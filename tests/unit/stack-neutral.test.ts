import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Kanon is stack-neutral (#15): it is opinionated about process, never about the adopter's
 * stack, and its guards reach an adopter without a `package.json` (#16).
 *
 * Two halves. The FIXTURE half runs Kanon's lane check and guards, exactly as an adopter's CI
 * runs them, on a Python project that has no `package.json`, no lockfile and no Node
 * toolchain (`tests/fixtures/python-adopter`), and shows each one red on a one-line break of
 * that project, so a green run is a guard that read it rather than one that read nothing.
 * The SCAN half keeps what ships to an adopter (the actions, the CLI, the library and the
 * rulebook) from growing a new assumption about the adopter's package manager. The lanes
 * have their own literal check (`lane-workflows.test.ts`), and their prompts are #36.
 */
const ROOT = process.cwd();
const FIXTURE = join(ROOT, 'tests/fixtures/python-adopter');

/** A copy of the fixture as a git repository, the shape a checkout has. */
const checkout = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'python-adopter-'));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const args of [['init', '-q'], ['add', '-A']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
  return dir;
};

/**
 * A PATH holding `node` and `git` and nothing else, so a guard that shelled out to `npm`,
 * `npx` or any other package manager would fail here rather than find one on the machine.
 */
const bareBin = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-bare-bin-'));
  for (const tool of ['node', 'git']) {
    const at = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim();
    if (!at) throw new Error(`${tool} is not on PATH`);
    symlinkSync(at, join(dir, tool));
  }
  return dir;
})();

/** Run one of Kanon's guards the way a step after `kanon-path` does: `node "$KANON/scripts/<guard>.mjs"`. */
const guard = (name: string, change?: (dir: string) => void) => {
  const dir = checkout();
  try {
    change?.(dir);
    const r = spawnSync('node', [join(ROOT, 'scripts', `${name}.mjs`)], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: bareBin, HOME: dir, KANON: ROOT },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const edit = (dir: string, rel: string, fn: (s: string) => string) => {
  const before = readFileSync(join(dir, rel), 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`the change to ${rel} changed nothing`);
  writeFileSync(join(dir, rel), after);
};

const filesUnder = (dir: string, rel = ''): string[] =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(dir, join(rel, d.name)) : [join(rel, d.name)],
  );

describe('the fixture adopter is a project with no Node toolchain', () => {
  it('has a Python manifest, and no package.json, lockfile, .nvmrc or node_modules anywhere', () => {
    const files = filesUnder(FIXTURE);
    expect(files).toContain('pyproject.toml');
    expect(files.filter((f) => /(^|\/)(package(-lock)?\.json|\.nvmrc|node_modules|yarn\.lock|pnpm-lock\.yaml)(\/|$)/.test(f))).toEqual([]);
  });

  it('sets up its lanes with Python, not Node', () => {
    const hook = readFileSync(join(FIXTURE, '.github/actions/project-setup/action.yml'), 'utf8');
    expect(hook).toContain('actions/setup-python@');
    expect(hook).not.toMatch(/setup-node|\bnpm\b|\bnpx\b/);
  });
});

const hasYq = spawnSync('yq', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasYq && process.env.CI) throw new Error('the lane-check case needs yq on PATH in CI');

describe.skipIf(!hasYq)("Kanon's lane check on a project with no package.json", () => {
  const laneCheck = (change?: (dir: string) => void) => {
    const dir = checkout();
    try {
      change?.(dir);
      const r = spawnSync('bash', [join(ROOT, 'actions/lane-check/lane-check.sh')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' },
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('passes the Python adopter whole', () => {
    const r = laneCheck();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('4 lane caller(s) pass');
  });

  it('still reads it: a hook missing an input Kanon passes is red', () => {
    const r = laneCheck((dir) => edit(dir, '.github/actions/project-setup/action.yml', (s) => s.replace(/ {2}browsers:\n( {4}.*\n)+/, '')));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/browsers/);
  });
});

describe("Kanon's guards on a project with no package.json, run with only node and git on PATH", () => {
  // spec-coverage is not here: it finds tests by the JavaScript convention, which is #20.
  it.each([
    ['brief-guard', /1 brief\(s\) carry all 8 required sections/],
    ['spec-guard', /1 invariants, 1 unique IDs, registry consistent/],
    // The citation is into `src/orders/core.py`. Before #16 the guard read no Python
    // coordinate at all, and this line said "0 citation(s)".
    ['citation-guard', /1 citation\(s\) across \d+ docs resolve; 1 anchor-checked/],
  ])('%s passes the Python adopter', (name, says) => {
    const r = guard(name);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(says);
  });

  it('brief-guard is red when the brief drops a required section', () => {
    const r = guard('brief-guard', (dir) => edit(dir, 'docs/projects/1.md', (s) => s.replace(/## 8\. What I did not examine[\s\S]*$/, '')));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/what I did not examine/i);
  });

  it('spec-guard is red when a clause id is used twice', () => {
    const r = guard('spec-guard', (dir) => edit(dir, 'docs/qa/specs/orders.md', (s) => `${s}- \`[ORD-1]\` \`[seed]\` A second clause under the same id.\n`));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/ORD-1/);
  });

  it('citation-guard counts a coordinate into the Python venv as external, not missing (#108)', () => {
    // `.venv/` is in the fixture's `.gitignore` and not in its index, as on any Python project.
    const venv = (dir: string) =>
      edit(dir, 'docs/design.md', (s) => `${s}\nRequests retries it (\`.venv/lib/python3.12/site-packages/requests/api.py:59\`).\n`);
    const r = guard('citation-guard', venv);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/1 coordinate\(s\) into an untracked, git-ignored path not checked/);
    // A path the project's git does NOT ignore is not a dependency: the same line is a finding.
    const typo = guard('citation-guard', (dir) => {
      venv(dir);
      edit(dir, '.gitignore', (s) => s.replace('.venv/\n', ''));
    });
    expect(typo.status, typo.out).toBe(1);
    expect(typo.out).toMatch(/no such file in the repository/);
  });

  it('citation-guard is red when a coordinate into a Python file points past its end', () => {
    const r = guard('citation-guard', (dir) => edit(dir, 'docs/design.md', (s) => s.replace('core.py:4-6', 'core.py:40')));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('docs/design.md:3');
  });
});

/**
 * What ships to an adopter, read line by line, minus comments. A line naming a package
 * manager or its files is an assumption about the adopter's stack unless it is listed here
 * with the reason it isn't. An entry that matches nothing fails too, so the list can't
 * outlive what it excuses.
 */
const ASSUMPTION = /\bnpm\b|\bnpx\b|\byarn\b|\bpnpm\b|package(?:-lock)?\.json|node_modules|\.nvmrc/;
// ROADMAP.md too: it once restated K-ADOPT-11's table, and a copy is where "an npm package" survived.
const SHIPPED = /^(actions|cli|scripts)\/.*\.(mjs|js|sh|awk|yml|yaml)$|^rulebook\/.*\.md$|^ROADMAP\.md$/;
const ALLOWED: Array<{ file: string; needle: string; why: string }> = [
  { file: 'scripts/doc-path-guard.mjs', needle: "!f.startsWith('node_modules/')", why: 'skips a Node dependency tree if one is tracked; on another stack it matches nothing' },
  { file: 'scripts/verify-acs.mjs', needle: "['npx', 'vitest'", why: '#20: tests are found and run by the JavaScript convention until the per-language convention lands' },
  { file: 'scripts/verify-acs.mjs', needle: "['npx', 'playwright'", why: '#20, as above' },
  { file: 'rulebook/10-adoption.md', needle: 'may have no `package.json` to hold a version', why: "K-ADOPT-11's Why for the guard row: the reason a guard is not a package" },
  { file: 'rulebook/00-principles.md', needle: 'guards need no `package.json`, package manager', why: 'states that the guards need none, and names the parts that still do (#20, #36)' },
];

const isComment = (file: string, line: string): boolean => {
  const t = line.trim();
  if (file.endsWith('.md')) return false;
  if (/\.(mjs|js)$/.test(file)) return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  return t.startsWith('#');
};

/** Every uncommented line of `files` that names a package manager, with the entries it used. */
const scanForAssumptions = (files: Array<{ file: string; text: string }>, allowed = ALLOWED) => {
  const used = new Set<number>();
  const hits: string[] = [];
  for (const { file, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (isComment(file, line) || !ASSUMPTION.test(line)) return;
      const k = allowed.findIndex((a) => a.file === file && line.includes(a.needle));
      if (k === -1) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      else used.add(k);
    });
  }
  return { hits, stale: allowed.filter((_, k) => !used.has(k)).map((a) => `${a.file}: ${a.needle}`) };
};

describe('what ships to an adopter names no package manager of the adopter', () => {
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter((f) => SHIPPED.test(f));
  const shipped = () => tracked.filter((f) => existsSync(join(ROOT, f))).map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));

  it('reads the actions, the CLI, the library, the rulebook and the roadmap', () => {
    for (const dir of ['actions/', 'cli/', 'scripts/', 'rulebook/', 'ROADMAP.md']) expect(tracked.some((f) => f.startsWith(dir)), dir).toBe(true);
  });

  it('finds no unlisted line, and no listed entry that matches nothing', () => {
    expect(scanForAssumptions(shipped())).toEqual({ hits: [], stale: [] });
  });

  it('is red on a new `npm ci` in an action, and not on the same words in a comment', () => {
    const files = [{ file: 'actions/x/action.yml', text: '    - run: npm ci\n    # npm ci, in a comment\n' }];
    expect(scanForAssumptions(files, []).hits).toEqual(['actions/x/action.yml:1: - run: npm ci']);
  });

  it('is red on a library line that reads package.json', () => {
    const files = [{ file: 'scripts/x.mjs', text: "const v = readFileSync('package.json');\n// package.json, in a comment\n" }];
    expect(scanForAssumptions(files, []).hits).toHaveLength(1);
  });

  it('reports an entry that matches nothing as stale', () => {
    expect(scanForAssumptions([], ALLOWED.slice(0, 1)).stale).toEqual([`${ALLOWED[0]!.file}: ${ALLOWED[0]!.needle}`]);
  });
});
