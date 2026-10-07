# Explorer playbook: Kanon

Kanon runs the Explorer in one mode: the code audit, on Kanon's own code ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), plan 0004 step 11a), through `code-audit.yml`. It runs no runtime sweep, because Kanon has no app to sweep. The Reviewer also rates each follow-up it files with the rubric below, and the review lane's prompt looks for it here.

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

## Code-reading mode

What the code audit looks for on Kanon. The lane's prompt sets the bar (an objective contradiction, cited `file:line`, deduped against open issues) and the report protocol; this section says what those mean here. Kanon's product is its rules and the machinery that holds a project to them, so most of its contradictions are between two of the areas its stack document lists under `## Code areas`: a rule, a doc, a guard, or a script.

**Kanon has a QA store, since 2026-10-06** (the [adoption record](adoption.md)'s `## Choices`). Choose areas from the export's code-reading ledger, as the lane's prompt says. Until the store holds a few audits, its ledger covers little, so fill the rest from `git log`: prefer what changed since the last audit issue you can find, then what no audit issue has cited. When the export says the store is absent or degraded, say so in your final message, and choose from `git log` alone.

**What counts, by the prompt's four kinds:**

| The prompt's kind | On Kanon |
|---|---|
| Consumer contradiction | A rule's "Enforced by" line names a mechanism, file or test that doesn't exist, or that doesn't check what the rule says. A doc or a rule names a script, flag, input, output, secret or path that the code doesn't have. A lane input or block output that nothing reads. A rule id cited that no rule has. |
| Security anti-pattern | Untrusted text (an issue, a PR body, a branch name) interpolated into a `run:` line. `secrets: inherit`. A token broader than its step's use (`K-AGENT-46`). A pull request's own code running with a write token or a secret. A Kanon file reaching another through `./` or a second version instead of `$/`, outside the self-pinning test's exemptions. |
| Structural-contract violation | A guard that passes whatever it is given, or that reads less than the rule it holds (a fail-open guard). Two copies of one fact that disagree: a table and the file a test says is its twin, a caller and the lane contract in `docs/lanes.md`, the roles table and `agent-permissions.json`. |
| Promoted-spec contradiction | Kanon has no `docs/qa/specs/`. Its rulebook stands in: code, a test or a doc that contradicts a rule's text, rather than one that merely doesn't enforce it yet. |

**What doesn't count:**

- **A rule Kanon doesn't yet enforce on itself,** when the [adoption record](adoption.md) says so: its mechanism list marks it "not yet installed". That is a declared state, not a contradiction. The record claiming a mechanism is installed when it isn't is one.
- **A step a plan hasn't reached yet,** when the plan's table says it is open.
- **Whether a rule is right.** A disagreement with a rule is an ADR, not a bug: file a `spec-delta` at most.
- **Wording, style, or a doc that is unclear but not wrong.**

**Filing on a public repository.** Every issue you file is public. Never name the reference adopter, its people or its product: write "the reference adopter", and cite its issues only as `RA-N`, as Kanon's files do. Quote no secret, token or key, even a revoked one. Rate severity with the rubric above, and milestone a bug to Product Backlog.
