import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compare, main, registeredRoles, summary } from '../../cli/apps-check.mjs';
import { loadRoles, realDeps } from '../../cli/apps.mjs';

/**
 * apps-check (#39): the script that checks each registered App's installation, and the
 * workflow that runs it. GitHub is mocked; the register is read by the lanes' awk program.
 */
const ROOT = process.cwd();
const ROLES = loadRoles();
const REVIEWER = ROLES.reviewer!;
const REPO = 'acme/widgets';

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const PUBLIC = createPublicKey(PEM);

const withRegister = <T>(text: string, fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'apps-check-'));
  try {
    realDeps.writeFile(join(dir, 'docs/qa/agent-identities.md'), text);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const FIXTURE = readFileSync(join(ROOT, 'tests/fixtures/lane-check/adopter/docs/qa/agent-identities.md'), 'utf8');

describe('registeredRoles reads the register with the lanes\' reader', () => {
  it("lists Kanon's own Reviewer", () => {
    expect(registeredRoles(join(ROOT, 'docs/qa/agent-identities.md'), ROLES)).toEqual([
      { key: 'reviewer', role: 'Reviewer', slug: 'kanon-reviewer', secret: 'REVIEWER' },
    ]);
  });

  it('lists every agent role the register has, bold slugs included, and skips the rest', () => {
    const roles = withRegister(FIXTURE, (dir) => registeredRoles(join(dir, 'docs/qa/agent-identities.md'), ROLES));
    expect(roles).toEqual([
      { key: 'implementer', role: 'Implementer', slug: 'example-implementer', secret: 'IMPLEMENTER' },
      { key: 'lead', role: 'Lead', slug: 'example-lead', secret: 'LEAD' },
    ]);
  });

  it('fails on a register the lanes would refuse, rather than skipping the role', () => {
    expect(() => withRegister(`${FIXTURE}\n${FIXTURE}`, (dir) => registeredRoles(join(dir, 'docs/qa/agent-identities.md'), ROLES))).toThrow(
      /2 tables headed/,
    );
    const noSlug = FIXTURE.replace('`example-implementer`', 'example-implementer');
    expect(() => withRegister(noSlug, (dir) => registeredRoles(join(dir, 'docs/qa/agent-identities.md'), ROLES))).toThrow(/no App slug in backticks/);
  });

  it('fails when the register lists no agent App', () => {
    expect(() => withRegister('# Agent identities\n\nNone installed.\n', (dir) => registeredRoles(join(dir, 'docs/qa/agent-identities.md'), ROLES))).toThrow(
      /lists no agent App/,
    );
  });
});

describe('compare', () => {
  const base = {
    role: 'Reviewer',
    spec: REVIEWER,
    registerSlug: 'kanon-reviewer',
    appSlug: 'kanon-reviewer',
    repository: REPO,
    selection: 'selected',
    repositories: [REPO],
    permissions: { ...REVIEWER.permissions },
  };

  it('passes an installation on this repository alone, with exactly the role\'s permissions', () => {
    expect(compare(base)).toEqual({ failures: [], warnings: [] });
  });

  it('matches the repository without regard to case', () => {
    expect(compare({ ...base, repositories: ['Acme/Widgets'] })).toEqual({ failures: [], warnings: [] });
    expect(compare({ ...base, repository: 'Acme/Widgets' })).toEqual({ failures: [], warnings: [] });
  });

  it('fails when the minted slug is not the register\'s', () => {
    expect(compare({ ...base, appSlug: 'other-reviewer' }).failures).toEqual([
      'Reviewer: the minted App is `other-reviewer`, but the register says `kanon-reviewer` (K-AGENT-5).',
    ]);
  });

  it('fails when the installation misses this repository', () => {
    const r = compare({ ...base, repositories: ['acme/gadgets'] });
    expect(r.failures).toEqual(["Reviewer: the installation doesn't cover acme/widgets (it covers: acme/gadgets)."]);
    expect(r.warnings).toEqual(['Reviewer: the installation also covers acme/gadgets (K-ADOPT-8: one App per role per repository).']);
  });

  it('warns, and does not fail, when it covers other repositories too', () => {
    const r = compare({ ...base, repositories: [REPO, 'acme/gadgets'] });
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual(['Reviewer: the installation also covers acme/gadgets (K-ADOPT-8: one App per role per repository).']);
  });

  it('warns, and does not fail, when it covers all repositories', () => {
    const r = compare({ ...base, selection: 'all', repositories: [] });
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual(['Reviewer: the installation covers ALL repositories in the organisation, not only acme/widgets (K-ADOPT-8).']);
  });

  it('fails on a permission the role does not hold', () => {
    expect(compare({ ...base, permissions: { ...REVIEWER.permissions, actions: 'read' } }).failures).toEqual([
      "Reviewer: the installation's permissions differ from rulebook/agent-permissions.json: actions: read, expected none.",
    ]);
  });

  it('fails on a permission held at a different level', () => {
    expect(compare({ ...base, permissions: { ...REVIEWER.permissions, contents: 'read' } }).failures).toEqual([
      "Reviewer: the installation's permissions differ from rulebook/agent-permissions.json: contents: read, expected write.",
    ]);
  });

  it('fails on a permission the role holds and the installation lacks', () => {
    const rest = Object.fromEntries(Object.entries(REVIEWER.permissions).filter(([k]) => k !== 'issues'));
    expect(compare({ ...base, permissions: rest }).failures).toEqual([
      "Reviewer: the installation's permissions differ from rulebook/agent-permissions.json: issues: none, expected write.",
    ]);
  });
});

describe('summary', () => {
  it('writes one table row, then the failures and warnings', () => {
    const text = summary({
      role: 'Reviewer',
      slug: 'kanon-reviewer',
      installation: '9',
      selection: 'selected',
      repositories: [REPO],
      permissions: { metadata: 'read', contents: 'write' },
      failures: ['f'],
      warnings: ['w'],
    });
    expect(text.split('\n').slice(0, 3)).toEqual([
      '| Role | App slug | Installation | Repositories | Permissions | Result |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Reviewer | `kanon-reviewer` | 9 | acme/widgets | contents: write, metadata: read | Fail |',
    ]);
    expect(text).toContain('- **Fail:** f');
    expect(text).toContain('- Warning: w');
  });

  it('says Pass, with warnings, and Pass', () => {
    const r = { role: 'R', slug: 's', installation: '1', selection: 'all', repositories: [], permissions: {}, failures: [] };
    expect(summary({ ...r, warnings: ['w'] })).toContain('| R | `s` | 1 | all | none | Pass, with warnings |');
    expect(summary({ ...r, warnings: [] })).toContain('| Pass |');
  });
});

describe('main check, with GitHub mocked', () => {
  type Opts = { selection?: string; pages?: string[][]; permissions?: Record<string, string>; status?: number };
  const run = async (o: Opts = {}, env: Record<string, string> = {}) => {
    const out: string[] = [];
    const calls: string[] = [];
    const summaries: string[] = [];
    const pages = o.pages ?? [[REPO]];
    const total = pages.flat().length;
    const status = await main(['check'], {
      env: {
        ROLE: 'reviewer',
        REPOSITORY: REPO,
        REGISTER_SLUG: 'kanon-reviewer',
        APP_SLUG: 'kanon-reviewer',
        INSTALLATION_ID: '9',
        TOKEN: 'ghs_secret_token',
        APP_ID: '4242',
        APP_PRIVATE_KEY: PEM,
        GITHUB_STEP_SUMMARY: '/summary',
        ...env,
      },
      now: () => 1_700_000_000_000,
      out: (l) => out.push(l),
      append: (path, text) => summaries.push(`${path}\n${text}`),
      github: async (url, init) => {
        const u = new URL(url);
        const auth = (init?.headers as Record<string, string>).authorization ?? '';
        calls.push(`${u.pathname}${u.search} ${auth.split(' ')[0]}`);
        const json = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s });
        if (u.pathname === '/app/installations/9') {
          const jwt = auth.replace(/^Bearer /, '');
          const [h, p, sig] = jwt.split('.');
          if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), PUBLIC, Buffer.from(sig ?? '', 'base64url'))) throw new Error('bad JWT');
          expect(JSON.parse(Buffer.from(p ?? '', 'base64url').toString()).iss).toBe('4242');
          return json(o.status ?? 200, { repository_selection: o.selection ?? 'selected', permissions: o.permissions ?? REVIEWER.permissions });
        }
        if (u.pathname === '/installation/repositories') {
          if (auth !== 'token ghs_secret_token') throw new Error('expected the installation token');
          const page = Number(u.searchParams.get('page'));
          return json(200, { total_count: total, repositories: (pages[page - 1] ?? []).map((full_name) => ({ full_name })) });
        }
        throw new Error(`unexpected GitHub call ${url}`);
      },
    });
    return { status, output: out.join('\n'), calls, summaries };
  };

  it('passes, reads the installation with the JWT and the repositories with the token, and writes the summary', async () => {
    const r = await run();
    expect(r.status, r.output).toBe(0);
    expect(r.calls).toEqual(['/app/installations/9 Bearer', '/installation/repositories?per_page=100&page=1 token']);
    expect(r.summaries).toHaveLength(1);
    expect(r.summaries[0]).toMatch(/^\/summary\n\| Role \| App slug/);
    expect(r.summaries[0]).toContain('| Reviewer | `kanon-reviewer` | 9 | acme/widgets |');
    expect(r.output).toContain('Reviewer: the installation matches the register');
  });

  it('reads every page of repositories', async () => {
    const first = Array.from({ length: 100 }, (_, i) => `acme/r${i}`);
    const r = await run({ pages: [first, [REPO]] });
    expect(r.status, r.output).toBe(0);
    expect(r.calls).toHaveLength(3);
    expect(r.output).toMatch(/::warning title=apps-check::Reviewer: the installation also covers acme\/r0/);
  });

  it('fails, as an error annotation, on drifted permissions', async () => {
    const r = await run({ permissions: { ...REVIEWER.permissions, workflows: 'write' } });
    expect(r.status).toBe(1);
    expect(r.output).toContain("::error title=apps-check::Reviewer: the installation's permissions differ");
    expect(r.summaries[0]).toContain('| Fail |');
  });

  it('fails when the installation misses the repository', async () => {
    const r = await run({ pages: [['acme/gadgets']] });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/doesn't cover acme\/widgets/);
  });

  it('lists no repositories, and only warns, for an installation on all of them', async () => {
    const r = await run({ selection: 'all' });
    expect(r.status, r.output).toBe(0);
    expect(r.calls).toEqual(['/app/installations/9 Bearer']);
    expect(r.output).toMatch(/::warning title=apps-check::.*ALL repositories/);
  });

  it('fails when GitHub refuses, and when an input is missing', async () => {
    expect((await run({ status: 404 })).output).toMatch(/::error title=apps-check::GitHub answered 404 for GET \/app\/installations\/9/);
    const r = await run({}, { APP_SLUG: '' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error title=apps-check::APP_SLUG is not set');
  });

  it('never prints the key or the token', async () => {
    for (const r of [await run(), await run({ status: 500 }), await run({ permissions: {} })]) {
      const all = [r.output, ...r.summaries].join('\n');
      expect(all).not.toContain('PRIVATE KEY');
      expect(all).not.toContain('ghs_secret_token');
    }
  });

  it('prints the roles for $GITHUB_OUTPUT', async () => {
    const out: string[] = [];
    expect(await main(['roles'], { env: { REGISTER_DIR: ROOT }, out: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(['roles=[{"key":"reviewer","role":"Reviewer","slug":"kanon-reviewer","secret":"REVIEWER"}]']);
  });
});

describe('the apps-check workflow', () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> };
  type Job = { permissions?: Record<string, string>; needs?: string; secrets?: unknown; strategy?: { matrix: Record<string, string> }; steps: Step[] };
  const text = readFileSync(join(ROOT, '.github/workflows/apps-check.yml'), 'utf8');
  const wf = parse(text) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };
  const check = wf.jobs.check!;
  const register = wf.jobs.register!;

  it('runs by hand only', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
  });

  it('grants nothing at the top or to the check jobs, and contents: read to the register job only', () => {
    expect(wf.permissions).toEqual({});
    expect(check.permissions).toEqual({});
    expect(register.permissions).toEqual({ contents: 'read' });
  });

  it('runs the check once per registered role, without stopping at the first failure', () => {
    expect(check.needs).toBe('register');
    expect(check.strategy).toEqual({ 'fail-fast': false, matrix: { app: '${{ fromJSON(needs.register.outputs.roles) }}' } });
    expect(register.steps.map((s) => s.run).filter(Boolean)).toEqual(['node cli/apps-check.mjs roles >> "$GITHUB_OUTPUT"']);
  });

  it("mints with the create-github-app-token Kanon's lanes pin, from the role's own two secrets, scoped to the owner", () => {
    const lane = readFileSync(join(ROOT, '.github/workflows/agent-lane.yml'), 'utf8');
    const pinned = /uses: (actions\/create-github-app-token@\S+)/.exec(lane)?.[1];
    const mint = check.steps[0]!;
    expect(mint.uses).toBe(pinned);
    expect(mint.with).toEqual({
      'client-id': "${{ secrets[format('{0}_APP_ID', matrix.app.secret)] }}",
      'private-key': "${{ secrets[format('{0}_APP_PRIVATE_KEY', matrix.app.secret)] }}",
      owner: '${{ github.repository_owner }}',
    });
  });

  it('names every secret it reads, and inherits none', () => {
    expect(text).not.toMatch(/secrets:\s*inherit/);
    for (const job of Object.values(wf.jobs)) expect(job.secrets).toBeUndefined();
    const named = [...text.matchAll(/secrets(\.\w+|\[[^\]]+\])/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(["[format('{0}_APP_ID', matrix.app.secret)]", "[format('{0}_APP_PRIVATE_KEY', matrix.app.secret)]"]));
  });

  it('keeps the logic in the script: one run line per job', () => {
    expect(check.steps.map((s) => s.run).filter(Boolean)).toEqual(['node cli/apps-check.mjs check']);
    const env = check.steps.at(-1)!.env!;
    expect(Object.keys(env).sort()).toEqual(['APP_ID', 'APP_PRIVATE_KEY', 'APP_SLUG', 'INSTALLATION_ID', 'REGISTER_SLUG', 'REPOSITORY', 'ROLE', 'TOKEN']);
    expect(env.APP_SLUG).toBe('${{ steps.app-token.outputs.app-slug }}');
    expect(env.INSTALLATION_ID).toBe('${{ steps.app-token.outputs.installation-id }}');
    expect(env.REGISTER_SLUG).toBe('${{ matrix.app.slug }}');
  });

  it('never persists a checkout credential', () => {
    for (const job of Object.values(wf.jobs)) {
      for (const s of job.steps.filter((x) => x.uses?.startsWith('actions/checkout@'))) expect(s.with?.['persist-credentials']).toBe(false);
    }
  });
});
