# Capability ledger

The agent-runtime and platform features Kanon's own pipeline could adopt, and what was decided about each (`K-SELF-16`), in the format of `K-LAYOUT-7`. **A human keeps this file:** the Owner folds in what the Overseer's weekly capability review proposes, from the `Ledger delta` block of its audit issue. The Overseer reads it and never writes it.

## Watermark

The last agent-runtime version reviewed: the Claude Code CLI version, as it appears after `## ` in its changelog, which the review slices from (`scripts/cc-sweep.mjs`). The audits carry the watermark forward in their `Ledger delta`; this one is the seed they fall back to. It was seeded on 2026-10-06 with the CLI that Kanon's lanes ran that day: `anthropics/claude-code-action@v1.0.241`, the pin in `actions/agent-run/action.yml` at the release Kanon's callers pin, installs Claude Code 2.1.289 (`.github/scripts/reviewer-grant-record.json`). The Overseer's runtime-version trigger compares the runtime of the release it runs with this line. The Owner folded in the first audit's delta on 2026-10-07 ([#468](https://github.com/yedeya-labs/kanon/issues/468)), which reviewed 2.1.290 to 2.1.292.

```text
Watermark: 2.1.292
```

## Runtime capabilities

| Capability | What it's for | CI? | Status here | Disposition |
|---|---|---|---|---|
| Agent tool `effort` parameter (Claude Code 2.1.292) | Run a sub-agent at a chosen effort level | yes | not used | no current gap |
| `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` (2.1.292) | A longer base delay when retrying an overloaded (529) request | yes | not set | no current gap |
| Bash read-only checks tightened: `rg`/`git grep` with wildcard arguments, and `pyright` (2.1.291) | Fewer commands auto-approved as read-only | yes | inherited when the pin reaches 2.1.291 or later; the Reviewer's grant battery is re-probed on that bump (#284) | no current gap |
| Mod and plugin-hook additions: `agentId` on `tool.check`, `prompt.autocomplete`, `$.model.complete` caching, workflow agents on `agent.spawn` (2.1.291, 2.1.292) | Extending Claude Code through mods and plugin hooks | no | the pipeline runs no mods | no current gap |

## Platform capabilities

| Capability | What it's for | CI? | Status here | Disposition |
|---|---|---|---|---|
