import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, adopter, check, red, defaulted, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the reconciler, dispatch-sweep and Overseer lanes.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
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
      }, 'the Kanon lane agent-dispatch-sweep takes exactly [AUTHOR_APP_ID,AUTHOR_APP_PRIVATE_KEY,QA_STORE_BUCKET,QA_STORE_ROLE_ARN], and may leave out [QA_STORE_BUCKET,QA_STORE_ROLE_ARN]'));
    // kanon#433: the QA store's secrets are the lane's `# OPTIONAL SECRET:`s. A caller maps both
    // once its repository has a store hook, or leaves them out; its App's optional secrets it
    // still maps, so the soft skip stays a skip and never a caller that forgot them.
    it('accepts a caller that maps the QA store\'s secrets, or leaves them out', () => {
      const without = adopter();
      extra(without);
      expect(check(without).status).toBe(0);
      const t = adopter();
      extra(t);
      t.edit(SWEEP, (d) => {
        const s = job(d).secrets as Record<string, string>;
        s.QA_STORE_ROLE_ARN = '${{ secrets.QA_STORE_ROLE_ARN }}';
        s.QA_STORE_BUCKET = '${{ secrets.QA_STORE_BUCKET }}';
      });
      expect(check(t).status).toBe(0);
    });
    it('still refuses a caller that leaves out an optional secret the lane does not mark', () =>
      red((t) => { extra(t); t.edit(SWEEP, (d) => { delete (job(d).secrets as Record<string, string>).AUTHOR_APP_ID; }); },
        'the Kanon lane agent-dispatch-sweep takes exactly [AUTHOR_APP_ID,AUTHOR_APP_PRIVATE_KEY,QA_STORE_BUCKET,QA_STORE_ROLE_ARN]'));
    it('refuses a caller that passes apply as a setting', () =>
      red((t) => { extra(t); t.edit(SWEEP, (d) => { (job(d).with as Record<string, string>).apply = 'true'; }); }, 'passes `apply: true`'));
  });

  describe('the Overseer lane, and the adoption record saying whether it is installed (plan 0004 step 13)', () => {
    const OVERSEER = '.github/workflows/agent-overseer.yml';
    const REC = 'docs/qa/adoption.md';
    const record = (value: string | null) => `# Adoption record\n\n## Choices\n\n- **Chat channel:** none yet.\n${value === null ? '' : `- **Overseer:** \`${value}\`\n`}`;
    const install = (t: Tree, value: string | null = 'installed') => {
      t.write(OVERSEER, readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-overseer.yml'), 'utf8'));
      t.write(REGISTER, `${t.read(REGISTER)}| Overseer | \`example-author\` | Read | Read & write | Read | No access |\n`);
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
    it("reads a record that does not say as Kanon's default, `not installed`, and says so (plan 0005 §5.2)", () =>
      defaulted((t) => t.write(REC, record(null)), /::notice file=docs\/qa\/adoption\.md,title=lane-check::docs\/qa\/adoption\.md doesn't say whether the Overseer is installed, so Kanon's default applies: the Overseer is `not installed`/));
    it('reads no record as the default too', () =>
      defaulted((t) => t.rm(REC), /::notice file=docs\/qa\/adoption\.md,title=lane-check::docs\/qa\/adoption\.md doesn't exist, so Kanon's default applies: the Overseer is `not installed`/));
    it('refuses a record that does not say beside a caller: the default contradicts it', () =>
      red((t) => install(t, null), "doesn't say whether the Overseer is installed, so it reads as Kanon's default, `not installed`, but a workflow calls the Overseer's lane"));
    it('refuses `installed` with no caller', () =>
      red((t) => t.write(REC, record('installed')), 'says the Overseer is `installed`, but no workflow calls its lane'));
    it('refuses `not installed` beside a caller', () =>
      red((t) => install(t, 'not installed'), 'says the Overseer is `not installed`, but a workflow calls its lane'));
    it('refuses a caller with no record at all', () =>
      red((t) => { install(t); t.rm(REC); }, "doesn't exist, so it reads as Kanon's default, `not installed`, but a workflow calls the Overseer's lane"));
    it('refuses a value it does not know, by line', () =>
      red((t) => t.write(REC, record('yes')), /adoption\.md:6: `Overseer` is `yes`; write `installed` or `not installed`/));
    // kanon#499: the telemetry store's table and region are the lane's caller settings, which a
    // caller reading a self-hosted store sets to a plain value.
    const setting = (t: Tree, w: Record<string, string>) => t.edit(OVERSEER, (d) => { (job(d) as Record<string, unknown>).with = w; });
    it('accepts the telemetry table and region set to plain values, the lane\'s caller settings', () => {
      const t = adopter();
      install(t);
      setting(t, { 'telemetry-table': 'acme-telemetry', 'telemetry-region': 'us-east-2' });
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses a setting that is an expression or holds other characters', () => {
      red((t) => { install(t); setting(t, { 'telemetry-table': '${{ vars.TABLE }}' }); }, /sets `telemetry-table: \$\{\{ vars\.TABLE \}\}`; a setting is a plain value/);
      red((t) => { install(t); setting(t, { 'telemetry-region': 'eu central 1' }); }, /sets `telemetry-region: eu central 1`; a setting is a plain value/);
    });
    it('refuses a plain value for an input the lane does not mark as a setting', () =>
      red((t) => { install(t); setting(t, { smoke: 'x' }); }, 'passes `smoke`'));
    it('refuses a caller that does not grant the store job its OIDC token', () =>
      red((t) => { install(t); t.edit(OVERSEER, (d) => { delete (d as Caller).permissions!['id-token']; }); }, 'needs id-token: write'));
    const watchOn = (t: Tree) => t.write(REC, `${record('installed')}- **Capability watch:** \`on\`\n`);
    it("reads a missing Overseer playbook as Kanon's baseline, and refuses a missing capability ledger where the capability watch is on, which has no default", () => {
      defaulted((t) => { install(t); t.rm('docs/qa/overseer-playbook.md'); }, "docs/qa/overseer-playbook.md,title=lane-check::doesn't exist, so the Kanon lane(s) agent-overseer read Kanon's baseline for it");
      red((t) => { install(t); watchOn(t); t.rm('docs/qa/capability-ledger.md'); }, 'is missing; the Kanon lane(s) agent-overseer');
    });
    // kanon#477: the capability watch is off by default, and off needs no ledger.
    it('needs no capability ledger where the record leaves the capability watch off, and says so', () => {
      defaulted((t) => { install(t); t.rm('docs/qa/capability-ledger.md'); }, /::notice file=docs\/qa\/capability-ledger\.md,title=lane-check::doesn't exist, which is fine: the adoption record doesn't turn the capability watch on/);
      defaulted((t) => { install(t); t.write(REC, `${record('installed')}- **Capability watch:** \`off\`\n`); t.rm('docs/qa/capability-ledger.md'); }, /doesn't turn the capability watch on/);
    });
    it('refuses a malformed capability watch, by line, and then holds the ledger as needed', () => {
      red((t) => { install(t); t.write(REC, `${record('installed')}- **Capability watch:** \`yes\`\n`); }, /`Capability watch` is `yes`; write `on` or `off`/);
      red((t) => { install(t); t.write(REC, `${record('installed')}- **Capability watch:** \`yes\`\n`); t.rm('docs/qa/capability-ledger.md'); }, 'is missing; the Kanon lane(s) agent-overseer');
    });
  });
});
