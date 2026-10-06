import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, TRIAGE, adopter, check, red, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the lanes that run as another role, and the review, verify-
 * acs, explore, lead and Merger lanes.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe('a lane that runs as another role (§8)', () => {
    // The merge-reconcile lane runs as the Reviewer, whom the fixture's register does not list.
    const MERGE = '.github/workflows/agent-merge-reconcile.yml';
    const addCaller = (t: Tree) => t.write(MERGE, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-merge-reconcile.yml'), 'utf8'));
    it('refuses its caller while the register has no row for that role', () =>
      red(addCaller, 'lists the role Reviewer 0 times'));
    it('accepts it once the role has a row', () => {
      const t = adopter();
      addCaller(t);
      t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-judge\` | Read | Read & write | Read & write | No access |\n`);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('5 lane caller(s) pass');
    });
  });

  describe('the review and verify-acs lanes (step 4)', () => {
    const REVIEW = '.github/workflows/agent-review.yml';
    const VERIFY = '.github/workflows/agent-verify-acs.yml';
    const extra = (t: Tree, f: string) => t.write(f, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra', f.split('/').pop()!), 'utf8'));
    const roles = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-judge\` | Read | Read & write | Read & write | No access |\n| Explorer | \`example-author\` | Read | Read & write | Read | No access |\n`);
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
    const explorer = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Explorer | \`example-author\` | Read | Read & write | Read | No access |\n`);
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
    const merger = (t: Tree) => t.write(REGISTER, `${t.read(REGISTER)}| Merger | \`example-judge\` | Read & write | Read & write | Read & write | No access |\n`);
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
      }, 'the Kanon lane agent-merge takes exactly [JUDGE_APP_ID,JUDGE_APP_PRIVATE_KEY]'));
  });
});
