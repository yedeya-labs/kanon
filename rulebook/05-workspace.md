# 05 Workspace

This chapter governs where work happens: the checkout, the database and the ports a piece of work runs against. Kanon's rule is **one issue, one worktree, one database**, because agents and humans work concurrently, and concurrent sessions sharing any piece of state don't just slow each other down. They silently corrupt each other's results: a test run can pass or fail on what a *different branch* did to the shared state thirty seconds earlier. The rules below make that impossible rather than unlikely, and make a broken workspace diagnose itself rather than look like a bug in the code.

## Isolation

### `K-WS-1` One issue, one worktree

**Rule.** Every issue is worked in its own worktree, created by the project's worktree script. Never run two sessions against the same checkout, never point two agents at the same file at once, and never provision a worktree by hand. The one exception: issues filed by the same audit may share one branch and ship as one squashed commit.

**Why.** Concurrent sessions in one checkout overwrite each other's files, branches and generated state. A worktree provisioned by hand has none of its isolation (no environment file, no database of its own) and quietly falls back to the shared state that the rule exists to avoid. Issues from one audit are usually small and adjacent, and splitting them would only multiply review rounds.

**Enforced by.** The ship step refuses to run from the main checkout. The rest is prose only.

**Class.** framework

### `K-WS-2` Each worktree gets its own state: a database, ports and an environment file

**Rule.** The worktree script provisions each worktree's own state: a dedicated database where the project has one, its own assigned ports for the dev server and the test server, and a worktree-local environment file recording both. Start servers through the script, and make every test and dev configuration read the worktree's environment file. Never hardcode a connection string or a port.

**Why.** Every checkout otherwise resolves to the same database. Schema changes are not additive across branches, so one session applying its migrations can break the invariants another session's tests are asserting, and those tests then pass or fail on another branch's schema. Fixed ports collide the moment two worktrees run servers. And isolation the test runner never reads is no isolation: a config that hardcodes a connection string sends every worktree back to the shared database.

**Enforced by.** The worktree script, which allocates a free port pair and creates the database when it creates the worktree. Reading the environment file from configs is prose only.

**Class.** split. Isolated per-worktree state and assigned ports are framework. **The project supplies:** its database engine and how to provision and migrate it.

### `K-WS-3` Copy dependencies only when they provably match

**Rule.** A new worktree may reuse the main checkout's installed dependencies only when both checkouts pin the same lockfile **and** the main checkout's installed tree matches it. Otherwise it does a clean install.

**Why.** Copying an installed tree that has drifted from its lockfile carries that drift into the new worktree, where it shows up as failures nobody can reproduce from a clean checkout.

**Enforced by.** The worktree script checks both conditions before copying.

**Class.** split. The rule is framework. **The project supplies:** its package manager's lockfile and clean-install command.

### `K-WS-4` Never commit runner environment files or test artifacts

**Rule.** Never commit CI runner environment files or test-run artifact directories.

**Why.** In the reference adopter a file literally named after a runner's output variable was committed and passed six green checks, because nothing looked for it.

**Enforced by.** A lint-time guard that fails when a runner environment file or a test-artifact directory is tracked.

**Class.** framework

### `K-WS-8` Name a branch `<type>/<number>-<slug>`

**Rule.** Name every working branch `<type>/<number>-<slug>`: `<type>` is one of the PR-title types (`K-SHIP-4`), `<number>` is the issue the branch works, and `<slug>` is a short lowercase, hyphenated form of its title. For example, `fix/42-empty-cart-total`. The worktree script derives the name from the issue.

**Why.** Tools find a branch's issue by its name: the worktree script resolves `--issue <n>` to its branch, and a branch whose issue can't be read from its name can't be matched to its merged PRs, which is how the script tells a leftover branch from a live one (`K-WS-6`). A branch named without a convention is also one a later session can't find.

**Enforced by.** The worktree script, which creates the name. Branches made by hand are prose only.

**Class.** framework

## Repair and removal

### `K-WS-5` Run the doctor before debugging a broken worktree

**Rule.** When a worktree misbehaves, run the worktree doctor before debugging anything. The doctor repairs provisioning (dependencies, environment file, the database, including migrating a database that has fallen behind its branch) and is safe to re-run. Don't push from a worktree the doctor has flagged until it is resolved.

**Why.** A half-finished install, a missing environment file and a database behind its branch all present as code bugs. In the reference adopter a database that had fallen behind produced 770 test failures across 114 files, all reporting a missing column, which reads as "my change broke everything" rather than as a setup problem.

**Enforced by.** The worktree script's doctor command.

**Class.** framework

### `K-WS-6` Tooling never moves a branch on a guess

**Rule.** The worktree script never moves a branch on its own. The doctor only *reports* a branch that has lost commits its remote holds, and prints a reset command only after asking the remote that the branch still exists there and matches the local record of it. When creating a worktree for a branch that exists only on the remote, check that branch out rather than creating a fresh one at the main branch. Ignore remote refs whose upstream branch was deleted. Refuse a leftover local branch of the same name unless it contains commits past every merged PR head for that branch.

**Why.** A fresh local branch pointing at the main branch, under the name of somebody's PR, looks correct everywhere: its diff is empty, a rebase says "up to date", and the listing shows the expected name. The natural next step is a push that force-pushes the main branch over the PR. A remote ref left behind by a merged and deleted PR has the same local signature as a wrecked branch, so offering a reset without asking the remote would reset onto a dead branch.

**Enforced by.** The worktree script's create and doctor commands, with a dry-run mode that prints how a branch name would resolve (local, remote or new) without touching anything.

**Class.** framework

### `K-WS-7` Remove a worktree only through the script

**Rule.** Remove a worktree with the worktree script, never by deleting its directory. The script refuses while there are uncommitted or unpushed changes, and drops the worktree's database and branch.

**Why.** Deleting the directory by hand leaves the worktree registration and an orphaned database behind, and can throw away unpushed work.

**Enforced by.** The worktree script's remove command.

**Class.** framework

## Examples from the reference adopter

- **Why the database matters there.** The reference adopter's database enforces tenant isolation with row-level security, and re-creating tables drops it. A sibling worktree's migration could therefore flip a tenant-isolation test from red to green, which is exactly the result the tests exist to be sure of.
- **Ports.** Dev servers are allocated from one range and end-to-end test servers from another, one pair per worktree, and both test runners load the worktree's environment file.
