import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTES, PROJECTION, WORK_PROJECTION, handle, pageView, queryRequest, readPage,
} from '../../infra/telemetry/function/aggregate.mjs';
import { MINIMUM, TREND_WINDOWS, WINDOW_DAYS } from '../../scripts/metrics/indicators.mjs';
import { LANES } from '../../actions/agent-telemetry/schema.mjs';

/**
 * Plan 0003 M7 (kanon#661): the aggregate function's page view, the work-item indicators the
 * public page shows. The function computes the report of `scripts/metrics/indicators.mjs` over
 * each DECLARING adopter's run partitions and its `#work` partition, under its label, and over
 * nobody else's: no cross-adopter work-item figure is computed, so the three-adopter rule holds
 * by construction, and the subtraction guard (#449) with it. The default answer is unchanged, so
 * a reader pinned to an earlier release keeps reading it.
 */

const NOW = Date.parse('2026-10-07T12:00:00Z');
const LIVE = Math.floor(NOW / 1000) + 86_400;
const CLOSED = '2026-10-01T10:00:00Z';
const RAN = '2026-09-30T10:00:00Z';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Stored = Record<string, string | number>;

const work = (key: string, pr: number, over: Stored = {}): Stored => ({
  pk: `${key}#work`, row_kind: 'work_item', tag: 'run', recorded_at: CLOSED, expires_at: LIVE, pr_number: pr, closed_at: CLOSED,
  fate: 'merged', changed_lines: 100, changed_files: 3, changed_dirs: 1, author_kind: 'implementer', first_verdict: 'approved',
  human_commits: 0, human_cr_after_approval: 0, kanon_version: '0.39.0', ...over,
});
const run = (key: string, pr: number, cost: number, over: Stored = {}): Stored => ({
  pk: `${key}#implement`, row_kind: 'run', tag: 'run', recorded_at: RAN, expires_at: LIVE, lane: 'implement', model: 'claude-opus-5-5',
  total_cost_usd: cost, outcome: 'ok', pr_number: pr, kanon_version: '0.39.0', ...over,
});
/** `n` merged items of one adopter, each with one costed run. */
const items = (key: string, n: number, from = 1, cost = (i: number) => i) =>
  Array.from({ length: n }, (_, k) => [work(key, from + k), run(key, from + k, cost(k + 1))]).flat();

const page = (rows: Stored[], own: Record<string, string> = { alpha: 'kanon' }) => pageView(rows, { now: NOW, own });
const entry = (p: ReturnType<typeof page>, label = 'kanon') => p.own.find((o: J) => o.label === label) as J;

/** A fake table answering Query pages, honouring the filter on `tag`. */
function fakeQuery(stored: Stored[]) {
  const requests: J[] = [];
  const attrs = (o: Stored) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? { N: String(v) } : { S: v }]));
  const query = async (req: J) => {
    requests.push(req);
    const pk = req.ExpressionAttributeValues[':p'].S as string;
    const wanted = Object.values(req.ExpressionAttributeNames) as string[];
    const all = stored.filter((i) => i.pk === pk && i.tag === req.ExpressionAttributeValues[':run'].S);
    return { Items: all.map((i) => attrs(Object.fromEntries(Object.entries(i).filter(([k]) => wanted.includes(k))))) };
  };
  return { query, requests };
}

describe('the page view: the work-item indicators of each declaring adopter (plan 0003 M7)', () => {
  it('shows a cell below its minimum as not enough data with its count, never a number', () => {
    const p = entry(page(items('alpha', 9)));
    expect(p.headline.cost.pooled.median).toEqual({ status: 'not-enough-data', n: 9, minimum: MINIMUM.median });
    expect(p.headline.yield.pooled.yield).toEqual({ status: 'not-enough-data', n: 9, minimum: MINIMUM.yield });
    expect(JSON.stringify(p.headline.cost)).not.toMatch(/"value"/);
  });

  it('gives each cell at its minimum its value, its sample size and its 95% interval', () => {
    const p = entry(page(items('alpha', MINIMUM.median)));
    expect(p.headline.cost.pooled.median).toMatchObject({ status: 'ok', n: MINIMUM.median, value: 5.5 });
    expect(typeof p.headline.cost.pooled.median.low).toBe('number');
    expect(typeof p.headline.cost.pooled.median.high).toBe('number');
    expect(p.headline.cost.pooled.bandMix).toEqual({ S: MINIMUM.median, M: 0, L: 0, XL: 0, none: 0 });
  });

  it('states the window, the band version and the cost basis of every figure', () => {
    const p = page(items('alpha', 3));
    expect(p).toMatchObject({ view: 'page', band_version: 1, cost_basis: 'API list price', window_days: WINDOW_DAYS, trend_windows: TREND_WINDOWS, min_adopters: 3 });
    expect(p.minimum).toEqual(MINIMUM);
    // The window ends at the start of the day it was computed, so a page is the same all day.
    expect(entry(p).window).toEqual({ from: '2026-09-09', until: '2026-10-07', days: WINDOW_DAYS });
    expect(entry(p).headline.escape.d30).toMatchObject({ merged_from: '2026-08-10', merged_until: '2026-09-07' });
  });

  it('shows the trend, one cell per window, and the by-version view', () => {
    const p = entry(page(items('alpha', 12)));
    expect(p.trend).toHaveLength(TREND_WINDOWS);
    expect(p.trend.at(-1).window).toEqual({ from: '2026-09-09', until: '2026-10-07', days: WINDOW_DAYS });
    expect(p.trend.at(-1).cost.median).toMatchObject({ status: 'ok', n: 12 });
    expect(p.by_version.versions.map((v: J) => [v.version, v.items])).toEqual([['0.39.0', 12]]);
    expect(p.by_version.minimum).toBe(MINIMUM.median);
  });

  it("computes one adopter's figures from its own rows only, under its label, as one adopter", () => {
    const p = page([...items('alpha', 12), ...items('beta', 12, 100, () => 1000)], { alpha: 'kanon', beta: 'second' });
    expect(p.own.map((o: J) => [o.label, o.adopters])).toEqual([['kanon', 1], ['second', 1]]);
    expect(entry(p).headline.cost.pooled.median.value).toBe(6.5);
    expect(entry(p, 'second').headline.cost.pooled.median.value).toBe(1000);
  });

  it("never computes a figure from an adopter that did not declare its own: the three-adopter rule and the subtraction guard (#449)", () => {
    const alone = page(items('alpha', 12));
    const withOthers = page([...items('alpha', 12), ...items('beta', 12, 100, () => 7), ...items('gamma', 12, 200), ...items('delta', 12, 300)]);
    expect(withOthers).toEqual(alone);
    expect(Object.keys(withOthers).sort()).toEqual(['band_version', 'bootstrap', 'computed_at', 'cost_basis', 'min_adopters', 'minimum', 'own', 'trend_windows', 'view', 'window_days']);
  });

  it('names no adopter key anywhere, and refuses a label that is one', () => {
    const text = JSON.stringify(page([...items('alpha', 12), ...items('beta', 3, 50)], { alpha: 'kanon', beta: 'second' }));
    for (const k of ['alpha', 'beta']) expect(text).not.toContain(k);
    expect(() => page(items('alpha', 3), { alpha: 'alpha' })).toThrow(/adopter key/);
  });

  it("refuses a label equal to the key of an adopter whose rows it does not read", () => {
    const rows = items('alpha', 3);
    expect(() => pageView(rows, { now: NOW, own: { alpha: 'beta' }, keys: ['alpha', 'beta'] })).toThrow(/adopter key/);
    expect(entry(pageView(rows, { now: NOW, own: { alpha: 'kanon' }, keys: ['alpha', 'beta'] }))).toBeDefined();
  });

  it('reads no row past its expiry, and no row not tagged run', () => {
    const expired = items('alpha', 12).map((r) => (r.pr_number === 1 && r.row_kind === 'work_item' ? { ...r, expires_at: Math.floor(NOW / 1000) } : r));
    expect(entry(page(expired)).headline.cost.pooled.median.n).toBe(11);
    const smoke = items('alpha', 12).map((r) => (r.pr_number === 1 ? { ...r, tag: 'smoke' } : r));
    expect(entry(page(smoke)).headline.cost.pooled.median.n).toBe(11);
  });
});

describe("the page view's reads", () => {
  it("query only the declaring adopters' partitions: every run lane and `#work`, nobody else's", async () => {
    const stored = [...items('alpha', 2), ...items('beta', 2, 10)];
    const { query, requests } = fakeQuery(stored);
    const rows = await readPage({ alpha: 'kanon' }, query, 'kanon-telemetry');
    const partitions = requests.map((r) => r.ExpressionAttributeValues[':p'].S);
    expect(partitions.sort()).toEqual([...LANES.map((l) => `alpha#${l}`), 'alpha#work'].sort());
    expect(rows).toHaveLength(4);
  });

  it('ask for exactly their projection: the run projection for a lane, the work projection for `#work`', () => {
    const names = (req: J) => Object.values(req.ExpressionAttributeNames).sort();
    expect(names(queryRequest('t', 'alpha#review'))).toEqual([...PROJECTION].sort());
    expect(names(queryRequest('t', 'alpha#work', undefined, WORK_PROJECTION))).toEqual([...WORK_PROJECTION].sort());
    expect([...ATTRIBUTES].sort()).toEqual([...new Set([...PROJECTION, ...WORK_PROJECTION])].sort());
  });

  it('the work projection holds what the indicators read, and no text field', () => {
    for (const f of ['pr_number', 'closed_at', 'fate', 'closing_issues', 'changed_lines', 'changed_files', 'changed_dirs', 'author_kind', 'revert_days', 'first_fix_days', 'first_verdict', 'human_commits', 'human_cr_after_approval', 'kanon_version']) {
      expect(WORK_PROJECTION, f).toContain(f);
    }
    for (const f of ['pr_number', 'issue_number']) expect(PROJECTION, f).toContain(f);
    for (const f of ['evidence', 'title', 'body', 'login']) expect(ATTRIBUTES).not.toContain(f);
  });
});

describe('the function answers the page view only when asked, and the default answer is unchanged', () => {
  const ACCOUNT = '5'.repeat(12);
  const env = { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT, AGGREGATE_KEYS: 'alpha,beta', OWN_FIGURES: 'alpha=kanon', INVOKER_KEYS: 'alpha' };
  const urlEvent = (query?: Record<string, string>) => ({
    requestContext: { http: { method: 'GET' }, authorizer: { iam: { userArn: `arn:aws:sts::${ACCOUNT}:assumed-role/kanon-telemetry-alpha-aggregates/GitHubActions` } } },
    ...(query ? { queryStringParameters: query, rawQueryString: new URLSearchParams(query).toString() } : {}),
  });
  const call = async (event: unknown) => {
    const logs: string[] = [];
    const res = await handle(event, { env, now: () => NOW, query: fakeQuery([...items('alpha', 12), ...items('beta', 12, 100)]).query, log: (l) => logs.push(l) });
    return { status: res.statusCode, body: JSON.parse(res.body), logs };
  };

  it('answers `?view=page` with the page view', async () => {
    const { status, body, logs } = await call(urlEvent({ view: 'page' }));
    expect(status).toBe(200);
    expect(body.view).toBe('page');
    expect(body.own.map((o: J) => o.label)).toEqual(['kanon']);
    expect(body.own[0].headline.cost.pooled.median).toMatchObject({ status: 'ok', n: 12 });
    expect(JSON.stringify(body) + logs.join('\n')).not.toMatch(/alpha|beta/);
    expect(logs).toEqual(['aggregate: page view, 1 own']);
  });

  it('answers a GET with no query exactly as before', async () => {
    const { status, body } = await call(urlEvent());
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['computed_at', 'cross_adopter', 'min_adopters', 'own', 'signal_days', 'signals']);
  });

  it('refuses any other view or any other parameter, so a caller still cannot narrow a figure', async () => {
    expect((await call(urlEvent({ view: 'rows' }))).status).toBe(400);
    expect((await call(urlEvent({ view: 'page', key: 'beta' }))).status).toBe(400);
    expect((await call(urlEvent({ adopter: 'beta' }))).status).toBe(400);
  });

  it("returns nothing when a declared label is another adopter's key, though that adopter's rows are not read", async () => {
    const res = await handle(urlEvent({ view: 'page' }), { env: { ...env, OWN_FIGURES: 'alpha=beta' }, now: () => NOW, query: fakeQuery(items('alpha', 3)).query, log: () => {} });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toMatch(/alpha|beta/);
  });

  it('answers a direct invoke with the page view too, for the Owner to reproduce the page', async () => {
    expect((await call({ queryStringParameters: { view: 'page' } })).body.view).toBe('page');
  });
});
