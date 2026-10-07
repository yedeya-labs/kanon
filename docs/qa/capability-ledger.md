# Capability ledger

The agent-runtime and platform features Kanon's own pipeline could adopt, and what was decided about each (`K-SELF-16`), in the format of `K-LAYOUT-7`. **A human keeps this file:** the Owner folds in what the Overseer's weekly capability review proposes, from the `Ledger delta` block of its audit issue. The Overseer reads it and never writes it.

## Watermark

The last agent-runtime version reviewed: the Claude Code CLI version, as it appears after `## ` in its changelog, which the review slices from (`scripts/cc-sweep.mjs`). The audits carry the watermark forward in their `Ledger delta`; this one is the seed they fall back to. It was seeded on 2026-10-06 with the CLI that Kanon's lanes ran that day: `anthropics/claude-code-action@v1.0.241`, the pin in `actions/agent-run/action.yml` at the release Kanon's callers pin, installs Claude Code 2.1.289 (`.github/scripts/reviewer-grant-record.json`). The Overseer's runtime-version trigger compares the runtime of the release it runs with this line.

```text
Watermark: 2.1.289
```

## Runtime capabilities

| Capability | What it's for | CI? | Status here | Disposition |
|---|---|---|---|---|

## Platform capabilities

| Capability | What it's for | CI? | Status here | Disposition |
|---|---|---|---|---|
