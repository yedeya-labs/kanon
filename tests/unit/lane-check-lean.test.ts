import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, adopter, check, red, type Tree, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the lean installation, which leaves out every declaration
 * with a default.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe('the lean installation: every omitted declaration is its documented default (plan 0005 step L8, §5.2)', () => {
    const STACK = 'docs/qa/stack.md';
    const REC = 'docs/qa/adoption.md';
    /** Only the stack document's `## Gates`, the App register and the adoption record's people. */
    const lean = (t: Tree) => {
      for (const f of readdirSync(join(t.dir, 'docs/qa'))) {
        if (f !== 'agent-identities.md') t.rm(`docs/qa/${f}`);
      }
      t.write(STACK, '# Stack\n\n## Gates\n\n1. `make check`\n');
      t.write(REC, '# Adoption record\n\n## People\n\n- **Owner:** Ada Lovelace\n- **Maintainer:** Ada Lovelace\n- **Stakeholder:** Ada Lovelace\n');
    };
    it('passes a repository that has only those, and names each default it takes', () => {
      const t = adopter();
      lean(t);
      expect(readdirSync(join(t.dir, 'docs/qa')).sort()).toEqual(['adoption.md', 'agent-identities.md', 'stack.md']);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toMatch(/::error/);
      const notices = r.out.split('\n').filter((l) => l.startsWith('::notice'));
      for (const named of [
        /file=docs\/qa\/triage-fix-playbook\.md,title=lane-check::doesn't exist, so the Kanon lane\(s\) .* read Kanon's baseline/,
        /file=docs\/qa\/stack\.md,title=lane-check::has no `## Schema changes`, so Kanon's default applies: the project has no schema/,
        /file=docs\/qa\/stack\.md,title=lane-check::has no `## Data isolation`, so Kanon's default applies: the project has nothing to isolate/,
        /file=docs\/qa\/stack\.md,title=lane-check::has no `## Generated files`, so Kanon's default applies: the project has no generated files/,
        /file=docs\/qa\/stack\.md,title=lane-check::docs\/qa\/stack\.md declares no `## Code areas`, so Kanon's default applies: the code is the whole repository/,
        /file=docs\/qa\/escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md doesn't exist, so Kanon's default applies: only the pipeline's own paths escalate/,
        /file=docs\/qa\/exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md doesn't exist, so Kanon's default applies: nothing is exempt/,
        /file=docs\/qa\/adoption\.md,title=lane-check::docs\/qa\/adoption\.md doesn't say whether the Overseer is installed, so Kanon's default applies: the Overseer is `not installed`/,
      ]) expect(notices.some((l) => named.test(l)), `${named}\n${r.out}`).toBe(true);
      expect(r.out).toContain(`4 lane caller(s) pass, with ${notices.length} documented default(s) taken`);
    });
    it("passes it with the Reviewer's lane called too, reading Kanon's baseline Reviewer and Explorer playbooks", () => {
      const t = adopter();
      lean(t);
      t.write('.github/workflows/agent-review.yml', readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-review.yml'), 'utf8'));
      t.write(REGISTER, `${t.read(REGISTER)}| Reviewer | \`example-judge\` | Read | Read & write | Read & write | No access |\n`);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/::notice file=docs\/qa\/reviewer-playbook\.md,title=lane-check::doesn't exist, so the Kanon lane\(s\) agent-review read Kanon's baseline/);
      expect(r.out).toMatch(/::notice file=docs\/qa\/explorer-playbook\.md,title=lane-check::doesn't exist, so the Kanon lane\(s\) [a-z-,]*agent-review[a-z-,]* read Kanon's baseline/);
    });
    // MUTATION: the same repository with each section present but malformed, rather than
    // missing, still fails, by name.
    it.each([
      ['a doubled stack section', (t: Tree) => t.write(STACK, `${t.read(STACK)}\n## Data isolation\n\n## Data isolation\n`), /stack\.md,title=lane-check::has the heading `## Data isolation` 2 times/],
      ['a near miss of a stack section', (t: Tree) => t.write(STACK, `${t.read(STACK)}\n## Schema Changes\n`), /stack\.md,title=lane-check::has the heading `## Schema changes` 0 times \(1 more line/],
      ['a malformed `## Code areas`', (t: Tree) => t.write(STACK, `${t.read(STACK)}\n## Code areas\n\n- \`src\` — code: the app\n`), /stack\.md,title=lane-check::.*a `code` area is a directory/],
      ['an escalation file with an unreadable entry', (t: Tree) => t.write('docs/qa/escalation-paths.md', '## Escalation paths\n\n- ^a/ — no backticks\n'), /escalation-paths\.md,title=lane-check::docs\/qa\/escalation-paths\.md:3, under `## Escalation paths`, isn't an entry/],
      ['an exemptions file with a doubled section', (t: Tree) => t.write('docs/qa/exemptions.md', '## Path mentions\n\n## Path mentions\n'), /exemptions\.md,title=lane-check::docs\/qa\/exemptions\.md has the `## Path mentions` heading 2 times/],
      ['an Overseer bullet with another value', (t: Tree) => t.write(REC, `${t.read(REC)}\n## Choices\n\n- **Overseer:** \`maybe\`\n`), /adoption\.md,title=lane-check::docs\/qa\/adoption\.md:\d+: `Overseer` is `maybe`/],
      ['a test-database file that declares nothing', (t: Tree) => t.write('docs/qa/test-database.md', '# Test database\n'), /test-database\.md,title=lane-check::.*has no `\*\*Test database:\*\* `<kind>`` line/],
    ])('still fails %s, by name', (_, change, message) => { red((t) => { lean(t); change(t); }, message); });
  });
});
