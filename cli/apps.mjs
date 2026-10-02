// `kanon apps`: creates an adopter's agent Apps from manifests (K-ADOPT-1 step 12, #39).
//
// For each role it builds a GitHub App manifest holding exactly the role's permissions
// (rulebook/agent-permissions.json, the roles table's machine-readable twin, K-ADOPT-8),
// opens the organisation's "create App" page with the manifest filled in, exchanges the
// one-time code for the App's id and private key, stores both as Actions secrets with the
// Owner's own `gh`, waits for the Owner to install the App, checks the installation covers
// the repository and nothing else, and writes the role's row in the App register
// (K-LAYOUT-6). The Owner clicks Create and Install; the command never creates an App or a
// key itself (K-AGENT-6).
//
// The private key lives in one variable. It goes to `gh secret set` on stdin and is used to
// sign the App's JWTs in memory; it is never written to disk, printed or passed as an argument.
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { writeRegisterRow } from './app-register.mjs';

export const REGISTER_PATH = 'docs/qa/agent-identities.md';
const API = 'https://api.github.com';
const PERMISSIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), '../rulebook/agent-permissions.json');

/** @typedef {{ role: string, permissions: Record<string, string> }} RoleSpec */

/** @returns {Record<string, RoleSpec>} */
export const loadRoles = () => JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf8')).roles;

export const USAGE = `Usage: kanon apps --org <org> --repo <repo> --roles <role>[,<role>...] [options]

Creates one GitHub App per role from a manifest, with exactly the role's permissions
(K-ADOPT-8), stores its id and key as Actions secrets, and writes its App register row.
You click "Create" and "Install" in the browser; the command never creates an App itself.

Options:
  --org <org>            the GitHub organisation that will own the Apps
  --repo <repo>          the repository, in that organisation, the Apps are for
  --roles <list>         comma-separated: ${Object.keys(loadRoles()).join(', ')}
  --name <role>=<name>   the App's name (default <repo>-<role>); repeatable
  --dir <path>           the repository's checkout, for the register (default: here)
  -h, --help             this text

Needs \`gh\`, signed in as someone who can set the repository's Actions secrets.`;

/**
 * @typedef {{
 *   github: (url: string, init?: RequestInit) => Promise<Response>,
 *   gh: (args: string[], input?: string) => Promise<{ status: number | null, stdout: string, stderr: string }>,
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
  /** @type {{ org: string, repo: string, roles: string[], names: Record<string, string>, dir: string, help: boolean }} */
  const opts = { org: '', repo: '', roles: [], names: {}, dir: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--org') opts.org = value();
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
  if (!opts.org) throw new Error('--org is required');
  if (!opts.repo) throw new Error('--repo is required');
  if (opts.repo.includes('/')) throw new Error('--repo is the repository name alone; the organisation goes in --org');
  if (!opts.roles.length) throw new Error('--roles is required');
  for (const r of [...opts.roles, ...Object.keys(opts.names)]) {
    if (!roles[r]) throw new Error(`"${r}" is not an agent role; the roles are ${Object.keys(roles).join(', ')}`);
  }
  for (const r of Object.keys(opts.names)) {
    if (!opts.roles.includes(r)) throw new Error(`--name names the role "${r}", which --roles doesn't include`);
  }
  return opts;
};

/**
 * The App manifest for one role: exactly the role's permissions, private, no webhook.
 * @param {{ org: string, repo: string, role: string, name: string, redirectUrl: string, spec: RoleSpec }} a
 */
export const buildManifest = ({ org, repo, name, redirectUrl, spec }) => {
  const home = `https://github.com/${org}/${repo}`;
  return {
    name,
    url: home,
    description: `Kanon ${spec.role} for ${org}/${repo}.`,
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
 * @param {{ org: string, state: string, manifestFor: (redirectUrl: string) => object, deps: Deps }} a
 * @returns {Promise<{ url: string, code: Promise<string> }>}
 */
const listen = ({ org, state, manifestFor, deps }) =>
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
        const action = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`;
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
 * @param {string} org @param {string} repo @param {string[]} roles
 */
export const rotationSteps = (org, repo, roles) => [
  'Key rotation stays manual: GitHub has no API that makes a new private key for an existing App.',
  `To rotate a role's key: open https://github.com/organizations/${org}/settings/apps/<slug>, choose`,
  '"Generate a private key", then store it and delete the downloaded file:',
  ...roles.map((r) => `  gh secret set ${secretNames(r).key} -R ${org}/${repo} < <downloaded>.pem && rm <downloaded>.pem`),
  'Then delete the old key on the same page.',
];

/**
 * Waits until the App is installed in the organisation, then checks what it covers.
 * @param {{ org: string, repo: string, appId: number, pem: string, deps: Deps }} a
 * @returns {Promise<{ id: number, warnings: string[] }>}
 */
const awaitInstallation = async ({ org, repo, appId, pem, deps }) => {
  const deadline = deps.now() + deps.timeoutMs;
  for (;;) {
    const r = await api(deps, '/app/installations?per_page=100', { jwt: appJwt(appId, pem, deps.now()) });
    if (r.status !== 200) throw new Error(`GitHub answered ${r.status} when listing the App's installations`);
    const inst = (r.json ?? []).find((/** @type {any} */ i) => String(i.account?.login).toLowerCase() === org.toLowerCase());
    if (inst) {
      /** @type {string[]} */
      const warnings = [];
      const settings = `https://github.com/organizations/${org}/settings/installations/${inst.id}`;
      if (inst.repository_selection === 'all') {
        warnings.push(`The App is installed on ALL repositories in ${org}, not only ${repo} (K-ADOPT-8). Choose "Only select repositories" at ${settings}.`);
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
      const want = `${org}/${repo}`.toLowerCase();
      if (!names.some((n) => n.toLowerCase() === want)) {
        throw new Error(`the App is installed in ${org}, but not on ${repo} (it covers: ${names.join(', ') || 'nothing'}). Add ${repo} at ${settings}, then run the command again for this role.`);
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
 * @param {{ org: string, repo: string, role: string, name: string, spec: RoleSpec, dir: string, deps: Deps }} a
 */
const createApp = async ({ org, repo, role, name, spec, dir, deps }) => {
  const { out } = deps;
  out('');
  out(`== ${spec.role}: the App "${name}" ==`);
  const state = deps.state();
  const { url, code } = await listen({ org, state, deps, manifestFor: (redirectUrl) => buildManifest({ org, repo, role, name, redirectUrl, spec }) });
  out(`1. Your browser is opening ${url}, which sends the manifest to GitHub.`);
  out(`   Check the name, then click "Create GitHub App for ${org}". (If the name is taken, change it there.)`);
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
  const owner = String(conv.json.owner?.login ?? '');
  if (owner.toLowerCase() !== org.toLowerCase()) deps.err(`warning: GitHub says the App belongs to "${owner}", not ${org}.`);
  const got = conv.json.permissions ?? {};
  const want = spec.permissions;
  const drift = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((k) => got[k] !== want[k]);
  if (drift.length) {
    deps.err(`warning: the App's permissions differ from the ${spec.role}'s on ${drift.join(', ')}. Set them to the role's at https://github.com/organizations/${org}/settings/apps/${slug}/permissions before installing it.`);
  }

  const names = secretNames(role);
  for (const [secret, value] of /** @type {Array<[string, string]>} */ ([[names.id, String(appId)], [names.key, pem]])) {
    const r = await deps.gh(['secret', 'set', secret, '-R', `${org}/${repo}`], value);
    if (r.status !== 0) {
      throw new Error(
        `gh could not set ${secret} (${r.stderr.trim() || `exit ${r.status}`}). The key was never saved anywhere, so it is lost: ` +
          `generate a new one at https://github.com/organizations/${org}/settings/apps/${slug}, run ` +
          `"gh secret set ${names.key} -R ${org}/${repo} < <file>.pem", delete the file, and set ${names.id} to ${appId}.`,
      );
    }
  }
  out(`3. Stored ${names.id} and ${names.key} as Actions secrets on ${org}/${repo}.`);

  const install = `https://github.com/apps/${slug}/installations/new`;
  out(`4. Your browser is opening ${install}.`);
  out(`   Choose ${org}, then "Only select repositories", pick ${repo} alone, and click "Install".`);
  deps.open(install);
  const inst = await awaitInstallation({ org, repo, appId, pem, deps });
  for (const w of inst.warnings) deps.err(`warning: ${w}`);
  out(`5. Installed (installation ${inst.id}).`);

  const path = join(dir, REGISTER_PATH);
  const { text, diff } = writeRegisterRow(deps.readFile(path), { role: spec.role, slug, permissions: spec.permissions });
  deps.writeFile(path, text);
  out(`6. Wrote the ${spec.role}'s row in ${REGISTER_PATH}. Commit it:`);
  for (const l of diff) out(`   ${l}`);
  return { slug, warnings: inst.warnings };
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
  const { org, repo } = opts;

  // Fail before any App exists if the key could not be stored: an App whose key has nowhere
  // to go is one more App to delete by hand.
  const probe = await deps.gh(['secret', 'list', '-R', `${org}/${repo}`]);
  if (probe.status !== 0) {
    deps.err(`kanon apps: gh cannot read ${org}/${repo}'s Actions secrets (${probe.stderr.trim() || `exit ${probe.status}`}).`);
    deps.err('Sign gh in as someone who can set them (an admin of the repository), and try again. No App was created.');
    return 1;
  }

  let warnings = 0;
  try {
    for (const role of opts.roles) {
      const spec = /** @type {RoleSpec} */ (roles[role]);
      const r = await createApp({ org, repo, role, spec, name: opts.names[role] ?? `${repo}-${role}`, dir: opts.dir, deps });
      warnings += r.warnings.length;
    }
  } catch (e) {
    deps.err(`kanon apps: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  deps.out('');
  deps.out(warnings ? `Done, with ${warnings} warning(s) above to act on.` : 'Done.');
  for (const l of rotationSteps(org, repo, opts.roles)) deps.out(l);
  return 0;
};
