// A recording double of GitHub's Git Data API, over a real bare repository (kanon#1382).
//
// The verified-commit helper's tests run against it: every request is recorded, and each answer
// is the one GitHub's would be for that repository, so a blob's id, a tree's id and a commit's
// parents are real git's, and a tree built wrong has the wrong id. A commit created through the
// double is the App's and verified, as GitHub signs an App token's API commit. A commit that
// arrived by `git push` is a person's and unverified. Each can be overridden, and an answer can
// be replaced, as a rate limit's, before the double handles the request.
//
// It reads a request's path as GitHub's server does (kanon#1392): what follows a `#` is the URL's
// fragment, which is never sent, what follows a `?` is the query, and each `/`-separated segment
// is percent-decoded. So a branch name put into a path unencoded names the ref GitHub would read.
//
// Imported, `fakeGitHub` returns the `request` the helper takes. Run as a script, it serves the
// same double over HTTP for a workflow step's test:
//   node fake-git-data-api.mjs <remote.git> <owner/name> <app-login> <dir>
// It writes the port it listens on to `<dir>/port`, and each request, one JSON line each, to
// `<dir>/calls.jsonl`. It answers the pull requests `<dir>/pulls.json` holds, when there is one.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {{method: string, path: string, body?: any}} Call
 * @typedef {{status: number, headers: Record<string, string>, json: any}} Answer
 * @param {{remote: string, repo: string, appLogin: string,
 *          authors?: Record<string, string>, committers?: Record<string, string>, defaultBranch?: string,
 *          verification?: (sha: string, byApi: boolean) => {verified: boolean, reason: string} | undefined,
 *          pulls?: Record<string, any>,
 *          before?: (call: Call, calls: Call[]) => Answer | undefined}} opts
 */
export function fakeGitHub({ remote, repo, appLogin, authors = {}, committers = {}, defaultBranch = 'main', verification = () => undefined, pulls = {}, before = () => undefined }) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {Set<string>} */
  const byApi = new Set();
  const git = (/** @type {string[]} */ a, /** @type {{input?: Buffer|string, env?: Record<string, string>}} */ o = {}) =>
    execFileSync('git', ['--git-dir', remote, ...a], { input: o.input, env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8').trim();
  const has = (/** @type {string} */ sha, /** @type {string} */ type) => {
    try {
      return git(['cat-file', '-t', sha]) === type;
    } catch {
      return false;
    }
  };
  const refOf = (/** @type {string} */ branch) => {
    try {
      return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch {
      return '';
    }
  };
  /** The path the server receives: no fragment or query, each segment decoded; `null` if it can't be. */
  const received = (/** @type {string} */ path) => {
    try {
      return new URL(path, 'http://fake.invalid/').pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
  };
  const answer = (/** @type {number} */ status, /** @type {any} */ json) => ({ status, headers: {}, json });
  const prefix = `repos/${repo}`;

  /** @param {string} method @param {string} path @param {any} [body] @returns {Promise<Answer>} */
  const request = async (method, path, body) => {
    const call = { method, path, ...(body === undefined ? {} : { body: JSON.parse(JSON.stringify(body)) }) };
    calls.push(call);
    const replaced = before(call, calls);
    if (replaced) return replaced;
    const served = received(path);
    if (served === null) return answer(400, { message: 'Bad Request' });
    if (served === prefix && method === 'GET') return answer(200, { default_branch: defaultBranch });
    if (!served.startsWith(`${prefix}/`)) return answer(404, { message: 'Not Found' });
    const p = served.slice(prefix.length + 1);
    let m;
    // A pull request, as the `pulls` it was given hold it: its head branch and repository.
    if (method === 'GET' && (m = /^pulls\/(\d+)$/.exec(p))) {
      return pulls[m[1] ?? ''] ? answer(200, pulls[m[1] ?? '']) : answer(404, { message: 'Not Found' });
    }
    // The pull requests listed by `head=<owner>:<branch>` and `state`, which the query carries.
    if (method === 'GET' && p === 'pulls') {
      const q = new URL(path, 'http://fake.invalid/').searchParams;
      const state = q.get('state') ?? 'open';
      return answer(200, Object.entries(pulls).map(([n, pr]) => ({ number: Number(n), state: 'open', ...pr }))
        .filter((pr) => (!q.has('head') || `${String(pr.head?.repo?.full_name ?? '').split('/')[0]}:${pr.head?.ref}` === q.get('head'))
          && (state === 'all' || pr.state === state)));
    }
    // Two commits compared as GitHub's `compare/<base>...<head>` answers: `ahead` when `head` has
    // commits `base` lacks and lacks none of `base`'s, `identical`, `behind` or `diverged`.
    if (method === 'GET' && (m = /^compare\/(.+?)\.\.\.(.+)$/.exec(p))) {
      const at = (/** @type {string} */ rev) => (/^[0-9a-f]{40}$/.test(rev) && has(rev, 'commit') ? rev : refOf(rev));
      const [from, to] = [at(m[1] ?? ''), at(m[2] ?? '')];
      if (!from || !to) return answer(404, { message: 'Not Found' });
      const ancestor = (/** @type {string} */ a, /** @type {string} */ b) => {
        try {
          git(['merge-base', '--is-ancestor', a, b]);
          return true;
        } catch {
          return false;
        }
      };
      const status = from === to ? 'identical' : ancestor(from, to) ? 'ahead' : ancestor(to, from) ? 'behind' : 'diverged';
      return answer(200, { status });
    }
    if (method === 'GET' && (m = /^git\/commits\/(\w+)$/.exec(p))) {
      return has(m[1] ?? '', 'commit') ? answer(200, { sha: m[1], tree: { sha: git(['rev-parse', `${m[1]}^{tree}`]) } }) : answer(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = /^commits\/(\w+)$/.exec(p))) {
      const sha = m[1] ?? '';
      if (!has(sha, 'commit')) return answer(422, { message: 'No commit found' });
      const api = byApi.has(sha);
      const v = verification(sha, api) ?? (api ? { verified: true, reason: 'valid' } : { verified: false, reason: 'unsigned' });
      // An API commit's committer as `web-flow`, one of the two `verifiedAs` accepts: which one GitHub
      // records for an App's commit is unmeasured (kanon#1482), and `committers` sets the other.
      const author = { login: authors[sha] ?? (api ? appLogin : 'a-person'), type: api ? 'Bot' : 'User' };
      return answer(200, { sha, author, committer: { login: committers[sha] ?? (api ? 'web-flow' : 'a-person') }, commit: { verification: v } });
    }
    if (method === 'POST' && p === 'git/blobs') {
      return answer(201, { sha: git(['hash-object', '-w', '--stdin'], { input: Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8') }) });
    }
    if (method === 'POST' && p === 'git/trees') {
      const dir = mkdtempSync(join(tmpdir(), 'fake-index-'));
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      try {
        git(body.base_tree ? ['read-tree', body.base_tree] : ['read-tree', '--empty'], { env });
        // Mode 0 removes a path: `--index-info` needs no work tree, as `--force-remove` does.
        for (const e of body.tree) {
          if (e.sha !== null && !has(e.sha, 'blob')) return answer(422, { message: `tree.sha ${e.sha} is not a valid blob` });
        }
        const info = body.tree.map((/** @type {{path: string, mode: string, sha: string|null}} */ e) => (e.sha === null ? `0 ${'0'.repeat(40)}\t${e.path}\0` : `${e.mode} ${e.sha}\t${e.path}\0`)).join('');
        git(['update-index', '-z', '--index-info'], { input: info, env });
        return answer(201, { sha: git(['write-tree'], { env }) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (method === 'POST' && p === 'git/commits') {
      if (!has(body.tree, 'tree')) return answer(422, { message: 'Tree SHA does not exist' });
      if (!body.parents.every((/** @type {string} */ s) => has(s, 'commit'))) return answer(422, { message: 'Parent SHA does not exist or is not a commit object' });
      const who = { GIT_AUTHOR_NAME: appLogin, GIT_AUTHOR_EMAIL: `1+${appLogin}@users.noreply.github.com`, GIT_AUTHOR_DATE: '1700000000 +0000' };
      const env = { ...who, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_DATE: '1700000000 +0000' };
      const sha = git(['commit-tree', body.tree, ...body.parents.flatMap((/** @type {string} */ s) => ['-p', s]), '-F', '-'], { input: body.message, env });
      byApi.add(sha);
      return answer(201, { sha });
    }
    if (method === 'GET' && (m = /^git\/ref\/heads\/(.+)$/.exec(p))) {
      const sha = refOf(m[1] ?? '');
      return sha ? answer(200, { ref: `refs/heads/${m[1]}`, object: { sha } }) : answer(404, { message: 'Not Found' });
    }
    if (method === 'POST' && p === 'git/refs') {
      if (refOf(body.ref.replace(/^refs\/heads\//, ''))) return answer(422, { message: 'Reference already exists' });
      git(['update-ref', body.ref, body.sha]);
      return answer(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && (m = /^git\/refs\/heads\/(.+)$/.exec(p))) {
      const at = refOf(m[1] ?? '');
      if (!at) return answer(422, { message: 'Reference does not exist' });
      if (!body.force) {
        try {
          git(['merge-base', '--is-ancestor', at, body.sha]);
        } catch {
          return answer(422, { message: 'Update is not a fast forward' });
        }
      }
      git(['update-ref', `refs/heads/${m[1]}`, body.sha]);
      return answer(200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    return answer(404, { message: `the double doesn't answer ${method} ${path}` });
  };
  return { request, calls, byApi };
}

/**
 * The double, served over HTTP from a process of its own, so a step a test runs with a blocking
 * spawn can reach it.
 *
 * @param {{remote: string, repo: string, appLogin: string, dir: string}} opts
 */
export async function serveFake({ remote, repo, appLogin, dir }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), remote, repo, appLogin, dir], { stdio: 'ignore' });
  const port = join(dir, 'port');
  for (let i = 0; !existsSync(port) || !readFileSync(port, 'utf8'); i++) {
    if (i > 200) throw new Error('the fake GitHub did not start');
    await delay(25);
  }
  const url = `http://127.0.0.1:${readFileSync(port, 'utf8')}`;
  const calls = () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** Run a command beside it; the server answers from its own process. */
  const run = async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20_000 });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  return { url, calls, run, stop: () => child.kill() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [remote = '', repo = '', appLogin = '', dir = ''] = process.argv.slice(2);
  const pulls = existsSync(join(dir, 'pulls.json')) ? JSON.parse(readFileSync(join(dir, 'pulls.json'), 'utf8')) : {};
  const { request } = fakeGitHub({ remote, repo, appLogin, pulls });
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', async () => {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '/').replace(/^\//, '');
      const body = text ? JSON.parse(text) : undefined;
      appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ method, path, ...(body === undefined ? {} : { body }), auth: req.headers.authorization ?? '' })}\n`);
      const r = await request(method, path, body);
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.json));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    writeFileSync(join(dir, 'port'), String(typeof address === 'object' && address ? address.port : ''));
  });
}
