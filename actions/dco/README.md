# `dco`: Kanon's sign-off check

Fails a pull request unless **every commit in it** carries a `Signed-off-by:` trailer whose name and email are the commit **author's**. This is the Developer Certificate of Origin sign-off that [ADR 0010](../../docs/decisions/0010-licence.md) asks of every contribution, instead of a contributor licence agreement.

- **Name exactly, email ignoring case.** `git commit -s` writes the sign-off from your `user.name` and `user.email`, so it matches whenever those are also the author identity.
- **A person signs off, never an AI or a bot.** A sign-off by an `anthropic.com` address (such as Claude's `noreply@anthropic.com`) or by any `[bot]` identity never counts, even when it matches the author. `Co-Authored-By: Claude ...` is fine: it's a credit, not a certification.
- **Several trailers are fine.** Other sign-offs and trailers (`Co-Authored-By:`, `Reviewed-by:`) may sit alongside, as long as one `Signed-off-by:` is the author's.
- **Git's trailer rules decide what a sign-off is.** It must be in the message's **last paragraph**, and that paragraph must be a trailer block the way `git interpret-trailers` reads one. A `Signed-off-by:` line in the middle of the body, or in the subject, doesn't count, because git itself wouldn't treat it as a trailer.

On failure it lists each offending commit by short SHA and subject, with the reason, and prints the fix.

## Exemptions

The list is fixed ([ADR 0002](../../docs/decisions/0002-standardise-dont-parameterise.md)):

| Commit | Why it's exempt |
|---|---|
| A merge commit (two or more parents) | It authors no change of its own; the commits it brings in are checked themselves. |
| `dependabot[bot]`, created and signed by GitHub | Dependabot signs off as `dependabot[bot] <support@github.com>`, which isn't its author email, and its upgrade PRs are how an adopter's Kanon pin moves (`K-ADOPT-11`). |
| `github-actions[bot]`, created and signed by GitHub | release-please commits the release PR with the workflow token, and signs nothing off (`K-SHIP-7`). |

A bot's name on a commit isn't enough: anyone can write that email into a commit. The exemption also needs GitHub as the committer (`web-flow`) and a signature GitHub verified. A human commit pushed onto a bot's branch is checked like any other.

## Use it

Add `.github/workflows/dco.yml`, pinned to an **exact version** ([`K-ADOPT-11`](../../rulebook/10-adoption.md)). Use the exact Kanon release you adopt (the action first shipped in `v0.4.0`), never the moving `v0`:

```yaml
name: DCO

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: read

jobs:
  dco:
    name: Signed-off commits
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: yedeya-labs/kanon/actions/dco@v0.4.0
```

- **No checkout needed.** The action reads the pull request's commits through the REST API with the workflow token, and carries its own script, read from its own directory at the version you pinned.
- **`pull-requests: read`** lets the token list the commits. **`contents: read`** is also needed on a private repository.
- **No inputs.** The pull request number, repository, base branch and token reach the script only through environment variables, never through the shell.
- **At most 250 commits.** That is all the API lists for a pull request. The check fails closed on a longer one rather than pass the commits it couldn't read.
- **Node 18 or later** must be on the runner. GitHub's hosted runners have it. On a self-hosted runner, add `actions/setup-node` before this step.
- **Commits made in GitHub's web editor** need a sign-off too. Turn on **Settings → General → "Require contributors to sign off on web-based commits"** and GitHub adds it for them.

Dependabot is set up the same way as for the [PR-title action](../pr-title/README.md#upgrades-dependabot).

## Fix a failing pull request

Sign off with the author identity, then force-push:

```sh
git commit --amend -s          # the last commit only
git rebase --signoff main      # every commit since main
git push --force-with-lease
```
