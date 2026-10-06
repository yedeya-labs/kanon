import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { parse, stringify } from 'yaml';

/**
 * `actions/lane-check` (plan 0001 §6): the permanent rules for an adopter's lane callers.
 *
 * Every case runs the real script, against a copy of the fixture adopter
 * (`tests/fixtures/lane-check/adopter`, the shape an adopter copies) with ONE thing broken,
 * and reads Kanon's real lane files from this tree, as the action reads them from the tag
 * an adopter pinned. The first case (in `tests/unit/lane-check.test.ts`) is the fixture
 * passing whole, so every red is the one change it makes.
 *
 * The cases are split by area across `tests/unit/lane-check*.test.ts` (kanon#381): vitest runs
 * one file's cases serially, and at about a second a case one file of them all was the whole
 * suite's wall-clock. They share this file's helpers and its one `lane-check` block, so every
 * case keeps its full name.
 *
 * `yq` (mikefarah v4) is on GitHub's hosted runners, so CI always runs these. A machine
 * without it skips them, and says so; CI never does (decision 6).
 */
export const ROOT = process.cwd();
export const FIXTURE = join(ROOT, 'tests/fixtures/lane-check/adopter');
export const SCRIPT = join(ROOT, 'actions/lane-check/lane-check.sh');
export const hasYq = spawnSync('yq', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasYq && process.env.CI) throw new Error('lane-check tests need yq on PATH in CI');

export type Tree = { dir: string; edit: (rel: string, fn: (doc: Record<string, unknown>) => void) => void; write: (rel: string, body: string) => void; read: (rel: string) => string; rm: (rel: string) => void };

export const adopter = (): Tree => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-check-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');
  const write = (rel: string, body: string) => writeFileSync(join(dir, rel), body);
  return {
    dir,
    read,
    write,
    rm: (rel) => rmSync(join(dir, rel), { recursive: true, force: true }),
    edit: (rel, fn) => {
      const doc = parse(read(rel)) as Record<string, unknown>;
      fn(doc);
      write(rel, stringify(doc));
    },
  };
};

export const check = (tree: Tree, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [SCRIPT], { cwd: tree.dir, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '', ...env } });
  rmSync(tree.dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/** Run with one change, and expect exactly a red naming `message`. */
export const red = (change: (t: Tree) => void, message: string | RegExp, env: Record<string, string> = {}) => {
  const t = adopter();
  change(t);
  const r = check(t, env);
  expect(r.status, r.out).toBe(1);
  expect(r.out).toMatch(typeof message === 'string' ? new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : message);
  return r;
};

/** Run with one change, and expect it to pass, taking the documented default `message` names (plan 0005 §5.2). */
export const defaulted = (change: (t: Tree) => void, message: string | RegExp) => {
  const t = adopter();
  change(t);
  const r = check(t);
  expect(r.status, r.out).toBe(0);
  expect(r.out).toMatch(typeof message === 'string' ? new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : message);
  return r;
};

export const TRIAGE = '.github/workflows/agent-triage.yml';
export const IMPL = '.github/workflows/agent-implement-revise.yml';
export const REGISTER = 'docs/qa/agent-identities.md';
export type Caller = { on?: unknown; concurrency?: unknown; env?: unknown; permissions?: Record<string, string>; jobs: Record<string, Record<string, unknown>> };
export const job = (doc: Record<string, unknown>) => Object.values((doc as Caller).jobs)[0]!;

/**
 * The one `lane-check` block every split file's cases sit in, so their names are unchanged.
 *
 * Each case spawns lane-check (bash, yq, jq and one Node process) on a fixture tree, about a
 * second alone. Under a loaded full `npm test` single cases outlasted the 5s default (seen on
 * the L4 branch twice, on different cases), so the whole block gets 20s.
 */
export const laneCheck = (cases: () => void) => describe.skipIf(!hasYq)('lane-check', { timeout: 20_000 }, cases);
