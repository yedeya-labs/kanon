# `agent-run`: run the agent

Block 2 of an agent lane (see [`agent-setup`](../agent-setup/README.md)). It records when the agent started, then runs `anthropics/claude-code-action` with the lane's prompt and flags.

The action is pinned to an exact version, so each Kanon release fixes the Claude Code CLI that runs. Dependabot proposes each bump as a Kanon pull request.

## Use it

Call it with `id: agent`, so the lane reads `steps.agent.outputs.execution_file` and `steps.agent.outcome` as it would for the action itself.

<!-- x-release-please-start-version -->

```yaml
- id: agent
  uses: yedeya-labs/kanon/actions/agent-run@v0.18.0
  with:
    prompt: ${{ env.PROMPT }}
    claude_args: ${{ env.CLAUDE_ARGS }}
    claude-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    github-token: ${{ steps.app-token.outputs.token }}
```

<!-- x-release-please-end -->

| Input | Required | Meaning |
|---|---|---|
| `prompt` | yes | The agent's instructions. |
| `claude_args` | yes | The flag block. Pass the same value to `agent-finish`, so the cost row records what ran. |
| `claude-token` | yes | The Claude OAuth token. A composite action can't read secrets, so the lane passes it in. |
| `github-token` | yes | The minted App token. The agent acts as the App, never as the default token. |
| `prompt-cache-ttl` | no | `CLAUDE_CODE_PROMPT_CACHE_TTL` for this lane. Empty keeps the CLI default. |
| `full-transcript` | no | `"true"` prints the whole transcript into the job log. It changes nothing the model sees. |

| Output | Meaning |
|---|---|
| `execution_file` | The action's result file, for `agent-finish`. |
| `started-at` | When the agent started (UTC, ISO 8601). |
