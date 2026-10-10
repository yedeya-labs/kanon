#!/usr/bin/env node
// Kanon's health (plan 0003 M8): reads Kanon's own repository from GitHub and prints the health
// view of `scripts/metrics/health.mjs`, which computes every figure. Reads only: one release list
// and two issue searches, through `gh`.
//
//   node scripts/telemetry/kanon-health.mjs [--repo <owner>/<repo>] [--rows <file>] [--json]
//   --repo: Kanon's repository (default yedeya-labs/kanon)
//   --rows: run rows, a JSON array or one row per line, as `kanon-bugs.mjs` reads them; without
//     it, upgrade lag is not computed. The rows are the Owner's: they never leave this process,
//     and the lag is printed only as a distribution of at least three adopters
//   --json: one document, `SCHEMA`, instead of the Markdown view
//
// WHAT IT READS. The releases; the issues whose body holds the "Dispute a rule" form's heading;
// and the issues labelled as #41's job labels them, each with what closed it, a pull request's
// merge or a commit, which times the fix. Every issue here is a public issue of Kanon's own.
//
// Exit codes: 0 printed; 2 usage, or a rows file that can't be read; 3 a GitHub read failed.
//
// `node:` built-ins only, like every script under scripts/ (`K-SELF-8`).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { DISPUTE_FIELD, healthView, ruleDisputes, timeToFix, upgradeLag } from '../metrics/health.mjs';
import { isCliEntry } from '../lib/cli-entry.mjs';
import { parseRows } from './kanon-bugs.mjs';
import { LABELS } from './kanon-findings.mjs';

/** The JSON output's contract. A breaking change to it changes this. */
export const SCHEMA = 'kanon-health/v1';
/** Kanon's own repository, whose disputes, bugs and releases these are. */
export const KANON_REPO = 'yedeya-labs/kanon';

const USAGE = 'usage: kanon-health.mjs [--repo <owner>/<repo>] [--rows <file>] [--json]';
const PAGE = 'pageInfo { hasNextPage endCursor }';

/** The disputes: each issue's state and body, which holds the form's fields. */
export const disputesQuery = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) { ${PAGE}
    nodes { ... on Issue { number state body } } } }`;

/** #41's issues, each with the last close and what closed it. */
export const bugsQuery = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) { ${PAGE}
    nodes { ... on Issue { number state stateReason createdAt closedAt body labels(first: 50) { nodes { name } }
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent {
        closer { __typename ... on PullRequest { mergedAt } ... on Commit { committedDate } } } } } } } } }`;

/** @typedef {(args: string[]) => { status: number | null, stdout: string, stderr: string }} Gh */

/** A GitHub read that failed; its message names the read, never what it returned. */
class ReadError extends Error {}

/** @type {Gh} */
const realGh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
};

/**
 * Every node of a search, page by page.
 * @param {Gh} gh @param {string} query @param {string} q @param {string} what
 * @returns {any[]}
 */
function search(gh, query, q, what) {
  const nodes = [];
  /** @type {string | null} */
  let after = null;
  do {
    const r = gh(['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`, ...(after ? ['-f', `after=${after}`] : [])]);
    if (r.status !== 0) throw new ReadError(`could not search ${what}`);
    let page;
    try {
      page = JSON.parse(r.stdout)?.data?.search;
    } catch {
      page = undefined;
    }
    if (!page || !Array.isArray(page.nodes)) throw new ReadError(`could not read the search for ${what}`);
    nodes.push(...page.nodes.filter(Boolean));
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

/**
 * Reads the three inputs from `repo`.
 * @param {Gh} gh @param {string} repo
 */
export function read(gh, repo) {
  const r = gh(['release', 'list', '-R', repo, '--limit', '1000', '--json', 'tagName,publishedAt,isDraft,isPrerelease']);
  if (r.status !== 0) throw new ReadError('could not list the releases');
  let list;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) throw new ReadError('could not read the release list');
  const releases = list.map((x) => ({ tag: x.tagName, published_at: x.publishedAt ?? null, draft: !!x.isDraft, prerelease: !!x.isPrerelease }));
  const disputes = search(gh, disputesQuery, `repo:${repo} is:issue in:body "${DISPUTE_FIELD}"`, 'the disputes')
    .map((n) => ({ number: n.number, state: n.state, body: n.body ?? null }));
  const bugs = search(gh, bugsQuery, `repo:${repo} is:issue label:${LABELS.bug}`, "#41's issues").map((n) => {
    const closer = n.timelineItems?.nodes?.[0]?.closer;
    const fixedAt = closer?.__typename === 'PullRequest' ? closer.mergedAt : closer?.__typename === 'Commit' ? closer.committedDate : null;
    return {
      number: n.number, state: n.state, state_reason: n.stateReason ?? null, body: n.body ?? null,
      labels: (n.labels?.nodes ?? []).map((/** @type {{ name: string }} */ l) => l.name),
      created_at: n.createdAt, closed_at: n.closedAt ?? null, fixed_at: fixedAt ?? null,
    };
  });
  return { releases, disputes, bugs };
}

/**
 * The CLI, as a function the tests call.
 * @param {string[]} argv
 * @param {{ gh?: Gh, now?: () => Date }} [deps]
 * @returns {{ code: number, out: string }}
 */
export function main(argv, { gh = realGh, now = () => new Date() } = {}) {
  let repo = KANON_REPO;
  /** @type {string | null} */
  let rowsFile = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if ((a === '--repo' || a === '--rows') && argv[i + 1] !== undefined) {
      const v = /** @type {string} */ (argv[i + 1]);
      if (a === '--repo') repo = v;
      else rowsFile = v;
      i += 1;
      continue;
    }
    return { code: 2, out: USAGE };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { code: 2, out: USAGE };
  let rows = null;
  if (rowsFile !== null) {
    try {
      rows = parseRows(readFileSync(rowsFile, 'utf8'));
    } catch (e) {
      // The error's name only: a message could quote a row, and a row holds what must not be printed.
      return { code: 2, out: `could not read the rows (${e instanceof Error ? e.name : 'error'})` };
    }
  }
  const at = now();
  let input;
  try {
    input = read(gh, repo);
  } catch (e) {
    return { code: 3, out: e instanceof ReadError ? e.message : 'could not read GitHub' };
  }
  const health = {
    computed_at: at.toISOString(),
    disputes: ruleDisputes(input.disputes),
    fixes: timeToFix(input.bugs, input.releases, { now: at }),
    lag: rows === null ? null : upgradeLag(rows, input.releases, { now: at }),
  };
  if (json) {
    const { lag, ...rest } = health;
    return { code: 0, out: JSON.stringify({ schema: SCHEMA, ...rest, upgrade_lag: lag }, null, 2) };
  }
  return { code: 0, out: healthView(health) };
}

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  const { code, out } = main(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out.endsWith('\n') ? out : `${out}\n`}`);
  process.exit(code);
}
/* c8 ignore stop */
