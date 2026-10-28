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
- `[LANE-12]` `[seed]` The revise lane's no-model fix (`fix-push`) commits through the verified-commit helper, so its commit is verified as the Author App's, and its `sha` and `base` outputs name the commit GitHub created and the head it was built on.

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

## Retired: the test-only choices

Project [#902](https://github.com/yedeya-labs/kanon/issues/902)'s draft brief seeded these for three adoption-record choices that would have let the end-to-end tier stub the model, lower a lane's ceiling and tag its rows. The Owner's no-leak rule of 2026-10-14 dropped all three: the tier adds no test-only switch to Kanon's product (plan 0012, decisions 6, 7 and 8). The clauses keep their ids, and nothing cites them.

- `[LANE-1]` `[retired]` With the adoption-record choice `Agent replay` set to `on`, `agent-run` runs no `claude-code-action` step and needs no Claude credential: it writes the recording's `execution_file` and applies the recording's effects with the minted App token.
- `[LANE-2]` `[retired]` `agent-run` refuses a recording made against a release other than the one it runs at.
- `[LANE-3]` `[retired]` Every comment a replayed run posts carries the replay marker, and the run's telemetry row is `tag: test`.
- `[LANE-4]` `[retired]` With the adoption-record choice `Run ceiling`, every lane's agent job passes `--max-budget-usd` as the lower of its own ceiling and the declared one, so a declared ceiling above a lane's own changes nothing.
- `[LANE-5]` `[retired]` With the adoption-record choice `Telemetry tag` set to `test`, every row the repository's lanes write carries `tag: test`.
