import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, adopter, check, red, defaulted, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the scheduled lanes: the reconciler, dispatch-sweep,
 * digest, code-audit and Overseer lanes.
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
      }, 'the Kanon lane agent-dispatch-sweep takes exactly [AUTHOR_APP_ID,AUTHOR_APP_PRIVATE_KEY]'));
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
      t.write(REGISTER, `${t.read(REGISTER)}| Explorer | \`example-author\` | Read | Read & write | Read | No access |\n`);
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
    it('refuses a caller that does not grant the store job its OIDC token', () =>
      red((t) => { install(t); t.edit(OVERSEER, (d) => { delete (d as Caller).permissions!['id-token']; }); }, 'needs id-token: write'));
    it("reads a missing Overseer playbook as Kanon's baseline, and refuses a missing capability ledger, which has no default", () => {
      defaulted((t) => { install(t); t.rm('docs/qa/overseer-playbook.md'); }, "docs/qa/overseer-playbook.md,title=lane-check::doesn't exist, so the Kanon lane(s) agent-overseer read Kanon's baseline for it");
      red((t) => { install(t); t.rm('docs/qa/capability-ledger.md'); }, 'is missing; the Kanon lane(s) agent-overseer');
    });
  });
});
