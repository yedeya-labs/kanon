import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  it.each([
    ['brief-guard', /1 brief\(s\) carry all 8 required sections/],
    ['spec-guard', /1 invariants, 1 unique IDs, registry consistent/],
    // The citation is into `src/orders/core.py`. Before #16 the guard read no Python
    // coordinate at all, and this line said "0 citation(s)".
    ['citation-guard', /1 citation\(s\) across \d+ docs resolve; 1 anchor-checked/],
    // `[ORD-1]` is in the summary line of a pytest docstring (kanon#20). Before #20 the
    // coverage tool read only JavaScript under `tests/` and `e2e/`, and this said 0 of 1.
    ['spec-coverage', /\*\*Locked\*\* — a test names the invariant's ID: \*\*1 of 1\*\*/],
    // The exemption is the fixture's own, from its `docs/qa/exemptions.md`. Before #54 the
    // reference adopter's seven were in the library, and this guard failed "stale exemption"
    // on every one of them here.
    ['doc-path-guard', /resolve; 1 deliberately illustrative or historical mention\(s\) exempted by name/],
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

  describe('brief-guard reads a roadmap milestone from the repository, not from the library (kanon#54)', () => {
    const onLaunch = (dir: string) => edit(dir, 'docs/projects/1.md', (t) => t.replace('**Milestone:** Product Backlog', '**Milestone:** Launch'));
    /** brief-guard with a `gh` on PATH that answers the milestone listing with `milestones`. */
    const withGh = (milestones: string) => {
      const dir = checkout();
      const bin = mkdtempSync(join(tmpdir(), 'gh-stub-'));
      try {
        onLaunch(dir);
        writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *milestones*) printf '%s\\n' '${milestones}' ;; *) exit 9 ;; esac\n`, { mode: 0o755 });
        const r = spawnSync('node', [join(ROOT, 'scripts', 'brief-guard.mjs')], {
          cwd: dir,
          encoding: 'utf8',
          env: { PATH: `${bin}:${bareBin}`, HOME: dir, KANON: ROOT },
        });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    };

    it('passes a brief that names a roadmap milestone the repository has', () => {
      const r = withGh('{"title":"Launch","due_on":"2026-12-31T00:00:00Z","state":"open"}');
      expect(r.status, r.out).toBe(0);
    });

    it('is red when the repository has no such roadmap milestone', () => {
      const r = withGh('{"title":"Launch","due_on":null,"state":"open"}');
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/names milestone “Launch”, which has no due date/);
    });

    it("is red, by name, when the repository's milestones can't be read", () => {
      // The bare PATH has no `gh`.
      const r = guard('brief-guard', onLaunch);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/names milestone “Launch”, which isn't a bucket \(Product Backlog, Development Automation\), and the repository's milestones couldn't be read/);
    });
  });

  it("doc-path-guard is red on a mention its exemptions file doesn't list, and on a stale entry (kanon#54)", () => {
    const unlisted = guard('doc-path-guard', (dir) => edit(dir, 'docs/design.md', (s) => `${s}\nSee \`docs/missing.md\`.\n`));
    expect(unlisted.status, unlisted.out).toBe(1);
    expect(unlisted.out).toMatch(/docs\/missing\.md — a path this text cites as real/);
    const stale = guard('doc-path-guard', (dir) => edit(dir, 'docs/design.md', (s) => s.replace('`docs/TODO.md`', 'a TODO file')));
    expect(stale.status, stale.out).toBe(1);
    expect(stale.out).toMatch(/stale exemption — docs\/design\.md no longer names docs\/TODO\.md.*docs\/qa\/exemptions\.md:13/);
  });

  it.each(['brief-guard', 'doc-path-guard'])('%s fails by name when the exemptions file is missing or malformed (kanon#54)', (name) => {
    const missing = guard(name, (dir) => rmSync(join(dir, 'docs/qa/exemptions.md')));
    expect(missing.status, missing.out).toBe(1);
    // Reported by the guard, once, before any brief or document is read: not a crash.
    expect(missing.out).toMatch(new RegExp(`^${name}: docs/qa/exemptions\\.md doesn't exist`, 'm'));
    expect(missing.out).not.toMatch(/\n\s+at /);
    const malformed = guard(name, (dir) => edit(dir, 'docs/qa/exemptions.md', (s) => s.replace('## Path mentions', '## Mentions')));
    expect(malformed.status, malformed.out).toBe(1);
    expect(malformed.out).toMatch(/docs\/qa\/exemptions\.md has no `## Path mentions` heading/);
  });

  it('brief-guard is red on a pre-standard entry for a brief that does not exist (kanon#54)', () => {
    const r = guard('brief-guard', (dir) => edit(dir, 'docs/qa/exemptions.md', (s) => s.replace('None: every brief here was written to the standard.', '- `docs/projects/7.md` — an old brief')));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/docs\/qa\/exemptions\.md:7\n\s+`docs\/projects\/7\.md` is listed as a pre-standard brief, but there is no such brief/);
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

  it("spec-coverage is red when the pytest title loses its id, which the docstring's body does not hold", () => {
    const r = guard('spec-coverage', (dir) => edit(dir, 'tests/test_core.py', (s) => s.replace('"""[ORD-1] Placing', '"""Placing')));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/lost their citation: ORD-1/);
  });

  it("spec-coverage doesn't count a test in a directory git ignores, such as a virtualenv", () => {
    const r = guard('spec-coverage', (dir) => {
      edit(dir, 'tests/test_core.py', (s) => s.replace('"""[ORD-1] Placing', '"""Placing'));
      writeFileSync(join(dir, '.gitignore'), 'venv/\n');
      mkdirSync(join(dir, 'venv/lib/site'), { recursive: true });
      writeFileSync(join(dir, 'venv/lib/site/test_vendored.py'), 'def test_vendored():\n    """[ORD-1] a vendored test"""\n');
    });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/lost their citation: ORD-1/);
  });

  it('spec-coverage reads a clause that names a pytest file as Claimed', () => {
    const r = guard('spec-coverage', (dir) => edit(dir, 'docs/qa/specs/orders.md', (s) => `${s}- \`[ORD-2]\` \`[seed]\` A refund is recorded once. *(Confirmed by \`tests/test_core.py\`.)*\n`));
    expect(r.out).toMatch(/\*\*Claimed\*\* — the spec names a test file, but no test cites the ID: \*\*1\*\*/);
  });

  it('citation-guard is red when a coordinate into a Python file points past its end', () => {
    const r = guard('citation-guard', (dir) => edit(dir, 'docs/design.md', (s) => s.replace('core.py:4-6', 'core.py:40')));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('docs/design.md:3');
  });
});

describe('citation-shift on the Python adopter, with only node and git on PATH (kanon#20)', () => {
  /** Commit the fixture, move `place` down two lines, and run citation-shift against that diff. */
  const shift = (...args: string[]) => shiftWith(undefined, ...args);
  const shiftWith = (declare: ((dir: string) => void) | undefined, ...args: string[]) => {
    const dir = checkout();
    try {
      declare?.(dir);
      const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
      git('add', '-A');
      git('commit', '-qm', 'base');
      edit(dir, 'src/orders/core.py', (s) => `"""Orders."""\n\n${s}`);
      const r = spawnSync('node', [join(ROOT, 'scripts/citation-shift.mjs'), '--base', 'HEAD', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: bareBin, HOME: dir, KANON: ROOT },
      });
      const after = (rel: string) => readFileSync(join(dir, rel), 'utf8');
      return { status: r.status, out: `${r.stdout}${r.stderr}`, test: after('tests/test_core.py'), design: after('docs/design.md') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('is red on the doc coordinate AND the `#` comment coordinate that the move left behind', () => {
    const r = shift();
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('docs/design.md:3  `src/orders/core.py:4-6`  ->  `src/orders/core.py:6-8`');
    expect(r.out).toContain('tests/test_core.py:1  src/orders/core.py:4-6  ->  src/orders/core.py:6-8');
  });

  it("skips the comments of the adopter's declared pipeline code, which quote old coordinates on purpose (kanon#54)", () => {
    expect(shift().out).not.toContain('scripts/pipeline/triage.py');
    // Undeclared, the same comment is a claim like any other, and is red.
    const undeclared = shiftWith((dir) => edit(dir, 'docs/qa/escalation-paths.md', (s) => s.replace(/^- `scripts\/pipeline\/`.*\n/m, '')));
    expect(undeclared.status, undeclared.out).toBe(1);
    expect(undeclared.out).toContain('scripts/pipeline/triage.py:3  src/orders/core.py:4-6  ->  src/orders/core.py:6-8');
  });

  it('fails by name when the escalation file is missing or malformed (kanon#54)', () => {
    const missing = shiftWith((dir) => rmSync(join(dir, 'docs/qa/escalation-paths.md')));
    expect(missing.status, missing.out).toBe(1);
    expect(missing.out).toMatch(/docs\/qa\/escalation-paths\.md doesn't exist/);
    const malformed = shiftWith((dir) => edit(dir, 'docs/qa/escalation-paths.md', (s) => s.replace('## Pipeline code', '## Pipeline')));
    expect(malformed.status, malformed.out).toBe(1);
    expect(malformed.out).toMatch(/docs\/qa\/escalation-paths\.md has no `## Pipeline code` heading/);
  });

  it('--fix re-points both', () => {
    const r = shift('--fix');
    expect(r.status, r.out).toBe(0);
    expect(r.test).toContain('at src/orders/core.py:6-8.');
    expect(r.design).toContain('`src/orders/core.py:6-8`');
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
  { file: 'scripts/spec-coverage.mjs', needle: "e !== 'node_modules'", why: "the walk outside a git repository skips a Node dependency tree, as git's ignore list would; on another stack it matches nothing" },
  { file: 'scripts/lib/test-conventions.mjs', needle: "bin: 'node_modules/.bin/vitest'", why: "the JavaScript row's runner, as the project-setup hook installs it; a Python or Go project never reaches it (#20)" },
  { file: 'scripts/lib/test-conventions.mjs', needle: "bin: 'node_modules/.bin/playwright'", why: '#20, as above' },
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
