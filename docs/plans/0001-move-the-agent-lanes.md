# Plan 0001: move the agent lanes into Kanon

- **Status:** proposed. The Owner has decided questions 1 to 6 and 8 in principle (2026-10-01). Where a measurement below changes how a decision is carried out, the plan says so.
- **Governed by:** [ADR 0009](../decisions/0009-move-dont-rewrite.md) (move, don't rewrite), [ADR 0002](../decisions/0002-standardise-dont-parameterise.md) (no configuration), `K-ADOPT-11` (delivery forms), [chapter 11](../../rulebook/11-repository-layout.md) (fixed paths).
- **Measured on** the reference adopter's main branch on 2026-10-01, after its reviewer lane joined the blocks. That was the last of its lane conversions onto the blocks. The commands are in [Measurements](#measurements).

## The plan in one paragraph

The reference adopter's lanes are built from four composite actions: the three **blocks** (`agent-setup`, `agent-run`, `agent-finish`) and `agent-telemetry`. Ten lane workflows call them, either through a reusable **spine** (`agent-lane.yml`) or directly. The blocks and the scripts they run move to Kanon's `actions/`. The spine and the lane callers **stay in the adopter**, because the Owner decided that the project's own literals (database, toolchain, App identities) stay there, and a reusable workflow can't take steps or services from its caller. Before anything moves, three preparatory changes are made in the reference adopter itself (ADR 0009 §4). The last of them switches the blocks to GitHub's new self-reference syntax, `$/`, and removes the load, reload and tamper machinery. The move itself is then purely mechanical. The adopter's scanners don't move as code. They become Kanon unit tests and the rules of one new check action, `lane-check`, which ships in the same release as the blocks.

## 1. Order of moves

**Decided (Owner):** blocks first, scanners never blind. **What this plan changes about that order:** the spine and the lane callers don't move (see §5), and the work starts with preparatory changes in the reference adopter.

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **P1** | adopter | Split the classifier step out of `agent-finish` into a fourth local block, `agent-classify`. It has inputs `arm`, `recover` and `non-fatal`, and outputs `kind` and `retry`. Point every other caller of the classifier script at it: the reviewer's reconcile step, explore, overseer, code-audit and both digests. | The effective step list of every lane, resolved before and after the change, is identical apart from the new block boundary. The comparison is the one the adopter's block split used. A red run prints the same annotation, with the same `kind` and `retry`. |
| **P2** | adopter | Take the project literals out of the blocks and into the callers (§5): Node, npm cache, `npm ci`, the App-slug assertion, `AGENT_QUIET`, the starting map. | `grep -nE 'node-version\|npm ci\|AGENT_QUIET\|starting-map\|expect-slug' .github/actions/agent-{setup,run,finish}/action.yml` prints nothing. The per-lane step-list comparison shows the same steps, moved only from inside a block to just around it. |
| **P3** | adopter | Every block reference becomes `$/.github/actions/agent-*`, including the nested `agent-finish` → `agent-telemetry` call. The blocks read their scripts through `$GITHUB_ACTION_PATH`. The load, reload and tamper machinery is deleted (§2). | `grep -rn 'uses: ./.github/actions/agent-' .github/workflows` prints 0 lines, and so does a grep for the machinery's step names. **Live:** on a revise lane, the first round on a PR branch cut before P3 shows a green `Post Run` for both setup and run, and a collected cost row. The first review after P3 posts a verdict and a cost row. If either fails, §2's verdict is falsified: revert P3, which is one PR. |
| **1** | Kanon vN | Move `agent-classify` and `agent-telemetry` with their scripts. Ship `lane-check` v1, with the permission rules and the telemetry-caller rules. The adopter, in the same PR: `$/.github/actions/agent-{classify,telemetry}` becomes `yedeya-labs/kanon/actions/…@vN`, the local copies are deleted, `lane-check` is added to CI, the Kanon Dependabot entry is added, and `permissions-guard.mjs` is deleted. | Kanon's CI runs both actions through `$/`. In the adopter, `grep -rln 'classify-agent-result.mjs'` finds nothing outside `node_modules`, and `lane-check` is green on main. **Mutation:** dropping `continue-on-error` from one telemetry caller turns `lane-check` red. Over 24 hours, the collector receives an artifact from every lane it expects. Kolophon's CI and its Dependabot bump to vN are green. |
| **2** | Kanon vN+1 | Move `agent-setup`, `agent-run` and `agent-finish` with the quality script. `lane-check` v2 adds the lane-shape, standard-lane-table, CLI-flag and cache-setting rules. The adopter switches and deletes `cli-flag-guard.mjs`, `agent-lanes.mjs` and the block-internal tests (§7). | The adopter's `.github/actions/` holds no `agent-*` directory, and `lane-check` is green. **Mutation:** a direct-block lane whose finish call lacks `always()` turns it red. **Live:** one run of each lane shape (a spine lane, a direct-block lane, the reviewer) records a cost row. |
| **3** | Kolophon | Kolophon installs the lanes it can run: thin callers around Kanon's blocks, its Apps and its secrets (§8). | Kolophon's `lane-check` is green, and a first lane run uploads its telemetry artifact. The roadmap's falsifier applies: setup takes no more than about a day. |
| **later** | both | Telemetry collection and its scanners move with the store (`K-OBS-17`). The starting map moves with Kanon's spec tooling, once the adopter declares its spec prefixes in its spec files (`K-LAYOUT-2`). | Each gets its own plan. |

**Why this order.** Each step leaves both adopters working, and no step leaves a scanner blind.

- **The leaves move before the trunk.** `agent-classify` and `agent-telemetry` are called by every lane. Moving them first proves the pin, the Dependabot upgrade and `$/` nesting on code that can't red a run, because both are `continue-on-error`.
- **`lane-check` ships in the same release as what it checks**, and the adopter deletes a scanner only in the PR that installs the rule replacing it. Until then, P3 teaches the adopter's own scanners the `$/` form, and step 1 teaches them the remote form, in the same PR as each switch.
- **Why P3 matters most.** The resolver recognises a block only as `./.github/actions/<name>`. A lane switched to any other form drops out of every scan **silently**: a shorter list, not an error.

## 2. The load, reload and tamper machinery: verified, it goes

**Verdict: it holds.** A block referenced remotely, or through `$/`, is never read from the workspace. So nothing an agent or a PR does to the workspace can reach it.

**GitHub's documentation** (workflow syntax, `jobs.<job_id>.steps[*].uses`):
- `./path` "resolves against the runner's workspace rather than the repository of the running workflow". That is the root cause of all the machinery.
- `{owner}/{repo}/{path}@{ref}` names a repository at a ref.
- `$/path`, documented since 2026-07-29, "resolves to that repository at the running commit … You do not need to check out the repository first". It "always resolves against the repository of the file it appears in".

**The runner's behaviour** (actions/runner v2.336.0, which added `$/`):
- Every action reference, nested composite references included, is resolved and downloaded during **Set up job**, before any step runs. Pre and post steps are registered from that complete walk.
- A `$/` reference "is indistinguishable from a normal `owner/repo/path@sha` reference" once resolved.
- `LoadAction` re-reads `action.yml` from the runner's action cache (`_work/_actions/<owner>/<repo>/<ref>/`) at execution time, not from the workspace. The post steps of `setup-node` and `claude-code-action` inside a block therefore no longer need the block's file in the workspace. Their absence there is what made the reload necessary.
- `github.action_path` points into that cache. The whole repository archive is downloaded, which is why a block can reach `$GITHUB_ACTION_PATH/../<other-action>/`. The adopter's telemetry action already relies on this.

**What goes** (measured at 652 lines in 7 files, plus the reviewer's classifier pin):

| File | Removed | Lines |
|---|---|---|
| spine | "Load the lane's building blocks", "Load the blocks again", "Restore the telemetry action from the default branch" | 102 |
| `agent-run` | the `restore-paths` input and its "Return the checked-out branch" step | 13 + input |
| reviewer lane | the load step; "Record what the blocks hold" (the digest and its pinned file list); "Re-verify the blocks before the agent runs from them"; the reload; the telemetry restore; "Re-verify the blocks before the finish block runs from them" | 260 |
| reviewer lane | the classifier extracted from the base branch, its `classify_sha256`, and the re-check before running it. Replaced by a `uses:` of `agent-classify` (P1). | about 40 |
| four direct-block lanes (rebase, lead split, merge-reconcile, verify-acs) | their copies of the load, reload and restore steps | 277 |

**What stays:** the reviewer's base pin of *documents* (`restore-agent-docs.sh` and its `pin_digest`). The agent reads those from the workspace, and nothing about actions changes that.

**Why ADR 0009 allows this one non-mechanical change.**
- The machinery isn't part of what the lanes do. It is a workaround for one property of `./` references, and that property disappears with the reference form.
- Moving it would carry several hundred lines that run, check nothing, and fail closed on situations that can no longer arise.
- It is done in the adopter (P3) as an ordinary reviewed change with a live test, so the moves that follow stay purely mechanical.

**Open security concerns it closes:**
1. **An agent editing a block mid-run.** An agent working a pipeline issue may edit, move or delete `.github/actions/agent-*`. Today the reload reverses that. Afterwards the workspace copy is simply never read.
2. **The reviewer's install rewriting `.git` before a restore.** `npm ci` and `db:init` run the PR's code, which can plant a hook, a filter or a re-pointed `origin`. Today the reload and the telemetry restore then run `git checkout` and `git fetch` in that `.git`, which is why the digests exist. Afterwards no step restores anything with `git`.
3. **A PR branch older than the blocks.** The blocks are no longer looked for in the branch at all.

**The residue, stated plainly.** The action cache is on the runner's disk and writable by the job's user. `LoadAction` reads it at execution time, so a process that deliberately rewrites `_work/_actions/…` can still change a block. That belongs to the class the reviewer lane already records as undefendable in-job: "a lifecycle script that subverts the runner rather than the files". It is bounded the same way, by the fork gate and the human merge.

**Two risks to check in P3:**
- The runner gates `$/` behind a feature flag (`actions_dollar_self_reference`). The documentation presents it as available, but P3's live run is the proof.
- The adopter's actionlint may not parse `$/` yet. Check its version before P3.

If `$/` fails, the fallback is the remote form `yedeya-labs/kanon/...@vX.Y.Z` (§4), and P3 is folded into step 1.

## 3. Scripts the blocks call, and where each lands

Every one uses only `node:` built-ins. A grep for language features newer than Node 18 found none. The runner tools they call are `bash`, `git`, `gh`, `jq` and `sha256sum`. Like `pr-title`, the blocks don't install Node: the caller's job does (§5).

| Script | Lines | Dependencies | Lands in |
|---|---|---|---|
| `classify-agent-result.mjs` | 460 | `node:fs`, `node:url` | `actions/agent-classify/`. Its importers are tests and `agent-telemetry.mjs`, which reaches it at `$GITHUB_ACTION_PATH/../agent-classify/`. |
| `agent-telemetry.mjs` (normaliser) | 616 | `node:child_process`, `node:crypto`, `node:fs`, the classifier | `actions/agent-telemetry/` |
| `agent-quality-prs.mjs` | 80 | `node:child_process`, `node:fs` | `actions/agent-finish/` |
| `starting-map.mjs` | 281 | `node:*`, and `spec-lib.mjs` (281 lines), whose `PREFIXES` map hard-codes the adopter's 16 spec areas | **Not moved now.** It becomes an adopter step before `agent-run` (P2). It moves later with the spec tooling. |
| `install-playwright-chromium.sh` | 58 | `apt`, `npx` | **Stays in the adopter.** Browsers are project setup (§5), and the adopter's `ci.yml` uses it too. |

## 4. Self-pinning: `$/`, not a release-time rewrite

**Decided (Owner):** the blocks must always be the same Kanon version as each other.

**Measured:** the runner now does this natively, so the release-please rewrite agreed in principle isn't needed. The runner's own rationale for `$/` is exactly this circular-tag problem.

- Inside Kanon, one action reaches another only as `$/actions/<name>`. That resolves to the commit the adopter pinned. `agent-finish` → `$/actions/agent-telemetry` is the one nested reference today.
- An adopter refers to each block as `yedeya-labs/kanon/actions/<name>@vX.Y.Z`. One Dependabot group bumps every reference together (`K-ADOPT-11`), `lane-check` included.
- **Guard test** (Kanon, `tests/unit/`): no file under `actions/` contains `uses: ./` or `uses: yedeya-labs/kanon/`. A `./` reference would resolve against the *adopter's* workspace, and a tag reference would name the previous release.
- **Kanon's own CI before any release:** a smoke workflow calls `$/actions/agent-classify`, `agent-telemetry` and `agent-finish` with fixture execution files, and `agent-setup` with the push probe off. No model runs and nothing is spent. `$/` resolves to the PR's own commit, so every PR exercises its own blocks. The adopter's block split gave this as the reason it couldn't use remote references. `agent-run`'s single real step, the model call, is covered by the adopter's first live run after each upgrade.
- **The `lane-check` rule:** every Kanon reference in an adopter names the same `vX.Y.Z`.
- **Fallback, if `$/` is unavailable:** release-please `extra-files` with an `x-release-please-version` marker on each internal reference, the same guard test, and the blocks and the spine released in consecutive versions so that every pin names an existing tag.

## 5. Repository-specific literals: all stay in the adopter

**Decided (Owner):** none becomes a Kanon input or a fixed path.

**The consequence, which P2 carries out:** the literals leave the *blocks*. The spine and the lane callers stay in the adopter as the jobs that hold them. Measured in the blocks, the telemetry action and the spine (`grep -oE … | wc -l`):

| Literal | Today | Ends up |
|---|---|---|
| Postgres service: image, the project's database name ×10, port 5433 ×3, `DATABASE_URL`, `DATABASE_URL_APP` | spine | **The adopter's job** `services:` and its env step. They already sit outside the blocks, because a composite action can't declare `services:`. |
| `npm run db:init` ×4 | spine | An adopter step between `agent-setup` and `agent-run`. Unchanged. |
| `setup-node` with `node-version: "24"`, `cache: npm`, `npm ci` ×3 | `agent-setup` | **Out of the block (P2)**, into the adopter's job before `agent-setup`. The `install` and `npm-cache` inputs disappear, and the reviewer's own late install becomes simply its own step. |
| App-slug assertion (`expect-slug-export`, the module path of the login constant) | `agent-setup` | **Out of the block (P2)**, as an adopter step after `agent-setup`. The block keeps the push probe, which is Kanon's runtime scope check (`K-AGENT-5`). |
| `docs/qa/agent-identities.md` in the push-probe message | `agent-setup` | **Stays in the block.** It is Kanon's fixed path (`K-LAYOUT-6`), not the adopter's. |
| `AGENT_QUIET` ×2 | `agent-run` | **Out of the block (P2).** The adopter sets it as `env:` on its `agent-run` call, and env on a composite step reaches the steps inside it. P2 verifies this with the failures-only test output. |
| Starting map and `.agent/starting-map.md` | `agent-run` | **Out of the block (P2)**, as an adopter step just before `agent-run` (§3). |
| `install-playwright-chromium.sh` | spine | An adopter step. Unchanged. |
| `claude_args` per lane (model, effort, turns, budget) | each caller | Stays an input for now. `lane-check` checks it against Kanon's standard lane table (ADR 0005 §2). It becomes Kanon-internal when the table moves into the blocks, which is a later Kanon change. |
| The reference adopter's organisation, its QA role name and its infrastructure file, in the telemetry header ×5 | `agent-telemetry` | **Literal substitution** on the move ("the QA store's role", "the store's infrastructure code"). The public-tree test would fail without it. |
| A persona name and "Gate C" ×1 | `agent-run` | Substitution: "the Maintainer's merge". |
| Section anchors of the adopter's own documents (`observability.md §8`, `agentic-qa-pipeline.md §6`) | all four | Substitution: the Kanon rule id, or the action's README. |
| Issue references: 6, 8, 15, 16, and 62 in the three scripts | all moving files | **Owner decision 5.** |

**What P2 costs.** Every lane caller gains up to three explicit steps that were inside `agent-setup`, and the spine gains the same.

**Why there's no Kanon spine.** A reusable workflow can't host the adopter's services or steps, so a Kanon spine could hold none of the literals above. That conflicts with `K-ADOPT-11`'s "Lane → reusable workflow" row. Owner decision 1 resolves it.

## 6. The scanners

**What they are.** The reference adopter has five scripts, plus one shared resolver, that read its workflow files to answer one question: **which agent lanes exist, and what does each pass the model?** Each uses the answer differently:

| Scanner | Lines | What it does |
|---|---|---|
| `agent-lanes.mjs` | 259 | The shared resolver. It expands a lane, whether direct, spine or direct-block, into its effective steps, reading each block's `action.yml`. |
| `cli-flag-guard.mjs` | 370 | Runs the real Claude CLI against every lane's flag block, with no credentials, and fails on a flag the CLI rejects. `claude-code-action@v1` floats, so a CLI update can break every lane at once. |
| `permissions-guard.mjs` | 593 | Checks that each job grants the scopes its steps need, and nothing broader. |
| `cache-ttl-check.mjs` | 424 | Joins each lane's prompt-cache pin to its arm and to the store's cutover records, for the Overseer's audit. |
| `qa-store.mjs` (`agentsIn`, `agentNames`) | 106 | Which agent partitions exist in the store. A regex copy, because the Overseer runs without `node_modules`. |
| `collect-agent-telemetry.mjs` (`AGENT_WORKFLOWS`) | 294 | The collector's expected list of lanes. |

**Why they matter.** A scanner that misses a lane doesn't fail. It produces a **shorter list**: fewer flags probed, fewer partitions read, fewer permissions checked. That reads as a clean run. Moving the blocks is exactly the change that makes them miss, because a remote `uses:` matches none of their patterns. Hence §1's rule that a scanner is replaced in the same PR that would otherwise blind it.

**Decided (Owner):** the scanners become Kanon code in two forms:
- **Kanon unit tests,** for what Kanon fixes inside its blocks;
- **`lane-check` rules,** for what the adopter controls. `yedeya-labs/kanon/actions/lane-check@vX.Y.Z` reads the adopter's `.github/workflows/`, and reads the block definitions at its own version through `$GITHUB_ACTION_PATH/../agent-*/action.yml`.

Telemetry collection is not a lint check: it moves later, with the store. The disposition of each:

| Existing code | Becomes | Why |
|---|---|---|
| `agent-lanes.mjs` (the resolver) | `lane-check`'s internal library, and its tests | Every rule needs effective steps, and it has no imports. |
| `permissions-guard.mjs` | `lane-check` rule (v1) | Each job's grant is the adopter's. What the blocks need is known at lane-check's version. |
| `cli-flag-guard.mjs`: does the CLI accept the flags | `lane-check` rule (v2) | The flags are the adopter's input until the standard lane table moves in, and the CLI floats under `@v1`. It becomes a Kanon test once both are fixed inside the blocks. |
| `cli-flag-guard.mjs`: the prompt-cache pin list | split. Block-level pin: Kanon test. Per-arm pin: `lane-check` rule. | The Owner placed the cache setting in the standard lane table. |
| `cache-ttl-check.mjs` | **moves with telemetry later** | It queries the store's cutovers. |
| `qa-store.mjs` (`agentsIn`, `agentNames`) | **moves with telemetry later** | It enumerates store partitions. Until then it is taught each new `uses:` form in the PR that introduces it. |
| `collect-agent-telemetry.mjs` (`AGENT_WORKFLOWS`) | **moves with telemetry later** | The Owner's point 3. |
| `ship-review-scope.mjs` (uses the resolver) | stays in the adopter, with the block paths dropped from its scope | It decides the adopter's own `/code-review` scope. It isn't a scanner. |

**Delivery form.** `lane-check` is a **check** in `K-ADOPT-11`'s sense: a composite action under `actions/`. It isn't an npm guard, and no npm package is needed for this plan.

**Parsing YAML without dependencies.** It parses YAML with the runner's preinstalled `yq` (`yq -o=json`), with a first step that fails by name if `yq` is absent (Owner decision 6).

**Its rules are mutation-checked** in Kanon's tests: a rule that can't fail is a bug.

## 7. The tests

**Scope.** 61 files in the adopter touch the blocks, the spine, the lanes or the resolver. 43 of them name a lane workflow only to test that lane's own logic.

| Disposition | Count | Files |
|---|---|---|
| **Kanon unit test** (block internals) | 0 whole, 9 in part | Below. |
| **`lane-check` rule test** (in Kanon) | 3 whole | the direct-lane fixture (`agent-direct-lane.yml`, the shape every rule is tested on); `direct-block-lane-2669` (the scanners agree on that fixture); `permissions-guard` |
| **Moves with telemetry later** | 1 whole | `collect-agent-telemetry` |
| **Deleted with the machinery** (§2) | 0 whole, 2 in part | Below. |
| **Stays in the adopter** | 43 whole | Each lane's own contract and the adopter's own scripts: `agent-implement-revise`, `agent-lead`, `agent-lead-revise`, `agent-verify-acs`, `agent-review-filter`, `agent-review-verdict`, `rebase-lane`, `revise-round-record`, `implement-crash`, `split-lineage`, `lead-reconcile`, `merge-gate`, `dispatch-sweep` (and its fixture), `brief-revise-recovery`, `review-recovery`, `review-run-evidence`, `review-trailer`, `red-test`, `red-unreviewed`, `incremental-review`, `pinned-docs`, `playbook-excerpt-2488`, `project-digest`, `project-inheritance`, `decomposition-contract`, `capability-interlock-countable`, `code-audit-report-invalid-639`, `explorer-change-gate-714`, `filter-job-if-2596`, `follow-up-membership`, `issue-triage-defaults`, `label-guard`, `overseer-backlog-dynamics`, `overseer-dependency-free`, `doc-path-guard-919`, `runner-artifact-guard`, `ship-review-scope`, `workflow-health`, `agent-quiet-output-2456` and `starting-map-2456` (both P2 literals), `install-playwright-chromium`, and the `workflow-step` helper (§8, decision 7) |
| **Split** | 14 | Below. |

The 14 split files, each with its halves:

| File | Kanon test | `lane-check` rule | Telemetry later | Deleted | Adopter |
|---|---|---|---|---|---|
| `agent-lane-blocks` | the composite rules each block lives with (string inputs, `bash -e {0}`, `job-status` instead of `failure()`) | | | load and reload bodies run against real git | |
| `classify-agent-result` | the classifier | each lane wires it | | | |
| `agent-telemetry` | the action and the normaliser | every caller has `always()` and `continue-on-error` | | | |
| `agent-quality-columns` | `agent-quality-prs.mjs` | | the column builder | | |
| `agent-step-flags` | flags declared where the action reads them | per-arm fallback chains (standard lane table) | | | |
| `prompt-cache-ttl-pin` | the block passes the pin through | per-arm pin values | | | |
| `cache-ttl-check` | the block-level pin fixture | | the store join | | |
| `agent-full-transcript-2651` | the block passes `show_full_output` | | | | which lanes opt in |
| `lane-retry` | `agent-finish`'s `retry` output contract | | | | the job-level breadcrumbs (the adopter's protocol) |
| `implement-turn-cap-2207` | | turn cap per lane | | | the wall-clock timeout |
| `merge-reconcile-lane-2660` | | a direct-block lane calls the blocks in order | | | "installs nothing" |
| `agent-lanes` | | the resolver (`lane-check`'s library) | its agreement with `qa-store`'s regex | | |
| `reviewer-base-instructions` | | | | the block digests and the classifier pin (27 + 3 references) | the documents' base pin |
| `helpers/spine.ts` | | block expansion (`readBlock`, `blockInputsFor`, `effectiveSteps`) | | | the per-lane caller helpers |

**How the moved tests keep asserting against real steps.**
- **In Kanon,** a test parses the real `actions/*/action.yml` in the same tree and runs the real scripts against fixtures, as `action.test.ts` does for `pr-title`. The smoke workflow (§4) runs the blocks for real through `$/` on every PR.
- **In the adopter,** `lane-check` runs on its real workflows in CI, against block definitions of the exact version they call. The lane tests that stay assert the adopter's own steps and the `with:` it hands each block. Anything inside a block is Kanon's test, so the 15 staying tests that expand blocks through `helpers/spine.ts` are re-pointed to stop at the block boundary.

## 8. Identities and secrets

**Decided (Owner):** fixed names.

**What an adopter creates to run the lanes:**
- **One App per role** it runs, from the roles table (`K-ADOPT-8`): Lead, Implementer, Reviewer, Merger, Explorer, Overseer. Each is listed in `docs/qa/agent-identities.md` with its slug.
- **Two secrets per App,** under fixed names: `<ROLE>_APP_ID` and `<ROLE>_APP_PRIVATE_KEY`, for example `REVIEWER_APP_ID`.
- **`CLAUDE_CODE_OAUTH_TOKEN`:** the subscription token (`claude setup-token`). The second adopter chose it, with one lane run at a time (ADR 0009).
- **No repository variables.** The lanes need none. The adopter's `QA_*` variables belong to the store, and move with it.

The blocks never name a secret. They receive the tokens as inputs, because a composite action can't read `secrets`. So the names live in the adopter's jobs, and a `lane-check` rule in v2 enforces them, together with the App slugs against the register.

**The reference adopter today:** its secrets use a project prefix and an older role name (`QA_<ROLE>_APP_*`, with the Implementer stored under the triage name). It renames them at step 2. Actions secrets can't be read back, so renaming means generating a new key per App, which is also a rotation (Owner decision 7).

**Kolophon's install is the test.** It has no Apps yet. Its register reads "None installed", and it is private on a plan without rulesets. Step 3 succeeds only if its Owner can create the Apps and secrets from this list and `K-ADOPT-8` alone, and `lane-check` then passes.

## 9. Issues

None are migrated ahead of time. When a piece moves, its open issues in the reference adopter are re-filed on Kanon and written neutrally, and the original is closed with a link. GitHub can't transfer an issue between organisations.

## Measurements

Run in the reference adopter's checkout (`RA`) and in Kanon's. All commands were run with `AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null`.

**Block, spine and reviewer sizes** (145, 138, 177, 245, 474 and 2,329 lines):

```
wc -l $RA/.github/actions/*/action.yml $RA/.github/workflows/agent-lane.yml $RA/.github/workflows/agent-review.yml
```

**Which lanes use which form** (5 spine callers; 5 direct-block lanes: rebase, merge-reconcile, lead split, verify-acs, review; 5 raw classifier callers):

```
for f in $RA/.github/workflows/agent-*.yml; do echo "$f $(grep -c 'agent-lane.yml' $f) $(grep -c 'actions/agent-run' $f)"; done
grep -n 'classify-agent-result' $RA/.github/workflows/*.yml
```

**Literals per file** (the counts in §5): for each pattern, count matches in each of the blocks, the telemetry action and the spine.

```
for p in pgvector 5433 db:init node-version 'npm ci' AGENT_QUIET '#[0-9]{3,4}'; do grep -oE "$p" FILE | wc -l; done
```

**Machinery lines** (652 lines in 7 files): a Python walk that sums each step whose name starts "Load the lane's building blocks", "Load the blocks again", "Restore the telemetry action", "Record what the blocks hold", "Re-verify the blocks" or "Return the checked-out branch", including its leading comment block.

**Script dependencies, sizes and importers.** For each script: its sizes, then its imports, then which other files import it.

```
wc -l SCRIPT
grep -nE "^import" SCRIPT
grep -rl "SCRIPT_BASENAME" --include="*.mjs" --include="*.ts" --include="*.yml" $RA/.github $RA/scripts $RA/tests
```

**Node version features:**

```
grep -nE "import\.meta\.dirname|globSync|Object\.groupBy|toSorted|findLast|withResolvers" SCRIPTS
```

It prints nothing.

**Tests in scope** (61 files):

```
grep -rlE "agent-lane\.yml|actions/agent-(setup|run|finish|telemetry)|agent-lanes\.mjs|helpers/spine|classify-agent-result|agent-quality-prs|starting-map|\.github/workflows/agent-" $RA/tests
```

That finds 59 files. These add 2 more:

```
grep -rlE "\.github/actions|install-playwright-chromium|claude-code-action" $RA/tests
```

Each file was then classified by reading its `describe` titles and its references.

**Secrets:**

```
grep -ohE "secrets\.[A-Za-z_-]+|vars\.[A-Z_]+" $RA/.github/workflows/agent-*.yml | sort | uniq -c
```

**`$/` support:**
- the documentation source, `github/docs`: `content/actions/reference/workflows-and-actions/workflow-syntax.md`, §`steps[*].uses`, and `metadata-syntax.md`, §`runs.steps[*].uses`;
- `gh api repos/actions/runner/releases/tags/v2.336.0`, which lists "add self-repository action reference syntax";
- the runner PR's description, for the Set up job resolution, `LoadAction`'s re-read from the action cache, and the feature flag.

## Decisions for the Owner

1. **Amend `K-ADOPT-11`: lanes ship as composite actions, and each adopter writes a thin caller job around them.** The "Lane → reusable workflow" row can't hold your Q5 decision, because a reusable workflow takes no steps or services from its caller. *Recommend: yes.* The release workflow keeps its row. The reviewer and lead lanes' own logic (thousands of lines of steps) then reaches Kolophon later, as further composite actions, one plan per lane. That keeps ADR 0009 §6's promise that the second adopter installs the real loop, rather than a copy of the reference adopter's callers.
2. **Do P1 to P3 in the reference adopter before step 1,** including the §2 removal under `$/`. *Recommend: yes.* The one non-mechanical change is then reviewed and proven live where it already runs, and every move after it is a file move plus substitutions.
3. **Self-pinning by `$/` rather than a release-time rewrite** (§4), with the rewrite as the fallback. *Recommend: yes.* It changes the mechanism you agreed in principle, not the outcome.
4. **A fourth block, `agent-classify`** (P1). *Recommend: yes.* Six workflows run the classifier outside `agent-finish`, two of them with flags `agent-finish` doesn't pass. Without it, the classifier has no single remote home they can all call.
5. **Issue references in moved comments** (107 in the moving actions and scripts, 23 in the resolver). GitHub would autolink each one to an unrelated Kanon issue. *Recommend:* the mechanical substitution `#N` → `RA-N`, with one line in each action's README saying `RA-N` is a reference-adopter issue. That keeps the reasoning and the provenance trail, and no longer links anywhere.
6. **`lane-check` parses YAML with the runner's `yq`,** rather than a bundled parser. *Recommend: yes.* No dependency, no build step, and no vendored third-party code. A self-hosted runner without `yq` gets a named failure.
7. **Secret names `<ROLE>_APP_ID` and `<ROLE>_APP_PRIVATE_KEY`, plus `CLAUDE_CODE_OAUTH_TOKEN`,** written into `K-AGENT-6`. The reference adopter renames its secrets at step 2, by minting a new key per App. *Recommend: yes.* Kolophon creates the fixed names from the start.
8. **The starting map stays in the adopter** until it declares its spec prefixes in its spec files (`K-LAYOUT-2`). *Recommend: yes.* Moving it now would carry 16 of the adopter's domain areas into Kanon.
9. **One test-only duplicate.** The adopter's `workflow-step` test helper (31 users, several of them deploy tests) is copied into Kanon's `tests/` for the moved tests. It is recorded as test scaffolding that isn't shipped, not a live copy under ADR 0009 §2. *Recommend: yes.* The alternative would be publishing a test-utility package for one helper.
