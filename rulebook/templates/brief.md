# Project brief — `<tracking issue title>`

> **This file is the template, not a project.** Its leading `_` (as `docs/projects/_template.md`) is how everything that reads `docs/projects/` tells apparatus from a brief. A brief's file name **is** its tracking issue number, `docs/projects/<n>.md`, because the reconciler and the digest find a project by that number; a brief named by a slug is never reconciled (`K-PROJ-2`). Copy this file to `docs/projects/<n>.md` and replace every section.
>
> **The standard behind each section is chapter 07 of the Kanon rulebook, and the exact syntax is chapter 11** (`K-LAYOUT-12`, `K-LAYOUT-13`). The brief guard runs against this file too, so the template is held to the standard it teaches (`K-PRIN-11`).
>
> **A brief decides and decomposes. It does not measure** (`K-PROJ-3`):
>
> - **No file-and-line coordinates.** Cite the spec id that states a behaviour, or the command that re-derives a fact. A name and a command survive the next refactor; a line number is true of one commit and silently wrong of every later one.
> - **Acceptance criteria live in the spec layer.** Cite a `[PREFIX-N]` id; never restate the criterion beside it. A restated criterion has two homes and no owner (`K-SPEC-4`).
>
> **A brief is immutable once approved.** It is a decision record, not a wiki. A correction after the merge is an issue or a spec edit. The two sanctioned exceptions are a mechanical repair and a **split**, where the Lead replaces one item whose implementer run hit its cap with smaller children (`K-PROJ-10`).
>
> **Aim at about 300 lines.** Not a limit, a signal. Past it, ask which paragraph is measurement that belongs in a command, or a criterion that belongs in a spec clause.
>
> **Section numbering, wording and order are yours.** The guard matches each section by its key phrase, so `## 5. Cost — no delta, and why` counts, and combining two sections under one heading is good writing where they are one story. What is not yours is *omitting* one: an omitted section reads exactly like a section with nothing to say. Write "none, because…" instead.
>
> **One heading is not yours: `## Decomposition`.** It may be numbered, but it carries nothing else. `## 3. Decomposition — the five issues` reads as *no decomposition at all*: nothing is filed and the project reports healthy.

---

## 1. The real problem

Read the code before you plan, and say what you found. **Every claim carries evidence that can be re-run**: the command that produces a count, or the `[PREFIX-N]` invariant that states the behaviour (`K-PRIN-14`). If the issues in the mandate are symptoms of one root cause, say so and plan the root-cause fix; one systemic fix beats N point fixes. If they genuinely are separate problems, say *that*, and say what you checked to conclude it.

This section is where a brief earns the approver's trust, because a command they can paste is the only part of a plan they can falsify cheaply.

## 2. Scope

What this project is and, in its own paragraph, **what it is not**. The boundary is the half that gets forgotten, and it is what a reviewer will otherwise argue one pull request at a time. Name the adjacent work you are leaving alone, with a sentence on why it is separable. Where something is out of scope only *for now*, say what would bring it back in.

What is specific to this project's definition of done (a follow-up filed rather than fixed, a `[seed]` clause left unpromoted, a verification a human still owes) is a scope boundary too, and belongs here.

## 3. Decomposition

One `###` sub-heading per issue. **This is the only machine-read part of the brief.** The metadata lines are consumed, and everything else under an item is filed verbatim as the issue's body.

**Acceptance criteria are `[PREFIX-N]` ids, one per bullet, leading the bullet.** Where the invariant does not exist yet, allocate its id with the allocator and write it into the area's spec as `[seed]` (`K-SPEC-3`, `K-SPEC-5`). A deliverable gets a clause too: a criterion nothing can cite is one nothing can verify.

### Issue A — Short imperative title

**Milestone:** Development Automation · **Labels:** `pipeline-improvement` · **Closes #\<n>**

Acceptance criteria:

- `[AREA-1]` — the criterion this issue takes on, named by its id.
- `[AREA-2]` — a second one, seeded in this project's own spec edit.

Not in this issue: the boundary again, per issue. This is what stops an implementer widening the diff.

### Issue B — The one that has to wait

**Milestone:** Product Backlog · **Labels:** `enhancement` · `sev:high`
**Depends on:** Issue A (its change is what this reads)

Acceptance criteria:

- `[AREA-3]` — the criterion this issue takes on.

### Issue C — What it costs to run

**Milestone:** Product Backlog · **Labels:** `enhancement` · `qa:human-action`
**Depends on:** Issue B

- **Measures:** the monthly cost of one environment at idle — `<the command that produces it>`

A measurement item's deliverable is the number and the command that produced it, posted on its issue (`K-PROJ-16`). This one needs cloud access, so it also carries `qa:human-action`.

**Sequencing lives on the `Depends on:` line, not in a section of its own.** The reconciler holds an item until its dependencies close, so the parenthetical reason is the sequencing rationale, and it is enforced rather than advisory. A dependency must name an item this decomposition declares, and the graph must be acyclic.

**What the parser holds you to** (`K-LAYOUT-12`), each of which stops a tick rather than degrading quietly:

- **The milestone is required**, chosen by the routing rules (`K-WORK-4`, `K-WORK-5`).
- **Labels** are applied at creation, and added (never replaced) on adoption. Separate them with `·` and keep prose off the label run.
- An item whose deliverable is **not a pull request** carries `qa:human-action`. It is never dispatched, does not park the project's other items, and is closed by a human with its evidence recorded on the issue (`K-PROJ-9`).
- **`Closes #<n>`** adopts an existing issue instead of filing a new one, and is read **only** from the metadata line. Written anywhere else it is not adopted, and a duplicate is filed.
- **`Depends on:`** cites items by letter. Only the leading run of `Issue X` references counts.

## 4. Cost

**Price it, or declare that there is nothing to price.** A dollar figure, including `$0`, is the commonest answer; an explicit `no delta`, with the reason, is the other acceptable form (`K-PROJ-6`). The Owner's agreement comes *before* spend (`K-OBS-9`), and a number nobody wrote cannot be agreed to.

Price each environment the change reaches, then multiply by the number of environments it is deployed to. A new alarm or custom metric has a price. Any recurring schedule that wakes a scale-to-zero resource carries its own estimate: tick frequency, extra wakes per day, and the monthly delta (`K-OBS-10`).

## 5. Observability

**Add or skip, with a reason, in the project's own terms**: name the signal, the alarm, or the row in `docs/observability.md`'s not-paged table you are deciding about (`K-OBS-1`). A deliberate skip is a fine answer and an absent one is not.

Deciding **not** to page is a decision and has a home: a signal that fails the admission rule (`K-OBS-4`) goes in the not-paged table with the trigger that would change the answer (`K-OBS-3`).

## 6. Blast radius — what will need a human

Name every item in `docs/qa/escalation-paths.md` this project will touch: its escalation paths and its bail list (`K-LAYOUT-8`). These are otherwise discovered mid-PR, which turns one up-front decision into N interrupts, and avoiding that is the whole premise of the brief.

Also name the softer ones: anything touching the pipeline itself, and anything a reviewer will escalate rather than approve.

**Reconciliation gaps belong here as issues, not as a survey.** The spec coverage report already says which areas have a spec and which `[confirmed]` invariants no test enforces. If it names a gap in an area you touch, closing it is **Issue A of this project** (`K-SPEC-5`): an acceptance criterion citing an invariant nothing checks is not falsifiable.

## 7. Decisions

The questions that need a human, numbered, each with the options and your recommendation. **This merge is the only time they are asked**, so a question left implicit here becomes an interrupt later, or an agent's silent guess (`K-PROJ-1`).

Include anything that raises spend (the Owner's), anything that changes what pages or what an agent may do (the Owner's), anything that chooses the product's behaviour or a project's closure rule (the Maintainer's or the Stakeholder's), and anything that places work on a roadmap milestone (the Stakeholder's, `K-PROJ-14`). The Lead may settle a purely technical decision itself, and says so (`K-PROJ-18`).

**Write each one as a numbered item whose headline is bold, and mark it answered** (`K-LAYOUT-13`). The guard reads the headline, not the prose under it, and fails the build while any decision is still open:

1. **The question, once ruled. ✅ ANSWERED (Maintainer): what was chosen, and why.** Put the argument, the options and the rejected alternative in prose here; the guard reads only the bold headline above. Record where the answer was *carried*, because a decision that changed nothing downstream is indistinguishable from one nobody applied.

While a decision is still open, its headline carries an open mark instead: `⛔ OPEN`, `PROPOSED`, `TBD`, `UNANSWERED`, or *awaiting the Owner*, *awaiting the Maintainer* or *awaiting the Stakeholder*. The brief does not merge until `✅` or `ANSWERED` replaces it. A human answers by editing the headline on the brief's own branch; an answer given in a review comment is transcribed there by the Lead (`K-PROJ-17`). **The uppercase marks are case-sensitive**: lowercase *open* and *proposed* are ordinary words in prose, so write them shouted. Both `N. **…**` and `**N. …**` are read as items.

*(This section is why the template itself passes the brief guard: its one example decision is answered.)*

## 8. What I did not examine

A brief that is silent on an area reads identically to one that checked it and found nothing (`K-PRIN-8`). List what you could not read, what you inferred rather than verified, which numbers carry a command that was written but not run, and where you ran short of budget.

This section is never empty. If you genuinely examined everything the mandate touches, say so and name the boundary you drew.

*(The definition of done is not a section: it is the same for every project, `K-PROJ-11`.)*
