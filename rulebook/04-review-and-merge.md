# 04 Review and merge

This chapter governs how a pull request gets from "opened" to "merged": how it asks for review, how its author answers review, what a reviewer's approval is worth, who may merge, and which changes always go to a human. Kanon's position is that review is adversarial and runs until approval, and that **every merge is made either by a human or by a merger agent inside a green zone the project defines**, with anything on an escalation path always going to a human (ADR 0004 §1). The rules here exist because the merge is the one step that cannot be undone by a later review, so the authority to make it has to come from a mechanism an agent can verify but cannot waive.

## Merge authority

### `K-MERGE-1` A human merges, or a merger agent merges inside the green zone

**Rule.** Every merge to the main branch is made either by a human, or by a merger agent acting inside a green zone the project defines. A change that touches an escalation path always goes to a human; which paths escalate is `K-MERGE-4`'s. Inside the zone, a reviewer agent's approval is enough to satisfy the repository's rules; outside it, a human merges. "A human merges everything" is a valid adoption: it is simply an empty green zone. (ADR 0004 §1)

**Why.** The reference adopter's documents said "a human approves every merge, no auto-merge ever" for weeks after an agent merger was running, so the old rule described nothing real. This rule describes what actually happens, raises the unit of human decision from a single PR to a whole project where the project wants that, and still gives the strictest teams exactly what they need. The repository must therefore not demand an extra human approval for AI-written changes, because that setting is the mechanical form of the empty zone and would make any non-empty zone impossible.

**Enforced by.** The merger calls a pure verdict function over the PR's state (author, reviews, checks, paths, labels, closing set, mergeability) and merges only when it returns "merge". Once bootstrap has ended, the repository ruleset requires an approving review, so nothing reaches the main branch without one (`K-MERGE-6`). During bootstrap there is no merger agent, so a human merges everything.

**Class.** split. The merger, the green-zone checks and escalation are framework. **The project supplies:** its escalation paths and the width of its zone.

### `K-MERGE-2` Start the zone narrow, and only a human widens it

**Rule.** Launch a merger agent with an aggressively narrow green zone. Widen it only by a human decision, made on evidence (false merges measured at zero). An agent never widens its own authority. (ADR 0004 §1)

**Why.** Authority is earned by evidence, and a zone that starts wide has nowhere to climb from. An agent that could widen its own zone would have authority nothing verifies.

**Enforced by.** Prose only.

**Class.** framework

### `K-MERGE-3` The green zone is a fixed set of checks, all read at the head commit

**Rule.** A merger may merge a PR only when every one of these holds:

1. the author is the implementer agent's identity, and the PR carries the implementer's label;
2. the reviewer agent's latest verdict **on the current head commit** is an approval; an approval on an earlier commit says nothing about the head;
3. every check has completed and passed, excluding the merger's own run and any job started by the same review event;
4. no changed path is on an escalation path (`K-MERGE-4`), and the PR carries no escalating label;
5. the squash commit would close exactly the issues the PR body declares (`K-SHIP-5`);
6. the platform reports the PR as cleanly mergeable.

The merge is pinned to the head commit the verdict read. If the head has moved, that is a wait, not a failure.

**Why.** Each check closes a hole that was hit. One PR merged on an approval of an earlier commit. Counting its own check run and the review event's jobs made the merger wait on itself, so every merge fell through to the hourly sweep. Pinning the head stops a commit pushed between the verdict and the merge from riding in unreviewed.

**Enforced by.** The merger's pure, unit-tested verdict function, and a merge call that names the expected head commit and fails if it has moved.

**Class.** split. The check set is framework. **The project supplies:** the identity and label names its agents use.

### `K-MERGE-4` The pipeline itself always escalates, and so do the project's high-risk paths unless its production promotion is human-gated

**Rule.** A PR always goes to a human if it changes **the pipeline itself**: CI and agent workflow files, the pipeline's scripts, or agent instructions and playbooks. It also goes to a human if it changes one of the project's own high-risk paths, which are escalation paths unless the project declares its production promotion human-gated (below). Match escalation paths against implementation code, not against documents that merely discuss the topic. Don't escalate spec files: specs are the deliverable of a planned project, reviewed against its approved plan. A spec edit that promotes an invariant to `[confirmed]` is the exception, and escalates (`K-SPEC-9`). Don't escalate a document only because an agent instruction or playbook links to it (the last row of `K-MERGE-17`'s table); a project that wants such a document to go to a human declares it as one of its own paths.

**A project whose production promotion is human-gated may take its high-risk paths off its escalation paths.** It declares so with the `Production promotion` bullet of its adoption record (`K-LAYOUT-10`, which fixes the bullet's shape), read from the default branch. Then its high-risk paths are not escalation paths, and a PR that touches one of them, and nothing else that escalates, merges in the green zone. These are still escalation paths, declared or not, because each decides how a PR is judged, or whether the promotion is gated at all, and a PR must never be able to change its own rules:

- every file under `.github/`: the workflows that run Kanon's lanes and pin its release, the project-setup hook, and the deploy workflow whose environment holds the human approval;
- every markdown file directly inside `docs/qa/`: the adoption record that makes the declaration, the escalation file, the identity register, the sign-off delegation and the playbooks. An adopter's rules are these declarations and the Kanon release its workflows pin; it never copies the rulebook (`K-ADOPT-10`);
- the agent instructions and agent configuration, `AGENTS.md`, `CLAUDE.md` and `.claude/`;
- the project's own pipeline code;
- a high-risk path the project marks `always` (`K-LAYOUT-8`): code outside `.github/` that keeps the promotion gated, such as infrastructure code that manages the environment's required reviewers, or the role trust that lets only the gated job deploy. Kanon can't tell which of a project's paths decide that, so a project that opts in marks them;
- a high-risk path that is also a judging input on the default branch (`K-MERGE-17`), such as a document the instructions link to that the project declared so a human approves changes to it.

The project briefs, the escalating labels and a spec promotion (`K-SPEC-9`) escalate as before. Without the bullet, the project's high-risk paths are escalation paths, marked or not.

**Why.** A PR can hollow out a required job while keeping its check name, and a merged bad pipeline script governs every later review, so the agent that merges must never be able to change what gates a merge. In the reference adopter a third of the implementer's PRs touched pipeline files. High-risk surfaces such as schema changes or payments code are where a wrong merge is most expensive, and an agent's willingness to stop is only a prompt, while escalation is a mechanism. Matching documents produced false escalations, and escalating specs made the merger decline every PR of the first planned project. Each over-broad entry interrupts a human and trains them to ignore the surface. Linked documents are the same trade: in the reference adopter the instructions link to eight project documents, including the observability guide that feature changes must update, and escalating them would have sent 97 of the 543 changes merged in two months to a human on that alone. The lanes that judge a PR still read every linked document from the default branch (`K-MERGE-17`), so no PR is judged by its own copy. What remains is that a merged change to one guides later reviews, and that change was itself approved by a Reviewer reading the default branch's instructions.

**Why a human-gated promotion may widen the zone.** Escalating a high-risk path puts a person between the merge and the main branch, but what a person is protecting is production. Where every production deploy already waits for a person's approval, that person still stands between a bad merge and production, later in the line: a wrong merge costs a revert and a broken staging environment, not an outage. In the reference adopter the merge gate fired about 30 times as often as the promotion gate, and was the gate that didn't scale. **The trade-off is that the human gate moves to the promotion.** The person approving a deploy approves every change in it at once, after the merge, and approves it far less closely than one PR's diff, so a wrong change on a high-risk path is caught later and more cheaply missed. The pipeline's own paths can't move with it: a merged change to them governs every later review and merge, and the deploy workflow decides whether the promotion is still gated, and no deploy approval undoes that. The same holds for code outside the pipeline that configures the gate, which is why the project can mark it to stay: a change that removes the gate is approved by no one, because the deploy it lets through no longer waits. It is a declaration, and nothing verifies that the environment holds a required reviewer that deploys can't skip; the record is where the claim is written, a PR that changes it escalates, and a project that can't stand behind it doesn't make it.

**Enforced by.** The merger's verdict function refuses any PR whose diff touches an escalation path: every file under `.github/`, every markdown file directly inside `docs/qa/`, the agent instructions and agent configuration (`AGENTS.md`, `CLAUDE.md` and `.claude/`, `K-LAYOUT-9`), and the project's own pipeline code and high-risk paths, read from `docs/qa/escalation-paths.md` on the default branch (`K-LAYOUT-8`, `K-MERGE-17`). A missing or malformed file stops the sweep by name rather than merging with no project paths applied. The Merger reads the production promotion from the adoption record on the default branch ([`scripts/lib/production-promotion.mjs`](../scripts/lib/production-promotion.mjs)), so a PR that declares it is judged without it. Declared, it drops the project's high-risk paths and keeps every other escalation, plus each high-risk path marked `always` and each judging input on the default branch that a high-risk path matches; a record it can't read, or a malformed bullet, stops the sweep by name, and the line naming the default or the widening is in every sweep's log and summary. [`lane-check`](../actions/lane-check/README.md) fails a malformed bullet on the PR that breaks it. [`tests/library/production-promotion.test.ts`](../tests/library/production-promotion.test.ts) pins each shape and the verdict either way. A parity test fails when a row of `K-MERGE-17`'s table names a path the pipeline's own escalations don't cover, and names the delegation row as the one row they deliberately don't.

**Class.** split. Escalating the pipeline, matching code rather than documents, never escalating specs, and what a human-gated promotion may and may not widen are framework. **The project supplies:** whether its production promotion is human-gated, its own pipeline code and its high-risk paths, kept under `## Pipeline code` and `## Escalation paths` in `docs/qa/escalation-paths.md` (`K-LAYOUT-8`) and filled in before the first brief is written.

### `K-MERGE-5` Merge through the front door

**Rule.** The merger is never a ruleset bypass actor; it merges only when the repository's own rules are satisfied. The reviewer agent has the access its approval needs to count toward those rules. The merger uses its own App token, never the platform's default workflow token, and fails rather than falling back when its credentials are missing.

**Why.** A bypass actor skips every required check, which makes one script the only guard on the main branch. A merge made with the default workflow token triggers no further workflows, so nothing releases and nothing deploys, and the failure is silent.

**Enforced by.** The ruleset's bypass list, and a merge step that refuses to run without its App token.

**Class.** framework

### `K-MERGE-6` The ruleset requires an approval on the current head

**Rule.** The main branch's ruleset requires one approving review, and dismisses an approval when a new commit is pushed. The requirement is switched on when bootstrap ends, and switching it on is what ends bootstrap (`K-ADOPT-6`); before then it stays off.

**Why.** An approval has to sit on the code that is merged. Without dismissal, a PR approved at one commit can merge at another. Before the Reviewer's App exists, the requirement would lock out a solo Owner, because GitHub refuses self-approval and the only permitted bypass is the release bot.

**Enforced by.** The repository ruleset.

**Class.** framework

### `K-MERGE-7` Use the platform's merge queue

**Rule.** Use GitHub's native merge queue where the plan provides it. Where it doesn't, use the fixed fallback: leave "require branches to be up to date" off, and let the release commit's full CI run (`K-SHIP-8`) catch a stale base before anything deploys. Either way, never require branches to be up to date before merging. ([ADR 0004 §2](../docs/decisions/0004-disputed-rules.md), amended by [ADR 0008 §2](../docs/decisions/0008-installation-test-decisions.md); `K-ADOPT-3`)

**Why.** Requiring an up-to-date branch, combined with dismissing approvals on every push (`K-MERGE-6`), makes the cost of review grow quadratically: every merge invalidates every other PR's approval. It once deadlocked merging for a day. A merge queue tests each change against the real result of merging without re-reviewing it. Kanon prefers a native platform feature to its own mechanism wherever one exists. The queue isn't available on every plan (private repositories on the Team plan lack it), and the fallback keeps the same property one step later: a stale base that breaks the main branch is caught before it deploys.

**Enforced by.** Kanon's own repository uses the merge queue: its main-branch ruleset has a merge-queue rule (squash, groups of one to five, only non-failing PRs merge), and "require branches to be up to date" is off. Every required check also runs on `merge_group` under the name it reports on the pull request, which [`tests/unit/workflows.test.ts`](../tests/unit/workflows.test.ts) pins. CI and the agent blocks and agent lanes smoke runs (plan 0001 §4) run in full on the queue's combined commit; the PR-title and DCO checks pass there, because a PR can only be queued once they have passed on it. The release PR runs no CI, so it can't be queued, and an admin merges it through the ruleset's pull-request bypass ([`docs/release.md`](../docs/release.md#known-limits)). For an adopter, `kanon init` reads the plan (`K-ADOPT-3`) and creates the default branch's ruleset with a merge-queue rule where the plan has the queue, and with "require branches to be up to date" off on the status check it requires. While a ruleset on the default branch has a merge queue, a job that reports `Lane check` counts only if its workflow runs on `merge_group` too: `kanon init` doesn't require the check until one does (`ruleset.require-check`), and `kanon doctor` reports the check unreported (`ruleset.check-unreported`; [`docs/doctor.md`](../docs/doctor.md#what-it-checks) item 7, [#459](https://github.com/yedeya-labs/kanon/issues/459)). The rest is prose only: neither command reports a ruleset that lacks the queue on a plan that has it, or that requires branches to be up to date (to a ruleset it didn't create, `kanon init` adds its check under that ruleset's own setting), and nothing checks that a required check other than `Lane check` runs on `merge_group`.

**Class.** framework

### `K-MERGE-8` The release bot is the only bypass, and it is bounded

**Rule.** The release bot is the only actor allowed to bypass the ruleset, and only to merge its own release PRs. Its diff is bounded to the release file set, and every commit on the main branch must have a PR. The one exception is the first commit and the installation commits made during bootstrap, each recorded in the adoption record (`K-ADOPT-4`, `K-ADOPT-5`).

**Why.** Once merging is unattended, the release bot is the one path to the main branch that nobody reads. Bounding it keeps that path from carrying anything but a release.

**Enforced by.** The ruleset's bypass list names only the release bot. Where an adopter runs the optional Releaser App, `kanon apps` adds it to the default branch's ruleset's bypass list, for pull requests only, and `kanon doctor` reports a ruleset that lacks it or lets another actor bypass (`ruleset.releaser-bypass-missing`, `ruleset.bypass-extra`; [#49](https://github.com/yedeya-labs/kanon/issues/49)). Restricting it to release PRs, the file-set bound and the every-commit-has-a-PR assertion are prose only; a guard is planned.

**Class.** framework

## The merger's behaviour

### `K-MERGE-9` Recover pipeline problems; escalate only decisions

**Rule.** Every merger run ends in one of a fixed set of outcomes: merge, wait, recover, escalate, skip, or release. A pipeline problem (a stale or misattributed approval, a review with no verdict) is recovered by the merger itself, for example by re-dispatching the reviewer. Only a decision a human can make is escalated. Skips and changes-requested states stay silent; every waiting PR is named in the run's summary.

**Why.** A refusal is only worth a human's attention if a human can fix it. Labelling routine states trains humans to ignore the label, and a wait that nobody can see is a PR parked forever.

**Enforced by.** The merger's verdict function returns only these outcomes, and its summary lists every waiting PR.

**Class.** framework

### `K-MERGE-10` Escalate once per head, and lift only your own escalation

**Rule.** Escalate with one PR comment and the `needs:human` label per rule and head commit; re-apply the label if it goes missing. A new commit re-opens the question. The merger may lift an escalation it applied for a head-specific reason once the head moves, but never a path, label or promotion escalation, and never a label a person applied.

**Why.** One comment plus a label is the cheapest surface that leaves a record on the PR itself. Without the lift, a PR whose author fixed the problem stayed parked on an escalation that no longer applied. A human's label is a human's decision, and the merger does not reverse it.

**Enforced by.** A per-rule, per-head marker in the escalation comment, and a fixed list of head-scoped reasons the merger is allowed to lift.

**Class.** framework

### `K-MERGE-11` A conflicting PR goes to the conflict resolver first

**Rule.** When a PR has merge conflicts, the merger waits until the conflict-resolution lane has attempted that head, and escalates only after it has. Recovery that re-triggers review is refused on a conflicting PR and reports the needed rebase instead. When CI seems not to have run on a PR, check whether it is mergeable before investigating the trigger. Treat "mergeability still computing" as proceed, and a mergeability field that cannot be read as an error.

**Why.** A PR with merge conflicts runs no pull-request workflows at all, because there is no merge ref to run them on. In the reference adopter, label churn on a conflicting PR fired 25 times and started no runs. And a merger that escalated a conflict immediately disqualified the lane built to resolve it.

**Enforced by.** One shared conflict-state module that every lane reads, and the merger's verdict function, which waits while the conflict lane has not tried the head.

**Class.** framework

### `K-MERGE-12` Verify the platform's side effects after merging

**Rule.** After a merge, check that the platform did what it should have (for example, that the linked issues were closed) rather than assuming it.

**Why.** Platform side effects run under the merger's identity and can fail silently. In the reference adopter, auto-closing linked issues quietly needed a permission the merger didn't have.

**Enforced by.** A post-merge check in the merger that reads the linked issues' state.

**Class.** framework

## Review

### `K-MERGE-13` Verify red-first on agent-written PRs

**Rule.** An agent-written PR must include a test that fails without the fix and passes with it. CI verifies this mechanically, and the agent cannot waive it. PRs written by humans are not subject to it. (ADR 0004 §7)

**Why.** Only agents claim to work test-first, and "I confirmed it was red" is the one step that leaves no artifact and is the most attractive to fake. Applied to human PRs, the check was measured blocking about half of them wrongly, because many real changes aren't observable by a test. A team that also wants it for humans may adopt that as its own practice; it is not a Kanon rule.

**Enforced by.** A CI check on agent-authored PRs that reverts the non-test part of the change, re-runs the changed tests, and fails when they still pass.

**Class.** framework

### `K-MERGE-14` Ask for review by label, and make sure it lands

**Rule.** Every PR that should be reviewed carries a review-trigger label; an unlabelled PR is never reviewed. After asking for review, watch for the verdict. A review that never landed is re-requested by re-applying the label once per head commit, only after CI has settled and a waiting threshold has passed. A red PR with no review verdict is reported; the implementer is not sent in without findings.

**Why.** The review lane is label-gated, so a missing label is a PR nobody will review. Reviews do fail to land (a dropped event, an outage, a crash), and in the reference adopter PRs sat green, labelled and unreviewed until someone noticed. Sending an implementer to "fix" a red PR with no findings repairs the wrong thing: the missing review is the problem.

**Enforced by.** The review workflow runs only on the trigger label; a recovery script re-applies it under the stated conditions; a warning-level check reports red PRs with no verdict.

**Class.** framework

### `K-MERGE-15` An author session never merges or force-pushes

**Rule.** A session that takes work to review (an interactive ship session or an agent author) never merges, and its tool allowlist never pre-approves a merge or a force-push. Never force-push over a branch a reviewer has read unless asked; resolve conflicts with a merge commit.

**Why.** Merging is the authority `K-MERGE-1` gives to someone else. In the reference adopter, prefix rules in an allowlist silently pre-approved `git push --force` and `gh pr merge`. A force-push detaches a review from the commits it cites.

**Enforced by.** A unit test that fails when the ship command's allowlist would permit a merge or a force-push. Not force-pushing over a read branch is prose only.

**Class.** framework

### `K-MERGE-16` Answer every finding, and stop when one survives two rounds

**Rule.** Answer each review finding by fixing it or by disagreeing openly with reasons; never comply silently with a wrong finding, and never ignore one. An approach the reviewer calls unverified is not an acceptance criterion. Don't absorb issues the reviewer filed as follow-ups into the current PR. When the same finding survives two pushes, stop and ask the human.

**Why.** A finding that survives two rounds is a substantive disagreement, and a third round of the same argument between two agents costs money without converging. The reviewer splits work into follow-ups on purpose, to keep the PR reviewable.

**Enforced by.** The agent revise lanes cap revision rounds and escalate after the cap. For human-driven sessions it is prose only.

**Class.** framework

### `K-MERGE-17` A pull request never chooses the rules it is judged by

**Rule.** A lane that judges a PR, rather than runs it, reads every trust-relevant input from the repository's **default** branch, never from the PR and never from the PR's base. The Reviewer is such a lane, and so is the Merger's verdict. The inputs are this one list:

| Input | Path | What a PR could do with its own copy |
|---|---|---|
| The project's agent instructions | `AGENTS.md` and `CLAUDE.md` (`K-LAYOUT-9`) | Tell the judge what not to check. Both are listed: `CLAUDE.md` imports `AGENTS.md`, so pinning one and not the other leaves the same gap by another route. |
| The agent configuration | `.claude/` | Change the judge's settings, permissions, hooks, skills, commands or subagents. |
| The identity register | `docs/qa/agent-identities.md` (`K-LAYOUT-6`) | Add an account to the repository's own agents, or change what a listed App may do. |
| The sign-off delegation | `docs/qa/sign-off-delegation.md` (`K-LAYOUT-14`) | Name its own author as the person who signs off for the repository's agents (`K-AGENT-44`). |
| The other pipeline documents | every other markdown file directly inside `docs/qa/` (`K-LAYOUT-1`) | Rewrite a playbook, the escalation paths and bail list (`K-LAYOUT-8`) or the capability ledger. |
| The project-setup hook | `.github/actions/project-setup` (plan 0001 §5) | Run before the agent, and change the tree or the tools it judges with. |
| Anything the inputs above delegate to | wherever they point | Reopen the gap one document over, through a file the judge was told to trust. |

The PR's own copy of each input is kept aside, so a change to one is still reviewed as part of the diff. An input the PR adds that the default branch lacks is not used. If the default branch's copy can't be read, the lane refuses to judge; it never falls back to the PR's copy, or to the base's.

**Why the default branch, not the base.** Usually they are the same branch, but not always. A stacked PR's base is another PR's branch, and that PR's author can write to it: they can add a register row or a delegation record there, and the PR stacked on top would then be judged by it. Only merged, reviewed changes reach the default branch.

**One exception: the specs.** The spec corpus under `docs/qa/specs/` is read from the PR (`K-SPEC-1`). A behaviour change ships its spec update in the same PR (`K-SPEC-10`), so the default branch's copy would flag a correct change as wrong. A spec change is judged as part of the diff, not used as the rules.

**Not covered.** A lane whose job is to run the PR's own code, such as one that verifies acceptance criteria by running the PR's hook and tests, reads them from the PR by design. The lane code itself (workflows, actions and pipeline scripts) comes from a pinned Kanon release (`K-ADOPT-11`), so an adopter's PR can't change it. Kanon's own PRs can, so Kanon calls its lanes at its previous release ([ADR 0011](../docs/decisions/0011-kanon-runs-its-own-lanes.md)). The same holds for the code of Kanon's own required checks: its DCO and PR-title checks run the last release, never the PR's copy, and the PR's copy runs beside them as a test that isn't required ([#47](https://github.com/yedeya-labs/kanon/issues/47)).

**Why.** A PR that edits the inputs of its own review can weaken that review, and then only the human merge is left to catch it. The reference adopter closed this one file at a time: the agent runtime restored `.claude/`, a script then restored the agent documents, and later the review read the register from base. Each gap was found separately, after it existed. One list closes the whole class, and a new input is added to the list rather than found by an incident.

**Enforced by.** For the identity register and the sign-off delegation as the `dco` check reads them, the check itself: it reads both from the default branch over the API (`K-AGENT-44`), and its tests fail when it reads them from the base. For the review lane, [`agent-review.yml`](../.github/workflows/agent-review.yml) (`K-AGENT-22`): one step restores this whole list from the default branch, from [`scripts/judging-inputs.mjs`](../scripts/judging-inputs.mjs), which holds the table row for row and closes it over the markdown documents the inputs link to or import. The same list decides which pushes re-open an approved review. [`tests/unit/judging-inputs.test.ts`](../tests/unit/judging-inputs.test.ts) fails when the list and this table disagree, and runs the lane's own restore step against a PR, stacked on a base whose author edited every input, that edits each input: the tree holds the default branch's copy and the PR's is set aside. The Merger's verdict reads the review, and moves at a later step. Its lane, [`agent-merge.yml`](../.github/workflows/agent-merge.yml), reads the escalation file over the API and the identity register from a checkout of the default branch, never the PR's merge ref, and [`tests/unit/merge-lane.test.ts`](../tests/unit/merge-lane.test.ts) fails when that checkout names another ref.

**Class.** framework

## Examples from the reference adopter

- **Escalation paths.** Beyond the pipeline itself, the reference adopter escalates infrastructure and cost configuration, database migrations and schema, and payments and authentication code. Documents about payments, and the spec corpus, are deliberately not on the list.
- **Launching the zone.** The reference adopter's zone admits only PRs authored by its implementer agent; a dependency-update bot's PR falls outside it.
