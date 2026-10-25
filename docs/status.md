# `kanon status`

`kanon status` says where a repository that runs Kanon stands, read live from GitHub when you ask. It writes nothing, anywhere: no file, no comment, no label, no cache. Every answer comes from Kanon's status core (`scripts/status/`), which judges each thing with the deciders the lanes themselves run, the Lead's reconciler for a project's phase among them. So `kanon status` can't disagree with what the next lane run will do. The core's clauses are the `STAT` area of the spec layer ([`docs/qa/specs/status.md`](qa/specs/status.md)).

```sh
kanon status --project 1327
kanon status --project 1327 --json
kanon status --pr 1391
kanon status --repo owner/name --project 12 --pr 40
```

| Option | Meaning |
|---|---|
| `--project <n>` | The project view of tracking issue `<n>`. |
| `--pr <n>` | The pull-request readiness view of pull request `<n>` ([below](#the-pull-request-readiness-view)). |
| `--repo <owner>/<repo>` | The repository. The default is the origin remote of the checkout you run it from. |
| `--json` | Print one JSON document instead of prose ([below](#the-json-output)). |

Each view you ask for is one section of the answer, and you can ask for both at once. The project and pull-request readiness views are the ones there are so far. The lane-health, release and needs-the-Owner views each add their own section as they are built.

## What it reads

It reads with your own `gh` credential, as [`kanon doctor`](doctor.md) does. `gh` takes its token from `GH_TOKEN`, then `GITHUB_TOKEN`, then its stored login. The command says on standard error which one it used and whose it is, and stops when GitHub refuses it. It reads only what that token can read, and asks GitHub only REST `GET`s and GraphQL queries.

It reads every declaration from the repository's default branch on GitHub: the brief, the spec layer, the App register, the adoption record, the escalation file, the exemptions file and the stack document. It never reads them from your checkout, so a local branch doesn't change the answer. Your checkout is used to find the repository when you don't pass `--repo`, and for one more thing with `--pr`: that view runs the merge gate's own verdict function, and loading it reads the App register from the directory you run in, as each lane does in its checkout. So run `--pr` from a checkout of a repository that runs Kanon. The logins the view judges by are still the default branch's register's, with one exception: the gate's hold logic still compares whoever applied `needs:human` against the Merger login (`MERGER_LOGIN`) in the register in the directory you run in. A checkout whose register names a different Merger can therefore read a hold differently.

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

## The pull-request readiness view

For a pull request, `--pr` reads it as the Merger would on its next sweep, through the same reads the merge gate makes, and gives:

- **its checks**, partitioned as the merge gate partitions them: the ones that count (the Reviewer's and the Merger's own runs don't), and of those, the ones still running, cancelled with nothing re-run, and failed;
- **the Reviewer's latest verdict**, the commit that verdict read, and whether it is current, which it is only when that commit is the head;
- **the acceptance criteria of the issues it closes**, each with its status in the spec layer;
- **the merge gate's verdict** for it, `merge`, `wait`, `recover`, `escalate`, `release` or `skip`, with the rule that decided it and its reason;
- **for a brief**, each open decision in it, read at its head as the brief guard reads it;
- **whether it is ready to merge, and by whom.**

Whether it is ready is never the view's own judgement:

- **The Implementer's pull request** is the Merger's. It is ready when the merge gate answers `merge`. It is ready for a person's merge when the gate escalates it for an escalation path alone: the gate, asked again with the declared paths lifted, answers `merge`. Any other answer isn't ready, and the gate's rule is what it lacks.
- **Any other pull request** is a person's to merge, never the Merger's. That is one the gate skips as not provably the Implementer's: a person's, a Lead's brief, a dependency bump, the release pull request. It is ready when three things hold, and the view names each one it lacks:
  - `checks`: the gate's check partition finds at least one check that counts, and none running, cancelled or failed;
  - `approval`: the Reviewer's verdict on its head, as the review-recovery lane reads it, is an approval;
  - `decisions`, for a brief only: the brief guard finds no open decision in it. A brief the default branch's `docs/qa/exemptions.md` lists as pre-standard isn't checked.

  Nothing else is asked of it: a person merging it reads the rest on GitHub.

## Exit codes

| Code | Status | Meaning |
|---|---|---|
| 0 | `ok` | Every view asked for was answered. |
| 2 | `error` | A usage error: an unknown or malformed flag, or no view named. |
| 3 | `error` | It couldn't run: no repository to read, a token GitHub refuses, or `--pr` run outside a checkout that has an App register (`docs/qa/agent-identities.md`). |
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

On a usage error or when it can't run, the document is the error document, `{ "schema", "kanon", "status": "error", "exitCode", "error" }`.

## The hosted server's tools

The same views will be served read-only by a hosted MCP server, whose tools are listed here once it is built. A test holds this list to the server's own (`[STAT-12]`). There are none yet.

| Tool | View |
|---|---|
