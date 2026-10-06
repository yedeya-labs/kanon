# Agent identities

| Role | App slug | Contents | Issues | Pull requests | Workflows | Actions | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reviewer | `yedeya-labs-judge` | Read & write | Read & write | Read & write | No access | Read & write | Checks: Read, Commit statuses: Read |
| Implementer | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write [^1] |
| Explorer | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write |
| Lead | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write |
| Overseer | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write |
| Merger | `yedeya-labs-judge` | Read & write | Read & write | Read & write | No access | Read & write | Checks: Read, Commit statuses: Read |
| Releaser | `yedeya-labs-releaser` | Read & write | No access | Read & write | No access | No access | None |

Every App also holds Metadata: Read (`K-ADOPT-8`).

[^1]: **Commit statuses: Read & write, broadened beyond the Implementer's row** (`K-AGENT-3`; plan 0005 §3.3, question 6; ADR 0013), granted and accepted on the installation by the Owner on 2026-10-05, on `kanon-implementer`; since plan 0005's L5 (2026-10-06) the Author App, `yedeya-labs-author`, holds it from its manifest. It is for the `kanon/role: implementer` commit status only. The one step that mints with it is the `implementer-status` job each Implementer lane runs after its agent's job (`actions/implementer-status`), with a token narrowed to Commit statuses write and nothing else. No agent's token holds it (`tests/unit/app-token-permissions.test.ts`). It is the Author's one broadened permission, so its other roles' rows show it too.
