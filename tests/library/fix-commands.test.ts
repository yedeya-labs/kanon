import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { SPAWNS } from '../unit/helpers/spawns.js';
const { FIX_COMMANDS, citationShiftPaths, commandsFor, recognise } = await import('../../scripts/lib/fix-commands.mjs');
const { reviseFix, signOff } = await import('../../scripts/revise-fix.mjs');

/**
 * kanon#1173 — the checks whose failure has a known fix command, which the revise lane runs on a
 * hand-back before any model run. The command is Kanon's, looked up by key; the check's log only
 * lets the Merger recognise which key.
 */
const step = (name: string, lines: string[]) => lines.map((l) => `CI\t${name}\t2026-10-20T12:00:00Z ${l}`).join('\n');
const MOVED = 'citation-shift: 3 coordinate(s) point at lines this diff MOVED, and were left as they were:';

describe('recognise', () => {
  it("names citation-shift from its own failure line, in the job's one failed step", () => {
    expect(recognise(step('Lint', [MOVED, '##[error]Process completed with exit code 1.']))).toBe('citation-shift');
  });

  it('names nothing for a failure it does not know', () => {
    expect(recognise(step('Test', ['FAIL tests/a.test.ts', '##[error]Process completed with exit code 1.']))).toBeNull();
    expect(recognise('')).toBeNull();
  });

  it('names nothing when the job failed on two steps', () => {
    expect(recognise(`${step('Lint', [MOVED])}\n${step('Test', ['FAIL tests/a.test.ts'])}`)).toBeNull();
  });
});

describe('commandsFor', () => {
  const ctx = { kanon: '/k', base: 'abc123', workflows: [] as string[] };

  it("gives Kanon's own citation-shift command, with --fix, and the check itself to verify it", () => {
    expect(commandsFor(['citation-shift'], ctx)).toEqual({
      commands: [{
        key: 'citation-shift',
        fix: ['node', '/k/scripts/citation-shift.mjs', '--base', 'abc123', '--fix'],
        verify: ['node', '/k/scripts/citation-shift.mjs', '--base', 'abc123'],
      }],
    });
  });

  it('names a key that is not on the list, and gives no command for it', () => {
    expect(commandsFor(['citation-shift', 'rm -rf /'], ctx)).toEqual({ unknown: 'rm -rf /' });
  });

  it('passes the --path globs the project\'s CI passes the script', () => {
    const wf = [
      "      - run: node \"$KANON/scripts/citation-shift.mjs\" --path 'docs/**/*.md' \\\n          --path README.md --path \"rulebook/**/*.md\"",
      '      - run: node scripts/citation-guard.mjs --path elsewhere.md',
    ];
    expect(citationShiftPaths(wf)).toEqual(['docs/**/*.md', 'README.md', 'rulebook/**/*.md']);
    const r = commandsFor(['citation-shift'], { ...ctx, workflows: wf });
    expect('commands' in r && r.commands[0]?.fix).toEqual([
      'node', '/k/scripts/citation-shift.mjs', '--base', 'abc123',
      '--path', 'docs/**/*.md', '--path', 'README.md', '--path', 'rulebook/**/*.md', '--fix',
    ]);
  });

  it('starts with the citation-shift check', () => {
    expect(FIX_COMMANDS.map((f: { key: string }) => f.key)).toEqual(['citation-shift']);
  });
});

// Runs `citation-shift.mjs` in `node`, with `git`, so the block takes the spawn budget (#436).
describe('reviseFix, in a checkout of the pull request', SPAWNS, () => {
  /** A repository whose branch moved `src/x.ts:10` down two lines, which `docs/a.md` cites. */
  const repo = ({ moved = true } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'revise-fix-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    const body = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    w('src/x.ts', `${body.join('\n')}\n`);
    w('docs/a.md', 'The guard is at `src/x.ts:10`.\n');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    w('src/x.ts', `${(moved ? ['new-a', 'new-b', ...body] : [...body, 'new-a']).join('\n')}\n`);
    git('commit', '-qam', 'the pull request');
    return { dir, base, doc: () => readFileSync(join(dir, 'docs/a.md'), 'utf8') };
  };

  it("runs Kanon's command, which re-points the cite, and says the tree changed", () => {
    const { dir, base, doc } = repo();
    const r = reviseFix({ keys: ['citation-shift'], base, kanon: ROOT, cwd: dir });
    expect(r).toMatchObject({ changed: true });
    expect(r.ran[0]).toEqual(['node', `${ROOT}/scripts/citation-shift.mjs`, '--base', base, '--fix']);
    expect(doc()).toContain('`src/x.ts:12`');
  });

  it('says so when the command changes nothing', () => {
    const { dir, base, doc } = repo({ moved: false });
    const r = reviseFix({ keys: ['citation-shift'], base, kanon: ROOT, cwd: dir });
    expect(r.changed).toBe(false);
    expect(r.why).toContain('changed nothing');
    expect(doc()).toContain('`src/x.ts:10`');
  });

  it('runs nothing for a key that is not on the list', () => {
    const { dir, base } = repo();
    const r = reviseFix({ keys: ['make-it-green'], base, kanon: ROOT, cwd: dir });
    expect(r).toMatchObject({ changed: false, ran: [] });
    expect(r.why).toContain('make-it-green');
  });

  it('does not push a fix whose check still fails after it', () => {
    const { dir, base } = repo();
    const r = reviseFix({
      keys: ['citation-shift'], base, kanon: ROOT, cwd: dir,
      run: (argv: string[]) => ({ ok: !argv.includes('--fix') ? false : true, output: 'still moved' }),
    });
    expect(r.changed).toBe(false);
    expect(r.why).toContain('still fails after its fix command');
  });
});

describe('signOff', () => {
  const RECORD = '| Delegate | Email | Delegated on |\n|---|---|---|\n| Dee Legate | dee@example.org | 2026-10-01 |\n';

  it("is the delegate's trailer from the default branch's record", () => {
    expect(signOff(() => RECORD, 'o/r')).toBe('Signed-off-by: Dee Legate <dee@example.org>');
  });

  it('is empty, with a warning, when there is no record: the dco check then says so', () => {
    expect(signOff(() => { throw new Error('HTTP 404'); }, 'o/r')).toBe('');
    expect(signOff(() => 'no table here', 'o/r')).toBe('');
  });
});
