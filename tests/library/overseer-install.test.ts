import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LABEL, checkOverseerInstall, parseOverseerInstall } from '../../scripts/lib/overseer-install.mjs';

/**
 * Plan 0004 step 13, decision 12, `K-LAYOUT-10`: the Overseer is an optional lane, so the adoption
 * record says whether it is installed, under `## Choices`, and `lane-check` holds that to the
 * callers on disk (`tests/unit/lane-check-tick-lanes.test.ts` runs it end to end).
 */
const RECORD = (choices: string[], tail = '') =>
  ['# Adoption record', '', '## People', '', '- Owner: someone', '', '## Choices', '', ...choices, '', tail].join('\n');
const BULLET = `- **${LABEL}:** \`installed\``;

describe('the declaration', () => {
  it('reads `installed` and `not installed` under `## Choices`, beside the other choices', () => {
    expect(parseOverseerInstall(RECORD(['- **Chat channel:** #team', BULLET, '- **Reference environment:** `staging`']))).toBe('installed');
    expect(parseOverseerInstall(RECORD([`* **${LABEL}:** \`not installed\`  `]))).toBe('not installed');
    expect(parseOverseerInstall(RECORD([BULLET]).replace(/\n/g, '\r\n'))).toBe('installed');
  });

  it('declares nothing without the bullet, or with it only inside a code fence', () => {
    expect(parseOverseerInstall(RECORD(['- **Chat channel:** none']))).toBeNull();
    expect(parseOverseerInstall(RECORD(['```markdown', BULLET, '```']))).toBeNull();
  });

  it.each([
    ['twice', RECORD([BULLET, BULLET]), /adoption\.md:10 repeats `Overseer`, already declared on line 9 \(K-LAYOUT-10\)/],
    ['outside `## Choices`', `# Adoption record\n\n${BULLET}\n\n## Choices\n`, /adoption\.md:3 declares whether the Overseer is installed outside `## Choices`/],
    ['with no `## Choices` at all', `# Adoption record\n\n${BULLET}\n`, /outside `## Choices`/],
    ['in another shape', RECORD([`- **${LABEL}:** installed`]), /adoption\.md:9, under `## Choices`, isn't a declaration/],
    ['as a numbered item', RECORD([`1. **${LABEL}:** \`installed\``]), /isn't a declaration/],
    ['with something after the value', RECORD([`${BULLET} since May`]), /isn't a declaration/],
    ['with another value', RECORD([`- **${LABEL}:** \`yes\``]), /adoption\.md:9: `Overseer` is `yes`; write `installed` or `not installed`/],
    ['with an empty value', RECORD([`- **${LABEL}:** \`\``]), /`Overseer` is ``; write/],
    ['in a fence that never closes', RECORD(['```', BULLET]), /opens a code fence that never closes/],
  ])('refuses one %s, by line', (_name, text, message) => {
    expect(() => parseOverseerInstall(text)).toThrow(message);
  });
});

describe('held to the callers', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const tree = (record: string | null) => {
    dir = mkdtempSync(join(tmpdir(), 'overseer-install-'));
    if (record !== null) {
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, 'docs/qa/adoption.md'), record);
    }
    return dir;
  };

  it('accepts what is true: `installed` with a caller, `not installed` without one', () => {
    expect(checkOverseerInstall({ root: tree(RECORD([BULLET])), caller: true })).toEqual({ value: 'installed', defaults: [] });
    expect(checkOverseerInstall({ root: tree(RECORD([`- **${LABEL}:** \`not installed\``])), caller: false })).toEqual({ value: 'not installed', defaults: [] });
  });

  it("reads no record, with no caller, as Kanon's default, `not installed`, and names it (plan 0005 §5.2)", () => {
    expect(checkOverseerInstall({ root: tree(null), caller: false })).toEqual({
      value: 'not installed',
      defaults: ["docs/qa/adoption.md doesn't exist, so Kanon's default applies: the Overseer is `not installed` (K-LAYOUT-10)"],
    });
  });

  it("reads a record that doesn't say, with no caller, as the default, and names it", () => {
    expect(checkOverseerInstall({ root: tree(RECORD(['- **Chat channel:** none'])), caller: false })).toEqual({
      value: 'not installed',
      defaults: ["docs/qa/adoption.md doesn't say whether the Overseer is installed, so Kanon's default applies: the Overseer is `not installed` (K-LAYOUT-10)"],
    });
  });

  it('refuses a record that does not say beside a caller: the default contradicts it', () => {
    expect(() => checkOverseerInstall({ root: tree(RECORD(['- **Chat channel:** none'])), caller: true }))
      .toThrow(/doesn't say whether the Overseer is installed, so it reads as Kanon's default, `not installed`, but a workflow calls the Overseer's lane/);
  });

  it('refuses a record the callers contradict', () => {
    expect(() => checkOverseerInstall({ root: tree(RECORD([`- **${LABEL}:** \`not installed\``])), caller: true }))
      .toThrow(/says the Overseer is `not installed`, but a workflow calls its lane/);
    expect(() => checkOverseerInstall({ root: tree(RECORD([BULLET])), caller: false }))
      .toThrow(/says the Overseer is `installed`, but no workflow calls its lane/);
  });

  it('refuses a caller with no record', () => {
    expect(() => checkOverseerInstall({ root: tree(null), caller: true })).toThrow(/doesn't exist, so it reads as Kanon's default, `not installed`, but a workflow calls the Overseer's lane/);
  });
});
