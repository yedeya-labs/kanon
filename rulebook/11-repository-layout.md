# 11 Repository layout

This chapter fixes every path and every machine-read format that Kanon's guards, lanes and scripts depend on. `K-PRIN-1` promises that every adopter uses the same document paths, because guards find what they check by scanning for fixed literals. A path or a format that isn't written down gets invented by each adopter, and the first real guard then rejects what they invented. So nothing here is a suggestion: an adopter uses these paths and these spellings exactly, and a guard that reads one of them keeps working, unmodified, on every project.

What a file *contains* is still the project's (its specs, its signals, its escalation paths). What is fixed is where the file lives and the shape its content takes ([ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md)).

## Paths

### `K-LAYOUT-1` Kanon's paths are fixed

**Rule.** Every adopter keeps Kanon's files at exactly these paths:

| Path | What | Rules |
|---|---|---|
| `AGENTS.md`, `CLAUDE.md`, `.claude/` | The agent instruction files | `K-LAYOUT-9` |
| `docs/projects/<n>.md` | A project brief, named by its tracking issue number | `K-PROJ-2` |
| `docs/projects/_template.md` | The brief template, copied unchanged from Kanon | `K-LAYOUT-11` |
| `docs/qa/specs/<area>.md` | The spec corpus, one file per area | `K-LAYOUT-2` |
| `docs/qa/specs/_id-registry.json` | The spec-id registry: high-water marks and renumbers | `K-LAYOUT-3` |
| `docs/qa/specs/_locked-floor.json` | The locked set | `K-LAYOUT-4` |
| `docs/observability.md` | The observability document | `K-LAYOUT-5` |
| `docs/qa/agent-identities.md` | The App register | `K-LAYOUT-6` |
| `docs/qa/capability-ledger.md` | The capability ledger | `K-LAYOUT-7` |
| `docs/qa/escalation-paths.md` | The escalation paths and the bail list | `K-LAYOUT-8` |
| `docs/qa/adoption.md` | The adoption record | `K-LAYOUT-10` |
| `docs/qa/sign-off-delegation.md` | The sign-off delegation, when the adopter records one | `K-LAYOUT-14` |
| `.github/dependabot.yml` | Holds the entry that proposes Kanon upgrades | `K-ADOPT-11` |

Every markdown file directly inside `docs/qa/` is pipeline governance: changing one changes what an agent does or what a merge requires, so it is on the pipeline's own escalation path (`K-MERGE-4`). Files under `docs/qa/specs/` are not: specs are a project's deliverable (`K-MERGE-4`).

**Why.** A guard can only fail on a file it knows how to find. Paths chosen per project would each need a setting to tell the guard where to look, and a setting is what [ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md) rules out. Grouping the governance files in one directory also makes the escalation rule a single path pattern instead of a list.

**Enforced by.** Prose only until Kanon's guards are installed; each guard then reads its file at this path and fails when it is missing.

**Class.** framework

## Specs

### `K-LAYOUT-2` A spec file declares its area prefix, and every clause has one shape

**Rule.** Each spec area is one markdown file in `docs/qa/specs/`. Its preamble (everything before the first `##` heading) states the area and declares its id prefix on a line of its own:

```text
**Id prefix:** `KIOSK`
```

A prefix is uppercase ASCII letters only, and unique across the corpus. The preamble may carry a legend of the maturity tags; nothing before the first `##` heading is ever read as a clause.

A clause is one line, starting at column zero or after a single `-` or `*` bullet, in exactly this order: the id in backticks, then the maturity tag in backticks, then the text.

```text
`[KIOSK-7]` `[structural]` Checking a student in twice records one check-in.
- `[KIOSK-8]` `[seed]` Undoing a check-in removes exactly that session's record.
```

The maturity tags are `[seed]`, `[confirmed]`, `[structural]` and `[retired]` (`K-SPEC-8`). A retired clause keeps its line and its id, tagged `[retired]`, so its id is never reused. A line inside a fenced code block is never a clause. Any other line that *looks* like a clause (a numbered item, a `+` bullet or a blockquote leading with a tag) is refused by the spec guard rather than silently skipped: rewrite it in one of the two shapes above.

**Why.** Three tools (the allocator, the coverage report and the spec guard) have to agree on what a clause is, or the scheme is decorative. A legend line is shaped exactly like a clause, which is why position, not punctuation, separates them. A clause-shaped line the parser can't read is otherwise indistinguishable from a clause that doesn't exist.

**Enforced by.** The spec guard (`K-SPEC-2`).

**Class.** framework

### `K-LAYOUT-3` The id registry is one JSON object of high-water marks and renumbers

**Rule.** `docs/qa/specs/_id-registry.json` is a JSON object. Each key is an area prefix and its value is that area's high-water mark: the highest number ever allocated, never lowered. The one other key, `renumbered`, maps each forced renumber from the old id to an object naming the new id and the PR that made the move:

```json
{
  "KIOSK": 35,
  "PAY": 19,
  "renumbered": {
    "PAY-12": { "to": "PAY-14", "by": 318 }
  }
}
```

A new repository starts with `{}`. The allocator is the only writer of high-water marks (`K-SPEC-3`); the `renumbered` entry is written by whoever resolves the collision, in the same change.

**Why.** A high-water mark, not the current maximum, is what stops a deleted last clause from freeing its number. The renumber record is the only trail by which a reference written against an old number can be found.

**Enforced by.** The spec guard and the allocator's unit test (`K-SPEC-2`, `K-SPEC-3`).

**Class.** framework

### `K-LAYOUT-4` The locked set is a generated, sorted list of ids, and tests cite ids in their titles

**Rule.** `docs/qa/specs/_locked-floor.json` is a JSON object with one key, `locked`, holding the sorted list of every id that a test currently names in its title:

```json
{ "locked": ["KIOSK-1", "KIOSK-7", "PAY-3"] }
```

It is generated by the coverage tool from the tree, never edited by hand, and the diff is what a reviewer acknowledges. A new repository starts with `{ "locked": [] }`.

A test declares what it locks by carrying the id, in the form `[KIOSK-7]`, in its title. A clause that can never be locked says so in its own text with the phrase "deliberately not migrating to Locked", and is reported in the *Declared unlockable* tier (`K-SPEC-7`).

**Why.** A set of ids, rather than a count, names which lock was lost, and two PRs locking different clauses add different lines, so they merge without conflict. A test title is the only thing the coverage and verification tools read (`K-SPEC-6`).

**Enforced by.** The locked-set ratchet (`K-SPEC-7`).

**Class.** framework

## Governance documents

### `K-LAYOUT-5` The observability document has fixed anchors for its three tables

**Rule.** `docs/observability.md` is the one home for what each signal means (`K-OBS-2`). It holds three tables, each between a pair of HTML-comment anchor lines that guards find it by:

| Table | Anchors | Columns |
|---|---|---|
| Paged signals | `<!-- paging-clauses:table -->` and `<!-- /paging-clauses:table -->` | Signal, what it means, threshold, what a person does |
| Not-paged signals | `<!-- not-paged-table -->` and `<!-- /not-paged-table -->` | Signal, why it does not page, what would change the answer |
| Hand-created resources | `<!-- hand-created:table -->` and `<!-- /hand-created:table -->` | Resource, state, verified |

In the not-paged table, a signal name leads its row, in backticks. In the hand-created table, the state is either `not yet created` followed by the tracking issue, or `created YYYY-MM-DD`; the verified column is `configuration`, `delivery` or `no` (`K-OBS-8`). Each anchor appears exactly once; a guard throws, rather than guessing, when an anchor is missing or doubled.

The admission rule is not restated in this document. It lives in `K-OBS-4`, and the document points to it.

**Why.** A guard that checks a document's claim has to find the claim exactly and fail when it can't (`K-SELF-7`). Headings get renumbered and reworded; an anchor pair doesn't. The admission rule has one home already, and a copy of it here would be a second one (`K-PRIN-2`).

**Enforced by.** The signal-disposition guard and the paging parity test (`K-OBS-2`, `K-OBS-3`), and the hand-created-resource check (`K-OBS-8`).

**Class.** split. The path, the anchors and the columns are framework. **The project supplies:** its signals, its alerting stack, and any further stack-specific sections.

### `K-LAYOUT-6` The App register is one table, with reasons as footnotes

**Rule.** `docs/qa/agent-identities.md` holds one table with a row per GitHub App installed on the repository, agent or not: the role, the App's slug exactly as GitHub derives it, and its permission on Contents, Issues, Pull requests, Workflows and Actions, plus any other permission it holds. Every permission broader than the roles table gives (`K-ADOPT-8`) carries a numbered footnote below the table saying why it was granted and what bounds its use (`K-AGENT-3`). A repository with no Apps yet says "none installed".

**Why.** The slug, not the display name, is what code compares (`K-AGENT-5`), so the register records the slug. A permission with no recorded reason is indistinguishable from drift.

**Enforced by.** Prose only; the run-time slug and scope checks (`K-AGENT-5`) turn the parts the code depends on into failures.

**Class.** framework

### `K-LAYOUT-7` The capability ledger has fixed columns, a fixed disposition vocabulary and a bare watermark

**Rule.** `docs/qa/capability-ledger.md` holds tables with these columns: **Capability**, **What it's for**, **CI?**, **Status here**, **Disposition**. A disposition is one of: `pending — first sighting`, `open #<n>`, `adopted`, `no current gap`, `rejected — <reason>`, `deferred — <reason>`. The ledger carries the last reviewed agent-runtime version as a bare line, alone in a fenced block, in exactly this form:

```text
Watermark: <version>
```

**Why.** The weekly review reads the dispositions (`K-SELF-16`) and the watermark (`K-SELF-17`) by exact match. A decorated watermark matches nothing and orphans every later run.

**Enforced by.** The watermark reader's exact-line match; the rest is prose only.

**Class.** framework

### `K-LAYOUT-8` The escalation paths and the bail list have one home

**Rule.** `docs/qa/escalation-paths.md` holds both project-supplied lists that decide when a human is needed, under two fixed headings:

- `## Escalation paths`: one bullet per path pattern, as a regular expression over repository-relative paths in backticks, then an em dash, then the reason. The Merger escalates any PR touching a match (`K-MERGE-4`).
- `## Bail list`: one bullet per kind of change the Implementer stops on and hands off with a plan (`K-AGENT-13`).

The pipeline's own paths escalate whatever the list says (`K-MERGE-4`), so the file lists only the project's high-risk paths. It must be filled in before the first brief is written, because a brief's blast-radius section names the items it touches (`K-PROJ-6`). The file is itself on the escalation path (`K-LAYOUT-1`).

**Why.** A list with no fixed home gets invented inside each brief that needs it, so every brief carries its own version. The two lists answer one question ("does this need a human?") from two sides, so they share a file.

**Enforced by.** Prose only until the Merger is installed; its verdict function then reads this file.

**Class.** split. The path, headings and bullet format are framework. **The project supplies:** the paths and the bail items.

### `K-LAYOUT-9` The agent instruction files carry only the project's content

**Rule.** The agent instruction files are `AGENTS.md` at the repository root (the project's own instructions), `CLAUDE.md` at the root containing the line `@AGENTS.md`, and the `.claude/` directory. They carry what is specific to the project: its stack, its commands, its landmines. They point to Kanon for Kanon's rules and never copy them (`K-ADOPT-10`). A lane that judges a PR reads them from the default branch, with the rest of `K-MERGE-17`'s list.

**Why.** A PR must not be able to rewrite the instructions of the agent that judges it. One root file named for each runtime, with one including the other, keeps a single home for the project's instructions.

**Enforced by.** The review lane's restore step, which reads them from the default branch with the rest of `K-MERGE-17`'s list (`K-AGENT-22`).

**Class.** split. The paths and the restore are framework. **The project supplies:** the content of `AGENTS.md` and `.claude/`.

### `K-LAYOUT-10` The adoption record says what state the repository is in

**Rule.** `docs/qa/adoption.md` records, under these headings:

- `## People`: who holds the Owner, Maintainer and Stakeholder roles;
- `## Plan`: the GitHub plan, and which fallbacks of `K-ADOPT-3` are in use;
- `## Bootstrap`: `in bootstrap since YYYY-MM-DD`, or `ended YYYY-MM-DD`, and every bootstrap exception (`K-ADOPT-5`);
- `## Mechanisms`: every mechanism the rulebook names, each `installed YYYY-MM-DD` or `not yet installed` (`K-ADOPT-9`);
- `## Choices`: the project's own decisions that Kanon leaves to it, such as its chat channel.

**Why.** Bootstrap, the plan's fallbacks and the installed mechanisms change what the rest of the rulebook means on this repository. If they aren't written down in one place, every reader has to reconstruct them.

**Enforced by.** Prose only; a guard is planned (`K-ADOPT-6`).

**Class.** framework

### `K-LAYOUT-14` The sign-off delegation names one person, one email and one date

**Rule.** An adopter that delegates sign-off for its own agents (`K-AGENT-44`) records it in `docs/qa/sign-off-delegation.md`, which holds exactly one table, outside any fenced block, with this header and exactly one row:

```markdown
| Delegate | Email | Delegated on |
|---|---|---|
| Ada Lovelace | ada@example.com | 2026-10-02 |
```

The name and email are the person's, written exactly as their sign-off writes them: the name matches exactly and the email ignoring case. The date is `YYYY-MM-DD`. Prose may surround the table, such as the delegation's wording. The delegate is a person: a name or email that marks an AI or a bot (an `anthropic.com` address, or `[bot]`) makes the record malformed. A repository that delegates nothing has no file.

**Why.** The `dco` check reads the record to decide what an agent's commit needs, so its shape has to be something a machine reads one way. One table, one row, one date leaves nothing to interpret: two delegates, a missing date or a free-text email are each a malformed record, not a guess. A malformed record delegates nothing, so a mistake in it fails an agent's commits rather than passing them.

**Enforced by.** The [`dco` action](../actions/dco/README.md)'s parser, which reports a malformed record by name and then treats it as absent; [`tests/unit/dco.test.ts`](../tests/unit/dco.test.ts) pins each malformed shape.

**Class.** framework

## The brief

### `K-LAYOUT-11` The brief template ships with Kanon

**Rule.** Kanon ships the brief template at [`rulebook/templates/brief.md`](templates/brief.md). An adopter copies it unchanged to `docs/projects/_template.md`, and replaces it when Kanon's template changes. A brief starts as a copy of it, saved as `docs/projects/<n>.md`.

**Why.** The template is held to the standard it teaches: the brief guard runs against it (`K-PRIN-11`). A template each adopter writes for itself is a template no guard has run against.

**Enforced by.** The brief guard's template test (`K-PROJ-4`).

**Class.** framework

### `K-LAYOUT-12` A brief's decomposition has one machine-read syntax

**Rule.** The decomposition is the only part of a brief a machine files from, and its syntax is fixed:

- **The heading** is `## Decomposition`, optionally numbered (`## 3. Decomposition`), and nothing else on the line. It ends at the next heading of the same or a higher level.
- **Each item** is a `###` heading: `### Issue <KEY> — <title>`, where `<KEY>` is uppercase letters or digits (`A`, `B`, `C1`) and the separator is an em dash, an en dash or a hyphen, with spaces around it.
- **The metadata line** is the first line under the item heading:

  ```text
  **Milestone:** Product Backlog · **Labels:** `enhancement` · `sev:high` · **Closes #12**
  ```

  `**Milestone:**` is required and names a milestone chosen by chapter 01's routing rules. `**Labels:**` lists labels in backticks, separated by `·`, with no prose between them. `**Closes #<n>**` appears only when the item adopts an existing issue, and is read only from this line.
- **Dependencies** go on their own line, `**Depends on:** Issue A (reason), Issue B`. Only the leading run of `Issue <KEY>` references counts; a parenthetical reason is allowed after each; prose after the last reference cites nothing. Every key must be declared in the same decomposition, and the graph must be acyclic.
- **A human-action item** carries the label `qa:human-action` on its metadata line (`K-PROJ-9`).
- **Acceptance criteria** are bullets, each led by one spec id in backticks: `` - `[KIOSK-7]` — … `` (`K-SPEC-5`).
- **A measurement item** replaces its acceptance criteria with bullets of the form `` - **Measures:** <quantity> — `<command>` `` (`K-PROJ-16`).
- Everything under the item except its metadata and dependency lines is filed verbatim as the issue's body.
- **The project marker.** The Lead ends every issue it files for project `<n>` with the line `<!-- qa:project <n> -->` as the body's **last** line, and mirrors it with the label `project:<n>`, which only the Lead writes (`K-PROJ-9`).

**Why.** Each of these is a place where the parser once read a brief differently from its author and failed quietly: a heading with a summary read as no decomposition, a label run with prose in it filed an issue with no labels, a closing reference in body prose filed a duplicate, and a dependency separated by the wrong punctuation was dropped, which made an item look ready before its prerequisite had landed. A fixed syntax, written down, is what lets an author get it right without reading the parser.

**Enforced by.** The brief guard, which parses the decomposition the same way the reconciler does (`K-PROJ-9`).

**Class.** framework

### `K-LAYOUT-13` A brief's sections and decisions have fixed minimums and a fixed vocabulary

**Rule.**

- **Sections.** Each of the eight sections of `K-PROJ-4` is a `##` heading that contains its key phrase: *real problem* (or *the measurement*), *scope*, *decomposition*, *cost*, *observability*, *blast radius*, *decisions* (plural, leading the heading), and *did not examine* (or *not examined*). One heading may carry two phrases when the two sections are one story. Each section's body holds at least **200 characters**.
- **The cost section** contains a figure (a currency sign followed by a digit) or the phrase `no delta` in any case, with its reason (`K-PROJ-6`).
- **The observability section** states a decision with one of the words *add*, *skip*, *page*, *none needed* or *nothing*, in any case and any inflection (`K-OBS-1`).
- **A decision** is a numbered item whose headline is bold, at column zero: `1. **Headline.**` or `**1. Headline.**`. Only the bold headline is read.
- **Answered** is `✅` or `ANSWERED` in the headline, followed by who answered (`K-PROJ-18`) and what was chosen: `1. **Which store? ✅ ANSWERED (Owner): the existing one, because…**`.
- **Open** is any of `⛔`, `OPEN`, `PROPOSED`, `TBD`, `UNANSWERED`, `awaiting the Owner`, `awaiting the Maintainer` or `awaiting the Stakeholder` in the headline. The uppercase words are case-sensitive, so the same words in lowercase are ordinary prose, and `OPEN` followed by a hyphen (`OPEN-ENDED`) is not a mark. A headline with an open mark and no answered mark blocks the merge (`K-PROJ-5`).

**Why.** "Answered" and "open" have to be words a guard can read, and an author has to know which words those are before the guard exists. The Owner answers the most common kind of decision (spend), so an open vocabulary that names only the Maintainer and the Stakeholder can't mark it open. The minimum length catches a heading with nothing under it, which reads exactly like a section with nothing to say.

**Enforced by.** The brief guard (`K-PROJ-4`, `K-PROJ-5`).

**Class.** framework
