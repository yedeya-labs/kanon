import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchPath } from '../../scripts/lib/branch-path.mjs';
import { branchPath as verifiedBranchPath } from '../../scripts/lib/verified-commits.mjs';

/**
 * kanon#1432: a REST path built from a branch name sends the whole name, so a `#` (the URL's
 * fragment) or a `%` (an escape GitHub decodes) can't make it name another ref. One encoder,
 * `scripts/lib/branch-path.mjs`, serves the JavaScript callers and, as a CLI, the lanes' shell.
 */

const SCRIPT = join(process.cwd(), 'scripts/lib/branch-path.mjs');
const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const CASES: Array<[string, string]> = [
  ['main', 'main'],
  ['main#x', 'main%23x'],
  ['feat/a%2fb', 'feat/a%252fb'],
  ['rel/1.0', 'rel/1.0'],
  ['a b/c?d', 'a%20b/c%3Fd'],
];

describe('branchPath (kanon#1432)', () => {
  it.each(CASES)('encodes each segment of %j and keeps its slashes', (name, path) => {
    expect(branchPath(name)).toBe(path);
  });

  it('is the one the verified-commit helper uses', () => {
    expect(verifiedBranchPath).toBe(branchPath);
  });

  it.each(CASES)('prints the same path for %j from the command line', (name, path) => {
    const r = cli(name);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(path);
  });

  it('refuses a call without exactly one name, rather than printing an empty path', () => {
    for (const args of [[], [''], ['a', 'b']]) {
      const r = cli(...args);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/usage/i);
    }
  });
});

describe('the revise lanes send their compare base through it (kanon#1432)', () => {
  it.each(['agent-implement-revise.yml', 'agent-lead-revise.yml'])('%s', (file) => {
    const text = readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8');
    const compares = text.split('\n').filter((l) => l.includes('/compare/'));
    expect(compares).toHaveLength(1);
    expect(compares[0]).toContain('compare/$(node "$KANON/scripts/lib/branch-path.mjs" "$BASE_REF")...$sha');
  });
});
