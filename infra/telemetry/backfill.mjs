#!/usr/bin/env node
// The work-item backfill (plan 0003 §7, M5; plan 0002 §7, S7a), run once per repository by the Owner.
//
//   node infra/telemetry/backfill.mjs --repo <owner/name> --since <YYYY-MM-DD> [--caller <file>]                  # dry run
//   node infra/telemetry/backfill.mjs --repo <owner/name> --since <YYYY-MM-DD> [--caller <file>] --key <key> --apply [--profile kanon]
//
// It derives the repository's work-item rows from GitHub with THE COLLECTOR'S OWN STEP
// (`workItemStep`, scripts/telemetry-work-items.mjs), over one span from --since to now, read
// with the Owner's `gh` token. So a backfilled row is the row the collector would have written.
// `--caller` names the repository's collector caller under .github/workflows (default
// `telemetry.yml`); each item's `kanon_version` is that caller's pin at its merge, and absent
// where the caller didn't exist yet.
//
// The dry run prints M5's check and nothing from a row: per month, the pull requests closed
// (release PRs left out, as the metrics leave them out) beside the rows derived, and the month
// marked when the two differ. An earlier item (closed before the span) whose story a PR in the
// span changed is rewritten too, as the collector rewrites it; its row is counted apart, as
// `earlier`, not in a month. Both sides stop at the run's start, `now`: a PR closed while the
// step runs is left out of the listing, and its row, if the step read it, is counted apart as
// `during`. It exits non-zero when the step failed or a month differs. The
// counts of PRs closed come from GitHub's own listing, not from the step, so the check is
// independent of the derivation it checks.
//
// `--apply` sends the rows through the ingest function as the backfill role, 25 to a direct
// invocation of its `backfill` alias, naming the adopter's key; the stack must be deployed with
// `EnableBackfill=true` (plan 0008 §9, J9), and the function stores work-item rows only from it. A re-sent row overwrites itself (its key is
// the PR number), so a re-run, or a span that overlaps the collector's, is harmless. The
// repository and the key are arguments and are never printed.

import { parseArgs } from 'node:util';
import { declarations } from '../../cli/metrics.mjs';
import { isReleasePr } from '../../scripts/metrics/release.mjs';
import { ghAsync, workItemStep } from '../../scripts/telemetry-work-items.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { send, sendFailure } from './import.mjs';
import { aws } from './verify.mjs';

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CALLER = /^[A-Za-z0-9._-]+\.ya?ml$/;

/** The month of an ISO time, `YYYY-MM`, in UTC. @param {string} iso */
export const monthOf = (iso) => new Date(iso).toISOString().slice(0, 7);

/**
 * GitHub's closed pull requests in a listing's shape (`GET /repos/{repo}/pulls`) as the release
 * test reads them.
 * @param {any} p
 * @returns {import('../../scripts/metrics/types.mjs').PullRequest}
 */
const asPr = (p) => /** @type {any} */ ({
  number: p.number,
  title: p.title,
  labels: (p.labels ?? []).map((/** @type {any} */ l) => l.name),
  author: p.user ? { login: p.user.login, type: p.user.type } : null,
});

/**
 * M5's check: per month, the PRs closed in the span (release PRs left out) beside the rows.
 * @param {any[]} listed GitHub's closed pull requests, as listed
 * @param {Array<{ closed_at: string }>} rows the derived work-item rows
 * @param {{ since: number, until: number, register: Map<string, string> }} opts
 * @returns {{ months: Array<{ month: string, closed: number, rows: number }>, earlier: number, during: number }}
 */
export function monthCounts(listed, rows, { since, until, register }) {
  /** @type {Map<string, { month: string, closed: number, rows: number }>} */
  const by = new Map();
  const at = (/** @type {string} */ month) => by.get(month) ?? by.set(month, { month, closed: 0, rows: 0 }).get(month);
  for (const p of listed) {
    if (typeof p?.closed_at !== 'string' || Date.parse(p.closed_at) < since || Date.parse(p.closed_at) >= until) continue;
    if (isReleasePr(asPr(p), register)) continue;
    /** @type {{ closed: number }} */ (at(monthOf(p.closed_at))).closed += 1;
  }
  let earlier = 0;
  let during = 0;
  for (const r of rows) {
    if (Date.parse(r.closed_at) < since) earlier += 1;
    else if (Date.parse(r.closed_at) >= until) during += 1;
    else /** @type {{ rows: number }} */ (at(monthOf(r.closed_at))).rows += 1;
  }
  return { months: [...by.values()].sort((a, b) => a.month.localeCompare(b.month)), earlier, during };
}

/**
 * The dry run's lines: counts only, never a row, a repository or a key.
 * @param {ReturnType<typeof monthCounts>} counts
 * @param {{ failures: string[], warnings: string[] }} step
 */
export function report({ months, earlier, during }, step) {
  const lines = ['month    PRs closed  rows'];
  for (const m of months) lines.push(`${m.month}  ${String(m.closed).padStart(10)}  ${String(m.rows).padStart(4)}${m.closed === m.rows ? '' : '  differs'}`);
  const total = months.reduce((t, m) => ({ closed: t.closed + m.closed, rows: t.rows + m.rows }), { closed: 0, rows: 0 });
  lines.push(`total    ${String(total.closed).padStart(10)}  ${String(total.rows).padStart(4)}`);
  lines.push(`earlier items rewritten: ${earlier}`);
  lines.push(`closed while the step ran: ${during}`);
  lines.push(`${step.warnings.length} warning(s), ${step.failures.length} failure(s)`);
  // A warning or failure names a PR number and why, never a row's values.
  for (const w of step.warnings) lines.push(`warning: ${w}`);
  for (const f of step.failures) lines.push(`failure: ${f}`);
  return lines;
}

/** Whether the dry run passed M5's check. @param {ReturnType<typeof monthCounts>} counts @param {{ failures: string[] }} step */
export const passed = ({ months }, step) => step.failures.length === 0 && months.every((m) => m.closed === m.rows);

/** @param {import('../../scripts/telemetry-work-items.mjs').Gh} gh @param {string} path */
async function listAll(gh, path) {
  const r = await gh(['api', '--paginate', '--slurp', path]);
  if (r.status !== 0) throw new Error(`GitHub answered: ${(r.stderr.trim() || `gh exited ${r.status}`).split('\n')[0]}`);
  const doc = JSON.parse(r.stdout || '[]');
  return Array.isArray(doc) ? doc.flat() : [];
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, since: { type: 'string' }, caller: { type: 'string', default: 'telemetry.yml' },
    key: { type: 'string' }, apply: { type: 'boolean', default: false }, profile: { type: 'string', default: 'kanon' },
  } });
  const repo = values.repo ?? '';
  const sinceText = values.since ?? '';
  if (!REPOSITORY.test(repo) || !DATE.test(sinceText) || !CALLER.test(values.caller) || (values.apply && !values.key)) {
    console.error('usage: backfill.mjs --repo <owner/name> --since <YYYY-MM-DD> [--caller <file>] [--key <key> --apply] [--profile kanon]');
    process.exit(2);
  }
  const since = Date.parse(`${sinceText}T00:00:00Z`);
  const now = Date.now();
  const step = await workItemStep({ repo, since, now, gh: ghAsync, log: (line) => console.error(line), callerFile: values.caller });
  /** @type {Map<string, string>} */
  let register = new Map();
  try {
    register = (await declarations(/** @type {any} */ ({ gh: ghAsync, err: () => {}, readFile: () => null }), repo, null)).decl.register;
  } catch (e) {
    // The step read the same declarations and has recorded the failure; the report says so.
    step.failures.push(`the declarations could not be read for the check (${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]})`);
  }
  // Closed pull requests, newest update first: one listing, every page, cut to the span.
  const listed = await listAll(ghAsync, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
  const rows = step.rows.map((r) => r.row);
  const counts = monthCounts(listed, /** @type {any} */ (rows), { since, until: now, register });
  for (const line of report(counts, step)) console.log(line);
  if (!values.apply) process.exit(passed(counts, step) ? 0 : 1);
  if (step.failures.length) {
    console.error('not sent: the step failed, so its rows are not the whole span');
    process.exit(1);
  }
  let sent;
  try {
    sent = await send(rows, /** @type {string} */ (values.key), { aws, profile: values.profile, role: 'backfill' });
  } catch (e) {
    console.log(sendFailure(e, /** @type {string} */ (values.key)));
    process.exit(1);
  }
  const { stored, refused } = sent;
  console.log(`stored ${stored}; refused ${Object.entries(refused).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  process.exit(stored === rows.length ? 0 : 1);
}
