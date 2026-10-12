# Kanon's architecture

This page describes Kanon on one page: who acts, what starts them, what stops them, where data goes and where the rules are enforced. Each part links to the page with the details.

```mermaid
flowchart LR
    P(["A person"]) -- "approves a brief,<br/>labels an issue" --> L
    subgraph Author["Author App"]
        L["Lead<br/>plans, files issues"]
        I["Implementer<br/>opens the pull request"]
        E["Explorer · Overseer<br/>sweeps and audits"]
    end
    subgraph Judge["Judge App"]
        R{"Reviewer"}
        M["Merger"]
    end
    L -- "issue with agent:implement" --> I
    I -- "pull request with review:please" --> R
    R -- "changes requested" --> I
    R -- "approved" --> G{"Green zone?"}
    G -- "yes" --> M
    G -- "no, or an escalation path" --> P
    M --> Q[("Merge queue<br/>and ruleset")]
    P -- "merges" --> Q
    E -. "files findings" .-> TR["Triage"] -.-> I
    I & R -. "run rows, with consent" .-> T[("Telemetry store")]
    E -. "Kanon's own bugs, with consent" .-> K[("Kanon's maintainer")]
```

## Who acts: two Apps

Agents act through GitHub Apps, never through a person's token. An owner has two, reused across its repositories ([apps.md](apps.md), [ADR 0013](decisions/0013-personal-accounts-and-two-apps.md)):

| App | Roles | What it may do |
|---|---|---|
| **Author** | Lead, Implementer, Explorer, Overseer | write code, open pull requests, file issues |
| **Judge** | Reviewer, Merger | review and merge, never write code |
| **Releaser** (optional) | the release workflow | open release pull requests and push release tags |

Each App holds exactly the permissions its roles need ([`rulebook/agent-permissions.json`](../rulebook/agent-permissions.json)). Each lane narrows its token further, and the job that runs the agent never holds the App's key. Every comment an agent posts opens with its role, such as **Reviewer**, and a hidden role marker, so a check can tell which role wrote it.

## What starts them: lanes

A **lane** is a reusable workflow that runs one agent for one job. An adopter calls it from a small workflow in its own repository, pinned to a Kanon release. All 19 are listed with their triggers in [lanes.md](lanes.md):

| Family | Lanes | Started by |
|---|---|---|
| Reviewing | review, merge reconcile | the `review:please` label once CI finishes; a review or a merge |
| Building | implement, implement-revise, triage, rebase | the `agent:implement`, `agent:revise` or `qa:needs-triage` label; a review; CI on main |
| Planning | lead, lead-revise, lead-split, lead-reconcile, verify-acs | a person's dispatch with a mandate; labels; hourly |
| Merging | merge | an approval; CI on main; hourly |
| Exploring | explore, code audit, explore the telemetry | a schedule |
| Upkeep and reporting | dispatch sweep, Overseer, daily and weekly digests | a schedule |

You don't install them all. `kanon init` offers three features: **Review** (the review lane alone), **Review + build** (adds the Implementer's lanes, the dispatch sweep and merge reconcile) and the **full pipeline** (adds the Lead, the Merger and the audits). Three lanes run no model at all: the Merger, the reconciler and the dispatch sweep.

## What stops them: the gates

- **The membership gate.** The first step of every lane checks who caused the event: a repository member, or one of the register's Apps. Anyone else is refused before a token exists ([`K-AGENT-45`](../rulebook/03-agents.md)).
- **Review is opt-in.** The Reviewer reviews a pull request only when it carries `review:please`, or the `agent:implement` or `agent:triage` label of an Implementer's pull request. An unlabelled pull request is never reviewed ([`K-MERGE-14`](../rulebook/04-review-and-merge.md)).
- **The implementer status.** After the Implementer finishes, a fixed step posts the `kanon/role: implementer` status on the commit, with a permission no agent holds. The Merger merges only a head that carries it, so no other agent can pass its work off as the Implementer's.
- **The green zone.** The Merger merges only when all six conditions hold: the Implementer's pull request, the Reviewer's approval of that exact head, green checks, no escalation path, exactly the declared issues closed, and a clean merge. Workflows, agent instructions and the paths you mark high-risk always go to a person ([`K-MERGE-3`, `K-MERGE-4`](../rulebook/04-review-and-merge.md)).
- **The ruleset and the merge queue.** The default branch's ruleset requires a pull request and the `Lane check` job, and the merge queue where your plan has one.
- **The round cap.** A finding that survives two review rounds stops the revise lanes and goes to a person (`K-AGENT-18`).
- **Bootstrap.** A new repository starts in bootstrap: people may play the agents' roles and approval isn't required yet. It ends once, when the Judge App is installed and required approval is switched on ([`K-ADOPT-6`](../rulebook/10-adoption.md)) [`kanon doctor`](doctor.md) reminds the adopter once the Judge can approve and nothing requires it to (`ruleset.bootstrap-can-end`), and fails a ruleset that stops requiring approval after the adoption record says bootstrap ended (`ruleset.approval-off`).

## Where data goes

- **The QA store** is the agents' memory: the Explorer's reports, route coverage and the code-reading ledger. It lives in the adopter's own cloud account, behind a hook. Without one, the lanes run without memory ([qa-store.md](qa-store.md)).
- **The telemetry store** is Kanon's, and is used only if you say yes at install. An hourly collector sends a row per agent run and a row per closed pull request: counts, costs and outcomes, never code, prompts, text, titles or usernames. Rows are keyed by an opaque key, kept 13 months and erased on request ([telemetry.md](telemetry.md)).
- **Kanon's own bugs** (upstream findings) are the one place text may leave. The Overseer and the telemetry Explorer send each bug they find in Kanon itself as codes, and, only if you answered **Yes** at install, with its evidence and suggested fix as scrubbed text. That text may rarely still hold personal data. It is read by Kanon's maintainer and by one third-party decision provider, which decides whether it becomes a public Kanon issue (`K-OBS-16`). [sharing.md](sharing.md) has the full answer: the three install answers, what is sent, who reads it, and how to stop and erase it.
- **Metrics** come from those rows: `kanon metrics report` gives cost per merged item, yield and escaped defects, by size of item, and the Overseer writes it to its weekly summary ([metrics.md](metrics.md)). Figures across adopters are published only when at least three contribute.

## Where the rules are enforced

The [rulebook](../rulebook/) states each rule once, as `K-<AREA>-<n>`, with its reason and what enforces it. **The rule ids are permanent.** The enforcement is spread over:

- **checks on every pull request:** the PR-title check, the DCO sign-off check, the lane check (your callers, Apps and pins) and Kanon's own tests;
- **GitHub's own settings:** the ruleset, the merge queue and the App permissions;
- **the lanes themselves:** the membership gate, the implementer status and the Merger's green-zone test;
- **`kanon doctor`**, which checks an installation against a release before you move the pin ([doctor.md](doctor.md));
- **the Reviewer's checklist** ([playbook](qa/reviewer-playbook.md)), for what code can't check.

A rule whose "Enforced by" says *prose only* has no check yet. Those rules are Kanon's own backlog.

## Where things are

| Path | What |
|---|---|
| [`rulebook/`](../rulebook/) | The rules: Kanon's specification. |
| [`docs/decisions/`](decisions/) | Architecture decision records: why Kanon is shaped this way. |
| [`.github/workflows/`](../.github/workflows/) | The lanes, the shared lane workflow they call, the release workflow, and Kanon's own CI. |
| [`actions/`](../actions/) | The checks and the building blocks of a lane, each a versioned composite action. |
| [`scripts/`](../scripts/) | The library the lanes run. |
| [`cli/`](../cli/) | The `kanon` command: `init`, `doctor`, `apps`, `milestones`, `metrics`. |
| [`skills/`](../skills/) | The Claude Code skills: `/kanon:adopt`, `/kanon:doctor`, `/kanon:upgrade`. |
| [`infra/`](../infra/) | The QA store's and the telemetry store's cloud templates. |
| [`tests/`](../tests/) | Kanon's own tests, run on every pull request. |
