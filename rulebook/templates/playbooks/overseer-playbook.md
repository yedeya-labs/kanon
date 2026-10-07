# Overseer playbook: Kanon's baseline

This is Kanon's baseline Overseer playbook. A lane reads it when the project installs the Overseer and keeps no `docs/qa/overseer-playbook.md` of its own (`K-LAYOUT-17`, plan 0005 §5.2), so it says only what holds on every project. Write the project's own, starting from a copy of this file; the lanes read the project's copy instead from then on.

Cite a rule by its id; don't restate it (`K-PRIN-2`). The Overseer may only propose or restrict (`K-AGENT-35`), and marks every proposal unverified (`K-SELF-10`).

## Liveness queries

Tell a run that died from one that skipped by reading full run records, never a summary, and reach a renamed workflow's earlier runs by its earlier file name (`K-SELF-12`). Each lane's caller is at its lane's file name (`K-LAYOUT-18`).

## Backlog dynamics

Measure the follow-up rate and the net open-issue rate, never set a target for them (`K-WORK-20`), and calibrate any threshold on the corpus it governs (`K-SELF-13`).

## Capability review

Review the agent runtime's releases since the ledger's watermark, record each disposition in the capability ledger (`K-SELF-16`), and file capability issues sparingly, saying that the watch ran (`K-SELF-17`).

A run the runtime-version trigger started (the prompt names its trigger, `pull_request_target`) exists because the runtime moved past the watermark, so the review is due whatever the week, and its audit is the next run's anchor like any other. On that trigger the QA store isn't read: its role trusts only the default branch's ref, and the event's token names the pull request. A `degraded` store there is expected, not a finding.
