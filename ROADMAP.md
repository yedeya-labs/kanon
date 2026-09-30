# Roadmap

Kanon is being extracted from the project where it grew up (the *reference adopter*). This page lists the work in order, and marks the decisions that still have to be made before that work can start. Nothing here has a date. Each phase starts when the one before it has shown what it needed to show.

## Phase 1: Rulebook

Write every opinion down in [`rulebook/`](rulebook/). Each opinion gets its reason and a class: framework opinion, or project policy.

- **Done when** every chapter is written, and every rule the reference adopter enforces has either a rule id or a recorded reason for not being a Kanon rule.
- The disputed rules are the real design work. Each one is decided explicitly and recorded.

## Where Kanon lives

Kanon's repositories live in the **`yedeya-labs`** GitHub organisation. They are **private for now**, and each goes public on its own, at its own gate ([ADR 0008 §2](docs/decisions/0008-installation-test-decisions.md)). This is the same rule Kanon sets for its adopters (`K-ADOPT-2`).

## Phase 2: Second adopter and extraction, together

The second adopter and the extraction were planned as two phases in sequence. They are now **one phase** ([ADR 0008 §1](docs/decisions/0008-installation-test-decisions.md)): the second adopter continues with humans playing the agent roles by hand, and each piece of Kanon's code, as it is extracted from the reference adopter, lands on the second adopter first. The reference adopter then consumes Kanon like any other adopter.

### The installation test: done

**Done on 2026-09-28.** Kanon was installed on its second adopter, **Kolophon**, in an empty repository, by an agent that could read only Kanon's README, roadmap, rulebook and decisions. Kolophon is a front page (a marketing page, sales pitch, blog or infomercial) backed by a serverless CMS, on the same deploy stack as the reference adopter but with none of its domain.

- **Friction:** 38 entries. By type: 8 blockers, 5 workarounds, 13 gaps, 5 unclear, 6 conflicts, 1 cost. By suggested classification: 7 rule-wrong, 14 rulebook-gap, 12 installer-needed, 5 project-decision, and **none out of target**. Kolophon fits Kanon's intended shape.
- **Time:** 13 minutes 19 seconds of uninterrupted agent work, from reading to a pushed first brief. That is a floor, not an estimate of a human adopter's setup time, and it covers only the part that enforces nothing.
- **What it showed:** adopted from its rulebook alone, Kanon is prose only. Every guard, the Reviewer and the Merger are code or GitHub Apps that didn't exist yet, so nothing on the adopter could fail a build. The rulebook also lacked a bootstrap state, an installation order, its fixed paths and formats, and the plan-dependent fallbacks.
- **Rulebook fixes:** made in the same change as ADR 0008. Chapter [10 Adoption](rulebook/10-adoption.md) and chapter [11 Repository layout](rulebook/11-repository-layout.md) were added, and the other fixes went into the chapters they concern.
- **Falsified if**, once the extracted code is installed, setup still takes more than about a day on the second adopter, or the conventions don't fit its shape.

### Extraction requirements

The installation test's `installer-needed` entries are the extraction's requirements. Grouped:

**Guards, lanes and Apps.**
- Every guard and lane named in an "Enforced by" line, so that an adopter's rules can fail a build (`K-ADOPT-9`). The Reviewer's lane comes first, because installing it is what ends bootstrap (`K-ADOPT-6`).
- A GitHub App manifest per agent role, with the permissions of `K-ADOPT-8`, so the Owner creates each App from a manifest instead of configuring it by hand; and the fixed names of the Actions secrets that hold each App's id and key (`K-AGENT-6`).
- The Lead's brief lane, so a brief's author is the Lead's App and not the Owner who merges it (`K-PRIN-5`, `K-ADOPT-5`).

**The installer.**
- One guided setup that runs `K-ADOPT-1` in order: layout, settings, labels with colours and descriptions, bucket milestones, the ruleset, the plan's fallbacks, and the adoption record.
- It checks the installer credential's permissions before it starts, and names any that are missing (`K-ADOPT-7`), including the permissions a human playing an agent role needs.
- It refuses a personal-account repository (`K-ADOPT-2`) and reads the plan to choose the fallbacks (`K-ADOPT-3`).

**Tools that write the fixed formats.**
- The spec-id allocator, the spec guard and the coverage tool, reading and writing exactly the formats of `K-LAYOUT-2` to `K-LAYOUT-4`.
- The brief guard, run against Kanon's template (`K-LAYOUT-11` to `K-LAYOUT-13`), including measurement items (`K-PROJ-16`).
- The worktree script, including branch naming (`K-WS-8`).
- The release configuration and the PR-title validator, with the fixed types of `K-SHIP-4`. The validator ships as the [`pr-title`](actions/pr-title/README.md) action, and the release mechanism as the reusable [release workflow](docs/release.md).

**Delivery and data.**
- The mechanism that delivers Kanon's rules and playbooks to an adopter's agents from Kanon's own files, at the adopter's installed version, which must work while Kanon's repositories are private (`K-ADOPT-10`).
- The infrastructure code for the QA store and the telemetry store in an adopter's own account (`K-OBS-17`, `K-OBS-18`). When an adopter has many accounts, the stores go in the reference environment's account (`K-OBS-17`).

### The code (formerly phase 3a)

Agent lanes, guards, checks, playbooks and scripts move here. Their shape follows what Phases 1 and 2 showed actually varies between projects. Each piece is installed on the second adopter first.

**Decided: how each kind of code reaches a project** (`K-ADOPT-11`):

| Kind | Delivered as | Why |
|---|---|---|
| **Checks** | **Composite actions** under [`actions/`](actions/) | A composite action reads its own script through its action path, at the ref the adopter pinned, so the check and its script can't drift apart. |
| **Lanes** | **Reusable workflows** | A lane owns whole jobs, with their permissions and secrets, which is what a reusable workflow is. It has no clean way to check out its own repository at its own ref, so it doesn't suit a check that needs its own script. |
| **Guards** | **An npm package** | Guards run inside the adopter's own test suite, against the adopter's files. |
| **Skills** | **A Claude Code plugin** | The agent runtime loads skills, commands and agents from a plugin. |

Every kind is versioned by Kanon's releases (release-please, one version per merge to `main`), and an adopter pins an exact version and takes upgrades as Dependabot PRs.

**First delivered:** the PR-title check, as [`actions/pr-title`](actions/pr-title/README.md) (`K-SHIP-4`), together with Kanon's own release configuration. It proves the release, pin and upgrade path before the lanes move.

### The operational store (formerly phase 3b)

**Today the pipeline's operational store lives in the reference adopter's staging AWS account**, created by that project's own infrastructure code and only on its staging stage:

| Resource | Holds |
|---|---|
| S3 bucket | Raw run reports, one object per agent run |
| DynamoDB table | Run history, cost telemetry, and per-project QA data (route coverage, signal precision, the code-reading ledger) |
| IAM role, assumed via GitHub OIDC | Access for the pipeline's jobs; trusts exactly one repository |
| Bedrock embedding calls | Semantic recall for deduplicating agent findings |

That is wrong for three reasons, and they are why this is part of the extraction rather than a later feature:

1. **The IP boundary.** Kanon is not the reference adopter's IP, and that covers its data as well as its code. Kanon's history sits in another product's account and on another product's bill.
2. **The lifecycle.** The store is tied to a staging environment. When that environment was once torn down and redeployed, the table and its items survived but **the bucket was emptied**. Any staging teardown puts Kanon's history at risk.
3. **Trust is single-repository.** The role trusts one repository. A second adopter cannot use it.

**The move** follows the data boundary ([ADR 0007](docs/decisions/0007-data-boundary.md), rules `K-OBS-16` to `K-OBS-18`). The store splits in two:

| Data | Goes to |
|---|---|
| Telemetry (run history, cost rows) | A **dedicated Kanon AWS account** in Frankfurt (`eu-central-1`), under AWS Organizations. The reference adopter opts in, as any adopter would. |
| QA data (run reports and findings, coverage, precision, the code-reading ledger, embeddings) | **Stays in the reference adopter's own account**, but moves out of the staging stage into a stack whose lifecycle no environment teardown can touch. The embedding calls stay with it. |

- **Kanon's infrastructure code creates both**: the hosted telemetry store in Kanon's account, and the QA store in any adopter's account. The reference adopter's own infrastructure code stops defining them.
- **Trust.** The telemetry role's trust covers each adopter repository that has opted in. Being granted it is part of onboarding.
- **Migrate, don't restart.** Export and import the table, and sync the bucket, *before* anything is removed from the staging stage. Existing cost baselines depend on that history.
  - Migrated telemetry rows are **cleaned on the way** to meet `K-OBS-16`: usernames are replaced by agent roles, and free-text reasons are mapped to codes. Where a reason can't be mapped, it is dropped.
- **Only the collector changes.** It is already the single job that writes telemetry, so the move repoints that job's role. The agent lanes don't change.
- **Cost:** mostly moved, not added. S3 and on-demand DynamoDB at pipeline volume cost pennies a month, and a new account is free. A stated estimate is still required when the work is proposed, and any scheduled job in either account needs its own budget estimate.

## Decided: the data boundary

Decided in [ADR 0007](docs/decisions/0007-data-boundary.md) and written as rules `K-OBS-16` to `K-OBS-18`:

- **Telemetry is metadata only:**
  - the repository, and issue or PR numbers;
  - the agent role, never a username;
  - lane, model, tokens, cost and duration;
  - the outcome, and a reason chosen from a fixed list of codes.

  Never code, prompts, issue or PR text, file paths or free text.
- **Project QA data stays in the adopter's own account**, created by Kanon's infrastructure code, independent of any application stage.
- **Hosted telemetry is opt-in.** It is kept in the EU (Frankfurt) for thirteen months and deleted on request. Each adopter sees only their own data; anything shared across adopters is aggregated and anonymised.

## Phase 3: Before going public

- **Licence:** see [ADR 0003](docs/decisions/0003-licence-deferred.md).
- **Installer:** complete, from the extraction requirements above (phase 2), and tested on an adopter that runs it without help.
- **Roles for teams:** the Owner, Maintainer and Stakeholder roles (ADR 0005, ADR 0006), tested on an adopter where they are different people.
- **Published per-run cost data**, from the telemetry.
- **Done 2026-09-30:** the extraction's working files moved to a separate private repository. A test keeps the reference adopter's names out of the public tree.

## Later: Kanon Cloud

Built on the operational store (phase 2) once there is data from more than one project. If Kanon becomes open core, this is the natural paid layer, so it depends on the licence decision.

- **Dashboards:** cost per merged PR, review rounds per PR, bail and crash reasons, cache hit rate, setup time per adopter. CloudWatch dashboards or a small serverless page, not per-user BI tooling, unless the cost is agreed.
- **Improvement agents:** the reference adopter's self-auditing agent, generalised across adopters, so that Kanon's opinions are driven by evidence ("this rule causes friction in three of five projects", "this lane's cost doubled after a model change"). These agents follow Kanon's own rules: they file issues on this repository, and a human merges.
