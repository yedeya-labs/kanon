# 0012. Tests are recognised by a fixed convention per language

- **Status:** accepted
- **Date:** 2026-10-03
- **Decided in:** [#20](https://github.com/yedeya-labs/kanon/issues/20), part of [#15](https://github.com/yedeya-labs/kanon/issues/15)

## Context

Several of Kanon's tools must know three things about an adopter's tests:
- **which files are tests**;
- **what a test is called**, because a spec id in a test's title is the citation that locks a clause (`K-SPEC-6`, `K-LAYOUT-4`);
- **how to run one test file**, because acceptance criteria are verified by running the tests that cite them (`K-PROJ-11`).

Each of these answers came from the reference adopter: TypeScript files under `tests/` and `e2e/`, titles written `it('[ORD-1] …')`, and runs through `npx vitest` and `npx playwright`. On any other stack the tools read nothing, and reported nothing. A Python project with a test citing `[ORD-1]` reported that clause as Bare. Kanon is stack-neutral ([#15](https://github.com/yedeya-labs/kanon/issues/15)), so these answers must not be JavaScript's by accident.

## Decision

1. **One fixed row per language, in [`scripts/lib/test-conventions.mjs`](../../scripts/lib/test-conventions.mjs).** It is a table in Kanon, not a setting ([ADR 0002](0002-standardise-dont-parameterise.md)). Each row follows its language's standard runner, and adds nothing Kanon invents:

   | Language | Test files | Where the spec id goes | One file is run with |
   |---|---|---|---|
   | JavaScript and TypeScript | every `.ts`, `.tsx`, `.mjs` or `.js` file under `tests/` or `e2e/` | the title argument: `it('[ORD-1] …')` | `node_modules/.bin/vitest` for `tests/`, `node_modules/.bin/playwright` for `e2e/` |
   | Python | `test_*.py` or `*_test.py`, anywhere (pytest's discovery) | the first line of the test function's docstring: `"""[ORD-1] …"""` | `python -m pytest <file> --junitxml=…` |
   | Go | `*_test.go`, anywhere | the name of a subtest: `t.Run("[ORD-1] …", …)` | `go test -json -run '^(TestA\|TestB)$' ./<dir>`, the file's own test functions |

   Python and Go need a rule of their own, because a test there is named by an identifier, and an identifier can't hold `[ORD-1]`. The docstring's summary line and the subtest's name are what each language's readers and runners already show as a test's description.

2. **No declaration and no detection: the file picks its row.** A test file's extension picks the row, and that row's pattern decides whether the file is a test. There is no "the adopter's language" anywhere in Kanon:
   - **A repository with two languages needs nothing more.** A Python service with a TypeScript front end has both rows, each for its own files. A declared language would have to choose one of them, and a list of languages is a setting.
   - **Detection by marker files** (`pyproject.toml`, `go.mod`, `package.json`) would add a second answer that can disagree with the files themselves. For example, a Go repository with a `package.json` for its linting would be detected as JavaScript.
   - **Reusing the release type (#17) doesn't fit.** The release type says where the version lives, not what the tests are. Its neutral default, `simple`, names no language at all.

3. **A language not in the table is never read.** Its tests cite nothing as far as Kanon knows, so its clauses are Bare and its acceptance criteria are `unverifiable`. That reading is fail-safe: it says "nothing was checked", never "passed". The remedy is a new row, not a setting.

4. **Tests run through the adopter's own toolchain, never through `npx`.** The lane's project-setup hook installs the toolchain (`install: "true"`). The table names a runner as the hook installs it: the project's own Vitest under `node_modules/.bin`, the `python` that `setup-python` put on the PATH, or `go`. `npx` fetches whatever it can't find, so it could run a tool the adopter never chose. With the table, a missing runner reports `not-run`.

5. **Each runner's report is read for test results, not for its exit code.** The rule `verify-acs` already followed for Vitest also holds for the new rows. A file whose tests ran and passed is `passed`. A file whose tests failed, or that failed to import or compile, is `failed`. A run that produced no test result is `not-run`. Python's report is pytest's JUnit XML, and Go's is the event stream from `go test -json`. Both are built into the runner, so the adopter installs no plug-in.

## Adding a language

Add a row to the table, with:
- its extensions and its test-file rule, as its standard runner discovers files;
- a title reader, and a reader that blanks string literals but keeps comments (fixture data is never a citation);
- its comment syntax, for `citation-shift`;
- a runner, with the command that runs one file and the function that reads its report.

Add tests for each in `tests/library/test-conventions.test.ts`. Nothing in the tools that read the table changes. A language earns a row when an adopter, or a project inside Kanon's target, uses it.

## Consequences

- **`spec-coverage` reads every row.** It finds test files through git, tracked and untracked but not ignored, so a virtualenv or a vendored module is never read as the project's tests. A spec's back-link to a test file is recognised in any language in the table.
- **`citation-shift` reads `#` comments in Python and `//` and `/* */` comments in Go.** A comment can cite any file a doc can. A Python docstring is a string, so `citation-shift` doesn't read it, just as it doesn't read a JavaScript string.
- **`doc-path-guard` reads Python and Go source** as it reads JavaScript.
- **The Python fixture adopter** (`tests/fixtures/python-adopter`) carries a pytest test whose docstring cites `[ORD-1]` and a `#` comment with a coordinate. `tests/unit/stack-neutral.test.ts` shows `spec-coverage` and `citation-shift` working on it with only `node` and `git` on the PATH, and red on a one-line break.
- **The red-test check** (`K-MERGE-13`), when Kanon installs it, takes "which files are tests" from the same table.

## Not decided here

- **The JavaScript row's test runners are still Vitest and Playwright.** A JavaScript project on Jest or `node:test` is outside the row today. Making the JavaScript row choose between runners would be the first row with two runners, and that needs its own case.
- **Where `citation-shift` looks for code comments** is still `src/`, `scripts/`, `tests/` and `e2e/`. A Go project's `internal/` and `cmd/`, or a Python package at the repository's root, aren't read yet.
