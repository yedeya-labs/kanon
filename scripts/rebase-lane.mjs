// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — which conflicting PRs the Implementer should resolve (RA-2150).
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
// This module decides WHICH PRs the agent is handed. It does not resolve anything:
// the resolution is a judgement, and the two previous attempts at making it mechanical
// both failed for reasons worth keeping.
//
//   1. A LABEL CHURN cannot even reach these PRs. `agent:rebase` was the route every
//      other re-delivery here takes — and GitHub dispatches no `pull_request` event for
//      a conflicting PR, which is the whole finding of RA-1722. Measured on PR RA-1708: 25
//      label events, zero runs. So this lane reads its own world on a schedule.
//      (`pull_request_target` DOES fire on one — review's label trigger since RA-2299 —
//      but that would run the base's copy against a head it cannot merge; RA-2302.)
//
//   2. A SCRIPTED MERGE cannot succeed. RA-2164's first draft gated a `git merge` on the
//      conflicted paths being "textual rather than semantic". But `git merge` has
//      ALREADY auto-resolved everything resolvable, so what `git merge-tree` reports as
//      conflicted is by definition what needs judgement — measured against real git in
//      that review: `merge-tree` and `git merge` exit 1 on the same file. "Textual, not
//      semantic" is close to the opposite of "a script can fix it".
//
// So the remedy is agentic, and the path list inverts with it: the files a script had
// to REFUSE (a migration journal, the id registry, the generated locked set) are ones
// an agent resolves correctly by renumbering, allocating or regenerating. They moved
// out of this file and into the prompt, as instructions.
//
// ── THE ESCALATION BOUNDARY ─────────────────────────────────────────────────
// A merge conflict is a code question, so it is the agent's. The exception is a
// conflict that encodes competing PRODUCT intent — two changes to the same rule that
// cannot both hold — where no amount of code reading settles which is wanted. That one
// reaches the developer, and it is the only thing here that does.
//
// Usage: node scripts/rebase-lane.mjs [--pr N] [--json]

import { execFileSync } from 'node:child_process';
import { CONFLICT_JSON, conflictState } from './conflict-state.mjs';
import { NO_RETRY_EVIDENCE, RETRY_COOL_DOWN_HOURS, describeRetry, makeRetryEvidenceReader, retryDecision } from './lane-retry.mjs';
import { appLogin, appPersona } from './app-register.mjs';
import { asRole, implementerStatusOn, signed } from './lib/role-marker.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

const REPO = process.env.GITHUB_REPOSITORY;

/** The App this lane runs as — the only one that authors code (`agent-identities.md`
 *  footnote 1, whose `Implementer` row this reads, RA-2701), and the author of every branch it may touch. Asserted against the
 *  minted `app-slug` in the workflow: a renamed App would make the author check below
 *  match nothing, which is what keeps this lane off human branches. */
export const IMPLEMENTER_LOGIN = appLogin('Implementer');

/** One identity, three spellings across three endpoints (RA-1007). */
export const normaliseLogin = (login) =>
  String(login ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '');

/** A PR is this pipeline's to resolve only if this pipeline is driving it. The same set
 *  `agent-review.yml` reads — the repo's existing definition of "in the pipeline". */
export const PIPELINE_LABELS = ['agent:implement', 'agent:triage', 'review:please'];

/** A human owns this PR now. This lane READS it, and the agent may WRITE it when a
 *  conflict turns out to encode a product decision — which makes the lane a third
 *  writer of a label `docs/agentic-lead-engineer.md` records as having two. */
export const HELD_LABEL = 'needs:human';

/**
 * How many PRs one run may hand to the agent.
 *
 * A cap rather than the whole set, because each one is a full agent session with a
 * database and a browser behind it, and because a `main` merge that conflicts with
 * five PRs at once is exactly when a bad resolution would be copied five times before
 * anyone read the first. The remainder is REPORTED, not dropped, and the next `main`
 * merge picks it up.
 */
export const MAX_PER_RUN = Number(process.env.REBASE_LANE_MAX || 3);

/**
 * ONE attempt per head SHA, and the WORKFLOW writes the marker before the agent runs.
 *
 * KEYED ON THE HEAD, not on the base: `main` moves hourly and a per-base key would
 * re-hand the same unchanged PR to the agent all day. Written BEFORE the attempt
 * rather than after it, because a crashed or capped agent writes nothing — and a
 * marker that only a SUCCESSFUL run leaves would retry a crash forever on the same
 * commit. That is RA-1408's "a run that FAILED is a run", expressed as a comment because
 * this lane's runs are `workflow_run`-triggered and therefore carry `main`'s SHA
 * rather than the PR's (RA-1717), so run evidence cannot see them. The one exception is
 * `runMarker` below (RA-2519): an attempt that died of its cause is re-handed once.
 */
export const marker = (sha) => `<!-- rebase-lane:attempt:${String(sha).slice(0, 12)} -->`;

/**
 * WHICH RUN MADE THE ATTEMPT (RA-2519), a second marker beside the first. The attempt
 * marker alone cannot say how the attempt ended, and a head whose only attempt never
 * reached the model (PR RA-2446: 550 ms, empty `modelUsage`) is retried once after a
 * cool-down — which needs that run's jobs. A separate marker rather than a widened one,
 * so every comment written before this still matches `marker()` and still counts.
 */
export const runMarker = (sha, runId) => `<!-- rebase-lane:run:${String(sha).slice(0, 12)}:${runId} -->`;

/** How many attempts this head has had, and the run id each recorded (null for one
 *  written before `runMarker` existed — counted, never retried). */
export function attemptsIn(bodies, sha) {
  const out = [];
  const key = String(sha).slice(0, 12);
  const runRe = new RegExp(`<!-- rebase-lane:run:${key}:(\\d+) -->`);
  for (const body of bodies ?? []) {
    if (!String(body).includes(marker(sha))) continue;
    out.push({ runId: runRe.exec(String(body))?.[1] ?? null });
  }
  return out;
}

/** What the lane says on the PR before handing it over, so a human reading the PR in
 *  that window sees an actor rather than silence. Signed as the Implementer, whose App
 *  posts it (plan 0005 §3.3). */
export const attemptComment = (sha, runId = '') => signed([
  '🔧 **Resolving this conflict.**',
  '',
  'This PR conflicts with `main`, so GitHub dispatches no `pull_request` events for it —'
  + ' no CI, no CI-driven review and no revise can reach it (RA-1722). The Implementer is'
  + ' merging `main` in and resolving.',
  '',
  'If the conflict turns out to encode a product decision rather than a code one, he will'
  + ` say so here and apply \`${HELD_LABEL}\` rather than guess.`,
  '',
  marker(sha),
  ...(/^\d+$/.test(String(runId)) ? [runMarker(sha, runId)] : []),
].join('\n'), 'Implementer', appPersona('Implementer'));

/**
 * Why this PR is not one the lane may hand over, or null if it is.
 *
 * ORDERED MOST-SPECIFIC FIRST, so the reported reason is the actionable one: a draft
 * that also carries `needs:human` should read as held, not as a draft.
 */
export function ineligible(pr, { implementer = IMPLEMENTER_LOGIN } = {}) {
  const labels = (pr.labels ?? []).map((l) => l.name ?? l);
  if (pr.state !== 'OPEN') return 'not open';
  if (labels.includes(HELD_LABEL)) {
    return `carries \`${HELD_LABEL}\` — a human owns this PR, and moving its head would mint a fresh duplicate of the Merger's escalation comment, whose marker is keyed on the head SHA`;
  }
  // The Implementer's login and, from L4, its role marker in the PR body (plan 0005 §3.3).
  if (!asRole('Implementer', { login: normaliseLogin(pr.author?.login), expected: implementer, body: pr.body })) {
    return `authored by \`${normaliseLogin(pr.author?.login) || 'unknown'}\`, not this pipeline — a human's branch is theirs to resolve`;
  }
  // THE CHAIN (plan 0005 §3.3, question 6). Every Author lane's agent can write the
  // Implementer's marker and label, so the lane moves a head only when it carries the
  // implementer status the Author App set; otherwise resolving the conflict would launder a
  // forged pull request into one the Implementer's status job then stamps.
  const stamped = implementerStatusOn(pr.headStatuses, implementer);
  if (!stamped.ok) {
    return `its head is not provably the Implementer's: ${stamped.why} — a pull request outside the chain is a person's to resolve (plan 0005 §3.3)`;
  }
  if (pr.isDraft) return 'a draft — nothing downstream is waiting on it';
  if (!labels.some((l) => PIPELINE_LABELS.includes(l))) {
    return `carries none of ${PIPELINE_LABELS.map((l) => `\`${l}\``).join(', ')}, so no lane is waiting on it`;
  }
  return null;
}

/**
 * What this run should hand to the agent.
 *
 * PURE, so every refusal is testable without git or GitHub. The failure that matters
 * here is "handed over a PR it should not have" — an agent with `contents: write`
 * pushing to a branch — and every input that decides it is an argument.
 *
 * @param {any[]} prs open PRs, hydrated with `PR_FIELDS`
 * @param {{hasMarker?: (pr: any) => boolean, attemptsOf?: (pr: any) => ({runId: string|null}[]|null), evidenceOf?: (runId: any, pr: any) => any, now?: number, retryHours?: number, max?: number}} [io]
 */
export function rebaseDecision(prs, {
  hasMarker = () => false,
  // The RA-2519 retry. `attemptsOf(pr)` lists the head's attempts from its markers (null
  // when unreadable), and `evidenceOf(runId, pr)` reads how that run ended. The defaults
  // retry nothing, so the unit tier never shells out; `main()` passes the real readers.
  attemptsOf = () => null,
  evidenceOf = NO_RETRY_EVIDENCE,
  now = Date.now(),
  retryHours = RETRY_COOL_DOWN_HOURS,
  max = MAX_PER_RUN,
} = {}) {
  const resolve = [];
  const noted = [];
  for (const pr of prs ?? []) {
    if (conflictState(pr) !== 'conflicting') continue;
    const no = ineligible(pr);
    if (no) {
      noted.push({ number: pr.number, sha: pr.headRefOid, reason: 'ineligible', why: no });
      continue;
    }
    if (hasMarker(pr)) {
      // THE ONE EXCEPTION (RA-2519): the head's only attempt recorded its run, and that
      // run died of its cause — the model unreachable, or its API failing mid-run — at
      // least `retryHours` ago. The retry writes a second attempt marker before its
      // agent runs, so whatever it concludes, this head is never retried again.
      // `retryDecision` counts attempts; a run id is what its evidence is read by.
      const attempts = attemptsOf(pr);
      const retry = Array.isArray(attempts)
        ? retryDecision(attempts.map((a) => ({ databaseId: a.runId, conclusion: a.runId ? 'failure' : null })),
          { evidenceOf: (runId) => evidenceOf(runId, pr), now, hours: retryHours })
        : null;
      if (retry?.retry) {
        resolve.push({ number: pr.number, sha: pr.headRefOid, branch: pr.headRefName, retry: retry.retry });
        continue;
      }
      if (retry?.why) {
        noted.push({ number: pr.number, sha: pr.headRefOid, reason: 'cooling', why: retry.why });
        continue;
      }
      noted.push({
        number: pr.number,
        sha: pr.headRefOid,
        reason: 'attempted',
        why: 'this head has already been handed to the agent once — re-handing it would repeat a resolution that did not stick, or re-enter a crash. It waits for a push',
      });
      continue;
    }
    resolve.push({ number: pr.number, sha: pr.headRefOid, branch: pr.headRefName });
  }
  // THE REMAINDER IS REPORTED, NEVER DROPPED. A silent truncation is the one thing
  // that would make this lane's own summary untrustworthy.
  const over = resolve.slice(max);
  for (const o of over) {
    noted.push({
      number: o.number,
      sha: o.sha,
      reason: 'deferred',
      why: `over this run's cap of ${max} — the next \`main\` merge picks it up, and no marker was written, so nothing is lost`,
    });
  }
  return { resolve: resolve.slice(0, max), noted };
}

/** The `gh pr list` fields the decision needs. One place, so a read that forgets one is
 *  one edit — and `conflictState` throws rather than answering "clear" if it does. */
export const PR_FIELDS = `number,author,body,state,isDraft,labels,headRefOid,headRefName,${CONFLICT_JSON}`;

// ── IO ──────────────────────────────────────────────────────────────────────

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ghJson = (args) => JSON.parse(gh(args));

/**
 * Is this job, by the name the jobs API gives it, one of the lane's jobs for PR `n`?
 *
 * ANY SEGMENT. The lane's own file names its matrix job `resolve (<n>)`. Called from an
 * adopter's caller, as a Kanon lane is (plan 0001 step 5), the API prefixes the caller's job:
 * `<caller job> / resolve (<n>)`. And since kanon#279 that matrix job is a call to
 * `rebase-run.yml`, so the jobs that ran are named BELOW it too: `… / resolve (<n>) / mint`
 * and `… / resolve (<n>) / resolve / resolve`, the second holding the breadcrumbs. So a name
 * is this PR's when one of its ` / ` segments is `resolve (<n>)`. Reading only the last would
 * find no breadcrumb in any Kanon run, so a head whose attempt died of its cause would never
 * be retried, silently. The mint job matches too and carries no breadcrumb, which is harmless:
 * every matching job is read.
 *
 * @param {string} name
 * @param {number|string} n
 */
export function isResolveJob(name, n) {
  return name.split(' / ').includes(`resolve (${n})`);
}

/** Render for a human. Says what it examined, not only what it found. */
export function report({ resolve, noted }) {
  const lines = ['## Rebase lane — conflicting pipeline PRs\n'];
  if (!resolve.length && !noted.length) {
    lines.push('**No open PR conflicts with its base.** That is a finding, not an absence — every open PR was examined.\n');
    return lines.join('\n');
  }
  for (const r of resolve) lines.push(`- PR #${r.number} \`${String(r.sha).slice(0, 7)}\` — handing to the Implementer to resolve${r.retry ? `, ${describeRetry(r.retry)}` : ''}`);
  for (const n of noted) lines.push(`- PR #${n.number} \`${String(n.sha).slice(0, 7)}\`: ${n.why}`);
  return lines.join('\n');
}

function main() {
  if (!REPO) {
    console.error('rebase-lane: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const only = process.argv.includes('--pr') ? process.argv[process.argv.indexOf('--pr') + 1] : null;
  const all = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100', '--json', PR_FIELDS]);
  const prs = only ? all.filter((p) => String(p.number) === String(only)) : all;
  // The head's commit statuses, for the chain in `ineligible`, read only for a conflicting PR
  // (the only kind it is asked about). `null` on a failed read, which refuses.
  for (const pr of prs) {
    if (conflictState(pr) !== 'conflicting') continue;
    try {
      pr.headStatuses = ghJson(['api', `repos/${REPO}/commits/${pr.headRefOid}/statuses?per_page=100`]);
    } catch {
      pr.headStatuses = null;
    }
  }

  // ONE comment read per PR, shared by both questions below.
  const bodiesOf = new Map();
  const bodies = (pr) => {
    if (!bodiesOf.has(pr.number)) {
      try {
        bodiesOf.set(pr.number, ghJson(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'comments',
          '--jq', '[.comments[].body]']));
      } catch {
        bodiesOf.set(pr.number, null);
      }
    }
    return bodiesOf.get(pr.number);
  };
  // Unreadable comments means "may already have attempted": suppress, never repeat.
  // An agent handed the same head twice is the expensive direction.
  const hasMarker = (pr) => {
    const b = bodies(pr);
    return b === null || b.some((body) => String(body).includes(marker(pr.headRefOid)));
  };
  const readRetry = makeRetryEvidenceReader({ json: ghJson, repo: REPO });
  const decision = rebaseDecision(prs, {
    hasMarker,
    attemptsOf: (pr) => { const b = bodies(pr); return b === null ? null : attemptsIn(b, pr.headRefOid); },
    // The matrix job for THIS PR only: one run resolves every PR a `main` merge
    // conflicted, and another PR's capped job must not license this one's retry.
    evidenceOf: (runId, pr) => readRetry(runId, { job: (name) => isResolveJob(name, pr.number) }),
  });
  const text = report(decision);
  console.error(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    execFileSync('bash', ['-c', 'cat >> "$GITHUB_STEP_SUMMARY"'], { input: text });
  }
  // STDOUT IS THE MACHINE-READABLE HALF, stderr the human one — the workflow reads this
  // into a matrix, so a stray log line on stdout would break the job rather than the
  // report. `--json` is the default and the flag exists only to say so at a call site.
  console.log(JSON.stringify(decision.resolve.map((r) => r.number)));
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) main();
