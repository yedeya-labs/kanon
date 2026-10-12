import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { writeStub } from '../unit/helpers/stub-bin.js';

/**
 * kanon#726: the library finds a lane's runs, and dispatches it, through the lane's CALLER on the
 * default branch, not the lane's own file name, which is the caller's only when it sits there
 * (K-LAYOUT-18). One helper resolves it (`scripts/lib/lane-caller.mjs`); each site that lists a
 * lane's runs or dispatches it is held here to use it.
 *
 * The sites read `GITHUB_REPOSITORY` when they load, so it is set before they are imported.
 */
vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
afterAll(() => { vi.unstubAllEnvs(); });

const { laneCaller, laneCallerFile, laneCallersIn, readSnapshot, resolveCaller } = await import('../../scripts/lib/lane-caller.mjs');
const { reviewRunsFor } = await import('../../scripts/review-run-evidence.mjs');
const { briefReviseRunsFor } = await import('../../scripts/brief-revise-recovery.mjs');
const { reviseRunsFor } = await import('../../scripts/lead-reconcile.mjs');
const { apply } = await import('../../scripts/merge-gate.mjs');
const { watchedWorkflows } = await import('../../scripts/workflow-health.mjs');

/** A caller of `lane`, as `kanon init` writes one. */
const caller = (lane: string, name = 'Caller') =>
  `name: ${name}\non:\n  workflow_dispatch:\njobs:\n  run:\n    uses: yedeya-labs/kanon/.github/workflows/${lane}.yml@v0.39.0\n`;
/** A lane itself, as a repository that hosts the lanes has it at the lane's file name. */
const laneItself = 'name: Lane\non:\n  workflow_call:\njobs:\n  run:\n    uses: $/.github/workflows/lane-agent-job.yml\n';
/** A workflow that calls a local reusable workflow. */
const callsLocal = (file: string) => `name: Outer\non:\n  pull_request_target:\n    types: [labeled]\njobs:\n  run:\n    uses: ./.github/workflows/${file}\n`;
/** The same caller, only callable by another workflow. */
const reusable = (lane: string) => caller(lane).replace('  workflow_dispatch:\n', '  workflow_call:\n');
/** An adoption record that waives `caller.misplaced` on each file. */
const record = (...files: string[]) =>
  ['# Adoption', '', '## Choices', '', ...files.map((f) => `- **Waived doctor finding:** \`caller.misplaced\` on \`.github/workflows/${f}\` (the lane's file name holds the lane)`), ''].join('\n');

/** The GraphQL answer `readSnapshot` reads. */
const snapshotOf = (files: Record<string, string>, rec: string | null = null) => ({
  data: { repository: {
    workflows: { entries: Object.entries(files).map(([name, text]) => ({ name, type: 'blob', object: { text } })) },
    record: rec === null ? null : { text: rec },
  } },
});

/** A `json` seam over a default branch holding `files`, answering every other read with `other`. */
const ghOver = (files: Record<string, string>, rec: string | null = null, other: (args: string[]) => unknown = () => ({ workflow_runs: [] })) => {
  const calls: string[][] = [];
  const json = (args: string[]) => {
    calls.push(args);
    return args[1] === 'graphql' ? snapshotOf(files, rec) : other(args);
  };
  return { json, calls };
};

const resolve = (lane: string, files: Record<string, string>, rec: string | null = null) =>
  resolveCaller(lane, { files: new Map(Object.entries(files)), record: rec });

describe('the helper: lane → caller', () => {
  it('finds a caller at the lane\'s own file name', () => {
    expect(resolve('agent-review.yml', { 'agent-review.yml': caller('agent-review'), 'ci.yml': 'name: CI\non: push\n' }))
      .toEqual({ file: 'agent-review.yml', how: 'own', reason: null });
  });

  it('finds a renamed caller by what it calls', () => {
    expect(resolve('agent-review', { 'review.yml': caller('agent-review'), 'implement.yml': caller('agent-implement') }))
      .toEqual({ file: 'review.yml', how: 'calls', reason: null });
  });

  it('finds the caller a `caller.misplaced` waiver names, before any other that calls the lane', () => {
    // Where the lanes live in the repository, the lane's own file name is the lane itself: it
    // calls nothing at a Kanon ref, so it is no caller.
    const files = { 'agent-review.yml': laneItself, 'a-review.yml': caller('agent-review'), 'review.yml': caller('agent-review') };
    expect(resolve('agent-review.yml', files, record('review.yml'))).toEqual({ file: 'review.yml', how: 'waiver', reason: null });
    // Without the waiver the first by name is taken, and the log says which others call it.
    const unwaived = resolve('agent-review.yml', files);
    expect(unwaived.file).toBe('a-review.yml');
    expect(unwaived.reason).toMatch(/a-review\.yml, review\.yml all call the lane agent-review/);
  });

  it('ignores a waiver on a file that does not call the lane', () => {
    const files = { 'review.yml': caller('agent-review'), 'implement.yml': caller('agent-implement') };
    expect(resolve('agent-review', files, record('implement.yml'))).toEqual({ file: 'review.yml', how: 'calls', reason: null });
  });

  it('finds a caller that calls the lane through a local reusable workflow', () => {
    const files = { 'review.yml': callsLocal('review-inner.yml'), 'review-inner.yml': reusable('agent-review') };
    // The reusable one has no runs of its own: they are the outer workflow's.
    expect(resolve('agent-review', files)).toEqual({ file: 'review.yml', how: 'calls', reason: null });
    // Doctor files `caller.misplaced` on the file whose job calls the lane, the INNER one, so
    // that is what a waiver names; it is lifted to the workflow that holds the runs.
    expect(resolve('agent-review', files, record('review-inner.yml'))).toEqual({ file: 'review.yml', how: 'waiver', reason: null });
    // And so is a lane-named file only another workflow calls.
    expect(resolve('agent-review', { 'agent-review.yml': reusable('agent-review'), 'outer.yml': callsLocal('agent-review.yml') }))
      .toEqual({ file: 'outer.yml', how: 'own', reason: null });
    // At any depth: outer → middle → the waived inner file.
    const middle = callsLocal('review-inner.yml').replace('  pull_request_target:\n    types: [labeled]\n', '  workflow_call:\n');
    expect(resolve('agent-review', { 'review.yml': callsLocal('middle.yml'), 'middle.yml': middle, 'review-inner.yml': reusable('agent-review') }, record('review-inner.yml')))
      .toEqual({ file: 'review.yml', how: 'waiver', reason: null });
    // A waived inner file nothing calls holds no runs: the next rule decides.
    expect(resolve('agent-review', { 'review-inner.yml': reusable('agent-review') }, record('review-inner.yml')).how).toBe('fallback');
    // A cycle of local calls calls nothing.
    expect(resolve('agent-review', { 'x.yml': callsLocal('y.yml'), 'y.yml': callsLocal('x.yml') }).how).toBe('fallback');
  });

  it('keeps the lane\'s own file name when no caller is found, and says why', () => {
    const r = resolve('agent-lead-revise.yml', { 'review.yml': caller('agent-review'), 'broken.yml': 'jobs: [\n' });
    expect(r).toMatchObject({ file: 'agent-lead-revise.yml', how: 'fallback' });
    expect(r.reason).toMatch(/no workflow on the default branch calls the lane agent-lead-revise/);
  });

  it('reads the default branch once per repository, and logs a fallback once per lane', () => {
    const log: string[] = [];
    const { json, calls } = ghOver({ 'review.yml': caller('agent-review') });
    expect(laneCallerFile('agent-review.yml', { repo: 'o/r', json, log: (m: string) => log.push(m) })).toBe('review.yml');
    expect(laneCallerFile('agent-merge.yml', { repo: 'o/r', json, log: (m: string) => log.push(m) })).toBe('agent-merge.yml');
    expect(laneCallerFile('agent-merge.yml', { repo: 'o/r', json, log: (m: string) => log.push(m) })).toBe('agent-merge.yml');
    expect(calls.filter((c) => c[1] === 'graphql')).toHaveLength(1);
    expect(calls[0]!.join(' ')).toMatch(/HEAD:\.github\/workflows.*HEAD:docs\/qa\/adoption\.md/);
    expect(log).toEqual([expect.stringMatching(/^lane caller: no workflow on the default branch calls the lane agent-merge/)]);
  });

  it('falls back to the lane\'s own file name when the default branch cannot be read, and says why', () => {
    const log: string[] = [];
    const json = () => { throw new Error('HTTP 403: Resource not accessible by integration'); };
    expect(laneCaller('agent-review.yml', { repo: 'o/r', json, log: (m: string) => log.push(m) }))
      .toMatchObject({ file: 'agent-review.yml', how: 'fallback' });
    expect(log).toEqual([expect.stringMatching(/could not read the default branch's workflows \(HTTP 403/)]);
    // An answer of the wrong shape is unreadable too, never "no workflows".
    expect(() => readSnapshot({ repo: 'o/r', json: () => ({ workflow_runs: [] }) })).toThrow(/could not be read/);
    expect(() => readSnapshot({ repo: '', json: () => snapshotOf({}) })).toThrow(/no repository/);
  });

  it('lists every lane caller among a set of workflows', () => {
    expect(laneCallersIn(new Map(Object.entries({
      'review.yml': caller('agent-review'),
      'outer.yml': callsLocal('inner.yml'),
      'inner.yml': reusable('agent-implement'),
      'apps-check.yml': caller('apps-check'),
      'agent-review.yml': laneItself,
      'ci.yml': 'name: CI\non: push\n',
    })))).toEqual(['outer.yml', 'review.yml']);
  });
});

describe('each site reaches the renamed caller', () => {
  const SHA = 'a'.repeat(40);
  const run = { id: 1, head_sha: SHA, actor: { login: 'someone' }, event: 'pull_request_target', status: 'completed', conclusion: 'success', created_at: '2026-10-12T00:00:00Z' };

  it('the review-run evidence (review recovery, red-unreviewed, the reconciler) lists the caller\'s runs', () => {
    const { json, calls } = ghOver({ 'agent-review.yml': laneItself, 'review.yml': caller('agent-review') }, record('review.yml'),
      (args) => ({ workflow_runs: String(args[1]).includes('/actions/workflows/review.yml/') && String(args[1]).includes('head_sha=') ? [run] : [], total_count: 0 }));
    const runs = reviewRunsFor(SHA, { repo: 'o/r', json, since: '2026-10-11T00:00:00Z' });
    expect(runs?.map((r: { id: number }) => r.id)).toEqual([1]);
    const listings = calls.filter((c) => c[1] !== 'graphql').map((c) => c[1]);
    expect(listings).toHaveLength(2);
    for (const l of listings) expect(l).toContain('actions/workflows/review.yml/runs');
  });

  it('the brief revise recovery lists the caller\'s runs', () => {
    const { json, calls } = ghOver({ 'lead-revise.yml': caller('agent-lead-revise') }, null, () => []);
    expect(briefReviseRunsFor(SHA, undefined, { json })).toEqual([]);
    const listing = calls.find((c) => c[0] === 'run')!;
    expect(listing[listing.indexOf('--workflow') + 1]).toBe('lead-revise.yml');
  });

  it('the reconciler\'s revise recovery lists the caller\'s runs', () => {
    const { json, calls } = ghOver({ 'implement-revise.yml': caller('agent-implement-revise') }, null, () => []);
    expect(reviseRunsFor(SHA, undefined, { json })).toEqual([]);
    const listing = calls.find((c) => c[0] === 'run')!;
    expect(listing[listing.indexOf('--workflow') + 1]).toBe('implement-revise.yml');
  });

  it('the Merger dispatches its re-review to the caller, and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-caller-merge-'));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/calls"\n`);
    const { json } = ghOver({ 'review.yml': caller('agent-review') });
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      apply({ number: 7, headSha: SHA }, { action: 'recover', rule: 'no-review-on-head', why: 'no review' }, 'o/r', { dryRun: false, json });
    } finally {
      process.env.PATH = prev;
      log.mockRestore();
    }
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    expect(calls).toContain('workflow run review.yml --repo o/r -f pr_number=7');
    expect(calls).not.toContain('agent-review.yml');
    expect(calls).toMatch(/asked `review\.yml` to re-review/);
  });

  it('the workflow-health check watches a renamed caller', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-caller-health-'));
    for (const [f, text] of Object.entries({ 'review.yml': caller('agent-review'), 'agent-merge.yml': caller('agent-merge'), 'ci.yml': 'name: CI\non: push\n' })) writeFileSync(join(dir, f), text);
    expect(watchedWorkflows(dir)).toEqual(['agent-merge.yml', 'review.yml']);
  });
});
