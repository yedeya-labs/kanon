#!/usr/bin/env node
// Splits Kanon's test files into CI shards by measured duration (#407).
//
//   node .github/scripts/test-shards.mjs 2/4      # print shard 2 of 4's files, one per line
//   node .github/scripts/test-shards.mjs --refresh # re-measure tests/shard-weights.json
//
// WHY NOT `vitest --shard`. Vitest's own sharding splits by file count over hashed paths, so
// the slow files can land together. Four shards by count left one shard at ~39 s while the
// others took ~20 s. This assigns files longest-first, each to the lightest shard so far,
// using the per-file seconds in tests/shard-weights.json.
//
// THE FILE LIST IS VITEST'S, NEVER THE WEIGHTS FILE'S. Every file `vitest list` reports (both
// projects) is placed in exactly one shard, and the plan is checked to be that partition before
// anything is printed. A file the weights file doesn't know gets the median weight, and a
// weight for a file that no longer exists is ignored. So stale weights only make the shards
// uneven; they can never drop a test file. Refresh them when the shards drift apart.
//
// WHY IT REFUSES TO PRINT AN EMPTY SHARD. `vitest run` with no file filter runs every test
// file, so an empty shard would quietly run the whole suite. Asking for more shards than there
// are files, or for a shard outside 1..N, exits 1.
//
// HOW CI CALLS IT. ci.yml assigns the output to a variable before `npm test -- $files`. A plain
// assignment fails the step under `bash -e` when this exits non-zero. An inline
// `npm test -- $(…)` would not: it would run with no filter, which is the whole suite, and pass.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const WEIGHTS_FILE = 'tests/shard-weights.json';
/** @param {string} root */
const VITEST = (root) => join(root, 'node_modules/vitest/vitest.mjs');

/**
 * Every test file vitest runs, across all projects, relative to `root`, sorted and deduplicated.
 * @param {string} [root]
 * @returns {string[]}
 */
export function listTestFiles(root = ROOT) {
  const out = execFileSync(process.execPath, [VITEST(root), 'list', '--filesOnly', '--json'], { cwd: root, encoding: 'utf8' });
  /** @type {{ file: string }[]} */
  const entries = JSON.parse(out);
  return [...new Set(entries.map((e) => relative(root, e.file)))].sort();
}

/**
 * @param {string} [root]
 * @returns {Record<string, number>}
 */
export function readWeights(root = ROOT) {
  return JSON.parse(readFileSync(join(root, WEIGHTS_FILE), 'utf8'));
}

/**
 * Longest-first into the lightest shard. Ties go to the lower shard index and, between files of
 * equal weight, to path order, so the plan is the same on every runner. A file without a weight
 * counts as the median of the weights that do apply to listed files (1 s if none do).
 *
 * @param {string[]} files
 * @param {Record<string, number>} weights
 * @param {number} n
 * @returns {string[][]}
 */
export function assign(files, weights, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`the shard count must be a positive integer, not ${n}`);
  const unique = [...new Set(files)];
  if (unique.length < n) throw new Error(`${n} shards for ${unique.length} test files would leave one empty, and an empty shard runs every file`);
  /** @param {string} f @returns {number | undefined} */
  const measured = (f) => {
    const w = weights[f];
    return typeof w === 'number' && Number.isFinite(w) ? w : undefined;
  };
  const known = unique.map(measured).filter((w) => w !== undefined).sort((a, b) => a - b);
  const mid = Math.floor(known.length / 2);
  const median = known.length === 0 ? 1 : known.length % 2 ? known[mid] ?? 1 : ((known[mid - 1] ?? 0) + (known[mid] ?? 0)) / 2;
  /** @param {string} f */
  const weightOf = (f) => measured(f) ?? median;
  const order = [...unique].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: n }, () => ({ files: /** @type {string[]} */ ([]), load: 0 }));
  for (const f of order) {
    let lightest = shards[0] ?? { files: [], load: 0 };
    for (const s of shards) if (s.load < lightest.load) lightest = s;
    lightest.files.push(f);
    lightest.load += weightOf(f);
  }
  return shards.map((s) => s.files.sort());
}

/**
 * Why `shards` is not an exact partition of `files` into non-empty shards, or `[]` when it is.
 * @param {string[]} files
 * @param {string[][]} shards
 * @returns {string[]}
 */
export function partitionProblems(files, shards) {
  const problems = [];
  const seen = new Map();
  shards.forEach((s, i) => {
    if (s.length === 0) problems.push(`shard ${i + 1} is empty, so it would run every file`);
    for (const f of s) {
      if (seen.has(f)) problems.push(`${f} is in shard ${seen.get(f) + 1} and shard ${i + 1}`);
      else seen.set(f, i);
    }
  });
  const want = new Set(files);
  for (const f of want) if (!seen.has(f)) problems.push(`${f} is in no shard, so it would never run`);
  for (const f of seen.keys()) if (!want.has(f)) problems.push(`${f} is in a shard but is not a test file vitest lists`);
  return problems;
}

/**
 * Re-measures the weights from a full run's JSON report: per file, its seconds, to 0.1 s.
 * @param {string} [root]
 */
function refresh(root = ROOT) {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-shard-weights-'));
  const report = join(dir, 'report.json');
  try {
    try {
      // The suite's own output is noise here unless the run fails.
      execFileSync(process.execPath, [VITEST(root), 'run', '--reporter=json', `--outputFile=${report}`], { cwd: root, stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
    } catch (e) {
      process.stderr.write(String(/** @type {{ stderr?: unknown }} */ (e).stderr ?? ''));
      throw new Error('the test run failed, so its timings were not recorded; fix the suite and run --refresh again', { cause: e });
    }
    /** @type {{ testResults: { name: string, startTime: number, endTime: number }[] }} */
    const { testResults } = JSON.parse(readFileSync(report, 'utf8'));
    const weights = Object.fromEntries(
      testResults
        .map((r) => [relative(root, r.name), Math.max(0.1, Math.round((r.endTime - r.startTime) / 100) / 10)])
        .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
    );
    writeFileSync(join(root, WEIGHTS_FILE), `${JSON.stringify(weights, null, 2)}\n`);
    console.error(`test-shards: wrote ${Object.keys(weights).length} file weights to ${WEIGHTS_FILE}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @param {string} [root]
 * @returns {string[]} the shard's files
 */
export function shardFiles(argv, root = ROOT) {
  const m = /^(\d+)\/(\d+)$/.exec(argv[0] ?? '');
  if (!m || argv.length !== 1) throw new Error('usage: test-shards.mjs <i>/<n> | --refresh');
  const [i, n] = [Number(m[1]), Number(m[2])];
  if (i < 1 || i > n) throw new Error(`shard ${i} is outside 1..${n}`);
  const files = listTestFiles(root);
  const shards = assign(files, readWeights(root), n);
  const problems = partitionProblems(files, shards);
  if (problems.length) throw new Error(`the shard plan is not a partition of the test files:\n${problems.join('\n')}`);
  return shards[i - 1] ?? [];
}

if (isCliEntry(import.meta.url)) {
  try {
    if (process.argv[2] === '--refresh' && process.argv.length === 3) refresh();
    else console.log(shardFiles(process.argv.slice(2)).join('\n'));
  } catch (e) {
    console.error(`test-shards: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
