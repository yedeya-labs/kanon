# Kanon's lanes

What Kanon's lanes do in an adopter's repository, where a project has needed a clause to cite. This area holds only the clauses projects have seeded so far; it is not a complete description of the lanes, whose contract is [`docs/lanes.md`](../../lanes.md) and the rulebook. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `LANE`

## How an Author lane commits

Seeded by project [#1373](https://github.com/yedeya-labs/kanon/issues/1373)'s brief, [`docs/projects/1373.md`](../../projects/1373.md). Every commit an Author lane puts on a pull request branch is created by GitHub through its API with the Author App's token, so GitHub verifies it as the App's, and the implementer status trusts that verification instead of an author email anyone with push access can set.

### The verified-commit helper

- `[LANE-6]` `[seed]` The verified-commit helper takes a local range of commits and, using the lane's App token, re-creates through GitHub's Git Data API each commit the repository does not already have, oldest first. A parent the repository already has is kept as it is, and any other parent is replaced by the commit re-created from it. The helper never re-creates a commit the repository already has, whoever wrote it, so a commit fetched from the remote keeps its own author and its own verification.
- `[LANE-7]` `[seed]` Each commit the verified-commit helper creates has the same tree id as the local commit it re-creates, so every path, its content, its deletion and its mode (`100644`, `100755`, `120000`) survive. The helper refuses a range that adds, changes or removes a submodule entry before it sends any request that creates an object.
- `[LANE-8]` `[seed]` Each commit the verified-commit helper creates carries the local commit's message byte for byte, its `Signed-off-by:` trailers included, and the helper sends no author, committer or signature field with it.
- `[LANE-9]` `[seed]` The verified-commit helper moves a branch only after it has read back every commit it created and found each one `verification.verified: true` with the App's bot account as its author and GitHub's `web-flow` or that bot account as its committer, as `[LANE-19]` and `[LANE-20]` read a commit. Any other answer moves nothing, and the helper fails naming the commit and GitHub's `verification.reason`, or the account that is not the App's.
- `[LANE-10]` `[seed]` The verified-commit helper moves a branch only from the head it was given. It creates a branch that doesn't exist, moves one that is still at that head without force, and refuses one that has moved. It forces a move only in its replace mode, which puts the branch on new commits over a commit on the default branch. It reports the branch's new head, each commit it created, and the head it built on. It reads and moves exactly the branch it was named, whatever characters git allows in that name (a `#` or a `%` included), and it refuses a name git doesn't allow for a branch before it sends any request.
- `[LANE-11]` `[seed]` The verified-commit helper uploads no blob whose id is already in a parent's tree, and it paces the requests that create objects. On a secondary rate limit it waits the time GitHub names and retries, within a fixed bound. A run that can't finish moves no branch.
- `[LANE-12]` `[seed]` The revise lane's no-model fix (`fix-push`) commits through the verified-commit helper, so its commit is verified as the Author App's, and its `sha` and `base` outputs name the commit GitHub created and the head it was built on. Re-run on its own, `fix-push` reads the files `fix-command` rewrote from the attempt `fix-command` ran in, of this run alone, with its own token.

### The lanes

- `[LANE-13]` `[seed]` In every lane that runs an agent under the Author App, the token the agent's job holds has neither `contents: write` nor `workflows: write`, so nothing the agent runs can move a branch. The agent commits locally, and its job hands the commits on as an artifact.
- `[LANE-14]` `[seed]` A push job runs after the agent's job, whenever that job left commits, including when it failed. The push job runs no agent and no project code, and checks out no branch but the default. It mints the Author App's token, narrowed to what the push uses, and moves the branch with the verified-commit helper.
- `[LANE-15]` `[seed]` For a lane whose agent opens a pull request, the push job opens it from the request the agent wrote: the branch, base, title, body and labels. It opens it only after it has moved the branch, and refuses a request whose branch is the default branch, or exists on GitHub when the push job reads it, unless it is the branch the lane names for its replace mode.
- `[LANE-16]` `[seed]` The implementer status reads the heads a run left, and the head it built on, only from the outputs of the push job and of `fix-push`, never from the agent's job.
- `[LANE-17]` `[seed]` The rebase lane resolves a conflict with a merge commit whose first parent is the pull request's head as its job fetched it, and whose second parent is the default branch's head that it merged. The push job creates that commit with the verified-commit helper and moves the branch without force.
- `[LANE-18]` `[seed]` The Lead's split lane and the metrics page commit through the verified-commit helper. The split's agent hands its commits to a push job, as the spine's lanes do, and a dead split branch is replaced in the helper's replace mode. The metrics page's fixed step creates its commit with the helper instead of `git push --force`.

### The implementer status

- `[LANE-19]` `[seed]` `carryDecision` carries `kanon/role: implementer` to a new head only when every commit on the first-parent path from that head back to the head the run started from is `verification.verified: true` with the Author App's bot account as its author and GitHub's `web-flow` or that bot account as its committer. A commit that isn't ends the chain, whatever email it carries, and no part of the decision compares a commit's author email.
- `[LANE-20]` `[seed]` In `open` mode, the implementer status sets `kanon/role: implementer` only on a pull request whose head commit is `verification.verified: true` with the Author App's bot account as its author and GitHub's `web-flow` or that bot account as its committer.

### The docs

- `[LANE-21]` `[seed]` `docs/lanes.md` says how an Author lane commits: the agent commits locally, and a push job re-creates each commit through the API. It gives an adopter's upgrade steps for the release that brings this. `SECURITY.md` no longer lists the implementer status's mid-run re-fetch gap as an accepted exposure.

## The upgrade lane

Seeded by project [#1718](https://github.com/yedeya-labs/kanon/issues/1718)'s brief, [`docs/projects/1718.md`](../../projects/1718.md). An adopter that opts in has each new Kanon release carried to its repository as an Implementer pull request: the pins, the plugin's `ref` and the callers, with what only a person can do held under `decision:needed`. The Reviewer reviews it, and a person, never the Merger, merges it.

### The choice and the target

- `[LANE-22]` `[seed]` The adoption record opts a repository in with one bullet under `## Choices`, ``- **Kanon upgrades:** `stable` `` or `` `candidates` ``, read from the default branch by one reader that the upgrade lane, `lane-check` and `kanon doctor` share. `off`, a record without the bullet, and no record all mean off. A bullet outside `## Choices`, written twice, or with any other value is malformed: the lane files nothing and names it, and `lane-check` fails it.
- `[LANE-23]` `[seed]` Under `stable`, the upgrade's target is Kanon's latest stable release, as GitHub's latest release of Kanon's repository names it. Under `candidates`, it is the later of that release and the newest `candidate-vX.Y.Z` whose commit carries a completed, successful `kanon-e2e` check run created by the Reporter App, matched by the App id the App register records; a `kanon-e2e` check run from any other App is ignored, and a candidate without the Reporter's is never a target. A target is always later than the one release the callers pin, and a candidate is never a target once its own `vX.Y.Z` exists. With no exact pin, or more than one, there is no target, and the lane says why.
- `[LANE-24]` `[seed]` No part of the upgrade lane, its choice's reader or its target reads the repository's name or owner. Kanon's own repository is held to the same code, and its pin job and Dependabot entry are unchanged by this project.

### The lane

- `[LANE-25]` `[seed]` The upgrade lane runs no model. It runs on a daily schedule and on dispatch, behind the membership gate (`K-AGENT-45`). When the repository opts in and a target exists, it files one issue titled `Upgrade Kanon to <target>`, carrying a marker that names the target, on the Development Automation milestone, and labels it `agent:implement`. When it doesn't opt in, the lane files, labels and closes nothing, and its summary says so.
- `[LANE-26]` `[seed]` The upgrade lane keeps at most one open upgrade issue. On a newer target, it retargets an open upgrade issue that no open pull request closes (its title, its marker and a comment), and on one that a pull request already closes, it comments once naming the newer release and changes nothing else. It never labels an issue that carries `decision:needed`.

### The Implementer's upgrade

- `[LANE-27]` `[seed]` On an issue carrying the upgrade marker, the Implementer moves every Kanon pin and the declared plugin `ref` to the marker's target with the edit `scripts/move-pins.mjs` makes, and applies each caller change that `kanon doctor --to <target> --json` and the target's `lane-check` name and that a file edit makes: a secret mapping, a `permissions:` block, an input, a trigger, a notify hook's pin, a declaration bullet that moved. It changes no other file, and no other line of those it edits.
- `[LANE-28]` `[seed]` A step only a person can do (a secret's value, an App's permission or installation, an intake deploy, an answer to a question the target's `kanon init` adds) is never done or guessed by the Implementer. One needed before the merge stops the run as a scope-first bail that lists every such step, so the issue waits under `decision:needed` (`K-AGENT-13`, `K-WORK-24`), and the run a member's reply restarts reads that reply as the answer. One that waits for the merge goes in the pull request's `## After merging`. A caller change the target's doctor or `lane-check` names is not on its own a reason to bail.
- `[LANE-29]` `[seed]` The upgrade pull request is titled `ci(deps): upgrade Kanon to <target>`. Its body closes the upgrade issue, links the release notes of each release after the pin up to the target, lists under `## Left to do` each person's step skipped and under `## After merging` each that waits for the merge, names any Dependabot pull request it replaces, and says that a person merges it.

### Dependabot

- `[LANE-30]` `[seed]` With the repository opted in, an open Dependabot pull request that only moves Kanon's references, as `lane-check` tells one, is named on the upgrade issue for its release, which the lane files if none is open. Once an upgrade pull request for that release or a later one is open, the lane closes Dependabot's with a comment linking it. The lane and the Implementer never push to Dependabot's branch.
- `[LANE-31]` `[seed]` With the repository opted in, `lane-check` and `kanon doctor` accept a `github-actions` entry that ignores every Kanon update in place of the Kanon entry `K-ADOPT-11` requires, and doctor notes, without blocking, an entry that still proposes Kanon beside the opt-in, with the `ignore` that turns it off. Without the opt-in, both hold the entry exactly as before.

### Review, revision and merge

- `[LANE-32]` `[seed]` On a pull request that closes an upgrade issue, the Reviewer reads the release notes of each release after the base's pin up to the target and the pull request's `Lane check`, and requests changes for a caller change a release asks for that the diff lacks, and for any change outside the pins, the plugin `ref`, the callers and the declarations the target asks for.
- `[LANE-33]` `[seed]` A change request on an upgrade pull request, which the revise lane's own triggers refuse because the pull request moves the pin (`K-MERGE-17`), is revised by a dispatch of the revise lane from the default branch, made at most once per change request by a fixed step with a token narrowed to what that step uses; no agent's token holds Actions write.
- `[LANE-34]` `[seed]` The merge gate never merges an upgrade pull request: its pins are under `.github/` and `.claude/` (`K-MERGE-4`), and the sweep's summary names it as waiting for a person.

### Install and checks

- `[LANE-35]` `[seed]` `kanon init` asks whether to follow Kanon's releases (off, stable, or stable and candidates), off unless chosen, offered only with the implement and review lanes. On a yes it writes the upgrade lane's caller and the `Kanon upgrades` bullet. The upgrade skill asks it as a new question, as it asks every answer an earlier install never gave.
- `[LANE-36]` `[seed]` `lane-check` and `kanon doctor` hold the choice and the callers to each other: `stable` or `candidates` with no caller of the upgrade lane, or a caller with the choice off, fails `lane-check` and is a blocking doctor finding, each naming the bullet and the caller.
- `[LANE-37]` `[seed]` `docs/lanes.md`, `docs/install.md` and the upgrade skill say what the upgrade lane does, how to opt in and choose candidates, that a person merges its pull request, how it treats Dependabot's pull request and how to turn Dependabot's `kanon` group off.

## Retired: the test-only choices

Project [#902](https://github.com/yedeya-labs/kanon/issues/902)'s draft brief seeded these for three adoption-record choices that would have let the end-to-end tier stub the model, lower a lane's ceiling and tag its rows. The Owner's no-leak rule of 2026-10-14 dropped all three: the tier adds no test-only switch to Kanon's product (plan 0012, decisions 6, 7 and 8). The clauses keep their ids, and nothing cites them.

- `[LANE-1]` `[retired]` With the adoption-record choice `Agent replay` set to `on`, `agent-run` runs no `claude-code-action` step and needs no Claude credential: it writes the recording's `execution_file` and applies the recording's effects with the minted App token.
- `[LANE-2]` `[retired]` `agent-run` refuses a recording made against a release other than the one it runs at.
- `[LANE-3]` `[retired]` Every comment a replayed run posts carries the replay marker, and the run's telemetry row is `tag: test`.
- `[LANE-4]` `[retired]` With the adoption-record choice `Run ceiling`, every lane's agent job passes `--max-budget-usd` as the lower of its own ceiling and the declared one, so a declared ceiling above a lane's own changes nothing.
- `[LANE-5]` `[retired]` With the adoption-record choice `Telemetry tag` set to `test`, every row the repository's lanes write carries `tag: test`.
