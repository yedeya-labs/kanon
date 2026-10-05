# Agent identities

| Role | App slug | Contents | Issues | Pull requests | Workflows | Actions | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reviewer | `kanon-reviewer` | Read & write | Read & write | Read & write | No access | No access | None |
| Implementer | `kanon-implementer` | Read & write | Read & write | Read & write | Read & write | No access | Commit statuses: Read & write [^1] |
| Explorer | `kanon-explorer` | Read | Read & write | Read | No access | No access | None |

Every App also holds Metadata: Read (`K-ADOPT-8`).

[^1]: **Commit statuses: Read & write, broadened beyond the Implementer's row** (`K-AGENT-3`; plan 0005 §3.3, question 6; ADR 0013), granted and accepted on the installation by the Owner on 2026-10-05. It is for the `kanon/role: implementer` commit status only. The one step that mints with it is the `implementer-status` job each Implementer lane runs after its agent's job (`actions/implementer-status`), with a token narrowed to Commit statuses write and nothing else. No agent's token holds it (`tests/unit/app-token-permissions.test.ts`). Once the Implementer joins the Author App (L4), this is the Author's one broadened permission.
