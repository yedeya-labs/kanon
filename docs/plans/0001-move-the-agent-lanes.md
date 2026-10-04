# Plan 0001: move the agent lanes into Kanon

- **Status:** proposed, revised 2026-10-01. Steps P1 to 5a are done for the lanes they name. Step 5's check, "the adopter holds no `agent-*` lane logic", holds for the ten lanes this plan moves; eight more lanes, this plan's "later" row, are still in the adopter. **Step 6 was paused by the Owner on 2026-10-03,** and the remaining lanes are planned in [plan 0004](0004-move-the-remaining-lanes.md).
  - The Owner agreed questions 1 to 6 and 8 in principle, and decisions 2, 3, 5 and 8.
  - The Owner **rejected decision 1** (adopter-written lanes around Kanon's blocks). This revision plans the replacement direction, which the Owner decided: **Kanon ships each lane as a reusable workflow; the adopter writes a trigger-only caller and one project-setup hook.**
- **Governed by:** [ADR 0009](../decisions/0009-move-dont-rewrite.md) (move, don't rewrite), [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), `K-ADOPT-11`, and [chapter 11](../../rulebook/11-repository-layout.md).
- **Measured on** the reference adopter's main branch on 2026-10-01. The commands are in [Measurements](#measurements).

## The plan in one paragraph

**Today.** The reference adopter runs ten agent lanes on four composite actions: the three **blocks** (`agent-setup`, `agent-run`, `agent-finish`) and `agent-telemetry`. Five lanes go through a reusable **spine** (`agent-lane.yml`), and five call the blocks directly.

**Where it ends.**
- **Kanon ships:**
  - the actions;
  - the spine;
  - one reusable workflow per lane, holding everything but the triggers;
  - the **pipeline library**: the 39 scripts the lanes run, which import each other too densely to move one at a time.
- **The adopter keeps:**
  - per lane, a caller holding its triggers, `permissions:`, secrets and one `uses:` line;
  - one **project-setup hook** at a fixed path, holding every project literal.
- **Kanon fixes one standard test database.**

**How it gets there.**
- **Prepare in the adopter first** (ADR 0009 §4). The last preparation step switches the blocks to `$/` and deletes the load, reload and tamper machinery.
- **Then the moves.** Each one is a file move plus listed substitutions, and the adopter's callers shrink in the same step.

## 1. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **P1** | adopter | Split the classifier into a fourth local block, `agent-classify` (inputs `arm`, `recover`, `non-fatal`; outputs `kind`, `retry`). Point the reviewer's reconcile, explore, overseer, code-audit and both digests at it. | Every lane's effective step list is identical, before and after, apart from the block boundary. The comparison is the one the adopter's block split used. A red run prints the same `kind` and `retry`. |
| **P2** | adopter | Create `.github/actions/project-setup` (§5) and move every project literal into it: Node, `npm ci`, `DATABASE_URL_APP`, `db:init`, Playwright, `AGENT_QUIET`, the App-slug assertion and the starting map. Switch the lanes to Kanon's standard database values (§5). The blocks and spine call the hook after checkout and before `agent-setup`. | `grep -nE 'node-version\|npm ci\|db:init\|AGENT_QUIET\|starting-map\|expect-slug\|5433' .github/actions/agent-*/action.yml .github/workflows/agent-*.yml` prints nothing. An implement run passes `db:init` and the RLS conformance test against the standard service. |
| **P3** | adopter | Every block reference becomes `$/.github/actions/agent-*`. The blocks read their scripts through `$GITHUB_ACTION_PATH`. The load, reload and tamper machinery goes (§2). | `grep -rn 'uses: ./.github/actions/agent-'` prints only the hook. **Live:** a revise round on a PR branch cut before P3 has a green `Post Run`, and the first review after P3 posts a verdict and a cost row. If either fails, §2 is falsified and P3 is reverted. |
| **P4** | adopter | Take the adopter literals out of the pipeline library: declare each spec area's prefix in its spec file (`K-LAYOUT-2`) instead of `spec-lib.mjs`'s 16-entry map, and read App logins from the register (`K-LAYOUT-6`) instead of constants. | `grep -rnE "AGENT_LOGIN = '\|PREFIXES = \{"` over the library prints nothing, and `npm test` is green. |
| **1** | Kanon vN | Move the five actions. The adopter switches `$/` to `yedeya-labs/kanon/actions/…@vN`, adds the Kanon Dependabot entry, and points its existing scanners at a checkout of Kanon at the pinned tag (§6). | The adopter's `.github/actions/` holds only `project-setup`, and its scanners report the same lane list as before the switch. **Mutation:** a lane whose finish call lacks `always()` still turns them red. Kolophon's Dependabot bump is green. |
| **2** | Kanon vN+1 | Move the spine, and the three lanes that run no workspace script (triage, implement-revise, lead-revise), as Kanon lane workflows. Their callers shrink to triggers. Ship `lane-check` (§6). | `lane-check` is green on the adopter, and each of the three callers is under 40 lines. **Live:** one run per lane records a cost row. |
| **3** | Kanon vN+2 | Move the pipeline library (39 files) and `actions/kanon-path` (§3), with the implement and merge-reconcile lanes. In the same PR, the adopter's not-yet-moved workflows switch from `node scripts/qa/…` to `node "$KANON/…"`. Its lint-run guards import the library from its `.kanon/` checkout of Kanon at the pinned tag (decision 13, as amended). | `grep -rnE 'node (\./)?scripts/qa/' .github/workflows` prints nothing, and the adopter's `npm run lint` and `npm test` are green. **Live:** an implement run and a merge-reconcile run. |
| **4** | Kanon vN+3 | Move the review and verify-acs lanes. The review lane gets one base-restore step driven by `K-MERGE-17`'s list, which replaces the adopter's per-file restores, and a test fails when the list and the step disagree ([#25](https://github.com/yedeya-labs/kanon/issues/25)). | **Live:** a review run posts a verdict and its cost row, on a PR branch cut before the step. A test shows that a PR editing each input on `K-MERGE-17`'s list is still reviewed under base's copy, each case mutation-checked. |
| **4a** | Kanon, `cli/` (run as `npx github:yedeya-labs/kanon#vX.Y.Z`; decision 13) | Ship `kanon apps` in `@yedeya-labs/kanon`, the first piece of the installer planned for the adoption checklist (`K-ADOPT-1`, [#39](https://github.com/yedeya-labs/kanon/issues/39)). For each role the adopter runs, it builds the App manifest from chapter 03's roles table: the role's permissions plus Metadata: read, and no webhook (`K-ADOPT-8`). It opens the organisation's create-App page with the manifest filled in, exchanges the one-time code for the App ID and private key, and sets `<ROLE>_APP_ID` and `<ROLE>_APP_PRIVATE_KEY` with `gh secret set`, never writing the key to disk. It then opens the install page, checks that the installation is on that repository and nowhere else, and writes the register row (`K-LAYOUT-6`). The Owner still clicks **Create** and **Install** (`K-AGENT-6`). Key rotation stays manual, because GitHub has no API for it; the command prints the steps. | Kanon's own Reviewer App is created, installed and registered with it (step 4b). A manifest test fails on any permission outside the role's row of the roles table. **Mutation:** add one permission to a manifest. Kolophon's Apps at step 6 are created with it. |
| **4b** | Kanon | Turn the Reviewer on for Kanon's own PRs ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)), with the App from step 4a. Kanon's caller pins the **previous** release, never `$/`, so a PR that changes the Reviewer is reviewed by the released one. It reviews members' PRs only ([#24](https://github.com/yedeya-labs/kanon/issues/24)), and the Owner still merges. From here on, each extraction PR is reviewed by the lane it extracts. **Installed** ([#22](https://github.com/yedeya-labs/kanon/issues/22)): the caller `.github/workflows/review.yml`, pinned to v0.10.0 and exempted by name in the self-pinning test; Kanon's project-setup hook (Node from `.nvmrc` and `npm ci`, no database); the review lane's labels; CI running `lane-check` at the same release; and Dependabot's `kanon` group, which now bumps the caller, `lane-check`, and the hook's `/.github/actions/*` too. | **Live:** a review of a Kanon PR posts a verdict and its cost row. |
| **5** | Kanon vN+4 | Move the lead, lead-split and rebase lanes. | **Live:** one run per lane. The adopter holds no `agent-*` lane logic. |
| **5a** | Kanon | **Keep the version-2 telemetry row for 90 days** ([#123](https://github.com/yedeya-labs/kanon/issues/123); [plan 0002](0002-hosted-telemetry-store.md)'s S1a, which holds the detail). Step 6 no longer waits for the store (plan 0002, decision 16), so Kolophon's rows wait in its run artifacts until plan 0002's S8 imports them. `agent-telemetry` uploads the `kanon-telemetry-*` artifact with a fixed 90-day retention instead of its 7-day `retention_days` input. | Plan 0002's S1a checks: a unit test pins 90, and a Kanon lane run's version-2 artifact expires 90 days after it was created. |
| **6** | Kolophon | **Paused by the Owner on 2026-10-03, not done.** What remains is all of it: Kolophon installs trigger-only callers, its hook (`setup-node` and `npm ci`, no database) and its Apps, created with `kanon apps` (step 4a). The Reviewer comes first, because it ends bootstrap (`K-ADOPT-6`). | `lane-check` is green on Kolophon, and a first review posts a verdict. The roadmap's falsifier applies: setup takes no more than about a day. |
| **later** | both | The non-model lanes (merge, lead-reconcile, dispatch-sweep) follow the same way. The store-coupled lanes (explore, overseer, code-audit, the digests) and the telemetry scanners move with the store (`K-OBS-17`). | Planned in [plan 0004](0004-move-the-remaining-lanes.md), which moves them while step 6 is paused. It found the digests touch no store. |

**Why this order.**
- **The non-mechanical changes (P1 to P4) are made where they already run,** and are proven there. That leaves every Kanon step a move.
- **The lanes with no workspace script go first,** so the reusable-workflow shape is proven before the library moves under it.
- **The library moves in one step** because it can't move in parts (§3).
- **No scanner is ever blind.** Each adopter scanner keeps running until its last lane leaves (§6).
- **Kanon reviews itself from step 4b,** as soon as the review lane is here, so the remaining moves are each reviewed by the lane they extract. Steps 4a and 4b are the two Kanon steps that aren't moves. Delegated sign-off ([#23](https://github.com/yedeya-labs/kanon/issues/23)) and the security rules ([#24](https://github.com/yedeya-labs/kanon/issues/24)) are now in the rulebook, so the Implementer runs on Kanon as ADR 0011's stage 2, once the Owner creates its App; the Lead follows later, by the Owner's decision ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)).

## 2. The load, reload and tamper machinery: verified, it goes

**Verdict: it holds.** A block referenced remotely or through `$/` is never read from the workspace.

**GitHub's documentation** (workflow syntax, `steps[*].uses`):
- `./path` "resolves against the runner's workspace".
- `$/path`, documented since 2026-07-29, "resolves to that repository at the running commit … You do not need to check out the repository first". It "always resolves against the repository of the file it appears in": in a reusable workflow called from another organisation, that is the called workflow's repository.

**The runner** (actions/runner v2.336.0, which added `$/`):
- Every reference, nested ones included, is resolved and downloaded during **Set up job**, and pre and post steps are registered from that walk.
- `LoadAction` re-reads `action.yml` from the action cache (`_work/_actions/…`), never from the workspace, so a block's post steps no longer need its file in the workspace.

**What goes:** 652 lines in 7 files, plus about 40 lines of the reviewer's classifier pin.

| File | Removed | Lines |
|---|---|---|
| spine | the block load, the reload, and the telemetry restore from the default branch | 102 |
| `agent-run` | the `restore-paths` input, and the step that returns the checked-out branch | 13 |
| reviewer lane | the load; the block digest ("Record what the blocks hold") and both re-verifications; the reload; the telemetry restore | 260 |
| the other four direct-block lanes | their copies of the load, reload and restore steps | 277 |
| reviewer lane | the classifier extracted from the base branch, and its digest check. `agent-classify` replaces it (P1). | about 40 |

**What stays:** the reviewer's base pin of *documents*, which the agent reads from the workspace.

**Why ADR 0009 allows this one non-mechanical change.** The machinery is a workaround for one property of `./` references, and it does nothing once that property is gone.

**It closes three open concerns:**
- **An agent editing a block mid-run.** The workspace copy is never read.
- **The reviewer's PR install rewriting `.git`** before a reload runs `git checkout`. Nothing reloads any more.
- **PR branches older than the blocks.** The blocks aren't looked for there.

**The residue.** The action cache is writable by the job's user. That is the "subverts the runner" class the reviewer lane already accepts.

**Risks to check in P3:**
- `$/` sits behind a runner feature flag (`actions_dollar_self_reference`).
- The adopter's actionlint may not parse `$/` yet.
- **Fallback:** remote `@vX.Y.Z` references with a release-time rewrite (§4).

## 3. Reusable workflows: what moves, what can't, and the library

**Can move into Kanon's lane workflow.** A called workflow's jobs are ordinary jobs: `needs`, job `if`, job `concurrency`, `strategy.matrix`, `services`, `timeout-minutes`, outputs, steps and App minting.

That covers every job-level part of the lanes:
- the review filter's deduplication, its deferral while CI runs, and its label exemption;
- the claim gate;
- lead-split's per-issue concurrency;
- rebase's matrix, and its record-the-attempt step.

Two context facts make this work:
- In a called workflow, "the `github` context is always associated with the caller workflow". So every `if` and filter that reads `github.event` works unchanged, including on `pull_request_target` and `workflow_run`.
- The caller's file comes from the base or default branch on those triggers, so the Kanon tag it pins is as trusted as the lane file is today.

**Must stay in the caller** (from GitHub's reusable-workflow reference):

| Key | Why |
|---|---|
| `on:` and the `workflow_dispatch` form | Triggers are the caller's by definition. Kanon's lane declares the same inputs under `workflow_call` and the caller passes them through (`with: issue_number: ${{ inputs.issue_number }}`), so every `inputs.x` in the lane still resolves. |
| `permissions:` on the calling job | It is the ceiling. "Permissions passed from the caller workflow can be only downgraded" by the called one. |
| `secrets:` | Passed explicitly, by the fixed names (§8). |
| **workflow-level `concurrency`** (9 of 10 lanes) | **Genuinely unresolved.** The calling job's `concurrency` is a documented key and is equivalent for a caller with one job. A top-level `concurrency:` *inside* a called workflow is undocumented. Decision 11. |

**Behaves differently, and is handled:**
- Workflow-level `env` "is not propagated", so any lane-level env moves into Kanon's jobs.
- `github.workflow` is the caller's name. No lane's concurrency group uses it: each uses a fixed prefix.

**The library, and how a reusable workflow reaches it.** The lanes run 14 scripts by workspace path. Their import graph, taken in both directions, joins **39 of the adopter's 66 pipeline scripts (19,846 lines, `node:` built-ins only)**. For example, `implement-crash.mjs` imports `dispatch-sweep.mjs`, which `lead-reconcile.mjs` imports too. Moving part of that graph would leave two live copies, so the library moves whole, at step 3.

A reusable workflow can't read its own repository by path: a `run:` step reads the adopter's checkout. The new `$/` fixes this.
- Kanon adds `actions/kanon-path`, one step that outputs the absolute path of Kanon's root in the action cache.
- A lane step then runs `node "$KANON/scripts/<name>.mjs"`. That is a mechanical substitution, at the version the caller pinned, outside the workspace.
- **Lanes never import the library from `node_modules`**, because on a PR lane the install is the PR's.
- The header comment of Kanon's `release.yml`, which says this is impossible, gets a separate fix.

**Scripts inside the actions** (decided Q3): the classifier (460 lines) goes to `actions/agent-classify/`, the telemetry normaliser (616) to `actions/agent-telemetry/`, and the quality count (80) to `actions/agent-finish/`. All use `node:` built-ins only. The starting map (281) joins the library at step 3, because P4 removes the adopter literals from `spec-lib.mjs` that held it back (decision 8).

## 4. Self-pinning

**Decided (decision 3).** Every Kanon-internal reference uses `$/`:
- lane workflow → `$/.github/workflows/agent-lane.yml`;
- spine and lanes → `$/actions/agent-*`;
- `agent-finish` → `$/actions/agent-telemetry`;
- lanes → `$/actions/kanon-path`.

All of these resolve to the commit of the tag the caller pinned.

**Guard test (Kanon):** no file under `actions/` or `.github/workflows/` references `yedeya-labs/kanon/` or `./`, except the hook.

**Kanon's CI:** a smoke workflow runs the actions through `$/` on fixtures, with no model call, so every PR exercises its own code. A lane's single model call is proven by the adopter's live run after each upgrade.

**The adopter:** pins one `vX.Y.Z` in every caller and in `lane-check`. One Dependabot group bumps them together (`K-ADOPT-11`).

## 5. The project-setup hook and the standard database

**The hook (a split rule; `K-LAYOUT-1` gains its path).** `./.github/actions/project-setup/action.yml` is a composite action the adopter writes. The mechanism and the inputs are Kanon's; the content is the project's.

**What Kanon passes it** (all strings):
- `lane`;
- `install`, `database`, `browsers`;
- `issue-number`;
- `app-slug`;
- `github-token`.

**What it does**, in the reference adopter's file:
- `setup-node` 24 with the npm cache, and `npm ci` when `install` is true;
- `DATABASE_URL_APP` written to `$GITHUB_ENV`, then `npm run db:init`, when `database` is true;
- `install-playwright-chromium.sh` when `browsers` is true;
- `AGENT_QUIET=1` written to `$GITHUB_ENV`, for the lanes that opt in;
- the App-slug assertion against its login constant;
- the starting map, when there is an issue number.

**One hook, not one per lane** (decision 10). The inputs say what each lane needs. Kolophon's hook is three lines.

**When a lane calls it.** Every lane that checks out calls the hook after the checkout and before `agent-setup`. A lane that needs no project setup (merge-reconcile installs nothing) doesn't call it at all. That is a property of Kanon's lane, not a setting.

If the file is missing, the lane fails with a named error. That happens on PR branches cut before P2: rebase them. It is a one-time transition, and it is the hook's own version of the problem §2 removes for the blocks.

**The standard test database (Kanon-fixed, decision 12).**
- The service is `pgvector/pgvector:pg17`, with user, password and database all `kanon`, on port 5432, switched on by the lane's `database` input.
- Kanon writes `DATABASE_URL=postgres://kanon:kanon@localhost:5432/kanon`.
- The adopter's hook runs its own schema setup against it.

*Since [#18](https://github.com/yedeya-labs/kanon/issues/18):* Kanon no longer fixes a test database (the Owner, 2026-10-03). A project declares `hook` in `docs/qa/test-database.md`, and its project-setup hook starts its database and writes `DATABASE_URL`. Otherwise it declares nothing, and gets none (`K-LAYOUT-16`). The standard above is now the worked example in the `test-database` block's README. An adopter adds its declaration before, or with, the upgrade, and rebases its open pull requests, because a lane that checks out a branch reads that branch's copy.

**What the reference adopter migrates in P2.** It runs the project's database name as user, password and database, on port 5433.
1. The hook writes `DATABASE_URL_APP` with the standard host, port and database name. The app role's name stays the adopter's: its `setup.sql` creates the role, and its setup script sets the role's password from that URL.
2. Confirm that nothing CI runs hard-codes the old database name or port. Its migrator, setup script and `env.ts` only *default* to them when `DATABASE_URL` is unset, and the standard sets it.
3. Its own `ci.yml` services aren't lanes, and stay as they are. So do the local worktree defaults.

**Security of the hook.** It runs adopter code, which on a PR-head lane is PR-controlled. That is the same class as the reviewer's PR `npm ci` today, and the reference adopter's deferred job-isolation issue, RA-2690, covers it.

| Lane | Checks out | App token reachable when the hook runs? |
|---|---|---|
| implement, triage, lead, lead-split, verify-acs | the default branch (reviewed code) | yes, persisted by checkout |
| implement-revise, lead-revise, rebase | the PR head (PR code) | **yes**, as with `npm ci` today |
| review | the PR head (PR code) | **no**. The token is minted after the hook, and the document base pin is re-verified in between, as today. |
| merge-reconcile | not called | none |

In every lane the hook runs before the agent, and the Claude token is never passed to it.

**Every literal, and where it ends up:**

| Literal | Ends up |
|---|---|
| Postgres image, credentials and port; `DATABASE_URL` | the Kanon standard |
| `DATABASE_URL_APP`, `db:init`, Node 24, the npm cache, `npm ci`, Playwright, `AGENT_QUIET`, the App-slug assertion, the starting map | the hook |
| Push-probe message naming `docs/qa/agent-identities.md` | stays in the block: it is a Kanon path (`K-LAYOUT-6`) |
| Each lane's `claude_args` (model, effort, turns, budget) | Kanon's lane file. ADR 0005 §2's standard lane table is now Kanon's by construction. |
| Logins and spec prefixes in the library | removed in P4 (the register, and `K-LAYOUT-2`) |
| The organisation name, the QA role and the infrastructure file in the telemetry header; a persona name; "Gate C"; the adopter's own document anchors | substitutions at each move |
| `#N` issue references | `RA-N` (decision 5) |

## 6. The scanners

**What they are.** Five scripts and a shared resolver read the adopter's workflows to answer one question: which lanes exist, and what does each pass the model?
- `agent-lanes.mjs` (259 lines) expands each lane into its effective steps.
- `cli-flag-guard.mjs` (370) runs the real CLI against each lane's flags.
- `permissions-guard.mjs` (593) checks each job's grants.
- `cache-ttl-check.mjs` (424) joins cache pins to arms and to the store.
- `qa-store.mjs` (106) and `collect-agent-telemetry.mjs` (294) list the store's lanes.

**Why they matter.** A miss is a **shorter list**, not an error. A remote `uses:` matches none of their patterns, so a lane that moves would silently drop out of every scan.

**Now that the lanes move, most of the YAML they check becomes Kanon's.**

| Scanner | Becomes | Why |
|---|---|---|
| `cli-flag-guard.mjs` | **Kanon test** | The flags live in Kanon's lane files. `agent-run` pins `claude-code-action` exactly, so the CLI is fixed per release (decision 14). |
| `permissions-guard.mjs`: grants inside each job | **Kanon test** | The jobs are Kanon's. |
| `permissions-guard.mjs`: the calling job's `permissions:` ceiling | **`lane-check` rule** | The caller holds it. |
| `agent-lanes.mjs` | **Kanon test helper** | Kanon's own tests use it to expand its lanes. No adopter rule needs it. |
| `cache-ttl-check.mjs`: the pin per lane | **Kanon test** | The pin is in Kanon's lane file. |
| `cache-ttl-check.mjs`: the store join | **with telemetry, later** | It reads the store. |
| `qa-store.mjs`, `collect-agent-telemetry.mjs` | **with telemetry, later** | Each lane's move PR teaches them the caller form. |

**`lane-check`** is a check action (`K-ADOPT-11`) with **permanent rules only**:
- each caller holds only `on`, `permissions`, the decided `concurrency` and one job;
- that job `uses:` a Kanon lane at the shared tag, and maps secrets by their fixed names;
- the hook exists at its path and declares Kanon's inputs;
- App slugs match the register;
- the Dependabot entry exists.

It parses this small YAML with the runner's `yq` (decision 6).

**Through the transition** (steps 1 to 5), the adopter's existing scanners keep checking its not-yet-moved lanes. Each lane leaves their scope in its move PR, and they're deleted when the last lane leaves.
- **How they still see the blocks** (decision 15): CI checks out Kanon at the tag the workflows pin, and the resolver maps `yedeya-labs/kanon/actions/<name>@vX` to that checkout.
- **Why not transitional rules:** that writes no `lane-check` rules only to delete them five steps later.

## 7. The tests

**Scope.** 61 adopter files touch the blocks, the spine, the lanes or the resolver. The lane-contract tests now move **with their lane**.

| Disposition | n | Files |
|---|---|---|
| Kanon at step 1 (actions) | 5 | `agent-lane-blocks` (its load and reload part is deleted at P3), `classify-agent-result`, `agent-telemetry`, `agent-step-flags`, `prompt-cache-ttl-pin` |
| Kanon at step 2, as tests and helpers | 12 | the spine helper `helpers/spine` and its resolver tests (`agent-lanes`, `direct-block-lane-2669`, the fixture lane); `permissions-guard`'s per-job half; `lane-retry`; `revise-round-record`; `agent-implement-revise`; `agent-lead-revise`; `implement-turn-cap-2207`; `agent-full-transcript-2651`; `implement-crash` (at step 3, with the library) |
| Kanon at step 4 | 10 | `agent-review-filter`, `agent-review-verdict`, `incremental-review`, `pinned-docs`, `reviewer-base-instructions` (its block-digest part is deleted at P3), `project-inheritance`, `agent-quality-columns`, `agent-verify-acs`, `merge-reconcile-lane-2660` and `playbook-excerpt-2488` (both at step 3) |
| Kanon at step 5 | 4 | `agent-lead`, `rebase-lane`, `split-lineage`, `decomposition-contract` |
| Kanon later, with the library's other lanes and guards | 22 | `lead-reconcile`, `merge-gate`, `dispatch-sweep` and its fixture, `brief-revise-recovery`, `review-recovery`, `red-unreviewed`, `red-test`, `review-run-evidence`, `review-trailer`, `follow-up-membership`, `issue-triage-defaults`, `label-guard`, `capability-interlock-countable`, `overseer-backlog-dynamics`, `overseer-dependency-free`, `code-audit-report-invalid-639`, `explorer-change-gate-714`, `project-digest`, `workflow-health`, `doc-path-guard-919`, `filter-job-if-2596` |
| With telemetry, later | 2 | `collect-agent-telemetry`, and `cache-ttl-check` (its pin half goes at step 1) |
| Stays in the adopter | 6 | `install-playwright-chromium` and `agent-quiet-output-2456` (both hook content), `starting-map-2456` (until step 3), `runner-artifact-guard`, `ship-review-scope`, the `workflow-step` helper (decision 9). A new test of the hook itself joins them. |

**Library tests move in step 3,** and where one tests a not-yet-moved lane, or the adopter's own content, it stays in the adopter and imports from the `.kanon/` checkout (decision 13, as amended).

**How the moved tests keep asserting against real steps.** They parse Kanon's real lane files and actions in Kanon's tree, and run the real scripts against fixtures. The smoke workflow runs the actions through `$/`. In the adopter, only the callers and the hook remain, and `lane-check` and the hook test cover them.

## 8. Identities and secrets

**What an adopter creates:**
- **One App per role** it runs (`K-ADOPT-8`), listed in `docs/qa/agent-identities.md`.
- **Two secrets per App:** `<ROLE>_APP_ID` and `<ROLE>_APP_PRIVATE_KEY`.
- **The subscription token,** `CLAUDE_CODE_OAUTH_TOKEN`.

**How they reach a lane.** Kanon's lane workflow declares exactly the secrets it uses, under those names, and the caller maps them explicitly, never with `secrets: inherit` (decision 7). The lanes need no repository variables.

**The reference adopter** renames its `QA_<ROLE>_*` secrets by minting new keys, by step 2.

**Kolophon has no Apps yet.** Step 6 is the test: it must be possible from this list alone.

## 9. Issues

None are migrated ahead of time. A piece's open issues are re-filed on Kanon when it moves, written neutrally, and closed at the source with a link. GitHub can't transfer issues between organisations.

## Measurements

All commands were run with `AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null`, in the reference adopter's checkout (`RA`) or the GitHub docs source.

**Sizes** (blocks 145, 138 and 177 lines; telemetry 245; spine 474; review 2,329):

```
wc -l $RA/.github/actions/*/action.yml $RA/.github/workflows/agent-*.yml
```

**Triggers, and top-level concurrency (9 of 10):**

```
grep -c '^concurrency:' $RA/.github/workflows/agent-*.yml
```

**Workspace scripts per lane** (14):

```
grep -vE '^\s*#' LANE | grep -oE '(\.github/scripts|scripts)/[A-Za-z0-9_./-]+\.(mjs|sh)' | sort -u
```

**The library** (39 of 66 files, 19,846 lines): a Python walk of every relative `import` under the adopter's two script directories, taking the undirected component of the 14 lane scripts plus the block scripts. The same walk lists non-`node:` imports, and there are none.

**Machinery** (652 lines): a Python walk summing each step named "Load the lane's building blocks", "Load the blocks again", "Restore the telemetry action", "Record what the blocks hold", "Re-verify the blocks" or "Return the checked-out branch", with its leading comment block.

**Database literals:**

```
grep -nE "$DB_NAME|5433" src/db/setup.sql scripts/db-setup.ts src/env.ts scripts/db-migrate.ts
```

Each hit is a default or a role name.

**Tests** (59 files, plus 2):

```
grep -rlE 'agent-lane\.yml|actions/agent-|agent-lanes\.mjs|helpers/spine|classify-agent-result|agent-quality-prs|starting-map|\.github/workflows/agent-' $RA/tests
grep -rlE '\.github/actions|install-playwright-chromium|claude-code-action' $RA/tests
```

Each file was classified by its `describe` titles and its references.

**Secrets:**

```
grep -ohE 'secrets\.[A-Za-z_-]+' $RA/.github/workflows/agent-*.yml | sort | uniq -c
```

**Reusable workflows:**
- `github/docs`, `reusing-workflow-configurations.md`: its limitations, the keywords a calling job may use, and the `github` context;
- `contexts.md`: `job.workflow_sha`;
- `workflow-syntax.md` and `metadata-syntax.md`: `$/`;
- actions/runner v2.336.0's release notes and its `$/` pull request.

## Decisions for the Owner

1. **Decided by the Owner, 2026-10-01:** Kanon ships each lane as a reusable workflow built from its blocks. Adopters write trigger-only callers and one project-setup hook at a fixed path. `K-ADOPT-11`'s "Lane → reusable workflow" row stands, and `K-LAYOUT-1` gains the hook's path as a split rule.
2. **Agreed:** prepare in the adopter first. This revision adds P4.
3. **Agreed:** self-pinning by `$/`, with a release-time rewrite as the fallback.
4. **Re-checked: keep `agent-classify`.** Kanon's reviewer lane calls it. So do the store-coupled lanes, which stay in the adopter until the store moves, and need the classifier without the rest of `agent-finish`.
5. **Agreed:** `#N` → `RA-N`.
6. **Re-checked: `lane-check` still parses with `yq`.** Its input is now only the callers and the hook, which makes a bundled parser even harder to justify.
7. **Re-checked:** the fixed names matter more now, because they are the `workflow_call` secret names Kanon declares. *Recommend:* explicit mapping in every caller, never `secrets: inherit`, which would hand all of an adopter's secrets to Kanon's code.
8. **Agreed:** the starting map stays in the adopter until the spec prefixes are declared in the spec files. P4 now does exactly that, so it moves at step 3 with the library.
9. **Re-checked: the test helper.** About 45 of its users move to Kanon. *Recommend:* Kanon holds it, and the adopter keeps a test-only copy for its deploy tests. It is recorded as unshipped scaffolding.
10. **New: one hook with inputs, not one per lane.** *Recommend:* one. Per-lane hooks multiply the adopter's files, and the differences between lanes are already inputs.
11. **New: where workflow-level concurrency lives.** *Recommend:* top-level `concurrency:` in Kanon's lane workflow, if Kanon's smoke test proves the runner honours it in a called workflow (two dispatches must queue). Otherwise the calling job's `concurrency:`, with `lane-check` holding its text to Kanon's published value.
12. **New: the standard database.** It would be `pgvector/pgvector:pg17`, `kanon`/`kanon`/`kanon`, on port 5432. *Recommend:* yes. pgvector is a superset of plain Postgres, and port 5432 is Postgres's own.
13. **New: deliver the library to adopter-side code as the npm package `@yedeya-labs/kanon`.** That means guards run in the adopter's `lint` (spec, citation and path guards), and tests of not-yet-moved lanes. *Recommend:* yes. It is `K-ADOPT-11`'s guard form, and lanes still read the library only through `kanon-path`.
    - **Amended by the Owner, 2026-10-02: no npm package for now.**
      - **In the adopter,** lint guards and tests import the library from the `.kanon/` checkout that the adopter already makes at the pinned tag for its scanners (decision 15). There is one pin, the workflow tag, and Kanon's releases are immutable, so the checkout is as fixed as a package version would be.
      - **In Kanon,** the lanes read the library only through `actions/kanon-path`, as planned.
      - **Publishing to npm waits until an adopter needs a package.** `kanon apps` runs as `npx github:yedeya-labs/kanon#vX.Y.Z`.
      - **Why.** A package is a second release channel with its own version, registry account and publish step, to deliver files the adopter already checks out at exactly the right tag. Nothing yet needs what only a package gives.
14. **New: pin `claude-code-action` exactly in `agent-run`,** with Kanon's Dependabot proposing bumps. *Recommend:* yes. Without it, the CLI-flag test in Kanon's CI doesn't describe what an adopter runs.
15. **New: during the transition, the adopter's scanners read the blocks from a CI checkout of Kanon at the pinned tag,** instead of `lane-check` carrying rules that are deleted five steps later. *Recommend:* yes.
16. **New at step 4: what "anything the inputs delegate to" means, mechanically.** The review lane's restore closes `K-MERGE-17`'s list over the markdown documents the inputs link to (`[text](path)`) or import (`@path`), transitively, outside fenced blocks and never into the specs. Only markdown is followed: a link to source code points at the work under review. *Recommend:* keep it. On the reference adopter it pins 27 files today: 16 documents, 10 files under `.claude/` and the hook. Its own script pinned 10 documents. The 6 more are documents its instructions link to, `docs/observability.md` among them, which its tests read, so its test helper must read the set-aside copy for every pinned path, not only for the 10.
17. **New at step 4: who the review lane's actor is.** On a CI completion (`workflow_run`), whoever pushed the commit CI ran on; on `pull_request_target`, the sender of the label or of the opening. *Recommend:* yes. A non-member can't push to the repository, and the lane already refuses a fork's head.
18. **New at step 4: the review lane reads the adopter's CI from `.github/workflows/ci.yml`.** Its label path asks Actions about that file's runs for the head. *Recommend:* make it a fixed path in chapter 11, rather than a lane input (ADR 0002).
19. **New at step 4: the review caller's `run-name`.** A called workflow's `run-name` is ignored, and the review-run evidence reads the head SHA from the run's title, so the caller sets it and `lane-check` holds it to the lane's declared suffix. *Recommend:* yes.
20. **New at step 5: a schedule's actor.** The rebase lane's daily floor runs on `schedule`, which the membership gate refused as an event with no actor. GitHub runs a schedule as one user: whoever last changed its cron on the default branch, or changed the default branch (`GITHUB_ACTOR`). The gate now checks that user like a dispatch's. *Recommend:* yes. The alternative is a floor that never runs, or a schedule admitted without asking anyone.
21. **Decided by the Owner, 2026-10-02: option (a).** The crash job adds `qa:needs-split` with the Implementer's App token, narrowed to Issues write, and the label's own event starts the split lane through the gate. The crash comment and the other label edits stay on the workflow token, and the job's `actions` grant drops to read. Done in step 5's Kanon PR. The question as it was put:

    **New at step 5: the crash recovery's dispatch of the split lane is refused.** The implement lane's crash job starts the split lane with `gh workflow run` on the workflow token, because a label it adds on that token raises no event. That dispatch's actor is `github-actions[bot]`, which the gate refuses: it is a bot outside the App register. Neither App the lanes hold can take it over as it stands. The Implementer and the Lead hold no Actions write (chapter 03's roles table), and the job deliberately acts on the workflow token so that its comment never reads as the Implementer's. Until this is decided, an exhausted project item waits for the reconciler's one re-delivery on the Lead's token (`splitRecovery`, after the stall window), which also spends that re-delivery. *Options:*
    - (a) the crash job mints the Implementer's token for the `qa:needs-split` label alone, so the label's own event starts the split lane, and the dispatch goes;
    - (b) the gate admits `github-actions[bot]` on `workflow_dispatch` only, since only a workflow in the repository can raise it;
    - (c) accept the delay.

    *Recommended:* (a). It needs only the Issues write the Implementer already holds, and it is the route the dispatch sweep already takes on the Lead's token.
22. **New at step 5: a lane admits only its caller's triggers.** When a lane held its own `on:`, no other event could reach it. A called workflow runs on whatever its caller is called on, so the brief lane's filter now admits only a dispatch, and the rebase lane's only a finished CI run, its schedule or a dispatch. Kanon's lanes smoke calls them on pull requests, where a member's `opened` would otherwise pass the gate and mint a token. *Recommend:* yes. The other lanes already name their events in their filters.
