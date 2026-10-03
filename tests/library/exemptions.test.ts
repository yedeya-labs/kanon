import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeclarationError, parseExemptions, readExemptions } from '../../scripts/lib/exemptions.mjs';
import { auditPaths } from '../../scripts/doc-path-guard.mjs';

/**
 * kanon#54: what a guard exempts by name is the adopter's, declared in `docs/qa/exemptions.md`
 * (`K-LAYOUT-15`). These tests run in the fixture adopter (`tests/fixtures/adopter`), whose file
 * declares one pre-standard brief and one path mention.
 */

const FILE = (briefs: string, mentions: string) =>
  `# Exemptions\n\n## Pre-standard briefs\n\n${briefs}\n## Path mentions\n\n${mentions}\n`;
const TABLE = '| File | Path | Reason |\n|---|---|---|\n';

const fails = (text: string, message: RegExp) => {
  expect(() => parseExemptions(text)).toThrow(DeclarationError);
  expect(() => parseExemptions(text)).toThrow(message);
};

describe('the exemptions file parser', () => {
  it('reads both sections, each entry with its reason and line, and leaves prose alone', () => {
    const file = parseExemptions(FILE('Prose first.\n- `docs/projects/12.md` — approved before the standard\n', `${TABLE}| \`docs/a.md\` | \`docs/TODO.md\` | history |\n`));
    expect(file.briefs).toEqual([{ brief: 'docs/projects/12.md', reason: 'approved before the standard', line: 6 }]);
    expect(file.mentions).toEqual([{ file: 'docs/a.md', path: 'docs/TODO.md', reason: 'history', line: 12 }]);
  });

  it('takes a section with no entries as a declaration that nothing is exempt', () => {
    expect(parseExemptions(FILE('None.\n', 'None.\n'))).toEqual({ briefs: [], mentions: [] });
  });

  it('stops each section at the next heading, so a later section is never read as entries', () => {
    const later = '## Notes\n\n- `docs/projects/9.md` — not an entry here\n\n| File | Path | Reason |\n|---|---|---|\n| `a.md` | `b.md` | nor this |\n';
    expect(parseExemptions(`${FILE('', '')}${later}`)).toEqual({ briefs: [], mentions: [] });
    expect(parseExemptions(`# Exemptions\n\n## Pre-standard briefs\n\n${later}\n## Path mentions\n`)).toEqual({ briefs: [], mentions: [] });
  });

  it('ignores a heading or an entry inside a fenced block', () => {
    expect(parseExemptions(FILE('```\n- `docs/projects/1.md` — x\n## Path mentions\n```\n', '')).briefs).toEqual([]);
  });

  it('fails by name when a heading is missing or doubled', () => {
    fails('## Pre-standard briefs\n', /docs\/qa\/exemptions\.md has no `## Path mentions` heading/);
    fails('## Path mentions\n', /has no `## Pre-standard briefs` heading/);
    fails(`${FILE('', '')}## Path mentions\n`, /has the `## Path mentions` heading 2 times/);
  });

  it('fails by name, with the line, on an entry it cannot read', () => {
    fails(FILE('- `docs/projects/12.md` - a hyphen\n', ''), /exemptions\.md:5, under `## Pre-standard briefs`, isn't an entry/);
    fails(FILE('- `docs/projects/_template.md` — not a brief\n', ''), /:5, under `## Pre-standard briefs`/);
    fails(FILE('- `docs/projects/12.md` —\n', ''), /:5, under `## Pre-standard briefs`/);
    fails(FILE('', '| File | Reason |\n|---|---|\n'), /isn't the table's header/);
    fails(FILE('', '| File | Path | Reason |\n| `a.md` | `b.md` | x |\n'), /needs a `\|---\|---\|---\|` row/);
    fails(FILE('', `${TABLE}| docs/a.md | \`docs/b.md\` | no backticks |\n`), /exemptions\.md:10, under `## Path mentions`, isn't an entry/);
    fails(FILE('', `${TABLE}| \`docs/a.md\` | \`docs/b.md\` |  |\n`), /:10, under `## Path mentions`, isn't an entry/);
    fails(FILE('', `${TABLE}| \`docs/a.md\` | \`docs/b.md\` | x | extra |\n`), /:10, under `## Path mentions`, isn't an entry/);
    fails(`${FILE('', '')}\`\`\`\n`, /opens a code fence that never closes/);
  });

  it('fails on an entry listed twice', () => {
    fails(FILE('- `docs/projects/1.md` — a\n- `docs/projects/1.md` — b\n', ''), /exemptions\.md:6 repeats the entry on line 5/);
    fails(FILE('', `${TABLE}| \`a.md\` | \`b.md\` | x |\n| \`a.md\` | \`b.md\` | y |\n`), /:11 repeats the entry on line 10/);
  });
});

describe('reading the exemptions file', () => {
  it("reads the fixture adopter's file from the working tree", () => {
    const file = readExemptions();
    expect(file.briefs.map((b) => b.brief)).toEqual(['docs/projects/2.md']);
    expect(file.mentions.map((m) => [m.file, m.path])).toEqual([['docs/history.md', 'docs/TODO.md']]);
  });

  it('fails by name when the tree has none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exemptions-'));
    try {
      expect(() => readExemptions(dir)).toThrow(/docs\/qa\/exemptions\.md doesn't exist\. Every adopter keeps one/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doc-path-guard exempts exactly the declared mentions (kanon#54)', () => {
  const text = 'Tracked in `docs/TODO.md` once.\n';

  it('exempts a declared (file, path) pair, and no other file or path', () => {
    const exemptions = readExemptions().mentions;
    expect(auditPaths(['docs/history.md'], () => text, ['docs/history.md'], exemptions)).toMatchObject({ findings: [], exemptionsUsed: new Set([0]) });
    expect(auditPaths(['docs/other.md'], () => text, ['docs/other.md'], exemptions).findings).toHaveLength(1);
    expect(auditPaths(['docs/history.md'], () => text, ['docs/history.md'], []).findings).toHaveLength(1);
  });

  it('refuses to audit with no exemptions argument, rather than run with none', () => {
    // @ts-expect-error -- the missing argument is the point
    expect(() => auditPaths(['docs/a.md'], () => '', ['docs/a.md'])).toThrow(/needs the declared path-mention exemptions/);
  });
});
