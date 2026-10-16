# 0007. The data boundary

- **Status:** accepted
- **Date:** 2026-09-28

## Context

Kanon's pipeline produces two kinds of data:

- **Telemetry:** what each agent run cost, how long it took and how it ended.
- **QA data:** run reports and findings, route coverage, signal precision, the code-reading ledger, and the embeddings used to deduplicate findings.

In the reference adopter, both live in one store inside that project's staging environment. Kanon is meant for other teams, and will offer a hosted telemetry service. So before any other team's data arrives, three things had to be decided: what may leave a project, where each kind of data is kept, and who may see it.

## Decision

Written as rules `K-OBS-16`, `K-OBS-17` and `K-OBS-18` in [chapter 08](../../rulebook/08-observability-and-cost.md).

1. **Telemetry is metadata, never content.**
   - **Allowed:** the repository (the opaque key the store files a row under, by the amendment of 2026-10-12, below), issue and PR numbers, the agent *role*, lane, model, tokens, cost, duration, outcome, and a reason from a fixed list of codes.
   - **Never:** code, prompts, issue or PR text, file paths outside Kanon's own tree (narrowed from "file paths" by the amendment of 2026-10-07, below), error messages, other free text, or GitHub usernames.
2. **QA data stays in the adopter's own cloud account.** Kanon's infrastructure code creates it there. Its lifecycle is independent of any application stage, so an environment teardown can never delete it.
3. **Sending telemetry to the Kanon-hosted service is opt-in.** By default the same collector writes to the adopter's own store (amended 2026-10-12, below: by default the row stays in the adopter's repository as a run artifact, and no collector sends it anywhere).
4. **Hosted telemetry is kept in the EU, in Frankfurt (`eu-central-1`), for thirteen months**, and an adopter's data is deleted on request.
5. **Each adopter sees only their own data.** Anything shared across adopters, including published cost figures, is aggregated and anonymised.

**Amended 2026-10-02.** Rule 1's allowed list is longer in `K-OBS-16`: it also names the run's identity, configuration, work-size and output counts, the verdict and diagnostic codes, and attribution codes, and six groups of metadata for the work-item row. Each is a number, a time, or a value from a closed list. The "never" list is unchanged. See [plan 0002](../plans/0002-hosted-telemetry-store.md), decision 2, and [plan 0003](../plans/0003-metrics.md) §5.3.

**Noted 2026-10-07, by the Owner's decision (#443).** Rule 5 is unchanged: a figure that combines several adopters' rows is published only when at least three distinct adopters contribute to it, and never names an adopter. **An adopter may declare its own figures publishable,** in the operator's private register, off by default and open to any adopter. Those figures are then published as that adopter's own, under a label it chooses, never its key, and never presented as cross-adopter figures. Its rows are then left out of every cross-adopter figure, so the two can't be subtracted to recover a figure of fewer than three adopters. Kanon declares it for its own runs, which are public anyway. See [plan 0002](../plans/0002-hosted-telemetry-store.md) §6.1.

**Amended 2026-10-07, by the Owner's decisions on [#481](https://github.com/yedeya-labs/kanon/issues/481): upstream findings.** A finding only Kanon can act on, found in an adopter's repository by the Overseer or the telemetry Explorer, may leave that repository over the telemetry channel, as a third row kind, the finding row. See [plan 0006](../plans/0006-upstream-findings.md).
- **Opt-in, at two levels, beside rule 3's.** The adoption record says ``- **Upstream findings:** `sent` `` or `` `sent with evidence` `` under `## Choices`; without either, nothing is sent. Both need the telemetry opt-in, and are asked during install, in one consent question that sets both levels (amended 2026-10-10, from "as their own questions", by [plan 0007](../plans/0007-guided-install.md)'s Owner decision 2: its §3, Q4, and the page it links, [`docs/sharing.md`](../sharing.md)). The question for the second level says plainly that the text is read by Kanon's maintainer and by a third-party decision provider.
- **`sent`: Kanon's vocabulary only.** The lane, stage, error and reason codes, the Kanon version, rulebook ids, the paths of files Kanon ships, and a suggested-fix category from a closed list. Each is a code, a version or a path in Kanon's own tree. **Rule 1's "never" list narrows from "file paths" to "file paths outside Kanon's own tree"**, matching `K-OBS-16`: a path to a file Kanon ships says nothing about the adopter's project.
- **`sent with evidence`: also the finding's evidence and suggested fix, as free text.** This is the one exception to rule 1's free-text and username clauses, and it holds only for this row kind at this level. **The text is extracted, not redacted** (the Owner's decision, 2026-10-07): the lane writes it for Kanon's maintainer to Kanon's template (Expected, Observed, Where, Reproduce, Suggested fix), in roles rather than names, without quoting the adopter's text, and sends codes only when it can't. A deterministic scrub then runs on it in the adopter's lane, and again at intake and in the job that reads it. A text that fails is not sent. **The scrub removes only the logins and names the lane can see, so level-2 text may rarely still contain personal data,** and the install question for that level says so.
- **To whom.** The scrubbed text goes to Kanon's maintainer, who reads it in a private issue, and to one third-party decision provider, **TypeSafe**, whose model **Jev** decides which findings become public Kanon issues. It goes to no one else: a public Kanon issue holds only what `sent` sends, and counts only under rule 5.
- **What never leaves.** At `sent`, nothing but codes, versions and Kanon paths, so no key, repository name, login, URL or non-Kanon path can, by construction. At `sent with evidence`, the scrub removes every URL, email address, credential shape, adopter-key shape and path outside Kanon's own tree, the repository's own name and its owner's, and the logins and names the lane can see. A login or a personal name the lane never saw is kept out by the template's rules alone, which is why the claim above is "rarely", not "never".
- **Kept like telemetry:** in Frankfurt, thirteen months, and deleted on request (rule 4). Each adopter reads only its own findings (rule 5).

**Amended 2026-10-12, by [#707](https://github.com/yedeya-labs/kanon/issues/707): rules 1 and 3 say what the code does.**
- **Rule 1's "the repository" is the opaque key the store files a row under.** No row kind has a field naming the repository. The store's partition key is the adopter's key and a partition name (`<key>#<lane>` for a run row), and the ingest function takes the key from its caller, never from the row (`K-OBS-16`). The "never" list is unchanged.
- **Rule 3's default is not an adopter-owned store, because no install makes one.** Each lane run keeps its row as one of the run's artifacts, and no collector sends it anywhere, which is what the install's answer **No** gives (`K-OBS-18`, [`docs/sharing.md`](../sharing.md)). Sending telemetry to the Kanon-hosted service is still opt-in, so nothing more leaves by default.

**Amended 2026-10-14, by [plan 0008](../plans/0008-self-service-registration.md) §11, from vM (the release that ships its token path): how the hosted store holds rule 5, and who erases.** No rule changes.
- **Rule 5 is unchanged; its enforcement for the hosted store moves from IAM roles to the ingest function's token checks.** The function admits a row only from Kanon's collector at a release, on the repository's default branch, with GitHub's OIDC token, and reads each adopter's own rows under a session held to its key. Which repository is calling, and so which key, is decided by Kanon's code, not by IAM; the per-adopter writer, reader and invoker roles went at vM+1 (plan 0008 J9).
- **The register leaves git** for a KMS-encrypted table in the store's account, so no pull request carries a key.
- **Erasure is self-service.** Rule 4's "deleted on request" holds, and the request no longer needs a person: the adopter dispatches its collector's caller with `erase: yes`, or asks the operator.

**Amended 2026-10-14, by [plan 0010](../plans/0010-deployment-lane.md)'s decision 11: the deploy row.** A fourth row kind, the deploy row, describes one release's deploy to one environment of the chain an adopter declares, and is written by the deploy lane, which runs no model. Rule 1's allowed list grows for it in `K-OBS-16`, as it did for the work-item and finding rows; the "never" list is unchanged.
- **Allowed:** the environment's **role**, `production` for the last environment of the chain and `pre-production` for every other, and its **position** in the chain; the trigger, and whether the release is a pre-release, the deploy a redeploy or a rollback; the outcome, the stage that failed and the refusal, from Kanon's closed lists; and durations. Each is a number, a time, a boolean or a value from a closed list.
- **Never:** the release's commit or tag, the adopter's version, an environment's name, a URL, the reviewer, or any name from the cloud. Any of them would let whoever can read the adopter's public repository say whose row it is, which the opaque key exists to prevent.
- **Rule 5 for deploy rows:** they are stored, and not published across adopters (plan 0010 §10).

**Amended 2026-10-14, by [plan 0011](../plans/0011-notifications.md)'s decision 14: the notify row.** A fifth row kind, the notify row, describes one `notify` job's delivery of one lane's message through the adopter's hook, and is written by that job, which runs no model. It is stored in its lane's partition, `<key>#<lane>`. Rule 1's allowed list grows for it in `K-OBS-16`, as it did for the work-item, finding and deploy rows; the "never" list is unchanged.
- **Allowed:** the hook's kind, `slack`, `webhook` or `custom`; the message's kind and its contract version; the producer's attempt, beside the `notify` job's own run id and attempt; the outcome, `posted`, `failed` or `skipped`, with a skip reason or a failure from Kanon's closed lists; and a duration. Each is a number, a time or a value from a closed list.
- **Never:** a URL, a channel, a host, the message's text, the hook's status body or a secret. A webhook URL is a credential, and any of the others would say whose row it is or quote the project the message describes.
- **Rule 5 for notify rows:** they are stored, and not published: nothing reads them until the follow-up reader that decision 19 names, which counts posted and failed by hook kind and release, Kanon's prebuilt hooks only, behind the three-adopter floor (plan 0011 §11).

**Amended 2026-10-20, by [plan 0013](../plans/0013-smoke-lifecycle.md)'s decisions 7 and 12: the smoke-check row, and the deploy row's reset stage.** A sixth row kind, the smoke-check row, describes one run of the smoke check outside a deploy, on one environment of the declared chain, and is written by the smoke workflow, which runs no model. The deploy row gains the reset hook's stage and duration. Rule 1's allowed list grows for both in `K-OBS-16`; the "never" list is unchanged.
- **Allowed:** the environment's role and position, as on the deploy row; the trigger, `schedule` or `workflow_dispatch`, and whether a reset hook ran; the outcome, the stage that failed and the refusal, from Kanon's closed lists; and durations. Each is a number, a time, a boolean or a value from a closed list.
- **Never:** the release's commit or tag, an environment's name, a URL, the reviewer, or anything the hooks print.
- **Rule 5 for smoke-check rows:** they are stored, from plan 0013's S3, and not published: no metric reads them, and a view of them is a later choice (plan 0013 §8).

**Amended 2026-10-26, by project [#1327](https://github.com/yedeya-labs/kanon/issues/1327)'s decisions 1, 4 and 5: what passes through the hosted status server.** ADR 0007 governs what Kanon stores; this records what it relays. No rule changes.
- **What it returns:** only numbers, titles, states, labels, check names and links, and the counts and times computed from them. It returns no comment or issue body. A tool's error may carry GitHub's own error message, such as "Not Found", which is returned to the person and never logged.
- **What it reads and doesn't return:** a body it reads to find a Kanon marker is held in memory only, in decision 5's per-person cache, and is never returned or logged. It is never used after 60 seconds, and it leaves memory the next time that container uses its cache, or when the container is discarded.
- **What it keeps:** nothing at rest: no token, no answer, no body. A person's GitHub tokens exist only inside the tokens it issues, encrypted under its KMS key.
- **What it logs:** one line per request, with the route or method, the tool, the outcome, the duration, the GitHub request count and the remaining rate limit, and never a token, a login or text read from GitHub (`[MCP-8]`, [`docs/status.md`](../status.md#what-the-server-logs)).

## Why

- **Telemetry must be safe to leave a project by construction, not by review.** Free text is how content leaks: a bail reason or an error message can quote code, and a file path reveals a project's structure. A fixed schema with reason codes closes that route.
- **Without usernames, telemetry holds no personal data.** That keeps hosted telemetry almost entirely outside GDPR. The one exception is an upstream finding sent with evidence: its text is written to Kanon's template, then scrubbed, and may rarely still contain personal data, so it is opted into on its own, and its install question says so. The EU region covers the rest, and suits Kanon's starting point.
- **QA data describes the adopter's application.** It is their content, not Kanon's. Keeping it in their account means Kanon never holds another team's code findings.
- **Opt-in protects trust.** An open-source tool that sends data home by default loses the trust it depends on. The cost is that the cross-adopter improvement work learns only from adopters who opt in, so the benefit of opting in has to be visible to them.
- **Thirteen months** is long enough for year-on-year comparisons, and no longer.

## Consequences

- **The roadmap's operational-store step splits the reference adopter's store.**
  - *Telemetry* moves to the Kanon account; the reference adopter opts in.
  - *QA data* stays in the reference adopter's account, but moves out of its staging stage.
  - Migrated telemetry rows are cleaned to meet rule 1: roles replace usernames, and codes replace free-text reasons.
- **The reason codes need defining** before the collector can validate rows. The reference adopter's existing bail and failure reasons are the starting list.
- **Every adopter needs cloud infrastructure** for its QA store, even if it never opts in to hosted telemetry. That is recorded in the principles chapter as part of what Kanon assumes about an adopter.
