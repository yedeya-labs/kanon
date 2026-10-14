# Notifications

Kanon's lanes tell people things in chat: the daily project digest, the weekly digest, and a deploy's announcement. **Kanon owns what a notification is; you own where it goes.** Every notification is one message in Kanon's contract, `kanon-notify` version 1, and the lanes hand it to a hook you choose: Kanon's Slack hook, Kanon's generic JSON webhook hook, or your own, for any other system ([plan 0011](plans/0011-notifications.md)).

**What is built so far.** This page is the contract half: the message, its kinds and secrets, its limits, Kanon text, the library that builds and checks it, and the published JSON Schema ([plan 0011, step N2](plans/0011-notifications.md#12-order-of-moves)). The hook's interface, Kanon's two prebuilt hooks and the `notify` job that calls them come in the plan's later steps, and the digests still post as they do today until their release moves them. The security section below holds for the whole design, and is worth reading before you choose a hook.

## The message

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

Lengths are in characters, counted as Unicode code points, as JSON Schema counts them. Each limit is Slack's, less a margin Kanon's Slack hook spends on its own syntax.

| Field | Required | Type | Limit | What |
|---|---|---|---|---|
| `schema_version` | yes | integer | `1` | The contract's version ([Versions](#versions)) |
| `kind` | yes | closed list | — | `project-digest`, `weekly-digest` or `deploy` ([Kinds and secrets](#kinds-and-secrets)) |
| `severity` | yes | closed list | — | `info`, `warning` or `critical` |
| `title` | yes | plain text, one line | 1 to 120 | Slack's header block takes 150: a severity emoji of up to 20 before the title, and 10 in hand |
| `summary` | yes | Kanon text | 1 to 1,000 | What a person must know if they read nothing else. A notification preview, a mobile push and a screen reader each read one short string first; the producer writes it, rather than a hook guessing it from the first section |
| `sections` | no | array | 0 to 20 | Each `{heading?, body, fields?}` |
| `sections[].heading` | no | plain text, one line | 1 to 150 | Goes inside the section's text, not in a header block |
| `sections[].body` | yes | Kanon text | 1 to 2,500 | Slack's section block takes 3,000; the margin is for escaping and link syntax |
| `sections[].fields` | no | array of `{label, value}` | 0 to 10 | Slack's section block takes 10 fields of 2,000 characters |
| `sections[].fields[].label` | yes | plain text, one line | 1 to 100 | Label and value together at most 1,900 |
| `sections[].fields[].value` | yes | plain text | 1 to 1,800 | May hold line breaks |
| `links` | no | array of `{label, url}` | 0 to 9 | Slack's context block takes 10 elements: one per link, and the tenth is the run's |
| `links[].label` | yes | plain text, one line | 1 to 75 | |
| `links[].url` | yes | `https://` URL | 1 to 2,000 | Nothing but `https://`, with no space or control character |
| `source` | yes | object | — | Where it came from: a hook may show it, route by it, or ignore it |
| `source.repository` | yes | `owner/name` | — | |
| `source.lane` | yes | closed list | — | The lane that produced it: `project-digest`, `weekly-digest` or `deploy` |
| `source.run_url` | yes | `https://` URL | 1 to 2,000 | The producing run |
| **The whole message** | | | 12,000 characters, 64 KiB | Every string in the message together, and the message as UTF-8 JSON. Well under the 40,000 characters past which Slack truncates a message's text |

**A message is valid, or it isn't posted.** Nothing repairs a message on its way to a hook.

### Kanon text

`summary` and each section's `body` are **Kanon text**, a fixed subset of Markdown that every chat system renders or can strip:

- paragraphs separated by a blank line;
- one level of `- ` bullets;
- `**strong**`, `_emphasis_` and `` `code` ``;
- `[label](https://…)`, a link to an `https://` URL.

**Everything else is literal text, and is never refused.** A line that starts with `#` or `|` is a line that starts with that character; `<`, `>` and `&` are characters, which each hook escapes for its system. There are no headings, tables, images, HTML, emoji shortcodes or mentions to write, because nothing renders them. Markup that doesn't complete (an unclosed `**`, a lone `*`, a `[` with no `(https://…)` after its `]`) is literal text too.

- **A backslash makes a markup character literal:** `\*`, `\_`, `` \` ``, `\[` and `\\`. A backslash before any other character is itself literal.
- **`_` opens emphasis only at a word's start and closes only at its end,** as in CommonMark, so `snake_case_name` is never emphasis, even unescaped.
- **A span never crosses a line:** strong, emphasis, code and a link each open and close on one line. Strong may hold emphasis, code and links; emphasis may hold code and links; a link's label is plain text with escapes; code holds anything but a backtick, literally.

**Plain text** fields (`title`, `heading`, a field's label and value, a link's label) are never interpreted at all. The only thing a plain-text field can be refused for is its length, or a line break (`\n`, `\r`, U+2028 or U+2029) in a one-line field.

### Text nobody controls

An issue's title, a pull request's title, a label, a release note's line: a producer never writes them into Kanon text bare, but through **`literal(s)`**, which backslash-escapes every markup character, so `Support Array<string>` or `**urgent**` arrives as written.

A model's narrative is Kanon text by intent (it may bold a word), so it goes through **`prose(s)`**, which keeps the subset's markup and nothing else: every construct the subset defines stays, and every markup character that forms none is escaped, so a hook reading the result never has to guess. Every other character is already literal.

**So no text a producer interpolates can make a message invalid,** and `fit` only has limits to enforce.

## Kinds and secrets

| Kind | Producer | Audience | Severity | Its secret |
|---|---|---|---|---|
| `project-digest` | the daily project digest | the developer | `warning` when a project is stopped, `info` otherwise | `KANON_CHAT_PROJECT_DIGEST` |
| `weekly-digest` | the weekly digest | a stakeholder outside the day-to-day | `info` | `KANON_CHAT_WEEKLY_DIGEST` |
| `deploy` | the deploy announcement | the stakeholder | `info` when a deploy lands, `critical` when production fails | `KANON_CHAT_DEPLOY` |

**Each kind has its own secret,** named `KANON_CHAT_` and the kind in capitals. Each kind's message reaches the hook with that kind's secret and no other, so routing is by secret, not inside a hook: the developer's digest and the stakeholder's go wherever their two secrets point. If you want one webhook for everything, store the same URL in all three. A kind whose secret is unset is not posted.

**There is no `health` kind.** The project digest's health job never posts a chat message: it files and reopens issues, and the issue is the record.

**A hook must post a kind it doesn't know** as a generic message, never drop it: a new kind is an additive change ([Versions](#versions)).

## The library

[`scripts/lib/notify-contract.mjs`](../scripts/lib/notify-contract.mjs) is the contract in code. It imports nothing, as the telemetry schema doesn't, and it is used three times: by the producers, through `fit`; by the `notify` job before any hook runs, through `validate`; and by the tests.

| Export | What |
|---|---|
| `validate(message)` | `{ ok: true }`, or `{ ok: false, errors }`, each error a field path (`sections[3].body`) and a problem word: `required`, `type`, `enum`, `range`, `line-break`, `pattern`, `unknown`, and `too-long` or `too-large` for the whole message. **It never echoes a value,** because a message can hold a model's prose and a rejection reaches a log. A key that isn't shaped like a field name is reported as `(unnamed)`. It never repairs |
| `fit(draft)` | What producers call. Cuts a draft to the limits at line boundaries, with a visible `… truncated` line, or a last `… N more` field or section; folds a line break in a one-line field into a space; sets `schema_version`. Sections past the room (or the twentieth) fold into a last section that names how many sections and links were left out. A draft whose kind, severity and source are right always fits into a valid message |
| `literal(s)`, `prose(s)` | Text nobody controls, made safe for Kanon text ([above](#text-nobody-controls)) |
| `renderText(message)` | The message as **plain text**, at most 12,000 characters, for a hook that posts one string: the markup removed, the escapes resolved, a link written `label (url)`, the run's link last. Plain text, not Kanon text, so a system that renders Markdown can't turn a literal `#` into a heading |
| `SCHEMAS`, `KINDS`, `SEVERITIES`, `LIMITS`, `KIND_SECRETS` | The spec of each version, version 1's lists and limits, and each kind's secret's name |
| `jsonSchema(version)` | The JSON Schema of a version, generated from `SCHEMAS` |

## The JSON Schema

[`docs/notify/message-v1.schema.json`](notify/message-v1.schema.json) is version 1 as a JSON Schema (draft 2020-12), so you can write a hook in any language and test it against the contract offline, and a generic-webhook receiver can validate what it gets. It is generated from `SCHEMAS`, and a test holds the file equal to it and holds it to accept and refuse the same messages as `validate`.

One difference, stated in the schema itself: a JSON Schema can't sum lengths, so the two whole-message limits (12,000 characters of text across every field, 64 KiB as JSON) are in its `x-kanon-whole-message` keyword rather than in its rules. A message Kanon sends always meets them.

## Versions

As the telemetry schema's row kinds are versioned:

- **Within a version, changes are additive only:** a new optional field, or a new kind. A hook must ignore a field it doesn't know, and post a kind it doesn't know.
- **Anything else is a new version:** a field removed, renamed or retyped, a limit tightened. Kanon then hands a hook both versions for at least one stable release, and the hook reads the one it declares.
- **Kanon's prebuilt hooks declare the versions their release writes,** so a repository on them moves with its pin.

## Security

The hook runs with one kind's chat secret, so where its code comes from matters. Plan 0011's [§5.3](plans/0011-notifications.md#53-any-branchs-code-and-what-that-exposes) states the weakness the design accepts; it is here word for word. The doctor checks it names (`notify.hook-unreviewed`) come with plan 0011's doctor step.

**The hook runs on the run's commit, whatever branch it is on** (decision 8): a `schedule` runs the default branch's hook, and a dispatch on another branch runs that branch's. The Owner chose this over a default-branch-only rule after being told the risk, and Kanon adds no restriction. **The weakness, plainly:**
- **Anyone who can push a branch and dispatch the lane can read the kind's chat secret.** They change `.github/actions/notify/action.yml` on their branch to print or send the secret, dispatch the notifying lane on that branch, and the hook runs with it. Nothing reviews the branch first: escalation (`K-MERGE-4`) guards what merges to the default branch, not what runs on another.
- **That includes an agent.** An App that can push a branch and dispatch a workflow (`contents: write` and `actions: write`) can do it without GitHub's `workflows` permission, because the hook is not under `.github/workflows/`. An agent steered by text it read could do the same.
- **What it is not:** a fork's pull request can't, since no notifying lane has a `pull_request` trigger and the guard holds that ([§5.2](plans/0011-notifications.md#52-what-the-job-holds-and-what-it-never-holds)); and the exposure is the chat secrets alone, never an App key or the Claude credential, which the `notify` job never holds. A person with write access can already push a workflow that reads repository secrets; what this adds is that an App without the `workflows` permission can reach the chat secrets too.
- **What it costs:** a leaked webhook lets its holder post to that channel as Kanon. Slack revokes a webhook it finds leaked ([§13](plans/0011-notifications.md#13-what-slacks-documentation-says)); the adopter replaces it and stores the new URL.

**What still protects the default branch's runs.** A scheduled run executes the default branch's hook with the secret, and the Merger may merge an agent's change. Every file under `.github/` escalates (`K-MERGE-4`), so a change to the hook's `action.yml` always reaches a human first. **That covers only what escalates.** A script the hook runs from elsewhere in the repository (`scripts/post-to-teams.mjs`), a local action outside `.github/`, or a package the hook installs, is not on an escalation path unless the adopter declares it under `## Pipeline code` in `docs/qa/escalation-paths.md` (`K-MERGE-4`, `K-LAYOUT-8`). So **every repository path the hook runs must escalate** ([§6.2](plans/0011-notifications.md#62-how-a-hook-declares-and-pins-its-contract), item 2), and doctor checks the paths it can see (`notify.hook-unreviewed`). **What doctor can't see,** and so remains: a path a script builds at run time, a file a reviewed script imports from outside `.github/` and the declared pipeline code, and a hook that `curl`s code and runs it. `notify.hook-unreviewed` reads what the hook names; what the hook's code then does is the adopter's review's to catch.

Doctor has no check for the branch exposure itself (decision 22): it is stated in the plan and on this page only.
