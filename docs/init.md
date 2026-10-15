# `kanon init`

`kanon init` installs Kanon in the repository whose checkout you run it from ([plan 0005](plans/0005-lean-installation.md) §5.4). It inspects the repository and its owner, asks three questions, infers or defaults the rest and shows it all in one summary to confirm ([below](#answering-without-a-terminal)), writes the declarations and the lane callers pinned to the release it runs from, and the [kanon plugin's](skills.md#declare-it-in-the-repository) declaration if you want it, and, for a repository that declares deploy environments, the deploy lane's caller and its three hooks' stubs ([below](#the-deploy-lane)), creates the labels, the bucket milestones and, where the plan has rulesets, the default branch's ruleset, and runs [`kanon apps`](apps.md) for the Apps the lanes run as. The ruleset requires the status check `Lane check` only once a job on the default branch reports it on every pull request, read from GitHub as [`kanon doctor`](doctor.md) reads it ([#444](https://github.com/yedeya-labs/kanon/issues/444)): a check required before then blocks every other pull request until the one adding the job merges, so until then the rule is a step for after that merge (`ruleset.require-check`). To a ruleset it didn't create, `init` adds that rule and no other, and only with a token that can administer the repository; it writes `lane-check.yml` unless another workflow already has a job that reports the check, which a step of another job doesn't. It commits nothing, prints as exact steps whatever its token or plan can't do, and changes nothing on a second run. `kanon init --help` lists every option.

It is **scriptable** ([ADR 0014](decisions/0014-adopter-audiences.md), decision 2): every question has a flag that answers it, and `--json` prints the result as one JSON document. The agent skills of plan 0005's L11 drive it that way, and so can any program.

## Answering without a terminal

**At a terminal, `init` asks three questions** ([plan 0007](plans/0007-guided-install.md) §3), each unless its flag answers it: what Kanon should do in this repository (a **feature**, or **Customise**, which asks for the lanes one by one), whether the repository holds private or sensitive material, and one consent question for sharing with Kanon. Every other value is **inferred** from the repository or **defaulted**, as the table below says. `init` then shows **one summary**, a line per value with where it came from (`flag`, `asked`, `inferred` or `default`, and why), and asks **Install Kanon with these settings?**: **Install**; **Change something**, which asks which of the summary's groups to change (People; Lanes and Apps; Gates, database and delegation; Labels, plugin and pin; Data and sharing; Claude credential; Deploy environments), asks each chosen group's questions, and shows the summary again; or **Stop**, which writes and changes nothing. A fourth question, which pull requests the Reviewer reviews, waits for the review lane's trigger without a label (plan 0007 step G7): until then the trigger is the summary's `labelled` line.

Each question has a flag, and so does each value the summary shows. A flag answers its question or sets its value; `--yes` takes the default of every question no flag answers, and confirms the summary without asking; without `--yes`, the questions no flag answers are asked, and the summary is confirmed. At the terminal, Enter takes the answer each question shows in brackets: its recommended answer, except at the first question for a repository whose called lanes make up no feature, where Enter keeps those lanes (**Customise**, `custom`) while **Review** is marked recommended, so that pressing Enter never narrows an installation to fewer lanes than it calls. An answer `init` doesn't recognise takes the safe side: No at the consent question, and **Stop** at the confirmation. **Recommended is not a default:** under `--yes`, where nothing is shown, sharing is No, and the Data section says "not declared". On a standard input that isn't a terminal, `init` refuses to start without `--yes` (or `--json`, which implies it), and changes nothing.

| Question or value | Flag | Default |
|---|---|---|
| What should Kanon do in this repo? (asked) | `--feature review\|build\|full`, a fixed set of lanes ([`docs/lanes.md`](lanes.md#the-features)), or `--lanes <list>`, the **Customise** choice, lane by lane | the feature the lanes the repository already calls make up; those lanes, `custom`, when they make up none; `review` when it calls none |
| Which pull requests should the Reviewer review? (asked once step G7 ships) | `--review-trigger labelled`; `every-pr` is refused until step G7 builds it | `labelled`, with the review lane |
| Does this repo hold private or sensitive material? (asked) | `--sensitive-data`, `--no-sensitive-data` | not declared: the adoption record's `## Data` section says so, and `notes` too |
| Help improve Kanon by sharing anonymous run data and the Kanon bugs your lanes find? (asked, [below](#sharing)) | `--consent yes\|codes\|no` | `no` |
| Who is the Owner? | `--project-owner <who>` | the one user `CODEOWNERS` names for `*` (`inspection.codeowners`), else the token's login |
| Who is the Maintainer? | `--maintainer <who>` | the Owner |
| Who is the Stakeholder? | `--stakeholder <who>` | the Owner |
| Which Claude credential do the lanes run on? (inferred, never asked: [below](#the-claude-credential)) | `--claude-auth subscription\|api-key` | The one the installed model lanes' callers map, when they all map the same one; else `api-key` when the repository holds `ANTHROPIC_API_KEY` and not `CLAUDE_CODE_OAUTH_TOKEN`; else `subscription` |
| The stack's gates | `--gates <list>`, or `--gates none` | suggested from `package.json`, a `Makefile`, Cargo or Go |
| Does a lane need a test database? | `--test-database none\|hook` | `hook` when a compose file has a database service, an example environment file (`.env.example` and the like) sets `DATABASE_URL`, or a migrations directory exists; else `none` |
| Record a sign-off delegation? | `--delegation`, `--no-delegation` | yes when a chosen lane runs as the Author and a workflow runs Kanon's DCO check (`yedeya-labs/kanon/actions/dco`), and `git config` names the delegate; else no |
| The delegate's name | `--delegate-name <name>` (implies `--delegation`) | `git config user.name` |
| The delegate's email | `--delegate-email <email>` (implies `--delegation`) | `git config user.email` |
| Delete GitHub's default labels outside the taxonomy? | `--delete-default-labels`, `--keep-default-labels` | delete on a repository with no commit yet, else keep |
| Create the optional Releaser App? | `--releases`, `--no-releases`, or the same answer as `--releaser`, `--no-releaser` | yes for a repository that calls Kanon's release workflow (`inspection.callsRelease`), else no |
| Reuse an App the owner already has, rather than create a second? (only when the owner's installations, or another of its repositories' registers, hold one the chosen lanes need and the register lacks, `inspection.ownerApps`) | `--reuse-apps`, `--no-reuse-apps` | yes |
| Declare the kanon plugin in `.claude/settings.json`? | `--plugin`, `--no-plugin` | yes |
| Send this repository's telemetry rows to Kanon's hosted telemetry store? (one of the three answers the consent question sets) | `--telemetry`, `--no-telemetry` | no |
| Where do upstream findings go? And, after `sent`: also send each finding's evidence and suggested fix, as text? ([below](#upstream-findings); the other two answers the consent question sets, and `filed-here` only through **Change something**) | `--upstream-findings drafted\|filed-here\|sent\|sent-with-evidence`; `sent` and `sent-with-evidence` need `--telemetry` | `drafted` |
| The deploy lane's environments, in deploy order, the last being production? (asked by the adopt skill; at the terminal, only through **Change something**, [below](#the-deploy-lane)) | `--deploy-environments <list>`, comma-separated, such as `staging,production`, or `--deploy-environments none` | the adoption record's `## Deploy` list, else none: no deploy lane |
| Accept a job of your workflows that holds `id-token: write`? ([below](#existing-id-token-holders); once per job) | `--accept-id-token-holder <workflow>.yml#<job>=<why>` | none: each such job is the finding `id-token.unaccepted` |
| Create the Apps now? | `--create-apps`, `--no-apps` | yes |

**What fails, by name, before anything changes:** a flag `init` doesn't know, `--owner` among them, with a hint naming `--project-owner`; a value flag given twice, or followed by another flag where its value belongs (`--project-owner --yes`, as an unset, unquoted variable leaves it: a value that begins with `-` is given as `--project-owner=<value>`); a value `init` doesn't take (`--test-database` other than `none` or `hook`, a lane Kanon doesn't ship, `--feature` other than `review`, `build` or `full`, `--consent` other than `yes`, `codes` or `no`, and `--review-trigger every-pr`, which isn't built yet); two flags that contradict each other (`--delegation` and `--no-delegation`, `--delegate-name` or `--delegate-email` with `--no-delegation`, `--delete-default-labels` and `--keep-default-labels`, `--releaser` or `--releases` with `--no-releaser` or `--no-releases`, `--sensitive-data` and `--no-sensitive-data`, `--reuse-apps` and `--no-reuse-apps`, `--plugin` and `--no-plugin`, `--telemetry` and `--no-telemetry`, `--consent` with `--telemetry`, `--no-telemetry` or `--upstream-findings`, `--feature` and `--lanes`, `--create-apps` and `--no-apps`, and `--help` and `--json`, since the usage text is no document); `--review-trigger` with a `--lanes` that has no review lane; `--upstream-findings sent` or `sent-with-evidence` without `--telemetry`; `--deploy-environments` with an empty name, a name with a character other than letters, digits, `.`, `_` and `-`, or a name given twice; `--accept-id-token-holder` in another shape than `<workflow>.yml#<job>=<why>`, given twice for one job, or naming a job that holds no `id-token: write` in the checkout, whose acceptance would be stale; and `--releaser` or `--releases` for a repository that doesn't call Kanon's release workflow. Each exits 2.

**Why `--project-owner`, not `--owner`** (the Owner, 2026-10-06): `--owner` names the GitHub account that owns the repository, in `kanon apps` and everywhere else, so the person who is the project's Owner gets a flag of their own, and `answers.projectOwner` in the JSON.

### Sharing

**One consent question** sets the three answers sharing takes: whether the telemetry collector is written, where upstream findings go, and whether their evidence is sent ([plan 0007](plans/0007-guided-install.md) §3, `K-OBS-18`). In `init`'s words, `CONSENT_QUESTION` in `cli/init.mjs`, which the adopt skill asks word for word: "Help improve Kanon by sharing anonymous run data and the Kanon bugs your lanes find? Evidence text may rarely hold personal data; details: `<link>`." The link is [`docs/sharing.md`](sharing.md) at the release `init` runs from, which holds the rest of what is sent, where and for how long, who reads it, and how to stop and erase.

| `--consent` | Its option | Sets |
|---|---|---|
| `yes` | **Yes**: run data, and scrubbed bug evidence read by Kanon's maintainer and a third-party decision provider. | `telemetry` true, `upstreamFindings` `sent with evidence`, `upstreamEvidence` true |
| `codes` | **Codes only**: run data, and Kanon bugs as codes with no text. | `telemetry` true, `upstreamFindings` `sent`, `upstreamEvidence` false |
| `no` | **No**: nothing leaves this repo; Kanon bugs stay drafts here. | `telemetry` false, `upstreamFindings` `drafted`, `upstreamEvidence` null |

**Yes is `sent with evidence` whatever the feature:** the record holds what the person consented to, so a later move to Full asks nothing again (Owner decision 7). Yes is recommended, and listed first. **At the terminal, Enter answers Yes:** the question was shown, so Enter is the person's answer to it (plan 0007, Owner decision 16), and an answer `init` doesn't recognise is No, the safe side. **Under `--yes`, with no flag, it is No:** with no question shown, consent is never implied (`K-OBS-18`, Owner decision 8). The older flags still set the three answers one by one, never beside `--consent`; `answers.consent` is then the level they make, or null for a combination no level names, such as `filed here`.

### Telemetry

**Telemetry is off unless you say yes** (#428). With `--consent yes` or `codes`, `--telemetry`, or a yes to the consent question, `init` writes the caller of Kanon's telemetry collector, `.github/workflows/telemetry.yml`, exactly as [`docs/telemetry.md`](telemetry.md#collect-the-rows) gives it and pinned to this release. Hourly, it sends each agent run's row: plan 0002's fixed fields about the run (its lane, outcome, model, cost, tokens, durations and counts, the run, pull request and issue numbers, and the Kanon release), with a work-item row per closed pull request, a deploy row per environment a release run reaches and a notify row each time a lane's `notify` job runs ([what is sent](sharing.md), [`K-OBS-16`](../rulebook/08-observability-and-cost.md#k-obs-16-telemetry-is-metadata-never-content) the full list), and never code, text, logins or file paths. The rows go to one table in Kanon's AWS account in Frankfurt, under an opaque key, and are kept 13 months. Kanon's operator reads them, and publishes only aggregates that at least three adopters contribute to; your repository reads only its own rows. To stop, delete the caller; to have what was sent erased, first run it by hand with `erase: yes` ([Stop and erase](sharing.md#stop-and-erase)). What you get for it: Kanon notices failures that Kanon caused in your runs, and often fixes them before you would have to report one, and you get cross-adopter cost and reliability baselines ([What an adopter gets by opting in](telemetry.md), [#41](https://github.com/yedeya-labs/kanon/issues/41)).

**The caller is the whole registration** ([plan 0008](plans/0008-self-service-registration.md) §8): it reads no variable and maps no secret, and its first run on the default branch registers the repository with the store, with the OIDC token GitHub gives the run. So `init` leaves no step for it, and the summary's *Sharing* line says "registers on the collector's first run". A release whose hosted store's URL is not published yet ([`docs/telemetry.md`](telemetry.md#publish-the-hosted-urls)) sends nothing, so at one the question says so and the line says "sends nothing yet: this release of Kanon doesn't publish the hosted store's URL" instead ([#843](https://github.com/yedeya-labs/kanon/issues/843)). `kanon doctor` reads that run afterwards: `telemetry.not-run` until there is one, `telemetry.unpublished` if it skipped for that reason, `telemetry.refused` if the store refused it ([`docs/doctor.md`](doctor.md)).

### Upstream findings

An upstream finding is one about Kanon itself, a lane's behaviour, a guard, a rule or Kanon's library, found by the Overseer or the telemetry Explorer ([plan 0006](plans/0006-upstream-findings.md) §3). The consent question sets where they go ([above](#sharing)), and **Change something** asks it as its own question, after the telemetry question, which is the one way to `filed-here` at the terminal. `init` writes the answer as the adoption record's `Upstream findings:` choice (`K-LAYOUT-10`), only when it isn't the default, `drafted`. Whichever is chosen, nothing is ever filed in another repository.

- **`drafted`** (the default): written into the audit issue or the run's summary, for the person to read. Nothing is filed or sent.
- **`sent`**: also sent to Kanon's telemetry store as codes only: the lane, stage, error and reason codes, the Kanon release, rulebook ids, Kanon's own file paths and a fix category, and no text. **Offered only when the telemetry answer is yes,** since the findings travel over the telemetry channel: without `--telemetry`, `--upstream-findings sent` is refused, and the question offers only `drafted` and `filed-here`. A record that says `sent` with no caller of the collector is `upstream.unsent` to `lane-check` and `kanon doctor`.
- **`sent with evidence`** (`--upstream-findings sent-with-evidence`, or `--consent yes`): asked on its own only after `sent`, through **Change something**, codes only by default. It also sends each finding's evidence and suggested fix, as text, which may rarely still contain personal data, and which Kanon's maintainer and a third-party decision provider, TypeSafe, read. The consent question says so in its own second sentence and in its *Yes*, as ADR 0007 and `K-OBS-16` require, and the question **Change something** asks says it in plan 0006 decision 14's words.
- **`filed-here`**: filed as issues in this repository, for a repository that maintains Kanon itself or a fork of it.

**How they travel.** The lanes build the rows (plan 0006's F3) and upload them as `kanon-finding-*` artifacts, and the collector sends them (F4). A lane drafts each finding of a record that says `sent` or `sent with evidence`, writes its row, and the collector sends the row at the level the record declares.

### Existing id-token holders

**Every job on the default branch that holds `id-token: write` can assume the QA store's role and the telemetry writer**, which trust the default branch's ref ([`docs/doctor.md`](doctor.md#the-id-token-holders), [#631](https://github.com/yedeya-labs/kanon/issues/631)), so a yes to telemetry makes a repository's existing OIDC jobs, such as one that assumes its own cloud role, possible writers to Kanon's store. `kanon doctor` blocks on each one the adoption record doesn't accept (`id-token.unaccepted`), and `init` names the same jobs before anything is written, with doctor's own check, so the person decides at the consent question rather than after the pull request:

- `inspection.idTokenHolders` lists every job of the checkout's workflows that holds the grant, in doctor's shape ([An id-token holder](doctor.md#an-id-token-holder)). A caller of a store-coupled Kanon lane, of the telemetry collector, or of the deploy lane's two workflows at any exact release is `kanon-lane` (the deploy lane's by `init` alone until `kanon doctor` gains its deploy checks, plan 0010 step D7: until then doctor still reports those jobs as `id-token.unaccepted`): doctor holds it to the release the callers pin, and there is nothing for the person to decide about it.
- Each job nothing accepts is the finding `id-token.unaccepted`, doctor's subject, message and fix word for word, and a line of the summary (`id-token`) says what becomes of each.
- The consent question, at the terminal, carries a line after its own words naming those jobs: "On `<branch>`, a job that already holds id-token: write could then write to Kanon's telemetry store: `<workflow>.yml job <job>`. Narrow its grant, or accept it in docs/qa/adoption.md (kanon init lists it)." The telemetry question says it of every repository.
- `--accept-id-token-holder <workflow>.yml#<job>=<why>`, once per job, records the person's acceptance: `init` writes doctor's bullet under the adoption record's `## Choices`, `` - **Accepted id-token holder:** `<workflow>.yml` job `<job>` (<why>) ``, and doctor then finds the job accepted. A record the repository already has is the project's, so `init` leaves it alone, and the finding stays, its bullet carrying the reason given, for the person to add. Narrowing the job's grant needs no flag: it is a change to the project's own workflow.

### The Claude credential

The lanes' agents run on one of two Claude credentials ([plan 0009](plans/0009-release-channels-and-api-key.md) §9, §10): a **Claude subscription**'s token, `CLAUDE_CODE_OAUTH_TOKEN`, made with `claude setup-token`, which costs nothing beyond the subscription but shares its weekly limit with the person's own Claude use; or an **Anthropic API key**, `ANTHROPIC_API_KEY`, made in the [Claude Console](https://console.anthropic.com/settings/keys), billed per token and bounded by each run's dollar ceiling. Every model lane declares both under its `# ONE OF SECRETS:` marker, and **each caller `init` writes maps exactly one of them**, never both; the Merger, the reconciler, the dispatch sweep and the issue backstop run no model and map neither.

**It is inferred, not asked** (plan 0009, Owner decision 7). An installation keeps the credential its callers map ([#809](https://github.com/yedeya-labs/kanon/issues/809)): when every installed model lane's caller that maps one of the pair maps the same one, that one, whatever secrets the repository holds, so an installation on the key keeps it while the old token waits out its week (`secret.stale`), and one on the token keeps the token. Otherwise, a fresh installation or callers that map a mix, it comes from the secret names `init` already lists: `api-key` when the repository holds `ANTHROPIC_API_KEY` and not `CLAUDE_CODE_OAUTH_TOKEN`; `subscription` when it holds the token, both included; and `subscription` by default when it holds neither, or when the token can't list the secrets. The summary shows it as one line, `Claude`, with its consequence and where it came from: `flag`, `inferred` (`from the lanes' callers` or `from the repository's secrets`) or `default`. `--claude-auth subscription|api-key` sets it, and so does **Change something**'s sixth group at the terminal. `answers.claudeAuth` carries it, and the features' and the catalogue's `secrets` name the chosen credential. The step left to a person is `secret.claude-code-oauth-token` for the token, and `secret.anthropic-api-key` for the key, which says to make it in a Console workspace for CI alone with its own spend limit; both are stored in the person's own terminal, never through an agent's prompt.

**Switching later** is `kanon init --claude-auth api-key` (or `subscription`) from the checkout. `init` never rewrites a workflow, so each existing caller is reported as `differs`, its diff the one `secrets:` line, and its `content` the caller as it maps the new credential: write those on a branch and open a pull request, then store the new secret before it merges. Mixed credentials, the Reviewer on the key and the Implementer on the token, are allowed; `init` writes one choice for all.

### Where a lane's caller goes

A lane's caller goes at the lane's file name, `.github/workflows/<lane>.yml` (`K-LAYOUT-18`). In a repository that hosts Kanon's lanes, that path holds the lane itself, so its caller lives at another path, and the adoption record waives doctor's `caller.misplaced` finding on it ([`docs/doctor.md`](doctor.md#waiving-a-finding)). **`init` honours that waiver as the caller's path** ([#451](https://github.com/yedeya-labs/kanon/issues/451)): when the file at the lane's file name doesn't call the lane, and a `caller.misplaced` waiver under `## Choices` names a file that does, `init` compares the caller there instead, so a run offers the lane's caller at the path the record declares and counts the lane as installed. A file at the lane's file name that calls the lane stays its caller. A waiver of a file that doesn't exist yet, or calls another lane, names no lane, so the first time, take the caller's text from `files[].content` of its lane's file name (every caller's full text is there, whatever its status), write it at the path you choose, and add the waiver. No repository is special-cased.

`kanon apps` opens a browser for each App it creates, and waits for you to click Create and Install there. A program that wants to run that step on its own, for instance to explain it first, passes `--no-apps`: the command it would have run is then the finding `app.create`.

### The Lead's brief template

The Lead writes each brief from `docs/projects/_template.md`, which an adopter copies unchanged from Kanon's [`rulebook/templates/brief.md`](../rulebook/templates/brief.md) (`K-LAYOUT-11`). **`init` writes it wherever it writes the Lead's caller** ([#749](https://github.com/yedeya-labs/kanon/issues/749)): with the **Full pipeline** feature, or a customised set of lanes that holds `lead`, never with Review or Review + build. It copies the template of the release it runs from, and a template the repository has is the project's, `kept` and left alone. Without one, [`kanon doctor`](doctor.md) reports `lead.template-missing`, and with one that differs from the template of the release it checks, `lead.template-stale` ([#755](https://github.com/yedeya-labs/kanon/issues/755)): `init` doesn't replace a kept copy, so after an upgrade that changes Kanon's template, doctor is what says the copy is behind.

### The deploy lane

The deploy lane deploys your published releases to the environments your adoption record declares, in order, the last being production ([`docs/lanes.md`](lanes.md#the-deploy-lane), [plan 0010](plans/0010-deployment-lane.md) step D6). **It is not one of the features:** a repository that declares no environment has no deploy lane, and `init` writes nothing for it, no caller and no hook.

**The list** is `--deploy-environments`, comma-separated in deploy order (`--deploy-environments staging,production`), or else the list the adoption record's `## Deploy` section already declares, read through [`scripts/lib/deploy-declaration.mjs`](../scripts/lib/deploy-declaration.mjs), the section's one parser. `--deploy-environments none` declares none. The adopt skill asks it as an install question, with an answer it recommends from the repository's GitHub environments (`inspection.environments`) and the workflows that reference one (`inspection.deployWorkflows`), **None** among the options ([plan 0010](plans/0010-deployment-lane.md), open-question decision 2). At the terminal it isn't asked: the summary's `Deploy` line shows it, and **Change something**'s seventh group changes it. A record whose `## Deploy` section doesn't parse, or declares a name `init` couldn't write into the caller (one with a character other than letters, digits, `.`, `_` and `-`), stops `init` before it reads GitHub, naming the line, and nothing changes. `--deploy-environments` takes `none` in any case.

**What a declared list writes:**

- **The adoption record's `## Deploy` section,** after `## Data`, when `init` writes the record: the list, and the reference deploy at the first environment (`K-PROJ-11`, open-question decision 6), the caller's job for it as a run lists it:

  ```markdown
  ## Deploy

  - **Environments:** `staging`, `production`
  - **Reference environment:** `staging`
  - **Reference deploy workflow:** `deploy.yml`
  - **Reference deploy job:** `staging / deploy`
  ```

  A record the repository already has is the project's, as ever: when its list differs from the answer, the finding `deploy.declare` gives the bullets to write, in place of any list and reference bullets it has, its CI wait and fallback bullets kept.
- **The caller,** `.github/workflows/deploy.yml`, pinned to this release: a `release` job calling `deploy-release.yml` with the list, then one `deploy-<position>` job per environment, in order, calling `deploy.yml` with its environment, its position and `build: ${{ needs.release.outputs.build }}`, each needing `release` and the one before it (the first, `release` alone). Each job grants its workflow's permissions as the release's `requirements.json` lists them, and none maps a secret. **When the list changes, run `init` again: it rewrites the caller** (status `rewritten`, with its diff). A file at that path that calls no deploy lane is a deploy workflow of the project's own, which `init` leaves alone (`differs`), and then it writes **nothing** for the lane, no caller, no hook and no `## Deploy` section, since a reference deploy would name a job nobody writes: the finding `deploy.caller-taken` says so, and the summary's `Deploy` line says nothing was written. Move that workflow to another file name and run `init` again, or answer none. With no list, a deploy caller left behind is left alone too, with a note.
- **The three hooks' stubs,** `.github/actions/build/action.yml`, `.github/actions/deploy/action.yml` and `.github/actions/smoke/action.yml`, each declaring the inputs the lane passes, with one step that fails, naming its file, until you replace it with your build, your deploy command and your smoke check. **`init` never overwrites a hook**: one that exists is `kept`. Until each is filled, the finding `deploy.hooks` names it.

**The diagnose lane** (`agent-deploy-diagnose`, [`docs/lanes.md`](lanes.md#the-deploy-diagnose-lane), plan 0010 step D8) reads a failed deploy run and comments its diagnosis on the issue the deploy lane filed for each environment that failed. It is a model lane in no feature, so `init` writes its caller only when you name it, as for any lane outside the features: `--lanes …,deploy-diagnose`, or **Customise**. It follows the deploy caller by its name, so with no deploy environment declared, or where the deploy caller's path holds a workflow of the project's own, it is left out of the lanes, with a note saying which.

Each declared environment is a GitHub environment you create, production with its required reviewers, or the record's fallback marker where the plan has none ([`docs/lanes.md`](lanes.md#the-deploy-lane)); [`kanon doctor`](doctor.md) checks them.

## The token it needs

`init` reads and writes GitHub through `gh`, with `GH_TOKEN`, `GITHUB_TOKEN` or `gh`'s own login, in that order, so a `GH_TOKEN` left in the environment is the token that counts, whoever `gh auth status` says is signed in. It says whose token it used (`token`, below, and the summary), never the token, and the adopt skill asks the person to confirm it before anything is written ([#630](https://github.com/yedeya-labs/kanon/issues/630)). What it can't do with that token it leaves as a finding, the exact step for someone whose token can: labels and milestones need Issues: write, the merge settings and the ruleset Administration: write, and the secrets' names Secrets: read (`kanon apps` writes them, with Secrets: read and write). Every permission a person's fine-grained token needs for the adopt, doctor and upgrade skills, and the reads a fine-grained token can't do on a private repository, such as `gh pr checks`, are listed in one place: [`docs/doctor.md`, "A person's fine-grained token"](doctor.md#a-persons-fine-grained-token).

## The JSON output

`--json` prints one JSON document on standard output, and nothing else there; the prose a person reads goes to standard error, and `kanon apps` and `kanon milestones`, when `init` runs them, print theirs there too. It asks nothing, as `--yes`, and the run and its exit code are the ones the same flags give without `--json`.

**Its shape is a contract** ([ADR 0014](decisions/0014-adopter-audiences.md), decision 2): the agent skills that wrap `kanon init` and `kanon doctor`, and any integrator, build on it. It follows the convention every `kanon` command's JSON shares ([`docs/cli-json.md`](cli-json.md): the opening fields, the error document, the finding's shape), and is versioned by its `schema` field, `kanon-init/v1`:

- **Within a version,** fields, statuses and finding ids may be added, and a consumer ignores what it doesn't know. Nothing is removed, renamed, retyped or given another meaning.
- **Anything else is a new version,** `kanon-init/v2`, shipped in a breaking release and named in its release notes.

`tests/unit/kanon-init.test.ts` holds the document's fields, the statuses, the finding ids and the flags to the tables on this page.

### Decided by the Owner (2026-10-06)

- **`--json` runs the same run as without it,** `kanon apps` included: it opens a browser and waits for the person. A program that wants that step on its own passes `--no-apps`.
- **A standard input that isn't a terminal still needs `--yes` (or `--json`),** even when flags answer every question: which questions are asked depends on the repository.
- **Under `--json` the prose goes to standard error,** rather than nowhere, so a person watching the run still reads it.
- **The person's flag is `--project-owner`,** and `--owner` keeps meaning the GitHub account.

### The document

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `kanon-init/v1` |
| `kanon` | string | The release of the `init` that ran, `vX.Y.Z`: every reference it writes is pinned to it. |
| `status` | string | `complete`, `steps-left`, `failed` or `error`, below. |
| `exitCode` | number | The exit code: 0, 1 or 2. |
| `repository` | string | `<owner>/<repo>`. |
| `token` | object | `source` (`GH_TOKEN`, `GITHUB_TOKEN` or `gh`) and `login` (string or null): whose token `gh` used. Never the token. |
| `dryRun` | boolean | Whether it ran with `--dry-run`: then `files` and `changes` say what it *would* do, and nothing changed. |
| `inspection` | object | What it read, below. |
| `answers` | object | The answer to each question, from its flag, its default or the person, below. |
| `catalogue` | array | The lane catalogue, a group at a time, in the order the adopt skill asks them: what each lane does, needs and costs, and whether it is recommended for this repository, below. |
| `features` | array | The features `--feature` chooses from ([plan 0007](plans/0007-guided-install.md) §2), from the release's requirements file, in order, each containing the one before it, below. |
| `summary` | array | The summary `init` shows before it writes anything, one element per line, in its order, below. |
| `files` | array | Each file `init` writes, in the order it considers them, below. |
| `changes` | array | What it changed on the checkout and on GitHub, or in a dry run would, in the order the summary lists them, below. |
| `apps` | object | The `kanon apps` step, below. |
| `findings` | array | What is left to a person, in the order the summary numbers it: the finding shape of [`docs/cli-json.md`](cli-json.md). |
| `notes` | array | Strings: facts that block nothing, such as a merge queue the plan lacks or that the platform does not enforce review. |
| `failures` | array | Strings: what failed, when `status` is `failed`. |

| Status | Exit code | Meaning |
|---|---|---|
| `complete` | 0 | It ran, and nothing is left to a person. |
| `steps-left` | 0 | It ran, and `findings` lists what is left to a person. |
| `failed` | 1 | Something failed after it started changing things, or it stopped on an error it didn't expect (a file it couldn't write) once it had inspected the repository; `failures` says what. What it did before is still listed. |
| `error` | 1 or 2 | It stopped before inspecting the repository, on a usage error, an unreadable requirements file or an error it didn't expect, so nothing changed: the error document of [`docs/cli-json.md`](cli-json.md), `{ "schema", "kanon", "status", "exitCode", "error" }`. 2 is a usage error. |

### The inspection

| Field | Type | Meaning |
|---|---|---|
| `owner` | string | The account that owns the repository. |
| `ownerKind` | string | `user` or `organization`. |
| `private` | boolean | Whether the repository is private. |
| `defaultBranch` | string | Its default branch. |
| `hasCommits` | boolean | Whether the default branch has a commit. |
| `admin` | boolean | Whether the token can administer the repository. |
| `rulesets` | string | `yes`, `no` or `unknown`: whether the plan has rulesets. `no` means the platform can't enforce review (`K-ADOPT-3`). |
| `mergeQueue` | string | `yes`, `no` or `unknown`: whether the plan has the merge queue. |
| `defaultBranchMergeQueue` | boolean | Whether the default branch merges through a merge queue ([#452](https://github.com/yedeya-labs/kanon/issues/452)): an active ruleset on it has one, or, where none covers it yet, the ruleset `init` creates has one, because the plan has the queue. A lane's `mergeQueue`, in the catalogue, says what that changes for it. |
| `defaultBranchRulesets` | array | The names of the active rulesets on the default branch. |
| `inactiveRulesets` | array | Each `disabled` or `evaluate` ruleset on the default branch: `name` and `enforcement`. |
| `labels` | array | The repository's label names, sorted. |
| `milestones` | array | Its milestone titles, sorted. |
| `secrets` | array or null | Its secret names, sorted, or null when the token can't list them. |
| `installedLanes` | array | The lanes its callers already call, by file name without `.yml`. |
| `callsRelease` | boolean | Whether it calls Kanon's release workflow, which is what turns the Releaser on by default. |
| `environments` | array or null | The repository's GitHub environments, by name, as GitHub lists them; null when the token can't list them. The adopt skill recommends the deploy environments from them ([above](#the-deploy-lane)). |
| `deployWorkflows` | array | Each job of a workflow under `.github/workflows/` that references an environment: `workflow` (its path), `job` (its key) and `environment`, as written, an expression included. Empty when none does. |
| `idTokenHolders` | array | Every job of the checkout's workflows that holds `id-token: write`, counted and shaped as `kanon doctor` counts them (`workflow`, `job`, `grant`, `how`, `calls`, `status`, `reason`: [An id-token holder](doctor.md#an-id-token-holder)), with the acceptances `answers.acceptedIdTokenHolders` adds once `init` writes the adoption record ([above](#existing-id-token-holders)). Empty when no job holds it. |
| `codeowners` | array or null | The users `CODEOWNERS` (`.github/`, the root or `docs/`, the first that exists, as GitHub reads it) names for `*`, by login without `@`, from its last `*` line, teams and emails left out; null when there is no such file or no `*` line. One user is the Owner by default. |
| `ownerApps` | array or null | Kanon's Apps the owner already has ([#363](https://github.com/yedeya-labs/kanon/issues/363)): each of its App installations whose permissions are exactly an App's in `rulebook/agent-permissions.json`, that subscribes to no events, whose App is the owner's own (one `GET /apps/<slug>` answers 404 for, as it does a private App, or names the owner; never another account's, such as a public bot's, [#462](https://github.com/yedeya-labs/kanon/issues/462)), and whose App this register doesn't name, as `app` (`author`, `judge` or `releaser`), `slug` and `from`, `installation`. When the token can't list the installations (only an organisation's owner can, with its Administration permission (read), and on a personal account gh's token can't), they are read instead from the App registers (`docs/qa/agent-identities.md`, on the default branch) of the owner's other repositories the token can read, forks left out, since a fork's register names its upstream's Apps: each App such a register names that this one doesn't, and that is the owner's own as above, with `from` the register it was read from, `register:<owner>/<repo>` (plan 0007 step G4). Looked for only when the register lacks one of the Apps, so empty otherwise. Null when the token can't list the installations and no other register names one; `notes` then says so, and `init` creates the Apps as before. |
| `appsNotLookedFor` | array | The Apps the register lacks (`author`, `judge` or `releaser`) that `init` couldn't look for ([#652](https://github.com/yedeya-labs/kanon/issues/652)): when the token can't list the owner's installations, each one `ownerApps` doesn't name, since another repository's register naming some says nothing of the rest. Empty when the installations were listed, or the register lacks none. The adopt skill asks about each of these that a chosen lane runs as, whether the owner already has it, and `notes` says `Not looked for: …` whenever one of them is an App the chosen lanes need. |

### The answers

| Field | Type | Meaning |
|---|---|---|
| `projectOwner` | string | The project's Owner (`K-ADOPT-1` step 2). |
| `maintainer` | string | The Maintainer. |
| `stakeholder` | string | The Stakeholder. |
| `lanes` | array | The lanes to install, by file name without `.yml`. |
| `gates` | array | The stack's gates, in order; empty for none yet. |
| `testDatabase` | string | `none` or `hook`. |
| `delegation` | object or null | The sign-off delegation, `name` and `email`, or null. |
| `deleteDefaultLabels` | boolean | Whether to delete GitHub's default labels outside the taxonomy. |
| `releaser` | boolean | Whether to create the optional Releaser. |
| `reuseApps` | boolean or null | Whether to reuse the Apps in `inspection.ownerApps` that the chosen lanes need, with `kanon apps --reuse`, rather than create a second set; null when there was none to ask about. |
| `plugin` | boolean | Whether to declare the kanon plugin in `.claude/settings.json`, pinned to this release. |
| `telemetry` | boolean | Whether to send the repository's telemetry rows (agent-run, work-item, deploy and notify rows) to Kanon's hosted telemetry store, by writing the collector's caller, `.github/workflows/telemetry.yml` ([below](#telemetry)). |
| `upstreamFindings` | string | Where upstream findings go, as the adoption record's `Upstream findings:` choice writes it: `drafted`, `filed here`, `sent` or `sent with evidence` ([above](#upstream-findings)). |
| `upstreamEvidence` | boolean or null | Whether each sent finding also carries its evidence and suggested fix, as text; null when nothing is sent, so it wasn't asked. |
| `feature` | string | What Kanon does here: `review`, `build` or `full`, the feature whose lanes `lanes` holds, with no lane beyond them but its conditional ones, or `custom` when they make up none. The adoption record's `Feature:` bullet, written unless `custom` (`K-LAYOUT-10`). |
| `reviewTrigger` | string or null | Which pull requests the Reviewer reviews: `labelled`, only those labelled `review:please`, or `every-pr` once step G7 builds it; null without the review lane. The record's `Review trigger:` bullet. |
| `sensitiveData` | boolean or null | Whether the repository holds private or sensitive material, the record's `## Data` section; null when nobody declared it. |
| `consent` | string or null | The consent level ([above](#sharing)): `yes`, `codes` or `no`, from `--consent`, the question, or the level `telemetry` and `upstreamFindings` make; null for a combination no level names. |
| `acceptedIdTokenHolders` | array | The jobs the person accepted as id-token holders with `--accept-id-token-holder`, each `workflow` (its file name), `job` and `reason`; empty for none ([above](#existing-id-token-holders)). The adoption record's `Accepted id-token holder` bullets. |
| `deployEnvironments` | array | The deploy lane's environments, in deploy order, the last being production ([above](#the-deploy-lane)): from `--deploy-environments`, else the adoption record's `## Deploy` list; empty for none, which writes no `## Deploy` section, no caller and no hook. |
| `claudeAuth` | string | The Claude credential every caller maps ([above](#the-claude-credential)): `subscription`, `CLAUDE_CODE_OAUTH_TOKEN`, or `api-key`, `ANTHROPIC_API_KEY`; from `--claude-auth`, or inferred from what the installed callers map, else from the repository's secret names. It lands in the callers' `secrets:`, never in a declaration. |

### A feature

A fixed set of lanes `--feature` installs ([plan 0007](plans/0007-guided-install.md) §2, `docs/lanes.json`'s `features`), which the adopt skill builds its first question and the steps it hands over from.

| Field | Type | Meaning |
|---|---|---|
| `feature` | string | Its id, as `--feature` and `answers.feature` name it: `review`, `build` or `full`. |
| `title` | string | Its name, the question's option: `Review`, `Review + build` or `Full pipeline`. |
| `does` | string | The option's one-line consequence. |
| `lanes` | array | Its lanes, always installed with it, each feature's containing the one before it's. |
| `conditional` | array | Its lanes installed only where their condition holds: each `lane`, its `condition` in words, and `met`, whether it holds here (the hook it calls exists, or the repository holds the secret it takes), or the repository calls the lane already. |
| `leftOut` | array | The lanes it leaves out at install, each `lane` and `reason`. |
| `apps` | array | The Apps its lanes run as. |
| `secrets` | array | The secrets its lanes', and its conditional lanes', callers map, those a caller may leave unset aside; of the Claude pair, the one `answers.claudeAuth` names. |
| `steps` | array | Strings: what is left to a person, in words. |

### A summary line

One value `init` will install with, shown before it writes anything ([plan 0007](plans/0007-guided-install.md) §4). Nothing is silent: every answer is on a line.

| Field | Type | Meaning |
|---|---|---|
| `answer` | string | The line's name, such as `Feature`, `Sharing` or `People`. |
| `fields` | array | The `answers` fields the line shows, empty for one that says what `init` does rather than an answer, such as `Ruleset` or `Files`. |
| `value` | string | The value, as the summary prints it. |
| `source` | string | Where it came from: `flag`, `inferred` or `default`; at the terminal, `asked` too. `init` can't know whether a person or a program gave a flag, so the adopt skill shows `flag` as asked. |
| `reason` | string | What it was inferred from, or why it is the default, such as `from CODEOWNERS`; empty when there is nothing to add. |

### The lane catalogue

What `--lanes` chooses from, so a person, or the adopt skill asking them, can choose knowing what each lane does ([#428](https://github.com/yedeya-labs/kanon/issues/428)). It is [`docs/lanes.json`](lanes.json), the one source `kanon init --help` and [`docs/lanes.md`](lanes.md#the-lane-catalogue) also read, with what the release's requirements file derives from each lane beside it. Each element is a group:

| Field | Type | Meaning |
|---|---|---|
| `group` | string | The group's id, such as `review`. |
| `title` | string | Its name, such as `Implement and revise`. |
| `header` | string | A short name for it, at most 12 characters. |
| `lanes` | array | Its lanes, at most four, below. |

### A catalogue lane

| Field | Type | Meaning |
|---|---|---|
| `lane` | string | The lane, by file name without `.yml`, as `--lanes` and `answers.lanes` name it. |
| `name` | string | Its name in docs/lanes.md. |
| `does` | string | What it does, in one sentence. |
| `app` | string or null | The App it runs as, `author` or `judge`, or null for none. |
| `secrets` | array | The secrets its caller maps; of the Claude pair, the one `answers.claudeAuth` names. |
| `qaStore` | boolean | Whether it reaches the QA store, through a hook you write, and runs without memory when there is none. |
| `hooks` | array | The hooks it calls besides the project-setup hook, by path. |
| `reads` | array | The project documents it reads (`K-LAYOUT-17`). |
| `schedule` | string or null | The cron its caller is written with, or null when it runs on events alone. |
| `needs` | array | Strings: what else it needs, such as project briefs. |
| `cost` | string | What it costs to run, in one sentence: whether it runs a model, and how often. |
| `minutes` | string | The GitHub Actions runner-minutes it used a day on Kanon's own repository, in one sentence, or that it wasn't measured ([`docs/actions-minutes.md`](actions-minutes.md), [#581](https://github.com/yedeya-labs/kanon/issues/581)). |
| `when` | string | When it is recommended, in one sentence. |
| `mergeQueue` | string or null | What a merge queue on the default branch changes for it, in one sentence, or null when nothing ([#452](https://github.com/yedeya-labs/kanon/issues/452)): a merge through the queue doesn't start a lane that runs on CI finishing on the default branch, unless its caller also runs on the merged pull request, as the rebase lane's does ([#484](https://github.com/yedeya-labs/kanon/issues/484)). |
| `recommendedWith` | array | The lanes whose choice makes it recommended; empty for none. |
| `recommended` | boolean | Whether it is recommended for this repository: the repository calls it already, it is the review lane, or it is recommended with a lane that is. |
| `installed` | boolean | Whether the repository calls it already (`inspection.installedLanes`). |

### A file

| Field | Type | Meaning |
|---|---|---|
| `path` | string | From the checkout's root. |
| `status` | string | `new` (written, or in a dry run would be), `same` (already as `init` writes it), `kept` (a declaration, the brief template or a hook, that is the project's, left alone), `rewritten` (the deploy lane's caller, rewritten from the declared list, or in a dry run would be, [above](#the-deploy-lane)) or `differs` (a workflow that differs from what `init` would write, left alone). |
| `content` | string or null | What `init` writes, or would write, whatever the file's status ([#451](https://github.com/yedeya-labs/kanon/issues/451)): for a `differs` file it is the full text the diff compares with, so a program can write it at another path. Null only for a `kept` file, whose content is the project's to say. |
| `diff` | array | Strings: for a file that `differs` or is `rewritten`, the lines that differ, `- ` for the file's and `+ ` for what `init` would write. |

### A change

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | `file`, `label`, `label-deleted`, `milestone`, `merge-settings`, `ruleset` or `apps`. |
| `subject` | string | What changed: a path, a label, a milestone, the repository, the default branch, or the Apps. |
| `message` | string | The summary's line for it. |

### The Apps

| Field | Type | Meaning |
|---|---|---|
| `identities` | array | The Apps the chosen lanes run as, and the Releaser if asked for. |
| `missing` | array | Those the App register lacks. |
| `reuse` | array | Those of the missing ones the owner already has and the person chose to reuse, each `app`, `slug` and `appId`, the App's ID from its installation, or null when that isn't known, as for an App only a register names: each is a finding `app.reuse`, its `kanon apps --reuse` command with the slug filled in, and the App ID when known, in place of `<App ID>` ([#640](https://github.com/yedeya-labs/kanon/issues/640)). |
| `command` | string or null | The `kanon apps` command for the missing ones it creates. |
| `outcome` | string | `none` (the lanes run as no App), `registered` (the register lists them all), `reuse` (the owner has every missing one, and the person chose to reuse them: the findings `app.reuse`), `would-run` (a dry run), `ran`, `left-to-you` (`--no-apps`, or the person said no: the finding `app.create`) or `failed`. With some reused and some created, it is the outcome of creating them. |
| `exitCode` | number or null | `kanon apps`'s exit code, when `init` ran it. |

### The findings

Every finding is non-blocking, except `app.failed`: `blocking` means it makes the exit code 1, as in `kanon doctor`. A step that is left to a person still matters, which is what `steps-left` says.

| Id | Category | When |
|---|---|---|
| `dependabot.kanon-entry` | `dependabot` | `.github/dependabot.yml` exists without the entry that proposes Kanon upgrades. |
| `label.create` | `label` | The token could not create some of the taxonomy's labels. |
| `label.delete-default` | `label` | The token could not delete a default label it was asked to. |
| `milestone.buckets` | `milestone` | `kanon milestones` did not create the bucket milestones. |
| `merge.settings` | `merge` | The token could not set squash-only merging. A token that can't read the merge settings (GitHub leaves them out of its answer without Administration: read) gets a note saying they are not known, and `init` neither checks nor changes them. |
| `ruleset.gaps` | `ruleset` | The default branch's ruleset lacks some of `K-ADOPT-1` step 8. |
| `ruleset.first-commit` | `ruleset` | The default branch has no commit yet, so no ruleset was created. |
| `ruleset.create` | `ruleset` | The token could not create the default branch's ruleset. |
| `ruleset.require-check` | `ruleset` | No job of a workflow on the default branch reports the status check `Lane check` on every pull request yet (and, where the default branch merges through a merge queue, on its `merge_group` run too, [#459](https://github.com/yedeya-labs/kanon/issues/459)), or the token can't read the default branch's workflows, so the ruleset doesn't require it: a required check that nothing reports blocks every other pull request ([#444](https://github.com/yedeya-labs/kanon/issues/444)). Its subject is the check's name. It is a step for after the merge of the pull request that adds the job, never before: run `kanon init` again with a token that can administer the repository, which adds only that rule, or add it on the fix's page. |
| `app.create` | `app` | The Apps the lanes need were not created: `--no-apps`, or the person said no. When the token can't list the owner's installations, its fix also says how to reuse such an App instead, generating its key under Credentials → Key pairs → New key on its settings page. |
| `app.failed` | `app` | `kanon apps` did not finish. |
| `app.reuse` | `app` | The register lists an App, but the repository lacks its secrets; or the owner already has an App the register lacks, and the person chose to reuse it. Its fix says where the key is made, Credentials → Key pairs → New key on the App's settings page, with GitHub's page on it ([#637](https://github.com/yedeya-labs/kanon/issues/637)), and names each other App of the owner's with the same permissions once, as `<slug> (App ID <id>)` when its ID is known ([#653](https://github.com/yedeya-labs/kanon/issues/653)). |
| `secret.claude-code-oauth-token` | `secret` | The callers map the subscription's token, and the repository lacks `CLAUDE_CODE_OAUTH_TOKEN`. |
| `secret.anthropic-api-key` | `secret` | The callers map the API key (`answers.claudeAuth` is `api-key`), and the repository lacks `ANTHROPIC_API_KEY`. The fix makes it in the Claude Console, in a workspace for CI alone with its own spend limit (its `url`), and stores it in the person's own terminal. |
| `secret.digest-webhook` | `secret` | The repository lacks `DIGEST_WEBHOOK`. |
| `secret.qa-store` | `secret` | The repository has a QA store hook (`.github/actions/qa-store/action.yml`), and lacks `QA_STORE_ROLE_ARN` or `QA_STORE_BUCKET`, the store's coordinates, which the store-coupled lanes take as secrets ([#433](https://github.com/yedeya-labs/kanon/issues/433)). The fix stores each, copying it from a repository variable of the same name where one holds it. A repository without a hook is asked for neither. |
| `secret.unreadable` | `secret` | The token can't list the repository's secret names. Its fix names each secret the chosen lanes map, the QA store's two only where the store hook exists, as for `secret.qa-store` ([#480](https://github.com/yedeya-labs/kanon/issues/480)). |
| `id-token.unaccepted` | `id-token` | A job of the checkout's workflows holds `id-token: write`, so on the default branch it can assume the QA store's role and the telemetry writer, and the adoption record doesn't accept it: `kanon doctor`'s own finding, which blocks there ([above](#existing-id-token-holders)). Its fix is to narrow the job's grant, or to accept it with `--accept-id-token-holder`, or, where the record is the project's already, with the bullet the fix gives. |
| `deploy.caller-taken` | `deploy` | Deploy environments are declared, and `.github/workflows/deploy.yml` is a deploy workflow of the project's own, which calls no Kanon deploy lane: `init` wrote nothing for the lane ([above](#the-deploy-lane)). The fix is to move that workflow to another file name and run `init` again, or to answer none. |
| `deploy.declare` | `deploy` | The adoption record exists, so it is the project's, and its `## Deploy` section declares another list than `answers.deployEnvironments`: the fix gives the bullets to write, the list and the reference deploy at its first environment, or, for none, says to remove the list ([above](#the-deploy-lane)). |
| `deploy.hooks` | `deploy` | A deploy hook is still the stub `init` wrote, which fails the deploy lane by name: its subject names each, and the fix says to replace each stub's step with your own. |
| `plugin.declare` | `plugin` | `.claude/settings.json` exists, and doesn't declare the kanon plugin at this release: the file is the project's, so `init` leaves it alone, and the fix lists the keys to merge into it. |
