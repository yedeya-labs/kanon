# Sharing run data and Kanon's bugs with Kanon

The page the install's consent question links ([plan 0007](plans/0007-guided-install.md) §3, Q4): "Help improve Kanon by sharing anonymous run data and the Kanon bugs your lanes find? Evidence text may rarely hold personal data; details: `<link>`." The question carries the disclosure the rules require it to make itself, that the evidence text may rarely hold personal data and who reads it ([ADR 0007](decisions/0007-data-boundary.md), `K-OBS-16`). This page holds the rest: what is sent, where it is kept and for how long, who reads it, and how to stop and erase it. Nothing on it changes what the question means.

## The three answers

| Answer | What it sets | What leaves this repository |
|---|---|---|
| **Yes** | telemetry on, and ``- **Upstream findings:** `sent with evidence` `` in the adoption record | run data, and each Kanon bug as codes, with its evidence and suggested fix as scrubbed text |
| **Codes only** | telemetry on, and ``- **Upstream findings:** `sent` `` | run data, and each Kanon bug as codes, with no text |
| **No** | no telemetry, and ``- **Upstream findings:** `drafted` `` | nothing: Kanon bugs stay drafts here |

**Nothing is sent without an explicit answer** (`K-OBS-18`). `kanon init --yes` with no answer is **No**. Both opt-ins are recorded in this repository, the telemetry one as the collector's caller, `.github/workflows/telemetry.yml`, and the second as the adoption record's `Upstream findings:` bullet (`K-LAYOUT-10`), so changing either is a pull request.

A repository that maintains Kanon or a fork of it may file Kanon bugs as issues in itself instead, `filed here`, by changing that line of the install's summary. It sends nothing, and never files in another repository.

## Run data

**What is sent:** one row per agent run, plan 0002's fixed fields: the lane, the outcome, the model, cost, tokens, durations and counts, the run, pull request and issue numbers, and the Kanon release ([`actions/agent-telemetry/schema.mjs`](../actions/agent-telemetry/schema.mjs)). No code, no text, no logins, no file paths (`K-OBS-16`).

**Where it is kept:** one table in Kanon's AWS account in Frankfurt (eu-central-1), under an opaque key, kept 13 months ([the hosted telemetry store](telemetry.md)).

**Who reads it:** Kanon's operator, to improve Kanon, who publishes only aggregates that at least three adopters contribute to. This repository's own reader role reads only its own rows. No one else reads it.

**What you get:** Kanon notices failures it caused in your runs, often fixing them before you would report one, and you get cross-adopter cost and reliability baselines ([what an adopter gets](telemetry.md)).

**After a yes:** Kanon's operator registers the repository and gives the values of two repository variables. You ask by filing a registration issue, which is public and names the repository; for a name that must stay private, the issue's form says what to do instead. Until the variables are set, the collector skips, green. On a private repository each hourly run costs about an Actions minute.

## Kanon's bugs: upstream findings

An upstream finding is one about Kanon itself, a lane's behaviour, a guard, a rule or Kanon's library, found by the Overseer or the telemetry Explorer (`K-SELF-11`). Review and Review + build run neither lane, so on those features nothing more leaves the repository for this opt-in until the Overseer is installed. Each finding is drafted here either way: in the Overseer's audit issue or the telemetry Explorer's run summary, for you to read.

**As codes** (**Codes only** and **Yes**): the lane, stage, error and reason codes, the Kanon release, rulebook ids, Kanon's own file paths and a fix category. No text ([plan 0006](plans/0006-upstream-findings.md) §2).

**With evidence** (**Yes** only): also each finding's evidence and suggested fix, as text.
- **How it is written:** the agent writes it for Kanon's maintainer, to Kanon's template, without names, logins, URLs, repository names or quotes of this repository's text.
- **The scrub:** before it leaves, an automatic scrub removes URLs, this repository's name, the logins and names the lane can see, and every path outside Kanon's own files. A text that fails the scrub is not sent. It runs again when Kanon receives the text ([plan 0006](plans/0006-upstream-findings.md) §4.2).
- **What may remain:** the scrub knows only the names the lane can see, so the text may rarely still contain personal data, such as a name the scrub didn't know.
- **Who reads it:** Kanon's maintainer, in a private issue, and a third-party decision provider, TypeSafe, whose model, Jev, decides whether a finding becomes a public Kanon issue. No one else.
- **Never published:** the text itself is never published. A public Kanon issue holds only the codes.
- **Where and how long:** like run data, in Frankfurt (eu-central-1), kept 13 months.

## Stop and erase

- **Stop sending run data and findings:** delete `.github/workflows/telemetry.yml`. Nothing is sent without it.
- **Stop sending findings, or their text, only:** change the adoption record's `Upstream findings:` bullet to `drafted`, or from `sent with evidence` to `sent`.
- **Erase what was sent:** ask Kanon's operator, who erases it on request, run data and findings alike. It is gone from the table at once and from backups within 35 days ([erase an adopter](telemetry.md#erase-an-adopter)).
