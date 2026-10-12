import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The README's "What is enforced, honestly" section gives the rulebook's figures exactly: how
 * many rules are in force, how many name what enforces them, and how many are prose only. An
 * earlier README said "about 200 rules" long after that stopped being true, so this holds the
 * three figures to the rulebook (kanon#698):
 *
 *   - a rule is a `### \`K-<AREA>-<n>\`` heading in a numbered chapter. One marked **retired**
 *     (in its heading or by a `**Retired.**` paragraph, rulebook/README.md) keeps its id but is
 *     not in force, and is not counted;
 *   - a rule is prose only when its `**Enforced by.**` line opens with "Prose only", whatever
 *     follows ("Prose only; a guard is planned", "Prose only. The brief guard checks …"). A line
 *     that names a mechanism first and leaves the rest to prose ("…; the rest is prose only")
 *     enforces the rule in part, which is how the README counts it;
 *   - every rule in force has exactly one `**Enforced by.**` line, and a retired one has none,
 *     so a rule the count can't classify fails here rather than being guessed at.
 */

const ROOT = process.cwd();
const RULEBOOK = join(ROOT, 'rulebook');

type Rule = { id: string; retired: boolean; enforcedBy: string[] };
type Counts = { inForce: number; enforced: number; proseOnly: number };

const RULE_HEADING = /^### `(K-[A-Z]+-\d+)`(.*)$/;
const ENFORCED_BY = /^\*\*Enforced by\.\*\*\s*(.*)$/;

/**
 * The rules a chapter declares, each with whether it is retired and its Enforced-by lines. A
 * rule runs to the next heading of any kind, so a chapter section after it is not read as its.
 * A fenced block is an example, not the chapter's own text: a heading in one ends nothing.
 */
const rulesOf = (chapter: string): Rule[] => {
  const rules: Rule[] = [];
  let rule: Rule | undefined;
  let fenced = false;
  for (const line of chapter.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = RULE_HEADING.exec(line);
    if (heading) {
      rule = { id: heading[1]!, retired: /\*\*retired\*\*/i.test(heading[2]!), enforcedBy: [] };
      rules.push(rule);
      continue;
    }
    if (/^#{1,6} /.test(line)) rule = undefined;
    if (!rule) continue;
    if (/^\*\*Retired\.\*\*/.test(line)) rule.retired = true;
    const enforced = ENFORCED_BY.exec(line);
    if (enforced) rule.enforcedBy.push(enforced[1]!);
  }
  return rules;
};

const isProseOnly = (rule: Rule): boolean => /^Prose only\b/i.test(rule.enforcedBy[0] ?? '');

/** Each rule the count can't classify: one in force without exactly one Enforced-by line, or a retired one with any. */
const unclassifiableOf = (rules: Rule[]): string[] =>
  rules.filter((r) => r.enforcedBy.length !== (r.retired ? 0 : 1))
    .map((r) => `${r.id} (${r.retired ? 'retired' : 'in force'}) has ${r.enforcedBy.length} "Enforced by" lines`);

const countsOf = (rules: Rule[]): Counts => {
  const live = rules.filter((r) => !r.retired);
  const proseOnly = live.filter(isProseOnly).length;
  return { inForce: live.length, enforced: live.length - proseOnly, proseOnly };
};

/** The three figures the README's "What is enforced, honestly" section states, or null for each it no longer states. */
const readmeFigures = (readme: string): { inForce: number | null; enforced: number | null; proseOnly: number | null } => {
  const section = /^## What is enforced, honestly\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme)?.[1] ?? '';
  const figure = (re: RegExp): number | null => {
    const m = re.exec(section);
    return m ? Number(m[1]) : null;
  };
  return {
    inForce: figure(/has (\d+) rules\b/),
    enforced: figure(/\b(\d+) name what enforces them\b/),
    proseOnly: figure(/\b(\d+) are prose only\b/),
  };
};

const CHAPTERS = readdirSync(RULEBOOK).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const RULES = CHAPTERS.flatMap((f) => rulesOf(readFileSync(join(RULEBOOK, f), 'utf8')));

describe('the rule counter classifies a rule the way the README counts it', () => {
  const chapter = [
    '# 99 Example',
    '',
    '### `K-EX-1` A rule a guard enforces',
    '**Enforced by.** A unit test; the rest is prose only.',
    '',
    '### `K-EX-2` A prose-only rule',
    '**Enforced by.** Prose only.',
    '',
    '### `K-EX-3` A prose-only rule with a planned guard',
    '```markdown',
    '## An example file\'s heading',
    '**Enforced by.** An example\'s line, not the rule\'s.',
    '```',
    '**Enforced by.** Prose only; a guard is planned.',
    '',
    '### `K-EX-4` A prose-only rule that describes a partial check',
    '**Enforced by.** Prose only. The brief guard checks one half of it.',
    '',
    '### `K-EX-5` A retired rule (**retired**)',
    '**Retired.** Folded into `K-EX-1`.',
    '',
    '### `K-EX-6` A rule retired by its paragraph alone',
    '**Retired.** Folded into `K-EX-2`.',
    '',
    '## A chapter section',
    '**Enforced by.** Not a rule\'s line, so not read as one.',
  ].join('\n');

  it('counts live rules, leaves out retired ones, and reads "Prose only" only at the start of the line', () => {
    const rules = rulesOf(chapter);
    expect(rules.map((r) => [r.id, r.retired])).toEqual([
      ['K-EX-1', false], ['K-EX-2', false], ['K-EX-3', false], ['K-EX-4', false], ['K-EX-5', true], ['K-EX-6', true],
    ]);
    expect(countsOf(rules)).toEqual({ inForce: 4, enforced: 1, proseOnly: 3 });
  });

  it('ends a rule at the next heading, so a chapter section\'s line is not the rule\'s, and skips a fenced example', () => {
    const rules = rulesOf(chapter);
    expect(rules.find((r) => r.id === 'K-EX-6')?.enforcedBy).toEqual([]);
    expect(rules.find((r) => r.id === 'K-EX-3')?.enforcedBy).toEqual(['Prose only; a guard is planned.']);
    expect(unclassifiableOf(rules)).toEqual([]);
  });

  it('reads the three figures from the README section, and none from elsewhere', () => {
    const readme = [
      '# Example',
      'The intro has 999 rules, which are not counted.',
      '## What is enforced, honestly',
      '',
      'The [rulebook](rulebook/) has 12 rules, each with its reason. 9 name what enforces them. **3 are prose only**: they say so.',
      '## Read on',
      '7 are prose only, but in another section.',
    ].join('\n');
    expect(readmeFigures(readme)).toEqual({ inForce: 12, enforced: 9, proseOnly: 3 });
    expect(readmeFigures('# Example\nNo such section.\n')).toEqual({ inForce: null, enforced: null, proseOnly: null });
  });
});

describe('the README\'s rule counts are the rulebook\'s', () => {
  it('every rule in force has one "Enforced by" line, and a retired rule has none', () => {
    expect(unclassifiableOf(RULES)).toEqual([]);
  });

  it('README.md states the rulebook\'s rules in force, the enforced ones and the prose-only ones', () => {
    const counts = countsOf(RULES);
    expect(counts.inForce).toBeGreaterThan(0);
    expect(readmeFigures(readFileSync(join(ROOT, 'README.md'), 'utf8'))).toEqual(counts);
  });
});
