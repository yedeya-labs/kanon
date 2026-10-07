import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { assign, listTestFiles, partitionProblems, readWeights } from '../../.github/scripts/test-shards.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * #407: CI's unit shards each run the files .github/scripts/test-shards.mjs gives them. A file
 * in no shard would never run, and nothing else would notice, so these hold the plan to an exact
 * partition of what vitest lists, at the shard count ci.yml's matrix uses.
 */

const SCRIPT = '.github/scripts/test-shards.mjs';
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: { unit: { strategy: { matrix: { shard: number[] } } } } };
const N = ci.jobs.unit.strategy.matrix.shard.length;
const FILES = listTestFiles();
const WEIGHTS = readWeights();

describe('the shard plan CI runs is an exact partition of the test files', () => {
  it('reads both projects from vitest', () => {
    expect(FILES.some((f) => f.startsWith('tests/unit/'))).toBe(true);
    expect(FILES.some((f) => f.startsWith('tests/library/'))).toBe(true);
    expect(FILES).toContain('tests/unit/test-shards.test.ts');
  });

  it(`puts every test file in exactly one of ${N} non-empty shards`, () => {
    const shards = assign(FILES, WEIGHTS, N);
    expect(shards).toHaveLength(N);
    expect(partitionProblems(FILES, shards)).toEqual([]);
    expect(shards.flat().sort()).toEqual([...FILES].sort());
  });

  it('prints, from the CLI CI calls, shards whose union is every test file, each once', async () => {
    const run = promisify(execFile);
    const outs = await Promise.all(
      Array.from({ length: N }, (_, i) => run(process.execPath, [SCRIPT, `${i + 1}/${N}`]).then((r) => r.stdout.split('\n').filter(Boolean))),
    );
    expect(outs.every((o) => o.length > 0)).toBe(true);
    const all = outs.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...FILES].sort());
  }, 30_000);

  // vitest reads each argument as a case-insensitive SUBSTRING of a file's path, so a file whose
  // path contained another's would also be run by the shard that holds the other.
  it('names no test file whose path is part of another\'s, so a filter selects exactly its file', () => {
    const lower = FILES.map((f) => f.toLowerCase());
    const overlaps = lower.flatMap((a, i) => lower.filter((b, j) => i !== j && b.includes(a)).map((b) => `${a} ⊂ ${b}`));
    expect(overlaps).toEqual([]);
    expect(FILES.filter((f) => /\s/.test(f))).toEqual([]);
  });
});

describe('stale weights only unbalance the shards, never drop a file', () => {
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'new.test.ts'];

  it('places a file the weights file does not know, at the median weight', () => {
    const shards = assign(files, { 'a.test.ts': 10, 'b.test.ts': 1, 'c.test.ts': 2, 'd.test.ts': 3, 'gone.test.ts': 99 }, 2);
    expect(partitionProblems(files, shards)).toEqual([]);
    // a=10 alone; then d=3, new=2.5 (the median of 1, 2, 3, 10), c=2, b=1 fill the other.
    expect(shards).toEqual([['a.test.ts'], ['b.test.ts', 'c.test.ts', 'd.test.ts', 'new.test.ts']]);
  });

  it('places every file with no weights at all, and ignores weights for files that are gone', () => {
    const shards = assign(files, { 'gone.test.ts': 5 }, 3);
    expect(partitionProblems(files, shards)).toEqual([]);
    expect(shards.map((s) => s.length).sort()).toEqual([1, 2, 2]);
  });

  it('balances longest-first into the lightest shard, the same way every time', () => {
    const weights = { 'a.test.ts': 8, 'b.test.ts': 7, 'c.test.ts': 6, 'd.test.ts': 5, 'new.test.ts': 4 };
    const shards = assign(files, weights, 2);
    expect(shards).toEqual([['a.test.ts', 'd.test.ts', 'new.test.ts'], ['b.test.ts', 'c.test.ts']]);
    expect(assign([...files].reverse(), weights, 2)).toEqual(shards);
  });

  it('refuses a shard count that would leave a shard empty, since an empty shard runs every file', () => {
    expect(() => assign(files, {}, 6)).toThrow(/empty/);
    expect(() => assign(files, {}, 0)).toThrow(/positive integer/);
  });
});

// Some of its cases run the CLI in `node`, which runs `vitest list`, so the block takes the spawn budget (#436).
describe('partitionProblems names each way a plan can lose or repeat a file', SPAWNS, () => {
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts'];

  it('a dropped file, a duplicated file, an unknown file and an empty shard', () => {
    expect(partitionProblems(files, [['a.test.ts'], ['b.test.ts']])).toEqual(['c.test.ts is in no shard, so it would never run']);
    expect(partitionProblems(files, [['a.test.ts', 'b.test.ts'], ['b.test.ts', 'c.test.ts']])).toEqual(['b.test.ts is in shard 1 and shard 2']);
    expect(partitionProblems(files, [['a.test.ts', 'b.test.ts'], ['c.test.ts', 'x.test.ts']])).toEqual(['x.test.ts is in a shard but is not a test file vitest lists']);
    expect(partitionProblems(files, [['a.test.ts', 'b.test.ts', 'c.test.ts'], []])).toEqual(['shard 2 is empty, so it would run every file']);
  });

  it('the CLI refuses a shard outside 1..N', async () => {
    const run = promisify(execFile);
    await expect(run(process.execPath, [SCRIPT, `${N + 1}/${N}`])).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/outside 1\.\./) });
    await expect(run(process.execPath, [SCRIPT, '0/4'])).rejects.toMatchObject({ code: 1 });
  });
});
