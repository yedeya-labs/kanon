#!/usr/bin/env node
// Moves every pin a repository holds on Kanon to one release (plan 0009 §6, its step S4). The
// upgrade skill's step 4, as a script, so the skill and Kanon's own pin job make the same edit:
//
//   node scripts/move-pins.mjs <release> [--root <dir>]
//
// `<release>` is an exact release, `vX.Y.Z` or `candidate-vX.Y.Z`. `--root` is the repository's
// checkout, the current directory by default. It moves, and nothing else:
//   - under `.github/`, every `yedeya-labs/kanon` reference pinned to an exact release: each
//     `@<release>` of a `uses:` line (`yedeya-labs/kanon/<path>@vX.Y.Z`), and each `#<release>`
//     of an `npx` line (`github:yedeya-labs/kanon#vX.Y.Z`);
//   - in `.claude/settings.json`, the `ref` of each marketplace whose source is the GitHub
//     repository `yedeya-labs/kanon`, when it names an exact release.
// A reference in a comment never moves: a `#` at the start of a line, or after a space, starts
// one, as in YAML and the shell, so a commented-out caller stays as its author left it. A ref
// that is not an exact release (`@main`, a commit) is left alone, as is every other character of
// every line. Prints each file it changed, one per line, relative to the root; exits 2 on a
// release that is not exact.
//
// A caller the release's lanes need changed (a secret, an input, a permission) is not this
// script's: the pin job checks the moved tree with `pin-lane-check.mjs` and lists each one in its
// pull request, and the upgrade skill makes the change with `kanon init` (kanon#1074).

import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { isCliEntry } from './lib/cli-entry.mjs';

/** An exact Kanon release, stable or candidate (plan 0009 §3), anchored at both ends. */
export const RELEASE = /^(?:candidate-)?v\d+\.\d+\.\d+$/;

const REPO = 'yedeya-labs/kanon';
const SETTINGS = '.claude/settings.json';

// `yedeya-labs/kanon`, an optional path inside it, then `@` (a `uses:` line) or `#` (an `npx`
// package spec), then an exact release not followed by anything a ref could continue with, so a
// pre-release suffix (`v1.2.3-rc.1`) or a longer name (`yedeya-labs/kanon-other`) never matches.
const PIN = /(?<![\w.-])(yedeya-labs\/kanon(?:\/[\w./-]*)?)([@#])((?:candidate-)?v\d+\.\d+\.\d+)(?![\w.-])/g;

/**
 * Where a line's code ends: the first `#` at the start of the line or after whitespace, which
 * starts a YAML or shell comment; the line's length when it has none.
 *
 * @param {string} line
 * @returns {number}
 */
export function codeEnd(line) {
  for (let i = 0; i < line.length; i++) if (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) return i;
  return line.length;
}

/**
 * Moves every Kanon pin in one file's text to `release`, outside comments.
 *
 * @param {string} text
 * @param {string} release
 * @returns {{ text: string, moved: number }}
 */
export function moveText(text, release) {
  let moved = 0;
  const lines = text.split('\n').map((line) => {
    const end = codeEnd(line);
    const code = line.slice(0, end).replace(PIN, (whole, ref, sigil, from) => {
      if (from === release) return whole;
      moved++;
      return `${ref}${sigil}${release}`;
    });
    return code + line.slice(end);
  });
  return { text: lines.join('\n'), moved };
}

/**
 * Sets the `ref` of each marketplace in `.claude/settings.json` that declares Kanon's
 * repository at an exact release. The edit is made in the text, so the file's layout is kept,
 * and checked against the parsed result.
 *
 * @param {string} text
 * @param {string} release
 * @returns {{ text: string, moved: number }}
 */
export function moveSettings(text, release) {
  const json = JSON.parse(text);
  const markets = json?.extraKnownMarketplaces;
  if (!markets || typeof markets !== 'object') return { text, moved: 0 };
  /** @type {string[]} */
  const from = [];
  for (const market of Object.values(markets)) {
    const source = market?.source;
    if (source?.source !== 'github' || source.repo !== REPO) continue;
    if (typeof source.ref !== 'string' || !RELEASE.test(source.ref) || source.ref === release) continue;
    from.push(source.ref);
    source.ref = release;
  }
  if (from.length === 0) return { text, moved: 0 };
  // Each moved ref, where it is the value of a `ref` key; then the result must parse to the
  // object edited above, or the file is written from it instead.
  let edited = text;
  for (const ref of new Set(from)) {
    const escaped = ref.replace(/[.]/g, '\\.');
    edited = edited.replace(new RegExp(`("ref"\\s*:\\s*")${escaped}(")`, 'g'), `$1${release}$2`);
  }
  let same = false;
  try {
    same = JSON.stringify(JSON.parse(edited)) === JSON.stringify(json);
  } catch {
    same = false;
  }
  return { text: same ? edited : `${JSON.stringify(json, null, 2)}\n`, moved: from.length };
}

/**
 * Every regular file under `dir`, recursively, never following a symbolic link.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Moves every Kanon pin in the checkout at `root` to `release`, and writes the files it changed.
 *
 * @param {{ root: string, release: string }} options
 * @returns {{ path: string, moved: number }[]} each file changed, relative to `root`, `/`-separated
 */
export function movePins({ root, release }) {
  if (!RELEASE.test(release)) throw new Error(`not an exact release: ${JSON.stringify(release)} (vX.Y.Z or candidate-vX.Y.Z)`);
  /** @type {{ path: string, moved: number }[]} */
  const changed = [];
  const write = (/** @type {string} */ path, /** @type {(text: string) => { text: string, moved: number }} */ edit) => {
    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) return;
    const result = edit(text);
    if (result.moved === 0 || result.text === text) return;
    writeFileSync(path, result.text);
    changed.push({ path: relative(root, path).split(sep).join('/'), moved: result.moved });
  };
  for (const path of filesUnder(join(root, '.github'))) write(path, (text) => moveText(text, release));
  const settings = join(root, SETTINGS);
  let isFile = false;
  try {
    isFile = lstatSync(settings).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) write(settings, (text) => moveSettings(text, release));
  return changed;
}

/**
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {{ code: number, out: string }}
 */
export function movePinsCli(argv, cwd = process.cwd()) {
  const args = [...argv];
  let root = cwd;
  const at = args.indexOf('--root');
  if (at >= 0) {
    root = args[at + 1] ?? '';
    args.splice(at, 2);
  }
  const [release, ...rest] = args;
  if (!release || rest.length > 0 || !root) return { code: 2, out: 'usage: move-pins.mjs <vX.Y.Z | candidate-vX.Y.Z> [--root <dir>]' };
  if (!RELEASE.test(release)) return { code: 2, out: `move-pins: not an exact release: ${JSON.stringify(release)} (vX.Y.Z or candidate-vX.Y.Z)` };
  const changed = movePins({ root, release });
  return { code: 0, out: changed.map((c) => c.path).join('\n') };
}

if (isCliEntry(import.meta.url)) {
  const { code, out } = movePinsCli(process.argv.slice(2));
  if (out) (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
