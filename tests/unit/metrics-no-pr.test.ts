import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderPage } from '../../.github/scripts/metrics-page.mjs';
import { runBoth } from '../../actions/agent-telemetry/agent-telemetry.mjs';
import { handle } from '../../infra/telemetry/function/aggregate.mjs';
import { stamp, toAttributes } from '../../infra/telemetry/function/index.mjs';
import { readAggregate } from '../../scripts/aggregate-read.mjs';
import { IDLE_DAYS } from '../../scripts/metrics/indicators.mjs';

/**
 * Kanon#703: a delivery run that bails before opening a pull request (a split, a refusal, a run
 * that finds nothing to do) reaches yield's "no PR" column on the public page, through the path
 * the page itself takes. The row is built by the telemetry step (`runBoth`), stored as the ingest
 * function stores it (`stamp`, `toAttributes`), read back by the aggregate function's page view
 * (`handle`, `?view=page`), checked by `scripts/aggregate-read.mjs page` (`readAggregate`), and
 * rendered by `.github/scripts/metrics-page.mjs` (`renderPage`).
 *
 * The page's first window (2026-09-14 to 2026-10-12) read "not enough data (0)" there. That is
 * the idle rule (§2.3), not a lost row: a group of runs that joins no item settles `IDLE_DAYS`
 * after its last run, and Kanon's own run rows begin on 2026-09-29, so none had settled by then.
 */

const KEY = 'alpha';
const ACCOUNT = '5'.repeat(12);
const URL = 'https://abc.lambda-url.eu-central-1.on.aws/';
const COMMIT = 'a'.repeat(40);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const dir = mkdtempSync(join(tmpdir(), 'metrics-no-pr-'));
/** A run that finished cleanly and opened nothing: the shape of a bail. */
const EXECUTION = join(dir, 'bailed.json');
writeFileSync(EXECUTION, [
  { type: 'system', subtype: 'init', model: 'claude-opus-5' },
  {
    type: 'result', is_error: false, terminal_reason: 'completed', num_turns: 10, duration_ms: 60_000, total_cost_usd: 0.33,
    usage: { input_tokens: 5, output_tokens: 50 }, modelUsage: { 'claude-opus-5': { canonicalModel: 'claude-opus-5', costUSD: 0.33 } },
  },
].map((o) => JSON.stringify(o)).join('\n'));

/** One bailed implement run on `issue`, as the telemetry step builds it, stored as the ingest function stores it. */
function bailed(issue: number, at: number, runId: number) {
  const recorded = new Date(at).toISOString();
  const { v2, errors } = runBoth({ agent: 'implementer', execution_file: EXECUTION }, {
    TELEMETRY_NOW: recorded, GITHUB_RUN_ID: String(runId), GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'issues',
    GITHUB_WORKFLOW: 'Implement', GITHUB_JOB: 'run', TELEMETRY_CLAUDE_ARGS: '--model claude-opus-5\n--max-turns 300',
    TELEMETRY_LANE: 'implement', TELEMETRY_KANON_REF: 'v0.38.0', TELEMETRY_JOB_STATUS: 'success',
    TELEMETRY_ISSUE_NUMBER: String(issue),
  });
  expect(errors).toEqual([]);
  const s = stamp(v2, { caller: { kind: 'writer', key: KEY }, key: KEY, now: at + HOUR });
  if (!s.ok) throw new Error(`the row did not store: ${JSON.stringify(s.errors)}`);
  return s.item as Record<string, unknown>;
}

/** Twenty issues, each with a first attempt and a re-dispatch a day later, none of which opened a PR. */
const ISSUES = Array.from({ length: 20 }, (_, k) => 1001 + k);
const bails = (from: string) => ISSUES.flatMap((issue, k) => [
  bailed(issue, Date.parse(from) + k * 60_000, 40_000 + k),
  bailed(issue, Date.parse(from) + DAY + k * 60_000, 50_000 + k),
]);

/** A table answering Query pages in DynamoDB's attribute values, honouring the key, the filter and the projection. */
const table = (stored: Record<string, unknown>[]) => async (req: J) => {
  const pk = req.ExpressionAttributeValues[':p'].S as string;
  const wanted = Object.values(req.ExpressionAttributeNames) as string[];
  const items = stored.filter((i) => i.pk === pk && i.tag === req.ExpressionAttributeValues[':run'].S);
  return { Items: items.map((i) => toAttributes(Object.fromEntries(Object.entries(i).filter(([k]) => wanted.includes(k))))) };
};

const HEALTH = {
  schema: 'kanon-health/v1', computed_at: '2026-10-12T07:15:00.000Z',
  disputes: { disputes: 1, unreadable: 0, rules: [{ rule: 'K-PRIN-14', open: 1, closed: 0 }] },
  fixes: { filed: 3, open: 1, fixed: 2, closed_unfixed: 0, unreleased: 0, no_fix_link: 0, to_close: { n: 2, median_days: 1.5, p90_days: 2 }, to_release: { n: 2, median_days: 3, p90_days: 4 } },
  upgrade_lag: null,
};

/** The page as the metrics-page workflow makes it: the function's page view, the reader's check, the generator. */
async function publish(stored: Record<string, unknown>[], now: string) {
  const env = { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT, AGGREGATE_KEYS: KEY, OWN_FIGURES: `${KEY}=kanon`, INVOKER_KEYS: KEY };
  const res = await handle({ queryStringParameters: { view: 'page' } }, { env, now: () => Date.parse(now), query: table(stored), log: () => {} });
  const fetchImpl = (async () => new Response(res.body, { status: res.statusCode })) as unknown as typeof fetch;
  const page = await readAggregate({ url: URL, env: { AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S' }, fetchImpl, view: 'page' });
  const html = renderPage({ page, health: HEALTH, release: '0.38.0', commit: COMMIT });
  const entry = page.own.find((o: J) => o.label === 'kanon');
  return { yield: entry.headline.yield, window: entry.window, html };
}

const noPrRow = (cell: string) => `<td>Yield, share of delivery spend merged</td><td>no PR</td><td>${cell}</td>`;

describe("a delivery run that bails before a pull request reaches yield's no PR column (kanon#703)", () => {
  it('the telemetry step records the bail with its issue, lane and cost, and no pull request', () => {
    const row = bailed(1001, Date.parse('2026-09-01T10:00:00Z'), 40_000);
    expect(row).toMatchObject({ pk: `${KEY}#implement`, row_kind: 'run', tag: 'run', lane: 'implement', issue_number: 1001, total_cost_usd: 0.33, outcome: 'ok' });
    expect(row).not.toHaveProperty('pr_number');
  });

  it('settled bails reach the page as one no PR unit per issue, through the page view, the reader and the generator', async () => {
    // Last runs on 2026-09-02, so each issue's group settles on 2026-10-02, inside the window.
    const p = await publish(bails('2026-09-01T10:00:00Z'), '2026-10-12T07:15:00Z');
    expect(p.window).toEqual({ from: '2026-09-14', until: '2026-10-12', days: 28 });
    // Twenty issues of two runs each: one unit per issue, so the issue number reached the page.
    expect(p.yield.noPr.yield).toEqual({ status: 'ok', n: 20, value: 0, low: 0, high: 0 });
    expect(p.yield.pooled.bandMix).toMatchObject({ noPr: 20 });
    expect(p.html).toContain(noPrRow('0.0% (0.0% to 0.0%), n 20'));
  });

  it(`explains the first page's zero: a bail counts only ${IDLE_DAYS} days after the last run on its issue`, async () => {
    // Kanon's own run rows begin on 2026-09-29, the start of the collector's first sweep.
    const stored = bails('2026-09-29T12:00:00Z');
    const first = await publish(stored, '2026-10-12T07:15:00Z');
    expect(first.yield.noPr.yield).toEqual({ status: 'not-enough-data', n: 0, minimum: 20 });
    expect(first.html).toContain(noPrRow('not enough data (0)'));
    // The same rows, on the refresh after their groups settle (2026-10-30), are all there.
    const later = await publish(stored, '2026-11-02T07:15:00Z');
    expect(later.yield.noPr.yield).toMatchObject({ status: 'ok', n: 20 });
    expect(later.html).toContain(noPrRow('0.0% (0.0% to 0.0%), n 20'));
  });
});
