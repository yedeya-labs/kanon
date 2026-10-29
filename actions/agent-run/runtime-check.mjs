// Whether claude-code-action failed to install Claude Code, so no model was ever called (kanon#1470).
//
// The action installs the CLI inside its one step, after it has prepared the run, and retries the
// install three times. When every attempt fails, the step fails before the model is called and
// writes no result file, and `agent-classify` could only say "no result file, cannot tell which":
// it licensed no retry, and the promotion's red gate counted the run against the candidate though
// no candidate code ran (review run 39739375943, "Installation failed, retrying..." twice).
//
// The evidence is what the action leaves on disk, never its log. In the pinned action
// (`run.ts`, v1.0.262) the prepare phase writes the prompt to
// `$RUNNER_TEMP/claude-prompts/claude-prompt.txt`, then builds its MCP config, then installs the
// CLI at `$HOME/.local/bin/claude`. Building the config only assembles it (its one API call
// swallows its errors), so a failure there is close to unreachable, though it would read as an
// install failure too: the model wasn't called either way. So a failed step that set no `conclusion` and
// no `execution_file` (the CLI never returned), with a prompt written during this run and no CLI
// in place, failed at the install. Any other shape writes nothing:
//   - no prompt file, or one older than the agent's start stamp (a non-ephemeral runner keeps
//     `RUNNER_TEMP`): the action failed before its prepare finished, which is not this;
//   - a CLI in place: the install worked, or an earlier job's CLI is still there on a reused
//     runner, and the run keeps today's "cannot tell which" notice;
//   - a `conclusion` or a result file: the CLI ran, and the result file is what classifies it.
// Every unclear case leaves the marker out, so nothing widens what counts as unreachable.
//
// The marker is `RUNTIME_NOT_INSTALLED` in the runner's temp directory, and `agent-classify` and
// `agent-telemetry` read it, in the same job. A non-ephemeral runner can keep that directory
// between jobs, so the marker names this run, attempt and job, and this job execution's check run
// (`runtimeMarker`), and is read only by the job execution it names: the job id alone is shared by
// every entry of a matrix (kanon#1499). `agent-run`'s first step deletes any marker already there.
//
// Inputs, by environment only: OUTCOME, CONCLUSION, EXECUTION_FILE, STARTED_AT, RUNNER_TEMP, HOME,
// GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_JOB, which the runner sets, and
// KANON_JOB_CHECK_RUN_ID, which the step sets to `job.check_run_id`.
// ALWAYS EXITS 0: it records evidence about a red run and must never red one.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { RUNTIME_NOT_INSTALLED, runtimeMarker } from '../agent-classify/classify-agent-result.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** Where the pinned action's prepare phase writes the prompt, just before it installs the CLI. */
export const PROMPT_FILE = join('claude-prompts', 'claude-prompt.txt');
/** Where the pinned action's install puts the CLI. */
export const CLI_PATH = join('.local', 'bin', 'claude');

/**
 * Did the action fail at its install of Claude Code?
 * @param {{ outcome: string, conclusion: string, executionFile: string, startedAt: string,
 *   runnerTemp: string, home: string, stat?: typeof statSync, exists?: typeof existsSync }} input
 * @returns {{ notInstalled: boolean, message: string }}
 */
export function runtimeCheck({ outcome, conclusion, executionFile, startedAt, runnerTemp, home, stat = statSync, exists = existsSync }) {
  const no = (/** @type {string} */ why) => ({ notInstalled: false, message: `Not recorded as an install failure: ${why}.` });
  if (outcome !== 'failure') return no(`the agent step's outcome is \`${outcome || 'none'}\``);
  if (conclusion || executionFile) return no('Claude Code ran, so its result file classifies the run');
  if (!isAbsolute(runnerTemp ?? '') || !isAbsolute(home ?? '')) return no('RUNNER_TEMP or HOME is not an absolute path');
  let prompt;
  try { prompt = stat(join(runnerTemp, PROMPT_FILE)); } catch { prompt = null; }
  if (!prompt) return no('the action wrote no prompt, so it failed before its prepare finished');
  const started = Date.parse(startedAt ?? '');
  if (!Number.isFinite(started) || prompt.mtimeMs < started) {
    return no('the prompt file was not written during this run');
  }
  if (exists(join(home, CLI_PATH))) return no(`a Claude Code CLI is in place at ~/${CLI_PATH}`);
  return {
    notInstalled: true,
    message: 'claude-code-action failed after writing the prompt with no Claude Code CLI in place: '
      + 'its install failed, so the model was never called.',
  };
}

if (isCliEntry(import.meta.url)) {
  try {
    const env = process.env;
    const result = runtimeCheck({
      outcome: env.OUTCOME ?? '',
      conclusion: env.CONCLUSION ?? '',
      executionFile: env.EXECUTION_FILE ?? '',
      startedAt: env.STARTED_AT ?? '',
      runnerTemp: env.RUNNER_TEMP ?? '',
      home: env.HOME ?? '',
    });
    if (result.notInstalled) writeFileSync(join(String(env.RUNNER_TEMP), RUNTIME_NOT_INSTALLED), runtimeMarker(env, result.message));
    console.log(result.message);
  } catch (e) {
    console.log(`::warning title=runtime-check::Could not record whether Claude Code installed: ${e instanceof Error ? e.message : e}`);
  }
}
