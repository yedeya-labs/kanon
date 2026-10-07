import { describe, expect, it } from 'vitest';

import {
  aggregate, assertNoKey, callerAllowed, configOf, handle, keyOf, median, MIN_ADOPTERS, percentile, PROJECTION,
  publicView, queryRequest, readAll, SIGNAL_DAYS,
} from '../../infra/telemetry/function/aggregate.mjs';
import { cliQuery, fromRegister, TABLE } from '../../infra/telemetry/aggregate.mjs';
import { LANES } from '../../actions/agent-telemetry/schema.mjs';

/**
 * Plan 0002 §6 and §6.1 (decided by the Owner, 2026-10-07, #443): the aggregate. Cross-adopter
 * cells only at three distinct adopters or more; an adopter's own figures only when it declared
 * them publishable, under its label; failure signals with a count of adopters and no figures.
 * The rows are fixtures in the stored shape, keyed by made-up adopter keys; nothing touches AWS.
 */

const NOW = Date.parse('2026-10-07T12:00:00Z');
const LIVE = Math.floor(NOW / 1000) + 86_400;
const RECENT = '2026-10-06T12:00:00Z';
const MODEL = 'claude-opus-5-5';

type Row = {
  pk: string, row_kind?: string, tag?: string, recorded_at?: string, lane?: string, model?: string, total_cost_usd?: number,
  expires_at?: number, outcome?: string, reason?: string, failed_stage?: string, kanon_error?: string, kanon_version?: string,
};
const row = (key: string, cost: number | undefined, over: Partial<Row> = {}): Row => ({
  pk: `${key}#${over.lane ?? 'review'}`, row_kind: 'run', tag: 'run', recorded_at: RECENT, lane: 'review', model: MODEL,
  ...(cost === undefined ? {} : { total_cost_usd: cost }), expires_at: LIVE, outcome: 'ok', reason: 'none', kanon_version: '0.32.0', ...over,
});
const run = (rows: Row[], own: Record<string, string> = {}) => aggregate(rows, { now: NOW, own });
const three = (over: Partial<Row> = {}) => [row('alpha', 1, over), row('beta', 2, over), row('gamma', 3, over)];

describe('the three-adopter rule for cells that combine adopters (decision 7)', () => {
  it('is three', () => {
    expect(MIN_ADOPTERS).toBe(3);
  });

  it('withholds a cell two adopters contribute to, however many rows they send', () => {
    const out = run([...Array.from({ length: 20 }, (_, i) => row('alpha', i)), row('beta', 1)]);
    expect(out.cross_adopter).toEqual([]);
    expect(out.notes.withheld_cells).toBe(1);
  });

  it('emits a cell exactly three adopters contribute to', () => {
    const out = run(three());
    expect(out.cross_adopter).toEqual([{ lane: 'review', model: MODEL, runs: 3, median_cost_usd: 2, p90_cost_usd: 3 }]);
    expect(out.notes.withheld_cells).toBe(0);
  });

  it('counts adopters by key, not by partition or row', () => {
    const rows = [row('alpha', 1), row('alpha', 1, { lane: 'implement' }), row('beta', 2), row('beta', 2, { lane: 'implement' }), row('gamma', 3)];
    expect(run(rows).cross_adopter.map((c) => c.lane)).toEqual(['review']);
  });

  it('counts adopters per model: three adopters in a lane, split over two models, publish neither', () => {
    const out = run([row('alpha', 1), row('beta', 2), row('gamma', 3, { model: 'claude-sonnet-5' })]);
    expect(out.cross_adopter).toEqual([]);
    expect(out.notes.withheld_cells).toBe(2);
  });

  it('does not let a row with no model or no cost count its adopter toward a cell', () => {
    const out = run([row('alpha', 1), row('beta', 2), row('gamma', undefined), row('gamma', 3, { model: undefined })]);
    expect(out.cross_adopter).toEqual([]);
    expect(out.notes.excluded).toEqual({ no_model: 1, no_cost: 1 });
    expect(out.notes.withheld_cells).toBe(1);
  });
});

describe("an adopter's own figures (§6.1, item 2)", () => {
  it('are not published for an adopter that did not declare them, alone or in a mixed cell', () => {
    expect(run([row('alpha', 1), row('alpha', 2)]).own).toEqual([]);
    expect(run([row('alpha', 1), row('beta', 2)]).own).toEqual([]);
  });

  it('are published, under its label, for an adopter that declared them, even alone', () => {
    const out = run([row('alpha', 1), row('alpha', 3), row('alpha', 8, { lane: 'implement' })], { alpha: 'kanon' });
    expect(out.own).toEqual([{ label: 'kanon', cells: [
      { lane: 'implement', model: MODEL, runs: 1, median_cost_usd: 8, p90_cost_usd: 8 },
      { lane: 'review', model: MODEL, runs: 2, median_cost_usd: 2, p90_cost_usd: 3 },
    ] }]);
    expect(out.cross_adopter).toEqual([]);
  });

  it("are that adopter's rows only: a mixed cell under three stays withheld, and lends no other adopter's cost", () => {
    const out = run([row('alpha', 1), row('beta', 100), row('beta', 200)], { alpha: 'kanon' });
    expect(out.cross_adopter).toEqual([]);
    expect(out.notes.withheld_cells).toBe(1);
    expect(out.own).toEqual([{ label: 'kanon', cells: [{ lane: 'review', model: MODEL, runs: 1, median_cost_usd: 1, p90_cost_usd: 1 }] }]);
  });

  it("never let a cross-adopter cell and own figures overlap: subtracting own can't recover two adopters' figure (#449)", () => {
    // The reviewer's example: alpha declares; alpha, beta and gamma share the cell.
    const rows = [row('alpha', 1), row('alpha', 1), row('beta', 10), row('gamma', 3), row('gamma', 3), row('gamma', 3), row('gamma', 3)];
    const out = run(rows, { alpha: 'kanon' });
    expect(out.cross_adopter).toEqual([]);
    expect(out.notes.withheld_cells).toBe(1);
    expect(out.own).toEqual([{ label: 'kanon', cells: [{ lane: 'review', model: MODEL, runs: 2, median_cost_usd: 1, p90_cost_usd: 1 }] }]);
  });

  it('count only adopters that did not declare toward a cross-adopter cell, and their rows only', () => {
    // alpha and beta declare; gamma, delta and epsilon don't.
    const own = { alpha: 'one', beta: 'two' };
    const four = [row('alpha', 100), row('beta', 100), row('gamma', 1), row('delta', 2)];
    expect(run(four, own).cross_adopter).toEqual([]);
    expect(run(four, own).notes.withheld_cells).toBe(1);
    const five = [...four, row('epsilon', 3)];
    expect(run(five, own).cross_adopter).toEqual([{ lane: 'review', model: MODEL, runs: 3, median_cost_usd: 2, p90_cost_usd: 3 }]);
    expect(run(five, own).own.map((o) => [o.label, o.cells[0]!.runs])).toEqual([['one', 1], ['two', 1]]);
  });

  it('withhold nothing when only declaring adopters contribute: their figures are all in own', () => {
    expect(run([row('alpha', 1)], { alpha: 'kanon' }).notes.withheld_cells).toBe(0);
  });

  it('keep two declaring adopters apart, each under its own label', () => {
    const out = run([row('alpha', 1), row('beta', 5)], { alpha: 'one', beta: 'two' });
    expect(out.own.map((o) => [o.label, o.cells[0]!.median_cost_usd])).toEqual([['one', 1], ['two', 5]]);
    expect(out.cross_adopter).toEqual([]);
  });

  it('never carry the key: a label that is a key is refused', () => {
    expect(() => run([row('alpha', 1), row('beta', 2)], { alpha: 'beta' })).toThrow(/adopter key/);
  });
});

describe('the failure signals (§6.1, item 3)', () => {
  const failed = { outcome: 'failed', reason: 'did_not_finish', failed_stage: 'agent', kanon_error: 'token_failed' };

  it('name the lane, reason, stage, Kanon error and version, and how many adopters, and nothing else', () => {
    const out = run([row('alpha', 9, failed), row('alpha', 9, failed), row('beta', 4, failed), row('gamma', 1)]);
    expect(out.signals).toEqual([{ lane: 'review', reason: 'did_not_finish', failed_stage: 'agent', kanon_error: 'token_failed', kanon_version: '0.32.0', adopters_affected: 2 }]);
  });

  it('come from one adopter too, with no cost or run count', () => {
    const out = run([row('alpha', 9, failed)]);
    expect(out.signals).toEqual([expect.objectContaining({ adopters_affected: 1 })]);
    expect(JSON.stringify(out.signals)).not.toMatch(/cost|runs|"9"/);
  });

  it('read no ok run, and an absent field is null', () => {
    const out = run([row('alpha', 1), row('beta', undefined, { outcome: 'not-reached', reason: 'no_result_file', kanon_version: undefined })]);
    expect(out.signals).toEqual([{ lane: 'review', reason: 'no_result_file', failed_stage: null, kanon_error: null, kanon_version: null, adopters_affected: 1 }]);
  });

  it(`look back ${SIGNAL_DAYS} days by recorded_at, and no further`, () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const edge = NOW - SIGNAL_DAYS * 86_400_000;
    expect(run([row('alpha', 1, { ...failed, recorded_at: at(edge) })]).signals).toHaveLength(1);
    expect(run([row('alpha', 1, { ...failed, recorded_at: at(edge - 1000) })]).signals).toEqual([]);
    expect(run([row('alpha', 1, { ...failed, recorded_at: undefined })]).signals).toEqual([]);
  });

  it('split by version, so a bad release stands apart', () => {
    const out = run([row('alpha', 1, failed), row('beta', 1, { ...failed, kanon_version: '0.33.0' })]);
    expect(out.signals.map((s) => [s.kanon_version, s.adopters_affected])).toEqual([['0.32.0', 1], ['0.33.0', 1]]);
  });
});

describe('which rows are read', () => {
  it('run rows tagged `run` only', () => {
    expect(run(three({ tag: 'smoke' })).cross_adopter).toEqual([]);
    expect(run(three({ tag: 'test' })).cross_adopter).toEqual([]);
    expect(run(three({ row_kind: 'work_item' })).cross_adopter).toEqual([]);
    expect(run(three({ tag: 'test', outcome: 'failed' })).signals).toEqual([]);
    expect(run(three()).cross_adopter).toHaveLength(1);
  });

  it('not a row past its expiry, nor one expiring exactly now (§10)', () => {
    expect(run(three({ expires_at: Math.floor(NOW / 1000) })).cross_adopter).toEqual([]);
    expect(run(three({ expires_at: Math.floor(NOW / 1000) + 1 })).cross_adopter).toHaveLength(1);
  });

  it('not a lane outside the schema enum, nor a pk with no key', () => {
    expect(run(three({ lane: 'not-a-lane' })).cross_adopter).toEqual([]);
    expect(run([row('alpha', 1), row('beta', 2), { ...row('gamma', 3), pk: 'review' }]).cross_adopter).toEqual([]);
  });

  it('a zero-cost run, in its cell', () => {
    expect(run(three().map((r) => ({ ...r, total_cost_usd: 0 }))).cross_adopter[0]).toMatchObject({ runs: 3, median_cost_usd: 0, p90_cost_usd: 0 });
  });
});

describe('the median and the 90th percentile', () => {
  const sorted = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('takes the middle value of an odd count, and the mean of the two middles of an even one', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([5])).toBe(5);
  });

  it('takes the nearest rank, always a value some run cost', () => {
    expect(percentile(sorted(3), 90)).toBe(3);
    expect(percentile(sorted(9), 90)).toBe(9);
    expect(percentile(sorted(10), 90)).toBe(9);
    expect(percentile(sorted(11), 90)).toBe(10);
    expect(percentile(sorted(20), 90)).toBe(18);
    expect(percentile(sorted(1), 90)).toBe(1);
    expect(percentile([2, 2, 2, 7], 90)).toBe(7);
  });

  it('sorts costs as numbers before taking either, whatever order the rows come in', () => {
    const costs = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    const out = run(costs.map((c, i) => row(['alpha', 'beta', 'gamma'][i % 3]!, c)));
    expect(out.cross_adopter[0]).toMatchObject({ runs: 10, median_cost_usd: 5.5, p90_cost_usd: 9 });
  });

  it('rounds to a hundredth of a cent', () => {
    const out = run([row('alpha', 0.1), row('beta', 0.2), row('gamma', 0.30004999)]);
    expect(out.cross_adopter[0]).toMatchObject({ median_cost_usd: 0.2, p90_cost_usd: 0.3 });
  });

  it('orders cells by lane, then model', () => {
    const keys = ['alpha', 'beta', 'gamma'];
    const rows = [
      ...keys.map((k) => row(k, 1, { lane: 'review', model: 'm-b' })),
      ...keys.map((k) => row(k, 1, { lane: 'review', model: 'm-a' })),
      ...keys.map((k) => row(k, 1, { lane: 'implement', model: 'm-z' })),
    ];
    expect(run(rows).cross_adopter.map((c) => `${c.lane}/${c.model}`)).toEqual(['implement/m-z', 'review/m-a', 'review/m-b']);
  });
});

describe('the output never names an adopter', () => {
  it('holds no key anywhere', () => {
    const keys = ['alpha', 'beta', 'gamma', 'delta'];
    const out = run([...keys.map((k, i) => row(k, i + 1, { outcome: 'failed', reason: 'did_not_finish' })), row('delta', 1, { model: 'claude-sonnet-5' })], { delta: 'kanon' });
    const text = JSON.stringify(out);
    for (const k of keys) expect(text).not.toContain(k);
    expect(Object.keys(out.cross_adopter[0]!).sort()).toEqual(['lane', 'median_cost_usd', 'model', 'p90_cost_usd', 'runs']);
  });

  it('refuses output in which a value is an adopter key', () => {
    expect(() => run(three({ model: 'beta' }))).toThrow(/adopter key/);
    expect(() => run([row('alpha', 1, { outcome: 'failed', kanon_version: 'alpha' })])).toThrow(/adopter key/);
    expect(() => assertNoKey({ a: [{ b: 'gamma' }] }, new Set(['gamma']))).toThrow(/adopter key/);
    expect(() => assertNoKey({ a: [{ b: 'gammas' }] }, new Set(['gamma']))).not.toThrow();
  });

  it('keeps the notes, which span every adopter, out of what may leave', () => {
    expect(Object.keys(publicView(run(three())))).toEqual(['cross_adopter', 'own', 'signals']);
  });

  it('reads the key from the pk up to its first `#`', () => {
    expect(keyOf('alpha#review')).toBe('alpha');
    expect(keyOf('review')).toBe('');
    expect(keyOf(undefined)).toBe('');
  });
});

type Item = Record<string, { S?: string, N?: string }>;
const attrs = (r: Row): Item => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'number' ? { N: String(v) } : { S: String(v) }]));

/** A fake table answering Query pages, as DynamoDB does, honouring the filter on `tag`. */
function fakeQuery(items: Row[], { pageSize = 2, failOn }: { pageSize?: number, failOn?: string } = {}) {
  const requests: Record<string, J>[] = [];
  const query = async (req: Record<string, J>) => {
    requests.push(req);
    const pk = req.ExpressionAttributeValues[':p'].S as string;
    if (pk === failOn) throw new Error(`Query 400 on ${pk}`);
    const all = items.filter((i) => i.pk === pk && i.tag === req.ExpressionAttributeValues[':run'].S);
    const from = req.ExclusiveStartKey ? Number(req.ExclusiveStartKey.i.N) : 0;
    const page = all.slice(from, from + pageSize);
    return { Items: page.map(attrs), ...(from + pageSize < all.length ? { LastEvaluatedKey: { i: { N: String(from + pageSize) } } } : {}) };
  };
  return { query, requests };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

describe('the reader', () => {
  it('walks every key and every lane, following pages', async () => {
    const { query, requests } = fakeQuery([row('alpha', 1), row('alpha', 2), row('alpha', 3), row('beta', 4, { lane: 'implement' })]);
    const rows = await readAll(['alpha', 'beta'], query, TABLE);
    expect(rows.map((r) => r.total_cost_usd).sort()).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ pk: 'alpha#review', tag: 'run', model: MODEL, expires_at: LIVE, outcome: 'ok' });
    expect(requests).toHaveLength(2 * LANES.length + 1);
  });

  it('asks for tag = run rows, exactly the projection, with Select named for the role\'s condition', () => {
    const req = queryRequest(TABLE, 'alpha#review');
    expect(req.FilterExpression).toBe('#tag = :run');
    expect(req.Select).toBe('SPECIFIC_ATTRIBUTES');
    expect(req.ProjectionExpression.split(', ').map((n) => req.ExpressionAttributeNames[n as keyof typeof req.ExpressionAttributeNames]).sort()).toEqual([...PROJECTION].sort());
    expect(Object.values(req.ExpressionAttributeNames).sort()).toEqual([...PROJECTION].sort());
  });

  it('the Owner\'s CLI sends the same request through the AWS CLI, one page a call, without naming the partition on failure', async () => {
    const calls: string[][] = [];
    const aws = (args: string[]) => {
      calls.push(args);
      return args.includes('--exclusive-start-key') ? { code: 254, stdout: '' } : { code: 0, stdout: JSON.stringify({ Items: [], LastEvaluatedKey: { i: { N: '1' } } }) };
    };
    const q = cliQuery({ aws, profile: 'kanon' });
    await expect(q(queryRequest(TABLE, 'alpha#review'))).resolves.toMatchObject({ LastEvaluatedKey: {} });
    const c = calls[0]!;
    for (const [flag, value] of [['--table-name', TABLE], ['--select', 'SPECIFIC_ATTRIBUTES'], ['--filter-expression', '#tag = :run'], ['--profile', 'kanon'], ['--region', 'eu-central-1']]) {
      expect(c[c.indexOf(flag!) + 1]).toBe(value);
    }
    expect(c).toContain('--no-paginate');
    const err = await q(queryRequest(TABLE, 'alpha#review', { i: { N: '1' } })).catch((e: unknown) => String(e));
    expect(err).toMatch(/a query failed/);
    expect(err).not.toContain('alpha');
  });

  it('takes the keys and the declared labels from the register, refusing a label that is a key', () => {
    expect(fromRegister({ repositories: [{ key: 'alpha', publish_own_figures_as: 'kanon' }, { key: 'beta' }, { key: 'alpha' }] }))
      .toEqual({ keys: ['alpha', 'beta'], own: { alpha: 'kanon' } });
    expect(fromRegister({ repositories: [{ key: 'alpha' }] }).own).toEqual({});
    expect(() => fromRegister({ repositories: [{ key: 'alpha', publish_own_figures_as: 'beta' }, { key: 'beta' }] })).toThrow(/is a key/);
    expect(() => fromRegister({ repositories: [{ key: 'alpha', publish_own_figures_as: true }] })).toThrow(/not a label/);
    expect(() => fromRegister({ repositories: [] })).toThrow(/no repositories/);
    expect(() => fromRegister({ repositories: [{ key: 'Bad#Key' }] })).toThrow(/valid key/);
  });
});

describe('the aggregate-only function (§6.1)', () => {
  const ACCOUNT = '5'.repeat(12);
  const env = { TABLE_NAME: TABLE, ACCOUNT_ID: ACCOUNT, AGGREGATE_KEYS: 'alpha,beta,gamma,delta', OWN_FIGURES: 'alpha=kanon', INVOKER_KEYS: 'alpha' };
  const urlEvent = (role = 'kanon-telemetry-alpha-aggregates', method = 'GET', account = ACCOUNT) => ({
    requestContext: { http: { method }, authorizer: { iam: { userArn: `arn:aws:sts::${account}:assumed-role/${role}/GitHubActions` } } },
  });
  const failed = { outcome: 'failed', reason: 'did_not_finish', failed_stage: 'agent' };
  const items = [...three(), row('delta', 4), row('alpha', 5, { lane: 'implement' }), row('beta', 7, { lane: 'implement', ...failed })];
  const call = async (event: unknown, over: Partial<typeof env> = {}, q = fakeQuery(items).query) => {
    const logs: string[] = [];
    const res = await handle(event, { env: { ...env, ...over }, now: () => NOW, query: q, log: (l) => logs.push(l) });
    return { status: res.statusCode, body: JSON.parse(res.body), logs };
  };

  it('answers only what may leave: cross-adopter cells, declared own figures and signals', async () => {
    const { status, body, logs } = await call(urlEvent());
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['computed_at', 'cross_adopter', 'min_adopters', 'own', 'signal_days', 'signals']);
    expect(body.min_adopters).toBe(3);
    // alpha declared, so the cross-adopter cell is beta, gamma and delta's alone.
    expect(body.cross_adopter).toEqual([{ lane: 'review', model: MODEL, runs: 3, median_cost_usd: 3, p90_cost_usd: 4 }]);
    expect(body.own).toEqual([{ label: 'kanon', cells: [
      { lane: 'implement', model: MODEL, runs: 1, median_cost_usd: 5, p90_cost_usd: 5 },
      { lane: 'review', model: MODEL, runs: 1, median_cost_usd: 1, p90_cost_usd: 1 },
    ] }]);
    expect(body.signals).toEqual([{ lane: 'implement', reason: 'did_not_finish', failed_stage: 'agent', kanon_error: null, kanon_version: '0.32.0', adopters_affected: 1 }]);
    const text = JSON.stringify(body) + logs.join('\n');
    for (const k of ['alpha', 'beta', 'gamma', 'delta', 'withheld', 'excluded']) expect(text).not.toContain(k);
    // beta's lone implement run, which cost 7, is in no figure.
    expect(text).not.toMatch(/_usd":7\b/);
  });

  it('declares nobody\'s own figures when the register declares none', async () => {
    expect((await call(urlEvent(), { OWN_FIGURES: '' })).body.own).toEqual([]);
  });

  it('answers only a registered invoker role in this account, by GET', async () => {
    expect((await call(urlEvent('kanon-telemetry-beta-aggregates'))).status).toBe(403);
    expect((await call(urlEvent('kanon-telemetry-alpha-writer'))).status).toBe(403);
    expect((await call(urlEvent('kanon-telemetry-alpha-aggregates', 'GET', '6'.repeat(12)))).status).toBe(403);
    expect((await call({ requestContext: { http: { method: 'GET' } } })).status).toBe(403);
    expect((await call(urlEvent('kanon-telemetry-alpha-aggregates', 'POST'))).status).toBe(405);
    expect((await call({})).status).toBe(200);
  });

  it('says only that it failed when a query fails, never which partition', async () => {
    const { status, body, logs } = await call(urlEvent(), {}, fakeQuery(items, { failOn: 'beta#lead' }).query);
    expect(status).toBe(502);
    expect(JSON.stringify(body) + logs.join('')).not.toContain('beta');
    expect(logs).toEqual(['aggregate: failed (error)']);
    const denied = async () => { throw new Error('Query 400'); };
    expect((await call(urlEvent(), {}, denied)).logs).toEqual(['aggregate: failed (Query 400)']);
  });

  it('refuses a malformed configuration rather than guess', async () => {
    expect((await call(urlEvent(), { OWN_FIGURES: 'alpha' })).status).toBe(500);
    expect((await call(urlEvent(), { OWN_FIGURES: 'zeta=kanon' })).status).toBe(500);
    expect((await call(urlEvent(), { AGGREGATE_KEYS: 'Al#pha' })).status).toBe(500);
    expect(configOf(env)).toEqual({ keys: ['alpha', 'beta', 'gamma', 'delta'], own: { alpha: 'kanon' }, invokers: ['alpha'] });
  });

  it('checks the caller by role name, account and invoker list', () => {
    expect(callerAllowed(urlEvent(), env, ['alpha'])).toBe(true);
    expect(callerAllowed(urlEvent(), env, [])).toBe(false);
    expect(callerAllowed(urlEvent('kanon-telemetry-alpha-aggregates-x'), env, ['alpha'])).toBe(false);
  });
});
