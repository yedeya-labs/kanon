import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pluginSettingsFile, readPluginDeclaration } from '../../cli/plugin.mjs';

// K-ADOPT-11: an adopter pins Kanon to an exact version, and copies the `uses:` line from
// Kanon's documentation to do it. A stale version there sends a new adopter to an old
// release, so release-please rewrites every such reference in the release PR: each file is
// listed under `extra-files`, and each reference sits between
// `<!-- x-release-please-start-version -->` and `<!-- x-release-please-end -->` (or on a line
// carrying `x-release-please-version`). Its generic updater replaces the FIRST X.Y.Z on each
// line it covers, and nothing else.
//
// The files are found from the tree, not from a list, so a new README with a reference is
// caught without anyone remembering to add it here. Three kinds of Markdown are left out:
// the changelog and the decision and plan records, which describe the past, and the
// rulebook, which states the form (`@vX.Y.Z`) rather than a line to copy.

const root = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const version = (JSON.parse(read('package.json')) as { version: string }).version;
const config = JSON.parse(read('release-please-config.json')) as {
  packages: Record<string, { 'extra-files'?: unknown[] }>;
};
const extraFiles = config.packages['.']?.['extra-files'] ?? [];

const HISTORY = /^(CHANGELOG\.md|docs\/(decisions|plans)\/)/;
const FORM_ONLY = /^rulebook\//;
// `uses:` paths pin with `@`; the `npx` line that runs `kanon apps` (docs/apps.md) pins the
// git package with `#`; the kanon plugin's declaration in `.claude/settings.json` (docs/skills.md,
// #376) pins its marketplace with a `"ref"` beside the repository, on one line.
const REF = /yedeya-labs\/kanon(?:\/[^\s`'"@]+@|#|", "ref": ")([^\s`'")|]+)/g;
const SEMVER = /\d+\.\d+\.\d+/g;
const INLINE = /x-release-please-version/;
const START = /x-release-please-start-version/;
const END = /x-release-please-end/;

const markdown = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !HISTORY.test(f));

type Line = { at: string; text: string; refs: string[]; covered: boolean };

/** Each line of a file, with the Kanon references on it and whether release-please rewrites it. */
const scan = (file: string, text: string): Line[] => {
  let inBlock = false;
  return text.split(/\r?\n/).map((line, i) => {
    let covered = false;
    if (INLINE.test(line)) covered = true;
    else if (inBlock) {
      covered = true;
      if (END.test(line)) inBlock = false;
    } else if (START.test(line)) inBlock = true;
    return { at: `${file}:${i + 1}`, text: line, refs: [...line.matchAll(REF)].map((m) => m[1] ?? ''), covered };
  });
};

const docs = markdown.filter((f) => !FORM_ONLY.test(f)).map((file) => ({ file, lines: scan(file, read(file)) }));
const withRefs = docs.filter((d) => d.lines.some((l) => l.refs.length > 0));

describe('K-ADOPT-11 the version references an adopter copies stay current', () => {
  it('finds the references, so the checks below are not vacuous', () => {
    expect(withRefs.map((d) => d.file)).toContain('README.md');
    expect(withRefs.filter((d) => d.file.startsWith('actions/')).length).toBeGreaterThanOrEqual(8);
  });

  it("every reference names package.json's version", () => {
    const stale = withRefs.flatMap((d) => d.lines.flatMap((l) => l.refs.filter((r) => r !== `v${version}`).map((r) => `${l.at}: @${r}`)));
    expect(stale).toEqual([]);
  });

  it('every reference is on a line release-please rewrites', () => {
    const unmarked = withRefs.flatMap((d) => d.lines.filter((l) => l.refs.length > 0 && !l.covered).map((l) => l.at));
    expect(unmarked).toEqual([]);
  });

  it('every file holding a reference is in extra-files, and nothing else is', () => {
    const markdownFiles = extraFiles.filter((f): f is string => typeof f === 'string');
    expect(markdownFiles.sort()).toEqual(withRefs.map((d) => d.file).sort());
  });

  // The skills' plugin (docs/skills.md) carries the release as its own version, which an adopter
  // installs it at (K-ADOPT-11's "an exact plugin version"). It is JSON, so release-please's
  // json updater rewrites it, at the one path that holds it; it is the only non-Markdown entry.
  it("the skills' plugin manifest carries package.json's version, and a release rewrites it", () => {
    const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { version?: string };
    expect(manifest.version).toBe(version);
    expect(extraFiles.filter((f) => typeof f !== 'string')).toEqual([
      { type: 'json', path: '.claude-plugin/plugin.json', jsonpath: '$.version' },
      { type: 'json', path: '.claude/settings.json', jsonpath: '$.extraKnownMarketplaces.kanon.source.ref' },
    ]);
  });

  // Kanon declares its own plugin as any adopter can (docs/skills.md, #376), and release-please
  // moves the declaration's `ref` with each release. Its json updater replaces the X.Y.Z inside
  // the value and keeps the `v`; the file must hold the declaration `kanon doctor` reads, at the
  // jsonpath above, or the updater would skip it with only a warning.
  it("Kanon's own declaration of the plugin pins package.json's version, where a release rewrites it", () => {
    const settings = JSON.parse(read('.claude/settings.json')) as { extraKnownMarketplaces: { kanon: { source: { ref: string } } } };
    expect(settings.extraKnownMarketplaces.kanon.source.ref).toBe(`v${version}`);
    expect(readPluginDeclaration(read('.claude/settings.json'))).toEqual({ status: 'declared', name: 'kanon', ref: `v${version}`, enabled: true });
    expect(read('.claude/settings.json')).toBe(pluginSettingsFile(`v${version}`));
  });

  it('a release rewrites every reference and nothing else', () => {
    // The generic updater's rule, applied with the next version: replace the first X.Y.Z on
    // each covered line. A covered line holding another version, or two, would have the
    // wrong one rewritten.
    const next = '999.0.0';
    for (const { lines } of withRefs) {
      for (const l of lines.filter((x) => x.covered)) {
        const after = l.text.replace(/\d+\.\d+\.\d+/, next);
        const expected = l.refs.length > 0 ? l.text.replace(new RegExp(`([@#]|"ref": ")v${version.replaceAll('.', '\\.')}`, 'g'), `$1v${next}`) : l.text;
        expect(after, l.at).toBe(expected);
        expect((l.text.match(SEMVER) ?? []).length, l.at).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the rulebook states the form, never a version that would go stale', () => {
    const concrete = markdown
      .filter((f) => FORM_ONLY.test(f))
      .flatMap((file) => scan(file, read(file)))
      .flatMap((l) => l.refs.filter((r) => r !== 'vX.Y.Z').map((r) => `${l.at}: @${r}`));
    expect(concrete).toEqual([]);
  });
});
