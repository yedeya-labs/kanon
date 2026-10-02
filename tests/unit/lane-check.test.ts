import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

/**
 * `actions/lane-check` (plan 0001 §6): the permanent rules for an adopter's lane callers.
 *
 * Every case runs the real script, against a copy of the fixture adopter
 * (`tests/fixtures/lane-check/adopter`, the shape an adopter copies) with ONE thing broken,
 * and reads Kanon's real lane files from this tree, as the action reads them from the tag
 * an adopter pinned. The first case is the fixture passing whole, so every red below is the
 * one change it makes.
 *
 * `yq` (mikefarah v4) is on GitHub's hosted runners, so CI always runs these. A machine
 * without it skips them, and says so; CI never does (decision 6).
 */
const ROOT = process.cwd();
const FIXTURE = join(ROOT, 'tests/fixtures/lane-check/adopter');
const SCRIPT = join(ROOT, 'actions/lane-check/lane-check.sh');
const hasYq = spawnSync('yq', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasYq && process.env.CI) throw new Error('lane-check tests need yq on PATH in CI');

type Tree = { dir: string; edit: (rel: string, fn: (doc: Record<string, unknown>) => void) => void; write: (rel: string, body: string) => void; read: (rel: string) => string; rm: (rel: string) => void };

const adopter = (): Tree => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-check-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');
  const write = (rel: string, body: string) => writeFileSync(join(dir, rel), body);
  return {
    dir,
    read,
    write,
    rm: (rel) => rmSync(join(dir, rel), { recursive: true, force: true }),
    edit: (rel, fn) => {
      const doc = parse(read(rel)) as Record<string, unknown>;
      fn(doc);
      write(rel, stringify(doc));
    },
  };
};

const check = (tree: Tree, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [SCRIPT], { cwd: tree.dir, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '', ...env } });
  rmSync(tree.dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/** Run with one change, and expect exactly a red naming `message`. */
const red = (change: (t: Tree) => void, message: string | RegExp, env: Record<string, string> = {}) => {
  const t = adopter();
  change(t);
  const r = check(t, env);
  expect(r.status, r.out).toBe(1);
  expect(r.out).toMatch(typeof message === 'string' ? new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : message);
  return r;
};

const TRIAGE = '.github/workflows/agent-triage.yml';
const IMPL = '.github/workflows/agent-implement-revise.yml';
const REGISTER = 'docs/qa/agent-identities.md';
type Caller = { on?: unknown; concurrency?: unknown; env?: unknown; permissions?: Record<string, string>; jobs: Record<string, Record<string, unknown>> };
const job = (doc: Record<string, unknown>) => Object.values((doc as Caller).jobs)[0]!;

describe.skipIf(!hasYq)('lane-check', () => {
  it('passes Kanon itself, which calls its own review lane (ADR 0011, plan 0001 step 4b)', () => {
    // In this tree, not a copy: Kanon is its own adopter. CI also runs the released action on
    // it; this run reads the lanes as this PR leaves them, so a lane change that would break
    // Kanon's own caller is red here before it is released.
    const r = spawnSync('bash', [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('1 lane caller(s) pass');
  });

  it('passes the fixture adopter whole, and counts its four callers', () => {
    const r = check(adopter());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('4 lane caller(s) pass');
  });

  describe('a caller holds only its triggers, permissions and one job', () => {
    it('refuses a workflow-level env', () => red((t) => t.edit(TRIAGE, (d) => { d.env = { X: '1' }; }), 'it also has: env'));
    it('refuses concurrency on the caller, which the lane holds (decision 11)', () =>
      red((t) => t.edit(TRIAGE, (d) => { d.concurrency = { group: 'x' }; }), 'it also has: concurrency'));
    it('refuses concurrency on the calling job too', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).concurrency = 'x'; }), 'the calling job holds only uses, with, secrets and permissions; it also has: concurrency'));
    it('refuses a second job', () =>
      red((t) => t.edit(TRIAGE, (d) => { (d as Caller).jobs.more = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] }; }), 'exactly one job, not 2'));
    it('refuses a job-level `if`, which is the lane\'s admission rule', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).if = 'true'; }), 'it also has: if'));
  });

  describe('the calling job passes only its own inputs through', () => {
    it('refuses a literal value, which would be a setting (ADR 0002)', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '12' }; }), 'a caller only passes its own input through'));
    it('refuses another input\'s value', () =>
      red((t) => t.edit(IMPL, (d) => { job(d).with = { pr_number: '${{ inputs.reset }}', reset: '${{ inputs.reset }}' }; }), 'passes `pr_number: ${{ inputs.reset }}`'));
    it('refuses an input the lane does not declare', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '${{ inputs.issue_number }}', bogus: '${{ inputs.bogus }}' }; }), 'passes `bogus`, which the Kanon lane agent-triage does not declare'));
  });

  describe('the calling job maps exactly the lane\'s secrets, explicitly', () => {
    it('refuses `secrets: inherit` (decision 7)', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).secrets = 'inherit'; }), 'maps no secrets explicitly'));
    it('refuses a missing secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { delete (job(d).secrets as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN; }), 'takes exactly [CLAUDE_CODE_OAUTH_TOKEN,IMPLEMENTER_APP_ID,IMPLEMENTER_APP_PRIVATE_KEY]'));
    it('refuses a secret under a name the lane does not take', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).QA_TRIAGE_APP_ID = '${{ secrets.QA_TRIAGE_APP_ID }}'; }), 'the Kanon lane agent-triage takes exactly'));
    it('refuses a secret mapped to anything but one repository secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).IMPLEMENTER_APP_ID = '${{ github.token }}'; }), 'map each one to a single repository secret'));
    it('accepts a secret mapped from another repository secret, as during the renaming (§8)', () => {
      const t = adopter();
      t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).IMPLEMENTER_APP_ID = '${{ secrets.QA_TRIAGE_APP_ID }}'; });
      expect(check(t).status).toBe(0);
    });
  });

  describe('the caller grants at least what the lane declares (§3)', () => {
    it('refuses a caller with no explicit permissions', () =>
      red((t) => t.edit(IMPL, (d) => { delete d.permissions; }), 'grants no explicit permissions'));
    it('refuses a narrower grant', () =>
      red((t) => t.edit(IMPL, (d) => { (d as Caller).permissions = { contents: 'read', 'pull-requests': 'read' }; }), 'grants issues: none; the Kanon lane agent-implement-revise needs issues: read'));
    it('refuses read where the lane needs write', () =>
      red((t) => t.edit('.github/workflows/agent-lead-revise.yml', (d) => { (d as Caller).permissions!['pull-requests'] = 'read'; }), 'needs pull-requests: write'));
    // A job-level grant inside a called workflow is held to the caller's ceiling too, so the
    // implement lane's crash recovery (issues, pull requests and actions, on the default
    // token) is part of what its caller must grant.
    it('counts a grant the lane makes on one of its jobs, not only at its top level', () =>
      red((t) => t.edit('.github/workflows/agent-implement.yml', (d) => { delete (d as Caller).permissions!.actions; }), 'grants actions: none; the Kanon lane agent-implement needs actions: write'));
    it('takes the wider of a top-level and a job-level grant of one scope', () =>
      red((t) => t.edit('.github/workflows/agent-implement.yml', (d) => { (d as Caller).permissions!.issues = 'read'; }), 'needs issues: write'));
    it('reads the calling job\'s own grant over the workflow\'s', () => {
      const t = adopter();
      t.edit(IMPL, (d) => {
        (d as Caller).permissions = {};
        job(d).permissions = { contents: 'read', 'pull-requests': 'read', issues: 'read' };
      });
      expect(check(t).status).toBe(0);
    });
  });

  describe('every Kanon reference pins one exact version (K-ADOPT-11)', () => {
    const retag = (t: Tree, rel: string, tag: string) => t.write(rel, t.read(rel).replace(/@v1\.2\.3/g, `@${tag}`));
    it('refuses the moving major tag', () => red((t) => retag(t, TRIAGE, 'v1'), "pins 'v1', not an exact version"));
    it('refuses two versions', () => red((t) => retag(t, TRIAGE, 'v1.2.4'), 'pin v1.2.3,v1.2.4'));
    it('refuses a version other than the one lane-check runs at', () =>
      red(() => {}, 'lane-check runs at v9.9.9, but the Kanon references pin v1.2.3', { ACTION_REF: 'v9.9.9' }));
    it('accepts the version lane-check runs at', () => expect(check(adopter(), { ACTION_REF: 'v1.2.3' }).status).toBe(0));
    it('counts a pin in any workflow, not only in a caller', () =>
      red((t) => t.write('.github/workflows/other.yml', 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: yedeya-labs/kanon/actions/pr-title@v1.0.0\n'), 'pin v1.0.0,v1.2.3'));
    it('ignores a commented-out reference, which is not a pin', () => {
      const t = adopter();
      t.write(TRIAGE, `${t.read(TRIAGE)}#    uses: yedeya-labs/kanon/.github/workflows/agent-triage.yml@v0.0.1\n`);
      expect(check(t).status).toBe(0);
    });
  });

  describe('a file it cannot parse is a red, never a file it skips', () => {
    const BROKEN = 'jobs: [unclosed\n';
    it('a workflow', () => red((t) => t.write('.github/workflows/broken.yml', BROKEN), '.github/workflows/broken.yml,title=lane-check::is not valid YAML'));
    it('the hook', () => red((t) => t.write('.github/actions/project-setup/action.yml', BROKEN), 'project-setup/action.yml,title=lane-check::is not valid YAML'));
    it('the Dependabot file', () => red((t) => t.write('.github/dependabot.yml', BROKEN), 'dependabot.yml,title=lane-check::is not valid YAML'));
  });

  describe('which files are callers', () => {
    it('refuses a call to a lane this Kanon version does not ship', () =>
      red((t) => t.write(TRIAGE, t.read(TRIAGE).replace('workflows/agent-triage.yml@', 'workflows/agent-nope.yml@')), "calls Kanon lane 'agent-nope', which this Kanon version does not ship"));
    it('holds a call to the spine to no caller rule: it is not a lane', () => {
      const t = adopter();
      t.write('.github/workflows/agent-implement.yml', stringify({
        on: { issues: { types: ['labeled'] } },
        concurrency: { group: 'x' },
        jobs: { implement: { if: 'true', uses: 'yedeya-labs/kanon/.github/workflows/agent-lane.yml@v1.2.3', with: { agent: 'implementer' } } },
      }));
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('3 lane caller(s) pass');
    });
    it('refuses a repository with no lane caller at all', () =>
      red((t) => { for (const f of ['agent-triage', 'agent-implement', 'agent-implement-revise', 'agent-lead-revise']) t.rm(`.github/workflows/${f}.yml`); }, 'no workflow calls a Kanon lane'));
  });

  describe('a lane that runs as another role (§8)', () => {
    // The merge-reconcile lane runs as the Reviewer, whom the fixture's register does not list.
    const MERGE = '.github/workflows/agent-merge-reconcile.yml';
    const addCaller = (t: Tree) => t.write(MERGE, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-merge-reconcile.yml'), 'utf8'));
    it('refuses its caller while the register has no row for that role', () =>
      red(addCaller, 'lists the role Reviewer 0 times'));
    it('accepts it once the role has a row', () => {
      const t = adopter();
      addCaller(t);
      t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-reviewer\` | Read | Read & write | Read & write | No access |\n`);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
    });
  });

  describe('the review and verify-acs lanes (step 4)', () => {
    const REVIEW = '.github/workflows/agent-review.yml';
    const VERIFY = '.github/workflows/agent-verify-acs.yml';
    const extra = (t: Tree, f: string) => t.write(f, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra', f.split('/').pop()!), 'utf8'));
    const roles = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-reviewer\` | Read | Read & write | Read & write | No access |\n| Explorer | \`example-explorer\` | Read | Read & write | Read | No access |\n`);
    it('accepts both callers, with the roles they run as registered', () => {
      const t = adopter();
      extra(t, REVIEW);
      extra(t, VERIFY);
      roles(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('6 lane caller(s) pass');
    });
    it('refuses a review caller with no run-name, which the review-run evidence reads', () =>
      red((t) => { extra(t, REVIEW); roles(t); t.edit(REVIEW, (d) => { delete d['run-name']; }); }, 'its run-name must end with'));
    it('refuses a review caller whose run-name does not end with the head SHA', () =>
      red((t) => {
        extra(t, REVIEW);
        roles(t);
        t.edit(REVIEW, (d) => { d['run-name'] = '${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.pr_number }} review'; });
      }, 'its run-name must end with'));
    it('accepts a run-name on a caller whose lane asks for none', () => {
      const t = adopter();
      t.edit(TRIAGE, (d) => { d['run-name'] = 'Triage ${{ github.event.issue.number }}'; });
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses the verify-acs caller while the register has no Explorer', () =>
      red((t) => { extra(t, VERIFY); }, 'lists the role Explorer 0 times'));
  });

  describe('the project-setup hook (§5)', () => {
    const HOOK = '.github/actions/project-setup/action.yml';
    it('refuses a missing hook', () => red((t) => t.rm(HOOK), 'the project-setup hook is missing'));
    it('refuses a hook that does not declare an input Kanon passes', () =>
      red((t) => t.edit(HOOK, (d) => { delete (d.inputs as Record<string, unknown>)['github-token']; }), 'does not declare the input `github-token`'));
    it('refuses a hook that is not a composite action', () =>
      red((t) => t.edit(HOOK, (d) => { (d.runs as Record<string, unknown>).using = 'node24'; }), 'must be a composite action'));
  });

  describe('the App register has a slug for every role a caller\'s lane runs as (K-LAYOUT-6)', () => {
    const REG = 'docs/qa/agent-identities.md';
    it('refuses a missing register', () => red((t) => t.rm(REG), 'the App register is missing'));
    it('refuses a register without the role', () =>
      red((t) => t.write(REG, t.read(REG).replace(/^\| Lead .*\n/m, '')), 'lists the role Lead 0 times, not once'));
    it('does not ask for a role no caller runs as', () => {
      const t = adopter();
      t.rm('.github/workflows/agent-lead-revise.yml');
      t.write(REG, t.read(REG).replace(/^\| Lead .*\n/m, ''));
      expect(check(t).status).toBe(0);
    });
    it('refuses a slug that is not in backticks', () =>
      red((t) => t.write(REG, t.read(REG).replace('`example-implementer`', 'example-implementer')), 'gives the role Implementer no App slug in backticks'));
  });

  describe('the Dependabot entry that proposes Kanon upgrades (K-ADOPT-11)', () => {
    const DEP = '.github/dependabot.yml';
    type Dep = { updates: Record<string, unknown>[] };
    it('refuses a missing file', () => red((t) => t.rm(DEP), 'is missing; it holds the entry'));
    it('refuses an entry with no Kanon group', () =>
      red((t) => t.edit(DEP, (d) => { delete (d as Dep).updates[0]!.groups; }), 'has no github-actions entry'));
    it('refuses an entry that is not titled `ci`', () =>
      red((t) => t.edit(DEP, (d) => { (d as Dep).updates[0]!['commit-message'] = { prefix: 'build' }; }), 'has no github-actions entry'));
    it('refuses a cooldown that holds Kanon back', () =>
      red((t) => t.edit(DEP, (d) => { (d as Dep).updates[0]!.cooldown = { 'default-days': 3 }; }), 'has no github-actions entry'));
    it('accepts a cooldown that excludes Kanon', () => {
      const t = adopter();
      t.edit(DEP, (d) => { (d as Dep).updates[0]!.cooldown = { 'default-days': 3, exclude: ['yedeya-labs/kanon*'] }; });
      expect(check(t).status).toBe(0);
    });
  });
});

describe('the lane-check action', () => {
  const action = parse(readFileSync(join(ROOT, 'actions/lane-check/action.yml'), 'utf8')) as {
    inputs?: unknown;
    runs: { using: string; steps: { run?: string; env?: Record<string, string> }[] };
  };

  it('takes no inputs: what a lane needs is read from the lane (ADR 0002)', () => {
    expect(action.inputs).toBeUndefined();
  });

  it('runs its script from its own directory, at the version it was called at', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toHaveLength(1);
    expect(action.runs.steps[0]?.run).toBe('bash "$GITHUB_ACTION_PATH/lane-check.sh"');
    expect(action.runs.steps[0]?.env).toEqual({ ACTION_REF: '${{ github.action_ref }}' });
  });

  it('the agents smoke runs it on the fixture adopter, through `$/`', () => {
    const smoke = parse(readFileSync(join(ROOT, '.github/workflows/agent-lanes-smoke.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: { uses?: string; run?: string }[] }>;
    };
    const steps = smoke.jobs.smoke?.steps ?? [];
    expect(steps.map((s) => s.uses).filter(Boolean)).toEqual(['actions/checkout@v7', '$/actions/kanon-path', '$/actions/lane-check']);
    expect(steps.some((s) => s.run?.includes('cp -R tests/fixtures/lane-check/adopter/. .'))).toBe(true);
  });
});
