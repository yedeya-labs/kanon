# Plan 0008: self-service telemetry registration through GitHub's OIDC token

- **Status:** proposed, 2026-10-10. The Owner took four decisions on 2026-10-10, before this plan was drafted, on the four open questions of the source note: activation, aggregate access, the audience and the migration. They are recorded in [Owner decisions (2026-10-10)](#owner-decisions-2026-10-10) and are not reopened here. What the plan adds beyond them is listed under [Decisions left open](#decisions-left-open), each with a proposed default.
- **Tracks:** [#629](https://github.com/yedeya-labs/kanon/issues/629) (where the register lives) and [#607](https://github.com/yedeya-labs/kanon/issues/607) (`NAME_HASHES` and Lambda's 4 KB environment). **Builds on:** [plan 0002](0002-hosted-telemetry-store.md) (the store, its function and its register), [plan 0006](0006-upstream-findings.md) (finding intake, which reads the sender's name hashes) and [plan 0007](0007-guided-install.md) (the guided install's consent question, Q4). **Amends, once decided:** plan 0002 §3 (write authentication), §4 (its option C, rejected then, is taken here), §5 (the register), §6 (reads), §6.1 (the invoker role) and §10 (erasure); plan 0007 §5 (the sharing step after R9). **Governed by:** [ADR 0007](../decisions/0007-data-boundary.md), `K-OBS-13`, `K-OBS-16` to `K-OBS-18`, `K-PRIN-11` and `K-SELF-7` (every guard can fail, and is mutation-checked), and `K-OBS-4` (no alarm).
- **Source:** a note the operator wrote on 2026-10-10 in the operator's private repository, after the first timed install. It names no adopter; its problem statement, idea, endpoint list and risks are carried into §1 to §3 here.
- **Measured on** Kanon's `origin/main` at `16158d5` (v0.38.0 plus commits): `infra/telemetry/` (the template, `render.mjs`, `function/index.mjs`, `function/aggregate.mjs`, `verify.mjs`, `erase.mjs`), `.github/workflows/telemetry-collect.yml`, `scripts/telemetry-collect.mjs`, `agent-overseer.yml`, `agent-explore-telemetry.yml` and `docs/telemetry.md`. GitHub's documentation and its OIDC discovery document were read on 2026-10-10 ([§4.1](#41-what-githubs-documentation-confirms)). Nothing in this plan has been built or deployed.

## The plan in one paragraph

**Today.** An adopter that opts in to telemetry files a public registration issue naming its repository. The operator adds an entry to a register file (each adopter's opaque key and repository name), renders the CloudFormation template, which gives each repository a writer, a reader and possibly an aggregate-invoker IAM role trusting its OIDC subject, deploys it, and sends back two values the adopter sets as repository variables. Until then the collector skips. Erasure goes through the operator. The register is a file in a git repository, and the ingest function's environment holds every key and, per key, the name hashes finding intake needs, which caps the register at about 13 to 25 repositories (#607).

**Where it ends.**
- **The ingest function checks GitHub's OIDC token itself,** claim by claim, against GitHub's published keys. The token proves which repository the call comes from, that it runs on its default branch, and that the job is **Kanon's own collector at a Kanon release** (`job_workflow_ref`), which today nothing proves.
- **Registration is a table row, not infrastructure.** The collector's first default-branch run registers the repository, which is **active at once**, under per-key rate limits and daily quotas. The operator can **suspend** a key with one CLI call, no deploy.
- **The register is a KMS-encrypted DynamoDB table,** out of git entirely. `NAME_HASHES`, the keys, and the aggregate fields (`aggregate_invoker`, `publish_own_figures_as`, set only by the operator's CLI) move into it, which also lifts #607's cap.
- **Five endpoints:** register, status, self-service erasure, ingest, and the adopter's own rows. The aggregate function takes the same token, so **no per-adopter IAM role is left**.
- **The adopter does nothing beyond consenting.** No issue, no repository name in public, no variables, no wait for the operator. Opting out is deleting the caller; erasure is one dispatch.

**How it gets there.** The token verifier first, as a module with one mutation-checked test per claim. Then the register table and the operator's CLI, then the endpoints, then the collector and the two reading lanes on the token path, in **one release, vM**. The Owner deploys vM beside today's SigV4 path, imports **both existing register entries at once with their keys unchanged**, and both repositories move their pins. **The next release, vM+1, removes SigV4, the writer, reader and aggregate-invoker roles, and `render.mjs`'s per-adopter resources.**

## 1. What is wrong today

Each item is in the code as measured.

| What | Where | Cost |
|---|---|---|
| A public issue names the repository; a private one needs a side channel | `.github/ISSUE_TEMPLATE/telemetry-registration.yml`, `docs/sharing.md` ("After a yes") | The opt-in says who adopted Kanon, in public |
| An entry, a render, a package and a deploy per adopter, then two variables | `docs/telemetry.md`, "Add a repository"; `render.mjs` `repositoryResources` | The slowest step of an install that opts in, and all of it the operator's; plan 0007 §11 had to take it off the clock |
| Up to three IAM roles per adopter (writer, reader, aggregate invoker) | `render.mjs` | IAM's roles-per-account quota becomes a ceiling on adopters |
| Any default-branch job holding `id-token: write` can assume the writer | `docs/telemetry.md`, "Who can write"; `K-OBS-13`'s **Not enforced** | Kanon's own QA-store jobs, the two reading jobs and the adopter's deploy jobs can all write rows |
| The register is a file in a git repository | plan 0002 §5; #629 | A pull request that touches it sends every key and its repository to the reviewing model |
| `NAME_HASHES` and `WRITER_KEYS` live in the function's environment | `render.mjs` `nameHashesVariable`, `LAMBDA_ENV_BYTES` | About 13 to 25 repositories before Lambda's 4 KB refuses the deploy (#607) |
| Erasure is the operator's to run | `erase.mjs`, `docs/telemetry.md` "Erase an adopter" | The adopter waits on a person to have its own data deleted |

## 2. The token

### 2.1 How the collector gets one

The collect job already holds `id-token: write`. At vM it stops assuming a role. Instead, **for each request**, it asks the runner for a fresh token with the audience `kanon-telemetry` (`ACTIONS_ID_TOKEN_REQUEST_URL` with `&audience=kanon-telemetry`, which is what `core.getIDToken(audience)` calls) and sends it as `Authorization: Bearer <token>`. A fresh token per request keeps each one well inside its lifetime, whatever the sweep's length. The token is masked before anything prints, and never written to a file or an artifact.

**The URL is fixed with the audience.** The hosted store's URL becomes a constant in the collector, and **a token with the hosted audience is only ever sent to that URL**. A self-hosted store (`K-OBS-18`'s default, the same template in the adopter's own account) is reached by passing both a `url` and an `audience` input, never one without the other, so a token minted for Kanon's store can't be pointed at another host by an input.

### 2.2 The checks, claim by claim

The function checks every request in this order, and **stops at the first failure**. A missing claim, a claim of the wrong type, or an extra value where one is expected is a failure, never a skip. Each failure answers with its own code, so a live check (§9) can tell which claim refused a token; the codes are public, as the code is.

| # | Claim | The check | Refused with | Docs |
|---|---|---|---|---|
| 1 | header `alg`, `kid` | `alg` is exactly `RS256`; `kid` is a non-empty string. `none`, `HS256` or any other algorithm is refused before any key is looked up | 401 `alg` | verified (discovery document: `RS256` only) |
| 2 | signature | `kid` names a key in the cached JWKS (§2.4), and the RS256 signature over the header and payload verifies with it | 401 `kid`, 401 `signature` | verified (JWKS URI in the discovery document) |
| 3 | `iss` | exactly `https://token.actions.githubusercontent.com`, compared as a string | 401 `iss` | verified |
| 4 | `aud` | exactly the store's audience, `kanon-telemetry` (a template parameter, §5.1). A string, or an array of exactly one element equal to it. GitHub's default audience, the owner's URL, and AWS's `sts.amazonaws.com` are refused | 401 `aud` | verified (custom audience through `core.getIDToken(audience)`; default is the owner's URL) |
| 5 | `exp`, `nbf`, `iat` | integers; `exp > now − 60 s`; `nbf ≤ now + 60 s`; `iat ≤ now + 60 s`; and `iat ≥ now − 600 s`, a maximum age of ten minutes that holds whatever lifetime GitHub issues. **Allowed skew: 60 seconds** | 401 `time` | claims verified; **lifetime not documented** (below) |
| 6 | `event_name` | one of `schedule` and `workflow_dispatch`, the collector caller's two triggers. An allow-list: `pull_request`, `pull_request_target`, `push`, `merge_group`, `dynamic` (Dependabot's) and every other value are refused | 403 `event` | verified (claim; `dynamic` for Dependabot) |
| 7 | `job_workflow_ref` | exactly `yedeya-labs/kanon/.github/workflows/<file>@refs/tags/v<X>.<Y>.<Z>`, where `<file>` is the endpoint's own workflow (below) and the version is at least `MIN_TOKEN_VERSION`, the release that ships this path (vM) | 403 `workflow` | claim verified; **the `@refs/tags/` form not shown in the docs** (below) |
| 8 | `repository_id`, `repository_owner_id` | decimal strings, `^[1-9][0-9]{0,19}$`. For every endpoint but registration, `repository_id` finds the registration, and `repository_owner_id` must equal the one it was registered with | 404 `not-registered`, 403 `owner` | verified (strings in GitHub's example payload) |
| 9 | `ref`, `ref_type` | `ref_type` is `branch`; `ref` equals the registration's `default_ref` (§2.3) | 403 `ref` | verified |

**Which workflow each endpoint admits (check 7).** A token is tied to the job that minted it, so each endpoint names the one Kanon workflow whose job may call it:

| Endpoint | `<file>` | The job |
|---|---|---|
| `POST /v1/registrations`, `GET` and `DELETE /v1/registrations/self`, `POST /v1/rows` | `telemetry-collect.yml` | `collect` |
| `GET /v1/rows/self` | `agent-overseer.yml` | `telemetry`, the Overseer's cost view, which today assumes the reader role |
| `GET /v1/registrations/self` | also the two reading lanes | so each can say why it read nothing |
| the aggregate function (§3.6) | `agent-explore-telemetry.yml` | `aggregate`, which today assumes the invoker role |

**Which tags count.** A tag `v<X>.<Y>.<Z>` with no suffix, at or above `MIN_TOKEN_VERSION`. A pre-release suffix, a branch (`@refs/heads/main`, the dev line), a pull request ref (`@refs/pull/…`) and a commit SHA are all refused: **an unreleased collector never writes to the hosted store.** Kanon's own callers pin a release and never call through `$/` (ADR 0011's bootstrap; `telemetry.yml`, `overseer.yml` and `explore-telemetry.yml` all name `@v0.38.0` today), so Kanon is admitted exactly as an adopter is. Kanon's CI, smoke runs and any `$/` self-call from a branch carry a branch ref in `job_workflow_ref`, and are refused by design; they test against a test store with its own audience (decision 3), or not at all. **A `$/` call nested inside a pinned release**, such as a lane's `$/.github/workflows/…-agent-job.yml`, is observed to carry the outer release's tag in `job.workflow_ref` (`review-agent-job.yml@refs/tags/v0.33.0`, [#454](https://github.com/yedeya-labs/kanon/issues/454)); none of the three jobs above is nested today, so the plan doesn't rely on it, and J6 checks it live if one ever is. `MIN_TOKEN_VERSION` is a template parameter, so the operator can raise it to drop a release with a bug, without a code change.

**Tag protection.** A tag is only as good as who can create it. Kanon's releases are immutable (GitHub's immutable releases, on for v0.38.0, read on 2026-10-10), so a published release's tag can't be moved; but a new `v*` tag can be pushed by anyone with write access, and Kanon has no tag ruleset (one ruleset, `main`, on branches). J5 adds a ruleset restricting the creation, update and deletion of `refs/tags/v*` to the release workflow and the Owner. Pinning `job_workflow_sha` to the set of release commits as well is [left open](#decisions-left-open).

**What the token does not prove.** It proves the job: Kanon's collector at a release, in this repository, on its default branch. It does not prove the rows are true. The collector sends what the repository's own runs uploaded as artifacts, and a repository's owner can upload any artifact from its own workflows. So an adopter can still send validated rows of its own invention **under its own key**, as any default-branch job can today; it can't reach another key. §6 bounds what that can do to the aggregates.

### 2.3 How the function knows the default branch

No claim says "this is the default branch". The function learns it in two ways, both from GitHub's own definitions:
- **A `schedule` token's `ref` is the default branch.** GitHub's events documentation: for `schedule`, `GITHUB_REF` is "Default branch", and "Scheduled workflows will only run on the default branch."
- **A `workflow_dispatch` token from Kanon's collector at a release is on the default branch,** because check 7 proves the job is the collector's `collect` job, and that job's `if:` admits a dispatch only when `github.ref_name == github.event.repository.default_branch`. GitHub evaluates `if:` before the job starts, and a token can only be minted inside a running job. That makes the `if:` a security check, so J5 adds a guard test for it: **mutation:** dropping the default-branch clause from the `if:` turns the test red.

**At registration** the function records `default_ref` from the token's `ref`. **On every later call** check 9 compares the two. **A renamed default branch** fails closed: the next dispatch is refused with 403 `ref`, and the next **schedule** token, which by GitHub's definition carries the new default branch, updates `default_ref` and is admitted. So a rename heals within an hour, and only a schedule can move it.

### 2.4 GitHub's keys: caching and failure

- **Fetched from a fixed URL,** `https://token.actions.githubusercontent.com/.well-known/jwks`, the `jwks_uri` of GitHub's discovery document, which the function does not read at run time. Only RSA keys with `use: sig` are kept.
- **Cached in the function's container for 15 minutes.** An unknown `kid` triggers one refetch, **at most once a minute per container**, so a stream of tokens with invented `kid`s can't turn into a stream of fetches. A rotated key is picked up by the first token that names it.
- **The fetch has a 2-second timeout and no retry inside a request.**
- **Fail closed.** With no cached key set younger than 15 minutes and a failed fetch, every request answers **503 `jwks-unavailable`**. A key is never accepted from a stale cache, and a token is never accepted unverified. The collector turns red on the 503, which is the page (`K-OBS-4`), and its next sweep re-covers the span, so nothing is lost while the artifacts live.
- **Node built-ins only** (`node:crypto` `createPublicKey` with a JWK, and `verify` with `RSA-SHA256`), as the function is today: no JWT library.

### 2.5 Every check fails closed, and each one can fail

The verifier is one module, `infra/telemetry/function/oidc.mjs`, exporting `verifyToken(token, { audience, endpoint, now, keys })`, used by both functions. Its tests sign tokens with a key pair generated in the test (`generateKeyPairSync`), so no fixture holds a real token. **One test per check, and each check is mutation-tested** (`K-PRIN-11`, `K-SELF-7`): the check is removed or inverted in a copy of the module, the suite is run, the named test goes red, and the copy is restored from the backup, never by checking the file out. The mutations J1 runs, each with the test it must turn red:

| Check removed or weakened | The test that goes red |
|---|---|
| `alg` not checked | a token with `alg: none`, and one with `HS256` signed with the public key as an HMAC secret, are refused |
| signature not verified | a token whose payload changed after signing is refused |
| unknown `kid` accepted from another key | a token signed by an unlisted key, with a listed `kid`, is refused |
| `iss` compared by prefix | `https://token.actions.githubusercontent.com.evil` is refused |
| `aud` not checked, or `includes` on an array | the owner-URL audience, `sts.amazonaws.com`, and `["kanon-telemetry", "x"]` are refused |
| `exp` skew widened past 60 s, or dropped | a token expired 61 s ago is refused |
| `nbf` dropped | a token not valid for another 61 s is refused |
| `iat` maximum age dropped | a token issued 601 s ago with a far `exp` is refused |
| `event_name` as a deny-list | `push` and `dynamic` are refused, as `pull_request` and `pull_request_target` are |
| `job_workflow_ref` repository or path not anchored | `evil/kanon/.github/workflows/telemetry-collect.yml@refs/tags/v9.0.0`, `yedeya-labs/kanon-fork/…` and `…/telemetry-collect.yml.bak@…` are refused |
| `job_workflow_ref` ref not checked | `@refs/heads/main`, `@refs/pull/1/merge`, a SHA and `@refs/tags/v9.0.0-rc.1` are refused |
| version floor dropped | a release below `MIN_TOKEN_VERSION` is refused |
| endpoint's workflow not checked | the Overseer's token on `POST /v1/rows` is refused |
| `repository_owner_id` not compared | a registered `repository_id` under another owner id is refused |
| `ref` not compared | a dispatch token on another branch of a registered repository is refused |
| `ref_type` not checked | a tag ref equal in name to the default branch is refused |
| a missing claim treated as a pass | each claim removed from an otherwise valid token is refused |
| JWKS fetch failure treated as an empty set and a pass, or a stale set used | with the fetch failing and the cache 16 minutes old, a valid token gets 503 |

A **mutation that passes** is either equivalent, and the test says why, or the test is dead, and is fixed before J1 merges. The list above is the minimum; the J1 pull request lists each mutation it ran and its red test.

## 3. The endpoints

### 3.1 Common to all five

- **Base:** the ingest function's URL, `/v1/…`. The hosted URL is a constant in the collector (§2.1), not a variable the adopter sets.
- **Auth:** `Authorization: Bearer <token>`, checked by §2.2 with the endpoint's own workflow. No other credential is read.
- **Answers:** JSON, with `error` a code from a closed list on any non-2xx, never a value from the request. Logs hold keys, codes and field names only, as today.
- **Status codes shared by all:** 400 `body-*` malformed; **401** a token that fails checks 1 to 5 (`WWW-Authenticate: Bearer error="invalid_token"`); **403** a token that fails checks 6 to 9, or `suspended`; 404 `not-registered`; 405 method; 413 `body-size`; **429** `quota` (§6), with `Retry-After`; 503 `jwks-unavailable`.

### 3.2 The table

| Endpoint | Who | Request | Response | Idempotent |
|---|---|---|---|---|
| `POST /v1/registrations` | the collector | `{}`, or `{ "reregister": true }` after an erasure | **201** `{ "status": "active", "registered_at": … }` for a new registration; **200** the same for an existing active one; **409** `erased` without `reregister`; 403 `suspended`; 429 `registrations` | yes: one registration per `repository_id`, by a conditional write |
| `GET /v1/registrations/self` | the collector, the Overseer's `telemetry` job, the Explorer's `aggregate` job | none | **200** `{ "status": "active" \| "suspended" \| "erased", "registered_at", "suspended_at"?, "suspended_reason"?, "erased_at"?, "rows_erased": bool, "quota": { "rows_per_day", "rows_today" }, "aggregate_invoker": bool, "publish_own_figures_as"?: label }`; 404 `not-registered` | read only |
| `DELETE /v1/registrations/self` | the collector, on an `erase` dispatch | none | **202** `{ "status": "erased", "erased_at", "rows_erased": false }`, the rows' deletion started (§7); **200** the same on a repeat, with `rows_erased` true once done; 404 `not-registered` | yes |
| `POST /v1/rows` | the collector | up to 25 rows, 256 KB, as today | **200** `{ "results": [ { "status": "stored" } … ] }`; **422** any row rejected, per row, by field and rule; **502** a write failed; 404 `not-registered`; 403 `suspended`; **410** `erased`; 429 `quota` | yes: the key is built from the row, as today, so a re-send overwrites identically |
| `GET /v1/rows/self` | the Overseer's `telemetry` job | `?lane=<lane>&from=<ISO>&to=<ISO>&fields=<a,b,…>&cursor=<opaque>`; `lane` from the schema's enum or `work`; `fields` from the schema's field names; `tag=run` unless `tag=smoke\|test` is asked | **200** `{ "rows": [ … ], "cursor"? }`, at most 1,000 rows a page, never a row past its `expires_at`; 400 `lane`, `fields` or `window` | read only |

**Never returned:** the key, by any endpoint. The adopter never sees it, and never needs to: the function finds it from `repository_id`. The `cursor` is the function's own encryption of DynamoDB's `LastEvaluatedKey` (AES-GCM with a key in the function's environment, rotated on every deploy), so it holds no key in clear.

**The collector's flow on each run:** `POST /v1/rows`; on 404 `not-registered`, `POST /v1/registrations` once, then the rows again. So a registered repository makes no extra call, and the first default-branch run registers. On 403 `suspended` or 410 `erased`, the run says so in its summary and turns red for `suspended`; for `erased` it stays green with a warning, since the adopter asked for it, and sends nothing (§7).

### 3.3 Registration

- **Who may register:** any repository whose token passes checks 1 to 7 on `POST /v1/registrations`, from a schedule or a default-branch dispatch of Kanon's collector at a release. The consent is the caller: `kanon init` writes it only on a *Yes* or *Codes only* (plan 0007 §3, Q4), and a person merged it.
- **What it writes,** in one `TransactWriteItems`: the registration item and the key item (§5.2), each conditional on not existing, so two concurrent first runs make one registration and one answers 200.
- **The key** is minted by the function: `k` and 16 hex characters from `crypto.randomBytes(8)`, 64 bits, so collisions stay negligible as adopters grow; the key item's condition makes a collision a retry, never a shared key. It never leaves the function, the table and the operator's CLI.
- **Active at once** (decision 1), with the default quotas (§6).
- **Re-registration after erasure** needs `{ "reregister": true }`, which the collector sends only on a dispatch with `register: yes` (§8). A deleted-then-restored caller doesn't silently opt the repository back in.

### 3.4 The name hashes (#607)

Finding intake (plan 0006 §4.2) checks a finding's text against the sender's own words: the SHA-256 of each word of its repository's owner and name, as the scrub's `nameContext` hashes them, never the words. Today `render.mjs` writes them into the function's environment for every key, which is what caps the register (#607).

**At vM they come from the token.** The `repository` claim is the sender's current `owner/name`, so the function computes the hashes per request with `nameContext`, exactly as `render.mjs` does now. They are always current, through a rename, and nothing about them is configured. The registration item also keeps them, as `name_hashes`, refreshed when the token's differ, **for the operator's private job** (§10), which checks findings again and today reads them from the register file. The function's environment no longer grows with adopters: `WRITER_KEYS`, `NAME_HASHES`, `AGGREGATE_KEYS`, `OWN_FIGURES` and `INVOKER_KEYS` all leave it at vM+1 (during the overlap, the SigV4 path reads keys from the table too, §9). **That closes #607:** no per-adopter value is in any environment, and the property F4 relies on holds, since the table holds hashes and never the words, and a key whose registration holds none stores no finding.

`assertNoKey`, which needs every registered key, reads them from the table (a `Scan` of the key items, §5.2), cached in the container for 5 minutes. A key registered in the last 5 minutes can be missed by that one check on another adopter's finding; it can't be missed in its own sender's, whose key the function always holds.

### 3.5 The adopter's own rows

`GET /v1/rows/self` replaces the reader role, `kanon-telemetry-<key>-reader`, and the `KANON_TELEMETRY_READER_ROLE` secret. **IAM still bounds each read to one key:** for each request the function assumes one role, `kanon-telemetry-self-read`, with an inline session policy whose `dynamodb:LeadingKeys` is `<key>#*` for the key the registration gave. So a fault in how a query is built can't read another key's partition; a fault in which key is chosen still could, and that part is code-enforced (§11). It costs an STS call per read, which is free. Whether to keep this, or have the function's own role query directly, is [left open](#decisions-left-open); the default is to keep it.

### 3.6 The aggregate function

Its URL takes the same token, from `agent-explore-telemetry.yml`'s `aggregate` job (check 7), and answers only a registration whose `aggregate_invoker` is true. `aggregate_invoker` and `publish_own_figures_as` are read from the table, not the environment (decision 2), and **only the operator's CLI writes them** (§5.3). The invoker role, `kanon-telemetry-<key>-aggregates`, and the `KANON_AGGREGATE_ROLE` secret go at vM+1, and `KANON_AGGREGATE_URL` becomes a constant in the lane like the ingest URL. That removes the last per-adopter IAM role. Its answer is unchanged: the three-adopter rule, `own` figures by label, and signals (plan 0002 §6.1). **A suspended key's rows count in no aggregate and no signal,** since suspension is how the operator quarantines a sender that skews them.

## 4. What GitHub's documentation says

### 4.1 What GitHub's documentation confirms

Read on 2026-10-10: GitHub's OIDC reference (`docs.github.com/en/actions/reference/security/oidc`), "OIDC with reusable workflows" (`…/security-harden-deployments/oidc-with-reusable-workflows`), "Events that trigger workflows", and the discovery document `https://token.actions.githubusercontent.com/.well-known/openid-configuration`.

| Claim or fact | Confirmed | Where |
|---|---|---|
| `iss` is `https://token.actions.githubusercontent.com` | **yes** | the reference; the discovery document's `issuer` |
| `aud` defaults to the owner's URL, and is set with `core.getIDToken(audience)` | **yes** | the reference |
| Signing is RS256; the keys are at `/.well-known/jwks` | **yes** | the discovery document (`id_token_signing_alg_values_supported: ["RS256"]`, `jwks_uri`); four RSA `sig` keys were listed |
| `repository_id`, `repository_owner_id` exist, as strings | **yes** | `claims_supported`; the reusable-workflow page's example (`"repository_id": "74"`) |
| `ref` is the ref that triggered the run, and **in a reusable workflow it is the caller's** | **yes** | the reusable-workflow page: "`workflow`, `ref`, `repository` and `actor`" describe the caller |
| `event_name`; Dependabot jobs carry `dynamic` | **yes** | the reference |
| **`job_workflow_ref` is in a reusable workflow's token, and names the called workflow** | **yes** | the reference: "For jobs using a reusable workflow, the ref path to the reusable workflow"; the reusable-workflow page's example, `octo-org/octo-automation/.github/workflows/oidc.yml@refs/heads/main` |
| `job_workflow_sha` is in it | **yes** | the reference: "the commit SHA for the reusable workflow file" |
| `exp`, `nbf`, `iat` are in it | **yes** | the reference; the example payload |
| `ref_type`, `ref_protected`, `runner_environment`, `repository_visibility` exist | **yes** | `claims_supported` |
| A `schedule` run's ref is the default branch; it runs only there | **yes** | the events page |
| A `workflow_dispatch` run's ref is "Branch or tag that received dispatch" | **yes** | the events page |

### 4.2 Not confirmed, and how each is handled

- **The token's lifetime.** The documentation doesn't state it. The one example has `exp = iat + 300` and `nbf = iat − 600`. The checks don't depend on it: a fresh token per request, a 10-minute maximum age on `iat`, and `exp` itself. **J6 records** `exp − iat` from a real collector run.
- **`job_workflow_ref` at a tag.** The documentation's examples show `@refs/heads/main` and a SHA, never `@refs/tags/v…`. Kanon's own observation of `job.workflow_ref` shows the tag form (#454), but that is the `job` context, not the token. **J6's first check** is that a real collector token at vM carries `yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@refs/tags/v<vM>`; until it does, the token path stays beside SigV4 and nothing is removed.
- **`job_workflow_ref` in a nested reusable workflow,** a `$/` call inside a pinned release. Not documented. No endpoint relies on it (§2.2).
- **`repository_owner_id` for a personal account.** The reference describes it as "the ID of the organization"; the immutable subject's form (`repo:octo-org@123456/…`) suggests it is the owner's id for any account. **J6** checks a personal-account repository before vM ships, on a sandbox.
- **JWKS caching headers.** A `HEAD` on the JWKS answered 405 on 2026-10-10, so GitHub's cache headers weren't read. The 15-minute cache is the function's own, and doesn't depend on them.

## 5. The register as a table

### 5.1 The table

`kanon-telemetry-register`, in the same stack and account as the rows table, in Frankfurt.
- **On demand,** `pk` string as its only key, TTL on `expires_at` (for counters, §6), point-in-time recovery, deletion protection, `DeletionPolicy: Retain`, like the rows table (`K-OBS-17`'s lifecycle).
- **Encrypted with KMS,** `SSEType: KMS` with the AWS-managed key `aws/dynamodb`: no monthly key fee, and every use of the key is in CloudTrail. **What it does not add:** an AWS-managed key's policy can't be narrowed, so it is not an access control. Access is held by the table's resource policy and IAM (§5.3). A customer-managed key, whose policy could also deny the key to everyone but the function and the operator, costs $1 a month on its own, which is the whole ceiling (§12); [left open](#decisions-left-open).
- **The audience** is a template parameter, `Audience`, default `kanon-telemetry`. A test store is the same template with another (decision 3).
- **Out of git entirely.** No register file, no rendered parameters file holding keys. #629's warning stops applying at vM+1, when the old file is deleted (§10).

### 5.2 Its items

**The registration**, `pk = repo#<repository_id>`:

| Field | Set by | What |
|---|---|---|
| `repository_id`, `repository_owner_id` | the function, at registration | from the token; the immutable ids, which hold through a rename |
| `repository` | the function, refreshed when the token's differs | the `owner/name` last seen; [left open](#decisions-left-open) whether to keep it |
| `key` | the function, at registration (or the import, J6) | the opaque key every row carries |
| `status` | the function (`active`, `erased`); the CLI (`suspended`, `active`) | |
| `default_ref` | the function | §2.3 |
| `name_hashes` | the function | §3.4 |
| `registered_at`, `registered_by_version`, `last_seen_at` | the function | `last_seen_at` written at most hourly |
| `suspended_at`, `suspended_reason` | the CLI | a code from a closed list: `abuse`, `quota`, `owner-changed`, `request`, `other` |
| `erased_at`, `rows_erased_at` | the function | §7 |
| `quota_rows_per_day`, `quota_requests_per_hour` | the CLI | absent means the defaults of §6 |
| `aggregate_invoker`, `publish_own_figures_as` | **the CLI only** | decision 2; the label's rules are `render.mjs`'s today: the key's pattern, never a key, unique |
| `first_review` | the CLI | `{ minutes, review_recorded_at }`, kept 13 months after the review row, as plan 0002 decision 18 has it; the CLI refuses to keep one past it |
| `source` | the function or the import | `api` or `import` |

**The key item,** `pk = key#<key>`, holding `repository_id`: it makes each key unique (§3.3), and lets the operator's CLI and jobs find a registration by key without a scan of every field.

**Counters,** `pk = count#<key>#<window>` and `pk = refused#<key>#<day>`, with `expires_at` two days out (§6).

### 5.3 Who reads and writes it

| Principal | May | How it is held |
|---|---|---|
| The ingest function's role | `GetItem`, `Query`, `Scan` (key items only, for `assertNoKey`), `PutItem`, `UpdateItem`, `TransactWriteItems`, `DeleteItem` (the key item, on erasure) | its policy's `dynamodb:Attributes` lists every field **but** `aggregate_invoker`, `publish_own_figures_as`, `quota_*`, `suspended_*` and `first_review`, so **IAM refuses the function a write of an operator field**, whatever its code does |
| The aggregate function's role | `Scan` with exactly `pk`, `key`, `status`, `aggregate_invoker`, `publish_own_figures_as`, `repository_owner_id` | `dynamodb:Attributes` and `dynamodb:Select: SPECIFIC_ATTRIBUTES`, as its `Query` on the rows table is held today |
| The Owner's role | everything, through the CLI | the table's resource policy names it |
| The operator's private jobs | `GetItem` and `Scan` of `key`, `status`, `name_hashes` and `repository_owner_id`, through **their existing roles** | the same projection condition; added to those roles in the operator's private repository (§10) |
| Anyone else | nothing | the table's resource policy denies every action to every principal but these four |

**The operator's CLI,** `infra/telemetry/register.mjs`, run by the Owner with the Owner's profile:
- `list`: counts by status, and each registration **by repository, never by key** (kanon#628's rule, which `render.mjs` follows today);
- `suspend --repository <owner/name> --reason <code>` and `resume --repository <owner/name>`: one `UpdateItem`, effective on the next request, **no deploy**;
- `set --repository <owner/name> [--aggregate-invoker true|false] [--publish-own-figures-as <label>|--no-publish-own-figures] [--rows-per-day <n>] [--requests-per-hour <n>] [--first-review <minutes>@<recorded_at>]`;
- `erase --repository <owner/name> [--apply]`: §7's erasure, run by the operator;
- `import --register <file>`: J6's one-time move, refusing any entry it can't resolve to its ids.

Each prints repositories, statuses and counts only, and exits non-zero on any refusal, naming the entry by its repository or index, never its key.

## 6. Quotas and rate limits

**Proposed defaults,** per key unless said otherwise. Volume today is about 42 rows a day for the busiest adopter (plan 0002 §1.3), and a collector run makes at most one `POST` per 25 rows.

| Limit | Default | Why that number |
|---|---|---|
| Rows stored per UTC day | **5,000** | about 100 times the busiest adopter's day; a 7-day recovery sweep at today's volume is about 300 rows |
| Requests per hour, all endpoints | **120** | an hourly collector makes 1 to 13; a recovery sweep a few dozen |
| `GET /v1/rows/self` page | **1,000 rows** | the Overseer's 14-day read is a few pages |
| `DELETE /v1/registrations/self` | **5 a day** | it is idempotent; more is a loop |
| New registrations per `repository_owner_id` per day | **20** | an organisation installing Kanon across its repositories in a day |
| New registrations, store-wide, per day | **100** | far above any adoption rate in sight; bounds a mass registration |
| Body, rows per request | 256 KB, 25 | unchanged (plan 0002 §4) |
| Reserved concurrency | **2** | plan 0002 §4; a precondition of publishing the URL (§12) |

**How a limit is held.** A counter item per key and window (`count#<key>#<UTC day>` for rows, `count#<key>#<UTC hour>` for requests), incremented by a conditional `UpdateItem` that **reserves the whole batch** before any row is written: `ADD n :rows` only if `n + :rows ≤ limit`. A batch that doesn't fit is refused whole, so a request is never half stored. The registration limits are counters too, on `count#owner#<owner id>#<day>` and `count#all#<day>`. The operator raises one adopter's limit with `register.mjs set`.

**Past a limit:** **429** with `Retry-After` (the counter window's end) and `{ "error": "quota", "limit": "rows_per_day" | "requests_per_hour" | "registrations", "resets_at" }`. Nothing from that request is stored. **Never silent, and counted:**
- the collector turns red, naming the limit, which is the page; its watermark doesn't move, so the next sweep after the reset re-covers the span, and nothing is lost while the artifacts live (the 7-day sweep cap);
- the function adds the refused rows to `refused#<key>#<day>`, which the operator's private job reports daily (§10), so a key that keeps hitting a limit is seen by the operator, not only by the adopter.

## 7. Erasure

**Self-service:** a dispatch of the collector's caller with `erase: yes` (§8) calls `DELETE /v1/registrations/self`. The function:
1. sets `status: erased` and `erased_at` at once, so from that moment **every write and read for the key is refused** (410 on rows, 409 on a registration without `reregister`);
2. answers 202, and starts the rows' deletion as an asynchronous invocation of its own `erase` handler, which walks every partition `erase.mjs` walks today (`<key>#<lane>` for each lane, `<key>#work`, `<key>#finding`; `PARTITIONS`), with a `BatchWriteItem` of deletes, under the session policy of §3.5 scoped to that key;
3. when the walk finds nothing left, sets `rows_erased_at`, deletes the key item, and reduces the registration to a **tombstone**: `repository_id`, `repository_owner_id`, `status`, `erased_at`, `rows_erased_at`. No key, no name, no hashes, no quotas, no aggregate fields, no `first_review`.

The tombstone is what makes a deleted-then-restored caller answer "erased" rather than silently register again (§3.3). It is kept with no expiry; [left open](#decisions-left-open). An asynchronous invocation that fails is retried twice by Lambda; a tombstone still without `rows_erased_at` after a day is reported by the operator's private job (§10), and the operator finishes it with `register.mjs erase`.

**The promise, unchanged in substance:** **deleted from the table at once, and from backups within 35 days** (plan 0002 §10, decision 11). "At once" now means within minutes of the dispatch, not when the operator gets to it. The ingest log, which holds keys and field names, expires in 30 days, inside the same 35. ADR 0007 rule 4's "deleted on request" stays true, and the request no longer needs a person.

**The operator's erasure,** for a request made another way (an issue, an email), or a key the operator removes: `register.mjs erase --repository <owner/name> --apply`, which does the same three steps as the Owner. It replaces step 1 of today's "Erase an adopter" (remove the entry, render, deploy) with one call; `erase.mjs` stays as the walk both use.

**Suspension is not erasure.** A suspended key keeps its rows, which still expire by TTL; its writes and reads are refused (403 `suspended`) until the operator resumes it. Suspension is for abuse or a dispute, erasure for consent withdrawn.

## 8. The adopter's experience

In plan 0007's guided install, **Q4's *Yes* or *Codes only* writes the collector's caller, and that is the whole registration:**
- The caller has **no variables**. Its `uses:` line, its triggers and its permissions stay; `url:` and `writer-role:` go, because the hosted URL is the collector's default (§2.1). The caller gains two dispatch inputs, `erase` and `register`, both default `no`.
- **Its first default-branch run registers the repository:** the first hourly schedule after the install's pull request merges, or a dispatch the runbook may suggest to see it at once. Nothing is asked of the operator, and nothing names the repository in public.
- **Plan 0007 §5's sharing step goes:** "submit the registration issue the link opens, prefilled; the collector skips, green, until the operator's two variables arrive" is removed, and the registration issue template with it. The summary's *Sharing* line says "registers on the collector's first run".
- **`kanon init`'s `telemetry.register` finding and `kanon doctor`'s `telemetry.unconfigured`** retire; doctor instead reads the caller's last default-branch run and reports `telemetry.refused` when it ended red on a 403, 410 or 429, with the run's own words, and `telemetry.not-run` while there is none. Neither blocks.
- **To stop:** delete the caller. Nothing more is sent; the rows expire by TTL within 13 months.
- **To erase:** dispatch the caller with `erase: yes`, then delete it. The run's summary says when the rows are gone, from `GET /v1/registrations/self`. `docs/sharing.md`'s "Stop and erase" says so in two lines.
- **To come back after erasing:** dispatch with `register: yes`, which sends `reregister: true` and gets a new key.

Plan 0007 §11 took "the Kanon operator's telemetry registration" off timed run 2's clock; with this plan there is nothing to take off.

## 9. Migration: one release, both entries, keys unchanged

Decision 4: **both existing register entries, Kanon and the operator's private repository, move at once, in one release, with their keys unchanged.** SigV4 ingest runs beside the token path for that one release, and is removed in the next, with the per-adopter IAM roles.

**During vM's overlap the function has two URLs:**
- the **existing URL**, `AuthType: AWS_IAM`, on the unqualified function, serving the SigV4 path for any caller still pinned below vM;
- a **new URL**, `AuthType: NONE`, on an alias, `live`, serving the token path only.

The handler tells them apart by the qualifier of the ARN it was invoked through, which Lambda sets, never by the request: an IAM-shaped request on the alias's URL, or a bearer token on the unqualified one, is refused. During the overlap **the SigV4 path also reads its keys from the table** (the role's key must have a registration that is `active`), so a suspension holds on both paths, and `WRITER_KEYS` is already unused.

**The steps,** in the order the Owner runs them:
1. **Before vM's tag:** J6's sandbox checks pass (§4.2): a personal-account token's `repository_owner_id`, and a collector token's `job_workflow_ref` at a tag.
2. **Deploy vM's template** beside today's stack resources (the roles stay): the register table, the alias and its URL, the self-read role, the `Audience` and `MIN_TOKEN_VERSION` parameters. *Check:* `verify.mjs` passes, including the new checks (§13).
3. **Import both entries:** `register.mjs import --register <the private register file>`, which resolves each repository's ids and default branch through `gh api`, keeps each key exactly, and carries `publish_own_figures_as`, `aggregate_invoker` and `first_review` across. *Check:* `register.mjs list` shows two `active` registrations, by repository; the function answers each key's SigV4 call as before.
4. **Move both pins to vM,** Kanon's through Dependabot's `kanon` group and the operator's repository's the same way, and in the same pull request each drops `url:` and `writer-role:` from the collector's caller, and the reading lanes' role secrets from theirs. *Check:* each repository's next collector run is green on the token path, its summary says `active`, and its rows land under the same `<key>#<lane>` partitions as the day before; the Overseer's and the Explorer's next runs read through the token.
5. **Delete the two repositories' variables** (`KANON_TELEMETRY_URL`, `KANON_TELEMETRY_WRITER_ROLE`) and secrets (`KANON_TELEMETRY_READER_ROLE`, `KANON_AGGREGATE_ROLE`, and the `KANON_AGGREGATE_URL` variable). *Check:* a week of runs with none of them, all green.
6. **vM+1 removes the old path:** the IAM URL and its permissions, the SigV4 branch of the handler, the writer, reader and aggregate-invoker roles, `render.mjs` and `register.example.json`, the environment's per-key variables, the collector's `url` and `writer-role` inputs (deprecated and ignored at vM, refused at vM+1, which `kanon doctor` reports first as `caller.input-unknown`), and the SigV4 signing in the collector. *Check:* the template test fails on any `AWS::IAM::Role` whose trust names GitHub's OIDC provider; `verify.mjs` reports the IAM URL gone.
7. **The private register file is deleted** from the operator's storage, once step 6 is deployed and a week of runs agree with the table (§10).

**Rollback.** Until step 6, the old path is whole: a repository whose pin goes back below vM writes through SigV4 with the same key. After step 6 there is no rollback to roles but a release that restores them.

**Owner-only paths at vM+1.** The importer, the backfill role and the Kolophon import role (plan 0002 §7) are role-based callers of the IAM URL. At vM+1 they become **direct invocations** of the function by the Owner, which only a principal holding `lambda:InvokeFunction` outside a URL can make (only the Owner's role, as for the aggregate check in `docs/telemetry.md` today), with the adopter's key named in the event. That is the one path still held by IAM, and the only one that can name a key.

## 10. The operator's side

These steps live in the operator's private repository, not in Kanon. Each is **offloaded to the operator's repository as issues**, filed when its Kanon step merges, and Kanon's step names the issue. Nothing in them names an adopter here.
- **The register migration** (§9, steps 3 and 7): run the import, compare a week of runs against the old file, then delete the file and the rendered parameters beside it.
- **The Kanon-bug job reads keys from the table** (plan 0002 S10, plan 0006 F5): `kanon-bugs.mjs` and `kanon-findings.mjs` take `--register`, a file today; the job reads the key items and `name_hashes` from the table with its existing role, given the projection of §5.3, and writes them to a temporary file for the run. It also reports daily the `refused#…` counters (§6), and any tombstone without `rows_erased_at` after a day (§7).
- **The deploy checklist:** render and the register leave it; the checklist becomes package, deploy with parameters, `verify.mjs`, and the live token checks (§13).

## 11. What changes in the trust model, stated plainly

**Today, IAM enforces who may write and read each key.** A writer role trusts one repository's default-branch subject and can only invoke the URL; the function maps the role's name to its key; a reader role can only `Query` its own `LeadingKeys`. A bug in the function's code can corrupt rows, but AWS still keeps one adopter's credentials away from another's partitions.

**After this plan, code enforces it.** The function's token checks decide which repository is calling, and the registration decides its key. **A bug in the verifier, or in how a key is looked up, opens every key,** for writing, for reading through `GET /v1/rows/self`, and for erasure. What stays with IAM: the table's resource policy (only the function and the Owner write rows), the function's role (it can't write an operator field of the register, §5.3), the read session policy (a query can't leave the chosen key, §3.5), the aggregate's projection, and the Owner-only direct invocation (§9).

**What gets stronger.** Today any default-branch job holding `id-token: write` can assume the writer (`K-OBS-13`'s **Not enforced**). After it, only Kanon's collector job, at a Kanon release, gets a token the store accepts, so `K-OBS-13`'s **Not enforced** sentence goes. The register leaves git, so no model reviewing a pull request can read it (#629).

**The proposed amendments,** landed in J5 as "from vM", and with the IAM sentences removed in J9:
- **`K-OBS-13`, Enforced by:** "The hosted store's ingest function accepts a row only with a GitHub OIDC token whose `job_workflow_ref` is Kanon's `telemetry-collect.yml` at a release tag, issued for the repository's default branch, with the store's audience (`infra/telemetry/function/oidc.mjs`, one mutation-checked test per claim in `tests/unit/telemetry-oidc.test.ts`). This is enforced by Kanon's code, not by IAM: the function is the gate." The **Not enforced** sentence is replaced by: "Not enforced: that the rows the collector sends are true; a repository can upload any artifact from its own workflows, and send it under its own key."
- **`K-OBS-16`, Enforced by:** "`infra/telemetry/render.mjs` writes into its environment" becomes "the function computes from the token's `repository` claim".
- **`K-OBS-18`, Rule, "Who sees what":** unchanged. **Enforced by**, new: "Each adopter reads only its own rows through the function, which finds the key from the token's `repository_id` and reads under a session policy scoped to that key; which key is chosen is code-enforced." **Where and how long:** "deleted on request" gains "by the adopter, with one dispatch of its caller, or by the operator".
- **ADR 0007,** a dated note under its amendments: rule 5 is unchanged; its enforcement for the hosted store moves from IAM roles to the ingest function's token checks; the register leaves git for a KMS-encrypted table; and erasure is self-service. No rule changes.
- **Plan 0002:** a header line saying §3, §4's option C, §5's register, §6's reader role, §6.1's invoker role and §10's step 1 are replaced by this plan, each section pointing here.

## 12. Cost

**Estimate: unchanged at about $0.05 to $0.10 a month, under the $1 ceiling** (plan 0002 decision 10).

| Item | Driver | Month |
|---|---|---|
| Register table: storage and requests | a few KB; one `GetItem` and one or two counter `UpdateItem`s per request, about 2,200 requests a month for three adopters | < $0.01 |
| KMS, the AWS-managed key | no key fee; DynamoDB caches its data keys, so a few thousand KMS requests at most | < $0.01 |
| Lambda: the same calls, plus JWKS fetches | about 4 fetches an hour per warm container; outbound HTTPS from a function outside a VPC is free | < $0.01, inside the free tier |
| STS for the self-read session | one call per read page | $0 |
| Point-in-time recovery on the register | a few KB | < $0.01 |
| IAM roles | **fewer**: three per adopter go | $0 |

**What it costs that today's design doesn't: a public URL.** Today the URL's IAM auth refuses an unsigned request before the function runs, at no charge. With `AuthType: NONE` every request runs the function, which refuses it in milliseconds. A flood is bounded by **reserved concurrency 2** (throttled requests are not billed): at about 20 ms a refusal, two instances serve at most about 100 a second, which at Lambda's Frankfurt list prices as I know them is a few dollars over a month of continuous flooding, and the budget alert at $1 says so within a day. So **the reservation is a precondition** of step 2 in §9: plan 0002 decision 15 deploys without one until the account's concurrency quota is raised, and that raise must be granted first. A WAF rule would cost more than the whole store ($5 a month and up), and isn't proposed. **The prices are not run against the price list;** J6 runs plan 0002's pricing commands for Lambda and KMS before the Owner approves.

**What it saves.** IAM's roles-per-account quota stops bounding the number of adopters. The operator's time per adopter goes to zero.

## 13. `verify.mjs`, and the live token checks

**`verify.mjs` keeps** checks 1 to 3 and 6 to 13 (the row, the field, the partition, the expiry, the table's resource policy, and plan 0006's finding checks), sent through the alias's URL with a token from §13's workflow instead of the writer role. **It drops** check 4 (the reader denied another key by IAM) and check 5 (the writer's direct `PutItem`), whose roles are gone at vM+1. **It adds,** each a PASS or FAIL naming the code it saw:

| New check | Expected |
|---|---|
| a request with no `Authorization` | 401 `token` |
| a token signed by a key the Owner generates, with a `kid` GitHub lists | 401 `signature` |
| the same with an unlisted `kid` | 401 `kid` |
| a token with `alg: none` | 401 `alg` |
| the register table's encryption | `SSEType` is `KMS` |
| the register table's resource policy, through a probe role allowed every action by its own policy | every read and write denied by the resource policy |
| the function's role writing `aggregate_invoker`, simulated with `iam simulate-principal-policy` | denied |
| a `suspend` then `resume` of Kanon's own registration with `register.mjs`, around one request from §13's workflow | 403 `suspended`, then 200 |

**The checks that need a token GitHub signed** can't run from the Owner's terminal. A dispatch-only Kanon workflow, `telemetry-verify.yml`, mints tokens and sends each to the hosted URL; every one is expected to be **refused**, by the code below, since its job is not the collector:

| Token | Expected |
|---|---|
| audience `kanon-telemetry-wrong` | 401 `aud` |
| the default audience | 401 `aud` |
| audience `kanon-telemetry`, sent at once | 403 `workflow` (its `job_workflow_ref` is `telemetry-verify.yml`) |
| audience `kanon-telemetry`, sent after 11 minutes | 401 `time` |
| the payload of a valid token with one character changed | 401 `signature` |

Its one job holds `id-token: write` and joins the id-token guard's allow-list in its exact shape. **The positive path is Kanon's own collector,** whose next run after the pin moves is green on the token path (§9, step 4). **What no live check reaches:** `event_name`, `ref`, `ref_type` and `repository_owner_id`, because a token that reaches those checks has passed check 7, and only the collector can mint one. Those four are held by J1's unit tests and their mutations alone, and this plan says so rather than claiming a live check.

## 14. Order of moves

| Step | Where | What | Falsifiable check |
|---|---|---|---|
| **J1** | Kanon | **The verifier,** `infra/telemetry/function/oidc.mjs` (§2.2, §2.4, §2.5), with the JWKS cache, `node:` built-ins only. Not wired to any endpoint. | `tests/unit/telemetry-oidc.test.ts`: a token signed in the test passes; each refusal in §2.5's table answers its code. **Mutations:** every row of §2.5's table, each run on a copy and restored from the backup, each turning its named test red; the pull request lists them. |
| **J2** | Kanon | **The register table and the CLI** (§5): the table in the template, its resource policy and the roles' attribute conditions; `register.mjs` with `list`, `suspend`, `resume`, `set`, `erase` and `import`. | `telemetry-store-template.test.ts`: the table is KMS-encrypted, retained, deletion-protected, with point-in-time recovery; the ingest role's `dynamodb:Attributes` holds no operator field; the resource policy denies all but the four principals. `register.mjs` tests: its output holds no key, with a register of keys as input; `import` keeps each key. **Mutations:** adding `aggregate_invoker` to the ingest role's attribute list turns the template test red; printing a key in `list` turns the output test red. |
| **J3** | Kanon | **The five endpoints** (§3), on the alias's URL, with registration, quotas (§6), erasure (§7) and the name hashes from the token (§3.4); the SigV4 path reading keys from the table (§9). | `telemetry-ingest.test.ts`: each row of §3.2's table, each status code; two concurrent registrations make one; a batch past the day's quota is refused whole and counted in `refused#…`; `GET /v1/rows/self` never returns another key's row, nor one past `expires_at`; an erased key's next `POST /v1/rows` gets 410 and its partitions are empty; no response holds the key. **Mutations:** a quota check that stores the rows that fit fails the whole-batch test; a lookup that takes the key from the request instead of the registration fails the cross-key test; an erasure that leaves the key item fails the tombstone test; the IAM path on the alias's URL fails the URL-separation test. |
| **J4** | Kanon | **The aggregate function on the token** (§3.6): `aggregate_invoker` and labels from the table; suspended keys left out. | `telemetry-aggregate.test.ts`: a registration without `aggregate_invoker` gets 403; a suspended key's rows are in no cell and no signal. **Mutation:** reading `aggregate_invoker` from the token's repository instead of the table fails the first. |
| **J5** | Kanon **vM** | **The collector and the two reading lanes on the token path** (§2.1, §8): a fresh token per request; the hosted URL as the default, with `url` and `audience` only together; the `erase` and `register` inputs; `url` and `writer-role` deprecated and ignored. `kanon init` writes the new caller; doctor's findings change (§8); `docs/telemetry.md`, `docs/sharing.md`, `docs/init.md` and `docs/doctor.md` follow; the registration issue template goes; the rule and ADR amendments of §11 land, as "from vM"; the tag ruleset is the Owner's GitHub step. | `telemetry-collect.test.ts`: a token is never printed or written; with `url` and no `audience`, the run refuses before minting one. The guard on the collect job's `if:` (§2.3). `kanon-init.test.ts`: the caller has no `vars.`. The id-token guard's shapes for the three jobs. **Mutations:** dropping the default-branch clause from the `if:`, sending the hosted audience to a `url` input, and a fourth step in the collect job each turn their test red. |
| **J6** | the Owner, with Kanon's scripts | **Before vM's tag:** the sandbox checks of §4.2, and plan 0002's price commands for Lambda and KMS. **After it:** deploy (§9 step 2), `verify.mjs`, `telemetry-verify.yml`, and the import (§9 step 3). **The register migration is offloaded to the operator's repository as issues** (§10). | §4.2: a real collector token at vM has `job_workflow_ref` at `@refs/tags/v<vM>`, and `exp − iat` is recorded; a personal account's `repository_owner_id` is its owner's id. `verify.mjs` and `telemetry-verify.yml` PASS every row of §13. `register.mjs list` shows two `active` registrations. |
| **J7** | Kanon and the operator's repository | **The pins move to vM** (§9 steps 4 and 5). | Each repository's next collector run is green on the token path, says `active`, and its rows land in the same partitions; a week later, no variable or role secret remains and every run is green. |
| **J8** | the operator's repository | **Offloaded to the operator's repository as issues** (§10): the Kanon-bug job reads keys and name hashes from the table, and reports the refused counters and unfinished erasures; the deploy checklist. | The job's next run files the same signals from the table as from the file. A seeded `refused#…` counter appears in its daily report. |
| **J9** | Kanon **vM+1** | **The old path goes** (§9 step 6): the IAM URL, SigV4, the three per-adopter roles, `render.mjs`, `register.example.json`, the per-key environment, the deprecated inputs; the Owner-only paths become direct invocations; the IAM sentences of §11's amendments go. The private register file is deleted (§9 step 7, J8's issue). | The template test fails on any role trusting GitHub's OIDC provider, and on any per-key environment variable; `verify.mjs` reports the IAM URL gone; a direct invocation by the Owner naming a key stores a `test` row, and the same event through the URL is refused. **Mutation:** restoring `WriterRole` to the template turns the template test red. |
| **J10** | Kanon, after J9 | **Close #607 and #629.** | `grep -rn "NAME_HASHES\|WRITER_KEYS" infra docs` finds only this plan and plan 0006's history; `docs/telemetry.md` names no register file. |

**Why this order.**
- **The verifier first, alone:** it is the gate everything else stands behind, and its tests and mutations are reviewed before any endpoint trusts it.
- **The table before the endpoints,** since registration, quotas and suspension are all reads and writes of it.
- **One release for everything the adopter sees** (J5), so the two existing repositories move in one step, as decision 4 has it.
- **Nothing is removed until a real token has been seen** (J6's first check, J7), because two of the claims this plan relies on are not confirmed in GitHub's documentation (§4.2).

## Out of scope

- **Proving that rows are true.** The token proves the sender is Kanon's collector at a release; the rows are still what the repository's own runs uploaded (§2.2). A signed artifact, or rows sent by the lanes themselves, would be another plan.
- **A custom domain** for the URL. It would hide the function URL's form behind a name, at the cost of a hosted zone and a certificate; not needed for anything here.
- **An API Gateway, a WAF,** or any always-on component (§12).
- **Self-hosted stores' registration.** The same template works in an adopter's own account with its own audience; how an adopter operates it is its own (`K-OBS-17`, plan 0002 decision 12).
- **The three-adopter rule's definition** beyond the open question below; plan 0002 decision 7 stands.
- **Kolophon's S8 import** (plan 0002), which this plan only re-routes (§9).

## Decisions left open

Each has a proposed default, which the plan assumes unless the Owner decides otherwise.

1. **`job_workflow_sha` pinned to release commits?** Default: **no**; immutable releases plus a tag ruleset on `v*` (J5) hold the tag. The alternative is a list of release commits the release workflow writes to the table, checked on every call.
2. **The self-read session policy** (§3.5). Default: **keep it**, so a query can't leave the chosen key. The alternative is the function's own role querying every key, simpler by an STS call.
3. **Store the repository's name** in the registration (§5.2)? Default: **yes**, encrypted and readable only by the function and the operator, because the operator needs it to act on a request that names a repository, and the CLI prints by repository. The alternative is ids only, resolved through `gh api` when needed, which fails for a private repository the operator can't read.
4. **A customer-managed KMS key** for the register (§5.1). Default: **no**; the AWS-managed key, at no fee. A customer-managed key's policy would add an access control, for $1 a month, which is the whole ceiling.
5. **The tombstone's lifetime** (§7). Default: **kept with no expiry**, holding only the two ids, the status and two dates, because it is what stops a restored caller from registering again unasked. The alternative is a TTL, after which a caller still present re-registers.
6. **The quotas** (§6): 5,000 rows a day, 120 requests an hour, 20 registrations per owner and 100 store-wide a day. Default: **as proposed**, revisited when an adopter reaches a tenth of any.
7. **Who counts as an adopter for the three-adopter rule,** now that registering is free. Default: **distinct `repository_owner_id`s, not keys**, so three repositories of one owner are one adopter. This changes how plan 0002 decision 7 counts, not its threshold. The alternative keeps counting keys, and lets one owner make a public cell or a public Kanon issue alone.
8. **The JWKS cache:** 15 minutes, a refetch at most once a minute, and no stale keys when GitHub's endpoint is down. Default: **as proposed** (fail closed).
9. **Token lifetime bounds:** 60 seconds of skew, a 10-minute maximum age. Default: **as proposed**, revisited when J6 records `exp − iat`.
10. **Publishing the hosted URL** in the public tree (§2.1, §12), which today stays out of it. Default: **publish it**, since it is not a credential and the token is the gate, with reserved concurrency in place first. The alternative is a custom domain (out of scope above).

## Owner decisions (2026-10-10)

Taken by the Owner on the source note's four open questions, before this plan was drafted, and not reopened:

1. **Activation:** a new registration is **active at once**, with per-key rate limits and daily quotas. The operator can **suspend** a key with one CLI call, no deploy. Publishing still needs three adopters, and only Kanon's collector can get a usable token (`job_workflow_ref`). §3.3, §5.3, §6.
2. **Aggregate access** (`aggregate_invoker`, `publish_own_figures_as`) **moves to the table** as fields only the operator's CLI sets. The adopter reads its own figures through the API, which removes the last per-adopter IAM role. §3.6, §5.3.
3. **Audience:** **one value per store**, `kanon-telemetry`. A future test store gets its own. It has nothing to do with the adopter's environments: telemetry is per repository. §2.2 check 4, §5.1.
4. **Migration:** **both existing register entries, Kanon and the operator's private repository, move at once, in one release**, with keys unchanged. SigV4 ingest runs beside the token path for that one release and is removed in the next, together with the per-adopter IAM roles. §9.
