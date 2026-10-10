// `kanon apps`: creates an adopter's Kanon Apps from manifests (K-ADOPT-1 step 12, #39), or
// adds a repository to an App that already exists (`--reuse`).
//
// Since plan 0005's L4 an owner has two Apps, three with releases, reused across its
// repositories (ADR 0013, decision 2): the Author (Implementer, Lead, Explorer, Overseer), the
// Judge (Reviewer, Merger) and the optional Releaser. For each App it builds a manifest holding
// exactly the App's permissions (the `apps` block of rulebook/agent-permissions.json: the union
// of its roles' rows, plus any broadened permission, K-ADOPT-8), opens the owner's "create App"
// page with it filled in (a personal account's or an organisation's, detected from the owner's
// account type: plan 0005, decision 1), exchanges the one-time code for the App's id and
// private key, stores both as Actions secrets on EVERY repository named in --repo with the
// Owner's own `gh` (`AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY`, ...: §3.5), waits for the Owner
// to install the App, checks the installation covers each of those repositories, and writes
// one App register row per role of the App, its roles sharing its slug (K-LAYOUT-6, §3.4). The
// Owner clicks Create and Install; the command never creates an App or a key itself (K-AGENT-6).
//
// For the Releaser, which alone may bypass the default branch's ruleset (K-MERGE-8), it then
// adds the App to each repository's ruleset bypass list through the rulesets API, since a
// manifest can't (#49; `setReleaserBypass`), and prints any other bypass actor to remove.
//
// The key GitHub returns at creation is in memory once, so the repositories named at creation
// get it in the same run. A repository added later uses a key the Owner generates on the App's
// settings page: `--reuse <app>:<slug>@<id>=<key file>` reads it, checks it is a key of that slug
// and that the slug's App holds the named App's permissions (#366), stores it, and deletes the
// file (plan 0005 §3.2). The id is the App ID or the Client ID from the same page: GitHub answers
// 404 to a person's token for a private App, as Kanon's are, so the command can't look it up (#623).
//
// Before anything else it refuses to run outside a checkout of one of the repositories it is
// for (the register would land wherever it ran), and says which token `gh` uses and whose it
// is (cli/gh-token.mjs), because a stale GH_TOKEN otherwise shows up only as a 401 (§5.1).
//
// The private key lives in one variable. It goes to `gh secret set` on stdin and is used to
// sign the App's JWTs in memory; it is never written to disk, printed or passed as an argument.
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { writeRegisterRow } from './app-register.mjs';
import { describeSource, isAuthFailure, tokenFix, tokenSource, whoami } from './gh-token.mjs';
import { actorName, bypassCommand, readCovering, releaserActor, releaserBypass, rulesetUrl } from './ruleset-bypass.mjs';

export const REGISTER_PATH = 'docs/qa/agent-identities.md';
const API = 'https://api.github.com';
const PERMISSIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), '../rulebook/agent-permissions.json');

/** @typedef {{ role: string, permissions: Record<string, string> }} RoleSpec */
/** @typedef {{ app: string, roles: string[], permissions: Record<string, string>, optional?: boolean, broadened?: Record<string, string> }} AppSpec */

/** @returns {Record<string, RoleSpec>} */
export const loadRoles = () => JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf8')).roles;

/** @returns {Record<string, AppSpec>} Kanon's Apps, the `apps` block (ADR 0013). */
export const loadApps = () => JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf8')).apps;

/** The role names an App holds, as the register spells them. @param {AppSpec} spec */
export const appRoles = (spec) => {
  const roles = loadRoles();
  return spec.roles.map((k) => roles[k]?.role ?? k.charAt(0).toUpperCase() + k.slice(1));
};

export const USAGE = `Usage: kanon apps --owner <login> --repo <repo>[,<repo>...] --apps <app>[,<app>...] [options]
       kanon apps --owner <login> --repo <repo>[,<repo>...] --reuse <app>:<slug>@<id>=<key file> [options]
       kanon apps --owner <login> --repo <repo>[,<repo>...] --preflight

Creates Kanon's GitHub Apps for an owner, one manifest flow each, with exactly each App's
permissions (K-ADOPT-8), stores each App's id and key as Actions secrets on every repository
named, and writes one App register row per role of the App (plan 0005 §3.4). You click
"Create" and "Install" in the browser; the command never creates an App itself.
Run it from a checkout of one of <login>/<repo>: it refuses anywhere else, before it changes
anything, and writes that checkout's register. For the other repositories it prints the rows.
For the Releaser it also adds the App to the bypass list of each repository's default-branch
ruleset, for pull requests only (K-MERGE-8), when your token can edit the ruleset, and prints
the step otherwise. It removes no other bypass actor: it prints that step.

Options:
  --owner <login>        the account that owns the Apps: a personal account or an
                         organisation (the command asks GitHub which)
  --repo <list>          comma-separated: the repositories, owned by that account, the Apps
                         are for. Each gets the Apps' secrets in this run
  --apps <list>          comma-separated: ${Object.keys(loadApps()).join(', ')}. The Author and the
                         Judge run the lanes; the Releaser is optional, for releases alone
  --reuse <app>:<slug>@<id>=<file>
                         add these repositories to an App that exists: <id> is its App ID or
                         Client ID, and the key file one you generated, both from the App's
                         settings page. It is checked against the App, stored, and deleted.
                         Repeatable; takes the place of --apps
  --name <app>=<name>    the App's name (default <owner>-<app>); repeatable
  --dir <path>           the checkout (default: here)
  --preflight            run only the checks that come before any App: the checkout, the
                         token, the owner, and that the token can write each repository's
                         Actions secrets (the throwaway secret below). Creates no App, opens
                         no page and writes no file; exits 0 when the real run would start
  --register <path>      write the App register here instead of the checkout's
                         ${REGISTER_PATH}; no checkout is needed then
  --org <org>            deprecated: the old spelling of --owner, removed in a later release
  -h, --help             this text

--roles, the per-role Apps before plan 0005's L4, is gone: an owner has the Author and the
Judge, and the Releaser if it makes releases.

Needs \`gh\`, with a token that can set each repository's Actions secrets (Secrets: read and
write). gh takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored login, so a
stale GH_TOKEN wins over \`gh auth login\`; the command prints which one it uses and whose it
is. It proves the token can write by setting and deleting a throwaway secret,
KANON_APPS_PREFLIGHT, on each repository before it opens any page.`;

/**
 * @typedef {{
 *   github: (url: string, init?: RequestInit) => Promise<Response>,
 *   gh: (args: string[], input?: string) => Promise<{ status: number | null, stdout: string, stderr: string }>,
 *   git: (args: string[]) => { status: number | null, stdout: string, stderr: string },
 *   env: Record<string, string | undefined>,
 *   open: (url: string) => void,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   readFile: (path: string) => string | null,
 *   writeFile: (path: string, text: string) => void,
 *   remove: (path: string) => void,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   state: () => string,
 *   pollMs: number,
 *   timeoutMs: number,
 * }} Deps
 */

/** @type {Deps} */
export const realDeps = {
  github: (url, init) => fetch(url, init),
  gh: (args, input) =>
    new Promise((resolve) => {
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => resolve({ status: null, stdout, stderr: String(e.message) }));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input ?? '');
    }),
  git: (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
  },
  env: process.env,
  open: (url) => {
    const [cmd, args] =
      process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {
      // The URL is printed too, so a missing opener costs a copy and paste.
    }
  },
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  remove: (path) => rmSync(path, { force: true }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  state: () => randomBytes(16).toString('hex'),
  pollMs: 3000,
  timeoutMs: 15 * 60 * 1000,
};

/**
 * Parses `kanon apps`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv
 * @param {Record<string, AppSpec>} apps
 */
export const parseArgs = (argv, apps) => {
  /** @type {{ owner: string, viaOrg: boolean, repos: string[], apps: string[], reuse: Array<{ app: string, slug: string, id: string, file: string }>, names: Record<string, string>, dir: string, register: string, preflight: boolean, help: boolean }} */
  const opts = { owner: '', viaOrg: false, repos: [], apps: [], reuse: [], names: {}, dir: process.cwd(), register: '', preflight: false, help: false };
  const list = (/** @type {string} */ v) => [...new Set(v.split(',').map((r) => r.trim()).filter(Boolean))];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--owner' || flag === '--org') {
      const v = value();
      if (opts.owner && opts.owner.toLowerCase() !== v.toLowerCase()) throw new Error(`--owner and --org name different accounts, "${opts.owner}" and "${v}"`);
      opts.owner = v;
      if (flag === '--org') opts.viaOrg = true;
    } else if (flag === '--register') opts.register = value();
    else if (flag === '--repo') opts.repos = list(value());
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--preflight') opts.preflight = true;
    else if (flag === '--apps') opts.apps = list(value().toLowerCase());
    else if (flag === '--roles') {
      throw new Error('--roles is gone since plan 0005\'s L4: the lanes run as two Apps per owner, the Author and the Judge, and the Releaser for releases. Pass --apps author,judge (and ,releaser)');
    } else if (flag === '--reuse') {
      const v = value();
      // The id is optional here only so that its absence is refused with the App's page (#623).
      const m = /^([a-z]+):([a-z0-9]+(?:-[a-z0-9]+)*)(?:@([A-Za-z0-9.]+))?=(.+)$/.exec(v);
      if (!m) throw new Error(`--reuse takes <app>:<slug>@<App ID or Client ID>=<key file>, not "${v}"`);
      opts.reuse.push({ app: /** @type {string} */ (m[1]), slug: /** @type {string} */ (m[2]), id: m[3] ?? '', file: /** @type {string} */ (m[4]) });
    } else if (flag === '--name') {
      const v = value();
      const eq = v.indexOf('=');
      if (eq < 1 || eq === v.length - 1) throw new Error(`--name takes <app>=<name>, not "${v}"`);
      opts.names[v.slice(0, eq).toLowerCase()] = v.slice(eq + 1);
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (opts.help) return opts;
  if (!opts.owner) throw new Error('--owner is required');
  if (!/^[A-Za-z0-9-]+$/.test(opts.owner)) throw new Error(`--owner takes a GitHub login, not "${opts.owner}"`);
  if (!opts.repos.length) throw new Error('--repo is required');
  for (const r of opts.repos) if (r.includes('/')) throw new Error('--repo takes repository names alone; the owner goes in --owner');
  if (!opts.apps.length && !opts.reuse.length && !opts.preflight) throw new Error('--apps or --reuse is required');
  if (opts.apps.length && opts.reuse.length) throw new Error('--apps creates Apps and --reuse adds repositories to existing ones: run them separately');
  for (const a of [...opts.apps, ...opts.reuse.map((r) => r.app), ...Object.keys(opts.names)]) {
    if (!apps[a]) throw new Error(`"${a}" is not one of Kanon's Apps; they are ${Object.keys(apps).join(', ')}`);
  }
  for (const a of Object.keys(opts.names)) {
    if (!opts.apps.includes(a)) throw new Error(`--name names the App "${a}", which --apps doesn't include`);
  }
  const reused = opts.reuse.map((r) => r.app);
  if (new Set(reused).size !== reused.length) throw new Error('--reuse names one App twice');
  return opts;
};

/** @typedef {'User' | 'Organization'} OwnerKind */

/**
 * The GitHub pages for an owner's Apps. A personal account's live under
 * github.com/settings/, an organisation's under github.com/organizations/<org>/settings/.
 * @param {OwnerKind} kind @param {string} owner
 */
export const ownerPages = (kind, owner) => {
  const base = kind === 'Organization' ? `https://github.com/organizations/${encodeURIComponent(owner)}` : 'https://github.com';
  return {
    newApp: `${base}/settings/apps/new`,
    /** @param {string} slug */
    app: (slug) => `${base}/settings/apps/${slug}`,
    /** @param {number | string} id */
    installation: (id) => `${base}/settings/installations/${id}`,
  };
};

/** @typedef {ReturnType<typeof ownerPages>} OwnerPages */

/** An App's install page, which names no owner: the person chooses one on it. @param {string} slug */
const installPage = (slug) => `https://github.com/apps/${slug}/installations/new`;

/**
 * Asks GitHub whether the owner is a personal account or an organisation (`GET /users/<login>`
 * answers both, with `type`). Throws with a message naming the owner when it is neither.
 * @param {Deps['gh']} gh @param {string} owner
 * @returns {Promise<{ kind: OwnerKind, login: string }>}
 */
export const ownerKind = async (gh, owner) => {
  const r = await gh(['api', `users/${owner}`]);
  if (r.status !== 0) throw new Error(`GitHub could not say what "${owner}" is (${r.stderr.trim() || `exit ${r.status}`}). Check --owner.`);
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(`GitHub's answer for "${owner}" was not JSON`);
  }
  const kind = json?.type;
  if (kind !== 'User' && kind !== 'Organization') {
    throw new Error(`"${owner}" is a GitHub ${kind ?? 'account of no type'}, and Apps are owned by a personal account or an organisation`);
  }
  return { kind, login: String(json.login ?? owner) };
};

/**
 * The owner/repo a git remote URL points at, whatever its host spelling: an https URL, an
 * scp-like `git@host:owner/repo.git`, or an ssh host alias. Null when it has no such path.
 * @param {string} url
 */
export const remoteRepo = (url) => {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
};

/**
 * Refuses to run anywhere but a checkout of `<owner>/<repo>`: the register would otherwise
 * be written wherever the command ran (plan 0005 §5.1). Returns the checkout's top level,
 * where the register goes, or the lines that explain the refusal. Reads git only; it runs
 * before the token is used for anything.
 * @param {Deps} deps @param {string} dir @param {string} owner @param {string | string[]} repo
 * @returns {{ root: string, refusal: null, repo: string } | { root: null, refusal: string[] }}
 */
export const checkoutCheck = (deps, dir, owner, repo) => {
  const wanted = (Array.isArray(repo) ? repo : [repo]).map((r) => `${owner}/${r}`);
  const want = wanted.join(' or ');
  const where = resolve(dir);
  const fix = `cd into your checkout of ${want} and run the command again, or pass --dir <that checkout>, or --register <path> to write the register somewhere else on purpose. Nothing was changed.`;
  const top = deps.git(['-C', where, 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    return { root: null, refusal: [`${where} is not a git checkout, and --repo is ${want}: the App register would be written outside the repository.`, fix] };
  }
  const root = top.stdout.trim();
  const remotes = deps.git(['-C', root, 'remote', '-v']);
  const urls = [...new Set(remotes.stdout.split('\n').map((l) => l.split(/\s+/)[1] ?? '').filter(Boolean))];
  const repos = urls.map(remoteRepo).filter((r) => r !== null);
  const hit = repos.find((r) => wanted.some((w) => r.toLowerCase() === w.toLowerCase()));
  if (hit) return { root, refusal: null, repo: /** @type {string} */ (hit.split('/')[1]) };
  const has = [...new Set(repos)].join(', ') || 'no GitHub remote';
  return { root: null, refusal: [`${root} is a checkout of ${has}, not of ${want}, which --owner and --repo name.`, fix] };
};

/**
 * The App manifest for one of Kanon's Apps: exactly the App's permissions, private, no webhook.
 * @param {{ owner: string, repo: string, name: string, redirectUrl: string, spec: AppSpec | RoleSpec }} a
 */
export const buildManifest = ({ owner, repo, name, redirectUrl, spec }) => {
  const home = `https://github.com/${owner}/${repo}`;
  const what = 'app' in spec ? `${spec.app} (${appRoles(spec).join(', ')})` : spec.role;
  return {
    name,
    url: home,
    description: `Kanon's ${what} for ${owner}.`,
    public: false,
    // GitHub's manifest schema asks for a hook URL even when the hook is off. Nothing is
    // ever delivered to it, because `active` is false.
    hook_attributes: { url: home, active: false },
    redirect_url: redirectUrl,
    default_permissions: { ...spec.permissions },
    default_events: [],
  };
};

/** @param {string} s */
const html = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The local page that posts the manifest to GitHub. It submits itself; the button is there
 * for a browser that blocks the script.
 * @param {string} action @param {object} manifest
 */
export const manifestPage = (action, manifest) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>kanon apps</title></head>
<body>
<form id="f" method="post" action="${html(action)}">
<input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}">
<p>Sending the App manifest to GitHub. If nothing happens, <button type="submit">continue</button>.</p>
</form>
<script>document.getElementById('f').submit()</script>
</body></html>
`;

/**
 * Serves the manifest page on loopback and waits for GitHub's redirect back. Resolves with
 * the one-time code; rejects on a wrong `state`, which is refused and ends the run.
 * @param {{ newApp: string, state: string, manifestFor: (redirectUrl: string) => object, deps: Deps }} a
 * @returns {Promise<{ url: string, code: Promise<string> }>}
 */
const listen = ({ newApp, state, manifestFor, deps }) =>
  new Promise((ready, failed) => {
    /** @type {(code: string) => void} */
    let resolve = () => {};
    /** @type {(e: Error) => void} */
    let reject = () => {};
    const code = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let done = false;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/' && !done) {
        const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
        const action = `${newApp}?state=${state}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(manifestPage(action, manifestFor(`http://127.0.0.1:${port}/callback`)));
        return;
      }
      if (u.pathname === '/callback' && !done) {
        const got = u.searchParams.get('state');
        const c = u.searchParams.get('code');
        done = true;
        clearTimeout(timer);
        if (got !== state) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Refused: this redirect does not carry the state kanon apps sent. Nothing was stored.\n');
          server.close();
          reject(new Error('the redirect carried a state that does not match the one sent, so it was refused and nothing was stored. Run the command again.'));
          return;
        }
        if (!c) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No code: GitHub did not create the App.\n');
          server.close();
          reject(new Error('GitHub redirected back without a code, so no App was created.'));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('The App is created. Go back to the terminal.\n');
        server.close();
        resolve(c);
        return;
      }
      res.writeHead(404).end();
    });
    const timer = setTimeout(() => {
      done = true;
      server.close();
      reject(new Error(`no App was created within ${Math.round(deps.timeoutMs / 60000)} minutes`));
    }, deps.timeoutMs);
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      ready({ url: `http://127.0.0.1:${port}/`, code });
    });
  });

/** @param {object} o */
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * An App JWT (RS256), signed in memory with the App's private key.
 * @param {number | string} appId @param {string} pem @param {number} nowMs
 */
export const appJwt = (appId, pem, nowMs) => {
  const now = Math.floor(nowMs / 1000);
  const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), pem).toString('base64url')}`;
};

const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'kanon-apps' };

/**
 * @param {Deps} deps @param {string} path @param {{ method?: string, token?: string, jwt?: string, body?: object }} [o]
 */
const api = async (deps, path, o = {}) => {
  /** @type {Record<string, string>} */
  const headers = { ...HEADERS };
  if (o.jwt) headers.authorization = `Bearer ${o.jwt}`;
  if (o.token) headers.authorization = `token ${o.token}`;
  if (o.body) headers['content-type'] = 'application/json';
  const res = await deps.github(`${API}${path}`, { method: o.method ?? 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  /** @type {any} */
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

/** The fixed secret names of one of Kanon's Apps (plan 0005 §3.5). @param {string} app */
export const secretNames = (app) => ({ id: `${app.toUpperCase()}_APP_ID`, key: `${app.toUpperCase()}_APP_PRIVATE_KEY` });

/**
 * The steps that stay manual, printed at the end of every run.
 * @param {OwnerPages} pages @param {string} owner @param {string[]} repos @param {string[]} apps
 */
export const rotationSteps = (pages, owner, repos, apps) => [
  'Key rotation stays manual: GitHub has no API that makes a new private key for an existing App.',
  `To rotate an App's key: open ${pages.app('<slug>')}, choose`,
  '"Generate a private key", then store it on every repository the App covers and delete the downloaded file:',
  ...apps.flatMap((a) => repos.map((r) => `  gh secret set ${secretNames(a).key} -R ${owner}/${r} < <downloaded>.pem`)),
  '  rm <downloaded>.pem',
  'Then delete the old key on the same page. To add a repository later, generate a key the same way and run',
  `  kanon apps --owner ${owner} --repo <repo> --reuse <app>:<slug>@<App ID>=<downloaded>.pem`,
];

/**
 * Waits until the App is installed on the owner's account, then checks what it covers: every
 * repository named. One App per owner covers several (plan 0005 §3.2), so only an installation
 * on ALL of the owner's repositories warns (K-ADOPT-8, amended).
 * @param {{ owner: string, pages: OwnerPages, repos: string[], appId: number, slug: string, pem: string, deps: Deps, wait?: boolean }} a
 * @returns {Promise<{ id: number, warnings: string[] }>}
 */
const awaitInstallation = async ({ owner, pages, repos, appId, slug, pem, deps, wait = true }) => {
  const deadline = deps.now() + deps.timeoutMs;
  for (;;) {
    const r = await api(deps, '/app/installations?per_page=100', { jwt: appJwt(appId, pem, deps.now()) });
    if (r.status !== 200) throw new Error(`GitHub answered ${r.status} when listing the App's installations`);
    const inst = (r.json ?? []).find((/** @type {any} */ i) => String(i.account?.login).toLowerCase() === owner.toLowerCase());
    if (inst) {
      /** @type {string[]} */
      const warnings = [];
      const settings = pages.installation(inst.id);
      if (inst.repository_selection === 'all') {
        warnings.push(`The App is installed on ALL repositories of ${owner}, not only those that adopt Kanon (K-ADOPT-8). Choose "Only select repositories" at ${settings}.`);
        return { id: inst.id, warnings };
      }
      // The installation's repository list needs an installation token. This one can read
      // metadata only, is never printed, and is revoked as soon as the list is read.
      const t = await api(deps, `/app/installations/${inst.id}/access_tokens`, {
        method: 'POST',
        jwt: appJwt(appId, pem, deps.now()),
        body: { permissions: { metadata: 'read' } },
      });
      if (t.status !== 201 || !t.json?.token) throw new Error(`GitHub answered ${t.status} when asked for a token to read the installation's repositories`);
      const token = String(t.json.token);
      const list = await api(deps, '/installation/repositories?per_page=100', { token }).finally(() =>
        api(deps, '/installation/token', { method: 'DELETE', token }),
      );
      if (list.status !== 200) throw new Error(`GitHub answered ${list.status} when listing the installation's repositories`);
      /** @type {string[]} */
      const names = (list.json?.repositories ?? []).map((/** @type {any} */ x) => String(x.full_name).toLowerCase());
      const missing = repos.filter((r) => !names.includes(`${owner}/${r}`.toLowerCase()));
      if (missing.length) {
        throw new Error(`the App is installed on ${owner}, but not on ${missing.join(', ')} (it covers: ${names.join(', ') || 'nothing'}). Add ${missing.length > 1 ? 'them' : 'it'} at ${settings}, then run the command again.`);
      }
      return { id: inst.id, warnings };
    }
    if (!wait) throw new Error(`the App is not installed on ${owner}. Install it at ${installPage(slug)}, choosing ${repos.join(', ')}, then run the command again.`);
    if (deps.now() >= deadline) throw new Error(`the App was not installed within ${Math.round(deps.timeoutMs / 60000)} minutes`);
    await deps.sleep(deps.pollMs);
  }
};

/**
 * Stores an App's id and key on every repository. Throws, naming what to do, on the first
 * failure: a key that is in memory only is lost if it can't be stored.
 * @param {{ owner: string, repos: string[], app: string, appId: number, slug: string, pem: string, pages: OwnerPages, deps: Deps, keyFile?: string }} a
 */
const storeSecrets = async ({ owner, repos, app, appId, slug, pem, pages, deps, keyFile }) => {
  const names = secretNames(app);
  for (const repo of repos) {
    for (const [secret, value] of /** @type {Array<[string, string]>} */ ([[names.id, String(appId)], [names.key, pem]])) {
      const r = await deps.gh(['secret', 'set', secret, '-R', `${owner}/${repo}`], value);
      if (r.status !== 0) {
        throw new Error(
          `gh could not set ${secret} on ${owner}/${repo} (${r.stderr.trim() || `exit ${r.status}`}). ` +
            (keyFile
              ? `The key file ${keyFile} is kept: fix the token and run the command again.`
              : `The key was never saved anywhere, so it is lost: generate a new one at ${pages.app(slug)}, and run ` +
                `"kanon apps --owner ${owner} --repo ${repos.join(',')} --reuse ${app}:${slug}@${appId}=<file>.pem".`),
        );
      }
    }
  }
  return names;
};

/**
 * Writes one register row per role of the App, all naming its slug (plan 0005 §3.4), and
 * prints the diff to commit. The rows carry the App's permissions: what each role's token can
 * at most be minted with.
 * @param {{ spec: AppSpec, slug: string, register: string, deps: Deps }} a
 */
const writeAppRows = ({ spec, slug, register, deps }) => {
  let text = deps.readFile(register);
  /** @type {string[]} */
  const diff = [];
  for (const role of appRoles(spec)) {
    const w = writeRegisterRow(text, { role, slug, permissions: spec.permissions });
    text = w.text;
    diff.push(...w.diff);
  }
  deps.writeFile(register, /** @type {string} */ (text));
  return diff;
};

/**
 * The permissions on which an App's, as GitHub reports them, differ from what it should hold.
 * @param {Record<string, string>} got @param {Record<string, string>} want
 */
export const permissionDrift = (got, want) => [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((k) => got[k] !== want[k]);

/**
 * The owner's App installations, as GitHub lists them: an organisation's to an owner of it, with
 * its Administration permission (read); a personal account's only to a GitHub App's user token,
 * never to gh's own (#417). `installs` is null when they can't be listed, and `listed` says why.
 * `kanon doctor` (`app.unused`, the Releaser's id) and `kanon init` (an App the owner already
 * has, #363) read them through this.
 * @param {(args: string[]) => Promise<{ status: number | null, stdout: string, stderr: string }>} gh
 * @param {string} owner @param {string} kind `Organization` or `User`
 * @returns {Promise<{ listed: { status: number | null, stdout: string, stderr: string }, installs: any[] | null }>}
 */
export const ownerInstallations = async (gh, owner, kind) => {
  const listed = await gh(['api', kind === 'Organization' ? `orgs/${owner}/installations?per_page=100` : 'user/installations?per_page=100']);
  /** @type {any} */
  let j;
  try {
    j = listed.status === 0 ? JSON.parse(listed.stdout) : null;
  } catch {
    j = null;
  }
  return { listed, installs: Array.isArray(j?.installations) ? j.installations : null };
};

/**
 * Which of Kanon's Apps the owner already has: each of its installations whose permissions are
 * exactly one App's in rulebook/agent-permissions.json (#363), as apps-check holds them, and that
 * subscribes to no events, as `buildManifest` creates each of Kanon's Apps (#462). In the order of
 * the Apps, then of the installations. `ownersOwn` then drops an App of someone else's.
 * @param {any[]} installs @param {string} owner @param {Record<string, { permissions: Record<string, string> }>} specs
 * @returns {Array<{ app: string, slug: string, installation: number }>}
 */
export const ownerKanonApps = (installs, owner, specs) =>
  Object.entries(specs).flatMap(([app, spec]) =>
    installs
      .filter((i) => String(i?.account?.login ?? '').toLowerCase() === owner.toLowerCase() && typeof i?.app_slug === 'string' && i?.permissions && typeof i.permissions === 'object' && !permissionDrift(i.permissions, spec.permissions).length)
      .filter((i) => Array.isArray(i.events) && !i.events.length)
      .map((i) => ({ app, slug: String(i.app_slug), installation: Number(i.id) })),
  );

/**
 * The owner's own Apps among `found`, each read with `GET /apps/<slug>` (#462). Kanon creates its
 * Apps private (`buildManifest`), and GitHub installs a private App only on the account that owns
 * it, so a slug it answers 404 for, as it does a private App to a person's token, is the owner's.
 * One it answers names its owner: a public App of another account's, such as a bot installed on
 * an organisation, is never one of Kanon's. Any other answer can't tell, so the App is dropped.
 * The Releaser's three permissions are ones an ordinary bot can hold, so it needs this most.
 * @template {{ slug: string }} T
 * @param {(args: string[]) => Promise<{ status: number | null, stdout: string, stderr: string }>} gh
 * @param {string} owner @param {T[]} found
 * @returns {Promise<T[]>}
 */
export const ownersOwn = async (gh, owner, found) => {
  /** @type {Map<string, boolean>} */
  const own = new Map();
  for (const slug of new Set(found.map((f) => f.slug))) {
    const r = await gh(['api', `apps/${slug}`]);
    /** @type {any} */
    let app;
    try {
      app = r.status === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      app = null;
    }
    own.set(slug, r.status === 0 ? String(app?.owner?.login ?? '').toLowerCase() === owner.toLowerCase() : /\(HTTP 404\)/.test(r.stderr));
  }
  return found.filter((f) => own.get(f.slug));
};

/**
 * One App, start to finish.
 * @param {{ owner: string, pages: OwnerPages, repos: string[], key: string, name: string, spec: AppSpec, register: string, deps: Deps }} a
 */
const createApp = async ({ owner, pages, repos, key, name, spec, register, deps }) => {
  const { out } = deps;
  out('');
  out(`== The ${spec.app} (${appRoles(spec).join(', ')}): the App "${name}" ==`);
  const state = deps.state();
  const home = /** @type {string} */ (repos[0]);
  const { url, code } = await listen({ newApp: pages.newApp, state, deps, manifestFor: (redirectUrl) => buildManifest({ owner, repo: home, name, redirectUrl, spec }) });
  out(`1. Your browser is opening ${url}, which sends the manifest to GitHub.`);
  out(`   Check the name, then click "Create GitHub App for ${owner}". (If the name is taken, change it there.)`);
  deps.open(url);
  const oneTime = await code;

  const conv = await api(deps, `/app-manifests/${encodeURIComponent(oneTime)}/conversions`, { method: 'POST' });
  if (conv.status !== 201 || !conv.json?.pem || !conv.json?.id || !conv.json?.slug) {
    throw new Error(`GitHub answered ${conv.status} when exchanging the code${conv.json?.message ? `: ${conv.json.message}` : ''}`);
  }
  const appId = Number(conv.json.id);
  const slug = String(conv.json.slug);
  /** The private key. It goes to `gh` on stdin and to `sign`, and nowhere else. */
  const pem = String(conv.json.pem);
  out(`2. Created the App ${slug} (id ${appId}).`);
  const holder = String(conv.json.owner?.login ?? '');
  if (holder.toLowerCase() !== owner.toLowerCase()) deps.err(`warning: GitHub says the App belongs to "${holder}", not ${owner}.`);
  const drift = permissionDrift(conv.json.permissions ?? {}, spec.permissions);
  if (drift.length) {
    deps.err(`warning: the App's permissions differ from the ${spec.app}'s on ${drift.join(', ')}. Set them to the ${spec.app}'s at ${pages.app(slug)}/permissions before installing it.`);
  }

  const names = await storeSecrets({ owner, repos, app: key, appId, slug, pem, pages, deps });
  out(`3. Stored ${names.id} and ${names.key} as Actions secrets on ${repos.map((r) => `${owner}/${r}`).join(', ')}.`);

  const install = installPage(slug);
  out(`4. Your browser is opening ${install}.`);
  out(`   Choose ${owner}, then "Only select repositories", pick ${repos.join(', ')}, and click "Install".`);
  deps.open(install);
  const inst = await awaitInstallation({ owner, pages, repos, appId, slug, pem, deps });
  for (const w of inst.warnings) deps.err(`warning: ${w}`);
  out(`5. Installed (installation ${inst.id}).`);

  const diff = writeAppRows({ spec, slug, register, deps });
  out(`6. Wrote the ${spec.app}'s rows (${appRoles(spec).join(', ')}) in ${register}. Commit them:`);
  for (const l of diff) out(`   ${l}`);
  return { slug, appId, warnings: inst.warnings };
};

/** Where an App's App ID and Client ID are, for an error that asks for one. @param {OwnerPages} pages @param {string} slug */
const idsAt = (pages, slug) => `under "About" on ${pages.app(slug)}`;

/**
 * Adds the repositories to an App that exists, from a key file the Owner generated on the
 * App's settings page (plan 0005 §3.2): checks the key is that App's and the installation
 * covers each repository, stores it, writes the rows, and deletes the file. `id` is the App ID
 * or Client ID the person copied from the same page, since GitHub tells a person's token nothing
 * about a private App (#623); GitHub takes either as the JWT's issuer.
 * @param {{ owner: string, pages: OwnerPages, repos: string[], key: string, slug: string, id: string, file: string, spec: AppSpec, specs: Record<string, AppSpec>, register: string, deps: Deps }} a
 */
const reuseApp = async ({ owner, pages, repos, key, slug, id, file, spec, specs, register, deps }) => {
  const { out } = deps;
  out('');
  out(`== The ${spec.app} (${appRoles(spec).join(', ')}): the App ${slug}, from ${file} ==`);
  const pem = deps.readFile(file);
  if (pem === null || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) throw new Error(`${file} is not a private key file`);
  // The key is this App's only if GitHub accepts a JWT it signed as this App, and answers its slug.
  const me = await api(deps, '/app', { jwt: appJwt(id, pem, deps.now()) });
  if (me.status !== 200) {
    throw new Error(
      `GitHub refused the key in ${file} as the App ${id}'s (HTTP ${me.status}): either ${id} is not ${slug}'s App ID or Client ID, or the key is not one of its keys. ` +
        `Both IDs are ${idsAt(pages, slug)}, and its keys under "Private keys". Nothing was stored; the file is kept.`,
    );
  }
  if (String(me.json?.slug) !== slug) {
    throw new Error(`the ID ${id} and the key in ${file} are the App ${me.json?.slug}'s, not ${slug}'s. Nothing was stored; the file is kept.`);
  }
  const appId = Number(me.json?.id);
  if (!Number.isInteger(appId) || appId <= 0) throw new Error(`GitHub's answer for ${slug} named no App ID. Nothing was stored; the file is kept.`);
  // The App is the one named only if it holds that App's permissions (#366): a slug of the
  // Author given as the Judge's would otherwise store the Author's key under JUDGE_ secrets and
  // write the Reviewer's and Merger's rows naming it. apps-check fails on any difference, so an
  // App that differs is refused here too, before anything is stored, with the file kept.
  /** @type {Record<string, string>} */
  const got = me.json?.permissions ?? {};
  const drift = permissionDrift(got, spec.permissions);
  if (drift.length) {
    const other = Object.entries(specs).find(([, o]) => !permissionDrift(got, o.permissions).length);
    throw new Error(
      `${slug} does not hold the ${spec.app}'s permissions (${drift.map((k) => `${k}: ${got[k] ?? 'none'}, the ${spec.app}'s ${spec.permissions[k] ?? 'none'}`).join('; ')}). ` +
        (other
          ? `They are the ${other[1].app}'s: if ${slug} is your ${other[1].app}, give it as --reuse ${other[0]}:${slug}@${id}=<key file>. `
          : `If ${slug} is your ${spec.app}, set its permissions to the ${spec.app}'s at ${pages.app(slug)}/permissions, then run the command again. `) +
        'Nothing was stored; the file is kept.',
    );
  }
  out(`1. ${file} is a key of ${slug} (id ${appId}), which holds the ${spec.app}'s permissions.`);
  const inst = await awaitInstallation({ owner, pages, repos, appId, slug, pem, deps, wait: false });
  for (const w of inst.warnings) deps.err(`warning: ${w}`);
  out(`2. Its installation (${inst.id}) covers ${repos.join(', ')}.`);
  const names = await storeSecrets({ owner, repos, app: key, appId, slug, pem, pages, deps, keyFile: file });
  out(`3. Stored ${names.id} and ${names.key} as Actions secrets on ${repos.map((r) => `${owner}/${r}`).join(', ')}.`);
  deps.remove(file);
  out(`4. Deleted ${file}.`);
  const diff = writeAppRows({ spec, slug, register, deps });
  out(`5. Wrote the ${spec.app}'s rows in ${register}. Commit them:`);
  for (const l of diff) out(`   ${l}`);
  return { slug, appId, warnings: inst.warnings };
};

/**
 * THE RELEASER'S BYPASS (`K-MERGE-8`, plan 0005 §3.1, #49). A manifest can't make an App a
 * ruleset's bypass actor, so once the Releaser exists this adds it to every active ruleset on
 * each repository's default branch, through a pull request only, when the Owner's token can
 * edit the ruleset; otherwise it prints the step. It only ADDS: removing another actor's bypass
 * (an admin role's, typically) is the Owner's step, printed with its command, because release
 * PRs merge through it until the `dco` check the repository pins exempts the Releaser (#337).
 * Returns the number of steps left to the Owner.
 * @param {{ owner: string, repos: string[], slug: string, appId: number, deps: Deps }} a
 */
export const setReleaserBypass = async ({ owner, repos, slug, appId, deps }) => {
  const { out } = deps;
  let left = 0;
  out('');
  out(`== The Releaser's ruleset bypass (K-MERGE-8): the App ${slug}, through pull requests only ==`);
  for (const repo of repos.map((r) => `${owner}/${r}`)) {
    const read = await readCovering(deps.gh, repo);
    if ('unreadable' in read) {
      left += 1;
      out(`${repo}: ${read.unreadable}. In its Settings, Rules, Rulesets, add the App ${slug} to the default branch's ruleset's bypass list, "For pull requests only".`);
      continue;
    }
    if (!read.covering.length) {
      left += 1;
      out(`${repo}: no active ruleset covers ${read.defaultBranch} yet. When you create it (K-ADOPT-1 step 8; kanon init does), add the App ${slug} to its bypass list, "For pull requests only", and no other actor.`);
      continue;
    }
    const where = releaserBypass(read.covering, appId);
    for (const s of where.hidden) {
      left += 1;
      out(`${repo}: the token can't see the bypass list of the ruleset "${s.name}" (only someone who can edit it can). Add the App ${slug} there, "For pull requests only": ${rulesetUrl(repo, s)}`);
    }
    for (const s of where.lacking) {
      const actors = [...s.bypass_actors, releaserActor(appId)];
      const r = s.source_type === 'Organization' ? null : await deps.gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${s.id}`, '--input', '-'], JSON.stringify({ bypass_actors: actors }));
      if (r?.status === 0) out(`${repo}: added the App ${slug} to the bypass list of the ruleset "${s.name}", for pull requests only.`);
      else {
        left += 1;
        out(`${repo}: could not add the App ${slug} to the bypass list of the ruleset "${s.name}"${r ? ` (${r.stderr.trim() || `exit ${r.status}`})` : ', an organisation ruleset'}. Add it, "For pull requests only", at ${rulesetUrl(repo, s)}${r ? ', or with a token that can administer the repository:' : '.'}`);
        if (r) for (const l of bypassCommand(repo, s, actors)) out(`   ${l}`);
      }
    }
    const others = where.others;
    if (others.length) {
      left += 1;
      out(`${repo}: ${others.map(({ ruleset, actor }) => `${actorName(actor)} on "${ruleset.name}"`).join(', ')} can bypass the ruleset too. K-MERGE-8 makes the Releaser the only bypass actor. Once your dco caller pins this release or later, so the Releaser's release PR passes it (#337), remove ${others.length > 1 ? 'them' : 'it'}, and merge release PRs through the front door:`);
      for (const s of [...new Set(others.map((o) => o.ruleset))]) {
        if (s.source_type === 'Organization') out(`   the organisation ruleset "${s.name}": ${rulesetUrl(repo, s)}`);
        else for (const l of bypassCommand(repo, s, [releaserActor(appId)])) out(`   ${l}`);
      }
    }
  }
  return left;
};

/** The throwaway secret the pre-check sets and deletes. */
export const PREFLIGHT_SECRET = 'KANON_APPS_PREFLIGHT';

/**
 * Proves `gh` can write the repository's Actions secrets: sets a throwaway secret, then
 * deletes it. The delete runs even when the set failed or threw, so nothing stays behind.
 * Returns null when both worked, or the lines that explain the refusal.
 * When GitHub refused the token (401 or 403), the refusal also says which token gh used and
 * how to fix a stale one.
 * @param {Deps} deps @param {string} owner @param {string} repo
 * @returns {Promise<string[] | null>}
 */
export const preflight = async (deps, owner, repo) => {
  const where = `${owner}/${repo}`;
  /** @param {{ status: number | null, stderr: string }} r */
  const cause = (r) => r.stderr.trim() || `exit ${r.status}`;
  const source = tokenSource(deps.env);
  /** @param {{ stderr: string }} r */
  const fix = (r) => [
    `The token gh uses, ${describeSource(source)}, needs Secrets: read and write on the repository. No App was created.`,
    ...(isAuthFailure(r.stderr) ? tokenFix(source) : []),
  ];
  /** @type {{ status: number | null, stdout: string, stderr: string }} */
  let set;
  try {
    set = await deps.gh(['secret', 'set', PREFLIGHT_SECRET, '-R', where], 'kanon apps pre-check; safe to delete');
  } catch (e) {
    set = { status: null, stdout: '', stderr: String(/** @type {Error} */ (e).message) };
  }
  const del = await deps.gh(['secret', 'delete', PREFLIGHT_SECRET, '-R', where]);
  if (set.status !== 0) return [`gh cannot set an Actions secret on ${where} (${cause(set)}).`, ...fix(set)];
  if (del.status !== 0) {
    return [
      `gh set the throwaway secret ${PREFLIGHT_SECRET} on ${where} but cannot delete it (${cause(del)}). Delete it by hand: gh secret delete ${PREFLIGHT_SECRET} -R ${where}`,
      ...fix(del),
    ];
  }
  return null;
};

/**
 * `kanon apps`. Returns the exit code.
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const apps = async (argv, overrides = {}) => {
  const deps = { ...realDeps, ...overrides };
  const specs = loadApps();
  /** @type {ReturnType<typeof parseArgs>} */
  let opts;
  try {
    opts = parseArgs(argv, specs);
  } catch (e) {
    deps.err(`kanon apps: ${/** @type {Error} */ (e).message}`);
    deps.err(USAGE);
    return 2;
  }
  if (opts.help) {
    deps.out(USAGE);
    return 0;
  }
  const { repos } = opts;
  if (opts.viaOrg) deps.err('kanon apps: warning: --org is deprecated; use --owner, which takes a personal account or an organisation. --org goes in a later release.');

  // Where the register goes, settled before anything else: run outside a checkout of the
  // repository, the command once created the Apps and their secrets and then wrote a fresh
  // register in the checkout's parent (plan 0005 §5.1). Only git is read here.
  /** @type {string} */
  let register;
  /** @type {string | null} the repository whose checkout gets the register */
  let here = null;
  if (opts.register) register = resolve(opts.register);
  else {
    const where = checkoutCheck(deps, opts.dir, opts.owner, repos);
    if (where.refusal) {
      for (const l of where.refusal) deps.err(`kanon apps: ${l}`);
      return 1;
    }
    register = join(where.root, REGISTER_PATH);
    here = where.repo;
  }

  // Which token gh uses, and whose it is, before it is used for anything that changes state.
  const who = await whoami(deps.gh, deps.env);
  deps.out(who.line);
  if (who.refusal) {
    for (const l of who.refusal) deps.err(`kanon apps: ${l}`);
    return 1;
  }

  /** @type {{ kind: OwnerKind, login: string }} */
  let account;
  try {
    account = await ownerKind(deps.gh, opts.owner);
  } catch (e) {
    deps.err(`kanon apps: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  const owner = account.login;
  const pages = ownerPages(account.kind, owner);
  deps.out(`${owner} is ${account.kind === 'User' ? 'a personal account' : 'an organisation'}; its Apps are created at ${pages.newApp}.`);
  deps.out(`The App register is ${register}.`);

  // A reused App's ID, asked for before anything changes, with the page it is on (#623).
  const unnamed = opts.reuse.filter((r) => !r.id);
  if (unnamed.length) {
    for (const { app, slug } of unnamed) {
      deps.err(`kanon apps: --reuse ${app}:${slug} needs the App's ID: give it as --reuse ${app}:${slug}@<App ID>=<key file>. The App ID, or the Client ID, is ${idsAt(pages, slug)}. Nothing was changed.`);
    }
    return 2;
  }

  // Fail before any App exists if a key could not be stored: an App whose key has nowhere to
  // go is one more App to delete by hand. Reading the secrets proves nothing about writing
  // them (a token can hold Secrets: read alone), so the probe writes one, on each repository.
  for (const repo of repos) {
    const refusal = await preflight(deps, owner, repo);
    if (refusal) {
      for (const l of refusal) deps.err(`kanon apps: ${l}`);
      return 1;
    }
  }
  // `--preflight` (#420, L5's G10): the agent can confirm the token before it hands the person
  // the command that creates the Apps, so the person doesn't run it twice.
  if (opts.preflight) {
    deps.out(`The token can write the Actions secrets of ${repos.map((r) => `${owner}/${r}`).join(', ')}, so kanon apps can run from here. Nothing was created.`);
    return 0;
  }

  let warnings = 0;
  /** @type {Array<{ spec: AppSpec, slug: string, appId: number }>} */
  const done = [];
  try {
    for (const key of opts.apps) {
      const spec = /** @type {AppSpec} */ (specs[key]);
      const r = await createApp({ owner, pages, repos, key, spec, name: opts.names[key] ?? `${owner}-${key}`.toLowerCase(), register, deps });
      warnings += r.warnings.length;
      done.push({ spec, slug: r.slug, appId: r.appId });
    }
    for (const { app: key, slug, id, file } of opts.reuse) {
      const spec = /** @type {AppSpec} */ (specs[key]);
      const r = await reuseApp({ owner, pages, repos, key, slug, id, file: resolve(file), spec, specs, register, deps });
      warnings += r.warnings.length;
      done.push({ spec, slug: r.slug, appId: r.appId });
    }
  } catch (e) {
    deps.err(`kanon apps: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  // THE OTHER REPOSITORIES' REGISTERS. This run wrote one checkout's; each repository the
  // Apps cover keeps its own register (K-LAYOUT-6), so it prints the rows to copy into each.
  const others = repos.filter((r) => r !== here);
  if (others.length && done.length) {
    deps.out('');
    deps.out(`The App register of ${others.map((r) => `${owner}/${r}`).join(', ')} needs these rows too (one per role, ${here ? `as in ${owner}/${here}'s` : 'as written above'}):`);
    for (const { spec, slug } of done) for (const role of appRoles(spec)) deps.out(`  | ${role} | \`${slug}\` | …`);
  }
  for (const { spec, slug, appId } of done.filter(({ spec }) => spec.app === 'Releaser')) {
    warnings += await setReleaserBypass({ owner, repos, slug, appId, deps });
    deps.out('');
    deps.out(`The ${spec.app}: map RELEASER_APP_ID and RELEASER_APP_PRIVATE_KEY in the job that calls the release workflow (docs/release.md, "With the Releaser"), and commit its register row: the dco check exempts its release commits by that row on your default branch (#337).`);
  }
  deps.out('');
  deps.out(warnings ? `Done, with ${warnings} warning(s) above to act on.` : 'Done.');
  for (const l of rotationSteps(pages, owner, repos, [...opts.apps, ...opts.reuse.map((r) => r.app)])) deps.out(l);
  return 0;
};
