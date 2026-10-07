import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upstreamFindingsCli } from '../../scripts/upstream-findings.mjs';
import {
  DEFAULT_VALUE,
  LABEL,
  SENT_VALUES,
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
 * the default branch; `lane-check` and `kanon doctor` read the checkout. Plan 0006 F2 (kanon#585)
 * adds `sent` and `sent with evidence`, which need the telemetry opt-in (§3.1).
 */
const RECORD = (choices: string[], tail = '') =>
  ['# Adoption record', '', '## People', '', '- Owner: someone', '', '## Choices', '', ...choices, '', tail].join('\n');
const BULLET = `- **${LABEL}:** \`filed here\``;

describe('the declaration', () => {
  it('takes four values, two of them sent, and defaults to drafts', () => {
    expect(VALUES).toEqual(['drafted', 'filed here', 'sent', 'sent with evidence']);
    expect(SENT_VALUES).toEqual(['sent', 'sent with evidence']);
    expect(DEFAULT_VALUE).toBe('drafted');
  });

  it('reads `sent` and `sent with evidence` under `## Choices` (plan 0006 §3.1)', () => {
    expect(parseUpstreamFindings(RECORD([`- **${LABEL}:** \`sent\``]))).toBe('sent');
    expect(parseUpstreamFindings(RECORD(['- **Overseer:** `installed`', `- **${LABEL}:** \`sent with evidence\``]))).toBe('sent with evidence');
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
    ['naming another repository', RECORD([`- **${LABEL}:** \`filed on yedeya-labs/kanon\``]), /adoption\.md:9: `Upstream findings` is `filed on yedeya-labs\/kanon`; write `drafted`, `filed here`, `sent` or `sent with evidence`/],
    ['with two spaces inside a sent value', RECORD([`- **${LABEL}:** \`sent  with evidence\``]), /adoption\.md:9: `Upstream findings` is `sent {2}with evidence`; write `drafted`, `filed here`, `sent` or `sent with evidence` \(K-LAYOUT-10\)/],
    ['with a sent value in another case', RECORD([`- **${LABEL}:** \`Sent\``]), /adoption\.md:9: `Upstream findings` is `Sent`; write/],
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
      'error\tdocs/qa/adoption.md\tdocs/qa/adoption.md:10: `Upstream findings` is `always`; write `drafted`, `filed here`, `sent` or `sent with evidence` (K-LAYOUT-10)',
    ]);
  });

  // Plan 0006 §3.1: `sent` and `sent with evidence` travel over the telemetry channel, so without a
  // caller of Kanon's telemetry collector nothing is sent, and lane-check says so, naming both fixes.
  it('fails `sent` and `sent with evidence` without a caller of the telemetry collector, naming both fixes (upstream.unsent)', () => {
    const errors = (root: string, telemetry: boolean) => declarationFindings(false, false, root, telemetry).filter((l) => l.startsWith('error\tdocs/qa/adoption.md\t'));
    for (const value of ['sent', 'sent with evidence']) {
      const root = tree(RECORD([`- **${LABEL}:** \`${value}\``]));
      const [line, ...rest] = errors(root, false);
      expect(rest).toEqual([]);
      expect(line).toContain(`docs/qa/adoption.md:9 says \`${LABEL}: ${value}\`, and no workflow calls Kanon's telemetry collector`);
      expect(line).toMatch(/opt in to telemetry \(`kanon init --telemetry`, docs\/telemetry\.md\), or choose `drafted`/);
      expect(line).toMatch(/\(K-LAYOUT-10, upstream\.unsent\)$/);
      expect(errors(root, true)).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    }
    // `drafted`, `filed here` and no bullet need no collector.
    for (const choices of [[`- **${LABEL}:** \`drafted\``], [BULLET], []]) expect(errors(tree(RECORD(choices)), false)).toEqual([]);
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
      "docs/qa/adoption.md on `trunk` doesn't say where upstream findings go, so Kanon's default applies: they are `drafted`, never filed (K-LAYOUT-10)",
      "docs/qa/adoption.md on `trunk` doesn't exist, so Kanon's default applies: they are `drafted`, never filed (K-LAYOUT-10)",
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
