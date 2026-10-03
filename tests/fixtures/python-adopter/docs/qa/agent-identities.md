# Agent identities

The Python fixture adopter's App register (`K-LAYOUT-6`), for the pipeline library's tests. One App
per role, with example slugs.

| Role | App slug | Contents | Issues | Pull requests | Workflows |
|---|---|---|---|---|---|
| Explorer | `example-explorer` | Read | Read & write | Read | No access |
| Implementer | `example-implementer` | Read & write | Read & write | Read & write | Read & write |
| Reviewer | `example-reviewer` | Read | Read & write | Read & write | No access |
| Overseer | `example-overseer` | Read | Read & write | Read | No access |
| Lead | **`example-lead`** | Read & write | Read & write | Read & write | No access |
| Merger | **`example-merger`** | Read & write | Read & write | Read & write | No access |
| Intake | `example-intake` | No access | Read & write | No access | No access |
| Releaser | `example-releaser` | Read & write | Read & write | Read & write | No access |
