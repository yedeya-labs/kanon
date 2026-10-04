import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The lanes' test database is the project's declaration (kanon#18, `K-LAYOUT-16`).
 *
 * Three halves. The DECLARATION half runs the block's reader on every shape a project can
 * write, so a malformed declaration is a named red rather than a silent "no database". The
 * LANE half holds every lane to starting the database through the block, from a step, with
 * nothing of a database engine in the lane itself, the block or the rulebook. The FIXTURE
 * half shows the two adopters: the Python one declares nothing and gets nothing, and the
 * worked example declares `hook`. That its hook really starts Postgres is the test-database
 * smoke's job, on a runner.
 */
const ROOT = process.cwd();
const READER = join(ROOT, 'actions/test-database/declaration.sh');
const FILE = 'docs/qa/test-database.md';

/** Run the reader in a fresh directory holding `body` as the declaration (or no file). */
const read = (body: string | null, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'test-database-'));
  try {
    if (body !== null) {
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, FILE), body);
    }
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const r = spawnSync('bash', [READER], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH!, WANTED: 'true', GITHUB_OUTPUT: out, ...env } });
    const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=', 2) as [string, string]));
    return { status: r.status, log: `${r.stdout}${r.stderr}`, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const declare = (kind: string) => `# Test database\n\nProse first.\n\n**Test database:** \`${kind}\`\n`;

describe('the declaration (K-LAYOUT-16)', () => {
  it('no file declares no database: nothing is started and the hook is told false', () => {
    const r = read(null);
    expect(r.status, r.log).toBe(0);
    expect(r.outputs).toEqual({ kind: 'none', database: 'false' });
  });

  it.each([
    ['none', 'false'],
    ['hook', 'true'],
  ])('`%s` is read, and tells the hook database=%s', (kind, database) => {
    const r = read(declare(kind));
    expect(r.status, r.log).toBe(0);
    expect(r.outputs).toEqual({ kind, database });
  });

  it('a lane that wants no database reads nothing, even a malformed declaration', () => {
    const r = read('nonsense', { WANTED: 'false' });
    expect(r.status, r.log).toBe(0);
    expect(r.outputs).toEqual({ kind: '', database: 'false' });
  });

  it('ignores a declaration inside a fenced block, as an example is not one', () => {
    const r = read('```\n**Test database:** `mysql`\n```\n\n**Test database:** `hook`\n');
    expect(r.outputs.kind).toBe('hook');
  });

  it.each([
    ['a file with no declaration line', '# Test database\n\nWe use Postgres.\n', /has no `\*\*Test database:\*\* `<kind>`` line/],
    ['two declaration lines', `${declare('postgres')}**Test database:** \`none\`\n`, /has 2 `\*\*Test database:\*\*` lines/],
    ['a kind Kanon does not know', declare('mysql'), /declares `mysql`, which is not a kind Kanon knows/],
    // The Owner's choice (2026-10-03): Kanon names no engine, so an engine is never a kind.
    ['an engine, even the reference adopter\'s', declare('postgres'), /declares `postgres`, which is not a kind Kanon knows: `none`, or `hook`.*Kanon names no engine/],
    ['an empty kind', declare(''), /declares ``, which is not a kind Kanon knows/],
    ['a kind outside backticks', '**Test database:** postgres\n', /the line is exactly \*\*Test database:\*\* followed by the kind in backticks/],
    ['an indented line', '  **Test database:** `hook`\n', /at column zero/],
    ['text after the kind', '**Test database:** `hook` (Postgres)\n', /the line is exactly/],
  ])('refuses %s, by name, rather than starting nothing', (_, body, says) => {
    const r = read(body);
    expect(r.status, r.log).toBe(1);
    expect(r.log).toMatch(/::error file=docs\/qa\/test-database\.md,title=test database::/);
    expect(r.log).toMatch(says);
  });

  it('reads the declaration at a commit when given one, not from the working tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-database-git-'));
    try {
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout.trim();
      };
      git('init', '-q');
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, FILE), declare('hook'));
      git('add', '-A');
      git('commit', '-qm', 'declare');
      const sha = git('rev-parse', 'HEAD');
      // The working tree is a tag with no declaration; the defining commit has one.
      rmSync(join(dir, FILE));
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const run = (from: string) => {
        writeFileSync(out, '');
        spawnSync('bash', [READER], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH!, WANTED: 'true', FROM: from, GITHUB_OUTPUT: out } });
        return readFileSync(out, 'utf8');
      };
      expect(run(sha)).toContain('kind=hook');
      expect(run('')).toContain('kind=none');
      // A commit it can't read is an error, not "no declaration" (the Reviewer, finding D).
      expect(run('f'.repeat(40))).toBe('');
      const bad = spawnSync('bash', [READER], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH!, WANTED: 'true', FROM: 'f'.repeat(40), GITHUB_OUTPUT: out } });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/cannot read the commit ffffffffffff/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

type Step = { id?: string; uses?: string; with?: Record<string, unknown>; if?: string };
type Wf = { jobs: Record<string, { services?: unknown; env?: Record<string, unknown>; steps?: Step[]; with?: Record<string, unknown> }> };
const WF = '.github/workflows';
const workflows = readdirSync(WF).filter((f) => f.endsWith('.yml'));
const lanes = workflows.map((f) => ({ f, wf: parse(readFileSync(join(WF, f), 'utf8')) as Wf }));

describe('every lane starts the database the project declares, from a step', () => {
  it('no workflow declares a service container, so nothing starts before the declaration is read', () => {
    expect(lanes.filter(({ wf }) => Object.values(wf.jobs ?? {}).some((j) => j.services !== undefined)).map(({ f }) => f)).toEqual([]);
  });

  it('no lane names a database engine, image, port or URL: those are the block\'s, or the project\'s', () => {
    const named = workflows.filter((f) => f.startsWith('agent-')).filter((f) => /pgvector|postgres|:5432|DATABASE_URL=/i.test(readFileSync(join(WF, f), 'utf8')));
    expect(named).toEqual([]);
  });

  // Every job that calls the hook and may hand it a database: the block runs before the hook,
  // in the same job, and the hook's `database` is the block's answer, never a literal 'true'.
  const hookCalls = lanes.filter(({ f }) => f.startsWith('agent-')).flatMap(({ f, wf }) =>
    Object.entries(wf.jobs ?? {}).flatMap(([name, job]) => {
      const steps = job.steps ?? [];
      const at = steps.findIndex((s) => s.uses === './.github/actions/project-setup');
      return at < 0 ? [] : [{ where: `${f} ${name}`, steps, at }];
    }),
  );

  it('finds every job that calls the hook', () => {
    expect(hookCalls.map((c) => c.where).sort()).toEqual([
      'agent-lane.yml run',
      'agent-lead-split.yml split',
      'agent-rebase.yml resolve',
      'agent-verify-acs.yml verify',
    ]);
  });

  it.each(['agent-lane.yml run', 'agent-rebase.yml resolve', 'agent-verify-acs.yml verify'])(
    '%s runs the block before the hook and hands the hook its answer',
    (where) => {
      const { steps, at } = hookCalls.find((c) => c.where === where)!;
      const db = steps.findIndex((s) => s.uses === '$/actions/test-database');
      expect(db, 'the block').toBeGreaterThanOrEqual(0);
      expect(db).toBeLessThan(at);
      expect(steps[db]!.id).toBe('database');
      expect(steps[at]!.with?.database).toBe('${{ steps.database.outputs.database }}');
    },
  );

  it('the split lane, which edits prose, starts none and tells the hook so', () => {
    const { steps, at } = hookCalls.find((c) => c.where === 'agent-lead-split.yml split')!;
    expect(steps.some((s) => s.uses === '$/actions/test-database')).toBe(false);
    expect(steps[at]!.with?.database).toBe('false');
  });

  it('the spine passes the lane\'s own switch, so a prose lane starts nothing whatever is declared', () => {
    const spine = lanes.find(({ f }) => f === 'agent-lane.yml')!.wf.jobs.run!;
    expect(spine.steps!.find((s) => s.uses === '$/actions/test-database')?.with).toEqual({ wanted: '${{ inputs.database }}' });
  });

  it('the verify-acs lane reads the declaration where it reads the hook, from the defining commit', () => {
    const verify = lanes.find(({ f }) => f === 'agent-verify-acs.yml')!.wf.jobs.verify!;
    const steps = verify.steps!;
    const load = steps.findIndex((s) => s.id === 'hook');
    const db = steps.findIndex((s) => s.uses === '$/actions/test-database');
    expect(load).toBeLessThan(db);
    expect(steps[db]!.with).toEqual({ from: '${{ steps.hook.outputs.sha }}' });
  });
});

describe('the block starts nothing, and nothing Kanon ships to an adopter names an engine', () => {
  it('the block only reads: its one step runs the reader', () => {
    const block = parse(readFileSync('actions/test-database/action.yml', 'utf8')) as { runs: { steps: { run?: string }[] } };
    expect(block.runs.steps.map((s) => s.run)).toEqual(['bash "$GITHUB_ACTION_PATH/declaration.sh"']);
    expect(readdirSync('actions/test-database').sort()).toEqual(['README.md', 'action.yml', 'declaration.awk', 'declaration.sh']);
  });

  it('no rule, and no file of the block but its README\'s worked example, names an engine, image or port', () => {
    const ENGINE = /pgvector|postgres|mysql|mongo|:5432/i;
    const rules = readdirSync('rulebook').filter((f) => f.endsWith('.md')).filter((f) => ENGINE.test(readFileSync(join('rulebook', f), 'utf8')));
    expect(rules).toEqual([]);
    for (const f of ['action.yml', 'declaration.awk', 'declaration.sh']) {
      const named = readFileSync(join('actions/test-database', f), 'utf8').split('\n').filter((l) => ENGINE.test(l) && !l.includes('tests/fixtures/test-database/postgres'));
      expect(named, f).toEqual([]);
    }
  });

  it('the README\'s worked example is the step the smoke runs', () => {
    const hook = parse(readFileSync('tests/fixtures/test-database/postgres/.github/actions/project-setup/action.yml', 'utf8')) as { runs: { steps: { run?: string }[] } };
    const run = hook.runs.steps[0]!.run!.trimEnd();
    const readme = readFileSync('actions/test-database/README.md', 'utf8');
    expect(readme).toContain(run.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n'));
  });
});

describe('the fixture adopters', () => {
  it('the Python adopter declares no database, so its lanes start none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'python-adopter-db-'));
    try {
      cpSync(join(ROOT, 'tests/fixtures/python-adopter'), dir, { recursive: true });
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = spawnSync('bash', [READER], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH!, WANTED: 'true', GITHUB_OUTPUT: out } });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('kind=none\ndatabase=false\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the worked example declares `hook`: its hook starts its Postgres, as the reference adopter\'s will', () => {
    const r = read(readFileSync('tests/fixtures/test-database/postgres/docs/qa/test-database.md', 'utf8'));
    expect(r.outputs).toEqual({ kind: 'hook', database: 'true' });
  });
});
