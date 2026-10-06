import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, TRIAGE, adopter, check, red, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the lead, lead-split, rebase and Merger lanes.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
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
