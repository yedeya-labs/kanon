// A user scope this job made, for a lane whose flags load no project settings (kanon#283).
//
// `--setting-sources user` keeps the project's Claude Code settings out of the run, so the
// lane's flags are its whole grant (kanon#277). The user scope still loads, and on a runner that
// is `$HOME/.claude/` and `$HOME/.claude.json`. claude-code-action keeps whatever settings file
// it finds there and only adds a key to it. A GitHub-hosted runner starts every job with a new
// home, but a persistent self-hosted one keeps what an earlier job left: a hook, a permission
// rule, `env`, an MCP server, a `CLAUDE.md`. Measured on CLI 2.1.289 (the pinned action's):
// with all of those in a leftover home, a `--setting-sources user` run fired both hooks, spawned
// the MCP server and answered from the `CLAUDE.md`; with `CLAUDE_CONFIG_DIR` at a new directory,
// none of them did.
//
// So for such a lane, this points `CLAUDE_CONFIG_DIR` at a new directory under the runner's temp
// directory, through `$GITHUB_ENV`, for the action step after it. Only through `$GITHUB_ENV`,
// and only with a value: the CLI reads an EMPTY `CLAUDE_CONFIG_DIR` as the working directory
// (measured: it loaded a `settings.json` at the checkout's root as the user's), so a step `env:`
// that might be blank is the one thing this must never become. A lane that loads its project
// settings is left alone: the action approves the project's MCP servers in the home's settings
// file, and that lane runs the tree by design anyway.
//
// Inputs, by environment only: CLAUDE_ARGS, RUNNER_TEMP, GITHUB_ENV.

import { appendFileSync, mkdtempSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { loadsNoProjectSettings } from '../../scripts/lib/claude-args.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/**
 * Make the user scope, if the flags call for one, and say what was done.
 * @param {{ claudeArgs: string, runnerTemp: string, githubEnv: string }} input
 * @returns {{ ok: boolean, dir?: string, message: string }}
 */
export function userScope({ claudeArgs, runnerTemp, githubEnv }) {
  if (!loadsNoProjectSettings(claudeArgs)) {
    return { ok: true, message: "The flags load the project settings, so the runner's user scope is left as it is." };
  }
  if (!isAbsolute(runnerTemp) || /[\r\n]/.test(runnerTemp)) {
    return { ok: false, message: `::error title=user-scope::RUNNER_TEMP is not an absolute path on one line (${JSON.stringify(runnerTemp)}), so no user scope could be made for the agent.` };
  }
  const dir = mkdtempSync(join(runnerTemp, 'claude-user-'));
  appendFileSync(githubEnv, `CLAUDE_CONFIG_DIR=${dir}\n`);
  return { ok: true, dir, message: `The flags load no project settings, so the agent's user scope is ${dir}, which this job made.` };
}

if (isCliEntry(import.meta.url)) {
  const result = userScope({
    claudeArgs: process.env.CLAUDE_ARGS ?? '',
    runnerTemp: process.env.RUNNER_TEMP ?? '',
    githubEnv: String(process.env.GITHUB_ENV),
  });
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
