# Plan 0006: upstream findings reach Kanon through the telemetry channel, promoted by Jev

- **Status:** decided, 2026-10-07. The Owner's decisions on [#481](https://github.com/yedeya-labs/kanon/issues/481) are recorded in §0, and the Owner's answers on this plan's pull request, the same day, under [Owner decisions (2026-10-07)](#owner-decisions-2026-10-07). One thing is left open: Jev's cost, approved before F7 once it is known (decision 22).
- **Tracks:** #481. **Builds on:** #41 (Kanon's own bugs) and #471 (the telemetry Explorer). **Governed by:** [ADR 0007](../decisions/0007-data-boundary.md) (the data boundary, amended the same day for this plan), `K-OBS-13`, `K-OBS-16` to `K-OBS-18`, `K-LAYOUT-10`, `K-SELF-8`, `K-SELF-11`, `K-PRIN-6`, `K-OBS-14` (claims are measured), [plan 0002](0002-hosted-telemetry-store.md), whose store and schema this plan extends, and [plan 0004](0004-move-the-remaining-lanes.md) decision 12, which still holds.
- **Not measured.** Nothing here has run yet: no adopter sends findings, and Jev has not been called. The numbers below are the Owner's decisions, not measurements. F8 is the step that measures Jev against them.

## The plan in one paragraph

**Today.** Two lanes find things only Kanon can act on: the Overseer, and the telemetry Explorer (#471). By default, `Upstream findings: drafted`, each such finding stops at the adopter as a draft, under the audit issue's `## Upstream` heading or in the run's step summary. `filed here` files it in the adopter's own repository. Plan 0004 decision 12 says the adopter "may file on Kanon by hand", but nothing links a draft anywhere, so Kanon hears about its own bugs only through #41's content-free run rows, or when someone reports them.

**Where it ends.**
- **Two more values of the same choice,** `sent` and `sent with evidence`, asked during install like the telemetry opt-in (#428).
- **A third row kind, the finding row,** in the telemetry schema. `sent` carries Kanon's vocabulary only; `sent with evidence` adds the draft's evidence and suggested fix as free text, after a deterministic scrub in the adopter's lane, checked again at intake.
- **The same channel as run rows:** the lane's filing job writes the row into an artifact, and the collector sends it with the repository's writer role. No new credential, no new trust.
- **The #41 job files every finding privately first,** on one issue per signature, next to the matching signal and its counts.
- **Jev, TypeSafe's typed decision model, decides which become public Kanon issues,** behind a deterministic gate, failing closed, and only after a shadow phase in which its calls are measured against the Owner's.

**How it gets there.** The schema and the scrub come first, invisible to adopters. Then the choice and its install questions, then the lanes' rows, then intake. The private job files findings privately before Jev is called at all. Jev then runs in shadow, its calls are measured, and it promotes on its own only when the measurement says so.

## 0. The Owner's decisions (2026-10-07, on #481)

Decided, and not reopened here:

1. **No human in the adopter's path.** A link in an issue body, a comment or a log still needs someone to click it. Upstream findings travel over the opt-in telemetry channel, never as an issue filed from another repository, so plan 0004 decision 12 holds.
2. **Two opt-in levels,** asked during install like the telemetry opt-in (#428):
   - `Upstream findings: sent` sends Kanon-vocabulary fields only: lane, stage, error and reason codes, Kanon version, rulebook ids, Kanon-shipped file paths, and a suggested-fix category.
   - `Upstream findings: sent with evidence` also sends the draft's evidence and suggested fix, as free text, after an automated scrub: no paths outside Kanon's tree, no URLs, logins or repository names.
   - `drafted` and `filed here` stay as they are.
3. **The path.** The Overseer or the telemetry Explorer posts the finding to the telemetry store, with the same key and auth as run rows. The #41 job, in the Owner's private operations repository, files every finding privately first.
4. **The Owner's own repositories use the same relay.** No direct filing on Kanon, and no cross-repository trust.
5. **Findings and signals share #41's signature** (lane, stage, error, reason, version). A finding and a signal with the same signature end up on one issue, with the evidence and the counts together.
6. **Promotion to a public Kanon issue is decided by Jev** (TypeSafe's typed decision model), bounded:
   - **A deterministic gate runs first:** closed vocabulary, no adopter key (`assertNoKey`), and for evidence text the public-words and identifying-content scrub. Jev judges whether a finding is *worth* publishing, never whether it is *safe*.
   - **Its questions** are a Choice (Kanon bug / adopter configuration / platform / unclear; only "Kanon bug" can be promoted) and a Noul ("a maintainer can act on this without asking the adopter").
   - **Fail closed:** low confidence, a provider error or no match leaves the finding private.
   - **Shadow first:** Jev labels each private finding with its call while the Owner promotes by hand. Once its calls match the Owner's on a set number of findings, it promotes on its own above a confidence threshold. Measured before trusted, as in plan 0003's M2.
7. **What Jev sees:** the vocabulary fields, #41's counts and, for `sent with evidence`, the scrubbed evidence text. The install question for that level says the text reaches a third-party decision provider, and ADR 0007 is amended to name what leaves the repository, and to whom.

## 1. What exists today

### 1.1 The two lanes, and where their upstream findings stop

- **The Overseer** (`agent-overseer.yml`). Its agent writes `qa-overseer-audit.json`, each finding with a free-text `title` and `body` and a `subject` from a fixed list. `scripts/overseer-file.mjs`, in a `file` job of its own that runs no agent, routes by subject: `lane`, `guard`, `rule` and `library` are Kanon's (`K-SELF-11`). Those become drafts under the audit issue's `## Upstream` heading, or, with `filed here`, issues in the same repository.
- **The telemetry Explorer** (`agent-explore-telemetry.yml`, #471). Its agent writes `qa-telemetry-findings.json`. Each finding names the aggregate's signals it rests on by their codes (`lane`, `reason`, `failed_stage`, `kanon_error`, `kanon_version`). `scripts/telemetry-file.mjs` checks each against the aggregate and files it with `filed here`, or writes it into the run's step summary with `drafted`. Today it runs only where an aggregate invoker role exists, which is Kanon.
- **The choice** is one bullet under `## Choices` in `docs/qa/adoption.md`, `- **Upstream findings:** \`drafted\`` or `` `filed here` `` (`K-LAYOUT-10`). It is parsed by `scripts/lib/upstream-findings.mjs`, read from the default branch in each lane's gate job before any agent runs (`K-MERGE-17`), and handed to the filing job as `UPSTREAM`. `lane-check` and `kanon doctor` fail a malformed one on the pull request.

### 1.2 The channel the findings will use

- **Run rows** are written by `agent-telemetry` into a `kanon-telemetry-<lane>-<run id>-<attempt>` artifact. The collector (`telemetry-collect.yml`, `scripts/telemetry-collect.mjs`) is the only job that holds `id-token: write` (`K-OBS-13`). It validates each row and sends up to 25 per signed `POST` to the ingest function with the repository's writer role. The function (`infra/telemetry/function/index.mjs`) takes the adopter's key from the role, never from the row, runs `validate`, and builds the partition itself.
- **The schema module** (`actions/agent-telemetry/schema.mjs`, linked into the function's directory) has two row kinds today, `run` and `work_item`. Every string is an enum or a strict pattern, and a row is valid whole or not stored.
- **`K-OBS-16`** forbids free text in any row. ADR 0007 is amended alongside this plan to allow the one exception level 2 needs (§2.2).

### 1.3 The #41 job

[`scripts/telemetry/kanon-bugs.mjs`](../../scripts/telemetry/kanon-bugs.mjs) is the public detection: run rows in, signals out, with no network. A signal's signature is `signalSignature`, a hash of `signal`, the lane, `failed_stage`, `kanon_error`, `reason` and `kanon_version`, carried in the issue body as `<!-- kanon:bug-signature=… -->`. The job that runs it is private: a scheduled job in the Owner's private operations repository (the #41 job; plan 0002 S10). It files every signal privately, and files a public Kanon issue only for a signal at `MIN_ADOPTERS` (three) adopters or more. Its configuration, its credentials and its below-threshold output stay private. This plan extends that job and nothing else private. It names no other private place.

## 2. The finding row (decision 8)

### 2.1 The fields

**Row kind `finding`, version 1. Each field is optional unless marked required. No nesting.** Every string is an enum, a strict pattern, or one of the two text fields of §2.2.

| Group | Fields | Type |
|---|---|---|
| **Row** | `schema_version` (required, `1`); `row_kind` (required, `finding`); `tag` (required, `run`, `smoke` or `test`); `recorded_at` (required) | integer; enum; enum; ISO-8601 UTC |
| **Run** | `run_id`, `run_attempt` (both required): the run of the lane that found it; `finding_index` (required): its position in that run's report | integers; `finding_index` 0 to 19 |
| **Reporter** | `reporter` (required): `overseer` or `explore-telemetry`, the lane that found it | enum, a subset of the lane list |
| **Subject** | `subject` (required): `lane`, `guard`, `rule` or `library`, the Overseer's Kanon subjects (`SUBJECTS` in `overseer-file.mjs`); every telemetry-Explorer finding is `lane` | enum |
| **Signature** (§2.4) | `lane`: the lane the finding is about, from the lane list; `failed_stage`; `kanon_error`; `reason`; `kanon_version` (required) | the run row's own enums and pattern, imported, not copied |
| **Kanon's vocabulary** | `rules`: rulebook ids, at most 10; `kanon_paths`: Kanon-shipped file paths, at most 10; `fix_category` (required): one of decision 9's list | list of `^K-[A-Z]+-\d{1,3}$`, each in the schema's `RULE_IDS`; list of `^(actions\|cli\|scripts\|skills\|rulebook\|docs\|infra\|\.github/(workflows\|scripts))/[A-Za-z0-9._/-]{1,200}$`; enum |
| **Level** | `evidence_level` (required): `codes` for `sent`, `evidence` for `sent with evidence` | enum |
| **Evidence** (§2.2, level 2 only) | `evidence`; `suggested_fix`; `scrub_version` (required with either) | text, at most 2,000 characters; text, at most 1,000; integer |

- **`RULE_IDS`** is a closed list in the schema module, like `GUARDS`: the schema test fails when it differs from the rulebook's headings, so a rule added without it, or an id that doesn't exist, fails.
- **`kanon_paths` is a path in Kanon's tree, not the adopter's.** The pattern only roots it at Kanon's top-level directories, so an adopter's own `scripts/x.mjs` would match it. The lane's scrub keeps a path only when it exists in the Kanon tree the lane runs from (`$KANON`, the release it pinned), and the #41 job checks it again against that release's tree (§6). A path that fails either is dropped, never sent.
- **No title, no body.** A public or private issue's title is rendered from the codes, as `renderIssue` does for a signal. The agent's own title stays in the adopter's draft.
- **Cross-field rules,** checked by `validate` like a run row's pairings: `evidence` and `suggested_fix` are allowed only with `evidence_level: evidence`, and `scrub_version` is required with either; `reporter: explore-telemetry` requires `subject: lane` and a `lane`. A finding has no outcome, so its `reason` is checked against the reason list alone, without a run row's reason-outcome pairing.

**Set by the store, never by the row:** the key, `source`, `received_at` and `expires_at`, as for every row.

### 2.2 The evidence fields

- **Two text fields, and only on this row kind.** The schema gains a `text` field type: a string of at most its `max` characters, no control characters but the newline, and no `<!--`, so a text can't forge an issue marker. `validate` also runs the scrub's verifier (§4.2) on it, and a text that fails is a rejected field, named, never echoed.
- **Sizes** (decision 10): `evidence` at most 2,000 characters, `suggested_fix` at most 1,000, measured after the scrub. Longer text is cut at the last whole line before the limit and ends `[cut]`. At most 20 finding rows per run (`finding_index` 0 to 19); a report with more sends the first 20 and its summary says how many it held back.
- **The function's limits hold:** 25 rows per `POST` and 256 KB per body. Twenty-five rows of 3,000 characters fit well inside them.

### 2.3 Key, retention and readers

- **A reserved partition, `finding`,** beside `work`: `pk = <key>#finding`, `sk = <recorded_at as YYYYMMDDTHHMMSSZ>#<run id>-<attempt>-<finding_index>`. The schema test fails if the lane list ever holds `finding`, as it does for `work`. A re-sent row overwrites identically.
- **Retention:** 13 months from `recorded_at`, 30 days for `smoke` and `test`, as a run row (decision 11). **Erasure on request must walk the `finding` partition, and today it wouldn't:** `PARTITIONS` in `infra/telemetry/function/index.mjs` is `[...LANES, RESERVED_PARTITION]`, and `RESERVED_PARTITION` is the single string `work`. F1 adds `finding` to `PARTITIONS`, so the erase script walks it, and F4's check proves it.
- **Who reads it:** the Owner and the #41 job. The adopter's reader role already reads every partition under its own key, so it reads its own findings. **The aggregate function never does:** it queries `<key>#<lane>` for the lanes alone, with a projection that names no finding field, so no finding text can reach the Explorer's lane or a published figure.

### 2.4 The signature, shared with #41

`kanon-bugs.mjs` exports one signature function for both, so the two can't drift:

```js
export const signature = (s) => hash(['signal', s.lane ?? '-', s.failed_stage ?? '-', s.kanon_error ?? '-', s.reason ?? '-', s.kanon_version]);
```

`signalSignature` becomes that function, and every signal's signature is unchanged, because a signal always has a lane and a reason. A finding with the same five fields gets the same signature, so the job puts the two on one issue. A finding that names none of lane, stage, error or reason (a rule, guard or library finding) would otherwise share one signature with every other such finding on its release, so decision 12 extends it for those alone: the sorted `rules` and `kanon_paths` are appended. Such a finding can't match a signal anyway, since every signal has a lane and a reason.

## 3. The opt-in

### 3.1 The declaration

`K-LAYOUT-10`'s bullet takes four values, each one code span with nothing after it:

```markdown
- **Upstream findings:** `sent with evidence`
```

| Value | Drafted for the adopter | Filed in the adopter's repository | Sent to Kanon's store |
|---|---|---|---|
| `drafted` (the default) | yes | no | no |
| `filed here` | no | yes | no |
| `sent` | yes | no | the vocabulary fields |
| `sent with evidence` | yes | no | the vocabulary fields, and the scrubbed evidence and suggested fix |

- **A sent finding is also drafted** (decision 13). The draft under `## Upstream`, or in the step summary, shows the adopter exactly what was sent: the codes, and for level 2 the text after the scrub, not before. Each such draft is marked "sent to Kanon", and the heading's sentence says at which level, and that the operator's private job reads it. When the scrub withheld the text (§4.2), the draft says so, and by which rule.
- **`sent` and `sent with evidence` need the telemetry opt-in.** Without a collector caller there is no channel, so `lane-check` and `kanon doctor` report `upstream.unsent`, naming both fixes: opt in to telemetry, or choose `drafted`. The lanes still draft, and nothing is sent.
- **The agent can't change the level.** The gate job reads the record from the default branch, as today, and the filing job builds the rows. The collector reads the record again from the default branch before it sends a finding row: it sends none when the record says `drafted` or `filed here`, and strips the evidence fields from any row whose level is above the record's. So turning the level down stops the text at the next sweep, even for artifacts written before.
- **`parseUpstreamFindings`** accepts the two new values, and every other check of the bullet stays: twice, outside `## Choices`, another shape or another value is malformed.

### 3.2 The install questions

Every input is asked as a question (#428), after the telemetry question, in the adopt skill's "The questions", with `kanon init` flags and a `docs/init.md` row. The upgrade skill needs nothing of its own: its step 5 asks every answer the target's `docs/init.md` lists and the pinned release's doesn't, as the adopt skill asks it.

**`.answers.upstreamFindings`: where findings only Kanon can act on go.** Asked of every installation.
- **Say, in the question:** an upstream finding is one about Kanon itself, a lane's behaviour, a guard, a rule or Kanon's library, found by the Overseer or the telemetry Explorer; whichever is chosen, nothing is ever filed in another repository.
- **Recommended: `Drafted`**, because sending is the person's to offer, as telemetry is.
- **Options:**
  - **Drafted** (`--upstream-findings drafted`): written into the audit issue or the run's summary, for the person to read. Nothing is filed or sent.
  - **Sent to Kanon** (`--upstream-findings sent`): also sent to Kanon's telemetry store as codes only, the lane, stage, error and reason codes, the Kanon release, rulebook ids, Kanon's own file paths and a fix category; no text. Offered only when the telemetry answer is yes; otherwise the option's description says it needs telemetry.
  - **Filed here** (`--upstream-findings filed-here`): filed as issues in this repository, for a repository that maintains Kanon itself or a fork of it.

**`.answers.upstreamEvidence`: also send the evidence text.** Asked only after **Sent to Kanon**.
- **Say, plainly, in the question itself** (the wording, decision 14): "Also send each finding's evidence and suggested fix, as text? The agent writes it for Kanon's maintainer, to Kanon's template, without names, logins, URLs, repository names or quotes of this repository's text, and before it leaves, an automatic scrub removes URLs, this repository's name, the logins and names the lane can see, and every path outside Kanon's own files. **It may rarely still contain personal data,** such as a name the scrub didn't know. **The text is read by Kanon's maintainer, and by a third-party decision provider, TypeSafe, whose model, Jev, decides whether a finding becomes a public Kanon issue.** The text itself is never published: a public issue holds only the codes. It is kept 13 months in Frankfurt and erased on request, like telemetry."
- **Recommended: Codes only.**
- **Options:** **Codes only** (keeps `sent`); **With evidence** (`--upstream-findings sent-with-evidence`), whose description repeats who reads the text.

**`kanon init`** writes the bullet only when the answer differs from the default, `drafted`, as for every declaration (plan 0005 §5.2).

### 3.3 What learns the two values

`K-LAYOUT-10` and `K-SELF-11` (the rule text and its Enforced by), `scripts/lib/upstream-findings.mjs`, `lane-check`, `kanon doctor` (`upstream.unsent`), `docs/lanes.md` for both lanes, `docs/init.md`, the adopt skill, and `docs/telemetry.md`'s "What an adopter gets by opting in".

## 4. The evidence: extracted, then scrubbed (decision 15)

**Extract, don't redact (the Owner's decision, 2026-10-07).** A redaction of the adopter's own prose keeps the adopter's words and removes only what a rule recognises. So level-2 text is not the draft's prose with parts removed: the lane *writes* the evidence for a Kanon maintainer, in Kanon's terms, from a shared Kanon skill (§4.1). The deterministic scrub (§4.2) then runs on what the lane wrote, as a backstop.

### 4.1 The `upstream-finding` skill

- **Where it lives:** `skills/upstream-finding/SKILL.md`, beside the adopt, doctor and upgrade skills, so it ships in every release with the rest of Kanon's tree. The lanes don't install it: each lane already puts Kanon's tree at its pinned release in the agent's environment as `$KANON` (`actions/kanon-path`), and its prompt says when to read what there. The Overseer's prompt (`overseer-agent-job.yml`) and the telemetry Explorer's (`explore-telemetry-agent-job.yml`) each say: before writing an upstream finding's `evidence` or `suggested_fix`, read and follow `$KANON/skills/upstream-finding/SKILL.md`. One file, so the two lanes can't drift apart.
- **A fixed template,** five headed parts, each in Kanon's terms:
  - **Expected:** the Kanon rule or behaviour, by id (`K-…`, a lane, a guard).
  - **Observed:** what happened, in Kanon's terms: stages, codes, outcomes.
  - **Where:** the Kanon file and line, at the finding's `kanon_version`.
  - **Reproduce:** the steps, in Kanon's terms: the lane, its trigger and inputs, the declaration's value.
  - **Suggested fix:** written into `suggested_fix`, not `evidence`.
- **Hard rules:** no people, logins or personal names; no repository names; no URLs; no paths outside Kanon's tree; no quotes of the adopter's text, whether code, issue, PR, comment or commit message. Roles instead: "the PR", "the reviewer", "an adopter workflow", "the adopter's hook".
- **A self-check.** Before writing the report, the agent re-reads each extract against the hard rules. When it can't write the finding without breaking one, it leaves `evidence` and `suggested_fix` empty, and the finding is sent as codes only. The draft says why.
- **Not trusted alone.** The skill is an instruction to the agent, and a steered agent can ignore it. What leaves is still bounded by the scrub (§4.2), the schema and intake, none of which the agent can change.

### 4.2 The scrub, a backstop

**One module, `actions/agent-telemetry/scrub.mjs`,** `node:` built-ins only, beside the schema and linked into the function's directory with it. It has two halves that share one list of rules, so what the lane removes and what intake refuses are the same rules at the same release:

- **`redact(text, context)`**, in the adopter's lane, replaces what it finds with a placeholder and returns the text and the names of the rules that fired.
- **`verify(text, context)`**, at intake and in the #41 job, returns the names of the rules that would still fire, never the text. Any name refuses the row.

**The rules, in order** (`scrub_version` 1):

| Rule | Finds | Lane's placeholder |
|---|---|---|
| `marker` | an HTML comment, `<!--` | removed |
| `url` | anything with a scheme (`https://`, `ssh://`, `git@`), and `www.` | `[url]` |
| `email` | an email address | `[email]` |
| `mention` | `@` and a login shape | `[login]` |
| `key` | an adopter key's shape (eight hex characters) and a partition's (`<key>#<lane>`), as `telemetry-file.mjs` refuses them | `[key]` |
| `token` | a credential's shape: GitHub and cloud token prefixes, and any unbroken run of 32 or more base64 or hex characters | `[token]` |
| `path` | a path-shaped token: one holding `/`, or starting `./`, `../`, `~` or a drive letter, or a file name with an extension. Kept only when it is a file in Kanon's tree (`context.kanonFiles`, from `$KANON` in the lane); `owner/name` shapes fall here | `[path]` |
| `name` | a word whose SHA-256 is in `context.nameHashes`, with or without an `@`: the repository's owner and name; the logins and App slugs of its App register; the run's actor; the repository's collaborators, where the filing job's token may list them; the logins of the run's issue and PR participants (authors, assignees, reviewers and commenters); and the logins and the words of the names of the commit authors the lane read. All hashed in the lane; plus `FORBIDDEN_WORD_HASHES` | `[name]` |

- **Reused, not rewritten.** The `name` rule is `.github/scripts/public-words.mjs`'s `namesForbiddenWord`, which already hashes each lowercase `[a-z0-9]+` run and takes the hash set as an argument: once with its own `FORBIDDEN_WORD_HASHES`, once with the context's. No name is ever written into the scrub, a test or a log, only hashes, as that guard does.
- **The adopter key** is checked with `assertNoKey` from `infra/telemetry/function/aggregate.mjs` at intake (every registered key) and in the #41 job (every key the rows held). The lane doesn't know any key, which is why the `key` rule refuses the shape.
- **At intake, the context is the sender's own.** `render.mjs` writes into the function's environment, per key, the SHA-256 of each word of the registered repository's owner and name, never the words. The function's `kanonFiles` check is the path pattern of §2.1, because it holds no tree; the #41 job holds the real check against the release's tree.
- **Fail closed in the lane.** If `verify` still fires after `redact`, which a test makes impossible for every fixture but which a new kind of text could reach, the row is sent at `evidence_level: codes`, without the text, and the draft says the evidence was withheld and by which rule. Text is never sent on a guess.
- **What it can't promise.** The `name` rule removes only the logins and names the lane can see. A login, or a person's name, the lane never saw (someone named in prose, a login from another repository) gets through unless the skill kept it out. So level-2 text **may rarely still contain personal data.** The plan, `K-OBS-16`, ADR 0007 and the level-2 install question all say so, and none claims the scrub removes every login.
- **Some useful text goes too.** A commit SHA has a key's or a token's shape, so it is redacted; the row's `kanon_version` already says which release. Erring this way is the point: where a rule can match, it removes too much rather than too little.
- **Deterministic.** No model takes part in the scrub, and nothing in it reads the network or the clock. The same text and context always give the same answer.

## 5. Intake (decision 16)

**The same key and auth as run rows** (Owner decision 3). No lane gains `id-token: write`, and no new role exists:

1. **The lane's filing job builds the rows.** `overseer-file.mjs` and `telemetry-file.mjs` already run in a job of their own with no agent, and already hold the gate job's `UPSTREAM`. For `sent` and `sent with evidence` they build one finding row per upstream finding, run `redact` on the text for level 2, `validate` every row, and upload them as one artifact, `kanon-finding-<reporter>-<run id>-<attempt>`. They still draft each finding, showing what was sent.
2. **The agent's report gains the vocabulary.** The Overseer's report gives each Kanon-subject finding an `upstream` object, `{ lane, failed_stage, kanon_error, reason, rules, kanon_paths, fix_category, evidence, suggested_fix }`, and the telemetry Explorer's findings already carry the signal codes. The filing step keeps a code only when it is in the schema's list, so a steered agent can choose which codes to send, never send a value outside Kanon's vocabulary. Its free text goes only into `evidence` and `suggested_fix`, written to the skill's template (§4.1), and only through the scrub (§4.2).
3. **The collector sends them.** It lists `kanon-finding-*` beside `kanon-telemetry-*`, refuses a row whose reporter, run or attempt isn't its artifact's, as it does for run rows, applies the record's level (§3.1), runs `validate` and `verify`, and sends the rows with the writer role. A finding row that fails `verify` here is sent at `codes` level, with a warning naming the rule, so an older lane's weaker scrub can't turn the collector red forever.
4. **The function stores them.** It accepts `row_kind: finding` from writer roles only, never from the importer or the backfill role. It checks `recorded_at`'s window, runs `validate`, `verify` with the sender's context, and `assertNoKey` over the row with every registered key, and answers per row. A rejection is a 422 naming fields and rule names, never values, and turns the collector red, which is the page (`K-OBS-6`).

**The writer's known gap carries over.** `K-OBS-13` records that any default-branch job holding `id-token: write` can assume the writer, not only the collector. Such a job could send finding rows too, but only rows that pass `validate`, `verify` and `assertNoKey`, under its own adopter's key.

**The Owner's own repositories use the same relay** (Owner decision 4). A repository the Owner owns declares `sent` or `sent with evidence` like any adopter. Kanon itself keeps `filed here`, since on Kanon "this repository" is Kanon (ADR 0011).

## 6. The private job's extension (decision 17)

The #41 job, in the Owner's private operations repository, already reads the run rows and runs `kanon-bugs.mjs`. It gains:

1. **It reads the `finding` partition of every key,** beside the run rows, `tag = run` only, as it reads run rows.
2. **It checks each finding again,** with Kanon's public code at the release the job pins: `validate`, `verify` with that key's name hashes, `assertNoKey` with every key, and each `kanon_paths` entry against the file list of the finding's `kanon_version` tag in Kanon's public repository. A finding that fails any check is filed privately, marked `gate: failed` with the rule's name, and can never be promoted.
3. **It files privately on one issue per signature** (§2.4), in that repository, as it files signals: the matching signal's counts, codes and classification, if there is one; every finding with that signature, its reporter, level, rules, paths and fix category, and its evidence and suggested fix for level 2; and the number of distinct adopters that sent one. A later finding or signal with the same signature updates the same issue, found by the `kanon:bug-signature` marker. Adopter keys appear in no issue, private or public.
4. **The logic is public, the running is private.** What it reads, checks and renders is a public module in Kanon, `scripts/telemetry/kanon-findings.mjs`, pure like `kanon-bugs.mjs`: rows in, private issues out, with no network. The private job supplies the rows, the credentials and the filing.

## 7. Promotion by Jev (decision 18)

### 7.1 The gate, first

A private finding is offered to Jev only when the deterministic gate passes: §6's checks passed, the finding's vocabulary is closed (it is, by `validate`), and the request built for Jev passes `assertNoKey` and `verify` itself. Jev decides whether a finding is worth publishing; whether it is safe is settled before Jev is asked, and nothing Jev says can make an unsafe finding public.

### 7.2 The questions

One call per signature that has a finding and no public issue yet, with the signature's fields, its signal's counts and classification when there is one, the number of adopters, and, for level-2 findings, their scrubbed evidence and suggested fix. Never a key, a repository, a run id or a date finer than a day.

- **A Choice:** what the finding is: **Kanon bug**, **adopter configuration**, **platform** or **unclear**. Only Kanon bug can be promoted.
- **A Noul:** "A maintainer can act on this without asking the adopter." Anything but an affirmed answer keeps it private.

### 7.3 The call

- **`scripts/telemetry/jev.mjs`, public, in Kanon,** `node:` built-ins and the runtime's global `fetch` only (`K-SELF-8`): `buildRequest`, `parseResponse` and `decide` are pure; `call` posts to `https://api.typesafe.ai/v1/systemone` with model `jev-latest` and the key in the header TypeSafe's reference names, with a 30-second `AbortSignal.timeout`. The request and response shapes are read from TypeSafe's API reference when F6 is built, and pinned by a recorded fixture, so a change in either fails a test, not a promotion.
- **`decide` fails closed.** The finding stays private on any of: a network error, a timeout or a non-2xx answer; a response that doesn't parse or lacks either answer; a Choice other than Kanon bug; a Noul not affirmed; a confidence under the threshold of 0.90 on either answer, or no confidence at all.
- **Promotion is proposing** (`K-PRIN-6`). A promoted finding becomes a public Kanon issue that a human triages, labelled as Jev's, like every filer's issue; nothing merges or closes on Jev's call. There is no cap on promotions per run (decision 19).

### 7.4 Shadow, then autonomy

- **Shadow.** For every private finding the gate passes, the job calls Jev and records the call on the private issue, as a label (`jev:promote` or `jev:keep`) and a hidden line with the Choice, the Noul and both confidences. The Owner promotes by hand, by a label on the private issue (`promote`) or by leaving it private. **Nothing is promoted on Jev's call in shadow.**
- **The ledger.** Each call is also one line in a ledger kept in the private repository: the signature, the time, Jev's two answers and confidences, Jev's would-be call under the threshold, and later the Owner's call and when. A finding counts once the Owner has decided it: promoted by hand, or kept private past 14 days, or closed.
- **Agreement.** A call agrees when Jev's would-be call (promote or keep) equals the Owner's. The count is of consecutive agreeing calls. A disagreement where Jev would have promoted and the Owner kept it private resets the count to zero; one where Jev would have kept it and the Owner promoted it is counted, reported, and also resets it, since both mean the threshold is wrong for the data.
- **Autonomy** (decision 20). The job runs in `shadow` or `auto`, a variable of the private job, and **refuses `auto` unless the ledger shows at least 30 consecutive agreeing calls** at the threshold of 0.90. So the switch is held by code, not by memory. In `auto`, it promotes on Jev's call, and keeps recording.
- **Back to shadow, by itself, on one rule only.** A promoted issue that the Owner closes as not a Kanon bug resets the count, and the job is back in shadow until 30 consecutive agreeing calls are measured again. Nothing else sends it back: a change of the model behind `jev-latest` does not.

### 7.5 The provider key

- **It lives in the private job's secrets,** as `TYPESAFE_API_KEY`, and nowhere else: not in Kanon, not in any adopter, not in a log.
- **Without it, findings stay private, and the job says so.** It skips every Jev call, keeps filing privately, writes one line in its summary and a warning annotation naming the missing secret, and adds "not judged: no provider key" to each private issue it touched. The run stays green: nothing is lost, only not promoted.

### 7.6 What a public issue holds

Only what level 1 sends, and the counts #41 may already publish: the signature's codes, the rulebook ids, the Kanon paths and the fix category, a title rendered from them, and the signal's run and adopter counts only when the signal itself is public (`MIN_ADOPTERS`, plan 0002 decision 7). **Never the evidence or suggested-fix text, whichever level sent it,** and never a key, a repository, a run id or a login. That follows from Owner decision 7 and ADR 0007's amendment: the text goes to Kanon's maintainer and to TypeSafe, and to no one else. The maintainer reads it on the private issue.

## 8. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **F1** | Kanon | **The finding row and the scrub.** `finding` version 1 in the schema module (§2), `RULE_IDS`, the `text` type, the reserved `finding` partition, `scrub.mjs` (§4.2), `finding` added to `PARTITIONS` (§2.3), and `signature` exported from `kanon-bugs.mjs` (§2.4). `K-OBS-16`'s Enforced by drops "planned". When the Owner accepts this plan, plan 0002's header and plan 0004 decision 12 note it. | Every fixture finding validates, and every existing signal's signature is unchanged. **Mutations:** a finding with a `title` field, a free-text `fix_category`, `evidence` at `evidence_level: codes`, `evidence` of 2,001 characters, a `rules` id the rulebook doesn't have, or a `kanon_paths` entry outside Kanon's top-level directories each fails `validate`; adding `finding` to the lane list fails the schema test; dropping one scrub rule lets its fixture through `verify`, and its test fails; a text holding a URL, an email, an `@login`, a key's shape, a 40-character hex run, an adopter path, or a word whose hash is in the context each fails `verify` and is replaced by `redact`; **a bare third-party login with no `@`, a collaborator's or a PR reviewer's, in the context, is removed**, and dropping the participants from the context lets it through, and the test fails. |
| **F2** | Kanon | **The two values and their questions** (§3). The parser, `lane-check`, `kanon doctor`'s `upstream.unsent`, `kanon init`'s `--upstream-findings`, the adopt skill's two questions, the `docs/init.md` row, `K-LAYOUT-10` and `K-SELF-11`. | `sent with evidence` under `## Choices` parses; `sent  with evidence` is malformed by line. A record saying `sent` with no telemetry caller gets `upstream.unsent` from doctor. `kanon init --json` without telemetry offers no sent option. **Mutation:** the evidence question's text without "third-party decision provider" fails the skills test. |
| **F2a** | Kanon | **The `upstream-finding` skill** (§4.1): `skills/upstream-finding/SKILL.md`, and the line in each lane's prompt that sends the agent to it before it writes level-2 evidence. | The Overseer's and the telemetry Explorer's lane tests find the skill's path in their prompt, and the skill's file exists in the tree. **Mutations:** removing either prompt's line fails its lane test; a skill without one of the template's five parts, or without the hard rules or the self-check, fails `tests/unit/skills.test.ts`. |
| **F3** | Kanon | **The lanes write finding rows** (§5, steps 1 and 2). The Overseer's report gains `upstream`; both filing steps build, redact, validate and upload `kanon-finding-*`, and draft what they sent. **Depends on #471** for the telemetry Explorer, merged. | With `sent`, a fixture audit with two Kanon findings uploads two rows at `codes`, and no text; with `sent with evidence`, the text in the artifact equals the draft's, placeholders included. With `drafted`, no artifact. **Mutations:** an agent `upstream.lane` outside the lane list is dropped, not sent; a report whose evidence holds the repository's own name sends `[name]`. |
| **F4** | Kanon PR; the Owner deploys | **Intake** (§5, steps 3 and 4): the collector sends `kanon-finding-*` under the record's level, and the function accepts `finding` from writers, with the sender's name hashes written by `render.mjs`. `verify.mjs` gains finding cases. | The Owner's `verify` run: a valid `test` finding gets 200 and lands in `<key>#finding`; one with a URL in `evidence` gets 422 naming `evidence (url)`; one holding a registered key gets 422; the importer role sending one gets 422; the aggregate function's answer is unchanged by a stored finding; erasure of a key with a stored finding leaves `<key>#finding` empty. **Mutation:** dropping `finding` from `PARTITIONS` leaves the finding, and the erase test fails. **Mutation:** a record turned from `sent with evidence` to `sent` sends the next sweep's level-2 artifact without its text. |
| **F5** | The Owner's private operations repository (the #41 job), with Kanon's `kanon-findings.mjs` | **Private filing** (§6). Waits for plan 0002's S10 job to be running. | A seeded `test` finding with a signal's signature updates that signal's private issue and doesn't file a second; a second finding with the same signature adds to it. A finding whose `kanon_paths` entry isn't in its release's tree is filed with `gate: failed`. |
| **F6** | Kanon | **`jev.mjs`** (§7.3), pure, with recorded fixtures; no test reaches the network. | **Mutations:** each fail-closed case of §7.3 (an error, a timeout, a 500, a malformed body, Choice `unclear`, Noul not affirmed, a confidence of 0.89, no confidence) returns `keep`; removing any one of those checks fails its test; a request built from a finding holding a key throws before `fetch` is called. |
| **F7** | The private job; the Owner adds the secret | **Shadow** (§7.4). The Owner approves Jev's cost first (`K-OBS-9`, decision 22). | Each gated private finding carries a `jev:*` label and a ledger line. Without `TYPESAFE_API_KEY`, the run is green, warns, and calls nothing. With the variable at `auto` and a short ledger, the job refuses and says how many agreeing calls it has. |
| **F8** | Kanon, run on the private ledger | **Measure Jev's calibration.** `scripts/telemetry/jev-calibration.mjs` reads the ledger and prints the calls the Owner decided, the agreement count, the 2×2 table of Jev's call against the Owner's, the agreement rate with a 95% Wilson interval (`K-OBS-14`), and the agreement at each confidence step from 0.5 to 0.95, which shows how the decided threshold of 0.90 holds. It prints counts and codes only. | A fixture ledger of 30 agreeing calls then one disagreement reports a run of 0 and 30 agreements of 31. **Mutation:** dropping the reset on disagreement reports 30, and the test fails. Its output is what F9 waits for: 30 consecutive agreeing calls at 0.90 (decision 20). |
| **F9** | The private job | **Autonomy**, once F8's report shows 30 consecutive agreeing calls at 0.90. No per-run cap on promotions. | The job in `auto` promotes a seeded `test` finding that Jev calls a Kanon bug above the threshold, with an issue holding §7.6's fields only; a promoted issue the Owner closes as not a Kanon bug puts the job back in shadow on its next run. **Mutations:** a change of the model behind `jev-latest` leaves the job in `auto`; four promotable findings in one run file four issues. |

**Why this order.**
- **The data boundary is built before anything is sent.** F1 makes a row with text outside the scrub unstorable, and F4 checks it again where the adopter can't reach.
- **Private before public.** F5 files everything privately before Jev exists in the job, so the Owner sees what arrives before any of it can become public.
- **Measured before trusted.** F7 and F8 run before F9, and F9 is refused in code until F8's numbers are met.

## 9. Cost

- **Kanon's store:** a finding row is a few KB, and a run writes at most twenty. Against plan 0002's measured $0.05 a month, findings add nothing measurable. No new schedule: the collector's hourly sweep already exists, and the #41 job's schedule is the Owner's.
- **Jev:** one call per new signature with a finding, not per finding or per run. TypeSafe's price per call is not known to this plan, so F7 waits for the Owner's approval of the cost (`K-OBS-9`), and the private job's summary counts the calls per run.
- **The adopter:** nothing new. The filing job already runs, and the collector already sweeps.

## Out of scope

- **Filing on Kanon from another repository,** in any form, by any repository, including the Owner's own (Owner decisions 1 and 4).
- **Publishing evidence text.** A public issue holds codes only (§7.6). Publishing text would need another amendment to ADR 0007 and another install question.
- **Jev deciding whether a finding is safe,** or anything other than promotion (Owner decision 6).
- **Other lanes' findings.** Only the Overseer and the telemetry Explorer have upstream findings today. Another lane that gains them joins `reporter`'s enum in a later version.
- **Findings from the adopter's own content,** a QA store's run reports, coverage or ledgers (`K-OBS-17`). Those stay in the adopter's account.

## Owner decisions (2026-10-07)

1. to 7. **Decided by the Owner on #481** (§0).
8. **The finding row** (§2.1): a third row kind, `finding` version 1, with the fields above, its partition `<key>#finding`, and no title or body. Accepted with the plan.
9. **The suggested-fix categories,** a closed list: `lane-behaviour`, `guard`, `rule-text`, `documentation`, `codes-or-schema`, `default-value`, `permissions`, `other`. Accepted as proposed.
10. **The sizes** (§2.2): `evidence` at most 2,000 characters and `suggested_fix` at most 1,000, after the scrub; at most 10 rule ids, 10 Kanon paths and 20 findings per run. Accepted as proposed.
11. **Retention** (§2.3): 13 months, as a run row, evidence included, erasable on request. Accepted as proposed.
12. **The signature of a finding with no lane, stage, error or reason** (§2.4) appends its sorted rule ids and Kanon paths; every other finding's signature is the signal's. Accepted as proposed.
13. **A sent finding is also drafted locally** (§3.1), showing exactly what left, marked "sent to Kanon". Accepted as proposed.
14. **The install questions** (§3.2): one for where findings go, `Drafted` recommended, and a second, asked only after `Sent to Kanon`, for the evidence, `Codes only` recommended, with the wording above; the flag `--upstream-findings drafted|filed-here|sent|sent-with-evidence`. Accepted as proposed.
15. **Extract, don't redact; the scrub as a backstop** (§4). **Decided by the Owner, 2026-10-07, on the review of this plan:** level-2 evidence is written by the lane for a Kanon maintainer from the shared `upstream-finding` skill (§4.1): a fixed template (Expected, Observed, Where, Reproduce, Suggested fix), hard rules (no people, logins, personal names, repository names, URLs, non-Kanon paths or quotes of adopter text; roles instead), and a self-check that sends codes only when it can't comply. The deterministic scrub (§4.2) stays after it, redacting in the lane and verifying at intake and in the job, with its name context widened to the logins the lane can see. **When the lane's scrub fails, the finding is sent as codes only,** and the adopter's local draft says the text was withheld and why (accepted as proposed). Level-2 text may rarely still contain personal data, and the level-2 install question says so.
16. **Intake through the filing job, an artifact and the collector** (§5), the collector re-reading the record's level before each send. Accepted with the plan.
17. **The job's extension** (§6), its logic public in `kanon-findings.mjs`. Accepted with the plan.
18. **The promotion design** (§7): the gate, the two questions, failing closed, shadow, the ledger, and consecutive agreement, any disagreement resetting the count. **Changed by the Owner:** the only rule that sends Jev back to shadow is a promoted issue the Owner closes as not a Kanon bug. A change of the model behind `jev-latest` does not, and is not a fail-closed case.
19. **No cap on promotions per run.** **Changed by the Owner** from the proposed three a run.
20. **The numbers:** **30 consecutive agreeing calls** before `auto`, any disagreement resetting the count, and **a confidence threshold of 0.90 on both answers**. Accepted as proposed. F8 measures against them.
21. **Public issues carry codes only** (§7.6): the evidence and suggested fix go only to the Owner and to TypeSafe. Accepted as proposed.
22. **Open: Jev's cost.** The gate stands as proposed: the Owner approves the measured cost before F7 (`K-OBS-9`).
