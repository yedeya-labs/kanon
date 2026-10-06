# Agent identities

The Python fixture adopter's App register (`K-LAYOUT-6`), for the pipeline library's tests. One App
per role, with example slugs.

| Role | App slug | Contents | Issues | Pull requests | Workflows |
|---|---|---|---|---|---|
| Explorer | `example-author` | Read | Read & write | Read | No access |
| Implementer | `example-author` | Read & write | Read & write | Read & write | Read & write |
| Reviewer | `example-judge` | Read | Read & write | Read & write | No access |
| Overseer | `example-author` | Read | Read & write | Read | No access |
| Lead | **`example-author`** | Read & write | Read & write | Read & write | No access |
| Merger | **`example-judge`** | Read & write | Read & write | Read & write | No access |
| Intake | `example-intake` | No access | Read & write | No access | No access |
| Releaser | `example-releaser` | Read & write | Read & write | Read & write | No access |
