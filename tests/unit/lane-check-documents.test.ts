import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, REGISTER, adopter, check, red, defaulted, type Tree, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the project documents the lanes read, and the lean
 * installation that leaves out every one with a default.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  describe('the project documents the lanes read (K-LAYOUT-17, kanon#36)', () => {
    const STACK = 'docs/qa/stack.md';
    it('refuses a missing stack document, naming the lanes that read it', () =>
      red((t) => t.rm(STACK), /docs\/qa\/stack\.md,title=lane-check::is missing; the Kanon lane\(s\) [a-z-,]*agent-triage[a-z-,]* read it \(K-LAYOUT-17\)/));
    it("reads a missing playbook a called lane reads as Kanon's baseline, and says so (plan 0005 §5.2)", () => {
      const r = defaulted((t) => t.rm('docs/qa/triage-fix-playbook.md'),
        /::notice file=docs\/qa\/triage-fix-playbook\.md,title=lane-check::doesn't exist, so the Kanon lane\(s\) [a-z-,]*agent-triage[a-z-,]* read Kanon's baseline for it \(plan 0005 §5\.2, K-LAYOUT-17\)/);
      expect(r.out).not.toMatch(/::error/);
    });
    it('requires a playbook only when a called lane reads it', () => {
      const t = adopter();
      t.rm('docs/qa/explorer-playbook.md');
      expect(check(t).status).toBe(0);
    });
    it('refuses a stack document without `## Gates`, which has no default', () =>
      red((t) => t.write(STACK, t.read(STACK).replace('## Gates\n', '')), 'has the heading `## Gates` 0 times; the stack document has it exactly once, with no default'));
    it.each([
      ['## Schema changes', 'the project has no schema'],
      ['## Data isolation', 'the project has nothing to isolate'],
      ['## Generated files', 'the project has no generated files'],
    ])("reads a stack document without `%s` as Kanon's default, and says so (plan 0005 §5.2)", (h, means) => {
      defaulted((t) => t.write(STACK, t.read(STACK).replace(`${h}\n`, '')),
        `::notice file=docs/qa/stack.md,title=lane-check::has no \`${h}\`, so Kanon's default applies: ${means} (K-LAYOUT-17)`);
    });
    it('still refuses an optional section written twice: malformed, not omitted', () =>
      red((t) => t.write(STACK, `${t.read(STACK)}\n## Data isolation\n\nMore.\n`), 'has the heading `## Data isolation` 2 times; the stack document has it at most once'));
    it('still refuses a near miss of an optional section, which looks present', () =>
      red((t) => t.write(STACK, t.read(STACK).replace('## Data isolation\n', '## Data Isolation\n')), /has the heading `## Data isolation` 0 times \(1 more line\(s\) match it/));
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
      red((t) => t.write(STACK, t.read(STACK).replace('## Gates\n', '```\n## Gates\n```\n')), 'has the heading `## Gates` 0 times'));
  });

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
