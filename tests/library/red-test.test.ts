import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { UNDECLARED, parseCodeAreas } from '../../scripts/lib/code-areas.mjs';
import {
  changedFiles, classify, dirtyPaths, exitCodeFor, materialise, narrowRunnable, planOutput, readResult, runFiles,
  tierOf, verdict, withMaterialised,
} from '../../scripts/red-test.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * The red-test check (`K-MERGE-13`), moved from the reference adopter (plan 0001 §7): its tests,
 * generalised from the adopter's stack to the stack document's declarations, plus the cases that
 * show the check end to end on a real repository and a real runner.
 *
 * Two findings these assertions encode exist only because the approach was measured against real
 * merged PRs in the reference adopter before it was built:
 *
 *  • **Which runner runs a file is load-bearing.** A PR there changed a unit test AND an
 *    integration test; a job that ran one tier only never ran the file where the sensitivity
 *    lived, and reported "still green": a false block. Here the runner is the file's own, by the
 *    test-convention table and the declared trees.
 *  • **Collection errors must not read as assertion failures.** One PR ran 52 tests at head and 18
 *    on the reverted tree: 34 never executed, while the run still "looked red for the right
 *    reason". Folding the weak case into the strong one is how this job would launder its own
 *    evidence.
 */

/** The reference adopter's shape, as a project now declares it (`K-LAYOUT-17`). */
const AREAS = parseCodeAreas([
  '## Code areas',
  '',
  '- `src/` — code: the application',
  '- `tests/` `vitest` — tests: unit and integration tests',
  '- `e2e/` `playwright` — tests: the browser suite',
  '',
].join('\n'));

/** The runner's report shape: a file that could not LOAD is `failed` with zero assertions. */
const res = (file: string, failed: number, passed = 0, status = 'passed') =>
  ({ file: `/repo/${file}`, failed, passed, status });

describe('tierOf: the runner is the declared tree\'s, or the language\'s (ADR 0012)', () => {
  it('runs a test in a tree that names Vitest with Vitest', () => {
    expect(tierOf('tests/unit/orders-gate.test.ts', AREAS)).toBe('vitest');
    expect(tierOf('tests/orders-trace.test.ts', AREAS)).toBe('vitest');
  });

  it('declines a browser suite: it needs a built app and is out of scope', () => {
    expect(tierOf('e2e/home.spec.ts', AREAS)).toBe('browser');
  });

  it('runs a Python test with pytest and a Go test with go test, whatever the trees say', () => {
    expect(tierOf('tests/test_orders.py', AREAS)).toBe('pytest');
    expect(tierOf('pkg/orders/orders_test.go', AREAS)).toBe('go');
  });

  it('never picks a JavaScript runner the project did not name', () => {
    // The adopter ran a co-located `src/**/*.test.ts` in its integration tier because its own
    // Vitest config said so; Kanon reads no runner config, and a tree is a directory of tests.
    expect(tierOf('src/server/services/foo.test.ts', AREAS)).toBe('none');
    expect(tierOf('tests/unit/a.test.ts', UNDECLARED)).toBe('none');
  });

  it('reads a helper or setup file as collected by nothing: the harness', () => {
    expect(tierOf('tests/setup.ts', AREAS)).toBeNull();
    expect(tierOf('tests/helpers/seed.ts', AREAS)).toBeNull();
    expect(tierOf('tests/conftest.py', AREAS)).toBeNull();
  });
});

describe('classify', () => {
  it('separates the test half from the source half', () => {
    const c = classify([
      'src/server/services/orders.ts',
      'tests/unit/foo.test.ts',
      'docs/qa/specs/orders.md',
      '.github/workflows/ci.yml',
      'package.json',
    ], AREAS);
    expect(c.src).toEqual(['src/server/services/orders.ts']);
    expect(c.tests).toEqual(['tests/unit/foo.test.ts']);
  });

  it('does not treat docs, workflows, manifests or lockfiles as source', () => {
    // The manifests in particular: the install runs BEFORE the revert, so reverting one would break
    // the run for a reason unrelated to the claim being checked.
    const c = classify(['package.json', 'package-lock.json', 'pyproject.toml', 'go.mod', 'docs/x.md', '.github/workflows/ci.yml'], AREAS);
    expect(c.src).toEqual([]);
  });

  it('treats a root-level config a test reads as source, wherever the declared code trees are', () => {
    // The adopter's KNOWN LIMIT, closed there by naming its infrastructure config: a PR whose
    // payload was one entry in it, plus a comment touch-up in `src/`, was falsely blocked, because
    // the comment revert changed nothing and the clause the test asserts on was never reverted.
    // Here every source file the PR changed is reverted, so no name is needed.
    const c = classify(['infra.config.ts', 'src/server/observability/server-error.ts', 'tests/unit/a.test.ts'], AREAS);
    expect(c.src).toEqual(['infra.config.ts', 'src/server/observability/server-error.ts']);
    expect(classify(['infra/paging.ts', 'tests/unit/paging.test.ts'], AREAS).src).toEqual(['infra/paging.ts']);
  });

  it('still excludes the config files that configure the runner doing the verifying', () => {
    // Named by the runners' own file names, not a `*.config.*` glob: reverting the runner's config
    // mid-job breaks the run for a cause unrelated to the claim.
    const c = classify(['vitest.config.ts', 'vitest.workspace.ts', 'playwright.config.ts', 'packages/web/vitest.config.mts'], AREAS);
    expect(c.src).toEqual([]);
    expect(c.unreverted).toEqual(['vitest.config.ts', 'vitest.workspace.ts', 'playwright.config.ts', 'packages/web/vitest.config.mts']);
    // A project's other configs are source: a test can read one, and none configures the run.
    expect(classify(['next.config.ts', 'eslint.config.mjs'], AREAS).src).toEqual(['next.config.ts', 'eslint.config.mjs']);
  });

  it('keeps a co-located test on the TEST side, not the source side', () => {
    // Reverting it would delete the very evidence being examined.
    const c = classify(['src/lib/pricing.test.ts', 'src/lib/pricing.ts'], AREAS);
    expect(c.tests).toEqual(['src/lib/pricing.test.ts']);
    expect(c.src).toEqual(['src/lib/pricing.ts']);
  });

  it('reports a browser suite as skipped rather than dropping it silently', () => {
    const c = classify(['e2e/orders.spec.ts', 'tests/unit/a.test.ts'], AREAS);
    expect(c.skipped).toEqual(['e2e/orders.spec.ts']);
    expect(c.browserSkipped).toEqual(['e2e/orders.spec.ts']);
    expect(c.runnable).toEqual(['tests/unit/a.test.ts']);
  });

  it('reads a Python project by its own convention, with conftest.py as harness', () => {
    const c = classify(['src/orders/core.py', 'tests/test_core.py', 'tests/conftest.py', 'docs/design.md'], UNDECLARED);
    expect(c.src).toEqual(['src/orders/core.py']);
    expect(c.runnable).toEqual(['tests/test_core.py']);
    expect(c.unrevertedTests).toEqual(['tests/conftest.py']);
    expect(c.unreverted).toEqual(['docs/design.md']);
  });

  it('reads a Go project by its own convention', () => {
    const c = classify(['pkg/orders/orders.go', 'pkg/orders/orders_test.go'], UNDECLARED);
    expect(c.src).toEqual(['pkg/orders/orders.go']);
    expect(c.runnable).toEqual(['pkg/orders/orders_test.go']);
  });

  it('with no tests tree declared, a JavaScript test is reported as having no runner, never run', () => {
    const c = classify(['src/a.ts', 'tests/unit/a.test.ts'], UNDECLARED);
    expect(c.runnable).toEqual([]);
    expect(c.noRunner).toEqual(['tests/unit/a.test.ts']);
    // An undeclared helper is not a test by any convention, so it is source, and reverted.
    expect(classify(['tests/helpers.ts'], UNDECLARED).src).toEqual(['tests/helpers.ts']);
  });

  it('treats every file in a declared tests tree as test side, fixtures included', () => {
    const c = classify(['tests/fixtures/orders.json', 'tests/fixtures/app/src/x.ts'], AREAS);
    expect(c.src).toEqual([]);
    expect(c.unreverted).toEqual([]);
    expect(c.unrevertedTests).toEqual(['tests/fixtures/orders.json', 'tests/fixtures/app/src/x.ts']);
  });
});

describe('narrowRunnable: the half a regression landed in', () => {
  /**
   * Narrowing the WHOLE diff by "exists at head", to kill a phantom row from a renamed test,
   * stripped DELETED source files out of the revert set too, so the reverted tree was no longer
   * the base tree, re-opening the same fail-open hole on a new shape.
   */
  const exists = (f: string) => !f.includes('deleted');

  it('drops a deleted test path from what the runner is given', () => {
    const r = narrowRunnable(['tests/unit/deleted.test.ts', 'tests/unit/live.test.ts'], exists);
    expect(r.runnable).toEqual(['tests/unit/live.test.ts']);
  });

  it('still REPORTS the deleted test rather than letting it vanish', () => {
    const r = narrowRunnable(['tests/unit/deleted.test.ts'], exists);
    expect(r.deletedTests).toEqual(['tests/unit/deleted.test.ts']);
  });

  it('is never applied to source: a deleted source file MUST stay in the revert set', () => {
    const c = classify(['src/deleted-helper.ts', 'src/caller.ts', 'tests/unit/a.test.ts'], AREAS);
    expect(c.src).toEqual(['src/deleted-helper.ts', 'src/caller.ts']);
  });
});

describe('verdict', () => {
  it('blocks when every changed test still passes', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [res('tests/unit/a.test.ts', 0, 5)] });
    expect(v.blocked).toBe(true);
    expect(v.passed).toBe(1);
  });

  it('passes on an assertion failure and calls it strong', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [res('tests/unit/a.test.ts', 3, 2)] });
    expect(v.blocked).toBe(false);
    expect(v.strong).toBe(1);
    expect(v.weak).toBe(0);
  });

  it('treats ABSENCE from the report as no data, never as evidence', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [] });
    expect(v.byFile[0].outcome).toBe('no-data');
    expect(v.weak).toBe(0);
    expect(v.inconclusive).toBe(true);
  });

  it('BLOCKS a vacuous test that a renamed file would otherwise launder', () => {
    const v = verdict({
      expected: ['tests/unit/old.test.ts', 'tests/unit/new.test.ts'],
      results: [res('tests/unit/new.test.ts', 0, 3)],
    });
    expect(v.blocked).toBe(true);
  });

  it('is INCONCLUSIVE, not a pass, when the runner produced nothing', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [], ran: false });
    expect(v.inconclusive).toBe(true);
    expect(v.blocked).toBe(false);
    expect(exitCodeFor(v)).toBe(1);
  });

  it('reads a file that FAILED with zero assertions as not-collected, not as passed', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [res('tests/unit/a.test.ts', 0, 0, 'failed')] });
    expect(v.byFile[0].outcome).toBe('not-collected');
    expect(v.blocked).toBe(false);
    expect(v.weak).toBe(1);
  });

  it('does not block when only ONE of several changed tests is sensitive', () => {
    const v = verdict({
      expected: ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'],
      results: [res('tests/unit/a.test.ts', 1), res('tests/unit/b.test.ts', 0, 4)],
    });
    expect(v.blocked).toBe(false);
    expect(v.byFile.find((f) => f.file.endsWith('b.test.ts'))?.outcome).toBe('passed');
  });

  it('matches a result to its file by a whole path segment, never by a suffix of a name', () => {
    // `tests/unit/b.test.ts` must not be read as `tests/unit/ab.test.ts`'s result.
    const v = verdict({ expected: ['b.test.ts'], results: [{ file: '/repo/ab.test.ts', failed: 2, passed: 0, status: 'failed' }] });
    expect(v.byFile[0].outcome).toBe('no-data');
  });
});

describe('a BLOCK must be about the change it reverted', () => {
  const green = (file: string) => ({ file: `/repo/${file}`, failed: 0, passed: 3, status: 'passed' });

  it('names the files it could not revert', () => {
    const c = classify(['docs/observability.md', 'migrations/0007_x.sql', 'src/a.ts', 'tests/unit/a.test.ts'], AREAS);
    expect(c.unreverted).toEqual(['docs/observability.md', 'migrations/0007_x.sql']);
    expect(c.src, 'and still reverts what it can').toEqual(['src/a.ts']);
  });

  it('does NOT block when an unreverted file is in the diff, AND STILL REFUSES', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [green('tests/unit/a.test.ts')], unreverted: ['docs/observability.md'] });
    expect(v.blocked, 'the evidence does not support a block').toBe(false);
    expect(v.unverifiable).toBe(true);
    expect(exitCodeFor(v), 'naming a limitation must not become a bypass').toBe(1);
  });

  it('still blocks on a diff where everything WAS reverted', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [green('tests/unit/a.test.ts')], unreverted: [] });
    expect(v.blocked).toBe(true);
    expect(exitCodeFor(v)).toBe(1);
  });

  it('an unreverted file does not rescue a diff that has real evidence either way', () => {
    const v = verdict({ expected: ['tests/unit/a.test.ts'], results: [res('tests/unit/a.test.ts', 2, 1, 'failed')], unreverted: ['docs/observability.md'] });
    expect(v.blocked).toBe(false);
    expect(v.strong).toBe(1);
    expect(v.unverifiable, 'strong evidence is not unverifiable').toBe(false);
    expect(exitCodeFor(v), 'a PR with real evidence still passes').toBe(0);
  });
});

describe('the file set is the PR\'s own diff, not the base branch tip', () => {
  it('diffs against the merge base, and reverts from it too', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'merge-base') return 'mb123\n';
      if (args[0] === 'diff') return 'scripts/red-test.mjs\ntests/unit/red-test.test.ts\n';
      throw new Error(`unrouted: ${args.join(' ')}`);
    };
    const { diffBase, files } = changedFiles('basetip', 'headsha', { run });
    expect(calls[0]).toEqual(['merge-base', 'basetip', 'headsha']);
    expect(calls[1], 'the diff is against the merge base, never the base branch tip').toEqual(['diff', '--name-only', 'mb123', 'headsha']);
    expect(diffBase).toBe('mb123');
    expect(files).toEqual(['scripts/red-test.mjs', 'tests/unit/red-test.test.ts']);
  });

  it('fails closed when the merge base cannot be computed', () => {
    const boom = () => { throw new Error('fatal: refusing to work with a shallow repo'); };
    expect(() => changedFiles('b', 'h', { run: boom })).toThrow(/merge base/i);
    expect(() => changedFiles('b', 'h', { run: boom })).toThrow(/fetch-depth/);
    const empty = (args: string[]) => (args[0] === 'merge-base' ? '\n' : '');
    expect(() => changedFiles('b', 'h', { run: empty })).toThrow(/refusing to guess/);
  });

  it('a foreign runnable test would supply the evidence, which is why the set must be narrow', () => {
    const wide = classify(['src/red.ts', 'tests/unit/red.test.ts', 'src/gate.ts', 'tests/unit/gate.test.ts', 'CHANGELOG.md', 'package-lock.json'], AREAS);
    expect(wide.runnable).toContain('tests/unit/gate.test.ts');
    const v = verdict({
      expected: wide.runnable,
      results: [res('tests/unit/red.test.ts', 0, 5), res('tests/unit/gate.test.ts', 3, 2, 'failed')],
      unreverted: wide.unreverted,
    });
    expect(v.blocked, 'one foreign 🔴 is enough to clear the block').toBe(false);
    const narrow = classify(['src/red.ts', 'tests/unit/red.test.ts'], AREAS);
    const n = verdict({ expected: narrow.runnable, results: [res('tests/unit/red.test.ts', 0, 5)], unreverted: narrow.unreverted });
    expect(n.blocked, 'alone, the vacuous test proves nothing').toBe(true);
    expect(exitCodeFor(n)).toBe(1);
  });

  it("the default branch's routine churn also relabels a genuine BLOCK as UNVERIFIABLE", () => {
    const wide = classify(['src/red.ts', 'tests/unit/red.test.ts', 'CHANGELOG.md', 'package-lock.json'], AREAS);
    const v = verdict({ expected: wide.runnable, results: [res('tests/unit/red.test.ts', 0, 5)], unreverted: wide.unreverted });
    expect(v.blocked).toBe(false);
    expect(v.unverifiable, 'the right diagnosis is lost, though both still refuse').toBe(true);
    expect(exitCodeFor(v)).toBe(1);
  });
});

describe('an unreverted test harness cannot manufacture a weak pass', () => {
  it('classify names them, in their own inventory', () => {
    const c = classify(['src/a.ts', 'tests/setup.ts', 'tests/helpers/seed.ts', 'tests/unit/a.test.ts'], AREAS);
    expect(c.unrevertedTests).toEqual(['tests/setup.ts', 'tests/helpers/seed.ts']);
    expect(c.src, 'they are not reverted: the harness the run depends on').not.toContain('tests/setup.ts');
    expect(c.unreverted, 'and the unreverted inventory stays about NON-test files').toEqual([]);
  });

  it('refuses an all-not-collected result when a harness file changed', () => {
    const c = classify(['src/a.ts', 'tests/setup.ts', 'tests/unit/a.test.ts'], AREAS);
    const v = verdict({ expected: c.runnable, results: [res('tests/unit/a.test.ts', 0, 0, 'failed')], unreverted: c.unreverted, unrevertedTests: c.unrevertedTests });
    expect(v.strong).toBe(0);
    expect(v.weakOnUnrevertedHarness).toBe(true);
    expect(exitCodeFor(v), 'a pass here would be decided by an unnamed file').toBe(1);
  });

  it('still passes weakly when no harness file changed', () => {
    const c = classify(['src/a.ts', 'tests/unit/a.test.ts'], AREAS);
    const v = verdict({ expected: c.runnable, results: [res('tests/unit/a.test.ts', 0, 0, 'failed')], unreverted: c.unreverted, unrevertedTests: c.unrevertedTests });
    expect(v.weakOnUnrevertedHarness).toBe(false);
    expect(exitCodeFor(v), 'a weak pass is still a pass').toBe(0);
  });

  it('a browser spec or a test with no runner alone does not trip it: the reverted run never loads one', () => {
    const c = classify(['src/new.ts', 'tests/unit/new.test.ts', 'e2e/new.spec.ts', 'src/other.test.ts'], AREAS);
    expect(c.unrevertedTests, 'out of the harness set').toEqual([]);
    expect(c.browserSkipped).toEqual(['e2e/new.spec.ts']);
    expect(c.noRunner).toEqual(['src/other.test.ts']);
    const v = verdict({ expected: c.runnable, results: [res('tests/unit/new.test.ts', 0, 0, 'failed')], unreverted: c.unreverted, unrevertedTests: c.unrevertedTests });
    expect(v.weakOnUnrevertedHarness).toBe(false);
    expect(exitCodeFor(v), 'the new-module-plus-browser-spec shape must stay green').toBe(0);
  });

  it("derives the harness set and the report's split from ONE expression", () => {
    const c = classify(['src/a.ts', 'tests/unit/a.test.ts', 'tests/setup.ts', 'tests/helpers/x.ts', 'e2e/a.spec.ts', 'src/b.test.ts'], AREAS);
    expect([...c.browserSkipped, ...c.noRunner, ...c.unrevertedTests].sort()).toEqual([...c.skipped].sort());
    expect(new Set([...c.browserSkipped, ...c.noRunner, ...c.unrevertedTests]).size, 'and they do not overlap').toBe(c.skipped.length);
  });

  it('a single assertion failure clears it, so the innocent case stays green', () => {
    const c = classify(['src/a.ts', 'tests/setup.ts', 'tests/unit/a.test.ts', 'tests/unit/b.test.ts'], AREAS);
    const v = verdict({
      expected: c.runnable,
      results: [res('tests/unit/a.test.ts', 3, 2, 'failed'), res('tests/unit/b.test.ts', 0, 0, 'failed')],
      unreverted: c.unreverted,
      unrevertedTests: c.unrevertedTests,
    });
    expect(v.strong).toBe(1);
    expect(v.weakOnUnrevertedHarness).toBe(false);
    expect(exitCodeFor(v)).toBe(0);
  });
});

describe('a PR whose only source is a script outside the application is not green for free', () => {
  // In the adopter, a pattern of source directories left out its CI scripts, then its lint
  // rules, then its infrastructure, and each time a PR confined to one took the "no source file
  // changed" skip: a free green. Reading every source file by its language closes the class.
  it.each([
    ['.github/scripts/weekly-digest.mjs', 'tests/unit/weekly-digest.test.ts'],
    ['.github/actions/classify/classify.mjs', 'tests/unit/classify.test.ts'],
    ['eslint-rules/no-unescaped-html.mjs', 'tests/unit/eslint-no-unescaped-html.test.ts'],
    ['.github/scripts/check-title.sh', 'tests/unit/check-title.test.ts'],
  ])('%s is revertible source, so a vacuous test blocks', (src, test) => {
    const c = classify([src, test], AREAS);
    expect(c.src).toEqual([src]);
    const v = verdict({ expected: c.runnable, results: [res(test, 0, 5)], unreverted: c.unreverted, unrevertedTests: c.unrevertedTests });
    expect(v.blocked).toBe(true);
    expect(exitCodeFor(v)).toBe(1);
  });

  it('does NOT swallow workflow files, action metadata, issue templates, READMEs or JSON', () => {
    for (const f of ['.github/workflows/agent-review.yml', '.github/actions/classify/action.yml', '.github/ISSUE_TEMPLATE/bug.yml', 'eslint-rules/README.md', 'eslint-rules/fixtures/x.json']) {
      const c = classify([f], AREAS);
      expect(c.src, `${f} must not be reverted`).toEqual([]);
      expect(c.unreverted, `${f} must still be named`).toEqual([f]);
    }
  });
});

describe('readResult: each runner\'s report, in the shape the verdict reads', () => {
  it('Vitest: assertions counted, a file that could not load is failed with none', () => {
    const report = { testResults: [
      { name: '/w/tests/a.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }, { status: 'passed' }] },
      { name: '/w/tests/b.test.ts', status: 'failed', assertionResults: [] },
    ] };
    expect(readResult('vitest', report, 'tests/a.test.ts')).toEqual({ file: 'tests/a.test.ts', status: 'failed', failed: 1, passed: 1 });
    expect(readResult('vitest', report, 'tests/b.test.ts')).toEqual({ file: 'tests/b.test.ts', status: 'failed', failed: 0, passed: 0 });
    expect(readResult('vitest', report, 'tests/c.test.ts'), 'absent is no data').toBeNull();
    expect(readResult('vitest', { testResults: [] }, 'tests/a.test.ts')).toBeNull();
  });

  it('pytest: a failure is an assertion, a collection error is a file that could not load', () => {
    const xml = '<testsuite><testcase name="test_a"><failure message="assert"/></testcase><testcase name="test_b"/></testsuite>';
    expect(readResult('pytest', xml, 'tests/test_x.py')).toEqual({ file: 'tests/test_x.py', status: 'failed', failed: 1, passed: 1 });
    const collection = '<testsuite><testcase classname="" name="tests.test_x"><error message="collection failure">ImportError</error></testcase></testsuite>';
    expect(readResult('pytest', collection, 'tests/test_x.py')).toEqual({ file: 'tests/test_x.py', status: 'failed', failed: 0, passed: 0 });
    expect(readResult('pytest', '<testsuite tests="0"></testsuite>', 'tests/test_x.py')).toBeNull();
    expect(readResult('pytest', null, 'tests/test_x.py')).toBeNull();
  });

  it('go test: a top-level fail is an assertion, a package that did not build could not load', () => {
    const ev = (o: object) => JSON.stringify(o);
    const ran = [ev({ Action: 'pass', Test: 'TestA' }), ev({ Action: 'fail', Test: 'TestB' }), ev({ Action: 'fail', Test: 'TestB/sub' })].join('\n');
    expect(readResult('go', ran, 'pkg/x_test.go')).toEqual({ file: 'pkg/x_test.go', status: 'failed', failed: 1, passed: 1 });
    const broken = ev({ Action: 'fail', Package: 'example/pkg' });
    expect(readResult('go', broken, 'pkg/x_test.go')).toEqual({ file: 'pkg/x_test.go', status: 'failed', failed: 0, passed: 0 });
    expect(readResult('go', '', 'pkg/x_test.go')).toBeNull();
  });
});

describe('runFiles: one file at a time, through the table\'s command, never a package runner', () => {
  const TREES = AREAS.tests;

  it('runs each file with its runner and reads its report back', () => {
    const seen: string[][] = [];
    const exec = (bin: string, args: string[]) => {
      seen.push([bin, ...args]);
      const out = args.find((a) => a.startsWith('--outputFile='))?.slice('--outputFile='.length) ?? args.find((a) => a.startsWith('--junitxml='))?.slice('--junitxml='.length);
      if (bin.endsWith('vitest')) writeFileSync(out as string, JSON.stringify({ testResults: [{ name: `/w/${args[1]}`, status: 'failed', assertionResults: [{ status: 'failed' }] }] }));
      if (bin === 'python') writeFileSync(out as string, '<testsuite><testcase name="t"/></testsuite>');
      throw Object.assign(new Error('exit 1'), { stdout: '' });
    };
    const r = runFiles(['tests/unit/a.test.ts', 'tests/test_b.py'], { trees: TREES, exec });
    expect(seen.map((s) => s[0])).toEqual(['node_modules/.bin/vitest', 'python']);
    expect(r.ran).toBe(true);
    expect(r.results).toEqual([
      { file: 'tests/unit/a.test.ts', status: 'failed', failed: 1, passed: 0 },
      { file: 'tests/test_b.py', status: 'passed', failed: 0, passed: 1 },
    ]);
  });

  it('a run that wrote no report at all makes the whole run not-ran: inconclusive, never evidence', () => {
    const exec = (bin: string, args: string[]) => {
      const out = args.find((a) => a.startsWith('--outputFile='))?.slice('--outputFile='.length);
      if (args[1] === 'tests/unit/a.test.ts') writeFileSync(out as string, JSON.stringify({ testResults: [{ name: '/w/tests/unit/a.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] }] }));
      throw new Error(`spawn ${bin} ENOENT`);
    };
    const r = runFiles(['tests/unit/a.test.ts', 'tests/unit/b.test.ts'], { trees: TREES, exec });
    expect(r.ran, 'even though the other file gave a clean 🔴').toBe(false);
    expect(verdict({ expected: ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'], results: r.results, ran: r.ran }).inconclusive).toBe(true);
  });

  it('reads go test\'s report from its standard output', () => {
    const exec = () => `${JSON.stringify({ Action: 'fail', Test: 'TestA' })}\n`;
    const r = runFiles(['pkg/a_test.go'], { trees: TREES, exec, read: () => 'package a\nimport "testing"\nfunc TestA(t *testing.T) {}\n' });
    expect(r).toEqual({ ran: true, results: [{ file: 'pkg/a_test.go', status: 'failed', failed: 1, passed: 0 }] });
  });
});

describe('the tree the job borrowed is the tree it gives back', () => {
  const recorder = () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'cat-file' && args[2].startsWith('base:')) throw new Error('not in base');
      return '';
    };
    return { calls, run };
  };

  it('materialises at whichever ref it is given: the revert and the restore are one function', () => {
    const { calls, run } = recorder();
    materialise(['src/a.ts'], 'head', { run });
    expect(calls).toContainEqual(['checkout', 'head', '--', 'src/a.ts']);
  });

  it('removes a path the ref does not have, in BOTH directions', () => {
    // A REAL file on disk, because the removal is guarded by `existsSync`.
    const dir = mkdtempSync(join(tmpdir(), 'red-test-'));
    const added = join(dir, 'added.ts');
    writeFileSync(added, 'export const x = 1;\n');
    try {
      const { calls, run } = recorder();
      materialise([added], 'base', { run });
      expect(calls.some((c) => c[0] === 'rm'), 'absent at base -> removed').toBe(true);
      const back = recorder();
      materialise([added], 'head', { run: back.run });
      expect(back.calls).toContainEqual(['checkout', 'head', '--', added]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports uncommitted work in the revert set instead of overwriting it', () => {
    const run = () => ' M src/a.ts\n?? src/b.ts\n';
    expect(dirtyPaths(['src/a.ts', 'src/b.ts'], { run })).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('is empty on a clean tree, so CI never sees the refusal', () => {
    expect(dirtyPaths(['src/a.ts'], { run: () => '' })).toEqual([]);
    let called = false;
    expect(dirtyPaths([], { run: () => { called = true; return ''; } })).toEqual([]);
    expect(called).toBe(false);
  });

  it('a refusal exits 1: it could not verify the claim, which is what every other 1 means', () => {
    expect(exitCodeFor({ refused: true })).toBe(1);
    expect(exitCodeFor({ skipped: true })).toBe(0);
    expect(exitCodeFor({ dryRun: true })).toBe(0);
  });
});

describe('withMaterialised: the restore is guaranteed, not remembered', () => {
  const spy = () => {
    const refs: string[] = [];
    return { refs, m: (_p: string[], ref: string) => { refs.push(ref); } };
  };

  it('reverts, runs, restores, in that order', () => {
    const { refs, m } = spy();
    const order: string[] = [];
    withMaterialised({ paths: ['src/a.ts'], ref: 'mergebase', restoreRef: 'head', body: () => order.push('ran'), materialise: m });
    expect(refs).toEqual(['mergebase', 'head']);
    expect(order).toEqual(['ran']);
  });

  it('restores even when the runner throws', () => {
    const { refs, m } = spy();
    expect(() => withMaterialised({ paths: ['src/a.ts'], ref: 'mergebase', restoreRef: 'head', body: () => { throw new Error('runner exploded'); }, materialise: m })).toThrow(/exploded/);
    expect(refs).toEqual(['mergebase', 'head']);
  });

  it('hands back whatever the body returned', () => {
    const { m } = spy();
    expect(withMaterialised({ paths: [], ref: 'a', restoreRef: 'b', body: () => ({ ok: true }), materialise: m })).toEqual({ ok: true });
  });
});

describe('the reusable workflow', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/red-test.yml'), 'utf8');
  const wf = parse(text);
  type Step = { uses?: string; run?: string; id?: string; name?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  const steps = (job: string): Step[] => wf.jobs[job].steps;

  it('is called, takes no secret and no input, and reads the repository only', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    expect(wf.on.workflow_call).toBeNull();
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(wf.jobs) as Array<{ secrets?: unknown, permissions?: unknown }>) {
      expect(job.secrets).toBeUndefined();
      expect(job.permissions).toBeUndefined();
    }
    expect(text).not.toMatch(/secrets\./);
  });

  it('names the check-runs, because a ruleset would match one by literal string', () => {
    expect(wf.jobs.verify.name).toBe('Red-test verification');
    expect(wf.jobs.scope.name).toBe('Red-test scope');
  });

  it('runs only where "confirmed it fails" was claimed, by an agent\'s label', () => {
    expect(wf.jobs.scope.if).toContain("contains(github.event.pull_request.labels.*.name, 'agent:implement')");
    expect(wf.jobs.scope.if).toContain("contains(github.event.pull_request.labels.*.name, 'agent:triage')");
    expect(wf.jobs.verify.needs).toBe('scope');
  });

  it('concludes SKIPPED, not SUCCESS, when there is nothing to verify', () => {
    expect(wf.jobs.verify.if).toBe("needs.scope.outputs.verify == 'true'");
    expect(wf.jobs.scope.outputs.verify).toBe('${{ steps.plan.outputs.verify }}');
    const plan = steps('scope').find((s) => s.id === 'plan') as Step;
    expect(plan.run).toContain('node "$KANON/scripts/red-test.mjs" --plan');
    expect(plan.run).toContain('PIPESTATUS[0]');
  });

  it('runs the verifier from Kanon at the caller\'s pin, never from the checkout the PR controls', () => {
    for (const job of ['scope', 'verify']) {
      const s = steps(job);
      const kanon = s.findIndex((x) => x.uses === '$/actions/kanon-path');
      const script = s.findIndex((x) => x.run?.includes('scripts/red-test.mjs'));
      expect(kanon, job).toBeGreaterThan(-1);
      expect(kanon, job).toBeLessThan(script);
      expect(s[script].env?.KANON, `${job} reads the path from the step's output, which the hook cannot rewrite`).toBe('${{ steps.kanon.outputs.path }}');
    }
    expect(text, "the PR's own copy must not be what runs").not.toMatch(/node\s+"?\.?\/?scripts\/red-test\.mjs/);
  });

  it('passes the PR\'s commits through the environment, never into the shell line', () => {
    for (const job of ['scope', 'verify']) {
      for (const s of steps(job).filter((x) => x.run)) expect(s.run, `${job}: ${s.name}`).not.toMatch(/\$\{\{/);
    }
  });

  it('fetches full history in both jobs, and persists no credential', () => {
    for (const job of ['scope', 'verify']) {
      const checkout = steps(job).find((s) => s.uses?.startsWith('actions/checkout')) as Step;
      expect(checkout.with?.['fetch-depth'], job).toBe(0);
      expect(checkout.with?.['persist-credentials'], job).toBe(false);
    }
  });

  it('installs with the project-setup hook, with its declared database, BEFORE reverting', () => {
    const s = steps('verify');
    const db = s.findIndex((x) => x.uses === '$/actions/test-database');
    const hook = s.findIndex((x) => x.uses === './.github/actions/project-setup');
    const script = s.findIndex((x) => x.run?.includes('scripts/red-test.mjs'));
    expect(db).toBeGreaterThan(-1);
    expect(db).toBeLessThan(hook);
    expect(hook).toBeLessThan(script);
    expect(s[hook].with).toMatchObject({ lane: 'red-test', install: 'true', database: '${{ steps.database.outputs.database }}', browsers: 'false' });
  });

  it('propagates the script exit code through the tee pipeline', () => {
    const last = steps('verify').at(-1) as Step;
    expect(last.run).toContain('PIPESTATUS[0]');
    expect(last.run).toContain('--base "$BASE" --head "$HEAD"');
  });
});

/**
 * A run whose job will skip must not be able to cancel one that will verify. Concurrency is
 * decided when the run is CREATED, before the job `if` is read. EVALUATED, not string-matched: a
 * tiny evaluator for the expression subset these two fields use turns each event into (group,
 * does-the-job-run), and the invariant is checked over every event shape the pipeline produces.
 * It is also where a person's PR is shown NOT SUBJECT to the check (`K-MERGE-13`).
 */
describe('only a run that will verify shares the cancellable group, and a person\'s PR is not subject', () => {
  const wf = parse(readFileSync(join(ROOT, '.github/workflows/red-test.yml'), 'utf8'));
  type Ev = { action: string; label?: string; labels: string[]; runId: number };
  const PR = 42;

  const evaluate = (expr: string, ev: Ev): unknown => {
    const js = expr
      .replace(/contains\(github\.event\.pull_request\.labels\.\*\.name,\s*'([^']+)'\)/g, (_, l) => JSON.stringify(ev.labels.includes(l)))
      .replace(/format\('noop-\{0\}',\s*github\.run_id\)/g, JSON.stringify(`noop-${ev.runId}`))
      .replace(/github\.event\.action/g, JSON.stringify(ev.action))
      .replace(/github\.event\.label\.name/g, JSON.stringify(ev.label ?? ''))
      .replace(/github\.event\.pull_request\.number/g, String(PR))
      .replace(/!=/g, '!==').replace(/([^!=])==(?!=)/g, '$1===');
    if (/github\.|\w+\(/.test(js)) throw new Error(`unmodelled expression: ${js}`);
    return new Function(`return (${js});`)();
  };
  const groupOf = (ev: Ev) => String(wf.concurrency.group).replace(/\$\{\{([\s\S]*?)\}\}/g, (_: string, e: string) => String(evaluate(e, ev)));
  const jobRuns = (ev: Ev) => Boolean(evaluate(wf.jobs.scope.if, ev));

  const AGENT = ['agent:implement', 'review:please'];
  const events: Ev[] = [
    { action: 'opened', labels: [], runId: 1 },
    { action: 'opened', labels: AGENT, runId: 2 },
    { action: 'synchronize', labels: AGENT, runId: 3 },
    { action: 'synchronize', labels: [], runId: 4 },
    { action: 'reopened', labels: ['agent:triage'], runId: 5 },
    { action: 'labeled', label: 'agent:implement', labels: AGENT, runId: 6 },
    { action: 'labeled', label: 'agent:triage', labels: ['agent:triage'], runId: 7 },
    { action: 'labeled', label: 'review:please', labels: AGENT, runId: 8 },
    { action: 'labeled', label: 'agent:reviewer', labels: [...AGENT, 'agent:reviewer'], runId: 9 },
    { action: 'labeled', label: 'needs:human', labels: [...AGENT, 'needs:human'], runId: 10 },
    { action: 'labeled', label: 'review:please', labels: ['review:please'], runId: 11 },
  ];

  it('evaluates both fields for every event: the rest of this block is vacuous without it', () => {
    expect(events.filter(jobRuns).length).toBeGreaterThan(2);
    expect(events.filter((e) => !jobRuns(e)).length).toBeGreaterThan(2);
  });

  it('a person\'s PR, whatever happens to it, is never checked (K-MERGE-13)', () => {
    const human: Ev[] = [
      { action: 'opened', labels: [], runId: 20 },
      { action: 'synchronize', labels: ['review:please'], runId: 21 },
      { action: 'reopened', labels: ['bug'], runId: 22 },
      { action: 'labeled', label: 'review:please', labels: ['review:please'], runId: 23 },
    ];
    for (const ev of human) expect(jobRuns(ev), `${ev.action} on [${ev.labels.join(',')}]`).toBe(false);
  });

  it('puts a run in the shared group IF AND ONLY IF its job will run', () => {
    const shared = `red-test-${PR}-verify`;
    for (const ev of events) {
      const label = `${ev.action}${ev.label ? `:${ev.label}` : ''} on [${ev.labels.join(',')}]`;
      expect(groupOf(ev) === shared, label).toBe(jobRuns(ev));
    }
  });

  it('gives every skipping run a group of its own, so it cancels nothing', () => {
    const skipping = events.filter((e) => !jobRuns(e)).map(groupOf);
    expect(new Set(skipping).size).toBe(skipping.length);
  });

  it('a review label added in the same second as the agent\'s no longer cancels the verification', () => {
    const implement: Ev = { action: 'labeled', label: 'agent:implement', labels: AGENT, runId: 100 };
    const please: Ev = { action: 'labeled', label: 'review:please', labels: AGENT, runId: 101 };
    expect(jobRuns(implement)).toBe(true);
    expect(groupOf(please)).not.toBe(groupOf(implement));
  });

  it('still lets a newer verifying run supersede an older one: a push replaces the old head', () => {
    expect(groupOf({ action: 'synchronize', labels: AGENT, runId: 1 })).toBe(groupOf({ action: 'synchronize', labels: AGENT, runId: 2 }));
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
  });
});

/**
 * END TO END: the script, as the workflow runs it, on a real repository with a real runner. Kanon's
 * own Vitest is the project's runner here, linked in as the project-setup hook would install it,
 * declared by the stack document as a `tests` tree's runner (`K-LAYOUT-17`). Each case is one
 * shape of PR, committed as base then head, and the check is run against the two.
 */
describe('end to end, on a real repository and a real runner', { timeout: 120_000 }, () => {
  const SCRIPT = join(ROOT, 'scripts/red-test.mjs');
  const STACK = '# Stack\n\n## Gates\n\n1. run the tests\n\n## Code areas\n\n- `src/` — code: the application\n- `tests/` `vitest` — tests: the suite\n';
  const write = (dir: string, files: Record<string, string | null>) => {
    for (const [f, body] of Object.entries(files)) {
      if (body === null) { rmSync(join(dir, f)); continue; }
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
  };
  type Run = { status: number | null; out: string; output: string; dirty: string; addedOnDisk: boolean };
  const check = (base: Record<string, string>, head: Record<string, string | null>, opts: { runner?: boolean; args?: string[]; after?: Record<string, string> } = {}): Run => {
    const dir = mkdtempSync(join(tmpdir(), 'red-test-e2e-'));
    try {
      const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      // The runner's own config, at the base, so the run's cache stays in this repository.
      write(dir, { '.gitignore': 'node_modules\n.vitest-cache\n', 'vitest.config.mjs': "export default { cacheDir: '.vitest-cache' };\n", 'docs/qa/stack.md': STACK, ...base });
      g('add', '-A'); g('commit', '-qm', 'base');
      const baseSha = g('rev-parse', 'HEAD');
      write(dir, head);
      g('add', '-A'); g('commit', '-qm', 'head');
      const headSha = g('rev-parse', 'HEAD');
      if (opts.runner !== false) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
      // Uncommitted work, as a developer's own tree may hold.
      write(dir, opts.after ?? {});
      const output = join(dir, '.git', 'gh-output');
      writeFileSync(output, '');
      // A clean environment: the runner must not inherit this suite's own Vitest worker state.
      const r = spawnSync('node', [SCRIPT, '--base', baseSha, '--head', headSha, ...(opts.args ?? [])], {
        cwd: dir, encoding: 'utf8', timeout: 100_000,
        env: { PATH: process.env.PATH ?? '', HOME: dir, GITHUB_OUTPUT: output },
      });
      return {
        status: r.status,
        out: `${r.stdout}${r.stderr}`,
        output: readFileSync(output, 'utf8').trim(),
        dirty: g('status', '--porcelain', '--untracked-files=no'),
        // Read now: the directory is gone once this returns.
        addedOnDisk: existsSync(join(dir, 'src/add.mjs')),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const BUGGY = { 'src/add.mjs': 'export const add = (a, b) => a - b;\n' };
  const FIXED = { 'src/add.mjs': 'export const add = (a, b) => a + b;\n' };
  const REAL_TEST = { 'tests/add.test.ts': "import { expect, it } from 'vitest';\nimport { add } from '../src/add.mjs';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n" };
  const VACUOUS_TEST = { 'tests/add.test.ts': "import { expect, it } from 'vitest';\nimport { add } from '../src/add.mjs';\nit('adds', () => { expect(typeof add).toBe('function'); });\n" };

  it('a real fix whose test fails on the reverted source is green, and the tree is given back', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('| `tests/add.test.ts` | 🔴 failed an assertion: **strong** |');
    expect(r.out).toContain('**PASS.** 1 file(s) failed an assertion against the reverted source.');
    expect(r.dirty, 'the source is back at head').toBe('');
  });

  it('a change whose test still passes on the reverted source is red: BLOCKED', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('| `tests/add.test.ts` | 🟢 still passed |');
    expect(r.out).toContain('**BLOCKED: every changed test passed without the source change, so none of them proves anything.**');
  });

  it('the same vacuous test beside a file the check cannot revert is UNVERIFIABLE, and still red', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/add.md': 'Adding.\n' });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**UNVERIFIABLE: 1 changed file(s) were not reverted, so a block would not be about them.**');
    expect(r.out).toContain('`docs/add.md`');
  });

  it('a new module and its test pass weakly: the test cannot load without the module, and the added file is restored', () => {
    const r = check({ 'src/keep.mjs': 'export {};\n' }, { ...FIXED, ...REAL_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('| `tests/add.test.ts` | 🟠 did not collect: *weak* |');
    expect(r.out).toContain('**PASS, weakly.**');
    expect(r.addedOnDisk, 'the file the PR added is back').toBe(true);
    expect(r.dirty).toBe('');
  });

  it('…and UNVERIFIABLE when an unreverted test helper changed beside it, which could have caused that', () => {
    const r = check({ 'src/keep.mjs': 'export {};\n', 'tests/helpers.ts': 'export const h = 1;\n' }, { ...FIXED, ...REAL_TEST, 'tests/helpers.ts': 'export const h = 2;\n' });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**Not run, and NOT reverted**');
    expect(r.out).toContain('unreverted test harness file(s) could have caused that.**');
  });

  it('refuses, rather than overwrites, uncommitted work in the revert set, and exits 1', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { after: { 'src/add.mjs': 'export const add = (a, b) => b + a;\n' } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**Refused: 1 file(s) in the revert set have uncommitted changes:** `src/add.mjs`');
    expect(r.dirty, 'the work is still there').toContain('src/add.mjs');
  });

  it('a runner that is not installed is INCONCLUSIVE, never a pass or a block', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { runner: false });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('| `tests/add.test.ts` | ⚪ no data: the runner reported nothing for this file |');
    expect(r.out).toContain('**INCONCLUSIVE');
  });

  it('--plan: tests only → verify=false, so the verification job does not run', () => {
    const r = check({}, REAL_TEST, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.output).toBe('verify=false');
    expect(r.out).toContain('**Skipped:** no source file changed');
  });

  it('--plan: tests AND source → verify=true, with the scope heading, not a verdict', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.output).toBe('verify=true');
    expect(r.out.split('\n')[0]).toBe('## Red-test scope');
    expect(r.out).not.toContain('PASS');
  });

  it('--plan with no tests tree declared names the default and skips: no runner is assumed', () => {
    const r = check({ 'docs/qa/stack.md': '# Stack\n\n## Gates\n\n1. test\n', ...BUGGY }, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.output).toBe('verify=false');
    expect(r.out).toContain("declares no `## Code areas`, so Kanon's default applies");
    expect(r.out).toContain('**Not run**: no `tests` tree in docs/qa/stack.md names a runner for these');
  });

  it('a malformed declaration fails by name, before anything is read', () => {
    const r = check({ 'docs/qa/stack.md': '# Stack\n\n## Code areas\n\n- `src` — code: the application\n', ...BUGGY }, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/^red-test: docs\/qa\/stack\.md:\d+: a `code` area is a directory/m);
  });

  it('only a skip declines in the plan: a refusing result still sends the real job to report it', () => {
    expect(planOutput({ skipped: true })).toBe('verify=false');
    expect(planOutput({ plan: true })).toBe('verify=true');
    expect(planOutput({ blocked: true })).toBe('verify=true');
    expect(planOutput(undefined)).toBe('verify=true');
  });
});
