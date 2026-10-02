import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeStub } from '../unit/helpers/stub-bin.js';
import { LANES, costReadLine, costReadPrecondition, readCostRows, renderReport } from '../../scripts/dispatch-sweep.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-2706 — a store read that did not happen must say so (`K-PRIN-8`).
 *
 * The sweep's job lacked `environment: qa`, so the AWS step got an empty region, the
 * step is `continue-on-error`, and `readCostRows` failed closed: every scheduled run
 * charged every dispatch while its summary looked exactly like a normal sweep. Failing
 * closed is right; failing closed QUIETLY is the bug. These tests drive each way the
 * read can be skipped or fail and assert the summary states it.
 *
 * The `environment: qa` key and the `QA_AWS_AUTH: ${{ steps.aws.outcome }}` plumbing
 * live in the adopter's sweep workflow, which calls this script; Kanon ships no sweep
 * workflow, so only the script's half is asserted here.
 */

const NOT_READ = /^\*\*Cost rows NOT read( for [^:]+)?: .+; every dispatch charged and no run-cap exhaustion seen\.\*\*( Read: .+\.)?$/;
const fullEnv = { QA_AWS_AUTH: 'success', QA_DYNAMO_TABLE: 't', QA_AWS_REGION: 'eu-west-1' };

describe('costReadPrecondition — why the read cannot be tried', () => {
  it('names a failed AWS step by its outcome', () => {
    expect(costReadPrecondition({ ...fullEnv, QA_AWS_AUTH: 'failure' })).toMatch(/AWS credentials step did not succeed \(outcome: failure\)/);
  });
  it('names a missing table or region', () => {
    expect(costReadPrecondition({ ...fullEnv, QA_DYNAMO_TABLE: '' })).toBe('QA_DYNAMO_TABLE is unset');
    expect(costReadPrecondition({ ...fullEnv, QA_AWS_REGION: '' })).toBe('QA_AWS_REGION is unset');
  });
  it('is null when everything is present, and when no AWS step ran (a local run)', () => {
    expect(costReadPrecondition(fullEnv)).toBeNull();
    expect(costReadPrecondition({ ...fullEnv, QA_AWS_AUTH: undefined })).toBeNull();
  });
});
type Read = { rows: unknown[]; error: string | null };
const ok = (n: number): Read => ({ rows: Array.from({ length: n }, () => ({})), error: null });
const bad = (error: string): Read => ({ rows: [], error });

describe('the step summary states whether cost rows were read', () => {
  it('a skipped read is one clear line, directly under the heading', () => {
    const reason = costReadPrecondition({ ...fullEnv, QA_AWS_AUTH: 'failure' }) as string;
    const costLine = costReadLine(new Map([['implement', bad(reason)], ['triage', bad(reason)]]));
    const { text } = renderReport([], { apply: true, costLine });
    const lines = text.split('\n');
    const at = lines.findIndex((l) => NOT_READ.test(l));
    expect(at, text).toBeGreaterThan(0);
    expect(lines[at], 'the shared cause is stated once').toBe(
      '**Cost rows NOT read: the AWS credentials step did not succeed (outcome: failure); every dispatch charged and no run-cap exhaustion seen.**');
    expect(at, 'before the table, since it changes what every Attempts cell means')
      .toBeLessThan(lines.findIndex((l) => l.startsWith('| Issue')));
  });

  it('a successful read says how many rows each lane returned', () => {
    const { text } = renderReport([], { apply: true, costLine: costReadLine(new Map([['implement', ok(4)], ['triage', ok(0)]])) });
    expect(text).toContain('Cost rows read (RA-1517): 4 `implement` · 0 `triage`.');
    expect(text).not.toMatch(/NOT read/);
  });

  it('a partial failure names the failed lane and still reports the lane that was read', () => {
    const line = costReadLine(new Map([['implement', ok(4)], ['triage', bad('the store query failed (boom)')]]));
    expect(line).toMatch(NOT_READ);
    expect(line).toContain('NOT read for `triage`: the store query failed (boom)');
    expect(line).toContain('Read: 4 `implement`.');
  });
});

describe('readCostRows reads each lane independently and reports a failure', () => {
  let bin: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'sweep-aws-'));
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });
  const fakeAws = (script: string) => writeStub(join(bin, 'aws'), `#!/usr/bin/env bash\n${script}\n`);
  const ROW = `{"Items":[{"sk":{"S":"20261001T000000Z"},"issue_number":{"N":"7"},"outcome":{"S":"ok"}}]}`;

  it('a failing query fails closed AND returns the reason the summary prints', () => {
    fakeAws('echo "Unable to locate credentials" >&2; exit 255');
    const r = readCostRows(LANES[0], Date.now(), fullEnv);
    expect(r.rows).toEqual([]);
    expect(r.error).toBe('the store query failed (Unable to locate credentials)');
  });

  it('one lane failing does not stop the next lane being read', () => {
    // The first draft shared one mutable state across lanes and returned early once it
    // held a reason, so an `implement` blip cost `triage` its discounts too.
    fakeAws(`case "$*" in *COST#${LANES[0].telemetryAgent}*) echo boom >&2; exit 1;; esac\necho '${ROW}'`);
    const reads = new Map(LANES.map((l) => [l.key, readCostRows(l, Date.now(), fullEnv)]));
    expect(reads.get(LANES[0].key)?.error).toMatch(/boom/);
    expect(reads.get(LANES[1].key)).toMatchObject({ error: null });
    expect(reads.get(LANES[1].key)?.rows).toHaveLength(1);
  });

  it('a precondition skips the query and is the reason', () => {
    fakeAws(`echo '${ROW}'`);
    expect(readCostRows(LANES[0], Date.now(), { ...fullEnv, QA_AWS_REGION: '' })).toEqual({ rows: [], error: 'QA_AWS_REGION is unset' });
  });
});

describe('main() carries the line to the summary', () => {
  // A pure line that `main` never prints is the guard that cannot fail, so the wiring is
  // asserted against the source: the line reaches the report, the report reaches the
  // summary, and a run with no open issues still states a broken AWS step.
  const src = readFileSync(join(ROOT, 'scripts/dispatch-sweep.mjs'), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    if (i === -1 || src.indexOf(needle, i + 1) !== -1) throw new Error(`anchor missing or not unique — re-point: ${needle}`);
    return i;
  };

  it('builds the line from the per-lane reads and hands it to the report', () => {
    expect(at('const costLine = costReadLine(reads);')).toBeLessThan(at('report(verdicts, breaker, costLine);'));
    expect(src).toContain('renderReport(verdicts, { apply: APPLY, breaker, costLine })');
  });

  it('states a broken AWS step even when no lane has an open issue', () => {
    const quiet = src.slice(at('if (total === 0) {'), at('// ONE PR fetch for every lane'));
    expect(quiet).toContain('costReadPrecondition()');
    expect(quiet).toMatch(/appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY, `\$\{line\}\\n`\)/);
  });
});
