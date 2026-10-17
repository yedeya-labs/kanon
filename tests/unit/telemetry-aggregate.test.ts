import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aggregate, assertNoKey, bearerOf, handle, keyOf, median, MIN_ADOPTERS, pageView, pathOf, percentile, PROJECTION,
  publicView, queryRequest, readAll, REGISTER_TTL_MS, registerCache, registrationsFrom, scanRegister, scanRequest, SIGNAL_DAYS,
} from '../../infra/telemetry/function/aggregate.mjs';
import { AGGREGATE_GET, AGGREGATE_SCAN } from '../../infra/telemetry/function/register-fields.mjs';
import { AwsError } from '../../infra/telemetry/function/aws.mjs';
import { cliQuery, fromRegister, TABLE } from '../../infra/telemetry/aggregate.mjs';
import { LANES } from '../../actions/agent-telemetry/schema.mjs';
import { prepareRows } from '../../scripts/metrics/indicators.mjs';
import { writeStub } from './helpers/stub-bin.js';
import {
  ALIAS_ARN, EXPLORE, fakeRegister, keys, type Registration, token, tokenEnv, tokenEvent, UNQUALIFIED_ARN,
} from './helpers/aggregate-register.js';

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

describe('a notify row is never counted (plan 0011 §11, N5)', () => {
  /** A notify row as the store holds it: in its lane's partition, beside the run rows, with the fields a projection takes. */
  const notify = (key: string, over: Record<string, unknown> = {}) => ({
    pk: `${key}#review`, row_kind: 'notify', tag: 'run', recorded_at: RECENT, lane: 'review', expires_at: LIVE,
    outcome: 'failed', failure: 'hook-step-failed', kind: 'project-digest', hook: 'slack', kanon_version: '0.32.0', ...over,
  });
  const notifies = ['alpha', 'beta', 'gamma'].flatMap((k) => [notify(k), notify(k, { outcome: 'posted', failure: undefined }), notify(k, { outcome: 'skipped', skip_reason: 'no-secret' })]);

  it('the aggregate counts no notify row in a cell, a signal or the excluded notes', () => {
    expect(run(three())).toEqual(run([...three(), ...notifies] as Row[]));
    const alone = run(notifies as Row[]);
    expect(alone.cross_adopter).toEqual([]);
    expect(alone.signals).toEqual([]);
    expect(alone.notes.excluded).toEqual({ no_model: 0, no_cost: 0 });
  });

  it('the page view\'s rows pass through prepareRows, which counts a notify row as another kind, never as a run', () => {
    const runRow = { row_kind: 'run', tag: 'run', recorded_at: RECENT, lane: 'review', total_cost_usd: 1, outcome: 'ok' };
    const notifyRow = { row_kind: 'notify', tag: 'run', recorded_at: RECENT, lane: 'review', outcome: 'posted', kind: 'project-digest', hook: 'slack' };
    const ctx = prepareRows([runRow, notifyRow, { ...notifyRow, outcome: 'failed' }], ['review']);
    expect(ctx.runs).toEqual([runRow]);
    expect(ctx.ignored).toEqual({ notRun: 0, otherKind: 2, unreadable: 0 });
    expect(ctx.loose.flatMap((g) => g.runs)).toEqual([runRow]);
  });

  it('the page view is the same with and without an adopter\'s notify rows in a delivery lane\'s partition', () => {
    const own = { alpha: 'kanon' };
    const runs = ['alpha', 'beta'].map((k) => row(k, 2, { lane: 'implement', pk: `${k}#implement` }));
    const delivered = Array.from({ length: 12 }, (_, i) => notify('alpha', { lane: 'implement', pk: 'alpha#implement', total_cost_usd: i + 1, recorded_at: new Date(NOW - (40 + i) * 86_400_000).toISOString() }));
    expect(pageView([...runs, ...delivered], { now: NOW, own })).toEqual(pageView(runs, { now: NOW, own }));
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

describe('a malformed register or answer is refused without quoting it (#638)', () => {
  // A made-up key, in a shape the register refuses, so it is never valid and never real.
  const SECRET = 'k_test_SECRET123';
  const quoted = (text: string) => [SECRET, 'SECRET', 'k_test'].filter((s) => text.includes(s));
  const thrown = (f: () => unknown): string => {
    try { f(); } catch (e) { return e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e); }
    throw new Error('expected a throw');
  };

  it('names the entry by its index and field, never by its text', () => {
    const bad = thrown(() => fromRegister({ repositories: [{ key: 'alpha' }, { key: SECRET }] }));
    expect(bad).toMatch(/repositories\[1\] is an entry without a valid key/);
    expect(quoted(bad)).toEqual([]);
    const label = thrown(() => fromRegister({ repositories: [{ key: 'alpha' }, { key: 'beta', publish_own_figures_as: SECRET }] }));
    expect(label).toMatch(/repositories\[1\]\.publish_own_figures_as is not a label/);
    expect(quoted(label)).toEqual([]);
  });

  it('a query that answers something other than JSON is refused without quoting the answer', async () => {
    const q = cliQuery({ aws: () => ({ code: 0, stdout: `{"Items":[{"pk":${SECRET}#review}]}` }), profile: 'kanon' });
    const err = await q(queryRequest(TABLE, 'alpha#review')).then(() => 'resolved', (e: unknown) => (e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)));
    expect(err).toMatch(/a query answered something that is not JSON/);
    expect(quoted(err)).toEqual([]);
  });

  /** Run the CLI as the Owner does, with an `aws` stub first on PATH. */
  const cli = (register: string, awsBody = 'exit 1') => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-aggregate-'));
    try {
      writeStub(join(dir, 'aws'), `#!/usr/bin/env bash\n${awsBody}\n`);
      const reg = join(dir, 'register.json');
      writeFileSync(reg, register);
      return spawnSync(process.execPath, ['infra/telemetry/aggregate.mjs', '--register', reg], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('a register that is not JSON is refused by its path, with no stack and no register text', () => {
    // Unquoted, so JSON.parse's own message would quote the text around it: the key.
    const r = cli(`{ "repositories": [{ "key": ${SECRET} }] }`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^register: .*register\.json is not JSON\n$/);
    expect(quoted(r.stdout + r.stderr)).toEqual([]);
  });

  it('a register with a bad entry, or a failed query, prints the message alone', () => {
    const bad = cli(JSON.stringify({ repositories: [{ key: SECRET }] }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe('register: repositories[0] is an entry without a valid key\n');
    expect(quoted(bad.stdout + bad.stderr)).toEqual([]);
    const garbled = cli(JSON.stringify({ repositories: [{ key: 'ktestabc123' }] }), `printf '{"pk":ktestabc123#review'`);
    expect(garbled.status).toBe(1);
    expect(garbled.stderr).toBe('a query answered something that is not JSON\n');
    expect(garbled.stdout + garbled.stderr).not.toContain('ktestabc');
  });
});

describe("the aggregate-only function (§6.1), on the Owner's direct invoke", () => {
  const ACCOUNT = '5'.repeat(12);
  // Plan 0008 J9: nothing is read from the environment but the tables' names; whose rows are
  // read, and under which labels, comes from the register table.
  const env = { TABLE_NAME: TABLE, ACCOUNT_ID: ACCOUNT };
  const registered: Registration[] = [
    { repository_id: '1', key: 'alpha', label: 'kanon', aggregate_invoker: true },
    { repository_id: '2', key: 'beta' }, { repository_id: '3', key: 'gamma' }, { repository_id: '4', key: 'delta' },
  ];
  /** What `aws lambda invoke` hands the unqualified function: no request context. */
  const direct = {};
  /** What the IAM URL handed it, before J9: an invoker role's signed GET. */
  const urlEvent = (role = 'kanon-telemetry-alpha-aggregates', method = 'GET', account = ACCOUNT) => ({
    requestContext: { http: { method }, authorizer: { iam: { userArn: `arn:aws:sts::${account}:assumed-role/${role}/GitHubActions` } } },
  });
  const failed = { outcome: 'failed', reason: 'did_not_finish', failed_stage: 'agent' };
  const items = [...three(), row('delta', 4), row('alpha', 5, { lane: 'implement' }), row('beta', 7, { lane: 'implement', ...failed })];
  const call = async (event: unknown, { over = {}, q = fakeQuery(items).query, regs = registered, arn }: {
    over?: Record<string, string>, q?: (r: Record<string, J>) => Promise<J>, regs?: Registration[], arn?: string,
  } = {}) => {
    const logs: string[] = [];
    const res = await handle(event, { env: { ...env, ...over }, now: () => NOW, query: q, scan: fakeRegister(regs).scan, invokedArn: arn, log: (l) => logs.push(l) });
    return { status: res.statusCode, body: JSON.parse(res.body), logs };
  };

  it('answers only what may leave: cross-adopter cells, declared own figures and signals', async () => {
    const { status, body, logs } = await call(direct);
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

  it('answers the same through the unqualified ARN, and reads no key or label from the environment', async () => {
    const plain = await call(direct);
    const unqualified = await call(direct, { arn: UNQUALIFIED_ARN });
    expect(unqualified.status).toBe(200);
    expect(unqualified.body).toEqual(plain.body);
    // The variables render.mjs once wrote are not read: malformed ones change nothing.
    expect((await call(direct, { over: { AGGREGATE_KEYS: 'Al#pha', OWN_FIGURES: 'zeta=x', INVOKER_KEYS: 'Al#pha' } })).body).toEqual(plain.body);
  });

  it('declares nobody\'s own figures when the register declares none', async () => {
    const regs = registered.map((r) => ({ ...r, label: undefined }));
    expect((await call(direct, { regs })).body.own).toEqual([]);
  });

  it('refuses every URL-shaped event on the unqualified function, which has no URL since J9: an invoker role\'s among them', async () => {
    for (const ev of [
      urlEvent(), urlEvent('kanon-telemetry-beta-aggregates'), urlEvent('kanon-telemetry-alpha-aggregates', 'GET', '6'.repeat(12)),
      { requestContext: { http: { method: 'GET' } } }, { ...urlEvent(), headers: { authorization: 'AWS4-HMAC-SHA256 Credential=x' } },
    ]) {
      expect(await call(ev), JSON.stringify(ev).slice(0, 80)).toMatchObject({ status: 403, body: { error: 'caller' } });
    }
    expect((await call(urlEvent('kanon-telemetry-alpha-aggregates', 'POST'))).status).toBe(405);
    // A bearer token is the alias's, never the unqualified function's.
    expect(await call({ headers: { authorization: 'Bearer a.b.c' } })).toMatchObject({ status: 403, body: { error: 'caller' } });
  });

  it('refuses any alias but the token path\'s', async () => {
    expect((await call(direct, { arn: `${UNQUALIFIED_ARN}:other` })).status).toBe(403);
    expect((await call(direct, { arn: 'not-an-arn' })).status).toBe(403);
  });

  it('says only that it failed when a query fails, never which partition', async () => {
    const { status, body, logs } = await call(direct, { q: fakeQuery(items, { failOn: 'beta#lead' }).query });
    expect(status).toBe(502);
    expect(JSON.stringify(body) + logs.join('')).not.toContain('beta');
    expect(logs).toEqual(['aggregate: failed (error)']);
    const denied = async () => { throw new Error('Query 400'); };
    expect((await call(direct, { q: denied })).logs).toEqual(['aggregate: failed (Query 400)']);
  });

  it('says only that it failed when the register can\'t be read', async () => {
    const logs: string[] = [];
    const res = await handle(direct, { env, now: () => NOW, query: fakeQuery(items).query, scan: fakeRegister(registered, { failScan: true }).scan, log: (l) => logs.push(l) });
    expect(res.statusCode).toBe(502);
    expect(logs).toEqual(['aggregate: failed (Scan 400)']);
    // DynamoDB's own failure, as `function/aws.mjs` throws it: the operation and AWS's code, nothing of its message.
    const awsLogs: string[] = [];
    const denied = async () => { throw new AwsError('Scan', 'AccessDeniedException'); };
    await handle(direct, { env, now: () => NOW, query: fakeQuery(items).query, scan: denied, log: (l) => awsLogs.push(l) });
    expect(awsLogs).toEqual(['aggregate: failed (Scan AccessDeniedException)']);
  });

  it('refuses a malformed register rather than guess', async () => {
    const relabel = (label: string) => registered.map((r) => (r.key === 'beta' ? { ...r, label } : r));
    expect((await call(direct, { regs: relabel('alpha') })).status).toBe(502);
    expect((await call(direct, { regs: relabel('kanon') })).status).toBe(502);
    expect((await call(direct, { regs: relabel('Not A Label') })).status).toBe(502);
    expect((await call(direct, { regs: [...registered, { repository_id: '9', key: 'Bad#Key' }] })).status).toBe(502);
  });
});

describe('whose rows are read comes from the register table (plan 0008 §3.6, J4)', () => {
  const env = { TABLE_NAME: TABLE };
  const failed = { outcome: 'failed', reason: 'did_not_finish', failed_stage: 'agent' };

  it('takes active registrations\' keys and labels, and keeps every key to check labels against', () => {
    const items = [
      { pk: 'repo#1', key: 'alpha', status: 'active', publish_own_figures_as: 'kanon' },
      { pk: 'repo#2', key: 'beta', status: 'active' },
      { pk: 'repo#3', key: 'gamma', status: 'suspended', publish_own_figures_as: 'gee' },
      { pk: 'repo#4', status: 'erased' },
      { pk: 'key#alpha' },
      { pk: 'count#all#2026-10-07' },
    ];
    expect(registrationsFrom(items)).toEqual({ keys: ['alpha', 'beta'], known: ['alpha', 'beta', 'gamma'], own: { alpha: 'kanon' } });
    expect(() => registrationsFrom([...items, { pk: 'repo#5', key: 'delta', status: 'active', publish_own_figures_as: 'gamma' }])).toThrow(/label/);
  });

  it("reads the register with exactly the aggregate role's Scan projection, following every page", async () => {
    const register = fakeRegister([{ repository_id: '1', key: 'alpha' }, { repository_id: '2', key: 'beta' }]);
    const items = await scanRegister(register.scan, 'kanon-telemetry-register');
    expect(items.filter((i) => i.key).map((i) => i.key)).toEqual(['alpha', 'beta']);
    expect(register.scans.length).toBe(5);
    for (const req of register.scans) {
      expect(req).toMatchObject({ TableName: 'kanon-telemetry-register', Select: 'SPECIFIC_ATTRIBUTES' });
      expect(Object.values(req.ExpressionAttributeNames).sort()).toEqual([...AGGREGATE_SCAN].sort());
    }
    expect(scanRequest('t')).not.toHaveProperty('FilterExpression');
  });

  it("a suspended key's rows are in no cell and no signal, and its partitions are never read", async () => {
    const regs: Registration[] = [
      { repository_id: '1', key: 'alpha' }, { repository_id: '2', key: 'beta' }, { repository_id: '3', key: 'gamma' },
      { repository_id: '4', key: 'delta', status: 'suspended' },
    ];
    const rows = [...three(), row('delta', 4), row('delta', 9, { lane: 'implement', ...failed })];
    const answer = async (r: Registration[]) => {
      const { query, requests } = fakeQuery(rows);
      const res = await handle({}, { env, now: () => NOW, query, scan: fakeRegister(r).scan, log: () => {} });
      return { body: JSON.parse(res.body), partitions: requests.map((q) => q.ExpressionAttributeValues[':p'].S as string) };
    };
    const active = await answer(regs.map((r) => ({ ...r, status: 'active' })));
    expect(active.body.cross_adopter).toEqual([{ lane: 'review', model: MODEL, runs: 4, median_cost_usd: 2.5, p90_cost_usd: 4 }]);
    expect(active.body.signals).toHaveLength(1);
    const quarantined = await answer(regs);
    expect(quarantined.body.cross_adopter).toEqual([{ lane: 'review', model: MODEL, runs: 3, median_cost_usd: 2, p90_cost_usd: 3 }]);
    expect(quarantined.body.signals).toEqual([]);
    expect(quarantined.partitions.some((p) => p.startsWith('delta#'))).toBe(false);
    // Two active adopters left: the cell is withheld, not computed from the suspended key's rows.
    const two = await answer([...regs.slice(0, 2), { repository_id: '3', key: 'gamma', status: 'suspended' }, regs[3]!]);
    expect(two.body.cross_adopter).toEqual([]);
  });

  it('publishes a cross-adopter cell from three keys of one repository owner: adopters are counted by key (Owner decision 7)', async () => {
    const regs: Registration[] = ['alpha', 'beta', 'gamma'].map((key, i) => ({ repository_id: String(i + 1), key, owner: '42' }));
    const res = await handle({}, { env, now: () => NOW, query: fakeQuery(three()).query, scan: fakeRegister(regs).scan, log: () => {} });
    expect(JSON.parse(res.body).cross_adopter).toEqual([{ lane: 'review', model: MODEL, runs: 3, median_cost_usd: 2, p90_cost_usd: 3 }]);
  });

  it('holds the scan for five minutes in a container, and never holds a failure', async () => {
    const cache = registerCache();
    let loads = 0;
    const load = async () => { loads += 1; return [{ pk: 'repo#1', key: `k${loads}`, status: 'active' }]; };
    expect((await cache.get(NOW, load))[0]!.key).toBe('k1');
    expect((await cache.get(NOW + REGISTER_TTL_MS - 1, load))[0]!.key).toBe('k1');
    expect((await cache.get(NOW + REGISTER_TTL_MS, load))[0]!.key).toBe('k2');
    const fresh = registerCache();
    await expect(fresh.get(NOW, async () => { throw new Error('Scan 500'); })).rejects.toThrow();
    expect((await fresh.get(NOW, load))[0]!.key).toBe('k3');
  });
});

describe('the token path (plan 0008 §3.6, J4): the Explorer at a release, on its own alias\'s URL', () => {
  const regs: Registration[] = [
    { repository_id: '1', key: 'alpha', label: 'kanon', aggregate_invoker: true },
    { repository_id: '2', key: 'beta' }, { repository_id: '3', key: 'gamma' }, { repository_id: '4', key: 'delta', aggregate_invoker: false },
  ];
  const items = [...three(), row('delta', 4), row('alpha', 5, { lane: 'implement' })];
  const call = async (event: unknown, { r = regs, env = tokenEnv, arn = ALIAS_ARN }: { r?: Registration[], env?: Record<string, string>, arn?: string } = {}) => {
    const logs: string[] = [];
    const register = fakeRegister(r);
    const res = await handle(event, {
      env, now: () => NOW, query: fakeQuery(items).query, scan: register.scan, getItem: register.getItem, keys: keys(), invokedArn: arn, log: (l) => logs.push(l),
    });
    return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body), logs, gets: register.gets };
  };

  it('answers the Explorer\'s token from a registration whose aggregate_invoker is true, either view, as the direct invoke does', async () => {
    const { status, body, logs, gets } = await call(tokenEvent(token(NOW, '1')));
    expect(status).toBe(200);
    expect(body.cross_adopter).toEqual([{ lane: 'review', model: MODEL, runs: 3, median_cost_usd: 3, p90_cost_usd: 4 }]);
    expect(body.own.map((o: J) => o.label)).toEqual(['kanon']);
    expect(JSON.stringify(body) + logs.join('\n')).not.toMatch(/alpha|beta|gamma|delta/);
    expect(gets).toHaveLength(1);
    expect(gets[0]).toMatchObject({ TableName: 'kanon-telemetry-register', Key: { pk: { S: 'repo#1' } } });
    expect(Object.values(gets[0].ExpressionAttributeNames).sort()).toEqual([...AGGREGATE_GET].sort());
    expect((await call(tokenEvent(token(NOW, '1'), { view: 'page' }))).body.view).toBe('page');
  });

  it('a registration without aggregate_invoker gets 403', async () => {
    expect(await call(tokenEvent(token(NOW, '2')))).toMatchObject({ status: 403, body: { error: 'invoker' } });
    expect(await call(tokenEvent(token(NOW, '4')))).toMatchObject({ status: 403, body: { error: 'invoker' } });
    expect(await call(tokenEvent(token(NOW, '2'), { view: 'page' }))).toMatchObject({ status: 403, body: { error: 'invoker' } });
  });

  it('a suspended caller gets 403 suspended, an erased one 410, and an unregistered one 404', async () => {
    const as = (status: string) => regs.map((x) => (x.key === 'alpha' ? { ...x, status } : x));
    expect(await call(tokenEvent(token(NOW, '1')), { r: as('suspended') })).toMatchObject({ status: 403, body: { error: 'suspended' } });
    expect(await call(tokenEvent(token(NOW, '1')), { r: as('erased') })).toMatchObject({ status: 410, body: { error: 'erased' } });
    expect(await call(tokenEvent(token(NOW, '99')))).toMatchObject({ status: 404, body: { error: 'not-registered' } });
  });

  it('answers the verifier\'s refusal by its code alone, with the bearer challenge on a 401', async () => {
    const none = await call(tokenEvent(undefined));
    expect(none).toMatchObject({ status: 401, body: { error: 'token' } });
    expect(none.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect((await call({ ...tokenEvent(undefined), headers: { authorization: 'Basic x' } })).status).toBe(401);
    expect(await call(tokenEvent(token(NOW, '1', { aud: 'sts.amazonaws.com' })))).toMatchObject({ status: 401, body: { error: 'aud' } });
    expect(await call(tokenEvent(token(NOW, '1', { event_name: 'push' })))).toMatchObject({ status: 403, body: { error: 'event' } });
    const overseer = 'yedeya-labs/kanon/.github/workflows/agent-overseer.yml@refs/tags/v0.40.0';
    expect(await call(tokenEvent(token(NOW, '1', { job_workflow_ref: overseer })))).toMatchObject({ status: 403, body: { error: 'workflow' } });
    expect(await call(tokenEvent(token(NOW, '1', { job_workflow_ref: `${EXPLORE}@refs/tags/v0.39.0` })))).toMatchObject({ status: 403, body: { error: 'workflow' } });
    expect(await call(tokenEvent(token(NOW, '1', { repository_owner_id: '1' })))).toMatchObject({ status: 403, body: { error: 'owner' } });
    expect(await call(tokenEvent(token(NOW, '1', { event_name: 'workflow_dispatch', ref: 'refs/heads/other' })))).toMatchObject({ status: 403, body: { error: 'ref' } });
  });

  it('refuses an IAM-shaped request on the alias\'s URL, and answers nothing without a token there', async () => {
    const iam = { ...tokenEvent(token(NOW, '1')), requestContext: { http: { method: 'GET' }, authorizer: { iam: { userArn: 'x' } } } };
    expect(await call(iam)).toMatchObject({ status: 403, body: { error: 'caller' } });
    expect((await call({})).status).toBe(401);
    expect((await call({ ...tokenEvent(token(NOW, '1')), requestContext: { http: { method: 'POST' } } })).status).toBe(405);
  });

  it('refuses any view but the two, after the token', async () => {
    expect((await call(tokenEvent(token(NOW, '1'), { view: 'rows' }))).status).toBe(400);
    expect((await call(tokenEvent(token(NOW, '2'), { view: 'rows' }))).status).toBe(403);
  });

  it('answers 503 `config` without its audience or version floor, as the ingest function does, and 502 when the registration can\'t be read', async () => {
    expect(await call(tokenEvent(token(NOW, '1')), { env: { ...tokenEnv, AUDIENCE: '' } })).toMatchObject({ status: 503, body: { error: 'config' } });
    expect(await call(tokenEvent(token(NOW, '1')), { env: { ...tokenEnv, MIN_TOKEN_VERSION: 'v1' } })).toMatchObject({ status: 503, body: { error: 'config' } });
    // The template's default floor, empty, admits no token.
    expect(await call(tokenEvent(token(NOW, '1')), { env: { ...tokenEnv, MIN_TOKEN_VERSION: '' } })).toMatchObject({ status: 503, body: { error: 'config' } });
    const logs: string[] = [];
    const res = await handle(tokenEvent(token(NOW, '1')), {
      env: tokenEnv, now: () => NOW, query: fakeQuery(items).query, scan: fakeRegister(regs).scan,
      getItem: async () => { throw new Error('GetItem 400'); }, keys: keys(), invokedArn: ALIAS_ARN, log: (l) => logs.push(l),
    });
    expect(res.statusCode).toBe(502);
    expect(logs).toEqual(['aggregate: failed (GetItem 400)']);
  });

  it('tells the two ways in apart by the invoked ARN alone', () => {
    expect(pathOf(ALIAS_ARN)).toBe('token');
    expect(pathOf(UNQUALIFIED_ARN)).toBe('direct');
    expect(pathOf(undefined)).toBe('direct');
    expect(pathOf(`${UNQUALIFIED_ARN}:$LATEST`)).toBe(null);
    expect(pathOf(`${UNQUALIFIED_ARN}:import`)).toBe(null);
    expect(pathOf('')).toBe(null);
    expect(bearerOf({ headers: { Authorization: 'Bearer t' } })).toBe('t');
    expect(bearerOf({ headers: { authorization: 'Bearer ' } })).toBe('');
    expect(bearerOf({})).toBe(undefined);
  });
});
