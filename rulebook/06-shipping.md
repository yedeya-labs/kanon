# 06 Shipping

This chapter governs what happens between "the code works in my worktree" and "it is running in production": the checks before a PR opens, the PR's title and body, how issues get closed, and how a merge becomes a release and a deploy. These rules are strict about spelling because the spelling is machine-read. A PR title drives the version, a PR body drives which issues close, and a release commit's CI decides whether anything deploys. A slip in any of them fails silently: no version, an issue left open, or a red build shipped.

## Taking work to review

### `K-SHIP-1` Ship the whole loop, unprompted

**Rule.** A worktree takes its issue all the way to an approved PR, not just to a commit. Without being asked: commit, push, open the PR with the review label, watch for the review, fold in each round, and tell the human when the PR is mergeable. Never merge (`K-MERGE-15`).

**Why.** A commit sitting in a worktree is not progress anyone can see or review. Stopping at each step to ask permission turns an agent into a bottleneck, while the merge, the one step that matters, stays with whoever `K-MERGE-1` gives it to.

**Enforced by.** Prose only; the ship command implements the loop.

**Class.** framework

### `K-SHIP-2` Pass CI's gates locally before opening a PR

**Rule.** Before opening a PR, run the gates CI runs: lint, typecheck and unit tests always, plus the heavier tiers the change calls for. Don't open a PR over a failure you can't fix. When the change touches an escalation path, also run one local advisory code review per ship, record its first line in the PR body, and say in the body what you did with each finding. That advisory review never runs in CI.

**Why.** A red required check makes approval impossible, so a PR opened red spends a review round learning what a local run would have said for free. The advisory review is a cheap second opinion where a missed bug is most expensive: in the reference adopter it caught two or three of five bugs that had previously escaped, and 42 of its 50 findings were valid, at about a dollar a run.

**Enforced by.** A script that decides from the changed paths whether the advisory review is required. Running the gates locally is prose only.

**Class.** split. Local preflight and the advisory review on escalation paths are framework. **The project supplies:** which changes trigger which test tiers, and its escalation paths (`K-MERGE-4`).

## Titles and bodies

### `K-SHIP-3` Squash-merge, with the title as subject and the body as message

**Rule.** Merge every PR by squash, using the PR title as the commit subject and the PR body as the commit message.

**Why.** The title then drives versioning and the body drives closing references, so both are written once, on the PR, where they are reviewed.

**Enforced by.** Repository merge settings, checked on every release by the merge-settings guard in Kanon's release workflow ([`release.yml`](../docs/release.md)), which fails when the repository allows merge commits or rebase merges, or doesn't squash with the PR title and body.

**Class.** framework

### `K-SHIP-4` Title every PR as a conventional commit

**Rule.** Every PR title is a conventional commit, `<type>[(<scope>)][!]: <description>`, with a scope of lowercase letters, digits and `._/-`. Kanon fixes the release tool (release-please, `K-SHIP-7`) and the types it recognises:

| Type | Version bump | Deploys |
|---|---|---|
| `feat` | minor | yes |
| `fix`, `perf`, `refactor`, `build`, `revert` | patch | yes |
| `docs`, `style`, `test`, `ci`, `chore` | patch | no |

A `!` after the type, or a `BREAKING CHANGE` footer, marks a breaking change. `chore` means no runtime effect: a change that alters live behaviour is never `chore`. Dependency updates are `build(deps)`, and CI action updates `ci(deps)`. Never end a title with `(#n)`. Validate the title with CI's own validator before creating the PR, and don't infer the convention from the commit log.

**Why.** The release tool silently drops commits with an unknown type: no version, and eventually no deploy. The platform appends the PR number at squash time, so a title that already ends in one gets a double reference, which the release tool also drops. The commit log shows those platform-added numbers, which is why copying its style teaches the wrong rule.

**Enforced by.** Kanon's `pr-title` action ([`actions/pr-title`](../actions/pr-title/README.md)), which fails on an unrecognised type or a trailing issue reference and prints the recognised types, and a unit test in Kanon that fails when the action's type table disagrees with the changelog sections in Kanon's release configuration. An adopter runs the action pinned to an exact version (`K-ADOPT-11`).

**Class.** framework

### `K-SHIP-5` The issues a merge closes are exactly the issues the body declares

**Rule.** Every PR body links its issue and says what changed and how it was verified. Declare closing references (`Closes #n`) in the body's first paragraph that isn't a blockquote, never in the title. The set of issues the platform will close must equal the set the body declares: re-save the body after retargeting the PR. To mention an issue without closing it, break the keyword's adjacency by backticking the reference, not the whole phrase (``Closes `#n` ``).

**Why.** Closing references outside that first paragraph are unreliable, and the closing set drifted three different ways before it was checked. Backticking the whole phrase hides it from the platform's link preview but not from the merge: the commit message is plain text, where backticks mean nothing, so the phrase still closes the issue on merge. That once closed two issues from a line written to explain this exact bug.

**Enforced by.** A required check that fails when the issues the platform links for closing differ from the issues declared in the body's first paragraph, and prints the safe spelling for a reference that should not close.

**Class.** framework

### `K-SHIP-6` A change PR doesn't close an issue that still needs measuring

**Rule.** When an issue's acceptance criteria include a measurement taken after merge, the PR making the change must not close it. Reference it without a closing keyword, and close it when the measurement is in.

**Why.** Merging auto-closes the issue, and the measurement it was waiting for is then never taken, because nothing open asks for it.

**Enforced by.** Prose only.

**Class.** framework

## Release and deploy

### `K-SHIP-7` Release on every merge, or on the cadence the project declares

**Rule.** Every merge to the main branch produces a version and a release, and release tags drive the deploy, through the stages the project declares. A project whose releases other repositories pin may instead declare a **release cadence** under `## Choices` in its adoption record (`K-LAYOUT-10`), such as `` - **Release cadence:** `weekly, Monday` ``. Its merges then pool into the release pull request, which merges on the declared day, so a week's changes, breaking ones included, ship as one release. A fix that can't wait may release on another day, and the release pull request says why. A project that declares no cadence releases on every merge ([plan 0009](../docs/plans/0009-release-channels-and-api-key.md)).

**Why.** One merge, one version keeps every deployed build traceable to exactly one change, and removes "cutting a release" as a separate human task. A release that other repositories pin is different: each one is an upgrade every pinning repository has to review, and releasing on every merge sends them upgrades faster than they can. A framework that released on every merge once cut fifteen releases in a day, one in five of its releases asked its adopters to change something, and the upgrades reached them the day they were tagged. A declared day pools them into one, and is written where any reader looks, rather than kept by a maintainer's habit.

**Enforced by.** Kanon's reusable release workflow ([`release.yml`](../docs/release.md)), called on every push to the main branch, which first runs its merge-settings guard (`K-SHIP-3`) and then release-please; and Kanon's deploy lane ([plan 0010](../docs/plans/0010-deployment-lane.md), steps D4 and D5), which a published release triggers through the deploy caller `kanon init` writes: `deploy-release.yml` gates the release and builds it once, then `deploy.yml` deploys it to each environment the adoption record declares under `## Deploy` (`K-LAYOUT-10`), in order. A declared cadence is prose only: whoever merges the release pull request merges it on the declared day, and on Kanon's own record [`tests/unit/adoption-record.test.ts`](../tests/unit/adoption-record.test.ts) reads the bullet's shape.

**Class.** split. Releasing on every merge, and the release tool (release-please, with the changelog sections matching `K-SHIP-4`'s types), are framework. **The project supplies:** its stages, and its release cadence, if it declares one.

### `K-SHIP-8` A red main never deploys, and it reaches a human

**Rule.** Run the full test suite, heavy tiers included, on every release commit, in a concurrency group that nothing cancels. Deploy only when that run completes with every tier green, and announce a refusal. When the main branch goes red, file or update one de-duplicated issue for a human.

**Why.** A cancelled run reads as "not red" to anything that checks only for failure, and the reference adopter shipped a red main branch next to a deploy that way. The platform's failure notification goes to the actor who triggered the run, which stopped being a person once agents merge, so a red main branch otherwise notifies nobody.

**Enforced by.** The gate job of Kanon's deploy lane, `deploy-release.yml` with `scripts/deploy-gate.mjs` ([plan 0010](../docs/plans/0010-deployment-lane.md) §3, step D4), which deploys a release only when `ci.yml`'s `push` run on the default branch at the release's commit completed with every job `success`, waits for it while it runs, and refuses by name otherwise (`ci-red`, `ci-timeout`); each refusal files or updates the first environment's deploy issue, and `deploy.yml`'s `report` job files one per environment that fails. A workflow files or updates a single issue when the main branch goes red.

**Class.** split. Gating the deploy on the release commit's CI, and routing a red main to a human, are framework. **The project supplies:** its stages and its announcement channel.

### `K-SHIP-9` Promotion to production needs a human

**Rule.** Promotion to production is behind a required human reviewer on the deployment environment. Where the plan provides no environment reviewers, the fixed fallback applies: promotion is a manually triggered workflow that only the Maintainer may run (`K-ADOPT-3`).

**Why.** It is the one human gate that keeps bad code out of production however the merge was made, which is what makes an agent merger inside a green zone (`K-MERGE-1`) safe to run. Private repositories on the Team plan have no environment reviewers, so the gate needs a form that works there too.

**Enforced by.** A required reviewer on the production environment, the last of the chain the adoption record declares, which `deploy.yml`'s `deploy` job references, so the job waits for that reviewer before it runs ([plan 0010](../docs/plans/0010-deployment-lane.md) §4, step D4); `kanon doctor` blocks when production has no required-reviewers rule (`deploy.reviewers-missing`). Under the fallback, `deploy.yml`'s job deploys production only in a dispatch at the release's tag that the Maintainer named in the adoption record started (plan 0010 §13).

**Class.** framework

### `K-SHIP-12` A deploy runs no model, and holds its cloud credential only in an environment's job

**Rule.** No job of the deploy path runs an agent: no model, no agent action, no Claude credential and no App key. The cloud credential a deploy needs is obtained only in the job that deploys to one environment, which references that environment, by the project's deploy hook, through trust bound to that environment's identity: on GitHub, a role that trusts the OIDC subject naming the environment, so only a job that references it, after its protection rules pass, can assume it. The job that builds what every environment deploys holds no credential, no OIDC grant and no secret, and nothing is rebuilt per environment. The one secret the lane passes to a deploy, `KANON_DEPLOY_SECRET`, reaches the deploy hook's step alone; the only other secret the lane holds, the announcement's chat secret, reaches its `notify` job alone, which holds no cloud credential (`K-OBS-19`). Before anything builds, a probe outside every environment tries each declared environment's credential and must be refused for every one. Where the plan provides no environments, the fixed fallback of `K-ADOPT-3` applies, recorded as weaker, and the probe is skipped.

**Why.** The deploy path is where an instruction hidden in a release note, a commit message or a log would meet a cloud credential, and a model that reads text there can be steered by it; code that runs no model can only do what the reviewed commit says. A credential bound to an environment can't be reached by a pull request, by another workflow or by a job outside it, and only after the environment's reviewers approve, so the binding is a property of the platform rather than of every workflow being written carefully. Building in a job of its own keeps the build's tools and dependencies, which run code the project didn't write, away from the credential. The probe exists because no tool can read a project's cloud trust policy from outside: only a job that is refused proves the binding ([plan 0010](../docs/plans/0010-deployment-lane.md) §5, §9).

**Enforced by.** Kanon's deploy lane's guard test, `tests/unit/deploy-lane.test.ts` ([plan 0010](../docs/plans/0010-deployment-lane.md), steps D4 and D5): it fails when a job of either deploy workflow references an agent run, an agent action, a `CLAUDE_*`, `ANTHROPIC_*` or `*_PRIVATE_KEY` secret, any secret but `KANON_DEPLOY_SECRET` outside the deploy hook step's `env:` in `deploy.yml`'s `deploy` job and `KANON_CHAT_DEPLOY` outside the `notify` block's `secret` input in `deploy.yml`'s `notify` job, any declared `workflow_call` secret but `deploy.yml`'s optional `KANON_CHAT_DEPLOY`, or `id-token: write` on any job but `probe` and `deploy`; when the build job holds an environment, an OIDC grant or a secret; and when the probe passes on an answer other than `refused` for every environment. `K-AGENT-50`'s guard holds the probe, the build and the deploy job to no App token, `contents: read` and `persist-credentials: false`. For an adopter, `kanon doctor` reads the probe's line from the lane's latest counting run (`deploy.trust-unproven`) and blocks a custom OIDC subject template that leaves the environment out (`deploy.subject-custom`).

**Class.** split. The lane, its guards and the probe are framework. **The project supplies:** its build, deploy and smoke hooks, its environments, and each environment's cloud role, trusting that environment's subject.

## Reporting outward

### `K-SHIP-10` Announce each deploy once, and never confuse the two failures

**Rule.** Announce each landed deploy once, as a digest grouped by kind of change. A failure to announce is reported as an announcement failure, never as a deploy failure.

**Why.** In the reference adopter a timeout from the chat service raised a deploy-failure alert for a deploy that had succeeded, which is the kind of false alarm that teaches people to ignore real ones.

**Enforced by.** The `notify` job of `K-OBS-19`, in Kanon's deploy lane ([plan 0011](../docs/plans/0011-notifications.md) step N9, [plan 0010](../docs/plans/0010-deployment-lane.md) §8): each environment's call of `deploy.yml` writes one `deploy` message in its `announce` job (`scripts/announce-deploy.mjs`), naming the releases since the environment's previous successful deployment, so each landed release is announced once per environment, or the failure, `critical` for production; its `notify` job, a job of its own after the deploy, posts it. A failed post turns `notify` red and leaves the deploy's jobs green. `tests/library/announce-deploy.test.ts` holds the message and the range, and `tests/unit/notify-guard.test.ts` the `notify` job's shape.

**Class.** split. The mechanism is framework. **The project supplies:** its announcement channel (which service, and how it is wired, is the project's decision: its notify hook and the `deploy` kind's secret, recorded in the adoption record, `K-ADOPT-1` step 10) and its stages.

### `K-SHIP-11` The stakeholder digest leads with burndown, not activity

**Rule.** Send stakeholders a weekly digest led by progress against roadmap milestones, not by activity volume. Never list the Maintainer's own pending work in it; the one exception is the **decisions waiting for the Stakeholder** (`K-PRIN-18`), which lead the digest because they are the Stakeholder's own queue.

**Why.** Stakeholders need to know how close the launch is, and activity counts don't say that. Turning a digest into a list of the Maintainer's own queue is nagging, which the reference adopter rejected: automate agent behaviour, not reminders to humans.

**Enforced by.** The digest script computes progress with the shared milestone classifier (`K-WORK-3`). Leaving out the Maintainer's pending work is prose only; the decisions-waiting section is prose only, and a guard is planned.

**Class.** framework

## Examples from the reference adopter

- **Release tooling.** The reference adopter uses a release bot that opens a release PR on every merge and a tag-triggered deploy to staging. Production promotion is a separate workflow behind an environment reviewer.
- **Test tiers in preflight.** Lint, typecheck and unit tests always; the integration tier when the change touches the database or the service layer; end-to-end tests when the change is user-visible.
