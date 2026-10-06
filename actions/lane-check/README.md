# `lane-check`: check an adopter's lane callers

Fails unless the repository's Kanon lane callers, project-setup hook, App register and Dependabot entry follow the lane rules in [docs/lanes.md](../../docs/lanes.md) ([plan 0001 §6](../../docs/plans/0001-move-the-agent-lanes.md)). It holds only the permanent rules:

- **Each lane caller** (a workflow with a job that calls a Kanon lane, `yedeya-labs/kanon/.github/workflows/agent-<lane>.yml`, never the spine `agent-lane.yml`) holds only `name`, `run-name`, `on`, `permissions` and one job, and no `concurrency`. When the lane says what its caller's `run-name` must end with (the review lane does, on a `# CALLER RUN-NAME ENDS WITH:` line), the caller's ends with exactly that, as its last token. It is at `.github/workflows/<lane>.yml`, its lane's own file name, and is not itself a reusable workflow, because Kanon's scripts find a lane's runs by that file name and GitHub files a run under the top-level workflow (`K-LAYOUT-18`; in Kanon's own source tree, where that path holds the lane, its caller is exempt). When the lane reads a workflow of yours by its file name (a `# READS WORKFLOW:` line; the review lane and the reconciler read `ci.yml`), that workflow exists. When the lane says what its caller's `name` must be (the Merger's does, on a `# CALLER NAME:` line, because `merge-gate.mjs` tells its own checks from the rest by it), the caller has exactly that name.
- **That job** holds only `uses`, `with`, `secrets` and `permissions`. It passes only its own inputs through by the same name, maps exactly the secrets the lane declares, each to one repository secret (never `secrets: inherit`), and grants at least the permissions the lane declares, at its top level or on any of its jobs.
- **A call to any other Kanon workflow is not a lane caller.** The [release workflow](../../docs/release.md)'s caller maps the optional Releaser's secrets or none, and the [`apps-check`](../../docs/apps.md#checking-the-installations-later) caller maps its own Apps', so neither is held to the rules above, only to the pin below and to `secrets`: a job that calls any Kanon workflow maps each secret by name or passes none, never `secrets: inherit` ([#152](https://github.com/yedeya-labs/kanon/issues/152)).
- **Every Kanon reference** under `.github/` pins one exact version, and it is the version this check runs at.
- **The project-setup hook** exists at `.github/actions/project-setup/action.yml`, is a composite action, and declares every input Kanon's lanes pass it.
- **The hooks only some lanes call** exist, as composite actions, when a caller calls one of those lanes: the Explorer's sweep hook, `.github/actions/explore-sweep/action.yml`, for an explore caller (plan 0004 decision 5). A lane names each on a `# NEEDS HOOK:` line.
- **The App register** (`docs/qa/agent-identities.md`) has one row, with an App slug in backticks, for every role a caller's lane runs as (its `# KANON ROLE:` line). The rows of one App's roles name one slug, and the Author, the Judge and the Releaser name three different ones (plan 0005 §3.4).
- **No role-named App secret.** A caller that maps `IMPLEMENTER_APP_ID`, `REVIEWER_APP_ID` or another role's secret fails by name, with the `AUTHOR_` or `JUDGE_` secret the lane takes instead (§3.5).
- **The project documents a called lane reads** exist, and the stack document has `## Gates` exactly once and each of its other three sections at most once (`K-LAYOUT-17`). Which documents a lane reads is read from the lane itself. A missing playbook isn't a failure: the lane reads Kanon's baseline for it, and this says so. Neither is an omitted `## Schema changes`, `## Data isolation` or `## Generated files`, which means none.
- **The test-database declaration** (`docs/qa/test-database.md`), when there is one, has exactly one `**Test database:**` line declaring `none` or `hook`, never an engine (`K-LAYOUT-16`). No file is valid: it declares no database.
- **The escalation and exemptions files** (`docs/qa/escalation-paths.md`, `K-LAYOUT-8`, and `docs/qa/exemptions.md`, `K-LAYOUT-15`), parse with the same readers the guards and the Merger use, at your pinned version, and a malformed one fails by name with the reader's own message ([#153](https://github.com/yedeya-labs/kanon/issues/153)). A missing file or section is Kanon's default (only the pipeline's own paths escalate; nothing is exempt), and the reader's line naming it is printed.
- **The reference environment's deploy** in the adoption record (`docs/qa/adoption.md`, `K-LAYOUT-10`), when the record exists, parses with the reader the reconciler uses, and a malformed declaration fails by name. A record that declares no reference environment passes here: the reconciler fails on it when a project reaches its deploy phase (`K-PROJ-11`).
- **Whether the production promotion is human-gated** (`K-MERGE-4`, `K-LAYOUT-10`, [#158](https://github.com/yedeya-labs/kanon/issues/158)), when the adoption record has a `**Production promotion:**` bullet, parses with the reader the Merger uses, and a malformed one fails by name: one outside `## Choices`, written twice, in another shape than `human-gated (<what gates it>)`, or with nothing in its parentheses. A record without the bullet is Kanon's default, where every escalation path escalates.
- **Whether the Overseer is installed** (`K-LAYOUT-10`, plan 0004 step 13). The Overseer is optional, so the adoption record may have an `**Overseer:**` bullet under `## Choices`, its value `installed` or `not installed`, and it says what is true: `installed` with a caller of `agent-overseer.yml`, `not installed` without one. A record without the bullet, or no record, is Kanon's default, `not installed`, and this says so. A bullet in another shape fails, and so does a value, declared or the default, that the callers contradict: a caller of the Overseer needs a record that says `installed`.

**What it takes as a default it names**, one `::notice` each, so a repository that relies on a default is told so on every run ([plan 0005](../../docs/plans/0005-lean-installation.md) §5.2). The last line counts them: `lane-check: N lane caller(s) pass, with M documented default(s) taken`.
- **`.github/dependabot.yml`** has a `github-actions` entry for `/` that groups `yedeya-labs/kanon*`, prefixes its commits `ci`, and excludes `yedeya-labs/kanon*` from its `cooldown`. An entry with no `cooldown` fails: Dependabot then applies its default of 3 days, which holds back every Kanon release made in the last 3 days ([#233](https://github.com/yedeya-labs/kanon/issues/233)).

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
      - uses: yedeya-labs/kanon/actions/lane-check@v0.28.0
```

<!-- x-release-please-end -->

- **Check out first.** It reads your repository's files.
- **`yq` and `jq`.** It parses YAML with `yq` (mikefarah v4) and checks it with `jq`. GitHub's hosted runners have both; a self-hosted runner must provide them. Node is Kanon's own: the action's first step puts the Node major Kanon declares on the `PATH`, as every lane does. That Node, and `KANON`, stay set for the rest of the job, so run the check in a job of its own, as above, or before your own toolchain's setup.
- **No inputs.** Everything it checks is a fixed path or is read from the lanes ([ADR 0002](../../docs/decisions/0002-standardise-dont-parameterise.md)).
- Pin the same exact Kanon version as your lanes, and let Dependabot propose upgrades (`K-ADOPT-11`).
- **Run it locally** from a Kanon checkout at your pinned tag, in your repository's root: `KANON_ROOT=<kanon checkout> ACTION_REF=<tag> bash <kanon checkout>/actions/lane-check/lane-check.sh`. It needs `yq` (mikefarah v4) and `jq` on your `PATH`, and Node 24 when you keep an escalation or exemptions file or an adoption record, or call the Overseer.
