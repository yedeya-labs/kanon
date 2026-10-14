#!/usr/bin/env node
// Is a re-asked run of a sweeping lane due? (kanon#813)
//
// GitHub's `schedule` is best effort: an hourly cron fires a few times a day and a daily one
// hours late (docs/lanes.md, "Schedules are best effort"). So the dispatch sweep and the
// Lead's reconciler are also re-asked by an event: a run of a lane they cover completing, which
// their callers hear through `workflow_run`. Those runs come far more often than the cadence
// the lane was built for, and the dispatch sweep must not run more often than daily (its
// re-dispatch cooldown assumes that cadence). So a re-ask acts only when the lane has not
// worked inside its cadence: when no run of the same caller, besides this one, ran the lane's
// working job (`REASK_JOB`), or that job's working step (`REASK_STEP`, for a lane whose one job
// also holds the gate), within `REASK_HOURS`. A re-ask that declined left that job or step
// skipped, so it does not count, and the next re-ask after the cadence acts. The cron stays
// as the floor for a repository where nothing else runs.
//
// THIS IS ALSO THE LOOP GUARD. A sweep that re-labels an issue starts the lane that re-asks it;
// that lane's completion finds the sweep's own run inside the window, and stops there.
//
// FAILS OPEN: a listing it cannot read says `due=true`, with a warning. The lanes it gates are
// safety nets, idempotent per tick, and bounded by their own caps, so an extra run costs a
// short job; a silent `false` would leave the work for a schedule that may not come.
//
// Env: GH_TOKEN (`actions: read`), GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF (the caller's, in a
// called workflow), GITHUB_RUN_ID, REASK_JOB, REASK_STEP (optional), REASK_HOURS. Writes
// `due=true|false` to GITHUB_OUTPUT and one line to the step summary. Node built-ins and `gh`
// only: the lanes that run it install nothing.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The most runs inside the window a check reads the jobs of. Past it, the re-ask is due. */
export const MAX_RUNS_READ = 30;

/**
 * The caller's workflow file name from `GITHUB_WORKFLOW_REF`
 * (`owner/repo/.github/workflows/<file>@<ref>`), or null when it is not that shape.
 * @param {string | undefined} ref
 */
export function callerFileOf(ref) {
  const m = /^[^/]+\/[^/]+\/\.github\/workflows\/([^/@]+\.ya?ml)@/.exec(String(ref ?? ''));
  return m ? m[1] : null;
}

/** @typedef {{ name?: string, status?: string, conclusion?: string | null }} Step */
/** @typedef {Step & { steps?: Step[] }} Job */

/** Did a job or step work, or is it about to? Queued or running counts; `skipped` does not. @param {Step | undefined} x */
const worked = (x) => Boolean(x) && (x?.status !== 'completed' || (x?.conclusion !== 'skipped' && x?.conclusion != null));

/**
 * Did this run reach the lane's working job, or that job's working step? A called workflow's
 * jobs are listed as `<caller job> / <job>`. A step is matched by its name, exactly. A job not
 * yet started, with no steps listed, counts: it is about to work.
 * @param {Job[] | null | undefined} jobs
 * @param {string} job
 * @param {string} [step]
 */
export function ranJob(jobs, job, step) {
  return (jobs ?? []).some((j) => {
    const name = String(j?.name ?? '');
    if (name !== job && !name.endsWith(` / ${job}`)) return false;
    if (!step) return worked(j);
    if (j?.status !== 'completed' && !(j?.steps ?? []).length) return true;
    return worked((j?.steps ?? []).find((s) => s?.name === step));
  });
}

/**
 * The decision, pure. `runs` are the caller's runs created inside the window, any order;
 * `jobsOf(id)` reads one run's jobs and may throw.
 * @param {{ runs: Array<{ id: number | string, created_at?: string }>, jobsOf: (id: number | string) => Job[], job: string, step?: string, runId?: string | number }} o
 * @returns {{ due: boolean, why: string, by?: { id: number | string } }}
 */
export function reaskDue({ runs, jobsOf, job, step, runId }) {
  const what = step ? `\`${job}\`'s step "${step}"` : `\`${job}\``;
  const others = [...runs]
    .filter((r) => String(r.id) !== String(runId ?? ''))
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
  for (const r of others.slice(0, MAX_RUNS_READ)) {
    if (ranJob(jobsOf(r.id), job, step)) return { due: false, why: `run ${r.id} ran ${what} inside the window`, by: r };
  }
  return others.length > MAX_RUNS_READ
    ? { due: true, why: `none of the newest ${MAX_RUNS_READ} runs inside the window ran ${what}` }
    : { due: true, why: `no other run inside the window ran ${what}` };
}

const ghJson = (/** @type {string[]} */ args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const job = process.env.REASK_JOB || '';
  const step = process.env.REASK_STEP || undefined;
  const hours = Number(process.env.REASK_HOURS);
  const file = callerFileOf(process.env.GITHUB_WORKFLOW_REF);
  const out = (/** @type {boolean} */ due, /** @type {string} */ why) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
    const line = due ? `Re-asked by an event, and due: ${why}.` : `Re-asked by an event, and not due: ${why}. The next re-ask, or the schedule, runs it.`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    console.log(line);
  };
  if (!repo || !job || !Number.isFinite(hours) || hours <= 0 || !file) {
    console.log(`::warning title=reask-due::cannot tell whether the re-ask is due (repository '${repo ?? ''}', job '${job}', hours '${process.env.REASK_HOURS ?? ''}', caller '${process.env.GITHUB_WORKFLOW_REF ?? ''}'); running it.`);
    out(true, 'its inputs could not be read');
    return;
  }
  const since = new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const runs = ghJson(['api', '-X', 'GET', `repos/${repo}/actions/workflows/${file}/runs`, '-f', `created=>=${since}`, '-f', 'per_page=100']).workflow_runs ?? [];
    const jobsOf = (/** @type {number | string} */ id) => ghJson(['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]).jobs ?? [];
    const d = reaskDue({ runs, jobsOf, job, step, runId: process.env.GITHUB_RUN_ID });
    out(d.due, `${d.why} (${hours}h)`);
  } catch (e) {
    console.log(`::warning title=reask-due::could not read the runs of ${file}: ${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]}. Running the re-ask.`);
    out(true, "the caller's runs could not be read");
  }
}

if (isCliEntry(import.meta.url)) main();
