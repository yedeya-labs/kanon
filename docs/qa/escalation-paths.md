# Escalation paths

Kanon's escalation file (`K-LAYOUT-8`), declared the way any adopter declares one. Since 2026-10-12 Kanon runs its full suite, the Merger with it, and the Merger merges an Implementer pull request the Reviewer approved only when it touches none of the paths that go to the Owner ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md), as amended that day). The Merger reads this file from the default branch (`K-MERGE-17`), so a pull request that changes it is judged without the change, and the file is directly inside `docs/qa/`, so that pull request goes to the Owner too.

Three tiers decide who merges a pull request here:

- **Always the Owner, fixed by `K-MERGE-4`, so not declared here:** every file under `.github/`, every markdown file directly inside `docs/qa/`, `AGENTS.md`, `CLAUDE.md` and `.claude/`.
- **The Owner, by Kanon's choice:** the paths below, each marked `always`, so they stay with the Owner although the adoption record declares Kanon's production promotion human-gated (`K-MERGE-4`, `K-LAYOUT-10`). Every entry Kanon declares is marked, so that declaration widens nothing here: it records where the human gate on what reaches adopters is, the weekly release pull request.
- **Green, everything else:** the Merger may merge it, notably `docs/` outside `docs/qa/`, `docs/decisions/` and `docs/plans/`, `README.md`, `tests/`, `cli/`, `scripts/metrics/` and the rest of `scripts/`.

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
- `^scripts/telemetry/jev\.mjs$` `pipeline` `always` — the decision whether a private upstream finding becomes a public issue

## Pipeline code

None. Kanon's own pipeline scripts are `.github/scripts/`, under `.github/`, which escalates whatever this file says. `scripts/` is Kanon's library, the product: Kanon's lanes run the copy at the release their callers pin, never this tree's ([ADR 0011](../decisions/0011-kanon-runs-its-own-lanes.md)), and a change here reaches them only through the release pull request and Dependabot's bump of the pins, both of which go to the Owner. So `scripts/` is not declared as pipeline code, which would send all of it to the Owner; its scripts that decide a verdict, gate a lane, touch a token or scrub what leaves are declared one by one above.
