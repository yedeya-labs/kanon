import { describe, expect, it } from 'vitest';
import { churnBoundary, reviseDeliveries } from '../../scripts/revise-run-evidence.mjs';

/**
 * RA-1724 — which revise runs DELIVERED a changes-request. Shared by both revise
 * recoveries; each has its own lane-level tests, these pin the rules themselves,
 * including the fail-closed arms no lane fixture reaches.
 */
const SHA = 'aaaaaaa1';
const REVIEWED = '2026-09-23T10:20:46Z';
const at = (s: number) => new Date(Date.parse(REVIEWED) + s * 1000).toISOString();
const CHURN = churnBoundary(REVIEWED, 4);
const run = (databaseId: number, conclusion: string | null, createdAt?: string) =>
  ({ headSha: SHA, status: 'completed', conclusion, databaseId, createdAt });
const ids = (runs: { databaseId?: number }[] | null) => (runs ?? []).map((r) => r.databaseId);

describe('reviseDeliveries', () => {
  it('keeps the rules it inherited: skipped and pre-review runs are not deliveries', () => {
    expect(reviseDeliveries([run(1, 'skipped', at(5))], { sha: SHA, since: REVIEWED, churnedAfter: CHURN })).toEqual([]);
    expect(reviseDeliveries([run(1, 'success', at(-60))], { sha: SHA, since: REVIEWED, churnedAfter: CHURN })).toEqual([]);
    expect(reviseDeliveries([{ ...run(1, 'success', at(5)), headSha: 'other' }], { sha: SHA, since: REVIEWED })).toEqual([]);
  });

  it('drops a cancelled run that a newer run of ANY conclusion superseded', () => {
    // The displacing run is a `skipped` label event in every measured case, so
    // supersession must be read from the raw listing, skips included.
    const burst = [run(1, 'success', at(3)), run(2, 'cancelled', at(4)), run(3, 'skipped', at(24))];
    expect(ids(reviseDeliveries(burst, { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([1]);
  });

  it('breaks a same-second tie by run id, which the burst produces (PR RA-2007)', () => {
    const tie = [run(10, 'cancelled', at(4)), run(11, 'success', at(4))];
    expect(ids(reviseDeliveries(tie, { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([11]);
    const reversed = [run(11, 'cancelled', at(4)), run(10, 'success', at(4))];
    expect(ids(reviseDeliveries(reversed, { sha: SHA, since: REVIEWED, churnedAfter: CHURN })),
      'the newer id survives, whatever the listing order').toEqual([11, 10]);
  });

  it('keeps a cancelled run that is the NEWEST on its head — a real cancellation', () => {
    expect(ids(reviseDeliveries([run(1, 'success', at(3)), run(2, 'cancelled', at(9000))],
      { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([1, 2]);
  });

  it('keeps the CHURN\'s own run whatever it concluded — the loop bound', () => {
    // Created after the stall window: only a churn starts a run that late. Displaced
    // or not, it counts, so the same head is never re-churned hourly.
    const churned = [run(5, 'cancelled', at(5 * 3600)), run(6, 'skipped', at(5 * 3600 + 20))];
    expect(ids(reviseDeliveries(churned, { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([5]);
  });

  it('fails CLOSED on an unknown churn boundary: every post-review run counts', () => {
    const burst = [run(1, 'success', at(3)), run(2, 'cancelled', at(4)), run(3, 'skipped', at(24))];
    expect(ids(reviseDeliveries(burst, { sha: SHA, since: REVIEWED }))).toEqual([1, 2]);
    expect(ids(reviseDeliveries(burst, { sha: SHA, since: REVIEWED, churnedAfter: 'not a date' }))).toEqual([1, 2]);
  });

  it('fails CLOSED on an unreadable clock: supersession must be proven', () => {
    expect(ids(reviseDeliveries([run(2, 'cancelled'), run(3, 'skipped', at(24))],
      { sha: SHA, since: REVIEWED, churnedAfter: CHURN })), 'no clock on the cancelled run').toEqual([2]);
    expect(ids(reviseDeliveries([run(2, 'cancelled', at(4)), run(3, 'skipped')],
      { sha: SHA, since: REVIEWED, churnedAfter: CHURN })), 'no clock on the would-be superseder').toEqual([2]);
  });

  describe('only a LABEL-event run is a displaced casualty (RA-2301)', () => {
    const ev = (event: string, r: ReturnType<typeof run>) => ({ ...r, event });

    it('keeps a cancelled pull_request_review run followed by label runs — it was stopped, not displaced', () => {
      // RA-2267's burst order: the review run first, label runs seconds after it, always.
      const burst = [
        ev('pull_request_review', run(1, 'cancelled', at(3))),
        ev('pull_request', run(2, 'skipped', at(4))),
        ev('pull_request', run(3, 'skipped', at(24))),
      ];
      expect(ids(reviseDeliveries(burst, { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([1]);
    });

    it('keeps a cancelled workflow_dispatch run for the same reason', () => {
      const runs = [ev('workflow_dispatch', run(1, 'cancelled', at(60))), ev('pull_request', run(2, 'skipped', at(90)))];
      expect(ids(reviseDeliveries(runs, { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([1]);
    });

    it('still drops the displaced LABEL run in the measured RA-2267 burst', () => {
      const burst = [
        ev('pull_request_review', run(35848261456, 'success', at(3))),
        ev('pull_request', run(35848263198, 'cancelled', at(4))),
        ev('pull_request', run(35848293949, 'skipped', at(24))),
      ];
      expect(ids(reviseDeliveries(burst, { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([35848261456]);
    });

    it('still keeps the churn\'s own label run, displaced or not — the loop bound', () => {
      const churned = [ev('pull_request', run(5, 'cancelled', at(5 * 3600))), ev('pull_request', run(6, 'skipped', at(5 * 3600 + 20)))];
      expect(ids(reviseDeliveries(churned, { sha: SHA, since: REVIEWED, churnedAfter: CHURN }))).toEqual([5]);
    });
  });

  it('treats a null listing as empty rather than throwing', () => {
    expect(reviseDeliveries(null as never, { sha: SHA, since: REVIEWED })).toEqual([]);
  });
});

describe('churnBoundary', () => {
  it('is the review timestamp plus the stall window', () => {
    expect(churnBoundary(REVIEWED, 4)).toBe('2026-09-23T14:20:46.000Z');
  });

  it('is null for an undated review, which the reader treats as unknown', () => {
    expect(churnBoundary(null, 4)).toBeNull();
    expect(churnBoundary('garbage', 4)).toBeNull();
    expect(churnBoundary(REVIEWED, Number.NaN)).toBeNull();
  });
});
