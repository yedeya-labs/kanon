import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeStub } from '../unit/helpers/stub-bin.js';
import {
  LANES, costReadLine, costReadPrecondition, costRowsSource, costSourceLine, readCostRows, readLaneCostRows, readStoreCostRows,
  renderReport, storeRowsEnv,
} from '../../scripts/dispatch-sweep.mjs';
import { ROOT } from './helpers/adopter.js';
import { SPAWNS } from '../unit/helpers/spawns.js';

/**
 * RA-2706 — a store read that did not happen must say so (`K-PRIN-8`).
 *
 * The sweep's job lacked `environment: qa`, so the AWS step got an empty region, the
 * step is `continue-on-error`, and `readCostRows` failed closed: every scheduled run
 * charged every dispatch while its summary looked exactly like a normal sweep. Failing
 * closed is right; failing closed QUIETLY is the bug. These tests drive each way the
 * read can be skipped or fail and assert the summary states it.
 *
 * That direct read is what an adopter's own sweep workflow does, before it calls Kanon's lane.
 * Kanon's lane (`agent-dispatch-sweep.yml`, plan 0004 step 9) reads the rows through the store
 * hook in a store job of its own, or from run artifacts without a hook; `costRowsSource` picks,
 * and the last two describes below drive the script end to end through both.
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
    expect(at('const costLine = costLines(source, reads);')).toBeLessThan(at('report(verdicts, breaker, costLine);'));
    expect(at('warnCostRead(costReadLine(reads));')).toBeLessThan(at('report(verdicts, breaker, costLine);'));
    expect(src).toContain('renderReport(verdicts, { apply: APPLY, breaker, costLine })');
  });

  it('states a broken AWS step even when no lane has an open issue', () => {
    const quiet = src.slice(at('if (total === 0) {'), at('// ONE PR fetch for every lane'));
    expect(quiet).toContain('costReadPrecondition()');
    expect(quiet).toMatch(/appendFileSync\(process\.env\.GITHUB_STEP_SUMMARY, `\$\{line\}\\n`\)/);
  });
});

// ── Plan 0004 step 9: the store first, run artifacts without one (§3.3, decision 3) ──────────

describe('costRowsSource — where the rows come from', () => {
  it('reads the store when the store job succeeded and the repository has a hook', () => {
    expect(costRowsSource({ QA_STORE_RESULT: 'success', QA_STORE_PRESENT: 'true' })).toBe('store');
  });
  it('reads run artifacts when the store job says there is no hook', () => {
    expect(costRowsSource({ QA_STORE_RESULT: 'success', QA_STORE_PRESENT: 'false' })).toBe('artifacts');
  });
  it('fails closed when the store job did not succeed, or handed over nothing', () => {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(costRowsSource({ QA_STORE_RESULT: result, QA_STORE_PRESENT: 'false' }), result).toBe('store-failed');
    }
    expect(costRowsSource({ QA_STORE_RESULT: 'success', QA_STORE_PRESENT: '' })).toBe('store-failed');
  });
  it('keeps the direct read for a workflow that runs no store job (an adopter\'s own, before its switch)', () => {
    expect(costRowsSource({ QA_DYNAMO_TABLE: 't' })).toBe('direct');
    expect(costRowsSource({})).toBe('direct');
  });
});

describe('readStoreCostRows — the store job\'s answer, failing closed', () => {
  const lane = LANES[0]!;
  const row = { ts: '20261001T000000Z', issue_number: '7', outcome: 'unavailable', run_id: '42' };
  const env = (v: string) => ({ [storeRowsEnv(lane)]: v });

  it('names one variable per telemetry agent', () => {
    expect(LANES.map((l) => storeRowsEnv(l))).toEqual(['QA_STORE_COST_ROWS_IMPLEMENTER', 'QA_STORE_COST_ROWS_TRIAGE_FIX']);
  });
  it('passes the rows through', () => {
    expect(readStoreCostRows(lane, env(JSON.stringify({ rows: [row], error: null })))).toEqual({ rows: [row], error: null });
  });
  it('keeps the store\'s own error, so a degraded read says why', () => {
    expect(readStoreCostRows(lane, env(JSON.stringify({ rows: [], error: 'the store query failed (AccessDenied)' }))))
      .toEqual({ rows: [], error: 'the store query failed (AccessDenied)' });
  });
  it('reads an empty or malformed value as no rows and an error, never as "no runs"', () => {
    expect(readStoreCostRows(lane, {})).toEqual({ rows: [], error: 'the store job handed over no readable cost rows in QA_STORE_COST_ROWS_IMPLEMENTER' });
    expect(readStoreCostRows(lane, env('[]'))).toEqual({ rows: [], error: "the store job's cost rows are malformed (not a JSON object)" });
    expect(readStoreCostRows(lane, env(JSON.stringify({ rows: [{ ...row, issue_number: 7 }] })))).toEqual({
      rows: [], error: "the store job's cost rows are malformed (rows[0].issue_number is neither a string nor null)",
    });
  });
});

describe('readLaneCostRows and costSourceLine — the fallback, and what the summary says', () => {
  const lane = LANES[0]!;
  type ArtifactRead = { rows: unknown[]; error: string | null; retentionDays: number | null; days: number };
  const artifacts = (retentionDays: number | null) => (): ArtifactRead => ({ rows: [{}], error: null, retentionDays, days: 14 });

  it('without a hook, reads run artifacts, and says so with the retention note when it is shorter than the window', () => {
    const read = readLaneCostRows(lane, 'artifacts', { env: {}, artifacts: artifacts(5) as never });
    expect(read).toMatchObject({ rows: [{}], error: null, retentionDays: 5 });
    const line = costSourceLine('artifacts', new Map([['implement', read], ['triage', { rows: [], error: null, retentionDays: 90, days: 14 }]]));
    expect(line).toBe('Cost rows from run artifacts: this repository has no QA store hook (`.github/actions/qa-store/action.yml`). '
      + 'The repository keeps artifacts 5 days, so the artifact read covers 5 of the 14-day window.');
  });
  it('carries no note when the repository keeps artifacts for the whole window, or no artifact said', () => {
    const covered = costSourceLine('artifacts', new Map([['implement', { retentionDays: 90 }], ['triage', { retentionDays: null }]]));
    expect(covered).toBe('Cost rows from run artifacts: this repository has no QA store hook (`.github/actions/qa-store/action.yml`).');
  });
  it('with a hook, never reads artifacts', () => {
    const never = () => { throw new Error('read artifacts with a store hook'); };
    const v = JSON.stringify({ rows: [], error: null });
    expect(readLaneCostRows(lane, 'store', { env: { [storeRowsEnv(lane)]: v }, artifacts: never as never })).toEqual({ rows: [], error: null });
    expect(costSourceLine('store', new Map())).toBe('Cost rows from the QA store, through its hook (`cost-rows`).');
  });
  it('a failed store job charges every dispatch and says so, without reading artifacts', () => {
    const never = () => { throw new Error('read artifacts after a failed store job'); };
    const read = readLaneCostRows(lane, 'store-failed', { env: { QA_STORE_RESULT: 'failure' }, artifacts: never as never });
    expect(read).toEqual({ rows: [], error: 'the QA store job did not hand over cost rows (result: failure)' });
    expect(costReadLine(new Map([['implement', read]]))).toMatch(NOT_READ);
  });
  it('the direct read says nothing about its source, as before', () => {
    expect(costSourceLine('direct', new Map())).toBe('');
  });
});

// Its cases run the sweep end to end, against stubs on PATH, so the block takes the spawn budget (#436).
describe('the sweep, run end to end through the lane\'s two paths', SPAWNS, () => {
  // `main()` itself, with `gh` stubbed: what the lane's sweep step prints for each source.
  let bin: string;
  let summary: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'sweep-main-'));
    summary = join(bin, 'summary.md');
    writeFileSync(summary, '');
  });
  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  const DAY = 86_400_000;
  const run = (env: Record<string, string>, gh: string) => {
    writeStub(join(bin, 'gh'), `#!/usr/bin/env bash\n${gh}\n`);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QA_|APPLY$|GITHUB_STEP_SUMMARY$)/.test(k)));
    const out = execFileSync('node', [join(ROOT, 'scripts/dispatch-sweep.mjs')], {
      encoding: 'utf8',
      env: { ...clean, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'example-org/example-repo', GITHUB_STEP_SUMMARY: summary, ...env },
    });
    return { out, summary: readFileSync(summary, 'utf8') };
  };
  const ISSUE = JSON.stringify([{ number: 7, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'agent:implement' }], body: '' }]);
  const OPEN_ISSUE = [
    'case "$1 $2" in',
    `  "issue list") case "$*" in *agent:implement*) echo '${ISSUE}';; *) echo '[]';; esac;;`,
    '  "pr list") echo \'[]\';;',
    '  "issue view") echo \'{"comments":[]}\';;',
    '  *) echo "unexpected: gh $*" >&2; exit 1;;',
    'esac',
  ].join('\n');

  it('with a store hook: the summary says "Cost rows read" with a count for both lanes (the live check)', () => {
    const row = { ts: '20261001T000000Z', issue_number: '7', outcome: 'ok', run_id: '1' };
    const r = run({
      QA_STORE_RESULT: 'success', QA_STORE_PRESENT: 'true',
      QA_STORE_COST_ROWS_IMPLEMENTER: JSON.stringify({ rows: [row], error: null }),
      QA_STORE_COST_ROWS_TRIAGE_FIX: JSON.stringify({ rows: [], error: null }),
    }, OPEN_ISSUE);
    expect(r.summary).toContain('Cost rows from the QA store, through its hook (`cost-rows`).');
    expect(r.summary).toContain('Cost rows read (RA-1517): 1 `implement` · 0 `triage`.');
    expect(r.summary).not.toMatch(/run artifacts|NOT read/);
  });

  it('MUTATION: with the hook removed, the sweep reads run artifacts, says so, and carries the retention note', () => {
    // One version-2 artifact of this repository's own run, kept 5 days (the reference
    // adopter's setting), of a lane the sweep doesn't read: the retention is measured from
    // it, and nothing is downloaded.
    const created = Date.now() - DAY;
    const listing = JSON.stringify({ artifacts: [{
      id: 1, name: 'kanon-telemetry-review-123-1', expired: false,
      created_at: new Date(created).toISOString(), expires_at: new Date(created + 5 * DAY).toISOString(),
      workflow_run: { id: 123, repository_id: 1, head_repository_id: 1 },
    }] });
    const gh = OPEN_ISSUE.replace('  *) echo', `  "api repos/example-org/example-repo/actions/artifacts?per_page=100&page=1") echo '${listing}';;\n  *) echo`);
    const r = run({ QA_STORE_RESULT: 'success', QA_STORE_PRESENT: 'false' }, gh);
    expect(r.summary).toContain('Cost rows from run artifacts: this repository has no QA store hook');
    expect(r.summary).toContain('The repository keeps artifacts 5 days, so the artifact read covers 5 of the 14-day window.');
    expect(r.summary).toContain('Cost rows read (RA-1517): 0 `implement` · 0 `triage`.');
  });

  it('a quiet day still says where the rows came from, and a failed store job', () => {
    const quiet = 'case "$1 $2" in\n  "issue list") echo \'[]\';;\n  *) echo "unexpected: gh $*" >&2; exit 1;;\nesac';
    const failed = run({ QA_STORE_RESULT: 'failure' }, quiet);
    expect(failed.summary).toContain('Cost rows from the QA store: its job did not succeed.');
    expect(failed.summary).toMatch(/\*\*Cost rows NOT read: the QA store job did not hand over cost rows \(result: failure\)/);
    expect(failed.out).toContain('::warning title=qa-dispatch-sweep::Cost rows NOT read');
    const ok = run({ QA_STORE_RESULT: 'success', QA_STORE_PRESENT: 'true', QA_STORE_COST_ROWS_IMPLEMENTER: '{"rows":[],"error":null}', QA_STORE_COST_ROWS_TRIAGE_FIX: '{"rows":[],"error":null}' }, quiet);
    expect(ok.summary).toContain('Cost rows read (RA-1517): 0 `implement` · 0 `triage`.');
  });
});
