# Notifications

Kanon's lanes tell people things in chat: the daily project digest, the weekly digest, and a deploy's announcement. **Kanon owns what a notification is; you own where it goes.** Every notification is one message in Kanon's contract, `kanon-notify` version 1, and the lanes hand it to a hook you choose: Kanon's Slack hook, Kanon's generic JSON webhook hook, or your own, for any other system ([plan 0011](plans/0011-notifications.md)).

**What is built so far.** The contract: the message, its kinds and secrets, its limits, Kanon text, the library that builds and checks it, and the published JSON Schema ([plan 0011, step N2](plans/0011-notifications.md#12-order-of-moves)). And Kanon's two prebuilt hooks, [Slack](#kanons-slack-hook) (step N3) and the [generic webhook](#kanons-generic-webhook-hook) (step N4), which nothing calls yet. The [deploy announcement](#the-deploy-announcement) is a producer of `deploy` messages (step N9), which no lane runs yet. The `notify` job that calls a hook, and `kanon init`'s question come in the plan's later steps, and the digests still post as they do today until their release moves them. The security section below holds for the whole design, and is worth reading before you choose a hook.

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
| `links[].url` | yes | `https://` URL | 1 to 2,000 | Nothing but `https://`, with no whitespace, C0 control character or DEL ([The JSON Schema](#the-json-schema)) |
| `source` | yes | object | — | Where it came from: a hook may show it, route by it, or ignore it |
| `source.repository` | yes | `owner/name` | 1 to 140 | As GitHub spells them: an owner of 1 to 39 letters, digits and `-`, not starting with `-`; a name of 1 to 100 letters, digits, `.`, `_` and `-` |
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

**So no character a producer interpolates can make a message invalid,** and `fit` only has limits to enforce, given [its precondition](#the-library).

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

[`scripts/lib/notify-contract.mjs`](../scripts/lib/notify-contract.mjs) is the contract in code. It imports nothing, and it is used four times: by the producers, through `fit`; by the `notify` job before any hook runs, through `validate`; by [Kanon's Slack hook](#kanons-slack-hook), through `parseInline` and `linesOf`, to render Kanon text; and by the tests.

| Export | What |
|---|---|
| `validate(message)` | `{ ok: true }`, or `{ ok: false, errors }`, each error a field path (`sections[3].body`) and a problem word: `required`, `type`, `enum`, `range`, `line-break`, `pattern`, `unknown`, and `too-long` or `too-large` for the whole message. **It never echoes a value,** because a message can hold a model's prose and a rejection reaches a log. A key that isn't shaped like a field name is reported as `(unnamed)`. It never repairs |
| `fit(draft)` | What producers call. Cuts a draft to the limits at line boundaries, with a visible `… truncated` line, or a last `… N more` field or section; folds a line break in a one-line field into a space; sets `schema_version`. Sections past the room (or the twentieth) fold into a last section that names how many sections and links were left out. **Its precondition:** kind, severity and source right; every required string (`title`, `summary`, each section's `body`, each field's `label` and `value`, each link's `label`) present and non-empty; and each link's `url` an `https://` URL that `links[].url` accepts. A draft that meets it always fits into a valid message. One that doesn't is a producer's bug, which `fit` doesn't repair and `validate` reports |
| `literal(s)`, `prose(s)` | Text nobody controls, made safe for Kanon text ([above](#text-nobody-controls)) |
| `renderText(message)` | The message as **plain text**, at most 12,000 characters, for a hook that posts one string: the markup removed, the escapes resolved, a link written `label (url)`, the run's link last. Plain text, not Kanon text, so a system that renders Markdown can't turn a literal `#` into a heading |
| `SCHEMAS`, `KINDS`, `SEVERITIES`, `LIMITS`, `KIND_SECRETS` | The spec of each version, version 1's lists and limits, and each kind's secret's name |
| `jsonSchema(version)` | The JSON Schema of a version, generated from `SCHEMAS` |
| `parseInline(line)`, `linesOf(text)` | Kanon text parsed, one line at a time, into text, code, strong, emphasis and link nodes, with every escape resolved: for a hook that renders Kanon text into its own system's markup, as Kanon's Slack hook does, so the subset is parsed in one place |

## The deploy announcement

[`scripts/announce-deploy.mjs`](../scripts/announce-deploy.mjs) produces the `deploy` message (`K-SHIP-10`, [plan 0011, step N9](plans/0011-notifications.md#12-order-of-moves)). Every non-draft release newer than the repository variable `ANNOUNCED_<STAGE>_VERSION`, up to and including the deployed version, becomes **one** message: a title and summary naming the release or the range and the environment, then Features, Fixes and Maintenance sections built from the release notes, and a link to the notes. A first run, with the variable unset, announces the deployed version's release alone, never the whole history. Each release-note line is text nobody controls, so it goes through `literal`; a pull request's link is kept only when it is `https://`.

**Two modes, in two jobs, so a deploy is announced once.**

- **Produce** (no flag) builds the message with `fit`, checks it with `validate`, writes one `message.json` (`MESSAGE_PATH`) and names it in the step's output `message` (empty when there is nothing new to announce). It posts nothing, moves nothing, and never reads a chat secret: the lane's `notify` job posts it with the kind's secret, **`KANON_CHAT_DEPLOY`**. On a dry run (`DRY_RUN`) it writes no file, and prints the message, its plain-text rendering and Kanon's Slack hook's payload, to the log and the step summary.
- **`--advance`** moves `ANNOUNCED_<STAGE>_VERSION` to the deployed version, in a job after `notify`. **It refuses unless `NOTIFY_RESULT` is `success`** (the lane passes `needs.notify.result`), so a post that failed leaves the variable where it was, and the next deploy announces those releases again. It never moves the variable back.

Either mode makes requests to GitHub's API and nowhere else. It reads `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `STAGE` (the environment, as your project names it; it must make a valid variable name) and `VERSION` (the deployed version, a leading `v` allowed); produce also reads `SHA` (optional, shown as the build), `GITHUB_SERVER_URL` and `GITHUB_RUN_ID` (the message's run link). Try it locally:

```sh
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> \
  STAGE=<your environment> VERSION=0.1.6 DRY_RUN=1 node scripts/announce-deploy.mjs
```

**`SLACK_RELEASE_WEBHOOK` is gone.** The script used to post to Slack itself, on that secret; it no longer reads it, and nothing else does. Store the webhook in `KANON_CHAT_DEPLOY` instead, for the `notify` job. Running it in plan 0010's deploy lane, as that lane's `announce`, `notify` and advance jobs, is [a later step of that plan](plans/0010-deployment-lane.md); until then no Kanon workflow runs it.

## The JSON Schema

[`docs/notify/message-v1.schema.json`](notify/message-v1.schema.json) is version 1 as a JSON Schema (draft 2020-12), so you can write a hook in any language and test it against the contract offline, and a generic-webhook receiver can validate what it gets. It is generated from `SCHEMAS`, and a test holds the file equal to it and holds it to accept and refuse the same messages as `validate`.

**Its patterns are ECMA-262's,** as JSON Schema defines them. They name each character they refuse rather than using `\s`, whose set differs between engines: a URL refuses U+0000 to U+0020, U+007F, and every other character ECMA-262's `\s` matches. One difference no pattern removes: some engines' `$`, Python's for one, also matches before a final `\n`, so a validator there accepts a one-line field or a URL that ends in a line break, which `validate` refuses.

One difference, stated in the schema itself: a JSON Schema can't sum lengths, so the two whole-message limits (12,000 characters of text across every field, 64 KiB as JSON) are in its `x-kanon-whole-message` keyword rather than in its rules. A message Kanon sends always meets them.

## Versions

As the telemetry schema's row kinds are versioned:

- **Within a version, changes are additive only:** a new optional field, or a new kind. A hook must ignore a field it doesn't know, and post a kind it doesn't know.
- **Anything else is a new version:** a field removed, renamed or retyped, a limit tightened. Kanon then hands a hook both versions for at least one stable release, and the hook reads the one it declares.
- **Kanon's prebuilt hooks declare the versions their release writes,** so a repository on them moves with its pin.

## Kanon's Slack hook

Kanon ships a hook for Slack ([plan 0011 §7.2](plans/0011-notifications.md#72-the-slack-hook)). It is an ordinary hook: the lanes call it exactly as they would call your own, and choosing it means having it at the hook's path.

**Two files.** The action, [`actions/notify/slack/action.yml`](../actions/notify/slack/action.yml) with [`slack.mjs`](../actions/notify/slack/slack.mjs), is the code, at a Kanon release; it reads the hook's four inputs (`message-v1`, `text`, `kind`, `secret`) and nothing else. The hook file, [`actions/notify/hooks/slack.yml`](../actions/notify/hooks/slack.yml), is what `kanon init` will write to `.github/actions/notify/action.yml`: a composite action whose one step is `yedeya-labs/kanon/actions/notify/slack` at the release `init` ran from, with the four inputs passed through. A release moves that pin in Kanon's copy, and `kanon upgrade` will move yours with your callers'. Change the step and it is your own hook.

**One webhook, the one it is given.** `secret` is one Slack incoming-webhook URL, and the hook posts there and nowhere else: create an incoming webhook for the channel ([Slack's guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)) and store its URL in the kind's secret. There is no routing inside a secret: each kind reaches its own channel because its own secret holds that channel's webhook, and the same URL in all three puts everything in one channel. **Anything but `https://hooks.slack.com/services/…` is refused,** naming the input and never echoing its value: another URL means another system, which is the generic webhook hook's job or your own hook's.

**What Slack gets.** One `POST` of `application/json` with `text` and `blocks`. The payload sets no channel, name or icon, which an incoming webhook can't change. A redirect is not followed.

| From | Block |
|---|---|
| `severity` and `title` | a `header`, `plain_text`: `:large_blue_circle:`, `:warning:` or `:rotating_light:` for `info`, `warning` or `critical` (an unknown severity reads as `info`), a space, then the title; cut at Slack's 150 characters with `…` |
| `summary` | a `section`, `mrkdwn` |
| each section | a `divider`, then a `section` whose text is the heading in bold and the body, with `fields` as the section's fields (each `*label*` and its value, at most 2,000 characters). A text past Slack's 3,000 characters after escaping splits into further sections, at a line boundary where a line fits |
| `links` and `source.run_url` | one `context` block: one element per link, and the run's own last, at most 9 and 1, Slack's 10 |

At most 50 blocks, Slack's limit: past it, the fiftieth block is a `context` saying the message was cut, with the run's link. A message within the contract reaches that only when escaping more than doubles its bodies. **Links are text, not buttons,** because a button needs a request URL that a webhook-only Slack app doesn't have. A kind the hook doesn't know is posted the same way, never dropped.

**Kanon text to `mrkdwn`.** `**strong**` becomes `*strong*`, `_emphasis_` and `` `code` `` stay, `[label](url)` becomes `<url|label>`, and a `- ` bullet becomes `•`. **Every `&`, `<` and `>` is escaped** (`&amp;`, `&lt;`, `&gt;`, Slack's three control characters) in every field that goes into `mrkdwn`, so no text, an issue title or a model's narrative, can form `<!channel>`, `<!here>` or a mention. Slack documents no escape for its formatting characters, so a literal `*`, `_`, `` ` `` or `~` gets a zero-width space on each side, which keeps Slack from pairing it: `snake_case_name` and an issue titled `**urgent**` arrive as written. The header is `plain_text`, which Slack never parses, so the title there is not escaped.

**The `text` fallback.** Slack shows the top-level `text` in notifications, mobile pushes and to screen readers first. It is the whole message in `mrkdwn` (a `Warning:` or `Critical:` lead in words, the title in bold, the summary, the sections, then the links) when that fits Slack's recommended 4,000 characters, and otherwise the title, the summary and the run's link, which the blocks complete.

**Errors.** A non-2xx answer fails the step with its status and Slack's error string (`invalid_payload`, `no_text`, `channel_is_archived`, `invalid_token`, `action_prohibited`), never the URL; any other answer body is not printed. A `429` is retried once, after its `Retry-After`, when that is at most 60 seconds (one second when Slack sends none); a second `429` fails.

**What isn't confirmed yet:** how a header with an emoji renders on Slack's mobile client, and whether the zero-width spaces keep Slack from formatting on desktop and mobile alike. Plan 0011's live step checks both in a test workspace.

## Kanon's generic webhook hook

Kanon ships a second hook, for any system that can take a JSON body at a URL: a receiver of your own, a workflow tool, or a relay to another chat system ([plan 0011 §7.3](plans/0011-notifications.md#73-the-generic-webhook-hook)). Like the Slack hook, it is an ordinary hook, and choosing it means having it at the hook's path.

**Two files.** The action, [`actions/notify/webhook/action.yml`](../actions/notify/webhook/action.yml) with [`webhook.mjs`](../actions/notify/webhook/webhook.mjs), reads the hook's four inputs and nothing else. The hook file, [`actions/notify/hooks/webhook.yml`](../actions/notify/hooks/webhook.yml), is what `kanon init` will write to `.github/actions/notify/action.yml`: a composite action whose one step is `yedeya-labs/kanon/actions/notify/webhook` at the release `init` ran from, with the four inputs passed through. Its pin moves as the Slack hook's does, and changing the step makes it your own hook.

**What the receiver gets.** One `POST` to the URL in the kind's secret. **The body is the message itself,** byte for byte the validated `message-v1` file: the kind, the severity, the title, the summary, the sections in Kanon text, the links and the source, as [the message](#the-message) describes them. Validate it against [`docs/notify/message-v1.schema.json`](notify/message-v1.schema.json) if you like. Nothing is rendered or escaped: Kanon text arrives as Kanon text, and the plain-text rendering is not sent, since the receiver can compute what it needs. The headers are `Content-Type: application/json` and `User-Agent: kanon-notify/1`, and nothing else identifies your repository beyond the message's own `source`. A kind the hook doesn't know, or a field it doesn't know, is posted as it is.

**One URL, the one it is given.** `secret` must be one `https://` URL of at most 2,000 characters. Anything else (`http://`, another scheme, a JSON map of URLs, two URLs) is refused, naming the input and never echoing its value. Routing is by the kind's secret, as with Slack: store one URL in each kind's secret, the same URL in all three if one receiver takes everything.

**No signature.** The body is not signed in this version: the URL is the secret, as a Slack webhook's is, so keep it unguessable and treat it as a credential (plan 0011, decision 20). Signing may come later as an optional input.

**Errors.** A non-2xx answer fails the step with its HTTP status alone: never the URL, and never the response body, which a receiver Kanon knows nothing about could fill with anything. **A redirect is not followed,** and fails, so the URL and the message are never re-sent to a host the secret doesn't name. A `429` is retried once, after its `Retry-After`, when that is at most 60 seconds (one second when there is none); a second `429` fails.

## Security

The hook runs with one kind's chat secret, so where its code comes from matters. Plan 0011's [§5.3](plans/0011-notifications.md#53-any-branchs-code-and-what-that-exposes) states the weakness the design accepts; it is here word for word. The doctor checks it names (`notify.hook-unreviewed`) come with plan 0011's doctor step.

**The hook runs on the run's commit, whatever branch it is on** (decision 8): a `schedule` runs the default branch's hook, and a dispatch on another branch runs that branch's. The Owner chose this over a default-branch-only rule after being told the risk, and Kanon adds no restriction. **The weakness, plainly:**
- **Anyone who can push a branch and dispatch the lane can read the kind's chat secret.** They change `.github/actions/notify/action.yml` on their branch to print or send the secret, dispatch the notifying lane on that branch, and the hook runs with it. Nothing reviews the branch first: escalation (`K-MERGE-4`) guards what merges to the default branch, not what runs on another.
- **That includes an agent.** An App that can push a branch and dispatch a workflow (`contents: write` and `actions: write`) can do it without GitHub's `workflows` permission, because the hook is not under `.github/workflows/`. An agent steered by text it read could do the same.
- **What it is not:** a fork's pull request can't, since no notifying lane has a `pull_request` trigger and the guard holds that ([§5.2](plans/0011-notifications.md#52-what-the-job-holds-and-what-it-never-holds)); and the exposure is the chat secrets alone, never an App key or the Claude credential, which the `notify` job never holds. A person with write access can already push a workflow that reads repository secrets; what this adds is that an App without the `workflows` permission can reach the chat secrets too.
- **What it costs:** a leaked webhook lets its holder post to that channel as Kanon. Slack revokes a webhook it finds leaked ([§13](plans/0011-notifications.md#13-what-slacks-documentation-says)); the adopter replaces it and stores the new URL.

**What still protects the default branch's runs.** A scheduled run executes the default branch's hook with the secret, and the Merger may merge an agent's change. Every file under `.github/` escalates (`K-MERGE-4`), so a change to the hook's `action.yml` always reaches a human first. **That covers only what escalates.** A script the hook runs from elsewhere in the repository (`scripts/post-to-teams.mjs`), a local action outside `.github/`, or a package the hook installs, is not on an escalation path unless the adopter declares it under `## Pipeline code` in `docs/qa/escalation-paths.md` (`K-MERGE-4`, `K-LAYOUT-8`). So **every repository path the hook runs must escalate** ([§6.2](plans/0011-notifications.md#62-how-a-hook-declares-and-pins-its-contract), item 2), and doctor checks the paths it can see (`notify.hook-unreviewed`). **What doctor can't see,** and so remains: a path a script builds at run time, a file a reviewed script imports from outside `.github/` and the declared pipeline code, and a hook that `curl`s code and runs it. `notify.hook-unreviewed` reads what the hook names; what the hook's code then does is the adopter's review's to catch.

Doctor has no check for the branch exposure itself (decision 22): it is stated in the plan and on this page only.
