# Plan 0005: the lean installation

- **Status:** proposed, 2026-10-05. The Owner took six decisions on 2026-10-05, before this plan was drafted, and answered its five questions the same day; all are recorded as decided (§4 and [Decisions for the Owner](#decisions-for-the-owner)). **The Owner also decided the sequencing on 2026-10-05:** Kanon is applied to its adopters (the reference adopter, Kolophon) only after this plan is implemented, so each adopter migrates once, onto the lean model (decision 7, step L6). Answering question 2, **the Owner changed decision 2**: the Releaser is a third App of its own, not a role of the Author. Decision 4 is in flight in #291. The Owner also decided question 6, raised by the first review, the same day: the green zone requires an implementer commit status. No question remains open. **The Owner re-sequenced the migrations on 2026-10-06** ([ADR 0014](../decisions/0014-adopter-audiences.md), decision 1): the agent-client skills (step L11) come right after L10, and Kanon's migration (L5) and its adopters' (L6) run through them, so both move after L11.
- **Why now:** the Owner's verdict in #288, after installing Kanon on the reference adopter and on Kanon itself: the installation and bootstrap phase is long, tedious and cumbersome, and has to get smoother before other adopters arrive. Kanon hit it again on 2026-10-05, when `kanon apps` wrote the App register outside the checkout (#288's comment), and the Owner hit a stale `GH_TOKEN` repeatedly the same day.
- **Tracks:** #288. **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md) (standardise, don't parameterise), [ADR 0008](../decisions/0008-installation-test-decisions.md), whose §2 this plan supersedes, [ADR 0009](../decisions/0009-move-dont-rewrite.md), [ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), chapter 10 (`K-ADOPT-*`), and #274 and #279 (key isolation).
- **Amended** 2026-10-10 by [plan 0007](0007-guided-install.md), from the first timed install: the skills of L11 no longer ask every answer of `kanon init` as its own question, as #428 had them do. They ask three (a feature, whether the repository holds sensitive material, and one consent question for sharing), and a fourth, the review trigger, once the every-PR trigger ships; they show every other answer, inferred or defaulted, in one summary the person confirms or edits; nothing is silent. This returns §5.4 step 2 to its first wording, "asks only what it can't infer", with the confirmation added.
- **Measured on** Kanon's `origin/main` at `fdfbbd9` (v0.24.0 plus #289), on 2026-10-05, and on Kanon's GitHub settings through the API. The commands are in [Measurements](#measurements). The time from an empty repository to a first reviewed pull request has **not been run**: it is step M1, and its method is in §6.

## The plan in one paragraph

**Today.** An adopter installs Kanon by hand, in fourteen ordered steps (`K-ADOPT-1`), plus a lane caller per lane. Each agent role is its own GitHub App: six roles, so six manifest flows, twelve secrets and six register rows per repository, and the reference adopter runs about eight Apps. The Apps must live in an organisation (`K-ADOPT-2`), and `kanon apps` builds only organisation URLs. The labels, the declaration files and the environment are made by hand, learned one `lane-check` failure at a time. Nothing tells an adopter, before the first red run, what a new release needs.

**Where it ends.**
- **Any GitHub account can adopt Kanon.** A personal account is first-class. Organisations and paid features are used where they exist and required nowhere (decision 1).
- **Two GitHub Apps per owner, three with releases, reused across that owner's repositories:** the **Author** (Implementer, Lead, Explorer, Overseer) and the **Judge** (Reviewer, Merger), plus the optional **Releaser**, which alone holds the release bypass (decision 2, as changed on 2026-10-05). Each lane still narrows its token to what it uses (`K-AGENT-46`), and each agent still speaks as its role, through a persona header and a role marker (decision 3).
- **`kanon init`** inspects a repository, asks what it can't infer, with a default for each answer, writes the declarations, creates the labels and, where the plan has them, the ruleset's checks, and drives the Apps. **`kanon doctor`** re-runs after an upgrade and names exactly what the new release needs, before the first red run.
- **An omitted declaration means the documented default,** and **a lane creates a label it needs and doesn't find.**
- **The time from an empty repository to a first reviewed pull request** is measured before and after, on a fresh personal-account repository (§6).

**How it gets there.** Measure first. Then write the decisions into an ADR and the rulebook, fix `kanon apps` where it bit the Owner, and teach the lanes to write and read the role marker beside the login, before any App changes. Then one breaking release moves the lanes to the two Apps (and the release workflow to the Releaser). Labels and defaults come next, so that `kanon init` has less to write, then `kanon doctor`, because it reuses `init`'s inspection, then the agent-client skills that wrap both ([ADR 0014](../decisions/0014-adopter-audiences.md)). Kanon then migrates through those skills (#279, which it waited for, closed on 2026-10-05). Measure again. Only then are the adopters, the reference adopter and Kolophon, moved onto Kanon, each once, onto the lean model (decision 7), through the same skills.

## 1. What an installation takes today

Measured on Kanon's main branch: the rulebook, `docs/lanes.md`, `docs/apps.md` and `cli/`. "By hand" means no command does it today.

| What | Count today | How it is done | Where |
|---|---|---|---|
| Installation steps | 14, in a fixed order | by hand, except steps 7 and 12 | `K-ADOPT-1` |
| Agent roles that need an App | 6 (Explorer, Implementer, Reviewer, Merger, Lead, Overseer), plus the Releaser and Intake, which `kanon apps` doesn't create (#49) | `kanon apps`, one manifest flow per role | `K-ADOPT-8`, `docs/apps.md` |
| Browser actions per App | 2 clicks the command asks for (**Create**, **Install**), plus choosing the account, "Only select repositories" and the repository on the install page | by hand, in GitHub's pages | `docs/apps.md` |
| Actions secrets | 2 per App (`<ROLE>_APP_ID`, `<ROLE>_APP_PRIVATE_KEY`): 12 for six roles, plus `CLAUDE_CODE_OAUTH_TOKEN`, plus `DIGEST_WEBHOOK` for the digests | `kanon apps` sets the App secrets; the rest by hand | `docs/lanes.md` |
| App register rows | 1 per App, committed by hand from the diff `kanon apps` prints | the command writes the file; a person commits it | `K-LAYOUT-6` |
| Apps Kanon itself runs | 3 (`kanon-reviewer`, `kanon-implementer`, `kanon-explorer`), created on two days, 2026-10-02 and 2026-10-05 | `kanon apps` | the adoption record, step 12 |
| Apps the reference adopter runs | about 8 | by hand, then `kanon apps` | |
| Labels | 37 in the taxonomy (36 rows), and 7 of GitHub's defaults to delete. Kanon itself has 26 today, so its step 6 is "not done" | by hand | `K-WORK-12` |
| Fixed governance files in `docs/qa/` | 13: the App register, the capability ledger, the escalation file, the adoption record, the sign-off delegation, the exemptions file, the test-database declaration, the stack document, and five playbooks. #288 counts six of them as *declarations*: the adoption record, the stack document, the escalation file, the test-database declaration, the sign-off delegation and the App register | by hand, each in its own format | `K-LAYOUT-1` |
| Lane callers | 1 per lane: 18 lanes, plus the `apps-check` caller, `lane-check` in CI and a Dependabot entry with the cooldown written out | by hand, from `docs/lanes.md` | `K-LAYOUT-18`, `K-ADOPT-11` |
| The project-setup hook and `ci.yml` | 1 each | by hand | `docs/lanes.md` |
| Environments | 1, `kanon-qa-store`, for an adopter with a store. #291 removes it (decision 4) | by hand | `docs/qa-store.md` |
| Ruleset | 1, plus its required checks | by hand | `K-ADOPT-1` step 8 |
| Upgrade needs | not listed anywhere machine-readable; a release's notes say what changed, and `lane-check` or the first red run finds the rest | by hand | #288 |

**Two traps the Owner hit on 2026-10-05,** neither of which fails visibly:
- **`kanon apps` run outside the checkout** created both Apps and their secrets, then wrote a fresh register relative to the working directory, in the checkout's parent. Nothing said it wasn't the repository's register; #289 copied the rows in by hand (#288's comment).
- **A stale `GH_TOKEN`** wins over `gh`'s stored login. `kanon apps` already says so in its usage text and in its preflight's refusal, but it never says which token it used, or whose it is.

**Code that tells two roles apart by login.** 14 calls to `appLogin('<Role>')` in 8 library scripts, each comparing an author or actor against one role's App, and at least six more reads outside them: the Merger's self-event guard in its job `if:`, the actor of `holdOn`'s `labeled` event, and four review selects in the review lane (§3.3). With two Apps, every comparison between two roles of the same App needs another signal.

## 2. The target

| What | After this plan |
|---|---|
| Account | any: a personal account or an organisation (decision 1) |
| Apps | 2 per owner, 3 with releases, reused across its repositories (decision 2) |
| Manifest flows | 2 per owner, 3 with releases, and none for that owner's next repository |
| App secrets per repository | 4: `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY`, `JUDGE_APP_ID`, `JUDGE_APP_PRIVATE_KEY`; 6 with releases, adding `RELEASER_APP_ID` and `RELEASER_APP_PRIVATE_KEY` |
| Labels | none by hand: `kanon init` creates the taxonomy, and a lane creates a missing label on first use (§5.3) |
| Declarations | written by `kanon init` from questions with defaults; a section left out means the documented default (§5.2) |
| Environments | none (decision 4) |
| Lane callers | one per lane, unchanged (decision 6); `kanon init` writes the ones the adopter chooses |
| Upgrades | `kanon doctor` names what the new release needs before the pin moves (§5.5) |

## 3. The Apps

### 3.1 Which roles each App holds, and its permissions

Each App holds the union of its roles' rows in chapter 03's roles table, plus Metadata: read (`K-ADOPT-8`):

| App | Roles | Contents | Issues | Pull requests | Workflows | Actions | Checks, Commit statuses |
|---|---|---|---|---|---|---|---|
| **Author** | Implementer, Lead, Explorer, Overseer | write | write | write | write | read | Commit statuses write, broadened for the implementer status (§3.3, question 6) |
| **Judge** | Reviewer, Merger | write | write | write | none | write | read |
| **Releaser** (optional) | Releaser | write | none | write | none | none | none |

- **The one essential separation is author and approver.** GitHub forbids an identity to approve its own pull request, so a Judge approval on an Author pull request is a real approval, and the ruleset's required review means what it says (`K-MERGE-6`). The Author never approves, and the Judge never authors.
- **Least privilege stays at the token** (decision 2). Every minting step already narrows its token to what that step uses, and `tests/unit/app-token-permissions.test.ts` holds each step to its list and each list to the role's grant (#155, `K-AGENT-46`). That test changes only in what it compares against: the list must fit inside the *App's* grant, and still inside the *role's* row. So the Lead's token still carries no Workflows, and the review token no Actions write.
- **`K-AGENT-7` keeps its meaning.** Only the Author holds Workflows, and only the Implementer's lanes mint with it. The Judge, and so the Merger, never holds it.
- **The Releaser is a third App, and the only bypass actor** (decision 2, as the Owner changed it answering question 2). A ruleset bypass is granted to an App, not to a role, so a bypass on the Author would also have been the Implementer's, the Lead's, the Explorer's and the Overseer's. The Releaser holds Contents and Pull requests write and the bypass limited to release pull requests (`K-MERGE-8`), runs no agent, and is used only by the release workflow. It opens release pull requests with its own token, so CI runs on them (one opened with the workflow token gets no CI run, #49's finding). **It is optional:** an adopter that makes no releases, or merges its release pull requests through the front door, needs only the Author and the Judge. Kanon's admin bypass, kept until the Releaser App exists (#49), is replaced by the Releaser's at L5.

### 3.2 What one App per owner changes

- **One installation per owner,** with "Only select repositories". The App covers each repository that adopts Kanon, and nothing else. `apps-check` stops warning that an App covers other repositories, and keeps warning when it covers *all* of them (`K-ADOPT-8`, amended).
- **Keys.** GitHub has no API that makes a new private key for an existing App (`docs/apps.md`, Limits). The key `kanon apps` receives at creation is in memory once, so the command sets it on **every repository named at creation** in the same run (`--repo a,b,c`). A repository added later gets a key the Owner generates on the App's settings page; `kanon apps --reuse` reads that file, stores the secret, and deletes the file. An organisation may instead hold the two secrets once, as organisation secrets, where its plan offers them for its repositories (`K-AGENT-6` already counts them).
- **Blast radius.** Any key of the App mints tokens for every repository the installation covers. With one App per role per repository, a leaked Lead key reached one repository with the Lead's grant; a leaked Author key reaches every adopting repository of that owner with the Author's grant. That is the cost of reuse, and it makes #274 and #279, which keep the key out of every job that runs an agent, more urgent. See question 4.
- **Rate limits.** GitHub's API rate limit for an App is per installation, so every lane of every adopting repository of one owner shares the Author's budget, and the Judge's. Step L6's live check reads `x-ratelimit-remaining` at the busiest hour of the reference adopter, which runs the most lanes.

### 3.3 Personas without per-role Apps (decision 3)

**What a reader sees.** Every post an agent writes (a comment, a review, an issue or pull request body) opens with a persona header, `**<persona> (<Role>)**`. The persona is a display name the adopter may declare (`K-AGENT-2`'s "the project supplies: the display names of its Apps", which becomes "of its personas"); without one, the header is the role alone, `**Reviewer**`. Every commit an agent makes is authored with the persona as its *name* and the App's noreply address, `<id>+<slug>[bot]@users.noreply.github.com`, as its *email*. GitHub attributes the commit to the App by its email, so the avatar stays the App's, and the `dco` action already recognises an agent commit by that email (`actions/dco/dco.mjs`), so the delegate's sign-off still matches (`K-AGENT-44`).

**What a machine reads.** A hidden role marker, `<!-- kanon:role=<role> -->`, beside the header, plus the labels and trailers the lanes already write. A check trusts a marker only on an object the expected App authored: the login says *which App*, the marker says *which of its roles*. A member can edit a marker on an App's pull request, but a member is already trusted (`K-AGENT-45`), and a stranger can edit neither.

**The readers that change.** Each of the 14 `appLogin` calls compares against one role, and so do the reads outside them, measured by the first review. The ones that compare two roles of the same App switch to "the App's login **and** the role's marker", or, where no marker can be attached, to the rule in the last column:

| Script | Roles it tells apart | Same App after this plan |
|---|---|---|
| `merge-gate.mjs` | the Implementer's pull requests, the Reviewer's verdicts, the Merger's own comments | the Implementer vs the Lead (both Author); the Reviewer vs the Merger (both Judge) |
| `dispatch-sweep.mjs` | the Implementer's and the Lead's comments on an issue | both Author |
| `lead-reconcile.mjs` | the Explorer's filings | Author, beside the Lead itself |
| `review-run-evidence.mjs`, `brief-revise-recovery.mjs` | the Lead's brief pull requests | Author, beside the Implementer's |
| `rebase-lane.mjs` | the Implementer's pull requests | Author, beside the Lead's |
| `incremental-review.mjs`, `review-recovery.mjs` | the Reviewer's reviews | Judge, beside the Merger, whose comments already carry `<!-- merger:… -->` |
| `agent-merge.yml`, the Merger job's `if:` | `github.actor != <merger>[bot]` on a review event: the Merger's own events; and `github.event.pull_request.user.login` against the Implementer's login: the PR's author | Judge for the actor, Author for the PR's author. **A job `if:` can't read a marker or a status**, and with a shared Judge the actor clause would decline every Reviewer review, leaving the Merger to its hourly sweep, silently. The Merger submits no reviews, so on `pull_request_review` the actor clause is dropped, and a test pins that the merge lane calls no review-submission endpoint. The author clause compares against the Author's login, which admits every Author lane's PR to the job; that is a pre-filter only, and `mergeVerdict` then requires the implementer status (below) |
| `merge-gate.mjs`, `holdOn` | the actor of the last `labeled` event of `needs:human`: whether the Merger may lift its own hold (`K-MERGE-10`) | Judge. **A label event has no body**, so no marker. The rule stays today's (`merge-gate.mjs`, the `escalation-lapsed` release): the Merger lifts a hold only when the label's last actor is the Judge **and** every Merger escalation on the PR is head-scoped and about a commit **other than** the current head. A test fails if a fixed step of any other Judge lane (the review and merge-reconcile lanes) applies `needs:human`. That test covers the lanes' steps, not the Reviewer's agent, which holds Pull requests write and so could apply the label; such a label, with no lapsed Merger escalation behind it, is never lifted, so it holds a PR for a person and can't release one. The rebase lane, which also applies it, is Author, so it stays told apart by login |
| `agent-review.yml`, four review selects by the Reviewer's login | the Reviewer's earlier reviews | Judge. Unchanged, because the Merger posts no reviews; the test in the Merger's row keeps it so |

**Who writes the marker.** The lane's deterministic steps write the header and the marker where they post, and the prompt asks the agent to write them where the agent posts. **The agent can write the same bytes**: any agent of the Author holds Pull requests and Issues write on its narrowed token, so a marker on an Author object is a claim by *some* Author lane, not proof of which one.

**The Merger's green zone** changes from "authored by the Implementer" to "authored by the Author App and marked `implementer`", with its other conditions unchanged (`K-MERGE-4`). That is **forgeable by another Author lane's agent**, as the first review showed: a Lead agent steered by text it reads could open a code pull request as the Author, write the `implementer` marker and apply `agent:implement`. Today the Implementer's own login refuses that pull request, a signal no text can forge; after L4, without more, the Reviewer's approval would be the only gate. Refusing `docs/projects/` covers only a brief. So the green zone needs a signal no other Author lane can produce. **Decided by the Owner, 2026-10-05 (question 6):**
- **An implementer status on the head commit,** `kanon/role: implementer`, set by a fixed step (never the agent) of the Implementer's lanes after the agent has finished, with a token narrowed to Commit statuses write. No agent's token holds that permission (`K-AGENT-46`, held by `app-token-permissions.test.ts`), and once #279 has closed no agent's job holds the key that could mint one. The Merger requires the status on the current head, created by the Author App.
- **The first status goes only on the pull request this run opened** (from the third review). The opening lanes' status step never finds its pull request by its link to the issue, its label or its author: today `implement-crash.mjs` finds the lane's pull request by `closingIssuesReferences` alone, and after L4 a forged Author pull request saying `Closes #N` would match that. The step stamps a pull request only when this run created it: opened after the run started, from a branch first pushed in this run, with the head commit this run pushed. When it finds no such pull request, or more than one, it stamps nothing, and the run's summary says so by name. The head this run pushed is read from a fixed step of the agent's own job, after the agent: the branch heads that job's repository holds (the spine's `heads` output, #324). The App's noreply email, which the step also checks, binds nothing to a run, because every run of the shared Author App commits under it.
- **The status is a chain, not a stamp** (from the second review). Only a lane that **opens** a pull request, implement or triage, creates the first status. A lane that acts on an **existing** pull request, implement-revise or rebase, sets the status on its new head only if the head it started from carried an implementer status created by the Author App, and otherwise refuses the pull request, by name. Today both pick a pull request by its author and its label alone (`agent-implement-revise.yml`'s author-slug and label check, `rebase-lane.mjs`'s `ineligible`), and after L4 every Author lane's agent can forge both, so without the chain a forged pull request could be laundered into the green zone by a change request or a conflict.
- **A person's push ends the chain.** A commit a person pushes to an Implementer pull request carries no status, so the pull request leaves the green zone, and the revise and rebase lanes refuse it from then on. A person merges it. Today the Merger judges such a pull request by its author alone, so this is a change.
- **The cost:** the Author gains Commit statuses write, a broadened permission recorded with its reason in the register (`K-AGENT-3`): only the Implementer lanes' status step mints with it. The Implementer's lanes each gain one step.
- **The migrations (L5, L6) wait for #279** (question 4), because before then an agent's job still holds a key that could mint a token with that permission.

**The only loss:** a distinct avatar per persona.

### 3.4 The App register

Two shapes would carry the Apps. The Owner chose the first (question 5), unless the review objects:
- **A, chosen: one row per role, as today, with roles sharing a slug.** The Author's four rows name one slug, the Judge's two rows another, and the Releaser's row a third. Every reader that maps a role to a login keeps working, which is all of them today (`cli/app-register.mjs`, `scripts/app-register.mjs`, `actions/lane-check/app-register.awk`, the `dco` parser), and the register still says which role each App plays. `lane-check` fails a register in which the Author's roles name more than one slug, the Judge's roles more than one, or any two of the Author, the Judge and the Releaser share a slug (Author and Judge sharing one is the self-approval case; the Releaser sharing one would make its bypass another role's). `K-LAYOUT-6`'s "a row per App" becomes "a row per role".
- **B: one row per App, with a Roles column.** Closer to `K-LAYOUT-6`'s present words, but every reader of the register is rewritten (ADR 0009), and the `dco` action reads it from the default branch of every adopter, so a release in between would read the wrong shape.

### 3.5 Secrets

The lanes declare **`AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY`, `JUDGE_APP_ID` and `JUDGE_APP_PRIVATE_KEY`**, by fixed name, mapped by the caller and never inherited, as today. The release workflow declares **`RELEASER_APP_ID` and `RELEASER_APP_PRIVATE_KEY`**, and no lane does. `CLAUDE_CODE_OAUTH_TOKEN` and `DIGEST_WEBHOOK` are unchanged. Today the lanes reference six role pairs (measured: `IMPLEMENTER_` 23 times, `LEAD_` 21, `EXPLORER_` 13, `REVIEWER_` 13, `OVERSEER_` 6, `MERGER_` 5, across 21 files). The rename is one breaking release (step L4), because an adopter's callers and its register must change together, and `lane-check` judges both.

## 4. Decisions

**Decided by the Owner, 2026-10-05:**

1. **Personal accounts are first-class.** Organisations and paid features (the merge queue, environments, organisation secrets) are supported where they exist, and nothing in Kanon may require them. This supersedes ADR 0008 §2 and `K-ADOPT-2`, and the assumptions table's organisation row in chapter 00. `kanon apps` takes `--owner` and detects whether it is a user or an organisation; today it takes `--org` only and builds `organizations/<org>/settings/apps` URLs throughout (`cli/apps.mjs`, from its usage text to the key-rotation steps). `K-ADOPT-3`'s table gains the personal-account columns, measured on the test account at step M1. **A consequence to record:** on a personal account a collaborator has write access, with no Triage role, so the Stakeholder holds more than chapter 03's "Triage"; the adoption record says so.
2. **Two GitHub Apps per owner, not one per role,** reused across that owner's repositories: the **Author** (Implementer, Lead, Explorer, Overseer), which writes code, issues and pull requests, and the **Judge** (Reviewer, Merger), which reviews and merges and never authors (§3.1). **Changed by the Owner the same day, answering question 2:** the Releaser, first placed in the Author, is a **third App of its own**, optional, and the only one holding the release bypass; an adopter without releases, or without a bypass, needs only two. *Rationale:* GitHub forbids self-approval, so author and approver is the one essential separation; per-lane token narrowing (#155) keeps least privilege at the token; setup drops from six to eight manifest flows to two per owner, three with releases. This amends `K-PRIN-5` (author and approver are distinct identities; the reviewer and the merger may be one), `K-AGENT-1` and `K-AGENT-2` (an identity per *App*, a persona per role), `K-AGENT-7`'s wording, `K-ADOPT-8`, `K-LAYOUT-6`, the roles table and `agent-permissions.json`.
3. **Personas without per-role Apps** (§3.3): a persona header in every post, the persona as each commit's author name with the App's noreply email, and a hidden role marker plus the existing labels and trailers for machine checks. The Merger's "authored by the Implementer" becomes "authored by the Author App and marked `implementer`". The only loss is a distinct avatar per persona.
4. **Environments are dropped** (#290, in flight in #291). The QA store trusts the default branch's ref subject instead of the `kanon-qa-store` environment, and a widened guard holds which jobs may hold `id-token: write`. Once #291 merges, no Kanon lane needs an environment, which a personal account's private repository may not have.
5. **The rest of the lean plan:**
   - **`kanon init` and `kanon doctor`** (#288), §5.4 and §5.5.
   - **Sensible defaults:** an omitted declaration section means the documented default (§5.2).
   - **Lanes create missing labels on first use** (§5.3).
   - **One declaration file instead of six** was considered, and the Owner kept the six (question 1).
   - **`kanon apps` refuses outside a checkout of `--repo`** (#288's comment), before it opens any page.
   - **The CLI says which token it used,** and how to fix a stale `GH_TOKEN`.
6. **One caller per lane stays** (`K-LAYOUT-18`). "One caller per trigger group", which would cut the number of caller files, is deferred: Kanon's scripts find a lane's runs by its caller's file name, and GitHub files a run under the top-level workflow.
7. **Decided by the Owner, 2026-10-05: the adopters move last, and once.** Kanon is applied to its adopters (the reference adopter, Kolophon) only after this plan is implemented, so each adopter migrates once, onto the lean model (L6, after M2). The adopter-side switches that plans 0001 and 0004 left waiting go into that one migration.

**Decided by the Owner later on 2026-10-05:** questions 1 to 6, in [Decisions for the Owner](#decisions-for-the-owner).

## 5. The pieces

### 5.1 `kanon apps`, fixed

- **`--owner <login>`.** The command asks `GET /users/<login>` and reads `type`. For a `User` the create page is `https://github.com/settings/apps/new` and the settings pages `https://github.com/settings/apps/<slug>`; for an `Organization`, today's URLs. The installation is matched by its account login either way. `--org` stays one release as an alias that warns, then goes.
- **It refuses outside a checkout of `--repo`,** before the preflight and before any page opens: the working directory (or `--dir`) must be a git checkout with a remote that resolves to `<owner>/<repo>`. The refusal names both, and says to `cd` into the checkout. `--register <path>` writes elsewhere, explicitly.
- **It names its token.** Before the preflight it prints where the token came from (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh`'s stored login) and the login it belongs to (`GET /user`), never the token. When the preflight fails with 401 or 403 and `GH_TOKEN` is set, the refusal says so and gives the fix: `unset GH_TOKEN` to use the stored login, or export a fresh one. `kanon milestones`, `init` and `doctor` share the same helper.

### 5.2 Defaults

Each declaration's default is written once, in the rule that defines the file, and a reader that finds the file or section missing reads the default and says so in its summary. Some defaults exist already.

| Declaration | Default when omitted | Today |
|---|---|---|
| `## Code areas` in the stack document | the whole repository | already (`docs/lanes.md`) |
| The test-database declaration | `none` | already: no file means no database (`K-LAYOUT-16`) |
| The sign-off delegation | none: an agent's commit fails a required `dco` check | already; `kanon init` asks, because a repository with `dco` required needs one before the Implementer runs |
| The exemptions file | none | already |
| The escalation file | Kanon's own pipeline paths only (`docs/qa/`, `.github/`, the agent instruction files) | **new**: today the file is required before the first brief (`K-ADOPT-1` step 4) |
| A playbook | Kanon's shipped baseline for the role, read from the pinned release | **new**: today `lane-check` fails a lane whose playbook is missing |
| The adoption record's choices | the Overseer `not installed`, no reference environment, the weekly digest's generic audience, chat channel "none yet" | partly already; the Overseer bullet is required today |
| The App register | written by `kanon apps` | already |
| The stack document's `## Gates` | **no default**: `kanon init` asks, offering what it sees in the repository as a suggestion the adopter accepts or edits | |

`lane-check` stops failing an omitted section that has a default, and keeps failing a malformed one by name.

Measured when L8 was built, on `origin/main` at `b38b8b7`: the exemptions file was not "already" defaulted, as the table says. A missing file, or a missing section, failed both guards that read it, so L8 treats it as new. So were the stack document's `## Schema changes`, `## Data isolation` and `## Generated files`, which `lane-check` required and which L8's own check leaves out: each now means none.

### 5.3 Labels on first use

The taxonomy (`K-WORK-12`, 37 labels in 36 rows) gains a machine-readable twin, `rulebook/labels.json`, with a test that fails when the table and the file disagree, as `agent-permissions.json` does for the roles table. When a lane applies a label the repository lacks, it creates it first, with the taxonomy's colour and description, and says so in its summary. Both Apps hold Issues write, which creating a label needs, and each minting step's list already includes it where the step labels. A label outside the taxonomy is never created: an unknown name is a bug, and fails by name. `kanon init` creates the whole taxonomy, and deletes GitHub's defaults that aren't in it, after asking.

### 5.4 `kanon init`

Run once, from the checkout, by the Owner:
1. **Inspects** the repository and its owner, read-only: user or organisation, public or private, the plan's features (rulesets, merge queue) from the API, the existing labels, the declaration files, the callers, the ruleset, the secrets' names, and the App register.
2. **Asks** only what it can't infer, each question with a default: the people (`K-ADOPT-1` step 2), the stack's gates, the test database, whether to record a sign-off delegation, which lanes to install.
3. **Writes** the declaration files, the lane callers it was asked for, the `apps-check` caller, `lane-check` in CI and the Dependabot entry, all pinned to the release it runs from, and prints the diff. It commits nothing.
4. **Creates** the taxonomy's labels and the bucket milestones (`kanon milestones`), and, where the plan has rulesets and the token holds Administration, the ruleset with its required checks; otherwise it prints the fallback `K-ADOPT-3` records.
5. **Drives `kanon apps`** for the Author and the Judge, and the Releaser if the adopter makes releases, or `--reuse` when the owner's register on another repository already names them.
6. **Says plainly what the plan can't enforce.** On a private repository on GitHub Free there are no rulesets, so the repository never leaves bootstrap, and `init` prints that the platform doesn't enforce review there: a person can merge past the Reviewer (question 3).

Re-running it is safe: it changes nothing that is already right, and names what it would change.

### 5.5 `kanon doctor`

Every release ships a machine-readable requirements file: the permissions each App's lanes mint with, the declarations and sections each lane reads, the labels each lane applies, and the secrets each caller maps. `kanon doctor --to vX.Y.Z` reads the repository as `init` does, compares it with that release's requirements, and lists exactly what the upgrade needs, in the order to do it: an App permission to widen, a declaration to add, a caller's grant to change. It also lists **every job of the adopter's own workflows on its default branch that holds `id-token: write`**, counted as #291's guard counts it: through its own grant, inherited from the workflow's `permissions:`, through `permissions: write-all` at either level, or by calling a reusable workflow that it passes the grant to: since #291 the QA store's role trusts the default branch's ref, so it admits any such job, not only Kanon's store jobs (from #291's review). For each, `doctor` asks the adopter to accept it, recorded with its reason in the adoption record, or to narrow it. **A caller of Kanon's own store-coupled lanes** (a job whose `uses:` is one of those lanes at the pinned release) is listed as such and accepted without asking: the grant reaches only the lane's store jobs, which #291's guard holds in Kanon. It exits non-zero while anything is missing, or while a holder is neither accepted nor narrowed. It writes nothing; `kanon init` fixes what can be fixed from the checkout. Run before merging Dependabot's pin bump, it turns "the first red run" into a list.

## 6. The measurement

**What:** the wall-clock time, and the count of manual actions (commands typed, browser clicks, files written by hand), from `gh repo create` of an empty repository to the first verdict the Reviewer posts on a pull request in it.

**Where:** a fresh **public repository on a personal account** the Owner creates for it, so that no organisation feature or paid plan helps, and its Actions minutes are free. A second fresh repository for the after-run, so neither inherits the other's state.

**How:** the Owner follows the published path with a clock running, and a log of each manual action:
- **Before (step M1):** the current release, following `K-ADOPT-1` and `docs/lanes.md`'s "Your first lane". Today that needs an organisation for `kanon apps`, which is itself a finding; the before-run records where the path refuses a personal account, then continues in a throwaway organisation, and records the difference.
- **After (step M2):** the release that completes step L9, following `kanon init`.

**The record:** start and stop timestamps (the repository's `created_at`, and the review's `submitted_at`), the action log, and every failure met on the way, in the PR that closes the step. **The claim this plan makes, to be confirmed or refuted by M2:** fewer than half the manual actions of M1. The time is reported, not targeted, because it depends on one person's speed.

## 7. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **M1** | the Owner, a fresh personal repository | **Measure before** (§6), on the current release. | The record holds both timestamps, the action log, and each refusal met, with the release it ran. Without it, M2 has nothing to compare against. |
| **E** | Kanon | **In flight in #291** (decision 4): the QA store trusts the default branch's ref; no lane declares an environment. | #291's own checks: its id-token guard is red for any job outside its allow-list holding `id-token: write`, and for any store-coupled job that declares an environment. `grep -rn "environment:" .github/workflows/` prints no lane job after it merges. |
| **L1** | Kanon, docs | **Write the decisions down.** ADR 0013 records decisions 1 to 3 and supersedes ADR 0008 §2. The same PR amends `K-PRIN-5`, `K-AGENT-1`, `K-AGENT-2`, `K-AGENT-7`, `K-ADOPT-1` (step 1), `K-ADOPT-2`, `K-ADOPT-3`, `K-ADOPT-8`, `K-LAYOUT-6`, chapter 00's assumptions table and chapter 03's roles table, and adds the three Apps to `agent-permissions.json` as the union of their roles. | `tests/unit/agent-permissions.test.ts` fails when an App's permissions differ from the union of its roles' rows (plus the Author's Commit statuses write, recorded in the register, question 6), and when a role belongs to no App or to two. **Mutation:** removing `workflows` from the Author, adding it to the Judge, or giving the Releaser Issues write, turns it red. `rulebook-why.test.ts` and the adoption-record test stay green. |
| **L2** | Kanon vN | **`kanon apps`, fixed** (§5.1): `--owner` with user or organisation detection; the refusal outside a checkout of `--repo`; the token's source and login printed, and the stale-`GH_TOKEN` fix in the refusal. | `tests/unit/kanon-apps.test.ts`: for a `User` owner every URL the command prints or opens is under `github.com/settings/`, and for an `Organization` under `github.com/organizations/<org>/`. Run from a directory whose remote is another repository, or from no checkout, the command exits non-zero before the preflight's `gh secret set`, and the message names the directory and `--repo`. **Mutation:** moving the checkout check after the preflight turns the test red. **Live:** the M1 repository's owner gets a working manifest flow. |
| **L3** | Kanon vN+1 | **Personas and role markers, additive** (§3.3). Every post and commit the lanes write carries the persona header, the role marker and the persona as the commit's author name. Every reader in §3.3's table accepts the marker beside today's login, so nothing changes while each role still has its own App. The Merger refuses a pull request that touches `docs/projects/`. The Implementer's lanes start setting the `kanon/role: implementer` status (question 6), which nothing requires yet. | A library test runs each reader in §3.3's table against an object with the right login and marker, the right login and another role's marker, and the right login and no marker: each is read as today in this release, and the test names what L4 flips. `tests/unit/agent-commits.test.ts` judges a persona-named commit with the App's noreply email with the `dco` action's own check: it passes with the delegate's sign-off. **Mutation:** a writer that drops the marker fails the writer test. |
| **L4** | Kanon vN+2, **breaking** | **Two Apps, and the Releaser.** The lanes declare `AUTHOR_*` and `JUDGE_*`, and the release workflow `RELEASER_*` (§3.5); the readers require the marker wherever two roles share an App, and the two reads that can't carry one follow §3.3's table; the Merger's green zone is "authored by the Author App and marked `implementer`", plus the implementer status on its head (question 6). `kanon apps --apps author,judge[,releaser] --repo a,b,c` creates each App once and sets its key on every repository named; `--reuse` adds a repository from a key file (#49 for the Releaser). `apps-check` checks the Apps, and `lane-check` the register's shape (§3.4) and the secret names. **This release may ship before #279 closes** (question 4). | `lane-check` fails a caller mapping a role-named secret, a register whose Author roles name two slugs, and one where any two of the Author, the Judge and the Releaser share a slug. `app-token-permissions.test.ts` holds each minting step inside its App's grant and its role's row, and fails if any agent's step holds Commit statuses write. **Mutations:** an Author pull request marked `lead` with every other green-zone condition met gets `not-the-implementer` from `mergeVerdict`; so does a **forged** one, an Author pull request on code paths marked `implementer` and labelled `agent:implement` but without the implementer status on its head (or with one created by another App); a forged Author pull request already open, marked `implementer` and saying `Closes #N`, is still unstamped after the implement lane runs on #N and opens its own, and still gets `not-the-implementer`; with two candidate pull requests from the run's branch, the step stamps neither and says so; the same forged pull request, after a change request starts implement-revise or a conflict starts the rebase lane, is refused by that lane, sets no status, and still gets `not-the-implementer`; a person's push to a real Implementer pull request removes it from the green zone; a Judge review marked `reviewer` still starts the Merger's review-event path; a `needs:human` applied by the Judge with no Merger escalation on the pull request at all is not lifted, and one whose Merger escalations are all about other heads is (`escalation-lapsed`, as §3.3's row states); a Judge review is still counted as the Reviewer's, and a Judge comment with the Merger's marker is not. `grep -rnE "(EXPLORER\|IMPLEMENTER\|REVIEWER\|MERGER\|LEAD\|OVERSEER)_APP_" .github/workflows actions` prints nothing outside the old-spelling notes. |
| **L7** | Kanon vN+3 | **Labels on first use** (§5.3): `rulebook/labels.json`, its parity test, and the create-before-apply step in every lane that labels. The same PR amends `K-WORK-12` ("create all of them at installation", and its Why, which says a lane applying a missing label fails at filing) and `K-ADOPT-1` step 6: installation still creates the taxonomy, and a lane creates a label that is missing. | A lane test on a fixture repository without `qa:needs-split` creates it with the taxonomy's colour, then applies it. **Mutation:** a label name outside `labels.json` fails by name and creates nothing; a colour changed in the table but not in the file fails the parity test. |
| **L8** | Kanon vN+4 | **Defaults** (§5.2), in each rule and each reader. | For each row of §5.2's table marked new, a test runs the reader on a repository without the file or section and asserts the default and the summary line that names it. `lane-check` passes a fixture repository that has only the stack document's `## Gates`, the register and the adoption record's people. **Mutation:** the same fixture with a malformed section, rather than a missing one, still fails by name. |
| **L9** | Kanon vN+5 | **`kanon init`** (§5.4), and the requirements file each release ships. | On an empty fixture repository, `init` with every default accepted writes files that pass `lane-check` for the Reviewer's lane. Run a second time, it changes nothing and says so. **Mutation:** deleting one label after the first run makes the second run create exactly that label. |
| **L10** | Kanon vN+6 | **`kanon doctor`** (§5.5), with JSON output beside its prose and the same exit codes ([ADR 0014](../decisions/0014-adopter-audiences.md), decision 2). | On a fixture pinned at one release, `doctor --to` a release whose requirements add an App permission and a declaration lists exactly those two, and exits non-zero; after both are fixed it exits 0. The same run with JSON output names the same two items and exits non-zero. **Mutation:** a requirements file that drops the permission makes `doctor` miss it, and the test that compares the requirements file with the lanes' minting steps turns red. On a fixture whose default branch has an adopter job holding `id-token: write` (its own grant, or inherited from the workflow), `doctor` names that job and exits non-zero until the adoption record accepts it or the grant is removed; so it does for a job under `permissions: write-all`, and for a job that passes the grant to a reusable workflow of the adopter's; a caller of Kanon's code-audit lane at the pinned release is listed as Kanon's and accepted; a job with `id-token: none` is not listed. |
| **L11** | Kanon vN+7 | **The agent-client skills** ([ADR 0014](../decisions/0014-adopter-audiences.md), decision 1): a small set of skills wrapping `kanon init` and `kanon doctor` that inspect the repository, explain each choice in plain words, write the files, and walk the person through the steps only a person can take (the Apps' manifest flow, the secrets, the ruleset). Prioritised by the Owner on 2026-10-06, right after L10, and used by Kanon itself: L5 and L6 run through them. | **Live:** L5 runs through the skills end to end; every step done by hand instead is recorded on L5's issue and filed as a gap against L11, not worked around. |
| **L5** | Kanon itself, **after L11** (#279 closed 2026-10-05) | **Kanon migrates from three agent Apps to the Author and the Judge, and adds the Releaser,** through the L11 skills rather than by hand ([ADR 0014](../decisions/0014-adopter-audiences.md), the Owner's decision of 2026-10-06), pinned to the release that carries L11 as ADR 0011's bootstrap requires, and only once #279 has closed (question 4). **Until L5, Kanon's own callers stay pinned below v0.28.0, L4's release** ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), amended 2026-10-06), because that release needs the Apps L5 creates; the releases from L4 to L11 reach Kanon's own lanes only at L5. The same change **removes the Dependabot hold** on Kanon's own pins (the `ignore` of `yedeya-labs/kanon*` `>= 0.28.0` in `.github/dependabot.yml`), which keeps Dependabot from proposing L4's release before Kanon has the Apps it needs. The Owner creates the three Apps with `kanon apps --owner yedeya-labs`, the callers map the four secrets and `release.yml` the Releaser's two, the register gets §3.4's rows, and `apps-check` runs. The `main` ruleset's admin bypass is replaced by the Releaser's, limited to release pull requests (#49, `K-MERGE-8`): `kanon apps` adds the Releaser's when it creates the App, and `kanon doctor` reports the admin's as `ruleset.bypass-extra` until it is removed, which the Releaser's release pull request can survive once Kanon's `dco` caller pins the release that exempts it (#337). The three old Apps are uninstalled and deleted after one week of green runs. | `apps-check` passes for the three Apps. **Live:** a release pull request opened by the Releaser runs CI; the next Kanon PR gets its verdict from the Judge, with the Reviewer's persona header; an Implementer PR authored by the Author passes `dco`. After the week, the register lists exactly three slugs, and the ruleset's bypass list names only the Releaser. |
| **M2** | the Owner, a second fresh personal repository | **Measure after** (§6), on the release that completes L9. | The record holds both timestamps and the action log. The plan's claim holds if the manual actions are fewer than half of M1's; if not, the record says which step dominated, and a follow-up is filed against it. |
| **L6** | the reference adopter and Kolophon, **after M2 and L11** (#279 closed 2026-10-05) | **Each adopter migrates once, onto the lean model** (decision 7). Kanon is applied to its adopters only after this plan is implemented, so neither adopts the per-role model first and migrates again. The reference adopter moves from about eight Apps to the Author, the Judge and, for its releases, the Releaser; Kolophon, whose plan 0001 step 6 is paused, starts on them. Each runs, through the L11 skills ([ADR 0014](../decisions/0014-adopter-audiences.md)), `kanon doctor` against the release that completes this plan, then `kanon init` for what it reports, in one switch PR that also carries the adopter-side switches plans 0001 and 0004 left waiting. Its callers map the Apps' secrets; its register gets §3.4's rows; the Merger's `logins` job outputs the Judge's and the Author's slugs (plan 0004, P5). For the reference adopter, the Owner uninstalls and deletes the old Apps after one week. | `kanon doctor` exits 0 on each adopter before its switch PR merges; `lane-check` and `apps-check` green for the Apps it runs. **Live:** on the reference adopter, the Merger merges one Author-authored pull request carrying the implementer status through the front door; a dispatch sweep's dry run prints the same verdicts as the day before the switch; the busiest hour's `x-ratelimit-remaining` for the Author's installation stays above a quarter of its limit (§3.2). On Kolophon, the first reviewed pull request comes from the Judge. |

**Why this order:**
- **Measure first.** M1 runs on today's release; every later step changes what it would measure.
- **Decisions before code** (L1): four rules and an ADR change meaning, and the guards that read the roles table must agree with them before any App changes.
- **`kanon apps` is fixed early** (L2), because it is cheap, independent of the two-App change, and is what the Owner hit.
- **Markers before Apps** (L3 before L4), as #53 did for the protocol spellings: readers learn the new signal while the old one still holds, so the breaking release flips one thing.
- **The migrations wait for #279** (question 4, met: #279 closed on 2026-10-05): the shared keys become the keys for every lane, so no agent job may hold them first.
- **Kanon migrates first, and the adopters last** (L5 after L11, L6 after M2), as ADR 0011 intends and as the Owner decided (decision 7): every lane change runs on Kanon before it reaches another adopter, and each adopter migrates once, onto the finished lean model, rather than once per breaking release.
- **Labels and defaults before `init`** (L7 and L8 before L9), so that `init` writes less, and `doctor` after it, because it reuses `init`'s inspection and the requirements file.
- **The skills next, and the migrations through them** (L11 before L5 and L6), as the Owner decided on 2026-10-06 ([ADR 0014](../decisions/0014-adopter-audiences.md)): whatever Kanon builds for its first audience, it uses itself, so its own migration and its adopters' are the skills' first real runs. **The cost:** until L5, Kanon's own callers stay pinned below v0.28.0, L4's release, so the lane changes of L4 to L11 are first exercised on Kanon at L5, not one release after each merges (ADR 0011).

## 8. Issues to file

This PR files none of them: each is filed when the Owner accepts the plan. Each goes to *Product Backlog* (Kanon has no roadmap milestone), links #288, and closes when its step's check holds. #288 stays the umbrella, and closes after M2.

| Step | Proposed title |
|---|---|
| M1 | Measure the time and manual actions from an empty personal repository to a first reviewed pull request, on the current release |
| L1 | Record personal accounts and the two-App model in ADR 0013, and amend the rules they change |
| L2 | `kanon apps`: take `--owner` and detect user or organisation, refuse outside a checkout of `--repo`, and name the token it uses |
| L3 | Write a persona header and role marker on every agent post and commit, and read the marker beside the login |
| L4 | Run the lanes as two Apps, Author and Judge, and releases as the optional Releaser App, with fixed secrets and the register's shared-slug rows |
| L7 | Create a missing taxonomy label on first use, from a machine-readable twin of `K-WORK-12` |
| L8 | Read an omitted declaration as its documented default |
| L9 | `kanon init`: inspect, ask with defaults, write the declarations, create labels and the ruleset, drive the Apps, and warn where review isn't enforced |
| L10 | `kanon doctor`: name what a release needs before the pin moves, as prose and as JSON |
| L11 | Agent-client skills wrapping `kanon init` and `kanon doctor`, used for Kanon's own migration (ADR 0014) |
| L5 | Move Kanon from three agent Apps to the Author and the Judge, through the L11 skills, replace the admin bypass with the Releaser's, and remove the Dependabot hold below v0.28.0 (after L11) |
| M2 | Measure the same path after `kanon init` |
| L6 | Move the reference adopter and Kolophon onto the lean model once, through the L11 skills, after M2 and L11 (the reference adopter's is filed there, neutrally linked) |

Already open, and folded in: #49 (the Releaser and Intake Apps) is answered by L4 and L5 for the Releaser (question 2); Intake stays an App of the running application, outside Kanon's three. #274 and #279 are the key-isolation work L5 and L6 wait for (question 4).

## 9. Cost

**AWS: none.** No step adds a resource, a schedule or an alarm, and decision 4 removes an environment.

**Actions minutes: unchanged.** No lane gains a job or a schedule. Creating a missing label is one API call inside an existing step. The two measurement repositories are public, so their minutes are free. Each measurement's first review is one Reviewer run on `CLAUDE_CODE_OAUTH_TOKEN`, the subscription the Reviewer already uses, so it spends quota and adds no bill.

**The Owner's time:** two manifest flows per owner, three with releases, instead of six to eight, and two measurement runs.

## Measurements

All commands ran on a checkout of Kanon's `origin/main` at `fdfbbd9`, with the read-only token for the GitHub calls.

**The organisation-only URLs in `kanon apps`:**

```
grep -nE "organizations/|--org" cli/apps.mjs
```

**The calls that tell roles apart by login** (14 calls in 8 scripts):

```
grep -rnoE "appLogin\('[A-Za-z]+'\)" scripts actions .github
```

**The role-named secrets in the lanes** (21 files):

```
grep -rlE "_APP_PRIVATE_KEY" .github/workflows actions | wc -l
grep -rhoE "[A-Z]+_APP_PRIVATE_KEY" .github/workflows actions | sort | uniq -c
```

**The label taxonomy** (36 rows holding 37 names; the release tool's row holds two), and Kanon's own labels (26):

```
awk '/^\| Family \| Label \| Colour/,/^$/' rulebook/01-work-items.md | grep -cE '^\| [^|]*\| `'
gh label list -R yedeya-labs/kanon --limit 200 --json name --jq 'length'
```

**The fixed governance files** (13 in `docs/qa/`): the `docs/qa/` rows of `K-LAYOUT-1`'s table, in `rulebook/11-repository-layout.md`.

**The lanes and their callers** (18): the lane table in `docs/lanes.md`.

**Kanon's Apps and their dates:** the App register, `docs/qa/agent-identities.md`, and step 12 of the adoption record, `docs/qa/adoption.md`.

**The `dco` action recognises an agent commit by its noreply email:** `BOT_NOREPLY` in `actions/dco/dco.mjs`.

## Decisions for the Owner

Questions 1 to 5 were answered by the Owner on 2026-10-05, the day the plan was drafted. Question 6 was raised by the plan's first review, and the Owner decided it the same day.

1. **Decided by the Owner, 2026-10-05: keep the six declaration files.** The plan asked whether the six #288 names (the adoption record, the stack document, the escalation file, the test-database declaration, the sign-off delegation and the App register) should become one file. Against it: the files change at different speeds and by different hands (`kanon apps` writes the register, the Owner records the delegation as a personal act, `K-AGENT-44`, and the stack document changes with the code), and every reader, the `dco` action among them, would be rewritten. The Owner decided: keep the files, remove the work with §5.2's documented defaults and `kanon init`, and **revisit after M2** if the declarations still dominate the time. No step merges them.
2. **Decided by the Owner, 2026-10-05: changed.** The plan recommended that no App be a bypass actor, with the Releaser inside the Author and release pull requests merged through the front door. The Owner decided: **a third, Releaser-only App holds the release bypass**, so the model is the Author, the Judge and the Releaser, and the Releaser is optional: an adopter without releases, or without a bypass, needs only two (§3.1, decision 2). Its secrets are `RELEASER_APP_ID` and `RELEASER_APP_PRIVATE_KEY`, and `lane-check` fails a register in which it shares a slug with the Author or the Judge.
3. **Decided by the Owner, 2026-10-05: accepted.** **A private repository on GitHub Free is allowed, and never leaves bootstrap** (`K-ADOPT-3`). Every lane runs in full there, and the Merger still merges only what the Judge approved, but nothing on the platform refuses a merge without an approval. `kanon init` says so plainly (§5.4), and the adoption record records it.
4. **Decided by the Owner, 2026-10-05: accepted.** **The two-App release may ship** (L4), but **Kanon's and the reference adopter's migrations wait until #279 closes** (L5, L6), so no agent job holds the Author's or the Judge's key on the day it becomes the key for every lane of that owner.
5. **Decided by the Owner, 2026-10-05: accepted, unless the review objects.** **The register keeps one row per role, with roles sharing a slug** (§3.4), and `lane-check` holds the Author, the Judge and the Releaser to three distinct slugs. `K-LAYOUT-6` says "a row per role".
6. **Decided by the Owner, 2026-10-05: accepted. The green zone requires an implementer commit status** (§3.3, from the first review). With one Author App, the `implementer` marker can be written by any Author lane's agent, so on its own it would let a steered Lead, Explorer or Overseer agent put a code pull request in the green zone, with the Reviewer's approval as the only gate. The Owner decided: a fixed step of the implement lanes, never the agent, sets `kanon/role: implementer` on the pull request's head with a token narrowed to Commit statuses write, which no agent's token holds; the Merger requires that status on the current head, created by the Author App; and the Author App gains Commit statuses write, recorded as a broadened permission in the register (`K-AGENT-3`). Only implement and triage create the first status, and only on the pull request their own run opened, identified by what the run created (opened after the run started, from a branch first pushed in the run, at the head it pushed), never by the pull request's link to the issue, its label or its author; when that is ambiguous they stamp nothing, by name (§3.3, from the third review). Implement-revise and rebase set it on their new head only when the head they started from carried one created by the Author App, and refuse the pull request otherwise (§3.3, from the second review). L4 carries the mutations, including an already-open forged pull request closing the issue, which the implement lane leaves unstamped: a forged Author pull request, on code paths, marked `implementer` and labelled `agent:implement` but without the status, or with one created by another App, gets `not-the-implementer`; and the same forged pull request sent through implement-revise or rebase is refused by that lane, and still gets `not-the-implementer`. It is unforgeable by another lane's agent once #279 keeps the key out of every agent's job, which question 4 already makes a precondition of the migrations.
