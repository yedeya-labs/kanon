import { describe, expect, it } from 'vitest';
import { AggregateError, PAGE_FILE, checkPage, readAggregateToken, tokenRefusal } from '../../scripts/aggregate-read.mjs';
import { HOSTED_URL, RUNNER_ENV, TOKEN, tokenNet } from '../unit/helpers/token-net.js';
import { pageView } from '../../infra/telemetry/function/aggregate.mjs';

/**
 * Plan 0003 M7 (kanon#661): the metrics page's read of the aggregate function's page view. The
 * same `GET` on the token URL, asking for `?view=page`, and an answer checked as strictly as the Explorer's:
 * exactly the keys the page view has, codes, dates and numbers where it has them, no text, a
 * threshold of three, and one adopter per declared entry. Anything else refuses the read whole,
 * so nothing reaches the page.
 */

const NOW = Date.parse('2026-10-07T12:00:00Z');
const LIVE = Math.floor(NOW / 1000) + 86_400;

const rows = Array.from({ length: 12 }, (_, k) => [
  { pk: 'alpha#work', row_kind: 'work_item', tag: 'run', recorded_at: '2026-10-01T10:00:00Z', expires_at: LIVE, pr_number: k + 1, closed_at: '2026-10-01T10:00:00Z', fate: 'merged', changed_lines: 100 * (k % 4), author_kind: 'implementer', first_verdict: 'approved', kanon_version: '0.39.0' },
  { pk: 'alpha#implement', row_kind: 'run', tag: 'run', recorded_at: '2026-09-30T10:00:00Z', expires_at: LIVE, lane: 'implement', total_cost_usd: k + 1, pr_number: k + 1 },
]).flat();
/** What the function answers, as JSON on the wire. */
const answer = () => JSON.parse(JSON.stringify(pageView(rows, { now: NOW, own: { alpha: 'kanon' } })));

describe('checkPage: exactly what the page view may publish', () => {
  it("passes the function's own answer through unchanged", () => {
    const a = answer();
    expect(checkPage(a)).toEqual(a);
    expect(PAGE_FILE).toBe('page.json');
  });

  it('refuses a key the page view never answers, at the top, in an entry, or deep in a cell', () => {
    const top = { ...answer(), rows: [] };
    expect(() => checkPage(top)).toThrow(/`rows`/);
    const inEntry = answer();
    inEntry.own[0].key = 'alpha';
    expect(() => checkPage(inEntry)).toThrow(/own\[0\] holds `key`/);
    const deep = answer();
    deep.own[0].headline.cost.pooled.median.repository = 'x';
    expect(() => checkPage(deep)).toThrow(/`repository`/);
  });

  it('refuses text where a code, a date or a version goes, and any value that is not a number, a code or null', () => {
    const prose = answer();
    prose.own[0].headline.cost.pooled.median.status = 'see https://example.com';
    expect(() => checkPage(prose)).toThrow(/is not a code/);
    const login = answer();
    login.own[0].trend[0].versionsIntroduced = ['someone'];
    expect(() => checkPage(login)).toThrow(/is not a code/);
    const bool = answer();
    bool.own[0].headline.cost.pooled.median.n = true;
    expect(() => checkPage(bool)).toThrow(/is not/);
    const label = answer();
    label.own[0].label = 'Owner/Repo';
    expect(() => checkPage(label)).toThrow(/label is not a code/);
  });

  it('refuses a threshold under three, an entry that combines adopters, and a repeated label (plan 0002 decision 7)', () => {
    expect(() => checkPage({ ...answer(), min_adopters: 2 })).toThrow(/below 3/);
    const two = answer();
    two.own[0].adopters = 2;
    expect(() => checkPage(two)).toThrow(/one adopter's own figures/);
    const twice = answer();
    twice.own.push(twice.own[0]);
    expect(() => checkPage(twice)).toThrow(/repeats/);
    expect(() => checkPage({ ...answer(), view: 'aggregate' })).toThrow(/not the page view/);
  });

  it('never puts a value in its message', () => {
    const a = answer();
    a.own[0].headline.cost.pooled.median.status = 'leaked-secret-value';
    try { checkPage(a); } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      expect(String((e as Error).message)).not.toContain('leaked');
    }
  });
});

/**
 * Plan 0008 §9 step 4a (J7): the read `metrics-page.yml` runs, `aggregate-read.mjs page`, on the
 * hosted store's token URL. Handed no variable, it reads the hosted store with a fresh token.
 */
describe('readAggregateToken for the page: the token read of `?view=page` (J7)', () => {
  it("asks the hosted store for the page view with a fresh token, and answers checkPage's output", async () => {
    const net = tokenNet(() => ({ status: 200, json: answer() }));
    const p = await readAggregateToken({ env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL, view: 'page' });
    expect(net.calls).toEqual([expect.objectContaining({ url: `${HOSTED_URL}?view=page`, method: 'GET', query: { view: 'page' }, auth: `Bearer ${TOKEN}1` })]);
    expect(p).toEqual(checkPage(answer()));
    expect(p.view).toBe('page');
    const wrong = tokenNet(() => ({ status: 200, json: { ...answer(), extra: 1 } }));
    await expect(readAggregateToken({ env: RUNNER_ENV, fetchImpl: wrong.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL, view: 'page' })).rejects.toThrow(/`extra`/);
  });

  it("names the page exception's conditions, not a pin, for a 403 `workflow` on the page view", async () => {
    const net = tokenNet(() => ({ status: 403, json: { error: 'workflow' } }));
    const e = await readAggregateToken({ env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {}, hostedUrl: HOSTED_URL, view: 'page' }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(AggregateError);
    expect((e as Error).message).toMatch(/answered 403 \(workflow\): the store admits the metrics page's read only from Kanon's `metrics-page\.yml` on its registration's default branch, and only while that registration sets `page_reader`/);
    expect((e as Error).message).not.toMatch(/pin/);
    // The Explorer's read keeps its own cause.
    expect(tokenRefusal(403, 'workflow')).toMatch(/check the caller's pin/);
  });
});
