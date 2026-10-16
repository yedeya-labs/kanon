# Agent identities

| Role | App slug | Contents | Issues | Pull requests | Workflows | Actions | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reviewer | `yedeya-labs-judge` | Read & write | Read & write | Read & write | No access | Read & write | Checks: Read, Commit statuses: Read |
| Implementer | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write [^1] |
| Explorer | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write |
| Lead | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write |
| Overseer | `yedeya-labs-author` | Read & write | Read & write | Read & write | Read & write | Read | Commit statuses: Read & write |
| Merger | `yedeya-labs-judge` | Read & write | Read & write | Read & write | No access | Read & write | Checks: Read, Commit statuses: Read |
| Releaser | `yedeya-labs-releaser` | Read & write | No access | Read & write | Read & write | No access | None |
| Other App | `kanon-e2e-reporter` | No access | No access | No access | No access | No access | Checks: Read & write [^2] |

Every App also holds Metadata: Read (`K-ADOPT-8`).

[^1]: **Commit statuses: Read & write, broadened beyond the Implementer's row** (`K-AGENT-3`; plan 0005 §3.3, question 6; ADR 0013), granted and accepted on the installation by the Owner on 2026-10-05, on `kanon-implementer`; since plan 0005's L5 (2026-10-06) the Author App, `yedeya-labs-author`, holds it from its manifest. It is for the `kanon/role: implementer` commit status only. The one step that mints with it is the `implementer-status` job each Implementer lane runs after its agent's job (`actions/implementer-status`), with a token narrowed to Commit statuses write and nothing else. No agent's token holds it (`tests/unit/app-token-permissions.test.ts`). It is the Author's one broadened permission, so its other roles' rows show it too.

[^2]: **The end-to-end Reporter, an App that isn't an agent** (`K-AGENT-3`, `K-LAYOUT-6`; plan 0012 decision 18, [#967](https://github.com/yedeya-labs/kanon/issues/967)). `kanon-e2e-reporter`, created by the Owner (App id 5349415), owned by `yedeya-labs`, private, and installed on this repository only, with one permission, Checks: Read & write. It posts the `kanon-e2e` check run, the end-to-end harness's verdict on a candidate's commit, which the promotion reads. No lane runs as it, it authors no commit, and its key belongs in the harness repository's `e2e-report` environment (plan 0012 §5.2), never in this repository's secrets. `kanon apps` doesn't write this row: it is written by hand (`docs/apps.md`, "Kanon's three Apps only").
