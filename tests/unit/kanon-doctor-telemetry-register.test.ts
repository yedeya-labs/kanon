import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { doctor, EXIT, FINDINGS } from '../../cli/doctor.mjs';
import { render } from '../../infra/telemetry/render.mjs';
import { checkout, fakeGitHub, healthyFiles, ids, PINNED, put, REPO, REQ, ROOT, run } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `telemetry.register-tracked` (#1071): a telemetry register, or what `render.mjs` makes from
 * one, tracked in the repository doctor checks, which is one where Kanon's lanes run.
 * docs/telemetry.md ("Where the register lives") forbids that, public or private: the Reviewer
 * reads any diff that touches it, and every agent reads the checkout. Doctor recognises the file
 * by its shape, never its name, exempts a register whose owner ARN is still a `<…>` placeholder
 * (Kanon's own `register.example.json`), and names only the path: never a key or a repository.
 *
 * The guard can fail: with the check removed from cli/doctor.mjs, the first case finds nothing
 * and turns red.
 */
vi.setConfig({ testTimeout: SPAWNS.timeout });

const KEYS = ['f00dfeed1', 'c0ffee042'];
const REPOS = ['acme/payments-service', 'acme/billing-ledger'];
const ARN = `arn:aws:iam::${'4'.repeat(12)}:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_Admin_0123456789abcdef`;
const register = {
  owner_principal_arn: ARN,
  create_oidc_provider: false,
  reserved_concurrency: 0,
  repositories: KEYS.map((key, i) => ({ key, repository: REPOS[i]!, readers: ['ref:refs/heads/main'] })),
};
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const example = readFileSync(join(ROOT, 'infra/telemetry/register.example.json'), 'utf8');
const LIVES = 'docs/telemetry.md#where-the-register-lives';

/** Nothing doctor prints, in either mode, holds a key or a repository from the file. */
const leaks = (text: string) => [...KEYS, ...REPOS].filter((s) => text.includes(s));

describe('kanon doctor on a telemetry register tracked in the checkout (#1071)', () => {
  it('blocks on a tracked register, whatever its name, names only its path, and points to "Where the register lives"', async () => {
    const files = healthyFiles();
    files['ops/state/accounts.json'] = json(register);
    const dir = checkout(files);
    const github = fakeGitHub();
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['telemetry.register-tracked ops/state/accounts.json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    const f = r.json.findings[0];
    expect(f.blocking).toBe(true);
    expect(FINDINGS['telemetry.register-tracked']).toEqual({ category: 'secret', blocking: true });
    expect(f.message).toContain('telemetry register');
    expect(f.fix.url).toContain(LIVES);
    expect(f.fix.commands).toEqual(["git rm --cached -- 'ops/state/accounts.json'", "printf '\\n%s\\n' '/ops/state/accounts.json' >> .gitignore"]);
    expect(leaks(r.out)).toEqual([]);
    const prose = await run(dir, github);
    expect(prose.out).toContain('ops/state/accounts.json');
    expect(leaks(prose.out + prose.err)).toEqual([]);
  });

  it("leaves the .gitignore's last rule whole when the fix's commands run on one with no final newline", async () => {
    const files = healthyFiles();
    files['ops/state/accounts.json'] = json(register);
    files['.gitignore'] = '.env';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    for (const command of r.json.findings[0].fix.commands) {
      const ran = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
      expect(ran.status, ran.stderr).toBe(0);
    }
    const ignored = spawnSync('git', ['-C', dir, 'check-ignore', '--no-index', '--', '.env', 'ops/state/accounts.json'], { encoding: 'utf8' });
    expect(ignored.stdout.split('\n').filter(Boolean)).toEqual(['.env', 'ops/state/accounts.json']);
  });

  it("does not flag Kanon's register.example.json, whose owner ARN is still a placeholder", async () => {
    const files = healthyFiles();
    files['infra/telemetry/register.example.json'] = example;
    const r = await run(checkout(files), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
  });

  it('does not flag a file that only resembles the shape, nor a register that is not tracked', async () => {
    const files = healthyFiles();
    // No `repositories[].key`.
    files['config/a.json'] = json({ ...register, repositories: register.repositories.map(({ repository }) => ({ repository })) });
    // No `repositories[].repository`.
    files['config/b.json'] = json({ ...register, repositories: register.repositories.map(({ key }) => ({ key })) });
    // No `owner_principal_arn`.
    files['config/c.json'] = json({ repositories: register.repositories });
    // Not a JSON object.
    files['config/d.json'] = json([register]);
    files['docs/notes.md'] = '# Notes\n\nThe register holds `owner_principal_arn` and `repositories`.\n';
    const dir = checkout(files);
    put(dir, { 'scratch/register.json': json(register) });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
  });

  it("blocks on render.mjs's template.json and parameters.json, tracked, and names neither a key nor a repository", async () => {
    const gh = (args: string[]) => {
      const m = /^repos\/([^/]+\/[^/]+)(\/actions\/oidc\/customization\/sub)?$/.exec(args[1] ?? '');
      if (!m) throw new Error(`gh: HTTP 404 for ${args[1]}`);
      return JSON.stringify(m[2] ? { use_default: true, use_immutable_subject: false } : { full_name: m[1], default_branch: 'main' });
    };
    const out = render(register, { gh });
    const files = healthyFiles();
    files['deploy/build/template.json'] = json(out.template);
    files['deploy/build/parameters.json'] = json(out.parameters);
    const r = await run(checkout(files), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['telemetry.register-tracked deploy/build/parameters.json', 'telemetry.register-tracked deploy/build/template.json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    for (const f of r.json.findings) {
      expect(f.message).toContain('render.mjs');
      expect(f.fix.url).toContain(LIVES);
    }
    expect(leaks(r.out)).toEqual([]);
    expect(r.out).not.toContain(out.parameters.at(-1)!.slice('CursorKey='.length));
  });

  it('lists the check as unchecked, never healthy, when git cannot search the tracked files', async () => {
    const files = healthyFiles();
    files['ops/state/accounts.json'] = json(register);
    const dir = checkout(files);
    const lines: string[] = [];
    const status = await doctor(['--dir', dir, '--json'], {
      gh: fakeGitHub().gh,
      git: (args: string[]) => {
        if (args[2] === 'grep') return { status: 128, stdout: '', stderr: 'fatal: unable to read tree' };
        const r = spawnSync('git', args, { encoding: 'utf8' });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      },
      env: {},
      out: (l: string) => lines.push(l),
      err: () => {},
      requirements: () => REQ,
      release: () => PINNED,
    });
    const doc = JSON.parse(lines.join('\n'));
    expect(doc.findings).toEqual([]);
    expect(doc.unchecked).toContainEqual({ check: 'telemetry-register', subject: REPO, reason: expect.stringContaining('fatal: unable to read tree') });
    expect(status).toBe(EXIT.incomplete);
  });
});
