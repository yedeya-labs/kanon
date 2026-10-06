import { describe, expect, it } from 'vitest';

import { analyse, closingRefs, declarationZone, explain, linksArePopulated, mergeMessageRefs } from '../../scripts/closing-refs.mjs';

/**
 * RA-1013 — the issues a PR WILL close vs the issues it SAYS it closes.
 *
 * Every fixture here is a real PR body from this repo, not an invented shape. The
 * three defects were all found by hand on 2026-08-26, each by querying
 * `closingIssuesReferences` directly — none was visible in the diff, in CI, or in
 * the review.
 */

describe('the declaration zone', () => {
  it('is the first real paragraph', () => {
    expect(declarationZone('Closes #1 · Refs #2\n\nbody text')).toBe('Closes #1 · Refs #2');
  });

  it('skips an agent\'s persona header line, which opens every agent post (plan 0005 §3.3)', () => {
    const header = '**Ada (Implementer)** <!-- kanon:role=implementer -->';
    expect(declarationZone(`${header}\n\nCloses #4\n\nbody text`)).toBe('Closes #4');
    expect(declarationZone(`**Implementer** <!-- kanon:role=implementer -->\n\n> banner\n\nCloses #5`)).toBe('Closes #5');
    // A header sharing its paragraph with a declaration is still the zone.
    expect(declarationZone(`${header}\nCloses #6\n\nbody`)).toBe(`${header}\nCloses #6`);
    // Bold prose without the marker is a paragraph like any other.
    expect(declarationZone('**Note**\n\nCloses #7')).toBe('**Note**');
  });

  it('does not leak the skipped banner back in as "below the zone"', () => {
    // `belowZone` was `body.slice(zone.length)` — an offset counted from character 0
    // while the zone starts after the banner, so what landed below it depended on
    // how long the Closes line happened to be. A `closes #N` inside the banner then
    // surfaced as a spurious note on the very template this check is built around.
    // Observed through `probableForwardRefs`, which is what picks the EXPLANATION
    // the author is shown: a leaked banner turns "a stale link from an earlier body
    // revision" into "a closing keyword further down the body", which sends them to
    // the wrong place.
    const body = '> **Agent-authored PR** (Triage/Fix). Bezalel dispatched this; it closes #500 per the brief.\n\nCloses #827';
    const r = analyse({ body, willClose: [827, 500] });
    expect(r.declared).toEqual([827]);
    expect(r.willCloseButNotDeclared).toEqual([500]);
    expect(r.probableForwardRefs).toEqual([]);
  });

  it('skips a leading blockquote banner', () => {
    // the Implementer's template opens with `> **Agent-authored PR** …`, so the first
    // paragraph is boilerplate and the Closes lines are the second. Measured on
    // real PRs: without this, RA-830 and RA-833 both flag — and agent PRs are the
    // majority in this repo, so the rule would false-block the class it most needs
    // to hold. This is the assertion that keeps 40 merged PRs at one flag.
    const body = '> **Agent-authored PR** (Triage/Fix). Per Gate C, a human merges.\n\nCloses #827\nCloses #836';
    expect(closingRefs(declarationZone(body))).toEqual([827, 836]);
  });
});

describe('what GitHub will actually close', () => {
  it('flags a link left by an earlier body revision (RA-1008 / RA-918)', () => {
    // The body said `Refs RA-918` and stated in prose that it does NOT close it.
    // GitHub kept 918 in the closing set from a revision nobody could read any
    // more. RA-918 is open on Development Automation; merging would have closed it.
    const r = analyse({
      body: 'Closes #1007 · Refs #918, #966\n\nIt does **not** close #918, which asks for a live check this does not perform.',
      willClose: [918, 1007],
    });
    expect(r.willCloseButNotDeclared).toEqual([918]);
  });

  it('flags a forward reference to work a FUTURE issue will do (RA-964 / RA-897)', () => {
    // The pilot brief's decomposition table described an issue that did not exist
    // yet. GitHub linked RA-897 — sev:high, Production Ready — to the PR that merely
    // PLANS the work, while the body's last line read "Closes nothing."
    const r = analyse({
      body: 'Brief for #961\n\n| **B** | Move the guard into settleOrderWith — **closes #897** | Production Ready |\n\nCloses nothing.',
      willClose: [897],
    });
    expect(r.willCloseButNotDeclared).toEqual([897]);
    expect(r.probableForwardRefs).toEqual([897]);
  });

  it('flags prose about ANOTHER PR\'s work (RA-840 / RA-585)', () => {
    // Found by this check, not by a human: "RA-732 fixed RA-585 structurally" is a
    // sentence about an already-merged PR. GitHub linked it. RA-585 was already
    // closed by RA-732 six days earlier, so the instance was harmless — by luck, not
    // by design.
    const r = analyse({
      body: 'Closes #754 — makes #585\'s fix a property instead of a convention.\n\n#732 fixed #585 **structurally**: the gateway field is gone from every service input.',
      willClose: [585, 754],
    });
    expect(r.willCloseButNotDeclared).toEqual([585]);
  });

  it('passes a PR whose declaration matches exactly', () => {
    const r = analyse({ body: 'Closes #1007, closes #1010 · Unblocks #964', willClose: [1007, 1010] });
    expect(r.willCloseButNotDeclared).toEqual([]);
    expect(r.declaredButWontClose).toEqual([]);
  });
});

describe('what the merge will silently drop', () => {
  it('reports a keyword GitHub did not parse in the declaration', () => {
    const r = analyse({ body: 'Closes #1007, `closes #1010` · Unblocks #964', willClose: [1007] });
    expect(r.declaredButWontClose).toEqual([1010]);
  });

  it('reports a commit-message keyword, which the squash discards', () => {
    // Measured, not assumed: this repo squash-merges with the PR title plus the PR
    // BODY. Across 13 merges every one is a single-parent commit containing the
    // body, and RA-1008's `Closes RA-1011` / `Closes RA-1012` appear ZERO times in its
    // merge commit — the issues closed only because they were also in the body.
    const r = analyse({
      body: 'Closes #1007 · Unblocks #964',
      willClose: [1007],
      commitMessages: ['test(qa): execute the filter\n\nCloses #1011', 'fix(qa): dispatch\n\nCloses #1012'],
    });
    expect(r.droppedBySquash).toEqual([1011, 1012]);
  });

  it('does not report a reference the body declares as dropped, on a stacked PR (kanon#165)', () => {
    // A stacked PR's `willClose` is `[]` by construction — GitHub fills it only for a PR
    // onto the default branch — so a commit keyword the body ALSO declares used to be
    // reported, with advice to "declare it in the body" for an issue it already declares.
    const r = analyse({
      body: 'Closes #1207',
      willClose: [],
      linksPopulated: false,
      commitMessages: ['fix(qa): x\n\ncloses #1207', 'fix(qa): y\n\ncloses #1300'],
    });
    expect(r.droppedBySquash, 'the declared one is not dropped; the undeclared one still is').toEqual([1300]);
  });

  it('does not report a declared reference as dropped when the links are live either', () => {
    // A backticked declaration GitHub cannot link is `declaredButWontClose`'s finding,
    // not this one's: the body already says it, so "declare it in the body" is wrong.
    const r = analyse({ body: 'Closes #1007, `closes #1010`', willClose: [1007], commitMessages: ['x\n\ncloses #1010'] });
    expect(r.droppedBySquash).toEqual([]);
    expect(r.declaredButWontClose).toEqual([1010]);
  });

  it('does not report one the PR link will close either, declared or not', () => {
    // The link closes it at merge whatever the commit says, so nothing is dropped; the
    // missing declaration is `willCloseButNotDeclared`'s finding.
    const r = analyse({ body: 'Closes #1007 · Refs #918', willClose: [918, 1007], commitMessages: ['x\n\ncloses #918'] });
    expect(r.droppedBySquash).toEqual([]);
    expect(r.willCloseButNotDeclared).toEqual([918]);
  });

  it('BLOCKS on a code-spanned keyword below the declaration', () => {
    // This used to be a note reading "inside code, so it will NOT close. Deliberate
    // for a planned issue" — and that advice is the exact false belief that closed
    // RA-918 and RA-897. A code span hides the keyword from the PR link and not from
    // the merge commit, so there is no benign case: `unparsedBelowZone` was a subset
    // of `mergeClosesUndeclared`, i.e. every note it emitted was paired with a fatal
    // saying the opposite. The arm is gone; this is what replaced it.
    const r = analyse({ title: 't', body: 'Closes #1007\n\n`Closes #1010`. Full suite: 958 passed.', willClose: [1007] });
    expect(r.mergeClosesUndeclared).toEqual([1010]);
  });

  it('does not block the SAFE shape — a backticked reference', () => {
    // ``closes `RA-897` `` is what the brief format writes for a planned issue, and it
    // is inert in BOTH parsers because the backtick breaks the adjacency. That is
    // the distinction the old note tried and failed to draw.
    const r = analyse({ title: 't', body: 'Closes #1007\n\n| B | move the guard — **closes `#897`** |', willClose: [1007] });
    expect(r.mergeClosesUndeclared).toEqual([]);
  });
});

describe('an empty closing set that could not be read', () => {
  it('is unverifiable, not a mismatch', () => {
    // The defect that shipped in round 1. `issues: read` was missing, GitHub
    // returned an EMPTY closingIssuesReferences on this private repo, and the check
    // inverted: every declared issue looked unclosable, and the arm catching
    // RA-918/RA-964/RA-840 became `[].filter(...)` — permanently silent. It blocked the
    // correct case and said nothing about the three defects it exists for.
    const r = analyse({ body: 'Closes #1013', willClose: [], issuesReadable: false });
    expect(r.unverifiable).toBe(true);
  });

  it('never suppresses a finding without also failing loudly', () => {
    // The gap in round 2: `declaredButWontClose` was gated on `issuesReadable` while
    // `unverifiable` also required an EMPTY willClose. An unreadable probe with a
    // non-empty willClose — the REST probe flaking while GraphQL succeeded — landed
    // between them: arm off, no loud fail, run exits 0 saying the references agree.
    // There must be no state that reports nothing and does not stop.
    for (const willClose of [[], [1007]]) {
      for (const issuesReadable of [true, false]) {
        const r = analyse({ body: 'Closes #1007, `closes #1010`', willClose, issuesReadable });
        const suppressed = r.declaredButWontClose.length === 0 && r.declared.includes(1010);
        expect(suppressed && !r.unverifiable).toBe(false);
      }
    }
  });

  it('is a real mismatch when Issues ARE readable', () => {
    const r = analyse({ body: 'Closes #1013', willClose: [], issuesReadable: true });
    expect(r.unverifiable).toBe(false);
    expect(r.declaredButWontClose).toEqual([1013]);
  });
});

describe('keyword parsing', () => {
  it.each([
    ['Closes #1', [1]],
    ['closed #2', [2]],
    ['Fixes #3', [3]],
    ['fixed #4', [4]],
    ['Resolves #5', [5]],
    ['resolve #6', [6]],
  ])('%s', (text, expected) => expect(closingRefs(text)).toEqual(expected));

  it.each([
    ['Refs #7'],
    ['Unblocks the pilot brief #8'],
    ['supersedes #9'],
    ['See #10'],
  ])('%s is not a closing keyword', (text) => expect(closingRefs(text)).toEqual([]));

  it('does not chain one keyword across several refs', () => {
    // "Closes RA-754 — makes RA-585's fix a property" links ONLY 754 from that clause.
    // GitHub needs the keyword per issue, not once per list.
    expect(closingRefs("Closes #754 — makes #585's fix a property")).toEqual([754]);
  });
});

describe('the ref spellings GitHub honours besides #N (RA-1055)', () => {
  const REPO = 'example-org/example-repo';

  it.each([
    ['closes example-org/example-repo#897', 'cross-repo, qualified with THIS repo'],
    ['closes https://github.com/example-org/example-repo/issues/897', 'the full issue URL'],
    ['closes GH-897', 'the GH- prefix'],
  ])('%s (%s)', (text) => expect(closingRefs(text, REPO)).toEqual([897]));

  it('drops a ref qualified with ANOTHER repository', () => {
    // Reporting a foreign RA-897 as a local one would be the confidently-wrong answer
    // `explain` says is worse than silence: the author would go edit an issue of ours
    // that the PR never mentioned.
    expect(closingRefs('closes other/repo#897', REPO)).toEqual([]);
  });

  it('does not read a bare issue URL with no keyword in front of it', () => {
    // ~10 commit messages on `main` carry one. None is adjacent to a closing keyword,
    // and treating a citation as a closure is how a widening turns into false blocks.
    expect(closingRefs('fixed by nothing; see https://github.com/example-org/example-repo/issues/5', REPO)).toEqual([]);
  });

  it('sees them on a STACKED PR, where the merge-message arm is the only one left', () => {
    // The sharpest case, and it post-dates the issue. RA-1672 taught this file that a
    // stacked PR gets an empty `closingIssuesReferences`, which quiets the three
    // link-based arms deliberately — leaving `mergeClosesUndeclared`, which runs on
    // this regex alone. Before RA-1055 these three spellings were silent-green there.
    const stacked = {
      body: 'Some prose.\n\nA later paragraph: closes example-org/example-repo#897.',
      title: 'fix(qa): something',
      willClose: [],
      repo: REPO,
      linksPopulated: false,
    };
    expect(analyse(stacked).mergeClosesUndeclared).toEqual([897]);
  });

  it('reads a qualified ref in the DECLARATION as a declaration, not as a missing one', () => {
    // The other direction: `Closes owner/repo#N` in line 1 is a declaration GitHub
    // honours. It used to produce `declared: []` and a red run blaming a missing
    // keyword that was sitting in the first line.
    const r = analyse({ body: 'Closes example-org/example-repo#897', willClose: [897], repo: REPO });
    expect(r.declared).toEqual([897]);
    expect(r.declaredButWontClose).toEqual([]);
    expect(explain(r, REPO, '1')).toEqual([]);
  });
});


describe('what the MERGE COMMIT will close (RA-1045)', () => {
  /**
   * `closingIssuesReferences` is not the whole oracle, and trusting it as one cost
   * two wrongly-closed issues on 2026-08-26 — RA-918, and RA-897 which is `sev:high` on
   * Production Ready.
   *
   * PR RA-1029's body was checked repeatedly before merge and the field read `[1013]`
   * every time. It was still wrong: that field parses the PR body as MARKDOWN,
   * where a code span is not a link, while the squash-merge commit message is the
   * PR title plus body parsed as PLAIN TEXT, where backticks are not syntax.
   *
   * The line that fired had been written to explain this exact bug.
   */
  it('sees a keyword the body parser treats as a code span', () => {
    // The real one, from PR RA-1029's body.
    expect(mergeMessageRefs('ci(qa): check closing refs', 'GitHub has no notion of negation — `closes #918` links.')).toEqual([918]);
  });

  it('sees a keyword split across a line break', () => {
    // The body is hard-wrapped into the commit message, so the keyword can end one
    // line and its #N begin the next. This is how RA-897 closed, and why the
    // line-by-line grep audit of that same commit did not find it.
    expect(mergeMessageRefs('t', 'the body genuinely said `closes\n#897`, so the two agreed')).toEqual([897]);
  });

  it('does NOT fire when the reference itself is backticked', () => {
    // The safe shape, and the reason the brief format's forward references have
    // never fired: a backtick between the keyword and the `#` breaks adjacency in
    // BOTH parsers. Backticking the whole phrase only hides it from one.
    expect(mergeMessageRefs('t', '| B | Move the guard into settleOrderWith — **closes `#897`** |')).toEqual([]);
  });

  it('includes the title, which is half the commit message', () => {
    expect(mergeMessageRefs('fix(x): thing, closes #42', 'body')).toEqual([42]);
  });

  it('reports what the merge closes but the declaration does not declare', () => {
    const r = analyse({
      title: "ci(qa): check a PR's closing references",
      body: 'Closes #1013\n\n`does not close #918` links exactly as hard as `closes #918`.',
      willClose: [1013],
    });
    expect(r.willClose).toEqual([1013]);           // the old oracle: clean
    expect(r.mergeWillClose).toContain(918);       // the new one: not clean
    expect(r.mergeClosesUndeclared).toEqual([918]);
  });

  it('passes a PR whose declaration matches what the merge will close', () => {
    const r = analyse({ title: 'fix: thing', body: 'Closes #1013 · Refs #918', willClose: [1013] });
    expect(r.mergeClosesUndeclared).toEqual([]);
  });
});

describe('a stacked PR has no links to check, and that is not a mismatch', () => {
  // GitHub populates `closingIssuesReferences` ONLY for a PR onto the default branch.
  // A stacked PR — base set to another PR's branch, which is how a batch gets split
  // for review — therefore gets `[]` whatever its body says, and every declared
  // reference landed in `declaredButWontClose` with a message blaming a backtick that
  // is not there. Measured the day it was found: PR RA-1671 (base `main`) resolved 13
  // references and PR RA-1672 (base RA-1671's branch) resolved 0 — same token, same hour,
  // both bodies written identically. This check found it on itself.
  const body = 'Closes #1207 · Closes #1484\n\nBatch E of a split.';

  it('does not report a mismatch it has no evidence for', () => {
    const r = analyse({ body, title: 'fix(qa): batch E', willClose: [], linksPopulated: false });
    expect(r.linksDeferred).toBe(true);
    expect(r.declared, 'the declaration is still read').toEqual([1207, 1484]);
    expect(r.declaredButWontClose, 'but nothing is claimed about links that were never populated').toEqual([]);
    expect(r.willCloseButNotDeclared).toEqual([]);
    expect(r.probableForwardRefs).toEqual([]);
  });

  it('still reports the same body as a mismatch when the links ARE populated', () => {
    // The other half of the pair — without it the deferral could be hiding a real
    // defect rather than an absent input.
    const r = analyse({ body, title: 'fix(qa): batch E', willClose: [] });
    expect(r.linksDeferred).toBe(false);
    expect(r.declaredButWontClose).toEqual([1207, 1484]);
  });

  it('keeps the TEXT-based arms live on a stacked PR', () => {
    // `mergeClosesUndeclared` is what caught RA-1029 — the most expensive of the three
    // defects this file exists for — and it reads the title and body, not the links.
    // If deferral silenced it too, this would be a check that cannot fail.
    const sneaky = 'Closes #1207\n\nA later paragraph that also says closes #999 by accident.';
    const r = analyse({ body: sneaky, title: 'fix(qa): x', willClose: [], linksPopulated: false });
    expect(r.mergeClosesUndeclared, 'the squash message will still close #999').toContain(999);
  });

  it('does not defer a PR that targets the default branch', () => {
    const r = analyse({ body, title: 't', willClose: [1207, 1484], linksPopulated: true });
    expect(r.linksDeferred).toBe(false);
    expect(r.declaredButWontClose).toEqual([]);
  });

  it('defers on the base, and ONLY on the base', () => {
    // The predicate is where this goes wrong quietly. The first draft read
    // `baseRefName` from a `--json` list that never requested it, so it was
    // `undefined` for every PR and the check deferred EVERYWHERE — a guard silenced
    // on the whole repo, which is strictly worse than the noisy run it was fixing.
    expect(linksArePopulated('main', 'main'), 'an ordinary PR is never deferred').toBe(true);
    expect(linksArePopulated('fix/1636-x', 'main'), 'a stacked PR is').toBe(false);
    expect(linksArePopulated('trunk', 'trunk'), 'the default branch is read, not assumed to be `main`').toBe(true);
    expect(linksArePopulated('main', 'trunk')).toBe(false);
    // An unreadable default branch must leave the arms LIVE — silencing a real
    // mismatch is the failure that matters, one noisy run on a stack is not.
    expect(linksArePopulated('anything', null)).toBe(true);
    expect(linksArePopulated(undefined, undefined)).toBe(true);
    // THE REGRESSION THE DOCSTRING NAMES, now caught rather than narrated (RA-1672
    // review). A `baseRefName` the read never requested is `undefined`, and the first
    // draft returned `false` for it — deferring the check on EVERY PR in the repo. The
    // assertion above pins the unreadable-DEFAULT-BRANCH case, which is a different one.
    expect(linksArePopulated(undefined, 'main'), 'a missing base must fail LIVE, not defer everywhere').toBe(true);
    expect(linksArePopulated(null, 'main')).toBe(true);
  });
});

describe('a retargeted PR is not a backticked one (RA-1111)', () => {
  /**
   * GitHub parses closing references when a body is OPENED or EDITED, and NOT when a
   * base is RETARGETED. So a stacked PR loses every declaration at the moment its
   * parent merges and GitHub moves it to the default branch — body never touched,
   * keyword never touched. RA-1109 recorded the set going to `[]` and coming back only
   * on an edit; PR RA-1672 hit it again a day after teaching this file about stacked
   * bases, and its own body carries the correction.
   *
   * RA-1672 fixed the STACKED half — base is not the default branch, so the link arms
   * defer. This is the half that survives it: once GitHub retargets, the arms are live
   * again and `willClose` is still empty, so every declared reference lands in
   * `declaredButWontClose` and the run goes red. Red is correct there. The advice was
   * not: it read "usually a backtick or a code fence around the keyword" on a
   * declaration with no backtick in it, which sends the author to edit the one thing
   * that was already right.
   */
  const retargeted = { body: 'Closes #957\n\nStacked on #1092; its parent has landed.', title: 'fix(qa): x', willClose: [], retargeted: true };

  it('separates a keyword GitHub could not see from one it simply did not re-read', () => {
    const r = analyse(retargeted);
    expect(r.declaredButWontClose, 'the mismatch is real and still reported').toEqual([957]);
    expect(r.plainlyDeclared, 'and the text is plain — GitHub saw the same characters a reader does').toEqual([957]);

    const backticked = analyse({ body: 'Closes #1007, `closes #1010`', title: 't', willClose: [1007] });
    expect(backticked.declaredButWontClose).toEqual([1010]);
    expect(backticked.plainlyDeclared, 'the span is exactly what GitHub cannot see').toEqual([1007]);
  });

  it('names the retarget rather than a backtick that is not there', () => {
    const [msg, ...rest] = explain(analyse(retargeted), 'o/r', 1109);
    expect(rest).toEqual([]);
    expect(msg, 'the cause').toContain('BASE RETARGET');
    expect(msg, 'the remedy — a body edit re-parses the same characters').toMatch(/re-save the body/i);
    expect(msg, 'and the command that proves it worked, on this PR').toContain('gh pr view 1109 --json closingIssuesReferences');
    expect(msg, 'a backtick must NOT be offered as the cause').not.toMatch(/usually a backtick|[Uu]nbacktick/);
  });

  it('still says "unbacktick" when the keyword really is in a code span', () => {
    // The other half of the pair. Without it, the fix above could be "delete the
    // backtick diagnosis", which would lose the finding this check was built for
    // (RA-1008 / RA-1010) rather than aim it.
    const [msg] = explain(analyse({ body: 'Closes #1007, `closes #1010`', title: 't', willClose: [1007] }), 'o/r', 1);
    expect(msg).toContain('inside a code span');
    expect(msg).toMatch(/unbacktick the keyword/i);
    expect(msg, 'and not the retarget story').not.toContain('BASE RETARGET');
  });

  it('offers the one other cause of a plain declaration that resolves to nothing', () => {
    // `closingIssuesReferences` resolves ISSUES. A PR number, or an issue that was
    // deleted or transferred, is plainly written, correctly spelled, and will never
    // appear there — so "re-save the body" alone would loop an author forever.
    const [msg] = explain(analyse(retargeted), 'o/r', 1109);
    expect(msg).toMatch(/not an ISSUE in this repository/);
  });
});

describe('a base retarget is claimed only when the base moved (kanon#182)', () => {
  /**
   * The reference adopter saw "the measured cause is a BASE RETARGET" printed twice on PRs
   * whose base had always been the default branch, with no base change on the timeline. Its
   * remedy, "re-save the body", was tried four and more times on each and the closing set
   * stayed `[]`, so the advice sent the Reviewer and the Implementer round a loop. The red
   * run was right; the diagnosis was not.
   */
  const plain = { body: 'Closes #957', title: 'fix(qa): x', willClose: [] };

  it('says the cause is unknown and routes to a human when the timeline shows no base change', () => {
    const [msg, ...rest] = explain(analyse({ ...plain, retargeted: false }), 'o/r', 2654);
    expect(rest).toEqual([]);
    expect(msg, 'the finding is still reported').toContain('the PR LINK will not close it');
    expect(msg).toContain('The cause is UNKNOWN');
    expect(msg, 'and why the retarget does not apply').toContain('records no base change');
    expect(msg, 'a person can link it, or close it by hand').toMatch(/Development sidebar[\s\S]*close #957 by hand/);
    expect(msg, 'no retarget is claimed').not.toContain('BASE RETARGET');
    expect(msg, 'and no re-save is prescribed').not.toMatch(/Fix: re-save/);
    expect(msg, 'the other cause is still offered').toMatch(/Or #957 is not an ISSUE in this repository/);
  });

  it('claims no retarget when the timeline could not be read, and says so', () => {
    for (const r of [analyse({ ...plain, retargeted: null }), analyse(plain)]) {
      const [msg] = explain(r, 'o/r', 2654);
      expect(msg).toContain('The cause is UNKNOWN');
      expect(msg).toContain('could not be read');
      expect(msg).not.toContain('BASE RETARGET');
      expect(msg).not.toMatch(/Fix: re-save/);
    }
  });

  it('keeps the retarget advice when the timeline records a base change', () => {
    const [msg] = explain(analyse({ ...plain, retargeted: true }), 'o/r', 1109);
    expect(msg).toContain('BASE RETARGET');
    expect(msg).toMatch(/Fix: re-save the body/);
    expect(msg).not.toContain('UNKNOWN');
  });

  it('leaves a code-spanned keyword to the backtick advice, whatever the timeline says', () => {
    const [msg] = explain(analyse({ body: 'Closes #1007, `closes #1010`', title: 't', willClose: [1007], retargeted: false }), 'o/r', 1);
    expect(msg).toMatch(/unbacktick the keyword/i);
    expect(msg).not.toContain('UNKNOWN');
  });
});

describe('clearing a link is not the same instruction as preventing one (RA-1111)', () => {
  /**
   * `willCloseButNotDeclared` is a subset of `willClose` by construction: the link
   * EXISTS. GitHub keeps it until the `#N` token itself is gone — RA-1008 measured the
   * stronger version, where removing the KEYWORD did not clear RA-918 and removing the
   * token did — so "backtick the reference", which is the right spelling for a forward
   * reference that has not linked yet, does nothing at all here. PR RA-1658 was one body
   * revision from closing RA-326 through exactly this gap.
   */
  it.each([
    ['a forward reference below the zone', 'Closes #754\n\n| B | move the guard — **closes #897** |', [754, 897], 897],
    ['a link from a body revision nobody can read', 'Closes #1007 · Refs #918', [918, 1007], 918],
  ])('%s: the remedy is the token, not a backtick', (_name, body, willClose, n) => {
    const r = analyse({ body, title: 't', willClose });
    expect(r.willCloseButNotDeclared).toContain(n);
    const msg = explain(r, 'o/r', 1).find((p) => p.startsWith(`#${n} WILL be closed`));
    expect(msg, 'the finding is reported').toBeTruthy();
    expect(msg).toContain('ALREADY registered');
    expect(msg, 'the token is what must go').toContain(`the \`#${n}\` TOKEN itself is gone`);
    expect(msg, 'backticking is named as insufficient, never as the fix')
      .toMatch(/backticking will not clear it/i);
  });

  it('keeps advising a backticked REFERENCE where it does work — the merge-commit arm', () => {
    // Not a contradiction: nothing is registered there. The squash message is re-parsed
    // from scratch, so breaking the adjacency prevents the link outright.
    const r = analyse({ title: 't', body: 'Closes #1007\n\n`Closes #1010`.', willClose: [1007] });
    const [msg] = explain(r, 'o/r', 1).filter((p) => p.includes('MERGE COMMIT MESSAGE'));
    expect(msg).toContain('backtick the REFERENCE, not the phrase');
  });
});
