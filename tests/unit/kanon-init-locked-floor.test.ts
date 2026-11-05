import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { serialiseLockedSet } from '../../scripts/locked-set.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { checkout, fakeGitHub, parse, read, run } from './helpers/kanon-init.js';

// Each case runs `kanon init` against a real git checkout (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

/**
 * kanon#1644: the Lead runs kanon-spec-coverage, which stops on a missing locked set, so `init`
 * writes the empty one (K-LAYOUT-4) wherever it writes the Lead's brief template, and never
 * overwrites one the project has.
 */
const FLOOR = 'docs/qa/specs/_locked-floor.json';
const init = async (lanes: string, files: Record<string, string> = {}) => {
  const dir = checkout(files);
  const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--lanes', lanes]));
  return { dir, d, status: d.files.find((f) => f.path === FLOOR)?.status };
};

describe('kanon init and the locked set (kanon#1644)', () => {
  it("writes the empty locked set, as the coverage tool writes it, beside the Lead's brief template", async () => {
    const { dir, status } = await init('review,lead');
    expect(status).toBe('new');
    expect(read(dir, FLOOR)).toBe(serialiseLockedSet([]));
    expect(read(dir, FLOOR)).toBe('{\n  "locked": []\n}\n');
  });

  it('leaves a locked set the project has alone', async () => {
    const own = serialiseLockedSet(['ORD-1', 'ORD-3']);
    const { dir, status } = await init('review,lead', { [FLOOR]: own });
    expect(status).toBe('kept');
    expect(read(dir, FLOOR)).toBe(own);
  });

  it('writes none without a Lead lane', async () => {
    const { dir, status } = await init('review');
    expect(status).toBeUndefined();
    expect(existsSync(join(dir, FLOOR))).toBe(false);
  });
});
