import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep } from './workflow-step.js';
import { jobPrompt, spineJobFor } from './spine.js';
import { comparePatch, GH_COMPARE_ARM } from './compare-diff.js';
import { writeStub } from './stub-bin.js';
import { GH_REGISTER_ARM, REGISTER_FIXTURE, registerEnv } from './register.js';

/**
 * The workflow, its steps and the filter runner the Implementer's revise-mode tests share
 * (tests/unit/agent-implement-revise*.test.ts, split by area in #1204 so their cases run in
 * parallel).
 *
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
export const wf = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-implement-revise.yml'), 'utf8'));
export const filter = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'filter');
// The prompt stays in the lane (RA-2592): it is the `prompt` input the revise job passes the spine.
export const prompt: string = jobPrompt(wf.jobs.revise);
// What the revise job RUNS — `agent-lane.yml`, resolved for this lane's inputs.
export const revise = spineJobFor(wf.jobs.revise);
export const mandateStep = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'mandate');

/**
 * Run a step and REQUIRE it to succeed. Under `bash -c` a step that exits non-zero
 * mid-body carried on and the suite passed; under the runner's `-e` it aborts, so the
 * status is now part of every assertion rather than discarded (RA-1044).
 */
export const runStepOrThrow = (step: Parameters<typeof runWorkflowStep>[0], opts: Parameters<typeof runWorkflowStep>[1]) => {
  const r = runWorkflowStep(step, opts);
  expect(r.status, `the step aborted under the runner's shell: ${r.output}`).toBe(0);
  return r;
};

/** Run the SHIPPED mandate step and return what it put in `outputs.text`. */
export const runMandate = ({ reset, round = '3', mode = 'review', merger = 'example-judge', headSha = 'deadbeefcafe1234' }:
  { reset: boolean; round?: string; mode?: string; merger?: string; headSha?: string }) => {
  const r = runWorkflowStep(mandateStep, {
    env: {
      RESET: String(reset), MODE: mode, PR: '1057', ROUND: round, REPO: 'example-org/example-repo',
      MERGER: merger, HEAD_SHA: headSha, HANDBACK_RULE: mandateStep.env.HANDBACK_RULE,
    },
  });
  // The step must not merely produce the right text — it must SUCCEED under the
  // runner's `-e`, which is what `bash -c` was hiding (RA-1044).
  expect(r.status, `mandate step aborted: ${r.output}`).toBe(0);
  return r.outputFile.replace(/^text<<MANDATE_EOF\n/, '').replace(/MANDATE_EOF\n?$/, '');
};

export const GH_STUB = `#!/usr/bin/env bash
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

export const HEAD_OID = 'deadbeefcafe1234';

export const runFilter = ({
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
  // Top-level PR comments besides the implementer's round markers: the Merger's hand-back
  // (kanon#1100), or a forgery of it.
  extraComments = [] as { author: { login: string }; body: string }[],
  // The App register the filter reads; the hand-back path also reads the Merger's row.
  register = REGISTER_FIXTURE,
  // The PR's base branch, which the fingerprint's compare is rooted at (kanon#1432).
  baseRefName = 'main',
}: Partial<{
  author: string; labels: string[]; prState: string; reviewState: string;
  rounds: number; changesRequested: number; isDispatch: boolean; reset: boolean;
  isLabel: boolean; labelAdded: string; headVerdict: string;
  headMoved: false | 'content-free' | 'revised'; readableDiffs: boolean; statuses: string;
  extraComments: { author: { login: string }; body: string }[]; register: string;
  baseRefName: string;
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
  const compareLog = join(dir, 'compare.log');
  const r = runStepOrThrow(filter, {
    dir,
    env: {
      PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
      REPO: 'example-org/example-repo',
      ...registerEnv(filter, register),
      HANDBACK_RULE: filter.env.HANDBACK_RULE,
      FIX_MARKER: filter.env.FIX_MARKER,
      PR: '1057',
      // A workflow_dispatch carries no review, so this interpolates EMPTY.
      STATE: isDispatch || isLabel ? '' : reviewState,
      IS_DISPATCH: String(isDispatch),
      IS_LABEL: String(isLabel),
      LABEL_ADDED: isLabel ? labelAdded : '',
      REVISE_LABEL: 'agent:revise',
      RESET: isDispatch ? String(reset) : '',
      STUB_STATUSES: statuses,
      STUB_COMPARE_LOG: compareLog,
      STUB_META: JSON.stringify({
        author: { login: author },
        state: prState,
        headRefName: 'docs/1049-payments-transition-table',
        baseRefName,
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
        comments: [
          ...Array.from({ length: rounds }, () => ({
            author: { login: 'example-author' },
            body: '<!-- qa:implement-revise -->',
          })),
          ...extraComments,
        ],
      }),
    },
  });

  const { outputs, summary } = r;
  // The paths the compare arm was asked for (kanon#1432).
  const compares = existsSync(compareLog) ? readFileSync(compareLog, 'utf8').split('\n').filter((l) => l.includes('/compare/')) : [];
  return { act: outputs.act === 'true', outputs, stdout: r.stdout, summary, compares };
};
