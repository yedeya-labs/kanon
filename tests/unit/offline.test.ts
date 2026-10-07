import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SPAWNS } from './helpers/spawns.js';
import { writeStub } from './helpers/stub-bin.js';

/**
 * #524: a case that forgets to stub `gh` or `aws` must fail at once, offline, and say
 * why, rather than reach GitHub or AWS with the credentials of whoever runs the suite.
 * The test workers see what tests/unit/helpers/offline.ts set up before they started.
 */
describe('the real gh and aws are unreachable from the test suite (#524)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'offline-test-'));
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  for (const tool of ['gh', 'aws']) {
    it(`an unstubbed ${tool} fails at once, offline, and names the cause and the fix`, () => {
      const started = Date.now();
      const r = spawnSync(tool, ['api', 'user'], { encoding: 'utf8', timeout: 10_000 });
      expect(r.error).toBeUndefined();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`the real ${tool} is unreachable from the test suite`);
      expect(r.stderr).toContain(`${tool} api user`);
      expect(r.stderr).toContain('writeStub');
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }

  it('the trap stands for gh through execFileSync, as the library calls it', () => {
    expect(() => execFileSync('gh', ['run', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      .toThrow(/the real gh is unreachable from the test suite/);
  });

  it('a stub put first on PATH still wins over the trap', () => {
    writeStub(join(bin, 'gh'), '#!/usr/bin/env bash\necho "stub gh $*"\n');
    const r = spawnSync('gh', ['pr', 'view'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('stub gh pr view\n');
  });

  // The backstop, for a case that builds its own PATH without the trap: a real gh finds no
  // token and no stored login, so it stops at "gh auth login" before any request.
  it('no gh or GitHub token reaches a test, and gh reads a config directory with no login', () => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(process.env[name], name).toBeUndefined();
    }
    const config = process.env.GH_CONFIG_DIR;
    expect(config).toBeTruthy();
    expect(readdirSync(config!)).not.toContain('hosts.yml');
  });

  it('no AWS credential reaches a test', () => {
    for (const name of [
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE',
      'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_BEARER_TOKEN_BEDROCK',
    ]) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  // #534: as gh reads a config directory with no login, aws reads config and credentials
  // files that don't exist rather than ~/.aws, and asks no instance metadata service.
  it('aws reads no shared config or credentials file, and asks no instance metadata', () => {
    for (const name of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
      const path = process.env[name];
      expect(path, name).toBeTruthy();
      expect(existsSync(path!), `${name}=${path}`).toBe(false);
    }
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });

  // The real aws, reached through a PATH without the trap, with a [default] profile in
  // ~/.aws as a developer's machine has: it must find no credentials. Skipped where no
  // real aws is installed, or one too old to have export-credentials (v1, early v2); CI's
  // runners have a current one. It starts the CLI's bundled Python, so it takes the spawn
  // budget (#436).
  const outside = (process.env.PATH ?? '').split(delimiter).filter((d) => !d.includes('kanon-test-offline-'));
  const realAws = outside.map((d) => join(d, 'aws')).find((p) => existsSync(p));
  it.skipIf(!realAws)('a real aws, outside the trap, finds no credentials in a ~/.aws default profile', SPAWNS, (ctx) => {
    const home = join(bin, 'home');
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'credentials'),
      '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n');
    writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = us-east-1\n');
    // export-credentials resolves the credential chain locally and sends no request.
    const r = spawnSync(realAws!, ['configure', 'export-credentials', '--format', 'env'], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home, PATH: outside.join(delimiter) },
    });
    expect(r.error).toBeUndefined();
    if (/invalid choice/i.test(r.stderr)) ctx.skip(`${realAws} has no \`aws configure export-credentials\``);
    expect(r.stdout).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no credentials found|Unable to locate credentials/i);
  });
});
