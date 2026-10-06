# `kanon doctor`

`kanon doctor` says what a Kanon installation lacks, before a lane's first red run says it for you ([plan 0005](plans/0005-lean-installation.md) §5.5). Run it from your repository's checkout:

```bash
npx --yes --package github:yedeya-labs/kanon#<release> kanon doctor              # against the release your callers pin
npx --yes --package github:yedeya-labs/kanon#<release> kanon doctor --to v1.4.0  # before you merge the pin bump to v1.4.0
npx --yes --package github:yedeya-labs/kanon#<release> kanon doctor --json       # for a script or an agent
```

It reads the repository the way `kanon init` does, and compares it with the requirements file (`requirements.json`) that every release ships at its tag: the release your callers pin, or, with `--to`, the one you are moving to. It reads that file from Kanon's repository at the tag, so the doctor you run can be any release from v0.26.0 on.

**It writes nothing.** Every GitHub call it makes is a read, and it changes no file. `kanon init` fixes what can be fixed from the checkout; doctor says what is left, and how.

## What it checks

In the order it lists them, which is the order to fix them:

1. **The pin.** Every `yedeya-labs/kanon` reference under `.github/` names one exact release (`K-ADOPT-11`).
2. **The Apps** the lanes you call run as, and the optional Releaser when your release caller maps its secrets: a register row for each of their roles, the roles of one App sharing one slug and no two Apps sharing one (`K-LAYOUT-6`, plan 0005 §3.4), and each App's permissions exactly the release's grant for it, read from `GET /apps/<slug>`.
3. **The secrets,** by name: each lane's, and each App's two (plan 0005 §3.5). A per-role or retired App secret that nothing reads any more is listed as stale, without blocking.
4. **The declarations** each lane reads (`K-LAYOUT-17`): a file that has no default must exist, and the stack document must hold `## Gates` exactly once. A missing playbook is Kanon's baseline, and is a note, not a finding (plan 0005 §5.2). Also the project-setup hook and every input the lanes pass it, the hooks only some lanes call, and the workflows a lane reads by file name (`ci.yml`).
5. **The callers:** each at its lane's file name (`K-LAYOUT-18`), mapping exactly the lane's secrets by name, passing only inputs the lane declares, granting at least the lane's permissions, and with the name or run-name a lane asks of its caller. The `apps-check` caller maps each App's secrets, and nothing its release doesn't take.
6. **The labels** of the taxonomy (`K-WORK-12`). A lane creates a label it needs on first use (plan 0005 §5.3), so a missing one doesn't block.
7. **The ruleset** on the default branch (`K-ADOPT-1` step 8), where the plan has rulesets. A private repository on a plan without them is a note: nothing on the platform enforces review there (`K-ADOPT-3`).
8. **The id-token holders,** below.

`lane-check` checks the callers too, on every pull request, against the release they pin. What doctor adds is the release you are about to pin, and what only GitHub knows: the secrets, the Apps' permissions, the labels and the ruleset.

## The id-token holders

The QA store's role and the telemetry writer trust the default branch's ref, not an environment ([`docs/qa-store.md`](qa-store.md#who-can-reach-the-store), [`docs/telemetry.md`](telemetry.md#who-can-write)), so **every job on your default branch that holds `id-token: write` can assume them**, including your own jobs that hold it for another cloud. Kanon's guard holds Kanon's own workflows; yours are yours to check, and doctor lists them, counted as the guard counts them: a job's own grant, the workflow's when the job declares none, `permissions: write-all` at either level, and a job that calls a reusable workflow with such a grant.

- **A caller of one of Kanon's store-coupled lanes at the pinned release** is listed as Kanon's, and accepted: the grant reaches only the lane's store jobs, which Kanon's guard holds.
- **Any other holder** blocks until you either narrow its grant, or accept it under `## Choices` in the adoption record (`K-LAYOUT-10`), one bullet per job, naming the workflow file and the job's key, with the reason it holds the grant:

  ```markdown
  - **Accepted id-token holder:** `deploy.yml` job `deploy` (assumes the production deploy role)
  ```

  An acceptance in another shape, outside `## Choices` or written twice is malformed and blocks. One whose job no longer holds the grant is listed as stale, without blocking.

Doctor counts the workflows of the checkout it runs from. Run it on your default branch for the count the roles see; it says so when you don't.

## Exit codes

The same in both outputs.

| Code | Status | Meaning |
|---|---|---|
| 0 | `healthy` | Every check ran, and nothing blocking was found. |
| 1 | `findings` | At least one blocking finding, an id-token holder neither accepted nor narrowed included. |
| 2 | `usage` | A usage error: an unknown argument, or `--to` that is not an exact release. |
| 3 | `error` | It could not run: no checkout, the repository or a release's requirements file could not be read, or nothing pins Kanon. |
| 4 | `incomplete` | Nothing blocking was found, but at least one check could not run (the token can't list the secrets, say), so health can't be claimed. |

## The JSON output

`--json` prints one JSON document on standard output, and nothing else there. **Its shape is a contract** ([ADR 0014](decisions/0014-adopter-audiences.md), decision 2): the agent skills that wrap `kanon init` and `kanon doctor`, and any integrator, build on it. It follows the convention every `kanon` command's JSON shares ([`docs/cli-json.md`](cli-json.md): the opening fields, the error document, the finding's shape), and is versioned by its `schema` field, `kanon-doctor/v1`:

- **Within a version,** fields and finding ids may be added, and a consumer ignores what it doesn't know. Nothing is removed, renamed, retyped or given another meaning.
- **Anything else is a new version,** `kanon-doctor/v2`, shipped in a breaking release and named in its release notes.

`tests/unit/kanon-doctor.test.ts` holds the document's fields, the finding ids and the exit codes to the tables below.

### The document

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `kanon-doctor/v1` |
| `kanon` | string | The release of the doctor that ran, `vX.Y.Z`. |
| `repository` | string | `<owner>/<repo>`. |
| `checkout` | object | `branch` (string or null), `defaultBranch` (string) and `head` (the commit, or null) of the checkout it read. |
| `token` | object | `source` (`GH_TOKEN`, `GITHUB_TOKEN` or `gh`) and `login` (string or null): whose token `gh` used. Never the token. |
| `releases` | object | `pins` (every ref the references pin, oldest first), `pinned` (the callers' release), `to` (the `--to` release, or null) and `checked` (the release whose requirements it compared against). |
| `checking` | string | The checked release, in words. |
| `status` | string | `healthy`, `findings` or `incomplete`. |
| `exitCode` | number | The exit code, 0, 1 or 4. |
| `lanes` | array | The lanes the repository calls that the checked release ships, by file name without `.yml`. |
| `apps` | array | Each App the lanes run as: `identity` (`author`, `judge`, `releaser`, or a role before plan 0005's L4) and `slug` (the register's, or null). |
| `findings` | array | What is missing or stale, in the order to fix it. |
| `idTokenHolders` | array | Every job of the checkout's workflows that holds `id-token: write`. |
| `unchecked` | array | Each check that could not run: `check`, `subject` and `reason`. |
| `notes` | array | Strings: defaults taken and facts that block nothing. |

When it can't run, or on a usage error with `--json`, the document is `{ "schema", "kanon", "status": "error", "exitCode", "error" }`, with the exit code 2 or 3 and `error` saying why.

### A finding

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Its stable id, from the table below. |
| `category` | string | `pin`, `app`, `secret`, `declaration`, `caller`, `label`, `ruleset` or `id-token`, in the order they are listed. |
| `blocking` | boolean | Whether it makes the exit code 1. |
| `subject` | string | What it is about: a file, an App slug, the repository, a branch, or `<workflow file>#<job>`. |
| `message` | string | What is missing or stale, in a sentence. |
| `fix` | object | The exact fix. |

### A fix

| Field | Type | Meaning |
|---|---|---|
| `text` | string | What to do, in a sentence. |
| `commands` | array | Strings: the commands to run, or the lines to add to the file the finding names, in order. Possibly empty. |
| `url` | string or null | The page to do it on, such as an App's permissions page. |

### An id-token holder

| Field | Type | Meaning |
|---|---|---|
| `workflow` | string | The workflow file, from the repository's root. |
| `job` | string | The job's key. |
| `grant` | string | `job` when the job's own `permissions:` grants it, `workflow` when it inherits the workflow's. |
| `how` | string | `id-token` for `id-token: write`, `write-all` for `permissions: write-all`. |
| `calls` | string or null | The reusable workflow the job calls and passes the grant to. |
| `status` | string | `kanon-lane` (a store-coupled Kanon lane at the pinned release), `accepted` (by the adoption record) or `unaccepted`. |
| `reason` | string or null | The adoption record's reason, when accepted there. |

### The finding ids

| Id | Category | Blocks | Meaning |
|---|---|---|---|
| `pin.mixed` | `pin` | yes | Kanon's references pin more than one release, or a ref that is not an exact release. |
| `register.missing-row` | `app` | yes | The App register has no row for a role an App's lanes read their slug from. |
| `register.split-slug` | `app` | yes | An App's roles name more than one slug. |
| `register.shared-slug` | `app` | yes | Two Apps name one slug. |
| `app.permission-missing` | `app` | yes | An App holds less than the release grants it. |
| `app.permission-extra` | `app` | yes | An App holds more than the release grants it, which `apps-check` fails. |
| `secret.missing` | `secret` | yes | A secret a lane or an App needs is not set. |
| `secret.stale` | `secret` | no | An App secret nothing at the checked release reads. |
| `declaration.missing` | `declaration` | yes | A project document a lane reads, with no default, is missing. |
| `declaration.section-missing` | `declaration` | yes | A section with no default is missing, or written more than once. |
| `declaration.malformed` | `declaration` | yes | An id-token holder's acceptance in the adoption record is malformed. |
| `hook.missing` | `declaration` | yes | The project-setup hook, or a hook a lane calls, is missing. |
| `hook.input-missing` | `declaration` | yes | The project-setup hook does not declare an input the lanes pass it. |
| `workflow.missing` | `declaration` | yes | A workflow a lane reads by file name is missing. |
| `caller.lane-removed` | `caller` | yes | A caller calls a lane the checked release does not ship. |
| `caller.misplaced` | `caller` | yes | A caller is not at its lane's file name. |
| `caller.secrets-inherited` | `caller` | yes | A caller maps no secrets by name, such as `secrets: inherit`. |
| `caller.secret-missing` | `caller` | yes | A caller does not map a secret its lane takes. |
| `caller.secret-stale` | `caller` | yes | A caller maps a secret its lane does not take. |
| `caller.input-stale` | `caller` | yes | A caller passes an input its lane does not declare. |
| `caller.grant-missing` | `caller` | yes | A caller grants less than its lane needs, or nothing explicitly. |
| `caller.name` | `caller` | yes | A caller's name is not the one its lane asks for. |
| `caller.run-name` | `caller` | yes | A caller's run-name does not end as its lane asks. |
| `apps-check.secret-missing` | `caller` | yes | The `apps-check` caller does not map an App's secrets. |
| `apps-check.secret-stale` | `caller` | yes | The `apps-check` caller maps a secret its release does not take. |
| `label.missing` | `label` | no | Labels of the taxonomy are missing. |
| `ruleset.missing` | `ruleset` | yes | No active ruleset covers the default branch. |
| `ruleset.rule-missing` | `ruleset` | yes | The default branch's ruleset lacks a rule of `K-ADOPT-1` step 8. |
| `id-token.unaccepted` | `id-token` | yes | A job holds `id-token: write`, and is neither Kanon's lane nor accepted. |
| `id-token.stale-acceptance` | `id-token` | no | The adoption record accepts a job that no longer holds the grant. |
