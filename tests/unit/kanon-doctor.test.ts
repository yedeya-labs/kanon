import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { appSecrets } from '../../cli/callers.mjs';
import { CATEGORIES, doctor, EXIT, FINDINGS, HOLDER_LABEL, idTokenGrant, ITEMIZED, kanonPins, readHolderAcceptances, readWaivers, SCHEMA, UNWAIVABLE, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { laneFiles, laneTree } from './helpers/requirements.js';
import { checkout, clone, fakeGitHub, healthyFiles, ids, LANES, NEW_DOC, NEXT, nextRelease, permissionsOf, PINNED, put, REPO, REQ, ROOT, run, TAXONOMY, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';


/**
 * `kanon doctor` (plan 0005 §5.5, step L10). Every case runs the command against a real git
 * checkout in a temporary directory and a FAKE GitHub: `gh` is a function holding one
 * repository's state, one App per identity and Kanon's requirements file at each release, so
 * nothing reaches the network, and the test asserts that doctor only ever reads.
 *
 * The plan's falsifiable checks for L10:
 *  - on a fixture pinned at one release, `doctor --to` a release whose requirements add an App
 *    permission and a declaration lists exactly those two, and exits non-zero; after both are
 *    fixed it exits 0;
 *  - a requirements file that drops the permission makes doctor miss it, and the test that
 *    compares the requirements file with the lanes' minting steps turns red;
 *  - a job of the adopter's holding `id-token: write` (its own grant, inherited from the
 *    workflow, `write-all`, or passed to a reusable workflow of its own) is named, and the run
 *    exits non-zero until the adoption record accepts it or the grant is removed; a caller of
 *    Kanon's code-audit lane at the pinned release is listed as Kanon's and accepted; a job with
 *    `id-token: none` is not listed.
 * And ADR 0014's: the `--json` document is a versioned contract, documented in docs/doctor.md.
 */
// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

describe('kanon doctor on a healthy installation', () => {
  it('finds nothing, lists the code-audit caller as Kanon\'s accepted holder, and exits 0', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.findings).toEqual([]);
    expect(r.json.waived).toEqual([]);
    expect(r.json.status).toBe('healthy');
    expect(r.json.releases).toEqual({ pins: [PINNED], pinned: PINNED, to: null, checked: PINNED });
    expect(r.json.lanes).toEqual([...LANES].sort());
    expect(r.json.idTokenHolders).toEqual([
      { workflow: '.github/workflows/agent-code-audit.yml', job: 'audit', grant: 'workflow', how: 'id-token', calls: `yedeya-labs/kanon/.github/workflows/agent-code-audit.yml@${PINNED}`, status: 'kanon-lane', reason: null },
    ]);
  });

  it('only ever reads: every gh call is a GET or a listing, and the checkout is untouched', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    const { next } = nextRelease();
    github.st.releases[NEXT] = next;
    await run(dir, github, ['--to', NEXT]);
    await run(dir, github, ['--json']);
    expect(github.calls.length).toBeGreaterThan(5);
    for (const c of github.calls) {
      expect(c[0] === 'api' ? !c.includes('-X') && !c.includes('--method') && !c.includes('-f') && !c.includes('-F') : (c[0] === 'secret' || c[0] === 'variable') && c[1] === 'list', c.join(' ')).toBe(true);
    }
    // The one body it sends is the default branch's workflows (#418): a GraphQL query, never a mutation.
    expect(github.inputs.length).toBeGreaterThan(0);
    for (const i of github.inputs) expect((JSON.parse(i) as { query: string }).query).toMatch(/^query\(/);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('prints prose by default, with the same exit code', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub());
    expect(r.status).toBe(0);
    expect(r.out).toContain(`== ${REPO}: Kanon ${PINNED} pinned ==`);
    expect(r.out).toContain("Kanon's store-coupled lane at the pinned release: accepted");
    expect(r.out).toContain('Healthy. doctor wrote nothing.');
    expect(() => JSON.parse(r.out)).toThrow();
  });
});

describe('kanon doctor --to, before the pin moves (plan 0005 L10)', () => {
  it('lists exactly the App permission and the declaration the next release adds, and exits 1; after both are fixed, 0', async () => {
    const dir = checkout(healthyFiles());
    const { next, slug } = nextRelease();
    const github = fakeGitHub({ releases: { [NEXT]: next } });
    const before = await run(dir, github, ['--to', NEXT, '--json']);
    expect(before.status, before.out).toBe(EXIT.findings);
    expect(ids(before)).toEqual([`app.permission-missing ${slug}`, `declaration.missing ${NEW_DOC}`]);
    expect(before.json.findings[0].message).toContain('deployments: read');
    expect(before.json.findings[0].fix.url).toBe(`https://github.com/settings/apps/${slug}/permissions`);
    expect(before.json.releases).toMatchObject({ pinned: PINNED, to: NEXT, checked: NEXT });

    github.st.apps[slug]!.permissions.deployments = 'read';
    put(dir, { [NEW_DOC]: '# Release checklist\n' });
    const after = await run(dir, github, ['--to', NEXT, '--json']);
    expect(after.json.findings).toEqual([]);
    expect(after.status, after.out).toBe(EXIT.healthy);
  });

  it('misses the permission when the requirements file drops it (the minting-step test below is what catches that)', async () => {
    const dir = checkout(healthyFiles());
    const { next } = nextRelease();
    const dropped = clone(next);
    const id = REQ.lanes['agent-review']!.identities[0]!;
    delete (dropped.identities.apps[id] ?? dropped.identities.roles[id]!).permissions.deployments;
    const r = await run(dir, fakeGitHub({ releases: { [NEXT]: dropped } }), ['--to', NEXT, '--json']);
    expect(ids(r)).toEqual([`declaration.missing ${NEW_DOC}`]);
  });

  it('names what a caller must change for the next release: a secret, a grant and an input', async () => {
    const dir = checkout(healthyFiles());
    const next = clone(REQ);
    const lane = next.lanes['agent-review']!;
    lane.secrets = [...lane.secrets, 'DIGEST_WEBHOOK'].sort();
    lane.grant = { ...lane.grant, checks: 'read' };
    delete lane.inputs.pr_number;
    const r = await run(dir, fakeGitHub({ releases: { [NEXT]: next } }), ['--to', NEXT, '--json']);
    expect(r.status).toBe(1);
    expect(ids(r)).toEqual([
      'secret.missing acme/widgets',
      'caller.secret-missing .github/workflows/agent-review.yml',
      'caller.input-stale .github/workflows/agent-review.yml',
      'caller.grant-missing .github/workflows/agent-review.yml',
    ]);
    const grant = r.json.findings.find((f: { id: string }) => f.id === 'caller.grant-missing');
    expect(grant.fix.commands).toEqual(['  checks: read']);
    expect(r.json.findings[0].fix.commands).toEqual([`gh secret set DIGEST_WEBHOOK -R ${REPO}`]);
    // The lane that takes it, and its caller, which doesn't map it yet (#415).
    expect(r.json.findings[0].message).toBe(`lacks DIGEST_WEBHOOK, which agent-review takes: .github/workflows/agent-review.yml calls a lane that takes it at ${NEXT}.`);
  });

  it('refuses, exit 3, a release that ships no requirements file', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--to', 'v0.1.0', '--json']);
    expect(r.status).toBe(EXIT.error);
    expect(r.json).toEqual({ schema: SCHEMA, kanon: PINNED, status: 'error', exitCode: 3, error: expect.stringContaining('ships no requirements file') });
  });
});

describe('kanon doctor on an error it did not expect (#375)', () => {
  it('prints the error document, exit 3, and the sentence without a stack trace in prose', async () => {
    const dir = checkout(healthyFiles());
    const go = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const status = await doctor(['--dir', dir, ...argv], {
        gh: fakeGitHub().gh,
        git: () => {
          throw new Error('spawnSync git EMFILE');
        },
        env: {},
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        requirements: () => REQ,
        release: () => PINNED,
      });
      return { status, out: out.join('\n'), err: err.join('\n') };
    };
    const json = await go(['--json']);
    expect(json.status).toBe(EXIT.error);
    expect(JSON.parse(json.out)).toEqual({ schema: SCHEMA, kanon: PINNED, status: 'error', exitCode: 3, error: 'stopped on an unexpected error: spawnSync git EMFILE' });
    const prose = await go([]);
    expect(prose.status).toBe(EXIT.error);
    expect(prose.out).toBe('');
    expect(prose.err).toBe('kanon doctor: stopped on an unexpected error: spawnSync git EMFILE');
  });
});

describe('kanon doctor on the id-token holders (plan 0005 §5.5)', () => {
  const deploy = (perms: string, jobPerms = '') => `name: Deploy
on:
  push:
    branches: [main]
${perms}
jobs:
  deploy:
    runs-on: ubuntu-latest
${jobPerms}    steps:
      - run: ./deploy.sh
  lint:
    runs-on: ubuntu-latest
    permissions:
      id-token: none
      contents: read
    steps:
      - run: make lint
`;
  const accept = (job = 'deploy') => `\n- **${HOLDER_LABEL}:** \`deploy.yml\` job \`${job}\` (assumes the deploy role in our cloud account)\n`;
  const holders = (r: Result) => r.json.idTokenHolders.filter((h: { status: string }) => h.status !== 'kanon-lane').map((h: { job: string; grant: string; how: string; status: string; calls: string | null }) => `${h.job} ${h.grant} ${h.how} ${h.status}${h.calls ? ` ${h.calls}` : ''}`);

  const cases: Array<[string, string]> = [
    ['its own grant', deploy('permissions:\n  contents: read', '    permissions:\n      id-token: write\n      contents: read\n')],
    ["the workflow's grant, inherited", deploy('permissions:\n  id-token: write\n  contents: read')],
    ['permissions: write-all on the job', deploy('permissions: {}', '    permissions: write-all\n')],
    ['permissions: write-all on the workflow', deploy('permissions: write-all')],
  ];
  for (const [how, text] of cases) {
    it(`names a job holding it through ${how}, until the record accepts it or the grant goes`, async () => {
      const files = healthyFiles();
      files['.github/workflows/deploy.yml'] = text;
      const dir = checkout(files);
      const github = fakeGitHub();
      const named = await run(dir, github, ['--json']);
      expect(named.status).toBe(EXIT.findings);
      expect(holders(named)).toHaveLength(1);
      expect(holders(named)[0]).toMatch(/^deploy (job|workflow) (id-token|write-all) unaccepted$/);
      expect(ids(named)).toEqual(['id-token.unaccepted .github/workflows/deploy.yml#deploy']);
      expect(named.json.findings[0].fix.commands).toEqual([`- **${HOLDER_LABEL}:** \`deploy.yml\` job \`deploy\` (<why it holds the grant>)`]);

      put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md'] + accept() });
      const accepted = await run(dir, github, ['--json']);
      expect(accepted.status, accepted.out).toBe(EXIT.healthy);
      expect(accepted.json.idTokenHolders.find((h: { job: string }) => h.job === 'deploy')).toMatchObject({ status: 'accepted', reason: 'assumes the deploy role in our cloud account' });

      put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md']!, '.github/workflows/deploy.yml': deploy('permissions:\n  contents: read') });
      const narrowed = await run(dir, github, ['--json']);
      expect(narrowed.status, narrowed.out).toBe(EXIT.healthy);
      expect(holders(narrowed)).toEqual([]);
    });
  }

  it('names a job that passes the grant to a reusable workflow of its own', async () => {
    const files = healthyFiles();
    files['.github/workflows/release-train.yml'] = 'name: Train\non: push\npermissions:\n  contents: read\njobs:\n  ship:\n    permissions:\n      id-token: write\n    uses: ./.github/workflows/reusable-deploy.yml\n';
    files['.github/workflows/reusable-deploy.yml'] = 'on:\n  workflow_call:\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./go.sh\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(holders(r)).toEqual(['ship job id-token unaccepted ./.github/workflows/reusable-deploy.yml']);
    expect(r.status).toBe(EXIT.findings);
  });

  it('lists a job with id-token: none nowhere, and names a stale or malformed acceptance', async () => {
    const files = healthyFiles();
    files['.github/workflows/deploy.yml'] = deploy('permissions:\n  contents: read');
    files['docs/qa/adoption.md'] += accept('lint') + '- **Accepted id-token holder:** deploy.yml deploy\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(holders(r)).toEqual([]);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md', 'id-token.stale-acceptance docs/qa/adoption.md']);
    expect(r.json.findings[1].blocking).toBe(false);
  });

  it("blocks on a malformed `Upstream findings:` choice, and passes a well-formed one (K-LAYOUT-10, kanon#423)", async () => {
    const good = healthyFiles();
    good['docs/qa/adoption.md'] += '- **Upstream findings:** `filed here`\n';
    expect(ids(await run(checkout(good), fakeGitHub(), ['--json']))).toEqual([]);
    const bad = healthyFiles();
    bad['docs/qa/adoption.md'] += '- **Upstream findings:** `filed on another repository`\n';
    const r = await run(checkout(bad), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md']);
    expect(r.json.findings[0].message).toMatch(/`Upstream findings` is `filed on another repository`; write `drafted`, `filed here`, `sent` or `sent with evidence`/);
    expect(r.status).toBe(EXIT.findings);
  });

  it("blocks on a malformed `Capability watch:` choice, and passes a well-formed one (K-LAYOUT-10, kanon#477)", async () => {
    for (const value of ['on', 'off']) {
      const good = healthyFiles();
      good['docs/qa/adoption.md'] += `- **Capability watch:** \`${value}\`\n`;
      expect(ids(await run(checkout(good), fakeGitHub(), ['--json'])), value).toEqual([]);
    }
    const bad = healthyFiles();
    bad['docs/qa/adoption.md'] += '- **Capability watch:** `yes`\n';
    const r = await run(checkout(bad), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md']);
    expect(r.json.findings[0].message).toMatch(/`Capability watch` is `yes`; write `on` or `off`/);
    expect(r.status).toBe(EXIT.findings);
  });

  // kanon#477: the capability ledger is needed only where the record turns the watch on.
  it('needs the capability ledger only where the record turns the capability watch on', async () => {
    const { next } = nextRelease();
    next.lanes['agent-review']!.reads = [...REQ.lanes['agent-review']!.reads, 'docs/qa/capability-ledger.md'].sort();
    const off = await run(checkout(healthyFiles()), fakeGitHub({ releases: { [NEXT]: next } }), ['--to', NEXT, '--json']);
    expect(ids(off).filter((i: string) => i.startsWith('declaration'))).toEqual([]);
    expect(off.json.notes.join('\n')).toMatch(/docs\/qa\/capability-ledger\.md doesn't exist, which is fine: docs\/qa\/adoption\.md doesn't turn the capability watch on/);
    const on = healthyFiles();
    on['docs/qa/adoption.md'] += '- **Capability watch:** `on`\n';
    const r = await run(checkout(on), fakeGitHub({ releases: { [NEXT]: next } }), ['--to', NEXT, '--json']);
    expect(ids(r)).toContain('declaration.missing docs/qa/capability-ledger.md');
  });

  it('accepts a caller of a store-coupled Kanon lane only at the pinned release', async () => {
    const files = healthyFiles();
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.json.idTokenHolders.map((h: { status: string }) => h.status)).toEqual(['kanon-lane']);
    const next = clone(REQ);
    delete next.lanes['agent-code-audit']!.grant['id-token'];
    const moved = await run(dir, fakeGitHub({ releases: { [NEXT]: next } }), ['--to', NEXT, '--json']);
    expect(moved.json.idTokenHolders.map((h: { status: string }) => h.status)).toEqual(['unaccepted']);
  });
});

// #390: any repository waives a finding it has decided to keep, one bullet per finding id and
// subject under `## Choices`, with its reason. Doctor knows no repository's special case: the
// fixtures below are Kanon's (callers that can't take their lane's name, because the lane's own
// definition holds it) and an ordinary adopter's, and the same rules apply to both.
describe('kanon doctor and the waivers under ## Choices (#390)', () => {
  const waive = (id: string, subject: string, reason = 'the lane itself holds that name') => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` (${reason})\n`;
  const record = (bullets: string) => healthyFiles()['docs/qa/adoption.md']! + bullets;
  const waiveFor = (id: string, subject: string, items: string[], reason: string) => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` for ${items.map((x) => `\`${x}\``).join(', ')} (${reason})\n`;
  const definition = 'name: Lane\non:\n  workflow_call:\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./lane.sh\n';
  /** Kanon's shape: each lane's definition at the lane's file name, and its caller beside it under another. */
  const laneHost = () => {
    const files = healthyFiles();
    for (const lane of LANES) {
      const short = lane.slice('agent-'.length);
      files[`.github/workflows/${short}.yml`] = files[`.github/workflows/${lane}.yml`]!;
      files[`.github/workflows/${lane}.yml`] = definition;
    }
    return files;
  };
  const misplaced = ['caller.misplaced .github/workflows/code-audit.yml', 'caller.misplaced .github/workflows/review.yml'];

  it('turns each waived caller.misplaced into a waived finding, and the run healthy', async () => {
    const files = laneHost();
    const dir = checkout(files);
    const github = fakeGitHub();
    const before = await run(dir, github, ['--json']);
    expect(before.status, before.out).toBe(EXIT.findings);
    expect(ids(before).sort()).toEqual(misplaced);
    expect(before.json.waived).toEqual([]);

    put(dir, { 'docs/qa/adoption.md': record(waive('caller.misplaced', '.github/workflows/review.yml') + waive('caller.misplaced', '.github/workflows/code-audit.yml', "agent-code-audit.yml is the lane's definition")) });
    const after = await run(dir, github, ['--json']);
    expect(after.status, after.out).toBe(EXIT.healthy);
    expect(after.json.findings).toEqual([]);
    const byFile = Object.fromEntries(after.json.waived.map((w: { subject: string; reason: string }) => [w.subject, w.reason]));
    expect(byFile).toEqual({ '.github/workflows/review.yml': 'the lane itself holds that name', '.github/workflows/code-audit.yml': "agent-code-audit.yml is the lane's definition" });
    // The waived finding is the finding, whole: what it was, and the fix it would have had.
    const review = before.json.findings.find((f: { subject: string }) => f.subject === '.github/workflows/review.yml');
    expect(after.json.waived.find((w: { subject: string }) => w.subject === review.subject)).toEqual({ ...review, items: [], line: 12, reason: 'the lane itself holds that name' });

    const prose = await run(dir, github);
    expect(prose.status).toBe(EXIT.healthy);
    expect(prose.out).toContain("Waived under ## Choices in docs/qa/adoption.md, so they don't count:");
    expect(prose.out).toContain('- [Caller] caller.misplaced, .github/workflows/review.yml, by docs/qa/adoption.md:12: the lane itself holds that name.');
    expect(prose.out).toContain('Healthy. doctor wrote nothing. 2 finding(s) waived in docs/qa/adoption.md.');
  });

  it('waives only the finding id and the subject it names (mutations: another path, another id)', async () => {
    const dir = checkout({ ...laneHost(), 'docs/qa/adoption.md': record(waive('caller.misplaced', '.github/workflows/implement.yml') + waive('caller.name', '.github/workflows/review.yml') + waive('caller.misplaced', '.github/workflows/code-audit.yml')) });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md', 'waiver.stale docs/qa/adoption.md', 'caller.misplaced .github/workflows/review.yml']);
    expect(r.json.waived.map((w: { id: string; subject: string }) => `${w.id} ${w.subject}`)).toEqual(['caller.misplaced .github/workflows/code-audit.yml']);
    expect(r.json.findings[0].message).toContain('waives caller.misplaced on .github/workflows/implement.yml, but doctor reports no such finding');
    expect(r.json.findings[1].message).toContain('waives caller.name on .github/workflows/review.yml');
  });

  it('names a stale waiver, without blocking, once the finding is gone', async () => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waive('caller.misplaced', '.github/workflows/review.yml')) });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(r.json.findings[0]).toMatchObject({ blocking: false, fix: { text: 'Remove the bullet, so the record says only what is true.' } });
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.waived).toEqual([]);
  });

  it("doesn't call a waiver stale when the check that would report its finding could not run", async () => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, ['DIGEST_WEBHOOK'], 'set in the organisation')) });
    const blind = await run(dir, fakeGitHub({ secrets: null }), ['--json']);
    expect(blind.status).toBe(EXIT.incomplete);
    expect(ids(blind)).toEqual([]);
    expect(blind.json.notes.join('\n')).toContain(`waives secret.missing on ${REPO} for DIGEST_WEBHOOK, which doctor did not report; the secrets check could not run`);
    const seeing = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(seeing)).toEqual(['waiver.stale docs/qa/adoption.md']);
  });

  it('waives a finding that does not block too, and every finding of that id on that subject whose items it names', async () => {
    const github = fakeGitHub({ secrets: new Set() });
    github.st.labels = new Set();
    const labels = TAXONOMY;
    // Not the QA store's two (#433): without a store hook doctor asks for neither.
    const secrets = [...new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets))].filter((n) => !REQ.qaStore!.secrets.includes(n));
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('label.missing', REPO, labels, 'we keep our own labels') + waiveFor('secret.missing', REPO, secrets, 'set in the organisation')) });
    const r = await run(dir, github, ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
    const waived = r.json.waived.map((w: { id: string; blocking: boolean }) => `${w.id} ${w.blocking}`);
    expect(waived.filter((w: string) => w === 'secret.missing true').length).toBeGreaterThan(1);
    expect(waived).toContain('label.missing false');
  });

  it('fails a malformed waiver by its line, and one of a finding that cannot be waived, so neither is ignored', async () => {
    const bad = [
      `- **${WAIVER_LABEL}:** caller.misplaced on .github/workflows/review.yml\n`,
      waive('caller.misplaced', '.github/workflows/review.yml', ' '),
      waive('caller.misplced', '.github/workflows/review.yml'),
      waive('caller.secrets-inherited', '.github/workflows/review.yml'),
      waive('caller.misplaced', '.github/workflows/review.yml') + waive('caller.misplaced', '.github/workflows/review.yml', 'again'),
    ];
    for (const b of bad) {
      const dir = checkout({ ...laneHost(), 'docs/qa/adoption.md': record(b) });
      const r = await run(dir, fakeGitHub(), ['--json']);
      expect(r.status, b).toBe(EXIT.findings);
      expect(r.json.findings.filter((f: { id: string }) => f.id === 'declaration.malformed'), b).toHaveLength(1);
      expect(r.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed').message, b).toMatch(/^docs\/qa\/adoption\.md:\d+ /);
    }
    const outside = checkout({ ...laneHost(), 'docs/qa/adoption.md': record('') .replace('## People\n', `## People\n\n${waive('caller.misplaced', '.github/workflows/review.yml')}`) });
    const r = await run(outside, fakeGitHub(), ['--json']);
    expect(ids(r).sort()).toEqual([...misplaced, 'declaration.malformed docs/qa/adoption.md']);
  });

  it('keeps the id-token holder its own form: a general waiver of one is malformed, and the holder stays unaccepted', async () => {
    const files = healthyFiles();
    files['.github/workflows/deploy.yml'] = 'on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: x\n';
    const dir = checkout({ ...files, 'docs/qa/adoption.md': record(waive('id-token.unaccepted', '.github/workflows/deploy.yml#d')) });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md', 'id-token.unaccepted .github/workflows/deploy.yml#d']);
    expect(r.json.findings[0].message).toContain(HOLDER_LABEL);
    expect(r.json.waived).toEqual([]);
  });

  it("leaves an ordinary adopter's findings exactly as they were", async () => {
    const files = healthyFiles();
    files['docs/qa/stack.md'] = '# Stack\n';
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.labels = new Set();
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['declaration.section-missing docs/qa/stack.md', `label.missing ${REPO}`]);
    expect(r.json.waived).toEqual([]);
    expect(r.status).toBe(EXIT.findings);
  });
});

// #406: a finding that lists items, which a later release can add to, is waived item by item.
// A bullet names the items it keeps after `for`; any other item, today's or the next release's,
// stays a finding. A bullet that names none still waives the whole finding, as before, and a
// note names what it waives and the bullet to write instead.
describe('kanon doctor and the waiver of a finding that lists items (#406)', () => {
  const judge = REQ.lanes['agent-review']!.identities[0]!;
  const slug = `widgets-${judge}`;
  const record = (bullet: string) => `${healthyFiles()['docs/qa/adoption.md']}${bullet}\n`;
  const waiveFor = (id: string, subject: string, items: string[] | null, reason = 'kept on purpose') =>
    `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\`${items ? ` for ${items.map((x) => `\`${x}\``).join(', ')}` : ''} (${reason})`;
  /** The Judge's App lacks one permission it is granted, which the repository keeps on purpose. */
  const kept = Object.keys(permissionsOf(REQ, judge)).find((k) => k !== 'metadata')!;
  /** The next release asks the Judge's App for one permission more, and nothing else. */
  const next = () => {
    const r = clone(REQ);
    (r.identities.apps[judge] ?? r.identities.roles[judge]!).permissions.deployments = 'read';
    return r;
  };
  const setup = (bullet: string) => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(bullet) });
    const github = fakeGitHub({ releases: { [NEXT]: next() } });
    delete github.st.apps[slug]!.permissions[kept];
    return { dir, github };
  };

  it('waives the items it names, and reports the one the next release adds, written for it alone', async () => {
    const { dir, github } = setup(waiveFor('app.permission-missing', slug, [kept]));
    const now = await run(dir, github, ['--json']);
    expect(now.status, now.out).toBe(EXIT.healthy);
    expect(now.json.waived.map((w: { id: string; items: string[] }) => [w.id, w.items])).toEqual([['app.permission-missing', [kept]]]);

    const later = await run(dir, github, ['--to', NEXT, '--json']);
    expect(later.status).toBe(EXIT.findings);
    expect(ids(later)).toEqual([`app.permission-missing ${slug}`]);
    const f = later.json.findings[0];
    expect(f.message).toBe(`The ${judge} App \`${slug}\` holds deployments: none; Kanon ${NEXT} needs deployments: read. docs/qa/adoption.md:12 waives ${kept}, not this.`);
    expect(later.json.waived).toHaveLength(1);
    expect(later.json.waived[0]).toMatchObject({ items: [kept], line: 12, reason: 'kept on purpose' });
    expect(later.json.waived[0].message).not.toContain('deployments');
    const prose = await run(dir, github, ['--to', NEXT]);
    expect(prose.out).toContain(`- [App] app.permission-missing, ${slug} (${kept}), by docs/qa/adoption.md:12: kept on purpose.`);
  });

  it('refuses a bullet that names no items, waiving nothing, and gives the bullet to write from today\'s items (the Owner, 2026-10-07)', async () => {
    const { dir, github } = setup(waiveFor('app.permission-missing', slug, null));
    const later = await run(dir, github, ['--to', NEXT, '--json']);
    expect(later.status).toBe(EXIT.findings);
    expect(ids(later)).toEqual([`app.permission-missing ${slug}`, 'declaration.malformed docs/qa/adoption.md']);
    expect(later.json.waived).toEqual([]);
    const bad = later.json.findings[1];
    expect(bad.message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} without naming its items, so it would waive whatever a later release adds to that finding too; it waives nothing until it names them (#406). Doctor reports ${kept}, deployments there today.`);
    expect(bad.fix.commands).toEqual([`- **${WAIVER_LABEL}:** \`app.permission-missing\` on \`${slug}\` for \`${kept}\`, \`deployments\` (kept on purpose)`]);
    // Written as the fix says, it waives both, and the run is healthy again.
    put(dir, { 'docs/qa/adoption.md': record(bad.fix.commands[0]) });
    expect((await run(dir, github, ['--to', NEXT, '--json'])).status).toBe(EXIT.healthy);
    // Beside a bullet that names some, the rewrite names only the rest; with none reported, a placeholder.
    put(dir, { 'docs/qa/adoption.md': record(`${waiveFor('app.permission-missing', slug, [kept])}\n${waiveFor('app.permission-missing', slug, null, 'and the rest')}`) });
    const beside = await run(dir, github, ['--to', NEXT, '--json']);
    expect(beside.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed').fix.commands).toEqual([`- **${WAIVER_LABEL}:** \`app.permission-missing\` on \`${slug}\` for \`deployments\` (and the rest)`]);
    const none = await run(dir, github, ['--json']);
    expect(none.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed')).toMatchObject({ message: expect.stringContaining('Doctor reports no item there today that the other bullets don\'t name.'), fix: { commands: [`- **${WAIVER_LABEL}:** \`app.permission-missing\` on \`${slug}\` for \`<item>\` (and the rest)`] } });
    // A finding that lists no items is still waived by a bullet that names none.
    const moved = healthyFiles();
    moved['.github/workflows/review.yml'] = moved['.github/workflows/agent-review.yml']!;
    delete moved['.github/workflows/agent-review.yml'];
    const plain = checkout({ ...moved, 'docs/qa/adoption.md': record(waiveFor('caller.misplaced', '.github/workflows/review.yml', null)) });
    const r = await run(plain, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['caller.misplaced']);
  });

  it('takes several bullets for one finding, each with its own items and reason, and shows which covers which', async () => {
    const { dir, github } = setup(`${waiveFor('app.permission-missing', slug, [kept], 'kept on purpose')}\n${waiveFor('app.permission-missing', slug, ['deployments'], 'until the deploy lane lands')}`);
    const r = await run(dir, github, ['--to', NEXT, '--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.waived.map((w: { items: string[]; line: number; reason: string }) => [w.items, w.line, w.reason])).toEqual([[[kept], 12, 'kept on purpose'], [['deployments'], 13, 'until the deploy lane lands']]);
    expect(r.json.waived[1].message).toBe(`The ${judge} App \`${slug}\` holds deployments: none; Kanon ${NEXT} needs deployments: read.`);
    const prose = await run(dir, github, ['--to', NEXT]);
    expect(prose.out).toContain(`- [App] app.permission-missing, ${slug} (deployments), by docs/qa/adoption.md:13: until the deploy lane lands.`);
    // An item a third permission brings stays a finding, naming both bullets.
    const more = next();
    (more.identities.apps[judge] ?? more.identities.roles[judge]!).permissions.pages = 'read';
    github.st.releases[NEXT] = more;
    const later = await run(dir, github, ['--to', NEXT, '--json']);
    expect(later.json.findings[0].message).toMatch(/needs pages: read\. docs\/qa\/adoption\.md:12 waives \w+; docs\/qa\/adoption\.md:13 waives deployments, not this\.$/);
  });

  it('waives item by item across the findings of one id on one subject, each App\'s secrets and a lane\'s', async () => {
    const secrets = new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets).filter((n) => !appSecrets(judge).includes(n) && n !== 'CLAUDE_CODE_OAUTH_TOKEN'));
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, appSecrets(judge), 'set in the organisation')) });
    const r = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(ids(r)).toEqual([`secret.missing ${REPO}`]);
    expect(r.json.findings[0].message).toMatch(/^lacks CLAUDE_CODE_OAUTH_TOKEN,/);
    expect(r.json.waived.map((w: { items: string[] }) => w.items)).toEqual([appSecrets(judge)]);
    // Naming one of the App's two leaves the other a finding, its fix the App's own.
    put(dir, { 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, [appSecrets(judge)[0]!, 'CLAUDE_CODE_OAUTH_TOKEN'], 'set in the organisation')) });
    const half = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(ids(half)).toEqual([`secret.missing ${REPO}`]);
    expect(half.json.findings[0].message).toMatch(new RegExp(`^lacks ${appSecrets(judge)[1]}, the ${judge} App's secret: .* docs/qa/adoption.md:12 waives ${appSecrets(judge)[0]}, not this\\.$`));
    expect(half.json.findings[0].fix.commands[0]).toBe('kanon apps --owner acme --repo widgets --preflight');
  });

  it('calls an item it names that doctor no longer reports stale, and the bullet stale when it reports none', async () => {
    const { dir, github } = setup(waiveFor('app.permission-missing', slug, [kept, 'pages']));
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(r.json.findings[0].message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} for pages, but doctor reports no such item there.`);
    expect(r.json.findings[0].fix.text).toBe('Remove `pages` from the bullet, so the record says only what is true.');
    expect(r.json.waived.map((w: { items: string[] }) => w.items)).toEqual([[kept]]);
    // The finding is there, but for none of the items it names (the Reviewer's F2 on 5a0088f).
    put(dir, { 'docs/qa/adoption.md': record(waiveFor('app.permission-missing', slug, ['pages'])) });
    const other = await run(dir, github, ['--json']);
    expect(ids(other)).toEqual([`app.permission-missing ${slug}`, 'waiver.stale docs/qa/adoption.md']);
    expect(other.json.findings[1].message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} for pages, but doctor reports none of it there.`);
    expect(other.json.findings[1].fix.text).toBe('Remove the bullet, so the record says only what is true.');
    github.st.apps[slug]!.permissions[kept] = permissionsOf(REQ, judge)[kept]!;
    const none = await run(dir, github, ['--json']);
    expect(ids(none)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(none.json.findings[0].message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} for pages, but doctor reports no such finding.`);
  });

  it("doesn't call an item stale when the check that would report it could not run", async () => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, ['DIGEST_WEBHOOK'])) });
    const r = await run(dir, fakeGitHub({ secrets: null }), ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.notes.join('\n')).toContain(`docs/qa/adoption.md:12 waives secret.missing on ${REPO} for DIGEST_WEBHOOK, which doctor did not report; the secrets check could not run`);
  });

  it('reads the items of a waiver, and refuses items for a finding that lists none', () => {
    const at = (bullet: string) => readWaivers(`## Choices\n\n${bullet}\n`);
    expect(at(waiveFor('secret.missing', REPO, ['A_B', 'C D', 'A_B'], 'why')).waivers).toEqual([{ id: 'secret.missing', subject: REPO, items: ['A_B', 'C D'], reason: 'why', line: 3 }]);
    expect(at(waiveFor('caller.misplaced', 'a.yml', ['x'])).errors[0]).toContain("names items after `for`, but `caller.misplaced` lists none");
    // Several bullets of one finding, but never one item twice; an item-less one is read, for diagnose to refuse.
    const two = at(`${waiveFor('secret.missing', REPO, ['A', 'B'], 'one')}\n${waiveFor('secret.missing', REPO, ['C'], 'two')}\n${waiveFor('secret.missing', REPO, null, 'three')}`);
    expect(two.errors).toEqual([]);
    expect(two.waivers.map((w) => [w.items, w.line])).toEqual([[['A', 'B'], 3], [['C'], 4], [null, 5]]);
    expect(at(`${waiveFor('secret.missing', REPO, ['A', 'B'], 'one')}\n${waiveFor('secret.missing', REPO, ['C', 'B'], 'two')}`).errors).toEqual(['docs/qa/adoption.md:4 waives `B` of `secret.missing` on `acme/widgets`, which docs/qa/adoption.md:3 waives already']);
    expect(at(`${waiveFor('caller.misplaced', 'a.yml', null)}\n${waiveFor('caller.misplaced', 'a.yml', null, 'again')}`).errors[0]).toContain('a second time');
    for (const bad of [`- **${WAIVER_LABEL}:** \`secret.missing\` on \`${REPO}\` for A_B (why)`, `- **${WAIVER_LABEL}:** \`secret.missing\` on \`${REPO}\` for \`\` (why)`, `- **${WAIVER_LABEL}:** \`secret.missing\` on \`${REPO}\` for \`a\` and \`b\` (why)`]) {
      expect(at(bad).errors, bad).toHaveLength(1);
    }
  });

  it('lists every finding id that lists items in ITEMIZED and in docs/doctor.md, and nothing else', () => {
    const source = readFileSync(join(ROOT, 'cli/doctor.mjs'), 'utf8');
    const built = [...new Set([...source.matchAll(/findItems\('([a-z-]+\.[a-z-]+)'/g)].map((m) => m[1]))].sort();
    expect(built).toEqual(Object.keys(ITEMIZED).sort());
    for (const id of built) expect(UNWAIVABLE[id!], id).toBeUndefined();
    const doc = readFileSync(join(ROOT, 'docs/doctor.md'), 'utf8');
    const table = doc.split('| Id | An item |')[1]!.split('\n\n')[0]!;
    expect([...new Set([...table.matchAll(/`([a-z-]+\.[a-z-]+)`/g)].map((m) => m[1]))].sort()).toEqual(Object.keys(ITEMIZED).sort());
  });
});

describe('the readers doctor is built from', () => {
  it('counts an id-token grant as the guard does', () => {
    expect(idTokenGrant({}, { permissions: { 'id-token': 'write' } })).toEqual({ from: 'job', how: 'id-token' });
    expect(idTokenGrant({ permissions: { 'id-token': 'write' } }, { permissions: { contents: 'read' } })).toBeNull();
    expect(idTokenGrant({ permissions: 'write-all' }, {})).toEqual({ from: 'workflow', how: 'write-all' });
    expect(idTokenGrant({ permissions: 'read-all' }, {})).toBeNull();
    expect(idTokenGrant({}, { permissions: { 'id-token': 'none' } })).toBeNull();
    expect(idTokenGrant({}, {})).toBeNull();
  });

  it('reads Kanon pins outside comments only', () => {
    const pins = kanonPins(new Map([['.github/workflows/a.yml', '# uses: yedeya-labs/kanon/x@v0.0.1\n    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v1.2.3\n']]));
    expect([...pins.keys()]).toEqual(['v1.2.3']);
  });

  it('reads an acceptance only under ## Choices, outside fences, once per holder', () => {
    const ok = `## Choices\n\n- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` (why)\n`;
    expect([...readHolderAcceptances(ok).accepted]).toEqual([['d.yml#j', 'why']]);
    expect(readHolderAcceptances(`## People\n\n- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` (why)\n`).errors[0]).toContain('outside `## Choices`');
    expect(readHolderAcceptances(`${ok}- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` (again)\n`).errors[0]).toContain('a second time');
    expect(readHolderAcceptances(`## Choices\n\n- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` ()\n`).errors).toHaveLength(1);
    expect(readHolderAcceptances(`## Choices\n\n\`\`\`\n- **${HOLDER_LABEL}:** nonsense\n\`\`\`\n`)).toEqual({ accepted: new Map(), errors: [] });
  });

  it('reads a waiver only under ## Choices, outside fences, of a finding doctor reports and may waive, once each', () => {
    const line = (id: string, subject = 'a.yml', why = '(why)') => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` ${why}\n`;
    const ok = `## Choices\n\n${line('caller.misplaced')}`;
    expect(readWaivers(ok)).toEqual({ waivers: [{ id: 'caller.misplaced', subject: 'a.yml', items: null, reason: 'why', line: 3 }], errors: [] });
    expect(readWaivers(`${ok}${line('caller.misplaced', 'b.yml')}${line('caller.name')}`).waivers).toHaveLength(3);
    expect(readWaivers(`## People\n\n${line('caller.misplaced')}`).errors[0]).toContain('outside `## Choices`');
    expect(readWaivers(`${ok}${line('caller.misplaced', 'a.yml', '(again)')}`).errors[0]).toContain('a second time');
    expect(readWaivers(`## Choices\n\n${line('caller.misplaced', 'a.yml', '()')}`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n${line('caller.misplaced', 'a.yml', '')}`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n${line('caller.misplaced', ' ')}`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n${line('caller.nope')}`).errors[0]).toContain('no finding doctor reports');
    expect(readWaivers(`## Choices\n\n* **${WAIVER_LABEL.toLowerCase()}:** whatever\n`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n\`\`\`\n${line('caller.misplaced')}\`\`\`\n`)).toEqual({ waivers: [], errors: [] });
    for (const id of Object.keys(UNWAIVABLE)) {
      expect(FINDINGS[id], id).toBeDefined();
      expect(readWaivers(`## Choices\n\n${line(id)}`).errors[0], id).toContain("can't be waived");
    }
  });
});

describe("the requirements file's App grants and the lanes' minting steps", () => {
  // The requirements file says what each App must hold; the lanes' minting steps are what they
  // ask of it. A grant the file drops that a step still mints with would make doctor pass an App
  // the lane then fails to mint on, so the two are held together here, from the lanes themselves.
  const level = (v: unknown) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);
  it('covers every literal permission a lane mints with, for the identity the lane runs as', () => {
    let seen = 0;
    const problems: string[] = [];
    for (const file of laneFiles(ROOT)) {
      const lane = file.replace(/\.yml$/, '');
      const ids = REQ.lanes[lane]!.identities;
      if (!ids.length) continue;
      expect(ids, `${lane} runs as one identity`).toHaveLength(1);
      const grant = permissionsOf(REQ, ids[0]!);
      for (const f of laneTree(ROOT, file)) {
        const doc = parse(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')) as { jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }> };
        for (const job of Object.values(doc.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            if (!String(step.uses ?? '').startsWith('actions/create-github-app-token@')) continue;
            for (const [k, v] of Object.entries(step.with ?? {})) {
              if (!k.startsWith('permission-') || typeof v !== 'string' || !/^(read|write)$/.test(v)) continue;
              seen++;
              const scope = k.slice('permission-'.length).replace(/-/g, '_');
              if (level(grant[scope]) < level(v)) problems.push(`${f} (${lane}, as ${ids[0]}) mints ${scope}: ${v}; requirements.json grants ${grant[scope] ?? 'none'}`);
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });
});

describe('the JSON contract (ADR 0014, docs/doctor.md)', () => {
  const doc = readFileSync(join(ROOT, 'docs/doctor.md'), 'utf8');

  it('has exactly the documented top-level, finding and holder fields', async () => {
    const files = healthyFiles();
    files['.github/workflows/deploy.yml'] = 'on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: x\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    const documented = (heading: string) => [...doc.split(`### ${heading}`)[1]!.split('\n### ')[0]!.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((m) => m[1]).sort();
    expect(r.json.schema).toBe(SCHEMA);
    expect(r.json.exitCode).toBe(r.status);
    expect(Object.keys(r.json).sort()).toEqual(documented('The document'));
    expect(Object.keys(r.json.findings[0]).sort()).toEqual(documented('A finding'));
    expect(Object.keys(r.json.findings[0].fix).sort()).toEqual(documented('A fix'));
    expect(Object.keys(r.json.idTokenHolders[0]).sort()).toEqual(documented('An id-token holder'));
    put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md'] + `- **${WAIVER_LABEL}:** \`caller.misplaced\` on \`.github/workflows/x.yml\` (why)\n` });
    const stale = await run(dir, fakeGitHub(), ['--json']);
    expect(stale.json.findings.map((f: { id: string }) => f.id)).toContain('waiver.stale');
    const github = fakeGitHub();
    github.st.labels = new Set();
    put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md'] + `- **${WAIVER_LABEL}:** \`label.missing\` on \`${REPO}\` for ${TAXONOMY.map((n) => `\`${n}\``).join(', ')} (why)\n` });
    const waived = await run(dir, github, ['--json']);
    expect(Object.keys(waived.json.waived[0]).sort()).toEqual(documented('A waived finding'));
    expect(doc).toContain(`\`${SCHEMA}\``);
  });

  it('documents every finding id, with its category and whether it blocks, and nothing else', () => {
    const rows = [...doc.matchAll(/^\| `([a-z-]+\.[a-z-]+)` \| `([a-z-]+)` \| (yes|no) \|/gm)].map((m) => [m[1], { category: m[2], blocking: m[3] === 'yes' }]);
    expect(Object.fromEntries(rows)).toEqual(FINDINGS);
    for (const f of Object.values(FINDINGS)) expect(CATEGORIES).toContain(f.category);
  });

  it('documents every finding id no waiver waives, and nothing else', () => {
    const section = doc.split('### What can\'t be waived')[1]!.split('\n## ')[0]!;
    const listed = [...new Set([...section.matchAll(/`([a-z-]+\.[a-z-]+)`/g)].map((m) => m[1]))].sort();
    expect(listed).toEqual(Object.keys(UNWAIVABLE).sort());
  });

  it('documents every exit code', () => {
    for (const [name, code] of Object.entries(EXIT)) expect(doc, name).toMatch(new RegExp(`^\\| ${code} \\| \`${name}\` \\|`, 'm'));
  });
});

describe("kanon doctor and the QA store's secrets (#433)", () => {
  const HOOK = REQ.qaStore!.hook;
  const STORE = REQ.qaStore!.secrets;
  const withHook = () => ({ ...healthyFiles(), [HOOK]: 'name: QA store\nruns: { using: composite, steps: [] }\n' });
  const allBut = (...drop: string[]) => new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets).filter((n) => !drop.includes(n)));
  const CALLER = '.github/workflows/agent-code-audit.yml';
  const unmap = (dir: string) => put(dir, { [CALLER]: readFileSync(join(dir, CALLER), 'utf8').replace(/^ {6}QA_STORE_[A-Z_]+: .*\n/gm, '') });
  // A v0.34.x requirements file: the store's secrets, without `secretsOnly`, because its block
  // still passed the variables, which the hook fell back to (#479).
  const V034 = { ...REQ, qaStore: { hook: HOOK, secrets: STORE } };
  const runAt = async (req: typeof REQ, dir: string, github: ReturnType<typeof fakeGitHub>): Promise<Result> => {
    const out: string[] = [];
    const status = await doctor(['--dir', dir, '--json'], { gh: github.gh, env: {}, out: (l: string) => out.push(l), err: () => {}, requirements: () => req, release: () => PINNED });
    const text = out.join('\n');
    return { status, out: text, err: '', json: JSON.parse(text) };
  };

  it('names the store hook and its two secrets, which the store-coupled lanes take as optional', () => {
    expect(REQ.qaStore).toEqual({ hook: '.github/actions/qa-store/action.yml', secrets: ['QA_STORE_BUCKET', 'QA_STORE_ROLE_ARN'], secretsOnly: true });
    expect(REQ.lanes['agent-code-audit']!.optionalSecrets).toEqual(STORE);
    expect(FINDINGS['qa-store.variables']).toEqual({ category: 'secret', blocking: false });
    expect(FINDINGS['qa-store.unmapped']).toEqual({ category: 'caller', blocking: false });
  });

  it('asks nothing of a repository without a store hook: no secret, no mapping, no variable read', async () => {
    const dir = checkout(healthyFiles());
    unmap(dir);
    const github = fakeGitHub({ secrets: allBut(...STORE), variables: new Set(STORE) });
    const r = await run(dir, github, ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([]);
    expect(github.calls.some((c) => c[0] === 'variable')).toBe(false);
  });

  it('with a hook, reports both secrets missing when no variable holds them either', async () => {
    const r = await run(checkout(withHook()), fakeGitHub({ secrets: allBut(...STORE) }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(ids(r)).toEqual([`secret.missing ${REPO}`, `secret.missing ${REPO}`]);
    expect(r.json.findings.map((f: { message: string }) => f.message)).toEqual([`lacks QA_STORE_BUCKET, which agent-code-audit takes: ${CALLER} maps it.`, `lacks QA_STORE_ROLE_ARN, which agent-code-audit takes: ${CALLER} maps it.`]);
    expect(r.json.findings[1].fix.text).toContain("store the stack's RoleArn output");
    // #625: a store's coordinates aren't secret, so the line carries them with --body, which
    // works at the Claude Code prompt with `!`, where a line that reads standard input stores an
    // empty secret.
    expect(r.json.findings.map((f: { fix: { commands: string[] } }) => f.fix.commands)).toEqual([[`gh secret set QA_STORE_BUCKET -R ${REPO} --body '<BucketName>'`], [`gh secret set QA_STORE_ROLE_ARN -R ${REPO} --body '<RoleArn>'`]]);
  });

  it('against a release that passes no variables (#479), blocks on each store secret a variable alone holds, and copies it from the variable', async () => {
    const r = await run(checkout(withHook()), fakeGitHub({ secrets: allBut(...STORE), variables: new Set([...STORE, 'OTHER']) }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(ids(r)).toEqual([`qa-store.variables ${REPO}`, `secret.missing ${REPO}`, `secret.missing ${REPO}`]);
    const [left, bucket, role] = r.json.findings;
    expect(bucket).toMatchObject({ blocking: true, message: `lacks QA_STORE_BUCKET, which agent-code-audit takes: ${CALLER} maps it.` });
    expect(bucket.fix.text).toContain('as secrets alone, never the variable QA_STORE_BUCKET');
    expect(bucket.fix.commands).toEqual([`gh variable get QA_STORE_BUCKET -R ${REPO} | gh secret set QA_STORE_BUCKET -R ${REPO}`]);
    expect(role.fix.commands).toEqual([`gh variable get QA_STORE_ROLE_ARN -R ${REPO} | gh secret set QA_STORE_ROLE_ARN -R ${REPO}`]);
    // The leftover variables stay a finding of their own, never blocking.
    expect(left).toMatchObject({ category: 'secret', blocking: false });
    expect(left.message).toContain(`holds QA_STORE_BUCKET and QA_STORE_ROLE_ARN as repository variables, which Kanon ${PINNED}'s lanes no longer read or print`);
    expect(left.fix.commands).toEqual([
      `gh variable get QA_STORE_BUCKET -R ${REPO} | gh secret set QA_STORE_BUCKET -R ${REPO}`,
      `gh variable get QA_STORE_ROLE_ARN -R ${REPO} | gh secret set QA_STORE_ROLE_ARN -R ${REPO}`,
      `gh variable delete QA_STORE_BUCKET -R ${REPO}`,
      `gh variable delete QA_STORE_ROLE_ARN -R ${REPO}`,
    ]);
    // One secret set: only the other blocks.
    const half = await run(checkout(withHook()), fakeGitHub({ secrets: allBut('QA_STORE_BUCKET'), variables: new Set(STORE) }), ['--json']);
    expect(half.status, half.out).toBe(EXIT.findings);
    expect(ids(half)).toEqual([`qa-store.variables ${REPO}`, `secret.missing ${REPO}`]);
    expect(half.json.findings[1].message).toMatch(/^lacks QA_STORE_BUCKET,/);
  });

  it('against a v0.34.x release, which still passed the variables, reports them without blocking, with the move as its fix', async () => {
    const r = await runAt(V034, checkout(withHook()), fakeGitHub({ secrets: allBut(...STORE), variables: new Set([...STORE, 'OTHER']) }));
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`qa-store.variables ${REPO}`]);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'secret', blocking: false });
    expect(f.message).toContain('holds QA_STORE_BUCKET and QA_STORE_ROLE_ARN as repository variables, which the runner never masks');
    expect(f.fix.text).toContain('"Move the coordinates to secrets"');
    expect(f.fix.commands).toEqual([
      `gh variable get QA_STORE_BUCKET -R ${REPO} | gh secret set QA_STORE_BUCKET -R ${REPO}`,
      `gh variable get QA_STORE_ROLE_ARN -R ${REPO} | gh secret set QA_STORE_ROLE_ARN -R ${REPO}`,
      `gh variable delete QA_STORE_BUCKET -R ${REPO}`,
      `gh variable delete QA_STORE_ROLE_ARN -R ${REPO}`,
    ]);
    // With neither, it still blocks, as before.
    const none = await runAt(V034, checkout(withHook()), fakeGitHub({ secrets: allBut(...STORE) }));
    expect(ids(none)).toEqual([`secret.missing ${REPO}`, `secret.missing ${REPO}`]);
  });

  it('once the secrets are set, asks only that the variables be deleted, without blocking (#479)', async () => {
    const r = await run(checkout(withHook()), fakeGitHub({ variables: new Set(['QA_STORE_ROLE_ARN']) }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`qa-store.variables ${REPO}`]);
    expect(r.json.findings[0].fix.commands).toEqual([`gh variable delete QA_STORE_ROLE_ARN -R ${REPO}`]);
  });

  it('with a hook, lists a store-coupled caller that does not map them, without blocking; a required secret still blocks', async () => {
    const dir = checkout(withHook());
    unmap(dir);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`qa-store.unmapped ${CALLER}`]);
    expect(r.json.findings[0].message).toContain(`its store jobs reach no store, since Kanon ${PINNED} passes the hook no variables to fall back to`);
    expect(r.json.findings[0].fix.commands).toEqual(['      QA_STORE_BUCKET: ${{ secrets.QA_STORE_BUCKET }}', '      QA_STORE_ROLE_ARN: ${{ secrets.QA_STORE_ROLE_ARN }}']);
    put(dir, { [CALLER]: readFileSync(join(dir, CALLER), 'utf8').replace(/^ {6}CLAUDE_CODE_OAUTH_TOKEN: .*\n/m, '') });
    const missing = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(missing)).toEqual([`caller.secret-missing ${CALLER}`, `qa-store.unmapped ${CALLER}`]);
  });

  it('lists its items, so a waiver names the ones it keeps and the rest stay a finding (#406, #464)', async () => {
    expect(ITEMIZED['qa-store.variables']).toBe('a variable');
    expect(ITEMIZED['qa-store.unmapped']).toBe('a secret');
    const bullet = `- **${WAIVER_LABEL}:** \`qa-store.variables\` on \`${REPO}\` for \`QA_STORE_BUCKET\` (kept while another reader moves)\n`;
    const dir = checkout({ ...withHook(), 'docs/qa/adoption.md': healthyFiles()['docs/qa/adoption.md'] + bullet });
    const r = await run(dir, fakeGitHub({ variables: new Set(STORE) }), ['--json']);
    expect(ids(r)).toEqual([`qa-store.variables ${REPO}`]);
    expect(r.json.findings[0].message).toMatch(/^holds QA_STORE_ROLE_ARN as a repository variable/);
    expect(r.json.findings[0].fix.commands).toEqual([`gh variable delete QA_STORE_ROLE_ARN -R ${REPO}`]);
    expect(r.json.waived.map((w: { id: string; items: string[] }) => [w.id, w.items])).toEqual([['qa-store.variables', ['QA_STORE_BUCKET']]]);
  });

  it('asks for neither secret where a workflow maps them but no store hook exists (#464)', async () => {
    const r = await run(checkout(healthyFiles()), fakeGitHub({ secrets: allBut(...STORE) }), ['--json']);
    expect(readFileSync(join(checkout(healthyFiles()), CALLER), 'utf8')).toContain('secrets.QA_STORE_ROLE_ARN');
    expect(ids(r)).toEqual([]);
  });

  it("says in a note when the token can't list the variables", async () => {
    const r = await run(checkout(withHook()), fakeGitHub({ variables: null }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.notes.some((n: string) => n.includes("can't tell whether QA_STORE_BUCKET or QA_STORE_ROLE_ARN is still a variable"))).toBe(true);
  });
});
