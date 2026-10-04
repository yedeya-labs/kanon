#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0004 step 10; ADR 0009)
// RA-1036 — an agent workflow that is RED ON EVERY RUN must produce an escalation a
// human sees, without anyone thinking to run `gh run list`. Moved from the reference adopter
// into Kanon's library with the project digest lane, whose `health` job runs it (plan 0004,
// step 10).
//
// ── WHAT HAPPENED ───────────────────────────────────────────────────────────
// In the reference adopter, `agent-lead-reconcile.yml` exited 1 on its pre-filter step on EVERY run from the
// day RA-956 merged until RA-1032 was filed — 16 `failure`, 4 `cancelled`, 0 `success`,
// across scheduled ticks and both cascade triggers. Nothing escalated it. It was
// found only because merging the pilot brief produced no issues and someone went
// looking. Sixteen visible red runs in the Actions tab, for weeks.
//
// ── WHY NOTHING CAUGHT IT, AND WHY THIS IS NOT THE OVERSEER'S JOB ───────────
// The Overseer does read workflow history, but its prompt aims that at explorer and
// audit LIVENESS — "did a run happen", answered against the L1 store's `RUN#` rows.
// A workflow that runs on schedule and fails every time is LIVE by that measure.
// RA-915 covers the mirror case (a green run that acts on nothing) and RA-945 names the
// `silent-absence` class (a detector that finds nothing looking like health).
// Loud, repeated, unattended RED had no owner.
//
// It is also not something the failing workflow can report about itself: a job that
// dies on its first step has no later step to escalate from, which is exactly the
// shape of the motivating case.
//
// ── THE CLAIM THIS FALSIFIES ────────────────────────────────────────────────
// "A red run is the page, because GitHub's own workflow-failure notification carries it."
// It doesn't: the notification goes to the ACTOR of the run, and on a scheduled workflow
// nobody reads it. This is the missing half.
//
// ── WHAT COUNTS AS RED, AND WHAT DELIBERATELY DOES NOT ──────────────────────
// A `cancelled` run is not evidence of breakage — the reconciler alone shows four
// from concurrency-group races — and a `skipped` one is not evidence of health. Both
// are DROPPED rather than counted either way, and the verdict is taken over what is
// left. A naive "no success in the last K" would page on a healthy quiet workflow,
// which is the false positive that gets a detector muted.
//
// `--limit K` IS A TIME WINDOW IN DISGUISE (`lead-reconcile.mjs`'s `reviewRunsFor`
// says the same). For an hourly workflow K=12 is half a day; for an event-gated one
// it can be months. That is the right bias here: the question is "has this workflow
// succeeded RECENTLY", and recency in runs is what a per-workflow answer needs.
//
// ── COST ────────────────────────────────────────────────────────────────────
// No new schedule, no database, no cloud. It runs as a second job on the existing daily
// project digest tick: a check that needs no wake of its own rides an existing one. Its own
// job declares `actions: read`; the digest job's deliberate refusal of that scope is
// untouched, because permissions are per JOB.
//
// Usage: node "$KANON/scripts/workflow-health.mjs" [--apply], in the adopter's checkout, with
// GITHUB_REPOSITORY and a `gh` token in its environment.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = process.env.GITHUB_REPOSITORY;
const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';

/* ── TUNING VALUES ARE GUARDED, BECAUSE A TYPO IN ONE IS SILENT (RA-1908) ────────
 *
 * `Number(env || n)` handles the empty string but not a typo: `"12runs"`, `"three"`,
 * `"9d"` all yield NaN, and NaN does not throw — it makes a comparison `false` forever.
 * Every one of these three constants sits on the wrong side of such a comparison:
 *
 *   · MIN_DECISIVE — `decisive.length < NaN` is `false` for every n, so the `quiet`
 *     branch becomes UNREACHABLE and the all-red verdict is applied with no minimum at
 *     all. A workflow with a single `failure` in its window escalates as broken, which
 *     is exactly the false positive MIN_DECISIVE's own comment says gets a detector
 *     muted.
 *   · WINDOW — reaches `gh run list --limit`, and `renderFinding` puts it in front of a
 *     human as "their last NaN".
 *   · AUDIT_MAX_AGE_DAYS — `ageDays > NaN` is `false`, so the heartbeat reports `fresh`
 *     on a year-old audit, on every input (RA-1885 review, which is where this started).
 *
 * TWO GUARDS, NOT ONE, because the shapes genuinely differ: the counts are `--limit`
 * and a length comparison, so a fractional value is meaningless there, while a
 * fractional number of days is perfectly sensible (`7.5`). One permissive helper for
 * all three would have let `--limit 7.5` through, which is the hazard RA-1908 asked to
 * check for rather than assume away.
 *
 * ZERO AND NEGATIVES ARE REJECTED TOO, for the mirror reason: `MIN_DECISIVE=0` escalates
 * on a single red run and `QA_AUDIT_MAX_AGE_DAYS=0` escalates on every healthy week.
 * Muting a detector through noise and muting it through silence cost the same.
 */

/** A finite number > 0, or the fallback. Fractions allowed. */
export const positiveNumber = (raw, fallback) => {
  const n = Number(raw);
  return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** A whole number > 0, or the fallback — for counts and `--limit`. */
export const positiveInt = (raw, fallback) => {
  const n = positiveNumber(raw, fallback);
  return Number.isInteger(n) ? n : fallback;
};

/** How many recent runs to read per workflow. */
export const WINDOW = positiveInt(process.env.QA_HEALTH_WINDOW, 12);
/** How many DECISIVE runs must exist before an all-red verdict is allowed.
 *
 *  A workflow with one failed run is a failed run, not a broken workflow, and calling
 *  it broken is how a detector earns its way onto the muted list. Three is the smallest
 *  number that cannot be one bad afternoon on a daily workflow. */
export const MIN_DECISIVE = positiveInt(process.env.QA_HEALTH_MIN_DECISIVE, 3);

/**
 * The two constants are guarded individually and the defect is in their RELATION (RA-1914).
 *
 * `classifyWorkflow` compares `decisive.length` against `MIN_DECISIVE`, and `decisive`
 * can never exceed the `--limit WINDOW` the runs were read with. So a WELL-FORMED
 * `QA_HEALTH_MIN_DECISIVE` greater than `WINDOW` makes `decisive.length < minDecisive`
 * true for every workflow: every verdict becomes `quiet` and the red check is silently
 * off — the same "detector muted without anyone noticing" failure the guards above exist
 * to prevent, reached through values that pass every one of them.
 *
 * NOT A CLAMP, AND NOT A THROW — BUT A NON-ZERO EXIT (RA-2027). Clamping would silently
 * change a number an operator deliberately set. Throwing would lose the rest of the red
 * check (`runBoth` still runs the heartbeat after it, so the heartbeat was never the
 * cost). The real alternative was always `process.exitCode = 1`, which unwinds nothing,
 * and it is what the all-unreadable branch beside it already uses on the stated ground
 * that "a check that looked at nothing must not report a clean fleet". A check that
 * CANNOT RETURN RED is the same broken detector by that sentence's own logic, so it now
 * exits the same way — see `fleetGate`, which also stops it acting on the verdicts
 * (every one is `quiet`, so the close arm would otherwise close an open escalation).
 *
 * There is no self-escalation loop to fear: while the pair is incoherent this check
 * cannot call ANY workflow red, its own host included, and once it is fixed at most one
 * tick names the host's red runs, which is accurate.
 *
 * @returns the message, or null when the pair is coherent. Pure, so it is assertable.
 */
export const relationWarning = (window = WINDOW, minDecisive = MIN_DECISIVE) =>
  minDecisive > window
    ? `QA_HEALTH_MIN_DECISIVE (${minDecisive}) exceeds QA_HEALTH_WINDOW (${window}), so no workflow can ever reach the minimum and EVERY verdict will be "quiet" — the red check is effectively off. Lower it below the window.`
    : null;

/** Conclusions that are evidence either way. Everything else — `cancelled`, `skipped`,
 *  `action_required`, `neutral`, and `null` for a run still going — is dropped. */
const GOOD = new Set(['success']);
const BAD = new Set(['failure', 'timed_out', 'startup_failure']);

const warn = (m) => console.log(`::warning title=workflow-health::${m}`);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
const ghJson = (args) => JSON.parse(gh(args));

/** The marker that makes the escalation issue findable without a title match. */
export const HEALTH_MARKER = '<!-- qa:workflow-health';
/** The marker carries the red SET, not just the fact of a finding.
 *
 *  So "has anything changed since the last comment?" is an exact comparison rather
 *  than a prose diff. A daily comment restating the same red workflows would be the
 *  "one comment an hour" invisibility `hold()` is commented about, one cadence slower;
 *  a set that has GROWN is news and must not be suppressed with it. */
export const healthMarker = (files) => `${HEALTH_MARKER} red=${[...files].sort().join(',')} -->`;
/** The red set a previous body recorded, or null when there is no marker. */
export const redSetIn = (body) => {
  const m = /<!-- qa:workflow-health red=([^>]*)-->/.exec(body ?? '');
  return m ? m[1].trim().split(',').filter(Boolean) : null;
};
export const HEALTH_TITLE = '[pipeline] agent workflow(s) red on every recent run';

/**
 * One workflow's verdict.
 *
 * @param {string} file  e.g. `agent-lead-reconcile.yml`
 * @param {{conclusion: string|null, createdAt?: string, url?: string}[]|null|undefined} runs
 *   newest first, as `gh run list` returns them. `null` means the read FAILED.
 * @param {{minDecisive?: number}} [opts]
 * @returns {{file: string, status: 'red'|'ok'|'quiet'|'unreadable', decisive: number,
 *            failures: number, url: string|null}}
 */
export function classifyWorkflow(file, runs, { minDecisive = MIN_DECISIVE } = {}) {
  // UNREADABLE IS ITS OWN ANSWER, not health (RA-957's shape, and `classifyDeploy`'s
  // tri-state one file over). A detector that reads "cannot see" as "fine" is the
  // silent-absence class it exists to close.
  if (runs === null || runs === undefined) return { file, status: 'unreadable', decisive: 0, failures: 0, url: null };
  const decisive = runs.filter((r) => GOOD.has(r.conclusion) || BAD.has(r.conclusion));
  const failures = decisive.filter((r) => BAD.has(r.conclusion));
  if (decisive.length < minDecisive) {
    return { file, status: 'quiet', decisive: decisive.length, failures: failures.length, url: null };
  }
  const red = failures.length === decisive.length;
  return {
    file,
    status: red ? 'red' : 'ok',
    decisive: decisive.length,
    failures: failures.length,
    url: red ? (failures[0]?.url ?? null) : null,
  };
}

/**
 * May the red check act on this tick's verdicts at all? Pure, so both refusals are
 * assertable rather than living inside the untested `redCheck()`.
 *
 * Two states make the verdicts meaningless, and both are the silent-absence class: every
 * workflow unreadable (the check looked at nothing), and a MIN_DECISIVE above the WINDOW
 * (the check can return nothing but `quiet`). Both exit non-zero, and in both the
 * escalation issue is left exactly as it is — neither filed nor closed, because a close
 * would assert a recovery the check never observed.
 *
 * @param {ReturnType<typeof classifyWorkflow>[]} rows
 * @param {{relation?: string|null}} [opts]  `relationWarning()`'s result
 * @returns {{act: boolean, exitCode: 0|1, error: string|null}}
 */
export function fleetGate(rows, { relation = null } = {}) {
  if (relation) {
    return { act: false, exitCode: 1, error: `${relation} Not filing or closing anything this tick: every verdict below is "quiet" by construction.` };
  }
  if (rows.length > 0 && rows.every((r) => r.status === 'unreadable')) {
    return { act: false, exitCode: 1, error: 'could not read ANY workflow\'s runs. This job needs `actions: read`; without it the check reports a healthy fleet it never looked at.' };
  }
  return { act: true, exitCode: 0, error: null };
}

/**
 * Close the open escalation, or hold it? (RA-1675.) Pure, so the rule is assertable.
 *
 * The close comment is a claim that the workflows it named RECOVERED, so it may only be
 * made on evidence this tick actually read. `classifyWorkflow` already says unreadable is
 * its own answer, not health; this is the same rule applied to the close arm, which used
 * to key only on "nothing is red" — so one transient API failure on the read of the
 * workflow that WAS red closed the escalation, and the next good read filed a fresh one.
 *
 *  - **`unreadable` holds.** Any workflow the open issue names (`previousRed`, from its
 *    marker) whose history could not be read this tick keeps the issue open. A read that
 *    stays broken on every tick is not a way to pin it open forever unnoticed: the
 *    per-workflow `::warning` fires every tick, and the all-unreadable case exits non-zero.
 *  - **`quiet` counts as recovery,** deliberately. A workflow that was red and has since
 *    gone event-idle or been disabled has no failures left to report, and refusing to
 *    close on it would pin the issue open for as long as it stays idle — possibly forever,
 *    for a renamed-and-retired workflow. It is named separately in the close comment
 *    rather than folded into "succeeded again", so the comment claims nothing unread.
 *  - **A named workflow absent from the fleet** (deleted or renamed on disk) counts as
 *    gone, not as a hold, for the same reason.
 *  - **No marker** (`previousRed === null`, e.g. a hand-edited body) means the issue
 *    names nothing this can check, so nothing holds it. Holding on ANY unreadable row
 *    would pin it open on an unrelated flaky read, with only a green-run `::warning` to
 *    say so. The close comment then claims no named recovery either.
 *
 * @param {ReturnType<typeof classifyWorkflow>[]} rows  this tick's verdicts; none red
 * @param {string[]|null} previousRed  `redSetIn(existing.body)`
 * @returns {{close: boolean, held: string[], recovered: string[], quiet: string[], gone: string[]}}
 */
export function closeDecision(rows, previousRed) {
  const byFile = new Map(rows.map((r) => [r.file, r]));
  const named = previousRed ?? [];
  const held = named.filter((f) => byFile.get(f)?.status === 'unreadable');
  const recovered = named.filter((f) => byFile.get(f)?.status === 'ok');
  const quiet = named.filter((f) => byFile.get(f)?.status === 'quiet');
  const gone = previousRed ? named.filter((f) => !byFile.has(f)) : [];
  return { close: held.length === 0, held, recovered, quiet, gone };
}

/**
 * The red set the refreshed marker records (RA-1675, the refresh arm).
 *
 * A workflow the open issue names that is UNREADABLE this tick is carried forward,
 * not dropped. Otherwise a transient read failure on a.yml, while b.yml is still red,
 * rewrote the marker to [b.yml], and the close arm's hold was bypassed one tick later:
 * a.yml was never seen to recover, but it was no longer named. Pure, so it is assertable.
 *
 * @param {ReturnType<typeof classifyWorkflow>[]} rows
 * @param {string[]|null} previousRed
 * @returns {{red: string[], carried: string[]}}
 */
export function nextRedSet(rows, previousRed) {
  const red = rows.filter((r) => r.status === 'red').map((r) => r.file);
  const unreadable = new Set(rows.filter((r) => r.status === 'unreadable').map((r) => r.file));
  const carried = (previousRed ?? []).filter((f) => unreadable.has(f) && !red.includes(f));
  return { red: [...red, ...carried].sort(), carried: carried.sort() };
}

/** The comment a close posts: names what recovered, and never claims what was unread. */
export function renderClose({ recovered, quiet, gone }) {
  const list = (fs) => fs.map((f) => `\`${f}\``).join(', ');
  const parts = [];
  if (recovered.length) parts.push(`${list(recovered)} ${recovered.length === 1 ? 'has' : 'have'} a successful run in the recent window again.`);
  if (quiet.length) parts.push(`${list(quiet)} no longer ${quiet.length === 1 ? 'has' : 'have'} enough decisive runs to judge (idle or disabled). That is not a success, but it is no longer a red workflow either.`);
  if (gone.length) parts.push(`${list(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer in \`.github/workflows/\`.`);
  if (!parts.length) parts.push('No watched workflow is red any more.');
  return `${parts.join(' ')} Closing; the next daily check re-files if one goes red on every run again.`;
}

/**
 * The escalation body. Pure, so what a human reads is assertable.
 *
 * @param {ReturnType<typeof classifyWorkflow>[]} rows
 * @param {number} window
 * @param {{carried?: string[]}} [opts]  named workflows unreadable this tick (`nextRedSet`)
 */
export function renderFinding(rows, window = WINDOW, { carried = [] } = {}) {
  const red = rows.filter((r) => r.status === 'red');
  const unreadable = rows.filter((r) => r.status === 'unreadable' && !carried.includes(r.file));
  return [
    `The following workflow(s) have **no successful run** among their last ${window}, counting only runs that concluded \`success\` or \`failure\`/\`timed_out\`/\`startup_failure\`. A \`cancelled\` or \`skipped\` run is dropped rather than counted either way, so a quiet workflow cannot reach this list.`,
    '',
    '| workflow | failed | of decisive | most recent failure |',
    '|---|---|---|---|',
    ...red.map((r) => `| \`${r.file}\` | ${r.failures} | ${r.decisive} | ${r.url ? `[run](${r.url})` : '—'} |`),
    '',
    ...(carried.length
      ? [`Still named, but unreadable this tick, so not known to have recovered: ${carried.map((f) => `\`${f}\``).join(', ')}.`, '']
      : []),
    ...(unreadable.length
      ? [`Additionally, ${unreadable.length} workflow(s) could not be read at all: ${unreadable.map((r) => `\`${r.file}\``).join(', ')}. That is not evidence of health — see the run log.`, '']
      : []),
    'Why this is filed rather than left to the Actions tab: GitHub\'s own workflow-failure notification goes to the *actor* of the run, which on a scheduled workflow is nobody who reads it. A workflow can fail on **every** run for weeks, in plain sight, with nobody told.',
    '',
    'This issue is refreshed when the set of red workflows changes, and closed automatically once none of them is red any more — but never on a tick that could not read one of them.',
    '',
    healthMarker([...red.map((r) => r.file), ...carried]),
  ].join('\n');
}

/* ── THE WEEKLY AUDIT HEARTBEAT (RA-1877 finding 1) ──────────────────────────────
 *
 * A DIFFERENT SHAPE OF SILENCE FROM THE ONE ABOVE, and the red check cannot see it.
 *
 * In the reference adopter, `agent-overseer.yml` run 34125467510 (2026-09-07) concluded `failure` at its
 * "Reconcile the agent's exit with what it durably produced" step — correctly: the
 * agent died, no audit-summary issue was filed, and the step reds the job precisely
 * so that is visible. Nothing read it. The audit issue from the week before silently
 * aged to fourteen days and the pipeline's only weekly report card was simply missing,
 * indistinguishable from a quiet week, until a human went looking.
 *
 * ── WHY `classifyWorkflow` ABOVE IS STRUCTURALLY BLIND TO IT ──────────────────
 * `--limit K` IS A TIME WINDOW IN DISGUISE, and that bias cuts the other way here. For
 * an hourly workflow WINDOW=12 is half a day; for a WEEKLY one it is three months. One
 * red tick among eleven greens is `ok` by every threshold the red check has — and must
 * be, or a single bad afternoon would escalate. A missed weekly tick is not an all-red
 * workflow and never will be.
 *
 * The other two detectors are blind by construction too: the L1 store has no
 * `RUN#overseer` partition (only `RUN#explorer` / `RUN#audit`), so there is no
 * store-side absence to notice, and the Actions run log had already expired — HTTP 410
 * — by the time the NEXT weekly audit read for it. Any remedy that reads run logs is
 * therefore already too late by its own cadence, which is why this one reads none.
 *
 * ── THE OBSERVABLE, AND WHY IT IS AN ISSUE'S AGE ──────────────────────────────
 * The Overseer's whole durable output is one issue. So "how long since an audit landed"
 * is exactly the age of the most recent one, which is a fact that never expires — the
 * property the run logs lacked.
 *
 * READ `--state all`, NOT THE OPEN ONE. The rolling-audit pattern keeps roughly one
 * audit issue open, and the tempting version of this check ages *that*. It is the wrong
 * quantity: the human curating the audit — closing RA-1336 once its findings are filed —
 * would zero out the heartbeat, so the check would go quiet exactly when someone was
 * paying attention, and read "no open audit issue" as an escalation when it is the
 * normal end state of a well-run week. The newest audit issue's creation date is
 * immune to curation: nothing a human does to the backlog changes when the Overseer
 * last spoke.
 *
 * ── WHY NINE DAYS ────────────────────────────────────────────────────────────
 * A healthy gap is 7 (`cron: "0 7 * * 1"`). GitHub's scheduler is the reason the bound
 * is not 7-and-a-bit: a scheduled tick here drifts hours, not minutes — the 09-14 run
 * was queued for 07:00Z and started 13:27Z — and a `workflow_dispatch` re-run mid-week
 * legitimately resets the clock. Nine gives two full days of slack over the cadence and
 * still fires on the Thursday after a missed Monday, cutting the observed seven days of
 * invisibility to three. It must not fire on a healthy week even once: this check shares
 * an escalation surface with the red check, and a detector that cries wolf gets muted.
 *
 * NO NEW SCHEDULE, NO CLOUD, NO DATABASE. It is two `gh issue` reads on the daily
 * tick this script already rides, and it can only file or comment — never fix, never
 * close an audit.
 *
 * ── ONLY WHERE AN OVERSEER IS INSTALLED ──────────────────────────────────────
 * The Overseer is an optional lane (plan 0004, decision 12), and a repository without one
 * has no weekly audit to miss. Until its lane moves into Kanon (plan 0004 step 13, where the
 * adoption record says whether it is installed), the heartbeat reads that from the lane
 * callers on disk: an `agent-overseer.yml` among them (`OVERSEER_WORKFLOW`). Without one it
 * says so and asks nothing.
 */

/** The Overseer's caller, by the file name every lane caller takes (K-LAYOUT-18). */
export const OVERSEER_WORKFLOW = 'agent-overseer.yml';
/** Is there a weekly audit to expect? Pure, over `watchedWorkflows()`'s list. */
export const overseerInstalled = (files) => files.includes(OVERSEER_WORKFLOW);

/** Days since the last audit before the silence is news. See the arithmetic above. */
export const AUDIT_MAX_AGE_DAYS = positiveNumber(process.env.QA_AUDIT_MAX_AGE_DAYS, 9);
export const AUDIT_TITLE = '[pipeline] no Overseer audit has landed in over a week';
export const AUDIT_MARKER = '<!-- qa:audit-heartbeat';
/** The marker carries the audit issue the complaint is ABOUT, not its age.
 *
 *  Age changes every day, so a marker carrying it would make every daily tick a
 *  "something changed" comment — the once-a-day restatement `renderFinding`'s marker
 *  exists to prevent, and the fastest way to get the escalation ignored. The stale
 *  audit's number is stable until an audit actually lands, which is the only event
 *  worth saying anything new about. */
export const auditMarker = (number) => `${AUDIT_MARKER} latest=${number ?? 'none'} -->`;
export const auditIssueIn = (body) => {
  const m = /<!-- qa:audit-heartbeat latest=([^\s>]*)\s*-->/.exec(body ?? '');
  return m ? m[1] : null;
};

/**
 * How long the pipeline has been without a report card.
 *
 * @param {{number: number, createdAt: string, url?: string}[]|null|undefined} issues
 *   every audit-summary issue in any state. `null` means the READ failed.
 * @param {Date|string} now
 * @param {{maxAgeDays?: number}} [opts]
 * @returns {{status: 'fresh'|'stale'|'missing'|'unreadable', ageDays: number|null,
 *            number: number|null, createdAt: string|null, url: string|null}}
 */
export function classifyAudit(issues, now, { maxAgeDays = AUDIT_MAX_AGE_DAYS } = {}) {
  const none = { ageDays: null, number: null, createdAt: null, url: null };
  // UNREADABLE IS ITS OWN ANSWER (`classifyWorkflow`'s rule, and RA-957's shape). A
  // detector that reads "cannot see" as "fine" is the silent-absence class it closes.
  if (issues === null || issues === undefined) return { status: 'unreadable', ...none };
  // ZERO IS NOT SILENCE, IT IS A BROKEN QUERY. The heartbeat runs only where an Overseer is
  // installed, and the reference adopter's had filed eighteen of these when this was
  // written, so an empty answer far more likely means the label, the title or the search
  // changed under this check than that the Overseer has never run. Escalating says so; returning `fresh` would
  // be the detector quietly deciding its own blindness is health.
  if (issues.length === 0) return { status: 'missing', ...none };
  const newest = issues.reduce((a, b) => (new Date(a.createdAt) >= new Date(b.createdAt) ? a : b));
  const ageDays = (new Date(now).getTime() - new Date(newest.createdAt).getTime()) / 86_400_000;
  return {
    status: ageDays > maxAgeDays ? 'stale' : 'fresh',
    ageDays,
    number: newest.number,
    createdAt: newest.createdAt,
    url: newest.url ?? null,
  };
}

/**
 * The heartbeat escalation body. Pure, so what a human reads is assertable.
 *
 * @param {ReturnType<typeof classifyAudit>} verdict
 * @param {{maxAgeDays?: number}} [opts]
 */
export function renderAuditFinding(verdict, { maxAgeDays = AUDIT_MAX_AGE_DAYS } = {}) {
  const head =
    verdict.status === 'missing'
      ? [
          '**No Overseer audit-summary issue could be found at all.** This repository has an Overseer caller, so this is far more likely to mean the search in Kanon\'s `scripts/workflow-health.mjs` no longer matches how they are labelled or titled than that the Overseer has never run.',
          '',
          'Check the `agent:overseer` label and the `audit-summary` title convention before trusting any other line in this check.',
        ]
      : [
          `The most recent Overseer audit is **#${verdict.number}**, filed **${Math.floor(verdict.ageDays)} days ago** (${verdict.createdAt}). \`agent-overseer.yml\` runs weekly, so anything past ${maxAgeDays} days means at least one tick produced no audit.`,
          '',
          'Look at `agent-overseer.yml`\'s recent runs. A run that concluded `failure` at **"Reconcile the agent\'s exit with what it durably produced"** did exactly what it should — the agent died before filing and the step reds the job so it is visible. The bug this check closes is that *nothing read that red*.',
          '',
          '⚠️ **Read the run soon or the evidence is gone.** Actions run logs expire with the repository\'s log retention, often before the next weekly audit would look for them, and an expired log can\'t say why the run failed. Step-level job metadata (`gh run view <id> --json jobs`) outlives the logs and names the failing step, which is usually enough to classify it.',
        ];
  return [
    ...head,
    '',
    `Why an issue's age and not the workflow's run history: for a **weekly** workflow \`--limit 12\` is three months, so one red tick among eleven greens can never reach the "red on every recent run" verdict this script's other check applies — and must not, or a single bad afternoon would escalate. The audit issue's creation date is also the only evidence that does not expire.`,
    '',
    'This check reads `--state all` deliberately: closing an audit issue once its findings are filed is the normal end of a good week, and must not silence the heartbeat.',
    '',
    'This issue is refreshed only when a *different* audit becomes the newest one, and closed automatically once an audit lands inside the window.',
    '',
    auditMarker(verdict.number),
  ].join('\n');
}

/** Every workflow this checks: the whole `agent-*` family, its own host included.
 *
 *  READ FROM DISK, NOT FROM A LIST. A list of the lanes that run a model (the reference
 *  adopter's telemetry collector keeps one) is the wrong set here: it OMITS
 *  `agent-lead-reconcile.yml`, which is the workflow this check was written for. Every lane
 *  caller is named after its lane (K-LAYOUT-18), so the `agent-` prefix finds them all.
 *
 *  ITS OWN HOST IS IN THE SET, deliberately: the project digest's caller is
 *  `agent-project-digest.yml`, a lane caller like the rest. A detector visible only as its
 *  own exit code reproduces the bug it is meant to catch, so if the digest workflow goes red
 *  on every run, the next run that DOES work says so. That is partial by construction — a
 *  detector cannot report its own total failure — and it is stated rather than glossed.
 *  (In the reference adopter the host was `project-digest.yml`, and this named it too.) */
export function watchedWorkflows(dir = '.github/workflows') {
  return readdirSync(dir)
    .filter((f) => f.startsWith('agent-') && f.endsWith('.yml'))
    .sort();
}

/**
 * Run both checks, and let neither hide the other.
 *
 * BOTH, ALWAYS, AND THE HEARTBEAT LAST. The two answer unrelated questions about
 * unrelated evidence, so neither may short-circuit the other — the same reason the
 * `health` job carries no `needs:` on the digest.
 *
 * THE RED CHECK IS NOT EXCEPTION-SAFE, and the throwing path is the one taken exactly
 * when the fleet IS red: its `issue create` / `comment` / `edit` calls are outside any
 * `try` (only `openFinding()` has one), so a rate-limited or rejected write on a bad
 * afternoon would propagate out and the heartbeat would never run — with the job red for
 * the other reason, so nobody reads the absence. That is the silent-absence class this
 * whole file exists to close, one layer up (RA-1885 review).
 *
 * PURE AND EXPORTED so the claim is pinned by a test rather than asserted in a comment:
 * the previous version of this said "called unconditionally" with nothing holding it to
 * it. A throw from the heartbeat is deliberately NOT caught — it runs last, so there is
 * nothing left to protect, and swallowing it would hide a bug in the detector itself.
 *
 * @param {() => void} redCheckFn
 * @param {() => number} heartbeatFn
 * @param {(msg: string) => void} [log]
 * @returns {number} the exit code contribution — 1 if either half failed.
 */
export function runBoth(redCheckFn, heartbeatFn, log = console.log) {
  let code = 0;
  try {
    redCheckFn();
  } catch (err) {
    log(`::error title=workflow-health::the red-run check threw (${String(err?.message ?? err).split('\n')[0]}), so the fleet was not assessed. The audit heartbeat below still ran.`);
    code = 1;
  }
  return heartbeatFn() || code;
}

/* c8 ignore start */
function runsFor(file) {
  try {
    return ghJson(['run', 'list', '--repo', REPO, '--workflow', file,
      '--limit', String(WINDOW), '--json', 'conclusion,createdAt,url']);
  } catch (err) {
    warn(`could not read runs for ${file}: ${err.message.split('\n')[0]}`);
    return null;
  }
}

/** The open escalation issue, or null.
 *
 *  NARROWED BY TITLE, DECIDED BY MARKER — the "search then re-filter exactly" idiom
 *  `agent-verify-acs.yml` already uses, because GitHub search is tokenised and fuzzy
 *  while the marker is not. The search term is deliberately the title phrase rather
 *  than the marker: `scripts/label-guard.mjs` reads any quoted `qa:<word>` literal
 *  as a label this pipeline applies, so searching for the marker text made the guard
 *  demand a repo label named `qa:workflow-health` that does not and should not exist.
 *  (Caught by that guard on this PR's first CI run, which is the guard working.) */
function openFinding() {
  const hits = ghJson(['issue', 'list', '--repo', REPO, '--state', 'open',
    '--label', 'pipeline-improvement', '--search', 'in:title "red on every recent run"',
    '--limit', '50', '--json', 'number,body']);
  return hits.find((i) => (i.body ?? '').includes(HEALTH_MARKER)) ?? null;
}

/** Every Overseer audit-summary issue, in ANY state. `null` when the read failed.
 *
 *  NARROWED BY LABEL AND TITLE, `--state all` (see `classifyAudit`). `agent:overseer`
 *  is the Overseer's own filing label and `audit-summary` its title convention; both
 *  are asserted rather than assumed, because `classifyAudit` escalates an empty answer
 *  instead of reading it as health. */
function auditIssues() {
  try {
    return ghJson(['issue', 'list', '--repo', REPO, '--state', 'all',
      '--label', 'agent:overseer', '--search', 'in:title "audit-summary"',
      '--limit', '30', '--json', 'number,createdAt,url']);
  } catch (err) {
    warn(`could not read the Overseer's audit issues: ${err.message.split('\n')[0]}`);
    return null;
  }
}

/** The open heartbeat escalation, or null. Same search-then-filter-on-marker idiom as
 *  `openFinding` — GitHub search is tokenised and fuzzy; the marker is not. */
function openAuditFinding() {
  const hits = ghJson(['issue', 'list', '--repo', REPO, '--state', 'open',
    '--label', 'pipeline-improvement', '--search', 'in:title "no Overseer audit has landed"',
    '--limit', '50', '--json', 'number,body']);
  return hits.find((i) => (i.body ?? '').includes(AUDIT_MARKER)) ?? null;
}

/**
 * The heartbeat half of this script. Returns an exit code contribution.
 *
 * Kept separate from the red check, and called unconditionally, so the two cannot hide
 * each other: an unreadable run history must not stop the audit-age question being
 * asked, which is the whole point of a check whose evidence does not expire.
 */
function auditHeartbeat() {
  if (!overseerInstalled(watchedWorkflows())) {
    console.log(`audit heartbeat: skipped — no \`${OVERSEER_WORKFLOW}\` in .github/workflows, so there is no weekly audit to expect.`);
    return 0;
  }
  const verdict = classifyAudit(auditIssues(), new Date());
  console.log(`audit heartbeat: ${verdict.status}` +
    (verdict.number ? ` — newest is #${verdict.number}, ${verdict.ageDays.toFixed(1)}d old` : ''));

  // FAIL CLOSED on an unreadable read — the same rule `openFinding`'s catch applies.
  // This job holds `issues: write`, so a failure here is a broken detector, not a
  // permissions gap to shrug at.
  if (verdict.status === 'unreadable') {
    console.log('::error title=audit-heartbeat::could not read the Overseer\'s audit issues at all, so "has an audit landed recently" was never answered. That is not evidence of health.');
    return 1;
  }

  if (!APPLY) {
    console.log(verdict.status === 'fresh'
      ? 'Audit heartbeat healthy (dry run).'
      : `Audit heartbeat would escalate: ${verdict.status} (dry run).`);
    return 0;
  }

  let existing;
  try {
    existing = openAuditFinding();
  } catch (err) {
    console.log(`::error title=audit-heartbeat::could not search for an existing heartbeat escalation (${err.message.split('\n')[0]}) — refusing to file a possible duplicate.`);
    return 1;
  }

  if (verdict.status === 'fresh') {
    if (existing) {
      gh(['issue', 'close', String(existing.number), '--repo', REPO, '--comment',
        `An Overseer audit landed again (#${verdict.number}, ${Math.floor(verdict.ageDays)} days old). Closing; the next daily check re-files if the weekly audit stops arriving.`]);
      console.log(`closed #${existing.number} — the audit cadence recovered`);
    }
    return 0;
  }

  const body = renderAuditFinding(verdict);
  if (!existing) {
    // ONE CALL, `--label` AND `--milestone` together (K-WORK-2) — a bare create races
    // the default-milestone backstop. Pipeline work goes to the platform bucket (K-WORK-4).
    const url = gh(['issue', 'create', '--repo', REPO, '--title', AUDIT_TITLE,
      '--body', body, '--label', 'pipeline-improvement',
      '--milestone', 'Development Automation']).trim();
    console.log(`filed: ${url}`);
    return 0;
  }
  // REFRESHED ONLY WHEN A DIFFERENT AUDIT IS THE NEWEST ONE. The age grows every day
  // and commenting on that daily is how an escalation stops being read.
  const was = auditIssueIn(existing.body);
  const now = String(verdict.number ?? 'none');
  if (was === now) {
    console.log(`#${existing.number} already names audit ${now} — saying nothing.`);
    return 0;
  }
  gh(['issue', 'comment', String(existing.number), '--repo', REPO, '--body',
    `The newest Overseer audit changed and the cadence is still broken.\n\n${body}`]);
  gh(['issue', 'edit', String(existing.number), '--repo', REPO, '--body', body]);
  console.log(`refreshed #${existing.number}`);
  return 0;
}

/** The "red on every recent run" half (RA-1036). */
function redCheck() {
  const files = watchedWorkflows();
  const rows = files.map((f) => classifyWorkflow(f, runsFor(f)));
  const red = rows.filter((r) => r.status === 'red');

  const summary = [
    `## Workflow health — ${files.length} workflow(s), last ${WINDOW} runs each\n`,
    '| workflow | verdict | failed / decisive |',
    '|---|---|---|',
    ...rows.map((r) => `| \`${r.file}\` | ${r.status} | ${r.failures}/${r.decisive} |`),
    '',
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    execFileSync('bash', ['-c', 'cat >> "$GITHUB_STEP_SUMMARY"'], { input: `${summary}\n` });
  }

  // EVERY WORKFLOW UNREADABLE, OR A CHECK THAT CANNOT RETURN RED, IS A BROKEN
  // DETECTOR, not a clean fleet — the same fail-closed rule the Overseer's outcome
  // reconciliation applies to its own read. `fleetGate` decides; it is pure and tested.
  const gate = fleetGate(rows, { relation: relationWarning() });
  if (!gate.act) {
    console.log(`::error title=workflow-health::${gate.error}`);
    process.exitCode = gate.exitCode;
    return;
  }

  if (!APPLY) {
    console.log(red.length ? `${red.length} workflow(s) would be escalated (dry run).` : 'Nothing to escalate.');
    return;
  }

  let existing;
  try {
    existing = openFinding();
  } catch (err) {
    console.log(`::error title=workflow-health::could not search for an existing escalation (${err.message.split('\n')[0]}) — refusing to file a possible duplicate.`);
    process.exitCode = 1;
    return;
  }

  if (!red.length) {
    if (existing) {
      // CLOSE ONLY ON EVIDENCE THIS TICK READ (RA-1675) — `closeDecision` holds the issue
      // open while any workflow it names was unreadable.
      const decision = closeDecision(rows, redSetIn(existing.body));
      if (!decision.close) {
        warn(`not closing #${existing.number}: ${decision.held.join(', ')} could not be read this tick, so its recovery was never observed. Saying nothing on the issue.`);
        return;
      }
      gh(['issue', 'close', String(existing.number), '--repo', REPO, '--comment', renderClose(decision)]);
      console.log(`closed #${existing.number} — the fleet recovered`);
    }
    return;
  }

  const next = nextRedSet(rows, existing ? redSetIn(existing.body) : null);
  const body = renderFinding(rows, WINDOW, { carried: next.carried });
  if (!existing) {
    // ONE CALL, `--label` AND `--milestone` together (K-WORK-2): a bare create races
    // the default-milestone backstop, and a wrong milestone is harder to spot than a
    // missing one. Pipeline work goes to the platform bucket (K-WORK-4).
    const url = gh(['issue', 'create', '--repo', REPO, '--title', HEALTH_TITLE,
      '--body', body, '--label', 'pipeline-improvement',
      '--milestone', 'Development Automation']).trim();
    console.log(`filed: ${url}`);
    return;
  }
  // REFRESHED ONLY WHEN THE SET CHANGES. A daily comment restating the same red
  // workflows is the "one comment an hour" invisibility `hold()` is commented about,
  // one cadence slower.
  const was = redSetIn(existing.body);
  const now = next.red;
  if (was && was.join(',') === now.join(',')) {
    console.log(`#${existing.number} already names exactly ${now.join(', ')} — saying nothing.`);
    return;
  }
  gh(['issue', 'comment', String(existing.number), '--repo', REPO, '--body',
    `The set of red workflows changed.\n\n${body}`]);
  gh(['issue', 'edit', String(existing.number), '--repo', REPO, '--body', body]);
  console.log(`refreshed #${existing.number}`);
}

function main() {
  if (!REPO) {
    console.error('workflow-health: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const code = runBoth(redCheck, auditHeartbeat);
  if (code) process.exitCode = code;
}

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (IS_CLI) main();
/* c8 ignore stop */
