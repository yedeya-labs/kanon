---
name: upgrade
description: Move a repository's Kanon pins to the release this plugin ships in. Runs `kanon doctor --to <release> --json` first to list what the release needs, explains it, bumps every pin on a branch, fixes the findings through the doctor skill, and opens the pull request. Use when the person asks to upgrade Kanon, or to make a Dependabot pull request that bumps Kanon go green.
disable-model-invocation: true
---

# Upgrade Kanon

You move the repository's Kanon references to one new release, after finding out what that release needs, so the first red run of a lane never has to tell the person. You drive `kanon doctor` through its JSON output only (`docs/doctor.md` in Kanon's repository, read at the release in the `npx` line below, `https://github.com/yedeya-labs/kanon/blob/<release>/docs/doctor.md`, never at `main`, whose contract may be newer), and you never read its prose to decide anything.

**The release you upgrade to is the one this skill ships in,** the version in the `npx` line below. To move to another release, the person first moves this plugin to it ("Moving the plugin", below), so the skill, the command and the release always agree.

## How to run `kanon`

Run every `kanon` command in this skill, and every one a finding's fix names, from the repository's checkout:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.39.0 kanon doctor --json
```

<!-- x-release-please-end -->

Below, `kanon …` means that `npx` line with the rest of the command in place of `doctor --json`, and **the target** means the release it names after `#`, such as `v1.4.0`. Read only standard output, which is one JSON document; never decide anything from standard error.

## Ground rules

- **Never merge.** Never approve a pull request, never push to the default branch, and never bypass a ruleset. You open the pull request; a person merges it.
- **Never print a secret.** Never run `gh auth token`, never echo or print an environment variable that holds a token, never read, print or move a private key (`*.pem`), and never put a secret's value in a command line.
- **Only a person can** click **Create** and **Install** for a GitHub App, generate an App's private key, widen an App's permissions and accept the change on its installation, and type a secret's value. The doctor skill's table says which finding needs which; give the exact step and wait for them.
- **Explain, then ask, then act.** Show the person what the target needs before you change anything.
- **The person signs off.** Commit with `git commit -s` under the person's own git identity. Never sign off as yourself: Kanon's DCO check rejects an AI sign-off.
- **The contract is `kanon-doctor/v1`.** If the document's `.schema` is anything else, stop and tell the person this skill and the command disagree.

## Steps

1. **Where you start.** On the default branch, up to date, with a clean working tree; or on `kanon/upgrade-<the target>`, made from it, when the only change there is the plugin's `ref` in `.claude/settings.json` (step 2). If the working tree has other changes, ask the person to commit or stash them first; never do either yourself.

2. **What the repository pins now.** Run `kanon doctor --to <the target> --json` and read `.releases.pinned` and `.releases.pins`:
   - pinned at the target already: there is nothing to move to this plugin's release. Look up Kanon's latest release with `gh release view --repo yedeya-labs/kanon --json tagName --jq .tagName`. If it is later than the target and the person wants it, they move the plugin to it first ("Moving the plugin", below, with that release in place of the target), and run this skill again. Otherwise hand over to the doctor skill without `--to`, and stop here;
   - pinned at a later release than the target: this plugin is older than the repository's pins. Tell the person to move the plugin to `.releases.pinned` first ("Moving the plugin", below, with that release in place of the target), and stop;
   - more than one release in `.releases.pins`: say so; the bump below makes them one (`K-ADOPT-11`).

   Exit code 3 with nothing pinned means Kanon isn't installed: that is the adopt skill's job.

3. **What the target needs.** From the same document, explain each of `.findings` in plain words, in its order, saying which the person will have to do (the doctor skill's table). **Say up front that each `kanon apps` command a fix names is the person's step** ([#420](https://github.com/yedeya-labs/kanon/issues/420)): it creates Apps and writes secrets, so you check their token first and give them the exact line to run, as the doctor skill's "Running `kanon apps`" says, rather than sending them to run it twice. When the repository calls Kanon's release workflow and `.apps[].identity` lists no `releaser`, say that you will offer the Releaser, as the doctor skill's "Offering the Releaser" says: still the person's choice. Point the person at the release notes of each release between the pin and the target, on `https://github.com/yedeya-labs/kanon/releases`, especially any marked breaking. Ask whether to go on.

4. **Bump every pin.** Create the branch `kanon/upgrade-<the target>`, unless you are on it. Replace the pinned release with the target in every `yedeya-labs/kanon` reference under `.github/`: each `@vX.Y.Z` of a `uses:` line, and each `#vX.Y.Z` of an `npx` line. Where `.claude/settings.json` declares this plugin, set its marketplace's `ref` to the target too: doctor's `plugin.version-mismatch` finding names it. Where it doesn't, offer to declare it, with its `ref` at the target (`docs/skills.md` in Kanon's repository, "Declare it in the repository", gives the keys), so that the next move is one edit; write it only on a yes. Change nothing else on those lines. Show the diff.

   **Past v0.34.1, the QA store's coordinates are secrets alone** ([#479](https://github.com/yedeya-labs/kanon/issues/479)): the lanes hand the store hook no `variables`, and the maintenance workflow takes no `role-arn`. Where `.github/actions/qa-store/action.yml` reads `inputs.variables`, make it read `fromJSON(inputs.secrets || '{}').<NAME>` alone, as the hook template in `docs/qa-store.md` at the target does, and drop its `variables` input. Where a workflow calls `qa-store-aws-maintenance.yml` with `role-arn:`, remove that line and map the secret `QA_STORE_ROLE_ARN` instead. Doctor's `secret.missing` (step 6) asks for the secrets themselves. Show the diff.

5. **New questions.** A release can add a question to `kanon init`, and an installation made before it never answered it. Read the table under "The answers" in `docs/init.md` at the pinned release and at the target (`gh api repos/yedeya-labs/kanon/contents/docs/init.md?ref=<release> --jq .content | base64 -d`). For each answer the target lists and the pinned release doesn't, ask the person its question as the adopt skill this plugin ships asks it ("The questions" in its instructions): as a multiple-choice question, the recommended option first and marked, each option with what it does, never taking its default. Then take only what that answer adds: run `kanon init --dry-run --json` with the answer's flag, show the person each file of `files` whose status is `new` that the answer brings (and nothing else it lists), and write those on this branch after a yes. A step only a person can do that the answer brings is walked through as the adopt skill says, do it now or skip, and a skip is said in the pull request.

6. **Fix what it needs.** Hand over to the doctor skill on this branch. Doctor now reads the target as the pinned release, so it lists what is left. Fix the findings there, in order, until it exits 0 or only a person's steps are left. Never force a fix the repository can't take, such as a `git mv` onto a file name another workflow already holds: the doctor skill offers the person a waiver instead, which they write or accept with its reason. What the record already waives is in `.waived`; say so, and leave it alone. A waiver covers only the items it names ([#406](https://github.com/yedeya-labs/kanon/issues/406)): an item the target adds to a waived finding is listed in `.findings` like any other. **Rewrite a waiver that names no items, before or with this upgrade:** for a finding that lists items, such a bullet is `declaration.malformed` and waives nothing, so the finding it waived is back. Show the person the fix's bullet, which names the items doctor reports today, ask which they keep, keep their reason, and write it on this branch after a yes. **Never ask the person to require a status check before this pull request merges** ([#418](https://github.com/yedeya-labs/kanon/issues/418)): when doctor reports `ruleset.check-unreported` and its fix says this checkout adds the job, the rule is a step after the merge, because a required check that nothing on the default branch reports blocks every other open pull request.

7. **Open the pull request.** Commit (signed off by the person), push the branch, and `gh pr create` titled `ci(deps): upgrade Kanon to <the target>`. Its body lists, under `## Left to do`, each step the person skipped with its finding's id, and under `## After merging`, the steps that wait for the merge ("After the merge", below), one checkbox each. If Dependabot already has a pull request bumping Kanon to the target, say that this one replaces it, link it, and leave it for the person to close. Never merge.

8. **Hand over what waits for the merge.** Show the person the list under `## After merging`, and say that it stays in the pull request's body. When they say it has merged, or `gh pr view <number> --json state --jq .state` says `MERGED`, walk them through it ("After the merge", below).

9. **Say how everyone's plugin moves.** Where `.claude/settings.json` declares the plugin, merging the pull request moves it: each person pulls and runs `/reload-plugins`. Where it doesn't, each person who installed the plugin themselves runs the lines under "Moving the plugin", as printed there.

## After the merge

Some steps can only happen once the upgrade is on the default branch ([#419](https://github.com/yedeya-labs/kanon/issues/419)). Build the list from doctor's last run on the branch (step 6), the release notes of the target and of each release before it (step 3), and what the person skipped, taking each row below that applies, in its order, and nothing that doesn't. Each step says who does it, when, and the exact command or page: the finding's `.findings[].fix.commands` and `.findings[].fix.url` where it has them.

Walk the person through it when they come back after the merge, or whenever they ask, each step as the adopt skill walks a step only a person can do: **Do it now** (Recommended) or **Skip it for now**, a skip left unticked in the list. A step for later (a week of green runs) is said with its date. To get the list again: it is in the pull request's body, and the doctor skill, run on the default branch, reports each step that is still open by its finding.

| Step | Who | When | What |
|---|---|---|---|
| `ruleset.check-unreported` | person | On merge: the job that reports the check is then on the default branch | Run the doctor skill on the default branch. It then reports `ruleset.rule-missing` for the check, and the person adds the rule on its page. Never before the merge: a required check that nothing on the default branch reports blocks every other pull request. |
| `ruleset.bypass-extra` | person | On merge: the `dco` caller on the default branch then pins the target, whose check passes the Releaser's release pull request | The fix's command, leaving the Releaser as the ruleset's only bypass actor, or the same on the fix's page. `kanon apps` prints it and doesn't run it. |
| `apps-check` | agent | On merge, when the repository has an `apps-check` caller | After a yes, run `gh workflow run apps-check.yml -R <owner>/<repo>`, then `gh run watch` its run: it passes for every App the lanes run as. A failure names the App and what it lacks; hand that to the doctor skill. |
| The live checks | agent, person | On the next runs after the merge | Watch, with `gh pr checks <number>`, and tell the person what each showed: the next release pull request, opened by the Releaser where the release caller maps it, runs CI; the next pull request's verdict comes from the Judge's App; a commit of the Author's App passes `dco`. |
| `/reload-plugins` | person | On merge, where `.claude/settings.json` declares the plugin | Each person pulls the default branch and runs `/reload-plugins` (step 9). |
| `app.unused` | person | A week after the merge, if every run on the new Apps has been green | Uninstall and delete the App as the fix says, once no other repository's register names it. |
| `qa-store.variables` | person | On merge, once a store job has run green on the secrets: its log shows `***` where the role and the bucket were | The fix's `gh variable delete` lines. Never before: until the merge, the callers on the default branch still pin the old release. Past v0.34.1 nothing reads the variables, so a store secret one alone holds is `secret.missing`, which blocks, and is copied before the merge. |
| `secret.stale` | decision | With `app.unused`, a week of green runs after the merge | Offer the fix's `gh secret delete` commands, and run each only on a yes. |
| `## Left to do` | person | When the person chooses | Each step skipped during the upgrade, by its finding's id, walked through as above. |

## Moving the plugin

`claude plugin marketplace update` and `claude plugin update` don't move the plugin to a new release: its marketplace is pinned to a release tag, and an update fetches that same tag again. The move is one of these two, with the release it moves to:

- **Declared in the repository,** in `.claude/settings.json`: set the kanon marketplace's `ref` to the release, and run `/reload-plugins`. Claude Code fetches a declared marketplace again when its source changes. To upgrade, make that edit on the branch `kanon/upgrade-<the release>`, made from the default branch, so the upgrade's pull request carries it; where the person also added the `kanon` marketplace themselves, the repository's entry, under the same name, is the one Claude Code uses (`docs/skills.md` in Kanon's repository, "Declare it in the repository", cites the rule).
- **Installed by the person,** in their own Claude Code configuration: they run the lines below in their own terminal, then start a new session or run `/reload-plugins`. The lines name the target; for another release, its tag takes the target's place in the second line. Removing the marketplace uninstalls its plugin, which is why the install follows.

<!-- x-release-please-start-version -->

```sh
claude plugin marketplace remove kanon
claude plugin marketplace add yedeya-labs/kanon#v0.39.0
claude plugin install kanon@kanon
```

<!-- x-release-please-end -->
