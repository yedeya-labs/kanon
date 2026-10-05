import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { callsSpine, jobPrompt, spineJobFor } from './helpers/spine.js';
import { comparePatch, GH_COMPARE_ARM } from './helpers/compare-diff.js';
import { writeStub } from './helpers/stub-bin.js';
import { GH_REGISTER_ARM, LEAD_LOGIN, REGISTER_FIXTURE, registerEnv } from './helpers/register.js';

/**
 * RA-966 — the Lead's revise mode.
 *
 * `pull_request_review` fires on EVERY review in the repo, so most of what is
 * testable here is what the workflow refuses to act on. The failure modes are all
 * "acted when it should not have": on someone else's PR, on an approve, on a
 * closed PR, on a non-brief, or for a third round of a disagreement that two
 * rounds did not settle.
 *
 * The other load-bearing property is that it revises IN PLACE. Re-authoring would
 * discard the review threads the findings are attached to — the same error as
 * overwriting a brief with a fresh dispatch, which is what this replaces.
 */

const wf = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-lead-revise.yml'), 'utf8'));
// Since RA-2592 the decision is a job of its own (`filter`) and the agent half calls the
// spine (`revise`), so the steps are found in the job that now holds them.
const filter = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'filter');
const prompt: string = jobPrompt(wf.jobs.revise);
const mandateStep = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'mandate');
// What the revise job RUNS — `agent-lane.yml`, resolved for this lane's inputs.
const revise = spineJobFor(wf.jobs.revise);

/**
 * Run the SHIPPED mandate step and return what it put in `outputs.text`.
 *
 * RA-1024 round 1: the reset gate opened the door and the prompt still said "the Reviewer
 * requested changes… READ THE REVIEW FIRST", pointing at `.reviews[-1].body` and
 * the review line-comments endpoint. The developer's answers are PR ISSUE
 * comments and appear in neither. So the gate worked and the payload was wrong —
 * The Lead would have revised against the review he had already answered twice and
 * spent the one authorised revision doing it.
 */
const runMandate = ({ reset, round = '3' }: { reset: boolean; round?: string }) => {
  const r = runWorkflowStep(mandateStep, {
    env: { RESET: String(reset), PR: '964', ROUND: round, REPO: 'example-org/example-repo' },
  });
  // Under `bash -c` a non-zero exit mid-body was invisible; under the runner's `-e`
  // it aborts, so the status is asserted rather than discarded (RA-1044).
  expect(r.status, `mandate step aborted: ${r.output}`).toBe(0);
  return r.outputFile.replace(/^text<<MANDATE_EOF\n/, '').replace(/MANDATE_EOF\n?$/, '');
};

/**
 * A stub `gh pr view <n> --json <fields> [--jq <expr>]`. Generic on purpose: a stub
 * that shaped its answer per test case would be smuggling the expected result into
 * the fixture. It dispatches on the requested fields alone and runs any `--jq`
 * through the real jq, exactly as gh does.
 */
const GH_STUB = `#!/usr/bin/env bash
# \`gh api repos/O/R/compare/BASE...SHA\` under the diff media type — the PR's effective
# patch at a commit, which is what the content fingerprint hashes (RA-1841).
# The App register, which the filter reads its login from (plan 0001 §5).
${GH_REGISTER_ARM}

${GH_COMPARE_ARM}

json=""; jqexpr=""; prev=""
for a in "$@"; do
  case "$prev" in
    --json) json="$a" ;;
    --jq) jqexpr="$a" ;;
  esac
  prev="$a"
done
case "$json" in
  *comments*) payload="$STUB_COMMENTS" ;;
  # The reviewer's own CHANGES_REQUESTED reviews, which the round cap floors on (RA-969)
  # — since RA-1841 fingerprinted down to the DISTINCT PATCHES they faulted.
  *reviews*)  payload="$STUB_REVIEWS" ;;
  *) payload="$STUB_META" ;;
esac
if [ -n "$jqexpr" ]; then printf '%s' "$payload" | jq -r "$jqexpr"; else printf '%s' "$payload"; fi
`;

/**
 * Run the SHIPPED filter step under bash and report what it decided.
 *
 * The first version of these assertions compared a TypeScript re-implementation of
 * the two parameter expansions against a table of logins. That proved the copy
 * worked: it never loaded the workflow, so reverting the shell comparison to
 * `$AUTHOR` — RA-1007 verbatim, revise mode inert on every dispatch — left the suite
 * green (mutation-verified, RA-1010). Executing the real script is what makes a
 * regression visible, and it costs one bash process.
 */
const runFilter = ({
  author,
  rounds = 0,
  // How many CHANGES_REQUESTED reviews the PR carries. Defaults to `rounds + 1` — the
  // one that triggered this run, plus one per prior revision, which is the world a
  // healthy loop actually produces. Set independently to model RA-969's failure: a round
  // that pushed and ended without leaving its marker.
  changesRequested = rounds + 1,
  /** Override the marker comments entirely, to model who wrote them. */
  comments,
  prState = 'OPEN',
  files = ['docs/projects/961.md'],
  reviewState = 'changes_requested',
  isDispatch = false,
  // THE LABEL PATH (RA-1595). A `labeled` event carries no review payload, so the
  // filter reads the standing verdict off the PR instead — which is why these two
  // exist: the head SHA the reviews are compared against, and the reviews as the
  // API actually shapes them (`commit.oid`, not the bare `state` the count uses).
  isLabel = false,
  labelAdded,
  headRefOid = 'ffffffffffffffffffffffffffffffffffffffff',
  reviews,
  // CONTENT, NOT SHA (RA-1841). false: every reviewed commit carries its own patch, which
  // is what a healthy loop produces. true: every commit on the PR — reviewed and head —
  // carries the SAME patch, which is all a content-free rebase leaves behind.
  samePatch = false,
  // The compare API not answering: a deleted commit, a truncated diff. The fingerprint
  // must degrade to the SHA, which is the pre-RA-1841 behaviour.
  readableDiffs = true,
  reset = false,
  resetEnv,
  register = REGISTER_FIXTURE,
}: {
  author: string;
  rounds?: number;
  changesRequested?: number;
  comments?: Array<{ author?: { login: string }; body: string }>;
  prState?: string;
  files?: string[];
  reviewState?: string;
  isDispatch?: boolean;
  isLabel?: boolean;
  labelAdded?: string;
  headRefOid?: string;
  /** Replace the generated review list, to place verdicts on specific commits. */
  reviews?: Array<{ state: string; commit?: { oid: string } }>;
  samePatch?: boolean;
  readableDiffs?: boolean;
  reset?: boolean;
  /** Force RESET independently of the trigger, to probe the guard adversarially. */
  resetEnv?: string;
  /** The App register the filter reads its login from; empty is a missing register. */
  register?: string;
}) => {
  // ONE HEAD PER CHANGES-REQUEST, because a review is filed against a commit and a
  // healthy loop reviews a new one each round (RA-1841). The old fixture put every review
  // on the head oid, which the raw count could ignore and the content count cannot.
  const reviewList = reviews
    ?? Array.from({ length: changesRequested }, (_, i) => ({
      state: 'CHANGES_REQUESTED',
      commit: { oid: i === changesRequested - 1 ? headRefOid : `sha-${i}` },
    }));
  const diffs: Record<string, string> = {};
  [...new Set([...reviewList.map((rv) => rv.commit?.oid ?? ''), headRefOid])]
    .filter(Boolean)
    .forEach((s, i) => {
      diffs[s] = samePatch
        ? comparePatch({ content: 'the same paragraph', churn: 'a'.repeat(i + 1) })
        : comparePatch({ content: `paragraph ${i}` });
    });

  const dir = mkdtempSync(join(tmpdir(), 'lead-revise-filter-'));
  writeStub(join(dir, 'gh'), GH_STUB);
  const r = runWorkflowStep(filter, {
    dir,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      // What GitHub interpolates into `env:` at run time.
      REPO: 'example-org/example-repo',
      PR: '964',
      // On a real workflow_dispatch there is no review in the payload, so
      // `${{ github.event.review.state }}` is INFERRED to interpolate empty, from
      // GitHub's documented behaviour for a missing context path. Not observed:
      // run 32936437286 reached the author guard, but `&&` short-circuits once
      // IS_DISPATCH is true, so $STATE was never examined and that run is silent
      // on its value. The assertion does not depend on it either way — ANY state
      // other than changes_requested is equally sensitive to deleting the escape.
      STATE: isDispatch || isLabel ? '' : reviewState,
      IS_DISPATCH: String(isDispatch),
      // A `pull_request: [labeled]` event carries neither a review nor an input.
      IS_LABEL: String(isLabel),
      LABEL_ADDED: labelAdded ?? (isLabel ? filter.env.REVISE_LABEL : ''),
      // Read FROM the workflow, so renaming the marker in one place fails here
      // rather than passing against a stale copy of it.
      REVISE_LABEL: filter.env.REVISE_LABEL,
      // A `pull_request_review` event cannot carry an input, so on that path the
      // expression yields the empty string — modelled, not assumed away. Tests that
      // probe the guard itself override this with `resetEnv`.
      RESET: resetEnv ?? (isDispatch ? String(reset) : ''),
      // ...and the register the workflow reads its login from, with the role and the
      // parser read FROM the workflow, so a renamed role fails here.
      ...registerEnv(filter, register),
      STUB_META: JSON.stringify({
        author: { login: author },
        state: prState,
        files: files.map((path) => ({ path })),
        headRefName: 'docs/961-order-settlement-brief',
        // The label path asks the PR for its head before asking which verdict
        // stands on it.
        headRefOid,
        // ...and for its base, which the compare the fingerprint reads is rooted at.
        baseRefName: 'main',
      }),
      // The effective patch at each commit the PR's reviews name, keyed by sha (RA-1841).
      STUB_DIFFS: readableDiffs ? JSON.stringify(diffs) : '',
      // Reviews on the PR. Default: the one CHANGES_REQUESTED that triggered this
      // run, so `REQUESTED - 1` is 0 prior rounds — the state every non-cap test
      // means when it says "a first revision".
      STUB_REVIEWS: JSON.stringify({ reviews: reviewList }),
      STUB_COMMENTS: JSON.stringify({
        // AUTHORED. The counter is author-filtered since RA-969 — without that,
        // `contains(...)` counted the marker in anyone's comment, so a developer
        // quoting it while discussing this mechanism silently consumed a round. This
        // fixture carried no author at all and so proved the cap against a counter
        // that could not tell whose marker it was reading.
        comments: comments ?? Array.from({ length: rounds }, () => ({
          author: { login: 'example-lead' },
          body: '<!-- qa:lead-revise -->',
        })),
      }),
    },
  });

  // Read the outputs the step actually WROTE. Asserting `branch` from the consumer
  // (`checkout.with.ref`) stays true whatever the filter puts in it — `.headRefName`
  // could become `.baseRefName` and the revision would run against the default
  // branch with the suite green (RA-1012).
  const { outputs } = r;

  return { act: outputs.act === 'true', outputs, stdout: r.stdout, summary: r.summary, status: r.status };
};

describe('what it refuses to act on', () => {
  const LEAD_AUTHOR = 'app/example-lead';

  it.each([
    // RA-378: the reviewer posts COMMENT while a check is pending, and that comment
    // can carry an approve. Acting on it would revise a brief nobody faulted.
    ['changes_requested', true],
    ['commented', false],
    ['approved', false],
    ['dismissed', false],
  ])('a %s verdict → acts: %s', (reviewState, expected) => {
    expect(runFilter({ author: LEAD_AUTHOR, reviewState }).act).toBe(expected);
  });

  it.each([
    ['OPEN', true],
    ['CLOSED', false],
    ['MERGED', false],
  ])('a %s PR → acts: %s', (prState, expected) => {
    expect(runFilter({ author: LEAD_AUTHOR, prState }).act).toBe(expected);
  });

  it('acts on a manual dispatch, where there is no review state at all', () => {
    // A workflow_dispatch carries no review, so `github.event.review.state`
    // interpolates to EMPTY and the verdict guard would skip every manual run —
    // RA-1007's failure mode verbatim, on the path that exists to RECOVER from it.
    // The escape is what prevents that, and nothing executed it until now.
    expect(runFilter({ author: LEAD_AUTHOR, isDispatch: true }).act).toBe(true);
  });

  it.each([
    [['docs/projects/961.md'], true],
    [['docs/projects/961.md', 'src/app/page.tsx'], true],
    [['src/app/page.tsx'], false],
    [[], false],
  ])('a PR touching %j → acts: %s', (files, expected) => {
    // This is the guard that stops revise mode checking out an ARBITRARY branch
    // and running claude-code-action under a freshly minted App token. The author
    // guard narrows the blast radius; it does not replace this one, so this is the
    // last place a string grep is acceptable. Grepping for `docs/projects/` was
    // satisfied by the literal inside the jq expression while `-gt 0` became
    // `-ge 0` and admitted every PR in the repo (RA-1011).
    expect(runFilter({ author: LEAD_AUTHOR, files }).act).toBe(expected);
  });

  it('says why it skipped, every time', () => {
    // A silent no-op on a repo-wide trigger is indistinguishable from a broken
    // one — agentic-qa-pipeline.md §5.
    expect(filter.run).toContain('Skipped: $1');
    expect(filter.run).toContain('GITHUB_STEP_SUMMARY');
  });
});

describe('the author identity check', () => {
  /**
   * One identity, three spellings, three endpoints — and the filter compared
   * against none of the ones `gh pr view` produces:
   *
   *   gh pr view --json author      -> app/example-lead
   *   gh issue view --json comments -> example-lead
   *   gh api .../reviews            -> example-lead[bot]
   *
   * So revise mode never once acted on a review. It failed closed and said why,
   * which is precisely why nothing went wrong and why nobody noticed for two days.
   *
   * RA-918 predicted this class, and is OPEN: it asks for a hardcoded login to be
   * checked against the identity the agent actually authenticates as, which is a
   * live check and not this. Executing the filter over the three spellings narrows
   * that gap; it does not close it, so RA-918 stays open.
   */
  it.each([
    ['app/example-lead', true],       // what gh pr view really returns
    ['example-lead', true],           // the comments shape
    ['example-lead[bot]', true],      // the reviews-API shape
    ['a-developer', false],                    // a human
    ['app/example-implementer', false], // a different agent's PR
  ])('the workflow acts on a PR authored by %s: %s', (author, expected) => {
    expect(runFilter({ author }).act).toBe(expected);
  });

  it('names the raw login AND the derived slug in the reason it skipped', () => {
    // "authored by 'app/example-lead', not the Lead" was true and useless — it
    // did not show that the comparison itself was the problem. Read off the real
    // step summary, so a reworded skip() that drops one of them fails here.
    const { summary } = runFilter({ author: 'app/example-implementer' });
    expect(summary).toContain("'app/example-implementer'");
    expect(summary).toContain("slug 'example-implementer'");
  });

  it('strips both affixes in the workflow, not just one', () => {
    // The prefix and the suffix come from different endpoints, so handling only
    // one leaves the mode inert against the other.
    expect(filter.run).toContain('${AUTHOR#app/}');
    expect(filter.run).toContain('%\\[bot\\]');
  });

  it('names the role once, in env, and reads its login from the App register', () => {
    // A fourth spelling on a fourth endpoint should be one edit, not a hunt — and since
    // the lane is Kanon's, the slug itself is the register's (plan 0001 §5).
    expect(filter.env.ROLE).toBe('Lead');
    expect(filter.env.REGISTER_AWK).toBe(readFileSync(join(process.cwd(), 'actions/lane-check/app-register.awk'), 'utf8'));
    expect(REGISTER_FIXTURE).toContain(LEAD_LOGIN);
  });

});

describe('the round cap', () => {
  const LEAD_AUTHOR_CAP = 'app/example-lead';

  it('counts rounds from the Lead\'s own marker comments, not stored state', () => {
    // Same mechanism as the dispatch sweep (RA-912): the world already contains the
    // evidence, so the bound survives a re-run and needs nothing persisted.
    expect(filter.run).toContain('qa:lead-revise');
    expect(filter.run).toContain('ROUNDS');
  });

  it.each([
    [0, true],
    [1, true],
    [2, false],
    [3, false],
  ])('stops at two rounds: %i prior revisions → acts: %s', (rounds, expected) => {
    // /ship states the same rule for a human doing this by hand: a finding that
    // survives two pushes is substantive, and another iteration will not settle it.
    // Executed rather than grepped for `-ge 2`, because an off-by-one in the
    // comparison is invisible to a string match — the same reason as RA-1010.
    expect(runFilter({ author: 'app/example-lead', rounds }).act).toBe(expected);
  });

  it.each([
    [2, true],
    [3, true],
    [9, true],
  ])('an explicit reset clears the cap at %i prior revisions → acts: %s', (rounds, expected) => {
    // RA-1023: the cap counts REVISIONS, not disagreements. On RA-964 two review rounds
    // spent the budget, the brief asked the developer six questions and blocked on
    // them, the developer answered — and the Lead could not apply the answers.
    // Escalation was one-way. A developer's answer is a NEW MANDATE.
    expect(runFilter({ author: LEAD_AUTHOR_CAP, rounds, isDispatch: true, reset: true }).act).toBe(expected);
  });

  it('refuses to let a non-dispatch path clear the cap even if RESET says true', () => {
    // The load-bearing half, and it needs an ADVERSARIAL fixture to be visible.
    // Today a review event cannot set an input, so RESET is empty there — which
    // means a guard testing RESET alone passes every honest test while leaving the
    // loop unbounded for any future trigger that CAN set one. Forcing RESET=true on
    // a non-dispatch is the only fixture that fails when `IS_DISPATCH` is dropped.
    // Mutation-verified: without this case, deleting the IS_DISPATCH half is green.
    expect(runFilter({ author: LEAD_AUTHOR_CAP, rounds: 5, isDispatch: false, resetEnv: 'true' }).act).toBe(false);
  });

  it('models the real review-event payload, where no input exists at all', () => {
    expect(runFilter({ author: LEAD_AUTHOR_CAP, rounds: 5, isDispatch: false }).act).toBe(false);
  });

  it('a plain dispatch does NOT clear the cap — the reset must be asked for', () => {
    expect(runFilter({ author: LEAD_AUTHOR_CAP, rounds: 2, isDispatch: true, reset: false }).act).toBe(false);
  });

  it('does not announce a bypass that never happened', () => {
    // The notice exists so a bypass is never silent; announcing a non-bypass dilutes
    // exactly that signal. A reset dispatch below the cap proceeds either way, so
    // `act` cannot detect this — only the summary can.
    const { act, summary } = runFilter({ author: LEAD_AUTHOR_CAP, rounds: 0, isDispatch: true, reset: true });
    expect(act).toBe(true);
    expect(summary).not.toContain('Round cap cleared');
  });

  it('records the clearance in the step summary, so a bypass is auditable', () => {
    const { summary } = runFilter({ author: LEAD_AUTHOR_CAP, rounds: 4, isDispatch: true, reset: true });
    expect(summary).toContain('Round cap cleared by explicit dispatch');
    expect(summary).toContain('4 prior revisions');
  });

  it('warns loudly when it gives up, rather than skipping quietly', () => {
    const { stdout } = runFilter({ author: 'app/example-lead', rounds: 2 });
    expect(stdout).toContain('::warning');
  });

  it('requires the marker even on an empty round, or the cap silently resets', () => {
    expect(prompt).toContain('<!-- qa:lead-revise -->');
    expect(prompt.replace(/\s+/g, ' ')).toMatch(/must be present even if/);
  });
});

describe('revise in place', () => {
  const LEAD_AUTHOR_IN_PLACE = 'app/example-lead';

  it('checks out the PR branch, not the default branch', () => {
    // Both halves, or the invariant is only half-guarded: the consumer must read
    // `filter.outputs.branch`, AND the filter must put the HEAD ref in it.
    // Three links since RA-2592: the lane passes the branch, the spine's checkout uses it,
    // and the filter job publishes the step output the lane reads.
    expect(callsSpine(wf.jobs.revise)).toBe(true);
    expect(wf.jobs.revise.with.ref).toContain('needs.filter.outputs.branch');
    expect(wf.jobs.filter.outputs.branch).toBe('${{ steps.filter.outputs.branch }}');
    const checkout = revise.steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.ref).toBe('${{ inputs.ref }}');
    // With history, as before the conversion: the agent merges `main` into the branch.
    expect(checkout?.with?.['fetch-depth']).toBe('${{ inputs.fetch-depth }}');
    expect(revise.inputs['fetch-depth']).toBe(0);
    // And the row names the PR it was spent on — there is no issue to name instead.
    expect(wf.jobs.revise.with['pr-number']).toBe('${{ needs.filter.outputs.pr }}');
    expect(revise.steps.find((s) => s.uses?.includes('actions/agent-telemetry'))?.with?.pr_number)
      .toBe('${{ inputs.pr-number }}');
    expect(runFilter({ author: LEAD_AUTHOR_IN_PLACE }).outputs.branch).toBe('docs/961-order-settlement-brief');
  });

  it('numbers the round it is about to take, not the one just finished', () => {
    // Interpolated into the prompt as "round N of at most 2", so an off-by-one is
    // invisible to a string match for the same reason `-ge 2` was (RA-1012).
    expect(runFilter({ author: LEAD_AUTHOR_IN_PLACE, rounds: 0 }).outputs.round).toBe('1');
    expect(runFilter({ author: LEAD_AUTHOR_IN_PLACE, rounds: 1 }).outputs.round).toBe('2');
  });

  it('forbids re-authoring, which would discard the review it answers', () => {
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).toMatch(/Do NOT create a new branch, a new PR, or a new file/);
    expect(flat).toMatch(/do NOT re-author the brief from scratch/);
  });

  it('receives the App token before checkout, so the push credential is the App token (minted in the key-holding job of the spine, kanon#274)', () => {
    const names = revise.steps.map((s) => s.name ?? s.uses);
    expect(names.indexOf('Receive the App token')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Receive the App token'))
      .toBeLessThan(names.findIndex((n) => n?.startsWith('actions/checkout')));
    // And the App is the Lead's — the identity the round count filters on.
    expect(wf.jobs.revise.secrets['app-id']).toBe('${{ secrets.LEAD_APP_ID }}');
  });

  it('serialises revisions of one brief', () => {
    expect(wf.concurrency.group).toContain('agent-lead-revise-');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });
});

describe('the mandate the reset run actually receives', () => {
  it('is wired into the prompt, and wired to the filter', () => {
    // The chain is four links — filter emits `reset` -> mandate reads it -> mandate
    // emits `text` -> prompt interpolates it. Executing the mandate SCRIPT proves it
    // branches correctly; it cannot prove the script is reached, fed or consumed.
    // Deleting the interpolation is the easiest of the three to introduce and the
    // worst: one unreferenced line inside a block scalar, `mandateStep` still found
    // by id, and every mandate test keeps passing over a prompt that no longer
    // contains a mandate. String-presence is acceptable here ONLY because the thing
    // asserted IS a literal wiring reference — no arithmetic, no comparison —
    // unlike `-gt 0` or `-ge 2`, which this suite executes instead (RA-1010).
    // Five links since RA-2592: the prompt now reads the mandate through the filter JOB's
    // outputs, so the job must publish the mandate step's `text` under that name.
    expect(prompt).toContain('needs.filter.outputs.mandate');
    expect(wf.jobs.filter.outputs.mandate).toBe('${{ steps.mandate.outputs.text }}');
    expect(mandateStep.env.RESET).toContain('steps.filter.outputs.reset');
  });

  it.each([
    [{ isDispatch: true, reset: true, rounds: 3 }, 'true'],
    [{ isDispatch: true, reset: false, rounds: 1 }, 'false'],
    [{ isDispatch: false, rounds: 1 }, 'false'],
  ])('the filter tells the mandate whether this is a reset: %j', (args, expected) => {
    // The one link that needs real execution. Without it the filter can emit a
    // hardcoded `reset=false` and the reset run silently takes the review branch —
    // the round-1 defect verbatim, suite green.
    expect(runFilter({ author: 'app/example-lead', ...args }).outputs.reset).toBe(expected);
  });

  it('tells him it is a developer decision, not a review round', () => {
    const m = runMandate({ reset: true });
    expect(m).toContain('APPLYING A DEVELOPER DECISION');
    expect(m).not.toContain('requested changes');
  });

  it('points at PR issue comments, where the answers really are', () => {
    // Not `.reviews[-1].body` (the Reviewer's review) and not `/pulls/N/comments` (review
    // LINE comments). A developer answering the brief writes a PR issue comment —
    // the same field the round counter reads.
    const m = runMandate({ reset: true });
    expect(m).toContain('--json comments');
    // The review LINE-comments endpoint is never right for a developer's answer.
    expect(m).not.toMatch(/pulls\/\$?\{?PR\}?\/comments/);
    // The standing review is still offered (it is subordinate, not dropped — see the
    // standing-review test), so assert PRECEDENCE rather than absence: the answers
    // are what this run is for, and they must be the first thing he is sent to.
    expect(m.indexOf('--json comments')).toBeLessThan(m.indexOf('--json reviews'));
  });

  it('never claims a round number on a reset run', () => {
    // `round` is ROUNDS+1 and unbounded past the cleared cap, so the ordinary text
    // renders as "This is round 10 of at most 2" — instructing the agent it is over
    // a cap the workflow just deliberately cleared.
    expect(runMandate({ reset: true, round: '10' }).replace(/\s+/g, ' ')).not.toContain('of at most 2');
  });

  it('still sends him to the standing review the cap skipped', () => {
    // A reset happens AFTER the cap, so a third CHANGES_REQUESTED exists and was
    // skipped. The answers take precedence, but a finding orthogonal to the six
    // questions does not stop being true because the developer answered something
    // else — and the prompt's surviving "VERIFY BEFORE YOU FIX / re-derive each one"
    // would otherwise refer to findings he was told not to fetch.
    const m = runMandate({ reset: true });
    expect(m).toContain('--json reviews');
    expect(m.replace(/\s+/g, ' ')).toContain('address any finding the answers do NOT settle');
    // ...but it must not ASSERT that a standing review exists. `reset=true` carries no
    // ROUNDS condition, so a reset below the cap is reachable and `.reviews[-1]` is
    // then the first review, an APPROVE, or null (RA-971, RA-1025). Telling the agent a
    // third review was skipped would be false on that path.
    expect(m.replace(/\s+/g, ' ')).toContain('CHECK WHAT YOU GET BACK');
    expect(m).not.toMatch(/a third review exists/);
  });

  it('orders him to carry a decision into the sections it changes', () => {
    // A decision recorded only in the decisions section is one the implementer
    // never reads — the issues are filed from the other sections.
    expect(runMandate({ reset: true })).toContain('CARRY THE CONSEQUENCES');
  });

  it('still gives the ordinary review mandate when it is not a reset', () => {
    // Collapse the wrapping before matching — the mandate is written to be read at
    // 80 columns and asserting on its line breaks makes a reflow look like a
    // removed instruction.
    const m = runMandate({ reset: false, round: '2' });
    expect(m).toContain('requested changes');
    expect(m.replace(/\s+/g, ' ')).toContain('round 2 of at most 2');
    // Since RA-971 this reads the latest CHANGES-REQUEST rather than the latest
    // review — `.reviews[-1]` is what it used to be, and is the regression to catch.
    expect(m).toContain('select(.state == "CHANGES_REQUESTED")');
    expect(m).not.toContain('DEVELOPER DECISION');
  });
});

describe('the prompt', () => {
  it('tells him to verify a finding before fixing it', () => {
    // A reviewer can be wrong, and a finding fixed by guessing is worse than one
    // disputed with evidence.
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).toMatch(/VERIFY BEFORE YOU FIX/);
    expect(flat).toMatch(/A reviewer can be wrong/);
  });

  it('singles out a finding on an acceptance criterion', () => {
    // The brief's ACs become the issues and the issues become the work, so a wrong
    // number in an AC propagates into everything built from it. That is exactly
    // what happened on the first real brief (RA-964).
    expect(prompt.replace(/\s+/g, ' ')).toMatch(/A FINDING ON AN ACCEPTANCE CRITERION IS THE EXPENSIVE KIND/);
  });

  it('withholds every authority the other modes withhold', () => {
    // Collapse the YAML block scalar's wrapping before matching — the prompt is
    // written to be read at 80 columns, and asserting on its line breaks would
    // make a reflow look like a removed guard.
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).toMatch(/no merging, no issue creation, no labelling/);
    expect(flat).toMatch(/never a `\[seed\]` -> `\[confirmed\]` promotion/);
  });
});

// The repo-wide "gh names the repo before checkout" guard that used to live here covers
// every workflow, not this one — it moved to workflow-gh-repo-before-checkout.test.ts (RA-975).

describe('cost shape', () => {
  it('decides everything it can before minting a token', () => {
    // The trigger is repo-wide; most firings are other people's PRs and must cost
    // Actions seconds, not tokens.
    // Since RA-2592 the filter is a JOB and the invariant is held per job, not per step:
    // the filter job is the only root, it mints nothing, and every other job waits for it
    // and is gated on its `act`. The round record carries the SAME gate wrapped in
    // `always()`, so it still runs after an agent job that FAILED — a run that died is
    // the one that most needs its round recorded.
    // The membership gate (kanon#46) comes first, and `lane-gate.test.ts` holds it there.
    const names = wf.jobs.filter.steps.map((s: { name?: string; uses?: string }) => s.name ?? s.uses);
    expect(names.slice(0, 3)).toEqual(['$/actions/kanon-path', 'Is the actor a member?', 'Should this review be acted on?']);
    for (const st of wf.jobs.filter.steps.slice(3)) {
      expect(st.if).toContain("steps.filter.outputs.act == 'true'");
    }
    expect(names.some((n: string) => /token/i.test(n ?? ''))).toBe(false);
    const others = Object.entries(wf.jobs).filter(([id]) => id !== 'filter') as [string, { needs?: string | string[]; if?: string }][];
    expect(others.map(([id]) => id).sort()).toEqual(['record-round', 'revise']);
    for (const [id, job] of others) {
      expect([job.needs].flat(), `${id} must wait for the filter`).toContain('filter');
      expect(job.if, `${id} must be gated on the filter's decision`).toContain("needs.filter.outputs.act == 'true'");
    }
  });

  it('the filter job publishes, from a real step output, everything the later jobs read (RA-2592)', () => {
    // New with the split: a step output read across a job boundary must be re-published
    // as a JOB output, and a missing or mis-pointed one is silent — the expression yields
    // "" and the Lead revises a blank ref against a blank mandate. The implementer lane
    // carries the same pair of checks (`agent-implement-revise.test.ts`).
    const emits: Record<string, Set<string>> = {};
    for (const st of wf.jobs.filter.steps as { id?: string; run?: string }[]) {
      if (!st.id || !st.run) continue;
      emits[st.id] = new Set([...st.run.matchAll(/echo "(\w+)=/g)].map((m) => m[1]!));
      if (/text<<MANDATE_EOF/.test(st.run)) emits[st.id]!.add('text');
    }
    const outs = wf.jobs.filter.outputs as Record<string, string>;
    for (const [name, expr] of Object.entries(outs)) {
      const m = /steps\.(\w+)\.outputs\.(\w+)/.exec(expr);
      expect(m, `${name} must reference a step output`).not.toBeNull();
      expect([...(emits[m![1]!] ?? [])], `${name} -> ${m![1]} never emits ${m![2]}`).toContain(m![2]);
    }
    const downstream = JSON.stringify([wf.jobs.revise, wf.jobs['record-round']]);
    const read = [...downstream.matchAll(/needs\.filter\.outputs\.(\w+)/g)].map((m) => m[1]);
    expect(read).toEqual(expect.arrayContaining(['act', 'pr', 'branch', 'mandate', 'head_sha', 'marked']));
    for (const k of read) expect(Object.keys(outs), `a later job reads needs.filter.outputs.${k}`).toContain(k);
  });

  it('provisions no database and no browser — a brief is prose (RA-2592)', () => {
    // The lane never had either; converting it onto a spine that defaults both ON must
    // not quietly add a Postgres container and a Chromium install to every revision.
    // Resolved for THIS caller, because the spine itself still has both.
    expect(revise.services).toEqual({});
    const runs = revise.steps.map((s) => s.run ?? '');
    expect(runs.some((r) => r.includes('db:init'))).toBe(false);
    expect(runs.some((r) => r.includes('DATABASE_URL='))).toBe(false);
    expect(runs.some((r) => r.includes('install-playwright-chromium'))).toBe(false);
  });

  it('grants exactly the scopes its calls need, and no more', () => {
    // NOT "minimal" as a number — minimal for what it DOES. The previous version
    // asserted `pull-requests: read` and so locked in the scope that made RA-969's cap
    // comment a swallowed 403: the deliverable degraded to the green-run annotation
    // the issue named as the wrong surface, and a test guarded the mistake.
    //
    // A permissions block sets every unlisted scope to `none`, so each of these is
    // load-bearing and the pair is coupled: granting the write WITHOUT `issues: read`
    // leaves `SEEN` empty, and the cap comment posts on every re-fire — worse than
    // the 403, because it is noise a human learns to ignore.
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'write', issues: 'read' });
  });
});

const CAP_AUTHOR = 'app/example-lead';

describe('the cap binds on a round that left no marker (RA-969, RA-1099)', () => {
  /**
   * The cap was counted from a marker the AGENT is asked to leave, bounding the
   * agent's own iteration. Two ways that under-counts, both leaving the loop live:
   *
   *   • the round pushed and ended without the marker — max-turns, a failed `gh`, the
   *     model not doing the last step;
   *   • the marker landed where the counter cannot see it. `--json comments` is the
   *     GraphQL IssueComment connection — top-level comments only, no review bodies
   *     and no thread replies — while the prompt routes two exits to a "reply" (RA-1099).
   *
   * The loop is closed and re-fires on every push, so an unadvanced cap means two Opus
   * agents iterating without a bound. The floor is the REVIEWER's count — since RA-1841
   * the count of DISTINCT PATCHES he faulted, not of his reviews. That is weaker than
   * RA-969's "no agent behaviour changes it": the agent moves it by pushing content, and
   * a run that pushed and then crashed before leaving a marker used to raise neither
   * count. Since RA-1981 the WORKFLOW leaves the marker in that case — pinned by
   * `revise-round-record.test.ts`. The cases below are the floor's own half — a
   * reviewer faulting three DIFFERENT patches binds the cap whether or not a marker
   * was ever left.
   */
  it('stops after two reviewer requests even with ZERO markers', () => {
    // The RA-969 shape exactly: three CHANGES_REQUESTED reviews, no marker ever left.
    // Counted by markers this is round 0 and revise fires again, forever.
    expect(runFilter({ author: CAP_AUTHOR, rounds: 0, changesRequested: 3 }).act).toBe(false);
  });

  it('still acts on a genuine first round', () => {
    // One CHANGES_REQUESTED — the one that triggered this run — is zero prior rounds.
    expect(runFilter({ author: CAP_AUTHOR, rounds: 0, changesRequested: 1 }).act).toBe(true);
  });

  it('still acts on a second round', () => {
    expect(runFilter({ author: CAP_AUTHOR, rounds: 0, changesRequested: 2 }).act).toBe(true);
  });

  it('takes the LARGER of the two counts, never the smaller', () => {
    // Biased toward over-counting, which is `dispatch-sweep`'s direction: stopping
    // early costs a dispatch, stopping late costs an unbounded loop. Markers ahead of
    // reviews must not be pulled down by the review floor.
    expect(runFilter({ author: CAP_AUTHOR, rounds: 2, changesRequested: 1 }).act).toBe(false);
  });

  it('reports both numbers, so a disagreement between them is visible', () => {
    const { stdout } = runFilter({ author: CAP_AUTHOR, rounds: 0, changesRequested: 3 });
    expect(stdout).toMatch(/markers=0/);
    expect(stdout).toMatch(/changes-requested=3/);
  });
});

describe('a content-free rebase is neither an answer nor a round (RA-1841)', () => {
  /**
   * MEASURED ON THE IMPLEMENTER LANE, FIXED ON BOTH. PR RA-1822 had three heads carrying
   * one patch — two of them produced by GitHub's "Update branch" button — and both reads
   * in that filter asked whether the SHA had moved rather than whether the CONTENT had:
   * the label path discarded a changes-request nobody had answered, and `REQUESTED`
   * counted all three anyway, so at 3 requests and 0 markers the cap stopped a PR the
   * agent had never once been dispatched on.
   *
   * This lane carries that filter verbatim, so it carried the defect verbatim. A brief
   * PR is docs-only and `agent-review.yml` re-reviews every push, which makes the
   * exposure larger here, not smaller.
   */
  const LEAD_AUTHOR = 'app/example-lead';
  const HEAD = 'ffffffffffffffffffffffffffffffffffffffff';
  const OLD = '1111111111111111111111111111111111111111';

  it('keeps a changes-request standing when the head moved but the patch did not', () => {
    const r = runFilter({
      author: LEAD_AUTHOR, isLabel: true, headRefOid: HEAD, samePatch: true,
      reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: OLD } }],
    });
    expect(r.act).toBe(true);
  });

  it('still lets a real push answer it, which is what the SHA check was protecting', () => {
    // Unchanged behaviour, and the reason the fingerprint is not simply "ignore the
    // sha": a churn may not re-fire against a review the Lead answered with a push.
    const r = runFilter({
      author: LEAD_AUTHOR, isLabel: true, headRefOid: HEAD,
      reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: OLD } }],
    });
    expect(r.act).toBe(false);
    expect(r.stdout).toContain('no changes-request stands');
  });

  it('counts three requests against one unchanged patch as ONE round, not three', () => {
    const r = runFilter({ author: CAP_AUTHOR, rounds: 0, changesRequested: 3, samePatch: true });
    expect(r.act).toBe(true);
    expect(r.stdout).toContain('changes-requested=1 distinct of 3');
  });

  it('still reaches the cap when three DIFFERENT patches were faulted', () => {
    // The loop RA-969 closed stays closed whenever the agent produced new content to fault.
    expect(runFilter({ author: CAP_AUTHOR, rounds: 0, changesRequested: 3 }).act).toBe(false);
  });

  it('still counts a round the agent spent DISAGREEING, which changes no content', () => {
    // The marker floor is what makes lowering the content count safe: a round that
    // pushed nothing is invisible to the patch and visible to `MARKED`.
    expect(runFilter({ author: CAP_AUTHOR, rounds: 2, changesRequested: 3, samePatch: true }).act).toBe(false);
  });

  it('degrades to the SHA when the diff cannot be read, which is the old behaviour', () => {
    // FAILS TOWARD OVER-COUNTING. Nothing here may LOWER the cap on a guess.
    const r = runFilter({
      author: CAP_AUTHOR, rounds: 0, changesRequested: 3, samePatch: true, readableDiffs: false,
    });
    expect(r.act).toBe(false);
    expect(r.stdout).toContain('changes-requested=3 distinct of 3');
  });

  it('reads the patch from the compare API, since this step runs before checkout', () => {
    // `git patch-id` is the right tool and is not reachable: the filter step runs
    // before checkout on purpose, so an unrelated review costs Actions seconds rather
    // than a minted token and a clone.
    expect(filter.run).toContain('/compare/');
    expect(filter.run).toContain('vnd.github.v3.diff');
  });

  it('asks the PR for the base the compare is rooted at', () => {
    // A three-dot compare against the base branch is what makes the patch at a commit
    // the base has since moved past still read as it was reviewed. Without
    // `baseRefName` in the META query the ref is empty and every fingerprint degrades.
    expect(filter.run).toContain('baseRefName');
    expect(filter.run).toContain('$BASE_REF...$sha');
  });
});

describe("only the agent's own marker consumes a round (RA-969)", () => {
  it("does not count a human's comment that merely quotes the marker", () => {
    // A developer discussing this mechanism in the PR wrote the marker in prose, and
    // the unfiltered `contains(...)` counted it. Two such comments capped a project
    // whose agent had revised nothing.
    const quoted = Array.from({ length: 3 }, () => ({
      author: { login: 'a-developer' },
      body: 'the cap counts <!-- qa:lead-revise --> markers',
    }));
    const r = runFilter({ author: CAP_AUTHOR, rounds: 0, changesRequested: 1, comments: quoted });
    expect(r.act, "a human quoting the marker must not spend the agent's rounds").toBe(true);
  });
});

describe('the mandate reads the review it was fired for (RA-971, RA-1026)', () => {
  /**
   * `.reviews[-1]` is the wrong read and was the shipped one. Reviews accumulate, and
   * the last is frequently not the request that fired this run: the reviewer may post
   * a COMMENT after his verdict — a standalone inline comment makes one (the playbook
   * permitted it on a red check until RA-2299), and 19 of his last 96 reviews were
   * COMMENTED — or an APPROVE may sit on an earlier commit.
   * Revising against the wrong review answers findings nobody raised and leaves the
   * real ones untouched.
   */
  it('selects the latest CHANGES_REQUESTED, not the latest review', () => {
    const m = runMandate({ reset: false });
    expect(m).toMatch(/select\(\.state == "CHANGES_REQUESTED"\)/);
    expect(m, '`.reviews[-1]` takes whatever landed last').not.toMatch(/reviews\[-1\]/);
  });

  it('the reset mandate reads it the same way', () => {
    const m = runMandate({ reset: true });
    expect(m).toMatch(/select\(\.state == "CHANGES_REQUESTED"\)/);
    expect(m).not.toMatch(/reviews\[-1\]/);
  });

  it('the reset mandate does not assert a standing changes-request (RA-1026)', () => {
    // It said "a review was filed and skipped" unconditionally, while a reset below
    // the cap is permitted and may find no review at all — or an approve.
    const m = runMandate({ reset: true });
    expect(m).toMatch(/may be dispatched at any round count|do not assume a standing/i);
    expect(m, 'the agent must be told what it may actually find').toMatch(/there may be none at all|may be an\s+approve/i);
  });
});

describe('the cap escalation can actually post (RA-969, RA-1205 review)', () => {
  /**
   * RA-969 asked that "this belongs with the developer" surface where the developer
   * reads it. The comment shipped with `pull-requests: read` and a `|| echo
   * "::warning::"` around the call, so the 403 was swallowed and the deliverable
   * degraded silently back to the green-run annotation the issue named as the wrong
   * surface. A shipped feature made INERT rather than wrong is the hardest state to
   * notice later, and the workflow's own tests locked the wrong scope in.
   */
  const step: string = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'filter').run;

  it('has write on the scope the comment needs', () => {
    expect(wf.permissions['pull-requests']).toBe('write');
  });

  it('has issues:read, without which the idempotence marker is never found', () => {
    // The two are coupled. `gh pr view --json comments` reads Issues, so without this
    // `SEEN` is always empty and the "post once" guard posts every time — which is
    // worse than the 403, because noise is what a human learns to ignore.
    expect(wf.permissions.issues).toBe('read');
  });

  it('reads the existing comments before posting, and keys on its own marker', () => {
    expect(step).toContain('qa:lead-revise-capped');
    // No `s` flag — this file targets a lib without it. `[\s\S]` is the portable form.
    expect(step, 'the guard must read before it writes').toMatch(/SEEN=[\s\S]*--json comments/);
  });

  it('says how to resume, since a cap nobody can clear is a deadlock', () => {
    expect(step).toMatch(/reset=true/);
  });
});

describe('the re-delivery path for an unanswered changes-request (RA-1595)', () => {
  const LEAD_AUTHOR = 'app/example-lead';
  const HEAD = 'ffffffffffffffffffffffffffffffffffffffff';
  const OLD = '1111111111111111111111111111111111111111';

  it('subscribes to the label the recovery churns, and to nothing wider', () => {
    // `pull_request_review` fires ONCE. If this workflow did not run for it — a cap,
    // an outage, a dropped queue — nothing re-fired the Lead and the brief PR parked
    // on the developer's own gate. The label is the re-delivery, and it is a label
    // rather than `gh workflow run` because the Lead holds `Actions: No access`
    // deliberately (agent-identities.md footnote 2, RA-1281).
    //
    // The triggers are the CALLER's since the lane moved to Kanon (plan 0001 §3): the lane
    // is called, and the fixture adopter's caller, which is the shape an adopter copies,
    // subscribes to exactly these. The adopter's own caller is held to it in the adopter.
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    expect(Object.keys(wf.on.workflow_call.inputs).sort()).toEqual(['pr_number', 'reset']);
    const caller = parse(readFileSync(join(process.cwd(), 'tests/fixtures/lane-check/adopter/.github/workflows/agent-lead-revise.yml'), 'utf8'));
    expect(Object.keys(caller.on).sort()).toEqual(['pull_request', 'pull_request_review', 'workflow_dispatch']);
    expect(caller.on.pull_request.types).toEqual(['labeled']);
  });

  it('gates the JOB on the marker, so a foreign label event concludes `skipped`', () => {
    // NOT ONLY IN THE SCRIPT. An in-script skip exits 0 and the RUN concludes
    // `success` — and the recovery's only bound is "does a revise run exist for this
    // head". A brief PR collects `review:please` at open and `agent:reviewer` on its
    // first review, both on the head the first changes-request lands on. Left to skip
    // in-script those would manufacture a green run on exactly the head the recovery
    // exists for and suppress it.
    // On the FILTER job since RA-2592 — the only root job, so a false gate there skips the
    // whole run (every other job needs it).
    expect(wf.jobs.filter.if).toContain(`github.event.label.name == '${filter.env.REVISE_LABEL}'`);
    expect(wf.jobs.filter.if).toContain("github.event_name == 'pull_request'");
  });

  it('gates the review arm at the job too, so a COMMENTED verdict leaves no green run', () => {
    // The local half of RA-1594: a `COMMENTED` or `APPROVED` review used to reach the
    // filter, skip in-script and conclude `success`, which is indistinguishable from a
    // delivered revision to anything counting runs for a head.
    expect(wf.jobs.filter.if).toContain("github.event.review.state == 'changes_requested'");
  });

  it('acts on a churn when a changes-request stands on the current head', () => {
    const r = runFilter({ author: LEAD_AUTHOR, isLabel: true, headRefOid: HEAD });
    expect(r.act).toBe(true);
  });

  it('does NOT act when the standing verdict on the head is an approve', () => {
    // Stricter than the event path, not looser: a churn cannot re-fire against a
    // review the Lead has already answered with a push.
    const r = runFilter({
      author: LEAD_AUTHOR, isLabel: true, headRefOid: HEAD,
      reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: HEAD } }, { state: 'APPROVED', commit: { oid: HEAD } }],
    });
    expect(r.act).toBe(false);
    expect(r.stdout).toContain('no changes-request stands');
  });

  it('does NOT act when the only changes-request is on an older head', () => {
    const r = runFilter({
      author: LEAD_AUTHOR, isLabel: true, headRefOid: HEAD,
      reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: OLD } }],
    });
    expect(r.act).toBe(false);
  });

  it('ignores a label that is not the marker', () => {
    const r = runFilter({ author: LEAD_AUTHOR, isLabel: true, labelAdded: 'review:please' });
    expect(r.act).toBe(false);
    expect(r.stdout).toContain('is not agent:lead-revise');
  });

  it('still honours the round cap on the label path', () => {
    // RA-1595's first constraint. The cap is `max(distinct patches faulted - 1, markers)`
    // (RA-1841) — derived from the world, not incremented per run — so a re-delivery re-delivers
    // the SAME round rather than spending one, and a capped PR stays capped whichever
    // door the event came through.
    const r = runFilter({ author: LEAD_AUTHOR, isLabel: true, headRefOid: HEAD, rounds: 2, changesRequested: 3 });
    expect(r.act).toBe(false);
    expect(r.stdout).toContain('round cap reached');
  });

  it('applies the same author and brief-file guards to a churn', () => {
    expect(runFilter({ author: 'someone-else', isLabel: true }).act).toBe(false);
    expect(runFilter({ author: LEAD_AUTHOR, isLabel: true, files: ['src/x.ts'] }).act).toBe(false);
  });
});

describe('the login is read from the App register (plan 0001 §5)', () => {
  const LEAD = `app/${LEAD_LOGIN}`;

  it('acts for the slug the register gives, and publishes it for the round record', () => {
    const r = runFilter({ author: LEAD });
    expect(r.act).toBe(true);
    expect(r.outputs.login).toBe(LEAD_LOGIN);
  });

  it('follows the register, not a constant: another slug there turns the same author away', () => {
    const r = runFilter({ author: LEAD, register: REGISTER_FIXTURE.replace(`\`${LEAD_LOGIN}\``, '`someone-else`') });
    expect(r.act).toBe(false);
  });

  it.each([
    ['no register at all', ''],
    ['no row for the role', REGISTER_FIXTURE.replace(/^\| Lead .*\n/m, '')],
  ])('fails the job by name on %s, never skips silently', (_, register) => {
    const r = runFilter({ author: LEAD, register });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('::error title=App register::');
    expect(r.outputs.act).toBeUndefined();
  });
});
