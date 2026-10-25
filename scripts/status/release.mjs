// THE RELEASE VIEW (project #1327, Issue E, `[STAT-9]`): what is about to ship, what shipped, where
// it is deployed and whether the next promotion would pass, read live, and nothing written anywhere.
//
// EACH PART IS SOMEONE ELSE'S DECIDER, READ OVER THE CALLER'S READER.
//   • The release pull request is what the metrics' detector, `isReleasePr`, takes for one: by
//     release-please's labels or the register's Releaser, never by a repository's name.
//   • The latest release is GitHub's `latest`; the latest pre-release is the newest published one in
//     the release listing, with its age at the time of the read.
//   • Each environment the adoption record's `## Deploy` declares, with its last deploy, found as the
//     reconciler's deploy read finds a release's deploy (`readDeploy`): among the deploy workflow's
//     latest runs (`deployRuns`), the run for the release by its tag or its commit (`findDeployRun`),
//     and in it the environment's deploy job, by its exact name. The walk reads the same 30 newest
//     releases the reconciler reads, newest first, and an environment's last deploy is the newest
//     release whose job ran there: success is `deployed`, any other conclusion `failed`, a job not
//     yet completed `deploying`, as `classifyDeploy` names them. A job that was skipped, or isn't in
//     the run, deployed nothing there, and the walk goes on. The record names the deploy job of its
//     reference environment only; each other environment of the chain has the job the deploy caller
//     `kanon init` writes gives it, the reference job with the environment's name in place of the
//     reference environment's (`staging / deploy`, `production / deploy`). A reference job not
//     named that way names no job for the others, and the view says so rather than guessing.
//   • The promotion's gates come from the promotion's own read-only check (`promotion.mjs`), only
//     where the default branch runs Kanon's promotion workflow.
//
// INCOMPLETE IS AN ERROR (`[STAT-3]`): every read goes through `watched`, and a view whose reads
// failed throws `IncompleteRead`, naming each, as the project view does.

import { APP_REGISTER, parseAppRegister } from '../app-register.mjs';
import { deployRuns, findDeployRun } from '../lead-reconcile.mjs';
import { defaultBranchReader } from '../lib/declarations.mjs';
import { ADOPTION_RECORD, parseDeployDeclaration } from '../lib/deploy-declaration.mjs';
import { isReleasePr } from '../metrics/release.mjs';
import { IncompleteRead } from './project.mjs';
import { promotionCheck, promotionWorkflow } from './promotion.mjs';
import { ReadError, graphqlRead, incomplete, isNotFound, ownerAndName, watched } from './reader.mjs';

/** How many of the newest releases the deploy walk reads: the reconciler's `releases?per_page=30`. */
export const DEPLOY_RELEASE_WINDOW = 30;

const HOUR = 3_600_000;

const Q_WORKFLOWS = `query Workflows($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Tree { entries { name type object { ... on Blob { text isTruncated isBinary } } } }
    }
  }
}`;

/**
 * @typedef {{ tag: string, name: string, url: string, publishedAt: string }} Release
 * @typedef {{ tag: string, outcome: 'deployed' | 'failed' | 'deploying', url: string }} Deploy
 * @typedef {{ environment: string, workflow: string, job: string | null, last: Deploy | null }} Environment
 */

/**
 * The release view. Reads only through `reader`; writes nothing.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now?: Date }} args
 */
export async function releaseView({ reader: given, repo, now = new Date() }) {
  const { reader, failures } = watched(given);
  try {
    return await view({ reader, repo, now, failures });
  } catch (e) {
    const failed = failures();
    if (e instanceof ReadError && !failed.includes(e)) failed.push(e);
    if (failed.length) throw new IncompleteRead('the release view', failed);
    throw e;
  }
}

/**
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now: Date, failures: () => ReadError[] }} io
 */
async function view({ reader, repo, now, failures }) {
  const files = await defaultBranchReader(reader, repo);
  const registerText = await files.read(APP_REGISTER);
  const register = registerText === null ? new Map() : parseAppRegister(registerText, `${APP_REGISTER} on \`${files.branch}\``);
  const record = await files.read(ADOPTION_RECORD);
  const declaration = record === null ? null : parseDeployDeclaration(record);

  const releasePrs = (await openPulls(reader, repo))
    .filter((p) => isReleasePr({ ...p, labels: (p.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l)), author: p.user ? { login: String(p.user.login), type: String(p.user.type) } : null }, register))
    .map((p) => ({ number: Number(p.number), title: String(p.title ?? ''), url: String(p.html_url ?? ''), createdAt: String(p.created_at ?? '') }));

  let latest = null;
  try {
    latest = releaseOf(/** @type {any} */ (await reader.get(`repos/${repo}/releases/latest`)));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    /** @type {{ expected?: boolean }} */ (e).expected = true;
  }
  const { newest, preRelease } = await releases(reader, repo);
  const workflows = await workflowsOn(reader, repo, files.branch);
  const deploys = await deploysOf(declaration, newest, { reader, repo });
  const promotion = await promotionOf(workflows, { reader, repo, branch: files.branch, now });

  const failed = failures();
  if (failed.length) throw new IncompleteRead('the release view', failed);
  return {
    branch: files.branch,
    releasePrs,
    latest,
    preRelease: preRelease ? { ...releaseOf(preRelease), ageHours: Math.floor((now.getTime() - Date.parse(String(preRelease.published_at))) / HOUR) } : null,
    deploys,
    promotion,
  };
}

/** A release, as the view gives one. @param {any} r @returns {Release} */
const releaseOf = (r) => ({ tag: String(r.tag_name), name: String(r.name ?? r.tag_name), url: String(r.html_url ?? ''), publishedAt: String(r.published_at ?? '') });

/**
 * Every open pull request. @param {import('./reader.mjs').Reader} reader @param {string} repo
 * @returns {Promise<any[]>}
 */
async function openPulls(reader, repo) {
  const path = `repos/${repo}/pulls?state=open&per_page=100`;
  const pages = await reader.pages(path);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw incomplete(reader, `GET ${path}`, 'the answer is not a list of pull requests');
  return pages.flat();
}

/**
 * The newest releases the deploy walk reads, and the latest published pre-release, read page by
 * page only as far as the first.
 * @param {import('./reader.mjs').Reader} reader @param {string} repo
 */
async function releases(reader, repo) {
  /** @type {any[]} */
  const all = [];
  for (let page = 1; ; page++) {
    const path = `repos/${repo}/releases?per_page=100&page=${page}`;
    const got = await reader.get(path);
    if (!Array.isArray(got)) throw incomplete(reader, `GET ${path}`, 'the answer is not a list of releases');
    all.push(...got);
    const preRelease = all.find((r) => r?.prerelease && !r?.draft && r?.published_at);
    if (preRelease || got.length < 100) return { newest: all.slice(0, DEPLOY_RELEASE_WINDOW), preRelease: preRelease ?? null };
  }
}

/**
 * The default branch's workflow files, by name, in one read. No `.github/workflows` is none.
 * @param {import('./reader.mjs').Reader} reader @param {string} repo @param {string} branch
 * @returns {Promise<Array<{ file: string, text: string }>>}
 */
async function workflowsOn(reader, repo, branch) {
  const data = /** @type {any} */ (await reader.graphql(Q_WORKFLOWS, { ...ownerAndName(repo), expression: `${branch}:.github/workflows` }));
  if (!data?.repository) throw incomplete(reader, graphqlRead(Q_WORKFLOWS), `${repo} came back empty`);
  const entries = data.repository.object?.entries ?? [];
  /** @type {Array<{ file: string, text: string }>} */
  const out = [];
  for (const e of entries) {
    if (e?.type !== 'blob' || !/\.ya?ml$/.test(String(e?.name))) continue;
    if (e.object?.isTruncated || typeof e.object?.text !== 'string') throw incomplete(reader, graphqlRead(Q_WORKFLOWS), `.github/workflows/${e.name} came back truncated`);
    out.push({ file: String(e.name), text: e.object.text });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Each declared environment with its deploy job and its last deploy among `newest`.
 * @param {import('../lib/deploy-declaration.mjs').DeployDeclaration | null} declaration
 * @param {any[]} newest the newest releases, newest first
 * @param {{ reader: import('./reader.mjs').Reader, repo: string }} io
 * @returns {Promise<Environment[]>}
 */
async function deploysOf(declaration, newest, { reader, repo }) {
  const reference = declaration?.reference ?? null;
  if (!reference) return [];
  const names = declaration?.environments.length ? declaration.environments : [reference.environment];
  /** @type {Environment[]} */
  const envs = names.map((environment) => ({ environment, workflow: reference.workflow, job: jobOf(environment, reference), last: null }));
  let open = envs.filter((e) => e.job !== null);
  if (!open.length) return envs;
  const runs = await deployRuns(reference.workflow, { reader, repo });
  for (const r of newest) {
    if (!open.length) break;
    const tag = String(r?.tag_name ?? '');
    const run = findDeployRun(runs, tag) ?? findDeployRun(runs, tag, await tagSha(tag, { reader, repo }));
    if (!run) continue;
    const jobs = await jobsOf(run.databaseId, { reader, repo });
    for (const e of open) {
      const j = jobs.find((x) => x?.name === e.job);
      if (!j || j.conclusion === 'skipped') continue;
      e.last = { tag, outcome: j.status !== 'completed' ? 'deploying' : j.conclusion === 'success' ? 'deployed' : 'failed', url: String(run.url ?? '') };
    }
    open = open.filter((e) => e.last === null);
  }
  return envs;
}

/**
 * An environment's deploy job: the reference job for the reference environment, and for each other
 * environment the job the deploy caller gives it, when the reference job is named that way.
 * @param {string} environment @param {import('../lib/deploy-declaration.mjs').ReferenceDeploy} reference
 */
function jobOf(environment, reference) {
  if (environment === reference.environment) return reference.job;
  const prefix = `${reference.environment} / `;
  return reference.job.startsWith(prefix) ? `${environment} / ${reference.job.slice(prefix.length)}` : null;
}

/**
 * The commit a release tag names, for a run titled by it, or null when the tag isn't there. GitHub
 * answers a ref it doesn't have (a draft's new tag, a deleted one) with 422 `No commit found for
 * SHA`, or 404; only those two read as "not there". Any other failure still errors the view.
 * @param {string} tag @param {{ reader: import('./reader.mjs').Reader, repo: string }} io
 */
async function tagSha(tag, { reader, repo }) {
  try {
    const sha = /** @type {{ sha?: unknown }} */ (await reader.get(`repos/${repo}/commits/${encodeURIComponent(tag)}`))?.sha;
    return typeof sha === 'string' ? sha : null;
  } catch (e) {
    if (!isNotFound(e) && !(e instanceof ReadError && e.status === 422)) throw e;
    /** @type {{ expected?: boolean }} */ (e).expected = true;
    return null;
  }
}

/**
 * A run's jobs, every page. @param {number} id @param {{ reader: import('./reader.mjs').Reader, repo: string }} io
 * @returns {Promise<any[]>}
 */
async function jobsOf(id, { reader, repo }) {
  const path = `repos/${repo}/actions/runs/${id}/jobs?per_page=100`;
  const pages = /** @type {any} */ (await reader.pages(path));
  if (!Array.isArray(pages) || !pages.every((p) => Array.isArray(p?.jobs))) throw incomplete(reader, `GET ${path}`, 'the answer has no job list');
  return pages.flatMap((p) => p.jobs);
}

/**
 * The promotion's gates, where the default branch runs its workflow; null elsewhere.
 * @param {Array<{ file: string, text: string }>} workflows
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, branch: string, now: Date }} io
 */
async function promotionOf(workflows, { reader, repo, branch, now }) {
  const workflow = promotionWorkflow(workflows);
  if (!workflow) return null;
  return { workflow, ...(await promotionCheck({ reader, repo, branch, workflows, now: now.getTime() })) };
}
