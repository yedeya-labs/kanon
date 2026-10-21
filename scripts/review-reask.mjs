#!/usr/bin/env node
// kanon#1197 — the dispatch sweep re-asks the review for a labelled pull request that has none on
// its head. Run by the Lead's daily dispatch sweep, after its own reconcile, on the same App
// token; it adds no schedule and no grant of its own.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// CI's completion starts the review lane once per head. When that run is dropped (on #1156 the
// filter's membership gate failed on a transient empty read, #1160), nothing re-asks: the pull
// request keeps `review:please`, CI is green, and no review lands on its head. The reconciler's
// review recovery (`review-recovery.mjs`) re-asks only a head no review run has attempted, so a
// head whose one run FAILED is reported and never re-asked: a cap or an outage must not be fired
// into twice. This sweep is the other half. It counts no run that has finished, only the one it
// asked for, so it re-asks a head once whatever its earlier runs did, and never twice.
//
// ── WHAT IT RE-ASKS ─────────────────────────────────────────────────────────
// An open pull request that carries `review:please` and:
//   - has no Reviewer review on its current head: a review by the Reviewer's App, with the
//     Reviewer's role marker, whose `<!-- reviewed: sha=… -->` trailer names the head (a review
//     with no trailer counts by the commit GitHub filed it under, as `review-recovery.mjs` reads
//     one). Any state, a COMMENT included: the lane skips a head the Reviewer has reviewed;
//   - has no Review run queued or in progress on that head (`review-run-evidence.mjs`);
//   - whose `ci.yml` runs on that head have all completed, as the review lane's filter reads CI;
//   - whose head was pushed at least the reconciler's stall window ago, `AWAITING_REVIEW_HOURS`
//     (`K-MERGE-14`'s waiting threshold), and which the sweep has not re-asked before.
// A fork's head is never re-asked: the review lane refuses one before it reads anything.
//
// ── ONCE PER HEAD, AND THE MARKER IS THE BOUND ──────────────────────────────
// Before it re-asks, it posts one comment of the Lead's on the pull request, carrying
// `<!-- qa:review-reask sha=<head> -->`. That comment is its only state, and it also tells the
// pull request that its review was dropped, without opening the Actions tab. Only the Lead's own
// comment counts, so a marker quoted by a person holds nothing. The comment comes first: if it
// can't be posted, no label is touched, so a head is never re-asked without its bound.
//
// ── HOW IT ASKS: A LABEL CHURN, NOT A DISPATCH ──────────────────────────────
// It removes and re-adds `review:please`, which starts the review lane's `labeled` path, as the
// reconciler's recovery does (`K-AGENT-4`: the Lead holds no `actions: write`). A label the
// Lead's App applies is never an explicit request, so on a head that has a verdict it would start
// nothing; this only runs on a head with none. Both writes go through the issues endpoints, which
// the sweep's `issues: write` covers on a pull request.
//
// NON-FATAL, like the sweep that runs it: a failed read or write is a ::warning:: and exit 0.
// SAFE BY DEFAULT: without APPLY=1 (or --apply) it prints what it would re-ask.
//
// DEPENDENCY-FREE: `node:` and `gh` only, like every script under scripts/ (`K-SELF-8`).
//
// Env: GH_TOKEN (the Lead's App token in the sweep), GITHUB_REPOSITORY, APPLY.
// Usage: node "$KANON/scripts/review-reask.mjs" [--apply]

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { appLogin, appPersona } from './app-register.mjs';
import { AWAITING_REVIEW_HOURS } from './lead-reconcile.mjs';
import { readTrailer } from './review-trailer.mjs';
import { reviewRunsFor } from './review-run-evidence.mjs';
import { asRole, signed } from './lib/role-marker.mjs';
import { beforeApply } from './lib/labels.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The label it re-applies, and the one a pull request must carry to be re-asked. */
export const REASK_LABEL = 'review:please';

/** The register's logins: the Lead, whose marker comments are the bound, and the Reviewer. */
export const LEAD_LOGIN = appLogin('Lead');
export const REVIEWER_LOGIN = appLogin('Reviewer');

/** The marker naming the head the sweep re-asked. @param {string} sha */
export const reaskMarker = (sha) => `<!-- qa:review-reask sha=${sha} -->`;
const MARKER_RE = /<!--\s*qa:review-reask sha=([0-9a-f]{40})\s*-->/gi;

/**
 * @typedef {{ name?: string } | string} Label
 * @typedef {{ author?: { login?: string } | null, body?: string | null, state?: string, commit?: { oid?: string } | null }} Review
 * @typedef {{ author?: { login?: string } | null, body?: string | null }} Comment
 * @typedef {{ number: number, headRefOid: string, isCrossRepository?: boolean, labels?: Label[], reviews?: Review[], comments?: Comment[], commits?: { committedDate?: string }[] }} Pr
 * @typedef {{ id?: number, status?: string, conclusion?: string | null }} Run
 */

/** @param {Pr} pr */
const carriesLabel = (pr) => (pr.labels ?? []).some((l) => ((typeof l === 'string' ? l : l?.name) ?? '').toLowerCase() === REASK_LABEL);

/**
 * Does a Reviewer review name this pull request's current head? The trailer decides; a review
 * without one counts by the commit GitHub filed it under.
 * @param {Pr} pr
 */
export function reviewedHead(pr) {
  const head = String(pr.headRefOid ?? '').toLowerCase();
  return (pr.reviews ?? []).some((r) =>
    asRole('Reviewer', { login: r.author?.login, expected: REVIEWER_LOGIN, body: r.body })
    && String(readTrailer(r).reviewedSha ?? r.commit?.oid ?? '').toLowerCase() === head);
}

/**
 * The heads the sweep already re-asked, from the Lead's own comments.
 * @param {Comment[] | undefined} comments
 * @returns {Set<string>}
 */
export function reaskedHeads(comments) {
  const heads = new Set();
  for (const c of comments ?? []) {
    if (!asRole('Lead', { login: c.author?.login, expected: LEAD_LOGIN, body: c.body })) continue;
    for (const m of String(c.body ?? '').matchAll(MARKER_RE)) heads.add(String(m[1]).toLowerCase());
  }
  return heads;
}

/**
 * What this pass re-asks. PURE: every read that decides it is an argument.
 * @param {Pr[]} prs open pull requests, as `gh pr view --json` returns them
 * @param {{ ciSettled: (sha: string) => boolean | null, runsFor: (sha: string, since: string) => Run[] | null, now?: number, hours?: number }} io
 *   `ciSettled`: whether CI's runs on the head all completed, `null` when unreadable; `runsFor`:
 *   the head's Review runs, `null` when unreadable
 */
export function reaskPlan(prs, { ciSettled, runsFor, now = Date.now(), hours = AWAITING_REVIEW_HOURS }) {
  /** @type {{ number: number, sha: string }[]} */
  const reask = [];
  /** @type {{ number: number, sha: string, why: string }[]} */
  const held = [];
  /** @type {number[]} */
  const reviewed = [];
  for (const pr of prs) {
    if (!carriesLabel(pr)) continue;
    const sha = pr.headRefOid;
    /** @param {string} why */
    const hold = (why) => held.push({ number: pr.number, sha, why });
    if (pr.isCrossRepository) { hold('its head is in a fork, which the review lane refuses'); continue; }
    if (reviewedHead(pr)) { reviewed.push(pr.number); continue; }
    if (reaskedHeads(pr.comments).has(String(sha).toLowerCase())) {
      hold('the sweep already re-asked this head, and it asks once per head. Read its Review runs, then remove and re-add the label by hand');
      continue;
    }
    const pushedAt = pr.commits?.at(-1)?.committedDate ?? '';
    const pushed = Date.parse(pushedAt);
    if (Number.isNaN(pushed)) { hold('its push time is unreadable, so the stall window cannot be measured'); continue; }
    if (now - pushed < hours * 3600_000) { hold(`pushed less than ${hours}h ago, inside the stall window`); continue; }
    const settled = ciSettled(sha);
    if (settled === null) { hold('could not read CI\'s runs for this head'); continue; }
    if (!settled) { hold('CI has not finished on this head; its completion starts the review'); continue; }
    const runs = runsFor(sha, pushedAt);
    if (!Array.isArray(runs)) { hold('could not read the Review runs for this head'); continue; }
    const live = runs.find((r) => r.status !== 'completed');
    if (live) { hold(`Review run ${live.id ?? '?'} is ${live.status ?? 'unfinished'} on this head`); continue; }
    reask.push({ number: pr.number, sha });
  }
  return { reask, held, reviewed };
}

/**
 * The comment that bounds a re-ask and tells the pull request why.
 * @param {string} sha
 */
export function reaskComment(sha) {
  return signed([
    `No review has landed on \`${sha.slice(0, 7)}\`. CI has finished on it and no Review run is pending, so the dispatch sweep has asked the review lane again, by removing and re-adding \`${REASK_LABEL}\`.`,
    '',
    'The sweep asks once per head. If no review lands on this head, read its Review runs, then remove and re-add the label yourself.',
    '',
    reaskMarker(sha),
  ].join('\n'), 'Lead', appPersona('Lead'));
}

/**
 * The step summary. Every state renders, so an empty pass and one that never read look different.
 * @param {ReturnType<typeof reaskPlan>} plan
 * @param {{ apply: boolean, reasked?: number[], failed?: number[] }} opts
 */
export function renderSummary(plan, { apply, reasked = [], failed = [] }) {
  const lines = ['### Review re-ask (kanon#1197)', ''];
  lines.push(`${plan.reask.length} to re-ask, ${plan.held.length} held, ${plan.reviewed.length} reviewed on their head.`);
  for (const r of plan.reask) {
    const done = !apply ? 'would re-ask (dry run)' : reasked.includes(r.number) ? `re-asked: \`${REASK_LABEL}\` removed and re-added` : failed.includes(r.number) ? 'the re-ask FAILED, see the warning' : 'not attempted';
    lines.push(`- #${r.number} \`${r.sha.slice(0, 7)}\`: no review on its head, CI done, no Review run pending; ${done}`);
  }
  for (const h of plan.held) lines.push(`- #${h.number} \`${String(h.sha).slice(0, 7)}\`: not re-asked, ${h.why}`);
  return `${lines.join('\n')}\n`;
}

// ── I/O ────────────────────────────────────────────────────────────────────

/** @param {string} msg */
const warn = (msg) => console.log(`::warning title=review-reask::${msg.replace(/\r?\n/g, ' ')}`);
/** @param {unknown} e */
const firstLine = (e) => String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0];

/**
 * Whether every `ci.yml` run on the head has completed: `false` with none yet, `null` when the
 * listing can't be read. The file is the one the review lane's filter reads (`READS WORKFLOW`).
 * @param {string} sha
 * @param {{ repo: string, gh: (args: string[]) => string }} io
 */
export function ciSettled(sha, { repo, gh }) {
  try {
    const runs = /** @type {{ headSha?: string, status?: string }[]} */ (JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', 'ci.yml',
      '--commit', sha, '--limit', '50', '--json', 'headSha,status,conclusion,databaseId']))).filter((r) => r.headSha === sha);
    return runs.length > 0 && runs.every((r) => r.status === 'completed');
  } catch {
    return null;
  }
}

/**
 * Read, plan, and (with `apply`) re-ask each pull request in the plan. Never throws.
 * @param {{ repo: string, apply: boolean, gh: (args: string[]) => string, summary?: (text: string) => void, now?: number,
 *   runsFor?: (sha: string, since: string) => Run[] | null }} io
 */
export function run({ repo, apply, gh, summary = () => {}, now = Date.now(), runsFor }) {
  const json = (/** @type {string[]} */ args) => JSON.parse(gh(args));
  /** @type {Pr[]} */
  let prs;
  try {
    const listed = /** @type {{ number: number }[]} */ (json(['pr', 'list', '--repo', repo, '--state', 'open', '--label', REASK_LABEL,
      '--limit', '100', '--json', 'number,headRefOid,isCrossRepository,labels']));
    prs = [];
    for (const { number } of listed) {
      try {
        prs.push(json(['pr', 'view', String(number), '--repo', repo, '--json', 'number,headRefOid,isCrossRepository,labels,reviews,comments,commits']));
      } catch (e) {
        warn(`could not read #${number}, so it was not re-asked this pass: ${firstLine(e)}`);
      }
    }
  } catch (e) {
    warn(`could not list the open pull requests carrying ${REASK_LABEL}, so none was re-asked: ${firstLine(e)}`);
    summary('### Review re-ask (kanon#1197)\n\nThe open pull requests could not be read; nothing was re-asked.\n');
    return { plan: null, reasked: [], failed: [] };
  }
  const plan = reaskPlan(prs, {
    ciSettled: (sha) => ciSettled(sha, { repo, gh }),
    runsFor: runsFor ?? ((sha, since) => reviewRunsFor(sha, { repo, json, since })),
    now,
  });
  /** @type {number[]} */
  const reasked = [];
  /** @type {number[]} */
  const failed = [];
  if (apply) {
    for (const r of plan.reask) {
      try {
        gh(['api', '-X', 'POST', `repos/${repo}/issues/${r.number}/comments`, '-f', `body=${reaskComment(r.sha)}`]);
      } catch (e) {
        failed.push(r.number);
        warn(`#${r.number}: the re-ask's marker could not be posted, so its label was left alone: ${firstLine(e)}`);
        continue;
      }
      try {
        gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${r.number}/labels/${encodeURIComponent(REASK_LABEL)}`]);
      } catch {
        // Gone already (a person took it off between the read and now): the add below is the event.
      }
      try {
        gh(['api', '-X', 'POST', `repos/${repo}/issues/${r.number}/labels`, '-f', `labels[]=${REASK_LABEL}`]);
        reasked.push(r.number);
      } catch (e) {
        failed.push(r.number);
        warn(`#${r.number}: re-adding ${REASK_LABEL} failed, so the pull request may no longer carry it. Add it back by hand: ${firstLine(e)}`);
      }
    }
  }
  summary(renderSummary(plan, { apply, reasked, failed }));
  return { plan, reasked, failed };
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    warn('GITHUB_REPOSITORY is not set; nothing to read');
    return;
  }
  const apply = process.argv.includes('--apply') || process.env.APPLY === '1';
  const gh = (/** @type {string[]} */ args) => {
    beforeApply(args, (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const summary = (/** @type {string} */ text) => {
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  };
  run({ repo, apply, gh, summary });
}

if (isCliEntry(import.meta.url)) main();
