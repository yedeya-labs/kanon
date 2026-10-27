#!/usr/bin/env node
// The Kanon version Kanon's documentation tells a reader to pin: the latest stable release,
// never a candidate and never a version not yet tagged.
//
//   node scripts/doc-pins.mjs move <vX.Y.Z> [--root <dir>]
//   node scripts/doc-pins.mjs check [--root <dir>]
//
// A reader copies the install command and the `uses:` lines from the README and the docs on the
// default branch, which is what GitHub shows them. Until 2026-10-27 release-please rewrote those
// lines in each release PR, which on Kanon tags a candidate, so from the candidate's cut to its
// promotion the README's first command named a tag that didn't exist (for a week, for 0.42.0).
// So the documents follow the stable channel instead: `move` rewrites them to a stable release,
// which the promotion runs once it has tagged one (`.github/workflows/promote.yml`), and `check`,
// in CI, fails when one names anything but a published stable release.
//
// The documents are every tracked Markdown file holding a Kanon reference, except the history
// (the changelog, the decisions and the plans), the rulebook, which states the form
// (`@vX.Y.Z`), and the skills, which ship inside the plugin and are read at the release they
// came with, so release-please still rewrites them, as it does the notify hooks' YAML
// (`tests/unit/version-references.test.ts`). A reference counts only on a line between
// `<!-- x-release-please-start-version -->` and `<!-- x-release-please-end -->`, the markers the
// files already carry.
//
// `move` prints each file it changed, one per line, relative to the root. `check` reads the
// stable tags from the repository's remote, `git ls-remote`, which needs no token on a public
// repository, and exits 1 listing each reference that names anything else; 2 on a usage error.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isCliEntry } from './lib/cli-entry.mjs';

/** A stable Kanon release, anchored at both ends. */
export const STABLE = /^v\d+\.\d+\.\d+$/;

const REPO = 'yedeya-labs/kanon';

// A Kanon reference and its ref: `@` after a path (`uses:`), `#` (a git package or a marketplace
// spec), or a settings `"ref"` beside the repository on one line.
const REF = /yedeya-labs\/kanon(?:\/[^\s`'"@]+@|#|", "ref": ")([^\s`'")|]+)/g;
const START = /x-release-please-start-version/;
const END = /x-release-please-end/;
const LEFT_OUT = /^(CHANGELOG\.md|docs\/(decisions|plans)\/|rulebook\/|skills\/)/;

/**
 * @typedef {{ line: number, text: string, refs: string[], covered: boolean }} DocLine
 */

/**
 * Each line of a document, with the Kanon refs on it and whether it is between the markers.
 *
 * @param {string} text
 * @returns {DocLine[]}
 */
export function scanDoc(text) {
  let inBlock = false;
  return text.split('\n').map((line, i) => {
    let covered = false;
    if (inBlock) {
      covered = true;
      if (END.test(line)) inBlock = false;
    } else if (START.test(line)) inBlock = true;
    return { line: i + 1, text: line, refs: [...line.matchAll(REF)].map((m) => m[1] ?? ''), covered };
  });
}

/**
 * Rewrites each marked reference in one document to `version`, keeping its `v`.
 *
 * @param {string} text
 * @param {string} version a stable release, `vX.Y.Z`
 * @returns {string}
 */
export function moveDocText(text, version) {
  const bare = version.slice(1);
  return scanDoc(text)
    .map((l) => (l.covered && l.refs.length > 0 ? l.text.replace(/\d+\.\d+\.\d+/, bare) : l.text))
    .join('\n');
}

/**
 * What is wrong with the documents' references: one that isn't marked, one that isn't a stable
 * release, one whose release isn't tagged, and references that name more than one release.
 *
 * @param {{ path: string, text: string }[]} docs
 * @param {Set<string>} stableTags
 * @returns {string[]}
 */
export function docProblems(docs, stableTags) {
  const problems = [];
  const named = new Set();
  for (const { path, text } of docs) {
    for (const l of scanDoc(text)) {
      for (const ref of l.refs) {
        const at = `${path}:${l.line}`;
        if (!l.covered) problems.push(`${at}: ${ref} is outside the version markers, so the promotion can't move it`);
        else if (!STABLE.test(ref)) problems.push(`${at}: ${ref} is not a stable release; the docs name the latest stable release, vX.Y.Z`);
        else if (!stableTags.has(ref)) problems.push(`${at}: ${ref} is not a published release of ${REPO}; a reader who copies it gets an error`);
        else named.add(ref);
      }
    }
  }
  if (named.size > 1) problems.push(`the docs name ${named.size} releases, ${[...named].sort().join(', ')}: they name one, the latest stable`);
  return problems;
}

/**
 * The tracked documents holding a Kanon reference, as the header says.
 *
 * @param {string} root
 * @returns {{ path: string, text: string }[]}
 */
export function readDocs(root) {
  return execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !LEFT_OUT.test(f))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }))
    .filter((d) => scanDoc(d.text).some((l) => l.refs.length > 0));
}

/** @returns {Set<string>} */
function remoteStableTags() {
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', `https://github.com/${REPO}.git`], { encoding: 'utf8' });
  return new Set(out.split('\n').map((l) => l.split('refs/tags/')[1] ?? '').filter((t) => STABLE.test(t)));
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, tags?: () => Set<string> }} [io]
 * @returns {{ code: number, out: string }}
 */
export function docPinsCli(argv, { cwd = process.cwd(), tags = remoteStableTags } = {}) {
  const args = [...argv];
  let root = cwd;
  const at = args.indexOf('--root');
  if (at >= 0) {
    root = args[at + 1] ?? '';
    args.splice(at, 2);
  }
  const usage = { code: 2, out: 'usage: doc-pins.mjs move <vX.Y.Z> [--root <dir>] | doc-pins.mjs check [--root <dir>]' };
  const [command, ...rest] = args;
  if (!root) return usage;
  if (command === 'move' && rest.length === 1) {
    const version = rest[0] ?? '';
    if (!STABLE.test(version)) return { code: 2, out: `doc-pins: not a stable release: ${JSON.stringify(version)} (vX.Y.Z)` };
    const changed = [];
    for (const { path, text } of readDocs(root)) {
      const moved = moveDocText(text, version);
      if (moved !== text) {
        writeFileSync(join(root, path), moved);
        changed.push(path);
      }
    }
    return { code: 0, out: changed.join('\n') };
  }
  if (command === 'check' && rest.length === 0) {
    const problems = docProblems(readDocs(root), tags());
    if (problems.length === 0) return { code: 0, out: 'doc-pins: every reference in the docs names the published stable release' };
    return { code: 1, out: ['doc-pins: the docs send a reader to a release they can\'t install:', ...problems.map((p) => `  ${p}`), 'Fix: node scripts/doc-pins.mjs move <the latest stable vX.Y.Z>'].join('\n') };
  }
  return usage;
}

if (isCliEntry(import.meta.url)) {
  const { code, out } = docPinsCli(process.argv.slice(2));
  if (out) (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = code;
}
