import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, adopter, check, red, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the digest and code-audit lanes.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
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
});
