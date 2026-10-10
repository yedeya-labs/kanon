---
name: doctor
description: Check a repository's Kanon installation with `kanon doctor --json`, explain each finding in plain words, fix what can be fixed from the checkout, and walk the person through the steps only they can take, until doctor reports it healthy. Use when the person asks whether Kanon is installed correctly, why a Kanon lane failed for a missing secret, App permission, declaration or caller, or what a Kanon release needs before the pin moves. The adopt and upgrade skills end here.
---

# Kanon doctor

You check a Kanon installation and help the person make it healthy. You drive `kanon doctor` through its JSON output only (`docs/doctor.md` in Kanon's repository, read at the release in the `npx` line below, `https://github.com/yedeya-labs/kanon/blob/<release>/docs/doctor.md`, never at `main`, whose contract may be newer), and you never read its prose to decide anything.

## How to run `kanon`

Run every `kanon` command in this skill, and every one a finding's fix names, from the repository's checkout, through the release this skill ships in:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.38.0 kanon doctor --json
```

<!-- x-release-please-end -->

Below, `kanon …` means that `npx` line with the rest of the command in place of `doctor --json`. Read only standard output, which is one JSON document. Standard error is the prose a person reads: show it to them if it helps, but never decide anything from it.

## Ground rules

- **Never merge.** Never approve a pull request, never push to the default branch, and never bypass or change a ruleset to get a change in. You open the pull request; a person merges it.
- **Never print a secret.** Never run `gh auth token`, never echo or print an environment variable that holds a token, never read, print or move a private key (`*.pem`), and never put a secret's value in a command line (a value that isn't secret, such as an App's id, goes on the line with `… --body <value>`: "Running `gh secret set`"). A doctor document names whose token it used (`.token.source`, `.token.login`), never the token: say whose it is, and nothing more.
- **Only a person can** click **Create** and **Install** for a GitHub App, generate an App's private key, widen an App's permissions and accept the change on its installation, type a secret's value, and decide anything the rulebook gives to a person (an id-token holder to accept, a finding to waive, an approval). Say so plainly, give them the exact step, and wait for them to say it's done. Never pretend to have done one of these, and never work around one.
- **Explain, then ask, then act.** Before a command or an edit that changes anything, say in plain words what it changes and why, show the diff, and get a yes.
- **The person signs off.** Commit with `git commit -s` under the person's own git identity. Never sign off as yourself: Kanon's DCO check rejects an AI sign-off.
- **The contract is `kanon-doctor/v1`.** If the document's `.schema` is anything else, stop and tell the person this skill and the command disagree, and to update the plugin. Ignore a field you don't know. The one exception is a `kanon init` you run to fix a finding (below): its document is init's, versioned as `kanon-init/v<N>`, and you read it as the adopt skill does. A finding whose `.findings[].id` is not in the table below is newer than this skill: show the person its `.findings[].message` and `.findings[].fix`, and do nothing else with it.

## Steps

1. **Run it.** `kanon doctor --json`, or `kanon doctor --to vX.Y.Z --json` when the person is about to move the pin to that release (the upgrade skill passes it). Read `.exitCode` and `.status`:

   | Code | Status | What you do |
   |---|---|---|
   | 0 | `healthy` | Say so, list `.notes` and `.waived`, and stop. |
   | 1 | `findings` | Go on to step 2. |
   | 2 | `usage` | This skill passed something the command refused: show `.error`, and stop. It is a bug in the skill, not the repository. |
   | 3 | `error` | Show `.error` in plain words. Usually: not a checkout, a release's requirements file that can't be read, or nothing pins Kanon yet, which is the adopt skill's job. |
   | 4 | `incomplete` | Nothing blocking was found, but a check couldn't run. List each of `.unchecked`, with `.unchecked[].check`, `.unchecked[].subject` and `.unchecked[].reason`, and say what would let it run, as "When a check couldn't run" below says. Then go on to step 2 for any finding that doesn't block. |

2. **Say what it checked.** The release (`.checking`), the lanes (`.lanes`), the Apps (`.apps[].identity` and `.apps[].slug`), and whose token it used. If `.checkout.branch` is not `.checkout.defaultBranch`, say that the id-token holders, and the secrets the workflows map, are counted on this branch, not the default one. List what the adoption record waives (`.waived`): each `.waived[].id` on `.waived[].subject`, the items it waives (`.waived[].items`, when there are any), the bullet that waives them (`.waived[].line`), and the record's reason, `.waived[].reason`. A waived finding doesn't block, and you leave it alone unless the person asks.

3. **Explain the findings, in their order.** `.findings` is already in the order to fix it. Blocking ones (`.findings[].blocking`) first. For each: what it means in plain words (from `.findings[].message` and the table below), who fixes it, and the exact fix (`.findings[].fix.text`, `.findings[].fix.commands`, `.findings[].fix.url`). Read the fix's commands this way:
   - one that starts `kanon apps` is the person's ("Running `kanon apps`", below): you check the token first, and give them the exact line. When a fix lists a `kanon apps` line with the pre-check's flag before it, that one is the token's check of step 1 there, not a second line to hand over;
   - any other that starts `kanon ` you run as above, after saying what it does. A `kanon init` you always run as `kanon init --json --no-apps`, with the adopt skill's answer flags when the person has given them: without the JSON flag it refuses in a shell whose standard input isn't a terminal, and without the no-apps flag it would start the Apps' browser flow unannounced;
   - one that starts `gh secret set` is the person's ("Running `gh secret set`"): never with `!` unless the line carries the value with `… --body <value>`;
   - any other line is a line to add to, or remove from, the file the finding's `.findings[].subject` names, as its `.findings[].fix.text` says.

4. **Fix, one finding at a time,** following the table. Edits go on a branch, never the default branch: if you are on the default branch, create `kanon/doctor` first (the adopt and upgrade skills have their own).

5. **Run it again,** and repeat from step 1 until it exits 0, or until every finding left is one only a person can do. Then list those, each with its exact step, and stop.

6. **Open the pull request** if you changed files: commit (signed off by the person), push the branch, and `gh pr create` with a title that passes the repository's PR-title check, such as `ci: fix the Kanon installation`. Its body lists, under `## Left to do`, each person's step that was skipped, with its finding's id, and under `## After merging`, each step that waits for the merge, as the upgrade skill's "After the merge" lists them, such as requiring a check whose job this pull request adds. Never merge it.

## Running `kanon apps`

`kanon apps` creates GitHub Apps and writes the repository's Actions secrets, so **it is the person's step,** whoever types it: say so as soon as a finding's fix (`register.missing-row`, `register.split-slug`, `register.shared-slug`, `secret.missing`) names it ([#420](https://github.com/yedeya-labs/kanon/issues/420)). Your agent client may refuse to run it for you, and the person clicks **Create** and **Install** in their browser anyway. Before you hand it over:

1. **Check the token first.** Run `kanon apps --owner <owner> --repo <repo> --preflight`. It creates no App, opens no page and writes no file: it checks the checkout, the token and the owner, and sets and deletes a throwaway secret, `KANON_APPS_PREFLIGHT`, because GitHub has no read-only way to show that a token can write secrets. If your client won't run it either, the person runs it as the line below, with the pre-check's flag in place of the App flags. On exit 1, say what it said, and name the permission: the token `gh` uses (`GH_TOKEN`, then `GITHUB_TOKEN`, then its stored login) needs **Secrets: read and write** on the repository, for a fine-grained token the repository permission *Secrets* set to *Read and write*. Fixing the token is a step only a person can do. Run the check again once they say it's done.
2. **Give the exact line,** every placeholder filled in: the checkout's root (`git rev-parse --show-toplevel`), and after `kanon` the command the fix names, flag for flag. In Claude Code the person types it at the prompt, `!` first, which runs it in this session; in another client they run it in their own terminal, without the `!`:

<!-- x-release-please-start-version -->

```sh
! cd <the checkout's root> && npx --yes --package github:yedeya-labs/kanon#v0.38.0 kanon apps --owner <owner> --repo <repo> --apps <apps>
```

<!-- x-release-please-end -->

3. **Say what else it changes, before they run it.** When the command creates or reuses the Releaser, it also edits the default branch's rulesets with the person's token: it adds the Releaser App to the bypass list of each repository ruleset that covers the default branch, for pull requests only, and removes nobody (`K-MERGE-8`; step 7 of `docs/apps.md` in Kanon's repository). Where the token can't edit a ruleset, or it is an organisation's, it changes nothing there and prints the step instead.
4. **Ask, then wait.** **Do it now** (Recommended), and tell me when it's done; or **Skip it for now**, recorded under `## Left to do` with the finding's id. When it's done, check it: `gh secret list`, the register rows it wrote in `docs/qa/agent-identities.md` (they go in the commit), or the doctor skill. When it exits non-zero, ask what it said, and give the line again once they've fixed it.

## Running `gh secret set`

A fix's `gh secret set` is the person's step: it writes a secret, and only a person types a secret's value. **Never with `!` at the Claude Code prompt** when the line reads the value from standard input ([#625](https://github.com/yedeya-labs/kanon/issues/625)): with `!` it runs in this session, whose standard input isn't a terminal, so `gh` asks for nothing and stores an **empty** secret without a word. GitHub never shows a secret's value, so nothing says so until a lane fails to mint its token. So:

- **A value that isn't secret,** such as an App's id (the App ID its settings page shows) or a QA store's coordinates, goes on the line with `… --body <value>`, the value filled in, as the fix gives it: `gh secret set JUDGE_APP_ID -R <owner>/<repo> --body 123456`. That line works with `!` too. Where the fix's line holds a `<…>` in place of the value, fill it in before you hand the line over, asking the person when only they can see it.
- **A real secret,** such as a private key, `CLAUDE_CODE_OAUTH_TOKEN` or a webhook's URL, never goes on a command line. The person runs the fix's line in their own terminal, without the `!`, and pastes the value when `gh` asks for it; or reads it from a file, which works with `!` as well, and deletes the file after:

```sh
gh secret set <NAME> -R <owner>/<repo> < <file>
```

A private key is better stored with `kanon apps --reuse` ("Running `kanon apps`"), which checks it, stores it and deletes the file. Once it's done, `gh secret list -R <owner>/<repo>` shows the secret's name and when it was updated, never its value.

## Offering the Releaser

When the repository calls Kanon's release workflow (a job whose `uses:` is Kanon's `.github/workflows/release.yml` at a release) and `.apps[].identity` lists no `releaser`, its release pull requests are opened with the workflow's token, so they run no CI, and a ruleset that requires checks blocks them unless an admin bypasses it. Plan 0005 gives such a repository the optional Releaser ([#420](https://github.com/yedeya-labs/kanon/issues/420)). Offer it, as a question, once: **Create the Releaser** (Recommended when an active ruleset covers the default branch), which opens the release pull requests so their CI runs and becomes the ruleset's only bypass actor (`K-MERGE-8`); or **Not now**, which keeps the workflow's token. It is the person's choice. On **Create the Releaser**, the person runs `kanon apps --owner <owner> --repo <repo> --apps releaser` ("Running `kanon apps`"); then you map `RELEASER_APP_ID` and `RELEASER_APP_PRIVATE_KEY` under that job's `secrets:` (`docs/release.md` in Kanon's repository, "With the Releaser"), show the diff, and run doctor again: it now checks the Releaser, its register row and its bypass.

## When a check couldn't run

Each check's token is in `docs/doctor.md`, "The token it needs". Never ask for a token's value, and never put one in a command line: the person runs doctor with another token in their own terminal, once, and tells you what it said.

| `.unchecked[].check` | What lets it run |
|---|---|
| `app-permissions` | A private App shows its permissions only to itself, so doctor reads them from the latest `apps-check` run on the default branch. Offer to run the `apps-check` caller there, `gh workflow run apps-check.yml -R <owner>/<repo>`, on a yes; wait for it with `gh run watch <id>`, the id from `gh run list --workflow apps-check.yml -L 1 -R <owner>/<repo>`, then run doctor again. If the caller pins a release from before doctor could read it, the run prints nothing doctor reads: the upgrade moves that pin. |
| `ruleset-bypass` | When the reason says the Releaser could not be read, as `app-permissions` above. When it says the Releaser is private, its id is in the owner's App installations: in an organisation, an owner who can edit the ruleset runs doctor once with a fine-grained token that also holds the organisation's Administration permission (read); on a personal account, the person checks the ruleset's bypass list on its page for the Releaser, through pull requests only. Otherwise someone who can edit the ruleset runs doctor once. |
| `unused-apps` | In an organisation, an owner runs doctor once in their own terminal, with a fine-grained token that holds the organisation's Administration permission (read), and nothing more. Don't widen `gh`'s own login for it: `admin:org` is organisation admin (write), and it stays on that login after the run; if the person uses it anyway, they remove it straight after, `gh auth refresh -r admin:org`. On a personal account, the person looks on https://github.com/settings/installations for the Apps the reason names. |
| `secrets` | Someone with admin access runs doctor once, or a fine-grained token with Secrets: read. |
| any other | Read them the reason. |

## Waiving a finding

Some findings the repository keeps on purpose. The usual one is a caller whose lane's file name is already taken: if a file is already at the path a `git mv` would move a caller to, never move, overwrite or delete either file, and never pass `git mv -f`. Show the person both files and explain the collision.

Then offer a waiver, the person's to make (`docs/doctor.md`, "Waiving a finding"): one bullet under `## Choices` in `docs/qa/adoption.md`, naming the finding's `.findings[].id` and its `.findings[].subject` exactly as doctor reports them, and why it stands. For a finding that lists items, such as each secret of a `secret.missing` or each permission of an `app.permission-missing` (that page lists which), the bullet names, after `for`, only the items the person keeps, as `.findings[].message` names them, so doctor still reports any item a later release adds. A bullet of such a finding that names no items is malformed and waives nothing ([#406](https://github.com/yedeya-labs/kanon/issues/406)). Items kept for different reasons go in bullets of their own, each with its reason; no item in two:

```markdown
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/review.yml` (agent-review.yml is the lane's own definition in this repository)
- **Waived doctor finding:** `secret.missing` on `acme/widgets` for `DIGEST_WEBHOOK` (the digests post through the organisation's webhook)
```

Propose the bullet and ask for the reason; never invent one. Write it only once the person has given or accepted it, show the diff, and run doctor again: the finding moves to `.waived`. Never offer a waiver to get past a finding you could fix, and never for one `docs/doctor.md` says can't be waived ("What can't be waived"): those you fix. For `id-token.unaccepted`, the waiver is the fix's own `Accepted id-token holder` bullet.

## Who fixes each finding of `kanon doctor`

*agent*: you, from the checkout, after showing the diff. *person*: only a person can; you give the exact step and wait. *decision*: the person decides, and you write what they decided.

| Id | Who | What you do |
|---|---|---|
| `pin.mixed` | agent | Make every `yedeya-labs/kanon` reference under `.github/` name the one release the person chooses (`.releases.pins` lists them). |
| `plugin.version-mismatch` | agent | Doesn't block. Set the `ref` the fix names on the kanon marketplace in `.claude/settings.json`, changing nothing else there, and show the diff. Once it is on their checkout, the person runs `/reload-plugins`: Claude Code fetches the marketplace again from the changed source. If the fix's release is newer than this skill's, say that this session still runs the older skills until they reload. |
| `register.missing-row` | agent, person | When the fix has a `kanon apps` command, the person runs it ("Running `kanon apps`") and clicks **Create** and **Install** in the browser it opens. Otherwise add the register rows the fix names. Commit `docs/qa/agent-identities.md`. |
| `register.split-slug` | decision | Ask the person which slug is the App's, then make the register's rows for that App name only it. |
| `register.shared-slug` | person | Each App needs its own. Ask the person which identity gets a new App; they run `kanon apps --owner <owner> --repo <repo> --apps <identity>` for it ("Running `kanon apps`"), and you commit the register rows it writes. |
| `app.permission-missing` | person | The person widens the App's permissions on `.findings[].fix.url`, then accepts the new permissions on the App's installation. |
| `app.permission-extra` | decision | Doesn't block. Say that `apps-check` fails it; the person may narrow it on `.findings[].fix.url`, or leave it. |
| `app.unused` | person | Doesn't block. Once the replacing Apps have run green for a week, and no other repository's register still names it, the person uninstalls the App on `.findings[].fix.url` and deletes it on its Advanced page. |
| `secret.missing` | person | Say which secret it is and which workflows map it (`.findings[].message`). If the fix is `kanon apps` commands, check the token with the pre-check's line, then the person runs the other ("Running `kanon apps`"; for `kanon apps --reuse`, they first generate a key on the App's page, and the command deletes the file). If it is `gh secret set`, the person runs it as "Running `gh secret set`" says: an App's id, or a store's coordinates, with `… --body <value>`, the value filled in; a real secret in their own terminal, never with `!`, or from a file. If it is `gh variable get … \| gh secret set …`, a QA store secret only a variable holds ([#479](https://github.com/yedeya-labs/kanon/issues/479)), the person runs it, or you, on a yes: no value is printed. |
| `secret.stale` | decision | Doesn't block. Offer the fix's `gh secret delete` command, and run it only on a yes. |
| `declaration.missing` | agent | Run `kanon init --dry-run --json`, show the file it would write, then write it with `kanon init --json --no-apps` (with the adopt skill's answer flags), or by hand. |
| `declaration.section-missing` | agent | Add the section, or remove the duplicate, as the fix says. Ask the person for content only they know, such as the stack's gates. |
| `declaration.malformed` | agent, decision | Rewrite the acceptance or waiver in the shape the fix shows, keeping the person's reason. For a waiver that names no items, the fix's bullet names every item doctor reports there today: show it to the person, and drop any item they don't keep, which is then a finding to fix. If it waives a finding that can't be waived, tell the person, remove the bullet once they agree, and fix the finding instead. |
| `upstream.unsent` | decision | The record says findings are sent, and nothing sends them. Ask the person which fix they want: opt in to telemetry (`kanon init --json --no-apps --telemetry`, which writes the collector's caller and leaves the operator's registration as a step), or choose drafted, the fix's bullet, which you write in place of theirs on a yes. It can't be waived. |
| `waiver.stale` | agent | Doesn't block. Offer to remove the bullet, or, when the message names items, only those items from it. |
| `hook.missing` | agent | As `declaration.missing`. |
| `hook.input-missing` | agent | Add the inputs the fix lists to the hook. |
| `workflow.missing` | agent | Rename the project's CI workflow to the file name the fix gives, or let `kanon init --json --no-apps` write one. |
| `caller.lane-removed` | decision | The release no longer ships that lane: ask the person whether to remove the caller, and read them the release notes. |
| `caller.misplaced` | agent, decision | If nothing is at the target path, run the fix's `git mv`. If a file is already there, never move or overwrite either one: show the person both files, and offer a waiver (above). |
| `caller.secrets-inherited` | agent | Replace `secrets: inherit` with the lines the fix lists. |
| `caller.secret-missing` | agent | Add the lines the fix lists under the job's `secrets:`. |
| `caller.secret-stale` | agent | Remove the lines the fix lists. |
| `caller.input-stale` | agent | Remove the input the fix names. |
| `caller.grant-missing` | agent | Add the grant lines the fix lists. |
| `caller.name` | agent | Set the workflow's `name:` as the fix says. |
| `caller.run-name` | agent | Set the `run-name:` as the fix says. |
| `apps-check.secret-missing` | agent | Add the lines the fix lists to the `apps-check` caller. |
| `apps-check.secret-stale` | agent | Remove the lines the fix lists. |
| `telemetry.unconfigured` | person | Kanon's operator registers the repository and gives the two variables' values: the person files the issue the fix's page opens, then runs the fix's `gh variable set` lines with the values. Or, if they no longer want telemetry, you delete the caller the finding's subject names, on a yes. |
| `qa-store.unmapped` | agent | Doesn't block. Add the lines the fix lists under the caller's `secrets:`, once the caller pins a release that takes them. From the release after v0.34.1 the store jobs of a caller that doesn't map them reach no store, so do it with the pin. |
| `qa-store.variables` | agent, person | Doesn't block. The person runs the fix's `gh variable get … \| gh secret set …` lines (or you, on a yes: no value is printed); you map both secrets in each store-coupled caller and make the hook read `inputs.secrets` alone, with no `variables` input (docs/qa-store.md, "Move the coordinates to secrets"). The fix's `gh variable delete` lines wait until a store job has run green on the secrets: never before. |
| `label.missing` | agent | Doesn't block. Run the fix's `gh label create` commands, or `kanon init --json --no-apps`. |
| `ruleset.missing` | agent, person | `kanon init --json --no-apps` creates it when the token can administer the repository; otherwise the person creates it as the fix says, or runs `kanon init` in their own terminal with such a token. |
| `ruleset.rule-missing` | person | The person adds the rule on the ruleset's page (`.findings[].fix.url`). Doctor asks to require a status check only once a job on the default branch reports it, so never ask for a check it didn't name, or before the pull request that adds the check's job has merged ([#418](https://github.com/yedeya-labs/kanon/issues/418)). |
| `ruleset.check-unreported` | agent, person | No job on the default branch reports the check its subject names, so requiring it would block every other pull request. When the fix says this checkout adds the job, the rule waits: its step comes after that pull request merges. When the message names filters of the job's trigger (`paths`, `branches`, `types` and the like), the job skips some pull requests, which would wait on the check: take those filters off as the fix says. When it names a job that doesn't run on `merge_group`, the default branch merges through a merge queue, which waits for the check on that event: add `merge_group:` to the workflow's `on:` as the fix says, show the diff, and say the rule waits for its merge. Otherwise add a job of its own with exactly that name, in a workflow that runs on `pull_request` with no filter, as the fix's page shows, show the diff, and say the rule is the person's step once it has merged. If the ruleset requires the check already, say that every other pull request waits on it until then. |
| `ruleset.releaser-bypass-missing` | person | The person adds the Releaser to the ruleset's bypass list, "For pull requests only", with the fix's command or on the ruleset's page; `kanon apps` adds it when it creates the Releaser. |
| `ruleset.bypass-extra` | person | Once the `dco` caller pins the checked release, the person removes the other bypass actors with the fix's command; release PRs then merge through the front door. |
| `id-token.unaccepted` | decision | Ask the person whether that job needs `id-token: write`. If not, narrow its grant. If it does, ask why, and add the fix's bullet under `## Choices` in the adoption record with their reason. |
| `id-token.stale-acceptance` | agent | Doesn't block. Offer to remove the bullet. |
