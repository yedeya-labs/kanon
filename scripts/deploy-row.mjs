// The deploy lane's `deploy` row (plan 0010 §8, §10, step D4): one row per environment of a
// release, written by the `record` jobs from the jobs' conclusions and outputs, never by a model.
//
// TWO RECORDS.
//   • `environment`, in `deploy.yml`'s `record` job, for that call's environment: it reads the
//     `declare` and `deploy` jobs' results and outputs (`toJSON(needs)`), and, when the deploy
//     job failed without running a step, the run's approvals.
//   • `release`, in `deploy-release.yml`'s `record` job: a run that stops before any environment
//     (the gate or the probe) never starts the environment calls, so this writes ONE row, for the
//     first environment, with that outcome and stage (open-question decision 4). When the run
//     went on to the environments it writes nothing: each environment writes its own, and one
//     stopped release is never counted as N failures. A probe skipped under the `no-environments`
//     marker went on (the probe decision). Plan 0010's D5 adds the build job between the probe
//     and the environments; it joins `classifyRelease` there.
//
// A REJECTION IS READ FROM THE APPROVALS, NOT THE CONCLUSION (kanon#890, D0's probe 7). A job a
// reviewer rejected concludes `failure` with no step and no log, exactly as a job that failed
// before its first step would. So when the deploy job failed without starting, the record reads
// `GET /repos/{o}/{r}/actions/runs/{id}/approvals`: an entry for this environment in state
// `rejected` is `rejected` at `approval`; `approved` and `skipped` (an approval given with
// self-review unticked lists as `skipped`) admitted it, so anything else is `failed`. A waiting
// job whose run was cancelled concludes `cancelled`, at `approval`.
//
// WHAT THE ROW CARRIES (§10): the environment's role and position, never its name; no commit, no
// tag, no URL. The row is validated with the schema before it is written: a row that fails is a
// bug here, and the step fails by field name, never by echoing a value (ADR 0007).
//
// THE ARTIFACT. The row is uploaded as `kanon-deploy-row-<run id>-<attempt>-<position>`
// (`deployArtifactName`), holding `kanon-deploy-row.json`. Not under `kanon-telemetry-`, which
// only a lane's run row may carry (kanon#826). The name and the file are the collector's, from
// `lib/telemetry-artifacts.mjs`, so the upload can't drift from what it lists (kanon#919).
//
// ENV  NEEDS          `toJSON(needs)` of the record job
//      ENVIRONMENTS   the caller's list (`release`)
//      ENVIRONMENT, POSITION  the call's own (`environment`)
//      GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_EVENT_NAME, RUNNER_TEMP
//      KANON_WORKFLOW_REF, KANON_WORKFLOW_SHA  `job.workflow_ref` and `job.workflow_sha`: Kanon's release
//      GH_TOKEN       the job's `actions: read` token, for the approvals and the run's start

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { kanonVersion } from '../actions/agent-telemetry/agent-telemetry.mjs';
import { describeErrors, validate } from '../actions/agent-telemetry/schema.mjs';
import { ghApi, splitEnvironments } from './deploy-gate.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { ROLES } from './lib/deploy-declaration.mjs';
import { DEPLOY_ARTIFACT_FILE, DEPLOY_ARTIFACT_PREFIX, deployArtifactName } from './lib/telemetry-artifacts.mjs';

export { DEPLOY_ARTIFACT_FILE, DEPLOY_ARTIFACT_PREFIX, deployArtifactName };

/**
 * @typedef {{ result?: string, outputs?: Record<string, string | undefined> }} JobResult
 * @typedef {{ outcome: string, failed_stage?: string, refusal?: string }} Ending
 */

/** The stage a refusal stopped at (§10): the probe's two at `probe`, `superseded` at `deploy`, the gate's codes at `gate`. */
export const stageOfRefusal = (/** @type {string} */ code) =>
  (code === 'trust-unbound' || code === 'probe-unconfigured' ? 'probe' : code === 'superseded' ? 'deploy' : 'gate');

/** @param {JobResult | undefined} job @param {string} stage @returns {Ending} */
const stopped = (job, stage) => {
  const refusal = job?.outputs?.refusal;
  if (refusal) return { outcome: 'refused', failed_stage: stageOfRefusal(refusal), refusal };
  if (job?.result === 'cancelled') return { outcome: 'cancelled', failed_stage: stage };
  return { outcome: 'failed', failed_stage: stage };
};

/**
 * How a run that may have stopped before any environment ended, or `null` when it went on to
 * the environments, which then write their own rows.
 * @param {{ gate?: JobResult, probe?: JobResult }} needs
 * @returns {Ending | null}
 */
export function classifyRelease({ gate, probe }) {
  if (gate?.result !== 'success') return stopped(gate, 'gate');
  if (probe?.result === 'success') return null;
  // The probe decision: under the `no-environments` marker the probe is skipped, and the run goes on.
  if (probe?.result === 'skipped' && gate.outputs?.fallback === 'no-environments') return null;
  return stopped(probe, 'probe');
}

/**
 * Whether a reviewer rejected this environment's deploy in this run (kanon#890).
 * @param {unknown} approvals the run's approvals, as the API returns them
 * @param {string} environment
 */
export function rejectedIn(approvals, environment) {
  return (Array.isArray(approvals) ? approvals : []).some((/** @type {any} */ a) => a?.state === 'rejected'
    && (Array.isArray(a?.environments) ? a.environments : []).some((/** @type {any} */ e) => e?.name === environment));
}

/**
 * How one environment's call ended.
 * @param {{ declare?: JobResult, deploy?: JobResult, approvals?: () => unknown, environment: string }} o
 *   `approvals` is read only when the deploy job failed before its first step.
 * @returns {Ending}
 */
export function classifyEnvironment({ declare, deploy, approvals = () => [], environment }) {
  // A failed `declare` is never a hold: the hold is read from its `held` output alone
  // (`heldOrUnrecorded`), which a failed job leaves empty, never inferred from `deploy` being
  // skipped. Its stage is `gate`, the closest existing one, PENDING #886, which decides the stage
  // of a failure before the environment's job.
  if (declare?.result !== 'success') return stopped(declare, 'gate');
  const o = deploy?.outputs ?? {};
  const started = Boolean(o['started-at']);
  switch (deploy?.result) {
    case 'success':
      return { outcome: 'ok' };
    case 'failure':
      if (o.refusal) return stopped(deploy, 'deploy');
      if (!started) return rejectedIn(approvals(), environment) ? { outcome: 'rejected', failed_stage: 'approval' } : { outcome: 'failed', failed_stage: 'approval' };
      if (o['smoke-outcome'] === 'failure') return { outcome: 'smoke_failed', failed_stage: 'smoke' };
      return { outcome: 'failed', failed_stage: 'deploy' };
    case 'cancelled':
      return { outcome: 'cancelled', failed_stage: o['deploy-ended-at'] ? 'smoke' : started ? 'deploy' : 'approval' };
    default:
      // Skipped after its declaration passed: it never reached a runner.
      return { outcome: 'cancelled', failed_stage: 'approval' };
  }
}

/** Milliseconds between two ISO times, or `undefined` when either is missing or they run backwards. */
export const between = (/** @type {string | undefined} */ from, /** @type {string | undefined} */ to) => {
  const a = Date.parse(String(from ?? ''));
  const b = Date.parse(String(to ?? ''));
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined;
};

/**
 * One row, validated. Undefined fields are left out.
 * @param {Record<string, unknown>} fields
 */
export function buildRow(fields) {
  const row = Object.fromEntries(Object.entries({ schema_version: 1, row_kind: 'deploy', tag: 'run', ...fields }).filter(([, v]) => v !== undefined && v !== ''));
  const v = validate(row);
  if (!v.ok) throw new Error(`the deploy row doesn't validate: ${describeErrors(v.errors)}`);
  return row;
}

/** The run's own fields. @param {Record<string, string | undefined>} env @param {Date} now */
const runFields = (env, now) => ({
  recorded_at: now.toISOString(),
  run_id: Number(env.GITHUB_RUN_ID),
  run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
  trigger: env.GITHUB_EVENT_NAME === 'release' || env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? env.GITHUB_EVENT_NAME : undefined,
  kanon_version: kanonVersion(env.KANON_WORKFLOW_SHA ?? '', env.KANON_WORKFLOW_REF ?? '', env.KANON_WORKFLOW_SHA ?? ''),
});

const bool = (/** @type {string | undefined} */ v) => (v === 'true' ? true : v === 'false' ? false : undefined);

/**
 * The release record's row: one, for the first environment, or `null`.
 * @param {Record<string, string | undefined>} env
 * @param {{ now?: Date }} [deps]
 */
export function releaseRow(env, { now = new Date() } = {}) {
  const needs = /** @type {{ gate?: JobResult, probe?: JobResult }} */ (JSON.parse(env.NEEDS || '{}'));
  const ending = classifyRelease(needs);
  if (!ending) return null;
  const count = splitEnvironments(needs.gate?.outputs?.environments || env.ENVIRONMENTS).length;
  return buildRow({
    ...runFields(env, now),
    role: count > 1 ? ROLES.preProduction : ROLES.production,
    position: 1,
    ...ending,
    prerelease: bool(needs.gate?.outputs?.prerelease),
  });
}

/**
 * Whether this environment's call writes no row:
 *   • HELD (kanon#894): production on a `release` run under a fallback marker waits for the
 *     Maintainer's dispatch. It is neither a deploy nor a failure, so a row would only distort
 *     the production metrics; the dispatch writes production's one row.
 *   • A production attempt by anyone but the Maintainer under a marker, refused by `declare` or,
 *     on a re-run of the failed jobs, by the `deploy` job's own check:
 *     its refusal code, `not-maintainer`, reaches `DEPLOY_REFUSALS` only with PR #901 (kanon#899), so no row until that merges. The
 *     report still announces it.
 * @param {JobResult | undefined} declare @param {JobResult | undefined} [deploy]
 */
export const heldOrUnrecorded = (declare, deploy) => declare?.outputs?.held === 'true'
  || Boolean(declare?.outputs?.unauthorized) || Boolean(deploy?.outputs?.unauthorized);

/**
 * An environment record's row: one, or `null` when it is held or awaits its refusal code.
 * @param {Record<string, string | undefined>} env
 * @param {{ now?: Date, api?: import('./deploy-gate.mjs').Api }} [deps]
 */
export function environmentRow(env, { now = new Date(), api = ghApi } = {}) {
  const needs = /** @type {{ declare?: JobResult, deploy?: JobResult }} */ (JSON.parse(env.NEEDS || '{}'));
  const repo = String(env.GITHUB_REPOSITORY);
  const environment = String(env.ENVIRONMENT ?? '');
  if (heldOrUnrecorded(needs.declare, needs.deploy)) return null;
  const ending = classifyEnvironment({
    ...needs,
    environment,
    approvals: () => api(`repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}/approvals`),
  });
  const d = needs.declare?.outputs ?? {};
  const o = needs.deploy?.outputs ?? {};
  let runStarted;
  if (o['started-at']) {
    try {
      runStarted = String(api(`repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}`)?.run_started_at ?? '');
    } catch {
      runStarted = undefined;
    }
  }
  return buildRow({
    ...runFields(env, now),
    role: d.role === ROLES.preProduction ? ROLES.preProduction : ROLES.production,
    position: Number(env.POSITION),
    ...ending,
    prerelease: bool(d.prerelease),
    redeploy: bool(o.redeploy),
    // Only a dispatch's supersede check says `true` (§3); the schema refuses it on a release.
    rollback: bool(o.rollback),
    wait_ms: between(runStarted, o['started-at']),
    deploy_ms: between(o['deploy-started-at'], o['deploy-ended-at']),
    smoke_ms: between(o['deploy-ended-at'], o['ended-at']),
    duration_ms: between(o['started-at'], o['ended-at']),
    since_release_ms: between(d['published-at'], o['ended-at']),
  });
}

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const command = process.argv[2];
  if (!env.GITHUB_REPOSITORY) {
    console.error('deploy-row: GITHUB_REPOSITORY must be set; the runner sets it, and the lane never guesses a repository');
    process.exit(2);
  }
  if (command !== 'release' && command !== 'environment') {
    console.error('usage: deploy-row.mjs release | environment');
    process.exit(2);
  }
  const row = command === 'release' ? releaseRow(env) : environmentRow(env);
  const out = (/** @type {string} */ line) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line); };
  if (!row) {
    console.log(command === 'release'
      ? 'The run went on to the environments, which record their own rows: nothing to record here.'
      : 'Production is held for the Maintainer\'s dispatch, or its dispatch was refused for an actor who isn\'t the Maintainer: no row.');
    out('written=false\n');
  } else {
    const dir = join(env.RUNNER_TEMP ?? '.', 'kanon-deploy-row');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DEPLOY_ARTIFACT_FILE), `${JSON.stringify(row)}\n`);
    console.log(`Recorded a deploy row: ${row.role}, position ${row.position}, ${row.outcome}${row.failed_stage ? ` at ${row.failed_stage}` : ''}${row.refusal ? ` (${row.refusal})` : ''}.`);
    out(`written=true\noutcome=${row.outcome}\nstage=${row.failed_stage ?? ''}\nrefusal=${row.refusal ?? ''}\nrole=${row.role}\n`);
  }
}
