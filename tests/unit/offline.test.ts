import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
      expect(process.env[name], name).toBeUndefined();
    }
  });
});
