/**
 * The deploy announcement (`K-SHIP-10`): the producer of Kanon's `deploy` message (plan 0011,
 * step N9), run by the deploy lane's `announce` job in `deploy.yml`, once per environment (plan
 * 0010 §8; the Owner's decisions of 2026-10-15). It writes one `message.json` for the lane to
 * upload, and the lane's `notify` job posts it with the kind's secret, `KANON_CHAT_DEPLOY`. It
 * never posts, never reads a chat secret, and moves nothing.
 *
 * WHAT IT ANNOUNCES, by the environment's outcome as its `record` job wrote it (`OUTCOME`):
 * - `ok`: the releases the deploy brought live. Every non-draft release newer than the release of
 *   the environment's PREVIOUS SUCCESSFUL GITHUB DEPLOYMENT (the Deployments API, which the
 *   workflow token reads with `deployments: read`), up to and including the deployed version,
 *   becomes one Features / Fixes / Maintenance summary, `info`. With no earlier successful
 *   deployment, or one whose release can't be told, it announces the deployed release alone, never
 *   the whole history; a redeploy of the same release announces nothing; a rollback (a dispatch of
 *   an older release) announces the deployed release alone. A pre-release is announced alone.
 * - `failed` or `smoke_failed`: a failure, `critical` for production and `warning` for any other
 *   environment (plan 0011 §3.2), naming the release, the stage that failed, the run, and the
 *   environment's issue when the `report` job filed or commented on one.
 * - anything else (`refused`, `rejected`, `cancelled`, or no row): nothing. A refusal is reported
 *   on the environment's issue (`K-SHIP-8`), and a rejection or a cancel is a person's choice.
 *
 * Nothing records what was announced: the deployments are the record, so nothing has to move after
 * a post, and a post that failed is not repeated by the next deploy (kanon#972 has nothing left to
 * guard). The `notify` job's red is the announcement's failure, never the deploy's.
 *
 * It makes requests to GitHub's API and nowhere else.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, STAGE (the environment deployed to, as the project names
 * it; required since kanon#54), VERSION (the deployed release's tag, a leading v ok), OUTCOME (the
 * `record` job's), ROLE (`production` or `pre-production`; production when unset), FAILED_STAGE,
 * ISSUE (the environment's issue number, when known), SHA (optional, the summary's build),
 * MESSAGE_PATH (default `message.json`), GITHUB_SERVER_URL and GITHUB_RUN_ID (the run link, and
 * how this run's own deployment is told from the previous one), GITHUB_OUTPUT (`message=<path>`,
 * empty when there is nothing to announce), GITHUB_STEP_SUMMARY (a dry run's rendering), DRY_RUN
 * (print, write nothing).
 *
 * Locally, exactly as CI runs it:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> STAGE=<your environment> \
 *   VERSION=0.1.6 OUTCOME=ok DRY_RUN=1 node scripts/announce-deploy.mjs
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { payload } from '../actions/notify/slack/slack.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { ROLES } from './lib/deploy-declaration.mjs';
import { describeErrors, fit, literal, renderText, validate } from './lib/notify-contract.mjs';
import { classify, kanonList, kanonMaint, parseSections, scopeOf } from './lib/release-notes.mjs';

/** The one host it makes requests to. */
export const API = 'https://api.github.com';

/** `owner/name`, as GitHub spells them; anything else never reaches a request's path. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** A release's version: `1.2.3`, a leading `v` allowed, and a pre-release's suffix. */
const VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A GitHub environment's name: one line, at most 255 characters. */
const ENVIRONMENT = /^[^\r\n]{1,255}$/;
/** A commit SHA, shown in the summary as code. */
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** The outcomes announced as a landed deploy, and as a failure; any other announces nothing. */
export const LANDED = Object.freeze(['ok']);
export const FAILED = Object.freeze(['failed', 'smoke_failed']);
/** How many deployments, newest first, are read for the previous successful one. */
const DEPLOYMENTS_READ = 30;

/**
 * @typedef {{ fetch: typeof fetch, writeFile: (path: string, text: string) => void, appendFile: (path: string, text: string) => void }} Io
 * @typedef {{ log: (s: string) => void, error: (s: string) => void }} Out
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ tag_name: string, body?: string | null, draft?: boolean, prerelease?: boolean }} Release
 */

/** Numeric semver parts of a 'v0.1.6'-style tag, any pre-release suffix left out. */
const parts = (/** @type {string} */ v) => v.replace(/^v/, '').split('-')[0]?.split('.').map(Number) ?? [];
/** Whether a version is a pre-release's (`1.2.3-rc.1`). */
const isPre = (/** @type {string} */ v) => v.replace(/^v/, '').includes('-');

/**
 * Numeric semver compare of the release part.
 * @param {string} a
 * @param {string} b
 */
export function cmp(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/**
 * The releases to announce, oldest first: non-draft, non-pre-release, at most the deployed
 * version, and newer than the previous deployment's release, or, with none, the deployed version's
 * alone.
 * @param {Release[]} releases
 * @param {string} version
 * @param {string | null} last
 */
export function selectReleases(releases, version, last) {
  return releases
    .filter((r) => !r.draft && !r.prerelease)
    .filter((r) => cmp(r.tag_name, version) <= 0)
    // A release is newer than a pre-release of its own version (`1.2.3` after `1.2.3-rc.1`).
    .filter((r) => (last ? cmp(r.tag_name, last) > 0 || (isPre(last) && cmp(r.tag_name, last) === 0) : cmp(r.tag_name, version) === 0))
    .sort((a, b) => cmp(a.tag_name, b.tag_name));
}

/**
 * One `deploy` message for the releases a deploy brought live, fitted to the contract (§3.3).
 * @param {{ repo: string, stage: string, sha?: string, server?: string, runUrl: string, releases: Release[] }} args
 * @returns {Record<string, any>}
 */
export function buildDeployMessage({ repo, stage, sha, server = 'https://github.com', runUrl, releases }) {
  /** @type {string[]} */ const features = [];
  /** @type {string[]} */ const fixes = [];
  /** @type {string[]} */ const maint = [];
  for (const r of releases) {
    for (const [heading, bullets] of Object.entries(parseSections(r.body || ''))) {
      for (const raw of /** @type {string[]} */ (bullets)) {
        const bucket = classify(heading, scopeOf(raw));
        (bucket === 'feature' ? features : bucket === 'fix' ? fixes : maint).push(raw);
      }
    }
  }

  const versions = releases.map((r) => r.tag_name);
  const first = versions[0] ?? '';
  const newest = versions.at(-1) ?? '';
  const isRange = versions.length > 1;
  const title = isRange
    ? `${first} to ${newest} (${versions.length} releases) are live on ${stage}`
    : `${first} is live on ${stage}`;
  const build = sha && COMMIT.test(sha) ? ` Build \`${sha.slice(0, 7)}\`.` : '';
  const summary = isRange
    ? `**${literal(first)}** to **${literal(newest)}**, ${versions.length} releases, are now live on **${literal(stage)}**.${build}`
    : `**${literal(first)}** is now live on **${literal(stage)}**.${build}`;

  const sections = [
    { heading: 'Features', body: kanonList(features) },
    { heading: 'Fixes', body: kanonList(fixes) },
    { heading: 'Maintenance', body: kanonMaint(maint) },
  ].filter((s) => s.body !== '');

  const notes = isRange
    ? `${server}/${repo}/releases`
    : `${server}/${repo}/releases/tag/${encodeURIComponent(first)}`;

  return fit({
    kind: 'deploy',
    severity: 'info',
    title,
    summary,
    sections,
    links: [{ label: 'Release notes', url: notes }],
    source: { repository: repo, lane: 'deploy', run_url: runUrl },
  });
}

/**
 * The failure's severity (plan 0011 §3.2, the Owner's decision of 2026-10-15): `critical` when
 * production fails, `warning` for any other environment.
 * @param {string} role
 */
export const failureSeverity = (role) => (role === ROLES.preProduction ? 'warning' : 'critical');

/**
 * One `deploy` message for a deploy that failed: the environment, the release, the stage that
 * failed, the run, and the environment's issue when known.
 * @param {{ repo: string, stage: string, role: string, version: string, outcome: string, failedStage?: string, issue?: number | null, sha?: string, server?: string, runUrl: string }} args
 * @returns {Record<string, any>}
 */
export function buildFailureMessage({ repo, stage, role, version, outcome, failedStage, issue, sha, server = 'https://github.com', runUrl }) {
  const smoke = outcome === 'smoke_failed';
  const title = smoke ? `${version} failed its smoke check on ${stage}` : `${version} failed to deploy to ${stage}`;
  const at = failedStage ? ` at the **${literal(failedStage)}** stage` : '';
  const build = sha && COMMIT.test(sha) ? ` Build \`${sha.slice(0, 7)}\`.` : '';
  const summary = smoke
    ? `**${literal(version)}** was deployed to **${literal(stage)}** and failed its smoke check.${build}`
    : `**${literal(version)}** did not deploy to **${literal(stage)}**: it failed${at}.${build}`;
  const fields = [
    { label: 'Environment', value: stage },
    { label: 'Release', value: version },
    ...(failedStage ? [{ label: 'Failed stage', value: failedStage }] : []),
  ];
  const links = [
    { label: 'Run', url: runUrl },
    ...(issue ? [{ label: `Issue #${issue}`, url: `${server}/${repo}/issues/${issue}` }] : []),
  ];
  return fit({
    kind: 'deploy',
    severity: failureSeverity(role),
    title,
    summary,
    sections: [{ body: 'The run holds the logs; the environment\'s issue tracks the failure until the next successful deploy closes it.', fields }],
    links,
    source: { repository: repo, lane: 'deploy', run_url: runUrl },
  });
}

/**
 * The environment, checked: an error line, or the values.
 * @param {Env} env
 */
function common(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'STAGE', 'VERSION'].filter((k) => !env[k]);
  if (missing.length) return { error: `Missing required env: ${missing.join(', ')}` };
  const repo = /** @type {string} */ (env.GITHUB_REPOSITORY);
  const stage = /** @type {string} */ (env.STAGE);
  const raw = /** @type {string} */ (env.VERSION);
  if (!REPOSITORY.test(repo)) return { error: 'GITHUB_REPOSITORY is not owner/name.' };
  if (!VERSION.test(raw)) return { error: 'VERSION is not a version like 1.2.3.' };
  if (!ENVIRONMENT.test(stage)) return { error: 'STAGE is not an environment name: one line, at most 255 characters.' };
  return { repo, stage, version: raw.replace(/^v/, ''), tag: raw, token: /** @type {string} */ (env.GITHUB_TOKEN) };
}

/**
 * A GitHub API client on `io.fetch`, for one repository. Any failure is thrown.
 * @param {Io} io
 * @param {string} repo
 * @param {string} token
 */
function github(io, repo, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return async (/** @type {string} */ path) => {
    const res = await io.fetch(`${API}/repos/${repo}${path}`, { headers });
    if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
    return res.json();
  };
}

/**
 * The release of the environment's previous successful deployment, or null: the newest deployment
 * to `stage` whose latest status is `success` and which this run (`runId`) didn't make, read as the
 * release tag its ref names, else a release tag on its commit.
 * @param {(path: string) => Promise<any>} gh a GET on the repository's API path
 * @param {{ stage: string, runId: string, releases: Release[] }} o
 * @returns {Promise<string | null>}
 */
export async function previousRelease(gh, { stage, runId, releases }) {
  const list = await gh(`/deployments?environment=${encodeURIComponent(stage)}&per_page=${DEPLOYMENTS_READ}`);
  const ownRun = new RegExp(`/actions/runs/${runId}(?:/|$)`);
  for (const d of Array.isArray(list) ? list : []) {
    const [status] = /** @type {any[]} */ (await gh(`/deployments/${d.id}/statuses?per_page=1`));
    if (status?.state !== 'success') continue;
    // This run's own deployment of the environment, which just succeeded: its status links the run.
    if (runId && [status.log_url, status.target_url].some((u) => ownRun.test(String(u ?? '')))) continue;
    const tags = new Set(releases.filter((r) => !r.draft).map((r) => r.tag_name));
    // A release run's deployment names its tag; a dispatch's names its branch, so read its commit.
    if (tags.has(String(d.ref))) return String(d.ref);
    const onCommit = /** @type {any[]} */ (await gh('/tags?per_page=100'))
      .filter((t) => t?.commit?.sha === d.sha && tags.has(String(t.name)))
      .map((t) => String(t.name))
      .sort(cmp);
    return onCommit.at(-1) ?? null;
  }
  return null;
}

/**
 * Write the environment's `deploy` message, or nothing when there is nothing to announce. Returns
 * the exit code.
 * @param {{ env: Env, io: Io, out: Out }} args
 */
export async function produce({ env, io, out }) {
  const c = common(env);
  if ('error' in c) { out.error(String(c.error)); return 1; }
  const { repo, stage, version, tag, token } = c;
  const dryRun = Boolean(env.DRY_RUN);
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  if (!/^https:\/\/[^\s/]+$/.test(server)) { out.error('GITHUB_SERVER_URL is not an https:// origin.'); return 1; }
  if (!env.GITHUB_RUN_ID && !dryRun) { out.error('Missing required env: GITHUB_RUN_ID'); return 1; }
  const runId = env.GITHUB_RUN_ID && /^\d+$/.test(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : '';
  const runUrl = runId ? `${server}/${repo}/actions/runs/${runId}` : `${server}/${repo}/actions`;
  const output = (/** @type {string} */ value) => { if (env.GITHUB_OUTPUT) io.appendFile(env.GITHUB_OUTPUT, `message=${value}\n`); };
  const outcome = String(env.OUTCOME ?? '');
  const role = env.ROLE === ROLES.preProduction ? ROLES.preProduction : ROLES.production;

  /** @type {Record<string, any>} */
  let message;
  let what;
  if (FAILED.includes(outcome)) {
    const issue = /^\d+$/.test(String(env.ISSUE ?? '')) ? Number(env.ISSUE) : null;
    message = buildFailureMessage({ repo, stage, role, version: tag, outcome, failedStage: env.FAILED_STAGE || undefined, issue, sha: env.SHA, server, runUrl });
    what = `the failure of ${tag} on ${stage}`;
  } else if (LANDED.includes(outcome)) {
    const gh = github(io, repo, token);
    /** @type {Release[]} */
    const releases = await gh('/releases?per_page=100');
    const last = await previousRelease(gh, { stage, runId, releases });
    const alone = () => releases.filter((r) => !r.draft && r.tag_name.replace(/^v/, '') === version);
    const toAnnounce = isPre(version) || (last && cmp(version, last) < 0)
      ? alone()
      : last && cmp(version, last) === 0 && !isPre(last) ? [] : selectReleases(releases, version, last);
    if (toAnnounce.length === 0) {
      out.log(`Nothing new to announce (deployed ${version} to ${stage}; the previous successful deployment there was ${last ?? 'none'}).`);
      output('');
      return 0;
    }
    message = buildDeployMessage({ repo, stage, sha: env.SHA, server, runUrl, releases: toAnnounce });
    what = `${toAnnounce.map((r) => r.tag_name).join(', ')} on ${stage} (previous successful deployment: ${last ?? 'none'})`;
  } else {
    out.log(`Nothing to announce: ${stage}'s outcome is ${outcome ? `\`${outcome}\`` : 'unrecorded'}, neither a deploy that landed nor one that failed.`);
    output('');
    return 0;
  }

  const checked = validate(message);
  if (!checked.ok) {
    out.error(`The deploy message is invalid: ${describeErrors(checked.errors)}`);
    return 1;
  }

  if (dryRun) {
    const shown = [
      `DRY RUN: would announce ${what}; nothing is written or uploaded.`,
      '', '--- message.json ---', JSON.stringify(message, null, 2),
      '', '--- text (what a hook gets as `text`) ---', renderText(message),
      '', "--- Kanon's Slack hook's payload ---", JSON.stringify(payload(message), null, 2),
    ].join('\n');
    out.log(shown);
    if (env.GITHUB_STEP_SUMMARY) io.appendFile(env.GITHUB_STEP_SUMMARY, `\`\`\`\n${shown}\n\`\`\`\n`);
    output('');
    return 0;
  }

  const path = env.MESSAGE_PATH || 'message.json';
  io.writeFile(path, `${JSON.stringify(message, null, 2)}\n`);
  output(path);
  out.log(`Wrote the deploy message for ${what} to ${path}. The notify job posts it.`);
  return 0;
}

/**
 * The CLI. Returns the exit code.
 * @param {{ argv: string[], env: Env, io: Io, out?: Out }} args
 */
export async function main({ argv, env, io, out = console }) {
  if (argv.length) {
    out.error(`Unknown argument: ${argv[0]}. It takes none${argv[0] === '--advance' ? ': --advance is gone, since the environment\'s deployments record what was announced' : ''}.`);
    return 1;
  }
  return produce({ env, io, out });
}

if (isCliEntry(import.meta.url)) {
  const io = /** @type {Io} */ ({
    fetch: globalThis.fetch,
    writeFile: (p, t) => writeFileSync(p, t),
    appendFile: (p, t) => appendFileSync(p, t),
  });
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, io });
}
