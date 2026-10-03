# `lane-check`: check an adopter's lane callers

Fails unless the repository's Kanon lane callers, project-setup hook, App register and Dependabot entry follow the lane rules in [docs/lanes.md](../../docs/lanes.md) ([plan 0001 §6](../../docs/plans/0001-move-the-agent-lanes.md)). It holds only the permanent rules:

- **Each caller** (a workflow with a job that calls `yedeya-labs/kanon/.github/workflows/<lane>.yml`) holds only `name`, `run-name`, `on`, `permissions` and one job, and no `concurrency`. When the lane says what its caller's `run-name` must end with (the review lane does, on a `# CALLER RUN-NAME ENDS WITH:` line), the caller's ends with exactly that, as its last token.
- **That job** holds only `uses`, `with`, `secrets` and `permissions`. It passes only its own inputs through by the same name, maps exactly the secrets the lane declares, each to one repository secret (never `secrets: inherit`), and grants at least the permissions the lane declares, at its top level or on any of its jobs.
- **Every Kanon reference** under `.github/` pins one exact version, and it is the version this check runs at.
- **The project-setup hook** exists at `.github/actions/project-setup/action.yml`, is a composite action, and declares every input Kanon's lanes pass it.
- **The App register** (`docs/qa/agent-identities.md`) has one row, with an App slug in backticks, for every role a caller's lane runs as.
- **`.github/dependabot.yml`** has a `github-actions` entry for `/` that groups `yedeya-labs/kanon*`, prefixes its commits `ci`, and leaves Kanon out of any cooldown.

What a lane declares, and what the hook must accept, is read from Kanon's own files at the version you pinned, so the check and the lanes can't disagree.

## Use it

<!-- x-release-please-start-version -->

```yaml
name: Lane check

on:
  pull_request:
  merge_group:

permissions:
  contents: read

jobs:
  lanes:
    name: Lane check
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - uses: yedeya-labs/kanon/actions/lane-check@v0.16.0
```

<!-- x-release-please-end -->

- **Check out first.** It reads your repository's files.
- **`yq` and `jq`.** It parses YAML with `yq` (mikefarah v4) and checks it with `jq`. GitHub's hosted runners have both; a self-hosted runner must provide them.
- **No inputs.** Everything it checks is a fixed path or is read from the lanes ([ADR 0002](../../docs/decisions/0002-standardise-dont-parameterise.md)).
- Pin the same exact Kanon version as your lanes, and let Dependabot propose upgrades (`K-ADOPT-11`).
