// The verified-commit helper (kanon#1382, plan in docs/projects/1373.md): turns a range of local
// commits into commits GitHub's API creates with the lane's App token, which GitHub signs as the
// App's, and moves a branch to them.
//
// WHY THE API. GitHub signs an App's commit only when the App's own token created it through the
// API with no custom author or committer (`actions/dco/dco.mjs`). A commit the agent makes with git
// and pushes is unsigned, and the email in it is all that says the App wrote it, which anyone with
// push access can set. So the agent commits locally, and this re-creates each commit through the
// Git Data API: its blobs, its tree with every entry's mode, the commit, and last the ref.
//
// WHAT IT TAKES: a git object store and a range, never a working tree, so the job that runs it
// checks nothing out. The range is `--tip` back to `--head`, the commit the branch is expected at.
//
// WHAT IT HOLDS (`[LANE-6]` to `[LANE-11]`, docs/qa/specs/lanes.md):
// - It re-creates only the commits the repository lacks, oldest first. A commit the repository
//   has is kept as it is, whoever wrote it, so a person's commit the agent fetched and built on is
//   never laundered into the App's (#1358's case).
// - Each created commit has the local commit's tree id, which it checks before creating the
//   commit, and a range that touches a submodule entry is refused before anything is created.
// - The message is sent byte for byte, and nothing else but the tree and the parents: no author,
//   committer or signature, which would forfeit GitHub's signature.
// - Every created commit is read back, and must be verified with the App's bot account as its
//   author, before any branch moves.
// - The branch is created, moved without force from the head it was given, or refused. Only
//   replace mode forces, and it builds over the default branch's head.
// - It reads and moves exactly the branch it was named: each ref path carries the name
//   percent-encoded, so a `#` or a `%` in it can't name another branch (kanon#1392), and a name
//   git doesn't allow for a branch is refused before any request.
// - A blob already in a parent's tree is not uploaded again. Requests that create objects are
//   paced, and a rate limit is waited out within the bounds below. The ref moves last, so a run
//   that can't finish has moved nothing.
//
// Usage: node scripts/lib/verified-commits.mjs --git-dir <store> --tip <commit> --branch <name>
//          (--head <sha> | --replace) --app-login <slug>[bot]
// Reads `GH_TOKEN`, `REPO` and `GITHUB_API_URL` (api.github.com when unset). Writes `head=<the
// branch's new head>`, `base=<the head it built on>` and `created=<each created commit, by commas>`
// to `$GITHUB_OUTPUT`, and each local commit and the commit created from it to the step summary.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isCliEntry } from './cli-entry.mjs';

/** The wait between two requests that create something: GitHub asks for about a second. */
export const PACE_MS = 1000;
/** How many times a rate-limited request is sent again before the run fails. */
export const RETRIES = 3;
/** The longest wait the helper takes on a rate limit. A longer one GitHub names fails the run. */
export const MAX_WAIT_MS = 120_000;
/** GitHub's advice for a secondary rate limit that names no time: wait at least a minute. */
export const UNNAMED_WAIT_MS = 60_000;
/** A created commit's verification is read this many times, this far apart, before it fails. */
export const READBACK = { tries: 3, waitMs: 2000 };

const SUBMODULE = '160000';

/**
 * @typedef {{status: number, headers: Record<string, string>, json: any}} Response
 * @typedef {(method: string, path: string, body?: unknown) => Promise<Response>} Request
 *   `path` is relative to the API's root, as `repos/<owner>/<name>/git/blobs`.
 * @typedef {{local: string, remote: string}} Created
 * @typedef {{head: string, base: string, created: Created[], move: 'created'|'moved'|'forced'|'unchanged'}} Result
 */

/**
 * A `Request` over `fetch`, to `api` with `token`.
 *
 * @param {{token: string, api?: string, fetchImpl?: typeof fetch}} opts
 */
export function githubRequest({ token, api = 'https://api.github.com', fetchImpl = fetch }) {
  /** @type {Request} */
  return async (method, path, body) => {
    const r = await fetchImpl(`${api.replace(/\/$/, '')}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text };
    }
    return { status: r.status, headers: Object.fromEntries(r.headers), json };
  };
}

/** Whether `r` is a rate limit's answer, primary or secondary. */
const limited = (/** @type {Response} */ r) => (r.status === 403 || r.status === 429)
  && (r.headers['retry-after'] !== undefined || r.headers['x-ratelimit-remaining'] === '0'
    || /rate limit/i.test(String(r.json?.message ?? '')));

/** The wait a rate limit names: `retry-after`, else the primary limit's reset, else a minute. */
const namedWait = (/** @type {Response} */ r, /** @type {number} */ now) => {
  const after = Number(r.headers['retry-after']);
  if (r.headers['retry-after'] !== undefined && Number.isFinite(after)) return Math.max(0, after * 1000);
  const reset = Number(r.headers['x-ratelimit-reset']);
  if (r.headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset)) return Math.max(0, reset * 1000 - now);
  return UNNAMED_WAIT_MS;
};

/**
 * `branch` as a ref path's tail, each `/`-separated segment percent-encoded, so GitHub receives the
 * whole name (kanon#1392): unencoded, a `#` would end the path, as the start of the URL's fragment,
 * and a `%` would be decoded into another name.
 */
export const branchPath = (/** @type {string} */ branch) => branch.split('/').map(encodeURIComponent).join('/');

/**
 * Whether `branch` is a name git allows for a branch, as `git check-ref-format --branch` decides,
 * and not one it expands into another: run inside a repository (`cwd`, the process's own by
 * default), it turns `@{-1}` into the branch checked out before.
 *
 * @param {string} branch
 * @param {string} [cwd]
 */
export function validBranch(branch, cwd) {
  try {
    return execFileSync('git', ['check-ref-format', '--branch', branch], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim() === branch;
  } catch {
    return false;
  }
}

/**
 * Re-create `--tip`'s commits that the repository lacks, verify each, and move `branch` to them.
 *
 * @param {{gitDir: string, tip: string, branch: string, head?: string, replace?: boolean,
 *          appLogin: string, repo: string, request: Request,
 *          sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (line: string) => void}} opts
 * @returns {Promise<Result>}
 */
export async function pushVerified({
  gitDir, tip, branch, head = '', replace = false, appLogin, repo, request,
  sleep = (ms) => delay(ms), now = Date.now, log = () => {},
}) {
  if (!appLogin) throw new Error('no --app-login: the read-back has no bot account to require');
  if (!branch) throw new Error('no --branch to move');
  if (!validBranch(branch)) throw new Error(`--branch ${JSON.stringify(branch)} is not a valid branch name, so nothing was sent`);
  if (replace === Boolean(head)) throw new Error('give either --head, the commit the branch is expected at, or --replace');
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['--git-dir', gitDir, ...a], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const gitText = (/** @type {string[]} */ a) => git(a).toString('utf8').trim();
  const resolve = (/** @type {string} */ rev) => gitText(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]);
  const refPath = `git/refs/heads/${branchPath(branch)}`;

  let lastCreate = -Infinity;
  /** Send a request, pacing the ones that create something, and waiting out a rate limit. */
  const call = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body = undefined) => {
    for (let attempt = 0; ; attempt++) {
      if (method !== 'GET') {
        const wait = lastCreate + PACE_MS - now();
        if (wait > 0) await sleep(wait);
        lastCreate = now();
      }
      const r = await request(method, path ? `repos/${repo}/${path}` : `repos/${repo}`, body);
      if (!limited(r)) return r;
      const wait = namedWait(r, now());
      if (attempt >= RETRIES) throw new Error(`${method} ${path} was still rate-limited after ${RETRIES} retries, so no branch moved`);
      if (wait > MAX_WAIT_MS) throw new Error(`${method} ${path} was rate-limited for ${Math.ceil(wait / 1000)}s, longer than the ${MAX_WAIT_MS / 1000}s this helper waits, so no branch moved`);
      log(`rate-limited on ${method} ${path}: waiting ${Math.ceil(wait / 1000)}s (retry ${attempt + 1} of ${RETRIES})`);
      await sleep(wait);
    }
  };
  const ok = (/** @type {Response} */ r, /** @type {string} */ what) => {
    if (r.status < 200 || r.status > 299) throw new Error(`${what}: GitHub answered ${r.status} ${r.json?.message ?? ''}`.trim());
    return r.json;
  };
  /** The branch's head on GitHub, or `''` when it doesn't exist. */
  const remoteRef = async () => {
    const r = await call('GET', `git/ref/heads/${branchPath(branch)}`);
    if (r.status === 404) return '';
    return String(ok(r, `reading ${branch}`).object.sha);
  };

  // The head it builds on: the one it was given, or in replace mode the default branch's.
  let base = head;
  if (replace) {
    const def = String(ok(await call('GET', ''), `reading ${repo}`).default_branch);
    if (def === branch) throw new Error(`replace mode never moves the default branch, ${def}`);
    const r = await call('GET', `git/ref/heads/${branchPath(def)}`);
    base = String(ok(r, `reading ${def}`).object.sha);
  }
  const tipSha = resolve(tip);
  base = resolve(base);
  try {
    git(['merge-base', '--is-ancestor', base, tipSha]);
  } catch {
    throw new Error(`${tipSha.slice(0, 7)} is not built on ${base.slice(0, 7)}, so ${branch} can't move to it from there`);
  }

  /** How `branch` moves, from what GitHub has: refused unless it is absent, at base, or replaced. */
  const decide = (/** @type {string} */ at) => {
    if (!at) return 'created';
    if (replace) return 'forced';
    if (at === base) return 'moved';
    throw new Error(`${branch} is at ${at.slice(0, 7)}, not ${base.slice(0, 7)}, the head this push was given, so it moves nothing`);
  };
  decide(await remoteRef());

  // [LANE-6] Only the commits GitHub lacks are re-created; every other one is kept as it is.
  const range = gitText(['rev-list', '--reverse', '--topo-order', tipSha, '--not', base]).split('\n').filter(Boolean);
  /** @type {string[]} */
  const missing = [];
  for (const sha of range) {
    const r = await call('GET', `git/commits/${sha}`);
    if (r.status === 404) missing.push(sha);
    else ok(r, `asking whether GitHub has ${sha}`);
  }

  const parentsOf = (/** @type {string} */ sha) => gitText(['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);
  /** `[oldMode, newMode, oldSha, newSha, status, path]` for each path `sha` changes from `parent`. */
  const diff = (/** @type {string} */ parent, /** @type {string} */ sha) => {
    const out = git(['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-commit-id', ...(parent ? [parent, sha] : ['--root', sha])])
      .toString('utf8').split('\0');
    /** @type {string[][]} */
    const rows = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const [oldMode = '', newMode = '', oldSha = '', newSha = '', status = ''] = (out[i] ?? '').replace(/^:/, '').split(' ');
      rows.push([oldMode, newMode, oldSha, newSha, status, out[i + 1] ?? '']);
    }
    return rows;
  };

  // [LANE-7] A submodule entry added, changed or removed is refused before anything is created.
  for (const sha of missing) {
    for (const parent of parentsOf(sha).length ? parentsOf(sha) : ['']) {
      const sub = diff(parent, sha).find(([o, n]) => o === SUBMODULE || n === SUBMODULE);
      if (sub) throw new Error(`${sha.slice(0, 7)} changes the submodule \`${sub[5]}\`, which this helper doesn't re-create, so nothing was created`);
    }
  }

  // [LANE-8] The message is the bytes after the commit's header, which must survive as UTF-8.
  const messageOf = (/** @type {string} */ sha) => {
    const raw = git(['cat-file', 'commit', sha]);
    const end = raw.indexOf('\n\n');
    const header = raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
    const enc = /^encoding (.+)$/m.exec(header)?.[1];
    if (enc && !/^utf-?8$/i.test(enc)) throw new Error(`${sha.slice(0, 7)}'s message is ${enc}, which can't be sent byte for byte`);
    const bytes = end === -1 ? Buffer.alloc(0) : raw.subarray(end + 2);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${sha.slice(0, 7)}'s message is not UTF-8, so it can't be sent byte for byte`);
    return text;
  };

  /** @type {Map<string, string>} */
  const made = new Map();
  /** @type {Set<string>} */
  const uploaded = new Set();
  for (const sha of missing) {
    const parents = parentsOf(sha);
    const tree = gitText(['rev-parse', `${sha}^{tree}`]);
    const first = parents[0] ?? '';
    // [LANE-11] A blob already in a parent's tree is on GitHub, and isn't sent again.
    const known = new Set(uploaded);
    for (const p of parents) {
      for (const entry of git(['ls-tree', '-r', '-z', p]).toString('utf8').split('\0')) {
        const id = entry.split('\t')[0]?.split(' ')[2];
        if (id) known.add(id);
      }
    }
    const entries = [];
    for (const [oldMode, newMode, , newSha, status, path] of diff(first, sha)) {
      if (status === 'D') {
        entries.push({ path, mode: oldMode, type: 'blob', sha: null });
        continue;
      }
      const blob = /** @type {string} */ (newSha);
      if (!known.has(blob)) {
        const content = git(['cat-file', 'blob', blob]).toString('base64');
        const got = ok(await call('POST', 'git/blobs', { content, encoding: 'base64' }), `uploading ${path}`).sha;
        if (got !== blob) throw new Error(`GitHub stored ${path} as ${got}, not ${blob}, so nothing moved`);
        uploaded.add(blob);
        known.add(blob);
      }
      entries.push({ path, mode: newMode, type: 'blob', sha: blob });
    }
    // [LANE-7] The created tree must be the local commit's tree, or no commit is made of it.
    if (entries.length) {
      const got = ok(await call('POST', 'git/trees', { ...(first ? { base_tree: gitText(['rev-parse', `${first}^{tree}`]) } : {}), tree: entries }), `creating ${sha.slice(0, 7)}'s tree`).sha;
      if (got !== tree) throw new Error(`GitHub built ${sha.slice(0, 7)}'s tree as ${got}, not ${tree}, so no commit was created from it`);
    } else if (!first || gitText(['rev-parse', `${first}^{tree}`]) !== tree) {
      throw new Error(`${sha.slice(0, 7)} changes nothing from its first parent but has another tree, ${tree}`);
    }
    // [LANE-8] The message, the tree and the parents, and nothing else.
    const body = { message: messageOf(sha), tree, parents: parents.map((p) => made.get(p) ?? p) };
    const created = String(ok(await call('POST', 'git/commits', body), `creating ${sha.slice(0, 7)}`).sha);
    made.set(sha, created);
    log(`created ${created} from ${sha}`);
  }

  // [LANE-9] Every created commit verified as the App's before any branch moves.
  for (const created of made.values()) {
    for (let read = 1; ; read++) {
      const c = ok(await call('GET', `commits/${created}`), `reading back ${created.slice(0, 7)}`);
      const v = c.commit?.verification ?? {};
      const login = c.author?.login ?? '';
      if (v.verified === true && login === appLogin) break;
      if (v.verified !== true && read < READBACK.tries) {
        await sleep(READBACK.waitMs);
        continue;
      }
      throw new Error(`${created} is ${v.verified === true ? 'verified' : `not verified (${v.reason ?? 'no reason given'})`} with ${login || 'no account'} as its author, not ${appLogin}, so no branch moved`);
    }
  }

  // [LANE-10] Create, move from the head it was given, force only in replace mode, or refuse.
  const newHead = made.get(tipSha) ?? tipSha;
  const at = await remoteRef();
  const created = [...made].map(([local, remote]) => ({ local, remote }));
  if (at === newHead) return { head: newHead, base, created, move: 'unchanged' };
  const move = decide(at);
  if (move === 'created') ok(await call('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha: newHead }), `creating ${branch}`);
  else ok(await call('PATCH', refPath, { sha: newHead, force: move === 'forced' }), `moving ${branch}`);
  return { head: newHead, base, created, move };
}

/** The step summary's lines for a result. */
export function summary(/** @type {Result} */ r, /** @type {string} */ branch) {
  const verb = { created: 'created', moved: 'moved', forced: 'replaced', unchanged: 'left' }[r.move];
  return [
    `**${branch}** ${verb} at \`${r.head.slice(0, 7)}\`, built on \`${r.base.slice(0, 7)}\`.`,
    '',
    ...(r.created.length
      ? ['| Local commit | Created, verified as the App\'s |', '|---|---|', ...r.created.map((c) => `| \`${c.local.slice(0, 7)}\` | \`${c.remote.slice(0, 7)}\` |`)]
      : ['No commit needed creating: GitHub had each one.']),
  ];
}

if (isCliEntry(import.meta.url)) {
  const arg = (/** @type {string} */ name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? '' : (process.argv[i + 1] ?? '');
  };
  const token = process.env.GH_TOKEN ?? '';
  if (!token) {
    console.error('verified-commits: no GH_TOKEN, the App token the commits are created with');
    process.exit(2);
  }
  const branch = arg('--branch');
  try {
    const r = await pushVerified({
      gitDir: arg('--git-dir'), tip: arg('--tip'), branch, head: arg('--head'), replace: process.argv.includes('--replace'),
      appLogin: arg('--app-login'), repo: process.env.REPO ?? '',
      request: githubRequest({ token, api: process.env.GITHUB_API_URL || undefined }), log: (line) => console.log(line),
    });
    const lines = summary(r, branch);
    console.log(lines.join('\n'));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `head=${r.head}\nbase=${r.base}\ncreated=${r.created.map((c) => c.remote).join(',')}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  } catch (e) {
    const why = /** @type {Error} */ (e).message;
    console.log(`::error title=verified commits::${why}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**${branch}** moved nothing: ${why}\n`);
    process.exit(1);
  }
}
