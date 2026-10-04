# `kanon-path`: find Kanon's scripts from a workflow step

Sets up the Node that Kanon's scripts run on, and puts the absolute path of the Kanon tree it was loaded from in its `path` output and in `KANON` for every later step of the job, so a step can run one of Kanon's scripts at the version the workflow pinned ([plan 0001 §3](../../docs/plans/0001-move-the-agent-lanes.md)).

A `run:` step reads the checked-out repository, and a reusable workflow can't read its own repository by path. But every action a job uses is downloaded into the runner's action cache before the job starts, and this one lands inside a whole copy of Kanon at the pinned commit. Kanon's own lanes call it as `$/actions/kanon-path`.

## Use it

<!-- x-release-please-start-version -->

```yaml
- uses: yedeya-labs/kanon/actions/kanon-path@v0.21.0
- run: node "$KANON/scripts/playbook-excerpt.mjs"
```

<!-- x-release-please-end -->

| Output | Meaning |
|---|---|
| `path` | The absolute path of Kanon's root in the runner's action cache. The same value is in `KANON`. |

- **The scripts run at the pinned version, outside the workspace.** A pull request can't change the script a lane runs on it, because the script isn't in the checkout.
- **They still run in the workspace.** A script reads the repository's own files (its App register, its specs, its briefs) relative to the working directory, at the paths in [chapter 11](../../rulebook/11-repository-layout.md), so check the repository out first when the script needs them.
- **Never import Kanon's scripts from `node_modules` in a lane.** On a pull-request lane the install is the pull request's.
- **It sets up Kanon's Node.** It installs Node 24, the major in Kanon's `engines`, with `actions/setup-node` pinned to an exact release, so a script runs on the same Node whatever the runner image ships. Dependabot proposes each bump of that pin to Kanon, so you need do nothing. It puts that Node first on the `PATH`: call it before your project's own toolchain setup if a later step runs your project's code on a different Node.
- **Read the path from the output after your project's code has run.** Your code can rewrite `$GITHUB_ENV`, and with it `KANON`; a step's output is the runner's. Kanon's lanes give every agent step `KANON` from this output, so your project-setup hook need not export it.
- **It fails** if the tree it finds has no `scripts/` directory.
