# `pr-title`: Kanon's PR-title check

Fails a pull request whose title isn't a conventional commit with one of Kanon's fixed types, or that ends in an issue reference such as `(#12)`. This enforces [`K-SHIP-4`](../../rulebook/06-shipping.md). The type table is Kanon's and isn't configurable:

| Type | Version bump | Deploys |
|---|---|---|
| `feat` | minor | yes |
| `fix`, `perf`, `refactor`, `build`, `revert` | patch | yes |
| `docs`, `style`, `test`, `ci`, `chore` | patch | no |

On failure it prints the reason and the recognised types.

## Use it

Add a workflow such as `.github/workflows/pr-title.yml`, pinned to an **exact version** ([`K-ADOPT-11`](../../rulebook/10-adoption.md)):

```yaml
name: PR title

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read

jobs:
  title:
    name: Conventional title
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: yedeya-labs/kanon/actions/pr-title@v0.3.0
```

- **No checkout needed.** The action carries its own script and reads it from its own directory, at the version you pinned, so the action and its script can't drift apart.
- **`edited` matters.** Without it, fixing a bad title doesn't re-run the check.
- **Node 18 or later** must be on the runner. GitHub's hosted runners have it. On a self-hosted runner, add `actions/setup-node` before this step.
- **Input `title`** (optional) defaults to the pull request's title. The title reaches the check only through an environment variable, never through the shell, because a PR title is untrusted input.
- **The release tool must agree.** Your `release-please-config.json` needs a changelog section, not hidden, for each of the eleven types above (`K-SHIP-7`). A type the release tool doesn't know is dropped silently.

A moving major tag (`@v0`) also exists, but pin the exact version: Dependabot then proposes each upgrade as a PR that your own CI tests.

To validate a title locally before opening a PR, run the same script: `node actions/pr-title/pr-title.mjs "feat(scope): your title"` from a checkout of Kanon at your pinned version.

## Upgrades: Dependabot

Add this entry to `.github/dependabot.yml`. It watches only Kanon's actions, groups them into one PR, and titles that PR `ci(deps): ...` so it passes this check:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: daily
    allow:
      - dependency-name: "yedeya-labs/kanon*"
    groups:
      kanon:
        patterns:
          - "yedeya-labs/kanon*"
    # Kanon is first-party: exempt it from Dependabot's default 3-day cooldown,
    # which would otherwise hold back every Kanon release. Third-party updates keep it.
    cooldown:
      default-days: 3
      exclude:
        - "yedeya-labs/kanon*"
    commit-message:
      prefix: ci
      include: scope
```

If you already have a `github-actions` entry for other actions, keep one entry per ecosystem and directory. Add the `allow` pattern and the group to it instead of adding a second entry.

## One-time settings while Kanon is private

Both are made by an Owner, once:

1. **Let the organisation's workflows use Kanon.** In the Kanon repository, **Settings → Actions → General → Access** (at the very bottom of the page, shown only for private repositories): "Accessible from repositories in the `yedeya-labs` organization". The section is easy to miss, and the API sets it directly:

   ```sh
   gh api -X PUT repos/yedeya-labs/kanon/actions/permissions/access -f access_level=organization
   ```

   Without it, a workflow outside Kanon can't resolve `yedeya-labs/kanon/...` and fails at setup.
2. **Let Dependabot read Kanon.** Organisation → **Settings → Advanced Security → Global settings**, then scroll to the **bottom** of the page, below the Dependabot and code-scanning sections, to **"Grant Dependabot access to repositories"**. Tick **`yedeya-labs/kanon`**: the repository Dependabot reads *from*, not the adopter's own. Without it, every Dependabot run fails with *"Either the repo doesn't exist, or Dependabot doesn't have access to it"*.

A failed Dependabot run can't be re-run. To start a fresh one, change `.github/dependabot.yml` on the main branch.

An adopter outside the `yedeya-labs` organisation can't use the action until Kanon is public.
