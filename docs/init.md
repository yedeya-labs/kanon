# `kanon init`

`kanon init` installs Kanon in the repository whose checkout you run it from ([plan 0005](plans/0005-lean-installation.md) §5.4). It inspects the repository and its owner, asks what it can't infer, writes the declarations and the lane callers pinned to the release it runs from, creates the labels, the bucket milestones and, where the plan has rulesets, the default branch's ruleset, and runs [`kanon apps`](apps.md) for the Apps the lanes run as. It commits nothing, prints as exact steps whatever its token or plan can't do, and changes nothing on a second run. `kanon init --help` lists every option.

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
| Create the Apps now? | `--create-apps`, `--no-apps` | yes |

**What fails, by name, before anything changes:** a flag `init` doesn't know, `--owner` among them, with a hint naming `--project-owner`; a value flag given twice; a value `init` doesn't take (`--test-database` other than `none` or `hook`, a lane Kanon doesn't ship); two flags that contradict each other (`--delegation` and `--no-delegation`, `--delegate-name` or `--delegate-email` with `--no-delegation`, `--delete-default-labels` and `--keep-default-labels`, `--releaser` and `--no-releaser`, `--create-apps` and `--no-apps`); and `--releaser` for a repository that doesn't call Kanon's release workflow. Each exits 2.

**Why `--project-owner`, not `--owner`** (the Owner, 2026-10-06): `--owner` names the GitHub account that owns the repository, in `kanon apps` and everywhere else, so the person who is the project's Owner gets a flag of their own, and `answers.projectOwner` in the JSON.

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
| `failed` | 1 | Something failed after it started changing things; `failures` says what. What it did is still listed. |
| `error` | 1 or 2 | It stopped before inspecting the repository, so nothing changed: the error document of [`docs/cli-json.md`](cli-json.md), `{ "schema", "kanon", "status", "exitCode", "error" }`. 2 is a usage error. |

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
| `mergeQueue` | string | `yes`, `no` or `unknown`. |
| `defaultBranchRulesets` | array | The names of the active rulesets on the default branch. |
| `inactiveRulesets` | array | Each `disabled` or `evaluate` ruleset on the default branch: `name` and `enforcement`. |
| `labels` | array | The repository's label names, sorted. |
| `milestones` | array | Its milestone titles, sorted. |
| `secrets` | array or null | Its secret names, sorted, or null when the token can't list them. |
| `installedLanes` | array | The lanes its callers already call, by file name without `.yml`. |
| `callsRelease` | boolean | Whether it calls Kanon's release workflow, which is what offers the Releaser. |

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

### A file

| Field | Type | Meaning |
|---|---|---|
| `path` | string | From the checkout's root. |
| `status` | string | `new` (written, or in a dry run would be), `same` (already as `init` writes it), `kept` (a declaration or hook that is the project's, left alone) or `differs` (a workflow that differs from what `init` would write, left alone). |
| `content` | string or null | What `init` writes, for a `new` file. |
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
| `command` | string or null | The `kanon apps` command for the missing ones. |
| `outcome` | string | `none` (the lanes run as no App), `registered` (the register lists them all), `would-run` (a dry run), `ran`, `left-to-you` (`--no-apps`, or the person said no: the finding `app.create`) or `failed`. |
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
| `app.create` | `app` | The Apps the lanes need were not created: `--no-apps`, or the person said no. |
| `app.failed` | `app` | `kanon apps` did not finish. |
| `app.reuse` | `app` | The register lists an App, but the repository lacks its secrets. |
| `secret.claude-code-oauth-token` | `secret` | The repository lacks `CLAUDE_CODE_OAUTH_TOKEN`. |
| `secret.digest-webhook` | `secret` | The repository lacks `DIGEST_WEBHOOK`. |
| `secret.unreadable` | `secret` | The token can't list the repository's secret names. |
