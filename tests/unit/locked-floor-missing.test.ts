import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LockedSetError, readLockedSet, serialiseLockedSet } from '../../scripts/locked-set.mjs';

/**
 * kanon#1644: `kanon-spec-coverage` on a repository with spec areas and no locked set yet. A missing
 * floor is NOT read as empty, since the floor is a reviewed ratchet; it stops with one line that
 * names the file and the command that writes it, as a malformed one does, and `--write-locked`
 * works without it. Each case copies the Python adopter fixture into a temporary git repository.
 */
const ROOT = process.cwd();
const FLOOR = 'docs/qa/specs/_locked-floor.json';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const checkout = (change: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-locked-floor-'));
  dirs.push(dir);
  cpSync(join(ROOT, 'tests/fixtures/python-adopter'), dir, { recursive: true });
  change(dir);
  for (const args of [['init', '-q'], ['add', '-A']]) spawnSync('git', args, { cwd: dir });
  return dir;
};
const coverage = (dir: string, ...args: string[]) => {
  const r = spawnSync('node', [join(ROOT, 'scripts/spec-coverage.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: dir } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
/** No stack trace: no frame line, no `Error:` banner. */
const plain = (out: string) => !/^\s+at /m.test(out) && !/\bLockedSetError\b|^Error:/m.test(out);

describe('kanon-spec-coverage without a locked set (kanon#1644)', () => {
  it('stops with exit 1 and one line that names the file and the command that writes it', () => {
    const dir = checkout((d) => rmSync(join(d, FLOOR)));
    for (const args of [['--quiet'], []]) {
      const r = coverage(dir, ...args);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain(`spec-coverage: ${FLOOR} is missing. Create it with \`kanon-spec-coverage --write-locked\``);
      expect(r.out).toContain('and commit it');
      expect(plain(r.out), r.out).toBe(true);
    }
  });

  it('says as plainly that a malformed file is not the locked set', () => {
    for (const text of ['{ "locked": [', '{ "floor": 3 }', '{ "locked": [1, 2] }']) {
      const r = coverage(checkout((d) => writeFileSync(join(d, FLOOR), text)), '--quiet');
      expect(r.status, text).toBe(1);
      expect(r.out).toContain(`spec-coverage: ${FLOOR} is not the locked set`);
      expect(plain(r.out), r.out).toBe(true);
    }
  });

  it('writes the locked set with --write-locked when there is none, and is green after', () => {
    const dir = checkout((d) => rmSync(join(d, FLOOR)));
    const w = coverage(dir, '--write-locked');
    expect(w.status, w.out).toBe(0);
    expect(readFileSync(join(dir, FLOOR), 'utf8')).toBe(serialiseLockedSet(['ORD-1']));
    expect(coverage(dir, '--quiet').status).toBe(0);
  });

  it('reads a well-formed set, and throws its own error on the others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanon-locked-read-'));
    dirs.push(dir);
    const at = join(dir, 'floor.json');
    writeFileSync(at, serialiseLockedSet(['A-2', 'A-1']));
    expect(readLockedSet(at)).toEqual(['A-1', 'A-2']);
    expect(() => readLockedSet(join(dir, 'none.json'))).toThrow(LockedSetError);
    writeFileSync(at, 'nope');
    expect(() => readLockedSet(at)).toThrow(LockedSetError);
  });
});
