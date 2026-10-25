// THE LANE-HEALTH VIEW (project #1327, Issue D): how each of a repository's lane callers has run
// lately, read live, and nothing written anywhere.
//
// THREE ANSWERS THAT ARE ALREADY KANON'S, AND NONE OF ITS OWN (`[STAT-8]`). Which workflows are
// lane callers is `laneCallersIn`'s answer, the library's form of the rule the lane check holds
// callers to, over the default branch's workflows. A lane's state over its recent runs is
// `classifyWorkflow`'s, the workflow-health check's verdict, with that check's window and minimum.
// Why a failed run failed is the agent classifier's, as the run recorded it: the breadcrumb step
// a lane runs when its classify step reports the model unreachable or its API failing mid-run, or
// the review lane's no-verdict step, read off the run's jobs by `retryEvidenceIn`, as the retry
// lanes read it. This file adds no flake classifier: a failed run is `infra` when the classifier
// recorded one of those causes, or when a later attempt of the same run succeeded, and `real`
// otherwise.
//
// A RUN IS `infra` ONLY WHEN EVERY JOB THAT FAILED SAYS SO. A matrix run (the rebase lane's, one
// job per pull request) can carry a capped job beside one that genuinely failed, and calling that
// run `infra` would hide the real failure. A run with no failed job to read is `real`, the safe
// direction: it asks a person to look rather than to wait.
//
// INCOMPLETE IS AN ERROR (`[STAT-3]`), as in every view: a read that failed or came back cut
// short makes the view throw `IncompleteRead`, never answer for the lanes it could read.

import { laneCallersIn } from '../lib/lane-caller.mjs';
import { defaultBranchReader } from '../lib/declarations.mjs';
import { retryEvidenceIn } from '../lane-retry.mjs';
import { MIN_DECISIVE, WINDOW, classifyWorkflow } from '../workflow-health.mjs';
import { IncompleteRead } from './project.mjs';
import { ReadError, incomplete, requireComplete, watched } from './reader.mjs';

/** Where the lane callers live. */
const WORKFLOWS = '.github/workflows';

/** The conclusions the workflow-health check counts as a failed run. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * @typedef {'unreachable' | 'api_error' | 'no_verdict' | 'rerun-succeeded'} InfraReason
 * @typedef {object} Failure one failed run, or one failed attempt of a run a later attempt fixed
 * @property {number} run the run's id
 * @property {number} attempt the attempt that failed
 * @property {string | null} url
 * @property {string | null} createdAt
 * @property {string} conclusion
 * @property {'infra' | 'real'} class
 * @property {InfraReason | null} reason why it is `infra`; null when it is `real`
 * @typedef {object} Lane
 * @property {string} file the caller's file name
 * @property {'ok' | 'red' | 'quiet'} status the workflow-health check's verdict
 * @property {number} decisive the runs that verdict counted
 * @property {number} failed of those, the failed ones
 * @property {'ok' | 'red' | 'flaky' | 'quiet'} health `flaky` when every failure is `infra`
 * @property {Failure[]} failures newest first
 */

/**
 * The lane-health view of one repository. Reads only through `reader`; writes nothing.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, window?: number, minDecisive?: number }} args
 */
export async function laneHealthView({ reader: given, repo, window = WINDOW, minDecisive = MIN_DECISIVE }) {
  const { reader, failures } = watched(given);
  try {
    const answer = await view({ reader, repo, window, minDecisive });
    const failed = failures();
    if (failed.length) throw new IncompleteRead('the lane-health view', failed);
    return answer;
  } catch (e) {
    if (e instanceof IncompleteRead) throw e;
    const failed = failures();
    if (e instanceof ReadError && !failed.includes(e)) failed.push(e);
    if (failed.length) throw new IncompleteRead('the lane-health view', failed);
    throw e;
  }
}

/**
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, window: number, minDecisive: number }} io
 */
async function view({ reader, repo, window, minDecisive }) {
  const files = await defaultBranchReader(reader, repo);
  /** @type {Map<string, string>} */
  const workflows = new Map();
  for (const e of await files.list(WORKFLOWS)) {
    if (e.type !== 'file' || !/\.ya?ml$/.test(e.name)) continue;
    const text = await files.read(e.path);
    if (text !== null) workflows.set(e.name, text);
  }
  /** @type {Lane[]} */
  const callers = [];
  for (const file of laneCallersIn(workflows)) callers.push(await laneOf(file, { reader, repo, window, minDecisive }));
  return { branch: files.branch, window, minDecisive, callers };
}

/**
 * @typedef {{ id?: unknown, conclusion?: unknown, created_at?: unknown, html_url?: unknown, run_attempt?: unknown }} RestRun
 */

/**
 * One caller's recent runs, its verdict, and each failure's class.
 * @param {string} file
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, window: number, minDecisive: number }} io
 * @returns {Promise<Lane>}
 */
async function laneOf(file, { reader, repo, window, minDecisive }) {
  const path = `repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=${window}`;
  const body = /** @type {{ workflow_runs?: RestRun[] } | null} */ (await reader.get(path));
  const runs = body?.workflow_runs;
  if (!Array.isArray(runs)) throw incomplete(reader, `GET ${path}`, 'the answer has no `workflow_runs`');
  const verdict = classifyWorkflow(file, runs.map((r) => ({ conclusion: str(r.conclusion), createdAt: str(r.created_at) ?? undefined, url: str(r.html_url) ?? undefined })), { minDecisive });
  /** @type {Failure[]} */
  const out = [];
  for (const r of runs) {
    const run = Number(r.id);
    const attempt = Number(r.run_attempt) || 1;
    const conclusion = str(r.conclusion);
    if (conclusion && FAILED.has(conclusion)) {
      const reason = await recordedCause(run, { reader, repo });
      out.push({ run, attempt, url: str(r.html_url), createdAt: str(r.created_at), conclusion, class: reason ? 'infra' : 'real', reason });
    } else if (conclusion === 'success' && attempt > 1) {
      // A later attempt succeeded, so each earlier attempt that failed failed of something a
      // re-run cured: `infra`. Newest first, as the runs are.
      for (let n = attempt - 1; n >= 1; n -= 1) {
        const a = /** @type {RestRun | null} */ (await reader.get(`repos/${repo}/actions/runs/${run}/attempts/${n}`));
        const was = str(a?.conclusion);
        if (was && FAILED.has(was)) out.push({ run, attempt: n, url: str(a?.html_url), createdAt: str(a?.created_at), conclusion: was, class: 'infra', reason: 'rerun-succeeded' });
      }
    }
  }
  const status = /** @type {'ok' | 'red' | 'quiet'} */ (verdict.status);
  const health = out.length && out.every((f) => f.class === 'infra') ? 'flaky' : status;
  return { file, status, decisive: verdict.decisive, failed: verdict.failures, health, failures: out };
}

/**
 * The cause the agent classifier recorded on a failed run, when every job that failed recorded
 * one; null otherwise. Read off the latest attempt's jobs, which is the attempt that failed.
 * @param {number} run
 * @param {{ reader: import('./reader.mjs').Reader, repo: string }} io
 * @returns {Promise<'unreachable' | 'api_error' | 'no_verdict' | null>}
 */
async function recordedCause(run, { reader, repo }) {
  const path = `repos/${repo}/actions/runs/${run}/jobs?per_page=100`;
  /** @typedef {{ name?: string, conclusion?: string | null, steps?: Array<{ name?: string, conclusion?: string | null, completed_at?: string | null }> }} Job */
  const pages = /** @type {Array<{ total_count?: number, jobs?: Job[] }>} */ (await reader.pages(path));
  if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p?.jobs))) throw incomplete(reader, `GET ${path}`, 'the answer has no `jobs`');
  const jobs = pages.flatMap((p) => /** @type {Job[]} */ (p.jobs));
  requireComplete(`GET ${path}`, jobs.length, pages[0]?.total_count, reader);
  const failed = jobs.filter((j) => FAILED.has(String(j?.conclusion)));
  if (!failed.length) return null;
  const causes = failed.map((j) => retryEvidenceIn({ jobs: [j] })?.classification ?? null);
  return causes.every(Boolean) ? /** @type {'unreachable' | 'api_error' | 'no_verdict'} */ (causes[0]) : null;
}

/** A string field, or null. @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null);
