import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Execute a workflow `run` body the way the RUNNER executes it (RA-1044), with the
 * runner's environment files pointed somewhere harmless (RA-1083).
 *
 * WHY EXECUTE AT ALL. Asserting on a workflow's source text is what let RA-1032 ship a
 * workflow that had never once succeeded while its tests stayed green. So several
 * suites here run the real `run:` body out of the parsed YAML. That is the right
 * shape — but it was being run in a mode the runner never uses.
 *
 * THE SHELL IS NOT `bash -c`. GitHub writes the body to a temporary FILE and runs a
 * shell over it, and the two differ in ways that decide whether a step aborts:
 *
 *   run: with no `shell:`  →  bash -e {0}
 *   shell: bash            →  bash --noprofile --norc -eo pipefail {0}
 *
 * `-e` is the one that matters. Under `bash -c` a step that exits non-zero mid-script
 * carries on and the suite passes; on the runner it aborts. `pipefail` is the second:
 * it is NOT in the default, only in the explicit `shell: bash` form, so a step relying
 * on it must say so. `grep -rn 'shell:' .github/workflows/` finds no key today, so
 * every step in this repo takes the first line — but the helper honours the key rather
 * than hard-coding the default, because the day someone adds `shell: bash` the tests
 * should follow the workflow instead of quietly disagreeing with it.
 *
 * Running a FILE rather than a `-c` string is part of the fidelity: `$0` differs, and
 * so does how the shell reports the failing line.
 *
 * THE ENVIRONMENT FILES ARE ALWAYS TEMPORARY (RA-1083). A `run` body writes to
 * `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_STEP_SUMMARY` and `$GITHUB_PATH`. When a
 * harness leaves one unset, bash expands it to the empty string and `>> ""` fails —
 * but when a harness inherits the *job's* value, the suite writes into the real run's
 * summary, and when someone runs a body by hand it lands a file literally named
 * `$GITHUB_OUTPUT` in the repo root. Both have happened: RA-1092 and RA-1083, the latter
 * reaching `main` through six green required checks because an extensionless root file
 * is outside ESLint's globs and outside `.gitignore`. Setting all four here means a
 * caller cannot forget one.
 */
export type WorkflowStep = {
  run?: string;
  shell?: string;
  id?: string;
  name?: string;
  /**
   * The step's own `env:` block. NOT applied automatically — `runWorkflowStep` merges
   * only what a caller passes, so a suite that wants the step's declared environment
   * passes `env: { ...step.env }` and thereby asserts *about the declared value*
   * rather than about one the test invented (`[STORE-112]`, RA-2065).
   */
  env?: Record<string, string>;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
};

/**
 * The agent step in a job, found by WHAT IT IS.
 *
 * Four suites located it as `steps.at(-1)`, which held only while the agent step
 * happened to be last. It stopped holding TWICE, independently and within a day:
 * RA-1408 appended an `if: failure()` step explaining a quota cap, and RA-1485 appended
 * a telemetry step. Both fixed it inline in each suite; two breaks from the same
 * cause is the argument for fixing it in one place instead.
 *
 * A positional lookup asserts about whatever occupies that slot, so it breaks on an
 * unrelated edit and, worse, could silently start asserting about the wrong step
 * rather than failing.
 */
export const agentStep = (steps: WorkflowStep[] = []): WorkflowStep | undefined =>
  steps.find((s) => typeof s.uses === 'string' && s.uses.includes('claude-code-action'));

/**
 * The agent step's prompt, or a real error naming what was missing.
 *
 * The positional version failed as `Cannot read properties of undefined (reading
 * 'replace')` at module scope, which names neither the file nor the cause. A suite
 * whose whole subject is the prompt should say "there is no prompt" when there isn't.
 */
export const agentPrompt = (steps: WorkflowStep[] = []): string => {
  const step = agentStep(steps);
  if (!step) throw new Error('no claude-code-action step in this job');
  const prompt = step.with?.prompt;
  if (typeof prompt !== 'string') throw new Error('the claude-code-action step has no `with.prompt`');
  return prompt;
};

/** The telemetry step paired with it (RA-1485). */
export const telemetryStep = (steps: WorkflowStep[] = []): WorkflowStep | undefined =>
  steps.find((s) => typeof s.uses === 'string' && s.uses.includes('actions/agent-telemetry'));

export type RunStepResult = {
  /** Exit status. 0 unless the step aborted — under `-e` that is the interesting case. */
  status: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for assertions that do not care which stream carried a message. */
  output: string;
  /** Raw `$GITHUB_OUTPUT` contents. */
  outputFile: string;
  /** Raw `$GITHUB_STEP_SUMMARY` contents. */
  summary: string;
  /** `$GITHUB_ENV` and `$GITHUB_PATH`, for the steps that write them. */
  envFile: string;
  pathFile: string;
  /** `key=value` lines from `$GITHUB_OUTPUT`, last write wins — as Actions resolves them. */
  outputs: Record<string, string>;
  /** The scratch directory, for a caller that needs to place a stub on PATH. */
  dir: string;
};

/**
 * The argv GitHub uses for a step, given its `shell:` key (or absence).
 *
 * `bash -e {0}` IS THE DEFAULT, SPELLED OUT (RA-2666). A composite action's `run` step must
 * name its shell, and the spine's blocks name exactly the one a workflow step with no
 * `shell:` gets — so a step moved into a block runs as it ran before. Modelled as that
 * default, not as a general custom-shell parser: any other custom string still throws.
 */
export const shellArgsFor = (step: WorkflowStep): string[] =>
  step.shell === 'bash'
    ? ['--noprofile', '--norc', '-eo', 'pipefail']
    : step.shell === 'bash -e {0}'
      ? ['-e']
      : step.shell && step.shell !== 'bash'
      ? // Only bash-family defaults are modelled. A step asking for something else
        // should fail loudly here rather than be silently run under bash.
        (() => {
          throw new Error(`workflow-step helper does not model shell: ${step.shell}`);
        })()
      : ['-e'];

/**
 * Run one step's body. `env` is merged over `process.env`; the four `GITHUB_*` file
 * variables are always overridden with temp files and cannot be passed in.
 */
export const runWorkflowStep = (
  step: WorkflowStep,
  { env = {}, cwd, dir = mkdtempSync(join(tmpdir(), 'wf-step-')) }: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    dir?: string;
  } = {},
): RunStepResult => {
  if (!step?.run) throw new Error('runWorkflowStep: the step has no `run` body — wrong step selected?');

  const scriptFile = join(dir, 'step.sh');
  writeFileSync(scriptFile, step.run);

  const files = {
    GITHUB_OUTPUT: join(dir, 'github_output'),
    GITHUB_ENV: join(dir, 'github_env'),
    GITHUB_PATH: join(dir, 'github_path'),
    GITHUB_STEP_SUMMARY: join(dir, 'github_step_summary'),
  };
  for (const f of Object.values(files)) writeFileSync(f, '');

  let stdout: string;
  let stderr = '';
  let status = 0;
  try {
    stdout = execFileSync('bash', [...shellArgsFor(step), scriptFile], {
      cwd,
      encoding: 'utf8',
      // Captured, not inherited: a harness that lets stderr through pollutes the
      // vitest output and hides which case produced it.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, ...files } as NodeJS.ProcessEnv,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    status = err.status ?? 1;
    stdout = String(err.stdout ?? '');
    stderr = String(err.stderr ?? '');
  }

  const outputFile = readFileSync(files.GITHUB_OUTPUT, 'utf8');
  const outputs: Record<string, string> = {};
  for (const line of outputFile.split('\n')) {
    const m = /^([^=]+)=([\s\S]*)$/.exec(line);
    // Last write wins, which is how Actions resolves a key written twice.
    if (m) outputs[m[1] as string] = m[2] as string;
  }

  return {
    status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
    outputFile,
    summary: readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8'),
    envFile: readFileSync(files.GITHUB_ENV, 'utf8'),
    pathFile: readFileSync(files.GITHUB_PATH, 'utf8'),
    outputs,
    dir,
  };
};
