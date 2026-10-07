import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UNDECLARED, auditAreas, codeAreasDefaults, codeTrees, isCodePath, isTestPath, parseCodeAreas, readCodeAreas,
} from '../../scripts/lib/code-areas.mjs';
import { codeAreasCli } from '../../scripts/code-areas.mjs';
import { referenceCorpus } from '../../scripts/spec-lib.mjs';
import { auditPaths } from '../../scripts/doc-path-guard.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * kanon#54, plan 0004 step 11 (decision 6): where a project's code is, declared under
 * `## Code areas` in its stack document (`K-LAYOUT-17`), and Kanon's rule when it declares none.
 * The guards (`citation-shift`, `doc-path-guard`, the spec-id reference corpus) and the
 * code-audit lane read it through `scripts/lib/code-areas.mjs`.
 */

const STACK = (areas: string) => `# Stack\n\n## Gates\n\n1. \`make test\`\n\n## Code areas\n\n${areas}\n## Generated files\n\nNone.\n`;
const REFERENCE = STACK([
  '- `src/` — code: the application',
  '- `scripts/` — code: build scripts',
  '- `tests/` `vitest` — tests: unit and integration tests',
  '- `e2e/` `playwright` — tests: the browser suite',
  '- `src/server/services/` — audit: the service layer, where tenant scope lives',
  '- `src/middleware.ts` — audit: the session guard',
].join('\n'));

describe('parseCodeAreas reads the declaration', () => {
  it('reads each kind, in order, with what it holds', () => {
    const a = parseCodeAreas(REFERENCE);
    expect(a.declared).toBe(true);
    expect(a.code).toEqual([{ path: 'src/', what: 'the application' }, { path: 'scripts/', what: 'build scripts' }]);
    expect(a.tests).toEqual([
      { path: 'tests/', what: 'unit and integration tests', runner: 'vitest' },
      { path: 'e2e/', what: 'the browser suite', runner: 'playwright' },
    ]);
    expect(a.audit).toEqual([
      { path: 'src/server/services/', what: 'the service layer, where tenant scope lives' },
      { path: 'src/middleware.ts', what: 'the session guard' },
    ]);
  });

  it('allows prose between the bullets, CRLF, and the section ending at the next heading', () => {
    const a = parseCodeAreas(STACK('Where things are.\n\n- `lib/` — code: the package\n').replace(/\n/g, '\r\n'));
    expect(a.code).toEqual([{ path: 'lib/', what: 'the package' }]);
  });

  it('reads a tests tree with no runner as one that names none (kanon#20)', () => {
    expect(parseCodeAreas(STACK('- `spec/` — tests: the suite')).tests).toEqual([{ path: 'spec/', what: 'the suite' }]);
  });

  it('reads no section as undeclared, and a section with no entries as declared but empty', () => {
    expect(parseCodeAreas('# Stack\n\n## Gates\n\n1. `make`\n')).toBe(UNDECLARED);
    expect(parseCodeAreas(STACK('Nothing yet.'))).toEqual({ declared: true, code: [], tests: [], audit: [] });
    // A heading inside a fence is not the section.
    expect(parseCodeAreas('```\n## Code areas\n- nonsense\n```\n')).toBe(UNDECLARED);
  });

  it.each([
    ['an entry in another shape', '- src/ — code: the application', /:9, under `## Code areas`, isn't an area/],
    ['an entry with no kind', '- `src/` — the application', /isn't an area: write a path in backticks, for a tests tree optionally its runner in backticks, an em dash, its kind/],
    ['a runner on a code area', '- `src/` `vitest` — code: the application', /:9 names the runner `vitest` on a `code` area: only a `tests` tree names a runner/],
    ['a runner on an audit area', '- `src/` `vitest` — audit: the application', /:9 names the runner `vitest` on a `audit` area/],
    ['a runner Kanon does not run a tree with', '- `tests/` `jest` — tests: the suite', /:9: `jest` isn't a runner Kanon runs a tests tree with: write `vitest` or `playwright`, or none/],
    ['a language runner, which its own row already names', '- `tests/` `pytest` — tests: the suite', /`pytest` isn't a runner Kanon runs a tests tree with/],
    ['an unknown kind', '- `src/` — source: the application', /`source` isn't a kind of code area; write one of code, tests, audit/],
    ['a code area that is not a directory', '- `src` — code: the application', /a `code` area is a directory, so write `src\/`/],
    ['a tests area that is not a directory', '- `tests` — tests: the suite', /a `tests` area is a directory, so write `tests\/`/],
    ['a leading slash', '- `/src/` — code: x', /`\/src\/` isn't a repository-relative path/],
    ['a dot-slash', '- `./src/` — code: x', /`\.\/src\/` isn't a repository-relative path/],
    ['a glob', '- `src/**` — code: x', /`src\/\*\*` isn't a repository-relative path/],
    ['a parent segment', '- `src/../lib/` — code: x', /isn't a repository-relative path/],
    ['an empty segment', '- `src//lib/` — code: x', /isn't a repository-relative path/],
    ['a numbered item', '1. `src/` — code: x', /is a list item the file doesn't use/],
    ['an indented item', '  - `src/` — code: x', /is a list item the file doesn't use/],
    ['a + item', '+ `src/` — code: x', /is a list item the file doesn't use/],
    ['the same area twice under one kind', '- `src/` — code: a\n- `src/` — code: b', /:10 declares the code area `src\/` again, already declared on line 9/],
  ])('fails by name on %s', (_what, entry, says) => {
    expect(() => parseCodeAreas(STACK(entry))).toThrow(says);
    expect(() => parseCodeAreas(STACK(entry))).toThrow(/^docs\/qa\/stack\.md.*\(K-LAYOUT-17\)$/);
  });

  it('fails by name on the heading written twice, and on a fence that never closes', () => {
    expect(() => parseCodeAreas(`${STACK('- `src/` — code: a')}\n## Code areas\n`)).toThrow(/has the `## Code areas` heading 2 times, on lines 7, 14/);
    expect(() => parseCodeAreas(`${STACK('- `src/` — code: a')}\n\`\`\`\n`)).toThrow(/:14 opens a code fence that never closes/);
  });

  it('lets the same path be two kinds: an audit area inside a code tree', () => {
    const a = parseCodeAreas(STACK('- `src/` — code: x\n- `src/` — audit: everything'));
    expect(a.code[0]!.path).toBe('src/');
    expect(a.audit[0]!.path).toBe('src/');
  });
});

describe('what each reader makes of it', () => {
  const declared = parseCodeAreas(REFERENCE);

  it('code: the declared code and test trees, or the whole repository', () => {
    expect(codeTrees(declared)).toEqual(['src/', 'scripts/', 'tests/', 'e2e/']);
    expect(isCodePath('src/a.ts', declared)).toBe(true);
    expect(isCodePath('e2e/a.spec.ts', declared)).toBe(true);
    expect(isCodePath('lib/a.ts', declared)).toBe(false);
    expect(codeTrees(UNDECLARED)).toBeNull();
    expect(isCodePath('lib/a.ts', UNDECLARED)).toBe(true);
    // A section with only tests declares no code tree, so the code is still the whole repository.
    expect(codeTrees(parseCodeAreas(STACK('- `spec/` — tests: x')))).toBeNull();
  });

  it('tests: the declared test trees, or the language convention file by file', () => {
    expect(isTestPath('tests/fixtures/a.md', declared)).toBe(true);
    expect(isTestPath('src/a.test.ts', declared)).toBe(false);
    // Undeclared: the per-language table (`K-SPEC-6`). A pytest file anywhere is a test.
    expect(isTestPath('pkg/test_orders.py', UNDECLARED)).toBe(true);
    expect(isTestPath('pkg/orders.py', UNDECLARED)).toBe(false);
    expect(isTestPath('tests/a.test.ts', UNDECLARED)).toBe(true);
  });

  it('audit: the audit areas, else the code trees, else the whole repository', () => {
    expect(auditAreas(declared)).toEqual({
      source: 'audit',
      lines: ['- `src/server/services/`: the service layer, where tenant scope lives', '- `src/middleware.ts`: the session guard'],
    });
    expect(auditAreas(parseCodeAreas(STACK('- `lib/` — code: the package')))).toEqual({ source: 'code', lines: ['- `lib/`: the package'] });
    expect(auditAreas(UNDECLARED).source).toBe('repository');
  });
});

describe('the readers, on a tree', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'code-areas-'));
    dirs.push(root);
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return root;
  };
  const git = (root: string, ...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  /** The same tree, in a git repository, with `track` staged and the rest left untracked. */
  const repo = (files: Record<string, string>, track: string[]) => {
    const root = tree(files);
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@t');
    git(root, 'config', 'user.name', 't');
    if (track.length) git(root, 'add', '--', ...track);
    return root;
  };

  it('readCodeAreas: no stack document declares nothing; a malformed one throws', () => {
    expect(readCodeAreas(tree({}))).toBe(UNDECLARED);
    expect(readCodeAreas(tree({ 'docs/qa/stack.md': REFERENCE })).declared).toBe(true);
    expect(() => readCodeAreas(tree({ 'docs/qa/stack.md': STACK('- `src` — code: x') }))).toThrow(/a `code` area is a directory/);
    // Only a MISSING document declares nothing: one that can't be read fails by name.
    expect(() => readCodeAreas(tree({ 'docs/qa/stack.md/x': '' }))).toThrow(/^docs\/qa\/stack\.md couldn't be read: .*\(K-LAYOUT-17\)$/);
  });

  it('the code-audit lane\'s CLI prints the areas, and fails by name before the agent on a malformed section', () => {
    expect(codeAreasCli({ root: tree({ 'docs/qa/stack.md': REFERENCE }) })).toEqual({
      code: 0,
      out: '- `src/server/services/`: the service layer, where tenant scope lives\n- `src/middleware.ts`: the session guard',
      note: 'code-areas: auditing the `audit` areas docs/qa/stack.md declares',
    });
    expect(codeAreasCli({ root: tree({}) }).note).toBe('code-areas: auditing the whole repository: docs/qa/stack.md declares no code areas');
    const bad = codeAreasCli({ root: tree({ 'docs/qa/stack.md': STACK('- `src/` — sauce: x') }) });
    expect(bad.code).toBe(1);
    expect(bad.out).toBe('');
    expect(bad.note).toMatch(/^code-areas: docs\/qa\/stack\.md:9: `sauce` isn't a kind of code area/);
  });

  it('referenceCorpus walks the declared trees and docs/, or the whole repository outside dot-directories', () => {
    const files = {
      'src/a.ts': '', 'lib/b.ts': '', 'tests/c.test.ts': '', 'docs/d.md': '', 'docs/qa/specs/s.md': '',
      '.hidden/e.ts': '', 'node_modules/x/f.ts': '',
    };
    const declared = tree({ ...files, 'docs/qa/stack.md': STACK('- `src/` — code: x\n- `tests/` — tests: y') });
    expect(referenceCorpus(declared, [])).toEqual(['docs/d.md', 'docs/qa/stack.md', 'src/a.ts', 'tests/c.test.ts']);
    const undeclared = tree(files);
    expect(referenceCorpus(undeclared, [])).toEqual(['docs/d.md', 'lib/b.ts', 'src/a.ts', 'tests/c.test.ts']);
  });

  it('referenceCorpus reads the tracked files, so an untracked dependency tree is not the corpus (kanon#266)', () => {
    const root = repo({
      'src/a.ts': '', 'docs/d.md': '', '.github/scripts/g.mjs': '',
      'vendor/pkg/README.md': '', 'dist/bundle.mjs': '',
    }, ['src/a.ts', 'docs/d.md', '.github/scripts/g.mjs']);
    // Undeclared: the whole repository as git sees it — every tracked file, dot-directories
    // included, as `citation-shift` and `doc-path-guard` read it, and nothing git does not track.
    expect(referenceCorpus(root, [])).toEqual(['.github/scripts/g.mjs', 'docs/d.md', 'src/a.ts']);
    // Declared, the same read, narrowed to the trees.
    mkdirSync(join(root, 'docs/qa'), { recursive: true });
    writeFileSync(join(root, 'docs/qa/stack.md'), STACK('- `src/` — code: x'));
    git(root, 'add', 'docs/qa/stack.md');
    expect(referenceCorpus(root, [])).toEqual(['docs/d.md', 'docs/qa/stack.md', 'src/a.ts']);
  });

  it('referenceCorpus skips a dangling symlink instead of crashing on it (kanon#266)', () => {
    const files = { 'src/a.ts': '', 'tests/c.test.ts': '' };
    // Outside a git repository, the walk.
    const walked = tree(files);
    symlinkSync(join(walked, 'src/nowhere.ts'), join(walked, 'src/dangling.ts'));
    symlinkSync(join(walked, 'tests/nowhere.test.ts'), join(walked, 'tests/dangling.test.ts'));
    expect(referenceCorpus(walked, [])).toEqual(['src/a.ts', 'tests/c.test.ts']);
    // And inside one, where git tracks the dangling link as a file.
    const tracked = repo(files, []);
    symlinkSync(join(tracked, 'src/nowhere.ts'), join(tracked, 'src/dangling.ts'));
    git(tracked, 'add', '-A');
    expect(referenceCorpus(tracked, [])).toEqual(['src/a.ts', 'tests/c.test.ts']);
  });

  it('referenceCorpus walks a tree that is not a repository root, inside a repository or not (kanon#266)', () => {
    const root = repo({ 'sub/src/a.ts': '', 'sub/docs/d.md': '' }, []);
    expect(referenceCorpus(join(root, 'sub'), [])).toEqual(['docs/d.md', 'src/a.ts']);
  });

  it('referenceCorpus leaves out a tooling test only inside a test tree', () => {
    const tooling = "import { x } from '../scripts/qa/a.mjs';\n";
    const root = tree({
      'docs/qa/stack.md': STACK('- `src/` — code: x\n- `spec/` — tests: y'),
      'spec/tooling.test.ts': tooling,
      'src/tooling.ts': tooling,
    });
    expect(referenceCorpus(root, ['scripts/qa/'])).toEqual(['docs/qa/stack.md', 'src/tooling.ts']);
  });

  it('referenceCorpus leaves out the declared pipeline code, whose ids are fixtures', () => {
    const root = tree({
      'docs/qa/stack.md': STACK('- `scripts/` — code: scripts'),
      'scripts/seed.mjs': '', 'scripts/qa/guard.mjs': '',
    });
    expect(referenceCorpus(root, ['scripts/qa/'])).toEqual(['docs/qa/stack.md', 'scripts/seed.mjs']);
    expect(referenceCorpus(root, [])).toEqual(['docs/qa/stack.md', 'scripts/qa/guard.mjs', 'scripts/seed.mjs']);
  });

  it('referenceCorpus throws the declaration error on a malformed section', () => {
    expect(() => referenceCorpus(tree({ 'docs/qa/stack.md': STACK('- `src` — code: x') }), [])).toThrow(/a `code` area is a directory/);
  });
});

describe('doc-path-guard skips the declared test trees, and the convention without them', () => {
  const text = 'See `docs/missing.md`.\n';
  const findings = (file: string, areas: ReturnType<typeof parseCodeAreas>) => auditPaths([file], () => text, [file], [], areas).findings.length;

  it('skips a fixture in a declared test tree, and reads it outside one', () => {
    const areas = parseCodeAreas(STACK('- `spec/` — tests: the suite'));
    expect(findings('spec/fixtures/a.md', areas)).toBe(0);
    expect(findings('tests/fixtures/a.md', areas)).toBe(1);
  });

  it('without a declaration, skips what the language calls a test, and reads the rest', () => {
    expect(findings('tests/a.test.ts', UNDECLARED)).toBe(0);
    expect(findings('pkg/test_a.py', UNDECLARED)).toBe(0);
    expect(findings('tests/fixtures/a.md', UNDECLARED)).toBe(1);
  });

  it('needs the areas: a caller that forgets them fails, not reads everything', () => {
    // @ts-expect-error the fifth argument is required
    expect(() => auditPaths(['docs/a.md'], () => '', ['docs/a.md'], [])).toThrow(/declared code areas/);
  });
});

describe("Kanon's own stack document declares its code areas", () => {
  it('parses, and names the trees Kanon keeps code and tests in', () => {
    const a = parseCodeAreas(readFileSync(join(ROOT, 'docs/qa/stack.md'), 'utf8'));
    expect(a.code.map((c) => c.path)).toEqual(['scripts/', 'actions/', 'cli/', 'infra/', '.github/scripts/']);
    // The runner is named now that Kanon pins a release whose parser reads it (kanon#20, #482).
    expect(a.tests).toEqual([{ path: 'tests/', runner: 'vitest', what: 'the library and unit tests, and their fixtures' }]);
  });
});

describe("an omitted `## Code areas` is Kanon's default, and the readers name it (plan 0005 §5.2)", () => {
  it('names the default for an undeclared document, and nothing for a declared one', () => {
    expect(codeAreasDefaults(UNDECLARED)).toEqual([
      "docs/qa/stack.md declares no `## Code areas`, so Kanon's default applies: the code is the whole repository, and a test is what its language's convention calls one, in JavaScript and TypeScript a `*.test.*` or `*.spec.*` file that no runner runs (K-LAYOUT-17)",
    ]);
    expect(codeAreasDefaults(parseCodeAreas('## Gates\n'))).toHaveLength(1);
    expect(codeAreasDefaults(parseCodeAreas('## Code areas\n\n- `src/` — code: the app\n'))).toEqual([]);
    // Declared with no entries is a declaration, not an omission.
    expect(codeAreasDefaults(parseCodeAreas('## Code areas\n'))).toEqual([]);
  });
});
