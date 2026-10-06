import { describe, expect, it } from 'vitest';
import { adopter, check, red, type Tree, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the project-setup hook, the App register and the Dependabot
 * entry.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
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
      red((t) => t.write(REG, t.read(REG).replace('`example-author`', 'example-author')), 'gives the role Implementer no App slug in backticks'));

    // The optional `Persona` column (plan 0005 §3.3): blank is the role's name, and a
    // malformed persona fails by name, on the pull request that wrote it.
    const withPersonas = (t: Tree, implementer: string, lead = '') => t.write(REG, t.read(REG)
      .replace('| Role | App slug |', '| Role | App slug | Persona |').replace(/^\|---\|/m, '|---|---|')
      .replace(/^(\| Implementer \| [^|]+\|)/m, `$1 ${implementer} |`).replace(/^(\| Lead \| [^|]+\|)/m, `$1 ${lead} |`));
    it('passes a register with a Persona column, declared or blank', () => {
      const t = adopter();
      withPersonas(t, 'The Builder', '');
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it('refuses a malformed persona, by row and name', () =>
      red((t) => withPersonas(t, '<b>Builder</b>'), /agent-identities\.md:\d+: the Implementer row's persona `<b>Builder<\/b>` is malformed/));
    it('refuses a persona that is another role\'s name', () =>
      red((t) => withPersonas(t, 'Reviewer'), "the Implementer row's persona `Reviewer` is another role's name"));
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
