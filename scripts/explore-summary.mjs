#!/usr/bin/env node
// The Explorer's sweep summary (plan 0004 §4, step 12; decision 5): the one file Kanon's
// Explorer lane reads from the adopter's sweep hook, `.github/actions/explore-sweep/action.yml`.
//
// WHAT THE SWEEP IS, AND HOW, IS THE ADOPTER'S. What it hands the lane is Kanon's: one JSON
// object at `qa-explore-summary.json`, in the format below, which the lane checks, gives the
// agent, and `put`s to the QA store. Moved from the reference adopter's sweep hook (RA-2746),
// where `checkSummary` was the format's executable definition (ADR 0009). docs/explore-sweep.md
// is its prose.
//
//   timestamp     string   ISO 8601 in `Date#toISOString`'s shape, when the summary was written
//   trigger       string   the event that ran the sweep (`schedule`, `workflow_dispatch`)
//   commit        string   the commit swept
//   tier          string   the tier swept; `all` when the run asked for none
//   routes_swept  integer  the number of entries in `routes`
//   passed        integer  the entries whose status is `passed`
//   failed        integer  the entries whose status is `failed`
//   routes        array    one { route, status, signal? } per route swept: `route` a string,
//                          `status` `passed` or `failed`, and `signal` (a string, the first
//                          objective signal) only on a failed route that reported one
//   cost_proxy    object   { duration_ms_total: number, screenshots: integer }
//
// No other key, at any level. `passed + failed == routes_swept`.
//
// NO VERSION KEY, ON PURPOSE (plan 0004 §4's first open item). The summary is also the raw
// object the store keeps for each run, so a key added now would change every stored report
// from here on, for a reader that has nothing to tell apart: there is one format. A summary
// in any other shape fails here by name, so a hook and a lane that disagree fail loudly, never
// silently. If a second format ever ships, it adds a `format` key, and a summary without one is
// this format: so the old reports still read, and nothing is stamped today.
//
// NO SUMMARY IS NO SWEEP, NEVER GREEN. A sweep that wrote no report writes no file. The lane
// reads a missing file, a malformed one, one for another commit or tier, and one that swept no
// route as no sweep: the job fails by name, the agent doesn't run, and nothing is `put`, so the
// change gate never takes it for a green baseline.
//
//   node explore-summary.mjs check <summary.json> [--commit <sha>] [--tier <tier>]
//
// Exits 0 on a summary the lane can read, printing one line and writing `routes_swept`,
// `passed` and `failed` to `$GITHUB_OUTPUT`; 1 with one `::error` per problem otherwise; 2 on a
// usage error. Node's built-ins only.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The summary's path, at the root of the checkout (decision 5): the lane reads nothing else. */
export const SUMMARY_FILE = 'qa-explore-summary.json';
export const SUMMARY_KEYS = Object.freeze(['timestamp', 'trigger', 'commit', 'tier', 'routes_swept', 'passed', 'failed', 'routes', 'cost_proxy']);
export const ROUTE_KEYS = Object.freeze(['route', 'status', 'signal']);
export const COST_KEYS = Object.freeze(['duration_ms_total', 'screenshots']);
export const STATUSES = Object.freeze(['passed', 'failed']);
/** The tier a run that asked for none records. */
export const ALL_TIERS = 'all';

/** `Date#toISOString`'s shape: `Date.parse` alone accepts '1' and 'Oct 4 2026'. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** @param {unknown} v */
const isCount = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
/** @param {unknown} v */
const isText = (v) => typeof v === 'string' && v !== '';
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * What is wrong with a summary, against the format in this file's header. Empty when it is well
 * formed. Each problem names the key, so a failure says what drifted.
 * @param {unknown} s
 * @returns {string[]}
 */
export function checkSummary(s) {
  if (!isObject(s)) return ['the summary is not a JSON object'];
  /** @type {string[]} */
  const problems = [];
  for (const k of SUMMARY_KEYS) if (!(k in s)) problems.push(`\`${k}\` is missing`);
  for (const k of Object.keys(s)) if (!SUMMARY_KEYS.includes(k)) problems.push(`\`${k}\` is not a summary key`);
  if ('timestamp' in s && !(isText(s.timestamp) && ISO.test(/** @type {string} */ (s.timestamp)) && !Number.isNaN(Date.parse(/** @type {string} */ (s.timestamp))))) problems.push('`timestamp` is not an ISO date');
  for (const k of ['trigger', 'commit', 'tier']) if (k in s && !isText(s[k])) problems.push(`\`${k}\` is not a non-empty string`);
  for (const k of ['routes_swept', 'passed', 'failed']) if (k in s && !isCount(s[k])) problems.push(`\`${k}\` is not a count`);
  if ('routes' in s) {
    const routes = s.routes;
    if (!Array.isArray(routes)) problems.push('`routes` is not an array');
    else {
      routes.forEach((r, i) => {
        if (!isObject(r)) { problems.push(`routes[${i}] is not an object`); return; }
        for (const k of Object.keys(r)) if (!ROUTE_KEYS.includes(k)) problems.push(`routes[${i}].${k} is not a route key`);
        if (!isText(r.route)) problems.push(`routes[${i}].route is not a non-empty string`);
        if (!STATUSES.includes(/** @type {string} */ (r.status))) problems.push(`routes[${i}].status is not passed or failed`);
        if ('signal' in r && (r.status !== 'failed' || !isText(r.signal))) problems.push(`routes[${i}].signal is only a non-empty string on a failed route`);
      });
      /** @param {string} st */
      const by = (st) => routes.filter((r) => isObject(r) && r.status === st).length;
      if (s.routes_swept !== routes.length) problems.push(`\`routes_swept\` is ${s.routes_swept}, and \`routes\` holds ${routes.length}`);
      if (s.passed !== by('passed')) problems.push(`\`passed\` is ${s.passed}, and ${by('passed')} routes passed`);
      if (s.failed !== by('failed')) problems.push(`\`failed\` is ${s.failed}, and ${by('failed')} routes failed`);
    }
  }
  // The plan's own equation, checked on its own: it holds even when `routes` is malformed.
  if (isCount(s.routes_swept) && isCount(s.passed) && isCount(s.failed)
    && /** @type {number} */ (s.passed) + /** @type {number} */ (s.failed) !== s.routes_swept) {
    problems.push(`\`passed\` + \`failed\` is ${/** @type {number} */ (s.passed) + /** @type {number} */ (s.failed)}, not \`routes_swept\` (${s.routes_swept})`);
  }
  if ('cost_proxy' in s) {
    const c = s.cost_proxy;
    if (!isObject(c)) problems.push('`cost_proxy` is not an object');
    else {
      for (const k of Object.keys(c)) if (!COST_KEYS.includes(k)) problems.push(`cost_proxy.${k} is not a cost key`);
      if (typeof c.duration_ms_total !== 'number' || !(c.duration_ms_total >= 0)) problems.push('cost_proxy.duration_ms_total is not a non-negative number');
      if (!isCount(c.screenshots)) problems.push('cost_proxy.screenshots is not a count');
    }
  }
  return problems;
}

/**
 * What makes a well-formed summary unusable for THIS run: another commit, another tier, or no
 * route at all. Each is a sweep the lane can't vouch for, so each is read as no sweep. A summary
 * of no route would otherwise be recorded as a green full sweep, and the change gate would skip
 * the next scheduled run on that commit.
 * @param {Record<string, unknown>} s a summary `checkSummary` passed
 * @param {{ commit?: string, tier?: string }} run
 * @returns {string[]}
 */
export function runProblems(s, { commit = '', tier = '' } = {}) {
  /** @type {string[]} */
  const problems = [];
  if (commit && s.commit !== commit) problems.push(`\`commit\` is ${String(s.commit)}, and this run swept ${commit}`);
  const want = tier || ALL_TIERS;
  if (s.tier !== want) problems.push(`\`tier\` is ${String(s.tier)}, and this run asked for ${want}`);
  if (s.routes_swept === 0) problems.push('the sweep swept no route');
  return problems;
}

/**
 * Read and judge the summary at `path` for this run.
 * @param {string} path
 * @param {{ commit?: string, tier?: string }} [run]
 * @returns {{ ok: true, summary: Record<string, unknown> } | { ok: false, problems: string[] }}
 */
export function readSummary(path, run = {}) {
  if (!existsSync(path)) {
    return { ok: false, problems: [`the sweep hook wrote no ${SUMMARY_FILE}: no sweep, which is never green`] };
  }
  /** @type {unknown} */
  let s;
  try {
    s = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, problems: [`${SUMMARY_FILE} is not JSON`] };
  }
  const shape = checkSummary(s);
  if (shape.length) return { ok: false, problems: shape };
  const summary = /** @type {Record<string, unknown>} */ (s);
  const mismatch = runProblems(summary, run);
  if (mismatch.length) return { ok: false, problems: mismatch };
  return { ok: true, summary };
}

const usage = 'usage: explore-summary.mjs check <summary.json> [--commit <sha>] [--tier <tier>]';

/**
 * @param {string[]} argv the arguments after the script
 * @returns {{ code: number, lines: string[], outputs: Record<string, string> }}
 */
export function cli(argv) {
  const [mode, path, ...rest] = argv;
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i] ?? '';
    if (!['--commit', '--tier'].includes(k) || rest[i + 1] === undefined) return { code: 2, lines: [usage], outputs: {} };
    flags[k.slice(2)] = /** @type {string} */ (rest[i + 1]);
  }
  if (mode !== 'check' || !path) return { code: 2, lines: [usage], outputs: {} };
  const r = readSummary(path, flags);
  if (!r.ok) {
    return {
      code: 1,
      lines: [
        ...r.problems.map((p) => `::error title=Explorer sweep summary::${p}`),
        `The sweep's summary can't be read (${r.problems.length} problem(s), each above), so this run is no sweep: the agent doesn't run and nothing is recorded. The format is in Kanon's docs/explore-sweep.md.`,
      ],
      outputs: {},
    };
  }
  const s = r.summary;
  return {
    code: 0,
    lines: [`Sweep of \`${String(s.commit).slice(0, 12)}\`, tier \`${String(s.tier)}\`: ${String(s.routes_swept)} routes, ${String(s.passed)} passed, ${String(s.failed)} failed.`],
    outputs: { routes_swept: String(s.routes_swept), passed: String(s.passed), failed: String(s.failed) },
  };
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  const { code, lines, outputs } = cli(process.argv.slice(2));
  for (const l of lines) (code === 2 ? process.stderr : process.stdout).write(`${l}\n`);
  if (code === 0) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines[0]}\n`);
  } else if (code === 1 && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.at(-1)}\n`);
  }
  process.exitCode = code;
}
