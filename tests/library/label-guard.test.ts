import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEDGER, liveCohortDrift } from '../../scripts/label-guard.mjs';
import { LABEL } from '../../scripts/lib/capability-watch.mjs';
import { ROOT } from './helpers/adopter.js';
import { writeStub } from '../unit/helpers/stub-bin.js';

/**
 * kanon#1694: the capability ledger exists only where the adoption record turns the capability
 * watch on, which is off by default (`K-LAYOUT-17`, `K-LAYOUT-10`). The label guard's check 3, the
 * cohort's drift from the ledger's `open #N` rows, read the ledger on every run, so an adopter that
 * kept the default exited 2 every time, blamed on the token. `lane-check` and `kanon doctor` skip
 * a missing ledger where the watch isn't on, and hold it as needed where it is or the choice is
 * malformed; the guard agrees with them.
 */
const RECORD = (choices: string[]) => ['# Adoption record', '', '## Choices', '', ...choices, ''].join('\n');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A checkout with only the files given, by path. */
const checkout = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'label-guard-ledger-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

const noGh = () => {
  throw new Error('gh was called');
};

describe('check 3 without a capability ledger (kanon#1694)', () => {
  it("is skipped, saying so, where the adoption record doesn't exist", () => {
    const drift = liveCohortDrift('owner/repo', checkout({}), noGh);
    expect(drift).toEqual({ skipped: expect.stringMatching(/capability-ledger\.md doesn't exist.*capability watch isn't on/) });
  });

  it("is skipped where the record doesn't declare the watch, or declares it off", () => {
    for (const choices of [[], [`- **${LABEL}:** \`off\``]]) {
      const drift = liveCohortDrift('owner/repo', checkout({ 'docs/qa/adoption.md': RECORD(choices) }), noGh);
      expect(drift).toEqual({ skipped: expect.any(String) });
    }
  });

  it('is a missing ledger, never a token problem, where the watch is on', () => {
    const drift = liveCohortDrift('owner/repo', checkout({ 'docs/qa/adoption.md': RECORD([`- **${LABEL}:** \`on\``]) }), noGh);
    expect(drift).toEqual({ missing: expect.stringMatching(/capability-ledger\.md is missing, but docs\/qa\/adoption\.md turns the capability watch on/) });
    expect(JSON.stringify(drift)).not.toMatch(/token|issues: read/);
  });

  it('holds the ledger as needed where the choice is malformed, and names the declaration', () => {
    const drift = liveCohortDrift('owner/repo', checkout({ 'docs/qa/adoption.md': RECORD([`- **${LABEL}:** \`maybe\``]) }), noGh);
    expect(drift).toEqual({ missing: expect.stringMatching(/capability-ledger\.md is missing.*`maybe`/) });
  });

  it('still compares the rows with the label where the ledger exists, whatever the watch', () => {
    const root = checkout({ [LEDGER]: '| Capability | Disposition |\n|---|---|\n| x | open #7 |\n' });
    const run = (args: string[]) => (args[1] === 'list' ? [] : { state: 'OPEN' });
    expect(liveCohortDrift('owner/repo', root, run)).toEqual({ undercount: [7], closed: [], unrowed: [], unresolved: [] });
  });
});

describe("the guard's exit code without a capability ledger (kanon#1694)", () => {
  const script = join(ROOT, 'scripts/label-guard.mjs');

  /** Runs the guard in `root`, with a `gh` that answers every read with nothing. */
  const runGuard = (root: string) => {
    const bin = mkdtempSync(join(tmpdir(), 'label-guard-bin-'));
    dirs.push(bin);
    writeStub(join(bin, 'gh'), '#!/usr/bin/env bash\necho "[]"\n');
    const r = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo' },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('comes from the other checks alone where the watch is off', () => {
    const r = runGuard(checkout({}));
    expect(r.out).toMatch(/capability-ledger\.md doesn't exist/);
    expect(r.out).not.toMatch(/issues: read/);
    expect(r.status, r.out).toBe(0);
  });

  it('fails, naming the missing ledger rather than the token, where the watch is on', () => {
    const r = runGuard(checkout({ 'docs/qa/adoption.md': RECORD([`- **${LABEL}:** \`on\``]) }));
    expect(r.out).toMatch(/capability-ledger\.md is missing/);
    expect(r.out).not.toMatch(/issues: read/);
    expect(r.status, r.out).toBe(1);
  });
});
