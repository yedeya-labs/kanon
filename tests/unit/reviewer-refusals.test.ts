import { describe, expect, it } from 'vitest';
import { compareVersions, render, summarize } from '../../.github/scripts/reviewer-refusals.mjs';

/**
 * kanon#404 — the Reviewer's prompt steers its reads to shapes the CLI's read-only checker
 * accepts, and the issue closes on the refusals per run re-measured over the first 20 or more
 * Reviewer runs after that ships. `.github/scripts/reviewer-refusals.mjs` takes them from the
 * review lane's telemetry rows, so the baseline and the after-measurement are the same sum.
 */
const row = (at: string, version: string, denials?: number, fingerprint = 'aaaaaaaaaaaa') => ({
  recorded_at: `2026-10-${at}Z`, kanon_version: version, config_fingerprint: fingerprint,
  ...(denials === undefined ? {} : { permission_denials: denials }),
});

describe('refusals per Reviewer run (kanon#404)', () => {
  const rows = [
    row('05T10:00:00', '0.29.0', 3),
    row('05T09:00:00', '0.29.0', 1),
    row('06T10:00:00', '0.30.0', 0, 'bbbbbbbbbbbb'),
    row('06T11:00:00', '0.30.0', 2, 'bbbbbbbbbbbb'),
    row('06T12:00:00', '0.30.0', undefined, 'bbbbbbbbbbbb'),
    row('07T10:00:00', '0.100.0', 5, 'bbbbbbbbbbbb'),
  ];

  it('divides the refusals by the runs that carry a count, and leaves the rest out', () => {
    const s = summarize(rows);
    expect(s.total).toEqual({ runs: 6, counted: 5, denials: 11, perRun: 11 / 5, most: 5 });
    expect(s.from).toBe('2026-10-05T09:00:00Z');
    expect(s.to).toBe('2026-10-07T10:00:00Z');
  });

  it('groups by Kanon release and fingerprint, in release order', () => {
    expect(summarize(rows).groups.map((g) => [g.version, g.fingerprint, g.runs, g.counted, g.denials])).toEqual([
      ['0.29.0', 'aaaaaaaaaaaa', 2, 2, 4],
      ['0.30.0', 'bbbbbbbbbbbb', 3, 2, 2],
      ['0.100.0', 'bbbbbbbbbbbb', 1, 1, 5],
    ]);
  });

  it('keeps the runs after a time and with a fingerprint, and then the earliest N of them', () => {
    expect(summarize(rows, { after: '2026-10-05T23:00:00Z' }).total).toMatchObject({ runs: 4, denials: 7 });
    expect(summarize(rows, { after: '2026-10-05T09:00:00Z' }).total).toMatchObject({ runs: 5, denials: 10 });
    expect(summarize(rows, { fingerprint: 'aaaaaaaaaaaa' }).total).toMatchObject({ runs: 2, denials: 4 });
    expect(summarize(rows, { after: '2026-10-05T23:00:00Z', first: 2 }).total).toMatchObject({ runs: 2, counted: 2, denials: 2, perRun: 1 });
    expect(summarize(rows, { first: 1 }).total).toMatchObject({ runs: 1, denials: 1 });
    expect(summarize(rows, { after: '2026-11-01T00:00:00Z' }).total).toEqual({ runs: 0, counted: 0, denials: 0, perRun: null, most: 0 });
  });

  it('compares versions by number, not by text', () => {
    expect(compareVersions('0.100.0', '0.30.0')).toBeGreaterThan(0);
    expect(compareVersions('0.30.0', '0.30.0')).toBe(0);
    expect(compareVersions('', '0.0.0')).toBeLessThan(0);
  });

  it('renders a table with the overall rate', () => {
    expect(render(summarize(rows))).toContain('| **all** | | **6** | 5 | 11 | **2.20** | 5 |');
  });
});
