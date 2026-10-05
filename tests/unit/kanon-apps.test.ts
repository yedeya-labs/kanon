import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRegisterRow } from '../../cli/app-register.mjs';
import { apps, buildManifest, checkoutCheck, loadRoles, realDeps, remoteRepo } from '../../cli/apps.mjs';
import { agentRows, expectedManifestPermissions } from './helpers/roles-table.js';

/**
 * `kanon apps` (#39). GitHub and `gh` are mocked; the local listener is real, and a fake
 * browser drives it: it loads the local page, reads the form GitHub would receive, and
 * follows GitHub's redirect back with a code and a state.
 */
const ROOT = process.cwd();
const ORG = 'acme';
const REPO = 'widgets';
const AWK = join(ROOT, 'actions/lane-check/app-register.awk');

// A real RSA key, so the JWT the command signs can be verified the way GitHub would.
const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const PUBLIC = createPublicKey(PEM);
/** A distinctive run of the key's base64 body: if any of the key leaks, this does. */
const KEY_BODY = PEM.split('\n').slice(1, -2).join('');
const KEY_LINES = PEM.split('\n').filter((l) => l && !l.startsWith('-----'));

type Run = {
  status: number;
  output: string;
  manifest: Record<string, unknown> | null;
  action: string;
  callbackStatus: number;
  gh: Array<{ args: string[]; input: string | undefined }>;
  git: string[][];
  api: string[];
  writes: string[];
  opened: string[];
  dir: string;
};

type Git = { status: number | null; stdout: string; stderr: string };

type Scenario = {
  roles?: string;
  /** The owner's account type, as `GET /users/<login>` answers it (default Organization). */
  kind?: 'User' | 'Organization';
  /** The owner flag: `--owner` (default) or the deprecated `--org`. */
  ownerFlag?: '--owner' | '--org';
  /** The environment gh would see. */
  env?: Record<string, string>;
  /** gh's answer to `gh api user`. */
  user?: Git;
  /** git's answers; by default the scenario's directory is a checkout of acme/widgets. */
  git?: (args: string[], dir: string) => Git;
  /** Drop --dir, so the command reads the working directory. */
  noDir?: boolean;
  extraArgs?: string[];
  callbackState?: (sent: string) => string;
  selection?: 'all' | 'selected';
  repos?: string[];
  register?: string;
  /** Overrides fields of GitHub's conversion reply. */
  conversion?: Record<string, unknown>;
  /** gh's exit status for `gh secret set <name>`. */
  setStatus?: Record<string, number>;
  /** gh's exit status for `gh secret delete <name>`. */
  deleteStatus?: Record<string, number>;
};

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let printed = '';
beforeEach(() => {
  printed = '';
  const capture = (chunk: unknown) => {
    printed += String(chunk);
    return true;
  };
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  log = vi.spyOn(console, 'log').mockImplementation(capture);
});
afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  log.mockRestore();
});

const verifyJwt = (auth: string | undefined, appId: string) => {
  const jwt = (auth ?? '').replace(/^Bearer /, '');
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) throw new Error('not a JWT');
  if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), PUBLIC, Buffer.from(s, 'base64url'))) throw new Error('bad JWT signature');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (header.alg !== 'RS256' || claims.iss !== appId || claims.exp - claims.iat > 600) throw new Error('bad JWT claims');
};

/** A git that answers as a checkout, at `root`, whose one remote is `url`. */
const checkoutOf =
  (url: string, root?: string) =>
  (args: string[], dir: string): Git =>
    args.includes('rev-parse')
      ? { status: 0, stdout: `${root ?? dir}\n`, stderr: '' }
      : args.includes('remote')
        ? { status: 0, stdout: `origin\t${url} (fetch)\norigin\t${url} (push)\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };

const notACheckout = (): Git => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

const run = async (s: Scenario = {}): Promise<Run> => {
  printed = '';
  const dir = mkdtempSync(join(tmpdir(), 'kanon-apps-'));
  if (s.register !== undefined) realDeps.writeFile(join(dir, 'docs/qa/agent-identities.md'), s.register);
  const r: Run = { status: -1, output: '', manifest: null, action: '', callbackStatus: 0, gh: [], git: [], api: [], writes: [], opened: [], dir };
  let installed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let n = 0;

  const argv = [s.ownerFlag ?? '--owner', ORG, '--repo', REPO, '--roles', s.roles ?? 'reviewer', ...(s.noDir ? [] : ['--dir', dir]), ...(s.extraArgs ?? [])];
  const status = await apps(argv, {
    env: s.env ?? {},
    git: (args) => {
      r.git.push(args);
      return (s.git ?? checkoutOf(`git@github.com:${ORG}/${REPO}.git`))(args, dir);
    },
    state: () => `state-${++n}`,
    pollMs: 0,
    timeoutMs: 5000,
    sleep: () => new Promise((res) => setTimeout(res, 1)),
    writeFile: (path, text) => {
      r.writes.push(path);
      realDeps.writeFile(path, text);
    },
    gh: async (args, input) => {
      r.gh.push({ args, input });
      if (args[0] === 'api' && args[1] === 'user') return s.user ?? { status: 0, stdout: 'octo\n', stderr: '' };
      if (args[0] === 'api' && args[1] === `users/${ORG}`) return { status: 0, stdout: JSON.stringify({ login: ORG, type: s.kind ?? 'Organization' }), stderr: '' };
      const by = args[1] === 'set' ? s.setStatus : args[1] === 'delete' ? s.deleteStatus : undefined;
      const status = by?.[args[2] ?? ''] ?? 0;
      return { status, stdout: '', stderr: status ? 'HTTP 403: Resource not accessible' : '' };
    },
    // The fake browser.
    open: (url) => {
      r.opened.push(url);
      if (url.startsWith('https://github.com/apps/')) {
        installed = true;
        return;
      }
      pending = (async () => {
        const page = await (await fetch(url)).text();
        r.action = /action="([^"]+)"/.exec(page)?.[1]?.replace(/&amp;/g, '&') ?? '';
        const value = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? '';
        r.manifest = JSON.parse(value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
        const sent = new URL(r.action).searchParams.get('state') ?? '';
        const back = new URL(String(r.manifest?.redirect_url));
        back.searchParams.set('code', 'one-time-code');
        back.searchParams.set('state', s.callbackState ? s.callbackState(sent) : sent);
        r.callbackStatus = (await fetch(back)).status;
      })();
    },
    github: async (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      r.api.push(`${method} ${u.pathname}`);
      const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });
      if (method === 'POST' && u.pathname === '/app-manifests/one-time-code/conversions') {
        if (auth) throw new Error('the conversion needs no auth');
        return json(201, {
          id: 4242,
          slug: `${REPO}-reviewer`,
          owner: { login: ORG },
          permissions: (r.manifest as { default_permissions: Record<string, string> }).default_permissions,
          pem: PEM,
          client_secret: 'client-secret',
          webhook_secret: null,
          ...s.conversion,
        });
      }
      if (u.pathname === '/app/installations') {
        verifyJwt(auth, '4242');
        return json(200, installed ? [{ id: 77, account: { login: ORG }, repository_selection: s.selection ?? 'selected' }] : []);
      }
      if (method === 'POST' && u.pathname === '/app/installations/77/access_tokens') {
        verifyJwt(auth, '4242');
        return json(201, { token: 'ghs_installation' });
      }
      if (u.pathname === '/installation/repositories') {
        if (auth !== 'token ghs_installation') throw new Error('expected the installation token');
        return json(200, { repositories: (s.repos ?? [`${ORG}/${REPO}`]).map((full_name) => ({ full_name })) });
      }
      if (method === 'DELETE' && u.pathname === '/installation/token') return json(204, null);
      throw new Error(`unexpected GitHub call ${method} ${url}`);
    },
  });
  await pending;
  r.status = status;
  r.output = printed;
  return r;
};

/** Every file under `dir`, read whole. */
const allFiles = (dir: string): Array<[string, string]> =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => [f, readFileSync(f, 'utf8')]);

const parseSlug = (dir: string, role: string) =>
  spawnSync('awk', ['-v', `role=${role}`, '-f', AWK, join(dir, 'docs/qa/agent-identities.md')], { encoding: 'utf8' });

describe('the manifest (K-ADOPT-8)', () => {
  const roles = loadRoles();
  for (const row of agentRows()) {
    it(`${row.role}: exactly the row's permissions plus Metadata: read, private, no webhook`, () => {
      const m = buildManifest({ owner: ORG, repo: REPO, role: row.role.toLowerCase(), name: 'n', redirectUrl: 'http://127.0.0.1:1/callback', spec: roles[row.role.toLowerCase()]! });
      // Compared with the roles table itself, not with the JSON the builder reads, so an
      // extra permission from either the data or the builder fails here.
      expect(m.default_permissions).toEqual(expectedManifestPermissions(row));
      expect(m.public).toBe(false);
      expect(m.hook_attributes.active).toBe(false);
      expect(m.default_events).toEqual([]);
    });
  }
});

describe('kanon apps, end to end with GitHub mocked', () => {
  it('creates, stores, checks and registers the Reviewer', async () => {
    const r = await run();
    expect(r.status, r.output).toBe(0);
    expect(r.action).toBe(`https://github.com/organizations/${ORG}/settings/apps/new?state=state-1`);
    expect(r.manifest).toMatchObject({ name: `${REPO}-reviewer`, public: false, hook_attributes: { active: false } });
    expect(r.manifest?.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(r.callbackStatus).toBe(200);
    expect(r.gh.map((c) => c.args.join(' '))).toEqual([
      'api user --jq .login',
      `api users/${ORG}`,
      `secret set KANON_APPS_PREFLIGHT -R ${ORG}/${REPO}`,
      `secret delete KANON_APPS_PREFLIGHT -R ${ORG}/${REPO}`,
      `secret set REVIEWER_APP_ID -R ${ORG}/${REPO}`,
      `secret set REVIEWER_APP_PRIVATE_KEY -R ${ORG}/${REPO}`,
    ]);
    expect(r.gh[4]?.input).toBe('4242');
    expect(r.gh[5]?.input).toBe(PEM);
    // The installation token is revoked once the repository list is read.
    expect(r.api).toContain('DELETE /installation/token');
    expect(r.output).toContain('Key rotation stays manual');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('the private key never reaches disk, stdout, stderr or an argument', async () => {
    const r = await run();
    expect(r.status, r.output).toBe(0);
    expect(r.gh[5]?.input).toBe(PEM); // so the absence checks below are not vacuous
    for (const where of [r.output, ...r.gh.map((c) => c.args.join(' '))]) {
      expect(where).not.toContain('PRIVATE KEY');
      for (const line of KEY_LINES) expect(where).not.toContain(line);
    }
    expect(r.writes).toEqual([join(r.dir, 'docs/qa/agent-identities.md')]);
    for (const [file, text] of allFiles(r.dir)) {
      expect(text, file).not.toContain('PRIVATE KEY');
      expect(text.replace(/\s/g, ''), file).not.toContain(KEY_BODY.slice(0, 64));
    }
    expect(r.output).not.toContain('client-secret');
    expect(r.output).not.toContain('ghs_installation');
    rmSync(r.dir, { recursive: true, force: true });
  });

  const leaks = (text: string) => text.includes('PRIVATE KEY') || KEY_LINES.some((l) => text.includes(l));

  it('prints no key when GitHub\'s conversion reply is incomplete', async () => {
    const r = await run({ conversion: { slug: undefined } });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/GitHub answered 201 when exchanging the code/);
    expect(leaks(r.output)).toBe(false);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('prints no key, and says how to recover, when gh cannot store it', async () => {
    const r = await run({ setStatus: { REVIEWER_APP_PRIVATE_KEY: 1 } });
    expect(r.status).toBe(1);
    expect(r.gh.at(-1)?.input).toBe(PEM);
    expect(r.output).toMatch(/gh could not set REVIEWER_APP_PRIVATE_KEY .*it is lost: generate a new one/);
    expect(leaks(r.output)).toBe(false);
    expect(r.writes).toEqual([]);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('refuses a redirect whose state does not match, and stores nothing', async () => {
    const r = await run({ callbackState: () => 'forged' });
    expect(r.status).toBe(1);
    expect(r.callbackStatus).toBe(400);
    expect(r.output).toMatch(/state that does not match/);
    expect(r.api).toEqual([]);
    expect(r.gh.filter((c) => c.args[1] === 'set' && c.args[2] !== 'KANON_APPS_PREFLIGHT')).toEqual([]);
    expect(r.writes).toEqual([]);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('writes a register row the lanes can read', async () => {
    const r = await run();
    expect(r.status, r.output).toBe(0);
    const register = readFileSync(join(r.dir, 'docs/qa/agent-identities.md'), 'utf8');
    expect(register).toContain(`| Reviewer | \`${REPO}-reviewer\` | Read & write | Read & write | Read & write | No access | No access | None |`);
    const parsed = parseSlug(r.dir, 'Reviewer');
    expect(parsed.stderr).toBe('');
    expect(parsed.stdout.trim()).toBe(`${REPO}-reviewer`);
    expect(r.output).toContain(`+| Reviewer | \`${REPO}-reviewer\``);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('warns when the installation covers every repository', async () => {
    const r = await run({ selection: 'all' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/warning: The App is installed on ALL repositories of acme/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('warns when the installation covers other repositories too', async () => {
    const r = await run({ repos: [`${ORG}/${REPO}`, `${ORG}/gadgets`] });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/warning: The App is also installed on acme\/gadgets/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('does not warn when the installation covers the repository alone', async () => {
    const r = await run();
    expect(r.output).not.toMatch(/warning/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('fails, and registers nothing, when the installation misses the repository', async () => {
    const r = await run({ repos: [`${ORG}/gadgets`] });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/not on widgets/);
    expect(r.writes).toEqual([]);
    rmSync(r.dir, { recursive: true, force: true });
  });

  // The live failure behind this (#39): the token could read Actions secrets but not write
  // them, so `gh secret list` passed, the App was created, and its key was lost.
  type Gh = { status: number | null; stdout: string; stderr: string };
  const preflightRun = async (reply: (args: string[]) => Gh | Promise<Gh>, env: Record<string, string> = {}) => {
    const calls: string[] = [];
    const out: string[] = [];
    let opened = 0;
    const status = await apps(['--owner', ORG, '--repo', REPO, '--roles', 'reviewer'], {
      env,
      git: (args) => checkoutOf(`https://github.com/${ORG}/${REPO}.git`, '/work/widgets')(args, ''),
      gh: async (args) => {
        if (args[0] === 'api') return args[1] === 'user' ? { ...ok, stdout: 'octo' } : { ...ok, stdout: JSON.stringify({ login: ORG, type: 'Organization' }) };
        calls.push(args.join(' '));
        return reply(args);
      },
      open: () => {
        opened++;
      },
      github: async () => {
        throw new Error('no GitHub call before the pre-check passes');
      },
      err: (l) => out.push(l),
      out: (l) => out.push(l),
    });
    return { status, calls, output: out.join('\n'), opened };
  };
  const ok: Gh = { status: 0, stdout: '', stderr: '' };
  const SET = `secret set KANON_APPS_PREFLIGHT -R ${ORG}/${REPO}`;
  const DELETE = `secret delete KANON_APPS_PREFLIGHT -R ${ORG}/${REPO}`;

  it('refuses before opening a page when gh can list the secrets but not set one', async () => {
    const r = await preflightRun(
      (args) => (args[1] === 'set' ? { status: 1, stdout: '', stderr: 'failed to set secret: HTTP 403: Resource not accessible by personal access token' } : ok),
      { GH_TOKEN: 'ghp_stale' },
    );
    expect(r.status).toBe(1);
    expect(r.opened).toBe(0);
    expect(r.output).toContain(`gh cannot set an Actions secret on ${ORG}/${REPO} (failed to set secret: HTTP 403: Resource not accessible by personal access token).`);
    expect(r.output).toMatch(/Secrets: read and write/);
    expect(r.output).toContain('The token gh uses, the token in GH_TOKEN, needs Secrets: read and write');
    expect(r.output).toContain('`unset GH_TOKEN` to use the stored login');
    expect(r.output).not.toContain('ghp_stale');
    expect(r.output).toMatch(/No App was created/);
    // The throwaway secret is deleted even though setting it failed.
    expect(r.calls).toEqual([SET, DELETE]);
  });

  it('deletes the throwaway secret when gh throws while setting it', async () => {
    const r = await preflightRun((args) => {
      if (args[1] === 'set') throw new Error('spawn gh ENOENT');
      return ok;
    });
    expect(r.status).toBe(1);
    expect(r.opened).toBe(0);
    expect(r.output).toMatch(/gh cannot set an Actions secret .*\(spawn gh ENOENT\)/);
    expect(r.calls).toEqual([SET, DELETE]);
  });

  it('refuses, and says how to clean up, when gh can set the throwaway secret but not delete it', async () => {
    const r = await preflightRun((args) => (args[1] === 'delete' ? { status: 1, stdout: '', stderr: 'HTTP 403' } : ok));
    expect(r.status).toBe(1);
    expect(r.opened).toBe(0);
    expect(r.output).toContain(`cannot delete it (HTTP 403). Delete it by hand: gh secret delete KANON_APPS_PREFLIGHT -R ${ORG}/${REPO}`);
    expect(r.calls).toEqual([SET, DELETE]);
  });

  it('names the exit status when gh says nothing, and gives no token advice for a failure GitHub did not refuse', async () => {
    const r = await preflightRun((args) => (args[1] === 'set' ? { status: 4, stdout: '', stderr: '' } : ok), { GH_TOKEN: 'x' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('(exit 4)');
    expect(r.output).not.toContain('unset GH_TOKEN');
  });

  it('refuses an unknown role, and a name for a role it was not asked for', async () => {
    const out: string[] = [];
    const err = (l: string) => out.push(l);
    expect(await apps(['--owner', ORG, '--repo', REPO, '--roles', 'releaser'], { err })).toBe(2);
    expect(await apps(['--owner', ORG, '--repo', REPO, '--roles', 'reviewer', '--name', 'lead=x'], { err })).toBe(2);
    expect(out.join('\n')).toMatch(/"releaser" is not an agent role/);
    expect(out.join('\n')).toMatch(/--name names the role "lead"/);
  });

  it('uses the name given with --name', async () => {
    const r = await run({ extraArgs: ['--name', 'reviewer=Acme Reviewer'] });
    expect(r.manifest?.name).toBe('Acme Reviewer');
    rmSync(r.dir, { recursive: true, force: true });
  });
});

/** Every github.com URL the run printed, opened, or sent the manifest to. */
const githubUrls = (r: Run) =>
  [...`${r.output}\n${r.opened.join('\n')}\n${r.action}`.matchAll(/https:\/\/github\.com\/[^\s"'`),]*/g)].map((m) => m[0]);

describe('kanon apps for a personal account or an organisation (plan 0005 §5.1, decision 1)', () => {
  // Every page that names an owner: the create page, the App's settings (the permissions
  // drift warning and the rotation steps) and the installation's (the all-repositories
  // warning). The install page, github.com/apps/<slug>/installations/new, names no owner.
  const everyPage: Scenario = { selection: 'all', conversion: { permissions: { contents: 'read' } } };
  const owned = (urls: string[]) => urls.filter((u) => !u.startsWith('https://github.com/apps/'));

  it('asks GitHub what the owner is', async () => {
    const r = await run();
    expect(r.gh.slice(0, 2).map((c) => c.args.join(' '))).toEqual(['api user --jq .login', `api users/${ORG}`]);
  });

  it('a User owner: every page it prints or opens is under github.com/settings/', async () => {
    const r = await run({ ...everyPage, kind: 'User' });
    expect(r.status, r.output).toBe(0);
    expect(r.action).toBe('https://github.com/settings/apps/new?state=state-1');
    const urls = owned(githubUrls(r));
    // So the check below is not vacuous: the create page, the App's settings, its installation.
    expect(urls.some((u) => u.startsWith('https://github.com/settings/apps/new'))).toBe(true);
    expect(urls.some((u) => u.startsWith(`https://github.com/settings/apps/${REPO}-reviewer/permissions`))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://github.com/settings/installations/77'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://github.com/settings/apps/<slug>'))).toBe(true);
    for (const u of urls) expect(u).toMatch(/^https:\/\/github\.com\/settings\//);
    expect(r.output).toContain(`${ORG} is a personal account; its Apps are created at https://github.com/settings/apps/new.`);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('an Organization owner: every page it prints or opens is under github.com/organizations/<org>/', async () => {
    const r = await run({ ...everyPage, kind: 'Organization' });
    expect(r.status, r.output).toBe(0);
    const urls = owned(githubUrls(r));
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const u of urls) expect(u).toMatch(new RegExp(`^https://github\\.com/organizations/${ORG}/settings/`));
    expect(r.output).toContain(`${ORG} is an organisation`);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('refuses an owner GitHub does not know, before the preflight', async () => {
    const out: string[] = [];
    const calls: string[] = [];
    const status = await apps(['--owner', 'nobody-here', '--repo', REPO, '--roles', 'reviewer', '--register', '/dev/null/x'], {
      env: {},
      git: () => notACheckout(),
      gh: async (args) => {
        calls.push(args.join(' '));
        if (args[1] === 'user') return { status: 0, stdout: 'octo', stderr: '' };
        return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
      },
      err: (l) => out.push(l),
      out: (l) => out.push(l),
    });
    expect(status).toBe(1);
    expect(calls).toEqual(['api user --jq .login', 'api users/nobody-here']);
    expect(out.join('\n')).toContain('GitHub could not say what "nobody-here" is (gh: Not Found (HTTP 404)). Check --owner.');
  });

  it('keeps --org one release, as a deprecated alias that warns', async () => {
    const r = await run({ ownerFlag: '--org' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('warning: --org is deprecated; use --owner');
    expect(r.action).toBe(`https://github.com/organizations/${ORG}/settings/apps/new?state=state-1`);
    expect((await run()).output).not.toContain('deprecated');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('refuses --owner and --org naming different accounts, and a slash in --owner', async () => {
    const out: string[] = [];
    const err = (l: string) => out.push(l);
    expect(await apps(['--owner', ORG, '--org', 'other', '--repo', REPO, '--roles', 'reviewer'], { err })).toBe(2);
    expect(await apps(['--owner', `${ORG}/${REPO}`, '--repo', REPO, '--roles', 'reviewer'], { err })).toBe(2);
    expect(await apps(['--repo', REPO, '--roles', 'reviewer'], { err })).toBe(2);
    expect(out.join('\n')).toContain('--owner and --org name different accounts, "acme" and "other"');
    expect(out.join('\n')).toContain('--owner takes a GitHub login, not "acme/widgets"');
    expect(out.join('\n')).toContain('--owner is required');
  });
});

describe('kanon apps refuses outside a checkout of --repo (plan 0005 §5.1)', () => {
  // The refusal must come before the token is used for anything: the Owner's run outside the
  // checkout created both Apps and their secrets, then wrote a register in the parent.
  const refusedEarly = (r: Run) => {
    expect(r.status).toBe(1);
    expect(r.gh).toEqual([]);
    expect(r.opened).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.api).toEqual([]);
  };

  it('from no checkout: exits 1 before the preflight, naming the directory and --repo', async () => {
    const r = await run({ git: notACheckout });
    refusedEarly(r);
    expect(r.output).toContain(`${r.dir} is not a git checkout, and --repo is ${ORG}/${REPO}`);
    expect(r.output).toContain(`cd into your checkout of ${ORG}/${REPO}`);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("from another repository's checkout: exits 1 before the preflight, naming both", async () => {
    const r = await run({ git: checkoutOf(`git@github.com:${ORG}/gadgets.git`) });
    refusedEarly(r);
    expect(r.output).toContain(`${r.dir} is a checkout of ${ORG}/gadgets, not of ${ORG}/${REPO}, which --owner and --repo name.`);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('from a checkout with no remote: refuses, saying it has no GitHub remote', async () => {
    const r = await run({ git: (args, dir) => (args.includes('rev-parse') ? { status: 0, stdout: dir, stderr: '' } : { status: 0, stdout: '', stderr: '' }) });
    refusedEarly(r);
    expect(r.output).toContain('is a checkout of no GitHub remote');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('reads the working directory when --dir is not given', async () => {
    const r = await run({ noDir: true, git: notACheckout });
    refusedEarly(r);
    expect(r.git[0]).toEqual(['-C', process.cwd(), 'rev-parse', '--show-toplevel']);
  });

  it.each([
    ['an https remote', `https://github.com/${ORG}/${REPO}.git`],
    ['an https remote without .git', `https://github.com/${ORG}/${REPO}`],
    ['an scp-like ssh remote', `git@github.com:${ORG}/${REPO}.git`],
    ['an ssh host alias', `git@github-work:${ORG}/${REPO}.git`],
    ['an ssh URL', `ssh://git@github.com/${ORG}/${REPO}.git`],
    ['another case', `https://github.com/ACME/Widgets.git`],
  ])('accepts a checkout whose remote is %s', async (_, url) => {
    const r = await run({ git: checkoutOf(url) });
    expect(r.status, r.output).toBe(0);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('writes the register at the top of the checkout when run from a subdirectory', async () => {
    const r = await run({ git: (args, dir) => checkoutOf(`git@github.com:${ORG}/${REPO}.git`, join(dir, 'top'))(args, dir) });
    expect(r.status, r.output).toBe(0);
    expect(r.writes).toEqual([join(r.dir, 'top', 'docs/qa/agent-identities.md')]);
    expect(r.output).toContain(`The App register is ${join(r.dir, 'top', 'docs/qa/agent-identities.md')}.`);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('--register writes elsewhere on purpose, and needs no checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanon-register-'));
    const target = join(dir, 'elsewhere.md');
    const r = await run({ git: notACheckout, extraArgs: ['--register', target] });
    expect(r.status, r.output).toBe(0);
    expect(r.git).toEqual([]);
    expect(r.writes).toEqual([target]);
    expect(parseSlug(dir, 'Reviewer').status).not.toBe(0); // nothing in the usual place
    expect(readFileSync(target, 'utf8')).toContain(`| Reviewer | \`${REPO}-reviewer\``);
    rmSync(dir, { recursive: true, force: true });
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('with the real git: refuses a directory outside any checkout, and one of another repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanon-checkout-'));
    try {
      expect(checkoutCheck(realDeps, dir, ORG, REPO).refusal?.[0]).toMatch(/is not a git checkout, and --repo is acme\/widgets/);
      spawnSync('git', ['init', '-q', dir]);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `git@github.com:${ORG}/gadgets.git`]);
      expect(checkoutCheck(realDeps, dir, ORG, REPO).refusal?.[0]).toMatch(/is a checkout of acme\/gadgets, not of acme\/widgets/);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'upstream', `https://github.com/${ORG}/${REPO}.git`]);
      // From a subdirectory, with the repository as its second remote.
      realDeps.writeFile(join(dir, 'sub', 'x'), '');
      const ok = checkoutCheck(realDeps, join(dir, 'sub'), ORG, REPO);
      expect(ok.refusal).toBeNull();
      expect(ok.root && realpathSync(ok.root)).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remoteRepo reads owner/repo from every remote spelling, and nothing from a bare path', () => {
    expect(remoteRepo('https://github.com/a/b.git')).toBe('a/b');
    expect(remoteRepo('git@host-alias:a/b.git')).toBe('a/b');
    expect(remoteRepo('ssh://git@github.com:22/a/b/')).toBe('a/b');
    expect(remoteRepo('b')).toBeNull();
  });
});

describe('kanon apps names the token it uses (plan 0005 §5.1)', () => {
  it('prints where the token came from and whose it is, before the preflight, and never the token', async () => {
    const r = await run({ env: { GH_TOKEN: 'ghp_never_printed' } });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('Using the token in GH_TOKEN, which belongs to octo.');
    expect(r.output.indexOf('Using the token')).toBeLessThan(r.output.indexOf('Your browser is opening'));
    expect(r.gh[0]?.args).toEqual(['api', 'user', '--jq', '.login']);
    expect(`${r.output}${JSON.stringify(r.gh)}`).not.toContain('ghp_never_printed');
    expect((await run()).output).toContain("Using gh's stored login, which belongs to octo.");
    expect((await run({ env: { GITHUB_TOKEN: 'x' } })).output).toContain('Using the token in GITHUB_TOKEN, which belongs to octo.');
    // gh's own order: GH_TOKEN wins over GITHUB_TOKEN.
    expect((await run({ env: { GITHUB_TOKEN: 'x', GH_TOKEN: 'y' } })).output).toContain('Using the token in GH_TOKEN, which belongs to octo.');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('refuses a GH_TOKEN GitHub rejects, before the preflight, and says how to fix it', async () => {
    const r = await run({ env: { GH_TOKEN: 'ghp_stale' }, user: { status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' } });
    expect(r.status).toBe(1);
    expect(r.gh.map((c) => c.args.join(' '))).toEqual(['api user --jq .login']);
    expect(r.opened).toEqual([]);
    expect(r.output).toContain('GitHub refuses the token in GH_TOKEN (gh: Bad credentials (HTTP 401)). Nothing was changed.');
    expect(r.output).toContain('GH_TOKEN is set in this shell, and gh uses it before its stored login');
    expect(r.output).toContain('`unset GH_TOKEN` to use the stored login (check it with `gh auth status`), or export a fresh token as GH_TOKEN.');
    expect(r.output).not.toContain('ghp_stale');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("points at gh auth, not GH_TOKEN, when gh's stored login is the one rejected", async () => {
    const r = await run({ user: { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)' } });
    expect(r.status).toBe(1);
    expect(r.output).toContain("GitHub refuses gh's stored login");
    expect(r.output).toContain('`gh auth login` signs in again');
    expect(r.output).not.toContain('unset');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('carries on, saying so, when the login cannot be read for another reason', async () => {
    const r = await run({ env: { GITHUB_TOKEN: 'x' }, user: { status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' } });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('Using the token in GITHUB_TOKEN; its login could not be read (HTTP 403: Resource not accessible by integration).');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('adds the GH_TOKEN fix to a preflight GitHub refused with 403, and names the token', async () => {
    const r = await run({ env: { GH_TOKEN: 'x' }, setStatus: { KANON_APPS_PREFLIGHT: 1 } });
    expect(r.status).toBe(1);
    expect(r.output).toContain('the token in GH_TOKEN, needs Secrets: read and write');
    expect(r.output).toContain('`unset GH_TOKEN`');
    expect(r.opened).toEqual([]);
    rmSync(r.dir, { recursive: true, force: true });
  });
});

describe('the register row (K-LAYOUT-6)', () => {
  const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/lane-check/adopter/docs/qa/agent-identities.md'), 'utf8');
  const write = (text: string | null, role: string, slug: string) =>
    writeRegisterRow(text, { role, slug, permissions: loadRoles()[role.toLowerCase()]!.permissions });

  const slugOf = (text: string, role: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'kanon-register-'));
    realDeps.writeFile(join(dir, 'docs/qa/agent-identities.md'), text);
    const r = parseSlug(dir, role);
    rmSync(dir, { recursive: true, force: true });
    return r;
  };

  it('adds a row to an existing table, keeping the rows already there', () => {
    const { text, diff } = write(FIXTURE, 'Reviewer', 'example-reviewer');
    expect(diff).toEqual(['+| Reviewer | `example-reviewer` | Read & write | Read & write | Read & write | No access |']);
    for (const [role, slug] of [['Reviewer', 'example-reviewer'], ['Implementer', 'example-implementer'], ['Lead', 'example-lead']]) {
      expect(slugOf(text, role!).stdout.trim()).toBe(slug);
    }
  });

  it('replaces the role\'s row when it exists, bold or not', () => {
    const bold = FIXTURE.replace('| Implementer | `example-implementer` |', '| **Implementer** | **`example-implementer`** |');
    const { text, diff } = write(bold, 'Implementer', 'renamed-implementer');
    expect(diff).toEqual([
      '-| **Implementer** | **`example-implementer`** | Read & write | Read & write | Read & write | Read & write |',
      '+| Implementer | `renamed-implementer` | Read & write | Read & write | Read & write | Read & write |',
    ]);
    expect(slugOf(text, 'Implementer').stdout.trim()).toBe('renamed-implementer');
    expect(text.match(/Implementer \|/g)).toHaveLength(1);
  });

  it('records the Lead\'s Actions: Read, which the fixture has no column for, in Other', () => {
    const { diff } = write(FIXTURE, 'Lead', 'renamed-lead');
    expect(diff).toContain('-| Lead | **`example-lead`** | Read & write | Read & write | Read & write | No access |');
    expect(diff).toContain('+| Lead | `renamed-lead` | Read & write | Read & write | Read & write | No access | Actions: Read |');
    expect(diff.filter((l) => l.includes('example-lead') || l.includes('renamed-lead'))).toHaveLength(2);
  });

  it('puts a permission with no column of its own in Other, and marks the existing rows not recorded', () => {
    const { text } = write(FIXTURE, 'Merger', 'example-merger');
    expect(text).toContain('| Role | App slug | Contents | Issues | Pull requests | Workflows | Other |');
    expect(text).toContain('| Implementer | `example-implementer` | Read & write | Read & write | Read & write | Read & write | not recorded |');
    expect(text).toContain('| Merger | `example-merger` | Read & write | Read & write | Read & write | No access | Actions: Read & write, Checks: Read, Commit statuses: Read |');
    expect(slugOf(text, 'Merger').stdout.trim()).toBe('example-merger');
  });

  it('keeps a project column it does not know on update, and leaves it empty on insert', () => {
    const custom = '| Role | App slug | What it does | Contents | Issues | Pull requests | Workflows | Actions |\n|---|---|---|---|---|---|---|---|\n| Reviewer | `old` | Reviews PRs | Read | Read | Read | No access | No access |\n';
    const { text } = write(custom, 'Reviewer', 'new-reviewer');
    expect(text).toContain('| Reviewer | `new-reviewer` | Reviews PRs | Read & write | Read & write | Read & write | No access | No access |');
    expect(write(custom, 'Overseer', 'o').text).toContain('| Overseer | `o` |  | Read | Read & write | Read | No access | Read |');
  });

  it('creates the register when the file does not exist', () => {
    const { text } = write(null, 'Reviewer', 'r');
    expect(text.startsWith('# Agent identities\n')).toBe(true);
    expect(slugOf(text, 'Reviewer').stdout.trim()).toBe('r');
  });

  it('replaces "none installed" with the table', () => {
    const { text, diff } = write('# Agent identities\n\nNone installed.\n', 'Reviewer', 'r');
    expect(text).not.toMatch(/none installed/i);
    expect(diff[0]).toBe('-None installed.');
    expect(slugOf(text, 'Reviewer').stdout.trim()).toBe('r');
  });

  it('refuses a register the lanes would refuse', () => {
    expect(() => write(`${FIXTURE}\n${FIXTURE}`, 'Reviewer', 'r')).toThrow(/more than one table/);
    expect(() => write(FIXTURE.replace('| Lead |', '| Implementer |'), 'Implementer', 'r')).toThrow(/2 times/);
  });

  it('ignores a table inside a fenced block', () => {
    const fenced = `\`\`\`text\n${FIXTURE}\`\`\`\n\n${FIXTURE}`;
    expect(slugOf(write(fenced, 'Reviewer', 'r').text, 'Reviewer').stdout.trim()).toBe('r');
  });
});

describe("Kanon's own App register (#39, plan 0001 step 4a)", () => {
  const OWN = join(ROOT, 'docs/qa/agent-identities.md');

  // Each row is exactly what the tool wrote, in the order the Owner created the Apps: the
  // Reviewer (2026-10-02), then the Implementer and the Explorer (2026-10-05).
  it('is exactly what kanon apps writes for the Reviewer, the Implementer and the Explorer it created', () => {
    const roles = loadRoles();
    const reviewer = writeRegisterRow(null, { role: 'Reviewer', slug: 'kanon-reviewer', permissions: roles.reviewer!.permissions }).text;
    const both = writeRegisterRow(reviewer, { role: 'Implementer', slug: 'kanon-implementer', permissions: roles.implementer!.permissions }).text;
    const all = writeRegisterRow(both, { role: 'Explorer', slug: 'kanon-explorer', permissions: roles.explorer!.permissions }).text;
    expect(readFileSync(OWN, 'utf8')).toBe(all);
  });

  it('keeps the Implementer as one row when kanon apps writes the slug GitHub gave it', () => {
    const { text } = writeRegisterRow(readFileSync(OWN, 'utf8'), { role: 'Implementer', slug: 'kanon-implementer-2', permissions: loadRoles().implementer!.permissions });
    expect(text.match(/^\| Implementer \|/gm)).toHaveLength(1);
    expect(text).toContain('| Implementer | `kanon-implementer-2` |');
  });

  it.each([['Reviewer', 'kanon-reviewer'], ['Implementer', 'kanon-implementer'], ['Explorer', 'kanon-explorer']])('gives the lanes the %s slug', (role, slug) => {
    const r = spawnSync('awk', ['-v', `role=${role}`, '-f', AWK, OWN], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${slug}\n`);
  });
});
