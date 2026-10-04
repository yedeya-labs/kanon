# `dco`: Kanon's sign-off check

Fails a pull request unless **every commit in it** carries a `Signed-off-by:` trailer whose name and email are the commit **author's**. This is the Developer Certificate of Origin sign-off that [ADR 0010](../../docs/decisions/0010-licence.md) asks of every contribution, instead of a contributor licence agreement.

- **Name exactly, email ignoring case.** `git commit -s` writes the sign-off from your `user.name` and `user.email`, so it matches whenever those are also the author identity.
- **A person signs off, never an AI or a bot.** A sign-off by an `anthropic.com` address (such as Claude's `noreply@anthropic.com`) or by any `[bot]` identity never counts, even when it matches the author. `Co-Authored-By: Claude ...` is fine: it's a credit, not a certification.
- **Several trailers are fine.** Other sign-offs and trailers (`Co-Authored-By:`, `Reviewed-by:`) may sit alongside, as long as one `Signed-off-by:` is the author's.
- **Git's trailer rules decide what a sign-off is.** It must be in the message's **last paragraph**, and that paragraph must be a trailer block the way `git interpret-trailers` reads one. A `Signed-off-by:` line in the middle of the body, or in the subject, doesn't count, because git itself wouldn't treat it as a trailer.

On failure it lists each offending commit by short SHA and subject, with the reason, and prints the fix.

## The repository's own agents

An adopter may delegate sign-off for its own agents' commits to one named person ([`K-AGENT-44`](../../rulebook/03-agents.md)). Whether a standing delegation meets the DCO's certification is the adopter's own judgement; Kanon never makes it for them.

- **The record** is `docs/qa/sign-off-delegation.md`: one table, `| Delegate | Email | Delegated on |`, with exactly one row ([`K-LAYOUT-14`](../../rulebook/11-repository-layout.md)).
- **An agent's commit** is one whose author is an App in the App register, `docs/qa/agent-identities.md` ([`K-LAYOUT-6`](../../rulebook/11-repository-layout.md)): the login `<slug>[bot]`, or the noreply email `<id>+<slug>[bot]@users.noreply.github.com`, with `<slug>` in the register. It must carry the delegate's `Signed-off-by:` (name exactly, email ignoring case). Nobody else's sign-off counts for it, the author's included.
- **Every other commit is unchanged,** and the delegate's sign-off on a person's commit counts for nothing.
- **Both files are read from the repository's default branch** over the API, never from the pull request and never from its base ([`K-MERGE-17`](../../rulebook/04-review-and-merge.md)), so a PR that adds its own App to the register, or names its own delegate, is still judged by the default branch. The base isn't enough: on a stacked PR it is another PR's branch, which that PR's author can write to. The change takes effect for the pull requests after it merges. If the default branch's name can't be read, the check fails.
- **No record, or a malformed one, delegates nothing.** An agent's commit is then checked like any other, and fails on its bot sign-off. The log says which file was missing or what was wrong with it.
- **The files are read only when a commit has a bot author,** so a pull request of people's commits costs no extra call. A read that fails for any reason but "not found" fails the check.

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

<!-- x-release-please-start-version -->

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
      - uses: yedeya-labs/kanon/actions/dco@v0.23.0
```

<!-- x-release-please-end -->

- **No checkout needed.** The action reads the pull request's commits through the REST API with the workflow token, and carries its own script, read from its own directory at the version you pinned.
- **`pull-requests: read`** lets the token list the commits. **`contents: read`** is also needed on a private repository, for the commits and for the register and delegation files on the default branch. The default branch's name comes from the repository itself, which every workflow token may read.
- **No inputs.** The pull request number, repository, base branch and token reach the script only through environment variables, never through the shell.
- **With a merge queue** (`K-MERGE-7`), a required check must also run on `merge_group`, or queued PRs wait until they time out. A merge group carries no pull request, so add `merge_group:` under `on:`, gate this step with `if: github.event_name == 'pull_request'`, and add a step before it that passes with `if: github.event_name == 'merge_group'`. Keep the job's `name:` literal and the job itself unconditional, so the check reports under the same name on both events. Skipping the sign-off check on the queue is safe because a PR can only be queued once this check has passed on it, and a push to a queued PR takes it out of the queue. Kanon's own [`dco.yml`](../../.github/workflows/dco.yml) is the worked example.
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
