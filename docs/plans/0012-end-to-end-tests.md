# Plan 0012: end-to-end tests in throwaway repositories, and a release gate on them

- **Status:** decided 2026-10-14. Nothing in this plan is built. It starts right after the deploy lane ([plan 0010](0010-deployment-lane.md), [#610](https://github.com/yedeya-labs/kanon/issues/610)) is delivered. On 2026-10-14 the Owner took four decisions before the draft, then answered all seventeen of the draft's questions ([Owner decisions (2026-10-14)](#owner-decisions-2026-10-14)). Eight of the answers differ from the draft's recommendation (4, 6, 7, 8, 11, 14, 16 and 17). Two new decisions restructure the plan:
  - **the no-leak rule:** the tier adds no test-only switch to Kanon's product;
  - **the harness's home:** a separate repository in the test organisation, which tests Kanon from outside, as an adopter would, and reports its verdict on the candidate's commit.

  This revision is rewritten around them. The stubbed model, the `Agent replay`, `Run ceiling` and `Telemetry tag` choices, and every change to `agent-run`, doctor or the collector made for tests are gone. Kanon's own repository gains only the promotion gate's step and `init`'s pin fix. The rewrite raised five more questions, which the Owner answered the same day (decisions 18 to 22). Four went as recommended. One is changed: the harness repository installs Kanon's full pipeline, release lane included, and cuts its own releases (decision 20). The Reviewer's last pass found three places where the text couldn't hold as written, and they are fixed: a candidate poll that would start a run on top of one in flight, a red verdict that couldn't reach Kanon, and a token narrowing that needs `K-AGENT-50`'s job split to be real ([§5.2](#52-the-jobs-and-which-secret-each-holds)). Nothing is open ([Open questions](#open-questions)).
- **Tracks:** [#902](https://github.com/yedeya-labs/kanon/issues/902), whose Lead's brief is [PR #915](https://github.com/yedeya-labs/kanon/pull/915) (`docs/projects/902.md`); decisions 16 and 17 and the driver token's reach in [§11](#11-the-threat-model-stated-plainly) came from that brief. **Builds on:** [plan 0009](0009-release-channels-and-api-key.md) (candidates, `candidate-vX.Y.Z`, the promotion and its four gates, the pin job and `scripts/move-pins.mjs`, all in its steps S3 to S5, not built yet), [plan 0010](0010-deployment-lane.md) (its D0 probes, recorded in [#890](https://github.com/yedeya-labs/kanon/issues/890), and its D12 rehearsal, which becomes the harness's first scenario), [plan 0005](0005-lean-installation.md) (the Releaser, `kanon init`, `kanon doctor`) and [plan 0007](0007-guided-install.md) (the install's flags, which a script answers). **Same split as** plan 0010's placement decision: Kanon's deploy lives in the operator's repository, and Kanon's end-to-end harness lives in a repository of the test organisation. **Amends, once built:** plan 0009 §2 (a fifth promotion gate) and §6 (the pin job waits for the gate), plan 0010's D12 (rehearsed again on every candidate), [ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md) (Kanon's pins move only to a candidate the gate passed), and [`docs/release.md`](../release.md) ("Channels: candidates and stable"). **Offloads:** the harness itself, to the harness repository, as issues filed there ([§14](#14-order-of-moves)). **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), [ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), [ADR 0013](../decisions/0013-personal-accounts-and-two-apps.md), [ADR 0014](../decisions/0014-adopter-audiences.md) (the scenarios read `init` and `doctor` through their JSON), `K-ADOPT-11`, `K-SHIP-7`, `K-SHIP-9`, `K-MERGE-8`, `K-AGENT-47`, `K-AGENT-49`, `K-AGENT-50`, `K-OBS-12`, `K-SELF-7` and `K-PRIN-11` (every guard can fail, and is mutation-checked).
- **Measured on** Kanon's `origin/main` at `d9b7f2d` (v0.39.0 plus 117 commits):
  - the release flow: `.github/workflows/release.yml`, `release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`, `docs/release.md`, and plan 0009 §2, §3, §6 and §16;
  - the smoke workflows: `agent-lanes-smoke.yml`, `agent-blocks-smoke.yml`, `test-database-smoke.yml` and `judging-actions-smoke.yml`;
  - the fixtures and the suite's setup: `tests/fixtures/adopter/`, `tests/fixtures/lane-check/adopter/`, `tests/fixtures/python-adopter/` and `vitest.config.ts`;
  - the CLI: `cli/init.mjs`, `cli/callers.mjs`, `cli/doctor.mjs`, `cli/apps.mjs`, `docs/init.md`, `docs/doctor.md`, `requirements.json` (`features`) and `skills/upgrade/SKILL.md`;
  - the lanes: `actions/agent-run/action.yml`, `actions/agent-finish/action.yml`, `actions/agent-telemetry/action.yml` and `schema.mjs`, each model lane's `--max-budget-usd`, and `actions/lane-check/lane-check.mjs`;
  - the guards: the rulebook's `K-AGENT-49`, `tests/unit/app-key-isolation.test.ts` and `docs/qa/escalation-paths.md`.

  Plan 0010's D0 results were read from [#890](https://github.com/yedeya-labs/kanon/issues/890) on 2026-10-14. Kanon's release list was read with `gh release list` on 2026-10-14. The Owner's answers of 2026-10-14 were folded in with no new measurement, except a re-read of `docs/qa/escalation-paths.md` for [§11](#11-the-threat-model-stated-plainly). **GitHub's documentation was not read for this plan,** and no probe has run. Every platform behaviour the plan rests on is listed in [§12](#12-what-is-not-confirmed-and-how-each-is-handled), and E0 reads or probes each before the step that needs it.

## The plan in one paragraph

**Today.** Kanon's tests run inside Kanon's own repository. The unit and library suites stub `gh` and refuse the network (`vitest.config.ts`'s `stub-bin` and `offline` setup). The smoke workflows call every lane through `$/` with events each lane turns away and with secrets mapped to one that doesn't exist. They prove that the workflows resolve and their permissions fit, and they stop before any token is minted or any model is called. `lane-check` runs once, on a fixture adopter laid over the workspace. Nothing in Kanon installs Kanon into a second repository, runs `kanon doctor` against a real one, upgrades a real installation, or runs a lane end to end. The smoke workflows' own comments say what stands in for that: "the reference adopter's live run after each upgrade". Plan 0010's deploy lane will be rehearsed once, by hand, in a sandbox (its D12). Every probe Kanon has run on the platform, plan 0009's S0 and plan 0010's D0, was run by hand, and D0 could not run the Releaser's path because no App was installed there.

**Where it ends.**
- **A test organisation,** the Owner's, holding:
  - **the harness repository,** which holds the runner, the scenarios, the workflows and the driver App's key;
  - **throwaway scenario repositories,** created and deleted by the harness;
  - **a driver App,** which creates and deletes those repositories;
  - **test copies of the Author, the Judge and the Releaser.**

  All of these Apps are installed only there (Owner decisions 1 and 2, and the harness decision).
- **The harness tests Kanon from outside, as an adopter would** (the harness decision). It adopts Kanon's full pipeline itself, release lane included, and cuts its own releases, so a repository that lives for months exercises Kanon's releases, Dependabot's pin bumps and the upgrade path (decision 20). Its end-to-end runs still come from its `main`. Its runner's files are on its escalation paths as `always`, so agents propose a change and the Owner merges it (decision 17).
- **Kanon's product gains no test-only switch** (the no-leak rule). The only product change the tier needs is `init`'s pin fix (decision 5), which stands on its own for adopters.
- **A scenario is data:** a directory `scenarios/<scenario>/` in the harness repository. It holds a starting tree, the steps to take, from a fixed vocabulary, and what must then be true. The expectations are read through `kanon doctor --json`, `kanon init --json` and the GitHub API.
- **The runner** creates `e2e-<scenario>-<run id>-<attempt>` in the test organisation. It lays the starting tree, runs the steps, polls each expectation against a deadline, records the result, and deletes the repository. **A janitor** deletes any leftover older than a few hours.
- **Every scenario repository pins the release under test,** as an adopter does, so the scenario runs the candidate's released code, not a branch's.
- **Two tiers:**
  - **no model,** the bulk: install per feature, doctor clean and broken per finding family, upgrade from the last two stable releases, `lane-check`, the deploy lane end to end, and the gates' refusals;
  - **a real model,** at most two scenarios a run, under the $2 cap (decisions 4, 6, 7 and 15).
- **Triggers** (decision 4):
  - every candidate, found by a 15-minute poll of Kanon's public releases (decision 19), as the gate;
  - a nightly run, held unless Kanon's `main` changed since the last nightly run or no nightly run has happened in seven days;
  - a dispatch.

  Never per pull request.
- **A hard release gate** (Owner decision 3, decisions 1 and 2): a candidate is promoted to stable, and Kanon's own pins move to it, only once the harness has reported green on the candidate's commit. The harness reports it as a check run from a Reporter App installed only on Kanon, which Kanon's promotion reads (decision 18, [§8](#8-the-release-gate)). No quarantine and no override (decisions 11 and 12).

**How it gets there.**
- **The Owner's setup and the probes come first** (E0). The Owner creates the organisation, the harness repository and the Apps. A maintainer then probes the platform there, because the plan rests on behaviours nobody has measured: an App creating and deleting repositories, the Releaser's release approved by the Owner, the free plan's job and rate limits, and a check run authenticated by its App.
- **In Kanon:** `init`'s pin fix (E1), and later the gate step (E11), which needs plan 0009's candidates and promotion (S3 to S5).
- **In the harness repository, offloaded as issues:**
  - its own adoption of Kanon's full pipeline, its release lane and Dependabot entry (E2);
  - the scenario format, the runner and the workflows;
  - the first scenario, plan 0010's D12 rehearsal, so the harness pays for itself on its first run;
  - install per feature and upgrade from the previous releases;
  - the verdict and its report;
  - then the doctor-broken families and the real-model tier, each joining the gate after a burn-in;
  - and the long-lived upgrade signal, which reads whether the harness itself keeps up with Kanon's stable releases (E14).

## 1. Today, measured

| What | Where | What it means for this plan |
|---|---|---|
| A Kanon release is cut when the release pull request merges: release-please tags `vX.Y.Z` and publishes the Release. With the Releaser's secrets mapped, the release PR runs CI and the tag triggers tag-driven workflows | `release.yml` (its header and steps), `release-please.yml`, [`docs/release.md`](../release.md) | Nothing in the release path runs anything outside Kanon's repository, and no workflow in Kanon can start one in another repository without a credential for it ([§7](#7-triggers)) |
| Candidates are decided but not built. Plan 0009's steps: <ul><li>S3: the release PR's merge tags `candidate-vX.Y.Z` as a GitHub pre-release;</li><li>S4: the pin job moves Kanon's own pins to the candidate;</li><li>S5: a daily `promote.yml` tags `vX.Y.Z` on the same commit when four gates pass (soak, no revert, no serious bug, no unexplained red).</li></ul> | plan 0009 §2, §3, §6, §16; `docs/release.md`, "Channels" ("Partly built") | The gate hooks into S4 and S5 ([§8](#8-the-release-gate)). None of the four gates reads anything run outside Kanon |
| No Kanon release since v0.39.0 (2026-10-11); `main` is 117 commits past it | `gh release list`, `git rev-list` | The first gated release is not the next one: S3 to S5 come first |
| `agent-lanes-smoke.yml` calls the 20 lanes with events each turns away, and maps every secret to `KANON_SMOKE_UNSET`. It then runs the membership gate on one label event, and `lane-check` on a fixture laid over the workspace | `.github/workflows/agent-lanes-smoke.yml` | It proves resolution, inputs and permission ceilings, on every pull request. It can't prove a mint, a model call, a posted verdict or a merge, and says so: "The model call is proven by the reference adopter's live run after each upgrade" |
| The other smoke workflows run the blocks, the test-database hook and the judging actions inside Kanon's own runner, on fixtures | `agent-blocks-smoke.yml`, `test-database-smoke.yml`, `judging-actions-smoke.yml` | Same boundary: one repository, no second installation |
| The fixture adopters are trees, not repositories: <ul><li>`tests/fixtures/adopter/`: an adoption record and its declarations, and one script;</li><li>`tests/fixtures/lane-check/adopter/`: callers;</li><li>`tests/fixtures/python-adopter/`: a Python project.</li></ul> | `tests/fixtures/` | They are the natural starting trees for the first scenarios, copied into the harness at the release they come from |
| The unit and library suites stub `gh` and refuse the network | `vitest.config.ts` (`stub-bin`, `offline`) | The tier can't live in Kanon's `vitest run`. It lives in the harness repository's workflows |
| `kanon init --json` prints `kanon-init/v1`. `--yes`, `--feature review\|build\|full`, `--no-apps` and `--dry-run` let a script drive it. `status` is `complete`, `steps-left`, `failed` or `error` | `cli/init.mjs`, [`docs/init.md`](../init.md) | A scenario can install without a person, and read the outcome from one document |
| `kanon doctor --json` prints `kanon-doctor/v1`, with `status`, `exitCode` (0 healthy, 1 findings, 3 error, 4 incomplete), `findings[].id` from a fixed table, `unchecked` and `releases` | `cli/doctor.mjs`, [`docs/doctor.md`](../doctor.md) | Doctor is the oracle for every install, doctor and upgrade scenario: an expectation names finding ids, never prose |
| `init` pins `v` plus `package.json`'s version (`kanonRelease` in `cli/callers.mjs`). At a candidate's commit that is `vX.Y.Z`, a tag that exists only after promotion. Plan 0009 §6 says the docs carry the same gap | `cli/callers.mjs`, plan 0009 §6 | **An install run from a candidate writes callers pinned to a tag that doesn't exist yet,** for an adopter running ahead as much as for a scenario. Decision 5 fixes it in the product, E1 |
| Doctor counts only the repository's own secrets: "an organisation secret shared with the repository isn't counted" | `cli/doctor.mjs`, `docs/doctor.md` | The test Apps' keys go into each scenario repository's own secrets (decision 10) |
| `kanon apps --reuse <app>:<slug>@<id>=<key file>` adds an existing App to a repository, reading its key from a file | `cli/apps.mjs` | The harness writes the register rows without a key, and the secrets with `gh`, so no job that runs code holds a key ([§5.2](#52-the-jobs-and-which-secret-each-holds)) |
| `agent-run` always runs `claude-code-action`. It has no stub, dry run or replay | `actions/agent-run/action.yml` | **None is added** (the no-leak rule, decision 6). A model lane is tested only by a real-model scenario |
| Every model lane fixes its own `--max-budget-usd`, and no lane takes a lower ceiling from its caller. The ceilings: <ul><li>$10: the two digests and the Explorer's telemetry mode;</li><li>$15: the merge reconcile;</li><li>$25: the Explorer and verify-acs;</li><li>$30: the Reviewer;</li><li>$35: the Overseer and the Lead's split;</li><li>$40: triage, the Lead's revise and the code audit;</li><li>$50: the Lead and the rebase;</li><li>$120: the Implementer and its revise.</li></ul> | each lane's agent job | **One lane run can cost more than the tier's $2 cap.** Under decision 7, the lane's own ceiling is the hard bound on one run. The ledger only refuses to start a run that could pass the cap, so the $2 is held per run softly, and the month is held hard by the key's spend limit ([§6.2](#62-a-real-model-under-2)). A per-run hard cap comes only as an adopter feature, judged on its own merit ([#891](https://github.com/yedeya-labs/kanon/issues/891)) |
| A row's `tag` is `run`, `smoke` or `test`; every read and aggregate filters on `run` | `actions/agent-telemetry/schema.mjs` (`TAGS`) | Unused by this plan: the scenario repositories send no telemetry (decision 8). The collector's path stays covered by its own tests |
| `docs/qa/escalation-paths.md` puts `cli/` and most of `scripts/` in the green zone, which the Merger may merge | `docs/qa/escalation-paths.md` | Kanon's CLI, run by the harness with a driver token, is code a green-zone merge can change. So it runs only in a job of its own, on a narrowed token ([§5.2](#52-the-jobs-and-which-secret-each-holds), [§11](#11-the-threat-model-stated-plainly), decision 22) |
| The upgrade skill runs a model. Its mechanical edit (every `yedeya-labs/kanon` ref under `.github/` and the plugin's `ref`) becomes `scripts/move-pins.mjs` in plan 0009 S4 | `skills/upgrade/SKILL.md` step 4; plan 0009 §6 | An upgrade scenario runs `doctor --to`, the script's edit at the release under test, and doctor again. It never runs the skill |
| Plan 0009 S0 and plan 0010 D0 were run by hand, in sandboxes. D0 ([#890](https://github.com/yedeya-labs/kanon/issues/890)) found: <ul><li>required reviewers offered only once the sandbox was public;</li><li>a rejection concluding as a plain `failure` (read the run's approvals to tell it apart);</li><li>a release published by a maintainer can't be approved by that maintainer.</li></ul> **The Releaser's case was not measured: the Apps are uninstalled there** | #890; plan 0009 §16, S0 | The test organisation's repositories are public (Owner decision 1), and the test Releaser makes the unmeasured path a scenario (Owner decision 2) |
| Plan 0010's D12 rehearses the released lane once, by a maintainer, in the D0 sandbox, with trivial hooks, two environments and no AWS, before the operator's repository adopts it | plan 0010 §18, D12 | Its checks are the first scenario's expectations, word for word ([§9](#9-the-first-scenarios)) |

**What this adds up to.** Every behaviour that only shows when Kanon is installed in a second repository is first seen by an adopter:
- an `init` that writes a caller pinned to a tag that doesn't exist;
- a doctor finding that fires on a healthy repository;
- an upgrade whose caller changes nobody listed;
- a lane whose mint works on Kanon and not on a fresh install.

The plan moves that first sighting into repositories the Owner holds, on every candidate, before any adopter's Dependabot proposes it, and without teaching Kanon's product anything about being tested.

## 2. What the tier is, and what it is not

**It is** a test of Kanon as an adopter meets it: a fresh repository, the release's own callers, the release's own CLI, real Apps with real permissions, GitHub's real events, and doctor's verdict at the end. It tests what the unit suites can't:
- **the platform's answers:** eventual consistency, permissions, rulesets, environments, and events fired by an App rather than by the workflow token;
- **the joins between Kanon's parts:** `init` writes what `lane-check` accepts and doctor calls healthy; a lane's mint, setup, run, finish and recorded row happen in one run.

**It is Kanon-specific, not a Kanon feature** (the no-leak rule). Nothing in Kanon's product knows the tier exists:
- no input, choice, marker or mode is added for it;
- no lane, doctor check or collector behaves differently in a scenario repository;
- the harness reaches Kanon only through what any adopter uses: its releases, its CLI and its callers.

A product change the tier needs must stand on its own for adopters, as `init`'s pin fix does.

**It is not:**
- **a replacement for the unit and library suites,** which stay the place for every branch of every script, with their mutations. A scenario covers a path, not its edge cases;
- **a per-pull-request check.** A pull request's code is not a release, a scenario repository can only pin a release, and a run takes minutes to an hour ([§7](#7-triggers));
- **a test of the model's judgement.** The real-model tier checks that a lane ran, posted and recorded under its ceiling, not that its verdict was right ([§6.2](#62-a-real-model-under-2));
- **a test of an adopter's stack.** A scenario's hooks are trivial on purpose, as D12's are.

## 3. The test organisation, the harness repository and the Apps

**The organisation.** It is the Owner's, created for this and nothing else (Owner decision 1). "The test organisation" in this plan is its name until it exists. Its repositories are **public**:
- GitHub's free plan offers environment reviewers only on public repositories, as D0 measured;
- rulesets and free Actions minutes are expected there too, but not yet confirmed ([§12](#12-what-is-not-confirmed-and-how-each-is-handled), items 6 and 11).

**The harness repository** (the harness decision). "The harness repository" is its name until the Owner chooses one at E0. It holds:
- the runner, the scenarios, the workflows and the janitor;
- three protected environments, each admitting only its default branch:
  - **`e2e`:** the driver App's key and the test Apps' keys;
  - **`e2e-model`:** only the real-model API key;
  - **`e2e-report`:** only the Reporter App's key.

**It adopts Kanon's full pipeline, like any adopter** (decisions 17 and 20):
- **The install.** It runs `kanon init --feature full` at a stable release, with the test Releaser and Kanon's release workflow.
- **Its own releases.** It cuts releases through Kanon's release lane, and Dependabot proposes each stable Kanon release to it. The Owner's criterion: it releases only because that adds coverage. A repository that lives for months exercises a run of releases, Dependabot's pin bumps and the upgrade path, which throwaway repositories can't.
- **Where the e2e runs come from.** They still run from the harness's `main`, not from its releases, so a fix to the harness reaches the gate at once.
- **Who merges.** Its runner's files are on its escalation paths as `always`, so agents propose a change and the Owner merges every change that touches what runs with the driver key (decision 17). That is Kanon dogfooded on a second repository.
- **Its lanes** run as the test Apps, on the Owner's subscription token, as Kanon's own lanes do (decision 21). So its own agent runs never spend the e2e tier's budget.

**The Apps:**
- **The driver App.** Created by the Owner, owned by the test organisation, and **installed only there,** on all its repositories. It is the only identity the runner acts as. Its permissions are Owner decision 1's, each read and write: create and delete repositories, Administration, Contents, Actions, Environments, Workflows, Issues and Pull requests. Decision 14 adds two more: Secrets (write), and the organisation's Administration (read), so doctor's `unused-apps` and private-Releaser checks run in a scenario rather than being listed as `unchecked`.
- **Test copies of the Author, the Judge and the Releaser.** Created by the Owner with the manifests `kanon apps` uses, owned by the test organisation, and installed only there, on all its repositories (Owner decision 2). A scenario therefore exercises the persona permissions an adopter's Apps hold. That includes the path D0 could not measure: **the Releaser publishes a release, and the Owner approves its environment** ([§9](#9-the-first-scenarios)).
- **The Reporter App, new** (decision 18). It is the one identity that posts the harness's verdict on Kanon's commit, and it is the only App this plan installs on Kanon ([§8.2](#82-what-the-gate-reads)):
  - created by the Owner, owned by `yedeya-labs`, private, and installed only on Kanon's repository;
  - one permission, Checks (write);
  - its key lives in the harness repository's `e2e-report` environment.

**Nothing in the test organisation is ever an adopter's.** Kanon's real Apps are never installed there, and the test Apps never anywhere else, so a test App's key can reach only throwaway repositories and the harness itself.

**What it costs the Owner:**
- **one-time setup:**
  - the organisation and the harness repository;
  - five Apps: the driver, the three test personas and the Reporter;
  - the harness's three environments and their secrets;
  - a real-model API key in Kanon's existing Console workspace (decision 16);
- **membership of the organisation,** so the Owner can be the required reviewer a deploy scenario waits for (decision 9);
- **merging every change to the harness's runner** (decision 17).

## 4. A scenario is data

### 4.1 The directory

In the harness repository:

```
scenarios/<scenario>/
  scenario.json     what the scenario is, below
  start/            the tree laid down as the repository's first commit
  steps.json        up to three phases, each a `kanon` segment then an `act` segment of verbs (§4.2, §5.2)
```

`scenario.json`:

| Field | Meaning |
|---|---|
| `id` | The directory's name: lowercase, digits and hyphens, at most 40 characters, so the repository's name fits. |
| `family` | `lane`, `install`, `doctor`, `upgrade` or `deploy`. |
| `tier` | `none` or `model` ([§6](#6-two-tiers)). |
| `gate` | Whether it counts toward the release gate. A new scenario starts `false`. It turns `true` in a pull request once it has passed ten consecutive scheduled runs ([§10](#10-flakiness)). Once `true`, it is never set aside: a broken gating scenario blocks releases until it is fixed (decision 11). |
| `apps` | The test Apps the scenario repository gets: any of `author`, `judge`, `releaser`. |
| `claude` | `none` or `api-key`: whether the scenario repository needs the real-model key. With `api-key`, the `model-key` job writes it ([§5.2](#52-the-jobs-and-which-secret-each-holds)). |
| `deadlineMinutes` | The whole scenario's deadline, at most 120. |

`start/` is copied as it is, with two substitutions and no others:
- `{{release}}`: the release under test, `candidate-vX.Y.Z` or `vX.Y.Z`;
- `{{repository}}`: the scenario repository's `<owner>/<name>`.

Nothing in `start/` runs on the harness's runner. It is data that becomes the scenario repository's tree, and its hooks run only in the scenario repository's own Actions.

### 4.2 The step vocabulary

The vocabulary is a closed set. Each verb is implemented once in the harness, with its own unit test against a stubbed `gh`. **Each verb belongs to one kind of segment** ([§5.2](#52-the-jobs-and-which-secret-each-holds)): the `kanon.*`, `register.write` and `pins.move` verbs run Kanon's code and belong only in a `kanon` segment; every verb that writes to GitHub with the harness's own code belongs only in an `act` segment; the `expect.*` and `run.await` verbs, which only read, may sit in either. The validator refuses a verb in the wrong kind of segment. A scenario that needs another verb adds it in a pull request, with its test. Every verb that waits takes a `deadline` in minutes, and polls ([§10](#10-flakiness)). Every verb that runs Kanon's code runs it at the release under test, fetched as an adopter fetches it (`npx --yes --package github:yedeya-labs/kanon#<release> kanon …`), in a `kanon` job, on that job's narrowed token ([§5.2](#52-the-jobs-and-which-secret-each-holds)).

| Verb | What it does |
|---|---|
| `kanon.init` | Runs `kanon init --json --yes --no-apps` with the given flags (`--feature`, `--review-trigger`, `--sensitive-data`, …) against a clone of the scenario repository, with telemetry and sharing declined (decision 8). The CLI writes only to the clone; the next `act` job pushes it. The document is kept for `expect.init`. |
| `kanon.doctor` | Runs `kanon doctor --json`, optionally `--to <release>`, from a clone of the default branch, and keeps the document. |
| `kanon.at` | Runs `init` or `doctor` at another release (`previous`, `previous-1`, or a tag): the upgrade scenarios' starting point. |
| `register.write` | Writes the App register's rows for the scenario's test Apps, through the library `kanon apps` writes them with, without a key ([§5.2](#52-the-jobs-and-which-secret-each-holds)). |
| `pins.move` | Runs Kanon's `scripts/move-pins.mjs` (plan 0009 S4), at the release under test, to that release. It is the upgrade skill's edit, without the skill. |
| `files.commit` | Commits files from the scenario's directory, or the clone the `kanon` segment left, or deletes paths, on a branch or the default branch. |
| `pr.open`, `pr.label`, `pr.merge` | Opens a pull request from a branch, adds or removes a label, or merges it. A merge goes through the front door, or as the driver where the ruleset lets a bypass actor through, which the scenario says. |
| `issue.open`, `issue.label` | Opens an issue, adds a label. |
| `workflow.dispatch` | Dispatches a workflow, such as `apps-check` before doctor. |
| `release.cut` | Merges the scenario repository's release pull request, and waits for the Release the test Releaser publishes. |
| `deployment.await-approval` | Waits until an environment's job is `waiting`. Then it either cancels the run (nightly), or files the Owner's approval request in the harness repository and waits for the Owner's decision (a candidate's run, decision 9). |
| `run.await` | Waits for a workflow's run on a given event and commit to complete. |
| `expect.init`, `expect.doctor` | Holds the kept document to a status, an exit code, finding ids present and absent, and the `unchecked` checks allowed. |
| `expect.run` | Holds a run to its conclusion and its jobs' names and conclusions. |
| `expect.check` | Holds a commit's check run or status to a name and a conclusion. |
| `expect.issue`, `expect.pr` | Holds an issue or a pull request to its state, labels, author's App slug, and a marker in a comment. |
| `expect.artifact` | Holds a run's artifact to its name. Used for a model lane's recorded row, which the lane uploads whether or not the repository sends telemetry. |
| `expect.api` | Holds one GET of the scenario repository's own API (a path under `repos/<the scenario repository>/`) to a JSON value at a pointer. The validator refuses any other path. |

### 4.3 What a scenario may expect

Expectations are read in this order:
1. **Through doctor's and `init`'s JSON first** (ADR 0014): a finding id, a status, an exit code, an `unchecked` check.
2. **Through the GitHub API second,** and only for what doctor doesn't report: a run's jobs, a check's conclusion, an issue's labels, a pull request's author, an artifact's name.
3. **Never through prose.** No expectation reads a message, a log line or a comment's wording. It reads only a field, or a marker Kanon already writes for its own reasons, such as the release-PR guard's `<!-- kanon-release-pr-guard … -->` or the Reviewer's role marker.

**No marker is added for the tests** (the no-leak rule). A scenario's expectations are therefore as stable as the contracts they read, and a contract change shows up as a failing scenario on the candidate that makes it.

**Doctor's `unchecked` is explicit.** A check the driver's token can't run (E0 measures which) is listed in the scenario's `expect.doctor` as allowed. Anything else unchecked fails the expectation, so "incomplete" can never pass for "healthy" by accident.

## 5. The runner and the janitor

All of this lives in the harness repository (the harness decision). Kanon's repository holds none of it.

### 5.1 One scenario's life

1. **Name.** `e2e-<scenario>-<run id>-<attempt>`, at most 100 characters. The run id makes it unique across concurrent runs; the attempt across a re-run.
2. **Create** a public repository in the test organisation with the driver's token. It gets the topic `kanon-e2e` and a description naming the harness run that made it.
3. **Provision** the repository, as [§5.2](#52-the-jobs-and-which-secret-each-holds) says:
   - the `provision` job writes the scenario's App secrets;
   - for `claude: api-key`, the `model-key` job writes the real-model key;
   - the organisation member who reviews its environments is set.
4. **Lay** `start/` as the first commit of the default branch.
5. **Run** `steps.json` in order. A step that fails stops the scenario.
6. **Classify** the result:
   - `pass`;
   - `fail`: an expectation was false, or a deadline passed;
   - `infra`: an infrastructure error the runner classified and retried, still failing ([§10](#10-flakiness)).
7. **Delete** the repository, always on `pass` and `infra`. On `fail`, mark it with the topic `kanon-e2e-failed`, archive it, and leave it for 24 hours so its runs can be read (decision 13).
8. **Report** one JSON result, `kanon-e2e-result/v1`, uploaded as an artifact and written to the step summary. It holds the scenario, the release, the result, each step's duration and outcome, the first false expectation, and the repository's name.

### 5.2 The jobs, and which secret each holds

The harness repository's workflows follow `K-AGENT-49` as Kanon's `tests/unit/app-key-isolation.test.ts` holds it for the lanes. The harness's own workflow test copies those assertions, because Kanon's test reads only Kanon's workflows. Two rules:
- **No job that runs code holds a private key.**
- **Each job that runs code with the driver's token gets it from a mint of its own,** in the lanes' three levels:
  1. a job in the calling workflow calls a `-run` workflow;
  2. the `-run` workflow holds exactly two jobs: `mint`, and a call of a `-job` workflow that `needs: mint` and receives the sealed token through that call's `secrets:`;
  3. the `-job` workflow is one job. It declares the token as its `app-token` secret, runs the spine's receive step first (masked before any output, a stale attempt refused), does its work, and runs the spine's revoke last, under `always()`.

**No minted token is ever handed to two jobs.** One consumer revoking it would cut the other off, and not revoking it breaks the rule.

**The matrix and any concurrency sit on the level-1 call,** never inside the pair. So the mint waits with the job it serves, and never mints a token a wait could outlive.

**Each mint and each key-reading job declares its environment and reads its key itself.** A job that calls a reusable workflow can't declare an environment, so it can't read one for the job it calls ([§12](#12-what-is-not-confirmed-and-how-each-is-handled) item 12). Environment secrets' names take no hyphen.

**Kanon's code runs in a job of its own** (`K-AGENT-50`, decision 22). Inside one job, step order is not a boundary: a token in a job is reachable from any code that job runs. Kanon's CLI and scripts at the release under test are code a green-zone merge in Kanon can change ([§1](#1-today-measured)). So a scenario phase is two jobs, never one:
- **a `kanon` job** runs only the `kanon` segment's verbs. Its token is scoped to the one scenario repository, with **no Workflows, no Secrets and no Contents write**: Contents (read), Issues (write), Administration (write), Actions (read), Pull requests (read). That is what `init` and doctor need against GitHub: labels, milestones, the ruleset and the merge settings, and reads. Everything the CLI writes goes to the local clone, which crosses to the next job as an artifact.
- **an `act` job** runs only the harness's own verbs, from the harness's `main`. It never runs Kanon's code. Its token is scoped to the same repository, with Contents, Workflows, Issues, Pull requests, Actions and Administration (write). It pushes the clone the `kanon` job left, as written, and does the steps that write through the harness's own code (opening and merging pull requests, cutting a release, waiting for an approval).

`.github/workflows/e2e.yml`, with `concurrency: { group: e2e-${{ the release under test }}, cancel-in-progress: false }`, so a second run for the same release waits for the first, and then stops at `plan` if the first posted a check run that needs no re-run ([§7](#7-triggers)):

| Job | Holds | Runs |
|---|---|---|
| `plan` | nothing | Reads Kanon's releases and `main` (public), decides whether this run goes ahead ([§7](#7-triggers)), picks the release under test and the scenarios for the trigger and tier. It writes two outputs: `scenarios`, the matrix of every scenario, and `model-scenarios`, those with `claude: api-key` (`[]` when there are none). |
| `start` | `needs: plan`; only on a candidate's run. In the `e2e-report` environment: the Reporter App's key, nothing else | Mints the Reporter's token for Kanon's repository and creates the check run `kanon-e2e` on the candidate's commit, `in_progress`, with this run's id as its `external_id`. It outputs the check run's id. **The token action and `gh` alone.** From this moment the poll sees the candidate as taken. |
| `provision` | Matrix entry per scenario; `fail-fast: false`; `timeout-minutes: 10`. In the `e2e` environment: the driver App's key and the test Apps' keys, and no Claude credential | Mints its **own** driver token, scoped to the new repository, with `actions/create-github-app-token`. Creates the repository, and writes each App's id and key with `gh secret set`. Its last step adds the topic `kanon-e2e-provisioned` with `gh repo edit --add-topic`. **No checkout, no `npx`, no script: the token action and `gh` alone.** That is the shape Kanon's guard already accepts for `apps-check.yml`'s `check`. |
| `model-key` | Matrix over `model-scenarios`; `fail-fast: false`; `needs: [plan, provision]`; `if: ${{ !cancelled() && needs.plan.outputs.model-scenarios != '[]' }}`. Holds nothing | Calls `e2e-model-key-run.yml`. Why its `if:` has both parts: <ul><li>`!cancelled()`: an `if:` without a status function is read as `success() && …`, and a needed matrix job counts as failed when any one entry failed;</li><li>the non-empty test: an empty matrix is an error, not a skip.</li></ul> |
| `kanon-1`, `act-1`, `kanon-2`, `act-2`, `kanon-3`, `act-3` | Each a matrix entry per scenario; `fail-fast: false`; `if: ${{ !cancelled() }}`. Hold nothing | Each `kanon-N` calls `e2e-kanon-run.yml`, each `act-N` calls `e2e-act-run.yml`. Their `needs:`: <ul><li>`kanon-1`: `[plan, provision, model-key]`;</li><li>`act-N`: `[plan, kanon-N]`;</li><li>`kanon-2`: `[plan, act-1]`, and `kanon-3`: `[plan, act-2]`.</li></ul> |
| `verdict` | `needs:` the six phase jobs; `if: ${{ !cancelled() }}`. Holds nothing beyond `issues: write` on the harness repository | Reads every scenario's result artifact, writes the summary table, decides the gate's answer ([§8.2](#82-what-the-gate-reads)), files or closes the red issue in the harness repository ([§8.3](#83-a-red-gate-how-it-is-reported-and-the-only-way-past-it)), and uploads `verdict.json`: `pass`, `fail` or `infra-only`. **It then exits non-zero unless the answer is `pass`,** so the harness run concludes `success` only when the verdict is green. |
| `report` | `needs: [start, verdict]`; `if: ${{ always() && needs.start.result == 'success' }}`. In the `e2e-report` environment: the Reporter App's key, nothing else | Downloads `verdict.json` with `gh run download`, mints the Reporter's token, and completes the check run `start` created: `success` for `pass`, `failure` for `fail`, and `neutral` for `infra-only` or for a missing `verdict.json` (the run was cancelled or broke before judging). The summary links this run and the red issue. **The token action and `gh` alone** (decision 18). Its `if:` makes it post on red, on `infra` and on a cancelled run too, so no candidate is left `in_progress`. |

The pairs. Each `-run` workflow holds exactly `mint` and its call; each `-job` workflow is one job.

| Pair | `mint` | The `-job` workflow's one job |
|---|---|---|
| `e2e-kanon-run.yml` → `e2e-kanon-job.yml` | Declares `environment: e2e` and reads the driver's id and key from it. Runs `actions/create-github-app-token` with `skip-token-revoke`, scoped to the one scenario repository and narrowed to the `kanon` job's permissions above, and the spine's seal. No `needs:`, no `if:`; `timeout-minutes: 5` | `timeout-minutes: 20`. Receive; download the previous `act` job's clone; run the harness's runner for one `kanon` segment, which fetches and runs Kanon's code; upload the clone and the state; revoke. It never holds a key. |
| `e2e-act-run.yml` → `e2e-act-job.yml` | As above, with the `act` job's permissions | `timeout-minutes: 30`. Receive; check out the harness at its default branch; download the `kanon` job's clone and state; run the runner for one `act` segment; upload the state; revoke. **It runs no code of Kanon's:** the harness's workflow test refuses `npx`, a `kanon` command or a module from Kanon's tree in it. |
| `e2e-janitor-run.yml` → `e2e-janitor-job.yml`, called hourly by `e2e-janitor.yml` | As above, unscoped, because it lists every repository | Receive; check out the harness at its default branch; run the janitor; revoke. |
| `e2e-model-key-run.yml` → `e2e-model-key-job.yml` | As above, scoped to the one scenario repository | `timeout-minutes: 5`. Declares `environment: e2e-model` and reads only the key from it. Receive; one `gh secret set ANTHROPIC_API_KEY` into the scenario repository, reading the key from that step's `env:`; revoke. No checkout, no other `uses:`. The harness's workflow test holds this job to exactly those steps. |

**Phases are fixed at three, each a `kanon` job and then an `act` job.**
- **Why:** a matrix runs its entries in no order, so a scenario's phases can't be entries of one matrix; and Kanon's code and the harness's wide token must never share a job. A scenario's `steps.json` names its segments; the validator refuses one that needs more than three phases, and a verb in the wrong kind of segment.
- **Timing:**
  - a `kanon` job lasts at most 20 minutes and an `act` job at most 30, each under a token's hour;
  - a scenario's steps may take at most 120 minutes of the 150 the three phases give;
  - the token's hour counts from the mint, so a queue between a mint and its job spends it too. A token that expires that way fails a call, which the runner reports as `infra`, never as `pass`.
- **Exit status:** a runner that finishes exits 0 whatever the scenario's result, which is in its artifact. So one scenario's `fail` never stops another's phases. `verdict` is the one job whose exit carries the result into the run's conclusion.
- **A failure before the steps is `infra`, not `fail`.** The runner reports `infra` when:
  - the repository lacks the `kanon-e2e-provisioned` topic;
  - a `claude: api-key` scenario's repository lacks the key's secret;
  - the repository is already gone.
- **A repository's running time** is at most about three hours: three 50-minute phases, plus at most 45 minutes of `provision`, the `model-key` pair and the six mints. **Queueing is bounded by nothing,** since a timeout counts from a job's start. The janitor's extra hour absorbs it. E13 measures both.

**Why `register.write` and not `kanon apps --reuse`.** `--reuse` reads the App's key from a file, so the job that runs it would hold a key and run Kanon's CLI. So the register's rows are written without a key, and the secrets by `provision`'s `gh`. What this leaves untested end to end is `--reuse`'s key check, which its unit tests in Kanon keep.

### 5.3 The janitor

`e2e-janitor.yml` runs hourly and on dispatch, through its own pair ([§5.2](#52-the-jobs-and-which-secret-each-holds)). It lists the test organisation's repositories, and deletes each one that:
- carries the topic `kanon-e2e`, **and**
- was created more than 4 hours ago (a repository's longest life, a little over three hours, plus an hour), or, with the topic `kanon-e2e-failed`, more than 28 hours ago.

It never deletes a repository without the topic, and never the harness repository. It writes each deletion, and each repository it left, to its summary. A repository older than a day that it couldn't delete fails its run, so a leak is red within the hour rather than found later.

## 6. Two tiers

There is no stubbed tier (decision 6). Faking the model would need a switch in `agent-run` that adopters would carry, which the no-leak rule excludes. A model lane's wiring is proven only by the few real-model scenarios; the no-model scenarios cover everything else.

### 6.1 No model

The bulk, and every scenario of the gate's first version. Each scenario is a repository, a few `kanon` commands, a few events, and doctor's verdict. The catalogue's first scenarios are [§9](#9-the-first-scenarios)'s. The families grow to:
- **install:** one scenario per feature in `requirements.json`'s `features` (`review`, `build`, `full`), and one with the Python fixture as the starting tree. Each runs `kanon.init`, `register.write`, `workflow.dispatch apps-check` and `kanon.doctor`, then `expect.doctor` healthy;
- **doctor broken:** one scenario per finding category of `docs/doctor.md` (`pin`, `app`, `secret`, `declaration`, `caller`, `label`, `ruleset`, `id-token`, and `deploy` once plan 0010 ships it). Each starts from a clean install and breaks one thing: a secret deleted, a caller's grant narrowed, a label removed, or a ruleset rule switched off. It expects **exactly** that finding id, and no other blocking one;
- **upgrade,** from each of the last two stable releases: `kanon.at previous` installs, `kanon.doctor --to` lists, `pins.move` moves, the steps the findings name are committed, and `expect.doctor` is healthy at the release under test;
- **`lane-check`:** a pull request that changes a caller wrongly (an inexact pin, `secrets: inherit`) gets `Lane check` red, and a correct one gets it green;
- **gate refusals,** the lanes' own admission rules on real events:
  - a label applied by an identity outside the register starts nothing;
  - the Merger refuses a pull request with no verdict;
  - plan 0010's deploy gate refuses a release whose CI is red;
- **deploy:** the rehearsal ([§9](#9-the-first-scenarios)).

### 6.2 A real model, under $2

**The cap is the Owner's** (Owner decision 4): $2 for a run of the tier, nightly or on a candidate. How it holds (decision 7, changed):
1. **The lane's own ceiling bounds one run.** It is the hard bound per run, and it is $10 or more for every model lane ([§1](#1-today-measured)). No choice lowers it for the tests (the no-leak rule). A per-run hard cap comes only as the adopter feature [#891](https://github.com/yedeya-labs/kanon/issues/891) describes, judged on its own merit.
2. **The runner's ledger holds the $2 softly.** Before it starts a real-model scenario, the runner adds the scenario's expected cost to what this run's real-model scenarios have already spent.
   - The expected cost is the largest cost the scenario's last ten runs recorded, read from their result artifacts, times 1.5.
   - If the sum could pass $2, it refuses to start the scenario and reports `skipped: budget`.
   - Until a scenario has a recorded run, its first one is a dispatch the Owner starts, with nothing else running against the cap.
   - It is soft because a run that goes past its history can still spend up to its lane's ceiling, $30 for the Reviewer. The plan says so rather than calling it hard.
3. **The key's monthly spend limit holds the month hard.** The key lives in Kanon's existing Console workspace and shares its spend limit (decision 16, changed). So the tier's spend counts against the same limit Kanon's own lanes draw on, and a leak of the key spends Kanon's own workspace ([§11](#11-the-threat-model-stated-plainly)).

**What the tier runs:** at most two scenarios a run (decision 15). It starts with the review lane on a one-line documentation pull request in a fresh install. Expectations are model-independent (decision 11):
- the run completed;
- a verdict of either kind was posted by the test Judge, read by its role marker;
- the run's telemetry artifact was uploaded (the lane records its row whether or not the repository sends it);
- the row's cost is under the lane's ceiling.

A run classified `unavailable` (the model was never reached, plan 0009 §2) is `infra`, which is retried, not failed.

**No telemetry is sent** (decision 8, changed). The scenario repositories decline sharing and install no collector, so no test row reaches the hosted store. The collector's end-to-end path stays covered by its own tests.

## 7. Triggers

| Trigger | Runs | Against |
|---|---|---|
| **A new candidate** (decision 19): the harness polls Kanon's public releases every 15 minutes. It runs for a `candidate-vX.Y.Z` pre-release whose commit has no `kanon-e2e` check run from the Reporter, or whose latest one completed `neutral` (not judged) more than an hour ago, at most six times for one candidate. A check run `in_progress` means a run is in flight, and the poll leaves the candidate alone | every `none` scenario, and the real-model tier under its cap | the candidate: every scenario repository pins it, and every Kanon command runs at it |
| **Nightly** (decision 4, changed): scheduled once a night, and **held** unless Kanon's `main` head differs from the head the last nightly recorded, or no nightly has run in seven days | the same, against the latest candidate (or the latest stable release when no candidate is newer). Also the install and doctor families with the CLI at `main`'s head commit, pinning the release its `package.json` names. Those are `claude: none` scenarios, so unreleased Kanon code never runs in a repository that holds the real-model key | the seven-day floor catches the platform's drift in a quiet week |
| **Dispatch,** with a scenario id or a family, and a release | the named scenarios | the given release |
| A pull request, the merge queue, or a push to Kanon | **never** | — |

**Why a run in flight is never doubled.** `start` posts the check run `in_progress` as the run's second job, so every poll after it sees the candidate as taken. The poll that started the run and any poll before `start` finishes are held off by `e2e.yml`'s concurrency group on the release: a second run waits, then stops at `plan` when it finds the check run. `report` runs even on a red or cancelled run, so the check run never stays `in_progress`.

**What re-runs a candidate.** A `success` or `failure` check run is final: a green candidate needs nothing, and a red one needs a fix and a new candidate (decisions 11 and 12). A `neutral` one (every failure `infra`, or the run broke before judging) is re-run by the poll, at most hourly and at most six times; after that it waits for a dispatch, and the red issue says so. A dispatch can re-run any candidate.

**How "`main` changed" is read.** `plan` reads Kanon's `main` head through the public API, and the head the last completed nightly recorded in its result. A held night finishes `plan` and stops, at no cost beyond a minute of runner time.

**Why not `main` for the whole tier** (no third tag form, decision 4). A scenario repository can only pin a release: `lane-check` and doctor admit `vX.Y.Z` and `candidate-vX.Y.Z` and nothing else, and doctor stops with "nothing pins Kanon to an exact release" on any other ref. So `main`'s lanes can't run in a scenario repository until they are in a candidate. `main`'s CLI can. That is why the nightly runs it against the last release's requirements: it catches an `init` or doctor regression before the release pull request merges.

## 8. The release gate

**Owner decision 3:** no Kanon release ships unless the tier is green on its candidate. Under plan 0009, a release reaches adopters only by promotion: `vX.Y.Z` is tagged on the candidate's commit, and Dependabot proposes it. Until then the candidate reaches only Kanon's own pins and anyone who chooses to run ahead. So the gate sits where a candidate becomes a release anyone follows.

### 8.1 Where it hooks in

**Decided (decisions 1 and 2): a fifth promotion gate, and the pin job waits for green.**
- `scripts/promote.mjs` (plan 0009 S5) reads the gate. A red candidate stays a pre-release that is never promoted.
- The pin job (S4) opens `ci(deps): run Kanon on candidate vX.Y.Z` only once the gate is green, so the soak's 72 hours start on a candidate the gate passed.
- Kanon's repository gains only this step (the harness decision), in `promote.mjs` and the pin job.

**Before candidates exist** (decision 3): the tier runs ungated, nightly and by dispatch, against the latest release, until plan 0009's S3 to S5 exist. A release cut before E11 is not gated. The Owner chose this after seeing that holding every release would deadlock with the release hold on the telemetry store's token path: the deploy lane must itself ship in a release.

### 8.2 What the gate reads

`promote.mjs`'s fifth row, read from GitHub, never self-reported. Each condition below is needed:

| Gate | Holds when | Read from |
|---|---|---|
| **End to end** | <ol><li>The candidate's commit carries a completed check run named `kanon-e2e` whose App is the Reporter, by its App id, which Kanon records beside its other Apps. A check run of the same name from any other App or token is ignored.</li><li>The latest such check run concluded `success`.</li><li>The harness run it links (by its `external_id`) is a run of the harness repository's `e2e.yml`, on its default branch, that concluded `success`, which it does only when its `verdict` was `pass` ([§5.2](#52-the-jobs-and-which-secret-each-holds)). Its recorded release is the candidate's tag and its commit.</li></ol> | `GET repos/yedeya-labs/kanon/commits/<sha>/check-runs?app_id=<the Reporter's id>`, and the linked run in the harness repository (public, read without a credential) |

**Why a check run, and why the cross-read** (decision 18):
- **A check run carries the App that made it, and nobody else can make one in its name.** A commit status's context can be posted by any token with Statuses (write), including Kanon's own workflow token, so a status would prove nothing about who posted it.
- **The cross-read means a leaked Reporter key can't promote a candidate alone.** A forged green check run fails condition 3 unless the harness repository also has a run for that candidate that concluded `success`. A red run concludes `failure`, so linking a real red run doesn't help a forger, and making a green run there needs write access to the harness.

**What `verdict` decides.** It passes when every scenario with `gate: true` is `pass` (there is no quarantine). Two cases need saying:
- **A gating scenario `skipped: budget` counts as missing,** and holds the gate. So the real-model scenarios start gating only once their measured cost fits two under $2 with the ledger's margin.
- **An earlier red run for the same candidate still holds the gate.** A green run doesn't clear it while an earlier run for that candidate failed with a `fail` (not `infra`) whose red issue is still open. A person closes that issue, with the cause, as plan 0009's fourth gate asks of an unexplained red. Until then `verdict` answers `fail`, so the run concludes `failure` and the Reporter posts `failure`, whatever the latest run's scenarios did.

**The urgent path** (plan 0009 §7) skips the soak and the six-day spacing. **It doesn't skip this gate** (decision 12): an urgent fix is a candidate like any other. The no-model tier's duration on a candidate is not measured yet; E13 measures it.

### 8.3 A red gate: how it is reported, and the only way past it

- **One issue per candidate,** filed in the harness repository by `verdict`:
  - titled `e2e: candidate-vX.Y.Z is red`;
  - listing each failing scenario, its first false expectation, its kept repository's link (alive 24 hours) and the run.

  A later run of the same candidate edits it rather than filing another. A green run closes it only when every failure in it was `infra`; a `fail` needs a person to close it, with the cause.
- **The check run on Kanon's commit** links that issue, so a red gate is visible on the candidate's commit in Kanon.
- **`promote.yml`'s summary** names the gate, the check run and its issue whenever it holds a candidate.
- **The only way past a red gate is a fix and a new candidate** (decisions 11 and 12). There is no quarantine, no `override` input, and `urgent` doesn't skip it. A broken scenario is fixed in the harness repository, through its own review, and the Owner merges it there (decision 17). A re-run of the same candidate then reports again.

## 9. The first scenarios

In this order, each a step of [§14](#14-order-of-moves), so the harness proves itself on the scenario that needs it most:
1. **`deploy-rehearsal`: plan 0010's D12, automated.**
   - **Setup:** two declared environments, trivial hooks (a build that writes one file, a deploy and a smoke that check it), and no AWS. `release.cut` has the test Releaser publish the scenario repository's release, so the lane's trigger fires as it does for an adopter.
   - **Expected, as D12 states it:**
     - the run executes the gate, the probe, the build, both environments in order, and every `record` and `report` job;
     - the second environment waits for its reviewer;
     - the run lists the job names the reference deploy declares;
     - a failing smoke (a second release, with the smoke hook made to fail) files that environment's issue, and a third release that succeeds closes it;
     - doctor reports no `deploy.*` finding.
   - **The approval.** On a candidate's run, the Owner approves, on a release the test Releaser published: the path D0 could not measure (decision 9). Nightly, the scenario waits until the second environment is `waiting`, then cancels the run and expects the job `cancelled`, as D0 measured.
2. **`install-review`, `install-build`, `install-full`:** `init`, then doctor healthy, per feature. They need E1 released first: before it, `init` at a candidate writes `vX.Y.Z` pins, which don't exist yet.
3. **`upgrade-previous`:** install at the last stable release, upgrade to the release under test, and doctor is healthy.
4. **`review-real`:** the first real-model scenario (decision 15). It joins the gate only after its burn-in, and only once the ledger's measured cost fits.

**D12 itself** stays plan 0010's, run by hand once, before the operator's repository adopts the lane (decision 15). Scenario 1 then re-runs it on every candidate, which D12 alone never would.

## 10. Flakiness

- **Every read after a write polls,** never sleeps. A step polls its predicate with a backoff from 2 to 30 seconds, until it holds or its deadline passes. GitHub's answers are eventually consistent: a new repository's installation, a ruleset's effect, a pull request's head (the release PR guard's own #86). A fixed sleep is either too short on a slow day or wasted on a fast one.
- **Retries only on infrastructure errors,** classified by the runner, never on an expectation. The errors it retries:
  - an HTTP 5xx;
  - a 403 or 429 with GitHub's rate-limit headers, after the wait they name;
  - a network error;
  - a repository name GitHub says exists (a re-run's leftover, renamed with the next attempt);
  - a model run classified `unavailable` (decision 11).

  Up to three times per call, with backoff. A false expectation is never retried: it is the finding.
- **An `infra` scenario is re-run once,** whole, in a fresh repository. If it is still `infra`, the gate can't claim green: the Reporter posts `neutral`, the gate holds the candidate and says why, and the poll re-runs it hourly, at most six times, after which a dispatch does ([§7](#7-triggers)). It never counts as `pass`.
- **A deadline that passes is `fail`, not `infra`.** A lane that takes too long is a finding. Each deadline is set from E13's measured durations, at three times the slowest observed run.
- **Burn-in:** a new scenario joins the gate (`gate: true`) only after ten consecutive scheduled runs passed. The pull request that turns it on links them. Burn-in is how a scenario earns its place, before it can block anything.
- **No quarantine** (decision 11, changed). A gating scenario is never set aside: while it is broken, releases wait. The pressure goes where it belongs, on fixing the scenario or the product.
- **Measured, not assumed.** E13 records every scenario's pass rate, `infra` rate and duration over four weeks. A scenario under a 98% non-`infra` pass rate on unchanged code is a finding against the scenario.

## 11. The threat model, stated plainly

Almost everything with a credential now lives outside Kanon's repository, in the harness repository and the test organisation.

**Kanon's repository gains no secret,** and one installation: the Reporter, Checks (write) only (decision 18). Its key lives in the harness repository, so a leak of it can post check runs on Kanon's commits. The gate's cross-read ([§8.2](#82-what-the-gate-reads)) keeps such a check run from promoting a candidate on its own.

**What each credential can reach:**
- **No personal token anywhere.** The runner acts as the driver App; the lanes in a scenario repository act as the test Apps; the real-model key is an API key. No step uses the Owner's or a maintainer's token. The Owner's only acts are a click to approve a deployment (decision 9) and the merges the escalation paths give the Owner (decision 17).
- **The driver's key** is in the harness's `e2e` environment, read only by the pairs' `mint` jobs and by `provision`, which mints its own token and runs `gh` alone. **A minted token** reaches exactly one consuming job, through its pair's `secrets:`, masked, and that job revokes it when it ends. It never reaches a scenario repository: it is never written as a secret there, never passed to a workflow there, and no code from a scenario repository runs in a job that holds it.
- **The driver can reach only the test organisation,** because it is installed only there. A leaked driver token can create and delete throwaway repositories, and change the harness repository, but nothing of Kanon's or an adopter's.
- **The test Apps' keys** are in the `e2e` environment, read only by `provision`, and written as each scenario repository's own secrets. There the lanes' mint jobs read them as an adopter's do. They are deleted with the repository.

**What the driver token can do inside a scenario repository.** The real-model scenarios' repositories hold the Anthropic API key as a secret. Code that can push a workflow there can make it read the key and send it anywhere. Two kinds of code run with a driver token, and they never share a job ([§5.2](#52-the-jobs-and-which-secret-each-holds), `K-AGENT-50`):
- **The harness's own runner and janitor,** in the `act` and janitor jobs, with Contents and Workflows write. They are on the harness's escalation paths as `always`, so the Owner merges every change to them (decision 17). The harness runs Kanon's full pipeline (decision 20), so agents propose, and the Owner decides.
- **Kanon's CLI and scripts, at the release under test,** in the `kanon` jobs. These are Kanon's code, merged under Kanon's own escalation paths, where `cli/` and most of `scripts/` are green ([§1](#1-today-measured)). A change the Merger lands there runs on the next candidate. Its token (decision 22) is scoped to the one scenario repository, with no Workflows, no Secrets and no Contents write, and no wider token is in its job. **The residual risk, stated plainly:**
  - **Administration (write) on that one repository.** It is what `init` needs for the ruleset and the merge settings. Whether it opens a path to a workflow change (a deploy key, a collaborator, a ruleset bypass) without the Workflows permission is not confirmed ([§12](#12-what-is-not-confirmed-and-how-each-is-handled) item 14).
  - **What the CLI writes is pushed as written.** `init`'s job is to write the callers, and the `act` job pushes them. A malicious CLI could write a caller that reads the key, exactly as it could in any adopter's repository on that release. The harness adds no exposure an adopter on the candidate doesn't have, and `main`'s unreleased CLI runs only in `claude: none` scenarios, whose repositories hold no key ([§7](#7-triggers)).

  The model key is written by `model-key` before the first phase, so the CLI does run in a repository that holds it. That is why the narrowing matters, and why the draft's idea of writing the key after the last Kanon command is dropped: the job graph writes it first.

**The shared Console workspace** (decision 16, changed). The real-model key is in Kanon's existing workspace, under its spend limit. **A leak from a scenario repository spends Kanon's own workspace,** and a leak's spending is bounded only by that limit, which Kanon's own lanes share. If it is spent, Kanon's own lanes on that key stop too until the month turns or the Owner raises the limit. The ledger still holds $2 per run and night against honest runs. It doesn't bound a leaked key.

**Public repositories.** A scenario repository's logs are public, as Kanon's are, and its secrets are not. A fork's pull request gets no secret (`K-AGENT-47`), and the lanes refuse a non-member's event, which the gate-refusal scenarios check.

**The harness's environments** each admit only the harness's default branch, so a branch's workflow can't read them. The harness's workflow test holds three things:
- each environment is named only by the jobs [§5.2](#52-the-jobs-and-which-secret-each-holds) lists;
- no `-job` workflow names a private key;
- no workflow runs on `pull_request`, `pull_request_target` or `merge_group` with a secret.

**This finding first came from the Lead's brief for #902,** where it was inferred, not verified. Moving the harness out of Kanon removed the parts about Kanon's own guard. What remains is where Kanon's code runs with a driver token, which decision 22 and the `kanon`/`act` split cover.

## 12. What is not confirmed, and how each is handled

GitHub's documentation was not read for this plan. Each item is read, or probed in the test organisation, at E0. A step that rests on an item is amended before it is built if the answer differs.

| # | Assumed | Rests on it | If it doesn't hold |
|---|---|---|---|
| 1 | A GitHub App's installation token, with the organisation's and the repository's Administration (write), creates a public repository in the organisation, adds a topic to it, and deletes it | the whole runner | The Owner grants what the probe shows is needed; if no App can, the plan stops before E3 |
| 2 | A new repository in an organisation whose Apps are installed on all repositories has them at once, and a token minted after creation, scoped to it, reaches it | `provision`, every lane | `provision` polls the installation's repositories before it writes |
| 3 | Installation tokens expire after an hour | [§5.2](#52-the-jobs-and-which-secret-each-holds)'s phases | the phase length changes |
| 4 | Repository creation is held by a secondary rate limit well above a candidate run's count (about 20 to 40 repositories in an hour) | the catalogue's size | the matrix's `max-parallel` falls, and the run grows longer |
| 5 | The free plan runs 20 jobs at once across the organisation's public repositories | `max-parallel` | as 4 |
| 6 | Public repositories' Actions minutes are free on the free plan | [§15](#15-cost) | the Owner decides a budget |
| 7 | The Owner, as required reviewer, can approve an environment job of a run whose release the test Releaser published, with "Prevent self-review" on | `deploy-rehearsal` on a candidate | D0's finding 9, unrun half: if not, the scenario's reviewer is another member, whom the Owner names |
| 8 | `--max-budget-usd` stops a run within one turn of its ceiling | [§6.2](#62-a-real-model-under-2)'s statement that the lane's ceiling bounds a run | the plan names the measured overshoot |
| 9 | Doctor's checks with the driver's installation token, with decision 14's permissions: which are still `unchecked` | [§4.3](#43-what-a-scenario-may-expect)'s explicit `unchecked` | the scenarios list what E0 found |
| 10 | A deleted repository's name can be reused at once, and deleted repositories don't count against anything | the janitor, re-runs | names carry the attempt (already so) |
| 11 | Rulesets on the default branch are offered on the free plan for public repositories (D0 measured required reviewers only) | every scenario that expects doctor's `ruleset.*` checks clean | those scenarios list the `ruleset.*` findings the plan forces, and the Owner decides whether the test organisation needs a paid plan |
| 12 | A job inside a called workflow can declare an environment and read that environment's secrets (a calling job can't declare one), and the environment's deployment policy applies to it | every mint, `e2e-model-key-job.yml` | the keys move to repository secrets read by the level-1 call jobs and handed down, and the branch restriction is replaced by the workflows' triggers alone, which the Owner accepts or not |
| 13 | A private App owned by `yedeya-labs`, installed only on Kanon, can create a check run on a Kanon commit from a token minted in another organisation's workflow, `in_progress`, and complete it later. The check run's `app.id` is the App's, and `check-runs?app_id=` filters by it | [§7](#7-triggers), [§8.2](#82-what-the-gate-reads) | the gate reads the harness's runs directly, through the public API, with no write to Kanon: the alternative decision 18 weighed |
| 14 | A token with Administration (write) and no Workflows or Contents write can't change a workflow file in that repository by any route (a deploy key it adds, a collaborator it invites, a ruleset bypass it grants) | [§11](#11-the-threat-model-stated-plainly)'s residual risk | the plan states the route E0 found, and the Owner decides whether the `kanon` job's token gives up Administration, leaving `init`'s ruleset and merge settings as `steps-left` findings that the `act` job applies |
| 15 | An App installation token can be narrowed, at mint time, to a subset of the App's permissions and to one repository | the `kanon` job's token | the `kanon` job gets its own App with the narrow grant, which the Owner creates |

## 13. Rules and docs that change

- **No new rule for adopters,** and no product switch (the no-leak rule). The gate is Kanon's own operation, as candidates and promotion are (plan 0009, "Out of scope").
- **[ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md),** amended: Kanon's pins move only to a candidate the gate passed.
- **[`docs/release.md`](../release.md),** "Channels": the fifth gate, the Reporter's check run, the harness repository by link, and that `urgent` doesn't skip the gate.
- **[`docs/init.md`](../init.md):** which tag `init` pins when run from a candidate (E1).
- **`docs/architecture.md`:** a line saying Kanon's end-to-end tier lives in the harness repository and gates promotion.
- **Plan 0009:** §2's table gains the fifth row; §6's pin job runs after the gate. **Plan 0010:** D12 notes that scenario 1 repeats it on every candidate.
- **In the harness repository, not Kanon:** its README (the tier, the scenario format and vocabulary, how to dispatch a scenario, how to read a red run) and its own escalation paths and adoption record.

## 14. Order of moves

**Touches** names each step's files, to show which steps may run at once. Steps marked **harness** are offloaded to the harness repository as issues, as plan 0010 offloads the operator's steps. Each issue is filed when the step before it lands. In those steps, Touches names the harness's paths, and Kanon changes nothing. **E1 and E11 are Kanon's only code steps.**

| Step | Where | What | Touches | What must be true | Mutation |
|---|---|---|---|---|---|
| **E0** | the test organisation and Kanon: the Owner, then a maintainer | **The setup and the probes.** The Owner creates: <ul><li>the organisation and the harness repository;</li><li>the driver App with decision 14's permissions;</li><li>the test Author, Judge and Releaser;</li><li>the Reporter (decision 18), installed on Kanon;</li><li>the harness's three environments with their keys, the real-model key from Kanon's workspace (decision 16);</li></ul> and joins the organisation as the reviewer. A maintainer probes [§12](#12-what-is-not-confirmed-and-how-each-is-handled)'s fifteen items with throwaway workflows, printing no token | none in Kanon; results in E0's issue | Each of the fifteen answers is recorded, with the run's link. If 1 fails, the plan stops; if 7 fails, decision 9 is revisited before E5; if 13 fails, decision 18 is revisited before E8; if 14 or 15 fails, decision 22 is revisited before E4 | — (a measurement) |
| **E1** | Kanon | **`init` pins the release it runs from** (decision 5): `vX.Y.Z` when that tag exists, else `candidate-vX.Y.Z` when that exists, else it refuses | `cli/callers.mjs`, `cli/init.mjs`, `docs/init.md`, `tests/unit/kanon-init.test.ts` | With `vX.Y.Z` absent and `candidate-vX.Y.Z` present (stubbed), every reference `init` writes is the candidate; with both present, `vX.Y.Z`; with neither, `init` refuses and says why | Preferring the candidate when the stable tag exists turns the test red |
| **E2** | **harness** | **The harness adopts Kanon's full pipeline** (decisions 17, 20 and 21): `kanon init --feature full` at a stable release, with the test Apps and the Owner's subscription token; the release lane (Kanon's release workflow, the test Releaser, a `simple` release configuration) and Dependabot's Kanon entry; its escalation paths, with the runner's, the janitor's and the workflows' files `always`; and its workflow test, copying Kanon's `app-key-isolation.test.ts` assertions | the harness's `docs/qa/adoption.md`, `docs/qa/escalation-paths.md`, `.github/workflows/` (the lane callers and the release caller), `.github/dependabot.yml`, `release-please-config.json`, `.release-please-manifest.json`, `version.txt`, its workflow test | `lane-check` and `kanon doctor` pass on the harness with no finding; a review run on a harness pull request posts its verdict; a pull request touching an `always` path is not merged by the Merger; the harness's first release PR is opened by the test Releaser and, merged, publishes its `v0.1.0` | A runner path dropped from the escalation list turns the harness's own escalation test red |
| **E3** | **harness** | **The scenario format and the vocabulary** ([§4](#4-a-scenario-is-data)): the validator, and every verb with a stubbed-`gh` test | the harness's scenario validator, its step modules, their tests, its README | <ul><li>every directory under `scenarios/` validates;</li><li>these are each refused: an unknown verb; a waiting verb with no deadline; an `expect.api` path outside the scenario repository; a substitution other than the two; an expectation that reads a message.</li></ul> | The validator accepting an unknown verb, and `expect.api` admitting `repos/yedeya-labs/…`, each turn a named test red |
| **E4** | **harness** | **The runner, the janitor and the workflows** ([§5](#5-the-runner-and-the-janitor), [§7](#7-triggers)) | the harness's runner, janitor and GitHub client modules; `.github/workflows/e2e.yml` and the four pairs; their tests | On a stubbed `gh`: <ul><li>a passing scenario deletes its repository; a failing one keeps it 24 hours with the failed topic;</li><li>a 502 is retried and a false expectation is not;</li><li>an `infra` result never reads as `pass`, and a repository without the provisioned topic, a missing key or a deleted repository reads as `infra`;</li><li>a held night stops after `plan`;</li><li>the poll skips a candidate whose Reporter check run is `in_progress`, `success` or `failure`, re-runs one whose check run completed `neutral` more than an hour ago, and stops after six such re-runs;</li><li>a second run for the same release, started while one is in flight, stops at `plan`;</li><li>`verdict` exits non-zero on `fail` and on `infra-only`, and `report` completes the check run as `failure`, `neutral` and, with no `verdict.json`, `neutral`;</li><li>a `kanon` segment holding an `act` verb, or the reverse, is refused by the validator;</li><li>the janitor deletes only topic-marked repositories past their age, never the harness repository, and fails its run on one older than a day it couldn't delete.</li></ul> The workflow test holds every pair, `provision`, `model-key`, `start` and `report` to [§5.2](#52-the-jobs-and-which-secret-each-holds)'s shapes; the `kanon` mint to its narrow permissions and the `act` job to no Kanon code; `e2e.yml`'s concurrency group; `report`'s `if:`; and the phases' `needs:`, `if:` and `fail-fast: false` | Each of these turns a named test red: <ul><li>retrying a false expectation;</li><li>skipping the deletion on `pass`;</li><li>the janitor without its topic check;</li><li>a private key in a `-job` workflow;</li><li>the revoke removed;</li><li>a checkout added to `provision` or `report`;</li><li>a second step reading the model key;</li><li>a phase without its `if:` or with `fail-fast` on;</li><li>a held night that runs scenarios;</li><li>the poll re-running a candidate whose check run is `in_progress`;</li><li>`e2e.yml` without its concurrency group;</li><li>`verdict` exiting 0 on `fail`;</li><li>`report` without `always()` in its `if:`;</li><li>Workflows, Secrets or Contents write added to the `kanon` mint;</li><li>`npx` or a `kanon` command added to the `act` job.</li></ul> |
| **E5** | **harness**, then a dispatch | **Scenario 1, `deploy-rehearsal`** ([§9](#9-the-first-scenarios)) | the harness's `scenarios/deploy-rehearsal/` | Plan 0010's D4 to D8 are released. A dispatch against that release passes, nightly-style (cancelled at the wait), and the step's issue links it | A copy whose failing-smoke release expects no issue is reported `fail`, run once by dispatch and linked in the issue |
| **E6** | **harness**, after E1 is released | **Install scenarios,** per feature, and the Python tree | the harness's `scenarios/install-*/` | Each passes by dispatch at a candidate, with every caller pinned to the candidate | As E5: a copy expecting a finding doctor doesn't report is `fail` |
| **E7** | **harness**, after plan 0009 S4 | **Upgrade scenarios** from the last two stable releases | the harness's `scenarios/upgrade-*/` | Each passes by dispatch; `kanon.at` installs the older release's own `init` | As E5 |
| **E8** | **harness** | **The verdict, the red issue and the report** ([§8.2](#82-what-the-gate-reads), [§8.3](#83-a-red-gate-how-it-is-reported-and-the-only-way-past-it)) | the harness's verdict module, the `report` job, their tests | On fixtures: <ul><li>`skipped: budget` on a gating scenario fails the verdict;</li><li>an `infra`-only red closes on green; a `fail` red doesn't;</li><li>a green run for a candidate with an open `fail` issue still answers `fail`, and its run concludes `failure`;</li><li>`report` posts `failure` for a red verdict, never nothing.</li></ul> **Live:** once a candidate exists, a dispatch against it posts a `kanon-e2e` check run by the Reporter on its commit; before that, the `report` job writes to its summary the check run it would post, and posts nothing | Closing a `fail` issue on green, and posting `success` while one is open, each turn the test red |
| **E9** | **harness** | **Burn-in:** E5, E6 and E7's scenarios run nightly against the latest release; each turns `gate: true` after ten passes | each scenario's `scenario.json` | ten consecutive scheduled passes, linked in each pull request | — |
| **E10** | **harness**, with the real-model key | **The real-model tier** ([§6.2](#62-a-real-model-under-2)): the ledger, the `model-key` pair, `review-real` | the harness's ledger module, `scenarios/review-real/`, their tests | <ul><li>the ledger refuses a scenario whose expected cost would pass $2, and starts one that fits;</li><li>a scenario with no history runs only by the Owner's dispatch.</li></ul> **Live:** a week of runs, every one under $2 by the artifacts' recorded cost | The ledger without its margin, and a scenario with no history started by the schedule, each turn a named test red |
| **E11** | Kanon, after plan 0009 S5 | **The gate** ([§8](#8-the-release-gate)): `promote.mjs`'s fifth gate, and the pin job waiting for it | `scripts/promote.mjs`, `.github/workflows/promote.yml`, `.github/workflows/release-please.yml` (the pin job), the Reporter's id beside Kanon's other Apps, `docs/release.md`, `docs/architecture.md`, ADR 0011, plans 0009 and 0010's notes, their tests | `promote.test.ts`, on stubbed check runs and harness runs, holds a candidate when: <ul><li>it has no `kanon-e2e` check run;</li><li>it has one from another App;</li><li>it has one by the Reporter whose linked run is on another branch, another workflow, or another candidate;</li><li>its green check run links a harness run that concluded `failure`;</li><li>its latest check run is red.</li></ul> `urgent` doesn't skip the gate. A green check run with a matching run passes, and the pin job opens nothing while the gate holds. **Live:** the next candidate gets its check run from the harness, and `promote.yml`'s summary shows five gates | Each condition removed in turn, the App id check removed, and `urgent` skipping the gate, each turn a named test red |
| **E12** | **harness** | **The doctor-broken, `lane-check` and refusal families** ([§6.1](#61-no-model)), each through E9's burn-in | the harness's `scenarios/doctor-*/`, `lane-check-*/`, `refuse-*/` | Each passes by dispatch, and joins the gate after ten passes | As E5, per scenario |
| **E13** | the harness and Kanon | **The measurement** | none | Over four weeks after E11: <ul><li>every candidate has a check run;</li><li>each scenario's pass rate, `infra` rate and duration are recorded;</li><li>deadlines are set to three times the slowest;</li><li>no run of the real-model tier passed $2;</li><li>no repository outlived the janitor by more than an hour.</li></ul> | — |
| **E14** | **harness** | **The long-lived upgrade signal** (decision 20): a weekly harness job runs `kanon doctor --json` on the harness's own `main`, with its workflow token, and reads three things. Is the harness pinned to Kanon's latest stable release within seven days of its promotion? Is doctor healthy (the checks a workflow token can't run listed as allowed `unchecked`)? Did the harness's own latest release run go green? A no to any one opens, or keeps open, one issue in the harness, `long-lived upgrade behind`, naming which, and closes it when all three hold | the harness's `.github/workflows/upgrade-signal.yml`, its signal module, their tests | On fixtures: a pin one stable release behind for eight days opens the issue; a healthy, current harness closes it; a doctor `unchecked` outside the allowed list opens it | Treating a pin seven days behind as current after eight, and closing the issue while doctor has a blocking finding, each turn a named test red |

**Why this order.**
- **Probes first** (E0): the runner rests on an App creating and deleting repositories, which nobody has measured. The first scenario rests on an approval D0 couldn't run, and the gate on a check run authenticated across organisations.
- **`init`'s fix early** (E1): it is a product fix that stands on its own, and the install scenarios at a candidate can't pass without it.
- **The harness adopts Kanon before it holds a key's code** (E2 before E4): every change to the runner is the Owner's from the first, and the harness's own releases and Dependabot bumps start accruing the long-lived coverage E14 reads.
- **The harness before any scenario** (E3, E4), and **the deploy rehearsal first** (E5), because it is the scenario a human would otherwise run by hand on every candidate.
- **The gate after plan 0009's S5** (E11): it is a fifth row in a script S5 writes, and it needs candidates to exist.
- **The gate starts with the first scenarios,** not the whole catalogue. The families added later (E10, E12) join it one by one, after their burn-in, so the gate is never made of untried scenarios.

**What may run at once.** E1 runs in Kanon beside E2 to E5 in the harness. E14 needs only E2 and a promoted stable release, and can run beside anything after it. E3 and E4 touch different files once the format is agreed. E12's families can be written at once, each in its own directory.

## 15. Cost

- **Actions minutes:** the harness and the scenario repositories are public, so their runs are free on the free plan (not confirmed, [§12](#12-what-is-not-confirmed-and-how-each-is-handled) item 6). The candidate poll runs 96 times a day for under a minute each, also free. Kanon's own new work is one more read in the daily `promote.yml`. Wall time is the real cost: a candidate's run is bounded by its longest scenario, the deploy rehearsal, which waits for CI, a reviewer and three releases. Not measured; E13 measures it.
- **The model** (decisions 4, 7 and 16):
  - **How many runs:** a nightly run happens only after `main` changed, or on the seventh quiet day. So a month has at most 31 nightly runs and as few as 4–5, plus one run per candidate, about 4–5 a month on the weekly cadence.
  - **Honest runs:** at $2 a run, that is at most about $72 a month, and as little as about $18 in a quiet month.
  - **The soft part:** a run that goes past its own history can spend up to its lane's ceiling ($30 for the Reviewer) before the ledger sees it.
  - **The hard bound** is the shared workspace's monthly spend limit. The tier's spend now comes out of the same limit Kanon's own lanes use.
- **No stubbed tier and no recordings,** so neither costs anything (decision 6).
- **The harness's own lanes:** its full pipeline (decision 20) runs on the Owner's subscription token (decision 21), so its Implementer, Lead and review runs draw on the subscription's quota, not on the e2e tier's $2 or the shared workspace. Its releases cost nothing beyond the release workflow's minutes, free on a public repository.
- **The Owner's time:**
  - one approval per candidate (decision 9);
  - a merge for every change to the harness's runner (decision 17);
  - the first setup (E0).
- **Kanon's maintainers:** a release that changes a contract a scenario reads needs a harness pull request before its candidate can pass. That is the price of the gate having no quarantine (decision 11).

## Out of scope

- **Any test-only switch in Kanon's product:** a replay or stub mode, a test-only ceiling, a telemetry tag, a comment marker, a doctor waiver for tests (the no-leak rule).
- **A stubbed model tier** (decision 6).
- **Telemetry from scenario repositories** (decision 8).
- **A hard per-run cost cap for the tests.** It comes only as the adopter feature [#891](https://github.com/yedeya-labs/kanon/issues/891) describes, if it is judged worth it for adopters.
- **Per-pull-request end-to-end runs** ([§7](#7-triggers)).
- **Driving the adopt, doctor and upgrade skills through a model.** The scenarios drive their commands and the upgrade's edit. The skills' own conversations need a person, or a harness for Claude Code sessions, which is a plan of its own.
- **Private repositories and personal accounts.** The test organisation is an organisation with public repositories (Owner decision 1). So the fallbacks for a plan without rulesets or reviewers (`K-ADOPT-3`), and an adopter on a personal account (ADR 0013), stay with Kanon's unit tests.
- **Cloud credentials in the test organisation:** no QA store, no AWS, no deploy to a real cloud. The deploy rehearsal's hooks are trivial, as D12's are.
- **Creating Apps through the manifest flow** (`kanon apps --apps`): it needs a person's click.
- **Load and scale testing** of the lanes.

## Owner decisions (2026-10-14)

All taken by the Owner on 2026-10-14. None is reopened here; the sections above state them. **Changed** marks an answer that differs from the draft's recommendation.

### Before the draft

1. **A dedicated test organisation, and a driver App.** The Owner creates the organisation (its name to be filled in once it exists) and a GitHub App for driving the tests, installed only there. The App can create and delete repositories, and holds Administration, Contents, Actions, Environments, Workflows, Issues and Pull requests. The organisation's repositories are public. D0 measured only one of the reasons: required reviewers are offered on a public repository. Rulesets on the free plan and free minutes are not confirmed ([§12](#12-what-is-not-confirmed-and-how-each-is-handled), items 6 and 11). The key's home moved with the harness decision: it now lives in the harness repository, not on Kanon. [§3](#3-the-test-organisation-the-harness-repository-and-the-apps).
2. **Test copies of Kanon's Apps** (the Author, the Judge, the Releaser and any other persona) are installed only in the test organisation. So the scenarios exercise real persona permissions, including the Releaser-publishes, Owner-approves path D0 could not measure. [§3](#3-the-test-organisation-the-harness-repository-and-the-apps), [§9](#9-the-first-scenarios).
3. **The end-to-end tier is a hard release gate:** "no Kanon release ships unless it is green on the release candidate". [§8](#8-the-release-gate).
4. **The real-model tier's budget is a hard cap of $2 per nightly run,** and the same cap for a release candidate's run. How it holds is decision 7 below. [§6.2](#62-a-real-model-under-2).

### The two new decisions

- **The no-leak rule.** "The e2e tier adds no test-only switch to Kanon's product; any product change it needs must stand on its own for adopters. The e2e run is Kanon-specific, not a Kanon feature." It replaces the draft's decisions 6, 7 and 8. [§2](#2-what-the-tier-is-and-what-it-is-not).
- **The harness's home.** A separate repository in the test organisation holds the runner, the scenarios, the e2e workflows and the driver App's key. "It tests Kanon from outside, like an adopter, and reports its verdict to the candidate's commit (a commit status or check), which Kanon's promotion gate reads." Kanon's repository gains only the gate step in its release flow, plus product fixes that stand alone (decision 5). It mirrors the placement of Kanon's deploy in the operator's repository (plan 0010). [§3](#3-the-test-organisation-the-harness-repository-and-the-apps), [§5](#5-the-runner-and-the-janitor), [§14](#14-order-of-moves).

### The answers to the draft's seventeen questions

1. **Where the gate hooks in:** (G1), a fifth promotion gate, and the pin job waits for green. As recommended. [§8.1](#81-where-it-hooks-in).
2. **Kanon's own pins wait for the gate:** yes. As recommended. [§8.1](#81-where-it-hooks-in).
3. **Before candidates exist:** (a), the tier runs **ungated** until plan 0009's S3 to S5 exist. As recommended. The Owner first chose to hold every release. Shown that this deadlocks with the release hold on the store's token path (the deploy lane must itself ship in a release), the Owner chose to run ungated after all. [§8.1](#81-where-it-hooks-in).
4. **Triggers** (**changed**). "The nightly runs only when main changed since the last nightly, or when no nightly has run in 7 days (the floor catches platform drift in quiet weeks)." The real model is included under the cap. The tier also runs on every candidate as the gate, and by manual dispatch. No third tag form. [§7](#7-triggers).
5. **`init` pins the release it runs from:** `vX.Y.Z` if that tag exists, else `candidate-vX.Y.Z`, else it refuses. As recommended: "a product bug fix". E1.
6. **No stubbed or replayed model** (**changed**, under the no-leak rule). No `Agent replay` choice, and no change to `agent-run`, doctor or comment markers. "Model lanes are tested only by the few real-model scenarios. No-model scenarios cover the rest." [§6](#6-two-tiers).
7. **The cap** (**changed**, under the no-leak rule). No `Run ceiling` choice. "The cost cap is the spend-limited key's monthly limit (hard per month) plus the runner's ledger, which refuses to start a run that could pass the cap (soft per run). Each lane's own ceiling still bounds one run." A per-run hard cap comes only later, as the adopter feature #891 describes, judged on its own merit. [§6.2](#62-a-real-model-under-2).
8. **Telemetry** (**changed**, under the no-leak rule). No `Telemetry tag` choice: "scenario repositories don't send telemetry". The collector's end-to-end path stays covered by its own tests. [§6.2](#62-a-real-model-under-2).
9. **The deploy scenario's approval:** (a), the Owner approves on candidates, on a release the test Releaser published, and nightly runs cancel at the wait. As recommended. [§9](#9-the-first-scenarios).
10. **The test Apps' keys** go in each scenario repository's own secrets. As recommended. [§5.2](#52-the-jobs-and-which-secret-each-holds).
11. **No quarantine** (**changed**). "A broken scenario blocks releases until it is fixed." Real-model scenarios gate only on model-independent facts: the run completed, posted, recorded, and stayed under its ceiling. A model outage is `infra`, which is retried, not failed. That half is as recommended. [§10](#10-flakiness).
12. **No override of a red gate,** and `urgent` doesn't skip it. As recommended. With decision 11, "the only way past a red gate is a fix and a new candidate". [§8.3](#83-a-red-gate-how-it-is-reported-and-the-only-way-past-it).
13. **A failed scenario's repository** is kept 24 hours, archived, then deleted. As recommended. [§5.1](#51-one-scenarios-life).
14. **The driver App's permissions** (**changed**): Secrets (write) **and** the organisation's Administration (read), both granted now, rather than the second only if E0 showed doctor needed it. [§3](#3-the-test-organisation-the-harness-repository-and-the-apps).
15. **The first real-model scenario** is the review lane on a one-line docs pull request, with at most two real-model scenarios a night. D12 is done by hand, as plan 0010 says. As recommended. [§9](#9-the-first-scenarios).
16. **The real-model key** (**changed**) shares Kanon's existing Console workspace and its spend limit; there is no separate workspace. The consequence, stated plainly: a leak from a scenario repository spends Kanon's own workspace. The ledger still holds $2 per run and night. [§6.2](#62-a-real-model-under-2), [§11](#11-the-threat-model-stated-plainly).
17. **Who merges harness code** (**changed** in substance, because the harness moved). The harness repository adopts Kanon itself (review lanes, like any adopter), with the runner's files on its escalation paths set to `always`, "so agents propose and the Owner merges every change that touches what runs with the driver key". It dogfoods Kanon on a second repository. Decision 20 widened "review lanes" to the full pipeline. [§3](#3-the-test-organisation-the-harness-repository-and-the-apps), [§11](#11-the-threat-model-stated-plainly), E2.

### The answers to the rewrite's five questions

18. **Who posts the verdict:** a new Reporter App with Checks (write) only, installed only on Kanon, posts a check run; the gate counts only its App id and verifies the linked harness run. As recommended. [§8.2](#82-what-the-gate-reads).
19. **How the harness learns of a candidate:** it polls Kanon's public releases every 15 minutes. As recommended. [§7](#7-triggers).
20. **The harness's releases** (**changed** in framing). The harness repository installs Kanon's **full** pipeline, release lane included, and cuts its own releases through it. "This gives long-lived release, Dependabot pin and `kanon upgrade` coverage on a repo that lives for months, which throwaway repos can't give." The e2e runs still come from the harness's `main`, not pinned to its releases, "so a harness fix reaches the gate at once". The Owner's criterion: "release only if it increases coverage". [§3](#3-the-test-organisation-the-harness-repository-and-the-apps), E2, E14.
21. **The harness's own lanes** run with the test Apps and the Owner's subscription token. As recommended. [§3](#3-the-test-organisation-the-harness-repository-and-the-apps).
22. **Kanon's CLI in the harness** gets a token scoped to the one scenario repository, without Workflows or Secrets, and the plan states the remaining risk. As recommended. Carried out as `K-AGENT-50` requires: the CLI runs in a `kanon` job of its own, with no wider token in it and no Contents write either, and the harness's pushes happen in a separate `act` job. The remaining risk, stated in [§11](#11-the-threat-model-stated-plainly), is Administration on that repository and the CLI's written files, which are pushed as written, as on any adopter's repository. [§5.2](#52-the-jobs-and-which-secret-each-holds).

## Open questions

None open. The Owner answered decisions 18 to 22 on 2026-10-14 ([above](#the-answers-to-the-rewrites-five-questions)).
