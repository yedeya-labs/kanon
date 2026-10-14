// The deploy lane's issues (plan 0010 §8, decision 10, step D4): one open issue per environment,
// written by a script in the `report` jobs, never by a model, with the workflow token's
// `issues: write` and nothing else: no checkout, no cloud credential.
//
// ONE ISSUE PER ENVIRONMENT, FOUND BY ITS TITLE, `Deploy to <environment> failed`.
//   • A failure (`failed`, `smoke_failed`) or a refusal (`refused`, `K-SHIP-8`'s "announce a
//     refusal") files the issue, or comments on it when one is open.
//   • A successful deploy (`ok`) closes that environment's open issue, if there is one.
//   • A rejection or a cancellation files nothing: a person decided it, and the run says so.
// Labelled `bug`, and `sev:high` for production (the last environment), `sev:medium` for every
// other one. The body holds the release, the stage, the refusal's code and the run's link, never
// a log line: a deploy log can hold what the adopter's `## Data` answer keeps private.
//
// A HELD PRODUCTION (kanon#894: under a fallback marker, on a `release` run) is neither a deploy
// nor a failure: nothing is filed, commented on or closed. A production dispatch refused because
// its actor isn't the Maintainer files as a refusal, `not-maintainer`.
//
// A RUN THAT STOPPED BEFORE ANY ENVIRONMENT (the gate or the probe) files on the FIRST
// environment's issue (open-question decision 4), `sev:medium`, or `sev:high` when the first is
// the only one: `deploy-release.yml`'s `report` job.
//
// ENV  NEEDS          `toJSON(needs)` of the report job: the jobs it judges, and the `record` job,
//                     whose `outcome` (read from the run's approvals) it prefers
//      ENVIRONMENT, POSITION  the call's own (`environment`); ENVIRONMENTS, the caller's list (`release`)
//      RELEASE        the release's tag, for the body
//      RUN_URL        the run's link
//      GITHUB_REPOSITORY, GH_TOKEN (the job's `issues: write` token)

import { ghApi, splitEnvironments } from './deploy-gate.mjs';
import { classifyEnvironment, classifyRelease } from './deploy-row.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { ROLES } from './lib/deploy-declaration.mjs';

/** The outcomes that file, or comment on, the environment's issue. */
export const FILES = Object.freeze(['failed', 'smoke_failed', 'refused']);

/** The issue's fixed title, by which it is found again. */
export const issueTitle = (/** @type {string} */ environment) => `Deploy to ${environment} failed`;

/** The severity label: production is `sev:high`, every other environment `sev:medium`. */
export const severity = (/** @type {string} */ role) => (role === ROLES.production ? 'sev:high' : 'sev:medium');

/** The most pages of open issues read to find the environment's. */
const MAX_PAGES = 10;

/**
 * The environment's open issue, by its exact title, or `null`.
 * @param {import('./deploy-gate.mjs').Api} api @param {string} repo @param {string} environment
 */
export function findIssue(api, repo, environment) {
  const title = issueTitle(environment);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = api(`repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    const items = Array.isArray(list) ? list : [];
    const hit = items.find((/** @type {any} */ i) => !i?.pull_request && i?.title === title);
    if (hit) return hit;
    if (items.length < 100) return null;
  }
  return null;
}

const WHAT = /** @type {Record<string, string>} */ ({
  failed: 'failed',
  smoke_failed: 'deployed, but its smoke check failed',
  refused: 'was refused',
});

/**
 * @typedef {{ environment: string, role: string, position: number, outcome: string, failed_stage?: string, refusal?: string, release: string, runUrl: string }} Report
 */

/** The text of a failure, for the body or a comment: no log line. @param {Report} r */
export function failureText(r) {
  const where = r.failed_stage ? ` at the \`${r.failed_stage}\` stage` : '';
  const code = r.refusal ? `, \`${r.refusal}\`` : '';
  return `The deploy of release \`${r.release || 'unknown'}\` to \`${r.environment}\` (${r.role}, environment ${r.position}) ${WHAT[r.outcome] ?? r.outcome}${where}${code}.\n\nRun: ${r.runUrl}`;
}

/**
 * Files, comments on, or closes the environment's issue. Returns what it did.
 * @param {Report & { repo: string, api?: import('./deploy-gate.mjs').Api }} r
 * @returns {{ action: 'filed' | 'commented' | 'closed' | 'none', number?: number }}
 */
export function report({ repo, api = ghApi, ...r }) {
  const open = findIssue(api, repo, r.environment);
  if (r.outcome === 'ok') {
    if (!open) return { action: 'none' };
    api(`repos/${repo}/issues/${open.number}/comments`, { method: 'POST', body: { body: `Release \`${r.release || 'unknown'}\` deployed to \`${r.environment}\`: closing.\n\nRun: ${r.runUrl}` } });
    api(`repos/${repo}/issues/${open.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    return { action: 'closed', number: open.number };
  }
  if (!FILES.includes(r.outcome)) return { action: 'none' };
  if (open) {
    api(`repos/${repo}/issues/${open.number}/comments`, { method: 'POST', body: { body: failureText(r) } });
    return { action: 'commented', number: open.number };
  }
  const created = api(`repos/${repo}/issues`, {
    method: 'POST',
    body: {
      title: issueTitle(r.environment),
      body: `${failureText(r)}\n\nThe deploy lane files one issue per environment (plan 0010 §8), comments on it at each later failure, and closes it at the next successful deploy to \`${r.environment}\`. It holds no log line: read the run.`,
      labels: ['bug', severity(r.role)],
    },
  });
  return { action: 'filed', number: created?.number };
}

/**
 * What the report job reports: the record's outcome when it wrote one, else the jobs' own.
 * @param {Record<string, string | undefined>} env @param {'environment' | 'release'} kind
 * @returns {Report | null}
 */
export function reportFrom(env, kind) {
  const needs = JSON.parse(env.NEEDS || '{}');
  const rec = needs.record?.outputs ?? {};
  const base = { release: String(env.RELEASE ?? ''), runUrl: String(env.RUN_URL ?? '') };
  if (kind === 'release') {
    const ending = rec.written === 'true' ? { outcome: rec.outcome, failed_stage: rec.stage || undefined, refusal: rec.refusal || undefined } : classifyRelease(needs);
    if (!ending || rec.written === 'false') return null;
    const list = splitEnvironments(needs.gate?.outputs?.environments || env.ENVIRONMENTS);
    if (!list.length) return null;
    return { ...base, environment: /** @type {string} */ (list[0]), position: 1, role: list.length > 1 ? ROLES.preProduction : ROLES.production, ...ending };
  }
  const environment = String(env.ENVIRONMENT ?? '');
  const declared = needs.declare?.outputs ?? {};
  // A held production neither files, comments nor closes (kanon#894).
  if (declared.held === 'true') return null;
  if (declared.unauthorized) {
    return { ...base, environment, position: Number(env.POSITION), role: ROLES.production, outcome: 'refused', failed_stage: 'gate', refusal: declared.unauthorized };
  }
  const ending = rec.outcome ? { outcome: rec.outcome, failed_stage: rec.stage || undefined, refusal: rec.refusal || undefined } : classifyEnvironment({ ...needs, environment });
  const role = needs.declare?.outputs?.role === ROLES.preProduction ? ROLES.preProduction : ROLES.production;
  return { ...base, environment, position: Number(env.POSITION), role, ...ending };
}

if (isCliEntry(import.meta.url)) {
  const kind = process.argv[2];
  if (!process.env.GITHUB_REPOSITORY) {
    console.error('deploy-report: GITHUB_REPOSITORY must be set; the runner sets it, and the lane never guesses a repository');
    process.exit(2);
  }
  if (kind !== 'environment' && kind !== 'release') {
    console.error('usage: deploy-report.mjs environment | release');
    process.exit(2);
  }
  const r = reportFrom(process.env, kind);
  if (!r) {
    console.log(kind === 'release'
      ? 'The run went on to the environments, which report their own: nothing to report here.'
      : 'Production is held for the Maintainer\'s dispatch: no issue is filed, commented on or closed.');
  }
  else {
    const done = report({ repo: String(process.env.GITHUB_REPOSITORY), ...r });
    console.log(done.action === 'none'
      ? `\`${r.environment}\`: ${r.outcome}, nothing to file or close.`
      : `\`${r.environment}\`: ${r.outcome}; ${done.action} issue #${done.number}.`);
  }
}
