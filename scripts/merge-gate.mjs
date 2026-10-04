#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-965 — the Merger. Decide whether one PR may be merged without a human.
//
// THE DECISION IS A PURE FUNCTION, so it is testable without GitHub and its
// escalation paths can be enumerated. `mergeVerdict` never calls an API; the thin
// caller below gathers the world and hands it over. Same discipline as
// `lead-reconcile.mjs`'s `phaseOf`, and for the same reason: every defect worth
// catching this week was in a decision, not in a fetch.
//
// ── IT MERGES THROUGH THE FRONT DOOR ────────────────────────────────────────
// the Merger is NOT a ruleset bypass actor. `main`'s ruleset still enforces all eight
// required checks and one approving review; the reviewer App has `Contents: write`
// so the Reviewer's approval satisfies that (§1.3, Option B, confirmed 2026-08-27).
//
// The cost of the alternative, recorded so nobody re-litigates it: a bypass actor
// bypasses the ENTIRE ruleset, checks included. Under that design this file would
// be the only thing standing between a red build and `main`. Here it is the second
// line, and the ruleset is the first.
//
// ── FOUR OUTCOMES, NOT TWO ──────────────────────────────────────────────────
//
//   merge     the green zone, on evidence from the CURRENT head
//   wait      checks still running — not a refusal, it will re-fire
//   recover   the PIPELINE can fix this itself, no human needed
//   escalate  a human decides
//   release   lift a `needs:human` the Merger applied that no longer means anything (RA-2097,
//             RA-2238) — never a merge; the next sweep evaluates the PR from scratch
//
// `recover` is the backstop for a hole that was closed UPSTREAM in the same change
// (RA-378): the Reviewer used to review alongside CI, and when a required check was still
// pending he posted a COMMENT verdict carrying an approve in its prose. Nothing
// converted it. Three of seven measured PRs — RA-1080, RA-1087, RA-1098 — ended there and
// were merged by hand, so a Merger reading review EVENTS would have stalled on
// roughly half of all PRs, permanently and silently.
//
// `agent-review.yml` now fires on CI's COMPLETION, so a COMMENT verdict should no
// longer be reachable. `recover` stays anyway, because that trigger change runs only
// from the default branch and therefore could not be exercised before it merged. A
// backstop for an untestable change is worth its near-dead code; if it never fires,
// that is the evidence the upstream fix works.
//
// ── EVERY ANSWER IS A REASON, NEVER A BOOLEAN ───────────────────────────────
// A refusal that does not say why is indistinguishable from a crash, and the
// pipeline's dominant failure this week was exactly that: three detectors calling a
// deadlocked project healthy while a PR sat for 19 hours. So the verdict carries
// the rule that fired, and the caller writes it onto the PR.

/**
 * Paths that must never be merged without a human are not written here (kanon#54). The
 * pipeline's own paths are Kanon's (`PIPELINE_ESCALATIONS`: `.github/**`, the `docs/qa/*.md`
 * playbooks, and the agent instructions and configuration, `AGENTS.md`, `CLAUDE.md` and
 * `.claude/`), and the project's pipeline code and high-risk paths are the
 * adopter's, declared in `docs/qa/escalation-paths.md` (`K-LAYOUT-8`). `main` reads that file
 * from the default branch (`K-MERGE-17`) and hands `escalatingPaths` of it to `mergeVerdict`,
 * so a pull request can't add or remove an escalation path for itself.
 *
 * `docs/qa/specs/**` is deliberately never an escalation path: those specs are the project's
 * DELIVERABLE, and escalating them made the Merger decline every PR the project he exists for
 * produces (measured on RA-1057). A spec change is reviewed by the Reviewer against the brief.
 */
export { PIPELINE_ESCALATIONS } from './lib/escalation-paths.mjs';

/**
 * The two workflows the Merger must not wait on, because they are him and the review
 * that woke him. Named by `workflowName`; see the note at the check inspection. They are
 * the adopter's caller names, so they live with the other protocol strings, old spellings
 * included (#53, `lib/protocol-spellings.mjs`).
 */
export { SELF_CHECKS, REVIEW_EVENT_CHECKS, ESCALATION_HEADER } from './lib/protocol-spellings.mjs';

/**
 * The JOBS of other workflows that start on the same `pull_request_review` event the Merger
 * does (RA-1177), so they are necessarily still running at the instant he reads the
 * rollup. Counting them made `checks-pending` the verdict on EVERY approval — observed
 * on PR RA-979: "wait (checks-pending): filter, revise, filter still running", everything
 * green and CLEAN a minute later — so the merge-on-approval path could never merge and
 * every merge fell through to the sweep, which only wakes when something ELSE lands on
 * main. Each is a decision about whether to act, never evidence about the merge:
 *
 *   - `Implement (Implementer) — revise` / `revise / filter` decides whether a changes-request
 *     needs answering. Since RA-2709 the lane is Kanon's reusable workflow, which this repo's
 *     `revise` job calls, so GitHub names its jobs `revise / <job>`. Its agent job
 *     (`revise / revise / run`, through the spine) is NOT excluded: it runs the Implementer and
 *     pushes, and when it is genuinely running the Merger must wait for it.
 *   - `Merge Reconcile (Reviewer)` / `reconcile / filter` checks whether the PR is already
 *     MERGED, and skips every open one; its `reconcile` job never runs on an open PR. Since
 *     plan 0001 step 3 the lane is Kanon's reusable workflow, which the reference adopter's
 *     `reconcile` job calls, so GitHub names its jobs `reconcile / <job>`.
 *
 * `Lead (Lead) — revise` needs no entry: the only root job of its Kanon lane (`filter`,
 * reported as `revise / filter`) is gated at job level on `review.state ==
 * 'changes_requested'`, and every other job needs it — so on an approval the whole run is
 * SKIPPED at once (measured on a called workflow whose jobs all skip: the run concludes
 * `skipped`, Kanon run 37006558783).
 *
 * Keyed on workflow AND job, for the reason `checkPartition` gives: three workflows
 * define a `filter` job. `tests/unit/merge-gate-review-racers.test.ts` derives the rule
 * from the workflow files (through the Kanon lane a job calls, read from the checkout of the
 * pinned tag) — every root job of a review-triggered workflow must be either
 * listed here or gated on the review state — so a new racer, or a new real guard on the
 * review event, is a red test rather than a silent always-wait or a silent skip.
 *
 * Excluding them cannot merge over a commit one of them pushes: `apply` merges with
 * `--match-head-commit`, so a head that moved after the read refuses the merge.
 */
const isReviewEventRacer = (c) =>
  REVIEW_EVENT_CHECKS.some((r) => r.workflow === c.workflowName && r.job === c.name);

/**
 * The merger App's slug — the login GitHub derives from its NAME ("Example
 * Merger" gives `example-merger`). Exported so `agent-merge.yml` can compare it against the slug the
 * minted token actually authenticates as and FAIL on a mismatch, the way
 * `dispatch-sweep.mjs` does with SWEEP_LOGIN.
 *
 * Worth a machine check because the failure is silent: the workflow's `if:` guard
 * stops the Merger from processing his own comments and merges, and a slug that does
 * not match simply never matches — no error, just an agent answering its own
 * events. Four live Apps were named differently from the names
 * docs/qa/agent-identities.md once suggested, so drift is the normal case rather
 * than the unlucky one — which is why the register now records slugs and this is
 * read from its `Merger` row (RA-2701).
 */
export const MERGER_LOGIN = appLogin('Merger'); // the register's `Merger` row (RA-2701)

/**
 * Labels that always mean a human decides.
 *
 * `needs:human` is on this list because the Merger APPLIES it, and the hourly sweep
 * re-evaluates every open PR from scratch. The marker suppresses the repeat COMMENT,
 * never the verdict — so any escalation whose condition is transient (a flaked Issues
 * probe, a re-run flaky check, a momentary non-CLEAN merge state) used to clear itself
 * and merge an hour later, still wearing the label that said not to. It also gives the
 * label the meaning its NAME promises: a person can apply it by hand to stop a merge.
 *
 * WHICH TRANSIENTS STILL APPLY IT, AND WHICH NO LONGER CAN (RA-1773, RA-1319, RA-2256). A
 * condition GitHub is still settling is a `wait`, not an escalation, so it never reaches
 * the label: `UNKNOWN` mergeability, `UNSTABLE` while any check is running or within
 * `UNSTABLE_SETTLE_MS` of the last one settling, an unreadable Actions run listing, and a
 * conflict the rebase lane has not tried yet. A flaked Issues probe, a re-run check that
 * failed, `BLOCKED`/`BEHIND`, and an `UNSTABLE` that outlives the window still escalate.
 *
 * AND THE LABEL CAN EXPIRE, but only the Merger's own (RA-2097, RA-2238). When the last `labeled`
 * event is his App and every escalation he posted is in `LAPSES_WITH_HEAD` and about a
 * commit that is no longer the head — or the PR conflicts and the lane has not tried —
 * he lifts it (`release`) and the next sweep re-runs every gate. A label a PERSON applied
 * is never lifted; to hold a PR the Merger already labeled, remove and re-apply it by hand,
 * which makes you its last applier.
 */
export const ESCALATE_LABELS = ['sev:critical', 'qa:needs-info', 'blocked', 'needs:human'];

/**
 * The labels that mark a PR as the implementer's pipeline work — BOTH of the Implementer's
 * modes, not one of them.
 *
 * `agent-implement.yml` labels a feature PR `agent:implement`; the triage-fix
 * playbook labels a bug-fix PR `agent:triage` (docs/qa/triage-fix-playbook.md). They
 * are the same agent, held to the same gate: the Reviewer reviews both, and the red-test
 * verification job from RA-938/RA-940 is scoped to the two labels together. Nothing
 * about a triage PR carries less evidence than an implement one.
 *
 * Testing `agent:implement` alone made the Merger decline the label the triage playbook
 * MANDATES — quietly, because a `skip` posts nothing. Measured on the 2026-08-29
 * 06:43 sweep: 9 of ~20 open PRs (RA-1164, RA-1159, RA-908, RA-891, RA-888, RA-885, RA-829, RA-817,
 * RA-811) skipped on this rule, several approved and CLEAN for days. That is this
 * pipeline's own dominant failure class (RA-945) — a gate that finds nothing looks
 * identical to a gate with nothing to do — reproduced inside the gate meant to
 * close the human merge (RA-1188).
 */
export const IMPLEMENTER_LABELS = ['agent:implement', 'agent:triage'];

/** The implementer whose PRs the Merger merges — the same App the rebase lane authors as.
 *  Exported so the parity between the two gates is asserted against one constant each
 *  rather than against a literal re-spelled in a test (RA-2218). */
export const IMPLEMENTER_LOGIN = appLogin('Implementer');

/** The reviewer whose verdict the gate reads — `mergeVerdict`'s default. It was an inline
 *  literal in that signature; since RA-2701 it is the register's `Reviewer` row. */
export const REVIEWER_LOGIN = appLogin('Reviewer');

/**
 * Runs on a commit that are WORKFLOW STARTUP FAILURES rather than job failures (RA-2222).
 *
 * WHY THE PR'S CHECK ROLLUP CANNOT SEE THESE. A workflow file GitHub refuses to LOAD
 * never produces a job, so it produces no check run — and `statusCheckRollup` is a list
 * of check runs. The run exists, is `failure`, and is attached to the head SHA, but the
 * PR's rollup is green and `mergeVerdict` merges. Measured on run 35589620617: a caller
 * job carrying `${{ env.ISSUE_NUMBER }}`, which is a context that does not exist where a
 * caller's inputs are evaluated. Ten legitimate runs sat on the same SHA, all green.
 *
 * THE SIGNATURE IS THE `name`. A run GitHub could not load is named for the FILE
 * (`.github/workflows/agent-triage.yml`); every run it could load is named for the
 * workflow's `name:` key, or for its `run-name:` where one is set. `agent-review.yml`
 * sets one since RA-2314, so its runs read `Review (Reviewer) <sha>`, not `Review (Reviewer)`.
 * Neither form is a path, and a path is all this predicate reads. Measured over the last
 * 300 runs of this repo (before RA-2314): zero path-named runs, so this cannot fire on a
 * concurrency-cancelled run or a `workflow_dispatch`. Those carry workflow names. A gate that refuses on something benign is worse than the
 * gap it closes, so the predicate is narrow by construction rather than by filtering.
 *
 * KNOWN GAP, STATED RATHER THAN PAPERED OVER: on a FORKED head the push run lives in the
 * fork, so a query against the base repo returns empty rather than erroring and the
 * failure stays invisible. Every agent PR in this repo is in-repo, so this is theoretical
 * here — but an empty answer meaning "none" and an empty answer meaning "cannot see" are
 * the silent-absence pair this whole file exists to keep apart.
 *
 * THAT PAIR IS KEPT APART FOR A FAILED READ, which is the half that is not theoretical
 * (RA-2256). `readPr` carries `workflowRuns` as `null` when the listing itself failed — a
 * 403, a rate limit, a renamed `--json` field — and `mergeVerdict` WAITS on `null` rather
 * than handing it here, where it would read as "no startup failure" and merge. This
 * function is only ever asked about a list that was actually read.
 */
export const startupFailuresIn = (runs = []) =>
  runs
    .filter((r) => r?.conclusion === 'failure' && /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(String(r?.name ?? '')))
    .map((r) => String(r.name));

/**
 * Escalation rules whose condition is a property of ONE COMMIT, so a push that replaces
 * that commit answers them afresh (RA-2097).
 *
 * `needs:human` used to be permanent the moment the Merger applied it: the quiet
 * `escalating-label` arm returns before every check, review and merge-state gate, so a
 * PR escalated on `checks-failed` stayed parked after the push that fixed the check —
 * silently, because that arm is quiet, and with a `why` ("nothing has changed") that was
 * false. PR RA-2056 is the measured case: escalated on `9d90a79`'s red E2E, rebased to
 * `745fb7b` with all ten check runs green, and refused every hour after.
 *
 * AN ALLOWLIST, NOT A DENYLIST, so a rule added later stays sticky until someone decides
 * it expires. Deliberately ABSENT:
 *   · `escalating-path` — a property of the DIFF, which survives a rebase. A human owes a
 *     verdict on a pipeline or schema change whatever commit it is on.
 *   · `escalating-label` — a human's `sev:critical` / `blocked` / `qa:needs-info` is a
 *     statement about the work, not about a commit, and is re-read every sweep anyway.
 */
export const LAPSES_WITH_HEAD = new Set([
  'workflow-startup-failure', 'files-unreadable', 'never-started', 'contradictory-verdicts',
  'checks-cancelled', 'checks-failed', 'undeclared-closes', 'closes-unverifiable', 'merge-state',
]);

// The first line of every escalation comment the Merger posts, `ESCALATION_HEADER`, is
// exported above from `lib/protocol-spellings.mjs` (#53), so `readPr` can tell an ESCALATION
// marker from a recover or release marker, which share the marker shape, in either spelling.

/**
 * How long an `UNSTABLE` merge state may disagree with a fully-settled rollup before it
 * is believed (RA-1773, RA-1319).
 *
 * `UNSTABLE` is GitHub saying a NON-required check is pending or failing. Twice it was
 * read in the seconds between siblings settling and GitHub catching up — PR RA-1314 went
 * CLEAN 71 seconds after the Merger escalated it, PR RA-1759 sat parked for 9 hours after an
 * evaluation made ~11 minutes after its last check completed — and each became a
 * terminal `needs:human` on a PR with nothing wrong with it. Inside this window it is a
 * `wait`; past it, with nothing running, the disagreement is real and still escalates.
 * Sized above the measured RA-1759 gap, and far below the hourly sweep, so a genuinely
 * failing non-required check escalates on the first sweep after it rather than never.
 */
export const UNSTABLE_SETTLE_MS = 20 * 60 * 1000;

/**
 * The check rollup, partitioned (RA-1974; exported for RA-1723's red-unreviewed detector).
 *
 * PURE, and the ONLY definition of "which check runs count" — `mergeVerdict` calls it, so a
 * second reader cannot drift from the gate. It applies, in order: the `SELF_CHECKS`
 * exclusion (`relevant`), the supersede rule (`live`), then splits `live` into three
 * DISJOINT sets:
 *
 *   pending    not COMPLETED — never superseded, whatever its siblings concluded (RA-1974)
 *   cancelled  COMPLETED and CANCELLED, with nothing conclusive to excuse it
 *   failed     COMPLETED, not CANCELLED, and not SUCCESS / SKIPPED / NEUTRAL
 *
 * Green means all three are empty AND `relevant` is not — zero checks is not "everything
 * passed" (RA-1147), and that judgement is the caller's.
 *
 * @typedef {{name: string, workflowName?: string, status: string, conclusion: string|null,
 *            startedAt?: string, completedAt?: string, databaseId?: number}} Check
 * @param {Check[]} checks
 * @returns {{relevant: Check[], live: Check[], pending: Check[], cancelled: Check[], failed: Check[]}}
 */
export function checkPartition(checks) {
  const relevant = (checks ?? []).filter(
    (c) => !SELF_CHECKS.includes(c.workflowName ?? c.name) && !isReviewEventRacer(c));
  // SUPERSEDED IS NOT EVIDENCE, and it must drop out before EVERY partition (RA-1168).
  //
  // The rollup carries every run on the head, so a check dispatched twice — `opened`
  // then `labeled`, routine here — leaves its `cancel-in-progress` casualty in the
  // list forever, next to the run that then passed. PR RA-979 is the worked case:
  // `Red-test verification` passed TWICE on `1c93976` and the Merger still refused.
  //
  // The first version of this fix excluded the superseded run from `cancelled` alone
  // and left it in `failed`, where `'CANCELLED'` is not in the allowed list — so the
  // entry was excused by one rule and picked straight back up by the next. The Merger
  // still refused, still escalated, and now printed `checks-failed` with no
  // remediation at all, which is WORSE than the wrong-but-actionable message it
  // replaced. The issue said "before the pending / cancelled / failed partitions";
  // applying it to one of three changed the rule name and nothing else.
  //
  // KEYED ON WORKFLOW AND NAME, not name alone: job ids are not unique across this
  // repo's workflows — `agent-implement-revise`, `agent-merge-reconcile` and
  // `agent-review` all define a `filter` job, and the exclusions above (`SELF_CHECKS`,
  // plus two of those `filter` jobs since RA-1177) leave the rest in — so a
  // genuinely-cancelled `filter` from one would be excused by a
  // successful `filter` from another. Two dispatches of the SAME workflow share both
  // fields, so supersede still works where it should.
  //
  // SUPERSEDE APPLIES TO ANY CONCLUSION, NOT JUST `CANCELLED` (RA-1892).
  //
  // A check that FAILED and was then re-run to SUCCESS on the SAME head SHA used to
  // refuse forever: a concluded check run stays in `statusCheckRollup` permanently, so
  // `failed` still contained the stale FAILURE while GitHub's own ruleset — which takes
  // the latest run per name — was satisfied. Measured on PR RA-1885 head `28b64ff`, which
  // carried `check` twice: FAILURE at 18:11:46Z and SUCCESS at 18:12:15Z.
  //
  // THE PATH IS ROUTINE, WHICH IS WHY THIS MATTERS. `closing-refs.mjs`'s own
  // remediation and `reviewer-playbook.md` (RA-1351) both say a body-edit finding is
  // fixed by editing the body — which re-fires on `pull_request: edited` with NO new
  // commit. So the prescribed fix for that whole class of finding is exactly what
  // leaves a stale FAILURE beside a SUCCESS on one SHA. On a human PR the Merger skips at
  // `not-the-implementer`; on an Implementer PR he is the merge path and it blocks
  // permanently, with every required check green on GitHub.
  //
  // ── WHY THIS STILL DOES NOT GUESS AN ORDERING ───────────────────────────────
  // The previous comment here refused to order by time because the rollup's timestamp
  // exposure could not be verified from the authoring environment, noting that
  // "guessing an ordering is how this rule got its meaning wrong the first time". That
  // caution is kept, and the reason is unchanged: the Checks API 403s for a personal
  // token, so neither `statusCheckRollup` nor `/commits/{sha}/check-runs` can be read
  // outside CI. GraphQL introspection (which needs no Checks access) confirms `CheckRun`
  // exposes `startedAt`, `completedAt` and a monotonic `databaseId` — but whether gh's
  // own `--json statusCheckRollup` projection carries them through is a separate
  // question, and one that cannot be answered from here.
  //
  // So this DEGRADES rather than assumes. `newest()` returns the discriminator if one
  // is present and `null` if not; when every entry for a key is indistinguishable, the
  // supersede narrows to the old `CANCELLED`-only behaviour, i.e. today's conservative
  // refusal. A missing field therefore costs a false refusal that a no-op push clears —
  // never a merge over a genuinely failing check, which is the direction that must not
  // break. `why` names which path was taken, so the first real run answers the question
  // the authoring environment could not.
  const key = (c) => `${c.workflowName ?? ''}/${c.name}`;
  // Prefer an explicit completion time; fall back to start, then to the monotonic id.
  // `Date.parse` of a valid ISO string and a numeric id are both safe to compare within
  // one key — across keys they are never compared.
  //
  // MEASURED FROM CI, which the authoring environment could not do (RA-1965 review):
  // gh's `--json statusCheckRollup` projection carries `startedAt` and `completedAt`, so
  // the primary path is live. It does NOT carry `databaseId` — so `readPr` always maps
  // that to `undefined` and THE THIRD RUNG IS UNREACHABLE THROUGH THE ONLY CALLER. It is
  // kept as a documented fallback for a direct caller, not because it fires here.
  //
  // `completedAt` IS NOT ALWAYS THE LATER OF THE TWO on real data — a skipped job is
  // stamped from the run's creation rather than the job's finish, so it can precede
  // `startedAt` (observed on this PR's own head: `revise` reported completedAt 04:34:03Z
  // against startedAt 04:34:13Z). Preferring it is still correct for the re-run case
  // this rule exists for; do not "fix" the precedence on the strength of that inversion.
  const stamp = (c) => {
    const t = Date.parse(c.completedAt ?? c.startedAt ?? '');
    if (Number.isFinite(t)) return t;
    return Number.isFinite(c.databaseId) ? c.databaseId : null;
  };
  // ONLY A CONCLUSIVE RESULT MAY SUPERSEDE (RA-1965 review). A `SKIPPED` entry is a
  // dispatch whose job DID NOT RUN, and a `CANCELLED` one is a casualty — neither is
  // evidence about the check, so neither may displace a sibling that actually ran. That
  // is the same "superseded is not evidence" reasoning this rule is built on, pointed
  // the other way.
  //
  // Letting them into `newestFor` was a live hole, not a hypothetical one: `red-test.yml`
  // narrows by LABEL at the job level (`:99-104`), not in its trigger (`:28` includes
  // `labeled`), so every label event dispatches the workflow and registers a SKIPPED
  // check run. The Reviewer applies `agent:reviewer` mid-review — AFTER the real run has
  // concluded — so on the standard agent-PR flow the SKIPPED is always the newest entry
  // for that key. A genuinely failing `Red-test verification` would then drop out of
  // `live` and merge, and it is NOT a required context (`red-test.yml:21-23`), so this
  // partition is the only thing that blocks on it. Measured on RA-1929/RA-1944/RA-1941.
  const CONCLUSIVE = (c) => c.conclusion && !['SKIPPED', 'CANCELLED'].includes(c.conclusion);
  const newestFor = new Map();
  for (const c of relevant) {
    if (!CONCLUSIVE(c)) continue;
    const s = stamp(c);
    if (s === null) continue;
    const k = key(c);
    const prev = newestFor.get(k);
    if (prev === undefined || s > prev) newestFor.set(k, s);
  }
  const concluded = new Set(
    relevant.filter((c) => c.conclusion && c.conclusion !== 'CANCELLED').map(key));
  const live = relevant.filter((c) => {
    // ONLY A CONCLUSIVE RESULT MAY BE SUPERSEDED EITHER (RA-1974) — the other half of the
    // rule above. A run that has not COMPLETED is stamped with its START (it has no
    // completion yet) while its concluded siblings are stamped with their COMPLETION, and
    // those are not comparable: whenever the two overlapped, the in-flight entry's start
    // is the older stamp. So an older run still IN_PROGRESS beside a newer SUCCESS was
    // dropped here, before `pending` below could see it, and the Merger merged with a check
    // running on the head. Measured against the real function: `merge (green-zone)`.
    //
    // Not reachable today only because every PR-triggered workflow happens to set a
    // concurrency group that cancels or queues the older run — eight files, none of which
    // knows this rule depends on it. So an unfinished entry always survives to `pending`.
    // A genuinely stuck run then parks the PR on `checks-pending`, which is the fail-closed
    // direction, and is named in the sweep summary's wait list rather than silent (RA-1290).
    if (c.status !== 'COMPLETED') return true;
    const k = key(c);
    // Ordered path: a strictly older entry for this key is superseded, whatever it
    // concluded. Equal stamps keep both — two runs that completed in the same
    // millisecond are not evidence about each other.
    const s = stamp(c);
    if (s !== null && newestFor.has(k) && s < newestFor.get(k)) return false;
    // Unordered fallback: the pre-RA-1892 rule, unchanged.
    return !(c.conclusion === 'CANCELLED' && concluded.has(k));
  });

  const pending = live.filter((c) => c.status !== 'COMPLETED');
  const done = live.filter((c) => c.status === 'COMPLETED');
  const cancelled = done.filter((c) => c.conclusion === 'CANCELLED');
  const failed = done.filter((c) => c.conclusion !== 'CANCELLED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion));
  return { relevant, live, pending, cancelled, failed };
}

/**
 * The Merger's verdict for one PR.
 *
 * @param {{
 *   number: number, author: string, state: string, isDraft: boolean,
 *   labels: string[], files: string[], headSha: string,
 *   reviews: {id?: number, state: string, sha: string, author: string,
 *             reviewedSha?: string|null, supersedes?: string[]}[],
 *   checks: {name: string, conclusion: string|null, status: string}[],
 *   mergeStateStatus: string,
 *   mergeable: string,
 *   rebaseAttempted: boolean|null,
 *   closing: {mergeClosesUndeclared: number[], unverifiable: boolean},
 *   workflowRuns: {name: string, conclusion: string|null}[]|null,
 *   hold?: {labeledBy: string, escalations: {rule: string, sha: string}[]}|null,
 * }} pr
 * `workflowRuns` IS REQUIRED TOO, and `null` is a value, not an omission (RA-2256): it
 * means the Actions listing could not be read, and anything that is not an array is
 * treated the same way — a `wait`, never "no startup failure".
 *
 * `hold` is read only when `needs:human` is on the PR: who applied that label last, and
 * which (rule, head) pairs the Merger's own escalation comments name. Absent or `null` means
 * "unknown", and an unknown hold is a human's hold — the label stays sticky (RA-2097).
 * BOTH MERGEABILITY FIELDS ARE REQUIRED, not optional (RA-2184). `conflictState` THROWS
 * `ConflictFieldsUnread` on a `pr` carrying neither, and this function is called from
 * `main`'s sweep loop — so a caller that projects NEITHER ends a tick rather than
 * degrading. One that projects only `mergeStateStatus` does NOT throw: `conflictState`
 * reads it alone, a stale `CLEAN` returns `clear`, and the RA-1708/RA-2175 hole (a
 * conflicting PR reaching `gh pr merge`) is back with no signal at all. `readPr` always
 * projects both via `CONFLICT_JSON`; this typedef is the only place a future caller
 * learns it must too.
 *
 * @param {{escalations: Array<readonly [RegExp, string]>, implementer?: string, reviewer?: string, now?: number}} who
 * `now` is injected for the `UNSTABLE` settle window, so the decision stays a function of
 * its arguments. `escalations` is REQUIRED: `escalatingPaths` of the escalation file as the
 * default branch has it (kanon#54). There is no default, because a default would be a list
 * of paths the adopter never declared, and a missing list is a caller's bug that must throw
 * rather than merge a PR no path rule was applied to.
 */
export function mergeVerdict(pr, { escalations, implementer = IMPLEMENTER_LOGIN, reviewer = REVIEWER_LOGIN, now = Date.now() } = /** @type {any} */ ({})) {
  if (!Array.isArray(escalations) || escalations.length === 0) {
    throw new Error('mergeVerdict needs the escalating paths (`escalatingPaths` of docs/qa/escalation-paths.md), and was given none');
  }
  // `quiet` is on EVERY verdict, not only the ones that set it. A field present on
  // some branches of a union is one every caller has to narrow for, and the one that
  // forgets suppresses nothing — so the default is carried explicitly.
  const stop = (rule, why, quiet = false) => ({ action: 'escalate', rule, why, quiet });
  const wait = (rule, why) => ({ action: 'wait', rule, why, quiet: false });
  const recover = (rule, why) => ({ action: 'recover', rule, why, quiet: false });
  // `not-a-candidate` is silent on purpose: this trigger is repo-wide, so most PRs
  // are simply not the Merger's. Reporting them as escalations would bury the real ones.
  const skip = (rule, why) => ({ action: 'skip', rule, why, quiet: true });
  // LIFT a `needs:human` that Merger himself applied and that no longer means anything
  // (RA-2097, RA-2238). Never merges: `apply` comments and removes the label, and the NEXT
  // sweep evaluates the PR from scratch through every gate below.
  const release = (rule, why) => ({ action: 'release', rule, why, quiet: false });
  const slug = (s) => String(s ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '');

  // ── Is this even a candidate? ─────────────────────────────────────────────
  if (pr.state !== 'OPEN') return skip('not-open', `PR is ${pr.state}`);
  if (pr.isDraft) return skip('draft', 'PR is a draft');

  // The green zone is the implementer's work. Everything else — a human's PR, a
  // brief from the Lead, a dependabot bump — is somebody else's call.
  if (slug(pr.author) !== implementer) {
    return skip('not-the-implementer', `authored by \`${pr.author}\`, not ${implementer}`);
  }
  if (!IMPLEMENTER_LABELS.some((l) => pr.labels.includes(l))) {
    return skip('not-implementer-label', `carries no \`${IMPLEMENTER_LABELS.join('` / `')}\` label (has: ${pr.labels.join(', ') || 'none'})`);
  }

  // ── Escalations, before any approval is considered ────────────────────────
  // REAL REASONS FIRST, the sticky label last. `needs:human` is one the Merger APPLIES, so
  // once it is on, matching it before anything else made it swallow every other
  // escalation: a later commit that newly touches `drizzle/` was absorbed into the
  // quiet arm and never announced. Checking it LAST means a new reason is still a new
  // announcement, and the label only silences when it is the ONLY thing left to say.
  const sev = pr.labels.filter((l) => ESCALATE_LABELS.includes(l) && l !== 'needs:human');
  if (sev.length) return stop('escalating-label', `carries \`${sev.join('`, `')}\``);

  const touched = pr.files.flatMap((f) => {
    const hit = escalations.find(([re]) => re.test(f));
    return hit ? [`\`${f}\` (${hit[1]})`] : [];
  });

  // WHOSE `needs:human` IS THIS? (RA-2097, RA-2238). `[]` means "a person's, or unknown" —
  // the label then stays sticky exactly as before. Only when the LAST `labeled` event
  // was the Merger's own App, and his own escalation comments say what it was about, is
  // there anything to reason from. A hand-applied label has no such comment and a
  // different actor, and is never lifted: it is the one manual brake in the pipeline.
  const head12 = String(pr.headSha).slice(0, 12);
  const mergersHold = () => {
    const h = pr.hold;
    if (!h || slug(h.labeledBy) !== MERGER_LOGIN) return [];
    return Array.isArray(h.escalations) ? h.escalations : [];
  };
  const held = pr.labels.includes('needs:human') ? mergersHold() : [];
  const lapsesWithHead = (e) => LAPSES_WITH_HEAD.has(e.rule);
  const shas = (es) => [...new Set(es.map((e) => `\`${String(e.sha).slice(0, 7)}\``))].join(', ');
  const rules = (es) => [...new Set(es.map((e) => `\`${e.rule}\``))].join(', ');

  // ── A CONFLICT THE REBASE LANE HAS NOT TRIED YET COMES FIRST (RA-2218, RA-2238) ──
  // Before every gate that can escalate — the startup-failure, file, path, review,
  // check and closing rules alike — because any of them stamps `needs:human`, and that
  // label is first on `rebase-lane.mjs`'s refusal list. So a conflicting PR escalated
  // for ANY reason was disqualified from the only thing that resolves it. The conflict
  // comes first: the lane's push mints a new head, and every one of those rules is then
  // re-asked on it — re-reviewed by the Reviewer, re-run by CI, and path-escalated again if it
  // touches a path a human decides. `escalating-path` means "a human decides whether
  // this MERGES", never "a human must perform the rebase".
  //
  // IT WAS BELOW THE CHECK GATES, AND THAT FLAPPED THE LABEL (RA-2317 review). With the
  // wait placed only ahead of the path rule, a lift of the Merger's `checks-failed` on THIS
  // head was undone on the very next sweep: the check gate re-escalated before the wait
  // was reached, `apply` re-applied the label, and the sweep after lifted it again —
  // forever, with the lane racing the toggle. Here, the evaluation after a lift is this
  // same `wait`, which `apply` acts on not at all.
  //
  // RA-1147'S ANNOUNCEMENT IS MET BY THE LANE: a `wait` posts nothing, but
  // `rebase-lane.mjs` posts its `attemptComment` before its session, and the wait is
  // named in the sweep summary (RA-1290). Every refusal in the lane's `ineligible()` is a
  // gate this function has already returned at (see the RA-2218 parity tests), so a PR
  // waiting here is one the lane accepts.
  //
  // Only `false` qualifies: tried-and-still-conflicting and unreadable both fall through
  // to the escalations they get today (`never-started` / `merge-state`, below).
  if (pr.rebaseAttempted === false && conflictState(pr) === 'conflicting') {
    // `{ UNKNOWN, CONFLICTING }` is GitHub still computing: wait on THAT, and neither lift
    // nor hand the PR to the lane on a half-computed answer. It settles into DIRTY or
    // stale-CLEAN by the next sweep, and both are answered here.
    if (pr.mergeStateStatus === 'UNKNOWN') {
      return wait('merge-state-unknown', 'GitHub is still computing mergeability');
    }
    if (pr.labels.includes('needs:human')) {
      // Lift the Merger's own label so the lane may act — but only when every escalation it
      // stands for is one a new head re-asks anyway (head-scoped, or the path rule that
      // re-fires on the resolved head). Anything else, or a label a person applied, stays
      // put and falls through to the gates below as before.
      if (held.length && held.every((e) => lapsesWithHead(e) || e.rule === 'escalating-path')) {
        return release('lifted-for-rebase', `this PR conflicts with \`main\`, and \`needs:human\` is the Merger's own escalation (${rules(held)} on ${shas(held)}) — which disqualifies it from \`agent-rebase.yml\`, the lane that resolves conflicts. Lifting it so the lane can act; the resolved head is re-reviewed, re-run and re-evaluated from scratch, and ${touched.length ? 'the path rule will escalate it again there, because a human still decides whether it merges' : 'anything still wrong there escalates again'} (RA-2238)`);
      }
    } else if (checkPartition(pr.checks).relevant.length === 0) {
      // "No CI has run on this head at all" IS the un-startable state `agent-rebase.yml`'s
      // header names as its population — reachable on the first sweep: a PR opened
      // already conflicting, or a revise commit pushed onto a branch that conflicts.
      return wait('never-started-rebasing', `${CONFLICT_WHY}. No CI has run on this head at all — which is the un-startable state \`agent-rebase.yml\` exists for. It owns this one and has not tried this head yet, so not escalating: \`needs:human\` would disqualify it from the lane that fixes it (RA-2218)`);
    } else {
      return wait('merge-state-rebasing', `${CONFLICT_WHY}. \`agent-rebase.yml\` owns this one and has not tried this head yet — not escalating${touched.length ? ` (it also touches ${touched.join(', ')}, which a human decides; the path rule escalates on the resolved head)` : ''}, because \`needs:human\` would disqualify it from the lane that fixes it (RA-2218, RA-2238)`);
    }
  }


  // A WORKFLOW THE HEAD SHA MADE UNLOADABLE (RA-2222). Checked HERE — before any path or
  // review rule and before `merge` is reachable — because it is invisible to everything
  // downstream: a file GitHub refuses to load produces no job, so no check run, so the
  // rollup those rules read is GREEN while the run sits on the SHA marked `failure`.
  //
  // Escalate rather than `wait`: this is deterministic on the commit, so re-firing
  // changes nothing and a human has to edit the file. Naming the file is the point — the
  // one real instance identified itself only by appearing where a workflow NAME belongs.
  //
  // AN UNREAD LIST IS NOT AN EMPTY ONE (RA-2256). This read used to be wrapped in a `catch`
  // that yielded `[]`, which the predicate reads as "none" — so a 403 or a renamed
  // `--json` field silently switched the rule off and the PR merged. `readPr` now carries
  // a failed read as `null`, and this WAITS on it rather than escalating: the likely cause
  // is transient (a rate limit, a flaked token), an escalation would stamp the sticky
  // `needs:human`, and a `wait` is re-asked next sweep. It is not silent — every `wait` is
  // named in the sweep summary (RA-1290), so a listing that never comes back is a PR number
  // against `runs-unreadable` in every run, not an absence.
  if (!Array.isArray(pr.workflowRuns)) {
    return wait('runs-unreadable', 'the Actions run listing for this head could not be read, so whether a workflow file failed to load on it is unknown — not merging on an unread answer (RA-2256)');
  }
  const broken = startupFailuresIn(pr.workflowRuns);
  if (broken.length) {
    return stop(
      'workflow-startup-failure',
      `${broken.length} workflow file(s) on this head cannot be loaded by GitHub, so they run no job and appear in no check: \`${broken.join('`, `')}\``,
    );
  }

  // AN EMPTY FILE LIST DISABLES EVERY PATH RULE, and does it silently — the verdict
  // still reads `green-zone … no escalating path`. A PR always changes at least one
  // file, so empty means the read failed, not that nothing was touched.
  if (!pr.files.length) {
    return stop('files-unreadable', 'the changed-file list came back empty, so the escalating-path rules could not be applied');
  }

  if (touched.length) {
    return stop('escalating-path', `touches ${touched.join(', ')} — a human decides these`);
  }

  // Nothing else to say, and the label is on: refuse without repeating myself. A
  // different rule means a different marker means a SECOND comment, saying only that
  // the PR carries the label the Merger just applied — and this surface only works while
  // every message on it means something. `quiet` suppresses the announcement, never
  // the verdict, and a human applying the label by hand gets the same protection.
  if (pr.labels.includes('needs:human')) {
    // ── UNLESS THE COMMIT IT WAS ABOUT IS GONE (RA-2097) ──────────────────────────────
    // Every escalation the Merger made must be head-scoped AND about a commit other than
    // this head. One escalation naming THIS head, or one rule that does not lapse, and
    // the label means what it says. Released rather than merged through: the next sweep
    // re-reads the PR with the label gone and runs every gate, so a condition that still
    // holds on the new head is re-escalated — with a new marker, so it is re-announced.
    if (held.length && held.every((e) => lapsesWithHead(e) && String(e.sha).slice(0, 12) !== head12)) {
      return release('escalation-lapsed', `the Merger escalated ${rules(held)} on ${shas(held)}, and the head is now \`${String(pr.headSha).slice(0, 7)}\` — the commit that escalation was about no longer exists. Lifting \`needs:human\` so the next sweep re-evaluates this head from scratch; a label a person applies is never lifted (RA-2097)`);
    }
    return stop('escalating-label', held.length
      ? `already escalated — \`needs:human\` is on it for ${rules(held)} on ${shas(held)}`
      : 'already escalated — `needs:human` is on it, and it was not the Merger\'s own escalation (or who applied it could not be read), so it stays until a person removes it', true);
  }

  // ── DID ANYTHING EVEN RUN? (RA-1147) ────────────────────────────────────────
  // FIRST, and the position is the fix. This block used to sit with the other check
  // gates, below the review test — and `no-review-on-head` returns before it, so
  // `never-started` was UNREACHABLE for the exact case it was built for: a PR that
  // conflicts at open gets no merge ref, so no CI, so no Reviewer, so no review on head.
  // It exited as a `recover`, which posts "the Merger asked agent-review.yml to re-review
  // this commit" — reading as *the pipeline is handling it* — applied no
  // `needs:human`, and fired once because the marker is keyed on the head SHA.
  //
  // Its tests passed anyway, because the fixture defaults an APPROVED review on head
  // and the cases overrode only `checks` and `mergeStateStatus`. Every assertion about
  // an unstartable PR was made about a PR holding an approval the scenario cannot
  // produce. That is this pipeline's own failure class turned on its own test suite,
  // so the cases below now set `reviews: []` and would fail if this block moved back.
  //
  // Keyed on `relevant`, not `pr.checks`: one SELF_CHECKS entry on the head (the Reviewer's
  // own check run, which exists the instant he starts) would otherwise make the gate
  // miss and drop through to a `wait` that announces nothing.
  const { relevant, pending, cancelled, failed } = checkPartition(pr.checks);
  if (relevant.length === 0) {
    // THE SIXTH READER, CONVERTED (RA-2154). This asked `mergeStateStatus === 'DIRTY'`
    // and requested only that field, so on `{ mergeStateStatus: 'CLEAN', mergeable:
    // 'CONFLICTING' }` — the stale-field case `conflict-state.mjs` deliberately pins as
    // reachable — the five reconciler lanes said "blocked on a rebase" and the Merger read
    // CLEAN and went on to `merge`. RA-2152's stated invariant is one definition of
    // "conflicting" in `scripts/qa/`; it did not hold until this call.
    if (conflictState(pr) === 'conflicting') {
      // THE SAME ARBITRATION AS THE RULESET ARM BELOW, and it belongs here MORE than
      // there (RA-2218). "No CI has run on this head at all" IS the un-startable state,
      // and `agent-rebase.yml`'s own header names it as the population it was built
      // for. Fixing only the lower arm left the lane disqualified from exactly the PRs
      // it exists for, while this PR's docs asserted otherwise — which is worse than
      // not fixing it, because the claim is what a reader checks instead of the code.
      //
      // Reachable on the FIRST sweep, not as an edge case: a PR opened already
      // conflicting, or a revise commit pushed onto a branch that already conflicts —
      // no `pull_request` dispatch, so no checks on the new head.
      //
      // RA-1147'S ANNOUNCEMENT REQUIREMENT IS STILL MET, and by the same argument the
      // lower arm already accepted: a `wait` posts nothing, but `rebase-lane.mjs`
      // posts its `attemptComment` before its session, and `project-digest.mjs` still
      // renders this member as `:rotating_light:`. What RA-1147 forbids is a stall that
      // NOTHING announces; this one is announced by the agent that is acting on it.
      // `rebaseAttempted === false` waited above, ahead of every escalating gate (RA-2238).
      // The shared sentence VERBATIM, then this gate's own fact. Restating it in
      // the Merger's words is how the two drift while still agreeing logically.
      return stop('never-started', `${CONFLICT_WHY}. And no CI has run on this head at all, so no agent downstream can act: no CI means no review, and no review means no revise (RA-1147). \`agent-rebase.yml\` ${pr.rebaseAttempted === null ? 'may already have attempted this head — its comments could not be read, and an unread answer escalates rather than stalls' : 'has already attempted this head and it still conflicts'}`);
    }
    // Not conflicting, just early. Not-yet and never are different, and treating one
    // as the other is what most of this file's history is about.
    return wait('no-checks-yet', pr.checks.length
      ? `only this pipeline's own checks are reporting (${pr.checks.map((c) => c.name).join(', ')}) — CI has not registered yet`
      : 'no check runs have registered on this head yet');
  }

  // ── The evidence ──────────────────────────────────────────────────────────
  //
  // ON THE CURRENT HEAD, not anywhere. An approval for a superseded commit twice
  // reached the merge button this week (RA-964, RA-1057).
  //
  // CORRECTED 2026-08-27: an earlier version of this comment said
  // `dismiss_stale_reviews_on_push` is FALSE and that this check was therefore the
  // ONLY guard. It is TRUE — verified against ruleset 18630463 — so the ruleset does
  // dismiss a stale approval on push and this is the second line, not the first. The
  // check is right either way and is deliberately kept: it is cheap, it is local, and
  // agreeing with the ruleset independently is what makes a disagreement a finding.
  // WHAT THE REVIEW READ, NOT WHAT GITHUB FILED IT UNDER (RA-1680). `commit_id` is the
  // head at SUBMISSION time, and a reviewer run reads its diff minutes earlier — so a
  // push landing inside that window re-attributes the verdict to a commit the run
  // never saw, and this filter is the mechanism that then merges on it. The reviewer
  // job stamps the SHA it checked out into the review body; `reviewedSha` is that
  // stamp. Absent (every review posted before RA-1680, and any from a manual session)
  // it falls back to `commit_id`, which is exactly the pre-RA-1680 behaviour — the stamp
  // can prove the head was read, its absence proves nothing either way.
  // IMPORTED, NOT RE-DERIVED. This file hand-rolled `r.reviewedSha || r.sha` beside an
  // exported `evidenceSha` that had no callers — a second copy of the rule, and one
  // that had already drifted (`||` where the export uses `??`). The argument for
  // extracting `review-run-evidence.mjs` applies verbatim here.
  const onHead = pr.reviews.filter((r) => evidenceSha(r) === pr.headSha);
  const latestByReviewer = [...onHead].reverse().find((r) => slug(r.author) === reviewer);
  if (!latestByReviewer) {
    // NAMED SEPARATELY FROM A MERELY STALE APPROVAL, because the two look identical on
    // the PR and only one of them is a lie. A stale approval is honestly filed against
    // an older commit and any reader can see it; a mis-attributed one is filed against
    // THIS commit and reads as current — which is why it reached a merge gate at all.
    const misattributed = pr.reviews.filter((r) =>
      slug(r.author) === reviewer && r.sha === pr.headSha
      && r.reviewedSha && r.reviewedSha !== pr.headSha);
    if (misattributed.length) {
      const read = misattributed.map((r) => `\`${String(r.reviewedSha).slice(0, 7)}\``).join(', ');
      return recover('review-misattributed',
        `GitHub filed ${reviewer}'s review under \`${pr.headSha.slice(0, 7)}\` because that was the head when it was SUBMITTED, but the run read ${read} — the head moved mid-review, so this is not evidence about this commit (RA-1680)`);
    }
    const elsewhere = pr.reviews.some((r) => slug(r.author) === reviewer);
    // RECOVERABLE either way: a review that never happened, and one attached to a
    // superseded commit, are both fixed by asking for a review of THIS commit.
    return recover('no-review-on-head', elsewhere
      ? `${reviewer} has reviewed, but not commit \`${pr.headSha.slice(0, 7)}\` — the approval is stale`
      : `${reviewer} has not reviewed this commit`);
  }
  // ── TWO VERDICTS ON ONE COMMIT, AND ORDERING DECIDING WHICH WINS (RA-1334) ──
  //
  // `latestByReviewer` takes the last review. That is RIGHT three times over and
  // WRONG once, and the difference is whether the later verdict was FORMED KNOWING
  // about the earlier one:
  //
  //   · RA-1351's re-review — a finding whose remedy is a PR-BODY edit produces no new
  //     commit, so a human re-labels and the Reviewer re-reviews the same SHA.
  //     `request-changes` -> `approve` there is the pipeline working.
  //   · A run correcting ITSELF, which he does explicitly: "Correcting myself first. I
  //     approved this at 14:57 on what I believed was the head" (PR RA-1652).
  //   · Two runs that never saw each other. MEASURED on PR RA-1708 head `76a6a18`: six
  //     `agent-review` runs dispatched, two surviving the concurrency group because
  //     they had different ACTORS (the Implementer's labels, then the Merger's), and between them
  //     THREE review events — `APPROVED` 11:36:31, `CHANGES_REQUESTED` 11:37:47 and
  //     11:40:25. Had the approval arrived last, this file would have merged over two
  //     unanswered blocking reviews. PR RA-1324 is the same shape a week earlier: an
  //     `APPROVE` three minutes after a `CHANGES_REQUESTED` addressing neither of its
  //     findings, and its sibling recovered only because a human read both bodies.
  //
  // THE TRAILER IS WHAT SEPARATES THEM, on two fields. `supersedes` names the verdicts
  // this run deliberately replaced — a CI re-review of an unchanged commit only happens
  // past the `already reviewed <sha>` skip, so it can honestly claim that. `run` names
  // the run that posted, so a run correcting itself is visible as one author changing
  // its mind rather than two disagreeing. An approval carrying neither is a blind
  // second opinion, and merging on it is merging over findings nobody answered.
  //
  // NOT A DEDUPE. Collapsing identical same-SHA verdicts would have left PR RA-1708
  // fully broken — its three events do not agree, which is the whole danger.
  if (latestByReviewer.state === 'APPROVED') {
    const superseded = new Set((latestByReviewer.supersedes ?? []).map(String));
    const unanswered = onHead.filter((r) =>
      slug(r.author) === reviewer && r.state === 'CHANGES_REQUESTED'
      && !superseded.has(String(r.id))
      // SAME RUN, SO IT KNEW. A run that posts a request-changes and then an approval
      // read the earlier one by construction — it wrote it — and no concurrency key can
      // reach that case, so the run id is the only thing that can say so.
      && !(r.runId && latestByReviewer.runId && r.runId === latestByReviewer.runId));
    if (unanswered.length) {
      return stop('contradictory-verdicts',
        `${reviewer} has BOTH an approval and ${unanswered.length} unanswered \`CHANGES_REQUESTED\` on \`${pr.headSha.slice(0, 7)}\` (review ${unanswered.map((r) => `#${r.id}`).join(', ')}), and the approval does not say it supersedes ${unanswered.length > 1 ? 'them' : 'it'} — two runs disagreed and submission order is deciding it. Read both bodies; the findings of the losing one are invisible on every other surface (RA-1334)`);
    }
  }
  if (latestByReviewer.state === 'CHANGES_REQUESTED') {
    // SILENT, not an escalation. Requested changes are the pipeline working: the
    // implementer owns the next move and `agent-implement-revise.yml` fires it
    // (RA-1077). Escalating would put `needs:human` and a comment on every PR the Reviewer
    // sends back — the majority of them — and a surface that cries about normal
    // progress is a surface the developer stops reading, which is the one thing this
    // design cannot afford.
    return skip('changes-requested', `${reviewer} requested changes on this commit — the implementer owns it`);
  }
  if (latestByReviewer.state !== 'APPROVED') {
    // the Merger reads the EVENT, never the prose: a verdict written in English is not a
    // mechanism, and the ruleset cannot read it either. Since RA-965 the Reviewer reviews
    // only after CI settles, so the reason he used to post a COMMENT is gone — which
    // makes this an anomaly rather than the normal case, and a re-dispatch the right
    // response to it.
    return recover('comment-verdict', `${reviewer}'s latest review on this commit is ${latestByReviewer.state}, not APPROVED — a re-review should convert it (RA-378)`);
  }

  // Every check that ran must have passed, and nothing may still be running —
  // EXCEPT the pipeline's own two agents.
  //
  // The Merger wakes on `pull_request_review`, which fires the moment the Reviewer SUBMITS.
  // The Review job then keeps running for its remaining steps, so `Review (Reviewer)`
  // is IN_PROGRESS at exactly the instant the Merger looks. Counting it would make
  // `checks-pending` fire on every single review event, pushing every merge onto the
  // hourly heartbeat while still reporting a healthy-looking "still running" — the
  // silent-degradation shape this pipeline keeps producing. The Merger's own check run
  // is excluded for the same reason: it cannot be a precondition of itself.
  //
  // The jobs that race him on that same event are excluded for the same reason (RA-1177,
  // `REVIEW_EVENT_CHECKS`). Every OTHER agent check — PR checks (which since RA-2597
  // carries the closing-references guard as well as the title taxonomy), Label guard,
  // a revise job that is actually revising — is a real guard on the merge and is
  // waited for.
  // The partition — the SELF_CHECKS exclusion, the supersede rule and the split — lives
  // in `checkPartition` above, so what counts as a check has exactly one definition.

  if (pending.length) return wait('checks-pending', `${pending.map((c) => c.name).join(', ')} still running`);
  // CANCELLED is called out separately from FAILURE because it means something
  // different: a run somebody stopped, or one a `concurrency:` group cancelled that
  // nothing re-ran (a re-run that concluded supersedes it in `checkPartition`), rather
  // than a defect. It is still a refusal —
  // a cancelled REQUIRED check leaves the ruleset unsatisfied — but naming it tells
  // the developer to re-run rather than to go looking for a defect that is not there.
  if (cancelled.length) {
    return stop('checks-cancelled', `${cancelled.map((c) => c.name).join(', ')} was cancelled and nothing re-ran it, so it never reported — re-run that check run (a fresh dispatch creates a new one and leaves this in the rollup)`);
  }
  if (failed.length) {
    return stop('checks-failed', `${failed.map((c) => `${c.name} (${c.conclusion})`).join(', ')}`);
  }

  // ── The closing set ───────────────────────────────────────────────────────
  // A PR that closes an issue its body never declared is how RA-918 and RA-897 were
  // closed by a merge that had nothing to do with them (RA-1013, RA-1045). The check
  // exists in CI as a required status; the Merger asks again rather than trusting that
  // it ran, because "the guard could not fail the build" is a defect this repo has
  // shipped twice (RA-1089, RA-1092).
  //
  // The analysis comes from `closing-refs.mjs` — the same module CI runs — rather
  // than a second implementation here. Two implementations of one rule drift, and
  // the drift is invisible until they disagree about a merge.
  //
  // `mergeClosesUndeclared` is the field, not `willCloseButNotDeclared`: merges are
  // SQUASHED, so the commit message is re-parsed as plain text and closes issues the
  // PR link never claimed. That is the arm that caught RA-918/RA-897, where
  // `closingIssuesReferences` read only `[1013]`.
  const undeclared = pr.closing?.mergeClosesUndeclared ?? [];
  if (undeclared.length) {
    return stop('undeclared-closes', `the squash commit closes #${undeclared.join(', #')}, which the body does not declare`);
  }
  // Ambiguous, never assumed benign: an empty closing set means "closes nothing" OR
  // "Issues could not be read", and conflating those is what inverts this check.
  if (pr.closing?.unverifiable) {
    return stop('closes-unverifiable', 'the closing set could not be read, so what this merge closes is unknown');
  }

  // ── The ruleset's own answer ──────────────────────────────────────────────
  // Last, and deliberately not first: if this disagrees with everything above,
  // the disagreement is the finding. `CLEAN` is the only state that merges.
  // `UNKNOWN` is GitHub still COMPUTING mergeability, not a verdict about it. Treating
  // it as a refusal put `needs:human` and a comment on a PR that was merely mid-flight
  // — the "surface that cries about normal progress" this file's own reasoning says the
  // design cannot afford. It is a wait: the sweep asks again, and by then it resolves.
  if (pr.mergeStateStatus === 'UNKNOWN') {
    return wait('merge-state-unknown', 'GitHub is still computing mergeability');
  }
  // ── THE CONVERSE HOLE RA-2154 LEFT OPEN (RA-2175) ─────────────────────────────
  // RA-2164 converted only the `never-started` arm above, on an instruction that was
  // right about not COLLAPSING `!== 'CLEAN'` into `conflictState` and wrong to imply
  // nothing was needed here. `never-started` is reachable only when NO check has run;
  // every path where CI has already run — the commoner one, and RA-1708's measured shape
  // — fell through to the line below, which asks `mergeStateStatus` alone. So on
  // `{ mergeStateStatus: 'CLEAN', mergeable: 'CONFLICTING' }`, the stale-field case
  // `conflict-state.mjs` pins as reachable, the Merger returned `merge`.
  //
  // WHAT THAT COSTS IS NOT ONE PR. `apply` calls `gh pr merge` through `execFileSync`,
  // so a 405 ("Pull Request is not mergeable") THROWS, and until RA-2175 the sweep loop
  // had no `try` — every PR after it went unconsidered on that tick, hourly, until a
  // human resolved the conflict. The loop is now guarded too; both halves are needed,
  // because a guard here does not stop the next unguarded call from ending a sweep.
  //
  // AFTER THE `UNKNOWN` WAIT, DELIBERATELY. `conflictState` resolves the split case
  // `{ mergeStateStatus: 'UNKNOWN', mergeable: 'CONFLICTING' }` to `conflicting`, and
  // placing this first would stamp `needs:human` and a comment on a PR GitHub has not
  // finished computing — exactly what the wait above exists to prevent, on the surface
  // this file insists must stay meaningful. Waiting costs one tick; the answer settles
  // into either `DIRTY` or stale-`CLEAN`, and both are caught below.
  //
  // NOT COLLAPSED INTO THE NEXT LINE, which is a different predicate: `!== 'CLEAN'`
  // also stops on `BLOCKED`, `BEHIND` and `UNSTABLE`, all of which `conflictState`
  // reports as `clear` by design. It keeps the same `merge-state` rule so the marker,
  // the escalation path and everything keyed on the rule name are unchanged.
  if (conflictState(pr) === 'conflicting') {
    // ── WHO OWNS A CONFLICTING PR (RA-2218) ───────────────────────────────────
    // Escalating one used to disable the only thing that fixes it. `apply()` turns
    // every `escalate` into `--add-label needs:human`, and `rebase-lane.mjs`'s
    // `ineligible()` refuses any PR carrying it — first in its ordered list. So
    // the Merger stamping a conflict switched off RA-2150's conflict lane, permanently:
    // `needs:human` is in `ESCALATE_LABELS`, so the quiet `escalating-label` arm
    // returns before every other gate and no later state change re-admits the PR.
    // Both lanes fire on the same `workflow_run: CI/main`, and the Merger's extra hourly
    // cron means he usually got there first.
    //
    // THE ARBITRATION IS DERIVED, AND IT NEEDS ONLY ONE FACT: has the lane tried?
    //   · not yet  → WAIT. `apply` does nothing at all on a `wait`, so the label stays
    //                clean and the lane stays eligible. It is not silence: the lane
    //                posts its own "Resolving this conflict" comment before its
    //                session, so RA-1147's requirement is met by the agent that is acting.
    //   · tried, and it still conflicts → escalate. That is the state a human genuinely
    //                owns, and without it a PR the lane cannot fix would wait forever.
    //   · unreadable → escalate. Fail toward telling a human: a stall nobody is told
    //                about is worse than an escalation that turns out to be early. This
    //                is why `rebaseAttempted` is three-state and not a boolean.
    //
    // NO "WOULD THE LANE TAKE IT?" CHECK, and that is a deletion rather than an
    // omission. One was written and removed as UNREACHABLE: every refusal in
    // `rebase-lane.mjs`'s `ineligible()` — not open, `needs:human`, foreign author,
    // draft, no pipeline label — is also a gate THIS function returns at, earlier.
    // `IMPLEMENTER_LABELS` is a subset of the lane's `PIPELINE_LABELS`, both use the
    // same implementer login, and `needs:human` returns at the sticky `escalating-label`
    // arm above. So a PR arriving here is one the lane accepts, by construction, and a
    // branch that cannot fire reads as protection while providing none.
    //
    // What keeps that true is a PARITY TEST rather than a runtime branch
    // (`tests/unit/merge-gate.test.ts`, "RA-2218"): if the two rule sets ever diverge so
    // that this function admits a PR the lane refuses, that PR would wait forever, and
    // the test is what makes the divergence red instead of silent.
    // `rebaseAttempted === false` already waited, ahead of every escalating gate (RA-2238).
    return stop('merge-state', `${CONFLICT_WHY}. \`agent-rebase.yml\` ${pr.rebaseAttempted === null ? 'may already have attempted this head — its comments could not be read, and an unread answer escalates rather than stalls' : 'has already attempted this head and it still conflicts'}`);
  }
  // ── `UNSTABLE` IS NOT ALWAYS A VERDICT EITHER (RA-1773, RA-1319) ─────────────────
  // It means a NON-required check is pending or failing — and every check this function
  // can see has already passed by the time this line runs. Twice that disagreement was a
  // race, not a finding: GitHub still counting a check that was starting, or a superseded
  // run the rollup no longer lists. Each became a terminal `needs:human` on a PR that went
  // CLEAN on its own (RA-1314 in 71 s; RA-1759 parked 9 hours). The `UNKNOWN` argument above
  // applies verbatim, so the same answer — but BOUNDED, because `UNSTABLE` also covers a
  // non-required check that has genuinely failed, and a wait with no end is the silent
  // shape this file refuses:
  //   · anything on the head still running, this pipeline's own checks included → wait
  //   · all settled, the last one inside `UNSTABLE_SETTLE_MS` → wait; the sweep re-asks
  //   · all settled for longer than that, or no timestamp to judge by → escalate as before
  // `BLOCKED` and `BEHIND` are untouched: neither is a check that has yet to settle.
  if (pr.mergeStateStatus === 'UNSTABLE') {
    const unsettled = pr.checks.filter((c) => c.status !== 'COMPLETED');
    if (unsettled.length) {
      return wait('merge-state-unsettled', `GitHub reports \`UNSTABLE\` while ${unsettled.map((c) => c.name).join(', ')} ${unsettled.length > 1 ? 'are' : 'is'} still running — a non-required check that has not settled is not a verdict about this PR (RA-1773)`);
    }
    const stamps = pr.checks.map((c) => Date.parse(c.completedAt ?? c.startedAt ?? '')).filter(Number.isFinite);
    const last = stamps.length ? Math.max(...stamps) : null;
    if (last !== null && now - last < UNSTABLE_SETTLE_MS) {
      return wait('merge-state-unsettled', `GitHub reports \`UNSTABLE\`, but every check on this head has settled green here — the last ${Math.max(0, Math.round((now - last) / 60000))} min ago, inside the ${UNSTABLE_SETTLE_MS / 60000}-min settle window — so asking again next sweep rather than escalating a rollup that has not caught up (RA-1319). Past the window it escalates`);
    }
  }
  if (pr.mergeStateStatus !== 'CLEAN') {
    return stop('merge-state', `GitHub reports \`${pr.mergeStateStatus}\`, not CLEAN — the ruleset is not satisfied`);
  }

  return { action: 'merge', rule: 'green-zone', quiet: false, why: `approved by ${reviewer} on \`${pr.headSha.slice(0, 7)}\`, all checks green, no escalating path or label` };
}

// ── THE CALLER ──────────────────────────────────────────────────────────────
// Everything below touches GitHub. Nothing below decides anything.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { analyse } from './closing-refs.mjs';
import { evidenceSha, readTrailer } from './review-trailer.mjs';
import { CONFLICT_JSON, CONFLICT_WHY, conflictState } from './conflict-state.mjs';
import { marker as rebaseMarker } from './rebase-lane.mjs';
import { appLogin } from './app-register.mjs';
import { escalatingPaths, readEscalationFileAt } from './lib/escalation-paths.mjs';
import { defaultBranchFile } from './lib/declarations.mjs';
import {
  ESCALATION_HEADER, REVIEW_EVENT_CHECKS, SELF_CHECKS, isEscalation, mergerMarker, mergerMarkerSpellings, mergerMarkersIn,
} from './lib/protocol-spellings.mjs';

const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', ...opts });

/**
 * Block for a moment without pulling in a scheduler. This runs in a one-shot CI step
 * that has already merged; there is nothing else for it to be doing, and an injectable
 * `sleep` keeps the retry loop testable without making the suite wait.
 */
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Gather one PR into the shape `mergeVerdict` expects.
 *
 * `opts` exists so a test can put a stubbed `gh` on PATH and assert the calls that are
 * actually made. Asserting on the source instead is what let the 100-file cap ship.
 */
export function readPr(number, repo, opts = {}) {
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', ...opts });
  const meta = JSON.parse(
    gh(['pr', 'view', String(number), '--repo', repo, '--json',
        `number,author,state,isDraft,labels,headRefOid,statusCheckRollup,title,body,closingIssuesReferences,commits,${CONFLICT_JSON}`]),
  );
  // NOT `gh pr view --json files`. That connection is hard-capped at `files(first: 100)`
  // with no pagination and no truncation signal, so on a PR of more than 100 files any
  // `drizzle/`, `src/db/`, `.github/` or payments/auth file sorting past position 100 is
  // invisible to the escalating paths — and `mergeVerdict` returns `merge` while still
  // reporting "no escalating path". The paginated REST endpoint is what
  // `agent-review.yml` already uses for the same list.
  //
  // Deliberately NOT wrapped in `|| true`: a failure here must THROW, because an empty
  // list disables every path rule. `mergeVerdict` refuses on an empty list too, so this
  // fails closed twice.
  const files = gh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--jq', '.[].filename'])
    .split('\n').map((f) => f.trim()).filter(Boolean);
  // `commit_id` per review, which `gh pr view --json reviews` does not expose — and
  // it is the whole point: an approval is evidence about ONE commit.
  const reviews = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}/reviews?per_page=100`]));
  // Runs attached to the head SHA, for the startup-failure rule above.
  //
  // THREE-STATE, like `rebaseAttempted` (RA-2256). `[]` is "listed, nothing failed"; `null`
  // is "could not list", and `mergeVerdict` waits on it. This used to be a `catch`
  // yielding `[]` — justified as "the same empty result a FORKED head produces", but a
  // forked head returns `[]` SUCCESSFULLY and never enters a `catch`. What the `catch`
  // covers is a 403, a rate limit, or a renamed flag or `--json` field, and it turned
  // every one of those into "no startup failure". The `files` read above throws and
  // `issuesReadable` is probed and carried; this was the one read in `readPr` whose
  // failure silently disabled its own rule.
  //
  // `--status failure` FILTERS SERVER-SIDE, measured on the recorded SHA `e6a35f69`: it
  // returns exactly the one startup-failure run of eleven. The predicate needs
  // `conclusion === 'failure'` anyway, so nothing it could fire on is filtered out — and
  // it removes the `--limit` truncation, which bit in the worst place: a startup failure
  // fires on PUSH, so it is the OLDEST run on the head and the first a newest-first cap
  // drops. (`--status startup_failure` is NOT an alternative; it returns `[]` on the real
  // run, which is why the predicate is the name shape.)
  let workflowRuns = null;
  try {
    const listed = JSON.parse(
      gh(['run', 'list', '--repo', repo, '--commit', meta.headRefOid, '--status', 'failure', '--limit', '100',
          '--json', 'name,conclusion']),
    );
    workflowRuns = Array.isArray(listed) ? listed : null;
  } catch (e) {
    console.log(`::warning title=merge-gate::#${number}: the Actions run listing could not be read, so this PR waits (runs-unreadable): ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}`);
    workflowRuns = null;
  }
  let issuesReadable = true;
  try {
    gh(['api', `repos/${repo}/issues?per_page=1`, '--jq', 'length'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    issuesReadable = false;
  }
  return {
    number: meta.number,
    author: meta.author?.login ?? '',
    state: meta.state,
    isDraft: meta.isDraft,
    labels: meta.labels.map((l) => l.name),
    files,
    headSha: meta.headRefOid,
    workflowRuns,
    // `body` is read for the TRAILER, not for prose (RA-1680/RA-1334). The reviewer job
    // stamps the SHA it checked out and the review ids it supersedes into the body it
    // just posted, so the decision below can ask what a verdict actually read and what
    // it deliberately replaced — neither of which `commit_id` can answer.
    reviews: reviews.map((r) => ({
      id: r.id,
      state: r.state,
      sha: r.commit_id,
      author: r.user?.login ?? '',
      ...readTrailer(r),
    })),
    checks: (meta.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? c.context,
      workflowName: c.workflowName,
      // Carried for the supersede rule (RA-1892). A `StatusContext` has `createdAt` and
      // no check-run id; a `CheckRun` has the other three. All are optional here —
      // `mergeVerdict` degrades to the CANCELLED-only rule when none survives.
      startedAt: c.startedAt ?? c.createdAt,
      completedAt: c.completedAt,
      databaseId: c.databaseId,
      // A StatusContext has `state` and no `status`; a CheckRun has both. Flattening
      // them here keeps the decision from having to know which kind it is looking at.
      status: c.status ?? 'COMPLETED',
      conclusion: c.conclusion ?? (c.state === 'SUCCESS' ? 'SUCCESS' : c.state ?? null),
    })),
    mergeStateStatus: meta.mergeStateStatus,
    // CARRIED ALONGSIDE, NOT INSTEAD (RA-2154). The `DIRTY` arm below is a question about
    // git and is now `conflictState`'s to answer; the ruleset arm at the end of
    // `decide()` is a different predicate — it requires `CLEAN` and stops on `BLOCKED`,
    // `BEHIND` and `UNSTABLE` too, all of which `conflictState` reports as `clear` by
    // design. Collapsing the two would make the Merger merge a PR the ruleset refuses.
    mergeable: meta.mergeable,
    closing: analyse({
      body: meta.body,
      title: meta.title,
      willClose: meta.closingIssuesReferences.map((r) => r.number),
      commitMessages: meta.commits.map((c) => `${c.messageHeadline}\n${c.messageBody ?? ''}`),
      issuesReadable,
    }),
    // HAS THE REBASE LANE ALREADY TRIED THIS HEAD? (RA-2218)
    //
    // ONLY ASKED OF A CONFLICTING PR, which is the whole reason this is affordable: it
    // is one extra `gh pr view --json comments` on a population measured at a handful of
    // PRs ever, not one per PR per sweep. Every other PR gets `false` without a read and
    // never reaches the branch that consults it.
    //
    // THREE-STATE, and the third is the point. `null` means the comments could not be
    // read, and `mergeVerdict` escalates on it — a stall nobody is told about is worse
    // than an escalation that turns out to be early. A boolean would have made an
    // unreadable answer indistinguishable from "not tried yet", which is the silent
    // direction this file spends most of its length refusing.
    rebaseAttempted: rebaseAttemptedOn(meta, repo, gh),
    // WHO APPLIED `needs:human`, AND WHAT THE MERGER SAID ABOUT IT (RA-2097, RA-2238). Read only
    // when the label is on, which is the only time `mergeVerdict` consults it.
    hold: meta.labels.some((l) => l.name === 'needs:human') ? holdOn(meta.number, repo, gh) : undefined,
  };
}

/**
 * Who last applied `needs:human`, and the (rule, head) of every escalation the Merger posted.
 *
 * `null` on ANY read failure — and `mergeVerdict` reads `null` as a person's hold, so an
 * unreadable answer keeps the label sticky rather than lifting it. Lifting is the
 * direction that can end in a merge, so it is the one that needs positive evidence.
 *
 * WHY THE ACTOR AND NOT ONLY THE MARKERS. A marker says the Merger escalated; it does not say
 * the label on the PR NOW is that escalation's. A person can remove it and re-apply it to
 * hold a PR on purpose, and the rebase lane's agent applies it for a product-decision
 * conflict — both leave the Merger's old markers in place. The last `labeled` event's actor
 * is what tells those apart. (A person who wants to hold a PR the Merger already labeled must
 * therefore re-apply the label: `ESCALATE_LABELS`' docblock says so.)
 *
 * @returns {{labeledBy: string, escalations: {rule: string, sha: string}[]}|null}
 */
function holdOn(number, repo, gh) {
  try {
    const labeledBy = gh(['api', `repos/${repo}/issues/${number}/events?per_page=100`, '--paginate', '--jq',
      '.[] | select(.event == "labeled" and .label.name == "needs:human") | .actor.login'])
      .split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
    const comments = gh(['api', `repos/${repo}/issues/${number}/comments?per_page=100`, '--paginate', '--jq',
      '.[] | {login: .user.login, body: .body} | @json'])
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const slug = (s) => String(s ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '');
    const escalations = comments
      .filter((c) => slug(c.login) === MERGER_LOGIN && isEscalation(c.body))
      .flatMap((c) => mergerMarkersIn(c.body));
    return { labeledBy, escalations };
  } catch {
    return null;
  }
}

/**
 * Whether `agent-rebase.yml` has already posted its attempt marker for this head.
 *
 * The marker is the lane's, not this file's — imported rather than re-spelled, so the
 * two cannot drift about what an attempt looks like. It is written by the WORKFLOW
 * before the agent session starts, so its presence means "tried", including a session
 * that then crashed; that is exactly the reading the Merger wants, since a crashed attempt
 * leaves a PR no less stuck.
 *
 * TAKES `readPr`'S OWN `gh`, not the module-level one. `readPr` is driven in tests by a
 * stubbed `gh` on PATH via `opts.env`, and a helper that reached past `opts` would be
 * unreachable from that harness — which is how the first version of this shipped with
 * the wiring untested: replacing the call with a hardcoded `false` passed the suite.
 *
 * @returns {boolean|null} null when the comments could not be read
 */
function rebaseAttemptedOn(meta, repo, gh) {
  if (conflictState({ mergeable: meta.mergeable, mergeStateStatus: meta.mergeStateStatus }) !== 'conflicting') {
    return false;
  }
  try {
    const body = gh(['pr', 'view', String(meta.number), '--repo', repo, '--json', 'comments',
      '--jq', '[.comments[].body] | join("\n")']);
    return body.includes(rebaseMarker(meta.headRefOid));
  } catch {
    return null;
  }
}

/**
 * ONE marker per (rule, head SHA). The heartbeat re-runs hourly and the review
 * trigger can fire several times on one commit, so without this an escalated PR
 * collects a comment an hour until someone looks at it — which trains the developer
 * to ignore exactly the surface this design uses to reach them.
 *
 * Keyed on the head SHA and not the PR, because a new commit is a new question: a
 * push that removes the `.github/` file SHOULD be re-evaluated and re-announced.
 */
const marker = mergerMarker;

// A marker in an old spelling (#53) says the same thing, so it counts as said.
const alreadySaid = (number, repo, rule, sha) => {
  try {
    const bodies = gh(['api', `repos/${repo}/issues/${number}/comments?per_page=100`, '--jq', '.[].body']);
    return mergerMarkerSpellings(rule, sha).some((m) => bodies.includes(m));
  } catch {
    // Fail LOUD, not silent: if the check cannot run, say the thing again rather
    // than swallowing an escalation nobody would ever see.
    return false;
  }
};

/**
 * DID THE MERGE ACTUALLY CLOSE WHAT IT SAID IT WOULD?
 *
 * MEASURED on RA-1057, the Merger's first real merge: the PR declared `Closes RA-1049`,
 * GitHub linked it, the merge succeeded — and RA-1049 stayed OPEN with no `closed`
 * event at all. The same PRs merged by a human do produce one, attributed to the
 * merger. GitHub performs the auto-close AS THE MERGING ACTOR, so it needs
 * `Issues: write`, which this App was deliberately not granted.
 *
 * The failure is silent in the worst way: the merge reports success and the issue
 * simply never closes. Every autonomous merge would leave its issue open, which
 * breaks the milestone burndown AND `lead-reconcile.mjs`'s phase detection, since
 * that counts open issues to decide what is done. A project would look permanently
 * unfinished while every PR in it had landed.
 *
 * So the side effect is CHECKED rather than trusted. If the permission is ever
 * dropped again, this says so on the PR instead of quietly rotting the burndown.
 */
export function verifyClosed(pr, repo, say, { retries = 3, waitMs = 4000, sleep = sleepSync } = {}) {
  const declared = pr.closing?.willClose ?? [];
  if (!declared.length) return;
  const stillOpen = () => declared.filter((n) => {
    try {
      // Only an explicit `closed` counts as closed. Testing for `=== 'open'` put every
      // OTHER answer — an empty body, an error string, a rate-limit page — on the
      // benign branch, which is the exact silent-absence shape this function exists to
      // catch. A read that failed must never read as "it worked".
      return gh(['api', `repos/${repo}/issues/${n}`, '--jq', '.state']).trim() !== 'closed';
    } catch {
      return true;
    }
  });

  // RE-READ BEFORE CRYING WOLF. `gh pr merge` returns once the merge commit exists;
  // GitHub performs the linked-issue close downstream in its push processing, so an
  // immediate read can catch a close that is merely LATE rather than absent. With the
  // scope correctly granted that produced `⚠️ did not close — grant the scope`, which
  // is a false alarm telling the developer to fix something already fixed, posted on
  // the one surface this design cannot afford to make noisy.
  //
  // A retry is the right shape rather than a longer single wait: the common case
  // returns on the first read and costs nothing, and only a genuine miss pays.
  let open = stillOpen();
  for (let i = 0; open.length && i < retries; i += 1) {
    sleep(waitMs);
    open = stillOpen();
  }

  if (!open.length) return say(`closed #${declared.join(', #')}`);
  say(`MERGED but #${open.join(', #')} did not close`);
  // GUARDED. This is the only call site that can throw AFTER a merge has happened, so
  // an unhandled failure here ends the tick with the merge done and nothing recorded —
  // the worst combination available. RA-1122 covers the loop; this site cannot wait for
  // it, because it is the one that reports the merge.
  try {
    gh(['pr', 'comment', String(pr.number), '--repo', repo, '--body', [
      `⚠️ **Merged, but #${open.join(', #')} did not close.**`,
      '',
      'GitHub performs the auto-close as the merging actor, so it needs `Issues: write`',
      "on this App's installation. Without it the merge succeeds and the issue silently",
      'stays open — which rots the milestone burndown and makes the reconciler read the',
      'project as unfinished.',
      '',
      'Close it by hand, and grant the scope so the next one closes itself.',
    ].join('\n')]);
  } catch (e) {
    say(`could not comment about the unclosed issue: ${e.message}`);
  }
}

export function apply(pr, verdict, repo, { dryRun = true } = {}) {
  const say = (msg) => console.log(`  ${dryRun ? 'would ' : ''}${msg}`);
  if (verdict.action === 'merge') {
    say(`merge #${pr.number} (squash)`);
    // NOT the default GITHUB_TOKEN. A merge pushed by it triggers NO workflows, so
    // release-please would never see the commit, no release PR would open, and
    // nothing would deploy — a silent break of the whole release chain. The workflow
    // hands this an App installation token, which does trigger them.
    if (dryRun) return;
    // Pinned to the head the verdict was computed on (RA-1177): the checks excluded as
    // review-event racers could still push a commit, and GitHub then refuses the merge
    // rather than squashing a head nobody reviewed.
    try {
      gh(['pr', 'merge', String(pr.number), '--repo', repo, '--squash', '--match-head-commit', pr.headSha]);
    } catch (e) {
      // The pin doing its job is a WAIT, not a failure: the head moved between the read
      // and the merge, and the next event re-evaluates the new head. Letting it throw
      // put the PR under "could not be considered" and failed the run red.
      if (/head branch was modified/i.test(`${e?.message ?? ''}${e?.stderr ?? ''}`)) {
        say(`not merging #${pr.number}: the head moved since \`${String(pr.headSha).slice(0, 7)}\` was read — the next event re-evaluates it`);
        return;
      }
      throw e;
    }
    verifyClosed(pr, repo, say);
    return;
  }
  if (verdict.action === 'escalate') {
    // A quiet escalation still refuses; it just does not announce itself again.
    if (verdict.quiet) return say(`escalated already, staying quiet on #${pr.number}: ${verdict.why}`);
    const mark = marker(verdict.rule, pr.headSha);
    if (alreadySaid(pr.number, repo, verdict.rule, pr.headSha)) {
      // THE MARKER DEDUPES THE COMMENT, NEVER THE LABEL. Returning before `--add-label`
      // meant a label that had been lifted (RA-2097/RA-2238) or removed stayed off while the
      // escalation it stood for still held on this very commit — refused every sweep, with
      // nothing on the PR saying so. `--add-label` is idempotent, so this is re-applied.
      say(`already escalated #${pr.number} on this commit`);
      if (!dryRun && !(pr.labels ?? []).includes('needs:human')) {
        gh(['pr', 'edit', String(pr.number), '--repo', repo, '--add-label', 'needs:human']);
      }
      return;
    }
    const body = [
      ESCALATION_HEADER,
      '',
      `Rule: \`${verdict.rule}\``,
      `Why: ${verdict.why}`,
      '',
      'This one is yours to decide. Nothing else in the pipeline will act on it.',
      '',
      mark,
    ].join('\n');
    say(`escalate #${pr.number}: ${verdict.rule}`);
    if (!dryRun) {
      gh(['pr', 'comment', String(pr.number), '--repo', repo, '--body', body]);
      gh(['pr', 'edit', String(pr.number), '--repo', repo, '--add-label', 'needs:human']);
    }
    return;
  }
  if (verdict.action === 'recover') {
    const mark = marker(verdict.rule, pr.headSha);
    if (alreadySaid(pr.number, repo, verdict.rule, pr.headSha)) return say(`already re-dispatched for #${pr.number} on this commit`);
    say(`re-dispatch the reviewer for #${pr.number}: ${verdict.rule}`);
    if (!dryRun) {
      gh(['workflow', 'run', 'agent-review.yml', '--repo', repo, '-f', `pr_number=${pr.number}`]);
      // The record IS the idempotence key, so it is written even though it is noise
      // on a healthy PR. A re-dispatch that leaves no trace re-fires every hour.
      gh(['pr', 'comment', String(pr.number), '--repo', repo, '--body',
          `🔁 the Merger asked ${'`agent-review.yml`'} to re-review this commit — ${verdict.why}\n\n${mark}`]);
    }
    return;
  }
  if (verdict.action === 'release') {
    // COMMENT FIRST, then lift. A lift that fails after the comment is retried next sweep
    // and the marker keeps it from saying so twice; a comment that fails after a lift
    // would leave the label gone with nothing on the PR saying why.
    const mark = marker(verdict.rule, pr.headSha);
    say(`lift needs:human on #${pr.number}: ${verdict.rule}`);
    if (!dryRun) {
      if (!alreadySaid(pr.number, repo, verdict.rule, pr.headSha)) {
        gh(['pr', 'comment', String(pr.number), '--repo', repo, '--body',
            `🔓 **the Merger — lifting \`needs:human\`.**\n\nRule: \`${verdict.rule}\`\nWhy: ${verdict.why}\n\nTo hold this PR on purpose, re-apply \`needs:human\` by hand — the Merger never lifts a label a person applied.\n\n${mark}`]);
      }
      gh(['pr', 'edit', String(pr.number), '--repo', repo, '--remove-label', 'needs:human']);
    }
    return;
  }
  say(`nothing to do (${verdict.action}: ${verdict.rule})`);
}

/** Rules that are NOT the Merger's to merge, and legitimately dominate every sweep.
 *  Folded into one bucket so the interesting reasons are not lost in them. */
const BENIGN_SKIPS = new Set(['not-the-implementer', 'not-open', 'draft']);

/** The skip distribution, for the step summary (RA-1201).
 *
 *  A SKIP IS INVISIBLE ON EVERY SURFACE A HUMAN READS: `skip()` sets `quiet`, so
 *  `apply` posts nothing on the PR, and the summary counted only merges and
 *  escalations. So a sweep that declined most of the open PRs on ONE wrong rule read
 *  exactly like a sweep with nothing to do.
 *
 *  Measured, in RA-1188: on the 2026-08-29 06:43 sweep, 9 of ~20 open PRs were skipped on
 *  the single `not-agent-implement` rule — several approved and CLEAN for days — and
 *  the summary said `merged: 0`, `waiting on you: 0`. The rule sat wrong for days
 *  because nothing distinguished that from healthy.
 *
 *  An individual skip is genuinely not a finding, which is what the comment at the loop
 *  says and it is right. The DISTRIBUTION is a finding, and that is the distinction the
 *  old summary could not express.
 *
 *  `not-the-implementer` / `not-open` / `draft` are the ones that legitimately dominate
 *  — most open PRs are not the Merger's — so they are folded into one line. A flat
 *  histogram would bury a spike under them, which is the noise failure the issue warns
 *  about: a summary nobody reads is the state being fixed. */
export function skipSummary(skips) {
  const total = [...skips.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  const benign = [...skips].filter(([r]) => BENIGN_SKIPS.has(r)).reduce((a, [, n]) => a + n, 0);
  const notable = [...skips].filter(([r]) => !BENIGN_SKIPS.has(r)).sort((a, b) => b[1] - a[1]);
  return [
    `- skipped: ${total}`,
    ...(benign ? [`  - not the Merger's to merge (not-the-implementer / not-open / draft): ${benign}`] : []),
    ...notable.map(([rule, n]) => `  - ${rule}: ${n}`),
  ];
}

/**
 * Consider every PR, and let none of them end the sweep (RA-2175).
 *
 * WHY THIS IS A FUNCTION AND NOT A `for` INSIDE `main`. Every call in a PR's body can
 * throw — `readPr` on an unreadable PR, `mergeVerdict` via `conflictState`'s
 * `ConflictFieldsUnread`, and `apply` on any `gh` non-zero, most sharply `gh pr merge`
 * returning 405 ("Pull Request is not mergeable"). Unguarded, the first such throw
 * propagated to `main().catch`, exited 1, and left EVERY LATER PR IN THE LIST
 * UNCONSIDERED — hourly, until a human resolved it, with a red run as the only signal
 * and nothing in it naming the PRs skipped as collateral.
 *
 * `main` shells out to `gh` for everything, so a guard written inside it is a guard no
 * test can reach. The loop takes `consider` as an argument for exactly that reason, and
 * the property worth testing — "a throw on one PR does not stop the next" — is then a
 * three-line test instead of an integration harness.
 *
 * IT COLLECTS RATHER THAN SWALLOWS. The caller re-throws once the sweep is done, so the
 * run is still red; a `try` that exited 0 would turn a broken sweep into a silent one.
 *
 * @param {string[]} numbers
 * @param {{consider: (n: string) => {action: string, rule: string}}} io
 */
export function sweep(numbers, { consider }) {
  let merged = 0;
  const escalated = [];
  const waiting = [];
  const released = [];
  const skips = new Map();
  const failed = [];
  for (const n of numbers ?? []) {
    try {
      const verdict = consider(n);
      if (verdict.action === 'merge') merged += 1;
      if (verdict.action === 'escalate') escalated.push(`#${n} — ${verdict.rule}`);
      if (verdict.action === 'wait') waiting.push(`#${n} — ${verdict.rule}`);
      if (verdict.action === 'release') released.push(`#${n} — ${verdict.rule}`);
      if (verdict.action === 'skip') skips.set(verdict.rule, (skips.get(verdict.rule) ?? 0) + 1);
    } catch (err) {
      const why = String(err?.stderr || err?.message || err).trim().slice(0, 300);
      console.log(`::error title=merge-gate::#${n} could not be considered: ${why}`);
      failed.push(`#${n} — ${why}`);
    }
  }
  return { merged, escalated, waiting, released, skips, failed };
}

/**
 * The step summary, as data (RA-1290) — pure, so what a reader sees is testable.
 *
 * A `WAIT` WAS THE ONE VERDICT NO SURFACE SHOWED. `apply` posts nothing for it, and the
 * summary counted merges, escalations and skips — so a PR parked on `checks-pending` by
 * a check run that never completes read, every hour, exactly like a healthy quiet sweep.
 *
 * NAMED, NOT COUNTED, for the reason RA-2175 gave for failures: a bare count is the
 * always-present line RA-1201 warns a reader learns to skip, and it cannot tell a PR that
 * is waiting for the first time from one that has waited all week. A PR number against a
 * rule, in run after run, is the finding — and one sweep's summary beside the last is
 * enough to see it without any state this stateless script would have to keep.
 *
 * @param {{considered: number, dryRun: boolean, merged: number, escalated: string[],
 *          waiting?: string[], released?: string[], failed?: string[], skips?: Map<string, number>}} s
 */
export function summaryLines({ considered, dryRun, merged, escalated, waiting = [], released = [], failed = [], skips = new Map() }) {
  return [
    '### The Merger', '',
    `Considered ${considered} PR(s)${dryRun ? ' — DRY RUN' : ''}.`, '',
    `- merged: ${merged}`,
    `- waiting on you: ${escalated.length}`,
    ...escalated.map((e) => `  - ${e}`),
    ...(waiting.length ? [`- waiting on the pipeline (re-checked next sweep; the same PR here run after run is stuck): ${waiting.length}`, ...waiting.map((w) => `  - ${w}`)] : []),
    ...(released.length ? [`- lifted a lapsed \`needs:human\`: ${released.length}`, ...released.map((r) => `  - ${r}`)] : []),
    // NAMED, NOT COUNTED (RA-2175). "1 failed" sends a reader to the whole log; the PR
    // number and the first line of the error send them to the one PR.
    ...(failed.length ? [`- could not be considered: ${failed.length}`, ...failed.map((f) => `  - ${f}`)] : []),
    ...skipSummary(skips),
  ];
}

/**
 * The escalating paths, from the escalation file on the repository's default branch
 * (`K-MERGE-17`, kanon#54). `run` is `gh`, injected so the reader is testable: a 404 on the
 * contents read is "the file doesn't exist there", and any other failure is a read failure.
 * Both throw `DeclarationError` by name, through `readEscalationFileAt`.
 * @param {string} repo
 * @param {(args: string[], opts?: object) => string} [run]
 */
export function readEscalations(repo, run = gh) {
  const { branch, read } = defaultBranchFile(repo, run);
  return escalatingPaths(readEscalationFileAt(branch, (path) => read(path)));
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('merge-gate: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const dryRun = !process.argv.includes('--apply');
  const i = process.argv.indexOf('--pr');
  const explicit = i > -1 ? [process.argv[i + 1]] : null;

  // THE ESCALATION FILE, FROM THE DEFAULT BRANCH (`K-MERGE-17`, kanon#54). Read once, before
  // any PR, and a missing or malformed file ends the run by name: a sweep with no path rules
  // would merge PRs that touch the project's high-risk paths.
  const escalations = readEscalations(repo);

  // No --pr: sweep every open PR. This is the heartbeat's mode, and it is what makes
  // a missed event recoverable rather than terminal — the failure this pipeline
  // produces over and over is a trigger that silently did not fire.
  const numbers = explicit ?? JSON.parse(
    gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number']),
  ).map((p) => String(p.number));

  const { merged, escalated, waiting, released, skips, failed } = sweep(numbers, {
    consider: (n) => {
      const pr = readPr(n, repo);
      const verdict = mergeVerdict(pr, { escalations });
      // Skips are the majority and are not findings. Printed at one line so a run is
      // still auditable, but never summarised as if something happened.
      console.log(`#${n} → ${verdict.action} (${verdict.rule}): ${verdict.why}`);
      apply(pr, verdict, repo, { dryRun });
      return verdict;
    },
  });

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = summaryLines({ considered: numbers.length, dryRun, merged, escalated, waiting, released, failed, skips });
    execFileSync('bash', ['-c', `cat >> "$GITHUB_STEP_SUMMARY"`], { input: lines.join('\n') + '\n' });
  }

  // RED AFTER THE SWEEP, not during it. Re-thrown so the run still fails — a caught
  // error that exits 0 is a broken sweep reported as a healthy one — but only once
  // every other PR has had its verdict.
  if (failed.length) {
    throw new Error(`${failed.length} PR(s) could not be considered: ${failed.join('; ')}`);
  }
}

// `process.argv[1]` is undefined when this module is imported by a test runner, and
// `pathToFileURL(undefined)` throws — which is how RA-1071 turned an import into a
// crash. Guarded, then guarded again in label-guard.mjs a day later.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
