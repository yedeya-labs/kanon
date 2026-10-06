---
name: upgrade
description: Move a repository's Kanon pins to the release this plugin ships in. Runs `kanon doctor --to <release> --json` first to list what the release needs, explains it, bumps every pin on a branch, fixes the findings through the doctor skill, and opens the pull request. Use when the person asks to upgrade Kanon, or to make a Dependabot pull request that bumps Kanon go green.
disable-model-invocation: true
---

# Upgrade Kanon

You move the repository's Kanon references to one new release, after finding out what that release needs, so the first red run of a lane never has to tell the person. You drive `kanon doctor` through its JSON output only ([docs/doctor.md](https://github.com/yedeya-labs/kanon/blob/main/docs/doctor.md)), and you never read its prose to decide anything.

**The release you upgrade to is the one this skill ships in,** the version in the `npx` line below. To move to another release, the person first moves this plugin to it (`docs/skills.md` in Kanon's repository says how), so the skill, the command and the release always agree.

## How to run `kanon`

Run every `kanon` command in this skill, and every one a finding's fix names, from the repository's checkout:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.28.0 kanon doctor --json
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

1. **Where you start.** On the default branch, up to date, with a clean working tree. If the working tree has changes, ask the person to commit or stash them first; never do either yourself.

2. **What the repository pins now.** Run `kanon doctor --to <the target> --json` and read `.releases.pinned` and `.releases.pins`:
   - pinned at the target already: there is nothing to move; hand over to the doctor skill without `--to`, and stop here;
   - pinned at a later release than the target: this plugin is older than the repository's pins. Tell the person to move the plugin to that release first, and stop;
   - more than one release in `.releases.pins`: say so; the bump below makes them one (`K-ADOPT-11`).

   Exit code 3 with nothing pinned means Kanon isn't installed: that is the adopt skill's job.

3. **What the target needs.** From the same document, explain each of `.findings` in plain words, in its order, saying which the person will have to do (the doctor skill's table). Point the person at the release notes of each release between the pin and the target, on `https://github.com/yedeya-labs/kanon/releases`, especially any marked breaking. Ask whether to go on.

4. **Bump every pin.** Create the branch `kanon/upgrade-<the target>`. Replace the pinned release with the target in every `yedeya-labs/kanon` reference under `.github/`: each `@vX.Y.Z` of a `uses:` line, and each `#vX.Y.Z` of an `npx` line. Change nothing else on those lines. Show the diff.

5. **Fix what it needs.** Hand over to the doctor skill on this branch. Doctor now reads the target as the pinned release, so it lists what is left. Fix the findings there, in order, until it exits 0 or only a person's steps are left.

6. **Open the pull request.** Commit (signed off by the person), push the branch, and `gh pr create` titled `ci(deps): upgrade Kanon to <the target>`. If Dependabot already has a pull request bumping Kanon to the target, say that this one replaces it, link it, and leave it for the person to close. Never merge.
