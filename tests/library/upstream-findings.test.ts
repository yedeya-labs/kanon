import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upstreamFindingsCli } from '../../scripts/upstream-findings.mjs';
import {
  DEFAULT_VALUE,
  LABEL,
  VALUES,
  parseUpstreamFindings,
  readUpstreamFindings,
  readUpstreamFindingsFrom,
} from '../../scripts/lib/upstream-findings.mjs';
import { declarationFindings } from '../../actions/lane-check/declarations.mjs';

/**
 * `K-LAYOUT-10`, `K-SELF-11`, kanon#423 (plan 0004 decision 12, amended 2026-10-06): where the
 * Overseer's upstream findings go is a choice any repository declares in its adoption record,
 * never something Kanon detects. Without it they are drafts, as before. The lane reads it from
 * the default branch; `lane-check` and `kanon doctor` read the checkout.
 */
const RECORD = (choices: string[], tail = '') =>
  ['# Adoption record', '', '## People', '', '- Owner: someone', '', '## Choices', '', ...choices, '', tail].join('\n');
const BULLET = `- **${LABEL}:** \`filed here\``;

describe('the declaration', () => {
  it('takes two values, and defaults to drafts', () => {
    expect(VALUES).toEqual(['drafted', 'filed here']);
    expect(DEFAULT_VALUE).toBe('drafted');
  });

  it('reads `filed here` and `drafted` under `## Choices`, beside the other choices', () => {
    expect(parseUpstreamFindings(RECORD(['- **Chat channel:** #team', '- **Overseer:** `installed`', BULLET]))).toBe('filed here');
    expect(parseUpstreamFindings(RECORD([`* **${LABEL}:** \`drafted\`  `]))).toBe('drafted');
    expect(parseUpstreamFindings(RECORD([BULLET]).replace(/\n/g, '\r\n'))).toBe('filed here');
  });

  it('declares nothing without the bullet, or with it only inside a code fence', () => {
    expect(parseUpstreamFindings(RECORD(['- **Overseer:** `installed`']))).toBeNull();
    expect(parseUpstreamFindings(RECORD(['```markdown', BULLET, '```']))).toBeNull();
  });

  it.each([
    ['twice', RECORD([BULLET, BULLET]), /adoption\.md:10 repeats `Upstream findings`, already declared on line 9 \(K-LAYOUT-10\)/],
    ['outside `## Choices`', `# Adoption record\n\n${BULLET}\n\n## Choices\n`, /adoption\.md:3 declares where upstream findings go outside `## Choices`/],
    ['after `## Choices` has ended', RECORD([], `## Mechanisms\n\n${BULLET}\n`), /outside `## Choices`/],
    ['with no `## Choices` at all', `# Adoption record\n\n${BULLET}\n`, /outside `## Choices`/],
    ['with `## Choices` twice', `${RECORD([BULLET])}\n## Choices\n`, /has the `## Choices` heading 2 times/],
    ['in another shape', RECORD([`- **${LABEL}:** filed here`]), /adoption\.md:9, under `## Choices`, isn't a declaration/],
    ['as a numbered item', RECORD([`1. **${LABEL}:** \`filed here\``]), /isn't a declaration/],
    ['with something after the value', RECORD([`${BULLET} on Kanon`]), /isn't a declaration/],
    ['naming another repository', RECORD([`- **${LABEL}:** \`filed on yedeya-labs/kanon\``]), /adoption\.md:9: `Upstream findings` is `filed on yedeya-labs\/kanon`; write `drafted` or `filed here`/],
    ['with an empty value', RECORD([`- **${LABEL}:** \`\``]), /`Upstream findings` is ``; write/],
    ['in a fence that never closes', RECORD(['```', BULLET]), /opens a code fence that never closes/],
  ])('refuses one %s, by line', (_name, text, message) => {
    expect(() => parseUpstreamFindings(text)).toThrow(message);
  });
});

describe('lane-check reads it from the checkout', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const tree = (record: string | null) => {
    dir = mkdtempSync(join(tmpdir(), 'upstream-findings-'));
    if (record !== null) {
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, 'docs/qa/adoption.md'), record);
    }
    return dir;
  };

  it('reads a declared value, and nothing from no record or a record without it', () => {
    expect(readUpstreamFindings(tree(RECORD([BULLET])))).toBe('filed here');
    expect(readUpstreamFindings(tree(RECORD([])))).toBeNull();
    expect(readUpstreamFindings(tree(null))).toBeNull();
  });

  it('fails a malformed bullet by name, through the readers lane-check runs', () => {
    const errors = (root: string) => declarationFindings(false, false, root).filter((l) => l.startsWith('error\tdocs/qa/adoption.md\t'));
    expect(errors(tree(RECORD(['- **Overseer:** `not installed`', BULLET])))).toEqual([]);
    expect(errors(tree(RECORD(['- **Overseer:** `not installed`', `- **${LABEL}:** \`always\``])))).toEqual([
      'error\tdocs/qa/adoption.md\tdocs/qa/adoption.md:10: `Upstream findings` is `always`; write `drafted` or `filed here` (K-LAYOUT-10)',
    ]);
  });

  it('reads the fixture adopter, which declares none', () => {
    expect(readUpstreamFindings(join(process.cwd(), 'tests/fixtures/adopter'))).toBeNull();
  });
});

describe('the lane reads it from the default branch (K-MERGE-17)', () => {
  const run = (contents: () => string) => (args: string[]) => (args[1] === 'repos/o/r' ? 'trunk\n' : contents());
  const fail = (stderr: string) => () => {
    throw Object.assign(new Error('gh failed'), { stderr });
  };

  it('uses the declared value, and Kanon\'s default when there is none or no record', () => {
    expect(readUpstreamFindingsFrom('o/r', run(() => RECORD([BULLET])))).toBe('filed here');
    expect(readUpstreamFindingsFrom('o/r', run(() => RECORD([`- **${LABEL}:** \`drafted\``])))).toBe('drafted');
    expect(readUpstreamFindingsFrom('o/r', run(() => RECORD([])))).toBe('drafted');
    expect(readUpstreamFindingsFrom('o/r', run(fail('gh: Not Found (HTTP 404)')))).toBe('drafted');
  });

  it('reads the default branch, never the run\'s own ref', () => {
    const calls: string[][] = [];
    readUpstreamFindingsFrom('o/r', (args: string[]) => { calls.push(args); return args[1] === 'repos/o/r' ? 'trunk\n' : RECORD([BULLET]); });
    expect(calls[1]![1]).toBe('repos/o/r/contents/docs/qa/adoption.md?ref=trunk');
  });

  it("names Kanon's default when it takes it, and says nothing when the record declares one (plan 0005 §5.2)", () => {
    const notes: string[] = [];
    readUpstreamFindingsFrom('o/r', run(() => RECORD([])), (l) => notes.push(l));
    readUpstreamFindingsFrom('o/r', run(fail('gh: Not Found (HTTP 404)')), (l) => notes.push(l));
    readUpstreamFindingsFrom('o/r', run(() => RECORD([BULLET])), (l) => notes.push(l));
    expect(notes).toEqual([
      "docs/qa/adoption.md on `trunk` doesn't say where upstream findings go, so Kanon's default applies: they are `drafted` under the audit's `## Upstream` heading, never filed (K-LAYOUT-10)",
      "docs/qa/adoption.md on `trunk` doesn't exist, so Kanon's default applies: they are `drafted` under the audit's `## Upstream` heading, never filed (K-LAYOUT-10)",
    ]);
    expect(upstreamFindingsCli({ repo: 'o/r', run: run(() => RECORD([])) })).toEqual({ code: 0, out: 'drafted', notes: [`upstream-findings: ${notes[0]}`] });
  });

  it('fails by name on a malformed record, an unreadable one, and no default branch', () => {
    expect(() => readUpstreamFindingsFrom('o/r', run(() => RECORD([BULLET, BULLET])))).toThrow(/repeats `Upstream findings`/);
    expect(() => readUpstreamFindingsFrom('o/r', run(fail('gh: Server Error (HTTP 502)')))).toThrow(/couldn't be read from `trunk`: gh: Server Error \(HTTP 502\)/);
    expect(() => readUpstreamFindingsFrom('o/r', () => '\n')).toThrow(/no default branch to read docs\/qa\/adoption\.md from/);
  });

  it('the CLI prints the value, and exits 1 or 2 by name', () => {
    expect(upstreamFindingsCli({ repo: 'o/r', run: run(() => RECORD([BULLET])) })).toEqual({ code: 0, out: 'filed here' });
    expect(upstreamFindingsCli({ repo: 'o/r', run: run(() => RECORD([`- **${LABEL}:**`])) }).code).toBe(1);
    expect(upstreamFindingsCli({ repo: '' })).toEqual({ code: 2, out: 'upstream-findings: GITHUB_REPOSITORY must be set' });
  });
});
