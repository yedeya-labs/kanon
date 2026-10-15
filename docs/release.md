# The release workflow

Kanon's release mechanism (`K-SHIP-7`) ships as a reusable workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml). Every adopter releases the same way by calling it, pinned to an exact Kanon version (`K-ADOPT-11`). Kanon calls it itself through `$/`, which resolves to the commit being released.

On each push to the main branch it:

1. **Checks the merge settings** (`K-SHIP-3`), and fails unless the repository squash-merges only, with the PR title as the commit subject and the PR body as its message. A merge commit's subject, `Merge pull request #2 ...`, isn't a conventional commit, so release-please can't version it. On 2026-09-29 Kanon's first PR merged that way.
2. **Runs release-please v5** with your own `release-please-config.json` and `.release-please-manifest.json`. Every merge updates the release PR; merging the release PR tags `vX.Y.Z` and publishes the GitHub Release.
3. **Explains a failed release-please run.** When GitHub refused to let the workflow open the release PR, it says so and names the two settings that allow it, organisation first.
4. **Moves the major tag** (`v0`, later `v1`, ...) to the released commit, when the release's tag is a plain `vX.Y.Z`: a candidate's tag (`candidate-vX.Y.Z`, [below](#channels-candidates-and-stable)) or a monorepo component's (`<component>-vX.Y.Z`) leaves it where it is. Pin the exact version anyway: the major tag is a convenience.
5. **Refuses a stale release PR** ([#73](https://github.com/yedeya-labs/kanon/issues/73)). It checks the diff of every open release PR (a branch named `release-please--…` in your repository) against its merge base with your default branch, which is what a squash merge applies. It fails, with a comment on the PR, when the PR changes anything but version strings:
   - your changelog is left out, with the files your release type owns: `version.txt` (or your `version-file`) for `simple`, and for `node` and `python` a `changelog.json` at the repository root, if you keep one;
   - `.release-please-manifest.json` is compared as JSON, at the merge base and at the PR's head: every entry the PR changes or adds must hold a version, not one below the version it replaces, and no entry may be removed. So a package's first release, which adds its entry, passes ([#129](https://github.com/yedeya-labs/kanon/issues/129));
   - in your `extra-files`, and in any other file the PR modifies (your release type's own version files, such as `package.json`, `package-lock.json`, `pyproject.toml`, `__init__.py`, `Cargo.toml` or `Cargo.lock`), only a line whose sole change is a version may differ;
   - each version such a line changes must be one this release sets (a version the PR's manifest changes or adds), and must not go backwards. A stale copy that reverts a dependency bump, such as `serde = "1.0.190"` back to `"1.0.188"`, changes only a version, and fails ([#90](https://github.com/yedeya-labs/kanon/issues/90));
   - a file the PR adds, removes or renames fails it.

   It judges the head of the release branch itself, read from the branch ref ([#86](https://github.com/yedeya-labs/kanon/issues/86)). GitHub records a PR's new head after a push asynchronously, so right after release-please's push the PR can still name the previous one. The step re-reads the PR a few times, and if it still doesn't name the branch's head, it fails without judging it: re-run the Release workflow before you merge. The diff it judges is read for that head by its SHA, from a comparison with the base, not from the PR's file list, which GitHub also recomputes after a push ([#246](https://github.com/yedeya-labs/kanon/issues/246)). A comparison lists at most 300 files, so a release PR that changes 300 or more fails rather than being judged in part.

It takes no inputs ([ADR 0002](decisions/0002-standardise-dont-parameterise.md)). The file names are fixed, the branch is your default branch, and what really differs per repository (release type, package name) already lives in your own release configuration. The workflow's header comment gives the reasoning for each candidate input.

It takes one optional pair of secrets, `RELEASER_APP_ID` and `RELEASER_APP_PRIVATE_KEY`: the optional **Releaser** App (plan 0005 §3.1, [ADR 0013](decisions/0013-personal-accounts-and-two-apps.md)). Map them by name, never through `secrets: inherit`, and release-please runs on a Releaser token narrowed to Contents and Pull requests write. Leave them out and it runs on the workflow's own token, which is the default every section below describes. [With the Releaser](#with-the-releaser) says what changes.

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
    uses: yedeya-labs/kanon/.github/workflows/release.yml@v0.39.0
```

<!-- x-release-please-end -->

- **Grant the writes on the calling job only.** A reusable workflow can use no more than its caller grants, and nothing else in the file needs them.
- **`contents: write` is also what lets the guard read your merge settings.** GitHub returns those fields to a workflow token only when it can push; with `metadata` or `contents: read` they come back empty. If they are unreadable, the guard fails and says so, rather than passing.
- **With `lane-check`.** [`lane-check`](../actions/lane-check/README.md) passes this caller: a call to the release workflow is no lane caller, so it is held only to the one pin and never to pass `secrets: inherit`.
- **The Releaser, if you have one.** Add `secrets:` to the job, mapping `RELEASER_APP_ID: ${{ secrets.RELEASER_APP_ID }}` and `RELEASER_APP_PRIVATE_KEY: ${{ secrets.RELEASER_APP_PRIVATE_KEY }}`. See [With the Releaser](#with-the-releaser).
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

## With the Releaser

With the Releaser's secrets mapped, release-please pushes the release branch and opens the release PR with the Releaser's token instead of the workflow's, and the step after it creates or moves the major tag (`v0`, `v1`, …) with the same token. GitHub runs workflows for an App's pushes, so:

- **the release PR runs CI**, which the first limit below says it otherwise doesn't;
- **the release tag triggers `on: push: tags` workflows**, which the last limit below says it otherwise doesn't, **and so does the major tag** whenever a plain release moves it: a filter such as `v*` fires on both, and `v*.*.*` keeps it to the release tag;
- **the release PR is the Releaser's, which plan 0005 makes the only release bypass actor** (`K-MERGE-8`, §3.1). Mapping the secrets doesn't move the bypass; the next section does.

**The release PR passes the `dco` check.** Its commits are the Releaser's: created and signed by GitHub, with no sign-off, as `github-actions[bot]`'s are on the workflow's token. The [`dco` action](../actions/dco/README.md#exemptions) exempts them by the Releaser's App identity: the App register's `Releaser` row on your default branch, as the commit's GitHub account, with GitHub's own signature ([#337](https://github.com/yedeya-labs/kanon/issues/337)). So the Releaser needs its row in the register (`kanon apps` writes it), and your `dco` caller must pin a release that has the exemption. An earlier `dco` fails the release PR's commits on their missing sign-off.

**Then the bypass moves to the Releaser** ([#49](https://github.com/yedeya-labs/kanon/issues/49), `K-MERGE-8`):

1. **`kanon apps` adds the Releaser** to the bypass list of each ruleset on your default branch, for pull requests only, when it creates or reuses the Releaser and your token can edit the ruleset. A GitHub App manifest can't grant a bypass, so nothing else does it; otherwise the command prints the step. It removes nobody.
2. **Remove every other bypass actor** (the admin role, typically) once your `dco` caller pins a release with the exemption above. `kanon apps` prints the command, and `kanon doctor` reports the actor as `ruleset.bypass-extra` until it is gone, but only against such a release; against an earlier one it keeps the admin bypass, because that is still what merges the release PR.
3. **Merge release PRs through the front door.** Their checks now run, and the Releaser authored them, so anyone else's approval counts; with a merge queue, queue them. Nothing in the release workflow merges as the Releaser, so its bypass is held for a release workflow that does, and lets no one else skip the rules. Read the Release run first: the stale-release-PR guard is not one of the PR's checks (see [Known limits](#known-limits)).

**Decided by the Owner, 2026-10-06** (#337, #49): the `dco` exemption of the Releaser's release commits, by its App identity as above, is accepted; and from plan 0005's L5 on, Kanon's release PRs merge through the front door (CI, the Owner's approval, the merge queue), with the Releaser's bypass held but unused.

## Channels: candidates and stable

Kanon releases itself weekly, and in two steps, so every release runs on Kanon before an adopter's Dependabot proposes it ([plan 0009](plans/0009-release-channels-and-api-key.md), decided by the Owner on 2026-10-12). **Partly built:** step S2 is in, so `lane-check` and [`kanon doctor`](doctor.md) accept a candidate pin as an exact version (doctor notes it, `pin.candidate`, with the latest stable release beside it), and this workflow moves the major tag only when the release's tag is a plain `vX.Y.Z`. Step S4 is in too: Kanon's pin job, below. Steps S3 and S5, which make Kanon cut candidates and promote them, are not built yet, and until then every Kanon release is tagged `vX.Y.Z` when its release PR merges, as above, and the pin job opens nothing.

- **A release cadence.** Any project may declare one in its adoption record, `` - **Release cadence:** `weekly, Monday` `` under `## Choices` (`K-SHIP-7`, `K-LAYOUT-10`): its release PR then merges on that day, and a week's merges ship as one release. Kanon declares `weekly, Monday`. A project that declares none releases on every merge, and this workflow behaves the same either way: the cadence is when someone merges the release PR.
- **Candidates.** Kanon's release PR, merged on the release day, tags a candidate, `candidate-vX.Y.Z`, published as a GitHub pre-release, which GitHub's latest release never names. Kanon's own callers move to it the same day (ADR 0011, decision 2).
- **Kanon's pin job.** Kanon's caller of this workflow, [`release-please.yml`](../.github/workflows/release-please.yml), runs two more jobs after the release, which are Kanon's alone and not part of the reusable workflow. The first says whether this push cut a candidate: this workflow declares no outputs, so it reads what the release left on GitHub, the tag `candidate-v<version>` (the version the manifest records at the pushed commit) naming the pushed commit, with a Release that is a pre-release. A plain release and every other push find none, and nothing more runs. On a candidate, the second runs [`scripts/move-pins.mjs`](../scripts/move-pins.mjs) at the candidate's commit and opens `ci(deps): run Kanon on candidate vX.Y.Z` as the Releaser, whose merge, by the Owner, starts the candidate's soak. The script moves every `yedeya-labs/kanon` pin under `.github/` (each `@<release>` of a `uses:` line and each `#<release>` of an `npx` line) and the plugin's `ref` in `.claude/settings.json`, and nothing else: a reference in a comment, a ref that is not an exact release, and every file elsewhere stay as they are. It is the upgrade skill's edit, `node scripts/move-pins.mjs <release>` from a repository's root. The commit is made through the API, so GitHub signs it as the Releaser and the `dco` check exempts it; since it changes workflow files, its Releaser token asks for Workflows write. That is beyond the Releaser's shared grant, so Kanon's adoption record declares it for Kanon's own Releaser (`K-AGENT-3`, decided by the Owner on 2026-10-15; [`docs/doctor.md`](doctor.md#an-app-that-holds-more-than-kanon-grants)), and the Releaser App must hold it before the job can open the pull request. The release job never asks for it, and no other repository's Releaser needs it. The job opens nothing when its pull request already exists. Plan 0012's end-to-end gate (its step E11, not built) will be added as a precondition of the second job, so Kanon's pins move only to a candidate the harness passed.
- **Stable.** A candidate is promoted once it has been Kanon's pin for at least 72 hours, with no revert of its changes, no serious bug traced to it and no unexplained red run of Kanon's lanes: the stable tag, `vX.Y.Z`, goes on the candidate's commit, its Release becomes the latest, and the major tag moves with it.
- **What an adopter pins.** An exact version, as today (`K-ADOPT-11`): a stable `vX.Y.Z`, which its Dependabot entry proposes, or, to run ahead on purpose, a candidate. Nothing in an adopter's repository changes for the stable channel.
- **Your own releases** are untouched: candidates and promotion are Kanon's own operation, and this workflow keeps tagging `vX.Y.Z` for you.

## Intake first

Kanon's own step, for the hosted telemetry store it runs ([`docs/telemetry.md`](telemetry.md)), and none of this workflow's ([#794](https://github.com/yedeya-labs/kanon/issues/794)). A lane writes what its release's schema allows, and the ingest function refuses what the release it was deployed from doesn't: a raised `SCRUB_VERSION` is a 422 `scrub_version` `range`, a new row version or lane a 422 `enum`, and the collector of every repository on that release turns red until intake is redeployed (plan 0006 §4.2). Nothing in the release workflow knows which release intake runs, so the Owner checks it, before the release reaches anyone:

1. **Check the release against the deployed intake.** From a checkout of the release PR's head (`gh pr checkout <n>`), run [`infra/telemetry/intake-first.mjs`](../infra/telemetry/intake-first.mjs) with the release intake was last deployed from:

   ```sh
   node infra/telemetry/intake-first.mjs --deployed vX.Y.Z
   ```

   It compares the two releases' schemas, read from git, both ways. A widening is a row the release can write that the deployed intake refuses, such as `finding v1 scrub_version: accepts up to 2, the deployed intake up to 1`. A narrowing is a row the deployed intake accepts that the release refuses ([#828](https://github.com/yedeya-labs/kanon/issues/828)): a row version, a field, or an enum or list value it drops (a Merger stop rule or a Kanon error code, say), a field it newly requires, or a bound it tightens, such as `work_item v1 escalation_reasons: accepts <rule>, which the release does not`. A repository on an older pin can write such a row, and intake deployed from the release answers it with a 422 (`enum`, `unknown`, `required` or `range`), which turns its collector red. It compares the row kinds each release's ingest function stores too (`STORED_KINDS` in `infra/telemetry/function/rows.mjs`, [#918](https://github.com/yedeya-labs/kanon/issues/918)), since the function refuses a kind its schema knows but it doesn't store with a 422 `row_kind` `not-allowed`: a kind the release starts storing is a widening, such as `deploy: a row kind the deployed intake knows but does not store, which it refuses as row_kind not-allowed`, and a kind it stops storing a narrowing. A release with no `rows.mjs` stored every kind its schema knew; a `rows.mjs` that exports no `STORED_KINDS` is an exit 2, since the check can't tell what it stores. The check exits 0 when it names neither, 1 when it names widenings alone, and 3 when it names a narrowing, with or without widenings. Beyond those two lists it doesn't read the function's code, so a change to `validate`'s cross-field rules is not seen; the scrub's rules are, through `scrub_version`, which a change to them raises. Nothing records which releases are still pinned, so the deployed intake stands in for them: a pin whose rows it refuses is red already.
2. **On exit 1, deploy intake from that checkout, then merge.** Render, package and deploy as [Deploy](telemetry.md#deploy) says, and run [Verify](telemetry.md#verify), whose finding check sends the release's `SCRUB_VERSION`. The release PR changes only version strings and the changelog, so the function deployed is the release tag's. Intake accepts every earlier version too, so a repository on an older pin is unaffected. Once the tag exists, move the #41 job's pin to it ([Kanon's own bugs](telemetry.md#kanons-own-bugs)). Note the release you deployed from, beside the register: the next check starts from it.

   **On exit 3, the release narrows.** With no widening named, merge, but hold the deploy of intake from it: the deployed intake accepts every row the release writes, and deploying would refuse an older pin's. Deploy once no repository that sends telemetry is pinned to a release that writes the rows it names; until then each check names the narrowing again, since it starts from the release intake was deployed from. With widenings named too, there is no order that keeps every collector green: without the deploy this release's are red, with it an older pin's. Decide before merging, for instance by moving the narrowing to a later release, or by deploying and moving the older pins.
3. **With candidates** ([above](#channels-candidates-and-stable)), run the check on the candidate's tag and act on its exit as steps 1 and 2 say, before Kanon's own callers move to it: on exit 1, deploy intake from the candidate's tag; on exit 3, hold the deploy, or decide first when it names widenings too. Kanon's collector writes from them, so the order holds for Kanon first, and for adopters at promotion.

## Known limits

All are accepted on the workflow's own token, the default. Mapping the Releaser removes the first and the last, and with its bypass moved, the merge queue one (see [With the Releaser](#with-the-releaser)). The stale-release-PR guard's limits hold either way.

- **The release PR runs no CI.** It is opened with the workflow's own token, and a PR opened with that token triggers no workflows. It changes only the changelog, the version, the manifest and any `extra-files` you list (Kanon lists the documents holding its `uses:` lines, so they always name the latest release), but a test that pins one of those can still go red on `main` after the release PR merges. Kanon's own did once, on its first release: a test had pinned the manifest's starting value.
- **The stale-release-PR guard covers the release PR's diff, at the moment the workflow runs.** On 0.10.0, release-please rebuilt the release PR from stale copies of `docs/lanes.md` and `actions/lane-check/README.md`, and merging it (`db99870`) reverted the review lane's documentation that #67 had just merged. The guard reads the PR's diff after every push, so a PR in that state fails the Release run and gets a comment saying what it would revert. What it doesn't cover:
  - **It can't stop the merge, with or without the Releaser.** The guard fails the Release run and comments on the PR; it sets no status or check on the release PR's head. So nothing required carries its verdict: on the workflow's token the release PR is merged through the admin bypass, which skips required checks, and through the front door a stale release PR whose CI is green merges just the same. Read the Release run and the PR's comments before you merge it.
  - **It doesn't read the changelog or the files your release type owns** (`version.txt` for `simple`, the root `changelog.json` for `node` and `python`), whatever they hold.
  - **In a monorepo, a version may move to any version the release sets**, not only its own package's. The guard reads one set of released versions, not which file belongs to which package. A stale line that moves a version forward to another package's new version still passes.
  - **A diff too large for GitHub's API to return** (it omits a file's patch above a size limit) fails the guard rather than passing unchecked.
- **With a merge queue, the release PR can't be queued** on the workflow's token, because its required checks never report, so an admin merges it directly through the ruleset's pull-request bypass (`gh pr merge <n> --squash --admin`, or "Merge without waiting for requirements to be met" in the web UI). A bypass actor's merge skips the queue as well as the checks, which `K-MERGE-8` already allows for the release bot's PRs. This is confirmed on Kanon: with the queue on, release 0.4.2 was merged through the admin bypass on 2026-09-30. Closing and reopening the release PR as a person also works: the reopen triggers the PR's workflows, and once they pass it can be queued like any other.
- **Releases pool into a release PR that a human merges.** During bootstrap a merge doesn't produce a release by itself, which falls short of `K-SHIP-7`'s "every merge produces a release". A project that declares a release cadence (`K-SHIP-7`) uses exactly this: its release PR merges on the declared day.
- **The release tag triggers no workflows either**, for the same reason. A deploy workflow `on: push: tags` (`K-SHIP-7`'s deploy leg) won't fire from these tags; that needs the release App too.
