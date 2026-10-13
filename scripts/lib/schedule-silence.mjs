// A scheduled lane caller that has gone far longer than its cron without a scheduled run
// (kanon#813). The pure half of `scripts/workflow-health.mjs`'s schedule heartbeat: which
// workflows have a schedule, how long their cron can leave between two ticks, and whether the
// newest scheduled run is older than that allows.
//
// WHY IT EXISTS. GitHub's `schedule` event is best effort: "delayed during periods of high
// loads" and, "if the load is sufficiently high enough, some queued jobs may be dropped"
// (GitHub's docs, "Events that trigger workflows", `schedule`). Measured on Kanon's own
// repository and another one over 2026-10-06..13, an hourly cron fired four to six times a day,
// in batches four to ten hours apart, and a daily cron fired six to nine hours late. GitHub also
// disables a public repository's schedules after 60 days without activity, and runs a schedule
// as whoever last changed its cron, so a deactivated account stops it. None of that turns a run
// red: a schedule that stops firing leaves no run at all, which the red check cannot see and
// GitHub tells nobody about.
//
// THE BOUND: twice the cron's longest gap between two ticks, plus a slack (12 hours by default,
// `QA_SCHEDULE_SLACK_HOURS`). An hourly cron is silent after 14 hours, a daily one after 60, a
// weekly one after 14.5 days. The longest gap measured between two runs of an hourly cron was
// 10.5 hours, so the bound passes GitHub's normal lateness and names a schedule that has stopped.
// A lane that needs a re-ask sooner than that must not wait for its schedule (docs/lanes.md,
// "Schedules are best effort").
//
// DEPENDENCY-FREE: `node:` only, like every script under scripts/ (`K-SELF-8`).

import { parseYaml } from '../../cli/workflow-yaml.mjs';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * One cron field's values, or null when it can't be read. Numbers, `*`, ranges, steps, lists,
 * and month and day names, as GitHub's POSIX cron takes them.
 * @param {string} field @param {number} min @param {number} max @param {string[]} [names]
 * @returns {Set<number>|null}
 */
export function cronField(field, min, max, names = []) {
  /** @param {string} s */
  const value = (s) => {
    const named = names.indexOf(s.toUpperCase());
    if (named >= 0) return named + (names === MONTHS ? 1 : 0);
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };
  const out = new Set();
  for (const part of field.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!(step > 0)) return null;
    let lo;
    let hi;
    const range = m[1] ?? '';
    if (range === '*') [lo, hi] = [min, max];
    else {
      const [a = '', b] = range.split('-');
      lo = value(a);
      hi = b === undefined ? (m[2] === undefined ? lo : max) : value(b);
    }
    // Day 7 is Sunday too.
    if (max === 6 && lo === 7 && hi === 7) {
      lo = 0;
      hi = 0;
    } else if (max === 6 && hi === 7) {
      if ((7 - lo) % step === 0) out.add(0);
      hi = 6;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const SPAN_DAYS = 1827; // five years from 2024-01-01, so a leap day's cron ticks twice

/**
 * The longest time, in minutes, that `crons` can leave between two ticks, together. Null when
 * one can't be read or they tick fewer than twice in five years.
 * @param {string[]} crons
 * @returns {number|null}
 */
export function cronGapMinutes(crons) {
  if (!crons.length) return null;
  const parsed = [];
  for (const cron of crons) {
    const f = String(cron).trim().split(/\s+/);
    if (f.length !== 5) return null;
    const [mi = '', ho = '', dm = '', mo = '', dw = ''] = f;
    const minute = cronField(mi, 0, 59);
    const hour = cronField(ho, 0, 23);
    const dom = cronField(dm, 1, 31);
    const month = cronField(mo, 1, 12, MONTHS);
    const dow = cronField(dw, 0, 6, DAYS);
    if (!minute || !hour || !dom || !month || !dow) return null;
    // POSIX: when both day fields are restricted, a day matching either one ticks.
    parsed.push({ minute, hour, dom, month, dow, either: !dm.startsWith('*') && !dw.startsWith('*') });
  }
  const ticks = new Set();
  const start = Date.UTC(2024, 0, 1);
  for (let d = 0; d < SPAN_DAYS; d++) {
    const day = new Date(start + d * 86_400_000);
    for (const c of parsed) {
      if (!c.month.has(day.getUTCMonth() + 1)) continue;
      const domHit = c.dom.has(day.getUTCDate());
      const dowHit = c.dow.has(day.getUTCDay());
      if (!(c.either ? domHit || dowHit : domHit && dowHit)) continue;
      for (const h of c.hour) for (const m of c.minute) ticks.add(d * 1440 + h * 60 + m);
    }
  }
  const sorted = [...ticks].sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  let gap = 0;
  for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i] - sorted[i - 1]);
  return gap;
}

/**
 * The crons a workflow's `on.schedule` lists, or `[]` when it has none. Throws a `YamlError` on a
 * file the reader can't parse.
 * @param {string} text
 * @returns {string[]}
 */
export function scheduleCrons(text) {
  const wf = parseYaml(text);
  const on = wf && typeof wf === 'object' ? /** @type {Record<string, any>} */ (wf).on : null;
  const schedule = on && typeof on === 'object' && !Array.isArray(on) ? on.schedule : null;
  if (!Array.isArray(schedule)) return [];
  return schedule.map((s) => (s && typeof s === 'object' ? s.cron : null)).filter((c) => typeof c === 'string');
}

/**
 * How long after its newest scheduled run a workflow is silent, in hours.
 * @param {number} gapMinutes @param {number} slackHours
 */
export const silenceLimitHours = (gapMinutes, slackHours) => (2 * gapMinutes) / 60 + slackHours;

/**
 * One scheduled workflow's verdict. Pure.
 *
 * - `unreadable`: its state or runs could not be read. Not health.
 * - `off`: someone disabled it by hand; that is a choice, so it is listed and not escalated.
 * - `disabled`: GitHub disabled it (60 days without activity in a public repository) or it
 *   isn't active for another reason no person chose.
 * - `unknown`: its cron can't be read, so there is no bound to hold it to.
 * - `silent`: its newest scheduled run, or, with none, the workflow's own registration, is older
 *   than the bound.
 * - `ok` otherwise.
 *
 * @param {{ file: string, crons: string[], workflow: { state?: string, created_at?: string } | null,
 *   lastRunAt: string | null | undefined, lastRunUrl?: string | null }} input
 *   `workflow` null and `lastRunAt` undefined mean the read failed; `lastRunAt` null means no
 *   scheduled run exists.
 * @param {Date|string|number} now
 * @param {{ slackHours: number }} opts
 * @returns {{ file: string, status: 'ok'|'silent'|'disabled'|'off'|'unknown'|'unreadable',
 *   cron: string, ageHours: number|null, limitHours: number|null, since: 'run'|'registered'|null, url: string|null }}
 */
export function classifySchedule({ file, crons, workflow, lastRunAt, lastRunUrl = null }, now, { slackHours }) {
  const cron = crons.join(', ');
  const base = { file, cron, ageHours: null, limitHours: null, since: null, url: null };
  if (workflow === null || lastRunAt === undefined) return { ...base, status: 'unreadable' };
  if (workflow.state === 'disabled_manually') return { ...base, status: 'off' };
  if (workflow.state !== 'active') return { ...base, status: 'disabled' };
  const gap = cronGapMinutes(crons);
  if (gap === null) return { ...base, status: 'unknown' };
  const limitHours = silenceLimitHours(gap, slackHours);
  const from = lastRunAt ?? workflow.created_at ?? null;
  const at = from ? new Date(from).getTime() : NaN;
  if (!Number.isFinite(at)) return { ...base, status: 'unreadable', limitHours };
  const ageHours = (new Date(now).getTime() - at) / 3_600_000;
  return {
    ...base,
    status: ageHours > limitHours ? 'silent' : 'ok',
    ageHours,
    limitHours,
    since: lastRunAt ? 'run' : 'registered',
    url: lastRunAt ? lastRunUrl : null,
  };
}

/** The marker that finds the escalation, carrying the set it names so a refresh is exact. */
export const SCHEDULE_MARKER = '<!-- qa:schedule-heartbeat';
/** @param {string[]} files */
export const scheduleMarker = (files) => `${SCHEDULE_MARKER} silent=${[...files].sort().join(',')} -->`;
/** @param {string|null|undefined} body @returns {string[]|null} */
export const silentSetIn = (body) => {
  const m = /<!-- qa:schedule-heartbeat silent=([^>]*)-->/.exec(body ?? '');
  return m ? (m[1] ?? '').trim().split(',').filter(Boolean) : null;
};
export const SCHEDULE_TITLE = '[pipeline] scheduled workflow(s) silent far longer than their cron';

/** The verdicts the escalation names. */
export const ESCALATED = new Set(['silent', 'disabled']);

/**
 * The set the escalation names this tick: every silent or disabled workflow, plus any it named
 * before that couldn't be read this tick, which is not known to have recovered. Pure.
 * @param {ReturnType<typeof classifySchedule>[]} rows
 * @param {string[]|null} previous
 * @returns {{ named: string[], carried: string[] }}
 */
export function nextSilentSet(rows, previous) {
  const named = rows.filter((r) => ESCALATED.has(r.status)).map((r) => r.file);
  const unreadable = new Set(rows.filter((r) => r.status === 'unreadable').map((r) => r.file));
  const carried = (previous ?? []).filter((f) => unreadable.has(f) && !named.includes(f));
  return { named: [...named, ...carried].sort(), carried: carried.sort() };
}

/** @param {number|null} h */
const hours = (h) => (h === null ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} hours`);

/**
 * The escalation body. Pure, so what a person reads is assertable.
 * @param {ReturnType<typeof classifySchedule>[]} rows
 * @param {{ carried?: string[] }} [opts]
 */
export function renderScheduleFinding(rows, { carried = [] } = {}) {
  const named = rows.filter((r) => ESCALATED.has(r.status));
  const why = (/** @type {ReturnType<typeof classifySchedule>} */ r) =>
    r.status === 'disabled'
      ? 'GitHub has disabled the workflow, so its schedule never fires: re-enable it in the Actions tab'
      : r.since === 'run'
        ? `newest scheduled run ${hours(r.ageHours)} ago${r.url ? ` ([run](${r.url}))` : ''}`
        : `no scheduled run since the workflow was registered ${hours(r.ageHours)} ago`;
  return [
    `These workflows have a \`schedule\` that has not fired for far longer than its cron allows. GitHub runs a schedule late or drops it under load, so this check allows twice the cron's longest gap plus a slack before it names one; a schedule past that has most likely stopped.`,
    '',
    '| workflow | cron | silent for | allowed | why |',
    '|---|---|---|---|---|',
    ...named.map((r) => `| \`${r.file}\` | \`${r.cron}\` | ${hours(r.ageHours)} | ${hours(r.limitHours)} | ${why(r)} |`),
    '',
    ...(carried.length ? [`Still named, but unreadable this tick, so not known to have recovered: ${carried.map((f) => `\`${f}\``).join(', ')}.`, ''] : []),
    'What stops a schedule: GitHub disables a public repository\'s schedules after 60 days without activity; it runs a schedule as whoever last changed the cron, and stops when that account is no longer active; and it only reads the workflow file on the default branch. Pushing a change to the workflow file re-registers its schedule. A dispatch of the workflow runs it now, but does not count as a scheduled run here.',
    '',
    'Why this is filed: a schedule that stops leaves no run at all, so no run turns red and GitHub tells nobody. Every lane that waits for its sweep waits with it.',
    '',
    'This issue is refreshed when the set of silent workflows changes, and closed automatically once each one has a scheduled run inside its bound, but never on a tick that could not read one of them.',
    '',
    scheduleMarker([...named.map((r) => r.file), ...carried]),
  ].join('\n');
}
