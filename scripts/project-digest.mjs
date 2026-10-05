// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/**
 * Daily project-brief digest for the developer's Slack channel (RA-1438).
 *
 * AUDIENCE: the developer, not a stakeholder. That inverts the weekly digest's
 * editorial rules rather than reusing them — `weekly-digest.mjs` is written for
 * a co-founder tracking runway and is forbidden from mentioning anything
 * pending, because RA-166 was rejected for nagging the solo developer about their
 * own backlog. This post is the opposite instrument on purpose: what is STOPPED
 * is the entire signal, and it was asked for.
 *
 * The RA-166 line still holds where it means something, and the distinction is
 * WHOSE queue is being reported. This says where the PIPELINE is stopped — an
 * agent that bailed, a project nothing is filing for. It deliberately does NOT
 * count the developer's unreviewed PRs or unmerged branches back at them.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Project state is only legible by hand: membership is the `<!-- qa:project N -->`
 * marker (RA-1066), not a label or a milestone, so "how are the projects going?"
 * is five `gh` queries per project plus knowing where to look. RA-1305 bailed on
 * 2026-08-30 awaiting a human decision and was found three days later, only
 * because someone thought to ask. This turns that into a schedule.
 *
 * ── THE ONE CLASSIFICATION THAT MUST BE RIGHT ──────────────────────────────
 * An `agent:implement` issue with no PR has two completely different causes:
 *
 *   BAIL   the implementer STOPPED and said why — a scope-first bail on the
 *          bail list, a precondition only a human can meet, a question. It
 *          needs a DECISION.
 *   STALL  the run was skipped, died, or never fired. It needs a RE-DISPATCH.
 *
 * They look identical in labels and PR state and call for opposite responses,
 * so reporting one as the other is worse than not reporting at all — it sends
 * the reader to re-dispatch something that would immediately bail again. The
 * distinguishing evidence is WHO spoke last — the dispatch sweep's own rule, which
 * `classifyDispatch` imports — not the wording of what they said (kanon#179).
 *
 * ── THERE IS NO POSITION-DERIVED STARVATION ────────────────────────────────
 * This script used to classify every open project but the lowest-numbered one as
 * `starved`, deriving it from the reconciler's pick rule — "one project per tick,
 * lowest-numbered first". **RA-1483 deleted that rule**: `reconcileAll` walks EVERY
 * open project on every tick. So the red line was reporting a stall about projects
 * being reconciled normally, in the digest whose whole job is saying what is
 * stopped (RA-1490).
 *
 * A project with members now reads `active` and one with none reads `unfiled`,
 * both of which are facts about the project rather than about its neighbours.
 *
 * NOTHING REPLACES THE RED LINE, and that is a decision rather than an omission.
 * Real starvation still exists — the shared tick budget is consumed in numeric
 * order, so a later project can get nothing in a given tick (RA-1484) — but that is
 * budget-derived and *per tick*, and this script cannot see it: knowing what a
 * given tick actually spent means reading its run log, which is precisely the
 * `actions: read` this job does without. Inventing a position-derived stand-in is
 * how the wrong line got here in the first place.
 *
 * What survives unchanged is the reason there is no `actions: read`: everything
 * here is still derived from issues and PRs, and nothing is scraped.
 *
 * Dependency-free (Node 20+: global fetch), and exercised locally exactly as CI
 * runs it:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> \
 *   DRY_RUN=1 node scripts/project-digest.mjs
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, DIGEST_WEBHOOK (lib/digest-webhook.mjs), NARRATIVE
 * (optional prose from the model step — the post degrades to numbers-only when
 * absent), TODAY (optional ISO date, for reproducible runs), DRY_RUN.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { closingRefs } from './closing-refs.mjs';
import { digestWebhook } from './lib/digest-webhook.mjs';
import { CONFLICT_SHORT, ConflictFieldsUnread, conflictState } from './conflict-state.mjs';
// THE RECONCILER'S OWN CLOSURE RULE AND BRIEF GRAMMAR, imported rather than restated
// (RA-2414). Since RA-1783 a project closes when its GATING members are done — the brief's
// decomposition, phase-5 findings, any `sev:high`/`sev:critical` member — and every other
// member is CARRIED OUT: reported, never waited on. A second definition of "gating" here
// would drift from the one that actually closes projects.
//
// FROM THE SHARED MODULE, NOT FROM `lead-reconcile.mjs`. Importing the reconciler pulled
// its whole CLI — top-level env reads and a `gh` wrapper — into this job to get four pure
// functions; `project-closure.mjs` is those functions and nothing else, so it imports
// nothing and the workflow's plain checkout (no `npm ci`) runs it.
// THE SWEEP'S OWN CLASSIFIER (kanon#179), so the digest and the sweep read one state per
// issue. Node built-ins only, like everything else this job runs; it reads the App
// register for the Implementer's login, as the reconciler does.
import { AGENT_LOGIN, MARKER as SWEEP_MARKER, classify as classifyLane, isBot, norm } from './dispatch-sweep.mjs';
import { carriedOut as reconcilerCarriedOut, declaresMembership, itemSatisfied, openGatingWork, parseProposed } from './project-closure.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { asRole, markedRole } from './lib/role-marker.mjs';

/** The Implementer's own comment: its login and, from L4, its role marker (plan 0005 §3.3). */
const byImplementer = (/** @type {{login?: string|null, body?: string|null}} */ c) =>
  asRole('Implementer', { login: norm(c.login), expected: AGENT_LOGIN, body: c.body });

/** Where briefs live. A brief's basename IS its tracking issue number (RA-1032). */
export const BRIEF_DIR = 'docs/projects';

/** `agent-implement.yml`'s bail marker, as the implementer writes it. */
export const BAIL_RE = /SCOPE-FIRST BAIL/i;

/**
 * A PR body that actually CLOSES an issue, as GitHub's own closing keywords spell it.
 *
 * The search that finds candidate PRs is `in:body`, which is a term search — it
 * matches a PR that merely NAMES the number in prose. This PR's own body named
 * RA-1305-RA-1308 without implementing any of them, and would have reported all four as
 * "building", which suppresses the bail line entirely (RA-1443 review, finding 1).
 *
 * So the search is a cheap filter and this is the predicate, exactly as
 * `qa:project` is searched loosely and then re-checked. Verified against the live
 * repo: PR RA-1445 (`Closes RA-1305`) matches, PR RA-1443 (prose mention) does not.
 *
 * Deliberately NOT `closedByPullRequestsReferences`: that is GraphQL-only and its
 * reachability under the workflow's plain `GITHUB_TOKEN` is unverified, and a 403
 * there fails the job. A regex over a body we already fetch cannot 403.
 *
 * ONE MODEL OF GITHUB'S LINKER, NOT TWO (RA-1733). This used to carry its own regex, which
 * knew one of the four spellings GitHub acts on (`#N`), while `closing-refs.mjs` knew all
 * four (`#N`, `owner/repo#N`, `GH-N`, the issue URL). A member whose PR said `Closes GH-N`
 * read as having no PR and fell through to stall/bail — in-flight work reported as work
 * nobody picked up. `repo` drops a ref to ANOTHER repository, which must not count.
 *
 * @param {string | null | undefined} body
 * @param {number} number
 * @param {string} [repo] `owner/name`
 */
export const closesIssue = (body, number, repo) => closingRefs(body ?? '', repo).includes(number);

/**
 * A dispatched issue is "quiet" rather than merely young after this. Sized at
 * one working day: an implementer run that is going to open a PR does so within
 * hours, so a day of silence is a real signal and an hour of it is noise.
 */
export const QUIET_AFTER_DAYS = 1;

// ---------------------------------------------------------------------------
// Pure derivation. Everything above the I/O line is unit-tested.
// ---------------------------------------------------------------------------

/**
 * What a brief proposes — ONE parse, both numbers (cleanup round 5).
 *
 * `proposed` is the item count, and it is DERIVED from `briefItems` rather than read by
 * a second grammar. It used to come from `countProposed`, a whole-file count of
 * `### Issue X` headings, while `briefItems` came from the reconciler's `parseProposed`,
 * which reads only the `## Decomposition` section and reports anything issue-shaped it
 * could not take as residue. Both fed the same header line — the count through the
 * `unfiled` status and the fallback denominator, the parse through the closure join — so
 * a brief with an `### Issue` heading outside its decomposition, or a mis-separated one
 * inside it, read as two different sizes in one post. Now the digest counts exactly the
 * items the reconciler would file.
 *
 * An unparseable brief proposes 0 here, where the old count could still find headings —
 * which is the reconciler's own answer, since it files nothing from such a brief. So that
 * zero cannot read as an empty, healthy project, `classifyProject` still calls a brief
 * with nothing filed `unfiled` when it does not parse, and `renderProject` names the
 * parser's reason instead of a count.
 *
 * @param {string} markdown
 * @returns {{proposed: number, briefItems: any[]}}
 */
export function readBrief(markdown) {
  const briefItems = parseProposed(markdown);
  return { proposed: briefItems.length, briefItems };
}

/** A brief's short name, for the Slack heading — its H1 with the boilerplate trimmed. */
/** @param {string} markdown @param {string} fallback @returns {string} */
export function briefTitle(markdown, fallback) {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1] ?? fallback;
  return h1
    .replace(/^Project\s+brief\s*[—–-]\s*/i, '')
    .replace(/^Project\s+#\d+\s*[—–-]\s*/i, '')
    .replace(/^Project:\s*/i, '')
    .trim();
}

/**
 * What the reader is told the Implementer stopped on: `scope-first bail` when the comment
 * says so, else its first heading (or first line), Slack-escaped and bounded. A LABEL
 * only — `BAIL_RE` never decides between "awaiting you" and "stalled" (kanon#179).
 *
 * @param {string|null|undefined} body
 * @param {number} [max]
 * @returns {string}
 */
export function stopReason(body, max = 80) {
  const text = body ?? '';
  if (BAIL_RE.test(text)) return 'scope-first bail';
  // Not a hidden marker, and not the persona header the role marker rides on (plan 0005 §3.3):
  // neither is what the Implementer stopped on.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('<!--') && !markedRole(l));
  const first = (lines.find((l) => /^#{1,6}\s/.test(l)) ?? lines[0] ?? '')
    .replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!first) return 'stopped';
  const safe = first.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `stopped: “${safe.length > max ? `${safe.slice(0, max - 1)}…` : safe}”`;
}

/**
 * Why a dispatched issue has no PR. See the header — this is the classification
 * the whole digest exists to get right.
 *
 * BY AUTHORSHIP, AS THE DISPATCH SWEEP DECIDES IT (kanon#179). The state comes from the
 * sweep's own `classify`, so the digest and the sweep cannot disagree on an issue. It
 * used to come from `BAIL_RE`: only a comment saying `SCOPE-FIRST BAIL` verbatim was a
 * bail, so an Implementer stop worded any other way ("Stopped: the data precondition is
 * still unmet") read as a stall, and sent the reader to re-dispatch something that
 * would only stop again. The sweep refuses that keyword match for the same reason.
 *
 *  - the Implementer has never commented            → `stall` once quiet, else `dispatched`
 *  - its word is the last (bots aside)              → `bail`: awaiting a human, with the
 *                                                     stop's heading as the reason — unless
 *                                                     it answers a human and is under 48h
 *                                                     old: then a re-run, `authorised`
 *  - a human answered it and nothing ran since      → `authorised`
 *  - a human replied to the SWEEP, nothing ran      → `human-held`
 *  - a human parked it with `qa:needs-info`         → `needs-info`
 *
 * So a bail never clears a bail once it is stale, and
 * the reported wait comes from the Implementer's last comment rather than `updatedAt`,
 * which a label change or a bot comment bumps.
 *
 * @param {{comments?: {login?: string|null, body?: string|null, createdAt?: string}[],
 *          labels?: string[], hasPr?: boolean, prConflicting?: boolean, ageDays?: number,
 *          now?: Date}} input
 * @returns {{disposition: 'conflicting'|'building'|'authorised'|'bail'|'stall'|'dispatched'|'human-held'|'needs-info',
 *            waitedDays: number, reason?: string}}
 */
export function classifyDispatch({ comments = [], labels = [], hasPr = false, prConflicting = false, ageDays = 0, now = new Date() }) {
  // BEFORE `building`, because it is the same PR and the opposite report (RA-1722). A
  // conflicting PR has no merge ref, so GitHub dispatches no `pull_request` events for
  // it: CI, review, revise and every label churn the reconciler owns are all
  // unreachable. "building" is then the most misleading word available — the 2026-09-09
  // digest called PR RA-1708 a normal in-progress member for 36 hours while nothing in
  // the pipeline could touch it, which is the exact failure this script exists to
  // prevent one level up.
  if (hasPr && prConflicting) return { disposition: 'conflicting', waitedDays: ageDays };
  if (hasPr) return { disposition: 'building', waitedDays: ageDays };

  const conversation = comments.map((c) => ({ login: norm(c.login), body: c.body ?? '', createdAt: c.createdAt }));
  const v = classifyLane({ labels: labels.map((name) => ({ name })) }, conversation, false, { now: now.getTime() });
  const lastAgent = conversation.filter(byImplementer).at(-1);
  const at = Date.parse(lastAgent?.createdAt ?? '');
  const waitedDays = Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 86400000)) : ageDays;
  const quiet = { disposition: ageDays >= QUIET_AFTER_DAYS ? 'stall' : 'dispatched', waitedDays: ageDays };

  switch (v.state) {
    case 'parked': return { disposition: 'needs-info', waitedDays: ageDays };
    case 'human-held': return { disposition: 'human-held', waitedDays: ageDays };
    case 'answered': return { disposition: 'authorised', waitedDays };
    // `in-flight` is the sweep's young `awaiting-human`: the Implementer's word is the last,
    // under the sweep's 48h. A first stop is awaiting the reader at once. One that FOLLOWS
    // a human's answer is the re-dispatched run speaking (RA-1305: bail, "proceed",
    // "Building now."), so it stays `authorised` until it is as stale as the sweep's own
    // `awaiting-human` — after which a second stop reads as awaiting the reader again.
    case 'in-flight': {
      // By position, oldest first, as the API returns them: a human between the
      // Implementer's last two comments. Its FIRST comment answers nobody — a human who
      // spoke before the first run was not replying to it.
      const agentIdx = conversation.flatMap((c, i) => (byImplementer(c) ? [i] : []));
      const answered = agentIdx.length > 1 && conversation.slice(agentIdx.at(-2) + 1, agentIdx.at(-1))
        .some((c) => !isBot(c.login) && !c.body.includes(SWEEP_MARKER));
      if (answered) return { disposition: 'authorised', waitedDays };
      return { disposition: 'bail', waitedDays, reason: stopReason(lastAgent?.body) };
    }
    case 'awaiting-human': return { disposition: 'bail', waitedDays, reason: stopReason(lastAgent?.body) };
    // Out of re-dispatches: the sweep stops it on its next run. Report the state that
    // ran out — silence is a stall, an answered stop is authorised.
    case 'exhausted': return v.sawAgent ? { disposition: 'authorised', waitedDays } : quiet;
    default: return quiet;
  }
}

/**
 * The search hits that are MEMBERS of `project` — by the reconciler's own rule (kanon#174).
 *
 * The search is `in:body`, a term search, so it is only a filter. Membership is
 * `declaresMembership`: the marker must be the body's LAST non-empty line, because a
 * document QUOTING the marker mid-body is textually identical to a use of it (RA-1066).
 * A body-wide match here counted such a quote as a member that the reconciler does not
 * consider one at all, and the digest then named it as carried out.
 *
 * @template {{body?: string|null}} T
 * @param {T[]} hits
 * @param {number} project
 * @returns {T[]}
 */
export const membersOf = (hits, project) => (hits ?? []).filter((i) => declaresMembership(i.body ?? '', project));

/**
 * Whole-project state, from its members alone.
 *
 * NO LONGER TAKES `isNext` (RA-1490). It answered "is this the lowest-numbered open
 * project?", the pick rule `agent-lead-reconcile.yml` had before RA-1483 — which now
 * reconciles every open project every tick, making every non-first project read
 * `starved` while it was being worked on normally.
 *
 * @param {{proposed: number, members: any[], held: boolean, briefItems?: any[]}} input
 *   `briefItems` is the brief's `parseProposed` output; omitted or unparsed, every member counts.
 */
export function classifyProject({ proposed, members, held, briefItems }) {
  // COUNTED BY THE CLOSURE RULE, NOT BY MEMBERSHIP (RA-2414). This counted every open member
  // as outstanding, so a project whose own work was finished but which had inherited a
  // `sev:low` follow-up never read `complete`, and counted the follow-up as remaining work
  // until the tick closed the tracking issue around it. Every set below is the
  // reconciler's own function, so the two cannot disagree about which members count:
  //   · work     — `openGatingWork` over ALL members: what gates closure, minus the QA
  //                issue (open for as long as the project is unverified, so counting it
  //                would hide "ready to verify" for exactly the phase it describes).
  //   · carried  — `carriedOut`: open, reported, never waited on.
  //   · unfiled  — brief items no member satisfies yet (`itemSatisfied`): work too, or a
  //                project with one filed-and-closed item of three would read complete.
  // ONLY FOR A BRIEF THE RECONCILER CAN PARSE. On an unparsed or partly parsed brief
  // (no items — which is also the only shape a `reason` comes on — or any `residue`) the
  // join matches too little, so members would read carried out and the project
  // `complete`, while the reconciler itself stops (`parsedFully`, the same two tests).
  // Then every member counts, as before RA-2414, and nothing is carried out.
  const parsed = Array.isArray(briefItems) && briefItems.length > 0
    && !(/** @type {any} */ (briefItems).residue?.length);
  const openMembers = members.filter((m) => m.state === 'OPEN');
  const work = parsed ? openGatingWork(members, briefItems) : members;
  const open = work.filter((m) => m.state === 'OPEN');
  const closed = work.length - open.length;
  const unfiled = parsed ? briefItems.filter((item) => !itemSatisfied(item, members)).length : 0;
  const total = closed + open.length + unfiled;
  // Still REPORTED (RA-1783: every member is), just not counted as outstanding.
  const carriedOut = (parsed ? reconcilerCarriedOut({ open: openMembers, proposed: briefItems }) : [])
    .map((m) => ({ number: m.number, url: m.url }));

  /**
   * HELD OUTRANKS EVERY OTHER STATUS, including `complete` (RA-1462).
   *
   * `needs:human` means a tick's action FAILED and `agent-lead-reconcile.yml` now
   * takes no actions at all while the label is on — `lead-reconcile.mjs`'s
   * `if (phase === 'held')` stop in `nextActionsCore`, cited by CONTENT rather than by
   * line because that file moves under this citation and `383-396` had already drifted
   * onto the `reopened` branch (RA-1471). So
   * every other status describes an action the reconciler cannot currently take,
   * and printing one tells the reader to do something that cannot work — this
   * script's own stated error class (see the header).
   *
   * It was checked third, so a project held before its first filing succeeded —
   * `members.length === 0` — rendered the loudest line the digest emits, "never
   * reconciled … none are filed", for a project deliberately stopped. That is the
   * LIKELY shape rather than a corner: `hold()` fires on a failed action, and the
   * canonical example in its own comment is a brief naming a nonexistent
   * milestone, which fails in the FILE phase.
   *
   * WHY IT ALSO OUTRANKS `complete`, which RA-1462 left open rather than inheriting:
   * a held project whose members have all closed still cannot reach verification
   * or be closed, because the tick that would do it is stopped. "Ready to verify
   * and close" would be the same wrong instruction. Nothing is lost by ranking it
   * first — `renderProject` prints `closed/filed done` in the header regardless, so
   * a held-and-finished project reads "5/5 done" AND held, which is the whole truth.
   */
  const counts = { open: open.length, closed, filed: members.length, total, carriedOut };
  if (held) return { status: 'held', ...counts };

  // An UNPARSED brief with nothing filed is unfiled too, whatever it proposes: the
  // reconciler stops on it (`brief-unparseable` / `brief-partially-parsed`), so it is as
  // stuck as a project nobody reconciled. Without this, a brief whose items the parser
  // cannot read proposes 0 and would render as an `active` 0/0.
  if (members.length === 0 && (proposed > 0 || (Array.isArray(briefItems) && !parsed))) {
    return { status: 'unfiled', ...counts, filed: 0 };
  }
  if (open.length === 0 && unfiled === 0 && members.length > 0) {
    return { status: 'complete', ...counts };
  }
  return { status: 'active', ...counts };
}

/** The Lead's hold marker, as `scripts/lead-reconcile.mjs` writes it.
 *
 * TWO HAND-KEPT COPIES OF A STRING A WRITER AND A READER IN A DIFFERENT PROCESS MUST
 * AGREE ON (RA-1673) — the same drift `qaIssueTitle` in the reconciler is extracted to
 * avoid. The digest deliberately does NOT import the reconciler (it imports the pure
 * `project-closure.mjs` instead, and a test forbids importing `lead-reconcile.mjs`, whose
 * top level is a CLI), so this copy stays hand-kept; making it an import means moving the
 * marker into a shared module first. The guard below holds either way.
 * The guard is a TEST rather than a definition — `tests/unit/project-digest.test.ts`
 * imports `renderHoldComment` from the reconciler and asserts this marker appears in
 * what it actually writes. Without it the pair fails SILENTLY and GREEN: `holdReason`
 * returns null, `renderProject` degrades to the bare `*held*` line, and RA-1469 is undone
 * with a clean test run.
 */
export const HELD_MARKER = '<!-- qa:lead-held -->';

/** Comments per page — the API maximum, so the fewest requests. */
const PER_PAGE = 100;

/** The hold comments in one page of comments, oldest first. */
const marked = (comments) => (comments ?? []).filter((c) => (c.body ?? '').includes(HELD_MARKER));

/**
 * Why the reconciler is holding this project, from its own hold comments (RA-1469).
 *
 * THE LAST MARKED COMMENT WINS. `hold()` is idempotent per distinct reason set, so a
 * project held for one cause and later stopped for another carries both — and the
 * newest is the one still true.
 *
 * Slack-escaped and truncated here rather than at the call site: this string is
 * assembled from an issue comment, so it is the only untrusted text in the message.
 *
 * @param {{body?: string}[]} comments  newest last, as the REST API returns them
 * @param {number} [max]
 * @returns {string|null}
 */
export function holdReason(comments, max = 160) {
  const body = marked(comments).at(-1)?.body;
  if (!body) return null;
  const bullet = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('- '));
  if (!bullet) return null;
  const text = bullet.slice(2).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Slack's `text` field treats these three as markup; nothing else needs escaping.
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

/**
 * The reason off the NEWEST hold comment, reading comment pages newest-page-first (RA-1673).
 *
 * `?per_page=100` ALONE READS THE OLDEST HUNDRED. The "List issue comments" endpoint
 * returns ascending order and is not paginated by its caller, so on a tracking issue
 * past 100 comments this named a SUPERSEDED cause — which is worse than naming none,
 * because a stale reason reads as current and RA-1469 exists so the reason can decide
 * whether this is a one-line brief edit or a decision the developer owes the project.
 *
 * `direction=desc` DOES NOT FIX IT, and that is measured rather than assumed: the
 * endpoint documents only `since`/`per_page`/`page`, and
 * `?per_page=100&sort=created&direction=desc` against this repo returns the identical
 * ascending id order. Inverting `holdReason`'s "newest last" contract on the strength
 * of a parameter the server ignores would have swapped the bug for its mirror.
 *
 * SO THE LAST PAGE IS COMPUTED, NOT DISCOVERED. The issue's own `comments` count is
 * already in hand from the read that decided the project is held, so finding the last
 * page costs no request and no `Link`-header parsing (`api` returns parsed JSON and
 * drops headers). Pages are walked backwards and the walk STOPS at the first page
 * carrying a hold comment — not at the first page that yields a REASON, so a newest
 * hold comment somebody hand-edited the bullet out of says nothing rather than
 * resurrecting an older cause, which is the same "degrade to nothing rather than
 * guessing" `holdReason` already promises.
 *
 * The ordinary cost is exactly one request, as before: a held project's hold comment is
 * written by the reconciler and is normally among the newest.
 *
 * @param {(path: string) => Promise<any>} api
 * @param {string} repo
 * @param {number} issue
 * @param {number} commentCount  the issue's own `comments` field
 * @param {number} [max]
 * @returns {Promise<string|null>}
 */
export async function holdReasonOf(api, repo, issue, commentCount, max = 160) {
  const pages = Math.max(1, Math.ceil((commentCount ?? 0) / PER_PAGE));
  for (let page = pages; page >= 1; page--) {
    const comments = await api(`/repos/${repo}/issues/${issue}/comments?per_page=${PER_PAGE}&page=${page}`);
    if (!marked(comments).length) continue;
    return holdReason(comments, max);
  }
  return null;
}

/**
 * The NEWEST run of a member issue's comments — enough of them for `classifyDispatch`,
 * and no more (RA-1705). Since kanon#179 the run reaches back to the Implementer's last
 * comment rather than the last `BAIL_RE` match, because authorship decides now.
 *
 * SAME DEFECT AS `holdReasonOf`, one screen further down and untouched by RA-1673:
 * `?per_page=100` alone reads the OLDEST hundred, and every derivation
 * `classifyDispatch` performs is about the newest state — it takes the LAST `BAIL_RE`
 * match and reads `answered` off whether anything follows it. Fed the oldest hundred, a
 * member issue past 100 comments reports `dispatched`/`stall` for one that is bailed and
 * waiting on a human, or `bail` for one already answered.
 *
 * NOT A DROP-IN OF `holdReasonOf`, and that is the whole subtlety. That function needs
 * one page carrying one predicate; this one needs a CONTIGUOUS run ending at the newest
 * comment and reaching back past the last bail, because "anything after the last bail
 * answers it" splits across a page boundary. So pages are walked backwards and
 * ACCUMULATED, stopping at the first page (newest-first) that carries a bail — that page
 * holds the last bail, and every comment after it is already in hand.
 *
 * The ordinary cost is one request, exactly as before: no issue in this repo has ever
 * had more than single-digit comments, which is why RA-1705 is a latent defect with a real
 * trigger rather than a live one.
 *
 * @param {(path: string) => Promise<any>} api
 * @param {string} repo
 * @param {number} issue
 * @param {number} commentCount  the issue's own `comments` field, which `/search/issues`
 *   items carry — so finding the last page costs no extra request
 * @returns {Promise<{login: string|null, body: string|null, createdAt: string}[]>}
 */
export async function dispatchCommentsOf(api, repo, issue, commentCount) {
  const pages = Math.max(1, Math.ceil((commentCount ?? 0) / PER_PAGE));
  let run = [];
  for (let page = pages; page >= 1; page--) {
    const batch = (await api(`/repos/${repo}/issues/${issue}/comments?per_page=${PER_PAGE}&page=${page}`))
      .map((c) => ({ login: c.user?.login ?? null, body: c.body, createdAt: c.created_at }));
    run = [...batch, ...run];
    // The page holding the Implementer's last word: everything `classifyDispatch` reads
    // follows it. Attempt counting (only `exhausted`) may see fewer sweep comments on an
    // issue past 100 comments, which is a report detail rather than a classification.
    if (batch.some(byImplementer)) break;
  }
  return run;
}

const ICON = {
  complete: ':white_check_mark:',
  active: ':large_yellow_circle:',
  unfiled: ':red_circle:',
  held: ':octagonal_sign:',
};

/**
 * One line per member issue that needs a human's attention, or nothing.
 *
 * @param {{number: number, title: string, url: string, ageDays: number,
 *          disposition: string|null}} m
 * @returns {string|null} null when the issue needs nothing said about it
 */
export function renderMember(m) {
  const t = m.title.length > 68 ? `${m.title.slice(0, 65)}…` : m.title;
  const link = `<${m.url}|#${m.number}>`;
  switch (m.disposition) {
    case 'bail':
      return `        :hand: ${link} ${t}\n            *awaiting your decision* — ${m.reason ?? 'scope-first bail'}, ${m.waitedDays}d`;
    // A human answered the SWEEP rather than the Implementer ("stop, this needs design"),
    // and the sweep holds it rather than dispatching again.
    case 'human-held':
      return `        :raised_hand: ${link} ${t}\n            *held* — a human replied to the dispatch sweep and nothing has run since`;
    case 'authorised':
      // NOT "needs a re-dispatch". Without `actions: read` this cannot see a run
      // already in flight, and asserting an action the reader may have taken an
      // hour ago is the same error class as calling a bail a stall. Say what is
      // known — the decision is made and no PR exists yet — and let the reader
      // draw the conclusion.
      return `        :arrows_counterclockwise: ${link} ${t}\n            authorised ${m.waitedDays}d ago — no PR yet`;
    case 'stall':
      return `        :warning: ${link} ${t}\n            *no PR after ${m.ageDays}d* — likely a stalled dispatch`;
    case 'building':
      return `        :hammer: ${link} ${t} — building`;
    // LOUD, and phrased as a state rather than an instruction, because since RA-2150 this
    // is no longer the developer's to clear by default: `agent-rebase.yml` resolves a
    // conflicting pipeline PR, and the Merger WAITS rather than escalating while it owns one
    // (RA-2218). Both halves of the old comment — "no agent will clear this one" and "who
    // rebases is deliberately undecided" — were true when written and are now false.
    //
    // It stays LOUD anyway, and that is a judgement rather than an oversight: the lane
    // can still refuse (a semantic conflict, a foreign branch), a resolution still needs
    // the Reviewer's re-review, and a member nobody can act on for hours is exactly what this
    // digest exists to surface. What changed is that the reader is being told the work
    // has stopped, not told to go and fix it.
    case 'conflicting':
      return `        :rotating_light: ${link} ${t}\n            *PR conflicts — ${CONFLICT_SHORT}* — no CI, no review, no churn can move it`;
    // Not a dispatch state at all, but the same shape as the defect this digest
    // exists to prevent: a member parked on a human and nobody told (RA-1443
    // review, finding 3). `qa:needs-info` is the implementer asking a question.
    case 'needs-info':
      return `        :grey_question: ${link} ${t}\n            *awaiting your answer* — the implementer asked a question`;
    // Too big for one implementer run (RA-1781): its run hit the turn or budget cap, and
    // the Lead's split lane proposes smaller children as a PR against the brief. Not a
    // question for the reader — the split PR is — but a stall if that PR never appears.
    case 'needs-split':
      return `        :scissors: ${link} ${t}\n            *awaiting a split* — its implementer run hit the cap; the Lead's split PR against the brief replaces it`;
    case 'verify':
      return `        :mag: ${link} ${t} — verification`;
    default:
      return null;
  }
}

/**
 * @param {{number: number, url: string, title: string, status: string, proposed: number,
 *          filed: number, closed: number, total?: number, heldReason?: string|null,
 *          briefItems?: any[] & {reason?: string|null, residue?: string[]},
 *          carriedOut?: {number: number, url: string}[],
 *          members?: {number: number, title: string, url: string, ageDays: number,
 *                     disposition: string|null}[]}} p
 * @returns {string}
 */
export function renderProject(p) {
  // THE PROJECT'S OWN WORK, IN BOTH HALVES (RA-2414): `closed` and `total` come from
  // `classifyProject`'s gating set, so a carried-out member — open or since closed — moves
  // neither, and an unfiled brief item is in the denominator. Falls back to the proposal
  // count while nothing is counted (an unfiled project, or a caller without `total`).
  const carried = p.carriedOut ?? [];
  const head = `${ICON[p.status] ?? ':grey_question:'}  *<${p.url}|#${p.number}> — ${p.title}*  ·  ${p.closed}/${p.total || p.filed || p.proposed} done`;
  // The brief path is in amended AC 4, and it is the first thing a reader opens
  // when they want the decomposition behind these numbers.
  const lines = [head, `        \`${BRIEF_DIR}/${p.number}.md\``];
  switch (p.status) {
    case 'complete':
      lines.push(carried.length
        ? "        the project's own work is closed — ready to verify and close"
        : '        every filed issue closed — ready to verify and close');
      break;
    case 'unfiled':
      // A brief the parser only PARTLY read (residue) is stopped on exactly like one it
      // could not read at all, so both name the parse failure rather than a count.
      if (p.proposed && p.briefItems?.residue?.length) {
        lines.push(`        *never reconciled* — the brief's decomposition only partly parses (${p.proposed} read, ${p.briefItems.residue.length} not recognised), so nothing is filed until it is fixed`);
      } else {
        lines.push(p.proposed
          ? `        *never reconciled* — the brief proposes ${p.proposed} issues and none are filed`
          : `        *never reconciled* — the brief's decomposition does not parse (${p.briefItems?.reason ?? 'no `### Issue X — …` items'}), so nothing can be filed`);
      }
      break;
    case 'held':
      // NAMES THE CAUSE, NOT ONLY THE STATE (RA-1469). Every other loud status here
      // carries its reason — `unfiled` names the proposal count, a bail names the wait
      // in days — and `held` was the one that stopped at the state, while being the one
      // whose cause is least guessable: a brief naming a nonexistent milestone, an
      // unparseable decomposition, a dependency matching nothing, or a terminal phase-5
      // stop. The reader should be able to tell what has to be FIXED without opening
      // the tracking issue.
      //
      // NOT SCRAPED PROSE. `hold()` writes an HTML-comment marker, and the reason is
      // read from the bullet list under it — a machine marker this file's own author
      // controls, which is the distinction the header's "STARVATION IS DERIVED, NOT
      // SCRAPED" note draws. When the marker is absent the line degrades to what it
      // said before, rather than guessing.
      lines.push(p.heldReason
        ? `        *held* — the tracking issue carries \`needs:human\`: ${p.heldReason}`
        : '        *held* — the tracking issue carries `needs:human`');
      break;
    default:
      break;
  }
  // REPORTED, NOT WAITED ON (RA-1783, RA-2414) — its own line so leaving it out of the
  // fraction above cannot also make it disappear. Every member is reported; these are the
  // ones the tick closes the project around, as the retro's "Left open at close" will say.
  if (carried.length) {
    const shown = carried.slice(0, 12).map((c) => `<${c.url}|#${c.number}>`).join(', ');
    const more = carried.length > 12 ? ` +${carried.length - 12} more` : '';
    lines.push(`        carried out: ${carried.length} — open, not waited on: ${shown}${more}`);
  }
  for (const m of p.members ?? []) {
    const line = renderMember(m);
    if (line) lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

/** @param {Date} d @returns {string} */
export const formatDay = (d) =>
  d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Did the narrative go missing on a day it was owed? (RA-1476.)
 *
 * An absent `narrative.txt` is the DESIGNED degraded path, which is exactly why
 * every cause of one looked the same: the step is `continue-on-error: true`, the
 * read is `|| true`, and the post simply had no prose. A denied tool (RA-1473), a
 * model-id typo, `--max-turns` exhaustion, a quota cap and an action outage all
 * produced the same silent, green, prose-less post.
 *
 * THE TRACE GOES IN THE POST, NOT ONLY ON THE RUN. `weekly-digest.mjs` uses a
 * `::warning` annotation, and `docs/observability.md` §12 admits that nobody
 * watches a green run's annotations. That trade suits a weekly post to a
 * stakeholder, who should never see pipeline jargon. This post goes to the
 * developer, every day, and the post is the one surface they do read. So a
 * missing narrative adds one line to it, linking the run, and the annotation is
 * kept as the searchable half.
 *
 * NOT ON A NO-PROJECTS DAY. With nothing open there is nothing to narrate, and a
 * marker every quiet day would train the reader to skip it.
 *
 * @param {{narrative?: string|null, projects: unknown[]}} input
 * @returns {boolean}
 */
export const narrativeMissing = ({ narrative, projects }) =>
  projects.length > 0 && !(narrative ?? '').trim();

/**
 * Assemble the post. Pure, so the shape is testable without the network.
 *
 * NO NARRATIVE SANITISER, unlike the weekly digest, and that is a decision not
 * an omission: its rules forbid naming an environment or anything pending,
 * which are exactly the things this post exists to say. The audience is the
 * developer, and there is no stakeholder-facing claim to fail closed on.
 *
 * @param {{today: Date, narrative?: string|null,
 *          projects: Parameters<typeof renderProject>[0][], runUrl?: string|null}} input
 * @returns {string}
 */
export function buildMessage({ today, narrative, projects, runUrl = null }) {
  let text = `:clipboard: *Projects, ${formatDay(today)}*\n`;
  const prose = (narrative ?? '').trim();
  if (prose) text += `\n${prose}\n`;
  if (narrativeMissing({ narrative, projects })) {
    const where = runUrl ? `<${runUrl}|the run>` : 'the run';
    text += `\n_No narrative today: the model step wrote nothing. The numbers below are complete; ${where} says why._\n`;
  }
  if (projects.length === 0) {
    text += '\nNo open projects — every brief in `docs/projects/` has a closed tracking issue.\n';
    return text;
  }
  text += '\n';
  for (const p of projects) text += `${renderProject(p)}\n`;
  const done = projects.filter((p) => p.status === 'complete').length;
  text += `_${projects.length} open project${projects.length === 1 ? '' : 's'}`;
  if (done) text += ` · ${done} ready to close`;
  text += '_';
  if (text.length > 12000) text = `${text.slice(0, 11800)}\n… _truncated_`;
  return text;
}

// ---------------------------------------------------------------------------
// I/O below this line. Everything above is pure and unit-tested, with one named
// exception: `holdReasonOf` takes its `api` as an argument (RA-1673), the same
// injectable-runner idiom `hold()` uses in the reconciler and for the same reason —
// a page walk is logic, and logic that can only be reached through `fetch` is logic
// nothing tests.
// ---------------------------------------------------------------------------

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  const {
    GITHUB_TOKEN,
    GITHUB_REPOSITORY: repo,
    NARRATIVE,
    TODAY,
    DRY_RUN,
  } = process.env;
  const webhook = digestWebhook(process.env);

  if (!GITHUB_TOKEN || !repo) {
    console.error('Missing required env: GITHUB_TOKEN, GITHUB_REPOSITORY');
    process.exit(1);
  }
  if (!webhook && !DRY_RUN) {
    // Graceful no-op, matching announce-deploy and weekly-digest: a missing
    // webhook must not fail a scheduled job whose output is a nice-to-have.
    console.warn('DIGEST_WEBHOOK not set — skipping digest.');
    process.exit(0);
  }

  const HEADERS = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const api = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const search = async (q) =>
    (await api(`/search/issues?q=${encodeURIComponent(`repo:${repo} ${q}`)}&per_page=100`)).items;

  const today = TODAY ? new Date(TODAY) : new Date();
  const days = (iso) => Math.floor((today - new Date(iso)) / 86400000);

  // Briefs come off the CHECKOUT, not the API — the workflow checks out `main`,
  // and reading the file is both cheaper and exactly what the reconciler does.
  const briefs = readdirSync(BRIEF_DIR)
    .filter((f) => /^\d+\.md$/.test(f))
    .map((f) => ({ number: Number(f.replace('.md', '')), markdown: readFileSync(`${BRIEF_DIR}/${f}`, 'utf8') }))
    .sort((a, b) => a.number - b.number);

  const projects = [];
  for (const b of briefs) {
    const tracking = await api(`/repos/${repo}/issues/${b.number}`);
    if (tracking.state !== 'open') continue;
    const held = (tracking.labels ?? []).some((l) => (l.name ?? l) === 'needs:human');
    // GATED ON `held`, which is normally zero projects (RA-1469). One extra comments read
    // per HELD project, never an unconditional one — the cost objection in that issue.
    // Still one read in the ordinary case after RA-1673: `holdReasonOf` starts at the
    // LAST page and stops there when it carries a hold comment, which it normally does.
    // It costs a second read only on a tracking issue past 100 comments whose newest
    // page has none — and that case is precisely the one that used to report a
    // superseded cause as current.
    const heldReason = held ? await holdReasonOf(api, repo, b.number, tracking.comments) : null;

    // Membership is the marker (RA-1066), by the reconciler's position rule — see
    // `membersOf`. `in:body` is a term search, so it only narrows.
    // `is:issue` is BOTH the AGENTS.md counting rule (never count PRs alongside
    // issues) and a hard API requirement — the search endpoint 422s without
    // `is:issue` or `is:pull-request`, which the first dry run found.
    const hits = await search(`is:issue "qa:project ${b.number}" in:body`);
    const members = membersOf(hits, b.number);

    const enriched = [];
    for (const m of members) {
      const labels = (m.labels ?? []).map((l) => l.name ?? l);
      const base = {
        number: m.number, title: m.title, url: m.html_url, labels, body: m.body ?? '',
        state: m.state.toUpperCase(), ageDays: days(m.updated_at), waitedDays: days(m.updated_at),
      };
      if (m.state !== 'open') {
        enriched.push({ ...base, disposition: null });
        continue;
      }
      // A member parked on a human is reported whatever put it there — not only a
      // dispatched one. `qa:needs-info` is the implementer asking a question, and
      // dropping it silently was the same defect as the bail it exists to catch.
      if (!labels.includes('agent:implement')) {
        const parked = labels.includes('qa:needs-info') ? 'needs-info'
          : labels.includes('qa:needs-split') ? 'needs-split'
          : labels.includes('qa:verify') ? 'verify'
          : null;
        enriched.push({ ...base, disposition: parked });
        continue;
      }
      const comments = await dispatchCommentsOf(api, repo, m.number, m.comments);
      // The search is `in:body`, a TERM search that matches a PR merely naming the
      // number. `closesIssue` is the predicate; without it this PR's own body would
      // have marked RA-1305-RA-1308 "building".
      const candidates = await search(`is:pr is:open ${m.number} in:body`);
      const closing = candidates.filter((p) => closesIssue(p.body, m.number, repo));
      const hasPr = closing.length > 0;
      // ONE EXTRA READ, AND ONLY FOR A MEMBER THAT HAS A PR — the same shape as the
      // `held`-gated comments read above, and for the same cost objection (RA-1469).
      // Mergeability is not on the search result: `/search/issues` returns the issue
      // projection of a PR, which carries no `mergeable_state`, so the pull object has
      // to be fetched. A read that fails is NOT conflicting — this digest must not
      // invent a stop — and `conflictState` already reports GitHub's own
      // still-computing answer as `computing`, which is not one either.
      let prConflicting = false;
      for (const c of closing) {
        try {
          if (conflictState(await api(`/repos/${repo}/pulls/${c.number}`)) === 'conflicting') {
            prConflicting = true;
            break;
          }
        } catch (err) {
          // unreadable: leave it reading as `building`, which is the pre-RA-1722 answer.
          // A trimmed read is not that — same re-throw as the two reconciler lanes.
          if (err instanceof ConflictFieldsUnread) throw err;
        }
      }
      enriched.push({
        ...base,
        ...classifyDispatch({ comments, labels, hasPr, prConflicting, ageDays: days(m.updated_at), now: today }),
      });
    }

    projects.push({
      number: b.number,
      url: tracking.html_url,
      title: briefTitle(b.markdown, tracking.title),
      // The reconciler's own parse, for the closure rule's decomposition join (RA-2414) AND
      // the proposal count. No `knownLabels`: they only validate an item's labels, never
      // its title or `Closes`.
      ...readBrief(b.markdown),
      members: enriched,
      held,
      heldReason,
    });
  }

  for (const p of projects) {
    Object.assign(p, classifyProject({
      proposed: p.proposed,
      members: p.members,
      held: p.held,
      briefItems: p.briefItems,
    }));
  }

  const { GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  const runUrl = GITHUB_SERVER_URL && GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${repo}/actions/runs/${GITHUB_RUN_ID}` : null;
  if (narrativeMissing({ narrative: NARRATIVE, projects })) {
    // The searchable half of the trace (RA-1476); the post carries the visible half.
    console.warn(
      '::warning title=project digest narrative missing::narrative.txt was absent or empty, so the digest ' +
      'posted numbers-only. Causes that look identical here: a denied tool (RA-1473), a model-id typo, ' +
      '--max-turns exhaustion, a quota cap, an action outage. See the narrative step and the ' +
      '"Say whether the model was unreachable" step.',
    );
  }
  const text = buildMessage({ today, narrative: NARRATIVE, projects, runUrl });

  if (DRY_RUN) {
    console.log(`DRY RUN\n--- Slack message ---\n${text}`);
    process.exit(0);
  }

  const slack = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!slack.ok) throw new Error(`Slack webhook → ${slack.status}: ${await slack.text()}`);
  console.log(`Posted the ${formatDay(today)} project digest to Slack.`);
}
/* c8 ignore stop */
