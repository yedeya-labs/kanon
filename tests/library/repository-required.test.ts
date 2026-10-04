import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';

/**
 * Plan 0001, step 3: the scripts a lane runs name the repository they act on from
 * `GITHUB_REPOSITORY`, which the runner always sets, and never fall back to one. In the
 * reference adopter they defaulted to its own repository, so a script run by hand without
 * the variable acted there; in Kanon a default would name somebody else's repository.
 */
const CLIS: Array<[string, string[]]> = [
  ['brief-revise-recovery', []],
  ['capability-interlock', []],
  ['digest-audience', []],
  ['dispatch-sweep', []],
  ['implement-crash', []],
  ['lane-gate', []],
  ['lead-reconcile', ['--project', '1']],
  ['merge-gate', []],
  ['overseer-file', []],
  ['rebase-lane', []],
  ['red-unreviewed', []],
  ['review-recovery', []],
  ['split-lineage', ['gate']],
  ['starting-map', ['--issue', '1']],
  ['workflow-health', []],
];

describe('every lane script requires GITHUB_REPOSITORY', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GITHUB_REPOSITORY' && k !== 'GH_TOKEN'));
  it.each(CLIS)('%s refuses to run without it, before it reads anything', (name, args) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', `${name}.mjs`), ...args], { encoding: 'utf8', env, timeout: 20_000 });
    expect(r.stderr).toContain(`${name}: GITHUB_REPOSITORY must be set`);
    expect(r.status).toBe(2);
  });

  it('no library script names a repository to fall back to', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const hits = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'))
      .filter((f) => /GITHUB_REPOSITORY\s*(\|\||\?\?)\s*['"`]/.test(readFileSync(join(ROOT, 'scripts', f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
