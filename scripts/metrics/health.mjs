// Kanon's own health (plan 0003 M8; §4, "Group 9, field by field"): the measures computed in
// Kanon, and the health view that shows them. Pure, like the rest of the metrics module: issues,
// releases and rows in, figures and Markdown out, with no network, no file reads and no clock
// but `now`. `scripts/telemetry/kanon-health.mjs` reads them from GitHub and calls this.
//
// THREE MEASURES. The rest of group 9, guard and rule firing counts, is the store's.
// 1. DISPUTED RULES (decision 15): issues filed with the "Dispute a rule" form
//    (`DISPUTE_FORM`), counted open and closed per rule id. A dispute is recognised by the
//    heading GitHub writes for the form's rule field, `### Disputed rule`, which no other form
//    has, so no label has to exist for it to count. The id is shown only when it is one of the
//    rulebook's (`RULE_IDS`): the field is free text, and anything else is counted as
//    unreadable, never printed.
// 2. TIME TO FIX KANON'S OWN BUGS: the issues #41's job files, each carrying the job's label
//    and its signature marker (both, so neither a person's label nor a pasted marker counts).
//    Created to closed, for those closed as completed; and created to the first release that
//    contains the fix, read as the first release PUBLISHED AT OR AFTER the fix merged: Kanon
//    releases from one branch, so a release cut after a fix merged holds it. The fix is what
//    closed the issue, a merged pull request or a commit; an issue closed by hand has none, and
//    is counted apart.
// 3. UPGRADE LAG: each adopter's newest `kanon_version`, the highest release on its run rows,
//    against Kanon's releases published by `now`: how many releases are newer, and how many days
//    since the first of them came out. Across adopters it is a cross-adopter figure, so it is
//    shown only as a distribution, and only at `MIN_ADOPTERS` adopters or more (plan 0002
//    decision 7, imported from the aggregate, not restated); below, it is withheld without
//    saying how many there are. Its output holds numbers only, so no key can reach it.

import { RULE_IDS } from '../../actions/agent-telemetry/schema.mjs';
import { MIN_ADOPTERS, keyOf, median, percentile } from '../../infra/telemetry/function/aggregate.mjs';
import { MARKER, compareVersions } from '../telemetry/kanon-bugs.mjs';
import { LABELS } from '../telemetry/kanon-findings.mjs';

/** The "Dispute a rule" issue form. */
export const DISPUTE_FORM = '.github/ISSUE_TEMPLATE/rule-dispute.yml';
/** The label of the form's rule field: the heading GitHub writes above its value. */
export const DISPUTE_FIELD = 'Disputed rule';

/** A release tag Kanon publishes, `v1.2.3`, and the version a row carries for it. */
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const DAY_MS = 86_400_000;

/**
 * @typedef {{ number: number, state: string, body?: string | null }} DisputeIssue
 * @typedef {{ number: number, state: string, state_reason?: string | null, labels: string[], body?: string | null,
 *   created_at: string, closed_at?: string | null, fixed_at?: string | null }} BugIssue
 *   `fixed_at`: when what closed it merged, a pull request's merge or a commit's date; null when nothing did
 * @typedef {{ tag: string, published_at: string | null, draft?: boolean, prerelease?: boolean }} Release
 * @typedef {{ version: string, published_at: string }} Published
 * @typedef {{ n: number, median_days: number, p90_days: number }} Dist
 * @typedef {{ disputes: number, unreadable: number, rules: { rule: string, open: number, closed: number }[] }} Disputes
 * @typedef {{ filed: number, open: number, fixed: number, closed_unfixed: number, unreleased: number, no_fix_link: number,
 *   to_close: Dist | null, to_release: Dist | null }} Fixes
 * @typedef {{ withheld: true, min_adopters: number } | { withheld: false, adopters: number, on_latest: number,
 *   releases_behind: { median: number, p90: number }, days_behind: { median: number, p90: number } }} Lag
 */

/** Days, to a tenth. @param {number} ms */
const days = (ms) => Math.round((ms / DAY_MS) * 10) / 10;
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEADING = new RegExp(`^###[ \\t]+${escape(DISPUTE_FIELD)}[ \\t]*\\r?\\n\\s*([^\\n]*)`, 'm');

/**
 * The rule id a dispute names: the id, when the rulebook has it; null when the issue is a
 * dispute whose field holds anything else; undefined when the issue is not a dispute.
 * @param {string | null | undefined} body
 * @returns {string | null | undefined}
 */
export function disputedRule(body) {
  const m = typeof body === 'string' ? HEADING.exec(body) : null;
  if (!m) return undefined;
  const id = (m[1] ?? '').trim().replace(/^`(.*)`$/, '$1').trim().toUpperCase();
  return RULE_IDS.includes(id) ? id : null;
}

/**
 * Open and closed disputes per rule id, most disputed first.
 * @param {DisputeIssue[]} issues
 * @returns {Disputes}
 */
export function ruleDisputes(issues) {
  /** @type {Map<string, { rule: string, open: number, closed: number }>} */
  const rules = new Map();
  let disputes = 0;
  let unreadable = 0;
  for (const issue of issues) {
    const rule = disputedRule(issue.body);
    if (rule === undefined) continue;
    disputes += 1;
    if (rule === null) { unreadable += 1; continue; }
    const r = rules.get(rule) ?? { rule, open: 0, closed: 0 };
    rules.set(rule, r);
    if (String(issue.state).toUpperCase() === 'OPEN') r.open += 1;
    else r.closed += 1;
  }
  const sorted = [...rules.values()].sort((a, b) => b.open + b.closed - (a.open + a.closed) || b.open - a.open || a.rule.localeCompare(b.rule));
  return { disputes, unreadable, rules: sorted };
}

/**
 * Kanon's releases as of `now`: published, neither draft nor prerelease, tagged `v<x.y.z>`,
 * oldest version first.
 * @param {Release[]} releases
 * @param {Date} now
 * @returns {Published[]}
 */
export function releaseList(releases, now) {
  /** @type {Published[]} */
  const out = [];
  for (const r of releases) {
    const m = RELEASE_TAG.exec(r.tag ?? '');
    const published = Date.parse(r.published_at ?? '');
    if (!m || r.draft || r.prerelease || !Number.isFinite(published) || published > now.getTime()) continue;
    out.push({ version: /** @type {string} */ (m[1]), published_at: /** @type {string} */ (r.published_at) });
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** The median and 90th percentile of durations in milliseconds, in days; null for none. @param {number[]} ms */
const dist = (ms) => {
  if (ms.length === 0) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  return { n: sorted.length, median_days: days(median(sorted)), p90_days: days(percentile(sorted, 90)) };
};

/** Whether #41's job filed the issue: its label and its signature marker. @param {BugIssue} issue */
const filedByJob = (issue) => issue.labels.includes(LABELS.bug) && typeof issue.body === 'string' && issue.body.includes(`<!-- ${MARKER}=`);

/**
 * The time to fix the bugs #41's job files.
 * @param {BugIssue[]} issues
 * @param {Release[]} releases
 * @param {{ now: Date }} opts
 * @returns {Fixes}
 */
export function timeToFix(issues, releases, { now }) {
  const published = releaseList(releases, now).map((r) => Date.parse(r.published_at)).sort((a, b) => a - b);
  const r = { filed: 0, open: 0, fixed: 0, closed_unfixed: 0, unreleased: 0, no_fix_link: 0 };
  /** @type {number[]} */
  const toClose = [];
  /** @type {number[]} */
  const toRelease = [];
  for (const issue of issues) {
    if (!filedByJob(issue)) continue;
    r.filed += 1;
    if (String(issue.state).toUpperCase() === 'OPEN') { r.open += 1; continue; }
    if (String(issue.state_reason ?? '').toUpperCase() !== 'COMPLETED') { r.closed_unfixed += 1; continue; }
    r.fixed += 1;
    const created = Date.parse(issue.created_at);
    const closed = Date.parse(issue.closed_at ?? '');
    if (Number.isFinite(created) && Number.isFinite(closed)) toClose.push(closed - created);
    const fixed = Date.parse(issue.fixed_at ?? '');
    if (!Number.isFinite(fixed)) { r.no_fix_link += 1; continue; }
    const release = published.find((t) => t >= fixed);
    if (release === undefined) { r.unreleased += 1; continue; }
    if (Number.isFinite(created)) toRelease.push(release - created);
  }
  return { ...r, to_close: dist(toClose), to_release: dist(toRelease) };
}

/**
 * Upgrade lag across adopters, from run rows: a row's adopter is `adopter`, or its stored
 * partition's key.
 * @param {Record<string, unknown>[]} rows
 * @param {Release[]} releases
 * @param {{ now: Date, tag?: string }} opts
 * @returns {Lag}
 */
export function upgradeLag(rows, releases, { now, tag = 'run' }) {
  const list = releaseList(releases, now);
  /** @type {Map<string, string>} */
  const newest = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || row.row_kind !== 'run' || row.tag !== tag) continue;
    const key = typeof row.adopter === 'string' && row.adopter !== '' ? row.adopter : keyOf(row.pk);
    if (!key) continue;
    const version = row.kanon_version;
    const recorded = Date.parse(typeof row.recorded_at === 'string' ? row.recorded_at : '');
    if (typeof version !== 'string' || !RELEASE_VERSION.test(version) || !(recorded <= now.getTime())) continue;
    const had = newest.get(key);
    if (had === undefined || compareVersions(version, had) > 0) newest.set(key, version);
  }
  if (newest.size < MIN_ADOPTERS) return { withheld: true, min_adopters: MIN_ADOPTERS };
  const behind = [];
  const late = [];
  for (const version of newest.values()) {
    const newer = list.filter((r) => compareVersions(r.version, version) > 0);
    behind.push(newer.length);
    late.push(newer.length ? now.getTime() - Math.min(...newer.map((r) => Date.parse(r.published_at))) : 0);
  }
  behind.sort((a, b) => a - b);
  late.sort((a, b) => a - b);
  return {
    withheld: false, adopters: newest.size, on_latest: behind.filter((n) => n === 0).length,
    releases_behind: { median: median(behind), p90: percentile(behind, 90) },
    days_behind: { median: days(median(late)), p90: days(percentile(late, 90)) },
  };
}

const fixed1 = (/** @type {number} */ n) => n.toFixed(1);

/**
 * The health view (plan 0003 §6.1, "Kanon's health"): Markdown, public, distributions and
 * counts only. `lag` is null when no rows were given.
 * @param {{ computed_at: string, disputes: Disputes, fixes: Fixes, lag: Lag | null }} h
 */
export function healthView({ computed_at, disputes, fixes, lag }) {
  const out = ['## Kanon\'s health', '', `Computed ${computed_at.slice(0, 10)} (plan 0003 §4, group 9).`, '', '### Disputed rules', ''];
  if (disputes.disputes === 0) out.push('No rule has been disputed.');
  else {
    out.push(`${disputes.disputes} dispute(s), filed with the "Dispute a rule" form.`, '');
    if (disputes.rules.length) out.push('| Rule | Open | Closed |', '|---|---|---|', ...disputes.rules.map((r) => `| \`${r.rule}\` | ${r.open} | ${r.closed} |`));
    if (disputes.unreadable) out.push('', `${disputes.unreadable} name no rule id the rulebook has, and are counted here only.`);
  }

  out.push('', "### Time to fix Kanon's own bugs", '');
  if (fixes.filed === 0) out.push("#41's job has filed no issue.");
  else {
    out.push(`${fixes.filed} filed by #41's job: ${fixes.open} open, ${fixes.fixed} fixed, ${fixes.closed_unfixed} closed unfixed.`);
    const rows = [['To the close', fixes.to_close], ['To the first release with the fix', fixes.to_release]]
      .filter(([, d]) => d !== null)
      .map(([label, d]) => { const x = /** @type {Dist} */ (d); return `| ${label} | ${x.n} | ${fixed1(x.median_days)} | ${fixed1(x.p90_days)} |`; });
    if (rows.length) out.push('', '| From filed | Fixed | Median days | 90th percentile days |', '|---|---|---|---|', ...rows);
    const apart = [
      fixes.unreleased ? `${fixes.unreleased} fixed but in no release yet` : '',
      fixes.no_fix_link ? `${fixes.no_fix_link} closed with no pull request or commit to time the release from` : '',
    ].filter(Boolean);
    if (apart.length) out.push('', `Not in the release times: ${apart.join('; ')}.`);
  }

  out.push('', '### Upgrade lag', '');
  if (lag === null) out.push('Not computed: no run rows were given.');
  else if (lag.withheld) out.push(`Withheld: fewer than ${lag.min_adopters} adopters send rows, and a figure across adopters needs ${lag.min_adopters} (plan 0002 decision 7).`);
  else {
    out.push(
      `${lag.adopters} adopters, ${lag.on_latest} on the latest release.`, '',
      '| | Median | 90th percentile |', '|---|---|---|',
      `| Releases behind | ${lag.releases_behind.median} | ${lag.releases_behind.p90} |`,
      `| Days behind | ${fixed1(lag.days_behind.median)} | ${fixed1(lag.days_behind.p90)} |`,
    );
  }
  return `${out.join('\n')}\n`;
}
