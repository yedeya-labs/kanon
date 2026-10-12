import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { evaluate, interpolate, type Contexts } from './helpers/expression.js';

/**
 * kanon#627: a label the Reviewer adds after its verdict cancelled its own review run.
 *
 * The review lane's workflow-level concurrency group is evaluated when a run is QUEUED, before
 * any job's `if`, and it has `cancel-in-progress`. Only `agent:reviewer` had a group of its
 * own, so the `sev:low` the Reviewer applied a second after posting `APPROVED` landed in the
 * `review:please` run's group and cancelled it: the run and its telemetry row read
 * `cancelled` for a review that had succeeded. A person's label mid-review did the same, and
 * because the `filter` job read the label SET, that event could also start a second review.
 *
 * These evaluate the lane's own expressions (the group, the `filter` job's `if`, the `decide`
 * step's `if`, `notify-unlabeled`'s and `review`'s) over the events, so the guarantees are
 * read from what GitHub would compute, not from the text.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
const wf: Doc = parse(readFileSync(join(process.cwd(), '.github/workflows/agent-review.yml'), 'utf8'));
const GROUP = String(wf.concurrency.group);
const FILTER_IF = String(wf.jobs.filter.if);
const DECIDE_IF = String(wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'decide').if);
const NOTIFY_IF = String(wf.jobs['notify-unlabeled'].if);
const REVIEW_IF = String(wf.jobs.review.if);

/** The group as it was before kanon#627, for the events whose group must not move. */
const OLD_GROUP = "qa-review-${{ github.event.pull_request.number || inputs.pr_number || github.event.workflow_run.head_sha }}-${{ github.event_name }}-${{ (github.event.action == 'opened' || github.event.action == 'labeled') && 'open' || github.event.action || 'manual' }}-${{ github.event.label.name == 'agent:reviewer' && 'reviewer-label' || 'other' }}${{ inputs.smoke && format('-smoke-{0}', github.run_id) || '' }}";

const TRIGGERS = ['review:please', 'agent:triage', 'agent:implement'];

type Ev = { action: string; label?: string; labels: string[]; runId: number; author?: 'User' | 'Bot' };

/** A `pull_request_target` event on PR 7, as the caller hands it to the lane. */
const ctx = ({ action, label, labels, runId, author = 'User' }: Ev, filter: { member?: string; review?: string } = {}): Contexts => ({
  github: {
    event_name: 'pull_request_target',
    run_id: runId,
    event: {
      action,
      ...(label === undefined ? {} : { label: { name: label } }),
      pull_request: { number: 7, head: { sha: 'abc' }, user: { type: author }, labels: labels.map((name) => ({ name })) },
    },
  },
  inputs: { pr_number: '', smoke: '' },
  steps: { login: { outputs: { login: 'example-reviewer' } } },
  needs: { filter: { outputs: { member: filter.member ?? 'true', review: filter.review ?? '' } } },
});

const group = (e: Ev) => interpolate(GROUP, ctx(e));
const holds = (expr: string, c: Contexts) => {
  const v = evaluate(expr, c);
  return !(v === null || v === undefined || v === false || v === '' || v === 0);
};
const filterRuns = (e: Ev) => holds(FILTER_IF, ctx(e));
const decides = (e: Ev) => holds(DECIDE_IF, ctx(e));

/** The `review:please` run that is reviewing when the other events arrive. */
const RUNNING: Ev = { action: 'labeled', label: 'review:please', labels: ['review:please'], runId: 100 };

describe('a label that is not a review label never cancels a running review (kanon#627)', () => {
  it('the running review is admitted by every gate, as today', () => {
    expect(filterRuns(RUNNING)).toBe(true);
    expect(decides(RUNNING)).toBe(true);
    expect(group(RUNNING)).toBe('qa-review-7-pull_request_target-open-other');
  });

  // The Reviewer's own labels after its verdict, and labels a person adds mid-review.
  const others = ['sev:low', 'sev:critical', 'agent:reviewer', 'follow-up', 'documentation', 'gate-candidate'];

  it.each(others)('`%s` added during the review lands in another group, so it cannot cancel it', (label) => {
    const e: Ev = { action: 'labeled', label, labels: ['review:please', 'agent:reviewer', label], runId: 101 };
    expect(group(e)).not.toBe(group(RUNNING));
  });

  it.each(others)('`%s` added during the review starts no review', (label) => {
    const e: Ev = { action: 'labeled', label, labels: ['review:please', 'agent:reviewer', label], runId: 101 };
    expect(filterRuns(e), 'the filter job does not start').toBe(false);
    expect(decides(e), 'and its decide step would not decide either').toBe(false);
    expect(holds(REVIEW_IF, ctx(e)), 'so the review job skips').toBe(false);
  });

  it('two such events take two groups, so neither cancels the other', () => {
    const a: Ev = { action: 'labeled', label: 'sev:low', labels: ['review:please', 'sev:low'], runId: 101 };
    const b: Ev = { action: 'labeled', label: 'documentation', labels: ['review:please', 'sev:low', 'documentation'], runId: 102 };
    expect(group(a)).not.toBe(group(b));
  });

  it('holds on every review label the PR can carry', () => {
    for (const t of TRIGGERS) {
      const running: Ev = { action: 'labeled', label: t, labels: [t], runId: 100 };
      const sev: Ev = { action: 'labeled', label: 'sev:low', labels: [t, 'sev:low'], runId: 101 };
      expect(group(sev), t).not.toBe(group(running));
      expect(filterRuns(sev), t).toBe(false);
    }
  });
});

describe('a review label still works as today', () => {
  it.each(TRIGGERS)('`%s` added to a PR starts the review', (label) => {
    const e: Ev = { action: 'labeled', label, labels: [label], runId: 103 };
    expect(filterRuns(e)).toBe(true);
    expect(decides(e)).toBe(true);
  });

  it.each(TRIGGERS)('`%s` added during a review shares its group, so one review survives (RA-312)', (label) => {
    const e: Ev = { action: 'labeled', label, labels: ['review:please', label], runId: 103 };
    expect(group(e)).toBe(group(RUNNING));
  });

  it('`opened` with a review label and its `labeled` event still collapse (RA-312)', () => {
    const opened: Ev = { action: 'opened', labels: ['agent:implement'], runId: 104, author: 'Bot' };
    const labeled: Ev = { action: 'labeled', label: 'agent:implement', labels: ['agent:implement'], runId: 105, author: 'Bot' };
    expect(group(opened)).toBe(group(labeled));
  });

  it('a review label added with another label still starts the review', () => {
    // `--label review:please --label sev:low` fires one event per label; the review label's starts it.
    const e: Ev = { action: 'labeled', label: 'review:please', labels: ['review:please', 'sev:low'], runId: 106 };
    expect(filterRuns(e)).toBe(true);
    expect(decides(e)).toBe(true);
  });
});

describe('an unlabelled PR is never reviewed, and is still noted once', () => {
  const labels = ['sev:low', 'documentation', 'agent:reviewer', 'follow-up'];

  it.each(labels)('a `%s` event on an unlabelled PR decides nothing, so no review starts', (label) => {
    const e: Ev = { action: 'labeled', label, labels: [label], runId: 107 };
    expect(decides(e)).toBe(false);
    expect(holds(REVIEW_IF, ctx(e))).toBe(false);
  });

  it('`opened` on an unlabelled PR decides nothing either', () => {
    expect(decides({ action: 'opened', labels: [], runId: 107 })).toBe(false);
  });

  it('a person’s label on an unlabelled PR shares the `opened` run’s group, so one note is posted (RA-893)', () => {
    const opened: Ev = { action: 'opened', labels: [], runId: 108 };
    const labeled: Ev = { action: 'labeled', label: 'documentation', labels: ['documentation'], runId: 109 };
    expect(group(labeled)).toBe(group(opened));
    expect(filterRuns(labeled), 'the filter still starts, for notify-unlabeled').toBe(true);
    expect(holds(NOTIFY_IF, ctx(labeled, { member: 'true' }))).toBe(true);
  });
});

describe('every other event keeps the group it had', () => {
  const unchanged: Contexts[] = [
    { github: { event_name: 'workflow_run', run_id: 1, event: { workflow_run: { head_sha: 'abc' } } }, inputs: { pr_number: '', smoke: '' } },
    { github: { event_name: 'workflow_dispatch', run_id: 2, event: { inputs: { pr_number: '7' } } }, inputs: { pr_number: '7', smoke: '' } },
    ctx(RUNNING),
    ctx({ action: 'opened', labels: ['review:please'], runId: 3 }),
    ctx({ action: 'opened', labels: [], runId: 3 }),
    ...TRIGGERS.map((t) => ctx({ action: 'labeled', label: t, labels: ['review:please', t], runId: 4 })),
    ctx({ action: 'labeled', label: 'agent:reviewer', labels: ['review:please', 'agent:reviewer'], runId: 5 }),
    ctx({ action: 'labeled', label: 'sev:low', labels: ['sev:low'], runId: 6 }),
  ];
  it.each(unchanged.map((c, i) => [i, c] as const))('event %i', (_, c) => {
    expect(interpolate(GROUP, c)).toBe(interpolate(OLD_GROUP, c));
  });
});
