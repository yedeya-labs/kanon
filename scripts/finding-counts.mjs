#!/usr/bin/env node
// How often the Reviewer's findings cite each rule, counted from its reviews (`K-SELF-14`).
//
// WHY. A gate is switched on to make a class of finding stop recurring, and a finding's class is
// the rule id it cites. So the count of findings per rule id, before a gate is switched on and
// in the weeks after, is what shows whether the gate moved anything. A baseline nobody can
// re-measure can't be compared later (`K-PRIN-14`), so the count is this script, not a figure
// someone wrote down.
//
// WHAT IT COUNTS, read-only, through `gh api`, over a window of days, [--since, --until):
//   findings     the Reviewer's request-changes reviews submitted in the window that cite the
//                rule id in a finding, each review counted once per id it cites;
//   pull requests the distinct pull requests those reviews are on;
//   follow-ups   the Reviewer's follow-up issues (labelled `follow-up` and `agent:reviewer`)
//                created in the window whose body cites the id, each counted once per id.
//
// A REVIEW IS THE REVIEWER'S when a bot authored it and its first role marker is the
// Reviewer's (`scripts/lib/role-marker.mjs`), or when a `--reviewer <login>` names its author:
// a review written before the role marker existed carries none, so a history that predates it
// names the Reviewer's old login.
//
// WHAT IN A REVIEW IS A FINDING. A review cites rules for what holds as well as for what is
// wrong, and an incremental review restates the findings of the round before. So the ids are
// read from the review's body outside two kinds of section, told apart by their markdown
// heading (`#` to `####`, matched case-insensitively):
//   - a section that reports what holds ("What I checked", "Verified", "Checked, no finding",
//     "What holds", "Sound", "CI"), which cites the rules it checked, not a finding;
//   - a section that restates or files ("Prior findings", "Filed", "Follow-ups"): a prior
//     finding is counted in the review that first raised it, and a filed one as a follow-up.
// Everything else counts, the text before the first heading included, where the verdict and an
// "Owner decision needed" line sit. The headings are the Reviewer's own words, so this is a
// convention the count reads, not one it enforces: a review that reports what holds under a
// heading the list doesn't know adds the rules it checked to the findings, which a week-on-week
// comparison absorbs as long as the Reviewer writes the same way.
//
// Usage: GITHUB_REPOSITORY=owner/repo node scripts/finding-counts.mjs [--since YYYY-MM-DD]
//   [--until YYYY-MM-DD] [--rules K-A-1,K-B-2] [--reviewer <login>]... [--json]
// The window defaults to the seven days before today (UTC). `--rules` limits the table to those
// ids and lists each of them, a zero included. `--json` prints the counts and each week's.
// Exit 0 with the counts, 1 when `gh` fails, 2 on a usage error. Node built-ins only.

import { execFileSync } from 'node:child_process';
import { isCliEntry } from './lib/cli-entry.mjs';
import { markedRole } from './lib/role-marker.mjs';

const DAY = 86_400_000;
const PAGE = 100;
const RULE_ID = /\bK-[A-Z]+-\d+\b/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A heading that reports what holds, or restates or files, so the ids under it are no finding. */
export const NOT_A_FINDING = /\b(prior|previous|earlier|checked|verified|verify|holds?|sound|fine|no findings?|not findings?|no action|ci|checks|rollup|filed|follow-ups?)\b/i;

/**
 * @typedef {{ user?: { login?: string, type?: string } | null, state?: string, submitted_at?: string | null, body?: string | null }} Review
 * @typedef {{ number: number, updated_at: string }} Pull
 * @typedef {{ number: number, created_at: string, body?: string | null, pull_request?: unknown, labels?: Array<{ name?: string } | string> }} Issue
 * @typedef {{ findings: number, pullRequests: number, followUps: number }} Counts
 * @typedef {{ rule: string } & Counts} Row
 * @typedef {{ repo: string, since: string, until: string, reviews: number, followUpIssues: number,
 *   rows: Row[], weeks: Array<{ week: string, rows: Row[] }> }} Report
 */

/**
 * The rule ids a body cites, each once, in order of first citation.
 * @param {string} text
 * @returns {string[]}
 */
export const citedRules = (text) => [...new Set(String(text ?? '').match(RULE_ID) ?? [])];

/**
 * The rule ids a request-changes review cites in its findings: its body outside the sections
 * whose heading marks them as what holds, or as restated or filed (the header above).
 * @param {string} body
 * @returns {string[]}
 */
export const findingRules = (body) => {
  /** @type {string[]} */
  const kept = [];
  let skipping = false;
  /** The level of the heading that started the skipped section; a heading at or above it ends it. */
  let level = 0;
  for (const line of String(body ?? '').split('\n')) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const depth = h[1]?.length ?? 0;
      if (skipping && depth > level) continue;
      skipping = NOT_A_FINDING.test(h[2] ?? '');
      level = depth;
      if (skipping) continue;
    } else if (skipping) continue;
    kept.push(line);
  }
  return citedRules(kept.join('\n'));
};

/**
 * Whether a review is the Reviewer's (the header above).
 * @param {Review} review
 * @param {string[]} logins
 */
export const isReviewers = (review, logins) => {
  const login = review.user?.login ?? '';
  if (logins.includes(login)) return true;
  return review.user?.type === 'Bot' && markedRole(review.body) === 'Reviewer';
};

/** The Monday, UTC, of the week `iso` falls in, as YYYY-MM-DD. @param {string} iso */
export const weekOf = (iso) => {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
};

/**
 * The counts, rule by rule, from the reviews and follow-ups already read.
 * @param {{ reviews: Array<{ pr: number, review: Review }>, followUps: Issue[], rules?: string[] | null }} input
 * @returns {Row[]} by findings, then follow-ups, then id; with `rules`, exactly those ids in that order
 */
export const tally = ({ reviews, followUps, rules = null }) => {
  /** @type {Map<string, { findings: number, prs: Set<number>, followUps: number }>} */
  const by = new Map();
  const at = (/** @type {string} */ id) => {
    let c = by.get(id);
    if (!c) by.set(id, (c = { findings: 0, prs: new Set(), followUps: 0 }));
    return c;
  };
  for (const { pr, review } of reviews) {
    for (const id of findingRules(review.body ?? '')) {
      const c = at(id);
      c.findings += 1;
      c.prs.add(pr);
    }
  }
  for (const issue of followUps) for (const id of citedRules(issue.body ?? '')) at(id).followUps += 1;
  const row = (/** @type {string} */ id) => {
    const c = by.get(id);
    return { rule: id, findings: c?.findings ?? 0, pullRequests: c?.prs.size ?? 0, followUps: c?.followUps ?? 0 };
  };
  if (rules) return rules.map(row);
  return [...by.keys()].map(row).sort((a, b) => b.findings - a.findings || b.followUps - a.followUps || a.rule.localeCompare(b.rule));
};

/** @param {Issue} issue */
const labelNames = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? ''));

/**
 * Read the window's reviews and follow-ups through `gh`, and count them.
 * @param {{ repo: string, since: string, until: string, gh: (args: string[]) => unknown, logins?: string[], rules?: string[] | null }} opts
 *   `since` and `until` are YYYY-MM-DD, UTC; the window is [since, until).
 * @returns {Report}
 */
export const count = ({ repo, since, until, gh, logins = [], rules = null }) => {
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T00:00:00Z`);
  const inWindow = (/** @type {string | null | undefined} */ t) => {
    const ms = Date.parse(t ?? '');
    return ms >= from && ms < to;
  };

  // A review submitted in the window updated its pull request then, so the pull requests updated
  // since the window opened, newest first, hold every one of them.
  /** @type {number[]} */
  const prs = [];
  for (let page = 1; ; page++) {
    const list = /** @type {Pull[]} */ (gh(['api', `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`]));
    for (const p of list) if (Date.parse(p.updated_at) >= from) prs.push(p.number);
    if (list.length < PAGE || Date.parse(list[list.length - 1]?.updated_at ?? '') < from) break;
  }

  /** @type {Array<{ pr: number, review: Review }>} */
  const reviews = [];
  for (const pr of prs) {
    for (let page = 1; ; page++) {
      const list = /** @type {Review[]} */ (gh(['api', `repos/${repo}/pulls/${pr}/reviews?per_page=${PAGE}&page=${page}`]));
      for (const review of list) {
        if (review.state === 'CHANGES_REQUESTED' && inWindow(review.submitted_at) && isReviewers(review, logins)) reviews.push({ pr, review });
      }
      if (list.length < PAGE) break;
    }
  }

  // `since` on the issues listing is by update, and an issue created in the window was updated
  // in it, so the listing holds every follow-up created there; the creation date picks them.
  /** @type {Issue[]} */
  const followUps = [];
  for (let page = 1; ; page++) {
    const list = /** @type {Issue[]} */ (gh(['api', `repos/${repo}/issues?labels=follow-up,agent:reviewer&state=all&since=${since}T00:00:00Z&per_page=${PAGE}&page=${page}`]));
    for (const issue of list) {
      const names = labelNames(issue);
      if (!issue.pull_request && names.includes('follow-up') && names.includes('agent:reviewer') && inWindow(issue.created_at)) followUps.push(issue);
    }
    if (list.length < PAGE) break;
  }

  const weeks = [...new Set([...reviews.map((r) => weekOf(r.review.submitted_at ?? '')), ...followUps.map((i) => weekOf(i.created_at))])].sort();
  return {
    repo,
    since,
    until,
    reviews: reviews.length,
    followUpIssues: followUps.length,
    rows: tally({ reviews, followUps, rules }),
    weeks: weeks.map((week) => ({
      week,
      rows: tally({
        reviews: reviews.filter((r) => weekOf(r.review.submitted_at ?? '') === week),
        followUps: followUps.filter((i) => weekOf(i.created_at) === week),
        rules,
      }),
    })),
  };
};

/** The report as a markdown table, for a person or an audit issue. @param {Report} r */
export const renderTable = (r) => {
  const lines = [
    `Findings per rule id on ${r.repo}, ${r.since} to ${r.until} (exclusive): ${r.reviews} request-changes review(s) by the Reviewer, ${r.followUpIssues} follow-up(s).`,
    '',
    '| Rule | Findings | Pull requests | Follow-ups |',
    '|---|---:|---:|---:|',
    ...r.rows.map((x) => `| \`${x.rule}\` | ${x.findings} | ${x.pullRequests} | ${x.followUps} |`),
  ];
  if (r.rows.length === 0) lines.push('| (none) | 0 | 0 | 0 |');
  return lines.join('\n');
};

/**
 * Parse the arguments.
 * @param {string[]} argv
 * @param {string} today YYYY-MM-DD
 * @returns {{ since: string, until: string, rules: string[] | null, logins: string[], json: boolean } | { error: string }}
 */
export const parseArgs = (argv, today) => {
  let until = today;
  /** @type {string | null} */
  let since = null;
  /** @type {string[] | null} */
  let rules = null;
  /** @type {string[]} */
  const logins = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--json') json = true;
    else if (a === '--since' || a === '--until') {
      if (!v || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return { error: `${a} takes a date, YYYY-MM-DD` };
      if (a === '--since') since = v;
      else until = v;
      i++;
    } else if (a === '--rules') {
      const ids = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0 || ids.some((id) => !/^K-[A-Z]+-\d+$/.test(id))) return { error: '--rules takes rule ids, comma-separated, such as K-PRIN-4,K-MERGE-13' };
      rules = ids;
      i++;
    } else if (a === '--reviewer') {
      if (!v || v.startsWith('--')) return { error: '--reviewer takes a login' };
      logins.push(v);
      i++;
    } else return { error: `unknown argument ${a}` };
  }
  since ??= new Date(Date.parse(`${until}T00:00:00Z`) - 7 * DAY).toISOString().slice(0, 10);
  if (since >= until) return { error: `--since (${since}) must be before --until (${until})` };
  return { since, until, rules, logins, json };
};

if (isCliEntry(import.meta.url)) {
  const repo = process.env.GITHUB_REPOSITORY;
  const args = parseArgs(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  if (!repo || 'error' in args) {
    console.error(`finding-counts: ${!repo ? 'GITHUB_REPOSITORY must be set' : 'error' in args ? args.error : ''}`);
    process.exit(2);
  }
  /** @param {string[]} a */
  const gh = (a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  try {
    const r = count({ repo, gh, since: args.since, until: args.until, logins: args.logins, rules: args.rules });
    console.log(args.json ? JSON.stringify(r, null, 2) : renderTable(r));
  } catch (e) {
    console.error(`finding-counts: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}
