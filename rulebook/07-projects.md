# 07 Projects

This chapter governs projects: work too large for one issue, planned by the Lead as a **brief**, approved once by a human, then decomposed into issues, dispatched, verified and closed by the pipeline. The brief is the developer's single decision point for the whole project, so its format exists to make that one decision complete: every section present, every decision answered, every claim re-runnable. A brief decides and decomposes. It does not measure.

## The brief as the single gate

### `K-PROJ-1` The brief is the Maintainer's single gate

**Rule.** Make the approved brief the Maintainer's one decision for a project, and don't consult them again until something escalates. So a brief's decisions include everything that needs a human: anything that raises spend or changes what an agent may do (the Owner's), anything that changes paging, anything that chooses product behaviour or a closure rule, and any roadmap placement (the Stakeholder's, `K-PROJ-14`). How each is answered is `K-PROJ-17`.

**Why.** Per-artifact decisions don't scale. The brief's merge is the only time those questions are asked, so a decision left out of it is a decision an agent makes later, or an interrupt.

**Enforced by.** Prose only; the brief guard checks that the decisions section exists and is answered (`K-PROJ-5`).

**Class.** framework

### `K-PROJ-2` A brief is named by its tracking issue

**Rule.** Store every brief in the fixed projects directory, `docs/projects/`, with its tracking issue number as its file name. Files there whose names start with an underscore are apparatus (the template), not briefs.

**Why.** The reconciler and the digest find a project's brief by its number. A brief named by a slug is never reconciled.

**Enforced by.** The reconciler reads only numbered files, and a workflow warns about any other file in the directory.

**Class.** framework

### `K-PROJ-3` A brief decides and decomposes; it does not measure

**Rule.** A brief contains no file-and-line coordinates. Cite the invariant id that states a behaviour, or the command that re-derives a fact. Aim at about 300 lines, as a signal rather than a limit: past it, ask which paragraph is measurement that belongs in a command, or a criterion that belongs in a spec clause.

**Why.** A name and a command survive the next refactor; a line number is true of one commit and silently wrong of every later one. Six briefs in the reference adopter accumulated over three hundred coordinates, twenty post-approval edits and thousands of lines of guard code chasing them. The length target is not enforced because a line cap fires on the honest case.

**Enforced by.** The brief guard fails on a coordinate. The length is deliberately not enforced.

**Class.** framework

### `K-PROJ-4` Every brief has the eight sections, each saying something

**Rule.** Every brief has eight sections, each with an explicit statement: the real problem, scope (including what it is not), decomposition, cloud cost, observability, blast radius, decisions, and what the author did not examine. Numbering, wording and order are the author's, and a section with nothing to say says "none, because…". The one exception is the decomposition heading, which carries no trailing summary. Each section's heading and minimum length are fixed in `K-LAYOUT-13`, and every brief starts from Kanon's template (`K-LAYOUT-11`).

**Why.** An omitted section reads exactly like a section with nothing to say: silent absence (`K-PRIN-8`) on the artifact with the widest blast radius. The decomposition heading is fixed because the parser matches it exactly; a heading with a summary reads as "no decomposition", the tick files nothing, and the project reports healthy.

**Enforced by.** The brief guard fails on a missing section or one under a minimum length, and a unit test runs the guard against the template itself so the template cannot drift from the standard.

**Class.** framework

### `K-PROJ-5` Every decision is answered before the merge

**Rule.** Write every decision as a bold numbered headline and mark it answered, naming who answered it. An open marker blocks the merge: `⛔`, `OPEN`, `PROPOSED`, `TBD`, `UNANSWERED`, `awaiting the Owner`, `awaiting the Maintainer` or `awaiting the Stakeholder` (the exact vocabulary is `K-LAYOUT-13`). Split a half-answered decision into its answered and open halves. A non-blocking question is an issue, not a decision.

**Why.** A brief was once merged with a decision still marked proposed, and seven issues were filed from it within a minute. The Owner is named in the vocabulary because spend and agent authority are the Owner's decisions (`K-OBS-9`, chapter 03), and they are the most common kind of open decision in a first brief; a vocabulary without the Owner can't mark them open.

**Enforced by.** The brief guard fails on an open marker in the decisions section.

**Class.** framework

### `K-PROJ-6` Cost, observability and blast radius are decided in the brief

**Rule.** The cost section gives a figure, or declares "no delta" with a reason. The observability section states the add-or-skip decision with a reason (`K-OBS-1`). The blast-radius section names every item in `docs/qa/escalation-paths.md` the project touches (`K-LAYOUT-8`). That file is filled in before the first brief is written; a brief never invents its own list.

**Why.** Agreement comes before spend (`K-OBS-9`). A deliberate skip is fine and an absent one is not. Naming escalation items up front turns N mid-PR interrupts into one decision.

**Enforced by.** The brief guard, for cost and observability. The blast-radius list is checked by the Reviewer's brief review (prose).

**Class.** split. The three required decisions are framework. **The project supplies:** its pricing, its observability vocabulary, and the contents of its escalation file (for example data migrations, authentication, destructive schema changes, payments code).

### `K-PROJ-7` Review a brief for substance, not shape

**Rule.** The Reviewer reviews a brief for: the root cause (plan the systemic fix when several issues share one cause), falsifiable criteria, declared non-examination, re-runnable evidence, an honest blast radius, decided cost and observability, real sequencing, no `[confirmed]` clauses, and reconciliation gaps filed as issues. It does not review prose or shape, which the guard owns.

**Why.** The failure mode is a complete, readable plan aimed at the wrong problem. One systemic fix beats N point fixes.

**Enforced by.** The Reviewer's brief review (prose); shape is the brief guard's.

**Class.** framework

### `K-PROJ-8` Cluster a backlog before briefing it

**Rule.** Before briefing a backlog, cluster it into themes and take one disposition per theme. Brief only what survives.

**Why.** Each issue costs one human decision. Clustered, a backlog of about 150 issues came to about a dozen decisions.

**Enforced by.** Prose only. The clustering exists; recording dispositions does not yet.

**Class.** framework

## Decomposition and membership

### `K-PROJ-9` Decomposition items are machine-readable

**Rule.** Decompose into one subsection per issue, each with a metadata line: a milestone chosen by the routing rules (chapter 01), labels including a kind label (`K-WORK-23`), dependencies on sibling items by letter (declared and acyclic), and a closing reference only when adopting an existing issue. Mark an item whose deliverable is not a PR with the `qa:human-action` label: it is never dispatched, doesn't park the project, and is closed by a human with its evidence recorded on the issue. An item whose deliverable is a number is a measurement item (`K-PROJ-16`). Mark each filed issue's membership with the project marker `<!-- qa:project <n> -->` as the **last line** of its body, mirrored by the label `project:<n>`, which only the reconciler writes, and only while the project is open: after it closes the marker is the membership record (`K-LAYOUT-12`). The exact syntax of all of these is `K-LAYOUT-12`.

**Why.** These are the conditions that otherwise stop a tick hours after the merge. Membership is decided by position, not presence, because documents that discussed the marker were once absorbed as project members.

**Enforced by.** The brief guard parses the decomposition the same way the reconciler does and fails on a missing milestone, a malformed dependency, a cycle, a misplaced closing reference, or a blocking edge stated in prose but missing from the dependency line (`K-LAYOUT-12`). The reconciler reads membership by position.

**Class.** framework

## Change after approval

### `K-PROJ-10` An approved brief is immutable, except for a repair or a split

**Rule.** Once approved, a brief is a decision record, not a wiki. A correction is an issue or a spec edit. The only sanctioned edits are a mechanical defect repair and a **split**: when an item's implementer run hits its cap, the Lead replaces that one item with smaller children, by PR.

**Why.** A brief that keeps changing after approval is no longer the thing the Maintainer approved. Splitting keeps an over-large item from stalling the project without reopening its decisions.

**Enforced by.** The brief guard applies to every brief except those the adopter lists as written before the standard, under `## Pre-standard briefs` in `docs/qa/exemptions.md` (`K-LAYOUT-15`). Its shape checks still run over those briefs; its summary line names each content rule it skipped for them. A pull request that adds one escalates to a human, because the file is directly inside `docs/qa/` (`K-MERGE-4`), and an entry for a brief that doesn't exist fails the guard.

**Class.** framework

## Closure

### `K-PROJ-11` One definition of done, reached through fixed phases

**Rule.** Every project has the same definition of done: all its gating issues closed, their merges deployed to the project's **reference environment**, and every cited id resolved to a passing test at the ref deployed there. The reference environment is the one environment the project names, in its adoption record, as where released behaviour is verified, with the workflow that deploys there and the job whose success is the deploy (`K-LAYOUT-10`). **By default it is the last environment before production** (staging, for most projects), because agents never explore production (`K-OBS-7`). A project whose last environment before production doesn't exist names its own. Verification runs the citing tests at the ref deployed there; it never sends an agent to explore production (`K-OBS-7`). A human-action item is done when a human closes it with the evidence of their verdict recorded on the issue, so an outcome only a person can judge gates closure like any other decomposition item without being forced into a test. It is reached through fixed phases: file, dispatch, confirm the merges are deployed to the reference environment (by the deploy job itself, not the workflow's conclusion), verify the acceptance criteria there, then close the tracking issue with a retrospective. Escalate the terminal verification states (unverifiable; rounds exhausted). Re-verify only when a gating issue closes after the last verification, never on a release. A project never gets its own milestone.

**Why.** The definition is already executable, so a per-brief one would only drift from it. "The deployed ref" means nothing until the project says which environment's ref, and a project that deploys to many environments needs one of them to be where behaviour is verified; how releases reach the others is the project's own policy. A deploy workflow concluded "success" without deploying in eight of twenty-five runs, which is why the project names the deploy job and not only the workflow. A project that declares no reference environment can't close, and the reconciler says so by name rather than guessing a workflow. Releases are cut on every merge, so re-verifying on a release loops. A per-project milestone would corrupt the milestone kinds (chapter 01).

**Enforced by.** The reconciler's closure phases, which read the reference environment's deploy from the adoption record on the default branch, and the acceptance-criteria verification workflow.

**Class.** split. The phase model is framework. **The project supplies:** its reference environment, and the workflow and job that deploy to it, declared in its adoption record.

### `K-PROJ-12` Report every member, gate on the few

**Rule.** Report every project member, but gate closure only on decomposition items, verification findings, and members of high or critical severity. Carry the rest out of the project and list them in the retrospective.

**Why.** Follow-ups keep arriving during a project; gating on all of them means a project never closes. The rule was agreed with the stakeholder, because what gates a project is a planning decision.

**Enforced by.** One shared closure module used by both the reconciler and the digest, so they cannot size a project differently.

**Class.** framework

### `K-PROJ-13` A daily digest says where the pipeline is stopped

**Rule.** Give the Maintainer a daily digest of where the pipeline is stopped, ranking held projects first. Don't count the Maintainer's own queue back at them.

**Why.** Held projects are the only thing waiting on the human. Nagging someone about their own merge backlog was proposed and rejected; automate agent behaviour, not human reminders.

**Enforced by.** The digest job.

**Class.** framework

### `K-PROJ-14` A brief that places roadmap work carries the Stakeholder's decision

**Rule.** When a brief places any of its work on a roadmap milestone, the brief's decisions section records the Stakeholder's decision, as either an approval of the brief's pull request by the Stakeholder or an attestation by the Maintainer naming the Stakeholder and when or where it was agreed (`K-PRIN-18`). A brief that only files into buckets needs neither.

**Why.** Roadmap placement is the Stakeholder's decision, but a brief is merged by the Maintainer. Without this rule, the merge is the only trace, and nobody can tell afterwards whether the Stakeholder agreed or was simply not asked.

**Enforced by.** Prose only; a guard is planned (the brief guard, extended to fail when a roadmap placement has no Stakeholder record).

**Class.** framework

## Mandates, measurements and decisions

### `K-PROJ-15` A mandate lives in its tracking issue's body, and nowhere else

**Rule.** The mandate that starts a project (what a human asks the Lead to plan) is the body of the project's tracking issue. It is not committed to the repository as a file, and not restated in the brief: the brief cites the tracking issue. A change to the mandate is an edit to that issue, made by a human, before the brief merges.

**Why.** A mandate kept in two places has two homes (`K-PRIN-2`), and the Lead would plan from whichever it happened to read. The tracking issue already exists, is numbered, and is where the brief's file name points.

**Enforced by.** Prose only. The Lead reads the mandate from the tracking issue it is given (`K-AGENT-30`).

**Class.** framework

### `K-PROJ-16` A measurement item's deliverable is a number and its command

**Rule.** When a decomposition item exists to produce a number (a spike, a cost measurement, a baseline), write it as a **measurement item**: instead of spec ids, its bullets each name a quantity and the command that measures it (`K-LAYOUT-12`). Its deliverable is the measured number with that command, posted on its issue, and it closes when the number is posted. It is never a spec clause. If only a human can take the measurement, it also carries `qa:human-action`.

**Why.** A number is not behaviour. Forcing it into a `[seed]` clause bends the spec corpus into a to-do list, and a clause that says "the cost is measured" is satisfied by any number at all. A measurement item keeps the evidence rule (`K-PRIN-14`) and leaves the spec layer to behaviour.

**Enforced by.** The brief guard (`scripts/brief-guard.mjs`): it accepts an item with no acceptance criteria when it carries `**Measures:**` lines, refuses a measurement line that names no command, and refuses an item with neither ids nor measurements. A test runs the guard on the brief template, whose example measurement item it must accept ([#55](https://github.com/yedeya-labs/kanon/issues/55)).

**Class.** framework

### `K-PROJ-17` A human answers a decision on the brief's branch

**Rule.** A human answers an open decision by editing its headline on the brief's own pull-request branch: replace the open mark with `✅ ANSWERED (<role>)`, then what was chosen. When the answer is given in a review comment instead, the Lead transcribes it into the brief on the same branch, naming the role that answered and linking the comment. Nothing else counts as an answer: a chat message, or an answer the Lead inferred, is not one until it is in the headline.

**Why.** The brief is the decision record (`K-PROJ-10`), so the answer has to be in it, where the guard reads it and where it survives the merge. A comment is where people naturally answer, and transcription keeps that convenience without leaving the record split between the brief and a thread.

**Enforced by.** The brief guard reads only the headline (`K-PROJ-5`). Who may answer what is `K-PROJ-18`.

**Class.** framework

### `K-PROJ-18` The Lead may settle technical decisions only

**Rule.** The Lead may answer a decision itself only when it is technical: how to build something the mandate already asks for. It marks such an answer `✅ ANSWERED (Lead, technical)`. It never answers a decision about spend or agent authority (the Owner's), product behaviour or a project's closure rule (the Maintainer's or the Stakeholder's, `K-PRIN-18`), paging (`K-OBS-1`), or roadmap placement (the Stakeholder's). Those stay open until the human who owns them answers.

**Why.** Humans decide product intent; agents solve code questions (`K-PRIN-3`). A brief that asks a human every technical question wastes their one decision point, and one that lets the Lead answer a spend or product question has an agent deciding what it was meant to propose. Naming the answerer in the headline lets the Reviewer check the line was respected.

**Enforced by.** The Reviewer's brief review checks that no decision in a human's domain is marked answered by the Lead. Prose only; a guard is planned.

**Class.** framework

## Examples from the reference adopter

- **The closed list of pre-standard briefs** (`K-PROJ-10`). Six briefs were approved before the brief standard existed. They are exempt from the guard through a list the adopter keeps (`K-LAYOUT-15`), and its own test forbids a seventh, because immutability outranks the coordinate rule for history.
