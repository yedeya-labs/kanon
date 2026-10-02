// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// ONE BRIEF GRAMMAR AND ONE CLOSURE RULE, SHARED (cleanup round 5, following RA-2414).
//
// Two processes answer "what does this project still owe?": the reconciler
// (`lead-reconcile.mjs`), which acts on the answer, and the daily project digest
// (`scripts/project-digest.mjs`), which reports it. They must agree on both
// halves of the question — WHICH items a brief proposes, and WHICH members gate
// closure — or the digest describes a project the tick is not running.
//
// Both used to live in `lead-reconcile.mjs`, whose top level also reads the
// environment and shells out to `gh`, so the digest imported a 4,000-line CLI to get
// four pure functions. Worse, the digest kept a SECOND brief grammar of its own
// (`countProposed`, a whole-file `### Issue X` count) beside the reconciler's
// `parseProposed`, and the two fed the same "N done" line: the count still drove the
// `unfiled` status and the fallback denominator while the parse drove the closure
// join, so one brief could read as two different sizes in one post. There is now
// one parser, and this module is its only home.
//
// Pure: no I/O, no environment, no imports. `lead-reconcile.mjs` imports and
// re-exports everything here, so its callers and tests are unchanged.

// The QA issue is a PROJECT issue — it carries the same membership marker, which is
// what makes findings work with no new machinery. That also means it lands in
// `open`, and without this label the reconcile phase would dispatch a VERIFICATION
// issue to an implementer as though it were work to build.
export const VERIFY = 'qa:verify';

/** The brief-item titles an issue satisfies.
 *
 *  An issue satisfies the item whose title it carries, OR the item that ADOPTED it —
 *  which is what `briefTitle` records, since an adopted issue keeps the title its own
 *  author wrote and by construction never carries the brief's.
 *
 *  ONE definition because there were three copies and I fixed two (RA-1213 review).
 *  Each is `proposed` compared against `all`/`filed` by title, each is false forever
 *  once an item adopts, and each fails somewhere different: `phaseOf` never leaves
 *  `file`, `nothingLeftToFile` never lets `readDeploy` run so the project sits in
 *  `awaiting-release` for good, and `already` re-proposes the adoption every tick.
 *  A shape that recurs three times in one file will recur a fourth. */
export const satisfiedTitles = (issues) =>
  new Set(issues.flatMap((i) => [i.title, i.briefTitle].filter(Boolean)));

/** Is this brief item satisfied by the issues that exist?
 *
 *  ALL of the numbers it names, not any (RA-1213 review). An item may adopt several —
 *  the real brief writes `**Closes RA-897, RA-633 and RA-871**`, three numbers under one
 *  title — and `briefTitle` is stamped on each adopted issue, so a title-set said
 *  "satisfied" the moment the FIRST landed. `phaseOf` then left the file phase, the
 *  adoptions arm was never consulted again, and RA-633 and RA-871 were never adopted,
 *  dispatched, verified or counted. The tick had just promised "the rest next tick".
 *
 *  Reachable two ways, and the second needs no budget: adoptions can exceed the tick
 *  budget, and `execute` catches per action, so adopting one can succeed while another
 *  fails. The second is worse — `hold()` tells the human the next tick "resumes from
 *  wherever the project actually is", which for this action kind was no longer true.
 *
 *  An item naming an issue that cannot be adopted — deleted, transferred, or a PR
 *  number — does NOT deadlock here: the adoption is still proposed, `execute` fails on
 *  it, and `hold()` escalates to a human with the reason. That is the designed exit,
 *  and it is why this can be an all-of rule without reintroducing the silent stall
 *  this PR started out fixing. */
export const itemSatisfied = (item, issues) => {
  const closes = item.closes ?? [];
  if (closes.length) return closes.every((n) => issues.some((i) => i.number === n));
  return satisfiedTitles(issues).has(item.title);
};

/** The issues a brief item actually named — the inverse of `itemSatisfied` (RA-1219).
 *
 *  The retro used `world.all`, which is every MARKER-CARRYING issue. That set always
 *  contains two the brief never proposed: the tracking issue (which is why
 *  `readWorld` strips it back out for `filed`) and the QA issue (which is how
 *  `readWorld` finds it). The retro only renders on `close-project`, downstream of
 *  phase 5, so both are always present — a fixed **+2 on every project**.
 *
 *  Derived from the same join as `missing` rather than by subtracting two known
 *  numbers: an issue belongs to the brief when an item named it, which is the fact
 *  being counted. Subtracting would go wrong the moment a third marker-carrying
 *  issue exists, and would say nothing about why. */
export const briefIssues = (proposed, issues) =>
  issues.filter((i) => inDecomposition(i, proposed));

/** Did a brief item name this issue — by title, by its stamped `briefTitle`, or by an
 *  adopting `**Closes #N**`? The join `readWorld` makes, stated once. */
export const inDecomposition = (i, proposed) =>
  (proposed ?? []).some((p) =>
    (p.closes ?? []).includes(i.number) || p.title === i.title || p.title === i.briefTitle);

// ── MEMBERSHIP IS NOT CLOSURE (RA-1783) ────────────────────────────────────────
//
// A project's membership is every issue carrying its marker, and since RA-1783 that
// includes the review follow-ups and explorer bugs its own PRs produce. Gating phase 4
// on ALL of them would hold a project open forever — reviewing a follow-up's PR files
// further follow-ups — and have this tick dispatch an implementer at every one. RA-1019
// carried six such documentation corrections, all `sev:low`/`sev:medium`.
//
// So there are two sets, and the stakeholder-agreed rule (2026-09-12) draws the line:
//   · EVERY member is REPORTED — the tick report, the digest, `project-progress`, and
//     the retro's "left open at close" section.
//   · CLOSURE gates on the PROJECT'S WORK — the brief's decomposition and phase 5's
//     spec-violation findings, which are failures of the brief's own acceptance
//     criteria — plus any member carrying `sev:high` / `sev:critical`, because a
//     launch-gating regression the project caused must not be closed around.
//   · Everything else is CARRIED OUT: named in the report and the retro, never
//     dispatched by this tick, and routed by its own milestone per AGENTS.md.

/** A phase-5 finding (`agent-verify-acs.yml` files it): one of the brief's own
 *  acceptance criteria failing, so it is the project's work however it is labelled.
 *
 *  THE LABEL ALONE IS NOT ENOUGH (RA-1783 review). The general explorer and the code
 *  audit apply `signal:spec-violation` too, and an explorer bug can now inherit a
 *  project's marker — so the label would make it project work, dispatched and gating,
 *  which is the outcome this change exists to prevent. The second anchor is the one
 *  string `agent-verify-acs.yml`'s prompt mandates in a finding's environment field and
 *  nothing else writes: `(targeted-invariant mode)`. Recovery by a content anchor is
 *  `qaIssueOf`'s precedent, for the same reason. */
export const SPEC_FINDING = 'signal:spec-violation';
export const FINDING_ANCHOR = '(targeted-invariant mode)';
export const isPhase5Finding = (i) =>
  (i.labels ?? []).includes(SPEC_FINDING) && String(i.body ?? '').includes(FINDING_ANCHOR);
/** Severities that hold a project open whatever filed the issue. */
export const GATING_SEVERITIES = ['sev:critical', 'sev:high'];

/** The project's own work — what this tick files and dispatches. */
export const isProjectWork = (i, proposed) =>
  inDecomposition(i, proposed) || isPhase5Finding(i);

/** Does this member hold the project open? The QA issue does, by its own phase. */
export const gatesClosure = (i, proposed) =>
  (i.labels ?? []).includes(VERIFY)
  || isProjectWork(i, proposed)
  || (i.labels ?? []).some((l) => GATING_SEVERITIES.includes(l));

/** The open WORK phase 4 waits on — one definition for `phaseOf` and `readWorld`, which
 *  must agree or phase 4 is never reached (RA-1783 review). The QA issue is excluded: it
 *  is open for as long as the project is unverified. */
export const openGatingWork = (open, proposed) =>
  (open ?? []).filter((i) => !(i.labels ?? []).includes(VERIFY) && gatesClosure(i, proposed));


/** The open members that do NOT gate closure — reported, never waited on. */
export const carriedOut = (world) =>
  (world.open ?? []).filter((i) => !gatesClosure(i, world.proposed));

// THE ONE MACHINE-READABLE CONTRACT A BRIEF MUST MEET, and the only one. RA-949 keeps
// the brief format otherwise free — the template is derived from real briefs, not
// imagined — but a reconciler cannot file what it cannot parse, so this much is
// required. It has THREE copies: this parser, `agent-lead.yml`'s prompt example (what
// the author writes to) and `report()`'s `brief-unparseable` text (what whoever fixes
// a rejected brief reads). They are held in agreement by
// `tests/unit/decomposition-contract.test.ts` (RA-967), which feeds each copy's own
// example through this parser and requires every field the example DECLARES to be one
// the parser READ. Before that they had drifted twice, both times within hours, both
// times caught by eye in review.
//
// ANCHORED TO THE `## Decomposition` SECTION, deliberately — a rationale that outlived
// the format it was first written for. Run over the whole file, an item pattern
// matches anywhere, and a brief also carries a definition of done, an out-of-scope
// list and a blast radius, all of which are naturally item lists. Every one of those
// would become a filed GitHub issue on the first `--apply` tick — including a box
// ticked to mean "already done", filed as new work — and unamendably, because the file
// phase dedups by title and never re-files.
//
// WHAT IT READS IS BELOW AND IS NOT RESTATED HERE (RA-995). A summary above the code is
// a fourth copy with nothing checking it, and this one had gone wrong in all three
// available ways at once: it documented the pre-RA-964 one-liner as the format, it
// asserted there was "deliberately no `dependsOn`" while `dependsOnKeys` parsed one
// and `nextActions` held issues on it, and it never mentioned `labels`, which the
// parser gained and `execute` applies at issue creation.
//
// DERIVED FROM THE FIRST REAL BRIEF (PR RA-964), not invented.
//
// The format this replaces — `- [ ] **Title** — summary — milestone: X` — was
// written from imagination the same afternoon, and the first brief disagreed
// within hours: it parsed ZERO items and the tick would have reported
// `brief-unparseable` on a good 640-line brief. RA-949 says the template is derived
// from a real brief precisely because of this, and it was right on n=1.
//
// What a brief author actually writes, when each issue carries acceptance
// criteria that do not fit on a line:
//
//     ### Issue B — Move the settlement status guard into settleOrderWith
//     **Milestone:** Production Ready · **Labels:** `sev:critical` · **Closes #897**
//     **Depends on:** Issue A (needs the decided from-sets)
//
//     …acceptance criteria, rationale, "not in this issue"…
//
// Three things the invented one-liner got wrong: the unit is a HEADING with a
// body, not a line; milestone and labels are their own metadata line; and
// DEPENDENCIES exist. `dependsOn` was deleted a few hours earlier on the grounds
// that "nothing parses a dependency from a brief" — the first author wrote them
// unprompted, and WIP-1 dispatch order is wrong without them (Issue C runs
// parallel to B; D needs B).
//
// STILL n=1. A second brief may differ again, so this parses the observed shape
// and is LOUD when a decomposition does not match, rather than treating one
// sample as the canonical format.
const ISSUE_RE = /^###\s+Issue\s+([A-Z0-9]+)\s*[—–-]\s*(.+?)\s*$/gm;
const MILESTONE_RE = /^\*\*Milestone:\*\*\s*([^·|\n]+?)\s*(?:·|$)/m;
const DEPENDS_RE = /^\*\*Depends on:\*\*\s*(.+?)$/m;
/** A line that CONTINUES the metadata field above it, rather than starting the body.
 *
 *  ONE DEFINITION, TWO READERS (RA-1636). The body-extraction loop below uses this to
 *  decide what to swallow after a `**Field:**` line, and `dependsField` uses it to
 *  decide how much of the `**Depends on:**` field there is to read. Those two answers
 *  MUST agree: a line the body loop swallows and the field reader does not see is
 *  content that reaches neither, which is exactly the silent drop RA-1636 is about. Two
 *  copies of this predicate would be free to disagree, so there is one. */
const META_CONTINUATION = /^(\s+\S|[a-z(])/;

/** The WHOLE `**Depends on:**` field — its first line plus every continuation line.
 *
 *  A LINE IS NOT A FIELD (RA-1636). `DEPENDS_RE` is `/…(.+?)$/m` with no `s` flag, so it
 *  read the first PHYSICAL line and stopped. A brief author who wraps the field — which
 *  is what an author does the moment a dependency carries a reason — had the remainder
 *  swallowed by the body loop into `droppedLines`, and `droppedLines` deliberately does
 *  not block (see `nextActions`). So `dependsOnKeys` was silently narrowed and the
 *  dispatch gate acted on the truncation: the issue was released for `agent:implement`
 *  ahead of a dependency the brief declared. Fail-open, in the one field whose whole
 *  purpose is to hold work back.
 *
 *  Measured on the corpus that prompted this: `docs/projects/284.md`'s Issue D wrapped
 *  `**Depends on:** Issue B (…) and Issue C (…)` across three lines and parsed as
 *  `['B']`, with `C` — which the brief states three times must precede it — nowhere.
 *
 *  READ, RATHER THAN BLOCKED, and that is the choice RA-1636 leaves open. Its siblings
 *  (`droppedLabels`, `droppedCloses`) block because the loss is unamendable; a
 *  dependency is not in that class once it can be READ, and reading is strictly better
 *  than stopping a project to ask an author to unwrap a line. Nothing downstream
 *  changes: the leading-run anchor still applies, so prose after the run still cannot
 *  invent a phantom dependency, and a prerequisite the run cannot take still lands in
 *  the report-only `droppedDeps` exactly as it does on an unwrapped line (RA-1331). What
 *  changes is only WHERE the parser stops looking. */
export function dependsField(chunk) {
  const lines = chunk.split('\n');
  const at = lines.findIndex((l) => /^\*\*Depends on:\*\*/.test(l.trim()));
  if (at === -1) return null;
  const parts = [DEPENDS_RE.exec(lines[at])?.[1] ?? ''];
  for (const line of lines.slice(at + 1)) {
    // Stops at exactly what the body loop stops at: a blank line, a new `**Field:**`,
    // or an unindented capitalised sentence. Anything else after this field is this
    // field.
    if (!META_CONTINUATION.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(' ').trim();
}
// An issue the decomposition item ADOPTS rather than proposes (RA-976). The real brief
// writes `**Closes RA-897; supersedes the caller-side guards in PR RA-869**` on the
// metadata line, and nothing read it: the tick filed a SECOND issue for work RA-897
// already tracked, the implementer's PR closed the new one, and RA-897 stayed open
// forever — permanently, because the file phase dedups by title and never re-files.
//
// Only the LEADING run of references, before any prose. `Closes RA-897; supersedes …
// PR RA-869` must yield 897 and not 869: a PR mentioned in the rationale is not an
// issue this item adopts, and adopting it would have the tick dispatch an implementer
// at a pull request.
const CLOSES_RE = /\*\*Closes\s+(#\d+(?:\s*(?:,|and|;)\s*#\d+)*)/i;

// READ FROM THE METADATA LINE, NOT THE WHOLE CHUNK (RA-1300/RA-1310). `CLOSES_RE` has no
// anchor and `exec` returns the FIRST match anywhere, so bold body prose beat the
// metadata line. Measured: brief RA-1291's Issue B opened `**Closes RA-720's successor
// question**` and parsed as adopting RA-720 — an unrelated issue the tick would then
// have filed a `Closes RA-720` into. Its two siblings `MILESTONE_RE` and `DEPENDS_RE`
// are both `^…` anchored; this one was not.
//
// ANCHORED TO THE LINE, NOT TO COLUMN ZERO. The real form is
// `**Milestone:** … · **Labels:** … · **Closes RA-603**`, so `^\*\*Closes` would have
// matched none of the four briefs on disk. The metadata line is identified the way
// `MILESTONE_RE` already identifies it, and `CLOSES_RE` runs against that line alone.
const METADATA_LINE_RE = /^\*\*Milestone:\*\*.*$/m;

// A `Closes #N` the anchored read did NOT adopt (RA-1303). Empty `closes` takes the FILE
// branch in `nextActions`, so an unread marker files a duplicate — and the original can
// then never be closed, because the file phase dedups by title and never re-files. That
// is irreversible, and closing references were the one axis of the metadata block with
// no `dropped*` report, which is what makes the miss silent.
//
// SENTENCE-INITIAL OR BOLD, so a passing mention is not an escalation. `docs/
// projects/1291.md`'s `**This adopts RA-326's gap 4 ONLY and does NOT close RA-326**` line
// is a DELIBERATE non-close —
// and a bare /close\s+#\d+/ would flag it on every tick forever. Requiring the verb to
// open a line, a sentence or a bold span excludes it without a negation list, which
// would be the same after-the-fact maintenance RA-1214 argued against. Measured: zero
// hits across all four briefs on disk.
// MARKDOWN PUNCTUATION IS NOT PROSE (RA-1330). `^` under `/m` anchors at column zero
// only, so the form brief authors most often write — a list item — defeated it:
// `- Closes #N` and `> Closes #N` were neither adopted NOR reported, falling straight
// back into RA-1303's silent duplicate. A numbered `1. Closes #N` matched only
// incidentally, through the sentence lookbehind, so two list markers behaved
// differently on identical content.
//
// The line-start arm now steps over any run of list/blockquote markers and
// indentation, and the sentence arm CONSUMES its whitespace rather than looking behind
// exactly one character, which `Done.  Closes #N` (two spaces) had defeated.
//
// EVERY MARKER COMMONMARK TREATS AS ONE CONSTRUCT (RA-1455). The first version accepted
// `1.` and not `1)`, and `-` and not `- [ ]` — reproducing, one paren over, the exact
// asymmetry RA-1330 was filed on: two markers that render identically on GitHub behaving
// differently on identical content, with nothing to tell an author which form is read.
//
// Measured on all four briefs through `parseProposed` itself, not against the regex in
// isolation: still zero `droppedCloses`, so no live project is parked by the widening.
// The metadata line is removed before this scan, which is why the nine real
// `**Closes #N**` markers do not self-report.
const PROSE_CLOSES_RE = /(?:^[ \t]*(?:(?:[-*+>]|\d+[.)]|\[[ xX]\])[ \t]*)*|(?<=[.!?])\s+|(?<=\*\*))Clos(?:e|es|ing)\s+#(\d+)/gim;

/**
 * @param {string} markdown
 * @param {{knownLabels?: Set<string>}} [opts] the repo's actual labels, when the caller
 *   has them. Given, they are the authority; absent, a shape heuristic stands in.
 */
export function parseProposed(markdown, { knownLabels } = {}) {
  // A NUMBERED heading counts. The Lead numbers every section — `## 3. Decomposition`
  // — because the brief cross-references them (§3, §7, §11 are cited throughout the
  // first real one), and that is better writing, not a deviation to correct. `\s*`
  // matched whitespace and not `3.`, so the reconciler reported "no decomposition"
  // for a brief that had one, filed nothing, and blocked the pilot (RA-1046).
  //
  // The contract was derived from the real brief rather than imagined (RA-949) — but
  // only its ISSUE blocks were. The heading line above them was still the invented
  // shape, and the fixture started below it, so nothing compared the two.
  const section = /^(#{1,4})\s*(?:\d+[.)]\s*)?Decomposition\s*$/im.exec(markdown);
  if (!section) return Object.defineProperties([], { reason: { value: 'no Decomposition heading (`## Decomposition` or `## 3. Decomposition`)' } });

  const level = section[1].length;
  const rest = markdown.slice(section.index + section[0].length);
  // Terminate only at a heading at the SAME OR SHALLOWER level. A flat `#{1,4}`
  // also matched `###`, which is the very level the issues live at — so the
  // section ended at its own first issue.
  const end = new RegExp(`^#{1,${level}}\\s+\\S`, 'm').exec(rest);
  const body = end ? rest.slice(0, end.index) : rest;

  // Split on the issue headings, so each issue's metadata is read from its own
  // body rather than from whatever line happens to come next.
  const heads = [...body.matchAll(ISSUE_RE)];
  // THE KEYS THIS BRIEF ACTUALLY DECLARES, for the dropped-dependency report (RA-1454).
  // Anchoring on declared keys is what keeps `- see the note about the B path` from
  // becoming noise: a bare token is only worth reporting if it names an issue the
  // decomposition contains.
  const declaredKeys = new Set(heads.map((h) => h[1]));
  const out = heads.map((h, i) => {
    const chunk = body.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const ms = MILESTONE_RE.exec(chunk);
    // `**Labels:**` may sit on the milestone line after a `·`, or on its own.
    // Take the REST of the line: `·` is the brief's separator BETWEEN labels as
    // well as between metadata fields, so stopping at the first one dropped every
    // label after the first. Anything following a later `**Bold:**` marker on the
    // same line is a different field and is trimmed below.
    const lb = /\*\*Labels:\*\*\s*([^\n]+)/m.exec(chunk);
    // THE WHOLE FIELD, not its first physical line (RA-1636). See `dependsField`.
    const dep = dependsField(chunk);
    return {
      key: h[1],                                   // "A", "B" — how the brief refers to it
      title: h[2].trim(),
      // THE ISSUE'S WHOLE SECTION, not a one-line summary.
      //
      // Taking "the first non-metadata paragraph" returned the string
      // `Acceptance criteria:` — a colon-terminated section label — on THREE of the
      // four issues in the only real brief that exists, because B, C and D each
      // open with that line followed by a numbered list. Three GitHub issues whose
      // entire body is a label, with the Implementer dispatched onto them.
      //
      // And a summary was the wrong shape regardless: the brief's acceptance
      // criteria ARE the issue's acceptance criteria (§6), so summarising threw
      // away the thing the implementer builds to. The body now carries the
      // section as written, minus the metadata lines the reconciler consumed.
      //
      // Failing silently is what made this dangerous: nothing looks at the body,
      // the tick reports `file` and exits green, and the file phase dedups by
      // title — so once these exist a corrected script never re-files or amends
      // them. A run-once transformation whose output a later PR cannot fix.
      ...(() => {
        // EVERY DISCARD IS RECORDED. Three rounds of this review found defects in
        // heuristics that dropped something silently — a wrapped metadata line, a
        // body sentence, a label token. Each fix narrowed the heuristic and the
        // next round found the new edge it created. The heuristics stay (they are
        // right for the real brief), but nothing they discard disappears: what is
        // dropped is reported, so a wrong guess is LOUD rather than a permanent,
        // unamendable GitHub issue. That is the principle the residue guard
        // already enforces for headings, applied to the other two axes.
        const kept = [];
        const dropped = [];
        let inMeta = false;
        for (const line of chunk.split('\n')) {
          if (/^\*\*(Milestone|Depends on|Labels):/.test(line.trim())) { inMeta = true; continue; }
          // A continuation is an INDENTED or clearly-continuing line, not any
          // non-blank one — skipping everything until a blank line ate the body
          // whenever an author wrote prose directly under the metadata.
          if (inMeta && META_CONTINUATION.test(line)) { dropped.push(line.trim()); continue; }
          inMeta = false;
          kept.push(line);
        }
        return { body: kept.join('\n').trim(), droppedLines: dropped };
      })(),
      ...(() => {
        const tokens = (lb?.[1] ?? '')
          // Stop at the next `**Field:**` on the line — the real brief writes
          // "**Labels:** `sev:critical` · **Closes RA-897; supersedes …**".
          .split(/·\s*\*\*[A-Z]/)[0]
          .split(/[,·]/)
          .map((l) => l.replace(/[`*]/g, '').trim())
          .filter(Boolean);
        // VALIDATED AGAINST THE REPO'S LABELS WHEN THEY ARE KNOWN (RA-1004), and by
        // shape only when they are not.
        //
        // The shape filter alone rejected a REAL label containing a space — this repo
        // has `good first issue` and `help wanted` — and since a dropped label token
        // fails closed, that deadlocked the whole project while reporting that the
        // token is "not a label", which is the opposite of true. A regex cannot decide
        // what is a label; the repo can, and `readWorld` already talks to it.
        //
        // The fallback keeps `parseProposed` a pure function for callers that have no
        // repo (tests, a dry parse). It now allows internal spaces, so the shape and
        // the reality disagree in the safe direction: a real label passes both, and an
        // obvious non-label (`follow-up Closes RA-897`) still fails the length bound and
        // the leading-character rule.
        const shaped = (l) => /^[a-z0-9][a-z0-9:_ -]*$/i.test(l) && l.length <= 40;
        const ok = (l) => (knownLabels ? knownLabels.has(l) : shaped(l));
        // A token that is not label-shaped is prose that drifted in — but dropping
        // it silently turned a LOUD failure into a quiet one. On the previous
        // commit `**Labels:** \`follow-up\` Closes RA-897` produced the single bad
        // label "follow-up Closes RA-897", which `gh issue create` rejects: the issue
        // is not filed and someone looks. The shape filter made that same input
        // file an issue with NO labels and no word said — and `sev:critical` is
        // exactly the signal RA-729/RA-730 exist to retrofit. Reported now.
        return { labels: tokens.filter(ok), droppedLabels: tokens.filter((l) => !ok(l)) };
      })(),
      milestone: ms ? ms[1].replace(/\*+/g, '').trim() : null,
      // The issue(s) this item adopts, if it names any (RA-976), READ ONLY FROM THE
      // METADATA LINE (RA-1300/RA-1310) — plus a report of any `Closes #N` elsewhere in
      // the item that this therefore did not adopt (RA-1303).
      ...(() => {
        const meta = METADATA_LINE_RE.exec(chunk)?.[0] ?? '';
        const m = CLOSES_RE.exec(meta);
        const closes = m ? [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1])) : [];
        const adopted = new Set(closes);
        const seen = new Set();
        for (const p of chunk.replace(meta, '').matchAll(PROSE_CLOSES_RE)) {
          const n = Number(p[1]);
          if (!adopted.has(n)) seen.add(n);
        }
        return { closes, droppedCloses: [...seen] };
      })(),
      // Keys the issue depends on, e.g. "Issue A" -> "A". Resolved to issue
      // numbers in readWorld once those issues exist.
      // Only the LEADING run of issue references, before the prose. The rest of the
      // line is prose and any incidental "Issue F" in it became a permanent
      // dependency on nothing. The real fixture survives only by luck — Issue C's
      // line reads "Runs in parallel with B", not "with Issue B".
      //
      // PARENTHETICALS ARE REMOVED FIRST, NOT TREATED AS THE END OF THE RUN
      // (RA-1300/RA-1310). `Issue A (the schema change) and Issue B` yielded `['A']`,
      // because the `(` terminated the leading run — so a brief could state two
      // dependencies and have one enforced, silently: `droppedLines` counts whole
      // unparsed lines, never content discarded inside a line that parsed.
      //
      // This FAILS OPEN, which is the dangerous direction: `nextActions`' `eligible` filters out an
      // issue with an open dependency, so a dropped one makes an issue look ready and
      // dispatches an implementer at work whose prerequisite has not landed. Not
      // biting on the four briefs on disk only because every parenthetical there
      // follows the SOLE dependency — and `Issue A (the schema change) and Issue B` is
      // exactly what an author reaches for next.
      //
      // Stripping keeps the anti-phantom guarantee intact: prose after the run still
      // cannot invent a dependency, because the run anchor is unchanged.
      // …AND WHAT THE RUN DISCARDED IS REPORTED, NOT GUESSED (RA-1331). The `(…)` strip
      // above fixed one separator; `—` and `;` still truncate, and `1015.md:401`/`:576`/
      // `:717` all write `Issue A — reason`, surviving only because each names ONE
      // dependency. `1291.md`'s parser note opening `**Depends on:** cannot carry a
      // reason per dependency` is an author writing the complaint down verbatim.
      //
      // WIDENING THE SEPARATOR CANNOT HAVE BOTH PROPERTIES, which is why this reports
      // instead. Accept `—` and `Issue A — see the note about Issue F below` yields
      // `['A','F']` — the permanent dependency on nothing that the leading-run anchor
      // exists to prevent, and that this file's own test asserts against. The two
      // properties are in genuine tension, so the parser keeps the safe one and says
      // out loud what it dropped.
      //
      // It FAILS OPEN, which is the dangerous direction: `nextActions` filters out an
      // issue with an open dependency, so a dropped one makes an issue look ready and
      // dispatches an implementer at work whose prerequisite has not landed.
      ...(() => {
        if (!dep) return { dependsOnKeys: [], droppedDeps: [] };
        // Parentheticals are rationale, not references — stripped before BOTH reads so
        // an `Issue F` mentioned inside one is not reported as dropped either.
        const line = dep.replace(/\([^)]*\)/g, ' ');
        const run = /^((?:\s*(?:and|,|&)?\s*Issue\s+[A-Z0-9]+)+)/.exec(line)?.[1] ?? '';
        const taken = [...run.matchAll(/Issue\s+([A-Z0-9]+)/g)].map((m) => m[1]);
        // THE REPORTING READ IS WIDER THAN THE RUN, DELIBERATELY (RA-1454). `all` used
        // the SAME `Issue <KEY>` token as `taken`, so a prerequisite named without
        // repeating the word — `Issue A and B`, `Issue A, B`, or the plural
        // `Issues A and B` — was invisible to both reads and therefore could not
        // appear in the difference. It was taken silently and reported nowhere, which
        // is the fail-open direction this field exists to close.
        //
        // Live, not hypothetical: `1015.md:717` writes `Issue C — which itself depends
        // on B`, parsing to `['C']` with nothing said about B. So RA-1446's "zero across
        // four briefs" measured the detector's blind spot as much as a clean corpus.
        //
        // ONLY the report widens; `taken` keeps the leading-run anchor untouched,
        // because that anchor is the whole defence against a phantom dependency.
        // Restricted to keys the brief DECLARES, so prose naming a letter cannot
        // become noise.
        // TWO READS WITH DIFFERENT SCOPES, UNIONED (RA-1468 review). Replacing the
        // whole-line scan with a first-sentence one fixed the disclaimer false
        // positives and REGRESSED the case it inherited: `Issue A. Issue B must also
        // land first.` reported `B` before this change and nothing after it — the
        // fail-open direction this field exists for, in the same field being widened.
        //
        //   · an EXPLICIT `Issue <KEY>` counts anywhere on the line, as it always has.
        //     The author wrote the word; there is no ambiguity to bound.
        //   · a BARE key counts only in the declaring sentence, because that is the
        //     read this change adds and the one that needs a boundary.
        //
        // THE FIRST SENTENCE, and that boundary is doing real work rather than
        // being a convenience. The declaration lives there; what follows is
        // commentary, and commentary is where authors DISCLAIM dependencies.
        // Measured on the corpus: `961.md:453` writes `Issue A (…). Runs in parallel
        // with B.` and `961.md:564` writes `nothing. Runs at any time, independently
        // of A–D.` — both would otherwise be reported as prerequisites named and not
        // enforced, which is the exact opposite of what they say. `1015.md:717`'s
        // `Issue C — which itself depends on B, so this lands after both` is one
        // sentence and is correctly reported.
        //
        // A phrase list ("in parallel with", "independently of", "not") would be the
        // opt-in, after-the-fact maintenance RA-1214 deleted a file for; a sentence
        // boundary needs nothing remembered.
        //
        // STATED AS NARROWLY AS IT IS MEASURED (RA-1468 review): the boundary defends
        // against a disclaimer in a FOLLOWING sentence, which is the corpus's shape.
        // An in-sentence one still reports — `Issue A — B is NOT required here` gives
        // `['B']`, and so does `the A/B test harness`. That is a noise ceiling on a
        // report-only field whose block tells the reader what to do about an entry,
        // not a fail-open; the ceiling is why this reports rather than stops.
        const declaration = line.split(/(?<=[.!?])\s/)[0];
        const mentioned = [
          ...[...declaration.matchAll(/\b([A-Z0-9]+)\b/g)].map((m) => m[1]),
          ...[...line.matchAll(/Issue\s+([A-Z0-9]+)/g)].map((m) => m[1]),
        ].filter((k) => declaredKeys.has(k));
        return {
          dependsOnKeys: taken,
          droppedDeps: [...new Set(mentioned.filter((k) => !taken.includes(k)))],
        };
      })(),
      order: i,
    };
  });

  // COUNT WHAT WAS LEFT BEHIND. The parser takes only
  // `### Issue X — Title`, so anything written slightly differently is dropped —
  // a heading one level deeper, a colon instead of an em dash, or the previous
  // one-liner contract a brief written against the old prompt still uses. As long
  // as ONE sibling parses, the tick proceeds on a partial list, files a prefix,
  // and reports `complete` on a project with issues that were never filed.
  //
  // That is the exact outcome the terminator fix closed, arriving through a
  // different door — and more likely now, not less, because this format is n=1 and
  // a second brief differing by one heading level is precisely the case.
  //
  // So the guard is derived rather than asserted: any heading inside the section
  // that is NOT an issue we took, and any old-style checkbox item, is residue.
  const takenAt = new Set(heads.map((h) => h.index));
  // Only headings AT THE ISSUE LEVEL count as residue — a heading DEEPER than an
  // issue is ordinary structure inside its body, which the prompt explicitly
  // leaves to the author ("everything else about the format stays yours"). The
  // first version counted any heading, so `#### Acceptance criteria` inside Issue
  // A's body stalled the tick and asked a human to delete legitimate structure
  // from an approved brief. The checked-in fixture escapes only because that
  // author used bold labels and numbered lists — and this format is n=1.
  // Two kinds of residue, and they are distinguished by SHAPE as well as depth:
  //
  //   • a heading at the issue level that we did not take — e.g. `### Issue A: a`,
  //     the wrong separator;
  //   • a heading at ANY depth that names an issue but was not taken — e.g.
  //     `#### Issue B — b`, one level too deep.
  //
  // A DEEPER heading that is not issue-shaped is ordinary structure inside an
  // issue body (`#### Acceptance criteria`), which the prompt explicitly leaves to
  // the author. Counting those stalled the tick and asked a human to delete
  // legitimate structure from an approved brief — depth alone is not the signal.
  const issueLevel = heads.length ? (/^#+/.exec(body.slice(heads[0].index))?.[0].length ?? 3) : 3;
  const looksLikeIssue = /^#{2,6}\s+Issue\s+/;
  const residue = [
    ...[...body.matchAll(/^#{2,6}\s+\S.*$/gm)].filter((h) => {
      if (takenAt.has(h.index)) return false;
      const depth = /^#+/.exec(h[0])[0].length;
      return depth <= issueLevel || looksLikeIssue.test(h[0]);
    }),
    ...[...body.matchAll(/^\s*-\s*\[[ x]\]\s*\*\*.+?\*\*/gm)],
  ].map((m) => m[0].trim().slice(0, 90));

  Object.defineProperty(out, 'reason', {
    value: heads.length ? null : 'a Decomposition section with no `### Issue X — …` headings',
  });
  Object.defineProperty(out, 'residue', { value: residue, enumerable: false });
  Object.defineProperty(out, 'endedAt', {
    value: end ? end[0].trim() : 'end of file', enumerable: false,
  });
  return out;
}
