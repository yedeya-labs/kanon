# `agent-run`: run the agent

Block 2 of an agent lane (see [`agent-setup`](../agent-setup/README.md)). It records when the agent started, then runs `anthropics/claude-code-action` with the lane's prompt and flags.

The agent runs on one Claude credential: the subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, made with `claude setup-token`) or an Anthropic API key (`ANTHROPIC_API_KEY`, from the Claude Console). The lane passes whichever its caller maps, each under its own input, and the block checks them before the agent starts (plan 0009, step A1; [#579](https://github.com/yedeya-labs/kanon/issues/579)). The check fails the run, naming the secrets and never their values, when:

- both are set: "maps both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY; map one";
- neither is set, or the one mapped is empty;
- the one set looks like the other, such as an API key stored as `CLAUDE_CODE_OAUTH_TOKEN`. The check compares each value with the other credential's fixed prefix, `sk-ant-api` for a key and `sk-ant-oat` for a token. Those prefixes are the documented forms and haven't been measured against a real token and key yet, so a value with neither prefix passes.

Otherwise it writes the `auth` output. The credential then reaches the agent through the action step's environment only, never as an input of `claude-code-action`, which copies its inputs into its own `ALL_INPUTS` variable and into its inline-comment step.

When the action fails, a last step records whether it failed at its install of Claude Code, before any model was called ([#1470](https://github.com/yedeya-labs/kanon/issues/1470)). It reads what the action left on disk, never its log: a prompt the action wrote during this run, with no CLI at `~/.local/bin/claude`, the place the install puts it, and no result file or `conclusion` from the CLI. Then it writes a marker into the runner's temp directory, and [`agent-classify`](../agent-classify/README.md) and the run's telemetry row call the run `unavailable`, the model never reached. Any other shape writes nothing, including a CLI left by an earlier job on a reused runner, so the run keeps the "cannot tell which" notice. The step never changes the block's outcome. A self-hosted runner can keep its temp directory between jobs, so the marker names the run, attempt and job that wrote it and counts only for that job, and the block's first step deletes any marker already there.

The action is pinned to an exact version, so each Kanon release fixes the Claude Code CLI that runs. Dependabot proposes each bump as a Kanon pull request.

Nothing the agent runs can outlive its turn ([#621](https://github.com/yedeya-labs/kanon/issues/621)). Every lane runs headless, so when the agent ends its turn the session ends, and a command still running in the background is lost with the work that was waiting on it. The block sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, which takes `run_in_background` off the Bash tool, and raises the foreground cap to 45 minutes with `BASH_MAX_TIMEOUT_MS`, so a long gate can run to the end. It adds `--disallowedTools Monitor` after the lane's flags, and the prompt says why. A lane's `timeout-minutes` still bounds the job.

When the flags load no project settings (`--setting-sources user`, as the Reviewer's and the Lead's do), the block first points the agent's user settings (`CLAUDE_CONFIG_DIR`) at a new directory under the runner's temp directory. Claude Code would otherwise read `~/.claude` and `~/.claude.json`, and on a reused self-hosted runner an earlier job could have left a hook or an MCP server there ([#283](https://github.com/yedeya-labs/kanon/issues/283)). The block reads the flags the way the action does, and leaves every other lane as it was.

In Kanon's own repository, a bump of the action's pin is red until a maintainer has re-probed the Reviewer's and the Lead's grants against the CLI the new version installs ([#284](https://github.com/yedeya-labs/kanon/issues/284), [#405](https://github.com/yedeya-labs/kanon/issues/405)): `node .github/scripts/reviewer-grant-probe.mjs --version-only` names the version, and `--cli <binary>` runs both batteries and writes `.github/scripts/reviewer-grant-record.json` and `lead-grant-record.json`, which are committed with the bump.

## Use it

Call it with `id: agent`, so the lane reads `steps.agent.outputs.execution_file` and `steps.agent.outcome` as it would for the action itself.

<!-- x-release-please-start-version -->

```yaml
- id: agent
  uses: yedeya-labs/kanon/actions/agent-run@v0.42.0
  with:
    prompt: ${{ env.PROMPT }}
    claude_args: ${{ env.CLAUDE_ARGS }}
    claude-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    github-token: ${{ steps.app-token.outputs.token }}
```

On an API key, pass `anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}` in place of `claude-token`.

<!-- x-release-please-end -->

| Input | Required | Meaning |
|---|---|---|
| `prompt` | yes | The agent's instructions. When `agent-setup` resolved the agent's role, one instruction is appended: open every post with the persona header and role marker (plan 0005 §3.3). When `agent-setup` put Kanon's baseline in place of a playbook you don't have, a note names it, says git ignores it there, and says to stage your own with `git add -f`. Last, a rule says the run is headless: the session ends when the agent stops, so it runs every command in the foreground and never ends its turn to wait for one ([#621](https://github.com/yedeya-labs/kanon/issues/621)). If that step fails, the prompt goes through unchanged. |
| `claude_args` | yes | The flag block. Pass the same value to `agent-finish`, so the cost row records what ran. |
| `max-turns` | no | A turn limit raised for one dispatched run: a lane's `max_turns` input, which only its caller's `workflow_dispatch` fills ([#891](https://github.com/yedeya-labs/kanon/issues/891)). Empty runs the flag block's own `--max-turns`. A whole number from 1 to `max-turns-ceiling`, on a `workflow_dispatch` run with `max-turns-reason` set, replaces it, and the `--max-budget-usd` beside it becomes $0.40 a turn rounded up to the next $5 (`K-OBS-12`); the run's step summary records the raise and the reason. Anything else (above the ceiling, zero, negative, not a whole number, no reason, another event) fails the block before the agent starts, naming `max_turns`. |
| `max-turns-ceiling` | no | The lane's ceiling for `max-turns`, fixed by the lane. Empty means the lane's limit can't be raised, and a `max-turns` is refused. |
| `max-turns-reason` | no | Why the run's limit is raised: the lane's `reason` input, from the same dispatch. Required when `max-turns` is set. |
| `claude-token` | one of two | The Claude subscription token, `CLAUDE_CODE_OAUTH_TOKEN`. A composite action can't read secrets, so the lane passes it in. |
| `anthropic-api-key` | one of two | An Anthropic API key, `ANTHROPIC_API_KEY`, in place of the token. Pass exactly one of the two. |
| `github-token` | yes | The minted App token. The agent acts as the App, never as the default token. |
| `prompt-cache-ttl` | no | `CLAUDE_CODE_PROMPT_CACHE_TTL` for this lane. Empty keeps the CLI default. The run's telemetry row records it, through the `prompt-cache-ttl` output. |
| `full-transcript` | no | `"true"` prints the whole transcript into the job log. It changes nothing the model sees. |

| Output | Meaning |
|---|---|
| `execution_file` | The action's result file, for `agent-finish`. |
| `started-at` | When the agent started (UTC, ISO 8601). |
| `claude-args` | The flags the agent ran with: `claude_args`, with a raised turn limit and its dollar cap in place when the dispatch set one. Hand it to `agent-finish` as `claude-args-ran`. |
| `prompt-cache-ttl` | The TTL the run was pinned at, for `agent-finish`: the input, `default` when it is empty, and empty for anything but a plain word ([#546](https://github.com/yedeya-labs/kanon/issues/546)). |
| `auth` | The credential the agent ran on: `subscription` or `api-key`. A name, never anything the secret holds. Every lane hands it to `agent-finish` as `auth`, for the run row's `auth` ([plan 0009](../../docs/plans/0009-release-channels-and-api-key.md) §12). |
