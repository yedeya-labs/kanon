# 0013. Any GitHub account, two Apps, and personas in content

- **Status:** accepted
- **Date:** 2026-10-05
- **Decided in:** [#288](https://github.com/yedeya-labs/kanon/issues/288), recorded by [plan 0005](../plans/0005-lean-installation.md), decisions 1 to 3 and question 6
- **Supersedes:** [ADR 0008 §2](0008-installation-test-decisions.md) (Kanon assumes a GitHub organisation)

## Context

Installing Kanon took fourteen ordered steps, one GitHub App per agent role, and an organisation to hold them. Each App meant a manifest flow, two secrets and a register row per repository: six roles, so six flows and twelve secrets, and about eight Apps on the reference adopter. `kanon apps` built only organisation URLs, because [ADR 0008 §2](0008-installation-test-decisions.md) said an adopter's repositories live in an organisation. After installing Kanon on the reference adopter and on Kanon itself, the Owner judged the installation long, tedious and cumbersome, and asked for it to get smoother before other adopters arrive ([plan 0005](../plans/0005-lean-installation.md), §1).

Two of the costs come from assumptions rather than from the governance. ADR 0008 §2 assumed an organisation because a personal account lacks the merge queue and, on a private repository, rulesets without a paid plan. But [ADR 0008](0008-installation-test-decisions.md) already gives each missing feature a recorded fallback, and the one feature with no fallback (rulesets) is missing on a free organisation's private repository too. And one App per role assumed that the identity is what separates two roles. It is only essential between the author and the approver: GitHub refuses to let an identity approve its own pull request, so that separation is the one the platform enforces. Least privilege is already held at the token: every step that mints one narrows it to what it uses (`K-AGENT-46`).

## Decisions

### 1. Personal accounts are first-class

**Any GitHub account may adopt Kanon: a personal account or an organisation.** Organisations and paid features (the merge queue, environments, organisation secrets) are used wherever they exist, and nothing in Kanon may require them. Each missing feature has the fixed fallback `K-ADOPT-3` records, as before. A private repository on a plan without rulesets, such as GitHub Free, is allowed: every lane runs there, and the Merger still merges only what the Judge approved, but nothing on the platform refuses a merge without an approval, so that repository stays in bootstrap (`K-ADOPT-6`) and the adoption record says so.

**A consequence to record:** on a personal account a collaborator has write access, with no Triage role, so the Stakeholder holds more than chapter 03's "Triage". The adoption record says so.

*Why:* the organisation bought nothing that a recorded fallback doesn't already cover, and it cost every solo adopter an organisation before their first commit. Requiring it was a setting in disguise: the plan, not the adopter, decides which features exist, and [ADR 0002](0002-standardise-dont-parameterise.md) asks for one rule with recorded outcomes.

### 2. Two Apps per owner, plus an optional Releaser

**An owner runs two GitHub Apps, reused across all of its repositories that adopt Kanon:**

| App | Roles | Writes |
|---|---|---|
| **Author** | Implementer, Lead, Explorer, Overseer | code, issues and pull requests |
| **Judge** | Reviewer, Merger | reviews and merges, and never authors |
| **Releaser**, optional | Releaser | release pull requests only, and is the only ruleset bypass actor |

- **Each App holds the union of its roles' permissions,** plus Metadata: read (`K-ADOPT-8`). The Author also holds Commit statuses: write, a broadened permission recorded with its reason (`K-AGENT-3`, decision 3 below).
- **The one essential separation is author and approver.** A Judge approval on an Author pull request is a real approval, so the ruleset's required review means what it says (`K-MERGE-6`). The Author never approves, and the Judge never authors.
- **Least privilege stays at the token.** Each minting step still narrows its token to what that step uses (`K-AGENT-46`), and must fit inside both its App's grant and its role's row. So the Lead's token still carries no Workflows, the review token no Actions write, and only the Implementer's lanes mint with Workflows (`K-AGENT-7`).
- **The Releaser is a third App of its own.** A ruleset bypass is granted to an App, not to a role, so a bypass on the Author would also have been the Implementer's, the Lead's, the Explorer's and the Overseer's. An adopter that makes no releases, or merges its release pull requests through the front door, needs only the Author and the Judge. The Owner first placed the Releaser inside the Author, and changed that the same day.
- **The register keeps one row per role,** and roles of one App share its slug (`K-LAYOUT-6`). The Author, the Judge and the Releaser have three distinct slugs.

*Why:* setup drops from six to eight manifest flows to two per owner, three with releases, and to none for the owner's next repository. **The cost is blast radius:** a leaked Author key mints tokens for every adopting repository of that owner, where a leaked per-role key reached one. That is why no repository migrates onto the shared Apps until no agent's job holds an App's key (`K-AGENT-49`).

### 3. Personas in content, and an implementer status the agents can't forge

**A role is shown and read through the content an agent writes, not through a separate App:**

- **What a reader sees.** Every post an agent writes (a comment, a review, an issue or pull request body) opens with a persona header, `**<persona> (<Role>)**`. The persona is a display name the adopter may declare; without one, the header is the role alone. Every commit an agent makes has the persona as its author name and the App's noreply address as its email, so GitHub still attributes it to the App, and the delegate's sign-off still matches (`K-AGENT-44`).
- **What a machine reads.** A hidden role marker, `<!-- kanon:role=<role> -->`, beside the header, plus the labels and trailers the lanes already write. A check trusts a marker only on an object the expected App authored: the login says which App, the marker says which of its roles.
- **The green zone needs a signal no other Author lane can write.** Any Author lane's agent can write the `implementer` marker, so on its own it would let a steered Lead, Explorer or Overseer agent put a code pull request in the green zone. So a fixed step of the Implementer's lanes, never the agent, sets the commit status `kanon/role: implementer` on the head, with a token narrowed to Commit statuses: write, which no agent's token holds. The Merger requires that status on the current head, created by the Author App. Only a lane that opens a pull request creates the first status, and only on the pull request its own run opened; a lane that acts on an existing pull request carries the status to its new head only when the head it started from had one. A person's push ends the chain, and a person merges that pull request.

*Why:* a marker in content costs nothing to write and survives the move to shared Apps, while the login alone can no longer tell two roles of one App apart. The only loss is a distinct avatar per persona. The status exists because a marker is a claim, and the green zone must rest on a mechanism (`K-PRIN-4`).

## Consequences

- **The rulebook describes the target from this change.** `K-PRIN-5`, `K-AGENT-1`, `K-AGENT-2`, `K-AGENT-7`, `K-ADOPT-1`, `K-ADOPT-2`, `K-ADOPT-3`, `K-ADOPT-8`, `K-LAYOUT-6`, chapter 00's assumptions table and chapter 03's roles table are amended, and [`agent-permissions.json`](../../rulebook/agent-permissions.json) gains the three Apps as the union of their roles, held there by a parity test.
- **Behaviour follows in plan 0005's later steps, and each amended rule says until when it is prose.** Until the release that completes step L4, Kanon's lanes still mint one App per role, read roles by login, and declare role-named secrets; `kanon apps` still creates one App per role and, until step L2, needs an organisation. Step L3 writes the persona header, the role marker and the implementer status beside today's logins; step L4 is the breaking release that moves the lanes to the Author and the Judge, the release workflow to the Releaser, and the Merger's green zone to the implementer status.
- **The migrations wait.** Kanon's own move to the three Apps (step L5) and its adopters' (step L6) wait until no agent's job holds an App's key, because the shared keys become the keys for every lane of that owner.
- **ADR 0008 §2 is superseded.** Its plan table moves into `K-ADOPT-3`, which gains the personal-account columns; the fallbacks it defined are unchanged.
