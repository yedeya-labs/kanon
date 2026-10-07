import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityWatchCli } from '../../scripts/capability-watch.mjs';
import {
  DEFAULT_VALUE,
  LABEL,
  LEDGER,
  VALUES,
  parseCapabilityWatch,
  readCapabilityWatch,
  readCapabilityWatchFrom,
} from '../../scripts/lib/capability-watch.mjs';
import { declarationFindings } from '../../actions/lane-check/declarations.mjs';

/**
 * `K-LAYOUT-10`, `K-SELF-16`, `K-SELF-17`, kanon#477 (the Owner's decision of 2026-10-07): whether
 * the Overseer runs the capability watch is a choice any repository declares in its adoption
 * record, off by default, never something Kanon detects. The lane reads it from the default
 * branch; `lane-check` and `kanon doctor` read the checkout.
 */
const RECORD = (choices: string[], tail = '') =>
  ['# Adoption record', '', '## People', '', '- Owner: someone', '', '## Choices', '', ...choices, '', tail].join('\n');
const BULLET = `- **${LABEL}:** \`on\``;

describe('the declaration', () => {
  it('takes two values, and defaults to off', () => {
    expect(VALUES).toEqual(['on', 'off']);
    expect(DEFAULT_VALUE).toBe('off');
    expect(LEDGER).toBe('docs/qa/capability-ledger.md');
  });

  it('reads `on` and `off` under `## Choices`, beside the other choices', () => {
    expect(parseCapabilityWatch(RECORD(['- **Overseer:** `installed`', '- **Upstream findings:** `filed here`', BULLET]))).toBe('on');
    expect(parseCapabilityWatch(RECORD([`* **${LABEL}:** \`off\`  `]))).toBe('off');
    expect(parseCapabilityWatch(RECORD([BULLET]).replace(/\n/g, '\r\n'))).toBe('on');
  });

  it('declares nothing without the bullet, or with it only inside a code fence', () => {
    expect(parseCapabilityWatch(RECORD(['- **Overseer:** `installed`']))).toBeNull();
    expect(parseCapabilityWatch(RECORD(['```markdown', BULLET, '```']))).toBeNull();
    // The audit's own status line is not the bullet: it isn't bold.
    expect(parseCapabilityWatch(RECORD(['Capability watch: ran, through 2.1.292']))).toBeNull();
  });

  it.each([
    ['twice', RECORD([BULLET, BULLET]), /adoption\.md:10 repeats `Capability watch`, already declared on line 9 \(K-LAYOUT-10\)/],
    ['outside `## Choices`', `# Adoption record\n\n${BULLET}\n\n## Choices\n`, /adoption\.md:3 declares the capability watch outside `## Choices`/],
    ['after `## Choices` has ended', RECORD([], `## Mechanisms\n\n${BULLET}\n`), /outside `## Choices`/],
    ['with no `## Choices` at all', `# Adoption record\n\n${BULLET}\n`, /outside `## Choices`/],
    ['with `## Choices` twice', `${RECORD([BULLET])}\n## Choices\n`, /has the `## Choices` heading 2 times/],
    ['in another shape', RECORD([`- **${LABEL}:** on`]), /adoption\.md:9, under `## Choices`, isn't a declaration/],
    ['as a numbered item', RECORD([`1. **${LABEL}:** \`on\``]), /isn't a declaration/],
    ['with something after the value', RECORD([`${BULLET} for Kanon`]), /isn't a declaration/],
    ['with another value', RECORD([`- **${LABEL}:** \`yes\``]), /adoption\.md:9: `Capability watch` is `yes`; write `on` or `off`/],
    ['with an empty value', RECORD([`- **${LABEL}:** \`\``]), /`Capability watch` is ``; write/],
    ['in a fence that never closes', RECORD(['```', BULLET]), /opens a code fence that never closes/],
  ])('refuses one %s, by line', (_name, text, message) => {
    expect(() => parseCapabilityWatch(text)).toThrow(message);
  });
});

describe('lane-check reads it from the checkout', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const tree = (record: string | null) => {
    dir = mkdtempSync(join(tmpdir(), 'capability-watch-'));
    if (record !== null) {
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, 'docs/qa/adoption.md'), record);
    }
    return dir;
  };

  it('reads a declared value, and nothing from no record or a record without it', () => {
    expect(readCapabilityWatch(tree(RECORD([BULLET])))).toBe('on');
    expect(readCapabilityWatch(tree(RECORD([])))).toBeNull();
    expect(readCapabilityWatch(tree(null))).toBeNull();
  });

  it('fails a malformed bullet by name, through the readers lane-check runs', () => {
    const errors = (root: string) => declarationFindings(false, false, root).filter((l) => l.startsWith('error\tdocs/qa/adoption.md\t'));
    expect(errors(tree(RECORD(['- **Overseer:** `not installed`', BULLET])))).toEqual([]);
    expect(errors(tree(RECORD(['- **Overseer:** `not installed`', `- **${LABEL}:** \`always\``])))).toEqual([
      'error\tdocs/qa/adoption.md\tdocs/qa/adoption.md:10: `Capability watch` is `always`; write `on` or `off` (K-LAYOUT-10)',
    ]);
  });

  it('reads the fixture adopter, which declares none', () => {
    expect(readCapabilityWatch(join(process.cwd(), 'tests/fixtures/adopter'))).toBeNull();
  });
});

describe('the lane reads it from the default branch (K-MERGE-17)', () => {
  const run = (contents: () => string) => (args: string[]) => (args[1] === 'repos/o/r' ? 'trunk\n' : contents());
  const fail = (stderr: string) => () => {
    throw Object.assign(new Error('gh failed'), { stderr });
  };

  it('uses the declared value, and Kanon\'s default when there is none or no record', () => {
    expect(readCapabilityWatchFrom('o/r', run(() => RECORD([BULLET])))).toBe('on');
    expect(readCapabilityWatchFrom('o/r', run(() => RECORD([`- **${LABEL}:** \`off\``])))).toBe('off');
    expect(readCapabilityWatchFrom('o/r', run(() => RECORD([])))).toBe('off');
    expect(readCapabilityWatchFrom('o/r', run(fail('gh: Not Found (HTTP 404)')))).toBe('off');
  });

  it('reads the default branch, never the run\'s own ref', () => {
    const calls: string[][] = [];
    readCapabilityWatchFrom('o/r', (args: string[]) => { calls.push(args); return args[1] === 'repos/o/r' ? 'trunk\n' : RECORD([BULLET]); });
    expect(calls[1]![1]).toBe('repos/o/r/contents/docs/qa/adoption.md?ref=trunk');
  });

  it("names Kanon's default when it takes it, and says nothing when the record declares one (plan 0005 §5.2)", () => {
    const notes: string[] = [];
    readCapabilityWatchFrom('o/r', run(() => RECORD([])), (l) => notes.push(l));
    readCapabilityWatchFrom('o/r', run(fail('gh: Not Found (HTTP 404)')), (l) => notes.push(l));
    readCapabilityWatchFrom('o/r', run(() => RECORD([BULLET])), (l) => notes.push(l));
    expect(notes).toEqual([
      "docs/qa/adoption.md on `trunk` doesn't declare the capability watch, so Kanon's default applies: it is `off`, and the Overseer skips the capability review (K-LAYOUT-10)",
      "docs/qa/adoption.md on `trunk` doesn't exist, so Kanon's default applies: it is `off`, and the Overseer skips the capability review (K-LAYOUT-10)",
    ]);
    expect(capabilityWatchCli({ repo: 'o/r', run: run(() => RECORD([])) })).toEqual({ code: 0, out: 'off', notes: [`capability-watch: ${notes[0]}`] });
  });

  it('fails by name on a malformed record, an unreadable one, and no default branch', () => {
    expect(() => readCapabilityWatchFrom('o/r', run(() => RECORD([BULLET, BULLET])))).toThrow(/repeats `Capability watch`/);
    expect(() => readCapabilityWatchFrom('o/r', run(fail('gh: Server Error (HTTP 502)')))).toThrow(/couldn't be read from `trunk`: gh: Server Error \(HTTP 502\)/);
    expect(() => readCapabilityWatchFrom('o/r', () => '\n')).toThrow(/no default branch to read docs\/qa\/adoption\.md from/);
  });

  it('the CLI prints the value, and exits 1 or 2 by name', () => {
    expect(capabilityWatchCli({ repo: 'o/r', run: run(() => RECORD([BULLET])) })).toEqual({ code: 0, out: 'on' });
    expect(capabilityWatchCli({ repo: 'o/r', run: run(() => RECORD([`- **${LABEL}:**`])) }).code).toBe(1);
    expect(capabilityWatchCli({ repo: '' })).toEqual({ code: 2, out: 'capability-watch: GITHUB_REPOSITORY must be set' });
  });
});
