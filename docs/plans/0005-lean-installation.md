# Plan 0005: the lean installation

- **Status:** proposed, 2026-10-05. The Owner took six decisions on 2026-10-05, before this plan was drafted; they are recorded as decided (§4). Decision 4 is in flight in #291. Five questions remain for the Owner ([Decisions for the Owner](#decisions-for-the-owner)), each with a recommendation.
- **Why now:** the Owner's verdict in #288, after installing Kanon on the reference adopter and on Kanon itself: the installation and bootstrap phase is long, tedious and cumbersome, and has to get smoother before other adopters arrive. Kanon hit it again on 2026-10-05, when `kanon apps` wrote the App register outside the checkout (#288's comment), and the Owner hit a stale `GH_TOKEN` repeatedly the same day.
- **Tracks:** #288. **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md) (standardise, don't parameterise), [ADR 0008](../decisions/0008-installation-test-decisions.md), whose §2 this plan supersedes, [ADR 0009](../decisions/0009-move-dont-rewrite.md), [ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), chapter 10 (`K-ADOPT-*`), and #274 and #279 (key isolation).
- **Measured on** Kanon's `origin/main` at `fdfbbd9` (v0.24.0 plus #289), on 2026-10-05, and on Kanon's GitHub settings through the API. The commands are in [Measurements](#measurements). The time from an empty repository to a first reviewed pull request has **not been run**: it is step M1, and its method is in §6.

## The plan in one paragraph

**Today.** An adopter installs Kanon by hand, in fourteen ordered steps (`K-ADOPT-1`), plus a lane caller per lane. Each agent role is its own GitHub App: six roles, so six manifest flows, twelve secrets and six register rows per repository, and the reference adopter runs about eight Apps. The Apps must live in an organisation (`K-ADOPT-2`), and `kanon apps` builds only organisation URLs. The labels, the declaration files and the environment are made by hand, learned one `lane-check` failure at a time. Nothing tells an adopter, before the first red run, what a new release needs.

**Where it ends.**
- **Any GitHub account can adopt Kanon.** A personal account is first-class. Organisations and paid features are used where they exist and required nowhere (decision 1).
- **Two GitHub Apps per owner, reused across that owner's repositories:** the **Author** (Implementer, Lead, Explorer, Overseer, Releaser) and the **Judge** (Reviewer, Merger) (decision 2). Each lane still narrows its token to what it uses (`K-AGENT-46`), and each agent still speaks as its role, through a persona header and a role marker (decision 3).
- **`kanon init`** inspects a repository, asks what it can't infer, with a default for each answer, writes the declarations, creates the labels and, where the plan has them, the ruleset's checks, and drives the two Apps. **`kanon doctor`** re-runs after an upgrade and names exactly what the new release needs, before the first red run.
- **An omitted declaration means the documented default,** and **a lane creates a label it needs and doesn't find.**
- **The time from an empty repository to a first reviewed pull request** is measured before and after, on a fresh personal-account repository (§6).

**How it gets there.** Measure first. Then write the decisions into an ADR and the rulebook, fix `kanon apps` where it bit the Owner, and teach the lanes to write and read the role marker beside the login, before any App changes. Then one breaking release moves the lanes to the two Apps, Kanon migrates, and the reference adopter follows. Labels and defaults come next, so that `kanon init` has less to write, and `kanon doctor` last, because it reuses `init`'s inspection. Measure again.

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
| Labels | 40 in the taxonomy, and 7 of GitHub's defaults to delete. Kanon itself has 26 today, so its step 6 is "not done" | by hand | `K-WORK-12` |
| Fixed governance files in `docs/qa/` | 13: the App register, the capability ledger, the escalation file, the adoption record, the sign-off delegation, the exemptions file, the test-database declaration, the stack document, and five playbooks. #288 counts six of them as *declarations*: the adoption record, the stack document, the escalation file, the test-database declaration, the sign-off delegation and the App register | by hand, each in its own format | `K-LAYOUT-1` |
| Lane callers | 1 per lane: 18 lanes, plus the `apps-check` caller, `lane-check` in CI and a Dependabot entry with the cooldown written out | by hand, from `docs/lanes.md` | `K-LAYOUT-18`, `K-ADOPT-11` |
| The project-setup hook and `ci.yml` | 1 each | by hand | `docs/lanes.md` |
| Environments | 1, `kanon-qa-store`, for an adopter with a store. #291 removes it (decision 4) | by hand | `docs/qa-store.md` |
| Ruleset | 1, plus its required checks | by hand | `K-ADOPT-1` step 8 |
| Upgrade needs | not listed anywhere machine-readable; a release's notes say what changed, and `lane-check` or the first red run finds the rest | by hand | #288 |

**Two traps the Owner hit on 2026-10-05,** neither of which fails visibly:
- **`kanon apps` run outside the checkout** created both Apps and their secrets, then wrote a fresh register relative to the working directory, in the checkout's parent. Nothing said it wasn't the repository's register; #289 copied the rows in by hand (#288's comment).
- **A stale `GH_TOKEN`** wins over `gh`'s stored login. `kanon apps` already says so in its usage text and in its preflight's refusal, but it never says which token it used, or whose it is.

**Code that tells two roles apart by login.** 14 calls to `appLogin('<Role>')` in 8 library scripts, each comparing an author or actor against one role's App (§3.3). With two Apps, every comparison between two roles of the same App needs another signal.

## 2. The target

| What | After this plan |
|---|---|
| Account | any: a personal account or an organisation (decision 1) |
| Apps | 2 per owner, reused across its repositories (decision 2) |
| Manifest flows | 2 per owner, and none for that owner's next repository |
| App secrets per repository | 4: `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY`, `JUDGE_APP_ID`, `JUDGE_APP_PRIVATE_KEY` |
| Labels | none by hand: `kanon init` creates the taxonomy, and a lane creates a missing label on first use (§5.3) |
| Declarations | written by `kanon init` from questions with defaults; a section left out means the documented default (§5.2) |
| Environments | none (decision 4) |
| Lane callers | one per lane, unchanged (decision 6); `kanon init` writes the ones the adopter chooses |
| Upgrades | `kanon doctor` names what the new release needs before the pin moves (§5.5) |

## 3. Two Apps

### 3.1 Which roles each App holds, and its permissions

Each App holds the union of its roles' rows in chapter 03's roles table, plus Metadata: read (`K-ADOPT-8`):

| App | Roles | Contents | Issues | Pull requests | Workflows | Actions | Checks, Commit statuses |
|---|---|---|---|---|---|---|---|
| **Author** | Implementer, Lead, Explorer, Overseer, Releaser | write | write | write | write | read | none |
| **Judge** | Reviewer, Merger | write | write | write | none | write | read |

- **The one essential separation is author and approver.** GitHub forbids an identity to approve its own pull request, so a Judge approval on an Author pull request is a real approval, and the ruleset's required review means what it says (`K-MERGE-6`). The Author never approves, and the Judge never authors.
- **Least privilege stays at the token** (decision 2). Every minting step already narrows its token to what that step uses, and `tests/unit/app-token-permissions.test.ts` holds each step to its list and each list to the role's grant (#155, `K-AGENT-46`). That test changes only in what it compares against: the list must fit inside the *App's* grant, and still inside the *role's* row. So the Lead's token still carries no Workflows, and the review token no Actions write.
- **`K-AGENT-7` keeps its meaning.** Only the Author holds Workflows, and only the Implementer's lanes mint with it. The Judge, and so the Merger, never holds it.
- **The Releaser.** Today it is a bot with a ruleset bypass limited to release pull requests (`K-MERGE-8`), and Kanon merges its release pull requests through an admin bypass (#49). Putting it in the Author raises a question this plan can't settle alone: a bypass granted to the Author would also be the Implementer's. See question 2.

### 3.2 What one App per owner changes

- **One installation per owner,** with "Only select repositories". The App covers each repository that adopts Kanon, and nothing else. `apps-check` stops warning that an App covers other repositories, and keeps warning when it covers *all* of them (`K-ADOPT-8`, amended).
- **Keys.** GitHub has no API that makes a new private key for an existing App (`docs/apps.md`, Limits). The key `kanon apps` receives at creation is in memory once, so the command sets it on **every repository named at creation** in the same run (`--repo a,b,c`). A repository added later gets a key the Owner generates on the App's settings page; `kanon apps --reuse` reads that file, stores the secret, and deletes the file. An organisation may instead hold the two secrets once, as organisation secrets, where its plan offers them for its repositories (`K-AGENT-6` already counts them).
- **Blast radius.** Any key of the App mints tokens for every repository the installation covers. With one App per role per repository, a leaked Lead key reached one repository with the Lead's grant; a leaked Author key reaches every adopting repository of that owner with the Author's grant. That is the cost of reuse, and it makes #274 and #279, which keep the key out of every job that runs an agent, more urgent. See question 4.
- **Rate limits.** GitHub's API rate limit for an App is per installation, so every lane of every adopting repository of one owner shares the Author's budget, and the Judge's. Step L6's live check reads `x-ratelimit-remaining` at the busiest hour of the reference adopter, which runs the most lanes.

### 3.3 Personas without per-role Apps (decision 3)

**What a reader sees.** Every post an agent writes (a comment, a review, an issue or pull request body) opens with a persona header, `**<persona> (<Role>)**`. The persona is a display name the adopter may declare (`K-AGENT-2`'s "the project supplies: the display names of its Apps", which becomes "of its personas"); without one, the header is the role alone, `**Reviewer**`. Every commit an agent makes is authored with the persona as its *name* and the App's noreply address, `<id>+<slug>[bot]@users.noreply.github.com`, as its *email*. GitHub attributes the commit to the App by its email, so the avatar stays the App's, and the `dco` action already recognises an agent commit by that email (`actions/dco/dco.mjs`), so the delegate's sign-off still matches (`K-AGENT-44`).

**What a machine reads.** A hidden role marker, `<!-- kanon:role=<role> -->`, beside the header, plus the labels and trailers the lanes already write. A check trusts a marker only on an object the expected App authored: the login says *which App*, the marker says *which of its roles*. A member can edit a marker on an App's pull request, but a member is already trusted (`K-AGENT-45`), and a stranger can edit neither.

**The readers that change.** Each of the 14 `appLogin` calls compares against one role. The ones that compare two roles of the same App switch to "the App's login **and** the role's marker":

| Script | Roles it tells apart | Same App after this plan |
|---|---|---|
| `merge-gate.mjs` | the Implementer's pull requests, the Reviewer's verdicts, the Merger's own comments | the Implementer vs the Lead (both Author); the Reviewer vs the Merger (both Judge) |
| `dispatch-sweep.mjs` | the Implementer's and the Lead's comments on an issue | both Author |
| `lead-reconcile.mjs` | the Explorer's filings | Author, beside the Lead itself |
| `review-run-evidence.mjs`, `brief-revise-recovery.mjs` | the Lead's brief pull requests | Author, beside the Implementer's |
| `rebase-lane.mjs` | the Implementer's pull requests | Author, beside the Lead's |
| `incremental-review.mjs`, `review-recovery.mjs` | the Reviewer's reviews | Judge, beside the Merger, whose comments already carry `<!-- merger:… -->` |

**The Merger's green zone** changes from "authored by the Implementer" to "**authored by the Author App and marked `implementer`**", with its other conditions unchanged (`K-MERGE-4`). Because the Lead, the Explorer and the Overseer now author as the same App, a marker written by one of them is the only thing between their pull request and the green zone. So the Merger also refuses a pull request that touches `docs/projects/` (a brief, which only the Maintainer approves by merging), and step L3's mutation shows a Lead-marked Author pull request refused.

**The only loss:** a distinct avatar per persona.

### 3.4 The App register

Two shapes would carry two Apps. This plan recommends the first (question 5):
- **A, recommended: one row per role, as today, with roles sharing a slug.** The Author's five rows name one slug, the Judge's two rows another. Every reader that maps a role to a login keeps working, which is all of them today (`cli/app-register.mjs`, `scripts/app-register.mjs`, `actions/lane-check/app-register.awk`, the `dco` parser), and the register still says which role each App plays. `lane-check` fails a register in which the Author's roles name more than one slug, the Judge's roles more than one, or an Author role and a Judge role share a slug (the self-approval case). `K-LAYOUT-6`'s "a row per App" becomes "a row per role".
- **B: one row per App, with a Roles column.** Closer to `K-LAYOUT-6`'s present words, but every reader of the register is rewritten (ADR 0009), and the `dco` action reads it from the default branch of every adopter, so a release in between would read the wrong shape.

### 3.5 Secrets

The lanes declare **`AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY`, `JUDGE_APP_ID` and `JUDGE_APP_PRIVATE_KEY`**, by fixed name, mapped by the caller and never inherited, as today. `CLAUDE_CODE_OAUTH_TOKEN` and `DIGEST_WEBHOOK` are unchanged. Today the lanes reference six role pairs (measured: `IMPLEMENTER_` 23 times, `LEAD_` 21, `EXPLORER_` 13, `REVIEWER_` 13, `OVERSEER_` 6, `MERGER_` 5, across 21 files). The rename is one breaking release (step L4), because an adopter's callers and its register must change together, and `lane-check` judges both.

## 4. Decisions

**Decided by the Owner, 2026-10-05:**

1. **Personal accounts are first-class.** Organisations and paid features (the merge queue, environments, organisation secrets) are supported where they exist, and nothing in Kanon may require them. This supersedes ADR 0008 §2 and `K-ADOPT-2`, and the assumptions table's organisation row in chapter 00. `kanon apps` takes `--owner` and detects whether it is a user or an organisation; today it takes `--org` only and builds `organizations/<org>/settings/apps` URLs throughout (`cli/apps.mjs`, from its usage text to the key-rotation steps). `K-ADOPT-3`'s table gains the personal-account columns, measured on the test account at step M1. **A consequence to record:** on a personal account a collaborator has write access, with no Triage role, so the Stakeholder holds more than chapter 03's "Triage"; the adoption record says so.
2. **Two GitHub Apps per owner, not one per role,** reused across that owner's repositories: the **Author** (Implementer, Lead, Explorer, Overseer, Releaser), which writes code, issues and pull requests, and the **Judge** (Reviewer, Merger), which reviews and merges and never authors (§3.1). *Rationale:* GitHub forbids self-approval, so author and approver is the one essential separation; per-lane token narrowing (#155) keeps least privilege at the token; setup drops from six to eight manifest flows to two per owner. This amends `K-PRIN-5` (author and approver are distinct identities; the reviewer and the merger may be one), `K-AGENT-1` and `K-AGENT-2` (an identity per *App*, a persona per role), `K-AGENT-7`'s wording, `K-ADOPT-8`, `K-LAYOUT-6`, the roles table and `agent-permissions.json`.
3. **Personas without per-role Apps** (§3.3): a persona header in every post, the persona as each commit's author name with the App's noreply email, and a hidden role marker plus the existing labels and trailers for machine checks. The Merger's "authored by the Implementer" becomes "authored by the Author App and marked `implementer`". The only loss is a distinct avatar per persona.
4. **Environments are dropped** (#290, in flight in #291). The QA store trusts the default branch's ref subject instead of the `kanon-qa-store` environment, and a widened guard holds which jobs may hold `id-token: write`. Once #291 merges, no Kanon lane needs an environment, which a personal account's private repository may not have.
5. **The rest of the lean plan:**
   - **`kanon init` and `kanon doctor`** (#288), §5.4 and §5.5.
   - **Sensible defaults:** an omitted declaration section means the documented default (§5.2).
   - **Lanes create missing labels on first use** (§5.3).
   - **One declaration file instead of six** is considered, and is question 1.
   - **`kanon apps` refuses outside a checkout of `--repo`** (#288's comment), before it opens any page.
   - **The CLI says which token it used,** and how to fix a stale `GH_TOKEN`.
6. **One caller per lane stays** (`K-LAYOUT-18`). "One caller per trigger group", which would cut the number of caller files, is deferred: Kanon's scripts find a lane's runs by its caller's file name, and GitHub files a run under the top-level workflow.

**Open, for the Owner:** questions 1 to 5, in [Decisions for the Owner](#decisions-for-the-owner).

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

### 5.3 Labels on first use

The taxonomy (`K-WORK-12`, 40 labels) gains a machine-readable twin, `rulebook/labels.json`, with a test that fails when the table and the file disagree, as `agent-permissions.json` does for the roles table. When a lane applies a label the repository lacks, it creates it first, with the taxonomy's colour and description, and says so in its summary. Both Apps hold Issues write, which creating a label needs, and each minting step's list already includes it where the step labels. A label outside the taxonomy is never created: an unknown name is a bug, and fails by name. `kanon init` creates the whole taxonomy, and deletes GitHub's defaults that aren't in it, after asking.

### 5.4 `kanon init`

Run once, from the checkout, by the Owner:
1. **Inspects** the repository and its owner, read-only: user or organisation, public or private, the plan's features (rulesets, merge queue) from the API, the existing labels, the declaration files, the callers, the ruleset, the secrets' names, and the App register.
2. **Asks** only what it can't infer, each question with a default: the people (`K-ADOPT-1` step 2), the stack's gates, the test database, whether to record a sign-off delegation, which lanes to install.
3. **Writes** the declaration files, the lane callers it was asked for, the `apps-check` caller, `lane-check` in CI and the Dependabot entry, all pinned to the release it runs from, and prints the diff. It commits nothing.
4. **Creates** the taxonomy's labels and the bucket milestones (`kanon milestones`), and, where the plan has rulesets and the token holds Administration, the ruleset with its required checks; otherwise it prints the fallback `K-ADOPT-3` records.
5. **Drives `kanon apps`** for the Author and the Judge, or `--reuse` when the owner's register on another repository already names them.

Re-running it is safe: it changes nothing that is already right, and names what it would change.

### 5.5 `kanon doctor`

Every release ships a machine-readable requirements file: the permissions each App's lanes mint with, the declarations and sections each lane reads, the labels each lane applies, and the secrets each caller maps. `kanon doctor --to vX.Y.Z` reads the repository as `init` does, compares it with that release's requirements, and lists exactly what the upgrade needs, in the order to do it: an App permission to widen, a declaration to add, a caller's grant to change. It exits non-zero while anything is missing. It writes nothing; `kanon init` fixes what can be fixed from the checkout. Run before merging Dependabot's pin bump, it turns "the first red run" into a list.

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
| **L1** | Kanon, docs | **Write the decisions down.** ADR 0013 records decisions 1 to 3 and supersedes ADR 0008 §2. The same PR amends `K-PRIN-5`, `K-AGENT-1`, `K-AGENT-2`, `K-AGENT-7`, `K-ADOPT-1` (step 1), `K-ADOPT-2`, `K-ADOPT-3`, `K-ADOPT-8`, `K-LAYOUT-6`, chapter 00's assumptions table and chapter 03's roles table, and adds the two Apps to `agent-permissions.json` as the union of their roles. | `tests/unit/agent-permissions.test.ts` fails when an App's permissions differ from the union of its roles' rows, and when a role belongs to no App or to two. **Mutation:** removing `workflows` from the Author, or adding it to the Judge, turns it red. `rulebook-why.test.ts` and the adoption-record test stay green. |
| **L2** | Kanon vN | **`kanon apps`, fixed** (§5.1): `--owner` with user or organisation detection; the refusal outside a checkout of `--repo`; the token's source and login printed, and the stale-`GH_TOKEN` fix in the refusal. | `tests/unit/kanon-apps.test.ts`: for a `User` owner every URL the command prints or opens is under `github.com/settings/`, and for an `Organization` under `github.com/organizations/<org>/`. Run from a directory whose remote is another repository, or from no checkout, the command exits non-zero before the preflight's `gh secret set`, and the message names the directory and `--repo`. **Mutation:** moving the checkout check after the preflight turns the test red. **Live:** the M1 repository's owner gets a working manifest flow. |
| **L3** | Kanon vN+1 | **Personas and role markers, additive** (§3.3). Every post and commit the lanes write carries the persona header, the role marker and the persona as the commit's author name. Every reader in §3.3's table accepts the marker beside today's login, so nothing changes while each role still has its own App. The Merger refuses a pull request that touches `docs/projects/`. | A library test runs each reader in §3.3's table against an object with the right login and marker, the right login and another role's marker, and the right login and no marker: each is read as today in this release, and the test names what L4 flips. `tests/unit/agent-commits.test.ts` judges a persona-named commit with the App's noreply email with the `dco` action's own check: it passes with the delegate's sign-off. **Mutation:** a writer that drops the marker fails the writer test. |
| **L4** | Kanon vN+2, **breaking** | **Two Apps.** The lanes declare `AUTHOR_*` and `JUDGE_*` (§3.5); the readers require the marker wherever two roles share an App; the Merger's green zone is "authored by the Author App and marked `implementer`". `kanon apps --apps author,judge --repo a,b,c` creates each App once and sets its key on every repository named; `--reuse` adds a repository from a key file. `apps-check` checks two Apps, and `lane-check` the register's shape (§3.4) and the four secret names. | `lane-check` fails a caller mapping a role-named secret, a register whose Author roles name two slugs, and one where an Author and a Judge role share a slug. `app-token-permissions.test.ts` holds each minting step inside its App's grant and its role's row. **Mutation:** an Author pull request marked `lead` with every other green-zone condition met gets `not-the-implementer` from `mergeVerdict`; a Judge review is still counted as the Reviewer's, and a Judge comment with the Merger's marker is not. `grep -rnE "(EXPLORER\|IMPLEMENTER\|REVIEWER\|MERGER\|LEAD\|OVERSEER)_APP_" .github/workflows actions` prints nothing outside the old-spelling notes. |
| **L5** | Kanon itself | **Kanon migrates from three Apps to two,** pinned to L4's release as ADR 0011's bootstrap requires (the pin moves only after L4 is released). The Owner creates the Author and the Judge with `kanon apps --owner yedeya-labs`, the callers map the four secrets, the register gets §3.4's rows, and `apps-check` runs. The three old Apps are uninstalled and deleted after one week of green runs. | `apps-check` passes for both Apps. **Live:** the next Kanon PR gets its verdict from the Judge, with the Reviewer's persona header; an Implementer PR authored by the Author passes `dco`. After the week, the register lists exactly two slugs. |
| **L6** | the reference adopter | **The reference adopter migrates from about eight Apps to two,** in one switch PR on L4's release. Its callers map the four secrets; its register gets §3.4's rows; the Merger's `logins` job outputs the Judge's and the Author's slugs (plan 0004, P5); `lane-check` runs green. The Owner uninstalls and deletes the old Apps after one week. | `lane-check` green, `apps-check` green for two Apps. **Live:** the Merger merges one Author-authored, `implementer`-marked pull request through the front door; a dispatch sweep's dry run prints the same verdicts as the day before the switch; the busiest hour's `x-ratelimit-remaining` for the Author's installation stays above a quarter of its limit (§3.2). |
| **L7** | Kanon vN+3 | **Labels on first use** (§5.3): `rulebook/labels.json`, its parity test, and the create-before-apply step in every lane that labels. | A lane test on a fixture repository without `qa:needs-split` creates it with the taxonomy's colour, then applies it. **Mutation:** a label name outside `labels.json` fails by name and creates nothing; a colour changed in the table but not in the file fails the parity test. |
| **L8** | Kanon vN+4 | **Defaults** (§5.2), in each rule and each reader. | For each row of §5.2's table marked new, a test runs the reader on a repository without the file or section and asserts the default and the summary line that names it. `lane-check` passes a fixture repository that has only the stack document's `## Gates`, the register and the adoption record's people. **Mutation:** the same fixture with a malformed section, rather than a missing one, still fails by name. |
| **L9** | Kanon vN+5 | **`kanon init`** (§5.4), and the requirements file each release ships. | On an empty fixture repository, `init` with every default accepted writes files that pass `lane-check` for the Reviewer's lane. Run a second time, it changes nothing and says so. **Mutation:** deleting one label after the first run makes the second run create exactly that label. |
| **L10** | Kanon vN+6 | **`kanon doctor`** (§5.5). | On a fixture pinned at one release, `doctor --to` a release whose requirements add an App permission and a declaration lists exactly those two, and exits non-zero; after both are fixed it exits 0. **Mutation:** a requirements file that drops the permission makes `doctor` miss it, and the test that compares the requirements file with the lanes' minting steps turns red. |
| **L11** | Kanon, **only if the Owner chooses it** | **One declaration file** (question 1). | Defined with the Owner's answer. |
| **M2** | the Owner, a second fresh personal repository | **Measure after** (§6), on the release that completes L9. | The record holds both timestamps and the action log. The plan's claim holds if the manual actions are fewer than half of M1's; if not, the record says which step dominated, and a follow-up is filed against it. |

**Why this order:**
- **Measure first.** M1 runs on today's release; every later step changes what it would measure.
- **Decisions before code** (L1): four rules and an ADR change meaning, and the guards that read the roles table must agree with them before any App changes.
- **`kanon apps` is fixed early** (L2), because it is cheap, independent of the two-App change, and is what the Owner hit.
- **Markers before Apps** (L3 before L4), as #53 did for the protocol spellings: readers learn the new signal while the old one still holds, so the breaking release flips one thing.
- **Kanon migrates before the reference adopter** (L5 before L6), as ADR 0011 intends: every lane change runs on Kanon before it reaches another adopter.
- **Labels and defaults before `init`** (L7 and L8 before L9), so that `init` writes less, and `doctor` last, because it reuses `init`'s inspection and the requirements file.

## 8. Issues to file

This PR files none of them: each is filed when the Owner accepts the plan. Each goes to *Product Backlog* (Kanon has no roadmap milestone), links #288, and closes when its step's check holds. #288 stays the umbrella, and closes after M2.

| Step | Proposed title |
|---|---|
| M1 | Measure the time and manual actions from an empty personal repository to a first reviewed pull request, on the current release |
| L1 | Record personal accounts and the two-App model in ADR 0013, and amend the rules they change |
| L2 | `kanon apps`: take `--owner` and detect user or organisation, refuse outside a checkout of `--repo`, and name the token it uses |
| L3 | Write a persona header and role marker on every agent post and commit, and read the marker beside the login |
| L4 | Run the lanes as two Apps, Author and Judge, with four fixed secrets and the register's shared-slug rows |
| L5 | Move Kanon from three Apps to the Author and the Judge |
| L6 | Move the reference adopter to the Author and the Judge (filed in the reference adopter, neutrally linked) |
| L7 | Create a missing taxonomy label on first use, from a machine-readable twin of `K-WORK-12` |
| L8 | Read an omitted declaration as its documented default |
| L9 | `kanon init`: inspect, ask with defaults, write the declarations, create labels and the ruleset, drive the two Apps |
| L10 | `kanon doctor`: name what a release needs before the pin moves |
| L11 | Merge the declarations into one file (only if the Owner chooses it) |
| M2 | Measure the same path after `kanon init` |

Already open, and folded in: #49 (the Releaser and Intake Apps) is answered by L4 for the Releaser and question 2; Intake stays an App of the running application, outside Kanon's two. #274 and #279 are the key-isolation work question 4 depends on.

## 9. Cost

**AWS: none.** No step adds a resource, a schedule or an alarm, and decision 4 removes an environment.

**Actions minutes: unchanged.** No lane gains a job or a schedule. Creating a missing label is one API call inside an existing step. The two measurement repositories are public, so their minutes are free. Each measurement's first review is one Reviewer run on `CLAUDE_CODE_OAUTH_TOKEN`, the subscription the Reviewer already uses, so it spends quota and adds no bill.

**The Owner's time:** two manifest flows per owner instead of six to eight, and two measurement runs.

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

**The label taxonomy** (40 rows), and Kanon's own labels (26):

```
awk '/K-WORK-12. Use the fixed/,/^\*\*Why/' rulebook/01-work-items.md | grep -cE '^\| [^|]*\| `'
gh label list -R yedeya-labs/kanon --limit 200 --json name --jq 'length'
```

**The fixed governance files** (13 in `docs/qa/`): the `docs/qa/` rows of `K-LAYOUT-1`'s table, in `rulebook/11-repository-layout.md`.

**The lanes and their callers** (18): the lane table in `docs/lanes.md`.

**Kanon's Apps and their dates:** the App register, `docs/qa/agent-identities.md`, and step 12 of the adoption record, `docs/qa/adoption.md`.

**The `dco` action recognises an agent commit by its noreply email:** `BOT_NOREPLY` in `actions/dco/dco.mjs`.

## Decisions for the Owner

1. **One declaration file instead of six?** The six #288 names (the adoption record, the stack document, the escalation file, the test-database declaration, the sign-off delegation and the App register) would become one, say `docs/qa/kanon.md`, with a section each.
   - *For:* one file to write and to find; one parser; one place that shows the defaults in use.
   - *Against:* the files change at different speeds and by different hands: `kanon apps` writes the register, the Owner records the delegation as a personal act (`K-AGENT-44`), and the stack document changes with the code. One file mixes those histories, and makes a tool's write conflict with a person's edit. Every reader is rewritten (`lane-check`'s awk, the `dco` action, `reference-deploy`, `test-database`, `code-areas`, the digest audience), and the `dco` action reads its file from every adopter's default branch, so the move needs a release that reads both shapes. Each file is already pipeline governance as part of `docs/qa/` (`K-LAYOUT-1`), so merging them changes no escalation.
   - **Recommendation: keep the files, and remove the work instead.** With §5.2's defaults, a new adopter writes the stack document's gates and the adoption record's people, and `kanon apps` writes the register; `kanon init` writes all of them. Revisit if M2 shows declarations still dominate the time.
2. **The Releaser in the Author, and the release bypass.** A ruleset bypass for release pull requests (`K-MERGE-8`) granted to the Author would also be the Implementer's, the Lead's, the Explorer's and the Overseer's, because a bypass is granted to an App, not to a role.
   - **Recommendation: no App is a bypass actor.** The Author opens the release pull request, so CI runs on it (one opened with the workflow token gets no CI run, #49's finding), the Judge reviews it like any other, and the Maintainer merges it through the front door, or the merge queue. `K-MERGE-8`'s bypass list becomes empty, and Kanon's admin bypass goes when L5 lands.
   - *Alternative:* a third App for the Releaser alone, for an adopter that wants releases merged without a person. That keeps the bypass narrow, at the cost of a third manifest flow.
3. **A private repository on a plan without rulesets.** On GitHub Free, a private repository, personal or organisation, has no rulesets and no branch protection, so `K-ADOPT-3` leaves it in bootstrap for good. Decision 1 says nothing may *require* a paid feature.
   - **Recommendation: keep `K-ADOPT-3`'s outcome, and say plainly what it means.** Every lane runs in full on such a repository, and the Merger still merges only what the Judge approved. What can't exist is the *platform's* refusal to merge without an approval, so a person can merge past the Reviewer. The adoption record says so, and `kanon init` prints it. Paying, or making the repository public, is the project's decision, as today.
4. **Do the migrations wait for key isolation?** With one Author App per owner, its key is in the jobs of five roles' lanes, and a leaked key mints the Author's grant on every adopting repository of that owner (§3.2). #279 lists eight lane jobs that still hold an App key beside the agent; #281 is fixing the spine.
   - **Recommendation: yes.** L4 can ship, but L5 and L6 run only after #279 closes, so no agent job holds the Author's or the Judge's key on the day it becomes the key for every lane.
5. **The register's shape** (§3.4).
   - **Recommendation: A**, one row per role with roles sharing a slug, with `lane-check` holding the shape; `K-LAYOUT-6` says "a row per role". It keeps every reader, including the `dco` action that reads every adopter's default branch.
