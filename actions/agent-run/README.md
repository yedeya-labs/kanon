# `agent-run`: run the agent

Block 2 of an agent lane (see [`agent-setup`](../agent-setup/README.md)). It records when the agent started, then runs `anthropics/claude-code-action` with the lane's prompt and flags.

The action is pinned to an exact version, so each Kanon release fixes the Claude Code CLI that runs. Dependabot proposes each bump as a Kanon pull request.

When the flags load no project settings (`--setting-sources user`, as the Reviewer's and the Lead's do), the block first points the agent's user settings (`CLAUDE_CONFIG_DIR`) at a new directory under the runner's temp directory. Claude Code would otherwise read `~/.claude` and `~/.claude.json`, and on a reused self-hosted runner an earlier job could have left a hook or an MCP server there ([#283](https://github.com/yedeya-labs/kanon/issues/283)). The block reads the flags the way the action does, and leaves every other lane as it was.

In Kanon's own repository, a bump of the action's pin is red until a maintainer has re-probed the Reviewer's and the Lead's grants against the CLI the new version installs ([#284](https://github.com/yedeya-labs/kanon/issues/284), [#405](https://github.com/yedeya-labs/kanon/issues/405)): `node .github/scripts/reviewer-grant-probe.mjs --version-only` names the version, and `--cli <binary>` runs both batteries and writes `.github/scripts/reviewer-grant-record.json` and `lead-grant-record.json`, which are committed with the bump.

## Use it

Call it with `id: agent`, so the lane reads `steps.agent.outputs.execution_file` and `steps.agent.outcome` as it would for the action itself.

<!-- x-release-please-start-version -->

```yaml
- id: agent
  uses: yedeya-labs/kanon/actions/agent-run@v0.33.0
  with:
    prompt: ${{ env.PROMPT }}
    claude_args: ${{ env.CLAUDE_ARGS }}
    claude-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    github-token: ${{ steps.app-token.outputs.token }}
```

<!-- x-release-please-end -->

| Input | Required | Meaning |
|---|---|---|
| `prompt` | yes | The agent's instructions. When `agent-setup` resolved the agent's role, one instruction is appended: open every post with the persona header and role marker (plan 0005 §3.3). When `agent-setup` put Kanon's baseline in place of a playbook you don't have, a note names it, says git ignores it there, and says to stage your own with `git add -f`. If that step fails, the prompt goes through unchanged. |
| `claude_args` | yes | The flag block. Pass the same value to `agent-finish`, so the cost row records what ran. |
| `claude-token` | yes | The Claude OAuth token. A composite action can't read secrets, so the lane passes it in. |
| `github-token` | yes | The minted App token. The agent acts as the App, never as the default token. |
| `prompt-cache-ttl` | no | `CLAUDE_CODE_PROMPT_CACHE_TTL` for this lane. Empty keeps the CLI default. |
| `full-transcript` | no | `"true"` prints the whole transcript into the job log. It changes nothing the model sees. |

| Output | Meaning |
|---|---|
| `execution_file` | The action's result file, for `agent-finish`. |
| `started-at` | When the agent started (UTC, ISO 8601). |
