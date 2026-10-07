#!/usr/bin/env node
// Kanon's own bugs in adopters' runs (#41, plan 0002 §2.6): the public detection logic. Pure:
// rows in, signals out, with no network, no AWS and no clock.
//
// WHERE IT RUNS (the Owner's decisions of 2026-10-07 on #41). A private scheduled job, in the
// Owner's own operations repository, reads the run rows, calls this module, files every signal
// privately, and files a PUBLIC Kanon issue only for a signal whose `visibility` is `public`.
// This file computes and prints; it reads one file and writes stdout, and files nothing.
//
// THE INPUT is run rows in the schema's shape (`actions/agent-telemetry/schema.mjs`), each
// tagged with an opaque adopter key: `adopter: "<key>"`, or the stored partition `pk:
// "<key>#<lane>"`, as the store and the aggregate (`infra/telemetry/function/aggregate.mjs`)
// have it. Only `tag = run` rows are read by default (plan 0002 §2.4); a seeded test passes
// `tag: 'test'`. A row with no `kanon_version` (the history import, decision 17) is never read:
// no release describes it.
//
// WHAT A SIGNAL IS. Every run that did not end `ok`, grouped by lane, failed stage, Kanon error,
// reason and Kanon version: the aggregate's signal (§6.1 item 3, reason included as the Owner
// accepted it on #449), with the run count, the adopter count, first and last seen, and the
// `api_error_status` codes it carried. Each is classified by plan 0002 §2.6's table:
//   - `platform`: every run in it carries a platform code, an `api_error_status` of 429 (rate
//     limits and usage caps) or 5xx, or the reason `model_never_ran` / `no_model_ran` (the
//     configured model was unreachable). Neither Kanon nor the adopter is at fault. Checked
//     first, and only when EVERY run says so: a signal that is half platform is read as the
//     other half, because a human triages it and a hidden Kanon bug costs more than noise.
//   - `kanon`: at two adopters or more, or STARTING AT A RELEASE: absent on the previous
//     version, which ran that lane at least `RISE.minRuns` times (so its absence means something).
//   - `adopter`: the rest, one adopter only, such as a `failed_stage: hook`.
// Beside the signals, a RISE: a lane whose failure rate on one release is `RISE.points` or more
// above its rate on the release before, with at least `RISE.minRuns` runs on each. Platform-coded
// runs are not counted as failures there, so an outage after a release is not a regression.
//
// PUBLIC OR PRIVATE (decision 2 on #41). A signal or a rise is `public` only when at least
// `MIN_ADOPTERS` distinct adopters contributed to it: the aggregate's three-adopter rule (#449,
// plan 0002 decision 7), imported, not restated. Everything else is `private`.
//
// NOTHING IDENTIFYING LEAVES. A row's lane, stage, error and reason are read only when they are
// in the schema's closed lists, and its version only when it matches the schema's pattern;
// anything else skips the row, counted. So every string a signal holds is one of Kanon's codes,
// a version, or a time, and the rendered issue holds those and counts only: never an adopter
// key, a repository, a run id, a login or a path. The output is also checked for every key the
// input held (`assertNoKey`), and refused whole if one appears.
//
//   node scripts/telemetry/kanon-bugs.mjs --rows <file> [--known <file>] [--tag run|test|smoke] [--json]
//   --rows: a JSON array of rows, or one row per line (JSON lines)
//   --known: a JSON array of signatures already filed; a signal not in it is `new`
//   prints: with --json, `{ signals, rises, skipped }`, each signal and rise with its `issue`
//     (`signature`, `title`, `body`); without, a summary of counts
//
// `node:` built-ins only, like every script under scripts/ (`K-SELF-8`).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { KANON_ERRORS, LANES, OUTCOMES, REASONS, STAGES } from '../../actions/agent-telemetry/schema.mjs';
import { MIN_ADOPTERS, assertNoKey, keyOf } from '../../infra/telemetry/function/aggregate.mjs';
import { isCliEntry } from '../lib/cli-entry.mjs';

/**
 * "RISING AFTER A RELEASE", and the sample every comparison between two releases needs.
 * - `minRuns`: a lane needs at least this many runs on EACH of the two releases before their
 *   failure rates are compared, and the previous release needs this many runs of a lane before a
 *   signal's absence there counts as "starting at a release". Twenty keeps one bad afternoon at
 *   one adopter from reading as a regression.
 * - `points`: the failure rate on the newer release must exceed the older one's by at least
 *   this much, as a fraction (0.10 is ten percentage points).
 * The Owner sets both (#41); these are the proposal.
 */
export const RISE = Object.freeze({ minRuns: 20, points: 0.10 });

/** The `api_error_status` codes that are the platform's: rate limits and usage caps, and server errors. */
export const isPlatformStatus = (/** @type {unknown} */ s) => typeof s === 'number' && (s === 429 || (s >= 500 && s <= 599));
/** The reasons that say the configured model was never reached (plan 0002 §2.3). */
export const PLATFORM_REASONS = Object.freeze(['model_never_ran', 'no_model_ran']);

/** The marker an issue body carries its signature in, so the job finds the open issue to update. */
export const MARKER = 'kanon:bug-signature';

const VERSION = /^(\d+\.\d+\.\d+|dev)$/;
/** A field the module reads from a row as an ISO time. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * @typedef {{ adopter?: string, pk?: string, tag?: string, row_kind?: string, recorded_at?: string,
 *   lane?: string, outcome?: string, reason?: string, failed_stage?: string, kanon_error?: string,
 *   kanon_version?: string, api_error_status?: number } & Record<string, unknown>} Row
 * @typedef {'kanon' | 'adopter' | 'platform'} Classification
 * @typedef {{ signature: string, title: string, body: string }} Issue
 * @typedef {{ kind: 'signal', signature: string, lane: string, failed_stage: string | null,
 *   kanon_error: string | null, reason: string, kanon_version: string, runs: number, adopters: number,
 *   first_seen: string, last_seen: string, api_error_status: Record<string, number>,
 *   previous_version: string | null, starts_at_release: boolean, classification: Classification,
 *   visibility: 'public' | 'private', new: boolean, issue: Issue }} Signal
 * @typedef {{ kind: 'rise', signature: string, lane: string, kanon_version: string, previous_version: string,
 *   runs: number, failures: number, rate: number, previous_runs: number, previous_failures: number,
 *   previous_rate: number, adopters: number, previous_adopters: number,
 *   visibility: 'public' | 'private', new: boolean, issue: Issue }} Rise
 * @typedef {{ not_run: number, no_version: number, no_adopter: number, unknown_code: number }} Skipped
 */

/**
 * Compare two versions: a release by its numbers, and `dev` after every release.
 * @param {string} a @param {string} b
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  if (a === 'dev') return 1;
  if (b === 'dev') return -1;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * A signature: the kind and the identifying fields, never a count, so a signal keeps its
 * signature as its counts grow, and the job updates the open issue instead of filing another.
 * @param {string[]} parts
 */
const hash = (parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
/** @param {{ lane: string, failed_stage: string | null, kanon_error: string | null, reason: string, kanon_version: string }} s */
export const signalSignature = (s) => hash(['signal', s.lane, s.failed_stage ?? '-', s.kanon_error ?? '-', s.reason, s.kanon_version]);
/** @param {{ lane: string, kanon_version: string }} r */
export const riseSignature = (r) => hash(['rise', r.lane, r.kanon_version]);

/** A field read only when it is one of Kanon's codes, else `undefined`; absent is `null`. */
const codeIn = (/** @type {unknown} */ v, /** @type {readonly string[]} */ list) => (v === undefined || v === null || v === '' ? null : typeof v === 'string' && list.includes(v) ? v : undefined);

/**
 * The adopter's key: `adopter`, or the stored partition's prefix.
 * @param {Row} row
 */
const adopterOf = (row) => (typeof row.adopter === 'string' && row.adopter !== '' ? row.adopter : keyOf(row.pk));

/**
 * The signals and rises in a set of rows (the file's head says what each is).
 * @param {Row[]} rows
 * @param {{ known?: Iterable<string>, tag?: string }} [opts] `known`: the signatures already filed
 * @returns {{ signals: Signal[], rises: Rise[], skipped: Skipped }}
 */
export function detect(rows, { known = [], tag = 'run' } = {}) {
  const knownSet = new Set(known);
  /** @type {Skipped} */
  const skipped = { not_run: 0, no_version: 0, no_adopter: 0, unknown_code: 0 };
  /** @type {Set<string>} */
  const keys = new Set();
  /** Every run, failed or not, by lane and version: the denominators. */
  /** @type {Map<string, { runs: number, failures: number, adopters: Set<string> }>} */
  const totals = new Map();
  /** @type {Map<string, { lane: string, failed_stage: string | null, kanon_error: string | null, reason: string,
   *   kanon_version: string, runs: number, platform: number, adopters: Set<string>, first: string, last: string,
   *   statuses: Record<string, number> }>} */
  const groups = new Map();
  /** @type {Set<string>} */
  const versions = new Set();

  for (const row of rows) {
    if (row === null || typeof row !== 'object' || row.row_kind !== 'run' || row.tag !== tag) { skipped.not_run += 1; continue; }
    const key = adopterOf(row);
    if (key) keys.add(key);
    if (typeof row.kanon_version !== 'string' || !VERSION.test(row.kanon_version)) { skipped.no_version += 1; continue; }
    if (!key) { skipped.no_adopter += 1; continue; }
    const lane = codeIn(row.lane, LANES);
    const reason = codeIn(row.reason, REASONS);
    const stage = codeIn(row.failed_stage, STAGES);
    const error = codeIn(row.kanon_error, KANON_ERRORS);
    const okOutcome = row.outcome === 'ok';
    if (!lane || !reason || stage === undefined || error === undefined || !codeIn(row.outcome, OUTCOMES)
      || typeof row.recorded_at !== 'string' || !ISO.test(row.recorded_at)) { skipped.unknown_code += 1; continue; }
    const version = row.kanon_version;
    versions.add(version);
    const status = Number.isInteger(row.api_error_status) ? /** @type {number} */ (row.api_error_status) : null;
    const platform = PLATFORM_REASONS.includes(reason) || isPlatformStatus(status);

    const tk = `${lane}\u0000${version}`;
    const t = totals.get(tk) ?? { runs: 0, failures: 0, adopters: new Set() };
    totals.set(tk, t);
    t.runs += 1;
    t.adopters.add(key);
    if (okOutcome) continue;
    if (!platform) t.failures += 1;

    const gk = JSON.stringify([lane, stage, error, reason, version]);
    const g = groups.get(gk) ?? { lane, failed_stage: stage, kanon_error: error, reason, kanon_version: version, runs: 0, platform: 0, adopters: new Set(), first: row.recorded_at, last: row.recorded_at, statuses: {} };
    groups.set(gk, g);
    g.runs += 1;
    if (platform) g.platform += 1;
    g.adopters.add(key);
    if (row.recorded_at < g.first) g.first = row.recorded_at;
    if (row.recorded_at > g.last) g.last = row.recorded_at;
    if (status !== null && status >= 100 && status <= 599) g.statuses[String(status)] = (g.statuses[String(status)] ?? 0) + 1;
  }

  const releases = [...versions].filter((v) => v !== 'dev').sort(compareVersions);
  /** The release before `v` among those seen, or null; `dev` is not among them, so it has none. */
  const previousOf = (/** @type {string} */ v) => {
    const i = releases.indexOf(v);
    return i > 0 ? /** @type {string} */ (releases[i - 1]) : null;
  };
  const visibility = (/** @type {number} */ n) => (n >= MIN_ADOPTERS ? 'public' : 'private');

  /** @type {Signal[]} */
  const signals = [...groups.values()].map((g) => {
    const previous = previousOf(g.kanon_version);
    const prevTotal = previous ? totals.get(`${g.lane}\u0000${previous}`) : undefined;
    const onPrevious = previous ? groups.has(JSON.stringify([g.lane, g.failed_stage, g.kanon_error, g.reason, previous])) : false;
    const startsAtRelease = Boolean(prevTotal && prevTotal.runs >= RISE.minRuns && !onPrevious);
    /** @type {Classification} */
    const classification = g.platform === g.runs ? 'platform' : g.adopters.size >= 2 || startsAtRelease ? 'kanon' : 'adopter';
    const base = {
      kind: /** @type {const} */ ('signal'), lane: g.lane, failed_stage: g.failed_stage, kanon_error: g.kanon_error, reason: g.reason,
      kanon_version: g.kanon_version, runs: g.runs, adopters: g.adopters.size, first_seen: g.first, last_seen: g.last,
      api_error_status: Object.fromEntries(Object.entries(g.statuses).sort(([a], [b]) => Number(a) - Number(b))),
      previous_version: previous, starts_at_release: startsAtRelease, classification,
      visibility: /** @type {'public' | 'private'} */ (visibility(g.adopters.size)),
    };
    const signature = signalSignature(base);
    const s = { ...base, signature, new: !knownSet.has(signature) };
    return { ...s, issue: renderIssue(s) };
  });

  /** @type {Rise[]} */
  const rises = [];
  for (const [tk, t] of totals) {
    const [lane = '', version = ''] = tk.split('\u0000');
    const previous = previousOf(version);
    const p = previous ? totals.get(`${lane}\u0000${previous}`) : undefined;
    if (!previous || !p || t.runs < RISE.minRuns || p.runs < RISE.minRuns) continue;
    const rate = t.failures / t.runs;
    const previousRate = p.failures / p.runs;
    // Compared in whole hundredths of a percent, so floating-point noise never decides a threshold.
    if (Math.round((rate - previousRate) * 1e4) < Math.round(RISE.points * 1e4)) continue;
    const base = {
      kind: /** @type {const} */ ('rise'), lane, kanon_version: version, previous_version: previous,
      runs: t.runs, failures: t.failures, rate: round(rate), previous_runs: p.runs, previous_failures: p.failures,
      previous_rate: round(previousRate), adopters: t.adopters.size, previous_adopters: p.adopters.size,
      // Both rates combine adopters' runs, so each must clear the three-adopter rule.
      visibility: /** @type {'public' | 'private'} */ (visibility(Math.min(t.adopters.size, p.adopters.size))),
    };
    const signature = riseSignature(base);
    const r = { ...base, signature, new: !knownSet.has(signature) };
    rises.push({ ...r, issue: renderIssue(r) });
  }

  const ORDER = { kanon: 0, adopter: 1, platform: 2 };
  signals.sort((a, b) => ORDER[a.classification] - ORDER[b.classification] || b.adopters - a.adopters || b.runs - a.runs || a.signature.localeCompare(b.signature));
  rises.sort((a, b) => a.lane.localeCompare(b.lane) || compareVersions(a.kanon_version, b.kanon_version));
  const result = { signals, rises, skipped };
  assertNoKey(result, keys);
  return result;
}

const round = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4;
const pct = (/** @type {number} */ n) => `${(n * 100).toFixed(1)}%`;
const day = (/** @type {string} */ t) => t.slice(0, 10);
const orNone = (/** @type {string | null} */ v) => (v === null ? 'none' : `\`${v}\``);

const CAUSE = {
  kanon: 'Kanon, most likely: the same failure at two adopters or more, or starting at a release.',
  adopter: "The adopter's setup, most likely: one adopter only.",
  platform: 'The platform: every run carries a rate limit, usage cap, server error or unreachable model. Neither Kanon nor the adopter.',
};

/**
 * The issue for a signal or a rise: its signature, a title and a body built from Kanon's codes,
 * versions, counts and the adopter count only. Nothing in it comes from a row's free text.
 * @param {Omit<Signal, 'issue'> | Omit<Rise, 'issue'>} x
 * @returns {Issue}
 */
export function renderIssue(x) {
  const out = [];
  if (x.kind === 'signal') {
    const what = x.kanon_error ? `\`${x.kanon_error}\`` : `\`${x.reason}\``;
    const where = x.failed_stage ? ` at stage \`${x.failed_stage}\`` : '';
    const title = `Kanon bug signal: ${x.lane} lane, ${what}${where}, on ${x.kanon_version}`;
    out.push(
      `Detected in adopters' telemetry by \`scripts/telemetry/kanon-bugs.mjs\` (#41). Counts and codes only: no adopter, repository or run is named.`,
      '',
      '| | |', '|---|---|',
      `| Lane | \`${x.lane}\` |`,
      `| Failed stage | ${orNone(x.failed_stage)} |`,
      `| Kanon error | ${orNone(x.kanon_error)} |`,
      `| Reason | \`${x.reason}\` |`,
      `| Kanon version | \`${x.kanon_version}\`${x.previous_version ? ` (previous seen: \`${x.previous_version}\`)` : ''} |`,
      `| Runs | ${x.runs} |`,
      `| Adopters affected | ${x.adopters} |`,
      `| API error status | ${Object.entries(x.api_error_status).map(([s, n]) => `${s} × ${n}`).join(', ') || 'none'} |`,
      `| First seen | ${day(x.first_seen)} |`,
      `| Last seen | ${day(x.last_seen)} |`,
      '',
      `**Classification: \`${x.classification}\`.** ${CAUSE[x.classification]}${x.starts_at_release ? ` It starts at this release: absent on \`${x.previous_version}\`, which ran this lane at least ${RISE.minRuns} times.` : ''}`,
    );
    out.push('', 'A human triages this issue; the job that filed it does nothing else (`K-PRIN-6`).', '', `<!-- ${MARKER}=${x.signature} -->`);
    return { signature: x.signature, title, body: out.join('\n') };
  }
  const title = `Kanon bug signal: ${x.lane} lane fails more on ${x.kanon_version} than on ${x.previous_version}`;
  out.push(
    `Detected in adopters' telemetry by \`scripts/telemetry/kanon-bugs.mjs\` (#41). Counts only: no adopter, repository or run is named.`,
    '',
    '| Kanon version | Runs | Failures | Failure rate | Adopters |', '|---|---|---|---|---|',
    `| \`${x.previous_version}\` | ${x.previous_runs} | ${x.previous_failures} | ${pct(x.previous_rate)} | ${x.previous_adopters} |`,
    `| \`${x.kanon_version}\` | ${x.runs} | ${x.failures} | ${pct(x.rate)} | ${x.adopters} |`,
    '',
    `The \`${x.lane}\` lane's failure rate rose by ${pct(x.rate - x.previous_rate)}, past the threshold of ${pct(RISE.points)} with at least ${RISE.minRuns} runs on each release. Runs that failed on a platform code (a rate limit, usage cap, server error or unreachable model) are not counted as failures.`,
    '', 'A human triages this issue; the job that filed it does nothing else (`K-PRIN-6`).', '', `<!-- ${MARKER}=${x.signature} -->`,
  );
  return { signature: x.signature, title, body: out.join('\n') };
}

/**
 * Rows from a file's text: a JSON array, or one JSON row per line.
 * @param {string} text
 * @returns {Row[]}
 */
export function parseRows(text) {
  const t = text.trim();
  if (t === '') return [];
  if (t.startsWith('[')) {
    const v = JSON.parse(t);
    if (!Array.isArray(v)) throw new Error('--rows is not a JSON array');
    return v;
  }
  return t.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** The summary line, counts only. @param {ReturnType<typeof detect>} r */
export function summary(r) {
  const by = (/** @type {string} */ c) => r.signals.filter((s) => s.classification === c).length;
  const skipped = Object.entries(r.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
  return `${r.signals.length} signal(s): ${by('kanon')} kanon, ${by('adopter')} adopter, ${by('platform')} platform; `
    + `${r.signals.filter((s) => s.new).length} new, ${r.signals.filter((s) => s.visibility === 'public').length} public. `
    + `${r.rises.length} rise(s) after a release.${skipped ? ` Rows skipped: ${skipped}.` : ''}`;
}

/**
 * The CLI, as a function the tests call.
 * @param {string[]} argv
 * @returns {{ code: number, out: string }}
 */
export function main(argv) {
  const usage = 'usage: kanon-bugs.mjs --rows <file> [--known <file>] [--tag run|smoke|test] [--json]';
  /** @type {Record<string, string>} */
  const opts = {};
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if ((a === '--rows' || a === '--known' || a === '--tag') && argv[i + 1] !== undefined) { opts[a.slice(2)] = /** @type {string} */ (argv[i + 1]); i += 1; continue; }
    return { code: 2, out: usage };
  }
  if (!opts.rows) return { code: 2, out: usage };
  if (opts.tag && !['run', 'smoke', 'test'].includes(opts.tag)) return { code: 2, out: usage };
  let rows;
  /** @type {string[]} */
  let known = [];
  try {
    rows = parseRows(readFileSync(opts.rows, 'utf8'));
    if (opts.known) {
      const k = JSON.parse(readFileSync(opts.known, 'utf8'));
      if (!Array.isArray(k) || !k.every((s) => typeof s === 'string')) return { code: 2, out: '--known is not a JSON array of signatures' };
      known = k;
    }
  } catch (e) {
    // The error's name only: a message could quote a row, and a row holds what must not be printed.
    return { code: 2, out: `could not read the input (${e instanceof Error ? e.name : 'error'})` };
  }
  const r = detect(rows, { known, tag: opts.tag ?? 'run' });
  return { code: 0, out: json ? JSON.stringify(r, null, 2) : summary(r) };
}

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  const { code, out } = main(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exit(code);
}
/* c8 ignore stop */
