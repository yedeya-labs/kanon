/**
 * The deploy announcement (`K-SHIP-10`): the producer of Kanon's `deploy` message (plan 0011,
 * step N9). Every non-draft release newer than the ANNOUNCED_<STAGE>_VERSION repository variable,
 * up to and including the deployed version, becomes one message: one Features / Fixes /
 * Maintenance summary rather than each release's notes verbatim. The first run (the variable
 * absent) announces only the deployed version's release, never the whole history.
 *
 * TWO MODES, IN TWO JOBS (plan 0011 §4, §5).
 * - Produce (the default) builds the message through `scripts/lib/notify-contract.mjs` (`fit`,
 *   then `validate`) and writes one `message.json`, for the lane to upload as its message
 *   artifact. It never posts and never reads a chat secret: the lane's `notify` job posts, with
 *   the kind's secret, `KANON_CHAT_DEPLOY`. It moves nothing.
 * - `--advance` moves ANNOUNCED_<STAGE>_VERSION to the deployed version, in a job after `notify`,
 *   so a deploy is announced once. It refuses unless `NOTIFY_RESULT` is `success` (the lane passes
 *   `needs.notify.result`): a post that failed leaves the marker where it was, and the next deploy
 *   announces the releases again. It never moves the marker back.
 *
 * Either mode makes requests to GitHub's API and nowhere else.
 *
 * Env, both modes: GITHUB_TOKEN, GITHUB_REPOSITORY, STAGE (the environment deployed to, as the
 * project names it; required since kanon#54), VERSION (the deployed semver, a leading v ok),
 * DRY_RUN (print, write and move nothing).
 * Produce: SHA (optional, the summary's build), MESSAGE_PATH (default `message.json`),
 * GITHUB_SERVER_URL and GITHUB_RUN_ID (the message's run link), GITHUB_OUTPUT (`message=<path>`,
 * empty when there is nothing to announce), GITHUB_STEP_SUMMARY (a dry run's rendering).
 * --advance: NOTIFY_RESULT.
 *
 * Locally, exactly as CI runs it:
 *   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> \
 *   STAGE=<your environment> VERSION=0.1.6 DRY_RUN=1 node scripts/announce-deploy.mjs
 *
 * Wiring it into plan 0010's deploy lane (its `announce`, `notify` and advance jobs) is that
 * plan's later step.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { payload } from '../actions/notify/slack/slack.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { describeErrors, fit, literal, renderText, validate } from './lib/notify-contract.mjs';
import { classify, kanonList, kanonMaint, parseSections, scopeOf } from './lib/release-notes.mjs';

/** The one host either mode makes a request to. */
export const API = 'https://api.github.com';

/** `owner/name`, as GitHub spells them; anything else never reaches a request's path. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** A release-please version: `1.2.3`, a leading `v` allowed. */
const SEMVER = /^v?\d+\.\d+\.\d+$/;
/** A GitHub Actions variable's name. */
const VAR_NAME = /^[A-Z][A-Z0-9_]*$/;
/** A commit SHA, shown in the summary as code. */
const COMMIT = /^[0-9a-f]{7,40}$/i;

/**
 * @typedef {{ fetch: typeof fetch, writeFile: (path: string, text: string) => void, appendFile: (path: string, text: string) => void }} Io
 * @typedef {{ log: (s: string) => void, error: (s: string) => void }} Out
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ tag_name: string, body?: string | null, draft?: boolean, prerelease?: boolean }} Release
 */

/** Numeric semver parts of a 'v0.1.6'-style tag (release-please never emits prereleases here). */
const parts = (/** @type {string} */ v) => v.replace(/^v/, '').split('.').map(Number);

/**
 * Numeric semver compare.
 * @param {string} a
 * @param {string} b
 */
export function cmp(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/**
 * The releases to announce, oldest first: non-draft, at most the deployed version, and newer than
 * the last announced one, or, on a first run, the deployed version's alone.
 * @param {Release[]} releases
 * @param {string} version
 * @param {string | null} last
 */
export function selectReleases(releases, version, last) {
  return releases
    .filter((r) => !r.draft && !r.prerelease)
    .filter((r) => cmp(r.tag_name, version) <= 0)
    .filter((r) => (last ? cmp(r.tag_name, last) > 0 : cmp(r.tag_name, version) === 0))
    .sort((a, b) => cmp(a.tag_name, b.tag_name));
}

/** The deploy's variable: ANNOUNCED_<STAGE>_VERSION. */
export const varNameOf = (/** @type {string} */ stage) => `ANNOUNCED_${stage.toUpperCase()}_VERSION`;

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
 * The environment both modes need, checked: an error line, or the values.
 * @param {Env} env
 */
function common(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'STAGE', 'VERSION'].filter((k) => !env[k]);
  if (missing.length) return { error: `Missing required env: ${missing.join(', ')}` };
  const repo = /** @type {string} */ (env.GITHUB_REPOSITORY);
  const stage = /** @type {string} */ (env.STAGE);
  const raw = /** @type {string} */ (env.VERSION);
  if (!REPOSITORY.test(repo)) return { error: 'GITHUB_REPOSITORY is not owner/name.' };
  if (!SEMVER.test(raw)) return { error: 'VERSION is not a version like 1.2.3.' };
  const varName = varNameOf(stage);
  if (!VAR_NAME.test(varName)) return { error: 'STAGE makes ANNOUNCED_<STAGE>_VERSION an invalid variable name: use letters, digits and _.' };
  return { repo, stage, version: raw.replace(/^v/, ''), varName, token: /** @type {string} */ (env.GITHUB_TOKEN) };
}

/**
 * A GitHub API client on `io.fetch`, for one repository. A 404 is returned, any other failure thrown.
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
  return async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
    const res = await io.fetch(`${API}/repos/${repo}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok && res.status !== 404) {
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}`);
    }
    return res;
  };
}

/**
 * The last announced version, or null on a first run.
 * @param {ReturnType<typeof github>} gh
 * @param {string} varName
 * @returns {Promise<string | null>}
 */
async function lastAnnounced(gh, varName) {
  const res = await gh(`/actions/variables/${varName}`);
  return res.status === 404 ? null : String((await res.json()).value);
}

/**
 * Produce: write the `deploy` message, or nothing when there is nothing new. Returns the exit code.
 * @param {{ env: Env, io: Io, out: Out }} args
 */
export async function produce({ env, io, out }) {
  const c = common(env);
  if ('error' in c) { out.error(String(c.error)); return 1; }
  const { repo, stage, version, varName, token } = c;
  const dryRun = Boolean(env.DRY_RUN);
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  if (!/^https:\/\/[^\s/]+$/.test(server)) { out.error('GITHUB_SERVER_URL is not an https:// origin.'); return 1; }
  if (!env.GITHUB_RUN_ID && !dryRun) { out.error('Missing required env: GITHUB_RUN_ID'); return 1; }
  const runUrl = env.GITHUB_RUN_ID && /^\d+$/.test(env.GITHUB_RUN_ID)
    ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
    : `${server}/${repo}/actions`;
  const output = (/** @type {string} */ value) => { if (env.GITHUB_OUTPUT) io.appendFile(env.GITHUB_OUTPUT, `message=${value}\n`); };

  const gh = github(io, repo, token);
  const last = await lastAnnounced(gh, varName);
  /** @type {Release[]} */
  const releases = await (await gh('/releases?per_page=100')).json();
  const toAnnounce = selectReleases(releases, version, last);
  if (toAnnounce.length === 0) {
    out.log(`Nothing new to announce (deployed ${version}, last announced ${last ?? 'never'}).`);
    output('');
    return 0;
  }

  const message = buildDeployMessage({ repo, stage, sha: env.SHA, server, runUrl, releases: toAnnounce });
  const checked = validate(message);
  if (!checked.ok) {
    out.error(`The deploy message is invalid: ${describeErrors(checked.errors)}`);
    return 1;
  }
  const tags = toAnnounce.map((r) => r.tag_name).join(', ');

  if (dryRun) {
    const shown = [
      `DRY RUN: would announce ${tags} (last announced: ${last ?? 'never'}); nothing is written or uploaded, and ${varName} doesn't move.`,
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
  out.log(`Wrote the deploy message for ${tags} to ${path}. ${varName} moves only after it is posted (--advance).`);
  return 0;
}

/**
 * --advance: move ANNOUNCED_<STAGE>_VERSION to the deployed version, only after `notify` posted.
 * Returns the exit code.
 * @param {{ env: Env, io: Io, out: Out }} args
 */
export async function advance({ env, io, out }) {
  if (env.NOTIFY_RESULT !== 'success') {
    out.error(`--advance refuses: the notify job did not post (NOTIFY_RESULT is ${JSON.stringify(env.NOTIFY_RESULT ?? '')}, not "success"), so the announced version stays where it is.`);
    return 1;
  }
  const c = common(env);
  if ('error' in c) { out.error(String(c.error)); return 1; }
  const { repo, version, varName, token } = c;
  const gh = github(io, repo, token);
  const last = await lastAnnounced(gh, varName);
  if (last && cmp(version, last) <= 0) {
    out.log(`${varName} is ${last}, not behind ${version}: nothing to move.`);
    return 0;
  }
  if (env.DRY_RUN) {
    out.log(`DRY RUN: would set ${varName} → ${version} (from ${last ?? 'unset'}).`);
    return 0;
  }
  const body = JSON.stringify({ name: varName, value: version });
  const update = await gh(`/actions/variables/${varName}`, { method: 'PATCH', body });
  if (update.status === 404) await gh('/actions/variables', { method: 'POST', body });
  out.log(`${varName} → ${version}`);
  return 0;
}

/**
 * The CLI: `--advance`, or produce. Returns the exit code.
 * @param {{ argv: string[], env: Env, io: Io, out?: Out }} args
 */
export async function main({ argv, env, io, out = console }) {
  const unknown = argv.filter((a) => a !== '--advance');
  if (unknown.length) { out.error(`Unknown argument: ${unknown[0]}. The one flag is --advance.`); return 1; }
  return argv.includes('--advance') ? advance({ env, io, out }) : produce({ env, io, out });
}

if (isCliEntry(import.meta.url)) {
  const io = /** @type {Io} */ ({
    fetch: globalThis.fetch,
    writeFile: (p, t) => writeFileSync(p, t),
    appendFile: (p, t) => appendFileSync(p, t),
  });
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, io });
}
