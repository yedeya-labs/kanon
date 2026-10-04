# Test database

Kanon's test-database declaration (`K-LAYOUT-16`). Kanon is a library of scripts, actions and workflows, with no app and no database, so its lanes start none.

**Test database:** `none`

No file would mean the same. The file is here so that the Implementer's lanes, which run Kanon's tests ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)), read the answer rather than infer it from an absence. Kanon's [stack document](stack.md) says the same under `## Schema changes`.
