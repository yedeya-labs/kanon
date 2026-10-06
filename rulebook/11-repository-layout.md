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
| `docs/qa/escalation-paths.md` | The escalation paths, the pipeline code and the bail list | `K-LAYOUT-8` |
| `docs/qa/adoption.md` | The adoption record | `K-LAYOUT-10` |
| `docs/qa/sign-off-delegation.md` | The sign-off delegation, when the adopter records one | `K-LAYOUT-14` |
| `docs/qa/exemptions.md` | What a guard exempts by name: pre-standard briefs and path mentions | `K-LAYOUT-15` |
| `docs/qa/test-database.md` | The test-database declaration, when the lanes need a database | `K-LAYOUT-16` |
| `.github/actions/qa-store/action.yml` | The QA store hook, when the adopter runs a store | `K-OBS-17` |
| `docs/qa/stack.md` | The stack document: the project's gates, schema procedure, isolation rules and generated files | `K-LAYOUT-17` |
| `docs/qa/triage-fix-playbook.md`, `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md`, `docs/qa/lead-playbook.md` | The Implementer's, Reviewer's, Explorer's and Lead's playbooks | `K-LAYOUT-17` |
| `docs/qa/overseer-playbook.md` | The Overseer's playbook, when the adopter installs the Overseer | `K-LAYOUT-17` |
| `.agent/starting-map.md` | The starting map the project-setup hook writes for an issue (`K-AGENT-41`) | `K-LAYOUT-17` |
| `.github/dependabot.yml` | Holds the entry that proposes Kanon upgrades | `K-ADOPT-11` |
| `.github/workflows/agent-<lane>.yml` | Each lane's caller, at the lane's own file name | `K-LAYOUT-18` |
| `.github/workflows/ci.yml` | The project's CI, when it runs the review lane or the reconciler | `K-LAYOUT-18` |

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

**Rule.** `docs/qa/agent-identities.md` holds one table with a row per role that runs under a GitHub App installed on the repository, agent or not: the role, the slug of the App it runs under exactly as GitHub derives it, and that App's permission on Contents, Issues, Pull requests, Workflows and Actions, plus any other permission it holds. An optional `Persona` column gives an agent role the display name its posts open with and its agent's commits are authored under (`K-AGENT-1`); a blank cell, or no column, means the role's own name. A persona is a letter followed by letters, digits, spaces and `.'-`, at most 40 characters, and never another role's name. Roles that share an App share its slug: the Author's four rows name one slug, the Judge's two rows another, and the Releaser's row a third, and no two of the three Apps share a slug. Every permission broader than its roles' rows give (`K-ADOPT-8`) carries a numbered footnote below the table saying why it was granted and what bounds its use (`K-AGENT-3`). A repository with no Apps yet says "none installed".

**Why.** The slug, not the display name, is what code compares (`K-AGENT-5`), so the register records the slug, and a persona is only ever displayed: no check reads it. A row per role keeps every reader that maps a role to a login working, and still says which role each App plays. An Author and a Judge sharing a slug would be one identity approving its own work (`K-PRIN-5`), and a Releaser sharing one would make its bypass another role's. A permission with no recorded reason is indistinguishable from drift.

**Enforced by.** Prose only; the run-time slug and scope checks (`K-AGENT-5`) turn the parts the code depends on into failures. `lane-check` fails a malformed `Persona` column by name (`parsePersonas` in [`scripts/app-register.mjs`](../scripts/app-register.mjs)). `lane-check` fails a register whose Author roles name more than one slug, whose Judge roles name more than one, or in which two of the three Apps share one (step L4 of [plan 0005](../docs/plans/0005-lean-installation.md); `appShape` and `parseAppRegister` in [`scripts/app-register.mjs`](../scripts/app-register.mjs)), and the lanes refuse, at run time, a register in which two of the Apps share a slug.

**Class.** framework

### `K-LAYOUT-7` The capability ledger has fixed columns, a fixed disposition vocabulary and a bare watermark

**Rule.** `docs/qa/capability-ledger.md` holds tables with these columns: **Capability**, **What it's for**, **CI?**, **Status here**, **Disposition**. A disposition is one of: `pending — first sighting`, `open #<n>`, `adopted`, `no current gap`, `rejected — <reason>`, `deferred — <reason>`. The ledger carries the last reviewed agent-runtime version as a bare line, alone in a fenced block, in exactly this form:

```text
Watermark: <version>
```

**Why.** The weekly review reads the dispositions (`K-SELF-16`) and the watermark (`K-SELF-17`) by exact match. A decorated watermark matches nothing and orphans every later run.

**Enforced by.** The watermark reader's exact-line match; the rest is prose only.

**Class.** framework

### `K-LAYOUT-8` The escalation paths, the pipeline code and the bail list have one home

**Rule.** `docs/qa/escalation-paths.md` holds the project-supplied lists that decide when a human is needed, under three fixed headings, each optional:

- `## Escalation paths`: one bullet per path pattern: a regular expression over repository-relative paths in backticks, then optionally its **category** in backticks, then an em dash, then the reason. A pattern written `/…/i` matches regardless of case. The Merger escalates any PR touching a match (`K-MERGE-4`). The category is one of Kanon's closed list, `pipeline`, `playbooks`, `infra`, `migrations`, `schema`, `payments`, `auth` or `other`, and an entry that names none is `other`. It is what the work-item telemetry reports about the paths a PR touched, as one boolean per category, so the patterns and paths themselves never leave the repository ([plan 0003](../docs/plans/0003-metrics.md) §3.7). The pipeline's own paths carry `pipeline` or `playbooks`, and pipeline code is always `pipeline`, so its bullets name none.
- `## Pipeline code`: one bullet per directory holding the project's own pipeline scripts, as a repository-relative path ending in `/` in backticks, then an em dash, then the reason. These escalate as the pipeline itself does (`K-MERGE-4`). The label guard reads them for labels the pipeline applies, and `citation-shift` doesn't read their comments as claims about the code, because a guard's comments quote old coordinates on purpose. A test that imports from one of them is a test of the pipeline, whose spec ids are fixtures: `spec-coverage` and the renumber check don't count them as coverage or as references, and `citation-shift` doesn't read its comments either.
- `## Bail list`: one bullet per kind of change the Implementer stops on and hands off with a plan (`K-AGENT-13`).

```markdown
## Escalation paths

- `^migrations/` `migrations` — database migrations
- `/^src/.*payments?/i` `payments` — payments

## Pipeline code

- `scripts/pipeline/` — the project's own pipeline scripts
```

The pipeline's own paths escalate whatever the file says: every file under `.github/`, every markdown file directly inside `docs/qa/`, and the agent instructions and configuration, `AGENTS.md`, `CLAUDE.md` and `.claude/` (`K-MERGE-4`). So the file lists only what Kanon can't know: the project's high-risk paths and where it keeps its own pipeline code. Prose may sit between the bullets. A section with no bullets says the project has none. **Without the file, or without a section, Kanon's default applies: the project declares nothing there, so only the pipeline's own paths escalate** ([plan 0005](../docs/plans/0005-lean-installation.md) §5.2), and every reader says so, in one line, each time it takes the default. A heading appears at most once outside a fenced block. Each entry is a `- ` bullet at the start of its line. A doubled heading, a bullet that isn't an entry, a list item in any other form (indented, `+`, numbered or inside a blockquote), a pattern that isn't a regular expression, begins with `/` without being `/…/` or `/…/i`, or carries a flag other than `i`, a category outside Kanon's list or on pipeline code, and a directory that isn't one plain directory each fail by name, with the file and the line, rather than being read as an empty list.

A project with high-risk paths of its own declares them before the first brief is written, because a brief's blast-radius section names the items it touches (`K-PROJ-6`). The file is itself on the escalation path (`K-LAYOUT-1`), so a pull request that changes it goes to a human. The Merger, which judges a pull request, reads it from the default branch (`K-MERGE-17`); a check that runs on a pull request reads the pull request's copy, and a change to it is what that human reviews.

**Why.** A list with no fixed home gets invented inside each brief that needs it, so every brief carries its own version. The lists answer one question ("does this need a human?") from different sides, so they share a file. Until it existed, the library carried one project's answers as constants: its migrations directory, its infrastructure file and its pipeline scripts directory escalated on every repository, and the guards looked for labels and skipped comments in a directory most projects don't have. The category sits on the entry because only the project knows what each of its paths is, and Kanon fixes the list so that what leaves the repository is a few booleans, never the project's own words (plan 0003 decision 14).

**Enforced by.** The parser in [`scripts/lib/escalation-paths.mjs`](../scripts/lib/escalation-paths.mjs), which every reader shares: the Merger's verdict ([`scripts/merge-gate.mjs`](../scripts/merge-gate.mjs)), which reads the file from the default branch, and the label guard, `citation-shift`, `spec-coverage`, the renumber check and `/ship`'s local review scope, which read the checked-out tree. [`tests/library/escalation-paths.test.ts`](../tests/library/escalation-paths.test.ts) pins each malformed shape, the default and the line that names it, and the default-branch read, and [`tests/library/pipeline-code-imports.test.ts`](../tests/library/pipeline-code-imports.test.ts) pins the tooling-test exclusion and that `spec-coverage` and the renumber check read no file as the default and say so. [`tests/unit/adopter-literals.test.ts`](../tests/unit/adopter-literals.test.ts) fails when the reference adopter's pipeline directory, or another of its facts, reappears in the library's code. [`tests/unit/telemetry-schema.test.ts`](../tests/unit/telemetry-schema.test.ts) holds the telemetry schema's `esc_*` fields to the parser's category list.

**Class.** split. The path, headings, bullet formats and the category list are framework. **The project supplies:** the paths and each one's category, the pipeline code and the bail items.

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
- `## Choices`: the project's own decisions that Kanon leaves to it, such as its chat channel, its reference environment (`K-PROJ-11`), and whether its production promotion is human-gated (`K-MERGE-4`).

The reference environment is declared under `## Choices` in three bullets, each a `- ` at the start of its line, its bold label, and its value as one code span with nothing after it:

```markdown
- **Reference environment:** `staging`
- **Reference deploy workflow:** `deploy-staging.yml`
- **Reference deploy job:** `deploy`
```

The environment is the name the project gives it. The workflow is the file name, in `.github/workflows/`, of the workflow that deploys there. The job is the name of the job whose success is the deploy, exactly as a run of that workflow lists it: its `name:`, or its key when it has none. A record declares all three or none of them. A record with none declares no reference environment, and then no project can close (`K-PROJ-11`). A record with some of them, one of them twice, one in another shape or outside `## Choices`, or a workflow that isn't a file name, is malformed.

Whether the Overseer is installed is declared under `## Choices` in one bullet, its value `installed` or `not installed` as one code span with nothing after it:

```markdown
- **Overseer:** `installed`
```

The Overseer is an optional lane (plan 0004 decision 12). `installed` means a workflow calls the Overseer's lane, and `not installed` means none does. **A record without the bullet, or no record, means Kanon's default, `not installed`** ([plan 0005](../docs/plans/0005-lean-installation.md) §5.2). A record with the bullet twice, outside `## Choices`, in another shape or with another value is malformed, and so is one whose value, declared or the default, the callers contradict.

The weekly digest's audience may be declared under `## Choices` in one bullet, the bold label and then the audience as plain text, on one line:

```markdown
- **Weekly digest audience:** a co-founder tracking runway
```

The value completes the digest prompt's sentence "The reader is …", and a trailing full stop is dropped. Without the bullet the digest is written for "a stakeholder who follows the project from outside the day-to-day work". A bullet outside `## Choices`, in another shape, written twice, empty, longer than 200 characters or holding a backtick is malformed.

A project whose production promotion is human-gated may declare it under `## Choices` in one bullet, the bold label, `human-gated`, and then in parentheses the environment or process that holds the human approval, on one line:

```markdown
- **Production promotion:** human-gated (the `production` environment's required reviewer)
```

Declared, the Merger merges a pull request on one of the project's high-risk paths in the green zone, and every other escalation still applies (`K-MERGE-4`). **A record without the bullet, or no record, means Kanon's default: not declared, and every escalation path escalates.** A bullet outside `## Choices`, in another shape or with another value, written twice, with nothing in its parentheses or more than 200 characters there is malformed.

A job of the project's own workflows that holds `id-token: write` on the default branch is accepted under `## Choices` in one bullet per job, the bold label, the workflow's file name as one code span, `job`, the job's key as one code span, and then in parentheses why it holds the grant, on one line:

```markdown
- **Accepted id-token holder:** `deploy.yml` job `deploy` (assumes the production deploy role)
```

The QA store's role and the telemetry writer trust the default branch's ref, so every such job can assume them ([`docs/qa-store.md`](../docs/qa-store.md#who-can-reach-the-store)). [`kanon doctor`](../docs/doctor.md) lists each one and fails until it is accepted here or its grant is narrowed; a caller of one of Kanon's store-coupled lanes at the pinned release needs no bullet. **A record without the bullet accepts no holder.** A bullet outside `## Choices`, in another shape, with nothing in its parentheses, or naming a job twice is malformed.

**Why.** Bootstrap, the plan's fallbacks and the installed mechanisms change what the rest of the rulebook means on this repository. If they aren't written down in one place, every reader has to reconstruct them. Without a line saying whether the optional Overseer is installed, a repository that chose not to run it reads the same as one whose Overseer was deleted by mistake. The reference environment's deploy and the weekly digest's reader are choices like the others, and the record is already where `K-PROJ-11` has the project name the environment, so a second file would be a second home for it (`K-PRIN-2`). A human-gated promotion is declared in the record for the same reason, and because the record is directly inside `docs/qa/`, so the pull request that declares it always goes to a human. The job, and not only the workflow, is declared because a workflow can conclude `success` with its deploy job skipped.

**Enforced by.** On Kanon's own record, [`tests/unit/adoption-record.test.ts`](../tests/unit/adoption-record.test.ts): it fails when a heading is missing or out of order, a role is unnamed, the bootstrap line has no date, or a mechanism is marked anything but `installed YYYY-MM-DD` or `not yet installed`. For an adopter, prose only, except the reference environment's declaration; a guard is planned (`K-ADOPT-6`). The declaration is read by the parser in [`scripts/lib/reference-deploy.mjs`](../scripts/lib/reference-deploy.mjs): the reconciler reads it from the default branch and fails by name, at a project's deploy phase, on a record that is missing, declares nothing or is malformed; [`lane-check`](../actions/lane-check/README.md) fails a malformed one on the pull request that breaks it. [`tests/library/reference-deploy.test.ts`](../tests/library/reference-deploy.test.ts) pins each malformed shape. The digest's audience is read by [`scripts/lib/digest-audience.mjs`](../scripts/lib/digest-audience.mjs): the weekly digest lane reads it from the default branch and fails by name, before its agent, on a malformed one; `lane-check` fails it on the pull request; [`tests/library/digest-audience.test.ts`](../tests/library/digest-audience.test.ts) pins each shape. Whether the Overseer is installed is read by [`scripts/lib/overseer-install.mjs`](../scripts/lib/overseer-install.mjs): `lane-check` names the default when the record doesn't say, and fails a record that is malformed or contradicts the callers, so a caller of the Overseer's lane needs a record that says `installed`; [`tests/library/overseer-install.test.ts`](../tests/library/overseer-install.test.ts) pins each shape. Whether the production promotion is human-gated is read by [`scripts/lib/production-promotion.mjs`](../scripts/lib/production-promotion.mjs): the Merger reads it from the default branch and stops its sweep by name on a malformed one (`K-MERGE-4`); `lane-check` fails it on the pull request; [`tests/library/production-promotion.test.ts`](../tests/library/production-promotion.test.ts) pins each shape. The accepted id-token holders are read by [`kanon doctor`](../cli/doctor.mjs), which fails a malformed bullet by its line and names one whose job no longer holds the grant; [`tests/unit/kanon-doctor.test.ts`](../tests/unit/kanon-doctor.test.ts) pins each shape.

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

### `K-LAYOUT-15` The exemptions file names every file a guard exempts, with its reason

**Rule.** `docs/qa/exemptions.md` holds what a guard exempts by name on this repository, under two fixed headings, each optional:

- `## Pre-standard briefs`: one bullet per brief approved before the brief standard, as its path (`docs/projects/<n>.md`) in backticks, then an em dash, then the reason. The brief guard's content rules don't run over these briefs; its shape checks still do (`K-PROJ-10`).
- `## Path mentions`: one table, with the header `| File | Path | Reason |`, and a row per mention of a path that doesn't exist on purpose: the citing file and the cited path, each in backticks, and the reason. The doc-path guard doesn't report that path in that file.

```markdown
## Pre-standard briefs

- `docs/projects/12.md` — approved before the brief standard; an immutable record

## Path mentions

| File | Path | Reason |
|---|---|---|
| `docs/history.md` | `docs/TODO.md` | names the retired TODO file, as history |
```

Prose may sit around the entries, and a section with no entries says nothing is exempt. **Without the file, or without a section, Kanon's default applies: nothing is exempt there** ([plan 0005](../docs/plans/0005-lean-installation.md) §5.2), and each guard that reads the file says so, in one line. A pre-standard brief is a `- ` bullet at the start of its line, and a path mention is a table row. A doubled heading, an entry that doesn't parse, a list item in any other form (indented, `+`, numbered or inside a blockquote, or any list item under `## Path mentions`), and an entry listed twice each fail the guard that reads the file, by name, with the file and the line. An entry that no longer matches anything (a brief that doesn't exist, a mention the file no longer makes) fails too.

**Why.** An exemption is the project's own history: which briefs predate the standard, which documents quote a path that is gone. Written into the guard, it was one project's list on every repository, and on any other one the doc-path guard failed every run on exemptions that matched nothing. Keeping it directly inside `docs/qa/` puts it on the escalation path (`K-MERGE-4`), so a pull request can't exempt itself without a human seeing the entry. Failing on a stale entry keeps the list from only ever growing, which is how a guard narrows to nothing.

**Enforced by.** The parser in [`scripts/lib/exemptions.mjs`](../scripts/lib/exemptions.mjs), read by the brief guard and the doc-path guard from the checked-out tree. [`tests/library/exemptions.test.ts`](../tests/library/exemptions.test.ts) pins each malformed shape and the default, and [`tests/unit/stack-neutral.test.ts`](../tests/unit/stack-neutral.test.ts) runs both guards on a fixture adopter with a missing, a malformed and a stale declaration.

**Class.** split. The path, the headings and the entry formats are framework. **The project supplies:** its pre-standard briefs and its path mentions.

### `K-LAYOUT-16` The test-database declaration names one kind, and no file means no database

**Rule.** A project whose lanes run tests against a database declares it in `docs/qa/test-database.md`, on one line of its own, at column zero, outside any fenced block:

```text
**Test database:** `hook`
```

The kind is one of:

- `hook`: the project-setup hook provides the database. When a lane passes it `database: 'true'`, the hook starts the database, whatever its engine, and writes its connection string to `$GITHUB_ENV` as `DATABASE_URL`.
- `none`: the project has no database. No file means the same.

Prose may surround the line. The file is malformed if it has no such line, has two, or names any other kind, an engine included. The lanes fail on a malformed file by name, rather than starting nothing.

The contract is the whole of what Kanon fixes:
- The database is ready when the project-setup hook has finished, before the agent starts.
- The lanes and their agents find it in `DATABASE_URL`.
- A lane that runs no tests (one that edits only prose) tells the hook `database: 'false'`, whatever is declared.

Kanon starts no database and names no engine, image or port.

**Why.** A database the lanes start for every project makes one project's stack every project's cost. Projects with no database paid for a container nothing used, and a project on another engine couldn't use the switch at all. So the project decides, in one file.

The Owner chose the contract over a Kanon-maintained standard database (2026-10-03). A standard, even an opt-in one, is a rule naming an engine, and Kanon is opinionated about process, never about the stack. The reference adopter's database setup is a worked example in the [`test-database`](../actions/test-database/README.md) block's README instead.

The file sits directly inside `docs/qa/`, so it is pipeline governance (`K-MERGE-4`), and the review lane reads it from the default branch (`K-MERGE-17`). So a pull request can't change the database its own review runs on.

**Enforced by.** [`lane-check`](../actions/lane-check/README.md), which fails on a malformed declaration, and the lanes' [`test-database`](../actions/test-database/README.md) block, which reads it with the same program before the hook runs.

**Class.** split. The path, the line, the kinds and the contract are framework. **The project supplies:** which kind, and, for `hook`, the database.

### `K-LAYOUT-17` The lanes read the project's stack and playbooks at fixed paths

**Rule.** A lane's prompt states the process and never the project's stack. What the stack decides, the prompt reads from a file the project owns, at a fixed path:

- **`docs/qa/stack.md`, the stack document.** It holds up to four sections, each a `##` heading exactly as written here, at most once, outside any fenced block. `## Gates` is required. Each of the other three may be left out, and then means its default ([plan 0005](../docs/plans/0005-lean-installation.md) §5.2):
  - `## Gates`: the commands an agent runs before it pushes, in order, and each further test tier with the paths that call for it. Whatever the agent should know about their output goes here too. It has no default.
  - `## Schema changes`: what to run after changing the schema, and the deploy steps a pull request states for one. Left out, the project has no schema.
  - `## Data isolation`: the rules a change must never regress, and the checks that prove they hold. The Reviewer scrutinises every pull request against this section. Left out, the project has nothing to isolate.
  - `## Generated files`: each file that is derived rather than written, such as a lockfile or a migration sequence, and how to re-derive it after a merge conflict. Left out, the project has none.

  It may hold a fifth, **`## Code areas`**, once, outside any fenced block: where the project's code is. Each entry is a bullet: a repository-relative path in backticks, an em dash, its kind, a colon, and what it holds, as in ``- `src/` — code: the application``. A `code` area is a directory of the project's own source, which `citation-shift` reads comments in and the spec-id sweeps read references in. A `tests` area is a directory of tests and their fixtures, which `doc-path-guard` doesn't read as claims and the spec-id sweeps read as tests. An `audit` area, a directory or a file, is what the code-audit lane reads first, with what to look for there. Without the section, or without an entry of a kind, Kanon's rule applies: the code is the whole repository, a test is what its language's convention calls one (`K-SPEC-6`), and the audit reads the `code` areas, or the whole repository.
- **The playbooks**: `docs/qa/triage-fix-playbook.md` (the Implementer's), `docs/qa/reviewer-playbook.md`, `docs/qa/explorer-playbook.md` and `docs/qa/lead-playbook.md`, and `docs/qa/overseer-playbook.md` when the project installs the Overseer, with the capability ledger beside it, `docs/qa/capability-ledger.md` (`K-SELF-16`). A playbook may link to the project's other documents: the review lane restores what it links to with it (`K-MERGE-17`). What a playbook says is the project's, but the prompts send the agent to some sections by name, so a playbook that a lane you run reads holds each of these as a `##` heading, exactly as written:
  - **`docs/qa/reviewer-playbook.md`**: `## Capturing follow-ups`, the filing rules for a follow-up the Reviewer files (bar, dedup, labels, severity, milestone, one-call create, body), and `## Beware your own suggested fix`, how a filed body presents a remedy the Reviewer hasn't verified. The merge-reconcile lane cuts both out before its agent starts (`K-AGENT-41`). The rest is what the Reviewer checks on this project.
  - **`docs/qa/explorer-playbook.md`**: `## Severity rubric`, what each `K-WORK-9` level looks like on this project. The Reviewer rates every follow-up with it, so a project that runs no Explorer still keeps this file. The verify-acs lane also reads its `## Targeted-invariant mode`, and the code-audit lane its `## Code-reading mode`.
  - **`docs/qa/triage-fix-playbook.md`**: `## Implementer mode`, how the Implementer builds a feature or spec-delta issue, which the implement lane sends it to first; and `## Follow-ups: branch off the open parent`, the rule for building a follow-up whose parent pull request is still open.
  - **`docs/qa/overseer-playbook.md`**: `## Liveness queries`, how to tell a run that died from one that skipped, and how to reach a renamed workflow's earlier runs (`K-SELF-12`); `## Backlog dynamics`, the queries for the follow-up and net open-issue rates; and `## Capability review`, how the weekly capability review runs on this project (`K-SELF-16`, `K-SELF-17`).

  The lead playbook has no section a prompt names by heading. The Lead reads it for the brief format it writes to (`K-LAYOUT-11` to `K-LAYOUT-13`).

  **A playbook the project leaves out is Kanon's baseline for the role**, [`rulebook/templates/playbooks/`](templates/playbooks/) at the release the project pins ([plan 0005](../docs/plans/0005-lean-installation.md) §5.2). The baseline holds every section above and says only what holds on every project, citing rules rather than restating them. A lane puts it in place before its agent starts, and the review lane before it pins its judging inputs (`K-MERGE-17`), and keeps it out of the agent's commits, so the prompt reads it at the path it names. A project writes its own to replace it, starting from a copy. The capability ledger has no default.
- **`.agent/starting-map.md`**, which the project-setup hook writes when a lane passes it an issue number (`K-AGENT-41`), and which the prompt tells the agent to read first if it exists.

The prompt names a section by its heading, and a command, a database or a setting only by the section that holds it, and a milestone only by the rule that names it (`K-WORK-4`, `K-WORK-5`, `K-WORK-10`). Kanon's own literals stay in the prompt: the buckets' names (`K-WORK-4`), Kanon's paths, and Kanon's scripts, run as `node "$KANON/scripts/<name>.mjs"`.

**Why.** A prompt written for one project's stack makes that stack every project's: a Python project's Implementer was told to run one package manager's lint script and to re-apply row-level security it doesn't have. The guards had the same problem with trees: they read one project's `src/`, `tests/` and `e2e/` on every repository. An undeclared tree is read rather than skipped, because a guard that skips a tree fails silently, and one that reads too much fails loudly on a finding the declaration then narrows. The facts were true, but they belonged to the project, so they move to a file the project owns and the prompt keeps only the process that holds on every stack. Fixed headings let the prompt send the agent to one section rather than to a whole document, and let a check tell a malformed section from a missing one. A missing section or playbook means a documented default rather than a failure, because a new project that has to write six files before its first lane runs gives up before it sees one run, and "nothing to say" is what most new projects would write anyway; the default is named in the run's output, so a project relying on it is told so every time. The files sit directly inside `docs/qa/`, so they are pipeline governance (`K-MERGE-4`), and the review lane reads them from the default branch (`K-MERGE-17`).

**Enforced by.** [`lane-check`](../actions/lane-check/README.md), which fails when the stack document or the capability ledger a called lane's prompt reads is missing, or the stack document lacks `## Gates`, repeats a section, holds a near miss of one, or holds a malformed `## Code areas`, and names each default it takes instead of failing; the [`agent-setup`](../actions/agent-setup/action.yml) block's defaults step, which puts Kanon's baseline in place of a missing playbook and names each default, pinned by [`tests/unit/declaration-defaults.test.ts`](../tests/unit/declaration-defaults.test.ts), which also holds each baseline to the sections above; the reader every guard and the code-audit lane share, [`scripts/lib/code-areas.mjs`](../scripts/lib/code-areas.mjs), which fails by name on a malformed section, pinned by [`tests/library/code-areas.test.ts`](../tests/library/code-areas.test.ts); `tests/unit/lane-workflows.test.ts`, which fails when a Kanon lane, its prompts included, names a known stack literal; and [`tests/unit/lanes-doc.test.ts`](../tests/unit/lanes-doc.test.ts), which fails when a lane's prompt sends the agent to a playbook section this rule doesn't name. Whether an adopter's playbook has those sections is prose only: a missing one reads as a whole playbook, or as nothing to do.

**Class.** split. The paths, the headings and the code areas' entry format and fallback are framework. **The project supplies:** what each says, and where its code is.

### `K-LAYOUT-18` Each lane's caller has the lane's file name, and CI is `ci.yml`

**Rule.** A workflow that calls a Kanon lane is `.github/workflows/<lane>.yml`, the lane's own file name: the caller of `agent-review.yml` is `.github/workflows/agent-review.yml`, and so on for every lane. It holds the lane's triggers itself: a caller is never a reusable workflow that another workflow calls. A project that runs the review lane or the Lead's reconciler keeps its CI workflow at `.github/workflows/ci.yml`.

Kanon's own repository is the one exception. There, `.github/workflows/<lane>.yml` holds the lane itself, so a caller of Kanon's own lanes can't take that path. `lane-check` recognises Kanon's repository by its tree, which holds the spine (`.github/workflows/agent-lane.yml`, a reusable workflow) and `actions/lane-check/lane-check.sh`, never by a name an adopter could share.

**Why.** Kanon's scripts find a lane's runs, or start it, by the file name of its caller in the adopter's repository: the Merger dispatches `agent-review.yml`, the review-run evidence lists its runs, the reconciler lists the runs of `agent-lead-revise.yml` and `agent-implement-revise.yml` and of `ci.yml`, the review lane lists `ci.yml`'s, and the health check watches every `agent-*.yml`. GitHub files a run under the top-level workflow's file name, so a caller that another workflow calls has its runs filed under that other name. Under another name a dispatch fails, and a run listing comes back empty, which the recoveries read as "nothing is parked" rather than as an error. Declaring each name instead would be a setting ([ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md)), and one file name per lane is the shape every adopter's callers already have.

**Enforced by.** [`lane-check`](../actions/lane-check/README.md), which fails a caller of a lane at any other path or one that is itself a reusable workflow, and a caller of a lane that reads a workflow of the project's by name (a `# READS WORKFLOW:` line in the lane: the review lane and the reconciler, `ci.yml`) when that workflow is missing; and `tests/unit/caller-file-names.test.ts`, which fails when a script or a lane reads a workflow by a name that is neither a lane's nor declared on such a line.

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

  `**Milestone:**` is required and names a milestone chosen by chapter 01's routing rules: one of the two buckets (`K-WORK-4`), or a roadmap milestone of the repository, which is one with a due date (`K-WORK-3`), open or met. `**Labels:**` lists labels in backticks, separated by `·`, with no prose between them. `**Closes #<n>**` appears only when the item adopts an existing issue, and is read only from this line.
- **Dependencies** go on their own line, `**Depends on:** Issue A (reason), Issue B`. Only the leading run of `Issue <KEY>` references counts; a parenthetical reason is allowed after each; prose after the last reference cites nothing. Every key must be declared in the same decomposition, and the graph must be acyclic. **Prose that asserts a blocking edge matches the line:** when an item's body says it waits for another item (*blocked on Issue X*, *X must land first*, *after X lands*, *cannot start until X*), or that another item waits for it (*X follows this issue*), the waiting item's `**Depends on:**` line names the other. A sentence that denies the edge (*not blocked on Issue X*, or one under a `Not in this issue:` boundary) asserts nothing.
- **A human-action item** carries the label `qa:human-action` on its metadata line (`K-PROJ-9`).
- **Acceptance criteria** are bullets, each led by one spec id in backticks: `` - `[KIOSK-7]` — … `` (`K-SPEC-5`). Criteria that are numbered run `1, 2, 3…` with no gap: a criterion moved elsewhere keeps its slot with a placeholder. A reference written as `Issue X criterion N` names an item this decomposition declares and a criterion it has.
- **A measurement item** replaces its acceptance criteria with bullets of the form `` - **Measures:** <quantity> — `<command>` `` (`K-PROJ-16`).
- Everything under the item except its metadata and dependency lines is filed verbatim as the issue's body.
- **The project marker.** The Lead ends every issue it files for project `<n>` with the line `<!-- qa:project <n> -->` as the body's **last** line, and mirrors it with the label `project:<n>`, which only the Lead writes (`K-PROJ-9`). The Lead mirrors a project only while its tracking issue is open, because its tick reconciles only open projects. An issue that gains the marker after the project closes, such as a follow-up that inherits the closed project or a marker backfilled by hand, never gets the label. So once a project closes, the marker is its only complete membership record, and the label shows the members it had when it closed.

**Why.** Each of these is a place where the parser once read a brief differently from its author and failed quietly: a heading with a summary read as no decomposition, a label run with prose in it filed an issue with no labels, a closing reference in body prose filed a duplicate, and a dependency separated by the wrong punctuation was dropped, which made an item look ready before its prerequisite had landed. An edge stated only in prose was dispatched as though it weren't there, because the reconciler reads only the dependency line. A renumbered criteria list rendered one lower than every reference to it. A fixed syntax, written down, is what lets an author get it right without reading the parser.

**Enforced by.** The brief guard, which parses the decomposition the same way the reconciler does (`K-PROJ-9`). It accepts a bucket by name, and reads the repository's milestones through `gh` only for any other name, so a brief that names a roadmap milestone needs `gh` with read access to the repository's issues; a name it can't check is a finding, never a pass.

**Class.** framework

### `K-LAYOUT-13` A brief's sections and decisions have fixed minimums and a fixed vocabulary

**Rule.**

- **Sections.** Each of the eight sections of `K-PROJ-4` is a `##` heading that contains its key phrase: *real problem* (or *the measurement*), *scope*, *decomposition*, *cost*, *observability*, *blast radius*, *decisions* (plural, leading the heading), and *did not examine* (or *not examined*). One heading may carry two phrases when the two sections are one story. Each section's body holds at least **200 characters**.
- **The cost section** contains a figure (a currency sign followed by a digit) or the phrase `no delta` in any case, with its reason (`K-PROJ-6`).
- **The observability section** states a decision with one of the words *add*, *skip*, *page*, *none needed* or *nothing*, in any case and any inflection (`K-OBS-1`).
- **A decision** is a numbered item whose headline is bold, at column zero: `1. **Headline.**` or `**1. Headline.**`. Only the bold headline is read. A decisions section that holds numbered lines outside a code fence but parses to no decision (an indented item, `__underscores__`, no space after the number) is refused, because none of its lines could be checked for an open mark.
- **Answered** is `✅` or `ANSWERED` in the headline, followed by who answered (`K-PROJ-18`) and what was chosen: `1. **Which store? ✅ ANSWERED (Owner): the existing one, because…**`.
- **Open** is any of `⛔`, `OPEN`, `PROPOSED`, `TBD`, `UNANSWERED`, `awaiting the Owner`, `awaiting the Maintainer` or `awaiting the Stakeholder` in the headline. The uppercase words are case-sensitive, so the same words in lowercase are ordinary prose, and `OPEN` followed by a hyphen (`OPEN-ENDED`) is not a mark. A headline with an open mark and no answered mark blocks the merge (`K-PROJ-5`).

**Why.** "Answered" and "open" have to be words a guard can read, and an author has to know which words those are before the guard exists. The Owner answers the most common kind of decision (spend), so an open vocabulary that names only the Maintainer and the Stakeholder can't mark it open. The minimum length catches a heading with nothing under it, which reads exactly like a section with nothing to say. A decisions section whose items were written in a shape the guard doesn't read was once reported as checked while it checked nothing.

**Enforced by.** The brief guard (`K-PROJ-4`, `K-PROJ-5`).

**Class.** framework
