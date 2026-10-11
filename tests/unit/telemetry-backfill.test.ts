import { describe, expect, it } from 'vitest';

import { monthCounts, passed, report } from '../../infra/telemetry/backfill.mjs';
import { send } from '../../infra/telemetry/import.mjs';

/**
 * Plan 0003 M5, the work-item backfill: its check (rows per month = PRs closed per month), its
 * report, and its send as the backfill role. The derivation itself is the collector's
 * `workItemStep`, tested in tests/library/telemetry-work-items.test.ts. No AWS, no GitHub.
 */

const SINCE = Date.parse('2026-09-04T00:00:00Z');
/** The run's start, `now`: both sides stop there. */
const UNTIL = Date.parse('2026-10-11T18:00:00Z');
const register = new Map([['Releaser', 'acme-releaser']]);

/** A closed pull request as GitHub's `GET /repos/{repo}/pulls` lists it. */
const listed = (number: number, closedAt: string, over: Record<string, unknown> = {}) => ({
  number, title: `feat: item ${number}`, closed_at: closedAt, labels: [], user: { login: 'someone', type: 'User' }, ...over,
});

describe('monthCounts: M5\'s check', () => {
  it('counts the PRs closed per month beside the rows, and agrees when every PR has its row', () => {
    const prs = [listed(1, '2026-09-05T10:00:00Z'), listed(2, '2026-09-30T23:59:59Z'), listed(3, '2026-10-01T00:00:00Z')];
    const rows = [{ closed_at: '2026-09-05T10:00:00Z' }, { closed_at: '2026-09-30T23:59:59Z' }, { closed_at: '2026-10-01T00:00:00Z' }];
    const counts = monthCounts(prs, rows, { since: SINCE, until: UNTIL, register });
    expect(counts).toEqual({ months: [{ month: '2026-09', closed: 2, rows: 2 }, { month: '2026-10', closed: 1, rows: 1 }], earlier: 0, during: 0 });
    expect(passed(counts, { failures: [] })).toBe(true);
  });

  it('leaves release PRs out, as the metrics do, by label and by the Releaser App', () => {
    const prs = [
      listed(1, '2026-09-10T00:00:00Z'),
      listed(2, '2026-09-11T00:00:00Z', { labels: [{ name: 'autorelease: tagged' }] }),
      listed(3, '2026-09-12T00:00:00Z', { user: { login: 'acme-releaser[bot]', type: 'Bot' }, title: 'chore(main): release 1.2.0' }),
    ];
    const counts = monthCounts(prs, [{ closed_at: '2026-09-10T00:00:00Z' }], { since: SINCE, until: UNTIL, register });
    expect(counts.months).toEqual([{ month: '2026-09', closed: 1, rows: 1 }]);
  });

  it('cuts the listing to the span', () => {
    const counts = monthCounts([listed(1, '2026-09-03T23:59:59Z'), listed(2, '2026-09-04T00:00:00Z')], [{ closed_at: '2026-09-04T00:00:00Z' }], { since: SINCE, until: UNTIL, register });
    expect(counts.months).toEqual([{ month: '2026-09', closed: 1, rows: 1 }]);
  });

  it('counts an earlier item\'s rewritten row apart, never in a month', () => {
    const counts = monthCounts([listed(5, '2026-09-20T00:00:00Z')], [{ closed_at: '2026-09-20T00:00:00Z' }, { closed_at: '2026-08-01T00:00:00Z' }], { since: SINCE, until: UNTIL, register });
    expect(counts).toEqual({ months: [{ month: '2026-09', closed: 1, rows: 1 }], earlier: 1, during: 0 });
    expect(passed(counts, { failures: [] })).toBe(true);
  });

  it('stops both sides at the run\'s start: a PR closed while the step ran is counted apart, not as a difference', () => {
    // Closed after `now`: in the listing (read after the step), and its row too, as the step's
    // read can see it. Neither may enter October's count.
    const prs = [listed(1, '2026-10-11T17:59:59Z'), listed(2, '2026-10-11T18:03:00Z')];
    const counts = monthCounts(prs, [{ closed_at: '2026-10-11T17:59:59Z' }, { closed_at: '2026-10-11T18:03:00Z' }], { since: SINCE, until: UNTIL, register });
    expect(counts).toEqual({ months: [{ month: '2026-10', closed: 1, rows: 1 }], earlier: 0, during: 1 });
    expect(passed(counts, { failures: [] })).toBe(true);
    // And the listing alone past the cut, with no row read for it, still agrees.
    expect(passed(monthCounts(prs, [{ closed_at: '2026-10-11T17:59:59Z' }], { since: SINCE, until: UNTIL, register }), { failures: [] })).toBe(true);
  });

  it('fails when a month differs, or when the step failed', () => {
    const short = monthCounts([listed(1, '2026-09-10T00:00:00Z'), listed(2, '2026-09-11T00:00:00Z')], [{ closed_at: '2026-09-10T00:00:00Z' }], { since: SINCE, until: UNTIL, register });
    expect(passed(short, { failures: [] })).toBe(false);
    const whole = monthCounts([listed(1, '2026-09-10T00:00:00Z')], [{ closed_at: '2026-09-10T00:00:00Z' }], { since: SINCE, until: UNTIL, register });
    expect(passed(whole, { failures: ['work items: the pull requests closed in the span could not be read (x)'] })).toBe(false);
  });
});

describe('report', () => {
  it('prints counts only, and marks a month that differs', () => {
    const counts = monthCounts([listed(1, '2026-09-10T00:00:00Z'), listed(2, '2026-10-11T00:00:00Z')], [{ closed_at: '2026-09-10T00:00:00Z' }], { since: SINCE, until: UNTIL, register });
    const lines = report(counts, { failures: [], warnings: ['work item PR #2: GitHub cuts one of its lists short, so it has no work-item row (plan 0003 §3.1)'] });
    expect(lines).toContain('2026-09           1     1');
    expect(lines).toContain('2026-10           1     0  differs');
    expect(lines).toContain('earlier items rewritten: 0');
    expect(lines).toContain('closed while the step ran: 0');
    expect(lines).toContain('1 warning(s), 0 failure(s)');
    expect(lines.join('\n')).not.toMatch(/someone|acme/);
  });
});

describe('send as the backfill role', () => {
  it('assumes the backfill role, not the importer, and names the key', async () => {
    const calls: string[][] = [];
    const aws = (args: string[]) => {
      calls.push(args);
      const out = args[1] === 'get-caller-identity' ? { Account: '4'.repeat(12) }
        : args[1] === 'describe-stacks' ? { Stacks: [{ Outputs: [{ OutputKey: 'IngestUrl', OutputValue: 'https://u.example/' }] }] }
          : { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't' } };
      return { code: 0, stdout: JSON.stringify(out), stderr: '' };
    };
    const urls: string[] = [];
    const post = async (url: string, body: string) => {
      urls.push(url);
      return { status: 200, json: { results: (JSON.parse(body) as unknown[]).map(() => ({ status: 'stored' })) } };
    };
    const r = await send([{ row_kind: 'work_item' }], 'k2', { aws, post, profile: 'kanon', role: 'backfill' });
    expect(r).toEqual({ stored: 1, refused: {} });
    expect(urls).toEqual(['https://u.example/?key=k2']);
    expect(calls.find((c) => c[1] === 'assume-role')).toContain(`arn:aws:iam::${'4'.repeat(12)}:role/kanon-telemetry-backfill`);
  });

  it('names the backfill flag when the role is not deployed', async () => {
    const aws = (args: string[]) => ({ code: args[1] === 'assume-role' ? 254 : 0, stdout: args[1] === 'assume-role' ? '' : JSON.stringify({ Account: '1', Stacks: [{ Outputs: [{ OutputKey: 'IngestUrl', OutputValue: 'u' }] }] }), stderr: '' });
    await expect(send([{}], 'k2', { aws, post: async () => ({ status: 200, json: {} }), profile: 'kanon', role: 'backfill' })).rejects.toThrow(/--backfill/);
  });
});
