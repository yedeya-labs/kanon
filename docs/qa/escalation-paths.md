# Escalation paths

Kanon's escalation file (`K-LAYOUT-8`), declared the way any adopter declares one. Since 2026-10-12 Kanon runs its full suite, the Merger with it, and the Merger merges an Implementer pull request the Reviewer approved only when it touches none of the paths that go to the Owner ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), as amended that day). The Merger reads this file from the default branch (`K-MERGE-17`), so a pull request that changes it is judged without the change, and the file is directly inside `docs/qa/`, so that pull request goes to the Owner too.

Three tiers decide who merges a pull request here:

- **Always the Owner, fixed by `K-MERGE-4`, so not declared here:** every file under `.github/`, every markdown file directly inside `docs/qa/`, `AGENTS.md`, `CLAUDE.md` and `.claude/`.
- **The Owner, by Kanon's choice:** the paths below, each marked `always`, so they stay with the Owner although the adoption record declares Kanon's production promotion human-gated (`K-MERGE-4`, `K-LAYOUT-10`). Every entry Kanon declares is marked, so that declaration widens nothing here: it records where the human gate on what reaches adopters is, the weekly release pull request.
- **Green, everything else:** the Merger may merge it, notably `docs/` outside `docs/qa/`, `docs/decisions/`, `docs/plans/` and `docs/metrics/`, `README.md`, `tests/`, and `cli/`, `scripts/metrics/` and the rest of `scripts/` except the files below.

## Escalation paths

What Kanon is, and what it promises:

- `^rulebook/` `other` `always` — the rules every adopter is held to, and `agent-permissions.json`, the grant each App holds; a change to a rule is the Owner's (`K-PRIN-*`, ADR 0002)
- `^docs/decisions/` `other` `always` — the decision records, which only the Owner decides
- `^docs/plans/` `other` `always` — the plans and the Owner's decisions in them
- `^skills/` `playbooks` `always` — the agent skills adopters install, which drive `kanon init` and `kanon doctor` for them
- `^\.claude-plugin/` `playbooks` `always` — the plugin manifest that ships the skills to adopters
- `^actions/` `pipeline` `always` — the composite actions every lane runs, the checks that judge a pull request among them (`dco`, `pr-title`, `lane-check`), the token minting in `agent-setup` and the scrub in `agent-telemetry`
- `^(LICENSE|NOTICE|TRADEMARK\.md)$` `other` `always` — the licence and the trademark policy (ADR 0010)

What ships, and when:

- `^package\.json$` `other` `always` — the release's version, its dependencies and the gate commands CI runs
- `^package-lock\.json$` `other` `always` — the dependency tree every gate and every adopter's CLI installs
- `^release-please-config\.json$` `other` `always` — how a release is cut, which keeps the release pull request the human gate
- `^\.release-please-manifest\.json$` `other` `always` — the version the next release is cut from
- `^requirements\.json$` `other` `always` — what this release asks of an adopter: the permissions its callers grant and the secrets they map, which `kanon init` writes and `kanon doctor` checks
- `^(eslint\.config\.js|vitest\.config\.ts|tsconfig(\.[a-z]+)?\.json)$` `pipeline` `always` — the configuration of the required `Lint, type-check and unit tests` check, which a change could hollow out while the check keeps its name (`K-MERGE-4`)

The hosted stores' trust and code:

- `^infra/telemetry/template\.yaml$` `infra` `always` — the telemetry store's template: its tables' resource policies, its functions' URLs and the roles and aliases that reach them (no role trusts GitHub's OIDC provider since plan 0008 J9)
- `^infra/telemetry/function/` `infra` `always` — the ingest function, the only code that writes the telemetry table and decides the one key a call may write (on `live`, the key of the registration the token's `repository_id` claim finds, or the Owner's `import` and `backfill` aliases' `{ key, rows }` event), and the aggregate function, which publishes only what at least three adopters contribute to
- `^infra/qa-store/aws/(template\.yaml|provision\.mjs)$` `infra` `always` — the QA store's template and its provisioner, which set the role and the exact subjects it trusts
- `^infra/status/` `infra` `always` — the hosted status server: what it reads with the token a person signs in with, and the status App's sign-in that issues it (project #1327)

The library scripts that decide a verdict, gate a lane, mint or narrow what a token can do, or scrub what leaves a repository:

- `^scripts/merge-gate\.mjs$` `pipeline` `always` — the Merger: its verdict function and its merge step
- `^scripts/lib/escalation-paths\.mjs$` `pipeline` `always` — the parser of this file, which decides which paths escalate
- `^scripts/lib/production-promotion\.mjs$` `pipeline` `always` — whether a human-gated promotion widens the green zone
- `^scripts/lib/declarations\.mjs$` `pipeline` `always` — the shared reader of the adopter's declaration files, and of their copy on the default branch
- `^scripts/spec-lib\.mjs$` `pipeline` `always` — the fence reader the escalation parser and the App register read with, and the spec grammar the spec-promotion check reads
- `^scripts/lib/spec-promotions\.mjs$` `pipeline` `always` — the check that sends a spec promotion to a human (`K-SPEC-9`)
- `^scripts/lib/protocol-spellings\.mjs$` `pipeline` `always` — the caller names by which the Merger leaves its own and the review event's checks out of the checks it waits on
- `^scripts/review-trailer\.mjs$` `pipeline` `always` — which commit a review read, which the Merger holds an approval to
- `^scripts/judging-inputs\.mjs$` `pipeline` `always` — the inputs a judging lane reads from the default branch, never from the pull request (`K-MERGE-17`)
- `^scripts/restore-judging-inputs\.sh$` `pipeline` `always` — the step that restores those inputs before the Reviewer runs
- `^scripts/incremental-review\.mjs$` `pipeline` `always` — how much of a pull request a re-review reads
- `^scripts/lane-gate\.mjs$` `auth` `always` — the membership gate every lane runs before it mints a token (`K-AGENT-45`)
- `^scripts/caller-pin\.mjs$` `pipeline` `always` — which Kanon release a lane runs, with its token, when started from another branch
- `^scripts/app-register\.mjs$` `auth` `always` — the App logins, read from the register, by which the gates tell an agent's work from a person's
- `^scripts/lib/role-marker\.mjs$` `auth` `always` — the role marker and the implementer status the Merger requires on a head
- `^scripts/lib/oidc-subject\.mjs$` `auth` `always` — the OIDC subject the store roles trust
- `^scripts/lib/finding-rows\.mjs$` `pipeline` `always` — how a finding's text goes through the scrub before it leaves a repository
- `^scripts/upstream-names\.mjs$` `pipeline` `always` — the names the scrub removes from a finding
- `^scripts/telemetry-collect\.mjs$` `pipeline` `always` — the collector, which holds the telemetry writer's credentials and decides which rows, and which findings at which level, leave a repository
- `^scripts/lib/telemetry-token\.mjs$` `auth` `always` — the telemetry store's token client (plan 0008 §2.1): which URL a GitHub OIDC token minted for the store's audience is sent to, and its mask; the collector, the Overseer's read, the Explorer's and the metrics page's import it
- `^scripts/telemetry/jev\.mjs$` `pipeline` `always` — the decision whether a private upstream finding becomes a public issue
- `^scripts/lane-push\.mjs$` `pipeline` `always` — the spine's, the rebase lane's and the Lead's split lane's push jobs: which of an agent's branches it moves, from which head, the pull request it opens from the agent's request, the one merge the rebase lane may push, and the dead split branch the split lane replaces (`[LANE-13]` to `[LANE-18]`)
- `^scripts/lib/verified-commits\.mjs$` `pipeline` `always` — the verified-commit helper: which commits GitHub creates, and signs, as an Author lane's App, and when it moves a branch to them (`[LANE-6]` to `[LANE-11]`)
- `^scripts/lib/branch-path\.mjs$` `pipeline` `always` — imported by the verified-commit helper and the implementer status's re-delivery, and run by the revise lanes' fingerprint: the REST path a branch name becomes, so a `#` or a `%` in it can't name another ref (kanon#1432)
- `^scripts/status/` `pipeline` `always` — the status core: the reads a person's token makes, which must stay reads, behind the hosted server and the `kanon status` command (project #1327)

Code Kanon's own workflows run from this tree, on the branch they run on, with a credential. Kanon's lanes run the library at the release their callers pin, but five workflows don't, so each entry file and every local file it imports, directly or through another, is the Owner's; the scripts above already cover the rest of their imports (`lane-gate.mjs`, `caller-pin.mjs`, `app-register.mjs`, `declarations.mjs`, `spec-lib.mjs`, `escalation-paths.mjs`, `production-promotion.mjs`, `protocol-spellings.mjs`), and `actions/`, `infra/telemetry/function/` and `.github/` cover theirs:

`apps-check.yml`, dispatched, runs `cli/apps-check.mjs` with each App's private key. `release-please.yml`'s `pins` job, after a candidate is cut, runs `scripts/move-pins.mjs`, checks the moved callers with `scripts/pin-lane-check.mjs`, which runs `actions/lane-check/lane-check.sh` and the library files its Node imports, and then opens the pin pull request with the Releaser's key. `metrics-page.yml`'s `aggregate` job runs `scripts/aggregate-read.mjs` with an OIDC token for the telemetry store, and its `page` job runs `scripts/telemetry/kanon-health.mjs` and `.github/scripts/metrics-page.mjs`, then `actions/agent-setup/agent-commits.sh`, and creates its commit with the Author's token through the verified-commit helper, `scripts/lib/verified-commits.mjs`, which imports `scripts/lib/branch-path.mjs` and `scripts/lib/cli-entry.mjs` ([#1385](https://github.com/yedeya-labs/kanon/issues/1385)). `promote.yml`, daily and dispatched, runs `scripts/promote.mjs`, which reads the promotion's gates and, when they pass, tags a stable release and moves the major tag with the Releaser's token (plan 0009 S5), then runs `scripts/doc-pins.mjs` and opens the pull request that points the docs at it, with the same token; its last step, `promote.mjs notify`, writes the held issue with the workflow token's Issues write. `agent-lanes-smoke.yml`, on the push to `main`, runs the jobs of its lanes that a push can start: their store-cleanup jobs (`actions/qa-store/qa-store.mjs`) with the workflow token's write grants; the lanes' other jobs, the implement-revise lane's implementer status (`actions/implementer-status`, which imports the role marker) among them, take their secrets from one that doesn't exist and hold a read grant alone, as their admission jobs (`scripts/lane-gate.mjs`) do. A lane caller pinned to a release runs this tree only through its lanes' `uses: ./` steps, the project-setup hook under `.github/actions/`, whose `npm ci` reads `package.json`. Every other run of this tree's code holds no secret, no role and no write grant (`ci.yml`, `citation-shift.yml`, `public-text.yml` and the other smoke runs), or runs a pull request's own code before anything merges, which no escalation path can guard; every lane caller runs the pinned release. `tests/unit/credential-reach-guard.test.ts` holds this ([#730](https://github.com/yedeya-labs/kanon/issues/730)): it walks every workflow a push, a schedule or a dispatch starts here, into the reusable workflows and composite actions each one runs from this tree (and, in a lane called at a release, its `uses: ./` steps), reads each job's `if:` under those events, and follows each job that holds a secret (its own, its workflow's top-level `env:`, or one its caller maps), a token minted from one that a job it needs hands it in an output, as a lane spine maps its agent job the App token ([#831](https://github.com/yedeya-labs/kanon/issues/831)), a write grant or `id-token: write` into the files it runs and everything they import, directly or through another. A file none of the entries below matches turns it red, naming the file and the workflow, and so does an `npm`, `npx`, `pnpm` or `yarn` command in such a job that runs a `package.json` script the guard doesn't follow ([#814](https://github.com/yedeya-labs/kanon/issues/814)), so a new import or a new step that widens what a green-zone merge can change in such a job fails before it merges.

- `^cli/apps-check\.mjs$` `auth` `always` — the App check `apps-check.yml` runs with each App's private key
- `^cli/apps\.mjs$` `auth` `always` — imported by the App check: each App's permissions, read from the rulebook
- `^cli/app-register\.mjs$` `auth` `always` — imported by the App check: the register rows it holds the Apps to
- `^cli/gh-token\.mjs$` `auth` `always` — imported by the App check: the token it calls GitHub with
- `^cli/ruleset-bypass\.mjs$` `auth` `always` — imported by the App check: the ruleset bypass it reads
- `^scripts/lib/app-extras\.mjs$` `auth` `always` — imported by the App check: the extra App permissions the adoption record declares, which widen what an App is held to (`K-AGENT-3`)
- `^scripts/move-pins\.mjs$` `pipeline` `always` — the pin job's edit: `release-please.yml`'s `pins` job runs it with the Releaser's key, and opens the pull request that moves Kanon's pins to a candidate (plan 0009 S4)
- `^scripts/pin-lane-check\.mjs$` `pipeline` `always` — the pin job's check of the moved callers: it runs the candidate's `lane-check` on them, and its list decides whether the pin pull request opens as a draft (kanon#1074)
- `^scripts/lib/(capability-watch|deploy-declaration|digest-audience|exemptions|overseer-install|reference-deploy|upstream-findings)\.mjs$` `pipeline` `always` — imported by the pin job's check, through `lane-check` (`actions/lane-check/lane-check.mjs` and its `declarations.mjs`): the declarations lane-check reads
- `^scripts/lib/cli-entry\.mjs$` `pipeline` `always` — imported by every entry here: whether a module runs as a command
- `^scripts/lib/code-areas\.mjs$` `pipeline` `always` — imported by the membership gate
- `^scripts/lib/test-conventions\.mjs$` `pipeline` `always` — imported by the membership gate, through the code areas
- `^scripts/aggregate-read\.mjs$` `infra` `always` — the metrics page's aggregate read, with an OIDC token for the telemetry store
- `^scripts/telemetry/kanon-health\.mjs$` `pipeline` `always` — the metrics page's health figures, which its job publishes with the Author's token
- `^scripts/telemetry/kanon-bugs\.mjs$` `pipeline` `always` — imported by the health figures
- `^scripts/telemetry/kanon-findings\.mjs$` `pipeline` `always` — imported by the health figures
- `^scripts/telemetry/holds-key\.mjs$` `pipeline` `always` — imported by the health figures, through `kanon-findings.mjs`, and by Jev's decision; also linked into the ingest function under `infra/telemetry/function/`, so a change to it changes deployed function code
- `^scripts/metrics/(band|compare|health|indicators|join|stats)\.mjs$` `pipeline` `always` — imported by the metrics page and its health figures; all but `health.mjs` are also linked into the telemetry functions under `infra/telemetry/function/`, so a change to them changes deployed function code (`compare.mjs`, the release comparison's core, since [#1453](https://github.com/yedeya-labs/kanon/issues/1453))
- `^scripts/lib/token-trend\.mjs$` `pipeline` `always` — the size-controlled fit (`fitPeriodEffect`), linked into the telemetry functions under `infra/telemetry/function/` for the page view's release comparison ([#1453](https://github.com/yedeya-labs/kanon/issues/1453)), so a change to it changes deployed function code
- `^scripts/promote\.mjs$` `pipeline` `always` — the promotion `promote.yml` runs, which decides whether a candidate becomes the stable release adopters' Dependabot proposes, and tags it with the Releaser's token (plan 0009 S5)
- `^scripts/doc-pins\.mjs$` `pipeline` `always` — the docs' pins: `promote.yml` runs it with the Releaser's key and opens the pull request that points the README's install command and the docs' `uses:` lines at the new stable release
- `^scripts/metrics/(areas|detectors)\.mjs$` `pipeline` `always` — imported by the promotion: the revert detector and the `Introduced by` reader its gates read, and the code areas the detectors import
- `^scripts/lib/reverts\.mjs$` `pipeline` `always` — imported by the promotion, through the detectors: what a revert says it reverts; the Lead's reconciler reads it too
- `^scripts/lib/search\.mjs$` `pipeline` `always` — imported by the promotion and the metrics page's health figures: when a GitHub search's answer is trusted, which decides whether the soak finds the pin pull request (kanon#1322)

Code linked into the hosted status server. Its handler under `infra/status/` serves the status core under `scripts/status/`, and the core calls the deciders the lanes run rather than copying them (project #1327, decision 10), so every local module the server links, directly or through another, is deployed function code: a change to one reaches the server through the release pull request and the Owner's deploy dispatch, which are human gates but don't read it. The Owner decided on 2026-10-26 to escalate the whole closure, as the telemetry functions' is (`holds-key.mjs` and `scripts/metrics/` above), rather than only `scripts/status/` and `infra/status/` ([#1345](https://github.com/yedeya-labs/kanon/issues/1345)). So a change to the reconciler, review recovery, workflow health, the brief guard or anything they import is the Owner's merge. The entries above cover the rest of the closure (`merge-gate.mjs`, `app-register.mjs`, `spec-lib.mjs`, `declarations.mjs`, `actions/` and others). `tests/unit/hosted-function-closure.test.ts` holds this: from every code file under `infra/status/` and `infra/telemetry/function/` it follows each static `import` and `export … from`, each dynamic `import()` with a literal specifier (`views.mjs` loads two views that way) and each `new URL(…, import.meta.url)` (the promotion view's worker), and turns red on a linked module no `always` entry matches, and on a load whose specifier isn't a literal. The waiver reader the lane-caller read was moved out of `cli/doctor.mjs` into `scripts/lib/waivers.mjs` for this, so the server links neither doctor nor `kanon init`.

- `^scripts/(lead-reconcile|project-closure|split-lineage|dispatch-sweep)\.mjs$` `pipeline` `always` — the Lead's reconciler, whose phase the project view reports and whose reads the needs-owner and release views share, and what the project view reads with it: a project's closure, a split's lineage and the dispatch sweep; linked into the hosted status server (#1345)
- `^scripts/(review-recovery|review-run-evidence|revise-run-evidence|rebase-lane|lane-retry|conflict-state|closing-refs)\.mjs$` `pipeline` `always` — the readiness view's deciders: review recovery's verdict on a head, the review and revise lanes' run evidence, the rebase lane, a lane's retry evidence, a pull request's conflict state and the issues it closes, which the Merger reads too; linked into the hosted status server (#1345)
- `^scripts/(brief-guard|citation-guard|verify-acs|spec-coverage|locked-set|issue-triage-defaults)\.mjs$` `pipeline` `always` — the brief guard's open-decision read, and what it and the views read acceptance criteria and specs with: the citation guard, the criteria verifier, spec coverage and its locked set, and the triage defaults; linked into the hosted status server (#1345)
- `^scripts/workflow-health\.mjs$` `pipeline` `always` — the lane-health view's classifier of a workflow's runs; linked into the hosted status server (#1345)
- `^scripts/project-digest\.mjs$` `pipeline` `always` — the project digest, whose read of what waits on the Owner the needs-owner view shares; linked into the hosted status server (#1345)
- `^scripts/metrics/release\.mjs$` `pipeline` `always` — whether a pull request is a release pull request, which the release view reads; linked into the hosted status server (#1345)
- `^scripts/lib/(lane-caller|waivers|schedule-silence|labels|milestones|fix-commands|notify-contract|telemetry-artifacts)\.mjs$` `pipeline` `always` — the libraries those deciders import: which workflows call a lane and the waivers the adoption record declares, a schedule's silence, the label taxonomy, the milestones, the known fix commands, the notification contract and a lane's telemetry artifacts; linked into the hosted status server (#1345)
- `^cli/workflow-yaml\.mjs$` `pipeline` `always` — the YAML reader the lane-caller and the schedule heartbeat read workflows with; linked into the hosted status server (#1345)
- `^infra/qa-store/aws/(cost-rows|keys)\.mjs$` `infra` `always` — the QA store's cost-row query and its keys, which the dispatch sweep imports; linked into the hosted status server (#1345)

The published metrics page:

- `^docs/metrics/` `other` `always` — the public metrics page, whose figures are published in Kanon's name (plan 0003 M7)

## Pipeline code

None. Kanon's own pipeline scripts are `.github/scripts/`, under `.github/`, which escalates whatever this file says. `scripts/` is Kanon's library, and a library that the project's own lanes run only at a pinned release is product, not pipeline code (`K-MERGE-4`): Kanon's lanes run the copy at the release their callers pin ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)), and a change there reaches them only through the release pull request and Dependabot's bump of the pins, both of which go to the Owner. Five of Kanon's own workflows do run this tree's code with a credential, `apps-check.yml`, `metrics-page.yml`, `promote.yml`, `agent-lanes-smoke.yml` and `release-please.yml` (above); their entry files and every local file those import are marked `always` above. So `scripts/` is not declared as pipeline code, which would send all of it to the Owner; its scripts that decide a verdict, gate a lane, touch a token, scrub what leaves, run from this tree with a credential, or are linked into a hosted function are declared one by one above.
