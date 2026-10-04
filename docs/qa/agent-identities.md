# Agent identities

| Role | App slug | Contents | Issues | Pull requests | Workflows | Actions | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reviewer | `kanon-reviewer` | Read & write | Read & write | Read & write | No access | No access | None |
| Implementer | `kanon-implementer` | Read & write | Read & write | Read & write | Read & write | No access | None |

Every App also holds Metadata: Read (`K-ADOPT-8`).

**The Implementer's App is not yet created.** Its row holds the slug `kanon apps` will ask GitHub for, so that the Implementer's lanes and `lane-check` can read the role now ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), stage 2). Until the Owner creates it, its two secrets are unset: an `agent:implement` label fails at the token mint, by name, before any model run, and every other event skips. `kanon apps --roles implementer` rewrites this row with the slug GitHub gives; delete this paragraph in the same commit.
