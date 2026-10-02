# `agent-setup`: set up an agent lane

Block 1 of an agent lane. After the lane has minted its App token, checked out and run the project-setup hook, it can prove that the App can push, before a single model turn is paid for.

A lane is built from four composite actions, so that a lane with steps of its own between the stages can use them directly:

| Block | Does |
|---|---|
| `agent-setup` | Optionally proves the App can push. |
| [`agent-run`](../agent-run/README.md) | Runs the agent. |
| [`agent-finish`](../agent-finish/README.md) | Explains a red run, and records what the run cost. |
| [`agent-classify`](../agent-classify/README.md) | Explains a red run. `agent-finish` calls it, and so can a lane on its own. |

`agent-finish` also calls [`agent-telemetry`](../agent-telemetry/README.md).

## Use it

<!-- x-release-please-start-version -->

```yaml
- uses: yedeya-labs/kanon/actions/agent-setup@v0.10.0
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
| `push-probe` | no | `"true"` runs `git push --dry-run` with the checkout's credential. It creates nothing. Default `"false"`. |

- **Order.** Mint the App token, check out with it, run the project-setup hook, then call this block. The probe pushes with the credential the checkout persisted.
- **Inputs are strings.** A composite action has no boolean type, so a switch is `"true"` or `"false"`.
- Pin an exact Kanon version, and let Dependabot propose upgrades (`K-ADOPT-11`).
