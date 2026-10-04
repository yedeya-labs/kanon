import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const { ESCALATION_HEADER, IMPLEMENTER_LABELS, IMPLEMENTER_LOGIN: MERGE_GATE_IMPLEMENTER, LAPSES_WITH_HEAD, MERGER_LOGIN, SELF_CHECKS, UNSTABLE_SETTLE_MS, apply, checkPartition, mergeVerdict: kanonMergeVerdict, readPr, sweep, summaryLines, verifyClosed, skipSummary, startupFailuresIn} = await import('../../scripts/merge-gate.mjs');
const { CONFLICT_WHY } = await import('../../scripts/conflict-state.mjs');
const { IMPLEMENTER_LOGIN: LANE_IMPLEMENTER, PIPELINE_LABELS: LANE_LABELS } = await import('../../scripts/rebase-lane.mjs');
import { writeStub } from '../unit/helpers/stub-bin.js';
import { ESCALATE_PATHS } from './helpers/escalations.js';
import { ROOT } from './helpers/adopter.js';
/** A value of the untyped library, as the reference adopter's helper named it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibraryValue = any;

/**
 * Since Kanon v0.17 (kanon#135) the verdict takes the escalating paths as an argument, read
 * by the Merger from `docs/qa/escalation-paths.md` on `main`. These tests judge against THIS
 * repository's file, so every verdict below applies the reference adopter's real paths.
 */
const mergeVerdict = (p: LibraryValue, opts: Record<string, unknown> = {}) =>
  kanonMergeVerdict(p, { escalations: ESCALATE_PATHS, ...opts });

/**
 * RA-965 — the Merger. A person used to merge every PR by hand; this is the decision
 * that replaces it for the ordinary case.
 *
 * The tests are about the REFUSALS, not the merge. A merger that merges the right
 * PR is easy; one that reliably declines the wrong one is the whole product, and
 * every refusal has to be distinguishable from a crash — the failure this pipeline
 * produces over and over is a detector finding nothing and looking healthy.
 */
const HEAD = 'ee4530d1111111111111111111111111111111111'.slice(0, 40);
const OLD = 'aaaaaaa2222222222222222222222222222222222'.slice(0, 40);

const pr = (over: Record<string, unknown> = {}) => ({
  number: 1234,
  author: 'example-implementer[bot]',
  state: 'OPEN',
  isDraft: false,
  labels: ['agent:implement'],
  files: ['src/app/page.tsx'],
  headSha: HEAD,
  reviews: [{ state: 'APPROVED', sha: HEAD, author: 'example-reviewer[bot]' }],
  checks: [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  mergeStateStatus: 'CLEAN',
  // DECLARED ON EVERY FIXTURE, like the four files RA-2152 swept (RA-2184). `mergeVerdict`
  // reads this through `conflictState`, which THROWS rather than answering "clear" for
  // an object that never asked — so a fixture cannot opt out of the conflict branch
  // silently, and the typedef now says the field is required rather than optional.
  mergeable: 'MERGEABLE',
  // EXPLICIT, because `undefined` silently skipped the `=== false` arm and made every
  // conflict test pass against the wrong branch (RA-2218). `false` is the healthy default:
  // the rebase lane has not tried this head. The other two states are set per scenario.
  rebaseAttempted: false,
  closing: { mergeClosesUndeclared: [], unverifiable: false },
  // `[]`, not absent: `null` / non-array means "the Actions listing could not be read"
  // and waits (RA-2256), so a fixture that omitted it would test the wait arm by accident.
  workflowRuns: [],
  ...over,
});

describe('the green zone', () => {
  it('merges an approved agent:implement PR with green checks', () => {
    const v = mergeVerdict(pr());
    expect(v.action).toBe('merge');
    expect(v.rule).toBe('green-zone');
  });

  it("merges an approved agent:triage PR too — both of the Implementer's modes are the green zone", () => {
    // RA-1188. `agent:triage` is the label the triage-fix playbook MANDATES for a bug-fix
    // PR, and testing `agent:implement` alone made the Merger decline it — silently, since a
    // `skip` posts nothing. 9 of ~20 open PRs sat on that rule, several approved and
    // CLEAN for days.
    //
    // ITERATE A LITERAL, NEVER THE CONSTANT. Looping `IMPLEMENTER_LABELS` here asserts
    // the constant against itself: shrink it to `['agent:implement']` and this test
    // passes over a one-element array, and ADD `review:please` to it and this test
    // cheerfully proves that a `review:please` PR merges unattended. Both directions
    // matter on the constant that decides what merges with no human in the loop, so the
    // expected set is written out and pinned below.
    for (const label of ['agent:implement', 'agent:triage']) {
      const v = mergeVerdict(pr({ labels: [label] }));
      expect(v.action, label).toBe('merge');
      expect(v.rule, label).toBe('green-zone');
    }
    // The pin. A label added to the green zone must be added HERE, deliberately, with
    // the merge case above written for it.
    expect([...IMPLEMENTER_LABELS].sort()).toEqual(['agent:implement', 'agent:triage']);
  });

  it('holds an agent:triage PR to every other rule — the label widened, the gate did not', () => {
    // The fix for RA-1188 must not become a second, laxer green zone. A triage PR gets
    // the same author test, the same escalating paths and the same approval-on-head.
    expect(mergeVerdict(pr({ labels: ['agent:triage'], files: ['migrations/0003_x.sql'] })).rule).toBe('escalating-path');
    expect(mergeVerdict(pr({ labels: ['agent:triage'], author: 'a-person' })).rule).toBe('not-the-implementer');
    expect(mergeVerdict(pr({ labels: ['agent:triage'], reviews: [{ state: 'APPROVED', sha: OLD, author: 'example-reviewer[bot]' }] })).action)
      .not.toBe('merge');
  });

  it('accepts the app/ and [bot] forms of the same identity', () => {
    // The author arrives as `example-implementer[bot]` from one API and
    // `app/example-implementer` from another. Comparing raw strings silently
    // classified every PR as somebody else's.
    for (const author of ['example-implementer', 'example-implementer[bot]', 'app/example-implementer']) {
      expect(mergeVerdict(pr({ author })).action, author).toBe('merge');
    }
  });

  it('every verdict says which rule fired and why', () => {
    // A refusal without a reason is indistinguishable from a crash.
    for (const p of [pr(), pr({ isDraft: true }), pr({ files: ['.github/workflows/ci.yml'] }), pr({ reviews: [] })]) {
      const v = mergeVerdict(p);
      expect(v.rule, JSON.stringify(v)).toBeTruthy();
      expect(v.why, JSON.stringify(v)).toBeTruthy();
    }
  });
});

describe('what is silently not his', () => {
  // These must NOT escalate. Most review events in this repo are on PRs the Merger has
  // no business with, and a surface that reports them buries the real escalations.
  it.each([
    ['a closed PR', { state: 'CLOSED' }],
    ['a draft', { isDraft: true }],
    ["someone else's PR", { author: 'a-person' }],
    ['a PR carrying neither implementer label', { labels: ['review:please'] }],
    ['a PR with no labels at all', { labels: [] }],
  ])('skips %s', (_name, over) => {
    expect(mergeVerdict(pr(over)).action).toBe('skip');
  });

  it('skips a PR the Reviewer sent back, because the implementer owns it', () => {
    // Requested changes are the pipeline WORKING. Escalating here would label the
    // majority of PRs `needs:human` and train the developer to ignore the label.
    const v = mergeVerdict(pr({ reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD, author: 'example-reviewer[bot]' }] }));
    expect(v.action).toBe('skip');
    expect(v.rule).toBe('changes-requested');
  });
});

describe('what a human decides', () => {
  it('escalates every path on the list, naming the file and the reason', () => {
    // The developer's rule: "agentic pipeline work should remain manual work done by
    // me". The rest are the landmine surfaces agent-implement.yml already makes
    // The Implementer bail on — restated as a MECHANISM, because a bail is a prompt asking
    // an agent to refuse and this is not.
    // The fixture adopter's file declares its pipeline code, migrations and auth; the rest are
    // Kanon's own (`PIPELINE_ESCALATIONS`).
    const samples: [string, string][] = [
      ['.github/workflows/ci.yml', 'the CI and agent pipeline'],
      ['docs/qa/reviewer-playbook.md', 'the pipeline documents, which are agent instructions'],
      ['AGENTS.md', 'the agent instructions'],
      ['.claude/settings.json', 'the agent configuration'],
      ['scripts/pipeline/lead-reconcile.mjs', "the project's own pipeline scripts"],
      ['migrations/0001_init.sql', 'database migrations'],
      ['src/lib/auth/session.ts', 'auth'],
    ];
    for (const [file, reason] of samples) {
      const v = mergeVerdict(pr({ files: ['src/app/page.tsx', file] }));
      expect(v.action, file).toBe('escalate');
      expect(v.rule, file).toBe('escalating-path');
      expect(v.why, file).toContain(file);
      expect(v.why, file).toContain(reason);
    }
    // One sample per rule: every rule must be the one a sample hits.
    const firstHit = (f: string) => ESCALATE_PATHS.findIndex(([re]: LibraryValue) => (re as RegExp).test(f));
    const hit = new Set(samples.map(([f]) => firstHit(f)));
    expect(hit.size).toBe(ESCALATE_PATHS.length);
  });

  it.each(['sev:critical', 'qa:needs-info', 'blocked'])('escalates a %s label', (label) => {
    const v = mergeVerdict(pr({ labels: ['agent:implement', label] }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('escalating-label');
  });

  it('escalates a failed check', () => {
    const v = mergeVerdict(pr({
      checks: [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }));
    expect(v.action).toBe('escalate');
    expect(v.why).toContain('E2E (Playwright)');
  });

  it('escalates a squash commit that closes an undeclared issue', () => {
    // RA-918 and RA-897 were closed by a merge that had nothing to do with them. The
    // field is `mergeClosesUndeclared`, because merges are squashed and the commit
    // message is re-parsed as plain text.
    const v = mergeVerdict(pr({ closing: { mergeClosesUndeclared: [918, 897], unverifiable: false } }));
    expect(v.action).toBe('escalate');
    expect(v.why).toContain('#918, #897');
  });

  it('escalates rather than assuming an unreadable closing set is empty', () => {
    // "closes nothing" and "Issues could not be read" are the same empty array.
    // Conflating them is what inverts this check.
    const v = mergeVerdict(pr({ closing: { mergeClosesUndeclared: [], unverifiable: true } }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('closes-unverifiable');
  });

  it('escalates anything GitHub calls neither CLEAN nor UNKNOWN, naming the state', () => {
    // DIRTY is no longer in this set: since RA-2175 it takes the conflict branch above
    // and carries `CONFLICT_WHY`, which says more than the state name does. The other
    // three are ruleset states with an intact merge ref — `conflictState` calls them
    // `clear` by design — so they still report the literal GitHub gave.
    for (const s of ['BLOCKED', 'BEHIND', 'UNSTABLE']) {
      const v = mergeVerdict(pr({ mergeStateStatus: s }));
      expect(v.action, s).toBe('escalate');
      expect(v.why, s).toContain(s);
    }
  });

  it('does not MERGE a CONFLICTING PR that CI has already run on (RA-2175)', () => {
    // THE HOLE RA-2154 LEFT. `never-started` only fires when NO check has run; every
    // path where CI already ran fell through to `!== 'CLEAN'`, which asks
    // `mergeStateStatus` alone. On the stale-field case that verdict was `merge`, and
    // the resulting 405 from `gh pr merge` threw out of an unguarded sweep loop.
    //
    // Since RA-2218 the verdict is `wait` rather than `escalate` while the rebase lane
    // owns it — what RA-2175 fixed is that it is no longer `merge`, and that is what this
    // asserts. Which of the two non-merge verdicts it gets is RA-2218's block below.
    for (const over of [{ mergeStateStatus: 'CLEAN', mergeable: 'CONFLICTING' }, { mergeStateStatus: 'DIRTY' }]) {
      const v = mergeVerdict(pr(over));
      expect(v.action, JSON.stringify(over)).not.toBe('merge');
      expect(v.why, JSON.stringify(over)).toContain(CONFLICT_WHY);
    }
  });

  it('still WAITS on a PR GitHub has not finished computing, even when one field says conflicting', () => {
    // `conflictState` resolves `{ UNKNOWN, CONFLICTING }` to `conflicting`, so placing
    // the new branch BEFORE the UNKNOWN wait would stamp `needs:human` and a comment on
    // a mid-flight PR — the thing that wait exists to prevent. Waiting costs one tick,
    // after which the answer settles into DIRTY or stale-CLEAN and both are caught.
    const v = mergeVerdict(pr({ mergeStateStatus: 'UNKNOWN', mergeable: 'CONFLICTING' }));
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('merge-state-unknown');
  });

  it('WAITS on UNKNOWN, which is GitHub still computing rather than a verdict', () => {
    // Escalating it put `needs:human` and a comment on a PR that was merely
    // mid-flight — the surface crying about normal progress.
    const v = mergeVerdict(pr({ mergeStateStatus: 'UNKNOWN' }));
    expect(v.action).toBe('wait');
  });

  it('refuses to judge with no escalating paths at all, rather than merge with none applied (kanon#135)', () => {
    expect(() => kanonMergeVerdict(pr(), {} as never)).toThrow();
    expect(() => kanonMergeVerdict(pr(), { escalations: [] })).toThrow();
  });

  it('refuses when the changed-file list is empty, which disables every path rule', () => {
    // An empty list makes ESCALATE_PATHS match nothing while the verdict still reads
    // "no escalating path". A PR always changes at least one file, so empty means the
    // read failed.
    const v = mergeVerdict(pr({ files: [] }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('files-unreadable');
  });

  it('names a CANCELLED check as cancelled, not as a defect to hunt', () => {
    const v = mergeVerdict(pr({
      checks: [{ name: 'Build (next build)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED' }],
    }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('checks-cancelled');
    // The remediation names the CHECK RUN, not a fresh dispatch: a new dispatch creates
    // a new run and leaves this one in the rollup, so the old advice could not clear it.
    expect(v.why).toContain('re-run that check run');
  });

  it('ignores a cancelled run whose check also concluded (RA-1168)', () => {
    // The rollup carries EVERY run on the head. A check dispatched twice — `opened`
    // then `labeled`, routine here — leaves its `cancel-in-progress` casualty next to
    // the run that then passed. Refusing on any CANCELLED entry stopped the Merger
    // permanently on green commits: PR RA-979's `Red-test verification` passed TWICE on
    // `1c93976` and he still refused.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'Red-test verification', workflowName: 'Red-test', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { name: 'Red-test verification', workflowName: 'Red-test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }));
    // ASSERTS THE OUTCOME, NOT THE ABSENCE OF ONE RULE. The first version said
    // `.not.toBe('checks-cancelled')`, which passes for ANY other wrong answer — and
    // the answer WAS wrong: the superseded entry was excused by `cancelled` and picked
    // straight back up by `failed`, so the Merger still refused, under `checks-failed`,
    // with no remediation at all. The test was satisfied by the bug it was written to
    // catch.
    expect(v.action, 'the PR is otherwise green and must MERGE').toBe('merge');
  });

  it('still refuses when a DIFFERENT check is cancelled with nothing to replace it', () => {
    // Not vacuous: the supersede rule is per NAME, so one check's re-run must not
    // excuse another check that genuinely never reported.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'Red-test verification', workflowName: 'Red-test', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { name: 'Red-test verification', workflowName: 'Red-test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'Build (next build)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED' },
      ],
    }));
    expect(v.rule).toBe('checks-cancelled');
    expect(v.why).toContain('Build (next build)');
    expect(v.why, 'and must not name the superseded one').not.toContain('Red-test');
  });

  it('a cancelled run alongside a FAILURE of the same check still refuses', () => {
    // `concluded` counts a failure too, so the cancelled entry drops out — and the
    // `failed` partition below must then be what refuses, naming the real problem.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'CI', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { name: 'CI', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    }));
    expect(v.action).toBe('escalate');
    expect(v.rule, 'a real failure is reported as a failure').toBe('checks-failed');
    expect(v.why).toContain('CI');
  });

  it('supersede is keyed on workflow AND name, not name alone', () => {
    // Job ids are not unique across this repo's workflows — `agent-implement-revise`,
    // `agent-merge-reconcile` and `agent-review` all define a `filter` job, and
    // SELF_CHECKS excludes only two workflows. Keyed on the name alone, a genuinely
    // cancelled `filter` from one would be excused by a successful `filter` from
    // another. Two dispatches of the SAME workflow share both fields, so real
    // supersede still works.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'filter', workflowName: 'agent-review', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { name: 'filter', workflowName: 'agent-merge-reconcile', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }));
    expect(v.action, 'a different workflow does not excuse this one').toBe('escalate');
    expect(v.rule).toBe('checks-cancelled');
  });

  it('escalates its own needs:human label, so a transient refusal cannot clear itself', () => {
    // The sweep re-evaluates every open PR from scratch and the comment marker
    // suppresses only the COMMENT. Without this, an escalation whose cause was
    // transient merged an hour later still wearing the label that said not to — and a
    // human applying it by hand got no protection at all.
    const v = mergeVerdict(pr({ labels: ['agent:implement', 'needs:human'] }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('escalating-label');
  });

  it('escalates auth in CODE, not every path naming it', () => {
    // Measured on the pilot's own PR RA-1057: matching any path containing the word
    // escalated `docs/payment-state-machine.md` — a document ABOUT payments — and the
    // bare `auth` alternation also caught `authors.ts`. The landmine is the
    // implementation; a doc describing it is reviewed like any other doc.
    for (const f of [
      'docs/payment-state-machine.md', 'src/lib/authors.ts',
      'docs/co-authors.md', 'src/components/AuthorCard.tsx',
    ]) {
      expect(mergeVerdict(pr({ files: [f] })).action, f).toBe('merge');
    }
    // The reference adopter also escalated its payments code; the fixture adopter declares
    // auth and migrations.
    for (const f of [
      'src/lib/auth/session.ts', 'src/server/sessions.ts', 'migrations/0002_payment.sql',
    ]) {
      expect(mergeVerdict(pr({ files: [f] })).rule, f).toBe('escalating-path');
    }
  });

  it('escalates a QA PLAYBOOK but not an L2 SPEC', () => {
    // The playbooks are agent instructions, so editing one edits an agent. The specs
    // are the PILOT'S DELIVERABLE — escalating them made the Merger decline every PR the
    // project he exists for produces, which is the whole value of RA-965 on that project.
    // A spec change is reviewed by the Reviewer against the brief, which is its real check.
    expect(mergeVerdict(pr({ files: ['docs/qa/reviewer-playbook.md'] })).rule).toBe('escalating-path');
    expect(mergeVerdict(pr({ files: ['docs/qa/specs/payments.md'] })).action).toBe('merge');
  });

  it("merges the pilot's own PR RA-1057, measured against its real file list", () => {
    // The live shape, not a fixture: this exact PR was APPROVED on head and CLEAN, and
    // the first version of ESCALATE_PATHS declined it.
    const v = mergeVerdict(pr({ files: ['docs/payment-state-machine.md', 'docs/qa/specs/payments.md'] }));
    expect(v.action).toBe('merge');
  });
});

describe('the approval is evidence about ONE commit', () => {
  it('refuses an approval that belongs to a superseded commit', () => {
    // CORRECTED 2026-08-27: this comment claimed `dismiss_stale_reviews_on_push` is
    // FALSE and that the Merger was therefore the only guard. It is TRUE (ruleset
    // 18630463), so the ruleset dismisses a stale approval and this is the second
    // line. Kept regardless — it is cheap and local, and two independent answers
    // disagreeing is itself a finding. A stale approval reached the merge button
    // twice in a week (RA-964, RA-1057).
    const v = mergeVerdict(pr({ reviews: [{ state: 'APPROVED', sha: OLD, author: 'example-reviewer[bot]' }] }));
    expect(v.action).not.toBe('merge');
    expect(v.rule).toBe('no-review-on-head');
    expect(v.why).toContain('stale');
  });

  it('recovers rather than escalating when nobody has reviewed the commit', () => {
    // Recoverable: a review of THIS commit is something the pipeline can ask for.
    const v = mergeVerdict(pr({ reviews: [] }));
    expect(v.action).toBe('recover');
  });

  it('ignores an approval from anyone who is not the reviewer', () => {
    const v = mergeVerdict(pr({ reviews: [{ state: 'APPROVED', sha: HEAD, author: 'some-human' }] }));
    expect(v.action).toBe('recover');
    expect(v.rule).toBe('no-review-on-head');
  });

  it('takes the LATEST review on the head when it says what it supersedes', () => {
    // RA-1351's flow: a finding whose remedy is a PR-BODY edit produces no new commit, so
    // a human re-labels and the Reviewer re-reviews the SAME SHA. `request-changes` ->
    // `approve` there is the pipeline working, and recency is the right rule — but only
    // because the approving run SAW the blocking one and says so. See the RA-1334 block
    // below for the case where it did not.
    const v = mergeVerdict(pr({
      reviews: [
        { id: 11, state: 'CHANGES_REQUESTED', sha: HEAD, author: 'example-reviewer[bot]' },
        { id: 12, state: 'APPROVED', sha: HEAD, author: 'example-reviewer[bot]', supersedes: ['11'] },
      ],
    }));
    expect(v.action).toBe('merge');
  });

  it('re-dispatches on a COMMENT verdict instead of stalling on it', () => {
    // RA-378. Three of seven measured PRs ended on COMMENTED and were merged by hand;
    // reading the EVENT means the Merger stalls on them unless he repairs it. The
    // trigger change should make this unreachable — it stays because that change
    // runs only from the default branch and could not be tested before it merged.
    const v = mergeVerdict(pr({ reviews: [{ state: 'COMMENTED', sha: HEAD, author: 'example-reviewer[bot]' }] }));
    expect(v.action).toBe('recover');
    expect(v.rule).toBe('comment-verdict');
  });
});

describe('it does not wait on itself', () => {
  /**
   * The Merger wakes on `pull_request_review`, which fires the moment the Reviewer SUBMITS —
   * while the Review job is still running its remaining steps. Counting that check
   * run would make `checks-pending` fire on every single review event, pushing every
   * merge onto the hourly heartbeat while reporting a healthy-looking "still
   * running". Silent degradation, which is this pipeline's signature failure.
   */
  it('merges while the review that woke it is still in progress', () => {
    const v = mergeVerdict(pr({
      checks: [
        { name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'Review (Reviewer)', workflowName: 'Review (Reviewer)', status: 'IN_PROGRESS', conclusion: null },
        { name: 'Merge (Merger)', workflowName: 'Merge (Merger)', status: 'IN_PROGRESS', conclusion: null },
      ],
    }));
    expect(v.action).toBe('merge');
  });

  it('still waits on every OTHER agent check, which are real guards', () => {
    // Merge Reconcile's `filter` JOB is excluded since RA-1177 (it races the Merger on the
    // review event) — a check named after the workflow, as here, is still waited for.
    for (const workflowName of ['Label guard', 'Merge Reconcile (Reviewer)']) {
      const v = mergeVerdict(pr({
        checks: [{ name: workflowName, workflowName, status: 'IN_PROGRESS', conclusion: null }],
      }));
      expect(v.action, workflowName).toBe('wait');
    }
    // And one whose check-run name DIFFERS from its workflow name, which is the shape
    // `Closing references` used to cover here: since RA-2597 that guard is a step of the
    // `PR checks` workflow's frozen `PR title matches the commit taxonomy` job, so the
    // rollup entry carries two different strings. Neither is in `SELF_CHECKS`, so it is
    // still waited for — and the fixture now names a check run that exists.
    expect(mergeVerdict(pr({
      checks: [{
        name: 'PR title matches the commit taxonomy',
        workflowName: 'PR checks',
        status: 'IN_PROGRESS',
        conclusion: null,
      }],
    })).action).toBe('wait');
  });

  it('excludes exactly two workflows, under their names and their old spellings, and says which', () => {
    // The role-named callers, then the old spellings a run from before kanon#53 still carries.
    expect(SELF_CHECKS).toEqual(['Review (Reviewer)', 'Merge (Merger)', 'Review (Thomas)', 'Merge (Joshua)']);
  });

  it('waits — never escalates — on a check that is still running', () => {
    // A pending check is not a refusal. Escalating it would put `needs:human` on a
    // PR that is merely mid-flight.
    const v = mergeVerdict(pr({
      checks: [{ name: 'Build (next build)', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: null }],
    }));
    expect(v.action).toBe('wait');
  });
});

describe('the identity the workflow guards on', () => {
  it("reads the actor guard in agent-merge.yml from the register row MERGER_LOGIN comes from (RA-2741)", () => {
    // The guard stops the Merger from processing his own comments and merges. A slug
    // that does not match never matches — no error, just an agent answering its own
    // events. Since RA-2741 the guard holds no copy of the login: the `logins` job reads
    // the register's Merger row, the row `MERGER_LOGIN` is read from, and
    // `filter-job-if-2596.test.ts` executes that read. At runtime the workflow also
    // asserts the MINTED token against both reads.
    const wf = readFileSync(join(ROOT, '.github/workflows/agent-merge.yml'), 'utf8');
    expect(wf).toContain("github.actor != format('{0}[bot]', needs.logins.outputs.merger)");
    expect(wf).toContain('for role in Merger Implementer; do');
    expect(wf).not.toContain(`'${MERGER_LOGIN}[bot]'`);
    expect(wf).toContain('m.MERGER_LOGIN');
    expect(wf).toContain('GUARD_SLUG: ${{ needs.logins.outputs.merger }}');
  });
});

describe('a verdict is evidence about the commit the RUN READ (RA-1680)', () => {
  /**
   * GitHub sets `commit_id` to the head AT SUBMISSION TIME and `gh pr review` cannot
   * pin it, so a push landing while a review run is in flight re-attributes the verdict
   * to a commit nothing read.
   *
   * Measured on PR RA-1672: an `APPROVED` filed under `add9508` whose body opens "First
   * review on this PR (single commit `effc0c9`)", reports `Closing references` failing
   * (true of `effc0c9`, false of `add9508`) and asserts a CI set that had not finished
   * on `add9508` — pushed 18 seconds before the review landed. This filter is what then
   * merges on it, which is RA-964's shape reached by a different route.
   *
   * The reviewer job stamps the SHA it checked out into the review body; these assert
   * that the stamp, not `commit_id`, is what decides.
   */
  it('refuses an approval GitHub filed under the head but whose run read an earlier commit', () => {
    const v = mergeVerdict(pr({
      reviews: [{ id: 1, state: 'APPROVED', sha: HEAD, author: 'example-reviewer[bot]', reviewedSha: OLD }],
    }));
    expect(v.action, 'this is the merge #1680 is about').not.toBe('merge');
    expect(v.rule).toBe('review-misattributed');
    // NAMED SEPARATELY from a merely stale approval, because the two look identical on
    // the PR and only one of them reads as current.
    expect(v.why).toContain('the head moved mid-review');
  });

  it('accepts an approval whose stamp agrees with the head, whatever commit_id says', () => {
    // The inverse, and it is not hypothetical either: the same race can file a review
    // under the OLD head. What the run read is what counts, in both directions.
    const v = mergeVerdict(pr({
      reviews: [{ id: 1, state: 'APPROVED', sha: OLD, author: 'example-reviewer[bot]', reviewedSha: HEAD }],
    }));
    expect(v.action).toBe('merge');
  });

  it('reads the trailer through ONE definition, not a local copy of it (RA-1715)', () => {
    // A BEHAVIOURAL mutation cannot catch this, and the PR that introduced the import
    // claimed one could: replacing it with a file-local `(r) => r.reviewedSha || r.sha`
    // is observationally identical on every input `readPr` produces, so all 80 cases
    // pass. What is being protected is the SINGLE DEFINITION, and the drift it prevents
    // has already happened once — the local copy had `||` where the export has `??`.
    //
    // So it is pinned structurally, which is the only thing that can fail here.
    const src = readFileSync(join(ROOT, 'scripts/merge-gate.mjs'), 'utf8');
    expect(src, 'evidenceSha must come from the module that defines the trailer')
      .toMatch(/import \{[^}]*\bevidenceSha\b[^}]*\} from '\.\/review-trailer\.mjs'/);
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, 'and must not be re-derived beside the import')
      .not.toMatch(/(?:const|let|function)\s+evidenceSha\b/);
  });

  it('still trusts commit_id when there is no stamp — every review predating this has none', () => {
    // NON-VACUITY IN THE OTHER DIRECTION. An absent stamp proves nothing either way, so
    // it must fall back rather than refuse: otherwise this change would have refused
    // every open PR the day it merged.
    expect(mergeVerdict(pr({
      reviews: [{ id: 1, state: 'APPROVED', sha: HEAD, author: 'example-reviewer[bot]' }],
    })).action).toBe('merge');
  });

  it('is not hijacked by a review body that QUOTES the trailer format (RA-1713)', () => {
    // NOT HYPOTHETICAL, and pointedly so: the Reviewer writes about this mechanism in the body
    // of every review of this very PR. The stamp is APPENDED, so taking the FIRST
    // trailer-shaped match let a quoted example win over the genuine one beneath it —
    // and then `merge-gate` calls a real approval `review-misattributed`, the workflow's
    // verdict check reds a run whose verdict landed, and the recovery spends a churn on
    // a second full agent run. Every consequence is safe; the guard was still breakable
    // by describing it, in a change whose subject is guards that cannot fail.
    const dir = mkdtempSync(join(tmpdir(), 'merge-gate-quoted-'));
    const meta = {
      number: 1234, author: { login: 'example-implementer[bot]' }, state: 'OPEN', isDraft: false,
      labels: [{ name: 'agent:implement' }], headRefOid: HEAD,
      statusCheckRollup: [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      mergeStateStatus: 'CLEAN', title: 't', body: 'Closes #1',
      closingIssuesReferences: [{ number: 1 }], commits: [{ messageHeadline: 'x', messageBody: '' }],
    };
    const reviews = [{
      id: 88, user: { login: 'example-reviewer[bot]' }, state: 'APPROVED', commit_id: HEAD,
      body: [
        'The stamp is written as `<!-- reviewed: sha=' + OLD + ' run=1 -->`,',
        'which is how a review of #1680 describes it.',
        '',
        `<!-- reviewed: sha=${HEAD} run=42 -->`,
      ].join('\n'),
    }];
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  "pr view"*)           printf '%s' '${JSON.stringify(meta)}' ;;
  *"/files"*)           printf '%s\\n' 'src/a.ts' ;;
  *"/reviews"*)         printf '%s' '${JSON.stringify(reviews)}' ;;
  *"issues?per_page"*)  printf '%s' '0' ;;
  "run list"*)          printf '%s' '[]' ;;
esac
`);
    const read = readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(read.reviews[0].reviewedSha, 'the APPENDED stamp is the genuine one').toBe(HEAD);
    expect(read.reviews[0].runId).toBe('42');
    expect(mergeVerdict(read).action).toBe('merge');
  });

  it('reads the stamp out of the review body, which is where it actually arrives', () => {
    // `mergeVerdict` is pure and takes `reviewedSha` as data; `readPr` is what has to
    // find it in the body GitHub returns. Asserting only the pure half would leave the
    // parser — the part that can silently stop matching — untested.
    const dir = mkdtempSync(join(tmpdir(), 'merge-gate-trailer-'));
    const meta = {
      number: 1234, author: { login: 'example-implementer[bot]' }, state: 'OPEN', isDraft: false,
      labels: [{ name: 'agent:implement' }], headRefOid: HEAD,
      // A real check, so the `never-started` / `no-checks-yet` gate above does not
      // answer first and hide what this test is about.
      statusCheckRollup: [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      mergeStateStatus: 'CLEAN', title: 't', body: 'Closes #1',
      closingIssuesReferences: [{ number: 1 }], commits: [{ messageHeadline: 'x', messageBody: '' }],
    };
    const reviews = [{
      id: 77, user: { login: 'example-reviewer[bot]' }, state: 'APPROVED', commit_id: HEAD,
      body: `Approve.\n\n<!-- reviewed: sha=${OLD} run=5 supersedes=76 -->`,
    }];
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  "pr view"*)           printf '%s' '${JSON.stringify(meta)}' ;;
  *"/files"*)           printf '%s\\n' 'src/a.ts' ;;
  *"/reviews"*)         printf '%s' '${JSON.stringify(reviews)}' ;;
  *"issues?per_page"*)  printf '%s' '0' ;;
  "run list"*)          printf '%s' '[]' ;;
esac
`);
    const read = readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(read.reviews[0].reviewedSha).toBe(OLD);
    expect(read.reviews[0].supersedes).toEqual(['76']);
    expect(read.reviews[0].id).toBe(77);
    expect(mergeVerdict(read).rule).toBe('review-misattributed');
  });
});

describe('two verdicts on one commit must not be decided by ordering (RA-1334)', () => {
  /**
   * On PR RA-1324 head `dabe9a6`, `example-reviewer[bot]` submitted an `APPROVED` and
   * a `CHANGES_REQUESTED` at the IDENTICAL timestamp, from two runs that reached the
   * same conclusions on the prior findings and diverged on whether two remaining
   * fold-ins block. The prior SHA carried the same pair three minutes apart, and the
   * author recorded it in the next commit message: "The approval that landed three
   * minutes later raced that review and did not address either [finding]." One of that
   * pair's findings became RA-1332; the other was nearly lost.
   *
   * `gh run list --workflow=agent-review.yml` shows ONE run on that SHA, so the sibling
   * was out of band — which is why a workflow concurrency group fixes nothing, and why
   * the discriminator has to be something a run WRITES rather than something Actions
   * knows.
   */
  const reviewer = 'example-reviewer[bot]';

  it('refuses to merge on an approval that says nothing about a blocking sibling', () => {
    const v = mergeVerdict(pr({
      reviews: [
        { id: 21, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer },
        { id: 22, state: 'APPROVED', sha: HEAD, author: reviewer },
      ],
    }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('contradictory-verdicts');
    // A human has to read BOTH bodies — that is how RA-1324's second finding survived —
    // so the message has to name the review nobody answered.
    expect(v.why).toContain('#21');
  });

  it('merges when the approval names the blocking review it supersedes', () => {
    // The RA-1351 re-review. A CI run only reaches the review job past the
    // `already reviewed <sha>` skip, so a same-SHA re-review from the workflow is the
    // deliberate kind and the job records what it replaces.
    expect(mergeVerdict(pr({
      reviews: [
        { id: 21, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer },
        { id: 22, state: 'APPROVED', sha: HEAD, author: reviewer, supersedes: ['21'] },
      ],
    })).action).toBe('merge');
  });

  it('reproduces PR RA-1708: an approval last would have merged over two blocking reviews', () => {
    // MEASURED, 2026-09-07, head `76a6a18` on PR RA-1708 (not one of ours). SIX
    // `agent-review` runs dispatched within four seconds; the concurrency group killed
    // four, and the two survivors had different ACTORS — the Implementer's labels at creation,
    // then `example-merger[bot]` two minutes later — so nothing collapsed them.
    // Between them they posted THREE events on one commit:
    //
    //   11:36:31  APPROVED           id 5131526289
    //   11:37:47  CHANGES_REQUESTED  id 5131535858
    //   11:40:25  CHANGES_REQUESTED  id 5131555649
    //
    // As it arrived, the blocking verdict is last and this file already declines. The
    // case that matters is the same set in the other order, which is a scheduling
    // accident away — and which used to merge.
    const asArrived = mergeVerdict(pr({
      reviews: [
        { id: 5131526289, state: 'APPROVED', sha: HEAD, author: reviewer },
        { id: 5131535858, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer },
        { id: 5131555649, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer },
      ],
    }));
    expect(asArrived.action).not.toBe('merge');
    const approvalLast = mergeVerdict(pr({
      reviews: [
        { id: 5131535858, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer },
        { id: 5131555649, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer },
        { id: 5131526289, state: 'APPROVED', sha: HEAD, author: reviewer },
      ],
    }));
    expect(approvalLast.rule).toBe('contradictory-verdicts');
    expect(approvalLast.why, 'both blocking reviews must be named').toContain('#5131535858');
    expect(approvalLast.why).toContain('#5131555649');
  });

  it('lets ONE run correct itself — that is not two runs disagreeing', () => {
    // He does this explicitly: "Correcting myself first. I approved this at 14:57 on
    // what I believed was the head" (PR RA-1652). A run that posts a request-changes and
    // then an approval read the earlier one by construction — it wrote it — and no
    // concurrency key can reach the case, so the run id is the only thing that says so.
    expect(mergeVerdict(pr({
      reviews: [
        { id: 21, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer, runId: '900' },
        { id: 22, state: 'APPROVED', sha: HEAD, author: reviewer, runId: '900' },
      ],
    })).action).toBe('merge');
  });

  it('does NOT let a DIFFERENT run\'s approval pass on the run id alone', () => {
    // NON-VACUITY on the rule above, and the PR RA-1708 shape exactly: two runs, two run
    // ids, no supersession claimed.
    expect(mergeVerdict(pr({
      reviews: [
        { id: 21, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer, runId: '900' },
        { id: 22, state: 'APPROVED', sha: HEAD, author: reviewer, runId: '901' },
      ],
    })).rule).toBe('contradictory-verdicts');
  });

  it('is not satisfied by superseding some OTHER review', () => {
    // The bound has to be the id, not the presence of a stamp: an approval that
    // supersedes a review on a different commit has still said nothing about this one.
    const v = mergeVerdict(pr({
      reviews: [
        { id: 21, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer },
        { id: 22, state: 'APPROVED', sha: HEAD, author: reviewer, supersedes: ['19'] },
      ],
    }));
    expect(v.rule).toBe('contradictory-verdicts');
  });

  it('leaves a lone changes-request to the implementer, silently, as before', () => {
    // NON-VACUITY: the new rule must not turn the pipeline's most common state into an
    // escalation. Requested changes are the pipeline working, and a surface that cries
    // about normal progress is one the developer stops reading.
    const v = mergeVerdict(pr({
      reviews: [{ id: 21, state: 'CHANGES_REQUESTED', sha: HEAD, author: reviewer }],
    }));
    expect(v.rule).toBe('changes-requested');
    expect(v.quiet).toBe(true);
  });

  it('ignores a contradiction on a commit that is no longer the head', () => {
    // Only the CURRENT head's verdicts are evidence about the merge. A pair on an older
    // commit is history.
    const v = mergeVerdict(pr({
      reviews: [
        { id: 21, state: 'CHANGES_REQUESTED', sha: OLD, author: reviewer },
        { id: 22, state: 'APPROVED', sha: OLD, author: reviewer },
        { id: 23, state: 'APPROVED', sha: HEAD, author: reviewer },
      ],
    }));
    expect(v.action).toBe('merge');
  });
});

describe('the file list the path rules are applied to', () => {
  /**
   * `gh pr view --json files` is hard-capped at `files(first: 100)` with no pagination
   * and no truncation signal. On a PR of more than 100 files, any `drizzle/`,
   * `src/db/`, `.github/` or payments file sorting past position 100 is invisible to
   * ESCALATE_PATHS — and the verdict still reads "no escalating path". A guard that
   * keeps a human in front of schema and migration changes would be off, silently.
   *
   * This runs `readPr` against a stubbed `gh` on PATH, so it asserts the call that is
   * actually made rather than the source that makes it.
   */
  const withStubbedGh = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-gate-'));
    const meta = {
      number: 1234, author: { login: 'example-implementer[bot]' }, state: 'OPEN', isDraft: false,
      labels: [{ name: 'agent:implement' }], headRefOid: 'a'.repeat(40),
      statusCheckRollup: [], mergeStateStatus: 'CLEAN', title: 't', body: 'Closes #1',
      closingIssuesReferences: [{ number: 1 }], commits: [{ messageHeadline: 'x', messageBody: '' }],
    };
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
# Record every invocation so the test can assert on the ARGUMENTS, not just the result.
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
  "pr view"*)           printf '%s' '${JSON.stringify(meta)}' ;;
  *"/files"*)           printf '%s\\n' ${files.map((f) => `'${f}'`).join(' ')} ;;
  *"/reviews"*)         printf '%s' '[]' ;;
  *"issues?per_page"*)  printf '%s' '0' ;;
  "run list"*)          printf '%s' '[]' ;;
esac
`);
    const pr = readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    return { pr, calls: readFileSync(join(dir, 'calls'), 'utf8') };
  };

  it('reads files from the PAGINATED endpoint, not the 100-capped one', () => {
    const { calls } = withStubbedGh(['src/a.ts']);
    const filesCall = calls.split('\n').find((c) => c.includes('/files'));
    expect(filesCall, 'no call to the files endpoint at all').toBeTruthy();
    expect(filesCall).toContain('--paginate');
    // The capped form must not be how files are obtained.
    expect(calls).not.toMatch(/pr view.*--json[^\n]*\bfiles\b/);
  });

  it('sees a file past position 100, which the capped form cannot', () => {
    const many = [...Array.from({ length: 120 }, (_, i) => `src/app/f${i}.tsx`), 'migrations/0001_init.sql'];
    const { pr } = withStubbedGh(many);
    expect(pr.files).toHaveLength(121);
    expect(mergeVerdict(pr).rule).toBe('escalating-path');
  });
});

describe('the merge is not trusted to have closed what it declared', () => {
  /**
   * MEASURED on RA-1057, the Merger's first real merge. The PR declared `Closes RA-1049`,
   * GitHub linked it, the merge succeeded — and RA-1049 stayed OPEN with no `closed`
   * event. The same PRs merged by a human do produce one, attributed to the merger:
   * GitHub performs the auto-close AS THE MERGING ACTOR, so it needs `Issues: write`,
   * which this App was deliberately not granted.
   *
   * The permission set was derived from the calls the SCRIPT makes and so missed the
   * one the PLATFORM makes on its behalf — and that one fails silently. Every
   * autonomous merge would leave its issue open, rotting the milestone burndown and
   * `lead-reconcile.mjs`'s phase detection, which counts open issues.
   */
  // `states` may be a SEQUENCE per issue, so a close that merely arrives LATE can be
  // distinguished from one that never arrives — which is the whole point of the retry.
  const run = (states: Record<number, string | string[]>, opts = {}, commentFails = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-closed-'));
    const arms = Object.entries(states).map(([n, st]) => {
      const seq = Array.isArray(st) ? st : [st];
      // Each read advances a per-issue counter, so the stub can answer differently on
      // the second look without the test knowing how many reads happen in between.
      return `  *"issues/${n}"*)
    C=$(cat "${dir}/n${n}" 2>/dev/null || echo 0); echo $((C+1)) > "${dir}/n${n}"
    case "$C" in
${seq.map((v, i) => `      ${i === seq.length - 1 ? '*' : i}) printf '%s' '${v}' ;;`).join('\n')}
    esac ;;`;
    });
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
${arms.join('\n')}
${commentFails ? '  *"pr comment"*) exit 1 ;;' : ''}
esac
`);
    const said: string[] = [];
    const slept: number[] = [];
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    try {
      verifyClosed(
        { number: 7, closing: { willClose: Object.keys(states).map(Number) } },
        'o/r',
        (m: string) => said.push(m),
        { waitMs: 1, sleep: (ms: number) => { slept.push(ms); }, ...opts },
      );
    } finally {
      process.env.PATH = prev;
    }
    return { said, slept, calls: readFileSync(join(dir, 'calls'), 'utf8') };
  };

  it('says nothing when the declared issue really closed', () => {
    const { said, calls } = run({ 1049: 'closed' });
    expect(said).toEqual(['closed #1049']);
    expect(calls).not.toContain('pr comment');
  });

  it('reports on the PR when the merge left the issue open', () => {
    const { said, calls } = run({ 1049: 'open' });
    expect(said[0]).toContain('did not close');
    expect(calls).toContain('pr comment');
    expect(calls).toContain('Issues: write');
  });

  it('treats an unreadable issue as not closed, since reporting it is the point', () => {
    const { said } = run({ 1049: '' });
    expect(said[0]).toContain('did not close');
  });

  it('re-reads a close that is merely LATE, instead of crying wolf', () => {
    // `gh pr merge` returns once the merge commit exists; GitHub performs the
    // linked-issue close downstream in its push processing. An immediate read can
    // therefore catch a close that has not landed YET — and with the scope correctly
    // granted that produced "grant the scope", telling the developer to fix something
    // already fixed, on the surface this design cannot afford to make noisy.
    const { said, calls, slept } = run({ 1049: ['open', 'closed'] });
    expect(said).toEqual(['closed #1049']);
    expect(calls).not.toContain('pr comment');
    expect(slept.length, 'it did not actually wait before re-reading').toBeGreaterThan(0);
  });

  it('does not wait at all when the close already landed', () => {
    // The common case must cost nothing; only a genuine miss pays for the retry.
    const { slept } = run({ 1049: 'closed' });
    expect(slept).toEqual([]);
  });

  it('still reports when the close never arrives, after exhausting the retries', () => {
    const { said, calls } = run({ 1049: 'open' });
    expect(said[0]).toContain('did not close');
    expect(calls).toContain('Issues: write');
  });

  it('records the miss even when it cannot comment about it', () => {
    // The only call site that can throw AFTER a merge. Unguarded, it ends the tick
    // with the merge done and nothing recorded — the worst combination available.
    //
    // THE STUB MUST ACTUALLY FAIL. The first version of this test had no `pr comment`
    // arm, so the `case` fell through, the script exited 0, and the `catch` was never
    // entered — the assertion passed on the UNGUARDED code too. Verified by mutation:
    // with the try/catch deleted this file was 47/47 green. Same vacuous-test class as
    // the review-filter test three files over, in the commit that fixed that one.
    const { said } = run({ 1049: 'open' }, { retries: 0 }, true);
    expect(said.some((m) => m.includes('did not close'))).toBe(true);
    expect(said.some((m) => m.includes('could not comment about the unclosed issue')),
      'the catch was never entered — the guard is untested').toBe(true);
  });
});

describe('an escalation announces itself once, not once per rule', () => {
  it('refuses on needs:human but stays quiet, since the Merger applied it', () => {
    // Adding `needs:human` to ESCALATE_LABELS means an already-escalated PR matches
    // HERE on the next sweep rather than on its original rule — a different rule means
    // a different marker means a SECOND comment, saying only that the PR carries the
    // label the Merger just put on it. The refusal must stand; the announcement is noise,
    // and this surface only works while every message on it means something.
    const v = mergeVerdict(pr({ labels: ['agent:implement', 'needs:human'] }));
    expect(v.action).toBe('escalate');
    expect(v.quiet).toBe(true);
  });

  it('speaks up when a REAL escalating label is also present', () => {
    const v = mergeVerdict(pr({ labels: ['agent:implement', 'needs:human', 'sev:critical'] }));
    expect(v.action).toBe('escalate');
    expect(v.quiet).toBe(false);
    expect(v.why).toContain('sev:critical');
    expect(v.why).not.toContain('needs:human');
  });

  it('speaks up for a human-applied blocker on its own', () => {
    const v = mergeVerdict(pr({ labels: ['agent:implement', 'blocked'] }));
    expect(v.quiet).toBe(false);
  });

  it('announces a NEW reason that appears after the label is already on', () => {
    // The sticky label used to be matched FIRST, so it swallowed every later
    // escalation: a commit that newly touched `drizzle/` was absorbed into the quiet
    // arm and never announced. A new reason must still be a new announcement.
    const v = mergeVerdict(pr({ labels: ['agent:implement', 'needs:human'], files: ['migrations/0003_x.sql'] }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('escalating-path');
    expect(v.quiet).toBe(false);
  });
});

describe('zero checks is not "everything passed" (RA-1147)', () => {
  /**
   * Every check gate in `mergeVerdict` is an `Array.prototype.filter`, and every one
   * returns empty for an empty input — so a PR on which NOTHING ran fell through the
   * whole section as though it were green. Nothing merged that way only because the
   * ruleset's eight required contexts leave such a PR `BLOCKED`, never `CLEAN`. The
   * safety was GitHub's; this file agreed.
   *
   * The reachable shape is PR RA-1143. GitHub cannot build `refs/pull/N/merge` for a
   * CONFLICTING PR and dispatches `pull_request` workflows against that ref, so a PR
   * conflicting at open never runs CI — zero runs, ever.
   *
   * EVERY FIXTURE HERE SETS `reviews: []`, AND THAT IS THE POINT. The first version of
   * this block sat below the review test, where `no-review-on-head` returns first, so
   * `never-started` was unreachable for the only case it exists for. The tests passed
   * because the shared fixture defaults an APPROVED review on head — so each one
   * asserted about a PR holding an approval the scenario cannot produce (no CI -> no
   * The Reviewer -> no review). Reviewer-caught on RA-1154. Restore the old ordering and every
   * case below fails, which is the property that was missing.
   */
  const unstarted = (over: Record<string, unknown> = {}) =>
    pr({ reviews: [], checks: [], mergeStateStatus: 'DIRTY', ...over });

  it('hands a conflicting PR that never started to the rebase lane first (RA-2218)', () => {
    // "No CI has run on this head at all" IS the un-startable state, and it is the
    // population `agent-rebase.yml` was built for — so this arm arbitrates exactly as
    // the ruleset arm does. It used to escalate unconditionally, which disqualified the
    // lane from precisely its own PRs.
    const v = mergeVerdict(unstarted());
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('never-started-rebasing');
  });

  it('escalates once the lane has tried this head, with no review in existence', () => {
    // The state a human genuinely owns. `quiet: false` because RA-1147's whole point is
    // that an un-startable PR must announce itself — once nothing else is coming.
    const v = mergeVerdict(unstarted({ rebaseAttempted: true }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('never-started');
    expect(v.quiet).toBe(false);
    expect(v.why).toMatch(/already attempted this head/);
  });

  it('escalates when it could not read whether the lane tried', () => {
    const v = mergeVerdict(unstarted({ rebaseAttempted: null }));
    expect(v.action).toBe('escalate');
    expect(v.why).toMatch(/could not be read/);
  });

  it('does not divert it to a re-review request, which reads as progress', () => {
    // The regression: `recover('no-review-on-head')` posts "the Merger asked
    // agent-review.yml to re-review this commit", applies no `needs:human`, and fires
    // once because its marker is keyed on the head SHA. A stall rendered as handling.
    const v = mergeVerdict(unstarted());
    expect(v.action).not.toBe('recover');
    expect(v.rule).not.toBe('no-review-on-head');
  });

  it('carries the shared sentence VERBATIM rather than restating it (RA-2154)', () => {
    // This message used to say "it needs a rebase from a human; nothing in the pipeline
    // will do it", in the Merger's own words. Two costs: `agent-rebase.yml` now does do it
    // for an eligible PR, so the claim went false, and a second copy of a sentence can
    // drift from the first while both still agree logically. Interpolating the shared
    // constant makes both impossible at once.
    // Asserted on the ESCALATING arm, which is the one that carries this gate's own
    // fact; the waiting arm carries the shared sentence too, pinned below.
    const v = mergeVerdict(unstarted({ rebaseAttempted: true }));
    expect(v.why).toContain(CONFLICT_WHY);
    expect(v.why).toMatch(/no CI has run on this head at all/);
    expect(v.why).not.toMatch(/nothing in the pipeline/i);
    expect(mergeVerdict(unstarted()).why, 'and so does the wait').toContain(CONFLICT_WHY);
  });

  it('asks the SHARED definition, so a stale `mergeStateStatus` cannot split it (RA-2154)', () => {
    // The divergence RA-2154 was filed for: this gate read only `mergeStateStatus`, so on
    // a PR GitHub reports as CLEAN-but-CONFLICTING the five reconciler lanes said
    // "blocked on a rebase" and the Merger read CLEAN and proceeded toward `merge`.
    // Either verdict of this arm proves the point — what RA-2154 is about is that the
    // stale-field case REACHES it at all rather than falling through to `no-checks-yet`.
    const v = mergeVerdict(unstarted({ mergeStateStatus: 'CLEAN', mergeable: 'CONFLICTING' }));
    expect(v.rule).toMatch(/^never-started/);
  });

  it('still lets a merely-early PR wait, rather than escalating it', () => {
    // The control, and the direction that matters: `computing` must not become a stop.
    // `merge-gate.mjs` already waits on `UNKNOWN` further down, and a conflict branch
    // that fired on it would escalate a PR that is simply mid-flight.
    const v = mergeVerdict(unstarted({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }));
    expect(v.rule).not.toMatch(/^never-started/);
  });

  it('is not fooled by the reviewer\'s own check run being present', () => {
    // `Review (the Reviewer)` exists the instant the Reviewer starts. Keying the gate on
    // `pr.checks` rather than `relevant` let one SELF_CHECKS entry miss the gate and
    // drop through to a wait that announces nothing.
    const v = mergeVerdict(unstarted({
      checks: [{ name: 'Review (Reviewer)', workflowName: 'Review (Reviewer)', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }));
    // Either verdict proves the SELF_CHECKS filtering reached this arm (RA-2218 split it).
    expect(v.rule).toMatch(/^never-started/);
  });

  it('does NOT confuse it with an ordinary conflict, which the rebase lane owns', () => {
    // A conflicting PR whose CI ran is the normal case, and since RA-2218 it is the rebase
    // lane's rather than a human's until that lane has tried. Still a different rule
    // from `never-started`, which is the distinction this block is about.
    const v = mergeVerdict(pr({ mergeStateStatus: 'DIRTY' }));
    expect(v.rule).toBe('merge-state-rebasing');
    expect(v.rule).not.toBe('never-started');
  });

  it('WAITS rather than escalating when a fresh PR has no checks yet', () => {
    const v = mergeVerdict(unstarted({ mergeStateStatus: 'BLOCKED' }));
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('no-checks-yet');
  });

  it('names the checks it did see, so the wait never claims nothing ran', () => {
    const v = mergeVerdict(unstarted({
      mergeStateStatus: 'BLOCKED',
      checks: [{ name: 'Review (Reviewer)', workflowName: 'Review (Reviewer)', status: 'IN_PROGRESS', conclusion: null }],
    }));
    expect(v.rule).toBe('no-checks-yet');
    expect(v.why).toContain('Review (Reviewer)');
  });

  it('never reaches `merge` on an empty check list, whatever the merge state says', () => {
    for (const mergeStateStatus of ['CLEAN', 'BLOCKED', 'DIRTY', 'UNKNOWN']) {
      expect(mergeVerdict(pr({ checks: [], mergeStateStatus })).action).not.toBe('merge');
    }
  });
});

describe('a quiet escalation refuses without announcing', () => {
  // The verdict carrying `quiet` is only half the fix; `apply` has to honour it.
  // Asserted separately because a flag nothing reads is the same as no flag — and a
  // mutation that ignored it passed every other test in this file.
  const applyWith = (verdict: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-quiet-'));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
`);
    const said: string[] = [];
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    try {
      apply({ number: 7, headSha: HEAD }, verdict, 'o/r', { dryRun: false });
    } finally {
      process.env.PATH = prev;
    }
    let calls: string;
    try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch { calls = ''; }
    return { said, calls };
  };

  it('posts nothing and applies no label for a quiet escalation', () => {
    const { calls } = applyWith({ action: 'escalate', rule: 'escalating-label', quiet: true, why: 'already escalated' });
    expect(calls).not.toContain('pr comment');
    expect(calls).not.toContain('add-label');
  });

  it('still comments and labels for a loud one', () => {
    const { calls } = applyWith({ action: 'escalate', rule: 'escalating-path', quiet: false, why: 'touches .github/' });
    expect(calls).toContain('pr comment');
    expect(calls).toContain('needs:human');
  });
});

describe('the sweep summary shows the skip distribution (RA-1201)', () => {
  // A skip is invisible on every surface a human reads: `skip()` sets `quiet`, so
  // nothing is posted on the PR, and the summary counted only merges and escalations.
  // So a sweep that declined most of the open PRs on ONE wrong rule read exactly like
  // a sweep with nothing to do — which is why RA-1188's rule sat wrong for days.
  const sum = (o: Record<string, number>) => skipSummary(new Map(Object.entries(o)));

  it('says nothing when nothing was skipped', () => {
    expect(sum({})).toEqual([]);
  });

  it('folds the rules that legitimately dominate into one line', () => {
    // Most open PRs are not the Merger's. A flat histogram would bury a real spike under
    // these, which is the noise failure the issue warns about — a summary nobody reads
    // is the state being fixed.
    const out = sum({ 'not-the-implementer': 11, 'not-open': 3 });
    expect(out).toEqual([
      '- skipped: 14',
      "  - not the Merger's to merge (not-the-implementer / not-open / draft): 14",
    ]);
  });

  it('makes the RA-1188 shape visible as a spike against a rule name', () => {
    // The measured case: 9 of ~20 skipped on one rule, several approved and CLEAN for
    // days, and the summary read `merged: 0`, `waiting on you: 0`.
    const out = sum({ 'not-the-implementer': 8, 'not-implementer-label': 9, 'changes-requested': 2 });
    expect(out).toContain('  - not-implementer-label: 9');
    expect(out[0]).toBe('- skipped: 19');
    // ordered by count, so the spike is the first notable line
    expect(out[2]).toBe('  - not-implementer-label: 9');
  });

  it('counts every skip exactly once', () => {
    // The total and the buckets must agree, or the line is worse than absent.
    const counts = { 'not-the-implementer': 4, 'not-open': 1, 'not-implementer-label': 2, 'changes-requested': 3 };
    const out = sum(counts);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(out[0]).toBe(`- skipped: ${total}`);
    const bucketed = out.slice(1).map((l: LibraryValue) => Number(l.split(': ').at(-1))).reduce((a: LibraryValue, b: LibraryValue) => a + b, 0);
    expect(bucketed, 'buckets must sum to the total').toBe(total);
  });
});

/**
 * RA-1892 — a check that FAILED and was re-run to SUCCESS on the SAME head SHA must not
 * refuse forever.
 *
 * A concluded check run stays in `statusCheckRollup` permanently, so `failed` kept the
 * stale FAILURE while GitHub's own ruleset — which takes the latest run per name — was
 * satisfied. Measured on PR RA-1885 head `28b64ff`: `check` concluded FAILURE at
 * 18:11:46Z and SUCCESS at 18:12:15Z.
 *
 * The path is routine rather than exotic, which is what makes it worth fixing:
 * `closing-refs.mjs`'s own remediation and `reviewer-playbook.md` (RA-1351) both say a
 * body-edit finding is fixed by editing the body, which re-fires on
 * `pull_request: edited` with NO new commit. The prescribed fix for that whole class of
 * finding is exactly what produces this state.
 *
 * The risk being guarded against is the opposite error: excusing a check that genuinely
 * failed. Most of what is held here is that.
 */
const at = (iso: string) => ({ startedAt: iso, completedAt: iso });

describe('RA-1892 — supersede applies to any conclusion, not just CANCELLED', () => {
  it('merges when a FAILURE was re-run to SUCCESS on the same SHA', () => {
    // The exact PR RA-1885 shape. Before the fix this returned `checks-failed` forever,
    // and no action on the same commit could clear it.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-14T18:11:46Z') },
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-14T18:12:15Z') },
      ],
    }));
    expect(v.action, 'every required check is green on GitHub; this must merge').toBe('merge');
  });

  it('STILL REFUSES when the newest run is the failing one', () => {
    // The direction that must not break. A check that passed and was then re-run to
    // FAILURE is a real failure, and ordering must not excuse it just because an older
    // SUCCESS exists for the same key.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-14T18:11:46Z') },
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-14T18:12:15Z') },
      ],
    }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('checks-failed');
  });

  it('orders by databaseId when no timestamp survives the projection', () => {
    // A DOCUMENTED FALLBACK THAT THE ONLY PRODUCTION CALLER CANNOT REACH (RA-1965 review).
    // Measured from CI: gh's projection carries `startedAt`/`completedAt` but NOT
    // `databaseId`, so `readPr` always maps it to `undefined`. This asserts the rung
    // works for a direct caller; it is not evidence about the sweep's behaviour.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 100 },
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'SUCCESS', databaseId: 200 },
      ],
    }));
    expect(v.action).toBe('merge');
  });

  it('DEGRADES to the CANCELLED-only rule when nothing can order the entries', () => {
    // The authoring environment cannot read the Checks API (403 for a personal token),
    // so whether gh carries the timestamps through is unverified. With no discriminator
    // the rule must narrow to its pre-RA-1892 behaviour — a false refusal a no-op push
    // clears — never widen into excusing a failure.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }));
    expect(v.action, 'conservative refusal, not a silent merge').toBe('escalate');
    expect(v.rule).toBe('checks-failed');
  });

  it('does not let one workflow\'s re-run excuse another workflow\'s failure', () => {
    // `key()` is `workflowName/name` because job ids are not unique across this repo's
    // workflows — three of them define a `filter` job. Ordering must not erode that.
    // NOTE the workflows here must be outside SELF_CHECKS and REVIEW_EVENT_CHECKS: naming
    // an excluded workflow filters it out of `relevant` entirely and the assertion tests
    // nothing about the supersede rule. (This used the two review-event `filter` jobs until
    // RA-1177 excluded them; the shared job name is what matters, so two guards stand in.)
    const v = mergeVerdict(pr({
      checks: [
        { name: 'filter', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-14T18:11:46Z') },
        { name: 'filter', workflowName: 'Label guard', status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-14T18:12:15Z') },
      ],
    }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('checks-failed');
  });

  it('keeps both when two runs share a stamp, rather than picking arbitrarily', () => {
    // Equal stamps are not evidence about each other, so neither supersedes — and the
    // FAILURE still refuses. Guards against a `<=` that would silently drop one.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-14T18:12:15Z') },
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-14T18:12:15Z') },
      ],
    }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('checks-failed');
  });

  it('does NOT let a later SKIPPED dispatch excuse a real FAILURE', () => {
    // RA-1965 review — the hole the first cut of this rule opened, and it is the shape of
    // EVERY agent PR rather than a corner. `red-test.yml` narrows by label at the JOB
    // level, not in its trigger, so a label event dispatches the workflow and registers
    // a SKIPPED check run. The Reviewer applies `agent:reviewer` mid-review, AFTER the real
    // run concluded, so the SKIPPED is always the newest entry for that key.
    //
    // Real rollup from PR RA-1929, with the middle conclusion flipped to the one the job
    // exists to produce. `Red-test verification` is deliberately NOT a required context
    // (`red-test.yml:21-23`), so this partition is the ONLY thing that blocks on it —
    // superseding here merges over a red red-test silently.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'verify', workflowName: 'Red-test verification', status: 'COMPLETED', conclusion: 'CANCELLED', ...at('2026-09-16T13:25:29Z') },
        { name: 'verify', workflowName: 'Red-test verification', status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-16T13:26:37Z') },
        { name: 'verify', workflowName: 'Red-test verification', status: 'COMPLETED', conclusion: 'SKIPPED', ...at('2026-09-16T13:38:05Z') },
        { name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-16T13:30:00Z') },
      ],
    }));
    expect(v.action, 'a red red-test must still block the merge').toBe('escalate');
    expect(v.rule).toBe('checks-failed');
  });

  it('does not let a later CANCELLED casualty excuse a real FAILURE either', () => {
    // Same argument, other non-conclusive value: a cancelled run is a casualty, not a
    // verdict, so it is not evidence about a sibling that actually ran.
    const v = mergeVerdict(pr({
      checks: [
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-14T18:11:46Z') },
        { name: 'check', workflowName: 'Closing references', status: 'COMPLETED', conclusion: 'CANCELLED', ...at('2026-09-14T18:12:15Z') },
      ],
    }));
    expect(v.action).toBe('escalate');
  });

  it('still supersedes a CANCELLED casualty that carries no stamp (RA-1168 unbroken)', () => {
    const v = mergeVerdict(pr({
      checks: [
        { name: 'Red-test verification', workflowName: 'Red-test', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { name: 'Red-test verification', workflowName: 'Red-test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }));
    expect(v.action).toBe('merge');
  });
});

describe('one PR must not end the sweep (RA-2175)', () => {
  /**
   * The failure this guards is not a bad merge — it is the PRs that were never looked
   * at. `apply` calls `gh pr merge` through `execFileSync`, so a 405 ("Pull Request is
   * not mergeable") throws; before this the throw reached `main().catch`, exited 1, and
   * every later PR in the sweep's list went unconsidered on that tick — hourly, until a
   * human resolved the conflict, with a red run as the only signal.
   *
   * The conflict branch in `mergeVerdict` now stops that particular 405 from being
   * reachable. This is the other half, and it is the durable one: a guard on one
   * predicate does not stop the next unguarded `gh` call from ending a sweep.
   */
  const ok = (rule = 'green-zone', action = 'merge') => ({ action, rule, why: '', quiet: false });

  it('considers every later PR after one throws', () => {
    const seen: string[] = [];
    const out = sweep(['1', '2', '3'], {
      consider: (n: string) => {
        seen.push(n);
        if (n === '2') throw new Error('HTTP 405: Pull Request is not mergeable');
        return ok();
      },
    });
    expect(seen, 'every PR reached the body').toEqual(['1', '2', '3']);
    expect(out.merged, 'and the survivors still got their verdicts').toBe(2);
  });

  it('names the PR and the reason rather than counting failures', () => {
    // "1 failed" sends a reader to the whole log; the number and the first line of the
    // error send them to the one PR.
    const out = sweep(['7'], { consider: () => { throw new Error('HTTP 405: not mergeable'); } });
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toContain('#7');
    expect(out.failed[0]).toContain('405');
  });

  it('collects the failure so the caller can still go red', () => {
    // A `try` that let the run exit 0 would turn a broken sweep into a silent one,
    // which is the trade this pipeline never makes. `main` re-throws on a non-empty
    // `failed`, AFTER the summary is written.
    const src = readFileSync(join(ROOT, 'scripts/merge-gate.mjs'), 'utf8');
    const tail = src.slice(src.indexOf('async function main() {'));
    expect(tail, 'main re-throws when any PR could not be considered').toMatch(/if \(failed\.length\) \{\s*\n\s*throw new Error/);
    // And it does so after the step summary, or the named failures never reach a reader.
    expect(tail.indexOf('GITHUB_STEP_SUMMARY')).toBeLessThan(tail.indexOf('if (failed.length)'));
  });

  it('reports a clean sweep as a clean sweep', () => {
    const out = sweep(['1', '2'], { consider: () => ok('no-review-on-head', 'skip') });
    expect(out.failed).toEqual([]);
    expect(out.skips.get('no-review-on-head')).toBe(2);
  });

  it('survives an empty or absent list rather than throwing on it', () => {
    expect(sweep([], { consider: () => ok() }).merged).toBe(0);
    expect(sweep(undefined as never, { consider: () => ok() }).failed).toEqual([]);
  });
});

describe('who owns a conflicting PR — the Merger or the rebase lane (RA-2218)', () => {
  /**
   * Escalating a conflict used to switch off the only thing that fixes it. `apply()`
   * turns every `escalate` into `--add-label needs:human`, and `rebase-lane.mjs`'s
   * `ineligible()` refuses any PR carrying it — first in its ordered list. Because
   * `needs:human` is in `ESCALATE_LABELS`, the quiet `escalating-label` arm then returns
   * before every other gate, so nothing re-admits the PR: not a new head, not a
   * resolution. Both lanes fire on the same `workflow_run: CI/main`, and the Merger's extra
   * hourly cron meant he usually got there first.
   *
   * The arbitration is derived from the lane's own predicate plus its own marker, so
   * the two cannot disagree about who is acting.
   */
  const conflicting = (over: Record<string, unknown> = {}) =>
    pr({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', ...over });

  it('WAITS — no label, no comment — while the lane owns it and has not tried', () => {
    // `apply` does nothing at all on a `wait`, which is the whole point: the label stays
    // clean, so the lane stays eligible. It is not silence either — the lane posts its
    // own "Resolving this conflict" comment before its session.
    const v = mergeVerdict(conflicting({ rebaseAttempted: false }));
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('merge-state-rebasing');
    expect(v.why).toContain('RA-2218');
  });

  it('escalates once the lane has tried this head and it still conflicts', () => {
    // Without this the PR waits forever on a lane that has already failed at it.
    const v = mergeVerdict(conflicting({ rebaseAttempted: true }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('merge-state');
    expect(v.why).toMatch(/already attempted this head/);
  });

  it('escalates when it could not read whether the lane tried', () => {
    // Fail toward telling a human: a stall nobody is told about is worse than an
    // escalation that turns out to be early. A boolean would have made this
    // indistinguishable from "not tried yet" and waited forever.
    const v = mergeVerdict(conflicting({ rebaseAttempted: null }));
    expect(v.action).toBe('escalate');
    expect(v.why).toMatch(/could not be read/);
  });

  it.each([
    ['a human\'s branch', { author: 'some-person' }, 'not-the-implementer'],
    ['a draft', { isDraft: true }, 'draft'],
    ['a PR no lane is waiting on', { labels: ['documentation'] }, 'not-implementer-label'],
    ['one a human already owns', { labels: ['agent:implement', 'needs:human'] }, 'escalating-label'],
  ])('never reaches the wait arm for %s — this function declines it first', (_l, over, rule) => {
    // THE PARITY THAT REPLACES A RUNTIME CHECK. A "would the lane take it?" branch was
    // written here and deleted as unreachable: every refusal in `ineligible()` is also a
    // gate `mergeVerdict` returns at, earlier. These pin that, so the day the two rule
    // sets diverge — `mergeVerdict` admitting a PR the lane refuses, which would wait
    // forever — is a red test rather than a PR nobody ever looks at again.
    const v = mergeVerdict(conflicting({ rebaseAttempted: false, ...over }));
    expect(v.rule).toBe(rule);
    expect(v.rule).not.toBe('merge-state-rebasing');
  });

  it('keeps the two rule sets in the only relation that is safe', () => {
    // `mergeVerdict` must admit a SUBSET of what the lane accepts. Equal is fine; wider
    // is the failure above. Asserted on the constants, because the per-case tests above
    // cover today's shapes and this covers a label being added to either list.
    for (const l of IMPLEMENTER_LABELS) expect(LANE_LABELS).toContain(l);
    expect(LANE_IMPLEMENTER).toBe(MERGE_GATE_IMPLEMENTER);
  });

  it('READS the marker off the PR, and the wiring is exercised not asserted', () => {
    // The first version of this shipped with the read untested: swapping
    // `rebaseAttemptedOn(...)` for a hardcoded `false` passed the whole suite, because
    // every other test builds the `pr` object by hand. Driven here through the same
    // stubbed-`gh`-on-PATH harness `readPr`'s other tests use.
    const dir = mkdtempSync(join(tmpdir(), 'merger-rebase-'));
    const meta = {
      number: 1234, author: { login: 'example-implementer[bot]' }, state: 'OPEN', isDraft: false,
      labels: [{ name: 'agent:implement' }], headRefOid: HEAD, statusCheckRollup: [],
      title: 't', body: 'Closes #1', closingIssuesReferences: [{ number: 1 }],
      commits: [{ messageHeadline: 'x', messageBody: '' }],
      mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING',
    };
    const withComments = (bodies: string[]) => {
      writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *"--json comments"*)  printf '%s' ${JSON.stringify(bodies.join('\n'))} ;;
  "pr view"*)           printf '%s' '${JSON.stringify(meta)}' ;;
  *"/files"*)           printf '%s\\n' 'src/a.ts' ;;
  *"/reviews"*)         printf '%s' '[]' ;;
  *"issues?per_page"*)  printf '%s' '0' ;;
  "run list"*)          printf '%s' '[]' ;;
esac
`);
      return readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    };

    expect(withComments(['nothing here']).rebaseAttempted, 'no marker → not tried').toBe(false);
    expect(withComments([`<!-- rebase-lane:attempt:${HEAD.slice(0, 12)} -->`]).rebaseAttempted,
      'the lane\'s marker for THIS head → tried').toBe(true);
    // A marker for a DIFFERENT head is not this head's attempt — a push re-opens the lane.
    expect(withComments([`<!-- rebase-lane:attempt:${OLD.slice(0, 12)} -->`]).rebaseAttempted).toBe(false);
  });

  it('does not pay for the comments read on a PR that is not conflicting', () => {
    // One extra `gh pr view --json comments` per conflicting PR is affordable because
    // the population is tiny; one per PR per sweep is not. A stub that FAILS the
    // comments call proves the call is not made.
    const dir = mkdtempSync(join(tmpdir(), 'merger-clean-'));
    const meta = {
      number: 1234, author: { login: 'example-implementer[bot]' }, state: 'OPEN', isDraft: false,
      labels: [{ name: 'agent:implement' }], headRefOid: HEAD, statusCheckRollup: [],
      title: 't', body: 'Closes #1', closingIssuesReferences: [{ number: 1 }],
      commits: [{ messageHeadline: 'x', messageBody: '' }],
      mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
    };
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *"--json comments"*)  echo 'the comments read should not happen here' >&2; exit 1 ;;
  "pr view"*)           printf '%s' '${JSON.stringify(meta)}' ;;
  *"/files"*)           printf '%s\\n' 'src/a.ts' ;;
  *"/reviews"*)         printf '%s' '[]' ;;
  *"issues?per_page"*)  printf '%s' '0' ;;
  "run list"*)          printf '%s' '[]' ;;
esac
`);
    const read = readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(read.rebaseAttempted, 'answered without asking').toBe(false);
  });

  it('reads the lane\'s marker rather than re-spelling it', () => {
    // A second copy of "what an attempt looks like" is a copy that drifts; the same
    // argument that made `conflictState` shared.
    const src = readFileSync(join(ROOT, 'scripts/merge-gate.mjs'), 'utf8');
    expect(src).toMatch(/marker as rebaseMarker.*from '\.\/rebase-lane\.mjs'/);
    expect(src).toMatch(/rebaseMarker\(meta\.headRefOid\)/);
  });
});


describe('a workflow the head SHA made unloadable blocks the merge (RA-2222)', () => {
  /**
   * RECORDED, NOT SYNTHESISED. Run 35589620617 on `e6a35f69` — a caller job carrying
   * `${{ env.ISSUE_NUMBER }}`, a context that does not exist where a caller's inputs are
   * evaluated. GitHub refused to load the file, so it produced no job, so no check run,
   * so the PR's `statusCheckRollup` was GREEN with ten passing runs beside it while an
   * eleventh sat on the same SHA marked `failure`.
   *
   * That is the gap: every rule downstream reads the rollup, and the rollup cannot see a
   * workflow that never started.
   */
  const REAL_SHA_RUNS = [
    { name: 'Lead (Bezalel) — revise', conclusion: 'skipped' },
    { name: 'Red-test verification', conclusion: 'skipped' },
    { name: 'Review (Reviewer)', conclusion: 'success' },
    { name: 'CI', conclusion: 'success' },
    { name: 'Label guard', conclusion: 'success' },
    { name: 'Closing references', conclusion: 'success' },
    { name: 'Review (Reviewer)', conclusion: 'cancelled' },
    { name: 'PR Title Check', conclusion: 'success' },
    { name: '.github/workflows/agent-triage.yml', conclusion: 'failure' },
  ];

  it('picks the startup failure out of the ten legitimate runs beside it', () => {
    expect(startupFailuresIn(REAL_SHA_RUNS)).toEqual(['.github/workflows/agent-triage.yml']);
  });

  it('fires on nothing benign — a cancelled run and a dispatch carry workflow NAMES', () => {
    // NON-VACUITY IN THE OTHER DIRECTION, and the one that matters most: a gate refusing
    // on something benign is worse than the gap it closes. Measured over this repo's last
    // 300 runs, zero carry a path-shaped name, so the predicate is narrow by construction.
    expect(startupFailuresIn(REAL_SHA_RUNS.filter((r) => !r.name.startsWith('.github/')))).toEqual([]);
    expect(startupFailuresIn([{ name: 'CI', conclusion: 'failure' }])).toEqual([]);
    expect(startupFailuresIn([{ name: '.github/workflows/x.yml', conclusion: 'cancelled' }])).toEqual([]);
    expect(startupFailuresIn([])).toEqual([]);
    expect(startupFailuresIn()).toEqual([]);
  });

  it('escalates rather than merging, and names the file', () => {
    const v = mergeVerdict(pr({ workflowRuns: REAL_SHA_RUNS }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('workflow-startup-failure');
    expect(v.why).toContain('agent-triage.yml');
  });

  it('does not disturb a PR whose runs are all real', () => {
    const v = mergeVerdict(pr({ workflowRuns: REAL_SHA_RUNS.filter((r) => !r.name.startsWith('.github/')) }));
    expect(v.rule).not.toBe('workflow-startup-failure');
  });
});

/**
 * A stubbed `gh` on PATH for `readPr`, with per-endpoint overrides. Records every call so
 * a test asserts the ARGUMENTS actually passed, not the source that builds them — the
 * discipline the 100-file cap taught (see "the file list the path rules are applied to").
 */
const stubReadPr = (over: {
  meta?: Record<string, unknown>, runList?: string | null, events?: string | null, comments?: string | null,
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-gate-read-'));
  const meta = {
    number: 1234, author: { login: 'example-implementer[bot]' }, state: 'OPEN', isDraft: false,
    labels: [{ name: 'agent:implement' }], headRefOid: HEAD,
    statusCheckRollup: [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', title: 't', body: 'Closes #1',
    closingIssuesReferences: [{ number: 1 }], commits: [{ messageHeadline: 'x', messageBody: '' }],
    ...over.meta,
  };
  const reviews = [{ id: 1, user: { login: 'example-reviewer[bot]' }, state: 'APPROVED', commit_id: HEAD, body: 'ok' }];
  // `null` for an endpoint = that call FAILS (non-zero exit), which is the case under test.
  const arm = (pattern: string, out: string | null | undefined, dflt: string) =>
    out === null
      ? `  ${pattern}) echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1 ;;`
      : `  ${pattern}) cat <<'__OUT__'\n${out ?? dflt}\n__OUT__\n ;;`;
  writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
${arm('"run list"*', over.runList, '[]')}
${arm('*"/events"*', over.events, '')}
${arm('*"/1234/comments"*', over.comments, '')}
  "pr view"*)           printf '%s' '${JSON.stringify(meta)}' ;;
  *"/files"*)           printf '%s\\n' 'src/a.ts' ;;
  *"/reviews"*)         printf '%s' '${JSON.stringify(reviews)}' ;;
  *"issues?per_page"*)  printf '%s' '0' ;;
esac
`);
  const read = readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  let calls: string;
  try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch { calls = ''; }
  return { read, calls: calls.split('\n').filter(Boolean) };
};

describe('an unreadable Actions listing is not "no startup failure" (RA-2256)', () => {
  it('WAITS on a listing that could not be read, rather than merging', () => {
    // The pre-RA-2256 shape: a `catch` yielding `[]`, which `startupFailuresIn` reads as
    // "none", so a 403 silently switched the rule off and this PR merged.
    const v = mergeVerdict(pr({ workflowRuns: null }));
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('runs-unreadable');
  });

  it('treats an ABSENT field the same way — only an array was read', () => {
    const rest: Record<string, unknown> = { ...pr() };
    delete rest.workflowRuns;
    expect(mergeVerdict(rest as never).rule).toBe('runs-unreadable');
  });

  it('still merges on a listing that was read and is empty', () => {
    // Non-vacuity: the wait must be about the READ, not about emptiness.
    expect(mergeVerdict(pr({ workflowRuns: [] })).action).toBe('merge');
  });

  it('asks for THIS head, filtered to failures server-side', () => {
    const { calls } = stubReadPr();
    const runList = calls.filter((c) => c.startsWith('run list'));
    expect(runList, 'the listing was never made').toHaveLength(1);
    expect(runList[0]).toContain(`--commit ${HEAD}`);
    // `--status failure` removes the newest-first `--limit` truncation, which would drop
    // a startup failure first: it fires on push, so it is the OLDEST run on the head.
    expect(runList[0]).toContain('--status failure');
    expect(runList[0]).toContain('--json name,conclusion');
  });

  it('carries what the listing returned all the way to the verdict', () => {
    const { read } = stubReadPr({ runList: JSON.stringify([{ name: '.github/workflows/agent-triage.yml', conclusion: 'failure' }]) });
    expect(read.workflowRuns).toHaveLength(1);
    const v = mergeVerdict(read);
    expect(v.rule).toBe('workflow-startup-failure');
    expect(v.why).toContain('agent-triage.yml');
  });

  it('carries a FAILED listing as null, and the verdict waits', () => {
    const { read } = stubReadPr({ runList: null });
    expect(read.workflowRuns).toBeNull();
    expect(mergeVerdict(read).rule).toBe('runs-unreadable');
  });

  it('carries a listing that is not an array as null too', () => {
    // A renamed or reshaped response is the "cannot see" half, not "none".
    const { read } = stubReadPr({ runList: '{"message":"Not Found"}' });
    expect(read.workflowRuns).toBeNull();
  });
});

describe('an in-flight check is never superseded by a concluded sibling (RA-1974)', () => {
  // `stamp()` is a START time for a run that has not completed and a COMPLETION time for
  // one that has, so an older in-flight run beside a newer finished one always looked
  // older — and was dropped from `live` before `pending` could see it.
  const red = (over: Record<string, unknown>) =>
    ({ name: 'verify', workflowName: 'Red-test verification', ...over });

  it('waits on an older IN_PROGRESS run beside a newer SUCCESS — it used to MERGE', () => {
    const v = mergeVerdict(pr({ checks: [
      red({ status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-09-20T10:00:00Z' }),
      red({ status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-20T10:05:00Z') }),
      { name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-20T10:04:00Z') },
    ] }));
    expect(v.action, 'a check is still running on this head').toBe('wait');
    expect(v.rule).toBe('checks-pending');
  });

  it('waits for the newest dispatch rather than escalating on an older FAILURE', () => {
    const v = mergeVerdict(pr({ checks: [
      red({ status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-09-20T10:05:00Z' }),
      red({ status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-20T10:10:00Z') }),
    ] }));
    expect(v.rule).toBe('checks-pending');
  });

  it('still supersedes a concluded entry by a newer concluded one (RA-1892 unbroken)', () => {
    const v = mergeVerdict(pr({ checks: [
      red({ status: 'COMPLETED', conclusion: 'FAILURE', ...at('2026-09-20T10:00:00Z') }),
      red({ status: 'COMPLETED', conclusion: 'SUCCESS', ...at('2026-09-20T10:05:00Z') }),
    ] }));
    expect(v.action).toBe('merge');
  });
});

describe('a transient UNSTABLE waits; a settled one still escalates (RA-1773, RA-1319)', () => {
  const NOW = Date.parse('2026-09-20T12:00:00Z');
  const ago = (min: number) => new Date(NOW - min * 60000).toISOString();
  const green = (min: number) =>
    ({ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', ...at(ago(min)) });

  it('waits while one of the pipeline\'s own checks is still running (#1759\'s shape)', () => {
    // `Review (the Reviewer)` is excluded from the check partitions (the Merger cannot wait on the
    // review that woke him) — but GitHub still counts it, as a pending NON-required check.
    const v = mergeVerdict(pr({ mergeStateStatus: 'UNSTABLE', checks: [
      green(30),
      { name: 'Review (Reviewer)', workflowName: 'Review (Reviewer)', status: 'IN_PROGRESS', conclusion: null, startedAt: ago(1) },
    ] }), { now: NOW });
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('merge-state-unsettled');
    expect(v.why).toContain('Review (Reviewer)');
  });

  it('waits when everything settled green only moments ago (RA-1319: CLEAN 71 s later)', () => {
    const v = mergeVerdict(pr({ mergeStateStatus: 'UNSTABLE', checks: [green(2)] }), { now: NOW });
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('merge-state-unsettled');
  });

  it('ESCALATES once the settle window has passed with nothing running', () => {
    // The bound. A non-required check that genuinely failed must not wait forever.
    const past = UNSTABLE_SETTLE_MS / 60000 + 1;
    const v = mergeVerdict(pr({ mergeStateStatus: 'UNSTABLE', checks: [green(past)] }), { now: NOW });
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('merge-state');
  });

  it('escalates when there is no timestamp to judge by', () => {
    const v = mergeVerdict(pr({ mergeStateStatus: 'UNSTABLE' }), { now: NOW });
    expect(v.action).toBe('escalate');
  });

  it('leaves BLOCKED and BEHIND alone — neither is a check yet to settle', () => {
    for (const s of ['BLOCKED', 'BEHIND']) {
      const v = mergeVerdict(pr({ mergeStateStatus: s, checks: [green(1),
        { name: 'Review (Reviewer)', workflowName: 'Review (Reviewer)', status: 'IN_PROGRESS', conclusion: null }] }), { now: NOW });
      expect(v.rule, s).toBe('merge-state');
    }
  });
});

const MERGER_BOT = `${MERGER_LOGIN}[bot]`;
const held = (labeledBy: string, escalations: { rule: string, sha: string }[]) =>
  ({ labels: ['agent:implement', 'needs:human'], hold: { labeledBy, escalations } });

describe('the Merger\'s needs:human lapses with the head it was about (#2097)', () => {
  it('LIFTS it once the escalated commit is gone — PR RA-2056\'s shape', () => {
    const v = mergeVerdict(pr(held(MERGER_BOT, [{ rule: 'checks-failed', sha: OLD.slice(0, 12) }])));
    expect(v.action).toBe('release');
    expect(v.rule).toBe('escalation-lapsed');
    expect(v.why).toContain(OLD.slice(0, 7));
  });

  it('keeps it while the escalation is about THIS head', () => {
    const v = mergeVerdict(pr(held(MERGER_BOT, [{ rule: 'checks-failed', sha: HEAD.slice(0, 12) }])));
    expect(v.rule).toBe('escalating-label');
    expect(v.quiet).toBe(true);
  });

  it('keeps it when ANY escalation behind it does not lapse with a head', () => {
    // A path escalation is about the diff; one lapsing sibling must not lift it.
    const v = mergeVerdict(pr(held(MERGER_BOT, [
      { rule: 'checks-failed', sha: OLD.slice(0, 12) }, { rule: 'escalating-path', sha: OLD.slice(0, 12) }])));
    expect(v.rule).toBe('escalating-label');
  });

  it('NEVER lifts a label a person applied, whatever the Merger said before', () => {
    // The one manual brake in the pipeline (ESCALATE_LABELS' docblock).
    const v = mergeVerdict(pr(held('a-member', [{ rule: 'checks-failed', sha: OLD.slice(0, 12) }])));
    expect(v.rule).toBe('escalating-label');
    expect(v.action).toBe('escalate');
  });

  it('never lifts one with no escalation of the Merger\'s behind it', () => {
    expect(mergeVerdict(pr(held(MERGER_BOT, []))).rule).toBe('escalating-label');
  });

  it('never lifts when who applied it is unknown', () => {
    expect(mergeVerdict(pr({ labels: ['agent:implement', 'needs:human'], hold: null })).rule).toBe('escalating-label');
    expect(mergeVerdict(pr({ labels: ['agent:implement', 'needs:human'] })).rule).toBe('escalating-label');
  });

  it('a lift is never a merge — even when everything else is green', () => {
    // The next sweep re-reads the PR without the label and runs every gate.
    const v = mergeVerdict(pr(held(MERGER_BOT, [{ rule: 'merge-state', sha: OLD.slice(0, 12) }])));
    expect(v.action).not.toBe('merge');
  });

  it('lists only head-scoped rules as lapsing', () => {
    expect(LAPSES_WITH_HEAD.size).toBeGreaterThan(0);
    for (const r of ['escalating-path', 'escalating-label']) expect(LAPSES_WITH_HEAD.has(r), r).toBe(false);
    for (const r of ['checks-failed', 'merge-state', 'workflow-startup-failure']) expect(LAPSES_WITH_HEAD.has(r), r).toBe(true);
  });
});

describe('a conflicting pipeline PR is the rebase lane\'s first (#2238)', () => {
  const conflictingPath = (over: Record<string, unknown> = {}) => pr({
    mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', files: ['scripts/pipeline/merge-gate.mjs'], ...over });

  it('WAITS — no label — when it touches an escalating path and the lane has not tried', () => {
    // The issue's measured verdict was `escalate (escalating-path)`, stamping the label
    // that takes the PR off the lane.
    const v = mergeVerdict(conflictingPath({ rebaseAttempted: false }));
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('merge-state-rebasing');
    expect(v.why).toContain('scripts/pipeline/merge-gate.mjs');
  });

  it('still escalates the path once the lane has tried, or when that is unreadable', () => {
    for (const rebaseAttempted of [true, null]) {
      const v = mergeVerdict(conflictingPath({ rebaseAttempted }));
      expect(v.action, String(rebaseAttempted)).toBe('escalate');
      expect(v.rule, String(rebaseAttempted)).toBe('escalating-path');
    }
  });

  it('still escalates the path on a PR that does not conflict', () => {
    expect(mergeVerdict(pr({ files: ['scripts/pipeline/merge-gate.mjs'] })).rule).toBe('escalating-path');
  });

  it('LIFTS the Merger\'s own path label so the lane may act', () => {
    const v = mergeVerdict(conflictingPath({ rebaseAttempted: false,
      ...held(MERGER_BOT, [{ rule: 'escalating-path', sha: HEAD.slice(0, 12) }]) }));
    expect(v.action).toBe('release');
    expect(v.rule).toBe('lifted-for-rebase');
  });

  it('does not lift a person\'s label, or a label behind a non-lapsing reason', () => {
    const person = mergeVerdict(conflictingPath({ rebaseAttempted: false,
      ...held('a-member', [{ rule: 'escalating-path', sha: HEAD.slice(0, 12) }]) }));
    expect(person.action).toBe('escalate');
    const sev = mergeVerdict(conflictingPath({ rebaseAttempted: false,
      ...held(MERGER_BOT, [{ rule: 'escalating-label', sha: HEAD.slice(0, 12) }]) }));
    expect(sev.action).toBe('escalate');
  });

  it('does not lift once the lane has already tried this head', () => {
    const v = mergeVerdict(conflictingPath({ rebaseAttempted: true,
      ...held(MERGER_BOT, [{ rule: 'escalating-path', sha: HEAD.slice(0, 12) }]) }));
    expect(v.action).toBe('escalate');
  });
});

describe('readPr reads who holds needs:human, and only when it is on (RA-2097)', () => {
  const labelled = { labels: [{ name: 'agent:implement' }, { name: 'needs:human' }] };
  const lines = (...cs: { login: string, body: string }[]) => cs.map((c) => JSON.stringify(c)).join('\n');

  it('takes the LAST labeler, and only the Merger\'s ESCALATION markers', () => {
    const { read } = stubReadPr({
      meta: labelled,
      events: ['a-member', MERGER_BOT].join('\n'),
      comments: lines(
        { login: MERGER_BOT, body: `${ESCALATION_HEADER}\n\nRule: \`checks-failed\`\n\n<!-- merger:checks-failed:${OLD.slice(0, 12)} -->` },
        // A recover marker has the same shape and is not an escalation.
        { login: MERGER_BOT, body: `🔁 The Merger asked ... <!-- merger:no-review-on-head:${OLD.slice(0, 12)} -->` },
        // A person quoting a marker is not the Merger escalating.
        { login: 'a-member', body: `${ESCALATION_HEADER} <!-- merger:merge-state:${HEAD.slice(0, 12)} -->` },
      ),
    });
    expect(read.hold).toEqual({ labeledBy: MERGER_BOT, escalations: [{ rule: 'checks-failed', sha: OLD.slice(0, 12) }] });
    expect(mergeVerdict(read).rule).toBe('escalation-lapsed');
  });

  it('carries a failed read as null, which keeps the label sticky', () => {
    const { read } = stubReadPr({ meta: labelled, events: null });
    expect(read.hold).toBeNull();
    expect(mergeVerdict(read).rule).toBe('escalating-label');
  });

  it('does not pay for the reads on a PR without the label', () => {
    const { read, calls } = stubReadPr({ events: null, comments: null });
    expect(read.hold).toBeUndefined();
    expect(calls.some((c) => c.includes('/events') || c.includes('/1234/comments'))).toBe(false);
  });
});

describe('apply: a release, and a label the marker used to swallow', () => {
  const run = (verdict: Record<string, unknown>, { said = '', labels = [] as string[], dryRun = false } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-release-'));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
  *"/comments"*) printf '%s' ${JSON.stringify(said)} ;;
esac
`);
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    try {
      apply({ number: 7, headSha: HEAD, labels }, verdict, 'o/r', { dryRun });
    } finally {
      process.env.PATH = prev;
    }
    let calls: string;
    try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch { calls = ''; }
    return calls.split('\n').filter(Boolean);
  };
  const release = { action: 'release', rule: 'escalation-lapsed', why: 'gone', quiet: false };

  it('says why, then removes the label — and never merges', () => {
    const calls = run(release, { labels: ['needs:human'] });
    const comment = calls.findIndex((c) => c.startsWith('pr comment'));
    const lift = calls.findIndex((c) => c.includes('--remove-label needs:human'));
    expect(comment, 'no comment saying why').toBeGreaterThan(-1);
    expect(lift, 'the label was not removed').toBeGreaterThan(comment);
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('does not repeat itself, but still lifts, when the marker is already there', () => {
    const calls = run(release, { labels: ['needs:human'], said: `<!-- merger:escalation-lapsed:${HEAD.slice(0, 12)} -->` });
    expect(calls.some((c) => c.startsWith('pr comment'))).toBe(false);
    expect(calls.some((c) => c.includes('--remove-label needs:human'))).toBe(true);
  });

  it('does nothing on a dry run', () => {
    expect(run(release, { labels: ['needs:human'], dryRun: true }).filter((c) => c.startsWith('pr '))).toEqual([]);
  });

  it('re-applies the label on an already-announced escalation that lost it', () => {
    const escalate = { action: 'escalate', rule: 'escalating-path', why: 'x', quiet: false };
    const mark = `<!-- merger:escalating-path:${HEAD.slice(0, 12)} -->`;
    const off = run(escalate, { labels: ['agent:implement'], said: mark });
    expect(off.some((c) => c.startsWith('pr comment')), 'the marker still dedupes the comment').toBe(false);
    expect(off.some((c) => c.includes('--add-label needs:human'))).toBe(true);
    const on = run(escalate, { labels: ['agent:implement', 'needs:human'], said: mark });
    expect(on.some((c) => c.includes('--add-label'))).toBe(false);
  });
});

describe('a wait is named in the sweep summary (RA-1290)', () => {
  const v = (action: string, rule: string) => ({ action, rule, why: '', quiet: false });

  it('collects waits and releases by PR, not just merges, escalations and skips', () => {
    const verdicts: Record<string, ReturnType<typeof v>> = {
      1: v('wait', 'checks-pending'), 2: v('merge', 'green-zone'), 3: v('release', 'escalation-lapsed'), 4: v('wait', 'runs-unreadable'),
    };
    const out = sweep(['1', '2', '3', '4'], { consider: (n: string) => verdicts[n] });
    expect(out.waiting).toEqual(['#1 — checks-pending', '#4 — runs-unreadable']);
    expect(out.released).toEqual(['#3 — escalation-lapsed']);
    expect(out.merged).toBe(1);
  });

  it('prints each waiting PR against its rule, so a stuck one recurs by NAME', () => {
    const lines = summaryLines({ considered: 3, dryRun: false, merged: 0, escalated: [],
      waiting: ['#1 — checks-pending'], released: ['#3 — escalation-lapsed'] });
    expect(lines.some((l: LibraryValue) => l.startsWith('- waiting on the pipeline') && l.endsWith(': 1'))).toBe(true);
    expect(lines).toContain('  - #1 — checks-pending');
    expect(lines).toContain('  - #3 — escalation-lapsed');
  });

  it('adds no line when nothing waited — an always-present line is noise', () => {
    const lines = summaryLines({ considered: 1, dryRun: false, merged: 1, escalated: [] });
    expect(lines.some((l: LibraryValue) => l.includes('waiting on the pipeline'))).toBe(false);
    expect(lines).toContain('- merged: 1');
  });

  it('is what main writes, not a second copy of it', () => {
    const src = readFileSync(join(ROOT, 'scripts/merge-gate.mjs'), 'utf8');
    const tail = src.slice(src.indexOf('async function main() {'));
    expect(tail).toMatch(/summaryLines\(\{[^}]*waiting[^}]*\}\)/);
  });
});

describe('checkPartition — the rollup partition, exported for other readers (RA-1723)', () => {
  const c = (over: Record<string, unknown>) => ({ name: 'verify', workflowName: 'Red-test verification', status: 'COMPLETED', conclusion: 'SUCCESS', ...over });
  const names = (xs: { conclusion: string | null, status: string }[]) => xs.map((x) => `${x.status}/${x.conclusion}`);

  it('drops the pipeline\'s own two checks before anything else', () => {
    const p = checkPartition(SELF_CHECKS.map((w: LibraryValue) => c({ name: w, workflowName: w, status: 'IN_PROGRESS', conclusion: null })));
    expect(p.relevant).toEqual([]);
    expect(p.pending).toEqual([]);
  });

  it('keeps an in-flight run beside a newer concluded sibling (RA-1974)', () => {
    const p = checkPartition([
      c({ status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-09-20T10:00:00Z' }),
      c({ ...at('2026-09-20T10:05:00Z') }),
    ]);
    expect(p.pending).toHaveLength(1);
    expect(p.live).toHaveLength(2);
  });

  it('supersedes an older concluded run by a newer conclusive one (RA-1892)', () => {
    const p = checkPartition([c({ conclusion: 'FAILURE', ...at('2026-09-20T10:00:00Z') }), c({ ...at('2026-09-20T10:05:00Z') })]);
    expect(p.failed).toEqual([]);
    expect(names(p.live)).toEqual(['COMPLETED/SUCCESS']);
  });

  it('does not let a newer SKIPPED or CANCELLED excuse a FAILURE (RA-1965)', () => {
    for (const late of ['SKIPPED', 'CANCELLED']) {
      const p = checkPartition([c({ conclusion: 'FAILURE', ...at('2026-09-20T10:00:00Z') }), c({ conclusion: late, ...at('2026-09-20T10:05:00Z') })]);
      expect(names(p.failed), late).toEqual(['COMPLETED/FAILURE']);
    }
  });

  it('excuses an unstamped CANCELLED only when a sibling concluded (RA-1168)', () => {
    expect(checkPartition([c({ conclusion: 'CANCELLED' }), c({})]).cancelled).toEqual([]);
    expect(names(checkPartition([c({ conclusion: 'CANCELLED' })]).cancelled)).toEqual(['COMPLETED/CANCELLED']);
  });

  it('returns three DISJOINT sets, so a caller can count each without double-counting', () => {
    const p = checkPartition([
      c({ name: 'a', status: 'IN_PROGRESS', conclusion: null }),
      c({ name: 'b', conclusion: 'CANCELLED' }),
      c({ name: 'd', conclusion: 'FAILURE' }),
      c({ name: 'e', conclusion: 'TIMED_OUT' }),
      c({ name: 'f' }), c({ name: 'g', conclusion: 'NEUTRAL' }), c({ name: 'h', conclusion: 'SKIPPED' }),
    ]);
    expect(p.pending.map((x: LibraryValue) => x.name)).toEqual(['a']);
    expect(p.cancelled.map((x: LibraryValue) => x.name)).toEqual(['b']);
    expect(p.failed.map((x: LibraryValue) => x.name)).toEqual(['d', 'e']);
    expect(p.live).toHaveLength(7);
  });

  it('is what mergeVerdict uses, not a copy beside it', () => {
    const src = readFileSync(join(ROOT, 'scripts/merge-gate.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export function mergeVerdict('));
    expect(body).toMatch(/= checkPartition\(pr\.checks\)/);
    expect(body).not.toMatch(/newestFor/);
  });

  it('a plan-skipped red-test blocks nothing, and a failed plan still does (RA-2315)', () => {
    // `red-test.yml` now runs a `Red-test scope` job first and skips `Red-test
    // verification` when there is nothing to verify. Distinct job names are distinct
    // keys, so the scope's SUCCESS cannot supersede a verification that ran.
    const scope = (conclusion: string, iso = '2026-09-20T10:00:00Z') => c({ name: 'Red-test scope', conclusion, ...at(iso) });
    const verify = (conclusion: string) => c({ name: 'Red-test verification', conclusion, ...at('2026-09-20T10:05:00Z') });
    expect(checkPartition([scope('SUCCESS'), verify('SKIPPED')]).failed).toEqual([]);
    expect(checkPartition([scope('FAILURE'), verify('SKIPPED')]).failed.map((x: LibraryValue) => x.name)).toEqual(['Red-test scope']);
    // A NEWER scope SUCCESS (a re-run) beside an older verification FAILURE.
    expect(checkPartition([verify('FAILURE'), scope('SUCCESS', '2026-09-20T10:10:00Z')]).failed.map((x: LibraryValue) => x.name)).toEqual(['Red-test verification']);
  });

  it('tolerates an absent rollup', () => {
    expect(checkPartition(undefined as never)).toEqual({ relevant: [], live: [], pending: [], cancelled: [], failed: [] });
  });
});

describe('a lift for the rebase lane stays lifted (RA-2317 review)', () => {
  /**
   * THE FLAP THE REVIEWER MEASURED. A conflicting, untried PR whose head carries a red E2E, with
   * The Merger's `checks-failed` escalation on THAT head. The untried-conflict wait used to sit
   * only ahead of the path rule, so after the lift the check gate re-escalated first, `apply`
   * found the marker already said and re-applied the label, and the next sweep lifted it
   * again: release → escalate → release, with the lane racing the toggle.
   *
   * Driven end to end — verdict, then `apply` against a stubbed `gh`, then the labels that
   * `apply` actually left — over three sweeps, not asserted on one verdict.
   */
  const red = [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const said = [
    `${ESCALATION_HEADER}\n<!-- merger:checks-failed:${HEAD.slice(0, 12)} -->`,
    `<!-- merger:lifted-for-rebase:${HEAD.slice(0, 12)} -->`,
  ].join('\n');

  const sweepOnce = (labels: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'flap-'));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/calls"
case "$*" in
  *"/comments"*) printf '%s' ${JSON.stringify(said)} ;;
esac
`);
    const state = pr({
      mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', rebaseAttempted: false, checks: red, labels,
      hold: labels.includes('needs:human')
        ? { labeledBy: MERGER_BOT, escalations: [{ rule: 'checks-failed', sha: HEAD.slice(0, 12) }] } : undefined,
    });
    const v = mergeVerdict(state);
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    try { apply(state, v, 'o/r', { dryRun: false }); } finally { process.env.PATH = prev; }
    let calls: string[];
    try { calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean); } catch { calls = []; }
    let next = [...labels];
    if (calls.some((c) => c.includes('--remove-label needs:human'))) next = next.filter((l) => l !== 'needs:human');
    if (calls.some((c) => c.includes('--add-label needs:human')) && !next.includes('needs:human')) next.push('needs:human');
    return { v, calls, next };
  };

  it('lifts once, then WAITS — the label is never re-applied', () => {
    let labels = ['agent:implement', 'needs:human'];
    const seen: string[] = [];
    const added: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { v, calls, next } = sweepOnce(labels);
      seen.push(`${v.action}:${v.rule}`);
      added.push(...calls.filter((c) => c.includes('--add-label')));
      labels = next;
    }
    expect(seen).toEqual(['release:lifted-for-rebase', 'wait:merge-state-rebasing', 'wait:merge-state-rebasing']);
    expect(added, 'needs:human was put back after the lift').toEqual([]);
    expect(labels).not.toContain('needs:human');
  });

  it('a red, conflicting, untried PR with no label waits for the lane instead of escalating', () => {
    const v = mergeVerdict(pr({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', rebaseAttempted: false, checks: red }));
    expect(v.action).toBe('wait');
    expect(v.rule).toBe('merge-state-rebasing');
  });

  it('still escalates the red check once the lane has tried this head', () => {
    const v = mergeVerdict(pr({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', rebaseAttempted: true, checks: red }));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('checks-failed');
  });
});
