# The agent skills

Kanon ships three skills for Claude Code that install Kanon and keep it healthy, from the agent you already work with ([ADR 0014](decisions/0014-adopter-audiences.md), audience 1; plan 0005 step L11). The agent does the reading and the explaining; the `kanon` command stays the source of truth, and you decide every choice.

| Skill | Run it as | What it does |
|---|---|---|
| [adopt](../skills/adopt/SKILL.md) | `/kanon:adopt` | Installs Kanon in the repository you are in, new or already in use: a dry run of `kanon init` first, each choice explained and asked, the files written on a branch, the Apps created with you clicking **Create** and **Install**, every step only you can take walked through, and the pull request opened. Then it hands over to doctor. |
| [doctor](../skills/doctor/SKILL.md) | `/kanon:doctor`, or ask the agent whether Kanon is set up right | Runs `kanon doctor`, explains each finding, fixes what can be fixed from the checkout, and walks you through the rest, until the installation is healthy. |
| [upgrade](../skills/upgrade/SKILL.md) | `/kanon:upgrade` | Moves the repository's pins to the plugin's release: `kanon doctor --to` that release first, so you see what it needs before anything changes, then the pin bump on a branch, the fixes through doctor, and the pull request. |

adopt and upgrade change things, so they run only when you ask for them by name; the agent may start doctor on its own, and doctor changes nothing without asking.

## Install them

The skills are a Claude Code plugin, `kanon`, in Kanon's own repository, which is also a plugin marketplace. Pin it to an exact release, as you pin Kanon's actions and lanes (`K-ADOPT-11`), so the skills, the `kanon` command they run and the release they install are always the same one:

<!-- x-release-please-start-version -->

```sh
claude plugin marketplace add yedeya-labs/kanon#v0.28.0
claude plugin install kanon@kanon
```

<!-- x-release-please-end -->

Or, inside a Claude Code session, the same two as `/plugin marketplace add …` and `/plugin install kanon@kanon`. Start a new session, or run `/reload-plugins`, and the skills are there. You need Claude Code, `gh` signed in as someone who can administer the repository, and Node 24 or later: the skills run `kanon` through `npx`, from the release's tag, so nothing is installed in your repository.

**The plugin's pin lives in your Claude Code configuration, not in the repository,** so Dependabot doesn't propose it and `kanon doctor` doesn't check it (`K-ADOPT-11`); [#376](https://github.com/yedeya-labs/kanon/issues/376) tracks declaring it in the repository and having doctor report a skills and command mismatch. **To move to a newer release,** run `claude plugin marketplace remove kanon`, then the two commands above as that release's copy of this page gives them, with its tag, and run `/kanon:upgrade`.

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
