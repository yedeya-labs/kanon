import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, categoryOf, census, main, readChapters, render, rulesOf } from '../../scripts/enforcement-census.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `scripts/enforcement-census.mjs` (#1236) counts the rulebook's rules by their "Enforced by."
 * lines, by the convention the rulebook's README fixes: a prose-only rule says so first, a guard
 * that leaves part of the rule to prose says which part is prose only, and a guard still to be
 * built is "a guard is planned".
 */
const ROOT = process.cwd();
const chapter = (...rules: string[]) => ({ chapter: '01-x.md', text: rules.join('\n\n') });
const rule = (id: string, line?: string, retired = false) =>
  [`### \`${id}\` A rule${retired ? ' (**retired**)' : ''}`, '', '**Rule.** Do it.', ...(line === undefined ? [] : ['', `**Enforced by.** ${line}`])].join('\n');

describe('the categories', () => {
  it.each([
    ['A unit test that fails when the label is missing.', 'enforced'],
    ['The merge gate, as a pure function.', 'enforced'],
    ['Prose only.', 'prose only'],
    ['Prose only, in the agent instructions.', 'prose only'],
    ['Prose only. The brief guard checks the decomposition (`K-PROJ-9`).', 'prose only'],
    ['Prose only; a guard is planned.', 'prose only, guard planned'],
    ['prose only; A guard is planned. It fails when the brief has no record.', 'prose only, guard planned'],
    ['The guard, for briefs only. The rest is prose only.', 'enforced in part'],
    ["On Kanon's own record, the test. For an adopter, prose only.", 'enforced in part'],
    ['The bypass list. The file-set bound is prose only; a guard is planned.', 'enforced in part'],
    ['The check for the format; a guard is planned for the rest.', 'enforced in part'],
    ['Partly. The template is checked against the guard.', 'enforced in part'],
  ])('%s is %s', (line, category) => {
    expect(categoryOf(line)).toBe(category);
  });

  it('are the four the summary prints, in order', () => {
    expect(CATEGORIES).toEqual(['enforced', 'enforced in part', 'prose only', 'prose only, guard planned']);
  });
});

describe('the census', () => {
  const rules = rulesOf([
    chapter(rule('K-A-1', 'The guard.'), rule('K-A-2', 'Prose only.'), rule('K-A-3', 'Prose only; a guard is planned.')),
    chapter(rule('K-B-1', 'The guard. The rest is prose only; a guard is planned.'), rule('K-B-2', undefined, true)),
  ]);

  it('puts each rule in one category, and a retired rule in none', () => {
    expect(rules.map((r) => [r.id, r.category])).toEqual([
      ['K-A-1', 'enforced'],
      ['K-A-2', 'prose only'],
      ['K-A-3', 'prose only, guard planned'],
      ['K-B-1', 'enforced in part'],
      ['K-B-2', 'retired'],
    ]);
    expect(census(rules)).toEqual({
      rules: 4,
      retired: 1,
      counts: { enforced: 1, 'enforced in part': 1, 'prose only': 1, 'prose only, guard planned': 1 },
      planned: 2,
      missing: [],
    });
  });

  it('reports a rule that is neither retired nor has a line', () => {
    const c = census(rulesOf([chapter(rule('K-A-1', 'The guard.'), rule('K-A-2'))]));
    expect(c.missing).toEqual(['K-A-2']);
    expect(render(c)).toMatch(/No "Enforced by\." line, which every rule that isn't retired has: K-A-2\./);
  });

  it('reads only the first "Enforced by." line of a rule', () => {
    const [r] = rulesOf([chapter([rule('K-A-1', 'Prose only.'), '**Enforced by.** The guard.'].join('\n'))]);
    expect(r?.category).toBe('prose only');
  });
});

describe("Kanon's own rulebook", () => {
  it('has a line on every rule that is not retired, and the counts add up', () => {
    const rules = rulesOf(readChapters(ROOT));
    const c = census(rules);
    expect(c.missing).toEqual([]);
    expect(c.rules).toBeGreaterThan(200);
    expect(Object.values(c.counts).reduce((a, b) => a + b, 0)).toBe(c.rules);
    expect(rules.find((r) => r.id === 'K-AGENT-16')?.category).toBe('retired');
  });

  it('prints a summary, or one JSON document with --json, and refuses another argument', () => {
    const text = main([], ROOT);
    expect(text.status).toBe(0);
    expect(text.out).toMatch(/^\d+ rules, and \d+ retired, by their "Enforced by\." lines:\n {2}enforced {2,}\d+/);
    const json = main(['--json'], ROOT);
    const doc = JSON.parse(json.out);
    expect(doc.counts).toEqual(census(rulesOf(readChapters(ROOT))).counts);
    expect(doc.byRule.length).toBe(doc.rules + doc.retired);
    expect(main(['--csv'], ROOT)).toMatchObject({ status: 2, err: expect.stringMatching(/unknown argument --csv/) });
  });

  it('runs as a command', SPAWNS, () => {
    const out = execFileSync(process.execPath, ['scripts/enforcement-census.mjs', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: SPAWNS.timeout });
    expect(JSON.parse(out).rules).toBeGreaterThan(200);
  });
});
