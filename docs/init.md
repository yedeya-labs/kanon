# `kanon init`

`kanon init` installs Kanon in the repository whose checkout you run it from ([plan 0005](plans/0005-lean-installation.md) §5.4). It inspects the repository and its owner, asks what it can't infer, writes the declarations and the lane callers pinned to the release it runs from, and the [kanon plugin's](skills.md#declare-it-in-the-repository) declaration if you want it, creates the labels, the bucket milestones and, where the plan has rulesets, the default branch's ruleset, and runs [`kanon apps`](apps.md) for the Apps the lanes run as. The ruleset requires the status check `Lane check` only once a job on the default branch reports it on every pull request, read from GitHub as [`kanon doctor`](doctor.md) reads it ([#444](https://github.com/yedeya-labs/kanon/issues/444)): a check required before then blocks every other pull request until the one adding the job merges, so until then the rule is a step for after that merge (`ruleset.require-check`). To a ruleset it didn't create, `init` adds that rule and no other, and only with a token that can administer the repository; it writes `lane-check.yml` unless another workflow already has a job that reports the check, which a step of another job doesn't. It commits nothing, prints as exact steps whatever its token or plan can't do, and changes nothing on a second run. `kanon init --help` lists every option.

It is **scriptable** ([ADR 0014](decisions/0014-adopter-audiences.md), decision 2): every question has a flag that answers it, and `--json` prints the result as one JSON document. The agent skills of plan 0005's L11 drive it that way, and so can any program.

## Answering without a terminal

Each question `init` asks has a flag. A flag answers its question; `--yes` takes the default of every question no flag answers; without `--yes`, the questions no flag answers are asked. On a standard input that isn't a terminal, `init` refuses to start without `--yes` (or `--json`, which implies it), and changes nothing.

| Question | Flag | Default |
|---|---|---|
| Who is the Owner? | `--project-owner <who>` | the token's login |
| Who is the Maintainer? | `--maintainer <who>` | the Owner |
| Who is the Stakeholder? | `--stakeholder <who>` | the Owner |
| Which lanes to install? | `--lanes <list>` | the lanes the repository already calls, or `review` |
| The stack's gates | `--gates <list>`, or `--gates none` | suggested from `package.json`, a `Makefile`, Cargo or Go |
| Does a lane need a test database? | `--test-database none\|hook` | `none` |
| Record a sign-off delegation? | `--delegation`, `--no-delegation` | no |
| The delegate's name | `--delegate-name <name>` (implies `--delegation`) | `git config user.name` |
| The delegate's email | `--delegate-email <email>` (implies `--delegation`) | `git config user.email` |
| Delete GitHub's default labels outside the taxonomy? | `--delete-default-labels`, `--keep-default-labels` | keep |
| Create the optional Releaser App? (asked only of a repository that calls Kanon's release workflow) | `--releaser`, `--no-releaser` | no |
| Reuse an App the owner already has, rather than create a second? (asked only when the owner's installations hold one the chosen lanes need and the register lacks, `inspection.ownerApps`) | `--reuse-apps`, `--no-reuse-apps` | yes |
| Declare the kanon plugin in `.claude/settings.json`? | `--plugin`, `--no-plugin` | yes |
| Send this repository's agent-run rows to Kanon's hosted telemetry store? | `--telemetry`, `--no-telemetry` | no |
| Create the Apps now? | `--create-apps`, `--no-apps` | yes |

**What fails, by name, before anything changes:** a flag `init` doesn't know, `--owner` among them, with a hint naming `--project-owner`; a value flag given twice, or followed by another flag where its value belongs (`--project-owner --yes`, as an unset, unquoted variable leaves it: a value that begins with `-` is given as `--project-owner=<value>`); a value `init` doesn't take (`--test-database` other than `none` or `hook`, a lane Kanon doesn't ship); two flags that contradict each other (`--delegation` and `--no-delegation`, `--delegate-name` or `--delegate-email` with `--no-delegation`, `--delete-default-labels` and `--keep-default-labels`, `--releaser` and `--no-releaser`, `--reuse-apps` and `--no-reuse-apps`, `--plugin` and `--no-plugin`, `--telemetry` and `--no-telemetry`, `--create-apps` and `--no-apps`, and `--help` and `--json`, since the usage text is no document); and `--releaser` for a repository that doesn't call Kanon's release workflow. Each exits 2.

**Why `--project-owner`, not `--owner`** (the Owner, 2026-10-06): `--owner` names the GitHub account that owns the repository, in `kanon apps` and everywhere else, so the person who is the project's Owner gets a flag of their own, and `answers.projectOwner` in the JSON.

### Telemetry

**Telemetry is off unless you say yes** (#428). With `--telemetry`, or a yes to its question, `init` writes the caller of Kanon's telemetry collector, `.github/workflows/telemetry.yml`, exactly as [`docs/telemetry.md`](telemetry.md#collect-the-rows) gives it and pinned to this release. Hourly, it sends each agent run's row: plan 0002's fixed fields about the run (its lane, outcome, model, cost, tokens, durations and counts, the run, pull request and issue numbers, and the Kanon release), and never code, text, logins or file paths. The rows go to one table in Kanon's AWS account in Frankfurt, under an opaque key, and are kept 13 months. Kanon's operator reads them, and publishes only aggregates that at least three adopters contribute to; your repository's own reader role reads only its rows. To stop, delete the caller; to have what was sent erased, ask the operator ([Erase an adopter](telemetry.md#erase-an-adopter)).

The store's side is the operator's: the register entry, and the values of the repository variables `KANON_TELEMETRY_URL` and `KANON_TELEMETRY_WRITER_ROLE`. Until both are set the collector skips with a warning and stays green, and `init` reports the step left, `telemetry.register` (as `kanon doctor` does afterwards, `telemetry.unconfigured`): ask for registration with [the telemetry registration issue](https://github.com/yedeya-labs/kanon/issues/new?template=telemetry-registration.yml), then set the two variables the operator gives you.

### Where a lane's caller goes

A lane's caller goes at the lane's file name, `.github/workflows/<lane>.yml` (`K-LAYOUT-18`). In a repository that hosts Kanon's lanes, that path holds the lane itself, so its caller lives at another path, and the adoption record waives doctor's `caller.misplaced` finding on it ([`docs/doctor.md`](doctor.md#waiving-a-finding)). **`init` honours that waiver as the caller's path** ([#451](https://github.com/yedeya-labs/kanon/issues/451)): when the file at the lane's file name doesn't call the lane, and a `caller.misplaced` waiver under `## Choices` names a file that does, `init` compares the caller there instead, so a run offers the lane's caller at the path the record declares and counts the lane as installed. A file at the lane's file name that calls the lane stays its caller. A waiver of a file that doesn't exist yet, or calls another lane, names no lane, so the first time, take the caller's text from `files[].content` of its lane's file name (every caller's full text is there, whatever its status), write it at the path you choose, and add the waiver. No repository is special-cased.

`kanon apps` opens a browser for each App it creates, and waits for you to click Create and Install there. A program that wants to run that step on its own, for instance to explain it first, passes `--no-apps`: the command it would have run is then the finding `app.create`.

## The JSON output

`--json` prints one JSON document on standard output, and nothing else there; the prose a person reads goes to standard error, and `kanon apps` and `kanon milestones`, when `init` runs them, print theirs there too. It asks nothing, as `--yes`, and the run and its exit code are the ones the same flags give without `--json`.

**Its shape is a contract** ([ADR 0014](decisions/0014-adopter-audiences.md), decision 2): the agent skills that wrap `kanon init` and `kanon doctor`, and any integrator, build on it. It follows the convention every `kanon` command's JSON shares ([`docs/cli-json.md`](cli-json.md): the opening fields, the error document, the finding's shape), and is versioned by its `schema` field, `kanon-init/v1`:

- **Within a version,** fields, statuses and finding ids may be added, and a consumer ignores what it doesn't know. Nothing is removed, renamed, retyped or given another meaning.
- **Anything else is a new version,** `kanon-init/v2`, shipped in a breaking release and named in its release notes.

`tests/unit/kanon-init.test.ts` holds the document's fields, the statuses, the finding ids and the flags to the tables on this page.

### Decided by the Owner (2026-10-06)

- **`--json` runs the same run as without it,** `kanon apps` included: it opens a browser and waits for the person. A program that wants that step on its own passes `--no-apps`.
- **A standard input that isn't a terminal still needs `--yes` (or `--json`),** even when flags answer every question: which questions are asked depends on the repository.
- **Under `--json` the prose goes to standard error,** rather than nowhere, so a person watching the run still reads it.
- **The person's flag is `--project-owner`,** and `--owner` keeps meaning the GitHub account.

### The document

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `kanon-init/v1` |
| `kanon` | string | The release of the `init` that ran, `vX.Y.Z`: every reference it writes is pinned to it. |
| `status` | string | `complete`, `steps-left`, `failed` or `error`, below. |
| `exitCode` | number | The exit code: 0, 1 or 2. |
| `repository` | string | `<owner>/<repo>`. |
| `token` | object | `source` (`GH_TOKEN`, `GITHUB_TOKEN` or `gh`) and `login` (string or null): whose token `gh` used. Never the token. |
| `dryRun` | boolean | Whether it ran with `--dry-run`: then `files` and `changes` say what it *would* do, and nothing changed. |
| `inspection` | object | What it read, below. |
| `answers` | object | The answer to each question, from its flag, its default or the person, below. |
| `catalogue` | array | The lane catalogue, a group at a time, in the order the adopt skill asks them: what each lane does, needs and costs, and whether it is recommended for this repository, below. |
| `files` | array | Each file `init` writes, in the order it considers them, below. |
| `changes` | array | What it changed on the checkout and on GitHub, or in a dry run would, in the order the summary lists them, below. |
| `apps` | object | The `kanon apps` step, below. |
| `findings` | array | What is left to a person, in the order the summary numbers it: the finding shape of [`docs/cli-json.md`](cli-json.md). |
| `notes` | array | Strings: facts that block nothing, such as a merge queue the plan lacks or that the platform does not enforce review. |
| `failures` | array | Strings: what failed, when `status` is `failed`. |

| Status | Exit code | Meaning |
|---|---|---|
| `complete` | 0 | It ran, and nothing is left to a person. |
| `steps-left` | 0 | It ran, and `findings` lists what is left to a person. |
| `failed` | 1 | Something failed after it started changing things, or it stopped on an error it didn't expect (a file it couldn't write) once it had inspected the repository; `failures` says what. What it did before is still listed. |
| `error` | 1 or 2 | It stopped before inspecting the repository, on a usage error, an unreadable requirements file or an error it didn't expect, so nothing changed: the error document of [`docs/cli-json.md`](cli-json.md), `{ "schema", "kanon", "status", "exitCode", "error" }`. 2 is a usage error. |

### The inspection

| Field | Type | Meaning |
|---|---|---|
| `owner` | string | The account that owns the repository. |
| `ownerKind` | string | `user` or `organization`. |
| `private` | boolean | Whether the repository is private. |
| `defaultBranch` | string | Its default branch. |
| `hasCommits` | boolean | Whether the default branch has a commit. |
| `admin` | boolean | Whether the token can administer the repository. |
| `rulesets` | string | `yes`, `no` or `unknown`: whether the plan has rulesets. `no` means the platform can't enforce review (`K-ADOPT-3`). |
| `mergeQueue` | string | `yes`, `no` or `unknown`: whether the plan has the merge queue. |
| `defaultBranchMergeQueue` | boolean | Whether the default branch merges through a merge queue ([#452](https://github.com/yedeya-labs/kanon/issues/452)): an active ruleset on it has one, or, where none covers it yet, the ruleset `init` creates has one, because the plan has the queue. A lane's `mergeQueue`, in the catalogue, says what that changes for it. |
| `defaultBranchRulesets` | array | The names of the active rulesets on the default branch. |
| `inactiveRulesets` | array | Each `disabled` or `evaluate` ruleset on the default branch: `name` and `enforcement`. |
| `labels` | array | The repository's label names, sorted. |
| `milestones` | array | Its milestone titles, sorted. |
| `secrets` | array or null | Its secret names, sorted, or null when the token can't list them. |
| `installedLanes` | array | The lanes its callers already call, by file name without `.yml`. |
| `callsRelease` | boolean | Whether it calls Kanon's release workflow, which is what offers the Releaser. |
| `ownerApps` | array or null | Kanon's Apps the owner already has ([#363](https://github.com/yedeya-labs/kanon/issues/363)): each of its App installations whose permissions are exactly an App's in `rulebook/agent-permissions.json`, and whose App this register doesn't name, as `app` (`author`, `judge` or `releaser`) and `slug`. Looked for only when the register lacks one of the Apps, so empty otherwise. Null when the token can't list the installations: only an organisation's owner can, with its Administration permission (read), and on a personal account gh's token can't; `notes` then says so, and `init` creates the Apps as before. |

### The answers

| Field | Type | Meaning |
|---|---|---|
| `projectOwner` | string | The project's Owner (`K-ADOPT-1` step 2). |
| `maintainer` | string | The Maintainer. |
| `stakeholder` | string | The Stakeholder. |
| `lanes` | array | The lanes to install, by file name without `.yml`. |
| `gates` | array | The stack's gates, in order; empty for none yet. |
| `testDatabase` | string | `none` or `hook`. |
| `delegation` | object or null | The sign-off delegation, `name` and `email`, or null. |
| `deleteDefaultLabels` | boolean | Whether to delete GitHub's default labels outside the taxonomy. |
| `releaser` | boolean | Whether to create the optional Releaser. |
| `reuseApps` | boolean or null | Whether to reuse the Apps in `inspection.ownerApps` that the chosen lanes need, with `kanon apps --reuse`, rather than create a second set; null when there was none to ask about. |
| `plugin` | boolean | Whether to declare the kanon plugin in `.claude/settings.json`, pinned to this release. |
| `telemetry` | boolean | Whether to send the repository's agent-run rows to Kanon's hosted telemetry store, by writing the collector's caller, `.github/workflows/telemetry.yml` ([below](#telemetry)). |

### The lane catalogue

What `--lanes` chooses from, so a person, or the adopt skill asking them, can choose knowing what each lane does ([#428](https://github.com/yedeya-labs/kanon/issues/428)). It is [`docs/lanes.json`](lanes.json), the one source `kanon init --help` and [`docs/lanes.md`](lanes.md#the-lane-catalogue) also read, with what the release's requirements file derives from each lane beside it. Each element is a group:

| Field | Type | Meaning |
|---|---|---|
| `group` | string | The group's id, such as `review`. |
| `title` | string | Its name, such as `Implement and revise`. |
| `header` | string | A short name for it, at most 12 characters. |
| `lanes` | array | Its lanes, at most four, below. |

### A catalogue lane

| Field | Type | Meaning |
|---|---|---|
| `lane` | string | The lane, by file name without `.yml`, as `--lanes` and `answers.lanes` name it. |
| `name` | string | Its name in docs/lanes.md. |
| `does` | string | What it does, in one sentence. |
| `app` | string or null | The App it runs as, `author` or `judge`, or null for none. |
| `secrets` | array | The secrets its caller maps. |
| `qaStore` | boolean | Whether it reaches the QA store, through a hook you write, and runs without memory when there is none. |
| `hooks` | array | The hooks it calls besides the project-setup hook, by path. |
| `reads` | array | The project documents it reads (`K-LAYOUT-17`). |
| `schedule` | string or null | The cron its caller is written with, or null when it runs on events alone. |
| `needs` | array | Strings: what else it needs, such as project briefs. |
| `cost` | string | What it costs to run, in one sentence: whether it runs a model, and how often. |
| `when` | string | When it is recommended, in one sentence. |
| `mergeQueue` | string or null | What a merge queue on the default branch changes for it, in one sentence, or null when nothing ([#452](https://github.com/yedeya-labs/kanon/issues/452)): a merge through the queue doesn't start a lane that runs on CI finishing on the default branch. |
| `recommendedWith` | array | The lanes whose choice makes it recommended; empty for none. |
| `recommended` | boolean | Whether it is recommended for this repository: the repository calls it already, it is the review lane, or it is recommended with a lane that is. |
| `installed` | boolean | Whether the repository calls it already (`inspection.installedLanes`). |

### A file

| Field | Type | Meaning |
|---|---|---|
| `path` | string | From the checkout's root. |
| `status` | string | `new` (written, or in a dry run would be), `same` (already as `init` writes it), `kept` (a declaration or hook that is the project's, left alone) or `differs` (a workflow that differs from what `init` would write, left alone). |
| `content` | string or null | What `init` writes, or would write, whatever the file's status ([#451](https://github.com/yedeya-labs/kanon/issues/451)): for a `differs` file it is the full text the diff compares with, so a program can write it at another path. Null only for a `kept` file, whose content is the project's to say. |
| `diff` | array | Strings: for a file that `differs`, the lines that differ, `- ` for the file's and `+ ` for what `init` would write. |

### A change

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | `file`, `label`, `label-deleted`, `milestone`, `merge-settings`, `ruleset` or `apps`. |
| `subject` | string | What changed: a path, a label, a milestone, the repository, the default branch, or the Apps. |
| `message` | string | The summary's line for it. |

### The Apps

| Field | Type | Meaning |
|---|---|---|
| `identities` | array | The Apps the chosen lanes run as, and the Releaser if asked for. |
| `missing` | array | Those the App register lacks. |
| `reuse` | array | Those of the missing ones the owner already has and the person chose to reuse, each `app` and `slug`: each is a finding `app.reuse`, its `kanon apps --reuse` command with the slug filled in. |
| `command` | string or null | The `kanon apps` command for the missing ones it creates. |
| `outcome` | string | `none` (the lanes run as no App), `registered` (the register lists them all), `reuse` (the owner has every missing one, and the person chose to reuse them: the findings `app.reuse`), `would-run` (a dry run), `ran`, `left-to-you` (`--no-apps`, or the person said no: the finding `app.create`) or `failed`. With some reused and some created, it is the outcome of creating them. |
| `exitCode` | number or null | `kanon apps`'s exit code, when `init` ran it. |

### The findings

Every finding is non-blocking, except `app.failed`: `blocking` means it makes the exit code 1, as in `kanon doctor`. A step that is left to a person still matters, which is what `steps-left` says.

| Id | Category | When |
|---|---|---|
| `dependabot.kanon-entry` | `dependabot` | `.github/dependabot.yml` exists without the entry that proposes Kanon upgrades. |
| `label.create` | `label` | The token could not create some of the taxonomy's labels. |
| `label.delete-default` | `label` | The token could not delete a default label it was asked to. |
| `milestone.buckets` | `milestone` | `kanon milestones` did not create the bucket milestones. |
| `merge.settings` | `merge` | The token could not set squash-only merging. |
| `ruleset.gaps` | `ruleset` | The default branch's ruleset lacks some of `K-ADOPT-1` step 8. |
| `ruleset.first-commit` | `ruleset` | The default branch has no commit yet, so no ruleset was created. |
| `ruleset.create` | `ruleset` | The token could not create the default branch's ruleset. |
| `ruleset.require-check` | `ruleset` | No job of a workflow on the default branch reports the status check `Lane check` on every pull request yet (and, where the default branch merges through a merge queue, on its `merge_group` run too, [#459](https://github.com/yedeya-labs/kanon/issues/459)), or the token can't read the default branch's workflows, so the ruleset doesn't require it: a required check that nothing reports blocks every other pull request ([#444](https://github.com/yedeya-labs/kanon/issues/444)). Its subject is the check's name. It is a step for after the merge of the pull request that adds the job, never before: run `kanon init` again with a token that can administer the repository, which adds only that rule, or add it on the fix's page. |
| `app.create` | `app` | The Apps the lanes need were not created: `--no-apps`, or the person said no. |
| `app.failed` | `app` | `kanon apps` did not finish. |
| `app.reuse` | `app` | The register lists an App, but the repository lacks its secrets; or the owner already has an App the register lacks, and the person chose to reuse it. |
| `secret.claude-code-oauth-token` | `secret` | The repository lacks `CLAUDE_CODE_OAUTH_TOKEN`. |
| `secret.digest-webhook` | `secret` | The repository lacks `DIGEST_WEBHOOK`. |
| `secret.unreadable` | `secret` | The token can't list the repository's secret names. |
| `telemetry.register` | `telemetry` | The repository calls Kanon's telemetry collector, and `KANON_TELEMETRY_URL` and `KANON_TELEMETRY_WRITER_ROLE` aren't both set, or the token can't list its variables: the register entry and the two values are the Kanon operator's to give, and the fix says how to ask. |
| `plugin.declare` | `plugin` | `.claude/settings.json` exists, and doesn't declare the kanon plugin at this release: the file is the project's, so `init` leaves it alone, and the fix lists the keys to merge into it. |
