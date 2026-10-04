#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-955 — the Lead, MODE: reconcile. Drive an approved brief to done.
//
// A brief (RA-951) plans a project. This is what makes it ASSIGNED rather than
// planned: it files the issues the brief proposes, then labels them for the
// implementer one at a time, in the brief's order, until they are all closed.
//
// ── STATE IS DERIVED, NEVER STORED (docs/agentic-lead-engineer.md §5.2) ──────
// Every tick reconstructs the world from GitHub — the brief on `main`, the issues
// that reference the tracking issue, their PRs, their merge state — and asks one
// question: what is the next legal action? There is no checkpoint to corrupt and
// no resume logic, so a tick that dies mid-flight costs nothing but a tick.
//
// The consequence worth stating: a tick is IDEMPOTENT by construction. Running it
// twice in a row does nothing the second time, because the world it reads already
// contains the first run's effect.
//
// ── WHAT IT MUST NOT DO ─────────────────────────────────────────────────────
// It never merges (that is the Merger, a different identity, §2). It never promotes a
// `[seed]` invariant — that transition is outside the green zone (§3) and is
// proposed as its own PR in phase 5 for a human to merge. And it files only what
// the brief proposes: an issue the brief did not name is a new mandate, not a
// tick action.
//
// Usage: node scripts/lead-reconcile.mjs --project <tracking-issue> [--apply]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { reviewAttempts, reviewRunsFor as readReviewRuns, whyNoChurn } from './review-run-evidence.mjs';
import { churnBoundary, reviseDeliveries, startedAfter } from './revise-run-evidence.mjs';
import { NO_RETRY_EVIDENCE, RETRY_COOL_DOWN_HOURS, describeRetry, makeRetryEvidenceReader, retryDecision } from './lane-retry.mjs';
import { evidenceSha, readTrailer } from './review-trailer.mjs';
import { CONFLICT_JSON, CONFLICT_WHY, ConflictFieldsUnread, blocksChurn, conflictState } from './conflict-state.mjs';
// ONE DEFINITION OF "PARKED ON A HUMAN", IMPORTED (RA-2038). The dispatch sweep owns
// this state machine, and `awaiting-human` is its FALLBACK arm: the last non-sweep
// comment is a bot's and is older than `QA_SWEEP_STALE_HOURS` (48). That is broader
// than "the agent asked a question or bailed" — it also covers an implementer that
// commented and then crashed or was capped, and a thread whose last word is another
// bot entirely. The breadth is correct for THIS caller: every one of those means no
// agent is running, which is the only property a quota cap needs, and the 48h window
// is what protects a run still in progress.
//
// ⚠️ It reads NO bail prose, deliberately — `dispatch-sweep.mjs` says a brittle
// keyword match on the agent's text "would be worse than useless". So this does not
// encode the three bail-reading traps the project-progress skill describes (the LAST
// bail decides; a bail never clears a bail; `updatedAt` is not the wait); those are
// for a human reading the thread. Writing a second detector here that DID read prose
// would be free to disagree with the one that decides re-dispatches.
import { STALE_HOURS, classify as classifyLane, makeCommentsReader } from './dispatch-sweep.mjs';
// `qa:needs-split` (RA-1781): an item whose implementer run hit its cap, awaiting the Lead's
// split PR. Never dispatched; does not park the project — see `split-lineage.mjs`.
import { SPLIT_LABEL, SPLIT_WORKFLOW, splitBranches } from './split-lineage.mjs';
import { adoptedNote, adoptedNotes } from './lib/protocol-spellings.mjs';
// THE BRIEF GRAMMAR AND THE CLOSURE RULE live in `project-closure.mjs`, shared with the
// project digest so the two cannot disagree about what a project owes. Re-exported, so
// every caller that imported them from here still does.
import {
  VERIFY, briefIssues, carriedOut, declaresMembership, dependsField, gatesClosure, inDecomposition, isPhase5Finding,
  isProjectWork, itemSatisfied, openGatingWork, parseProposed, satisfiedTitles,
  FINDING_ANCHOR, GATING_SEVERITIES, SPEC_FINDING,
} from './project-closure.mjs';
import { appLogin } from './app-register.mjs';
import { declaredEnvironmentFrom, readReferenceDeployFrom } from './lib/reference-deploy.mjs';
export {
  VERIFY, briefIssues, carriedOut, declaresMembership, dependsField, gatesClosure, inDecomposition, isPhase5Finding,
  isProjectWork, itemSatisfied, openGatingWork, parseProposed, satisfiedTitles,
  FINDING_ANCHOR, GATING_SEVERITIES, SPEC_FINDING,
};

const REPO = process.env.GITHUB_REPOSITORY;
const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

// This caps concurrent implementers, which caps the event rate, which caps
// everything downstream — and it is a QUOTA control as much as a quality one, since
// each dispatch is a full Implementer run.
//
// 1 for the pilot, 3 once the Merger merges (RA-965). At 1 the cap is not a throughput
// limit but a SERIALISATION: one issue that stops moving stops the project, and
// with an autonomous merger the ways an issue stops multiply — the Merger escalates
// anything touching the pipeline, payments, auth, the schema or infrastructure, and
// those wait on a person who is checking in every couple of days by design. A
// project whose second issue is escalated should still build its third.
//
// 3 rather than higher because the ceiling is the Implementer quota, not correctness, and
// because the brief's dependency order still serialises whatever genuinely depends
// on something. Raise it with QA_LEAD_WIP; nothing else reads this value.
//
// THE UNDERLYING IMPRECISION THIS PARAGRAPH PREDICTED IS NOW FIXED (RA-2038). It read:
// "an escalated issue still occupies a slot even though no implementer is working on
// it, so 3 escalations halt a project exactly as 1 used to. Counting only issues an
// implementer can still act on is the real fix." That is what `occupiesSlot` does —
// an issue parked on a human no longer counts against this cap or the shared one,
// and is still never re-dispatched. "Parked" is the dispatch sweep's own verdict —
// `awaiting-human` or `human-held` (RA-2108) — or the `qa:needs-info` label; it is
// NOT a reading of the agent's bail prose, which nothing here does (RA-2110).
// Measured on the 2026-09-18 tick: all three shared slots were held by issues that
// could not produce a PR, and project RA-1292 was handed nothing.
export const WIP_DEFAULT = Number(process.env.QA_LEAD_WIP || 3);

/** The cap on in-flight implementer issues across ALL projects a tick reconciles.
 *
 *  WIP IS PER-PROJECT AND THAT IS CORRECT; THIS IS THE OTHER HALF (RA-1447). `wip`
 *  answers "how many of THIS project's issues may be in flight", which is a statement
 *  about the brief's dependency order. Once a tick reconciles every open project
 *  rather than only the lowest-numbered one, that question stops bounding the total:
 *  three projects at `wip: 3` is nine concurrent implementer runs, and the ceiling
 *  the Implementer actually has is quota, not correctness — a usage cap was hit on
 *  2026-09-02 and it fails a review at zero cost and one turn, indistinguishable
 *  from a crash without reading the result JSON.
 *
 *  DEFAULTS TO `WIP_DEFAULT`, so at one open project nothing changes at all — the
 *  global cap and the per-project cap are the same number and bind identically. It
 *  only starts doing work the moment a second project is reconciled, which is
 *  exactly when it is needed. */
export const GLOBAL_WIP_DEFAULT = Number(process.env.QA_LEAD_GLOBAL_WIP || WIP_DEFAULT);

const IMPLEMENT = 'agent:implement';
const NEEDS_INFO = 'qa:needs-info';
/**
 * A HUMAN OWES THIS ONE ITEM AN ACTION, AND THE REST OF THE PROJECT PROCEEDS (RA-1301).
 *
 * `qa:needs-info` / `blocked` mean "a human owes an ANSWER before the PROJECT can
 * proceed" and park every issue in it (`phaseOf` → `blocked`) — correctly, which is why
 * that meaning stays. What had no vocabulary was an item whose deliverable is not a PR at
 * all: a console action in another AWS account, evidence in a comment. RA-1291's Issues G
 * and H are the worked example, and its brief's only option was to label them ordinarily
 * and accept a wasted implementer dispatch by design.
 *
 * This label is that second vocabulary. An issue carrying it is NEVER dispatched, never
 * occupies a WIP slot, and does NOT feed `blocked`. It stays in `open`, so the project
 * waits in `reconcile` until a human closes it — the wait moves to the one place it
 * belongs, and the tick says so by name rather than as a bare "held". Closing it without
 * a PR is fine for phase 4: `closingMergeShas` contributes nothing for it and the walk
 * runs on the other members' merges.
 */
export const HUMAN_ACTION = 'qa:human-action';
/** Phase 5's issue title, written in ONE place.
 *
 *  It is a template, not a name — `nextActions` proposes it and `readWorld` recovers by
 *  it (RA-1286), and two hand-kept copies of a string those two must agree on is the drift
 *  this file has already paid for four times.
 *
 *  IT NAMES THE DECLARED REFERENCE ENVIRONMENT (kanon#199, `K-PROJ-11`), or "the reference
 *  environment" when the verdict carries none. It used to say `staging` on every adopter,
 *  so the recovery below matches the title whatever environment it names: a QA issue filed
 *  before this change, or before the adopter renamed its environment, is still found. */
export const qaIssueTitle = (project, environment) =>
  `Verify project #${project} on ${environment || 'the reference environment'} — every acceptance criterion, per ID`;

/** Is `title` this project's phase-5 title, naming any environment? (kanon#199) */
export const isQaIssueTitle = (title, project) => {
  const [before, after] = qaIssueTitle(project, '\u0000').split('\u0000');
  return typeof title === 'string' && title.length > before.length + after.length
    && title.startsWith(before) && title.endsWith(after);
};

/** The reference environment, as an adopter-facing text names it (kanon#199): the declared
 *  name in backticks, or a description when the verdict carries none. */
const envName = (environment) => (environment ? `\`${environment}\`` : 'the reference environment');
/** A phrase only the Lead's phase-5 issue body carries — the `gh workflow run` snippet it
 *  prints for a human. The second half of the recovery anchor below. */
const QA_BODY_ANCHOR = 'agent-verify-acs.yml';
const REVIEW_PLEASE = 'review:please';
const REVISE = 'agent:revise';
// The escalation label, on the TRACKING issue rather than a member issue.
//
// IS THIS A CHECKPOINT? RA-963 asks it, and it is the right question to ask of a design
// whose first paragraph is "state is derived, never stored". The answer is no, on the
// same grounds that `agent:implement` is not: the tick already writes that label and
// reads it back next tick to compute WIP. GitHub IS the store — the rule forbids a
// checkpoint FILE the tick alone can see and corrupt, not derived state that lives
// where a human can read and clear it. A label satisfies the property this needs and a
// file does not: `needs:human` on the tracking issue is visible in `gh issue list` and
// on the board, which is RA-963's actual constraint — "a project that cannot make
// progress must become visible without someone reading Actions annotations".
const HELD = 'needs:human';
const HELD_MARKER = '<!-- qa:lead-held -->';
// On the retro, so a later tick can tell "never closed" from "closed and reopened"
// (RA-1062). The retro's heading is not a marker — a human quoting it would be read as
// one, which is the mistake RA-1066 absorbed three documents into.
const RETRO_MARKER = '<!-- qa:lead-retro -->';
/** The Explorer's login — the register's `Explorer` row (RA-2701). Exported so the login it
 *  compares is observable without reading this file's source. */
export const EXPLORER_LOGIN = appLogin('Explorer');
const QA_MARKER = '<!-- qa:verified -->';

/** A secret must never reach a public issue comment (RA-1284).
 *
 *  `gh` echoes the URL it called on some auth failures, and an installation token can
 *  ride in it as `x-access-token:<token>@`. `hold()` writes its reasons onto the
 *  TRACKING ISSUE, which is public, so anything appended to an error message is
 *  published. Redacted by SHAPE rather than by a list of the tokens we happen to know:
 *  every GitHub token type shares the `gh<letter>_` prefix, and basic-auth credentials
 *  in a URL are recognisable without knowing what they are.
 *
 *  The body class is `[A-Za-z0-9._-]`, not `[A-Za-z0-9]`, and the extra three characters
 *  are load-bearing (RA-1945). GitHub is replacing the opaque installation token with a
 *  STATELESS one: still `ghs_`-prefixed, but a ~520-character JWT with two dots and
 *  base64url `-`/`_` in its segments. Against the narrow class the match stopped at the
 *  first dot and published the payload and part of the signature — an installation id,
 *  an expiry and a credential fragment, on the public issue this function exists to keep
 *  them off. Over-matching a trailing period in prose is the correct trade here: a
 *  redactor that eats one extra character is strictly better than one that leaks 285. */
export const redactSecrets = (s) => String(s ?? '')
  .replace(/\bgh[pousr]_[A-Za-z0-9._-]{16,}/g, 'gh?_«redacted»')
  .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_«redacted»')
  .replace(/(https?:\/\/)[^/\s@]+@/g, '$1«redacted»@');

/** The one line of a `gh` failure that says WHY, or '' when there is none.
 *
 *  RA-1284: `execFileSync` throws with `message = "Command failed: <argv>\n<stderr>"`, and
 *  every caller here took `.split('\n')[0]` — the argv line, which is the one part that
 *  says nothing about the cause. So a 403, a 404, a malformed input and a network blip
 *  produced BYTE-IDENTICAL escalations, distinguishable only by the subcommand. The
 *  pilot project was held for exactly this and the hold comment could not say why; the
 *  answer turned out to be `HTTP 403: Resource not accessible by integration`, one line
 *  that would have named the cause immediately.
 *
 *  The FIRST stderr line, because that is where `gh` puts the HTTP status, and bounded
 *  at 300 characters because a comment on a public issue is not a log file. */
export const ghCause = (err) => {
  const raw = String(err?.stderr ?? '') || String(err?.message ?? '').split('\n').slice(1).join('\n');
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return redactSecrets(first).slice(0, 300);
};

/** Is this failure one a retry could fix? (RA-1203)
 *
 *  THE HOLD MUST NOT TREAT A BLIP LIKE A DEFECT. RA-963 made `execute` hold on ANY failed
 *  action, which is right for the failure it was filed about — a brief naming a
 *  milestone that does not exist, which no number of retries can fix — and wrong for a
 *  502, a secondary rate limit or a DNS wobble. Before RA-963 those self-healed on the
 *  next tick; after it they stopped the whole project, including the actions unrelated
 *  to the one that failed, until a human removed the label. On an hourly heartbeat and
 *  a developer checking in every couple of days, one blip cost ~2 days of throughput.
 *
 *  THIS IS ONLY IMPLEMENTABLE BECAUSE `ghCause` EXISTS. RA-1203 said so: classification
 *  needs `err.stderr`, and while every caller read the argv line there was nothing to
 *  classify. The two issues are one change.
 *
 *  FAILS CLOSED. Anything not recognised as transient is permanent, so the RA-963
 *  behaviour is the default and this only ever narrows it. A transient failure is NOT
 *  silently swallowed either — the tick goes RED (see `execute`), so a blip that is
 *  actually permanent shows up as a workflow failing on every run, which is the state
 *  `scripts/qa/workflow-health.mjs` escalates (RA-1036). */
export const TRANSIENT_GH = /\b(HTTP 5\d\d|502|503|504|bad gateway|service unavailable|gateway time-?out|server error|rate limit|abuse detection|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|connection reset|TLS handshake)\b/i;
export const isTransient = (cause) => TRANSIENT_GH.test(String(cause ?? ''));

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // RE-THROWN WITH THE CAUSE ON THE FIRST LINE (RA-1284), so every existing caller —
    // `hold()`, `execute`'s per-action catch, `reconcileAll`'s — carries it without
    // changing: they all take `.split('\n')[0]`, and now that line says why.
    const cause = ghCause(err);
    const e = new Error(`gh ${args[0] ?? ''} ${args[1] ?? ''} failed${cause ? `: ${cause}` : ' (no stderr)'}`);
    e.cause = err;
    e.ghCause = cause;
    e.stderr = err?.stderr;
    e.status = err?.status;
    throw e;
  }
}
/** @param {string[]} args @param {{run?: (a: string[]) => string}} [io] */
const ghJson = (args, { run = gh } = {}) => JSON.parse(run(args));
const warn = (m) => console.log(`::warning title=lead-reconcile::${m}`);

/** Append to the job summary, when there is one.
 *
 *  ONE PLACE (RA-1484 needed a second caller). Also the seam RA-1208 is about: the unit
 *  tier stubs `GITHUB_STEP_SUMMARY` to `''` so a test's `report()` cannot write a
 *  fabricated the Lead reconcile report — for a project that does not exist — into the
 *  `Lint · Typecheck · Unit` job's own summary, which is what it did on every CI run. */
function writeStepSummary(text) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  execFileSync('bash', ['-c', 'cat >> "$GITHUB_STEP_SUMMARY"'], { input: text });
}

// ---------------------------------------------------------------------------
// Phase
//
// Ordered by what must be true first. Each phase is a fact about the world, not a
// stored status — so a human filing an issue by hand, or closing one, moves the
// project exactly as a tick would.

/**
 * How a readDeploy state maps onto a phase name. `null` means "falls through to
 * phase 6".
 *
 * An EXPLICIT map, not a pass-through: returning `world.deploy.state` directly was
 * correct only because readDeploy's states happened to be spelled the way
 * `nextActions` branches on them, so any new state or a rename on either side
 * became a phase name nothing handles — silently, since nextActions would fall
 * through to the file/reconcile arms with every issue closed.
 *
 * At module scope so `reachesPhase6` reads the SAME map. Two hand-kept lists that
 * must agree is precisely the bug they would be written to prevent.
 */
// EXPORTED so the tests derive the state set instead of enumerating it (RA-1440 review).
// Three test tables restated this map by hand, and RA-1369's new state landed in the map
// without landing in them — which is precisely the drift the map exists to prevent,
// one level out.
export const DEPLOY_PHASE = {
  deployed: null,                      // fall through to phase 6
  'nothing-to-deploy': null,           // nothing shipped, but nothing to wait for
  deploying: 'deploying',
  failed: 'deploy-failed',
  'gate-declined': 'deploy-gate-declined',
  'awaiting-release': 'awaiting-release',
  'run-not-found': 'deploy-run-not-found',
  'run-unreadable': 'deploy-run-unreadable',
  'deploy-job-absent': 'deploy-job-absent',
  reverted: 'deploy-reverted',
  'history-unreadable': 'deploy-history-unreadable',
};



/** Phase 5's round cap before a human steps in (RA-1023). */
export const QA_ROUND_CAP = 2;

/**
 * How many verification rounds this project may have, and whether one is owed (kanon#186).
 *
 * `qa-exhausted` holds the project with `needs:human`, and the hold says to remove the
 * label once the cause is fixed. But the rounds are the Explorer's marker comments, which
 * never go away, so the next tick re-derived `qa-exhausted` and re-held it — twice in 70
 * minutes in the reference adopter, with the fix shipped and no new round in between.
 *
 * So a HUMAN removing `needs:human` once the bound is reached GRANTS ONE ROUND: the bound
 * becomes the rounds so far plus one, and the round is `pending` until the Explorer posts
 * it. If it fails, the project holds again; each human action buys exactly one round. A
 * clear before the bound is reached (another hold's cause) grants nothing, because the
 * two ordinary rounds are still unspent.
 *
 * Pure. `roundsAt` are the Explorer's marker times; `clearedAt` the times a human removed
 * `needs:human` from the tracking issue. Either absent reads as none, which is the
 * pre-kanon#186 bound of two.
 *
 * @param {{roundsAt?: string[]|null, clearedAt?: string[]|null, cap?: number}} input
 * @returns {{allowed: number, pending: boolean}}
 */
export function qaRoundBudget({ roundsAt, clearedAt, cap = QA_ROUND_CAP } = {}) {
  const times = (xs) => (xs ?? []).map((x) => Date.parse(x)).filter(Number.isFinite).sort((a, b) => a - b);
  const rounds = times(roundsAt);
  let allowed = cap;
  let grantedAt = null;
  for (const t of times(clearedAt)) {
    const before = rounds.filter((r) => r < t).length;
    if (before >= allowed) {
      allowed = before + 1;
      grantedAt = t;
    }
  }
  return { allowed, pending: grantedAt != null && !rounds.some((r) => r > grantedAt) };
}

/**
 * Has anything happened since the Explorer last verified that could change his answer?
 *
 * NOT "has the deployed tag moved". Releases are frequent and mostly unrelated work —
 * per merge until RA-2594 (v0.38.2..v0.38.5 in one hour, 2026-08-26), up to six a day since — so a
 * tag-based signal would re-verify constantly and verify nothing, at the cost of a
 * the Explorer run each time.
 *
 * The signal is a PROJECT ISSUE CLOSING: unrelated work never closes one. Timestamps
 * are safe here, unlike phase 4's containment test — "did this close after that
 * comment" is a genuine happens-before, not a question about commit ancestry. Where
 * it is imprecise (an issue closing mid-run) it errs toward re-verifying, which is
 * the safe direction.
 *
 * @param {{closedAt?: string}[]} issues  the project's issues, excluding the QA one
 * @param {string|null} lastVerifiedAt
 */
export function needsVerification(issues, lastVerifiedAt) {
  if (!lastVerifiedAt) return true;                       // never verified
  const since = Date.parse(lastVerifiedAt);
  if (Number.isNaN(since)) return true;                   // unreadable is not "no"
  return issues.some((i) => i.closedAt && Date.parse(i.closedAt) > since);
}

// MEMBERSHIP IS NOT CLOSURE (RA-1783): `gatesClosure`, `openGatingWork` and `carriedOut`
// live in `project-closure.mjs`, with the rule's full rationale. `blockedOf` stays here —
// it decides parking, which only this tick acts on.

/** The members that park the project on a human's answer. Only a GATING member can: a
 *  carried-out follow-up's question is its own, and holding the brief's work on it
 *  would let a `sev:low` documentation correction park a whole project (RA-1783). */
export const blockedOf = (open, proposed) =>
  (open ?? []).filter((i) => gatesClosure(i, proposed)
    && ((i.labels ?? []).includes(NEEDS_INFO) || (i.labels ?? []).includes('blocked')));

/** A member's severity label, for the report and the retro, or `no sev:*`. */
const severityOf = (i) => (i.labels ?? []).find((l) => l.startsWith('sev:')) ?? 'no sev:*';

// ── THE `project:<n>` LABEL MIRRORS THE MARKER (RA-1783) ────────────────────────
//
// The marker stays the machine identifier — five readers use it, and RA-1066's
// position rule is what keeps a document ABOUT the convention from being absorbed by
// it. But an HTML comment is invisible and unfilterable: nobody can `gh issue list
// --label` their way to a project's follow-ups. The label is that human surface.
//
// A milestone was considered and rejected: an issue carries exactly one, and RA-1452
// had to be both "project 1015" and launch-gating.
//
// THIS TICK IS THE ONLY WRITER OF THE LABEL, and it FOLLOWS the marker within a tick.
// Agents that file a follow-up write only the marker; the mirror below adds the label
// to every member that lacks it and removes it from any holder that is no longer a
// member. Two homes that can disagree will — so one derives from the other, and
// `labelMirror` is the parity check, run every tick.

export const projectLabel = (project) => `project:${project}`;
/** Label edits one tick may make for one project. The first tick after this landed
 *  labels every existing member; a cap spreads that over a few ticks instead of one
 *  burst, and the report says how many were deferred. */
export const mirrorCap = (raw) => {
  // Anything but a positive integer is the default, never a disabled or unbounded
  // mirror — `slice(0, -1)` is every edit but one, and `slice(0, NaN)` is none.
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 10;
};
export const MIRROR_PER_TICK = mirrorCap(process.env.QA_LEAD_MIRROR_PER_TICK);

/**
 * Where the marker and the label disagree, and what makes them agree. Pure.
 *
 * `add` — members (marker as the LAST line) missing the label. `remove` — label holders
 * that are not members. `create` — the label is not known to exist. A world whose
 * label holders could not be read (`labelled` undefined) removes nothing.
 */
export function labelMirror(world, { cap = MIRROR_PER_TICK } = {}) {
  const label = projectLabel(world.project);
  // No brief on `main`, nothing to mirror: the reads below are skipped for it too.
  if (!world.briefMerged) return { label, create: false, add: [], remove: [], deferred: 0 };
  const add = (world.all ?? []).filter((i) => !(i.labels ?? []).includes(label)).map((i) => i.number);
  const remove = (world.labelled ?? []).filter((i) => !declaresMembership(i.body, world.project)).map((i) => i.number);
  return {
    label,
    // An issue HOLDING the label proves it exists, which `repoLabels`' capped list may
    // not show once the repo has many — so `--force` never re-runs on an existing label.
    create: !world.knownLabels?.has(label) && !(world.labelled ?? []).length && !(world.all ?? []).some((i) => (i.labels ?? []).includes(label)),
    add: add.slice(0, cap),
    remove: remove.slice(0, cap),
    deferred: Math.max(0, add.length - cap) + Math.max(0, remove.length - cap),
  };
}

/** Perform the mirror. Every edit is caught and warned: a label is a reporting
 *  surface, and a failed one must never stop the tick's real work. Returns whether the
 *  label is known to exist, which the `file` and `adopt` arms read. */
export function mirrorLabels(world, plan, { run = gh } = {}) {
  let ready = !plan.create;
  if (plan.create) {
    try {
      // `--force` makes it idempotent: a label created since `repoLabels` read is updated.
      run(['label', 'create', plan.label, '--repo', REPO, '--force', '--color', 'BFD4F2',
        '--description', `Project #${world.project} — mirrors the qa:project marker (RA-1783)`]);
      ready = true;
    } catch (err) {
      warn(`project #${world.project}: could not create \`${plan.label}\` — ${ghCause(err)}`);
    }
  }
  if (!ready) return false;
  for (const n of plan.add) {
    try { run(['issue', 'edit', String(n), '--repo', REPO, '--add-label', plan.label]); } catch (err) { warn(`#${n}: could not add \`${plan.label}\` — ${ghCause(err)}`); }
  }
  for (const n of plan.remove) {
    try { run(['issue', 'edit', String(n), '--repo', REPO, '--remove-label', plan.label]); } catch (err) { warn(`#${n}: could not remove \`${plan.label}\` — ${ghCause(err)}`); }
  }
  return true;
}

export function phaseOf(world) {
  const { briefMerged, proposed, filed, open, blocked, projectHeld } = world;
  // FIRST, above even the brief gate. A held project is one where a previous tick
  // took an action that failed, or found a defect no tick can fix — and the whole
  // point of holding is that the next tick must not do the same thing again. RA-963:
  // an action that fails permanently was retried hourly, forever, on a green run,
  // because state is derived and nothing remembered the failure.
  if (projectHeld) return 'held';
  if (!briefMerged) return 'awaiting-brief';        // the human's gate; nothing to do
  // A brief whose decomposition did not parse yields NOTHING to file, and every
  // later condition is then vacuously satisfied — so this used to fall through to
  // `complete` and announce "all issues closed" on a project where nothing was
  // ever filed. That is silent-absence in the one place it costs most, and it was
  // reachable on day one: no brief has ever been produced, so the parser has never
  // met its input.
  if (!proposed.length) return 'brief-unparseable';
  // `brief-unparseable` guarded proposed.length === 0; this guards
  // proposed.length < what is actually in the file, which is the silent half.
  // "Took less than is there" — not specifically sub-headings, which was only the
  // first way it happened.
  if (proposed.residue?.length) return 'brief-partially-parsed';
  if (blocked.length) return 'blocked';             // a human owes an answer
  // By TITLE, not by count. Comparing counts let one hand-filed member issue
  // the brief never named suppress filing a real one — `2 >= 2` skipped the file
  // phase entirely, and the project then reported `complete` with an issue missing.
  // `nextActions` has always decided WHAT to file by title; this makes WHETHER
  // agree with it.
  // An item is SATISFIED by an issue carrying its title, or by the issue it adopted
  // (RA-1213 review). Comparing titles alone meant an adopted item was never satisfied,
  // the project never left `file`, and `nextActions` then produced no action and no
  // `stopped` — a silent hourly no-op, green, forever, which is the exact class this
  // change set exists to close.
  if (proposed.some((p) => !itemSatisfied(p, filed))) return 'file';
  // The QA issue is excluded from the WORK view. It is open for as long as the
  // project is unverified, and counting it here would keep the project in
  // `reconcile` forever — phase 4 gates on `!open.length` — while `nextActions`
  // dispatched it to an implementer.
  // Only the members that GATE CLOSURE (RA-1783): a carried-out follow-up is reported,
  // not waited on — see `gatesClosure`.
  const openWork = openGatingWork(open, proposed);
  if (openWork.length) return 'reconcile';

  // ── PHASE 4 — deploy watch ────────────────────────────────────────────────
  //
  // Every issue is closed. That is not the same as the work being ON the reference
  // environment, and conflating them is how a project would report itself done while
  // its code sat in an unreleased merge. Derived like everything else (§5.2):
  //
  //   issue closed -> its PR merged -> merge SHA
  //                -> the release whose tag CONTAINS that SHA
  //                -> the run, for that tag, of the deploy workflow the adoption
  //                   record declares (K-PROJ-11, K-LAYOUT-10)
  //
  // Measured on the reference adopter before this was written, because an earlier plan
  // assumed a human gate between merge and release and there is none: the Releaser
  // AUTO-MERGES the release PR. Its deploy workflow then fires when the release commit's
  // CI completes (RA-1190; until then it fired on `release: published`). So
  // `awaiting-release` is a transient, not a gate — up to one scheduled release tick
  // since RA-2594 (3 h, or overnight) — but it is a distinct state, because reporting
  // it as `deployed` is the lie this phase exists to prevent.
  // An EXPLICIT map, not a pass-through. Returning `world.deploy.state` directly was
  // correct only because readDeploy's states happened to be spelled the way
  // nextActions branches on them; any new state, or a rename on either side, became
  // a phase name nothing handles — silently, since `nextActions` would fall through
  // to the file/reconcile arms with every issue closed.
  const deployState = world.deploy?.state ?? 'awaiting-release';
  if (!(deployState in DEPLOY_PHASE)) return 'deploy-unknown';
  const deployPhase = DEPLOY_PHASE[deployState];
  if (deployPhase) return deployPhase;

  // ── PHASE 5 — verification on the reference environment ─────────────────────────
  //
  // The work is deployed. That is not the same as the work WORKING, and phase 6
  // closing on a deploy alone is the weakness RA-1056 shipped with and said so.
  //
  // Structural, not left to the brief (RA-1063): a brief that forgets to propose QA
  // is exactly the failure mode, and "the Lead must remember" is the weakest
  // available guard. So the tick appends the QA issue itself.
  if (!world.qaIssue) return 'file-qa';

  if (world.qaIssue.state === 'OPEN') {
    // Cannot decide without the round count: dispatching would loop, and skipping
    // would look like a healthy wait. Neither is honest, so it stops and says why.
    if (world.qaIssue.readable === false) return 'qa-unreadable';
    // Bounded like every other loop here (RA-1023): a project that cannot pass QA in
    // two rounds belongs with the developer, not another Explorer run. A human clearing
    // the hold grants exactly one more round (kanon#186) — see `qaRoundBudget`.
    const budget = qaRoundBudget({ roundsAt: world.qaIssue.roundsAt, clearedAt: world.qaIssue.clearedAt });
    if ((world.qaIssue.rounds ?? 0) >= budget.allowed) return 'qa-exhausted';
    // The granted round is OWED, whether or not a gating member closed since the last one:
    // the fix that clears the hold is often to the brief or the specs, which close nothing.
    if (budget.pending) return 'verify';
    // The same gating set (RA-1783): a carried-out follow-up closing is not a change to
    // the project's work, and must not spend one of phase 5's two rounds.
    if (needsVerification((world.all ?? []).filter((i) => !i.labels.includes(VERIFY) && gatesClosure(i, world.proposed)), world.qaIssue.lastVerifiedAt))
      return 'verify';
    // NOTHING IS LEFT TO FIX — which, here, is the only way to arrive (RA-1091).
    //
    // The Explorer is told not to file for `unverifiable`/`not-run` and not to close the QA
    // issue unless everything passed, so round 1 leaves an open QA issue, `rounds` at
    // 1, and no new project issue. `needsVerification` keys on a `closedAt` later than
    // `lastVerifiedAt`, and phase 5 is only reachable once every work issue is already
    // closed — so it is false forever. Nothing re-dispatched the Explorer, `rounds` stayed 1,
    // and `qa-exhausted` (`>= 2`) was unreachable. Every hour, forever.
    //
    // THE FIRST VERSION GUARDED THIS WITH A DEAD CONJUNCT (RA-1241). It asked whether an
    // open, non-QA, non-tracking issue existed — which is `openWork`, computed thirty
    // lines above and returning `reconcile` when non-empty, because `readWorld` derives
    // `open` from `all` by exactly that rule. So it was always false here, and the
    // `awaiting-qa` it guarded was unreachable. Executed rather than reasoned: an open
    // finding gives `reconcile`, `rounds === 0` gives `verify`, and no-open-work gives
    // this. The distinction the conjunct pretended to draw is drawn earlier, so the
    // honest thing is not to restate it.
    //
    // Escalates rather than closing. Closing on "nothing failed" would let a project
    // with no citing test close having verified nothing — the silent-absence phase 5
    // exists to prevent.
    return 'qa-unverifiable';
  }

  // ── PHASE 6 — close ───────────────────────────────────────────────────────
  // The work is on the reference environment and the tracking issue is still open: there is an action
  // to take. `complete` means the close already happened, so a re-run is a no-op
  // rather than a second retro.
  // A REOPENED tracking issue is not an unfinished close (RA-1062). Re-closing it
  // undoes a human's decision inside the hour and posts a second retro.
  if (world.trackingReopened) return 'reopened';
  if (!world.trackingClosed) return 'close';
  return 'complete';
}

// ---------------------------------------------------------------------------
// Actions
//
// At most one KIND of action per tick, deliberately. A tick that files issues does
// not also dispatch one: filing is the bigger, less reversible step, and letting
// the same tick act on its own output would mean acting on state it has not yet
// re-derived — which is the whole point of deriving it.

/** The declared reference environment, deploy workflow and job, as a message names them
 *  (plan 0004 P6). A hand-built `deploy` object carries none of them, so each falls back to
 *  a description. Before the deploy phase there is no `deploy`, so the environment's name
 *  comes from `world.environment`, read from the record whenever it declares one (kanon#219). */
const deployEnvironment = (world) => envName(world.deploy?.environment ?? world.environment);
const deployWorkflow = (world) => (world.deploy?.workflow ? `\`${world.deploy.workflow}\`` : 'the reference deploy workflow');
const deployJobName = (world) => (world.deploy?.job ? `\`${world.deploy.job}\`` : 'deploy');

/** How many containing releases the phase-4 walk classified, when that is more than
 *  one. Silent at one, because "examined 1 release" is noise on the common case and
 *  the tag already says which. */
const walked = (world) => (world.deploy?.examined > 1
  ? ` (${world.deploy.examined} containing releases examined; none deployed)` : '');

/** Every dependency cycle among the open issues, as lists of issue numbers.
 *
 *  Iterative DFS with an explicit stack rather than recursion: a brief is
 *  human-written and a malformed one should be reported, not overflow the stack.
 *  Returns each cycle once, keyed on its normalised rotation, so `A→B→A` and
 *  `B→A→B` are one finding rather than two. */
export function dependencyCycles(issues) {
  const edges = new Map(issues.map((i) => [i.number, (i.dependsOn ?? []).filter((d) => issues.some((x) => x.number === d))]));
  const seen = new Set();
  const found = new Map();
  for (const start of edges.keys()) {
    if (seen.has(start)) continue;
    const stack = [[start, [start]]];
    const onPath = new Set();
    while (stack.length) {
      const [node, path] = stack.pop();
      onPath.add(node);
      for (const next of edges.get(node) ?? []) {
        const at = path.indexOf(next);
        if (at !== -1) {
          const cycle = path.slice(at);
          // Normalise the rotation so one cycle is reported once however it is entered.
          const min = Math.min(...cycle);
          const rotated = [...cycle.slice(cycle.indexOf(min)), ...cycle.slice(0, cycle.indexOf(min))];
          found.set(rotated.join(','), rotated);
          continue;
        }
        if (path.length < edges.size + 1) stack.push([next, [...path, next]]);
      }
    }
    for (const n of onPath) seen.add(n);
  }
  return [...found.values()];
}

/**
 * ON EVERY TICK, WHATEVER ELSE THE TICK DECIDES (RA-1408).
 *
 * `nextActions` has ~20 return points and the unreviewed-PR detector lived behind
 * exactly one of them — the `slots <= 0` branch — so a project UNDER its WIP cap never
 * reached the code at all. That is the common case, which is why a stall this
 * reconciler could see hourly went unrecovered for as long as the project had room.
 *
 * Wrapping rather than editing twenty returns: a recovery that depends on which branch
 * the tick happened to take is the same defect again, one refactor later.
 *
 * NOT CHARGED AGAINST THE TICK BUDGET, and it fires even when that budget is spent. The
 * budget (RA-1447/RA-1483) meters IMPLEMENTER runs, which are the expensive, WIP-bearing
 * thing; a review churn starts no implementer and consumes no slot. Charging it would
 * mean the tick that is most starved — the one where work is piling up behind an
 * unreviewed PR — is exactly the tick that cannot unblock itself. `reconcileAll` is
 * where that exemption is actually applied — see `CHARGED` there.
 *
 * @param {any} world
 * @param {{wip?: number, budgetLeft?: number, runsFor?: (sha: string) => any[] | null,
 *          now?: number, hours?: number}} [opts]
 * @returns {{phase: string, actions: any[], stopped?: string|null, escalate?: any,
 *            reviewNotes?: {lane?: string, pr: number, sha: string, why: string}[]}}
 */
/**
 * @typedef {object} Decision
 * @property {string} phase
 * @property {any[]} actions
 * @property {string|null} [stopped]
 * @property {string[]} [escalate]  reasons a human must act on, routed to `hold()`
 * @property {'action'|'defect'|'stop'} [escalateKind]  which sentence the hold opens with
 * @property {{lane?: string, pr: number, sha: string, why: string}[]} [reviewNotes]
 */

/** @param {any} world @param {any} [opts] @returns {Decision} */
export function nextActions(world, opts = {}) {
  const base = nextActionsCore(world, opts);
  const { churn, noted } = reviewRecovery(world, opts);
  const revise = reviseRecovery(world, opts);
  const split = splitRecovery(world, opts);
  const allChurn = [...churn, ...revise.churn, ...split.actions];
  const allNotes = [...noted, ...revise.noted, ...split.noted];
  if (!allChurn.length && !allNotes.length) return base;
  return {
    ...base,
    actions: [...allChurn, ...(base.actions ?? [])],
    reviewNotes: allNotes,
  };
}

function nextActionsCore(world, {
  wip = WIP_DEFAULT,
  budgetLeft = Infinity,
  // THE PROJECT'S OWN CAP, THREADED (RA-1501). `wip` is `min(wipPerProject, globalLeft)`,
  // so by the time it arrives here the two caps are indistinguishable — which is why
  // the stop message could name the wrong one. Defaults to `wip`, so a caller that
  // passes neither (every test that predates this, and any future single-cap caller)
  // gets exactly the message it got before.
  wipPerProject = wip,
  // How many projects this tick already decided. `0` means this is the first, and the
  // shared-allowance message must NOT claim an earlier project spent it — with one open
  // project and `QA_LEAD_WIP=0` (the obvious way for an operator to pause dispatch) it
  // did exactly that, sending the reader somewhere wrong.
  earlierProjects = 0,
  // WHAT THE SHARED ALLOWANCE WAS AT THE START OF THE TICK, not what is left of it
  // (RA-1676). `earlierProjects` alone cannot answer "did an earlier project spend it":
  // it counts projects DECIDED, not allowance CONSUMED, so with `QA_LEAD_GLOBAL_WIP=0`
  // every project after the first was told an earlier one spent an allowance that was
  // never non-zero — the reader sent to chase "which project took my slot" when none
  // did, which is the misdirection this whole branch exists to remove.
  //
  // `Infinity` means NOT THREADED — a single-cap caller has no shared allowance to
  // describe, and every caller predating this one implied it was non-zero. So the
  // default leaves all four of RA-1501's sentences exactly as they were.
  globalWip = Infinity,
} = {}) {
  const phase = phaseOf(world);
  // 0 means EXHAUSTED here, unambiguously — parsing an unset or malformed env into
  // 0 is the caller's problem, and `readBudget` below is where that ambiguity is
  // resolved. Keeping it here made `Number('')` (an unset env) indistinguishable
  // from a spent budget, which would have stopped every tick, green, forever.
  if (budgetLeft <= 0) return { phase, actions: [], stopped: 'tick budget exhausted' };

  // A HELD PROJECT TAKES NO ACTIONS (RA-963). The hold exists because a previous tick
  // already tried and failed, so re-deriving the same world and computing the same
  // action is exactly what must not happen. It clears when a human removes the label,
  // which is also the only thing that can fix what caused it.
  if (phase === 'reopened') {
    return {
      phase, actions: [],
      stopped: `#${world.project} was closed by a previous tick and REOPENED since — that is a human saying the project is not done, so this tick will not re-close it or post a second retro (RA-1062). Close it again by hand, or delete the brief to release the project`,
    };
  }
  if (phase === 'held') {
    return {
      phase, actions: [],
      stopped: `held: the tracking issue carries \`${HELD}\`, so a previous tick escalated something no tick can fix. Remove the label once it is resolved and the next tick resumes`,
    };
  }

  // ── PHASE 4 outcomes ──────────────────────────────────────────────────────
  // A failed reference deploy STOPS the project. It never advances to close, and the
  // next tick re-derives the same failure rather than retrying past it — a project
  // whose code did not reach the reference environment is not one whose code works.
  if (phase === 'deploy-failed') {
    return {
      phase, actions: [],
      stopped: `the deploy to ${deployEnvironment(world)} FAILED for ${world.deploy?.tag ?? 'the release containing this project'} (${world.deploy?.url ?? 'no run url'})${walked(world)} — the project is not closed and will not be until a deploy of this work succeeds`,
    };
  }
  // Not an absence: every issue is closed and the work is in flight. Saying so is
  // the difference between "nothing to do" and "waiting on a named thing".
  // Each of these is a DIFFERENT fact, and two of them are not transient. Printing
  // one sentence for all of them said "waiting for the release that contains their
  // merges" about a project whose release was found and whose run was not — which
  // reads as patience for something already past.
  const WAITING = {
    'awaiting-release': () => 'every issue is closed; no release contains their merges yet',
    deploying: () => `every issue is closed; \`${world.deploy?.tag}\` is deploying to ${deployEnvironment(world)}`,
    'deploy-run-not-found': () => `every issue is closed and \`${world.deploy?.tag}\` contains their merges, but no ${deployWorkflow(world)} run for that tag is among the last ${DEPLOY_RUN_WINDOW} read${walked(world)} — this does NOT resolve itself, and the project will sit here until someone looks`,
    'deploy-run-unreadable': () => `could not read the jobs of the deploy run for \`${world.deploy?.tag}\` (${world.deploy?.url ?? 'no url'}), so whether ${deployEnvironment(world)} was touched is UNKNOWN — refusing to treat unknown as deployed. A read failure is transient: the next tick re-issues it`,
    // NAMES ITS OWN PERMANENCE (RA-1369). This state used to be reported as
    // `run-unreadable`, whose message says nothing about resolving itself — so a human
    // had every reason to wait for a tick that could never differ. A completed run's
    // job set does not change.
    'deploy-job-absent': () => `every containing release was read, and none has a ${deployJobName(world)} job — the first examined is \`${world.deploy?.tag}\` (${world.deploy?.url ?? 'no url'}). A completed run's jobs never change, so this does NOT resolve itself: either the job was renamed since these tags were cut, or the adoption record names a different one, or those releases genuinely never deployed. Refusing to treat an absent job as a deploy`,
    'deploy-gate-declined': () => `\`${world.deploy?.tag}\` was released but its deploy job was SKIPPED: ${deployWorkflow(world)}'s gate found nothing to deploy in the range, so ${deployEnvironment(world)} was never touched${walked(world)}. The project is not closed on a deploy that did not happen`,
    // A REVERT IS NOT A DEPLOY (kanon#161). Ancestry credited a release whose tree no
    // longer held the work, because a reverted merge stays an ancestor of every later tag.
    'deploy-reverted': () => `every containing release that deployed also contains a revert of this project's work: ${(world.deploy?.reverted ?? []).map((r) => `\`${String(r.sha).slice(0, 7)}\` reverted by \`${String(r.by).slice(0, 7)}\``).join(', ') || 'a closing merge'}, so ${deployEnvironment(world)} does not hold it — the newest examined is \`${world.deploy?.tag}\`${walked(world)}. A later release that re-lands the work clears this, by a revert of the revert or by a later merged pull request that closes the same issue; if it was re-landed another way, a human decides whether the project is done`,
    'deploy-history-unreadable': () => `\`${world.deploy?.tag}\` deployed (${world.deploy?.url ?? 'no url'}), but the commits after this project's merges could not be read, so whether one of them reverts the work is UNKNOWN — refusing to treat unknown as deployed. A read failure is transient: the next tick re-issues it`,
    'deploy-unknown': () => `readDeploy returned a state this tick does not know how to act on — refusing to guess`,
  };
  if (WAITING[phase]) return { phase, actions: [], stopped: WAITING[phase]() };

  // ── PHASE 5 outcomes ──────────────────────────────────────────────────────
  if (phase === 'file-qa') {
    return {
      phase,
      actions: [{
        kind: 'file-qa',
        title: qaIssueTitle(world.project, world.deploy?.environment),
        tag: world.deploy?.tag ?? null,
        environment: world.deploy?.environment ?? null,
      }],
    };
  }

  if (phase === 'verify') {
    return {
      phase,
      actions: [{ kind: 'verify', number: world.qaIssue.number, project: Number(world.project), tag: world.deploy?.tag ?? null }],
    };
  }

  // `awaiting-qa` HAS NO ARM because it has no reachable state (RA-1241). It said the
  // QA issue's findings "are already project issues that earlier phases dispatch" —
  // true, and precisely why control never arrives here: an open finding is `openWork`,
  // which returns `reconcile` earlier. Kept as a comment rather than a branch so the
  // reasoning survives without a reader believing the tick draws a distinction it
  // cannot draw.

  // The Explorer ran, nothing is left to fix, and another round would report exactly what
  // the last one did — because nothing it reads has changed. The two-round bound
  // cannot reach this state (RA-1091), so this is the escalation for it.
  if (phase === 'qa-unverifiable') {
    // IT REACHES A HUMAN, NOT ONLY THE STEP SUMMARY (RA-1242). This phase's own message
    // says a human owes the project a decision, and its only delivery mechanism was a
    // `**Stopped:**` line inside the job summary of a run that concludes GREEN, hourly,
    // indefinitely — so "this project is stalled and a human owes it a decision" and
    // "this project is progressing normally" were the same observable. `escalate`
    // routes it through `hold()`, which is idempotent in both halves and is already the
    // designed exit for a state that recurs every tick.
    //
    // WHY THE HAMMER IS THE RIGHT ONE HERE, which RA-1242 leaves open. Holding stops the
    // project — and this phase IS the project stopped: every issue is closed, nothing
    // is left to fix, and no tick can advance it. There is no work being suspended.
    // RA-1203's objection to a sticky hold is about a TRANSIENT cause, and this cause is
    // permanent by construction; that same change now keeps blips out of `hold()`
    // entirely, so the two fixes do not fight.
    //
    // THE DEPLOY PERMANENTS DELIBERATELY DO NOT ESCALATE. `deploy-run-not-found` and
    // `deploy-job-absent` also say they do not resolve themselves, and they are
    // narrower than they read: the phase-4 walk re-examines every containing release
    // each tick, so a LATER release that deploys clears them with nobody editing
    // anything. Permanent-by-construction is the admission test, and they do not meet it.
    // FAIL SAFE ON THE ANCHOR (RA-1783 review). A `signal:spec-violation` member WITHOUT
    // the phase-5 anchor is carried out — but if it is really a failed criterion whose
    // body lost the anchor, "NO project issue is left to fix" would be false and a
    // human following it would close over the failure. So they are named here.
    const unanchored = (world.open ?? []).filter((i) => (i.labels ?? []).includes(SPEC_FINDING) && !isPhase5Finding(i));
    const caveat = unanchored.length
      ? ` BUT ${unanchored.map((i) => `#${i.number}`).join(', ')} carr${unanchored.length === 1 ? 'ies' : 'y'} \`${SPEC_FINDING}\` without the phase-5 anchor \`${FINDING_ANCHOR}\`, so ${unanchored.length === 1 ? 'it is' : 'they are'} read as carried out — if any is a failed acceptance criterion, it is NOT fixed: read ${unanchored.length === 1 ? 'it' : 'them'} before accepting.`
      : '';
    return {
      phase, actions: [],
      escalateKind: 'stop',
      escalate: [`phase 5 is \`qa-unverifiable\`: QA issue #${world.qaIssue.number} is open after ${world.qaIssue.rounds} verification round(s) with NO project issue left to fix, so no tick can advance this project. Accept it unverified and close #${world.qaIssue.number} by hand, or add the tests that would let a criterion be established.${caveat}`],
      stopped: `QA issue #${world.qaIssue.number} is open after ${world.qaIssue.rounds} verification round(s), and NO project issue is left to fix — so nothing will change before the next tick and another Explorer run would report the same thing. This is the all-\`unverifiable\` outcome: criteria with no citing test are reported \`unverifiable\`, never \`passed\`, and that is not a finding the Explorer can file against. A human owes this project a decision — accept it unverified and close #${world.qaIssue.number} by hand, or add the tests that would let a criterion be established. NOT closing it here: a project with no citing test would close having verified nothing.${caveat}`,
    };
  }

  // Two QA rounds without a pass. Same reasoning as the revise cap (RA-1023): a
  // disagreement that survives two rounds belongs with the developer.
  if (phase === 'qa-unreadable') {
    return {
      phase, actions: [],
      // THE CAUSE MUST BE REACHABLE (RA-1103). This said "this job needs `issues:
      // read`" and sent the operator to the workflow's `permissions:` block — which
      // governs a different call. The `Reconcile` step runs on the Lead App token
      // (`agent-lead-reconcile.yml` mints it via `actions/create-github-app-token`);
      // the `permissions:` block only covers the cheap pre-filter that uses
      // `github.token`. So the operator finds that block already correct and the real
      // causes go unnamed.
      //
      // Naming the likely cause IS this phase's justification: `qa-unreadable` exists
      // to refuse both dispatching and waiting, and hand a human a lead instead. A
      // lead pointing at the wrong file is worse than none.
      stopped: `could not read QA issue #${world.qaIssue.number}'s comments, so how many times the Explorer has verified this project is UNKNOWN. Refusing to dispatch (which would loop) or to wait (which would look healthy). This step runs on the Lead App token, NOT the workflow token — so check the App installation's repository permissions (Issues: Read), not this workflow's \`permissions:\` block, which governs only the pre-filter. A transient \`gh\` failure is the other candidate; it clears on the next tick.`,
    };
  }

  if (phase === 'qa-exhausted') {
    // Same class, same delivery gap, same fix (RA-1242) — this one predates
    // `qa-unverifiable` and is the reason the subject is the CLASS rather than one phase.
    return {
      phase, actions: [],
      escalateKind: 'stop',
      escalate: [`phase 5 is \`qa-exhausted\`: QA issue #${world.qaIssue.number} has been verified ${world.qaIssue.rounds} times and the project still does not pass. Another Explorer run is bounded out; this belongs with the developer. Once the cause is fixed, removing \`${HELD}\` grants exactly one more verification round on the next tick; if it fails, the project holds again.`],
      stopped: `QA issue #${world.qaIssue.number} has been verified ${world.qaIssue.rounds} times and the project still does not pass. Stopping — this belongs with the developer, not another Explorer run. The project is NOT closed. Removing \`${HELD}\` grants one more round.`,
    };
  }

  // ── PHASE 6 ───────────────────────────────────────────────────────────────
  // Closes the project's TRACKING issue only. It never closes work — the phase is
  // only reachable because every filed issue is ALREADY closed.
  if (phase === 'close') {
    // `failedAt` TRAVELS ONTO THE ACTION (RA-1440 review). `renderCloseComment` is called
    // with this action, not with the deploy verdict, so a caveat read off the verdict
    // rendered empty in production while three tests passed against the verdict shape.
    // Carrying it here is what makes the close comment able to say it at all.
    return { phase, actions: [{
      kind: 'close-project',
      number: Number(world.project),
      tag: world.deploy?.tag ?? null,
      environment: world.deploy?.environment ?? null,
      ...(world.deploy?.failedAt
        ? { failedAt: world.deploy.failedAt, failedUrl: world.deploy.failedUrl }
        : {}),
    }] };
  }

  if (phase === 'file') {
    // Fail closed rather than let the backstop pick a bucket for us.
    if (world.unmilestoned?.length) {
      return { phase, actions: [], stopped: `${world.unmilestoned.length} proposed issue(s) carry no milestone` };
    }
    // THE GUARD THAT ENDS THE HEURISTIC-TUNING SEQUENCE. Filing is a run-once,
    // unamendable transformation — the file phase dedups by title, so a corrected
    // script never re-files or repairs what a bad parse produced. So the check
    // belongs on the OUTPUT, not on ever-narrower guesses about the input: an
    // issue with no body carries no acceptance criteria, and the implementer is
    // dispatched onto it regardless.
    const empty = world.proposed.filter((p) => !p.body || p.body.replace(/[-\s]/g, '') === '');
    if (empty.length) {
      return {
        phase, actions: [],
        stopped: `${empty.length} proposed issue(s) would be filed with an EMPTY body (${empty.map((p) => `“${p.title}”`).join(', ')}) — the acceptance criteria did not survive the parse, and filing is not undoable`,
      };
    }
    // A dropped LABEL token blocks: there is no legitimate reason for one, and
    // dropping it silently is what turned a loud `gh issue create --label` refusal
    // into a quiet loss of `sev:critical`.
    //
    // A dropped LINE does NOT block — the wrapped `**Depends on:**` continuation
    // in the real brief is a legitimate, intended drop, and blocking on it would
    // refuse the only real artifact we have. It is REPORTED instead (see
    // `report`), because the empty-body guard above is what actually catches a
    // heuristic that ate something load-bearing: a body that lost its content is
    // empty, and an empty body never files.
    const badLabels = world.proposed.flatMap((p) =>
      (p.droppedLabels ?? []).map((l) => `“${p.title}”: \`${l.slice(0, 60)}\``));
    if (badLabels.length) {
      return {
        phase, actions: [],
        stopped: `label token(s) that are not labels — ${badLabels.join('; ')}. Put prose after the labels, separated by \`·\`; a label welded to prose is lost silently and cannot be added back by a later tick`,
      };
    }
    // AN UNREAD `Closes #N` BLOCKS, for the same reason a dropped label does, and
    // more sharply (RA-1303). With `closes` empty this phase takes the FILE branch, so
    // an unread marker files a SECOND issue for work already tracked — and the
    // original then stays open permanently, because the file phase dedups by title
    // and never re-files. `itemSatisfied` falls back to title matching, so the project
    // reports itself complete with the original still open.
    //
    // Blocking rather than reporting, because the blast radius is the gate: the three
    // references RA-1303 measured (RA-1178, RA-625, RA-1120) are all on `Production Ready`, so
    // the failure mode is three duplicates on the gate beside three originals nothing
    // can close — the denominator corruption AGENTS.md makes gate hygiene a rule about.
    // A stop costs one tick and an edit; a wrong file costs a permanent issue.
    const strayCloses = world.proposed.flatMap((p) =>
      (p.droppedCloses ?? []).map((n) => `“${p.title}”: #${n}`));
    if (strayCloses.length) {
      return {
        phase, actions: [],
        stopped: `${strayCloses.length} item(s) name a closing reference the parser does not read — ${strayCloses.join('; ')}. A \`Closes #N\` is only adopted from the \`**Milestone:** …\` metadata line; written anywhere else it is ignored, and the tick would file a DUPLICATE that the original can never be closed by. Move it onto the metadata line, or separate the word from the number if the mention is deliberate`,
      };
    }
    // Only what the brief named, and only what is not already filed. Matching on
    // the brief's own title text keeps a re-run from filing duplicates when a
    // previous tick died between the create and the next read.
    // Adoption-aware too: comparing raw titles here would re-propose the same
    // adoption on every tick, since an adopted issue never carries the item's title.
    const already = satisfiedTitles(world.filed);
    // A TITLE THAT ALREADY EXISTS IS NEVER FILED AGAIN (RA-1069). Membership is the
    // body's last non-empty line being the marker — correct for the false POSITIVE it
    // fixes, and it widened the false negative, which is the unamendable one: a human
    // appending "Blocked on X" below the marker un-files the issue, and the next tick
    // re-files a duplicate of work that may already be in progress. The marker is an
    // HTML comment, invisible when rendered, so nothing warns the person editing.
    //
    // `searchTitles` is every issue the project search returned, member or not. An
    // issue with this exact title exists; filing a second one cannot be right whatever
    // its body says.
    //
    // REPORTED ON THE FIRST TICK THAT HAS NOTHING ELSE TO DO, which is weaker than
    // "reported rather than silently skipped" — the wording this comment carried, and
    // stronger than the code (RA-1213 review). The escalation arm below is gated on
    // there being no other action, so on a tick that also files or adopts, the orphan
    // waits. It is a one-tick deferral rather than a loss: the orphaned title never
    // enters `filedTitles`, so the phase stays `file` and the arm fires once the other
    // work drains. Reporting it immediately would mean a second escalation channel on
    // a tick that already has one, which is a bigger change than the finding warrants.
    const orphaned = world.proposed.filter((p) => !already.has(p.title) && world.searchTitles?.includes(p.title));
    // AN ADOPTED ISSUE IS NOT FILED, IT IS JOINED (RA-976). A decomposition item may
    // name an issue that already exists — the first real brief does, with
    // `**Closes RA-897; supersedes …**`. Filing a second issue for the same work left
    // the project carrying two, the implementer's PR closing the new one, and RA-897
    // open forever with nothing in the tick able to close it. Permanent, because the
    // file phase dedups by title and never re-files.
    //
    // `adopt` marks the existing issue as a member instead: it appends the membership
    // marker so `declaresMembership` sees it, which is the same fact filing would have
    // established, on the issue that already holds the work.
    const adoptions = world.proposed
      // NOT gated on `already` (RA-1213 review). That gate is redundant with the
      // per-number filter below — and worse than redundant: `briefTitle` is stamped on
      // each adopted issue, so `already` held the item's title as soon as the FIRST of
      // its numbers landed, and the remaining ones were never proposed again. The
      // per-number check is the one that makes this idempotent, and it is exact.
      .filter((p) => p.closes?.length)
      .flatMap((p) => p.closes
        // Already a member: nothing to do. This is what makes the action idempotent
        // across ticks, since the marker is what `all` is derived from.
        .filter((n) => !world.all.some((i) => i.number === n))
        .map((n) => ({ kind: 'adopt', number: n, title: p.title, ...p })));
    const files = world.proposed
      // An item that adopts is never filed — the adoption above is its action, and on
      // the tick after it lands the issue is a member and the title is `already`.
      .filter((p) => !already.has(p.title) && !p.closes?.length && !world.searchTitles?.includes(p.title))
      .map((p) => ({ kind: 'file', ...p }));
    // Adoptions go out WITH the files, not instead of them. Returning them alone
    // stalled the brief's other issues for a whole tick for no reason: they are
    // different actions on different issues, and the "one KIND of action per tick"
    // rule exists so a tick does not act on state it has not re-derived — which
    // adopting an issue the same tick files a different one does not do.
    // Adoptions first, because they are cheaper and cannot fail on a duplicate title.
    const all = [...adoptions, ...files];
    if (orphaned.length && !all.length) {
      return {
        phase, actions: [],
        escalateKind: 'defect',
        escalate: orphaned.map((p) => `an issue titled "${p.title}" already exists but no longer declares membership of #${world.project} — its body's last line is not the \`qa:project\` marker, most likely because something was appended below it. Re-filing it would duplicate work that may be in progress (RA-1069)`),
        stopped: `${orphaned.length} proposed issue(s) already exist but have lost the project marker: ${orphaned.map((p) => `"${p.title}"`).join(', ')}. Restoring the marker as the LAST line of each body re-joins them; the tick will not re-file them`,
      };
    }
    // The file phase is the one genuinely unbounded loop in the tick — it returned
    // EVERY unfiled issue at once. The budget now bounds it, which is the only way
    // it bounds anything: compared against a constant it could never fire, so the
    // guard was advertised and unreachable.
    const actions = all.slice(0, budgetLeft);
    return actions.length < all.length
      ? { phase, actions, stopped: `tick budget: filing ${actions.length} of ${all.length}, the rest next tick` }
      : { phase, actions };
  }

  if (phase === 'reconcile') {
    // THE PROJECT'S OWN WORK ONLY (RA-1783 review). A carried-out follow-up something
    // else dispatched is not this project's to count: three of them would spend its
    // whole cap and starve the brief, while the tick says it never waits on them.
    const inFlight = world.open.filter((i) => occupiesSlot(i) && isProjectWork(i, world.proposed));
    const parked = world.open.filter((i) => i.labels.includes(IMPLEMENT) && i.parkedOnHuman);
    const slots = wip - inFlight.length;
    if (slots <= 0) {
      // "WIP cap reached" is the message for WORK IN PROGRESS, and it was printed
      // hourly for six hours about a project that had stopped: PR RA-1057 was
      // reviewed CHANGES_REQUESTED and nothing re-invoked the implementer (RA-1077).
      // The count could not distinguish "an implementer is working" from "an
      // implementer will never work again", so three correct detectors described a
      // deadlocked project as a healthy one.
      //
      // The distinction is derivable: an in-flight issue whose PR is awaiting the
      // implementer is BLOCKED, not busy. Named here rather than left to a reader,
      // because this line is what a person checks when a project stops moving.
      const stalled = inFlight.filter((i) => i.reviewBlocked);
      // The other half of the same question (RA-1081): a head nobody has reviewed at
      // all. `isReviewBlocked` is false there, so it printed a plain `WIP cap
      // reached` — an implementer PR sitting unreviewed for hours, described as
      // progress. Age-gated, because a PR pushed a minute ago has no review either.
      const unreviewed = inFlight.flatMap((i) => awaitingReview(i.prs ?? []).map((pr) => ({ issue: i.number, pr })));
      // THE THIRD WAY AN IN-FLIGHT ISSUE CAN BE STOPPED, and the one that reads as
      // either of the other two (RA-1722). A conflicting PR dispatches no `pull_request`
      // event, so it collects neither CI nor a review — which makes it look like an
      // unanswered review or an unreviewed head depending on what landed last, and
      // both of those lines promise a churn that this tick will duly apply and that
      // GitHub will duly discard. PR RA-1708 sat here for 36 hours being described as a
      // stalled dispatch.
      //
      // Reported FIRST and said to supersede, because a conflicting PR is usually in
      // one of the other two lists as well and the remedy is not theirs.
      const conflicting = inFlight.flatMap((i) => (i.prs ?? [])
        .filter((pr) => pr.conflicting && pr.state === 'OPEN')
        .map((pr) => ({ issue: i.number, pr })));
      const notes = [
        conflicting.length
          ? `${conflicting.length} PR${conflicting.length === 1 ? ' is' : 's are'} blocked on a REBASE, not on the pipeline: ${conflicting.map((c) => `#${c.pr.number}`).join(', ')}. A conflicting PR has no merge ref, so GitHub dispatches no \`pull_request\` events for it — no CI, no revise, and no review that can land: a review-label churn starts a run that defers without CI, or reviews a head the rebase replaces. Any line below about the same PR describes a symptom; nothing moves until it is rebased (RA-1722).`
          : null,
        stalled.length
          ? `${stalled.length} of them ${stalled.length === 1 ? 'is' : 'are'} BLOCKED on a review the implementer has not answered: ${stalled.map((i) => `#${i.number}`).join(', ')}. This is not progress. This tick re-labels the ones with no revise run at all (RA-1524) and reports the rest — a head that HAS a failed run is a cap, an outage or a crash, and re-firing repeats it.`
          : null,
        unreviewed.length
          ? `${unreviewed.length} ${unreviewed.length === 1 ? 'has' : 'have'} had NO review on the current head for over ${AWAITING_REVIEW_HOURS}h: ${unreviewed.map((u) => `#${u.pr.number ?? u.issue}`).join(', ')}. This tick re-labels the ones with no review run at all (RA-1408) and reports the rest — a head that HAS a failed run is a cap, an outage or a crash, and re-firing repeats it.`
          : null,
      ].filter(Boolean);
      // WHICH CAP, AND WHOSE (RA-1483 review, corrected by RA-1501). `wip` is the smaller
      // of this project's cap and whatever the shared global allowance has left, so a
      // stop here has FOUR distinct causes and one sentence for all of them sends the
      // reader to the wrong place. This line is what a person checks when a project
      // stops moving, so it has to say truthfully why it stopped.
      //
      // The first version keyed on `wip === 0 && inFlight.length === 0`, which covers
      // half the cases: a later project carrying issues labelled on a PREVIOUS tick has
      // `wip = 0`, `inFlight.length = 2`, and rendered `WIP cap reached (2/0)` — "(2/0)"
      // reading as its own cap of zero, which is exactly the misdirection the branch
      // was added to remove. Reachable on an ordinary tick, not a corner.
      //
      // THE NOTES SURVIVE EVERY PATH (RA-1501). They were dropped on the shared-allowance
      // path — harmless while that path implied nothing in flight, and not harmless the
      // moment it is reachable WITH in-flight issues, since the notes are the half that
      // says whether those issues are stalled.
      // SAY WHAT WAS EXCLUDED (RA-2038). A slot freed silently is indistinguishable,
      // on every surface, from a slot that was never taken — and this whole change
      // is an argument that an unstated decision reads as no decision. Naming the
      // issues also makes a FALSE positive findable: if one of these is not really
      // parked, the tick says which to look at.
      const parkedNote = parked.length
        ? ` ${parked.length} issue(s) carry \`${IMPLEMENT}\` but are parked on a human and do NOT count against WIP (RA-2038): ${parked.map((i) => `#${i.number}`).join(', ')}.`
        : '';
      // WHAT PRECEDES `parkedNote` IS THE STOP SENTENCE PLUS `head`, NOT `head`
      // ALONE — and the first attempt at this got it backwards, dropping the
      // separator on exactly the path it was added for (RA-2111 review, measured).
      //
      // None of the four stop sentences ends in punctuation (`WIP cap reached
      // (1/1)`, `…\`QA_LEAD_WIP\` is 0`, `…(RA-1447)`, `…own cap of 3`), so an EMPTY
      // `head` means the note must supply the stop itself — otherwise the
      // kill-switch branch renders `is 0 1 issue(s) carry…`, a number pair on the
      // one line a person reads when a project stops moving. Both `notes` entries
      // DO end in `.`, so a non-empty punctuated `head` must not add a second.
      const head = notes.length ? `, and ${notes.join(' Also: ')}` : '';
      const endsPunctuated = head !== '' && /[.!?]$/.test(head);
      const suffix = head + (!parkedNote || endsPunctuated ? '' : '.') + parkedNote;
      const ownCapReached = wipPerProject > 0 && inFlight.length >= wipPerProject;
      const stopped = wipPerProject === 0
        // The operator kill-switch, which deserves its own sentence: nothing is wrong.
        ? `dispatch is paused for every project — \`QA_LEAD_WIP\` is 0${suffix}`
        : ownCapReached
          ? `WIP cap reached (${inFlight.length}/${wipPerProject})${suffix}`
          : wip === 0 && globalWip > 0 && earlierProjects > 0
            ? `the tick's shared implementer allowance is spent — ${earlierProjects} earlier project(s) in this tick used it. This project is NOT at its own cap (${inFlight.length}/${wipPerProject}); the shared one is \`QA_LEAD_GLOBAL_WIP\` (RA-1447)${suffix}`
            : wip === 0
              // The shared allowance was never non-zero this tick, so no project can
              // have spent it and NO position makes that claim true (RA-1676). Reached by
              // the first project because there is nothing before it, and by every
              // later one because `globalWip` is 0 — one sentence, one cause.
              // `QA_LEAD_GLOBAL_WIP=0` is the only way to arrive, and it is an operator
              // pausing dispatch, exactly like the `QA_LEAD_WIP=0` sentence above.
              ? `the tick's shared implementer allowance is 0 — \`QA_LEAD_GLOBAL_WIP\` is set to 0, so no project dispatches this tick. This project is NOT at its own cap (${inFlight.length}/${wipPerProject})${suffix}`
              : `WIP cap reached (${inFlight.length}/${wip}) — bound by the tick's SHARED allowance, not by this project's own cap of ${wipPerProject}${suffix}`;
      return { phase, actions: [], stopped };
    }
    // The brief's order, and only issues whose dependencies have closed. An issue
    // already labelled is skipped rather than re-labelled — re-labelling would
    // re-fire the implementer on work already in progress.
    // `order` is joined onto the issue from the brief in readWorld. Without that
    // join this sort compared undefined to undefined and was a NO-OP: dispatch ran
    // in whatever order the search returned, so the brief's last issue could go
    // first. The test that claimed to cover it passed `order` in by hand, building
    // a world the derivation could not produce.
    const openNumbers = new Set(world.open.map((i) => i.number));
    const eligible = world.open
      .filter((i) => !i.labels.includes(IMPLEMENT) && !i.labels.includes(NEEDS_INFO))
      // Never an implementer's to do (RA-1301) — see `HUMAN_ACTION`.
      .filter((i) => !i.labels.includes(HUMAN_ACTION))
      // Too big for one run, and a re-dispatch repeats the cap (RA-1781). The split PR
      // replaces this item; until it merges there is nothing here to build.
      .filter((i) => !i.labels.includes(SPLIT_LABEL))
      // Only the project's OWN work (RA-1783). A follow-up or bug that joined through
      // inheritance is the project's to REPORT, not to build: it keeps its own routing,
      // and dispatching it here would let every review of a follow-up's PR feed this
      // loop another issue. A `sev:high` one still gates closure — see `gatesClosure`.
      .filter((i) => isProjectWork(i, world.proposed))
      // Hold anything whose declared dependency is still open, or whose dependency
      // has not been filed at all. Removed once as unwired — a claim rather than a
      // check — and restored now that the brief genuinely carries `**Depends on:**`
      // (PR RA-964 wrote them unprompted on all four issues). At WIP 1 this is what
      // makes "runs in parallel with B" and "needs B first" mean anything.
      .filter((i) => !(i.dependsOn ?? []).some((d) => openNumbers.has(d)))
      .filter((i) => !(i.unfiledDeps ?? []).length)
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    // BOUNDED BY THE TICK BUDGET AS WELL AS BY WIP (RA-1447). This sliced on `slots`
    // alone, so `QA_LEAD_TICK_BUDGET` bounded only the FILE branch — the budget did
    // not mean what its name says. Invisible while a tick reconciled one project and
    // the budget defaulted to Infinity; it stops being invisible the moment the budget
    // is SHARED across projects, because then one project could spend more than the
    // whole tick was allowed and the next would still be asked for more.
    const actions = eligible.slice(0, Math.min(slots, budgetLeft))
      .map((i) => ({ kind: 'dispatch', number: i.number, title: i.title }));
    if (actions.length) return { phase, actions };

    // Never "nothing to do" without saying WHY it is nothing. Every other zero-action
    // path here sets `stopped`; this one did not, so a deadlock rendered as
    // "Nothing to do this tick. That is a finding, not an absence" — hourly, green,
    // indefinitely — in the very reporting surface this design offers as its answer
    // to silent-absence.
    const held = world.open
      .filter((i) => !i.labels.includes(IMPLEMENT))
      // A carried-out member holds nothing (RA-1783) — it is not what the project waits on.
      .filter((i) => gatesClosure(i, world.proposed))
      .map((i) => {
        // Gates closure by severity, but is not the brief's to dispatch (RA-1783).
        if (!isProjectWork(i, world.proposed)) return `#${i.number} is a \`${severityOf(i)}\` member outside the decomposition — it holds the project open, but it is not this tick's to dispatch; it follows its own routing (RA-1783)`;
        // Unresolvable: every proposed issue is filed by the reconcile phase, so a
        // key that still names nothing names nothing that will ever exist. That is
        // a defect in the brief, not a wait.
        if (i.unfiledDeps?.length) return `#${i.number} names ${i.unfiledDeps.map((k) => `Issue ${k}`).join(', ')}, which no filed issue matches — a brief defect, not a wait`;
        if (i.dependsOn?.length) return `#${i.number} waits on ${i.dependsOn.map((n) => `#${n}`).join(', ')}`;
        if (i.labels.includes(NEEDS_INFO)) return `#${i.number} is parked with \`${NEEDS_INFO}\``;
        if (i.labels.includes(HUMAN_ACTION)) return `#${i.number} awaits a HUMAN action (\`${HUMAN_ACTION}\`) — never dispatched; close it when the action is done (RA-1301)`;
        if (i.labels.includes(SPLIT_LABEL)) return `#${i.number} awaits a SPLIT (\`${SPLIT_LABEL}\`) — its implementer run hit its cap, so the Lead proposes smaller children as a PR against the brief; merging that PR closes it. If no split PR opens within ${SPLIT_STALL_HOURS}h, this tick re-delivers \`${SPLIT_WORKFLOW}\` ONCE, then hands it to \`${NEEDS_INFO}\` (RA-2406)`;
        return `#${i.number} held`;
      });
    // RA-977 — AN UNSATISFIABLE DEPENDENCY IS A BRIEF DEFECT, NOT A WAIT, and the
    // difference has to survive to the surface. A cycle renders the same sentence a
    // legitimate wait does ("RA-1 waits on RA-2; RA-2 waits on RA-1"), so the report cannot
    // distinguish "waiting correctly" from "will never proceed" — hourly, green,
    // forever. It is decidable from the brief alone, before any issue closes, which
    // is the same standard the `unfiledDeps` case one branch above already applies
    // when it calls an unresolvable key "a brief defect, not a wait".
    const cycles = dependencyCycles(world.open);
    if (cycles.length) {
      return {
        phase,
        actions: [],
        escalateKind: 'defect',
        escalate: cycles.map((c) => `dependency cycle: ${c.map((n) => `#${n}`).join(' → ')} → #${c[0]} — unsatisfiable, so no issue in it can ever become eligible`),
        stopped: `dependency cycle in the brief — ${cycles.map((c) => c.map((n) => `#${n}`).join(' → ')).join('; ')}. This is a brief defect: nothing in the cycle can ever be eligible, so the project cannot proceed until the brief is edited`,
      };
    }
    return held.length
      ? { phase, actions: [], stopped: `nothing eligible — ${held.join('; ')}` }
      : { phase, actions: [] };
  }

  return { phase, actions: [] };
}

// ---------------------------------------------------------------------------
// Derivation

/** Every label that exists in this repo, or `undefined` if they cannot be read.
 *
 *  `undefined`, not an empty set: an empty set would reject EVERY label the brief
 *  names and deadlock the project on an API hiccup — failing closed on the wrong
 *  axis. Undefined falls back to the shape heuristic, which is what the parser did
 *  before it could ask (RA-1004). */
// EXPORTED WITH AN INJECTABLE READER (RA-1202). The property that matters here —
// `undefined` rather than an empty set on a failed read, because an empty set rejects
// EVERY label the brief names and deadlocks the project on an API hiccup — was
// unreachable from a test: the function was module-private and talks to `gh`. What was
// tested was `parseProposed`'s behaviour GIVEN `undefined`, never that this produces it.
export function repoLabels({ json = ghJson } = {}) {
  try {
    return new Set(json(['label', 'list', '--repo', REPO, '--limit', '500', '--json', 'name']).map((l) => l.name));
  } catch {
    warn('could not read the repo label list — validating the brief\'s labels by shape only');
    return undefined;
  }
}

/**
 * PHASE 4's derivation. Closed is not deployed, and the whole chain is readable
 * from GitHub, so none of it is stored (§5.2):
 *
 *   closed issue -> its merged PR -> merge SHA -> the release whose tag CONTAINS
 *   that SHA -> the declared deploy workflow's run for that tag
 *
 * ANCESTRY, NOT TIMESTAMPS. `compare/<tag>...<sha>` returns `behind` or `identical`
 * when the SHA is in the tag. Comparing times instead would be wrong by exactly the
 * window that matters: releases here land about a minute apart, and a merge can
 * happen between a tag being cut and its deploy finishing.
 *
 * A closed issue with NO merged PR does not block. Issues get closed as duplicates,
 * as won't-fix, or by a human who did the work another way, and refusing to ever
 * finish a project because one issue closed without a PR would make the phase
 * unreachable rather than safe.
 */
/**
 * The merge SHAs that closed these issues.
 *
 * INJECTABLE (RA-1061) so the derivation can be tested. Phase 4 shells out to `gh` to
 * walk closed issue -> closing PR -> merge SHA -> containing release -> deploy run,
 * and that chain decides whether the Lead AUTO-CLOSES a project (the tick runs with
 * `APPLY=1`). None of it was covered: every test hand-built the `deploy` object it
 * wanted, so the tests exercised `phaseOf`/`nextActions` — the pure half — and
 * nothing at all exercised the half that produces those objects.
 *
 * That is the failure this file already records at the top of `phaseOf`: "The test
 * that claimed to cover it passed `order` in by hand, building a world the
 * derivation could not produce." Phase 4 reproduced it at four times the size.
 *
 * @param {object[]} issues
 * @param {{json?: (args: string[]) => any}} [io]
 */
export function closingMergeShas(issues, io = {}) {
  return closingMergesByIssue(issues, io).flatMap((i) => i.shas);
}

/**
 * The same merges, kept per issue (kanon#264). The flat list cannot tell "two pull
 * requests that each closed part of the work" from "the work, then its re-land", and
 * presence needs that: see `relandedReverts`. Only closed issues with at least one
 * merged closing pull request appear.
 *
 * @param {object[]} issues
 * @param {{json?: (args: string[]) => any}} [io]
 * @returns {{issue: number, shas: string[]}[]}
 */
export function closingMergesByIssue(issues, { json = ghJson } = {}) {
  // `closedByPullRequestsReferences` is GitHub's OWN join, the same reasoning as
  // RA-912's use of `closingIssuesReferences`: a `#N` regex over bodies cannot tell a
  // mention from a closure, and this field cannot drift from what GitHub did.
  // It reports the PR number but not its merge commit, so the PR is read too.
  return issues.flatMap((i) => {
    if (i.state !== 'CLOSED') return [];
    let refs = [];
    try {
      refs = json(['issue', 'view', String(i.number), '--repo', REPO, '--json', 'closedByPullRequestsReferences'])
        .closedByPullRequestsReferences ?? [];
    } catch {
      return [];
    }
    const shas = refs.flatMap((r) => {
      try {
        const pr = json(['pr', 'view', String(r.number), '--repo', REPO, '--json', 'state,mergeCommit']);
        return pr.state === 'MERGED' && pr.mergeCommit?.oid ? [pr.mergeCommit.oid] : [];
      } catch {
        return [];
      }
    });
    return shas.length ? [{ issue: i.number, shas }] : [];
  });
}


/**
 * The classification half of phase 4, pure so it can be executed by a test.
 *
 * Both of the defects the review found on the first version lived HERE, and both
 * escaped a mutation run because the tests covered `phaseOf`/`nextActions` with an
 * injected `deploy` object — the consumer, never the producer. Splitting it out is
 * what makes "a skipped deploy job is not a deploy" a testable claim.
 *
 * @param {{shas: string[], tag: string|null, run: object|null, deployJob: object|null|undefined}} evidence
 */
/**
 * The deploy workflow's run for exactly this tag.
 *
 * EXACT, never a substring. `includes` made `v0.38.1` match the run for `v0.38.10`
 * — and `gh run list` returns newest-first, so it preferred the wrong one. A
 * version prefix is a substring of its own successors, which makes this wrong
 * precisely as a project ages past `.9`.
 *
 * @param {{displayTitle?: string, [k: string]: unknown}[]} runs
 * @param {string} tag
 */
/**
 * Which deploy states can reach phase 6, and therefore need the tracking issue's
 * own state read.
 *
 * Gating this on `deployed` alone left `nothing-to-deploy` with
 * `trackingClosed: undefined` forever, so `phaseOf` returned `close` on every tick
 * and the project was re-closed with a fresh retro each hour. Idempotence is the
 * one property deriving state instead of storing it is supposed to give for free,
 * and this is the single place it can be lost.
 *
 * Derived from the same map `phaseOf` uses, rather than a second hand-kept list —
 * a state that falls through to phase 6 there but is missing here is exactly the
 * bug, so they cannot be allowed to disagree.
 *
 * @param {string|undefined} deployState
 */
export const reachesPhase6 = (deployState) =>
  deployState !== undefined && DEPLOY_PHASE[deployState] === null;

/**
 * What one commit message says it reverts (kanon#161): the commits git names
 * (`This reverts commit <sha>.`, which `git revert` and GitHub's Revert button both write)
 * and the pull requests GitHub names (`Reverts <owner>/<repo>#N`, the Revert button's PR
 * body, which a squash merge can carry instead). Only `repo`'s own pull requests count.
 *
 * @param {string} message @param {string} repo
 * @returns {{shas: string[], prs: number[]}}
 */
export function revertTargets(message, repo) {
  const shas = [...String(message).matchAll(/reverts commit ([0-9a-f]{7,40})\b/gi)].map((m) => m[1].toLowerCase());
  const prs = [...String(message).matchAll(/^Reverts ([\w.-]+\/[\w.-]+)#(\d+)\b/gim)]
    .filter((m) => m[1].toLowerCase() === String(repo).toLowerCase())
    .map((m) => Number(m[2]));
  return { shas, prs };
}

/**
 * The `--jq` prefilter for reverts, a regex that must hold every message `revertTargets`
 * accepts. Exported so a test evaluates the SAME pattern. It may use no anchor and no flag
 * but `i`, so that JavaScript and gojq read it the same way.
 */
export const REVERT_PREFILTER = 'reverts commit [0-9a-f]{7}|reverts [^ ]+#[0-9]';

/**
 * Which of `shas` a commit in `commits` undoes (kanon#161), each with the revert that
 * does it.
 *
 * A revert stays in history, so ANCESTRY cannot see one: a reverted merge is an ancestor
 * of every later tag. Presence is read from the reverts instead. A revert that is itself
 * reverted (a re-land by `git revert` of the revert) undoes nothing, to any depth, so a
 * re-landed merge reads as present again.
 *
 * @param {string[]} shas the project's closing merges
 * @param {{sha: string, targets: string[]}[]} commits the reverts after them, with each
 *   one's targets resolved to commit SHAs (full, or a prefix of 7 or more)
 * @returns {{sha: string, by: string}[]}
 */
export function revertedMerges(shas, commits) {
  const names = (target, sha) => sha.toLowerCase().startsWith(target.toLowerCase());
  const undone = new Map();
  /** @param {string} sha @param {Set<string>} seen @returns {string|null} the effective revert of `sha` */
  const undoneBy = (sha, seen = new Set()) => {
    if (undone.has(sha)) return undone.get(sha);
    if (seen.has(sha)) return null;            // a malformed cycle undoes nothing
    seen.add(sha);
    const by = commits.find((c) => c.sha !== sha && c.targets.some((t) => names(t, sha)) && !undoneBy(c.sha, seen))?.sha ?? null;
    undone.set(sha, by);
    return by;
  };
  return shas.flatMap((sha) => {
    const by = undoneBy(sha);
    return by ? [{ sha, by }] : [];
  });
}

/**
 * The reverts in `reverted` that a re-land through a NEW pull request answers (kanon#264),
 * removed. What is returned still holds the project at `reverted`.
 *
 * A reverted merge is re-landed for an issue when ANOTHER merge closing the SAME issue is
 * not itself reverted and came after the revert: the revert is an ancestor of it. That is
 * read from the ranges `presence` already fetched, at no extra call: the revert is in the
 * tag (it was in the reverted merge's range), so it is missing from the other merge's
 * range exactly when that merge's history holds it.
 *
 * A merge that landed BEFORE the revert re-lands nothing: two pull requests that each
 * closed part of an issue, one of them reverted, is a partial revert and still holds. So
 * does a merge closing a DIFFERENT issue, since issues are not interchangeable.
 *
 * @param {{sha: string, by: string}[]} reverted from `revertedMerges`
 * @param {{issue: number, shas: string[]}[]} byIssue from `closingMergesByIssue`
 * @param {Map<string, Set<string>>} after each closing merge's reverts in its range to the tag
 * @returns {{sha: string, by: string}[]}
 */
export function relandedReverts(reverted, byIssue, after) {
  const undone = new Set(reverted.map((r) => r.sha));
  return reverted.filter((r) => !byIssue.some((i) => i.shas.includes(r.sha) && i.shas.some((n) =>
    n !== r.sha && !undone.has(n) && after.has(n) && !after.get(n).has(r.by))));
}

/**
 * The deploy workflow's run for a release. Exact match on the title, never a substring
 * (RA-1056).
 *
 * TWO TITLES (RA-1190). A dispatched run is titled with its tag (the reference adopter's
 * deploy workflow sets `run-name` so). A run started by the release commit's CI completing
 * (`workflow_run`) can't know its tag when the title is fixed, because expressions
 * can't derive `v1.2.3` from a commit, so it is titled with the release commit's full
 * SHA. Pass `sha` to match those runs too.
 *
 * @template {{displayTitle: string}} R
 * @param {R[]} runs @param {string} tag @param {string|null} [sha]
 * @returns {R|null}
 */
export const findDeployRun = (runs, tag, sha = null) =>
  runs.find((r) => r.displayTitle === tag) ?? (sha ? runs.find((r) => r.displayTitle === sha) : undefined) ?? null;

/**
 * @param {{shas: string[], tag: string|null, run: object|null, deployJob: object|null|undefined}} evidence
 */
export function classifyDeploy({ shas, tag, run, deployJob }) {
  // Nothing merged closed any of these issues. Not `deployed` — saying so produced
  // three assertions of a deploy that provably did not happen, including a retro
  // reading "the work is on staging in `(untagged)`". It still must not block:
  // issues get closed as duplicates, or by a human who did the work another way.
  if (!shas.length) return { state: 'nothing-to-deploy' };
  if (!tag) return { state: 'awaiting-release' };
  if (!run) return { state: 'run-not-found', tag };
  if (run.status !== 'completed') return { state: 'deploying', tag, url: run.url };
  if (run.conclusion !== 'success') return { state: 'failed', tag, url: run.url };

  // A `success` RUN CONCLUSION IS NOT A DEPLOY (K-PROJ-11). The reference adopter's
  // deploy workflow is a cheap `gate` job plus a `deploy` job guarded by
  // `if: needs.gate.outputs.deploy == 'true'`. When the gate finds no deploying commits
  // in the tag range, `deploy` is SKIPPED and the run still concludes `success` — 8 of
  // its last 25 runs, 32% of releases, when this was measured. So the adoption record
  // names the job whose success is the deploy, not only the workflow.
  //
  // It is the LIKELY case for this pipeline's own projects: the gate deploys on
  // feat|fix|perf|refactor|build|revert, while release-please also cuts releases
  // for docs, test, ci, style and chore. A QA project landing as `docs:` produces a
  // release that never touches staging.
  //
  // Same distinction as `closed ≠ deployed`, one layer down: the workflow RAN is
  // not the code SHIPPED.
  // TWO CAUSES, ONE OF THEM PERMANENT (RA-1369). `deployJob` was falsy for both "the
  // API read failed" and "the jobs came back and none of them is the deploy job",
  // and only the first is transient. A completed run's job set never changes, so the
  // second cannot clear on a later tick — and because the walk deliberately reads
  // OLDER releases, whose job names come from the workflow as it was at that tag, any
  // past or future rename of the `deploy` job makes every release cut under that
  // shape park forever. That is RA-1258/RA-1268/RA-1271's shape one layer down.
  //
  // `undefined` = could not read (transient). `null` = read fine, no deploy job
  // (permanent). The tri-state was already in this function's JSDoc; only the
  // producer and this line had collapsed it.
  if (deployJob === undefined) return { state: 'run-unreadable', tag, url: run.url };
  if (deployJob === null) return { state: 'deploy-job-absent', tag, url: run.url };
  if (deployJob.conclusion === 'skipped') return { state: 'gate-declined', tag, url: run.url };
  if (deployJob.conclusion !== 'success') return { state: 'failed', tag, url: run.url };
  return { state: 'deployed', tag, url: run.url };
}

/** How many of the deploy workflow's runs phase 4 reads (RA-1190; see `readDeploy`). */
export const DEPLOY_RUN_WINDOW = 200;

/**
 * Phase 4's deploy state, derived rather than stored. See `closingMergeShas` for why
 * this takes an `io` seam.
 *
 * WHICH WORKFLOW, AND WHICH JOB, THE ADOPTION RECORD SAYS (plan 0004 P6, `K-PROJ-11`).
 * `declared` reads the reference environment's deploy from the record on the default
 * branch, and throws `DeclarationError` by name when it is missing or malformed: the
 * tick reports that project as failed, and no project can close without one. It is read
 * only when some merge closed an issue, because `nothing-to-deploy` looks for no run.
 * Every verdict after the read carries the declaration's `environment`, `workflow` and
 * `job`, so the messages name what was looked for.
 *
 * @param {object[]} issues
 * @param {{json?: (args: string[]) => any, text?: (args: string[]) => string,
 *   declared?: () => import('./lib/reference-deploy.mjs').ReferenceDeploy}} [io]
 */
export function readDeploy(issues, { json = ghJson, text = gh, declared = () => readReferenceDeployFrom(REPO) } = {}) {
  const byIssue = closingMergesByIssue(issues, { json });
  const shas = byIssue.flatMap((i) => i.shas);
  if (!shas.length) return classifyDeploy({ shas, tag: null, run: null, deployJob: null });
  const deploy = declared();
  const named = (d) => ({ ...d, environment: deploy.environment, workflow: deploy.workflow, job: deploy.job });

  const releases = json(['api', `repos/${REPO}/releases?per_page=30`, '--jq',
    '[.[] | {tag: .tag_name}]']);
  // Oldest-first: the walk STARTS at the earliest release containing every merge and
  // continues past negative evidence (RA-1258/RA-1268/RA-1271; own failure carried, RA-1372).
  const containsAll = (tag) => shas.every((sha) => {
    try {
      const st = text(['api', `repos/${REPO}/compare/${tag}...${sha}`, '--jq', '.status']).trim();
      return st === 'behind' || st === 'identical';   // ANCESTRY, never timestamps
    } catch {
      return false;                                    // unreadable is NOT containment
    }
  });
  // 200, not 30 (RA-1190). On the reference adopter every `main` CI completion starts a
  // run of its deploy workflow, including each feature merge's, whose gate is skipped at once. Those runs are
  // free, but they fill the window: at ~16 merges and ~11 releases a day, 30 runs was
  // about a day, and this walk reads up to 30 releases back.
  const runs = json(['run', 'list', '--repo', REPO, '--workflow', deploy.workflow,
    '--limit', String(DEPLOY_RUN_WINDOW), '--json', 'databaseId,displayTitle,status,conclusion,url']);

  // The release commit's SHA, for runs titled by it (see findDeployRun). Asked only when
  // the tag title found nothing. Unreadable means null, which reads as run-not-found:
  // a transient state, never a false `deployed`.
  const tagSha = (tag) => {
    try {
      return json(['api', `repos/${REPO}/commits/${tag}`, '--jq', '{sha: .sha}'])?.sha ?? null;
    } catch {
      return null;
    }
  };

  const classifyTag = (tag) => {
    const run = findDeployRun(runs, tag) ?? findDeployRun(runs, tag, tagSha(tag));
    let deployJob;
    if (run?.status === 'completed' && run.conclusion === 'success') {
      try {
        const jobs = json(['run', 'view', String(run.databaseId), '--repo', REPO, '--json', 'jobs']).jobs;
        // `undefined` when the answer is unusable, `null` when it is usable and says
        // there is no deploy job (RA-1369). `?? null` collapsed both, which is what made
        // a permanent state wear a transient one's name.
        // The declared job, by its exact name, never a pattern: a job whose name merely
        // contains "deploy" (an announcement, a failure notice) is not the deploy.
        deployJob = Array.isArray(jobs)
          ? (jobs.find((j) => j.name === deploy.job) ?? null)
          : undefined;
      } catch {
        deployJob = undefined;
      }
    }
    return classifyDeploy({ shas, tag, run, deployJob });
  };

  // A DECLINED GATE IS EVIDENCE OF NOTHING, so it must not be the final word (RA-1258).
  //
  // This took the EARLIEST release containing every merge and classified from that one
  // run. When that release's `deploy` job was skipped — the gate found no deploying
  // commits in its range — the project reported `deploy-gate-declined` and stopped.
  // But releases are cumulative and the earliest containing one never changes, so that
  // was a PERMANENT state, not a transient one: no later tick and no later release
  // could clear it, while the code had in fact been on staging for days.
  //
  // Live when this was written: project RA-961 had all 8 issues closed, nothing blocked,
  // and its merges shipped in `v0.48.9` — while the tick read `v0.48.8`, whose deploy
  // was skipped, forever. 8 of the last 25 releases are in that state, and a
  // QA-pipeline project is likelier than most to hit it, since the gate deploys on
  // `feat|fix|perf|refactor|build|revert` while release-please also cuts `ci`, `test`
  // and `docs` releases.
  //
  // ONLY POSITIVE EVIDENCE ENDS THE WALK EARLY (RA-1271/RA-1268). RA-1258 continued past
  // `gate-declined` alone and left `failed` and `run-not-found` terminal, which fixed
  // one permanent park by converting it into two rarer ones — the same shape, because
  // a NEGATIVE reading of one candidate was still ending a search that had candidates
  // left. Both sequences below put the project's commits on staging and parked forever:
  //
  //   vA declined · vB run aged out of the 30-run window · vC deployed   (RA-1268)
  //   vA declined · vB deploy failed                     · vC deployed   (RA-1271)
  //
  // In each, `vC` is real evidence — the reference adopter's deploy workflow checks out
  // the tag and deploys the whole tree, so it is not incremental — and the walk never
  // reached it.
  // Neither state recovers with time: the run window only ages `vB` further away, and
  // the earliest containing release never changes.
  //
  // THE ONE EXCEPTION IS THE PROJECT'S OWN FAILURE. A `failed` at the FIRST containing
  // release is the release that should have shipped this work, and walking past it
  // would report a later green as though the failure had not happened — the RA-1056
  // lesson, and the reason RA-1258 made `failed` terminal at all. That attribution is
  // exactly what breaks mid-walk: at candidate two or later the failing release is
  // whatever release happened to fail next, and the project is being parked on someone
  // else's failure.
  //
  // `deploying` and `run-unreadable` STAY TERMINAL and are deliberately not in the
  // continue set: both are transient — the next tick re-reads a completed run, or
  // re-issues an API call that failed — so neither can park a project permanently, and
  // waiting on an in-flight deploy of a containing release is the right answer.
  //
  // `deploy-job-absent` IS in the set, and used to hide inside `run-unreadable` (RA-1369).
  // A completed run's job set never changes, so "the jobs came back and none is the
  // deploy job" cannot clear on a later tick — it is negative evidence, not a pending
  // read, and it belongs with the other negatives. It reports ABOVE `run-not-found`
  // because it is strictly more informative: the run was found and read, and the
  // answer was that this tag's workflow had no deploy job under that name.
  //
  // Containment is re-checked per candidate by ANCESTRY (`compare` -> behind/identical),
  // never by assuming a later tag contains an earlier one. COST IS UNCHANGED IN THE
  // HEALTHY CASE: the first containing release is normally `deployed`, which returns on
  // the first iteration. Walking further only happens where RA-1258 already walked, so
  // the worst case — one `compare` per SHA per candidate — is the one that already
  // existed.
  //
  // `reverted` IS in the set too (kanon#161): a release whose tree no longer holds the work
  // is negative evidence, and a later release can re-land it. `history-unreadable` is not:
  // like `run-unreadable` it is a read that failed, and the next tick re-issues it.
  const CONTINUE_PAST = new Set(['gate-declined', 'run-not-found', 'failed', 'deploy-job-absent', 'reverted']);
  // Reported when NO candidate deployed. Most actionable first: `failed` names a run a
  // human can re-run, `run-not-found` says the evidence aged out, `gate-declined` is
  // evidence of nothing. Never used to CONCLUDE anything positive — only to choose
  // which negative to report, which is what RA-1268 means by "like `gate-declined` for
  // the purpose of continuing, but never for the purpose of concluding".
  // `reverted` FIRST: it is the one negative that says the work is not in the tree. It is
  // also the one state that keeps its LAST candidate rather than its first (see the walk),
  // so the release it names is the newest one that deployed without the work.
  const REPORT_ORDER = ['reverted', 'failed', 'deploy-job-absent', 'run-not-found', 'gate-declined'];

  // PRESENCE, NOT ONLY ANCESTRY (kanon#161), asked only of a release that would be credited.
  // One paginated `compare` per closing merge, from the merge to the tag: the commits the
  // tag holds after it, filtered by `--jq` to the ones whose message names a revert. A
  // pull request a revert names is resolved to its merge commit, which costs a call only
  // when a revert exists. Unreadable is never "no reverts".
  //
  // The prefilter is a SUPERSET of what `revertTargets` parses, with no anchor and no flag
  // but `i`: `gh --jq` is gojq, whose `m` flag means `(?s)`, not `(?m)`, so a `^Reverts`
  // there matched only at the start of the whole message and dropped every PR-named revert,
  // whose `Reverts …#N` line is in the body (kanon#262 review). `revertTargets` does the
  // anchored parse.
  //
  // A revert answered by a LATER merged pull request closing the same issue does not hold
  // the project (kanon#264): `relandedReverts` reads that from the same ranges, so it adds
  // no call. Before it, work re-landed that way waited for a human on every tick.
  const REVERT_JQ = `.commits[] | select(.commit.message | test("${REVERT_PREFILTER}"; "i")) | {sha: .sha, message: .commit.message} | @json`;
  const prMerge = new Map();
  const mergeOf = (n) => {
    if (!prMerge.has(n)) prMerge.set(n, json(['pr', 'view', String(n), '--repo', REPO, '--json', 'mergeCommit'])?.mergeCommit?.oid ?? null);
    return prMerge.get(n);
  };
  const presence = (tag, d) => {
    let reverted;
    try {
      const reverts = new Map();
      // Which reverts each merge's range holds, for `relandedReverts` (kanon#264).
      const after = new Map();
      for (const sha of shas) {
        const out = text(['api', '--paginate', `repos/${REPO}/compare/${sha}...${tag}?per_page=100`, '--jq', REVERT_JQ]);
        const seen = new Set();
        after.set(sha, seen);
        for (const line of out.split('\n').filter((l) => l.trim())) {
          const c = JSON.parse(line);
          if (typeof c?.sha !== 'string' || typeof c?.message !== 'string') throw new Error(`not a commit: ${line}`);
          seen.add(c.sha);
          if (reverts.has(c.sha)) continue;
          const t = revertTargets(c.message, REPO);
          reverts.set(c.sha, { sha: c.sha, targets: [...t.shas, ...t.prs.map(mergeOf).filter(Boolean)] });
        }
      }
      reverted = relandedReverts(revertedMerges(shas, [...reverts.values()]), byIssue, after);
    } catch {
      return { state: 'history-unreadable', tag, url: d.url };
    }
    return reverted.length ? { state: 'reverted', tag, url: d.url, reverted } : d;
  };

  // A DETECTOR REPORTS WHAT IT EXAMINED, not only what it found — the principle
  // `report()` already states. Now that the walk covers every containing release
  // rather than stopping at the first, a message naming one tag reads as though one
  // tag was checked, which is what the old behaviour did. `examined` is what lets a
  // human tell "we looked at the one release" from "we looked at all six and none
  // deployed", and stops them re-checking later releases by hand.
  const remembered = new Map();
  let examined = 0;
  let ownFailure = null;
  for (const r of [...releases].reverse()) {
    if (!containsAll(r.tag)) continue;
    examined++;
    const classified = classifyTag(r.tag);
    const d = classified.state === 'deployed' ? presence(r.tag, classified) : classified;
    if (!CONTINUE_PAST.has(d.state)) {
      // THE PROJECT'S OWN FAILURE IS CARRIED, NOT DISCARDED (RA-1372). This used to
      // `return` on a first-candidate `failed`, which was the last member of the
      // family RA-1258/RA-1268/RA-1271 belong to: the earliest containing release never
      // changes, so a project whose own release failed parked forever even when a
      // LATER whole-tree deploy put its code on staging.
      //
      // The RA-1056 reasoning that motivated the return still holds and is preserved —
      // reporting a later green "as though the failure had not happened" would be
      // wrong. What it did not settle is that the two facts are not exclusive: the
      // project's release CAN have failed and its code CAN now be deployed. So the
      // failure travels with the verdict (`failedAt`) instead of ending the walk, and
      // every artifact that names the deploy also names the failure.
      return named({ ...d, examined, ...(ownFailure ? { failedAt: ownFailure.tag, failedUrl: ownFailure.url } : {}) });
    }
    // The FIRST candidate in each state, so the message names a tag the walk actually
    // classified rather than the last one it happened to see.
    // Except `reverted`, which keeps the LAST: the newest release that deployed without
    // the work is the current fact, and the one its message names (kanon#262 review).
    if (!remembered.has(d.state) || d.state === 'reverted') remembered.set(d.state, d);
    // The earliest containing release is the one that SHOULD have shipped this work,
    // so its failure is about this project in a way a later release's is not.
    if (d.state === 'failed' && examined === 1) ownFailure = d;
  }
  for (const state of REPORT_ORDER) {
    if (remembered.has(state)) {
      const d = remembered.get(state);
      // NEVER CARRY A FAILURE ONTO ITSELF (RA-1440 review). When the reported state IS
      // the own failure, `remembered.get('failed')` and `ownFailure` are the same
      // object, so spreading would produce `failedAt === tag` — a sentence reading
      // "release vA failed; the work reached staging only via the later deploy of vA".
      // Unreachable today only because `deploy-failed` never gets to a caveat
      // renderer; gated so the invariant is structural rather than incidental.
      return named({ ...d, examined,
               ...(ownFailure && ownFailure !== d ? { failedAt: ownFailure.tag, failedUrl: ownFailure.url } : {}) });
    }
  }
  // Nothing contains the merges yet.
  return named(classifyDeploy({ shas, tag: null, run: null, deployJob: null }));
}


// `declaresMembership` lives in `project-closure.mjs` (kanon#174), so the project digest
// selects members by the same position rule; imported and re-exported above.


/**
 * Is this issue's work stopped, as opposed to in progress?
 *
 * An open PR whose LATEST review on the CURRENT head requests changes is waiting
 * for the implementer. Nothing re-fires one on its own except
 * `agent-implement-revise.yml` (RA-1077), so before that existed this state was
 * permanent — and indistinguishable, in the tick's report, from an agent working.
 *
 * On the CURRENT head deliberately: a changes-request against an older commit has
 * already been answered by the push that replaced it, and treating that as blocked
 * would report every healthy revision round as a stall.
 *
 * @param {{state: string, headSha: string, reviews: {state: string, sha: string, reviewedSha?: string|null, submittedAt?: string}[]}[]} prs
 */
export function isReviewBlocked(prs) {
  return prs.some((pr) => standingChangesRequest(pr) !== null);
}

/**
 * The changes-request standing on this PR's current head, or null.
 *
 * SPLIT OUT OF `isReviewBlocked` FOR ITS TIMESTAMP (RA-1690). The boolean answers "is
 * this stopped"; `reviseRecovery` needs a second thing from the same computation —
 * WHEN the request that stopped it was submitted — because that, not the head SHA, is
 * the clock its evidence and its age gate both have to run against. Returning the
 * review rather than re-deriving it in the caller keeps one definition of "deciding".
 * `brief-revise-recovery.mjs` has carried the identical function since RA-1595, over the
 * richer review shape `gh pr view` returns directly.
 *
 * COMMENTED IS NOT A VERDICT, and taking the last review regardless made it one in the
 * wrong direction (RA-1081): a `COMMENTED` review landing after a `CHANGES_REQUESTED` on
 * the same SHA flipped the answer back to "not blocked", and the project reported as
 * in-progress. This is reachable rather than theoretical — a standalone inline
 * comment creates one, 19 of his last 96 reviews were `COMMENTED`, and PRs carrying
 * them still exist. (`docs/qa/reviewer-playbook.md` used to permit a `COMMENT`
 * verdict on a red required check; RA-2299 removed that, but not the reviews it left.) GitHub's own `reviewDecision` ignores
 * them for exactly this reason.
 *
 * ON THE HEAD IT READ, NOT THE HEAD GITHUB FILED IT UNDER (RA-1725, after RA-1680).
 * `sha` is `commit.oid` — the head at SUBMISSION — so a changes-request formed against
 * `A` and submitted after a push made the head `B` reads as standing on `B`, even when
 * `B` is the push that answered it. The reviewer job stamps the SHA it checked out into
 * the body; `evidenceSha` prefers that stamp and falls back to `sha` for every review
 * predating it or posted out of band — the rule `review-recovery.mjs`'s `verdictOnHead`
 * and `merge-gate.mjs` already apply, from the same parser. Without it a re-attributed
 * request would be churned four hours later and re-invoke the implementer against a
 * review of a commit he has already moved past.
 */
export function standingChangesRequest(pr) {
  if (!pr || pr.state !== 'OPEN') return null;
  const onHead = (pr.reviews ?? []).filter((r) => evidenceSha(r) === pr.headSha);
  const deciding = onHead.filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED').at(-1);
  return deciding?.state === 'CHANGES_REQUESTED' ? deciding : null;
}

/** A PR whose head carries no verdict at all, and for how long.
 *
 *  The other half of RA-1081. If `agent-review.yml` crashes or skips — the recurring
 *  RA-356/RA-378 shape, and the skip-reports-SUCCESS case — the head has no review, so
 *  `isReviewBlocked` is false and the tick prints a plain `WIP cap reached`. An
 *  implementer PR sitting unreviewed for hours is the same deadlock RA-1077 describes,
 *  reached from the other side, and it renders as progress.
 *
 *  Age, not mere absence: a PR pushed a minute ago has no review either, and calling
 *  that a stall would fire on every healthy PR in the window CI takes to run. */
export const AWAITING_REVIEW_HOURS = Number(process.env.QA_LEAD_REVIEW_STALL_HOURS || 4);
export function awaitingReview(prs, now = Date.now(), hours = AWAITING_REVIEW_HOURS) {
  return prs.filter((pr) => {
    if (pr.state !== 'OPEN') return false;
    if ((pr.reviews ?? []).some((r) => r.sha === pr.headSha)) return false;
    // Unknown age is not a stall. A missing timestamp must not manufacture one.
    if (!pr.headPushedAt) return false;
    return now - new Date(pr.headPushedAt).getTime() >= hours * 3600_000;
  });
}

/**
 * The review runs that exist for a head SHA — the raw listing, classified by
 * `reviewAttempts` below into what is actually evidence that a review was attempted.
 *
 * `null` means UNREADABLE, which is not the same as none, and the difference decides
 * whether anything is churned. Failing to read Actions must never manufacture a
 * "no run ever fired" and re-fire a review on top of one that is already running.
 *
 * `Actions: Read` is granted (agent-identities.md footnote 7, for phase 4's probe of
 * the declared deploy workflow) and `agent-lead-reconcile.yml` already probes it at the top
 * of the tick, so a missing grant reds the run in seconds rather than silently
 * degrading here.
 *
 * SHARED WITH THE STANDALONE LANE (RA-1594/RA-1689). `review-run-evidence.mjs` owns both
 * the read and the classification, because `review-recovery.mjs` needs the identical
 * bound over a different world and a second copy of this rule is a second place for it
 * to be wrong.
 *
 * INJECTABLE (RA-1061), like `mergeShas` — the derivation is the thing worth testing and
 * `gh` is not reachable from a unit test.
 */
function reviewRunsFor(sha) {
  return readReviewRuns(sha, { repo: REPO, json: ghJson });
}

/**
 * What a decision costs the shared tick budget.
 *
 * EVERYTHING THE TICK PROPOSES EXCEPT A REVIEW CHURN (RA-1523 review). The change that
 * added `review-churn` argued it must not consume the budget, and then `reconcileAll`
 * decremented by `decision.actions.length` — churns included. The claim was true of
 * `nextActions`, which never consults the budget, and false one level up where the
 * budget actually moves. The sibling `globalLeft` line already filtered by kind; this
 * one did not.
 *
 * The damage is CROSS-PROJECT, which is why the single-project test that asserted "a
 * churn fires at budgetLeft: 0" could not see it: a churn on the first project
 * silently removes a file or a dispatch from the third. The tick where work is piling
 * up behind unreviewed PRs would be exactly the tick that files and dispatches least —
 * the sentence this module's docstring exists to rule out.
 *
 * Exported, and `reconcileAll` calls nothing else, for the same reason `actionable` is
 * in `dispatch-sweep.mjs`: the arithmetic is the thing worth testing and the loop it
 * lives in cannot be reached without `gh`.
 */
const RECOVERY_KINDS = new Set(['review-churn', 'revise-churn', 'split-churn', 'split-escalate']);
export function chargeable(actions) {
  // The split recovery's two kinds are exempt for the same reason (RA-2406): a churn
  // re-delivers an event that never arrived and a hand-off dispatches nothing.
  return (actions ?? []).filter((a) => !RECOVERY_KINDS.has(a.kind)).length;
}

/**
 * The `agent-implement-revise` runs for a head SHA that represent a DELIVERY of the
 * changes-request — or null if unreadable. Same fail-closed contract as
 * `reviewRunsFor` (RA-1524).
 *
 * SKIPPED RUNS ARE NOT DELIVERIES (RA-1592 review). The workflow subscribes to
 * `pull_request: [labeled]`, and every implement PR collects `agent:implement` +
 * `review:please` at open and `agent:reviewer` on the first review — all on the same
 * head the first changes-request lands on. Each of those starts a run. Counting them
 * as deliveries suppressed the churn on precisely the head this recovery exists for.
 *
 * The workflow's job-level `if` makes those conclude `skipped`, and this drops them.
 * A run started by the CHURN passes that gate, so it still counts — which matters
 * more than it looks: "after a churn a run exists" is the ONLY thing bounding this
 * loop. Exclude the churn's own run and the same head is re-churned every hour
 * forever.
 *
 * A null conclusion is an unfinished run and is KEPT: that is the state the churn
 * itself creates on the very next tick.
 *
 * AND A RUN THAT PREDATES THE REVIEW IS NOT A DELIVERY EITHER (RA-1690). The `skipped`
 * filter above was the right diagnosis with too narrow a remedy: the SAME burst of
 * label events also produces runs the workflow's `concurrency` group CANCELS, and
 * `cancelled` is not `skipped`, so those sailed through. PR RA-1660 parked for two days
 * on exactly one of them — run `33973225308`, cancelled at 14:55:06, ten minutes
 * BEFORE the 15:05 review it was being counted as having delivered. Worse than merely
 * suppressed: `reviseRecovery` classifies a cancelled run as `broken` and told a human
 * "re-firing repeats it", about a run that never saw the review.
 *
 * So the predicate was never `conclusion` — it is WHEN THE RUN STARTED. A delivery of
 * a changes-request cannot begin before the changes-request exists, whatever it went
 * on to conclude. That subsumes the `skipped` case for runs from the open burst, and
 * the `skipped` filter is kept anyway: a non-marker label event AFTER the review
 * starts a run too, and it is still not a delivery.
 *
 * THE LOOP STAYS BOUNDED, which is the one property that must not regress. A run
 * started by the churn is necessarily after the review, so "after a churn a run
 * exists" still holds and a head cannot be churned twice.
 *
 * FAIL CLOSED ON A MISSING `since`: no filtering, so every run counts and the churn is
 * suppressed. An unknown clock must not manufacture a re-fire.
 *
 * EXPORTED WITH A `json` SEAM (RA-1690), which its sibling `briefReviseRunsFor` has had
 * since RA-1595. It was private, so the only thing that could pin its filter was a
 * source-text assertion — and a source-text assertion cannot tell a filter that works
 * from one that reads right. The `skipped` half was guarded that way and still let the
 * cancelled runs through for two days.
 *
 * AND A CANCELLED RUN A NEWER ONE SUPERSEDED IS NOT A DELIVERY (RA-1724). The rules
 * live in `revise-run-evidence.mjs` — shared with the brief lane so the two cannot
 * drift — and that module's header has the measurement. `churnedAfter` is what keeps
 * the churn's own run counted whatever it concluded, so the bound above still holds;
 * absent, every post-review run counts, which is the pre-RA-1724 fail-closed behaviour.
 */
export { startedAfter };

export function reviseRunsFor(sha, since, { json = ghJson, churnedAfter = /** @type {string|null} */ (null) } = {}) {
  try {
    const runs = json(['run', 'list', '--repo', REPO, '--workflow', 'agent-implement-revise.yml',
      '--commit', sha, '--limit', '100', '--json', 'headSha,event,status,conclusion,databaseId,createdAt']);
    return reviseDeliveries(runs, { sha, since, churnedAfter });
  } catch {
    return null;
  }
}


/**
 * Recovery for a changes-request the implementer never answered (RA-1524).
 *
 * `isReviewBlocked` has detected this hourly since RA-1081 and printed a note telling a
 * HUMAN to "check that it ran" — the other half of the pattern RA-1408 removed for the
 * review lane, and the one it deliberately left because the implement-revise arm had
 * no label to churn. It has one now.
 *
 * THE BOUND IS THE EVIDENCE, exactly as in `reviewRecovery`: it churns only when NO
 * `agent-implement-revise` run exists for that head SHA. After a churn a run exists,
 * so the same head cannot be churned twice, and a run that failed IS a run — its head
 * is reported rather than re-fired, so a cap or an outage is never answered by
 * repeating it WHILE IT HOLDS. Since RA-2519 it is answered once AFTER: a head whose
 * only run died of its cause (the model unreachable, or its API failing mid-run) is
 * re-churned after `lane-retry.mjs`'s cool-down, and the retry is itself a run.
 *
 * THE ROUND CAP IS NOT AT RISK, which is the thing RA-1524 asked to be checked before
 * building this. `agent-implement-revise.yml` computes rounds as
 * `max(distinct patches faulted - 1, implementer markers)` (RA-1841 — it counted
 * changes-requests until then, which a content-free rebase could inflate) — derived
 * from the world, not incremented per run. A re-delivered event adds neither a patch
 * nor a marker, so it re-delivers the SAME round rather than spending another one.
 */
export function reviseRecovery(world, { runsFor = reviseRunsFor, now = Date.now(), hours = AWAITING_REVIEW_HOURS, evidenceOf = NO_RETRY_EVIDENCE, retryHours = RETRY_COOL_DOWN_HOURS } = {}) {
  // EVERY in-flight member, carried out or not (RA-1783): this re-delivers an event that
  // never arrived, which is a stall wherever it happens — it dispatches nothing new.
  const inFlight = (world?.open ?? []).filter((i) => (i.labels ?? []).includes(IMPLEMENT));
  const churn = [];
  const noted = [];
  for (const issue of inFlight) {
    for (const pr of (issue.prs ?? [])) {
      const review = standingChangesRequest(pr);
      if (!review) continue;
      // AGE-GATED ON THE REVIEW, NOT ON THE PUSH (RA-1690) — the same clock the brief
      // lane has used since RA-1595, and for the reason it already gives: what is being
      // timed is "how long has this changes-request gone unanswered", and the head
      // predates the review by definition. `headPushedAt` therefore timed the wrong
      // interval, always generously, so this gate opened earlier than it should have.
      // An unknown timestamp is not a stall: a missing `submittedAt` must not
      // manufacture one, and it is also the clock the run evidence below needs.
      if (!review.submittedAt) continue;
      if (now - new Date(review.submittedAt).getTime() < hours * 3600_000) continue;
      // A CHURN CANNOT REACH A CONFLICTING PR (RA-1722), so asking the run evidence is
      // asking the wrong question: `agent-implement-revise.yml` is `pull_request`-
      // triggered, GitHub dispatches no such event without a merge ref, and the run
      // listing is therefore empty *because* of the condition that would license the
      // churn. Measured on PR RA-1708: 12 remove/add pairs, 25 labels, zero runs.
      if (pr.conflicting) {
        noted.push({ lane: 'revise', pr: pr.number, sha: pr.headSha, why: CONFLICT_WHY });
        continue;
      }
      const runs = runsFor(pr.headSha, review.submittedAt, { churnedAfter: churnBoundary(review.submittedAt, hours) });
      if (!Array.isArray(runs)) {
        noted.push({ lane: 'revise', pr: pr.number, sha: pr.headSha, why: 'could not read this workflow\'s runs, so nothing was churned' });
        continue;
      }
      if (runs.length === 0) {
        churn.push({ kind: 'revise-churn', number: pr.number, sha: pr.headSha, issue: issue.number });
        continue;
      }
      // THE ONE EXCEPTION TO "A FAILED RUN IS A RUN" (RA-2519): the head's only delivery
      // died of its cause — the model unreachable, or its API failing mid-run — and the
      // cool-down has passed. Re-delivered once; the retry is itself a delivery, so a
      // second failure leaves two runs and falls through to the note below.
      const retry = retryDecision(runs, { evidenceOf, now, hours: retryHours });
      if (retry?.retry) {
        churn.push({ kind: 'revise-churn', number: pr.number, sha: pr.headSha, issue: issue.number, retry: retry.retry });
        continue;
      }
      if (retry?.why) {
        noted.push({ lane: 'revise', pr: pr.number, sha: pr.headSha, why: retry.why });
        continue;
      }
      const broken = runs.find((r) => ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(r.conclusion));
      const unfinished = runs.find((r) => !r.conclusion);
      const latest = broken ?? unfinished ?? runs[0];
      noted.push({
        lane: 'revise',
        pr: pr.number,
        sha: pr.headSha,
        why: `${runs.length} revise run(s) exist for this head and the request is still unanswered `
          + `(latest: ${latest?.status ?? '?'}/${latest?.conclusion ?? '-'}, run ${latest?.databaseId ?? '?'}). `
          + (unfinished && !broken
            ? 'It has NOT finished — nothing needs doing yet'
            : broken
              ? 'Re-firing repeats it — read that run\'s classify annotation (RA-1503)'
              : 'The run did not fail — read its `filter` step for which arm declined it. '
                + 'A round cap, an unanswered verdict, or a label that is not the marker; '
                + 'the last of those concludes `skipped` and is not counted here at all'),
      });
    }
  }
  return { churn, noted };
}

/**
 * Recovery for a review that never landed (RA-1408).
 *
 * `awaitingReview` has detected this hourly since RA-1081 and printed a note telling a
 * HUMAN to "check `agent-review.yml`" — the pattern RA-166 rejected, and the reason
 * PR RA-1503 sat unreviewed while its own fix was in it. This turns the note into an
 * action.
 *
 * IT CHURNS A LABEL, IT DOES NOT DISPATCH. `agent-identities.md` footnote 2 gives
 * the Lead `Actions: No access` for write on purpose — "label churn achieves the same
 * with strictly less authority" — and RA-1281 is what happened when phase 5 reached for
 * `gh workflow run` anyway: a 403 and a held pilot. `agent-review.yml` subscribes to
 * `pull_request: [labeled]` for precisely this case, in its own words: "a review label
 * added to a PR whose checks already settled fires no CI run, so no `workflow_run` ever
 * arrives."
 *
 * THE BOUND IS THE EVIDENCE, NOT A COUNTER. It churns only when no review run for that
 * head is evidence that a review was ATTEMPTED. Once it churns, one is — a run this
 * recovery started counts whatever it concluded — so the same head can never be churned
 * twice: no attempt counter, no marker comment, no state to keep or reset. That also
 * makes it impossible to re-fire into a live cap or outage, which is the one thing
 * RA-1408 must not do: a capped run IS a run, so its head is reported, never churned
 * while the cap may hold. After `lane-retry.mjs`'s cool-down, a head whose ONLY attempt
 * died of its cause is re-churned once (RA-2519) — the retry is an attempt too.
 *
 * "A RUN EXISTS" WAS THE WRONG QUESTION (RA-1594). `agent-review.yml` subscribes to
 * `pull_request: [labeled]` and admits any label event on a PR carrying a review label,
 * so on an implement PR every label — the two applied at open, the Merger's `needs:human`,
 * the Reviewer's `agent:reviewer` — manufactures a run for the head that reviews nothing.
 * Measured on PR RA-1591 head `b972df20`: five runs, zero reviews, `"reviews": []`. Had
 * it sat past the stall gate this would have taken the note branch and reported a
 * SUPERSEDED cancelled run as a crash to read a classify annotation from — about a head
 * nothing had ever tried to review. `reviewAttempts` in `review-run-evidence.mjs` is
 * the fix and carries the whole argument for each rule.
 */
export function reviewRecovery(world, { runsFor = reviewRunsFor, now = Date.now(), hours = AWAITING_REVIEW_HOURS, evidenceOf = NO_RETRY_EVIDENCE, retryHours = RETRY_COOL_DOWN_HOURS } = {}) {
  // EVERY in-flight member, carried out or not (RA-1783): this re-delivers an event that
  // never arrived, which is a stall wherever it happens — it dispatches nothing new.
  const inFlight = (world?.open ?? []).filter((i) => (i.labels ?? []).includes(IMPLEMENT));
  const churn = [];
  const noted = [];
  for (const issue of inFlight) {
    for (const pr of awaitingReview(issue.prs ?? [], now, hours)) {
      // Same outcome as `reviseRecovery`'s (RA-1722), one lane over, for a different
      // reason since RA-2299: `agent-review.yml`'s label path is now
      // `pull_request_target`, which DOES fire on a conflicting PR (RA-2302). But the
      // run it starts defers on a head CI never ran on, and a verdict on any other
      // head is dismissed by the push that resolves the conflict. Refusing stays right.
      if (pr.conflicting) {
        noted.push({ pr: pr.number, sha: pr.headSha, why: CONFLICT_WHY });
        continue;
      }
      const runs = runsFor(pr.headSha);
      if (!Array.isArray(runs)) {
        noted.push({ pr: pr.number, sha: pr.headSha, why: 'could not read this workflow\'s runs, so nothing was churned' });
        continue;
      }
      // THE CLASSIFICATION IS THE BOUND (RA-1594). A head can carry runs and still have
      // had no review attempted on it — see `review-run-evidence.mjs` for why each
      // rule is what it is, and for the five-run measurement that made this necessary.
      //
      // `churnedAfter` is the moment this head first became churnable, and it is what
      // separates a run THIS recovery started from one an App merely actored by
      // labelling the PR at creation (RA-1714). `awaitingReview` has already established
      // `headPushedAt` is set and older than `hours`, so this derives no new state.
      const attempts = reviewAttempts(runs, {
        churnedAfter: new Date(pr.headPushedAt).getTime() + hours * 3600_000,
      });
      if (attempts.length === 0) {
        churn.push({ kind: 'review-churn', number: pr.number, sha: pr.headSha, issue: issue.number });
        continue;
      }
      // Its only attempt died of its cause and the cool-down has passed (RA-2519) — the
      // same one exception, bounded the same way, as `reviseRecovery`'s.
      const retry = retryDecision(attempts, { evidenceOf, now, hours: retryHours });
      if (retry?.retry) {
        churn.push({ kind: 'review-churn', number: pr.number, sha: pr.headSha, issue: issue.number, retry: retry.retry });
        continue;
      }
      if (retry?.why) {
        noted.push({ pr: pr.number, sha: pr.headSha, why: retry.why });
        continue;
      }
      // An ATTEMPT stands and still no verdict. Re-firing is the wrong move either
      // way, but WHY differs and so does where the reader should look (RA-1523 review).
      noted.push({ pr: pr.number, sha: pr.headSha, why: whyNoChurn(attempts) });
    }
  }
  return { churn, noted };
}

// ── RE-DELIVERING A SPLIT THAT DIED (RA-2406) ──────────────────────────────────
//
// The split lane starts on an EVENT — `issues: labeled` with `qa:needs-split`, or the
// crash job's `workflow_dispatch`. A run that never happens or dies (a cap, an outage,
// a crash) leaves the issue labelled with no split PR (`splitBranch`), and until this
// nothing re-fired it: the tick only told a human to. The same "nothing re-fires"
// shape RA-1595 closed for the brief-revise lane and RA-1592 for the implementer.
//
// IT CHURNS THE LABEL, IT DOES NOT DISPATCH — footnote 2 again: the Lead has `Actions:
// No access` for write, and a label re-added on the App token is an `issues: labeled`
// event the lane already subscribes to.
//
// THE BOUND IS THE ISSUE'S OWN EVENT HISTORY, not a counter or a marker comment. Every
// application of the label is a `labeled` event, whoever made it — the crash job on the
// default token, the sweep, a human, or this churn — and GitHub keeps them. One such
// event is the original delivery; a second is a re-delivery. So:
//   · 1 delivery, older than `SPLIT_STALL_HOURS`, no split PR → churn (the ONE retry);
//   · 2+ deliveries, the latest that old, no split PR → `qa:needs-info` for a human.
// A churn adds an event, so the same issue can never be churned twice, and a human's own
// re-label counts as the retry rather than earning another one. ONE RETRY PER LINEAGE
// holds with no extra rule: a split child never carries this label — `exhaustedRoute`
// sends it straight to a human — so the only issue in a lineage that can is its root.
//
// PRE-STANDARD BRIEFS ARE STILL NEVER SPLIT. The churn re-runs the lane's GATE, not the
// agent, and the gate refuses an item from a pre-standard brief (`isPreStandard`, `K-LAYOUT-15`; §5.3,
// the developer's option (b) on RA-2407) and moves it to `qa:needs-info` itself. This
// recovery deliberately does not second-guess that: the gate is the one place that
// decides, and a re-delivery is exactly how a gate run that died gets to decide.

/** Hours a delivered split may go without a split PR before it is re-delivered. The lane
 *  times out at 60 minutes; the rest is queueing behind its per-issue concurrency group. */
export const splitStallHours = (raw) => {
  // Anything but a positive finite number is the default: NaN or a negative would make
  // every fresh delivery look stalled and spend the one retry on a run still queued.
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3;
};
export const SPLIT_STALL_HOURS = splitStallHours(process.env.QA_LEAD_SPLIT_STALL_HOURS);

/**
 * The split evidence for one issue — every `labeled` event for `qa:needs-split` and
 * every PR ever opened on its split branch — or null if either read failed. Read in
 * `readWorld`, only for an OPEN member carrying the label, so the decision stays pure
 * and an ordinary tick pays nothing. INJECTABLE for the unit tier.
 */
export function splitEvidenceRead(issue, { text = gh, json = ghJson } = {}) {
  try {
    const labeledAt = text(['api', '--paginate', `repos/${REPO}/issues/${issue}/events`, '--jq',
      `.[] | select(.event == "labeled" and .label.name == "${SPLIT_LABEL}") | .created_at`])
      .split('\n').map((l) => l.trim()).filter(Boolean);
    // Every spelling of the branch (#53): a split opened before the rename is still a split.
    const prs = splitBranches(issue).flatMap((head) => json(['pr', 'list', '--repo', REPO, '--state', 'all', '--head', head,
      '--json', 'number,state,createdAt']) ?? []);
    return { labeledAt, prs };
  } catch {
    return null;
  }
}

/**
 * What to do about each member parked on `qa:needs-split` with no split PR. Pure.
 *
 * @returns {{actions: {kind: 'split-churn'|'split-escalate', number: number, why: string}[],
 *            noted: {lane: 'split', pr: number, sha: string, why: string}[]}}
 */
export function splitRecovery(world, { now = Date.now(), splitHours = SPLIT_STALL_HOURS } = {}) {
  const actions = [];
  const noted = [];
  // A re-delivery starts a paid agent run; a human who held the project stopped those.
  if (world?.projectHeld) return { actions, noted };
  for (const i of world?.open ?? []) {
    const labels = i.labels ?? [];
    if (!labels.includes(SPLIT_LABEL)) continue;
    // The gate's own skips: a re-run under way, or already with a human.
    if (labels.includes(IMPLEMENT) || labels.includes(NEEDS_INFO)) continue;
    const ev = i.split;
    // FAIL CLOSED: an unread history must not manufacture a re-delivery.
    if (!ev) {
      noted.push({ lane: 'split', pr: i.number, sha: '', why: 'could not read its label events or split PRs, so nothing was re-delivered' });
      continue;
    }
    // A split PR under review is the lane having worked.
    if (ev.prs.some((p) => p.state === 'OPEN')) continue;
    const times = ev.labeledAt.map((t) => Date.parse(t)).filter(Number.isFinite);
    if (!times.length) {
      noted.push({ lane: 'split', pr: i.number, sha: '', why: `no \`labeled\` event for \`${SPLIT_LABEL}\` was found, so how long it has waited is UNKNOWN and nothing was re-delivered` });
      continue;
    }
    const latest = Math.max(...times);
    if (now - latest < splitHours * 3600_000) continue;
    // A split PR that CLOSED after the latest delivery and left the issue open was
    // rejected (a merge would have closed it) — re-splitting is a human's call. One
    // closed BEFORE it is history: a human re-labelled to ask for a fresh split, and
    // that request is judged by the delivery count below, like any other.
    const done = ev.prs.find((p) => p.state !== 'OPEN' && Date.parse(p.createdAt) >= latest);
    if (done) {
      actions.push({ kind: 'split-escalate', number: i.number, why: done.state === 'MERGED'
        ? `split PR #${done.number} MERGED but this issue is still open — its \`Closes #${i.number}.\` did not close it, so a human confirms the split landed and closes it`
        : `split PR #${done.number} is ${String(done.state).toLowerCase()} and this issue is still open, so a split was proposed and not taken — whether to split again is a human's call` });
      continue;
    }
    if (times.length >= 2) {
      actions.push({ kind: 'split-escalate', number: i.number, why: `the split lane was delivered ${times.length} times and no split PR exists after ${splitHours}h — a second re-delivery would repeat whatever stopped the first two` });
      continue;
    }
    actions.push({ kind: 'split-churn', number: i.number, why: `delivered once, over ${splitHours}h ago, and no split PR exists` });
  }
  return { actions, noted };
}

// ── A REVIEWER FOLLOW-UP'S MEMBERSHIP, DERIVED (RA-2412) ───────────────────────
//
// RA-1783 made the Reviewer derive it himself: trace `closingIssuesReferences` to the closed
// issue's last-line marker, or notice the PR touches `docs/projects/<n>.md`, then end
// the follow-up's body with the marker. Several `gh` hops per filing, done right every
// time by a model, and the prompt tests could only check what the prompt SAYS.
//
// Everything that trace needs is already fixed text on the follow-up — the Reviewer's prompt
// mandates `Surfaced by PR #N review` — or already read by this tick: every active
// project's members, closed ones included, are `world.all`. So the tick derives it:
// PR #N → the issues it closes → the active project they belong to, or PR #N →
// `docs/projects/<n>.md`. Exactly one project, or nothing.
//
// WHAT IT NEVER DOES:
//   · Touch a body that already carries ANY `qa:project` marker, last line or not. A
//     marker that is not last is a human's edit (RA-1069) or another writer's decision;
//     either way it is not this arm's to override.
//   · Guess across projects. A PR that traces to two active projects joins neither.
//   · Join an inactive project. Only the projects this tick reconciles are known, and a
//     closed project's retro has already been written.
//   · Write the `project:<n>` label. The marker is the membership; the label mirror
//     (`labelMirror`) remains that label's only writer and follows on the next tick.
//
// BOUNDED: open follow-ups created in the last `DERIVE_DAYS`, at most `MIRROR_PER_TICK`
// body edits per tick, and PR reads ROTATED over the window (`deriveMembership`) so each
// tick reads about `3 × MIRROR_PER_TICK` and every PR is read within a bounded number of
// ticks; the report says what was capped and what waits for its turn. GitHub API only —
// no Aurora, no new schedule.

export const REVIEWER_FOLLOW_UP = ['follow-up', 'agent:reviewer'];
const deriveDaysRaw = Number(process.env.QA_LEAD_DERIVE_DAYS);
/** How far back a follow-up is still a candidate — a positive integer, else 14. */
export const DERIVE_DAYS = Number.isInteger(deriveDaysRaw) && deriveDaysRaw > 0 ? deriveDaysRaw : 14;
// Loose on whitespace on purpose: ANY spelling of a marker means someone decided.
const ANY_MARKER_RE = /<!--\s*qa:project\s+\d+\s*-->/;
const SURFACED_RE = /Surfaced by PR #(\d+)/g;

/** The one PR a follow-up says surfaced it, or null when it names none or several. */
export function surfacedByPr(body) {
  const prs = new Set([...String(body ?? '').matchAll(SURFACED_RE)].map((m) => Number(m[1])));
  return prs.size === 1 ? [...prs][0] : null;
}

/** Open reviewer follow-ups with no marker anywhere and exactly one surfacing PR. */
export function followUpCandidates(issues) {
  return (issues ?? []).filter((i) => {
    const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
    return (i.state ?? 'OPEN') === 'OPEN'
      && REVIEWER_FOLLOW_UP.every((l) => labels.includes(l))
      && !ANY_MARKER_RE.test(String(i.body ?? ''))
      && surfacedByPr(i.body) != null;
  });
}

/** Which active projects a PR is the work of. Pure.
 *  @param {{closes: number[], files: string[]}} pr
 *  @param {Map<number, number>} memberOf  issue number → active project
 *  @param {Set<number>} active */
export function projectsOfPr(pr, memberOf, active) {
  const found = new Set();
  for (const n of pr?.closes ?? []) if (memberOf.has(n)) found.add(memberOf.get(n));
  for (const f of pr?.files ?? []) {
    const m = /^docs\/projects\/(\d+)\.md$/.exec(f);
    if (m && active.has(Number(m[1]))) found.add(Number(m[1]));
  }
  return [...found];
}

/** Can a follow-up still join this project? Not once its tracking issue is closed, or
 *  this tick's decision closes it — its retro is written, and would never name it. */
export const joinable = (world, decision) =>
  world?.trackingClosed !== true && !(decision?.actions ?? []).some((a) => a.kind === 'close-project');

/** Members of every world this tick read, and the tracking issues themselves. */
export function membersOf(worlds) {
  const memberOf = new Map();
  const active = new Set();
  for (const w of worlds ?? []) {
    const p = Number(w.project);
    active.add(p);
    memberOf.set(p, p);
    for (const i of w.all ?? []) memberOf.set(i.number, p);
  }
  return { memberOf, active };
}

/**
 * The marker appends this tick makes. Pure given `prFor`, which may return null for an
 * unreadable PR (that PR is retried the next time its bucket comes round).
 *
 * ROTATED, SO THE WHOLE WINDOW IS COVERED (the Reviewer, RA-2433). A plain newest-first walk
 * with a read cap read the SAME 30 PRs every hour — nothing records a "no project"
 * answer — and never reached the backlog: measured on 2026-09-25, 82 distinct
 * surfacing PRs, two of whose follow-ups (RA-2163 via PR RA-2145, RA-1994 via PR RA-1991)
 * traced to project 1019 past the cap. So the distinct PRs are split into
 * `buckets = ceil(PRs / readCap)` by `pr % buckets`, and this tick reads bucket
 * `tick % buckets`. A PR's bucket depends only on its own number, so issues filed or
 * aged out between ticks do not shift anyone out of turn: while the bucket count holds,
 * every PR is read within `buckets` consecutive ticks. Stateless — no cursor to store.
 * A bucket averages `readCap` reads; its hard bound is the listing's 200.
 *
 * @returns {{append: {number: number, project: number, pr: number}[],
 *            capped: number, unexamined: number, buckets: number, bucket: number}}
 */
export function deriveMembership(candidates, { memberOf, active, prFor, cap = MIRROR_PER_TICK, tick = 0 }) {
  const readCap = cap * 3;
  const prs = [...new Set(candidates.map((c) => surfacedByPr(c.body)))];
  const buckets = Math.max(1, Math.ceil(prs.length / readCap));
  const bucket = ((tick % buckets) + buckets) % buckets;
  const traced = new Map(prs.filter((n) => n % buckets === bucket).map((n) => [n, prFor(n)]));
  const append = [];
  let capped = 0;
  let unexamined = 0;
  for (const c of candidates) {
    const n = surfacedByPr(c.body);
    if (!traced.has(n)) { unexamined++; continue; }
    const projects = projectsOfPr(traced.get(n), memberOf, active);
    if (projects.length !== 1) continue;
    if (append.length >= cap) { capped++; continue; }
    append.push({ number: c.number, project: projects[0], pr: n });
  }
  return { append, capped, unexamined, buckets, bucket };
}

/** The PR's closing issues and changed files, or null. */
export function prTraceRead(pr, { json }) {
  try {
    const v = json(['pr', 'view', String(pr), '--repo', REPO, '--json', 'closingIssuesReferences,files']);
    return {
      closes: (v.closingIssuesReferences ?? []).map((r) => r.number),
      files: (v.files ?? []).map((f) => f.path),
    };
  } catch {
    return null;
  }
}

/**
 * Read, decide, and (with `apply`) append. Called once per tick from `main`, after every
 * project is reconciled, because "exactly one project" needs every world at once.
 * Every read and edit is caught: membership is a reporting surface and must never
 * turn a tick red.
 */
export function deriveFollowUps(worlds, { run = gh, apply = APPLY, now = Date.now(), days = DERIVE_DAYS } = {}) {
  if (!(worlds ?? []).length) return { append: [], capped: 0, unexamined: 0, buckets: 1, bucket: 0 };
  // ONE SEAM: every read and write goes through `run`, so a unit test stubs one function.
  const json = (args) => JSON.parse(run(args));
  let found;
  try {
    const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    found = json(['issue', 'list', '--repo', REPO, '--state', 'open',
      ...REVIEWER_FOLLOW_UP.flatMap((l) => ['--label', l]),
      '--search', `created:>=${since}`, '--limit', '200', '--json', 'number,state,labels,body']);
  } catch (err) {
    warn(`could not list reviewer follow-ups, so no membership was derived this tick — ${ghCause(err)}`);
    return { append: [], capped: 0, unexamined: 0, buckets: 1, bucket: 0 };
  }
  // No silent caps: a full page means some follow-ups were never looked at.
  if ((found ?? []).length >= 200) warn(`listed 200 reviewer follow-ups from the last ${days} days — the limit — so older ones were not considered for membership this tick`);
  const plan = deriveMembership(followUpCandidates(found), {
    ...membersOf(worlds), prFor: (n) => prTraceRead(n, { json }), tick: Math.floor(now / 3_600_000),
  });
  const lines = plan.append.map((a) => `- #${a.number} → project #${a.project} (surfaced by PR #${a.pr}, RA-2412)`);
  if (lines.length || plan.capped || plan.unexamined) {
    // Each sentence says only what the rotation guarantees (the Reviewer, RA-2433): a
    // candidate is re-examined when ITS bucket comes round, not "next tick".
    const text = ['', `**Follow-up membership derived${apply ? '' : ' (dry run)'}:**`, '', ...lines,
      ...(plan.capped ? [`- ${plan.capped} more matched a project but exceeded the per-tick edit cap; they are re-found when bucket ${plan.bucket} comes round again, within ${plan.buckets} tick(s)`] : []),
      ...(plan.unexamined ? [`- ${plan.unexamined} candidate(s) not examined this tick: their surfacing PRs are in the other ${plan.buckets - 1} bucket(s) of ${plan.buckets} — every PR is read once every ${plan.buckets} tick(s)`] : []), ''].join('\n');
    console.log(text);
    writeStepSummary(text);
  }
  if (!apply) return plan;
  for (const a of plan.append) {
    try {
      // RE-READ BEFORE WRITING, as the adopt arm does: the listed body may be stale,
      // and a marker someone added since must win.
      const body = json(['issue', 'view', String(a.number), '--repo', REPO, '--json', 'body']).body ?? '';
      if (ANY_MARKER_RE.test(body)) continue;
      run(['issue', 'edit', String(a.number), '--repo', REPO, '--body',
        [body.trimEnd(), '', `<!-- qa:project ${a.project} -->`].join('\n')]);
    } catch (err) {
      warn(`#${a.number}: could not append project #${a.project}'s marker — ${ghCause(err)}`);
    }
  }
  return plan;
}

/**
 * The review fields this world carries, from what `gh pr view --json reviews` returns.
 *
 * EXTRACTED SO IT CAN BE TESTED (RA-1690). Its caller — `linkedPrsRead`, named
 * `linkedPrs` when RA-1690 was written and unexported until RA-2107 gave it a `json`
 * seam — is an io function, so for as long as this projection lived inline inside
 * it, nothing could observe the projection —
 * and dropping a field from it broke no test. That is not hypothetical: `submittedAt`
 * was ABSENT here, which is precisely why the revise lane had no clock but
 * `headPushedAt` and PR RA-1660 parked for two days. A guard that cannot fail is worse
 * than none, so the projection is a pure function with a test rather than a line inside
 * a `try`.
 *
 * `submittedAt` normalises to `null` rather than `undefined` so a review that lacks one
 * is explicitly undated — every consumer treats that as "no clock" and fails closed.
 */
export function projectReviews(reviews) {
  return (reviews ?? []).map((rv) => ({
    state: rv.state,
    sha: rv.commit?.oid,
    // WHAT THE REVIEW READ (RA-1725): the reviewer job's `<!-- reviewed: sha=… -->` stamp,
    // parsed here so the world carries the SHA rather than every review body. `null`
    // when unstamped, and `evidenceSha` then falls back to `sha`.
    reviewedSha: readTrailer(rv).reviewedSha,
    submittedAt: rv.submittedAt ?? null,
  }));
}

/**
 * The PRs GitHub itself says would close this issue, with the reviews needed to tell
 * "waiting on the implementer" from "in progress" — AND whether the read succeeded.
 *
 * ⚠️ `ok` IS THE WHOLE POINT, and it replaced a bare `catch { return []; }` (RA-2107).
 * Failing to read is still not BLOCKING — an unreadable PR must not be reported as a
 * stall, so `prs` is `[]` exactly as before and every consumer of it is unchanged.
 * But `[]` alone made "no PR" and "I could not find out" the same value, and
 * `isParkedOnHuman` gates on emptiness: on a `gh` blip an issue with a live PR read
 * as parked and freed its slot. `ok` is what lets that check fail CLOSED for real
 * rather than in its docblock only.
 *
 * There is ONE caller. An earlier draft kept a `linkedPrs` wrapper "for callers that
 * cannot act on the difference" — there were none, so it and its claim are gone.
 *
 * INJECTABLE (`json`), the same seam `closingMergeShas` uses and for the same reason
 * (RA-1061): the `ok: false` arm only runs on a bad day, so without a seam it is
 * reachable by no test. Mutating `ok: false` to `ok: true` passed a full green tier
 * before this was added — the exact shape RA-2106 was filed about, one level up.
 */
export function linkedPrsRead(issueNumber, { json = ghJson } = {}) {
  try {
    const refs = json(['issue', 'view', String(issueNumber), '--repo', REPO, '--json', 'closedByPullRequestsReferences'])
      .closedByPullRequestsReferences ?? [];
    const prs = refs.map((r) => {
      const pr = json(['pr', 'view', String(r.number), '--repo', REPO, '--json',
        `state,headRefOid,reviews,commits,number,${CONFLICT_JSON}`]);
      return {
        number: pr.number,
        state: pr.state,
        headSha: pr.headRefOid,
        // THE ONE CALL SITE IN THIS FILE, and it is deliberately the READ (RA-1722).
        // `conflictState` throws when the object carries neither mergeability field,
        // so trimming the `--json` list above reds this tick with a message naming the
        // fix — rather than answering "not conflicting" for every PR in the project
        // and silently restoring the 25-no-op-churn behaviour. Consumers downstream
        // read this boolean, so none of them has to remember to ask.
        conflicting: blocksChurn(conflictState(pr)),
        // When the head commit landed, for the "nobody reviewed this" age signal
        // (RA-1081). `commits` is newest-last, so the last one is the head.
        headPushedAt: pr.commits?.at(-1)?.committedDate ?? null,
        reviews: projectReviews(pr.reviews),
      };
    });
    return { prs, ok: true };
  } catch (err) {
    // A TRIMMED `--json` LIST IS NOT A BAD DAY. Everything else here degrades to
    // `ok: false`, which the caller treats as "this issue's PRs are unknown" and moves
    // on — the right answer for a 502 and the wrong one for a code defect that would
    // otherwise report itself hourly as a transient read failure while the conflict
    // detector answered "clear" for every PR in the project (RA-1722).
    if (err instanceof ConflictFieldsUnread) throw err;
    warn(`could not read #${issueNumber}'s linked PRs: ${err.message}`);
    return { prs: [], ok: false };
  }
}


/** How many times the Explorer has verified this project, and when he last did.
 *  Counted from HIS OWN marker comments — a human quoting the marker is not a
 *  round, the lesson RA-1079 learned the hard way. */
function readQaRounds(qaNumber) {
  try {
    const comments = ghJson(['issue', 'view', String(qaNumber), '--repo', REPO, '--json', 'comments']).comments ?? [];
    const mine = comments.filter((c) =>
      (c.author?.login ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '') === EXPLORER_LOGIN
      && (c.body ?? '').includes(QA_MARKER));
    return { rounds: mine.length, roundsAt: mine.map((c) => c.createdAt), lastVerifiedAt: mine.at(-1)?.createdAt ?? null, readable: true };
  } catch {
    // ITS OWN STATE. The first version returned `lastVerifiedAt: new Date(0)` with a
    // comment claiming it "stalls rather than loops" — 1970 is BEFORE every closedAt
    // this phase can see, so it was behaviourally identical to `null` and did the
    // looping the comment said it prevented: an Explorer run every hour, forever.
    //
    // `new Date()` would stall, but silently and for the wrong reason. An unreadable
    // count is not evidence about verification either way, so it says so and stops.
    return { rounds: 0, lastVerifiedAt: null, readable: false };
  }
}

/** When a HUMAN removed `needs:human` from the tracking issue (kanon#186), for
 *  `qaRoundBudget`. A bot's removal is not a human's decision. An unreadable event list
 *  is no clears at all, which keeps the hold — the direction that cannot run the Explorer
 *  without a human. INJECTABLE for the unit tier. */
export function heldClearsRead(project, { text = gh } = {}) {
  try {
    return text(['api', '--paginate', `repos/${REPO}/issues/${project}/events`, '--jq',
      `.[] | select(.event == "unlabeled" and .label.name == "${HELD}" and .actor.type == "User") | .created_at`])
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    warn(`could not read #${project}'s label events, so whether a human cleared its \`${HELD}\` is UNKNOWN — keeping the QA round bound: ${err.message}`);
    return [];
  }
}

/** This project's phase-5 QA issue, and whether its label had to be recovered (RA-1286).
 *
 *  SEPARATED FROM `readWorld` so it can be tested at all — `readWorld` shells out to
 *  `gh` for everything else it does, which is why every property of this join has, until
 *  now, been unreachable from the unit tier.
 *
 *  @param {{number: number, title: string, body?: string, labels: string[]}[]} all
 *  @param {string|number} project
 *  @returns {{issue: any, labelMissing: boolean}}
 */
export function qaIssueOf(all, project) {
  const labelled = all.find((i) => i.labels.includes(VERIFY));
  if (labelled) return { issue: labelled, labelMissing: false };
  // ANY ENVIRONMENT IN THE TITLE (kanon#199): the title names the declared environment now,
  // and named `staging` before, so an open QA issue filed under either is recovered rather
  // than re-filed with its round count reset.
  const orphan = all.find((i) => isQaIssueTitle(i.title, project) && (i.body ?? '').includes(QA_BODY_ANCHOR));
  if (!orphan) return { issue: undefined, labelMissing: false };
  orphan.labels = [...orphan.labels, VERIFY];
  warn(`#${orphan.number} is this project's phase-5 QA issue but carries no \`${VERIFY}\` label — most likely a tick died between the remove and the re-add of the verification churn (RA-1286). Treating it as the QA issue so nothing files a duplicate or dispatches an implementer at it; the next \`verify\` action re-applies the label.`);
  return { issue: orphan, labelMissing: true };
}

/**
 * Is this issue's implement lane waiting on a HUMAN? (RA-2038)
 *
 * Delegates to the dispatch sweep's `classify`, the repo's one definition of that
 * state. `awaiting-human` is its fallback arm — the last non-sweep comment is a
 * bot's and older than 48h — which covers the agent asking a question, the agent
 * bailing, AND the agent crashing or being capped mid-run. It never inspects the
 * prose to tell those apart, by design. This caller does not need it to: all of
 * them mean no agent is running, which is the whole of what a quota cap asks.
 *
 * THE 48h WINDOW NOW COVERS BOTH STATES (RA-2112). `awaiting-human` is `classify`'s
 * terminal `else`, so it is gated on staleness there; `human-held` is decided ABOVE
 * `in-flight` and has no freshness gate of its own — a human replying while an
 * implementer is mid-run (it comments only when it finishes) reads as `human-held`
 * with a run genuinely in progress. So this caller supplies the gate `classify` does
 * not: `human-held` frees a slot only once the conversation's last word is older than
 * the sweep's own `STALE_HOURS`. Evaluated HERE rather than in `classify`, because the
 * sweep's dispatch decisions depend on `human-held` meaning exactly what it means
 * today, and after the window the ordinary RA-2038 case — a human replied to the sweep
 * and then nothing ran for days — still frees its slot.
 *
 * FAILS CLOSED. An unreadable comment list returns `null`, so the issue keeps its
 * slot. The opposite default would free a slot on a `gh` blip and dispatch beyond
 * the cap — the cap's whole justification is quota, so erring toward holding is the
 * safe direction.
 */
export function laneStateOf(number, { labels = [], comments = commentsFor, classify = classifyLane } = {}) {
  try {
    // The REAL labels, not `[]` (RA-2103 review). `classify` reads them only through
    // `terminalVerdict`, and since kanon#170 the implement lane declares one
    // (`qa:needs-info`, which `isParkedOnHuman` also reads first) — so `[]` would now
    // misreport a human-parked issue's lane state.
    const v = classify({ number, labels }, comments(number), false);
    // `lastAt` is the conversation's last word — what the RA-2112 gate ages.
    return { state: v.state, lastAt: v.last?.createdAt ?? null };
  } catch (err) {
    warn(`could not read #${number}'s comments, so whether it is parked on a human is UNKNOWN — counting it against WIP: ${err.message}`);
    return { state: null, lastAt: null };
  }
}

/** Cached across a tick, so two projects naming the same issue read it once. */
const commentsFor = makeCommentsReader();

/**
 * Is this issue parked on a human? The DECISION, separated from its inputs (RA-2106).
 *
 * Pure, so the three ways it can fail closed are testable without a `gh` seam:
 * an unreadable PR list (`prOk: false`), an unreadable comment list
 * (`laneState: null`), and a live PR (`hasPr`). `readWorld` supplies the inputs.
 *
 * @param {object} [o]
 * @param {string[]} [o.labels]    the issue's label names
 * @param {string} [o.state]       GitHub issue state, `OPEN` or `CLOSED`
 * @param {boolean} [o.hasPr]      a PR closing this issue is open
 * @param {boolean} [o.prOk]       the PR read SUCCEEDED (RA-2107) — false means unknown
 * @param {string|null} [o.laneState] `classify`'s state, or null if unreadable
 * @param {string|null} [o.laneLastAt] the conversation's last comment, ISO — ages `human-held` (RA-2112)
 * @param {number} [o.now]
 * @param {number} [o.staleHours] the sweep's `STALE_HOURS`
 * @returns {boolean}
 */
export function isParkedOnHuman({
  labels = [], state = 'OPEN', hasPr = false, prOk = true, laneState = null,
  laneLastAt = null, now = Date.now(), staleHours = STALE_HOURS,
} = {}) {
  // The implementer's own "I asked a question" label, and it needs no read at all.
  if (labels.includes(NEEDS_INFO)) return true;
  // A human owes this ITEM an action, by declaration (RA-1301). It is never dispatched,
  // so it can never be running.
  if (labels.includes(HUMAN_ACTION)) return true;
  // Only a dispatched, open issue can occupy a slot in the first place.
  if (!labels.includes(IMPLEMENT) || state !== 'OPEN') return false;
  // FAIL CLOSED, both ways. A live PR means work is happening; a PR list that could
  // not be READ is not evidence of its absence (RA-2107), and neither is an
  // unreadable comment list. Any of the three keeps the slot.
  if (hasPr || !prOk) return false;
  if (!PARKED_LANE_STATES.has(laneState)) return false;
  // `human-held` IS PARKED ONLY ONCE IT IS STALE (RA-2112) — see `laneStateOf`. An
  // undated last word is not evidence of age, so it keeps the slot.
  if (laneState === 'human-held') {
    const at = Date.parse(laneLastAt ?? '');
    return Number.isFinite(at) && (now - at) / 3600_000 >= staleHours;
  }
  return true;
}

/**
 * The `classify` states that mean a human owes this issue an answer (RA-2108).
 *
 * `human-held` is the one RA-2038 missed, and it is the state literally named for
 * this condition: `dispatch-sweep.mjs` sets it when a human replied to the SWEEP
 * rather than to the agent — *"Held for a human on purpose. The escape hatch the
 * sweep advertises is 'remove the label', but answering in prose is the natural
 * thing to do and must not be punished with another dispatch."* So the sweep stops
 * dispatching it and RA-2038 went on charging it a slot: RA-2038's own bug, surviving
 * in the state named for its condition.
 *
 * `has-pr` is deliberately NOT here — it outranks both in `classify`'s chain and
 * means work is happening — and neither are `answered` or `never-ran`, which are
 * the sweep's two ACTIONABLE states: something is about to run.
 */
const PARKED_LANE_STATES = new Set(['awaiting-human', 'human-held']);

/** The declared environment's name, read once per tick: every project names the same one. */
let declaredEnvironmentRead;
const declaredEnvironment = () => {
  if (declaredEnvironmentRead === undefined) declaredEnvironmentRead = declaredEnvironmentFrom(REPO);
  return declaredEnvironmentRead;
};

function readWorld(project) {
  const briefPath = `docs/projects/${project}.md`;
  const briefMerged = existsSync(briefPath);
  // Kept on the world: the `project:<n>` mirror asks whether its label exists (RA-1783).
  // Only with a brief, as before: a project awaiting one has nothing to parse or mirror.
  const knownLabels = briefMerged ? repoLabels() : undefined;
  const proposed = briefMerged ? parseProposed(readFileSync(briefPath, 'utf8'), { knownLabels }) : [];

  // Everything carrying the project marker in its body, so no new label taxonomy
  // and no per-project milestone — AGENTS.md is deliberate that there are four
  // milestones, and a per-project one would corrupt the burndown.
  const found = ghJson(['issue', 'list', '--repo', REPO, '--state', 'all', '--search',
    `"qa:project ${project}" in:body`, '--limit', '200',
    '--json', 'number,title,state,labels,body,closedAt']);

  // GitHub issue search is TOKENISED full-text, not substring — a nearby number or
  // an unrelated body can match. This set gates everything (`filed.length <
  // proposed.length` is the only condition on the file phase, and the dedup set is
  // built from it), so one false positive would silently suppress filing the last
  // real issue. The body is already fetched, so re-check it exactly.
  // Re-checked by POSITION, not presence. The search is tokenised full-text and,
  // worse, cannot tell a document ABOUT the marker from one carrying it — all three
  // documents that discussed this mechanism were absorbed by it. This set gates
  // everything: a false positive silently suppresses filing a real issue, and a
  // false negative RE-FILES issues that already exist, which is unamendable.
  const all = found
    .filter((i) => declaresMembership(i.body, project))
    .map((i) => {
      // BY TITLE OR BY ADOPTION (RA-1213 review). An adopted issue keeps its OWN
      // title, which by construction never matches the brief's item title — if it
      // did, the file phase's dedup would have suppressed filing and no adoption
      // would have been needed. So a title-only join left every adopted issue with
      // `key: undefined` and `order: undefined`, and the consequences compound:
      // `byKey` never learns the item's key, so a LATER item's `**Depends on: Issue
      // B**` becomes a permanent `unfiledDeps` reported as "a brief defect, not a
      // wait" — which it is not, it is the adoption.
      //
      // `closes` is the join and it needs no new marker: the brief names the issue
      // number, so the item that named it is the item this issue belongs to.
      const fromBrief = proposed.find((p) => p.title === i.title)
        ?? proposed.find((p) => (p.closes ?? []).includes(i.number));
      // ONE SNAPSHOT, READ ONCE (RA-1207). `prs` and `reviewBlocked` each called
      // `linkedPrs` under the identical guard, so they described two different reads of
      // the same PR: a review landing between them left the report's `awaitingReview`
      // path (which consumes `prs`) disagreeing with its `stalled` line (which consumes
      // `reviewBlocked`) — a self-inconsistent tick report about the very question
      // RA-1081 exists to make trustworthy. It also doubled the PR reads, which at WIP 3
      // is ~6 extra `gh` calls a tick against the "two `gh` calls per tick" the cost
      // note claimed. Deriving both from one array makes the agreement structural.
      const prRead = (i.labels || []).some((l) => l.name === IMPLEMENT) && i.state === 'OPEN'
        ? linkedPrsRead(i.number)
        : { prs: [], ok: true };
      const prs = prRead.prs;
      const labels = (i.labels || []).map((l) => l.name);
      // PARKED ON A HUMAN — computed HERE, where the `gh` access already lives, so
      // `nextActions` stays pure (RA-2038). It is called speculatively for `demand`
      // on the exhausted-budget path, and a counter that fetched would make that
      // re-derivation cost a request per call.
      //
      // BOUNDED BY CONSTRUCTION, and cheaper than it looks. It asks only about
      // issues that already cost a `linkedPrs` read — `agent:implement` and OPEN,
      // at most `QA_LEAD_WIP` (3) per project — and only when that read came back
      // EMPTY, because an issue with a live PR is by definition not parked. So the
      // common tick adds zero calls: the slots that are working have PRs.
      //
      // `qa:needs-info` needs no read at all; it IS the label for "the implementer
      // asked a question".
      // Read the lane only when the cheap gates leave it decisive — the comment
      // fetch is the one cost here, and `isParkedOnHuman` is pure so it cannot do
      // it itself.
      const needsLane = prRead.ok && prs.length === 0
        && labels.includes(IMPLEMENT) && i.state === 'OPEN' && !labels.includes(NEEDS_INFO);
      const lane = needsLane ? laneStateOf(i.number, { labels }) : { state: null, lastAt: null };
      const parkedOnHuman = isParkedOnHuman({
        labels,
        state: i.state,
        hasPr: prs.length > 0,
        prOk: prRead.ok,
        laneState: lane.state,
        laneLastAt: lane.lastAt,
      });
      return {
        ...i,
        labels,
        parkedOnHuman,
        // The brief's ordinal, joined by the same key the file phase dedups on.
        // Without this the sort in nextActions compares undefined to undefined.
        order: fromBrief?.order,
        // The item's title as the BRIEF writes it, which is what the file phase
        // compares against. An adopted issue satisfies its item without carrying
        // its title, and nothing else can express that.
        briefTitle: fromBrief?.title,
        // Only for issues actually in flight — this is a PR read per issue, and
        // every other phase decides without it. `isReviewBlocked([])` is `false`, so
        // the not-in-flight branch keeps exactly the defaults it had.
        prs,
        reviewBlocked: isReviewBlocked(prs),
        // RA-2406 — only an OPEN member parked on a split pays for this read.
        split: labels.includes(SPLIT_LABEL) && i.state === 'OPEN' ? splitEvidenceRead(i.number) : undefined,
        key: fromBrief?.key,
        dependsOnKeys: fromBrief?.dependsOnKeys ?? [],
      };
    });

  // Resolve "Issue A" to the number of the issue actually filed for it. Done here
  // rather than in the parser because it needs the filed set — and a dependency on
  // something not yet filed must still hold the dependant back.
  const numberOfKey = new Map(all.filter((i) => i.key).map((i) => [i.key, i.number]));
  for (const i of all) {
    i.dependsOn = i.dependsOnKeys.map((k) => numberOfKey.get(k)).filter((n) => n != null);
    // A dependency the brief names but nothing has been filed for yet.
    i.unfiledDeps = i.dependsOnKeys.filter((k) => !numberOfKey.has(k));
  }

  const filed = all.filter((i) => i.number !== Number(project));
  const open = filed.filter((i) => i.state === 'OPEN');
  // A human owes an answer here; a tick must not paper over it by dispatching
  // something else and making the project look like it is progressing.
  // Only a member that GATES CLOSURE can block the project (RA-1783) — see `blockedOf`.
  const blocked = blockedOf(open, proposed);
  // AGENTS.md: no issue is filed without a milestone. The backstop workflow WILL
  // fire on the Lead's App-token `issues: opened` and route anything bare to Product
  // Backlog — which AGENTS.md names as the BAD outcome, not the covered one: "an
  // issue that should have been on the gate and gets defaulted to a bucket looks
  // correctly triaged and stops showing up in the query that finds mistakes." The
  // brief already decided the routing; refusing to file without it keeps that
  // decision from being silently discarded.
  const unmilestoned = proposed.filter((p) => !p.milestone);

  // Only derived when it can change the answer — phase 4 is unreachable otherwise,
  // and this is ~30 gh calls. The earlier gate said so and then under-checked:
  // `briefMerged && all.length && !open.length` still ran on a brief that did not
  // parse, on one waiting for a human, and on one with issues left to file, all of
  // which return their own phase long before phase 4 is consulted.
  const parsedFully = proposed.length && !proposed.residue?.length;
  // THE THIRD COPY (RA-1213 review). Title-only here meant `deploy` was never computed
  // for any brief with an adopting item — `readDeploy` never ran, `phaseOf` fell back
  // to `awaiting-release`, and the project reported "no release contains their merges
  // yet" hourly, forever, with every issue closed and the work long since shipped.
  const nothingLeftToFile = proposed.every((pr) => itemSatisfied(pr, all));
  // PHASE 5's subject. It is a project issue like any other — same membership
  // marker, which is what lets the Explorer's findings join with no new machinery — and it
  // is identified by its label, not its title, so a reworded title cannot orphan it.
  //
  // ── THE ORPHAN WINDOW, AND WHY THE LABEL ALONE IS NOT ENOUGH (RA-1286) ──────────
  //
  // `qa:verify` carries TWO jobs since RA-1281: it is how this line finds the issue, and
  // it is the TRIGGER for `agent-verify-acs.yml` — and re-adding a label an issue
  // already carries fires nothing, so the tick must remove it first. Between those two
  // `gh` calls the QA issue carries no marker, and a tick that dies, is cancelled, or
  // whose second call fails leaves it there.
  //
  // What that costs is not one lost trigger. Without the label the issue is ordinary
  // OPEN WORK: `phaseOf` returns `reconcile`, and the reconcile arm would DISPATCH AN
  // IMPLEMENTER AT THE VERIFICATION ISSUE — the exact outcome the `VERIFY` exclusion
  // was written to prevent. Get past that and `phaseOf` returns `file-qa` and files a
  // SECOND QA issue, whose round count starts at 0, re-arming a two-round bound that
  // was already spent.
  //
  // RECOVERED BY CONTENT, AND THE PRECISION IS THE POINT. Both anchors are written by
  // `execute`'s own `file-qa` arm — the title template above and the `gh workflow run`
  // snippet in the body — so an Explorer finding cannot match, and neither can a project
  // issue that merely discusses the workflow (which, in this repo, several do). A
  // human who REWORDS the title defeats the recovery and gets today's behaviour back;
  // that is the deliberate direction to fail, because the alternative — matching
  // loosely — files nothing and mistakes a finding for the QA issue.
  //
  // THE LABEL IS SYNTHESISED IN MEMORY, not just noted. Every downstream reader asks
  // `labels.includes(VERIFY)` — `open`/`openWork` here, `phaseOf`'s work view,
  // `needsVerification`'s exclusion — and patching each one is three chances to miss
  // the fourth. Restoring it on the object restores all of them at once. The REAL
  // label comes back on the next `verify` action, whose remove is now allowed to fail
  // exactly as its `review-churn` sibling's is.
  const { issue: qa, labelMissing: qaLabelMissing } = qaIssueOf(all, project);

  // The QA issue is not implementation work; excluding it here is what stops phase
  // 4 waiting on it forever.
  // The gating set, as `phaseOf` draws it (RA-1783) — and only gating members' merges
  // are waited for on the reference environment: a carried-out follow-up's release is not the project's.
  const openWork = openGatingWork(open, proposed);
  const deploy = briefMerged && parsedFully && nothingLeftToFile && all.length && !openWork.length && !blocked.length
    ? readDeploy(all.filter((i) => gatesClosure(i, proposed)))
    : undefined;
  // Read for EVERY state that can reach phase 6, not just `deployed`. Gating on
  // `deployed` alone left `nothing-to-deploy` with `trackingClosed: undefined`
  // forever, so `phaseOf` returned `close` on every tick and the project was
  // re-closed with a fresh retro each hour — the close was not idempotent, which
  // is the one property the derived-state design is supposed to give for free.
  const trackingClosed = reachesPhase6(deploy?.state)
    ? ghJson(['issue', 'view', String(project), '--repo', REPO, '--json', 'state']).state === 'CLOSED'
    : undefined;

  // PAID ONLY WHERE IT IS READ (RA-1103). `readQaRounds` is a full `gh issue view
  // --json comments`, and it ran on EVERY tick once a project had a QA issue — a
  // `file` / `reconcile` / `blocked` tick returns its phase long before anything
  // consults `rounds`, `lastVerifiedAt` or `readable`, so the call was bought for
  // nothing every hour. The file already applies this discipline one function over:
  // `reviewBlocked` is computed only for issues actually in flight.
  //
  // The gate is "can this tick reach phase 5 or 6", which is exactly the terminal
  // deploy states — the `DEPLOY_PHASE` entries mapping to `null`, i.e. the ones that
  // fall through rather than returning a deploy phase. Keyed off that table rather
  // than a second list of state names: `reachesPhase6` is that test and already
  // exists, so there is no second copy to drift.
  //
  // NOTE THE CLOSE PATH. `readWorld` reads rounds for the QA issue regardless of its
  // STATE, and RA-1095 now depends on that: a closed QA issue with `rounds === 0` is
  // how the retro knows nobody verified anything. A gate on `qa.state === 'OPEN'`
  // would have removed exactly that evidence and reinstated the false claim.
  const qaRounds = qa && reachesPhase6(deploy?.state) ? readQaRounds(qa.number) : {};
  const qaIssue = qa
    ? {
        number: qa.number,
        state: qa.state,
        // RA-1286 — the label was recovered, not read. Reported, so the state is visible
        // rather than silently repaired.
        labelMissing: qaLabelMissing,
        // the Explorer's own marker comments, the same derived-state discipline as every
        // other cap here: no bookkeeping, and it survives a re-run.
        ...qaRounds,
        // Paid only once the bound is reached, which is the only time it is read (kanon#186).
        ...(qaRounds.readable && qaRounds.rounds >= QA_ROUND_CAP ? { clearedAt: heldClearsRead(project) } : {}),
      }
    : null;
  // WAS IT CLOSED BY THIS TICK, AND REOPENED SINCE? (RA-1062)
  //
  // Phase 6's "a re-run is a no-op, not a second retro" property held only while the
  // issue stayed closed. Reopening it is the natural way for a human to say *this
  // project is not done* — and the next hourly tick re-derived `close`, posted the
  // retro again and closed it again. Within the hour, every time, with no escape
  // hatch: `blocked` is consulted on the FILED issues, never on the tracking issue,
  // so the one issue a human is most likely to act on sat outside the pipeline's own
  // rule that a tick must not route around a question a human owes an answer to.
  //
  // Derived, like everything else: our own retro marker is on the issue and the issue
  // is open, so a close already happened and someone undid it.
  const trackingReopened = (() => {
    if (trackingClosed !== false) return false;
    try {
      const seen = gh(['issue', 'view', String(project), '--repo', REPO, '--json', 'comments',
        '--jq', '[.comments[].body] | join("\n")']);
      return seen.includes(RETRO_MARKER);
    } catch {
      // Unreadable comments must not read as "never closed" — that resumes a project
      // a human may have stopped. Treat it as reopened and say nothing further.
      warn(`could not read #${project}'s comments, so whether a human reopened it is UNKNOWN — holding`);
      return true;
    }
  })();

  // READ, NOT ASSUMED. An unreadable tracking issue must not read as "not held" — that
  // is the direction that resumes a project a human stopped. Failing to read is itself
  // a reason to hold: the tick cannot establish that acting is safe.
  let projectHeld;
  try {
    projectHeld = (ghJson(['issue', 'view', String(project), '--repo', REPO, '--json', 'labels'])
      .labels ?? []).some((l) => l.name === HELD);
  } catch {
    projectHeld = true;
    warn(`could not read #${project}'s labels, so whether this project is held is UNKNOWN — holding rather than acting`);
  }

  // THE LABEL'S HOLDERS, read separately from the marker's (RA-1783). The body search
  // above finds marker-carriers; an issue carrying `project:<n>` whose marker is gone
  // (a human appended below it, RA-1069) is only findable by the label. `undefined` on a
  // failed read, so the mirror removes nothing it could not see.
  let labelled;
  if (briefMerged) try {
    labelled = ghJson(['issue', 'list', '--repo', REPO, '--state', 'all', '--label', projectLabel(project),
      '--limit', '200', '--json', 'number,body']);
  } catch {
    labelled = undefined;
  }

  // The environment's name for the report, at any phase (kanon#219). Read softly: only the deploy
  // phase, through `readDeploy`, may fail on a missing or malformed record (`K-PROJ-11`).
  const environment = deploy?.environment ?? declaredEnvironment();
  return { project, briefMerged, briefPath, proposed, filed, open, blocked, unmilestoned, all, deploy, environment, qaIssue, trackingClosed, trackingReopened, projectHeld, searchHits: found.length, searchTitles: found.map((i) => i.title), knownLabels, labelled };
}

// ---------------------------------------------------------------------------
// Report — what it examined, not only what it did (agentic-qa-pipeline.md §5)

// NOT dry-run-only: `main` calls this BEFORE `execute`, unconditionally, so every
// string here lands in the step summary of the real APPLY tick. Three separate
// copies of "deployed in `(untagged)`" had to be found — the retro, the close
// comment, and this action line — each in its own artifact, each contradicting the
// issue the same run wrote. `renderCloseAction` exists so there is ONE of it.
/** The comment written when the tracking issue is closed.
 *
 *  EXTRACTED so a test can reach it (RA-1064). This string, `retro`'s opening line and
 *  `report`'s completion line are three copies of one fact, and the untagged case was
 *  fixed in each of them on three consecutive review rounds — every fix a one line
 *  string change, every one verified by eye, every one leaving the next copy behind.
 *  Nothing in `tests/` contained "Closed by the Lead" or "NOTHING was deployed", so the
 *  only mechanism available was a reviewer re-reading the file. */
export function renderCloseComment(a) {
  return a.tag
    ? `Closed by the Lead: every issue from the brief is closed and the work is on ${envName(a.environment)} in \`${a.tag}\`.${ownFailureCaveat(a)} See the retro above.`
    : 'Closed by the Lead: every issue from the brief is closed, and NOTHING was deployed — no merged PR closed any of them. See the retro above.';
}

export function renderCloseAction(a) {
  return `- **close project #${a.number}** — every issue closed, ${a.tag ? `deployed in \`${a.tag}\`` : '**nothing deployed** (no merged PR closed any of them)'}; writes the retro and pings the developer`;
}

/**
 * @param {any} world
 * @param {{phase: string, actions: any[], stopped?: string|null, escalate?: any,
 *          escalateKind?: 'action'|'defect'|'stop',
 *          reviewNotes?: {lane?: string, pr: number, sha: string, why: string}[]}} decision
 */
export function report(world, { phase, actions, stopped, reviewNotes = [] }) {
  const lines = [
    `## The Lead — reconcile tick, project #${world.project}\n`,
    `**Phase:** \`${phase}\`${APPLY ? '' : ' *(dry run)*'}\n`,
    '| Examined | |',
    '|---|---|',
    `| brief \`${world.briefPath}\` | ${world.briefMerged ? 'on `main`' : '**not merged** — the developer has not approved this project'} |`,
    `| issues the brief proposes | ${world.proposed.length} (section ended at ${world.proposed.endedAt ?? 'n/a'}) |`,
    `| search hits, after the exact re-check | ${world.searchHits} → ${world.all.length} |`,
    `| lines the parser discarded | ${world.proposed.reduce((n, p) => n + (p.droppedLines?.length ?? 0), 0)} |`,
    `| closing references not on a metadata line | ${world.proposed.reduce((n, p) => n + (p.droppedCloses?.length ?? 0), 0)} |`,
    `| filed | ${world.filed.length} |`,
    `| open | ${world.open.length} |`,
    `| blocked, awaiting a human | ${world.blocked.length} |`,
    // Reported unconditionally, including as 0. A row that appears only when
    // non-zero cannot distinguish "none were parked" from "the check did not run".
    `| in flight, occupying a slot | ${world.open.filter((i) => occupiesSlot(i) && isProjectWork(i, world.proposed)).length} |`,
    `| parked on a human, slot freed (RA-2038) | ${world.open.filter((i) => i.labels.includes(IMPLEMENT) && i.parkedOnHuman).length} |`,
    // A detector reports what it EXAMINED, not only what it found. `not read` is a
    // real and distinct answer here — phase 4 is unreachable while an issue is
    // open, so the deploy chain is deliberately not queried, and printing nothing
    // would make "not looked at" indistinguishable from "looked and found nothing".
    `| deploy to ${deployEnvironment(world)} | ${world.deploy ? `${world.deploy.state}${world.deploy.tag ? ` (\`${world.deploy.tag}\`)` : ''}` : 'not read — issues still open'} |`,
    // BOTH SETS, ALWAYS (RA-1783) — including as 0, for the reason the rows above give.
    `| carried out — open members outside the project's work, not holding it open (RA-1783) | ${carriedOut(world).length} |`,
    ...(() => {
      const m = labelMirror(world);
      return [`| \`${m.label}\` label mirror | ${m.create ? 'label to create; ' : ''}+${m.add.length} / −${m.remove.length}${m.deferred ? ` (${m.deferred} deferred to the next tick)` : ''}${world.labelled === undefined ? '; label holders unreadable, nothing removed' : ''} |`];
    })(),
    '',
    // WHICH ONES, by number and severity (RA-1783): a count cannot say which follow-up a
    // project left behind, and "RA-1015 is done, and it left RA-1452 behind" is the point.
    ...(() => {
      const out = carriedOut(world);
      return out.length
        ? ['', '**Carried out** — members of this project that do not hold it open (outside the decomposition, no `sev:high`/`sev:critical`). Never dispatched by this tick; each keeps its own milestone routing:', '',
           ...out.map((i) => `- #${i.number} \`${severityOf(i)}\` — ${i.title}`), '']
        : [];
    })(),
    // AFTER THE TABLE, NOT INSIDE IT (RA-1456). These were spliced between the count
    // rows, each wrapped in blank lines — which TERMINATES the GFM table, so
    // `| filed |` onward rendered as literal pipe-separated text with no delimiter row
    // above it. The rows that stopped rendering are the counts a human reads at close.
    //
    // The counts stay in the table and the detail follows it, which is the same split
    // RA-1006 argued for in the first place: a count says how many, the block says which.
    // AND WHAT THEY WERE (RA-1006). The count alone reads `1` on the only real brief
    // that exists AND on a brief whose body sentence the parser ate — the healthy
    // value and the defect value are the same number, with nothing to tell them apart.
    // A discard is not necessarily wrong (a wrapped metadata continuation is meant to
    // go), so this is evidence to read rather than a failure; printing it is what
    // makes the difference checkable at all.
    ...(() => {
      const dropped = world.proposed.flatMap((p) => (p.droppedLines ?? []).map((l) => ({ title: p.title, line: l })));
      return dropped.length
        ? ['', '**Lines the parser discarded** — a wrapped metadata continuation is expected here; a sentence from an issue body is not:', '',
           ...dropped.slice(0, 20).map((d) => `- \`${d.title}\`: ${d.line.slice(0, 120)}`),
           ...(dropped.length > 20 ? [`- …and ${dropped.length - 20} more`] : []), '']
        : [];
    })(),
    // AND WHICH REFERENCES THEY WERE (RA-1352) — the RA-1006 treatment, applied to the row
    // that got the first half of it and not the second. `| closing references not on a
    // metadata line | 1 |` reads the same on a healthy brief and on one whose `Closes
    // #N` the parser could not adopt, with nothing to tell them apart.
    //
    // IN EVERY PHASE, WHICH IS THE POINT. The `stopped:` message does name every stray
    // reference — inside `if (phase === 'file')`. Once every proposed item is filed the
    // phase is `dispatch`, that branch is unreachable, and a human who then edits the
    // brief to add a marker into an item body gets the bare count and no way to learn
    // which item or which number. The two overlap only in the `file` phase, where the
    // duplication is two lines and the alternative is a block that disappears exactly
    // when the count stops being explained.
    ...(() => {
      const dc = world.proposed.flatMap((p) => (p.droppedCloses ?? []).map((n) => ({ title: p.title, number: n })));
      return dc.length
        ? ['', '**Closing references the parser did not read** — a `Closes #N` is adopted only from the `**Milestone:** …` metadata line. Written anywhere else it is ignored, and filing would create a DUPLICATE the original can never be closed by. Move it onto the metadata line, or separate the word from the number if the mention is deliberate:', '',
           ...dc.slice(0, 20).map((d) => `- \`${d.title}\`: #${d.number}`),
           ...(dc.length > 20 ? [`- …and ${dc.length - 20} more`] : []), '']
        : [];
    })(),
    // REPORTED, NOT BLOCKING — and the choice is the one this file already draws
    // (RA-1331). A dropped LABEL blocks because no legitimate reason for one exists; a
    // dropped LINE is reported because the wrapped metadata continuation is a real,
    // intended drop. Dependencies pattern with the LINE: `Issue A — see the note about
    // Issue F below` discards `F` correctly, and the parser cannot tell that from
    // `Issue A; Issue B` discarding a real dependency — which is precisely why the
    // leading-run anchor exists rather than a looser separator.
    //
    // So stopping would park a project on an author's prose, while reporting costs a
    // line a human reads. The harm being guarded is also recoverable in a way RA-1303's
    // is not: a dropped dependency dispatches an implementer early, which wastes a
    // cycle; an unread `Closes` files a permanent duplicate.
    //
    // Measured over all four briefs on disk: zero. This surfaces the first one.
    ...(() => {
      const dd = world.proposed.flatMap((p) => (p.droppedDeps ?? []).map((k) => ({ title: p.title, key: k })));
      return dd.length
        ? ['', '**Dependency references the run did not take** — the `**Depends on:**` line names these and they are NOT enforced. A rationale after the last `Issue X` (an em dash, a semicolon, a trailing note) is where this comes from; if one of these is a real prerequisite, move it into the leading run (`Issue A, Issue B`) or a parenthetical:', '',
           ...dd.slice(0, 20).map((d) => `- \`${d.title}\`: Issue ${d.key}`),
           ...(dd.length > 20 ? [`- …and ${dd.length - 20} more`] : []), '']
        : [];
    })(),
    // WHY A HEAD WITH NO VERDICT WAS **NOT** RE-LABELLED (RA-1408). The churn itself is
    // an action and shows up in the actions list; this is the other half — the heads
    // that already have a review run, where re-firing repeats a cap, an outage or a
    // crash. Without it, "detected 3, churned 1" reads as two silently dropped, which
    // is how the note this replaced came to be trusted less than it deserved.
    ...(() => (reviewNotes.length
      ? (() => {
        // TWO LANES, TWO OPPOSITE CONDITIONS (RA-1592 review). A review-lane note is a
        // head with NO verdict; a revise-lane note is a head that HAS one and is
        // waiting on the implementer. Printing both under "no verdict" made half of
        // them read as the opposite of what they are.
        const lanes = [
          ['review', '**Heads with no verdict that were NOT re-labelled for review.** Each line says why, because the reasons want different responses and two of them want none — a run still in flight is not a problem, and a head whose runs could not be READ is where this recovery is blind:'],
          ['revise', '**Heads with a standing changes-request that were NOT re-labelled for revision.** The verdict is there; what is missing is the implementer answering it:'],
          ['split', `**Members awaiting a split that were NOT re-delivered or handed on.** The recovery could not establish how long each has waited (RA-2406):`],
        ];
        return lanes.flatMap(([lane, heading]) => {
          const rows = reviewNotes.filter((n) => (n.lane ?? 'review') === lane);
          return rows.length
            ? ['', heading, '',
              ...rows.slice(0, 20).map((n) => (lane === 'split' ? `- #${n.pr}: ${n.why}` : `- PR #${n.pr} \`${String(n.sha).slice(0, 7)}\`: ${n.why}`)),
              ...(rows.length > 20 ? [`- …and ${rows.length - 20} more`] : []), '']
            : [];
        });
      })()
      : []))(),
  ];
  // RA-1286 — say that the marker was recovered rather than read. A silent repair is a
  // repair nobody can audit, and this one is evidence that a tick died mid-churn.
  if (world.qaIssue?.labelMissing) {
    lines.push(`**The QA issue's \`${VERIFY}\` label is missing.** #${world.qaIssue.number} is this project's phase-5 issue by title and body, but carries no \`${VERIFY}\` — a tick almost certainly died between the remove and the re-add of the verification churn (RA-1286). It is being treated as the QA issue so nothing files a duplicate or dispatches an implementer at it; the next \`verify\` action restores the label. Re-applying \`${VERIFY}\` by hand also fixes it, and fires the verification.\n`);
  }
  if (world.blocked.length) {
    lines.push(`**Blocked — no action taken.** ${world.blocked.map((i) => `#${i.number}`).join(', ')} carry \`${NEEDS_INFO}\`/\`blocked\`. A tick must not route around a question a human owes an answer to.\n`);
  }
  if (stopped) lines.push(`**Stopped:** ${stopped}.\n`);
  if (phase === 'brief-partially-parsed') {
    warn(`brief ${world.briefPath}: ${world.proposed.residue.length} item(s) in the decomposition were not recognised`);
    lines.push(`**The decomposition was only partially parsed.** ${world.proposed.length} issue(s) were recognised and **${world.proposed.residue.length} item(s) were not**, so filing now would leave part of the project unfiled while the tick reported progress. Nothing was filed.\n`,
      'Not recognised:\n',
      ...world.proposed.residue.map((r) => `- \`${r}\``),
      '\nEach issue must read `### Issue X — Title`, with an em dash and at the same heading level as its siblings.\n');
  }
  if (phase === 'brief-unparseable') {
    warn(`brief ${world.briefPath} has no parseable Decomposition list — nothing to file`);
    lines.push(`**The brief has no parseable decomposition** — ${world.proposed.reason ?? 'no issues found'}. Nothing was filed, and this is NOT "complete": a project on which nothing was ever filed must never report done.\n`,
      'The reconciler needs one machine-readable thing from a brief — a `## Decomposition` section (numbered is fine — `## 3. Decomposition` parses) containing, per issue:\n\n```\n### Issue B — Short title\n**Milestone:** Product Backlog · **Labels:** `sev:critical`\n**Depends on:** Issue A (why)\n```\n\nEverything else about the format is free (RA-949). This shape is *derived* from the first real brief rather than imposed, so if a later brief reads better another way, fix this parser — not the brief.\n');
  }
  if (world.unmilestoned?.length) {
    warn(`${world.unmilestoned.length} proposed issue(s) name no milestone`);
    lines.push(`**Refusing to file:** ${world.unmilestoned.map((p) => `“${p.title}”`).join(', ')} name no milestone. \`AGENTS.md\` requires one on every issue, and filing bare would let the default-milestone backstop route them to Product Backlog — which reads as correctly triaged and stops showing up in the query that finds mistakes.\n`);
  }
  if (!actions.length) {
    lines.push(phase === 'complete'
      // What this DOES say: every issue closed, the work reached the reference environment, and
      // phase 5 verified the project's acceptance criteria against a build of that
      // tag. What it deliberately does NOT say is in `verificationCaveat` — one
      // renderer, because this sentence drifted across four artifacts before it had
      // one (RA-1087). Said in the report and not only in the issue, because this line
      // is what a human
      // reads when the project closes.
      ? (world.deploy?.state === 'nothing-to-deploy'
        ? '**Project complete.** Every issue closed, and NO merged PR closed any of them — so nothing was deployed and there is no release to name. The issues were closed some other way (duplicates, won\'t-fix, or a human doing the work by another route). Recorded rather than dressed up as a deploy.\n'
        : `**Project complete.** Every issue closed, the work is on ${deployEnvironment(world)} in \`${world.deploy?.tag}\`${world.qaIssue?.rounds === 0 || world.qaIssue?.readable === false ? '' : ', and phase 5 verified its acceptance criteria'}.${ownFailureCaveat(world.deploy)} ${verificationCaveat(world.deploy?.tag ?? null, world.qaIssue?.rounds, world.qaIssue?.readable, world.deploy?.environment)}\n`)
      : '**Nothing to do this tick.** That is a finding, not an absence — the table above is what was read to reach it.\n');
  } else {
    lines.push(`**${actions.length} action(s)${APPLY ? '' : ' that would be taken'}:**\n`);
    for (const a of actions) {
      // BEFORE THE TERNARY, because its final arm is an unguarded `dispatch`
      // fall-through: an unrecognised kind renders as `dispatch — #N **undefined**`,
      // which is a plausible-looking line about an implementer run that is not
      // happening.
      if (a.kind === 'revise-churn') {
        lines.push(`- \`revise-churn\` — re-label PR #${a.number} for revision; ${a.retry ? describeRetry(a.retry) : 'no revise run exists'} for \`${String(a.sha).slice(0, 7)}\` (issue #${a.issue}, RA-1524)`);
        continue;
      }
      if (a.kind === 'split-churn') {
        lines.push(`- \`split-churn\` — re-label #${a.number} with \`${SPLIT_LABEL}\` to re-deliver \`${SPLIT_WORKFLOW}\`: ${a.why} (RA-2406)`);
        continue;
      }
      if (a.kind === 'split-escalate') {
        lines.push(`- \`split-escalate\` — move #${a.number} from \`${SPLIT_LABEL}\` to \`${NEEDS_INFO}\` for a human: ${a.why} (RA-2406)`);
        continue;
      }
      if (a.kind === 'review-churn') {
        lines.push(`- \`review-churn\` — re-label PR #${a.number} for review; ${a.retry ? describeRetry(a.retry) : 'no review run exists'} for \`${String(a.sha).slice(0, 7)}\` (issue #${a.issue}, RA-1408)`);
        continue;
      }
      lines.push(a.kind === 'close-project'
      ? renderCloseAction(a)
      : a.kind === 'adopt'
        ? `- \`adopt\` — #${a.number} **${a.title}** (named by the brief; joined to the project rather than re-filed)`
      : a.kind === 'file'
        ? `- \`file\` — **${a.title}**`
        : `- \`dispatch\` — #${a.number} **${a.title}** → \`${IMPLEMENT}\``);
    }
    lines.push('');
  }
  const text = lines.join('\n');
  console.log(text);
  writeStepSummary(text);
  // RETURNED as well as printed (RA-1064), so a test can assert on what a human reads
  // instead of on the inputs that produce it. Three consecutive review rounds fixed
  // the same untagged-deploy string in three different surfaces, each fix leaving one
  // more copy behind, because nothing could reach any of them.
  return text;
}

// ---------------------------------------------------------------------------


/**
 * What phase 5's evidence is worth, in one place.
 *
 * This sentence has been corrected FOUR times in four artifacts across three PRs
 * (RA-1056, RA-1060, RA-1087 twice): the retro, the close comment, the tick's action
 * line, and the QA issue body. Each copy drifted separately because each was
 * written separately. It is one function now.
 *
 * @param {string|null} tag  the release verified against, or null if nothing shipped
 * @param {boolean} [readable]  false when the comment read FAILED — not evidence of
 *   absence, and must not be rendered as one
 * @param {number} [rounds]  the Explorer's marker-comment count on the QA issue; 0 means he
 *   never ran, and the claim must not be made. Optional so the many callers that
 *   render the caveat outside the close path keep their existing wording.
 */
/** What a `deployed` verdict does NOT say, when the project's own release failed first.
 *
 *  ONE RENDERER, for `verificationCaveat`'s reason (RA-1087): this sentence would
 *  otherwise drift across the retro, the close comment and the step summary. RA-1372
 *  lets the walk continue past a first-candidate failure so the project stops parking
 *  forever — and the whole justification for that is that the failure travels WITH the
 *  verdict rather than being discarded. If a close could omit it, this would be the
 *  RA-1056 mistake ("report a later green as though the failure had not happened")
 *  arriving through the artifact instead of through the classifier. */
export const ownFailureCaveat = (deploy) =>
  (deploy?.failedAt
    ? ` Its own release \`${deploy.failedAt}\` FAILED to deploy (${deploy.failedUrl ?? 'no run url'}); the work reached ${envName(deploy.environment)} only via the later whole-tree deploy of \`${deploy.tag}\`, so that failure is unexamined.`
    : '');

export const verificationCaveat = (tag, rounds, readable, environment) =>
  // NOBODY VERIFIED ANYTHING (RA-1095). `phaseOf` reaches phase 6 the moment the QA
  // issue is not OPEN, and checks nothing about whether the Explorer ever ran — so a QA
  // issue closed BY HAND produced a retro, and a step summary, both asserting that
  // phase 5 verified the acceptance criteria.
  //
  // That is reachable, not theoretical, and RA-1091 is how you get there: the obvious
  // human unstick for a permanent `awaiting-qa` stall is to close the QA issue
  // yourself, and the next tick then closes the project claiming a verification that
  // never happened. Phase 5 exists to stop a project reporting evidence nobody
  // gathered; on the close path it was re-introducing exactly that.
  //
  // `rounds === 0` means no marker comment on that issue — the Explorer never ran. The
  // project still CLOSES (a human closed the QA issue deliberately; stalling again
  // would be worse), it is just not described as verified. Says only what the marker
  // supports: the Explorer leaves it on every run INCLUDING a failing one, so `rounds >= 1`
  // establishes "the Explorer ran", not "everything passed".
  // AN UNREADABLE THREAD IS NOT AN ABSENCE (RA-1240). `readQaRounds` returns
  // `{ rounds: 0, readable: false }` on ANY `gh` failure, and `readable` is consulted
  // only inside the `state === 'OPEN'` branch — but the close path runs with the QA
  // issue CLOSED, so `rounds: 0` was taken at face value and the retro asserted that
  // nobody verified anything. That is RA-1095 inverted: a positive claim of absence made
  // from a source that could not be read, written permanently into the one artifact
  // this file calls "the last thing written before nobody looks again", on a close
  // that happens once. RA-1203 records a transient `gh` failure here as observed, not
  // hypothetical.
  readable === false
    ? `**Whether phase 5 ran is UNKNOWN.** The QA issue's comments could not be read on the tick that closed this project, so the verification round count is not evidence either way — neither that the criteria were verified nor that they were not.${tag ? ` The work is on ${envName(environment)} in \`${tag}\`.` : ''}`
    : rounds === 0
    ? `**No verification round ran.** QA issue closed without the Explorer ever reporting on it, so nothing established these criteria — this project is closed, not verified.${tag ? ` The work is on ${envName(environment)} in \`${tag}\`.` : ''}`
    : tag
      ? `The acceptance criteria were verified against a **build of \`${tag}\`**, not against ${envName(environment)} itself (RA-1063, option c) — a failed migration, a drifted env var or a config difference is invisible to that. A criterion with no citing test was reported \`unverifiable\`, never \`passed\`.`
      : 'NOTHING WAS DEPLOYED for this project — no merged PR closed any of its issues — so the acceptance criteria were verified against the default branch, and **no release backs this**. A criterion with no citing test was reported `unverifiable`, never `passed`.';

/**
 * PHASE 6's retro. Written to the tracking issue because that is what a person
 * reads when a project closes, and because the brief itself is now history.
 *
 * It states what is NOT known as plainly as what is — via `verificationCaveat`,
 * which is the single place that sentence is written. A retro claiming more than
 * phase 5 established would be the most expensive silent-absence in the pipeline,
 * since it is the last thing written before nobody looks again.
 */
export function retro(world, action) {
  // THE FIFTH COPY (RA-1213 review), and the one that does the most damage: an adopted
  // item landed in `missing`, so the retro's table contradicted its own prose two
  // lines above and printed an instruction to go create work that already exists —
  // the RA-976 failure this PR is named after, in the artifact this file's own comment
  // calls "the last thing written before nobody looks again".
  const missing = world.proposed.filter((p) => !itemSatisfied(p, world.all)).map((p) => p.title);
  // ITEMS AND ISSUES ARE DIFFERENT UNITS (RA-1219), and the old table asked the reader
  // to reconcile them silently: an adopting item names several issues, so even with
  // the tracking and QA issues excluded, "proposed 5, filed 7" is not an arithmetic
  // error to be fixed but two counts of two different things. Labelled rather than
  // forced to agree.
  const mine = briefIssues(world.proposed, world.all);
  return [
    `## The Lead — project retro, #${world.project}`,
    RETRO_MARKER,
    '',
    action.tag
      ? `The brief \`${world.briefPath}\` proposed **${world.proposed.length}** item(s), which named **${mine.length}** issue(s); all are closed. The work is on ${envName(action.environment)} in \`${action.tag}\`.${ownFailureCaveat(action)}`
      : `The brief \`${world.briefPath}\` proposed **${world.proposed.length}** item(s), which named **${mine.length}** issue(s); all are closed. **Nothing was deployed** — no merged PR closed any of them, so there is no release to name and ${envName(action.environment)} was never touched by this project.`,
    '',
    '| | |',
    '|---|---|',
    `| proposed by the brief | ${world.proposed.length} item(s) |`,
    `| filed | ${mine.length} issue(s) |`,
    `| proposed but never filed | ${missing.length}${missing.length ? ` — ${missing.map((t) => `“${t}”`).join(', ')}` : ''} |`,
    `| release containing every merge | ${action.tag ? `\`${action.tag}\`` : '**none — nothing was deployed**'} |`,
    '',
    // LEFT OPEN AT CLOSE (RA-1783) — the members that did not hold the project open, by
    // number and severity. Always rendered, as "none" too: a retro silent on them reads
    // identically to one that never looked.
    '### Left open at close',
    '',
    ...(() => {
      const out = carriedOut(world);
      return out.length
        ? ['This project closes with these members still open. None is in the brief\'s decomposition or carries `sev:high`/`sev:critical`, so none held it open; each keeps its own milestone routing:', '',
           ...out.map((i) => `- #${i.number} \`${severityOf(i)}\` — ${i.title}`)]
        : ['None — every member of this project is closed.'];
    })(),
    '',
    '### What this does NOT establish',
    '',
    `**That the work behaves on ${envName(action.environment)}.** ${verificationCaveat(action.tag, world.qaIssue?.rounds, world.qaIssue?.readable, action.environment)}`,
    '',
    'The `[seed]` invariants the brief proposed remain `[seed]`: promotion to `[confirmed]` is a human act and no agent on this project performed one.',
    '',
    'Nothing here was verified against a running system, and no database was queried.',
  ].join('\n');
}

/**
 * The provenance labels an adopted issue keeps that its brief does not declare (RA-1971).
 *
 * `sev:*`, `follow-up` and `agent:reviewer` are what RA-729's routing rule reads, so an
 * adoption must neither erase them nor carry them onto a brief's milestone silently.
 * Pure, so the warning's trigger is testable without a `gh` seam.
 *
 * @param {string[]} had   the issue's labels before adoption
 * @param {string[]} declared the brief item's `**Labels:**`
 */
export function adoptedProvenance(had, declared) {
  return had.filter((l) => (/^sev:/.test(l) || l === 'follow-up' || l === 'agent:reviewer') && !declared.includes(l));
}

export function execute(world, actions, { run = gh } = {}) {
  // TWO BUCKETS, NOT ONE (RA-1203). `failures` are what a retry cannot fix and hold the
  // project; `transient` are what a retry can, and turn the tick red instead.
  const failures = [];
  const transient = [];
  for (const a of actions) {
    try {
      if (a.kind === 'file') {
        const body = [
          a.body,
          '',
          `Part of #${world.project}.`,
          '',
          `_Filed by the Lead from the approved brief \`${world.briefPath}\` (RA-955). The brief is the acceptance criteria; if they are too vague to build safely, say so rather than guessing._`,
          '',
          // MUST BE LAST, with nothing after it. `declaresMembership` reads the
          // last non-empty line, because presence cannot tell a declaration from a
          // quotation — three documents about this convention were absorbed by it
          // (RA-1066). Appending anything below this silently un-files the issue.
          `<!-- qa:project ${world.project} -->`,
        ].join('\n');
        // Labels the brief chose, applied at creation — the prompt asks for them and
        // the parser skipped over the line without capturing it, so a `sev:critical`
        // on the real brief's Issue B was read and discarded. A label added later
        // is a label nobody adds.
        const url = run([
          'issue', 'create', '--repo', REPO, '--title', a.title,
          '--body', body, '--milestone', a.milestone,
          ...(a.labels ?? []).flatMap((l) => ['--label', l]),
          // The mirror, at creation, wherever the marker is written (RA-1783). Only when
          // the label is known to exist: `--label` on a missing one fails the create.
          ...(world.labelReady ? ['--label', projectLabel(world.project)] : []),
        ]).trim();
        console.log(`filed: ${url}`);
      } else if (a.kind === 'adopt') {
        // RA-976 — join an existing issue to the project instead of filing a rival.
        // Read-modify-write, because the marker must be the LAST non-empty line for
        // `declaresMembership` to see it, and the body already ends in whatever its
        // author wrote.
        // THE GUARD MUST TEST WHAT MEMBERSHIP TESTS (RA-1637). This asked
        // `body.includes(marker)`; membership is `declaresMembership`, which is the
        // marker as the LAST non-empty line. Those disagree in exactly one state —
        // marker present but not last — and that state is the one a human produces by
        // appending anything below a marker (the RA-1069 hazard the file phase is
        // commented about). The issue is then NOT a member, so the action is proposed
        // every tick; the arm read the body, saw the marker, logged "already declares
        // membership" — false — and skipped the edit. Forever, with nothing else
        // catching it: `orphaned` matches the BRIEF's item title, and an adopted issue
        // by construction carries its own.
        const current = ghJson(['issue', 'view', String(a.number), '--repo', REPO, '--json', 'body,milestone,labels'], { run });
        const body = current.body ?? '';
        if (declaresMembership(body, world.project)) {
          console.log(`adopt: #${a.number} already declares membership`);
        } else {
          // STRIP BEFORE APPENDING, or the present-but-not-last case grows a second
          // marker and leaves the first as stray text in the middle of the body.
          const stripped = body
            .split(/\r?\n/)
            .filter((l) => l.trim() !== `<!-- qa:project ${world.project} -->`)
            .join('\n')
            .trimEnd();
          const note = `${adoptedNote(world.project)}, from the decomposition item **${a.title}** in \`${world.briefPath}\`. The brief names this issue rather than proposing a new one, so the project tracks the work here instead of filing a duplicate (RA-976).`;
          // The note may already be there from the tick that wrote the marker a human
          // later buried; re-stating it would stack a paragraph per repair.
          const alreadyNoted = adoptedNotes(world.project).some((n) => stripped.includes(n));
          run(['issue', 'edit', String(a.number), '--repo', REPO, '--body', [
            stripped,
            ...(alreadyNoted ? [] : ['', note]),
            '',
            `<!-- qa:project ${world.project} -->`,
          ].join('\n')]);
          console.log(`adopted: #${a.number} into project #${world.project}`);
        }
        // THE BRIEF'S MILESTONE APPLIES TO AN ADOPTED ISSUE TOO (RA-1637). The `file`
        // arm passes `--milestone`; this one did not, though `parseProposed` sets the
        // field and the action already carries it. So a brief whose decomposition
        // routes an adopted issue to the gate silently did not move it, and AGENTS.md
        // makes the gate's denominator a rule — a brief that states gate movement and
        // does not perform it is the failure that rule exists to prevent.
        //
        // THE BRIEF WINS, DELIBERATELY, and this is the arguable half. A brief is a
        // reviewed, merged artifact and it is the LATER decision; the alternative —
        // "set it only when the issue has none" — makes the two arms disagree again and
        // silently drops the routing the brief was approved with. What it must not be
        // is invisible: an adoption that MOVES an issue already on a milestone raises a
        // `::warning` naming both, so a demotion off the gate is loud in the run that
        // does it rather than discovered in the burndown. Fires at most once per
        // adoption — the next tick sees a member and proposes no action at all.
        if (a.milestone) {
          const was = current.milestone?.title ?? null;
          if (was !== a.milestone) {
            run(['issue', 'edit', String(a.number), '--repo', REPO, '--milestone', a.milestone]);
            if (was) warn(`adopt: #${a.number} moved from milestone “${was}” to “${a.milestone}”, as \`${world.briefPath}\` names it`);
            console.log(`adopt: #${a.number} milestone ${was ?? '(none)'} → ${a.milestone}`);
          }
        }
        // …AND SO DO ITS LABELS (RA-1971) — the argument RA-1637 made for the milestone,
        // never extended. The `file` arm applies `**Labels:**` at creation; this arm
        // applied none, so an adopted issue kept whatever it was filed with and a
        // declared label was indistinguishable from one nobody wrote.
        //
        // ADD, NEVER REPLACE. An adopted issue's existing labels can be load-bearing
        // in ways a filed issue's are not: `follow-up` / `agent:reviewer` / `sev:*` are
        // the provenance record RA-729's severity rule reads, and erasing them to match
        // the brief would destroy evidence the brief never claimed to supersede.
        //
        // `agent:implement` IS NEVER ADDED HERE, whatever the brief says: applying it
        // IS a dispatch, and dispatch belongs to the `dispatch` arm, which is the one
        // that honours WIP, dependencies and order.
        //
        // WHAT ADDING CANNOT FIX IS SAID OUT LOUD. The live instance (RA-1701 adopted by
        // `1019.md`'s Issue C3) kept `sev:medium` + `follow-up` + `agent:reviewer` while
        // moving onto the gate — a combination AGENTS.md says is not launch-gating. So
        // a provenance label the brief does not itself declare raises a `::warning`
        // naming it, once, in the run that adopts: a human decides whether it stays.
        const had = (current.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
        const toAdd = [...(a.labels ?? []), ...(world.labelReady ? [projectLabel(world.project)] : [])]
          .filter((l) => l !== IMPLEMENT && !had.includes(l));
        if (toAdd.length) {
          run(['issue', 'edit', String(a.number), '--repo', REPO, ...toAdd.flatMap((l) => ['--add-label', l])]);
          console.log(`adopt: #${a.number} labels + ${toAdd.join(', ')}`);
        }
        const kept = adoptedProvenance(had, a.labels ?? []);
        if (kept.length) warn(`adopt: #${a.number} keeps ${kept.map((l) => `\`${l}\``).join(', ')}, which \`${world.briefPath}\` does not declare — the brief's labels were ADDED, never substituted, so a human decides whether these still apply (RA-1971)`);
      } else if (a.kind === 'dispatch') {
        run(['issue', 'edit', String(a.number), '--repo', REPO, '--add-label', IMPLEMENT]);
        console.log(`dispatched: #${a.number}`);
      } else if (a.kind === 'review-churn') {
        // REMOVE THEN ADD, in that order — adding a label the PR already carries is a
        // no-op that fires no event, so the removal is what makes the re-add an event.
        // Same reasoning as the `verify` arm below, same reason the order matters.
        //
        // The remove is allowed to fail: a PR that does not currently carry the label
        // still needs the add, and that add alone is a `labeled` event. What must not
        // happen is the reverse — skipping the add because the remove threw.
        try {
          run(['pr', 'edit', String(a.number), '--repo', REPO, '--remove-label', REVIEW_PLEASE]);
        } catch {
          // not labelled yet; the add below is still the event
        }
        run(['pr', 'edit', String(a.number), '--repo', REPO, '--add-label', REVIEW_PLEASE]);
        console.log(`re-labelled PR #${a.number} for review — ${a.retry ? describeRetry(a.retry) : 'no review run exists'} for ${String(a.sha).slice(0, 7)} (RA-1408)`);
      } else if (a.kind === 'revise-churn') {
        // Remove-then-add, and the remove may fail — see the `review-churn` arm.
        try {
          run(['pr', 'edit', String(a.number), '--repo', REPO, '--remove-label', REVISE]);
        } catch {
          // not labelled yet; the add below is still the event
        }
        run(['pr', 'edit', String(a.number), '--repo', REPO, '--add-label', REVISE]);
        console.log(`re-labelled PR #${a.number} for revision — ${a.retry ? describeRetry(a.retry) : 'no revise run exists'} for ${String(a.sha).slice(0, 7)} (RA-1524)`);
      } else if (a.kind === 'split-churn') {
        // Remove-then-add, and the remove may fail — see the `review-churn` arm. The
        // re-add is a `labeled` event on the App token, which is the delivery; it is
        // also the second `labeled` event that stops this issue being churned again.
        try {
          run(['issue', 'edit', String(a.number), '--repo', REPO, '--remove-label', SPLIT_LABEL]);
        } catch {
          // not labelled any more; the add below is still the event
        }
        try {
          run(['issue', 'edit', String(a.number), '--repo', REPO, '--add-label', SPLIT_LABEL]);
        } catch (err) {
          // UNLIKE THE PR CHURNS, LOSING THIS LABEL CHANGES WHAT IS DISPATCHABLE: with
          // neither `qa:needs-split` nor `qa:needs-info` the next tick would dispatch the
          // exhausted issue and repeat its cap. So a failed re-add parks it for a human.
          try { run(['issue', 'edit', String(a.number), '--repo', REPO, '--add-label', NEEDS_INFO]); } catch { /* reported below */ }
          throw err;
        }
        run(['issue', 'comment', String(a.number), '--repo', REPO, '--body', [
          `**Re-delivering the split lane** (\`${SPLIT_WORKFLOW}\`) — ${a.why}. This is the one re-delivery; if it produces no split PR either, the first tick ${SPLIT_STALL_HOURS}h after it hands this issue to \`${NEEDS_INFO}\`.`,
          '',
          '_Posted by `scripts/lead-reconcile.mjs` (RA-2406)._',
        ].join('\n')]);
        console.log(`re-labelled #${a.number} to re-deliver the split lane (RA-2406)`);
      } else if (a.kind === 'split-escalate') {
        // The human label FIRST, as the split gate orders it: if the removal then
        // fails the issue is still parked for a human, never carrying neither label.
        run(['issue', 'edit', String(a.number), '--repo', REPO, '--add-label', NEEDS_INFO]);
        run(['issue', 'edit', String(a.number), '--repo', REPO, '--remove-label', SPLIT_LABEL]);
        run(['issue', 'comment', String(a.number), '--repo', REPO, '--body', [
          `**Not re-delivering the split** — moving this issue from \`${SPLIT_LABEL}\` to \`${NEEDS_INFO}\` for a human.`,
          '',
          `- ${a.why}.`,
          '',
          '_Posted by `scripts/lead-reconcile.mjs` (RA-2406)._',
        ].join('\n')]);
        console.log(`handed #${a.number} to a human (${NEEDS_INFO}) — the split was not re-delivered (RA-2406)`);
      } else if (a.kind === 'file-qa') {
        // PHASE 5. Appended by the tick, not proposed by the brief (RA-1063).
        const body = [
          `Verify project #${world.project} on ${envName(a.environment)}, per acceptance criterion.`,
          '',
          a.tag
            ? `The work is deployed in \`${a.tag}\`. This issue is where that is CHECKED — the project does not close until it passes.`
            : 'NOTHING WAS DEPLOYED for this project — no merged PR closed any of its issues, so there is no release to verify against. Verify what the criteria assert against the current default branch, and say in your report that no deploy backs it.',
          '',
          '**the Explorer runs this**, not an implementer:',
          '',
          '```',
          `gh workflow run agent-verify-acs.yml -f project=${world.project}${a.tag ? ` -f ref=${a.tag}` : ''}`,
          '```',
          '',
          'He resolves the brief\'s acceptance criteria to the tests that cite them, runs those tests, and reports per ID. A criterion with no citing test is `unverifiable`, never `passed` — a project whose criteria are all unverifiable has NOT been verified.',
          '',
          'Findings are filed as project issues and picked up by the reconciler. **Close this issue only when the project passes**; the reconciler re-dispatches the Explorer whenever a project issue that holds the project open — a brief item, a finding, or a `sev:high`/`sev:critical` member — closes after his last run.',
          '',
          `What this does NOT establish: ${verificationCaveat(a.tag, undefined, undefined, a.environment)}`,
          '',
          `Part of #${world.project}.`,
          '',
          `<!-- qa:project ${world.project} -->`,
        ].join('\n');
        const url = run([
          'issue', 'create', '--repo', REPO, '--title', a.title,
          '--body', body, '--milestone', 'Development Automation', '--label', VERIFY,
          // The mirror at creation (RA-1783 review): a later `--add-label` on the QA issue
          // would raise a `labeled` event into `agent-verify-acs.yml`'s concurrency group.
          ...(world.labelReady ? ['--label', projectLabel(world.project)] : []),
        ]).trim();
        console.log(`filed QA issue: ${url}`);
      } else if (a.kind === 'verify') {
        // LABEL CHURN, NOT `workflow run` (RA-1281). The dispatch needed `actions:
        // write`, and `docs/qa/agent-identities.md` footnote 2 gives the Lead
        // `Actions: No access` deliberately — "label churn achieves the same with
        // strictly less authority". That reasoning had a hole for this one agent:
        // the Explorer was `workflow_dispatch`-only, so there was no label to churn, and the
        // dispatch 403'd and held the pilot project.
        //
        // `agent-verify-acs.yml` now also triggers on `issues: [labeled]` for
        // `qa:verify`, which is the QA issue's own marker — so re-applying it both
        // fires the Explorer and means "verify again". The workflow recovers `project` and
        // `ref` from the issue body, which states both.
        //
        // Remove-then-add, in that order: adding a label the issue already has is a
        // no-op that fires nothing, so the removal is what makes the re-add an event.
        // The issue keeps the marker either way — `readWorld` finds the QA issue by
        // this label, so a failure between the two calls must not orphan it, which is
        // why the re-add is the one that must not be skipped.
        //
        // THE REMOVE IS ALLOWED TO FAIL, exactly as `review-churn`'s and
        // `revise-churn`'s are (RA-1286). It was not, and that is the second half of the
        // orphan window: once a previous tick has already stripped the label, `gh issue
        // edit --remove-label` exits non-zero on a label the issue does not carry — so
        // the ONE action that would restore the marker failed on its first call and
        // held the project instead. The add is the event and the add is what matters.
        try {
          run(['issue', 'edit', String(a.number), '--repo', REPO, '--remove-label', VERIFY]);
        } catch {
          // not labelled — the orphan window, or a human already removed it
        }
        run(['issue', 'edit', String(a.number), '--repo', REPO, '--add-label', VERIFY]);
        console.log(`re-labelled #${a.number} to verify #${a.project}${a.tag ? ` at ${a.tag}` : ''}`);
      } else if (a.kind === 'close-project') {
        // PHASE 6. Closes the TRACKING issue only — every filed issue is already
        // closed, which is the sole reason this phase is reachable.
        run(['issue', 'comment', String(a.number), '--repo', REPO, '--body', retro(world, a)]);
        // Must AGREE with the retro posted one line above it. These two strings are
        // the ones actually written onto the tracking issue, and the untagged case
        // had them contradicting each other in adjacent comments: "Nothing was
        // deployed" followed by "the work is on staging in `(untagged)`".
        run(['issue', 'close', String(a.number), '--repo', REPO, '--comment', renderCloseComment(a)]);
        console.log(`closed project: #${a.number}`);
      } else {
        // An unrecognised kind used to fall into the dispatch branch, which would
        // have labelled the TRACKING issue `agent:implement` and set an implementer
        // loose on a whole project. Failing loudly costs a red tick; failing into
        // the wrong branch costs an agent run on the wrong artifact.
        warn(`unknown action kind \`${a.kind}\` — refusing to guess what to do with it`);
      }
    } catch (err) {
      // One failed action must not strand the rest, and must not read as success.
      // `gh()` now puts the CAUSE on the first line rather than the argv (RA-1284), so
      // this slice — which every caller here uses — finally says why.
      const why = err.message.split('\n')[0];
      warn(`${a.kind} failed for ${a.number ?? a.title}: ${why}`);
      const line = `\`${a.kind}\` for ${a.number ? `#${a.number}` : `\`${a.title}\``} — ${why}`;
      (isTransient(err.ghCause ?? err.message) ? transient : failures).push(line);
    }
  }
  // RA-963 — THE FAILURE HAS TO OUTLIVE THE TICK. State is derived, so the next tick
  // re-reads the same world, computes the same action and retries it: a brief naming
  // a milestone that does not exist was retried hourly, forever, each time producing a
  // green run and a `::warning` nobody reads. Holding the project is the memory, and
  // it is derived state a human can see and clear rather than a checkpoint file.
  //
  // ONLY FOR WHAT A RETRY CANNOT FIX (RA-1203). Holding on EVERY failure was a behaviour
  // change RA-963 did not intend: before it, a 502 or a secondary rate limit self-healed
  // on the next tick; after it, a blip stopped the whole project — including actions
  // unrelated to the one that failed — until a human cleared the label.
  if (failures.length) hold(world, failures, { run });
  // AND A TRANSIENT ONE STILL MUST NOT READ AS SUCCESS. Not holding is not the same as
  // ignoring: the tick goes RED, so GitHub's own workflow-failure notification carries
  // it (docs/observability.md §14) and a "transient" cause that is actually permanent
  // becomes a workflow red on every run — which is precisely the state
  // `scripts/qa/workflow-health.mjs` escalates (RA-1036). The green-hourly-forever hole
  // RA-963 closed stays closed; what changes is which memory the failure gets.
  if (transient.length) {
    process.exitCode = 1;
    warn(`${transient.length} action(s) failed for a reason a retry can fix — NOT holding #${world.project}; the next tick re-derives and retries. This tick is RED so the failure is not invisible: ${transient.join('; ')}`);
  }
}

/** A marker scoped to WHAT is being held, not just to the fact of holding.
 *
 *  ONE MARKER FOR SEVERAL DISTINCT REASONS SILENCES THE SECOND (RA-1242). `HELD_MARKER`
 *  alone suppressed the comment whenever ANY hold comment already existed — correct for
 *  the hourly repeat of one cause, and wrong the moment a project that was held for a
 *  failed action later enters a terminal stop phase: the new reason, which is the one a
 *  human is being asked to decide, was written nowhere. A digest of the reasons keeps
 *  the hourly suppression exactly as it was (same reasons → same marker → one comment)
 *  while letting a DIFFERENT reason say itself once.
 *
 *  A cheap non-cryptographic digest is enough: this only has to distinguish, not to
 *  resist anything. */
export const holdMarker = (reasons) => {
  let h = 5381;
  for (const ch of [...reasons].sort().join('\x00')) h = (Math.imul(h, 33) ^ ch.codePointAt(0)) >>> 0;
  return `<!-- qa:lead-held:${h.toString(36)} -->`;
};

/** The hold comment, as a string.
 *
 *  EXTRACTED SO A TEST CAN REACH IT (RA-1202), the same reasoning and the same precedent
 *  as `renderCloseComment` (RA-1064): the write half of the RA-963 fix had no test at all,
 *  so deleting `hold()`'s call site left the unit tier green and restored the exact
 *  behaviour RA-963 was filed about.
 *
 *  @param {string[]} reasons
 *  @param {'action'|'defect'|'stop'} kind  a failed action, a brief that describes
 *    something no tick can act on, or a phase that is permanent by construction and
 *    needs a decision (RA-1242). They ask for different things, and one sentence for all
 *    three told a human to go fix an action when nothing had failed.
 */
export function renderHoldComment(reasons, kind = 'action') {
  const opening = kind === 'stop'
    ? '🛑 **The Lead is holding this project.** It has reached a phase that is permanent by construction — nothing will change before the next tick, and a human owes it a decision.'
    : kind === 'defect'
      ? '🛑 **The Lead is holding this project.** The brief describes something no tick can act on, so every tick would recompute it and stop in the same place.'
      : '🛑 **The Lead is holding this project.** A tick took an action that failed, and the same action would be recomputed every hour until someone looks.';
  return [
    opening,
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    `Ticks take no actions while \`${HELD}\` is on this issue. Remove it once the cause is fixed and the next tick resumes from wherever the project actually is — nothing is checkpointed, so nothing needs unwinding.`,
    '',
    HELD_MARKER,
    holdMarker(reasons),
  ].join('\n');
}

/** Escalate to a human by labelling the TRACKING issue, and say why exactly once.
 *
 *  Idempotent in both halves: `--add-label` on a label already present is a no-op, and
 *  the comment is suppressed when this tick's marker is already on the issue. Without
 *  the second half an hourly tick would turn one permanent failure into a comment an
 *  hour — which is the same invisibility as no comment at all, arrived at from the
 *  opposite direction.
 *
 *  THE RUNNER IS INJECTABLE (RA-1202) so the argv this writes is assertable. It is the
 *  only way to hold a test on "a failed action holds the project": every other seam in
 *  this file is a pure function, and this one is the write.
 *
 *  @param {any} world
 *  @param {string[]} reasons
 *  @param {{run?: (a: string[]) => string, kind?: 'action'|'defect'|'stop'}} [io]
 */
export function hold(world, reasons, { run = gh, kind = 'action' } = {}) {
  try {
    run(['issue', 'edit', String(world.project), '--repo', REPO, '--add-label', HELD]);
    const seen = run(['issue', 'view', String(world.project), '--repo', REPO, '--json', 'comments',
      '--jq', '[.comments[].body] | join("\\n")']);
    if (!seen.includes(holdMarker(reasons))) {
      run(['issue', 'comment', String(world.project), '--repo', REPO, '--body', renderHoldComment(reasons, kind)]);
    }
    console.log(`held #${world.project}: ${reasons.length} ${kind === 'stop' ? 'terminal stop reason(s)' : 'failed action(s)'}`);
  } catch (err) {
    // The escalation itself failing is the one case with nowhere left to report to.
    warn(`could not hold #${world.project} after a failed action (${err.message.split('\n')[0]}) — this project will retry on the next tick`);
  }
}

/** What a tick DOES with a decision: report it, then act on it.
 *
 *  EXTRACTED FROM `reconcileAll`'S DEFAULT ARGUMENT (RA-1202). `main`'s escalate routing —
 *  that `nextActions` returning `escalate` becomes a HOLD — was named as load-bearing by
 *  the PR that shipped it and exercised by nothing, because it lived in a default
 *  parameter that could only be reached by letting the real `gh` run. Pulling it out
 *  gives it a name, a seam and a test, and changes nothing about what a tick does.
 *
 *  @param {any} world
 *  @param {{phase: string, actions: any[], stopped?: string|null, escalate?: string[],
 *           escalateKind?: 'action'|'defect'|'stop'}} decision
 *  @param {{run?: (a: string[]) => string, apply?: boolean}} [io]
 */
export function applyDecision(world, decision, { run = gh, apply = APPLY } = {}) {
  report(world, decision);
  // The mirror runs FIRST (RA-1783): it is what creates the label, and the `file` arm
  // applies it at creation — so it must exist before that arm runs.
  if (apply) world.labelReady = mirrorLabels(world, labelMirror(world), { run });
  if (apply && decision.actions.length) execute(world, decision.actions, { run });
  if (apply && decision.escalate?.length) {
    hold(world, decision.escalate, { run, kind: decision.escalateKind ?? 'defect' });
  }
}

/** Resolve the env ambiguity here, not in the decision function.
 *
 *  `Number('')` is 0 and `Number(undefined)` is NaN — and `??` does not catch an
 *  empty string, so an unset variable parsed to 0 and read as "budget exhausted",
 *  which would have stopped every tick, green, forever. NaN failed the other way:
 *  `NaN <= 0` is false, so the guard was silently off. Anything that is not a
 *  positive finite number means NO BUDGET SET. */
export function readBudget(raw) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * Does this issue occupy an implementer slot? (RA-2038)
 *
 * `agent:implement` does TWO jobs, and conflating them is the bug this answers: it
 * means "dispatched" (what the WIP caps count) and "do not re-dispatch" (the
 * `eligible` filter in `nextActions` excludes it). A correctly-bailed issue must
 * KEEP the label to avoid a re-run that bails again at ~$23 a time — and keeping it
 * held a shared slot forever.
 *
 * Measured 2026-09-18: all three `QA_LEAD_GLOBAL_WIP` slots were held by issues that
 * could not produce a PR (RA-66 human-only, RA-693 needs production telemetry, RA-1694
 * queued behind its dependency), while project RA-1292 — the launch gate's credential
 * work, 0 of 8, holding a `sev:critical` kiosk-lockout hole — was handed nothing on
 * every tick.
 *
 * So the cap counts what an agent might actually be RUNNING. A parked issue consumes
 * no quota, which is the justification the cap rests on. It is still not
 * re-dispatched: that is the `eligible` filter's job and it is unchanged, so this
 * frees the slot WITHOUT re-arming the dispatch.
 */
export const occupiesSlot = (i) => i.labels.includes(IMPLEMENT) && !i.parkedOnHuman;

/** In-flight implementer issues on a world, the same count `nextActions` bounds. */
const inFlightCount = (world) => world.open.filter((i) => occupiesSlot(i) && isProjectWork(i, world.proposed)).length;

/**
 * EVERY OPEN PROJECT, NOT THE LOWEST-NUMBERED ONE (RA-1447).
 *
 * The workflow's pick loop took the first open tracking issue in numeric order and
 * emitted the rest as a `::warning`. That is not a slow queue, it is a stop: a project
 * only advanced once every lower-numbered project had CLOSED. Measured when this was
 * written — RA-1015 open since 2026-08-26 and 1 of 5 done, while RA-1291 (9 proposed
 * items) and RA-1292 (8) had filed **zero** issues between them for four days. RA-1305
 * amplified it: one bailed issue in the lowest-numbered project held three others and
 * both higher-numbered projects for three days.
 *
 * SAFE TO LOOP BECAUSE THIS IS A SCRIPT, NOT AN AGENT. The reconciler is
 * `node scripts/lead-reconcile.mjs`; what costs quota is what it TRIGGERS. So the
 * loop itself is free and the two things that are not free stay bounded:
 *
 *   · the TICK BUDGET (`QA_LEAD_TICK_BUDGET`) is now shared across projects rather
 *     than granted to each, so a tick cannot do N times more than it used to;
 *   · in-flight implementer work is bounded GLOBALLY by `GLOBAL_WIP_DEFAULT` as well
 *     as per-project by `wip`, so N projects cannot mean N x wip agent runs.
 *
 * WITHIN A PROJECT NOTHING CHANGES. Each project's `nextActions` is called exactly as
 * before, so the brief's dependency order still serialises that project's issues.
 * Order across projects is numeric and stable, and the shared budget is consumed in
 * that order — the starved project gets the ticks it never got, not priority.
 *
 * ONE PROJECT'S FAILURE MUST NOT STRAND THE REST, which is the whole point: a throw
 * while reconciling RA-1015 is what used to take RA-1291 and RA-1292 down with it.
 */
export function reconcileAll(projects, {
  read = readWorld,
  onDecision = applyDecision,
  budget = readBudget(process.env.QA_LEAD_TICK_BUDGET),
  globalWip = GLOBAL_WIP_DEFAULT,
  wipPerProject = WIP_DEFAULT,
  // The Actions read `reviewRecovery` needs, injectable so the unit tier never shells
  // out (RA-1523 review). Without this seam the first fixture carrying an aged
  // unreviewed PR reaches the real `gh` from a unit test.
  runsFor = undefined,
  // The jobs read the RA-2519 retry needs — same seam, same reason. Absent, no run is
  // ever read as retryable, which is the pre-RA-2519 behaviour; `main()` passes the real
  // reader.
  evidenceOf = undefined,
} = {}) {
  let budgetLeft = budget;
  let globalLeft = globalWip;
  const decisions = [];
  // Kept for `deriveFollowUps` (RA-2412), which needs every project's members at once.
  const worlds = [];
  const failures = [];
  // WHAT EACH PROJECT WAS ALLOWED, AND WHAT IT TOOK (RA-1484). The shared budget is
  // consumed in strict numeric order with no rotation, so the last project can be
  // handed nothing several ticks running while the earlier ones drain. That is a slow
  // queue rather than the stop RA-1447 fixed — but it was UNMEASURED, and an unmeasured
  // slow queue is indistinguishable, on every surface, from a project with nothing to
  // do. This is that pipeline's `silent-absence` rule applied to the new shared
  // resource, and it is the part that is checkable whichever allocation policy is
  // chosen later.
  //
  // AND THE MEASUREMENT MUST NOT RE-CREATE THE CONFLATION IT WAS FILED ABOUT (RA-1679).
  // `starved` was `budgetAtStart <= 0` alone, which is a fact about the TICK and says
  // nothing about the project: `nextActionsCore`'s first statement is the budget gate,
  // so it returns before the phase logic decides whether there is any work at all. On
  // an ordinary tick (budget 6, three projects) EVERY later project was recorded
  // starved — the one with three issues waiting and the one with nothing to do alike —
  // and the step summary then asserted unmet demand about both. Each clause was
  // literally true and the framing was false, which is the same defect as the silence,
  // arrived at from the other side.
  const allocations = [];

  for (const project of projects) {
    try {
      const world = read(project);
      // The global cap is spent on what is ALREADY in flight before this project may
      // add more, so an early project cannot hold slots it is not using.
      const wip = Math.max(0, Math.min(wipPerProject, globalLeft));
      const budgetAtStart = budgetLeft;
      const opts = { wip, wipPerProject, globalWip, earlierProjects: decisions.length };
      // WHAT THIS PROJECT WOULD HAVE ASKED FOR HAD THE BUDGET BEEN UNBOUNDED (RA-1679) —
      // the one thing an exhausted-budget decision cannot report, because the gate
      // returns before the phase logic derives it. Re-deriving is the cheap route and
      // the one that leaves the gate's docblock true: `nextActionsCore` is pure and the
      // world is already read, so this costs no request and no `gh`. It is the CORE
      // rather than `nextActions` deliberately — the recovery churns are exempt from
      // the budget by construction, so counting them as demand would report a project
      // as starved for work the budget never withheld.
      //
      // Computed ONLY on the exhausted path, so an ordinary tick does no extra work.
      const demand = budgetAtStart <= 0 ? chargeable(nextActionsCore(world, { ...opts, budgetLeft: Infinity }).actions) : 0;
      const decision = nextActions(world, { ...opts, budgetLeft, ...(runsFor ? { runsFor } : {}), ...(evidenceOf ? { evidenceOf } : {}) });
      onDecision(world, decision);
      budgetLeft -= chargeable(decision.actions);
      allocations.push({
        project,
        budgetAtStart,
        spent: budgetAtStart - budgetLeft,
        wip,
        // How much budget-consuming work it had and could not take. `0` on any project
        // the budget did not gate, and `0` on one that reached an exhausted budget with
        // nothing to ask for — which is the distinction RA-1679 is about.
        demand,
        // Two DIFFERENT ways to get nothing, and the whole point is telling them apart:
        // `starved` is "the budget was already gone AND there was work waiting for it",
        // `cutShort` is "there was work left that the remaining budget could not cover".
        // A project allocated nothing because it wanted nothing is NEITHER, and saying
        // so is the point — it is a healthy project, and the summary stays quiet.
        starved: budgetAtStart <= 0 && demand > 0,
        cutShort: /^tick budget: filing/.test(decision.stopped ?? ''),
      });
      // CHARGED FOR WHAT THIS TICK DISPATCHES, NOT ONLY FOR HISTORY (RA-1483 review).
      // `inFlightCount` reads the `agent:implement` label, which `execute` applies
      // AFTER this — so charging it alone spent the cap on the past and never on the
      // thing the cap exists to bound. Measured at the workflow's production settings
      // (budget 6, wip 3, globalWip 3, three projects, nothing in flight): 6 dispatched
      // under a guard that reads as 3, and it is not a first-tick transient — the
      // steady state settles at 6, permanently double the advertised bound. The
      // justification for the cap is quota, which is exactly what overshoots.
      //
      // No double-count across ticks: the next tick reads these same issues as
      // in-flight and dispatches nothing further for them.
      globalLeft -= inFlightCount(world)
        + decision.actions.filter((a) => a.kind === 'dispatch').length;
      decisions.push({ project, decision });
      // A project this tick CLOSED is not joinable: its retro is already written.
      if (joinable(world, decision)) worlds.push(world);
    } catch (err) {
      // A read or an action failure on ONE project is reported and the loop
      // continues. Letting it throw would restore the exact coupling this change
      // removes — with the failure now able to strand EVERY project rather than only
      // the ones numerically after it.
      failures.push({ project, message: err.message });
      warn(`project #${project}: ${err.message}`);
      console.log(`\n**Project #${project} could not be reconciled** — ${err.message}\n`);
    }
  }
  if (failures.length) {
    const rest = projects.length - failures.length;
    console.log(`\n${failures.length} of ${projects.length} project(s) failed to reconcile${rest ? `; the other ${rest} ${rest === 1 ? 'was' : 'were'} unaffected` : ' — NONE was reconciled'}.\n`);
  }
  // SAID ONLY WHEN IT BOUND, so a healthy tick stays quiet and the line means
  // something when it appears. It goes to the step summary as well as the log: the log
  // is where this class of fact has gone unread before.
  const short = allocations.filter((a) => a.starved || a.cutShort);
  if (short.length && Number.isFinite(budget)) {
    const text = [
      '',
      `**The tick's shared budget of ${budget} bound ${short.length} project(s).** Consumed in numeric order, so a later project can get nothing on a given tick while the earlier ones drain (RA-1484). This is a slow queue, not a stop — the earlier projects do drain — but it is now measured rather than looking like a project with nothing to do:`,
      '',
      ...short.map((a) => (a.starved
        ? `- **#${a.project} was allocated NOTHING** — the budget was already spent when the tick reached it, and it had ${a.demand} action(s) waiting that it could not take.`
        : `- **#${a.project} was cut short** — it started with ${a.budgetAtStart} and had work left over.`)),
      '',
    ].join('\n');
    console.log(text);
    writeStepSummary(text);
  }
  return { decisions, failures, budgetLeft, globalLeft, allocations, worlds };
}

function main() {
  if (!REPO) {
    console.error('lead-reconcile: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const raw = arg('project');
  if (!raw) throw new Error('--project <tracking-issue>[,<n>...] is required');
  const projects = String(raw).split(',').map((p) => p.trim()).filter(Boolean);
  const { decisions, failures, worlds } = reconcileAll(projects, { evidenceOf: makeRetryEvidenceReader({ json: ghJson }) });
  // AFTER every project (RA-2412): "exactly one project" is a question about all of them,
  // so it runs only when this tick read ALL of them — a failed read, or a manual
  // dispatch narrowed to one project, would turn a two-project PR into a one-project
  // guess that is then permanent. Fail closed: only the workflow's scheduled scope says
  // `all`.
  if (!failures.length && process.env.QA_LEAD_SCOPE === 'all') deriveFollowUps(worlds);
  // A TICK THAT COULD NOT RECONCILE MUST NOT READ AS A CLEAN ONE (RA-1483 review).
  // Before the loop, `main()` let a read throw out and the tick went RED. Catching
  // per project is right — it is what stops one project stranding the others — but
  // dropping `failures` on the floor made "nothing was reconciled at all"
  // indistinguishable from "everything was fine", on a green run, retried hourly
  // forever. That is the swallowed-403 shape this workflow carries three comments
  // about, and it would sit BELOW RA-1036's detector, which watches for a workflow red
  // on every run.
  //
  // AFTER the loop, so every project is still attempted — the isolation is the point
  // and it stays. Narrow by construction: `execute` catches per action and `hold`
  // catches its own, so neither reaches `reconcileAll`'s catch. This fires only on a
  // throw out of `read`/`report`, which is the case with no other memory — an action
  // failure already outlives the tick via `hold`'s label on the tracking issue.
  if (failures.length) process.exitCode = 1;
  // The last decision is returned for callers and tests that read one; the loop's real
  // output is the per-project reports above.
  return decisions.at(-1)?.decision ?? { phase: 'no-projects', actions: [] };
}

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (IS_CLI) main();
