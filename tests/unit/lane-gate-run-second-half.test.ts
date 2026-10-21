import { expect, it, describe, vi } from 'vitest';
import { CASES, runGate } from './helpers/lane-gate.js';
import { describeGateRun, laneHalf } from './helpers/lane-gate-run.js';
import { SPAWNS } from './helpers/spawns.js';

// Each case runs a lane's gate step in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// kanon#46 half 2, the second half of the lanes: split out of lane-gate-run.test.ts so the two
// halves run in parallel (#1204). The four cases are in tests/unit/helpers/lane-gate-run.ts.
describeGateRun(laneHalf(2));

// A schedule on a merge-queue repository runs as the queue, named without its `[bot]` suffix
// (run 37638246558 failed red on it). Every scheduled lane admits it, without a permission lookup.
describe.each(CASES.filter(([, trigger]) => trigger === 'schedule'))('%s on a schedule run as the merge queue', (file) => {
  it('admits it', () => {
    const r = runGate(file, 'schedule', { login: 'github-merge-queue' }, { STUB_PERMISSION_FAILS: '1' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.summary).toContain('github-merge-queue[bot]');
  });
});
