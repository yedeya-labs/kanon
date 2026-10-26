// The spine's push job (kanon#1383, plan in docs/projects/1373.md Issue B): pushes the commits an
// agent made locally, through the verified-commit helper, and opens the pull request it asked for.
//
// WHY A JOB OF ITS OWN. The agent's token holds neither `contents: write` nor `workflows: write`
// (`[LANE-13]`), so nothing the agent runs can move a branch. Its job hands its commits on as a git
// bundle, with the pull request it wants as a request file, and this runs in the job after it, which
// holds the Author App's key, mints its own token, runs no agent and no project code, and checks
// nothing out (`[LANE-14]`, `K-AGENT-49`). Everything it reads from the agent's job, the bundle and
// the request, is the agent's to write, so it trusts none of it: the helper re-checks every commit
// against GitHub, and every branch this moves passes the rules below first.
//
// WHICH BRANCHES MOVE:
// - On a lane that revises a branch (`--ref`), that branch alone, from the commit the agent's job
//   checked out, without force: it existed before the run, and is the one exception to the rule
//   below. The helper refuses it if it moved, or if the agent rewrote it (`K-AGENT-34`).
// - Otherwise, with a request, the request's branch alone (`[LANE-15]`); with none, as a failed
//   agent leaves, each branch the bundle carries, so a crashed run's work survives as it did when
//   the agent pushed mid-run. Each is built on the first commit GitHub has on its first-parent path,
//   which is the checked-out commit, or the open pull request a follow-up stacks on.
// - Never the default branch, never a branch that existed before the run (read by the mint job,
//   before the agent's job started), and never a name a URL could read as another branch. A branch
//   whose commits carry the request file is refused too: the spine keeps it out of every commit.
// Every other branch the agent made stays on its runner, and the step summary names it.
//
// THE PULL REQUEST is opened only after its branch moved, from the request's branch, base, title and
// body, and labelled with the request's labels, each of which must be one of the lane's own. A
// request that breaks a rule is refused whole: nothing of it is pushed or opened.
//
// Usage: node scripts/lane-push.mjs --bundle <file> [--request <file>] --start <sha> [--ref <branch>]
//          --before <JSON array> --labels "<names>" --app-login <slug>[bot]
// Reads `GH_TOKEN`, `REPO`, `GITHUB_SERVER_URL` and `GITHUB_API_URL`. Writes `heads=<JSON [{ref, sha}]
// of the branches it moved>`, `base=<the head it built on>` and `pr=<the pull request it opened>` to
// `$GITHUB_OUTPUT`, and what it did to the step summary. A refusal fails the step, after the outputs.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from './lib/cli-entry.mjs';
import { githubRequest, pushVerified, summary } from './lib/verified-commits.mjs';

/** Where the agent writes its request: under `docs/`, the one path every lane's agent may write. */
export const REQUEST_PATH = 'docs/.kanon-pull-request.json';

/** GitHub's own limits on a pull request's title and body. */
const TITLE_MAX = 256;
const BODY_MAX = 65536;
const SHA = /^[0-9a-f]{40}$/;
/**
 * A branch this pushes: letters, digits, `.`, `_`, `-` and `/`. Git allows more, `#`, `%` and `?`
 * among them, which the API's paths would read as a fragment, an escape or a query, so a branch
 * named `main#x` would move `main`. A name outside this set is refused before any request.
 */
const SAFE_BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._/-]*(?<![./])$/;

/**
 * @typedef {{branch: string, base: string, title: string, body: string, labels: string[]}} PullRequest
 * @typedef {{branch: string, why: string}} Refusal
 * @typedef {import('./lib/verified-commits.mjs').Request} Api
 */

/**
 * A bundle's header: the commits it needs, which GitHub has, and the branches it carries.
 *
 * @param {Buffer} bytes
 */
export function bundleHeader(bytes) {
  const end = bytes.indexOf('\n\n');
  const lines = bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8').split('\n');
  if (!/^# v[23] git bundle$/.test(lines[0] ?? '')) throw new Error('the agent\'s job handed on no git bundle');
  /** @type {string[]} */
  const prereqs = [];
  /** @type {{ref: string, sha: string}[]} */
  const refs = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('@')) continue;
    const m = /^(-?)([0-9a-f]{40})(?: (.*))?$/.exec(line);
    if (!m) throw new Error(`the bundle's header has a line git doesn't write: ${JSON.stringify(line.slice(0, 80))}`);
    if (m[1]) prereqs.push(m[2] ?? '');
    else refs.push({ ref: m[3] ?? '', sha: m[2] ?? '' });
  }
  return { prereqs, refs };
}

/**
 * The request the agent wrote, or why it isn't one.
 *
 * @param {string} text
 * @returns {{request: PullRequest} | {problem: string}}
 */
export function readRequest(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { problem: `${REQUEST_PATH} is not JSON` };
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return { problem: `${REQUEST_PATH} is not a JSON object` };
  if (typeof j.branch !== 'string' || !j.branch) return { problem: `${REQUEST_PATH} names no \`branch\`` };
  if (j.base !== undefined && (typeof j.base !== 'string' || !SAFE_BRANCH.test(j.base))) return { problem: `${REQUEST_PATH}'s \`base\` is not a branch name` };
  if (typeof j.title !== 'string' || !j.title.trim() || j.title.length > TITLE_MAX) return { problem: `${REQUEST_PATH}'s \`title\` is empty or longer than ${TITLE_MAX} characters` };
  if (j.body !== undefined && (typeof j.body !== 'string' || j.body.length > BODY_MAX)) return { problem: `${REQUEST_PATH}'s \`body\` is not text of at most ${BODY_MAX} characters` };
  if (j.labels !== undefined && (!Array.isArray(j.labels) || !j.labels.every((/** @type {unknown} */ l) => typeof l === 'string'))) return { problem: `${REQUEST_PATH}'s \`labels\` is not a list of names` };
  return { request: { branch: j.branch, base: j.base ?? '', title: j.title, body: j.body ?? '', labels: j.labels ?? [] } };
}

/**
 * A bare object store holding the bundle's branches under `refs/bundle/`, and the commits they need,
 * each fetched from GitHub one commit deep: never a working tree, so nothing is checked out.
 *
 * @param {{store: string, bundle: string, start: string, server: string, repo: string, token: string}} opts
 */
export function prepareStore({ store, bundle, start, server, repo, token }) {
  const { prereqs } = bundleHeader(readFileSync(bundle));
  const git = (/** @type {string[]} */ a) => execFileSync('git', a, { stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '--bare', store]);
  // The token goes in each request's header, and is never written to the store's config.
  const auth = `http.extraHeader=Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  for (const sha of new Set([...prereqs, start].filter(Boolean))) {
    if (!SHA.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit id`);
    git(['--git-dir', store, '-c', auth, 'fetch', '-q', '--depth=1', '--no-tags', `${server.replace(/\/$/, '')}/${repo}`, sha]);
  }
  git(['--git-dir', store, 'fetch', '-q', '--no-tags', bundle, 'refs/heads/*:refs/bundle/*']);
  return { prereqs };
}

/**
 * Move the branches the rules allow, through the helper, and open the request's pull request.
 *
 * @param {{gitDir: string, prereqs: string[], start: string, ref?: string,
 *          request: {request: PullRequest} | {problem: string} | null, before: string[] | null,
 *          labels: string[], appLogin: string, repo: string, api: Api,
 *          push?: typeof pushVerified, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void}} opts
 */
export async function pushLane({
  gitDir, prereqs, start, ref = '', request, before, labels, appLogin, repo, api, push = pushVerified, sleep, log = () => {},
}) {
  const gitText = (/** @type {string[]} */ a) => execFileSync('git', ['--git-dir', gitDir, ...a], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  const lines = /** @type {string[]} */ ([]);
  /** @type {Refusal[]} */
  const refused = [];
  /** @type {{ref: string, sha: string}[]} */
  const heads = [];
  let base = '';
  /** @type {number | undefined} */
  let pr;

  const repoInfo = await api('GET', `repos/${repo}`);
  if (repoInfo.status !== 200) throw new Error(`reading ${repo}: GitHub answered ${repoInfo.status}`);
  const def = String(repoInfo.json?.default_branch ?? '');
  if (!def) throw new Error(`${repo} names no default branch`);

  const carried = gitText(['for-each-ref', '--format=%(refname)', 'refs/bundle/']).split('\n').filter(Boolean)
    .map((r) => r.slice('refs/bundle/'.length));
  const known = new Set([...prereqs, start].filter(Boolean));
  const existed = Array.isArray(before) ? new Set(before) : null;

  /** @type {PullRequest | null} */
  let pull = null;
  /** @type {string[]} */
  let wanted;
  if (ref) {
    wanted = [ref];
    if (request) lines.push(`A lane that revises \`${ref}\` opens no pull request, so ${REQUEST_PATH} was not read.`);
  } else if (request && 'problem' in request) {
    refused.push({ branch: '', why: `the request is refused: ${request.problem}` });
    wanted = [];
  } else if (request) {
    pull = request.request;
    wanted = [pull.branch];
    const outside = pull.labels.filter((l) => !labels.includes(l));
    if (outside.length) {
      refused.push({ branch: pull.branch, why: `the request asks for ${outside.map((l) => `\`${l}\``).join(', ')}, which this lane doesn't apply (its labels: ${labels.map((l) => `\`${l}\``).join(', ') || 'none'})` });
      wanted = [];
      pull = null;
    }
  } else {
    wanted = carried;
  }
  const left = carried.filter((b) => !wanted.includes(b));

  /** Why `branch` may not move, or `''`. */
  const ruleOut = (/** @type {string} */ branch) => {
    if (!SAFE_BRANCH.test(branch)) return 'its name has a character outside letters, digits, `.`, `_`, `-` and `/`, which an API path could read as another branch';
    if (branch === def) return 'it is the default branch';
    if (branch !== ref && existed === null) return 'the branches that existed before the run are unknown, so it can\'t be told new';
    if (branch !== ref && existed?.has(branch)) return 'it existed before the run';
    if (!carried.includes(branch)) return 'the agent\'s job left no commit on it that GitHub lacks';
    return '';
  };
  // A request is refused whole when its branch is: nothing of it is pushed or opened.
  if (pull) {
    const why = ruleOut(pull.branch);
    if (why) {
      refused.push({ branch: pull.branch, why: `the request is refused: ${why}` });
      wanted = [];
      pull = null;
    }
  }

  for (const branch of wanted) {
    // A revise lane's agent that made no commit on its branch has nothing to push: no refusal.
    if (branch === ref && !carried.includes(branch)) {
      lines.push(`**${branch}**: the agent made no commit on it, so nothing moved.`);
      continue;
    }
    const why = ruleOut(branch);
    if (why) {
      refused.push({ branch, why });
      continue;
    }
    const tip = `refs/bundle/${branch}`;
    // The commits the bundle brought, each of which the helper may create: none may hold the request.
    const own = gitText(['rev-list', tip, '--not', ...known]).split('\n').filter(Boolean);
    if (own.some((c) => gitText(['ls-tree', '--name-only', c, '--', REQUEST_PATH]) !== '')) {
      refused.push({ branch, why: `a commit on it carries ${REQUEST_PATH}, which the spine keeps out of every commit` });
      continue;
    }
    // The head it builds on: the checked-out commit on a revise lane, else the first commit on the
    // tip's first-parent path that GitHub has (the store holds only the bundle and those).
    const head = ref ? start : (gitText(['rev-list', '--first-parent', tip]).split('\n').filter(Boolean).at(-1) ?? '');
    if (!known.has(head)) {
      refused.push({ branch, why: 'it is built on no commit GitHub has' });
      continue;
    }
    try {
      const r = await push({ gitDir, tip, branch, head, appLogin, repo, request: api, log, ...(sleep ? { sleep } : {}) });
      heads.push({ ref: branch, sha: r.head });
      if (!base || branch === pull?.branch) base = r.base;
      lines.push(...summary(r, branch), '');
    } catch (e) {
      refused.push({ branch, why: /** @type {Error} */ (e).message });
    }
  }

  if (pull && heads.some((h) => h.ref === pull?.branch)) {
    const opened = await api('POST', `repos/${repo}/pulls`, { head: pull.branch, base: pull.base || def, title: pull.title, body: pull.body });
    if (opened.status !== 201) throw Object.assign(new Error(`opening the pull request from ${pull.branch}: GitHub answered ${opened.status} ${opened.json?.message ?? ''}`.trim()), { partial: { heads, base, refused, left, lines } });
    pr = Number(opened.json.number);
    lines.push(`Opened #${pr} from **${pull.branch}** into **${pull.base || def}**.`);
    if (pull.labels.length) {
      const labelled = await api('POST', `repos/${repo}/issues/${pr}/labels`, { labels: pull.labels });
      if (labelled.status !== 200) throw Object.assign(new Error(`labelling #${pr}: GitHub answered ${labelled.status} ${labelled.json?.message ?? ''}`.trim()), { partial: { heads, base, pr, refused, left, lines } });
    }
  } else if (!ref && !request) {
    lines.push('The agent wrote no request, so no pull request was opened.');
  }
  if (left.length) lines.push(`Left on the agent's runner, not pushed: ${left.map((b) => `\`${b}\``).join(', ')}.`);
  for (const r of refused) lines.push(`Refused${r.branch ? ` **${r.branch}**` : ''}: ${r.why}.`);
  if (!heads.length && !refused.length) lines.push('Nothing moved.');
  return { heads, base, pr, refused, left, lines };
}

if (isCliEntry(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? '' : (process.argv[i + 1] ?? '');
  };
  const token = process.env.GH_TOKEN ?? '';
  const repo = process.env.REPO ?? '';
  /** @param {{heads?: {ref: string, sha: string}[], base?: string, pr?: number, lines?: string[]}} r */
  const report = (r) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `heads=${JSON.stringify(r.heads ?? [])}\nbase=${r.base ?? ''}\npr=${r.pr ?? ''}\n`);
    const text = (r.lines ?? []).join('\n');
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  try {
    if (!token) throw new Error('no GH_TOKEN, the push job\'s token');
    const start = arg('--start');
    if (!SHA.test(start)) throw new Error(`--start ${JSON.stringify(start)} is not the commit the agent's job checked out`);
    const store = join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'kanon-push-store-')), 'store.git');
    const { prereqs } = prepareStore({
      store, bundle: arg('--bundle'), start, server: process.env.GITHUB_SERVER_URL || 'https://github.com', repo, token,
    });
    const requestFile = arg('--request');
    const request = requestFile && existsSync(requestFile) ? readRequest(readFileSync(requestFile, 'utf8')) : null;
    let before = null;
    try {
      const b = JSON.parse(arg('--before') || 'null');
      before = Array.isArray(b) && b.every((x) => typeof x === 'string') ? b : null;
    } catch { /* unknown: a new branch can't be told from an old one, and none moves */ }
    const r = await pushLane({
      gitDir: store, prereqs, start, ref: arg('--ref'), request, before, labels: arg('--labels').split(/\s+/).filter(Boolean),
      appLogin: arg('--app-login'), repo, api: githubRequest({ token, api: process.env.GITHUB_API_URL || undefined }), log: (line) => console.log(line),
    });
    report(r);
    if (r.refused.length) {
      for (const x of r.refused) console.log(`::error title=push::${x.branch ? `${x.branch}: ` : ''}${x.why}`);
      process.exit(1);
    }
  } catch (e) {
    const err = /** @type {Error & {partial?: Parameters<typeof report>[0]}} */ (e);
    report(err.partial ?? {});
    console.log(`::error title=push::${err.message}`);
    process.exit(1);
  }
}
