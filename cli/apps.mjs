// `kanon apps`: creates an adopter's agent Apps from manifests (K-ADOPT-1 step 12, #39).
//
// For each role it builds a GitHub App manifest holding exactly the role's permissions
// (rulebook/agent-permissions.json, the roles table's machine-readable twin, K-ADOPT-8),
// opens the owner's "create App" page with the manifest filled in (a personal account's or an
// organisation's, detected from the owner's account type: plan 0005, decision 1), exchanges the
// one-time code for the App's id and private key, stores both as Actions secrets with the
// Owner's own `gh`, waits for the Owner to install the App, checks the installation covers
// the repository and nothing else, and writes the role's row in the App register
// (K-LAYOUT-6). The Owner clicks Create and Install; the command never creates an App or a
// key itself (K-AGENT-6).
//
// Before anything else it refuses to run outside a checkout of the repository it is for (the
// register would land wherever it ran), and says which token `gh` uses and whose it is
// (cli/gh-token.mjs), because a stale GH_TOKEN otherwise shows up only as a 401 (plan 0005 §5.1).
//
// The private key lives in one variable. It goes to `gh secret set` on stdin and is used to
// sign the App's JWTs in memory; it is never written to disk, printed or passed as an argument.
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { writeRegisterRow } from './app-register.mjs';
import { describeSource, isAuthFailure, tokenFix, tokenSource, whoami } from './gh-token.mjs';

export const REGISTER_PATH = 'docs/qa/agent-identities.md';
const API = 'https://api.github.com';
const PERMISSIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), '../rulebook/agent-permissions.json');

/** @typedef {{ role: string, permissions: Record<string, string> }} RoleSpec */

/** @returns {Record<string, RoleSpec>} */
export const loadRoles = () => JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf8')).roles;

export const USAGE = `Usage: kanon apps --owner <login> --repo <repo> --roles <role>[,<role>...] [options]

Creates one GitHub App per role from a manifest, with exactly the role's permissions
(K-ADOPT-8), stores its id and key as Actions secrets, and writes its App register row.
You click "Create" and "Install" in the browser; the command never creates an App itself.
Run it from a checkout of <login>/<repo>: it refuses anywhere else, before it changes anything.

Options:
  --owner <login>        the account that will own the Apps: a personal account or an
                         organisation (the command asks GitHub which)
  --repo <repo>          the repository, owned by that account, the Apps are for
  --roles <list>         comma-separated: ${Object.keys(loadRoles()).join(', ')}
  --name <role>=<name>   the App's name (default <repo>-<role>); repeatable
  --dir <path>           the checkout of <login>/<repo> (default: here)
  --register <path>      write the App register here instead of the checkout's
                         ${REGISTER_PATH}; no checkout is needed then
  --org <org>            deprecated: the old spelling of --owner, removed in a later release
  -h, --help             this text

Needs \`gh\`, with a token that can set the repository's Actions secrets (Secrets: read and
write). gh takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored login, so a
stale GH_TOKEN wins over \`gh auth login\`; the command prints which one it uses and whose it
is. It proves the token can write by setting and deleting a throwaway secret,
KANON_APPS_PREFLIGHT, before it opens any page.`;

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
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  state: () => randomBytes(16).toString('hex'),
  pollMs: 3000,
  timeoutMs: 15 * 60 * 1000,
};

/**
 * Parses `kanon apps`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv
 * @param {Record<string, RoleSpec>} roles
 */
export const parseArgs = (argv, roles) => {
  /** @type {{ owner: string, viaOrg: boolean, repo: string, roles: string[], names: Record<string, string>, dir: string, register: string, help: boolean }} */
  const opts = { owner: '', viaOrg: false, repo: '', roles: [], names: {}, dir: process.cwd(), register: '', help: false };
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
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--roles') opts.roles = [...new Set(value().split(',').map((r) => r.trim().toLowerCase()).filter(Boolean))];
    else if (flag === '--name') {
      const v = value();
      const eq = v.indexOf('=');
      if (eq < 1 || eq === v.length - 1) throw new Error(`--name takes <role>=<name>, not "${v}"`);
      opts.names[v.slice(0, eq).toLowerCase()] = v.slice(eq + 1);
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (opts.help) return opts;
  if (!opts.owner) throw new Error('--owner is required');
  if (!/^[A-Za-z0-9-]+$/.test(opts.owner)) throw new Error(`--owner takes a GitHub login, not "${opts.owner}"`);
  if (!opts.repo) throw new Error('--repo is required');
  if (opts.repo.includes('/')) throw new Error('--repo is the repository name alone; the owner goes in --owner');
  if (!opts.roles.length) throw new Error('--roles is required');
  for (const r of [...opts.roles, ...Object.keys(opts.names)]) {
    if (!roles[r]) throw new Error(`"${r}" is not an agent role; the roles are ${Object.keys(roles).join(', ')}`);
  }
  for (const r of Object.keys(opts.names)) {
    if (!opts.roles.includes(r)) throw new Error(`--name names the role "${r}", which --roles doesn't include`);
  }
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
 * @param {Deps} deps @param {string} dir @param {string} owner @param {string} repo
 * @returns {{ root: string, refusal: null } | { root: null, refusal: string[] }}
 */
export const checkoutCheck = (deps, dir, owner, repo) => {
  const want = `${owner}/${repo}`;
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
  if (repos.some((r) => r.toLowerCase() === want.toLowerCase())) return { root, refusal: null };
  const has = [...new Set(repos)].join(', ') || 'no GitHub remote';
  return { root: null, refusal: [`${root} is a checkout of ${has}, not of ${want}, which --owner and --repo name.`, fix] };
};

/**
 * The App manifest for one role: exactly the role's permissions, private, no webhook.
 * @param {{ owner: string, repo: string, role: string, name: string, redirectUrl: string, spec: RoleSpec }} a
 */
export const buildManifest = ({ owner, repo, name, redirectUrl, spec }) => {
  const home = `https://github.com/${owner}/${repo}`;
  return {
    name,
    url: home,
    description: `Kanon ${spec.role} for ${owner}/${repo}.`,
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

/** @param {string} role */
export const secretNames = (role) => ({ id: `${role.toUpperCase()}_APP_ID`, key: `${role.toUpperCase()}_APP_PRIVATE_KEY` });

/**
 * The steps that stay manual, printed at the end of every run.
 * @param {OwnerPages} pages @param {string} owner @param {string} repo @param {string[]} roles
 */
export const rotationSteps = (pages, owner, repo, roles) => [
  'Key rotation stays manual: GitHub has no API that makes a new private key for an existing App.',
  `To rotate a role's key: open ${pages.app('<slug>')}, choose`,
  '"Generate a private key", then store it and delete the downloaded file:',
  ...roles.map((r) => `  gh secret set ${secretNames(r).key} -R ${owner}/${repo} < <downloaded>.pem && rm <downloaded>.pem`),
  'Then delete the old key on the same page.',
];

/**
 * Waits until the App is installed on the owner's account, then checks what it covers.
 * @param {{ owner: string, pages: OwnerPages, repo: string, appId: number, pem: string, deps: Deps }} a
 * @returns {Promise<{ id: number, warnings: string[] }>}
 */
const awaitInstallation = async ({ owner, pages, repo, appId, pem, deps }) => {
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
        warnings.push(`The App is installed on ALL repositories of ${owner}, not only ${repo} (K-ADOPT-8). Choose "Only select repositories" at ${settings}.`);
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
      const names = (list.json?.repositories ?? []).map((/** @type {any} */ x) => String(x.full_name));
      const want = `${owner}/${repo}`.toLowerCase();
      if (!names.some((n) => n.toLowerCase() === want)) {
        throw new Error(`the App is installed on ${owner}, but not on ${repo} (it covers: ${names.join(', ') || 'nothing'}). Add ${repo} at ${settings}, then run the command again for this role.`);
      }
      const others = names.filter((n) => n.toLowerCase() !== want);
      if (others.length) warnings.push(`The App is also installed on ${others.join(', ')} (K-ADOPT-8: one App per role per repository). Remove them at ${settings}, or record the sharing in the App register.`);
      return { id: inst.id, warnings };
    }
    if (deps.now() >= deadline) throw new Error(`the App was not installed within ${Math.round(deps.timeoutMs / 60000)} minutes`);
    await deps.sleep(deps.pollMs);
  }
};

/**
 * One role, start to finish.
 * @param {{ owner: string, pages: OwnerPages, repo: string, role: string, name: string, spec: RoleSpec, register: string, deps: Deps }} a
 */
const createApp = async ({ owner, pages, repo, role, name, spec, register, deps }) => {
  const { out } = deps;
  out('');
  out(`== ${spec.role}: the App "${name}" ==`);
  const state = deps.state();
  const { url, code } = await listen({ newApp: pages.newApp, state, deps, manifestFor: (redirectUrl) => buildManifest({ owner, repo, role, name, redirectUrl, spec }) });
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
  const got = conv.json.permissions ?? {};
  const want = spec.permissions;
  const drift = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((k) => got[k] !== want[k]);
  if (drift.length) {
    deps.err(`warning: the App's permissions differ from the ${spec.role}'s on ${drift.join(', ')}. Set them to the role's at ${pages.app(slug)}/permissions before installing it.`);
  }

  const names = secretNames(role);
  for (const [secret, value] of /** @type {Array<[string, string]>} */ ([[names.id, String(appId)], [names.key, pem]])) {
    const r = await deps.gh(['secret', 'set', secret, '-R', `${owner}/${repo}`], value);
    if (r.status !== 0) {
      throw new Error(
        `gh could not set ${secret} (${r.stderr.trim() || `exit ${r.status}`}). The key was never saved anywhere, so it is lost: ` +
          `generate a new one at ${pages.app(slug)}, run ` +
          `"gh secret set ${names.key} -R ${owner}/${repo} < <file>.pem", delete the file, and set ${names.id} to ${appId}.`,
      );
    }
  }
  out(`3. Stored ${names.id} and ${names.key} as Actions secrets on ${owner}/${repo}.`);

  const install = `https://github.com/apps/${slug}/installations/new`;
  out(`4. Your browser is opening ${install}.`);
  out(`   Choose ${owner}, then "Only select repositories", pick ${repo} alone, and click "Install".`);
  deps.open(install);
  const inst = await awaitInstallation({ owner, pages, repo, appId, pem, deps });
  for (const w of inst.warnings) deps.err(`warning: ${w}`);
  out(`5. Installed (installation ${inst.id}).`);

  const { text, diff } = writeRegisterRow(deps.readFile(register), { role: spec.role, slug, permissions: spec.permissions });
  deps.writeFile(register, text);
  out(`6. Wrote the ${spec.role}'s row in ${register}. Commit it:`);
  for (const l of diff) out(`   ${l}`);
  return { slug, warnings: inst.warnings };
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
  const roles = loadRoles();
  /** @type {ReturnType<typeof parseArgs>} */
  let opts;
  try {
    opts = parseArgs(argv, roles);
  } catch (e) {
    deps.err(`kanon apps: ${/** @type {Error} */ (e).message}`);
    deps.err(USAGE);
    return 2;
  }
  if (opts.help) {
    deps.out(USAGE);
    return 0;
  }
  const { repo } = opts;
  if (opts.viaOrg) deps.err('kanon apps: warning: --org is deprecated; use --owner, which takes a personal account or an organisation. --org goes in a later release.');

  // Where the register goes, settled before anything else: run outside a checkout of the
  // repository, the command once created the Apps and their secrets and then wrote a fresh
  // register in the checkout's parent (plan 0005 §5.1). Only git is read here.
  /** @type {string} */
  let register;
  if (opts.register) register = resolve(opts.register);
  else {
    const where = checkoutCheck(deps, opts.dir, opts.owner, repo);
    if (where.refusal) {
      for (const l of where.refusal) deps.err(`kanon apps: ${l}`);
      return 1;
    }
    register = join(where.root, REGISTER_PATH);
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

  // Fail before any App exists if the key could not be stored: an App whose key has nowhere
  // to go is one more App to delete by hand. Reading the secrets proves nothing about
  // writing them (a token can hold Secrets: read alone), so the probe writes one.
  const refusal = await preflight(deps, owner, repo);
  if (refusal) {
    for (const l of refusal) deps.err(`kanon apps: ${l}`);
    return 1;
  }

  let warnings = 0;
  try {
    for (const role of opts.roles) {
      const spec = /** @type {RoleSpec} */ (roles[role]);
      const r = await createApp({ owner, pages, repo, role, spec, name: opts.names[role] ?? `${repo}-${role}`, register, deps });
      warnings += r.warnings.length;
    }
  } catch (e) {
    deps.err(`kanon apps: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  deps.out('');
  deps.out(warnings ? `Done, with ${warnings} warning(s) above to act on.` : 'Done.');
  for (const l of rotationSteps(pages, owner, repo, opts.roles)) deps.out(l);
  return 0;
};
