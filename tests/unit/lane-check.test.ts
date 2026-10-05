import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('passes Kanon itself, which calls its own review, implement and code-audit lanes (ADR 0011)', () => {
    // In this tree, not a copy: Kanon is its own adopter. CI also runs the released action on
    // it; this run reads the lanes as this PR leaves them, so a lane change that would break
    // Kanon's own caller is red here before it is released.
    const r = spawnSync('bash', [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('4 lane caller(s) pass');
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
      red((t) => t.edit('.github/workflows/agent-implement.yml', (d) => { delete (d as Caller).permissions!.actions; }), 'grants actions: none; the Kanon lane agent-implement needs actions: read'));
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
    // A caller of one of Kanon's other reusable workflows exactly as its doc gives it,
    // retagged to the fixture's pin, so the doc and this check can't drift apart (kanon#152).
    const docCaller = (doc: string, workflow: string) => {
      const marker = `yedeya-labs/kanon/.github/workflows/${workflow}.yml@`;
      const block = [...readFileSync(join(ROOT, doc), 'utf8').matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.includes(marker));
      if (!block) throw new Error(`${doc} gives no caller of ${workflow}.yml; update this test`);
      return block.replace(/@v\d+\.\d+\.\d+/g, '@v1.2.3');
    };
    const releaseCaller = () => docCaller('docs/release.md', 'release');
    it('holds the release caller docs/release.md gives to no caller rule: it is not a lane', () => {
      const t = adopter();
      t.write('.github/workflows/release.yml', releaseCaller());
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('4 lane caller(s) pass');
    });
    it('holds the apps-check caller docs/apps.md gives to no caller rule either (kanon#154)', () => {
      const t = adopter();
      t.write('.github/workflows/apps-check.yml', docCaller('docs/apps.md', 'apps-check'));
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('4 lane caller(s) pass');
    });
    it.each([
      ['docs/release.md', 'release'],
      ['docs/apps.md', 'apps-check'],
    ])('still refuses `secrets: inherit` on the %s caller of Kanon\'s %s workflow (decision 7)', (doc, wf) => {
      red((t) => {
        const f = `.github/workflows/${wf}.yml`;
        t.write(f, docCaller(doc, wf));
        t.edit(f, (d) => { job(d).secrets = 'inherit'; });
      }, new RegExp(`${wf}\\.yml,title=lane-check::the job \`[a-z]+\` calls Kanon's ${wf} workflow with \`secrets: inherit\``));
    });
    it('still pins the release caller to the one version', () =>
      red((t) => t.write('.github/workflows/release.yml', releaseCaller().replace('@v1.2.3', '@v1.2.4')), 'pin v1.2.3,v1.2.4'));
    it('still refuses a lane caller beside it that maps no secrets', () =>
      red((t) => { t.write('.github/workflows/release.yml', releaseCaller()); t.edit(TRIAGE, (d) => { delete job(d).secrets; }); }, 'agent-triage.yml,title=lane-check::maps no secrets explicitly'));
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

  describe('the explore lane (plan 0004 step 12)', () => {
    const EXPLORE = '.github/workflows/agent-explore.yml';
    const HOOK = '.github/actions/explore-sweep/action.yml';
    const caller = (t: Tree) => t.write(EXPLORE, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-explore.yml'), 'utf8'));
    const explorer = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Explorer | \`example-explorer\` | Read | Read & write | Read | No access |\n`);
    const sweep = (t: Tree, body = 'name: Explore sweep\ninputs:\n  tier: { required: false, default: "" }\nruns:\n  using: composite\n  steps:\n    - run: echo sweep\n      shell: bash\n') => {
      mkdirSync(join(t.dir, '.github/actions/explore-sweep'), { recursive: true });
      t.write(HOOK, body);
    };
    it('accepts the caller, with the Explorer registered and the sweep hook written', () => {
      const t = adopter();
      caller(t);
      explorer(t);
      sweep(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
    });
    it('refuses the caller in a repository without the sweep hook (decision 5)', () =>
      red((t) => { caller(t); explorer(t); }, `${HOOK},title=lane-check::is missing; the Kanon lane(s) agent-explore call it`));
    it('refuses a sweep hook that is not a composite action', () =>
      red((t) => { caller(t); explorer(t); sweep(t, 'name: Explore sweep\nruns:\n  using: node24\n  main: index.js\n'); },
        `${HOOK},title=lane-check::must be a composite action`));
    it('refuses a caller that does not grant the store jobs their id-token', () =>
      red((t) => { caller(t); explorer(t); sweep(t); t.edit(EXPLORE, (d) => { delete (d as Caller).permissions!['id-token']; }); }, 'needs id-token: write'));
    it('refuses a caller that passes the tier as a setting rather than its own input', () =>
      red((t) => { caller(t); explorer(t); sweep(t); t.edit(EXPLORE, (d) => { (job(d).with as Record<string, string>).tier = 'admin'; }); }, 'passes `tier: admin`'));
  });

  describe('the lead, lead-split and rebase lanes (step 5)', () => {
    const LANES = ['agent-lead', 'agent-lead-split', 'agent-rebase'].map((f) => `.github/workflows/${f}.yml`);
    const extra = (t: Tree, f: string) => t.write(f, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra', f.split('/').pop()!), 'utf8'));
    const REBASE = LANES[2]!;
    it('accepts all three callers, run as the Lead and the Implementer the register lists', () => {
      const t = adopter();
      for (const f of LANES) extra(t, f);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('7 lane caller(s) pass');
    });
    it('refuses a rebase caller that does not grant the filter job’s read of runs', () =>
      red((t) => { extra(t, REBASE); t.edit(REBASE, (d) => { delete (d as Caller).permissions!.actions; }); }, 'needs actions: read'));
    it('refuses a split caller that grants the gate’s label edit only read', () =>
      red((t) => { extra(t, LANES[1]!); t.edit(LANES[1]!, (d) => { (d as Caller).permissions!.issues = 'read'; }); }, 'needs issues: write'));
  });

  describe('the Merger lane (plan 0004 step 7)', () => {
    const MERGE = '.github/workflows/agent-merge.yml';
    const extra = (t: Tree) => t.write(MERGE, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-merge.yml'), 'utf8'));
    const merger = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Merger | \`example-merger\` | Read & write | Read & write | Read & write | No access |\n`);
    it('accepts the caller, named `Merge (Merger)`, with the Merger registered', () => {
      const t = adopter();
      extra(t);
      merger(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
    });
    it('refuses the caller while the register has no Merger', () =>
      red((t) => { extra(t); }, 'lists the role Merger 0 times'));
    // The rule the step adds: `merge-gate.mjs` tells its own checks from the rest by the caller's
    // name, so under another name the Merger waits on itself.
    it('refuses the caller under any other name', () =>
      red((t) => { extra(t); merger(t); t.edit(MERGE, (d) => { d.name = 'Merge'; }); },
        'agent-merge.yml,title=lane-check::its name must be `Merge (Merger)`, not `Merge`'));
    it('refuses the caller under the old persona name', () =>
      red((t) => { extra(t); merger(t); t.edit(MERGE, (d) => { d.name = 'Merge (Joshua)'; }); }, 'its name must be `Merge (Merger)`'));
    it('refuses the caller with no name, whose checks GitHub reports under its path', () =>
      red((t) => { extra(t); merger(t); t.edit(MERGE, (d) => { delete d.name; }); }, 'its name must be `Merge (Merger)`, not ``'));
    it('holds no other caller to a name: their lanes ask for none', () => {
      const t = adopter();
      t.edit(TRIAGE, (d) => { d.name = 'Anything at all'; });
      expect(check(t).status).toBe(0);
    });
    it('refuses a caller that passes `apply` as a setting rather than its own input', () =>
      red((t) => { extra(t); merger(t); t.edit(MERGE, (d) => { (job(d).with as Record<string, string>).apply = 'true'; }); }, 'passes `apply: true`'));
    it('refuses a caller that maps the Claude token, which this lane does not take', () =>
      red((t) => {
        extra(t);
        merger(t);
        t.edit(MERGE, (d) => { (job(d).secrets as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN = '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'; });
      }, 'the Kanon lane agent-merge takes exactly [MERGER_APP_ID,MERGER_APP_PRIVATE_KEY]'));
  });

  describe('the reconciler lane (plan 0004 step 8)', () => {
    const TICK = '.github/workflows/agent-lead-reconcile.yml';
    const extra = (t: Tree) => t.write(TICK, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-lead-reconcile.yml'), 'utf8'));
    it('accepts the caller, run as the Lead the register lists', () => {
      const t = adopter();
      extra(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
    });
    it('refuses a caller that does not grant the red-unreviewed report its read of check runs', () =>
      red((t) => { extra(t); t.edit(TICK, (d) => { delete (d as Caller).permissions!.checks; }); }, 'needs checks: read'));
    it('refuses a caller that does not grant the pre-filter its read of issues', () =>
      red((t) => { extra(t); t.edit(TICK, (d) => { delete (d as Caller).permissions!.issues; }); }, 'needs issues: read'));
    it('refuses a caller that passes the tick budget, which is the lane\'s constant, not a setting', () =>
      red((t) => { extra(t); t.edit(TICK, (d) => { (job(d).with as Record<string, string>).budget = '${{ inputs.budget }}'; }); }, 'passes `budget`, which the Kanon lane agent-lead-reconcile does not declare'));
  });

  describe('the dispatch-sweep lane (plan 0004 step 9)', () => {
    const SWEEP = '.github/workflows/agent-dispatch-sweep.yml';
    const extra = (t: Tree) => t.write(SWEEP, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-dispatch-sweep.yml'), 'utf8'));
    it('accepts the caller, run as the Lead the register lists, under 40 lines and naming no cloud or environment', () => {
      const t = adopter();
      extra(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
      const text = readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-dispatch-sweep.yml'), 'utf8');
      expect(text.trimEnd().split('\n').length).toBeLessThan(40);
      expect(text).not.toMatch(/aws|environment:|role-to-assume|QA_DYNAMO/i);
    });
    it('refuses a caller that does not grant the store job its OIDC token: GitHub would not start the lane', () =>
      red((t) => { extra(t); t.edit(SWEEP, (d) => { delete (d as Caller).permissions!['id-token']; }); }, 'needs id-token: write'));
    it('refuses a caller that maps the Claude token: the sweep runs no model', () =>
      red((t) => {
        extra(t);
        t.edit(SWEEP, (d) => { (job(d).secrets as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN = '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'; });
      }, 'the Kanon lane agent-dispatch-sweep takes exactly [LEAD_APP_ID,LEAD_APP_PRIVATE_KEY]'));
    it('refuses a caller that passes apply as a setting', () =>
      red((t) => { extra(t); t.edit(SWEEP, (d) => { (job(d).with as Record<string, string>).apply = 'true'; }); }, 'passes `apply: true`'));
  });

  describe('the digest lanes (plan 0004 step 10)', () => {
    const DAILY = '.github/workflows/agent-project-digest.yml';
    const WEEKLY = '.github/workflows/agent-weekly-digest.yml';
    const extra = (t: Tree, rel: string) => t.write(rel, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra', rel.split('/').pop()!), 'utf8'));
    it('accepts both callers, which run as no App', () => {
      const t = adopter();
      extra(t, DAILY);
      extra(t, WEEKLY);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('6 lane caller(s) pass');
    });
    it('refuses a daily caller that does not grant the health job its issue writes', () =>
      red((t) => { extra(t, DAILY); t.edit(DAILY, (d) => { (d as Caller).permissions!.issues = 'read'; }); }, 'needs issues: write'));
    it('refuses a daily caller that does not grant the health job its read of runs', () =>
      red((t) => { extra(t, DAILY); t.edit(DAILY, (d) => { delete (d as Caller).permissions!.actions; }); }, 'needs actions: read'));
    it('refuses a caller that does not map the webhook under its fixed name (decision 7)', () =>
      red((t) => {
        extra(t, WEEKLY);
        t.edit(WEEKLY, (d) => {
          const secrets = job(d).secrets as Record<string, string>;
          delete secrets.DIGEST_WEBHOOK;
          secrets.SLACK_RELEASE_WEBHOOK = '${{ secrets.SLACK_RELEASE_WEBHOOK }}';
        });
      }, 'the Kanon lane agent-weekly-digest takes exactly [CLAUDE_CODE_OAUTH_TOKEN,DIGEST_WEBHOOK]'));
    it('refuses a caller that passes `dry_run` as a setting rather than its own input', () =>
      red((t) => { extra(t, WEEKLY); t.edit(WEEKLY, (d) => { (job(d).with as Record<string, string>).dry_run = 'true'; }); }, 'passes `dry_run: true`'));
  });

  describe('the code-audit lane (plan 0004 step 11)', () => {
    const AUDIT = '.github/workflows/agent-code-audit.yml';
    const STACK = 'docs/qa/stack.md';
    const extra = (t: Tree) => {
      t.write(AUDIT, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-code-audit.yml'), 'utf8'));
      t.write(REGISTER, `${t.read(REGISTER)}| Explorer | \`example-explorer\` | Read | Read & write | Read | No access |\n`);
    };
    it('accepts the caller, run as the Explorer the register lists, under 40 lines and naming no cloud or environment', () => {
      const t = adopter();
      extra(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
      const text = readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-code-audit.yml'), 'utf8');
      expect(text.trimEnd().split('\n').length).toBeLessThan(40);
      expect(text).not.toMatch(/aws|environment:|role-to-assume|QA_DYNAMO/i);
    });
    it('refuses a caller that does not grant the store jobs their OIDC token', () =>
      red((t) => { extra(t); t.edit(AUDIT, (d) => { delete (d as Caller).permissions!['id-token']; }); }, 'needs id-token: write'));
    it('refuses a caller that does not grant the delete job its artifact write', () =>
      red((t) => { extra(t); t.edit(AUDIT, (d) => { (d as Caller).permissions!.actions = 'read'; }); }, 'needs actions: write'));
    it('refuses a caller without the stack document the prompt reads', () =>
      red((t) => { extra(t); t.rm(STACK); }, 'is missing; the Kanon lane(s) agent-code-audit'));
    it('refuses a malformed `## Code areas`, by name, whichever lanes are called', () =>
      red((t) => t.write(STACK, `${t.read(STACK)}\n## Code areas\n\n- \`src\` — code: the application\n`), 'a `code` area is a directory, so write `src/`'));
  });

  describe('each caller has its lane\'s file name, and CI is ci.yml (K-LAYOUT-18, kanon#207)', () => {
    const EXTRA = join(ROOT, 'tests/fixtures/lane-check/extra');
    const fixture = (lane: string) => readFileSync(join(EXTRA, lane), 'utf8');
    const reviewer = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-reviewer\` | Read | Read & write | Read & write | No access |\n`);
    /** A caller of `lane`, written at `.github/workflows/<file>` instead of its own name. */
    const at = (t: Tree, file: string, lane: string) => t.write(`.github/workflows/${file}`, fixture(lane));

    it('refuses a caller of the review lane named as Kanon names its own, `review.yml`', () =>
      red((t) => { reviewer(t); at(t, 'review.yml', 'agent-review.yml'); },
        'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at .github/workflows/agent-review.yml'));
    it('refuses a revise caller under another name: the reconciler lists that file\'s runs', () =>
      red((t) => { const body = t.read(IMPL); t.rm(IMPL); t.write('.github/workflows/implement-revise.yml', body); },
        'calls the Kanon lane agent-implement-revise, so it lives at .github/workflows/agent-implement-revise.yml'));
    it('refuses the project digest under the reference adopter\'s old name: the health check watches agent-*.yml', () =>
      red((t) => at(t, 'project-digest.yml', 'agent-project-digest.yml'),
        'calls the Kanon lane agent-project-digest, so it lives at .github/workflows/agent-project-digest.yml'));
    it('refuses the right name with the other extension', () =>
      red((t) => { const body = t.read(TRIAGE); t.rm(TRIAGE); t.write('.github/workflows/agent-triage.yaml', body); },
        'agent-triage.yaml,title=lane-check::calls the Kanon lane agent-triage, so it lives at .github/workflows/agent-triage.yml'));
    /** A reusable workflow at the lane's path: the lane itself, as only Kanon's own tree holds it. */
    const STUB_LANE = 'name: Review (Reviewer)\non:\n  workflow_call:\njobs:\n  review:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n';
    /** The two files that make a checkout Kanon's own source tree. */
    const kanonTree = (t: Tree) => {
      mkdirSync(join(t.dir, 'actions/lane-check'), { recursive: true });
      t.write('actions/lane-check/lane-check.sh', '#!/usr/bin/env bash\n');
      t.write('.github/workflows/agent-lane.yml', 'name: Agent lane\non:\n  workflow_call:\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n');
    };
    it('exempts a caller whose lane\'s path holds the lane itself, in Kanon\'s own tree', () => {
      const t = adopter();
      reviewer(t);
      kanonTree(t);
      at(t, 'review.yml', 'agent-review.yml');
      t.write('.github/workflows/agent-review.yml', STUB_LANE);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
    });
    // kanon#217, part 1: the exemption was any reusable workflow at the lane's path.
    it('does not exempt an adopter whose own reusable workflow has the lane\'s name', () =>
      red((t) => { reviewer(t); at(t, 'review.yml', 'agent-review.yml'); t.write('.github/workflows/agent-review.yml', STUB_LANE); },
        'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at .github/workflows/agent-review.yml'));
    it('needs both marks of Kanon\'s tree: lane-check\'s own script alone is not one', () =>
      red((t) => {
        reviewer(t);
        kanonTree(t);
        t.rm('.github/workflows/agent-lane.yml');
        at(t, 'review.yml', 'agent-review.yml');
        t.write('.github/workflows/agent-review.yml', STUB_LANE);
      }, 'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at'));
    it('needs both marks of Kanon\'s tree: a reusable spine alone is not one', () =>
      red((t) => {
        reviewer(t);
        kanonTree(t);
        t.rm('actions/lane-check/lane-check.sh');
        at(t, 'review.yml', 'agent-review.yml');
        t.write('.github/workflows/agent-review.yml', STUB_LANE);
      }, 'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at'));
    it('does not exempt a caller whose lane\'s path holds another caller, even in Kanon\'s tree', () =>
      red((t) => { reviewer(t); kanonTree(t); at(t, 'review.yml', 'agent-review.yml'); at(t, 'agent-review.yml', 'agent-review.yml'); },
        'review.yml,title=lane-check::calls the Kanon lane agent-review, so it lives at'));
    // kanon#217, part 2: a wrapper at the right path has its runs filed under its caller's name.
    it.each([
      ['as a key', (d: Record<string, unknown>) => { (d.on as Record<string, unknown>).workflow_call = null; }],
      ['as the only event', (d: Record<string, unknown>) => { d.on = 'workflow_call'; }],
      ['in a list', (d: Record<string, unknown>) => { d.on = ['workflow_dispatch', 'workflow_call']; }],
    ])('refuses a caller that is itself a reusable workflow (%s)', (_how, wrap) => {
      red((t) => { reviewer(t); at(t, 'agent-review.yml', 'agent-review.yml'); t.edit('.github/workflows/agent-review.yml', wrap); },
        'agent-review.yml,title=lane-check::calls the Kanon lane agent-review but is itself a reusable workflow');
    });
    it('refuses a review caller when the project has no ci.yml', () =>
      red((t) => { reviewer(t); at(t, 'agent-review.yml', 'agent-review.yml'); t.rm('.github/workflows/ci.yml'); },
        '.github/workflows/ci.yml,title=lane-check::is missing; the Kanon lane(s) agent-review read its runs by that file name (K-LAYOUT-18)'));
    it('refuses a reconciler caller when the project has no ci.yml', () =>
      red((t) => { at(t, 'agent-lead-reconcile.yml', 'agent-lead-reconcile.yml'); t.rm('.github/workflows/ci.yml'); },
        'is missing; the Kanon lane(s) agent-lead-reconcile read its runs'));
    it('asks for ci.yml only of a project that runs a lane reading it', () => {
      const t = adopter();
      t.rm('.github/workflows/ci.yml');
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
  });

  describe('the project-setup hook (§5)', () => {
    const HOOK = '.github/actions/project-setup/action.yml';
    it('refuses a missing hook', () => red((t) => t.rm(HOOK), 'the project-setup hook is missing'));
    it('refuses a hook that does not declare an input Kanon passes', () =>
      red((t) => t.edit(HOOK, (d) => { delete (d.inputs as Record<string, unknown>)['github-token']; }), 'does not declare the input `github-token`'));
    it('refuses a hook that is not a composite action', () =>
      red((t) => t.edit(HOOK, (d) => { (d.runs as Record<string, unknown>).using = 'node24'; }), 'must be a composite action'));
  });

  describe('the project documents the lanes read (K-LAYOUT-17, kanon#36)', () => {
    const STACK = 'docs/qa/stack.md';
    it('refuses a missing stack document, naming the lanes that read it', () =>
      red((t) => t.rm(STACK), /docs\/qa\/stack\.md,title=lane-check::is missing; the Kanon lane\(s\) [a-z-,]*agent-triage[a-z-,]* read it \(K-LAYOUT-17\)/));
    it('refuses a missing playbook a called lane reads', () =>
      red((t) => t.rm('docs/qa/triage-fix-playbook.md'), /triage-fix-playbook\.md,title=lane-check::is missing/));
    it('requires a playbook only when a called lane reads it', () => {
      const t = adopter();
      t.rm('docs/qa/explorer-playbook.md');
      expect(check(t).status).toBe(0);
    });
    it.each(['## Gates', '## Schema changes', '## Data isolation', '## Generated files'])('refuses a stack document without `%s`', (h) => {
      red((t) => t.write(STACK, t.read(STACK).replace(`${h}\n`, '')), `has the heading \`${h}\` 0 times`);
    });
    it('refuses a section written twice', () =>
      red((t) => t.write(STACK, `${t.read(STACK)}\n## Gates\n\nMore.\n`), 'has the heading `## Gates` 2 times'));
    it.each([
      ['trailing spaces', (x: string) => x.replace('## Gates\n', '## Gates  \n')],
      ['CRLF line ends', (x: string) => x.replace(/\n/g, '\r\n')],
      ['another case', (x: string) => x.replace('## Gates\n', '## gates\n')],
    ])('names a near miss written with %s, which looks present', (_, change) => {
      red((t) => t.write(STACK, change(t.read(STACK))), /has the heading `## Gates` 0 times \(1 more line\(s\) match it once trailing spaces, a CR and case are ignored: write it exactly\)/);
    });
    it('does not count a heading inside a fenced block', () =>
      red((t) => t.write(STACK, t.read(STACK).replace('## Data isolation\n', '```\n## Data isolation\n```\n')), 'has the heading `## Data isolation` 0 times'));
  });

  describe('the test-database declaration (K-LAYOUT-16, kanon#18)', () => {
    const DB = 'docs/qa/test-database.md';
    const STANDARD = readFileSync(join(ROOT, 'tests/fixtures/test-database/postgres', DB), 'utf8');
    it('accepts no declaration: the project has no database', () => {
      const t = adopter();
      t.rm(DB);
      expect(check(t).status).toBe(0);
    });
    it.each(['none', 'hook'])('accepts `%s`', (kind) => {
      const t = adopter();
      t.write(DB, STANDARD.replace('`hook`', `\`${kind}\``));
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses a kind Kanon does not know, with the block\'s own reason', () =>
      red((t) => t.write(DB, STANDARD.replace('`hook`', '`mysql`')), /test-database\.md,title=lane-check::declares `mysql`, which is not a kind Kanon knows.*\(K-LAYOUT-16\)/));
    it('refuses an engine named as the kind: the hook starts it, Kanon names none (K-LAYOUT-16)', () =>
      red((t) => t.write(DB, STANDARD.replace('`hook`', '`postgres`')), /declares `postgres`, which is not a kind Kanon knows.*Kanon names no engine/));
    it('refuses a declaration file that declares nothing', () =>
      red((t) => t.write(DB, '# Test database\n'), /has no `\*\*Test database:\*\* `<kind>`` line/));
    it('refuses two declarations', () =>
      red((t) => t.write(DB, `${STANDARD}**Test database:** \`none\`\n`), /has 2 `\*\*Test database:\*\*` lines/));
  });

  describe('the escalation and exemptions files, read by the library\'s own readers (kanon#153)', () => {
    const ESC = 'docs/qa/escalation-paths.md';
    const EXE = 'docs/qa/exemptions.md';
    // The fixture adopter carries both, well formed, so the whole-fixture case above passes them.
    const ESC_OK = readFileSync(join(FIXTURE, ESC), 'utf8');
    const EXE_OK = readFileSync(join(FIXTURE, EXE), 'utf8');
    it('leaves a missing file to the guard or lane that reads it', () => {
      const t = adopter();
      t.rm(ESC);
      t.rm(EXE);
      expect(check(t).status).toBe(0);
    });
    it('refuses an escalation file written before `## Pipeline code`, with the reader\'s own message', () =>
      red((t) => t.write(ESC, ESC_OK.replace(/## Pipeline code[\s\S]*?(?=## Bail list)/, '')), /escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md has no `## Pipeline code` heading \(K-LAYOUT-8\)/));
    it('refuses an escalation pattern that is not a regular expression', () =>
      red((t) => t.write(ESC, ESC_OK.replace('`^migrations/`', '`^migrations/(`')), /escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md:5/));
    it('refuses an exemptions file without `## Path mentions`', () =>
      red((t) => t.write(EXE, EXE_OK.replace(/## Path mentions[\s\S]*/, '')), /exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md has no `## Path mentions` heading/));
    it('refuses an exemptions entry listed twice', () =>
      red((t) => t.write(EXE, EXE_OK.replace('## Path mentions', '- `docs/projects/1.md` — old\n- `docs/projects/1.md` — old\n\n## Path mentions')), /exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md:6 repeats the entry/));
  });

  describe("the adoption record's reference-deploy declaration, read by the library's reader (K-LAYOUT-10, plan 0004 P6)", () => {
    const REC = 'docs/qa/adoption.md';
    const DECLARED = '## Choices\n\n- **Overseer:** `not installed`\n- **Reference environment:** `preview`\n- **Reference deploy workflow:** `deploy-preview.yml`\n- **Reference deploy job:** `ship`\n';
    const passes = (body: string | null) => {
      const t = adopter();
      if (body !== null) t.write(REC, body);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    };
    it('passes no record, a record that declares no reference environment, and a whole declaration', () => {
      passes(null);
      passes('# Adoption record\n\n## Choices\n\n- **Chat channel:** none yet.\n- **Overseer:** `not installed`\n');
      passes(`# Adoption record\n\n${DECLARED}`);
    });
    it('refuses a declaration missing its job, with the reader\'s own message', () =>
      red((t) => t.write(REC, `# Adoption record\n\n${DECLARED.replace(/^- \*\*Reference deploy job.*\n/m, '')}`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md declares the reference environment's deploy without `Reference deploy job`: declare all three, or none \(K-LAYOUT-10\)/));
    it('refuses a workflow written as a path', () =>
      red((t) => t.write(REC, `# Adoption record\n\n${DECLARED.replace('`deploy-preview.yml`', '`.github/workflows/deploy-preview.yml`')}`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:7: `\.github\/workflows\/deploy-preview\.yml` isn't a workflow file name/));
  });

  describe("the adoption record's weekly digest audience (K-LAYOUT-10, kanon#218)", () => {
    const REC = 'docs/qa/adoption.md';
    const AUDIENCE = '- **Weekly digest audience:** a co-founder tracking runway\n';
    it('passes a declared audience beside the reference deploy', () => {
      const t = adopter();
      t.write(REC, `# Adoption record\n\n## Choices\n\n${AUDIENCE}- **Overseer:** \`not installed\`\n- **Reference environment:** \`preview\`\n- **Reference deploy workflow:** \`deploy-preview.yml\`\n- **Reference deploy job:** \`ship\`\n`);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses one declared twice, by name', () =>
      red((t) => t.write(REC, `# Adoption record\n\n## Choices\n\n${AUDIENCE}${AUDIENCE}`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:6 repeats `Weekly digest audience`, already declared on line 5 \(K-LAYOUT-10\)/));
    it('refuses one outside `## Choices`, by name', () =>
      red((t) => t.write(REC, `# Adoption record\n\n${AUDIENCE}\n## Choices\n`),
        /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:3 declares the weekly digest's audience outside `## Choices`/));
  });

  describe('the Overseer lane, and the adoption record saying whether it is installed (plan 0004 step 13)', () => {
    const OVERSEER = '.github/workflows/agent-overseer.yml';
    const REC = 'docs/qa/adoption.md';
    const record = (value: string | null) => `# Adoption record\n\n## Choices\n\n- **Chat channel:** none yet.\n${value === null ? '' : `- **Overseer:** \`${value}\`\n`}`;
    const install = (t: Tree, value: string | null = 'installed') => {
      t.write(OVERSEER, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-overseer.yml'), 'utf8'));
      t.write(REGISTER, `${t.read(REGISTER)}| Overseer | \`example-overseer\` | Read | Read & write | Read | No access |\n`);
      t.write('docs/qa/overseer-playbook.md', '# Overseer playbook\n\n## Liveness queries\n\n## Backlog dynamics\n\n## Capability review\n');
      t.write('docs/qa/capability-ledger.md', '# Capability ledger\n');
      t.write(REC, record(value));
    };
    it('accepts the caller, run as the Overseer the register lists, with a record that says it is installed', () => {
      const t = adopter();
      install(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
      const text = readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-overseer.yml'), 'utf8');
      expect(text.trimEnd().split('\n').length).toBeLessThan(40);
      expect(text).not.toMatch(/aws|environment:|role-to-assume|QA_DYNAMO/i);
    });
    it('accepts a record that says it is not installed, with no caller', () => {
      const t = adopter();
      t.write(REC, record('not installed'));
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses a record that does not say whether the Overseer is installed', () =>
      red((t) => t.write(REC, record(null)), /adoption\.md,title=lane-check::docs\/qa\/adoption\.md doesn't say whether the Overseer is installed/));
    it('refuses a record that does not say, even beside a caller', () =>
      red((t) => install(t, null), "doesn't say whether the Overseer is installed"));
    it('refuses `installed` with no caller', () =>
      red((t) => t.write(REC, record('installed')), 'says the Overseer is `installed`, but no workflow calls its lane'));
    it('refuses `not installed` beside a caller', () =>
      red((t) => install(t, 'not installed'), 'says the Overseer is `not installed`, but a workflow calls its lane'));
    it('refuses a caller with no record at all', () =>
      red((t) => { install(t); t.rm(REC); }, 'is missing, and a workflow calls the Overseer\'s lane'));
    it('refuses a value it does not know, by line', () =>
      red((t) => t.write(REC, record('yes')), /adoption\.md:6: `Overseer` is `yes`; write `installed` or `not installed`/));
    it('refuses a caller that does not grant the store job its OIDC token', () =>
      red((t) => { install(t); t.edit(OVERSEER, (d) => { delete (d as Caller).permissions!['id-token']; }); }, 'needs id-token: write'));
    it('refuses a caller without the playbook or the capability ledger the prompt reads', () => {
      red((t) => { install(t); t.rm('docs/qa/overseer-playbook.md'); }, 'is missing; the Kanon lane(s) agent-overseer');
      red((t) => { install(t); t.rm('docs/qa/capability-ledger.md'); }, 'is missing; the Kanon lane(s) agent-overseer');
    });
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
    // Dependabot applies its default 3-day cooldown to an entry that sets none, and Kanon's
    // own entry held 13 releases back that way (#233): no `cooldown` is not no cooldown.
    it('refuses an entry with no cooldown, which Dependabot gives its default', () =>
      red((t) => t.edit(DEP, (d) => { delete (d as Dep).updates[0]!.cooldown; }), 'excludes yedeya-labs/kanon* from its cooldown'));
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
    expect(action.runs.steps).toHaveLength(2);
    expect(action.runs.steps[1]?.run).toBe('bash "$GITHUB_ACTION_PATH/lane-check.sh"');
    expect(action.runs.steps[1]?.env).toEqual({ ACTION_REF: '${{ github.action_ref }}' });
  });

  it("puts Kanon's own Node on the PATH first, for the library's readers (kanon#110, kanon#153)", () => {
    expect((action.runs.steps[0] as { uses?: string }).uses).toBe('$/actions/kanon-path');
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
