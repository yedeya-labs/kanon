import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TRIGGERS } from '../../cli/callers.mjs';

/**
 * kanon#552, after kanon#537/#551: no run that only skips may cancel a pending real run.
 *
 * Under GitHub's default `queue: single`, a concurrency group keeps one pending run, and a newer
 * arrival cancels and replaces it. A run joins a WORKFLOW-level group before any job-level `if:`
 * is evaluated, so a run whose jobs all skip still joins, and still replaces. "Implement — revise"
 * showed it: runs 37617337974 and 37617338207 were cancelled pending by label events that only
 * skip. So every reusable workflow with a workflow-level group is classified here, and each class
 * is held to what keeps it safe:
 *
 *   - QUEUE_MAX: a skip-only run can join the group, so it keeps every pending run (`queue: max`,
 *     measured on the lane concurrency probe in kanon#551), which needs `cancel-in-progress: false`;
 *   - KEYED_OUT: the group key sends a run that would skip to a group of its own;
 *   - ONLY_RUNS: every event its caller sends runs, so no skip-only run reaches the group.
 *
 * A new reusable workflow with a workflow-level group fails until it is classified.
 */

const WF = '.github/workflows';
type Concurrency = { group: string; 'cancel-in-progress': boolean | string; queue?: string };
type Workflow = { on?: Record<string, unknown>; concurrency?: Concurrency; jobs: Record<string, { if?: string }> };
const read = (file: string) => parse(readFileSync(join(WF, file), 'utf8')) as Workflow;
/** Keeps every pending run: `queue: max`, which GitHub refuses with `cancel-in-progress: true`. */
const keepsPending = (c: Concurrency | undefined) => c?.queue === 'max' && c['cancel-in-progress'] === false;

/** Each, with the runs that only skip and can reach its group. */
const QUEUE_MAX: Record<string, string> = {
  'agent-rebase.yml': 'an unmerged close, a cancelled CI run, and the merge queue\'s CI run the gate refuses (kanon#537)',
  'agent-implement-revise.yml': 'every other label on the pull request, and every review its filter skips',
  'agent-lead-revise.yml': 'every other label on the brief pull request, and every review that is not a changes-request',
  'agent-merge-reconcile.yml': 'a review on a pull request that is still open, and an unmerged close',
  'agent-merge.yml': 'a review on a pull request outside the green zone, and a cancelled CI run on the default branch',
  'agent-lead-reconcile.yml': 'a re-ask from a run that skipped, or of its own caller (kanon#813)',
  'agent-dispatch-sweep.yml': 'a re-ask from a run that skipped, or of its own caller (kanon#813)',
  'agent-verify-acs.yml': 'every label on the issue but `qa:verify`',
  'agent-deploy-diagnose.yml': 'a deploy run that succeeded, was cancelled or was skipped (plan 0010 D8)',
  // Its runtime-version trigger is a `pull_request_target: closed` on its caller's path (kanon#833).
  'agent-overseer.yml': 'an unmerged close of a pull request that changes the caller',
};
/** Each, with the clause of its group key that sends a would-be skip elsewhere. */
const KEYED_OUT: Record<string, RegExp> = {
  // The label is in the key: another label's run waits in another group.
  'agent-implement.yml': /\$\{\{ github\.event\.label\.name \|\| 'dispatch' \}\}/,
  'agent-triage.yml': /\$\{\{ github\.event\.label\.name \|\| 'dispatch' \}\}/,
  // A label that neither starts nor cancels a review takes a group of its run's own (kanon#627).
  'agent-review.yml': /format\('label-\{0\}', github\.run_id\)/,
  // A label event that verifies nothing takes a group of its run's own.
  'red-test.yml': /format\('noop-\{0\}', github\.run_id\)/,
  // The issue is in the key: a run for one issue never waits behind, or displaces, another's (kanon#768).
  'agent-issue-backstop.yml': /github\.event\.issue\.number \|\| inputs\.issue_number/,
};
/** Each, with why every event its caller sends runs. */
const ONLY_RUNS: Record<string, string> = {
  'agent-lead.yml': 'a dispatch only',
  'agent-code-audit.yml': 'a schedule and a dispatch',
  'agent-explore.yml': 'a schedule and a dispatch',
  'agent-explore-telemetry.yml': 'a schedule and a dispatch',
  'agent-project-digest.yml': 'a schedule and a dispatch',
  'agent-weekly-digest.yml': 'a schedule and a dispatch',
  'telemetry-collect.yml': 'a schedule and a dispatch, from Kanon\'s telemetry caller',
  'lane-concurrency-probe.yml': 'the lane concurrency smoke, which only measures the group',
};
const grouped = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f)).filter((f) => {
  const w = read(f);
  return w.on !== undefined && 'workflow_call' in w.on && w.concurrency !== undefined;
});

describe('kanon#552: a run that only skips never replaces a pending real one', () => {
  it('classifies every reusable workflow with a workflow-level group, once', () => {
    const lists = [QUEUE_MAX, KEYED_OUT, ONLY_RUNS].map((l) => Object.keys(l));
    expect(lists.flat().sort()).toEqual([...grouped].sort());
    expect(new Set(lists.flat()).size).toBe(lists.flat().length);
  });

  it.each(Object.entries(QUEUE_MAX))('%s keeps every pending run: %s', (file) => {
    expect(keepsPending(read(file).concurrency), JSON.stringify(read(file).concurrency)).toBe(true);
  });

  it.each(Object.entries(KEYED_OUT))('%s sends a would-be skip to a group of its own', (file, clause) => {
    expect(read(file).concurrency!.group).toMatch(clause);
  });

  it.each(Object.entries(ONLY_RUNS).filter(([f]) => f.startsWith('agent-')))('%s is called on %s, and every one runs', (file) => {
    const t = (TRIGGERS as Record<string, Record<string, unknown>>)[file.replace(/\.yml$/, '')]!;
    // No event that reaches it can skip: no label, review, close or CI completion.
    for (const k of ['issues', 'pr', 'prTarget', 'review', 'ci', 'merged', 'pinMoved']) expect(t[k], `${file}: ${k}`).toBeUndefined();
    // And its first job admits exactly those.
    const first = Object.values(read(file).jobs)[0]!;
    if (file === 'agent-lead.yml') expect(first.if).toBe("github.event_name == 'workflow_dispatch'");
    else expect(String(first.if ?? '')).toMatch(/^github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'$/);
  });

  // Mutations: each turns the QUEUE_MAX check red.
  it.each([
    ['the key dropped', (t: string) => t.replace(/^ {2}queue: max\n/m, '')],
    ['the default spelled out', (t: string) => t.replace(/^ {2}queue: max$/m, '  queue: single')],
    ['cancel-in-progress turned on', (t: string) => t.replace(/^ {2}cancel-in-progress: false$/m, '  cancel-in-progress: true')],
  ] as const)('goes red on a QUEUE_MAX lane with %s', (_name, mutate) => {
    const text = mutate(readFileSync(join(WF, 'agent-implement-revise.yml'), 'utf8'));
    expect(keepsPending((parse(text) as Workflow).concurrency)).toBe(false);
  });
});
