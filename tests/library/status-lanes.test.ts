/**
 * The lane-health view (project #1327, Issue D): each lane caller the lane check reads, its recent
 * runs' state as the workflow-health check classifies it, and each failed run classed `infra` or
 * `real` from what the agent classifier recorded and from a re-run's outcome.
 */
import { describe, expect, it } from 'vitest';
import { fail, failedJob, laneCaller, laneFleet as fleet, laneWorld, ok, type LaneRun } from './helpers/status-world.js';

const { laneHealthView } = await import('../../scripts/status/lanes.mjs');
const { IncompleteRead } = await import('../../scripts/status/project.mjs');
const { ReadError } = await import('../../scripts/status/reader.mjs');
const { classifyWorkflow, MIN_DECISIVE, WINDOW } = await import('../../scripts/workflow-health.mjs');
const { RETRY_STEPS } = await import('../../scripts/lane-retry.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('the lane-health view', () => {
  it('[STAT-8] lists each lane caller with its state as the workflow-health check classifies it, and each failure classed infra or real', async () => {
    const w = fleet();
    const view: Any = await laneHealthView({ reader: w.reader, repo: w.repo });
    expect(view).toMatchObject({ branch: 'main', window: WINDOW, minDecisive: MIN_DECISIVE });

    // Each lane caller the lane check reads, and nothing else: no CI workflow, no spine caller.
    expect(view.callers.map((c: Any) => c.file)).toEqual(['implement.yml', 'merge.yml', 'rebase.yml', 'review.yml', 'triage.yml']);
    const lane = (file: string) => view.callers.find((c: Any) => c.file === file);

    // The state is the workflow-health check's own verdict for the same runs.
    const asRead = (runs: LaneRun[]) => runs.map((r) => ({ conclusion: r.conclusion, createdAt: '2026-10-24T00:00:00Z', url: `https://example.test/runs/${r.id}` }));
    const runs: Record<string, LaneRun[]> = {
      'review.yml': [fail(101), fail(102), fail(103), { id: 104, conclusion: 'cancelled' }],
      'implement.yml': [fail(201), { id: 202, conclusion: 'timed_out' }, fail(203)],
      'rebase.yml': [fail(301), ok(302), ok(303), ok(304)],
      'merge.yml': [ok(401), ok(402), ok(403)],
      'triage.yml': [ok(501), { id: 502, conclusion: null }],
    };
    for (const [file, rs] of Object.entries(runs)) {
      const v = classifyWorkflow(file, asRead(rs));
      expect([lane(file).status, lane(file).decisive, lane(file).failed], file).toEqual([v.status, v.decisive, v.failures]);
    }
    expect(view.callers.map((c: Any) => [c.file, c.status, c.health])).toEqual([
      ['implement.yml', 'red', 'red'],
      ['merge.yml', 'ok', 'flaky'],
      ['rebase.yml', 'ok', 'ok'],
      ['review.yml', 'red', 'flaky'],
      ['triage.yml', 'quiet', 'quiet'],
    ]);

    // infra: the classifier recorded the model unreachable, an API error, or no verdict.
    const classes = (file: string) => lane(file).failures.map((f: Any) => [f.run, f.attempt, f.conclusion, f.class, f.reason]);
    expect(classes('review.yml')).toEqual([
      [101, 1, 'failure', 'infra', 'unreachable'],
      [102, 1, 'failure', 'infra', 'api_error'],
      [103, 1, 'failure', 'infra', 'no_verdict'],
    ]);
    // real otherwise: a failure nothing recorded, or a run with no failed job to read.
    expect(classes('implement.yml')).toEqual([
      [201, 1, 'failure', 'real', null],
      [202, 1, 'timed_out', 'real', null],
      [203, 1, 'failure', 'real', null],
    ]);
    // A run is infra only when every job that failed says so; and infra when a later attempt of
    // the same run succeeded. A cancelled attempt is no failure.
    expect(classes('rebase.yml')).toEqual([
      [301, 1, 'failure', 'real', null],
      [302, 1, 'failure', 'infra', 'rerun-succeeded'],
    ]);
    expect(classes('merge.yml')).toEqual([[401, 2, 'startup_failure', 'infra', 'rerun-succeeded']]);
    expect(lane('merge.yml').failures[0]).toMatchObject({ url: 'https://example.test/runs/401/attempts/2', createdAt: '2026-10-23T00:00:00Z' });
    expect(lane('review.yml').failures[0]).toMatchObject({ url: 'https://example.test/runs/101', createdAt: '2026-10-24T00:00:00Z' });
    expect(classes('triage.yml')).toEqual([]);

    // It reads the window the workflow-health check reads, from the default branch's workflows.
    expect(w.seen).toContain(`GET repos/acme/shop/actions/workflows/review.yml/runs?per_page=${WINDOW}`);
    expect(w.seen).toContain('GET repos/acme/shop/contents/.github/workflows?ref=main');
    expect(w.seen.filter((s) => s.includes('/jobs')), 'only a failed run\'s jobs are read').toHaveLength(7);
    const narrow: Any = await laneHealthView({ reader: fleet().reader, repo: 'acme/shop', window: 2, minDecisive: 2 });
    expect(narrow.callers.find((c: Any) => c.file === 'rebase.yml')).toMatchObject({ status: 'ok', decisive: 2, failed: 1, health: 'ok' });
  });

  it('[STAT-3] makes the view an error when a lane\'s runs, a run\'s jobs or an attempt can\'t be read whole', async () => {
    const refused = laneWorld({
      workflows: { 'review.yml': laneCaller('review') },
      overrides: { get: (p) => { if (p.includes('/actions/workflows/')) throw new ReadError(`GET ${p}`, 'Resource not accessible by integration', { status: 403 }); return p.includes('contents/.github/workflows?') ? [{ name: 'review.yml', path: '.github/workflows/review.yml', type: 'file' }] : undefined; } },
    });
    const err: Any = await laneHealthView({ reader: refused.reader, repo: refused.repo }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteRead);
    expect(err.message).toMatch(/the lane-health view couldn't be read whole, so there is no answer: GET repos\/acme\/shop\/actions\/workflows\/review\.yml\/runs\?per_page=\d+ failed: Resource not accessible/);

    const cut = laneWorld({ workflows: { 'review.yml': laneCaller('review') }, runs: { 'review.yml': [fail(1)] }, jobs: { 1: [failedJob('review / review', RETRY_STEPS.unreachable)] } });
    const pages = cut.reader.pages;
    cut.reader.pages = (p: string) => (p.includes('/runs/1/jobs') ? [{ total_count: 150, jobs: [failedJob('review / review', RETRY_STEPS.unreachable)] }] : pages(p));
    await expect(laneHealthView({ reader: cut.reader, repo: cut.repo })).rejects.toThrow(/cut short: 1 of 150 entries/);

    const nojobs = laneWorld({ workflows: { 'review.yml': laneCaller('review') }, runs: { 'review.yml': [fail(1)] }, jobs: { 1: undefined } });
    await expect(laneHealthView({ reader: nojobs.reader, repo: nojobs.repo })).rejects.toThrow(/jobs\?per_page=100 failed: the answer has no `jobs`/);

    const gone = laneWorld({ workflows: { 'review.yml': laneCaller('review') }, runs: { 'review.yml': [ok(1, { run_attempt: 2 })] } });
    await expect(laneHealthView({ reader: gone.reader, repo: gone.repo })).rejects.toThrow(/unrouted: GET repos\/acme\/shop\/actions\/runs\/1\/attempts\/1/);
  });
});
