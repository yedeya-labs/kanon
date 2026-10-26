# `kanon status`

`kanon status` says where a repository that runs Kanon stands, read live from GitHub when you ask. It writes nothing, anywhere: no file, no comment, no label, no cache. Every answer comes from Kanon's status core (`scripts/status/`), which judges each thing with the deciders the lanes themselves run, the Lead's reconciler for a project's phase among them. So `kanon status` can't disagree with what the next lane run will do. The core's clauses are the `STAT` area of the spec layer ([`docs/qa/specs/status.md`](qa/specs/status.md)).

```sh
kanon status --project 1327
kanon status --project 1327 --json
kanon status --repo owner/name --project 12
kanon status --release --json
kanon status --pr 1391
kanon status --repo owner/name --project 12 --pr 40
kanon status --lanes
kanon status --repo owner/name --project 12 --lanes --json
kanon status --needs-owner
```

| Option | Meaning |
|---|---|
| `--project <n>` | The project view of tracking issue `<n>`. |
| `--release` | The release view: what is about to ship, what shipped, where it is deployed, and the promotion's gates. |
| `--lanes` | The lane-health view. |
| `--pr <n>` | The pull-request readiness view of pull request `<n>` ([below](#the-pull-request-readiness-view)). |
| `--needs-owner` | The needs-the-Owner view: what waits on a person ([below](#the-needs-the-owner-view)). |
| `--repo <owner>/<repo>` | The repository. The default is the origin remote of the checkout you run it from. Neither part may be `.` or `..`. |
| `--json` | Print one JSON document instead of prose ([below](#the-json-output)). |

Each view you ask for is one section of the answer, and you can ask for more than one at once. All five are built: the project, release, pull-request readiness, lane-health and needs-the-Owner views.

## What it reads

It reads with your own `gh` credential, as [`kanon doctor`](doctor.md) does. `gh` takes its token from `GH_TOKEN`, then `GITHUB_TOKEN`, then its stored login. The command says on standard error which one it used and whose it is, and stops when GitHub refuses it. It reads only what that token can read, and asks GitHub only REST `GET`s and GraphQL queries.

It reads every declaration from the repository's default branch on GitHub: the brief, the spec layer, the App register, the adoption record, the escalation file, the exemptions file, the stack document and the workflows. It never reads them from your checkout, so a local branch doesn't change the answer. Your checkout is used only to find the repository when you don't pass `--repo`, so every view runs from any directory, whatever App register it holds, if any: a partial one, a malformed one or none. `--pr` and `--needs-owner` run the merge gate's own verdict function, and judge by the Implementer, Reviewer and Merger logins in the default branch's App register, never the register in the directory you run in. That includes whose `needs:human` hold the gate reads as the Merger's. A repository with no register on its default branch, or one with no row for one of those three roles, has no login to judge by, so those two views stop with an error naming what is missing.

**An incomplete read is no answer.** A read that GitHub refused, that wasn't found, that hit the rate limit or that came back cut short makes that view's answer an error. The error names each read and why it failed, with the time the rate limit resets when that is the cause. A view never answers in part.

## The project view

For a tracking issue, `--project` reads its brief, `docs/projects/<n>.md`, on the default branch, and gives:

- **the phase** the Lead's reconciler is in for the project, as its own phase function returns it, and **the gating work**, the open issues the project's closure waits on;
- **each item** of the brief's decomposition, with:
  - the issue filed for it, found by its project marker;
  - the issue's open and merged pull requests;
  - the items it depends on;
  - each acceptance criterion it cites, with the clause's status in the spec layer and the test files that cite it in a test's title;
- **why an item can't proceed**: a dependency still open or not filed, `qa:needs-info`, `qa:needs-split`, `blocked`, `qa:human-action`, or a hold on the project (`needs:human`), which is the Lead's when the Lead's hold comment is there beside it. The hold comment is the Lead's own, as the reconciler counts it: a comment the App register's Lead App wrote with the Lead's role marker, carrying the hold marker. A copy of the marker in anyone else's comment leaves the hold a person's.

A tracking issue with no brief, or a brief whose decomposition doesn't parse, is reported as that. It is never reported as a project with no items.

## The release view

`--release` gives, for the repository:

- **the open release pull request**, as Kanon's metrics recognise one: by release-please's `autorelease:` labels, or by the App register's Releaser as its author, never by the repository's name. A person's pull request with a release's title isn't one;
- **the latest release**, GitHub's `latest`, and **the latest pre-release**, the newest published one, with how many hours ago it was published;
- **each environment** the adoption record's `## Deploy` declares, with **its last deploy**: the release, its outcome and the run. That is the `Environments` list, or, where the record declares only a reference deploy, the reference environment. The deploy is found as the Lead's reconciler finds a release's deploy: among the reference deploy workflow's latest 200 runs, the run titled with the release's tag or with its commit, and in that run the environment's deploy job, by its exact name. The view reads the 30 newest releases, as the reconciler does, newest first, and an environment's last deploy is the newest one whose job ran there. Its outcome is `deployed` when the job succeeded, `failed` when it concluded otherwise, and `deploying` while it hasn't finished, waiting for an approval included. A job that was skipped deployed nothing there, so the view reads on, as it does past a release whose tag isn't in the repository, such as a draft's. The record names the reference environment's job. Every other environment has the job the deploy caller `kanon init` writes gives it, the reference job with that environment's name in its place, such as `production / deploy` beside `staging / deploy`. Where the reference job isn't named that way, the other environments have no job the view can read, and it says so;
- **the promotion's gates**, where the default branch runs Kanon's promotion workflow, a workflow that runs `scripts/promote.mjs check`: the decision that check would take now, why, the candidate, and each gate's verdict and evidence. They come from the promotion's own read-only check, run over the same reads: the check of the Kanon release you run, while the workflow runs the default branch's `scripts/promote.mjs`. So they match what its next run reports whenever that release's `promote.mjs` is the default branch's; a gate the default branch has added or changed since that release reads differently until you run the release that has it. A state the promotion refuses to act on is reported as `refused`, with the check's reason. On the repository of any other project, there is no promotion to report.

## The pull-request readiness view

For a pull request, `--pr` reads it as the Merger would on its next sweep, through the same reads the merge gate makes, and gives:

- **its checks**, partitioned as the merge gate partitions them: the ones that count (the Reviewer's and the Merger's own runs don't), and of those, the ones still running, cancelled with nothing re-run, and failed;
- **the Reviewer's latest verdict**, the commit that verdict read, and whether it is current, which it is only when that commit is the head;
- **the acceptance criteria of the issues it closes**, each with its status in the spec layer;
- **the merge gate's verdict** for it, `merge`, `wait`, `recover`, `escalate`, `release` or `skip`, with the rule that decided it and its reason;
- **for a brief**, each open decision in it, read at its head as the brief guard reads it;
- **whether it is ready to merge, and by whom.**

Whether it is ready is never the view's own judgement:

- **The Implementer's pull request** is the Merger's, except when the merge gate escalates it, for any reason, or answers that it is a draft or not open: then it is a person's. It is ready when the merge gate answers `merge`. It is ready for a person's merge when the gate escalates it for an escalation path alone: the gate, asked again with the declared paths lifted, answers `merge`. Any other answer isn't ready, and the gate's rule is what it lacks.
- **Any other pull request** is a person's to merge, never the Merger's. That is one the gate skips as not provably the Implementer's: a person's, a Lead's brief, a dependency bump, the release pull request. It is ready when three things hold, and the view names each one it lacks:
  - `checks`: the gate's check partition finds at least one check that counts, and none running, cancelled or failed;
  - `approval`: the Reviewer's verdict on its head, as the review-recovery lane reads it, is an approval;
  - `decisions`, for a brief only: the brief guard finds no open decision in it. A brief the default branch's `docs/qa/exemptions.md` lists as pre-standard isn't checked.

  Nothing else is asked of it: a person merging it reads the rest on GitHub.

## The lane-health view

`--lanes` reads the workflows in `.github/workflows/` on the default branch, and lists each lane caller among them: each workflow with a job that calls one of Kanon's lanes, the lane callers [the lane check](../actions/lane-check/README.md) holds to the lane rules. For each it gives:

- **its state** over its recent runs, as the project digest's daily health check (`scripts/workflow-health.mjs`) judges it, with that check's own window and minimum: `red` when every run that ended in success or failure failed, `ok` when one succeeded, and `quiet` when too few runs ended either way to judge. A cancelled or skipped run counts neither way;
- **each failed run**, and each failed attempt of a run that a re-run then fixed, classed:
  - `infra` when the agent classifier recorded on the run that the model was unreachable or that its API failed mid-run, or the review lane recorded that its agent posted no verdict, each by the step the lane runs to say so, as the retry lanes read it; or when a later attempt of the same run succeeded. A run counts as `infra` only when every job of it that failed recorded one of those, so a matrix run with one capped job and one real failure is `real`;
  - `real` otherwise;
- **its health**: `flaky` when it has failures and every one is `infra`, whatever its state, and its state otherwise. A lane red only on `infra` failures is `flaky`, not `red`.

It has no flake classifier of its own: the classes are the agent classifier's and a re-run's outcome.

## The needs-the-Owner view

`--needs-owner` lists what in the repository waits on a person now, each with its link and its reason. It lists five things and nothing else, and each is another view's or another lane's own answer:

- **the pull requests ready for a person's merge**, `merges`: each open pull request the [readiness view](#the-pull-request-readiness-view) reports ready for a person's merge. That is the Implementer's when the merge gate escalates it for an escalation path alone, and any pull request the gate skips as not the Implementer's: a person's, a Lead's brief, a dependency bump, the release pull request. The reason is the readiness view's;
- **the Implementer's stops that wait on a person**, `stops`, each open issue with its reasons:
  - `qa:needs-info` or `qa:needs-split` on it;
  - for an issue carrying `agent:implement` or `qa:needs-triage`, the dispatch sweep's own reading of its conversation, its open pull requests and the lane runs still going: `scope-first-bail` when the Implementer's last word is a scope-first bail that nobody has answered, a bail so fresh that the sweep still reads it as in flight included, and `awaiting-human` when the sweep calls it that: the Implementer has spoken, no person has since, and the last word is two days old. An issue the sweep reads as answered, running or with a pull request isn't listed, nor one it reads as in flight whose last word isn't a scope-first bail;
- **the Lead's holds**, `holds`: each open issue carrying `needs:human` with the Lead's hold marker in the Lead's own comment, as the reconciler counts it. A copy of the marker in anyone else's comment isn't the Lead's;
- **each open decision in an open brief pull request**, `decisions`, read at its head as the brief guard reads it;
- **the red lanes**, `lanes`: each lane caller the [lane-health view](#the-lane-health-view) reports `red`. A `flaky` lane isn't listed.

It reads a comment only to find a bail or the hold marker, and gives the fact and its link, never a comment's or an issue's text. The dispatch sweep also reads the telemetry store's cost rows, which mark an issue whose last run hit its cap or ended with nothing to show. This view has no store to read, so such an issue reads here as its conversation reads.

## Exit codes

| Code | Status | Meaning |
|---|---|---|
| 0 | `ok` | Every view asked for was answered. |
| 2 | `error` | A usage error: an unknown or malformed flag, or no view named. |
| 3 | `error` | It couldn't run: no repository to read, a token GitHub refuses, or, for `--pr` or `--needs-owner`, no App register (`docs/qa/agent-identities.md`) on the default branch, or one with no Implementer, Reviewer or Merger row. |
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
| `project.hold.by` | string | `lead` when the Lead's own hold comment, by its App with its role marker, is beside the label, `person` otherwise. |
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
| `pr` | object | The pull-request readiness view, when `--pr` asked for it: the fields below, or, when its reads didn't complete, only `error` and `reads`. |
| `pr.error` | string | Why the view has no answer, naming each read that failed. |
| `pr.reads` | array | Each read that failed, as `project.reads` gives one. |
| `pr.reads[].read` | string | What was read. |
| `pr.reads[].why` | string | Why it failed. |
| `pr.reads[].status` | number or null | The HTTP status, when there is one. |
| `pr.reads[].resetAt` | string or null | When the exhausted rate limit resets, when that is the cause. |
| `pr.number` | number | The pull request. |
| `pr.title` | string | Its title. |
| `pr.url` | string | Its link. |
| `pr.state` | string | `OPEN`, `CLOSED` or `MERGED`. |
| `pr.draft` | boolean | True when it is a draft. |
| `pr.author` | string | Who opened it, as the merge gate reads the login: an App's as `app/<slug>`. |
| `pr.head` | string | Its head commit. |
| `pr.branch` | string | The default branch the declarations were read from. |
| `pr.checks` | object | Its checks, partitioned as the merge gate partitions them. |
| `pr.checks.relevant` | array | The checks that count, after the gate leaves out its own pipeline's runs. |
| `pr.checks.relevant[].name` | string | The check's name. |
| `pr.checks.relevant[].workflow` | string or null | The workflow it ran in, or null for a commit status or another App's check. |
| `pr.checks.relevant[].status` | string | `COMPLETED`, `IN_PROGRESS`, `QUEUED`, `PENDING` or the like. |
| `pr.checks.relevant[].conclusion` | string or null | `SUCCESS`, `FAILURE`, `CANCELLED` or the like; null until it completes. |
| `pr.checks.pending` | array | The names of the checks still running. |
| `pr.checks.cancelled` | array | The names of those cancelled that nothing re-ran. |
| `pr.checks.failed` | array | The names of those that failed. |
| `pr.review` | object or null | The Reviewer's latest verdict, or null when it has given none. |
| `pr.review.state` | string | `APPROVED` or `CHANGES_REQUESTED`. |
| `pr.review.commit` | string | The commit the verdict read: the one its stamp names, or the one GitHub filed it under when it carries no stamp. |
| `pr.review.current` | boolean | True only when that commit is the head. |
| `pr.closes` | array | The issues in this repository it closes. |
| `pr.closes[].number` | number | The issue. |
| `pr.closes[].acs` | array | The acceptance-criterion ids the issue cites. |
| `pr.closes[].acs[].id` | string | The id, such as `STAT-6`. |
| `pr.closes[].acs[].declared` | boolean | True when the issue declares it as a criterion, false when it only mentions it. |
| `pr.closes[].acs[].clause` | string or null | The clause's status in the spec layer, or null when the spec layer has no such id. |
| `pr.verdict` | object | The merge gate's verdict. |
| `pr.verdict.action` | string | `merge`, `wait`, `recover`, `escalate`, `release` or `skip`. |
| `pr.verdict.rule` | string | The rule that decided it, such as `green-zone`, `checks-pending` or `not-the-implementer`. |
| `pr.verdict.why` | string | The gate's reason, as a sentence. |
| `pr.decisions` | array or null | For a pull request that adds or changes a brief, each open decision in it; null for any other. |
| `pr.decisions[].brief` | string | The brief, `docs/projects/<n>.md`. |
| `pr.decisions[].n` | number | The decision's number. |
| `pr.decisions[].headline` | string | Its headline. |
| `pr.decisions[].marker` | string | The open mark its headline carries, such as `⛔` or `PROPOSED`. |
| `pr.readiness` | object | Whether it is ready to merge, and by whom. |
| `pr.readiness.by` | string | `merger` when it is the Merger's to merge, `person` when it is a person's. |
| `pr.readiness.ready` | boolean | True when it is ready for that merge. |
| `pr.readiness.lacks` | array | What it lacks: for a person's pull request, `checks`, `approval` or `decisions`; for the Implementer's, the merge gate's rule that stops it. Empty when it is ready. |
| `pr.readiness.why` | string | A sentence saying why. |
| `lanes` | object | The lane-health view, when `--lanes` asked for it: the fields below, or, when its reads didn't complete, only `error` and `reads`. |
| `lanes.error` | string | Why the view has no answer, naming each read that failed. |
| `lanes.reads` | array | Each read that failed. |
| `lanes.reads[].read` | string | What was read, such as `GET repos/o/r/actions/runs/1/jobs?per_page=100`. |
| `lanes.reads[].why` | string | Why it failed, as GitHub or `gh` said it. |
| `lanes.reads[].status` | number or null | The HTTP status, when there is one. |
| `lanes.reads[].resetAt` | string or null | When the exhausted rate limit resets, ISO 8601, when that is the cause. |
| `lanes.branch` | string | The default branch the workflows were read from. |
| `lanes.window` | number | How many of each lane's most recent runs were read, the workflow-health check's window. |
| `lanes.minDecisive` | number | How many runs must end in success or failure before a lane can be `red`, the workflow-health check's minimum. |
| `lanes.callers` | array | Each lane caller, by file name. |
| `lanes.callers[].file` | string | Its file name in `.github/workflows/`. |
| `lanes.callers[].status` | string | The workflow-health check's verdict over its recent runs: `ok`, `red` or `quiet`. |
| `lanes.callers[].decisive` | number | The runs that verdict counted, those that ended in success or failure. |
| `lanes.callers[].failed` | number | Of those, the ones that failed. |
| `lanes.callers[].health` | string | `flaky` when it has failures and every one is `infra`; its `status` otherwise. |
| `lanes.callers[].failures` | array | Each failed run, and each failed attempt of a run a later attempt fixed, newest first. |
| `lanes.callers[].failures[].run` | number | The run's id. |
| `lanes.callers[].failures[].attempt` | number | The attempt that failed. |
| `lanes.callers[].failures[].url` | string or null | The run's, or the attempt's, page on GitHub. |
| `lanes.callers[].failures[].createdAt` | string or null | When it started, ISO 8601. |
| `lanes.callers[].failures[].conclusion` | string | `failure`, `timed_out` or `startup_failure`. |
| `lanes.callers[].failures[].class` | string | `infra` or `real`. |
| `lanes.callers[].failures[].reason` | string or null | Why it is `infra`: `unreachable`, `api_error`, `no_verdict` or `rerun-succeeded`; null when it is `real`. |
| `needsOwner` | object | The needs-the-Owner view, when `--needs-owner` asked for it: the fields below, or, when its reads didn't complete, only `error` and `reads`. |
| `needsOwner.error` | string | Why the view has no answer, naming each read that failed. |
| `needsOwner.reads` | array | Each read that failed. |
| `needsOwner.reads[].read` | string | What was read. |
| `needsOwner.reads[].why` | string | Why it failed, as GitHub or `gh` said it. |
| `needsOwner.reads[].status` | number or null | The HTTP status, when there is one. |
| `needsOwner.reads[].resetAt` | string or null | When the exhausted rate limit resets, ISO 8601, when that is the cause. |
| `needsOwner.branch` | string | The default branch the declarations were read from. |
| `needsOwner.merges` | array | The open pull requests ready for a person's merge. |
| `needsOwner.merges[].number` | number | The pull request. |
| `needsOwner.merges[].title` | string | Its title. |
| `needsOwner.merges[].url` | string | Its link. |
| `needsOwner.merges[].rule` | string | The merge gate's rule for it: `escalating-path` for the Implementer's, `not-the-implementer` or `not-implementer-label` for any other. |
| `needsOwner.merges[].reason` | string | Why it is ready, as the readiness view gives it. |
| `needsOwner.stops` | array | The open issues where the Implementer stopped and waits on a person. |
| `needsOwner.stops[].number` | number | The issue. |
| `needsOwner.stops[].title` | string | Its title. |
| `needsOwner.stops[].url` | string | Its link. |
| `needsOwner.stops[].reasons` | array | Why: `qa:needs-info`, `qa:needs-split`, `scope-first-bail` or `awaiting-human`. |
| `needsOwner.holds` | array | The open issues the Lead holds. |
| `needsOwner.holds[].number` | number | The issue. |
| `needsOwner.holds[].title` | string | Its title. |
| `needsOwner.holds[].url` | string | Its link. |
| `needsOwner.decisions` | array | Each open decision in an open brief pull request. |
| `needsOwner.decisions[].number` | number | The pull request. |
| `needsOwner.decisions[].title` | string | Its title. |
| `needsOwner.decisions[].url` | string | Its link. |
| `needsOwner.decisions[].brief` | string | The brief, `docs/projects/<n>.md`. |
| `needsOwner.decisions[].n` | number | The decision's number. |
| `needsOwner.decisions[].headline` | string | Its headline. |
| `needsOwner.decisions[].marker` | string | The open mark its headline carries, such as `⛔` or `PROPOSED`. |
| `needsOwner.lanes` | array | The lane callers the lane-health view reports `red`. |
| `needsOwner.lanes[].file` | string | Its file name in `.github/workflows/`. |
| `needsOwner.lanes[].url` | string | Its runs on GitHub. |
| `needsOwner.lanes[].failed` | number | The failed runs the workflow-health check counted. |
| `needsOwner.lanes[].decisive` | number | The runs it counted, those that ended in success or failure. |

On a usage error or when it can't run, the document is the error document, `{ "schema", "kanon", "status": "error", "exitCode", "error" }`.

## The hosted MCP server

The same five views are served read-only to an MCP client, such as Claude Code, claude.ai or the Claude app on a phone, by a hosted MCP server: one request handler in [`infra/status/function/`](../infra/status/function/), with no MCP SDK. Each tool is one view, and returns the same object as that view's section of the JSON output above, for the same reads: the server builds it with the code `kanon status` uses (`scripts/status/views.mjs`). A view whose reads didn't complete answers with its section's `error` and `reads`, as the tool's error. The server reads GitHub with the person's own token, through a reader over `fetch` that can ask only REST `GET`s and GraphQL queries. A GraphQL document holding a mutation or a subscription is refused before anything is sent, whatever ignored tokens (white space, commas, comments, a byte-order mark) stand before it. It writes nothing, to GitHub or anywhere else, and keeps nothing. The server's clauses are the `MCP` area of the spec layer ([`docs/qa/specs/mcp.md`](qa/specs/mcp.md)).

It speaks MCP's Streamable HTTP transport at protocol version `2025-11-25`, at one endpoint, `/mcp`:

- **A request** is a POST of one JSON-RPC message, answered with one JSON object. The server answers `initialize`, `ping`, `tools/list` and `tools/call`, and any other method with JSON-RPC's method-not-found error. `initialize` answers with `2025-11-25`, whatever version the client asked for.
- **A notification**, a message with no `id` such as `notifications/initialized`, gets HTTP 202 and no body, whatever its method. So does a client's JSON-RPC response.
- **The `MCP-Protocol-Version` header**, when a request carries one, must be `2025-11-25`. Any other version gets 400.
- **Refused by the transport:**
  - a body that isn't one JSON-RPC 2.0 message, such as a batch, gets 400;
  - a GET or DELETE gets 405: the server is stateless, so it opens no stream and holds no session;
  - a request carrying an `Origin` header comes from a browser page, and gets 403.
- **An unknown tool** is a protocol error. **Arguments a tool can't take** are the tool's own error, which says what is wrong.

Every request to `/mcp` needs a token the server issued when the person signed in ([Signing in](#signing-in)). Without one, or with one that has expired, it gets 401, and no tool runs. Its address is a placeholder below until the Owner's first deploy ([Deploy](#deploy)).

The server's code is more than its own directory: it links the status core, and the core calls the deciders the lanes run, the Lead's reconciler, review recovery, workflow health, the brief guard and what they import, rather than copying them. On Kanon's repository every module it links, directly or through another, is the Owner's merge: each matches an `always` entry in [`docs/qa/escalation-paths.md`](qa/escalation-paths.md), and `tests/unit/hosted-function-closure.test.ts` fails on a new import that reaches one that doesn't ([kanon#1345](https://github.com/yedeya-labs/kanon/issues/1345)).

## The hosted server's tools

A test holds this list to the server's own tools (`[STAT-12]`, `[MCP-2]`). Every tool takes `repo`, the repository as `owner/name`, and is annotated read-only. A `repo` is checked against the same pattern `--repo` is: neither part may be `.` or `..`, which would name another path once GitHub's API URL is resolved, so such a call is the tool's error and reads nothing.

| Tool | Section | Arguments | View |
|---|---|---|---|
| `project` | `project` | `repo`, `project`: the tracking issue | [The project view](#the-project-view) |
| `release` | `release` | `repo` | [The release view](#the-release-view) |
| `pull_request` | `pr` | `repo`, `number`: the pull request | [The pull-request readiness view](#the-pull-request-readiness-view) |
| `lanes` | `lanes` | `repo` | [The lane-health view](#the-lane-health-view) |
| `needs_owner` | `needsOwner` | `repo` | [The needs-the-Owner view](#the-needs-the-owner-view) |

Before a tool reads a repository, the server checks that Kanon's status App reaches it with the person's access. It reads only the person's installations of the App and the repositories each grants, never the repository itself. A repository on an owner where the App isn't installed is the tool's error, saying so. So is one the installation doesn't grant, or one the person can't read: GitHub gives the same answer for both to the person's token, and only the App's own key could tell them apart, which the server doesn't hold.

Every answer that read GitHub carries the time its reads began, as `_meta.readAt` and as the answer's last line of text.

## Signing in

The server reads GitHub as the person, with their own access. It is its own OAuth 2.1 authorisation server, in front of the sign-in of Kanon's status App on GitHub, as the MCP authorisation specification at protocol version `2025-11-25` describes:

- **Discovery.** A 401 names the protected-resource metadata, `/.well-known/oauth-protected-resource/mcp`, which names the server as its own authorisation server. Its metadata is at `/.well-known/oauth-authorization-server`.
- **Registration.** A client registers itself at `/register`, by dynamic client registration. Only a public client registers, and only with redirects on the server's allow-list. The allow-list is a parameter of the server's deploy, and defaults to Claude's connector callbacks (`https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`) and any port on the loopback (`http://localhost:*` and `http://127.0.0.1:*`), for Claude Code.
- **Consent.** `/authorize` checks the client, its exact redirect, PKCE with `S256` and the resource, and then shows a page naming the client and where it sends the sign-in. It warns when that is a program on the person's own computer. GitHub shows nothing to a person who has authorised the App before, so this page is what stops a link someone else made from signing the person in to their program. Nothing goes to GitHub until the person presses Allow on that page.
- **GitHub.** The person signs in to GitHub with the status App, and GitHub sends them back to `/callback`, in the same browser.
- **Tokens.** The client exchanges its code at `/token` for an access token and a refresh token, and refreshes there.

The server keeps nothing. Everything the sign-in hands out, the client id included, is encrypted and authenticated under the server's KMS key, and carried by whoever holds it. The person's GitHub tokens exist only inside the access and refresh tokens the server issues. Its code wraps GitHub's code, so GitHub's refusal of a code used twice makes the server's single use too. Its refresh token wraps GitHub's, which GitHub replaces on every refresh and refuses a second time. The server mints no installation token and accepts no personal access token. When GitHub refuses the person's token, because they revoked the App's authorisation, the answer is 401, so the client signs in again. Revoking the App's authorisation on GitHub is how a person ends every token the server issued them at once: the server has no list of tokens to revoke from.

The status App must have GitHub's "expire user authorization tokens" setting on, so that GitHub's tokens expire and come with a refresh token.

### Token lifetimes

| Token | Lifetime | What it is |
|---|---|---|
| `client`, the client id | No expiry | The client's registration. A new deploy under another key ends it, and the client registers again. |
| `consent`, the consent form | 10 minutes | The page's Allow carries it. |
| `state`, the state sent to GitHub | 10 minutes | It goes to GitHub and back. |
| `code`, the authorisation code | 60 seconds | It is exchanged once. |
| `access`, the access token | 1 hour | It carries the person's GitHub token, and is never longer-lived than that token. |
| `refresh`, the refresh token | 30 days | Rolling: each refresh starts a new 30 days, so a person signs in again after 30 days without using it. |
| GitHub's user-to-server token | 8 hours | GitHub's. It is refreshed with GitHub's refresh token. |
| GitHub's refresh token | 6 months | GitHub's. |

A leaked access token reads, as that person, for at most an hour, or until they revoke the App's authorisation on GitHub.

### Freshness and the cache

Every read is sent to GitHub. The server keeps a per-person cache in the warm function's memory, of the REST answers that person's reads got. An answer is never used after 60 seconds, and it leaves memory the next time that function uses its cache, or when the function's container is discarded. It uses the cache only to ask GitHub conditionally, with the answer's ETag, and a 304 serves that answer, which doesn't count against the person's rate limit. So an answer is always live, and its `readAt` is when its reads began. Each person's entries are filed under a hash of their own GitHub token, so no entry is ever served to another person. GraphQL is never cached.

### What the server logs

One line per request, a JSON object of exactly these fields: the route, the MCP method, the tool, the outcome, the duration, the number of GitHub requests it made, and GitHub's remaining rate limit. Each value is a number or from a closed list, so a line never holds a token, a login, an error's message or anything GitHub answered. A tool's error may quote GitHub's own message, such as "Not Found": it is returned to the person and never logged. When a container can't read the App's client secret, it also logs `{"startup":"client_secret","code":…}`, whose code is AWS's error code, such as `ParameterNotFound`, or `Unconfigured` or `unknown`, and nothing of AWS's message.

## Connecting

Use the server's address, `<server-url>/mcp`. The first call opens the consent page, then GitHub, in a browser.

- **Claude Code:** `claude mcp add --transport http kanon-status <server-url>/mcp`, then run `/mcp` in Claude Code, choose `kanon-status` and authenticate.
- **claude.ai:** in Settings, under Connectors, add a custom connector with that address, and connect it.
- **The Claude app on a phone:** add the connector on claude.ai first. The app then lists it among a chat's tools, and connecting it there opens the same sign-in.

## Deploy

**The server is the stack `kanon-status`, in Kanon's AWS account in `eu-central-1`, beside the telemetry store** (project #1327, decision 2). Its template is [`infra/status/template.yaml`](../infra/status/template.yaml), and it creates exactly these resources, as `tests/unit/status-template.test.ts` holds it (`[MCP-10]`):

- the function, `kanon-status`: Node 24 on arm64, 256 MB, a 60-second timeout and no VPC. Its reserved concurrency is always set, 4 by default and never below 1, because its URL is public and the reservation bounds what a flood can cost;
- its function URL, with no IAM auth because the server does its own sign-in, and the two public grants such a URL needs;
- its role, which may write the function's log and read the one SSM parameter holding the App's client secret, and nothing else;
- its log group, `/aws/lambda/kanon-status`, kept 30 days;
- its KMS key, which seals everything the sign-in hands out. Its policy lets only the function's role use it, and only with the encryption context `service=kanon-status`; the account administers it through IAM and can't use it. It isn't rotated, and it is deleted with the stack after KMS's shortest wait, 7 days: nothing at rest depends on it, so replacing it only makes everyone sign in again.

No table and no bucket. The outputs are `McpUrl`, the server's address, and `LogGroupName`.

**It is deployed by the operator's repository, through Kanon's deploy lane,** as the telemetry store is ([the telemetry store's Deploy](telemetry.md#deploy)): the operator's repository pins a released Kanon, declares `production`, and holds the account's inputs as that environment's variables. Production is the Owner's dispatch. Kanon's repository has no deploy caller and no AWS-credentialed job. The operator's three hooks call the scripts beside the template, at the pinned tree that [`kanon-path`](../actions/kanon-path/README.md) puts in `$KANON`:

- **build,** with no credential: `node "$KANON/infra/status/build.mjs" --output "<output>"`. It copies the template, and the function's import closure with the repository's layout kept, which is where the template's `Code` and `Handler` point. The closure is the list in [`infra/status/closure.json`](../infra/status/closure.json), which `tests/unit/status-build.test.ts` holds equal to the walk the escalation test holds to the `always` paths, so what is deployed is what the Owner merged. It refuses a tree that doesn't load on its own, with no `node_modules` above it.
- **deploy,** with the environment's role: `node "$KANON/infra/status/deploy.mjs" --artifact "<artifact>" --bucket <artifacts bucket> --role-arn <service role> --release "<release>" --client-id <the App's client id>`, and, when the environment sets them, `--redirects`, `--reserved-concurrency` and `--permissions-boundary-arn`. It packages into the artifacts bucket, deploys `kanon-status` through the CloudFormation service role, and prints the stack's status and the server's address, and nothing else. Every parameter is passed on every deploy, so a variable removed resets its parameter. No secret passes through it, so the hook maps no `KANON_DEPLOY_SECRET`.
- **smoke:** `node "$KANON/infra/status/smoke.mjs" --stack`. It passes only when the stack is `CREATE_COMPLETE` or `UPDATE_COMPLETE`, an unauthenticated `tools/list` at `/mcp` gets 401 naming the server's own protected-resource metadata, and that metadata names the server as its resource and its authorisation server (`[MCP-11]`). It signs nobody in and needs no secret. A server whose secret can't be read answers that `tools/list` with 500, so it fails too. A failed deploy or smoke files `Deploy to production failed` in the operator's repository, and the next success closes it.

### Before the first deploy

These are the Owner's, once:

1. **The App's client secret.** Put it as a `SecureString` under the AWS-managed `aws/ssm` key. The function reads it at a container's first request and keeps it in memory, so it is in no template, stack parameter, function configuration, deploy or log:

   ```sh
   read -rs SECRET   # paste the status App's client secret
   aws ssm put-parameter --profile kanon --region eu-central-1 \
     --name /kanon-status/github-client-secret --type SecureString --value "$SECRET"
   unset SECRET
   ```

2. **Widen the bootstrap stack,** which stays the Owner's. Its deploy role may also create and execute change sets on `kanon-status`. Its service role may also manage resources named `kanon-status*`, and may create a KMS key only when the request tags it `kanon:stack=kanon-status`, and administer only a key carrying that tag (`aws:RequestTag` and `aws:ResourceTag`); the template tags its key that way. The boundary rule for roles doesn't change. Then check that the service role is still denied an untagged key, and allowed a tagged one:

   ```sh
   aws iam simulate-principal-policy --profile kanon --policy-source-arn <service role> \
     --action-names kms:CreateKey --query 'EvaluationResults[0].EvalDecision'
   # implicitDeny
   aws iam simulate-principal-policy --profile kanon --policy-source-arn <service role> \
     --action-names kms:CreateKey --query 'EvaluationResults[0].EvalDecision' \
     --context-entries ContextKeyName=aws:RequestTag/kanon:stack,ContextKeyValues=kanon-status,ContextKeyType=string
   # allowed
   ```

   A grant of `kms:TagResource` held only to the request's tag would let the service role tag someone else's key and then administer it, so check that it is denied on a key without the tag too.

3. **The `production` environment's variables** for the hooks above: the App's client id, and, if they aren't the defaults, the redirect allow-list and the reserved concurrency.

### Rotating the client secret

GitHub lets an App hold two client secrets. Generate a new one on the App's page, overwrite the parameter with `aws ssm put-parameter … --overwrite`, and deploy again: new containers read it. Then delete the old one on GitHub.

### By hand: break-glass

Only when GitHub Actions is down. From a Kanon checkout at the release tag being deployed, with your profile:

```sh
OUT=$(mktemp -d)
node infra/status/build.mjs --output "$OUT"
AWS_PROFILE=kanon node infra/status/deploy.mjs --artifact "$OUT" --bucket <artifacts bucket> \
  --role-arn <service role> --release <tag> --client-id <the App's client id>
AWS_PROFILE=kanon node infra/status/smoke.mjs --stack
```

**If the first deploy fails,** the stack rolls back and deletes what it made. The key waits 7 days for deletion, which costs nothing and blocks nothing: the next deploy makes a new one. A key policy naming a role IAM hasn't finished creating can fail that first deploy; deploy again.
