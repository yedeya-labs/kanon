#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-1013 — check that the issues a PR WILL close match the issues it SAYS it closes.
//
// Nothing compared the pair, and it drifts in three independent directions. All
// three were found by hand on a single day, each by querying the field directly —
// none was visible in the diff, in CI, or in the review.
//
// 1. DECLARED BUT WON'T CLOSE. `Closes RA-1010` inside backticks sat in RA-1008's body
//    while RA-1010 was ABSENT from closingIssuesReferences; unbackticked `RA-1007` on
//    the same line was present. Work that is done stays open, and the body says
//    otherwise.
//
//    NOTE that this is true of `closingIssuesReferences` ONLY. The same span is a
//    live keyword in the merge commit message — see `mergeMessageRefs` below, and
//    RA-1045, which is what reading direction 1 as "backticks make it safe" cost.
//
// 2. WILL CLOSE BUT NOT DECLARED. RA-1008's body said `Refs RA-918` and stated in prose
//    that it does NOT close RA-918 — GitHub still had 918 in the closing set, from a
//    body revision nobody could read any more. Removing the keyword did not remove
//    the link; removing the `RA-918` TOKEN did. GitHub's linker has no notion of
//    negation: "does not close RA-918" links exactly as hard as "closes RA-918".
//
// 3. THE SAME, FROM A FORWARD REFERENCE. The pilot brief RA-964 described a FUTURE
//    issue with the row "Move the guard into settleOrderWith — closes RA-897", and
//    GitHub linked it to the PR that merely PLANS that work. RA-897 is sev:high on
//    Production Ready. The body's own last line said "Closes nothing."
//
// WHY THE DECLARATION ZONE, AND NOT A BODY-WIDE REGEX. Direction 3 is invisible to
// one: the body genuinely said "closes RA-897", so body-text and closing-set AGREED —
// the PR just did not do it. The only mechanical difference between a declaration
// and a forward reference is WHERE it sits. So closing keywords are honoured in a
// declaration zone at the top of the body, and one below it is reported as a
// probable forward reference. That is a convention this repo already follows:
// bodies here open with `Closes RA-1007 · Refs RA-918 · Unblocks RA-964`.
//
// COMMIT MESSAGES ARE NOT A DECLARATION. This repo squash-merges with the PR title
// plus the PR BODY; branch commit messages are discarded. Measured over 13 merges:
// every one is a single-parent commit containing the body, and RA-1008's
// `Closes RA-1011` / `Closes RA-1012` appear ZERO times in its merge commit. So a
// closing keyword in a commit is reported — it reads as done and does nothing.

import { execFileSync } from 'node:child_process';
import { isCliEntry } from './lib/cli-entry.mjs';

/** GitHub's own closing-keyword set. Case-insensitive, keyword BEFORE the ref. */
const KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
/**
 * The four REF spellings GitHub's linker acts on, longest first so `owner/repo#N` and
 * the issue URL cannot be eaten by the bare `#N` branch.
 *
 * Only `#N` was modelled until RA-1055, and the miss is the same shape as RA-1029 from a
 * different spelling: a body carrying `closes owner/repo#897` passed GREEN and closed
 * RA-897 at merge, with both oracles silent. It got sharper after RA-1672 rather than
 * milder — a stacked PR gets an empty `closingIssuesReferences`, which quiets the three
 * link-based arms and leaves `mergeClosesUndeclared` as the only one still firing, and
 * that arm runs on this regex alone. So on a stacked PR these three spellings had ZERO
 * coverage.
 *
 * And on a NON-stacked PR the old regex was confidently wrong in the other direction:
 * `Closes owner/repo#897` in the declaration zone is a declaration GitHub honours, but
 * produced `declared: []` and a red run whose explanation blamed a missing keyword that
 * was sitting in line 1 — the exact failure `explain`'s own docstring says is worse than
 * silence.
 *
 * WIDENING COSTS NOTHING HERE, measured rather than argued. This repo squash-merges
 * title + body, so every commit on `main` IS a merge-commit message — the population
 * this regex is evaluated against. Over all 1093 commits on `origin/main` the broadened
 * alternation finds ZERO matches the old one did not, so no PR that passes today is
 * newly blocked. (Bare issue URLs appear in ~10 commit messages but never adjacent to a
 * closing keyword.) What is NOT measured, and should not be claimed as such: that
 * GitHub's push-time linker really acts on each spelling in a squash message. That rests
 * on GitHub's documented keyword table — the repo has no historical instance to observe.
 *
 * Groups 1/3 capture the qualified `owner/repo` so a ref to ANOTHER repository is
 * discarded rather than reported as a local issue number.
 */
const REF = '(?:https?://github\\.com/([\\w.-]+/[\\w.-]+)/issues/(\\d+)|([\\w.-]+/[\\w.-]+)#(\\d+)|GH-(\\d+)|#(\\d+))';
const CLOSING_RE = new RegExp(`\\b${KEYWORD}\\b\\s*:?\\s+${REF}`, 'gi');

/**
 * How much of the body counts as the declaration.
 *
 * The first paragraph — everything up to the first blank line. Deliberately small:
 * a declaration is a header, and anything that needs prose around it is a
 * discussion of an issue rather than a claim to close it.
 */
/** @param {string} [body] */
export const declarationZone = (body) => {
  // Skip LEADING BLOCKQUOTE paragraphs before taking the first real one. The Implementer's
  // PR template opens with a `> **Agent-authored PR** …` banner, so "the first
  // paragraph" is boilerplate and the `Closes #N` lines are the second. Measured:
  // without this, RA-830 and RA-833 both flag — and agent PRs are the majority here,
  // so the rule would have false-blocked the class it most needs to hold.
  const paras = (body ?? '').split(/\r?\n\s*\r?\n/);
  return paras.find((p) => p.trim() && !/^\s*>/.test(p)) ?? '';
};

/** Every `<keyword> <ref>` in a string, as numbers, deduped. Backticks are NOT stripped:
 *  a backticked keyword is exactly what GitHub does not see, and finding 1 is that
 *  gap — so it must be visible here to be reportable.
 *  @param {string} [text]
 *  @param {string} [repo] `owner/name`. A ref qualified with any OTHER repository is
 *    dropped — this check only answers for issue numbers here, and reporting a foreign
 *    #N as a local one would be a confident wrong answer. Omitted, nothing is dropped,
 *    which keeps every caller that has no repo in hand behaving as before. */
export const closingRefs = (text, repo) => [
  ...new Set(
    [...(text ?? '').matchAll(CLOSING_RE)]
      .filter((m) => {
        const owner = m[1] ?? m[3];
        return !owner || !repo || owner.toLowerCase() === repo.toLowerCase();
      })
      .map((m) => Number(m[2] ?? m[4] ?? m[5] ?? m[6])),
  ),
];

/** Fenced code and inline code, blanked out — a `Closes #N` shown as an EXAMPLE
 *  (this file's own header, a doc, a review quote) is not a claim. */
/** @param {string} [text] */
export const stripCode = (text) =>
  (text ?? '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

/**
 * What the SQUASH COMMIT MESSAGE will close, which is a different question from
 * what `closingIssuesReferences` says — and the one that did the damage.
 *
 * This repo squash-merges with the PR title plus the PR BODY as the commit message,
 * and a commit message on the default branch is parsed as PLAIN TEXT. Two
 * consequences that `closingIssuesReferences` cannot see:
 *
 *   1. BACKTICKS ARE NOT SYNTAX THERE. `` `closes RA-918` `` is a code span to the
 *      body parser and a live keyword to the commit parser. That is exactly how
 *      PR RA-1029 closed RA-918 and RA-897 — from a line written to EXPLAIN this bug —
 *      while its `closingIssuesReferences` read `[1013]`, stable across polls.
 *
 *      The safe shape is to backtick the REF, not the phrase: ``closes `RA-897` ``
 *      breaks the adjacency in both parsers, which is why the brief format's
 *      forward references have never fired. Backticking the whole phrase leaves
 *      `closes RA-918` contiguous inside the span and only hides it from one.
 *
 *   2. NEWLINES ARE WHITESPACE. The body is hard-wrapped into the message, so a
 *      keyword can end one line and its `#N` begin the next. `closes\n#897` is a
 *      live keyword and invisible to any line-based scan — it is what a
 *      `grep`-per-line audit of the same commit missed.
 *
 *      No normalisation is needed for this: `CLOSING_RE`'s `\s+` already spans a
 *      newline. An earlier version collapsed whitespace first, which was dead code
 *      that read as load-bearing — mutation-verified by deleting it and watching
 *      the suite stay green. The hazard is the LINE-BASED tooling around it, not
 *      the regex.
 */
export const mergeMessageRefs = (title, body, repo) =>
  closingRefs(`${title ?? ''}\n${body ?? ''}`, repo);

/**
 * @param {{ body?: string, title?: string, willClose: number[], commitMessages?: string[],
 *           repo?: string, issuesReadable?: boolean, linksPopulated?: boolean,
 *           retargeted?: boolean | null }} input
 *   `retargeted`: whether the PR's timeline records a base change — `null` when it was
 *   not read. Only `true` is evidence of one (kanon#182).
 */
export const analyse = ({ body, title = '', willClose, commitMessages = [], repo, issuesReadable = true, linksPopulated = true, retargeted = null }) => {
  const zone = declarationZone(body);
  // In the declaration zone, code spans are NOT stripped: a backticked keyword
  // there is a claim the author believes, and GitHub's silence about it is the bug.
  const declared = closingRefs(zone, repo);
  // THE SAME ZONE, PARSED THE WAY GITHUB PARSES IT — which is what separates the two
  // causes of `declaredButWontClose` (RA-1111). `declared` above deliberately does NOT
  // strip code spans, because finding 1 is precisely a keyword GitHub cannot see; so
  // the difference between the two sets is exactly "the keyword is inside a span".
  //
  //   in a span  — `` `Closes #N` ``. GitHub's body parser skips it. Unbacktick it;
  //                that has been the right advice since RA-1013.
  //   plain      — `Closes #N`, no span, and GitHub still resolved nothing. A backtick
  //                is then DEFINITIVELY not the cause, and printing it as one sends the
  //                author to edit the one thing that was already correct.
  //
  // The measured cause of the plain case is this issue: GitHub parses closing
  // references when a body is OPENED or EDITED and NOT when a base is RETARGETED, so a
  // stacked PR loses every declaration at the moment its parent merges and GitHub moves
  // it to the default branch — body untouched, keyword untouched. RA-1109 went to `[]`
  // that way and came back on an edit; RA-1672 hit it again the day it taught this file
  // about stacked bases, and its own body records the recovery.
  const plainlyDeclared = closingRefs(stripCode(zone), repo);
  // Slice from where the zone ACTUALLY sits, not from character 0. `declarationZone`
  // skips a leading blockquote, so `slice(zone.length)` counted the length of one
  // paragraph from the start of a different one — what landed "below the zone" then
  // depended on how long the Closes line happened to be. On the Implementer template
  // that this check is built around, a `closes #N` inside the banner leaked back in.
  const text = body ?? '';
  const belowZone = zone ? text.slice(text.indexOf(zone) + zone.length) : text;
  const forward = closingRefs(stripCode(belowZone), repo).filter((n) => willClose.includes(n));
  const inCommits = [...new Set(commitMessages.flatMap((m) => closingRefs(stripCode(m), repo)))];

  const mergeWillClose = mergeMessageRefs(title, body, repo);

  return {
    declared,
    // The subset of `declared` GitHub's own body parser can see. Not gated on
    // `linksPopulated`: it is a property of the TEXT, and the whole point is to be able
    // to say "the text is fine" on a run where the links are not.
    plainlyDeclared,
    willClose,
    // An empty closing set is AMBIGUOUS: the PR closes nothing, or Issues could not
    // be read. Conflating them inverts the whole check — every declared issue looks
    // unclosable and the arm that catches RA-918/RA-964/RA-840 becomes `[].filter(...)`.
    // So it is reported as unverifiable, never as a mismatch.
    unverifiable: !issuesReadable && willClose.length === 0,
    // A THIRD CAUSE OF AN EMPTY CLOSING SET, and the same conflation one layer out
    // (RA-1672 review round 0 — this check found it on itself).
    //
    // GitHub populates `closingIssuesReferences` ONLY for a PR targeting the
    // repository's DEFAULT BRANCH. A stacked PR — base set to another PR's branch,
    // which is how this repo splits a batch for review — therefore gets `[]` no
    // matter what its body says, and every declared reference lands in
    // `declaredButWontClose` with a message blaming a backtick that is not there.
    // Measured the day it was found: PR RA-1671 (base `main`) resolved 13 references
    // and PR RA-1672 (base RA-1671's branch) resolved 0, same token, same hour, both
    // bodies written the same way.
    //
    // DEFERRED, NOT SKIPPED, and that distinction is what makes this safe. Changing
    // a PR's base fires `pull_request: edited`, which this workflow already listens
    // for — so the moment the stack lands and GitHub retargets the PR to the default
    // branch, this check re-runs with the ARMS LIVE, before any merge. The window in
    // which the arms are blind is exactly the window in which the PR cannot be merged.
    //
    // "ARMS LIVE", NOT "LINKS POPULATED", AND THE DIFFERENCE IS MEASURED (RA-1111, and
    // RA-1672 review). An auto-retarget does NOT re-parse the body: RA-1111 recorded PR
    // RA-1109 losing its closing reference to `[]` when its base moved to `main`, with
    // the body never edited, and getting it back only when the body was edited. So the
    // first run after a retarget goes RED — arms live, `willClose` still empty, every
    // declared reference in `declaredButWontClose` — and clearing it takes a no-op body
    // edit, which is RA-1111's own remedy. That is the correct outcome rather than a
    // residual bug here: red-until-edited is exactly what should happen when the links
    // a merge depends on genuinely are not registered.
    //
    // ONLY THE LINK-BASED ARMS GO QUIET. `mergeClosesUndeclared` is computed from the
    // title and body alone, so it is unaffected and still FAILS the run — that is the
    // arm which caught RA-1029, the most expensive of the three defects this file exists
    // for, and it is why deferral cannot make this a check that never fires.
    //
    // `droppedBySquash` reads `willClose` too, and was the one arm left reading it bare
    // (RA-1672 review, then kanon#165). On a deferred PR `willClose` is `[]` by
    // construction, so it reported every commit-message keyword, including ones the body
    // already declares, with advice to "declare it in the body". It is now computed
    // against what the body declares as well as what the links close, so a declared
    // reference is never reported as dropped on any base; a commit keyword the body does
    // not declare is still reported on a stacked PR, where the note is as true as anywhere.
    linksDeferred: !linksPopulated,
    // Declared up top, but the PR link will not close it — backticks, a fence, or a
    // typo. It may still be closed by the MERGE COMMIT, which reads the same
    // characters as plain text; `mergeClosesUndeclared` is the arm for that.
    // NOT gated on `issuesReadable`. Suppressing it there left a state with no
    // report and no failure: an unreadable probe with a NON-empty willClose — i.e.
    // "the REST probe flaked, GraphQL was fine" — suppressed the arm while
    // `unverifiable` stayed false, so the run exited 0 saying the references agree.
    // That is the exact conflation this file exists to remove, one layer up. The
    // empty case is already covered by the loud fail, and a non-empty willClose is
    // by definition a good read, so the arm is safe to run unconditionally.
    declaredButWontClose: linksPopulated ? declared.filter((n) => !willClose.includes(n)) : [],
    // Will close, and the declaration does not say so. A stale link, or a forward
    // reference further down the body. Both close an issue nobody meant to close.
    willCloseButNotDeclared: linksPopulated ? willClose.filter((n) => !declared.includes(n)) : [],
    // The subset of the above that is explained by a keyword below the zone.
    probableForwardRefs: linksPopulated ? forward : [],
    // In a commit message and nowhere the merge will read. A reference the body DECLARES
    // is not dropped — the body is what the squash keeps — and that has to hold where
    // `willClose` is empty for want of links rather than for want of a declaration.
    droppedBySquash: inCommits.filter((n) => !willClose.includes(n) && !declared.includes(n)),
    // The second oracle. `closingIssuesReferences` predicts what the PR LINK
    // closes; this predicts what the merge COMMIT closes, and they disagree
    // whenever a keyword is inside a code span or split across a line break.
    mergeWillClose,
    // The finding: the merge commit closes it and the declaration never said so.
    // Supersedes trusting `willClose` alone — that field read `[1013]` on the PR
    // that closed RA-918 and RA-897.
    mergeClosesUndeclared: mergeWillClose.filter((n) => !declared.includes(n)),
    // Evidence for the one measured cause of a plain declaration GitHub did not resolve.
    // Carried, not judged here: `explain` names the retarget only when this is `true`.
    retargeted,
  };
};

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

// `baseRefName` is read by `linksArePopulated`, and a field this list does not request is
// `undefined` rather than an error, so dropping it would quietly un-defer every stacked PR.
// tests/library/closing-refs-read.test.ts asserts the request (kanon#165).
export const readPr = (pr, repo) => {
  const meta = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'title,body,closingIssuesReferences,commits,baseRefName']));
  return {
    body: meta.body,
    // The squash message is TITLE + BODY, so the title is part of the oracle.
    title: meta.title,
    willClose: meta.closingIssuesReferences.map((r) => r.number),
    commitMessages: meta.commits.map((c) => `${c.messageHeadline}\n${c.messageBody ?? ''}`),
    baseRefName: meta.baseRefName,
    // Read here, with the rest of the PR, so the one read a caller makes carries it.
    retargeted: baseRetargeted(pr, repo),
  };
};

/** Will GitHub have populated `closingIssuesReferences` for a PR on this base?
 *
 *  EXPORTED so the predicate itself is tested, not just the branch it selects. Its
 *  first draft read `baseRefName` from a `--json` list that did not request the field,
 *  so it was `undefined` for every PR and `undefined !== 'main'` deferred the check on
 *  ALL of them — a guard silenced everywhere, which is worse than the noisy run it was
 *  fixing. That is only visible from outside the function.
 *
 *  `defaultBranch === null` means the read failed; treat the base as the default so the
 *  arms stay LIVE. The failure direction that matters is silencing a real mismatch. */
export const linksArePopulated = (baseRefName, defaultBranch) =>
  // A MISSING BASE IS THE REGRESSION THIS DOCSTRING DESCRIBES, so it is caught rather
  // than merely narrated (RA-1672 review). Without this clause the predicate returned
  // `false` for `(undefined, 'main')` — deferring the check on every PR in the repo,
  // which is exactly what the first draft did and what the paragraph above records. The
  // tests pinned `(undefined, undefined)`, a different case: an unreadable DEFAULT
  // BRANCH. Both now fail LIVE, which is the safe direction on both axes.
  baseRefName === null || baseRefName === undefined
  || defaultBranch === null || defaultBranch === undefined
  || baseRefName === defaultBranch;

/**
 * Did this PR's base ever move? The evidence `explain` needs before it names a base
 * retarget as the cause of a plain declaration GitHub resolved to nothing (kanon#182).
 *
 * The reference adopter saw that diagnosis printed twice for PRs whose base had always
 * been the default branch, and its "re-save the body" remedy sent an author round a loop
 * of re-saves that could not work. So the claim now needs a `BaseRefChangedEvent` on the
 * PR's timeline.
 *
 * Counted from `nodes`, NOT `totalCount`: on a `timelineItems(itemTypes: …)` connection
 * `totalCount` counts the whole timeline, filter or not (measured on kanon#240: five items,
 * none a base change, `totalCount` 5). Reading it would report every PR as retargeted.
 *
 * @returns {boolean | null} `null` when the timeline could not be read.
 */
export const baseRetargeted = (pr, repo) => {
  const [owner, name] = repo.split('/');
  try {
    const nodes = JSON.parse(gh([
      'api', 'graphql',
      '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT],first:1){nodes{__typename}}}}}',
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`,
      '--jq', '.data.repository.pullRequest.timelineItems.nodes',
    ]));
    return Array.isArray(nodes) ? nodes.length > 0 : null;
  } catch {
    return null;
  }
};

/** The repository's default branch — the only base for which GitHub populates
 *  `closingIssuesReferences` at all. Read rather than assumed to be `main`: getting
 *  it wrong in the safe direction silences three arms on every PR. */
export const defaultBranchOf = (repo) => {
  try {
    return JSON.parse(gh(['repo', 'view', repo, '--json', 'defaultBranchRef'])).defaultBranchRef?.name ?? null;
  } catch {
    // Unreadable: assume the base IS the default branch, so the arms stay live. The
    // failure direction that matters is silencing a real mismatch, not one noisy run
    // on a stacked PR.
    return null;
  }
};

/**
 * An empty `closingIssuesReferences` is ambiguous: the PR closes nothing, or the
 * token could not read Issues. Those must not be conflated — conflating them is
 * what turns a permissions bug into a green run elsewhere in this repo, and into
 * an inverted check here. So prove the read works before trusting the emptiness.
 */
const canReadIssues = (repo) => {
  // A LIST endpoint, not a specific issue. The first version probed
  // `repos/<repo>/issues/1013` — the issue this very PR closes — so deleting or
  // transferring one issue would have silently disabled the check in a way nobody
  // would connect to a missing issue.
  try {
    execFileSync('gh', ['api', `repos/${repo}/issues?per_page=1`, '--jq', 'length'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { ok: true, stderr: '' };
  } catch (e) {
    // Keep the real error. Reporting "grant issues: read" for a rate-limit or a
    // network blip is a confidently wrong diagnosis on the one path whose whole job
    // is diagnosing, and this file already argues that being wrong while looking
    // responsible is the failure mode worth designing against.
    return { ok: false, stderr: String(e?.stderr ?? '').trim() };
  }
};

/**
 * The findings, as the text an author is shown.
 *
 * EXPORTED BECAUSE THE DIAGNOSIS IS THE PRODUCT (RA-1111). Everything above computes
 * SETS, and every set here has been correct on the run that did the damage — what was
 * wrong was the sentence explaining it. `main` was the only place that sentence lived,
 * so nothing could assert on it, and a confidently-wrong cause shipped twice: "usually
 * a backtick" on a declaration with no backtick in it, and "backtick the reference" as
 * the way to clear a link that backticking cannot clear. A check that is confidently
 * wrong about a cause is worse than one that says nothing, because the author edits the
 * one thing that was already right.
 *
 * @param {ReturnType<typeof analyse>} r
 * @param {string} repo
 * @param {string|number} [pr] the PR number, so the recovery command is copy-pasteable
 * @returns {string[]}
 */
export const explain = (r, repo, pr = '<pr>') => {
  const line = (n) => `https://github.com/${repo}/issues/${n}`;
  const problems = [];

  for (const n of r.declaredButWontClose) {
    if (r.plainlyDeclared.includes(n)) {
      // THE RA-1111 SHAPE. The keyword is not in a code span, so the body parser saw
      // exactly what a reader sees and GitHub still resolved nothing.
      const head = `#${n} is declared as closed by this PR and the PR LINK will not close it — and the keyword is NOT inside a code span, so a backtick is not the cause here.`;
      const notAnIssue = `#${n} is not an ISSUE in this repository: a pull-request number, or an issue that was deleted or transferred, never appears in that field. ${line(n)}`;
      if (r.retargeted === true) {
        // A retarget is the only cause measured for this shape, twice, and this PR's
        // timeline records one — so naming it is evidence, not a guess.
        problems.push(`${head}
    The measured cause is a BASE RETARGET (RA-1111), and this PR's base has moved: GitHub parses closing references when a body is opened or edited, and NOT when a base moves. A stacked PR therefore loses every declaration at the moment its parent merges and GitHub retargets it to the default branch, with the body never touched.
    Fix: re-save the body — any real change is enough, a trailing newline will do — then confirm with \`gh pr view ${pr} --json closingIssuesReferences\`. The same characters resolve on the second parse.
    If it still does not resolve, ${notAnIssue}`);
        continue;
      }
      // NO EVIDENCE OF A RETARGET (kanon#182). The reference adopter saw the retarget
      // diagnosis printed twice on PRs whose base had always been the default branch; four
      // and more re-saves each left the field `[]`. Prescribing that loop again is the
      // confidently-wrong cause this function's docstring warns about, so say "unknown" and
      // hand it to a person, who has remedies an edit does not.
      const evidence = r.retargeted === false
        ? "This PR's timeline records no base change, so the one measured cause, a base retarget, does not apply, and re-saving the body has been seen not to help here."
        : "This PR's timeline could not be read, so a base retarget, the one measured cause, can't be confirmed. If you know the base moved, re-save the body; that re-parses it.";
      problems.push(`${head}
    The cause is UNKNOWN. ${evidence}
    Route it to a human: link #${n} to this PR in its Development sidebar (a manual link is part of \`closingIssuesReferences\`), or close #${n} by hand when this PR merges.
    Or ${notAnIssue}`);
      continue;
    }
    const alsoMerge = r.mergeWillClose.includes(n);
    problems.push(`#${n} is declared as closed by this PR, but the PR LINK will not close it — the keyword is inside a code span or a fence.
    ${alsoMerge
      ? `The MERGE COMMIT will still close it, because backticks are not syntax there. The declaration and the outcome agree by accident, not by construction — unbacktick the keyword so both parsers see the same thing.`
      : `Neither will the merge commit, so #${n} stays OPEN. Unbacktick the keyword in the declaration.`} ${line(n)}`);
  }
  for (const n of r.mergeClosesUndeclared) {
    if (r.willCloseButNotDeclared.includes(n)) continue; // reported once, below
    problems.push(`#${n} will be closed by the MERGE COMMIT MESSAGE, and the declaration does not say so.
    This repo squash-merges with the PR title + body, and a commit message is parsed as PLAIN TEXT:
    backticks are not syntax there, and a newline between the keyword and the \`#N\` is just whitespace.
    \`closingIssuesReferences\` cannot see either, which is how PR RA-1029 closed RA-918 and RA-897 while that field read [1013].
    Fix: backtick the REFERENCE, not the phrase — \`closes \\\`#${n}\\\`\` breaks the adjacency in both parsers;
    \`\\\`closes #${n}\\\`\` only hides it from one. ${line(n)}`);
  }
  for (const n of r.willCloseButNotDeclared) {
    // BOTH ARMS DESCRIBE AN ALREADY-REGISTERED LINK — `willCloseButNotDeclared` is a
    // subset of `willClose` by construction — so PREVENTING a link and CLEARING one are
    // not the same instruction, and this said the wrong one. Backticking the reference
    // is the right spelling for a forward reference that has not linked yet (a brief's
    // decomposition table); it does nothing to a link GitHub has already stored, which
    // survives every edit that keeps the `#N` token. RA-1008 measured the stronger version
    // of that: removing the KEYWORD did not clear RA-918, removing the token did. PR RA-1658
    // was one revision from closing RA-326 through the same gap.
    const why = r.probableForwardRefs.includes(n)
      ? 'A closing keyword appears further down the body. GitHub cannot tell a plan from a claim, and it has NO notion of negation — "does not close #N" links exactly as hard as "closes #N".'
      : 'No closing keyword for it in the declaration — most often a link left by an earlier body revision, which is why you may not be able to find one.';
    problems.push(`#${n} WILL be closed on merge and the declaration does not say so.
    ${why}
    The link is ALREADY registered, so backticking will not clear it: GitHub keeps it until the \`#${n}\` TOKEN itself is gone. Write the number bare — \`${n}\`, no \`#\`. Do NOT swap it for the issue URL: a closing keyword in front of one is a spelling GitHub's linker acts on too (RA-1055), so that keeps the link rather than clearing it. Then re-read \`closingIssuesReferences\` to confirm it dropped. ${line(n)}`);
  }
  return problems;
};

const main = () => {
  const pr = process.argv[2];
  const repo = process.env.REPO ?? process.env.GITHUB_REPOSITORY;
  if (!pr || !repo) {
    console.error('usage: REPO=owner/name closing-refs.mjs <pr-number>');
    process.exit(2);
  }

  const probe = canReadIssues(repo);
  const meta = readPr(pr, repo);
  const defaultBranch = defaultBranchOf(repo);
  // `null` (unreadable) means treat the base as the default branch — see above.
  const linksPopulated = linksArePopulated(meta.baseRefName, defaultBranch);
  const input = { ...meta, repo, issuesReadable: probe.ok, linksPopulated };
  if (analyse(input).unverifiable) {
    console.error(`cannot read Issues in ${repo}, so an empty closingIssuesReferences proves nothing.
    Most often this is a missing \`issues: read\` in the workflow's permissions block — but a rate-limit,
    a network failure or an expired token land here too, so read the error rather than assuming:

      ${probe.stderr || '(no stderr captured)'}

    Failing loudly rather than reporting a mismatch that is an artifact of the read.`);
    process.exit(2);
  }
  const r = analyse(input);
  const problems = explain(r, repo, pr);
  if (r.linksDeferred) {
    console.log(`::warning title=closing refs deferred::PR #${pr} targets \`${meta.baseRefName}\`, not the default branch \`${defaultBranch}\`. GitHub populates \`closingIssuesReferences\` only for a PR onto the default branch, so the link-based arms have NO input here and are deferred rather than passed. Changing a PR's base fires \`pull_request: edited\`, which this workflow listens for — so when the stack lands and this PR is retargeted, the declaration is checked for real before it can merge. The text-based arms (merge-commit keywords, commit-message keywords) still ran.`);
    console.log(`declared: [${r.declared}]  will close: (deferred — base is \`${meta.baseRefName}\`, not \`${defaultBranch}\`)`);
  }

  // Reported, never fatal: the author did the right thing in the wrong artifact.
  for (const n of r.droppedBySquash) {
    // NOT prescriptive. A commit message that DESCRIBES an issue reads identically
    // to one that claims to close it — this PR's own commits mention RA-918, RA-897 and
    // RA-585 while closing none of them — and "move it into the body" would then be
    // advice to close an unrelated open issue. Measured on this PR: the commit
    // messages still carry `closes RA-897` / `closed RA-585` / `close RA-918` and
    // `closingIssuesReferences` is `[1013]`, so a commit keyword creates no link.
    console.log(`note: a commit message contains "closes #${n}", which creates no closing link — this repo squash-merges with the PR title and BODY. If this PR is meant to close #${n}, declare it in the body; if the commit merely mentions #${n}, ignore this.`);
  }


  if (!r.linksDeferred) console.log(`declared: [${r.declared}]  will close: [${r.willClose}]`);
  if (problems.length) {
    console.error(`\n${problems.length} closing-reference mismatch(es):\n`);
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exit(1);
  }
  console.log('closing references agree with the declaration.');
};

if (isCliEntry(import.meta.url)) main();
