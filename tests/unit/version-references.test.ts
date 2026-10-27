import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pluginSettingsFile, readPluginDeclaration } from '../../cli/plugin.mjs';

// K-ADOPT-11: an adopter pins Kanon to an exact version, and copies the `uses:` line from
// Kanon's documentation to do it. Each such reference sits between
// `<!-- x-release-please-start-version -->` and `<!-- x-release-please-end -->` (or on a line
// carrying `x-release-please-version`), and two things rewrite it, by which release it must name:
//   - What ships inside a release, the skills (read at the plugin's release) and the notify
//     hooks' YAML (which `kanon init` copies as it is), names that release: release-please
//     rewrites it in the release PR, each file listed under `extra-files`. Its generic updater
//     replaces the FIRST X.Y.Z on each line it covers, and nothing else.
//   - The rest of the documentation, which a reader copies from the default branch, names the
//     latest stable release, which exists: the promotion rewrites it with
//     `scripts/doc-pins.mjs move` once it tags one, and CI's `doc-pins.mjs check` fails a
//     reference to anything else. On Kanon a release PR tags a candidate, so a reference it
//     rewrote named a tag that didn't exist until promotion (0.42.0's README, for a week).
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
// The hook files `kanon init` writes into an adopter's repository (plan 0011 §7.1): YAML, not
// Markdown, but each pins Kanon's prebuilt hook action by release, and `init` copies the line as
// it is, so a release rewrites it like any reference an adopter copies (its inline marker).
const hookFiles = execFileSync('git', ['ls-files', 'actions/notify/hooks/*.yml'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

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

const docs = [...markdown.filter((f) => !FORM_ONLY.test(f)), ...hookFiles].map((file) => ({ file, lines: scan(file, read(file)) }));
const withRefs = docs.filter((d) => d.lines.some((l) => l.refs.length > 0));
// What ships inside a release names that release; the rest of the documentation, the stable one.
const SHIPPED = /^(skills\/|actions\/notify\/hooks\/)/;
const shipped = withRefs.filter((d) => SHIPPED.test(d.file));
const stableDocs = withRefs.filter((d) => !SHIPPED.test(d.file));
const refsOf = (ds: typeof withRefs): string[] => ds.flatMap((d) => d.lines.flatMap((l) => l.refs));
const semverOf = (ref: string): number[] => (ref.match(/\d+\.\d+\.\d+/)?.[0] ?? '').split('.').map(Number);

describe('K-ADOPT-11 the version references an adopter copies stay current', () => {
  it('finds the references, so the checks below are not vacuous', () => {
    expect(withRefs.map((d) => d.file)).toContain('README.md');
    expect(withRefs.filter((d) => d.file.startsWith('actions/')).length).toBeGreaterThanOrEqual(8);
    expect(withRefs.map((d) => d.file)).toContain('actions/notify/hooks/slack.yml');
    expect(shipped.map((d) => d.file)).toContain('skills/adopt/SKILL.md');
    expect(stableDocs.map((d) => d.file)).toContain('README.md');
  });

  it("every reference in what ships inside a release names package.json's version", () => {
    const stale = shipped.flatMap((d) => d.lines.flatMap((l) => l.refs.filter((r) => r !== `v${version}`).map((r) => `${l.at}: @${r}`)));
    expect(stale).toEqual([]);
  });

  // That the release is published is CI's `doc-pins.mjs check`, which reads the remote's tags;
  // this test reads nothing over the network, so it holds what it can: one stable release, never
  // a candidate, and none ahead of the version this tree releases.
  it('the documentation names one stable release, no later than package.json\'s version', () => {
    const named = [...new Set(refsOf(stableDocs))];
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/^v\d+\.\d+\.\d+$/);
    const [a = 0, b = 0, c = 0] = semverOf(named[0] ?? '');
    const [x = 0, y = 0, z = 0] = semverOf(version);
    expect(a * 1e6 + b * 1e3 + c).toBeLessThanOrEqual(x * 1e6 + y * 1e3 + z);
  });

  it('every reference is on a line release-please rewrites', () => {
    const unmarked = withRefs.flatMap((d) => d.lines.filter((l) => l.refs.length > 0 && !l.covered).map((l) => l.at));
    expect(unmarked).toEqual([]);
  });

  it('every file shipped with a reference is in extra-files, and nothing else is: the release PR leaves the documentation alone', () => {
    const markdownFiles = extraFiles.filter((f): f is string => typeof f === 'string');
    expect(markdownFiles.sort()).toEqual(shipped.map((d) => d.file).sort());
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
  // jsonpath above, or the updater would skip it with only a warning. The ref is that version's
  // stable release or its candidate, `candidate-vX.Y.Z`, which Kanon's pin job moves it to with
  // the callers (plan 0009 S4); the updater keeps either prefix.
  it("Kanon's own declaration of the plugin pins package.json's version, where a release rewrites it", () => {
    const settings = JSON.parse(read('.claude/settings.json')) as { extraKnownMarketplaces: { kanon: { source: { ref: string } } } };
    const ref = settings.extraKnownMarketplaces.kanon.source.ref;
    expect([`v${version}`, `candidate-v${version}`]).toContain(ref);
    expect(readPluginDeclaration(read('.claude/settings.json'))).toEqual({ status: 'declared', name: 'kanon', ref, enabled: true });
    expect(read('.claude/settings.json')).toBe(pluginSettingsFile(ref));
  });

  it('a release rewrites every reference and nothing else', () => {
    // The generic updater's rule, applied with the next version: replace the first X.Y.Z on
    // each covered line. A covered line holding another version, or two, would have the
    // wrong one rewritten.
    const next = '999.0.0';
    for (const { file, lines } of withRefs) {
      const own = SHIPPED.test(file) ? version : (refsOf(stableDocs)[0] ?? '').slice(1);
      for (const l of lines.filter((x) => x.covered)) {
        const after = l.text.replace(/\d+\.\d+\.\d+/, next);
        const expected = l.refs.length > 0 ? l.text.replace(new RegExp(`([@#]|"ref": ")v${own.replaceAll('.', '\\.')}`, 'g'), `$1v${next}`) : l.text;
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
