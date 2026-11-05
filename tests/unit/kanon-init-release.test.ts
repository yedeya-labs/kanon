import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { releaseCallerFile, releaseConfigFile, releaseManifestFile, versionFile, CHANGELOG_SECTIONS } from '../../cli/release-files.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { ROOT, PINNED, checkout, fakeGitHub, run, read, parse } from './helpers/kanon-init.js';

// Its cases run `kanon init` against a real git checkout, so every case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// kanon#1553 (the Owner, 2026-11-01): `kanon init` writes the release workflow when the person
// chooses releases or a deploy environment, since the deploy lane runs only on a published
// release: the caller, release-please's configuration and manifest, and `version.txt`, as
// docs/release.md gives them. The same answer recommends the Releaser. It never overwrites a file.

const DOC = readFileSync(join(ROOT, 'docs/release.md'), 'utf8');
/** The fenced block of docs/release.md that follows `after`, its fence's language `lang`. */
const block = (after: string, lang: string) => {
  const at = DOC.indexOf(after);
  if (at < 0) throw new Error(`docs/release.md has no "${after}"`);
  const m = DOC.slice(at).match(new RegExp('```' + lang + '\\n([\\s\\S]*?)```'));
  if (!m) throw new Error(`docs/release.md has no ${lang} block after "${after}"`);
  return m[1]!;
};

const CALLER = '.github/workflows/release.yml';
const CONFIG = 'release-please-config.json';
const MANIFEST = '.release-please-manifest.json';
const VERSION = 'version.txt';
const SECRETS = { RELEASER_APP_ID: '${{ secrets.RELEASER_APP_ID }}', RELEASER_APP_PRIVATE_KEY: '${{ secrets.RELEASER_APP_PRIVATE_KEY }}' };
const KANON_CALLER = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';

describe('the release files kanon init writes are docs/release.md\'s (kanon#1553)', () => {
  it('writes the caller of "A thin caller", byte for byte, at the page\'s pin', () => {
    const doc = block('### 1. A thin caller', 'yaml');
    const pin = doc.match(/release\.yml@(\S+)/)![1]!;
    expect(releaseCallerFile(pin, 'main', false)).toBe(doc);
  });

  it('maps the Releaser\'s two secrets by name with the Releaser, as the page\'s bullet says, and never inherits', () => {
    const wf = parseYaml(releaseCallerFile(PINNED, 'trunk', true)) as { on: { push: { branches: string[] } }; jobs: { release: { secrets: unknown; uses: string } } };
    expect(wf.on.push.branches).toEqual(['trunk']);
    expect(wf.jobs.release.uses).toBe(`yedeya-labs/kanon/.github/workflows/release.yml@${PINNED}`);
    expect(wf.jobs.release.secrets).toEqual(SECRETS);
    expect(DOC).toContain('mapping `RELEASER_APP_ID: ${{ secrets.RELEASER_APP_ID }}` and `RELEASER_APP_PRIVATE_KEY: ${{ secrets.RELEASER_APP_PRIVATE_KEY }}`');
    expect(releaseCallerFile(PINNED, 'main', false)).not.toMatch(/secrets|inherit/);
  });

  it('writes "Your release configuration", byte for byte: the simple type, Kanon\'s eleven sections, a 0.0.0 manifest and version.txt', () => {
    expect(releaseConfigFile('your-project')).toBe(block('\n`release-please-config.json`\n', 'json'));
    expect(releaseManifestFile()).toBe(block('\n`.release-please-manifest.json`\n', 'json'));
    expect(versionFile()).toBe(block('`version.txt`, for the `simple` type', 'text'));
    const config = JSON.parse(releaseConfigFile('widgets'));
    expect(config.packages['.']['release-type']).toBe('simple');
    expect(config.packages['.']['package-name']).toBe('widgets');
    // K-SHIP-4: the eleven types, none hidden, as Kanon's own configuration lists them.
    expect(CHANGELOG_SECTIONS).toHaveLength(11);
    const own = JSON.parse(read(ROOT, CONFIG)).packages['.']['changelog-sections'];
    expect(config.packages['.']['changelog-sections']).toEqual(own);
  });
});

describe('kanon init and the release workflow (kanon#1553)', () => {
  const init = async (files: Record<string, string>, argv: string[]) => {
    const dir = checkout(files);
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', ...argv]));
    const status = (p: string) => d.files.find((f) => f.path === p)?.status;
    const summary = d.summary.find((l) => l.answer === 'Releases');
    return { dir, d, status, summary };
  };

  it('writes the caller, the configuration, the manifest and version.txt for a deploy environment, and recommends the Releaser', async () => {
    const { dir, d, status, summary } = await init({}, ['--deploy-environments', 'production']);
    expect(d.exitCode).toBe(0);
    for (const p of [CALLER, CONFIG, MANIFEST, VERSION]) expect(status(p), p).toBe('new');
    expect(d.answers.releaser).toBe(true);
    expect(summary).toMatchObject({ source: 'inferred', reason: 'a deploy environment: a release made without the Releaser starts no deploy run' });
    expect(summary?.value).toContain(`${CALLER} and release-please's configuration, written by init`);
    expect(read(dir, CALLER)).toBe(releaseCallerFile(PINNED, 'main', true));
    expect(JSON.parse(read(dir, CONFIG)).packages['.']['package-name']).toBe('widgets');
    expect(read(dir, MANIFEST)).toBe(releaseManifestFile());
    expect(read(dir, VERSION)).toBe('0.0.0\n');
  });

  it('still writes the release workflow for a deploy environment without the Releaser, and says what that leaves', async () => {
    const { dir, d, status, summary } = await init({}, ['--deploy-environments', 'production', '--no-releaser']);
    expect(d.answers.releaser).toBe(false);
    expect(status(CALLER)).toBe('new');
    expect(read(dir, CALLER)).toBe(releaseCallerFile(PINNED, 'main', false));
    expect(summary?.value).toBe('the release workflow, written by init for the deploy lane, without the Releaser App: a release it makes starts no deploy run');
  });

  it.each(['--releaser', '--releases'])('writes it for %s alone, with no deploy environment', async (flag) => {
    const { d, status } = await init({}, [flag]);
    expect(d.answers.releaser).toBe(true);
    for (const p of [CALLER, CONFIG, MANIFEST, VERSION]) expect(status(p), p).toBe('new');
  });

  it('writes none of them without releases or a deploy environment', async () => {
    const { dir, d, status, summary } = await init({}, []);
    expect(d.answers.releaser).toBe(false);
    for (const p of [CALLER, CONFIG, MANIFEST, VERSION]) {
      expect(status(p), p).toBeUndefined();
      expect(existsSync(join(dir, p)), p).toBe(false);
    }
    expect(summary).toMatchObject({ value: 'off', reason: 'no release workflow' });
  });

  it("leaves a caller of Kanon's release workflow and a configuration the repository has to the project, unplanned", async () => {
    const config = '{ "packages": { ".": { "release-type": "go" } } }\n';
    const { dir, status } = await init({ [CALLER]: KANON_CALLER, [CONFIG]: config, [MANIFEST]: '{ ".": "1.4.0" }\n' }, ['--deploy-environments', 'production']);
    for (const p of [CALLER, CONFIG, MANIFEST, VERSION]) expect(status(p), p).toBeUndefined();
    expect(read(dir, CALLER)).toBe(KANON_CALLER);
    expect(read(dir, CONFIG)).toBe(config);
    expect(existsSync(join(dir, VERSION))).toBe(false);
  });

  it('never overwrites a release workflow of the project\'s own: it differs, and nothing of release-please is added beside it', async () => {
    const own = 'name: Release\non: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make release\n';
    const { dir, status, d } = await init({ [CALLER]: own }, ['--releaser']);
    expect(status(CALLER)).toBe('differs');
    expect(read(dir, CALLER)).toBe(own);
    expect(d.files.find((f) => f.path === CALLER)?.content).toBe(releaseCallerFile(PINNED, 'main', true));
    for (const p of [CONFIG, MANIFEST, VERSION]) expect(status(p), p).toBeUndefined();
  });

  // kanon#1586: never committed, the project's own workflow still isn't init's to replace, flag or no.
  it("never replaces a release workflow of the project's own, never committed, even with --replace-uncommitted", async () => {
    const own = 'name: Release\non: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make release\n';
    for (const flags of [['--releaser'], ['--releaser', '--replace-uncommitted']]) {
      const { dir, status, d } = await init({ [CALLER]: own }, flags);
      expect(status(CALLER), flags.join(' ')).toBe('differs');
      expect(read(dir, CALLER)).toBe(own);
      expect(d.changes.map((c) => String(c.subject))).not.toContain(CALLER);
      // Nor offered to the flag: the note names only files init may have written.
      expect(d.notes.join('\n')).not.toMatch(/Never committed, and differ from what init writes: [^\n]*\.github\/workflows\/release\.yml/);
      expect(d.summary.find((l) => l.answer === 'Files')?.value).not.toContain('replaced');
      for (const p of [CONFIG, MANIFEST, VERSION]) expect(status(p), p).toBeUndefined();
    }
  });

  it('still replaces, with the flag, an uncommitted file init writes that nothing marks as the project\'s', async () => {
    // A lane caller an earlier init wrote at another release, never committed: init's own, so the flag replaces it.
    const lane = '.github/workflows/agent-review.yml';
    const { d } = await init({ [lane]: 'name: Review (Reviewer)\non: pull_request\njobs:\n  review:\n    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.0.1\n' }, ['--replace-uncommitted']);
    expect(d.files.find((f) => f.path === lane)?.status).toBe('replaced');
  });

  it('leaves what it wrote alone on a second run, and a manifest and version.txt release-please moved', async () => {
    const first = await init({}, ['--deploy-environments', 'production']);
    const written = read(first.dir, CALLER);
    const again = parse(await run(first.dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--deploy-environments', 'production']));
    // Its caller now calls Kanon's release workflow, so it is the project's, and Dependabot moves its pin.
    for (const p of [CALLER, CONFIG, MANIFEST, VERSION]) expect(again.files.find((f) => f.path === p), p).toBeUndefined();
    expect(read(first.dir, CALLER)).toBe(written);
    const moved = await init({ [MANIFEST]: '{\n  ".": "0.3.0"\n}\n', [VERSION]: '0.3.0\n' }, ['--deploy-environments', 'production']);
    expect(moved.status(CONFIG)).toBe('new');
    expect(moved.status(MANIFEST)).toBeUndefined();
    expect(moved.status(VERSION)).toBeUndefined();
    expect(read(moved.dir, VERSION)).toBe('0.3.0\n');
  });
});
