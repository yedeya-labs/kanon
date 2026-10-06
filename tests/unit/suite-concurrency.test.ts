import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * No test writes into Kanon's own tree (kanon#330).
 *
 * WHY. Vitest runs test files concurrently, and many of Kanon's guards are directory walks over
 * its own tree: `readdirSync('scripts')` and then `readFileSync` of each entry, `git ls-files`,
 * the spec-id corpus. A test that drops a temporary file into one of those directories makes it
 * appear in, and then vanish from, a walk another test file is part-way through: the walker
 * lists the file, the writer's `finally` removes it, and the read throws `ENOENT` in a test that
 * has nothing to do with either. While the file is there it is also read as one of Kanon's own —
 * `telemetry-schema`'s emitter list read a mutated copy of a script as an emitter. The window is
 * narrow, so the shape costs flakes and re-runs rather than a steady red, which is the expensive
 * kind: it looks like a bug in whatever test happened to be walking.
 *
 * So a test's writes go to a temporary directory of its own. A mutated copy of one of Kanon's
 * files is written there too, with whatever the copy needs to find its neighbours pointed back
 * at Kanon's tree (`tests/unit/review-pin-defaults.test.ts`).
 *
 * HOW. `writes` reads each test file's source and reports every call to a file-writing function
 * whose DESTINATION argument is a path inside Kanon's tree: the root itself (`ROOT`,
 * `process.cwd()`, the fixture `ADOPTER` the library tests run in), anything built from one, or a
 * relative literal, which is a path under the working directory and so under one tree or the
 * other. There is no exemption list: a test that needs one argues for it by editing this guard.
 *
 * Its limits. It reads the source as text, so a write NAMED in a comment or a string reads as a
 * write — this file's own fixtures are built from pieces for that reason — and it sees no write a
 * spawned process makes: a script this suite runs with Kanon's root as its working directory is
 * on its own.
 */

/** The destination argument of each writing call: the path it creates, writes or removes. */
const DESTINATION: Record<string, number> = {
  writeFileSync: 0, appendFileSync: 0, mkdirSync: 0, mkdtempSync: 0, rmSync: 0, rmdirSync: 0,
  unlinkSync: 0, truncateSync: 0,
  cpSync: 1, copyFileSync: 1, renameSync: 1, linkSync: 1, symlinkSync: 1,
};

/** A path expression inside Kanon's own tree, before any name built from one is added. */
const ROOTED = /\bROOT\b|\bADOPTER\b|process\.cwd\(\)|import\.meta\.(?:url|dirname)/;

/**
 * A declaration's initialiser that is ITSELF a path: a `join`, a literal, or an alias of another
 * name. A function, an object or a call of something else only MENTIONS the root — `const env =
 * (s) => ({ ...process.env, KANON_ROOT: ROOT })` is not a path, and taking it for one taints
 * every short name in a file and then every expression that happens to contain one.
 */
const PATH_EXPR = /^(?:(?:join|resolve|normalize|dirname|fileURLToPath)\s*\(|[A-Za-z_$][\w$]*$|[`'"])/;

/** Every name a file binds to a path inside Kanon's tree, closed over names built from names. */
const rootedNames = (src: string): string[] => {
  const names: string[] = [];
  const rooted = (expr: string) => ROOTED.test(expr) || names.some((n) => new RegExp(`\\b${n}\\b`).test(expr));
  for (let grew = true; grew;) {
    grew = false;
    for (const m of src.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=([^\n]*)$/gm)) {
      const init = m[2]!.trim().replace(/;$/, '');
      if (!names.includes(m[1]!) && PATH_EXPR.test(init) && rooted(init)) { names.push(m[1]!); grew = true; }
    }
  }
  return names;
};

/** The argument expressions of the call whose `(` is at `open`, as written. */
const argsAt = (src: string, open: number): string[] => {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (--depth === 0) { args.push(src.slice(start, i)); return args; }
    } else if (c === ',' && depth === 1) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return args;
};

/**
 * A destination written out as a relative literal, with nothing interpolated into it. It is a
 * path under the working directory, which is Kanon's root for the unit project and the fixture
 * adopter for the library project (`vitest.config.ts`) — a tree in this repository either way.
 */
const RELATIVE_LITERAL = /^['"`](?!\/)(?![^'"`]*\$\{)/;

/** Every write in `src` whose destination is a path inside Kanon's tree, as `<line>: <call>`. */
const writes = (src: string): string[] => {
  const rooted = rootedNames(src);
  const hits: string[] = [];
  for (const [fn, dest] of Object.entries(DESTINATION)) {
    for (const m of src.matchAll(new RegExp(`\\b${fn}\\s*\\(`, 'g'))) {
      const arg = argsAt(src, m.index + m[0].length - 1)[dest];
      if (arg === undefined) continue;
      const expr = arg.trim();
      const inTree = ROOTED.test(expr) || RELATIVE_LITERAL.test(expr)
        || rooted.some((n) => new RegExp(`\\b${n}\\b`).test(expr));
      if (!inTree) continue;
      hits.push(`${src.slice(0, m.index).split('\n').length}: ${fn}(${expr})`);
    }
  }
  return hits.sort();
};

const FILES = execFileSync('git', ['ls-files', '--', 'tests/**/*.ts'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

describe("Kanon's own suite runs its files concurrently, so none writes into the tree another walks", () => {
  it('finds the test files to read', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('tests/unit/review-pin-defaults.test.ts');
  });

  it('no test writes into a path inside Kanon\'s own tree (kanon#330)', () => {
    const hits = FILES.flatMap((f) => writes(readFileSync(f, 'utf8')).map((w) => `${f}:${w}`));
    expect(hits).toEqual([]);
  });
});

describe('the scan reads a destination, not a source', () => {
  // Built, not written out, so this file doesn't trip the guard it tests.
  const R = `RO${'OT'}`;
  const line = (text: string) => `const ROO${'T'} = process.cwd();\n${text}\n`;

  it('flags a write into the source tree, and a copy of a name built from the root', () => {
    expect(writes(line(`writeFileSync(join(${R}, 'scripts', '.x.sh'), text);`)))
      .toEqual([`2: writeFileSync(join(${R}, 'scripts', '.x.sh'))`]);
    expect(writes(line(`const SCRIPT = join(${R}, 'scripts/a.sh');\nconst ALIAS = SCRIPT;\nrmSync(ALIAS, { force: true });`)))
      .toEqual(['4: rmSync(ALIAS)']);
  });

  it('flags a destination written out relative to the working directory', () => {
    // Which is Kanon's root, or the fixture adopter the library tests run in.
    expect(writes(line("writeFileSync('docs/qa/stack.md', text);"))).toEqual(["2: writeFileSync('docs/qa/stack.md')"]);
    expect(writes(line('mkdirSync(`${dir}/a`, { recursive: true });'))).toEqual([]);
  });

  it('allows a write into a temporary directory, and a read from the source tree', () => {
    expect(writes(line("const dir = mkdtempSync(join(tmpdir(), 'x-'));\nwriteFileSync(join(dir, 'a.sh'), text);")))
      .toEqual([]);
    // `cpSync` and `symlinkSync` name the destination second: copying Kanon's own fixture into a
    // temporary directory is what most of these suites do.
    expect(writes(line(`cpSync(join(${R}, 'tests/fixtures/adopter'), dir, { recursive: true });`))).toEqual([]);
    expect(writes(line(`symlinkSync(${R}, join(dir, 'link'));`))).toEqual([]);
  });
});
