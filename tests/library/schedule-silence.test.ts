import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifySchedule,
  cronField,
  cronGapMinutes,
  nextSilentSet,
  renderScheduleFinding,
  scheduleCrons,
  scheduleMarker,
  SCHEDULE_MARKER,
  silenceLimitHours,
  silentSetIn,
} from '../../scripts/lib/schedule-silence.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * kanon#813 — GitHub fired about one in seven of Kanon's hourly scheduled runs, and nothing said
 * so. A schedule that stops leaves no run to turn red, so the health job must notice the silence
 * itself, and must not cry wolf over GitHub's ordinary lateness.
 */

const NOW = '2026-10-13T12:00:00Z';
const ACTIVE = { state: 'active', created_at: '2026-10-01T00:00:00Z' };
const hoursBefore = (h: number) => new Date(new Date(NOW).getTime() - h * 3_600_000).toISOString();
const row = (over: Partial<Parameters<typeof classifySchedule>[0]> = {}) =>
  classifySchedule({ file: 'merge.yml', crons: ['37 * * * *'], workflow: ACTIVE, lastRunAt: hoursBefore(1), ...over }, NOW, { slackHours: 12 });

describe('cronGapMinutes: the longest a cron leaves between two ticks', () => {
  it.each([
    [['37 * * * *'], 60],
    [['30 4 * * *'], 1440],
    [['0 7 * * 1'], 10080],
    [['30 6 * * TUE'], 10080],
    [['0 0 * * 7'], 10080],
    // Every third day of the month: the 31st then the 1st is one day, so three is the longest.
    [['30 7 */3 * *'], 4320],
    // Six to twenty-one every three hours: the night is the longest gap.
    [['0 6-21/3 * * *'], 9 * 60],
    [['*/5 * * * *'], 5],
    // Both day fields restricted: either one ticks.
    [['0 0 1 * MON'], 10080],
    // Two crons together: the gap between them, not each alone.
    [['0 0 * * *', '0 12 * * *'], 720],
    [['0 0 1 JAN *'], 366 * 1440],
    // A leap day ticks once in four years.
    [['0 0 29 2 *'], 1461 * 1440],
  ])('%j → %i minutes', (crons, gap) => {
    expect(cronGapMinutes(crons)).toBe(gap);
  });

  it.each([[[]], [['bad']], [['* * * *']], [['61 * * * *']], [['0 0 * * 8']], [['5-1 * * * *']], [['*/0 * * * *']]])('%j can\'t be read, so it has no gap', (crons) => {
    expect(cronGapMinutes(crons)).toBeNull();
  });

  it('reads a start with a step as running to the field\'s end, and refuses a backward range', () => {
    expect([...(cronField('5/15', 0, 59) ?? [])]).toEqual([5, 20, 35, 50]);
    expect(cronField('5-1', 0, 59)).toBeNull();
  });

  it('gives a cron that never ticks no gap', () => {
    expect(cronGapMinutes(['0 0 31 2 *'])).toBeNull();
  });

  it('reads day 7 as Sunday in a range only on the step that reaches it', () => {
    expect([...(cronField('5-7', 0, 6) ?? [])].sort()).toEqual([0, 5, 6]);
    expect([...(cronField('1-7/2', 0, 6) ?? [])].sort()).toEqual([0, 1, 3, 5]);
    expect([...(cronField('2-7/2', 0, 6) ?? [])].sort()).toEqual([2, 4, 6]);
  });

  it('reads every cron in Kanon\'s own workflows', () => {
    const dir = join(ROOT, '.github/workflows');
    const crons = readdirSync(dir).flatMap((f) => scheduleCrons(readFileSync(join(dir, f), 'utf8')));
    expect(crons.length).toBeGreaterThan(0);
    for (const c of crons) expect(cronGapMinutes([c]), c).not.toBeNull();
  });
});

describe('scheduleCrons', () => {
  it('lists on.schedule\'s crons, and nothing for a workflow without one', () => {
    expect(scheduleCrons('on:\n  schedule:\n    - cron: "7 * * * *"\n    - cron: \'0 6 * * 1\'\n  workflow_dispatch:\njobs: {}\n')).toEqual(['7 * * * *', '0 6 * * 1']);
    expect(scheduleCrons('on:\n  workflow_call:\njobs: {}\n')).toEqual([]);
    expect(scheduleCrons('on: [push]\njobs: {}\n')).toEqual([]);
  });
});

describe('classifySchedule', () => {
  it('bounds an hourly cron at 14 hours, a daily one at 60 and a weekly one at 14.5 days', () => {
    expect(silenceLimitHours(60, 12)).toBe(14);
    expect(silenceLimitHours(1440, 12)).toBe(60);
    expect(silenceLimitHours(10080, 12)).toBe(348);
  });

  it('passes the longest gap measured on GitHub between two hourly runs (10.5 hours)', () => {
    expect(row({ lastRunAt: hoursBefore(10.5) }).status).toBe('ok');
  });

  it('names an hourly schedule silent past its bound, and not at it', () => {
    expect(row({ lastRunAt: hoursBefore(14) }).status).toBe('ok');
    const r = row({ lastRunAt: hoursBefore(14.1), lastRunUrl: 'https://run/1' });
    expect(r).toMatchObject({ status: 'silent', since: 'run', url: 'https://run/1', limitHours: 14 });
    expect(r.ageHours).toBeCloseTo(14.1);
  });

  it('measures a workflow that never had a scheduled run from its registration', () => {
    expect(row({ lastRunAt: null, workflow: { state: 'active', created_at: hoursBefore(13) } })).toMatchObject({ status: 'ok', since: 'registered' });
    expect(row({ lastRunAt: null, workflow: { state: 'active', created_at: hoursBefore(15) } })).toMatchObject({ status: 'silent', since: 'registered', url: null });
  });

  // kanon#818 — GitHub's `created_at` is when the file was first registered, and its `updated_at`
  // does not move on a push to it, so a `schedule` added to an old file needs the file's last change.
  it('measures a schedule added to an old workflow file from the file\'s last change, not its registration', () => {
    const weekly = { crons: ['0 7 * * 1'], lastRunAt: null, workflow: { state: 'active', created_at: hoursBefore(24 * 120) } };
    expect(row({ ...weekly, changedAt: hoursBefore(30) })).toMatchObject({ status: 'ok', since: 'changed', url: null });
    expect(row({ ...weekly, changedAt: hoursBefore(30) }).ageHours).toBeCloseTo(30);
    expect(row({ ...weekly, changedAt: hoursBefore(349) })).toMatchObject({ status: 'silent', since: 'changed' });
  });

  it('measures a schedule re-added after an old scheduled run from the file\'s last change', () => {
    expect(row({ lastRunAt: hoursBefore(24 * 90), changedAt: hoursBefore(2) })).toMatchObject({ status: 'ok', since: 'changed', url: null });
  });

  it('still measures from a scheduled run newer than the file\'s last change', () => {
    const r = row({ lastRunAt: hoursBefore(15), lastRunUrl: 'https://run/1', changedAt: hoursBefore(400) });
    expect(r).toMatchObject({ status: 'silent', since: 'run', url: 'https://run/1' });
  });

  it('measures as before when the file\'s last change could not be read or was not found', () => {
    const old = { lastRunAt: null, workflow: { state: 'active', created_at: hoursBefore(15) } };
    expect(row({ ...old, changedAt: undefined })).toMatchObject({ status: 'silent', since: 'registered' });
    expect(row({ ...old, changedAt: null })).toMatchObject({ status: 'silent', since: 'registered' });
  });

  it('reads an unreadable answer as unreadable, never as health', () => {
    expect(row({ workflow: null }).status).toBe('unreadable');
    expect(row({ lastRunAt: undefined }).status).toBe('unreadable');
    expect(row({ lastRunAt: null, workflow: { state: 'active' } }).status).toBe('unreadable');
  });

  it('escalates a schedule GitHub disabled, and lists one a person disabled without escalating it', () => {
    expect(row({ workflow: { state: 'disabled_inactivity' } }).status).toBe('disabled');
    expect(row({ workflow: { state: 'disabled_manually' } }).status).toBe('off');
  });

  it('holds a cron it can\'t read to no bound', () => {
    expect(row({ crons: ['bad'], lastRunAt: hoursBefore(1000) }).status).toBe('unknown');
  });
});

describe('the escalation', () => {
  const silent = row({ file: 'a.yml', lastRunAt: hoursBefore(20) });
  const ok = row({ file: 'b.yml' });
  const gone = row({ file: 'c.yml', workflow: null });

  it('names the silent and the disabled, and carries a named one it couldn\'t read', () => {
    const disabled = row({ file: 'd.yml', workflow: { state: 'disabled_inactivity' } });
    expect(nextSilentSet([silent, ok, gone, disabled], null)).toEqual({ named: ['a.yml', 'd.yml'], carried: [] });
    expect(nextSilentSet([ok, gone], ['c.yml', 'b.yml'])).toEqual({ named: ['c.yml'], carried: ['c.yml'] });
    expect(nextSilentSet([ok], ['b.yml'])).toEqual({ named: [], carried: [] });
  });

  it('writes a marker that reads back as the set it names', () => {
    expect(silentSetIn(scheduleMarker(['b.yml', 'a.yml']))).toEqual(['a.yml', 'b.yml']);
    expect(silentSetIn('no marker')).toBeNull();
    const body = renderScheduleFinding([silent, ok, gone], { carried: ['c.yml'] });
    expect(body).toContain(SCHEDULE_MARKER);
    expect(silentSetIn(body)).toEqual(['a.yml', 'c.yml']);
    expect(body).toContain('| `a.yml` | `37 * * * *` | 20.0 hours | 14.0 hours |');
    expect(body).not.toContain('`b.yml`');
    expect(body).toContain('unreadable this tick');
  });

  it('says a schedule is measured from its file\'s last change when that is what it was measured from', () => {
    const changed = row({ file: 'e.yml', lastRunAt: null, changedAt: hoursBefore(20) });
    expect(renderScheduleFinding([changed])).toContain('no scheduled run since its file last changed on the default branch 20.0 hours ago');
  });
});
