# `agent-setup`: set up an agent lane

Block 1 of an agent lane. After the lane has minted its App token, checked out and run the project-setup hook, it puts Kanon's baseline in the place of any playbook your repository leaves out, makes every commit the agent makes the App's, signed off by the person your repository delegated, and it can prove that the App can push, before a single model turn is paid for.

A lane is built from four composite actions, so that a lane with steps of its own between the stages can use them directly:

| Block | Does |
|---|---|
| `agent-setup` | Takes Kanon's defaults for the declarations you leave out, makes the agent's commits the App's, signed off by the delegate, and optionally proves the App can push. |
| [`agent-run`](../agent-run/README.md) | Runs the agent. |
| [`agent-finish`](../agent-finish/README.md) | Explains a red run, and records what the run cost. |
| [`agent-classify`](../agent-classify/README.md) | Explains a red run. `agent-finish` calls it, and so can a lane on its own. |

`agent-finish` also calls [`agent-telemetry`](../agent-telemetry/README.md).

## What it changes in your working tree

Before it sets the commit identity, it takes Kanon's documented defaults (`K-LAYOUT-17`, [plan 0005](../../docs/plans/0005-lean-installation.md) §5.2). For each playbook `docs/qa/` doesn't have, it copies Kanon's baseline for the role, from [`rulebook/templates/playbooks/`](../../rulebook/templates/playbooks/) at the version you pin, to that path, so the prompt reads it where it names it. Each copy is listed in your checkout's `.git/info/exclude`, so the agent's commits never include it, and `agent-run` names the copies in the agent's prompt, so an agent asked to write your first playbook knows to stage it with `git add -f`. A playbook you keep is never touched. For each optional section your stack document leaves out, it says what it means. Every default it takes is one line in the log and in the job's summary.

On the review lane, the restore of the judging inputs takes the playbook defaults itself, before the lane pins them (`K-MERGE-17`), so this step then finds them in place and copies nothing.

## Use it

<!-- x-release-please-start-version -->

```yaml
- uses: yedeya-labs/kanon/actions/agent-setup@v0.30.0
  with:
    arm: lead agent
    app-slug: ${{ steps.app-token.outputs.app-slug }}
    push-probe: "true"
```

<!-- x-release-please-end -->

| Input | Required | Meaning |
|---|---|---|
| `arm` | yes | A human name for the lane, used in error messages. |
| `app-slug` | yes | The minted App's slug, from `actions/create-github-app-token`. |
| `role` | no | The role the agent speaks as (`Implementer`, `Reviewer`, …). Empty reads it from the App register on the default branch, by the minted App's slug. Pass it when you call the block before your token exists. |
| `push-probe` | no | `"true"` runs `git push --dry-run` with the checkout's credential. It creates nothing. Default `"false"`. |
| `github-token` | no | Reads the App's bot account and the default branch's delegation record. Pass the minted App token; the default, the workflow token, is enough for a public repository or a caller that grants `contents: read`. |

| Output | Meaning |
|---|---|
| `kanon-error` | `push_probe_denied` when the push probe failed, for the telemetry row. Empty otherwise. |

- **The agent's commits pass your `dco` check** (`K-AGENT-44`). The block writes `GIT_AUTHOR_*` and `GIT_COMMITTER_*` for the rest of the job, so every commit is authored `<persona> <id+slug[bot]@users.noreply.github.com>` and committed by `<slug>[bot]`, the App the [`dco` action](../dco/README.md) looks up in your App register. When your default branch has a [sign-off delegation record](../../rulebook/11-repository-layout.md) (`docs/qa/sign-off-delegation.md`), it also points git at a hooks directory outside the workspace whose `commit-msg` adds that person's `Signed-off-by:`, read with the `dco` action's own parser. Your own git hooks still run: each one present when the block runs is called from there, and your `commit-msg` runs after the sign-off is added. With no record, the commits carry no sign-off, and a `dco` check fails them. You write no hook code for either. With an empty `app-slug` the step is skipped, for a lane that calls the block before it mints its token.
- **The agent speaks as its role** (plan 0005 §3.3). The block resolves the role and writes `KANON_ROLE`, `KANON_PERSONA` and `KANON_POST_HEADER` for the rest of the job: the persona is each commit's author name, and [`agent-run`](../agent-run/README.md) asks the agent to open every post with the header line, `**<Role>** <!-- kanon:role=<role> -->`. While no persona is declared, the persona is the role. A role it can't resolve fails the step by name, before the agent runs: since L4 no reader counts an unmarked post as any role's. A run with no `role` and no `app-slug` (or `github-actions`) posts as no App, and passes.
- **Order.** Mint the App token, check out with it, run the project-setup hook, then call this block. The probe pushes with the credential the checkout persisted.
- **Inputs are strings.** A composite action has no boolean type, so a switch is `"true"` or `"false"`.
- Pin an exact Kanon version, and let Dependabot propose upgrades (`K-ADOPT-11`).
