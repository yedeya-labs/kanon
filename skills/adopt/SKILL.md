---
name: adopt
description: Install Kanon in the repository of the current checkout, new or already in use, by driving `kanon init --json`. Inspects first with a dry run, explains each choice in plain words, asks the person, writes the files, walks them through the steps only a person can take (creating the Apps, the secrets, the ruleset), opens the pull request, then hands over to the doctor skill until the installation is healthy. Use when the person asks to install, adopt or set up Kanon.
disable-model-invocation: true
---

# Adopt Kanon

You install Kanon in the repository whose checkout you are in, with the person deciding every choice. You drive `kanon init` through its JSON output only (`docs/init.md` in Kanon's repository, read at the release in the `npx` line below, `https://github.com/yedeya-labs/kanon/blob/<release>/docs/init.md`, never at `main`, whose contract may be newer), and you never read its prose to decide anything. A repository that already has its own CI, rulesets and labels is the normal case: `init` merges into what is there, and its dry run names every change before you make one.

## How to run `kanon`

Run every `kanon` command in this skill, and every one a finding's fix names, from the repository's checkout, through the release this skill ships in. That release is the one every reference `init` writes is pinned to:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.29.0 kanon init --dry-run --json
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

## Steps

1. **Check where you are.** A git checkout of the repository to install in (`git rev-parse --show-toplevel`), `gh` signed in, and Node 24 or later. If the working tree has changes, ask the person to commit or stash them first; never do either yourself.

2. **Inspect, changing nothing.** `kanon init --dry-run --json`. Read `.status` and `.exitCode` (the table below). Then tell the person, in plain words:
   - the repository (`.repository`), whose token is used, and whether it can administer the repository (`.inspection.admin`);
   - the account (`.inspection.owner`, `.inspection.ownerKind`), and what its plan allows: `.inspection.rulesets` of `no` means nothing on the platform enforces review, so the Owner's discipline does (say this one clearly); `.inspection.mergeQueue`; and every line of `.notes`;
   - what is already there: the lanes it already calls (`.inspection.installedLanes`), its rulesets (`.inspection.defaultBranchRulesets`, `.inspection.inactiveRulesets`), whether it has a commit yet (`.inspection.hasCommits`);
   - every file it would write (`.files[].path` with `.files[].status`). For a file that `differs`, show `.files[].diff` and say `init` leaves it alone, so it is the person's to reconcile;
   - every change it would make on GitHub (`.changes[].message`).

3. **Explain each choice, and ask.** Show each default from `.answers`, say what it means, and ask the person to accept it or give another, all in one message:

   | Answer | Flag | Say |
   |---|---|---|
   | `.answers.projectOwner` | `--project-owner <who>` | The Owner decides product questions and merges what the agents can't. |
   | `.answers.maintainer` | `--maintainer <who>` | The Maintainer keeps the pipeline running. Often the Owner. |
   | `.answers.stakeholder` | `--stakeholder <who>` | The Stakeholder places work on the roadmap. Often the Owner. |
   | `.answers.lanes` | `--lanes <list>` | Which agent lanes to install. The review lane first: its App's approval is what ends bootstrap. |
   | `.answers.gates` | `--gates <list>`, or `--gates none` | The commands that must pass before a change is done, in order, suggested from the repository. |
   | `.answers.testDatabase` | `--test-database none` or `--test-database hook` | Whether a lane needs a test database, started by the project-setup hook. |
   | `.answers.delegation` | `--delegation` with `--delegate-name <name>` and `--delegate-email <email>`, or `--no-delegation` | Whether a named person signs off the agents' commits (`K-AGENT-44`). |
   | `.answers.deleteDefaultLabels` | `--delete-default-labels` or `--keep-default-labels` | Whether to delete GitHub's default labels that Kanon's taxonomy doesn't use. |
   | `.answers.releaser` | `--releaser` or `--no-releaser` | Only when `.inspection.callsRelease` is true: whether to create the optional Releaser App for release pull requests. |

   Then run the dry run again with their flags, show what changed in `.files` and `.changes`, and get a yes.

4. **Make a branch.** If `.inspection.hasCommits` is false, the repository is in bootstrap and its first commit goes straight to the default branch (`K-ADOPT-4`): say so. Otherwise create `kanon/adopt` from the default branch.

5. **Write.** `kanon init --json --no-apps` with the person's flags. `--no-apps` leaves the Apps to step 6, so you can explain them first. Read `.status`: on `failed`, show `.failures` and what it did (`.changes`), and stop; on `error`, show `.error` and stop. Show the person `git status` and the diff.

6. **The Apps.** When `.apps.outcome` is `left-to-you`, the finding `app.create` holds the command. Explain first: the Apps the lanes run as (`.apps.identities`), that each opens a page in their browser where they check the permissions and click **Create**, then a second page where they click **Install** and choose this repository, and that the command stores each App's id and key as Actions secrets itself, never printing the key. Then run the finding's `kanon apps` command (in the background, because it waits for their clicks), and wait for them. When it exits 0, the register rows it wrote in `docs/qa/agent-identities.md` go in the commit. When it doesn't, show its exit code and what it said, and run it again once they've fixed it.

7. **The rest of the findings,** in their order, as the table below says. Each `.findings[].fix` has the text, the commands and the page: a command that starts `kanon ` you run as above, one that starts `gh secret set` the person runs in their own terminal, pasting the value on standard input, and any other line is a line to add to the file the finding's `.findings[].subject` names.

8. **Open the pull request.** Commit everything `init` and `kanon apps` wrote (signed off by the person), push the branch, and `gh pr create` with a title that passes the PR-title check, such as `ci: install Kanon`. Say that until the Judge's App exists and the ruleset requires its approval, the repository is in bootstrap and a person merges (`K-ADOPT-6`). Never merge it.

9. **Check it.** Hand over to the doctor skill on the branch, and run it until it is healthy or only a person's steps are left.

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
| `ruleset.gaps` | person | The person adds the rules the fix names on the ruleset's page. |
| `ruleset.first-commit` | agent | Run `kanon init --json --no-apps` with the same flags again after the first commit is pushed; it creates the ruleset then. |
| `ruleset.create` | person | The person creates the ruleset as the fix says, or runs `kanon init` again in their own terminal with a token that can administer the repository. |
| `app.create` | person | Step 6: you run the command; the person clicks **Create** and **Install**. |
| `app.failed` | person | Show what `kanon apps` said; once the person has fixed it, run the fix's command again. |
| `app.reuse` | person | The owner already has the App. The person adds this repository to its installation and generates a private key on its settings page, then gives you only the key file's path; you run the fix's `kanon apps --reuse` command with it, which stores the secrets and deletes the file. |
| `secret.claude-code-oauth-token` | person | The person creates the token (`claude setup-token`) and runs the fix's `gh secret set` in their own terminal. |
| `secret.digest-webhook` | person | The person runs the fix's `gh secret set` with the chat webhook's URL. |
| `secret.unreadable` | person | The token can't list the secrets: the person checks the ones the lanes need by hand, or the doctor skill does with a token that can. |
