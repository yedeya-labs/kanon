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

- `^infra/telemetry/(template\.yaml|render\.mjs)$` `infra` `always` — the telemetry store's template and its renderer, which write each adopter's writer and reader roles and the subject each trusts
- `^infra/telemetry/function/` `infra` `always` — the ingest function, the only code that writes the telemetry table and maps a signed role to the one key it may write, and the aggregate function, which publishes only what at least three adopters contribute to
- `^infra/qa-store/aws/(template\.yaml|provision\.mjs)$` `infra` `always` — the QA store's template and its provisioner, which set the role and the exact subjects it trusts

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
- `^scripts/aggregate-mask\.mjs$` `pipeline` `always` — the masking of the aggregate function's URL and the account id in a role's ARN in every log
- `^scripts/telemetry-collect\.mjs$` `pipeline` `always` — the collector, which holds the telemetry writer's credentials and decides which rows, and which findings at which level, leave a repository
- `^scripts/lib/telemetry-token\.mjs$` `auth` `always` — the telemetry store's token client (plan 0008 §2.1): which URL a GitHub OIDC token minted for the store's audience is sent to, and its mask; the collector, the Overseer's read, the Explorer's and the metrics page's import it
- `^scripts/telemetry/jev\.mjs$` `pipeline` `always` — the decision whether a private upstream finding becomes a public issue

Code Kanon's own workflows run from this tree, on the branch they run on, with a credential. Kanon's lanes run the library at the release their callers pin, but five workflows don't, so each entry file and every local file it imports, directly or through another, is the Owner's; the scripts above already cover the rest of their imports (`lane-gate.mjs`, `caller-pin.mjs`, `app-register.mjs`, `declarations.mjs`, `spec-lib.mjs`, `aggregate-mask.mjs`), and `actions/`, `infra/telemetry/function/` and `.github/` cover theirs:

`apps-check.yml`, dispatched, runs `cli/apps-check.mjs` with each App's private key. `release-please.yml`'s `pins` job, after a candidate is cut, runs `scripts/move-pins.mjs` and then opens the pin pull request with the Releaser's key. `metrics-page.yml`'s `aggregate` job runs `scripts/aggregate-read.mjs` under the aggregate invoker role, and its `page` job runs `scripts/telemetry/kanon-health.mjs` and `.github/scripts/metrics-page.mjs`, then `actions/agent-setup/agent-commits.sh`, and pushes with the Author's token. `promote.yml`, daily and dispatched, runs `scripts/promote.mjs`, which reads the promotion's gates and, when they pass, tags a stable release and moves the major tag with the Releaser's token (plan 0009 S5). `agent-lanes-smoke.yml`, on the push to `main`, runs the jobs of its lanes that a push can start: their store-cleanup jobs (`actions/qa-store/qa-store.mjs`) with the workflow token's write grants; the lanes' other jobs, the implement-revise lane's implementer status (`actions/implementer-status`, which imports the role marker) among them, take their secrets from one that doesn't exist and hold a read grant alone, as their admission jobs (`scripts/lane-gate.mjs`) do. A lane caller pinned to a release runs this tree only through its lanes' `uses: ./` steps, the project-setup hook under `.github/actions/`, whose `npm ci` reads `package.json`. Every other run of this tree's code holds no secret, no role and no write grant (`ci.yml`, `citation-shift.yml`, `public-text.yml` and the other smoke runs), or runs a pull request's own code before anything merges, which no escalation path can guard; every lane caller runs the pinned release. `tests/unit/credential-reach-guard.test.ts` holds this ([#730](https://github.com/yedeya-labs/kanon/issues/730)): it walks every workflow a push, a schedule or a dispatch starts here, into the reusable workflows and composite actions each one runs from this tree (and, in a lane called at a release, its `uses: ./` steps), reads each job's `if:` under those events, and follows each job that holds a secret (its own, its workflow's top-level `env:`, or one its caller maps), a token minted from one that a job it needs hands it in an output, as a lane spine maps its agent job the App token ([#831](https://github.com/yedeya-labs/kanon/issues/831)), a write grant or `id-token: write` into the files it runs and everything they import, directly or through another. A file none of the entries below matches turns it red, naming the file and the workflow, and so does an `npm`, `npx`, `pnpm` or `yarn` command in such a job that runs a `package.json` script the guard doesn't follow ([#814](https://github.com/yedeya-labs/kanon/issues/814)), so a new import or a new step that widens what a green-zone merge can change in such a job fails before it merges.

- `^cli/apps-check\.mjs$` `auth` `always` — the App check `apps-check.yml` runs with each App's private key
- `^cli/apps\.mjs$` `auth` `always` — imported by the App check: each App's permissions, read from the rulebook
- `^cli/app-register\.mjs$` `auth` `always` — imported by the App check: the register rows it holds the Apps to
- `^cli/gh-token\.mjs$` `auth` `always` — imported by the App check: the token it calls GitHub with
- `^cli/ruleset-bypass\.mjs$` `auth` `always` — imported by the App check: the ruleset bypass it reads
- `^scripts/lib/app-extras\.mjs$` `auth` `always` — imported by the App check: the extra App permissions the adoption record declares, which widen what an App is held to (`K-AGENT-3`)
- `^scripts/move-pins\.mjs$` `pipeline` `always` — the pin job's edit: `release-please.yml`'s `pins` job runs it with the Releaser's key, and opens the pull request that moves Kanon's pins to a candidate (plan 0009 S4)
- `^scripts/lib/cli-entry\.mjs$` `pipeline` `always` — imported by every entry here: whether a module runs as a command
- `^scripts/lib/code-areas\.mjs$` `pipeline` `always` — imported by the membership gate
- `^scripts/lib/test-conventions\.mjs$` `pipeline` `always` — imported by the membership gate, through the code areas
- `^scripts/aggregate-read\.mjs$` `infra` `always` — the metrics page's aggregate read, under the aggregate invoker role
- `^scripts/telemetry/kanon-health\.mjs$` `pipeline` `always` — the metrics page's health figures, which its job publishes with the Author's token
- `^scripts/telemetry/kanon-bugs\.mjs$` `pipeline` `always` — imported by the health figures
- `^scripts/telemetry/kanon-findings\.mjs$` `pipeline` `always` — imported by the health figures
- `^scripts/telemetry/holds-key\.mjs$` `pipeline` `always` — imported by the health figures, through `kanon-findings.mjs`, and by Jev's decision; also linked into the ingest function under `infra/telemetry/function/`, so a change to it changes deployed function code
- `^scripts/metrics/(band|health|indicators|join|stats)\.mjs$` `pipeline` `always` — imported by the metrics page and its health figures; all but `health.mjs` are also linked into the telemetry functions under `infra/telemetry/function/`, so a change to them changes deployed function code
- `^scripts/promote\.mjs$` `pipeline` `always` — the promotion `promote.yml` runs, which decides whether a candidate becomes the stable release adopters' Dependabot proposes, and tags it with the Releaser's token (plan 0009 S5)
- `^scripts/metrics/(areas|detectors)\.mjs$` `pipeline` `always` — imported by the promotion: the revert detector and the `Introduced by` reader its gates read, and the code areas the detectors import
- `^scripts/lib/reverts\.mjs$` `pipeline` `always` — imported by the promotion, through the detectors: what a revert says it reverts; the Lead's reconciler reads it too

The published metrics page:

- `^docs/metrics/` `other` `always` — the public metrics page, whose figures are published in Kanon's name (plan 0003 M7)

## Pipeline code

None. Kanon's own pipeline scripts are `.github/scripts/`, under `.github/`, which escalates whatever this file says. `scripts/` is Kanon's library, and a library that the project's own lanes run only at a pinned release is product, not pipeline code (`K-MERGE-4`): Kanon's lanes run the copy at the release their callers pin ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)), and a change there reaches them only through the release pull request and Dependabot's bump of the pins, both of which go to the Owner. Five of Kanon's own workflows do run this tree's code with a credential, `apps-check.yml`, `metrics-page.yml`, `promote.yml`, `agent-lanes-smoke.yml` and `release-please.yml` (above); their entry files and every local file those import are marked `always` above. So `scripts/` is not declared as pipeline code, which would send all of it to the Owner; its scripts that decide a verdict, gate a lane, touch a token, scrub what leaves, or run from this tree with a credential are declared one by one above.
