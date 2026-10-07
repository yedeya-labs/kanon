import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { callsSpine, jobPrompt, spineJobFor } from './helpers/spine.js';
import { comparePatch, GH_COMPARE_ARM } from './helpers/compare-diff.js';
import { writeStub } from './helpers/stub-bin.js';
import { GH_REGISTER_ARM, IMPLEMENTER_LOGIN, REGISTER_FIXTURE, registerEnv } from './helpers/register.js';
import { SPAWNS } from './helpers/spawns.js';

// Its cases run the lane's steps in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

/**
 * RA-1077 — the Implementer's revise mode.
 *
 * The gap: `agent-implement.yml` fires on `issues: [labeled]` only, so a
 * CHANGES_REQUESTED on an implementer's PR re-invoked nothing. Found on the pilot,
 * where PR RA-1057 sat six hours after its review while THREE detectors reported the
 * project healthy — no trigger existed, the reconciler said "WIP cap reached
 * (1/1)" hourly, and the sweep saw `has-pr` and correctly skipped it.
 *
 * These EXECUTE the filter step rather than asserting on its source, because
 * RA-1032 is what the alternative costs: a workflow that had never once succeeded
 * while its tests stayed green.
 */
const wf = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-implement-revise.yml'), 'utf8'));
const filter = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'filter');
// The prompt stays in the lane (RA-2592): it is the `prompt` input the revise job passes the spine.
const prompt: string = jobPrompt(wf.jobs.revise);
// What the revise job RUNS — `agent-lane.yml`, resolved for this lane's inputs.
const revise = spineJobFor(wf.jobs.revise);
const mandateStep = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'mandate');

/**
 * Run a step and REQUIRE it to succeed. Under `bash -c` a step that exits non-zero
 * mid-body carried on and the suite passed; under the runner's `-e` it aborts, so the
 * status is now part of every assertion rather than discarded (RA-1044).
 */
const runStepOrThrow = (step: Parameters<typeof runWorkflowStep>[0], opts: Parameters<typeof runWorkflowStep>[1]) => {
  const r = runWorkflowStep(step, opts);
  expect(r.status, `the step aborted under the runner's shell: ${r.output}`).toBe(0);
  return r;
};

/** Run the SHIPPED mandate step and return what it put in `outputs.text`. */
const runMandate = ({ reset, round = '3' }: { reset: boolean; round?: string }) => {
  const r = runWorkflowStep(mandateStep, {
    env: { RESET: String(reset), PR: '1057', ROUND: round, REPO: 'example-org/example-repo' },
  });
  // The step must not merely produce the right text — it must SUCCEED under the
  // runner's `-e`, which is what `bash -c` was hiding (RA-1044).
  expect(r.status, `mandate step aborted: ${r.output}`).toBe(0);
  return r.outputFile.replace(/^text<<MANDATE_EOF\n/, '').replace(/MANDATE_EOF\n?$/, '');
};

const GH_STUB = `#!/usr/bin/env bash
# Generic on purpose: dispatches on the requested --json fields and passes any
# --arg through to the real jq, exactly as gh does. A stub shaped per test case
# would smuggle the expected answer into the fixture.

# \`gh api repos/O/R/compare/BASE...SHA\` under the diff media type — the PR's effective
# patch at a commit, which is what the content fingerprint hashes (RA-1841).
# The App register, which the filter reads its login from (plan 0001 §5).
${GH_REGISTER_ARM}

# Before the compare arm, which answers every other api call.
# The head's commit statuses, for the implementer-status chain (plan 0005 §3.3, L4): by
# default the Author App's \`kanon/role: implementer\` success; a test sets STUB_STATUSES.
DEFAULT_STATUSES='[{"context":"kanon/role: implementer","state":"success","creator":{"login":"example-author[bot]"}}]'
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == */statuses* ]]; then
  [ "\${STUB_STATUSES:-}" = "fail" ] && { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }
  printf '%s' "\${STUB_STATUSES:-$DEFAULT_STATUSES}"; exit 0
fi

${GH_COMPARE_ARM}


json=""; jqexpr=""; prev=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --json) json="$2"; shift 2 ;;
    --jq) jqexpr="$2"; shift 2 ;;
    --arg) args+=(--arg "$2" "$3"); shift 3 ;;
    *) shift ;;
  esac
done
case "$json" in
  *comments*) payload="$STUB_COMMENTS" ;;
  # The reviewer's CHANGES_REQUESTED reviews, which the cap floors on (RA-969/RA-1099) —
  # since RA-1841 fingerprinted down to the DISTINCT PATCHES they faulted.
  *reviews*)  payload="$STUB_REVIEWS" ;;
  *) payload="$STUB_META" ;;
esac
if [ -n "$jqexpr" ]; then printf '%s' "$payload" | jq -r "\${args[@]}" "$jqexpr"; else printf '%s' "$payload"; fi
`;

const HEAD_OID = 'deadbeefcafe1234';

const runFilter = ({
  author = 'app/example-author',
  labels = ['agent:implement'],
  prState = 'OPEN',
  reviewState = 'changes_requested',
  rounds = 0,
  // CHANGES_REQUESTED reviews on the PR. Defaults to `rounds + 1` — the one that
  // triggered this run plus one per prior revision, which is what a healthy loop
  // produces. Set independently to model RA-969: a round that pushed, and ended
  // without leaving the marker the cap used to be counted from.
  changesRequested = rounds + 1,
  isDispatch = false,
  reset = false,
  // RA-1524's re-delivery path: a `pull_request: [labeled]` event, which carries no
  // review payload at all — so the standing verdict is read from the PR.
  isLabel = false,
  labelAdded = 'agent:revise',
  headVerdict = 'CHANGES_REQUESTED',
  // Where the head sits relative to the reviewed commits (RA-1841).
  //   false            — the last changes-request is ON the head, the ordinary case.
  //   'content-free'   — PR RA-1822's shape: the head moved past every reviewed commit
  //                      and carries the SAME patch. Three presses of "Update branch",
  //                      not one revision.
  //   'revised'        — the head moved past them carrying a DIFFERENT patch, which is
  //                      what answering a review with a push looks like.
  headMoved = false as false | 'content-free' | 'revised',
  // The compare API not answering — a deleted commit, a truncated diff. The
  // fingerprint must then degrade to the SHA, which is the pre-RA-1841 behaviour.
  readableDiffs = true,
  // The head's commit statuses as the API lists them (plan 0005 §3.3, L4); unset is the
  // Author App's implementer status, and `fail` a denied read.
  statuses = '',
}: Partial<{
  author: string; labels: string[]; prState: string; reviewState: string;
  rounds: number; changesRequested: number; isDispatch: boolean; reset: boolean;
  isLabel: boolean; labelAdded: string; headVerdict: string;
  headMoved: false | 'content-free' | 'revised'; readableDiffs: boolean; statuses: string;
}> = {}) => {
  // ONE HEAD PER CHANGES-REQUEST, because a review is filed against a commit and a
  // healthy loop reviews a new one each round. The old fixture put every review on the
  // head oid, which the review path could ignore and the content count cannot.
  const crShas = Array.from({ length: changesRequested }, (_, i) =>
    (!headMoved && i === changesRequested - 1) ? HEAD_OID : `sha-${i}`);
  const diffs: Record<string, string> = {};
  for (const [i, s] of [...crShas, HEAD_OID].entries()) {
    diffs[s] = headMoved === 'content-free'
      ? comparePatch({ content: 'rows.filter(Boolean)', churn: 'a'.repeat(i + 1) })
      : comparePatch({ content: `rows.slice(${i})` });
  }

  const dir = mkdtempSync(join(tmpdir(), 'impl-revise-'));
  writeStub(join(dir, 'gh'), GH_STUB);
  const r = runStepOrThrow(filter, {
    dir,
    env: {
      PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
      REPO: 'example-org/example-repo',
      ...registerEnv(filter),
      PR: '1057',
      // A workflow_dispatch carries no review, so this interpolates EMPTY.
      STATE: isDispatch || isLabel ? '' : reviewState,
      IS_DISPATCH: String(isDispatch),
      IS_LABEL: String(isLabel),
      LABEL_ADDED: isLabel ? labelAdded : '',
      REVISE_LABEL: 'agent:revise',
      RESET: isDispatch ? String(reset) : '',
      STUB_STATUSES: statuses,
      STUB_META: JSON.stringify({
        author: { login: author },
        state: prState,
        headRefName: 'docs/1049-payments-transition-table',
        baseRefName: 'main',
        headRefOid: HEAD_OID,
        labels: labels.map((name) => ({ name })),
      }),
      STUB_DIFFS: readableDiffs ? JSON.stringify(diffs) : '',
      STUB_REVIEWS: JSON.stringify({
        // `commit.oid` decides both halves now: whether a verdict still stands on the
        // head's CONTENT, and how many distinct patches were faulted (RA-1841).
        reviews: [
          ...crShas.map((oid) => ({ state: 'CHANGES_REQUESTED', commit: { oid } })),
          ...(headVerdict && headVerdict !== 'CHANGES_REQUESTED'
            ? [{ state: headVerdict, commit: { oid: HEAD_OID } }]
            : []),
        ],
      }),
      STUB_COMMENTS: JSON.stringify({
        // Authored by the implementer — the cap counts HIS markers, not anyone's.
        comments: Array.from({ length: rounds }, () => ({
          author: { login: 'example-author' },
          body: '<!-- qa:implement-revise -->',
        })),
      }),
    },
  });

  const { outputs, summary } = r;
  return { act: outputs.act === 'true', outputs, stdout: r.stdout, summary };
};

describe('what it acts on', () => {
  it('acts on a changes-request on the implementer\'s own labelled PR', () => {
    // The exact shape of PR RA-1057, which sat six hours because nothing fired.
    expect(runFilter().act).toBe(true);
  });

  describe('the re-delivery path (RA-1524)', () => {
    // `pull_request_review` fires ONCE. If this workflow does not run for it — a cap,
    // an outage, a dropped queue — nothing re-fires the implementer and the PR parks
    // on an unanswered changes-request. The reconciler churns `agent:revise` to
    // re-deliver it, which is a label rather than a dispatch because the Lead holds
    // no Actions write (its row in `rulebook/03-agents.md`).
    it('acts on a label event when a changes-request stands on the head', () => {
      expect(runFilter({ isLabel: true }).act).toBe(true);
    });

    it('ignores a label that is not the marker', () => {
      // Any label event on the PR reaches this workflow, so the marker is the gate.
      expect(runFilter({ isLabel: true, labelAdded: 'needs:human' }).act).toBe(false);
    });

    it.each([
      ['APPROVED', false],
      ['COMMENTED', true],
    ])('a standing %s on the head -> acts: %s', (headVerdict, expected) => {
      // READ FROM THE PR, NOT THE EVENT — a label event carries no review payload,
      // and reading the PR is STRICTER than trusting one: it asks whether a
      // changes-request still STANDS, so a churn cannot re-fire against a review the
      // implementer already answered with a push. `COMMENTED` is not a deciding
      // verdict (RA-1081), so the earlier CHANGES_REQUESTED still stands.
      expect(runFilter({ isLabel: true, headVerdict }).act).toBe(expected);
    });

    it('still honours the round cap on the label path', () => {
      // A re-delivery must not become a way around the cap.
      expect(runFilter({ isLabel: true, rounds: 2 }).act).toBe(false);
    });
  });

  it.each([
    ['changes_requested', true],
    ['commented', false],
    ['approved', false],
  ])('a %s verdict -> acts: %s', (reviewState, expected) => {
    // RA-378: the Reviewer posts COMMENT while a check is pending, and that comment can
    // carry an approve. Acting on it would revise a PR nobody faulted.
    expect(runFilter({ reviewState }).act).toBe(expected);
  });

  it.each([
    ['app/example-author', true],
    ['example-author', true],
    ['example-author[bot]', true],
    ['app/example-judge', false], // the Judge's: another App
    ['a-developer', false],
  ])('author %s -> acts: %s', (author, expected) => {
    // One identity, three spellings, three endpoints. RA-1007 was exactly this and
    // left revise mode inert for two days, failing closed and saying why.
    expect(runFilter({ author }).act).toBe(expected);
  });

  it.each([
    [['agent:implement'], true],
    [['agent:triage'], true],
    [['review:please'], false],
    [[], false],
  ])('labels %j -> acts: %s', (labels, expected) => {
    // Scoped to the label that CLAIMS this pipeline produced the PR. A human PR
    // never claimed an implementer wrote it.
    expect(runFilter({ labels }).act).toBe(expected);
  });

  it.each([['OPEN', true], ['CLOSED', false], ['MERGED', false]])('a %s PR -> acts: %s', (prState, expected) => {
    expect(runFilter({ prState }).act).toBe(expected);
  });

  it('acts on a manual dispatch, where there is no review state at all', () => {
    // A dispatch carries no review, so `github.event.review.state` interpolates
    // empty and the verdict guard would skip every manual run — RA-1007's failure
    // mode, on the path that exists to RECOVER from it.
    expect(runFilter({ isDispatch: true }).act).toBe(true);
  });
});

describe('the round cap', () => {
  it.each([[0, true], [1, true], [2, false], [3, false]])('%i prior revisions -> acts: %s', (rounds, expected) => {
    expect(runFilter({ rounds }).act).toBe(expected);
  });

  it('warns loudly when it gives up, and names the way back', () => {
    const { stdout } = runFilter({ rounds: 2 });
    expect(stdout).toContain('::warning');
    expect(stdout).toContain('reset=true');
  });

  it('an explicit reset clears the cap', () => {
    expect(runFilter({ rounds: 3, isDispatch: true, reset: true }).act).toBe(true);
  });

  it('refuses to let a non-dispatch path clear the cap', () => {
    // A review event cannot set an input today — so only an adversarial fixture
    // can prove the IS_DISPATCH half is load-bearing rather than incidental.
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-adv-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary'), '');
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: 'true',
        STUB_META: JSON.stringify({ author: { login: 'app/example-author' }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [
          { author: { login: 'example-author' }, body: '<!-- qa:implement-revise -->' },
          { author: { login: 'example-author' }, body: '<!-- qa:implement-revise -->' },
        ] }),
      },
    });
    expect(r.status, `step aborted: ${r.output}`).toBe(0);
    expect(r.outputFile).toContain('act=false');
  });

  it('does not announce a bypass that never happened', () => {
    const { act, summary } = runFilter({ rounds: 0, isDispatch: true, reset: true });
    expect(act).toBe(true);
    expect(summary).not.toContain('Round cap cleared');
  });
});

describe('the prompt', () => {
  const flat = prompt.replace(/\s+/g, ' ');

  it('leaves the checks-vs-review ordering to the mandate step', () => {
    // It moved there when the mandate branched on `reset` (RA-1024's shape): a reset
    // run must NOT be sent to the checks-then-review script at all. Asserted in
    // "the mandate a reset run receives" below, per branch, by executing it.
    expect(prompt).toContain('needs.filter.outputs.mandate');
    expect(prompt).not.toContain('gh pr checks');
  });

  it('tells him to verify a finding before fixing it', () => {
    expect(flat).toMatch(/VERIFY BEFORE YOU FIX/);
    expect(flat).toMatch(/A reviewer can be wrong/);
  });

  it('forbids widening the issue on a review finding', () => {
    expect(flat).toMatch(/A review finding does not widen the issue/);
  });

  it('requires the marker on EVERY exit, including a bail', () => {
    // A bail comments and stops. Without the marker that round is one the cap never
    // sees, so hitting a guardrail is precisely when the loop becomes unbounded —
    // the opposite of what a guardrail is for.
    expect(flat).toMatch(/EVERY EXIT LEAVES THE MARKER/);
    expect(flat).toMatch(/comment with the failure — WITH THE MARKER — and STOP/);
  });

  it('pins the marker to a TOP-LEVEL comment, which is the only surface the cap reads (RA-1099)', () => {
    // `gh pr view --json comments` is the IssueComment connection: top-level only.
    // A marker in a review body or a thread reply is invisible to it, and the
    // instructions route two exits to a "reply" — the natural reading of which is
    // exactly the surface that does not count.
    expect(flat).toMatch(/TOP-LEVEL PR COMMENT/);
    expect(flat).toMatch(/gh pr comment/);
    expect(flat, 'the prompt must say why, or the next edit will undo it').toMatch(/IssueComment connection/);
    expect(flat, 'and must redirect the "reply" wordings').toMatch(/where the instructions below say "reply", answer in a top-level comment/i);
  });

  it('requires the marker even when nothing changed, or the cap resets', () => {
    expect(prompt).toContain('<!-- qa:implement-revise -->');
    expect(flat).toMatch(/must be present even if you changed nothing/);
  });

  it('requires the gates before pushing', () => {
    expect(flat).toMatch(/RUN THE GATES BEFORE YOU PUSH/);
  });

  it('carries the SCOPE-FIRST BAIL list, like the mode it revises', () => {
    // Revise mode has Read/Edit/Write/Bash, 300 turns (150 until RA-2207), a
    // checked-out branch, push
    // rights and — since RA-1079 gave it the integration tier — a DATABASE. It had
    // none of the guardrails `agent-implement.yml` carries (RA-1085). I gave it a
    // database and not the rules that come with one.
    expect(flat).toMatch(/SCOPE-FIRST BAIL/);
    expect(flat).toMatch(/DATA migration/);
    expect(flat).toMatch(/AUTH \/ credential \/ security change/);
    expect(flat).toMatch(/DESTRUCTIVE schema/);
  });

  it('says a review finding is not an authorisation to widen scope', () => {
    // The difference from implementer mode, and the reason copying its prompt
    // verbatim would be wrong: there a HUMAN wrote the acceptance criteria. Here a
    // reviewer asked for something, and a finding needing a data migration or an
    // auth change is a finding that needs a human.
    expect(flat).toMatch(/A REVIEW FINDING IS NOT AN AUTHORISATION/);
  });

  it('fails closed on a schema change, by the project\'s own procedure and checks (kanon#36)', () => {
    // A schema change that skips the project's procedure, or its isolation checks, is
    // how data isolation regresses silently. Which commands those are is the project's
    // (`docs/qa/stack.md`, K-LAYOUT-17); that the agent fails closed on them is Kanon's.
    expect(flat).toMatch(/follow the stack document's `## Schema changes` section exactly/);
    expect(flat).toMatch(/RUN THE CHECKS its `## Data isolation` section names/);
    expect(flat).toMatch(/do NOT push: comment with the failure — WITH THE MARKER — and STOP/);
  });

  it('points at the playbook rather than restating it as the source of truth', () => {
    expect(flat).toMatch(/docs\/qa\/triage-fix-playbook\.md/);
    expect(flat).toMatch(/the playbook is the source of truth if they ever disagree/);
  });

  it('withholds every authority the other modes withhold', () => {
    expect(flat).toMatch(/no merging, no closing issues, no labelling/);
    expect(flat).toMatch(/no promoting a `\[seed\]` invariant/);
  });
});

describe('revise in place', () => {
  it('checks out the PR branch the filter resolved', () => {
    // Both halves (RA-2592): the lane passes the branch, and the spine's checkout uses it.
    expect(callsSpine(wf.jobs.revise)).toBe(true);
    expect(wf.jobs.revise.with.ref).toContain('needs.filter.outputs.branch');
    const checkout = revise.steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.ref).toBe('${{ inputs.ref }}');
    // With history: the agent merges `main` into the branch to clear a red check.
    expect(checkout?.with?.['fetch-depth']).toBe('${{ inputs.fetch-depth }}');
    expect(revise.inputs['fetch-depth']).toBe(0);
    // And the row names the PR it was spent on — there is no issue to name instead.
    expect(wf.jobs.revise.with['pr-number']).toBe('${{ needs.filter.outputs.pr }}');
    expect(revise.steps.find((s) => s.uses?.includes('actions/agent-telemetry'))?.with?.pr_number)
      .toBe('${{ inputs.pr-number }}');
    expect(runFilter().outputs.branch).toBe('docs/1049-payments-transition-table');
  });

  it('receives the App token before checkout, so the push credential is the App token (minted in the key-holding job of the spine, kanon#274)', () => {
    const names = revise.steps.map((s) => s.name ?? s.uses);
    const checkout = revise.steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(names.indexOf('Receive the App token'))
      .toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Receive the App token'))
      .toBeLessThan(names.findIndex((n) => n?.startsWith('actions/checkout')));
    expect(checkout?.with?.token).toBe('${{ steps.app-token.outputs.token }}');
    // And it is THIS lane's App: the Implementer's identity, which the round count filters on.
    expect(wf.jobs.revise.secrets['app-id']).toBe('${{ secrets.AUTHOR_APP_ID }}');
  });

  it('serialises revisions of one PR', () => {
    expect(wf.concurrency.group).toContain('agent-implement-revise-');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('grants issues:read, without which the round cap never fires', () => {
    // A permissions block sets every unlisted scope to `none`, so the comment read
    // returns empty — which reads as "no prior rounds" and unbounds the loop.
    // Third occurrence of this shape in the repo (RA-957).
    // `statuses: read` for the implementer-status chain (plan 0005 §3.3, L4).
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', issues: 'read', statuses: 'read' });
  });
});

describe('plan 0005 L4: it revises only a PR in the implementer-status chain', () => {
  const status = (creator: string, state = 'success') =>
    JSON.stringify([{ context: 'kanon/role: implementer', state, creator: { login: creator } }]);

  it('acts on a head that carries the Author App\'s implementer status (the control)', () => {
    expect(runFilter({ statuses: status('example-author[bot]') }).act).toBe(true);
  });

  it('refuses a FORGED one by name: the Author\'s login, the label, and no status on its head', () => {
    const r = runFilter({ statuses: '[]' });
    expect(r.act).toBe(false);
    expect(r.summary).toMatch(/not provably the Implementer's: it carries no `kanon\/role: implementer` status/);
  });

  it('refuses one whose newest status another App created, or failed', () => {
    expect(runFilter({ statuses: status('example-ci[bot]') }).act).toBe(false);
    expect(runFilter({ statuses: status('example-author[bot]', 'failure') }).act).toBe(false);
  });

  it('refuses when the statuses can\'t be read, rather than revising on an unread answer', () => {
    const r = runFilter({ statuses: 'fail' });
    expect(r.act).toBe(false);
    expect(r.summary).toMatch(/could not be read/);
  });
});


describe('the mandate a reset run receives (RA-1023, RA-1024)', () => {
  /**
   * THE GATE IS ONLY HALF OF IT. A reset run handed the ordinary "the Reviewer requested
   * changes" instructions is sent to re-read the review it already answered twice,
   * and spends the one authorised revision doing it.
   *
   * That defect took four review rounds to get right in `agent-lead-revise.yml`,
   * and this file reintroduced it verbatim by copying the skeleton without what the
   * skeleton had learned. These execute the shipped step.
   */
  it('tells him it is a developer decision, not another review round', () => {
    const m = runMandate({ reset: true });
    expect(m).toContain('APPLYING A DEVELOPER DECISION');
    expect(m).not.toContain('requested changes. This is round');
  });

  it('points a reset run at PR issue comments, where a decision lives', () => {
    // Not `.reviews[-1].body` — that is the Reviewer's review, which the reset exists to
    // move past.
    const m = runMandate({ reset: true });
    expect(m).toContain('--json comments');
    expect(m.indexOf('--json comments')).toBeLessThan(m.indexOf('--json reviews'));
  });

  it('never claims a round number on a reset run', () => {
    // `round` is ROUNDS+1 and unbounded past a cleared cap, so the ordinary text
    // renders "round 4 of at most 2" — telling him he is over a cap the workflow
    // just deliberately cleared.
    expect(runMandate({ reset: true, round: '4' }).replace(/\s+/g, ' ')).not.toContain('of at most 2');
  });

  it('warns that the standing review may not be an unanswered changes-request', () => {
    // A reset below the cap is permitted, so `.reviews[-1]` can be an APPROVE or
    // nothing at all (RA-971).
    expect(runMandate({ reset: true }).replace(/\s+/g, ' ')).toContain('CHECK WHAT YOU GET BACK');
  });

  it.each([[true], [false]])('sends him to the CHECKS on a reset=%s run too', (reset) => {
    // The file's own header says WHY a code PR is not a brief: it has CI, and a red
    // check is a different instruction from a review. That applied to one branch
    // only — the reset branch never mentioned the build, so the one revision a
    // developer authorises could be spent applying a decision onto a broken tree.
    //
    // Round 2's fix added it and NOT this assertion: deleting the paragraph again
    // still passed 53 tests. Coverage tracked the gap, which is what the reviewer
    // said about round 1.
    expect(runMandate({ reset })).toContain('gh pr checks');
  });

  it('gives the ordinary run checks-then-review, in that order', () => {
    const m = runMandate({ reset: false, round: '2' });
    expect(m.replace(/\s+/g, ' ')).toContain('round 2 of at most 2');
    expect(m.indexOf('gh pr checks')).toBeLessThan(m.indexOf('--json reviews'));
    expect(m).not.toContain('DEVELOPER DECISION');
  });

  it('is wired into the prompt, and wired to the filter', () => {
    // The chain is four links and only the middle one is executed above.
    expect(prompt).toContain('needs.filter.outputs.mandate');
    expect(mandateStep.env.RESET).toContain('steps.filter.outputs.reset');
  });

  it.each([
    [{ isDispatch: true, reset: true, rounds: 3 }, 'true'],
    [{ isDispatch: true, reset: false, rounds: 1 }, 'false'],
    [{ isDispatch: false, rounds: 1 }, 'false'],
  ])('the filter tells the mandate whether this is a reset: %j', (args, expected) => {
    expect(runFilter(args).outputs.reset).toBe(expected);
  });
});

describe('the job can run the gates its prompt orders', () => {
  it('starts the project\'s declared database, and tells the project-setup hook to set up its schema', () => {
    // The prompt orders the integration tier when the fix touches src/db/**. Without
    // these it fails on connect — and a tier that cannot run is not a gate.
    // `agent-implement.yml` and `agent-triage.yml` both provision exactly this; the
    // revise job revises THEIR PRs and needs the same ground.
    // Resolved for THIS lane (RA-2592): the spine can turn all three off, so asserting the
    // spine has them would pass for a lane that opted out.
    // The database is the project's declaration since kanon#18: the test-database block
    // starts what the project declares, and the project-setup hook sets up its schema. Both
    // halves are tested where they live (`test-database.test.ts`, and the adopter's own
    // hook); here, the lane switches the database on and the spine hands the block that
    // switch, and the hook the block's answer.
    expect(revise.inputs.database).toBe(true);
    const db = revise.laneSteps.find((s) => s.uses === '$/actions/test-database');
    expect(db?.with?.wanted).toBe('${{ inputs.database }}');
    const hook = revise.laneSteps.find((s) => s.uses === './.github/actions/project-setup');
    expect(hook?.with?.database).toBe('${{ steps.database.outputs.database }}');
  });
});

describe('the round cap counts THE IMPLEMENTER', () => {
  it('filters the marker count by author, with the login inlined', () => {
    // The comment claimed "the Implementer's own marker comments" and the jq counted
    // anyone's — so a human quoting the marker while discussing the cap, or a
    // review doing so, would count as a round and stop the loop early.
    //
    // Inlined rather than passed with `--arg`, because `gh` has NO --arg
    // passthrough: it reads `--arg` as the jq expression. The stub caught that —
    // `jq: --arg takes two parameters` — which is the argument for a stub that
    // runs the real jq instead of pretending.
    expect(filter.run).toMatch(/author\.login/);
    expect(filter.run).toContain('$IMPL_LOGIN');
    // Deliberately NOT asserting the absence of the string `--arg`: the comment
    // above the jq explains why gh has no such passthrough, and an assertion that
    // forbids its own documentation is a guard against the wrong thing.
    expect(filter.run).not.toMatch(/--jq\s+--arg/);
    // And it normalises: `--json comments` returns the BARE slug while the other
    // two endpoints return `app/<slug>` and `<slug>[bot]` (RA-1007).
    expect(filter.run).toContain('^app/');
    // Escaped for jq's regex, so the literal brackets are backslash-separated.
    expect(filter.run).toContain('bot');
  });

  it('does not count a marker left by anyone else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-other-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary'), '');
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: 'app/example-author' }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        // Two markers, neither from the Implementer: a human discussing the cap, and the
        // reviewer quoting it. Under the old count this read as "cap reached".
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [
          { author: { login: 'a-developer' }, body: 'the marker is <!-- qa:implement-revise -->' },
          { author: { login: 'example-reviewer' }, body: '<!-- qa:implement-revise -->' },
        ] }),
      },
    });
    expect(r.status, `step aborted: ${r.output}`).toBe(0);
    expect(r.outputFile).toContain('act=true');
  });
});


describe('the cheap decision does not provision a database (RA-1079 r2)', () => {
  /**
   * Service containers start BEFORE a job's first step, and `pull_request_review`
   * is repo-wide. With the filter in the same job as Postgres, every review in the
   * repo provisioned a database in order to decide it had nothing to do —
   * measured over the last 60 PRs: 91 review submissions, ~54% of which skip.
   */
  it('the filter job has no services', () => {
    expect(wf.jobs.filter.services).toBeUndefined();
    expect(wf.jobs.filter.env?.DATABASE_URL).toBeUndefined();
  });

  it('the revise job has it, and runs only when there is work', () => {
    expect(revise.laneSteps.some((s) => s.uses === '$/actions/test-database')).toBe(true);
    expect(wf.jobs.revise.needs).toBe('filter');
    expect(wf.jobs.revise.if).toContain("needs.filter.outputs.act == 'true'");
  });

  it('every published output names a step that actually emits it', () => {
    // The keys existing is not enough: a `mandate` output pointing at
    // `steps.filter.outputs.mandate` — a step that emits no such thing — publishes
    // an empty string, and the revise job runs with a BLANK mandate. That is what
    // a careless rename did here, and the key-existence test below could not see it.
    const ids = new Set(wf.jobs.filter.steps.map((s: { id?: string }) => s.id).filter(Boolean));
    const emits: Record<string, Set<string>> = {};
    for (const st of wf.jobs.filter.steps) {
      if (!st.id || !st.run) continue;
      emits[st.id] = new Set([...String(st.run).matchAll(/echo "(\w+)=/g)].map((m) => m[1]!));
      if (/text<<MANDATE_EOF/.test(st.run)) emits[st.id]!.add('text');
    }
    for (const [name, expr] of Object.entries(wf.jobs.filter.outputs ?? {})) {
      const m = /steps\.(\w+)\.outputs\.(\w+)/.exec(String(expr));
      expect(m, `${name} must reference a step output`).not.toBeNull();
      const [, stepId, key] = m!;
      expect(ids, `${name} -> unknown step ${stepId}`).toContain(stepId);
      expect([...(emits[stepId!] ?? [])], `${name} -> ${stepId} never emits ${key}`).toContain(key);
    }
  });

  it('the filter job publishes everything the revise job reads', () => {
    // A missing output is silent: the expression yields empty and the step runs
    // with a blank ref or a blank mandate.
    const outs = Object.keys(wf.jobs.filter.outputs ?? {});
    expect(outs).toEqual(expect.arrayContaining(['act', 'pr', 'branch', 'round', 'reset', 'mandate']));
    // Every job downstream of the filter — the round record reads `head_sha` and `marked`
    // from a job of its own since RA-2592.
    const text = JSON.stringify(Object.values(wf.jobs as Record<string, { needs?: string | string[] }>).filter((j) => [j.needs].flat().includes('filter')));
    expect(text).toContain('needs.filter.outputs.head_sha');
    for (const m of text.matchAll(/needs\.filter\.outputs\.(\w+)/g)) {
      expect(outs, `revise reads needs.filter.outputs.${m[1]}`).toContain(m[1]);
    }
  });
});

describe('a deleted author does not abort the round count', () => {
  it('guards a null login before sub()', () => {
    // jq's sub() on null aborts the whole filter, so one ghost comment would fail
    // the job rather than skip the comment.
    // Escaped for the shell, so the literal is `.author.login // \"\"`.
    expect(filter.run).toContain('.author.login //');
  });

  it('counts correctly when a comment has no author', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-ghost-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary'), '');
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: 'app/example-author' }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [
          { author: null, body: 'a comment whose author deleted their account' },
          { author: { login: 'example-author' }, body: '<!-- qa:implement-revise -->' },
        ] }),
      },
    });
    expect(r.status, `step aborted: ${r.output}`).toBe(0);
    const out = r.outputFile;
    expect(out).toContain('act=true');
    expect(out).toContain('round=2');
  });
});

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
    expect(runFilter({ rounds: 0, changesRequested: 3 }).act).toBe(false);
  });

  it('still acts on a genuine first round', () => {
    // One CHANGES_REQUESTED — the one that triggered this run — is zero prior rounds.
    expect(runFilter({ rounds: 0, changesRequested: 1 }).act).toBe(true);
  });

  it('still acts on a second round', () => {
    expect(runFilter({ rounds: 0, changesRequested: 2 }).act).toBe(true);
  });

  it('takes the LARGER of the two counts, never the smaller', () => {
    // Biased toward over-counting, which is `dispatch-sweep`'s direction: stopping
    // early costs a dispatch, stopping late costs an unbounded loop. Markers ahead of
    // reviews must not be pulled down by the review floor.
    expect(runFilter({ rounds: 2, changesRequested: 1 }).act).toBe(false);
  });

  it('reports both numbers, so a disagreement between them is visible', () => {
    const { stdout } = runFilter({ rounds: 0, changesRequested: 3 });
    expect(stdout).toMatch(/markers=0/);
    expect(stdout).toMatch(/changes-requested=3/);
  });
});

describe('a content-free rebase is neither an answer nor a round (RA-1841)', () => {
  /**
   * PR RA-1822: THREE HEADS, ONE PATCH. Two of them came from GitHub's "Update branch"
   * button (`committer=Geoffry Nagy`, `author=claude[bot]`), and the effective patch at
   * each is identical apart from one hunk header and three context lines of base churn
   * in `scripts/qa/spec-coverage.mjs`. Both reads in this filter asked whether the SHA
   * moved rather than whether the CONTENT did, so both halves fired:
   *
   *   • the label path found no verdict on the new head and discarded a changes-request
   *     nobody had answered — `→ skipped (no changes-request stands on 68d5a8d …)`;
   *   • `REQUESTED` counted all three anyway, SHA-independently, so at 3 requests and 0
   *     markers `ROUNDS` reached the cap and the lane refused every further trigger.
   *
   * Together they stopped a PR the implementer had never once been dispatched on — a
   * cap whose stated purpose is bounding "an unbounded review->revise loop between two
   * Opus agents", fired having never invoked one of them.
   */

  it('keeps a changes-request standing when the head moved but the patch did not', () => {
    // The label path, on RA-1822's exact shape: one changes-request, on a commit the
    // head has since left behind without changing anything it faulted.
    expect(runFilter({ isLabel: true, headMoved: 'content-free', changesRequested: 1 }).act).toBe(true);
  });

  it('still lets a real push answer it, which is what the SHA check was protecting', () => {
    // The property that must survive: a label churn may not re-fire against a review
    // the implementer has already answered with a push. Here the head carries a
    // DIFFERENT patch from the reviewed commit, so nothing stands.
    const r = runFilter({ isLabel: true, headMoved: 'revised', changesRequested: 1 });
    expect(r.act).toBe(false);
    expect(r.summary).toContain('no changes-request stands');
  });

  it('counts three requests against one unchanged patch as ONE round, not three', () => {
    // RA-1822 measured: MARKED=0, REQUESTED=3 -> ROUNDS=2 -> capped, with the implementer
    // never dispatched. One distinct patch was faulted, so zero rounds were spent.
    const r = runFilter({ rounds: 0, changesRequested: 3, headMoved: 'content-free' });
    expect(r.act).toBe(true);
    expect(r.stdout).toContain('changes-requested=1 distinct of 3');
  });

  it('still reaches the cap when three DIFFERENT patches were faulted', () => {
    // The loop RA-969/RA-1099 closed stays closed: the reviewer floor still binds whenever
    // the implementer actually produced new content to fault.
    expect(runFilter({ rounds: 0, changesRequested: 3 }).act).toBe(false);
  });

  it('still counts a round the implementer spent DISAGREEING, which changes no content', () => {
    // The marker floor is what makes the content count safe to lower: a round that
    // pushed nothing is invisible to the patch, and visible to `MARKED`.
    expect(runFilter({ rounds: 2, changesRequested: 3, headMoved: 'content-free' }).act).toBe(false);
  });

  it('degrades to the SHA when the diff cannot be read, which is the old behaviour', () => {
    // FAILS TOWARD OVER-COUNTING. A deleted commit, a compare truncated at 300 files, a
    // 404 — none of them may LOWER the cap on a guess. Same three heads, same one
    // patch, but no readable diff: every head is its own round again.
    const r = runFilter({ rounds: 0, changesRequested: 3, headMoved: 'content-free', readableDiffs: false });
    expect(r.act).toBe(false);
    expect(r.stdout).toContain('changes-requested=3 distinct of 3');
  });

  it('reads the patch from the compare API, since this step runs before checkout', () => {
    // `git patch-id` is the right tool and is not reachable: the filter job has no
    // checkout on purpose, so an unrelated review costs Actions seconds rather than a
    // minted token and a clone. The signal has to come over the API.
    expect(filter.run).toContain('/compare/');
    expect(filter.run).toContain('vnd.github.v3.diff');
    expect(wf.jobs.filter.steps.some((s: { uses?: string }) => s.uses?.startsWith('actions/checkout'))).toBe(false);
  });

  it('asks the PR for the base the compare is rooted at', () => {
    // A three-dot compare against the base branch is what makes the patch at a commit
    // the base has since moved past still read as it was reviewed. Without
    // `baseRefName` in the META query the ref is empty and every fingerprint degrades
    // to its SHA — the defect back, silently, with the suite green on the diff lines.
    expect(filter.run).toContain('baseRefName');
    expect(filter.run).toContain('$BASE_REF...$sha');
  });

  it('normalises away exactly what a rebase moves, and nothing else', () => {
    // index blob oids, hunk headers and context lines are base churn; the +/- lines and
    // the file headers are the change. Asserted on the fixture rather than on the shell,
    // so the two patches this suite calls "the same content" really are byte-different.
    const a = comparePatch({ content: 'rows.filter(Boolean)', churn: 'aa' });
    const b = comparePatch({ content: 'rows.filter(Boolean)', churn: 'cccccccc' });
    expect(a).not.toBe(b);
    expect(b).toContain('index cccccccc..bbbbbbb');
    expect(a.split('\n').filter((l) => /^[+-][^+-]/.test(l)))
      .toEqual(b.split('\n').filter((l) => /^[+-][^+-]/.test(l)));
  });
});

describe('the mandate points at the review that requested changes (RA-1215)', () => {
  // RA-1205 fixed the READ at both sites — `.reviews[-1].body` selects whatever landed
  // last, which since RA-965 is routinely a `COMMENT` or an `APPROVE` — but shipped no
  // assertion covering it. Verified by mutation at filing: reverting BOTH sites to
  // `.reviews[-1].body` left this file at 66 passed.
  //
  // The sibling `agent-lead-revise.yml` IS guarded, at
  // `tests/unit/agent-lead-revise.test.ts` ("selects the latest CHANGES_REQUESTED, not the
  // latest review"), in the same commit that fixed this
  // file. One side got the lock and the other did not — so this mirrors it deliberately
  // rather than inventing a different shape.

  it('the ordinary round selects the latest CHANGES_REQUESTED', () => {
    // This is the branch that runs on every review-triggered revision.
    const m = runMandate({ reset: false });
    expect(m).toMatch(/select\(\.state == "CHANGES_REQUESTED"\)/);
    expect(m, '`.reviews[-1]` takes whatever landed last').not.toMatch(/reviews\[-1\]/);
  });

  it('the reset round reads it the same way', () => {
    const m = runMandate({ reset: true });
    expect(m).toMatch(/select\(\.state == "CHANGES_REQUESTED"\)/);
    expect(m).not.toMatch(/reviews\[-1\]/);
  });

  it('neither branch is left reading the last review anywhere', () => {
    // Both sites, asserted over the whole step rather than per-branch: the defect was
    // that ONE of the two was fixed and the other was not, and a per-branch check that
    // happens to render the fixed branch would pass over exactly that.
    const raw = JSON.stringify(mandateStep);
    expect(raw, 'no mandate site may read .reviews[-1]').not.toMatch(/reviews\\?\[-1\\?\]/);
    expect((raw.match(/CHANGES_REQUESTED/g) ?? []).length,
      'both mandate sites must select it').toBeGreaterThanOrEqual(2);
  });
});

describe('the login is read from the App register (plan 0001 §5)', () => {
  // A Kanon lane cannot name an adopter's App, so the filter reads the Implementer's slug
  // from `docs/qa/agent-identities.md` on the default branch. These run the shipped step
  // against the fixture register, and against registers that are wrong in each way.
  const runWith = (register: string | undefined, author = `app/${IMPLEMENTER_LOGIN}`) => {
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-register-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    return runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter, register ?? ''), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: author }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [] }),
      },
    });
  };

  it('names the role, and carries the shared parser verbatim', () => {
    expect(filter.env.ROLE).toBe('Implementer');
    expect(filter.env.REGISTER_AWK).toBe(readFileSync(join(process.cwd(), 'actions/lane-check/app-register.awk'), 'utf8'));
  });

  it('acts for the slug the register gives, and publishes it for the round record', () => {
    const r = runWith(REGISTER_FIXTURE);
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('act=true');
    expect(r.outputFile).toContain(`login=${IMPLEMENTER_LOGIN}`);
  });

  it('publishes the persona header the register declares, for the round record (plan 0005 §3.3)', () => {
    // A Persona column at the end of the table: the Implementer's declared, every other row blank.
    const withPersona = REGISTER_FIXTURE.split('\n').map((l) => (!l.startsWith('|') ? l
      : l.startsWith('| Role ') ? `${l} Persona |` : /^\|[-| ]+\|$/.test(l) ? `${l}---|`
        : l.startsWith('| Implementer ') ? `${l} The Builder |` : `${l}  |`)).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-persona-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter, withPersona), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: `app/${IMPLEMENTER_LOGIN}` }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [] }),
      },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('header=**The Builder (Implementer)** <!-- kanon:role=implementer -->');
  });

  it('follows the register, not a constant: another slug there turns the same author away', () => {
    const r = runWith(REGISTER_FIXTURE.replaceAll(`\`${IMPLEMENTER_LOGIN}\``, '`someone-else`'));
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('act=false');
    expect(r.stdout).toContain('not someone-else');
  });

  it.each([
    ['no register at all', ''],
    ['no row for the role', REGISTER_FIXTURE.replace(/^\| Implementer .*\n/m, '')],
    ['a row with no slug in backticks', REGISTER_FIXTURE.replace(`\`${IMPLEMENTER_LOGIN}\``, IMPLEMENTER_LOGIN)],
  ])('fails the job by name on %s, never skips silently', (_, register) => {
    const r = runWith(register);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('::error title=App register::');
    expect(r.outputFile).not.toContain('act=');
  });

  it('reads nothing for a review it turns away on the event alone', () => {
    // No register at all, and a COMMENT verdict: the skip comes first, so the job is green.
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-register-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    const r = runWorkflowStep(filter, {
      dir,
      env: { PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(), REPO: 'r', ...registerEnv(filter, ''), PR: '1', STATE: 'commented', IS_DISPATCH: 'false', RESET: '' },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputFile).toContain('act=false');
  });
});
