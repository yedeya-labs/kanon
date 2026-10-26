---
name: mandate
description: Turn a product idea or document into the mandate a Kanon project starts from, the body of its tracking issue, and see the project through its brief's pull request. Measures the input's claims against the code first, asks the product questions the Lead may not answer itself, sorts each answer, writes the mandate in a fixed shape, asks whether the project starts as soon as its brief merges, creates the roadmap milestone the Stakeholder asks for, files the tracking issue and dispatches the Lead's brief lane. On the brief's pull request, it finds the decisions the Lead marked answered that a person must make, helps the person rule on them, posts the rulings as one comment, dispatches the Lead's revise lane with a reset, and checks that every ruling landed. Use when the person wants to start a project, plan a large feature with the Lead, or answer the decisions on a brief's pull request.
disable-model-invocation: true
---

# Write a project's mandate

You help a person start a Kanon project. The mandate is what a person asks the Lead to plan, and it lives in one place: the body of the project's tracking issue (`K-PROJ-15`). The Lead turns it into a brief, the person's one decision on the whole project (`K-PROJ-1`). A product question the mandate leaves implicit comes back as an open decision on the brief's pull request, or, worse, as a confident plan built on a false premise. So you find those questions first, while each costs one answer rather than a revise round.

The skill has two parts. **The mandate** (steps 1 to 8) runs from the person's idea or document to a filed tracking issue and a dispatched Lead. **The brief's pull request** (steps 9 to 16) runs from the Lead's brief to the person's merge. The person may start at either: with an idea or a document, or by naming a brief's pull request or its tracking issue.

**You carry method, not rules.** Every rule you apply is in Kanon's rulebook or in the repository's own instructions, and you cite it by its id and never restate it (`K-PRIN-2`). Kanon's lanes don't load this plugin, so nothing here reaches the Lead as an instruction: what the Lead reads is the mandate, the brief template and the repository.

## Where the rules are

- **Kanon's rules, at the release the repository runs.** Read the release from the `yedeya-labs/kanon` references under `.github/` (each `uses:` line's `@vX.Y.Z`, or a `candidate-vX.Y.Z`), and read the chapters you need at that release, never at `main`: `gh api 'repos/yedeya-labs/kanon/contents/rulebook/07-projects.md?ref=<release>' --jq .content | base64 -d`, and the same for `01-work-items.md`, `03-agents.md` and `08-observability-and-cost.md`. These are the rules the brief guard and the lanes will hold the project to. Before citing an id, read its rule there.
- **The repository's own content.** `AGENTS.md` and `CLAUDE.md` at the root, and any rulebook or playbook they point to; the adoption record, `docs/qa/adoption.md`, which names the Owner, the Maintainer and the Stakeholder; the escalation paths, `docs/qa/escalation-paths.md` (`K-PROJ-6`); the stack document, `docs/qa/stack.md`; the observability document, `docs/observability.md`, with what pages and what doesn't (`K-OBS-2`, `K-OBS-3`); the Lead's playbook, `docs/qa/lead-playbook.md`, where it exists; the brief template, `docs/projects/_template.md`; and the milestones, `gh api 'repos/<owner>/<repo>/milestones?state=open' --jq '.[] | {title, due_on}'`.
- **Cost rules, paging rules, milestone names and stack facts are the repository's, never this skill's.** Ask the repository's own files which questions its rules imply. When a fact the mandate needs isn't written anywhere, such as what a resource costs or who operates a service, that is a gap in the repository's rulebook: tell the person, put it under "Constraints to verify", and never fill it from memory or from another repository.

## Ground rules

- **Never merge.** Never approve or merge the brief's pull request, never push to the default branch, and never push to the Lead's branch. The Lead writes the brief; a person merges it.
- **Never print a secret.** Never run `gh auth token`, and never echo or print an environment variable that holds a token.
- **Only a person can** answer what the rulebook gives a person to decide: spend, agent authority, product behaviour, a closure rule, paging and roadmap placement (`K-PROJ-1`, `K-PROJ-18`). You ask, and record the answer with the role that gave it. Never answer one yourself, and never take one from the input document as decided until the person confirms it.
- **Never post a review from the person's token.** The token `gh` uses here is the person's, so a review would be their verdict on the brief, and would start the Lead's ordinary revise round, which reads a changes-request rather than a ruling. Rulings go as one pull request comment (step 13).
- **Explain, then ask, then act.** Show the person the draft mandate before you file it, the ruling comment before you post it, and what a dispatch costs before you run it.

## How to ask

- **In Claude Code, ask with its question tool** (`AskUserQuestion`): multiple choice, up to four questions at a time, two to four options each. **The recommended option comes first,** its label ending in `(Recommended)`, and **each option's description says what choosing it does** to the plan, the estimate or what the brief must decide. A value only the person can give (an amount, a name, a date) is the tool's own free-text answer.
- **In another agent client,** ask with its own multiple-choice question in the same shape, or write the options as a numbered list in one message, the recommended one first and marked, and wait for the answer.
- **Never fill in an answer the person didn't give or confirm.** Where the input or the repository already answers a question clearly, show that answer and ask the person to confirm it, rather than asking it again from scratch.

## The mandate

1. **Take the input.** Read the person's idea or document in full. Find the release the repository runs and read the rules there ("Where the rules are"). Check that the repository runs the Lead: a caller of Kanon's brief lane, `.github/workflows/agent-lead.yml` by Kanon's name (`gh workflow view agent-lead.yml -R <owner>/<repo>`). Without one, say so: you can still write and file the mandate, and the person installs the Lead's lanes with the upgrade or adopt skill before step 8.

2. **Measure every claim before you ask anything** (`K-WORK-16`). Fetch the default branch and re-measure each claim the input makes about the code: that something exists or can be reused, a count, a file, a module, a service, how something behaves today. Where the input cites a commit or a snapshot, say how far behind the default branch it is (`git rev-list --count <its commit>..origin/<default branch>`). Report each claim that doesn't hold first, with the command that shows it and what it changes in the plan or the estimate. Also report what the input assumes without saying, when the code shows it isn't there: a public form with no abuse protection, a mail or payment provider still in a test mode, a permission nobody grants. A false premise found here costs one question; found in the brief, it costs a revise round.

3. **Ask the questions.** Work through each category below that the project touches, and skip one it doesn't, saying why. Take each category's content from the repository's own rules ("Where the rules are"), never from this skill. Ask in rounds, and after each round say what the answers changed in the plan and the estimate, so the person sees it now rather than in the brief.

   | Category | What to find out |
   |---|---|
   | Money movement | Whether money moves, through which provider, and who owns the account, the customer record and the refunds. |
   | Tenancy and data ownership | Whose data each new record is, who may read it, and what isolation the repository's stack document requires. |
   | Identity and auth | Who signs in, through which existing identity, and what each role may do. |
   | Public or unauthenticated surfaces | Any form, endpoint or link that works without signing in, and its protection from abuse and spam. |
   | Cost | Every new resource, paid service and recurring schedule, priced as the repository's rules price them (`K-OBS-9`, `K-OBS-10`); the Owner agrees spend before it is incurred. |
   | Observability | For each new failure mode, page or skip (`K-OBS-1`), against the repository's paged signals and not-paged table, so an overlap is visible (`K-OBS-4`). |
   | Human-gated work | Each item of `docs/qa/escalation-paths.md` the project will touch, such as a schema change, payments or authentication code, or a destructive change (`K-PROJ-6`). |
   | Who operates it | Who runs, supports and answers for the feature once it ships, and whether that is a new duty for someone. |
   | Phasing | What ships first, what waits, and how the phases sit against the repository's current launch gate (`K-WORK-6`). |
   | Milestone placement | Whether the work goes on the buckets, on an existing roadmap milestone, or on a new one created for this project, with its title and due date: the Stakeholder's decision (`K-WORK-5`, `K-PROJ-14`). |

4. **Sort every answer into exactly one of three.**
   - **Decided**: the person answered it. Record what was chosen, the role that decided it, as the adoption record names the roles, and the date, so the Lead does not reopen it. When the person isn't the role that owns the decision, such as a roadmap placement that is the Stakeholder's, record it as the person attesting that role's decision, naming the role and when or where it was agreed (`K-PRIN-18`), or leave it open.
   - **Open, a business decision**: nobody can answer it yet, such as an amount, a policy or a legal owner. The brief must make it configurable and say which phase it gates.
   - **For the Lead to verify**: a fact the brief has to measure, with the command or the question that settles it.

5. **Write the mandate** in this shape, every heading present, and "None." under a heading with nothing in it:

   ```markdown
   ## Goal
   ## What must be true
   ## Decisions made
   ## Decisions open
   ## Constraints to verify
   ## Plan and estimate
   ## Not in scope
   ```

   Under "What must be true", the requirements the work must meet: the filing skill's plan command refuses a tracking issue without that heading (`K-WORK-14`). Under "Decisions made", one bullet per decision: what was chosen, the role and the date. Under "Decisions open", what each gates. Under "Constraints to verify", each claim step 2 measured, with its command, and each gap in the repository's rules. Under "Plan and estimate", the phases and their estimates as they stand after the answers. Cite commands and rule ids, never file-and-line coordinates, for the reason the brief doesn't (`K-PROJ-3`). Show the person the whole draft and change it until they say it is right.

6. **Ask whether the project starts as soon as its brief merges.** Ask it before filing, because the answer is a label the filing call applies:
   - **Start on merge** (Recommended): no label. The Lead's reconcile tick, on its first run after the brief merges, files the brief's issues and dispatches the ready ones, up to the work-in-progress limit. There is no other start signal.
   - **File on merge, start on the go-ahead**: the tracking issue carries `lead:file-only` (`K-PROJ-11`). After the merge, each tick files and tracks the issues, so they can be read before the go-ahead, and dispatches none of them. Removing the label is the go-ahead, and the next tick dispatches what is ready. An issue a person labels `agent:implement` by hand is still dispatched.

   **Never use `needs:human` as a deliberate hold.** On a tracking issue it is the reconciler's escalation: it stops every phase, filing included, and reads as a stuck project (`K-PROJ-11`). If the person wants nothing filed until the go-ahead, the way is to leave the brief unmerged, since nothing is filed before the merge (`K-AGENT-30`).

7. **File the tracking issue** through the filing skill: read and follow `skills/file-issue/SKILL.md` in this plugin. Its labels are the kind label of the project's work, `enhancement` for product work or `pipeline-improvement` for platform work (`K-WORK-23`), with its subject to match, and `lead:file-only` when the person chose it in step 6. Pass no `--explicit-milestone`: a tracking issue goes on its bucket (`K-WORK-23`), which the filing skill's plan chooses. The body is the mandate. File it in one call, as the filing skill says (`K-WORK-2`). With `lead:file-only`, post one comment on the new issue (`gh issue comment <n> -R <owner>/<repo> --body-file <file>`) saying that the label is the person's choice and not an escalation, and that removing it starts dispatch on the next tick.

   **A new roadmap milestone, only when the Stakeholder asks for one.** Where the decomposition's work goes is the brief's, transcribed from the mandate's decisions (`K-WORK-5`); the tracking issue itself stays on its bucket. When the Stakeholder places the work on a roadmap milestone that doesn't exist yet, which may be one created for this project alone (`K-PROJ-11`), create it before you file the tracking issue:
   - **Confirm its title and due date with the person**, and that the placement is the Stakeholder's, recorded as step 4 says. A roadmap milestone always has a due date (`K-WORK-3`): never create one without it, and never create a bucket.
   - **Show the command, then, on a yes, run it** in the person's own session, with their token: `gh api repos/<owner>/<repo>/milestones -f title='<title>' -f due_on=<YYYY-MM-DD>T00:00:00Z`. Check that it is listed with its `due_on` set, with the milestones query in "Where the rules are".
   - **Name it in the mandate** under "Decisions made", by its exact title, as the Stakeholder's placement, so the brief records that decision (`K-PROJ-14`) and names the milestone on each item it places there.

   If the Stakeholder hasn't decided, create nothing and keep the placement under "Decisions open".

   **Where the decomposition lands.** The Lead writes a milestone on each decomposition item's metadata line, from the mandate (`K-PROJ-9`). The brief guard accepts a roadmap milestone there only when it already exists in the repository with a due date, which is why you create it before the Lead plans. After the merge, the reconcile tick files each item, and moves each issue the brief adopts, onto the milestone its item names. Only product work can go there: pipeline work and the Explorer's bugs never go on a roadmap milestone (`K-WORK-11`), the brief guard reports such an item, and the tick stops on it. Tell the person that the project's pipeline items stay on their bucket.

8. **Dispatch the Lead's brief lane.** Say first that it is one model run of the Lead. Then, on a yes:

   ```sh
   gh workflow run agent-lead.yml -R <owner>/<repo> -f mandate='<one paragraph>' -f context=<n>
   ```

   The paragraph says what to plan in the person's words, and ends: "The tracking issue is #<n>; its body is the mandate." The Lead refuses to write a brief without a numeric tracking issue (`K-AGENT-30`). Find the run (`gh run list --workflow agent-lead.yml -R <owner>/<repo> --limit 1`) and watch it (`gh run watch <id> -R <owner>/<repo>`). When it ends, find the brief's pull request, the open one that adds `docs/projects/<n>.md`: `gh pr list -R <owner>/<repo> --state open --json number,files --jq '.[] | select(any(.files[]; .path == "docs/projects/<n>.md")) | .number'`. Go on to step 9, or, if the person stops here, tell them to start this skill again with the pull request's number.

## The brief's pull request

9. **Read the brief and its mandate.** The brief, `docs/projects/<n>.md` at the pull request's head (`gh pr diff <number> -R <owner>/<repo>`); the mandate, the tracking issue's body (`gh issue view <n> -R <owner>/<repo>`); and the Lead's comment that lists what it needs from the person.

10. **Audit the decisions section against `K-PROJ-18`.** The brief guard fails on an open headline (`K-PROJ-5`). It warns, without failing, on a decision the Lead marked answered whose headline names spend, paging or roadmap placement, by the keyword list `PERSON_DECISION_SUBJECTS` in Kanon's `scripts/brief-guard.mjs`, and on an answered headline whose body still waits on a person. Read its warnings in the guard's run on the pull request, then read every decision yourself: the list misses agent authority, product behaviour and closure rules, and any subject worded without its keywords. List:
    - each decision marked answered by the Lead whose subject is one `K-PROJ-18` reserves for a person;
    - each headline marked answered whose body still defers to a person, such as "needs the developer's yes";
    - each decision still open;
    - each answer that contradicts the mandate's "Decisions made", and each of its "Decisions open" the brief doesn't carry.

11. **Prepare each listed decision** with what the person needs to rule well: what the Lead chose, the alternative it rejected, and what each would change. For **paging**, the repository's paged signals and not-paged table beside the proposal, so the person can see a new page that overlaps an existing one, could fold into it, or could be replaced by a structural guarantee (`K-OBS-3`, `K-OBS-4`). For **spend**, the figure per environment and the number of environments (`K-OBS-9`). For **roadmap placement**, who decides it: the Stakeholder (`K-PROJ-14`).

12. **Ask, then sort each answer** into one of: **accept as written**; **revise**, with the exact change; or **reject**, with what replaces it.

13. **Record the rulings as one pull request comment.** For each ruling: the decision's number and headline; the ruling; the headline the Lead should write, `✅ ANSWERED (<role>)` and what was chosen (`K-PROJ-17`); each section and spec clause it affects, such as the cost, observability, decisions and decomposition sections; and any spend the person agreed to. Show the draft; on a yes, post it with `gh pr comment <number> -R <owner>/<repo> --body-file <file>`. Never as a review ("Ground rules").

14. **Dispatch the Lead's revise lane with a reset.** No review event has fired, so the lane won't run on its own, and a reset is how a person's answers reach the Lead. Say what it costs first: a reset authorises exactly one more revision (`K-AGENT-18`), one model run of the Lead. Then, on a yes, dispatch it right after the comment, because the run reads the pull request's latest comments:

    ```sh
    gh workflow run agent-lead-revise.yml -R <owner>/<repo> -f pr_number=<number> -f reset=true
    ```

    Watch the run as in step 8. When it stopped at its turn limit on one ruling that can't be divided, a run with more turns is the person's choice: `docs/lanes.md` in Kanon's repository, "The turn budget", gives the inputs.

15. **Check the new head.** For each ruling, check that every section it touches carries it, and each spec clause it names; that each overridden headline now records the person's answer and role, not the Lead's; and that the brief guard passed on the head, in the revise run and in each run on that commit (`gh run list --commit <sha> -R <owner>/<repo>`). Report anything missing before the person reviews for merge. Applying what is missing is another ruling comment and another reset, and each reset is one more revision.

16. **Hand over the merge.** The person reviews and merges the brief. Say what happens then, from step 6's answer: the next tick files and dispatches, or files and waits for `lead:file-only` to come off.

## Why the questions come first

On a reference adopter's project, both halves of this skill were done by hand first. Measuring the product document's claims before any question found that an integration it planned to reuse didn't exist, and the plan's estimate grew by weeks before the brief, not in its review; the answers to two rounds of questions each moved the plan or the estimate too. On the brief's pull request, the Lead had marked three decisions answered that were the developer's, about product behaviour and paging, and the brief guard passed them. Comparing the proposed pages with the existing ones turned three new pages into one. Getting the rulings applied took knowledge nobody had written down: a comment, not a review, then the revise lane dispatched by hand with a reset, then a check that each ruling reached every section it touched. This skill writes that knowledge down.
