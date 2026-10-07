import { describe, expect, it } from 'vitest';
import { AggregateError, MIN_ADOPTERS, checkAggregate, isEmpty, readAggregate, regionOfAggregateUrl, summaryLine } from '../../scripts/aggregate-read.mjs';
import { masksOf } from '../../scripts/aggregate-mask.mjs';

/**
 * Plan 0004 step 14, plan 0002 §6.1: the telemetry Explorer's read of the aggregate. One signed
 * `GET` with the invoker role's credentials, and an answer that holds exactly what the function
 * may publish, checked field by field before the agent sees it. Anything else refuses the read
 * whole, so the agent doesn't run.
 */

const URL_OK = 'https://abc123def.lambda-url.eu-central-1.on.aws/';
const cell = (lane = 'review', model = 'claude-opus-5-5', runs = 47) => ({ lane, model, runs, median_cost_usd: 0.4213, p90_cost_usd: 1.0987 });
const signal = (extra: Record<string, unknown> = {}) => ({ lane: 'review', reason: 'did_not_finish', failed_stage: 'agent', kanon_error: null, kanon_version: '0.32.0', adopters_affected: 1, ...extra });
const answer = (extra: Record<string, unknown> = {}) => ({
  computed_at: '2026-10-07T12:00:00.000Z', min_adopters: 3, signal_days: 7,
  cross_adopter: [], own: [{ label: 'kanon', cells: [cell()] }], signals: [signal()], ...extra,
});
const ENV = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'session' };
const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

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

describe('regionOfAggregateUrl', () => {
  it('reads the region of a function URL, and nothing else', () => {
    expect(regionOfAggregateUrl(URL_OK)).toBe('eu-central-1');
    expect(regionOfAggregateUrl('https://abc.lambda-url.eu-central-1.on.aws')).toBe('eu-central-1');
    for (const bad of ['http://abc.lambda-url.eu-central-1.on.aws/', 'https://abc.lambda-url.eu-central-1.on.aws/x', 'https://abc.lambda-url.eu-central-1.on.aws/?a=1',
      'https://evil.example/', 'https://abc.lambda-url.eu-central-1.on.aws.evil.example/', '', 'not a url']) {
      expect(regionOfAggregateUrl(bad), bad).toBeNull();
    }
  });
});

describe('readAggregate: one signed GET', () => {
  it('signs a GET for Lambda in the URL\'s region, with the session token, and checks the answer', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(answer()), { status: 200 });
    }) as unknown as typeof fetch;
    const a = await readAggregate({ url: URL_OK, env: ENV, fetchImpl, now: new Date('2026-10-07T12:00:00Z') });
    expect(a.own[0]!.label).toBe('kanon');
    expect(seen!.url).toBe(URL_OK);
    expect(seen!.init.method).toBe('GET');
    const h = seen!.init.headers as Record<string, string>;
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261007\/eu-central-1\/lambda\/aws4_request, /);
    expect(h['x-amz-security-token']).toBe('session');
    expect(seen!.init.body).toBeUndefined();
  });

  it('fails by name, without the URL, on a refusal, a non-200, a body that is not JSON, or an answer that fails the check', async () => {
    await expect(readAggregate({ url: URL_OK, env: ENV, fetchImpl: respond(403, '{"Message":"Forbidden"}') })).rejects.toThrow(/answered 403: the invoker role was refused/);
    await expect(readAggregate({ url: URL_OK, env: ENV, fetchImpl: respond(502, '{"error":"aggregate"}') })).rejects.toThrow(/answered 502$/);
    await expect(readAggregate({ url: URL_OK, env: ENV, fetchImpl: respond(200, '<html>') })).rejects.toThrow(/not JSON/);
    await expect(readAggregate({ url: URL_OK, env: ENV, fetchImpl: respond(200, JSON.stringify(answer({ min_adopters: 1 }))) })).rejects.toThrow(AggregateError);
    const unreachable = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(readAggregate({ url: URL_OK, env: ENV, fetchImpl: unreachable })).rejects.toThrow(/could not be reached \(TypeError\)/);
    for (const p of [readAggregate({ url: URL_OK, env: ENV, fetchImpl: respond(500, '') })]) await p.catch((e) => expect(String(e.message)).not.toContain('abc123def'));
  });

  it('refuses a URL that is not a function URL, and a run without credentials, before calling anything', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    await expect(readAggregate({ url: 'https://example.com/', env: ENV, fetchImpl })).rejects.toThrow(/KANON_AGGREGATE_URL is not a Lambda function URL/);
    await expect(readAggregate({ url: URL_OK, env: {}, fetchImpl })).rejects.toThrow(/no AWS credentials/);
    expect(called).toBe(false);
  });
});

describe('masksOf (kanon#433): the two variables and the account id inside the role', () => {
  // Built, never written: the public-tree test refuses twelve digits in a row in a tracked file.
  const ACCOUNT = String(10 ** 11 + 23);
  const ROLE = `arn:aws:iam::${ACCOUNT}:role/kanon-telemetry-k-aggregates`;
  it('masks the URL, the role and the account id', () => {
    expect(masksOf({ URL: ` ${URL_OK} `, ROLE })).toEqual([URL_OK, ROLE, ACCOUNT]);
  });
  it('masks nothing empty, and no account id it cannot read', () => {
    expect(masksOf({ URL: '', ROLE: '' })).toEqual([]);
    expect(masksOf({ ROLE: 'not-an-arn' })).toEqual(['not-an-arn']);
  });
});
