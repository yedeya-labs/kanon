# The `kanon` command's JSON output

`kanon doctor` and `kanon init` are scriptable ([ADR 0014](decisions/0014-adopter-audiences.md), decision 2): beside the prose a person reads, each prints one JSON document with `--json`, for the agent skills that wrap them and for integrators. This page is the convention every command's document follows, so a consumer that reads one reads the others. Each command's own page lists its fields: [`kanon doctor`](doctor.md#the-json-output) and [`kanon init`](init.md#the-json-output).

## The convention

- **One document, on standard output, and nothing else there.** Prose, progress and warnings go to standard error, or nowhere. A command that asks questions doesn't, with `--json`: it takes each answer from its flag or its documented default.
- **The same result and exit code as the prose.** `--json` changes how the result is printed, never what it is.
- **Every document opens with the same fields:**

  | Field | Type | Meaning |
  |---|---|---|
  | `schema` | string | `kanon-<command>/v<N>`, such as `kanon-doctor/v1`: which contract the document follows. |
  | `kanon` | string | The release of the command that ran, `vX.Y.Z`. |
  | `status` | string | The outcome in one word; `error` when the command could not run. Each command lists its values. |
  | `exitCode` | number | The exit code the process exits with. |

- **When the command can't run,** or on a usage error, the document is `{ "schema", "kanon", "status": "error", "exitCode", "error" }`, `error` a sentence saying why.
- **A finding,** something a person or a program has to act on, has the same shape in every command: `id` (stable, `<area>.<what>`, lowercase with hyphens), `category`, `blocking` (boolean), `subject` (what it is about: a file, an App slug, the repository), `message` (a sentence) and `fix`, which is `{ "text", "commands", "url" }`: a sentence, the commands to run or lines to add in order (possibly none), and the page to do it on, or null. Each command lists its ids, in a table its test holds to the code.
- **Field names are camelCase; the order of keys means nothing;** arrays are in the order the prose lists them.

## Versioning

The `schema` field versions each command's contract on its own:

- **Within a version,** fields, statuses and finding ids may be added, and a consumer ignores what it doesn't know.
- **Anything else is a new version:** removing, renaming or retyping a field, giving a field, status, id or exit code another meaning. It ships in a breaking release and is named in its release notes.
