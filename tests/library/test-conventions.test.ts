import { describe, expect, it } from 'vitest';
import {
  CONVENTIONS, RUNNERS, conventionFor, goMentions, goTestFunctions, goTitles, interpretGoJson, interpretJunit,
  isTestFile, pythonMentions, pythonTitles, runnerFor,
} from '../../scripts/lib/test-conventions.mjs';

/**
 * The per-language test conventions (kanon#20, ADR 0012): which files are tests, where a
 * test's title is, and how one file is run. Each reader is held to the same rule the
 * JavaScript scanner is: a spec id in a TITLE is a citation, one in a comment or docblock is a
 * mention, and one in fixture data is neither.
 */
describe('the table picks a row by the file, never by a setting', () => {
  it.each([
    ['tests/unit/a.test.ts', 'JavaScript and TypeScript', true],
    ['e2e/storefront.spec.ts', 'JavaScript and TypeScript', true],
    ['src/server/a.ts', 'JavaScript and TypeScript', false],
    ['tests/test_core.py', 'Python', true],
    ['src/orders/core_test.py', 'Python', true],
    ['tests/conftest.py', 'Python', false],
    ['src/orders/core.py', 'Python', false],
    ['internal/orders/core_test.go', 'Go', true],
    ['internal/orders/core.go', 'Go', false],
  ])('%s is %s, test file: %s', (path, language, test) => {
    expect(conventionFor(path)?.language).toBe(language);
    expect(isTestFile(path)).toBe(test);
  });

  it('a language not in the table is never a test file, so nothing it asserts is counted', () => {
    for (const p of ['tests/core_test.rs', 'src/test/java/OrderTest.java', 'tests/README.md']) {
      expect(conventionFor(p)).toBeUndefined();
      expect(isTestFile(p)).toBe(false);
      expect(runnerFor(p)).toBe('unknown');
    }
  });

  it('every row names a runner that runs one file, and none of them is npx', () => {
    for (const row of CONVENTIONS) expect(row.titleConvention).not.toBe('');
    const goFile = 'package orders\nfunc TestPlace(t *testing.T) {}\n';
    for (const [name, make] of Object.entries(RUNNERS)) {
      const cmd = make('tests/x', '/out', () => goFile);
      expect(cmd, name).not.toBeNull();
      expect(cmd!.bin, name).not.toMatch(/\bnpx\b/);
    }
  });
});

describe('Python: the title is the summary line of a test function’s docstring', () => {
  const src = [
    '# A comment naming [ORD-9] is a mention, not a title.',
    'import pytest',
    'FIXTURE = "def test_fake():\\n    \\"\\"\\"[ORD-8] inside a string\\"\\"\\""',
    '',
    'def test_one():',
    '    """[ORD-1] Placing twice records once.',
    '',
    '    A body line naming [ORD-7] is a mention.',
    '    """',
    '',
    'async def test_two(',
    '    client: dict[str, int],  # a comment in the signature',
    ') -> None:  # and after it',
    "    r'''[ORD-2] a raw, single-quoted docstring'''",
    '',
    'class TestOrders:',
    '    def test_three(self):',
    '        """',
    '        [ORD-3] the summary is the first non-empty line',
    '        """',
    '',
    '    def helper(self):',
    '        """[ORD-6] not a test function"""',
    '',
    'def test_no_docstring():',
    '    assert "[ORD-5]" == "[ORD-5]"',
  ].join('\n');

  it('reads each test’s summary line, and nothing else', () => {
    expect(pythonTitles(src).split('\n')).toEqual([
      '[ORD-1] Placing twice records once.',
      '[ORD-2] a raw, single-quoted docstring',
      '[ORD-3] the summary is the first non-empty line',
    ]);
  });

  it('mentions keep comments and docstrings, and blank every other string', () => {
    const m = pythonMentions(src);
    for (const id of ['ORD-9', 'ORD-7', 'ORD-6', 'ORD-1']) expect(m).toContain(`[${id}]`);
    for (const id of ['ORD-8', 'ORD-5']) expect(m).not.toContain(`[${id}]`);
    expect(m.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('a string prefix ending an identifier is not a prefix', () => {
    // `elif"…"` is not valid Python, but `if"x"` is: the `f` belongs to `if`.
    expect(pythonMentions('if"[ORD-1]": pass').includes('[ORD-1]')).toBe(false);
  });
});

describe('Go: the title is a subtest’s name, the literal first argument of t.Run', () => {
  const src = [
    'package orders',
    '',
    '// TestPlace covers [ORD-9] in a comment: a mention, not a title.',
    'func TestPlace(t *testing.T) {',
    '\tt.Run("[ORD-1] placing twice records once", func(t *testing.T) {})',
    '\tt.Run(`[ORD-2] a raw string name`, func(t *testing.T) {})',
    '\tfor _, tc := range cases { t.Run(tc.name, func(t *testing.T) {}) }',
    '\tfixture := "t.Run(\\"[ORD-8] inside a string\\", nil)"',
    '\t_ = fixture',
    '\tcmd.Run()',
    '}',
    '',
    'func TestMain(m *testing.M) {}',
    'func Testhelper(t *testing.T) {}',
    'func TestRefund_Twice(t *testing.T) {}',
  ].join('\n');

  it('reads literal subtest names only', () => {
    expect(goTitles(src).split('\n')).toEqual(['[ORD-1] placing twice records once', '[ORD-2] a raw string name']);
  });

  it('mentions keep comments and blank strings', () => {
    const m = goMentions(src);
    expect(m).toContain('[ORD-9]');
    expect(m).not.toContain('[ORD-8]');
  });

  it('names the test functions `go test -run` selects, and not TestMain or a lowercase helper', () => {
    expect(goTestFunctions(src)).toEqual(['TestPlace', 'TestRefund_Twice']);
  });
});

describe('the runners’ reports', () => {
  const junit = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite name="pytest">${cases}</testsuite></testsuites>`;

  it('JUnit (pytest): a pass, a failure, an error at collection, and nothing run', () => {
    expect(interpretJunit(junit('<testcase classname="t" name="a" time="0"/><testcase classname="t" name="b"></testcase>'))).toBe(true);
    expect(interpretJunit(junit('<testcase name="a"/><testcase name="b"><failure message="x">t</failure></testcase>'))).toBe(false);
    expect(interpretJunit(junit('<testcase classname="" name="tests.test_core"><error message="collection failure">ImportError</error></testcase>'))).toBe(false);
    expect(interpretJunit(junit('<testcase name="a"><skipped message="s"/></testcase>'))).toBeUndefined();
    expect(interpretJunit(junit(''))).toBeUndefined();
  });

  const ev = (o: object) => JSON.stringify(o);
  it('go test -json: per top-level test, a build failure is false, and silence is undefined', () => {
    const pass = [ev({ Action: 'run', Test: 'TestPlace' }), ev({ Action: 'pass', Test: 'TestPlace/[ORD-1]_x' }), ev({ Action: 'pass', Test: 'TestPlace' }), ev({ Action: 'pass' })].join('\n');
    expect(interpretGoJson(pass)).toBe(true);
    const fail = [ev({ Action: 'fail', Test: 'TestPlace/[ORD-1]_x' }), ev({ Action: 'fail', Test: 'TestPlace' }), ev({ Action: 'pass', Test: 'TestOther' })].join('\n');
    expect(interpretGoJson(fail)).toBe(false);
    expect(interpretGoJson([ev({ Action: 'build-fail', ImportPath: 'x' }), ev({ Action: 'fail', Package: 'x' })].join('\n'))).toBe(false);
    expect(interpretGoJson('not json\n')).toBeUndefined();
    expect(interpretGoJson([ev({ Action: 'skip', Test: 'TestPlace' })].join('\n'))).toBeUndefined();
  });
});
