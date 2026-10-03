#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-949 — the project brief has a required shape, and this checks the mechanical half.
//
// WHY A BRIEF AND NOT SOME OTHER DOC. A brief is the developer's ONLY gate per project
// (`docs/agentic-lead-engineer.md` §5.3): everything downstream — which issues exist,
// what the implementer builds, what the reviewer checks — follows from it, and the
// developer is not consulted again until something escalates. If its shape varies run
// to run the gate cannot be exercised quickly, and worse: **an omitted section reads
// exactly like a section with nothing to say.** That is `silent-absence` (RA-946), the
// failure class this pipeline generates structurally, on the artifact with the widest
// blast radius. So the rule from `agentic-qa-pipeline.md` §5 — *a detector reports what
// it examined, not only what it found* — applies to briefs: every required section
// carries an explicit statement, never an empty heading.
//
// DERIVED, NOT IMAGINED. RA-949 refused to standardise before a real brief existed,
// because "a regex for what `linked` ought to mean" is the failure mode behind every
// Tier-1 finding in the session that produced RA-946. Six briefs now exist — 961, 1015,
// 1019, 1291, 1292 and 284, all on `main` — and the required sections below were their
// measured INTERSECTION, not a wish list.
//
// AND THEN NARROWED, ALSO BY MEASUREMENT (RA-1742). The intersection of six documents is
// not the same question as "what must a brief decide", and the eleven it produced were
// three sections wider. A brief holds three jobs: DECISIONS the developer must make,
// the DECOMPOSITION the reconciler files, and — the one that should never have been
// there — MEASUREMENT. Job 3 is what the six briefs cost:
//
//   6 briefs, 851–1421 lines each          ~7,000 lines, mean ~1,150
//   328 `file:line` coordinates in them    `grep -rhoE '`[^`]+\.(ts|mjs|yml|md):[0-9]+' docs/projects/[0-9]*.md | wc -l`
//   20 commits editing a brief AFTER it merged, four of them (RA-1198, RA-1220, RA-985,
//     RA-1417) re-deriving `961.md`'s coordinates for no reason but to keep lint green
//   4,769 lines of JS guarding the brief system, and three consecutive corrective
//     batches (RA-1658, RA-1702, RA-1731) spent making those guards tell the truth
//
// A document cannot be falsifiable; only a test can. The repo already has the artifact
// that can be — `docs/qa/specs/**`, 256 `[PREFIX-N]` invariants with a lifecycle, an id
// allocator, coverage checking and citation from tests — and it generated almost none
// of that follow-up volume. So the fix is to REMOVE job 3, not to guard it better:
// SEQUENCING (the parser reads `Depends on:`), RECONCILIATION STATE (`npm run
// spec:coverage` computes it, and a gap it finds is an ISSUE, not a paragraph) and
// DEFINITION OF DONE (identical for every project: every filed issue closed, the merges
// on staging, `verify-acs` green) are no longer required sections, and two things a
// brief may no longer CLAIM are checked below.
//
// WHAT THIS BUYS THAT A TICK DOES NOT. EIGHT of these checks are things
// `lead-reconcile.mjs` ALREADY refuses to act on, each named by the string it refuses
// with rather than by a line number:
//
//   an unparsed decomposition        `'brief-unparseable'`
//   residue                          `'brief-partially-parsed'`
//   a missing milestone              "carry no milestone"
//   an empty issue body              "would be filed with an EMPTY body"
//   a welded label token             "label token(s) that are not labels"
//   a stray `Closes #N`              "name a closing reference the parser does not read"
//   an undeclared dependency         "a brief defect, not a wait"
//   a dependency cycle               "dependency cycle in the brief"
//
// BY CONTENT, AND THE REASON IS THIS LIST'S OWN HISTORY (RA-1362). It has been wrong
// three times in three rounds of one review: it said SIX over a list of six while the
// standard said eight, because the two dependency checks were added and the count was
// not; then two of its labels sat one branch to the right of their coordinate; then
// RA-1671 rewrote this file and moved all eight. A line number into a file under active
// rewrite is stale on arrival, and RA-1671 converted its own `1291.md` citations for the
// same reason — a plain renumber fixes today and re-arms the drift. These strings are
// greppable and move with the code. Today every one of
// them is discovered at TICK time: hours after the developer merged the brief, as a
// stopped reconcile that files nothing and waits for a human to edit a merged
// document. The information was fully present in the diff the reviewer was reading.
// This moves it there.
//
// WHAT IT DELIBERATELY DOES NOT CHECK, and why — because a guard that quietly declines
// half its remit is the same silent-absence it exists to catch:
//
//   · THAT EVERY AC RESOLVES TO A DECLARED INVARIANT. RA-949 lists it; it cannot be a
//     lint gate. A brief PROPOSES `[seed]` invariants that do not exist yet — measured,
//     `1292.md` declares 11 such IDs (`AUTH-1..9`, `KIOSK-30..32`) and `284.md` four
//     (`STORE-93..96`). Failing lint on them would forbid the brief's central job.
//     `verify-acs.mjs` answers this question at the right time, against the tree that
//     was supposed to have implemented them. What IS checked here is the SHAPE — that
//     each criterion is an id and not a restated sentence — which is decidable now.
//   · HOW LONG A BRIEF IS. §5.7 states a ~300-line target against the old ~1,150-line
//     mean, and this guard does not enforce it, deliberately: a line count is not a
//     defect, and a brief with a genuinely large decomposition is long for a legitimate
//     reason. The two things that WERE defects — a coordinate and a restated criterion
//     — are checked directly, and they are most of the length. A guard on the symptom
//     would fire on the honest case and be overridden, which is worse than none.
//   · WHETHER ANY OF IT IS TRUE. Compliance theater is the standing risk RA-949 names
//     itself: a brief can be complete and vacuous exactly as a test can be green and
//     vacuous. Mechanism checks shape; only a reader checks meaning.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { BUCKET_MILESTONES, DEFAULT_MILESTONE } from './issue-triage-defaults.mjs';
import { isDatedMilestone } from './lib/milestones.mjs';
import { coordinatesIn } from './citation-guard.mjs';
import { readExemptions } from './lib/exemptions.mjs';
import { dependencyCycles, parseProposed } from './lead-reconcile.mjs';
import { isAcDeclaration } from './verify-acs.mjs';

/**
 * WHICH MILESTONE AN ITEM MAY NAME (`K-LAYOUT-12`, kanon#54): one of Kanon's two buckets,
 * whose names are fixed (`K-WORK-4`), or a roadmap milestone of this repository, which is
 * the Stakeholder's to name (`K-WORK-5`). The buckets are imported from the backstop that
 * writes them, so there is one copy. A roadmap milestone is not a list anyone keeps: it is a
 * milestone with a due date (`K-WORK-3`, the shared `isDatedMilestone`), read from the
 * repository only when a brief names something other than a bucket. Until #54 this was the
 * reference adopter's routing table, with its launch gate and its AI epic written in.
 *
 * A closed roadmap milestone still counts. A brief that named it when it was open is a record
 * of a decision (`K-PROJ-10`), and the brief must not turn red when the gate is met.
 *
 * @typedef {{ title: string, due_on?: string | null, dueOn?: string | null, state?: string }} Milestone
 */
export const ROUTING_BUCKETS = BUCKET_MILESTONES;

/**
 * The repository's milestones, open and closed, through `gh` (`{owner}/{repo}` is the
 * current checkout's, or `GH_REPO`'s). Throws when they can't be read.
 * @returns {Milestone[]}
 */
export const liveMilestones = () =>
  execFileSync('gh', ['api', '--paginate', 'repos/{owner}/{repo}/milestones?state=all&per_page=100', '--jq', '.[] | {title, due_on, state}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/**
 * Why `milestone` can't be named by an item, or `null` when it can.
 * @param {string} milestone
 * @param {() => Milestone[]} milestones read only when `milestone` isn't a bucket
 * @returns {string | null}
 */
export function milestoneProblem(milestone, milestones) {
  if (ROUTING_BUCKETS.includes(milestone)) return null;
  const buckets = ROUTING_BUCKETS.join(', ');
  let all;
  try {
    all = milestones();
  } catch (e) {
    const why = String(e?.stderr || e?.message || e).trim().split('\n')[0];
    return `isn't a bucket (${buckets}), and the repository's milestones couldn't be read to check it is a roadmap milestone (${why})`;
  }
  const found = all.find((m) => m.title === milestone);
  if (!found) return `isn't a bucket (${buckets}) or a milestone of this repository (K-WORK-4, K-LAYOUT-12)`;
  if (!isDatedMilestone(found)) {
    return `has no due date, so it isn't a roadmap milestone, and it isn't a bucket (${buckets}) either (K-WORK-3, K-WORK-4)`;
  }
  return null;
}

/**
 * A required section is matched by MEANING, not by its exact heading.
 *
 * Numbering and wording both vary across the six briefs and should: `## 5. AWS cost`,
 * `## 6. AWS cost — **no delta**, and why`, `## 1. The measurement` vs `## 1. The real
 * problem`. Some of them also COMBINE sections — `## 9. Reconciliation state, and blast
 * radius` in both `1015.md` and `284.md` — and that is good writing, not a deviation:
 * where two required sections are the same story, splitting them would make the brief
 * worse. A combined heading satisfies both entries, which falls out of matching each
 * independently.
 *
 * ORDER IS NOT CHECKED either, for the same reason: `1291.md` opens with Scope and
 * `1292.md` opens with the problem, and each is right for its project.
 */
export const REQUIRED_SECTIONS = [
  {
    key: 'problem',
    label: 'the real problem / the measurement',
    match: /real problem|the measurement/i,
    why: 'read the code before planning — N point-fixes for one root cause is the failure the brief exists to prevent (`K-PROJ-4`)',
  },
  {
    key: 'scope',
    label: 'scope',
    match: /\bscope\b/i,
    why: 'and explicitly what it is NOT: the boundary is the half that gets forgotten (`K-PROJ-4`)',
  },
  {
    key: 'decomposition',
    label: 'decomposition',
    match: /decomposition/i,
    why: 'the unit of dispatch — the only machine-read part of a brief (`K-PROJ-9`)',
  },
  {
    key: 'cost',
    label: 'cost',
    match: /\bcost\b/i,
    why: 'agreement comes BEFORE spend; an empty section reads as "not considered" (`K-PROJ-6`, `K-OBS-9`)',
  },
  {
    key: 'observability',
    label: 'observability',
    match: /observability/i,
    why: 'the add-or-skip decision is surfaced, not made silently (`K-PROJ-6`, `K-OBS-1`)',
  },
  {
    key: 'blast',
    label: 'blast radius',
    match: /blast radius/i,
    why: 'the escalation items a project touches are otherwise discovered mid-PR, converting one up-front decision into N interrupts (`K-PROJ-6`)',
  },
  {
    key: 'decisions',
    label: 'decisions',
    // Plural and heading-leading, deliberately: `1292.md` also has `## 3. The decision
    // that sizes the project`, which is an ARGUMENT, not the list of questions the
    // developer must answer. A loose match would let a brief satisfy this section with
    // a design digression and never ask anything.
    match: /^(?:\d+[.)]\s*)?(?:the\s+)?decisions\b/i,
    why: 'the questions that need a human, in one place, because this merge is the only time they are asked (`K-PROJ-5`)',
  },
  {
    key: 'unexamined',
    label: 'what I did not examine',
    match: /did not examine|not examined/i,
    why: "a brief silent on an area reads identically to one that checked it — silent absence (`K-PRIN-8`) on the Maintainer's only gate",
  },
];

/**
 * A STATED POSITION, not a heading with a hole under it.
 *
 * Calibrated against the corpus rather than picked: the SHORTEST section across all 65
 * in the five briefs is `284.md`'s AWS cost at 924 characters, so 200 leaves a 4.6x
 * margin and cannot flag real prose. What it does catch is the thing RA-949 predicts —
 * `Observability: N/A` under a heading, which is 20.
 */
export const MIN_SECTION_CHARS = 200;

/**
 * A dollar figure, or an explicit no-delta DECLARATION. Read across the section's
 * heading AND its body, which is where the first version of this was wrong.
 *
 * WIDENED BY A FALSE POSITIVE, measured rather than imagined. PR RA-1656's brief opens
 * `## 6. AWS cost — **no delta**` over 700 characters costing out Aurora wakes, DDL,
 * storage and Stripe Tax call volume — manifestly considered — and the body happens to
 * carry no `$`. The body-only read rejected it, which would have red-lit `main` for
 * whichever of the two PRs merged second, and, worse, would have demanded a ritual
 * token from a section that had done the work. That is the compliance theater RA-949
 * names as this standard's own standing risk, arriving through the guard meant to serve
 * it. `no delta` is not a novel spelling either: `284.md:519` heads its section the same
 * way, and the rule §5.7 documents was always "a figure **or** an explicit no-delta
 * statement".
 *
 * It stays falsifiable because every alternative is a specific declarative phrase, not a
 * vocabulary: a section that priced nothing and said nothing still fails, which is
 * mutation-checked. What the guard asserts is that the decision was STATED — whether it
 * is true is a reader's job, as the header says of every other check here.
 *
 * `no AWS cost` / `no new AWS spend` stay accepted so a brief written to the old wording
 * still passes (kanon#142), but the finding no longer suggests them: `K-PROJ-6` names
 * "no delta", which says the same thing on any cloud.
 */
const COST_FIGURE = /\$\s?\d|\bno (?:new )?AWS (?:cost|spend)\b|\bno delta\b/i;

/**
 * The observability decision, in the repo's own vocabulary. Two halves: a DECISION word
 * (this project adds a signal, or skips one) and a term from the paging contract, so a
 * section that never mentions what it is deciding about cannot pass by containing the
 * word "add".
 *
 * THE VOCABULARY HALF CARRIES THE WEIGHT, and saying so is the honest description
 * (RA-1658 review). `OBS_DECISION`'s words — add, skip, page, nothing — are common enough
 * English that a 200-character section lacking every one of them is close to
 * unreachable: constructing one for the test took deliberate effort, and `PAD` itself
 * fails because it contains "nothing". So the decision half is a cheap backstop rather
 * than a second gate. It is kept because it costs nothing and does exclude the
 * degenerate case, and `brief-guard.test.ts` pins BOTH halves independently so that
 * widening either one later cannot quietly make the pair unfalsifiable.
 */
export const OBS_DECISION = /\b(?:add|adds|adding|added|skip|skips|skipped|skipping|pages?|paged|none needed|nothing)\b/i;
export const OBS_VOCABULARY = /pagedBusinessEvents|businessEvent|observability\.md|§\s?6\.2|metric[- ]filter|CloudWatch|alarm/i;

/** `## `-level sections, with the body that hangs under each. */
/**
 * AN UNANSWERED DECISION MUST NOT MERGE (RA-1732).
 *
 * MEASURED, NOT INVENTED. `docs/projects/1019.md` merged at 2026-09-07T10:54:06Z carrying
 * `⚠️ PROPOSED — the developer may overrule` on §11 decision 11. FIFTY-ONE SECONDS later
 * the reconciler filed all seven issues. The developer answered two days on — the OPPOSITE
 * of what the brief proposed — and the consequence had to be retro-fitted by hand into two
 * already-filed issues (RA-1695, RA-1696) in PR RA-1721. That amendment then dropped a clause
 * from RA-1696 and left a `:92-95` pointer resolving against the wrong file. So the cost of
 * merging a declared open question is two issue amendments, a mangled clause, a misleading
 * coordinate and a review round.
 *
 * WHY THE GATE IS HERE AND NOT IN THE RECONCILER. Refusing to FILE was the obvious
 * alternative and is worse: the human then learns about it from an hourly tick that did
 * nothing, which is the weakest channel available. This guard runs in `npm run lint`, so
 * the brief's own PR goes red — where a human is already looking.
 *
 * THE VOCABULARY IS THE CORPUS'S, derived with `git log -p --all -- docs/projects/` rather
 * than chosen: `⛔ OPEN` (4 additions), `PROPOSED` (6), `awaits the developer` (2).
 * `TBD`/`UNANSWERED` never appear and are included only as the obvious next spellings.
 *
 * ⚠️ CASE-SENSITIVE, DELIBERATELY, and it is a real gap rather than an oversight. There is
 * no `i` flag, so `Proposed`, `still open` and `tbd` pass silently. That is the right trade
 * — lowercase *"open"* and *"proposed"* are everywhere in brief prose, and a
 * case-insensitive read would flag a headline for the ordinary English word — but it means
 * the marker is a SHOUTED convention, not a vocabulary. `1015.md`'s real open decision was
 * caught only because its author happened to write `⏳ STILL OPEN`. `awaits the developer`
 * is the one lowercase entry and is specific enough to carry no ambiguity.
 *
 * SCOPED TO THE HEADLINE, which is what keeps it falsifiable in the other direction. A
 * decision's headline is the leading bold span — `N. **…**` — and it MAY WRAP, which is
 * exactly how RA-1019's decision 11 was written. Body prose is excluded, so the corpus's own
 * `It is marked PROPOSED rather than answered:` (1019.md, narrating the mark) and every
 * later `decision 3 was OPEN until 2026-09-06` retrospective stay green. Matching the whole
 * item would flag a brief for describing its own history, which is the compliance theater
 * RA-949 names as this standard's standing risk.
 *
 * ⚠️ THIS IS A MERGE GATE, NOT A COMPLETENESS GUARANTEE, and the difference is not
 * pedantry. RA-1019's decision 11 DID NOT EXIST when the brief was written — review surfaced
 * it three rounds in, and at PR-open time §11 said all ten decisions were answered. This
 * catches a DECLARED open question. It cannot catch an undiscovered one, and describing it
 * otherwise would make the first undeclared gap read as the check failing.
 */
export const OPEN_DECISION = /⛔|\bPROPOSED\b|\bOPEN\b(?!-)|\bTBD\b|\bUNANSWERED\b|awaits the developer/;

/**
 * An explicit answered mark, which WINS over an open marker in the same headline.
 *
 * The precedence is not cosmetic and it was found by a false positive rather than
 * predicted: a decision may legitimately narrate its own history in its headline —
 * `**Decision 3 was OPEN until 2026-09-06 and is now answered. ✅**` — and the open-marker
 * read alone flags it. Since a brief that records how a decision moved is doing exactly
 * what §11 is for (see `1019.md` decision 3, *"this went against my recommendation"*),
 * flagging it would punish the behaviour the standard wants.
 *
 * ⚠️ THE COST OF THIS PRECEDENCE, stated because it is a real hole rather than a
 * theoretical one: a HALF-answered decision — `✅ for the wizard, ⛔ OPEN for the backfill`
 * — reads as answered and passes. That is accepted deliberately. A decision with two
 * answers is two decisions, and the alternative precedence (open wins) would re-introduce
 * the false positive above, which is the failure mode that gets a guard switched off.
 */
export const ANSWERED_DECISION = /✅|\bANSWERED\b/;

/**
 * The two arrangements a decision item is written in, both of which occur on the corpus.
 *
 * `N. **Headline.**` — number OUTSIDE the bold run — is what five of the six briefs use.
 * `**N. Headline.**` — number INSIDE it — is what `961.md` uses for ALL SIX of its
 * decisions, and an earlier version of this recogniser required the first form and
 * therefore saw **zero** of them.
 *
 * THAT WAS A 1-IN-6 MISS RATE ON THE GUARD'S OWN UNIT OF WORK, and it is worth naming how
 * it survived: this file falsifies its *vocabulary* against the corpus (`⛔ OPEN` ×4,
 * `PROPOSED` ×6) and its *terminator* against the corpus (the 427- and 259-character
 * over-runs), but the ITEM RECOGNISER was never run against it the same way. A parser
 * nobody counts is a parser that agrees with itself.
 *
 * The miss was also invisible to the corpus regression test, because that test asserts
 * `briefs.length > 0` corpus-wide rather than per file — so a brief parsing to zero items
 * contributed zero assertions and passed green. A per-section count exists so that cannot
 * recur, taken with a DIFFERENT regex than this one.
 *
 * ⚠️ BOTH ALTERNATIVES STILL REQUIRE THE BOLD, and the first attempt at widening did not.
 * Making the leading `**` optional is what reads `**N. …**`; relaxing the TRAILING `\*\*`
 * to `\*{0,2}` as well made every line starting `N. ` at column zero a candidate, and the
 * non-greedy capture then ran across up to six lines to the next unrelated `**`. A fenced
 * code block or an un-indented options list inside a decisions section — `1. hourly`,
 * `2. 15-min — TBD` — produced phantom decisions carrying whatever markers the prose held,
 * and failed an otherwise fully-answered brief. Two anchored alternatives, not one relaxed
 * pattern: `**N. ` or `N. **`.
 */
export const DECISION_ITEM = /^(?:\*\*\d+[.)]\s|\d+[.)]\s+\*\*)/;
const DECISION_ITEM_FULL = /^(?:\*\*(\d+)[.)]\s+|(\d+)[.)]\s+\*\*)([\s\S]*?)\*\*/;

/**
 * The decisions in a section body, as `{ n, headline, line }`.
 *
 * `headline` is the LEADING BOLD SPAN ONLY — the text between `N. **` and the first
 * closing `**` — and nothing after it. That exclusion is the whole design: the markers are
 * matched against this string, so anything it over-captures becomes a false positive on a
 * brief that merely *narrates* a decision, which is the failure mode that gets a guard
 * switched off.
 *
 * IT SPANS LINE BREAKS, because RA-1019's decision 11 wrapped and its `PROPOSED` sat on the
 * second line. Bounded to a 6-line window so an unterminated `**` cannot swallow the
 * section.
 *
 * ⚠️ THE FIRST VERSION OF THIS TERMINATED ON `/\*\*\s*$|\*\*[^*]*$/` AND WAS WRONG IN
 * BOTH DIRECTIONS, falsified against this repo's own briefs rather than reasoned about:
 *
 * - It kept same-line prose after the closing `**`, because `\*\*[^*]*$` matches the `**`
 *   *and its tail*. Every decision in `1015.md` has that shape.
 * - One stray `*` in that tail — an italic span, a bullet, a glob — defeated `[^*]*$`
 *   entirely and appended up to 5 more lines of body. Measured on the corpus this change
 *   ships: `1291.md` decision 4 captured **259** characters and `1015.md` decision 7
 *   **427**, against bold spans a fraction of that. Both passed only because the swallowed
 *   prose happened to carry no uppercase marker, and `1291.md` d4 carries no `✅`, so it had
 *   no protection at all.
 *
 * The non-greedy `([\s\S]*?)` capture ends at the FIRST `**` and keeps only what is inside
 * it, which is what all three of the docstring, §5.7 and the PR body already claimed.
 */
export const decisionsIn = (body) => {
  const out = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!DECISION_ITEM.test(lines[i])) continue;
    const window = lines.slice(i, Math.min(i + 6, lines.length)).join('\n');
    const m = DECISION_ITEM_FULL.exec(window);
    // An unterminated `**` inside the window yields no match: the item is skipped rather
    // than guessed at, and a decision nobody can parse is a shape the author will see.
    if (!m) continue;
    out.push({ n: Number(m[1] ?? m[2]), headline: m[3].replace(/\s+/g, ' ').trim(), line: i });
  }
  return out;
};

export const briefSections = (markdown) => {
  const heads = [...markdown.matchAll(/^##\s+(.*)$/gm)];
  return heads.map((h, i) => ({
    title: h[1].trim(),
    line: markdown.slice(0, h.index).split('\n').length,
    body: markdown.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined),
  }));
};

/**
 * A brief file is named for its TRACKING ISSUE NUMBER, and that is load-bearing rather
 * than tidy, and every consumer says so in its own code: `lead-reconcile.mjs` resolves
 * `docs/projects/${project}.md`, `project-digest.mjs` filters `/^\d+\.md$/`, and
 * `agent-lead-reconcile.yml` classifies `ls docs/projects/*.md` into numeric and
 * non-numeric, warning about the latter because a slug-named brief can never be
 * reconciled. (Cited by content rather than by line for the reason the header gives:
 * all three moved under RA-1671 and RA-1659 while this branch was open.)
 *
 * So a `_`-prefixed file in that directory is NOT a brief — it is apparatus, and
 * `_template.md` is the one that exists. Checking it here would demand a placeholder
 * carry 200 characters of real prose per section and a decomposition that parses; the
 * template is held to exactly that standard instead by `tests/library/brief-guard.test.ts`,
 * which runs this guard's own `checkBrief` against it. That is the stronger shape: the
 * template is proof the standard is satisfiable, checked by the checker.
 */
export const isBrief = (path) => /^docs\/projects\/\d+\.md$/.test(path);

/**
 * BRIEFS WRITTEN UNDER THE OLD STANDARD, AND WHY THEY ARE EXEMPT (RA-1742).
 *
 * Rule 1 of the brief contract — no `file:line` coordinate in a brief — and rule 3 — a
 * brief is IMMUTABLE after approval — conflict for a brief approved before the standard
 * existed. Stripping its coordinates would be editing an approved brief, and the reference
 * adopter's 20 commits doing that once (four of them purely to keep lint green over one
 * brief) are why the exemption exists.
 *
 * IMMUTABILITY WINS, and the reason is the same one RA-1445 gave: a brief's coordinates
 * are EVIDENCE about a commit that has passed. Re-deriving them against a later tree
 * does not correct the record, it falsifies it — a deletion project's brief cites the
 * code the project deleted, and there is no honest coordinate for that. So these briefs
 * stay byte-identical and are exempt from the content rules below. They still carry
 * every required section, and the shape checks still run over them.
 *
 * WHICH BRIEFS IS THE ADOPTER'S TO SAY (kanon#54), under `## Pre-standard briefs` in
 * `docs/qa/exemptions.md` (`K-LAYOUT-15`). Until #54 the reference adopter's six were a
 * constant here, which meant nothing on any other repository. The list is still closed in
 * practice: the file is directly inside `docs/qa/`, so a pull request that adds a brief to
 * it escalates to a human (`K-MERGE-4`), and a brief written from today satisfies the
 * standard or doesn't merge. A listed brief that no longer exists is a stale entry, and
 * `main` fails on it.
 */

/**
 * Is this brief exempt from the content rules? Reads the exemptions file from the working
 * tree, and throws `DeclarationError`, naming the file, when it is missing or malformed.
 * @param {string} path a brief path, as `isBrief` spells it.
 */
export const isPreStandard = (path) => readExemptions().briefs.some((b) => b.brief === path);

/**
 * A coordinate a brief may not carry.
 *
 * THE DEFINITION IS `citation-guard`'s, IMPORTED (`coordinatesIn`), not retyped — it
 * already knows the extension set, the `a-b` range form and the continuation shorthand
 * where a bare `` `:NNN` `` inherits the file named earlier on the line. A second opinion
 * about what a coordinate IS is exactly the drift AGENTS.md warns about.
 *
 * BUT IN `bareNeedsFile` MODE, AND THAT DIFFERENCE IS THE WHOLE POINT (RA-1744 review).
 * `citation-guard` DROPS a bare `` `:NNN` `` whose file was named on an earlier line,
 * and it is right to: it RESOLVES coordinates, so a continuation it cannot attribute to
 * a file is one it cannot check, and reporting it would be the guard crying about
 * correct prose. This guard is not resolving anything — it is banning the FORM — so
 * resolvability is not the question it asks, and the default mode would have missed the
 * commonest shape in the corpus that produced the rule. Measured over the six briefs:
 * 387 coordinates carry a same-line file, and **126 more are bare continuations** whose
 * antecedent is a line or two above, in wrapped prose. A ~300-line brief IS wrapped
 * prose; leaving them out would take the checking on that shape to zero, since
 * `citation-guard` no longer reads the tree at all.
 *
 * MEASURED FOR FALSE POSITIVES BEFORE ADOPTING, because a stricter recogniser that
 * fires on legitimate prose is one people learn to override. Across all six briefs and
 * the template the strict mode adds 126 tokens and every one is a code coordinate. The
 * one non-coordinate form that actually occurs is the clock reference `` `:00` `` (twice
 * in the corpus, plus `docs/observability.md`), and it is already immune — `coordinatesIn`
 * discards `a < 1` because files are 1-indexed. A `` `:15` `` past the hour would fire;
 * the corpus's only `` `:15` `` is a real line number, and the answer for prose that
 * needs one is to drop the backticks, which the failure message says.
 *
 * PLUS THE ONE EXTENSION IT DOES NOT RESOLVE. `citation-guard` checks claims about
 * CODE, so `.md` is absent from its list — but `docs/observability.md:123` in a brief
 * rots identically, and the measurement that produced RA-1742 counted it. A coordinate
 * into a document is banned here for the same reason as one into a source file.
 */
const MD_COORDINATE = /`[\w./-]+\.mdx?:\d+(?:-\d+)?`/g;

/**
 * The acceptance criteria a brief's issue takes on, as bullets under its
 * `Acceptance criteria` line.
 *
 * The region ends where the list does: blank lines and indented continuations stay in,
 * and the first line that resumes prose at column zero ends it — which is how the
 * template's own `Not in this issue:` paragraph sits below a criteria list without
 * being read as one.
 *
 * @returns {string[] | null} the top-level bullets, or `null` if the issue names no
 *   acceptance-criteria region at all.
 */
export const acBullets = (body) => {
  const lines = (body ?? '').split('\n');
  const start = lines.findIndex((l) => /acceptance criteri(?:a|on)/i.test(l));
  if (start === -1) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (/^\s{0,3}(?:[-*+]|\d+[.)])\s+/.test(line)) { out.push(line); continue; }
    if (/^\s/.test(line)) continue;
    break;
  }
  return out;
};

/**
 * A measurement item's bullets (`K-PROJ-16`, `K-LAYOUT-12`): the top-level bullets that
 * open with `**Measures:**`. An item whose deliverable is a number carries these instead
 * of acceptance criteria, because a number is not behaviour and has no spec clause.
 *
 * @returns {{line: string, wellFormed: boolean}[]} each one, and whether it names a
 *   quantity and, after a dash, the command that measures it in backticks.
 */
export const measureBullets = (body) =>
  (body ?? '')
    .split('\n')
    .filter((l) => /^\s{0,3}[-*+]\s+\*\*Measures:\*\*/.test(l))
    .map((line) => ({ line, wellFormed: /^\s{0,3}[-*+]\s+\*\*Measures:\*\*\s+\S.*?\s[—–-]+\s+`[^`]+`/.test(line) }));

// ── Consistency checks a re-scope can break (RA-2147, RA-2153, RA-1748) ─────────────
//
// All three are pure and exported so each can be tested in isolation, and all three run
// ONLY on briefs that aren't pre-standard (`isPreStandard`) — those are immutable records
// (RA-1742), and measured over the reference adopter's six the candidates DO fire: demanding an
// edit to an approved brief to keep lint green is the post-approval churn RA-1742 ended.

/**
 * The leading ordinals of an issue's criteria, and the first place they stop being
 * `1..n` (RA-2147). CommonMark takes an `<ol>`'s start from its FIRST item and ignores
 * every later number, so a list written `1, 2, 3, 5` RENDERS as 1…4 and every "criterion
 * 5" reference is off by one against what a reader sees. Bullets that are not numbered
 * (the standard `- [PREFIX-N]` form) have no ordinal and are not judged.
 *
 * @returns {{expected: number, found: number} | null}
 */
export const criteriaOrdinalGap = (body) => {
  const nums = (acBullets(body) ?? [])
    .map((b) => /^\s{0,3}(\d+)[.)]\s/.exec(b))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) return { expected: i + 1, found: nums[i] };
  }
  return null;
};

/**
 * `Issue X criterion N` references that resolve to nothing (RA-2147) — X is not a declared
 * issue, or X has fewer than N criteria. SINGULAR ONLY, deliberately: the plural forms
 * ("criteria 3 and 4 moved to…", "old criteria 5–9 renumber to 6–10") are narration of a
 * renumbering, measured in `1019.md`, and reading them would make the check noise.
 *
 * What this cannot catch, and says so: a reference RE-POINTED at a different criterion
 * that still exists (RA-2147's second instance). Existence is checkable; meaning is not.
 *
 * @param {string} markdown
 * @param {{key: string, body?: string}[]} proposed
 * @returns {{ref: string, why: string}[]}
 */
export const danglingCriterionRefs = (markdown, proposed) => {
  const counts = new Map(proposed.map((p) => [p.key, (acBullets(p.body) ?? []).length]));
  const out = [];
  for (const m of markdown.matchAll(/\bIssue ([A-Z][A-Z0-9]*)(?:'s|’s)? criterion (\d+)\b/g)) {
    const [ref, key, n] = [m[0], m[1], Number(m[2])];
    if (!counts.has(key)) out.push({ ref, why: `this decomposition declares no Issue ${key}` });
    // An issue whose criteria this reader cannot count (0) is not judged on N: measured on
    // `284.md` and `1291.md`, whose criteria are not a list, that would be a false positive.
    else if (counts.get(key) > 0 && (n < 1 || n > counts.get(key))) out.push({ ref, why: `Issue ${key} has ${counts.get(key)} criteria` });
  }
  return out;
};

/**
 * Blocking predecessors an issue's PROSE asserts and its `**Depends on:**` line omits
 * (RA-2153). `lead-reconcile` builds the dispatch graph from that one line and nothing
 * else — "the hold is the only thing standing between an issue and a dispatch" — so an
 * edge that lives only in prose is a dispatch against a tree that cannot compile.
 *
 * A DELIBERATELY SHORT PHRASE LIST, because a brief discusses other issues constantly and
 * a guard that fires on "Issue G is blocked on data this repository does not have" (true,
 * and correctly NOT a `Depends on:`) gets switched off. Each phrase names an ISSUE as the
 * thing that must land first:
 *
 *   "if/until/unless X has not landed" · "X must land first" · "after/once X lands"
 *   "blocked on/by X" · "requires X to have landed" · "cannot start until/before X"
 *   and the reverse, from the predecessor's side: "X follows this issue".
 *
 * X is `Issue <KEY>`, or a bare declared key of two or more characters (`C1B`, as
 * `1019.md` writes it) — a bare single letter is too common a word to trust.
 *
 * @param {{key: string, body?: string, dependsOnKeys?: string[]}[]} proposed
 * @returns {{from: string, needs: string, phrase: string}[]}  `from` must depend on `needs`
 */
export const omittedPredecessors = (proposed) => {
  const keys = new Set(proposed.map((p) => p.key));
  const long = [...keys].filter((k) => k.length >= 2).map((k) => k.replace(/[^A-Z0-9]/g, ''));
  const ref = `(?:Issue ([A-Z][A-Z0-9]*)${long.length ? `|\\b(${long.join('|')})` : ''})\\b`;
  const forward = [
    `\\b(?:if|until|unless) ${ref} (?:has|have) not (?:yet )?(?:landed|merged|shipped)`,
    `${ref} must (?:land|merge|ship) first`,
    `\\b(?:after|once) ${ref} (?:lands|has landed|merges|has merged|ships)`,
    `\\bblocked (?:on|by) ${ref}`,
    `\\brequires ${ref} to have (?:landed|merged)`,
    `\\bcannot start (?:until|before) ${ref}`,
  ].map((src) => new RegExp(src, 'gi'));
  const reverse = new RegExp(`${ref} follows this issue`, 'gi');
  const deps = new Map(proposed.map((p) => [p.key, new Set(p.dependsOnKeys ?? [])]));
  const out = [];
  const need = (from, needs, phrase) => {
    if (!keys.has(needs) || needs === from || deps.get(from)?.has(needs)) return;
    if (out.some((o) => o.from === from && o.needs === needs)) return;
    out.push({ from, needs, phrase });
  };
  for (const p of proposed) {
    const text = (p.body ?? '').replace(/\s+/g, ' ');
    for (const re of forward) {
      for (const m of text.matchAll(re)) need(p.key, (m[1] ?? m[2]).toUpperCase(), m[0]);
    }
    for (const m of text.matchAll(reverse)) need((m[1] ?? m[2]).toUpperCase(), p.key, m[0]);
  }
  return out;
};

/**
 * A decisions section that parses to ZERO decisions while a human would read numbered
 * items in it (RA-1748). `DECISION_ITEM` recognises two arrangements; a third
 * (`1. __Bold__`, an indented item, `1.**NoSpace**`) contributes nothing and the section
 * used to be reported as checked. The probe is deliberately loose — any numbered line —
 * and is evaluated OUTSIDE fenced blocks, which is what keeps it off the false positive
 * PR RA-1736 fixed. It only fires at ZERO parsed items, so a real decisions list with an
 * options list beside it (the other RA-1736 reproduction) is never flagged.
 *
 * @returns {number} how many numbered lines the probe saw, 0 when there is nothing to say
 */
export const unparsedDecisionLines = (body) => {
  if (decisionsIn(body).length) return 0;
  let fenced = false;
  let n = 0;
  for (const line of body.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && /^\s*(?:\*\*|__)?\d+[.)]/.test(line)) n += 1;
  }
  return n;
};

export const PROJECTS_DIR = 'docs/projects';

/**
 * The corpus, from the index UNION the working directory — and NOT from the index alone.
 *
 * `git ls-files` cannot see a file that has not been `git add`ed, and the brief this
 * guard is most often run over is exactly that one: `agent-lead.yml`'s prompt tells its
 * author to *"run `node scripts/brief-guard.mjs` yourself before you open the PR"*,
 * and at that moment the brief they have just written is untracked. Reading the index
 * alone printed an affirmative sentence about eleven sections over a file with none, and
 * did not even name it in the skip line, because that line is derived from the same list
 * (RA-1663). That is the silent-absence shape (RA-945) this file's own header cites — inside
 * the guard, at the one pre-check the prompt mandates.
 *
 * The union costs a widened remit: a scratch draft left under `docs/projects/` now fails
 * lint rather than being invisible. That is the intended direction. Nothing under
 * `docs/projects/` is `.gitignore`d, so no file is deliberately out of the corpus today,
 * and a guard that examines a file it can read is the whole point.
 *
 * `untracked` is REPORTED rather than assumed, for the same reason `skipped` is: the
 * examined set has to be legible, not just correct.
 */
export const briefCorpus = (tracked, present) => {
  const files = [...new Set([...tracked, ...present])].sort();
  const briefs = files.filter(isBrief);
  return {
    briefs,
    skipped: files.filter((f) => f.endsWith('.md') && !isBrief(f)),
    untracked: briefs.filter((f) => !tracked.includes(f)),
  };
};

/**
 * @param {string} path
 * @param {string} markdown
 * @param {{ milestones?: () => Milestone[] }} [world] the repository's milestones, read only
 *   when an item names something other than a bucket. Absent, such a name is a finding.
 * @returns {{at: string, problem: string}[]}
 */
export function checkBrief(path, markdown, { milestones = () => { throw new Error('no milestone list was read'); } } = {}) {
  const findings = [];
  const at = (line) => `${path}${line ? `:${line}` : ''}`;
  const sections = briefSections(markdown);

  for (const req of REQUIRED_SECTIONS) {
    const matching = sections.filter((s) => req.match.test(s.title));
    if (!matching.length) {
      findings.push({ at: at(0), problem: `no **${req.label}** section — ${req.why}` });
      continue;
    }
    // COMBINED HEADINGS COUNT AS ONE STATEMENT. `## 9. Reconciliation state, and blast
    // radius` satisfies two entries, and its body answers both — so the length is
    // judged on the pooled body rather than demanding 200 characters twice from a
    // section that legitimately exists once.
    const stated = matching.reduce((n, s) => n + s.body.trim().length, 0);
    if (stated < MIN_SECTION_CHARS) {
      findings.push({
        at: at(matching[0].line),
        problem:
          `**${req.label}** states ${stated} characters — an empty heading reads exactly ` +
          `like a section with nothing to say (RA-946). Say the thing, even if the thing is "none, because…"`,
      });
      continue;
    }
    // TITLE AND BODY. An author who puts the verdict in the heading has stated it —
    // `## 6. AWS cost — **no delta**` — and a heading is part of its section.
    const body = matching.map((s) => `${s.title}\n${s.body}`).join('\n');
    if (req.key === 'cost' && !COST_FIGURE.test(body)) {
      findings.push({
        at: at(matching[0].line),
        problem:
          'the **cost** section neither prices the change nor declares that there is ' +
          'nothing to price. State the delta as a figure — `$0` is a figure and the commonest ' +
          'answer — or declare it in the heading or the body as "no delta", and say why. ' +
          'Agreement comes before spend (`K-PROJ-6`, `K-OBS-9`), and a number nobody ' +
          'wrote cannot be agreed to',
      });
    }
    // RA-1732 — AN UNANSWERED DECISION MUST NOT MERGE. Scoped to each decision's HEADLINE
    // rather than its body, so a brief narrating how a decision moved stays green; see
    // `OPEN_DECISION` and `ANSWERED_DECISION` for the corpus this vocabulary came from
    // and for what this check deliberately cannot catch.
    //
    // PRE-STANDARD BRIEFS ARE EXEMPT, and the reason is this check's own definition rather
    // than a concession. It is a MERGE gate: it exists so a question is answered before the
    // brief merges and the reconciler files from it within the minute. A pre-standard
    // brief (`isPreStandard`) merged long ago, so there is nothing left to gate — an open
    // marker in one is a record of what was true then, which is exactly what RA-1742 ruled
    // immutable. Firing here would demand an edit to an approved brief purely to keep lint
    // green, and RA-1742 counted twenty such commits, four of them over `961.md` alone.
    //
    // ⚠️ It does NOT mean the question went away. `1015.md`'s decision 7 flags RA-1001, which
    // is open, in Product Backlog, and tracked there — where a live question belongs. A
    // brief is a dated record; the issue is the thing with a state.
    if (req.key === 'decisions' && !isPreStandard(path)) {
      for (const sec of matching) {
        // ZERO PARSED IS NOT "CHECKED" (RA-1748). See `unparsedDecisionLines`.
        const unparsed = unparsedDecisionLines(sec.body);
        if (unparsed) {
          findings.push({
            at: at(sec.line),
            problem:
              `this decisions section has ${unparsed} numbered line(s) and parses to ZERO decisions, ` +
              'so none of them was checked for an open marker. A decision is `N. **Headline.**` or ' +
              '`**N. Headline.**` at column zero — an indented item, `__underscores__`, or no space ' +
              'after the number is read as prose. (A numbered list inside a ``` fence is ignored.)',
          });
        }
        for (const d of decisionsIn(sec.body)) {
          if (!OPEN_DECISION.test(d.headline) || ANSWERED_DECISION.test(d.headline)) continue;
          const marker = (OPEN_DECISION.exec(d.headline) ?? [''])[0];
          findings.push({
            at: at(sec.line + d.line),
            problem:
              `decision ${d.n} is still open — its headline carries \`${marker}\`. A brief ` +
              'merges once and is filed from within the minute (RA-1019: 51 seconds), so an ' +
              'unanswered question becomes an amendment to issues that already exist. Get ' +
              'the answer and record it, or split the decision so the answered half can ' +
              'proceed. Mark it `✅` once ruled',
          });
        }
      }
    }
    if (req.key === 'observability' && !(OBS_DECISION.test(body) && OBS_VOCABULARY.test(body))) {
      findings.push({
        at: at(matching[0].line),
        problem:
          'the **observability** section does not state an add-or-skip decision in the ' +
          "repo's terms. Name what is decided (a `businessEvent`, a `pagedBusinessEvents` " +
          'clause, a CloudWatch alarm, a `docs/observability.md` §6.2 row) and whether it ' +
          'is added or skipped. Deciding NOT to page is a decision and has a home (RA-1291)',
      });
    }
  }

  // ── What a brief may not CLAIM (RA-1742) ─────────────────────────────────────
  //
  // Both rules are about the same mistake: a brief trying to be falsifiable in its own
  // prose. It cannot be — only a test can — and the attempt is what produced 328
  // coordinates, 20 post-approval edits and three batches of corrective work. The
  // artifact that CAN carry a falsifiable claim already exists one layer up.
  //
  // The pre-standard briefs are exempt and `isPreStandard` says why: their
  // coordinates are evidence about a commit that has passed, and immutability wins.
  if (!isPreStandard(path)) {
    markdown.split('\n').forEach((line, i) => {
      const found = [
        ...coordinatesIn(line, true).map((c) => c.text),
        ...[...line.matchAll(MD_COORDINATE)].map((m) => m[0]),
      ];
      for (const text of found) {
        findings.push({
          at: at(i + 1),
          problem:
            `${text} is a \`file:line\` coordinate, and a brief may not carry one. It is ` +
            'true of one commit and silently wrong of every later one, which is what 328 of ' +
            'these cost in re-derivation and guard machinery (RA-1742). Cite the invariant id ' +
            'that states the behaviour, or the command that re-derives the fact — a name and ' +
            'a command survive the next refactor; a line number does not. (A bare `:NNN` ' +
            'continuing a file named on an earlier line is the same claim and is refused the ' +
            'same way. If you genuinely mean a clock time rather than a line, drop the ' +
            'backticks — `:00` is already exempt, because files are 1-indexed.)',
        });
      }
    });
  }

  // ── The decomposition, read exactly as the reconciler will read it ──────────
  //
  // Not a second parser. Every check below calls `parseProposed`, so what lint accepts
  // and what the tick accepts cannot drift — a guard with its own idea of the format
  // would certify a brief the reconciler then refuses, which is worse than no guard.
  const proposed = parseProposed(markdown);
  if (!proposed.length) {
    // NAME THE ACTUAL CAUSE, because `parseProposed`'s own `reason` is misleading HERE.
    // For a heading like `## 3. Decomposition — the five issues` it says "no
    // Decomposition heading", which is right for its caller and reads as plainly false
    // to an author looking straight at one. This guard knows something the parser does
    // not: `REQUIRED_SECTIONS` matched a title on `/decomposition/i` while the anchored
    // parse found nothing, and the only way both are true is a suffix. That is the one
    // hazard §5.7 singles out, so its message must be the most actionable, not the least.
    const heading = sections.find((sec) => /decomposition/i.test(sec.title));
    const suffixed = heading && /no Decomposition heading/i.test(proposed.reason ?? '');
    findings.push({
      at: at(heading?.line ?? 0),
      problem: suffixed
        ? `“## ${heading.title}” carries a suffix, and the parser anchors this one heading: ` +
          'its regex ends at `Decomposition`, so anything after it reads as NO decomposition ' +
          'at all and the tick files nothing while the project reports healthy. Section ' +
          'numbering is fine; move the summary into the body'
        : `the decomposition does not parse — ${proposed.reason ?? 'no issues found'}. ` +
          'The reconciler files nothing from a brief it cannot read',
    });
    return findings;
  }
  if (proposed.residue?.length) {
    findings.push({
      at: at(0),
      problem:
        `${proposed.residue.length} item(s) in the decomposition are not recognised as issues ` +
        `(${proposed.residue.slice(0, 3).map((r) => `\`${r}\``).join(', ')}). The tick would file ` +
        'a PREFIX of the project and report progress — use `### Issue X — Title`',
    });
  }
  for (const p of proposed) {
    const label = `“${p.title}”`;
    if (!p.milestone) {
      findings.push({ at: at(0), problem: `${label} carries no **Milestone:** — the tick refuses to file, and filing bare lets the backstop route it to ${DEFAULT_MILESTONE}, which reads as correctly triaged` });
    } else {
      const why = milestoneProblem(p.milestone, milestones);
      if (why) findings.push({ at: at(0), problem: `${label} names milestone “${p.milestone}”, which ${why}` });
    }
    if (!p.body || p.body.replace(/[-\s]/g, '') === '') {
      findings.push({ at: at(0), problem: `${label} would be filed with an EMPTY body — its acceptance criteria did not survive the parse, and filing is not undoable` });
    }
    // ACCEPTANCE CRITERIA LIVE IN THE SPEC LAYER, AND THE BRIEF CITES THEM (RA-1742).
    //
    // A criterion restated in prose has two homes and no owner: the spec clause is what
    // a test cites and `verify-acs.mjs` resolves, and a paragraph beside it drifts from
    // the clause with nothing checking either. So a criterion here is an id LEADING its
    // bullet — the same form `verify-acs` reads a commitment from, imported rather than
    // re-expressed, so what lint demands and what phase 5 counts cannot disagree.
    //
    // THIS IS STRICTER THAN §6.2 USED TO BE, deliberately and with the developer's
    // agreement: a deliverable AC ("add a CSV export") was allowed to be plain prose,
    // and that is exactly the criterion nothing can ever verify. It gets a `[seed]`
    // clause too, which costs one allocator run and makes it checkable.
    //
    // A MEASUREMENT ITEM IS THE ONE EXCEPTION (`K-PROJ-16`). Its deliverable is a number and
    // the command that produced it, so it carries `**Measures:**` bullets instead of
    // criteria. It is accepted when it has no criteria region and at least one such
    // bullet, each naming its command; an item with neither ids nor measurements is refused.
    if (!isPreStandard(path)) {
      const bullets = acBullets(p.body);
      const measures = bullets === null ? measureBullets(p.body) : [];
      for (const m of measures.filter((x) => !x.wellFormed)) {
        findings.push({
          at: at(0),
          problem:
            `${label} has a measurement line with no command: \`${m.line.trim().slice(0, 60)}\`. ` +
            'Write it as `- **Measures:** <quantity> — `<command>``, so the number can be re-derived (`K-PROJ-16`)',
        });
      }
      if (bullets === null && measures.length === 0) {
        findings.push({
          at: at(0),
          problem:
            `${label} names no **Acceptance criteria** and no **Measures:** lines — the implementer builds to them and ` +
            '`verify-acs.mjs` closes the project on them, so an issue without any is filed ' +
            'with nothing to satisfy',
        });
      } else if (bullets !== null && !bullets.length) {
        findings.push({
          at: at(0),
          problem: `${label} has an **Acceptance criteria** heading with no criteria under it`,
        });
      }
      for (const b of bullets ?? []) {
        if (isAcDeclaration(b)) continue;
        findings.push({
          at: at(0),
          problem:
            `${label} states an acceptance criterion in prose: \`${b.trim().slice(0, 60)}\`. ` +
            'A criterion is a `[PREFIX-N]` invariant id LEADING its bullet, allocated with ' +
            '`node scripts/spec-ids.mjs --apply` — the brief cites the spec layer, it does ' +
            'not restate it. A restated criterion drifts from the clause a test actually ' +
            'cites, and `verify-acs.mjs` cannot resolve it at all',
        });
      }
    }
    for (const l of p.droppedLabels ?? []) {
      findings.push({ at: at(0), problem: `${label} has a label token that is not a label: \`${l.slice(0, 60)}\`. Keep rationale off the label run, separated by \`·\`` });
    }
    // THE RA-1634 HAZARD, ON THE HALF THAT LIVES IN THE FILE. A `Closes #N` outside the
    // metadata line is not adopted, so the tick files a SECOND issue for tracked work
    // and the original can never be closed — the file phase dedups by title and never
    // re-files (RA-1303). The OTHER half of that rule is about the PR body and cannot be
    // seen from here; `closing-refs.mjs` holds it, and §5.7 states both halves together.
    for (const n of p.droppedCloses ?? []) {
      findings.push({
        at: at(0),
        problem:
          `${label} names \`Closes #${n}\` somewhere the parser does not read it. A closing ` +
          'reference is adopted ONLY from the `**Milestone:** …` metadata line; elsewhere the ' +
          'tick files a duplicate. If the mention is deliberate, separate the word from the number',
      });
    }
  }

  // ── Dependencies that can never be satisfied ────────────────────────────────
  //
  // Both of these are decidable FROM THE BRIEF ALONE, before an issue is filed — and
  // `lead-reconcile.mjs` says so in both its own words: an unresolvable key is "a brief
  // defect, not a wait" and a cycle means "nothing in the cycle can ever be eligible".
  // (By content, like the eight in the header. These two carried `:789` and `:807`
  // through the commit that removed the others, and were 114 lines stale by the time a
  // reviewer measured them — which is the argument, not an exception to it.)
  // Today both surface as a stopped tick after the brief is merged, the
  // issues are filed, and the project has already started; the fix is then an edit to a
  // merged document. Neither needs anything the reviewer of the brief PR did not have.
  const keys = new Set(proposed.map((p) => p.key));
  for (const p of proposed) {
    const dangling = (p.dependsOnKeys ?? []).filter((k) => !keys.has(k));
    for (const k of dangling) {
      findings.push({
        at: at(0),
        problem:
          `“${p.title}” depends on Issue ${k}, which this decomposition does not declare. ` +
          'Every proposed issue gets filed, so a key that names nothing names nothing that ' +
          'will ever exist — the item is held forever rather than dispatched',
      });
    }
  }
  // Reusing the reconciler's own cycle finder rather than writing a second one, keyed on
  // position because it compares issue NUMBERS. Same algorithm, so lint and the tick
  // cannot disagree about what a cycle is.
  const index = new Map([...proposed].map((p, i) => [p.key, i]));
  const cycles = dependencyCycles(
    proposed.map((p, i) => ({
      number: i,
      dependsOn: (p.dependsOnKeys ?? []).map((k) => index.get(k)).filter((n) => n != null),
    })),
  );
  for (const c of cycles) {
    const path = c.map((i) => `Issue ${proposed[i].key}`);
    findings.push({
      at: at(0),
      problem: `dependency cycle — ${path.join(' → ')} → ${path[0]}. Nothing in it can ever become eligible, so the project cannot proceed`,
    });
  }

  // ── What a re-scope breaks (RA-2147, RA-2153) — see the helpers above ─────────────
  if (!isPreStandard(path)) {
    for (const o of omittedPredecessors(proposed)) {
      findings.push({
        at: at(0),
        problem:
          `Issue ${o.from}'s prose says it waits for Issue ${o.needs} (“${o.phrase}”), but its ` +
          `**Depends on:** line does not name Issue ${o.needs}. The reconciler reads ONLY that line, ` +
          'so it would dispatch the issue while every human-readable surface says it must wait. Add ' +
          `Issue ${o.needs} to the line, or reword the prose if it is not a real edge`,
      });
    }
    for (const p of proposed) {
      const gap = criteriaOrdinalGap(p.body);
      if (!gap) continue;
      findings.push({
        at: at(0),
        problem:
          `“${p.title}” numbers its criteria with a gap — criterion ${gap.expected} is written ` +
          `${gap.found}. Markdown renders an ordered list from its FIRST number, so everything after ` +
          'the gap displays one lower than every reference to it. Keep the slot occupied (a ' +
          '"moved to …" placeholder) rather than closing it up or skipping it',
      });
    }
    for (const d of danglingCriterionRefs(markdown, proposed)) {
      findings.push({
        at: at(0),
        problem: `“${d.ref}” points at nothing — ${d.why}. A reader following it lands on a different criterion or none`,
      });
    }
  }
  return findings;
}

const main = () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z', 'docs/projects'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch (e) {
    console.error(`brief-guard: could not read the git index — ${e.message}`);
    process.exitCode = 1;
    return;
  }
  // The directory as well as the index — see `briefCorpus` (RA-1663). A missing directory
  // is not caught here: it falls through to the empty-corpus error below, which is the
  // report a path typo deserves.
  let present = [];
  try {
    present = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => `${PROJECTS_DIR}/${d.name}`);
  } catch {
    present = [];
  }
  const { briefs, skipped, untracked } = briefCorpus(tracked, present);
  // REPORTED, NOT SILENT (RA-945). A guard that quietly stops looking at part of its
  // corpus is indistinguishable from one that looked and found nothing — and the
  // apparatus it skips is exactly where a template would rot unnoticed.
  if (untracked.length) {
    console.log(
      `brief-guard: examining ${untracked.length} brief(s) not yet in the git index ` +
        `(${untracked.join(', ')}) — a brief written and not yet \`git add\`ed is the ` +
        'commonest state this guard is run in.',
    );
  }
  if (skipped.length) {
    console.log(
      `brief-guard: skipping ${skipped.length} non-brief file(s) under docs/projects/ ` +
        `(${skipped.join(', ')}) — a brief is named for its tracking issue number.`,
    );
  }
  if (!briefs.length) {
    // No corpus is not a clean run. It is the shape a path typo takes, and this guard
    // would then print an all-clear forever over a directory it never read.
    console.error('brief-guard: found NO briefs under docs/projects/. That is a broken run, not a clean one.');
    process.exitCode = 1;
    return;
  }

  // READ ONCE, AND ONLY IF ASKED: a corpus that names only buckets never calls `gh`.
  /** @type {{ value?: Milestone[], error?: unknown }} */
  const read = {};
  const milestones = () => {
    if (!('value' in read) && !('error' in read)) {
      try { read.value = liveMilestones(); } catch (e) { read.error = e; }
    }
    if ('error' in read) throw read.error;
    return /** @type {Milestone[]} */ (read.value);
  };
  // THE EXEMPTIONS FILE (kanon#54), read before any brief so a missing or malformed one is
  // reported once, by name, rather than as a throw from inside the first brief's check.
  let exemptions;
  try {
    exemptions = readExemptions();
  } catch (e) {
    console.error(`brief-guard: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  // A STALE ENTRY FAILS. An exemption for a brief that isn't there exempts nothing today and
  // would exempt whatever is written at that path tomorrow.
  const stale = exemptions.briefs.filter((b) => !briefs.includes(b.brief));
  const findings = [
    ...stale.map((b) => ({
      at: `docs/qa/exemptions.md:${b.line}`,
      problem: `\`${b.brief}\` is listed as a pre-standard brief, but there is no such brief. Remove the entry`,
    })),
    ...briefs.flatMap((f) => checkBrief(f, readFileSync(f, 'utf8'), { milestones })),
  ];
  if (findings.length) {
    console.error(`brief-guard: ${findings.length} problem(s) in ${briefs.length} project brief(s):\n`);
    for (const f of findings) console.error(`  ${f.at}\n    ${f.problem}`);
    console.error(
      "\nThe required shape and the reason for each section are in Kanon's rulebook " +
        '(`K-PROJ-4`, `K-LAYOUT-12`, `K-LAYOUT-13`), and `docs/projects/_template.md` is a brief ' +
        'that satisfies all of it. A pre-standard brief is listed in `docs/qa/exemptions.md` (`K-LAYOUT-15`).',
    );
    process.exitCode = 1;
    return;
  }
  // NAMES THE EXEMPT ONES (RA-945). The content rules do not run over the
  // pre-standard briefs, and a count that did not say so would read as though this
  // guard had checked every brief for a coordinate. It has not, and `isPreStandard`
  // holds the reason.
  const exempt = briefs.filter(isPreStandard);
  console.log(
    `brief-guard: ${briefs.length} brief(s) carry all ${REQUIRED_SECTIONS.length} required ` +
      'sections, price their cost delta, state an observability decision, and decompose into ' +
      'issues the reconciler can file.' +
      (exempt.length
        ? `\n  ${exempt.length} of them predate the RA-1742 standard (${exempt.join(', ')}) and were NOT ` +
          'checked for coordinates, for prose acceptance criteria, or for an unanswered decision '
          + '(RA-1732 — a merge gate cannot gate a brief that already merged) — they are immutable records.'
        : ''),
  );
};

// `try`, because `realpathSync(undefined)` THROWS — importing this module with no
// argv[1] (a REPL, a worker) must not crash on the entry-point guard. Same shape as
// `citation-guard.mjs`, for the same reason.
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
