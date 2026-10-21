import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { ROOT } from './adopter.js';

/**
 * What the red-test tests share (tests/library/red-test*.test.ts): how `verify` runs, given how
 * `scope` ended, and the end-to-end check on a real repository with a real runner. The end-to-end
 * cases were one block of 32, each starting a real Vitest, which made red-test.test.ts one of the
 * slowest files in `npm test`; they were split by area so they run in parallel (#1204).
 *
 * WHAT `verify` DOES, GIVEN HOW `scope` ENDED (kanon#1186). A ruleset counts a skipped required
 * check as passing, so a `scope` that fails must never leave `Red-test verification` skipped behind
 * it. EVALUATED, as Actions reads a job's and a step's `if:`: a field with no status function is
 * `success() && (field)`, which is how a failed `scope` once skipped `verify` silently. A step
 * fails for certain when its script ends in `exit 1`; any other step is taken to pass, which is
 * all these cases need, since nothing after a step that fails runs.
 */
export type JobEnd = { result: 'success' | 'failure' | 'skipped' | 'cancelled'; outputs: Record<string, string> };
export const RED_TEST_WF = parse(readFileSync(join(ROOT, '.github/workflows/red-test.yml'), 'utf8'));
export const ifHolds = (field: string | undefined, ctx: { needs: Record<string, JobEnd>; ok: boolean; cancelled: boolean }): boolean => {
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
export type VerifyRun = { runs: false } | { runs: true; ran: string[]; failedAt?: string };
export const verifyRun = (scope: JobEnd, cancelled = false): VerifyRun => {
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
export const SCOPE_FAILED_STEP = 'Fail when the scope job did not finish';

/**
 * END TO END: the script, as the workflow runs it, on a real repository with a real runner. Kanon's
 * own Vitest is the project's runner here, linked in as the project-setup hook would install it,
 * declared by the stack document as a `tests` tree's runner (`K-LAYOUT-17`). Each case is one
 * shape of PR, committed as base then head, and the check is run against the two.
 */
export const SCRIPT = join(ROOT, 'scripts/red-test.mjs');
export const STACK = '# Stack\n\n## Gates\n\n1. run the tests\n\n## Code areas\n\n- `src/` — code: the application\n- `tests/` `vitest` — tests: the suite\n';
export const write = (dir: string, files: Record<string, string | null>) => {
  for (const [f, body] of Object.entries(files)) {
    if (body === null) { rmSync(join(dir, f)); continue; }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
};
export type Run = { status: number | null; out: string; output: string; outputs: Record<string, string>; dirty: string; addedOnDisk: boolean };
export type Opts = {
  runner?: boolean; args?: string[]; after?: Record<string, string>; event?: unknown;
  /** A commit on the trusted branch after the merge base: the default branch moved on. */
  trusted?: Record<string, string>;
  /** Where the areas come from, in place of `--areas-ref trusted`. */
  areasArgs?: string[];
};
export const check = (base: Record<string, string>, head: Record<string, string | null>, opts: Opts = {}): Run => {
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
export const BUGGY = { 'src/add.mjs': 'export const add = (a, b) => a - b;\n' };
export const FIXED = { 'src/add.mjs': 'export const add = (a, b) => a + b;\n' };
export const REAL_TEST = { 'tests/add.test.ts': "import { expect, it } from 'vitest';\nimport { add } from '../src/add.mjs';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n" };
export const VACUOUS_TEST = { 'tests/add.test.ts': "import { expect, it } from 'vitest';\nimport { add } from '../src/add.mjs';\nit('adds', () => { expect(typeof add).toBe('function'); });\n" };
