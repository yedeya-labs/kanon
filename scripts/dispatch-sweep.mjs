#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-912 — reconcile stalled dispatches. RA-1336 — in BOTH lanes, not just one.
//
// LANES: `agent:implement` (agent-implement.yml) and `qa:needs-triage`
// (agent-triage.yml). See the LANES table below for why the second one exists and
// what twelve days of not having it cost (RA-903, RA-904).
//
// WHY THIS EXISTS. Both workflows fire on `issues: [labeled]`. That event
// is the ONLY thing that starts the Implementer, and an event-driven system cannot recover
// from an event that never arrived. Three failures are invisible today:
//
//   1. the run never happened          — label applied, agent never spoke
//   2. the agent asked a question      — a human answered, nobody re-dispatched
//   3. the agent finished              — but nobody closed the issue (RA-730 sat like
//                                        this for 16 days, still counted in the
//                                        backlog it was filed to reduce)
//
// All three look identical from the outside: an open issue carrying the trigger
// label. Audited 2026-08-23: 17 such issues, 6 of them never run.
//
// THE FIX IS NOT A BETTER TRIGGER, it is a reconciler that re-derives state on a
// timer instead of depending on the event. See docs/agentic-lead-engineer.md §5.5.
//
// STATE IS DERIVED, NOT STORED. There is no ledger to corrupt and no resume logic:
// every run reconstructs the world from GitHub. Its own past actions are recovered
// by counting the MARKER comments it left, which is why the marker is load-bearing
// and must not change.
//
// SAFE BY DEFAULT: a bare run is a dry run that prints what it WOULD do, matching
// agent-maintenance.yml. Pass --apply (or APPLY=1) to act.
//
// NON-FATAL by design (see the observability note in the PR): exits 0 even when
// items need a human, emitting ::warning:: lines and a step summary. A daily red
// run for a backlog that is a queue, not an incident, is alarm fatigue.
//
// Env: GH_TOKEN/GITHUB_TOKEN (gh; must be an APP token — see the workflow),
//      GITHUB_REPOSITORY, APPLY, and the tunables below.
// Usage: node scripts/dispatch-sweep.mjs [--apply]

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { exhaustedRoute, projectOf } from './split-lineage.mjs';
import { appLogin } from './app-register.mjs';
import { queryCostRows } from '../infra/qa-store/aws/cost-rows.mjs';

const REPO = process.env.GITHUB_REPOSITORY;
const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';

const LABEL = 'agent:implement';
const STOP_LABEL = 'qa:needs-info';
const TRIAGE_LABEL = 'qa:needs-triage';
// `gh issue view --json comments` returns author.login WITHOUT the `[bot]` suffix,
// while `gh api .../reviews` returns it WITH. Normalise so the code is correct
// whichever shape it is handed — reading the suffix off a comment silently
// classified every agent comment as absent, which read as "the agent never ran".
export const norm = (login) => (login || '').replace(/\[bot\]$/, '');
// The implementer being watched, and the sweep's OWN identity — deliberately
// different Apps. When they were the same, `MARKER` was the only thing separating
// "the agent spoke" from "the sweep spoke", so losing the marker on one comment
// stranded the issue in a human queue permanently. With distinct logins the
// distinction is structural and the marker only has to be right for counting.
// EXPORTED so `agent-implement.yml` can assert its minted App slug against it the way
// the sweep's own workflow already does for SWEEP_LOGIN (RA-918). This is the login the
// classifier actually hinges on — `never-ran` and `answered` are both decided by
// whether a comment's author equals it — and a wrong value fails toward ACTION:
// `isBot` treats an unrecognised login as human, which is the re-dispatch path.
export const AGENT_LOGIN = appLogin('Implementer');
// This is the App's SLUG, which is what GitHub derives the comment-author login
// from — so the App must be NAMED to give that slug ("Example Lead" gives `example-lead`). Both logins are read from the
// App register's `App slug` column (docs/qa/agent-identities.md, RA-2701), which since
// then holds slugs rather than the suggested names it once listed (the table said
// `example-triage-fix`; the bot comments as `example-implementer`), and which
// fails loudly on a missing or malformed row. A mismatch here is silent and expensive —
// `isSweep` collapses back to the marker, and because isBot() treats an unknown
// login as human, a markerless sweep comment would read as a human reply and reach
// the re-dispatch path. See RA-918.
export const SWEEP_LOGIN = appLogin('Lead');

// There is no reliable is-a-bot flag on this payload, so the bots are named. An
// UNKNOWN login is therefore treated as human, which errs toward re-dispatching
// (bounded by MAX_REDISPATCH) rather than toward stalling forever — the failure
// this script exists to end.
//
// The project's own Apps come from the register (RA-2701), by ROLE — exactly the six
// this set has always named. The Merger and the Intake App are deliberately not added
// by this move: it changes where the logins are written, not which ones count.
// `github-actions` and `dependabot` are GitHub's own, the same in every repository.
const BOT_LOGINS = new Set([
  ...['Implementer', 'Lead', 'Reviewer', 'Explorer', 'Overseer', 'Releaser'].map((role) => appLogin(role)),
  'github-actions',
  'dependabot',
]);

// The marker is how the sweep recognises its own past comments. Changing it resets
// every issue's re-dispatch count to zero, which is exactly the runaway this bounds.
export const MARKER = '<!-- qa:dispatch-sweep -->';

// ---------------------------------------------------------------------------
// LANES (RA-1336)
//
// WHY A SECOND LANE. This sweep was built for `agent:implement` and fixed that
// class completely. `qa:needs-triage` has the IDENTICAL shape — `agent-triage.yml`
// fires on `issues: [labeled]` gated to that one label, so the event is again the
// only thing that starts the agent, and again nothing recovers from an event that
// never arrived — and it was simply never covered.
//
// The cost was measured, not predicted. A workflow hang on 2026-08-19 orphaned RA-903
// (sev:medium) and RA-904 (sev:low). Everything else from that morning was absorbed by
// this sweep because it happened to carry `agent:implement`; those two carried
// `qa:needs-triage` and sat for TWELVE DAYS with zero comments, indistinguishable
// from triage running right now. The pipeline merged 136 PRs in the week they aged.
//
// SAME AGENT, SAME CONTRACT. Both lanes are the Implementer (`QA_TRIAGE_APP_ID` and
// `QA_IMPLEMENT`'s App are the same installation) and both prompts say "ALWAYS leave
// a comment before you finish" — which is the whole basis for reading silence as
// `never-ran`. So the classifier is reused verbatim rather than re-derived; only the
// labels and the prose differ.
//
// TWO EXIT SHAPES, AND THE LANE MUST TELL THEM APART — "answered leaves, waiting stays".
//
//   * SCOPE-FIRST BAIL — agent-triage.yml deliberately KEEPS `qa:needs-triage` when a
//     bug needs human design. That is a real hand-off, it belongs in the lane, and it
//     must not be re-dispatched. It already is not: the issue carries an Implementer
//     comment, so it classifies `awaiting-human`/`in-flight` rather than `never-ran`.
//     The existing classifier draws that line with no lane-specific help.
//
//   * TERMINAL VERDICT (RA-1380) — `qa:cannot-reproduce` / `qa:false-positive` mean the
//     triage question is ANSWERED. Those must LEAVE the lane, and the comment history
//     cannot say so: a false-positive bug and an untriaged one can look identical. So
//     the lane declares them in `terminal` and `classify` reads the issue's labels.
//     Left unhandled, a settled issue accrues a daily `awaiting-human` warning nobody
//     can clear and sits one human reply away from re-firing an 80-minute job.
/**
 * @typedef {object} Lane
 * @property {string} key       short name, used in the report and the comment tag
 * @property {string} label     the trigger label this lane reconciles
 * @property {string} agent     the login whose silence means "the run never happened"
 * @property {string} telemetryAgent the `agent` its L1 store rows are written under
 *   (`COST#<telemetryAgent>`) — NOT `agent` above, which is the App login. Two
 *   identifiers for one actor, and querying the wrong one finds an empty partition
 *   and fails closed, which looks exactly like "no capped runs" forever (RA-1517).
 * @property {string} stopLabel where an exhausted issue goes
 * @property {string} workflow  the workflow the label starts, named in prose
 * @property {boolean} legacy   true for the lane whose comments predate lane tags
 * @property {string[]} [terminal] labels meaning this lane's question is answered, so
 *   the issue leaves it regardless of its conversation (RA-1380)
 * @property {string} [settled] the state an issue carrying a `terminal` label reports
 * @property {boolean} [decomposes] an `exhausted` run in this lane means the ISSUE is too
 *   big, and it is stopped and routed to a split rather than re-dispatched (RA-1781)
 * @property {string} neverRan  prose for a re-dispatch of a never-ran issue
 * @property {string} answered  prose for a re-dispatch of an answered issue
 */
/** @type {Lane[]} */
export const LANES = [
  {
    key: 'implement',
    label: LABEL,
    agent: AGENT_LOGIN,
    // The `agent` the TELEMETRY row is written under — `COST#<telemetryAgent>` in the
    // L1 store — which is not `agent` above. That one is the App LOGIN this lane's
    // comments come from; this is the name `agent-implement.yml` passes to the
    // telemetry action. Two different identifiers for the same actor, and conflating
    // them would query a partition that does not exist and silently find nothing.
    telemetryAgent: 'implementer',
    stopLabel: STOP_LABEL,
    workflow: 'agent-implement.yml',
    // LEGACY, and this flag is load-bearing rather than cosmetic. Every sweep comment
    // written before RA-1336 carries MARKER and no lane tag. Counting this lane's
    // attempts as "tagged `implement`" would read all of that history as zero and
    // re-dispatch issues that had already exhausted their attempts — the runaway
    // MAX_REDISPATCH exists to bound. So this lane counts an UNTAGGED marker comment
    // as its own, which is exactly what it was.
    legacy: true,
    // TOO BIG IS A FACT ABOUT THE ISSUE (RA-1781). An implementer run that hit its turn or
    // budget cap will hit it again, so this lane stops such an issue instead of spending
    // `MAX_REDISPATCH` attempts learning that. Not the triage lane: a triage run that
    // exhausts is not an item in any brief, and there is nothing to split.
    decomposes: true,
    // PARKED BY A HUMAN LEAVES THE LANE (kanon#170). A Maintainer who parks an issue by
    // hand ("built by hand, do not re-dispatch") adds `qa:needs-info` and may KEEP
    // `agent:implement`. The Lead's eligible filter already excludes that issue; the sweep
    // did not, because it only ever met `qa:needs-info` as its own stop label, and
    // `stop()` removes the trigger label in the same breath. So the human-parked
    // combination read `answered` and was re-dispatched. For an issue the sweep stopped
    // itself this is a no-op: the trigger label is already gone.
    terminal: [STOP_LABEL],
    settled: 'parked',
    neverRan:
      'This issue has carried the trigger label with no output from the implementer. ' +
      'Per `agent-implement.yml` the agent always comments before finishing, so silence ' +
      'means the run never happened.',
    answered:
      'The last word on this issue came from a human, and nothing re-fired the ' +
      'implementer. Re-dispatching so the answer is acted on.',
  },
  {
    key: 'triage',
    label: TRIAGE_LABEL,
    agent: AGENT_LOGIN,
    telemetryAgent: 'triage-fix',
    stopLabel: STOP_LABEL,
    workflow: 'agent-triage.yml',
    legacy: false,
    // Verdicts that mean TRIAGE IS ANSWERED, so the issue leaves this lane (RA-1380).
    // Deliberately NOT `qa:reproduced` (triage found a real bug and is proceeding to a
    // fix — still in flight) and NOT the scope-first bail (which keeps the trigger
    // label on purpose and is a genuine hand-off this lane should surface).
    terminal: ['qa:cannot-reproduce', 'qa:false-positive'],
    settled: 'triage-settled',
    neverRan:
      'This bug has carried `qa:needs-triage` with no output from the triage agent. ' +
      'Per `agent-triage.yml` the agent always comments before finishing, so silence ' +
      'means the run never happened — the shape that orphaned RA-903 and RA-904 for twelve ' +
      'days after the 2026-08-19 hang.',
    answered:
      'The last word on this bug came from a human, and nothing re-fired triage. ' +
      'Re-dispatching so the answer is acted on.',
  },
];

/** The per-lane tag carried by every sweep comment alongside MARKER. */
export const laneTag = (lane) => `<!-- qa:lane:${lane.key} -->`;
/** Matches ANY lane tag — used to tell a legacy (untagged) comment from another
 *  lane's. Kept as one source of truth so a third lane cannot silently inherit
 *  the legacy lane's history. */
export const ANY_LANE_TAG = /<!-- qa:lane:[a-z-]+ -->/;

/** Has this lane's question already been answered by a terminal verdict? (RA-1380)
 *
 *  Reads the issue's own labels, because this is the one fact the conversation cannot
 *  carry: a `qa:false-positive` bug and an untriaged one can have identical comment
 *  histories. The implement lane's one terminal label is `qa:needs-info`, a human's park
 *  (kanon#170); a lane with no `terminal` list is unaffected. */
export const terminalVerdict = (issue, lane) => {
  const names = (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
  return (lane?.terminal ?? []).some((t) => names.includes(t));
};

/** Is this comment one THIS lane wrote? A sweep comment always carries MARKER; a
 *  tagged one belongs to the lane it names, and an untagged one belongs to the
 *  legacy lane (see `legacy` above). */
export const isLaneComment = (body, lane) =>
  body.includes(MARKER) &&
  (body.includes(laneTag(lane)) || (lane.legacy && !ANY_LANE_TAG.test(body)));

/** Should this run withhold every `stop()`? Pure, and exported, because the decision
 *  is the thing worth testing and `main` cannot be reached without `gh` — the same
 *  "the tests covered the pure half and nothing covered the derivation" trap RA-1061
 *  records one script over.
 *
 *  @returns {{tripped: boolean, reason: string}} */
export function breakerTripped(verdicts, maxStops = MAX_STOPS_PER_RUN) {
  // `too-big` stops COUNT toward the volume arm (RA-1781). Each is evidence about its own
  // issue — the model ran to its cap — but many in one run are better explained by a
  // FLEET-level cause: a lowered `--max-turns`, a model regression, a classifier bug
  // reading every run as `exhausted`. Withholding them costs a day; letting them through
  // strips every label and starts a split run per issue.
  const wouldStop = verdicts.filter((v) => v.act === 'stop');
  // NOT `state === 'never-ran'` — see `sawAgent` in `classify`. By the time a verdict
  // carries `act: 'stop'` its state has been relabelled `exhausted`, so keying on the
  // state made this arm unreachable: it was only ever true when there was nothing to
  // withhold. `sawAgent` is the underlying fact and survives the relabel.
  //
  // NAMED FOR WHAT IT TESTS (RA-1272). It was `allNeverRan`, named for the very state the
  // line above explains it deliberately stopped reading — so the local, the operator
  // warning and `docs/observability.md` all described a classification the run cannot
  // produce, while the step summary showed `exhausted`.
  //
  // WHY `> 1`, WHICH THE COMMENT NEVER SAID. With a single verdict this arm is
  // switched off and the issue is stopped, and that is deliberate: `sawAgent === false`
  // on one issue is equally consistent with "the agent is down" and "this one issue is
  // unbuildable", and a breaker that never opens recreates the permanent-label state
  // RA-912 was filed to end (`docs/observability.md`, and the test named "does NOT become
  // the stall"). The tie is broken towards terminating. What would actually settle it
  // is whether the dispatched runs REACHED the model — RA-1517, once RA-1514 makes a run's
  // classification durable — not a wider predicate here.
  //
  // `has-pr` AND `human-held` STAY IN, and the choice is measured rather than assumed
  // (RA-1272). Both are reachable with `sawAgent === false` — 8 of 112 closed
  // `agent:implement` issues that carried a PR had no agent comment, measured
  // 2026-09-04 over the WHOLE population (RA-1548 review).
  //
  // THE FIRST TWO ATTEMPTS AT THIS NUMBER BOTH SAMPLED 40 AND REPORTED A POPULATION
  // FACT. `1 of 39` was the original, and RA-1534's "re-derivation" reproduced it by
  // re-running the same capped query — confirming the arithmetic and inheriting the
  // bound. There are 114 closed `agent:implement` issues; `--limit 40` silently
  // dropped 74 of them and understated the rate 2.8× (2.6% vs 7.1%). Re-check with a
  // limit ABOVE the population, never a default:
  //
  //   gh issue list --label agent:implement --state closed --limit 500 \
  //     --json number,comments,closedByPullRequestsReferences \
  //     --jq '[.[] | select((.closedByPullRequestsReferences|length) > 0)]
  //           | {withPr: length,
  //              noAgentComment: [.[] | select([.comments[]
  //                | select((.author.login|ascii_downcase)|test("implementer"))] | length == 0)
  //                | .number]}'
  //
  // The CONCLUSION is strengthened, not weakened: `has-pr` with no agent comment is
  // nearly three times more reachable than the comment used to claim, so keeping it
  // inside the fleet-wide arm matters more, not less.
  //
  // A DATED MEASUREMENT, not settled fact (agentic-lead-engineer.md §12.7) — and a
  // human-opened PR is genuinely poor evidence that the implementer is down, so
  // excluding them looks like a strict improvement. Executed against this module, it
  // is not: on a real fleet outage of three issues where two happen to carry a PR, the
  // exclusion drops the trip and STRIPS the labels the arm exists to protect. Keeping
  // them trades a rare withheld stop, which recovers once the fleet-wide condition
  // clears, against a rare stripped label, which does not recover at all.
  // Reachability is low either way; only one of the two directions is recoverable.
  //
  // "Recovers" is a duration, not one tick (RA-1534). Recomputation per run is true of
  // the mechanism, but the input persists: a long-lived `has-pr` issue with no agent
  // comment holds `sawAgent === false` on every sweep for as long as that PR is open, so
  // the withhold lasts as long as the condition does, with a `::warning::` each run.
  // A `too-big` verdict is evidence the model RAN, whatever the comments say (RA-1781), so
  // it counts against "the agent is down" exactly as an agent comment would.
  const noneSawAgent = verdicts.length > 1 && verdicts.every((v) => v.sawAgent === false && v.state !== 'too-big');
  if (!noneSawAgent && wouldStop.length <= maxStops) return { tripped: false, reason: '' };
  // Name the workflows the verdicts actually came from. With two lanes on one App
  // (RA-1336) a fleet-wide outage shows up across both, and a message that named only
  // `agent-implement.yml` would send the reader to the half that happened to be
  // listed first rather than to the one that is down.
  const workflows = [...new Set(verdicts.map((v) => v.lane?.workflow).filter(Boolean))];
  const where = workflows.length ? workflows.join(' / ') : 'agent-implement.yml';
  const labels = [...new Set(verdicts.map((v) => v.lane?.label).filter(Boolean))]
    .map((l) => `\`${l}\``).join(' / ') || `\`${LABEL}\``;
  return {
    tripped: true,
    reason:
      `Refusing to stop ${wouldStop.length} issue(s) this run: ` +
      (noneSawAgent
        ? `no open ${labels} issue has EVER had a comment from the agent, which is evidence about the agent, not about ${verdicts.length} separate issues.`
        : `more than ${maxStops} in one run is better explained by the agent being down than by that many issues being unbuildable.`) +
      ` Check ${where}'s recent runs. Re-dispatch is unaffected; stopping resumes on the next sweep once this clears.`,
  };
}

/**
 * The verdicts this run will ACT on, once the breaker has had its say.
 *
 * EXTRACTED AND EXPORTED so the withholding can be tested (RA-1272). The property
 * "never withholds a dispatch — only a stop" had a test asserting that the REASON
 * STRING contains `Re-dispatch is unaffected` — a test of a message, not of the
 * behaviour the message describes. The behaviour lived in `main`, which cannot be
 * reached without `gh`. Same reasoning that put `breakerTripped` behind an export.
 */
export function actionable(verdicts, tripped) {
  return verdicts.filter((v) => v.act && !(tripped && v.act === 'stop'));
}

/** The most issues ONE run may `stop()`. Small on purpose: stopping is the
 *  irreversible direction (the label goes away and the issue leaves the query), and
 *  more than a couple at once is better explained by the implementer being down.
 *  See the breaker in `main` (RA-916). */
export const MAX_STOPS_PER_RUN = Number(process.env.SWEEP_MAX_STOPS || 2);

const MAX_REDISPATCH = Number(process.env.QA_SWEEP_MAX_REDISPATCH || 2);
// Each re-dispatch spends a full Implementer run of subscription quota, so the cooldown
// is a quota guard, not politeness. It must exceed the daily cadence or a slow run
// gets re-dispatched underneath itself.
const COOLDOWN_HOURS = Number(process.env.QA_SWEEP_COOLDOWN_HOURS || 36);
// How long the agent's last word may stand unanswered before it is a human's problem.
// EXPORTED because `lead-reconcile.mjs` gates `human-held` on the same window before it
// frees a WIP slot (RA-2112) — one number, so the two cannot disagree about "stale".
export const STALE_HOURS = Number(process.env.QA_SWEEP_STALE_HOURS || 48);

const HOUR = 3600_000;
const hoursSince = (iso, now = Date.now()) => (now - Date.parse(iso)) / HOUR;
export const isBot = (login) => BOT_LOGINS.has(norm(login));

/** A secret must never reach a public issue comment — see `lead-reconcile.mjs`'s copy,
 *  which carries the reasoning (including why the body class admits `.`, `-` and `_`).
 *  `SweepFatal`'s message ends up in a `::error` annotation and, via `stop()`, in a
 *  comment on a public issue. Keep the two byte-identical. */
export const redactSecrets = (str) => String(str ?? '')
  .replace(/\bgh[pousr]_[A-Za-z0-9._-]{16,}/g, 'gh?_«redacted»')
  .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_«redacted»')
  .replace(/(https?:\/\/)[^/\s@]+@/g, '$1«redacted»@');

/** The one line of a `gh` failure that says WHY (RA-1284).
 *
 *  THE SWEEP GETS THE SAME TREATMENT, not an exemption. RA-1284 was filed against
 *  `lead-reconcile.mjs` and asks explicitly whether this copy should follow; it should,
 *  and for a sharper reason. `SweepFatal`'s message is the ONE per-issue failure this
 *  file promotes to fatal, on the grounds that an issue left with no trigger label is
 *  invisible to every future run — and the argv line it carried said nothing about
 *  whether that was a 403, a 404 or a blip, which is the whole question a human has to
 *  answer to get the label back. */
export const ghCause = (err) => {
  const raw = String(err?.stderr ?? '') || String(err?.message ?? '').split('\n').slice(1).join('\n');
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return redactSecrets(first).slice(0, 300);
};

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // Re-thrown with the cause on the FIRST line, so the two callers that take
    // `.split('\n')[0]` carry it without changing (RA-1284).
    const cause = ghCause(err);
    const e = new Error(`gh ${args[0] ?? ''} ${args[1] ?? ''} failed${cause ? `: ${cause}` : ' (no stderr)'}`);
    e.cause = err;
    e.ghCause = cause;
    e.stderr = err?.stderr;
    throw e;
  }
}
function ghJson(args) {
  return JSON.parse(gh(args));
}
function warn(msg) {
  console.log(`::warning title=qa-dispatch-sweep::${msg}`);
}

// ---------------------------------------------------------------------------
// Gather

// `has-pr` must mean "an open PR that would CLOSE this issue" — never "an open PR
// that MENTIONS it". The first draft regexed `#N` out of PR bodies, and in a repo
// that cross-references this densely that predicate degenerates to "has anyone
// mentioned this lately". Because `has-pr` outranks every other signal, the effect
// was silent and inverted: opening THIS pull request, whose body cites RA-855, RA-852,
// RA-730 and RA-159 as its motivating evidence, reclassified all four from
// `awaiting-human` to `has-pr` and would have buried the exact stalls it cites.
//
// Both arms below are claims of resolution rather than references to it:
//   • closingIssuesReferences — GitHub's OWN parse of the closing keywords. Using it
//     beats re-implementing `Closes #N` in a regex, and it cannot drift from what
//     GitHub will actually do on merge.
//   • the branch convention `<type>/<number>-<slug>`. This arm is NOT belt-and-braces
//     and must not be dropped: GitHub does not create a closing link at all when a
//     PR's base is not the default branch, keyword present or not. PR RA-863 is the
//     live proof — `base=worktree-issue-785-capability-review`,
//     `head=feat/845-capability-label`, `closingIssuesReferences: []` — so RA-845
//     resolves ONLY through this arm. Removing it re-dispatches every stacked PR's
//     issue, and the pipeline stacks routinely (agent-implement.yml branches a
//     follow-up off its still-open parent by design).
//
// Open PRs only: a merged PR that closed its issue would have closed it, and every
// issue reaching here is open.
export function linkedPrIndex(prs) {
  const closes = new Map();
  for (const pr of prs) {
    for (const ref of pr.closingIssuesReferences || []) {
      // A cross-repo closing reference carries another repo's issue numbers, which
      // would collide with ours and produce a false `has-pr` — the expensive
      // direction.
      //
      // READ THE PAYLOAD, NOT THE DOCS. `gh pr list --json closingIssuesReferences`
      // emits `repository: { id, name, owner: { id, login } }` on EVERY reference,
      // same-repo included — there is no `nameWithOwner`, and `repository` is never
      // absent. A guard on `ref.repository.nameWithOwner` therefore compared
      // `undefined` and skipped all 23 live references, silently reducing this arm
      // to nothing while the dry-run output stayed byte-identical (every issue that
      // was `has-pr` at the time happened to match the branch arm too). Absence is
      // still treated as ours, defensively, but it is not the normal case.
      // Case-insensitive because `GITHUB_REPOSITORY` casing is not guaranteed.
      const owner = ref.repository?.owner?.login;
      const name = ref.repository?.name;
      if (owner && name && `${owner}/${name}`.toLowerCase() !== REPO.toLowerCase()) continue;
      closes.set(ref.number, pr);
    }
  }
  return (issueNumber) =>
    closes.get(issueNumber) ||
    prs.find((pr) => new RegExp(`^[a-z]+/${issueNumber}-`).test(pr.headRefName || ''));
}

// ---------------------------------------------------------------------------
// Payload drift (RA-1262)
//
// `tests/fixtures/gh/*.json` are RECORDINGS of the real `gh --json` payloads, and the
// unit tier asserts the fields below exist in them. That closes the invented-field
// direction; the opposite one — a field `gh` STOPS emitting — would read as present in
// the recording forever, because nothing re-records it. `linkedPrIndex` is where that
// already shipped once (a guessed `nameWithOwner` silently indexed 0 of 23 references).
//
// So the sweep, which already holds a live `gh` every day, checks what it RECEIVED
// against the paths it reads, and says so on the run when one is missing. The paths
// live HERE rather than being read from the fixtures at run time (the script must not
// need a repo checkout's test tree); `dispatch-sweep.test.ts` holds this constant and
// the recordings in agreement, so the two halves cannot describe different shapes.
//
// A path is only checked where its nearest `[]` container has an element: an empty
// `closingIssuesReferences: []` says nothing about the element shape, and must not
// read as drift.
export const READ_SHAPES = {
  'pr list': [
    '[].number', '[].headRefName', '[].closingIssuesReferences',
    '[].closingIssuesReferences[].number',
    '[].closingIssuesReferences[].repository.name',
    '[].closingIssuesReferences[].repository.owner.login',
  ],
  // `labels[].name` feeds the terminal-verdict check (RA-1380). `body` is fetched only for
  // a decomposing lane, so it is not asserted here: absent is its normal state elsewhere.
  'issue list': ['[].number', '[].title', '[].createdAt', '[].labels', '[].labels[].name'],
  'issue comments': ['comments', 'comments[].body', 'comments[].createdAt', 'comments[].author.login'],
};

/** Every key path in a JSON value — `a`, `a[]`, `a[].b` … — intermediate ones included. */
export function keyPaths(value) {
  const out = new Set();
  const walk = (v, p) => {
    if (Array.isArray(v)) {
      if (p) out.add(p);
      for (const e of v) walk(e, `${p}[]`);
    } else if (v && typeof v === 'object') {
      if (p) out.add(p);
      for (const [k, e] of Object.entries(v)) walk(e, p ? `${p}.${k}` : k);
    } else if (p) out.add(p);
  };
  walk(value, '');
  return out;
}

/** The expected paths a payload is missing, skipping any whose array holds nothing. */
export function shapeDrift(payload, expected) {
  const have = keyPaths(payload);
  return expected.filter((path) => {
    if (have.has(path)) return false;
    const cut = path.lastIndexOf('[]');
    if (cut === -1) return true;
    // Nearest array container: `keyPaths` records its element marker (`x[]`, or `[]` at
    // the top) only when the array has an element, so this is the "non-empty" test.
    return have.has(path.slice(0, cut + 2));
  });
}

const driftSeen = new Set();
function noteDrift(kind, payload) {
  const missing = shapeDrift(payload, READ_SHAPES[kind]).filter((p) => !driftSeen.has(`${kind}:${p}`));
  if (missing.length === 0) return;
  for (const p of missing) driftSeen.add(`${kind}:${p}`);
  const msg = `gh ${kind} --json no longer carries ${missing.join(', ')} — tests/fixtures/gh is stale and the sweep reads a field that is gone (RA-1262). Re-record the fixtures and fix the reader.`;
  warn(msg);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `> [!WARNING]\n> ${msg}\n\n`);
}

function fetchOpenPrs() {
  const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '200',
    '--json', 'number,headRefName,closingIssuesReferences']);
  noteDrift('pr list', prs);
  return prs;
}

function openDispatchedIssues(lane) {
  // `labels` is fetched for the terminal-verdict check in `classify` (RA-1380) — the
  // one signal that cannot be read off the conversation. `body` for where a too-big
  // issue goes: its project marker and its split lineage (RA-1781).
  const issues = ghJson(['issue', 'list', '--repo', REPO, '--state', 'open', '--label', lane.label,
    '--limit', '200', '--json', `number,title,createdAt,labels${lane.decomposes ? ',body' : ''}`]);
  noteDrift('issue list', issues);
  return issues;
}

/** ONE SNAPSHOT PER ISSUE PER RUN (RA-1587).
 *
 *  Since RA-1573 `main()` reads an issue's comments TWICE — once to build the lane's
 *  unreached floor, once inside the classify loop — and the comment that change added
 *  claims the floor is *"read from the same comments the attempt count is derived
 *  from, so the two halves of the subtraction describe one set"*. With two fetches
 *  that was true by construction rather than by fact: a comment landing between them
 *  makes them different sets, and `Math.max(0, dispatched - unreached)` is exactly the
 *  arithmetic whose soundness depends on one set. Memoising makes the sentence
 *  literally true, and halves the API calls as a side benefit rather than as the point.
 *
 *  SCOPED TO THE RUN, and safe because nothing re-reads an issue's comments after the
 *  sweep writes one: `redispatch()` posts its marker inside the act loop, which runs
 *  after every verdict is classified, and no verdict is recomputed. */
export function makeCommentsReader({ json = ghJson, onPayload = () => {} } = {}) {
  const cache = new Map();
  return (number) => {
    if (cache.has(number)) return cache.get(number);
    const payload = json(['issue', 'view', String(number), '--repo', REPO, '--json', 'comments']);
    onPayload(payload);
    const { comments } = payload;
    const out = (comments ?? []).map((c) => ({
      login: norm(c.author?.login),
      createdAt: c.createdAt,
      body: c.body || '',
    }));
    cache.set(number, out);
    return out;
  };
}

// ---------------------------------------------------------------------------
// Classify
//
// Ordered so that the cheapest, most certain verdicts win. Note that `answered` and
// `never-ran` are the only ACTIONABLE states — everything else is either fine or a
// human's decision, and the sweep deliberately does not guess between "the agent
// asked a question" and "the agent claims it finished". Both are `awaiting-human`,
// reported with an excerpt so the difference is obvious at a glance; a brittle
// keyword match on the agent's prose would be worse than useless here.

export function classify(issue, comments, hasPr, opts = {}) {
  const {
    maxRedispatch = MAX_REDISPATCH,
    cooldownHours = COOLDOWN_HOURS,
    staleHours = STALE_HOURS,
    now = Date.now(),
    // HOW MANY OF THIS ISSUE'S DISPATCHES NEVER REACHED THE MODEL (RA-1517).
    //
    // The sweep counts an attempt per marker comment it left, which is a count of
    // DISPATCHES, not of runs that happened. A cap or an outage spends attempts
    // exactly like a genuine failure, so two bad days exhaust an issue and `stop()`
    // strips its label with a comment blaming the acceptance criteria — both stated
    // causes false, because no agent ever read it.
    //
    // Defaults to 0, which is the pre-RA-1517 behaviour: a caller that cannot read the
    // telemetry store charges every dispatch, exactly as before. Failing to read must
    // not silently un-exhaust an issue, so absence means "charge it".
    unreached = 0,
    // WHEN THIS ISSUE'S LATEST RUN EXHAUSTED ITS CAP, as epoch-ms — or null (RA-1781).
    //
    // The latest `COST#` row for the issue, and only when its `outcome` is `exhausted`
    // (see `exhaustedAtByIssue`). An exhausted run leaves no comment, so without this the
    // issue reads `never-ran` and is re-dispatched into the same cap twice before a
    // human hears of it — ~$21 and ~35 minutes each, for nothing. Defaults to null, the
    // pre-RA-1781 behaviour: a caller that cannot read the store dispatches as before,
    // which is bounded by `MAX_REDISPATCH` and so fails toward the old cost, not a stall.
    exhaustedAt = null,
    // WHEN THE TRIGGER LABEL WAS LAST APPLIED, as epoch-ms — or null (RA-1781). Read only
    // for an issue with an `exhaustedAt`, from its events. A label applied AFTER the
    // capped run is a re-run under way, and `too-big` must not stop it. Null when
    // unread, and then `main` passes no `exhaustedAt` either — see there.
    labeledAt = null,
    // Defaults to the implement lane so every existing caller — and every existing
    // test — keeps its exact meaning (RA-1336).
    lane = LANES[0],
  } = opts;

  // Normalise HERE, not only at fetch time: the comparison is the thing that must
  // be robust, so a caller handed a differently-shaped payload cannot reintroduce
  // the "every agent comment looks absent" bug.
  comments = comments.map((c) => ({ ...c, login: norm(c.login) }));

  // Attempts are counted by MARKER; the sweep's comments are excluded from the
  // conversation by EITHER its login or the marker, so neither signal alone is
  // load-bearing.
  //
  // TWO PREDICATES, DELIBERATELY (RA-1336). `isSweep` must exclude EVERY lane's sweep
  // comments from the conversation — a triage-lane comment on an issue that also
  // carries `agent:implement` is still the sweep talking, and reading it as a human
  // reply would trip `humanRepliedToSweep` and hold the issue forever. Counting, by
  // contrast, must be per-lane: attempts in one lane are not attempts in the other.
  const isSweep = (c) => c.login === SWEEP_LOGIN || c.body.includes(MARKER);
  const sweepComments = comments.filter((c) => isLaneComment(c.body, lane));
  const dispatched = sweepComments.length;
  // CHARGED = DISPATCHED − NEVER REACHED THE MODEL. Floored at 0: the store is read
  // over a window and the comments over all time, so a stale or over-broad read must
  // never manufacture a negative and hand an issue unlimited attempts.
  const redispatches = Math.max(0, dispatched - Math.max(0, unreached));
  const lastSweep = sweepComments.at(-1);
  const conversation = comments.filter((c) => !isSweep(c));
  const agentComments = conversation.filter((c) => c.login === lane.agent);
  const lastAgent = agentComments.at(-1);
  const last = conversation.at(-1);

  // A human who replies to the SWEEP is not a human answering the AGENT, and the
  // sweep must not read its own invitation to comment as a green light. The
  // discriminator is whether the agent spoke between the sweep's last comment and
  // the human's: if it did, the human is answering the agent (`answered`, and
  // dispatching is right); if it did not, the human is answering the sweep.
  //
  // This is reachable through `never-ran` as well as `answered` — the common shape
  // is a broken implementer that never comments, the sweep re-dispatching, and a
  // human replying "stop, this needs design". Before this check the sweep read that
  // objection as absence and dispatched again on the next tick.
  const after = (a, b) => a && b && Date.parse(a.createdAt) > Date.parse(b.createdAt);
  // Asked over the WHOLE conversation, not just its tail: a hold that depended on
  // `last` was cleared by any later third-party comment (a Reviewer scope note, a
  // github-actions comment), re-arming the dispatch the human had just objected to
  // — and the comment it then posted asserted "silence means the run never
  // happened" about an issue a human had explicitly held.
  //
  // THE HOLD IS PER-LANE, AND THAT IS A RULING, NOT A SIDE EFFECT (RA-1383). `lastSweep`
  // is this lane's last comment, so a human reply to the IMPLEMENT lane's sweep holds
  // the implement lane and not the triage lane on the same issue. That followed from
  // the per-lane COUNTING split (RA-1336) without being decided; it is decided here, and
  // for the cost of the alternative rather than the merit of this one:
  //
  //   · CROSS-LANE would key the hold on the last sweep comment of ANY lane. The
  //     triage lane never produces an implement-lane agent comment, so an old reply to
  //     an implement-lane comment would hold triage PERMANENTLY — on a question the
  //     human was not asked, with nothing in that lane able to clear it. That is the
  //     false-hold `isSweep` was split to avoid, applied to the hold itself.
  //   · PER-LANE's cost is one dispatch in the lane the human did not address, bounded
  //     by the 36h cooldown and `MAX_REDISPATCH`, after which `stop()` hands it to a
  //     human anyway — and the escape hatch the sweep advertises, removing the label,
  //     is itself per-lane.
  //
  // A bounded wasted run beats an unbounded silent hold. `tests/unit/dispatch-sweep.
  // test.ts` pins this ("the human-held hold is per-lane"); changing the ruling means
  // changing that test and this paragraph together.
  const humanRepliedToSweep = Boolean(
    lastSweep &&
    conversation.some((c) => !isBot(c.login) && after(c, lastSweep)) &&
    !after(lastAgent, lastSweep));

  // STATE describes the world; ACTION is decided separately below. Keeping them
  // apart is what stops the re-dispatch cap from being applied to an issue that
  // was never going to be re-dispatched — the earlier draft checked the cap first
  // and so could strip the trigger label off an issue the agent was actively
  // working on.
  //
  // The sweep deliberately does not try to tell "the agent asked a question" from
  // "the agent claims it finished". Both are `awaiting-human`, reported with an
  // excerpt so the difference is obvious at a glance; a keyword match on the
  // agent's own prose would be confidently wrong often enough to be worse than
  // useless.
  let state;
  if (terminalVerdict(issue, lane)) {
    // ANSWERED LEAVES, WAITING STAYS (RA-1380). A terminal triage verdict means the
    // question this lane exists to ask has been settled — so the issue must not be
    // treated as an unanswered one. It outranks every signal below including
    // `has-pr`, because the verdict is about the TRIAGE, not about the work.
    //
    // The label removal is also instructed in agent-triage.yml's prompt, and this
    // is deliberately the second of two mechanisms rather than a duplicate of the
    // first: a prompt is a request to a model, not a guarantee, and the failure it
    // guards against is silent — a settled issue accruing a daily warning nobody can
    // clear, one human reply away from re-firing an 80-minute job on a closed
    // question. `act: null`, never `stop`: the sweep does not need to strip a label
    // to reach the right outcome here, and stopping would post a `qa:needs-info`
    // hand-off note about an issue nobody needs information about.
    state = lane.settled ?? 'triage-settled';
  } else if (hasPr) {
    state = 'has-pr';
  } else if (humanRepliedToSweep) {
    // Held for a human on purpose. The escape hatch the sweep advertises is
    // "remove the label", but answering in prose is the natural thing to do and
    // must not be punished with another dispatch.
    state = 'human-held';
  } else if (agentComments.length === 0) {
    // The lane's workflow prompt says "ALWAYS leave a comment before you finish",
    // so silence means the run never happened — not that it ran and said nothing.
    // Comments from OTHER bots (a Reviewer scope note) are not evidence it ran. This
    // holds for both lanes because both prompts carry that sentence verbatim.
    state = 'never-ran';
  } else if (last && !isBot(last.login)) {
    // A human answered the agent's question and nothing re-fired. This is the case
    // that costs the most silently: the information needed to proceed already exists.
    state = 'answered';
  } else if (last && hoursSince(last.createdAt, now) < staleHours) {
    state = 'in-flight';
  } else {
    state = 'awaiting-human';
  }

  // `sawAgent` SURVIVES THE RELABEL (RA-916, corrected). The stop path replaces the
  // state — `never-ran` becomes `exhausted` — so `act === 'stop'` always implies
  // `state === 'exhausted'`, and a breaker arm asking "is every verdict `never-ran`?"
  // could only ever be true in a run that had NO stops to withhold. It was a warning
  // with an empty body.
  //
  // The fact the fleet-wide arm actually needs is "has this issue ever heard from the
  // implementer", which the relabel destroys. Carried explicitly so the breaker keys
  // on something `classify()` emits, rather than on a shape it cannot produce.
  // `lane` rides on the verdict so the act/report half never has to be told again
  // which lane produced it — the alternative is threading it through three call
  // sites and getting one of them wrong on the label edit, which is the single
  // failure `SweepFatal` exists to make impossible.
  // `dispatched` and `unreached` ride along so the report can say WHY the charged
  // count is lower than the number of comments on the issue — otherwise "attempt 1 of
  // 2" under three visible sweep comments reads as a bug.
  const base = {
    issue, lane, redispatches, dispatched, unreached: Math.max(0, unreached),
    maxRedispatch, lastSweep, last, sawAgent: agentComments.length > 0,
  };

  // TOO BIG — the latest run hit its cap (RA-1781). Checked before the attempt cap and the
  // cooldown, because neither bounds anything here: the next run is already known to
  // fail. And before the actionable-state gate, because a capped run can have SPOKEN —
  // a plan or progress comment early in the run — and would then read `in-flight` or
  // `awaiting-human` while nothing is running at all. Three things lift it:
  //   · a HUMAN word after the capped run — someone narrowed the scope or asked for
  //     another try, which is the escape hatch;
  //   · an AGENT word after it — a later run happened and spoke;
  //   · the trigger label RE-APPLIED after it (`labeledAt`) — a re-run is under way,
  //     and stopping it mid-run would strand its work beside a split PR.
  // NOT the states where a person or a PR already owns the issue. NOT `stop()`'s
  // `exhausted` either, which is the sweep's own attempt budget running out.
  const OWNED = ['has-pr', 'human-held', 'triage-settled', 'parked'];
  if (lane.decomposes && Number.isFinite(exhaustedAt) && !OWNED.includes(state)
    && !(Number.isFinite(labeledAt) && labeledAt > exhaustedAt)
    && !conversation.some((c) => Date.parse(c.createdAt) > exhaustedAt && (c.login === lane.agent || !isBot(c.login)))) {
    const route = exhaustedRoute({ project: projectOf(issue?.body), body: issue?.body });
    return { ...base, state: 'too-big', act: 'stop', stopLabel: route.label, why: route.why };
  }
  // Only `never-ran` and `answered` are actionable. Everything else is either fine
  // or a human's decision.
  if (state !== 'never-ran' && state !== 'answered') return { ...base, state, act: null };
  if (redispatches >= maxRedispatch) return { ...base, state: 'exhausted', act: 'stop' };
  const coolingDown = lastSweep && hoursSince(lastSweep.createdAt, now) < cooldownHours;
  return { ...base, state, act: coolingDown ? null : 'dispatch' };
}

// ---------------------------------------------------------------------------
// Act

// A label edit that half-succeeds is worse than one that fails outright: remove
// without add leaves the issue carrying NEITHER `agent:implement` nor
// `qa:needs-info`, so it drops out of openDispatchedIssues() and is invisible to
// every future sweep — a stall with LESS visibility than the ones this script
// exists to end. Warnings deliberately do not page (docs/observability.md §14), so
// this one case is escalated to a job failure instead.
class SweepFatal extends Error {}

// Node-native and unable to throw. Shelling out to `sleep` put a path AROUND the
// one hard invariant in this script: a spawn failure there is a plain Error, and
// main()'s per-issue catch lets anything that is not a SweepFatal through as a
// warning — leaving exactly the "issue carrying neither label, job green" state
// SweepFatal exists to make impossible. Also drops the POSIX dependency for free.
function sleepSeconds(seconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
  } catch {
    // Best effort: a backoff that cannot happen must never become a failure.
  }
}

function addLabelOrDie(n, label, context) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      gh(['issue', 'edit', n, '--repo', REPO, '--add-label', label]);
      return;
    } catch (err) {
      // Back off: the two failure modes named above (transient 5xx, secondary rate
      // limit) are exactly the ones three immediate retries fail together on. The
      // escalation below is the real protection; this makes the retries worth having.
      if (attempt < 3) sleepSeconds(attempt * 5);
      if (attempt === 3) {
        throw new SweepFatal(
          `#${n} lost \`${label}\` during ${context} and could not get it back ` +
          `(${err.message.split('\n')[0]}). It now carries no trigger label and no ` +
          'sweep will see it again — re-add the label by hand.');
      }
    }
  }
}

// Re-dispatch by REMOVING and RE-ADDING the label, not by workflow_dispatch.
//
// Two constraints force this. The default GITHUB_TOKEN cannot start another
// workflow at all (events it raises never trigger runs), so the sweep must hold an
// App token either way. And `POST /actions/workflows/{id}/dispatches` needs the
// `actions: write` App permission, which docs/qa/agent-identities.md does not grant
// to anyone — whereas re-adding a label needs only `Issues: Read & write`, which is
// all the Lead is granted. Label churn costs one extra event and strictly less
// authority than a workflow dispatch would need.
function redispatch(v) {
  const n = String(v.issue.number);
  const { lane } = v;
  const body = [
    // BOTH markers, always. MARKER is what every lane's `isSweep` recognises; the
    // lane tag is what THIS lane counts. Emitting only one of them re-opens exactly
    // one of the two bugs the pair prevents (RA-1336).
    MARKER,
    laneTag(lane),
    `Re-dispatching \`${lane.label}\` (attempt ${v.redispatches + 1} of ${v.maxRedispatch}`
      + `${v.unreached ? `; ${v.unreached} earlier dispatch${v.unreached === 1 ? '' : 'es'} never reached the model and ${v.unreached === 1 ? 'is' : 'are'} not charged, RA-1517` : ''}) — **${v.state}**.`,
    '',
    v.state === 'never-ran' ? lane.neverRan : lane.answered,
    '',
    `_Filed by \`scripts/dispatch-sweep.mjs\` (RA-912, ${lane.key} lane RA-1336). If this is wrong, remove the \`${lane.label}\` label._`,
  ].join('\n');
  // The comment goes FIRST because it is what records the attempt. If it failed and
  // the churn succeeded, the attempt would be uncounted and un-cooled-down, and the
  // issue would be re-dispatched every day forever.
  gh(['issue', 'comment', n, '--repo', REPO, '--body', body]);
  gh(['issue', 'edit', n, '--repo', REPO, '--remove-label', lane.label]);
  addLabelOrDie(n, lane.label, 're-dispatch');
}

function stop(v) {
  const n = String(v.issue.number);
  const { lane } = v;
  // Label edit FIRST here, inverting redispatch(): if the comment failed after a
  // successful edit the issue is still correctly labelled `qa:needs-info` and
  // visible to a human, whereas a comment posted before a failed edit would count
  // toward `redispatches` and re-comment every single day.
  const stopLabel = v.stopLabel ?? lane.stopLabel;
  gh(['issue', 'edit', n, '--repo', REPO, '--remove-label', lane.label]);
  // A `qa:needs-split` added here rides the Lead App token, so its `labeled` event
  // starts `agent-lead-split.yml` with no further call (RA-1781).
  addLabelOrDie(n, stopLabel, 'stop');
  const body = v.state === 'too-big'
    ? [
      MARKER,
      laneTag(lane),
      `Removing \`${lane.label}\`: this issue's latest implementer run hit its turn or budget cap, so a re-dispatch would hit it again (RA-1781).`,
      '',
      `It wants DECOMPOSING, not re-running. Labelled \`${stopLabel}\` — ${v.why}.`,
      '',
      `_Filed by \`scripts/dispatch-sweep.mjs\` (RA-912, ${lane.key} lane RA-1336, too-big RA-1781). To run it again unchanged instead, remove \`${stopLabel}\`${stopLabel === lane.stopLabel ? '' : ' (the split lane skips an issue without it)'} and re-add \`${lane.label}\` — a label applied after the capped run lifts this verdict._`,
    ].join('\n')
    : [
      MARKER,
      laneTag(lane),
      `Removing \`${lane.label}\` after ${v.redispatches} re-dispatches with no pull request.`,
      '',
      `Re-dispatching further would loop. Labelled \`${stopLabel}\` for a human: either the acceptance criteria need sharpening, or this needs building by hand. Remove \`${stopLabel}\` and re-add \`${lane.label}\` to try again — the sweep counts attempts from its own comments, so clear them to reset.`,
      '',
      `_Filed by \`scripts/dispatch-sweep.mjs\` (RA-912, ${lane.key} lane RA-1336)._`,
    ].join('\n');
  gh(['issue', 'comment', n, '--repo', REPO, '--body', body]);
}

// ---------------------------------------------------------------------------
// Report

const EXCERPT = 110;
function excerpt(c) {
  if (!c) return '';
  const text = c.body.replace(/\s+/g, ' ').trim();
  return `${c.login}: ${text.slice(0, EXCERPT)}${text.length > EXCERPT ? '…' : ''}`;
}

/**
 * The Attempts cell of the step-summary table.
 *
 * EXPORTED SO THE DISCOUNT IS ASSERTED, not merely rendered (RA-1573 review). The
 * step summary is the surface a human reads during an outage, and the re-dispatch
 * COMMENT — the other place that explains the discount — only fires on states that
 * actually re-dispatch, so `in-flight` and `awaiting-human` never carry it. Without
 * the cell, "1/2" under three visible sweep comments reads as a bug.
 */
export function attemptsCell(v) {
  return `${v.redispatches}/${v.maxRedispatch}${v.unreached ? ` (−${v.unreached} unreached)` : ''}`;
}

/**
 * The Action cell — `stop (withheld)` when the RA-916 breaker holds it back (RA-1260).
 * The table used to render `v.act` unconditionally while the breaker decided AFTER it,
 * so the run's durable record (the step summary) read "8 stopped" on exactly the run
 * that stopped none — and a maintainer reading it next morning would re-label by hand,
 * the recovery cost RA-916 exists to avoid, without the damage having happened.
 */
export function actionCell(v, breaker = { tripped: false }) {
  if (!v.act) return '—';
  return breaker.tripped && v.act === 'stop' ? 'stop (withheld)' : v.act;
}

const REPORT_ORDER = ['never-ran', 'answered', 'too-big', 'awaiting-human', 'human-held', 'exhausted', 'in-flight', 'has-pr', 'triage-settled', 'parked'];

/**
 * The step-summary text, pure so it can be asserted on (RA-1260). Takes the breaker's
 * decision rather than computing it, so the table and the acting loop read ONE answer —
 * and a dry run, which returns before acting, still previews what the breaker will do.
 *
 * @param {any[]} verdicts
 * @param {{ apply?: any, breaker?: { tripped: boolean, reason: string }, costLine?: string }} [opts]
 */
export function renderReport(verdicts, { apply = APPLY, breaker = { tripped: false, reason: '' }, costLine = '' } = {}) {
  const rows = [...verdicts].sort((a, b) => REPORT_ORDER.indexOf(a.state) - REPORT_ORDER.indexOf(b.state));

  // Per-lane counts in the heading, because "12 open issues" across two lanes hides
  // the thing worth seeing — a lane that is entirely quiet is either healthy or
  // not running, and the difference is only visible if the lanes are named (RA-1336).
  const perLane = LANES
    .map((l) => [l, verdicts.filter((v) => v.lane.key === l.key).length])
    .map(([l, n]) => `${n} \`${l.label}\``)
    .join(' · ');

  const lines = [
    `## Dispatch sweep — ${verdicts.length} open issue(s): ${perLane}`,
    '',
    apply ? '' : '**Dry run.** Pass `--apply` to act.',
    '',
    // Directly under the heading, because a skipped read changes what every Attempts
    // cell below means: none of them is discounted (RA-2706).
    ...(costLine ? [costLine, ''] : []),
    // The breaker's verdict on the persistent surface, not only as an annotation (which
    // does not survive into the summary). Worded for both modes: in a dry run it is the
    // preview of what `--apply` would withhold.
    ...(breaker.tripped
      ? [`> [!WARNING]\n> **Circuit breaker (RA-916) ${apply ? 'withheld' : 'would withhold'} every stop this run.** ${breaker.reason}`, '']
      : []),
    '| Issue | Lane | State | Action | Attempts | Last word |',
    '|---|---|---|---|---|---|',
    ...rows.map((v) =>
      `| [#${v.issue.number}](https://github.com/${REPO}/issues/${v.issue.number}) | \`${v.lane.key}\` | \`${v.state}\` | ${actionCell(v, breaker)} | ${attemptsCell(v)} | ${excerpt(v.last).replace(/\|/g, '\\|')} |`),
    '',
  ];

  const counts = REPORT_ORDER
    .map((s) => [s, rows.filter((v) => v.state === s).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');
  const withheld = breaker.tripped ? verdicts.filter((v) => v.act === 'stop').length : 0;
  lines.push(`**${counts || 'nothing open'}**${withheld ? ` · ${withheld} stop(s) withheld by the breaker` : ''}`, '');

  return { text: lines.join('\n'), rows };
}

function report(verdicts, breaker, costLine) {
  const { text, rows } = renderReport(verdicts, { apply: APPLY, breaker, costLine });
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

  // Surfaced as annotations so they are visible on the run without opening the summary.
  for (const v of rows.filter((v) => v.state === 'awaiting-human')) {
    warn(`#${v.issue.number} [${v.lane.key}] has waited ${Math.floor(hoursSince(v.last.createdAt))}h for a human — ${v.issue.title}`);
  }
  for (const v of rows.filter((v) => v.state === 'human-held')) {
    warn(`#${v.issue.number} [${v.lane.key}] is held: a human replied to the sweep and the agent has not run since — ${v.issue.title}`);
  }
}

// ---------------------------------------------------------------------------

/**
 * How many of an issue's dispatches never reached the model, per lane (RA-1517).
 *
 * Reads the L1 store's `COST#<telemetryAgent>` partition — one row per agent
 * invocation since RA-1514 — and counts rows whose `outcome` is `unavailable` and whose
 * `issue_number` matches. `outcome` is the classifier's own kind
 * (`agent-telemetry.mjs` destructures it straight in), so this is the same judgement
 * the run's annotation made, read back later.
 *
 * INJECTABLE, and it FAILS CLOSED. Every failure path returns an empty map, which
 * charges every dispatch — the pre-RA-1517 behaviour. An unreadable store must never
 * un-exhaust an issue: that would hand it unlimited attempts, which is the runaway
 * `MAX_REDISPATCH` exists to bound, arrived at from the other side.
 *
 * WINDOWED, because the partition grows without bound and the comments it is compared
 * against do not. `sk` is an ISO timestamp, so a range condition bounds the read; an
 * attempt older than the window is charged, which is the safe direction.
 *
 * PAIRED, NOT COUNTED (RA-1579). `dispatched` counts the sweep's OWN marker comments;
 * the rows are every `unavailable` run for the issue, whatever triggered it. RA-1573
 * narrowed that with a single floor — "a row older than the FIRST marker cannot be a
 * sweep dispatch" — which is the sound half. The subtraction relied on the converse,
 * which is false: a human re-applying the label between two sweep dispatches, whose
 * run was `unavailable`, still discounted one of the sweep's attempts, and repeating
 * the re-label kept the cap receding. So a row now discounts an attempt only when it
 * is, as far as the store and the Actions API can say, THE run a specific marker
 * comment triggered. Three conditions, each failing toward CHARGING:
 *
 *   1. ONE ROW PER MARKER. Each marker comment discounts at most itself, however many
 *      rows sit behind it, and — because the windows in (2) are disjoint — no row can
 *      be borrowed by two comments.
 *   2. IN THAT MARKER'S WINDOW. Strictly after the marker (a same-second tie is
 *      charged — the safe direction), strictly before the NEXT marker, and within
 *      `windowMinutes` of it. `sk` is stamped by the run's own telemetry step, which
 *      for an `unavailable` run fires minutes after the agent step fails; a row far
 *      from any sweep comment is somebody else's run. Closing the interval at the next
 *      marker can miss a sweep run that failed after the sweep's next comment — which
 *      charges it, the safe direction, and cannot happen at a 36h cooldown anyway.
 *   3. TRIGGERED BY THE SWEEP'S OWN APP. `run_id` is on the row, and the run's
 *      `triggering_actor` is the account that applied the label. A human re-label, a
 *      `workflow_dispatch`, or a re-run by a person is not a sweep dispatch whatever
 *      its timing. `triggeredBySweep` is injected; a missing `run_id` or an unreadable
 *      run is `false`, so an unattributable row is never a free attempt.
 *
 * Only a row that passed (1) and (2) is looked up, so the API cost is bounded by the
 * number of `unavailable` rows that sit right behind a sweep comment — usually zero.
 *
 * @param {Array<{ts?: string|null, issue_number?: string|number|null, outcome?: string|null, run_id?: string|null}>} rows
 * @param {number[]} issueNumbers
 * @param {{markers?: Map<number, number[]>, windowMinutes?: number, triggeredBySweep?: (row: any) => boolean}} [opts]
 *   `markers` — per issue, the epoch-ms of each of this lane's sweep comments. An issue
 *   with no markers has had no sweep dispatch, so nothing can be discounted for it.
 */
export function unreachedByIssue(rows, issueNumbers, {
  markers = new Map(),
  windowMinutes = PAIR_WINDOW_MINUTES,
  triggeredBySweep = () => false,
} = {}) {
  const wanted = new Set(issueNumbers);
  const candidates = new Map();
  for (const row of rows ?? []) {
    if (row?.outcome !== 'unavailable') continue;
    // MEMBERSHIP IS THE WHOLE TEST. An earlier version also required
    // `Number.isInteger`, which cannot fail here: `wanted` holds real issue numbers,
    // so anything `Number()` produces from a null, an empty string or a non-numeric
    // one — 0 or NaN — misses the set already. Mutation-checked: removing the integer
    // check failed nothing. A condition that reads as a guard and can never fire is
    // the thing that gets trusted later.
    const n = Number(row.issue_number);
    if (!wanted.has(n)) continue;
    // Rows with no parseable timestamp are skipped rather than assumed recent: an
    // unattributable row must not become a free attempt.
    const at = parseCostStamp(row.ts);
    if (at === null) continue;
    if (!candidates.has(n)) candidates.set(n, []);
    candidates.get(n).push({ row, at });
  }
  const out = new Map();
  const window = windowMinutes * 60_000;
  for (const [n, rowsFor] of candidates) {
    const marks = [...(markers.get(n) ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
    // NO "already used" SET, deliberately: the intervals `(mᵢ, mᵢ₊₁)` are disjoint, so
    // a row can fall in at most one and cannot be claimed twice. A used-set was written
    // and mutation-checked — deleting it failed nothing, because it could not fire.
    let paired = 0;
    marks.forEach((m, i) => {
      const next = marks[i + 1] ?? Infinity;
      if (rowsFor.some((c) => c.at > m && c.at < next && c.at - m <= window && triggeredBySweep(c.row))) paired += 1;
    });
    if (paired) out.set(n, paired);
  }
  return out;
}

/**
 * When each issue's LATEST run exhausted its cap, per issue (RA-1781) — epoch-ms of that
 * row, for issues whose most recent `COST#` row has `outcome: 'exhausted'`.
 *
 * THE LATEST ROW ONLY. An issue that exhausted once and then produced a PR, or a run
 * that merely crashed, is not too big now; only "the last thing that happened was the
 * cap" is. No pairing to a sweep comment, unlike `unreachedByIssue`, because the
 * question is different: that one decides whether an ATTEMPT is charged, and must fail
 * toward charging; this one asks what the issue's last run proved, whoever started it.
 *
 * FAILS OPEN, deliberately — an unreadable store is an empty map, which dispatches as the
 * sweep did before RA-1781. That is the bounded direction: `MAX_REDISPATCH` still caps it.
 * A row with no parseable stamp is skipped, so it can neither be the latest nor mask one.
 *
 * @param {Array<{ts?: string|null, issue_number?: string|number|null, outcome?: string|null}>} rows
 * @param {number[]} issueNumbers
 * @returns {Map<number, number>}
 */
export function exhaustedAtByIssue(rows, issueNumbers) {
  const wanted = new Set(issueNumbers);
  const latest = new Map();
  for (const row of rows ?? []) {
    const n = Number(row?.issue_number);
    if (!wanted.has(n)) continue;
    const at = parseCostStamp(row.ts);
    if (at === null) continue;
    const prev = latest.get(n);
    if (!prev || at > prev.at) latest.set(n, { at, outcome: row.outcome });
  }
  const out = new Map();
  for (const [n, { at, outcome }] of latest) if (outcome === 'exhausted') out.set(n, at);
  return out;
}

/** When `label` was last applied, from an issue's events, as epoch-ms — or null if it
 *  never was (RA-1781). Pure. */
export function lastLabeledAt(events, label) {
  const times = (events ?? [])
    .filter((e) => e?.event === 'labeled' && e?.label?.name === label)
    .map((e) => Date.parse(e.created_at))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** Reads `lastLabeledAt` for one issue; `undefined` when the events cannot be read.
 *  INJECTABLE. Only called for issues with an `exhaustedAt`, so it costs nothing on the
 *  common sweep. */
export function makeLabeledAtReader({ json = ghJson } = {}) {
  return (number, label) => {
    try {
      return lastLabeledAt(json(['api', '--paginate', '--slurp', `repos/${REPO}/issues/${number}/events?per_page=100`]).flat(), label);
    } catch {
      return undefined;
    }
  };
}

/** How long after a sweep comment its run's `unavailable` row may land and still be
 *  paired with it (RA-1579). An `unavailable` run fails at its first model call, so its
 *  row is written minutes after dispatch; 90 leaves room for a queued runner and
 *  setup. Too SHORT charges an attempt, which is the safe direction. */
export const PAIR_WINDOW_MINUTES = Number(process.env.QA_SWEEP_PAIR_WINDOW_MINUTES || 90);

/** A `COST#` sort key (`20260904T120245Z`) as epoch-ms, or null if it is not one.
 *  The inverse of `costStamp`, and strict: a key in any other shape is unattributable
 *  and so is charged. */
export function parseCostStamp(sk) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(sk ?? ''));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Was this store row's run started by the sweep's own App? (RA-1579)
 *
 * The run's `triggering_actor` is whoever applied the label that fired it — the sweep
 * churns with the Lead token, so its dispatches read `example-lead[bot]`. A human
 * re-label, a `workflow_dispatch` or a person's re-run reads as that person.
 *
 * INJECTABLE (`json`) and FAILS CLOSED: no `run_id`, or a read that throws, is `false`,
 * which charges the attempt. Memoised per run id for the life of one reader.
 */
export function makeSweepTriggerCheck({ json = ghJson } = {}) {
  const cache = new Map();
  return (row) => {
    const id = String(row?.run_id ?? '');
    if (!/^\d+$/.test(id)) return false;
    if (!cache.has(id)) {
      let login = null;
      try {
        login = json(['api', `repos/${REPO}/actions/runs/${id}`]).triggering_actor?.login ?? null;
      } catch {
        login = null;
      }
      cache.set(id, norm(login) === SWEEP_LOGIN);
    }
    return cache.get(id);
  };
}

const UNREACHED_WINDOW_DAYS = Number(process.env.QA_SWEEP_UNREACHED_WINDOW_DAYS || 14);

/**
 * A `COST#` sort key, in the format the store actually holds — BASIC ISO,
 * `20260904T120245Z`, with no dashes or colons.
 *
 * THE WINDOW WAS INERT BEFORE THIS (RA-1573 review). The bound was built with
 * `toISOString()`, which is EXTENDED ISO (`2026-09-04T12:02:45.050Z`), and DynamoDB
 * compares `S` keys as UTF-8 bytes. At index 4 the key has a digit and the bound has
 * `-` (0x2D < 0x30), so once the four year characters matched, `sk > :s` was
 * unconditionally true: a row from any earlier day of the same year passed a 14-day
 * window, and in early January it spanned two calendar years.
 *
 * That inverted the stated safety property. An issue with N `unavailable` runs at any
 * point that year carried an N-attempt discount forever, silently raising
 * `MAX_REDISPATCH` to `2 + N` — the un-exhausting direction this whole change says
 * must never happen.
 *
 * `runStamp()` in `collect-agent-telemetry.mjs` and `push-run.sh`'s `date -u
 * +%Y%m%dT%H%M%SZ` default are the only producers of these keys, and both emit this
 * shape. A historical row in any other format sorts BELOW this bound and is excluded,
 * which charges its attempt — the safe direction.
 */
export function costStamp(ms) {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** The `sk` lower bound for the lookback window. Exported so the window is testable
 *  as a VALUE compared against real stamps, not as a substring of the argv. */
export function unreachedWindowStart(now = Date.now(), days = UNREACHED_WINDOW_DAYS) {
  return costStamp(now - days * 86400_000);
}

/** Exactly the attributes `readCostRows` projects — the bound two documents record. Defined
 *  beside the query since it moved into the AWS store action (plan 0004 step P9).
 *
 *  `sk` is the sort key the query already ranges on, `issue_number` and `outcome` are
 *  the two fields the subtraction needs, and `run_id` is what lets a row be traced to
 *  the account that triggered it (RA-1579). Nothing else is read, and no write verb
 *  exists in the function. */
export { COST_PROJECTION } from '../infra/qa-store/aws/cost-rows.mjs';

/** Why the store cannot be read this run, or null if it can be tried (RA-2706).
 *
 *  THE READ FAILED SILENTLY FOR ITS WHOLE LIFE. The job lacked `environment: qa`, so
 *  `vars.QA_AWS_REGION` reached the AWS step empty, that step is `continue-on-error`,
 *  and `readCostRows` failed closed — every scheduled run charged every dispatch while
 *  its summary looked like a normal sweep. Fail-closed stays (it is the safe
 *  direction); what changes is that the run now SAYS it failed closed (`K-PRIN-8`).
 *
 *  `QA_AWS_AUTH` is the AWS step's `outcome` — not `conclusion`, which
 *  `continue-on-error` turns into `success`. Unset (a local run) is not a failure: the
 *  caller may hold credentials of their own, and the query itself reports if not.
 *
 *  @param {Record<string, string|undefined>} [env] */
export function costReadPrecondition(env = process.env) {
  if (env.QA_AWS_AUTH && env.QA_AWS_AUTH !== 'success') {
    return `the AWS credentials step did not succeed (outcome: ${env.QA_AWS_AUTH})`;
  }
  if (!env.QA_DYNAMO_TABLE) return 'QA_DYNAMO_TABLE is unset';
  if (!env.QA_AWS_REGION) return 'QA_AWS_REGION is unset';
  return null;
}

/** The one summary line saying whether the store was read (RA-2706), from each lane's
 *  `readCostRows` result. Per lane, because the lanes are read independently: one
 *  lane's failed query must not report the other lane's successful read as lost. A
 *  failed read costs more than the charge — the same rows feed RA-1781's `too-big`
 *  detection — so the line names both effects.
 *
 *  @param {Map<string, { rows: unknown[], error: string|null }>} reads */
export function costReadLine(reads) {
  const failed = [...reads].filter(([, r]) => r.error);
  const read = [...reads].filter(([, r]) => !r.error).map(([k, r]) => `${r.rows.length} \`${k}\``);
  if (!failed.length) return `Cost rows read (RA-1517): ${read.join(' · ') || 'no lane queried'}.`;
  const why = [...new Set(failed.map(([, r]) => r.error))].join('; ');
  const scope = read.length ? ` for ${failed.map(([k]) => `\`${k}\``).join(', ')}` : '';
  return `**Cost rows NOT read${scope}: ${why}; every dispatch charged and no run-cap exhaustion seen.**`
    + (read.length ? ` Read: ${read.join(' · ')}.` : '');
}

/** Surfaces a NOT-read line as an annotation too, so it shows on the run page. */
function warnCostRead(line) {
  if (line.startsWith('**Cost rows NOT read')) warn(line.replace(/\*\*/g, ''));
}

/** A lane's store rows, and why they could not be read. FAILS CLOSED — `rows` is []
 *  on any failure, which charges every dispatch (RA-1517) — and SAYS SO through
 *  `error` (RA-2706). Each lane is read independently of the others.
 *
 *  @param {{ telemetryAgent?: string, key: string }} lane
 *  @param {number} [now]
 *  @param {Record<string, string|undefined>} [env]
 *  @returns {{ rows: Array<{ts: string|null, issue_number: string|null, outcome: string|null, run_id: string|null}>, error: string|null }} */
export function readCostRows(lane, now = Date.now(), env = process.env) {
  const table = env.QA_DYNAMO_TABLE;
  const region = env.QA_AWS_REGION;
  if (!lane.telemetryAgent) return { rows: [], error: 'the lane names no telemetry agent' };
  const skipped = costReadPrecondition(env);
  if (skipped) return { rows: [], error: skipped };
  const since = unreachedWindowStart(now);
  try {
    // The query is the AWS store action's (plan 0004 step P9): one query, which the store hook's
    // `cost-rows` operation answers too, until step 9 moves this read onto the hook.
    const rows = queryCostRows({ agent: lane.telemetryAgent, since, table, region });
    return { rows, error: null };
  } catch (err) {
    // Fails closed — see `unreachedByIssue` — and says so (RA-2706).
    return { rows: [], error: `the store query failed (${ghCause(err) || 'no stderr'})` };
  }
}

function main() {
  if (!REPO) {
    console.error('dispatch-sweep: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  // Every lane is gathered before anything is classified, so the circuit breaker
  // below sees the WHOLE fleet. That is deliberate: both lanes run the same Implementer
  // App, so "no agent comment anywhere" is one fact about one implementer, and a
  // per-lane breaker would let a fleet-wide outage strip labels in whichever lane
  // happened to hold fewer than MAX_STOPS_PER_RUN issues (RA-1336).
  // ONE READER PER RUN (RA-1587) — see `makeCommentsReader`. A per-run instance rather
  // than a module-level cache, so the scope is structural: nothing can hold a snapshot
  // across runs, and a test can build its own.
  const commentsFor = makeCommentsReader({ onPayload: (p) => noteDrift('issue comments', p) });
  const byLane = LANES.map((lane) => ({ lane, issues: openDispatchedIssues(lane) }));
  const total = byLane.reduce((n, { issues }) => n + issues.length, 0);
  if (total === 0) {
    console.log(`No open issues in any lane (${LANES.map((l) => `\`${l.label}\``).join(', ')}).`);
    // Nothing to charge, so no query — but a broken AWS step is still a fact about
    // the NEXT run, and a quiet day must not hide it (RA-2706).
    const reason = costReadPrecondition();
    if (reason) {
      const line = costReadLine(new Map(LANES.map((l) => [l.key, { rows: [], error: reason }])));
      warnCostRead(line);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    }
    return;
  }
  // ONE PR fetch for every lane — the index is keyed by issue number and a triage
  // fix PR closes its bug exactly the way an implement PR closes its issue.
  const isLinked = linkedPrIndex(fetchOpenPrs());

  // An issue carrying BOTH trigger labels is classified once per lane, which is
  // correct: it has a separate attempt budget and a separate agent run in each.
  // ONE store query per lane, before classifying, so an issue's charged attempts can
  // exclude the dispatches whose run never reached the model (RA-1517).
  const triggeredBySweep = makeSweepTriggerCheck();
  // ONE READ PER LANE, shared by both derivations below (RA-1781 added the second).
  // Whether the read happened is REPORTED, not only absorbed (RA-2706): the summary
  // carries `costReadLine`, and a skipped or failed read is also a ::warning::.
  const reads = new Map(byLane.map(({ lane }) => [lane.key, readCostRows(lane)]));
  const rowsPerLane = new Map([...reads].map(([k, r]) => [k, r.rows]));
  const costLine = costReadLine(reads);
  warnCostRead(costLine);
  const exhaustedPerLane = new Map(byLane.map(({ lane, issues }) =>
    [lane.key, lane.decomposes ? exhaustedAtByIssue(rowsPerLane.get(lane.key), issues.map((i) => i.number)) : new Map()]));
  const unreachedPerLane = new Map(byLane.map(({ lane, issues }) => {
    // Every marker comment this lane left on each issue — the moments a row could be
    // a sweep dispatch (RA-1579). Read from the same comments the attempt count is
    // derived from, so the two halves of the subtraction describe one set.
    const markers = new Map(issues.map((i) => [i.number, commentsFor(i.number)
      .filter((c) => isLaneComment(c.body, lane))
      .map((c) => Date.parse(c.createdAt))]));
    return [lane.key, unreachedByIssue(rowsPerLane.get(lane.key), issues.map((i) => i.number), { markers, triggeredBySweep })];
  }));

  // WHEN THE LABEL WAS LAST APPLIED, for the few issues that have an exhaustion (RA-1781).
  // An unreadable event list FAILS TOWARD THE OLD BEHAVIOUR — no `exhaustedAt` at all,
  // so the issue is re-dispatched as before RA-1781 (bounded by MAX_REDISPATCH) rather
  // than possibly stopped mid-way through a re-run a human started.
  const labeledAtFor = makeLabeledAtReader();
  const verdicts = byLane.flatMap(({ lane, issues }) =>
    issues.map((issue) => {
      const exhaustedAt = exhaustedPerLane.get(lane.key)?.get(issue.number) ?? null;
      const labeledAt = exhaustedAt == null ? null : labeledAtFor(issue.number, lane.label);
      return classify(issue, commentsFor(issue.number), Boolean(isLinked(issue.number)), {
        lane,
        unreached: unreachedPerLane.get(lane.key)?.get(issue.number) ?? 0,
        exhaustedAt: labeledAt === undefined ? null : exhaustedAt,
        labeledAt: labeledAt ?? null,
      });
    }));

  // Decided BEFORE the report (RA-1260), so the summary shows what the run will do rather
  // than what it classified, and a dry run previews the breaker instead of returning
  // ahead of it. `breakerTripped` is pure; only the acting loop below is gated on APPLY.
  const breaker = breakerTripped(verdicts);
  report(verdicts, breaker, costLine);

  if (!APPLY) return;

  // CIRCUIT BREAKER (RA-916). It keys on `sawAgent === false` — this issue has never had
  // a comment from the agent — and NOT on the `never-ran` state, which by the time a
  // verdict carries `act: 'stop'` has been relabelled `exhausted` (RA-1272). This is the
  // fourth description of the same mechanism and it sits directly above the call, so it
  // says what the warning, the local and `docs/observability.md` say.
  //
  // That absence has two causes the classifier cannot tell apart: this issue is
  // unbuildable, or the implementer is down for everyone (App token expired, quota
  // exhausted, `agent-implement.yml` red, an Actions incident).
  //
  // In the second case the sweep does the maximally wrong thing on a timer: after the
  // cooldown it re-dispatches each issue, then at MAX_REDISPATCH calls `stop()` on all
  // of them — each losing `agent:implement`, gaining `qa:needs-info`, and gaining a
  // comment blaming the ISSUE for what is a fact about the PIPELINE. The recovery cost
  // is what makes it serious: once the trigger label is off, those issues drop out of
  // `openDispatchedIssues()` permanently, so no later sweep and no fix to the
  // implementer brings them back. A human must re-label each by hand, and must first
  // work out that this is what happened.
  //
  // A fleet-wide absence of agent comments is evidence about the FLEET. So the bound is
  // on how many issues one run may stop, and it is deliberately small.
  //
  // IT DOES NOT BECOME THE STALL (the check RA-916 asks for): the breaker only ever
  // withholds `stop`, never `dispatch`, and it caps a single RUN rather than latching.
  // A genuinely-unbuildable issue is still stopped on the next run once the fleet-wide
  // signal clears — so the state RA-912 exists to end still ends, one day later.
  const { tripped, reason } = breaker;
  if (tripped) warn(reason);

  for (const v of actionable(verdicts, tripped)) {
    try {
      if (v.act === 'dispatch') {
        redispatch(v);
        console.log(`re-dispatched #${v.issue.number}`);
      } else if (v.act === 'stop') {
        stop(v);
        console.log(`stopped #${v.issue.number}`);
      }
    } catch (err) {
      // One unactionable issue must not strand the rest of the sweep — EXCEPT a
      // half-applied label edit, which is the one failure that hides an issue from
      // every future run. That one goes red so GitHub's workflow-failure
      // notification carries it (docs/observability.md §14).
      if (err instanceof SweepFatal) throw err;
      warn(`#${v.issue.number}: ${v.act} failed — ${err.message.split('\n')[0]}`);
    }
  }
}

// Importing this module (the unit tier does) must not sweep anything.
if (process.argv[1] && process.argv[1].endsWith('dispatch-sweep.mjs')) main();
