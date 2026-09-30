# 09 Self-maintenance

This chapter governs how a Kanon pipeline keeps itself honest: the guards that check the repository and the pipeline's own configuration, the Overseer that audits the pipeline from its telemetry, the derived data it computes, and the capability ledger that stops the same idea being proposed every week. A pipeline that runs unattended degrades quietly: a guard starts passing because it can no longer fail, a citation points at the wrong line, a threshold governs data it was never calibrated on. Nothing here writes product code. It exists so that the rest of the rulebook keeps meaning what it says. The principle that every guard must be able to fail is stated in [00 Principles](00-principles.md); this chapter is how that principle is kept.

## Guards

### `K-SELF-1` Run every guard, and report every verdict

**Rule.** Run the guards as a chain that reports each guard's verdict even after an earlier guard has failed.

**Why.** A chain that stops at the first failure hides every later verdict. In the reference adopter, one failure once hid six other guards' results, and each had to be discovered in a separate round.

**Enforced by.** The lint chain runner, which runs all guards and fails at the end if any failed.

**Class.** framework

### `K-SELF-2` Check live facts against the repository, never against a declared list

**Rule.** A guard that checks labels, milestones or App identities checks them against the live repository, not against a list someone declared. Such a guard reads repository state rather than the diff, so it can fail on an unrelated PR; its output must say exactly what to fix.

**Why.** A declared list is a third opinion about what exists, and it drifts silently ([ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md)). A repository-state guard has no clock of its own, and a scheduled red run has no reader, so a PR is the only place its failure will be seen; that is acceptable only if the message is actionable by whoever sees it.

**Enforced by.** The label guard, and the App-slug assertions in agent workflows.

**Class.** framework

### `K-SELF-3` Every citation in the docs must resolve to what its sentence names

**Rule.** Every repository-relative path cited in a doc or comment resolves to a tracked file. Every `file:line` citation points at an identifier its own sentence names. When a diff moves lines, update the citations below the edit in the same change, finding them by the cited file's name.

**Why.** A design doc that didn't exist was cited through four reviews. A range check alone passes a citation that now points at a different invariant: after one edit, eleven of sixteen shifted citations still passed it.

**Enforced by.** A path guard that fails on a cited path that is not tracked; a citation guard that fails when the cited lines don't contain the identifier the sentence names; a shift helper that reports citations a diff moved.

**Class.** framework

### `K-SELF-4` Check the pipeline's runtime contract, not only its code

**Rule.** Check that the installed agent CLI accepts every flag the workflows pass, at or above each flag's minimum version. Check that each workflow's permissions block covers every default-token API call its steps make, including calls in the scripts they invoke.

**Why.** The agent action floats on a major version, so one flag it stops accepting breaks every lane at once. A missing permission returns an error body that code can read as data: five permission failures were swallowed into green runs in the reference adopter before this was checked.

**Enforced by.** A flag guard that fails when the installed CLI rejects a flag a workflow passes; a permissions guard that fails when a workflow step makes a call its permissions block does not grant.

**Class.** framework

### `K-SELF-5` Prove "cannot happen" with a test, and assert recorded bounds against the code

**Rule.** When a condition is claimed impossible, prove it with a parity test between the components involved, not with a runtime branch that can never fire. When a doc records a bound on what the code does (a query's projection, a permission's use), assert that bound against the code so that widening it fails the build.

**Why.** A branch that cannot fire reads as protection and provides none. A recorded bound is a claim someone can check, and unchecked ones drift: one drifted twice in the reference adopter before a test pinned it.

**Enforced by.** Parity tests between components that must agree, and unit tests that compare a recorded bound with the exported constant.

**Class.** framework

### `K-SELF-6` Re-grade a ratchet against the live main branch

**Rule.** Grade a coverage or ratchet claim against the current main branch, not against a PR's possibly stale merge ref. After a burst of merges, check the main branch's CI.

**Why.** Two PRs that are each green alone can be red together: one adds a repository-wide sweep and the other adds a file that violates it. It happened seven times in the reference adopter, twice in one day.

**Enforced by.** A locked-set check that re-grades against the live base branch.

**Class.** framework

### `K-SELF-7` Scope a guard's assertion to the claim, and mutation-check each assertion

**Rule.** A guard over prose anchors on the claim, slices out that block, asserts inside it, and throws when the anchor can't be found. Mutation-check each assertion separately. Restore a mutated file from a copy taken before the mutation, never by checking the file out from version control.

**Why.** A section-wide match binds nothing; it was measured passing twice when the claim it guarded was gone. A guard that silently stops finding its anchor passes forever. Checking a file out reverts it to the last commit, discarding the fix, and the next run goes green on the unfixed file.

**Enforced by.** Prose only; the mutation checks themselves are what verify each guard.

**Class.** framework

### `K-SELF-8` Scripts an agent runs without an install step have no dependencies

**Rule.** A script that runs in a job with no dependency-install step uses only the runtime's built-ins.

**Why.** The Overseer's job has no install step, so a dependency there fails at import, and in a job whose healthy state is quiet.

**Enforced by.** A unit test that fails when such a script imports anything outside the built-ins.

**Class.** framework

## The Overseer

### `K-SELF-9` The Overseer audits the pipeline from aggregates, and is built last

**Rule.** The Overseer audits, from aggregate telemetry: precision drift per signal, coverage gaps, root-cause clusters, the loop deceiving itself, pending spec promotions, follow-up leakage, backlog dynamics, cost and quota drift, and capability drift. Build it after the agents whose output it audits already emit that output.

**Why.** It can only audit what is instrumented. Building it first produces an auditor with nothing to read and findings that are really "no data".

**Enforced by.** Its prompt.

**Class.** framework

### `K-SELF-10` Mark every Overseer proposal unverified

**Rule.** Every change the Overseer proposes is marked **unverified**, and leads with its evidence and the constraint it must satisfy, not with the remedy.

**Why.** Once an issue is labelled for implementation, the Implementer builds what it says. An Overseer remedy presented as fact was built as written in the reference adopter, and was wrong.

**Enforced by.** Prose only.

**Class.** framework

### `K-SELF-11` Keep one rolling audit, and fix one audit's findings together

**Rule.** The Overseer keeps exactly one open audit issue, closing its own previous one when it files the next. Issues filed from the same audit are fixed together, on one branch, as one squashed commit.

**Why.** A rolling issue deduplicates for free and avoids issue spam. Closing its own superseded audit is the only thing the Overseer ever closes. Findings from one audit usually touch the same surfaces, so splitting them multiplies review rounds and conflicts for no gain.

**Enforced by.** The Overseer's prompt; batching is prose only.

**Class.** framework

### `K-SELF-12` Query liveness with full records, and know each workflow's history

**Rule.** When checking whether a lane ran, read full records rather than projections, and check that an object exists by fetching it rather than by listing. Know which workflows legitimately record skips. Remember that renaming a workflow file starts a new run history: reach the old runs by the workflow's numeric id and span the overlap.

**Why.** A projection plus a pagination token hid skip rows for weeks. After a rename, the new history showed five runs where the old one held over a thousand, which reads as a lane that barely ran.

**Enforced by.** Prose only.

**Class.** framework

## Telemetry and derived data

### `K-SELF-13` Calibrate every threshold on the corpus it governs

**Rule.** Calibrate every threshold (for example a clustering cut) on the corpus it will actually govern, re-sweep when that corpus widens, commit the calibration record, and test it against the code's default. Exclude the pipeline's own templated reports from any corpus it clusters.

**Why.** A cut calibrated on one corpus governed a wider one, uncalibrated, for a fortnight. The pipeline's own reports cluster with each other into a theme that grows by one a week and means nothing.

**Enforced by.** A committed calibration record with a unit test against the code's default; the corpus builder excludes the pipeline's reports.

**Class.** framework

### `K-SELF-14` Record a class for every review finding, and baseline before gating

**Rule.** Record a class for every review finding (silent absence, reality mismatch, stale assertion, logic, cross-artifact, self-referential). Establish a baseline before switching on any gate predicted to move a class.

**Why.** A gate switched on before its baseline exists has an effect nobody can measure.

**Enforced by.** Prose only; a guard is planned.

**Class.** framework

### `K-SELF-15` Fail on a lost record; tolerate a lost hint, but label it stale

**Rule.** A failed write to the record-critical store fails the job. Writes to derived stores (clusters, recall indexes) are non-fatal, but a derived index that could not be refreshed says so in its output instead of reading as current.

**Why.** The run record is what every audit reads, so losing it silently corrupts everything downstream; a derived store is a hint and can be rebuilt. But a refresh refusal once left a cluster file that looked fresh.

**Enforced by.** The run-record writer exits non-zero on a failed write; the derived-store sync exits zero; the cluster output carries a stale-index banner.

**Class.** framework

## The capability ledger

### `K-SELF-16` A human keeps the capability ledger, and its dispositions bind

**Rule.** Keep a capability ledger, `docs/qa/capability-ledger.md` in the format of `K-LAYOUT-7`, of runtime and platform features the pipeline could adopt, maintained by a human. A rejected or deferred capability is re-raised only when its recorded reason has changed; "pending, first sighting" is the only non-binding value. The weekly review proposes changes as a delta block, carried forward verbatim until a human folds it in; the reviewer never writes the ledger. A candidate is raised only when it maps to a named operation with evidence already measured, in the full form: operation, pain and evidence, what changes, what it deletes, what would make it not worth it, disposition. "No proposals" is a valid outcome.

**Why.** Without binding dispositions, the same capability is re-proposed every week. Without the evidence form, the review chases novelty. The reviewer not writing the ledger keeps it at zero blast radius.

**Enforced by.** The label guard checks that ledger rows referencing an open issue carry the capability label; the rest is prose only, and the Overseer's read-only access keeps it from writing.

**Class.** framework

### `K-SELF-17` File capability issues sparingly, and make the watch say it ran

**Rule.** File a capability issue only after two consecutive sightings, when no issue for it exists, and when the open capability backlog is under its interlock limit, counted by a script and not by the agent; at most one per scan, labelled as a capability. Open every capability-watch section with exactly one status line: ran through, not due, or degraded. Write the watermark as a bare line, never write one in an audit that emits no delta, and never carry a value that failed validation. When turns run short, sacrifice this section, never the audit.

**Why.** An unlabelled issue escapes the interlock, and a search that returns zero on error would unlock it silently. The status line is what shows the watch has gone quiet. A decorated or invented watermark becomes the anchor for the next run and orphans months of state.

**Enforced by.** An interlock script that counts the open capability backlog; the watermark reader matches the exact line format. The status line is prose only.

**Class.** framework

## Scope discipline

### `K-SELF-18` Propose out-of-scope work as an issue; don't do it

**Rule.** When a session discovers work outside its scope, propose an issue for it (with a milestone, per chapter 01) rather than doing it in the current change.

**Why.** Scope creep inflates review, mixes unrelated risks in one merge, and hides the extra work from the backlog that measures progress.

**Enforced by.** Prose only.

**Class.** framework
