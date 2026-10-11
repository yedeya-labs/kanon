# The agent skills

Kanon ships three skills for Claude Code that install Kanon and keep it healthy, from the agent you already work with ([ADR 0014](decisions/0014-adopter-audiences.md), audience 1; plan 0005 step L11). The agent does the reading and the explaining; the `kanon` command stays the source of truth, and you decide every choice.

| Skill | Run it as | What it does |
|---|---|---|
| [adopt](../skills/adopt/SKILL.md) | `/kanon:adopt` | Installs Kanon in the repository you are in, new or already in use: a dry run of `kanon init` first, each choice explained and asked, the files written on a branch, the Apps created with you clicking **Create** and **Install**, every step only you can take walked through, and the pull request opened. Then it hands over to doctor. |
| [doctor](../skills/doctor/SKILL.md) | `/kanon:doctor`, or ask the agent whether Kanon is set up right | Runs `kanon doctor`, explains each finding, fixes what can be fixed from the checkout, and walks you through the rest, until the installation is healthy. |
| [upgrade](../skills/upgrade/SKILL.md) | `/kanon:upgrade` | Moves the repository's pins to the plugin's release: `kanon doctor --to` that release first, so you see what it needs before anything changes, then the pin bump on a branch, the fixes through doctor, and the pull request, whose body lists what waits for the merge: a check to require once its job is on the default branch, the admin's bypass to remove, the `apps-check` run and the live checks, and, after a week of green runs, the Apps and secrets to delete. |

**Only you can start** `/kanon:adopt` and `/kanon:upgrade`: type the command in Claude Code. Each one writes your repository and walks you through steps only you can take, such as creating the Apps, typing a secret and merging, so the agent can't start it on its own (each sets `disable-model-invocation`), and asking the agent to install or upgrade Kanon won't start it. The agent may start doctor on its own, and doctor changes nothing without asking.

## Why a plugin

The skills live in `skills/`, as a Claude Code plugin, `kanon`, not in a repository's `.claude/skills/`, so **a session has no `/kanon:*` until the plugin is loaded,** in Kanon's own repository too: Claude Code finds a plugin's skills only through a marketplace it knows. The plugin is what lets one copy of the skills reach every adopter at a release they choose, and Kanon's repository is also the plugin's marketplace. Pin it to an exact release, as you pin Kanon's actions and lanes (`K-ADOPT-11`), so the skills, the `kanon` command they run and the release they install are always the same one. You need Claude Code, `gh` signed in as someone who can administer the repository, and Node 24 or later: the skills run `kanon` through `npx`, from the release's tag, so nothing is installed in your repository.

## Declare it in the repository

The way to pin it is in the repository, in its `.claude/settings.json`, which Claude Code reads for everyone who works there ([Require plugins per repository](https://code.claude.com/docs/en/plugins/org#require-plugins-per-repository)). `kanon init` offers to write it (`--plugin`, the default, or `--no-plugin`; [`docs/init.md`](init.md)); into a settings file the project already has, merge the two keys yourself:

<!-- x-release-please-start-version -->

```json
{
  "extraKnownMarketplaces": {
    "kanon": {
      "source": { "source": "github", "repo": "yedeya-labs/kanon", "ref": "v0.39.0" }
    }
  },
  "enabledPlugins": {
    "kanon@kanon": true
  }
}
```

<!-- x-release-please-end -->

- **`extraKnownMarketplaces`** names the marketplace, Kanon's repository, and `ref` pins it to a release tag ([marketplace sources](https://code.claude.com/docs/en/plugins/marketplace-reference#marketplace-sources)). **`enabledPlugins`** turns the plugin on for the repository ([`enabledPlugins`](https://code.claude.com/docs/en/settings-reference#enabledplugins)).
- **Each person trusts the folder first.** Claude Code honours a repository's marketplace only after the person accepts its workspace trust dialog, and ignores it, without a message, in a folder they haven't trusted, a `-p` run there included ([`extraKnownMarketplaces`](https://code.claude.com/docs/en/settings-reference#extraknownmarketplaces)). So the lanes, which run Claude Code on a fresh checkout, don't load it.
- **Moving to a new release is one edit:** set `ref` to the new tag, as part of the upgrade's pull request. Claude Code fetches a declared marketplace again when its source changes in settings, and asks for `/reload-plugins` ([plugin loading](https://code.claude.com/docs/en/plugins/loading)).
- **The release is where Kanon can see it.** `kanon doctor` reports a `ref` that differs from the release your callers pin, or the one you are moving to with `--to` (`plugin.version-mismatch`, [`docs/doctor.md`](doctor.md)). It doesn't block. Dependabot doesn't read this file, so when it bumps the callers' pin, doctor's finding gives the `ref` to set, and the upgrade skill sets it with the pin.
- **The repository's entry wins over a person's own `kanon` entry.** `claude plugin marketplace add` records the marketplace under its name, `kanon`, in the person's user settings ([plugin loading](https://code.claude.com/docs/en/plugins/loading)), and "when more than one settings file defines a marketplace entry under the same name, Claude Code uses the entry from the highest-precedence file whole", which the project's file is over the user's ([`extraKnownMarketplaces`](https://code.claude.com/docs/en/settings-reference#extraknownmarketplaces), from Claude Code v2.1.228). So a person who installed the plugin themselves gets the repository's release in it. Claude Code keeps one copy of a marketplace per person, though, so two repositories that pin the plugin to different releases move it back and forth as the person goes between them.

Kanon's own repository declares it the same way, and release-please moves its `ref` to each release in the release pull request, ahead of the callers' pin, which Dependabot moves after the release: until that bump merges, doctor reports the difference there, as it would in any repository the plugin leads.

## Or install it yourself

Without the declaration, each person installs the plugin in their own Claude Code configuration:

<!-- x-release-please-start-version -->

```sh
claude plugin marketplace add yedeya-labs/kanon#v0.39.0
claude plugin install kanon@kanon
```

<!-- x-release-please-end -->

Or, inside a Claude Code session, the same two as `/plugin marketplace add …` and `/plugin install kanon@kanon`. Start a new session, or run `/reload-plugins`, and the skills are there.

**That pin lives in each person's configuration, not in the repository,** so Dependabot doesn't propose it and `kanon doctor` doesn't check it. **To move it to a newer release,** `claude plugin marketplace update` and `claude plugin update` won't do: the marketplace is pinned to a tag, and an update fetches that same tag again. Run `claude plugin marketplace remove kanon`, which uninstalls the plugin too, then the two commands above as that release's copy of this page gives them, with its tag, then `/reload-plugins`, and run `/kanon:upgrade`. The upgrade skill prints the exact lines for the release it moves to.

## What they will and won't do

Each skill states these rules in its own instructions:

- **They drive only the `kanon` command's JSON output** ([`docs/cli-json.md`](cli-json.md)): `kanon init --json` ([`docs/init.md`](init.md)) and `kanon doctor --json` ([`docs/doctor.md`](doctor.md)), whose shapes are versioned contracts. They never read the command's prose to decide anything, so a skill and an integrator see the same interface.
- **They never merge,** approve, push to the default branch or bypass a ruleset. They open the pull request; you merge it.
- **They never print a secret.** They never read a token or a private key. A secret's value is something you type into your own terminal.
- **Some steps only a person can take, and the skills say which:** clicking **Create** and **Install** for each App, generating an App's private key, widening an App's permissions, typing a secret's value, naming the project's people, and deciding whatever the rulebook gives a person to decide. The skill gives you the exact step and waits.
- **You sign off the commits** (`git commit -s`, under your own name). Kanon's DCO check rejects an AI sign-off.

## How they are kept honest

`tests/unit/skills.test.ts` holds each skill to the command it drives, so a change to the command that would break a skill fails Kanon's own build instead:

- every `kanon` command a skill names is one the CLI has, and every flag it passes is one that command's parser takes;
- every `kanon init` a skill runs carries `--json`, which an agent's shell needs (it has no terminal for `init`'s questions), and `--no-apps` when it writes, so the Apps' browser flow never starts unannounced;
- each skill's table of findings lists exactly the finding ids of [`docs/init.md`](init.md#the-findings) or [`docs/doctor.md`](doctor.md#the-finding-ids), so a new finding can't go unhandled;
- every field a skill reads, such as `.findings[].fix.commands`, is a field those pages document, and each skill's table of statuses and exit codes is theirs;
- the plugin ships `skills/` and nothing else: the repository's root is the plugin's root, so a `hooks/`, `.mcp.json` or other plugin component added there would reach every adopter's agent, and fails the test instead;
- each skill names the contract (`kanon-init/v1`, `kanon-doctor/v1`) its command prints, and runs `kanon` from the release it ships in.

A skill step that a person still had to do by hand, when the skills ran Kanon's own migration (plan 0005 L5) or an adopter's (L6), is a gap in the skills, filed against L11 and fixed there.

## The lanes' skill

One more skill ships in `skills/`, for Kanon's lanes rather than for you: [upstream-finding](../skills/upstream-finding/SKILL.md) ([plan 0006](plans/0006-upstream-findings.md) §4.1). The Overseer and the telemetry Explorer read it by its path in Kanon's tree, at the release the lane pins, before they write an upstream finding's `evidence` or `suggested_fix`: a fixed template, the hard rules that keep people, repositories and the adopter's own text out of it, and a self-check that sends the finding as codes only when the lane can't comply. It is no command in your menu, and the agent never starts it on its own. `tests/unit/skills.test.ts` holds it to the template's five parts, the hard rules and the self-check, and each lane's test holds the line in its prompt that sends the agent there.
