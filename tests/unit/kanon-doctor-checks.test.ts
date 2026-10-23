import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appSecrets, callerFile, ciFile, hookFile } from '../../cli/callers.mjs';
import { rulesetBody } from '../../cli/init.mjs';
import { branchPattern, branchWorkflows, checkJobs, checkReporters, doctor, EXIT, parseArgs, SCHEMA, startsOnMerge, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { checkout, fakeGitHub, healthyFiles, identitiesOf, ids, LANES, no, ok, PINNED, registerText, REPO, REQ, run, scratch, type Gh, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';
import { callerNameFindings, FAILS_FROM, FIXED_CALLERS } from '../../actions/lane-check/caller-names.mjs';

/**
 * `kanon doctor` on what an installation lacks, and on the job behind a required check (#418, #446,
 * #452, #459).
 *
 * Split out of kanon-doctor.test.ts, which holds the plan's falsifiable checks and the JSON contract,
 * so the doctor's cases run in parallel (#436). The fixtures are in helpers/doctor.ts.
 */
// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

describe('kanon doctor on what an installation lacks', () => {
  it('names a missing register row, App secret and stack section, and a stale role secret', async () => {
    const files = healthyFiles();
    const id = REQ.lanes['agent-review']!.identities[0]!;
    files['docs/qa/agent-identities.md'] = registerText(identitiesOf(LANES).filter((x) => x !== id));
    files['docs/qa/stack.md'] = '# Stack\n';
    const dir = checkout(files);
    const secrets = new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets).filter((n) => n !== appSecrets(id)[1]));
    const staleRole = Object.keys(REQ.identities.roles).find((r) => !identitiesOf(LANES).includes(r))!;
    secrets.add(appSecrets(staleRole)[0]!);
    const r = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(r.status).toBe(1);
    expect(ids(r)).toEqual(['register.missing-row docs/qa/agent-identities.md', 'secret.missing acme/widgets', 'secret.stale acme/widgets', 'declaration.section-missing docs/qa/stack.md']);
    expect(r.json.findings[1].fix.commands[0]).toMatch(/^kanon apps --owner acme --repo widgets /);
    expect(r.json.findings[2]).toMatchObject({ blocking: false, fix: { commands: [`gh secret delete ${appSecrets(staleRole)[0]} -R ${REPO}`] } });
  });

  it('warns, without blocking, about an App that holds more than the release grants (the Owner, 2026-10-06)', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    const id = REQ.lanes['agent-code-audit']!.identities[0]!;
    github.st.apps[`widgets-${id}`]!.permissions.administration = 'write';
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([`app.permission-extra widgets-${id}`]);
    expect(r.json.findings[0]).toMatchObject({ blocking: false, fix: { text: expect.stringContaining('Narrow') } });
    expect(r.json.findings[0].message).toContain('blocks nothing');
    expect(r.status).toBe(EXIT.healthy);
  });

  it('names a missing hook input, a missing ruleset rule and missing labels (the labels not blocking)', async () => {
    const files = healthyFiles();
    files[REQ.hook.path] = hookFile(REQ.hook.inputs.slice(1));
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.rulesets = [{ ...github.st.rulesets[0]!, rules: github.st.rulesets[0]!.rules.filter((x) => x.type !== 'deletion') }];
    github.st.labels.delete('qa:needs-split');
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([`hook.input-missing ${REQ.hook.path}`, 'label.missing acme/widgets', 'ruleset.rule-missing main']);
    expect(r.json.findings[1]).toMatchObject({ blocking: false });
    expect(r.json.findings[1].fix.commands).toEqual([expect.stringMatching(/^gh label create "qa:needs-split" --color [0-9a-f]{6} --description /)]);
  });

  it("names each of GitHub's default labels outside the taxonomy, without blocking, and leaves bug and enhancement alone (K-WORK-12, kanon#1246)", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    for (const n of ['bug', 'enhancement', 'documentation', 'good first issue', 'wontfix', 'not-a-default']) github.st.labels.add(n);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([`label.github-default ${REPO}`]);
    expect(r.status).toBe(EXIT.healthy);
    expect(r.json.findings[0]).toMatchObject({ category: 'label', blocking: false });
    expect(r.json.findings[0].message).toMatch(/still has 3 of GitHub's default labels outside Kanon's taxonomy: documentation, good first issue, wontfix\. .*\(K-WORK-12\)/);
    expect(r.json.findings[0].fix.text).toContain('kanon init --delete-default-labels');
    expect(r.json.findings[0].fix.commands).toEqual([`gh label delete "documentation" --yes -R ${REPO}`, `gh label delete "good first issue" --yes -R ${REPO}`, `gh label delete "wontfix" --yes -R ${REPO}`]);
  });

  it('reports no default label on a repository that kept only the taxonomy', async () => {
    const r = await run(checkout(healthyFiles()), fakeGitHub(), ['--json']);
    expect(ids(r).filter((id: string) => id.startsWith('label.'))).toEqual([]);
  });

  it('names a caller that inherits secrets, and an apps-check caller that maps a secret its release does not take', async () => {
    const files = healthyFiles();
    files['.github/workflows/agent-review.yml'] = files['.github/workflows/agent-review.yml']!.replace(/ {4}secrets:\n( {6}.*\n)+/, '    secrets: inherit\n');
    files['.github/workflows/apps-check.yml'] += '      NOBODY_APP_ID: ${{ secrets.NOBODY_APP_ID }}\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['caller.secrets-inherited .github/workflows/agent-review.yml', 'apps-check.secret-stale .github/workflows/apps-check.yml']);
  });

  it('names a caller granting write-all as what it is, with the lane\'s grant written out as the fix', async () => {
    const files = healthyFiles();
    files['.github/workflows/agent-review.yml'] = files['.github/workflows/agent-review.yml']!.replace(/^permissions:\n( {2}.*\n)+/m, 'permissions: write-all\n');
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    // write-all also hands the review lane, which is not store-coupled, id-token: write.
    expect(ids(r)).toEqual(['caller.grant-missing .github/workflows/agent-review.yml', 'id-token.unaccepted .github/workflows/agent-review.yml#review']);
    expect(r.json.findings[0].message).toContain('grants `permissions: write-all` rather than a map');
    expect(r.json.findings[0].fix.commands).toEqual(['permissions:', ...Object.entries(REQ.lanes['agent-review']!.grant).map(([k, v]) => `  ${k}: ${v}`)]);
  });

  it('names, in the apps-check finding, each App whose secrets the caller does not map', async () => {
    const files = healthyFiles();
    files['.github/workflows/apps-check.yml'] = files['.github/workflows/apps-check.yml']!.split('\n').filter((l) => !/_APP_PRIVATE_KEY:/.test(l)).join('\n');
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['apps-check.secret-missing .github/workflows/apps-check.yml']);
    const both = identitiesOf(LANES);
    expect(both).toHaveLength(2);
    expect(r.json.findings[0].message).toContain(`can't check the ${both.join(' and ')} Apps.`);
  });

  it('says which release first ships a requirements file', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--to', 'v0.27.0', '--json']);
    expect(r.json.error).toContain('from v0.28.0 on');
  });

  it('names pins that disagree', async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = files['.github/workflows/ci.yml']!.replace(`@${PINNED}`, '@v0.9.0');
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['pin.mixed .github']);
    expect(r.json.releases.pins).toEqual(['v0.9.0', PINNED]);
    expect(r.json.releases.pinned).toBe(PINNED);
  });

  // kanon#1105: Dependabot reads a composite action only from the action's own directory, so an
  // entry for `/` alone leaves a hook's Kanon pin behind on every upgrade pull request.
  describe("the Dependabot entry's reach (K-ADOPT-11, kanon#1105)", () => {
    const pinnedHook = (files: Record<string, string>) =>
      files[REQ.hook.path]!.replace('  steps:\n', `  steps:\n    - uses: yedeya-labs/kanon/actions/kanon-path@${PINNED}\n`);
    const forRootAlone = (files: Record<string, string>) =>
      files['.github/dependabot.yml']!.replace(/ {4}directories:\n( {6}- .*\n)+/, '    directory: /\n');

    it("reports an entry that doesn't reach a composite action pinning Kanon, with the line that does", async () => {
      const files = healthyFiles();
      files[REQ.hook.path] = pinnedHook(files);
      files['.github/dependabot.yml'] = forRootAlone(files);
      expect(files['.github/dependabot.yml']).toContain('    directory: /\n');
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual(['pin.dependabot-unreached .github/dependabot.yml']);
      expect(r.json.findings[0]).toMatchObject({ category: 'pin', blocking: true });
      expect(r.json.findings[0].message).toContain(REQ.hook.path);
      expect(r.json.findings[0].message).toContain("Kanon entry at `updates[0]` (`directory: /`) doesn't reach");
      expect(r.json.findings[0].fix.commands).toEqual(['directories: ["/", "/.github/actions/*"]']);
      expect(r.status).toBe(EXIT.findings);
    });

    it('passes the entry kanon init writes, which reaches the hook', async () => {
      const files = healthyFiles();
      files[REQ.hook.path] = pinnedHook(files);
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual([]);
    });

    it('passes an entry for `/` alone while no composite action pins Kanon', async () => {
      const files = healthyFiles();
      files['.github/dependabot.yml'] = forRootAlone(files);
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual([]);
    });

    // kanon#1111: doctor holds the entries lane-check holds, each one that would open a Kanon
    // upgrade pull request, whatever its group, cooldown or prefix.
    const withEntry = (files: Record<string, string>, entry: string) => `${files['.github/dependabot.yml']!.trimEnd()}\n${entry}`;
    it('passes a copied Kanon group in an entry for a directory that pins no Kanon reference (kanon#1111)', async () => {
      const files = healthyFiles();
      files[REQ.hook.path] = pinnedHook(files);
      files['.github/dependabot.yml'] = withEntry(files, ['  - package-ecosystem: github-actions', '    directory: /infra', '    schedule:', '      interval: daily',
        '    groups:', '      kanon:', '        patterns: ["yedeya-labs/kanon*"]', ''].join('\n'));
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual([]);
      expect(r.status).toBe(EXIT.healthy);
    });

    it("reports a second entry with no Kanon group that doesn't reach a pin: it still proposes Kanon (kanon#1111)", async () => {
      const files = healthyFiles();
      files[REQ.hook.path] = pinnedHook(files);
      files['.github/dependabot.yml'] = withEntry(files, ['  - package-ecosystem: github-actions', '    directory: /', '    target-branch: release', '    schedule:', '      interval: daily', ''].join('\n'));
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      // Ungrouped, too (kanon#1126): two findings on the one entry, each with its own fix.
      expect(ids(r)).toEqual(['pin.dependabot-ungrouped .github/dependabot.yml', 'pin.dependabot-unreached .github/dependabot.yml']);
      // The first entry already reaches the hook, so the finding names the one to change (kanon#1111).
      expect(r.json.findings[1].message).toContain("Kanon entry at `updates[1]` (`target-branch: release`, `directory: /`) doesn't reach");
      expect(r.json.findings[1].fix.commands).toEqual(['directories: ["/", "/.github/actions/*"]']);
    });

    // kanon#1126: Dependabot opens an update no group takes in as a pull request of its own, per
    // dependency and per directory, and each Kanon lane's workflow is a dependency of its own. So
    // an entry that proposes Kanon has to group it, however well it reaches.
    const releaseEntry = (...more: string[]) => ['  - package-ecosystem: github-actions', '    directories: ["/", "/.github/actions/*"]', '    target-branch: release',
      '    schedule:', '      interval: daily', ...more, ''].join('\n');
    it('reports an entry that proposes Kanon and groups none of it, with the `kanon` group as the fix (kanon#1126)', async () => {
      const files = healthyFiles();
      files[REQ.hook.path] = pinnedHook(files);
      files['.github/dependabot.yml'] = withEntry(files, releaseEntry());
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual(['pin.dependabot-ungrouped .github/dependabot.yml']);
      expect(r.json.findings[0]).toMatchObject({ category: 'pin', blocking: true });
      expect(r.json.findings[0].message).toContain('Kanon entry at `updates[1]` (`target-branch: release`, `directories: ["/","/.github/actions/*"]`) proposes Kanon upgrades but puts them in no one group');
      expect(r.json.findings[0].fix.text).toContain("Add the `kanon` group `kanon init` writes as that entry's first group");
      expect(r.json.findings[0].fix.text).not.toContain('duplicate key');
      expect(r.json.findings[0].fix.commands).toEqual(['kanon: { patterns: ["yedeya-labs/kanon*"] }']);
      expect(r.status).toBe(EXIT.findings);
    });

    it('reports a group that takes in only some of Kanon: the bare repository name leaves its lanes out (kanon#1126)', async () => {
      const files = healthyFiles();
      files['.github/dependabot.yml'] = withEntry(files, releaseEntry('    groups:', '      kanon:', '        patterns: ["yedeya-labs/kanon"]'));
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual(['pin.dependabot-ungrouped .github/dependabot.yml']);
      // kanon#1159: the entry already has a `kanon` group, so adding one would write a duplicate
      // key; the fix changes that group, and moves it first, ahead of any group that takes Kanon in.
      const { text, commands } = r.json.findings[0].fix;
      expect(text).not.toContain('Add the `kanon` group');
      expect(text).toContain("Change that entry's `kanon` group, without adding a second one");
      expect(text).toContain('set its `patterns` to `["yedeya-labs/kanon*"]`');
      expect(text).toContain('remove any `exclude-patterns`, `update-types`, `dependency-type`, `group-by` or `applies-to` it sets');
      expect(text).toContain("move it first under the entry's `groups:`");
      expect(commands).toEqual(['kanon: { patterns: ["yedeya-labs/kanon*"] }']);
    });

    it('passes an entry that groups Kanon, or that ignores it (kanon#1126)', async () => {
      for (const more of [
        ['    groups:', '      kanon:', '        patterns: ["yedeya-labs/kanon*"]'],
        ['    groups:', '      everything:', '        patterns: ["*"]'],
        ['    ignore:', '      - dependency-name: "yedeya-labs/kanon*"'],
      ]) {
        const files = healthyFiles();
        files[REQ.hook.path] = pinnedHook(files);
        files['.github/dependabot.yml'] = withEntry(files, releaseEntry(...more));
        const r = await run(checkout(files), fakeGitHub(), ['--json']);
        expect(ids(r), more.join('\n')).toEqual([]);
      }
    });

    // kanon#1131: lane-check fails each entry that doesn't reach a pin, so doctor reports each one,
    // not only the first, or its fix takes a round per entry.
    it("reports every entry that doesn't reach a pin, one finding each (kanon#1131)", async () => {
      const files = healthyFiles();
      files[REQ.hook.path] = pinnedHook(files);
      files['.github/dependabot.yml'] = withEntry({ '.github/dependabot.yml': forRootAlone(files) }, ['  - package-ecosystem: github-actions', '    directory: /', '    target-branch: release', '    schedule:', '      interval: daily',
        '    groups:', '      kanon:', '        patterns: ["yedeya-labs/kanon*"]', ''].join('\n'));
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual(['pin.dependabot-unreached .github/dependabot.yml', 'pin.dependabot-unreached .github/dependabot.yml']);
      expect(r.json.findings[0].message).toContain("Kanon entry at `updates[0]` (`directory: /`) doesn't reach");
      expect(r.json.findings[1].message).toContain("Kanon entry at `updates[1]` (`target-branch: release`, `directory: /`) doesn't reach");
      for (const f of r.json.findings) expect(f.fix.commands).toEqual(['directories: ["/", "/.github/actions/*"]']);
      expect(r.status).toBe(EXIT.findings);
    });

    it('passes a second entry that ignores Kanon, which proposes no Kanon upgrade (kanon#1111)', async () => {
      const files = healthyFiles();
      files[REQ.hook.path] = pinnedHook(files);
      files['.github/dependabot.yml'] = withEntry(files, ['  - package-ecosystem: github-actions', '    directory: /', '    target-branch: release', '    schedule:', '      interval: daily',
        '    ignore:', '      - dependency-name: "yedeya-labs/kanon*"', ''].join('\n'));
      const r = await run(checkout(files), fakeGitHub(), ['--json']);
      expect(ids(r)).toEqual([]);
    });
  });

  // Plan 0009 S2: a candidate, `candidate-vX.Y.Z`, is an exact release (K-ADOPT-11). Doctor reads
  // its requirements at the candidate's tag and notes it, with the latest stable release beside it.
  describe('a candidate pin (plan 0009 S2)', () => {
    const CANDIDATE = `candidate-${PINNED}`;
    const candidateFiles = () => {
      const files = healthyFiles();
      for (const f of Object.keys(files).filter((x) => x.startsWith('.github/'))) files[f] = files[f]!.split(`@${PINNED}`).join(`@${CANDIDATE}`);
      return files;
    };

    it("reads the requirements at the candidate's tag, and notes the pin without blocking", async () => {
      const github = fakeGitHub({ releases: { [CANDIDATE]: REQ }, latest: 'v0.9.0' });
      const r = await run(checkout(candidateFiles()), github, ['--json']);
      expect(github.calls.map((c) => c.join(' '))).toContain(`api -H Accept: application/vnd.github.raw+json repos/yedeya-labs/kanon/contents/requirements.json?ref=${CANDIDATE}`);
      expect(ids(r)).toEqual(['pin.candidate .github']);
      expect(r.json.findings[0]).toMatchObject({ category: 'pin', blocking: false });
      expect(r.json.findings[0].message).toContain(`pin a candidate, ${CANDIDATE}; the latest stable release is v0.9.0`);
      expect(r.status).toBe(EXIT.healthy);
      expect(r.json.releases).toMatchObject({ pins: [CANDIDATE], pinned: CANDIDATE, checked: CANDIDATE, stable: 'v0.9.0' });
    });

    it("says it couldn't tell the latest stable release, and gives null, when that call fails", async () => {
      const r = await run(checkout(candidateFiles()), fakeGitHub({ releases: { [CANDIDATE]: REQ } }), ['--json']);
      expect(ids(r)).toEqual(['pin.candidate .github']);
      expect(r.json.findings[0].message).toContain("doctor couldn't tell the latest stable release");
      expect(r.json.releases.stable).toBeNull();
      expect(r.status).toBe(EXIT.healthy);
    });

    it('offers the stable release once it is at or past the candidate', async () => {
      const r = await run(checkout(candidateFiles()), fakeGitHub({ releases: { [CANDIDATE]: REQ }, latest: PINNED }), ['--json']);
      expect(r.json.findings[0].fix.text).toContain(`to ${PINNED}; the upgrade skill does it`);
    });

    it('reports a candidate beside its own stable release as two releases', async () => {
      const files = candidateFiles();
      files['.github/workflows/ci.yml'] = files['.github/workflows/ci.yml']!.split(`@${CANDIDATE}`).join(`@${PINNED}`);
      const r = await run(checkout(files), fakeGitHub({ releases: { [CANDIDATE]: REQ } }), ['--json']);
      expect(ids(r)).toContain('pin.mixed .github');
      expect(r.json.releases.pins).toEqual(expect.arrayContaining([CANDIDATE, PINNED]));
      expect(r.status).toBe(EXIT.findings);
    });

    it('gives the latest stable release to a stable pin too, and notes nothing', async () => {
      const r = await run(checkout(healthyFiles()), fakeGitHub({ latest: 'v1.1.0' }), ['--json']);
      expect(ids(r)).toEqual([]);
      expect(r.json.releases.stable).toBe('v1.1.0');
    });

    it('reads no pre-release as the latest stable', async () => {
      const r = await run(checkout(healthyFiles()), fakeGitHub({ latest: 'candidate-v1.1.0' }), ['--json']);
      expect(r.json.releases.stable).toBeNull();
    });

    it('takes a candidate with --to, and nothing shorter', () => {
      expect(parseArgs(['--to', CANDIDATE]).to).toBe(CANDIDATE);
      for (const bad of ['candidate-v1', 'candidate-v1.2', 'stable', 'v0', `${CANDIDATE}x`]) expect(() => parseArgs(['--to', bad]), bad).toThrow(/vX\.Y\.Z or candidate-vX\.Y\.Z/);
    });
  });

  it('says it is incomplete, exit 4, when the token cannot list the secrets', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub({ secrets: null }), ['--json']);
    expect(r.status).toBe(EXIT.incomplete);
    expect(r.json.status).toBe('incomplete');
    expect(r.json.unchecked).toEqual([{ check: 'secrets', subject: REPO, reason: expect.stringContaining('secret names') }]);
  });

  it('refuses, exit 3, where nothing pins Kanon, and outside a checkout', async () => {
    const dir = checkout({ 'README.md': 'hello\n' });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status).toBe(EXIT.error);
    expect(r.json.error).toContain('pins Kanon');
    const bare = mkdtempSync(join(tmpdir(), 'kanon-doctor-bare-'));
    scratch.push(bare);
    const out = await run(bare, fakeGitHub());
    expect(out.status).toBe(EXIT.error);
    expect(out.err).toContain('is not a git checkout');
  });

  it('refuses a bad argument with exit 2, as JSON when --json was asked for', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--to', 'latest', '--json']);
    expect(r.status).toBe(EXIT.usage);
    expect(r.json).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: expect.stringContaining('vX.Y.Z') });
  });

  it('prints the error document for --help with --json, not the usage text (#457)', async () => {
    const dir = checkout(healthyFiles());
    for (const h of ['--help', '-h']) {
      const r = await run(dir, fakeGitHub(), [h, '--json']);
      expect(r.status, h).toBe(EXIT.usage);
      expect(r.json, h).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: '--help and --json contradict each other; give one' });
    }
    // Without --json, --help prints the usage on standard output, as before.
    const help = await run(dir, fakeGitHub(), ['--help']);
    expect(help.status).toBe(EXIT.healthy);
    expect(help.out).toContain('Usage: kanon doctor');
  });

  it('never takes the next flag as a value flag\'s value, and prints the error document under --json (#457)', async () => {
    // `kanon doctor --dir --json`, as an unset, unquoted variable leaves it.
    for (const f of ['--dir', '--repo', '--to']) {
      const out: string[] = [];
      const err: string[] = [];
      const status = await doctor([f, '--json'], { gh: fakeGitHub().gh, env: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l), requirements: () => REQ, release: () => PINNED });
      expect(status, f).toBe(EXIT.usage);
      expect(JSON.parse(out.join('\n')), f).toMatchObject({
        schema: SCHEMA,
        status: 'error',
        exitCode: 2,
        error: `${f} needs a value, not the flag "--json"; to give a value that begins with "-", write ${f}=<value>`,
      });
      expect(err, f).toEqual([]);
    }
    expect(() => parseArgs(['--dir', '-h'])).toThrow('--dir needs a value, not the flag "-h"');
    // A value that begins with "-" is given inline.
    expect(parseArgs(['--dir=-x', '--json'])).toMatchObject({ dir: '-x', json: true });
  });
});

// #418, L5's G14: doctor told the Owner to require "Lane check" while the lane check ran as a step
// of another job, and before the pull request adding its job had merged, so every other open
// pull request waited, approved and green, on a check its branch could never produce.
describe('kanon doctor and the job behind a required check (#418)', () => {
  /** Kanon's own shape before #394: the lane check as a step of another job. */
  const asStep = `name: CI\non:\n  pull_request:\njobs:\n  test:\n    name: Lint, type-check and unit tests\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n      - uses: yedeya-labs/kanon/actions/lane-check@${PINNED}\n`;
  const withoutCheck = (github: ReturnType<typeof fakeGitHub>) => {
    github.st.rulesets = [{ ...github.st.rulesets[0]!, rules: github.st.rulesets[0]!.rules.filter((x) => x.type !== 'required_status_checks') }];
  };

  it('asks for the rule once a job on the default branch reports the check', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.rule-missing main']);
    expect(r.json.findings[0].message).toContain('require the status check "Lane check"');
  });

  it("doesn't offer the rule for a check whose job is only on this checkout's branch: the job's pull request merges first", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = {};
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.status).toBe(EXIT.findings);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'ruleset', blocking: true, subject: 'Lane check', fix: { url: `https://github.com/yedeya-labs/kanon/blob/${PINNED}/actions/lane-check/README.md` } });
    expect(f.message).toContain('so the ruleset can\'t require it yet');
    expect(f.fix.text).toContain('This checkout adds it (.github/workflows/ci.yml#lanes): merge the pull request that adds it to main first.');
    expect(f.fix.text).toContain('once the job is on main');
  });

  it('asks for a job of its own when the lane check runs as a step of another job, on the branch and the default branch alike', async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = asStep;
    const dir = checkout(files);
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = { 'ci.yml': asStep };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].fix.text).toMatch(/^Add a job of its own named "Lane check", in a workflow that runs on pull_request/);
  });

  it('names a ruleset that already requires a check no job on the default branch reports', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    github.st.defaultWorkflows = { 'ci.yml': asStep };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].message).toContain('requires the status check "Lane check", but no job of a workflow on main reports it');
    expect(r.json.findings[0].fix.text).toContain('Until it merges, every other pull request waits on the check.');
  });

  it("can't tell without the default branch's workflows: lists the check as unchecked, and doesn't ask for the rule", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = null;
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.status).toBe(EXIT.incomplete);
    // The review lane's caller is looked for there too, to tell whether bootstrap can end (#706).
    expect(r.json.unchecked).toEqual([
      { check: 'required-check', subject: 'Lane check', reason: expect.stringContaining("doesn't ask you to require it yet") },
      { check: 'ruleset', subject: 'main', reason: expect.stringContaining('whether bootstrap can end') },
    ]);
  });

  // #446: a job whose workflow filters pull_request runs on some pull requests only, and GitHub
  // never reports its check on the others, which then wait on the required check.
  const filtered = (filter: string) => ciFile(PINNED, 'main').replace('  pull_request:\n', `  pull_request:\n${filter}`);

  it("doesn't ask for the rule while the only job that reports the check skips some pull requests, and names the filter", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = { 'ci.yml': filtered("    paths: ['src/**']\n") };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    const f = r.json.findings[0];
    expect(f.message).toContain("so the ruleset can't require it yet");
    expect(f.message).toContain('The only job there that reports it (.github/workflows/ci.yml#lanes) runs on some pull requests only (pull_request.paths), and a pull request it skips never gets the check.');
    // This checkout's ci.yml has no filter, so its pull request merges first.
    expect(f.fix.text).toContain('This checkout adds it (.github/workflows/ci.yml#lanes)');
  });

  it('tells a ruleset that already requires the check to run its job on every pull request when the checkout filters it too', async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = filtered('    types: [labeled]\n');
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.defaultWorkflows = { 'ci.yml': filtered('    types: [labeled]\n') };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].message).toContain('requires the status check "Lane check", but no job of a workflow on main reports it on every pull request');
    expect(r.json.findings[0].fix.text).toMatch(/^Run the job on every pull request: take pull_request\.types off the workflow's trigger/);
  });

  it('counts a job whose filters skip no pull request into the default branch', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = { 'ci.yml': filtered("    branches: [main]\n    types: [opened, synchronize, reopened, labeled]\n") };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.rule-missing main']);
  });

  it('is waived like any other finding, on the check it names', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += `- **${WAIVER_LABEL}:** \`ruleset.check-unreported\` on \`Lane check\` (another CI reports it)\n`;
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.defaultWorkflows = {};
    const r = await run(dir, github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(r.json.waived.map((w: { id: string; reason: string }) => [w.id, w.reason])).toEqual([['ruleset.check-unreported', 'another CI reports it']]);
  });
});

// #459: a ruleset with a merge queue waits for each required check on the queue's merge_group run,
// so the job behind the check must run on that event too.
describe('kanon doctor and the job behind a required check, through a merge queue (#459)', () => {
  const queued = (github: ReturnType<typeof fakeGitHub>) => {
    github.st.rulesets = [{ id: 7, ...rulesetBody(true) }];
  };
  const noQueueEvent = (text: string) => text.replace('  merge_group:\n', '');

  it("doesn't count a job whose workflow doesn't run on merge_group, and names the job and the trigger", async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = noQueueEvent(files['.github/workflows/ci.yml']!);
    const dir = checkout(files);
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    const f = r.json.findings[0];
    expect(f.message).toBe('The ruleset on main requires the status check "Lane check", but no job of a workflow on main reports it on every pull request and every queued merge, so every one that doesn\'t get it waits on it (K-ADOPT-1 step 8). .github/workflows/ci.yml#lanes doesn\'t run on merge_group, the event the merge queue on main runs its checks on, so a queued merge never gets the check and waits on it.');
    expect(f.fix.text).toMatch(/^Run the job on every pull request and every queued merge: add merge_group to the triggers of \.github\/workflows\/ci\.yml, or move the job to a workflow of its own on pull_request and merge_group with no filter/);
  });

  it('says the checkout adds merge_group when its workflow runs on it', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].fix.text).toContain('This checkout adds it (.github/workflows/ci.yml#lanes): merge the pull request that adds it to main first.');
  });

  it("names a merge_group filter that skips the default branch, and a job of its own when none reports it", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': ciFile(PINNED, 'main').replace('  merge_group:\n', '  merge_group:\n    branches: [release]\n') };
    const r = await run(dir, github, ['--json']);
    expect(r.json.findings[0].message).toContain('The job there that reports it (.github/workflows/ci.yml#lanes) runs on some runs only (merge_group.branches), and a run it skips never gets the check.');
    github.st.defaultWorkflows = {};
    const none = await run(checkout({ ...healthyFiles(), '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: "true"\n' }), github, ['--json']);
    expect(none.json.findings.find((x: { id: string }) => x.id === 'ruleset.check-unreported').fix.text).toMatch(/^Add a job of its own named "Lane check", in a workflow that runs on pull_request and merge_group,/);
  });

  it('is healthy when the job runs on merge_group, and asks nothing of it without a merge queue', async () => {
    const github = fakeGitHub();
    queued(github);
    expect(ids(await run(checkout(healthyFiles()), github, ['--json']))).toEqual([]);
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = noQueueEvent(files['.github/workflows/ci.yml']!);
    const plain = fakeGitHub();
    plain.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    expect(ids(await run(checkout(files), plain, ['--json']))).toEqual([]);
  });

  it('is waived like any other finding', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += `- **${WAIVER_LABEL}:** \`ruleset.check-unreported\` on \`Lane check\` (the queue's checks run elsewhere)\n`;
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    const r = await run(checkout(files), github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['ruleset.check-unreported']);
  });
});

// #452 (#79): a merge through a merge queue doesn't start a lane on CI finishing on the default
// branch, so doctor notes it, in the catalogue's words, for a lane the repository calls. It blocks
// nothing. #484: the rebase lane's caller starts it on the merged pull request instead, so doctor
// notes a rebase caller without that trigger, which an upgrade of the pin alone doesn't add.
describe('kanon doctor and a lane a merge queue changes (#452, #484)', () => {
  const rebaseCaller = callerFile('agent-rebase', REQ.lanes['agent-rebase']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
  // A caller written before #484: the same, without the merged-pull-request trigger.
  const before484 = rebaseCaller.replace(/ {2}# A merged pull request[^\n]*\n[^\n]*\n {2}pull_request_target:\n {4}types: \[closed\]\n {4}branches: \[main\]\n/, '');
  const withRebase = (text = rebaseCaller) => ({ ...healthyFiles(), '.github/workflows/agent-rebase.yml': text });
  const withMerge = () => ({ ...healthyFiles(), '.github/workflows/agent-merge.yml': callerFile('agent-merge', REQ.lanes['agent-merge']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' }) });
  const noteOf = (r: Result) => (r.json.notes as string[]).filter((n) => n.includes('merges through a merge queue'));
  const queued = () => {
    const github = fakeGitHub();
    github.st.rulesets = [{ id: 7, ...rulesetBody(true) }];
    return github;
  };

  it('notes a called lane that a merge through the queue does not start, and nothing else changes', async () => {
    const r = await run(checkout(withMerge()), queued(), ['--json']);
    expect(noteOf(r)).toEqual([`main merges through a merge queue, and you call agent-merge. ${REQ.catalogue!.lanes['agent-merge']!.mergeQueue}`]);
    expect(r.json.findings.filter((f: { blocking: boolean }) => f.blocking).map((f: { id: string }) => f.id)).not.toContain('ruleset.check-unreported');
  });

  it("notes nothing for the rebase caller kanon init writes, which a merge through the queue starts", async () => {
    expect(before484).not.toBe(rebaseCaller);
    expect(before484).not.toContain('pull_request_target');
    expect(noteOf(await run(checkout(withRebase()), queued(), ['--json']))).toEqual([]);
  });

  it('notes a rebase caller without the merged-pull-request trigger, by file, with what to add', async () => {
    const notes = noteOf(await run(checkout(withRebase(before484)), queued(), ['--json']));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('.github/workflows/agent-rebase.yml calls agent-rebase without a trigger on a merged pull request');
    expect(notes[0]).toContain('`pull_request_target: { types: [closed], branches: [main] }`');
  });

  it('notes nothing without a merge queue, or for a lane the repository does not call', async () => {
    expect(noteOf(await run(checkout(withMerge()), fakeGitHub(), ['--json']))).toEqual([]);
    expect(noteOf(await run(checkout(withRebase(before484)), fakeGitHub(), ['--json']))).toEqual([]);
    expect(noteOf(await run(checkout(healthyFiles()), queued(), ['--json']))).toEqual([]);
  });
});

describe('startsOnMerge: whether a caller runs on a pull request closed on the branch (#484)', () => {
  const wf = (on: unknown) => ({ on });
  it('needs `closed` in the types, which the default types lack', () => {
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], branches: ['main'] } }), 'main')).toBe(true);
    expect(startsOnMerge(wf({ pull_request_target: { types: 'closed' } }), 'main')).toBe(true);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['opened', 'labeled'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request_target: null }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request: { types: ['closed'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf('pull_request_target'), 'main')).toBe(false);
    expect(startsOnMerge(wf(['pull_request_target']), 'main')).toBe(false);
  });
  it('and a branch filter that admits the branch', () => {
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], branches: ['trunk'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], branches: ['releases/**'] } }), 'main')).toBe(true);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], 'branches-ignore': ['main'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], 'branches-ignore': ['other'] } }), 'main')).toBe(true);
  });
});

describe("branchWorkflows: the default branch's workflows, read from GitHub (#418)", () => {
  const read = (reply: Gh) => branchWorkflows({ gh: async () => reply } as unknown as Parameters<typeof branchWorkflows>[0], REPO, 'main');
  const lane = 'on: pull_request\njobs:\n  lanes:\n    name: Lane check\n    runs-on: x\n';

  it('reads each workflow file, and only files', async () => {
    const r = await read(ok({ data: { repository: { object: { entries: [
      { name: 'ci.yml', type: 'blob', object: { text: lane } },
      { name: 'nested.yml', type: 'tree', object: { text: lane } },
      { name: 'notes.md', type: 'blob', object: { text: lane } },
      { name: 'broken.yml', type: 'blob', object: { text: 'a: &x 1\n' } },
      { name: 'big.yml', type: 'blob', object: { text: null } },
    ] } } } }));
    expect(r.error).toBeNull();
    expect([...r.workflows!.keys()]).toEqual(['.github/workflows/ci.yml']);
  });

  it('has none on a branch without the directory, and says why when GitHub refuses or errs', async () => {
    expect([...(await read(ok({ data: { repository: { object: null } } }))).workflows!.keys()]).toEqual([]);
    expect((await read(no('HTTP 403'))).error).toBe('HTTP 403');
    expect((await read(ok({ errors: [{ message: 'Could not resolve to a Repository' }] }))).error).toBe('Could not resolve to a Repository');
    expect((await read(ok({ data: { repository: null } }))).error).toBe('GitHub returned no repository');
    expect((await read(ok('not json'))).error).toBe("GitHub's answer was not JSON");
  });
});

describe('checkReporters: which jobs report a status check on a pull request (#418)', () => {
  const wf = (on: unknown, jobs: Record<string, unknown>) => ({ on, jobs });
  const job = { name: 'Lane check', 'runs-on': 'ubuntu-latest', steps: [] };
  const one = (w: Record<string, unknown>) => checkReporters(new Map([['.github/workflows/x.yml', w]]), 'Lane check');

  it("counts a job named exactly the check, in a workflow on pull_request, however `on` is written", () => {
    expect(one(wf({ pull_request: null }, { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    expect(one(wf('pull_request', { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    expect(one(wf(['push', 'pull_request'], { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    expect(one(wf({ pull_request_target: null }, { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    // A job with no name reports its key.
    expect(checkReporters(new Map([['w.yml', wf('pull_request', { lanes: { 'runs-on': 'x' } })]]), 'lanes')).toEqual(['w.yml#lanes']);
  });

  it('counts no job that reports under another name, or not on a pull request', () => {
    expect(one(wf({ push: null, merge_group: null }, { lanes: job }))).toEqual([]);
    expect(one(wf('push', { lanes: job }))).toEqual([]);
    expect(one(wf(['push'], { lanes: job }))).toEqual([]);
    expect(one(wf({ pull_request: null }, { lanes: { ...job, name: 'Lane checks' } }))).toEqual([]);
    expect(one(wf({ pull_request: null }, { 'lane-check': { 'runs-on': 'x' } }))).toEqual([]);
    // A reusable workflow's call reports "<name> / <its job>", a matrix job "<name> (<values>)".
    expect(one(wf({ pull_request: null }, { lanes: { name: 'Lane check', uses: './.github/workflows/l.yml' } }))).toEqual([]);
    expect(one(wf({ pull_request: null }, { lanes: { ...job, strategy: { matrix: { os: ['a', 'b'] } } } }))).toEqual([]);
    // A strategy without a matrix keeps the name.
    expect(one(wf({ pull_request: null }, { lanes: { ...job, strategy: { 'fail-fast': false } } }))).toEqual(['.github/workflows/x.yml#lanes']);
  });
});

describe('checkJobs: the filters that skip some pull requests (#446)', () => {
  const job = { name: 'Lane check', 'runs-on': 'ubuntu-latest', steps: [] };
  const filtersOf = (on: unknown, branch = 'main') => checkJobs(new Map([['x.yml', { on, jobs: { lanes: job } }]]), 'Lane check', branch).map((j) => j.filters);
  const reports = (on: unknown, branch = 'main') => checkReporters(new Map([['x.yml', { on, jobs: { lanes: job } }]]), 'Lane check', branch);

  it('names each filter that skips a pull request, by its event', () => {
    expect(filtersOf({ pull_request: { paths: ['src/**'] } })).toEqual([['pull_request.paths']]);
    expect(filtersOf({ pull_request: { 'paths-ignore': ['docs/**'] } })).toEqual([['pull_request.paths-ignore']]);
    expect(filtersOf({ pull_request: { branches: ['release/**'] } })).toEqual([['pull_request.branches']]);
    expect(filtersOf({ pull_request: { 'branches-ignore': ['ma*'] } })).toEqual([['pull_request.branches-ignore']]);
    expect(filtersOf({ pull_request_target: { types: ['labeled'] } })).toEqual([['pull_request_target.types']]);
    expect(filtersOf({ pull_request: { types: 'opened' } })).toEqual([['pull_request.types']]);
    expect(filtersOf({ pull_request: { paths: ['a'], types: ['opened', 'synchronize'] } })).toEqual([['pull_request.paths', 'pull_request.types']]);
    expect(reports({ pull_request: { paths: ['src/**'] } })).toEqual([]);
  });

  it('counts a trigger whose filters skip no pull request into the branch', () => {
    expect(reports({ pull_request: null })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { types: ['opened', 'reopened', 'synchronize', 'labeled'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { types: null } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['main'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: 'main' } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['ma*'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { 'branches-ignore': ['release/**'] } })).toEqual(['x.yml#lanes']);
    // One unfiltered trigger is enough: the workflow runs on every pull request through it.
    expect(reports({ pull_request: { paths: ['a'] }, pull_request_target: null })).toEqual(['x.yml#lanes']);
    expect(filtersOf({ pull_request: { paths: ['a'] }, pull_request_target: { types: ['closed'] } })).toEqual([['pull_request.paths', 'pull_request_target.types']]);
  });

  it('reads a branches list as GitHub does: the last pattern it matches decides, and a ! one excludes', () => {
    expect(reports({ pull_request: { branches: ['**', '!main'] } })).toEqual([]);
    expect(reports({ pull_request: { branches: ['!main', '**'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['release/*'] } }, 'release/1')).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['release/*'] } }, 'release/1/x')).toEqual([]);
    expect(reports({ pull_request: { branches: ['release/**'] } }, 'release/1/x')).toEqual(['x.yml#lanes']);
    // Without the branch, any branch filter counts as one that skips.
    const anyBranch = (on: unknown) => checkReporters(new Map([['x.yml', { on, jobs: { lanes: job } }]]), 'Lane check');
    expect(anyBranch({ pull_request: { branches: ['main'] } })).toEqual([]);
    expect(anyBranch({ pull_request: { 'branches-ignore': ['x'] } })).toEqual([]);
    expect(anyBranch({ pull_request: null })).toEqual(['x.yml#lanes']);
  });
});

describe("branchPattern: a branch filter's pattern, as GitHub matches it (#446)", () => {
  const m = (p: string, b: string) => branchPattern(p).test(b);
  it('matches *, **, ?, +, a class and an escape', () => {
    expect([m('main', 'main'), m('main', 'mainx'), m('mai', 'main')]).toEqual([true, false, false]);
    expect([m('feat/*', 'feat/a'), m('feat/*', 'feat/a/b'), m('feat/**', 'feat/a/b'), m('*', 'a/b')]).toEqual([true, false, true, false]);
    expect([m('mains?', 'main'), m('mains?', 'mains'), m('ma+in', 'maaain'), m('ma+in', 'min')]).toEqual([true, true, true, false]);
    expect([m('v[0-9].x', 'v1.x'), m('v[0-9].x', 'va.x'), m('v1.x', 'v1yx')]).toEqual([true, false, false]);
    expect([m('a\\*b', 'a*b'), m('a\\*b', 'axb'), m('[ab', '[ab'), m('[z-a]', 'z')]).toEqual([true, false, true, false]);
  });
});

// #749: the Lead writes each brief from docs/projects/_template.md, which an adopter copies
// unchanged from Kanon's brief template (K-LAYOUT-11), and `kanon init` writes beside its caller.
describe("kanon doctor and the Lead's brief template (#749)", () => {
  const TEMPLATE = 'docs/projects/_template.md';
  const withLead = (template: string | null) => {
    const files = healthyFiles();
    files['.github/workflows/agent-lead.yml'] = callerFile('agent-lead', REQ.lanes['agent-lead']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
    if (template !== null) files[TEMPLATE] = template;
    return files;
  };
  const lead = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'lead.template-missing');

  it('lead.template-missing: names the template, without blocking, where the Lead\'s caller exists and the template does not', async () => {
    const r = await run(checkout(withLead(null)), fakeGitHub(), ['--json']);
    expect(lead(r)).toEqual([{
      id: 'lead.template-missing',
      category: 'declaration',
      blocking: false,
      subject: TEMPLATE,
      message: `is missing; the Lead, which .github/workflows/agent-lead.yml calls, writes each brief from it (K-LAYOUT-11).`,
      fix: {
        text: `Copy Kanon's brief template to it unchanged, as kanon init writes it, from the release you check (${PINNED}):`,
        commands: [
          'mkdir -p docs/projects',
          `gh api -H 'Accept: application/vnd.github.raw+json' 'repos/yedeya-labs/kanon/contents/rulebook/templates/brief.md?ref=${PINNED}' > ${TEMPLATE}`,
        ],
        url: `https://github.com/yedeya-labs/kanon/blob/${PINNED}/rulebook/templates/brief.md`,
      },
    }]);
  });

  it('names a file that calls the Lead from two jobs once', async () => {
    const files = withLead(null);
    const caller = files['.github/workflows/agent-lead.yml']!;
    files['.github/workflows/agent-lead.yml'] = caller + caller.slice(caller.indexOf('  brief:')).replace('  brief:', '  again:');
    const r = await run(checkout(files), fakeGitHub(), ['--json']);
    expect(lead(r).map((f: { message: string }) => f.message)).toEqual([
      `is missing; the Lead, which .github/workflows/agent-lead.yml calls, writes each brief from it (K-LAYOUT-11).`,
    ]);
  });

  it("is absent where the template exists, or nothing calls the Lead", async () => {
    expect(lead(await run(checkout(withLead(KANONS)), fakeGitHub(), ['--json']))).toEqual([]);
    expect(lead(await run(checkout(withLead('# Our brief template\n')), fakeGitHub(), ['--json']))).toEqual([]);
    const r = await run(checkout(healthyFiles()), fakeGitHub(), ['--json']);
    expect(r.json.findings).toEqual([]);
  });

  // #755: K-LAYOUT-11's adopter replaces the copy when Kanon's template changes, so doctor names
  // one that differs from the checked release's, with lead.template-missing's copy command.
  const KANONS = readFileSync(new URL('../../rulebook/templates/brief.md', import.meta.url), 'utf8');
  const stale = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'lead.template-stale');
  const copyFix = (release: string) => ({
    text: `Replace it with Kanon's brief template, unchanged, as kanon init writes it, from the release you check (${release}):`,
    commands: [
      'mkdir -p docs/projects',
      `gh api -H 'Accept: application/vnd.github.raw+json' 'repos/yedeya-labs/kanon/contents/rulebook/templates/brief.md?ref=${release}' > ${TEMPLATE}`,
    ],
    url: `https://github.com/yedeya-labs/kanon/blob/${release}/rulebook/templates/brief.md`,
  });

  it('lead.template-stale: names a template that differs from the checked release\'s, without blocking, with the copy command', async () => {
    const r = await run(checkout(withLead(KANONS.replace('## ', '## Our '))), fakeGitHub(), ['--json']);
    expect(stale(r)).toEqual([{
      id: 'lead.template-stale',
      category: 'declaration',
      blocking: false,
      subject: TEMPLATE,
      message: `differs from Kanon's brief template at ${PINNED}; the Lead, which .github/workflows/agent-lead.yml calls, writes each brief from it, and the brief guard holds those briefs to ${PINNED}'s rules (K-LAYOUT-11).`,
      fix: copyFix(PINNED),
    }]);
    expect(stale(r)[0].fix.commands).toEqual((lead(await run(checkout(withLead(null)), fakeGitHub(), ['--json']))[0] as { fix: { commands: string[] } }).fix.commands);
    expect([r.status, r.json.status]).toEqual([EXIT.healthy, 'healthy']);
    expect(lead(r)).toEqual([]);
  });

  it('is absent for an exact copy, and for one a checkout wrote with CRLF line endings', async () => {
    for (const copy of [KANONS, KANONS.replace(/\n/g, '\r\n')]) {
      const r = await run(checkout(withLead(copy)), fakeGitHub(), ['--json']);
      expect(stale(r)).toEqual([]);
      expect(r.json.findings).toEqual([]);
      expect(r.json.unchecked).toEqual([]);
    }
    // A copy with one byte more is not exact.
    expect(stale(await run(checkout(withLead(`${KANONS}\n`)), fakeGitHub(), ['--json']))).toHaveLength(1);
  });

  it("compares with the --to release's template, read from Kanon's repository at its tag", async () => {
    const TO = 'v1.1.0';
    const github = () => fakeGitHub({ releases: { [TO]: REQ }, templates: { [TO]: `${KANONS}\n## A new section\n` } });
    const drifted = await run(checkout(withLead(KANONS)), github(), ['--json', '--to', TO]);
    expect(stale(drifted)).toEqual([expect.objectContaining({ subject: TEMPLATE, message: expect.stringContaining(`differs from Kanon's brief template at ${TO}`), fix: copyFix(TO) })]);
    const gh = github();
    const exact = await run(checkout(withLead(`${KANONS}\n## A new section\n`)), gh, ['--json', '--to', TO]);
    expect(stale(exact)).toEqual([]);
    expect(gh.calls).toContainEqual(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/yedeya-labs/kanon/contents/rulebook/templates/brief.md?ref=${TO}`]);
  });

  it("lists the check as unchecked, and reports nothing, when the release's template can't be read", async () => {
    const TO = 'v1.1.0';
    const r = await run(checkout(withLead('# Our brief template\n')), fakeGitHub({ releases: { [TO]: REQ } }), ['--json', '--to', TO]);
    expect(stale(r)).toEqual([]);
    expect(r.json.unchecked).toEqual([{ check: 'brief-template', subject: TEMPLATE, reason: expect.stringContaining(`could not read Kanon ${TO}'s brief template (gh: Not Found (HTTP 404))`) }]);
    expect([r.status, r.json.status]).toEqual([EXIT.incomplete, 'incomplete']);
  });

  it('reads no release template where nothing calls the Lead, or the template is missing', async () => {
    const TO = 'v1.1.0';
    for (const files of [healthyFiles(), withLead(null)]) {
      const gh = fakeGitHub({ releases: { [TO]: REQ } });
      const r = await run(checkout(files), gh, ['--json', '--to', TO]);
      expect(r.json.unchecked).toEqual([]);
      expect(gh.calls.some((c) => c.some((x) => x.includes('rulebook/templates/brief.md')))).toBe(false);
    }
  });

  it('can be waived, with its reason, as any finding that does not block', async () => {
    const files = withLead('# Our brief template\n');
    files['docs/qa/adoption.md'] += `- **${WAIVER_LABEL}:** \`lead.template-stale\` on \`${TEMPLATE}\` (we keep our own sections)\n`;
    const r = await run(checkout(files), fakeGitHub(), ['--json']);
    expect(stale(r)).toEqual([]);
    expect(r.json.waived).toEqual([expect.objectContaining({ id: 'lead.template-stale', subject: TEMPLATE, reason: 'we keep our own sections' })]);
  });
});

// #743: doctor reports the review, implement-revise and merge-reconcile callers' names, and the two
// racers' job ids, from lane-check's own table, at lane-check's own switch: a warning (not
// blocking) against a release before FAILS_FROM, a failure (blocking) from it.
describe('kanon doctor on the fixed caller names and job ids (#743)', () => {
  const RACERS = ['agent-implement-revise', 'agent-merge-reconcile'];
  const at = (lane: string) => `.github/workflows/${lane}.yml`;
  const withRacers = () => {
    const files = healthyFiles();
    for (const lane of RACERS) files[at(lane)] = callerFile(lane, REQ.lanes[lane]!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
    return files;
  };
  type F = { id: string; subject: string; blocking: boolean; message: string; fix: { text: string; commands: string[] } };
  const named = (r: Result): F[] => r.json.findings.filter((f: F) => ['caller.name', 'caller.job-id'].includes(f.id));
  /** Renames the review and merge-reconcile callers, and the implement-revise caller's job. */
  const renamed = () => {
    const files = withRacers();
    files[at('agent-review')] = files[at('agent-review')]!.replace(/^name: .*$/m, 'name: Review (Thomas)');
    files[at('agent-merge-reconcile')] = files[at('agent-merge-reconcile')]!.replace(/^name: .*$/m, 'name: Reconcile');
    files[at('agent-implement-revise')] = files[at('agent-implement-revise')]!.replace(/^ {2}revise:$/m, '  fix-up:');
    return files;
  };
  const versioned = (to: string) => fakeGitHub({ releases: { [to]: REQ } });

  it('reports nothing for the callers kanon init writes', async () => {
    const r = await run(checkout(withRacers()), fakeGitHub(), ['--json']);
    expect(named(r)).toEqual([]);
  });

  it('reports each wrong name and job id as lane-check does, blocking from FAILS_FROM on', async () => {
    const r = await run(checkout(renamed()), fakeGitHub(), ['--json']);
    expect(named(r).map((f) => [f.id, f.subject, f.blocking])).toEqual([
      ['caller.job-id', at('agent-implement-revise'), true],
      ['caller.name', at('agent-merge-reconcile'), true],
      ['caller.name', at('agent-review'), true],
    ]);
    const [revise, reconcile, review] = named(r) as [F, F, F];
    expect(review.message).toBe(`${callerNameFindings('agent-review', 'Review (Thomas)', null, PINNED)[0]!.message}.`);
    expect(review.message).toContain("an earlier release's spelling");
    expect(review.fix.commands).toEqual([`name: ${FIXED_CALLERS['agent-review']!.name}`]);
    expect(revise.message).toContain('`revise`, not `fix-up`');
    expect(revise.fix).toMatchObject({ text: 'Rename the calling job from `fix-up:` to:', commands: ['  revise:'] });
    expect(reconcile.fix.commands).toEqual([`name: ${FIXED_CALLERS['agent-merge-reconcile']!.name}`]);
    for (const f of named(r)) expect(f.message, f.subject).toContain(`since Kanon ${FAILS_FROM} this fails`);
  });

  it('reports them without blocking against a release before FAILS_FROM, and blocking at it', async () => {
    const [major, minor] = FAILS_FROM.split('.').map(Number) as [number, number];
    const before = `v${major}.${minor - 1}.9`;
    const early = await run(checkout(renamed()), versioned(before), ['--json', '--to', before]);
    expect(named(early)).toHaveLength(3);
    for (const f of named(early)) {
      expect(f.blocking, f.subject).toBe(false);
      expect(f.message).toContain(`this is a warning until Kanon ${FAILS_FROM}, and a failure from it`);
    }
    const from = await run(checkout(renamed()), versioned(`v${FAILS_FROM}`), ['--json', '--to', `v${FAILS_FROM}`]);
    expect(named(from).map((f) => f.blocking)).toEqual([true, true, true]);
  });

  it("holds them to the checked release's `# CALLER NAME:` and `# CALLER JOB:` lines, as its requirements file records them (#728)", async () => {
    const [major, minor] = FAILS_FROM.split('.').map(Number) as [number, number];
    const before = `v${major}.${minor - 1}.9`;
    const marked = structuredClone(REQ);
    marked.lanes['agent-merge-reconcile']!.callerName = 'Marked Name';
    marked.lanes['agent-merge-reconcile']!.callerJob = 'marked';
    const r = await run(checkout(withRacers()), fakeGitHub({ releases: { [before]: marked } }), ['--json', '--to', before]);
    const found = named(r);
    expect(found.map((f) => [f.id, f.subject, f.blocking])).toEqual([
      ['caller.name', at('agent-merge-reconcile'), false],
      ['caller.job-id', at('agent-merge-reconcile'), false],
    ]);
    expect(found[0]!.message).toContain(`its name must be \`Marked Name\`, not \`${FIXED_CALLERS['agent-merge-reconcile']!.name}\``);
    expect(found[0]!.fix.commands).toEqual(['name: Marked Name']);
    expect(found[1]!.fix.commands).toEqual(['  marked:']);
  });

  it('reads no job id from a caller with more than one job, as lane-check reads none', async () => {
    const files = withRacers();
    const path = at('agent-implement-revise');
    files[path] = `${files[path]!.replace(/^ {2}revise:$/m, '  fix-up:')}  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
    const r = await run(checkout(files), fakeGitHub(), ['--json']);
    expect(named(r)).toEqual([]);
  });

  it('documents the switch at the release lane-check fails from', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/doctor.md'), 'utf8');
    for (const id of ['caller.name', 'caller.job-id']) {
      const row = doc.split('\n').find((l) => l.startsWith(`| \`${id}\` |`))!;
      expect(row, id).toContain(FAILS_FROM);
      expect(row, id).toContain('#743');
    }
  });
});

// #1262: a ruleset GitHub says applies to the default branch, which the token couldn't read whole,
// was dropped without a word, and doctor then said no ruleset covered the branch.
describe('kanon doctor and a ruleset it could not read (#1262)', () => {
  it("raises ruleset.unreadable with the ruleset's page, and not ruleset.missing", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    github.st.unreadableRulesets = [7];
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.unreadable main']);
    expect(r.json.findings[0].fix.url).toBe(`https://github.com/${REPO}/settings/rules/7`);
  });
});
