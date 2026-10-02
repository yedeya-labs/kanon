# Explorer playbook: Kanon

Kanon runs no Explorer. This file exists because the Reviewer rates each follow-up it files with the rubric below, and the review lane's prompt looks for it here.

## Severity rubric

The rule, and the meaning of each label, is `K-WORK-9` in [rulebook/01-work-items.md](../../rulebook/01-work-items.md). This section doesn't redefine it. It says what each level looks like on Kanon, whose product is the pipeline other repositories run. Rate the reachable impact, by evidence from the diff and its callers, not by the title's shape.

| Severity | `K-WORK-9` | On Kanon |
|---|---|---|
| `sev:critical` | Data loss, a security or isolation breach, or an outage. | A lane or action that can destroy an adopter's work, such as a push over a branch or a deleted issue. A stranger's text acting as an instruction, a secret or write token a fork can reach, or a PR choosing the rules it is judged by. A release that stops a lane on every adopter. |
| `sev:high` | A core flow is broken and there is no workaround. | A lane, check or installer step that fails, or posts no verdict, for a whole class of PRs or adopters. A required check that passes whatever it is given. |
| `sev:medium` | Degraded, but a workaround exists. | A lane that needs a re-run, a manual step, or a documented bypass to finish. A guard that misses some cases but still fails on the one it was written for. |
| `sev:low` | Cosmetic. | Wording, log or summary text, or a doc that is unclear but not wrong. |

**Pinning the previous release is not a workaround.** It rolls the release back rather than working around the defect, so it doesn't lower a severity (ADR 0011 names it as the remedy for a broken release).

Never inflate a severity to reach a gate (`K-WORK-10`).
