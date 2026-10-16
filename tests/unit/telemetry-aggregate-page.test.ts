import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTES, PROJECTION, WORK_PROJECTION, handle, pageReaderOf, pageView, queryRequest, readPage,
} from '../../infra/telemetry/function/aggregate.mjs';
import { ENDPOINT_WORKFLOWS, verifyToken } from '../../infra/telemetry/function/oidc.mjs';
import { MINIMUM, TREND_WINDOWS, WINDOW_DAYS } from '../../scripts/metrics/indicators.mjs';
import { AB_MARGINS, metricsViews } from '../../scripts/metrics/views.mjs';
import { releaseRows, winRows } from './helpers/release-rows.js';
import { LANES } from '../../actions/agent-telemetry/schema.mjs';
import {
  ALIAS_ARN, AUDIENCE, DEFAULT_REF, EXPLORE, fakeRegister, keys, METRICS_PAGE, MIN_VERSION, OWNER, pageToken, type Registration,
  token, tokenEnv, tokenEvent,
} from './helpers/aggregate-register.js';

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

describe('the page view: the release comparison (kanon#1453)', () => {
  const DAY = 86_400_000;
  /** What `kanon metrics report` says of the same rows, over the same span. */
  const reportOf = (stored: Stored[]) => metricsViews(stored.map((r) => { const plain = { ...r }; delete plain.pk; delete plain.expires_at; return plain; }), { until: new Date(Math.floor(NOW / DAY) * DAY) }).releaseComparison as J;

  it("compares each release with the code `kanon metrics report` runs, and publishes only the Owner's derived fields", () => {
    const stored = winRows('alpha', NOW);
    const rc = entry(page(stored)).release_comparison;
    const [r] = reportOf(stored).comparisons;
    expect(rc.comparisons).toHaveLength(1);
    const [c] = rc.comparisons;
    expect(c.verdict).toBe('win');
    expect(c.verdict).toBe(r.verdict);
    expect(c.costAtEqualSize).toEqual({ status: 'ok', n: r.costAtEqualSize.n, value: r.costAtEqualSize.pct, low: r.costAtEqualSize.loPct, high: r.costAtEqualSize.hiPct });
    expect(c.yieldDifference).toEqual(r.yieldDifference);
    expect(c.escapeDifference).toEqual(r.escapeDifference);
    expect(c.old).toEqual({ version: '0.39.0', items: 100, from: r.old.from, until: r.old.until });
    expect(c.new).toEqual({ version: '0.40.0', items: 100, from: r.new.from, until: r.new.until });
    // Exactly these fields: no release's cost, yield or escape cells, no item, no text.
    expect(Object.keys(rc).sort()).toEqual(['comparisons', 'dev', 'fewer', 'margins', 'minimum']);
    expect(Object.keys(c).sort()).toEqual(['costAtEqualSize', 'escapeDifference', 'new', 'old', 'verdict', 'yieldDifference']);
    expect(rc).toMatchObject({ minimum: MINIMUM.median, margins: AB_MARGINS, fewer: [], dev: 0 });
  });

  it('publishes a fit below its minimum as not enough data with its counts, never its reason', () => {
    const stored = [
      ...releaseRows('alpha', '0.39.0', 1, 12, { now: NOW, days: [100, 160], scale: 1 }),
      ...releaseRows('alpha', '0.40.0', 1001, 12, { now: NOW, days: [31, 95], scale: 0.5 }).map((r) => {
        if (r.row_kind !== 'work_item' || (r.pr_number as number) < 1009) return r;
        const rest = { ...r };
        delete rest.changed_lines;
        return rest;
      }),
      ...releaseRows('alpha', '0.41.0', 2001, 4, { now: NOW, days: [10, 20], scale: 1 }),
    ];
    const rc = entry(page(stored)).release_comparison;
    expect(rc.comparisons[0].costAtEqualSize).toEqual({ status: 'not-enough-data', n: 8, minimum: MINIMUM.median });
    expect(rc.comparisons[0].yieldDifference).toEqual({ status: 'not-enough-data', n: 12, minimum: MINIMUM.yield });
    expect(rc.comparisons[0].verdict).toBe('not-enough-data');
    expect(rc.fewer).toEqual([{ version: '0.41.0', items: 4 }]);
    expect(JSON.stringify(rc)).not.toMatch(/needs|reason/);
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
  const env = { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT };
  const regs: Registration[] = [{ repository_id: '1', key: 'alpha', label: 'kanon', aggregate_invoker: true }, { repository_id: '2', key: 'beta' }];
  // The Owner's direct invoke (plan 0008 J9): the token URL's own answers are telemetry-aggregate.test.ts's.
  const urlEvent = (query?: Record<string, string>) => ({
    ...(query ? { queryStringParameters: query, rawQueryString: new URLSearchParams(query).toString() } : {}),
  });
  const call = async (event: unknown) => {
    const logs: string[] = [];
    const res = await handle(event, {
      env, now: () => NOW, query: fakeQuery([...items('alpha', 12), ...items('beta', 12, 100)]).query, scan: fakeRegister(regs).scan, log: (l) => logs.push(l),
    });
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
    const clash = [{ ...regs[0]!, label: 'beta' }, regs[1]!];
    const res = await handle(urlEvent({ view: 'page' }), { env, now: () => NOW, query: fakeQuery(items('alpha', 3)).query, scan: fakeRegister(clash).scan, log: () => {} });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toMatch(/alpha|beta/);
    // Nor a suspended adopter's key: every key the table holds is checked, whatever its status.
    const suspended = [{ ...regs[0]!, label: 'beta' }, { ...regs[1]!, status: 'suspended' }];
    expect((await handle(urlEvent({ view: 'page' }), { env, now: () => NOW, query: fakeQuery([]).query, scan: fakeRegister(suspended).scan, log: () => {} })).statusCode).toBe(502);
    // The default view reads no suspended key's rows, so only the register's check stands between its key and `own`.
    const plain = await handle(urlEvent(), { env, now: () => NOW, query: fakeQuery(items('alpha', 3)).query, scan: fakeRegister(suspended).scan, log: () => {} });
    expect(plain.statusCode).toBe(502);
    expect(plain.body).not.toMatch(/beta/);
  });

  it('answers a direct invoke with the page view too, for the Owner to reproduce the page', async () => {
    expect((await call({ queryStringParameters: { view: 'page' } })).body.view).toBe('page');
  });
});

describe("the page view's partitions come from the register table (plan 0008 §3.6, J4)", () => {
  const env = { TABLE_NAME: 'kanon-telemetry' };
  const stored = [...items('alpha', 12), ...items('beta', 12, 100), ...items('gamma', 12, 200)];
  const read = async (regs: Registration[]) => {
    const { query, requests } = fakeQuery(stored);
    const res = await handle({ queryStringParameters: { view: 'page' } }, { env, now: () => NOW, query, scan: fakeRegister(regs).scan, log: () => {} });
    return { body: JSON.parse(res.body), partitions: requests.map((r) => r.ExpressionAttributeValues[':p'].S as string).sort() };
  };
  const partitionsOf = (...keys: string[]) => keys.flatMap((k) => [...LANES.map((l) => `${k}#${l}`), `${k}#work`]).sort();

  it('reads exactly the partitions of registrations with publish_own_figures_as', async () => {
    const one = await read([{ repository_id: '1', key: 'alpha', label: 'kanon' }, { repository_id: '2', key: 'beta' }, { repository_id: '3', key: 'gamma' }]);
    expect(one.partitions).toEqual(partitionsOf('alpha'));
    const two = await read([{ repository_id: '1', key: 'alpha', label: 'kanon' }, { repository_id: '2', key: 'beta', label: 'bee' }, { repository_id: '3', key: 'gamma' }]);
    expect(two.partitions).toEqual(partitionsOf('alpha', 'beta'));
    expect(two.body.own.map((o: J) => o.label)).toEqual(['bee', 'kanon']);
  });

  it("a suspended key's rows are in no page view, though it declared a label", async () => {
    const r = await read([
      { repository_id: '1', key: 'alpha', label: 'kanon' }, { repository_id: '2', key: 'beta', label: 'bee', status: 'suspended' },
    ]);
    expect(r.partitions).toEqual(partitionsOf('alpha'));
    expect(r.body.own.map((o: J) => o.label)).toEqual(['kanon']);
    expect(JSON.stringify(r.body)).not.toContain('bee');
  });
});

describe("§2.2's one exception: Kanon's metrics page workflow reads the page view only (plan 0008 §2.5's last four rows, J4)", () => {
  // Kanon's registration carries page_reader; the Explorer's lane on it is separate (aggregate_invoker).
  const KANON: Registration = { repository_id: '1', key: 'alpha', label: 'kanon', page_reader: true };
  const stored = [...items('alpha', 12), ...items('beta', 12, 100)];
  const call = async (bearer: string, query?: Record<string, string>, regs: Registration[] = [KANON, { repository_id: '2', key: 'beta', page_reader: false }]) => {
    const register = fakeRegister(regs);
    const res = await handle(tokenEvent(bearer, query), {
      env: tokenEnv, now: () => NOW, query: fakeQuery(stored).query, scan: register.scan, getItem: register.getItem, keys: keys(), invokedArn: ALIAS_ARN, log: () => {},
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const page = { view: 'page' };

  it('a metrics-page.yml token at the default branch is answered on `?view=page`', async () => {
    const { status, body } = await call(pageToken(NOW, '1'), page);
    expect(status).toBe(200);
    expect(body.view).toBe('page');
    expect(body.own.map((o: J) => o.label)).toEqual(['kanon']);
    // A job_workflow_ref equal to workflow_ref is the same job, and is admitted too.
    expect((await call(pageToken(NOW, '1', { job_workflow_ref: `${METRICS_PAGE}@refs/heads/main` }), page)).status).toBe(200);
    expect((await call(pageToken(NOW, '1', { event_name: 'workflow_dispatch' }), page)).status).toBe(200);
  });

  it('the metrics page exception not held to the page view: its token asking the default view, and on any ingest endpoint, is refused', async () => {
    expect(await call(pageToken(NOW, '1'))).toMatchObject({ status: 403, body: { error: 'workflow' } });
    expect(await call(pageToken(NOW, '1'), { view: 'rows' })).toMatchObject({ status: 400 });
    const registrationOf = async () => ({ repository_owner_id: OWNER, default_ref: DEFAULT_REF });
    for (const endpoint of Object.keys(ENDPOINT_WORKFLOWS).filter((e) => e !== 'aggregate')) {
      const verdict = await verifyToken(pageToken(NOW, '1'), { audience: AUDIENCE, endpoint, now: NOW, keys: keys(), minTokenVersion: MIN_VERSION, registrationOf });
      expect(verdict, endpoint).toEqual({ ok: false, status: 403, error: 'workflow' });
    }
  });

  it("the exception's workflow_ref not anchored, or its branch not compared: other branches, a tag and other repositories are refused", async () => {
    for (const ref of [
      `${METRICS_PAGE}@refs/heads/other`,
      `${METRICS_PAGE}@refs/tags/v9.0.0`,
      'evil/kanon/.github/workflows/metrics-page.yml@refs/heads/main',
      'yedeya-labs/kanon-fork/.github/workflows/metrics-page.yml@refs/heads/main',
      'yedeya-labs/kanon/.github/workflows/metrics-page.yml.bak@refs/heads/main',
      'yedeya-labs/kanon/.github/workflows/xmetrics-page.yml@refs/heads/main',
      `${METRICS_PAGE}@refs/heads/main/x`,
      `x${METRICS_PAGE}@refs/heads/main`,
    ]) {
      expect(await call(pageToken(NOW, '1', { workflow_ref: ref }), page), ref).toMatchObject({ status: 403, body: { error: 'workflow' } });
    }
    // Its own branch named, but the run's ref is another: check 9 still holds.
    expect(await call(pageToken(NOW, '1', { ref: 'refs/heads/other', event_name: 'workflow_dispatch' }), page)).toMatchObject({ status: 403, body: { error: 'ref' } });
    expect(await call(pageToken(NOW, '1', { ref_type: 'tag' }), page)).toMatchObject({ status: 403, body: { error: 'ref' } });
    // A registration whose default branch is another refuses `@refs/heads/main`.
    expect(await call(pageToken(NOW, '1'), page, [{ ...KANON, default_ref: 'refs/heads/trunk' }])).toMatchObject({ status: 403, body: { error: 'workflow' } });
  });

  it('job_workflow_ref not compared with workflow_ref under the exception: a token naming another workflow in it is refused', async () => {
    for (const other of [`${EXPLORE}@refs/heads/main`, `${METRICS_PAGE}@refs/heads/other`, 'yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@refs/heads/main', '']) {
      expect(await call(pageToken(NOW, '1', { job_workflow_ref: other }), page), other).toMatchObject({ status: 403, body: { error: 'workflow' } });
    }
  });

  it('page_reader not checked: a metrics-page.yml token from a registration without page_reader is refused', async () => {
    expect(await call(pageToken(NOW, '2'), page)).toMatchObject({ status: 403, body: { error: 'workflow' } });
    expect(await call(pageToken(NOW, '1'), page, [{ ...KANON, page_reader: undefined }])).toMatchObject({ status: 403, body: { error: 'workflow' } });
    // aggregate_invoker is the Explorer's flag, not the page's.
    expect(await call(pageToken(NOW, '1'), page, [{ ...KANON, page_reader: undefined, aggregate_invoker: true }])).toMatchObject({ status: 403, body: { error: 'workflow' } });
  });

  it('holds checks 1 to 6, 8 and 9 as for any token, and a suspension', async () => {
    const valid = pageToken(NOW, '1');
    const [h, p, s] = valid.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), repository_id: '2' })).toString('base64url')}.${s}`;
    expect(await call(forged, page)).toMatchObject({ status: 401, body: { error: 'signature' } });
    expect(await call(pageToken(NOW, '1', { aud: 'other' }), page)).toMatchObject({ status: 401, body: { error: 'aud' } });
    expect(await call(pageToken(NOW - 11 * 60_000, '1'), page)).toMatchObject({ status: 401, body: { error: 'time' } });
    expect(await call(pageToken(NOW, '1', { event_name: 'pull_request' }), page)).toMatchObject({ status: 403, body: { error: 'event' } });
    expect(await call(pageToken(NOW, '1', { repository_owner_id: '1' }), page)).toMatchObject({ status: 403, body: { error: 'owner' } });
    expect(await call(pageToken(NOW, '1', { repository_id: 'x' }), page)).toMatchObject({ status: 403, body: { error: 'owner' } });
    expect(await call(pageToken(NOW, '99'), page)).toMatchObject({ status: 404, body: { error: 'not-registered' } });
    expect(await call(valid, page, [{ ...KANON, status: 'suspended' }])).toMatchObject({ status: 403, body: { error: 'suspended' } });
  });

  it('is decided after the verifier, so a token it refuses before check 7 never reaches the exception', async () => {
    const calls: string[] = [];
    const registrationOf = async (id: string) => { calls.push(id); return { ...KANON, status: 'active', repository_owner_id: OWNER, default_ref: DEFAULT_REF }; };
    expect(await pageReaderOf(token(NOW, '1'), registrationOf)).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await pageReaderOf(pageToken(NOW, '1'), registrationOf)).toMatchObject({ ok: true });
  });
});
