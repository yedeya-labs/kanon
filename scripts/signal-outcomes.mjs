#!/usr/bin/env node
// kanon#466 — precision per signal, counted from what the issues already record, so the
// Overseer's weekly audit (`K-SELF-9`) reads a number rather than an absence.
//
// ── WHY IT WAS UNMEASURABLE ─────────────────────────────────────────────────
// The prompt measured precision as "`qa:false-positive` against confirmed", and the only
// writer of an outcome label (`qa:reproduced`, `qa:false-positive`, `qa:cannot-reproduce`) is
// the triage lane (`K-AGENT-12`), which runs only on an Explorer finding labelled
// `qa:needs-triage`. Every other way a signal is resolved writes none:
//  - a Reviewer follow-up never passes through triage. A member sends it to the implement
//    lane, or a person fixes it, and a merged pull request closes it;
//  - an Explorer finding sent to the implement lane instead of the triage lane (a repository
//    that doesn't run triage) is built and closed the same way;
//  - a person who closes a signal as not planned says nothing about whether it was real.
// So on a repository without the triage lane no issue ever carried an outcome, and the ratio
// was 0/0: undefined, which an audit can't tell from "no false positives".
//
// ── WHAT COUNTS AS AN OUTCOME ───────────────────────────────────────────────
// An outcome label is the record and always wins. Without one, a signal CLOSED by a merged
// pull request that references it (GitHub closes an issue on a closing keyword only at the
// merge) was confirmed: the Implementer re-measured its claim before building (`K-WORK-16`),
// the Reviewer reviewed the fix and a person merged it. Anything else that is closed is
// UNRECORDED: whether it was real is known only to the person who closed it, so this script
// lists it for them to label rather than guess. It never writes a label.
//
// Precision is confirmed / (confirmed + false positive). Its floor counts every unrecorded
// signal as a false positive, so the gap between the two says how much the number depends on
// what nobody recorded. Both are observations, never a target (`K-WORK-20`): this prints no
// threshold and judges no rate (`K-SELF-13`).
//
// A SIGNAL is the lane that filed the issue (its `agent:` filer label) and the `signal:*`
// labels it carries, so `agent:explorer signal:contract` and `agent:reviewer` are counted
// apart. The Overseer's own audit issue carries `agent:overseer` too, and each run closes the
// last one, but a templated report is evidence about no signal (`K-SELF-13`), so an issue titled
// as `overseer-file.mjs` titles an audit is left out, like one no lane filed.
//
// READ-ONLY and DEPENDENCY-FREE: `node:` and `gh` only (`K-SELF-8`), on the token in GH_TOKEN.
// A failed or truncated read exits 1 with `signal-outcomes: UNAVAILABLE` on line 1, so an
// unreadable corpus is never reported as an empty one.
//
// Usage: node "$KANON/scripts/signal-outcomes.mjs" [--json]
//   On GITHUB_REPOSITORY, which it requires. Line 1 is `signal-outcomes: ok issues=N`.

import { execFileSync } from 'node:child_process';
import { isCliEntry } from './lib/cli-entry.mjs';
import { AUDIT_NUMBER } from './overseer-file.mjs';

/** The labels that say which lane FILED an issue (`K-WORK-12`'s Agent family). The dispatch
 *  labels (`agent:implement`, `agent:triage`, ...) start a lane on an issue someone else filed,
 *  so they name no signal. */
export const FILER_LABELS = ['agent:explorer', 'agent:reviewer', 'agent:overseer'];

/** The outcome labels, as the triage lane applies them (`K-AGENT-12`). */
export const OUTCOME_LABELS = {
  reproduced: 'qa:reproduced',
  falsePositive: 'qa:false-positive',
  cannotReproduce: 'qa:cannot-reproduce',
};

/** The most issues read before the script refuses to count a truncated corpus. */
export const MAX_PAGES = 30;

/**
 * @typedef {{ name?: string } | string} Label
 * @typedef {{ number?: number, merged?: boolean }} ClosingPr
 * @typedef {{
 *   number: number,
 *   title?: string,
 *   state?: string,
 *   stateReason?: string | null,
 *   labels?: Label[] | { nodes?: Label[] },
 *   closedByPullRequestsReferences?: { nodes?: ClosingPr[] } | ClosingPr[],
 * }} Issue
 * @typedef {'reproduced' | 'fixed' | 'falsePositive' | 'cannotReproduce' | 'conflict' | 'unrecorded' | 'open'} Outcome
 * @typedef {Record<Outcome, number[]>} Tally
 */

/** @type {Outcome[]} */
export const OUTCOMES = ['reproduced', 'fixed', 'falsePositive', 'cannotReproduce', 'unrecorded', 'open', 'conflict'];

/**
 * Label names, lowercased: GitHub matches label names case-insensitively.
 * @param {Issue} issue
 */
const labelNames = (issue) => {
  const raw = Array.isArray(issue.labels) ? issue.labels : issue.labels?.nodes ?? [];
  return raw.map((l) => ((typeof l === 'string' ? l : l?.name) ?? '').toLowerCase());
};

/** @param {Issue} issue */
const closingPrs = (issue) => {
  const c = issue.closedByPullRequestsReferences;
  return Array.isArray(c) ? c : c?.nodes ?? [];
};

/**
 * The signal an issue is evidence about, or null when no lane filed it.
 * @param {Issue} issue
 * @returns {string | null}
 */
export function signalOf(issue) {
  if (AUDIT_NUMBER.test(issue.title ?? '')) return null;
  const names = labelNames(issue);
  const filer = FILER_LABELS.find((f) => names.includes(f));
  if (!filer) return null;
  const signals = names.filter((n) => n.startsWith('signal:')).sort();
  return [filer, ...signals].join(' ');
}

/**
 * What became of one signal.
 * @param {Issue} issue
 * @returns {Outcome}
 */
export function outcomeOf(issue) {
  const names = labelNames(issue);
  const labelled = /** @type {(keyof typeof OUTCOME_LABELS)[]} */ (Object.keys(OUTCOME_LABELS))
    .filter((k) => names.includes(OUTCOME_LABELS[k]));
  if (labelled.length > 1) return 'conflict';
  const [only] = labelled;
  if (only) return only;
  if (String(issue.state ?? '').toUpperCase() !== 'CLOSED') return 'open';
  // Closed as not planned is a person's call even when a merged pull request mentions it. A
  // duplicate (`DUPLICATE`, with no merged fix) is unrecorded too: only the closer knows
  // whether the original was real.
  if (String(issue.stateReason ?? '').toUpperCase() === 'NOT_PLANNED') return 'unrecorded';
  return closingPrs(issue).some((p) => p?.merged === true) ? 'fixed' : 'unrecorded';
}

/** @returns {Tally} */
const emptyTally = () => /** @type {Tally} */ (/** @type {unknown} */ (Object.fromEntries(OUTCOMES.map((o) => [o, []]))));

/**
 * Every filed signal, grouped, each outcome holding its issue numbers. Issues no lane filed
 * are left out.
 * @param {Issue[]} issues
 * @returns {Map<string, Tally>}
 */
export function tally(issues) {
  /** @type {Map<string, Tally>} */
  const out = new Map();
  for (const issue of issues) {
    const signal = signalOf(issue);
    if (signal === null) continue;
    if (!out.has(signal)) out.set(signal, emptyTally());
    /** @type {Tally} */ (out.get(signal))[outcomeOf(issue)].push(issue.number);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Precision and its floor for one signal, or null where nothing is confirmed or refuted.
 * @param {Tally} t
 * @returns {{ confirmed: number, falsePositive: number, unrecorded: number, precision: number | null, floor: number | null }}
 */
export function precisionOf(t) {
  const confirmed = t.reproduced.length + t.fixed.length;
  const falsePositive = t.falsePositive.length;
  const unrecorded = t.unrecorded.length;
  const decided = confirmed + falsePositive;
  return {
    confirmed,
    falsePositive,
    unrecorded,
    precision: decided === 0 ? null : confirmed / decided,
    floor: decided + unrecorded === 0 ? null : confirmed / (decided + unrecorded),
  };
}

/** @param {number | null} r @param {number} num @param {number} den */
const pct = (r, num, den) => (r === null ? 'n/a' : `${Math.round(r * 100)}% (${num}/${den})`);

/** @param {number[]} ns */
const refs = (ns) => (ns.length === 0 ? 'none' : ns.slice().sort((a, b) => a - b).map((n) => `#${n}`).join(', '));

/**
 * The Markdown the Overseer pastes. Line 1 is the status line.
 * @param {Map<string, Tally>} t
 * @param {number} read how many issues were read
 */
export function render(t, read) {
  const lines = [`signal-outcomes: ok issues=${read} signals=${t.size}`, ''];
  if (t.size === 0) {
    lines.push('No issue carries a filer label, so no signal has an outcome to count.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '| Signal | Reproduced | Fixed (merged PR) | False positive | Cannot reproduce | Closed, unrecorded | Open | Precision | Floor |',
    '|---|---:|---:|---:|---:|---:|---:|---|---|',
  );
  /** @type {number[]} */
  const unrecorded = [];
  /** @type {number[]} */
  const conflicts = [];
  for (const [signal, c] of t) {
    const p = precisionOf(c);
    unrecorded.push(...c.unrecorded);
    conflicts.push(...c.conflict);
    lines.push(`| \`${signal}\` | ${c.reproduced.length} | ${c.fixed.length} | ${c.falsePositive.length} | ${c.cannotReproduce.length} | ${c.unrecorded.length} | ${c.open.length} | ${pct(p.precision, p.confirmed, p.confirmed + p.falsePositive)} | ${pct(p.floor, p.confirmed, p.confirmed + p.falsePositive + p.unrecorded)} |`);
  }
  lines.push(
    '',
    `Precision is confirmed / (confirmed + false positive): confirmed is \`${OUTCOME_LABELS.reproduced}\`, or closed by a merged pull request with no outcome label. The floor counts every unrecorded signal as a false positive. An outcome label always wins.`,
    '',
    `Unrecorded (closed with neither a merged fix nor an outcome label; only whoever closed it knows whether it was real, and \`${OUTCOME_LABELS.falsePositive}\` or \`${OUTCOME_LABELS.reproduced}\` records it): ${refs(unrecorded)}`,
    `Contradictory (more than one outcome label, counted in no column): ${refs(conflicts)}`,
  );
  return `${lines.join('\n')}\n`;
}

/** @param {Map<string, Tally>} t @param {number} read */
export function toJson(t, read) {
  return {
    issues: read,
    signals: [...t].map(([signal, c]) => ({ signal, ...Object.fromEntries(OUTCOMES.map((o) => [o, c[o]])), precision: precisionOf(c) })),
  };
}

// ── I/O ────────────────────────────────────────────────────────────────────

const QUERY = `query($owner: String!, $name: String!, $labels: [String!], $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, labels: $labels, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state stateReason
        labels(first: 50) { nodes { name } }
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { number merged } }
      }
    }
  }
}`;

/**
 * Every issue carrying a filer label, newest first, to the last page. Throws on a read that
 * fails or would be truncated.
 * @param {string} repo `owner/name`
 * @param {(args: string[]) => string} gh
 * @param {number} [maxPages]
 * @returns {Issue[]}
 */
export function readSignals(repo, gh, maxPages = MAX_PAGES) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`GITHUB_REPOSITORY must be owner/name, not "${repo}"`);
  /** @type {Issue[]} */
  const issues = [];
  /** @type {string | null} */
  let cursor = null;
  for (let page = 1; ; page++) {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
    for (const l of FILER_LABELS) args.push('-f', `labels[]=${l}`);
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const conn = JSON.parse(gh(args))?.data?.repository?.issues;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('the issues query returned no issue list');
    issues.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) return issues;
    if (page >= maxPages) throw new Error(`more than ${maxPages * 100} issues carry a filer label; refusing to count a truncated corpus`);
    cursor = conn.pageInfo.endCursor;
  }
}

/**
 * Read and count. Returns the process's stdout and exit code.
 * @param {{ repo: string | undefined, json: boolean, gh: (args: string[]) => string }} io
 * @returns {{ code: number, out: string }}
 */
export function run({ repo, json, gh }) {
  if (!repo) return { code: 1, out: 'signal-outcomes: UNAVAILABLE — GITHUB_REPOSITORY is not set\n' };
  let issues;
  try {
    issues = readSignals(repo, gh);
  } catch (e) {
    return { code: 1, out: `signal-outcomes: UNAVAILABLE — ${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]}\n` };
  }
  const t = tally(issues);
  return { code: 0, out: json ? `${JSON.stringify(toJson(t, issues.length), null, 2)}\n` : render(t, issues.length) };
}

function main() {
  const gh = (/** @type {string[]} */ args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const { code, out } = run({ repo: process.env.GITHUB_REPOSITORY, json: process.argv.includes('--json'), gh });
  process.stdout.write(out);
  process.exitCode = code;
}

if (isCliEntry(import.meta.url)) main();
