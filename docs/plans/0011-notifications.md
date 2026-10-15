# Plan 0011: chat notifications, a contract Kanon owns and hooks the adopter chooses

- **Status:** proposed 2026-10-14. Nothing in this plan is built. The Owner asked for it on 2026-10-14 ([#839](https://github.com/yedeya-labs/kanon/issues/839)), set its shape the same day, and later that day answered all sixteen questions the first draft left open ([Owner decisions (2026-10-14)](#owner-decisions-2026-10-14)). Seven answers differ from the draft's recommendations (2, 3, 4, 8, 10, 13 and 14), and this revision is rewritten around them: the lanes call only the adopter's hook, Kanon ships two prebuilt hooks (Slack and a generic JSON webhook), each message kind has its own secret, the hook runs on any branch's code, the health job posts nothing, and notifications are recorded in telemetry. The six questions those answers raised were answered by the Owner the same day (decisions 17 to 22): a clean break from `DIGEST_WEBHOOK`, the prebuilt hooks' pin moved by `kanon upgrade`, the rows' reader left to a follow-up, no signature on the webhook body in version 1, the `notify` job running to record `skipped`, and nothing in doctor for the branch exposure. A review then showed that the clean break, on GitHub, stops an unchanged caller's whole lane rather than only its posts ([§5.2](#52-what-the-job-holds-and-what-it-never-holds)); the plan says so, and the Owner kept the clean break knowing it (decision 23). Nothing is open.
- **Tracks:** [#839](https://github.com/yedeya-labs/kanon/issues/839). **Builds on:** [#836](https://github.com/yedeya-labs/kanon/issues/836), built (the project digest skips its model when no webhook is mapped), [plan 0004](0004-move-the-remaining-lanes.md) (decision 7, the digests' one webhook, and §3.2, the QA store's contract with hooks), [plan 0002](0002-hosted-telemetry-store.md) (the row schema and its versions), [plan 0007](0007-guided-install.md) and the install questions of 2026-10-10, and plan 0010, still a proposal in [PR #838](https://github.com/yedeya-labs/kanon/pull/838) (the deploy lane, whose announcement this plan's `deploy` message is). **Same split as** plan 0010 (Kanon owns the governance, the adopter owns the command) and [#19](https://github.com/yedeya-labs/kanon/issues/19) (a cloud-neutral interface, with AWS as one implementation). **Amends, once built:** plan 0004's decision 7, both halves: the digests' message stops being a `{"text": …}` body and becomes Block Kit with a `text` fallback in Kanon's Slack hook ([§7.2](#72-the-slack-hook)), and the one secret `DIGEST_WEBHOOK` gives way to one secret per message kind ([§5.2](#52-what-the-job-holds-and-what-it-never-holds), decision 3). **Waits on** nothing now: plan 0008's J5, which was changing `cli/init.mjs` and `cli/doctor.mjs`, has landed on `main` in both its halves (#841 and #852), so the installer and doctor steps no longer wait for it. **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), [ADR 0007](../decisions/0007-data-boundary.md), [ADR 0012](../decisions/0012-test-conventions-by-language.md), `K-AGENT-47`, `K-AGENT-50`, `K-ADOPT-1` (step 10, the chat channel), `K-ADOPT-12`, `K-SHIP-10`, `K-LAYOUT-1`, `K-LAYOUT-10`, `K-LAYOUT-17`, `K-MERGE-4`, `K-OBS-13`, `K-OBS-16` and `K-PRIN-11` (every guard can fail, and is mutation-checked).
- **Measured on** Kanon's `origin/main` at `680fffb` (v0.39.0), and again at `f1c9cf1`, after PR #832 and #836 landed: `agent-project-digest.yml`, `agent-weekly-digest.yml`, `scripts/project-digest.mjs`, `scripts/weekly-digest.mjs`, `scripts/lib/digest-webhook.mjs`, `scripts/lib/release-notes.mjs`, `scripts/announce-deploy.mjs`, every `fetch(` under `scripts/`, `cli/` and `actions/`, `cli/init.mjs`, `requirements.json`, `docs/lanes.md`, `docs/init.md`, `docs/doctor.md`, `docs/qa-store.md`, `actions/qa-store/action.yml`, `actions/agent-telemetry/schema.mjs`, `scripts/lib/code-areas.mjs`, `skills/adopt/SKILL.md`, the rulebook, and Kanon's adoption record. For the telemetry section, at `61667f0`: `actions/agent-telemetry/schema.mjs` (`SCHEMAS`, `LANES`), `infra/telemetry/function/rows.mjs` (`keysOf`), `infra/telemetry/function/aggregate.mjs`, `infra/telemetry/intake-first.mjs`, `scripts/telemetry-collect.mjs` and `docs/telemetry.md`. Slack's documentation was read on 2026-10-14 ([§13](#13-what-slacks-documentation-says)). No probe has run.

## The plan in one paragraph

**Today.** Two lanes post to chat, and a third script can. Each builds a Slack `mrkdwn` string, with Slack's emoji, link syntax and escaping, and `fetch`es it as `{"text": …}` to a URL, from the same job that holds the Claude credential. Nothing defines what a Kanon notification is, so a team on another chat system has nothing to implement, and "no chat" is an absence that doctor reports as a missing secret.

**Where it ends.**
- **One message contract, `kanon-notify` version 1,** versioned as the telemetry schema is: a kind (`project-digest`, `weekly-digest` or `deploy`), a severity, a title, a summary, sections, links and its source, in plain text with a small fixed markup, with limits taken from Slack's. No lane formats for a chat system again.
- **Every notifying lane hands its message to one job, `notify`,** which holds the lane's one chat secret and nothing else: no App key, no App token, no Claude credential, a read-only workflow token. Only there does a hook run.
- **The lanes call one thing: the hook at `.github/actions/notify/action.yml`,** a composite action, as the QA store's and the project setup's are. There is no built-in adapter and no fallback: no hook, nothing posts (decision 2).
- **Kanon ships two prebuilt hooks,** and `kanon init` writes the chosen one to that path: **Slack**, which turns the message into Block Kit with a `text` fallback and posts it to the one incoming webhook it is given, and a **generic JSON webhook**, which posts the message itself to the URL it is given (decision 10). Any other system is the adopter's own hook.
- **Each kind has its own secret,** `KANON_CHAT_PROJECT_DIGEST`, `KANON_CHAT_WEEKLY_DIGEST` and `KANON_CHAT_DEPLOY`; the adopter may store the same webhook in all three. A kind whose secret is unset is not posted (decision 3).
- **The hook runs on whatever branch the run is on** (decision 8). That is a weakness, stated plainly in [§5.3](#53-any-branchs-code-and-what-that-exposes): anyone, or any agent, who can push a branch and dispatch the lane can run a changed hook with the chat secret.
- **No hook is a choice:** the lanes skip the model work that only feeds a post (what #836 built for the project digest, widened to both digests), keep the rest, and doctor reports a note. The health job posts nothing either way (decision 13).
- **Each `notify` job writes one telemetry row,** a new row kind `notify`: its outcome (`posted`, `failed`, `skipped`) and the hook's kind (`slack`, `webhook`, `custom`), never a URL, a channel or any text (decision 14).
- **The installer asks once,** only when the chosen lanes notify: Kanon's Slack hook, Kanon's generic webhook hook, your own hook, or none. Slack's own page for creating a webhook is linked, and the person stores each secret in their own terminal.

**How it gets there.** The rule and the contract first, then the two prebuilt hooks, the telemetry row (whose intake the Owner deploys before any pin reaches it), and the `notify` job with its guards; then each producer moves behind it: the project digest, the weekly digest, `announce-deploy.mjs`. Doctor and the installer land before the release that moves the digests, so that release ships with what changes an adopter's callers and tells it what to do: a caller left unchanged at that release fails to start ([§5.2](#52-what-the-job-holds-and-what-it-never-holds)). A live run in a sandbox with a test Slack workspace closes it.

## 1. Today, measured

| What | Where | What it costs |
|---|---|---|
| The project digest builds one Slack `mrkdwn` string (`:clipboard:`, `*bold*`, `<url\|#n>`, `:rotating_light:`), cut at 12,000 characters, and `fetch`es `{"text": …}` to `DIGEST_WEBHOOK` | `scripts/project-digest.mjs`: `buildMessage`, and the `fetch(webhook, …)` at its end | Slack is the format, not one target among others; a Teams or Mattermost team gets Slack's syntax as literal text, or nothing |
| The weekly digest does the same, with its own `&`/`<`/`>` escaping and the same 12,000-character cut | `scripts/weekly-digest.mjs`: its `slackEscape`, the message's 12,000-character cut, and the `fetch(webhook, …)` at its end | Two copies of one poster, and two places to get escaping wrong |
| Both post from the `digest` job, the job that runs `agent-run` with `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | `agent-project-digest.yml`, `agent-weekly-digest.yml`, step "Post the digest" | Harmless while the poster is Kanon's own script. **An adopter's poster could never run there** (`K-AGENT-50`'s reason: step order is not a boundary inside one job) |
| `announce-deploy.mjs` is a third poster, on its own secret `SLACK_RELEASE_WEBHOOK`, with no workflow in Kanon that runs it; it moves an `ANNOUNCED_<STAGE>_VERSION` variable after a successful post | `scripts/announce-deploy.mjs`; plan 0010's "Out of scope" | `K-SHIP-10` (announce each deploy once) has a script and no lane |
| The webhook's one name, `DIGEST_WEBHOOK`, is read by `scripts/lib/digest-webhook.mjs`; the transitional `SLACK_RELEASE_WEBHOOK` fallback for the digests was removed | plan 0004 decision 7; `tests/unit/lane-check-report-lanes.test.ts` | A caller can map one secret only, to one channel, for both audiences (the developer's daily digest and the stakeholder's weekly one) |
| **The project digest skips its model with no webhook** (#836, built): its `digest` job's step "Will the digest be posted?" maps `DIGEST_WEBHOOK` into its own env and sets `narrate`; the three agent blocks run only when it is `true`, or on a dry run. The health job runs either way | `agent-project-digest.yml` | The check reads the chat secret **inside the job that holds the Claude credential**, and knows only one way to post |
| **Kanon calls the project digest for its health job alone** (`project-digest.yml`, since PR #832 on 2026-10-14), with no webhook, so its digest posts nothing and, since #836, runs no model | `.github/workflows/project-digest.yml`; `docs/qa/adoption.md` | — |
| **The weekly digest has no such check:** with no webhook it still writes its narrative, then its script logs "`DIGEST_WEBHOOK` not set — skipping" and exits 0 | `agent-weekly-digest.yml`; `scripts/weekly-digest.mjs` | A model run a week for prose nothing posts, wherever the weekly digest is called without a webhook |
| `kanon init` lists `secret.digest-webhook`, "Store the chat webhook the digests post to", and nothing else: no link to where a webhook comes from, and no "no chat" | `cli/init.mjs`, the step whose id is `secret.digest-webhook`; `docs/init.md`; `skills/adopt/SKILL.md` | The person is told to paste a URL they don't have |
| The full pipeline's digests are conditional on `DIGEST_WEBHOOK`; doctor reports a caller that maps it while the repository lacks it as `secret.missing`, which an adopter on an organisation secret has to waive | `requirements.json` (`conditional`); `docs/doctor.md` (the waiver example) | "No chat" and "forgot the secret" read the same; an organisation secret reads as missing |
| `K-ADOPT-1` step 10 asks the adoption record to say which service carries announcements, digests and cost alerts, and "how it is wired" | `rulebook/10-adoption.md`; Kanon's record: "Chat channel: not yet decided" | The record is prose; nothing writes it, and nothing reads it |
| No telemetry row says whether a post landed: the digests' run rows record the model run, and a failed post is a red step in the adopter's own run | `actions/agent-telemetry/schema.mjs` | A Kanon bug in a poster, at several adopters at once, is invisible to Kanon |

## 2. What Kanon owns and what the adopter keeps

The split the Owner set on 2026-10-14: **Kanon provides the interface; the adopter provides the implementation; Kanon also ships two implementations, Slack and a generic JSON webhook, as hooks the adopter can choose** (shape S1 and decision 10). It is plan 0010's line (Kanon owns the governance, the adopter owns the command) and #19's (a store defined by its operations, AWS the first behind them), and the QA store already lives by it (`K-OBS-17`, [`docs/qa-store.md`](../qa-store.md)).

| Kanon owns | The adopter keeps |
|---|---|
| **What a notification is:** the contract, its kinds, its fields, its limits and its versions ([§3](#3-the-message-contract)) | Whether to post at all, and where, kind by kind |
| **Who says it:** each lane builds its message with Kanon's library, and only with it ([§4](#4-producers)) | — |
| **Where a hook runs:** the `notify` job, its permissions and its one secret ([§5](#5-the-notify-job-where-a-hook-runs)) | Which secrets to store: one per kind, the same URL in each if it likes |
| **The hook's interface:** its path, its inputs, how it declares its contract version, and what it may call ([§6](#6-the-hook)) | **Which hook sits at the path:** one of Kanon's two, or its own |
| **Two prebuilt hooks,** Slack and the generic JSON webhook ([§7](#7-kanons-prebuilt-hooks)) | The Slack app, its webhooks and their channels; the receiving end of a generic webhook |
| — | **Its own hook's code,** for any other system: Teams, Mattermost, Discord, Google Chat, an e-mail relay, a pager, its own bot |
| Doctor's findings, the installer's question and the telemetry row ([§9](#9-doctors-findings), [§10](#10-the-installer), [§11](#11-telemetry)) | Whether to send telemetry at all (ADR 0007: the collector's caller is the consent) |

[ADR 0002](../decisions/0002-standardise-dont-parameterise.md) holds: the contract, the path and the secrets' names are fixed, and the adopter's content is its own. [ADR 0012](../decisions/0012-test-conventions-by-language.md)'s other rule holds too: Kanon never runs a tool the adopter didn't choose. Kanon calls Slack, or a generic webhook, only because the adopter put Kanon's hook for it at the path; it runs the adopter's own hook only because the adopter wrote it.

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
| `kind` | closed list | — | `project-digest`, `weekly-digest`, `deploy` ([§3.2](#32-kinds-and-severities)) |
| `severity` | closed list | — | `info`, `warning`, `critical` |
| `title` | plain text, one line | 1 to 120 characters | Slack's header block takes 150; the Slack hook puts a severity emoji of up to 20 characters before the title, and keeps 10 in hand |
| `summary` | Kanon text | 1 to 1,000 characters | What a person must know if they read nothing else; the notification's preview |
| `sections` | array | 0 to 20 | Each `{heading?, body, fields?}` |
| `sections[].heading` | plain text, one line | 1 to 150 characters | Optional; it goes inside the section's text, not in a header block |
| `sections[].body` | Kanon text | 1 to 2,500 characters | Slack's section block takes 3,000; the margin is the Slack hook's for escaping and link syntax ([§7.2](#72-the-slack-hook)) |
| `sections[].fields` | array of `{label, value}` | 0 to 10; label and value plain text, together at most 1,900 characters | Slack's section block takes 10 fields of 2,000 characters |
| `links` | array of `{label, url}` | 0 to 9; label 1 to 75 characters, plain; `url` `https://` only, at most 2,000 characters | Slack's context block takes 10 elements: one per link, and the tenth is the Slack hook's link to the run (`source.run_url`) |
| `source` | object | `repository` `owner/name`; `lane` one of Kanon's lane names; `run_url` `https://` | Where it came from: a hook may show it, route by it, or ignore it |
| **The whole message** | — | at most 12,000 characters of text across every field, and 64 KiB as JSON | The digests' cut today, which has held on an adopter; well under the 40,000 characters past which Slack truncates a message's text |

**Kanon text** is a fixed subset of Markdown, chosen because every chat system renders it or can strip it: paragraphs separated by a blank line, one level of `- ` bullets, `**strong**`, `_emphasis_`, `` `code` `` and `[label](https://…)`. **Everything else is literal text,** never refused: a line that starts with `#` or `|` is a line that starts with that character, and `<`, `>` and `&` are characters, which each hook escapes for its system ([§7.2](#72-the-slack-hook) does for Slack). There are no headings, tables, images, HTML, emoji shortcodes or mentions to write, because nothing renders them. **A backslash makes a markup character literal:** `\*`, `\_`, `` \` ``, `\[` and `\\`. `_` opens emphasis only at a word's start and closes only at its end, as in CommonMark, so `snake_case_name` is never emphasis even unescaped. **Plain text** fields (`title`, `heading`, `fields`, link labels) are never interpreted at all; the only thing a plain-text field can be refused for is its length, or a line break in a one-line field.

**Text nobody controls goes through `literal()`.** An issue title, a pull request's title, a label, a release note's line: a producer never writes them into Kanon text bare, but through `literal(s)`, which backslash-escapes every markup character, so `Support Array<string>` or `**urgent**` arrives as written. A model's narrative is Kanon text by intent (it may bold a word), so it goes through `prose(s)`, which keeps the subset's markup and nothing else: there is nothing else to strip, since every other character is already literal. **So no text a producer interpolates can make a message invalid,** and `fit` ([§3.3](#33-one-library-used-three-times)) only has limits to enforce.

**Why `summary` is separate.** A notification preview, a mobile push and a screen reader each read one short string first (Slack: "Mobile notifications exclusively use `message.text`", [§13](#13-what-slacks-documentation-says)). A producer that writes its own summary decides what that string says; a hook that guessed it from the first section would say whatever came first.

### 3.2 Kinds and severities

| Kind | Producer | Audience | Severity | Its secret |
|---|---|---|---|---|
| `project-digest` | the daily project digest | the developer | `warning` when a project is stopped, `info` otherwise | `KANON_CHAT_PROJECT_DIGEST` |
| `weekly-digest` | the weekly digest | a stakeholder outside the day-to-day (`K-LAYOUT-10`'s audience bullet) | `info` | `KANON_CHAT_WEEKLY_DIGEST` |
| `deploy` | `announce-deploy.mjs`, for plan 0010's lane | the Stakeholder | `info` when a deploy lands, `critical` when production fails | `KANON_CHAT_DEPLOY` |

**There is no `health` kind.** The Owner decided the health job never posts a chat message (decision 13): it files and reopens issues, and the issue is the record. The first draft's `health` kind had no other producer, so it leaves version 1's closed list, and with it the fourth per-kind secret: **three secrets, not four.** A health message later would be an additive kind with its producer ([§3.4](#34-versions)).

**Routing is by secret, not inside a hook.** Each kind's message reaches the hook with that kind's secret and no other (decision 3), so the developer's digest and the stakeholder's go wherever their two secrets point, and a hook needs no routing table (decision 4). **Adding a kind is additive:** a hook must post a kind it doesn't know as a generic message, never drop it. A `release` kind, for a library that releases without deploying, comes with its producer and its secret, which this plan doesn't build.

### 3.3 One library, used three times

`scripts/lib/notify-contract.mjs`, which imports nothing, not even a `node:` built-in, so any producer, hook or test can load it on its own:
- **`validate(message)`** returns the problems by field name and never echoes a value, because a message can hold a model's prose and a rejection reaches a log. A message is valid or it isn't posted; `validate` never repairs.
- **`literal(s)` and `prose(s)`** make text nobody controls safe to put in Kanon text ([§3.1](#31-shape)).
- **`fit(draft)`** is what producers call: it cuts a draft to the limits, at line boundaries, with a visible "… N more" or "… truncated" line, and folds a line break in a one-line field into a space. **Under its precondition:** kind, severity and source right; every required string (`title`, `summary`, each section's `body`, each field's `label` and `value`, each link's `label`) present and non-empty; and each link's `url` an `https://` URL. Since Kanon text refuses no character, the limits are then all a draft can break, so the output of a draft that meets the precondition always validates. A draft that doesn't meet it, a missing title or an `http:` link, is a producer's bug: `fit` doesn't repair it, and `validate` reports it ([the `fit(draft)` row of the topic doc](../notifications.md#the-library)). A section past the twentieth folds into a last one that names how many were left out.
- **`renderText(message)`** renders the message as **plain text**, at most 12,000 characters, for a hook that posts one string: the markup is removed, the escapes resolved, and a link written `label (url)`. Plain text, not Kanon text, so a hook that posts it to a system that renders Markdown can't have a literal `#` turned into a heading.
- **`SCHEMAS`**, `KINDS`, `SEVERITIES`, `LIMITS` and `KIND_SECRETS` (each kind's secret's name), by version.

It is used by the producers (through `fit`), by the `notify` job before any hook runs (through `validate`), and by the tests. **A published JSON Schema,** `docs/notify/message-v1.schema.json`, generated from `SCHEMAS` and held equal to it by a test, lets an adopter write its hook in any language and test it against the contract offline (decision 15). It is also what a generic-webhook receiver validates against ([§7.3](#73-the-generic-webhook-hook)).

### 3.4 Versions

As the telemetry schema's row kinds are versioned (`actions/agent-telemetry/schema.mjs`, `SCHEMAS`: "A new version is a Kanon release that adds a list; the old one stays until no supported release writes it"):
- **Within a version, changes are additive only:** a new optional field or a new kind. A hook must ignore a field it doesn't know and post a kind it doesn't know.
- **Anything else is a new version:** a field removed, renamed or retyped, a limit tightened. The `notify` job then hands a hook **both** versions for at least one stable release (plan 0009's channels) and the hook reads the one it declares ([§6.2](#62-how-a-hook-declares-and-pins-its-contract)). Doctor names a hook still on the older one.
- **Kanon's two prebuilt hooks declare the versions their release writes,** so an adopter on them moves with its pin ([§7.1](#71-how-a-prebuilt-hook-is-installed-and-pinned)).

## 4. Producers

**A lane never formats for a chat system.** Each notifying lane has exactly one producing job. Its script builds a draft with Kanon text, calls `fit`, writes one `message.json`, and uploads it as an artifact, `kanon-notify-<lane>-<job>-<run id>-<attempt>`. The producing job's id is in the name so that a lane given a second producer later can't collide with the first: `actions/upload-artifact` refuses a second artifact of the same name in a run. **One artifact per producing job, holding one message.** The first draft let one job send several (the health job's one per issue); with no health messages (decision 13) no producer sends more than one, so the block reads one `message.json` and nothing else, and a second message from one job would be a contract change, not a convention. The artifact is **named with the producer's own attempt, and published as the producing job's output `message-artifact`** (empty when nothing was uploaded), as `explore-agent-job.yml` publishes its `summary-artifact`. The `notify` job takes the name from that output and never computes it, because after "Re-run failed jobs" its own `github.run_attempt` is one past the green producer's. The producer never reads a chat secret and never makes a request to anything but GitHub. The `notify` job does the rest ([§5](#5-the-notify-job-where-a-hook-runs)).

**A dry run** (`dry_run: 'true'`, as both digests' dispatch has today) writes the message, `renderText`'s plain-text rendering (exactly what a hook's `text` input gets) and the Slack hook's payload to the job's step summary, uploads nothing, and the `notify` job is skipped: its `if:` excludes a dry run ([§5.1](#51-shape)), so a dry run posts nothing and writes no `notify` telemetry row, since nothing was meant to post. A person sees exactly what each prebuilt hook would send.

## 5. The `notify` job: where a hook runs

### 5.1 Shape

Every notifying lane gains the same job, after the job that produces the message, run by a Kanon block, `actions/notify`:

```yaml
  notify:
    needs: [gate, digest]
    # Only past an admitting gate, only with a hook, never on a dry run or a cancelled run (a
    # job-level always() would start it after a cancel); it runs after a failed or skipped producer, so a message not posted is still recorded as skipped (§11).
    if: ${{ !cancelled() && needs.gate.outputs.member == 'true' && needs.gate.outputs.hook == 'present' && inputs.dry_run != 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: $/actions/notify
        with:
          kind: project-digest
          artifact: ${{ needs.digest.outputs.message-artifact }}   # the producer's name, with its attempt; empty when it wrote none
          secret: ${{ secrets.KANON_CHAT_PROJECT_DIGEST }}          # this kind's secret, and no other
```

The block, in order:
1. **Skips, posting nothing,** when `secret` is empty (`no-secret`), and otherwise when `artifact` is empty (`no-message`): the kind is not posted (decision 3), the hook is not called, and the outcome is `skipped`. **`secret` is checked first,** because with no secret the gate also skipped the producer, so `artifact` is empty too, and `no-secret` is the reason worth recording (decision 21).
2. **Downloads** the one `message.json` and **validates** it with `notify-contract.mjs`. An invalid message fails the job by field name, posting nothing: it is a Kanon bug, and a red run is its page.
3. **Masks** the secret (`::add-mask::`) before anything prints, and each line of it when it holds several, as the QA store block masks its coordinates.
4. **Checks out the run's commit** with `persist-credentials: false`, whatever branch it is on ([§5.3](#53-any-branchs-code-and-what-that-exposes)), reads the hook's `action.yml` to choose the contract version to pass ([§6.2](#62-how-a-hook-declares-and-pins-its-contract)) and to name the hook's kind for telemetry: `slack` or `webhook` when its one step is Kanon's prebuilt action of that name ([§7.1](#71-how-a-prebuilt-hook-is-installed-and-pinned)), `custom` otherwise.
5. **Calls `./.github/actions/notify`** with the inputs of [§6.1](#61-the-interface).
6. **Prints one line for doctor,** as `apps-check` and the deploy lane's probe do: `kanon-notify/v1 {"hook":"slack","kind":"project-digest","outcome":"posted"}`, the outcome one of `posted`, `failed`, `skipped`. No URL, no channel, no text.
7. **Writes the telemetry row** ([§11](#11-telemetry)) and uploads it as `kanon-delivery-<lane>-<run id>-<attempt>`, on every outcome, as the lanes upload their run rows; only a repository that calls the collector sends it anywhere.

### 5.2 What the job holds, and what it never holds

| Holds | Never holds |
|---|---|
| **One secret, its kind's** (`KANON_CHAT_PROJECT_DIGEST`, `KANON_CHAT_WEEKLY_DIGEST` or `KANON_CHAT_DEPLOY`), by name, handed to the block as one input (`K-AGENT-47`: never the whole `secrets` context) | Another kind's chat secret, an App's key or token, a Claude credential, `id-token: write`, any other secret |
| A workflow token with `contents: read` and nothing else | `issues`, `pull-requests`, `actions` or `contents` write |
| The block's steps, the checkout and the hook | `env:` at job level (a `NODE_OPTIONS` could reach the block), `container:`, `services:`, `defaults:` |

**Every kind has its own secret** (decision 3): "Kanon treats every channel as unique secrets", and a channel is a message kind. An adopter that wants one webhook for everything stores the same URL three times; that is its choice. The names are `KANON_CHAT_` and the kind in capitals, from `KIND_SECRETS`, so a future kind's secret is named by the same rule. **They replace `DIGEST_WEBHOOK`,** which the digests' callers map today; the release that moves the digests is where an adopter changes over, and it is **a clean break** (decision 17): no lane accepts `DIGEST_WEBHOOK` from that release on, not even for one release. The release notes, `kanon upgrade` and doctor's `notify.legacy-secret` say what to do.

**What the clean break does on GitHub.** It is not silence. From N7's release the digest lanes no longer declare `DIGEST_WEBHOOK` among their `secrets:`, and GitHub refuses a call that passes a secret the called workflow does not declare (doctor already says so: `caller.secret-stale`, blocking). So a caller that moves its pin to that release and still maps `DIGEST_WEBHOOK` **fails to start:** the gate, the digest and the health job all stop, on every run, until the mapping changes. Only the callers that drop `DIGEST_WEBHOOK` in the same edit as the pin move, as `kanon upgrade` does (N11), keep their health job; with no hook and kind secrets yet, those post nothing. **A pin bump alone breaks the lane:** Dependabot's bump of a caller's `uses:` ref touches no `secrets:` line, so an adopter that moves pins only by Dependabot gets a red, unstarted lane at N7's release. The release notes mark it as a breaking change, and doctor's `notify.legacy-secret` is blocking ([§9](#9-doctors-findings)). Kanon's own callers move the same way: `agent-lanes-smoke.yml` maps `DIGEST_WEBHOOK` into both digest lanes at the running commit, so N7 and N8 change it in the same commit, and `project-digest.yml`, at Kanon's last release, drops it in the pull request that moves its pin to N7's release. The Owner kept the clean break knowing this, over a one-release declaration of `DIGEST_WEBHOOK` (decision 23).

This is the issue's "adopter code never runs in a job that holds an App key or the Claude credential", as a shape a test checks ([§12](#12-order-of-moves), N6): `tests/unit/helpers/notify-jobs.ts` holds every `notify` job to it, as `store-jobs.ts` holds the QA store's jobs, and **each `KANON_CHAT_*` secret may be referenced only in the `notify` job of the lane its kind belongs to, and in that lane's gate, as one presence boolean** ([§8](#8-no-hook)). `K-AGENT-50`'s guard, `pr-code-token-isolation.test.ts`, fails any job that runs a `./` action and references a secret; the `notify` job joins its named list of exceptions, held to the exact shape above, and the guard still fails a `notify` job in any workflow a `pull_request` or `pull_request_target` event can start, so a fork's pull request never runs a hook.

**What the hook can reach,** stated plainly: one kind's chat secret, a read-only workflow token (any composite action can read `github.token`), the run's checkout and the network. A compromised hook can post to that kind's channel or send its secret elsewhere. It can't push, comment, approve, merge, reach a model, or read another kind's secret.

### 5.3 Any branch's code, and what that exposes

**The hook runs on the run's commit, whatever branch it is on** (decision 8): a `schedule` runs the default branch's hook, and a dispatch on another branch runs that branch's. The Owner chose this over a default-branch-only rule after being told the risk, and Kanon adds no restriction. **The weakness, plainly:**
- **Anyone who can push a branch and dispatch the lane can read the kind's chat secret.** They change `.github/actions/notify/action.yml` on their branch to print or send the secret, dispatch the notifying lane on that branch, and the hook runs with it. Nothing reviews the branch first: escalation (`K-MERGE-4`) guards what merges to the default branch, not what runs on another.
- **That includes an agent.** An App that can push a branch and dispatch a workflow (`contents: write` and `actions: write`) can do it without GitHub's `workflows` permission, because the hook is not under `.github/workflows/`. An agent steered by text it read could do the same.
- **What it is not:** a fork's pull request can't, since no notifying lane has a `pull_request` trigger and the guard holds that ([§5.2](#52-what-the-job-holds-and-what-it-never-holds)); and the exposure is the chat secrets alone, never an App key or the Claude credential, which the `notify` job never holds. A person with write access can already push a workflow that reads repository secrets; what this adds is that an App without the `workflows` permission can reach the chat secrets too.
- **What it costs:** a leaked webhook lets its holder post to that channel as Kanon. Slack revokes a webhook it finds leaked ([§13](#13-what-slacks-documentation-says)); the adopter replaces it and stores the new URL.

The topic doc, `docs/notifications.md`, carries the same paragraph under its security section (N2), so an adopter reads it before choosing a hook. **Doctor says nothing about it** (decision 22): there is no per-App check for the branch exposure; the weakness is stated in this plan and the topic doc only.

**What still protects the default branch's runs.** A scheduled run executes the default branch's hook with the secret, and the Merger may merge an agent's change. Every file under `.github/` escalates (`K-MERGE-4`), so a change to the hook's `action.yml` always reaches a human first. **That covers only what escalates.** A script the hook runs from elsewhere in the repository (`scripts/post-to-teams.mjs`), a local action outside `.github/`, or a package the hook installs, is not on an escalation path unless the adopter declares it under `## Pipeline code` in `docs/qa/escalation-paths.md` (`K-MERGE-4`, `K-LAYOUT-8`). So **every repository path the hook runs must escalate** ([§6.2](#62-how-a-hook-declares-and-pins-its-contract), item 2), and doctor checks the paths it can see (`notify.hook-unreviewed`). **What doctor can't see,** and so remains: a path a script builds at run time, a file a reviewed script imports from outside `.github/` and the declared pipeline code, and a hook that `curl`s code and runs it. `notify.hook-unreviewed` reads what the hook names; what the hook's code then does is the adopter's review's to catch.

### 5.4 When the post fails

- **The `notify` job turns red,** with the hook's error, and the producing job stays green. That is `K-SHIP-10`'s "a failure to announce is reported as an announcement failure", and it is today's "a red run is the cheapest detector" (the digests' own comment) kept where it belongs. The telemetry row says `failed`.
- **Kanon's prebuilt hooks retry once, on 429 only,** after `Retry-After`, if it is at most 60 seconds ([§13](#13-what-slacks-documentation-says)). An adopter's own hook decides its own retries.
- **A re-run of the failed `notify` job** posts the same message again. "Re-run failed jobs" re-runs `notify` and reuses the green producer's outputs, so `message-artifact` still names the producer's attempt (`…-1` while `notify` runs as attempt 2), and that artifact lives the default retention. A re-run of all jobs produces and names a new one. The re-run writes its own telemetry row, under its own attempt.

## 6. The hook

### 6.1 The interface

`.github/actions/notify/action.yml`, a composite action at a fixed path (`K-LAYOUT-1` gains the row), as `.github/actions/qa-store`, `.github/actions/project-setup` and plan 0010's `.github/actions/deploy` are. **It is the only thing the lanes call** (decision 2): Kanon's Slack hook, Kanon's generic webhook hook ([§7](#7-kanons-prebuilt-hooks)), or the adopter's own. Without it, nothing posts ([§8](#8-no-hook)).

| Input | What |
|---|---|
| `message-v1` | Path to the validated message, version 1, as JSON |
| `text` | Path to `renderText`'s plain-text rendering of it, at most 12,000 characters, for a hook that posts one string |
| `kind` | The message's `kind`, for a hook that wants it without parsing JSON |
| `secret` | The value of this kind's secret, masked: whatever the hook needs to reach its system for this kind, a URL or a token (decision 3) |

**Must:** deliver the message or fail. **No outputs are read:** the block judges the hook by whether its step succeeded, as the lanes judge project-setup.

An adopter's own hook can be a few lines. The topic doc carries this one as an example of a custom hook, posting the plain text to a system that takes `{"text": …}`:

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
2. **The hook's own code, by the commit and by escalation.** The hook runs at the run's commit ([§5.3](#53-any-branchs-code-and-what-that-exposes)). Its `action.yml` is under `.github/`, so a change to it escalates to a human before it reaches the default branch. **Every other repository file it runs must escalate too:** it lives under `.github/` (`.github/actions/notify/post.mjs` beside the hook is the simplest), or is declared under `## Pipeline code`. Doctor reads each `uses: ./…` and each repository path a `run:` names, and fails one that doesn't escalate (`notify.hook-unreviewed`, blocking); it also fails a `run:` that calls a package manager's install (`npm ci`, `npm install`, `pip install`, `go mod download` and the like), because a lockfile outside `.github/` would bring in code nobody reviewed. This protects the default branch's runs; a branch's own runs are §5.3's weakness.
3. **What the hook calls from outside the repository, by `K-ADOPT-12`.** A `uses:` in the hook names a version tag or a full commit SHA, never a branch; a `docker://` image names a digest (`@sha256:…`), never a tag alone. Doctor fails a hook that breaks either (`notify.hook-unpinned`, blocking), which makes this the first place `K-ADOPT-12` is checked on an adopter's own file (its "for an adopter, prose only; a guard is planned"). Kanon's prebuilt hooks name Kanon's action by version tag, so they pass.

### 6.3 Scripts and containers

**Any system but Slack and a generic JSON webhook is the adopter's own hook,** and the hook may run what it likes inside those pins (decision 9): a script from the repository that escalates (`run: node .github/actions/notify/post-to-teams.mjs`, or a script under a declared `## Pipeline code` path), a pinned third-party action (`uses: some-org/teams-notify@<sha>`), or a container by digest (`uses: docker://ghcr.io/acme/notifier@sha256:…`). Kanon doesn't add a second way to declare a script or an image: each would be a setting a Kanon script executes (plan 0010 §7's reason for hooks), and each would need the same three pins the hook already has.

### 6.4 Why a hook, and not the stack document

The issue's sketch says "chosen in the stack declaration the way the test runner and deploy command are". The test runner works there because ADR 0012 gives Kanon a closed table of runners: the stack document only names one (``- `tests/` `vitest` — tests: …``). Chat systems have no such table, and a free command or action reference in a markdown file would be a setting a script runs. GitHub can't call an action whose name is computed (`uses:` takes no expression), so a declared action reference would still need a hook to call it. Plan 0010 reached the same answer for the deploy command (its decision 1) and the QA store before it. The stack document gains nothing (decision 1).

## 7. Kanon's prebuilt hooks

Kanon ships two (decision 10, which amends shape S2's "exactly one adapter"). Each is an ordinary hook at the path: the lanes call it exactly as they call an adopter's own, and nothing in the `notify` block knows it is Kanon's except the telemetry row's `hook` field.

### 7.1 How a prebuilt hook is installed and pinned

Each is two files in Kanon:
- **The action,** `actions/notify/slack/action.yml` with `slack.mjs`, and `actions/notify/webhook/action.yml` with `webhook.mjs`: the code, at a Kanon release, reading the four inputs of [§6.1](#61-the-interface) and nothing else, so the tests run both and a fixture hook through one harness ([§12](#12-order-of-moves), N6).
- **The hook file `kanon init` writes,** `actions/notify/hooks/slack.yml` and `actions/notify/hooks/webhook.yml`: a composite action whose one step is `uses: yedeya-labs/kanon/actions/notify/slack@vX.Y.Z` (or `…/webhook@vX.Y.Z`) with the four inputs passed through, at the release `init` runs from. `tests/unit/kanon-init.test.ts` holds what `init` writes to them byte for byte.

**So the Slack hook is the one that exists, and the lanes pick it** (the Owner's words, decision 2): there is no `adapter` input, no built-in Slack code path in the block, and no fallback. An adopter who wants to change how Slack posts edits the hook, which then counts as `custom`. **Two Kanon releases in one job, accepted.** A prebuilt hook runs `yedeya-labs/kanon/actions/notify/<name>@vX.Y.Z` inside the `notify` job, which runs `$/actions/notify` at the lane's release: two Kanon releases in one job, which `tests/unit/self-pinning.test.ts` exists to prevent elsewhere. Here it is accepted, because the two meet only at the hook's interface, and [§6.2](#62-how-a-hook-declares-and-pins-its-contract) item 1 negotiates the contract version across it: the block hands the hook the version it declares, whatever release the hook is at. **The hook's own pin moves with the callers'** (decision 18): `kanon upgrade` moves it when it moves the callers, Kanon's copy carries the release-please version marker so `init` always writes the current release, an adopter's Dependabot `github-actions` entry may name `/.github/actions/notify`, and doctor's `notify.hook-pin-behind` notes a mismatch without blocking, because an older hook that declares a version the release still writes works.

### 7.2 The Slack hook

`actions/notify/slack/slack.mjs`.

**The request.** One `POST` of `application/json` to the incoming webhook in `secret`, with `text` and `blocks`. **This supersedes plan 0004's decision 7** (accepted 2026-10-03): its "the message stays the `{"text": …}` body" ends here, as #839 asks, and its one secret under one fixed name gives way to one per kind ([§5.2](#52-what-the-job-holds-and-what-it-never-holds)). Slack's incoming webhook can't change the channel, the name or the icon: "You cannot override the default channel (chosen by the user who installed your app), username, or icon" ([§13](#13-what-slacks-documentation-says)), so the payload sets none.

**One webhook, the one it is given** (decision 4). `secret` is one Slack incoming-webhook URL, and the hook posts there. There is no routing map inside the secret: a kind goes to its own channel because its own secret holds that channel's webhook ([§3.2](#32-kinds-and-severities)). The hook refuses any value that isn't `https://hooks.slack.com/services/…`, by name and without echoing it: a non-Slack URL means a non-Slack system, which is the generic webhook hook's or the adopter's own hook's job, and the refusal says so.

**The blocks,** at most 50 per message (Slack's limit):

| From | Block |
|---|---|
| `severity` and `title` | a `header`, `plain_text` with emoji on: `:large_blue_circle:`, `:warning:` or `:rotating_light:` for `info`, `warning`, `critical`, a space, then the title. At most 20 plus 120 characters, under Slack's 150; the hook still cuts at 150 with `…` if a later contract version ever lets it grow |
| `summary` | a `section`, `mrkdwn` |
| each section | a `divider`, then a `section` whose text is the heading in bold and the body, at most 3,000 characters, with `fields` as the section's fields; a body that renders past 3,000 characters after escaping splits at a line boundary into further sections |
| `links` and `source.run_url` | one `context` block, one `mrkdwn` element per link and one for the run: at most 9 plus 1, Slack's 10 |

When the budget of 50 runs out, the last block is a `context` that says the message was cut and links the run. The worst case of the contract's limits (a header, a summary, 20 sections of a divider and a section, one context) is 43 blocks, so only a body that escaping more than doubles can reach it. **Links are text, not buttons:** a button posts an interaction to the Slack app's request URL, which a webhook-only app doesn't have.

**Kanon text to `mrkdwn`.** `**strong**` → `*strong*`, `_emphasis_` stays, `` `code` `` stays, `[label](url)` → `<url|label>`, `- ` → `•`; a backslash-escaped character is written so Slack shows it literally (Slack's `mrkdwn` documents no escape for `*`, `_` or `` ` ``, so the hook puts a zero-width space beside each, a common workaround that N12 checks renders as intended). **Every `&`, `<` and `>` in the source is escaped** first (`&amp;`, `&lt;`, `&gt;`, Slack's three control characters), so text from an issue title or a model's narrative can never form `<!channel>`, `<!here>` or a user mention. Today each digest escapes for itself; this moves it to one tested place.

**The `text` fallback.** Slack uses the top-level `text` for notifications and, on mobile, only that; screen readers read it first, and Slack says either to include everything necessary there or to leave it out and let Slack build it from the blocks ([§13](#13-what-slacks-documentation-says)). So (decision 6):
- **the whole message in `mrkdwn`** (the same rendering as the blocks, in one string), **when it fits in 4,000 characters,** Slack's recommended ceiling for `text`;
- **otherwise the title, the summary and the run's link,** which is what a notification needs, and the blocks carry the rest.

The digests today post up to 12,000 characters as `text` alone, three times Slack's recommendation.

**Errors.** A non-2xx answer fails the step with the status and Slack's error string (`invalid_payload`, `no_text`, `channel_is_archived`, `invalid_token`, `action_prohibited`), never the URL. A 429 is retried once ([§5.4](#54-when-the-post-fails)).

### 7.3 The generic webhook hook

`actions/notify/webhook/webhook.mjs`, for any system that can take a JSON body at a URL: a receiver of the adopter's own, a workflow tool, a relay to another chat system. It is the first draft's "ten-line hook" made a Kanon hook, as the Owner decided (decision 10).

**The request.** One `POST` to the URL in `secret`, with:
- **the body: the validated message itself,** exactly the contract's JSON at the version the hook declares (`message-v1` today), so the receiver gets the kind, the severity, the title, the summary, the sections in Kanon text, the links and the source, and validates it against `docs/notify/message-v1.schema.json` if it likes;
- `Content-Type: application/json` and `User-Agent: kanon-notify/1`, and nothing that identifies the adopter beyond what the message's `source` already holds.

**The URL** must be `https://`, at most 2,000 characters; anything else is refused by name, without echoing it. **One URL, the one it is given**, as with Slack: routing is by the kind's secret. **No markup is rendered and nothing is escaped:** the receiver gets Kanon text as Kanon text, and `renderText`'s plain text is not sent, since the receiver can compute what it needs; [§3.1](#31-shape)'s rules tell it what each field holds.

**Errors.** A non-2xx answer fails the step with the status alone: never the URL, and never the response body, which a receiver Kanon knows nothing about could fill with anything. A 429 is retried once, as Slack's. A redirect is not followed, so the secret URL is never re-sent to a host it doesn't name. **No signature** in this version: the URL is the secret, as Slack's is. Signing is not in version 1 (decision 20); it may come later as an optional input, which is additive.

**Versions.** The hook posts the newest version its pin declares. When version 2 exists, moving the hook's pin to a release whose hook declares `message-v2` changes the body the receiver gets; that release's notes say so, and the receiver reads `schema_version` to tell.

## 8. No hook

**Whether anything posts** is decided in the lane's gate job, before any model runs, by what exists (decision 2):

| The repository has, at the run's commit | `hook` | The producer's model |
|---|---|---|
| `.github/actions/notify/action.yml`, and the lane's kind's secret | `present` | runs |
| the hook, and not the kind's secret | `present` | skipped; `notify` runs and records `skipped` (`no-secret`) |
| no hook | `none` | skipped; `notify` doesn't run |

There is no third row for "no hook, but a secret": a secret with no hook posts nothing, because there is no built-in adapter to fall back to (decision 2). The gate reads the hook's presence from a sparse checkout that runs nothing, and the kind's secret's presence as one boolean, `${{ secrets.KANON_CHAT_PROJECT_DIGEST != '' }}`, the one reference to the secret outside the `notify` job that the guard admits. A run-time read is the truth doctor can't always see: an organisation secret shared with the repository is held at run time even where doctor's token can't list it.

**With no hook, or no secret for the kind** (decision 12):
- **The producing job's model step is skipped,** and so is the job when its whole output is the message. That is [#836](https://github.com/yedeya-labs/kanon/issues/836), built, generalised from "no `DIGEST_WEBHOOK`" to "nothing would post this kind". N7 moves its test, the step "Will the digest be posted?", out of the `digest` job, which holds the Claude credential, into the gate, and widens it; N8 gives the weekly digest the same, which it lacks today.
- **The rest of the lane runs:** the project digest's health job files its issues as today, which is why Kanon calls that lane. It never posts (decision 13). This holds for a caller whose `secrets:` match the lane; one that still maps `DIGEST_WEBHOOK` at N7's release or later is refused by GitHub and runs nothing, health job included ([§5.2](#52-what-the-job-holds-and-what-it-never-holds)).
- **A dispatch with `dry_run`** still runs the producer and prints, so a person can see a digest before choosing a hook.
- **The run's summary says what happened:** "No notify hook: nothing was posted", or "No `KANON_CHAT_PROJECT_DIGEST`: this kind was not posted". Doctor reports the note `notify.none` or `notify.kind-unset` ([§9](#9-doctors-findings)).

## 9. Doctor's findings

In `cli/doctor.mjs`'s style: one id per finding, blocking or a note, a `fix` the person can run, `unchecked` with a reason when the token can't read it. They run when a workflow calls a notifying lane. `requirements.json` gains a `notify` entry (the hook path, its inputs, each kind's secret's name), built from the lanes by `tests/unit/requirements.test.ts`, so doctor reads the release's own copy.

| Id | Blocks | Holds when | Read from |
|---|---|---|---|
| `notify.none` | no, a note | a hook exists. Its text: what is skipped (the digests' posts and narratives) and what still runs (the health job), and the fix line for each of Kanon's two hooks and for an own hook | the default branch's checkout |
| `notify.kind-unset` | no, a note | for each notifying caller, its kind's secret is held. Its text names the kind and the `gh secret set` line | the repository's secret names; `unchecked` when an organisation secret could hold it and can't be listed |
| `notify.legacy-secret` | **yes** | no notifying caller maps `DIGEST_WEBHOOK` where the lane, at the release doctor checks, no longer declares it. It is `caller.secret-stale` for this one secret, reported in its place with the notify fix: remove the line from the caller's `secrets:`, map the lane's kind secret instead, store the kind secrets with their `gh secret set` lines, and add a hook. Its text says the lane fails to start until the line goes, health job included (decision 17) | the callers, against `requirements.json` |
| `notify.hook-malformed` | yes | the hook is `using: composite` and declares `message-v<N>` for a version this release writes, and `secret` | the default branch's hook |
| `notify.hook-version-old` | no | the hook declares the newest version, or the release after next still writes the one it declares | the same |
| `notify.hook-unpinned` | yes | every `uses:` in the hook names a version tag or a full SHA, and every `docker://` a digest (`K-ADOPT-12`) | the same |
| `notify.hook-unreviewed` | yes | every `uses: ./…` in the hook, and every repository path a `run:` names, is under `.github/` or a `## Pipeline code` entry, and no `run:` installs packages ([§6.2](#62-how-a-hook-declares-and-pins-its-contract), item 2) | the default branch's hook and `docs/qa/escalation-paths.md`, read by `scripts/lib/escalation-paths.mjs` |
| `notify.hook-pin-behind` | no | a prebuilt hook's Kanon pin is the callers' pin (decision 18) | the hook and the callers |
| `notify.failing` | no | the latest completed `notify` job of each notifying caller, on the default branch, printed `outcome: posted` or `skipped` | the job's log line `kanon-notify/v1`, as `app-permissions` reads `apps-check`'s |

**`DIGEST_WEBHOOK` leaves `secret.missing`,** and no `KANON_CHAT_*` secret enters it: a kind not posted is a choice, so a missing kind secret is `notify.kind-unset`, a note. The organisation-secret waiver `docs/doctor.md` shows as its example then has nothing to waive, and the doc's example changes. The first draft's `notify.secret-unused` (a hook and a Slack secret both present) goes: with no built-in adapter there is nothing for a secret to be unused by.

## 10. The installer

### 10.1 The question

The install questions of 2026-10-10 are the feature, the review trigger, one consent and private material, and everything else is inferred and shown once in the summary. The issue asks for the chat choice "once, within the existing install questions". The two meet like this (decision 11):

- **Asked only when the chosen lanes notify:** the full pipeline (its two digests), or **Customise** with a digest, and later the deploy lane. **Review** and **Review + build** never see it.
- **Not asked when the repository already answers it:** a hook at the path infers its answer, read as the `notify` block reads it ([§5.1](#51-shape), step 4): **Kanon's Slack hook**, **Kanon's generic webhook hook**, or **My own hook**. It is shown in the summary, with its source, to confirm or change. A caller that still maps `DIGEST_WEBHOOK` infers nothing; `init` rewrites its `secrets:` to the kind secret (the lane would refuse the old one), and the summary says posts resume only once a hook is chosen and the kind secrets stored (decision 17).
- **Otherwise asked, in two short sentences:** "Post digests to a chat channel? Kanon ships a Slack hook and a generic webhook hook, or you can write your own." Options:
  - **Kanon's Slack hook** (Recommended): `init` writes it at `.github/actions/notify/action.yml`; the digests post through Slack incoming webhooks you create, one secret per kind; a person-only step follows.
  - **Kanon's generic webhook hook:** `init` writes it; each kind posts its message as JSON to a URL you choose, one secret per kind.
  - **My own hook:** `init` writes a stub hook that fails by name until you fill it; nothing posts until then.
  - **None:** no hook; nothing posts; the daily digest still runs its health checks, and no model runs for posts.
- **The flag** is `--chat slack|webhook|hook|none`; `.answers.chat` in `init --json`.

### 10.2 What each answer writes

| Answer | Files | Callers | Person-only steps | Adoption record (`K-ADOPT-1` step 10) |
|---|---|---|---|---|
| `slack` | `.github/actions/notify/action.yml` from `actions/notify/hooks/slack.yml` | each notifying caller maps its kind's secret | `secret.chat-project-digest`, and `secret.chat-weekly-digest` when the weekly digest is installed: "Create an incoming webhook for the channel, then store its URL, in your own terminal", with Slack's page, [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks), as its `url`, and `gh secret set KANON_CHAT_PROJECT_DIGEST -R <repo>`; the step says the same URL may go in both. Slack says the URL "contains a secret … Slack actively searches out and revokes leaked secrets", which is why it never goes on a command line | `- **Chat channel:** Slack, through Kanon's Slack hook (one secret per kind)` |
| `webhook` | the same path, from `actions/notify/hooks/webhook.yml` | the same | the same two ids, worded for a URL of the adopter's own and linking `docs/notifications.md`'s generic webhook section | `- **Chat channel:** a JSON webhook, through Kanon's generic webhook hook` |
| `hook` | a stub at the path that exits non-zero naming its file | the same, which the hook receives | the same two ids, worded as "whatever your hook needs for this kind" | `- **Chat channel:** our own hook, .github/actions/notify` |
| `none` | none | the project digest's caller maps its kind's secret anyway, so adding a hook later needs no change to it; the weekly digest is not installed | none | `- **Chat channel:** none yet` |

`secret.digest-webhook` gives way to one step id per kind; the deploy lane's step, `secret.chat-deploy`, comes with that lane.

**The full pipeline's lanes change** (decision 12): `agent-project-digest` becomes unconditional, since its health job is worth having without chat, as Kanon's own use shows; `agent-weekly-digest` stays conditional, now on "a notify hook at `.github/actions/notify/action.yml`". `requirements.json`'s `conditional` and `docs/lanes.json`'s features say so.

## 11. Telemetry

**In scope** (decision 14). The Owner's words: a `notify` stage or outcome "on the producers' run rows (or the smallest versioned schema change the plan judges right)", with the outcome and the hook's kind, "never URL, channel or text".

**Why a row of its own, not a field on the producer's run row.** The producer's run row is written and uploaded inside the producing job, as `kanon-telemetry-<lane>-<run id>-<attempt>` ([`docs/telemetry.md`](../telemetry.md), "Collect the rows"), before the `notify` job starts, so it can't hold an outcome that doesn't exist yet. Re-writing it from the `notify` job would mean two rows for one key in one sweep, with the store keeping whichever arrived last, and a re-run of `notify` alone would write under an attempt the producer never had. And when nothing would post, the producer's model never runs, so for the `no-secret` case the run row records a model that didn't run, not a notification. A new row kind, written by the job that knows the outcome, is the smallest change that is true in each case: one new list in `SCHEMAS`, no new version of the run row, and nothing for an existing reader to learn.

**The `notify` row, version 1:**

| Field | Type | What |
|---|---|---|
| `schema_version` | `1` | |
| `row_kind` | `notify` | |
| `tag` | `run`, `smoke`, `test` | as the run row's |
| `recorded_at` | time | when the block finished |
| `run_id`, `run_attempt` | integers | the `notify` job's run and attempt |
| `producer_attempt` | integer | the attempt in the artifact's name, so a re-run of `notify` alone is told apart from a fresh run |
| `lane` | one of `LANES` | the notifying lane |
| `kanon_version` | release or `dev` | the block's |
| `kind` | `project-digest`, `weekly-digest`, `deploy` | the message's kind |
| `contract_version` | integer | the message version the hook was handed; absent when skipped before the hook was read |
| `hook` | `slack`, `webhook`, `custom` | the hook's kind, as step 4 of [§5.1](#51-shape) names it |
| `outcome` | `posted`, `failed`, `skipped` | |
| `skip_reason` | `no-message`, `no-secret` | only with `skipped` |
| `failure` | `invalid-message`, `hook-step-failed` | only with `failed`: Kanon's validator refused the message, or the hook's step failed |
| `duration_ms` | count | from download to the hook's end |

No URL, channel, host, text, status body or secret. The cross-field rules (`skip_reason` only with `skipped`, `failure` only with `failed`) are in `validate`, as the run row's `reason` is checked against its outcome. A `deploy` row needs plan 0010's lane in `LANES` first; until then only the two digests write rows.

**The store.** The row goes to the lane's partition, `<key>#<lane>`, under an `sk` that begins `notify#` and holds the time, run and attempt, from a new branch of `infra/telemetry/function/rows.mjs`'s `keysOf`. The aggregate already skips any `row_kind` but `run`. The page view's rows pass through `prepareRows` (`infra/telemetry/function/indicators.mjs`), which today infers a row's kind, so N5 makes it skip a `notify` row and tests that it does. Erase's walk over the key's partitions removes it with the rest. Nothing in this plan reads it: the first reader, a `notify` cell in the aggregate (posted and failed by `hook` and release, Kanon's prebuilt hooks only, behind the same three-adopter floor), is a follow-up after N12, built against real rows (decision 19).

**The collector.** `scripts/telemetry-collect.mjs` lists a third artifact family, `kanon-delivery-<lane>-<run id>-<attempt>`, beside `kanon-telemetry-*` and `kanon-finding-*`, holding `kanon-delivery.json`, one row. It checks the row with `validate` and against its artifact's lane, run and attempt, ignores a fork's run, and sends it with the run rows. A collector pinned at a release before this ignores the family, and the artifacts expire unsent; nothing turns red.

**Consent and deploy order.** The `notify` block uploads the row on every run, as the lanes upload their run rows; only a repository whose workflows call Kanon's collector sends it (ADR 0007). A new row kind is a widening: an ingest function deployed from an earlier release refuses it with a 422 and the collector turns red. So **the Owner deploys intake from the release that ships the `notify` row kind before any repository's pin reaches it**, as for run row version 3 ([`docs/telemetry.md`](../telemetry.md), the Overseer's cost view), and `infra/telemetry/intake-first.mjs` names it as a widening when that release is checked. The release that ships the row kind (N5) can be the release before the one whose `notify` block writes rows (N6), so intake is deployed before any lane can write one.

## 12. Order of moves

**Touches** names each step's files, to show which steps may run at once.

| Step | Where | What | Touches | What must be true | Mutation |
|---|---|---|---|---|---|
| **N0** | Kanon, **built** | **[#836](https://github.com/yedeya-labs/kanon/issues/836)**: the project digest skips its model when no webhook is mapped (the step "Will the digest be posted?") | `agent-project-digest.yml`, `tests/unit/digest-lanes.test.ts` | done on `main` before this plan | — |
| **N1** | Kanon | **The rule and the record:** `K-OBS-19`, new, "A lane notifies only through Kanon's notification contract, and a hook runs only in a `notify` job" (decision 16); `K-SHIP-10`'s "Enforced by" names the `notify` job; `K-LAYOUT-1` gains the hook's path; `K-ADOPT-1` step 10 names the adoption record's `Chat channel` bullet; `K-AGENT-50`'s guard list names the `notify` job and why it may run any branch's code (decision 8) | `rulebook/08-observability-and-cost.md`, `06-shipping.md`, `11-repository-layout.md`, `10-adoption.md`, `03-agents.md`; `actions/agent-telemetry/schema.mjs` (`RULE_IDS` only) | `tests/unit/rulebook-why.test.ts` and the rulebook's guards pass; `telemetry-finding.test.ts` holds `RULE_IDS` to the headings | removing `K-OBS-19`'s heading turns `telemetry-finding.test.ts` red |
| **N2** | Kanon | **The contract** ([§3](#3-the-message-contract)): `validate`, `literal`, `prose`, `fit`, `renderText`, `SCHEMAS`, `KIND_SECRETS`; the JSON Schema; the topic doc's contract half and its security section ([§5.3](#53-any-branchs-code-and-what-that-exposes)'s weakness, word for word) | `scripts/lib/notify-contract.mjs`, `docs/notify/message-v1.schema.json`, `docs/notifications.md` (new), `tests/library/notify-contract.test.ts` (new) | a fixture of each of the three kinds validates, and a `health` kind is refused; `KIND_SECRETS` names `KANON_CHAT_PROJECT_DIGEST`, `KANON_CHAT_WEEKLY_DIGEST`, `KANON_CHAT_DEPLOY`; each limit is refused at one past it, naming the field and never the value; an unknown field, an `http:` link and a line break in a title are each refused. **Text nobody controls never makes a message invalid:** a draft whose project lines carry an issue titled `Support Array<string>`, one titled `**urgent** fix for snake_case_name`, and a narrative with a line starting `# ` and another starting `| a | b |`, validates after `literal` and `prose`, and `renderText` returns each exactly as written; `fit` on generated drafts far past every limit always returns a valid message that says what it cut; the JSON Schema accepts and refuses the same fixtures as `validate` | dropping the title's limit; `fit` keeping a twenty-first section; `validate` echoing a value in a problem; `literal` leaving `*` unescaped; `health` left in `KINDS`: each turns its test red |
| **N3** | Kanon | **The Slack hook** ([§7.1](#71-how-a-prebuilt-hook-is-installed-and-pinned), [§7.2](#72-the-slack-hook)) | `actions/notify/slack/action.yml`, `actions/notify/slack/slack.mjs`, `actions/notify/hooks/slack.yml`, `tests/library/notify-slack.test.ts` (new), `docs/notifications.md` | on a stubbed `fetch`: at most 50 blocks, a header of at most 150 characters for a 120-character title at `info` (the longest emoji), a context block of at most 10 elements for 9 links and the run, every section's text at most 3,000 characters after escaping, on a body of 2,500 `&`; `<!channel>` and `<@U1>` in any field reach Slack escaped; `text` is the full rendering under 4,000 characters and the title, summary and link over it; **the one URL in `secret` is the one posted to,** and a JSON object in `secret` is refused as not a Slack URL, without echoing it; a non-Slack URL is refused the same way; a 429 with `Retry-After: 5` retries once; a 400 `invalid_payload` fails naming it and not the URL; an issue title `Array<string>` reaches Slack as `Array&lt;string&gt;` and `snake_case_name` unformatted; `hooks/slack.yml`'s one step names `actions/notify/slack` at a version tag and passes the four inputs | removing the escaping turns the `<!channel>` test red; removing the block cap turns the 50-block test red; giving the run link no slot of its own turns the 10-element test red; a hook file naming `@main` turns its pin test red |
| **N4** | Kanon | **The generic webhook hook** ([§7.3](#73-the-generic-webhook-hook)) | `actions/notify/webhook/action.yml`, `actions/notify/webhook/webhook.mjs`, `actions/notify/hooks/webhook.yml`, `tests/library/notify-webhook.test.ts` (new), `docs/notifications.md` | on a stubbed `fetch`: the body is byte for byte the validated message, and validates against `docs/notify/message-v1.schema.json`; `Content-Type` and `User-Agent` are set and no other identifying header; an `http://` URL is refused without echoing it; a 302 is not followed and fails; a 500 fails with the status and neither the URL nor the response body in the log; a 429 with `Retry-After: 5` retries once | the body sent as `renderText`'s text instead of the message; following a redirect; a response body printed on failure: each turns its test red |
| **N5** | Kanon, **a release, then the Owner deploys intake from it** | **The `notify` row** ([§11](#11-telemetry)): the row kind in `SCHEMAS`, its cross-field rules, the store's key, the collector's third family | `actions/agent-telemetry/schema.mjs`, `infra/telemetry/function/rows.mjs`, `infra/telemetry/function/indicators.mjs`, `scripts/telemetry-collect.mjs`, `tests/unit/telemetry-schema.test.ts`, `telemetry-ingest.test.ts`, `telemetry-intake-first.test.ts`, `telemetry-aggregate.test.ts`, `tests/library/telemetry-collect.test.ts`, `docs/telemetry.md` | a row of each outcome validates; a row with `url`, `channel` or `text`, a `skip_reason` with `posted`, or a `failure` with `skipped` is refused whole; `keysOf` puts it in `<key>#<lane>` under `notify#…` and never collides with a run row of the same run; the aggregate and the page view count no `notify` row; the collector sends a `kanon-delivery-*` row only when its lane, run and attempt are its artifact's, and ignores a fork's; `intake-first.mjs` between the release before and this one names the `notify` row kind as a widening | a `url` field admitted; the collector sending a row whose lane isn't its artifact's; the aggregate counting a `notify` row as a run: each turns its test red |
| **N6** | Kanon, **a release after N5's intake deploy** | **The `notify` block and its guards** ([§5](#5-the-notify-job-where-a-hook-runs), [§6](#6-the-hook)); a fixture hook that writes what it received | `actions/notify/action.yml`, `actions/notify/notify.mjs`, `tests/fixtures/notify-hook/.github/actions/notify/action.yml`, `tests/unit/helpers/notify-jobs.ts` (new), `tests/unit/notify-guard.test.ts` (new), `tests/library/notify-block.test.ts` (new), `pr-code-token-isolation.test.ts`, `app-key-isolation.test.ts`, `workflow-security.test.ts`, `self-pinning.test.ts` (an exemption, `actions/notify/action.yml: ./.github/actions/notify`, with the reason "the adopter's hook, in the adopter's checkout", as the QA store block's), `lane-gate.test.ts`, `docs/notifications.md` | an invalid message fails before any hook runs; **an empty `artifact` or an empty `secret` calls no hook and records `skipped` with its reason, and with both empty the reason is `no-secret`;** with the gate refusing the actor (`member` empty or `false`), with no hook, on a dry run, or on a run cancelled after the producer published its artifact, the `notify` job doesn't start and writes no row, while after a failed or skipped producer it does start and records `skipped`; and `lane-gate.test.ts`'s `gateProblems` passes on its `if:`; the fixture hook receives `message-v1`, `text`, `kind`, `secret`, and a hook declaring only `message-v2` is refused by name; **the hook is called on a branch ref as on the default branch** (decision 8); Kanon's two hook files are named `slack` and `webhook` and the fixture `custom`; **on a re-run of `notify` alone,** with `github.run_attempt` 2 and the producer's output naming `…-1`, the block downloads and posts the producer's message, and the row says `producer_attempt` 1; the doctor line and a valid `notify` row are written for each outcome, with no URL, text or secret in either. **The guard:** in every Kanon workflow, each `KANON_CHAT_*` secret appears only in the `notify` job of its kind's lane, of `notify-jobs.ts`'s shape, and in that lane's gate's presence boolean; `DIGEST_WEBHOOK` appears in no notifying lane from N7's release on (each lane loses it in the step that moves it, N7 and N8, which ship together), the clean break of decision 17; no `notify` job is in a workflow with a `pull_request` or `pull_request_target` trigger; no script under `scripts/` calls `fetch` on a host other than GitHub's, or reads a chat secret; each lane that maps a chat secret has a `notify` job and exactly one producing job; no producer script holds Slack's syntax (a `<…\|…>` link, a `:shortcode:` emoji, `mrkdwn`). The emoji check reads only the producers' string and template literals, with comments removed, and matches `:[a-z0-9_+-]+:` bounded by a non-word character or the literal's edge, so an `a:b:c` key, a `16:30:` time or a `https://` URL in code is never a hit | **the issue's mutation:** a step in a digest job that `curl`s a chat secret with raw text, and a `fetch(webhook…)` added back to `project-digest.mjs`, each turn `notify-guard.test.ts` red; `issues: write` on a `notify` job, `CLAUDE_CODE_OAUTH_TOKEN` mapped into it, or the weekly digest's secret mapped into the project digest's `notify` job, turns `notify-jobs.ts`'s check red; a `pull_request` trigger added to a notifying lane turns the guard red; the block computing the artifact's name from its own `github.run_attempt` turns the re-run test red; the block calling the hook with an empty secret turns the skip test red; checking `artifact` before `secret` turns the both-empty case red; an `if:` reading `needs.gate.outputs.hook != 'none'`, or one without the dry-run condition, turns the gate and dry-run cases red; job-level `always()` in place of `!cancelled()` turns the cancelled-run case red; a `:rotating_light:` left in a string in `project-digest.mjs`, or a `<${url}\|#${n}>` link, turns `notify-guard.test.ts` red, and an `a:b:c` key in the same file doesn't |
| **N7** | Kanon, **a release** | **The project digest moves:** `buildMessage` returns a contract message; the gate decides `hook` and reads the kind's secret's presence; the `digest` job no longer maps any secret and uploads the message; the `notify` job posts through the hook; N0's step "Will the digest be posted?" leaves the `digest` job for the gate; the caller maps `KANON_CHAT_PROJECT_DIGEST` | `.github/workflows/agent-project-digest.yml`, `scripts/project-digest.mjs`, `scripts/lib/digest-webhook.mjs` (deleted), `tests/library/digest-webhook.test.ts` (deleted), `tests/library/project-digest.test.ts`, `tests/unit/digest-lanes.test.ts`, `tests/unit/lane-gate.test.ts` (the lane is in its `LANES`, and its new `notify` job's `if:` must pass `gateProblems`), `tests/fixtures/lane-check/extra/agent-project-digest.yml`, `.github/workflows/agent-lanes-smoke.yml` (its `project-digest` job maps `KANON_CHAT_PROJECT_DIGEST` instead of `DIGEST_WEBHOOK`, in the same commit), `docs/lanes.md`, `docs/notifications.md`; Kanon's `project-digest.yml` changes its mapping in the pull request that moves its pin to this release | the message validates on every fixture `buildMessage` has today; no Slack syntax remains in the script; with no hook, or no `KANON_CHAT_PROJECT_DIGEST`, the `digest` job is skipped and `health` runs; **with `KANON_CHAT_PROJECT_DIGEST` set and no hook, nothing posts** (decision 2); with a hook, `KANON_CHAT_PROJECT_DIGEST` is what the hook is handed; **the lane declares no `DIGEST_WEBHOOK` secret at all** (decision 17), so a lane-check fixture caller that still maps it is refused, the failure decision 17 makes on purpose; no workflow in Kanon maps `DIGEST_WEBHOOK` into the lane; a dry run prints the message, the text and the Slack hook's payload and uploads nothing; no step of the `digest` job references a chat secret; the health job writes no message | the `digest` job's `if:` without the hook condition, or N0's step left in the `digest` job, turns `digest-lanes.test.ts` red; a Slack post with no hook present turns the decision-2 test red; `DIGEST_WEBHOOK` declared back in the lane's `secrets:`, or left in `agent-lanes-smoke.yml`, turns its test red |
| **N8** | Kanon, **the same release** | **The weekly digest moves,** its narrative sanitiser unchanged; its escaping moves to the Slack hook; it gains the gate's decision on `KANON_CHAT_WEEKLY_DIGEST`, so with no hook or no secret it runs no model, which it does today | `.github/workflows/agent-weekly-digest.yml`, `scripts/weekly-digest.mjs`, `scripts/lib/release-notes.mjs`, `tests/library/weekly-digest.test.ts`, `digest-audience.test.ts`, `release-notes.test.ts`, `tests/unit/digest-lanes.test.ts`, its lane-check fixture, `.github/workflows/agent-lanes-smoke.yml` (its `weekly-digest` job, as N7's), `docs/lanes.md` | as N7; the stakeholder rules (nothing pending, no environment names) still hold on the message's text; its `notify` job holds `KANON_CHAT_WEEKLY_DIGEST` and not the project digest's | as N7 |
| **N9** | Kanon | **`announce-deploy.mjs` becomes a producer** of `deploy` messages; moving `ANNOUNCED_<STAGE>_VERSION` becomes a mode of its own, `--advance`, that a job after `notify` runs only when `notify` posted; `SLACK_RELEASE_WEBHOOK` goes, and `KANON_CHAT_DEPLOY` is its kind's secret. Wiring it into plan 0010's lane, and adding that lane to `LANES` for its rows, is that plan's later step | `scripts/announce-deploy.mjs`, `scripts/lib/release-notes.mjs`, `tests/library/pipeline-code-imports.test.ts`, `tests/library/announce-deploy.test.ts` (new), `docs/notifications.md` | a valid `deploy` message for one release and for a range; `--advance` refuses without `NOTIFY_RESULT=success`; no request leaves for anything but GitHub | `--advance` accepting a failed `notify` turns its test red |
| **N10** | Kanon, **before N7's release** | **Doctor** ([§9](#9-doctors-findings)); `requirements.json`'s `notify` entry | `cli/doctor.mjs`, `requirements.json`, `docs/doctor.md`, `skills/doctor/SKILL.md`, `tests/unit/kanon-doctor-notify.test.ts` (new), `kanon-doctor-secrets.test.ts`, `requirements.test.ts` | each id is reported on a stubbed answer and quiet on a healthy one; `notify.none` and `notify.kind-unset` are notes, and `notify.kind-unset` is `unchecked` where an organisation secret can't be listed; a caller mapping a chat secret the repository lacks is never `secret.missing`; `notify.legacy-secret` names a caller still mapping `DIGEST_WEBHOOK`; `notify.hook-pin-behind` names a prebuilt hook pinned below the callers; the line is read only from a completed default-branch run | `notify.none` made blocking; `notify.hook-unpinned` accepting `@main`; `docker://…:latest` accepted; `notify.hook-unreviewed` accepting `run: node scripts/post.mjs` with no `## Pipeline code` entry for it, or `run: npm ci`; `notify.kind-unset` reported as `secret.missing`; `notify.legacy-secret` made a note, or reported beside `caller.secret-stale` for the same line: each turns its test red |
| **N11** | Kanon, **before N7's release** | **The installer** ([§10](#10-the-installer)) | `cli/init.mjs`, `docs/init.md`, `docs/install.md`, `skills/adopt/SKILL.md`, `skills/upgrade/SKILL.md`, `docs/lanes.json`, `requirements.json`, `README.md`, `docs/architecture.md`, `tests/unit/kanon-init.test.ts`, `skills.test.ts`, `requirements.test.ts`, `lanes-doc.test.ts` | the question is asked only with a notifying lane, and inferred when a hook exists, naming which; `--chat slack` and `--chat webhook` write `actions/notify/hooks/<name>.yml` byte for byte, pinned at `init`'s release; `--chat hook` writes a stub that exits non-zero naming its file; `--chat none` writes no hook and installs the project digest and not the weekly; each notifying caller maps its own kind's secret; the person-only steps are one per kind, and the Slack ones' `url` is Slack's page; the record's bullet is written for each answer; the upgrade skill moves a prebuilt hook's pin with the callers' (decision 18), and for a repository whose callers map `DIGEST_WEBHOOK`, **rewrites each caller's `secrets:` in the same edit as the pin move** (drops `DIGEST_WEBHOOK`, maps the lane's kind secret), so the lane still starts, then says posts resume once a hook and the kind secrets exist, never that the old secret still works (decision 17) | a stub that exits 0; the upgrade leaving a prebuilt hook's pin behind the callers'; the question asked under **Review**; a caller mapping `DIGEST_WEBHOOK`; the upgrade moving a digest caller's pin past N7's release and leaving `DIGEST_WEBHOOK` in its `secrets:`; `--chat slack` writing no hook: each turns its test red |
| **N12** | a sandbox repository, live | **The first posts,** to a test Slack workspace and a test JSON receiver | none in Kanon; results in N12's issue | the project digest posts through Kanon's Slack hook and renders as §7.2 says on desktop and mobile; with two different webhooks in `KANON_CHAT_PROJECT_DIGEST` and `KANON_CHAT_WEEKLY_DIGEST`, each digest lands only in its own channel; Kanon's generic webhook hook delivers the message JSON to the receiver; the fixture-shaped own hook posts; with no hook the model is skipped and the health job runs; a dispatch on a branch runs that branch's hook; a revoked webhook turns `notify` red and leaves `digest` green, doctor's `notify.failing` reports it, and the collector sends a `notify` row saying `failed` | — (live) |

**Why this order.**
- **The contract and its guard before any producer moves,** so the first migrated lane is held from its first commit.
- **Both prebuilt hooks before the block,** so the block's tests run Kanon's real hooks as well as the fixture.
- **The row kind a release before the block that writes it** (N5, then N6), so the Owner deploys intake from N5's release before any lane can write a `notify` row, and no collector turns red ([§11](#11-telemetry)).
- **Both digests in one release** (N7 and N8), so no release has two ways of posting and `scripts/lib/digest-webhook.mjs` goes at once. That release is the one where `DIGEST_WEBHOOK` stops working, a clean break with no bridge release, and its notes say what to do (decision 17).
- **Doctor and the installer before the digests' release, not after it.** The first draft put them behind plan 0008's J5, which was changing both files; J5 has since landed on `main` in both halves (#841 and #852), so nothing holds them back. With the clean break (decision 17), a caller that moves its pin to N7's release without changing its `secrets:` fails to start ([§5.2](#52-what-the-job-holds-and-what-it-never-holds)), so **N7 and N8 do not ship in a release without N10 and N11:** doctor's blocking `notify.legacy-secret` and the upgrade's rewrite of the callers' mapping are what keep an adopter's lane starting. They may merge before N7, since nothing in them needs the moved lanes, or in the same release.

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

**Not confirmed, and handled by N12:** whether an incoming webhook accepts `blocks` without `text` (the hook always sends both, so it doesn't matter), how a `header` with emoji renders on Slack's mobile client, and whether a zero-width space beside `*`, `_` or `` ` `` keeps Slack from formatting it, on desktop and mobile.

## Out of scope

- **Wiring the deploy announcement into plan 0010's lane.** N9 makes `announce-deploy.mjs` a producer; the lane's `announce` and `notify` jobs, and its place in `LANES`, are that plan's step after its D3.
- **A `release` kind** for libraries that release without deploying, **cost alerts** (`K-ADOPT-1` step 10 names them; nothing produces one yet), and **health messages** (decision 13: never, for now). Each would be an additive kind with its producer and its secret.
- **A third prebuilt hook,** and **naming other chat systems** (shape S3: they are the adopter's own hooks).
- **A default-branch restriction on the hook** (decision 8: the Owner chose any branch).
- **Interactive messages:** buttons, replies, slash commands. An incoming webhook can't receive them.
- **Threads, edits and deletes** of earlier posts.
- **A reader of the `notify` rows,** a follow-up after N12 (decision 19).
- **A signature on the generic webhook's body** (decision 20: later, as an optional input).
- **Any doctor check of the branch exposure** (decision 22).

## Owner decisions (2026-10-14)

All taken by the Owner on 2026-10-14, and not open.

### The shape, before the draft

- **S1. Kanon provides the interface, and the adopter provides the implementation.** "Kanon provides an API and the adopter provides the implementation; one implementation we want to support is Slack." It is the deployment lane's split and #19's.
- **S2. Kanon ships exactly one adapter: Slack.** "One implementation that Kanon provides is Slack, but the adopter can choose to hook in a different implementation for the chats." **Amended by decision 10** the same day: Kanon now ships two prebuilt hooks, Slack and a generic JSON webhook.
- **S3. Any other chat system is the adopter's own adapter,** hooked in through the interface Kanon defines. Kanon names no other system as supported.

### The answers to the draft's sixteen questions

The first draft asked these as "Decisions for the Owner", each with a recommendation. Seven answers differ from the recommendation, marked **changed**.

1. **How the adopter hooks in its adapter: a composite-action hook at the fixed path `.github/actions/notify/action.yml`,** as the QA store, project setup and plan 0010's deploy have. As recommended. [§6.4](#64-why-a-hook-and-not-the-stack-document).
2. **Which adapter posts: the adopter's hook, and only the hook. Changed.** No built-in fallback to Slack when a secret is set; Slack is a prebuilt hook that Kanon ships, which the adopter chooses by having it at the path; no hook means no adapter. The Owner's words: "The adopter's hook if there is one. Without a built-in fallback to Slack if the secret is set. Slack is the hook that Kanon provides. The adopter should choose Kanon's prebuild Slack hook if Slack should be used. In this case, the Slack hook will be the only existing one and the lanes pick that one. Or another custom hook that the adopter provides." [§7.1](#71-how-a-prebuilt-hook-is-installed-and-pinned), [§8](#8-no-hook).
3. **The secret: one per message kind. Changed.** The Owner's words: "If the adopter wishes to use one webhook for all channels, that is his choice. Kanon treats every channel as unique secrets." A channel is a message kind. The `notify` job passes the kind's secret to the hook as its `secret` input, and a kind whose secret is unset is not posted (outcome `skipped`). With the `health` kind removed (decision 13), that is three secrets, `KANON_CHAT_PROJECT_DIGEST`, `KANON_CHAT_WEEKLY_DIGEST` and `KANON_CHAT_DEPLOY`, replacing `DIGEST_WEBHOOK`. [§5.2](#52-what-the-job-holds-and-what-it-never-holds).
4. **Two channels: fed to the hook, not built in. Changed.** The Slack hook takes the one webhook it is given; there is no routing map inside a secret. Routing is by which kind's secret the job passes (decision 3). [§7.2](#72-the-slack-hook).
5. **The contract's limits as [§3.1](#31-shape) gives them.** As recommended.
6. **The `text` fallback:** the whole message when it fits Slack's 4,000 characters, otherwise the title, the summary and the run's link. As recommended. [§7.2](#72-the-slack-hook).
7. **Kanon text:** a fixed Markdown subset, `literal` and `prose` for text nobody controls, and all escaping for a chat system in its hook. As recommended. [§3.1](#31-shape).
8. **The hook runs on any branch's code. Changed.** The Owner chose this over the default-branch-only rule, having been told the risk: anyone who can push a branch and dispatch the lane can read the secrets. The plan states the weakness and adds no restriction. [§5.3](#53-any-branchs-code-and-what-that-exposes).
9. **Scripts and containers only inside the hook:** a repository script on an escalation path, an action by tag or SHA, an image by digest, no package installs. As recommended. [§6.3](#63-scripts-and-containers).
10. **A generic JSON-webhook adapter: yes, Kanon ships it. Changed.** It is a second prebuilt hook beside Slack, posting the contract message as JSON to the URL in its secret. **This amends shape S2's "exactly one adapter":** Kanon now ships two prebuilt hooks, Slack and the generic JSON webhook, and any other system is the adopter's own hook. [§7.3](#73-the-generic-webhook-hook).
11. **The installer's question:** asked only when the chosen lanes notify, inferred and shown in the summary when a hook already exists; the answers are Kanon's Slack hook, Kanon's generic webhook hook, my own hook, or none; Slack recommended; **Review** and **Review + build** never see it. As recommended, with the answers widened by decisions 2 and 10. [§10](#10-the-installer).
12. **With no chat,** the project digest is still installed with the full pipeline, for its health job, and runs no model; the weekly digest isn't installed. As recommended. [§8](#8-no-hook).
13. **Health messages: never. Changed.** The health job posts no chat message; health stays issues-only. The first draft's step for it (its N10) is dropped, and so is the `health` kind: it had no other producer, so it leaves version 1's closed list, and the per-kind secrets are three. [§3.2](#32-kinds-and-severities).
14. **Telemetry: yes, now. Changed.** A `notify` outcome (`posted`, `failed`, `skipped`) and the hook's kind (`slack`, `webhook`, `custom`), never a URL, a channel or text, "on the producers' run rows (or the smallest versioned schema change the plan judges right)". The plan judges a new row kind the smallest true change, and says why. [§11](#11-telemetry), N5.
15. **A published JSON Schema** per contract version, generated from the validator and held equal to it. As recommended. [§3.3](#33-one-library-used-three-times).
16. **A new rule, `K-OBS-19`:** "A lane notifies only through Kanon's notification contract, and an adapter runs only in a `notify` job", enforced by the guards. As recommended; N1 words it with "hook" for "adapter", since every adapter is now a hook. [§12](#12-order-of-moves), N1.

### The answers to the six questions the revision raised

The second draft asked these as "Open questions", each with a recommendation. Two answers differ from it, marked **changed**.

17. **How an adopter changes over from `DIGEST_WEBHOOK`: a clean break. Changed** (the draft recommended accepting the old secret for one release). The release notes, `kanon upgrade` and doctor's `notify.legacy-secret` say what to do, and no lane accepts the old secret, not even for one release. From N7's release an adopter's digests post nothing until it adds a hook and stores the kind secrets, and a caller that still maps `DIGEST_WEBHOOK` is refused by GitHub, so its lane does not start at all ([§5.2](#52-what-the-job-holds-and-what-it-never-holds) says what that means); GitHub won't show a secret's value, so it fetches the webhook URL from Slack again. `kanon upgrade` may still write Kanon's Slack hook for a repository whose callers map `DIGEST_WEBHOOK`, and rewrites those callers' `secrets:` in the same move as the pin, but writes no secret, and the lanes still don't declare the old one. [§5.2](#52-what-the-job-holds-and-what-it-never-holds), N7, N11.
18. **A prebuilt hook's pin follows the callers'.** As recommended: `kanon upgrade` moves it with the callers, Kanon's copy carries the release-please version marker, an adopter's Dependabot `github-actions` entry may name `/.github/actions/notify`, and doctor's `notify.hook-pin-behind` is a note, never blocking. [§7.1](#71-how-a-prebuilt-hook-is-installed-and-pinned), N10, N11.
19. **The `notify` rows' reader is a follow-up after N12,** not a step of this plan: a `notify` cell in the aggregate, posted and failed by `hook` and release, Kanon's prebuilt hooks only, behind the three-adopter floor. As recommended. [§11](#11-telemetry).
20. **No signature on the generic webhook's body in version 1;** later, if at all, as an optional input. As recommended. [§7.3](#73-the-generic-webhook-hook).
21. **The `notify` job runs to record `skipped`** whenever a hook exists, even when the producer wrote no message or the kind's secret is unset. As recommended. Its `if:` still requires an admitting gate and excludes a dry run, which posts nothing by design and so writes no row. [§5.1](#51-shape), [§8](#8-no-hook).
22. **Nothing in doctor for the branch exposure. Changed** (the draft recommended a per-App note). Decision 8's weakness is stated in this plan and the topic doc only; doctor has no check for it. [§5.3](#53-any-branchs-code-and-what-that-exposes).

### The answer to the question the review raised

23. **The clean break stands, knowing it stops the whole lane. Changed** (the draft recommended declaring `DIGEST_WEBHOOK` for one release, read by nothing and handed to no hook, so an unchanged caller would still start). The Owner's answer: keep the clean break; there is no one-release declaration of `DIGEST_WEBHOOK`. So from N7's release a caller that still maps it is refused by GitHub and its lane, health job included, doesn't start; doctor's `notify.legacy-secret` is blocking, `kanon upgrade` rewrites the callers' `secrets:` in the same edit as the pin move, and the release note marks the change as breaking. [§5.2](#52-what-the-job-holds-and-what-it-never-holds), N7, N10, N11.

## Open questions

None open.
