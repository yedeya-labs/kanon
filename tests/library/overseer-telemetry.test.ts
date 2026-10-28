import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LANES, SCHEMAS } from '../../infra/telemetry/function/schema.mjs';
import { report as cliReport } from '../../cli/metrics-report.mjs';
import {
  COLLECTOR_LANE, FILES, JOB_TIMEOUT_MINUTES, MAX_PAGES, QUERY_TIMEOUT_MS, REPORT_BY_MS, REPORT_FALLBACK_MS, REPORT_MONTHS, STARTED_FILE, STATUSES, VIEW_FIELDS, WINDOW_DAYS,
  RefusedError, consentOf, deadlineOf, headline, itemOf, merge, overseerStore, read, readPartition, refusalWords, reportStep, rowOf,
} from '../../scripts/overseer-telemetry.mjs';
import { HOSTED_INGEST_URL } from '../../scripts/lib/telemetry-token.mjs';
import { UNTIL, ago, itemRow, risingRows, runRow } from '../unit/helpers/metrics-rows.js';
import { SPAWNS } from '../unit/helpers/spawns.js';
import { HOSTED_URL, RUNNER_ENV, SELF_AUDIENCE, SELF_URL, TOKEN, tokenNet, type StoreCall } from '../unit/helpers/token-net.js';

/**
 * kanon#470 (the Owner's decision, option A): the Overseer's own cost view. The lane's
 * `telemetry` job reads this repository's own rows and hands the agent `token-trend.md` and
 * `cache-ttl.md`, never rows; the agent's job adds them to the export and writes the read's status
 * into the manifest, which the prompt reports and never reads as an absent store.
 *
 * Plan 0008 §3.5, step J5: both reads go through the store's `GET /v1/rows/self`, with a fresh
 * GitHub OIDC token per request, and only for a repository that sends telemetry. The store never
 * returns the key, so nothing here has one to hide.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/overseer-telemetry.mjs', import.meta.url));
const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows', import.meta.url));
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const quiet = () => {};

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'overseer-telemetry-')); dirs.push(d); return d; };

type Row = Record<string, unknown>;
/** A run row of the cost view, as the endpoint answers it: `recorded_at` in place of the sort key. */
const viewRow = (daysAgo: number, cost: number, extra: Row = {}): Row => ({
  recorded_at: new Date(NOW - daysAgo * 86_400_000).toISOString(), tag: 'run', outcome: 'ok', total_cost_usd: cost, changed_lines: 300,
  cache_write_tokens: 100, cache_write_1h_tokens: 100, ...extra,
});

/**
 * The store's own-rows endpoint, as the function answers it (plan 0008 §3.2): one partition a
 * request by `lane`, `tag=run` unless asked, `recorded_at` within `from`, projected to `fields`,
 * `pageSize` rows a page with an opaque cursor. `refuse` answers a status and code for a lane.
 */
function selfStore(byLane: (lane: string) => Row[], { pageSize = 1000, refuse = () => null as null | { status: number; json?: unknown } }: { pageSize?: number; refuse?: (lane: string, call: StoreCall) => null | { status: number; json?: unknown } } = {}) {
  return tokenNet((call) => {
    const lane = call.query.lane!;
    const r = refuse(lane, call);
    if (r) return r;
    if (call.path !== '/v1/rows/self' || call.method !== 'GET') return { status: 404, json: { error: 'path' } };
    const all = byLane(lane).filter((x) => (x.tag ?? 'run') === (call.query.tag ?? 'run'))
      .filter((x) => call.query.from === undefined || String(x.recorded_at) >= call.query.from);
    const at = Number(call.query.cursor?.replace(/^c/, '') ?? 0);
    const page = all.slice(at, at + pageSize).map((x) => (call.query.fields ? Object.fromEntries(call.query.fields.split(',').filter((f) => f in x).map((f) => [f, x[f]])) : x));
    return { status: 200, json: { rows: page, ...(at + pageSize < all.length ? { cursor: `c${at + pageSize}` } : {}) } };
  });
}
const io = (net: ReturnType<typeof tokenNet>, extra: Record<string, unknown> = {}) => ({ env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: quiet, hostedUrl: HOSTED_URL, ...extra });

describe('which store (plan 0008 §2.1)', () => {
  it('reads the hosted store, unpublished until the operator publishes its URL, or a self-hosted one by its two variables together', () => {
    expect(overseerStore({}, '')).toMatchObject({ ok: false, unpublished: true });
    if (!HOSTED_INGEST_URL) expect(overseerStore({})).toMatchObject({ ok: false, unpublished: true });
    else expect(overseerStore({})).toEqual({ ok: true, url: HOSTED_INGEST_URL, audience: 'kanon-telemetry', hosted: true });
    expect(overseerStore({}, HOSTED_URL)).toEqual({ ok: true, url: HOSTED_URL, audience: 'kanon-telemetry', hosted: true });
    expect(overseerStore({ KANON_TELEMETRY_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }, HOSTED_URL)).toEqual({ ok: true, url: SELF_URL, audience: SELF_AUDIENCE, hosted: false });
    expect(overseerStore({ KANON_TELEMETRY_TOKEN_URL: SELF_URL }, HOSTED_URL)).toMatchObject({ ok: false, why: expect.stringMatching(/name a self-hosted store together/) });
    expect(overseerStore({ KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }, HOSTED_URL)).toMatchObject({ ok: false });
    expect(overseerStore({ KANON_TELEMETRY_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: 'kanon-telemetry' }, HOSTED_URL)).toMatchObject({ ok: false, why: expect.stringMatching(/only ever sent to the hosted store's URL/) });
    // The SigV4 variables a caller below vM still sets are not read at all: no fallback to them.
    expect(overseerStore({ KANON_TELEMETRY_URL: SELF_URL, KANON_TELEMETRY_TABLE: 'x', KANON_TELEMETRY_REGION: 'eu-central-1' }, HOSTED_URL)).toMatchObject({ ok: true, url: HOSTED_URL });
  });

  it('asks only for fields the run schema has, the reports\' own and the time each row was recorded', () => {
    const allowed = new Set(Object.values(SCHEMAS.run as Record<string, Record<string, unknown>>).flatMap((v) => Object.keys(v)));
    expect(VIEW_FIELDS.filter((f) => !allowed.has(f))).toEqual([]);
    expect(VIEW_FIELDS).toEqual(expect.arrayContaining(['recorded_at', 'tag', 'total_cost_usd', 'cache_write_1h_tokens']));
    expect(VIEW_FIELDS).not.toContain('sk');
  });

  it('turns an answered row into the item the reports read, with its sort key from recorded_at', () => {
    expect(itemOf({ recorded_at: '2026-10-01T10:20:30.123Z', lane: 'review', total_cost_usd: 1.25, is_error: false, odd: { x: 1 }, gone: null }))
      .toEqual({ recorded_at: { S: '2026-10-01T10:20:30.123Z' }, sk: { S: '20261001T102030Z' }, lane: { S: 'review' }, total_cost_usd: { N: '1.25' }, is_error: { BOOL: false } });
    expect(rowOf({ lane: 'review', total_cost_usd: 1.25, pr_number: 2, cache_1h: true, odd: [1], nan: Number.NaN })).toEqual({ lane: 'review', total_cost_usd: 1.25, pr_number: 2, cache_1h: true });
  });
});

describe('readPartition: one partition, every page, a fresh token per request', () => {
  const STORE = { ok: true as const, url: HOSTED_URL, audience: 'kanon-telemetry', hosted: true };
  it('follows the cursor to the last page, minting a token for each request', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => viewRow(1, i));
    const net = selfStore(() => rows, { pageSize: 2 });
    const masked: string[] = [];
    const got = await readPartition(STORE, { lane: 'review', from: '2026-09-23T12:00:00.000Z', fields: ['recorded_at', 'total_cost_usd'] }, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: (x) => masked.push(x) });
    expect(got.map((r) => r.total_cost_usd)).toEqual([0, 1, 2, 3, 4]);
    expect(net.calls.map((c) => c.query)).toEqual([
      { lane: 'review', from: '2026-09-23T12:00:00.000Z', fields: 'recorded_at,total_cost_usd' },
      { lane: 'review', from: '2026-09-23T12:00:00.000Z', fields: 'recorded_at,total_cost_usd', cursor: 'c2' },
      { lane: 'review', from: '2026-09-23T12:00:00.000Z', fields: 'recorded_at,total_cost_usd', cursor: 'c4' },
    ]);
    // A token of its own for each request, masked before it is sent, and sent as a bearer.
    expect(net.calls.map((c) => c.auth)).toEqual([`Bearer ${TOKEN}1`, `Bearer ${TOKEN}2`, `Bearer ${TOKEN}3`]);
    expect(masked).toEqual([`${TOKEN}1`, `${TOKEN}2`, `${TOKEN}3`]);
    expect(new Set(net.calls.map((c) => `${c.method} ${c.host}${c.path}`))).toEqual(new Set([`GET ${new URL(HOSTED_URL).host}/v1/rows/self`]));
  });

  it('stops at a cursor that never ends', async () => {
    const net = tokenNet(() => ({ status: 200, json: { rows: [], cursor: 'again' } }));
    await expect(readPartition(STORE, { lane: 'review' }, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: quiet })).rejects.toThrow(`more than ${MAX_PAGES} pages`);
    expect(net.calls).toHaveLength(MAX_PAGES);
  });

  it('refuses an answer with no list of rows, and names a store it couldn\'t reach without its URL', async () => {
    await expect(readPartition(STORE, { lane: 'review' }, { env: RUNNER_ENV, fetchImpl: tokenNet(() => ({ status: 200, json: { rows: 'x' } })).fetchImpl, mask: quiet })).rejects.toThrow('the store answered no list of rows');
    const down = tokenNet(() => { throw new TypeError('fetch failed'); });
    const e = await readPartition(STORE, { lane: 'review' }, { env: RUNNER_ENV, fetchImpl: down.fetchImpl, mask: quiet }).catch((x: Error) => x);
    expect((e as Error).message).toBe('the store could not be reached (TypeError)');
    expect((e as Error).message).not.toContain('hosted0123');
  });
});

describe('readPartition: the store\'s 503 jwks-unavailable is asked again, inside the deadline (#1440)', () => {
  const STORE = { ok: true as const, url: HOSTED_URL, audience: 'kanon-telemetry', hosted: true };
  const UNAVAILABLE = { status: 503, json: { error: 'jwks-unavailable' } };
  /** A clock the waits move, from `NOW`. */
  const clocked = () => {
    let at = NOW;
    const slept: number[] = [];
    return { slept, clock: () => at, sleep: async (ms: number) => { slept.push(ms); at += ms; } };
  };

  it('waits and asks the same page again, with a fresh token, and reads on', async () => {
    let refused = 1;
    const net = selfStore(() => [viewRow(1, 2), viewRow(2, 3)], { pageSize: 1, refuse: (_lane, call) => (call.query.cursor === 'c1' && refused-- > 0 ? UNAVAILABLE : null) });
    const t = clocked();
    const got = await readPartition(STORE, { lane: 'review' }, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: quiet, ...t });
    expect(got.map((r) => r.total_cost_usd)).toEqual([2, 3]);
    expect(net.calls.map((c) => c.query.cursor ?? null)).toEqual([null, 'c1', 'c1']);
    expect(new Set(net.calls.map((c) => c.auth)).size).toBe(3);
    expect(t.slept).toEqual([6_000]);
  });

  it('after its retries, refuses the read for every partition, in the store\'s code', async () => {
    const net = tokenNet(() => UNAVAILABLE);
    const t = clocked();
    const e = await readPartition(STORE, { lane: 'review' }, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: quiet, ...t }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(RefusedError);
    expect(e).toMatchObject({ status: 503, code: 'jwks-unavailable', message: 'the store answered 503 (jwks-unavailable)' });
    expect(refusalWords(e as RefusedError)).toMatch(/could not fetch GitHub's signing keys.*the next run reads again/);
    expect(net.calls).toHaveLength(3);
    expect(t.slept).toEqual([6_000, 61_000]);
  });

  it('begins no wait that would outlast the deadline', async () => {
    const net = tokenNet(() => UNAVAILABLE);
    const t = clocked();
    await expect(readPartition(STORE, { lane: 'review' }, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: quiet, ...t, deadline: NOW + 30_000 })).rejects.toBeInstanceOf(RefusedError);
    expect(t.slept).toEqual([6_000]);
    expect(net.calls).toHaveLength(2);
  });

  it('the read stops at it, asking no other partition, and writes nothing', async () => {
    const net = selfStore(() => [], { refuse: () => UNAVAILABLE });
    const r = await read({ ...io(net, clocked()), now: NOW, workflows: WORKFLOWS });
    expect(r).toMatchObject({ status: 'failed', files: {} });
    expect(r.lines).toEqual([expect.stringMatching(/^The telemetry read failed: the store answered 503 \(jwks-unavailable\): .*could not fetch GitHub's signing keys/)]);
    expect(new Set(net.calls.map((c) => c.query.lane))).toEqual(new Set([LANES[0]]));
  });

  it('the read rides out a refusal that passes, and reads every partition', async () => {
    let refused = 2;
    const net = selfStore(() => [viewRow(1, 2)], { refuse: () => (refused-- > 0 ? UNAVAILABLE : null) });
    const t = clocked();
    const r = await read({ ...io(net, t), now: NOW, workflows: WORKFLOWS });
    expect(r.status).toBe('ran');
    expect(r.lines[0]).toMatch(new RegExp(`^The telemetry read ran: ${LANES.length} of ${LANES.length} lane partitions read`));
    expect(t.slept).toEqual([6_000, 61_000]);
  });

  it('the headline report withholds itself when the work items stay refused, inside its deadline', async () => {
    const net = selfStore(() => [], { refuse: () => UNAVAILABLE });
    const t = clocked();
    const r = await headline({ ...io(net, t), now: NOW, deadline: NOW + REPORT_BY_MS });
    expect(r.status).toBe('failed');
    expect(r.lines).toEqual([expect.stringMatching(/^The headline report was not made: the `work` partition could not be read \(the store answered 503 \(jwks-unavailable\): .*\), and a report without it would be wrong\.$/)]);
    expect(t.clock()).toBeLessThan(NOW + REPORT_BY_MS);
  });
});

describe('the read', () => {
  it('reads each of Kanon\'s lanes over the window, projected, from the store it names', async () => {
    const net = selfStore(() => []);
    const r = await read({ ...io(net), now: NOW, workflows: WORKFLOWS });
    expect(r.status).toBe('ran');
    expect(net.calls.map((c) => c.query.lane)).toEqual([...LANES]);
    expect(new Set(net.calls.map((c) => c.query.from))).toEqual(new Set(['2026-09-23T12:00:00.000Z']));
    expect(new Set(net.calls.map((c) => c.query.fields))).toEqual(new Set([VIEW_FIELDS.join(',')]));
    expect(WINDOW_DAYS).toBe(14);
  });

  it('writes the two reports from the rows, and says only counts', async () => {
    const net = selfStore((lane) => (lane === 'review' ? [viewRow(1, 2), viewRow(2, 3), viewRow(9, 2), viewRow(10, 2), viewRow(20, 50)] : []));
    const r = await read({ ...io(net), now: NOW, workflows: WORKFLOWS });
    expect(r.status).toBe('ran');
    expect(Object.keys(r.files).sort()).toEqual([...FILES].sort());
    expect(r.files['token-trend.md']).toMatch(/^## Token efficiency — 7 days to 2026-10-07/);
    expect(r.files['token-trend.md']).toMatch(/\*\*\$5\.00 across 2 run\(s\)\*\*/);
    expect(r.files['cache-ttl.md']).toMatch(/^cache-ttl: 0 of 4 row\(s\) across \d+ lane partition\(s\) over the last 14 days/);
    expect(r.lines).toEqual([`The telemetry read ran: ${LANES.length} of ${LANES.length} lane partitions read, 4 row(s) over the last 14 days, summarised into token-trend.md and cache-ttl.md.`]);
  });

  it('names a partition it couldn\'t read in both reports, and still ran', async () => {
    const net = selfStore(() => [], { refuse: (lane) => (lane === 'implement' ? { status: 502, json: { error: 'read' } } : null) });
    const r = await read({ ...io(net), now: NOW, workflows: WORKFLOWS });
    expect(r.status).toBe('ran');
    expect(r.files['token-trend.md']).toMatch(/UNAVAILABLE:\*\* could not read `implement` \(the store answered 502 \(read\)\)/);
    expect(r.files['cache-ttl.md']).toMatch(/UNREADABLE \(implement\)/);
  });

  it('fails, writing nothing, when no partition can be read', async () => {
    const net = selfStore(() => [], { refuse: () => ({ status: 502, json: { error: 'read' } }) });
    const r = await read({ ...io(net), now: NOW, workflows: WORKFLOWS });
    expect(r).toMatchObject({ status: 'failed', files: {} });
    expect(r.lines[0]).toMatch(/none of the \d+ lane partitions could be read \(the store answered 502 \(read\)\)/);
  });

  it('stops at the first refusal, which holds for the whole registration, and says it in the store\'s code', async () => {
    const cases: Array<[number, string, string, RegExp]> = [
      [404, 'not-registered', 'not configured', /^The telemetry read found nothing to read: the store answered 404 \(not-registered\): this repository is not registered with the store yet/],
      [403, 'suspended', 'failed', /^The telemetry read failed: the store answered 403 \(suspended\): Kanon's operator has suspended/],
      [410, 'erased', 'failed', /\(erased\): this repository's telemetry was erased/],
      [403, 'ref', 'failed', /default branch only/],
      [403, 'workflow', 'failed', /check the caller's pin/],
      [429, 'quota', 'failed', /quota is spent/],
      [401, 'aud', 'failed', /^The telemetry read failed: the store answered 401 \(aud\)\.$/],
    ];
    for (const [status, code, want, says] of cases) {
      const net = selfStore(() => [], { refuse: () => ({ status, json: { error: code } }) });
      const r = await read({ ...io(net), now: NOW, workflows: WORKFLOWS });
      expect(r.status, code).toBe(want);
      expect(r.files).toEqual({});
      expect(r.lines[0], code).toMatch(says);
      expect(net.calls, code).toHaveLength(1);
    }
  });

  it('reads nothing, minting no token, while the hosted URL is unpublished or the variables are wrong', async () => {
    const net = selfStore(() => []);
    const unpublished = await read({ ...io(net, { hostedUrl: '' }), now: NOW, workflows: WORKFLOWS });
    expect(unpublished).toMatchObject({ status: 'not configured', files: {} });
    expect(unpublished.lines[0]).toMatch(/^The telemetry read did not run: the hosted store's URL is not published/);
    const alone = await read({ ...io(net, { env: { ...RUNNER_ENV, KANON_TELEMETRY_TOKEN_URL: SELF_URL } }), now: NOW, workflows: WORKFLOWS });
    expect(alone).toMatchObject({ status: 'failed', files: {} });
    expect(alone.lines[0]).toMatch(/KANON_TELEMETRY_TOKEN_URL variable` and `the KANON_TELEMETRY_AUDIENCE variable` name a self-hosted store together/);
    expect(net.minted).toEqual([]);
    expect(net.calls).toEqual([]);
  });

  it('masks a self-hosted store\'s URL before its first request, and never the hosted one', async () => {
    const masked: string[] = [];
    const net = selfStore(() => []);
    await read({ ...io(net, { env: { ...RUNNER_ENV, KANON_TELEMETRY_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }, mask: (x: string) => masked.push(x) }), now: NOW, workflows: WORKFLOWS });
    expect(masked[0]).toBe(SELF_URL);
    expect(net.calls.every((c) => c.url.startsWith(SELF_URL))).toBe(true);
    const hosted: string[] = [];
    await read({ ...io(selfStore(() => []), { mask: (x: string) => hosted.push(x) }), now: NOW, workflows: WORKFLOWS });
    expect(hosted).not.toContain(HOSTED_URL);
  });

  it('fails when the job holds no OIDC token, naming why', async () => {
    const r = await read({ ...io(selfStore(() => []), { env: {} }), now: NOW, workflows: WORKFLOWS });
    expect(r.status).toBe('failed');
    expect(r.lines[0]).toMatch(/the job holds no OIDC token: it needs `id-token: write`/);
  });
});

/**
 * kanon#668 (plan 0003 §6.4, option A): the Overseer's weekly job runs `kanon metrics report` over
 * this repository's own work-item and run partitions, the store's whole thirteen months, and writes
 * the Markdown to the job summary. The rows never leave the job: only the report's figures do.
 */
describe('the headline report (kanon#668)', () => {
  const rows: Row[] = [
    ...risingRows({ S: 12, M: 12, L: 12, XL: 12 }),
    itemRow(900, { closed: ago(3), fate: 'closed_unmerged', band: 'M' }),
    runRow('implement', { pr: 900, at: ago(4), cost: 2 }),
    runRow('explore', { at: ago(2), cost: 1.5 }),
    runRow('implement', { pr: 1, at: ago(2), cost: 99, tag: 'smoke' }),
  ];
  const partitionOf = (r: Row) => (r.row_kind === 'work_item' ? 'work' : String(r.lane));
  const byLane = (lane: string) => rows.filter((r) => partitionOf(r) === lane);
  const NOW_MS = UNTIL.getTime();
  /** What `kanon metrics report` prints for the same rows, the same day. */
  const cli = (input: unknown[]) => {
    const out: string[] = [];
    const code = cliReport(['--rows', 'rows.json'], { out: (l) => out.push(l), err: (l) => out.push(l), readFile: () => JSON.stringify(input), release: () => 'test', now: () => UNTIL });
    expect(code).toBe(0);
    return out.join('\n');
  };

  it('reads the work-item partition whole and every lane\'s over thirteen months, every field', async () => {
    const net = selfStore(byLane);
    const r = await headline({ ...io(net), now: NOW_MS });
    expect(r.status).toBe('ran');
    expect(REPORT_MONTHS).toBe(13);
    expect(net.calls.map((c) => c.query.lane)).toEqual(['work', ...LANES]);
    // A work item's sort key is its PR number, not a time: the partition is read whole.
    expect(net.calls[0]!.query.from).toBeUndefined();
    expect(new Set(net.calls.slice(1).map((c) => c.query.from))).toEqual(new Set(['2025-09-10T00:00:00.000Z']));
    expect(net.calls.every((c) => c.query.fields === undefined)).toBe(true);
  });

  it('is `kanon metrics report`\'s Markdown for the same rows, and says only counts', async () => {
    const r = await headline({ ...io(selfStore(byLane)), now: NOW_MS });
    expect(r.status).toBe('ran');
    // The store answers `tag: run` rows unless asked: the smoke row never reaches the report.
    const run = rows.filter((x) => (x.tag ?? 'run') === 'run');
    expect(r.markdown).toBe(`${cli(run)}\n`);
    expect(r.markdown).toMatch(/^## Kanon metrics, /);
    // The fixture is big enough for numbers, so the comparison isn't of two empty reports.
    expect(r.markdown).toMatch(/\| Cost per merged item, median \| \$\d/);
    const runs = run.filter((x) => x.row_kind === 'run').length;
    expect(r.lines).toEqual([`The headline report ran: ${LANES.length + 1} partitions read, 49 work item(s) and ${runs} run row(s) over the last 13 months, written to the job summary.`]);
  });

  // J5's check: the report withholds itself when one partition's read is refused, as it does today.
  it('withholds the report when any partition\'s read is refused or fails, naming it', async () => {
    for (const lane of ['work', 'implement']) {
      for (const [status, code, says] of [[403, 'suspended', "the store answered 403 (suspended): Kanon's operator has suspended this repository's registration"], [502, 'read', 'the store answered 502 (read)']] as const) {
        const net = selfStore(byLane, { refuse: (l) => (l === lane ? { status, json: { error: code } } : null) });
        const r = await headline({ ...io(net), now: NOW_MS });
        expect(r, `${lane} ${code}`).toMatchObject({ status: 'failed', markdown: '' });
        expect(r.lines, `${lane} ${code}`).toEqual([`The headline report was not made: the \`${lane}\` partition could not be read (${says}), and a report without it would be wrong.`]);
        // Nothing after the refused partition is asked.
        expect(net.calls.at(-1)!.query.lane).toBe(lane);
      }
    }
  });

  it('reads nothing while the hosted URL is unpublished or the variables are wrong', async () => {
    const net = selfStore(byLane);
    for (const extra of [{ hostedUrl: '' }, { env: { ...RUNNER_ENV, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE } }]) {
      const r = await headline({ ...io(net, extra), now: NOW_MS });
      expect(r).toMatchObject({ status: 'failed', markdown: '' });
      expect(r.lines[0]).toMatch(/^The headline report was not made: /);
    }
    expect(net.minted).toEqual([]);
  });
});

/**
 * kanon#682: the report step never fails the job. It holds a deadline of its own inside the job's
 * timeout, so no slow store holds the job past it, and a throw anywhere in it is a warning.
 */
describe('the report step never fails the job (kanon#682)', () => {
  const NOW_MS = UNTIL.getTime();
  /** A store that takes `ms` of the fake clock per request. */
  const slow = (ms: number) => {
    let t = NOW_MS;
    const clock = () => t;
    const net = tokenNet(() => { t += ms; return { status: 200, json: { rows: [] } }; });
    return { clock, net };
  };

  it('keeps its deadline inside the job\'s timeout, the workflow\'s own', () => {
    const wf = parse(readFileSync(join(WORKFLOWS, 'agent-overseer.yml'), 'utf8')) as { jobs: { telemetry: { 'timeout-minutes': number } } };
    expect(wf.jobs.telemetry['timeout-minutes']).toBe(JOB_TIMEOUT_MINUTES);
    expect(REPORT_BY_MS).toBeLessThan(JOB_TIMEOUT_MINUTES * 60_000);
    expect(REPORT_FALLBACK_MS).toBeLessThan(REPORT_BY_MS);
  });

  it('counts its deadline from the job\'s stamped start, or from its own start when the stamp is missing or stale', () => {
    const at = NOW_MS;
    expect(deadlineOf(`${at - 60_000}\n`, at)).toBe(at - 60_000 + REPORT_BY_MS);
    expect(deadlineOf(String(at), at)).toBe(at + REPORT_BY_MS);
    for (const stamp of [undefined, '', 'soon', String(at + 1), String(at - JOB_TIMEOUT_MINUTES * 60_000), String(at - 86_400_000)]) {
      expect(deadlineOf(stamp, at), String(stamp)).toBe(at + REPORT_FALLBACK_MS);
    }
  });

  it('starts no partition after its deadline, and withholds the report, naming the partition', async () => {
    const { clock, net } = slow(60_000);
    const r = await headline({ ...io(net), now: NOW_MS, clock, deadline: NOW_MS + 5 * 60_000 });
    expect(r).toMatchObject({ status: 'failed', markdown: '' });
    // Five requests of a minute each use the five minutes; the sixth partition is never started.
    expect(net.calls).toHaveLength(5);
    expect(r.lines).toEqual([`The headline report was not made: its time ran out before the \`${LANES[4]}\` partition was read (the step keeps inside the job's ${JOB_TIMEOUT_MINUTES}-minute timeout), and a report without it would be wrong.`]);
  });

  it('gives no request longer than what is left of its deadline, and aborts one that outlives it', async () => {
    // A store that never answers: only the request's own signal ends it.
    const hung = tokenNet(() => new Promise(() => {}));
    const fetchImpl = (async (url: string, init: { signal?: AbortSignal } = {}) => {
      if (url.includes('runner.example')) return hung.fetchImpl(url as never, init as never);
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as unknown as typeof fetch;
    let t = NOW_MS;
    const began = Date.now();
    const r = await headline({ env: RUNNER_ENV, fetchImpl, mask: quiet, hostedUrl: HOSTED_URL, now: NOW_MS, clock: () => { t = NOW_MS + (Date.now() - began); return t; }, deadline: NOW_MS + 300 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(r.lines).toEqual([expect.stringMatching(/^The headline report was not made: its time ran out while the `work` partition was read/)]);
    expect(QUERY_TIMEOUT_MS).toBe(120_000);
  });

  it('a step out of time warns, writes no report, and returns', async () => {
    const { clock, net } = slow(60_000);
    const log: string[] = [];
    const summary: string[] = [];
    await reportStep({ GITHUB_STEP_SUMMARY: 'summary', ...RUNNER_ENV }, { fetchImpl: net.fetchImpl, mask: quiet, hostedUrl: HOSTED_URL, now: NOW_MS, clock, stamp: () => String(NOW_MS - REPORT_BY_MS + 90_000), append: (_p, t) => { summary.push(t); }, log: (l) => { log.push(l); } });
    expect(log).toEqual([expect.stringMatching(/^::warning title=overseer metrics::The headline report was not made: its time ran out before the `\S+` partition was read/)]);
    expect(summary.join('')).not.toContain('## Kanon metrics');
    expect(summary.join('')).toMatch(/^The headline report was not made: its time ran out/);
  });

  it('writes the report to the summary, and only counts to the log', async () => {
    const log: string[] = [];
    const summary: string[] = [];
    await reportStep({ GITHUB_STEP_SUMMARY: 'summary', ...RUNNER_ENV }, { fetchImpl: selfStore(() => []).fetchImpl, mask: quiet, hostedUrl: HOSTED_URL, now: NOW_MS, append: (_p, t) => { summary.push(t); }, log: (l) => { log.push(l); } });
    expect(summary[0]).toMatch(/^## Kanon metrics, /);
    expect(log).toEqual([expect.stringMatching(/^The headline report ran: \d+ partitions read/)]);
  });

  it('a throw from the summary\'s write warns, and returns', async () => {
    const log: string[] = [];
    const append = () => { throw Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' }); };
    const opts = { fetchImpl: selfStore(() => []).fetchImpl, mask: quiet, hostedUrl: HOSTED_URL, now: NOW_MS, append };
    await expect(reportStep({ GITHUB_STEP_SUMMARY: 'summary', ...RUNNER_ENV }, { ...opts, log: (l) => { log.push(l); } })).resolves.toBeUndefined();
    expect(log).toEqual(['::warning title=overseer metrics::The headline report stopped on an error (Error); the job is not failed for it.']);
    // Even a log that throws doesn't throw out of the step.
    await expect(reportStep({ GITHUB_STEP_SUMMARY: 'summary', ...RUNNER_ENV }, { ...opts, log: () => { throw new Error('EPIPE'); } })).resolves.toBeUndefined();
  });
});

/**
 * ADR 0007, plan 0008 §3.3: the collector's caller is the repository's consent. The gate reads the
 * default branch's workflows and lets the read run only when one calls Kanon's collector, so a
 * repository that didn't opt in never mints a token for the store.
 */
describe('the gate: does this repository send telemetry?', () => {
  const caller = (pin = 'v0.41.0') => `name: Telemetry\non:\n  schedule:\n    - cron: "17 * * * *"\n  workflow_dispatch:\npermissions:\n  actions: read\n  id-token: write\njobs:\n  collect:\n    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@${pin}\n`;
  const lane = 'name: Overseer\non:\n  schedule:\n    - cron: "0 7 * * 1"\njobs:\n  oversee:\n    uses: yedeya-labs/kanon/.github/workflows/agent-overseer.yml@v0.41.0\n';
  const snapshot = (files: Record<string, string>) => () => ({ data: { repository: { workflows: { entries: Object.entries(files).map(([name, text]) => ({ name, type: 'blob', object: { text } })) }, record: null } } });
  const ENV = { GITHUB_REPOSITORY: 'acme/widgets' };

  it('reads true when a workflow on the default branch calls Kanon\'s collector, whatever its name', () => {
    expect(COLLECTOR_LANE).toBe('telemetry-collect');
    expect(consentOf(ENV, { json: snapshot({ 'telemetry.yml': caller(), 'overseer.yml': lane }), hostedUrl: HOSTED_URL }))
      .toEqual({ reader: 'true', line: "This repository sends telemetry (telemetry.yml calls Kanon's collector), so the lane reads its own rows." });
    expect(consentOf(ENV, { json: snapshot({ 'send-rows.yml': caller(), 'overseer.yml': lane }), hostedUrl: HOSTED_URL }).reader).toBe('true');
  });

  // #852's review (`K-OBS-18`; the Owner's decision on #842): a collector that names a store of its
  // own is no consent to the hosted store, so the lane refuses, naming the variables, and never
  // mints a token for the hosted audience on its behalf.
  it('reads unknown, never true, when the collector\'s caller names a store of its own and the two variables are unset', () => {
    const own = (w: string) => caller().replace('@v0.41.0\n', `@v0.41.0\n    with:\n${w}`);
    expect(consentOf(ENV, { json: snapshot({ 'telemetry.yml': own('      url: https://x\n      audience: acme\n'), 'overseer.yml': lane }), hostedUrl: HOSTED_URL }))
      .toEqual({ reader: 'unknown', line: expect.stringMatching(/^The telemetry read can't run: telemetry\.yml sends this repository's rows to a store of its own .* set the repository variables KANON_TELEMETRY_TOKEN_URL and KANON_TELEMETRY_AUDIENCE/) });
    // A caller written before vM, a hosted adopter's included: its store can't be told, so both
    // ways out, and never the claim that it is self-hosted (#852's third review).
    const legacy = consentOf(ENV, { json: snapshot({ 'telemetry.yml': own('      url: ${{ vars.KANON_TELEMETRY_URL }}\n      writer-role: ${{ vars.KANON_TELEMETRY_WRITER_ROLE }}\n'), 'overseer.yml': lane }), hostedUrl: HOSTED_URL });
    expect(legacy.reader).toBe('unknown');
    expect(legacy.line).toMatch(/^The telemetry read can't run: telemetry\.yml still passes `url:` and `writer-role:` to Kanon's collector without `audience:`.*write the new caller with `kanon init --telemetry`.*add `audience:` to the caller and set the repository variables KANON_TELEMETRY_TOKEN_URL and KANON_TELEMETRY_AUDIENCE/);
    expect(legacy.line).not.toContain('store of its own');
    // Nested in a local reusable workflow, the call's `with:` is still read.
    const outer = 'name: T\non:\n  schedule:\n    - cron: "1 * * * *"\njobs:\n  t:\n    uses: ./.github/workflows/inner.yml\n';
    const inner = 'name: Inner\non: workflow_call\njobs:\n  collect:\n    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v0.41.0\n    with:\n      audience: acme\n';
    expect(consentOf(ENV, { json: snapshot({ 't.yml': outer, 'inner.yml': inner }), hostedUrl: HOSTED_URL }).reader).toBe('unknown');
    // Its own two variables set, the same repository reads its own store.
    expect(consentOf({ ...ENV, KANON_TELEMETRY_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }, { json: snapshot({ 'telemetry.yml': own('      url: https://x\n      audience: acme\n') }), hostedUrl: HOSTED_URL }).reader).toBe('true');
    // The two dispatch inputs name no store.
    expect(consentOf(ENV, { json: snapshot({ 'telemetry.yml': own('      erase: no\n      register: no\n') }), hostedUrl: HOSTED_URL }).reader).toBe('true');
  });

  it('reads false when none does: the repository didn\'t opt in', () => {
    const r = consentOf(ENV, { json: snapshot({ 'overseer.yml': lane }), hostedUrl: HOSTED_URL });
    expect(r).toEqual({ reader: 'false', line: expect.stringMatching(/no workflow on the default branch calls Kanon's telemetry collector/) });
    // A collector caller only in a comment, or one calling another workflow, is not consent.
    expect(consentOf(ENV, { json: snapshot({ 'overseer.yml': `# uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v1\n${lane}` }), hostedUrl: HOSTED_URL }).reader).toBe('false');
  });

  it('reads false while the hosted URL is unpublished, and unknown on a wrong pair or an unreadable branch, before reading anything it needn\'t', () => {
    let reads = 0;
    const json = () => { reads += 1; return snapshot({ 'telemetry.yml': caller() })(); };
    expect(consentOf(ENV, { json, hostedUrl: '' })).toMatchObject({ reader: 'false', line: expect.stringMatching(/not published/) });
    expect(consentOf({ ...ENV, KANON_TELEMETRY_TOKEN_URL: SELF_URL }, { json, hostedUrl: HOSTED_URL })).toMatchObject({ reader: 'unknown', line: expect.stringMatching(/name a self-hosted store together/) });
    expect(reads).toBe(0);
    expect(consentOf({ ...ENV, KANON_TELEMETRY_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }, { json, hostedUrl: '' }).reader).toBe('true');
    const broken = () => { throw new Error('HTTP 502\nmore'); };
    expect(consentOf(ENV, { json: broken, hostedUrl: HOSTED_URL })).toEqual({ reader: 'unknown', line: "The telemetry read can't run: whether this repository sends telemetry could not be read (HTTP 502)." });
  });
});

describe('the merge into the export', () => {
  const exportDir = (manifest: Record<string, unknown> | null, files: Record<string, string> = {}) => {
    const root = temp();
    const dir = join(root, 'qa-store-export');
    mkdirSync(dir);
    if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    return dir;
  };
  const telemetry = (files: string[] = [...FILES]) => {
    const dir = temp();
    for (const f of files) writeFileSync(join(dir, f), `kanon ${f}\n`);
    return dir;
  };
  const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const PRESENT = { store: 'present', kind: 'overseer', files: ['areas.json'], reports: 0 };

  it('adds the read\'s files and says it ran, replacing a hook\'s own', () => {
    const dir = exportDir(PRESENT, { 'areas.json': '[]', 'token-trend.md': 'hook\n' });
    expect(merge({ TELEMETRY_STATUS: 'ran', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir })).toEqual({ status: 'ran', line: "Telemetry read: ran; token-trend.md and cache-ttl.md are from this repository's own rows." });
    expect(readFileSync(join(dir, 'token-trend.md'), 'utf8')).toBe('kanon token-trend.md\n');
    expect(manifestOf(dir)).toEqual({ ...PRESENT, telemetry: 'ran', files: ['areas.json', 'cache-ttl.md', 'token-trend.md'] });
  });

  it('passes a hook\'s own files on when the read didn\'t run, and says so', () => {
    const dir = exportDir(PRESENT, { 'areas.json': '[]', 'token-trend.md': 'hook\n', 'cache-ttl.md': 'hook\n' });
    const r = merge({ TELEMETRY_STATUS: 'not configured', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir });
    expect(r).toEqual({ status: 'not configured', line: "Telemetry read: not configured. The store hook's own files are passed on." });
    expect(readFileSync(join(dir, 'token-trend.md'), 'utf8')).toBe('hook\n');
    expect(manifestOf(dir)).toMatchObject({ store: 'present', telemetry: 'not configured', files: ['areas.json', 'cache-ttl.md', 'token-trend.md'] });
  });

  it('keeps the store\'s own state: an absent store with a read that ran is still an absent store', () => {
    const dir = exportDir({ store: 'absent', kind: 'overseer', files: [], reports: 0 });
    merge({ TELEMETRY_STATUS: 'ran', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir });
    expect(manifestOf(dir)).toEqual({ store: 'absent', kind: 'overseer', files: ['cache-ttl.md', 'token-trend.md'], reports: 0, telemetry: 'ran' });
  });

  it('calls a read that ran but left no files `failed`, and any other status too', () => {
    const missing = exportDir(PRESENT);
    expect(merge({ TELEMETRY_STATUS: 'ran', TELEMETRY_DIR: telemetry(['token-trend.md']), EXPORT_DIR: missing }).status).toBe('failed');
    expect(readdirSync(missing)).toEqual(['manifest.json']);
    expect(manifestOf(missing).telemetry).toBe('failed');
    for (const odd of ['', 'yes', undefined]) expect(merge({ TELEMETRY_STATUS: odd, EXPORT_DIR: exportDir(PRESENT) }).status).toBe('failed');
    expect(STATUSES).toEqual(['ran', 'not configured', 'not run on this trigger', 'failed']);
  });

  // kanon#499: on the runtime-version trigger the read isn't tried, and the manifest says so.
  it('records `not run on this trigger` as it is, passing a hook\'s own files on', () => {
    const dir = exportDir(PRESENT, { 'areas.json': '[]', 'cache-ttl.md': 'hook\n' });
    expect(merge({ TELEMETRY_STATUS: 'not run on this trigger', TELEMETRY_DIR: telemetry(), EXPORT_DIR: dir })).toEqual({ status: 'not run on this trigger', line: "Telemetry read: not run on this trigger. The store hook's own files are passed on." });
    expect(readFileSync(join(dir, 'cache-ttl.md'), 'utf8')).toBe('hook\n');
    expect(manifestOf(dir)).toMatchObject({ telemetry: 'not run on this trigger', files: ['areas.json', 'cache-ttl.md'] });
  });

  it('writes a manifest even when the export\'s is unreadable, saying so', () => {
    const dir = exportDir(null);
    merge({ TELEMETRY_STATUS: 'not configured', EXPORT_DIR: dir });
    expect(manifestOf(dir)).toEqual({ store: 'unreadable', telemetry: 'not configured', files: [] });
  });
});

// Its cases run the script in `node`, so the block takes the spawn budget (#436). None reaches a
// network: an unpublished hosted URL is read before any request, and the hosted store or a
// self-hosted one is refused before any request when the job holds no OIDC token.
describe('the script, as the lane runs it', SPAWNS, () => {
  const run = (mode: string, env: Record<string, string>) => spawnSync(process.execPath, [SCRIPT, mode], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 20_000 });
  const SELF = { KANON_TELEMETRY_TOKEN_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE };

  it('read: stamps the job\'s start outside the uploaded directory, and outputs its status', () => {
    const runnerTemp = temp();
    const out = join(temp(), 'out');
    const outputs = join(temp(), 'outputs');
    const before = Date.now();
    const r = run('read', { OUT: out, GITHUB_OUTPUT: outputs, RUNNER_TEMP: runnerTemp });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(runnerTemp)).toEqual([STARTED_FILE]);
    const started = Number(readFileSync(join(runnerTemp, STARTED_FILE), 'utf8'));
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(Date.now());
    expect(existsSync(out)).toBe(false);
    if (!HOSTED_INGEST_URL) {
      expect(readFileSync(outputs, 'utf8')).toBe('status=not configured\n');
      expect(r.stdout).toMatch(/The telemetry read did not run: the hosted store's URL is not published/);
      expect(r.stdout).not.toContain('::warning');
    } else {
      // Published, the hosted store is read: with no OIDC token in this job, the read fails before
      // any request, as the next case's self-hosted one does.
      expect(readFileSync(outputs, 'utf8')).toBe('status=failed\n');
      expect(r.stdout).toMatch(/::warning title=overseer telemetry::The telemetry read failed: .*the job holds no OIDC token/);
    }
  });

  it('read: a job with no OIDC token outputs `failed`, writes nothing, warns, and exits 0', () => {
    const out = join(temp(), 'out');
    const outputs = join(temp(), 'outputs');
    const r = run('read', { ...SELF, OUT: out, GITHUB_OUTPUT: outputs });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('status=failed\n');
    expect(existsSync(out)).toBe(false);
    expect(r.stdout).toMatch(/::warning title=overseer telemetry::The telemetry read failed: none of the \d+ lane partitions could be read \(the job holds no OIDC token/);
    // The self-hosted URL is masked before anything else prints.
    expect(r.stdout.split('\n')[0]).toBe(`::add-mask::${SELF_URL}`);
  });

  it('read: one variable without the other outputs `failed`, before any token', () => {
    const outputs = join(temp(), 'outputs');
    const r = run('read', { KANON_TELEMETRY_TOKEN_URL: SELF_URL, ...RUNNER_ENV, OUT: join(temp(), 'out'), GITHUB_OUTPUT: outputs });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('status=failed\n');
    expect(r.stdout).toMatch(/::warning title=overseer telemetry::The telemetry read did not run: `the KANON_TELEMETRY_TOKEN_URL variable` and `the KANON_TELEMETRY_AUDIENCE variable` name a self-hosted store together/);
  });

  it('report: a report it can\'t make warns, says so in the summary, and exits 0', () => {
    const summary = join(temp(), 'summary');
    const r = run('report', { ...SELF, GITHUB_STEP_SUMMARY: summary });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/::warning title=overseer metrics::The headline report was not made: the `work` partition could not be read \(the job holds no OIDC token/);
    expect(readFileSync(summary, 'utf8')).toMatch(/^The headline report was not made/);
    expect(readFileSync(summary, 'utf8')).not.toContain('## Kanon metrics');
  });

  it('consent: one variable without the other is `unknown`, said as a warning, before reading the branch', () => {
    const outputs = join(temp(), 'outputs');
    const r = run('consent', { KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE, GITHUB_OUTPUT: outputs, GITHUB_REPOSITORY: 'acme/widgets' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('reader=unknown\n');
    expect(r.stdout).toMatch(/^::warning title=overseer telemetry::The telemetry read can't run: /);
  });

  it('refuses an unknown mode, and the old ones', () => {
    for (const mode of ['dump', 'mask']) expect(run(mode, {}).status, mode).toBe(2);
  });
});
