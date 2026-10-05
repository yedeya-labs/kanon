import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COST_KEYS,
  ROUTE_KEYS,
  SUMMARY_FILE,
  SUMMARY_KEYS,
  checkSummary,
  cli,
  readSummary,
  runProblems,
} from '../../scripts/explore-summary.mjs';
import { decide } from '../../scripts/explore-gate.mjs';

/**
 * Plan 0004 step 12 (§4): the Explorer's sweep summary, the one file Kanon's explore lane reads
 * from the adopter's sweep hook. `checkSummary` moved from the reference adopter's hook
 * (RA-2746, ADR 0009), where it was the format's executable definition; these hold it to the
 * plan's format, key by key, and hold the lane's reading to "no summary is no sweep, never
 * green". Each failure names the key, because a hook and a lane that disagree must say where.
 */
const SHA = '0123456789abcdef0123456789abcdef01234567';
const good = () => ({
  timestamp: '2026-10-04T06:21:42.512Z',
  trigger: 'schedule',
  commit: SHA,
  tier: 'all',
  routes_swept: 3,
  passed: 2,
  failed: 1,
  routes: [
    { route: '/', status: 'passed' },
    { route: '/courses', status: 'passed' },
    { route: '/admin/courses', status: 'failed', signal: 'objective signals on /admin/courses: [pageerror] Minified React error #418' },
  ],
  cost_proxy: { duration_ms_total: 48210, screenshots: 3 },
});
type Summary = ReturnType<typeof good> & Record<string, unknown>;
const with_ = (change: (s: Summary) => void): Summary => {
  const s = good() as Summary;
  change(s);
  return s;
};

describe('the format: exactly plan 0004 §4\'s keys', () => {
  it('names exactly the plan\'s keys, at each level', () => {
    expect(SUMMARY_KEYS).toEqual(['timestamp', 'trigger', 'commit', 'tier', 'routes_swept', 'passed', 'failed', 'routes', 'cost_proxy']);
    expect(ROUTE_KEYS).toEqual(['route', 'status', 'signal']);
    expect(COST_KEYS).toEqual(['duration_ms_total', 'screenshots']);
    expect(SUMMARY_FILE).toBe('qa-explore-summary.json');
  });

  it('passes the worked summary, and one of a clean sweep with no signal', () => {
    expect(checkSummary(good())).toEqual([]);
    expect(checkSummary(with_((s) => { s.routes = [{ route: '/', status: 'passed' }]; s.routes_swept = 1; s.passed = 1; s.failed = 0; }))).toEqual([]);
    // A failed route that reported no signal is allowed: `signal` is only ever optional.
    expect(checkSummary(with_((s) => { s.routes[2] = { route: '/admin/courses', status: 'failed' }; }))).toEqual([]);
  });

  it('fails a key outside the list, by name: a version key included (§4\'s first open item)', () => {
    expect(checkSummary(with_((s) => { s.version = 1; }))).toEqual(['`version` is not a summary key']);
    expect(checkSummary(with_((s) => { s.routes[0] = { ...s.routes[0]!, duration: 3 } as never; }))).toEqual(['routes[0].duration is not a route key']);
    expect(checkSummary(with_((s) => { (s.cost_proxy as Record<string, unknown>).tokens = 1; }))).toEqual(['cost_proxy.tokens is not a cost key']);
  });

  it('fails each missing key, by name', () => {
    for (const k of SUMMARY_KEYS) {
      const s = good() as Record<string, unknown>;
      delete s[k];
      expect(checkSummary(s), k).toContain(`\`${k}\` is missing`);
    }
  });

  it('fails passed + failed unequal to routes_swept, even when routes is malformed', () => {
    expect(checkSummary(with_((s) => { s.failed = 2; }))).toEqual(['`failed` is 2, and 1 routes failed', '`passed` + `failed` is 4, not `routes_swept` (3)']);
    // The equation on its own: counts that agree with each other but not with themselves.
    const p = checkSummary(with_((s) => { s.routes = 'nope' as never; s.passed = 2; s.failed = 2; s.routes_swept = 3; }));
    expect(p).toContain('`routes` is not an array');
    expect(p).toContain('`passed` + `failed` is 4, not `routes_swept` (3)');
  });

  it('fails counts that disagree with the routes they count', () => {
    expect(checkSummary(with_((s) => { s.routes_swept = 4; }))).toContain('`routes_swept` is 4, and `routes` holds 3');
    expect(checkSummary(with_((s) => { s.passed = 3; s.failed = 0; }))).toEqual(['`passed` is 3, and 2 routes passed', '`failed` is 0, and 1 routes failed']);
  });

  it('fails a malformed value, by key', () => {
    expect(checkSummary(with_((s) => { s.timestamp = 'Oct 4 2026'; }))).toEqual(['`timestamp` is not an ISO date']);
    expect(checkSummary(with_((s) => { s.trigger = ''; }))).toEqual(['`trigger` is not a non-empty string']);
    expect(checkSummary(with_((s) => { s.tier = 3 as never; }))).toEqual(['`tier` is not a non-empty string']);
    expect(checkSummary(with_((s) => { s.routes[0]!.status = 'skipped'; }))).toContain('routes[0].status is not passed or failed');
    expect(checkSummary(with_((s) => { (s.routes[0] as Record<string, unknown>).signal = 'x'; }))).toEqual(['routes[0].signal is only a non-empty string on a failed route']);
    expect(checkSummary(with_((s) => { s.cost_proxy.screenshots = 1.5; }))).toEqual(['cost_proxy.screenshots is not a count']);
    expect(checkSummary(with_((s) => { s.cost_proxy.duration_ms_total = -1; }))).toEqual(['cost_proxy.duration_ms_total is not a non-negative number']);
    expect(checkSummary([])).toEqual(['the summary is not a JSON object']);
    expect(checkSummary(null)).toEqual(['the summary is not a JSON object']);
  });
});

describe('the lane\'s reading: no summary is no sweep, never green', () => {
  const at = (body?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'explore-summary-'));
    const path = join(dir, SUMMARY_FILE);
    if (body !== undefined) writeFileSync(path, body);
    return path;
  };

  it('reads a missing file as no sweep', () => {
    const r = readSummary(at());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems).toEqual(['the sweep hook wrote no qa-explore-summary.json: no sweep, which is never green']);
  });

  it('reads a file that is not JSON as no sweep', () => {
    const r = readSummary(at('{"timestamp":'));
    expect(!r.ok && r.problems).toEqual(['qa-explore-summary.json is not JSON']);
  });

  it('reads a summary of another commit or tier, or of no route, as no sweep', () => {
    expect(runProblems(good(), { commit: SHA, tier: '' })).toEqual([]);
    expect(runProblems(good(), { commit: 'f'.repeat(40) })).toEqual([`\`commit\` is ${SHA}, and this run swept ${'f'.repeat(40)}`]);
    expect(runProblems(good(), { tier: 'admin' })).toEqual(['`tier` is all, and this run asked for admin']);
    expect(runProblems(with_((s) => { s.tier = 'admin'; }), { tier: '' })).toEqual(['`tier` is admin, and this run asked for all']);
    const empty = with_((s) => { s.routes = []; s.routes_swept = 0; s.passed = 0; s.failed = 0; });
    expect(checkSummary(empty)).toEqual([]);
    expect(runProblems(empty)).toEqual(['the sweep swept no route']);
  });

  it('the CLI exits 1 with one error per problem, and 0 with the counts', () => {
    const bad = cli(['check', at(JSON.stringify(with_((s) => { s.version = 1; s.routes_swept = 9; }))), '--commit', SHA, '--tier', '']);
    expect(bad.code).toBe(1);
    expect(bad.lines.filter((l) => l.startsWith('::error'))).toEqual([
      '::error title=Explorer sweep summary::`version` is not a summary key',
      '::error title=Explorer sweep summary::`routes_swept` is 9, and `routes` holds 3',
      '::error title=Explorer sweep summary::`passed` + `failed` is 3, not `routes_swept` (9)',
    ]);
    const ok = cli(['check', at(JSON.stringify(good())), '--commit', SHA, '--tier', '']);
    expect(ok).toMatchObject({ code: 0, outputs: { routes_swept: '3', passed: '2', failed: '1' } });
    expect(cli(['check']).code).toBe(2);
    expect(cli(['check', 'x', '--model', 'y']).code).toBe(2);
  });
});

describe('the change gate\'s decision', () => {
  const base = { EVENT: 'schedule', HEAD_SHA: SHA, BASELINE_RESULT: 'success', STATE: 'ok', LAST_GREEN: SHA };

  it('skips only a scheduled run on the very commit of the last green full sweep', () => {
    expect(decide(base).sweep).toBe(false);
    expect(decide({ ...base, LAST_GREEN: `${SHA}\n` }).sweep).toBe(false);
  });

  it('sweeps on everything else', () => {
    for (const change of [
      { EVENT: 'workflow_dispatch' },
      { LAST_GREEN: '' },
      { LAST_GREEN: 'f'.repeat(40) },
      { STATE: 'absent', LAST_GREEN: '' },
      { STATE: 'degraded' },
      { BASELINE_RESULT: 'failure' },
      { BASELINE_RESULT: 'cancelled' },
      { BASELINE_RESULT: '' },
      { STATE: '' },
    ]) {
      expect(decide({ ...base, ...change }).sweep, JSON.stringify(change)).toBe(true);
    }
  });

  it('warns on a degraded answer, and not on an absent store or a dispatch', () => {
    expect(decide({ ...base, STATE: 'degraded' }).warning).toMatch(/could not be read/);
    expect(decide({ ...base, BASELINE_RESULT: 'failure' }).warning).toMatch(/ended `failure`/);
    expect(decide({ ...base, STATE: 'absent', LAST_GREEN: '' })).toMatchObject({ warning: null, line: expect.stringContaining('The QA store is absent') });
    expect(decide({ ...base, EVENT: 'workflow_dispatch' }).warning).toBeNull();
  });
});
