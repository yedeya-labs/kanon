import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemasAt, widenings } from '../../infra/telemetry/intake-first.mjs';
import { SCHEMAS } from '../../actions/agent-telemetry/schema.mjs';
import { SCRUB_VERSION } from '../../actions/agent-telemetry/scrub.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * Intake first (kanon#794): a release whose lanes can write a row the deployed ingest function
 * refuses needs intake deployed from it before it reaches adopters. `intake-first.mjs` compares
 * the schema at the release intake was deployed from with the release's own, and names every
 * row the release's schema accepts that the deployed one doesn't.
 */

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'infra/telemetry/intake-first.mjs');

type Field = Record<string, unknown> & { type: string };
type Schemas = Record<string, Record<number, Record<string, Field>>>;

/** A deep, unfrozen copy of the real schemas, with RegExps kept, for a case to change. */
function copy(s: Schemas = SCHEMAS as unknown as Schemas): Schemas {
  return Object.fromEntries(Object.entries(s).map(([kind, versions]) => [kind, Object.fromEntries(
    Object.entries(versions).map(([v, fields]) => [v, Object.fromEntries(
      Object.entries(fields).map(([name, f]) => [name, { ...f }]))]))]));
}

describe('widenings: what the release accepts that the deployed intake refuses', () => {
  it('names nothing when the schemas are the same', () => {
    expect(widenings(copy(), copy())).toEqual([]);
  });

  it('names a raised scrub_version, which an older intake refuses as range (kanon#724)', () => {
    const before = copy();
    before.finding![1]!.scrub_version!.max = SCRUB_VERSION - 1;
    expect(widenings(before, copy())).toEqual([
      `finding v1 scrub_version: accepts up to ${SCRUB_VERSION}, the deployed intake up to ${SCRUB_VERSION - 1}`,
    ]);
  });

  it('names a row version and a row kind the deployed intake does not know', () => {
    const before = copy();
    delete before.run![3];
    delete before.finding;
    expect(widenings(before, copy())).toEqual([
      'run v3: a version the deployed intake does not know',
      'finding: a row kind the deployed intake does not know',
    ]);
  });

  it('names an enum value and a list value the deployed intake does not know', () => {
    const before = copy();
    const lane = before.run![2]!.lane!;
    lane.values = (lane.values as string[]).filter((l) => l !== 'explore-telemetry');
    const guards = before.work_item![1]!.guard_failures!;
    guards.values = (guards.values as string[]).slice(1);
    const dropped = (copy().work_item![1]!.guard_failures!.values as string[])[0];
    expect(widenings(before, copy())).toContain('run v2 lane: accepts explore-telemetry, which the deployed intake does not');
    expect(widenings(before, copy())).toContain(`work_item v1 guard_failures: accepts ${dropped}, which the deployed intake does not`);
  });

  it('names a new field, a field made optional, and a required field the release drops', () => {
    const before = copy();
    const after = copy();
    delete before.run![2]!.reason;
    after.run![2]!.role = { ...after.run![2]!.role!, required: false };
    delete after.run![2]!.tag;
    expect(widenings(before, after)).toEqual([
      'run v2 role: optional, where the deployed intake requires it',
      'run v2 reason: a field the deployed intake does not know',
      'run v2 tag: no longer in the schema, where the deployed intake requires it',
    ]);
  });

  it('names a raised bound, a longer text, and a changed pattern or type', () => {
    const before = copy();
    before.run![2]!.run_attempt = { ...before.run![2]!.run_attempt!, max: 9 };
    before.finding![1]!.evidence = { ...before.finding![1]!.evidence!, max: 100 };
    before.finding![1]!.scrub_version = { ...before.finding![1]!.scrub_version!, min: 2, max: SCRUB_VERSION };
    before.run![2]!.kanon_version = { type: 'pattern', re: /^\d+\.\d+\.\d+$/ };
    before.run![2]!.recorded_at = { type: 'bool', required: true };
    const found = widenings(before, copy());
    expect(found).toEqual(expect.arrayContaining([
      'run v2 recorded_at: a time, where the deployed intake has a bool',
      'run v2 run_attempt: accepts up to 2147483647, the deployed intake up to 9',
      'run v2 kanon_version: its pattern differs from the deployed intake\'s',
      'finding v1 evidence: accepts up to 2000 characters, the deployed intake up to 100',
      'finding v1 scrub_version: accepts from 1, the deployed intake from 2',
    ]));
    expect(found).toHaveLength(5);
  });

  it('names nothing for a narrowing, which deploying first does not help', () => {
    const before = copy();
    const after = copy();
    const lane = after.run![2]!.lane!;
    lane.values = (lane.values as string[]).slice(1);
    after.finding![1]!.evidence = { ...after.finding![1]!.evidence!, max: 10 };
    after.run![2]!.trigger = { ...after.run![2]!.trigger!, required: true };
    expect(widenings(before, after)).toEqual([]);
  });
});

/** A scratch repository holding the telemetry action's modules, committed twice. */
function scratch(): { dir: string, git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'intake-first-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const src = join(ROOT, 'actions/agent-telemetry');
  mkdirSync(join(dir, 'actions/agent-telemetry'), { recursive: true });
  for (const f of readdirSync(src).filter((n) => n.endsWith('.mjs'))) copyFileSync(join(src, f), join(dir, 'actions/agent-telemetry', f));
  git('add', '-A');
  git('commit', '-q', '-m', 'deployed');
  git('tag', 'v1.0.0');
  return { dir, git };
}

const run = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 20_000 });

describe('intake-first.mjs, against a repository', SPAWNS, () => {
  it('reads a ref\'s schemas from git, not from the checkout', async () => {
    const { dir, git } = scratch();
    const scrub = join(dir, 'actions/agent-telemetry/scrub.mjs');
    writeFileSync(scrub, readFileSync(scrub, 'utf8').replace(/export const SCRUB_VERSION = \d+;/, `export const SCRUB_VERSION = ${SCRUB_VERSION + 1};`));
    git('commit', '-q', '-am', 'raise');
    const at = await schemasAt('v1.0.0', { cwd: dir });
    const head = await schemasAt('HEAD', { cwd: dir });
    expect(at.finding![1]!.scrub_version!.max).toBe(SCRUB_VERSION);
    expect(head.finding![1]!.scrub_version!.max).toBe(SCRUB_VERSION + 1);
  });

  it('exits 1 naming a raised SCRUB_VERSION, and tells the Owner to deploy intake first', () => {
    const { dir, git } = scratch();
    const scrub = join(dir, 'actions/agent-telemetry/scrub.mjs');
    writeFileSync(scrub, readFileSync(scrub, 'utf8').replace(/export const SCRUB_VERSION = \d+;/, `export const SCRUB_VERSION = ${SCRUB_VERSION + 1};`));
    git('commit', '-q', '-am', 'raise');
    const r = run(dir, '--deployed', 'v1.0.0');
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain(`finding v1 scrub_version: accepts up to ${SCRUB_VERSION + 1}, the deployed intake up to ${SCRUB_VERSION}`);
    expect(r.stdout).toMatch(/deploy intake from this release.*before/i);
  });

  it('exits 0 when the release writes nothing the deployed intake refuses', () => {
    const { dir, git } = scratch();
    writeFileSync(join(dir, 'actions/agent-telemetry/extra.mjs'), 'export const X = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'unrelated');
    const r = run(dir, '--deployed', 'v1.0.0', '--release', 'HEAD');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/intake deployed from v1\.0\.0 accepts every row/i);
  });

  it('exits 2 on an unknown ref or a missing --deployed, rather than passing', () => {
    const { dir } = scratch();
    expect(run(dir, '--deployed', 'v9.9.9').status).toBe(2);
    expect(run(dir).status).toBe(2);
  });
});
