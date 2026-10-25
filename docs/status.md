# `kanon status`

`kanon status` says where a repository that runs Kanon stands, read live from GitHub when you ask. It writes nothing, anywhere: no file, no comment, no label, no cache. Every answer comes from Kanon's status core (`scripts/status/`), which judges each thing with the deciders the lanes themselves run, the Lead's reconciler for a project's phase among them. So `kanon status` can't disagree with what the next lane run will do. The core's clauses are the `STAT` area of the spec layer ([`docs/qa/specs/status.md`](qa/specs/status.md)).

```sh
kanon status --project 1327
kanon status --project 1327 --json
kanon status --repo owner/name --project 12
kanon status --release --json
```

| Option | Meaning |
|---|---|
| `--project <n>` | The project view of tracking issue `<n>`. |
| `--release` | The release view: what is about to ship, what shipped, where it is deployed, and the promotion's gates. |
| `--pr <n>` | The pull-request readiness view. It isn't in this release yet: the command says so and exits 2. |
| `--repo <owner>/<repo>` | The repository. The default is the origin remote of the checkout you run it from. |
| `--json` | Print one JSON document instead of prose ([below](#the-json-output)). |

Each view you ask for is one section of the answer, and you may ask for more than one at once. The project and release views are the ones there are so far. The pull-request readiness, lane-health and needs-the-Owner views each add their own section as they are built.

## What it reads

It reads with your own `gh` credential, as [`kanon doctor`](doctor.md) does. `gh` takes its token from `GH_TOKEN`, then `GITHUB_TOKEN`, then its stored login. The command says on standard error which one it used and whose it is, and stops when GitHub refuses it. It reads only what that token can read, and asks GitHub only REST `GET`s and GraphQL queries.

It reads every declaration from the repository's default branch on GitHub: the brief, the spec layer, the App register, the adoption record, the stack document and, for the release view, the workflow files. It never reads them from your checkout, so a local branch doesn't change the answer. Your checkout is used only to find the repository when you don't pass `--repo`.

**An incomplete read is no answer.** A read that GitHub refused, that wasn't found, that hit the rate limit or that came back cut short makes that view's answer an error. The error names each read and why it failed, with the time the rate limit resets when that is the cause. A view never answers in part.

## The project view

For a tracking issue, `--project` reads its brief, `docs/projects/<n>.md`, on the default branch, and gives:

- **the phase** the Lead's reconciler is in for the project, as its own phase function returns it, and **the gating work**, the open issues the project's closure waits on;
- **each item** of the brief's decomposition, with:
  - the issue filed for it, found by its project marker;
  - the issue's open and merged pull requests;
  - the items it depends on;
  - each acceptance criterion it cites, with the clause's status in the spec layer and the test files that cite it in a test's title;
- **why an item can't proceed**: a dependency still open or not filed, `qa:needs-info`, `qa:needs-split`, `blocked`, `qa:human-action`, or a hold on the project (`needs:human`), which is the Lead's when the Lead's hold comment is there beside it.

A tracking issue with no brief, or a brief whose decomposition doesn't parse, is reported as that. It is never reported as a project with no items.

## The release view

`--release` gives, for the repository:

- **the open release pull request**, as Kanon's metrics recognise one: by release-please's `autorelease:` labels, or by the App register's Releaser as its author, never by the repository's name. A person's pull request with a release's title isn't one;
- **the latest release**, GitHub's `latest`, and **the latest pre-release**, the newest published one, with how many hours ago it was published;
- **each environment** the adoption record's `## Deploy` declares, with **its last deploy**: the release, its outcome and the run. That is the `Environments` list, or, where the record declares only a reference deploy, the reference environment. The deploy is found as the Lead's reconciler finds a release's deploy: among the reference deploy workflow's latest 200 runs, the run titled with the release's tag or with its commit, and in that run the environment's deploy job, by its exact name. The view reads the 30 newest releases, as the reconciler does, newest first, and an environment's last deploy is the newest one whose job ran there. Its outcome is `deployed` when the job succeeded, `failed` when it concluded otherwise, and `deploying` while it hasn't finished, waiting for an approval included. A job that was skipped deployed nothing there, so the view reads on, as it does past a release whose tag isn't in the repository, such as a draft's. The record names the reference environment's job. Every other environment has the job the deploy caller `kanon init` writes gives it, the reference job with that environment's name in its place, such as `production / deploy` beside `staging / deploy`. Where the reference job isn't named that way, the other environments have no job the view can read, and it says so;
- **the promotion's gates**, where the default branch runs Kanon's promotion workflow, a workflow that runs `scripts/promote.mjs check`: the decision that check would take now, why, the candidate, and each gate's verdict and evidence. They come from the promotion's own read-only check, run over the same reads: the check of the Kanon release you run, while the workflow runs the default branch's `scripts/promote.mjs`. So they match what its next run reports whenever that release's `promote.mjs` is the default branch's; a gate the default branch has added or changed since that release reads differently until you run the release that has it. A state the promotion refuses to act on is reported as `refused`, with the check's reason. On the repository of any other project, there is no promotion to report.

## Exit codes

| Code | Status | Meaning |
|---|---|---|
| 0 | `ok` | Every view asked for was answered. |
| 2 | `error` | A usage error: an unknown or malformed flag, no view named (`--project <n>` or `--release`), or `--pr`, whose view isn't in this release yet. |
| 3 | `error` | It couldn't run: no repository to read, or a token GitHub refuses. |
| 4 | `incomplete` | A view's reads didn't complete, so that view has no answer. |

The prose and `--json` exit with the same code for the same result.

## The JSON output

`--json` prints one document, following [the convention every `kanon` command's JSON shares](cli-json.md), versioned by its `schema` field, `kanon-status/v1`. Within `v1`, each view that is built adds its section, and a consumer ignores what it doesn't know.

### The fields

A path names a field inside its parent: `project.items[].key` is the `key` of each entry of `project.items`. A test holds this table to the fields the command emits, both ways (`[STAT-12]`).

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `kanon-status/v1`. |
| `kanon` | string | The release of the command that ran, `vX.Y.Z`. |
| `status` | string | `ok`, `incomplete` or `error` ([exit codes](#exit-codes)). |
| `exitCode` | number | The exit code the process exits with. |
| `error` | string | In the error document only: why the command couldn't run. |
| `repo` | string | `owner/name`. |
| `readAt` | string | When the reads began, ISO 8601. |
| `project` | object | The project view, when `--project` asked for it: the fields below, or, when its reads didn't complete, only `error` and `reads`. |
| `project.error` | string | Why the view has no answer, naming each read that failed. |
| `project.reads` | array | Each read that failed. |
| `project.reads[].read` | string | What was read, such as `GET repos/o/r/contents/docs/projects/7.md?ref=main` or `GraphQL Labels`. |
| `project.reads[].why` | string | Why it failed, as GitHub or `gh` said it. |
| `project.reads[].status` | number or null | The HTTP status, when there is one. |
| `project.reads[].resetAt` | string or null | When the exhausted rate limit resets, ISO 8601, when that is the cause. |
| `project.project` | number | The tracking issue. |
| `project.branch` | string | The default branch the declarations were read from. |
| `project.brief` | object | The brief. |
| `project.brief.path` | string | `docs/projects/<n>.md`. |
| `project.brief.state` | string | `parsed`, `missing` or `unparseable`. |
| `project.brief.residue` | array | Only when `unparseable`: the brief's lines the decomposition parser couldn't read. |
| `project.phase` | string | The reconciler's phase for the project, such as `file`, `awaiting-brief` or `brief-unparseable`. |
| `project.gating` | array | The numbers of the open issues the project's closure waits on. |
| `project.hold` | object or null | The hold on the tracking issue, or null when it carries none. |
| `project.hold.label` | string | `needs:human`. |
| `project.hold.by` | string | `lead` when the Lead's hold comment is beside the label, `person` otherwise. |
| `project.environment` | string or null | The reference environment the adoption record's `## Deploy` declares, or null. |
| `project.items` | array or null | Each item of the brief's decomposition, in the brief's order; null when the brief is missing or doesn't parse. |
| `project.items[].key` | string | The item's key in the brief, `A` for `Issue A`. |
| `project.items[].title` | string | The item's title in the brief. |
| `project.items[].issue` | object or null | The issue filed for it, found by the project marker, or null when none is filed. |
| `project.items[].issue.number` | number | Its number. |
| `project.items[].issue.state` | string | `OPEN` or `CLOSED`. |
| `project.items[].issue.labels` | array | Its labels' names. |
| `project.items[].prs` | object | The issue's pull requests. |
| `project.items[].prs.open` | array | The numbers of those open. |
| `project.items[].prs.merged` | array | The numbers of those merged. |
| `project.items[].dependsOn` | array | The items it depends on, from its `**Depends on:**` line. |
| `project.items[].dependsOn[].key` | string | The item's key. |
| `project.items[].dependsOn[].issue` | number or null | Its filed issue, or null when none is filed. |
| `project.items[].dependsOn[].state` | string or null | That issue's state, or null. |
| `project.items[].acs` | array | The acceptance-criterion ids the item cites. |
| `project.items[].acs[].id` | string | The id, such as `STAT-11`. |
| `project.items[].acs[].declared` | boolean | True when the item declares it as a criterion, false when it only mentions it. |
| `project.items[].acs[].clause` | string or null | The clause's status in the spec layer, such as `seed` or `confirmed`, or null when the spec layer has no such id. |
| `project.items[].acs[].tested` | boolean | True when a test cites it in its title. |
| `project.items[].acs[].tests` | array | The test files that cite it, from the stack document's test trees. |
| `project.items[].stops` | array | Why the item can't proceed; empty when it can. |
| `project.items[].stops[].reason` | string | `dependency`, `qa:needs-info`, `qa:needs-split`, `blocked`, `qa:human-action`, `lead-hold` or `held`. |
| `project.items[].stops[].detail` | string | A sentence naming the issue, the label or the dependency. |
| `project.notes` | array | What the reconciler warned of while it read, as sentences. |
| `release` | object | The release view, when `--release` asked for it: the fields below, or, when its reads didn't complete, only `error` and `reads`. |
| `release.error` | string | Why the view has no answer, naming each read that failed. |
| `release.reads` | array | Each read that failed, with the same fields as `project.reads`. |
| `release.reads[].read` | string | What was read. |
| `release.reads[].why` | string | Why it failed, as GitHub or `gh` said it. |
| `release.reads[].status` | number or null | The HTTP status, when there is one. |
| `release.reads[].resetAt` | string or null | When the exhausted rate limit resets, ISO 8601, when that is the cause. |
| `release.branch` | string | The default branch the declarations were read from. |
| `release.releasePrs` | array | The open release pull requests; empty when there is none. |
| `release.releasePrs[].number` | number | Its number. |
| `release.releasePrs[].title` | string | Its title. |
| `release.releasePrs[].url` | string | Its page. |
| `release.releasePrs[].createdAt` | string | When it was opened, ISO 8601. |
| `release.latest` | object or null | The latest release, or null when there is none. |
| `release.latest.tag` | string | Its tag. |
| `release.latest.name` | string | Its name. |
| `release.latest.url` | string | Its page. |
| `release.latest.publishedAt` | string | When it was published, ISO 8601. |
| `release.preRelease` | object or null | The latest published pre-release, or null when there is none. |
| `release.preRelease.tag` | string | Its tag. |
| `release.preRelease.name` | string | Its name. |
| `release.preRelease.url` | string | Its page. |
| `release.preRelease.publishedAt` | string | When it was published, ISO 8601. |
| `release.preRelease.ageHours` | number | Whole hours from its publication to `readAt`. |
| `release.deploys` | array | Each environment the adoption record's `## Deploy` declares, in its order; empty when it declares none. |
| `release.deploys[].environment` | string | The environment's name. |
| `release.deploys[].workflow` | string | The reference deploy workflow, whose runs were read. |
| `release.deploys[].job` | string or null | The environment's deploy job, as a run lists it, or null when the record names none for it. |
| `release.deploys[].last` | object or null | Its last deploy among the 30 newest releases, or null when none of them deployed there. |
| `release.deploys[].last.tag` | string | The release deployed. |
| `release.deploys[].last.outcome` | string | `deployed`, `failed` or `deploying`. |
| `release.deploys[].last.url` | string | The deploy run. |
| `release.promotion` | object or null | The promotion's check, or null where the default branch runs no promotion workflow. |
| `release.promotion.workflow` | string | The workflow that runs the check, such as `promote.yml`. |
| `release.promotion.decision` | string | `promote`, `hold`, `none` or `refused`. |
| `release.promotion.why` | string | Why, as the check says it. |
| `release.promotion.candidate` | string or null | The candidate tag it read, or null when there is none. |
| `release.promotion.gates` | array | Each gate the check read, in its order; empty when it read none. |
| `release.promotion.gates[].id` | string | The gate's id, such as `soak` or `e2e`. |
| `release.promotion.gates[].title` | string | The gate's title. |
| `release.promotion.gates[].skipped` | boolean | True when the check skipped it. |
| `release.promotion.gates[].pass` | boolean | True when it passes. |
| `release.promotion.gates[].evidence` | string | The evidence the check gives for its verdict. |

On a usage error or when it can't run, the document is the error document, `{ "schema", "kanon", "status": "error", "exitCode", "error" }`.

## The hosted server's tools

The same views will be served read-only by a hosted MCP server, whose tools are listed here once it is built. A test holds this list to the server's own (`[STAT-12]`). There are none yet.

| Tool | View |
|---|---|
