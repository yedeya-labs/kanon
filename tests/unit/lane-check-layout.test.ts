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

    // Issue #990: an App that isn't an agent has a row under the `Other App` role (K-AGENT-3).
    const withOthers = (t: Tree, ...slugs: string[]) =>
      t.write(REG, `${t.read(REG).trimEnd()}\n${slugs.map((s) => `| Other App | \`${s}\` | Read | Read & write | No access | No access |`).join('\n')}\n`);
    it('[REG-1] passes a register holding several Other App rows, with no finding', () => {
      const t = adopter();
      withOthers(t, 'example-reporter', 'example-scanner');
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toMatch(/::(error|warning|notice) file=docs\/qa\/agent-identities\.md/);
    });
    it('[REG-2] refuses an Other App row that names an agent App\'s slug, by both rows', () =>
      red((t) => withOthers(t, 'example-author'), /file=docs\/qa\/agent-identities\.md,title=lane-check::docs\/qa\/agent-identities\.md:7: the Other App row names `example-author`, the App the Implementer row names \(docs\/qa\/agent-identities\.md:5\)/));
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

    // kanon#1105: Dependabot reads `.github/workflows/` from `/`, and a composite action only from
    // the action's own directory. An adopter's project-setup hook that pinned Kanon stayed at the
    // old release on every upgrade pull request, which this check's one-version rule then failed.
    const HOOK = '.github/actions/project-setup/action.yml';
    const pinHook = (t: Tree) => t.edit(HOOK, (d) => {
      (d.runs as { steps: unknown[] }).steps.unshift({ uses: 'yedeya-labs/kanon/actions/kanon-path@v1.2.3' });
    });
    // The finding names the entry it means, by its place in `updates` and what tells it apart
    // (kanon#1111): with more than one entry that proposes Kanon, "the Kanon entry" is ambiguous.
    const stuck = (at: number, ...said: string[]) => `its Kanon entry at \`updates[${at}]\` (${said.map((x) => `\`${x}\``).join(', ')}) doesn't reach ${HOOK}`;
    const directories = (dirs: string[]) => (t: Tree) => t.edit(DEP, (d) => {
      const u = (d as Dep).updates[0]!;
      delete u.directory;
      u.directories = dirs;
    });
    it("refuses an entry that doesn't reach a composite action pinning Kanon, naming it and the line that does (kanon#1105)", () => {
      const r = red(pinHook, stuck(0, 'directory: /'));
      expect(r.out).toContain('directories: ["/", "/.github/actions/*"]');
      expect(r.out).not.toMatch(/Kanon references pin .*,/);
    });
    it("accepts the action's directories, by glob or written out", () => {
      for (const dirs of [['/', '/.github/actions/*'], ['/', '/.github/actions/project-setup']]) {
        const t = adopter();
        pinHook(t);
        directories(dirs)(t);
        const r = check(t);
        expect(r.status, r.out).toBe(0);
      }
    });
    it('refuses directories that name another action', () =>
      red((t) => { pinHook(t); directories(['/', '/.github/actions/notify'])(t); }, stuck(0, 'directories: ["/","/.github/actions/notify"]')));
    // Dependabot groups an entry's updates into one pull request, across its directories, never
    // across entries: two entries open two pull requests, each with a mix of pins.
    it("refuses a second entry for the action's directory, which opens a pull request of its own", () =>
      red((t) => {
        pinHook(t);
        t.edit(DEP, (d) => { (d as Dep).updates.push({ ...(d as Dep).updates[0]!, directory: '/.github/actions/project-setup' }); });
      }, stuck(0, 'directory: /')));
    it("refuses a second Kanon entry that doesn't reach it, though the first does: each opens its own upgrade pull request", () =>
      red((t) => {
        pinHook(t);
        directories(['/', '/.github/actions/*'])(t);
        t.edit(DEP, (d) => {
          const u: Record<string, unknown> = { ...(d as Dep).updates[0]!, directory: '/', 'target-branch': 'release' };
          delete u.directories;
          (d as Dep).updates.push(u);
        });
      }, stuck(1, 'target-branch: release', 'directory: /')));
    // kanon#1111: an entry is held to the reach when it would open a Kanon upgrade pull request,
    // which needs no cooldown, `ci` prefix or Kanon group, the same set `kanon doctor` holds.
    const second = (more: Record<string, unknown>, drop: string[] = []) => (t: Tree) => {
      pinHook(t);
      directories(['/', '/.github/actions/*'])(t);
      t.edit(DEP, (d) => {
        const u: Record<string, unknown> = { ...(d as Dep).updates[0]!, 'target-branch': 'release', ...more };
        for (const k of ['directories', ...drop]) delete u[k];
        (d as Dep).updates.push(u);
      });
    };
    it("refuses a second entry that doesn't reach a pin, though it lacks a cooldown or the `ci` prefix (kanon#1111)", () => {
      red(second({ directory: '/', allow: [{ 'dependency-name': 'yedeya-labs/kanon*' }] }, ['cooldown']), stuck(1, 'target-branch: release', 'directory: /'));
      red(second({ directory: '/', 'commit-message': { prefix: 'build' } }), stuck(1, 'target-branch: release', 'directory: /'));
    });
    it("refuses a second entry with no Kanon group that doesn't reach a pin: it still proposes Kanon, alone (kanon#1111)", () =>
      red(second({ directory: '/' }, ['groups', 'cooldown', 'commit-message']), stuck(1, 'target-branch: release', 'directory: /')));
    it('passes a second entry that proposes no Kanon upgrade: it reaches no pin, allows no Kanon dependency, or ignores Kanon (kanon#1111)', () => {
      for (const more of [
        { directory: '/infra' },
        { directory: '/', allow: [{ 'dependency-name': 'actions/*' }] },
        { directory: '/', ignore: [{ 'dependency-name': 'yedeya-labs/kanon*' }] },
      ]) {
        const t = adopter();
        second(more)(t);
        const r = check(t);
        expect(r.status, `${JSON.stringify(more)}\n${r.out}`).toBe(0);
      }
    });
    // kanon#1126: Dependabot opens an update no group takes in as a pull request of its own, per
    // dependency and per directory, and each Kanon lane's workflow is a dependency of its own, so
    // an entry that reaches every pin but groups none of Kanon still splits the upgrade.
    const ungrouped = (at: number, ...said: string[]) => `its Kanon entry at \`updates[${at}]\` (${said.map((x) => `\`${x}\``).join(', ')}) proposes Kanon upgrades but puts them in no one group`;
    const RELEASE = ungrouped(1, 'target-branch: release', 'directories: ["/","/.github/actions/*"]');
    // A second entry that reaches every pin, with `groups` and `ignore` as given (undefined drops it).
    const reaching = (more: Record<string, unknown>) => (t: Tree) => {
      pinHook(t);
      directories(['/', '/.github/actions/*'])(t);
      t.edit(DEP, (d) => {
        const u: Record<string, unknown> = { ...(d as Dep).updates[0]!, 'target-branch': 'release', ...more };
        for (const [k, v] of Object.entries(u)) if (v === undefined) delete u[k];
        (d as Dep).updates.push(u);
      });
    };
    it('refuses a second entry that reaches every pin but groups none of Kanon, naming the `kanon` group as the fix (kanon#1126)', () => {
      const r = red(reaching({ groups: undefined }), RELEASE);
      expect(r.out).toContain('Add the `kanon` group `kanon init` writes');
      expect(r.out).toContain('kanon: { patterns: ["yedeya-labs/kanon*"] }');
      expect(r.out).not.toContain("doesn't reach");
    });
    it("refuses a group that takes in Kanon's actions but not its lanes' workflows (kanon#1126)", () =>
      red(reaching({ groups: { kanon: { patterns: ['yedeya-labs/kanon'] } } }), RELEASE));
    it("refuses the first entry too, when another group takes in Kanon's lanes before its own (kanon#1126)", () =>
      red((t) => t.edit(DEP, (d) => {
        const u = (d as Dep).updates[0]!;
        u.groups = { lanes: { patterns: ['*/.github/workflows/*'] }, ...(u.groups as object) };
      }), ungrouped(0, 'directory: /')));
    it('passes a second entry that groups Kanon, by the `kanon` group or a catch-all, or ignores it (kanon#1126)', () => {
      for (const more of [
        { groups: { kanon: { patterns: ['yedeya-labs/kanon*'] } } },
        { groups: { all: { patterns: ['*'] } } },
        { groups: undefined, ignore: [{ 'dependency-name': 'yedeya-labs/kanon*' }] },
      ]) {
        const t = adopter();
        reaching(more)(t);
        const r = check(t);
        expect(r.status, `${JSON.stringify(more)}\n${r.out}`).toBe(0);
      }
    });
    it('passes a composite action that pins no Kanon reference, which the entry for `/` leaves alone', () => {
      const t = adopter();
      expect(t.read(HOOK)).not.toContain('yedeya-labs/kanon/');
      expect(t.read(DEP)).toContain('directory: /');
      expect(check(t).status).toBe(0);
    });
    it('refuses a Kanon reference in a file Dependabot updates under no directory', () =>
      red((t) => { directories(['/', '/.github/**'])(t); t.write('.github/kanon.yml', 'uses: yedeya-labs/kanon/actions/kanon-path@v1.2.3\n'); },
        /file=\.github\/kanon\.yml,title=lane-check::pins Kanon, but Dependabot updates no such file/));
  });
});
