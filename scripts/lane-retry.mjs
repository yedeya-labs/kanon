// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — retry a PR-lane run that died of its CAUSE, once the cause has cleared (RA-2519).
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
// Every PR lane is bounded to one attempt per head, and the bound is deliberate:
// `reviseRecovery` says "a run that failed IS a run — its head is reported rather than
// re-fired, so a cap or an outage is never answered by repeating it", and the rebase
// lane writes its attempt marker before the agent runs so "a crashed or capped
// session" uses the head's only attempt. Declining to retry DURING an outage is right.
// Nothing retried AFTER it, and that was the gap: on 2026-09-26 every in-flight review
// and revise run died on the subscription's session limit between 07:28 and 07:34 UTC,
// and four PRs sat for three hours until a human re-dispatched each one by hand. PR
// RA-2446 (2026-09-25) was worse — its revise run died on `api_error`, the rebase lane's
// only attempt never reached the model, and each lane then deferred to the other.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//   · CLASSIFY FROM EVIDENCE, NOT THE CONCLUSION. Only two failures are retried: the
//     configured model was never reached (`unreachable` — a cap, an outage) and the
//     model API failed part-way through (`api_error`). A run that ran and failed, or
//     stopped at its turn or dollar cap, keeps today's report-only behaviour.
//   · WAIT OUT THE CAUSE: `RETRY_COOL_DOWN_HOURS` after the failure, long enough for a
//     session cap to reset. A fixed wait rather than "some later run reached the model",
//     which is the stronger signal but needs the RA-1485 store this tick cannot read.
//   · ONCE PER HEAD PER LANE, and the bound is the lane's own evidence, not a counter:
//     a head is retried only while its ONLY attempt is that one retryable failure. The
//     retry is itself an attempt, so a second failure of any kind leaves two and is
//     reported, never retried.
//
// ── WHERE THE CLASSIFICATION COMES FROM ─────────────────────────────────────
// The failed run says so itself. `classify-agent-result.mjs` writes `retry=<class>` to
// its step's outputs, and each lane's workflow follows it with one of two no-op steps
// whose NAMES are below and whose `if:` reads that output. A step that ran concluded
// `success`, one that did not concluded `skipped`, and the jobs API reports both under
// the token every one of these readers already holds (`Actions: read`) — no new App
// permission, no store read, no annotation parsing (annotations need `Checks: read`,
// which the lead App does not have). `workflow-retry-breadcrumbs` in the unit tier holds
// the four workflows and these names together.
//
// NODE BUILTINS ONLY: `agent-lead-reconcile.yml` and `agent-rebase.yml`'s filter job run
// with no `npm ci` (RA-1957).

import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY;

/** The step a lane's workflow runs when its classify step reported a retryable failure,
 *  per classification. The names ARE the protocol: a rename here without the workflow
 *  (or the reverse) would read every capped run as a genuine failure, silently. */
export const RETRY_STEPS = Object.freeze({
  unreachable: 'Retryable once the cause clears: the model was unreachable (#2519)',
  api_error: 'Retryable once the cause clears: the model API failed mid-run (#2519)',
});

/**
 * THE SAME TWO STEPS AS KANON'S SPINE NAMES THEM (RA-2709). The spine moved to Kanon at its
 * step 2, and Kanon writes this repo's issue references as `RA-N`, so a run of a lane on the
 * spine (implement, triage, both revise lanes, the lead) leaves `(RA-2519)` where this
 * repo's own direct lanes (review, rebase) still leave `(#2519)`. Both spellings are read,
 * per classification: a run from before the switch, or a lane not yet moved, must still be
 * retried. `RETRY_STEPS` stays the local spelling, which the direct lanes are held to.
 */
export const RETRY_STEP_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(RETRY_STEPS).map(([k, v]) => [k, Object.freeze([v, v.replace('(#2519)', '(RA-2519)')])]),
));

/** Hours after a retryable failure before its head may be retried. The subscription's
 *  session window is five hours; anything shorter risks spending the one retry inside
 *  the same cap. Anything but a positive finite number is the default. */
export const retryCoolDownHours = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 5;
};
export const RETRY_COOL_DOWN_HOURS = retryCoolDownHours(process.env.QA_RETRY_COOL_DOWN_HOURS);

/**
 * The retry classification a finished run recorded, from its jobs payload — or null
 * when it recorded none (a genuine failure, an older run from before the breadcrumbs,
 * or a job that died before its classify step: every one of those is report-only).
 *
 * PURE. `job` narrows to one job by name — the rebase lane's matrix runs every PR of a
 * `main` merge in one run, as `resolve (<pr>)`, and one PR's classification must not be
 * read as another's.
 *
 * @param {{jobs?: {name?: string, steps?: {name?: string, conclusion?: string|null, completed_at?: string|null}[]}[]}|null|undefined} payload
 * @param {{job?: (name: string) => boolean}} [opts]
 * @returns {{classification: 'unreachable'|'api_error', at: string|null}|null}
 */
export function retryEvidenceIn(payload, { job = () => true } = {}) {
  const byName = new Map(Object.entries(RETRY_STEP_NAMES).flatMap(([k, names]) => names.map((v) => [v, k])));
  for (const j of payload?.jobs ?? []) {
    if (!job(String(j?.name ?? ''))) continue;
    for (const s of j?.steps ?? []) {
      const classification = byName.get(String(s?.name ?? ''));
      // `success` only: `skipped` is the step saying "not this class", and anything
      // else (a cancelled job mid-step) proves nothing.
      if (classification && s.conclusion === 'success') {
        return { classification: /** @type {'unreachable'|'api_error'} */ (classification), at: s.completed_at ?? null };
      }
    }
  }
  return null;
}

/**
 * Reads `retryEvidenceIn` for one run. `undefined` when the jobs cannot be read — which
 * every caller treats as "do not retry": an unreadable fact must never manufacture one.
 */
export function makeRetryEvidenceReader({ json = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), repo = REPO } = {}) {
  return (runId, opts = {}) => {
    if (!/^\d+$/.test(String(runId ?? ''))) return undefined;
    try {
      return retryEvidenceIn(json(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]), opts);
    } catch {
      return undefined;
    }
  };
}

/** The default for every pure decision function: nothing is retryable. Production
 *  passes `makeRetryEvidenceReader()`, so the unit tier never shells out to `gh`. */
/** @type {(runId?: any, opts?: any) => ({classification: string, at: string|null}|null|undefined)} */
export const NO_RETRY_EVIDENCE = () => null;

/** A run's id, whichever listing it came from (`gh run list` says `databaseId`, the REST
 *  runs endpoint `review-run-evidence.mjs` reads says `id`). */
export const runIdOf = (run) => run?.databaseId ?? run?.id ?? null;

/**
 * Should this head be retried? Given the ATTEMPTS a lane already counts for it (the
 * lane's own evidence, whose filtering is the lane's business), answers
 * `{retry: {runId, classification, at}}` or `{why}` — or null when the question does
 * not arise (no attempt, or several: the caller's existing wording already covers
 * those, and a second failure is reported by it, never retried here).
 *
 * @param {any[]} attempts
 * @param {{evidenceOf: (runId: any) => ({classification: string, at: string|null}|null|undefined), now?: number, hours?: number}} io
 */
export function retryDecision(attempts, { evidenceOf, now = Date.now(), hours = RETRY_COOL_DOWN_HOURS }) {
  const list = attempts ?? [];
  if (list.length !== 1) return null;
  const [only] = list;
  if (only?.conclusion !== 'failure') return null;
  const runId = runIdOf(only);
  const ev = evidenceOf(runId);
  // UNREADABLE IS NOT RETRYABLE: `undefined` (the jobs could not be read) and `null`
  // (no breadcrumb) both leave the caller's report-only note, which is the pre-RA-2519
  // behaviour. An unreadable fact must never manufacture a re-fire.
  if (ev == null) return null;
  const at = Date.parse(ev.at ?? '');
  if (!Number.isFinite(at)) {
    return { why: `run ${runId} died retryably (${ev.classification}) but its failure time is unreadable, so the cool-down cannot be measured — not retried (RA-2519)` };
  }
  const due = at + hours * 3600_000;
  if (now < due) {
    return {
      why: `run ${runId} died retryably (${ev.classification}) — the cause gets ${hours}h to clear, so this head is retried once after ${new Date(due).toISOString().slice(0, 16)}Z (RA-2519)`,
    };
  }
  return { retry: { runId, classification: ev.classification, at: ev.at } };
}

/** One line naming a retry and its evidence, for every lane's report. */
export const describeRetry = (r) =>
  `a retry of run ${r.runId}, which died retryably (\`${r.classification}\`) at ${String(r.at ?? '?').slice(0, 16)} — once per head (RA-2519)`;
