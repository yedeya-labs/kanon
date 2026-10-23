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
npx --yes --package github:yedeya-labs/kanon#v0.43.0 kanon init --dry-run --json
```

<!-- x-release-please-end -->

Below, `kanon …` means that `npx` line with the rest of the command in place of `init --dry-run --json`. Read only standard output, which is one JSON document. Standard error is the prose a person reads, and `kanon apps` prints there too: show it to them if it helps, but never decide anything from it.

## Ground rules

- **Never merge.** Never approve a pull request, never push to the default branch (except the first commit of an empty repository, below), and never bypass a ruleset. You open the pull request; a person merges it.
- **Never print a secret.** Never run `gh auth token`, never echo or print an environment variable that holds a token, never read, print or move a private key (`*.pem`), and never put a secret's value in a command line (a value that isn't secret, such as an App's id, goes on the line with `… --body <value>`: "Running `gh secret set`"). The document names whose token `init` used (`.token.source`, `.token.login`), never the token: say whose it is, and nothing more.
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

## Confirming the token

`gh` uses `GH_TOKEN`, then `GITHUB_TOKEN`, then its stored login (`docs/apps.md` in Kanon's repository), so a `GH_TOKEN` left in this session's environment is the token every call runs as, whoever `gh auth status` says is signed in ([#630](https://github.com/yedeya-labs/kanon/issues/630)). So **before your first question, and before anything is written,** say which token `gh` will use and whose it is, from the document's `.token.source` and `.token.login`: for example, "`gh` is using the token in `GH_TOKEN`, which belongs to octocat" (`gh` is its stored login). When `.token.login` is null, say that GitHub didn't say whose it is. Then ask whether it is the one they mean: **Use it** (Recommended): go on with it; or **Not this one**: change nothing, and they change the token first.

- On **Not this one**, it is a step only a person can do: they set `GH_TOKEN` to the token they mean in their own terminal, or `unset GH_TOKEN` (and `GITHUB_TOKEN`) to fall back to `gh`'s stored login, and start this session again from that terminal, since a variable set anywhere else never reaches it. Write nothing until they have.
- Never set `GH_TOKEN` yourself, and never ask for a token's value.
- Say what the token needs: for a fine-grained token, the permissions `docs/doctor.md` in Kanon's repository lists under "A person's fine-grained token", with the reads such a token can't do on a private repository.
- Ask once a session. Ask again only when a later document's `.token` names another source or login.

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
! cd <the checkout's root> && npx --yes --package github:yedeya-labs/kanon#v0.43.0 kanon apps --owner <owner> --repo <repo> --apps <apps>
```

<!-- x-release-please-end -->

3. **Say what else it changes, before they run it.** When the command creates or reuses the Releaser, it also edits the default branch's rulesets with the person's token: it adds the Releaser App to the bypass list of each repository ruleset that covers the default branch, for pull requests only, and removes nobody (`K-MERGE-8`; step 7 of `docs/apps.md` in Kanon's repository). Where the token can't edit a ruleset, or it is an organisation's, it changes nothing there and prints the step instead.
4. **Ask, then wait.** **Do it now** (Recommended), and tell me when it's done; or **Skip it for now**, recorded under `## Left to do` with the finding's id. When it's done, check it: `gh secret list`, the register rows it wrote in `docs/qa/agent-identities.md` (they go in the commit), or the doctor skill. When it exits non-zero, ask what it said, and give the line again once they've fixed it.

## Running `gh secret set`

A fix's `gh secret set` is the person's step: it writes a secret, and only a person types a secret's value. **Never with `!` at the Claude Code prompt** when the line reads the value from standard input ([#625](https://github.com/yedeya-labs/kanon/issues/625)): with `!` it runs in this session, whose standard input isn't a terminal, so `gh` asks for nothing and stores an **empty** secret without a word. GitHub never shows a secret's value, so nothing says so until a lane fails to mint its token. So:

- **A value that isn't secret,** such as an App's id (the App ID its settings page shows) or a QA store's coordinates, goes on the line with `… --body <value>`, the value filled in, as the fix gives it: `gh secret set JUDGE_APP_ID -R <owner>/<repo> --body 123456`. That line works with `!` too. Where the fix's line holds a `<…>` in place of the value, fill it in before you hand the line over, asking the person when only they can see it.
- **A real secret,** such as a private key, `CLAUDE_CODE_OAUTH_TOKEN` or a webhook's URL (or `ANTHROPIC_API_KEY`), never goes on a command line. The person runs the fix's line in their own terminal, without the `!`, and pastes the value when `gh` asks for it; or reads it from a file, which works with `!` as well, and deletes the file after:

```sh
gh secret set <NAME> -R <owner>/<repo> < <file>
```

A private key is better stored with `kanon apps --reuse` ("Running `kanon apps`"), which checks it, stores it and deletes the file. Once it's done, `gh secret list -R <owner>/<repo>` shows the secret's name and when it was updated, never its value.

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

### `.answers.feature`: what Kanon does here

A feature is a fixed set of lanes, listed in `.features` (`docs/lanes.md` in Kanon's repository, "The features"). Ask, in these words: "What should Kanon do in this repo?", with each feature of `.features` as an option, its title as the label and its `does` as the consequence, and **Customise** last.

- **Recommended:** the dry run's `.answers.feature` when the repository already calls lanes and they make up a feature; otherwise **Review**.
- **Options:** **Review** (`--feature review`), **Review + build** (`--feature build`) or **Full pipeline** (`--feature full`): `init` installs the feature's lanes, and each conditional lane whose condition holds here, and the lanes question below is not asked. With the Lead's lane, which **Full pipeline** has, `init` also writes the Lead's brief template, `docs/projects/_template.md`, copied unchanged from Kanon's, unless the repository has one (`K-LAYOUT-11`). **Customise**: Choose lane by lane (advanced): ask the lanes question below, which passes `--lanes <list>`, never beside `--feature`, which `init` refuses.

### `.answers.lanes`: which lanes, a group at a time

Asked only after **Customise**.

The lanes are the agents' workflows. Ask one question per group of `.catalogue`, in its order, as a multi-select question headed with the group's `.catalogue[].header`; for a group of one lane, ask **Install it** or **Not now** instead.

- **Options:** each lane of `.catalogue[].lanes`, chosen into `--lanes <list>`: its `.catalogue[].lanes[].name` as the label, and as the description what it does (`.catalogue[].lanes[].does`), what it needs (its App, `.catalogue[].lanes[].app`; its secrets beyond the App's, `.catalogue[].lanes[].secrets`; the QA store, `.catalogue[].lanes[].qaStore`; its hooks, `.catalogue[].lanes[].hooks`; its schedule, `.catalogue[].lanes[].schedule`; and `.catalogue[].lanes[].needs`) what it costs (`.catalogue[].lanes[].cost`) and the Actions runner-minutes it used a day on Kanon's own repository (`.catalogue[].lanes[].minutes`; on a private repository those are billed), shortened to fit, with `.catalogue[].lanes[].when` in one line.
- **Recommended:** each lane whose `.catalogue[].lanes[].recommended` is true (the review lane, and every lane the repository already calls, `.catalogue[].lanes[].installed`), and each lane whose `.catalogue[].lanes[].recommendedWith` names a lane the person chose in an earlier group. A lane recommended with one beside it in the same group says so in its description. Where `.catalogue[].lanes[].when` names a condition you can read from an answer already given, such as a Stakeholder who isn't the Owner for the weekly digest, apply it. The recommended lanes are listed first.
- **Through a merge queue** (`.inspection.defaultBranchMergeQueue` is true), a lane with a `.catalogue[].lanes[].mergeQueue` says it in its description: a merge doesn't start it, so it runs on its schedule or when dispatched. Say it again before the person chooses, in one line, so they choose knowing it ([#452](https://github.com/yedeya-labs/kanon/issues/452)).
- **The Overseer is recommended only to a repository that runs the Implementer, the Lead or the Merger unattended** (its `.catalogue[].lanes[].recommendedWith` names the Implementer and the Lead, asked before it; the Merger, asked after it, merges only the Implementer's pull requests, so a repository that runs it has chosen the Implementer; [#478](https://github.com/yedeya-labs/kanon/issues/478)). It audits the pipeline itself, and its value comes from lanes that run without a person watching. When the person chose none of those, still offer it in its group, unrecommended, with its `.catalogue[].lanes[].when` as the guidance: a repository running only the Reviewer, or lanes it triggers by hand, sees every run anyway, and its first audits say little until weeks of history exist. Recommend it anyway when the repository already calls it.
- **The review lane stays first and recommended:** its App's approval is what ends bootstrap. If the person leaves it out, say what that means and ask once more.
- **A lane the repository already calls** (`.inspection.installedLanes`) that the person leaves out is not uninstalled by `kanon init`: say so.
- **The flag:** every lane chosen, in every group, as one `--lanes <list>`, by the names in `.catalogue[].lanes[].lane`. At least one lane must be chosen.

### `.answers.chat`: which hook posts the digests

The daily project digest and the weekly digest post to a chat channel, each only through a notify hook at `.github/actions/notify/action.yml`, with one secret per kind of message (`docs/notifications.md` and `docs/init.md` in Kanon's repository, "The chat channel"; plan 0011 §10). The release announcement posts each published release, with `KANON_CHAT_RELEASE`, and the deploy lane posts too, each environment's deploy announcement, with `KANON_CHAT_DEPLOY`. **Ask it only when the chosen lanes post to a chat channel**: the **Full pipeline**, or **Customise** with a digest or the release announcement, or any feature with deploy environments declared (`.answers.deployEnvironments`). **Review** and **Review + build** with no deploy environment never see it: pass nothing, and `.answers.chat` is null. **Don't ask it when the repository answers it already:** when `.inspection.notifyHook` is not null, show the inferred answer once with the other inferred values, as the dry run's summary line `Chat` gives it (its `value`, `source` and `reason`), for the person to confirm or change. A caller that still maps `DIGEST_WEBHOOK` infers nothing; when the summary line says so, tell the person that no lane takes it any more, and that posts resume only once a hook exists and the kind secrets are stored. Otherwise ask it in `init`'s words, `CHAT_QUESTION`: "Post digests to a chat channel? Kanon ships a Slack hook and a generic webhook hook, or you can write your own." When the deploy lane is the only thing that posts, `CHAT_QUESTION_DEPLOY`: "Post deploy announcements to a chat channel? Kanon ships a Slack hook and a generic webhook hook, or you can write your own." When both post, `CHAT_QUESTION_BOTH`: "Post digests and deploy announcements to a chat channel? Kanon ships a Slack hook and a generic webhook hook, or you can write your own." When the release announcement is the only thing that posts, `CHAT_QUESTION_RELEASE`: "Post release announcements to a chat channel? Kanon ships a Slack hook and a generic webhook hook, or you can write your own." With it and others, "release announcements" is named among them, after the digests and before the deploy announcements.

- **Recommended:** **Kanon's Slack hook**; the inferred answer when a hook exists.
- **Options:** **Kanon's Slack hook** (`--chat slack`): `init` writes it at `.github/actions/notify/action.yml`, pinned at its release; the digests post through Slack incoming webhooks you create, one secret per kind, and the steps `secret.chat-project-digest`, `secret.chat-weekly-digest`, with the release announcement `secret.chat-release` and, with a deploy environment, `secret.chat-deploy` follow. **Kanon's generic webhook hook** (`--chat webhook`): `init` writes it; each kind posts its message as JSON to a URL you choose, one secret per kind. **My own hook** (`--chat hook`): `init` writes a stub hook that fails by name until you fill it; nothing posts until then. **None** (`--chat none`): no hook; nothing posts; the daily digest still runs its health checks, no model runs for posts, and the weekly digest is not installed.

### `.answers.reviewTrigger`: which pull requests the Reviewer reviews

Not asked by this release: the review lane reviews only a pull request labelled `review:please` until its trigger without a label is built (plan 0007 step G7 in Kanon's repository), and `init` refuses `--review-trigger every-pr` until then. Say so, in the summary's words: "To get a review, add the label `review:please` to the pull request; the Reviewer posts its verdict once CI has finished. After a verdict, push a new commit, or remove and add the label again, to ask for another look."

- **Recommended:** **Only labelled ones**.
- **Options:** **Only labelled ones** (`--review-trigger labelled`, the default with the review lane): only pull requests you label `review:please` get a verdict. **Every pull request** (`--review-trigger every-pr`): not offered until step G7 ships.

### `.answers.sensitiveData`: private or sensitive material

Ask, in these words: "Does this repo hold private or sensitive material?" The answer goes in the adoption record's `## Data` section.

- **Recommended:** **Yes** on a private repository (`.inspection.private` is true), **No** on a public one.
- **Options:** **Yes** (`--sensitive-data`): the record says so; the lanes still read the files and diffs they need. **No** (`--no-sensitive-data`): the record says it holds none.

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
- **Options:** **Yes** (`--releaser`, or `--releases`): `kanon apps` creates a third App, the Releaser, which opens the release pull requests so their CI runs, and becomes the ruleset's only bypass actor (`K-MERGE-8`). **No** (`--no-releaser`, or `--no-releases`): release pull requests keep being opened with the workflow's token.

### `.answers.deployEnvironments`: the deploy environments

The deploy lane deploys each published release to the environments the adoption record declares, in order, each only after the one before it succeeded on the same release, the last being production (`docs/lanes.md` in Kanon's repository, "The deploy lane"; plan 0010, open-question decision 2). It is not one of the features, and runs no model. Ask it of every installation, in these words: "Which environments should Kanon deploy your releases to, in order?" Say what the lane needs before the person answers: a GitHub environment per environment, production with required reviewers (or the record's fallback marker where the plan has none), a cloud role per environment that trusts only that environment, the Releaser so a release starts the lane, and three hooks they fill: their build, their deploy command and their smoke check.

- **Recommended:** infer it from what the repository already has, and say in one line what you inferred it from. The dry run's `.answers.deployEnvironments` when it isn't empty: the record declares that list already, so keep it. Otherwise the repository's GitHub environments (`.inspection.environments`) that its workflows deploy to (`.inspection.deployWorkflows`: each job that references an environment, by workflow and job), in the order those workflows run them: a job that `needs:` another comes after it, and the last is production, so an environment named like `production` or `prod` goes last. Leave out an environment no workflow deploys to, such as `github-pages` or `copilot`, unless the person says otherwise. With no environment and no workflow that references one, **None**.
- **Options:** the recommended list, as one option naming the environments in order (`--deploy-environments <a>,<b>`); **Another list**, the tool's free-text answer, the environments typed in deploy order, one at a time, the last being production (`--deploy-environments <list>`); or **None** (`--deploy-environments none`): no deploy lane, so `init` writes no `## Deploy` section, no caller and no hook. With a list, `init` writes the record's `## Deploy` section with it, the first environment as the reference deploy, the caller `.github/workflows/deploy.yml` and the stubs of the three hooks, `.github/actions/build`, `.github/actions/deploy` and `.github/actions/smoke`, which fail by name until filled (the finding `deploy.hooks`). When `docs/qa/adoption.md` exists already (its `.files[].status` is `kept`, or `rewritten` where `init` only added the Overseer's bullet) and declares another list, `init` leaves it alone and the finding `deploy.declare` gives the bullets to write.

### `.answers.reuseApps`: reuse an App the owner already has

An owner has one Author and one Judge (and at most one Releaser), reused across its repositories (plan 0005 §3.2). `.inspection.ownerApps` lists those the owner already has, found by their installations' permissions, or, when the token can't list the installations, named in the App registers of the owner's other repositories (each one's `from` says which), and only the owner's own Apps, never another account's ([#462](https://github.com/yedeya-labs/kanon/issues/462)), that this repository's register doesn't name ([#363](https://github.com/yedeya-labs/kanon/issues/363)). Ask only when it names an App that a chosen lane runs as (`.catalogue[].lanes[].app`), or the Releaser when the person chose it; name each by its `app` and `slug`. Otherwise there is nothing to choose: say so, and pass neither flag. When the token can't list the owner's installations, another register naming some of the Apps says nothing of the rest: `.inspection.appsNotLookedFor` names each App `init` couldn't look for (`.notes` says why, `Not looked for: …`), whether `.inspection.ownerApps` is null or names others. For each of them that a chosen lane runs as, or the Releaser when the person chose it, ask the person instead whether the owner already has it, as step 7 says ([#652](https://github.com/yedeya-labs/kanon/issues/652)).

- **Recommended:** **Reuse**, because a second set doubles the Apps and private keys the owner manages, for the same permissions.
- **Options:** **Reuse** (`--reuse-apps`): `kanon init` creates none of those Apps; each becomes the finding `app.reuse`, its `kanon apps --reuse` command with the slug filled in, and the App ID when its installation gave it (`.apps.reuse[].appId`), which step 7 walks the person through as **Do it now** or **Skip it for now**: add this repository to the App's installation, generate a private key on its settings page (**Credentials → Key pairs → New key**, [GitHub's steps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps); a key pair, not a client secret), copy its App ID from the same page (under "About") when the command still holds `<App ID>`, and run the command with the App ID in place of `<App ID>` and the key file's path. **Create new ones** (`--no-reuse-apps`): `kanon apps` creates a second App of each kind for this repository, with its own key, and the owner then manages both.

### `.answers.claudeAuth`: the Claude credential

Not asked: `init` infers it (plan 0009, Owner decision 7, in Kanon's repository), and you show it once, with the other inferred values, as the dry run's summary line `Claude` gives it (`.summary[]` whose `answer` is `Claude`: its `value` and where it came from, `source` and `reason`). The one the installed model lanes' callers map, when they all map the same one (`from the lanes' callers`); otherwise from the repository's secret names, `api-key` when it holds `ANTHROPIC_API_KEY` and not `CLAUDE_CODE_OAUTH_TOKEN`, `subscription` otherwise, by default when it holds neither. Every caller `init` writes maps that one secret, never both. Say its consequence in one line: **Claude subscription**, the token from `claude setup-token`, costs nothing beyond the subscription, and the lanes share its weekly limit with the person's own Claude use; **Anthropic API key**, from the Claude Console, is billed per token, each run bounded by its dollar ceiling. Never ask it as a question of its own.

- **Recommended:** the inferred value, `.answers.claudeAuth` in the dry run.
- **Options:** taken only when the person asks for the other. **Claude subscription** (`--claude-auth subscription`): every caller maps `CLAUDE_CODE_OAUTH_TOKEN`, and the step left is `secret.claude-code-oauth-token`. **Anthropic API key** (`--claude-auth api-key`): every caller maps `ANTHROPIC_API_KEY`, and the step left is `secret.anthropic-api-key`.

### `.answers.plugin`: declare this plugin in the repository

- **Recommended:** **Yes**, unless the person says nobody here uses Claude Code.
- **Options:** **Yes** (`--plugin`): `init` writes `.claude/settings.json` declaring the kanon plugin at this release (or, when the file exists, the finding `plugin.declare` gives the keys to merge), so everyone who uses Claude Code here gets these skills once they trust the folder, and doctor checks the release against the pins. **No** (`--no-plugin`): each person installs the plugin themselves, and nothing checks its release.

### `.answers.consent`: share with Kanon

One question sets telemetry, where upstream findings go and their evidence (`docs/sharing.md` in Kanon's repository). Ask it in `init`'s words, `CONSENT_QUESTION`, with `<link>` the sharing page at the release `init` runs from: "Help improve Kanon by sharing anonymous run data and the Kanon bugs your lanes find? Evidence text may rarely hold personal data; details: <link>."

- **When jobs already hold `id-token: write`:** a yes makes each a possible writer to Kanon's telemetry store ([#631](https://github.com/yedeya-labs/kanon/issues/631)). When `.findings` holds `id-token.unaccepted`, say it in the question, before the person answers, with the line `init` adds after its own words at the terminal, the jobs named from `.inspection.idTokenHolders` whose `.inspection.idTokenHolders[].status` is `unaccepted`: "On <`.inspection.defaultBranch`>, a job that already holds id-token: write could then write to Kanon's telemetry store: <workflow>.yml job <job>. Narrow its grant, or accept it in docs/qa/adoption.md (kanon init lists it)." (for several, "<n> jobs that already hold …", "Narrow their grants, or accept each …", "lists them"). They are asked about next, whatever the answer (`.answers.acceptedIdTokenHolders`).
- **Recommended:** **Yes**. The person answers; `init --yes` without the flag, where no question is shown, sends nothing.
- **Options:** **Yes** (`--consent yes`): run data, and scrubbed bug evidence read by Kanon's maintainer and a third-party decision provider; telemetry on, findings `sent with evidence`. **Codes only** (`--consent codes`): run data, and Kanon bugs as codes with no text. **No** (`--consent no`): nothing leaves this repo; Kanon bugs stay drafts here.
- **The three questions below** are asked only when the person wants what no level gives, such as **Filed here**; then pass their own flags, never beside `--consent`, which `init` refuses.

### `.answers.telemetry`: send telemetry rows to Kanon's telemetry store

Off unless the person says yes. Say, in the question itself, everything the person needs to decide:
- **What is sent:** one row per agent run, plan 0002's fixed fields (the lane, the outcome, the model, cost, tokens, durations and counts, the run, pull request and issue numbers, the Kanon release). Also one row per closed pull request, plan 0003's work-item fields (its sizes, times, outcome and the classes of its actors, with pull request and issue numbers). Once they run the deploy lane, one row per environment a release run reaches, whatever its outcome (plan 0010's deploy fields); once a lane hands its notifications to a hook, one row each time its `notify` job runs, whether the message was posted, failed or skipped (plan 0011's notify fields). No code, no text, no titles, no logins, no file paths. `docs/sharing.md` in Kanon's repository and `K-OBS-16` list every field a row may hold.
- **Where it goes:** one table in Kanon's AWS account in Frankfurt (eu-central-1), under an opaque key, kept 13 months.
- **What the person gets:** Kanon notices failures that Kanon caused in their runs, and often fixes them before they would have to report one; they also get cross-adopter cost and reliability baselines (`docs/telemetry.md` in Kanon's repository, "What an adopter gets by opting in").
- **Who reads it:** Kanon's operator, to improve Kanon, who publishes only aggregates that at least three adopters contribute to; the repository reads only its own rows.
- **How to stop and erase:** delete `.github/workflows/telemetry.yml`; to erase what was sent, first run it by hand with `erase: yes` (`docs/sharing.md` in Kanon's repository, "Stop and erase").
- **Who else can write:** every job on the default branch that holds `id-token: write`, an existing OIDC job of theirs included, can write to the store, since its writer role trusts the default branch's ref; name each one `.inspection.idTokenHolders` lists as `unaccepted`, which `.answers.acceptedIdTokenHolders` asks about next.
- **What is left after a yes:** nothing. The collector's first run on the default branch registers the repository, with no issue, no variable and no wait for the operator. On a private repository each hourly run costs about an Actions minute. At a release that doesn't publish the hosted store's URL yet ([#843](https://github.com/yedeya-labs/kanon/issues/843)), say instead what `init`'s question says: the collector sends nothing and registers nothing until the pin moves to a release that does.

- **Recommended:** **No**. Telemetry is never recommended for the person: it is theirs to offer.
- **Options:** **No** (`--no-telemetry`): nothing is written and nothing is sent. **Yes** (`--telemetry`): `init` writes the collector's caller, which is the whole registration: no step is left, and the summary's *Sharing* line says it registers on the collector's first run, or, at a release that doesn't publish the hosted store's URL yet, that it "sends nothing yet"; relay the line as it is.

### `.answers.upstreamFindings`: where findings only Kanon can act on go

Asked of every installation, after telemetry (`docs/plans/0006-upstream-findings.md` in Kanon's repository, §3.2). Say, in the question: an upstream finding is one about Kanon itself, a lane's behaviour, a guard, a rule or Kanon's library, found by the Overseer or the telemetry Explorer; whichever is chosen, nothing is ever filed in another repository.

- **Recommended:** **Drafted**, because sending is the person's to offer, as telemetry is.
- **Options:** **Drafted** (`--upstream-findings drafted`): written into the audit issue or the run's summary, for the person to read; nothing is filed or sent. **Sent to Kanon** (`--upstream-findings sent`): also sent to Kanon's telemetry store as codes only, the lane, stage, error and reason codes, the Kanon release, rulebook ids, Kanon's own file paths and a fix category; no text. Offered only when the telemetry answer is yes; otherwise its description says it needs telemetry, and choosing it isn't possible. **Filed here** (`--upstream-findings filed-here`): filed as issues in this repository, for a repository that maintains Kanon itself or a fork of it.

### `.answers.upstreamEvidence`: also send the evidence text

Asked only after **Sent to Kanon**. Otherwise there is nothing to choose: say so, and pass nothing more. Ask it in these words, the question `kanon init` asks:

"Also send each finding's evidence and suggested fix, as text? The agent writes it for Kanon's maintainer, to Kanon's template, without names, logins, URLs, repository names or quotes of this repository's text, and before it leaves, an automatic scrub removes URLs, this repository's name, the logins and names the lane can see, and every path outside Kanon's own files. It may rarely still contain personal data, such as a name the scrub didn't know. The text is read by Kanon's maintainer, and by a third-party decision provider, TypeSafe, whose model, Jev, decides whether a finding becomes a public Kanon issue. The text itself is never published: a public issue holds only the codes. It is kept 13 months in Frankfurt and erased on request, like telemetry."

- **Recommended:** **Codes only**.
- **Options:** **Codes only** (keeps `--upstream-findings sent`): each finding is sent as codes, with no text. **With evidence** (`--upstream-findings sent-with-evidence`): each finding's evidence and suggested fix are sent too, as text, read by Kanon's maintainer and by a third-party decision provider, TypeSafe, whose model, Jev, decides whether a finding becomes a public Kanon issue; the text itself is never published.

### `.answers.acceptedIdTokenHolders`: the jobs that already hold `id-token: write`

Asked right after the sharing answers, at the telemetry step, for each job `.inspection.idTokenHolders` lists with `.inspection.idTokenHolders[].status` `unaccepted`, which is the finding `id-token.unaccepted` ([#631](https://github.com/yedeya-labs/kanon/issues/631)). Otherwise there is nothing to choose: say so, and pass nothing. Doctor blocks on each such job until the person decides, so decide it here, not after the pull request. For each, name the job (`.inspection.idTokenHolders[].workflow`, `.inspection.idTokenHolders[].job`), how it holds the grant (`.inspection.idTokenHolders[].how`, `.inspection.idTokenHolders[].grant`, and `.inspection.idTokenHolders[].calls` when it passes the grant to a reusable workflow), and what it could then assume on the default branch: the telemetry writer when the consent answer turns telemetry on; the QA store's role when a chosen lane reaches the store (`.catalogue[].lanes[].qaStore`); and that doctor counts it either way, since either can come later (`.findings[].message`).

- **Recommended:** **Accept it** when the job's own permissions grant `id-token: write` (`grant` is `job` and `how` is `id-token`), a grant someone gave it on purpose, such as for the repository's own cloud role; **Narrow its grant** when it inherits the workflow's grant or holds `write-all`, which it rarely needs.
- **Options:** **Accept it** (`--accept-id-token-holder <workflow>.yml#<job>=<why>`): ask why the job holds the grant, as the tool's free-text answer, and never invent the reason; `init` writes the adoption record's `Accepted id-token holder` bullet under `## Choices` with it, and doctor then finds the job accepted. When `docs/qa/adoption.md` exists already (its `.files[].status` is `kept`, or `rewritten` where `init` only added the Overseer's bullet), `init` writes no holder into it and the finding stays, its bullet carrying the reason: add that bullet under `## Choices` yourself after step 6, and show the diff. **Narrow its grant**: only when the person says the job doesn't use the token, since narrowing a job that does breaks it; after step 6, remove `id-token: write` from the job's own `permissions:`, or, when it inherits the workflow's, give the job a `permissions:` of its own without it, and show the diff.

## Steps

1. **Check where you are.** A git checkout of the repository to install in (`git rev-parse --show-toplevel`), `gh` signed in, and Node 24 or later. If the working tree has changes, ask the person to commit or stash them first; never do either yourself.

2. **Inspect, changing nothing.** `kanon init --dry-run --json`. Read `.status` and `.exitCode` (the table below). Before anything else, confirm the token it used, as "Confirming the token" says. Then tell the person, in plain words:
   - the repository (`.repository`), and whether the token can administer the repository (`.inspection.admin`);
   - the account (`.inspection.owner`, `.inspection.ownerKind`), and what its plan allows: `.inspection.rulesets` of `no` means nothing on the platform enforces review, so the Owner's discipline does (say this one clearly); `.inspection.mergeQueue`, and whether the default branch merges through a merge queue (`.inspection.defaultBranchMergeQueue`); and every line of `.notes`;
   - what is already there: the lanes it already calls (`.inspection.installedLanes`), its rulesets (`.inspection.defaultBranchRulesets`, `.inspection.inactiveRulesets`), whether it has a commit yet (`.inspection.hasCommits`).

   If `.inspection.admin` is false, the token can't create the ruleset or set the merge settings: say so now, and ask, as a step only a person can do, whether they want to run with a token that can (then they set `GH_TOKEN` in their own terminal and start again) or go on and take those steps later.

3. **Ask the questions** ("The questions", above), in their order, as **How to ask** says. Every answer of `.answers` gets a question; none is taken from its default unasked, except those "The questions" says are not asked, such as the Claude credential, which you show with its source for the person to confirm.

4. **Show what the answers do.** Run the dry run again with every flag the answers gave, and show the person every file it would write (`.files[].path` with `.files[].status`; for a file that `differs`, show `.files[].diff` and say `init` leaves it alone, so it is the person's to reconcile) and every change it would make on GitHub (`.changes[].message`). Name the release every reference is pinned to, `.pin`, and its channel: a `vX.Y.Z` is a stable release, shown as `Kanon: v1.4.0 (stable)`; a `candidate-vX.Y.Z` is a candidate, which runs ahead of stable because this plugin does, and say so. The channel is no question: stable is the default, and a candidate pin is one a person writes on purpose (plan 0009 §5 in Kanon's repository). Say, in one line, how upgrades arrive: **Dependabot proposes each stable Kanon release, about once a week,** and `/kanon:upgrade` makes any caller change it needs. Then ask: **Go ahead** (Recommended), or **Change an answer**, which asks that question again. When a lane's caller `differs` because its lane's file name holds something that isn't a caller of that lane, such as the lane itself in a repository that hosts Kanon's lanes, ask where its caller goes ([#451](https://github.com/yedeya-labs/kanon/issues/451)): **Another path** (Recommended), typed: once `init` has written (step 6), you write the caller's `.files[].content` and, under `## Choices` in `docs/qa/adoption.md`, a `Waived doctor finding` bullet for `caller.misplaced` on that path with the person's reason (the shape `docs/doctor.md` gives), after which every run of `init` compares the caller there; or **Leave it out**, and the lane leaves `--lanes`.

5. **Make a branch.** If `.inspection.hasCommits` is false, the repository is in bootstrap and its first commit goes straight to the default branch (`K-ADOPT-4`): say so. Otherwise create `kanon/adopt` from the default branch.

6. **Write.** `kanon init --json --no-apps` with the person's flags. `--no-apps` leaves the Apps to step 7, so you can explain them first. Read `.status`: on `failed`, show `.failures` and what it did (`.changes`), and stop; on `error`, show `.error` and stop. Show the person `git status` and the diff.

7. **The Apps,** a step only a person can do. Each finding `app.reuse` (an App the owner has, `.apps.reuse`) is walked through first, as its row below says. When `.apps.outcome` is `left-to-you`, the finding `app.create` holds the command. When `.inspection.appsNotLookedFor` names an App the finding `app.create` would create, `init` couldn't look for it, even where it found others in another repository's register, so first ask, for each such App by name, **Does the owner already have the <App> App for another repository?** For each it does, the step is the finding's `kanon apps --reuse`, with that App's slug and a key the person generates on its settings page (Credentials → Key pairs → New key), as `app.reuse` below; not the command for that App, which would create a second one. Hand over the finding's command only for the Apps the owner doesn't have, naming those alone in its list of Apps. Otherwise explain: the Apps the lanes run as (`.apps.identities`), that each opens a page in their browser where they check the permissions and click **Create**, then a second page where they click **Install** and choose this repository, and that the command stores each App's id and key as Actions secrets itself, never printing the key. Then hand it over as "Running `kanon apps`" says: check the token with the pre-check, give the person the exact line for the finding's `kanon apps` command, and ask **Do it now** or **Skip it for now**. When it has run, the register rows it wrote in `docs/qa/agent-identities.md` go in the commit.

8. **The rest of the findings,** in their order, as the table below says. A finding an agent fixes, you fix, after showing the diff. A finding only a person can fix is asked as a step only a person can do, when you reach it. Each `.findings[].fix` has the text, the commands and the page: a command that starts `kanon apps` is the person's ("Running `kanon apps`": you check the token first, and give them the exact line), any other that starts `kanon ` you run as "How to run `kanon`" says (a `kanon init` as `kanon init --json --no-apps`, as in step 6), one that starts `gh secret set` is the person's ("Running `gh secret set`": never with `!` unless the line carries the value with `… --body <value>`), and any other line is a line to add to the file the finding's `.findings[].subject` names.

9. **Open the pull request.** Commit everything `init` and `kanon apps` wrote (signed off by the person), push the branch, and `gh pr create` with a title that passes the PR-title check, such as `ci: install Kanon`. Its body lists the answers; under `## Left to do`, each step the person skipped with its finding's id, so nobody has to remember it; and under `## After merging`, each step that waits for the merge (`ruleset.require-check`), one checkbox each. When the person chose the review lane, it says too, under `## After merging`, how review starts: the Reviewer reviews a pull request only once it carries `review:please` (or `agent:triage` / `agent:implement`), so add `review:please` to a pull request when it opens, without waiting for its CI (the review lane waits for CI itself, and reviews a labelled pull request once CI has finished on its head), or dispatch the review lane's caller (`gh workflow run <its caller's file> -f pr_number=<number>`); and that this pull request itself is never reviewed, since every trigger runs the default branch's copy of the caller it adds (`docs/lanes.md` in Kanon's repository). Say that until the Judge's App exists and the ruleset requires its approval, the repository is in bootstrap and a person merges (`K-ADOPT-6`); and list under `## After merging` what ends it: once this pull request has merged and the review lane runs on the default branch, switch on one required approving review in the ruleset and write `ended YYYY-MM-DD` under `## Bootstrap` in the adoption record. `kanon doctor` reminds them until they do (`ruleset.bootstrap-can-end`), and fails a ruleset that stops requiring it afterwards (`ruleset.approval-off`). Never merge it.

10. **Check it.** Hand over to the doctor skill on the branch, with the skipped list, and run it until it is healthy or only the person's skipped steps are left.

11. **After the merge.** **Never ask the person to require the `Lane check` status check before this pull request merges** ([#444](https://github.com/yedeya-labs/kanon/issues/444)): `init` requires it only once a job on the default branch reports it, because a required check that nothing there reports blocks every other open pull request. When the person says it has merged, or `gh pr view <number> --json state --jq .state` says `MERGED`, walk them through the list under `## After merging` as a step only a person can do, **Do it now** (Recommended) or **Skip it for now**: for `ruleset.require-check`, they run `kanon init` again in their own terminal with a token that can administer the repository, which adds only that rule, or add it on the fix's page. Then the doctor skill, run on the default branch, reports what is still open. When the person chose the review lane, tell them how review starts, as the body says: add `review:please` (or `agent:triage` / `agent:implement`) to a pull request when it opens, without waiting for its CI (the review lane waits for CI itself), or dispatch the review lane's caller (`gh workflow run <its caller's file> -f pr_number=<number>`). Say it plainly, and never that no label is needed: the Reviewer skips a pull request that carries none of the three.

| Code | Status | What you do |
|---|---|---|
| 0 | `complete` | Nothing is left to a person. Go on. |
| 0 | `steps-left` | Go on; `.findings` lists what is left to a person. |
| 1 | `failed` | Something failed after it started changing things. Show `.failures` and `.changes`, and stop. |
| 1 or 2 | `error` | It stopped before changing anything. Show `.error`. Exit 2 is a flag this skill passed that the command refused: a bug in the skill. |

## Who fixes each finding of `kanon init`

*agent*: you, from the checkout, after showing the diff. *person*: only a person can; you give the exact step and wait. *decision*: the person decides, and you write what they decided.

| Id | Who | What you do |
|---|---|---|
| `dependabot.kanon-entry` | agent | Add the fix's lines under `updates:` in `.github/dependabot.yml`. |
| `label.create` | person | The token couldn't create them: the person runs the fix's commands with a token that has Issues: write. |
| `label.delete-default` | person | As `label.create`, for the deletions. |
| `milestone.buckets` | person | As `label.create`: the person runs the fix's `kanon milestones` command with such a token, or you run it once they have one. |
| `merge.settings` | person | The person runs the fix's command with a token that has Administration: write, or sets squash-only merging in the repository's settings. |
| `ruleset.gaps` | person | The person adds the rules the fix names on the ruleset's page. `init` adds the required status check itself, once a job on the default branch reports it and its token can administer the repository, so the check is in this list only when it couldn't. |
| `ruleset.unreadable` | person | A ruleset that applies to the default branch couldn't be read, so `init` created none beside it. The person checks it on its page (the fix's `url`), or runs `kanon init` again with a token that can read it. Never create a second ruleset by hand beside it. |
| `ruleset.first-commit` | agent | Run `kanon init --json --no-apps` with the same flags again after the first commit is pushed; it creates the ruleset then. |
| `ruleset.create` | person | The person creates the ruleset as the fix says, or runs `kanon init` again in their own terminal with a token that can administer the repository. |
| `ruleset.require-check` | person | No job on the default branch reports `Lane check` yet (where the default branch merges through a merge queue, on its `merge_group` run too: when the fix names a workflow to add `merge_group` to, add it on this branch and show the diff), so the rule waits for this pull request's merge: never before, since every other pull request would wait on it. Put it under `## After merging` in the pull request's body (step 9), and walk the person through it after the merge (step 11). |
| `app.create` | person | Step 7: you check the token, then the person runs the command ("Running `kanon apps`") and clicks **Create** and **Install**. |
| `app.failed` | person | Show what `kanon apps` said; once the person has fixed it, they run the fix's command again ("Running `kanon apps`"). |
| `app.reuse` | person | The owner already has the App. The person adds this repository to its installation, generates a private key on its settings page (**Credentials → Key pairs → New key**, [GitHub's steps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps); a key pair, not a client secret) and, when the fix's command holds `<App ID>`, copies its App ID from the same page (under "About"; GitHub doesn't show a private App's ID to anyone else, [#623](https://github.com/yedeya-labs/kanon/issues/623)), then runs the fix's `kanon apps --reuse` command with the App ID in place of `<App ID>` and the key file's path ("Running `kanon apps`"), which stores the secrets and deletes the file. |
| `secret.claude-code-oauth-token` | person | The callers map the subscription's token. The person creates it in their own terminal (`claude setup-token`) and runs the fix's `gh secret set` there too, never with `!` ("Running `gh secret set`"). |
| `secret.anthropic-api-key` | person | The callers map the API key (`.answers.claudeAuth` is `api-key`). The person creates a key on the fix's page, the Claude Console, in a workspace for CI alone with its own spend limit, then runs the fix's `gh secret set` in their own terminal, never with `!` ("Running `gh secret set`"). The key's value never reaches this session. |
| `secret.chat-project-digest` | person | For Kanon's Slack hook, the person creates a Slack incoming webhook for the channel on the fix's page, then runs the fix's `gh secret set` with its URL, in their own terminal, never with `!` ("Running `gh secret set`"): Slack revokes a webhook URL it finds leaked. For the generic webhook hook, the receiver's https URL; for their own hook, whatever it needs. One value may go in every kind's secret. |
| `secret.chat-weekly-digest` | person | The same, for the weekly digest. |
| `secret.chat-deploy` | person | The same, for the deploy announcement, which each environment's job of the deploy caller maps. |
| `secret.chat-release` | person | The same, for the release announcement, which its caller maps. |
| `secret.qa-store` | person | The person runs the fix's lines: a `gh variable get … \| gh secret set …` line copies a variable the repository already holds, and a `gh secret set … --body '<…>'` line takes the store stack's output in place of its `<…>`: it isn't secret, so the line works with `!` once it is filled in ("Running `gh secret set`"). Never as a variable: Kanon's lanes hand the hook no variables ([#479](https://github.com/yedeya-labs/kanon/issues/479)), so a store whose coordinates are variables is never reached. A variable the fix copied is the person's to delete once a store job has run green on the secrets. |
| `secret.unreadable` | person | The token can't list the secrets: the person checks the ones the lanes need by hand, or the doctor skill does with a token that can. |
| `id-token.unaccepted` | decision | Asked at the telemetry step, as `.answers.acceptedIdTokenHolders` says: the person narrows the job's grant, or accepts it with their reason, which `--accept-id-token-holder` writes; where the record is `kept`, or `rewritten` where `init` only added the Overseer's bullet, add the fix's bullet, its reason filled in, under `## Choices`, and show the diff. |
| `overseer.declare` | decision | `init` wrote the Overseer's caller, and `docs/qa/adoption.md` is the project's and doesn't say the Overseer is installed. Ask: **Install it** (Recommended when they chose the lane): write the fix's bullet under `## Choices`, in place of the `Overseer:` bullet the record has, and show the diff; or **Keep it out**: delete `.github/workflows/agent-overseer.yml`. |
| `deploy.caller-taken` | decision | `.github/workflows/deploy.yml` is a deploy workflow of the person's own, so `init` wrote nothing for the deploy lane. Ask: **Move it** (Recommended when they want the lane): `git mv` it to another file name, update any reference deploy bullet that names it, show the diff, and run `kanon init --json --no-apps` again with the same flags; or **Keep it**: run again with `--deploy-environments none`. |
| `deploy.declare` | agent | `docs/qa/adoption.md` is the project's and declares another deploy list than the person chose: write the fix's bullets in its `## Deploy` section (after `## Data`, where it has none), in place of its environment list and reference deploy bullets, keeping its CI wait and fallback bullets; for **None**, remove the list as the fix says. Show the diff. |
| `deploy.hooks` | decision | A deploy hook is still `init`'s stub, which fails the lane by name. Ask the person what their build, deploy command and smoke check are, then write each hook's step from their answer, keeping the inputs the stub declares (`docs/lanes.md` in Kanon's repository, "The deploy lane"), and show the diff; or record it under `## Left to do` for the first release to wait on. |
| `plugin.declare` | agent | `.claude/settings.json` is the project's: merge the fix's keys into it, keeping every key it has, or set the `ref` of the kanon marketplace it already declares. Show the diff before you write. |
