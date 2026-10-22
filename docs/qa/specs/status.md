# Kanon status

What Kanon's status core computes about a repository that runs Kanon, and what `kanon status` prints from it, where a project has needed a clause to cite. The core is one library that reads GitHub and stores nothing; `kanon status --json` and the hosted MCP server (the `MCP` area, [`mcp.md`](mcp.md)) are two surfaces over it. Seeded by project [#1327](https://github.com/yedeya-labs/kanon/issues/1327)'s brief, whose decision 13 chooses which pull requests count as ready for a person's merge: `[STAT-10]` and `[STAT-14]` are written to that brief's recommended answer, and are rewritten on its branch before it merges if the answer differs. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `STAT`

## The core

- `[STAT-1]` `[seed]` The status core reads GitHub only through the reader its caller passes in, and writes nothing: a test runs every view over a recording reader and finds no request but a REST `GET` and a GraphQL `query`, and the core writes no file, table or cache that outlives the process.
- `[STAT-2]` `[seed]` The status core reads each declaration it needs (the brief, the spec layer, the App register, the escalation paths, the adoption record) from the repository's default branch through the shared declarations reader, and its code names no repository: the same code path answers every view over a fixture adopter's declarations and over Kanon's own.
- `[STAT-3]` `[seed]` A read the status core can't complete (not found, a refused token, an exhausted rate limit, a listing truncated before its end) makes that view's answer an error naming the read and why, with the rate limit's reset time when that is the cause, and never an empty or partial answer presented as complete.

## The project view

- `[STAT-4]` `[seed]` For a tracking issue whose brief is on the default branch, the project view lists each decomposition item with its filed issue, found by the project marker, that issue's state, its open and merged pull requests, its dependencies, and each acceptance-criterion id it cites with the clause's status in the spec layer and whether a test cites it; it reports the project's phase as the reconciler's phase function returns it, and its gating work as the closure module decides it, for the same reads.
- `[STAT-5]` `[seed]` The project view names each item that can't proceed, and why: an open dependency, `qa:needs-info`, `qa:needs-split`, `blocked`, a Lead hold (`needs:human` with the hold marker), or a `qa:human-action` item waiting on a person. A tracking issue with no brief, or a brief whose decomposition doesn't parse, is reported as that, never as a project with no items.

## The pull-request readiness view

- `[STAT-6]` `[seed]` The readiness view of a pull request gives its checks, partitioned as the merge gate partitions them; the Reviewer's latest verdict and whether it is current, which it is only when the commit that verdict read is the pull request's head; the acceptance-criterion ids of the issues it closes, with their spec status; and the merge gate's verdict for it (merge, wait, escalate or skip) with that verdict's rule and reason.
- `[STAT-7]` `[seed]` For a pull request the merge gate's verdict function takes as the Implementer's, the readiness view reports it ready only when that function, given the same reads, answers merge (ready for the Merger), or answers escalate for an escalation path alone with a current approving verdict and green checks (ready for a person's merge); it computes no readiness of its own beside that function.
- `[STAT-14]` `[seed]` A pull request the merge gate's verdict function skips as not the Implementer's (its `not-the-implementer` and `not-implementer-label` rules: a person's, a Lead's brief, a dependency bump, the release pull request) is reported as a person's to merge, never the Merger's, and ready for that merge only when the merge gate's check partition finds at least one relevant check and none pending, cancelled or failed, the Reviewer's verdict on its head as the review-recovery lane's verdict function reads it is an approval, and, for a brief pull request, the brief guard reports no open decision; the view applies no other test, and names which of the three a pull request that isn't ready lacks.

## The lane-health view

- `[STAT-8]` `[seed]` The lane-health view lists each lane caller the repository's lane check reads, with its recent runs' state as the workflow-health check classifies it, and each failed run's class: `infra` when the agent classifier recorded the model unreachable, an API error or no verdict, or a later attempt of the same run succeeded; `real` otherwise. A lane whose only failures are `infra` is reported flaky, not red.

## The release view

- `[STAT-9]` `[seed]` The release view gives the open release pull request, the latest release, the latest pre-release with its age, each environment the adoption record's `## Deploy` declares with its last deploy's release and outcome as the reconciler's deploy read finds it, and, where the default branch runs Kanon's promotion workflow, each promotion gate's verdict and evidence from the promotion's own read-only check.

## The needs-the-Owner view

- `[STAT-10]` `[seed]` The needs-the-Owner view lists, each with its link and its reason: the pull requests the readiness view reports ready for a person's merge, both the Implementer's that the merge gate escalates and those it skips as not the Implementer's; the Implementer's stops that wait on a person (`qa:needs-info`, `qa:needs-split`, a scope-first bail comment, or the dispatch sweep's awaiting-human state); the Lead's holds; each open decision in an open brief pull request, read as the brief guard reads it; and the lanes the lane-health view reports red. It lists nothing else.

## `kanon status`

- `[STAT-11]` `[seed]` `kanon status --json` prints one `kanon-status/v1` document that follows the convention of `docs/cli-json.md` (its opening fields, its error document, camelCase names), with one section per view it was asked for; without `--json` it prints the same result as prose, with the same exit code.
- `[STAT-12]` `[seed]` `docs/status.md` lists every field of `kanon-status/v1` and every tool of the hosted server, and a test fails when the code emits a field or a tool those tables don't list, or a row names one the code doesn't emit.
- `[STAT-13]` `[seed]` `README.md`, `docs/architecture.md` and `docs/install.md` each link `docs/status.md`, and a test holds the three links.
