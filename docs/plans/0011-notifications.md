# Plan 0011: chat notifications, a contract Kanon owns and adapters the adopter chooses

- **Status:** proposed 2026-10-14. Nothing in this plan is built. The Owner asked for it on 2026-10-14 ([#839](https://github.com/yedeya-labs/kanon/issues/839)) and decided its shape the same day: Kanon ships one adapter, Slack, and any other chat system is the adopter's own adapter behind Kanon's interface ([Owner decisions (2026-10-14)](#owner-decisions-2026-10-14)). Sixteen questions are left for the Owner ([Decisions for the Owner](#decisions-for-the-owner)), each with a recommendation.
- **Tracks:** [#839](https://github.com/yedeya-labs/kanon/issues/839). **Builds on:** [#836](https://github.com/yedeya-labs/kanon/issues/836), built (the project digest skips its model when no webhook is mapped), [plan 0004](0004-move-the-remaining-lanes.md) (decision 7, the digests' one webhook, and §3.2, the QA store's contract with hooks), [plan 0007](0007-guided-install.md) and the install questions of 2026-10-10, and plan 0010, still a proposal in [PR #838](https://github.com/yedeya-labs/kanon/pull/838) (the deploy lane, whose announcement this plan's `deploy` message is). **Same split as** plan 0010 (Kanon owns the governance, the adopter owns the command) and [#19](https://github.com/yedeya-labs/kanon/issues/19) (a cloud-neutral interface, with AWS as one implementation). **Amends, once built:** plan 0004's decision 7, its body half: the digests' message stops being a `{"text": …}` body and becomes Block Kit with a `text` fallback ([§7](#7-the-slack-adapter)); the one secret's name, its other half, stands. **Waits on,** for its installer and doctor steps: plan 0008's J5 pull request, which is changing `cli/init.mjs` and `cli/doctor.mjs`. **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), [ADR 0012](../decisions/0012-test-conventions-by-language.md), `K-AGENT-47`, `K-AGENT-50`, `K-ADOPT-1` (step 10, the chat channel), `K-ADOPT-12`, `K-SHIP-10`, `K-LAYOUT-1`, `K-LAYOUT-10`, `K-LAYOUT-17`, `K-MERGE-4`, `K-OBS-13`, `K-OBS-16` and `K-PRIN-11` (every guard can fail, and is mutation-checked).
- **Measured on** Kanon's `origin/main` at `680fffb` (v0.39.0), and again at `f1c9cf1`, after PR #832 and #836 landed: `agent-project-digest.yml`, `agent-weekly-digest.yml`, `scripts/project-digest.mjs`, `scripts/weekly-digest.mjs`, `scripts/lib/digest-webhook.mjs`, `scripts/lib/release-notes.mjs`, `scripts/announce-deploy.mjs`, every `fetch(` under `scripts/`, `cli/` and `actions/`, `cli/init.mjs`, `requirements.json`, `docs/lanes.md`, `docs/init.md`, `docs/doctor.md`, `docs/qa-store.md`, `actions/qa-store/action.yml`, `actions/agent-telemetry/schema.mjs`, `scripts/lib/code-areas.mjs`, `skills/adopt/SKILL.md`, the rulebook, and Kanon's adoption record. Slack's documentation was read on 2026-10-14 ([§13](#13-what-slacks-documentation-says)). No probe has run.

## The plan in one paragraph

**Today.** Two lanes post to chat, and a third script can. Each builds a Slack `mrkdwn` string, with Slack's emoji, link syntax and escaping, and `fetch`es it as `{"text": …}` to a URL, from the same job that holds the Claude credential. Nothing defines what a Kanon notification is, so a team on another chat system has nothing to implement, and "no chat" is an absence that doctor reports as a missing secret.

**Where it ends.**
- **One message contract, `kanon-notify` version 1,** versioned as the telemetry schema is: a kind, a severity, a title, a summary, sections, links and its source, in plain text with a small fixed markup, with limits taken from Slack's. No lane formats for a chat system again.
- **Every notifying lane hands its message to one job, `notify`,** which holds the chat secret and nothing else: no App key, no App token, no Claude credential, a read-only workflow token. Only there does an adapter run.
- **Kanon's Slack adapter** turns the message into Block Kit blocks with a `text` fallback and posts it to an incoming webhook. It is the one adapter Kanon ships.
- **The adopter's own adapter is a hook at a fixed path, `.github/actions/notify/action.yml`,** a composite action, as the QA store's and the project setup's are. It receives the validated message and the secret, and anything it calls from outside the repository is pinned. With a hook present, the hook posts; without one, the Slack adapter posts if the secret is held; with neither, nothing posts.
- **No adapter is a choice:** the lanes skip the model work that only feeds a post (what #836 built for the project digest, widened to every adapter and both digests), keep the rest, and doctor reports a note.
- **The installer asks once,** only when the chosen lanes notify: Slack, your own adapter, or no chat. Slack's own page for creating a webhook is linked, and the person stores it in their own terminal.

**How it gets there.** The rule and the contract first, then the Slack adapter and the `notify` job with their guards, then each producer moves behind it: the project digest, the weekly digest, `announce-deploy.mjs`. Doctor and the installer follow once plan 0008's J5 has landed. A live run in a sandbox with a test Slack workspace closes it.

## 1. Today, measured

| What | Where | What it costs |
|---|---|---|
| The project digest builds one Slack `mrkdwn` string (`:clipboard:`, `*bold*`, `<url\|#n>`, `:rotating_light:`), cut at 12,000 characters, and `fetch`es `{"text": …}` to `DIGEST_WEBHOOK` | `scripts/project-digest.mjs`: `buildMessage`, and the `fetch(webhook, …)` at its end | Slack is the format, not one target among others; a Teams or Mattermost team gets Slack's syntax as literal text, or nothing |
| The weekly digest does the same, with its own `&`/`<`/`>` escaping and the same 12,000-character cut | `scripts/weekly-digest.mjs`: its `slackEscape`, the message's 12,000-character cut, and the `fetch(webhook, …)` at its end | Two copies of one poster, and two places to get escaping wrong |
| Both post from the `digest` job, the job that runs `agent-run` with `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | `agent-project-digest.yml`, `agent-weekly-digest.yml`, step "Post the digest" | Harmless while the poster is Kanon's own script. **An adopter's poster could never run there** (`K-AGENT-50`'s reason: step order is not a boundary inside one job) |
| `announce-deploy.mjs` is a third poster, on its own secret `SLACK_RELEASE_WEBHOOK`, with no workflow in Kanon that runs it; it moves an `ANNOUNCED_<STAGE>_VERSION` variable after a successful post | `scripts/announce-deploy.mjs`; plan 0010's "Out of scope" | `K-SHIP-10` (announce each deploy once) has a script and no lane |
| The webhook's one name, `DIGEST_WEBHOOK`, is read by `scripts/lib/digest-webhook.mjs`; the transitional `SLACK_RELEASE_WEBHOOK` fallback for the digests was removed | plan 0004 decision 7; `tests/unit/lane-check-report-lanes.test.ts` | A caller can map one secret only, to one channel, for both audiences (the developer's daily digest and the stakeholder's weekly one) |
| **The project digest skips its model with no webhook** (#836, built): its `digest` job's step "Will the digest be posted?" maps `DIGEST_WEBHOOK` into its own env and sets `narrate`; the three agent blocks run only when it is `true`, or on a dry run. The health job runs either way | `agent-project-digest.yml` | The check reads the chat secret **inside the job that holds the Claude credential**, and knows only one adapter |
| **Kanon calls the project digest for its health job alone** (`project-digest.yml`, since PR #832 on 2026-10-14), with no webhook, so its digest posts nothing and, since #836, runs no model | `.github/workflows/project-digest.yml`; `docs/qa/adoption.md` | — |
| **The weekly digest has no such check:** with no webhook it still writes its narrative, then its script logs "`DIGEST_WEBHOOK` not set — skipping" and exits 0 | `agent-weekly-digest.yml`; `scripts/weekly-digest.mjs` | A model run a week for prose nothing posts, wherever the weekly digest is called without a webhook |
| `kanon init` lists `secret.digest-webhook`, "Store the chat webhook the digests post to", and nothing else: no link to where a webhook comes from, and no "no chat" | `cli/init.mjs`, the step whose id is `secret.digest-webhook`; `docs/init.md`; `skills/adopt/SKILL.md` | The person is told to paste a URL they don't have |
| The full pipeline's digests are conditional on `DIGEST_WEBHOOK`; doctor reports a caller that maps it while the repository lacks it as `secret.missing`, which an adopter on an organisation secret has to waive | `requirements.json` (`conditional`); `docs/doctor.md` (the waiver example) | "No chat" and "forgot the secret" read the same; an organisation secret reads as missing |
| `K-ADOPT-1` step 10 asks the adoption record to say which service carries announcements, digests and cost alerts, and "how it is wired" | `rulebook/10-adoption.md`; Kanon's record: "Chat channel: not yet decided" | The record is prose; nothing writes it, and nothing reads it |

## 2. What Kanon owns and what the adopter keeps

The split the Owner set on 2026-10-14: **Kanon provides the interface; the adopter provides the implementation; Slack is the one implementation Kanon provides.** It is plan 0010's line (Kanon owns the governance, the adopter owns the command) and #19's (a store defined by its operations, AWS the first behind them), and the QA store already lives by it (`K-OBS-17`, [`docs/qa-store.md`](../qa-store.md)).

| Kanon owns | The adopter keeps |
|---|---|
| **What a notification is:** the contract, its kinds, its fields, its limits and its versions ([§3](#3-the-message-contract)) | Whether to post at all, and where |
| **Who says it:** each lane builds its message with Kanon's library, and only with it ([§4](#4-producers)) | — |
| **Where an adapter runs:** the `notify` job, its permissions and its one secret ([§5](#5-the-notify-job-where-an-adapter-runs)) | — |
| **The Slack adapter** ([§7](#7-the-slack-adapter)) | The Slack app, its webhook and its channel |
| **The hook's interface:** its path, its inputs, how it declares its contract version, and what it may call ([§6](#6-the-adopters-adapter-the-notify-hook)) | **The hook's code,** for any other chat system: Teams, Mattermost, Discord, Google Chat, an e-mail relay, a pager, its own bot |
| Doctor's findings and the installer's question ([§9](#9-doctors-findings), [§10](#10-the-installer)) | — |

[ADR 0002](../decisions/0002-standardise-dont-parameterise.md) holds: the contract, the path and the secret's name are fixed, and the adopter's content is its own. [ADR 0012](../decisions/0012-test-conventions-by-language.md)'s other rule holds too: Kanon never runs a tool the adopter didn't choose. Kanon calls Slack only when the adopter stored a Slack webhook; it runs the adopter's hook only because the adopter wrote it.

## 3. The message contract

### 3.1 Shape

One JSON object, version 1. Every field is listed; any other is refused.

```json
{
  "schema_version": 1,
  "kind": "project-digest",
  "severity": "warning",
  "title": "Projects, Tuesday 14 October",
  "summary": "Three projects open. One is stopped on a decision you owe: #812.",
  "sections": [
    {
      "heading": "Stopped",
      "body": "- [#812](https://github.com/acme/widgets/issues/812) Merge retry: the Implementer posted a plan and stopped for a decision.",
      "fields": [{ "label": "Open issues", "value": "4" }, { "label": "Waiting", "value": "2 days" }]
    }
  ],
  "links": [{ "label": "The run", "url": "https://github.com/acme/widgets/actions/runs/1" }],
  "source": { "repository": "acme/widgets", "lane": "project-digest", "run_url": "https://github.com/acme/widgets/actions/runs/1" }
}
```

| Field | Type | Limit | What |
|---|---|---|---|
| `schema_version` | integer | `1` | The contract's version ([§3.4](#34-versions)) |
| `kind` | closed list | — | `project-digest`, `weekly-digest`, `health`, `deploy` ([§3.2](#32-kinds-and-severities)) |
| `severity` | closed list | — | `info`, `warning`, `critical` |
| `title` | plain text, one line | 1 to 120 characters | Slack's header block takes 150; the adapter puts a severity emoji of up to 20 characters before the title, and keeps 10 in hand |
| `summary` | Kanon text | 1 to 1,000 characters | What a person must know if they read nothing else; the notification's preview |
| `sections` | array | 0 to 20 | Each `{heading?, body, fields?}` |
| `sections[].heading` | plain text, one line | 1 to 150 characters | Optional; it goes inside the section's text, not in a header block |
| `sections[].body` | Kanon text | 1 to 2,500 characters | Slack's section block takes 3,000; the margin is the adapter's for escaping and link syntax ([§7](#7-the-slack-adapter)) |
| `sections[].fields` | array of `{label, value}` | 0 to 10; label and value plain text, together at most 1,900 characters | Slack's section block takes 10 fields of 2,000 characters |
| `links` | array of `{label, url}` | 0 to 9; label 1 to 75 characters, plain; `url` `https://` only, at most 2,000 characters | Slack's context block takes 10 elements: one per link, and the tenth is the adapter's link to the run (`source.run_url`) |
| `source` | object | `repository` `owner/name`; `lane` one of Kanon's lane names; `run_url` `https://` | Where it came from: an adapter may show it, route by it, or ignore it |
| **The whole message** | — | at most 12,000 characters of text across every field, and 64 KiB as JSON | The digests' cut today, which has held on the reference adopter; well under the 40,000 characters past which Slack truncates a message's text |

**Kanon text** is a fixed subset of Markdown, chosen because every chat system renders it or can strip it: paragraphs separated by a blank line, one level of `- ` bullets, `**strong**`, `_emphasis_`, `` `code` `` and `[label](https://…)`. **Everything else is literal text,** never refused: a line that starts with `#` or `|` is a line that starts with that character, and `<`, `>` and `&` are characters, which each adapter escapes for its system ([§7](#7-the-slack-adapter) does for Slack). There are no headings, tables, images, HTML, emoji shortcodes or mentions to write, because nothing renders them. **A backslash makes a markup character literal:** `\*`, `\_`, `` \` ``, `\[` and `\\`. `_` opens emphasis only at a word's start and closes only at its end, as in CommonMark, so `snake_case_name` is never emphasis even unescaped. **Plain text** fields (`title`, `heading`, `fields`, link labels) are never interpreted at all; the only thing a plain-text field can be refused for is its length, or a line break in a one-line field.

**Text nobody controls goes through `literal()`.** An issue title, a pull request's title, a label, a release note's line: a producer never writes them into Kanon text bare, but through `literal(s)`, which backslash-escapes every markup character, so `Support Array<string>` or `**urgent**` arrives as written. A model's narrative is Kanon text by intent (it may bold a word), so it goes through `prose(s)`, which keeps the subset's markup and nothing else: there is nothing else to strip, since every other character is already literal. **So no text a producer interpolates can make a message invalid,** and `fit` ([§3.3](#33-one-library-used-three-times)) only has limits to enforce.

**Why `summary` is separate.** A notification preview, a mobile push and a screen reader each read one short string first (Slack: "Mobile notifications exclusively use `message.text`", [§13](#13-what-slacks-documentation-says)). A producer that writes its own summary decides what that string says; an adapter that guessed it from the first section would say whatever came first.

### 3.2 Kinds and severities

| Kind | Producer | Audience | Severity |
|---|---|---|---|
| `project-digest` | the daily project digest | the developer | `warning` when a project is stopped, `info` otherwise |
| `weekly-digest` | the weekly digest | a stakeholder outside the day-to-day (`K-LAYOUT-10`'s audience bullet) | `info` |
| `health` | the project digest's health job, when it files or reopens an issue (decision 13) | the Maintainer | `warning` |
| `deploy` | `announce-deploy.mjs`, for plan 0010's lane | the Stakeholder | `info` when a deploy lands, `critical` when production fails |

The kind is how an adapter routes: the two digests have different readers, and Slack's incoming webhook is bound to one channel, so routing by kind is the adapter's job ([§7](#7-the-slack-adapter), decision 4). **Adding a kind is additive** ([§3.4](#34-versions)): an adapter must post a kind it doesn't know as a generic message, never drop it. A `release` kind, for a library that releases without deploying, comes with its producer, which this plan doesn't build.

### 3.3 One library, used three times

`scripts/lib/notify-contract.mjs`, which imports only `node:` built-ins, as `actions/agent-telemetry/schema.mjs` does:
- **`validate(message)`** returns the problems by field name and never echoes a value, because a message can hold a model's prose and a rejection reaches a log. A message is valid or it isn't posted; `validate` never repairs.
- **`literal(s)` and `prose(s)`** make text nobody controls safe to put in Kanon text ([§3.1](#31-shape)).
- **`fit(draft)`** is what producers call: it cuts a draft to the limits, at line boundaries, with a visible "… N more" or "… truncated" line, and folds a line break in a one-line field into a space. Since Kanon text refuses no character, the limits are all a draft can break, so a producer's output always validates. A section past the twentieth folds into a last one that names how many were left out.
- **`renderText(message)`** renders the message as **plain text**, at most 12,000 characters, for an adapter that posts one string: the markup is removed, the escapes resolved, and a link written `label (url)`. Plain text, not Kanon text, so a hook that posts it to a system that renders Markdown can't have a literal `#` turned into a heading.
- **`SCHEMAS`**, `KINDS`, `SEVERITIES` and `LIMITS`, by version.

It is used by the producers (through `fit`), by the `notify` job before any adapter runs (through `validate`), and by the tests. **A published JSON Schema,** `docs/notify/message-v1.schema.json`, generated from `SCHEMAS` and held equal to it by a test, lets an adopter write its hook in any language and test it against the contract offline (decision 15).

### 3.4 Versions

As the telemetry schema's row kinds are versioned (`actions/agent-telemetry/schema.mjs`, `SCHEMAS`: "A new version is a Kanon release that adds a list; the old one stays until no supported release writes it"):
- **Within a version, changes are additive only:** a new optional field or a new kind. A hook must ignore a field it doesn't know and post a kind it doesn't know.
- **Anything else is a new version:** a field removed, renamed or retyped, a limit tightened. The `notify` job then hands a hook **both** versions for at least one stable release (plan 0009's channels) and the hook reads the one it declares ([§6.2](#62-how-a-hook-declares-and-pins-its-contract)). Doctor names a hook still on the older one.
- **Kanon's Slack adapter always reads the newest,** since it ships in the same release as the producers.

## 4. Producers

**A lane never formats for a chat system.** Each notifying lane's script builds a draft with Kanon text, calls `fit`, writes `message.json`, and uploads it as an artifact, `kanon-notify-<run id>-<attempt>`. It never reads the chat secret and never makes a request to anything but GitHub. The `notify` job does the rest ([§5](#5-the-notify-job-where-an-adapter-runs)).

**A dry run** (`dry_run: 'true'`, as both digests' dispatch has today) writes the message, Kanon's text rendering and the Slack payload to the job's step summary, uploads nothing, and the `notify` job is skipped. A person sees exactly what each adapter would get.

## 5. The `notify` job: where an adapter runs

### 5.1 Shape

Every notifying lane gains the same job, after the job that produces the message, run by a Kanon block, `actions/notify`:

```yaml
  notify:
    needs: [gate, digest]
    # The message exists only when the producer wrote one; the adapter is decided in the gate (§8).
    if: always() && needs.digest.outputs.message == 'true' && needs.gate.outputs.adapter != 'none'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: $/actions/notify
        with:
          adapter: ${{ needs.gate.outputs.adapter }}   # slack or hook
          artifact: kanon-notify-${{ github.run_id }}-${{ github.run_attempt }}
          secret: ${{ secrets.DIGEST_WEBHOOK }}
```

The block, in order:
1. **Downloads** the message and **validates** it with `notify-contract.mjs`. An invalid message fails the job by field name, posting nothing: it is a Kanon bug, and a red run is its page.
2. **Masks** the secret (`::add-mask::`) before anything prints, and again each line of it when it is JSON ([§7](#7-the-slack-adapter)), as the QA store block masks its coordinates.
3. **For `slack`,** runs `actions/notify/slack.mjs` from Kanon's own checkout (`kanon-path`), at the lane's pinned release.
4. **For `hook`,** checks out the run's commit with `persist-credentials: false`, then calls `./.github/actions/notify` with the inputs of [§6.1](#61-the-interface), only when the run's code is the default branch's ([§5.3](#53-reviewed-code-only)).
5. **Prints one line for doctor,** as `apps-check` and the deploy lane's probe do: `kanon-notify/v1 {"adapter":"slack","kind":"project-digest","outcome":"posted"}`, the outcome one of `posted`, `failed`, `skipped`. No URL, no channel, no text.

### 5.2 What the job holds, and what it never holds

| Holds | Never holds |
|---|---|
| **One secret, `DIGEST_WEBHOOK`,** by name, handed to the block as one input (`K-AGENT-47`: never the whole `secrets` context) | An App's key or token, a Claude credential, `id-token: write`, any other secret |
| A workflow token with `contents: read` and nothing else | `issues`, `pull-requests`, `actions` or `contents` write |
| The block's steps and, for a hook, the checkout and the hook | `env:` at job level (a `NODE_OPTIONS` could reach the block), `container:`, `services:`, `defaults:` |

This is the issue's "adopter code never runs in a job that holds an App key or the Claude credential", as a shape a test checks ([§12](#12-order-of-moves), N4): `tests/unit/helpers/notify-jobs.ts` holds every `notify` job to it, as `store-jobs.ts` holds the QA store's jobs, and **`DIGEST_WEBHOOK` may be referenced only in a `notify` job and in the gate's one presence test** ([§8](#8-no-adapter)). `K-AGENT-50`'s guard, `pr-code-token-isolation.test.ts`, fails any job that runs a `./` action and references a secret; the `notify` job joins its named list of jobs that run the default branch's reviewed code, held to the exact shape above.

**What the hook can still reach,** stated plainly: the chat secret, a read-only workflow token (any composite action can read `github.token`), the run's checkout and the network. A compromised hook can post to the adopter's chat or send the secret elsewhere. It can't push, comment, approve, merge or reach a model. **What doctor can't see,** and so remains: a path a script builds at run time, a file a reviewed script imports from outside `.github/` and the declared pipeline code, and a hook that `curl`s code and runs it. `notify.hook-unreviewed` reads what the hook names; what the hook's code then does is the adopter's review's to catch, which is why each file the hook names must escalate to a human.

### 5.3 Reviewed code only

The hook runs only when the run is on the default branch's code: a `schedule`, a dispatch on the default branch, or, for plan 0010's lane, a `release` whose gate proved the commit is on the default branch. A dispatch on any other branch posts through the Slack adapter if that is the choice (Kanon's code, at the pinned release), and with a hook posts nothing and says why in the summary (decision 8). Every file under `.github/` escalates (`K-MERGE-4`), so a change to the hook's `action.yml` always reaches a human before it runs with the secret. **That covers only what escalates.** A script the hook runs from elsewhere in the repository (`scripts/post-to-teams.mjs`), a local action outside `.github/`, or a package the hook installs, is not on an escalation path unless the adopter declares it under `## Pipeline code` in `docs/qa/escalation-paths.md` (`K-MERGE-4`, `K-LAYOUT-8`). Otherwise the Merger may merge an agent's change to it, and the next scheduled run executes it with the secret, unread by a human. So **every repository path the hook runs must escalate** ([§6.2](#62-how-a-hook-declares-and-pins-its-contract), item 2), and doctor checks the paths it can see (`notify.hook-unreviewed`). It is the QA store's rule ("the store's role trusts the default branch's ref") by another mechanism.

### 5.4 When the post fails

- **The `notify` job turns red,** with Slack's or the hook's error, and the producing job stays green. That is `K-SHIP-10`'s "a failure to announce is reported as an announcement failure", and it is today's "a red run is the cheapest detector" (the digests' own comment) kept where it belongs.
- **One retry, on 429 only,** after Slack's `Retry-After`, if it is at most 60 seconds ([§13](#13-what-slacks-documentation-says)). A hook decides its own retries.
- **A re-run of the failed `notify` job** posts the same message again: it reuses the producer's artifact, which lives the artifact's default retention.

## 6. The adopter's adapter: the notify hook

### 6.1 The interface

`.github/actions/notify/action.yml`, a composite action the adopter writes, at a fixed path (`K-LAYOUT-1` gains the row), as `.github/actions/qa-store`, `.github/actions/project-setup` and plan 0010's `.github/actions/deploy` are.

| Input | What |
|---|---|
| `message-v1` | Path to the validated message, version 1, as JSON |
| `text` | Path to `renderText`'s plain-text rendering of it, at most 12,000 characters, for a hook that posts one string |
| `kind` | The message's `kind`, for a hook that routes without parsing JSON |
| `secret` | `DIGEST_WEBHOOK`'s value, masked. Whatever the hook needs to reach its system: a URL, a token, or a JSON object of several (decision 3) |

**Must:** deliver the message or fail. **No outputs are read:** the block judges the hook by whether its step succeeded, as the lanes judge project-setup.

A minimal hook, for a system that takes a JSON body at a URL, which the topic doc carries as an example, not as Kanon code (decision 10):

```yaml
name: notify
inputs:
  message-v1: { required: true }
  text: { required: true }
  kind: { required: true }
  secret: { required: true }
runs:
  using: composite
  steps:
    - shell: bash
      env:
        URL: ${{ inputs.secret }}
        TEXT_FILE: ${{ inputs.text }}
      run: jq -n --rawfile t "$TEXT_FILE" '{text: $t}' | curl -fsS -X POST -H 'Content-Type: application/json' --data @- "$URL"
```

### 6.2 How a hook declares and pins its contract

**"Declared"** is the hook's presence at the path: there is nothing else to fill in (decision 1). **"Pinned"** means three things, each checked:

1. **The contract version, by the input it declares.** A hook that declares `message-v1` gets version 1. When version 2 exists, the block passes `message-v2` to a hook that declares it, and `message-v1` to one that declares only that, for as long as Kanon still writes version 1 ([§3.4](#34-versions)). The block reads the hook's `action.yml` to choose, before it calls it. Doctor reports a hook that declares no version this release writes (`notify.hook-malformed`, blocking) and one on a version about to go (`notify.hook-version-old`, a note).
2. **The hook's own code, by the commit and by escalation.** The hook runs at the run's commit, on the default branch ([§5.3](#53-reviewed-code-only)). Its `action.yml` is under `.github/`, so a change to it escalates to a human. **Every other repository file it runs must escalate too:** it lives under `.github/` (`.github/actions/notify/post.mjs` beside the hook is the simplest), or is declared under `## Pipeline code`. Doctor reads each `uses: ./…` and each repository path a `run:` names, and fails one that doesn't escalate (`notify.hook-unreviewed`, blocking); it also fails a `run:` that calls a package manager's install (`npm ci`, `npm install`, `pip install`, `go mod download` and the like), because a lockfile outside `.github/` would bring in code nobody reviewed.
3. **What the hook calls from outside the repository, by `K-ADOPT-12`.** A `uses:` in the hook names a version tag or a full commit SHA, never a branch; a `docker://` image names a digest (`@sha256:…`), never a tag alone. Doctor fails a hook that breaks either (`notify.hook-unpinned`, blocking), which makes this the first place `K-ADOPT-12` is checked on an adopter's own file (its "for an adopter, prose only; a guard is planned").

### 6.3 Scripts and containers

**A non-Slack adapter is always the hook,** and the hook may run what it likes inside those pins (decision 9): a script from the repository that escalates (`run: node .github/actions/notify/post-to-teams.mjs`, or a script under a declared `## Pipeline code` path), a pinned third-party action (`uses: some-org/teams-notify@<sha>`), or a container by digest (`uses: docker://ghcr.io/acme/notifier@sha256:…`). Kanon doesn't add a second way to declare a script or an image: each would be a setting a Kanon script executes (plan 0010 §7's reason for hooks), and each would need the same three pins the hook already has.

### 6.4 Why a hook, and not the stack document

The issue's sketch says "chosen in the stack declaration the way the test runner and deploy command are". The test runner works there because ADR 0012 gives Kanon a closed table of runners: the stack document only names one (``- `tests/` `vitest` — tests: …``). Chat systems have no such table, and a free command or action reference in a markdown file would be a setting a script runs. GitHub can't call an action whose name is computed (`uses:` takes no expression), so a declared action reference would still need a hook to call it. Plan 0010 reached the same answer for the deploy command (its decision 1) and the QA store before it. The stack document gains nothing (decision 1).

## 7. The Slack adapter

`actions/notify/slack.mjs`, Kanon's one shipped adapter, written to the same interface as a hook: it reads `message-v1`, `text`, `kind` and `secret`, and nothing else, so the tests run it and a fixture hook through one harness ([§12](#12-order-of-moves), N4).

**The request.** One `POST` of `application/json` to the incoming webhook, with `text` and `blocks`. **This supersedes half of plan 0004's decision 7** (accepted 2026-10-03): its "the message stays the `{"text": …}` body" ends here, as #839 asks; its other half, one secret under one fixed name, stands (decision 3). Slack's incoming webhook can't change the channel, the name or the icon: "You cannot override the default channel (chosen by the user who installed your app), username, or icon" ([§13](#13-what-slacks-documentation-says)), so the payload sets none.

**The blocks,** at most 50 per message (Slack's limit):

| From | Block |
|---|---|
| `severity` and `title` | a `header`, `plain_text` with emoji on: `:large_blue_circle:`, `:warning:` or `:rotating_light:` for `info`, `warning`, `critical`, a space, then the title. At most 20 plus 120 characters, under Slack's 150; the adapter still cuts at 150 with `…` if a later contract version ever lets it grow |
| `summary` | a `section`, `mrkdwn` |
| each section | a `divider`, then a `section` whose text is the heading in bold and the body, at most 3,000 characters, with `fields` as the section's fields; a body that renders past 3,000 characters after escaping splits at a line boundary into further sections |
| `links` and `source.run_url` | one `context` block, one `mrkdwn` element per link and one for the run: at most 9 plus 1, Slack's 10 |

When the budget of 50 runs out, the last block is a `context` that says the message was cut and links the run. The worst case of the contract's limits (a header, a summary, 20 sections of a divider and a section, one context) is 43 blocks, so only a body that escaping more than doubles can reach it. **Links are text, not buttons:** a button posts an interaction to the Slack app's request URL, which a webhook-only app doesn't have.

**Kanon text to `mrkdwn`.** `**strong**` → `*strong*`, `_emphasis_` stays, `` `code` `` stays, `[label](url)` → `<url|label>`, `- ` → `•`; a backslash-escaped character is written so Slack shows it literally (Slack's `mrkdwn` documents no escape for `*`, `_` or `` ` ``, so the adapter puts a zero-width space beside each, a common workaround that N11 checks renders as intended). **Every `&`, `<` and `>` in the source is escaped** first (`&amp;`, `&lt;`, `&gt;`, Slack's three control characters), so text from an issue title or a model's narrative can never form `<!channel>`, `<!here>` or a user mention. Today each digest escapes for itself; this moves it to one tested place.

**The `text` fallback.** Slack uses the top-level `text` for notifications and, on mobile, only that; screen readers read it first, and Slack says either to include everything necessary there or to leave it out and let Slack build it from the blocks ([§13](#13-what-slacks-documentation-says)). So (decision 6):
- **the whole message in `mrkdwn`** (the same rendering as the blocks, in one string), **when it fits in 4,000 characters,** Slack's recommended ceiling for `text`;
- **otherwise the title, the summary and the run's link,** which is what a notification needs, and the blocks carry the rest.

The digests today post up to 12,000 characters as `text` alone, three times Slack's recommendation.

**The secret** is either the webhook URL, as `DIGEST_WEBHOOK` holds today, or a JSON object routing by kind, `{"default": "<url>", "weekly-digest": "<url>"}`, so the stakeholder's digest can go to its own channel without a second secret (decision 4). The adapter refuses any URL that isn't `https://hooks.slack.com/services/…`, by name and without echoing it: a non-Slack URL means a non-Slack system, which is a hook's job, and the refusal says so.

**Errors.** A non-2xx answer fails the job with the status and Slack's error string (`invalid_payload`, `no_text`, `channel_is_archived`, `invalid_token`, `action_prohibited`), never the URL. A 429 is retried once ([§5.4](#54-when-the-post-fails)).

## 8. No adapter

**Which adapter posts** is decided in the lane's gate job, before any model runs, by what exists (decision 2):

| The repository has | Adapter |
|---|---|
| `.github/actions/notify/action.yml` at the run's commit | `hook`, which receives `DIGEST_WEBHOOK` if it is held |
| no hook, and `DIGEST_WEBHOOK` | `slack` |
| neither | `none` |

The gate reads the hook's presence from a sparse checkout that runs nothing, and the secret's presence as one boolean, `${{ secrets.DIGEST_WEBHOOK != '' }}`, the one reference to the secret outside a `notify` job that the guard admits. A run-time read is the truth doctor can't always see: an organisation secret shared with the repository is held at run time even where doctor's token can't list it.

**With `none`** (decision 12):
- **The producing job's model step is skipped,** and so is the job when its whole output is the message. That is [#836](https://github.com/yedeya-labs/kanon/issues/836), built, generalised from "no `DIGEST_WEBHOOK`" to "no adapter". N5 moves its test, the step "Will the digest be posted?", out of the `digest` job, which holds the Claude credential, into the gate, and widens it; N6 gives the weekly digest the same, which it lacks today.
- **The rest of the lane runs:** the project digest's health job files its issues as today, which is why Kanon calls that lane.
- **A dispatch with `dry_run`** still runs the producer and prints, so a person can see a digest before choosing an adapter.
- **The run's summary says "No chat adapter: nothing was posted",** and doctor reports the note `notify.none` ([§9](#9-doctors-findings)).

## 9. Doctor's findings

In `cli/doctor.mjs`'s style: one id per finding, blocking or a note, a `fix` the person can run, `unchecked` with a reason when the token can't read it. They run when a workflow calls a notifying lane. `requirements.json` gains a `notify` entry (the hook path, its inputs, the secret's name), built from the lanes by `tests/unit/requirements.test.ts`, so doctor reads the release's own copy.

| Id | Blocks | Holds when | Read from |
|---|---|---|---|
| `notify.none` | no, a note | a hook exists, or `DIGEST_WEBHOOK` is held. Its text: what is skipped (the digests' posts and narratives) and what still runs (the health job), and the fix line for each adapter | the checkout; the repository's secret names; `unchecked` when an organisation secret could hold it and can't be listed |
| `notify.hook-malformed` | yes | the hook is `using: composite` and declares `message-v<N>` for a version this release writes, and `secret` | the default branch's hook |
| `notify.hook-version-old` | no | the hook declares the newest version, or the release after next still writes the one it declares | the same |
| `notify.hook-unpinned` | yes | every `uses:` in the hook names a version tag or a full SHA, and every `docker://` a digest (`K-ADOPT-12`) | the same |
| `notify.hook-unreviewed` | yes | every `uses: ./…` in the hook, and every repository path a `run:` names, is under `.github/` or a `## Pipeline code` entry, and no `run:` installs packages ([§6.2](#62-how-a-hook-declares-and-pins-its-contract), item 2) | the default branch's hook and `docs/qa/escalation-paths.md`, read by `scripts/lib/escalation-paths.mjs` |
| `notify.failing` | no | the latest completed `notify` job of each notifying caller, on the default branch, printed `outcome: posted` | the job's log line `kanon-notify/v1`, as `app-permissions` reads `apps-check`'s |
| `notify.secret-unused` | no | when a hook exists and `DIGEST_WEBHOOK` is held, the person knows the hook receives it and the Slack adapter doesn't run | the checkout and the secret names |

**`DIGEST_WEBHOOK` leaves `secret.missing`.** A caller that maps it while the repository lacks it is `notify.none`, a note, not a blocking finding: no chat is a choice. The organisation-secret waiver `docs/doctor.md` shows as its example then has nothing to waive, and the doc's example changes.

## 10. The installer

### 10.1 The question

The install questions of 2026-10-10 are the feature, the review trigger, one consent and private material, and everything else is inferred and shown once in the summary. The issue asks for the chat choice "once, within the existing install questions". The two meet like this (decision 11):

- **Asked only when the chosen lanes notify:** the full pipeline (its two digests), or **Customise** with a digest, and later the deploy lane. **Review** and **Review + build** never see it.
- **Not asked when the repository already answers it:** a hook at the path infers **My own adapter**; `DIGEST_WEBHOOK` held infers **Slack**. Either is shown in the summary, with its source, to confirm or change.
- **Otherwise asked, in two short sentences:** "Post digests to a chat channel? Kanon posts to Slack, or to your own adapter for any other chat." Options:
  - **Slack** (Recommended): the digests post to one Slack channel through an incoming webhook you create; a person-only step follows.
  - **My own adapter:** `init` writes a stub hook at `.github/actions/notify/action.yml` that fails by name until you fill it; nothing posts until then.
  - **No chat:** nothing posts; the daily digest still runs its health checks, and no model runs for posts.
- **The flag** is `--chat slack|hook|none`; `.answers.chat` in `init --json`.

### 10.2 What each answer writes

| Answer | Callers | Person-only step | Adoption record (`K-ADOPT-1` step 10) |
|---|---|---|---|
| `slack` | each notifying caller maps `DIGEST_WEBHOOK` | `secret.digest-webhook` (the id stays): "Create an incoming webhook for the channel, then store its URL, in your own terminal", with Slack's page, [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks), as its `url`, and `gh secret set DIGEST_WEBHOOK -R <repo>`. Slack says the URL "contains a secret … Slack actively searches out and revokes leaked secrets", which is why it never goes on a command line | `- **Chat channel:** Slack, through the incoming webhook in DIGEST_WEBHOOK` |
| `hook` | the same mapping, which the hook may use | none; the stub's failure names the file and `docs/notifications.md` | `- **Chat channel:** our own adapter, .github/actions/notify` |
| `none` | the project digest's caller maps `DIGEST_WEBHOOK` anyway, so adding a webhook later needs no change to it; the weekly digest is not installed | none | `- **Chat channel:** none yet` |

**The full pipeline's lanes change** (decision 12): `agent-project-digest` becomes unconditional, since its health job is worth having without chat, as Kanon's own use shows; `agent-weekly-digest` stays conditional, now on "a chat adapter: the Slack webhook in `DIGEST_WEBHOOK`, or a notify hook". `requirements.json`'s `conditional` and `docs/lanes.json`'s features say so.

## 11. Telemetry

**None** (decision 14). The `notify` job runs no model, so it writes no run row (`K-OBS-13` records agent runs), and the producers' run rows are unchanged. The adapter's kind is the adopter's choice of chat system, which tells Kanon nothing about how its lanes behave. Whether posts land is doctor's `notify.failing`, read from the adopter's own runs. If the Overseer later needs "digests not delivered" as a signal, a `notify` stage on the producer's run row is the smallest change, as a new run-row version.

## 12. Order of moves

**Touches** names each step's files, to show which steps may run at once.

| Step | Where | What | Touches | What must be true | Mutation |
|---|---|---|---|---|---|
| **N0** | Kanon, **built** | **[#836](https://github.com/yedeya-labs/kanon/issues/836)**: the project digest skips its model when no webhook is mapped (the step "Will the digest be posted?") | `agent-project-digest.yml`, `tests/unit/digest-lanes.test.ts` | done on `main` before this plan | — |
| **N1** | Kanon | **The rule and the record:** `K-OBS-19`, new, "A lane notifies only through Kanon's notification contract, and an adapter runs only in a `notify` job" (decision 16); `K-SHIP-10`'s "Enforced by" names the `notify` job; `K-LAYOUT-1` gains the hook's path; `K-ADOPT-1` step 10 names the adoption record's `Chat channel` bullet; `K-AGENT-50`'s guard list names the `notify` job | `rulebook/08-observability-and-cost.md`, `06-shipping.md`, `11-repository-layout.md`, `10-adoption.md`, `03-agents.md`; `actions/agent-telemetry/schema.mjs` (`RULE_IDS` only) | `tests/unit/rulebook-why.test.ts` and the rulebook's guards pass; `telemetry-schema.test.ts` holds `RULE_IDS` to the headings | removing `K-OBS-19`'s heading turns `telemetry-schema.test.ts` red |
| **N2** | Kanon | **The contract** ([§3](#3-the-message-contract)): `validate`, `literal`, `prose`, `fit`, `renderText`, `SCHEMAS`; the JSON Schema; the topic doc's contract half | `scripts/lib/notify-contract.mjs`, `docs/notify/message-v1.schema.json`, `docs/notifications.md` (new), `tests/library/notify-contract.test.ts` (new) | a fixture of each kind validates; each limit is refused at one past it, naming the field and never the value; an unknown field, an `http:` link and a line break in a title are each refused. **Text nobody controls never makes a message invalid:** a draft whose project lines carry an issue titled `Support Array<string>`, one titled `**urgent** fix for snake_case_name`, and a narrative with a line starting `# ` and another starting `| a | b |`, validates after `literal` and `prose`, and `renderText` returns each exactly as written; `fit` on generated drafts far past every limit always returns a valid message that says what it cut; the JSON Schema accepts and refuses the same fixtures as `validate` | dropping the title's limit; `fit` keeping a twenty-first section; `validate` echoing a value in a problem; `literal` leaving `*` unescaped: each turns its test red |
| **N3** | Kanon | **The Slack adapter** ([§7](#7-the-slack-adapter)) | `actions/notify/slack.mjs`, `tests/library/notify-slack.test.ts` (new), `docs/notifications.md` | on a stubbed `fetch`: at most 50 blocks, a header of at most 150 characters for a 120-character title at `info` (the longest emoji), a context block of at most 10 elements for 9 links and the run, every section's text at most 3,000 characters after escaping, on a body of 2,500 `&`; `<!channel>` and `<@U1>` in any field reach Slack escaped; `text` is the full rendering under 4,000 characters and the title, summary and link over it; a JSON secret routes `weekly-digest` to its own URL and the rest to `default`; a non-Slack URL is refused without echoing it; a 429 with `Retry-After: 5` retries once; a 400 `invalid_payload` fails naming it and not the URL; an issue title `Array<string>` reaches Slack as `Array&lt;string&gt;` and `snake_case_name` unformatted | removing the escaping turns the `<!channel>` test red; removing the block cap turns the 50-block test red; giving the run link no slot of its own turns the 10-element test red |
| **N4** | Kanon | **The `notify` block and its guards** ([§5](#5-the-notify-job-where-an-adapter-runs), [§6](#6-the-adopters-adapter-the-notify-hook)); a fixture hook that writes what it received | `actions/notify/action.yml`, `actions/notify/notify.mjs`, `tests/fixtures/notify-hook/.github/actions/notify/action.yml`, `tests/unit/helpers/notify-jobs.ts` (new), `tests/unit/notify-guard.test.ts` (new), `pr-code-token-isolation.test.ts`, `app-key-isolation.test.ts`, `workflow-security.test.ts`, `docs/notifications.md` | an invalid message fails before any adapter; a hook wins over the secret; the fixture hook receives `message-v1`, `text`, `kind`, `secret`, and a hook declaring only `message-v2` is refused by name; the hook isn't called on a branch ref; the doctor line is printed for each outcome. **The guard:** in every Kanon workflow, `DIGEST_WEBHOOK` appears only in a `notify` job of `notify-jobs.ts`'s shape and in the gate's presence boolean; no script under `scripts/` but `actions/notify/slack.mjs` calls `fetch` on a host other than GitHub's, or reads `DIGEST_WEBHOOK`; each lane that maps the secret has a `notify` job; no producer script holds Slack's syntax (a `<…|…>` link, a `:shortcode:` emoji, `mrkdwn`) | **the issue's mutation:** a step in a digest job that `curl`s `$DIGEST_WEBHOOK` with raw text, and a `fetch(webhook…)` added back to `project-digest.mjs`, each turn `notify-guard.test.ts` red; `issues: write` on a `notify` job, or `CLAUDE_CODE_OAUTH_TOKEN` mapped into it, turns `notify-jobs.ts`'s check red; the hook's step without its default-branch condition turns the branch-ref test red |
| **N5** | Kanon, **a release** | **The project digest moves:** `buildMessage` returns a contract message; the gate decides the adapter; the `digest` job no longer maps the secret and uploads the message; the `notify` job posts; N0's step "Will the digest be posted?" leaves the `digest` job for the gate, as the adapter decision | `.github/workflows/agent-project-digest.yml`, `scripts/project-digest.mjs`, `scripts/lib/digest-webhook.mjs` (deleted), `tests/library/digest-webhook.test.ts` (deleted), `tests/library/project-digest.test.ts`, `tests/unit/digest-lanes.test.ts`, `tests/fixtures/lane-check/extra/agent-project-digest.yml`, `docs/lanes.md`, `docs/notifications.md` | the message validates on every fixture `buildMessage` has today; no Slack syntax remains in the script; with `none` the `digest` job is skipped and `health` runs; a dry run prints the message, the text and the Slack payload and uploads nothing; no step of the `digest` job references `DIGEST_WEBHOOK`; the caller's mapping is unchanged, so `lane-check` passes on an adopter's existing caller | the `digest` job's `if:` without the adapter condition, or N0's step left in the `digest` job, turns `digest-lanes.test.ts` red |
| **N6** | Kanon, **the same release** | **The weekly digest moves,** its narrative sanitiser unchanged; its escaping moves to the adapter; it gains the gate's adapter decision, so with `none` it runs no model, which it does today | `.github/workflows/agent-weekly-digest.yml`, `scripts/weekly-digest.mjs`, `scripts/lib/release-notes.mjs`, `tests/library/weekly-digest.test.ts`, `digest-audience.test.ts`, `release-notes.test.ts`, `tests/unit/digest-lanes.test.ts`, its lane-check fixture, `docs/lanes.md` | as N5; the stakeholder rules (nothing pending, no environment names) still hold on the message's text | as N5 |
| **N7** | Kanon | **`announce-deploy.mjs` becomes a producer** of `deploy` messages; moving `ANNOUNCED_<STAGE>_VERSION` becomes a mode of its own, `--advance`, that a job after `notify` runs only when `notify` succeeded; `SLACK_RELEASE_WEBHOOK` goes. Wiring it into plan 0010's lane is that plan's later step | `scripts/announce-deploy.mjs`, `scripts/lib/release-notes.mjs`, `tests/library/pipeline-code-imports.test.ts`, `tests/library/announce-deploy.test.ts` (new), `docs/notifications.md` | a valid `deploy` message for one release and for a range; `--advance` refuses without `NOTIFY_RESULT=success`; no request leaves for anything but GitHub | `--advance` accepting a failed `notify` turns its test red |
| **N8** | Kanon, **after plan 0008's J5** | **Doctor** ([§9](#9-doctors-findings)); `requirements.json`'s `notify` entry | `cli/doctor.mjs`, `requirements.json`, `docs/doctor.md`, `skills/doctor/SKILL.md`, `tests/unit/kanon-doctor-notify.test.ts` (new), `kanon-doctor-secrets.test.ts`, `requirements.test.ts` | each id is reported on a stubbed answer and quiet on a healthy one; `notify.none` is a note and `unchecked` where an organisation secret can't be listed; a caller mapping `DIGEST_WEBHOOK` without the secret is no longer `secret.missing`; the line is read only from a completed default-branch run | `notify.none` made blocking; `notify.hook-unpinned` accepting `@main`; `docker://…:latest` accepted; `notify.hook-unreviewed` accepting `run: node scripts/post.mjs` with no `## Pipeline code` entry for it, or `run: npm ci`: each turns its test red |
| **N9** | Kanon, **after plan 0008's J5** | **The installer** ([§10](#10-the-installer)) | `cli/init.mjs`, `docs/init.md`, `docs/install.md`, `skills/adopt/SKILL.md`, `skills/upgrade/SKILL.md`, `docs/lanes.json`, `requirements.json`, `README.md`, `docs/architecture.md`, `tests/unit/kanon-init.test.ts`, `skills.test.ts`, `requirements.test.ts`, `lanes-doc.test.ts` | the question is asked only with a notifying lane, and inferred when a hook or the secret exists; `--chat hook` writes a stub that exits non-zero naming its file; `--chat none` installs the project digest and not the weekly; the Slack step's `url` is Slack's page; the record's bullet is written for each answer | a stub that exits 0; the question asked under **Review**: each turns its test red |
| **N10** | Kanon, **after decision 13** | **Health messages:** the health job writes a `health` message when it files or reopens an issue, and the `notify` job needs both producers | `scripts/workflow-health.mjs`, `.github/workflows/agent-project-digest.yml`, `tests/unit/workflow-health.test.ts`, `digest-lanes.test.ts`, `docs/lanes.md` | no message on a run that only updates an open issue; one per issue filed or reopened | a message on every run turns its test red |
| **N11** | a sandbox repository, live | **The first posts,** to a test Slack workspace | none in Kanon; results in N11's issue | the project digest posts through Slack and renders as §7 says on desktop and mobile; a stakeholder URL in the JSON secret receives the weekly digest only; the fixture-shaped hook posts; `none` skips the model and the health job runs; a revoked webhook turns `notify` red and leaves `digest` green, and doctor's `notify.failing` reports it | — (live) |

**Why this order.**
- **The contract and its guard before any producer moves,** so the first migrated lane is held from its first commit.
- **Both digests in one release** (N5 and N6), so no release has two ways of posting and `scripts/lib/digest-webhook.mjs` goes at once.
- **Doctor and the installer last,** behind plan 0008's J5, which is changing both files; nothing in N1 to N7 needs them, and the callers an adopter already has keep working, because the secret's name and mapping don't change.

## 13. What Slack's documentation says

Read on 2026-10-14, on docs.slack.dev.

| Fact | Where |
|---|---|
| A webhook comes from a Slack app: create it, turn on "Activate Incoming Webhooks", "Add New Webhook to Workspace", choose the channel | "Sending messages using incoming webhooks" |
| "Your webhook URL contains a secret. Don't share it online, including via public version control repositories. Slack actively searches out and revokes leaked secrets." | the same |
| The body may carry `text` and `blocks`; "You cannot override the default channel (chosen by the user who installed your app), username, or icon" | the same |
| Errors: `invalid_payload`, `no_text`, `too_many_attachments`, `channel_is_archived`, `invalid_token`, `action_prohibited`, with 400, 403 and 404 | the same |
| "You can include up to 50 blocks in each message" | "Blocks" reference |
| A header's `plain_text` is at most 150 characters | "Header block" |
| A section's text is 1 to 3,000 characters; at most 10 fields, each at most 2,000 characters | "Section block" |
| A context block holds at most 10 elements | "Context block" |
| With `blocks`, `text` is "used as a fallback string to display in notifications"; screen readers read it first; keep it to 4,000 characters; past 40,000 Slack truncates | "chat.postMessage" |
| "Mobile notifications exclusively use `message.text`" | "Formatting message text" |
| `&`, `<` and `>` are control characters, escaped as `&amp;`, `&lt;`, `&gt;`; a link is `<url\|text>` | the same |
| Incoming webhooks: "1 per second", "short bursts >1 allowed"; over the limit, `HTTP 429` with `Retry-After` in seconds | "Rate limits" |

**Not confirmed, and handled by N11:** whether an incoming webhook accepts `blocks` without `text` (the adapter always sends both, so it doesn't matter), how a `header` with emoji renders on Slack's mobile client, and whether a zero-width space beside `*`, `_` or `` ` `` keeps Slack from formatting it, on desktop and mobile.

## Out of scope

- **Wiring the deploy announcement into plan 0010's lane.** N7 makes `announce-deploy.mjs` a producer; the lane's `announce` and `notify` jobs are that plan's step after its D3.
- **A `release` kind** for libraries that release without deploying, and **cost alerts** (`K-ADOPT-1` step 10 names them; nothing produces one yet). Each is an additive kind with its producer.
- **A second adapter in Kanon** (decision 10) and **naming other chat systems** (the Owner's decision of 2026-10-14: they are the adopter's adapters).
- **Interactive messages:** buttons, replies, slash commands. An incoming webhook can't receive them.
- **Threads, edits and deletes** of earlier posts.

## Owner decisions (2026-10-14)

Taken by the Owner on 2026-10-14, before this draft, and not open:

1. **Kanon provides the interface, and the adopter provides the implementation.** "Kanon provides an API and the adopter provides the implementation; one implementation we want to support is Slack." It is the deployment lane's split and #19's.
2. **Kanon ships exactly one adapter: Slack.** "One implementation that Kanon provides is Slack, but the adopter can choose to hook in a different implementation for the chats."
3. **Any other chat system is the adopter's own adapter,** hooked in through the interface Kanon defines. Kanon names no other system as supported.

## Decisions for the Owner

1. **How the adopter hooks in its adapter.** (a) A composite-action hook at a fixed path, `.github/actions/notify/action.yml`, as the QA store, project setup and plan 0010's deploy have; (b) an action reference or a command in the stack document; (c) a bullet in the adoption record naming an action. **Recommended: (a).** GitHub can't call an action whose name is computed, so (b) and (c) still need a hook to call what they name, and a command in a markdown file is a setting a script runs. [§6.4](#64-why-a-hook-and-not-the-stack-document).
2. **Which adapter posts is decided by what exists:** a hook, then the secret, then none. The alternative is a declared choice in the adoption record that the lane reads. **Recommended: by what exists,** as the QA store and the Explorer's sweep do; `init` still writes the record's `Chat channel` bullet for `K-ADOPT-1` step 10, which a person reads. [§8](#8-no-adapter).
3. **The secret keeps its name, `DIGEST_WEBHOOK`,** and is the one secret any adapter receives; a hook that needs several values stores them as JSON in it. The alternative is renaming it `CHAT_WEBHOOK` now that it also announces deploys, which changes every adopter's caller and secret. **Recommended: keep it;** the name is cosmetic and the rename costs every adopter a step. [§5.2](#52-what-the-job-holds-and-what-it-never-holds).
4. **Two channels for two audiences:** the Slack adapter accepts either a URL or a JSON object by kind (`{"default": …, "weekly-digest": …}`) in the one secret. **Recommended: yes;** the daily digest is for the developer and the weekly one for a stakeholder, and Slack binds each webhook to one channel. [§7](#7-the-slack-adapter).
5. **The contract's limits** as [§3.1](#31-shape) gives them: a 120-character title, a 1,000-character summary, 20 sections of 2,500 characters with 10 fields, 9 links, 12,000 characters in all. **Recommended: yes;** each, with what the Slack adapter adds to it (a severity emoji before the title, the run's link beside the links, escaping in a body), is within Slack's limit, and 12,000 is the digests' cut today. [§3.1](#31-shape).
6. **The `text` fallback:** the whole message when it fits Slack's 4,000, otherwise the title, the summary and the run's link. **Recommended: yes.** [§7](#7-the-slack-adapter).
7. **Kanon text,** a fixed Markdown subset in which everything else is literal and a backslash escapes markup; producers pass text nobody controls through `literal` or `prose`; no chat system's syntax, emoji or mentions in the contract, and all escaping for a chat system in its adapter. **Recommended: yes;** nothing a producer interpolates can then make a message invalid or silence a digest, and `<!channel>` stops being a risk from a model's prose. [§3.1](#31-shape).
8. **The hook runs only on the default branch's code;** a dispatch on another branch posts through Slack or not at all. **Recommended: yes,** since the hook receives the secret. [§5.3](#53-reviewed-code-only).
9. **A script or a container as an adapter:** only inside the hook: a script from the repository on an escalation path (under `.github/` or declared pipeline code), an action by tag or SHA, an image by digest; no package installs; no separate way to declare either. **Recommended: yes;** the escalation requirement is what keeps an agent's merged change from running with the secret unread. [§6.3](#63-scripts-and-containers).
10. **A generic JSON-webhook adapter shipped by Kanon,** posting the message to any URL. It would be a second Kanon adapter, which your decision of 2026-10-14 doesn't include. **Recommended: no;** the topic doc carries the ten-line hook of [§6.1](#61-the-interface) as an example, and the fixture hook proves the interface in Kanon's tests. [§6.1](#61-the-interface).
11. **The installer's question:** asked only when the chosen lanes notify, and inferred (shown in the summary) when a hook or the secret already exists; Slack recommended. The alternative is to infer it always and never ask. **Recommended: ask it under those conditions;** it is the one choice the full pipeline's person-only steps depend on, and **Review** and **Review + build** never see it. [§10](#10-the-installer).
12. **With no chat,** the project digest is still installed with the full pipeline, for its health job, and runs no model; the weekly digest isn't installed. **Recommended: yes,** as Kanon's own repository already runs it. [§8](#8-no-adapter), [§10.2](#102-what-each-answer-writes).
13. **Health messages:** the health job posts a `health` message when it files or reopens an issue, never on a run that only updates one. **Recommended: yes, as N10,** after the digests move; the issue it files stays the record. [§3.2](#32-kinds-and-severities).
14. **Telemetry:** none for notifications in this version. **Recommended: yes.** [§11](#11-telemetry).
15. **A published JSON Schema** of each contract version, generated from the validator and held equal to it. **Recommended: yes;** an adopter writing a hook in another language tests against it offline. [§3.3](#33-one-library-used-three-times).
16. **A new rule, `K-OBS-19`:** "A lane notifies only through Kanon's notification contract, and an adapter runs only in a `notify` job", enforced by N4's guards. **Recommended: yes.** [§12](#12-order-of-moves), N1.
