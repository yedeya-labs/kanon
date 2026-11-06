import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { callerFile, loadRequirements } from '../../cli/callers.mjs';
import { ROOT, REGISTER, TRIAGE, adopter, check, red, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): a lane that runs as another role, and the review, verify-
 * acs and explore lanes.
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
    // #1652: the caller kanon init writes takes `ready_for_review`; one written before keeps its
    // old list. A warning at the release the caller pins, never a failure.
    it('warns of a review caller whose pull_request_target lacks a type the template lists, at its pin only', () => {
      const old = (t: Tree) => { extra(t, REVIEW); roles(t); t.edit(REVIEW, (d) => { (d.on as Record<string, { types: string[] }>).pull_request_target!.types = ['opened', 'labeled']; }); };
      const t = adopter();
      old(t);
      const r = check(t, { ACTION_REF: 'v1.2.3' });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("::warning file=.github/workflows/agent-review.yml,title=lane-check::its `pull_request_target` types don't list `ready_for_review`");
      expect(r.out).toContain('Write `types: [opened, labeled, ready_for_review]` under `pull_request_target:`');
      // Not judged against another release's template.
      const other = adopter();
      old(other);
      expect(check(other).out).not.toContain("types don't list");
      // The caller as kanon init writes it is quiet.
      const now = adopter();
      extra(now, REVIEW);
      roles(now);
      expect(check(now, { ACTION_REF: 'v1.2.3' }).out).not.toContain("types don't list");
    });
    it("names on its CALLER TYPES lines exactly the types the caller template writes, for each typed event of the template's", () => {
      const lines = readFileSync(join(ROOT, REVIEW), 'utf8').split('\n').filter((l) => l.startsWith('# CALLER TYPES: ')).map((l) => l.slice('# CALLER TYPES: '.length).trim().split(/\s+/));
      const template = parse(callerFile('agent-review', loadRequirements().lanes['agent-review']!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'main' })) as { on: Record<string, { types?: string[] }> };
      const typed = Object.entries(template.on).filter(([e, t]) => e !== 'workflow_run' && Array.isArray(t?.types)).map(([e, t]) => [e, ...t.types!]);
      expect(lines).toEqual(typed);
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
});
