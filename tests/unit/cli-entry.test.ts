import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { writeStub } from './helpers/stub-bin.js';

/**
 * kanon#191 — every script decides "am I the CLI?" through `realpath`.
 *
 * A script that compares its `import.meta.url` against the RAW `process.argv[1]` sees a
 * different path when run through a symlink (Node realpaths the main module before it
 * builds `import.meta.url`), and exits 0 having done nothing. A `file://${argv[1]}`
 * template also breaks on a path that URL-encodes. Neither fails anything: the script
 * just doesn't run.
 */
const ROOT = process.cwd();
// Every tree that holds a `.mjs` entry point outside tests/, `.github/scripts` included.
const DIRS = ['scripts', 'actions', 'infra', 'cli', '.github/scripts'];
const HELPER = join('scripts', 'lib', 'cli-entry.mjs');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
    return d.name.endsWith('.mjs') ? [p] : [];
  });

/** The file's code with `//` line comments and block comments removed, so prose about the idiom is not read as code. */
const code = (file: string): string =>
  readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const ARGV1 = /process\.argv(?:\[1\]|\.at\(1\))/g;
// The one inline form still accepted, for the scripts that already had it right:
// `pathToFileURL(realpathSync(process.argv[1] …)).href`, compared to `import.meta.url`,
// inside a `try`.
const INLINE = /try\s*\{\s*return import\.meta\.url === pathToFileURL\(realpathSync\((?:String\()?process\.argv\[1\](?: \?\? '')?\)?\)\)\.href;?\s*\}\s*catch/g;
const HELPER_CALL = /\bisCliEntry\(([^)]*)\)/g;

const sources = DIRS.flatMap(walk).filter((f) => f !== HELPER).sort();
const entryPoints = sources.filter((f) => {
  const c = code(f);
  return /\bisCliEntry\(/.test(c) || /process\.argv(?:\[1\]|\.at\(1\))/.test(c);
});

describe('isCliEntry', () => {
  const base = mkdtempSync(join(tmpdir(), 'cli entry #% é-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'real dir #1');
  mkdirSync(real);
  const script = join(real, 'tool.mjs');
  writeFileSync(script, '');
  const link = join(base, 'link');
  symlinkSync(real, link);
  const url = pathToFileURL(realpathSync(script)).href;

  it('is true for the module run by its own path, even one that URL-encodes', () => {
    expect(isCliEntry(url, script)).toBe(true);
  });

  it('is true for the module run through a symlinked directory', () => {
    expect(isCliEntry(url, join(link, 'tool.mjs'))).toBe(true);
  });

  it('is false when imported (no argv[1]), for a missing path, and for another file', () => {
    expect(isCliEntry(url, undefined)).toBe(false);
    expect(isCliEntry(url, join(base, 'nope.mjs'))).toBe(false);
    writeFileSync(join(real, 'other.mjs'), '');
    expect(isCliEntry(url, join(real, 'other.mjs'))).toBe(false);
  });

  it('compares against the url it is handed, not its own', () => {
    // A helper that compared against ITS OWN import.meta.url would be true only when the
    // helper itself is the entry point.
    const own = pathToFileURL(realpathSync(HELPER)).href;
    expect(isCliEntry(url, join(ROOT, HELPER))).toBe(false);
    expect(isCliEntry(own, join(ROOT, HELPER))).toBe(true);
  });
});

describe('every entry point uses the idiom', () => {
  it('finds the entry points, so the checks below are not vacuous', () => {
    expect(entryPoints.length).toBeGreaterThan(40);
    for (const dir of DIRS) expect(entryPoints.some((f) => f.startsWith(`${dir}/`)), dir).toBe(true);
  });

  it.each(sources)('%s', (file) => {
    const c = code(file);
    const calls = [...c.matchAll(HELPER_CALL)].map((m) => m[1]!.trim());
    for (const arg of calls) expect(arg, `${file}: isCliEntry must be handed the caller's import.meta.url`).toBe('import.meta.url');
    // Every mention of argv[1] must be inside the accepted inline form.
    const stray = c.replace(INLINE, '').match(ARGV1) ?? [];
    expect(stray, `${file} decides "am I the CLI?" from the raw argv[1]; use isCliEntry(import.meta.url) from ${HELPER}`).toEqual([]);
  });
});

/**
 * THE BEHAVIOUR, NOT THE SPELLING. Every run is from a fresh copy of the fixture adopter,
 * with `gh`, `git` and `aws` stubbed to fail and no GitHub environment, so nothing
 * reaches the network.
 *
 * Each entry point, with no arguments:
 *   · by its real path — the baseline, which must show the script ran (a non-zero exit or
 *     some output; every entry point here says something when called with nothing);
 *   · through a symlinked directory — must exit as the baseline did, and say something.
 *
 * And every module that EXPORTS anything, imported with no argv[1], must exit 0 and print
 * nothing — whether or not it has an entry check, so a script that loses its check
 * altogether (and so drops out of `entryPoints`) still fails here. A module with no export
 * is a run-only executable (`cli/kanon.mjs`), which nothing imports.
 */
describe('every entry point runs through a symlink, and every library module stays quiet when imported', () => {
  const base = mkdtempSync(join(tmpdir(), 'cli-entry-run-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  for (const tool of ['gh', 'git', 'aws']) {
    writeStub(join(bin, tool), `#!/usr/bin/env bash\nif [ -n "$STUB_OUT" ]; then echo "$STUB_OUT"; exit 0; fi\necho "stub ${tool}" >&2\nexit 1\n`);
  }
  const link = join(base, 'linked checkout');
  symlinkSync(ROOT, link);

  // A script that reports nothing when its only read fails needs that read to succeed.
  const EXTRA: Record<string, { env?: Record<string, string>; args?: string[] }> = {
    'actions/agent-finish/agent-quality-prs.mjs': {
      env: { REPO: 'o/r', STUB_OUT: '[]' },
      args: ['--label', 'x', '--issue', '1', '--opened-since', '2026-01-01T00:00:00Z'],
    },
  };

  // Several modules read the adopter's files (the App register, the spec floor) from the
  // working directory when they LOAD, so an empty directory would make them crash on
  // import — which looks like "ran" and would hide a broken entry check.
  const ADOPTER = join('tests', 'fixtures', 'adopter');
  const run = async (file: string, argv: string[]) => {
    const cwd = mkdtempSync(join(base, 'cwd-'));
    cpSync(ADOPTER, cwd, { recursive: true });
    // stdin is /dev/null: a script that reads stdin (issue-triage-defaults) sees EOF at once.
    return new Promise<{ status: number; out: string }>((done) => {
      const child = spawn(process.execPath, argv, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: cwd, ...EXTRA[file]?.env },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => done({ status: code ?? -1, out }));
    });
  };

  const libraries = sources.filter((f) => /^export\b/m.test(code(f)));

  it('finds library modules, and the run-only ones are few', () => {
    expect(libraries.length).toBeGreaterThan(60);
    expect(sources.length - libraries.length).toBeLessThan(5);
  });

  it.concurrent.each(entryPoints)('runs through a symlink: %s', async (file) => {
    const args = EXTRA[file]?.args ?? [];
    const direct = await run(file, [join(ROOT, file), ...args]);
    expect(direct.status !== 0 || direct.out.trim() !== '', `${file} did nothing even by its real path`).toBe(true);
    const linked = await run(file, [join(link, file), ...args]);
    expect(linked.status, `${file} through a symlink: ${linked.out}`).toBe(direct.status);
    expect(linked.out.trim() !== '' || linked.status !== 0, `${file} did nothing through a symlink`).toBe(true);
  }, 60_000);

  it.concurrent.each(libraries)('is quiet when imported: %s', async (file) => {
    const imported = await run(file, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(ROOT, file)).href)})`]);
    expect(imported, `${file} ran its CLI when imported`).toEqual({ status: 0, out: '' });
  }, 60_000);
});
