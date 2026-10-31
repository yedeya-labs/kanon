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
//   - has no Reviewer verdict on its current head: a review by the Reviewer's App, with the
//     Reviewer's role marker, whose `<!-- reviewed: sha=… -->` trailer names the head (a review
//     with no trailer counts by the commit GitHub filed it under, as `review-recovery.mjs` reads
//     one). APPROVED or CHANGES_REQUESTED only, a COMMENT excluded: the lane's filter reads
//     `already reviewed` from those two states alone, so it reviews a head carrying only a
//     COMMENT, and the sweep re-asks one (kanon#1528);
//   - has no Review run queued or in progress on that head (`review-run-evidence.mjs`);
//   - whose `ci.yml` runs on that head have all completed, as the review lane's filter reads CI;
//   - whose head was pushed at least the reconciler's stall window ago, `AWAITING_REVIEW_HOURS`
//     (`K-MERGE-14`'s waiting threshold), and which the sweep has not re-asked before;
//   - whose head the review lane does not decline BY DESIGN (kanon#1213), below;
//   - whose project is not held (kanon#1431), below.
// A fork's head is never re-asked: the review lane refuses one before it reads anything.
//
// ── A HEAD THE LANE DECLINES ON PURPOSE IS NOT A DROPPED REVIEW (kanon#1213) ──
// The lane's filter decides `review=false`, and posts nothing, on a labelled, CI-complete head
// in two arms: the head commit carries `[skip-review]`, or on a code PR the Reviewer already
// reviewed, only docs changed since that verdict. Such a run concludes `success`, so every
// check above passes. Re-asking it posts a comment saying a review was dropped, and churns a
// label whose run the filter declines again by the same arm (the Lead's label is not an
// explicit request), and the Overseer would count the head as a finding.
//
// THE FILTER'S OWN DECISION, NOT A COPY OF ITS RULES. The filter is inline shell in
// `agent-review.yml`, not a module this script can import, and a second copy of its arms (the
// marker's position, the docs and guarded-docs sets, the last verdict's stamped commit, the
// judging inputs) would drift from the first. So the sweep reads what the filter decided: its
// `decide` prints `→ review=<bool> (<reason>) pr=[<n>] head=[<sha>]`, and the newest finished
// Review run on the head whose `filter` job printed a decision for that head settles it. Only
// the two arms in `DECLINED_BY_DESIGN` hold the head; their reasons are pinned to the filter's
// `decide` lines by the tests. Every other outcome is still re-asked:
//   - the filter failed or never decided (#1156: its membership gate failed): no decision line;
//   - the filter deferred to CI, and CI's completion event was lost: a different reason;
//   - the log can't be read: unreadable is not a decline, so the head is re-asked as before.
//
// ── A HELD PROJECT TAKES NO ACTIONS (`K-AGENT-32`, kanon#1431) ───────────────────
// A pull request that closes a member of a project whose tracking issue carries `needs:human`
// is not re-asked: a human stopped that project, and a re-ask starts a paid Reviewer run. The
// reconciler's review recovery declines the same pull requests (kanon#1411), and this reuses its
// reader, `projectHoldReader` in `review-recovery.mjs`, rather than reading the project marker a
// second time. Every unknown answers "held": a tracking issue, a closing issue, or the list of
// closing issues that can't be read holds the pull request. It is asked last, only of a pull
// request about to be re-asked, so a pull request that is waiting anyway costs no read.
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
import { projectHoldReader } from './review-recovery.mjs';
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
 * @typedef {{ id?: number, status?: string, conclusion?: string | null, createdAt?: string }} Run
 * @typedef {{ run?: number, review: boolean, reason: string }} Decision
 */

/**
 * The review lane's filter arms that decline a head by design (kanon#1213): the reason each
 * prints, as `agent-review.yml`'s `decide` spells it, and what the sweep says instead.
 */
export const DECLINED_BY_DESIGN = [
  {
    arm: 'skip-marker',
    reason: /^the head commit carries the skip marker, on its subject line or alone on a line of its own$/,
    why: 'its head commit carries `[skip-review]`',
  },
  {
    arm: 'docs-only',
    reason: /^only docs changed since [0-9a-f]{7}, on a code PR$/,
    why: "only docs changed since the Reviewer's last verdict, on a code PR",
  },
];

/** The line the filter's `decide` prints, which the job log carries behind a timestamp. */
const DECISION_RE = /→ review=(true|false) \((.*)\) pr=\[\d*\] head=\[([0-9a-f]*)\]/;

/**
 * The filter's decision for `sha` in one `filter` job's log, or `null` when it printed none.
 * @param {string} log
 * @param {string} sha
 * @returns {Decision | null}
 */
export function filterDecision(log, sha) {
  const head = String(sha).toLowerCase();
  /** @type {Decision | null} */
  let found = null;
  for (const line of String(log ?? '').split(/\r?\n/)) {
    const m = DECISION_RE.exec(line);
    if (m && String(m[3]).toLowerCase() === head) found = { review: m[1] === 'true', reason: String(m[2]) };
  }
  return found;
}

/**
 * The by-design arm a decision declined by, or `null`.
 * @param {Decision | null | undefined} decision
 */
export function declinedByDesign(decision) {
  if (!decision || decision.review) return null;
  return DECLINED_BY_DESIGN.find((d) => d.reason.test(decision.reason)) ?? null;
}

/** @param {Pr} pr */
const carriesLabel = (pr) => (pr.labels ?? []).some((l) => ((typeof l === 'string' ? l : l?.name) ?? '').toLowerCase() === REASK_LABEL);

/**
 * Does a Reviewer verdict name this pull request's current head? The trailer decides; a review
 * without one counts by the commit GitHub filed it under. Only APPROVED and CHANGES_REQUESTED
 * count, the two states the lane's filter reads `already reviewed` from (kanon#1528), as
 * `verdictOnHead` in `review-recovery.mjs` reads them: a head carrying only a COMMENT is one
 * the lane would review.
 * @param {Pr} pr
 */
export function reviewedHead(pr) {
  const head = String(pr.headRefOid ?? '').toLowerCase();
  return (pr.reviews ?? []).some((r) =>
    asRole('Reviewer', { login: r.author?.login, expected: REVIEWER_LOGIN, body: r.body })
    && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
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
 * @param {{ ciSettled: (sha: string) => boolean | null, runsFor: (sha: string, since: string) => Run[] | null,
 *   decisionFor?: (sha: string, runs: Run[]) => Decision | null, heldBy?: (pr: Pr) => string | null,
 *   now?: number, hours?: number }} io
 *   `ciSettled`: whether CI's runs on the head all completed, `null` when unreadable; `runsFor`:
 *   the head's Review runs, `null` when unreadable; `decisionFor`: the filter's latest decision
 *   on the head, from those runs, `null` when none was found or read; `heldBy`: why the pull
 *   request's project is held, `null` when it is not (kanon#1431), asked last
 */
export function reaskPlan(prs, { ciSettled, runsFor, decisionFor = () => null, heldBy = () => null, now = Date.now(), hours = AWAITING_REVIEW_HOURS }) {
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
    const decision = decisionFor(sha, runs);
    const declined = declinedByDesign(decision);
    if (declined) {
      hold(`the review lane declines this head by design: ${declined.why} (Review run ${decision?.run ?? '?'}'s filter). It is not a dropped review; to have it reviewed anyway, remove and re-add the label by hand`);
      continue;
    }
    // A HELD PROJECT TAKES NO ACTIONS (`K-AGENT-32`, kanon#1431): asked last, so only a pull
    // request about to be re-asked costs the read.
    const heldWhy = heldBy(pr);
    if (heldWhy) { hold(heldWhy); continue; }
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

/** How many of a head's finished Review runs the sweep reads, newest first, for a decision. */
export const DECISION_RUNS_READ = 10;

/**
 * The filter's latest decision on `sha`: the newest finished Review run whose `filter` job
 * printed one for that head (kanon#1213). `null` when none did, or a read failed: an unreadable
 * log is not a decline, so the head is re-asked as before.
 * @param {string} sha
 * @param {Run[]} runs
 * @param {{ repo: string, gh: (args: string[]) => string }} io
 * @returns {Decision | null}
 */
export function filterDecisionFor(sha, runs, { repo, gh }) {
  const finished = runs
    .filter((r) => r.status === 'completed' && r.conclusion !== 'skipped' && r.id != null)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || Number(b.id) - Number(a.id))
    .slice(0, DECISION_RUNS_READ);
  try {
    for (const r of finished) {
      const jobs = /** @type {{ jobs?: { id?: number, name?: string }[] }} */ (JSON.parse(gh(['api', `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`]))).jobs ?? [];
      // A called lane's job is named `<caller's job> / filter`; the lane run directly, `filter`.
      const filter = jobs.find((j) => j.name === 'filter' || String(j.name ?? '').endsWith(' / filter'));
      if (filter?.id == null) continue;
      const decision = filterDecision(gh(['api', `repos/${repo}/actions/jobs/${filter.id}/logs`]), sha);
      if (decision) return { ...decision, run: r.id };
    }
  } catch (e) {
    warn(`could not read the review filter's decision on ${sha.slice(0, 7)}, so it is re-asked as a dropped review: ${firstLine(e)}`);
  }
  return null;
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
    decisionFor: (sha, runs) => filterDecisionFor(sha, runs, { repo, gh }),
    heldBy: projectHoldReader({ json, repo }),
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
