import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRegisterRow } from '../../cli/app-register.mjs';
import { apps, buildManifest, loadRoles, realDeps } from '../../cli/apps.mjs';
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
  api: string[];
  writes: string[];
  dir: string;
};

type Scenario = {
  roles?: string;
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

const run = async (s: Scenario = {}): Promise<Run> => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-apps-'));
  if (s.register !== undefined) realDeps.writeFile(join(dir, 'docs/qa/agent-identities.md'), s.register);
  const r: Run = { status: -1, output: '', manifest: null, action: '', callbackStatus: 0, gh: [], api: [], writes: [], dir };
  let installed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let n = 0;

  const status = await apps(['--org', ORG, '--repo', REPO, '--roles', s.roles ?? 'reviewer', '--dir', dir, ...(s.extraArgs ?? [])], {
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
      const by = args[1] === 'set' ? s.setStatus : args[1] === 'delete' ? s.deleteStatus : undefined;
      const status = by?.[args[2] ?? ''] ?? 0;
      return { status, stdout: '', stderr: status ? 'HTTP 403: Resource not accessible' : '' };
    },
    // The fake browser.
    open: (url) => {
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
      const m = buildManifest({ org: ORG, repo: REPO, role: row.role.toLowerCase(), name: 'n', redirectUrl: 'http://127.0.0.1:1/callback', spec: roles[row.role.toLowerCase()]! });
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
      `secret set KANON_APPS_PREFLIGHT -R ${ORG}/${REPO}`,
      `secret delete KANON_APPS_PREFLIGHT -R ${ORG}/${REPO}`,
      `secret set REVIEWER_APP_ID -R ${ORG}/${REPO}`,
      `secret set REVIEWER_APP_PRIVATE_KEY -R ${ORG}/${REPO}`,
    ]);
    expect(r.gh[2]?.input).toBe('4242');
    expect(r.gh[3]?.input).toBe(PEM);
    // The installation token is revoked once the repository list is read.
    expect(r.api).toContain('DELETE /installation/token');
    expect(r.output).toContain('Key rotation stays manual');
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('the private key never reaches disk, stdout, stderr or an argument', async () => {
    const r = await run();
    expect(r.status, r.output).toBe(0);
    expect(r.gh[3]?.input).toBe(PEM); // so the absence checks below are not vacuous
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
    expect(r.output).toMatch(/warning: The App is installed on ALL repositories in acme/);
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
  const preflightRun = async (reply: (args: string[]) => Gh | Promise<Gh>) => {
    const calls: string[] = [];
    const out: string[] = [];
    let opened = 0;
    const status = await apps(['--org', ORG, '--repo', REPO, '--roles', 'reviewer'], {
      gh: async (args) => {
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
    const r = await preflightRun((args) =>
      args[1] === 'set' ? { status: 1, stdout: '', stderr: 'failed to set secret: HTTP 403: Resource not accessible by personal access token' } : ok,
    );
    expect(r.status).toBe(1);
    expect(r.opened).toBe(0);
    expect(r.output).toContain(`gh cannot set an Actions secret on ${ORG}/${REPO} (failed to set secret: HTTP 403: Resource not accessible by personal access token).`);
    expect(r.output).toMatch(/Secrets: read and write/);
    expect(r.output).toMatch(/GH_TOKEN/);
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

  it('names the exit status when gh says nothing', async () => {
    const r = await preflightRun((args) => (args[1] === 'set' ? { status: 4, stdout: '', stderr: '' } : ok));
    expect(r.status).toBe(1);
    expect(r.output).toContain('(exit 4)');
  });

  it('refuses an unknown role, and a name for a role it was not asked for', async () => {
    const out: string[] = [];
    const err = (l: string) => out.push(l);
    expect(await apps(['--org', ORG, '--repo', REPO, '--roles', 'releaser'], { err })).toBe(2);
    expect(await apps(['--org', ORG, '--repo', REPO, '--roles', 'reviewer', '--name', 'lead=x'], { err })).toBe(2);
    expect(out.join('\n')).toMatch(/"releaser" is not an agent role/);
    expect(out.join('\n')).toMatch(/--name names the role "lead"/);
  });

  it('uses the name given with --name', async () => {
    const r = await run({ extraArgs: ['--name', 'reviewer=Acme Reviewer'] });
    expect(r.manifest?.name).toBe('Acme Reviewer');
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
    expect(write(custom, 'Overseer', 'o').text).toContain('| Overseer | `o` |  | Read | Read & write | Read | No access | No access |');
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

  it('is exactly what kanon apps writes for the Reviewer it created', () => {
    const { text } = writeRegisterRow(null, { role: 'Reviewer', slug: 'kanon-reviewer', permissions: loadRoles().reviewer!.permissions });
    expect(readFileSync(OWN, 'utf8')).toBe(text);
  });

  it('gives the lanes the Reviewer slug', () => {
    const r = spawnSync('awk', ['-v', 'role=Reviewer', '-f', AWK, OWN], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('kanon-reviewer\n');
  });
});
