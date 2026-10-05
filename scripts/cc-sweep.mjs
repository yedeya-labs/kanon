#!/usr/bin/env node
/**
 * cc-sweep — the mechanical half of a Claude Code release sweep (RA-2276). Moved from the
 * reference adopter into Kanon's library with the Overseer's lane (plan 0004, step 13).
 *
 * One implementation shared by two callers: the Overseer's weekly capability review (the
 * project's `docs/qa/overseer-playbook.md`, `## Capability review`; `K-SELF-17`) and a human
 * session sweeping the release notes by hand. The judgement stays in their prose (the
 * recovery ladder, the watermark role rule, dispositions); everything here is mechanics that
 * were previously re-executed from prose on every run, where each step had a way to fail
 * silently.
 *
 * DEPENDENCY-FREE. The Overseer job installs nothing, so this file imports `node:` builtins
 * only, like every script under scripts/ (`K-SELF-8`).
 *
 *   node "$KANON/scripts/cc-sweep.mjs" slice <watermark>   # the Overseer uses this, and only this
 *   node "$KANON/scripts/cc-sweep.mjs" context             # per-arm --model/--effort/flags snapshot
 *   node "$KANON/scripts/cc-sweep.mjs" issues <term>... [--fresh]  # which issues already mention an identifier
 *
 * `slice` prints ONE status line first, then (on exit 0) the slice:
 *
 *   cc-sweep: ok headers=<n> watermark=<w> head=<v> lines=<n> versions=<n> truncated=<n>
 *
 * and exits
 *   0  ok — the slice follows. `truncated=N` > 0 means the newest ~2,000 lines were kept
 *      and N versions skipped, so the caller's `ran, through` line takes the truncated suffix.
 *   2  fetch failed — the file is not a changelog (0 `## ` headers). NOT a bad watermark:
 *      carry the prior watermark forward and do not enter the recovery ladder.
 *   3  the watermark does not match exactly one header. Nothing is sliced (an unmatched
 *      watermark would slice the WHOLE file, ~128k tokens). `head=` is still printed, since
 *      ladder step 2 resets to it.
 *   1  usage error.
 *
 * Why the checks are here rather than in the caller's shell, briefly (the playbook has the
 * measured history): `curl` without `-f` exits 0 on a 404, so the header count is the only
 * thing that tells a failed fetch from a bad watermark; slicing up to an unmatched header
 * prints the entire file; and the bound must be applied from the NEWEST end, because the
 * changelog is newest-first and taking the tail would drop the versions being reported.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/cli-entry.mjs';

export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
/** ~3.5 months of backlog at ~570 lines a month: the over-large-slice bound (`K-SELF-17`). */
export const MAX_LINES = 2000;

/**
 * @typedef {{ status: 'fetch-failed', headers: 0 }
 *   | { status: 'bad-watermark', headers: number, head: string, matches: number }
 *   | { status: 'ok', headers: number, head: string, lines: number, versions: number, truncated: number, slice: string }} Slice
 */

/**
 * Slice `text` from its HEAD down to (not including) the `## <watermark>` header.
 * Pure, so the tests can feed it fixtures instead of the network.
 * @param {string} text
 * @param {string} watermark
 * @returns {Slice}
 */
export function sliceChangelog(text, watermark, maxLines = MAX_LINES) {
  const lines = text.split('\n');
  const headerIdx = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []));
  if (headerIdx.length === 0) return { status: 'fetch-failed', headers: 0 };
  const head = String(lines[/** @type {number} */ (headerIdx[0])]).slice(3).trim();
  const matches = headerIdx.filter((i) => lines[i] === `## ${watermark}`);
  if (matches.length !== 1) {
    return { status: 'bad-watermark', headers: headerIdx.length, head, matches: matches.length };
  }
  const full = lines.slice(0, matches[0]);
  const versionsIn = (/** @type {string[]} */ ls) => ls.filter((l) => l.startsWith('## ')).length;
  const kept = full.length > maxLines ? full.slice(0, maxLines) : full;
  return {
    status: 'ok',
    headers: headerIdx.length,
    head,
    lines: kept.length,
    versions: versionsIn(kept),
    truncated: versionsIn(full) - versionsIn(kept),
    slice: kept.join('\n'),
  };
}

/**
 * @param {Slice} r
 * @param {string} watermark
 */
export function statusLine(r, watermark) {
  if (r.status === 'fetch-failed') return 'cc-sweep: fetch-failed headers=0';
  if (r.status === 'bad-watermark') {
    return `cc-sweep: bad-watermark headers=${r.headers} watermark=${watermark} matches=${r.matches} head=${r.head}`;
  }
  return `cc-sweep: ok headers=${r.headers} watermark=${watermark} head=${r.head} lines=${r.lines} versions=${r.versions} truncated=${r.truncated}`;
}

/** Kanon's own lanes, in the tree this script runs from: the tag the adopter pinned. */
export const KANON_LANES = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

/** The workflows a workflow calls through `$/` (Kanon's call to its own), by file name. */
const selfCalls = (/** @type {string} */ text) =>
  [...text.matchAll(/^\s*uses:\s*\$\/\.github\/workflows\/([\w.-]+\.ya?ml)\s*$/gm)].map((m) => /** @type {string} */ (m[1]));

/**
 * A workflow's text, then the text of every workflow it calls through `$/`, transitively.
 * @param {string} dir
 * @param {string} file
 * @param {Set<string>} [seen]
 * @returns {string[]}
 */
const withCalls = (dir, file, seen = new Set()) => {
  if (seen.has(file) || !existsSync(join(dir, file))) return [];
  seen.add(file);
  const text = readFileSync(join(dir, file), 'utf8');
  return [text, ...selfCalls(text).flatMap((c) => withCalls(dir, c, seen))];
};

/**
 * Every `--model` / `--effort` / `--autocompact` / `--max-turns` block in the workflows, one
 * line per distinct `claude_args:` in each file. Regex rather than a YAML parse, to stay
 * dependency-free.
 * @param {string} [workflowDir] the project's workflows
 * @param {string} [lanesDir] Kanon's lanes, where a caller's lane is read
 * @returns {string[]}
 */
export function fleetConfig(workflowDir = '.github/workflows', lanesDir = KANON_LANES) {
  /** @type {string[]} */
  const out = [];
  const files = readdirSync(workflowDir).filter((n) => n.endsWith('.yml')).sort();
  // A lane's agent job runs in a workflow the lane calls through `$/` (kanon#279), and its
  // claude_args are there: each is read as part of the lane that calls it, never on its own.
  // A lane is an `agent-*.yml` file even when another calls it (the lanes smoke test does).
  const called = new Set(files.flatMap((f) => selfCalls(readFileSync(join(workflowDir, f), 'utf8')))
    .filter((c) => !/^agent-/.test(c)));
  for (const f of files.filter((n) => !called.has(n))) {
    const own = readFileSync(join(workflowDir, f), 'utf8');
    // A trigger-only caller of one of Kanon's lanes (RA-2709, RA-2715) carries no claude_args;
    // its lane does, read from this Kanon tree, and it is this file's arm.
    const lanes = [...own.matchAll(/^\s*uses:\s*yedeya-labs\/kanon\/\.github\/workflows\/([\w.-]+\.ya?ml)@[\w.-]+\s*$/gm)]
      .map((m) => /** @type {string} */ (m[1])).filter((l) => l !== 'agent-lane.yml')
      .flatMap((l) => withCalls(lanesDir, l));
    const text = [...withCalls(workflowDir, f).slice(1), own, ...lanes].join('\n');
    for (const m of text.matchAll(/claude_args:\s*\|?\s*\n((?:[ \t]+--.*\n?)+)/g)) {
      const args = String(m[1]);
      const pick = (/** @type {string} */ flag) => args.match(new RegExp(`${flag}[\\s=]+(\\S+)`))?.[1] ?? '-';
      out.push(`${f.padEnd(30)} model=${pick('--model')} effort=${pick('--effort')} max-turns=${pick('--max-turns')} autocompact=${pick('--autocompact')}`);
    }
  }
  // A step and its telemetry copy read identically, so collapse repeats into a count.
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const l of out) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} (x${n})` : l));
}

/**
 * Case-insensitive identifier search over a list of `{number,state,title,body}`.
 * @param {Array<{ number: number, state: string, title: string, body?: string | null }>} issues
 * @param {string[]} terms
 */
export function matchIssues(issues, terms) {
  /** @type {string[]} */
  const hits = [];
  for (const t of terms) {
    const needle = t.toLowerCase();
    const found = issues.filter((i) => `${i.title}\n${i.body ?? ''}`.toLowerCase().includes(needle));
    if (found.length === 0) hits.push(`${t}: no issue mentions it`);
    for (const i of found) hits.push(`${t}: #${i.number} ${i.state} ${i.title}`);
  }
  return hits;
}

/** @returns {Array<{ number: number, state: string, title: string, body?: string | null }>} */
function loadIssues() {
  // One dump per repo per hour, reused: the point is one API call per sweep, not one per
  // term. Keyed by repo so a second checkout of another repo cannot read this one's dump,
  // and by hour so issues filed during a sweep appear on the next run; `--fresh` forces it.
  const repo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' })
    .trim().replace(/\W+/g, '-');
  const cache = join(tmpdir(), `cc-sweep-issues-${repo}-${new Date().toISOString().slice(0, 13)}.json`);
  if (process.argv.includes('--fresh')) rmSync(cache, { force: true });
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const byNumber = new Map();
  for (const label of ['pipeline-improvement', 'capability']) {
    const raw = execFileSync('gh', ['issue', 'list', '--state', 'all', '--label', label, '--limit', '2000',
      '--json', 'number,state,title,body'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    for (const i of JSON.parse(raw)) byNumber.set(i.number, i);
  }
  const issues = [...byNumber.values()].sort((a, b) => b.number - a.number);
  writeFileSync(cache, JSON.stringify(issues));
  return issues;
}

/** @param {string[]} argv */
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'slice' && rest.length === 1) {
    let text = '';
    try {
      const res = await fetch(CHANGELOG_URL);
      if (res.ok) text = await res.text();
    } catch {
      // Falls through to the header probe, which reports fetch-failed.
    }
    const watermark = String(rest[0]);
    const r = sliceChangelog(text, watermark);
    console.log(statusLine(r, watermark));
    if (r.status === 'ok') {
      console.log(r.slice);
      return 0;
    }
    return r.status === 'fetch-failed' ? 2 : 3;
  }
  if (cmd === 'context' && rest.length === 0) {
    console.log(fleetConfig().join('\n'));
    return 0;
  }
  if (cmd === 'issues' && rest.length > 0) {
    console.log(matchIssues(loadIssues(), rest.filter((t) => t !== '--fresh')).join('\n'));
    return 0;
  }
  console.error('usage: cc-sweep.mjs slice <watermark> | context | issues <term>...');
  return 1;
}

// The resolved path, so a symlinked checkout still runs the CLI (RA-944).
const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) process.exitCode = await main(process.argv.slice(2));
