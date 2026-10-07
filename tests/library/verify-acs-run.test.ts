import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRuns, interpretRun, runTests } from '../../scripts/verify-acs.mjs';

/**
 * RA-1075 — `verify-acs --run` must record `failed` only when a citing test RAN and
 * failed. A run that produced no test result — no database, a timeout, ENOENT, a crash —
 * is `not-run`.
 *
 * `exec` is injected, so nothing shells out. The fake writes the runner's JSON report
 * where the real runner would (vitest: the `--outputFile=` argument; Playwright: the
 * `PLAYWRIGHT_JSON_OUTPUT_NAME` env var), then exits the way the scenario says.
 */
/** The test trees the reference stack declares, each with its runner (`## Code areas`, kanon#20). */
const TREES = [{ path: 'tests/', runner: 'vitest' }, { path: 'e2e/', runner: 'playwright' }];

type Scenario = { report?: unknown; exit?: 'ok' | 'fail' | 'enoent' | 'timeout' };

const vitestReport = (file: string, statuses: string[]) => ({
  numTotalTests: statuses.length,
  testResults: [{ name: `/repo/${file}`, status: statuses.includes('failed') ? 'failed' : 'passed',
    assertionResults: statuses.map((status, i) => ({ title: `t${i}`, status })) }],
});
// Measured on vitest 5 with Postgres unreachable: globalSetup throws, vitest exits 1, and
// it STILL writes this file. "The report exists" is therefore not the discriminator.
const GLOBAL_SETUP_FAILED = { numTotalTests: 0, testResults: [], success: false };

const fakeExec = (byFile: Record<string, Scenario>) => {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args });
    const file = args.find((a) => a.startsWith('tests/') || a.startsWith('e2e/'))!;
    const sc = byFile[file] ?? {};
    const out = args.find((a) => a.startsWith('--outputFile='))?.slice('--outputFile='.length)
      ?? opts.env?.PLAYWRIGHT_JSON_OUTPUT_NAME;
    if (sc.exit === 'enoent') throw Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
    if (sc.report !== undefined && out) writeFileSync(out, JSON.stringify(sc.report));
    if (sc.exit === 'timeout') throw Object.assign(new Error('ETIMEDOUT'), { signal: 'SIGTERM' });
    if (sc.exit === 'fail') throw Object.assign(new Error('exit 1'), { status: 1 });
    return '';
  };
  return { exec, calls };
};

const run = (files: string[], byFile: Record<string, Scenario>) => {
  const { exec, calls } = fakeExec(byFile);
  const outDir = mkdtempSync(join(tmpdir(), 'verify-acs-test-'));
  return { results: runTests(files, { exec: exec as never, outDir, cwd: '/repo', trees: TREES }), calls };
};

describe("runTests runs a JavaScript file with its declared tree's runner (kanon#20)", () => {
  const stackIn = (stack: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-acs-stack-'));
    if (stack !== null) {
      mkdirSync(join(dir, 'docs/qa'), { recursive: true });
      writeFileSync(join(dir, 'docs/qa/stack.md'), stack);
    }
    return dir;
  };
  const ran = (cwd: string, f: string) => {
    const { exec, calls } = fakeExec({ [f]: { report: vitestReport(f, ['passed']) } });
    const results = runTests([f], { exec: exec as never, cwd, outDir: mkdtempSync(join(tmpdir(), 'verify-acs-test-')) });
    return { result: results.get(f), bins: calls.map((c) => c.cmd) };
  };

  it("reads the trees from the stack document in `cwd` by default, and runs the runner it names", () => {
    const cwd = stackIn('# Stack\n\n## Code areas\n\n- `tests/` `vitest` — tests: the suite\n');
    expect(ran(cwd, 'tests/a.test.ts')).toEqual({ result: true, bins: ['node_modules/.bin/vitest'] });
  });

  it('runs nothing for a tree that names no runner, or with no declaration: not-run, never a guessed runner', () => {
    expect(ran(stackIn('# Stack\n\n## Code areas\n\n- `tests/` — tests: the suite\n'), 'tests/a.test.ts')).toEqual({ result: undefined, bins: [] });
    expect(ran(stackIn(null), 'tests/a.test.ts')).toEqual({ result: undefined, bins: [] });
  });

  it('the CLI stops with one line naming a malformed declaration, before reading anything else', () => {
    const cwd = stackIn('# Stack\n\n## Code areas\n\n- `tests/` `jest` — tests: the suite\n');
    // The locked floor, which the spec library reads when it loads.
    mkdirSync(join(cwd, 'docs/qa/specs'), { recursive: true });
    writeFileSync(join(cwd, 'docs/qa/specs/_locked-floor.json'), '{ "locked": [] }\n');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/verify-acs.mjs', import.meta.url)), '1'], { cwd, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toMatch(/^verify-acs: docs\/qa\/stack\.md:5: `jest` isn't a runner Kanon runs a tests tree with.*\(K-LAYOUT-17\)$/);
  });

  it('fails by name on a malformed declaration, rather than running with none', () => {
    expect(() => ran(stackIn('# Stack\n\n## Code areas\n\n- `tests/` `jest` — tests: the suite\n'), 'tests/a.test.ts')).toThrow(/docs\/qa\/stack\.md:5: `jest` isn't a runner/);
  });
});

describe('runTests — could-not-run is not-run, never failed (RA-1075)', () => {
  it('a real assertion failure is `false`', () => {
    const f = 'tests/unit/a.test.ts';
    const { results } = run([f], { [f]: { report: vitestReport(f, ['passed', 'failed']), exit: 'fail' } });
    expect(results.get(f)).toBe(false);
  });

  it('a passing file is `true`', () => {
    const f = 'tests/unit/a.test.ts';
    expect(run([f], { [f]: { report: vitestReport(f, ['passed', 'passed']) } }).results.get(f)).toBe(true);
  });

  it('globalSetup failing (no Postgres) writes a report with no tests — ABSENT, so not-run', () => {
    const f = 'tests/corporate.test.ts';
    const { results } = run([f], { [f]: { report: GLOBAL_SETUP_FAILED, exit: 'fail' } });
    expect(results.has(f)).toBe(false);
    // ...and applyRuns turns that absence into not-run, not failed.
    const [row] = applyRuns([{ status: 'has-test', tests: [f] }], results);
    expect(row.status).toBe('not-run');
  });

  it('ENOENT, a timeout, and a crash with no report are all ABSENT', () => {
    const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];
    const { results } = run(files, {
      'tests/a.test.ts': { exit: 'enoent' },
      'tests/b.test.ts': { exit: 'timeout' },
      'tests/c.test.ts': { exit: 'fail' },
    });
    expect(results.size).toBe(0);
  });

  it('a file that failed to LOAD (its own entry failed, no assertion ran) is `false` — a real regression', () => {
    // The project renamed an export the test imports, or a module now throws at load:
    // that is the criterion broken at the tag, and must be filed, not waved through.
    const f = 'tests/unit/a.test.ts';
    const collectErr = { testResults: [{ name: `/repo/${f}`, status: 'failed', assertionResults: [] }] };
    expect(run([f], { [f]: { report: collectErr, exit: 'fail' } }).results.get(f)).toBe(false);
    // ...whereas an entry that neither failed nor ran anything (all skipped) is no result.
    const skipped = { testResults: [{ name: `/repo/${f}`, status: 'skipped', assertionResults: [{ status: 'skipped' }] }] };
    expect(run([f], { [f]: { report: skipped } }).results.has(f)).toBe(false);
  });

  it('removes the report directory it created, and leaves a caller’s outDir alone', () => {
    const f = 'tests/unit/a.test.ts';
    const { exec } = fakeExec({ [f]: { report: vitestReport(f, ['passed']) } });
    const seen: string[] = [];
    const spy = (c: string, a: string[], o: { env?: NodeJS.ProcessEnv }) => {
      seen.push(a.find((x) => x.startsWith('--outputFile='))!.slice('--outputFile='.length));
      return exec(c, a, o);
    };
    expect(runTests([f], { exec: spy as never, trees: TREES }).get(f)).toBe(true);
    expect(existsSync(dirname(seen[0]))).toBe(false);
  });

  it('Playwright: unexpected → false, expected/flaky → true, nothing ran → absent', () => {
    const a = 'e2e/a.spec.ts', b = 'e2e/b.spec.ts', c = 'e2e/c.spec.ts';
    const { results } = run([a, b, c], {
      [a]: { report: { stats: { expected: 3, unexpected: 1 } }, exit: 'fail' },
      [b]: { report: { stats: { expected: 2, flaky: 1, unexpected: 0 } } },
      [c]: { report: { stats: { expected: 0, unexpected: 0, skipped: 0 } }, exit: 'fail' }, // webServer never started
    });
    expect(results.get(a)).toBe(false);
    expect(results.get(b)).toBe(true);
    expect(results.has(c)).toBe(false);
  });

  it('PER FILE, NOT PER BATCH — one exec per file, and one failure blames only its own file', () => {
    const a = 'tests/unit/a.test.ts', b = 'tests/unit/b.test.ts';
    const { results, calls } = run([a, b], {
      [a]: { report: vitestReport(a, ['failed']), exit: 'fail' },
      [b]: { report: vitestReport(b, ['passed']) },
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args.filter((x) => x.endsWith('.ts')))).toEqual([[a], [b]]);
    expect(results.get(a)).toBe(false);
    expect(results.get(b)).toBe(true);
  });

  it('a file whose runner is unknown is ABSENT and is never executed', () => {
    const { results, calls } = run(['docs/qa/specs/x.md'], {});
    expect(calls).toHaveLength(0);
    expect(results.size).toBe(0);
  });

  it('a stale report from an earlier file is never read as a later file’s result', () => {
    // Playwright, because its report names no file: vitest's per-file name filter would
    // mask a shared output path, Playwright's aggregate `stats` would not.
    const a = 'e2e/a.spec.ts', b = 'e2e/b.spec.ts';
    const { results } = run([a, b], { [a]: { report: { stats: { expected: 2 } } }, [b]: { exit: 'fail' } });
    expect(results.get(a)).toBe(true);
    expect(results.has(b)).toBe(false);
  });
});

describe('interpretRun', () => {
  it('reads only the named file’s results out of a vitest report', () => {
    const report = { testResults: [
      { name: '/repo/tests/unit/other.test.ts', assertionResults: [{ status: 'failed' }] },
      { name: '/repo/tests/unit/a.test.ts', assertionResults: [{ status: 'passed' }] },
    ] };
    expect(interpretRun('vitest', report, 'tests/unit/a.test.ts')).toBe(true);
  });

  it('skipped-only is not a result', () => {
    const report = { testResults: [{ name: '/repo/tests/unit/a.test.ts', assertionResults: [{ status: 'skipped' }] }] };
    expect(interpretRun('vitest', report, 'tests/unit/a.test.ts')).toBeUndefined();
  });
});

describe('runTests in the other languages of the table (kanon#20)', () => {
  type Call = { cmd: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } };
  const runWith = (files: string[], answer: (c: Call) => { write?: string; stdout?: string; exit?: 'fail' | 'enoent' }, read: (f: string) => string = () => '') => {
    const calls: Call[] = [];
    const exec = (cmd: string, args: string[], opts: Call['opts']) => {
      const call = { cmd, args, opts };
      calls.push(call);
      const a = answer(call);
      if (a.exit === 'enoent') throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
      const out = args.find((x) => x.startsWith('--junitxml='))?.slice('--junitxml='.length);
      if (a.write !== undefined && out) writeFileSync(out, a.write);
      if (a.exit === 'fail') throw Object.assign(new Error('exit 1'), { status: 1, stdout: a.stdout ?? '' });
      return a.stdout ?? '';
    };
    const outDir = mkdtempSync(join(tmpdir(), 'verify-acs-lang-'));
    return { results: runTests(files, { exec: exec as never, outDir, cwd: '/repo', read, trees: TREES }), calls };
  };

  it('pytest: runs the one file through `python -m pytest`, never npx, and reads its JUnit report', () => {
    const f = 'tests/test_core.py';
    const passing = '<testsuites><testsuite><testcase name="test_once"/></testsuite></testsuites>';
    const { results, calls } = runWith([f], () => ({ write: passing }));
    expect(calls.map((c) => [c.cmd, ...c.args.slice(0, 3)])).toEqual([['python', '-m', 'pytest', f]]);
    expect(results.get(f)).toBe(true);
    const failing = '<testsuites><testsuite><testcase name="test_once"><failure>x</failure></testcase></testsuite></testsuites>';
    expect(runWith([f], () => ({ write: failing, exit: 'fail' })).results.get(f)).toBe(false);
  });

  it('pytest: no pytest installed (no report) and no python (ENOENT) are not-run', () => {
    const f = 'tests/test_core.py';
    expect(runWith([f], () => ({ exit: 'fail' })).results.has(f)).toBe(false);
    expect(runWith([f], () => ({ exit: 'enoent' })).results.has(f)).toBe(false);
  });

  it('go: runs the file’s package restricted to the test functions the file declares, and reads stdout', () => {
    const f = 'internal/orders/core_test.go';
    const src = 'package orders\nfunc TestPlace(t *testing.T) {}\nfunc TestRefund(t *testing.T) {}\n';
    const pass = [{ Action: 'pass', Test: 'TestPlace' }, { Action: 'pass', Test: 'TestRefund' }].map((e) => JSON.stringify(e)).join('\n');
    const { results, calls } = runWith([f], () => ({ stdout: pass }), () => src);
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([['go', 'test', '-json', '-run', '^(TestPlace|TestRefund)$', './internal/orders']]);
    expect(results.get(f)).toBe(true);
    const fail = JSON.stringify({ Action: 'fail', Test: 'TestPlace' });
    expect(runWith([f], () => ({ stdout: fail, exit: 'fail' }), () => src).results.get(f)).toBe(false);
  });

  it('go: a file that declares no test function runs nothing, and is not-run', () => {
    const f = 'internal/orders/helpers_test.go';
    const { results, calls } = runWith([f], () => ({ stdout: '' }), () => 'package orders\nfunc helper() {}\n');
    expect(calls).toHaveLength(0);
    expect(results.has(f)).toBe(false);
  });

  it('JavaScript runs the adopter’s installed Vitest and Playwright, never npx', () => {
    const { calls } = runWith(['tests/unit/a.test.ts', 'e2e/a.spec.ts'], () => ({}));
    expect(calls.map((c) => c.cmd)).toEqual(['node_modules/.bin/vitest', 'node_modules/.bin/playwright']);
  });
});
