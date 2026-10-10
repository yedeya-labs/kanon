# Plan 0007: a guided install built on features, a short runbook and one confirmation

- **Status:** decided, 2026-10-10. The Owner took five decisions on 2026-10-10, before this plan was drafted, from the first timed install, decided nine more the same day on its pull request (its eight open points, and decision 8, which came from §3's text rather than the open list), and a tenth after its review (decision 15): all are recorded in [Owner decisions (2026-10-10)](#owner-decisions-2026-10-10). The Owner changed one proposal: **the recommended review trigger is labelled only, `review:please`, as today**, so the every-PR lane change is optional and built on demand (step G7). No question remains open.
- **Why now:** the first timed install of the adoption wedge, a review-only adoption on a private repository through `/kanon:adopt`, took **about 36 minutes of the adopter's time against a 15-minute target**, and **about 11 of them went on questions**. The rest went on one GitHub App (about 10 minutes, four of them lost to a key page GitHub has moved), the Claude token (about 2) and the merge and its required check (about 3). The Owner's verdict, during the run: *"we need to offer features that include a set of agents and their modes, it doesn't make sense to go over each agent and mode combination. This is too complex to install."*
- **Tracks:** #288. **Builds on:** [plan 0005](0005-lean-installation.md) (L9 `kanon init`, L11 the skills) and [plan 0006](0006-upstream-findings.md) (§3.2, the upstream-findings questions). **Supersedes:** #428's rule that the adopt skill asks every input as its own question ([§8](#8-428s-decision-and-what-replaces-it)). **Governed by:** [ADR 0002](../decisions/0002-standardise-dont-parameterise.md), [ADR 0007](../decisions/0007-data-boundary.md), whose "asked as their own questions" step G1 amends, [ADR 0014](../decisions/0014-adopter-audiences.md) (the skills drive the commands through their JSON only), `K-LAYOUT-10`, `K-OBS-18` and `K-AGENT-45`.
- **Measured on** the friction log of that first timed install, on Kanon's `origin/main` at `a074df5` (v0.38.0 plus two commits), and on `skills/adopt/SKILL.md`, `docs/init.md`, `docs/lanes.json` and `requirements.json` there. Nothing in this plan has run yet; step T2 is the measurement.

## The plan in one paragraph

**Today.** `/kanon:adopt` asks every answer of `kanon init` as its own question (#428): the three people, nine lane groups (three question rounds even for a review-only install), the gates, the test database, the delegation, the default labels, the Releaser, App reuse, the plugin, and three questions about sharing data, telemetry, upstream findings and their evidence, each with a paragraph of caveats and each recommending its most restrictive answer. It then hands over the steps only a person can do as blocks of text, with commands whose inputs don't exist yet, and with a key page GitHub no longer has.

**Where it ends.**
- **Four questions, asked at once** (three until the optional every-PR trigger ships, §3): what Kanon should do (a **feature**: Review, Review + build, Full pipeline, or Customise), which pull requests the Reviewer reviews (labelled `review:please` only, recommended, as today), whether the repository holds sensitive material, and one consent question for sharing.
- **Everything else is inferred or defaulted, and shown in one summary** the person confirms or edits. Nothing is silent: every value says where it came from.
- **A runbook of person steps,** one at a time: a direct link, one action, "done?", then the next, with every command filled in with real values, and shown only once its inputs exist.
- **Style rules for every skill question,** held by a guard: one decision, two short sentences at most, short options with a one-line consequence, the recommended first, caveats behind a link.
- **Under 15 minutes** from `/kanon:adopt` to the Reviewer's first verdict on a stranger's repository, measured by timed run 2.

**How it gets there.** The rules and the feature definitions first, as data a guard holds to the lane list. Then `kanon init`'s flags and JSON, additive within `kanon-init/v1`, and the `kanon apps --reuse` fix the run tripped on. Then the skills: the questions, the summary, the runbook and the style guard. Then `/kanon:upgrade`'s mapping, and the timed run. Reviewing every pull request without a label, the one lane change, is optional and comes last, built only on demand.

## 1. What the first timed install showed

The run installed the review lane on a private repository, through `/kanon:adopt` at v0.38.0, and stopped at the Reviewer's first verdict on a test pull request. `kanon doctor` reported it healthy afterwards. Each row below is a stall the log records, with what this plan does about it.

| Stage | What happened | Stalled (min) | Here |
|---|---|---|---|
| Questions | Nine lane groups took three question rounds for a review-only install; the person picked *Implement, revise* alone, a lane that never runs without *Implement*, and needed a correction round | ~1 | §3, Q1: a feature, not lanes |
| Questions | "Author and Judge" was treated as an answer, but a review-only install needs only the Judge | 0 | §2: each feature names its Apps |
| Questions | The telemetry question was a wall of caveats and recommended *No*; upstream findings recommended *Drafted*, and evidence *Codes only*. The person chose the opposite each time, and asked for the three to be one | 0 | §3, Q4: one consent question |
| Questions | Nothing asked about the private material the Reviewer would read, and the adoption record said only "private repository" | 0 | §3, Q3, and the `## Data` section |
| Questions | The skill couldn't see whether the owner already had a Judge App (the token's 403 on the owner's installations), and the person answered *Reuse* unconfirmed | 0 | §4: the owner's other registers |
| Apps | Three steps and a *Do it now* question in one message; the person had to ask which command to run | ~1 | §5: one step at a time |
| Apps | The App's key: Kanon's docs said *Private keys → Generate a private key*, a section GitHub has replaced with **Credentials → Key pairs → New key** | ~4 | §5, R3, and step G0 (#624) |
| Apps | `kanon apps --reuse` refused a correct slug: it looks a private organisation App up by slug with the person's token, which GitHub answers 404 | stalled | fixed in #636 (#623); step G4 keeps the rest |
| Secrets | `! gh secret set` at the agent client's prompt has no terminal to prompt on, and silently stored an empty App ID | ~2 | §5: `--body` for a value that isn't secret, the person's own terminal for one that is (#625) |
| First review | Review is opt-in, `review:please`, which the skill never mentioned; the test pull request was skipped until the label was added | ~2 | §3, Q2, and R9 (#626) |

**The totals:** about 36 minutes of the adopter's own time, after a break and the Kanon operator's telemetry deploy are taken out; about 26 of them in steps only the person could take, 11 of those on questions.

## 2. The features

A feature is a fixed set of lanes, with the Apps, secrets and person steps that follow from them. It is data: a `features` key in [`docs/lanes.json`](../lanes.json), copied into `requirements.json` as the catalogue already is, so `kanon init`, `kanon init --help`, `docs/lanes.md` and the skills read one source (step G2). Each feature contains the one before it.

### 2.1 Review

| | |
|---|---|
| **Lanes** | `agent-review` |
| **Apps** | the Judge |
| **Secrets** | `JUDGE_APP_ID`, `JUDGE_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` |
| **Declarations** | the stack document's `## Gates`, the adoption record; the Reviewer's and the Explorer's playbooks are Kanon's baseline when absent (plan 0005 §5.2) |
| **Also written** | `.github/workflows/ci.yml` when the repository has none, as `init` already does; the review lane reads its runs |
| **Person steps** | the Judge App (create, or reuse with a key), the Claude token, merging the install pull request, the ruleset where the token can't create it, the `Lane check` rule after the merge |
| **Adoption record** | `Feature: review`, `Review trigger:`, `## Data`, `Overseer: not installed` |

### 2.2 Review + build

Adds the Implementer and the lanes that keep its pull requests moving, and the Author App.

| | |
|---|---|
| **Lanes** | Review's, plus `agent-implement`, `agent-implement-revise`, `agent-triage`, `agent-rebase`, `agent-dispatch-sweep` and `agent-merge-reconcile` |
| **Apps** | the Author and the Judge |
| **Secrets** | Review's, plus `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY`; the QA store's two only where the repository has a store hook (`K-OBS-17`) |
| **Declarations** | Review's, plus the Implementer's playbook (baseline when absent), and the sign-off delegation where the repository runs Kanon's DCO check |
| **Person steps** | Review's, plus the Author App; the delegation is the person's own act (`K-AGENT-44`), confirmed in the summary |

**The edge lanes, and why:**
- **`agent-triage` is in.** It runs as the Implementer with the same playbook, and it is one of the two lanes that open an Implementer pull request and start the implementer status chain (plan 0005 §3.3). A build feature without it leaves `qa:needs-triage` bugs to a person.
- **`agent-rebase` and `agent-dispatch-sweep` are in.** The catalogue recommends both with implement or triage: without the first, a conflicting agent pull request waits for a person, whose rebase takes it out of the Implementer's chain; without the second, a label whose event never arrived never starts its run.
- **`agent-merge-reconcile` is here, not in Review.** It runs as the Judge, but what it produces is follow-up issues for review suggestions a merge left out, which is the Implementer's input. On a review-only repository those issues wait for a person, and it costs a model run per merged reviewed pull request (Owner decision 9).
- **`agent-code-audit` is not.** It is the Explorer's lane, and files bugs on its own schedule; it belongs with the rest of the unattended pipeline.

### 2.3 Full pipeline

Adds the Lead and its project lanes, the Merger, the Explorer's code audit, the Overseer and the digests.

| | |
|---|---|
| **Lanes** | Review + build's, plus `agent-lead`, `agent-lead-revise`, `agent-lead-split`, `agent-lead-reconcile`, `agent-verify-acs`, `agent-merge`, `agent-overseer` and `agent-code-audit`; and, each only when its input exists (below), `agent-explore`, `agent-weekly-digest` and `agent-project-digest` |
| **Apps** | the Author and the Judge |
| **Secrets** | Review + build's, plus `DIGEST_WEBHOOK` for the digests, and the Overseer's optional `KANON_TELEMETRY_READER_ROLE` |
| **Declarations** | Build's, plus the Lead's and the Overseer's playbooks and the capability ledger (baselines when absent), project briefs under `docs/projects/` (`K-PROJ-1`), and the reference environment's three bullets where the repository has a deploy workflow (`K-LAYOUT-10`) |
| **Person steps** | Build's, plus the chat webhook when the digests are in |
| **Adoption record** | `Feature: full`, `Overseer: installed` |

**The edge lanes, and why:**
- **`agent-explore`, the sweep, only with a sweep hook.** It needs `.github/actions/explore-sweep/action.yml`, which the adopter writes ([`docs/explore-sweep.md`](../explore-sweep.md)); `init` can't write one. Inferred: in when the hook exists, otherwise left out, and the summary says so with the page to read.
- **The two digests only with a chat channel.** Both post to `DIGEST_WEBHOOK`. Inferred: in when the repository already holds the secret; otherwise the summary's *Chat channel* line says "none yet, digests left out", and editing it adds them and a runbook step for the webhook.
- **`agent-explore-telemetry` is left out at install.** It needs an aggregate invoker role that Kanon's operator issues after registration ([`docs/telemetry.md`](../telemetry.md)), so nothing an adopter does at install makes it work. Once the role exists, `kanon doctor` offers it (Owner decision 10).
- **`agent-lead-reconcile` and the reference environment.** It is what turns an approved brief into work, so it is in. Without a declared reference environment no project closes (`K-PROJ-11`); the summary shows the inferred deploy workflow, or "none" with that consequence.
- **`agent-merge` is in,** as the Owner decided, although the catalogue recommends it only after a person has merged the Implementer's approved pull requests by hand for a while. The summary says that, in one line, so the person can take it out.

### 2.4 Releases, an add-on

The Releaser App and its bypass (`K-MERGE-8`, plan 0005 §3.1), with `RELEASER_APP_ID` and `RELEASER_APP_PRIVATE_KEY` mapped by the release workflow's caller. It goes with any feature, and is not one of the four options: it is inferred, **on when the repository calls Kanon's release workflow** (`.inspection.callsRelease`), off otherwise, and shown in the summary either way. A repository that doesn't release yet keeps it off; `init` writes no release-please configuration (Owner decision 11).

### 2.5 Customise

The advanced last option. It keeps today's per-group lane questions from the catalogue, recommended options first, and then the same summary. Choosing it changes nothing else in the flow.

### 2.6 What the guard holds

`tests/unit/requirements.test.ts` holds the features to the lane list (step G2): every lane of `docs/lanes.json` is in Full, or is one of the conditional or left-out lanes above with its condition; each feature contains the one before it; a feature's Apps are exactly the union of its lanes' identities; and a lane that **depends** on a base lane is in no feature without it. The dependencies are five, each a lane that acts only on what its base lane made: `agent-implement-revise` on `agent-implement`; `agent-lead-revise`, `agent-lead-split` and `agent-lead-reconcile` on `agent-lead`; and `agent-verify-acs` on `agent-lead-reconcile`. G2 records them in a new `requires` field of `docs/lanes.json`, read by the guard. **The catalogue's `recommend` is not a dependency:** its `$comment` defines it as the lanes whose choice makes a lane recommended, a trigger. So `agent-triage`, recommended with the explore and code-audit lanes, is in Review + build without them, since it also triages the bugs people file (§2.2); the Overseer, recommended with the Implementer and the Lead, is in Full only; and the rebase and dispatch sweeps and the project digest are placed by §2's reasons, not by their `recommend`. **Mutations:** a new lane added to the catalogue and to no feature, `agent-implement-revise` in Review, `agent-verify-acs` in a feature without `agent-lead-reconcile`, or `author` missing from Build's Apps, each turns it red; a guard that read `recommend` as a dependency would fail Review + build on `agent-triage`, which the guard's own fixture pins.

## 3. The questions

Asked once, together: in Claude Code as **one** `AskUserQuestion` call holding the questions, at most four, which its tool allows (three until G7 ships: Q2 waits for it); in another client, as one numbered message. The words below are the words asked. Each option is a label and a one-line consequence, the recommended one first.

**Q1. "What should Kanon do in this repo?"**

| Option | Consequence |
|---|---|
| **Review (Recommended)** | An AI reviewer approves or requests changes on pull requests, with one GitHub App. |
| **Review + build** | Also writes code from issues you label and revises it, with a second App. |
| **Full pipeline** | Also plans projects, merges approved work and audits the pipeline, with the same two Apps. |
| **Customise** | Choose lane by lane (advanced). |

Recommended: the feature that equals the lanes the repository already calls, when it does; otherwise Review.

**Q2. "Which pull requests should the Reviewer review?"** Asked when the feature includes the review lane: always, except for a Customise without it, which drops the answer.

| Option | Consequence |
|---|---|
| **Only labelled ones (Recommended)** | Only pull requests you label `review:please` get a verdict. |
| **Every pull request** | Each member's pull request gets a verdict when its CI finishes, one model run per pushed head. |

The agents' own pull requests carry their labels, so they are reviewed either way. **Every pull request is optional and not built yet** (step G7, on demand): today the review lane reviews only a labelled pull request. **Until G7 ships, Q2 is not asked,** since one option is no decision: the trigger is `labelled`, a line of the summary like any default, and the first call holds three questions. Once G7 ships, Q2 is asked as above, labelled first.

**How to ask for a review** is said in the summary, in the runbook's last step and in the skill's closing message, in these words: "To get a review, add the label `review:please` to the pull request; the Reviewer posts its verdict once CI has finished. After a verdict, push a new commit, or remove and add the label again, to ask for another look."


**Q3. "Does this repo hold private or sensitive material?"** The answer goes in the adoption record's `## Data` section.

| Option | Consequence |
|---|---|
| **Yes** | The record says so; the lanes still read the files and diffs they need. |
| **No** | The record says it holds none. |

Recommended, and listed first: **Yes** on a private repository, **No** on a public one.

**Q4. "Help improve Kanon by sharing anonymous run data and the Kanon bugs your lanes find? Evidence text may rarely hold personal data; details: `<link>`."** The link is a new page, `docs/sharing.md` at the pinned release (step G1), which holds the rest of what today's three questions carry: the fields, Frankfurt and 13 months, the scrub, TypeSafe and Jev, that the text is never published, how to stop and erase.

**The disclosure stays in the question itself** (Owner decision 15). Two sentences of the record require the consent to say it, not a link: [ADR 0007](../decisions/0007-data-boundary.md)'s "the question for the second level says plainly that the text is read by Kanon's maintainer and by a third-party decision provider", and `K-OBS-16`'s "it may rarely still contain personal data, which the opt-in says". Q4's second sentence says the second, and *Yes*'s consequence the first, each within its budget (§9). So ADR 0007's sentence, `K-OBS-16` and plan 0006 decision 14's disclosure hold unamended; what this plan replaces of decision 14 is its shape, two questions with *Drafted* and *Codes only* recommended, by Owner decision 2, as it replaces #428's rule (§8).

| Option | Consequence | Becomes |
|---|---|---|
| **Yes (Recommended)** | Run data, and scrubbed bug evidence read by Kanon's maintainer and a third-party decision provider. | telemetry on, `Upstream findings: sent with evidence` |
| **Codes only** | Run data, and Kanon bugs as codes with no text. | telemetry on, `Upstream findings: sent` |
| **No** | Nothing leaves this repo; Kanon bugs stay drafts here. | no telemetry, `Upstream findings: drafted` |

**Yes is `sent with evidence` whatever the feature.** Review and Review + build run no lane that finds upstream findings (only the Overseer and the telemetry Explorer do), so nothing more leaves the repository for it. The record holds what the person consented to, not what today's lanes produce, so a later move to Full needs no second question, and *Codes only* stays a level of its own (Owner decision 7).

**Q5, the confirmation: "Install Kanon with these settings?"** asked after the summary (§4).

| Option | Consequence |
|---|---|
| **Install (Recommended)** | Writes the files on a branch and opens the pull request. |
| **Change something** | Pick a line of the summary to change. |
| **Stop** | Nothing is written. |

**Change something** asks one multi-select question of the summary's groups (People; Lanes and Apps; Gates, database and delegation; Labels, plugin and pin), then each chosen line's own question, in today's shape, then shows the summary again. **Customise** inserts the per-group lane questions between Q4 and the summary.

**Recommended is not a default.** Under `kanon init --yes`, with no flag, sharing is **No** and the review trigger **labelled**: an explicit answer is needed to send anything (`K-OBS-18`), and a record without the new bullets reads as today's behaviour (plan 0005 §5.2). The skill always asks, so it never takes those defaults.

## 4. The summary

One message, after the dry run with every flag, and before anything is written. Each line is a value and where it came from: **asked**, **inferred** (with what it was inferred from) or **default**. Its shape, for a review install:

```text
Kanon v<release> for <owner>/<repo> (private, organisation; rulesets: yes)

Feature        Review: agent-review                                 asked
Review         labelled: add `review:please` to a PR to get a verdict  default
Data           holds private material (## Data)                     asked
Sharing        yes: telemetry on, findings sent with evidence       asked
Apps           Judge: reuse <slug>, from <other repo>'s register    inferred
Releases       off: no release workflow                             inferred
People         Owner, Maintainer, Stakeholder: <login>              inferred from CODEOWNERS
Gates          npm run lint; npm test                               inferred from package.json
Test database  none: no database service or DATABASE_URL            inferred
Delegation     none: no Author lane                                 inferred
Labels         create Kanon's taxonomy; keep GitHub's defaults      default
Milestones     the bucket milestones                                default
Ruleset        create on <branch>; Lane check after the merge       inferred: the token administers it
Merging        squash only                                          default
Plugin         declared in .claude/settings.json at v<release>      default
Pin            v<release>, the plugin's release (latest: v<latest>) inferred
CI             keep .github/workflows/ci.yml                        inferred
Dependabot     add the Kanon entry                                  default
id-token jobs  <workflow>/<job>: accept, it is <reason>             inferred (#631)
Files          <n> new, <n> kept, <n> differ (shown below)
Your steps     1 key for the Judge, the Claude token, merge the PR, 1 test PR
```

**Every current answer, and how it is now obtained:**

| `.answers.*` | Today | After this plan | From |
|---|---|---|---|
| `projectOwner` | asked | inferred | the single user owner of `*` in `CODEOWNERS`, else the token's login |
| `maintainer` | asked | inferred | the Owner |
| `stakeholder` | asked | inferred | the Owner |
| `lanes` | asked, per group | from Q1 | the feature's lanes and the conditions of §2; Customise asks per group as today |
| `gates` | asked | inferred | `init`'s suggestions from `package.json`, a `Makefile`, Cargo or Go, or "none yet" |
| `testDatabase` | asked | inferred | a database service in a compose file, `DATABASE_URL` in an example environment file, or a migrations directory |
| `delegation` | asked, then the name and the email | inferred | yes when a chosen lane runs as the Author and the repository runs Kanon's DCO check, with `git config user.name` and `user.email`; otherwise none |
| `deleteDefaultLabels` | asked | default | delete when the repository has no commit, else keep |
| `releaser` | asked when the repository calls the release workflow | inferred | §2.4 |
| `reuseApps` | asked | inferred | reuse each App `.inspection.ownerApps` names, which now also reads the App registers of the owner's other repositories the token can read (step G4) |
| `plugin` | asked | default | yes |
| `telemetry` | asked | from Q4 | yes for *Yes* and *Codes only* |
| `upstreamFindings` | asked | from Q4 | §3; `filed here` only through **Change something**, for a repository that maintains Kanon or a fork |
| `upstreamEvidence` | asked after `sent` | from Q4 | true for *Yes* |
| `feature` (new) | | asked, Q1 | |
| `reviewTrigger` (new) | | asked, Q2, once G7 ships | until then the default, `labelled` |
| `sensitiveData` (new) | | asked, Q3 | |
| `consent` (new) | | asked, Q4 | |

**Nothing is silent:** a value no question asks is still a line of the summary, and every line can be changed before anything is written. The pull request's body repeats the summary, so the reviewer of the install sees it too.

## 5. The runbook

The steps only a person can take, handed over one at a time. Each is **a direct link, one action, then "Done?"**, with *Done* and *Skip for now* as the options, and the next step only after the answer. The skill checks each step where it can before going on. A command appears only once its inputs exist, with the real values in it: the release, the owner, the repository, the slug, the App ID, the key file's name. Commands the person runs in the agent client start with `!`; a command that takes a secret's value never does.

**Secrets, the one rule** ([#625](https://github.com/yedeya-labs/kanon/issues/625)): never `gh secret set` without `--body` or a file. A value that isn't secret, such as a variable's, is set by the skill itself with `--body`; an App's ID is stored by `kanon apps` itself. A real secret is typed or pasted by the person **in their own terminal**, where `gh` can prompt for it, or read from a file the person made; an `!` command has no terminal to prompt on, and stores an empty value without a word, as the first run found.

For a review install whose owner already has a Judge App, in order:

| Step | The link | The one action | Checked by |
|---|---|---|---|
| **R1. Add the repository to the App** | the Judge's installation, `https://github.com/apps/<slug>/installations/new`, which opens its settings for `<owner>` | Under **Repository access**, add `<repo>`, then **Save**. | `kanon apps --preflight` sees the installation cover `<repo>` |
| **R2. Copy the App ID** | the Judge's settings page, `…/settings/apps/<slug>` | Paste the **App ID** (or the Client ID) shown under **About**. Skipped when `init` already filled it in (#640). | none: R4 uses it, and `kanon apps` stores `JUDGE_APP_ID` from GitHub's answer |
| **R3. Make a key** | the same page | In the left sidebar, **Credentials → Key pairs → New key**. Never a client secret. Your browser downloads `<slug>.<date>.private-key.pem`. ([GitHub's page](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)) | the skill lists the downloads folder by file name only, never opening the file |
| **R4. Store the key** | none | Run, as printed with the real file name: `! cd <root> && npx --yes --package github:yedeya-labs/kanon#v<release> kanon apps --owner <owner> --repo <repo> --reuse judge:<slug>@<App ID>=<path to the .pem>`, the form #636 shipped. It stores both secrets and deletes the file. | `gh secret list` shows `JUDGE_APP_ID` and `JUDGE_APP_PRIVATE_KEY` |
| **R5. Make the Claude token** | none | In **your own terminal**, run `claude setup-token`, and keep the token it prints. | none: the next step stores it |
| **R6. Store the Claude token** | none | In the same terminal, run `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/<repo>`, and paste the token when it asks. | `gh secret list` shows it |
| **R7. Merge the install** | the pull request | Review it, then **Squash and merge**. In bootstrap, a person merges it (`K-ADOPT-4`). | `gh pr view` says `MERGED` |
| **R8. The required check** | none | Run, as printed: `kanon init` with a token that can administer the repository, which adds only the `Lane check` rule. Skipped when the skill's own token can, which then adds it. | `kanon doctor` reports no `ruleset.check-unreported` |
| **R9. The first review** ([#626](https://github.com/yedeya-labs/kanon/issues/626)) | the test pull request the skill opened: a one-line change outside `docs/qa/` and every judging input | Add the label `review:please` to it. That is how every review is asked for: the Reviewer posts its verdict once CI has finished, and a new commit, or the label removed and added again, asks for another look. The skill watches for the verdict. | the Reviewer's review exists, from the Judge |

**When the owner has no App,** R1 to R4 are one step: run the printed `kanon apps --owner <owner> --repo <repo> --apps judge` (or `author,judge`), and on the two pages it opens, click **Create GitHub App**, then **Install** on `<repo>` only. Checked by the register rows it writes and `gh secret list`.

**Review + build** repeats R1 to R4 for the Author. **Full** adds, when the digests are in, the webhook: in your own terminal, `gh secret set DIGEST_WEBHOOK -R <owner>/<repo>`. **The ruleset**, where the token couldn't create it, is one step before R7: run the printed `kanon init` with an administering token. **Sharing** (*Yes* or *Codes only*) adds one step after R9, outside the clock: submit the registration issue the link opens, prefilled; the collector skips, green, until the operator's two variables arrive. **A skipped step** goes under `## Left to do` in the pull request, by its finding's id, as today.

## 6. `kanon init`'s flags and JSON

All additive within `kanon-init/v1` (`docs/init.md`, "Its shape is a contract"): new flags, answer fields, top-level fields and a finding id; nothing removed, renamed or retyped. Every old flag keeps working.

| Flag | Answers | Default under `--yes` | Refused (exit 2) with |
|---|---|---|---|
| `--feature review\|build\|full` | Q1; sets the lanes per §2 | `review`, or the feature the repository's lanes already equal | `--lanes`, which is Customise |
| `--releases`, `--no-releases` | §2.4; the same answer as `--releaser`, `--no-releaser`, which stay | inferred, §2.4 | each other, and the old pair contradicting them |
| `--review-trigger every-pr\|labelled` | Q2 | `labelled` | a lane set without the review lane; and `every-pr` until step G7 ships |
| `--sensitive-data`, `--no-sensitive-data` | Q3 | none: the `## Data` section says "not declared", and `init` notes it | each other |
| `--consent yes\|codes\|no` | Q4; sets `telemetry`, `upstreamFindings` and `upstreamEvidence` per §3 | `no` | `--telemetry`, `--no-telemetry` or `--upstream-findings` |

**The JSON gains:**
- **`answers.feature`** (`review`, `build`, `full` or `custom`), **`answers.reviewTrigger`** (`every-pr`, `labelled`, or null without the review lane), **`answers.sensitiveData`** (boolean or null), **`answers.consent`** (`yes`, `codes`, `no`, or null when the older flags set a combination no level names, such as telemetry with `drafted`).
- **`features`**, top level: each feature's `feature`, `title`, `lanes`, `conditional` (each lane and its condition), `apps`, `secrets` and `steps`, from `requirements.json`, so the skill builds Q1 and the runbook from it.
- **`summary`**, top level: one element per line of §4, `answer`, `value`, `source` (`flag`, `inferred` or `default`) and `reason`. `init` can't know whether a person or a script gave a flag; the skill shows `flag` as *asked*.
- **`inspection.ownerApps[].from`**: `installation`, or `register:<owner>/<repo>`, the register it was read from (step G4).
- **`inspection.codeowners`**: the user owners of `*` in `CODEOWNERS`, or null.
- **`apps.reuse[].appId`**: the App ID, when known ([#640](https://github.com/yedeya-labs/kanon/issues/640)).

**The adoption record gains,** under `## Choices`, ``- **Feature:** `review` `` and ``- **Review trigger:** `every pull request` `` (or `` `labelled` ``), and a `## Data` section (step G1, `K-LAYOUT-10`). Without the bullets the record means `custom` and `labelled`, today's behaviour.

## 7. `/kanon:upgrade`

An install made before this plan has lanes, not a feature. The upgrade skill maps it:
- **The feature** is the largest feature whose lanes, conditional ones aside, the repository all calls. Lanes beyond it make it `custom`, shown as "Review + build, plus `agent-code-audit`". `init` never uninstalls a lane, so nothing is lost by the mapping. The summary shows it as inferred, and the record gets its `Feature:` bullet.
- **When a target release adds a lane to the record's feature,** the upgrade's summary lists it as an inferred addition, which the person confirms or takes out. A `custom` record gets none.
- **Sharing** maps back without asking: telemetry with `sent with evidence` is *Yes*, with `sent` *Codes only*, no telemetry with `drafted` *No*. Any other combination is kept, shown as "sharing: custom", and changeable.
- **The review trigger,** absent, is `labelled`, shown as inferred and changeable.
- **Data,** absent, is the one question asked: Q3, once.

Step 5 of the upgrade skill, "New questions", asks only answers the adopt skill marks *asked* that the record lacks; every other new answer is a line of the upgrade's summary. This also answers #601, where a new answer whose only effect is a record bullet was dropped.

## 8. #428's decision, and what replaces it

**#428 (2026-10-06, closed)** decided that the adopt skill asks every choice as a multiple-choice question, recommended option first, with its consequence; never a comma-separated list; and no silent defaults. `tests/unit/skills.test.ts` holds every answer of `kanon init`'s contract to a question block of its own in the adopt skill, and its steps say "none is taken from its default unasked".

**What this plan keeps:** multiple choice, the recommended option first, a consequence per option, never a list to type, and **nothing silent**. **What it replaces:** *asked* becomes *asked, inferred or defaulted, and shown*. An inferred value the person sees in the summary and can change is not a silent default; a question the person can't answer quickly is friction, as eleven minutes of the first run showed. Plan 0005 §5.4 had said the same before #428: "asks only what it can't infer, each question with a default". Plan 0005 records the amendment in its header.

## 9. Question style, for every skill

These are acceptance criteria for every question a person skill asks (adopt, upgrade, doctor), and step G6 holds them with a guard:

1. **One decision per question.**
2. **The question is at most two short sentences,** at most 160 characters, a link not counted.
3. **Each option is a short label,** at most four words, **and a one-line consequence,** one sentence of at most 100 characters.
4. **Two to four options, the recommended one first,** its label ending `(Recommended)`.
5. **Caveats go behind a link,** never in the question or an option, except a disclosure a rule requires the question itself to make, written within the budgets above: Q4's (Owner decision 15).
6. **Never recommend against what Kanon needs to work and to improve:** the review lane, opting in to sharing. Recommended is not a default: the person still answers.

**The guard:** each question a skill asks is written in one fixed shape, a heading with the answer it sets, the question as a quoted line, and the options as a table of label and consequence, so `tests/unit/skills.test.ts` can read them. It fails a question over the sentence or character budget, an option label over four words or a consequence over its budget, fewer than two or more than four options, a first option not marked `(Recommended)`, a paragraph between the question and its options, and a consent question whose first option isn't *Yes*.

**The guard that ties answers to questions changes too.** Today it requires one question block per documented answer. After G6, the adopt skill holds a table under `## The answers`, one row per field of `docs/init.md`'s answers table, each marked *asked*, *inferred* or *defaulted*, with its source. The test fails when the rows and the documented answers differ; when an *asked* row has no question block in the fixed shape; when an *inferred* or *defaulted* row has no line in `## The summary`; and when the steps don't say that the summary is shown before anything is written and confirmed in one question. `UPSTREAM_EVIDENCE_QUESTION` is retired with the evidence question, and `CONSENT_QUESTION`, exported from `cli/init.mjs`, is the text both `init`'s terminal prompt and the skill ask, word for word. The tests that pin the evidence question's disclosure (`skills.test.ts`'s evidence-question test, and `kanon-init.test.ts`'s decision-14 test) move to Q4: `CONSENT_QUESTION` must contain "may rarely hold personal data", and *Yes*'s consequence "scrubbed bug evidence read by Kanon's maintainer and a third-party decision provider", so the readers it names are the evidence's, never the run data's, which only Kanon's store holds (ADR 0007). **Mutation:** dropping either phrase, or moving the readers onto the run data, turns them red.

## 10. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **G0** | Kanon, docs and CLI text, [#624](https://github.com/yedeya-labs/kanon/issues/624) | **The key page, now.** `docs/apps.md`, the adopt skill and `kanon apps`'s printed key-rotation steps say **Credentials → Key pairs → New key**, link GitHub's page, and warn against a client secret. Independent of the rest, and first. | `grep -rn "Generate a private key" docs skills cli` prints nothing. **Mutation:** restoring the old words in `cli/apps.mjs` fails `kanon-apps.test.ts`, which pins the printed steps. |
| **G1** | Kanon, docs | **The rules.** `K-LAYOUT-10` gains the `Feature:` and `Review trigger:` bullets and the `## Data` section; ADR 0007's "asked during install as their own questions" becomes "asked during install, in one consent question that sets both levels"; `K-OBS-18`'s Enforced by names the question; `docs/sharing.md` holds the caveats the three questions carry today beyond Q4's own disclosure. ADR 0007's "says plainly" sentence, `K-OBS-16` and plan 0006 decision 14 are not amended: Q4 says what they require (Owner decision 15). | `adoption-record.test.ts` parses each new bullet and section, and fails a record with the bullet twice or another value. **Mutation:** a `Review trigger:` of `sometimes` is malformed by line. A test reads `docs/sharing.md` for each caveat the evidence question states today: the scrub, the third-party decision provider, Frankfurt, 13 months, erasure. |
| **G2** | Kanon | **The features, as data** (§2). `features` in `docs/lanes.json`, copied into `requirements.json`; `docs/lanes.md` gains a features table built from it. | §2.6's guard. `lanes-doc.test.ts` fails a table that differs from the data. |
| **G4** | Kanon vN | **Apps found in the owner's other registers.** **Its CLI half shipped in #636** (closing [#623](https://github.com/yedeya-labs/kanon/issues/623)), in the form `--reuse <app>:<slug>@<App ID or Client ID>=<key file>`: the command signs its first JWT with the ID the person gives, reads the App from `GET /app`, and never looks the slug up with the person's token; the old slug-only form exits 2, naming the new one. This plan keeps that form and plans no other change to `--reuse`. **What is still open:** `init`'s `inspection.ownerApps` also reads `docs/qa/agent-identities.md` in the owner's other repositories the token can read, and records where it found each App; and, for an App found among the owner's installations, `init` fills its App ID into the `app.reuse` command ([#640](https://github.com/yedeya-labs/kanon/issues/640)). | `kanon-init.test.ts`: with installations unreadable and a sibling register naming the Judge, `ownerApps` names it, `from: register:<owner>/<repo>`, and the `app.reuse` fix names its slug; with an installation that carries `app_id`, the fix's command holds that ID in place of `<App ID>` (#640). **Mutation:** an `ownerApps` built without the register read leaves the sibling's Judge out, turning the first test red. |
| **G5** | Kanon vN | **`kanon init`'s flags and JSON** (§6), including the terminal prompt's four questions and its summary. | `kanon-init.test.ts`: `--feature review` writes exactly `agent-review`'s caller; `--consent yes` writes the collector and `sent with evidence`; `--consent no` neither; `--consent` with `--telemetry`, and `--feature` with `--lanes`, exit 2; `--yes` alone sends nothing; every `summary` line names a source. **Mutation:** a `--yes` default of `yes` for consent fails the test that `--yes` alone writes no collector. |
| **G6** | Kanon vN+1 | **The skills.** The adopt skill's questions (§3), summary (§4) and runbook (§5); the style guard and the answers table (§9); the upgrade skill's mapping (§7). | §9's guard. `skills.test.ts`: the first questions are asked in one call, Q2 only from the release that ships G7; every runbook step names a link or a command and one action; no `gh secret set` in any skill lacks `--body` or a file, except in a step that says *your own terminal*. **Mutations:** a fifth question in the first call, a 200-character question, an option without a consequence, a consent question recommending *No*, a `! gh secret set` without `--body`: each fails it. |
| **T2** | the Owner, a stranger's repository | **Timed run 2,** on the release that completes G6 (below). | The record holds the timestamps, a row per stage and the friction log. The target holds if the adopter's time is under 15 minutes; if not, the record names the stage that dominated, and a follow-up is filed against it. |
| **G7** | Kanon, a lane change, **optional and on demand** | **Every pull request, without a label.** Built only when the Owner or an adopter asks for it; the recommended path, and timed run 2, don't need it. The review lane's filter reads `Review trigger:` from the default branch's record; on `every pull request` it admits a finished CI run on an open pull request from the same repository whose author is a member (`K-AGENT-45`), as if requested by that author. A fork's head, and a pull request whose author isn't a member, such as a dependency bot's, are still refused without a label. | `kanon-init.test.ts` and `skills.test.ts`: `init` takes `--review-trigger every-pr`, and the skill asks Q2, only from the release that ships it. `review-filter.test.ts`: with the bullet, a member's unlabelled pull request is reviewed; without it, skipped, as today. **Mutations:** a fork's head, and a non-member's pull request, with the bullet and no label, are refused; a `labelled` record still skips an unlabelled pull request. |

**Why this order:**
- **G0 first:** it cost the first run four minutes, and is words.
- **Rules and data before code** (G1, G2): `init` and the skills read the features and the record's bullets, and the guards must agree with them first.
- **The every-PR trigger last, and only on demand** (G7): the recommended trigger is today's label, so nothing on the path to the first verdict waits for a lane change. Until it ships, `init` refuses `--review-trigger every-pr`, so it never writes a bullet the pinned lane doesn't read.
- **The skills last** (G6): they drive `init`'s JSON only (ADR 0014), so they wait for its fields.

## 11. The target, and how it is measured

**The target:** under **15 minutes** of the adopter's time, from typing `/kanon:adopt` to the Reviewer's first verdict on a test pull request, for the Review feature with the recommended labelled trigger, on a stranger's repository. Adding `review:please` to the test pull request is a runbook step, and on the clock.

**Timed run 2:**
- **The repository:** an existing repository with its own history and CI, on an account where Kanon has no App yet, so creating the Judge is on the clock. Not a repository made for the run.
- **The clock** starts when `/kanon:adopt` is typed, with the plugin already installed (its install is timed and reported apart), and stops at the verdict's `submitted_at`. A break the person takes is recorded and taken out, as in run 1, and so is the Kanon operator's telemetry registration, which is not the adopter's step.
- **The record:** a row per stage, with the same columns as run 1's friction log (stage, what happened, minutes stalled, whether the person left the flow, the suggested fix), and the time of each runbook step.
- **The budget it is held to:** the questions and the summary in 2 minutes; the App and its key in 4; the Claude token in 2; the install pull request merged in 2; CI and the first review in 5, the repository's own CI time reported beside it.

## 12. Cost

**AWS: none.** No step adds a resource.

**Actions minutes:** unchanged on the recommended path, which keeps today's label. The every-PR trigger, if G7 is built, adds a Reviewer run per pushed head of a member's pull request that wasn't labelled before, on `CLAUDE_CODE_OAUTH_TOKEN`, so quota rather than a bill, and a short filter job on every CI run, as today. The question says so in its consequence.

**The Owner's time:** timed run 2.

## Out of scope

Each is in the first run's log, and is filed or tracked on its own:
- **`GH_TOKEN` across the agent client's shell calls,** and which token the session uses: [#630](https://github.com/yedeya-labs/kanon/issues/630). Plan 0005 §5.1 names the token; persisting it is the person's client's.
- **`disable-model-invocation`** on the adopt skill stays: the person types `/kanon:adopt`, which is the right person starting it. The docs say so ([#626](https://github.com/yedeya-labs/kanon/issues/626)).
- **The telemetry register's handling** on the operator's side ([#629](https://github.com/yedeya-labs/kanon/issues/629)), and what its render step prints ([#628](https://github.com/yedeya-labs/kanon/issues/628)). Operator work, not the adopter's install.
- **A review run cancelled by the Reviewer's own label event,** right after it posted its verdict. A lane bug, [#627](https://github.com/yedeya-labs/kanon/issues/627); the verdict stands, and the run's row is wrong.
- **The person's token reading check runs** (`gh pr checks`). A docs fix to the token's permissions, [#630](https://github.com/yedeya-labs/kanon/issues/630).
- **A stable release channel** to pin to (#575). The pin stays the plugin's release, shown beside the latest.
- **The webapp** of ADR 0014's audience 2, and **fleets** of repositories, which need more than one summary.
- **Writing release-please's configuration** for a repository that doesn't release yet (§2.4).

## Owner decisions (2026-10-10)

Taken by the Owner from the first timed install, before this plan was drafted, and not reopened:

1. **Features, not lanes.** The first question is "What should Kanon do in this repo?": **Review** (the Reviewer, the Judge App only); **Review + build** (adds the Implementer and its family, and the Author App); **Full pipeline** (adds the Lead, the Merger, the Explorer, the Overseer, the digests and the rest); **Releases**, a separate add-on (the Releaser); and **Customise**, the advanced last option, keeping per-lane choice. §2 defines each.
2. **One consent question** replaces the telemetry, upstream-findings and evidence questions: "Help improve Kanon by sharing anonymous run data and the Kanon bugs your lanes find?" **Yes (recommended)** is telemetry and `sent with evidence`; **Codes only** is telemetry and `sent`; **No** is no telemetry and `drafted`. The caveats go on a linked page, not in the question.
3. **Infer, then confirm once,** replacing #428's "ask every input". Asked: the feature; the review trigger, every pull request or labelled `review:please` only, when Review is included; the consent question; and "Does this repo hold private or sensitive material?", recorded in a `## Data` section of the adoption record. Everything else is inferred or defaulted and shown in one summary the person confirms or edits. Nothing is silent.
4. **The person-step runbook:** one step at a time, a direct link and one action, then "done?", then the next. Commands appear only once their inputs exist, with real values filled in. App keys are made at **Credentials → Key pairs → New key**. Never `gh secret set` without `--body` or a file; a real secret goes through the person's own terminal.
5. **Question style rules for every skill:** one decision per question; at most two short sentences; each option a short label and a one-line consequence, the recommended first; caveats behind a link; never recommend against what Kanon wants, such as opting in.

### Decided by the Owner on the plan (2026-10-10)

Nine decisions taken by the Owner on the plan's pull request: its eight open points, and decision 8, which came from §3's text rather than the open list. Decision 15 followed the plan's review. Status: **decided**.

6. **The review trigger: labelled only, `review:please`, recommended, as today.** Changed from the plan's proposal of every pull request. Q2's first option is **Only labelled ones (Recommended)**, and **Every pull request** comes second. The every-PR lane change stays in the plan as step G7, optional and built on demand, after the install steps; until it ships Q2 is not asked, and the trigger is the summary's `labelled` line. The summary, the runbook's last step and the skill's closing message say plainly how to ask for a review (§3).
7. **Consent *Yes* means `sent with evidence` whatever the feature** (§3). Accepted as proposed: the record holds the consent, nothing more leaves a repository without the Overseer or the telemetry Explorer, and a move to Full asks nothing again.
8. **`kanon init --yes` defaults sharing to *No*.** Accepted: consent is never implied, and only an explicit answer sends anything (`K-OBS-18`).
9. **`agent-merge-reconcile` is in Review + build, not Review** (§2.2). Accepted as proposed.
10. **Full's conditional lanes** (§2.3): the sweep only with its hook, the digests only with a webhook, the telemetry Explorer left to doctor once the operator issues its role. Accepted as proposed.
11. **Releases is inferred, never asked,** and `init` writes no release-please configuration (§2.4). Accepted as proposed.
12. **The Data question's recommended answer** follows the repository's visibility, and a *Yes* changes no default (§3). Accepted as proposed.
13. **The style budget:** 160 characters per question, four words per label, 100 characters per consequence (§9). Accepted as proposed; G6 measures every current question against them first.
14. **The consent page is `docs/sharing.md`.** Accepted as proposed.
15. **The disclosure stays in Q4 itself** (§3), from the plan's review. *Yes*'s consequence says the evidence is scrubbed and read by Kanon's maintainer and a third-party decision provider, and Q4's second sentence that the evidence text may rarely hold personal data, each within §9's budget. So ADR 0007, `K-OBS-16` and plan 0006 decision 14's disclosure stay unamended, and G1 amends only what it lists. Decision 2's "the caveats go on a linked page" holds for every other caveat.
