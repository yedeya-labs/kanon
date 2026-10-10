import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { MIN_ADOPTERS } from '../../infra/telemetry/function/aggregate.mjs';
import {
  MARKER, RISE, compareVersions, detect, main, parseRows, renderIssue, riseSignature, signalSignature, signature,
} from '../../scripts/telemetry/kanon-bugs.mjs';

/**
 * #41, part 1: the public detection logic for Kanon's own bugs in adopters' runs. Pure, so every
 * case runs on fixture rows in the schema's shape, keyed by made-up adopter keys. Nothing touches
 * the network or AWS.
 */

type Row = Record<string, unknown>;
let seq = 0;
/** One run row. Each carries a run id, a PR and an issue number, which no output may hold. */
const row = (adopter: string, over: Row = {}): Row => ({
  schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: '2026-10-05T10:00:00Z',
  run_id: 98_765_432_100 + (seq += 1), run_attempt: 1, pr_number: 4242, issue_number: 4343,
  role: 'reviewer', lane: 'review', outcome: 'ok', reason: 'none', kanon_version: '0.36.0', adopter, ...over,
});
const failed = (adopter: string, over: Row = {}): Row =>
  row(adopter, { outcome: 'failed', reason: 'did_not_finish', failed_stage: 'agent', ...over });
const many = (n: number, make: (i: number) => Row): Row[] => Array.from({ length: n }, (_, i) => make(i));

describe('signals: the failed runs, grouped by lane, stage, error, reason and version', () => {
  it('counts runs and adopters, and keeps first and last seen and the API status codes', () => {
    const { signals } = detect([
      failed('k2', { recorded_at: '2026-10-04T08:00:00Z', api_error_status: 400 }),
      failed('k1', { recorded_at: '2026-10-03T08:00:00Z', api_error_status: 400 }),
      failed('k1', { recorded_at: '2026-10-06T09:00:00Z' }),
      row('k3'),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'signal', lane: 'review', failed_stage: 'agent', kanon_error: null, reason: 'did_not_finish', kanon_version: '0.36.0',
      runs: 3, adopters: 2, first_seen: '2026-10-03T08:00:00Z', last_seen: '2026-10-06T09:00:00Z', api_error_status: { 400: 2 },
    });
  });

  it('keeps apart what differs in any of the five fields', () => {
    const { signals } = detect([
      failed('k1'), failed('k1', { kanon_version: '0.35.0' }), failed('k1', { lane: 'triage', role: 'implementer' }),
      failed('k1', { failed_stage: 'hook' }), failed('k1', { kanon_error: 'unhandled' }),
      failed('k1', { outcome: 'exhausted', reason: 'turn_cap', failed_stage: undefined }),
    ]);
    expect(signals).toHaveLength(6);
  });

  it('reads only rows of the asked tag, with a Kanon version and an adopter key', () => {
    const r = detect([
      failed('k1', { tag: 'smoke' }), failed('k1', { kanon_version: undefined }), failed('', {}),
      failed('k1', { row_kind: 'work_item' }), failed('k1'),
    ]);
    expect(r.signals.map((s) => s.runs)).toEqual([1]);
    expect(r.skipped).toEqual({ not_run: 2, no_version: 1, no_adopter: 1, unknown_code: 0 });
    // A seeded test combination is read only when asked for (#41's "Done when").
    expect(detect([failed('k1', { tag: 'test' })], { tag: 'test' }).signals).toHaveLength(1);
  });

  it("takes the adopter from the stored partition when the row has no `adopter`", () => {
    const { signals } = detect([failed('', { pk: 'aa11bb22#review' }), failed('', { pk: 'cc33dd44#review' })]);
    expect(signals[0]?.adopters).toBe(2);
  });

  it("skips a row whose lane, stage, error, reason, outcome or time is not one of the schema's", () => {
    const r = detect([
      failed('k1', { lane: 'acme/widgets' }), failed('k1', { failed_stage: 'Install pnpm' }),
      failed('k1', { kanon_error: '/home/runner/work/x' }), failed('k1', { reason: 'it broke' }),
      failed('k1', { outcome: 'boom' }), failed('k1', { outcome: undefined }), failed('k1', { recorded_at: 'yesterday' }),
      failed('k1', { kanon_version: 'v1' }),
    ]);
    expect(r.signals).toEqual([]);
    expect(r.skipped).toEqual({ not_run: 0, no_version: 1, no_adopter: 0, unknown_code: 7 });
  });
});

describe('the classification (plan 0002 §2.6)', () => {
  const prior = (n: number, over: Row = {}) => many(n, () => row('k1', { kanon_version: '0.35.0', ...over }));

  it('is `kanon` for the same failure at two adopters', () => {
    expect(detect([failed('k1'), failed('k2')]).signals[0]?.classification).toBe('kanon');
  });

  it('is `adopter` for a failure at one adopter only, such as its hook', () => {
    expect(detect([failed('k1', { failed_stage: 'hook' }), failed('k1', { failed_stage: 'hook' })]).signals[0]?.classification).toBe('adopter');
  });

  it('is `kanon` for one adopter when the failure starts at a release the previous one ran enough of', () => {
    const s = detect([...prior(RISE.minRuns), failed('k1', { kanon_version: '0.36.0' })]).signals[0];
    expect(s).toMatchObject({ classification: 'kanon', starts_at_release: true });
  });

  it('is not "starting at a release" when the previous release ran the lane too few times', () => {
    const s = detect([...prior(RISE.minRuns - 1), failed('k1')]).signals[0];
    expect(s).toMatchObject({ classification: 'adopter', starts_at_release: false });
  });

  it("counts only the signal's own adopters' runs of the previous release: a new adopter's hook failure is `adopter`", () => {
    const s = detect([...prior(RISE.minRuns), failed('k9', { failed_stage: 'hook' })]).signals[0];
    expect(s).toMatchObject({ classification: 'adopter', starts_at_release: false });
    // Its own runs of the previous release, together with a second affected adopter's, do count.
    const both = detect([
      ...many(RISE.minRuns - 5, () => row('k1', { kanon_version: '0.35.0' })), ...many(5, () => row('k2', { kanon_version: '0.35.0' })),
      ...many(30, () => row('k3', { kanon_version: '0.35.0' })), failed('k1'), failed('k2'),
    ]).signals[0];
    expect(both).toMatchObject({ starts_at_release: true });
    const short = detect([
      ...many(RISE.minRuns - 6, () => row('k1', { kanon_version: '0.35.0' })), ...many(5, () => row('k2', { kanon_version: '0.35.0' })),
      ...many(30, () => row('k3', { kanon_version: '0.35.0' })), failed('k1'), failed('k2'),
    ]).signals[0];
    expect(short).toMatchObject({ starts_at_release: false });
  });

  it('is not "starting at a release" when the previous release failed the same way', () => {
    const s = detect([...prior(RISE.minRuns), failed('k1', { kanon_version: '0.35.0' }), failed('k1')]).signals
      .find((x) => x.kanon_version === '0.36.0');
    expect(s).toMatchObject({ classification: 'adopter', starts_at_release: false });
  });

  it('compares with the release just before, by number, not by text', () => {
    const s = detect([...prior(RISE.minRuns, { kanon_version: '0.9.0' }), failed('k1', { kanon_version: '0.10.0' })]).signals[0];
    expect(s).toMatchObject({ starts_at_release: true });
    // 0.9.0 is the release just before 0.10.0: had 0.1.0 been taken for it, the absence would not count.
    expect(detect([...prior(RISE.minRuns, { kanon_version: '0.9.0' }), row('k1', { kanon_version: '0.1.0' }), failed('k1', { kanon_version: '0.10.0' })])
      .signals[0]).toMatchObject({ starts_at_release: true });
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('dev', '9.9.9')).toBeGreaterThan(0);
    // `dev` is no release, so nothing starts at it.
    expect(detect([failed('k1', { kanon_version: 'dev' }), ...prior(RISE.minRuns)]).signals[0]?.starts_at_release).toBe(false);
  });

  it("compares each adopter affected with the release IT ran before, not the one just before among every adopter's (#562)", () => {
    // k1 pins 0.35.0 and k2 0.35.1. k1 moves to 0.36.0, and a failure starts there for k1 alone.
    const pinned = [...prior(RISE.minRuns), ...many(RISE.minRuns, () => row('k2', { kanon_version: '0.35.1' }))];
    const s = detect([...pinned, failed('k1')]).signals[0];
    expect(s).toMatchObject({ classification: 'kanon', starts_at_release: true, adopters: 1 });
    // The same failure on 0.35.0, k1's own previous release, means it did not start at 0.36.0.
    expect(detect([...pinned, failed('k1', { kanon_version: '0.35.0' }), failed('k1')]).signals
      .find((x) => x.kanon_version === '0.36.0')).toMatchObject({ classification: 'adopter', starts_at_release: false });
  });

  it('takes, for each adopter, the last release on which it ran THIS lane', () => {
    // k1 ran the review lane on 0.35.0, and only the triage lane on 0.35.1.
    const s = detect([
      ...prior(RISE.minRuns), ...many(RISE.minRuns, () => row('k1', { kanon_version: '0.35.1', lane: 'triage', role: 'implementer' })),
      failed('k1'),
    ]).signals[0];
    expect(s).toMatchObject({ classification: 'kanon', starts_at_release: true });
  });

  it("sums the adopters' runs on their own previous releases, and needs the signal absent on every one of them", () => {
    const split = [
      ...many(RISE.minRuns / 2, () => row('k1', { kanon_version: '0.35.0' })),
      ...many(RISE.minRuns / 2, () => row('k2', { kanon_version: '0.35.1' })),
    ];
    expect(detect([...split, failed('k1'), failed('k2')]).signals[0]).toMatchObject({ starts_at_release: true });
    // One run fewer, and the sample is too small.
    expect(detect([...split.slice(1), failed('k1'), failed('k2')]).signals[0]).toMatchObject({ starts_at_release: false });
    // Present on k2's previous release, though not on k1's: it did not start at 0.36.0.
    expect(detect([...split, failed('k2', { kanon_version: '0.35.1' }), failed('k1'), failed('k2')]).signals
      .find((x) => x.kanon_version === '0.36.0')).toMatchObject({ starts_at_release: false });
  });

  it("names no adopter's previous release, in the JSON or in the issue", () => {
    // Which release each adopter ran before is a fact about that adopter: not in a signal.
    const s = detect([...prior(RISE.minRuns), ...many(RISE.minRuns, () => row('k2', { kanon_version: '0.35.1' })), failed('k1')]).signals[0]!;
    expect(s).not.toHaveProperty('previous_version');
    expect(JSON.stringify(s)).not.toMatch(/0\.35\.[01]/);
    expect(s.issue.body).toContain('It starts at this release: absent on the release each adopter affected ran before it');
  });

  it('is `platform` when every run carries a rate limit, a server error or an unreachable model, at any number of adopters', () => {
    for (const over of [{ api_error_status: 429 }, { api_error_status: 500 }, { api_error_status: 529 }]) {
      expect(detect([failed('k1', over), failed('k2', over)]).signals[0]?.classification, JSON.stringify(over)).toBe('platform');
    }
    const never = { outcome: 'unavailable', reason: 'model_never_ran', failed_stage: undefined };
    expect(detect([row('k1', never), row('k2', never)]).signals[0]?.classification).toBe('platform');
    expect(detect([row('k1', { ...never, reason: 'no_model_ran' })]).signals[0]?.classification).toBe('platform');
  });

  it('is not `platform` when one run lacks a platform code, nor for a client error', () => {
    expect(detect([failed('k1', { api_error_status: 429 }), failed('k2')]).signals[0]?.classification).toBe('kanon');
    expect(detect([failed('k1', { api_error_status: 400 }), failed('k2', { api_error_status: 401 })]).signals[0]?.classification).toBe('kanon');
    expect(detect([failed('k1', { api_error_status: 499 })]).signals[0]?.classification).toBe('adopter');
  });
});

describe('public or private (the Owner, 2026-10-07 on #41: the three-adopter rule of #449)', () => {
  const at = (n: number) => detect(many(n, (i) => failed(`k${i}`))).signals[0]?.visibility;

  it("uses the aggregate's threshold, which is three", () => {
    expect(MIN_ADOPTERS).toBe(3);
    expect(readFileSync('scripts/telemetry/kanon-bugs.mjs', 'utf8')).not.toMatch(/MIN_ADOPTERS\s*=/);
  });

  it('is private below it and public at it', () => {
    expect(at(1)).toBe('private');
    expect(at(MIN_ADOPTERS - 1)).toBe('private');
    expect(at(MIN_ADOPTERS)).toBe('public');
    expect(at(MIN_ADOPTERS + 2)).toBe('public');
  });

  it('counts distinct adopters, not runs', () => {
    expect(detect(many(50, () => failed('k1')).concat(failed('k2'))).signals[0]).toMatchObject({ runs: 51, adopters: 2, visibility: 'private' });
  });
});

describe('new, and the signature', () => {
  it('is new unless its signature is known', () => {
    const s = detect([failed('k1')]).signals[0]!;
    expect(s.new).toBe(true);
    expect(detect([failed('k1')], { known: [s.signature] }).signals[0]?.new).toBe(false);
    expect(detect([failed('k1')], { known: ['0'.repeat(24)] }).signals[0]?.new).toBe(true);
  });

  it('stays the same as the counts grow, and changes with any identifying field', () => {
    const one = detect([failed('k1')]).signals[0]!;
    const more = detect([failed('k1'), failed('k2'), failed('k3', { recorded_at: '2026-10-07T00:00:00Z' })]).signals[0]!;
    expect(more.signature).toBe(one.signature);
    const base = { lane: 'review', failed_stage: 'agent', kanon_error: null, reason: 'did_not_finish', kanon_version: '0.36.0' };
    const sigs = [base, { ...base, lane: 'triage' }, { ...base, failed_stage: 'hook' }, { ...base, kanon_error: 'unhandled' },
      { ...base, reason: 'turn_cap' }, { ...base, kanon_version: '0.37.0' }].map(signalSignature);
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(sigs[0]).toMatch(/^[0-9a-f]{24}$/);
    expect(riseSignature({ lane: 'review', kanon_version: '0.36.0' })).not.toBe(sigs[0]);
  });

  it('is the signature a finding shares (plan 0006 §2.4), and every signal\'s is unchanged by it', () => {
    expect(signalSignature).toBe(signature);
    // Measured on main before `signature` existed: a change to any signal's signature would orphan
    // every open issue the job filed under the old one.
    const golden: [Parameters<typeof signature>[0], string][] = [
      [{ lane: 'review', failed_stage: 'agent', kanon_error: null, reason: 'did_not_finish', kanon_version: '0.36.0' }, 'a047bfc3341895d98e2d5d55'],
      [{ lane: 'implement', failed_stage: 'hook', kanon_error: 'hook_missing', reason: 'no_result_file', kanon_version: '0.37.0' }, 'd048f7cbcebf84e1b61c7af6'],
      [{ lane: 'overseer', failed_stage: null, kanon_error: null, reason: 'turn_cap', kanon_version: 'dev' }, 'd96659995c0f41c5ba747f84'],
      [{ lane: 'triage', failed_stage: 'token', kanon_error: 'unhandled', reason: 'no_result_file', kanon_version: '0.30.0' }, '9788cc85aaeb49282d3fd821'],
    ];
    for (const [s, sig] of golden) expect(signature(s)).toBe(sig);
    // And every signal `detect` makes has the signature the old formula gave it.
    const old = (s: { lane: string, failed_stage: string | null, kanon_error: string | null, reason: string, kanon_version: string }) =>
      createHash('sha256').update(['signal', s.lane, s.failed_stage ?? '-', s.kanon_error ?? '-', s.reason, s.kanon_version].join('\n')).digest('hex').slice(0, 24);
    const rows = [failed('k1'), failed('k2', { failed_stage: 'hook', kanon_error: 'hook_missing', reason: 'no_result_file', outcome: 'not-reached' }),
      failed('k3', { lane: 'triage', role: 'implementer', kanon_version: 'dev' })];
    const signals = detect(rows).signals;
    expect(signals.length).toBe(3);
    for (const s of signals) expect(s.signature).toBe(old(s));
  });

  it('gives a finding with a signal\'s five codes that signal\'s signature, whatever else it names', () => {
    const s = detect([failed('k1')]).signals[0]!;
    const finding = { lane: s.lane, failed_stage: s.failed_stage, kanon_error: s.kanon_error ?? undefined, reason: s.reason,
      kanon_version: s.kanon_version, rules: 'K-AGENT-12', kanon_paths: 'scripts/merge-gate.mjs' };
    expect(signature(finding)).toBe(s.signature);
    // A finding that names only a lane is still on the signal's terms: absent is `-`, as for a signal.
    expect(signature({ lane: 'review', kanon_version: '0.36.0', rules: 'K-AGENT-12' }))
      .toBe(signature({ lane: 'review', failed_stage: null, kanon_error: null, reason: null, kanon_version: '0.36.0' }));
  });

  it('appends the sorted rules and paths of a finding that names no lane, stage, error or reason (decision 12)', () => {
    const base = { kanon_version: '0.37.0' };
    const a = signature({ ...base, rules: 'K-MERGE-10,K-SELF-7', kanon_paths: 'scripts/merge-gate.mjs' });
    expect(signature({ ...base, rules: ['K-SELF-7', 'K-MERGE-10'], kanon_paths: ['scripts/merge-gate.mjs'] })).toBe(a);
    const others = [
      signature(base),
      signature({ ...base, rules: 'K-MERGE-10' }),
      signature({ ...base, rules: 'K-MERGE-10,K-SELF-7', kanon_paths: 'scripts/lane-gate.mjs' }),
      signature({ ...base, kanon_paths: 'K-MERGE-10,K-SELF-7' }),
      signature({ kanon_version: '0.36.0', rules: 'K-MERGE-10,K-SELF-7', kanon_paths: 'scripts/merge-gate.mjs' }),
    ];
    expect(new Set([a, ...others]).size).toBe(others.length + 1);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });

  it("is in the issue body's marker, so the job finds the open issue to update", () => {
    const s = detect([failed('k1')]).signals[0]!;
    expect(s.issue.signature).toBe(s.signature);
    expect(s.issue.body).toContain(`<!-- ${MARKER}=${s.signature} -->`);
  });
});

describe('rising after a release (RISE)', () => {
  // `fail` of `n` runs on a version fail, the rest succeed; three adopters share them.
  const runs = (version: string, n: number, fail: number, over: Row = {}) =>
    many(n, (i) => (i < fail ? failed(`k${i % 3}`, { kanon_version: version, ...over }) : row(`k${i % 3}`, { kanon_version: version })));

  it('is ten points over at least twenty runs on each release, as the Owner decided on 2026-10-07', () => {
    expect(RISE).toEqual({ minRuns: 20, points: 0.1 });
  });

  it('reports a rise of exactly the threshold, and not one just under it', () => {
    const r = detect([...runs('0.35.0', 20, 2), ...runs('0.36.0', 20, 4)]).rises;
    expect(r).toEqual([expect.objectContaining({
      kind: 'rise', lane: 'review', kanon_version: '0.36.0', previous_version: '0.35.0',
      runs: 20, failures: 4, rate: 0.2, previous_runs: 20, previous_failures: 2, previous_rate: 0.1, adopters: 3, previous_adopters: 3,
      visibility: 'public',
    })]);
    expect(detect([...runs('0.35.0', 20, 2), ...runs('0.36.0', 21, 4)]).rises).toEqual([]);
  });

  it('needs the minimum sample on both releases', () => {
    expect(detect([...runs('0.35.0', RISE.minRuns - 1, 0), ...runs('0.36.0', 40, 20)]).rises).toEqual([]);
    expect(detect([...runs('0.35.0', 40, 0), ...runs('0.36.0', RISE.minRuns - 1, 10)]).rises).toEqual([]);
  });

  // #569, the Owner's decision of 2026-10-10: the release compared with is the lane's own, the
  // most recent earlier one on which that lane reached `RISE.minRuns` runs.
  it("compares with the lane's last release of the minimum sample, skipping one it barely ran or never ran", () => {
    const other = (v: string) => many(5, (i) => row(`k${i % 3}`, { kanon_version: v, lane: 'triage', role: 'implementer' }));
    const barely = [...runs('0.35.0', 20, 2), ...runs('0.35.1', RISE.minRuns - 1, 0), ...runs('0.36.0', 20, 4)];
    const never = [...runs('0.35.0', 20, 2), ...other('0.35.1'), ...runs('0.36.0', 20, 4)];
    for (const rows of [barely, never]) {
      expect(detect(rows).rises).toEqual([expect.objectContaining({
        lane: 'review', kanon_version: '0.36.0', previous_version: '0.35.0',
        previous_runs: 20, previous_failures: 2, previous_rate: 0.1, previous_adopters: 3,
      })]);
    }
  });

  it('compares with the most recent release that qualifies, not an older one', () => {
    // 0.35.0 already failed as often as 0.36.0; only 0.34.0, two releases back, is ten points under.
    expect(detect([...runs('0.34.0', 20, 0), ...runs('0.35.0', 20, 4), ...runs('0.35.1', 5, 0), ...runs('0.36.0', 20, 4)]).rises)
      .toEqual([expect.objectContaining({ kanon_version: '0.35.0', previous_version: '0.34.0' })]);
  });

  it('is no rise when no earlier release of the lane has the minimum sample', () => {
    expect(detect([...runs('0.34.0', 10, 0), ...runs('0.35.0', RISE.minRuns - 1, 0), ...runs('0.36.0', 40, 20)]).rises).toEqual([]);
  });

  it('takes its visibility from the release it is compared with', () => {
    const two = (v: string, n: number, fail: number) => many(n, (i) => (i < fail ? failed(`k${i % 2}`, { kanon_version: v }) : row(`k${i % 2}`, { kanon_version: v })));
    // 0.35.1 has only two adopters but is skipped for its sample; 0.35.0, compared with, has three.
    expect(detect([...runs('0.35.0', 20, 0), ...two('0.35.1', 4, 0), ...runs('0.36.0', 20, 10)]).rises[0])
      .toMatchObject({ previous_version: '0.35.0', previous_adopters: 3, visibility: 'public' });
    expect(detect([...two('0.35.0', 20, 0), ...runs('0.35.1', 4, 0), ...runs('0.36.0', 20, 10)]).rises[0])
      .toMatchObject({ previous_version: '0.35.0', previous_adopters: 2, visibility: 'private' });
  });

  it('does not count platform failures, so an outage after a release is not a regression', () => {
    expect(detect([...runs('0.35.0', 20, 0), ...runs('0.36.0', 20, 10, { api_error_status: 529 })]).rises).toEqual([]);
  });

  it('is private unless both rates combine three adopters', () => {
    const two = (v: string, n: number, fail: number) => many(n, (i) => (i < fail ? failed(`k${i % 2}`, { kanon_version: v }) : row(`k${i % 2}`, { kanon_version: v })));
    expect(detect([...two('0.35.0', 20, 0), ...runs('0.36.0', 20, 10)]).rises[0]?.visibility).toBe('private');
  });

  it('renders the two rates and the threshold', () => {
    const r = detect([...runs('0.35.0', 20, 2), ...runs('0.36.0', 20, 4)]).rises[0]!;
    expect(r.issue.title).toBe('Kanon bug signal: review lane fails more on 0.36.0 than on 0.35.0');
    expect(r.issue.body).toContain('| `0.35.0` | 20 | 2 | 10.0% | 3 |');
    expect(r.issue.body).toContain('| `0.36.0` | 20 | 4 | 20.0% | 3 |');
    expect(r.issue.body).toContain(`<!-- ${MARKER}=${r.signature} -->`);
  });
});

describe('the issue: counts, codes, versions and the adopter count only', () => {
  // Every identifying string a row might carry: keys, a repository, a login, paths, run ids.
  const KEYS = ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2'];
  const SECRET = ['acme-corp/secret-repo', 'octocat-login', '/home/runner/work/secret-repo', 'src/payments/charge.ts', 'ref-adopter'];
  const rows = (): Row[] => [
    ...KEYS.map((k, i) => failed(k, {
      pk: `${k}#review`, repository: SECRET[0], actor: SECRET[1], path: SECRET[2], file: SECRET[3], name: SECRET[4],
      kanon_error: 'unhandled', api_error_status: 400 + i, run_id: 31_337_000_000 + i,
    })),
    failed(KEYS[0]!, { lane: SECRET[0], failed_stage: SECRET[3] }),
    failed(KEYS[1]!, { failed_stage: 'hook', kanon_error: SECRET[2] as string }),
    failed(KEYS[2]!, { reason: SECRET[1] }),
  ];

  it('holds none of them, in the JSON or in any title or body', () => {
    const r = detect(rows());
    // The signatures are hashes, whose hex digits could spell a number by chance: left out.
    const text = JSON.stringify(r).replace(/[0-9a-f]{24}/g, '');
    for (const s of [...KEYS, ...SECRET, '31337000000', '31337000001', '4242', '4343', '98765432']) expect(text, s).not.toContain(s);
    expect(r.signals[0]).toMatchObject({ visibility: 'public', adopters: 3, kanon_error: 'unhandled' });
    const issue = r.signals[0]!.issue;
    expect(issue.title).toBe('Kanon bug signal: review lane, `unhandled` at stage `agent`, on 0.36.0');
    for (const line of [
      '| Lane | `review` |', '| Failed stage | `agent` |', '| Kanon error | `unhandled` |', '| Reason | `did_not_finish` |',
      '| Kanon version | `0.36.0` |', '| Runs | 3 |', '| Adopters affected | 3 |', '| API error status | 400 × 1, 401 × 1, 402 × 1 |',
      '| First seen | 2026-10-05 |', '**Classification: `kanon`.**',
    ]) expect(issue.body).toContain(line);
  });

  it('holds no time finer than the day', () => {
    const body = detect(rows()).signals[0]!.issue.body;
    expect(body).not.toMatch(/T\d{2}:\d{2}/);
  });

  it('refuses output that holds an adopter key as a value, however it got there', () => {
    // A key that happens to be a lane's name: the output would name it, so nothing is returned.
    expect(() => detect([failed('review'), failed('k2')])).toThrow(/adopter key/);
  });

  it('renders a signal from its fields alone', () => {
    const s = detect([failed('k1', { failed_stage: undefined, outcome: 'exhausted', reason: 'turn_cap' })]).signals[0]!;
    const { issue, ...rest } = s;
    expect(renderIssue(rest)).toEqual(issue);
    expect(issue.title).toBe('Kanon bug signal: review lane, `turn_cap`, on 0.36.0');
    expect(issue.body).toContain('| Failed stage | none |');
    expect(issue.body).toContain('| API error status | none |');
  });
});

describe('the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-bugs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };

  it('reads a JSON array or JSON lines, and prints the signals as JSON', () => {
    const rs = [failed('k1'), failed('k2')];
    for (const p of [file('rows.json', JSON.stringify(rs)), file('rows.jsonl', `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`)]) {
      const r = main(['--rows', p, '--json']);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.out);
      expect(Object.keys(out)).toEqual(['signals', 'rises', 'skipped']);
      expect(out.signals[0]).toMatchObject({ classification: 'kanon', new: true, visibility: 'private' });
      expect(out.signals[0].issue.body).toContain(MARKER);
    }
    expect(parseRows('  ')).toEqual([]);
  });

  it('marks known signatures, and prints a summary of counts without --json', () => {
    const rows = file('r.json', JSON.stringify([failed('k1'), failed('k1', { failed_stage: 'hook' })]));
    const sig = detect([failed('k1')]).signals[0]!.signature;
    const r = main(['--rows', rows, '--known', file('known.json', JSON.stringify([sig]))]);
    expect(r).toEqual({ code: 0, out: '2 signal(s): 0 kanon, 2 adopter, 0 platform; 1 new, 0 public. 0 rise(s) after a release.' });
    expect(main(['--rows', file('t.json', JSON.stringify([failed('k1', { tag: 'test' })])), '--tag', 'test']).out).toMatch(/^1 signal/);
    expect(main(['--rows', file('s.json', JSON.stringify([failed('k1', { tag: 'smoke' })]))]).out).toContain('Rows skipped: 1 not run.');
  });

  it('refuses bad arguments and unreadable input, without echoing the input', () => {
    expect(main([]).code).toBe(2);
    expect(main(['--rows']).code).toBe(2);
    expect(main(['--rows', 'x', '--wat']).code).toBe(2);
    expect(main(['--rows', 'x', '--tag', 'prod']).code).toBe(2);
    expect(main(['--rows', join(dir, 'missing.json')])).toEqual({ code: 2, out: 'could not read the input (Error)' });
    const bad = main(['--rows', file('bad.json', '{"repository":"acme-corp/secret-repo"')]);
    expect(bad).toEqual({ code: 2, out: 'could not read the input (SyntaxError)' });
    expect(main(['--rows', file('obj.json', '[1]'), '--known', file('k.json', '{"a":1}')]).code).toBe(2);
    // A key that is also a lane's name would reach the output: refused, not thrown, and not printed.
    expect(main(['--rows', file('key.json', JSON.stringify([failed('review')])), '--json']))
      .toEqual({ code: 2, out: 'refused: the signals would hold an adopter key, so nothing is printed' });
  });
});
