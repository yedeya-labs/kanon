# 02 Specs

This chapter governs the spec layer: the numbered behavioural invariants that say what the product must do. In Kanon a behaviour is stated once, as an invariant with a permanent id, and everything else (issues, bug reports, reviews, briefs, tests, acceptance criteria) cites that id instead of restating the behaviour. That is what makes an acceptance criterion checkable, lets a test declare what it locks, and keeps the oracle from drifting. It is `K-PRIN-2` applied to behaviour.

## The corpus

### `K-SPEC-1` Specs live in the repository and travel with their PR

**Rule.** Keep behavioural specs as one markdown file per area in `docs/qa/specs/`, in the format of `K-LAYOUT-2`, changed only through a reviewed PR. On agent runs, read specs from the PR under review, never pinned to the base branch.

**Why.** The spec corpus is the highest-stakes oracle in the pipeline, so it has to be diffable, auditable and unable to change silently. A reviewer checking a PR that changes behaviour must read the oracle as that PR leaves it.

**Enforced by.** The step that restores agent instructions from the base branch on PR runs deliberately excludes the spec directory, the one exception `K-MERGE-17` names. The "only via reviewed PR" half is the main branch's ruleset.

**Class.** framework

### `K-SPEC-2` Every invariant has a permanent id

**Rule.** Give every invariant an id of the form `[AREA-N]`, recorded in the registry `docs/qa/specs/_id-registry.json`, which holds each area's high-water mark (`K-LAYOUT-3`). Never reuse an id, never renumber to close a gap (a gap records a retirement), and never change an id when the invariant's maturity changes.

**Why.** Without a handle, issues restate prose and drift, tests cannot declare what they lock, and promotion can't be measured. A citation written this year must not resolve to different behaviour next year.

**Enforced by.** A lint-time spec guard that fails on a duplicate id, an id above the registry's high-water mark, or a reused retired id.

**Class.** framework

### `K-SPEC-3` Allocate ids with the allocator, and record every forced renumber

**Rule.** Allocate new ids only with the allocator tool, which allocates above every open PR's claim as well as the registry. When a collision forces a renumber anyway, record old id to new id in the registry in the same change, and rewrite or acknowledge every reference outside the specs.

**Why.** Two sibling PRs once took the same id and both merged cleanly, creating a duplicate. A moved id otherwise silently resolves to whichever clause kept it, so every old citation now points at different behaviour.

**Enforced by.** A unit test that fails on an id the allocator did not record, and a lint-time check that fails when an id changes without a renumber record or with an unacknowledged outside reference. A dry run of the allocator accepts hand-numbered ids; the test does not.

**Class.** framework

## Citing, not restating

### `K-SPEC-4` Cite an invariant by id; never restate it

**Rule.** Issues, bug reports, reviews and briefs cite an invariant by its id. They never restate its prose.

**Why.** A restatement is a second home for the behaviour, and the two drift apart. A criterion with two homes has no owner.

**Enforced by.** The brief guard, for briefs. Otherwise prose only.

**Class.** framework

### `K-SPEC-5` Acceptance criteria are spec ids

**Rule.** Every acceptance criterion is a spec id leading its bullet. A deliverable with no existing invariant gets a new `[seed]` clause, so it has an id too. Write every such invariant against a concrete observable. Two kinds of item are not behaviour and take no spec id: a **measurement item**, whose deliverable is a number and its command (`K-PROJ-16`), and a **human-action item** judged by a person (`K-PROJ-9`). Installation work during bootstrap is tracked in the adoption record, not as spec clauses (`K-ADOPT-1`). When work touches an area whose confirmed invariants no test enforces, closing that gap is the first issue.

**Why.** Prose acceptance criteria vanished from verification entirely in the reference adopter. "Handles errors gracefully" is satisfied by anything. A criterion that cites an invariant no test checks is not falsifiable. But forcing a spike, a cost measurement or a repository skeleton into a clause bends the spec corpus into a to-do list, which is why those have kinds of their own.

**Enforced by.** The brief guard fails on a criterion that isn't led by an id; the acceptance-criteria verifier reads only ids. Observability of each clause, and the untested-area rule, are checked by the Reviewer's brief review (prose).

**Class.** framework

### `K-SPEC-6` A test declares what it locks, and only a passing test verifies

**Rule.** Name the invariant id in the title of the test that asserts it, and never cite an id the test does not assert. Count an acceptance criterion as verified only when a citing test ran and passed. "No citing test" is unverifiable and "didn't run" is not-run; neither is a pass or a finding.

Where the title is depends on the test's language, and Kanon fixes it per language ([ADR 0012](../docs/decisions/0012-test-conventions-by-language.md)):

| Language | Test files | The title that carries the id |
|---|---|---|
| JavaScript and TypeScript | every file in a `tests` tree the project declares under `## Code areas` (`K-LAYOUT-17`), or, with none declared, `*.test.*` and `*.spec.*` | the title argument: `it('[ORD-1] …')` |
| Python | `test_*.py` or `*_test.py` | the first line of the docstring of a test function pytest collects (a module-level `test…` function, or a `test…` method of a `Test…` class): `"""[ORD-1] …"""` |
| Go | `*_test.go` | the name of a subtest in a `Test…` function: `t.Run("[ORD-1] …", …)` |

Kanon reads no test in a language outside the table. A JavaScript test runs with the runner its declared tree names, and a test in a tree that names none, or found by the suffix alone, is read and never run, so its criteria are not-run.

**Why.** The title is the only thing the coverage and verification tools read, so a false citation turns "unverifiable" into a false pass. Evidence gaps must not become verdicts in either direction. A fixed convention per language keeps the tools from depending on a setting. The language of each file picks its row, so a project with two languages needs nothing extra. JavaScript is the exception that proves it: its runners find tests wherever the project configures them, so a fixed tree would be one project's layout imposed on every other, and its trees are declared in the stack document instead, with the suffix most of its runners discover by default when none are. A language outside the table reads as "nothing checked", never as a pass.

**Enforced by.** The coverage and acceptance-criteria tools read test titles and report the three states separately. Citation honesty is prose only.

**Class.** framework

### `K-SPEC-7` Coverage is reported, and the locked set only grows

**Rule.** Report spec coverage in tiers (Locked, Claimed, Declared unlockable, Bare) and never make the coverage number a merge gate. Record each newly locked id in the committed locked set, `docs/qa/specs/_locked-floor.json` (`K-LAYOUT-4`), and never let that set shrink.

**Why.** A coverage gate would teach agents to cite any handy id and destroy the signal. A ratchet is different: it only stops a lock from being deleted silently, and it distinguishes "a citation was removed" from "there were never that many".

**Enforced by.** The spec guard deliberately checks integrity only, not coverage. A merge-time check compares the locked set against the live base branch and fails when it shrinks. Project closure separately requires every cited id to pass (`K-PROJ-11`).

**Class.** framework

## Maturity and promotion

### `K-SPEC-8` Only confirmed invariants and reviewed contracts are a hard oracle

**Rule.** Tag every invariant `[seed]` (proposed), `[confirmed]` (promoted by a human) or `[structural]` (derived from a reviewed contract); a clause that no longer holds is tagged `[retired]` and keeps its id. Only `[confirmed]` and `[structural]` invariants, and the project's reviewed schema and validation contracts, are a hard oracle: a contradiction of one is a bug. A contradiction of a `[seed]` is a spec delta.

**Why.** A human already wrote and reviewed a validation contract, so a violation is an objective signal. A `[seed]` is only somebody's proposal, and filing it as a bug turns a guess into ground truth.

**Enforced by.** Prose only, applied by the Explorer's filing gate.

**Class.** split. The tags and the hard-oracle rule are framework. **The project supplies:** which of its schema and validation layers count as reviewed contracts.

### `K-SPEC-9` Agents never promote an invariant

**Rule.** Every invariant an agent writes lands as `[seed]`. Only a human moves an invariant from `[seed]` to `[confirmed]`, and approving a plan that proposes an invariant is not the same act as confirming it.

**Why.** Promotion turns an agent's plan into ground truth. Approving intent (a brief) and confirming behaviour are two separate human acts, and merging them lets an agent write its own oracle.

**Enforced by.** The merge gate (`scripts/merge-gate.mjs`), which reads the diff of every changed spec and escalates a pull request that makes any invariant `[confirmed]`: a tag flipped in place, a clause moved between spec files with its tag flipped, or a new clause written as `[confirmed]` (`spec-promotion`). An edit or move that keeps `[confirmed]` is not escalated. A spec diff it can't read never merges: a patch listing that fails waits for the next sweep (`spec-diff-unlisted`), and a changed spec that comes back without a diff escalates (`spec-diff-unreadable`). Its tests are in `tests/library/merge-gate.test.ts`. Agent instructions, and the Reviewer, which blocks a brief that writes `[confirmed]`, come first.

**Class.** framework

### `K-SPEC-10` The spec changes with the behaviour, and exploration proposes deltas

**Rule.** Update the area's spec in the same PR that changes expected behaviour. Every exploratory run emits proposed spec deltas alongside the bugs it files.

**Why.** If the spec lags, the Explorer files the intended change as a bug. The stream of spec deltas is what makes the oracle compound; bolting it on later throws away every observation made in between.

**Enforced by.** The Reviewer checks it. Prose only; a guard is planned (a check that nudges when a service changes without its spec).

**Class.** framework

### `K-SPEC-11` Promote against intent

**Rule.** Before codifying observed behaviour as an invariant, look for a consumer built for the opposite behaviour. If one exists, file a bug instead.

**Why.** A promotion once hardened "declined attempts are not stored" while the schema and a report had been built specifically to store and show them. The observed behaviour was the bug.

**Enforced by.** Prose only, in the Explorer's and Reviewer's instructions.

**Class.** framework

## Examples from the reference adopter

- **Pre-promoted contracts** (`K-SPEC-8`). The reference adopter counts its request-validation schemas and route input validation as reviewed contracts, so an input a schema accepts but the handler rejects is filed as a bug without waiting for a `[confirmed]` invariant.
