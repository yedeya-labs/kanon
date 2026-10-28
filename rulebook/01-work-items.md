# 01 Work items

This chapter governs the issue: how it is labelled, which milestone it belongs to, how severe it is, what its body says, and who decides where it goes. Issues and labels are Kanon's queue: every agent lane is triggered by a label and every progress report is counted from milestones, so a mislabelled or mis-milestoned issue is not an untidy record but work that is invisible, dispatched wrongly, or counted against the wrong goal. The chapter also draws the central line of Kanon's work model: **an agent may file and route work into a bucket, but only a human places work on the roadmap.**

## Milestones

### `K-WORK-1` File every issue with a milestone

**Rule.** Every issue has a milestone from the moment it is filed, whoever files it and whatever kind of work it is. A backstop assigns a bucket to any issue that arrives without one.

**Why.** Progress is reported as movement against milestones, so an issue with no milestone is work that effectively didn't happen. In the reference adopter, the earlier rule of leaving the milestone empty hid about 70% of closed work from every progress report. The backstop exists because some filing paths, such as issue forms, cannot set a milestone at all.

**Enforced by.** An automation that runs when an issue is opened and assigns a bucket milestone to any issue that has none. It fires only at opening: a milestone cleared later is not restored.

**Class.** framework. The buckets' names are fixed by Kanon (`K-WORK-4`); a roadmap milestone's name is the Stakeholder's.

### `K-WORK-2` Choose the milestone yourself, at filing, in one call

**Rule.** Pick the milestone deliberately when filing; don't rely on the backstop. Create the issue with its labels and milestone in a single call, never create it bare and edit it afterwards. When you notice an issue in the wrong milestone, or none, say so.

**Why.** The backstop knows only a few labels and cannot tell product work from platform work, and a *wrong* milestone is worse than a missing one: it looks triaged and drops out of the query that finds untriaged issues. A bare create followed by an edit races the backstop, which can overwrite a deliberately chosen milestone with a default. Pointing out a misplaced issue is expected, not scope creep.

**Enforced by.** Prose only.

**Class.** framework

### `K-WORK-3` There are exactly two kinds of milestone, told apart by the due date

**Rule.** A milestone is either a **bucket** (an ongoing stream of work that never completes and has **no due date**) or a **roadmap milestone** (a finite piece of work, prioritised by the stakeholder, closed when finished, and **always created with a due date**). Never give a bucket a due date, and never create a roadmap milestone without one. A roadmap milestone may be created for a single project's work (`K-PROJ-11`); its title and due date are the Stakeholder's decision, whoever types the command (`K-WORK-5`).

**Why.** The due date is the only difference between the two kinds that can be read from the repository, so every surface that treats them differently (progress digests, the guard that keeps agents off the roadmap) asks exactly that question. A roadmap milestone created without a due date reads as a bucket everywhere: no burndown, and no guard stopping an agent from routing into it. Because the two buckets' names are fixed (`K-WORK-4`), an open milestone with no due date and any other title is a roadmap milestone created without one, so a check can tell the two apart without naming a project's milestone.

**Enforced by.** One shared classifier decides "roadmap" by the presence of a due date, and every consumer uses it. Creating roadmap milestones with a due date is prose only.

**Class.** framework

### `K-WORK-4` Keep two buckets, and route by subject

**Rule.** Keep exactly two buckets, with these names: **Product Backlog**, for product work, and **Development Automation**, for engineering-platform and pipeline work. Neither has a due date (`K-WORK-3`). Route an issue by its subject, not by who surfaced it. When an issue fits both, such as a review follow-up that asks for a CI guard, the platform bucket wins. Every pipeline-improvement proposal goes to the platform bucket.

**Why.** Where an issue came from (a reviewer, an agent, a human) is provenance, not a kind of work. A CI guard is platform work whoever found it. Routing by provenance put guard work into the product backlog, where it was reported as product progress.

**Enforced by.** The backstop routes by one label: an issue labelled `pipeline-improvement` goes to *Development Automation*, everything else to *Product Backlog*. The filing skill's `plan` takes the filer's judgment of the subject, `product` or `pipeline`, and sends pipeline work to *Development Automation* with or without the label. It refuses pipeline work on *Product Backlog*, even when a brief names that bucket, so the Lead's reconcile tick stops on such a brief item and the brief guard reports it on the brief's pull request (`tests/library/lead-reconcile.test.ts`, `tests/library/brief-guard.test.ts`). Judging the subject is prose only.

**Class.** framework. The names are fixed because the backstop and the filing skill write them as literals. Letting each project name its buckets would buy nothing (the kind of a milestone is read from its due date, never its name) and would give every guard that writes a bucket a setting to read (`K-PRIN-1`).

### `K-WORK-5` An agent routes only to buckets; a human places work on the roadmap

**Rule.** An agent may assign an issue only to a bucket. Placing work on a roadmap milestone is the stakeholder's decision, with no exceptions. An agent may *suggest* a placement (see `K-WORK-10`), and it may *write* a roadmap milestone only when transcribing one from a plan that a human has already approved.

**Why.** Assigning work to a roadmap feature decides what a launch contains, which is product intent. A bucket default is the correct state until someone makes that call, not a placeholder for an agent to improve on. The reference adopter once let an agent route its highest-severity findings straight onto the launch gate; that exception was retired so that no agent decides a roadmap placement. Transcribing an approved plan is not an exception, because the decision was already a human's.

**Enforced by.** The backstop only ever writes a bucket. A label guard fails when the explorer's lane applies a roadmap milestone to the issues it files. Other agents are held by prose only.

**Class.** framework

### `K-WORK-6` Keep one launch gate, finite, and never reopen it

**Rule.** At most one roadmap milestone at a time is the **launch gate**. Put only work that gates the launch in it, never ongoing work. When the gate is met, close it and never reopen it: new work goes to a bucket.

**Why.** A gate is useful only because it is finite and completable, so that "27 of 38 done" means something. Parking ongoing work in it inflates the denominator and destroys the signal, and reopening a met gate erases the completion the burndown just recorded.

**Enforced by.** Prose only.

**Class.** framework

### `K-WORK-7` Milestone issues only, and count issues explicitly

**Rule.** Never put a pull request on a milestone. Every search that counts issues says `is:issue`.

**Why.** GitHub counts pull requests in a milestone's open and closed totals and in unqualified searches, so milestoned PRs silently inflate the burndown. In the reference adopter one milestone read 44 through the API when it held 38 real issues.

**Enforced by.** The issue backstop takes the milestone off a pull request as soon as one is set, a fork's pull request included, on `pull_request_target: milestoned` ([`scripts/issue-backstop.mjs`](../scripts/issue-backstop.mjs)). It reads only that number's milestone and whether it is a pull request. [`tests/unit/search-scope.test.ts`](../tests/unit/search-scope.test.ts) fails when a search Kanon's scripts, workflows, lane prompts, skills or playbooks send can count pull requests with issues: a `search/issues` or GraphQL issue search whose query says neither `is:issue` nor `is:pr`, or `gh search issues --include-prs`. A repository that doesn't run the backstop keeps the first half as prose, and an adopter's own searches are prose only.

**Class.** framework

### `K-WORK-8` The routing rule has one home

**Rule.** The milestone-routing rule (`K-WORK-4`, `K-WORK-5`, `K-WORK-10`, `K-WORK-11`) is implemented in exactly one place, a shared filing skill or script, and every agent and automation that files an issue calls it. No agent prompt, playbook or workflow carries its own copy. This is the work-items instance of `K-PRIN-2` (ADR 0004 §3).

**Why.** Routing is the rule most tempting to restate, because every filing agent needs it. In the reference adopter a routing table and four prompts once disagreed for a day, caught only by eye, and the workarounds (grep for positional references before renumbering a table; change every copy in the same edit) managed the copying rather than ending it.

**Enforced by.** The filing skill, [`skills/file-issue/SKILL.md`](../skills/file-issue/SKILL.md), runs `plan` in [`scripts/issue-triage-defaults.mjs`](../scripts/issue-triage-defaults.mjs), the module whose `decide()` the issue backstop runs, so the filer and the backstop route by one copy of the rule. `tests/unit/filing-skill.test.ts` fails when the skill stops running `plan` or passes a flag `plan` doesn't take, and when the prompt of a lane that files through the skill restates the routing: a bucket's name, a milestone of its own, or the `gate-candidate` rule. The test fails, too, when any agent prompt in a Kanon lane workflow that files an issue doesn't send its agent to the skill or restates the routing, and it holds the playbook section each filing lane reads to restating no routing: the code audit's "Code-reading mode", verify-acs's "Targeted-invariant mode", and the Reviewer's "Capturing follow-ups", which merge reconcile reads too, in Kanon's own playbook and in the baseline. The Lead's reconcile tick files from code: it calls `plan` with each brief item's milestone as the one it transcribes, and `tests/library/lead-reconcile.test.ts` fails when an issue it creates takes its labels or milestone from anywhere else. Three of Kanon's scripts that file without an agent, the Overseer's filer, the workflow-health check and the telemetry Explorer's filer, call `plan` directly, which `tests/unit/script-filers-plan.test.ts` holds them to; an adopter's own filers are prose only: they can point at the skill.

**Class.** framework

### `K-WORK-9` Every review follow-up carries a severity, set by the filer

**Rule.** Every follow-up a reviewer files carries exactly one `sev:*` label, applied by the filer, rated by evidence of impact:

| Severity | Meaning |
|---|---|
| `sev:critical` | Data loss, a security or isolation breach, or an outage. |
| `sev:high` | A core flow is broken and there is no workaround. |
| `sev:medium` | Degraded, but a workaround exists. |
| `sev:low` | Cosmetic. |

**Why.** Severity is a claim about reachability and impact, and that evidence lives in the diff and its callers, so only the filer can make it. It cannot be inferred later from the issue's prose. When the reference adopter measured, 2 of 149 reviewer follow-ups carried any severity, so a hole letting anyone register for free sorted exactly like a stale comment. Rate by evidence, not by confidence.

**Enforced by.** The issue-opened automation labels a severity-less reviewer follow-up `qa:needs-severity` and comments on it. A filer through the planning module's `plan` can't file one without a severity: `plan` refuses it, so the Lead's reconcile tick stops on such a brief item and the brief guard reports it on the brief's pull request. The rubric itself is prose only.

**Class.** framework

### `K-WORK-10` A gate-severity follow-up is a `gate-candidate`, not a gate item

**Rule.** A `sev:critical` or `sev:high` reviewer follow-up also gets the `gate-candidate` label, and **stays in its bucket**. The **Stakeholder** decides whether it joins the launch gate. Never inflate a severity to reach the gate: `sev:medium` means a workaround exists, which is what "not launch-gating" means.

The label comes off when the Stakeholder has decided, either way:

- **Placed:** the issue is on a roadmap milestone, open and with a due date (`K-WORK-3`). The placement is the record (`K-WORK-22`).
- **Declined:** the issue carries `gate:declined`, which only a person applies. It stays on the issue as the record of the decision.

So the queue, `is:issue is:open label:gate-candidate`, holds only candidates awaiting a decision. Placed reads as a roadmap milestone, declined as `gate:declined`. An issue that is both placed and declined keeps `gate-candidate` until the Stakeholder resolves it. Agents only ever add `gate-candidate`, and never apply `gate:declined` or write the milestone: taking the label off transcribes a decision, it doesn't make one.

**Why.** The filer is qualified to claim severity but not placement (`K-WORK-5`). The label keeps the signal visible as a queue that a human works through, and puts the human step only on the highest-severity items, where it is cheapest to justify. Without an exit, the queue only grows: a candidate the Stakeholder already ruled on reads exactly like one still waiting, and a digest lists a declined `sev:critical` as its top line for good. The decline is a label rather than a comment because a sweep reads it from the same list it finds the candidates in, with no prose to parse, and the Stakeholder can apply it without write access (Triage, chapter 03's role table).

**Enforced by.** The issue-opened automation adds `gate-candidate` to a gate-severity reviewer follow-up that lacks it; it fires on `opened` only, so it never re-adds a label the exit removed. The Lead's daily dispatch sweep removes `gate-candidate` from each open issue that is placed or declined, and reports a contradictory one ([`scripts/gate-candidate-exit.mjs`](../scripts/gate-candidate-exit.mjs)); the weekly digest lists only candidates awaiting a decision, reading the same predicate. A test fails when Kanon's lanes, scripts or prompts name `gate:declined` anywhere but that script, or when the script writes anything but the removal. Not inflating severity is prose only.

**Class.** framework

### `K-WORK-11` Streams never become gate candidates

**Rule.** Two kinds of work are never gate candidates and never go on a roadmap milestone, at any severity: **bugs filed by the Explorer**, and **pipeline work**.

**Why.** Both are ongoing streams. An incoming bug stream on the gate would wreck the burndown, since the gate could never be finished. Pipeline work is ongoing improvement however severe an instance of it is, so it belongs in the platform bucket (`K-WORK-4`).

**Enforced by.** A label guard fails when the Explorer's lane applies `gate-candidate` or a roadmap milestone, checked both statically and against the live repository. For pipeline work, which `plan` in [`scripts/issue-triage-defaults.mjs`](../scripts/issue-triage-defaults.mjs) knows by the `pipeline-improvement` label or the pipeline subject, `plan` refuses a roadmap milestone, never makes it a candidate, and refuses a `gate-candidate` label the rule doesn't give. It refuses the product bucket too (`K-WORK-4`), so nothing `plan` files is a candidate to the backstop, which reads the labels and never the subject. The filing skill, [`skills/file-issue/SKILL.md`](../skills/file-issue/SKILL.md), runs `plan`, and the Lead's reconcile tick calls it for each brief item, so neither a filer through the skill nor the tick can file pipeline work on a roadmap milestone or the product bucket: the tick stops on such a brief item, and the brief guard reports it on the brief's pull request (`tests/library/lead-reconcile.test.ts`, `tests/library/brief-guard.test.ts`). Filers not on the skill, and a person placing pipeline work on one by hand, are prose only.

**Class.** framework

## Labels

### `K-WORK-12` Use the fixed label taxonomy

**Rule.** Labels are the queue and the lane triggers, and every adopter uses the same set, with the same colours and descriptions. Installation creates all of them, and deletes GitHub's default labels that aren't in the taxonomy (`documentation`, `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`). `bug` and `enhancement` are defaults that are in it. A lane that is about to apply a taxonomy label the repository lacks creates it first, with the table's colour and description, and says so in its run summary. A name outside the taxonomy is never created: it fails by name, and nothing is created.

| Family | Label | Colour | Description |
|---|---|---|---|
| Agent | `agent:explorer` | `6f42c1` | Filed by the Explorer |
| | `agent:triage` | `6f42c1` | Dispatches the Implementer's bug-fix lane |
| | `agent:implement` | `6f42c1` | Dispatches the Implementer's build lane; marks the PRs it opens |
| | `agent:reviewer` | `6f42c1` | Filed or reviewed by the Reviewer |
| | `agent:overseer` | `6f42c1` | Filed by the Overseer |
| | `agent:revise` | `5319e7` | Re-delivers a skipped review or a red approved head to the revise lane (Lead, Merger, Implementer) |
| | `agent:lead-revise` | `5319e7` | Re-delivers a lost review to the Lead's brief-revise lane; applied by the Lead only |
| Triage state | `qa:needs-triage` | `1d76db` | Bug filed, awaiting the Implementer's triage |
| | `qa:reproduced` | `0e8a16` | Independently reproduced: confirmed real |
| | `qa:cannot-reproduce` | `5319e7` | The Implementer could not reproduce it |
| | `qa:false-positive` | `e99695` | Not a real bug (feeds precision metrics) |
| | `qa:fix-proposed` | `0052cc` | A fix PR is open and linked |
| | `qa:needs-info` | `fbca04` | A human owes an answer or parked the issue; parks its project and its implement lane |
| | `qa:needs-severity` | `fbca04` | Reviewer follow-up filed with no severity; the filer must set one |
| | `qa:needs-split` | `d4c5f9` | Implementer run hit its cap; the Lead proposes a split; never dispatched |
| | `qa:human-action` | `c5def5` | Project item a human must do (not a PR); never dispatched, does not park the project |
| | `qa:verify` | `0e8a16` | Project verification issue: the Explorer verifies the project's acceptance criteria |
| Severity | `sev:critical` | `b60205` | Data loss, a security or isolation breach, or an outage |
| | `sev:high` | `d93f0b` | Core flow broken, no workaround |
| | `sev:medium` | `fbca04` | Flow degraded, workaround exists |
| | `sev:low` | `0e8a16` | Cosmetic or minor |
| Kind of item | `bug` | `d73a4a` | Something isn't working |
| | `enhancement` | `a2eeef` | New feature or request; also a product project's tracking issue |
| | `spec-delta` | `c5def5` | Proposed behavioural invariant (the Explorer's second output) |
| | `follow-up` | `c5def5` | Deferred work captured from a review or audit |
| | `pipeline-improvement` | `5319e7` | Improvement to the pipeline itself; also a platform project's tracking issue |
| | `capability` | `006b75` | Capability investigation: the cohort the Overseer's interlock counts |
| Signal that produced a finding | `signal:spec-violation` | `fef2c0` | Contradicts a promoted behavioural invariant |
| | `signal:security` | `b60205` | A security anti-pattern the code audit cites: credentials, secret compare, isolation, injection |
| | `signal:contract` | `fef2c0` | A consumer or structural contract the code audit cites the code contradicting |
| | `signal:<name>` | `fef2c0` | One per objective signal on the project's list (`K-AGENT-9`); `b60205` for a security signal |
| Review and escalation | `review:please` | `d4c5f9` | Asks the Reviewer to review this PR |
| | `gate-candidate` | `d93f0b` | Filer says launch-gating (sev:critical or sev:high); the Stakeholder decides if it joins the gate |
| | `gate:declined` | `cfd3d7` | The Stakeholder declined this gate-candidate for the gate; applied by a person only |
| | `needs:human` | `d93f0b` | A human decides: the Merger declined this PR, the Lead held this project, or a review deferred it |
| | `decision:needed` | `e4e669` | A person owes a decision asked in a comment here; removed once the answer is recorded (K-WORK-24) |
| | `lead:file-only` | `c5def5` | On a project's tracking issue: the Lead files and reconciles its issues but dispatches none |
| | `blocked` | `b60205` | Waiting on something outside the pipeline; parks the issue's whole project |
| | `test:characterization` | `c2e0c6` | A person says the PR's tests lock behaviour already right: red-test skips; applied by a person only |
| Project membership | `project:<n>` | `bfd4f2` | Project #n: mirrors the marker while the project is open; written by the Lead only |
| Untrusted intake | `from-app` | `ffd200` | Filed from the running application; never dispatched |
| Release tool | `autorelease: pending`, `autorelease: tagged` | `ededed` | Created and applied by the Releaser only |

`qa:needs-info` is also the implement lane's park marker. A human who parks an issue by hand ("built by hand, do not re-dispatch") adds it and may keep `agent:implement`; neither the Lead nor the dispatch sweep dispatches an issue carrying it. The sweep's own stop applies the same label, so there is one marker for "a human has this", not two.

Two families have no members at installation. A `signal:<name>` label is created with the project's signal list, and `project:<n>` is created by the Lead the first time it files for project `<n>`. `signal:spec-violation` is fixed, because the project reconciler reads it, and so are `signal:security` and `signal:contract`, because the code audit applies them in every repository: the first to a security anti-pattern (its second gate), the second to a consumer or structural-contract contradiction (its first and third). The release tool's labels are created by the release tool.

**How the `agent:` labels map to the roles.** The labels mark lanes, not identities, so they don't map one-to-one onto chapter 03's roles:

| Role | Its `agent:` labels | Why |
|---|---|---|
| Explorer | `agent:explorer` | What it files. |
| Implementer | `agent:triage`, `agent:implement` | Two lanes of one role under one App: fixing a reported bug, and building a planned item. Each label dispatches its lane. The fixed job that sets its status also applies `agent:revise`, to re-deliver a changes-request filed on a head before that head had the status, which the revise lane skipped then. |
| Reviewer | `agent:reviewer` | What it files or reviews. |
| Overseer | `agent:overseer` | What it files. |
| Lead | none of its own | Its issues are marked by `project:<n>`. It applies `agent:revise` and `agent:lead-revise`, which are recovery labels: each re-delivers a lost review event to a revise lane (the Implementer's, or the Lead's own), and marks no author. It reads `needs:human` and `lead:file-only` on a tracking issue and applies only the first. |
| Merger | none | It files nothing. It applies `needs:human`, its escalation, and `agent:revise`, to hand an approved head whose checks failed back to the Implementer's revise lane. |

Every label the pipeline applies must be in this table. The table is the authority on what each label is, and [`labels.json`](labels.json) is its machine-readable twin, from which a lane creates a missing label. The live repository is the authority on which labels exist.

**Why.** A lane that applies a label that doesn't exist fails at the moment of filing, after the work is done, so the lane creates it first rather than leave the adopter to create every label by hand and miss one. Only a name from the table is created, so a typo fails instead of becoming a new label. A second list of labels drifts silently and becomes a third opinion about what a label is, unless a test holds it to the table. A fixed taxonomy, with its meanings, is what lets guards check labels at all (ADR 0002). Colours and descriptions are fixed too, so that the same label reads the same on every adopter's board, and a label left over from GitHub's defaults is noise every filer has to decide to ignore.

**Enforced by.** A guard that scans every place the pipeline applies a label (workflows, scripts, issue forms and agent prompts) and fails when one doesn't exist in the live repository. Kanon's own lanes create a missing label before applying it, from [`labels.json`](labels.json), and a test fails when that file and this table disagree, when Kanon's scripts, lanes or prompts apply a label outside it, or when a lane that labels has no create-before-apply step. `kanon init` deletes GitHub's defaults outside the taxonomy, with the person's consent, and [`kanon doctor`](../docs/doctor.md) reports each one a repository still has, when it is run (`tests/unit/kanon-doctor-checks.test.ts`).

**Class.** framework

### `K-WORK-13` An answered item leaves the queue; a waiting one stays

**Rule.** When triage reaches a terminal verdict, remove the queue label. When it hands off and waits (for information, for a human), keep it.

**Why.** Settled issues that keep their queue label sit in the dispatch lane forever and can re-fire an agent on work that is already decided.

**Enforced by.** The re-dispatch sweep reads each lane's terminal-verdict labels and never re-dispatches an issue that carries one, whatever its conversation says. Removing the label itself is prose only, in the triage agent's instructions.

**Class.** framework

## What an issue says

### `K-WORK-14` Separate what must be true from how to fix it

**Rule.** Title an issue as the work, not the symptom. In the body, state **what must be true** (the verified constraint and its evidence), which is the acceptance criteria. Put any proposed remedy under a heading `## Possible approach — UNVERIFIED, not acceptance criteria`, saying what must be checked before building it. Never head it "Suggested fix".

**Why.** A plausible remedy written in an issue gets built as written. In the reference adopter a suggested fix became a regression that passed two green reviews, because both the implementer and the reviewer treated the suggestion as the specification.

**Enforced by.** The filing skill's `plan` command, in [`scripts/issue-triage-defaults.mjs`](../scripts/issue-triage-defaults.mjs), takes the body file as a required `--body` and refuses, by name, a body with no "What must be true" heading, and one with a remedy heading (`Suggested fix`, `Proposed fix`, `Fix`, `Remedy`, `Solution`, or `Possible approach` in any other form) that isn't exactly the fixed one. The Overseer's filer holds a finding whose body fails the same check, and the telemetry Explorer's filer refuses one. `tests/unit/issue-triage-defaults.test.ts` fails when the check stops catching either. The issue backstop doesn't check it: it reads no issue's text (`K-AGENT-45`). Whether the remedy and the constraint are really separated, and an issue a person files, are prose only.

**Class.** framework

### `K-WORK-15` Search before filing

**Rule.** Before filing, search open issues. If one matches, comment on it instead of opening a duplicate.

**Why.** Idempotency. The classic failure of an automated filer is re-filing the same finding every night.

**Enforced by.** Prose only, in each filing agent's instructions.

**Class.** framework

### `K-WORK-16` Re-measure an issue's claims before scoping work from it

**Rule.** Before scoping work from an issue, re-check its claims (line numbers, counts, "X does Y") against the current main branch.

**Why.** Issue bodies are detailed and confident, and they go stale as soon as the code around them moves. Work scoped from a stale body fixes what was true last month.

**Enforced by.** Prose only.

**Class.** framework

## Follow-ups

### `K-WORK-17` File a follow-up only for trackable work, and fold in what is small

**Rule.** File a follow-up only for work someone should eventually do. Keep nits and "confirm this is intentional" in the review. Fold small, in-scope, zero-behaviour work into the open PR, even when it spills into adjacent files. File a follow-up for work that is deferred, changes behaviour, or needs its own design.

**Why.** A follow-up is a promise of future work. A nit filed as an issue is noise in the backlog; a zero-behaviour fix deferred to its own PR costs a whole review cycle to land a few lines.

**Enforced by.** Prose only.

**Class.** framework

### `K-WORK-18` On a follow-up's PR, fix the whole class

**Rule.** When a PR closes a follow-up and its review finds another instance of the same defect, fix every member of that class in the first round. If that is too large, file one follow-up naming the whole class, never one for the next instance.

**Why.** Filing the next link of a chain produces follow-ups of follow-ups indefinitely. In the reference adopter, 37 such issues cost about $525 of agent time in three weeks.

**Enforced by.** Prose only.

**Class.** framework

### `K-WORK-19` Record where a follow-up came from; let the pipeline derive the rest

**Rule.** A follow-up states its origin in the form `Surfaced by PR #N review`. Never hand-write its project membership: the reconciler derives membership from the origin. A reviewer never labels its own follow-up for implementation; a human decides whether and when it is built, either by labelling the issue or by opening the backlog feeder's valve for the repository. An opened valve stays bounded: it is off by default, feeds only a follow-up at `sev:medium` or below, on a named bucket milestone and without `gate-candidate`, and feeds no more while one it fed still holds a slot.

**Why.** A hand-written membership marker pre-empts the derivation and goes stale. Capturing follow-ups is automatic, but dispatching them is gated by a human, so a reviewer cannot put its own findings straight into an implementer's queue. The premise that every follow-up waits on a person's act on that issue no longer holds once a repository opens the feeder: the reviewer's own labels then decide which of its findings are eligible, and the person's act is opening the valve, once, for the whole repository. The bounds are what keep that act a decision rather than a blank cheque: the gate severities, unplanned work and a growing queue still wait on a person.

**Enforced by.** The reconciler derives follow-up membership from the origin line. The backlog feeder checks its own bounds before it labels anything: the valve, the severity, the milestone, the excluded labels and a fed issue still in flight. Not self-labelling is prose only.

**Class.** framework

### `K-WORK-20` Measure the backlog, never set a target for it

**Rule.** Report how fast work arrives (follow-ups per reviewed PR; issues opened minus closed, per week), but never set a target for it, and never propose a fix whose effect is simply "file less". (ADR 0004 §4)

**Why.** A follow-up that isn't filed is a defect nobody sees. A filing target makes the numbers better by hiding problems. An arrival rate above one may be correct, for example while hardening before a launch.

**Enforced by.** Prose only.

**Class.** framework

## Untrusted input

### `K-WORK-21` Untrusted input never reaches a write-capable agent unreviewed

**Rule.** An issue created from untrusted input (such as an in-app problem report) is filed with exactly one label marking its origin, is never dispatched to an agent automatically, and waits for human triage. Its user-supplied text is fenced with explicit begin and end markers.

**Why.** Text written by an outside reporter is a prompt-injection surface. Human triage keeps it away from agents that can write to the repository, and the fence tells every later reader which text is untrusted.

**Enforced by.** A unit test that fails when the intake path applies more than one label, and a unit-tested escape for the fenced text.

**Class.** split. The rule that untrusted input is fenced and never auto-dispatched is framework. **The project supplies:** its intake channels.

### `K-WORK-22` A `gate-candidate` joins the launch gate only on the Stakeholder's decision

**Rule.** Moving a `gate-candidate` onto the launch gate requires the Stakeholder's decision, recorded on the issue, as either the Stakeholder's own action or comment, or the Maintainer's attestation naming the Stakeholder (`K-PRIN-18`). Open gate candidates appear in the Stakeholder's digest as decisions waiting for them.

**Why.** The filer may claim severity but not placement (`K-WORK-10`), and placement on the launch gate is roadmap placement. A queue that only the Maintainer works through is a Stakeholder decision made by the wrong person.

**Enforced by.** Prose only; a guard is planned.

**Class.** framework

### `K-WORK-23` A tracking issue and a planned item carry the kind label of their work

**Rule.** A project's tracking issue carries the kind label of the work the project does: `enhancement` for product work, `pipeline-improvement` for platform work. It goes in the matching bucket, filed in one call (`K-WORK-2`). It is identified as a tracking issue by its brief, `docs/projects/<n>.md`, never by a label, and it never carries `project:<n>` itself. A planned item in a brief's decomposition carries a kind label too: `enhancement` for a new feature, `bug` for a defect, `pipeline-improvement` for platform work.

**Why.** An issue with no kind label is invisible to every query that counts work by kind, and a tracking issue has no other kind of its own. A dedicated "tracking" label would be a second way to find a project, next to the brief file the reconciler already reads, and the two could disagree.

**Enforced by.** The brief guard reads each brief's tracking issue, issue `<n>` for `docs/projects/<n>.md`, and fails when it has no kind label or both, isn't on the bucket its kind goes in, or carries `project:<n>`. A read that fails is a finding, not a pass ([`tests/library/brief-guard.test.ts`](../tests/library/brief-guard.test.ts)). It checks too that each decomposition item names its labels (`K-PROJ-9`). Which kind a project's work is stays prose only.

**Class.** framework

## Asking a person

### `K-WORK-24` Record a decision on GitHub before asking it, and label the thread `decision:needed`

**Rule.** Before an interactive session, or a subagent it starts, asks a person for a decision, in chat or anywhere else, it posts the decision as one comment on the issue or pull request the decision concerns, in the fixed form, and adds `decision:needed` to that issue or pull request. A decision with no thread of its own goes on the tracking issue of the project it belongs to. The form is a first line `<!-- kanon:decision-needed -->`, then three parts, each opening a line: `**Question.**`, `**Options.**` and `**Recommendation.**`. When the person answers, in chat or on GitHub, the agent records the answer on the same thread, as a comment whose first line is `<!-- kanon:decision-answered -->` with `**Decision.**` and `**Decided by.**`, and removes the label. A decision asked only in chat is never asked. An App-run agent's post opens with its persona header (`K-AGENT-1`), so in its ask or answer the marker is the line after that header, and the two rules hold together. A lane escalates in its own records, `needs:human`, `qa:needs-info`, a scope-first bail and a brief's open decisions, and they stay; a lane posting this ask beside them, when its escalation needs the Owner's decision, is planned. Which decisions go to a person at all is `K-PRIN-3`'s to say, not this rule's.

**Why.** A decision asked only in a conversation lives in that conversation's memory, and a session's memory is lossy: its context is compacted, a subagent's hand-back carries only what it chose to carry, and a session that ends takes its open questions with it. Decisions asked that way were forgotten, by the agent that asked and by the person asked, and found again only when the work they blocked was found stuck. A comment in a fixed form is still there after any session, says enough for a person to decide without the session that asked, and is where the answer is recorded for the next agent to read. The label is what makes the open ones findable by a query rather than by recall, and taking it off is what closes the question. It is a label of its own, not `needs:human`, because `needs:human` already means a hold the pipeline placed, which a person clears on their own schedule, while this one is a question an agent is waiting on now.

**Enforced by.** [`kanon inbox`](../docs/status.md#the-inbox) lists each open thread labelled `decision:needed` with the link of its latest ask, and reports a labelled thread with no ask in the form, and one whose answer was recorded with the label left on, and reads an App-run agent's marker on the line after its header ([`tests/library/status-inbox.test.ts`](../tests/library/status-inbox.test.ts)). [`scripts/lib/decision-asks.mjs`](../scripts/lib/decision-asks.mjs) writes both forms. Asking on GitHub before asking in chat, and removing the label, are prose only, in the inbox skill an agent loads when it asks.

**Class.** framework

### `K-WORK-25` Read what waits on a person from the repository, when asked; never keep it, and never push it

**Rule.** Which pull requests are ready for a person's merge, and which decisions wait on a person, are computed from GitHub when someone asks, by `kanon inbox`, and never kept in a session's memory or in a list an agent maintains. A pull request is ready for a person's merge when [the readiness view](../docs/status.md#the-pull-request-readiness-view) says so, and only then; its definition is the view's, and not restated here. A pull request carrying `decision:needed` whose ask is not answered is not ready, and is listed only among the decisions, since merging it would pre-empt the answer. An agent asked what waits on a person answers by running `kanon inbox`, never from recall. Nothing sends the inbox to anyone: it is read when asked.

**Why.** A list a session keeps of what is ready or waiting is a copy of the repository's state, and it drifts the moment anything changes: a push makes an approval stale, a red check lands after the list was written, a person merges what the list still offers. Every session that keeps one keeps it its own way, and none of them survives the session. Computing the answer each time costs a few reads and can't be stale. The definition of ready is the readiness view's, which judges with the merge gate's own functions, so the inbox can't call a pull request ready that the gate's checks would refuse, and a test holds each part of it. It is one definition in every view, so a conflicting pull request, which can't be merged as it stands, is ready in none of them. The inbox is pull-only because a solo developer or a small team asked to be reminded of their own backlog learns to ignore the reminder; what they need is one place that is right when they look.

**Enforced by.** `kanon inbox` and the readiness view's tests, which fail when any part of the definition of ready changes: a check that counts, none running, cancelled or failed, no conflict, an approval stamped with the head and not an older commit, nor a request for changes or a comment, no unanswered decision asked on it, and an open pull request only ([`tests/library/status-inbox.test.ts`](../tests/library/status-inbox.test.ts), [`tests/library/status-readiness.test.ts`](../tests/library/status-readiness.test.ts)). Answering from the command rather than from recall is prose only, in the inbox skill.

**Class.** framework

## Examples from the reference adopter

- **Milestone names.** The current launch gate is called *Production Ready*. A second roadmap milestone, *AI Capabilities*, is an epic that only the stakeholder routes to. An earlier gate, *Development Ready*, was met at 11 of 11 and closed; new platform work went to the bucket rather than reopening it.
- **Untrusted intake.** In-app problem reports are filed by a non-agent App with only the `from-app` label, and the App can apply no other label and trigger no agent.
