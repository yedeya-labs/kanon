# Notifications

Kanon's lanes tell people things in chat: the daily project digest, the weekly digest, a deploy's announcement, and a published release's. **Kanon owns what a notification is; you own where it goes.** Every notification is one message in Kanon's contract, `kanon-notify` version 1, and the lanes hand it to a hook you choose: Kanon's Slack hook, Kanon's generic JSON webhook hook, or your own, for any other system ([plan 0011](plans/0011-notifications.md)).

**What is built so far.** The contract: the message, its kinds and secrets, its limits, Kanon text, the library that builds and checks it, and the published JSON Schema ([plan 0011, step N2](plans/0011-notifications.md#12-order-of-moves)). And Kanon's two prebuilt hooks, [Slack](#kanons-slack-hook) (step N3) and the [generic webhook](#kanons-generic-webhook-hook) (step N4), which `kanon init` writes at the hook's path when you choose one. The [deploy announcement](#the-deploy-announcement) is a producer of `deploy` messages (step N9), which the deploy lane runs once per environment, its `notify` job posting with `KANON_CHAT_DEPLOY`. The [release announcement](#the-release-announcement) is a lane of its own that produces `release` messages, one per published release, posting with `KANON_CHAT_RELEASE` ([kanon#1190](https://github.com/yedeya-labs/kanon/issues/1190)). And [the `notify` block](#the-notify-job) that calls a hook in a lane's `notify` job, with its guards (step N6). **The daily project digest posts through it** (step N7): its `digest` job writes one `project-digest` message and its `notify` job hands it to your hook with `KANON_CHAT_PROJECT_DIGEST`; with no hook or no secret it skips the digest and its model, and runs its health job alone, which never posts. Its lane no longer takes `DIGEST_WEBHOOK`, so a caller that still maps it doesn't start until the line goes ([the lanes' digests section](lanes.md#the-digests)). **So does the weekly digest** (step N8, [below](#the-weekly-digest)), with `KANON_CHAT_WEEKLY_DIGEST`; both moves ship in one release, and no lane posts through `DIGEST_WEBHOOK` any more. **`kanon init` asks which hook posts them** (step N11), only when the lanes you choose post to a chat channel or you declare a deploy environment, and not when a hook at `.github/actions/notify/action.yml` already answers it: Kanon's Slack hook, Kanon's generic webhook hook, a stub of your own that fails until you fill it, or none, with one person step per kind's secret ([`docs/init.md`, "The chat channel"](init.md#the-chat-channel)). The security section below holds for the whole design, and is worth reading before you choose a hook.

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
| `kind` | yes | closed list | — | `project-digest`, `weekly-digest`, `deploy` or `release` ([Kinds and secrets](#kinds-and-secrets)) |
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
| `source.lane` | yes | closed list | — | The lane that produced it: `project-digest`, `weekly-digest`, `deploy` or `release-announce` (the `release` kind's lane, named for what it does) |
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
| `deploy` | the deploy announcement | the stakeholder | `info` when a deploy lands, `critical` when production fails or a release live on production fails its smoke check | `KANON_CHAT_DEPLOY` |
| `release` | the release announcement | whoever follows the releases | `info`, a stable release and a pre-release alike | `KANON_CHAT_RELEASE` |

**Each kind has its own secret,** named `KANON_CHAT_` and the kind in capitals. Each kind's message reaches the hook with that kind's secret and no other, so routing is by secret, not inside a hook: the developer's digest and the stakeholder's go wherever their two secrets point. If you want one webhook for everything, store the same URL in all of them. A kind whose secret is unset is not posted.

**There is no `health` kind.** The project digest's health job never posts a chat message: it files and reopens issues, and the issue is the record.

**A hook must post a kind it doesn't know** as a generic message, never drop it: a new kind is an additive change ([Versions](#versions)).

## The library

[`scripts/lib/notify-contract.mjs`](../scripts/lib/notify-contract.mjs) is the contract in code. It imports nothing, and it is used four times: by the producers, through `fit`; by the `notify` job before any hook runs, through `validate`; by [Kanon's Slack hook](#kanons-slack-hook), through `parseInline` and `linesOf`, to render Kanon text; and by the tests. [Kanon's generic webhook hook](#kanons-generic-webhook-hook) doesn't use it (it loads it only indirectly, through `retryAfter` from the Slack hook's `slack.mjs`): it posts the message the `notify` job already validated, byte for byte.

| Export | What |
|---|---|
| `validate(message)` | `{ ok: true }`, or `{ ok: false, errors }`, each error a field path (`sections[3].body`) and a problem word: `required`, `type`, `enum`, `range`, `line-break`, `pattern`, `unknown`, and `too-long` or `too-large` for the whole message. **It never echoes a value,** because a message can hold a model's prose and a rejection reaches a log. A key that isn't shaped like a field name is reported as `(unnamed)`. It never repairs |
| `fit(draft)` | What producers call. Cuts a draft to the limits at line boundaries, with a visible `… truncated` line, or a last `… N more` field or section; folds a line break in a one-line field into a space; sets `schema_version`. Sections past the room (or the twentieth) fold into a last section that names how many sections and links were left out. **Its precondition:** kind, severity and source right; every required string (`title`, `summary`, each section's `body`, each field's `label` and `value`, each link's `label`) present and non-empty; and each link's `url` an `https://` URL that `links[].url` accepts. A draft that meets it always fits into a valid message. One that doesn't is a producer's bug, which `fit` doesn't repair and `validate` reports |
| `literal(s)`, `prose(s)` | Text nobody controls, made safe for Kanon text ([above](#text-nobody-controls)) |
| `renderText(message)` | The message as **plain text**, at most 12,000 characters, for a hook that posts one string: the markup removed, the escapes resolved, a link written `label (url)`, the run's link last. Plain text, not Kanon text, so a system that renders Markdown can't turn a literal `#` into a heading |
| `SCHEMAS`, `KINDS`, `SEVERITIES`, `LIMITS`, `KIND_SECRETS` | The spec of each version, version 1's lists and limits, and each kind's secret's name |
| `jsonSchema(version)` | The JSON Schema of a version, generated from `SCHEMAS` |
| `parseInline(line)`, `linesOf(text)` | Kanon text parsed, one line at a time, into text, code, strong, emphasis and link nodes, with every escape resolved: for a hook that renders Kanon text into its own system's markup, as Kanon's Slack hook does, so the subset is parsed in one place |

## The `notify` job

Every notifying lane hands its message to one job, `notify`, after the job that produces it. Only there does a hook run ([plan 0011 §5](plans/0011-notifications.md#5-the-notify-job-where-a-hook-runs), `K-OBS-19`). The job runs Kanon's block, [`actions/notify`](../actions/notify/action.yml):

```yaml
  notify:
    needs: [gate, digest]
    if: ${{ !cancelled() && needs.gate.outputs.member == 'true' && needs.gate.outputs.hook == 'present' && inputs.dry_run != 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    outputs:
      outcome: ${{ steps.notify.outputs.outcome }}
    steps:
      - uses: $/actions/notify
        id: notify
        with:
          kind: project-digest
          artifact: ${{ needs.digest.outputs.message-artifact }}
          secret: ${{ secrets.KANON_CHAT_PROJECT_DIGEST }}
```

**When it runs.** Only past an admitting gate, only when the repository has a hook at the run's commit, never on a dry run, and never on a cancelled run. It does run after a failed or skipped producer, so a message that was never posted is still recorded, as `skipped`.

**The deploy lane's `notify` job** differs in its gate, and in that it continues on error ([below](#the-deploy-announcement)): `deploy.yml` has no membership gate and no dry run, so its job needs `declare` and `announce`, starts on `${{ !cancelled() && needs.declare.outputs.held == 'false' && needs.announce.outputs.hook == 'present' }}` (`declare` sets `held` to `false` only for a published release, or a dispatch naming one, so never on a pull request), and also hands the block `position: ${{ inputs.position }}`, which keeps its row's artifact apart from the other environments' in the same run. It has `continue-on-error: true`, so a failed post never fails its environment's call ([kanon#1048](https://github.com/yedeya-labs/kanon/issues/1048)).

**What it holds.** Its kind's secret and no other, handed to the block as one input; a workflow token that reads contents and nothing else; no App key or token, no Claude credential, no OIDC grant, and no job-level `env:`. It is in no workflow a pull request can start.

**What the block does, in order.**
1. **Masks** the secret, each of its lines when it holds several, before anything prints.
2. **Checks out the run's commit,** whatever branch it is on, keeping no credential, and reads the hook at `.github/actions/notify/action.yml`: its kind for telemetry (`slack` or `webhook` when its one step is Kanon's prebuilt action of that name, `custom` otherwise) and the contract versions it declares.
3. **Skips, calling no hook,** when `secret` is empty (`no-secret`), and otherwise when `artifact` is empty (`no-message`). The secret is checked first: with no secret the gate also skipped the producer, so the artifact is empty too, and `no-secret` is the reason worth recording.
4. **Downloads** the producer's one `message.json`, by the name the producer published, never one the block builds: after "Re-run failed jobs" the job's own attempt is one past the producer's.
5. **Validates** it with `validate`, checks its kind is the job's, and checks the hook declares a version this release writes (`message-v1`). An invalid message, or a hook declaring only another version, calls no hook, and fails the job by field name, never by value.
6. **Calls the hook** with its four inputs: `message-v1` (the message's path), `text` (`renderText`'s plain text's path), `kind` and `secret`.
7. **Records the outcome,** on every outcome: one line for `kanon doctor`, `kanon-notify/v1 {"hook":"slack","kind":"project-digest","outcome":"posted"}`, and one `notify` telemetry row, uploaded as `kanon-delivery-<lane>-<run id>-<attempt>`, with `-<position>` after it in the deploy lane ([`docs/telemetry.md`](telemetry.md)). Neither holds a URL, a channel, the message's text or the secret. A `deploy` message's row is in the `deploy-announce` lane, since `deploy` is the deploy rows' own partition. A `release` message's row is in the `release-announce` lane, the lane that produced it.
8. **Fails the job** unless the message was posted or skipped. The producing job stays green: a failed post is reported as a failed post (`K-SHIP-10`). A re-run of the failed `notify` job posts the same message again, in a digest's or the release announcement's run; never re-run a deploy run for it ([below](#the-deploy-announcement)).

**The outcome is an output.** The block's `outcome` output, which the job publishes, is `posted`, `failed` or `skipped`; the row and the run's summary say why. **A green `notify` job does not mean posted:** a skip is green. So a step or job that must act only on a post reads `needs.notify.outputs.outcome == 'posted'`, never `needs.notify.result == 'success'` ([kanon#972](https://github.com/yedeya-labs/kanon/issues/972)). No Kanon job acts on a post today, and `notify-guard.test.ts` fails any job that reads a `notify` job's result.

**What holds it.** `tests/unit/helpers/notify-jobs.ts` holds every `notify` job to the shape above, and `tests/unit/notify-guard.test.ts` holds each `KANON_CHAT_*` secret to its own lane's `notify` job and that lane's gate, keeps `notify` jobs out of workflows a pull request starts, fails a script under `scripts/` that fetches a host other than GitHub's or reads a chat secret, and a producer that writes Slack's syntax, and fails a job that reads a `notify` job's result. `tests/library/notify-block.test.ts` runs the block's steps against a fixture hook and Kanon's two prebuilt hooks.

## The deploy announcement

[`scripts/announce-deploy.mjs`](../scripts/announce-deploy.mjs) produces the `deploy` message (`K-SHIP-10`, [plan 0011, step N9](plans/0011-notifications.md#12-order-of-moves)), and the deploy lane runs it: **each environment announces its own deploy**, in `deploy.yml`'s `announce` job, after `record` and `report` ([`docs/lanes.md`](lanes.md#the-deploy-lane); the Owner's decisions of 2026-10-15). What it writes depends on the environment's outcome, as `record` wrote it (`OUTCOME`):

- **A deploy that landed** (`ok`), `info`: every non-draft release newer than the release of the environment's **previous successful GitHub deployment**, up to and including the deployed one, becomes **one** message: a title and summary naming the release or the range and the environment, then Features, Fixes and Maintenance sections built from the release notes, and a link to the notes. The previous deployment is read from the Deployments API with the workflow token (`deployments: read`); this run's own deployment, whose status links this run, is passed over. Its release is the tag its ref names, or, for a dispatch, a release tag on its commit. With no earlier successful deployment, or one whose release can't be told, it announces the deployed release alone, never the whole history; a redeploy of the same release announces nothing; a rollback, or a pre-release (by its tag, or as GitHub marks the release), announces the deployed release alone. **Under the `no-environments` fallback** no job sets an environment, so GitHub records no deployment: `announce` reads none, and each deploy announces its own release alone, a redeploy announces it again, and on a production the Maintainer dispatches after several releases, the ones between are not announced there ([plan 0010 §13](plans/0010-deployment-lane.md#13-the-fallback-where-the-plan-has-no-environments), [kanon#1038](https://github.com/yedeya-labs/kanon/issues/1038)). **A tag may carry a line prefix,** as release-please's `include-component-in-tag` writes (`widgets-v1.2.3`): the range holds only releases of the deployed tag's line, a previous deployment of another line never starts it, and the title and the notes link keep the tag whole ([kanon#1039](https://github.com/yedeya-labs/kanon/issues/1039)). A tag with no `X.Y.Z` version in it fails the `announce` job by name, and the deploy stays green. Each release-note line is text nobody controls, so it goes through `literal`; a pull request's link is kept only when it is `https://`.
- **A deploy that landed and failed its smoke check** (`smoke_failed`), **`critical` on production and `warning` on any other environment** ([plan 0013 §7.2](plans/0013-smoke-lifecycle.md#72-what-each-job-says)): the release is live, so this is the landed message, flagged, never a failure's. The same range and the same Features, Fixes and Maintenance sections an `ok` deploy gets, so nobody misses what went live; the title "`<version>` is live on `<environment>`, and its smoke check failed" (for a range, "… are live on `<environment>`, and the smoke check failed"); a first section, `Smoke check`, with the field "Smoke check: failed at `<stage>`", `reset` when your reset hook failed and the smoke check didn't run, else `smoke`; and links to the run, to the issue `Smoke check on <environment> failed` when `report` filed or commented on it, and to the notes. It is never skipped: a redeploy of the same release, which an `ok` deploy doesn't announce, names the deployed release alone.
- **A deploy that failed** (`failed`), **`critical` on production and `warning` on any other environment** ([plan 0011 §3.2](plans/0011-notifications.md#32-kinds-and-severities)): the release, the environment, the stage that failed, a link to the run, and a link to the environment's issue when `report` filed or commented on one. It reads "failed to deploy", which a smoke-failed deploy never does.
- **Anything else** (a refusal, a rejection, a cancellation, or no row) announces nothing: a refusal is on the environment's issue, and a rejection or a cancellation is a person's choice. A held production runs no `announce` at all.

It builds the message with `fit`, checks it with `validate`, writes one `message.json` (`MESSAGE_PATH`) and names it in the step's output `message` (empty when there is nothing to announce). It posts nothing and never reads a chat secret: the lane's `notify` job posts it with the kind's secret, **`KANON_CHAT_DEPLOY`**, an optional secret of `deploy.yml` that your deploy caller maps into each environment's call. `kanon init` writes that mapping into every `deploy-<position>` job whatever its chat answer, and, with a hook, leaves the step `secret.chat-deploy` to store it ([`docs/init.md`](init.md#the-chat-channel)); `kanon doctor` reads the deploy caller as it reads the digests' callers, so a missing `KANON_CHAT_DEPLOY`, or a job that doesn't map it, is the note `notify.kind-unset`. **Nothing records what was announced,** and nothing moves after a post: the environment's deployments are the record. **A post that fails** turns `notify` red and leaves its environment's call green, since the job continues on error: the next environment deploys as it would have, and `kanon doctor` reports `notify.failing` ([kanon#1048](https://github.com/yedeya-labs/kanon/issues/1048)). **Don't re-run the deploy run to post it.** A re-run of the failed `notify` job, by job (`gh run rerun --job`) or with the failed jobs (`--failed`, which a run that concluded green still accepts), re-runs every job after it, so the next environment's deploy runs again; a sandbox run measured both. Nothing posts the message again. When the deploy landed, a smoke-failed one included, GitHub marked its deployment `success`, so the next deploy to that environment starts its range there and doesn't name these releases. When the deploy failed, its release is still in the range of the environment's next deploy that lands, but the failure itself is not announced again. Under the `no-environments` fallback each deploy announces its own release alone. So post it by hand if it can't go unannounced; a command that posts a deploy's announcement again without re-running the deploy is [kanon#1200](https://github.com/yedeya-labs/kanon/issues/1200). On a dry run (`DRY_RUN`) it writes no file, and prints the message, its plain-text rendering and Kanon's Slack hook's payload, to the log and the step summary.

It makes requests to GitHub's API and nowhere else, and only reads. It reads `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `STAGE` (the environment, as your project names it), `VERSION` (the deployed release's tag), `FALLBACK` (the declaration's fallback marker), `OUTCOME`, `ROLE` (`production` or `pre-production`), `FAILED_STAGE`, `ISSUE`, `SHA` (optional, shown as the build), `GITHUB_SERVER_URL` and `GITHUB_RUN_ID` (the message's run link, and how this run's deployment is told apart). Try it locally:

```sh
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> \
  STAGE=<your environment> VERSION=v0.1.6 OUTCOME=ok DRY_RUN=1 node scripts/announce-deploy.mjs
```

**`--advance` and `ANNOUNCED_<STAGE>_VERSION` are gone.** Step N9 first kept the announced version in that repository variable and moved it with `--advance` after a post; the workflow token can't write a repository variable, so the Owner chose the deployments as the record instead (2026-10-15). Delete the variable if you created one. **`SLACK_RELEASE_WEBHOOK` is gone too.** Store the webhook in `KANON_CHAT_DEPLOY` instead, for the `notify` job. `kanon init` doesn't map `KANON_CHAT_DEPLOY` into the deploy caller yet: add the mapping by hand until it does.

## The release announcement

[`agent-release-announce.yml`](../.github/workflows/agent-release-announce.yml) is the producer of `release` messages ([plan 0011 §3.2](plans/0011-notifications.md#32-kinds-and-severities), [kanon#1190](https://github.com/yedeya-labs/kanon/issues/1190)): **each published GitHub release, posted once**, for a repository that releases without deploying, or that wants its releases heard apart from its deploys. A general lane: any repository that publishes GitHub releases can call it, and Kanon's own Slack is its first consumer. Its caller fires on `release: [published]`, and on a dispatch with `tag`, to announce a release again, and `dry_run` ([`docs/lanes.md`](lanes.md#the-release-announcement)). It runs no model. Its three jobs:

- **The gate** admits whoever published the release, a person with write access or an App the register names, such as the Releaser a promotion publishes as (`K-AGENT-45`). It checks out `.github/actions/notify` alone, to see whether the hook exists, and reads `KANON_CHAT_RELEASE` only as one presence boolean. With no hook, or no secret, the `announce` job doesn't run and the run stays green.
- **The `announce` job** runs [`scripts/announce-release.mjs`](../scripts/announce-release.mjs), which reads the release by its tag with the workflow token (`contents: read`) and nothing else, holds no chat secret and posts nothing. **A stable release and a pre-release both post, and both are `info`** (the Owner's decision of 2026-10-20); a pre-release says so, "pre-release" and "candidate", in its title and summary. The message is the release's tag, its name where it differs from the tag, its notes as Features, Fixes and Maintenance, each line through `literal`, and a link to the release. **Which release-note formats it reads** ([kanon#1196](https://github.com/yedeya-labs/kanon/issues/1196)): release-please's (`### Features` and `### Bug Fixes` headings over `* **scope:**` bullets) is sorted by heading with the deploy announcement's helpers ([`scripts/lib/release-notes.mjs`](../scripts/lib/release-notes.mjs)). A body counts as release-please's when a bullet has its `**scope:**` prefix, or when it has a Features or Fixes heading and something only release-please writes, its `## [x.y.z](…/compare/…) (date)` version heading or a bullet ending in its `([abc1234](…/commit/…))` link; a Features or Fixes heading alone is not enough ([kanon#1208](https://github.com/yedeya-labs/kanon/issues/1208)). Any other bulleted body, such as GitHub's auto-generated notes (`* feat: add x by @u in …/pull/1`), categorized by a `.github/release.yml` or not, or a hand-written one, is sorted by each bullet's conventional-commit prefix (`feat` a Feature; `fix`, `perf` and `revert` a Fix; `docs`, `style`, `refactor`, `test`, `build`, `ci` or `chore`, or an internal scope such as `feat(ci):`, Maintenance). A bullet with no such prefix goes under its heading when that heading is a Features or Fixes one ("Exciting New Features", "Bug fixes"), to Maintenance when it is a dependency bump, and otherwise under Changes with its text whole: a `Word: text` bullet whose word is no conventional-commit type, such as `- Breaking: drop Node 16`, is a Change, not a type. The pull request is kept as a link, and GitHub's New Contributors are left out. A body with no bullet becomes its first lines under Notes, at most 10 lines and 700 characters, cut further by the message's limits. An empty body posts the tag, the summary and the link alone. The deploy announcement and the weekly digest still read release-please's format alone. **A draft announces nothing,** and a tag with no published release fails the job by name. It builds the message with `fit`, checks it with `validate`, and uploads it as `kanon-notify-release-announce-announce-<run id>-<attempt>`. On a dry run it prints the message, its plain text and Kanon's Slack hook's payload to the run's summary, uploads nothing, and the `notify` job doesn't start.
- **The `notify` job** posts the message through your hook, with `KANON_CHAT_RELEASE` and no other secret ([The `notify` job](#the-notify-job)). Its row lands in the `release-announce` partition of the telemetry ([`docs/telemetry.md`](telemetry.md)).

**A release the workflow token publishes starts no run,** as GitHub never starts a workflow from the token's own events: publish as a person, or as an App such as the Releaser. **Nothing records what was announced:** each published release fires the lane once, and a dispatch with its tag announces it again. **A release's caller is its tag's:** GitHub runs the caller as it is at the tagged commit, so a tag whose caller pins another Kanon release than the default branch's is refused by the gate's pin check; dispatch it from the default branch with `tag` to announce it.

Try the producer locally:

```sh
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=<owner>/<repo> TAG=v1.2.3 DRY_RUN=1 node scripts/announce-release.mjs
```

## The weekly digest

[`agent-weekly-digest.yml`](../.github/workflows/agent-weekly-digest.yml) is the producer of `weekly-digest` messages, for a stakeholder outside the day-to-day work ([plan 0011, step N8](plans/0011-notifications.md#12-order-of-moves); [`docs/lanes.md`](lanes.md#the-digests) says what it reports). Its three jobs:

- **The gate decides whether anything will be posted,** before any model runs and outside the job that holds the Claude credential. It checks out `.github/actions/notify` alone, which runs nothing and keeps no credential, to see whether the hook exists, and reads `KANON_CHAT_WEEKLY_DIGEST` only as one presence boolean. It publishes `hook` (`present` or `none`) and `narrate`: `true` with a hook and the secret, or on a dry run. With the secret and no hook, nothing posts: there is no built-in fallback.
- **The `digest` job runs only when `narrate` is `true`,** so with no hook or no secret neither the job nor its model runs, and the run's summary says why. [`scripts/weekly-digest.mjs`](../scripts/weekly-digest.mjs) builds the message with `fit` and checks it with `validate`: the title is the week, the summary is the model's narrative (through `prose`) or, without one, the milestone burndown, then sections for milestones completed, Progress, Gate candidates and Delivered, and the week's counts last. Milestone titles, issue titles and release-note lines go through `literal`. Its narrative screen is unchanged: a narrative that names an environment, claims something is live, or frames work as pending is dropped whole, and the numbers still post. It writes `message.json` and uploads it as `kanon-notify-weekly-digest-digest-<run id>-<attempt>`, the job's `message-artifact` output; it holds no chat secret and posts nothing. On a dry run it prints the message, its plain text and Kanon's Slack hook's payload to the run's summary, uploads nothing, and the `notify` job doesn't start.
- **The `notify` job** posts the message through your hook, with `KANON_CHAT_WEEKLY_DIGEST` and no other secret ([The `notify` job](#the-notify-job)).

**The escaping is the hook's.** The digest used to escape Slack's `&`, `<` and `>` itself and write Slack's own links and emoji; it now writes Kanon text, and [Kanon's Slack hook](#kanons-slack-hook) escapes for Slack, so an issue titled `<!channel>` reaches Slack as text.

**`DIGEST_WEBHOOK` is gone from this lane** (decision 17, a clean break). The lane declares `KANON_CHAT_WEEKLY_DIGEST` instead, so a caller that still maps `DIGEST_WEBHOOK` is refused by GitHub and its run doesn't start: map `KANON_CHAT_WEEKLY_DIGEST`, store the webhook in it, and add a hook.

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

**Two files.** The action, [`actions/notify/slack/action.yml`](../actions/notify/slack/action.yml) with [`slack.mjs`](../actions/notify/slack/slack.mjs), is the code, at a Kanon release; it reads the hook's four inputs (`message-v1`, `text`, `kind`, `secret`) and nothing else. The hook file, [`actions/notify/hooks/slack.yml`](../actions/notify/hooks/slack.yml), is what `kanon init --chat slack` writes to `.github/actions/notify/action.yml`: a composite action whose one step is `yedeya-labs/kanon/actions/notify/slack` at the release `init` ran from (the candidate's tag on a candidate pin), with the four inputs passed through. A release moves that pin in Kanon's copy, and the upgrade skill moves yours with your callers', in the same edit. Change the step and it is your own hook.

**One webhook, the one it is given.** `secret` is one Slack incoming-webhook URL, and the hook posts there and nowhere else: create an incoming webhook for the channel ([Slack's guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)) and store its URL in the kind's secret. There is no routing inside a secret: each kind reaches its own channel because its own secret holds that channel's webhook, and the same URL in all of them puts everything in one channel. **Anything but `https://hooks.slack.com/services/…` is refused,** naming the input and never echoing its value: another URL means another system, which is the generic webhook hook's job or your own hook's.

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

**Two files.** The action, [`actions/notify/webhook/action.yml`](../actions/notify/webhook/action.yml) with [`webhook.mjs`](../actions/notify/webhook/webhook.mjs), reads the hook's four inputs and nothing else. The hook file, [`actions/notify/hooks/webhook.yml`](../actions/notify/hooks/webhook.yml), is what `kanon init --chat webhook` writes to `.github/actions/notify/action.yml`: a composite action whose one step is `yedeya-labs/kanon/actions/notify/webhook` at the release `init` ran from, with the four inputs passed through. Its pin moves as the Slack hook's does, and changing the step makes it your own hook.

**What the receiver gets.** One `POST` to the URL in the kind's secret. **The body is the message itself,** byte for byte the validated `message-v1` file: the kind, the severity, the title, the summary, the sections in Kanon text, the links and the source, as [the message](#the-message) describes them. Validate it against [`docs/notify/message-v1.schema.json`](notify/message-v1.schema.json) if you like. Nothing is rendered or escaped: Kanon text arrives as Kanon text, and the plain-text rendering is not sent, since the receiver can compute what it needs. The headers are `Content-Type: application/json` and `User-Agent: kanon-notify/1`, and nothing else identifies your repository beyond the message's own `source`. A kind the hook doesn't know, or a field it doesn't know, is posted as it is.

**One URL, the one it is given.** `secret` must be one `https://` URL of at most 2,000 characters. Anything else (`http://`, another scheme, a JSON map of URLs, two URLs) is refused, naming the input and never echoing its value. Routing is by the kind's secret, as with Slack: store one URL in each kind's secret, the same URL in all of them if one receiver takes everything.

**No signature.** The body is not signed in this version: the URL is the secret, as a Slack webhook's is, so keep it unguessable and treat it as a credential (plan 0011, decision 20). Signing may come later as an optional input.

**Errors.** A non-2xx answer fails the step with its HTTP status alone: never the URL, and never the response body, which a receiver Kanon knows nothing about could fill with anything. **A redirect is not followed,** and fails, so the URL and the message are never re-sent to a host the secret doesn't name. A `429` is retried once, after its `Retry-After`, when that is at most 60 seconds (one second when there is none); a second `429` fails.

## Security

The hook runs with one kind's chat secret, so where its code comes from matters. Plan 0011's [§5.3](plans/0011-notifications.md#53-any-branchs-code-and-what-that-exposes) states the weakness the design accepts; it is here word for word. The doctor checks it names (`notify.hook-unreviewed`) come with plan 0011's doctor step.

**The hook runs on the run's commit, whatever branch it is on** (decision 8): a `schedule` runs the default branch's hook, and a dispatch on another branch runs that branch's. The Owner chose this over a default-branch-only rule after being told the risk, and Kanon adds no restriction. **The weakness, plainly:**
- **Anyone who can push a branch and dispatch the lane can read the kind's chat secret.** They change `.github/actions/notify/action.yml` on their branch to print or send the secret, dispatch the notifying lane on that branch, and the hook runs with it. Nothing reviews the branch first: escalation (`K-MERGE-4`) guards what merges to the default branch, not what runs on another. A published release is a second way in where the release announcement is installed: the lane runs at the release's tag, so whoever can tag an unreviewed commit and publish a release on it runs that commit's hook with `KANON_CHAT_RELEASE` ([kanon#1190](https://github.com/yedeya-labs/kanon/issues/1190)).
- **That includes an agent.** An App that can push a branch and dispatch a workflow (`contents: write` and `actions: write`) can do it without GitHub's `workflows` permission, because the hook is not under `.github/workflows/`. An agent steered by text it read could do the same.
- **What it is not:** a fork's pull request can't, since no notifying lane has a `pull_request` trigger and the guard holds that ([§5.2](plans/0011-notifications.md#52-what-the-job-holds-and-what-it-never-holds)); and the exposure is the chat secrets alone, never an App key or the Claude credential, which the `notify` job never holds. A person with write access can already push a workflow that reads repository secrets; what this adds is that an App without the `workflows` permission can reach the chat secrets too.
- **What it costs:** a leaked webhook lets its holder post to that channel as Kanon. Slack revokes a webhook it finds leaked ([§13](plans/0011-notifications.md#13-what-slacks-documentation-says)); the adopter replaces it and stores the new URL.

**What still protects the default branch's runs.** A scheduled run executes the default branch's hook with the secret, and the Merger may merge an agent's change. Every file under `.github/` escalates (`K-MERGE-4`), so a change to the hook's `action.yml` always reaches a human first. **That covers only what escalates.** A script the hook runs from elsewhere in the repository (`scripts/post-to-teams.mjs`), a local action outside `.github/`, or a package the hook installs, is not on an escalation path unless the adopter declares it under `## Pipeline code` in `docs/qa/escalation-paths.md` (`K-MERGE-4`, `K-LAYOUT-8`). So **every repository path the hook runs must escalate** ([§6.2](plans/0011-notifications.md#62-how-a-hook-declares-and-pins-its-contract), item 2), and doctor checks the paths it can see (`notify.hook-unreviewed`). **What doctor can't see,** and so remains: a path a script builds at run time, a file a reviewed script imports from outside `.github/` and the declared pipeline code, and a hook that `curl`s code and runs it. `notify.hook-unreviewed` reads what the hook names; what the hook's code then does is the adopter's review's to catch.

Doctor has no check for the branch exposure itself (decision 22): it is stated in the plan, on this page, and in `SECURITY.md`'s accepted exposures, [The `notify` job's chat secret](../SECURITY.md#the-notify-jobs-chat-secret), which an adopter's security review reads.
