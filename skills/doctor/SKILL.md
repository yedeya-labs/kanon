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
npx --yes --package github:yedeya-labs/kanon#v0.33.0 kanon doctor --json
```

<!-- x-release-please-end -->

Below, `kanon …` means that `npx` line with the rest of the command in place of `doctor --json`. Read only standard output, which is one JSON document. Standard error is the prose a person reads: show it to them if it helps, but never decide anything from it.

## Ground rules

- **Never merge.** Never approve a pull request, never push to the default branch, and never bypass or change a ruleset to get a change in. You open the pull request; a person merges it.
- **Never print a secret.** Never run `gh auth token`, never echo or print an environment variable that holds a token, never read, print or move a private key (`*.pem`), and never put a secret's value in a command line. A doctor document names whose token it used (`.token.source`, `.token.login`), never the token: say whose it is, and nothing more.
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
   | 4 | `incomplete` | Nothing blocking was found, but a check couldn't run. List each of `.unchecked`, with `.unchecked[].check`, `.unchecked[].subject` and `.unchecked[].reason`, and say what would let it run (often a token that can list the repository's secrets). Then go on to step 2 for any finding that doesn't block. |

2. **Say what it checked.** The release (`.checking`), the lanes (`.lanes`), the Apps (`.apps[].identity` and `.apps[].slug`), and whose token it used. If `.checkout.branch` is not `.checkout.defaultBranch`, say that the id-token holders are counted on this branch, not the default one. List what the adoption record waives (`.waived`): each `.waived[].id` on `.waived[].subject`, and the record's reason, `.waived[].reason`. A waived finding doesn't block, and you leave it alone unless the person asks.

3. **Explain the findings, in their order.** `.findings` is already in the order to fix it. Blocking ones (`.findings[].blocking`) first. For each: what it means in plain words (from `.findings[].message` and the table below), who fixes it, and the exact fix (`.findings[].fix.text`, `.findings[].fix.commands`, `.findings[].fix.url`). Read the fix's commands this way:
   - one that starts `kanon ` you run as above, after saying what it does. A `kanon init` you always run as `kanon init --json --no-apps`, with the adopt skill's answer flags when the person has given them: without the JSON flag it refuses in a shell whose standard input isn't a terminal, and without the no-apps flag it would start the Apps' browser flow unannounced;
   - one that starts `gh secret set` is the person's: they run it in their own terminal and paste the value on standard input;
   - any other line is a line to add to, or remove from, the file the finding's `.findings[].subject` names, as its `.findings[].fix.text` says.

4. **Fix, one finding at a time,** following the table. Edits go on a branch, never the default branch: if you are on the default branch, create `kanon/doctor` first (the adopt and upgrade skills have their own).

5. **Run it again,** and repeat from step 1 until it exits 0, or until every finding left is one only a person can do. Then list those, each with its exact step, and stop.

6. **Open the pull request** if you changed files: commit (signed off by the person), push the branch, and `gh pr create` with a title that passes the repository's PR-title check, such as `ci: fix the Kanon installation`. Never merge it.

## Waiving a finding

Some findings the repository keeps on purpose. The usual one is a caller whose lane's file name is already taken: if a file is already at the path a `git mv` would move a caller to, never move, overwrite or delete either file, and never pass `git mv -f`. Show the person both files and explain the collision.

Then offer a waiver, the person's to make (`docs/doctor.md`, "Waiving a finding"): one bullet under `## Choices` in `docs/qa/adoption.md`, naming the finding's `.findings[].id` and its `.findings[].subject` exactly as doctor reports them, and why it stands:

```markdown
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/review.yml` (agent-review.yml is the lane's own definition in this repository)
```

Propose the bullet and ask for the reason; never invent one. Write it only once the person has given or accepted it, show the diff, and run doctor again: the finding moves to `.waived`. Never offer a waiver to get past a finding you could fix, and never for one `docs/doctor.md` says can't be waived ("What can't be waived"): those you fix. For `id-token.unaccepted`, the waiver is the fix's own `Accepted id-token holder` bullet.

## Who fixes each finding of `kanon doctor`

*agent*: you, from the checkout, after showing the diff. *person*: only a person can; you give the exact step and wait. *decision*: the person decides, and you write what they decided.

| Id | Who | What you do |
|---|---|---|
| `pin.mixed` | agent | Make every `yedeya-labs/kanon` reference under `.github/` name the one release the person chooses (`.releases.pins` lists them). |
| `plugin.version-mismatch` | agent | Doesn't block. Set the `ref` the fix names on the kanon marketplace in `.claude/settings.json`, changing nothing else there, and show the diff. Once it is on their checkout, the person runs `/reload-plugins`: Claude Code fetches the marketplace again from the changed source. If the fix's release is newer than this skill's, say that this session still runs the older skills until they reload. |
| `register.missing-row` | agent, person | Run the fix's `kanon apps` command when it has one: the person clicks **Create** and **Install** in the browser it opens. Otherwise add the register rows the fix names. Commit `docs/qa/agent-identities.md`. |
| `register.split-slug` | decision | Ask the person which slug is the App's, then make the register's rows for that App name only it. |
| `register.shared-slug` | person | Each App needs its own. Ask the person which identity gets a new App, run `kanon apps --owner <owner> --repo <repo> --apps <identity>` for it (they click **Create** and **Install**), and commit the register rows it writes. |
| `app.permission-missing` | person | The person widens the App's permissions on `.findings[].fix.url`, then accepts the new permissions on the App's installation. |
| `app.permission-extra` | decision | Doesn't block. Say that `apps-check` fails it; the person may narrow it on `.findings[].fix.url`, or leave it. |
| `app.unused` | person | Doesn't block. Once the replacing Apps have run green for a week, and no other repository's register still names it, the person uninstalls the App on `.findings[].fix.url` and deletes it on its Advanced page. |
| `secret.missing` | person | If the fix is a `kanon apps` command, run it (for `kanon apps --reuse`, the person first generates a key on the App's page and gives you only the file's path; the command deletes the file). If it is `gh secret set`, the person runs it. |
| `secret.stale` | decision | Doesn't block. Offer the fix's `gh secret delete` command, and run it only on a yes. |
| `declaration.missing` | agent | Run `kanon init --dry-run --json`, show the file it would write, then write it with `kanon init --json --no-apps` (with the adopt skill's answer flags), or by hand. |
| `declaration.section-missing` | agent | Add the section, or remove the duplicate, as the fix says. Ask the person for content only they know, such as the stack's gates. |
| `declaration.malformed` | agent, decision | Rewrite the acceptance or waiver in the shape the fix shows, keeping the person's reason. If it waives a finding that can't be waived, tell the person, remove the bullet once they agree, and fix the finding instead. |
| `waiver.stale` | agent | Doesn't block. Offer to remove the bullet. |
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
| `label.missing` | agent | Doesn't block. Run the fix's `gh label create` commands, or `kanon init --json --no-apps`. |
| `ruleset.missing` | agent, person | `kanon init --json --no-apps` creates it when the token can administer the repository; otherwise the person creates it as the fix says, or runs `kanon init` in their own terminal with such a token. |
| `ruleset.rule-missing` | person | The person adds the rule on the ruleset's page. |
| `ruleset.releaser-bypass-missing` | person | The person adds the Releaser to the ruleset's bypass list, "For pull requests only", with the fix's command or on the ruleset's page; `kanon apps` adds it when it creates the Releaser. |
| `ruleset.bypass-extra` | person | Once the `dco` caller pins the checked release, the person removes the other bypass actors with the fix's command; release PRs then merge through the front door. |
| `id-token.unaccepted` | decision | Ask the person whether that job needs `id-token: write`. If not, narrow its grant. If it does, ask why, and add the fix's bullet under `## Choices` in the adoption record with their reason. |
| `id-token.stale-acceptance` | agent | Doesn't block. Offer to remove the bullet. |
