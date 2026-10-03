// The fixed table of test conventions, one row per language (kanon#20, ADR 0012).
//
// Several of Kanon's tools have to know three things about an adopter's tests: WHICH FILES
// ARE TESTS, WHAT A TEST IS CALLED (its title, where a spec id goes, `K-SPEC-6`), and HOW TO
// RUN ONE FILE of them. Until #20 the answer to all three was the reference adopter's:
// TypeScript files under `tests/` and `e2e/`, titles in `it('[AREA-1] …')`, and `npx vitest`.
//
// A FIXED TABLE, NOT A SETTING (ADR 0002). The adopter chooses nothing here. A file's own
// extension picks its row, so a repository is never "declared" to be one language: a Python
// service with a TypeScript front end has both rows, each for its own files. A language that
// is not in the table is never read, so an id its tests assert stays Bare and unverifiable —
// "nothing checked", the fail-safe reading — until a row is added for it.
//
// ADDING A LANGUAGE is one row here, and nothing in the tools that read it:
//   1. `extensions`, and `isTest`: the language's own test-file convention, as its standard
//      runner discovers files, never one Kanon invents;
//   2. `titles(text)`: where a test's title is written, and `mentions(text)`: the file with
//      its string literals blanked and its comments kept, so an id in fixture data is never
//      read as a citation (`spec-coverage.mjs` says why at length);
//   3. `comment`: the comment syntax, for the coordinates `citation-shift` maps;
//   4. `runner(file)` and its entry in `RUNNERS`: the command that runs ONE file through the
//      toolchain the adopter's project-setup hook installed, and how to read its report;
//   5. a fixture test for each of the four, beside `tests/library/test-conventions.test.ts`.

import { basename, dirname } from 'node:path';

/**
 * @typedef {'vitest' | 'playwright' | 'pytest' | 'go' | 'unknown'} Runner
 * @typedef {{
 *   language: string,
 *   extensions: string[],
 *   isTest: (path: string) => boolean,
 *   titleConvention: string,
 *   titles: ((text: string) => string) | null,
 *   mentions: ((text: string) => string) | null,
 *   comment: 'slash' | 'hash',
 *   runner: (path: string) => Runner,
 * }} Convention
 */

/**
 * A tokenised source file: `code` is the text with every string literal AND comment blanked
 * to spaces (newlines kept, so offsets still map to lines), `uncommented` blanks only the
 * strings, and `strings` maps a literal's start offset to its body.
 * @typedef {{ code: string, uncommented: string, strings: Map<number, { start: number, end: number, body: string }> }} Scan
 */

const blank = (/** @type {string} */ s) => s.replace(/[^\n]/g, ' ');

/**
 * Python: `#` comments, and strings with any prefix (`r`, `b`, `f`, `rb`, …), single or
 * triple quoted. A backslash always skips the next character, which is right for a raw
 * string too: `r"\""` does not end at its second quote.
 * @param {string} text
 * @returns {Scan}
 */
export function scanPython(text) {
  let code = '', uncommented = '';
  const strings = new Map();
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      code += blank(text.slice(i, end));
      uncommented += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      // The prefix is already copied as code; the literal starts where it does.
      const pre = /[rRbBuUfF]{1,2}$/.exec(text.slice(Math.max(0, i - 2), i))?.[0] ?? '';
      const start = pre && !/\w/.test(text[i - pre.length - 1] ?? '') ? i - pre.length : i;
      const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text.startsWith(q, j)) break;
        if (q.length === 1 && text[j] === '\n') break;       // an unterminated one-line string
        j++;
      }
      const end = Math.min(text.length, j + (text.startsWith(q, j) ? q.length : 0));
      strings.set(start, { start, end, body: text.slice(i + q.length, j) });
      const lit = blank(text.slice(i, end));
      code += lit;
      uncommented += lit;
      i = end;
      continue;
    }
    code += c;
    uncommented += c;
    i++;
  }
  return { code, uncommented, strings };
}

/**
 * Go: `//` and `/* *\/` comments, interpreted `"…"` strings, raw `` `…` `` strings and
 * rune literals.
 * @param {string} text
 * @returns {Scan}
 */
export function scanGo(text) {
  let code = '', uncommented = '';
  const strings = new Map();
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const close = text[i + 1] === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : text[i + 1] === '/' ? close : close + 2;
      code += blank(text.slice(i, end));
      uncommented += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (c !== '`' && text[j] === '\\') j++;
        else if (c !== '`' && text[j] === '\n') break;
        j++;
      }
      const end = Math.min(text.length, j + 1);
      if (c !== "'") strings.set(i, { start: i, end, body: text.slice(i + 1, j) });
      const lit = blank(text.slice(i, end));
      code += lit;
      uncommented += lit;
      i = end;
      continue;
    }
    code += c;
    uncommented += c;
    i++;
  }
  return { code, uncommented, strings };
}

/** The literal starting at or after `k`, skipping only blanked space; null if code comes first. */
const literalFrom = (/** @type {Scan} */ s, /** @type {number} */ k) => {
  for (let i = k; i < s.code.length; i++) {
    const lit = s.strings.get(i);
    if (lit) return lit;
    if (!/\s/.test(s.code[i] ?? '')) return null;
  }
  return null;
};

/** The offset just past the `:` that ends a `def`/`class` header whose name ends at `k`. */
const headerEnd = (/** @type {string} */ code, /** @type {number} */ k) => {
  let depth = 0;
  for (let i = k; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0) return i + 1;
  }
  return -1;
};

const PY_TEST_DEF = /^[ \t]*(?:async[ \t]+)?def[ \t]+(test\w*)/gm;
const PY_DEF = /^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+\w+/gm;

/**
 * Python's titles: the SUMMARY LINE of each test function's docstring, its first non-empty
 * line. A test function is what pytest collects, `def test…` at any depth (a module function
 * or a method of a `Test…` class). A pytest name is an identifier and cannot hold `[ORD-1]`,
 * so the docstring's summary is the title a reader sees; the rest of the docstring is the
 * body, and an id there is a mention, as an id in a JavaScript docblock is.
 * @param {string} text
 */
export function pythonTitles(text) {
  const s = scanPython(text);
  const out = [];
  for (const m of s.code.matchAll(PY_TEST_DEF)) {
    const end = headerEnd(s.code, (m.index ?? 0) + m[0].length);
    if (end < 0) continue;
    const doc = literalFrom(s, end);
    const summary = doc?.body.split('\n').map((l) => l.trim()).find(Boolean);
    if (summary) out.push(summary);
  }
  return out.join('\n');
}

/**
 * Python's text minus its string literals, keeping comments AND docstrings: a docstring is
 * Python's docblock, so an id in one is a mention worth surfacing, while an id in any other
 * string is fixture data.
 * @param {string} text
 */
export function pythonMentions(text) {
  const s = scanPython(text);
  let out = s.uncommented;
  const docAt = (/** @type {number} */ k) => {
    const lit = literalFrom(s, k);
    if (lit) out = out.slice(0, lit.start) + text.slice(lit.start, lit.end) + out.slice(lit.end);
  };
  docAt(0);                                              // the module docstring
  for (const m of s.code.matchAll(PY_DEF)) {
    const end = headerEnd(s.code, (m.index ?? 0) + m[0].length);
    if (end >= 0) docAt(end);
  }
  return out;
}

/**
 * Go's titles: the NAME OF EACH SUBTEST, the first argument of `t.Run("[ORD-1] …", …)` when
 * it is a string literal. A Go test function's name is an identifier and cannot hold
 * `[ORD-1]`, so a test that locks a clause does it in a subtest, which is also the name
 * `go test -v` prints. A computed name (`t.Run(tc.name, …)`) is not read, as an interpolated
 * JavaScript title is not.
 * @param {string} text
 */
export function goTitles(text) {
  const s = scanGo(text);
  const out = [];
  for (const m of s.code.matchAll(/\.Run\(/g)) {
    const lit = literalFrom(s, (m.index ?? 0) + m[0].length);
    if (lit) out.push(lit.body);
  }
  return out.join('\n');
}

/** Go's text minus its string literals, comments kept. @param {string} text */
export const goMentions = (text) => scanGo(text).uncommented;

/** The top-level test functions a Go test file declares, for `go test -run`. @param {string} text */
export const goTestFunctions = (text) =>
  [...scanGo(text).code.matchAll(/^func[ \t]+(Test[A-Z_0-9]\w*|Test)[ \t]*\(\s*\w+\s+\*testing\.T\s*\)/gm)].map((m) => m[1] ?? '');

const JS_EXT = ['ts', 'tsx', 'mjs', 'js'];

/** @type {Convention[]} */
export const CONVENTIONS = [
  {
    language: 'JavaScript and TypeScript',
    extensions: JS_EXT,
    // Every source file under `tests/` and `e2e/`, as Vitest and Playwright are set up in the
    // reference adopter. Unchanged by #20, so no lock moves.
    isTest: (p) => /^(tests|e2e)\//.test(p),
    titleConvention: "the first argument of `describe`, `it` or `test`: `it('[ORD-1] …')`",
    // The JavaScript scanner predates this table and lives in `spec-coverage.mjs`
    // (`titlesIn`, `outsideStrings`), where its long history is recorded; null sends a
    // reader there.
    titles: null,
    mentions: null,
    comment: 'slash',
    runner: (p) => (p.startsWith('tests/') ? 'vitest' : p.startsWith('e2e/') ? 'playwright' : 'unknown'),
  },
  {
    language: 'Python',
    extensions: ['py'],
    // pytest's default discovery: `test_*.py` or `*_test.py`, wherever it is.
    isTest: (p) => /^test_.*\.py$|_test\.py$/.test(basename(p)),
    titleConvention: 'the first line of the test function\'s docstring: `def test_once():` then `"""[ORD-1] …"""`',
    titles: pythonTitles,
    mentions: pythonMentions,
    comment: 'hash',
    runner: () => 'pytest',
  },
  {
    language: 'Go',
    extensions: ['go'],
    // `go test`'s own rule: a file whose name ends in `_test.go`.
    isTest: (p) => p.endsWith('_test.go'),
    titleConvention: 'the name of a subtest: `t.Run("[ORD-1] …", func(t *testing.T) { … })`',
    titles: goTitles,
    mentions: goMentions,
    comment: 'slash',
    runner: () => 'go',
  },
];

/** The row a file's extension picks, or undefined for a language Kanon does not read. @param {string} path */
export const conventionFor = (path) => {
  const ext = /\.([^./]+)$/.exec(path)?.[1];
  return ext === undefined ? undefined : CONVENTIONS.find((c) => c.extensions.includes(ext));
};

/** Is this file a test file, by its language's convention? @param {string} path */
export const isTestFile = (path) => conventionFor(path)?.isTest(path) ?? false;

/** Which runner owns a test file, or `unknown`. @param {string} path @returns {Runner} */
export const runnerFor = (path) => (isTestFile(path) ? conventionFor(path)?.runner(path) ?? 'unknown' : 'unknown');

/** Every extension in the table, as a regex alternation. */
export const TABLE_EXT = CONVENTIONS.flatMap((c) => c.extensions).join('|');

/**
 * How each runner runs ONE file. Never `npx`: `npx` installs what it cannot find, so it could
 * run a tool the adopter never chose. The project-setup hook installs the adopter's
 * toolchain, and these name it as it is installed, so a toolchain that is missing reports
 * `not-run` rather than being fetched (kanon#20).
 *
 * `report` says where the runner writes its result: to the path in `out` (`file`), or to
 * standard output (`stdout`), which the caller writes to `out` itself.
 *
 * @typedef {{ bin: string, args: string[], env?: Record<string, string>, report: 'file' | 'stdout' } | null} Command
 * @type {Record<Exclude<Runner, 'unknown'>, (file: string, out: string, text: () => string) => Command>}
 */
export const RUNNERS = {
  vitest: (file, out) => ({ bin: 'node_modules/.bin/vitest', args: ['run', file, '--reporter=json', `--outputFile=${out}`], report: 'file' }),
  playwright: (file, out) => ({ bin: 'node_modules/.bin/playwright', args: ['test', file, '--reporter=json'], env: { PLAYWRIGHT_JSON_OUTPUT_NAME: out }, report: 'file' }),
  pytest: (file, out) => ({ bin: 'python', args: ['-m', 'pytest', file, `--junitxml=${out}`, '-p', 'no:cacheprovider'], report: 'file' }),
  // `go test` runs a PACKAGE, so one file is run as its package restricted to the test
  // functions that file declares. A file that declares none has nothing to run.
  go: (file, _out, text) => {
    const names = goTestFunctions(text());
    if (!names.length) return null;
    return { bin: 'go', args: ['test', '-json', '-run', `^(${names.join('|')})$`, `./${dirname(file)}`], report: 'stdout' };
  },
};

/**
 * Did a JUnit XML report (pytest's `--junitxml`) show tests executing? `true` all that ran
 * passed, `false` one failed or errored, `undefined` none ran. A collection error — the file
 * failed to import — is a `<testcase>` with an `<error>`, so it is `false`, as a JavaScript
 * file that fails to import is.
 * @param {string} xml
 */
export function interpretJunit(xml) {
  let ran = 0, failed = 0;
  for (const m of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[1] ?? '';
    if (/<(?:failure|error)\b/.test(body)) failed++;
    else if (!/<skipped\b/.test(body)) ran++;
  }
  if (failed) return false;
  return ran ? true : undefined;
}

/**
 * Did `go test -json` output show this file's test functions executing? Read per top-level
 * test: any `fail` is `false`, a `pass` with none failed is `true`. A package that failed with
 * no test result — it did not compile — is `false`, as an import failure is; nothing at all
 * is `undefined`.
 * @param {string} stream  newline-delimited JSON events
 */
export function interpretGoJson(stream) {
  let passed = 0, failed = 0, packageFailed = false;
  for (const line of stream.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const top = typeof e.Test === 'string' && !e.Test.includes('/');
    if (top && e.Action === 'pass') passed++;
    else if (top && e.Action === 'fail') failed++;
    else if (e.Test === undefined && (e.Action === 'fail' || e.Action === 'build-fail')) packageFailed = true;
  }
  if (failed) return false;
  if (passed) return true;
  return packageFailed ? false : undefined;
}
