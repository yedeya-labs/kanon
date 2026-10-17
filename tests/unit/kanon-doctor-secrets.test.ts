import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { appSecrets, callerFile, TELEMETRY_CALLER_PATH, telemetryCallerFile } from '../../cli/callers.mjs';
import { backlogFeedNote, doctor, EXIT, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { checkout, clone, fakeGitHub, healthyFiles, identitiesOf, ids, LANES, NEXT, PINNED, put, registerText, releaseBy, releaserFiles, releaserOn, REPO, REQ, run, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';
import { KEYS_HELP } from '../../cli/apps.mjs';
import { renderNotice } from '../../actions/agent-classify/classify-agent-result.mjs';
import { UNPUBLISHED_JOB } from '../../scripts/telemetry-collect.mjs';

/**
 * `kanon doctor` on the secrets a workflow maps (#414) and a caller maps at the checked release (#415),
 * and on the telemetry collector's caller (#428).
 *
 * Split out of kanon-doctor.test.ts, which holds the plan's falsifiable checks and the JSON contract,
 * so the doctor's cases run in parallel (#436). The fixtures are in helpers/doctor.ts.
 */
// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// #414 (plan 0005 G16): doctor counts a secret as read when any workflow maps it into a job, not
// only when a caller it recognises as Kanon's does, so it never tells anyone to delete a secret a
// workflow still uses.
describe('kanon doctor and the secrets a workflow maps (#414)', () => {
  const RELEASER = appSecrets('releaser');
  const withSecrets = (files: Record<string, string>) => {
    const dir = checkout({ ...healthyFiles(), ...files });
    const github = fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...RELEASER]) });
    return run(dir, github, ['--json']);
  };

  it('lists the Releaser\'s secrets as stale when no workflow maps them, and says how it looked (the mutation\'s baseline)', async () => {
    const r = await withSecrets({});
    expect(ids(r)).toEqual(['secret.stale acme/widgets']);
    const stale = r.json.findings[0];
    expect(stale.fix.commands).toEqual(RELEASER.map((n) => `gh secret delete ${n} -R ${REPO}`));
    expect(stale.message).toContain('no job of a workflow under .github/workflows/ on main names');
    expect(stale.message).toContain('`secrets.<NAME>`');
  });

  for (const uses of ['$/.github/workflows/release.yml', './.github/workflows/release.yml']) {
    it(`doesn't list the secrets a release caller reaching release.yml by \`${uses.split('/')[0]}/\` maps`, async () => {
      const r = await withSecrets({ '.github/workflows/release-please.yml': releaseBy(uses) });
      // The Releaser is an App in use here (#441), checked in its own block below.
      expect(ids(r).filter((x: string) => x.startsWith('secret.'))).toEqual([]);
    });
  }

  it("doesn't list a secret any other job names, in its env:, a step's with: or its secrets:", async () => {
    const [id, key] = RELEASER as [string, string];
    const other = ['name: Other', 'on: push', 'permissions: {}', 'jobs:', '  mint:', '    runs-on: ubuntu-latest',
      '    env:', `      ID: \${{ secrets.${id} }}`,
      '    steps:', '      - uses: actions/create-github-app-token@v2', '        with:', `          private-key: \${{ secrets.${key} }}`, ''].join('\n');
    expect(ids(await withSecrets({ '.github/workflows/other.yml': other }))).toEqual([]);
    // Mutation: the job names only one of them, and the other is listed.
    const half = other.split('\n').filter((l) => !l.includes(key)).join('\n');
    const r = await withSecrets({ '.github/workflows/other.yml': half });
    expect(ids(r)).toEqual(['secret.stale acme/widgets']);
    expect(r.json.findings[0].fix.commands).toEqual([`gh secret delete ${key} -R ${REPO}`]);
  });

  it("doesn't count a secret a comment, or a reusable workflow's declaration of what it takes, names", async () => {
    const declares = ['name: Takes', 'on:', '  workflow_call:', '    secrets:', ...RELEASER.map((n) => `      ${n}:\n        required: false\n        description: "the caller maps secrets.${n}"`),
      'jobs:', '  noop:', '    runs-on: ubuntu-latest', `    # \${{ secrets.${RELEASER[0]} }}`, '    steps:', '      - run: "true"', ''].join('\n');
    expect(ids(await withSecrets({ '.github/workflows/takes.yml': declares }))).toEqual(['secret.stale acme/widgets']);
  });

  it('lists nothing as stale while a job inherits every secret, and says why', async () => {
    const inherits = ['name: Inherits', 'on: push', 'permissions: {}', 'jobs:', '  call:', '    uses: ./.github/workflows/mine.yml', '    secrets: inherit', ''].join('\n');
    const r = await withSecrets({ '.github/workflows/inherits.yml': inherits });
    expect(ids(r)).toEqual([]);
    expect(r.json.notes.join('\n')).toContain(`.github/workflows/inherits.yml's job call inherits every secret, so doctor lists none of ${RELEASER.join(', ')} as stale`);
  });

  // #440: a read by a computed name, or of the whole context, can reach any secret the workflow
  // sees, so it counts as reading every one, as an inheriting job does.
  const reads = (expr: string, on = 'workflow_dispatch') => ['name: Reads', `on: ${on}`, 'permissions: {}', 'jobs:', '  mint:', '    runs-on: ubuntu-latest',
    '    steps:', '      - env:', `          ALL: ${expr}`, '        run: "true"', ''].join('\n');
  for (const expr of ["${{ secrets[format('{0}_APP_ID', matrix.app.secret)] }}", '${{ toJSON(secrets) }}', '${{ secrets.* }}', "${{ format('{{\"A\":{0}}}', toJSON(secrets)) }}"]) {
    it(`lists nothing as stale while a workflow reads secrets as \`${expr}\`, and says why (#440)`, async () => {
      const r = await withSecrets({ '.github/workflows/reads.yml': reads(expr) });
      expect(ids(r)).toEqual([]);
      expect(r.json.notes.join('\n')).toContain(`.github/workflows/reads.yml reads secrets by a computed name or as a whole (\`secrets[<expression>]\`, \`toJSON(secrets)\`), which can reach any of them, so doctor lists none of ${RELEASER.join(', ')} as stale`);
    });
  }

  it('still lists them beside a read by a literal name, a script\'s own text, or a computed read in a workflow only its callers run (#440, mutations)', async () => {
    for (const files of [
      { '.github/workflows/reads.yml': reads("${{ secrets['OTHER'] }} ${{ toJSON(secrets.OTHER) }} ${{ 'secrets' }}") },
      { '.github/workflows/reads.yml': reads('echo secrets[x] $(toJSON secrets)') },
      { '.github/workflows/reads.yml': reads('${{ toJSON(secrets) }}', '[workflow_call]') },
    ]) {
      const r = await withSecrets(files);
      expect(ids(r)).toEqual(['secret.stale acme/widgets']);
      expect(r.json.notes.join('\n')).not.toContain('computed name');
    }
    // The same read in an if:, which holds an expression without ${{ }}, counts.
    const inIf = reads('x').replace('      - env:', "      - if: toJSON(secrets) != '{}'\n        env:");
    expect(ids(await withSecrets({ '.github/workflows/reads.yml': inIf }))).toEqual([]);
  });

  it('lists nothing as stale while a workflow can\'t be read, which might map them', async () => {
    const r = await withSecrets({ '.github/workflows/broken.yml': 'jobs: [\n' });
    expect(ids(r)).toEqual([]);
    expect(r.json.unchecked).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'workflow', subject: '.github/workflows/broken.yml' })]));
  });

  it('notes that the reads are counted on the checkout, off the default branch', async () => {
    const dir = checkout(healthyFiles());
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'topic']);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.json.notes.join('\n')).toContain('The id-token holders and the secrets the workflows map are counted on topic, not on main');
  });
});

// #415 (Kanon's own L5, G2 and G9e): for each secret of the checked release's Apps, or of its
// lanes, that a workflow maps and the repository doesn't hold, doctor reports secret.missing,
// naming the secret, the workflows that map it, and the kanon apps line that creates it, after
// its pre-check (#420). A caller that reaches its workflow by a local path or `$/` counts.
describe('kanon doctor and the secrets a caller maps at the checked release (#415)', () => {
  const APPS = ['author', 'judge', 'releaser'];
  const all = () => new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...APPS.flatMap(appSecrets)]);
  const preflight = `kanon apps --owner acme --repo widgets --preflight`;
  /** The L5 shape: the lanes Kanon pins, and a release caller that reaches release.yml by `$/`. */
  const l5 = (secrets: Set<string>, extra: Record<string, string> = {}, tweak: (g: ReturnType<typeof fakeGitHub>) => void = () => {}) => {
    const dir = checkout({ ...releaserFiles(healthyFiles()), '.github/workflows/release-please.yml': releaseBy('$/.github/workflows/release.yml'), ...extra });
    const github = releaserOn(fakeGitHub({ secrets, releases: { [NEXT]: clone(REQ) } }));
    tweak(github);
    return run(dir, github, ['--to', NEXT, '--json']);
  };
  const missing = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'secret.missing');

  it('finds nothing missing while every App secret is there (the mutations\' baseline)', async () => {
    const r = await l5(all());
    expect(ids(r)).toEqual([]);
  });

  it('reports each App whose secrets are gone, the Releaser of a `$/` release caller included, and nothing else', async () => {
    const r = await l5(new Set([...all()].filter((n) => !/_APP_(ID|PRIVATE_KEY)$/.test(n))));
    expect(r.status).toBe(EXIT.findings);
    expect(ids(r)).toEqual(APPS.map(() => `secret.missing ${REPO}`));
    expect(missing(r).map((f: { message: string }) => f.message.split(',')[0])).toEqual(APPS.map((a) => `lacks ${appSecrets(a).join(' and ')}`));
    const releaser = missing(r)[2];
    expect(releaser.message).toContain('the releaser App\'s secrets: .github/workflows/apps-check.yml, .github/workflows/release-please.yml map them.');
    expect(releaser.fix.commands).toEqual([preflight, 'kanon apps --owner acme --repo widgets --reuse releaser:widgets-releaser@<App ID>=<downloaded>.pem']);
  });

  for (const app of APPS) {
    it(`reports exactly the ${app} App's finding when only its secrets are gone (mutation)`, async () => {
      const r = await l5(new Set([...all()].filter((n) => !appSecrets(app).includes(n))));
      expect(ids(r)).toEqual([`secret.missing ${REPO}`]);
      expect(r.json.findings[0].message).toMatch(new RegExp(`^lacks ${appSecrets(app).join(' and ')}, the ${app} App's secrets: \\S`));
      expect(r.json.findings[0].fix.commands[0]).toBe(preflight);
      // The App the register names gets the line that stores a new key for it.
      expect(r.json.findings[0].fix.commands[1]).toBe(`kanon apps --owner acme --repo widgets --reuse ${app}:widgets-${app}@<App ID>=<downloaded>.pem`);
    });
  }

  // #625: an App's id isn't secret. When it alone is gone, the fix stores it with `--body`, which
  // works at the Claude Code prompt with `!`, where a line that reads standard input stores an
  // empty secret; and it needs no new key.
  it('stores an App id alone with `gh secret set --body`, filled in when GitHub shows the App (#625)', async () => {
    const [appId, key] = appSecrets('judge') as [string, string];
    const r = await l5(new Set([...all()].filter((n) => n !== appId)), {}, (g) => { g.st.apps['widgets-judge']!.id = 4242; });
    expect(ids(r)).toEqual([`secret.missing ${REPO}`]);
    const f = missing(r)[0];
    expect(f.message).toMatch(/^lacks JUDGE_APP_ID, the judge App's secret: /);
    expect(f.fix.commands).toEqual([`gh secret set ${appId} -R ${REPO} --body 4242`]);
    expect(f.fix.text).toMatch(/isn't secret/);
    expect(f.fix.text).toMatch(/`!`/);
    expect(f.fix.url).toBe('https://github.com/settings/apps/widgets-judge');
    // A private App, whose id GitHub shows only on its settings page: the line says where it is.
    const hidden = await l5(new Set([...all()].filter((n) => n !== appId)), {}, (g) => { g.st.private.add('widgets-judge'); });
    expect(missing(hidden)[0].fix.commands).toEqual([`gh secret set ${appId} -R ${REPO} --body <the App ID on its settings page>`]);
    expect(missing(hidden)[0].fix.url).toBe('https://github.com/settings/apps/widgets-judge');
    // Mutation: the key gone too, or alone, still takes kanon apps, which reads the key from its file.
    const both = await l5(new Set([...all()].filter((n) => !appSecrets('judge').includes(n))), {}, (g) => { g.st.apps['widgets-judge']!.id = 4242; });
    expect(missing(both)[0].fix.commands[1]).toBe('kanon apps --owner acme --repo widgets --reuse judge:widgets-judge@<App ID>=<downloaded>.pem');
    // #637: the fix says where on the App's page the key is made, and links GitHub's page on it.
    expect(missing(both)[0].fix.text).toContain(`Add widgets to the judge App's installation, generate a private key on its settings page (Credentials → Key pairs → New key; GitHub's steps: ${KEYS_HELP}), and copy its App ID from the same page.`);
    const keyOnly = await l5(new Set([...all()].filter((n) => n !== key)), {}, (g) => { g.st.apps['widgets-judge']!.id = 4242; });
    expect(missing(keyOnly)[0].fix.commands[1]).toBe('kanon apps --owner acme --repo widgets --reuse judge:widgets-judge@<App ID>=<downloaded>.pem');
  });

  // #625: a real secret's line reads standard input, so the fix sends it to the person's own
  // terminal, never `!` at the Claude Code prompt, or to a file.
  it("sends a real secret's gh secret set to the person's own terminal or a file, never `!` (#625)", async () => {
    const r = await l5(new Set([...all()].filter((n) => !['CLAUDE_CODE_OAUTH_TOKEN', 'KANON_AGGREGATE_ROLE'].includes(n))), { '.github/workflows/digest.yml': ['name: Digest', 'on: push', 'jobs:', '  post:', '    runs-on: ubuntu-latest', '    env:', '      HOOK: ${{ secrets.KANON_AGGREGATE_ROLE }}', '    steps:', '      - run: "true"', ''].join('\n') });
    const real = missing(r).filter((f: { message: string }) => /^lacks (CLAUDE_CODE_OAUTH_TOKEN|KANON_AGGREGATE_ROLE)\b/.test(f.message));
    expect(real.length).toBe(2);
    for (const f of real) {
      expect(f.fix.text, f.message).toMatch(/in your own terminal/);
      expect(f.fix.text, f.message).toMatch(/never with `!` at the Claude Code prompt/);
      expect(f.fix.text, f.message).toMatch(/empty secret/);
      expect(f.fix.text, f.message).toContain('`< <file>`');
    }
  });

  it('gives an App in use that the register doesn\'t name the line that creates it, not the one that reuses a slug', async () => {
    const r = await l5(new Set([...all()].filter((n) => !appSecrets('releaser').includes(n))), { 'docs/qa/agent-identities.md': registerText(identitiesOf(LANES)) });
    expect(r.json.apps.map((a: { identity: string }) => a.identity)).toContain('releaser');
    expect(missing(r).map((f: { fix: { commands: string[] } }) => f.fix.commands)).toEqual([[preflight, 'kanon apps --owner acme --repo widgets --apps releaser']]);
  });

  it('names every workflow that maps the secrets, and the caller of a lane that takes them without mapping them', async () => {
    const files = healthyFiles();
    const judge = appSecrets('judge');
    const review = files['.github/workflows/agent-review.yml']!.split('\n').filter((l) => !judge.some((n) => l.includes(`${n}:`))).join('\n');
    const r = await l5(new Set([...all()].filter((n) => !judge.includes(n))), { '.github/workflows/agent-review.yml': review });
    const f = missing(r)[0];
    expect(f.message).toBe(`lacks ${judge.join(' and ')}, the judge App's secrets: .github/workflows/apps-check.yml maps them; .github/workflows/agent-review.yml calls a lane that takes them at ${NEXT}.`);
  });

  it('counts a lane reached by `$/`, which doctor does not read as a caller, and its lane secret too', async () => {
    const files = healthyFiles();
    delete files['.github/workflows/agent-review.yml'];
    const local = callerFile('agent-review', REQ.lanes['agent-review']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' }).replace(`yedeya-labs/kanon/.github/workflows/agent-review.yml@${PINNED}`, '$/.github/workflows/agent-review.yml').replace(/^( {4}secrets:\n)/m, '$1      KANON_AGGREGATE_ROLE: ${{ secrets.KANON_AGGREGATE_ROLE }}\n');
    const dir = checkout({ ...files, '.github/workflows/local-review.yml': local });
    const secrets = new Set([...all()].filter((n) => ![...appSecrets('judge'), ...appSecrets('releaser'), 'KANON_AGGREGATE_ROLE'].includes(n)));
    const r = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(r.json.lanes).toEqual(['agent-code-audit']);
    expect(ids(r).filter((x: string) => x.startsWith('secret.'))).toEqual([`secret.missing ${REPO}`, `secret.missing ${REPO}`]);
    const [judgeFinding, digest] = missing(r);
    expect(judgeFinding.message).toBe(`lacks ${appSecrets('judge').join(' and ')}, the judge App's secrets: .github/workflows/apps-check.yml, .github/workflows/local-review.yml map them.`);
    // No lane doctor reads runs as the Judge, so its slug is the register's own row.
    expect(r.json.apps.map((a: { identity: string }) => a.identity)).toEqual(['author']);
    expect(judgeFinding.fix.commands).toEqual([preflight, 'kanon apps --owner acme --repo widgets --reuse judge:widgets-judge@<App ID>=<downloaded>.pem']);
    expect(digest.message).toBe('lacks KANON_AGGREGATE_ROLE: .github/workflows/local-review.yml maps it.');
    expect(digest.fix.commands).toEqual([`gh secret set KANON_AGGREGATE_ROLE -R ${REPO}`]);
  });

  it("doesn't ask for a secret a reusable workflow only takes from its caller, as a lane's own definition does (a lane secret)", async () => {
    const definition = (declares: boolean) => ['name: Digest', 'on:', '  workflow_call:', ...(declares ? ['    secrets:', '      kanon_aggregate_role: # GitHub reads a secret name in any case', '        required: true'] : []), '  schedule:', '    - cron: "0 9 * * 1"',
      'jobs:', '  post:', '    runs-on: ubuntu-latest', '    env:', '      HOOK: ${{ secrets.KANON_AGGREGATE_ROLE }}', '    steps:', '      - run: "true"', ''].join('\n');
    expect(ids(await l5(all(), { '.github/workflows/digest.yml': definition(true) }))).toEqual([]);
    const secrets = new Set([...all()].filter((n) => n !== 'KANON_AGGREGATE_ROLE'));
    expect(ids(await l5(secrets, { '.github/workflows/digest.yml': definition(true) }))).toEqual([]);
    // Mutation: the same job, in a workflow that doesn't declare it takes the secret, reads the repository's.
    const r = await l5(secrets, { '.github/workflows/digest.yml': definition(false) });
    expect(ids(r)).toEqual([`secret.missing ${REPO}`]);
    expect(r.json.findings[0].message).toBe('lacks KANON_AGGREGATE_ROLE: .github/workflows/digest.yml maps it.');
  });

  it("reports no secret that is not Kanon's, nor one of a per-role App the checked release has no more", async () => {
    const role = Object.keys(REQ.identities.roles).find((x) => !REQ.identities.apps[x])!;
    const other = ['name: Publish', 'on: push', 'permissions: {}', 'jobs:', '  publish:', '    runs-on: ubuntu-latest', '    env:',
      '      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}', ...appSecrets(role).map((n) => `      ${n}: \${{ secrets.${n} }}`), '    steps:', '      - run: "true"', ''].join('\n');
    const r = await l5(all(), { '.github/workflows/publish.yml': other });
    expect(ids(r)).toEqual([]);
  });
});

// #428: a caller of Kanon's telemetry collector, as `kanon init --telemetry` writes it, is Kanon's
// id-token holder. From the token path (plan 0008 §8, J5) nothing is set beside it: its first
// default-branch run registers the repository, so doctor reads that run, `telemetry.not-run` while
// there is none and `telemetry.refused` when the store refused it, neither blocking.
describe("kanon doctor and the telemetry collector's caller (#428, plan 0008 J5)", () => {
  const VARS = ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE'];
  const FILE = 'telemetry.yml';
  const withCollector = (release = PINNED) => ({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: telemetryCallerFile(release) });
  const holderOf = (r: Result) => r.json.idTokenHolders.find((h: { workflow: string }) => h.workflow === TELEMETRY_CALLER_PATH);
  /** A GitHub whose caller has run on the default branch, its run's one job carrying `notes`. */
  const ran = (conclusion: string, notes: Array<{ title: string; annotation_level: string; message: string }> = [], job = 'collect / Collect telemetry rows') => {
    const github = fakeGitHub();
    github.st.runs[FILE] = [{ databaseId: 4242, conclusion, createdAt: '2026-10-14T07:40:00Z' }];
    github.st.runJobs[4242] = [{ id: 99, name: job, conclusion }];
    github.st.annotations[99] = notes;
    return github;
  };

  it("lists the caller init writes as Kanon's holder, asks for no variable, and is healthy once it has run", async () => {
    const github = ran('success');
    const r = await run(checkout(withCollector()), github, ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.findings).toEqual([]);
    expect(holderOf(r)).toMatchObject({ job: 'collect', status: 'kanon-lane', reason: null });
    expect(github.calls.some((c) => c[0] === 'variable')).toBe(false);
  });

  it('reports telemetry.not-run, without blocking, while the caller has no finished run on the default branch', async () => {
    const r = await run(checkout(withCollector()), fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`telemetry.not-run ${TELEMETRY_CALLER_PATH}`]);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'caller', blocking: false });
    expect(f.message).toContain('Its first run registers acme/widgets');
    expect(f.fix.commands).toEqual([`gh workflow run ${FILE} -R ${REPO} --ref main`]);
  });

  it("reports telemetry.refused with the run's own words when it ended on the store's refusal, and lets it be waived", async () => {
    const words = "the store answered 403 suspended: Kanon's operator suspended this repository's registration, so nothing is stored until the operator resumes it.";
    const dir = checkout(withCollector());
    const r = await run(dir, ran('failure', [{ title: 'telemetry-refused', annotation_level: 'failure', message: words }]), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`telemetry.refused ${TELEMETRY_CALLER_PATH}`]);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'caller', blocking: false });
    expect(f.message).toContain(`its last run on main, 4242, ended with the store's refusal: ${words}`);
    expect(f.fix.commands).toEqual([`gh run view 4242 -R ${REPO}`]);
    // An erasure's warning, on a green run, is a refusal too.
    const erased = await run(dir, ran('success', [{ title: 'telemetry-refused', annotation_level: 'warning', message: 'the store answered 410 erased: …' }]), ['--json']);
    expect(ids(erased)).toEqual([`telemetry.refused ${TELEMETRY_CALLER_PATH}`]);
    put(dir, { 'docs/qa/adoption.md': healthyFiles()['docs/qa/adoption.md'] + `- **${WAIVER_LABEL}:** \`telemetry.refused\` on \`${TELEMETRY_CALLER_PATH}\` (erased on purpose)\n` });
    const waived = await run(dir, ran('success', [{ title: 'telemetry-refused', annotation_level: 'warning', message: 'the store answered 410 erased: …' }]), ['--json']);
    expect(waived.json.findings).toEqual([]);
    expect(waived.json.waived.map((w: { id: string }) => w.id)).toEqual(['telemetry.refused']);
  });

  // #843: a release whose hosted URL is empty skips, green, and registers nothing. Its run is
  // finished, so `telemetry.not-run` no longer fires: doctor says what the skip means instead.
  it("reports telemetry.unpublished, without blocking, when the caller's last run skipped because the hosted store is unpublished in its release (#843)", async () => {
    const dir = checkout(withCollector());
    const r = await run(dir, ran('success', [], `collect / ${UNPUBLISHED_JOB}`), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`telemetry.unpublished ${TELEMETRY_CALLER_PATH}`]);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'caller', blocking: false });
    expect(f.message).toContain("its last run on main, 4242, sent nothing: Kanon's hosted telemetry store's URL is not published in the release of Kanon it calls");
    expect(f.message).toContain('registers nothing');
    expect(f.fix.text).toContain('Publish the hosted URLs');
    expect(f.fix.commands).toEqual([`gh run view 4242 -R ${REPO}`]);
    // A sweep under the job's own name is not, and neither is the skip's name on a red run.
    expect(ids(await run(dir, ran('success'), ['--json']))).toEqual([]);
    expect(ids(await run(dir, ran('failure', [], `collect / ${UNPUBLISHED_JOB}`), ['--json']))).toEqual([]);
  });

  it('reports nothing for a red run that is not a refusal, which the run itself pages', async () => {
    const r = await run(checkout(withCollector()), ran('failure', [{ title: 'telemetry-collect', annotation_level: 'failure', message: 'rows 1-1: the store answered 401 (aud)' }]), ['--json']);
    expect(r.json.findings).toEqual([]);
  });

  it("lists the check as unchecked when the token can't read the runs", async () => {
    const github = fakeGitHub();
    github.st.runsRefused = 'gh: Resource not accessible by personal access token (HTTP 403)';
    const r = await run(checkout(withCollector()), github, ['--json']);
    expect(r.status, r.out).toBe(EXIT.incomplete);
    expect(r.json.unchecked).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'telemetry-runs', subject: TELEMETRY_CALLER_PATH })]));
  });

  // Owner decision of 2026-10-14 (#842): the collector refuses these inputs, so doctor blocks on them.
  // Plan 0008 J9: `writer-role` is no input of the collector's any more, so it is `caller.input-stale`.
  it("blocks a caller that still passes the SigV4 path's url without audience, with init's caller as the fix, and names writer-role as an input the collector no longer declares", async () => {
    const legacy = telemetryCallerFile(PINNED).replace('    with:\n', "    with:\n      url: ${{ vars.KANON_TELEMETRY_URL }}\n      writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}\n");
    const r = await run(checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: legacy }), ran('success'), ['--json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(ids(r).sort()).toEqual([`caller.input-stale ${TELEMETRY_CALLER_PATH}`, `telemetry.legacy-inputs ${TELEMETRY_CALLER_PATH}`]);
    const f = r.json.findings.find((x: { id: string }) => x.id === 'telemetry.legacy-inputs');
    expect(f).toMatchObject({ category: 'caller', blocking: true });
    expect(f.message).toContain('passes `url:` to Kanon\'s telemetry collector without `audience:`');
    expect(f.message).toContain('nothing is sent or registered');
    expect(f.message).not.toContain('hosted store unless');
    expect(f.fix.text).toContain('Run kanon init again');
    expect(f.fix.text).toContain('add `audience:` beside `url:`');
    expect(f.fix.commands).toEqual(['kanon init --telemetry']);
    const stale = r.json.findings.find((x: { id: string }) => x.id === 'caller.input-stale');
    expect(stale).toMatchObject({ category: 'caller', blocking: true });
    expect(stale.message).toBe(`passes writer-role, which Kanon's telemetry collector does not declare at ${PINNED}; GitHub refuses a call that passes an input the called workflow does not declare, so every sweep fails before it starts.`);
    expect(stale.fix.text).toMatch(/^Remove `writer-role` from the job's with:, and the repository variable it read/);
    // writer-role alone is caller.input-stale alone: the collector would never see it.
    const role = telemetryCallerFile(PINNED).replace('    with:\n', "    with:\n      writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}\n");
    expect(ids(await run(checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: role }), ran('success'), ['--json']))).toEqual([`caller.input-stale ${TELEMETRY_CALLER_PATH}`]);
    // Against a release whose requirements don't list the collector's inputs (before J9), writer-role is legacy-inputs', as it was.
    const before = clone(REQ);
    delete (before.telemetry as { inputs?: string[] }).inputs;
    const out: string[] = [];
    await doctor(['--dir', checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: role }), '--json'], { gh: ran('success').gh, env: {}, out: (l: string) => out.push(l), err: () => {}, requirements: () => before, release: () => PINNED });
    expect(JSON.parse(out.join('\n')).findings.map((x: { id: string, subject: string }) => `${x.id} ${x.subject}`)).toEqual([`telemetry.legacy-inputs ${TELEMETRY_CALLER_PATH}`]);
    // A self-hosted url with its audience is neither.
    const self = telemetryCallerFile(PINNED).replace('    with:\n', '    with:\n      url: https://abc.lambda-url.eu-central-1.on.aws/\n      audience: acme-telemetry\n');
    expect(ids(await run(checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: self }), ran('success'), ['--json']))).toEqual([]);
  });

  it("asks nothing of a repository without the collector's caller", async () => {
    const github = fakeGitHub({ variables: null });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(github.calls.some((c) => c[0] === 'variable' || (c[0] === 'run' && c.includes(FILE)))).toBe(false);
  });

  it('reads no run against a release before the token path, and asks for no variable there either (telemetry.unconfigured is retired)', async () => {
    const old = clone(REQ);
    (old as { telemetry?: { token?: boolean; variables?: string[] } }).telemetry!.variables = VARS;
    delete (old as { telemetry?: { token?: boolean } }).telemetry!.token;
    const github = fakeGitHub({ variables: new Set() });
    const out: string[] = [];
    await doctor(['--dir', checkout(withCollector()), '--json'], { gh: github.gh, env: {}, out: (l: string) => out.push(l), err: () => {}, requirements: () => old, release: () => PINNED });
    expect(JSON.parse(out.join('\n')).findings).toEqual([]);
    expect(github.calls.some((c) => (c[0] === 'run' && c.includes(FILE)) || c[0] === 'variable')).toBe(false);
  });

  it("blocks a caller whose permissions: lack what the collector's job asks for: GitHub would refuse every sweep (plan 0006 F4)", async () => {
    // The caller as releases before F4 wrote it, with no `contents: read`.
    const before = telemetryCallerFile(PINNED).replace('  contents: read\n', '');
    const r = await run(checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: before }), ran('success'), ['--json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(ids(r)).toEqual([`caller.grant-missing ${TELEMETRY_CALLER_PATH}`]);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'caller', blocking: true });
    expect(f.message).toContain("grants contents: none; Kanon's telemetry collector needs contents: read at");
    expect(f.fix.commands).toEqual(['  contents: read']);
    // Against a release whose requirements give the collector no grant, nothing is asked.
    const old = clone(REQ);
    delete (old as { telemetry?: { grant?: unknown } }).telemetry!.grant;
    const out: string[] = [];
    await doctor(['--dir', checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: before }), '--json'], { gh: ran('success').gh, env: {}, out: (l: string) => out.push(l), err: () => {}, requirements: () => old, release: () => PINNED });
    expect(JSON.parse(out.join('\n')).findings).toEqual([]);
  });

  it('accepts the collector only from a release whose requirements name it', async () => {
    const old = clone(REQ);
    delete (old as { telemetry?: unknown }).telemetry;
    const github = ran('success');
    const r = await run(checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: telemetryCallerFile(PINNED) }), github, ['--json']);
    expect(holderOf(r).status).toBe('kanon-lane');
    // Against a release whose requirements file doesn't name the collector, it is unaccepted.
    const out: string[] = [];
    await doctor(['--dir', checkout(withCollector()), '--json'], { gh: github.gh, env: {}, out: (l: string) => out.push(l), err: () => {}, requirements: () => old, release: () => PINNED });
    const doc = JSON.parse(out.join('\n'));
    expect(doc.idTokenHolders.find((h: { workflow: string }) => h.workflow === TELEMETRY_CALLER_PATH).status).toBe('unaccepted');
    expect(doc.findings.map((f: { id: string }) => f.id)).not.toContain('telemetry.not-run');
  });
});

// Plan 0006 §3.1 (kanon#585): `Upstream findings: sent` or `sent with evidence` travels over the
// telemetry channel, so a record that says it with no caller of Kanon's collector sends nothing,
// and doctor says so, naming both fixes, as lane-check does on the pull request.
describe('kanon doctor and upstream findings sent without the telemetry collector (plan 0006 F2)', () => {
  const VARS = ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE'];
  const record = (value: string, extra = '') => ({ 'docs/qa/adoption.md': `${healthyFiles()['docs/qa/adoption.md']}- **Upstream findings:** \`${value}\`\n${extra}` });

  for (const value of ['sent', 'sent with evidence']) {
    it(`reports \`${value}\` with no caller of the collector as upstream.unsent, blocking, naming both fixes`, async () => {
      const r = await run(checkout({ ...healthyFiles(), ...record(value) }), fakeGitHub({ variables: new Set(VARS) }), ['--json']);
      expect(r.status, r.out).toBe(EXIT.findings);
      expect(ids(r)).toEqual(['upstream.unsent docs/qa/adoption.md']);
      const f = r.json.findings[0];
      expect(f).toMatchObject({ category: 'declaration', blocking: true });
      expect(f.message).toContain(`docs/qa/adoption.md:12 says \`Upstream findings: ${value}\`, and no workflow calls Kanon's telemetry collector`);
      expect(f.fix.text).toMatch(/kanon init --telemetry/);
      expect(f.fix.text).toMatch(/`drafted`/);
      expect(f.fix.commands).toEqual(['- **Upstream findings:** `drafted`']);
    });
  }

  it('reports nothing once a workflow calls the collector, nor for `drafted` or `filed here` without one', async () => {
    const github = fakeGitHub({ variables: new Set(VARS) });
    // The caller has run, so it is registered (plan 0008 J5): no `telemetry.not-run` beside it.
    github.st.runs['telemetry.yml'] = [{ databaseId: 4242, conclusion: 'success', createdAt: '2026-10-14T07:40:00Z' }];
    const sent = await run(checkout({ ...healthyFiles(), ...record('sent with evidence'), [TELEMETRY_CALLER_PATH]: telemetryCallerFile(PINNED) }), github, ['--json']);
    expect(sent.status, sent.out).toBe(EXIT.healthy);
    expect(sent.json.findings).toEqual([]);
    for (const value of ['drafted', 'filed here']) {
      const r = await run(checkout({ ...healthyFiles(), ...record(value) }), github, ['--json']);
      expect(r.json.findings, value).toEqual([]);
    }
  });

  it("can't be waived: lane-check fails the record whatever a waiver says", async () => {
    const waiver = `- **${WAIVER_LABEL}:** \`upstream.unsent\` on \`docs/qa/adoption.md\` (later)\n`;
    const r = await run(checkout({ ...healthyFiles(), ...record('sent', waiver) }), fakeGitHub(), ['--json']);
    expect(ids(r).sort()).toEqual(['declaration.malformed docs/qa/adoption.md', 'upstream.unsent docs/qa/adoption.md']);
    expect(r.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed').message).toContain("waives `upstream.unsent`, which can't be waived");
  });
});

// #609: a caller of a dispatch sweep that feeds the backlog at the checked release gets a note on
// the feeder's valve, never a finding: unset is the feeder's default, off.
describe("kanon doctor and the backlog feeder's valve (#609)", () => {
  const SWEEP = '.github/workflows/agent-dispatch-sweep.yml';
  const withSweep = () => ({ ...healthyFiles(), [SWEEP]: callerFile('agent-dispatch-sweep', REQ.lanes['agent-dispatch-sweep']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' }) });
  const feedNotes = (r: Result) => r.json.notes.filter((n: string) => n.includes('backlog feeder'));

  it('says the feeder is off when QA_BACKLOG_FEED is unset, as a note and not a finding', async () => {
    const r = await run(checkout(withSweep()), fakeGitHub(), ['--json']);
    expect(feedNotes(r)).toEqual([expect.stringContaining('is off: QA_BACKLOG_FEED is unset')]);
    expect(r.json.findings.filter((f: { message: string }) => /QA_BACKLOG|backlog/i.test(f.message))).toEqual([]);
    expect(r.json.unchecked).toEqual([]);
  });

  it('says how many it feeds a day, and from where, when the variable is set', async () => {
    const r = await run(checkout(withSweep()), fakeGitHub({ variables: new Map([['QA_BACKLOG_FEED', '2'], ['QA_BACKLOG_MILESTONES', 'Product Backlog, Tech Debt']]) }), ['--json']);
    expect(feedNotes(r)).toEqual([expect.stringContaining('labels up to 2 reviewer follow-ups a day agent:implement, from Product Backlog, Tech Debt')]);
  });

  it('reads a value that is not a whole number as closed, as the feeder does', () => {
    expect(backlogFeedNote(['x.yml'], new Map([['QA_BACKLOG_FEED', 'yes']]), REPO)).toContain('which is not a whole number');
    expect(backlogFeedNote(['x.yml'], new Map([['QA_BACKLOG_FEED', '0']]), REPO)).toContain('is off: QA_BACKLOG_FEED is 0');
    expect(backlogFeedNote(['x.yml'], null, REPO)).toContain("can't list acme/widgets's variables");
  });

  it('asks nothing of a repository without a sweep caller, or against a release whose sweep does not feed', async () => {
    const github = fakeGitHub({ variables: null });
    await run(checkout(healthyFiles()), github, ['--json']);
    expect(github.calls.some((c) => c[0] === 'variable')).toBe(false);
    // Mutation: the checked release's sweep declares no feeder variable, so no note.
    const old = clone(REQ);
    delete (old.lanes['agent-dispatch-sweep'] as { optionalVariables?: string[] }).optionalVariables;
    const out: string[] = [];
    await doctor(['--dir', checkout(withSweep()), '--json'], { gh: fakeGitHub().gh, env: {}, out: (l: string) => out.push(l), err: () => {}, requirements: () => old, release: () => PINNED });
    expect(JSON.parse(out.join('\n')).notes.filter((n: string) => n.includes('backlog feeder'))).toEqual([]);
  });
});

// Plan 0009 §11 (step A4): the Claude credential a lane runs on. Each model lane takes one of a
// pair, requirements.json's `claude`; doctor reads the secrets' names and dates, never a value.
describe('kanon doctor and the Claude credential (plan 0009 §11)', () => {
  const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
  const KEY = 'ANTHROPIC_API_KEY';
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-10-13T12:00:00Z');
  const REVIEW = '.github/workflows/agent-review.yml';
  const AUDIT = '.github/workflows/agent-code-audit.yml';
  const line = (n: string) => `      ${n}: \${{ secrets.${n} }}\n`;
  /** The healthy installation with each named caller's token line swapped, removed, or doubled. */
  const files = (change: Record<string, 'key' | 'none' | 'both'> = {}) => {
    const f = healthyFiles();
    for (const [file, how] of Object.entries(change)) {
      f[file] = f[file]!.replace(line(TOKEN), how === 'key' ? line(KEY) : how === 'none' ? '' : line(TOKEN) + line(KEY));
    }
    return f;
  };
  const held = (...extra: string[]) => new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...extra]);
  const claudeIds = (r: Result) => ids(r).filter((x: string) => /^(caller\.claude|claude\.|secret\.)/.test(x));
  const find = (r: Result, id: string) => r.json.findings.find((f: { id: string }) => f.id === id);
  const at = (days: number) => new Date(NOW - days * DAY).toISOString();

  it('reads the pair from requirements.json for every lane that runs a model', () => {
    expect(REQ.lanes['agent-review']).toMatchObject({ claude: [TOKEN, KEY] });
    expect((REQ.lanes['agent-merge'] as { claude?: string[] }).claude).toBeUndefined();
  });

  it('finds nothing on a healthy installation on the token (the baseline)', async () => {
    const r = await run(checkout(files()), fakeGitHub(), ['--json'], NOW);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(claudeIds(r)).toEqual([]);
  });

  it('reports a caller that maps both credentials as caller.claude-both, and only there', async () => {
    const r = await run(checkout(files({ [REVIEW]: 'both' })), fakeGitHub({ secrets: held(KEY) }), ['--json'], NOW);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(claudeIds(r)).toEqual([`caller.claude-both ${REVIEW}`]);
    expect(find(r, 'caller.claude-both')).toMatchObject({ category: 'caller', blocking: true });
    expect(find(r, 'caller.claude-both').fix.commands).toEqual([line(TOKEN).trimEnd(), line(KEY).trimEnd()]);
  });

  it('reports a caller that maps neither as caller.claude-none, and only there, never as a missing secret of the caller', async () => {
    const r = await run(checkout(files({ [REVIEW]: 'none' })), fakeGitHub(), ['--json'], NOW);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(claudeIds(r)).toEqual([`caller.claude-none ${REVIEW}`]);
    expect(ids(r)).not.toContain(`caller.secret-missing ${REVIEW}`);
    expect(find(r, 'caller.claude-none').message).toContain(`maps neither ${TOKEN} nor ${KEY}`);
  });

  it('notes callers on different credentials as claude.mixed, naming the lanes, without blocking', async () => {
    const r = await run(checkout(files({ [REVIEW]: 'key' })), fakeGitHub({ secrets: held(KEY) }), ['--json'], NOW);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(claudeIds(r)).toEqual(['claude.mixed .github/workflows']);
    expect(find(r, 'claude.mixed').message).toContain(`agent-review on ${KEY}; agent-code-audit on ${TOKEN}`);
    // A caller on the key is not a stale secret of the caller's.
    expect(ids(r)).not.toContain(`caller.secret-stale ${REVIEW}`);
  });

  it('asks for the key alone when every caller maps it, with the Console, and says organisation secrets are not counted', async () => {
    const secrets = new Set([...held()].filter((n) => n !== TOKEN));
    const r = await run(checkout(files({ [REVIEW]: 'key', [AUDIT]: 'key' })), fakeGitHub({ secrets }), ['--json'], NOW);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(claudeIds(r)).toEqual([`secret.missing ${REPO}`]);
    const f = find(r, 'secret.missing');
    expect(f.message).toMatch(new RegExp(`^lacks ${KEY}, which agent-code-audit, agent-review take`));
    expect(f.message).toContain("an organisation secret shared with acme/widgets isn't counted");
    expect(f.fix.text).toContain('Claude Console');
    expect(f.fix.url).toMatch(/^https:\/\/console\.anthropic\.com\//);
    expect(f.fix.commands).toEqual([`gh secret set ${KEY} -R ${REPO}`]);
  });

  it("names claude setup-token, and the switch to a key, in the token's secret.missing", async () => {
    const secrets = new Set([...held()].filter((n) => n !== TOKEN));
    const r = await run(checkout(files()), fakeGitHub({ secrets }), ['--json'], NOW);
    expect(claudeIds(r)).toEqual([`secret.missing ${REPO}`]);
    expect(find(r, 'secret.missing').fix.text).toContain('`claude setup-token`');
    expect(find(r, 'secret.missing').fix.text).toContain('kanon init --claude-auth api-key');
  });

  it('lists the token as stale once every caller maps the key, after a week of green runs', async () => {
    const r = await run(checkout(files({ [REVIEW]: 'key', [AUDIT]: 'key' })), fakeGitHub({ secrets: held(KEY) }), ['--json'], NOW);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(claudeIds(r)).toEqual([`secret.stale ${REPO}`]);
    const f = find(r, 'secret.stale');
    expect(f.fix.commands).toEqual([`gh secret delete ${TOKEN} -R ${REPO}`]);
    expect(f.fix.text).toContain('a week');
  });

  describe('claude.token-age', () => {
    const aged = async (days: number, change: Record<string, 'key'> = {}) => {
      const github = fakeGitHub({ secrets: Object.keys(change).length ? held(KEY) : held() });
      github.st.secretDates[TOKEN] = at(days);
      return run(checkout(files(change)), github, ['--json'], NOW);
    };

    it('says nothing at 335 days', async () => {
      const r = await aged(335);
      expect(r.status, r.out).toBe(EXIT.healthy);
      expect(claudeIds(r)).toEqual([]);
    });

    it('is a note from day 336 to day 365, saying when the secret was updated, never created', async () => {
      for (const days of [336, 365]) {
        const r = await aged(days);
        expect(r.status, r.out).toBe(EXIT.healthy);
        expect(claudeIds(r)).toEqual([`claude.token-age ${REPO}`]);
        const f = find(r, 'claude.token-age');
        expect(f).toMatchObject({ category: 'secret', blocking: false });
        expect(f.message).toContain(`${TOKEN} was last updated ${days} days ago`);
        expect(f.message).not.toMatch(/created/i);
        expect(f.message).toContain('renew it before day 365');
        expect(f.fix.commands).toEqual(['claude setup-token', `gh secret set ${TOKEN} -R ${REPO}`]);
      }
    });

    it('blocks from day 366: a subscription token lasts a year', async () => {
      const r = await aged(366);
      expect(r.status, r.out).toBe(EXIT.findings);
      expect(claudeIds(r)).toEqual([`claude.token-age ${REPO}`]);
      const f = find(r, 'claude.token-age');
      expect(f.blocking).toBe(true);
      expect(f.message).toContain('last updated 366 days ago');
      expect(f.message).not.toMatch(/created/i);
      expect(f.message).toContain('A subscription token lasts a year; this one is at least that old');
    });

    it('asks nothing of a token no caller maps any more', async () => {
      const r = await aged(400, { [REVIEW]: 'key', [AUDIT]: 'key' });
      expect(claudeIds(r)).toEqual([`secret.stale ${REPO}`]);
    });
  });

  describe('claude.unreachable-runs', () => {
    /**
     * The annotation title GitHub stores for agent-classify's notice, built from the line it emits
     * (`::error title=<title>::<body>`) by the runner's rule: the properties split on every `,`,
     * and only `key=value` segments kept. Never doctor's own constant, so the two can disagree.
     */
    const notice = renderNotice('unavailable', 'no model');
    const emitted = `::${notice.level} title=${notice.title}::${notice.body}`;
    const properties = emitted.slice(emitted.indexOf(' ') + 1, emitted.indexOf('::', 2));
    const STORED = properties.split(',').filter((p) => p.includes('=')).map((p) => p.slice(p.indexOf('=') + 1))[0]!;

    it("looks for the notice's title as GitHub stores it, cut at its comma", () => {
      expect(notice.title).toContain(',');
      expect(STORED).toBe('the model was unreachable');
    });
    let next = 7000;
    /** A run of the caller, whose `notices` failed jobs (one at least) each carry the given notice. */
    const addRun = (github: ReturnType<typeof fakeGitHub>, file: string, o: { days?: number; notices?: number; conclusion?: string; title?: string } = {}) => {
      const id = next++;
      const notices = o.notices ?? 1;
      (github.st.runs[file] ??= []).push({ databaseId: id, conclusion: o.conclusion ?? 'failure', createdAt: at(o.days ?? 1) });
      github.st.runJobs[id] = Array.from({ length: Math.max(notices, 1) }, (_, i) => ({ id: id * 10 + i, name: `job ${i}`, conclusion: 'failure' }));
      for (let i = 0; i < notices; i++) github.st.annotations[id * 10 + i] = [{ title: o.title ?? STORED, annotation_level: 'failure', message: '…' }];
      return id;
    };

    it('notes two runs in 14 days that never reached the model, naming them and the three causes, without blocking', async () => {
      const github = fakeGitHub();
      const a = addRun(github, 'agent-review.yml', { days: 1 });
      const b = addRun(github, 'agent-code-audit.yml', { days: 13 });
      const r = await run(checkout(files()), github, ['--json'], NOW);
      expect(r.status, r.out).toBe(EXIT.healthy);
      expect(claudeIds(r)).toEqual([`claude.unreachable-runs ${REPO}`]);
      const f = find(r, 'claude.unreachable-runs');
      expect(f).toMatchObject({ category: 'secret', blocking: false });
      expect(f.message).toContain(`${AUDIT} run ${b}`);
      expect(f.message).toContain(`${REVIEW} run ${a}`);
      expect(f.message).toContain("the Claude subscription's usage limit, an Anthropic outage, or a configuration fault");
      expect(f.message).not.toMatch(/\bcap\b/i);
      expect(f.fix.text).toContain(KEY);
    });

    it('needs two runs: one run, a second outside 14 days, another notice, or a green run is not enough', async () => {
      for (const extra of [null, { days: 15 }, { title: 'something else' }, { conclusion: 'success' }]) {
        const github = fakeGitHub();
        addRun(github, 'agent-review.yml', { days: 2 });
        if (extra) addRun(github, 'agent-review.yml', extra);
        const r = await run(checkout(files()), github, ['--json'], NOW);
        expect(claudeIds(r), JSON.stringify(extra)).toEqual([]);
      }
    });

    it('counts one run once, however many of its jobs carry the notice', async () => {
      const github = fakeGitHub();
      addRun(github, 'agent-review.yml', { notices: 2 });
      const r = await run(checkout(files()), github, ['--json'], NOW);
      expect(claudeIds(r)).toEqual([]);
    });

    it('reads no runs of a caller on the key', async () => {
      const github = fakeGitHub({ secrets: held(KEY) });
      addRun(github, 'agent-review.yml');
      addRun(github, 'agent-review.yml');
      const r = await run(checkout(files({ [REVIEW]: 'key' })), github, ['--json'], NOW);
      expect(claudeIds(r)).toEqual(['claude.mixed .github/workflows']);
      expect(github.calls.filter((c) => c[0] === 'run').map((c) => c[c.indexOf('--workflow') + 1])).toEqual(['agent-code-audit.yml']);
    });

    it("is unchecked when the token can't list the runs", async () => {
      const github = fakeGitHub();
      github.st.runsRefused = 'HTTP 403: Resource not accessible by personal access token';
      const r = await run(checkout(files()), github, ['--json'], NOW);
      expect(r.status, r.out).toBe(EXIT.incomplete);
      expect(r.json.unchecked.map((u: { check: string; subject: string }) => `${u.check} ${u.subject}`)).toEqual([`unreachable-runs ${AUDIT}`, `unreachable-runs ${REVIEW}`]);
    });
  });

  it('prints no value: a token-shaped secret name in the listing never reaches the output', async () => {
    const shaped = `sk-ant-oat01-${'Q'.repeat(60)}`;
    const github = fakeGitHub({ secrets: held(shaped) });
    github.st.secretDates[TOKEN] = at(366);
    github.st.secretDates[shaped] = at(400);
    const dir = checkout(files());
    const json = await run(dir, github, ['--json'], NOW);
    const prose = await run(dir, github, [], NOW);
    expect(claudeIds(json)).toEqual([`claude.token-age ${REPO}`]);
    for (const text of [json.out, prose.out, prose.err]) {
      expect(text).not.toContain('sk-ant');
      expect(text).not.toContain('Q'.repeat(20));
    }
    expect(github.calls).toContainEqual(['secret', 'list', '-R', REPO, '--json', 'name,updatedAt']);
  });
});
