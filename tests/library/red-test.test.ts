import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { UNDECLARED, parseCodeAreas } from '../../scripts/lib/code-areas.mjs';
import {
  CHARACTERIZATION_LABEL, areasFromJson, changedFiles, characterization, classify, commentOnlyAt, dirtyPaths, exitCodeFor,
  judgingAreas, materialise, narrowRunnable, noBehaviourChange, planOutput, planOutputs, readResult, runFiles, tierOf, verdict,
  withMaterialised,
} from '../../scripts/red-test.mjs';

type CodeAreasT = ReturnType<typeof parseCodeAreas>;
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

/**
 * A PR with no behaviour change has no fix to prove (`K-MERGE-13`, the Owner's decision of
 * 2026-10-12 on #666). Its test is a characterization test: it locks behaviour that is already
 * right, so it cannot fail on a revert by construction, and a red check there would mean nothing.
 */
describe('no behaviour change to revert: read from the diff', () => {
  const yes = () => true;
  const no = () => false;

  it('no non-test source change at all, beside docs or nothing', () => {
    expect(noBehaviourChange({ src: [], unreverted: [], commentOnly: no })).toBe('no-source');
    expect(noBehaviourChange({ src: [], unreverted: ['docs/qa/specs/observability.md', 'README.md'], commentOnly: no })).toBe('no-source');
  });

  it('every changed source file is comments or whitespace, beside docs', () => {
    expect(noBehaviourChange({ src: ['sst.config.ts', 'src/a.ts'], unreverted: ['docs/a.md'], commentOnly: yes })).toBe('comment-only');
  });

  it('one source file it cannot prove is comments or whitespace keeps the whole diff on the verifying path', () => {
    const commentOnly = (f: string) => f !== 'src/b.ts';
    expect(noBehaviourChange({ src: ['src/a.ts', 'src/b.ts'], unreverted: [], commentOnly })).toBeNull();
  });

  it('a non-doc file the job cannot revert (a config, a migration, a manifest) keeps it there too', () => {
    for (const f of ['config/flags.json', 'migrations/0001.sql', 'package.json', 'vitest.config.ts', '.github/workflows/ci.yml', 'requirements.txt']) {
      expect(noBehaviourChange({ src: ['src/a.ts'], unreverted: [f], commentOnly: yes }), f).toBeNull();
      expect(noBehaviourChange({ src: [], unreverted: [f], commentOnly: yes }), f).toBeNull();
    }
  });

  it('reads a file as comment-only only when it is the same blob kind at both ends', () => {
    const tree = (entries: Record<string, string>) => (args: string[]) => {
      if (args[0] === 'ls-tree') return entries[args[1] as string] ?? '';
      if (args[0] === 'cat-file') return args[2] === 'b1' ? 'const a = 1; // old\n' : 'const a = 1; // new\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    expect(commentOnlyAt('src/a.ts', 'base', 'head', { run: tree({ base: '100644 blob b1\tsrc/a.ts\n', head: '100644 blob b2\tsrc/a.ts\n' }) })).toBe(true);
    // Made executable: the content is the same, the behaviour is not.
    expect(commentOnlyAt('src/a.ts', 'base', 'head', { run: tree({ base: '100644 blob b1\tsrc/a.ts\n', head: '100755 blob b2\tsrc/a.ts\n' }) })).toBe(false);
    // Added by the PR: a new file's existence is a change, whatever it holds.
    expect(commentOnlyAt('src/a.ts', 'base', 'head', { run: tree({ head: '100644 blob b2\tsrc/a.ts\n' }) })).toBe(false);
    // A symlink's content is its target.
    expect(commentOnlyAt('src/a.ts', 'base', 'head', { run: tree({ base: '120000 blob b1\tsrc/a.ts\n', head: '120000 blob b2\tsrc/a.ts\n' }) })).toBe(false);
  });
});

describe('no behaviour change to revert: a person\'s `test:characterization` label', () => {
  const pr = (labels: string[]) => ({ labels: labels.map((name) => ({ name })) });
  const person = { login: 'yedeya', type: 'User' };
  const labelled = (sender: unknown, labels = ['agent:implement', CHARACTERIZATION_LABEL]) =>
    ({ action: 'labeled', label: { name: CHARACTERIZATION_LABEL }, sender, pull_request: pr(labels) });

  it('is honoured when a person applied it, on the run their labelling started', () => {
    expect(characterization(labelled(person))).toEqual({ kind: 'person', by: 'yedeya' });
  });

  it('is ignored when any App applied it, the agents\' included, by the label guard\'s test (K-MERGE-13)', () => {
    expect(characterization(labelled({ login: 'kanon-author[bot]', type: 'Bot' }))).toEqual({ kind: 'app', by: 'kanon-author[bot]' });
    expect(characterization(labelled({ login: 'github-actions[bot]', type: 'User' }))).toEqual({ kind: 'app', by: 'github-actions[bot]' });
    expect(characterization(labelled({ login: 'someone', type: 'Bot' }))).toEqual({ kind: 'app', by: 'someone' });
  });

  it('is not honoured on a run that cannot say who applied it: a push, or another label\'s event', () => {
    const labels = ['agent:implement', CHARACTERIZATION_LABEL];
    expect(characterization({ action: 'synchronize', sender: person, pull_request: pr(labels) })).toEqual({ kind: 'unattributed' });
    expect(characterization({ action: 'labeled', label: { name: 'review:please' }, sender: person, pull_request: pr(labels) })).toEqual({ kind: 'unattributed' });
    expect(characterization(labelled(undefined))).toEqual({ kind: 'unattributed' });
  });

  it('is nothing at all on a PR that does not carry it, or with no event', () => {
    expect(characterization({ action: 'opened', sender: person, pull_request: pr(['agent:implement']) })).toBeNull();
    expect(characterization(labelled(person, ['agent:implement']))).toBeNull();
    expect(characterization(null)).toBeNull();
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
    expect(wf.jobs.verify.if).toContain("needs.scope.outputs.verify == 'true'");
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

  it('checks out the PR\'s head in both jobs, not the merge ref, with full history and no persisted credential', () => {
    for (const job of ['scope', 'verify']) {
      const checkout = steps(job).find((s) => s.uses?.startsWith('actions/checkout')) as Step;
      // On `pull_request` the default is `refs/pull/N/merge`, whose base-tip changes would sit
      // beside the reverted source and could supply a false strong PASS.
      expect(checkout.with?.ref, job).toBe('${{ github.event.pull_request.head.sha }}');
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

  // kanon#761: what the check judges with is never the PR's.
  it('scope reads the code areas from the default branch, before any of the PR\'s code runs, and hands them on', () => {
    const plan = steps('scope').find((s) => s.id === 'plan') as Step;
    expect(plan.env?.DEFAULT_BRANCH).toBe('${{ github.event.repository.default_branch }}');
    expect(plan.run).toContain('--areas-ref "refs/remotes/origin/$DEFAULT_BRANCH"');
    expect(steps('scope').some((s) => s.uses === './.github/actions/project-setup'), 'no PR code runs in scope').toBe(false);
    expect(wf.jobs.scope.outputs.areas).toBe('${{ steps.plan.outputs.areas }}');
    expect(wf.jobs.scope.outputs.areas_changed).toBe('${{ steps.plan.outputs.areas_changed }}');
  });

  it('verify refuses a PR that changes the code areas before anything of the PR\'s runs, on anything but an explicit false', () => {
    const s = steps('verify');
    const refuse = s.findIndex((x) => x.name === 'Refuse a pull request that changes the code areas it is judged with');
    expect(refuse).toBe(1);
    expect((s[refuse] as Step & { if?: string }).if).toBe("needs.scope.outputs.areas_changed != 'false'");
    expect(s[refuse].run).toContain('exit 1');
    expect(refuse).toBeLessThan(s.findIndex((x) => x.uses === './.github/actions/project-setup'));
  });

  it('verify judges with the areas scope read, on Kanon\'s Node by absolute path, never the tree\'s or the PATH\'s', () => {
    const last = steps('verify').at(-1) as Step;
    expect(last.env?.AREAS).toBe('${{ needs.scope.outputs.areas }}');
    expect(last.run).toContain('--areas-json "$AREAS"');
    expect(last.run).not.toContain('--areas-ref');
    expect(last.env?.KANON_NODE).toBe('${{ steps.kanon.outputs.node }}');
    expect(last.run).toMatch(/^\s*"\$KANON_NODE" "\$KANON\/scripts\/red-test\.mjs"/m);
    const action = parse(readFileSync(join(ROOT, 'actions/kanon-path/action.yml'), 'utf8'));
    expect(action.outputs.node.value).toBe('${{ steps.path.outputs.node }}');
  });

  it('the script reads no stack document from the working tree', () => {
    const script = readFileSync(join(ROOT, 'scripts/red-test.mjs'), 'utf8');
    expect(script).not.toMatch(/import[^;]*\breadCodeAreas\b/);
    expect(script).not.toMatch(/readFileSync\([^)]*STACK_FILE/);
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
    { action: 'labeled', label: 'test:characterization', labels: [...AGENT, 'test:characterization'], runId: 12 },
    { action: 'unlabeled', label: 'test:characterization', labels: AGENT, runId: 13 },
    { action: 'unlabeled', label: 'review:please', labels: ['agent:implement'], runId: 14 },
    { action: 'labeled', label: 'test:characterization', labels: ['test:characterization'], runId: 15 },
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

  it('re-decides when `test:characterization` is applied or removed, and on no other label\'s removal', () => {
    expect(jobRuns({ action: 'labeled', label: 'test:characterization', labels: [...AGENT, 'test:characterization'], runId: 30 })).toBe(true);
    expect(jobRuns({ action: 'unlabeled', label: 'test:characterization', labels: AGENT, runId: 31 })).toBe(true);
    expect(jobRuns({ action: 'unlabeled', label: 'review:please', labels: ['agent:implement'], runId: 32 })).toBe(false);
    // A person's PR is still not subject, whatever label it is given.
    expect(jobRuns({ action: 'labeled', label: 'test:characterization', labels: ['test:characterization'], runId: 33 })).toBe(false);
  });

  it('still lets a newer verifying run supersede an older one: a push replaces the old head', () => {
    expect(groupOf({ action: 'synchronize', labels: AGENT, runId: 1 })).toBe(groupOf({ action: 'synchronize', labels: AGENT, runId: 2 }));
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
  });
});

/**
 * WHAT `verify` DOES, GIVEN HOW `scope` ENDED (kanon#1186). A ruleset counts a skipped required
 * check as passing, so a `scope` that fails must never leave `Red-test verification` skipped behind
 * it. EVALUATED, as Actions reads a job's and a step's `if:`: a field with no status function is
 * `success() && (field)`, which is how a failed `scope` once skipped `verify` silently. A step
 * fails for certain when its script ends in `exit 1`; any other step is taken to pass, which is
 * all these cases need, since nothing after a step that fails runs.
 */
type JobEnd = { result: 'success' | 'failure' | 'skipped' | 'cancelled'; outputs: Record<string, string> };
const RED_TEST_WF = parse(readFileSync(join(ROOT, '.github/workflows/red-test.yml'), 'utf8'));
const ifHolds = (field: string | undefined, ctx: { needs: Record<string, JobEnd>; ok: boolean; cancelled: boolean }): boolean => {
  const expr = (field ?? '').replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim() || 'success()';
  const js = (/\b(success|failure|always|cancelled)\(\)/.test(expr) ? expr : `success() && (${expr})`)
    .replace(/\bneeds\.(\w+)\.result\b/g, (_, j) => JSON.stringify(ctx.needs[j]?.result ?? ''))
    .replace(/\bneeds\.(\w+)\.outputs\.(\w+)/g, (_, j, o) => JSON.stringify(ctx.needs[j]?.outputs[o] ?? ''))
    .replace(/\bsuccess\(\)/g, String(ctx.ok && !ctx.cancelled))
    .replace(/\bfailure\(\)/g, String(!ctx.ok))
    .replace(/\balways\(\)/g, 'true')
    .replace(/\bcancelled\(\)/g, String(ctx.cancelled))
    .replace(/!=/g, '!==').replace(/([^!=])==(?!=)/g, '$1===');
  if (/[A-Za-z_]\w*[.(]/.test(js.replace(/"[^"]*"/g, '""'))) throw new Error(`unmodelled expression: ${js}`);
  return Boolean(new Function(`return (${js});`)());
};
type VerifyRun = { runs: false } | { runs: true; ran: string[]; failedAt?: string };
const verifyRun = (scope: JobEnd, cancelled = false): VerifyRun => {
  const job = RED_TEST_WF.jobs.verify;
  const needs = { scope };
  if (!ifHolds(job.if, { needs, ok: scope.result === 'success', cancelled })) return { runs: false };
  const ran: string[] = [];
  let failedAt: string | undefined;
  for (const step of job.steps as Array<{ name?: string; uses?: string; run?: string; if?: string }>) {
    if (!ifHolds(step.if, { needs, ok: failedAt === undefined, cancelled })) continue;
    const label = step.name ?? step.uses ?? '?';
    ran.push(label);
    if (failedAt === undefined && /(^|\n)\s*exit 1\s*$/.test(step.run ?? '')) failedAt = label;
  }
  return { runs: true, ran, failedAt };
};
const SCOPE_FAILED_STEP = 'Fail when the scope job did not finish';

describe('a scope that fails fails the required check, never skips it (kanon#1186)', () => {
  const PLANNED = { verify: 'true', areas: '{}', areas_changed: 'false' };

  it('names the required check, so the failure lands on the name a ruleset requires', () => {
    expect(RED_TEST_WF.jobs.verify.name).toBe('Red-test verification');
    expect(RED_TEST_WF.jobs.verify.needs).toBe('scope');
  });

  it('a failed scope, with no outputs, runs verify, which fails by name before anything of the PR\'s runs', () => {
    const r = verifyRun({ result: 'failure', outputs: {} });
    expect(r.runs, 'a skipped verify reads as passing to a ruleset').toBe(true);
    if (!r.runs) return;
    expect(r.failedAt).toBe(SCOPE_FAILED_STEP);
    expect(r.ran).toEqual([SCOPE_FAILED_STEP]);
    expect(r.ran).not.toContain('./.github/actions/project-setup');
  });

  it('a failed scope fails verify whatever outputs it left behind, a planned verify=true included', () => {
    const r = verifyRun({ result: 'failure', outputs: PLANNED });
    expect(r.runs && r.failedAt).toBe(SCOPE_FAILED_STEP);
  });

  it('the failing step says why, and names the scope job and the rule', () => {
    const step = (RED_TEST_WF.jobs.verify.steps as Array<{ name?: string; run?: string }>).find((s) => s.name === SCOPE_FAILED_STEP);
    expect(step?.run).toContain('Red-test scope');
    expect(step?.run).toContain('K-MERGE-13');
    expect(step?.run).toContain('::error title=Red-test scope failed::');
  });

  it('still skips where nothing was claimed or nothing is to verify: a skipped scope, or verify=false', () => {
    expect(verifyRun({ result: 'skipped', outputs: {} }).runs, 'a person\'s PR is not subject (K-MERGE-13)').toBe(false);
    expect(verifyRun({ result: 'success', outputs: { ...PLANNED, verify: 'false' } }).runs).toBe(false);
  });

  it('a planned verification runs as before: the scope step stays out of its way', () => {
    const r = verifyRun({ result: 'success', outputs: PLANNED });
    expect(r.runs).toBe(true);
    if (!r.runs) return;
    expect(r.failedAt).toBeUndefined();
    expect(r.ran).not.toContain(SCOPE_FAILED_STEP);
    expect(r.ran).toContain('./.github/actions/project-setup');
    expect(r.ran.at(-1)).toBe('Verify the changed tests fail without the source change');
  });

  it('a planned verification of a PR that changes its areas is still refused', () => {
    const r = verifyRun({ result: 'success', outputs: { ...PLANNED, areas_changed: 'true' } });
    expect(r.runs && r.failedAt).toBe('Refuse a pull request that changes the code areas it is judged with');
  });

  it('a cancelled run starts nothing: a newer run superseded it', () => {
    expect(verifyRun({ result: 'cancelled', outputs: {} }, true).runs).toBe(false);
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
  type Run = { status: number | null; out: string; output: string; outputs: Record<string, string>; dirty: string; addedOnDisk: boolean };
  type Opts = {
    runner?: boolean; args?: string[]; after?: Record<string, string>; event?: unknown;
    /** A commit on the trusted branch after the merge base: the default branch moved on. */
    trusted?: Record<string, string>;
    /** Where the areas come from, in place of `--areas-ref trusted`. */
    areasArgs?: string[];
  };
  const check = (base: Record<string, string>, head: Record<string, string | null>, opts: Opts = {}): Run => {
    const dir = mkdtempSync(join(tmpdir(), 'red-test-e2e-'));
    try {
      const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      // The runner's own config, at the base, so the run's cache stays in this repository.
      write(dir, { '.gitignore': 'node_modules\n.vitest-cache\n', 'vitest.config.mjs': "export default { cacheDir: '.vitest-cache' };\n", 'docs/qa/stack.md': STACK, ...base });
      g('add', '-A'); g('commit', '-qm', 'base');
      const baseSha = g('rev-parse', 'HEAD');
      // The default branch, as the scope job reads it: the base, or a commit after it.
      g('branch', 'trusted');
      if (opts.trusted) {
        g('checkout', '-q', 'trusted');
        write(dir, opts.trusted);
        g('add', '-A'); g('commit', '-qm', 'trusted moved on');
        g('checkout', '-q', 'main');
      }
      write(dir, head);
      g('add', '-A'); g('commit', '-qm', 'head');
      const headSha = g('rev-parse', 'HEAD');
      if (opts.runner !== false) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
      // Uncommitted work, as a developer's own tree may hold.
      write(dir, opts.after ?? {});
      const output = join(dir, '.git', 'gh-output');
      writeFileSync(output, '');
      // The event the run was started by, where Actions puts it.
      const eventPath = join(dir, '.git', 'event.json');
      if (opts.event !== undefined) writeFileSync(eventPath, JSON.stringify(opts.event));
      // A clean environment: the runner must not inherit this suite's own Vitest worker state.
      const r = spawnSync('node', [SCRIPT, '--base', baseSha, '--head', headSha, ...(opts.areasArgs ?? ['--areas-ref', 'trusted']), ...(opts.args ?? [])], {
        cwd: dir, encoding: 'utf8', timeout: 100_000,
        env: { PATH: process.env.PATH ?? '', HOME: dir, GITHUB_OUTPUT: output, ...(opts.event !== undefined ? { GITHUB_EVENT_PATH: eventPath } : {}) },
      });
      const written = readFileSync(output, 'utf8').trim();
      return {
        status: r.status,
        out: `${r.stdout}${r.stderr}`,
        output: written,
        outputs: Object.fromEntries(written.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
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

  it('--plan: tests only → verify=false, so the verification job does not run, and no behaviour change is named', () => {
    const r = check({}, REAL_TEST, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped: no behaviour change to revert.** No non-test file changed, so');
  });

  it('--plan: tests beside a non-doc file it cannot revert, and no source → verify=false, saying only that nothing was reverted', () => {
    const r = check({ 'config/flags.json': '{"a":1}\n' }, { 'config/flags.json': '{"a":2}\n', ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped:** no source file changed');
    expect(r.out).not.toContain('no behaviour change');
  });

  it('--plan: tests AND source → verify=true, with the scope heading, not a verdict', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('true');
    expect(r.out.split('\n')[0]).toBe('## Red-test scope');
    expect(r.out).not.toContain('PASS');
  });

  it('--plan with no tests tree declared names the default and skips: no runner is assumed', () => {
    const r = check({ 'docs/qa/stack.md': '# Stack\n\n## Gates\n\n1. test\n', ...BUGGY }, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain("declares no `## Code areas`, so Kanon's default applies");
    expect(r.out).toContain('**Not run**: no `tests` tree in docs/qa/stack.md names a runner for these');
  });

  it('a malformed declaration fails by name, before anything is read', () => {
    const r = check({ 'docs/qa/stack.md': '# Stack\n\n## Code areas\n\n- `src` — code: the application\n', ...BUGGY }, { ...FIXED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/^red-test: docs\/qa\/stack\.md:\d+: a `code` area is a directory/m);
  });

  // kanon#1186: the PR can't cause it, since the declaration is the default branch's, but a ruleset
  // reads a skipped required check as passing, so every PR would pass until someone fixed it.
  it('a malformed declaration on the default branch fails the required check, never skips it', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { args: ['--plan'], trusted: { 'docs/qa/stack.md': '# Stack\n\n## Code areas\n\n- `src` — code: the application\n' } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/^red-test: docs\/qa\/stack\.md:\d+: a `code` area is a directory/m);
    const run = verifyRun({ result: 'failure', outputs: r.outputs });
    expect(run.runs, '`Red-test verification` skipped, which a ruleset counts as passing').toBe(true);
    expect(run.runs && run.failedAt).toBe(SCOPE_FAILED_STEP);
  });

  // The shape of the case that showed the gap: a characterization test, comment-only edits to the
  // source it guards, and a spec whose line references those comments moved.
  const GUARDED = { 'src/add.mjs': '// Adds.\nexport const add = (a, b) => a + b;\n', 'docs/spec.md': 'See src/add.mjs:2.\n' };
  const RECOMMENTED = { 'src/add.mjs': '// Adds two numbers.\n// The second line moved the code down.\nexport const add = (a, b) => a + b;\n', 'docs/spec.md': 'See src/add.mjs:3.\n' };

  it('comment-only source beside a doc: "no behaviour change to revert", never UNVERIFIABLE, and not red', () => {
    const r = check(GUARDED, { ...RECOMMENTED, ...REAL_TEST });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('**Skipped: no behaviour change to revert.**');
    expect(r.out).toContain('`src/add.mjs`');
    expect(r.out).not.toContain('UNVERIFIABLE');
    expect(r.dirty, 'nothing was reverted').toBe('');
  });

  it('--plan: comment-only source → verify=false, so the check concludes SKIPPED, never red', () => {
    const r = check(GUARDED, { ...RECOMMENTED, ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('no behaviour change to revert');
  });

  it('--plan: tests and docs, no non-test source at all → verify=false, with the same message', () => {
    const r = check({ 'docs/spec.md': 'One.\n' }, { 'docs/spec.md': 'Two.\n', ...REAL_TEST }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped: no behaviour change to revert.**');
  });

  it('a behaviour change beside the same comment edits and doc is still verified, and still red', () => {
    const changed = { ...RECOMMENTED, 'src/add.mjs': '// Adds two numbers.\n// The second line moved the code down.\nexport const add = (a, b) => b + a;\n' };
    const r = check(GUARDED, { ...changed, ...VACUOUS_TEST });
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toContain('no behaviour change');
    expect(r.out).toContain('**UNVERIFIABLE: 1 changed file(s) were not reverted');
  });

  it('comment-only source beside a non-doc file it cannot revert stays on the verifying path', () => {
    const r = check({ ...GUARDED, 'config/flags.json': '{"a":1}\n' }, { ...RECOMMENTED, 'config/flags.json': '{"a":2}\n', ...REAL_TEST });
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toContain('no behaviour change');
    expect(r.out).toContain('`config/flags.json`');
  });

  const labelled = (sender: { login: string, type: string }) => ({
    action: 'labeled', label: { name: 'test:characterization' }, sender,
    pull_request: { labels: [{ name: 'agent:implement' }, { name: 'test:characterization' }] },
  });

  it('--plan: a person\'s `test:characterization` turns a behaviour-changing diff\'s check SKIPPED', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { args: ['--plan'], event: labelled({ login: 'yedeya', type: 'User' }) });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('false');
    expect(r.out).toContain('**Skipped: a person applied `test:characterization`** (@yedeya)');
  });

  it('--plan: the same label applied by an App is ignored, and says so: the check still verifies', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { args: ['--plan'], event: labelled({ login: 'kanon-author[bot]', type: 'Bot' }) });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.verify).toBe('true');
    expect(r.out).toContain('applied by an App (@kanon-author[bot]), and an App cannot waive this check (K-MERGE-13): ignored.');
  });

  it('the label is read in the scope job only: the verifying run, where the PR\'s hook has run, ignores it', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { event: labelled({ login: 'yedeya', type: 'User' }) });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**BLOCKED');
  });

  it('only a skip declines in the plan: a refusing result still sends the real job to report it', () => {
    expect(planOutput({ skipped: true })).toBe('verify=false');
    expect(planOutput({ plan: true })).toBe('verify=true');
    expect(planOutput({ blocked: true })).toBe('verify=true');
    expect(planOutput(undefined)).toBe('verify=true');
  });

  // ── kanon#761: the PR's stack document can't steer the check ──────────────
  const SRC_AS_TESTS = '# Stack\n\n## Gates\n\n1. run the tests\n\n## Code areas\n\n- `src/` — tests: the application, now "tests"\n- `tests/` `vitest` — tests: the suite\n';
  const NO_RUNNER = '# Stack\n\n## Gates\n\n1. run the tests\n\n## Code areas\n\n- `src/` — code: the application\n- `tests/` — tests: the suite\n';
  const NO_AREAS = '# Stack\n\n## Gates\n\n1. run the tests\n';

  it('a PR that re-declares its source as a tests tree is refused, not skipped: the plan still sends verify, which fails', () => {
    const plan = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': SRC_AS_TESTS }, { args: ['--plan'] });
    expect(plan.status, plan.out).toBe(0);
    expect(plan.outputs.verify).toBe('true');
    expect(plan.outputs.areas_changed).toBe('true');
    expect(plan.out).toContain('**Refused: this pull request changes the code areas the check judges with.**');
    expect(plan.out).not.toContain('Skipped');
    const run = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': SRC_AS_TESTS });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('**Refused');
  });

  it('a PR that drops its tests tree\'s runner is refused, not skipped', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': NO_RUNNER }, { args: ['--plan'] });
    expect(r.outputs.verify).toBe('true');
    expect(r.outputs.areas_changed).toBe('true');
    expect(r.out).toContain('declares the `tests` trees `tests/`, and `trusted` declares `tests/` `vitest`');
  });

  it('a PR that adds its first tests tree is refused, never SKIPPED', () => {
    const r = check({ 'docs/qa/stack.md': NO_AREAS, ...BUGGY }, { ...FIXED, ...REAL_TEST, 'docs/qa/stack.md': STACK }, { args: ['--plan'] });
    expect(r.outputs.verify).toBe('true');
    expect(r.outputs.areas_changed).toBe('true');
    expect(r.out).toContain('and `trusted` declares none');
  });

  it('a PR whose stack document can\'t be parsed is refused by name', () => {
    const r = check(BUGGY, { ...FIXED, ...REAL_TEST, 'docs/qa/stack.md': '# Stack\n\n## Code areas\n\n- `src` — code: the application\n' }, { args: ['--plan'] });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs.areas_changed).toBe('true');
    expect(r.out).toMatch(/This pull request's docs\/qa\/stack\.md can't be read: docs\/qa\/stack\.md:\d+: a `code` area is a directory/);
  });

  it('a PR that only rewords its areas, keeping the tests trees, is judged as usual', () => {
    const reworded = STACK.replace('the suite', 'every test we have');
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST, 'docs/qa/stack.md': reworded });
    expect(r.out).not.toContain('Refused');
    expect(r.out).toContain('**UNVERIFIABLE');
  });

  it('a branch behind a default branch whose areas moved is judged by the default branch\'s, not refused and not its own', () => {
    // The merge base declares no areas, so the PR's test has no runner there; the default branch
    // has since declared `tests/` with Vitest. The PR touched neither.
    const r = check({ 'docs/qa/stack.md': NO_AREAS, ...BUGGY }, { ...FIXED, ...REAL_TEST }, { trusted: { 'docs/qa/stack.md': STACK } });
    expect(r.out).not.toContain('Refused');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('**PASS.** 1 file(s) failed an assertion against the reverted source.');
  });

  it('the stack document on disk is never read: a rewrite after checkout (the hook\'s) changes nothing', () => {
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { after: { 'docs/qa/stack.md': SRC_AS_TESTS } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**BLOCKED');
  });

  it('the verifying run judges with the areas the plan handed it, whatever the tree on disk says', () => {
    const plan = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { args: ['--plan'] });
    expect(plan.outputs.areas_changed).toBe('false');
    const areas = plan.outputs.areas as string;
    expect(JSON.parse(areas).tests).toEqual([{ path: 'tests/', what: 'the suite', runner: 'vitest' }]);
    const r = check(BUGGY, { ...FIXED, ...VACUOUS_TEST }, { areasArgs: ['--areas-json', areas], after: { 'docs/qa/stack.md': SRC_AS_TESTS } });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('**BLOCKED');
  });

  it('fails closed with no trusted source of areas: none given, an unreadable ref, or a garbled hand-over', () => {
    for (const areasArgs of [[], ['--areas-ref', 'no-such-branch'], ['--areas-json', ''], ['--areas-json', '{"declared":true}']]) {
      const r = check(BUGGY, { ...FIXED, ...REAL_TEST }, { areasArgs, args: ['--plan'] });
      expect(r.status, `${areasArgs.join(' ')}: ${r.out}`).toBe(1);
      expect(r.outputs.verify, areasArgs.join(' ')).toBeUndefined();
      expect(r.out).toMatch(/^red-test: /m);
    }
  });

  it('planOutputs and exitCodeFor: a refusal sends verify, says so, and fails it', () => {
    expect(planOutputs({ areasChanged: true }, UNDECLARED)).toEqual(['verify=true', `areas=${JSON.stringify(UNDECLARED)}`, 'areas_changed=true']);
    expect(planOutputs({ skipped: true }, UNDECLARED)[2]).toBe('areas_changed=false');
    expect(exitCodeFor({ areasChanged: true })).toBe(1);
  });
});

describe('judgingAreas: the trusted ref\'s areas, and whether the PR changes them (kanon#761)', () => {
  const T = parseCodeAreas('## Code areas\n\n- `tests/` `vitest` — tests: the suite\n');
  const SRC = parseCodeAreas('## Code areas\n\n- `src/` — tests: source\n- `tests/` `vitest` — tests: the suite\n');
  const reader = (by: Record<string, CodeAreasT | Error>) => (ref: string) => {
    const v = by[ref];
    if (v instanceof Error) throw v;
    if (!v) throw new Error(`no ${ref}`);
    return v;
  };

  it('judges with the trusted ref\'s areas, whatever the head declares', () => {
    const r = judgingAreas({ trustedRef: 'main', head: 'h', diffBase: 'b', read: reader({ main: T, h: SRC, b: T }) });
    expect(r.areas).toBe(T);
    expect(r.changed).toEqual({ trusted: '`tests/` `vitest`', head: '`src/`, `tests/` `vitest`' });
  });

  it('is unchanged when the head matches the trusted ref, or the merge base', () => {
    expect(judgingAreas({ trustedRef: 'main', head: 'h', diffBase: 'b', read: reader({ main: T, h: T, b: SRC }) }).changed).toBeNull();
    expect(judgingAreas({ trustedRef: 'main', head: 'h', diffBase: 'b', read: reader({ main: T, h: SRC, b: SRC }) })).toEqual({ areas: T, changed: null });
  });

  it('a merge base it can\'t read can\'t show the head unchanged', () => {
    expect(judgingAreas({ trustedRef: 'main', head: 'h', diffBase: 'b', read: reader({ main: T, h: SRC, b: new Error('bad') }) }).changed).not.toBeNull();
  });

  it('throws when the trusted ref can\'t be read, and refuses a head that can\'t be', () => {
    expect(() => judgingAreas({ trustedRef: 'main', head: 'h', diffBase: 'b', read: reader({ main: new Error('gone'), h: T, b: T }) })).toThrow('gone');
    expect(judgingAreas({ trustedRef: 'main', head: 'h', diffBase: 'b', read: reader({ main: T, h: new Error('line 3'), b: T }) }).changed).toEqual({ malformed: 'line 3' });
  });

  it('areasFromJson takes back what the plan wrote, and nothing else', () => {
    expect(areasFromJson(JSON.stringify(SRC))).toEqual(SRC);
    for (const bad of ['', 'null', '[]', '{"declared":true,"code":[],"tests":[{"path":1}],"audit":[]}']) expect(() => areasFromJson(bad), bad).toThrow();
  });
});
