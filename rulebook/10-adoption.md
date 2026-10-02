# 10 Adoption

This chapter governs how a project becomes a Kanon project: what an adopter sets up, in what order, on which kind of GitHub account and plan, with which credentials, and what the repository is allowed to do before its agents exist. The rest of the rulebook describes a running project. An empty repository can't meet those rules on its first day: there is no base branch for a first pull request, no Reviewer to approve one, and no guard to fail. Kanon's answer is to name that state (**bootstrap**), say exactly what it permits, record every use of it, and give it an exit that can't be reversed ([ADR 0008](../docs/decisions/0008-installation-test-decisions.md)). A silent exception is what Kanon forbids. A named, recorded, finite one is a rule.

Every path this chapter mentions is fixed in [11 Repository layout](11-repository-layout.md).

## Installation

### `K-ADOPT-1` Install in the fixed order

**Rule.** Adopt Kanon by working through these steps in order, recording each in the adoption record (`K-LAYOUT-10`) as it is done:

1. **Account.** Create the repository in a GitHub organisation (`K-ADOPT-2`). Record the plan, and which of Kanon's fallbacks it forces (`K-ADOPT-3`).
2. **People.** Name the Owner, the Maintainer and the Stakeholder in the adoption record. One person may hold all three (chapter 03).
3. **Installer credential.** Give the installer a credential with exactly the permissions in `K-ADOPT-7`.
4. **First commit, straight to the main branch** (allowed by `K-ADOPT-4`). It lays down the fixed layout of chapter 11:
   - the agent instruction files (`K-LAYOUT-9`);
   - the adoption record;
   - `docs/projects/_template.md`, copied unchanged from Kanon's [`templates/brief.md`](templates/brief.md);
   - the spec directory with an empty registry and an empty locked set (`K-LAYOUT-2` to `K-LAYOUT-4`);
   - the observability document with its anchors and an empty paged table, not-paged table and hand-created-resource table (`K-LAYOUT-5`);
   - the App register, the capability ledger and the escalation file (`K-LAYOUT-6` to `K-LAYOUT-8`). The escalation file must be filled in before the first brief is written, because a brief's blast-radius section cites it (`K-PROJ-6`);
   - a `.gitignore` covering runner environment files and test artifacts (`K-WS-4`).
5. **Repository settings.** Squash merge only, with the PR title as the subject and the PR body as the message (`K-SHIP-3`). This is a repository setting available on every plan, separate from the ruleset in step 8: apply it even where the plan offers no rulesets. A merge commit on the main branch can't be parsed by the release tool.
6. **Labels.** Create the whole taxonomy with its colours and descriptions, and delete GitHub's default labels that aren't in it (`K-WORK-12`).
7. **Milestones.** Create the two buckets, *Product Backlog* and *Development Automation*, with no due date (`K-WORK-4`). Adoption needs no roadmap milestone and no launch gate. Creating one is the Stakeholder's decision, made when they choose (`K-WORK-5`, `K-WORK-6`).
8. **Rules on the main branch.** A ruleset that requires a pull request, blocks force-pushes and deletion, and allows squash only. Turn on the merge queue where the plan provides it, and otherwise apply the fallback (`K-MERGE-7`). Leave the required approving review **off** until bootstrap ends (`K-ADOPT-6`).
9. **Production approval.** A required reviewer on the production environment where the plan provides it, otherwise the fallback (`K-SHIP-9`).
10. **Chat channel.** Which service carries announcements, digests and cost alerts, and how it is wired, is the project's decision. Record it, or record "none yet".
11. **The first tracking issue.** File it with its mandate as the body (`K-PROJ-15`), its kind label and a bucket milestone, in one call (`K-WORK-2`, `K-WORK-23`).
12. **Agent identities.** The Owner creates one GitHub App per role, with the permissions in `K-ADOPT-8`, stores the keys as Actions secrets (`K-AGENT-6`), and lists every App in the App register (`K-AGENT-3`). [`kanon apps`](../docs/apps.md) does this from App manifests, and the Owner clicks **Create** and **Install** for each App.
13. **Kanon's code, as it becomes available.** Install each guard, lane and store, pinned to an exact Kanon version with Dependabot proposing upgrades (`K-ADOPT-11`), and mark it installed in the adoption record's mechanism list (`K-ADOPT-9`).
14. **End bootstrap** (`K-ADOPT-6`): the Reviewer's App is installed and the required approving review is switched on. Record the date. Then drop the installer credential's Administration permission.

**Why.** Without a checklist, an installer has to derive the setup from every rule's "Enforced by" line, which describes a mechanism rather than a step. The order matters. The layout has to exist before anything cites it. The escalation file has to exist before a brief names what it touches. And the required review can't be switched on before there is a Reviewer to give one.

**Enforced by.** Prose only. The installer that runs these steps is planned; its first piece, [`kanon apps`](../docs/apps.md), runs step 12.

**Class.** framework

## The account and the plan

### `K-ADOPT-2` An adopter's repositories live in a GitHub organisation

**Rule.** Put every repository that adopts Kanon in a GitHub organisation, never in a personal account. A repository may stay private while it is prepared, and goes public at its own gate, one repository at a time.

**Why.** On a personal account the merge queue doesn't exist, and rulesets on a private repository need a paid personal plan. An organisation is also what makes the Owner, Maintainer and Stakeholder separate people with separate permissions, rather than one account. ([ADR 0008 §2](../docs/decisions/0008-installation-test-decisions.md))

**Enforced by.** Prose only. The installer will refuse a personal-account repository.

**Class.** framework

### `K-ADOPT-3` Use each platform feature where the plan provides it, and the fixed fallback where it doesn't

**Rule.** GitHub's plans decide which of Kanon's platform features exist:

| Feature | Public repo, free organisation | Private repo, Team plan | Private repo, Enterprise Cloud |
|---|---|---|---|
| Rulesets, branch protection | yes | yes | yes |
| Merge queue | yes | **no** | yes |
| Required reviewers on an environment | yes | **no** | yes |

Use each feature wherever the plan provides it. Where it doesn't, use the fixed fallback, and record in the adoption record which one is in use:

- **Merge queue.** Without one, leave "require branches to be up to date" **off**, and let the release commit's full CI run catch a stale base before anything deploys (`K-MERGE-7`, `K-SHIP-8`).
- **Production approval.** Without environment reviewers, production promotion is a manually triggered workflow that only the Maintainer may run (`K-SHIP-9`).
- **Rulesets.** There is no fallback. A private repository on a plan without rulesets stays in bootstrap and can't leave it (`K-ADOPT-6`).

Whether to pay for a plan, or make a repository public, is the project's decision. Kanon only says what each choice provides.

**Why.** Most small teams run private repositories on the Team plan, which lacks both the merge queue and environment approval, so this is the common configuration rather than an edge case. One rule with two recorded outcomes keeps [ADR 0002](../docs/decisions/0002-standardise-dont-parameterise.md): the adopter doesn't choose a setting, the plan decides and the record says which outcome applies.

**Enforced by.** Prose only; the installer will read the plan and apply the matching outcome.

**Class.** framework

## Bootstrap

### `K-ADOPT-4` A repository is in bootstrap from its first commit until its agent identities exist

**Rule.** During bootstrap, and only then:

- the first commit and the installation commits of `K-ADOPT-1` may go directly to the main branch. Every other change goes through a pull request, as it will after bootstrap;
- humans may play agent roles, including the Lead and the Reviewer (`K-ADOPT-5`);
- the ruleset's required approving review is **off**, because GitHub won't let a solo Owner approve their own pull request, and there is no Reviewer yet to approve it;
- a rule whose mechanism isn't installed yet is prose only on this repository, and the adoption record says so (`K-ADOPT-9`). Nobody simulates a guard's verdict by hand.

**Why.** An empty repository breaks three rules on its first day: its first commit can't come through a pull request, a required approval locks a solo Owner out, and no guard exists to fail. A silent exception is exactly what Kanon forbids (`K-PRIN-1`). Naming the state turns those breaks into rules with a boundary.

**Enforced by.** Prose only.

**Class.** framework

### `K-ADOPT-5` Every bootstrap exception is recorded, including which role a human played

**Rule.** Record every use of bootstrap in the adoption record: each commit that went straight to the main branch, and each artifact a human produced while playing an agent role, naming the role. The artifact says so too: a brief, review or merge made by a human standing in for an agent names the role on the artifact itself. A human playing a role uses a credential with that role's permissions (`K-ADOPT-8`) where one can be made, and otherwise their own, recorded as such.

**Why.** When a human plays the Lead under their own credential, and then merges as the Maintainer, the author and the merger are one identity (`K-PRIN-5`). That is acceptable only while it is visible, so that nobody later reads a bootstrap merge as evidence that the separation held.

**Enforced by.** Prose only.

**Class.** framework

### `K-ADOPT-6` Bootstrap ends once, when the Reviewer exists and approval is required, and never returns

**Rule.** Bootstrap ends when the Reviewer's App is installed **and** the ruleset's required approving review is switched on (`K-MERGE-6`). Record the date in the adoption record. From then on, every rule applies in full, and no commit reaches the main branch without a pull request (`K-MERGE-8`). A repository that has left bootstrap never returns to it, whatever breaks later: a lost App or a disabled ruleset is an incident to fix, not a return to bootstrap.

**Why.** An exception that can be re-entered is a switch, and a switch is a setting (`K-PRIN-1`). The exit is tied to the one moment the solo-Owner lockout stops being true: once a Reviewer can approve, an approving review can be required.

**Enforced by.** Prose only; a guard is planned (it fails when the adoption record has an end date and the ruleset doesn't require an approving review).

**Class.** framework

## Credentials

### `K-ADOPT-7` The installer's credential holds setup permissions only while setting up

**Rule.** The credential that installs Kanon on a repository holds:

- **Administration: read and write**, during setup only, for rulesets, merge settings, environments and Actions permissions. Remove it when bootstrap ends;
- **Contents, Issues and Pull requests: read and write**, to commit the layout, create labels and milestones, file the tracking issue and open pull requests;
- **Workflows: read and write** while it commits workflow files, and **Secrets: read and write** while it stores App keys, both during setup only;
- **Metadata: read**, which every credential has.

Creating GitHub Apps and their keys is done by the Owner in GitHub's interface, never by the installer's credential (`K-AGENT-6`).

**Why.** An installation that ran with too little permission stopped partway: merge settings, branch protection, the production environment and even opening a pull request each answered "resource not accessible". One with too much, kept after setup, is a standing admin token nobody needs.

**Enforced by.** Prose only; the installer will probe these scopes before it starts and name the missing grant (`K-AGENT-5`).

**Class.** framework

### `K-ADOPT-8` Each agent App holds exactly its role's permissions

**Rule.** Create each agent App with the permissions in chapter 03's roles table, plus **Metadata: read** on every App. The Merger also holds **Checks: read** and **Commit statuses: read**, because a PR's check rollup is built from both. No App holds any permission its row doesn't give it, and a broadened permission is recorded with its reason in the App register (`K-AGENT-3`).

**Why.** The roles table is the one home for what each role may do (`K-PRIN-2`), and this rule only adds the platform's own requirements. A rollup missing one of the two check sources reads as "fewer checks", not as an error, so the Merger's two read scopes are load-bearing.

**Enforced by.** [`kanon apps`](../docs/apps.md) builds each App's manifest from [`agent-permissions.json`](agent-permissions.json), the roles table's machine-readable twin, and a test fails when the twin and the table disagree. On an App created by hand, or changed after it was created, only the run-time scope probe in every lane (`K-AGENT-5`) checks it.

**Class.** framework

## How Kanon reaches an adopter

### `K-ADOPT-9` The adoption record lists every mechanism, installed or not yet

**Rule.** The adoption record lists every mechanism Kanon's rules name in their "Enforced by" lines, each marked **installed** (with the date) or **not yet installed**. A rule whose mechanism is not yet installed is prose only on this repository, and nothing may describe it as enforced.

**Why.** A Kanon adopted from the rulebook alone enforces nothing: every guard, the Reviewer and the Merger are code or Apps. That is survivable while it is visible. What is not survivable is a repository that believes a guard protects it when none is installed, which is silent absence (`K-PRIN-8`) on the whole pipeline.

**Enforced by.** Prose only.

**Class.** framework

### `K-ADOPT-10` Agents read Kanon's rules from Kanon's shipped files, never from copies

**Rule.** An adopter's agents read Kanon's rules and playbooks from the files Kanon ships, at the version the adopter has installed. The adopter's own agent instruction files carry only the project's content and point to Kanon; they never copy a Kanon rule into a prompt, a playbook or `AGENTS.md`.

**Why.** A copied rule is a second home, and it drifts (`K-PRIN-2`). An adopter that pasted the rulebook into its prompts would hold a frozen, private fork of Kanon that no later fix reaches.

**Enforced by.** Prose only; a guard is planned. The mechanism that delivers Kanon's files to an adopter's agents isn't built yet.

**Class.** framework

### `K-ADOPT-11` Use Kanon's code by reference, pinned to an exact version, and let Dependabot propose upgrades

**Rule.** An adopter uses Kanon's code by reference, never by copying it. Each piece ships in a fixed form:

| Kind | Ships as | An adopter refers to it as |
|---|---|---|
| Check | A composite action under `actions/` | `uses: yedeya-labs/kanon/actions/<name>@vX.Y.Z` in a step |
| Lane | A reusable workflow, such as the [release workflow](../docs/release.md) | `uses: yedeya-labs/kanon/.github/workflows/<name>.yml@vX.Y.Z` in a job |
| Guard | An npm package | an exact version in `package.json` |
| Skill | A Claude Code plugin | an exact plugin version |

Every reference pins an **exact version** (`vX.Y.Z`), never a branch, a commit without a tag, or the moving major tag (`v0`). Upgrades arrive as Dependabot pull requests: `.github/dependabot.yml` has an entry that allows only Kanon's dependencies (`yedeya-labs/kanon*`), groups them into one PR, and titles it with the `ci` prefix and a scope, so it reads `ci(deps): ...` and passes `K-SHIP-4`. The entry **exempts Kanon from Dependabot's cooldown** (`cooldown.exclude: ["yedeya-labs/kanon*"]`), and keeps the default cooldown for every third-party dependency. The upgrade PR is reviewed and merged like any other.

Kanon's repository is public, so no settings are needed for an adopter's workflows or Dependabot to reach it.

**Why.** A copied check is a private fork that no later fix reaches (`K-ADOPT-10`). A moving reference is the opposite failure: a Kanon release changes what an adopter's build enforces with no change in the adopter's repository, so a check can start failing, or stop failing, on a commit that touched nothing. An exact pin makes every change to what Kanon enforces a PR that the adopter's own CI tests first. A composite action reads its own files at the ref the adopter pinned, so a check and its script can't drift; a reusable workflow owns whole jobs, which is what a lane needs. The cooldown is a supply-chain safeguard: it gives the community time to catch a compromised third-party release. Every Kanon release has already passed Kanon's own review, so for Kanon it protects against nothing and only delays fixes; on the first adopter, it held back the first upgrade for three days.

**Enforced by.** Prose only; a guard is planned. Kanon moves its major tag after each release, so a moving reference exists, but nothing yet fails an adopter's build for using it.

**Class.** framework

### `K-ADOPT-12` Pin every third-party action to a version tag or a full commit SHA, never a branch

**Rule.** Every `uses:` of an action or reusable workflow from outside the repository names a version tag (`v7`, `v1.0.239`) or a full 40-character commit SHA. Never a branch, a short SHA, or no ref at all. Kanon itself is pinned more strictly, to an exact version (`K-ADOPT-11`), and Dependabot proposes upgrades for both.

**Why.** A branch moves with every push to it, so whoever can push there can change what runs in your workflows, with your tokens and secrets, while your repository doesn't change at all. A tag is a release its publisher cut on purpose, and a SHA can't move at all. A major tag such as `v7` can still be moved by its publisher, so it trusts that publisher; a full SHA trusts nobody, and is always allowed.

**Enforced by.** [`tests/unit/workflow-security.test.ts`](../tests/unit/workflow-security.test.ts), on Kanon's own workflows and actions: it fails on a third-party `uses:` whose ref isn't `vN`, `vN.N`, `vN.N.N` or a full SHA. A branch named like a version tag can't be told apart by reading the file. For an adopter, prose only; a guard is planned.

**Class.** framework
