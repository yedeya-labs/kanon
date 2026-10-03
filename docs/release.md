# The release workflow

Kanon's release mechanism (`K-SHIP-7`) ships as a reusable workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml). Every adopter releases the same way by calling it, pinned to an exact Kanon version (`K-ADOPT-11`). Kanon calls it itself through `$/`, which resolves to the commit being released.

On each push to the main branch it:

1. **Checks the merge settings** (`K-SHIP-3`), and fails unless the repository squash-merges only, with the PR title as the commit subject and the PR body as its message. A merge commit's subject, `Merge pull request #2 ...`, isn't a conventional commit, so release-please can't version it. On 2026-09-29 Kanon's first PR merged that way.
2. **Runs release-please v5** with your own `release-please-config.json` and `.release-please-manifest.json`. Every merge updates the release PR; merging the release PR tags `vX.Y.Z` and publishes the GitHub Release.
3. **Explains a failed release-please run.** When GitHub refused to let the workflow open the release PR, it says so and names the two settings that allow it, organisation first.
4. **Moves the major tag** (`v0`, later `v1`, ...) to the released commit. Pin the exact version anyway: the major tag is a convenience.
5. **Refuses a stale release PR** ([#73](https://github.com/yedeya-labs/kanon/issues/73)). It checks the diff of every open release PR (a branch named `release-please--…` in your repository) against its merge base with your default branch, which is what a squash merge applies. It fails, with a comment on the PR, when the PR changes anything but version strings:
   - your changelog is left out, with the files your release type owns: `version.txt` (or your `version-file`) for `simple`, and for `node` and `python` a `changelog.json` at the repository root, if you keep one;
   - `.release-please-manifest.json` is compared as JSON, at the merge base and at the PR's head: every entry the PR changes or adds must hold a version, not one below the version it replaces, and no entry may be removed. So a package's first release, which adds its entry, passes ([#129](https://github.com/yedeya-labs/kanon/issues/129));
   - in your `extra-files`, and in any other file the PR modifies (your release type's own version files, such as `package.json`, `package-lock.json`, `pyproject.toml`, `__init__.py`, `Cargo.toml` or `Cargo.lock`), only a line whose sole change is a version may differ;
   - each version such a line changes must be one this release sets (a version the PR's manifest changes or adds), and must not go backwards. A stale copy that reverts a dependency bump, such as `serde = "1.0.190"` back to `"1.0.188"`, changes only a version, and fails ([#90](https://github.com/yedeya-labs/kanon/issues/90));
   - a file the PR adds, removes or renames fails it.

It takes no inputs and no secrets ([ADR 0002](decisions/0002-standardise-dont-parameterise.md)). The file names are fixed, the branch is your default branch, and what really differs per repository (release type, package name) already lives in your own release configuration. The workflow's header comment gives the reasoning for each candidate input.

## Use it

### 1. A thin caller

Add `.github/workflows/release.yml` to your repository, pinned to an **exact version**:

<!-- x-release-please-start-version -->

```yaml
name: Release

on:
  push:
    branches: [main]

permissions: {}

jobs:
  release:
    name: Release
    permissions:
      contents: write
      pull-requests: write
    uses: yedeya-labs/kanon/.github/workflows/release.yml@v0.16.0
```

<!-- x-release-please-end -->

- **Grant the writes on the calling job only.** A reusable workflow can use no more than its caller grants, and nothing else in the file needs them.
- **`contents: write` is also what lets the guard read your merge settings.** GitHub returns those fields to a workflow token only when it can push; with `metadata` or `contents: read` they come back empty. If they are unreadable, the guard fails and says so, rather than passing.
- **Upgrades.** The Dependabot entry in the [`pr-title` README](../actions/pr-title/README.md#upgrades-dependabot) also updates this `uses:` line: Dependabot's `github-actions` ecosystem covers reusable workflows. Keep one entry.

### 2. Your release configuration

Two files at the repository root. The changelog sections are Kanon's type table (`K-SHIP-4`), all eleven, none hidden, so no type is silently dropped from a release:

`release-please-config.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "simple",
      "package-name": "your-project",
      "changelog-path": "CHANGELOG.md",
      "initial-version": "0.1.0",
      "include-component-in-tag": false,
      "include-v-in-tag": true,
      "bump-minor-pre-major": true,
      "bump-patch-for-minor-pre-major": false,
      "changelog-sections": [
        { "type": "feat", "section": "Features" },
        { "type": "fix", "section": "Bug Fixes" },
        { "type": "perf", "section": "Performance" },
        { "type": "refactor", "section": "Refactoring" },
        { "type": "build", "section": "Build and Dependencies" },
        { "type": "revert", "section": "Reverts" },
        { "type": "docs", "section": "Documentation" },
        { "type": "style", "section": "Styling" },
        { "type": "test", "section": "Tests" },
        { "type": "ci", "section": "CI" },
        { "type": "chore", "section": "Chores" }
      ]
    }
  }
}
```

`.release-please-manifest.json`

```json
{
  ".": "0.0.0"
}
```

`version.txt`, for the `simple` type

```text
0.0.0
```

The manifest starts at `0.0.0` and `initial-version` makes the first release `0.1.0`. After that, release-please owns the manifest. `package-name` is yours.

**`release-type` is your language's, and `simple` is the default.** Kanon has no opinion about your stack, so pick the release-please type that keeps the version where your project already keeps it:

| Your project | `release-type` | Where the version lives |
|---|---|---|
| Any language, or none of the below | `simple` | `version.txt`, which you create with `0.0.0` (release-please updates it and never creates it; `version-file` renames it) |
| Node | `node` | `package.json` and `package-lock.json` |
| Python | `python` | `pyproject.toml`, `setup.py` or `setup.cfg`, and the package's `__init__.py` |
| Go | `go` | nowhere but the tag and the manifest (Go modules are versioned by tag) |
| Rust | `rust` | `Cargo.toml` and `Cargo.lock` |

Leave `release-type` out and release-please reads it as `node`, which needs a `package.json`; write it out. Other release-please types work too, and the stale-release-PR guard holds every file they change to the version-only rule. Kanon's own copy is [`release-please-config.json`](../release-please-config.json), with `node`, because Kanon is a Node project.

**If you test your release configuration, pin what holds across releases**: the first release is `0.1.0`, the manifest has one entry, it holds a version, and it agrees with the file your release type keeps the version in (`version.txt`, `package.json`, `pyproject.toml`, `Cargo.toml`; with `go`, nothing besides the tag). Never pin the manifest's current value: the first release PR changes it, and that PR runs no CI (see below).

### 3. One-time settings

Made once, by an Owner:

1. **Merge settings** (`K-SHIP-3`), checked by the guard on every run. Repository → **Settings → General → Pull Requests**: allow squash merging only, with **"Pull request title and description"** as the default commit message. Or:

   ```sh
   gh api -X PATCH repos/<owner>/<repo> \
     -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
     -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
   ```
2. **Let GitHub Actions open the release PR**, organisation first, because while the organisation's checkbox is off the repository's is greyed out. Tick **"Allow GitHub Actions to create and approve pull requests"** under **Settings → Actions → General → Workflow permissions**, in the organisation and then in the repository. Or:

   ```sh
   gh api -X PUT orgs/<owner>/actions/permissions/workflow -F can_approve_pull_request_reviews=true
   gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -F can_approve_pull_request_reviews=true
   ```

## Known limits

All are accepted while Kanon has no release App, and all go away when one exists.

- **The release PR runs no CI.** It is opened with the workflow's own token, and a PR opened with that token triggers no workflows. It changes only the changelog, the version, the manifest and any `extra-files` you list (Kanon lists the documents holding its `uses:` lines, so they always name the latest release), but a test that pins one of those can still go red on `main` after the release PR merges. Kanon's own did once, on its first release: a test had pinned the manifest's starting value.
- **The stale-release-PR guard covers the release PR's diff, at the moment the workflow runs.** On 0.10.0, release-please rebuilt the release PR from stale copies of `docs/lanes.md` and `actions/lane-check/README.md`, and merging it (`db99870`) reverted the review lane's documentation that #67 had just merged. The guard reads the PR's diff after every push, so a PR in that state fails the Release run and gets a comment saying what it would revert. What it doesn't cover:
  - **It can't stop the merge.** The release PR is merged through the admin bypass, which skips required checks, so read the Release run and the PR's comments before you merge it.
  - **It doesn't read the changelog or the files your release type owns** (`version.txt` for `simple`, the root `changelog.json` for `node` and `python`), whatever they hold.
  - **In a monorepo, a version may move to any version the release sets**, not only its own package's. The guard reads one set of released versions, not which file belongs to which package. A stale line that moves a version forward to another package's new version still passes.
  - **A diff too large for GitHub's API to return** (it omits a file's patch above a size limit) fails the guard rather than passing unchecked.
- **With a merge queue, the release PR can't be queued**, because its required checks never report, so an admin merges it directly through the ruleset's pull-request bypass (`gh pr merge <n> --squash --admin`, or "Merge without waiting for requirements to be met" in the web UI). A bypass actor's merge skips the queue as well as the checks, which `K-MERGE-8` already allows for the release bot's PRs. This is confirmed on Kanon: with the queue on, release 0.4.2 was merged through the admin bypass on 2026-09-30. Closing and reopening the release PR as a person also works: the reopen triggers the PR's workflows, and once they pass it can be queued like any other.
- **Releases pool into a release PR that a human merges.** During bootstrap a merge doesn't produce a release by itself, which falls short of `K-SHIP-7`'s "every merge produces a release".
- **The release tag triggers no workflows either**, for the same reason. A deploy workflow `on: push: tags` (`K-SHIP-7`'s deploy leg) won't fire from these tags; that needs the release App too.
