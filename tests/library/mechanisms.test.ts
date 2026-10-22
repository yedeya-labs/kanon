import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, NOT_APPLICABLE_LABEL, STATUS, mechanismRows, readMechanisms } from '../../scripts/lib/mechanisms.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * `K-ADOPT-9`, `K-LAYOUT-10` (#1236): a mechanism the repository has nothing for is marked
 * `not applicable` in its adoption record's mechanism list, and `## Choices` says why, in one
 * bullet naming the row's rules. Any repository may say it; `kanon doctor` reads it through
 * this module and fails either half without the other.
 */
const RECORD = (rows: string[], choices: string[], tail: string[] = []) =>
  [
    '# Adoption record',
    '',
    '## Mechanisms',
    '',
    '| Mechanism | Rules | Status |',
    '|---|---|---|',
    ...rows,
    '',
    '## Choices',
    '',
    ...choices,
    '',
    ...tail,
    '',
  ].join('\n');
const DEPLOY = '| The deploy lane | `K-SHIP-8`, `K-SHIP-9` | not applicable |';
const GUARD = '| The label guard | `K-WORK-12` | not yet installed |';
const REASON = `- **${NOT_APPLICABLE_LABEL}:** \`K-SHIP-9\`, \`K-SHIP-8\` (the repository deploys nothing)`;

describe('the mechanism list', () => {
  it('takes three statuses', () => {
    for (const s of ['installed 2026-10-21', 'not yet installed', 'not applicable']) expect(STATUS.test(s)).toBe(true);
    for (const s of ['installed', 'n/a', 'not installed']) expect(STATUS.test(s)).toBe(false);
  });

  it('reads each row with its rules, its status and its line', () => {
    expect(mechanismRows(RECORD([DEPLOY, GUARD], []))).toEqual([
      { mechanism: 'The deploy lane', rules: ['K-SHIP-8', 'K-SHIP-9'], status: 'not applicable', line: 7 },
      { mechanism: 'The label guard', rules: ['K-WORK-12'], status: 'not yet installed', line: 8 },
    ]);
  });

  it('reads no rows from a record without the table, or with another header', () => {
    expect(mechanismRows('# Adoption record\n\n## Choices\n')).toEqual([]);
    expect(mechanismRows(RECORD([DEPLOY], []).replace('| Mechanism | Rules | Status |', '| What | Rules | Status |'))).toEqual([]);
  });

  it('K-LAYOUT-10 writes the bullet as this module reads it', () => {
    const rule = readFileSync(join(ROOT, 'rulebook/11-repository-layout.md'), 'utf8');
    expect(rule).toContain(EXAMPLE);
    expect(rule).toContain('`installed YYYY-MM-DD`, `not yet installed` or `not applicable`');
  });
});

describe('the reasons', () => {
  it('pairs each not-applicable row with its bullet, the rules in any order', () => {
    const r = readMechanisms(RECORD([DEPLOY, GUARD], [REASON]));
    expect(r.errors).toEqual([]);
    expect(r.reasons).toEqual([{ rules: ['K-SHIP-9', 'K-SHIP-8'], reason: 'the repository deploys nothing', line: 12 }]);
  });

  it('asks nothing of a record without the table or the bullet, or of no record', () => {
    expect(readMechanisms('# Adoption record\n\n## Choices\n\n- **Overseer:** `installed`\n').errors).toEqual([]);
    expect(readMechanisms(RECORD([GUARD], [])).errors).toEqual([]);
    expect(readMechanisms(null)).toEqual({ rows: [], reasons: [], errors: [] });
  });

  it('reads nothing inside a code fence', () => {
    expect(readMechanisms(RECORD([GUARD], ['```markdown', REASON, '```'])).errors).toEqual([]);
  });

  it.each([
    ['a not-applicable row with no bullet', RECORD([DEPLOY], []), /adoption\.md:7 marks a mechanism `not applicable` with no reason: say why under `## Choices`, as `- \*\*Mechanism not applicable:\*\* `K-SHIP-8`, `K-SHIP-9` \(<why>\)`/],
    ['a bullet whose row is not yet installed', RECORD([DEPLOY.replace('not applicable', 'not yet installed')], [REASON]), /adoption\.md:11 says the mechanism of `K-SHIP-9`, `K-SHIP-8` doesn't apply, but docs\/qa\/adoption\.md:7 marks it `not yet installed`/],
    ['a bullet naming only some of its row\'s rules', RECORD([DEPLOY], [REASON.replace('`K-SHIP-9`, ', '')]), /names `K-SHIP-8`, which no row of `## Mechanisms` lists as exactly its rules/],
    ['a bullet naming one rule more than its row', RECORD([DEPLOY], [REASON.replace('`K-SHIP-8`', '`K-SHIP-8`, `K-SHIP-10`')]), /which no row of `## Mechanisms` lists as exactly its rules/],
    ['a bullet with nothing in its parentheses', RECORD([DEPLOY], [REASON.replace(/\(.*\)/, '( )')]), /adoption\.md:11 is not `- \*\*Mechanism not applicable:\*\*/],
    ['a bullet with no reason', RECORD([DEPLOY], [REASON.replace(/ \(.*\)/, '')]), /is not `- \*\*Mechanism not applicable:\*\*/],
    ['a bullet whose rules are plain text', RECORD([DEPLOY], [REASON.replace(/`/g, '')]), /is not `- \*\*Mechanism not applicable:\*\*/],
    ['a bullet outside `## Choices`', RECORD([DEPLOY], [], ['## Data', '', REASON]), /adoption\.md:14 says a mechanism doesn't apply outside `## Choices`/],
    ['a bullet written twice', RECORD([DEPLOY], [REASON, REASON]), /adoption\.md:12 names the mechanism of `K-SHIP-9`, `K-SHIP-8` a second time/],
    ['a not-applicable row with no rules', RECORD(['| The sweep | none | not applicable |'], []), /adoption\.md:7 marks a mechanism `not applicable` but lists no rules/],
    ['two not-applicable rows with the same rules', RECORD([DEPLOY, DEPLOY.replace('The deploy lane', 'The smoke check')], [REASON]), /adoption\.md:8 marks a mechanism `not applicable` with the same rules as line 7/],
  ])('fails %s, by its line', (_what, text, error) => {
    expect(readMechanisms(text).errors.join('\n')).toMatch(error);
  });

  it('fails an unclosed fence rather than reading past it', () => {
    expect(readMechanisms(RECORD([DEPLOY], ['```', REASON])).errors.join('\n')).toMatch(/opens a code fence that never closes/);
  });
});
