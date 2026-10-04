import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeclarationError, parseExemptions, readExemptions } from '../../scripts/lib/exemptions.mjs';
import { auditPaths, reportFindings } from '../../scripts/doc-path-guard.mjs';

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

  it('reads a CRLF file as it reads an LF one, rather than as no entries', () => {
    const lf = FILE('- `docs/projects/12.md` — r\n', `${TABLE}| \`docs/a.md\` | \`docs/TODO.md\` | history |\n`);
    expect(parseExemptions(lf.replace(/\n/g, '\r\n'))).toEqual(parseExemptions(lf));
    expect(parseExemptions(lf.replace(/\n/g, '\r\n')).briefs).toHaveLength(1);
  });

  it('fails by name on a pre-standard entry in any other list form, rather than dropping it as prose', () => {
    for (const item of ['+ `docs/projects/12.md` — r', '1. `docs/projects/12.md` — r', '  - `docs/projects/12.md` — r', '> - `docs/projects/12.md` — r']) {
      fails(FILE(`${item}\n`, ''), /exemptions\.md:5, under `## Pre-standard briefs`, is a list item the file doesn't use/);
    }
  });

  it('fails by name on a list item under the path mentions, whose entries are table rows', () => {
    fails(FILE('', '- `docs/a.md` `docs/b.md` — r\n'), /exemptions\.md:8, under `## Path mentions`, is a list item/);
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

// kanon#176: the exemption row is read by the text-mention rule only, so the report must never
// offer it for an anchor, a link or a fence — following that advice used to produce a second red.
describe('doc-path-guard gives each rule a remedy that works for it (kanon#176)', () => {
  const tracked = ['docs/a.md', 'docs/b.md'];
  const target = '# B\n\n## Real heading\n';
  const findingsFor = (text: string) =>
    auditPaths(['docs/a.md'], (p: string) => (p === 'docs/a.md' ? text : target), tracked, []).findings;
  const cases = {
    text: 'See `docs/missing.md`.\n',
    link: 'See [it](./missing.md).\n',
    anchor: 'See [it](./b.md#gone-heading).\n',
    fence: '```\nnever closed\n',
  } as const;

  it.each(Object.entries(cases))('a %s finding gets its own remedy, and only `text` is offered an exemption', (rule, text) => {
    const findings = findingsFor(text);
    expect(findings.map((f: { rule: string }) => f.rule)).toEqual([rule]);
    const report = reportFindings(findings);
    expect(report).toMatch(/^doc-path-guard: 1 unresolvable citation\(s\):/);
    expect(report).not.toMatch(/name no file in the repository/);
    expect(report.includes('docs/qa/exemptions.md')).toBe(rule === 'text');
    if (rule !== 'text') expect(report).toMatch(/are not exemptible/);
  });

  it('names one remedy per rule present, each once', () => {
    const findings = findingsFor(cases.text + cases.link + cases.anchor + cases.text + cases.fence);
    const report = reportFindings(findings);
    expect(report).toMatch(/^doc-path-guard: 5 unresolvable citation\(s\):/);
    expect(report.match(/docs\/qa\/exemptions\.md/g)).toHaveLength(1);
    expect(report).toMatch(/Links are not exemptible/);
    expect(report).toMatch(/Anchors are not exemptible/);
    expect(report).toMatch(/Fences are not exemptible/);
  });

  it('an exemption row does not silence an anchor finding, which is why it is never offered for one', () => {
    const anchor = 'See [it](./b.md#gone-heading).\n';
    const row = [{ file: 'docs/a.md', path: './b.md#gone-heading', line: 1 }];
    const r = auditPaths(['docs/a.md'], (p: string) => (p === 'docs/a.md' ? anchor : target), tracked, row);
    expect(r.findings).toHaveLength(1);
    expect(r.exemptionsUsed.size).toBe(0);
  });
});
