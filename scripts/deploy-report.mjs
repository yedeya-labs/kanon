// The deploy lane's issues (plan 0010 §8, decision 10, step D4): one open issue per environment,
// written by a script in the `report` jobs, never by a model, with the workflow token's
// `issues: write` and nothing else: no checkout, no cloud credential.
//
// TWO ISSUES PER ENVIRONMENT AT MOST, EACH FOUND BY ITS TITLE.
//   • `Deploy to <environment> failed`: a failure (`failed`) or a refusal (`refused`, `K-SHIP-8`'s
//     "announce a refusal") files it, or comments on it when one is open.
//   • `Smoke check on <environment> failed` (plan 0013 §7.2, decision 4): a deploy that landed and
//     whose reset or smoke check failed (`smoke_failed`) files it, or comments on it, and CLOSES
//     the deploy issue if one is open, since the deploy succeeded. The body says the release is
//     live, the stage that failed, and how to check it again.
//   • A successful deploy whose smoke check passed (`ok`) closes both, if open.
//   • A rejection or a cancellation files nothing: a person decided it, and the run says so.
// Labelled `bug`, and `sev:high` for production (the last environment), `sev:medium` for every
// other one. The body holds the release, the stage, the refusal's code and the run's link, never
// a log line: a deploy log can hold what the adopter's `## Data` answer keeps private.
//
// A HELD PRODUCTION (kanon#894: under a fallback marker, on a `release` run) is neither a deploy
// nor a failure: nothing is filed, commented on or closed. A production dispatch refused because
// its actor isn't the Maintainer files as a refusal, `not-maintainer`, at the stage its row
// records, `deploy`.
//
// A RUN THAT STOPPED BEFORE ANY ENVIRONMENT (the gate, the probe or the build) files on the
// FIRST environment's issue (open-question decision 4), `sev:medium`, or `sev:high` when the
// first is the only one: `deploy-release.yml`'s `report` job.
//
// ENV  NEEDS          `toJSON(needs)` of the report job: the jobs it judges, and the `record` job,
//                     whose `outcome` (read from the run's approvals) it prefers
//      ENVIRONMENT, POSITION  the call's own (`environment`); ENVIRONMENTS, the caller's list (`release`)
//      RELEASE        the release's tag, for the body
//      RUN_URL        the run's link
//      GITHUB_WORKFLOW_REF  the runner's: the deploy caller's file, for the smoke issue's command
//      GITHUB_REPOSITORY, GH_TOKEN (the job's `issues: write` token)
//      GITHUB_OUTPUT  `issue=<number>` when a failure filed or commented on the environment's
//                     issue, else `issue=`: the `announce` job links it (plan 0011 N9)

import { appendFileSync } from 'node:fs';
import { ghApi, splitEnvironments } from './deploy-gate.mjs';
import { classifyEnvironment, classifyRelease } from './deploy-row.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { ROLES } from './lib/deploy-declaration.mjs';

/** The outcomes that file, or comment on, one of the environment's issues. */
export const FILES = Object.freeze(['failed', 'smoke_failed', 'refused']);

/** The deploy issue's fixed title, by which it is found again. */
export const issueTitle = (/** @type {string} */ environment) => `Deploy to ${environment} failed`;

/** The smoke issue's fixed title (plan 0013 §7.2, decision 4), by which it is found again. */
export const smokeIssueTitle = (/** @type {string} */ environment) => `Smoke check on ${environment} failed`;

/** The severity label: production is `sev:high`, every other environment `sev:medium`. */
export const severity = (/** @type {string} */ role) => (role === ROLES.production ? 'sev:high' : 'sev:medium');

/** The most pages of open issues read to find the environment's. */
const MAX_PAGES = 10;

/**
 * The open issue with exactly this title, or `null`: the environment's deploy issue by default.
 * @param {import('./deploy-gate.mjs').Api} api @param {string} repo @param {string} environment
 * @param {string} [title]
 */
export function findIssue(api, repo, environment, title = issueTitle(environment)) {
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
  refused: 'was refused',
});

/**
 * @typedef {{ environment: string, role: string, position: number, outcome: string, failed_stage?: string, refusal?: string, release: string, runUrl: string, caller?: string }} Report
 */

/**
 * The deploy caller's file, from the runner's `GITHUB_WORKFLOW_REF`, which in a called workflow
 * names the caller (`owner/repo/.github/workflows/deploy.yml@refs/tags/v1.2.0`); `deploy.yml`, the
 * name `kanon init` writes, when it can't be read.
 * @param {string | undefined} ref
 */
export const callerFile = (ref) => /\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@/.exec(String(ref ?? ''))?.[1] ?? 'deploy.yml';

/**
 * The text of a failed reset or smoke check after a deploy that landed (plan 0013 §7.2): the
 * release is live, the stage that failed, the run, and how to check it again. No log line.
 * @param {Report} r
 */
export function smokeText(r) {
  const tag = r.release || 'unknown';
  const what = r.failed_stage === 'reset' ? 'its reset hook failed, so its smoke check didn\'t run' : `its smoke check failed${r.failed_stage ? ` at the \`${r.failed_stage}\` stage` : ''}`;
  const again = r.release
    ? `To check it again, deploy the release again: \`gh workflow run ${r.caller ?? 'deploy.yml'} --ref ${r.release} -f release=${r.release}\`. That deploys it to each environment in order, from the first, with the reset and the smoke check after each, and goes on past this one once its check passes.`
    : 'To check it again, dispatch the deploy caller at the release\'s tag.';
  return `Release \`${tag}\` is live on \`${r.environment}\` (${r.role}, environment ${r.position}), but ${what}. The environments after it don't start.\n\n${again}\n\nRun: ${r.runUrl}`;
}

/** The text of a failure, for the body or a comment: no log line. @param {Report} r */
export function failureText(r) {
  if (r.outcome === 'smoke_failed') return smokeText(r);
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
  const tag = r.release || 'unknown';
  /** Comments on an open issue and closes it. @param {{ number: number }} issue @param {string} why */
  const close = (issue, why) => {
    api(`repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', body: { body: `${why}\n\nRun: ${r.runUrl}` } });
    api(`repos/${repo}/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    return issue.number;
  };
  if (r.outcome === 'ok') {
    // A deploy whose smoke check passed closes both of the environment's issues.
    const deploy = findIssue(api, repo, r.environment);
    const smoke = findIssue(api, repo, r.environment, smokeIssueTitle(r.environment));
    const closed = [
      ...(deploy ? [close(deploy, `Release \`${tag}\` deployed to \`${r.environment}\`: closing.`)] : []),
      ...(smoke ? [close(smoke, `Release \`${tag}\` deployed to \`${r.environment}\` and its smoke check passed: closing.`)] : []),
    ];
    return closed.length ? { action: 'closed', number: closed[0] } : { action: 'none' };
  }
  if (!FILES.includes(r.outcome)) return { action: 'none' };
  const smoke = r.outcome === 'smoke_failed';
  if (smoke) {
    // The deploy succeeded, so its issue, if open, closes (plan 0013 §7.2).
    const deploy = findIssue(api, repo, r.environment);
    if (deploy) close(deploy, `Release \`${tag}\` deployed to \`${r.environment}\`: closing. Its smoke check failed, which the issue \`${smokeIssueTitle(r.environment)}\` tracks.`);
  }
  const title = smoke ? smokeIssueTitle(r.environment) : issueTitle(r.environment);
  const open = findIssue(api, repo, r.environment, title);
  if (open) {
    api(`repos/${repo}/issues/${open.number}/comments`, { method: 'POST', body: { body: failureText(r) } });
    return { action: 'commented', number: open.number };
  }
  const footer = smoke
    ? `The deploy lane files one smoke issue per environment (plan 0013 §7.2), comments on it at each later failed smoke check, and closes it at the next deploy to \`${r.environment}\` whose smoke check passes. It holds no log line: read the run.`
    : `The deploy lane files one issue per environment (plan 0010 §8), comments on it at each later failure, and closes it at the next successful deploy to \`${r.environment}\`. It holds no log line: read the run.`;
  const created = api(`repos/${repo}/issues`, {
    method: 'POST',
    body: { title, body: `${failureText(r)}\n\n${footer}`, labels: ['bug', severity(r.role)] },
  });
  return { action: 'filed', number: created?.number };
}

/**
 * The issue a failure filed or commented on, for the `announce` job's link: its number, or empty
 * when the report closed one or did nothing.
 * @param {{ action: string, number?: number }} done
 */
export const issueOf = (done) => ((done.action === 'filed' || done.action === 'commented') && done.number ? String(done.number) : '');

/**
 * What the report job reports: the record's outcome when it wrote one, else the jobs' own.
 * @param {Record<string, string | undefined>} env @param {'environment' | 'release'} kind
 * @returns {Report | null}
 */
export function reportFrom(env, kind) {
  const needs = JSON.parse(env.NEEDS || '{}');
  const rec = needs.record?.outputs ?? {};
  const base = { release: String(env.RELEASE ?? ''), runUrl: String(env.RUN_URL ?? ''), caller: callerFile(env.GITHUB_WORKFLOW_REF) };
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
  // A non-Maintainer's production attempt, refused by `declare` or by the `deploy` job's own check
  // on a re-run, files what its row records, or, when the record failed, what
  // `classifyEnvironment` reads: `not-maintainer` at `deploy` either way.
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
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `issue=${issueOf(done)}\n`);
    console.log(done.action === 'none'
      ? `\`${r.environment}\`: ${r.outcome}, nothing to file or close.`
      : `\`${r.environment}\`: ${r.outcome}; ${done.action} issue #${done.number}.`);
  }
}
