import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiError, deployCheck, environmentCheck, gate, judgeProbe, maintainersOf, PROBE_FILE, PROBE_LINE, supersede } from '../../scripts/deploy-gate.mjs';

/**
 * Plan 0010 §3, §5, step D4: the deploy lane's checks, on fixtures of GitHub's answers. The gate
 * refuses each of §3's codes; the probe's judge passes only on every declared environment
 * `refused`; the environment job's declaration check holds the caller to the position the record
 * declares and derives the role from it; the supersede check refuses an older commit on a release
 * and lets a dispatch roll back.
 */

const SHA = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const REPO = 'acme/app';
const RECORD = (deploy: string[]) => `# Adoption record\n\n## Deploy\n\n${deploy.join('\n')}\n`;
const TWO = RECORD(['- **Environments:** `staging`, `production`', '- **CI wait:** `5`']);

const CI_RUNS = `repos/${REPO}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${SHA}&per_page=20`;
const green = { workflow_runs: [{ id: 7, head_sha: SHA, status: 'completed', conclusion: 'success' }] };
const running = { workflow_runs: [{ id: 7, head_sha: SHA, status: 'in_progress', conclusion: null }] };

type Route = unknown | (() => unknown);
/** GitHub's API as the fixtures answer it; any other path is a 404. */
const github = (over: Record<string, Route> = {}) => {
  const routes: Record<string, Route> = {
    [`repos/${REPO}/releases/tags/v1.2.0`]: { draft: false, prerelease: false, published_at: '2026-10-14T10:00:00Z' },
    [`repos/${REPO}/commits/v1.2.0`]: { sha: SHA },
    [`repos/${REPO}/compare/${SHA}...main`]: { behind_by: 0, status: 'ahead' },
    [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: TWO,
    [CI_RUNS]: green,
    [`repos/${REPO}/actions/runs/7/jobs?per_page=100`]: { jobs: [{ name: 'lint', conclusion: 'success' }, { name: 'test', conclusion: 'success' }] },
    ...over,
  };
  const calls: string[] = [];
  const api = (path: string) => {
    calls.push(path);
    if (!(path in routes) || routes[path] === undefined) throw new ApiError(`${path}: HTTP 404`, 404);
    const v = routes[path];
    return typeof v === 'function' ? (v as () => unknown)() : v;
  };
  return { api, calls };
};

const ENV = {
  GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'release', GITHUB_SHA: SHA, RELEASE_TAG: 'v1.2.0', RELEASE_DRAFT: 'false',
  DEFAULT_BRANCH: 'main', ENVIRONMENTS: 'staging production',
};
/** A clock that the gate's sleep moves forward, so a wait runs in no time. */
const clock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
};
const run = (env: Record<string, string> = {}, over: Record<string, Route> = {}) => {
  const c = clock();
  return { ...gate({ ...ENV, ...env }, { api: github(over).api, now: c.now, sleep: c.sleep }), sleeps: c.sleeps };
};
const refusal = (r: ReturnType<typeof run>) => (r.ok ? 'admitted' : r.refusal);

describe('the gate (plan 0010 §3)', () => {
  it('admits a published release of a green default-branch commit, declared for the list the caller passes', () => {
    const r = run();
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ environments: 'staging production', sha: SHA, tag: 'v1.2.0', prerelease: 'false', 'published-at': '2026-10-14T10:00:00Z', fallback: '' });
  });

  it('check 1: refuses a draft, a missing release, a tag that moved, and any other event', () => {
    expect(refusal(run({ RELEASE_DRAFT: 'true' }))).toBe('draft');
    expect(refusal(run({}, { [`repos/${REPO}/releases/tags/v1.2.0`]: { draft: true } }))).toBe('draft');
    expect(refusal(run({}, { [`repos/${REPO}/releases/tags/v1.2.0`]: undefined }))).toBe('no-release');
    expect(refusal(run({}, { [`repos/${REPO}/commits/v1.2.0`]: { sha: OLDER } }))).toBe('no-release');
    expect(refusal(run({ GITHUB_EVENT_NAME: 'push' }))).toBe('no-release');
    expect(refusal(run({ GITHUB_EVENT_NAME: 'workflow_dispatch', DISPATCH_RELEASE: '' }))).toBe('no-release');
    // The refusal is an output, for `record` and `report`, as well as the result.
    expect(run({ RELEASE_DRAFT: 'true' }).outputs.refusal).toBe('draft');
  });

  it("check 1 on a dispatch at the release's tag: the input's tag names the commit", () => {
    const r = run({ GITHUB_EVENT_NAME: 'workflow_dispatch', DISPATCH_RELEASE: 'v1.2.0', GITHUB_REF: 'refs/tags/v1.2.0', GITHUB_SHA: OLDER, RELEASE_TAG: '' });
    expect(r.ok).toBe(true);
    expect(r.outputs.sha).toBe(SHA);
  });

  it("check 1 refuses a dispatch at the default branch, or at another release's tag, before anything else is read (#914; MUTATION: the ref check removed turns this red)", () => {
    // The Owner's decision on #914: a dispatch runs at its release's tag, so no job carries the
    // default branch's subject, which the adopter's QA store and other roles trust.
    for (const GITHUB_REF of ['refs/heads/main', 'refs/tags/v1.1.0', '']) {
      const { api, calls } = github();
      const r = gate({ ...ENV, GITHUB_EVENT_NAME: 'workflow_dispatch', DISPATCH_RELEASE: 'v1.2.0', GITHUB_REF, RELEASE_TAG: '' }, { api, now: () => 0, sleep: () => {} });
      expect(r.ok ? 'admitted' : r.refusal, GITHUB_REF).toBe('no-release');
      expect(r.ok ? '' : r.message, GITHUB_REF).toMatch(/--ref v1\.2\.0 -f release=v1\.2\.0/);
      expect(calls, GITHUB_REF).toEqual([]);
    }
  });

  it("a release run is unaffected by the ref check: its own ref is never compared", () => {
    expect(run({ GITHUB_REF: 'refs/heads/main' }).ok).toBe(true);
    expect(run({ GITHUB_REF: '' }).ok).toBe(true);
  });

  it('check 2: refuses a commit off the default branch', () => {
    const r = run({}, { [`repos/${REPO}/compare/${SHA}...main`]: { behind_by: 3, status: 'diverged' } });
    expect(refusal(r)).toBe('not-default-branch');
    expect(r.ok ? '' : r.message).toMatch(/is not on `main`/);
  });

  it('check 3: refuses a caller list that skips, reorders or adds an environment, and a record that declares none or fails to parse', () => {
    expect(refusal(run({ ENVIRONMENTS: 'production' }))).toBe('declaration-mismatch');
    expect(refusal(run({ ENVIRONMENTS: 'production staging' }))).toBe('declaration-mismatch');
    expect(refusal(run({ ENVIRONMENTS: 'staging production canary' }))).toBe('declaration-mismatch');
    expect(refusal(run({}, { [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: undefined }))).toBe('declaration-mismatch');
    expect(refusal(run({}, { [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: RECORD(['- **Environments:** `staging`, `staging`']) }))).toBe('declaration-mismatch');
    expect(refusal(run({}, { [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: '# Adoption record\n' }))).toBe('declaration-mismatch');
  });

  it('check 3 reads the record at the release commit, not the default branch', () => {
    const { api, calls } = github();
    gate(ENV, { api, now: () => 0, sleep: () => {} });
    expect(calls).toContain(`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`);
  });

  it('check 4: refuses a red CI run, a red job in a green-looking run, and a repository with no ci.yml', () => {
    expect(refusal(run({}, { [CI_RUNS]: { workflow_runs: [{ id: 7, head_sha: SHA, status: 'completed', conclusion: 'failure' }] } }))).toBe('ci-red');
    expect(refusal(run({}, { [`repos/${REPO}/actions/runs/7/jobs?per_page=100`]: { jobs: [{ name: 'test', conclusion: 'cancelled' }] } }))).toBe('ci-red');
    expect(refusal(run({}, { [CI_RUNS]: undefined }))).toBe('ci-red');
  });

  it('check 4: waits for a running CI, polling every 60 seconds, and admits it once green', () => {
    let n = 0;
    const r = run({}, { [CI_RUNS]: () => (n++ < 2 ? running : green) });
    expect(r.ok).toBe(true);
    expect(r.sleeps).toEqual([60_000, 60_000]);
  });

  it('check 4: refuses `ci-timeout` when CI still runs past the declared wait of 5 minutes, and when no run appears', () => {
    const r = run({}, { [CI_RUNS]: running });
    expect(refusal(r)).toBe('ci-timeout');
    expect(r.sleeps).toHaveLength(5);
    expect(refusal(run({}, { [CI_RUNS]: { workflow_runs: [] } }))).toBe('ci-timeout');
  });

  it('check 4: waits 90 minutes when the record declares no CI wait', () => {
    const r = run({}, { [CI_RUNS]: running, [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: RECORD(['- **Environments:** `staging`, `production`']) });
    expect(refusal(r)).toBe('ci-timeout');
    expect(r.sleeps).toHaveLength(90);
  });

  it("outputs the declaration's fallback marker, which the probe's `if:` reads", () => {
    const r = run({}, { [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: RECORD(['- **Environments:** `staging`, `production`', '- **Fallback:** `no-environments`']) });
    expect(r.ok && r.outputs.fallback).toBe('no-environments');
  });
});

describe("the trust probe's judge (plan 0010 §5)", () => {
  const LIST = ['staging', 'production'];
  it('passes only when every declared environment refused, and prints the line doctor reads', () => {
    const r = judgeProbe(LIST, JSON.stringify({ staging: 'refused', production: 'refused' }));
    expect(r.ok).toBe(true);
    expect(r.line).toBe(`${PROBE_LINE} {"staging":"refused","production":"refused"}`);
  });

  it('fails `trust-unbound` when the hook obtained one, even beside an unconfigured one', () => {
    expect(judgeProbe(LIST, JSON.stringify({ staging: 'refused', production: 'obtained' })).refusal).toBe('trust-unbound');
    expect(judgeProbe(LIST, JSON.stringify({ staging: 'unconfigured', production: 'obtained' })).refusal).toBe('trust-unbound');
  });

  it('fails `probe-unconfigured` on an unconfigured environment, a missing one, a missing or malformed answer', () => {
    expect(judgeProbe(LIST, JSON.stringify({ staging: 'refused', production: 'unconfigured' })).refusal).toBe('probe-unconfigured');
    const missing = judgeProbe(LIST, JSON.stringify({ staging: 'refused' }));
    expect(missing.refusal).toBe('probe-unconfigured');
    expect(missing.line).toBe(`${PROBE_LINE} {"staging":"refused","production":"unconfigured"}`);
    expect(judgeProbe(LIST, null).refusal).toBe('probe-unconfigured');
    expect(judgeProbe(LIST, 'refused').refusal).toBe('probe-unconfigured');
    expect(judgeProbe(LIST, JSON.stringify({ staging: 'yes', production: 'refused' })).refusal).toBe('probe-unconfigured');
  });

  it('prints exactly the declared environments, whatever else the hook wrote', () => {
    const r = judgeProbe(['production'], JSON.stringify({ production: 'refused', staging: 'obtained' }));
    expect(r.ok).toBe(true);
    expect(r.line).toBe(`${PROBE_LINE} {"production":"refused"}`);
  });

  describe('the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-probe-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const cli = (answer: string | null) => {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      rmSync(join(dir, PROBE_FILE), { force: true });
      if (answer !== null) writeFileSync(join(dir, PROBE_FILE), answer);
      const r = spawnSync('node', ['scripts/deploy-gate.mjs', 'probe'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: REPO, RUNNER_TEMP: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '', ENVIRONMENTS: 'production' } });
      return { status: r.status, stdout: r.stdout, outputs: readFileSync(out, 'utf8') };
    };
    it('exits 0 and prints the line on a refusal of every environment', () => {
      const r = cli('{"production":"refused"}');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`${PROBE_LINE} {"production":"refused"}`);
      expect(r.outputs).toBe('');
    });
    it('exits 1 with the refusal as an output otherwise', () => {
      const r = cli('{"production":"obtained"}');
      expect(r.status).toBe(1);
      expect(r.outputs).toBe('refusal=trust-unbound\n');
      expect(cli(null).outputs).toBe('refusal=probe-unconfigured\n');
    });
  });
});

describe("the environment job's declaration check (plan 0010 §4)", () => {
  const check = (env: Record<string, string>, over: Record<string, Route> = {}) => environmentCheck({ ...ENV, ...env }, { api: github(over).api });
  it('admits the environment at its position, and derives its role from the record: the last is production', () => {
    const first = check({ ENVIRONMENT: 'staging', POSITION: '1' });
    expect(first.ok).toBe(true);
    expect(first.outputs).toMatchObject({ role: 'pre-production', environment: 'staging', sha: SHA, tag: 'v1.2.0' });
    expect(check({ ENVIRONMENT: 'production', POSITION: '2' }).outputs).toMatchObject({ role: 'production', environment: 'production' });
  });

  it('refuses `declaration-mismatch` when the environment is not at its position', () => {
    for (const [ENVIRONMENT, POSITION] of [['production', '1'], ['staging', '2'], ['canary', '3'], ['staging', '0']]) {
      const r = check({ ENVIRONMENT: ENVIRONMENT!, POSITION: POSITION! });
      expect(r.ok ? 'admitted' : r.refusal, `${ENVIRONMENT} at ${POSITION}`).toBe('declaration-mismatch');
    }
  });

  it("sets no environment under the record's `no-environments` marker, and keeps it under `no-reviewers`", () => {
    const record = (marker: string) => ({ [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: RECORD(['- **Environments:** `production`', `- **Fallback:** \`${marker}\``]) });
    expect(check({ ENVIRONMENT: 'production', POSITION: '1' }, record('no-environments')).outputs).toMatchObject({ environment: '', role: 'production', fallback: 'no-environments' });
    expect(check({ ENVIRONMENT: 'production', POSITION: '1' }, record('no-reviewers')).outputs).toMatchObject({ environment: 'production', fallback: 'no-reviewers' });
  });
});

describe('the hold under a fallback marker (plan 0010 §13, kanon#894)', () => {
  const PEOPLE = '## People\n\n| Role | Who |\n|---|---|\n| Owner | A Person (`@owner`) |\n| Maintainer | M Person (`@maint`) |\n\n';
  const marked = (marker: string | null) => ({
    [`repos/${REPO}/contents/docs/qa/adoption.md?ref=${SHA}`]: `# Adoption record\n\n${PEOPLE}## Deploy\n\n- **Environments:** \`staging\`, \`production\`\n${marker ? `- **Fallback:** \`${marker}\`\n` : ''}`,
  });
  const check = (env: Record<string, string>, marker: string | null) => environmentCheck({ ...ENV, ...env }, { api: github(marked(marker)).api });
  const DISPATCH = { GITHUB_EVENT_NAME: 'workflow_dispatch', DISPATCH_RELEASE: 'v1.2.0', GITHUB_REF: 'refs/tags/v1.2.0', RELEASE_TAG: '' };

  it('holds the last environment on a `release` run under either marker', () => {
    for (const marker of ['no-environments', 'no-reviewers']) {
      const r = check({ ENVIRONMENT: 'production', POSITION: '2' }, marker);
      expect(r.ok, marker).toBe(true);
      expect(r.outputs.held, marker).toBe('true');
      expect(r.ok && r.line).toMatch(/waits for the Maintainer's dispatch/);
    }
  });

  it('never holds a pre-production environment, a run with no marker, or a dispatch', () => {
    expect(check({ ENVIRONMENT: 'staging', POSITION: '1' }, 'no-reviewers').outputs.held).toBe('false');
    expect(check({ ENVIRONMENT: 'production', POSITION: '2' }, null).outputs.held).toBe('false');
    expect(check({ ...DISPATCH, ENVIRONMENT: 'production', POSITION: '2', GITHUB_ACTOR: 'maint' }, 'no-reviewers').outputs.held).toBe('false');
  });

  it("admits the Maintainer's production dispatch, and refuses anyone else's, with no code the row could carry yet", () => {
    expect(check({ ...DISPATCH, ENVIRONMENT: 'production', POSITION: '2', GITHUB_ACTOR: 'maint' }, 'no-environments').ok).toBe(true);
    const r = check({ ...DISPATCH, ENVIRONMENT: 'production', POSITION: '2', GITHUB_ACTOR: 'owner' }, 'no-environments');
    expect(r.ok).toBe(false);
    expect(r.outputs.unauthorized).toBe('not-maintainer');
    expect(r.ok ? '' : r.message).toMatch(/only the Maintainer \(@maint\)/);
    // Without a marker the platform's reviewers gate production: no Maintainer check.
    expect(check({ ...DISPATCH, ENVIRONMENT: 'production', POSITION: '2', GITHUB_ACTOR: 'owner' }, null).ok).toBe(true);
  });

  it('refuses a non-Maintainer under `no-reviewers` too (#904)', () => {
    const r = check({ ...DISPATCH, ENVIRONMENT: 'production', POSITION: '2', GITHUB_ACTOR: 'owner' }, 'no-reviewers');
    expect(r.ok).toBe(false);
    expect(r.outputs.unauthorized).toBe('not-maintainer');
  });

  it("judges whoever started this attempt: a re-run of the Maintainer's dispatch by anyone else is refused (MUTATION: reading GITHUB_ACTOR only turns this red)", () => {
    for (const marker of ['no-environments', 'no-reviewers']) {
      const rerun = check({ ...DISPATCH, ENVIRONMENT: 'production', POSITION: '2', GITHUB_ACTOR: 'maint', GITHUB_TRIGGERING_ACTOR: 'owner' }, marker);
      expect(rerun.ok, marker).toBe(false);
      expect(rerun.outputs.unauthorized, marker).toBe('not-maintainer');
      expect(rerun.ok ? '' : rerun.message).toMatch(/started by @owner/);
      // The Maintainer re-running their own dispatch, or one someone else started, is admitted.
      expect(check({ ...DISPATCH, ENVIRONMENT: 'production', POSITION: '2', GITHUB_ACTOR: 'owner', GITHUB_TRIGGERING_ACTOR: 'maint' }, marker).ok, marker).toBe(true);
    }
  });

  describe("the deploy job's own check, which a \"Re-run failed jobs\" re-runs with declare's outputs reused", () => {
    const sup = { [`repos/${REPO}/deployments?environment=production&per_page=100`]: [] };
    const deploy = (env: Record<string, string>) => deployCheck({ GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'workflow_dispatch', ENVIRONMENT: 'production', SHA, ...env }, { api: github({ ...marked('no-reviewers'), ...sup }).api });

    it('refuses production under a marker when a non-Maintainer started this attempt, before the supersede check', () => {
      for (const FALLBACK of ['no-environments', 'no-reviewers']) {
        const r = deploy({ FALLBACK, ROLE: 'production', GITHUB_ACTOR: 'maint', GITHUB_TRIGGERING_ACTOR: 'owner' });
        expect(r, FALLBACK).toMatchObject({ ok: false, outputs: { unauthorized: 'not-maintainer' }, code: 'not-maintainer' });
      }
    });

    it("admits the Maintainer's attempt, and checks no actor without a marker or for pre-production", () => {
      expect(deploy({ FALLBACK: 'no-reviewers', ROLE: 'production', GITHUB_ACTOR: 'owner', GITHUB_TRIGGERING_ACTOR: 'maint' })).toMatchObject({ ok: true, outputs: { redeploy: 'false', rollback: 'false' } });
      expect(deploy({ FALLBACK: '', ROLE: 'production', GITHUB_ACTOR: 'owner' }).ok).toBe(true);
      expect(deploy({ FALLBACK: 'no-reviewers', ROLE: 'pre-production', GITHUB_ACTOR: 'owner' }).ok).toBe(true);
    });
  });

  it("reads the Maintainer's logins from the record's People table", () => {
    expect(maintainersOf(PEOPLE)).toEqual(['maint']);
    expect(maintainersOf('| Maintainer | A (`@a`), B (`@b-c`) |')).toEqual(['a', 'b-c']);
    expect(maintainersOf('# nothing')).toEqual([]);
  });
});

describe('the supersede check (plan 0010 §3)', () => {
  const deployments = (list: Array<{ id: number, sha: string, state: string }>, cmp: string) => github({
    [`repos/${REPO}/deployments?environment=production&per_page=100`]: list.map(({ id, sha }) => ({ id, sha })),
    ...Object.fromEntries(list.map(({ id, state }) => [`repos/${REPO}/deployments/${id}/statuses?per_page=1`, [{ state }]])),
    [`repos/${REPO}/compare/${SHA}...${OLDER}`]: { status: cmp },
  }).api;
  const sup = (trigger: string, list: Array<{ id: number, sha: string, state: string }>, cmp = 'behind') =>
    supersede({ repo: REPO, environment: 'production', sha: SHA, trigger, api: deployments(list, cmp) });

  it('admits a first deploy, and a commit newer than the last success', () => {
    expect(sup('release', [])).toMatchObject({ ok: true, redeploy: false, rollback: false });
    expect(sup('release', [{ id: 2, sha: SHA, state: 'in_progress' }, { id: 1, sha: OLDER, state: 'success' }], 'behind')).toMatchObject({ ok: true, rollback: false });
  });

  it('refuses `superseded` on a release older than the last success', () => {
    const r = sup('release', [{ id: 2, sha: SHA, state: 'in_progress' }, { id: 1, sha: OLDER, state: 'success' }], 'ahead');
    expect(r).toMatchObject({ ok: false, refusal: 'superseded' });
  });

  it('admits the same on a dispatch, as a rollback', () => {
    const r = sup('workflow_dispatch', [{ id: 1, sha: OLDER, state: 'success' }], 'ahead');
    expect(r).toMatchObject({ ok: true, refusal: null, rollback: true });
  });

  it('marks a redeploy of the commit last deployed, or of one that succeeded before', () => {
    expect(sup('release', [{ id: 1, sha: SHA, state: 'success' }])).toMatchObject({ ok: true, redeploy: true });
    expect(sup('release', [{ id: 3, sha: OLDER, state: 'success' }, { id: 1, sha: SHA, state: 'success' }], 'behind')).toMatchObject({ ok: true, redeploy: true });
  });
});
