# End-to-end release gate

Kanon's end-to-end release gate: a candidate is promoted, and Kanon's own pins move to it, only once the end-to-end harness has reported green on the candidate's commit ([plan 0012](../../plans/0012-end-to-end-tests.md) §8; project [#902](https://github.com/yedeya-labs/kanon/issues/902)). The harness itself, with its scenarios, runner and workflows, lives in a repository of the test organisation and is specified there. Every live clause here was seeded by the project's brief, `docs/projects/902.md`, and is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `ETE`

## The gate

- `[ETE-31]` `[seed]` `promote.mjs` holds a candidate unless the candidate's commit carries a completed check run named `kanon-e2e` from the Reporter App, matched by the App id Kanon records, and the latest such check run concluded `success`; a `kanon-e2e` check run from any other App or token is ignored.
- `[ETE-36]` `[seed]` `promote.mjs` passes the end-to-end gate only when the harness run that the Reporter's check run links by its `external_id` is a run of the harness repository's `e2e.yml` on its default branch, recorded for the candidate's tag and commit, whose `verdict` job concluded `success`; the run's own conclusion is not read, so a run that failed only in a non-gating job passes, and a run whose `verdict` job failed holds the candidate.
- `[ETE-32]` `[seed]` `urgent` does not skip the end-to-end gate, and no input overrides it.
- `[ETE-33]` `[seed]` The pin job opens no pull request moving Kanon's pins to a candidate while the end-to-end gate holds that candidate.
- `[ETE-34]` `[seed]` `promote.yml`'s summary names the end-to-end gate, the check run and its red issue whenever the gate holds a candidate.

## Retired: the harness's behaviour

Project #902's draft brief seeded these when the harness was to live in Kanon. On 2026-10-14 the Owner moved it to a repository of its own in the test organisation (plan 0012, the harness decision), and dropped the quarantine (decision 11), the replayed model (decision 6) and the candidate trigger in Kanon (the harness polls instead, plan decision 19). The clauses keep their ids, and nothing in Kanon cites them. The harness specifies its own behaviour.

- `[ETE-1]` `[retired]` Every directory under `tests/e2e/` holds `scenario.json`, `start/` and `steps.json`, and the scenario validator accepts it; a scenario whose `id` is not its directory's name, is longer than 40 characters, or uses anything but lowercase letters, digits and hyphens is refused.
- `[ETE-2]` `[retired]` The scenario validator refuses a step whose verb is outside the closed vocabulary, a waiting verb with no `deadline`, an `expect.api` path outside `repos/<the scenario repository>/`, a substitution in `start/` other than `{{release}}` and `{{repository}}`, and an expectation that reads a message, a log line or a comment's wording rather than a field or a marker Kanon writes.
- `[ETE-3]` `[retired]` An `expect.doctor` step fails when doctor's `unchecked` names a check the step does not list as allowed, so an incomplete doctor never reads as healthy.
- `[ETE-4]` `[retired]` Each verb of the vocabulary is implemented once under `scripts/e2e/steps/` and has a unit test against a stubbed `gh`.
- `[ETE-5]` `[retired]` `docs/e2e.md` names every verb the scenario validator accepts and no verb it refuses, and `docs/architecture.md` links it.
- `[ETE-6]` `[retired]` A scenario repository is created public in the test organisation, named `e2e-<scenario>-<run id>-<attempt>` in at most 100 characters, with the topic `kanon-e2e`.
- `[ETE-7]` `[retired]` The runner deletes a scenario repository whose result is `pass` or `infra`; on `fail` it archives the repository and adds the topic `kanon-e2e-failed`.
- `[ETE-8]` `[retired]` The runner retries a GitHub call only on an infrastructure error (an HTTP 5xx, a 403 or 429 carrying rate-limit headers, after the wait they name, a network error, or a repository name that already exists), at most three times; a false expectation is never retried, and a deadline that passes is `fail`.
- `[ETE-9]` `[retired]` A scenario still `infra` after one whole re-run in a fresh repository is reported `infra`, and nothing that reads results counts `infra` as `pass`.
- `[ETE-10]` `[retired]` Each scenario run writes one `kanon-e2e-result/v1` document naming the scenario, the release, the result, each step's duration and outcome, the first false expectation and the repository's name.
- `[ETE-11]` `[retired]` The janitor deletes only repositories with the topic `kanon-e2e` created more than 3 hours ago, or more than 27 hours ago with `kanon-e2e-failed`, and its run fails when a `kanon-e2e` repository older than a day survives it.
- `[ETE-12]` `[retired]` Only `e2e.yml`'s `provision` job and the `mint` jobs of `e2e-scenario-run.yml`, `e2e-janitor-run.yml` and `e2e-model-key-run.yml` name the `e2e` environment; no other workflow of Kanon names it.
- `[ETE-13]` `[retired]` The one job of `e2e-scenario-job.yml` and of `e2e-janitor-job.yml` names no private key and receives the driver token as its `app-token` secret from its pair's `mint`, and `e2e.yml`'s `provision` job holds no Claude credential and runs no checkout, no `npx` and no script of Kanon's.
- `[ETE-14]` `[retired]` `e2e.yml` has no `pull_request`, `pull_request_target` or `merge_group` trigger, and runs nightly and on a dispatch naming a scenario or a family and a release.
- `[ETE-15]` `[retired]` The nightly run tests the latest candidate, or the latest stable release when no candidate is newer, and also runs the install and doctor families with the CLI from `main`'s checkout.
- `[ETE-16]` `[retired]` The `verdict` job passes only when every scenario with `gate: true` and no live quarantine is `pass`; a scenario reported `skipped: budget` counts as missing.
- `[ETE-17]` `[retired]` A quarantine names an open issue and a date at most 14 days on, at most two scenarios are quarantined at once, `deploy-rehearsal` and the install scenarios are never quarantined, and the `plan` job fails a run while an expired quarantine is in the tree.
- `[ETE-18]` `[retired]` A red run files one issue per candidate, titled `e2e: candidate-vX.Y.Z is red` and labelled `bug` and `sev:high`; a later run of the same candidate edits that issue, and a green run closes it only when every failure in it was `infra`.
- `[ETE-19]` `[retired]` `deploy-rehearsal` expects each check of plan 0010's D12: the gate, the probe and the build run, both environments in order with every record and report job, the second environment waits for its reviewer, a failing smoke files that environment's issue and the next good release closes it, and doctor reports no `deploy.*` finding.
- `[ETE-20]` `[retired]` For each feature in `requirements.json`'s `features`, and for the Python fixture tree, an install scenario runs `kanon.init` and then expects doctor healthy.
- `[ETE-21]` `[retired]` An upgrade scenario exists from each of the last two stable releases: it installs with that release's own `init`, moves the pins with `scripts/move-pins.mjs`, and expects doctor healthy at the release under test.
- `[ETE-22]` `[retired]` `review-replay` expects a pull request labelled `review:please` in a fresh `review` install to get the test Judge's replayed verdict, its check, a `tag: test` row, and the Merger's merge.
- `[ETE-23]` `[retired]` The recording script keeps only what the recorded lane's parsers read, and stamps the recording with the release it was made against.
- `[ETE-24]` `[retired]` For each finding category of `docs/doctor.md`, a doctor-broken scenario breaks one thing in a clean install and expects exactly that category's finding id and no other blocking finding.
- `[ETE-25]` `[retired]` A `lane-check` scenario expects `Lane check` red on a pull request whose caller has an inexact pin or `secrets: inherit`, and green on a correct one.
- `[ETE-26]` `[retired]` Refusal scenarios expect a label applied by an identity outside the App register to start no lane, the Merger to refuse a pull request with no verdict, and the deploy gate to refuse a release whose CI is red with a `refused` row.
- `[ETE-27]` `[retired]` `review-real` expects only model-independent facts: the run completed, the test Judge posted a verdict with its marker, and its row is `tag: test` with a cost under the scenario's `ceilingUsd`; a run classified `unavailable` is `infra`.
- `[ETE-28]` `[retired]` The runner skips a real-model scenario, reporting `skipped: budget`, when its `ceilingUsd`, plus the ceilings of the run's real-model scenarios already started, plus the one-turn margin the probes measured, would exceed $2.
- `[ETE-29]` `[retired]` `deploy-rehearsal`, the install scenarios, the upgrade scenarios and `review-replay` carry `gate: true`, each set in a pull request that links ten consecutive scheduled passes.
- `[ETE-30]` `[retired]` `e2e.yml` starts on the publication of a `candidate-v*` pre-release, and reads its workflow, runner and scenarios at the candidate's tag.
- `[ETE-35]` `[retired]` The one job of `e2e-model-key-job.yml` is the only job of Kanon whose steps' `env:` holds a Claude credential: it holds no private key, its steps are exactly the receive, one `gh secret set ANTHROPIC_API_KEY` and the revoke, with no checkout and no other `uses:`, and it is called only through `e2e.yml`'s `model-key` job, which runs only for a scenario with `claude: api-key`.
