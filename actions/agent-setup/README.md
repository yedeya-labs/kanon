# `agent-setup`: set up an agent lane

Block 1 of an agent lane. After the lane has minted its App token, checked out and run the project-setup hook, it makes every commit the agent makes the App's, signed off by the person your repository delegated, and it can prove that the App can push, before a single model turn is paid for.

A lane is built from four composite actions, so that a lane with steps of its own between the stages can use them directly:

| Block | Does |
|---|---|
| `agent-setup` | Makes the agent's commits the App's, signed off by the delegate, and optionally proves the App can push. |
| [`agent-run`](../agent-run/README.md) | Runs the agent. |
| [`agent-finish`](../agent-finish/README.md) | Explains a red run, and records what the run cost. |
| [`agent-classify`](../agent-classify/README.md) | Explains a red run. `agent-finish` calls it, and so can a lane on its own. |

`agent-finish` also calls [`agent-telemetry`](../agent-telemetry/README.md).

## Use it

<!-- x-release-please-start-version -->

```yaml
- uses: yedeya-labs/kanon/actions/agent-setup@v0.26.0
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
- **The agent speaks as its role** (plan 0005 §3.3). The block resolves the role and writes `KANON_ROLE`, `KANON_PERSONA` and `KANON_POST_HEADER` for the rest of the job: the persona is each commit's author name, and [`agent-run`](../agent-run/README.md) asks the agent to open every post with the header line, `**<Role>** <!-- kanon:role=<role> -->`. While no persona is declared, the persona is the role. A role it can't resolve is a warning, and the agent runs without one.
- **Order.** Mint the App token, check out with it, run the project-setup hook, then call this block. The probe pushes with the credential the checkout persisted.
- **Inputs are strings.** A composite action has no boolean type, so a switch is `"true"` or `"false"`.
- Pin an exact Kanon version, and let Dependabot propose upgrades (`K-ADOPT-11`).
