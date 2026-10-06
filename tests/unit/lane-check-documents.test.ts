import { describe, expect, it } from 'vitest';
import { adopter, check, red, defaulted, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the project documents the lanes read.
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
});
