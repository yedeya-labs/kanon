# `kanon doctor`

`kanon doctor` says what a Kanon installation lacks, before a lane's first red run says it for you ([plan 0005](plans/0005-lean-installation.md) §5.5). Run it from your repository's checkout, through `npx` as the [README](../README.md) runs `kanon init`:

```bash
kanon doctor              # against the release your callers pin
kanon doctor --to v1.4.0  # before you merge the pin bump to v1.4.0
kanon doctor --json       # for a script or an agent
```

It reads the repository the way `kanon init` does, and compares it with the requirements file (`requirements.json`) that every release ships at its tag: the release your callers pin, or, with `--to`, the one you are moving to. It reads that file from Kanon's repository at the tag, so the release it checks against, pinned or `--to`, can be any from v0.28.0 on, the first that ships one.

**It writes nothing.** Every GitHub call it makes is a read, and it changes no file. `kanon init` fixes what can be fixed from the checkout; doctor says what is left, and how.

## What it checks

In the order it lists them, which is the order to fix them:

1. **The pin.** Every `yedeya-labs/kanon` reference under `.github/` names one exact release (`K-ADOPT-11`). Where the project declares the [kanon plugin](skills.md#declare-it-in-the-repository) in `.claude/settings.json`, also the plugin's: the `ref` of the marketplace whose source is Kanon's repository must be the release doctor checks against, because the skills run `kanon` from the release they ship in, and install that release (`plugin.version-mismatch`, [#376](https://github.com/yedeya-labs/kanon/issues/376)). It doesn't block, because no lane reads the plugin, and the two move at different times: the upgrade skill moves the `ref` with the pins, Dependabot moves the pins alone, and in Kanon's own repository release-please moves the `ref` ahead of them. A project that doesn't declare it gets a note; a settings file that isn't a JSON object makes the check `unchecked`.
2. **The Apps** the lanes you call run as, and the optional Releaser when your release caller maps its secrets, whether it reaches `release.yml` by Kanon's pin, `$/` or a local path ([#441](https://github.com/yedeya-labs/kanon/issues/441)): a register row for each of their roles, the roles of one App sharing one slug and no two Apps sharing one (`K-LAYOUT-6`, plan 0005 §3.4), and each App's permissions at least the release's grant for it, read from `GET /apps/<slug>`, or, for a private App, from the latest `apps-check` run on the default branch ([below](#the-token-it-needs)). An App that holds more is listed, without blocking: each lane narrows its token to what it uses (`K-AGENT-46`). **`apps-check` still fails such an App,** because it requires the App's permissions to be exactly its own; the two differ on purpose (the Owner's decision 3 below).
   It also lists, without blocking, **an App left installed that no lane uses any more** (`app.unused`): one the App register's git history on the checkout once named, that its current copy doesn't, and that the owner still has an installation of, such as a per-role App left from before the two-App move (decided by the Owner, 2026-10-06). Delete it once the Apps that replaced it have run green for a week, and not while another repository's register still names it. If the token can't list the owner's installations, this check is `unchecked`, and says which token can.
3. **The secrets,** by name: each lane's, and each App's two (plan 0005 §3.5). **A secret of the checked release's that any workflow maps is needed too,** whatever its job calls: each of its Apps' two, the Releaser's when a release caller reaching `release.yml` by a local path or `$/` maps them, and a lane's ([#415](https://github.com/yedeya-labs/kanon/issues/415)). A missing one is `secret.missing`, naming the workflows that map it, and the callers of a lane that takes it but don't map it yet. For an App's secrets, its fix is two `kanon apps` lines, the person's to run ([#420](https://github.com/yedeya-labs/kanon/issues/420)): `--preflight` first, which checks the token and creates nothing, then the line that creates the App, or, when the register already names its slug, stores a new key for it. A secret that isn't Kanon's, or a per-role App's the checked release no longer has, is not doctor's to ask for. Nor is one a reusable workflow names only because its `on.workflow_call.secrets` declares it takes it, as a lane's own definition does: that reads what its caller passes, and the caller is what maps it. A per-role or retired App secret that nothing reads any more is listed as stale, without blocking (`secret.stale`). A secret counts as read when an App in use reads it, or when a workflow under `.github/workflows/` names it as `secrets.<NAME>` or `secrets['<NAME>']` anywhere outside its `on:`: in a job's `secrets:`, `env:`, `with:` or steps, or the workflow's own `env:`, whatever the job calls: a Kanon lane, the release workflow by its pin, a local path or `$/`, or nothing ([#414](https://github.com/yedeya-labs/kanon/issues/414)). A reusable workflow's own `on.workflow_call.secrets` declares what it takes and reads nothing. While a job passes on `secrets: inherit`, or a workflow can't be read, doctor can't tell what is read, so it lists no secret as stale and says why in a note. The same holds while a workflow reads secrets by a computed name or as a whole, such as `secrets[format('{0}_APP_ID', matrix.app.secret)]` or `toJSON(secrets)`, in an expression (`${{ }}` or an `if:`, never a script's own text), since that read can reach any secret ([#440](https://github.com/yedeya-labs/kanon/issues/440)). A workflow that runs only on `workflow_call` is the exception: its `secrets` holds only what its caller passes, which the caller names or inherits. Like the id-token holders, the workflows counted are the checkout's.
4. **The declarations** each lane reads (`K-LAYOUT-17`): a file that has no default must exist, and the stack document must hold `## Gates` exactly once. A missing playbook is Kanon's baseline, and is a note, not a finding (plan 0005 §5.2). Also the project-setup hook and every input the lanes pass it, the hooks only some lanes call, and the workflows a lane reads by file name (`ci.yml`).
5. **The callers:** each at its lane's file name (`K-LAYOUT-18`), mapping exactly the lane's secrets by name, passing only inputs the lane declares, granting at least the lane's permissions, and with the name or run-name a lane asks of its caller. The `apps-check` caller maps each App's secrets, and nothing its release doesn't take. A caller of Kanon's telemetry collector, which `kanon init --telemetry` writes, needs the two repository variables the Kanon operator gives; while either is unset it sends nothing, which doctor lists without blocking (`telemetry.unconfigured`), and, when the token can't list the variables, says in a note. The QA store's two secrets, `QA_STORE_ROLE_ARN` and `QA_STORE_BUCKET`, are the only secrets a caller may leave out: doctor asks for them only once the repository has a store hook, and lists a store-coupled caller that doesn't map them (`qa-store.unmapped`) and a repository that still holds them as variables (`qa-store.variables`), neither blocking. Since the release after v0.34.1 the lanes pass the hook no variables ([#479](https://github.com/yedeya-labs/kanon/issues/479)), so a store secret that only a variable holds is `secret.missing`, which blocks.
6. **The labels** of the taxonomy (`K-WORK-12`). A lane creates a label it needs on first use (plan 0005 §5.3), so a missing one doesn't block.
7. **The ruleset** on the default branch (`K-ADOPT-1` step 8), where the plan has rulesets. A private repository on a plan without them is a note: nothing on the platform enforces review there (`K-ADOPT-3`). **Before it asks you to require the status check `Lane check`, a job on the default branch must report it** ([#418](https://github.com/yedeya-labs/kanon/issues/418)): a job of a workflow that runs on `pull_request`, whose name, or its key when it has none, is exactly `Lane check`, and that neither calls a reusable workflow nor runs a matrix, since those report their checks under longer names. A step of another job reports nothing under that name. **The workflow must run on every pull request into the default branch** ([#446](https://github.com/yedeya-labs/kanon/issues/446)): GitHub never reports the check of a run its trigger skips, so a pull request it skips waits on a required check. A `paths` or `paths-ignore` filter skips some, and so does a `branches` filter that doesn't admit the default branch, a `branches-ignore` filter that matches it, and a `types` list without each of `opened`, `synchronize` and `reopened`. **Where a ruleset on the default branch has a merge queue, the workflow must run on `merge_group` too** ([#459](https://github.com/yedeya-labs/kanon/issues/459)): the queue waits for each required check on its own `merge_group` run, which a pull request's run doesn't count for, so a queued merge whose workflow has no `merge_group` trigger never gets the check. A `merge_group` trigger's `branches` or `branches-ignore` filter that skips the default branch, or a `types` list without `checks_requested`, skips it the same way. Doctor reads the default branch's workflows from GitHub, not from the checkout, because a job only a branch adds reports its check on that branch's pull request and on no other: a required check that nothing on the default branch reports blocks every other pull request, approved and green, until the branch merges. So when no job there reports it, doctor asks for the job first (`ruleset.check-unreported`), and for the rule (`ruleset.rule-missing`) only once the job is on the default branch; it reports a ruleset that already requires such a check too. If the token can't read the default branch's workflows, the check is `unchecked`, and doctor doesn't ask for the rule. Where your release caller maps the Releaser, also its bypass (`K-MERGE-8`, [#49](https://github.com/yedeya-labs/kanon/issues/49)): the Releaser App must be a bypass actor of each ruleset on the default branch, and the only one. Another actor's bypass, such as the admin role's, is asked off only against a release whose `dco` check passes the release PR the Releaser opens (its requirements file's `release.dcoExemptsReleaser`, [#337](https://github.com/yedeya-labs/kanon/issues/337)); against an earlier one it is a note, because that bypass is still what merges the release PR. GitHub shows a ruleset's bypass list only to someone who can edit it, so with another token this check is `unchecked`.
8. **The id-token holders,** below.

Then it sets aside each finding the adoption record waives ([below](#waiving-a-finding)).

`lane-check` checks the callers too, on every pull request, against the release they pin. What doctor adds is the release you are about to pin, and what only GitHub knows: the secrets, the Apps' permissions, the labels and the ruleset.

## The token it needs

Doctor reads GitHub through `gh`, with `GH_TOKEN`, `GITHUB_TOKEN` or `gh`'s own login, in that order. A check its token can't run is listed under `unchecked`, with what would let it run, and the exit code is 4, never 0. A fine-grained token needs these permissions on the repository, a classic one the `repo` scope, and a workflow's token the same grants under `permissions:`:

| Check | What it reads | What the token needs |
|---|---|---|
| The pin, the declarations, the callers, the id-token holders | the checkout | nothing |
| The release's requirements | `requirements.json` in Kanon's public repository, at the tag | nothing beyond a login |
| The repository, the labels | the repository, its default branch, its labels and milestones | Metadata: read, Contents: read, Issues: read |
| `app-permissions` | `GET /apps/<slug>`; for a private App, the latest completed dispatched run of the `apps-check` caller on the default branch: its jobs and their logs | Actions: read |
| `secrets` | the secrets' names, never their values | Secrets: read (an admin's access, with a classic token) |
| `ruleset` | the rulesets on the default branch | Metadata: read |
| `ruleset-bypass` | each ruleset's bypass list, and the Releaser's App id: from `GET /apps/<slug>`, or, for a private Releaser, from the owner's App installations | Administration: write: GitHub shows a bypass list only to someone who can edit the ruleset; for a private Releaser in an organisation, also the organisation's Administration permission (read) |
| `unused-apps` | the owner's App installations, only when the register's history names an App it no longer does | in an organisation, an owner's token with the organisation's Administration permission (read); a classic token's `admin:org` scope holds it too, but that scope is write, so prefer a fine-grained token |

**A private App** shows its permissions only to itself: `GET /apps/<slug>` answers 404 to a person's token and to a workflow's alike ([#417](https://github.com/yedeya-labs/kanon/issues/417)). The `apps-check` workflow reads each App's installation with the App's own key, and each App's job prints one line for doctor: `kanon-apps-check/v1`, then the App's key, the slug it minted and the installation's permissions as JSON. Not the App's id: `kanon apps` stores it as the `<APP>_APP_ID` secret, and the runner masks a secret's value in the log as `***`, so a line with it would not be JSON. Doctor reads that line from the latest completed run dispatched (`workflow_dispatch`) on the default branch, whose workflow is the reviewed one, and says in a note which run it read. A branch name alone doesn't hold that: a pull request from a fork's own `main` runs the fork's workflow under that name. Doctor therefore asks only for dispatched runs, which a fork can't start, and refuses a run from another repository or another event. So:

- **Run your `apps-check` caller after creating or changing an App** (`gh workflow run apps-check.yml -R <owner>/<repo>`), as [`docs/apps.md`](apps.md#checking-the-installations-later) already asks. A permission changed on an App's page since that run is not seen until it runs again.
- **It reads the permissions, not the verdict.** `apps-check` fails an App that holds more than its own permissions, and doctor still reads what that run found, so an extra permission stays a warning here (the Owner's decision 3 below).
- **`app-permissions` is `unchecked`** when there is no completed dispatched run on the default branch, when the run came from another repository or another event, when its job for the App printed no line (an `apps-check` from before #417 doesn't, nor one that couldn't mint the App's token), or when the run checked another slug than the register names now. The reason says to run `apps-check` again. A line the runner masked part of is `unchecked` too, and its reason says so; running again doesn't help there.
- **A private Releaser's bypass** needs the Releaser's id, which `apps-check` can't print and doctor never reads around the mask (`K-AGENT-47`). Doctor reads it from the Releaser's installation, in the owner's App installations, which only an owner of an organisation can list, with its Administration permission (read). With another token, or on a personal account, where GitHub lists installations only to a GitHub App's user token, `ruleset-bypass` is `unchecked` and its reason says why; on a personal account, look at the ruleset's bypass list yourself.

**The Apps left installed** (`unused-apps`) are the one check a repository's token can't run. Only an owner of an organisation can list its installations, so an owner runs doctor once with such a token, in their own terminal, after any move off an App. On a personal account, GitHub lists its installations only to a GitHub App's user token, which doctor doesn't use, so look on <https://github.com/settings/installations> yourself. The check runs only when the register's history names an App its current copy doesn't.

**A healthy Kanon reaches 0** with a token that holds every permission in the table: in Kanon's own repository, an owner's fine-grained token for the organisation, holding its Administration permission (read) as well, once `apps-check` has run on `main`.

## The id-token holders

The QA store's role and the telemetry writer trust the default branch's ref, not an environment ([`docs/qa-store.md`](qa-store.md#who-can-reach-the-store), [`docs/telemetry.md`](telemetry.md#who-can-write)), so **every job on your default branch that holds `id-token: write` can assume them**, including your own jobs that hold it for another cloud. Kanon's guard holds Kanon's own workflows; yours are yours to check, and doctor lists them, counted as the guard counts them: a job's own grant, the workflow's when the job declares none, `permissions: write-all` at either level, and a job that calls a reusable workflow with such a grant.

- **A caller of one of Kanon's store-coupled lanes at the pinned release** is listed as Kanon's, and accepted: the grant reaches only the lane's store jobs and, in the Overseer, its `telemetry` job, each of which Kanon's guard holds. So is **a caller of Kanon's telemetry collector at the pinned release** (`kanon init --telemetry` writes one), whose one job that holds the grant the same guard holds; both are `kanon-lane` in `.idTokenHolders[].status`.
- **Any other holder** blocks until you either narrow its grant, or accept it under `## Choices` in the adoption record (`K-LAYOUT-10`), one bullet per job, naming the workflow file and the job's key, with the reason it holds the grant:

  ```markdown
  - **Accepted id-token holder:** `deploy.yml` job `deploy` (assumes the production deploy role)
  ```

  An acceptance in another shape, outside `## Choices` or written twice is malformed and blocks. One whose job no longer holds the grant is listed as stale, without blocking.

Doctor counts the workflows of the checkout it runs from. Run it on your default branch for the count the roles see; it says so when you don't.

## Waiving a finding

Some findings your repository has decided to keep. A caller whose lane's file name is already taken by another workflow can't be renamed onto it, say: `git mv` would refuse, and forcing it would destroy that workflow. **Doctor knows no repository's special case.** Instead, any repository waives a finding it keeps, under `## Choices` in the adoption record (`K-LAYOUT-10`), one bullet per finding: the bold label, the finding's id as one code span, `on`, its subject as one code span, exactly as doctor reports it in `.findings[].subject`, and then in parentheses why the finding stands, on one line:

```markdown
- **Waived doctor finding:** `caller.misplaced` on `.github/workflows/review.yml` (agent-review.yml is the lane's own definition in this repository)
```

- **A waived finding doesn't count.** It moves from `findings` to `waived`, with the bullet's reason, so it no longer sets the exit code, and it stays in the document for whoever reads it.
- **A waiver is narrow.** It waives one finding id on one subject; nothing waives an id everywhere, or every finding on a subject. Where doctor reports more than one finding of an id on one subject, such as each missing secret on the repository, a waiver of a finding that lists items covers each of them for the items it names (the next bullet), and any other waiver covers each of them; `waived` lists each.
- **A waiver of a finding that lists items names them** ([#406](https://github.com/yedeya-labs/kanon/issues/406)). Some findings list several items in one message, and a later release can add one: a permission an App needs, a secret a lane takes. So a waiver of one of these names, after `for`, each item it waives, as one code span each, separated by commas, exactly as the finding's message names them:

  ```markdown
  - **Waived doctor finding:** `secret.missing` on `acme/widgets` for `DIGEST_WEBHOOK` (the digests post through the organisation's webhook)
  ```

  Doctor waives only those. Any other item the finding lists, today or after an upgrade, stays a finding, written for those items alone, and says which bullet waives which items; `waived` lists the finding for the items each bullet names, in `.waived[].items`, with the bullet's line, `.waived[].line`. **Several bullets may waive items of one finding,** each with its own reason, but no item twice: a bullet naming an item another bullet of that finding names is malformed. An item a bullet names that doctor no longer reports makes the waiver stale. **A bullet of one of these findings that names no items is malformed** (the Owner, 2026-10-07), and waives nothing, because it would also waive whatever a later release adds: its fix is the bullet to write instead, naming the items doctor reports today, with the same reason. Before #406 such a bullet waived the whole finding; rewrite it as its fix says, keeping only the items the repository keeps. The ids, and what an item of each is:

  | Id | An item |
  |---|---|
  | `register.missing-row` | a role whose row is missing |
  | `register.split-slug` | an App whose roles name more than one slug |
  | `app.permission-missing`, `app.permission-extra` | a permission, such as `contents` |
  | `secret.missing`, `secret.stale` | a secret's name |
  | `declaration.section-missing` | a heading, such as `## Gates` |
  | `hook.input-missing` | an input |
  | `caller.secret-missing`, `caller.secret-stale` | a secret's name |
  | `caller.input-stale` | an input |
  | `caller.grant-missing` | a permission |
  | `apps-check.secret-missing`, `apps-check.secret-stale` | a secret's name |
  | `label.missing` | a label |
  | `telemetry.unconfigured` | a variable |
  | `qa-store.unmapped` | a secret |
  | `qa-store.variables` | a variable |

- **A waiver that matches nothing is listed as stale** (`waiver.stale`), without blocking, so a waiver doesn't outlive its finding. When the check that would report its finding couldn't run, doctor can't tell, and says so in a note instead.
- **A waiver in another shape is malformed, and blocks** (`declaration.malformed`): outside `## Choices`, with nothing in its parentheses, naming an id doctor doesn't report, naming no items of a finding that lists them, naming items of a finding that lists none, waiving one finding twice, or one item of it twice, or waiving a finding that can't be waived.
- **The person decides.** A waiver is a decision the rulebook gives to the project, in a file on its escalation path (`K-MERGE-4`). An agent may propose one; the person writes it, or accepts it with its reason.

An accepted id-token holder is this waiver's own form for `id-token.unaccepted`: the same `## Choices`, one bullet per job, a reason, malformed and stale alike. It keeps its own shape because doctor lists every holder with its status (`.idTokenHolders[].status`), and the acceptance is what makes one `accepted`.

### What can't be waived

Each of these is reported as before, whatever the record says, and a waiver of one is malformed:

- `declaration.malformed`, `waiver.stale` and `id-token.stale-acceptance`: they are about the adoption record itself, so a waiver could hide a broken or stale waiver.
- `id-token.unaccepted`: accept the holder with its own bullet, above.
- `register.shared-slug`: one App would author and approve its own work, which defeats independent review (`K-LAYOUT-6`).
- `caller.secrets-inherited`: the lane would receive every secret of the repository (plan 0001 decision 7).
- `ruleset.missing` and `ruleset.rule-missing`: nothing would enforce review on the default branch (`K-ADOPT-1` step 8).
- `ruleset.bypass-extra`: an actor other than the Releaser could merge around review (`K-MERGE-8`).

## Decided by the Owner, 2026-10-06

1. **An id-token holder is accepted by one bullet per job** under `## Choices` in the adoption record (`K-LAYOUT-10`), as above.
2. **Exit code 4, `incomplete`, is separate from 0,** so a script never reads "couldn't check" as healthy.
3. **An App holding more than the release grants warns, and doesn't block** (`app.permission-extra`): each lane narrows its token to what it uses (`K-AGENT-46`). `apps-check`, which fails such an App, is unchanged; the divergence is deliberate.
4. **`--to` checks the target release only.** What the pinned release already needed shows up too, because it fails the target as well.
5. **The holders are counted on the checkout's workflows,** not on the default branch read through the API; doctor adds a note when the checkout is on another branch.
6. **A per-role App left installed after the two-App move is listed, without blocking** (`app.unused`), with the steps to uninstall and delete it in its fix.
7. **Any repository waives a finding it keeps with one bullet under `## Choices`,** one finding id on one subject with its reason, as above ([#390](https://github.com/yedeya-labs/kanon/issues/390)); doctor learns no repository's special case ([#389](https://github.com/yedeya-labs/kanon/issues/389)). A waived finding doesn't count toward the exit code and stays in `waived`; a stale waiver is listed; a malformed one blocks. Which findings can't be waived is listed above. Since 2026-10-07, a finding that lists items takes several bullets, each naming its items (below).
8. **A project may declare the kanon plugin in `.claude/settings.json`,** and doctor reports, without blocking, a declared release other than the one it checks against (`plugin.version-mismatch`, [#376](https://github.com/yedeya-labs/kanon/issues/376)). Under `--to` that is the release you are moving to, so the upgrade shows the plugin's edit beside the pin's. It can be waived like any other finding.

## Decided by the Owner, 2026-10-07

1. **A waiver of a finding that lists items names them, or is malformed** ([#406](https://github.com/yedeya-labs/kanon/issues/406)), from the release that ships this, not a later schema: a bullet that names none would hide what a later release adds. Its fix is the bullet to write, built from the items doctor reports today. The document's shape stays `kanon-doctor/v1`; what the adoption record accepts is the breaking change.
2. **Several bullets may waive items of one finding,** each with its own items and reason; two naming the same item are malformed.
3. **`secret.missing` asks only for Kanon's own secrets** at the checked release: each of its Apps' two, and its lanes' ([#415](https://github.com/yedeya-labs/kanon/issues/415)).

## Exit codes

The same in both outputs.

| Code | Status | Meaning |
|---|---|---|
| 0 | `healthy` | Every check ran, and nothing blocking was found, or only findings the adoption record waives. |
| 1 | `findings` | At least one blocking finding that isn't waived, an id-token holder neither accepted nor narrowed included. |
| 2 | `usage` | A usage error: an unknown argument; a value flag followed by another flag where its value belongs (`--dir --json`, as an unset, unquoted variable leaves it: a value that begins with `-` is given as `--dir=<value>`); `--to` that is not an exact release; or `--help` with `--json`, since the usage text is no document. |
| 3 | `error` | It could not run: no checkout, the repository or a release's requirements file could not be read, nothing pins Kanon, or it stopped on an error it didn't expect. |
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
| `findings` | array | What is missing or stale, in the order to fix it. A waived finding is not here. |
| `waived` | array | Each finding the adoption record waives, in the same order: it doesn't count toward the exit code. |
| `idTokenHolders` | array | Every job of the checkout's workflows that holds `id-token: write`. |
| `unchecked` | array | Each check that could not run: `check`, `subject` and `reason`. |
| `notes` | array | Strings: defaults taken and facts that block nothing, such as a lane you call that a merge through the default branch's merge queue doesn't start, in its catalogue entry's words ([#452](https://github.com/yedeya-labs/kanon/issues/452)). |

When it can't run, or on a usage error with `--json`, the document is `{ "schema", "kanon", "status": "error", "exitCode", "error" }`, with the exit code 2 or 3 and `error` saying why.

### A finding

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Its stable id, from the table below. |
| `category` | string | `pin`, `app`, `secret`, `declaration`, `caller`, `label`, `ruleset` or `id-token`, in the order they are listed. |
| `blocking` | boolean | Whether it makes the exit code 1. |
| `subject` | string | What it is about: a file, an App slug, the repository, a branch, a status check's name, or `<workflow file>#<job>`. |
| `message` | string | What is missing or stale, in a sentence. |
| `fix` | object | The exact fix. |

### A fix

| Field | Type | Meaning |
|---|---|---|
| `text` | string | What to do, in a sentence. |
| `commands` | array | Strings: the commands to run, or the lines to add to the file the finding names, in order. Possibly empty. |
| `url` | string or null | The page to do it on, such as an App's permissions page. |

### A waived finding

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The finding's id. |
| `category` | string | Its category. |
| `blocking` | boolean | Whether it would have blocked, had it not been waived. |
| `subject` | string | What it is about, as the waiver names it. |
| `message` | string | What is missing or stale, in a sentence. |
| `fix` | object | The fix it would have had. |
| `items` | array | Strings: the items it waives, for a finding that lists items ([above](#waiving-a-finding)); empty for any other. |
| `line` | number | The line of the adoption record whose bullet waives it. |
| `reason` | string | Why the finding stands: the waiver's parentheses in the adoption record. |

It is the finding, whole, as it would have been listed, with the waiver's reason; for a waiver that names items, the finding as it would have been listed for those items alone, once for each bullet that waives some of them.

### An id-token holder

| Field | Type | Meaning |
|---|---|---|
| `workflow` | string | The workflow file, from the repository's root. |
| `job` | string | The job's key. |
| `grant` | string | `job` when the job's own `permissions:` grants it, `workflow` when it inherits the workflow's. |
| `how` | string | `id-token` for `id-token: write`, `write-all` for `permissions: write-all`. |
| `calls` | string or null | The reusable workflow the job calls and passes the grant to. |
| `status` | string | `kanon-lane` (a store-coupled Kanon lane, or Kanon's telemetry collector, at the pinned release), `accepted` (by the adoption record) or `unaccepted`. |
| `reason` | string or null | The adoption record's reason, when accepted there. |

### The finding ids

| Id | Category | Blocks | Meaning |
|---|---|---|---|
| `pin.mixed` | `pin` | yes | Kanon's references pin more than one release, or a ref that is not an exact release. |
| `plugin.version-mismatch` | `pin` | no | `.claude/settings.json` declares the kanon plugin's marketplace at a `ref` other than the checked release, or with no `ref`, so it follows Kanon's default branch. Its fix is the one `ref` to set. |
| `register.missing-row` | `app` | yes | The App register has no row for a role an App's lanes read their slug from. |
| `register.split-slug` | `app` | yes | An App's roles name more than one slug. |
| `register.shared-slug` | `app` | yes | Two Apps name one slug. |
| `app.permission-missing` | `app` | yes | An App holds less than the release grants it. |
| `app.permission-extra` | `app` | no | An App holds more than the release grants it. It blocks nothing, since each lane narrows its token, though `apps-check` fails it. |
| `app.unused` | `app` | no | An App the App register's history on the checkout once named, and its current copy doesn't, is still installed for the owner: a per-role App left from before the two-App move, say. Its fix gives the uninstall and delete steps. |
| `secret.missing` | `secret` | yes | A secret a lane or an App needs is not set: one a called lane takes, or one of the checked release's Apps or lanes that any workflow maps, whatever its job calls. One finding per App, or per other secret; its message names the workflows that map it. An App's fix is `kanon apps --preflight`, then the `kanon apps` line that creates the App or stores its key. The QA store's two secrets count only where the store hook exists. Against a release whose lanes pass the hook no variables ([#479](https://github.com/yedeya-labs/kanon/issues/479)), a store secret is missing even while a repository variable of the same name holds its value, and the fix copies the variable into the secret through a pipe; against v0.34.x, which still passed the variables, that case is `qa-store.variables` alone. |
| `secret.stale` | `secret` | no | An App secret no App in use reads and no workflow of the checkout names, while none inherits every secret or reads secrets by a computed name. |
| `declaration.missing` | `declaration` | yes | A project document a lane reads, with no default, is missing. |
| `declaration.section-missing` | `declaration` | yes | A section with no default is missing, or written more than once. |
| `declaration.malformed` | `declaration` | yes | An id-token holder's acceptance, a waiver, or the `Upstream findings:` or `Capability watch:` choice in the adoption record is malformed, or a waiver waives a finding that can't be waived. |
| `waiver.stale` | `declaration` | no | The adoption record waives a finding doctor doesn't report, or names an item of one that doctor doesn't report. |
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
| `telemetry.unconfigured` | `caller` | no | A workflow calls Kanon's telemetry collector, and the repository doesn't set `KANON_TELEMETRY_URL` or `KANON_TELEMETRY_WRITER_ROLE`, so it sends nothing: the collector skips with a warning and stays green. The fix says how to ask Kanon's operator for registration and the two values ([`docs/telemetry.md`](telemetry.md#add-a-repository)). It can be waived. |
| `qa-store.unmapped` | `caller` | no | The repository has a QA store hook, and the caller of a store-coupled lane doesn't map `QA_STORE_ROLE_ARN` or `QA_STORE_BUCKET`, so its store jobs reach no store, or, against v0.34.x, read the deprecated variables, which their logs print ([#433](https://github.com/yedeya-labs/kanon/issues/433), [#479](https://github.com/yedeya-labs/kanon/issues/479)). The fix is the lines to add. |
| `qa-store.variables` | `secret` | no | The repository has a QA store hook and a store-coupled lane, and holds `QA_STORE_ROLE_ARN` or `QA_STORE_BUCKET` as a repository variable ([#433](https://github.com/yedeya-labs/kanon/issues/433)). Against a release whose lanes pass the hook no variables ([#479](https://github.com/yedeya-labs/kanon/issues/479)) it is a leftover: the store reads the secrets alone, and a secret the variable doesn't replace is `secret.missing`, which blocks. Against v0.34.x, which passed every variable to the hook, every store job's log prints it, with the AWS account id in it. The fix copies each into a secret, unless one is set already, and deletes the variable once a store job has run green on the secrets ([the QA store](qa-store.md#move-the-coordinates-to-secrets)). |
| `label.missing` | `label` | no | Labels of the taxonomy are missing. |
| `ruleset.missing` | `ruleset` | yes | No active ruleset covers the default branch. |
| `ruleset.rule-missing` | `ruleset` | yes | The default branch's ruleset lacks a rule of `K-ADOPT-1` step 8. |
| `ruleset.check-unreported` | `ruleset` | yes | No job of a workflow on the default branch reports the status check the ruleset requires, or is about to be asked to require (`Lane check`); its subject is the check's name. A job whose workflow's `pull_request` trigger skips some pull requests doesn't count, and the message names its filters ([#446](https://github.com/yedeya-labs/kanon/issues/446)). Where a ruleset on the default branch has a merge queue, neither does a job whose workflow doesn't run on `merge_group`, or skips the default branch there, and the message names the job ([#459](https://github.com/yedeya-labs/kanon/issues/459)). Its fix says whether the checkout adds such a job, so its pull request merges first, or the filters have to come off, or `merge_group` has to be added to the workflow's triggers, or a job has to be added. Until one is on the default branch, doctor doesn't ask for the rule. |
| `ruleset.releaser-bypass-missing` | `ruleset` | yes | The release caller maps the Releaser, and a ruleset on the default branch does not list the Releaser App as a bypass actor (`K-MERGE-8`). |
| `ruleset.bypass-extra` | `ruleset` | yes | The release caller maps the Releaser, the checked release's `dco` check passes the Releaser's release PR, and a ruleset on the default branch lets another actor bypass it, such as the admin role (`K-MERGE-8`). |
| `id-token.unaccepted` | `id-token` | yes | A job holds `id-token: write`, and is neither Kanon's lane nor accepted. |
| `id-token.stale-acceptance` | `id-token` | no | The adoption record accepts a job that no longer holds the grant. |
