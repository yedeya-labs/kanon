import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `docs/qa/adoption.md` is Kanon's own adoption record (`K-LAYOUT-10`). This test checks the
 * parts of its format a machine can read one way: the five headings in order, the bootstrap
 * line, and a mechanism list (`K-ADOPT-9`) that names every rule whose "Enforced by" line
 * names something, with each mechanism marked `installed YYYY-MM-DD` or `not yet installed`.
 * The required rules come from the rulebook, never from a list kept here, so a new rule with
 * a mechanism fails this test until the record says whether it is installed.
 */
const ROOT = process.cwd();
const RECORD = join(ROOT, 'docs/qa/adoption.md');
const HEADINGS = ['People', 'Plan', 'Bootstrap', 'Mechanisms', 'Choices'];
const STATUS = /^(installed \d{4}-\d{2}-\d{2}|not yet installed)$/;
const RULE_ID = /K-[A-Z]+-\d+/g;
const TABLE_HEADER = '| Mechanism | Rules | Status |';
const PROSE_ANCHOR = "These rules' lines are prose only with a note, and name nothing to install:";

/** Every rule of the numbered chapters, with its "Enforced by" line (absent on a retired rule). */
const rulebookRules = (
  chapters: string[] = readdirSync(join(ROOT, 'rulebook'))
    .filter((f) => /^\d\d-.*\.md$/.test(f))
    .map((f) => readFileSync(join(ROOT, 'rulebook', f), 'utf8')),
): Map<string, string | undefined> => {
  const rules = new Map<string, string | undefined>();
  for (const text of chapters) {
    let id: string | undefined;
    for (const line of text.split('\n')) {
      const heading = /^### `(K-[A-Z]+-\d+)`/.exec(line);
      if (heading?.[1]) {
        id = heading[1];
        rules.set(id, undefined);
        continue;
      }
      const enforced = /^\*\*Enforced by\.\*\* (.*)$/.exec(line);
      if (enforced?.[1] && id) rules.set(id, enforced[1].trim());
    }
  }
  return rules;
};

/** A rule names a mechanism unless its line is exactly "Prose only." (or it has none). */
const rulesNamingAMechanism = (rules: Map<string, string | undefined>): string[] =>
  [...rules].filter(([, line]) => line !== undefined && line !== 'Prose only.').map(([id]) => id);

/** The record's `## ` sections, in order, keyed by heading. */
const sections = (text: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...body] = part.split('\n');
    out.push([(head ?? '').trim(), body.join('\n')]);
  }
  return out;
};

/** Every problem with a record, as readable strings. An empty list means it passes. */
const recordProblems = (text: string, rules: Map<string, string | undefined>): string[] => {
  const problems: string[] = [];
  const found = sections(text);
  const heads = found.map(([h]) => h).filter((h) => HEADINGS.includes(h));
  if (heads.join('|') !== HEADINGS.join('|')) problems.push(`headings are ${heads.join(', ')}, not ${HEADINGS.join(', ')}`);
  const body = (h: string): string => found.find(([head]) => head === h)?.[1] ?? '';

  for (const role of ['Owner', 'Maintainer', 'Stakeholder']) {
    if (!new RegExp(`^\\| ${role} \\| \\S`, 'm').test(body('People'))) problems.push(`People names no ${role}`);
  }

  const bootstrap = /`(in bootstrap since|ended) \d{4}-\d{2}-\d{2}`/.exec(body('Bootstrap'));
  if (!bootstrap) problems.push('Bootstrap has no `in bootstrap since YYYY-MM-DD` or `ended YYYY-MM-DD`');

  // Only the table, and the one anchored prose-only list, can list a rule. An id anywhere else
  // in the section (the intro, the reasons) lists nothing, so a deleted row can't hide behind it.
  const lines = body('Mechanisms').split('\n');
  const head = lines.indexOf(TABLE_HEADER);
  if (head < 0 || !/^\|(\s*-+\s*\|){3}$/.test(lines[head + 1] ?? '')) {
    throw new Error(`Mechanisms has no table headed "${TABLE_HEADER}": the anchor moved, so the check would go blind`);
  }
  const rows: string[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line);
  }
  if (rows.length === 0) problems.push('Mechanisms has no table rows');
  const listed = new Set<string>();
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 3) {
      problems.push(`mechanism row "${row}" has ${cells.length} cells, not 3`);
      continue;
    }
    const status = (cells[2] ?? '').replace(/`/g, '');
    if (!STATUS.test(status)) problems.push(`mechanism "${cells[0]}" is marked "${status}"`);
    for (const id of cells[1]?.match(RULE_ID) ?? []) listed.add(id);
  }
  const proseLine = lines.find((l) => l.startsWith(PROSE_ANCHOR)) ?? '';
  const prose = new Set(proseLine.match(RULE_ID) ?? []);
  for (const id of prose) {
    if (!rules.get(id)?.startsWith('Prose only')) problems.push(`${id} is listed as prose only, but its line names a mechanism`);
  }
  for (const id of rulesNamingAMechanism(rules)) {
    if (!listed.has(id) && !prose.has(id)) problems.push(`Mechanisms leaves out ${id}`);
  }
  for (const id of [...listed, ...prose]) if (!rules.has(id)) problems.push(`Mechanisms cites ${id}, which the rulebook has no rule for`);
  return problems;
};

describe("Kanon's adoption record (K-LAYOUT-10, K-ADOPT-9)", () => {
  const rules = rulebookRules();

  it('reads the rulebook, so the checks below are not vacuous', () => {
    expect(rules.size).toBeGreaterThan(200);
    expect(rulesNamingAMechanism(rules).length).toBeGreaterThan(150);
    expect(rulesNamingAMechanism(rules)).toContain('K-MERGE-6');
    expect(rulesNamingAMechanism(rules)).not.toContain('K-AGENT-17');
  });

  it('has the five headings, the bootstrap line and every mechanism, each marked', () => {
    expect(recordProblems(readFileSync(RECORD, 'utf8'), rules)).toEqual([]);
  });
});

describe('the record check fails on each broken shape', () => {
  const rules = new Map<string, string | undefined>([
    ['K-A-1', 'The guard.'],
    ['K-A-2', 'Prose only.'],
    ['K-A-3', 'Prose only; a guard is planned.'],
    ['K-A-4', undefined],
    ['K-A-5', 'Prose only, in the agent instructions.'],
  ]);
  const good = [
    '# Adoption record',
    '## People',
    '| Role | Who |',
    '|---|---|',
    '| Owner | A |',
    '| Maintainer | A |',
    '| Stakeholder | A |',
    '## Plan',
    'Free.',
    '## Bootstrap',
    '`ended 2026-10-02`',
    '## Mechanisms',
    '| Mechanism | Rules | Status |',
    '|---|---|---|',
    '| The guard | `K-A-1` | installed 2026-10-02 |',
    '| A planned guard | `K-A-3` | not yet installed |',
    '',
    "These rules' lines are prose only with a note, and name nothing to install: `K-A-5`.",
    '## Choices',
    'None yet.',
    '',
  ].join('\n');

  it('passes the good record', () => {
    expect(recordProblems(good, rules)).toEqual([]);
  });

  const broken: Array<[string, string, RegExp]> = [
    ['a heading is missing', good.replace('## Plan\n', ''), /headings are/],
    ['two headings swap', good.replace('## Plan', '## TMP').replace('## People', '## Plan').replace('## TMP', '## People'), /headings are/],
    ['a role is unnamed', good.replace('| Stakeholder | A |\n', ''), /no Stakeholder/],
    ['the bootstrap line has no date', good.replace('`ended 2026-10-02`', '`ended soon`'), /Bootstrap has no/],
    ['a mechanism has another status', good.replace('installed 2026-10-02', 'installed'), /is marked "installed"/],
    ['a mechanism is left out', good.replace('| A planned guard | `K-A-3` | not yet installed |\n', ''), /leaves out K-A-3/],
    ['a rule is cited only outside the table and the list', good.replace('| The guard | `K-A-1` | installed 2026-10-02 |\n', '').replace('# Adoption record', '# Adoption record\n\nSee `K-A-1`.').replace('## Mechanisms\n', '## Mechanisms\nThe guard is `K-A-1`.\n'), /leaves out K-A-1/],
    ['a mechanism is moved to the prose-only list', good.replace('| The guard | `K-A-1` | installed 2026-10-02 |\n', '').replace('`K-A-5`.', '`K-A-5`, `K-A-1`.'), /K-A-1 is listed as prose only/],
    ['a row has the wrong number of cells', good.replace('| `K-A-3` | not yet installed |', '| `K-A-3` |'), /has 2 cells/],
    ['a cited rule does not exist', good.replace('`K-A-3`', '`K-A-3`, `K-A-9`'), /K-A-9, which the rulebook/],
  ];
  it('throws when the table header moves, rather than going blind', () => {
    expect(() => recordProblems(good.replace('| Mechanism | Rules | Status |', '| What | Rules | Status |'), rules)).toThrow(/anchor moved/);
  });

  for (const [what, text, problem] of broken) {
    it(`fails when ${what}`, () => {
      expect(recordProblems(text, rules).join('\n')).toMatch(problem);
    });
  }
});
