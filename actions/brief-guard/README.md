# `brief-guard`: Kanon's brief guard

Fails a pull request whose project briefs under `docs/projects/` don't have the shape the Lead's lanes and the reconciler read: a `file:line` coordinate in a brief ([`K-PROJ-3`](../../rulebook/07-projects.md)), an open marker left in its decisions section ([`K-PROJ-5`](../../rulebook/07-projects.md)), a decomposition the reconciler can't parse or file ([`K-LAYOUT-12`](../../rulebook/11-repository-layout.md)), a required section missing ([`K-LAYOUT-13`](../../rulebook/11-repository-layout.md)), and a tracking issue whose kind label or milestone is wrong (`K-WORK-23`). [`scripts/brief-guard.mjs`](../../scripts/brief-guard.mjs) says what it checks and what it deliberately doesn't. The Lead runs the same guard on its own briefs before it opens a pull request; this action runs it on every pull request, so a brief a person or another lane edits is checked too ([#1608](https://github.com/yedeya-labs/kanon/issues/1608)).

The action is in Kanon from 0.45.0.

## Use it

`kanon init` writes this job into a new `.github/workflows/ci.yml` when you choose a Lead lane. With a CI of your own, add it under `jobs:`, pinned to the **exact version** your other Kanon references pin ([`K-ADOPT-11`](../../rulebook/10-adoption.md)):

<!-- x-release-please-start-version -->

```yaml
  brief-guard:
    name: Brief guard
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      issues: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: yedeya-labs/kanon/actions/brief-guard@v0.45.0
```

<!-- x-release-please-end -->

- **Check out first.** The guard reads the briefs, and `docs/qa/exemptions.md` when you have one, from the working directory.
- **`issues: read` is required.** The guard reads each brief's tracking issue, and any roadmap milestone a brief names, through `gh` with the workflow token. A read that fails is a finding, never a pass.
- **The guard runs at the pinned version, outside the workspace.** The action runs Kanon's own script through [`kanon-path`](../kanon-path/README.md), which also sets up Kanon's Node, so a pull request can't change the guard that judges it.
- **No inputs.** A repository with no brief yet, no `docs/projects/<n>.md`, passes, and the step says there was nothing to check: the guard on its own calls a run that finds no brief broken.
- **Doctor notices a missing job.** Where a workflow calls a Lead lane and no job of a workflow that runs on `pull_request` runs the guard, `kanon doctor` reports `ci.brief-guard-missing`, a note, with this job as its fix ([`docs/doctor.md`](../../docs/doctor.md)). A step that runs `scripts/brief-guard.mjs` from `kanon-path`, as Kanon's own `shipped-guards.yml` does, counts too.
