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

// #1645's review: the docs that list what init writes name the locked set, and doctor's sentence
// beside it is about the brief template, which is what doctor reads.
describe('the docs on the locked set init writes (#1644)', () => {
  it('lists it in docs/install.md, and keeps docs/init.md\'s doctor sentence about the template', () => {
    expect(read('.', 'docs/install.md')).toContain('and the empty locked set, `docs/qa/specs/_locked-floor.json`, unless you have one (`K-LAYOUT-4`)');
    const init = read('.', 'docs/init.md');
    expect(init).toContain('Without a brief template, [`kanon doctor`](doctor.md) reports `lead.template-missing`');
    expect(init).not.toMatch(/locked set the repository has is the project's, `kept` too\. Without one, `kanon-spec-coverage` exits 1[^.]*\. Without one, \[`kanon doctor`\]/);
  });
});
