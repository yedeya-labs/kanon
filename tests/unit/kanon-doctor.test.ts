import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeRegisterRow } from '../../cli/app-register.mjs';
import { appSecrets, appsCheckFile, callerFile, ciFile, dependabotFile, hookFile, loadRequirements } from '../../cli/callers.mjs';
import { CATEGORIES, doctor, EXIT, FINDINGS, HOLDER_LABEL, idTokenGrant, kanonPins, readHolderAcceptances, SCHEMA } from '../../cli/doctor.mjs';
import { registerRolesOf, rulesetBody } from '../../cli/init.mjs';
import { laneFiles, laneTree } from './helpers/requirements.js';

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
const ROOT = process.cwd();
const REQ = loadRequirements();
const REPO = 'acme/widgets';
const PINNED = 'v1.0.0';
const NEXT = 'v1.1.0';
const LANES = ['agent-review', 'agent-code-audit'];
const TAXONOMY = (JSON.parse(readFileSync(join(ROOT, 'rulebook/labels.json'), 'utf8')).labels as Array<{ name: string }>).map((l) => l.name).filter((n) => !/<[a-z]+>$/.test(n));

type Req = typeof REQ;
const clone = (r: Req): Req => JSON.parse(JSON.stringify(r));
const identitiesOf = (lanes: string[]) => [...new Set(lanes.flatMap((l) => REQ.lanes[l]!.identities))].sort();
const permissionsOf = (r: Req, id: string): Record<string, string> => ({ ...(r.identities.apps[id]?.permissions ?? r.identities.roles[id]!.permissions) });

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The register rows for the fixture's identities, one App slug each. */
const registerText = (ids: string[]) => {
  let text: string | null = null;
  for (const id of ids) {
    for (const role of registerRolesOf(id, REQ)) text = writeRegisterRow(text, { role, slug: `widgets-${id}`, permissions: permissionsOf(REQ, id) }).text;
  }
  return text!;
};

/** A healthy installation of the review and code-audit lanes at PINNED, as `kanon init` writes one. */
const healthyFiles = (): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const lane of LANES) files[`.github/workflows/${lane}.yml`] = callerFile(lane, REQ.lanes[lane]!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
  files['.github/workflows/apps-check.yml'] = appsCheckFile(identitiesOf(LANES), PINNED);
  files['.github/workflows/ci.yml'] = ciFile(PINNED, 'main');
  files['.github/dependabot.yml'] = dependabotFile();
  files[REQ.hook.path] = hookFile(REQ.hook.inputs);
  files['docs/qa/stack.md'] = '# Stack\n\n## Gates\n\n1. `npm test`\n';
  files['docs/qa/agent-identities.md'] = registerText(identitiesOf(LANES));
  files['docs/qa/adoption.md'] = '# Adoption record\n\n## People\n\n| Role | Who |\n|---|---|\n| Owner | `@octo` |\n\n## Choices\n\n- **Overseer:** `not installed`\n';
  return files;
};

/** A committed checkout of acme/widgets holding `files`. */
const checkout = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-doctor-'));
  scratch.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada Lovelace']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.com']);
  put(dir, files);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture']);
  return dir;
};

const put = (dir: string, files: Record<string, string | null>) => {
  for (const [rel, text] of Object.entries(files)) {
    const at = join(dir, rel);
    if (text === null) rmSync(at, { force: true });
    else {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, text);
    }
  }
};

type Gh = { status: number; stdout: string; stderr: string };
const ok = (v: unknown): Gh => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
const no = (stderr: string): Gh => ({ status: 1, stdout: '', stderr });

/** A fake GitHub: the repository, its Apps, and Kanon's requirements file at each release. */
const fakeGitHub = (over: { secrets?: Set<string> | null; releases?: Record<string, Req | null> } = {}) => {
  const ids = identitiesOf(LANES);
  const st = {
    labels: new Set(TAXONOMY),
    secrets: over.secrets === undefined ? new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets)) : over.secrets,
    apps: Object.fromEntries(ids.map((id) => [`widgets-${id}`, { owner: { login: 'acme', type: 'User' }, permissions: permissionsOf(REQ, id) }])) as Record<string, { owner: object; permissions: Record<string, string> }>,
    rulesets: [{ id: 7, ...rulesetBody(false) }],
    releases: over.releases ?? {},
  };
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<Gh> => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === 'api' && a1 === 'user') return ok('octo\n');
    if (a0 === 'secret' && a1 === 'list') return st.secrets ? ok([...st.secrets].map((name) => ({ name }))) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    if (a0 !== 'api' || args.includes('-X')) return no(`unexpected gh ${args.join(' ')}`);
    const path = args.find((x, i) => i > 0 && /^(repos|orgs|apps)\//.test(x)) ?? '';
    if (path === `repos/${REPO}`) return ok({ private: false, default_branch: 'main', owner: { login: 'acme', type: 'User' }, permissions: { admin: true } });
    if (path === `repos/${REPO}/branches/main`) return ok('main');
    if (path.startsWith(`repos/${REPO}/rulesets?`)) return ok(st.rulesets.map((r) => ({ id: r.id, name: r.name, target: r.target })));
    const one = /^repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(path);
    if (one) return ok(st.rulesets.find((r) => r.id === Number(one[1])));
    if (path.startsWith(`repos/${REPO}/labels?`)) return ok([[...st.labels].map((name) => ({ name }))]);
    if (path.startsWith(`repos/${REPO}/milestones?`)) return ok([[]]);
    const app = /^apps\/([a-z0-9-]+)$/.exec(path);
    if (app) return st.apps[app[1]!] ? ok({ slug: app[1], ...st.apps[app[1]!] }) : no('gh: Not Found (HTTP 404)');
    const rel = /^repos\/yedeya-labs\/kanon\/contents\/requirements\.json\?ref=(.+)$/.exec(path);
    if (rel) {
      const r = st.releases[decodeURIComponent(rel[1]!)];
      return r ? ok(r) : no('gh: Not Found (HTTP 404)');
    }
    return no(`unexpected gh ${args.join(' ')}`);
  };
  return { st, gh, calls };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the JSON document, read field by field
type Result = { status: number; out: string; err: string; json: any };

const run = async (dir: string, github: ReturnType<typeof fakeGitHub>, argv: string[] = []): Promise<Result> => {
  const out: string[] = [];
  const err: string[] = [];
  const status = await doctor(['--dir', dir, ...argv], {
    gh: github.gh,
    env: {},
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    requirements: () => REQ,
    release: () => PINNED,
  });
  const text = out.join('\n');
  return { status, out: text, err: err.join('\n'), json: argv.includes('--json') ? JSON.parse(text) : null };
};

const ids = (r: Result) => r.json.findings.map((f: { id: string; subject: string }) => `${f.id} ${f.subject}`);

/** The release after PINNED: one App permission more, and one declaration more for the review lane. */
const nextRelease = () => {
  const next = clone(REQ);
  const judgeLike = REQ.lanes['agent-review']!.identities[0]!;
  const target = next.identities.apps[judgeLike] ?? next.identities.roles[judgeLike]!;
  target.permissions.deployments = 'read';
  next.lanes['agent-review']!.reads = [...next.lanes['agent-review']!.reads, 'docs/qa/capability-ledger.md'].sort();
  return { next, slug: `widgets-${judgeLike}` };
};

describe('kanon doctor on a healthy installation', () => {
  it('finds nothing, lists the code-audit caller as Kanon\'s accepted holder, and exits 0', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.findings).toEqual([]);
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
      expect(c[0] === 'api' ? !c.includes('-X') && !c.includes('--method') && !c.includes('-f') && !c.includes('-F') : c[0] === 'secret' && c[1] === 'list', c.join(' ')).toBe(true);
    }
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
    expect(ids(before)).toEqual([`app.permission-missing ${slug}`, 'declaration.missing docs/qa/capability-ledger.md']);
    expect(before.json.findings[0].message).toContain('deployments: read');
    expect(before.json.findings[0].fix.url).toBe(`https://github.com/settings/apps/${slug}/permissions`);
    expect(before.json.releases).toMatchObject({ pinned: PINNED, to: NEXT, checked: NEXT });

    github.st.apps[slug]!.permissions.deployments = 'read';
    put(dir, { 'docs/qa/capability-ledger.md': '# Capability ledger\n' });
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
    expect(ids(r)).toEqual(['declaration.missing docs/qa/capability-ledger.md']);
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
  });

  it('refuses, exit 3, a release that ships no requirements file', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--to', 'v0.1.0', '--json']);
    expect(r.status).toBe(EXIT.error);
    expect(r.json).toEqual({ schema: SCHEMA, kanon: PINNED, status: 'error', exitCode: 3, error: expect.stringContaining('ships no requirements file') });
  });
});

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

  it("names an App that holds more than the release grants, as apps-check would", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    const id = REQ.lanes['agent-code-audit']!.identities[0]!;
    github.st.apps[`widgets-${id}`]!.permissions.administration = 'write';
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([`app.permission-extra widgets-${id}`]);
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

  it('names a caller that inherits secrets, and an apps-check caller that maps a secret its release does not take', async () => {
    const files = healthyFiles();
    files['.github/workflows/agent-review.yml'] = files['.github/workflows/agent-review.yml']!.replace(/ {4}secrets:\n( {6}.*\n)+/, '    secrets: inherit\n');
    files['.github/workflows/apps-check.yml'] += '      NOBODY_APP_ID: ${{ secrets.NOBODY_APP_ID }}\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['caller.secrets-inherited .github/workflows/agent-review.yml', 'apps-check.secret-stale .github/workflows/apps-check.yml']);
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
    expect(doc).toContain(`\`${SCHEMA}\``);
  });

  it('documents every finding id, with its category and whether it blocks, and nothing else', () => {
    const rows = [...doc.matchAll(/^\| `([a-z-]+\.[a-z-]+)` \| `([a-z-]+)` \| (yes|no) \|/gm)].map((m) => [m[1], { category: m[2], blocking: m[3] === 'yes' }]);
    expect(Object.fromEntries(rows)).toEqual(FINDINGS);
    for (const f of Object.values(FINDINGS)) expect(CATEGORIES).toContain(f.category);
  });

  it('documents every exit code', () => {
    for (const [name, code] of Object.entries(EXIT)) expect(doc, name).toMatch(new RegExp(`^\\| ${code} \\| \`${name}\` \\|`, 'm'));
  });
});
