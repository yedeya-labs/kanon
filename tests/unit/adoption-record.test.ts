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

/** Every rule of the numbered chapters, with its "Enforced by" line (absent on a retired rule). */
export const rulebookRules = (
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
export const rulesNamingAMechanism = (rules: Map<string, string | undefined>): string[] =>
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
export const recordProblems = (text: string, rules: Map<string, string | undefined>): string[] => {
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

  const mechanisms = body('Mechanisms');
  const rows = mechanisms.split('\n').filter((l) => /^\| /.test(l) && !/^\|[\s|-]*$/.test(l)).slice(1);
  if (rows.length === 0) problems.push('Mechanisms has no table rows');
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    const status = cells.at(-1)?.replace(/`/g, '') ?? '';
    if (!STATUS.test(status)) problems.push(`mechanism "${cells[0]}" is marked "${status}"`);
  }
  const cited = new Set(mechanisms.match(RULE_ID) ?? []);
  for (const id of rulesNamingAMechanism(rules)) if (!cited.has(id)) problems.push(`Mechanisms leaves out ${id}`);
  for (const id of cited) if (!rules.has(id)) problems.push(`Mechanisms cites ${id}, which the rulebook has no rule for`);
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
    ['a cited rule does not exist', good.replace('`K-A-3`', '`K-A-3`, `K-A-9`'), /K-A-9, which the rulebook/],
  ];
  for (const [what, text, problem] of broken) {
    it(`fails when ${what}`, () => {
      expect(recordProblems(text, rules).join('\n')).toMatch(problem);
    });
  }
});
