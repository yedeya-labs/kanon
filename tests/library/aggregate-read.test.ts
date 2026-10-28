import { describe, expect, it } from 'vitest';
import { AggregateError, MIN_ADOPTERS, aggregateStore, checkAggregate, isEmpty, readAggregateToken, summaryLine, tokenRefusal } from '../../scripts/aggregate-read.mjs';
import { HOSTED_AGGREGATE_URL } from '../../scripts/lib/telemetry-token.mjs';
import { HOSTED_URL, RUNNER_ENV, SELF_AUDIENCE, SELF_URL, TOKEN, tokenNet } from '../unit/helpers/token-net.js';

/**
 * Plan 0004 step 14, plan 0002 §6.1: the telemetry Explorer's read of the aggregate. One `GET`
 * on the token URL with a fresh OIDC token (plan 0008 J5; the signed one went in J9), and an answer that holds exactly what the function
 * may publish, checked field by field before the agent sees it. Anything else refuses the read
 * whole, so the agent doesn't run.
 */

const cell = (lane = 'review', model = 'claude-opus-5-5', runs = 47) => ({ lane, model, runs, median_cost_usd: 0.4213, p90_cost_usd: 1.0987 });
const signal = (extra: Record<string, unknown> = {}) => ({ lane: 'review', reason: 'did_not_finish', failed_stage: 'agent', kanon_error: null, kanon_version: '0.32.0', adopters_affected: 1, ...extra });
const answer = (extra: Record<string, unknown> = {}) => ({
  computed_at: '2026-10-07T12:00:00.000Z', min_adopters: 3, signal_days: 7,
  cross_adopter: [], own: [{ label: 'kanon', cells: [cell()] }], signals: [signal()], ...extra,
});

describe('checkAggregate: exactly what the function may publish', () => {
  it('passes the function\'s answer through, rebuilt from the checked fields', () => {
    expect(checkAggregate(answer())).toEqual(answer());
  });

  it('refuses a key the aggregate never answers, at every level (the mutation: an extra field reaches nothing)', () => {
    expect(() => checkAggregate(answer({ notes: { withheld_cells: 2 } }))).toThrow(/the answer holds `notes`/);
    expect(() => checkAggregate(answer({ cross_adopter: [{ ...cell(), adopters: 2 }] }))).toThrow(/cross_adopter\[0\] holds `adopters`/);
    expect(() => checkAggregate(answer({ own: [{ label: 'kanon', key: 'deadbeef', cells: [] }] }))).toThrow(/own\[0\] holds `key`/);
    expect(() => checkAggregate(answer({ signals: [{ ...signal(), runs: 4 }] }))).toThrow(/signals\[0\] holds `runs`/);
    expect(() => checkAggregate(answer({ signals: [{ ...signal(), total_cost_usd: 1 }] }))).toThrow(/signals\[0\] holds `total_cost_usd`/);
  });

  it('refuses a threshold under three, so a cell of fewer adopters never reaches the run (plan 0004 step 14\'s mutation)', () => {
    expect(MIN_ADOPTERS).toBe(3);
    expect(() => checkAggregate(answer({ min_adopters: 2 }))).toThrow(/`min_adopters` is below 3/);
    expect(() => checkAggregate(answer({ min_adopters: 3 }))).not.toThrow();
  });

  it('refuses a missing field, a wrong type, prose where a code goes, and a repeated label', () => {
    const noSignals: Record<string, unknown> = answer();
    delete noSignals.signals;
    expect(() => checkAggregate(noSignals)).toThrow(/lacks `signals`/);
    expect(() => checkAggregate(answer({ cross_adopter: [{ ...cell(), runs: 1.5 }] }))).toThrow(/runs is not a count/);
    expect(() => checkAggregate(answer({ cross_adopter: [{ ...cell(), median_cost_usd: '0.4' }] }))).toThrow(/median_cost_usd is not a figure/);
    expect(() => checkAggregate(answer({ signals: [signal({ lane: 'a lane with words' })] }))).toThrow(/signals\[0\]\.lane is not a code/);
    expect(() => checkAggregate(answer({ signals: [signal({ kanon_version: 'v1' })] }))).toThrow(/kanon_version is not a code/);
    expect(() => checkAggregate(answer({ own: [{ label: 'kanon', cells: [] }, { label: 'kanon', cells: [] }] }))).toThrow(/repeats/);
    expect(() => checkAggregate(answer({ computed_at: 'yesterday' }))).toThrow(/computed_at/);
    expect(() => checkAggregate([])).toThrow(/not an object/);
  });

  it('never puts a value in its message', () => {
    try {
      checkAggregate(answer({ own: [{ label: 'kanon', key: 'deadbeef', cells: [] }] }));
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('deadbeef');
    }
  });

  it('is empty only with no cell and no signal', () => {
    expect(isEmpty(checkAggregate(answer()))).toBe(false);
    expect(isEmpty(checkAggregate(answer({ own: [{ label: 'kanon', cells: [] }], signals: [] })))).toBe(true);
    expect(isEmpty(checkAggregate(answer({ own: [], signals: [], cross_adopter: [cell()] })))).toBe(false);
  });

  it('summarises in counts, never a figure of a cell', () => {
    const line = summaryLine(checkAggregate(answer()));
    expect(line).toContain('0 cross-adopter cell(s) (at least 3 adopters each), 1 own cell(s) of 1 declaring adopter(s), 1 failure signal(s) over 7 days');
    expect(line).not.toMatch(/0\.4213|1\.0987|47/);
  });
});


// ── The token way (plan 0008 §3.6, step J5) ───────────────────────────────────────────────────────
describe('readAggregateToken: one GET on the token URL, with a fresh OIDC token', () => {
  const SELF_ENV = { ...RUNNER_ENV, KANON_AGGREGATE_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE };

  it('asks the runner for the store\'s audience, sends the token as a bearer to the hosted URL, and checks the answer', async () => {
    const net = tokenNet(() => ({ status: 200, json: answer() }));
    const masked: string[] = [];
    const a = await readAggregateToken({ env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: (x) => masked.push(x), hostedUrl: HOSTED_URL });
    expect(a).toEqual(answer());
    expect(net.calls).toEqual([expect.objectContaining({ url: HOSTED_URL, method: 'GET', query: {}, auth: `Bearer ${TOKEN}1` })]);
    // The token is masked before it is sent, and the hosted URL, public, is not.
    expect(masked).toEqual([`${TOKEN}1`]);
  });

  it('reads a self-hosted store only with its URL and audience together, masking the URL first', async () => {
    const net = tokenNet(() => ({ status: 200, json: answer() }));
    const masked: string[] = [];
    await readAggregateToken({ env: SELF_ENV, fetchImpl: net.fetchImpl, mask: (x) => masked.push(x), hostedUrl: HOSTED_URL });
    expect(net.calls.map((c) => c.url)).toEqual([SELF_URL]);
    expect(masked).toEqual([SELF_URL, `${TOKEN}1`]);
    for (const env of [{ KANON_AGGREGATE_TOKEN_URL: SELF_URL }, { KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }]) {
      const none = tokenNet(() => ({ status: 200, json: answer() }));
      await expect(readAggregateToken({ env: { ...RUNNER_ENV, ...env }, fetchImpl: none.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL }))
        .rejects.toThrow(/name a self-hosted store together/);
      // Refused before any token is minted.
      expect(none.minted).toEqual([]);
    }
    // The hosted audience never goes to another URL (§2.1).
    await expect(readAggregateToken({ env: { ...SELF_ENV, KANON_TELEMETRY_AUDIENCE: 'kanon-telemetry' }, fetchImpl: tokenNet(() => ({ status: 200 })).fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL }))
      .rejects.toThrow(/only ever sent to the hosted store's URL/);
  });

  it('says the hosted URL is not published, before minting, while the constant is empty', async () => {
    const net = tokenNet(() => ({ status: 200, json: answer() }));
    await expect(readAggregateToken({ env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {}, hostedUrl: '' })).rejects.toThrow(/not published/);
    expect(net.minted).toEqual([]);
    expect(aggregateStore({}, '')).toMatchObject({ ok: false, unpublished: true });
    if (!HOSTED_AGGREGATE_URL) expect(aggregateStore({})).toMatchObject({ ok: false, unpublished: true });
    else expect(aggregateStore({})).toEqual({ ok: true, url: HOSTED_AGGREGATE_URL, audience: 'kanon-telemetry', hosted: true });
  });

  it('asks for the page view by name when told to', async () => {
    const net = tokenNet(() => ({ status: 403, json: { error: 'workflow' } }));
    await expect(readAggregateToken({ env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL, view: 'page' })).rejects.toThrow(AggregateError);
    expect(net.calls[0]!.query).toEqual({ view: 'page' });
  });

  it('asks again after the store\'s 503 jwks-unavailable, a bounded number of times, then names it (#1440)', async () => {
    let refused = 1;
    const net = tokenNet(() => (refused-- > 0 ? { status: 503, json: { error: 'jwks-unavailable' } } : { status: 200, json: answer() }));
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    expect(await readAggregateToken({ env: SELF_ENV, fetchImpl: net.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL, sleep })).toMatchObject({ min_adopters: 3 });
    expect(net.calls).toHaveLength(2);
    expect(slept).toEqual([6_000]);
    const down = tokenNet(() => ({ status: 503, json: { error: 'jwks-unavailable' } }));
    await expect(readAggregateToken({ env: SELF_ENV, fetchImpl: down.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL, sleep }))
      .rejects.toThrow(/answered 503 \(jwks-unavailable\): the store could not fetch GitHub's signing keys/);
    expect(down.calls).toHaveLength(3);
  });

  it('names each refusal by the store\'s code, never with the URL or the token, and refuses an answer that fails the check', async () => {
    const cases: Array<[number, unknown, RegExp]> = [
      [403, { error: 'invoker' }, /answered 403 \(invoker\): this repository's registration doesn't set `aggregate_invoker`/],
      [404, { error: 'not-registered' }, /answered 404 \(not-registered\): this repository is not registered/],
      [403, { error: 'suspended' }, /\(suspended\): Kanon's operator has suspended/],
      [410, { error: 'erased' }, /\(erased\): this repository's telemetry was erased/],
      [403, { error: 'ref' }, /default branch only/],
      [429, { error: 'quota' }, /quota is spent/],
      [401, { error: 'aud' }, /answered 401 \(aud\)$/],
      [502, { error: 'Some Value With Words' }, /answered 502$/],
    ];
    for (const [status, json, want] of cases) {
      const net = tokenNet(() => ({ status, json }));
      const e = await readAggregateToken({ env: SELF_ENV, fetchImpl: net.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL }).catch((x: Error) => x);
      expect(e, String(status)).toBeInstanceOf(AggregateError);
      expect((e as Error).message).toMatch(want);
      expect((e as Error).message).not.toContain('abc123def');
      expect((e as Error).message).not.toContain(TOKEN);
    }
    expect(tokenRefusal(500, null)).toBe('the aggregate function answered 500');
    await expect(readAggregateToken({ env: SELF_ENV, fetchImpl: tokenNet(() => ({ status: 200, text: '<html>' })).fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL })).rejects.toThrow(/not JSON/);
    await expect(readAggregateToken({ env: SELF_ENV, fetchImpl: tokenNet(() => ({ status: 200, json: answer({ min_adopters: 2 }) })).fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL })).rejects.toThrow(/below 3/);
    // No token from the runner: the job lacks `id-token: write`.
    await expect(readAggregateToken({ env: { KANON_AGGREGATE_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }, fetchImpl: tokenNet(() => ({ status: 200 })).fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL }))
      .rejects.toThrow(/holds no OIDC token/);
  });
});
