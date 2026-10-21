import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billedMinutes, isShort, looksLong, measure, readTable, renderReport, sampleByGroup, sampleEvenly, TABLE_HEADER } from '../../scripts/actions-minutes.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * kanon#581: what each lane costs in GitHub Actions runner-minutes, measured from a repository's
 * own runs by `scripts/actions-minutes.mjs`, so the figures in docs/actions-minutes.md and the
 * catalogue's `minutes` (which the adopt skill shows beside each lane) can be refreshed.
 */

/** A job of `seconds`, as the Actions API lists it; `null` seconds is a job that never started. */
const job = (seconds: number | null, conclusion = 'success') => ({
  conclusion,
  started_at: seconds === null ? null : '2026-10-01T10:00:00Z',
  completed_at: seconds === null ? null : new Date(Date.parse('2026-10-01T10:00:00Z') + seconds * 1000).toISOString(),
});

describe('what a run bills (kanon#581)', () => {
  it('rounds each job that ran up to a whole minute, as GitHub bills it, and charges nothing for a skipped job or one that never started', () => {
    expect(billedMinutes([job(61)])).toBe(2);
    expect(billedMinutes([job(5)])).toBe(1);
    expect(billedMinutes([job(60)])).toBe(1);
    // Two short jobs are two minutes, not one: each job is rounded on its own.
    expect(billedMinutes([job(5), job(5)])).toBe(2);
    // GitHub can stamp a skipped job with times, though no runner ran it.
    expect(billedMinutes([job(5, 'skipped'), job(30)])).toBe(1);
    expect(billedMinutes([job(null, 'cancelled'), job(0, 'cancelled')])).toBe(0);
    expect(billedMinutes([])).toBe(0);
  });

  it('calls a run short when no job of it ran past one minute, which is how a gated or skipped run looks', () => {
    expect(isShort([job(20), job(0, 'skipped')])).toBe(true);
    expect(isShort([job(0, 'skipped')])).toBe(true);
    expect(isShort([job(20), job(61)])).toBe(false);
  });

  it('samples runs spread evenly over the window, the same ones on every read', () => {
    const ten = [...Array(10).keys()];
    expect(sampleEvenly(ten, 3)).toEqual([0, 5, 9]);
    expect(sampleEvenly(ten, 3)).toEqual(sampleEvenly(ten, 3));
    expect(sampleEvenly(ten, 20)).toEqual(ten);
    expect(sampleEvenly(ten, 1)).toEqual([0]);
    expect(sampleEvenly([], 5)).toEqual([]);
  });

  it('tells a run that lasted past a minute from the rest by the listing\'s own times, and samples each group on its own (kanon#1211)', () => {
    const at = (seconds: number) => ({ run_started_at: '2026-10-01T10:00:00Z', updated_at: new Date(Date.parse('2026-10-01T10:00:00Z') + seconds * 1000).toISOString() });
    expect(looksLong(at(61))).toBe(true);
    expect(looksLong(at(60))).toBe(false);
    expect(looksLong({})).toBe(false);
    const runs = [...Array(10).keys()].map((i) => ({ i, ...at(i === 7 ? 900 : 5) }));
    const { picked, longRuns, longSampled } = sampleByGroup(runs, 3);
    expect({ longRuns, longSampled }).toEqual({ longRuns: 1, longSampled: 1 });
    // The one long run is read and stands for itself; three of the nine others stand for three each.
    expect(picked.map((p) => [p.run.i, p.weight, p.long])).toEqual([[7, 1, true], [0, 3, false], [4, 3, false], [9, 3, false]]);
  });
});

/** The window a measurement on 2026-10-08 over seven days reads. */
const WINDOW = [Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-07T23:59:59Z')] as const;

/** A fake `gh api`: the default branch's callers, each caller's runs, each run's jobs, and the search counts. */
const fakeGh = (opts: { runs: Record<string, Array<{ id: number; status?: string }>>; jobs: Record<number, ReturnType<typeof job>[]>; cap?: number; created?: Record<string, string> }) => {
  const calls: string[][] = [];
  const caller = (lane: string) => `on:\n  workflow_dispatch:\njobs:\n  run:\n    uses: yedeya-labs/kanon/.github/workflows/${lane}.yml@v1.0.0\n`;
  const gh = (args: string[]) => {
    calls.push(args);
    const path = args.find((a) => a.startsWith('repos/') || a.startsWith('search/') || a === 'graphql') ?? '';
    if (path === 'graphql') {
      return { data: { repository: { workflows: { entries: [
        { name: 'review.yml', type: 'blob', object: { text: caller('agent-review') } },
        { name: 'merge.yml', type: 'blob', object: { text: caller('agent-merge') } },
      ] }, record: null } } };
    }
    if (path.startsWith('search/')) {
      const q = args[args.indexOf('-f') + 1]!;
      return { total_count: q.includes('is:merged') ? 14 : q.includes('is:pr') ? 21 : 7 };
    }
    const runsOf = /^repos\/o\/r\/actions\/workflows\/([^/]+)\/runs\?(.*)$/.exec(path);
    if (runsOf) {
      const q = new URLSearchParams(runsOf[2]);
      const [from, to] = q.get('created')!.split('..').map((s) => Date.parse(s));
      // The runs are spread over the whole window, so a narrower range holds fewer, at whole
      // seconds as GitHub stamps them.
      // A caller younger than the window has runs only since it appeared.
      const start = Math.max(WINDOW[0], Date.parse(opts.created?.[runsOf[1]!] ?? '2026-01-01T00:00:00Z'));
      const all = (opts.runs[runsOf[1]!] ?? []).map((r, i, a) => ({ ...r, status: r.status ?? 'completed', created_at: new Date(start + Math.floor(((WINDOW[1] - start) * i) / Math.max(a.length, 1) / 1000) * 1000).toISOString() }));
      const inRange = all.filter((r) => { const t = Date.parse(r.created_at); return t >= from! && t <= to!; });
      const page = Number(q.get('page'));
      // GitHub returns at most 1,000 runs for one filtered listing, whatever total_count says.
      const listed = inRange.slice(0, opts.cap ?? 1000);
      return { total_count: inRange.length, workflow_runs: listed.slice((page - 1) * 100, page * 100) };
    }
    const workflow = /^repos\/o\/r\/actions\/workflows\/([^/?]+)$/.exec(path);
    if (workflow) return { path: `.github/workflows/${workflow[1]}`, created_at: opts.created?.[workflow[1]!] ?? '2026-01-01T00:00:00Z' };
    const jobsOf = /^repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?/.exec(path);
    if (jobsOf) {
      const js = opts.jobs[Number(jobsOf[1])] ?? [];
      return { total_count: js.length, jobs: js };
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
};

describe('measuring a repository (kanon#581)', () => {
  const lanes = ['agent-review', 'agent-merge', 'agent-explore'];

  it('measures each lane through its caller, by runs a day, short runs and minutes a day, and names a lane nothing calls as not measured', () => {
    // Fourteen runs of review in a week: half short, half eleven minutes. Merge: seven, all short.
    const reviewRuns = [...Array(14).keys()].map((i) => ({ id: 100 + i }));
    const mergeRuns = [...Array(7).keys()].map((i) => ({ id: 200 + i }));
    const jobs: Record<number, ReturnType<typeof job>[]> = {};
    for (const r of reviewRuns) jobs[r.id] = r.id % 2 ? [job(30), job(0, 'skipped')] : [job(30), job(600)];
    for (const r of mergeRuns) jobs[r.id] = [job(40)];
    const { gh } = fakeGh({ runs: { 'review.yml': [...reviewRuns, { id: 999, status: 'in_progress' }], 'merge.yml': mergeRuns }, jobs });
    const m = measure({ repo: 'o/r', gh, now: '2026-10-08T00:00:00Z', days: 7, sample: 40, lanes, log: () => {} });
    expect(m.since).toBe('2026-10-01T00:00:00Z');
    expect(m.until).toBe('2026-10-08T00:00:00Z');
    expect(m.activity).toEqual({ pullRequests: 21, merged: 14, issues: 7 });
    const [review, merge, explore] = m.rows;
    // A run still going is left out: it has no bill yet.
    expect(review).toMatchObject({ lane: 'agent-review', caller: 'review.yml', days: 7, runs: 14, sampled: 14, short: 7, shortMinutes: 1, otherMinutes: 11, perDay: 2, minutesPerDay: 12 });
    expect(merge).toMatchObject({ lane: 'agent-merge', caller: 'merge.yml', runs: 7, sampled: 7, short: 7, shortMinutes: 1, otherMinutes: null, perDay: 1, minutesPerDay: 1 });
    expect(explore).toMatchObject({ lane: 'agent-explore', caller: null });
  });

  it('counts the runs a day of a caller younger than the window over the days it has existed', () => {
    // Merge's caller appeared a day before the measurement, and ran twice in that day.
    const { gh } = fakeGh({ runs: { 'merge.yml': [{ id: 1 }, { id: 2 }] }, jobs: { 1: [job(30)], 2: [job(30)] }, created: { 'merge.yml': '2026-10-07T00:00:00Z' } });
    const m = measure({ repo: 'o/r', gh, now: '2026-10-08T00:00:00Z', days: 7, sample: 40, lanes: ['agent-merge'], log: () => {} });
    expect(m.rows[0]).toMatchObject({ days: 1, runs: 2, perDay: 2, minutesPerDay: 2 });
  });

  it('reads the jobs of at most the sample, spread over the window, and scales the minutes to every run', () => {
    const runs = [...Array(50).keys()].map((i) => ({ id: 1000 + i }));
    const jobs = Object.fromEntries(runs.map((r) => [r.id, [job(150)]]));
    const { gh, calls } = fakeGh({ runs: { 'review.yml': runs }, jobs });
    const m = measure({ repo: 'o/r', gh, now: '2026-10-08T00:00:00Z', days: 7, sample: 10, lanes: ['agent-review'], log: () => {} });
    expect(calls.filter((a) => a.some((x) => x.includes('/jobs?'))).length).toBe(10);
    expect(m.rows[0]).toMatchObject({ runs: 50, sampled: 10, minutesPerDay: Math.round((50 * 3) / 7) });
  });

  it('reads every model run of a lane whose runs are nearly all skipped gate checks, and says how many of each it read (kanon#1211)', () => {
    // Triage's week: 580 runs, 574 of them skipped in seconds, 6 model runs of 21 billed minutes.
    // The 6 sit where neither the first 100 runs nor 100 spread evenly over all 580 would reach.
    const ids = [...Array(580).keys()];
    const evenly = new Set(sampleEvenly(ids, 100));
    const modelAt = new Set(ids.filter((i) => i >= 100 && !evenly.has(i)).filter((_, k, a) => k % Math.floor(a.length / 6) === 0).slice(0, 6));
    expect(modelAt.size).toBe(6);
    const started = '2026-10-01T10:00:00Z';
    const after = (seconds: number) => new Date(Date.parse(started) + seconds * 1000).toISOString();
    const runs = ids.map((i) => ({ id: 3000 + i, run_started_at: started, updated_at: after(modelAt.has(i) ? 1260 : 4) }));
    const jobs = Object.fromEntries(ids.map((i) => [3000 + i, modelAt.has(i) ? [job(5), job(1200)] : [job(2, 'skipped')]]));
    const { gh, calls } = fakeGh({ runs: { 'review.yml': runs }, jobs });
    const m = measure({ repo: 'o/r', gh, now: '2026-10-08T00:00:00Z', days: 7, sample: 100, lanes: ['agent-review'], log: () => {} });
    // Each model run bills 1 + 20 minutes: 126 over the 7 days.
    expect(m.rows[0]).toMatchObject({ runs: 580, sampled: 106, longRuns: 6, longSampled: 6, short: 574, otherMinutes: 21, minutesPerDay: 18 });
    const read = calls.filter((a) => a.some((x) => x.includes('/jobs?'))).map((a) => Number(/runs\/(\d+)\/jobs/.exec(a.find((x) => x.includes('/jobs?'))!)![1]) - 3000);
    for (const i of modelAt) expect(read).toContain(i);
    const report = renderReport(m);
    expect(readTable(report)[0]).toMatchObject({ short: '99%', otherMinutes: '21', minutesPerDay: '18' });
    expect(report).toContain('`agent-review` 6 of 6 and 100 of 574');
  });

  it('splits a range GitHub would cut at 1,000 runs, so every run is counted', () => {
    const runs = [...Array(2500).keys()].map((i) => ({ id: 5000 + i }));
    const { gh } = fakeGh({ runs: { 'review.yml': runs }, jobs: {} });
    const m = measure({ repo: 'o/r', gh, now: '2026-10-08T00:00:00Z', days: 7, sample: 3, lanes: ['agent-review'], log: () => {} });
    expect(m.rows[0]!.runs).toBe(2500);
  });

  it('writes the report docs/actions-minutes.md holds, and reads its table back', () => {
    const reviewRuns = [{ id: 1 }, { id: 2 }];
    const { gh } = fakeGh({ runs: { 'review.yml': reviewRuns }, jobs: { 1: [job(30)], 2: [job(400)] } });
    const m = measure({ repo: 'o/r', gh, now: '2026-10-08T00:00:00Z', days: 7, sample: 40, lanes, log: () => {} });
    const report = renderReport(m);
    expect(report).toContain('o/r');
    expect(report).toContain('2026-10-01 00:00 to 2026-10-08 00:00 UTC');
    expect(report).toContain(TABLE_HEADER);
    const table = readTable(report);
    expect(table.map((r) => r.lane)).toEqual(lanes);
    expect(table[0]).toMatchObject({ lane: 'agent-review', minutesPerDay: '1.1' });
    expect(table[2]).toMatchObject({ lane: 'agent-explore', minutesPerDay: 'not measured' });
    // Merge's caller ran no run, so it has no share of short runs to give.
    expect(table[1]).toMatchObject({ lane: 'agent-merge', perDay: '0', short: '—', minutesPerDay: '0' });
  });
});

describe('docs/actions-minutes.md and the catalogue say what the measurement says (kanon#581)', () => {
  const catalogue = JSON.parse(read('docs/lanes.json')) as { lanes: Record<string, { minutes: string }> };
  const table = readTable(read('docs/actions-minutes.md'));

  it('has a row for every lane, in the catalogue\'s order', () => {
    expect(table.map((r) => r.lane)).toEqual(Object.keys(catalogue.lanes));
  });

  it('says what starts every lane, in the catalogue\'s order', () => {
    const doc = read('docs/actions-minutes.md');
    const section = doc.split('\n## What starts each lane\n')[1]!.split('\n## ')[0]!;
    const lanes = [...section.matchAll(/^\| `(agent-[a-z-]+)` \|/gm)].map((m) => m[1]);
    expect(lanes).toEqual(Object.keys(catalogue.lanes));
  });

  it("gives each lane's minutes a day in its catalogue entry, the line the adopt skill shows, or says it was not measured", () => {
    for (const row of table) {
      const minutes = catalogue.lanes[row.lane]!.minutes;
      // A lane nothing calls, or whose caller didn't run, has no figure to give.
      if (row.minutesPerDay === 'not measured' || row.perDay === '0') expect(minutes, row.lane).toMatch(/^Not measured/);
      else if (row.minutesPerDay === '0') expect(minutes, row.lane).toContain('under a runner-minute a day');
      else expect(minutes, row.lane).toContain(`about ${row.minutesPerDay} runner-minute${row.minutesPerDay === '1' ? '' : 's'} a day`);
    }
  });
});
