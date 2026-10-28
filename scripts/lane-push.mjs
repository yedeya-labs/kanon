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
//   below. The helper refuses it if it moved, or if the agent rewrote it (`K-AGENT-34`). With
//   `--pr`, the pull request's head must be that branch, of this repository, never a fork's.
// - On the rebase lane (`--merged`, kanon#1384), that branch moves only to a resolution of its
//   conflict (`[LANE-17]`): one merge commit, whose first parent is `--start` and whose second is
//   `--merged`, the default branch's head as the agent's job fetched it, before its agent ran. A
//   commit after the merge, such as a fix for a test the merged tree broke, has one parent.
// - On a lane that opens one branch of its own name (`--replace`, the Lead's split lane, kanon#1385),
//   that branch alone, in the helper's replace mode (`[LANE-18]`): it may be a dead branch an
//   earlier run left, whose pull request closed unmerged, so it is the one branch that may have
//   existed before the run, and the only one the lane may name. It is built over the first commit
//   GitHub has on its first-parent path, which the helper takes only while GitHub compares it as on
//   the default branch. It is never replaced while it heads an open pull request. A request must
//   ask for that branch, into the default branch; with none, the branch is still replaced.
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
// Usage: node scripts/lane-push.mjs --bundle <file> [--request <file>] --start <sha> [--ref <branch>
//          [--pr <n>] [--merged <sha>] | --replace <branch>] --before <JSON array> --labels "<names>"
//          --app-login <slug>[bot]
// `--before` is not read with `--replace`, which names the one branch that may move.
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
 * Why the commits from `tip` back to `start` are not the rebase lane's resolution, or `''`
 * (`[LANE-17]`): exactly one merge commit on the first-parent path, whose parents are `start` and
 * `merged` in that order. Every other commit on the path then has one parent, since none has none
 * and a second merge is refused. A merge's first parent is where its first-parent path goes on, so
 * a merge whose first parent is `start` is the path's oldest.
 *
 * @param {{gitDir: string, tip: string, start: string, merged: string}} opts
 */
export function mergeShape({ gitDir, tip, start, merged }) {
  const path = execFileSync('git', ['--git-dir', gitDir, 'rev-list', '--first-parent', '--parents', tip, '--not', start], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [sha = '', ...parents] = line.split(' ');
      return { sha, parents };
    });
  const merges = path.filter((c) => c.parents.length > 1);
  if (!merges.length) return `it holds no merge commit: the rebase lane resolves a conflict by merging ${merged} into ${start}`;
  if (merges.length > 1) return `it holds ${merges.length} merge commits on its first-parent path (${merges.map((c) => c.sha).join(', ')}); the rebase lane makes one`;
  const [merge] = merges;
  const [first, second, ...more] = merge?.parents ?? [];
  if (first !== start) return `its merge ${merge?.sha}'s first parent is ${first}, not the pull request's head as the job fetched it (${start})`;
  if (second !== merged || more.length) return `its merge ${merge?.sha}'s other parents are ${[second, ...more].join(', ')}, not the default branch's head recorded before the agent ran (${merged})`;
  return '';
}

/**
 * Why `ref` is not `pr`'s head branch in `repo`, or `''`: read from GitHub with the push job's own
 * token, so a pull request whose head is a fork's branch, or another branch, moves nothing.
 *
 * @param {{api: Api, repo: string, pr: number, ref: string}} opts
 */
export async function pullHeadProblem({ api, repo, pr, ref }) {
  const r = await api('GET', `repos/${repo}/pulls/${pr}`);
  if (r.status !== 200) return `reading #${pr}: GitHub answered ${r.status}`;
  const from = r.json?.head?.repo?.full_name;
  if (typeof from !== 'string' || from.toLowerCase() !== repo.toLowerCase()) return `#${pr}'s head is a branch of ${from ? `\`${from}\`` : 'no repository'}, not of ${repo}`;
  if (r.json?.head?.ref !== ref) return `#${pr}'s head is \`${r.json?.head?.ref}\`, not \`${ref}\``;
  return '';
}

/**
 * The open pull request whose head is `branch` in `repo`, by number, or `null`; read with the push
 * job's own token, before replace mode forces the branch (kanon#1385).
 *
 * @param {{api: Api, repo: string, branch: string}} opts
 */
export async function openPullOn({ api, repo, branch }) {
  const owner = repo.split('/')[0] ?? '';
  const r = await api('GET', `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`);
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`listing the open pull requests on ${branch}: GitHub answered ${r.status}`);
  return r.json.length ? Number(r.json[0]?.number) : null;
}

/**
 * Move the branches the rules allow, through the helper, and open the request's pull request.
 *
 * @param {{gitDir: string, prereqs: string[], start: string, ref?: string, merged?: string, pr?: number, replace?: string,
 *          request: {request: PullRequest} | {problem: string} | null, before: string[] | null,
 *          labels: string[], appLogin: string, repo: string, api: Api,
 *          push?: typeof pushVerified, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void}} opts
 */
export async function pushLane({
  gitDir, prereqs, start, ref = '', merged = '', pr: pullNumber, replace = '', request, before, labels, appLogin, repo, api, push = pushVerified, sleep, log = () => {},
}) {
  if (!ref && (merged || pullNumber !== undefined)) throw new Error('--merged and --pr name the branch a lane revises, and come only with --ref');
  if (replace && ref) throw new Error('--replace names the one branch a lane opens, and --ref the one it revises: a lane gives one');
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
    const why = pullNumber === undefined ? '' : await pullHeadProblem({ api, repo, pr: pullNumber, ref });
    if (why) {
      refused.push({ branch: ref, why });
      wanted = [];
    }
  } else if (request && 'problem' in request) {
    refused.push({ branch: '', why: `the request is refused: ${request.problem}` });
    wanted = [];
  } else if (request) {
    pull = request.request;
    wanted = [pull.branch];
    const outside = pull.labels.filter((l) => !labels.includes(l));
    // In replace mode the request is for the lane's branch, into the default branch, or for nothing.
    const other = !replace ? ''
      : pull.branch !== replace ? `its branch is not \`${replace}\`, the one this lane replaces`
        : pull.base && pull.base !== def ? `its base is \`${pull.base}\`, not the default branch, ${def}, which the branch is built over` : '';
    if (other) {
      refused.push({ branch: pull.branch, why: `the request is refused: ${other}` });
      wanted = [];
      pull = null;
    } else if (outside.length) {
      refused.push({ branch: pull.branch, why: `the request asks for ${outside.map((l) => `\`${l}\``).join(', ')}, which this lane doesn't apply (its labels: ${labels.map((l) => `\`${l}\``).join(', ') || 'none'})` });
      wanted = [];
      pull = null;
    }
  } else {
    wanted = replace ? [replace] : carried;
  }
  const left = carried.filter((b) => !wanted.includes(b));

  /** Why `branch` may not move, or `''`. */
  const ruleOut = (/** @type {string} */ branch) => {
    if (!SAFE_BRANCH.test(branch)) return 'its name has a character outside letters, digits, `.`, `_`, `-` and `/`, which an API path could read as another branch';
    if (branch === def) return 'it is the default branch';
    // The lane's own branch, which it revises or replaces, is the one that may have existed before.
    const own = branch === ref || branch === replace;
    if (!own && existed === null) return 'the branches that existed before the run are unknown, so it can\'t be told new';
    if (!own && existed?.has(branch)) return 'it existed before the run';
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
    // The rebase lane's resolution is one merge of the recorded default branch, and nothing else.
    const shape = merged ? mergeShape({ gitDir, tip, start, merged }) : '';
    if (shape) {
      refused.push({ branch, why: shape });
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
      // Replace mode forces the branch, so never while a pull request is open on it.
      const open = replace ? await openPullOn({ api, repo, branch }) : null;
      if (open !== null) {
        refused.push({ branch, why: `it heads the open pull request #${open}, which replacing it would rewrite` });
        continue;
      }
      const r = await push({ gitDir, tip, branch, head, ...(replace ? { replace: true } : {}), appLogin, repo, request: api, log, ...(sleep ? { sleep } : {}) });
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
    // Given, `--merged` is never empty: an empty one would push as a revise does, with no merge
    // checked (`[LANE-17]`). Only the rebase lane passes it.
    const merged = arg('--merged');
    if (process.argv.includes('--merged') && !SHA.test(merged)) throw new Error(`--merged ${JSON.stringify(merged)} is not the default branch's head the agent's job fetched`);
    const prText = arg('--pr');
    if (prText && !/^[1-9]\d*$/.test(prText)) throw new Error(`--pr ${JSON.stringify(prText)} is not a pull request's number`);
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
      gitDir: store, prereqs, start, ref: arg('--ref'), merged, ...(prText ? { pr: Number(prText) } : {}), replace: arg('--replace'), request, before, labels: arg('--labels').split(/\s+/).filter(Boolean),
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
