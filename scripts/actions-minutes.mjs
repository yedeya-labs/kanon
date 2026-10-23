#!/usr/bin/env node
// What each lane costs in GitHub Actions runner-minutes, measured from a repository's own runs
// (kanon#581).
//
// WHY. Kanon ran about 11,000 Actions runs in one week, about 800 runner-minutes a day. On a
// public repository those minutes are free; on a private one they are billed, and an adopter
// choosing lanes had no figure to estimate them by. docs/actions-minutes.md gives the figures,
// and the catalogue's `minutes` (docs/lanes.json) puts each lane's in front of the person the
// adopt skill asks. This script is where they come from, so they can be refreshed rather than
// remembered.
//
// HOW IT MEASURES, read-only, through `gh api`:
//   1. each lane's caller on the default branch, as the library finds it (scripts/lib/lane-caller.mjs);
//      a lane nothing calls is "not measured", never a zero;
//   2. every completed run of that caller created in the window, which ends when it measures,
//      splitting a range GitHub would cut at 1,000 runs. A caller younger than the window is
//      measured from when GitHub registered it, so a lane added mid-week isn't diluted over days
//      it didn't exist; the report says how many days each lane's figures rest on;
//   3. the jobs of up to `--sample` of those runs, every attempt included, drawn from two groups
//      the run listing tells apart without reading a job: runs that lasted past a minute, start to
//      last update, and the rest (kanon#1211). Each group is sampled on its own, up to `--sample`
//      runs spread evenly over the window, so a lane whose runs are nearly all skipped gate checks
//      still has its few model runs read (triage: about 580 runs, 6 of them model runs), and each
//      sampled run stands for its group's share of the runs. A run's minutes are its jobs' minutes, each rounded up to a whole minute, which is
//      how GitHub bills a job; a skipped job, or one that never started, bills nothing. A reusable
//      workflow's jobs are listed under the run that called it, so a lane's nested jobs count.
//   4. the minutes of the runs, estimated group by group (a group's mean times its runs), over the
//      days measured is the lane's minutes a day.
// A run is SHORT when no job of it ran past one minute: a run the lane's gate or filter turned
// away, a skipped run, or a no-model lane with nothing to do. It costs a minute or two whatever
// it was.
//
// WHAT IT DOESN'T: it doesn't know the runner's multiplier (Kanon's jobs ask for `ubuntu-latest`,
// billed at 1x), and it reads only the lanes' callers, not your CI or other workflows.
//
// Usage: GITHUB_REPOSITORY=owner/repo node "$KANON/scripts/actions-minutes.mjs" [--days 7] [--sample 40] [--json]
// with a `gh` token that can read the repository's Actions. It prints the report
// docs/actions-minutes.md holds between its markers.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { readSnapshot, resolveCaller } from './lib/lane-caller.mjs';
import { trustedSearchSync } from './lib/search.mjs';

/** GitHub returns at most this many runs for one filtered listing, whatever its total_count says. */
const LISTING_CAP = 1000;
const PAGE = 100;
const DAY = 86_400_000;

/** The table's header, which docs/actions-minutes.md holds and `readTable` finds the table by. */
export const TABLE_HEADER = '| Lane | Caller | Days measured | Runs a day | Short runs | Minutes a short run | Minutes another run (median) | Minutes a day |';

/**
 * @typedef {{ conclusion: string | null, started_at: string | null, completed_at: string | null }} Job
 * @typedef {{ lane: string, caller: string | null, days: number, runs: number, sampled: number, short: number,
 *   shortMinutes: number | null, otherMinutes: number | null, perDay: number, minutesPerDay: number,
 *   longRuns: number, longSampled: number }} Row
 *   `short` is the runs estimated short, of all `runs`; `longRuns` the runs the listing shows lasting
 *   past a minute and `longSampled` how many of them were read, the rest of `sampled` being the others.
 * @typedef {{ repo: string, since: string, until: string, days: number, sample: number,
 *   activity: { pullRequests: number, merged: number, issues: number }, rows: Row[] }} Measurement
 */

/** Each job that ran, in whole billed minutes: rounded up, as GitHub bills a job. @param {Job} j */
const jobMinutes = (j) => {
  if (j.conclusion === 'skipped' || !j.started_at || !j.completed_at) return 0;
  const ms = Date.parse(j.completed_at) - Date.parse(j.started_at);
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
};

/** What a run bills: its jobs' minutes, each rounded up on its own. @param {Job[]} jobs */
export const billedMinutes = (jobs) => jobs.reduce((n, j) => n + jobMinutes(j), 0);

/** A short run: no job of it ran past one minute. @param {Job[]} jobs */
export const isShort = (jobs) => jobs.every((j) => jobMinutes(j) <= 1);

/**
 * `n` of `items`, spread evenly from the first to the last, the same ones on every read.
 * @template T @param {T[]} items @param {number} n @returns {T[]}
 */
export const sampleEvenly = (items, n) => {
  if (n >= items.length) return [...items];
  if (n <= 1) return items.slice(0, Math.max(n, 0));
  return [...Array(n).keys()].map((i) => /** @type {T} */ (items[Math.round((i * (items.length - 1)) / (n - 1))]));
};

/** A run the listing shows lasting past a minute, start to last update: one that may have run its agent job. */
const LONG_RUN_MS = 60_000;

/**
 * Whether the run listing shows a run lasting past a minute, from its own times, before any of its
 * jobs is read. A run without both times is counted with the rest.
 * @param {{ run_started_at?: string | null, updated_at?: string | null }} run
 */
export const looksLong = (run) => {
  const ms = Date.parse(run.updated_at ?? '') - Date.parse(run.run_started_at ?? '');
  return ms > LONG_RUN_MS;
};

/**
 * Up to `n` runs from each group, the long-looking runs and the rest, each spread evenly over the
 * window, with the share of its group's runs each one stands for (kanon#1211).
 * @template {{ run_started_at?: string | null, updated_at?: string | null }} T
 * @param {T[]} runs in the order they were created @param {number} n
 * @returns {{ picked: Array<{ run: T, weight: number, long: boolean }>, longRuns: number, longSampled: number }}
 */
export const sampleByGroup = (runs, n) => {
  const long = runs.filter(looksLong);
  const rest = runs.filter((r) => !looksLong(r));
  /** @param {T[]} group @param {boolean} isLong */
  const draw = (group, isLong) => {
    const got = sampleEvenly(group, n);
    return got.map((run) => ({ run, weight: group.length / got.length, long: isLong }));
  };
  const fromLong = draw(long, true);
  return { picked: [...fromLong, ...draw(rest, false)], longRuns: long.length, longSampled: fromLong.length };
};

/** A figure as the report gives it: one decimal under ten, whole above. @param {number} x */
const figure = (x) => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));

/** @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? /** @type {number} */ (s[mid]) : (/** @type {number} */ (s[mid - 1]) + /** @type {number} */ (s[mid])) / 2;
};

/** ISO without milliseconds, as the `created` filter takes it. @param {number} ms */
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `2026-10-08 00:00`, as the report gives a time. @param {string} t */
const minute = (t) => t.slice(0, 16).replace('T', ' ');

/**
 * Every completed run of `file` created between `from` and `to` (inclusive, ms), splitting a range
 * whose runs GitHub would cut at 1,000.
 * @param {(args: string[]) => any} gh @param {string} repo @param {string} file @param {number} from @param {number} to
 * @returns {Array<{ id: number, created_at: string, run_started_at?: string | null, updated_at?: string | null }>}
 */
const listRuns = (gh, repo, file, from, to) => {
  const url = (/** @type {number} */ page) => `repos/${repo}/actions/workflows/${file}/runs?created=${iso(from)}..${iso(to)}&exclude_pull_requests=true&per_page=${PAGE}&page=${page}`;
  const first = gh(['api', url(1)]);
  const total = Number(first?.total_count ?? 0);
  if (total > LISTING_CAP && to - from > 1000) {
    const mid = from + Math.floor((to - from) / 2 / 1000) * 1000;
    return [...listRuns(gh, repo, file, from, mid), ...listRuns(gh, repo, file, mid + 1000, to)];
  }
  const runs = [...(first?.workflow_runs ?? [])];
  for (let page = 2; (page - 1) * PAGE < Math.min(total, LISTING_CAP); page++) runs.push(...(gh(['api', url(page)])?.workflow_runs ?? []));
  return runs.filter((r) => r.status === 'completed');
};

/** Every job of a run, every attempt's. @param {(args: string[]) => any} gh @param {string} repo @param {number} id @returns {Job[]} */
const listJobs = (gh, repo, id) => {
  /** @type {Job[]} */
  const jobs = [];
  for (let page = 1; ; page++) {
    const res = gh(['api', `repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=${PAGE}&page=${page}`]);
    const got = res?.jobs ?? [];
    jobs.push(...got);
    if (!got.length || jobs.length >= Number(res?.total_count ?? 0)) return jobs;
  }
};

/**
 * How many issues or pull requests a search finds, settled before it is printed: search can answer
 * 0 for a query with matches, so a doubtful answer is read again (`scripts/lib/search.mjs`, kanon#1322).
 * @param {(args: string[]) => any} gh @param {string} q
 */
const count = (gh, q) => trustedSearchSync(() => gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', 'per_page=1']), { what: `\`${q}\`` }).total_count;

/**
 * Measure each lane's runner-minutes over the `days` before `now`.
 * @param {{ repo: string, gh: (args: string[]) => any, now: string, days: number, sample: number, lanes: string[], log?: (msg: string) => void }} io
 * @returns {Measurement}
 */
export function measure({ repo, gh, now, days, sample, lanes, log = (m) => console.error(m) }) {
  const to = Math.floor(Date.parse(now) / 1000) * 1000;
  const from = to - days * DAY;
  const snapshot = readSnapshot({ repo, json: gh });
  /** @type {Row[]} */
  const rows = [];
  for (const lane of lanes) {
    const caller = resolveCaller(lane, snapshot);
    if (caller.how === 'fallback') {
      log(`actions-minutes: ${lane}: ${caller.reason}; not measured`);
      rows.push({ lane, caller: null, days: 0, runs: 0, sampled: 0, short: 0, shortMinutes: null, otherMinutes: null, perDay: 0, minutesPerDay: 0, longRuns: 0, longSampled: 0 });
      continue;
    }
    const registered = Date.parse(gh(['api', `repos/${repo}/actions/workflows/${caller.file}`])?.created_at ?? '');
    const start = Number.isNaN(registered) ? from : Math.max(from, Math.ceil(registered / 1000) * 1000);
    const span = (to - start) / DAY;
    const runs = listRuns(gh, repo, caller.file, start, to).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    const { picked, longRuns, longSampled } = sampleByGroup(runs, sample);
    // Each sampled run stands for `weight` runs of its group, so the estimates are its group's.
    const read = picked.map(({ run, weight }) => {
      const jobs = listJobs(gh, repo, run.id);
      return { weight, minutes: billedMinutes(jobs), short: isShort(jobs) };
    });
    /** @param {typeof read} xs */
    const weightOf = (xs) => xs.reduce((n, x) => n + x.weight, 0);
    /** @param {typeof read} xs */
    const minutesOf = (xs) => xs.reduce((n, x) => n + x.weight * x.minutes, 0);
    const short = read.filter((x) => x.short);
    const other = read.filter((x) => !x.short);
    log(`actions-minutes: ${lane}: ${runs.length} runs of ${caller.file} in ${figure(span)} days; read ${longSampled} of ${longRuns} that lasted past a minute and ${picked.length - longSampled} of the other ${runs.length - longRuns}`);
    rows.push({
      lane,
      caller: caller.file,
      days: figure(span),
      runs: runs.length,
      sampled: picked.length,
      short: Math.round(weightOf(short)),
      shortMinutes: short.length ? figure(minutesOf(short) / weightOf(short)) : null,
      otherMinutes: other.length ? figure(median(other.map((x) => x.minutes))) : null,
      perDay: span > 0 ? figure(runs.length / span) : 0,
      minutesPerDay: span > 0 ? figure(minutesOf(read) / span) : 0,
      longRuns,
      longSampled,
    });
  }
  const since = iso(from);
  const until = iso(to);
  const span = `${since}..${until}`;
  const activity = {
    pullRequests: count(gh, `repo:${repo} is:pr created:${span}`),
    merged: count(gh, `repo:${repo} is:pr is:merged merged:${span}`),
    issues: count(gh, `repo:${repo} is:issue created:${span}`),
  };
  return { repo, since, until, days, sample, activity, rows };
}

/** @param {number | null} x */
const cell = (x) => (x === null ? '—' : String(x));

/**
 * The report docs/actions-minutes.md holds between its markers: what was measured, and the table.
 * @param {Measurement} m
 */
export function renderReport(m) {
  const { activity: a, days } = m;
  const measured = m.rows.filter((r) => r.caller);
  const total = figure(measured.reduce((n, r) => n + r.minutesPerDay, 0));
  const lines = [
    `Measured on \`${m.repo}\` over the ${days} days from ${minute(m.since)} to ${minute(m.until)} UTC, in which ${a.pullRequests} pull requests were opened (${figure(a.pullRequests / days)} a day), ${a.merged} merged (${figure(a.merged / days)} a day) and ${a.issues} issues opened (${figure(a.issues / days)} a day). Each lane's minutes come from the jobs of up to ${m.sample} of its runs that lasted past a minute and up to ${m.sample} of the rest, each spread evenly over the window and standing for its group's share of the runs; a lane whose caller is younger than the window is measured over the days it has existed.`,
    '',
    TABLE_HEADER,
    '|---|---|---|---|---|---|---|---|',
    ...m.rows.map((r) => r.caller
      ? `| \`${r.lane}\` | \`${r.caller}\` | ${r.days} | ${r.perDay} | ${r.runs && r.sampled ? `${Math.round((100 * r.short) / r.runs)}%` : '—'} | ${cell(r.shortMinutes)} | ${cell(r.otherMinutes)} | ${r.minutesPerDay} |`
      : `| \`${r.lane}\` | none | — | — | — | — | — | not measured |`),
    '',
    `Together, the ${measured.length} lanes measured used about ${total} runner-minutes a day.`,
    ...(measured.some((r) => r.sampled)
      ? ['', `Runs read, of those that lasted past a minute and of the rest: ${measured.filter((r) => r.sampled).map((r) => `\`${r.lane}\` ${r.longSampled} of ${r.longRuns} and ${r.sampled - r.longSampled} of ${r.runs - r.longRuns}`).join('; ')}.`]
      : []),
  ];
  return lines.join('\n');
}

/**
 * The table of a report, a row per lane, its cells as written.
 * @param {string} text a report, or a document that holds one
 */
export function readTable(text) {
  const lines = text.split('\n');
  const start = lines.indexOf(TABLE_HEADER);
  if (start < 0) return [];
  /** @type {Array<{ lane: string, caller: string, days: string, perDay: string, short: string, shortMinutes: string, otherMinutes: string, minutesPerDay: string }>} */
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const [lane = '', caller = '', days = '', perDay = '', short = '', shortMinutes = '', otherMinutes = '', minutesPerDay = ''] = line.split('|').slice(1, -1).map((c) => c.trim().replace(/^`|`$/g, ''));
    rows.push({ lane, caller, days, perDay, short, shortMinutes, otherMinutes, minutesPerDay });
  }
  return rows;
}

/** @param {string[]} argv @param {string} flag @param {number} fallback */
const intFlag = (argv, flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = argv[i + 1] ?? '';
  return /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
};

if (isCliEntry(import.meta.url)) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('actions-minutes: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const days = intFlag(argv, '--days', 7);
  const sample = intFlag(argv, '--sample', 40);
  if (!Number.isInteger(days) || !Number.isInteger(sample)) {
    console.error('actions-minutes: --days and --sample take a whole number above 0');
    process.exit(2);
  }
  const catalogue = JSON.parse(readFileSync(new URL('../docs/lanes.json', import.meta.url), 'utf8'));
  /** @param {string[]} args */
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const m = measure({ repo, gh, now: new Date().toISOString(), days, sample, lanes: Object.keys(catalogue.lanes) });
  console.log(argv.includes('--json') ? JSON.stringify(m, null, 2) : renderReport(m));
}
