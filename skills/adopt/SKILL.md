---
name: adopt
description: Install Kanon in the repository of the current checkout, new or already in use, by driving `kanon init --json`. Inspects first with a dry run, asks every choice as a multiple-choice question with its recommended option and what it means, writes the files, walks the person through each step only a person can take (creating the Apps, the secrets, the ruleset) when it comes up, recording any they skip, opens the pull request, then hands over to the doctor skill until the installation is healthy. Use when the person asks to install, adopt or set up Kanon.
disable-model-invocation: true
---

# Adopt Kanon

You install Kanon in the repository whose checkout you are in, with the person deciding every choice. You drive `kanon init` through its JSON output only (`docs/init.md` in Kanon's repository, read at the release in the `npx` line below, `https://github.com/yedeya-labs/kanon/blob/<release>/docs/init.md`, never at `main`, whose contract may be newer), and you never read its prose to decide anything. A repository that already has its own CI, rulesets and labels is the normal case: `init` merges into what is there, and its dry run names every change before you make one.

## How to run `kanon`

Run every `kanon` command in this skill, and every one a finding's fix names, from the repository's checkout, through the release this skill ships in. That release is the one every reference `init` writes is pinned to:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.35.0 kanon init --dry-run --json
```

<!-- x-release-please-end -->

Below, `kanon …` means that `npx` line with the rest of the command in place of `init --dry-run --json`. Read only standard output, which is one JSON document. Standard error is the prose a person reads, and `kanon apps` prints there too: show it to them if it helps, but never decide anything from it.

## Ground rules

- **Never merge.** Never approve a pull request, never push to the default branch (except the first commit of an empty repository, below), and never bypass a ruleset. You open the pull request; a person merges it.
- **Never print a secret.** Never run `gh auth token`, never echo or print an environment variable that holds a token, never read, print or move a private key (`*.pem`), and never put a secret's value in a command line. The document names whose token `init` used (`.token.source`, `.token.login`), never the token: say whose it is, and nothing more.
- **Only a person can** click **Create** and **Install** for a GitHub App, generate an App's private key, type a secret's value, create a ruleset when their token can't, and name the project's people. Say so plainly, give them the exact step, and wait for them to say it's done. Never pretend to have done one of these, and never work around one.
- **Explain, then ask, then act.** Nothing changes before the person has seen the dry run and said yes.
- **The person signs off.** Commit with `git commit -s` under the person's own git identity. Never sign off as yourself: Kanon's DCO check rejects an AI sign-off.
- **The contract is `kanon-init/v1`.** If the document's `.schema` is anything else, stop and tell the person this skill and the command disagree. Ignore a field you don't know. A finding whose `.findings[].id` is not in the table below is newer than this skill: show the person its `.findings[].message` and `.findings[].fix`, and do nothing else with it.

## How to ask

The person decides every choice, as a question in their agent client ([#428](https://github.com/yedeya-labs/kanon/issues/428)):

- **In Claude Code, ask with its question tool** (`AskUserQuestion`): multiple choice, up to four questions at a time, two to four options each. **The recommended option comes first,** its label ending in `(Recommended)`, and **each option's description says what choosing it does.** A question about several things that can all be chosen, such as a group of lanes, is a multi-select question. A value only the person can type (a login, a name, an email, a command) is the tool's own free-text answer, with the inferred value as the recommended option.
- **In another agent client,** ask with its own multiple-choice question in the same shape. If it has none, write the options as a numbered list in one message, the recommended one first and marked, each with its consequence, and wait for the answer.
- **Never ask for a comma-separated list,** and never fill in an answer the person didn't give or confirm: no silent defaults. You build each flag from their answers; they never type a flag.
- **Infer the recommended option** from `.inspection`, the answers already given and the checkout, as each question below says, and say in one line why it is recommended.
- **Keep a list of the answers and of what the person skipped,** for the pull request (step 9) and for the doctor skill.

## Steps only a person can do

Some steps are the person's alone (**Only a person can**, above): creating and installing the Apps, giving their token a permission it lacks, a ruleset step the token can't take, typing a secret's value. Walk each through **when it comes up,** never as a list for later:

1. Say what the step is, why it is needed, and what is left undone without it.
2. Ask, as a question: **Do it now** (Recommended), and tell me when it's done; or **Skip it for now**, and the step is recorded as left to do.
3. On **Do it now**, give the exact step (the finding's `.findings[].fix.text`, its `.findings[].fix.commands` and `.findings[].fix.url`), and wait for the person to say it's done. Check it where you can: a dry run again, `gh secret list`, or the doctor skill.
4. On **Skip it for now**, add it to the skipped list with the finding's id, and go on. Never pretend it was done.

## Running `kanon apps`

`kanon apps` creates GitHub Apps and writes the repository's Actions secrets, so **it is the person's step,** whoever types it: say so as soon as a finding's fix (`app.create`, `app.failed`, `app.reuse`) names it ([#420](https://github.com/yedeya-labs/kanon/issues/420)). Your agent client may refuse to run it for you, and the person clicks **Create** and **Install** in their browser anyway. Before you hand it over:

1. **Check the token first.** Run `kanon apps --owner <owner> --repo <repo> --preflight`. It creates no App, opens no page and writes no file: it checks the checkout, the token and the owner, and sets and deletes a throwaway secret, `KANON_APPS_PREFLIGHT`, because GitHub has no read-only way to show that a token can write secrets. If your client won't run it either, the person runs it as the line below, with the pre-check's flag in place of the App flags. On exit 1, say what it said, and name the permission: the token `gh` uses (`GH_TOKEN`, then `GITHUB_TOKEN`, then its stored login) needs **Secrets: read and write** on the repository, for a fine-grained token the repository permission *Secrets* set to *Read and write*. Fixing the token is a step only a person can do. Run the check again once they say it's done.
2. **Give the exact line,** every placeholder filled in: the checkout's root (`git rev-parse --show-toplevel`), and after `kanon` the command the fix names, flag for flag. In Claude Code the person types it at the prompt, `!` first, which runs it in this session; in another client they run it in their own terminal, without the `!`:

<!-- x-release-please-start-version -->

```sh
! cd <the checkout's root> && npx --yes --package github:yedeya-labs/kanon#v0.35.0 kanon apps --owner <owner> --repo <repo> --apps <apps>
```

<!-- x-release-please-end -->

3. **Say what else it changes, before they run it.** When the command creates or reuses the Releaser, it also edits the default branch's rulesets with the person's token: it adds the Releaser App to the bypass list of each repository ruleset that covers the default branch, for pull requests only, and removes nobody (`K-MERGE-8`; step 7 of `docs/apps.md` in Kanon's repository). Where the token can't edit a ruleset, or it is an organisation's, it changes nothing there and prints the step instead.
4. **Ask, then wait.** **Do it now** (Recommended), and tell me when it's done; or **Skip it for now**, recorded under `## Left to do` with the finding's id. When it's done, check it: `gh secret list`, the register rows it wrote in `docs/qa/agent-identities.md` (they go in the commit), or the doctor skill. When it exits non-zero, ask what it said, and give the line again once they've fixed it.

## The questions

Ask them in this order, each as **How to ask** says. One answer of `kanon init` is one question, except the lanes, which are one question per group. Each says where its recommended option comes from, and the flag each answer becomes.

### `.answers.projectOwner`: who is the Owner?

The Owner decides product questions, accepts what the rulebook gives a person to accept, and merges what the agents can't. The adoption record names them.

- **Recommended:** the login whose token runs `kanon init` (`.token.login`), which is the dry run's `.answers.projectOwner`.
- **Options:** that login (`--project-owner <login>`); or someone else, typed (`--project-owner <who>`): a GitHub login, or a name.

### `.answers.maintainer`: who is the Maintainer?

The Maintainer keeps the pipeline running: the lanes, the Apps, the secrets, the upgrades.

- **Recommended:** the Owner just named, as it often is.
- **Options:** the Owner (`--maintainer <owner>`); or someone else, typed (`--maintainer <who>`).

### `.answers.stakeholder`: who is the Stakeholder?

The Stakeholder places work on the roadmap and decides what is a gate candidate.

- **Recommended:** the Owner.
- **Options:** the Owner (`--stakeholder <owner>`); or someone else, typed (`--stakeholder <who>`).

### `.answers.lanes`: which lanes, a group at a time

The lanes are the agents' workflows. Ask one question per group of `.catalogue`, in its order, as a multi-select question headed with the group's `.catalogue[].header`; for a group of one lane, ask **Install it** or **Not now** instead.

- **Options:** each lane of `.catalogue[].lanes`, chosen into `--lanes <list>`: its `.catalogue[].lanes[].name` as the label, and as the description what it does (`.catalogue[].lanes[].does`), what it needs (its App, `.catalogue[].lanes[].app`; its secrets beyond the App's, `.catalogue[].lanes[].secrets`; the QA store, `.catalogue[].lanes[].qaStore`; its hooks, `.catalogue[].lanes[].hooks`; its schedule, `.catalogue[].lanes[].schedule`; and `.catalogue[].lanes[].needs`) and what it costs (`.catalogue[].lanes[].cost`), shortened to fit, with `.catalogue[].lanes[].when` in one line.
- **Recommended:** each lane whose `.catalogue[].lanes[].recommended` is true (the review lane, and every lane the repository already calls, `.catalogue[].lanes[].installed`), and each lane whose `.catalogue[].lanes[].recommendedWith` names a lane the person chose in an earlier group. A lane recommended with one beside it in the same group says so in its description. Where `.catalogue[].lanes[].when` names a condition you can read from an answer already given, such as a Stakeholder who isn't the Owner for the weekly digest, apply it. The recommended lanes are listed first.
- **Through a merge queue** (`.inspection.defaultBranchMergeQueue` is true), a lane with a `.catalogue[].lanes[].mergeQueue` says it in its description: a merge doesn't start it, so it runs on its schedule or when dispatched. Say it again before the person chooses, in one line, so they choose knowing it ([#452](https://github.com/yedeya-labs/kanon/issues/452)).
- **The review lane stays first and recommended:** its App's approval is what ends bootstrap. If the person leaves it out, say what that means and ask once more.
- **A lane the repository already calls** (`.inspection.installedLanes`) that the person leaves out is not uninstalled by `kanon init`: say so.
- **The flag:** every lane chosen, in every group, as one `--lanes <list>`, by the names in `.catalogue[].lanes[].lane`. At least one lane must be chosen.

### `.answers.gates`: the stack's gates

The commands a change must pass before it is done, in order. They go under `## Gates` in `docs/qa/stack.md`, which every lane that changes code reads.

- **Recommended:** the commands `kanon init` suggested from the repository, the dry run's `.answers.gates`, each kept.
- **Options:** a multi-select of the suggested commands, each one kept when chosen, and the free-text answer for one to edit or add. With none suggested: **None yet** (`--gates none`), recommended, which leaves the section saying so; or the commands, typed one at a time.
- **The flag:** `--gates <list>` from the commands kept, in order, or `--gates none`.

### `.answers.testDatabase`: does a lane need a test database?

- **Recommended:** **No** (`--test-database none`), unless the checkout shows its tests need a database: a database service in a compose file, `DATABASE_URL` in an example environment file, a migrations directory. Then **Yes**.
- **Options:** **No** (`--test-database none`): no lane starts one. **Yes** (`--test-database hook`): `init` writes `docs/qa/test-database.md`, and your project-setup hook must start the database and write `DATABASE_URL`.

### `.answers.delegation`: who signs off the agents' commits?

An agent can't sign off its own commits, so a required DCO check fails them unless one named person takes responsibility for them (`K-AGENT-44`).

- **Recommended:** **Yes** when a chosen lane runs as the Author App (`.catalogue[].lanes[].app` is `author`) and the repository runs Kanon's DCO check (a workflow that uses `yedeya-labs/kanon/actions/dco`); otherwise **No**.
- **Options:** **Yes** (`--delegation`): `init` writes `docs/qa/sign-off-delegation.md`, and the agents' commits carry that person's sign-off. **No** (`--no-delegation`): an agent's commit fails a required DCO check.
- **Options on Yes,** two more questions: the delegate's name, recommended from `git config user.name` (`--delegate-name <name>`), and their email, recommended from `git config user.email` (`--delegate-email <email>`), each confirmed or typed. Say that the delegate signs off every agent commit, so it is a person who accepts that.

### `.answers.deleteDefaultLabels`: GitHub's default labels

Kanon's label taxonomy replaces GitHub's default labels it doesn't use, such as `good first issue` and `wontfix`.

- **Recommended:** **Delete** when the repository has no commit yet (`.inspection.hasCommits` is false), so nothing uses them; otherwise **Keep**, because issues may carry them.
- **Options:** **Delete** (`--delete-default-labels`): `init` deletes those in `.inspection.labels` that the taxonomy doesn't hold, and the issues that carry one lose it. **Keep** (`--keep-default-labels`): they stay beside the taxonomy.
- **When `.inspection.labels` holds none of them,** there is nothing to choose: say so, and pass `--keep-default-labels`.

### `.answers.releaser`: the optional Releaser App

Asked only when `.inspection.callsRelease` is true. Otherwise there is nothing to choose: say so, and pass neither flag.

- **Recommended:** **Yes** when `.inspection.rulesets` is `yes`, because a release pull request opened without an App runs no CI, so a ruleset that requires checks blocks it unless an admin bypasses it; otherwise **No**.
- **Options:** **Yes** (`--releaser`): `kanon apps` creates a third App, the Releaser, which opens the release pull requests so their CI runs, and becomes the ruleset's only bypass actor (`K-MERGE-8`). **No** (`--no-releaser`): release pull requests keep being opened with the workflow's token.

### `.answers.reuseApps`: reuse an App the owner already has

An owner has one Author and one Judge (and at most one Releaser), reused across its repositories (plan 0005 §3.2). `.inspection.ownerApps` lists those the owner already has, found by their installations' permissions, and only the owner's own Apps, never another account's ([#462](https://github.com/yedeya-labs/kanon/issues/462)), that this repository's register doesn't name ([#363](https://github.com/yedeya-labs/kanon/issues/363)). Ask only when it names an App that a chosen lane runs as (`.catalogue[].lanes[].app`), or the Releaser when the person chose it; name each by its `app` and `slug`. Otherwise there is nothing to choose: say so, and pass neither flag. When `.inspection.ownerApps` is null, the token can't list the owner's installations (`.notes` says why): ask the person instead whether the owner already has these Apps, as step 7 says.

- **Recommended:** **Reuse**, because a second set doubles the Apps and private keys the owner manages, for the same permissions.
- **Options:** **Reuse** (`--reuse-apps`): `kanon init` creates none of those Apps; each becomes the finding `app.reuse`, its `kanon apps --reuse` command with the slug filled in, which step 7 walks the person through as **Do it now** or **Skip it for now**: add this repository to the App's installation, generate a private key on its settings page, and run the command with the key file. **Create new ones** (`--no-reuse-apps`): `kanon apps` creates a second App of each kind for this repository, with its own key, and the owner then manages both.

### `.answers.plugin`: declare this plugin in the repository

- **Recommended:** **Yes**, unless the person says nobody here uses Claude Code.
- **Options:** **Yes** (`--plugin`): `init` writes `.claude/settings.json` declaring the kanon plugin at this release (or, when the file exists, the finding `plugin.declare` gives the keys to merge), so everyone who uses Claude Code here gets these skills once they trust the folder, and doctor checks the release against the pins. **No** (`--no-plugin`): each person installs the plugin themselves, and nothing checks its release.

### `.answers.telemetry`: send run rows to Kanon's telemetry store

Off unless the person says yes. Say, in the question itself, everything the person needs to decide:
- **What is sent:** one row per agent run, plan 0002's fixed fields (the lane, the outcome, the model, cost, tokens, durations and counts, the run, pull request and issue numbers, the Kanon release). No code, no text, no logins, no file paths.
- **Where it goes:** one table in Kanon's AWS account in Frankfurt (eu-central-1), under an opaque key, kept 13 months.
- **Who reads it:** Kanon's operator, to improve Kanon, who publishes only aggregates that at least three adopters contribute to; the repository's own reader role reads only its own rows.
- **How to stop and erase:** delete `.github/workflows/telemetry.yml`; the operator erases what was sent on request (`docs/telemetry.md` in Kanon's repository, "Erase an adopter").
- **What is left after a yes:** the operator registers the repository and gives the values of two repository variables; until then the collector skips, green. On a private repository each hourly run costs about an Actions minute.

- **Recommended:** **No**. Telemetry is never recommended for the person: it is theirs to offer.
- **Options:** **No** (`--no-telemetry`): nothing is written and nothing is sent. **Yes** (`--telemetry`): `init` writes the collector's caller, and the finding `telemetry.register` is the operator's step, walked through as a step only a person can do: the person files the registration issue the fix's page opens (it is public and names the repository; for a name that must stay private, the issue's form says what to do instead), then sets the two variables the operator gives them.

## Steps

1. **Check where you are.** A git checkout of the repository to install in (`git rev-parse --show-toplevel`), `gh` signed in, and Node 24 or later. If the working tree has changes, ask the person to commit or stash them first; never do either yourself.

2. **Inspect, changing nothing.** `kanon init --dry-run --json`. Read `.status` and `.exitCode` (the table below). Then tell the person, in plain words:
   - the repository (`.repository`), whose token is used, and whether it can administer the repository (`.inspection.admin`);
   - the account (`.inspection.owner`, `.inspection.ownerKind`), and what its plan allows: `.inspection.rulesets` of `no` means nothing on the platform enforces review, so the Owner's discipline does (say this one clearly); `.inspection.mergeQueue`, and whether the default branch merges through a merge queue (`.inspection.defaultBranchMergeQueue`); and every line of `.notes`;
   - what is already there: the lanes it already calls (`.inspection.installedLanes`), its rulesets (`.inspection.defaultBranchRulesets`, `.inspection.inactiveRulesets`), whether it has a commit yet (`.inspection.hasCommits`).

   If `.inspection.admin` is false, the token can't create the ruleset or set the merge settings: say so now, and ask, as a step only a person can do, whether they want to run with a token that can (then they set `GH_TOKEN` in their own terminal and start again) or go on and take those steps later.

3. **Ask the questions** ("The questions", above), in their order, as **How to ask** says. Every answer of `.answers` gets a question; none is taken from its default unasked.

4. **Show what the answers do.** Run the dry run again with every flag the answers gave, and show the person every file it would write (`.files[].path` with `.files[].status`; for a file that `differs`, show `.files[].diff` and say `init` leaves it alone, so it is the person's to reconcile) and every change it would make on GitHub (`.changes[].message`). Then ask: **Go ahead** (Recommended), or **Change an answer**, which asks that question again. When a lane's caller `differs` because its lane's file name holds something that isn't a caller of that lane, such as the lane itself in a repository that hosts Kanon's lanes, ask where its caller goes ([#451](https://github.com/yedeya-labs/kanon/issues/451)): **Another path** (Recommended), typed: once `init` has written (step 6), you write the caller's `.files[].content` and, under `## Choices` in `docs/qa/adoption.md`, a `Waived doctor finding` bullet for `caller.misplaced` on that path with the person's reason (the shape `docs/doctor.md` gives), after which every run of `init` compares the caller there; or **Leave it out**, and the lane leaves `--lanes`.

5. **Make a branch.** If `.inspection.hasCommits` is false, the repository is in bootstrap and its first commit goes straight to the default branch (`K-ADOPT-4`): say so. Otherwise create `kanon/adopt` from the default branch.

6. **Write.** `kanon init --json --no-apps` with the person's flags. `--no-apps` leaves the Apps to step 7, so you can explain them first. Read `.status`: on `failed`, show `.failures` and what it did (`.changes`), and stop; on `error`, show `.error` and stop. Show the person `git status` and the diff.

7. **The Apps,** a step only a person can do. Each finding `app.reuse` (an App the owner has, `.apps.reuse`) is walked through first, as its row below says. When `.apps.outcome` is `left-to-you`, the finding `app.create` holds the command. When `.inspection.ownerApps` is null, `init` couldn't look for the owner's Apps, so first ask **Does the owner already have these Apps for another repository?** If they do, the step is the finding's `kanon apps --reuse`, with each App's slug and a key the person generates on its settings page, as `app.reuse` below; not the command, which would create a second set. Otherwise explain: the Apps the lanes run as (`.apps.identities`), that each opens a page in their browser where they check the permissions and click **Create**, then a second page where they click **Install** and choose this repository, and that the command stores each App's id and key as Actions secrets itself, never printing the key. Then hand it over as "Running `kanon apps`" says: check the token with the pre-check, give the person the exact line for the finding's `kanon apps` command, and ask **Do it now** or **Skip it for now**. When it has run, the register rows it wrote in `docs/qa/agent-identities.md` go in the commit.

8. **The rest of the findings,** in their order, as the table below says. A finding an agent fixes, you fix, after showing the diff. A finding only a person can fix is asked as a step only a person can do, when you reach it. Each `.findings[].fix` has the text, the commands and the page: a command that starts `kanon apps` is the person's ("Running `kanon apps`": you check the token first, and give them the exact line), any other that starts `kanon ` you run as "How to run `kanon`" says (a `kanon init` as `kanon init --json --no-apps`, as in step 6), one that starts `gh secret set` the person runs in their own terminal, pasting the value on standard input, and any other line is a line to add to the file the finding's `.findings[].subject` names.

9. **Open the pull request.** Commit everything `init` and `kanon apps` wrote (signed off by the person), push the branch, and `gh pr create` with a title that passes the PR-title check, such as `ci: install Kanon`. Its body lists the answers; under `## Left to do`, each step the person skipped with its finding's id, so nobody has to remember it; and under `## After merging`, each step that waits for the merge (`ruleset.require-check`), one checkbox each. Say that until the Judge's App exists and the ruleset requires its approval, the repository is in bootstrap and a person merges (`K-ADOPT-6`). Never merge it.

10. **Check it.** Hand over to the doctor skill on the branch, with the skipped list, and run it until it is healthy or only the person's skipped steps are left.

11. **After the merge.** **Never ask the person to require the `Lane check` status check before this pull request merges** ([#444](https://github.com/yedeya-labs/kanon/issues/444)): `init` requires it only once a job on the default branch reports it, because a required check that nothing there reports blocks every other open pull request. When the person says it has merged, or `gh pr view <number> --json state --jq .state` says `MERGED`, walk them through the list under `## After merging` as a step only a person can do, **Do it now** (Recommended) or **Skip it for now**: for `ruleset.require-check`, they run `kanon init` again in their own terminal with a token that can administer the repository, which adds only that rule, or add it on the fix's page. Then the doctor skill, run on the default branch, reports what is still open.

| Code | Status | What you do |
|---|---|---|
| 0 | `complete` | Nothing is left to a person. Go on. |
| 0 | `steps-left` | Go on; `.findings` lists what is left to a person. |
| 1 | `failed` | Something failed after it started changing things. Show `.failures` and `.changes`, and stop. |
| 1 or 2 | `error` | It stopped before changing anything. Show `.error`. Exit 2 is a flag this skill passed that the command refused: a bug in the skill. |

## Who fixes each finding of `kanon init`

*agent*: you, from the checkout, after showing the diff. *person*: only a person can; you give the exact step and wait.

| Id | Who | What you do |
|---|---|---|
| `dependabot.kanon-entry` | agent | Add the fix's lines under `updates:` in `.github/dependabot.yml`. |
| `label.create` | person | The token couldn't create them: the person runs the fix's commands with a token that has Issues: write. |
| `label.delete-default` | person | As `label.create`, for the deletions. |
| `milestone.buckets` | person | As `label.create`: the person runs the fix's `kanon milestones` command with such a token, or you run it once they have one. |
| `merge.settings` | person | The person runs the fix's command with a token that has Administration: write, or sets squash-only merging in the repository's settings. |
| `ruleset.gaps` | person | The person adds the rules the fix names on the ruleset's page. `init` adds the required status check itself, once a job on the default branch reports it and its token can administer the repository, so the check is in this list only when it couldn't. |
| `ruleset.first-commit` | agent | Run `kanon init --json --no-apps` with the same flags again after the first commit is pushed; it creates the ruleset then. |
| `ruleset.create` | person | The person creates the ruleset as the fix says, or runs `kanon init` again in their own terminal with a token that can administer the repository. |
| `ruleset.require-check` | person | No job on the default branch reports `Lane check` yet (where the default branch merges through a merge queue, on its `merge_group` run too: when the fix names a workflow to add `merge_group` to, add it on this branch and show the diff), so the rule waits for this pull request's merge: never before, since every other pull request would wait on it. Put it under `## After merging` in the pull request's body (step 9), and walk the person through it after the merge (step 11). |
| `app.create` | person | Step 7: you check the token, then the person runs the command ("Running `kanon apps`") and clicks **Create** and **Install**. |
| `app.failed` | person | Show what `kanon apps` said; once the person has fixed it, they run the fix's command again ("Running `kanon apps`"). |
| `app.reuse` | person | The owner already has the App. The person adds this repository to its installation and generates a private key on its settings page, then runs the fix's `kanon apps --reuse` command with the key file's path ("Running `kanon apps`"), which stores the secrets and deletes the file. |
| `secret.claude-code-oauth-token` | person | The person creates the token (`claude setup-token`) and runs the fix's `gh secret set` in their own terminal. |
| `secret.digest-webhook` | person | The person runs the fix's `gh secret set` with the chat webhook's URL. |
| `secret.qa-store` | person | The person runs the fix's lines: a `gh variable get … \| gh secret set …` line copies a variable the repository already holds, and a bare `gh secret set` takes the store stack's output on standard input. Never as a variable: a variable prints in every store job's log. |
| `secret.unreadable` | person | The token can't list the secrets: the person checks the ones the lanes need by hand, or the doctor skill does with a token that can. |
| `plugin.declare` | agent | `.claude/settings.json` is the project's: merge the fix's keys into it, keeping every key it has, or set the `ref` of the kanon marketplace it already declares. Show the diff before you write. |
| `telemetry.register` | person | Kanon's operator registers the repository and gives the two variables' values: the person files the issue the fix's page opens (it is public and names the repository), then runs the fix's `gh variable set` lines with the values. Record it as skipped if they'd rather do it later; doctor reports it until then. |
