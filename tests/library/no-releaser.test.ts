import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADOPTER, ROOT } from './helpers/adopter.js';
import { SPAWNS } from '../unit/helpers/spawns.js';

/**
 * kanon#1558 (point 13 of #1551): an install with no Releaser by choice. `kanon init` offers the
 * Releaser only to a repository that calls Kanon's release workflow, so its register has no
 * Releaser row, and the sweep's `botLogins()` needed all six rows: the sweep and the reconciler
 * stopped on `lists no Releaser App` first thing in `main()`.
 *
 * The Releaser's App is the one `rulebook/agent-permissions.json` marks `optional`, so a register
 * without its row has no Releaser App, and no comment can be its. Leaving its login out lets no
 * person's comment pass as an App's (the set only loses a login nobody comments as), and reads no
 * App's comment as a person's. Every other role's row is still required, by name.
 *
 * Each case runs in a process of its own, in a temp copy of the fixture adopter, because the
 * register is read from the working directory and cached per process.
 */
const REGISTER = 'docs/qa/agent-identities.md';
const full = readFileSync(join(ADOPTER, REGISTER), 'utf8');

/** The fixture adopter, its register without the rows `dropped` matches. */
const adopter = (dropped: RegExp) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-1558-'));
  cpSync(ADOPTER, dir, { recursive: true });
  writeFileSync(join(dir, REGISTER), full.split('\n').filter((l) => !dropped.test(l)).join('\n'));
  return dir;
};
const NO_RELEASER = /^\| Releaser \|/;
const env = () => {
  const e = { ...process.env };
  delete e.GITHUB_REPOSITORY;
  return e;
};
const sweep = pathToFileURL(join(ROOT, 'scripts/dispatch-sweep.mjs')).href;
const run = (dir: string, code: string) =>
  spawnSync('node', ['--input-type=module', '-e', code], { cwd: dir, env: env(), encoding: 'utf8', timeout: 20_000 });

describe('kanon#1558 — an install with no Releaser runs the sweep, the reconciler and the brief guard', SPAWNS, () => {
  it('runs the sweep and the reconciler past their App logins on a register with no Releaser row', () => {
    const dir = adopter(NO_RELEASER);
    try {
      for (const script of ['dispatch-sweep.mjs', 'lead-reconcile.mjs']) {
        const r = spawnSync('node', [join(ROOT, 'scripts', script)], { cwd: dir, env: env(), encoding: 'utf8', timeout: 20_000 });
        expect(r.stderr, script).not.toContain('lists no');
        // The first check after the logins: they were read, and nothing threw.
        expect(r.stderr, script).toContain('GITHUB_REPOSITORY must be set');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads every listed App as an App, a person as a person, and the absent Releaser as no login at all', () => {
    const dir = adopter(NO_RELEASER);
    try {
      const r = run(dir, `const { botLogins, isBot } = await import(${JSON.stringify(sweep)});
console.log(JSON.stringify({ set: [...botLogins()].sort(), person: isBot('a-maintainer'), releaser: isBot('example-releaser'), author: isBot('example-implementer[bot]'), judge: isBot('example-reviewer') }));`);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const got = JSON.parse(r.stdout);
      expect(got.set).toEqual(['dependabot', 'example-explorer', 'example-implementer', 'example-lead', 'example-overseer', 'example-reviewer', 'github-actions']);
      expect(got.person, 'a person is never read as an App').toBe(false);
      expect(got.releaser, 'no row, no App: nothing to match').toBe(false);
      expect(got.author).toBe(true);
      expect(got.judge).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still reads a listed Releaser as an App', () => {
    const r = run(ADOPTER, `const { isBot } = await import(${JSON.stringify(sweep)}); console.log(isBot('example-releaser[bot]'));`);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('true');
  });

  it.each(['Implementer', 'Lead', 'Reviewer', 'Explorer', 'Overseer'])('still stops on a missing %s row, by name: its App is not optional', (role) => {
    const dir = adopter(new RegExp(`^\\| \\**${role}\\** \\|`));
    try {
      const r = run(dir, `const { botLogins } = await import(${JSON.stringify(sweep)}); botLogins();`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`lists no ${role} App`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the brief guard on a register with no Releaser row', () => {
    const dir = adopter(NO_RELEASER);
    try {
      // Kanon's template is a brief that meets the guard; the guard reads the briefs the git index holds.
      cpSync(join(ROOT, 'docs/projects/_template.md'), join(dir, 'docs/projects/1.md'));
      rmSync(join(dir, 'docs/qa/exemptions.md'));
      for (const args of [['init', '-q'], ['add', '-A']]) spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      const r = spawnSync('node', [join(ROOT, 'scripts/brief-guard.mjs')], {
        cwd: dir,
        env: { ...env(), BRIEF_GUARD_SKIP_TRACKING_ISSUES: '1' },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(`${r.stdout}${r.stderr}`).not.toContain('lists no');
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
