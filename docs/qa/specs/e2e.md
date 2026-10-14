# End-to-end tier and release gate

Kanon's end-to-end tier: scenarios run in throwaway repositories of a test organisation, against the release under test, and the gate that holds a candidate's promotion on them (plan 0012, drafted in [#903](https://github.com/yedeya-labs/kanon/pull/903); project [#902](https://github.com/yedeya-labs/kanon/issues/902)). Every clause here was seeded by the project's brief, `docs/projects/902.md`, and is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `ETE`

## Scenario format

- `[ETE-1]` `[seed]` Every directory under `tests/e2e/` holds `scenario.json`, `start/` and `steps.json`, and the scenario validator accepts it; a scenario whose `id` is not its directory's name, is longer than 40 characters, or uses anything but lowercase letters, digits and hyphens is refused.
- `[ETE-2]` `[seed]` The scenario validator refuses a step whose verb is outside the closed vocabulary, a waiting verb with no `deadline`, an `expect.api` path outside `repos/<the scenario repository>/`, a substitution in `start/` other than `{{release}}` and `{{repository}}`, and an expectation that reads a message, a log line or a comment's wording rather than a field or a marker Kanon writes.
- `[ETE-3]` `[seed]` An `expect.doctor` step fails when doctor's `unchecked` names a check the step does not list as allowed, so an incomplete doctor never reads as healthy.
- `[ETE-4]` `[seed]` Each verb of the vocabulary is implemented once under `scripts/e2e/steps/` and has a unit test against a stubbed `gh`.
- `[ETE-5]` `[seed]` `docs/e2e.md` names every verb the scenario validator accepts and no verb it refuses, and `docs/architecture.md` links it.

## Runner and janitor

- `[ETE-6]` `[seed]` A scenario repository is created public in the test organisation, named `e2e-<scenario>-<run id>-<attempt>` in at most 100 characters, with the topic `kanon-e2e`.
- `[ETE-7]` `[seed]` The runner deletes a scenario repository whose result is `pass` or `infra`; on `fail` it archives the repository and adds the topic `kanon-e2e-failed`.
- `[ETE-8]` `[seed]` The runner retries a GitHub call only on an infrastructure error (an HTTP 5xx, a 403 or 429 carrying rate-limit headers, after the wait they name, a network error, or a repository name that already exists), at most three times; a false expectation is never retried, and a deadline that passes is `fail`.
- `[ETE-9]` `[seed]` A scenario still `infra` after one whole re-run in a fresh repository is reported `infra`, and nothing that reads results counts `infra` as `pass`.
- `[ETE-10]` `[seed]` Each scenario run writes one `kanon-e2e-result/v1` document naming the scenario, the release, the result, each step's duration and outcome, the first false expectation and the repository's name.
- `[ETE-11]` `[seed]` The janitor deletes only repositories with the topic `kanon-e2e` created more than 3 hours ago, or more than 27 hours ago with `kanon-e2e-failed`, and its run fails when a `kanon-e2e` repository older than a day survives it.

## Workflows

- `[ETE-12]` `[seed]` Only the `mint` and `provision` jobs of `e2e.yml`, and the janitor's `mint` job, name the `e2e` environment; no other workflow of Kanon names it.
- `[ETE-13]` `[seed]` `e2e.yml`'s `run` job names no private key and receives the driver token through a called workflow's `secrets:`, and its `provision` job runs no checkout, no `npx` and no script of Kanon's.
- `[ETE-14]` `[seed]` `e2e.yml` has no `pull_request`, `pull_request_target` or `merge_group` trigger, and runs nightly and on a dispatch naming a scenario or a family and a release.
- `[ETE-15]` `[seed]` The nightly run tests the latest candidate, or the latest stable release when no candidate is newer, and also runs the install and doctor families with the CLI from `main`'s checkout.

## Verdict

- `[ETE-16]` `[seed]` The `verdict` job passes only when every scenario with `gate: true` and no live quarantine is `pass`; a scenario reported `skipped: budget` counts as missing.
- `[ETE-17]` `[seed]` A quarantine names an open issue and a date at most 14 days on, at most two scenarios are quarantined at once, `deploy-rehearsal` and the install scenarios are never quarantined, and the `plan` job fails a run while an expired quarantine is in the tree.
- `[ETE-18]` `[seed]` A red run files one issue per candidate, titled `e2e: candidate-vX.Y.Z is red` and labelled `bug` and `sev:high`; a later run of the same candidate edits that issue, and a green run closes it only when every failure in it was `infra`.

## Scenarios

- `[ETE-19]` `[seed]` `deploy-rehearsal` expects each check of plan 0010's D12: the gate, the probe and the build run, both environments in order with every record and report job, the second environment waits for its reviewer, a failing smoke files that environment's issue and the next good release closes it, and doctor reports no `deploy.*` finding.
- `[ETE-20]` `[seed]` For each feature in `requirements.json`'s `features`, and for the Python fixture tree, an install scenario runs `kanon.init` and then expects doctor healthy.
- `[ETE-21]` `[seed]` An upgrade scenario exists from each of the last two stable releases: it installs with that release's own `init`, moves the pins with `scripts/move-pins.mjs`, and expects doctor healthy at the release under test.
- `[ETE-22]` `[seed]` `review-replay` expects a pull request labelled `review:please` in a fresh `review` install to get the test Judge's replayed verdict, its check, a `tag: test` row, and the Merger's merge.
- `[ETE-23]` `[seed]` The recording script keeps only what the recorded lane's parsers read, and stamps the recording with the release it was made against.
- `[ETE-24]` `[seed]` For each finding category of `docs/doctor.md`, a doctor-broken scenario breaks one thing in a clean install and expects exactly that category's finding id and no other blocking finding.
- `[ETE-25]` `[seed]` A `lane-check` scenario expects `Lane check` red on a pull request whose caller has an inexact pin or `secrets: inherit`, and green on a correct one.
- `[ETE-26]` `[seed]` Refusal scenarios expect a label applied by an identity outside the App register to start no lane, the Merger to refuse a pull request with no verdict, and the deploy gate to refuse a release whose CI is red with a `refused` row.
- `[ETE-27]` `[seed]` `review-real` expects only model-independent facts: the run completed, the test Judge posted a verdict with its marker, and its row is `tag: test` with a cost under the scenario's `ceilingUsd`; a run classified `unavailable` is `infra`.
- `[ETE-28]` `[seed]` The runner skips a real-model scenario, reporting `skipped: budget`, when its `ceilingUsd`, plus the ceilings of the run's real-model scenarios already started, plus the one-turn margin the probes measured, would exceed $2.

## The gate

- `[ETE-29]` `[seed]` `deploy-rehearsal`, the install scenarios, the upgrade scenarios and `review-replay` carry `gate: true`, each set in a pull request that links ten consecutive scheduled passes.
- `[ETE-30]` `[seed]` `e2e.yml` starts on the publication of a `candidate-v*` pre-release, and reads its workflow, runner and scenarios at the candidate's tag.
- `[ETE-31]` `[seed]` `promote.mjs` holds a candidate unless the latest completed `e2e.yml` run at the candidate's commit concluded `success` with its `verdict` job `success`, and every red issue of that candidate with a `fail` result was closed by a person.
- `[ETE-32]` `[seed]` `urgent` does not skip the end-to-end gate, and no input overrides it.
- `[ETE-33]` `[seed]` The pin job opens no pull request moving Kanon's pins to a candidate until that candidate's `verdict` is green.
- `[ETE-34]` `[seed]` `promote.yml`'s summary names the end-to-end gate, its run and its red issue whenever the gate holds a candidate.
