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

### `K-SHIP-7` Release on every merge

**Rule.** Every merge to the main branch produces a version and a release, and release tags drive the deploy to the pre-production stage.

**Why.** One merge, one version keeps every deployed build traceable to exactly one change, and removes "cutting a release" as a separate human task.

**Enforced by.** Kanon's reusable release workflow ([`release.yml`](../docs/release.md)), called on every push to the main branch, which first runs its merge-settings guard (`K-SHIP-3`) and then release-please; and a deploy workflow triggered by release tags.

**Class.** split. Releasing on every merge, and the release tool (release-please, with the changelog sections matching `K-SHIP-4`'s types), are framework. **The project supplies:** its stages.

### `K-SHIP-8` A red main never deploys, and it reaches a human

**Rule.** Run the full test suite, heavy tiers included, on every release commit, in a concurrency group that nothing cancels. Deploy only when that run completes with every tier green, and announce a refusal. When the main branch goes red, file or update one de-duplicated issue for a human.

**Why.** A cancelled run reads as "not red" to anything that checks only for failure, and the reference adopter shipped a red main branch next to a deploy that way. The platform's failure notification goes to the actor who triggered the run, which stopped being a person once agents merge, so a red main branch otherwise notifies nobody.

**Enforced by.** The pre-production deploy workflow's gate on the release commit's CI run, and a workflow that files or updates a single issue when the main branch goes red.

**Class.** split. Gating the deploy on the release commit's CI, and routing a red main to a human, are framework. **The project supplies:** its stages and its announcement channel.

### `K-SHIP-9` Promotion to production needs a human

**Rule.** Promotion to production is behind a required human reviewer on the deployment environment. Where the plan provides no environment reviewers, the fixed fallback applies: promotion is a manually triggered workflow that only the Maintainer may run (`K-ADOPT-3`).

**Why.** It is the one human gate that keeps bad code out of production however the merge was made, which is what makes an agent merger inside a green zone (`K-MERGE-1`) safe to run. Private repositories on the Team plan have no environment reviewers, so the gate needs a form that works there too.

**Enforced by.** A required reviewer on the production deployment environment, or, as the fallback, the promotion workflow's check that the actor who started it is the Maintainer.

**Class.** framework

## Reporting outward

### `K-SHIP-10` Announce each deploy once, and never confuse the two failures

**Rule.** Announce each landed deploy once, as a digest grouped by kind of change. A failure to announce is reported as an announcement failure, never as a deploy failure.

**Why.** In the reference adopter a timeout from the chat service raised a deploy-failure alert for a deploy that had succeeded, which is the kind of false alarm that teaches people to ignore real ones.

**Enforced by.** An announcement step that runs separately from the deploy and reports its own failures.

**Class.** split. The mechanism is framework. **The project supplies:** its announcement channel (which service, and how it is wired, is the project's decision, recorded in the adoption record) and its stages.

### `K-SHIP-11` The stakeholder digest leads with burndown, not activity

**Rule.** Send stakeholders a weekly digest led by progress against roadmap milestones, not by activity volume. Never list the Maintainer's own pending work in it; the one exception is the **decisions waiting for the Stakeholder** (`K-PRIN-18`), which lead the digest because they are the Stakeholder's own queue.

**Why.** Stakeholders need to know how close the launch is, and activity counts don't say that. Turning a digest into a list of the Maintainer's own queue is nagging, which the reference adopter rejected: automate agent behaviour, not reminders to humans.

**Enforced by.** The digest script computes progress with the shared milestone classifier (`K-WORK-3`). Leaving out the Maintainer's pending work is prose only; the decisions-waiting section is prose only, and a guard is planned.

**Class.** framework

## Examples from the reference adopter

- **Release tooling.** The reference adopter uses a release bot that opens a release PR on every merge and a tag-triggered deploy to staging. Production promotion is a separate workflow behind an environment reviewer.
- **Test tiers in preflight.** Lint, typecheck and unit tests always; the integration tier when the change touches the database or the service layer; end-to-end tests when the change is user-visible.
