#!/usr/bin/env node
// The telemetry collector (plan 0002 S7): sweeps this repository's version-2 run rows from
// their artifacts and sends each to the hosted store's ingest function, as its one writer.
//
// MOVED, NOT REWRITTEN (ADR 0009). This is the reference adopter's hourly collector, with the
// parts S7 changes and nothing else:
//   - it sends only version 2, the `kanon-telemetry-*` artifacts, to the function, 25 rows to a
//     `POST` (§4), where it used to push the version-1 row to the adopter's own table and
//     bucket; there is one store and one step (ADR 0009 §2: no second live copy);
//   - a row is checked with `validate` before it is sent, so a bad row fails the collector with
//     the field's NAME (§2.5), and a row whose lane, run or attempt isn't its artifact's is
//     refused, because the artifact listing is the only thing vouching for it;
//   - only this repository's own runs count (`listTelemetryArtifacts`): a fork's run can upload
//     any row under any name, and this job holds the store's credential.
// What is kept as it was: the watermark, the floor and the override, the one paginated artifact
// scan, the download by id, and the red run as the page. One thing changed since (kanon#315): an
// override's run is no longer a watermark, so a short override can't hide the rows before it.
//
// GITHUB'S OIDC TOKEN, NOT A ROLE (plan 0008 §2.1, §3, step J5). Each request carries a fresh
// token for the store's audience (`scripts/lib/telemetry-token.mjs`), which the store checks claim
// by claim: this repository, its default branch, and Kanon's collector at a release. The hosted
// store's URL is a constant, and a self-hosted store is named by the `url` and `audience` inputs
// together, never one alone (`check`, the step before any token is minted). A caller that still
// passes a `url` without an `audience`, as every caller before the token path did, is refused
// there, red, before any token: it sends nothing and registers nothing, and its URL is never
// swapped for the hosted store's (Owner decision of 2026-10-14, #842). The SigV4 path's
// `writer-role` input is gone since plan 0008 J9, so GitHub refuses a caller that still passes it
// before the job starts, and `kanon doctor` names the line (`caller.input-stale`).
//
// REGISTRATION IS THE FIRST RUN (§3.2, §3.3, §8). `POST /v1/rows`; on 404 `not-registered`,
// `POST /v1/registrations` once, then the rows again. A run with no row to send asks
// `GET /v1/registrations/self`, and registers on a 404, so a quiet repository registers too. A
// refusal stops the sweep and is said with its own title, `telemetry-refused`, which `kanon doctor`
// reads (`telemetry.refused`): 403 `suspended` and 429 `quota` turn the run red; 410 `erased` (and
// 409 `erased` on registering) keeps it green with a warning, since the adopter asked for it.
// A dispatch with `erase: yes` calls `DELETE /v1/registrations/self` and sends nothing (§7); one
// with `register: yes` sends `{ "reregister": true }` first, after an erasure (§3.3).
//
// AN ANCHOR, NOT A PERSISTED CURSOR. The function keys a row from its own fields (`recorded_at`,
// run, attempt, number), so re-sending an artifact overwrites its row identically. Over-sweeping
// is therefore free, and the span can be derived rather than remembered: each sweep reaches back
// to the START of the last sweep whose collect job SUCCEEDED, floored at WINDOW so there is still
// an overlap. A fixed span heals one dropped schedule and not two (the reference adopter lost a
// four-hour hole that way, silently), and GitHub documents scheduled runs as best effort.
//
// CAPPED AT 7 DAYS, OR AT THE REPOSITORY'S RETENTION WHEN THAT IS SHORTER (S1a, #212). The
// function refuses a `recorded_at` older than 8 days (§4), and an artifact past the repository's
// retention is gone. A watermark older than the cap means rows were lost, and the run says so.
//
// FINDING ROWS (plan 0006 §5, step 3). The Overseer's and the telemetry Explorer's filing jobs
// upload their upstream findings as `kanon-finding-<reporter>-<run id>-<attempt>`, a JSON array of
// finding rows. The same sweep lists them beside the run rows, and sends them under the level the
// adoption record declares ON THE DEFAULT BRANCH, read again by this job before it sends any
// (§3.1, `K-LAYOUT-10`): `drafted` or `filed here` sends none; `sent` sends each row as codes
// only, stripped of its evidence fields; `sent with evidence` sends each row as the lane built it.
// So turning the level down stops the text at the next sweep, even for artifacts written before,
// and nothing the lane or its agent wrote can raise it. A record that is malformed or can't be read
// sends no finding row, and turns the run red; the run rows are still sent.
// Each finding row is checked against its artifact (reporter, run, attempt), then the scrub's
// `verify` runs on its text with the context intake will use, this repository's owner and name: a
// text that fails it is sent at `codes`, with a warning naming the rule, so an older lane's weaker
// scrub can't turn the collector red forever (§5). Then `validate`, as for a run row.
//
// WORK-ITEM ROWS (plan 0003 §3.1, M4). The same sweep then runs the work-item step
// (`telemetry-work-items.mjs`): one row per pull request closed in the span, and the row again of
// an earlier item a merge in the span reverted or fixed, or whose Reviewer follow-up closed. They
// are derived from GitHub with this job's token, as `kanon metrics dry-run` derives them, and sent
// in the same batches as the run rows. The store keys each by its PR number alone, so a row sent
// again overwrites the one before. A read that fails turns the run red, and the next sweep covers
// the same span again.
//
// DEPLOY ROWS (plan 0010 §8, §10, step D9). The deploy lane's `record` jobs upload one `deploy`
// row per environment as `kanon-deploy-row-<run id>-<attempt>-<position>`, outside the
// `kanon-telemetry-` prefix (kanon#826). The same sweep lists them, checks each row against its
// artifact (run, attempt, position) and with `validate`, and sends it beside the run rows. The
// store keys it `<key>#deploy` by time, run, attempt and position, so a re-sent row overwrites
// itself.
//
// SMOKE-CHECK ROWS (plan 0013 §8, step S3). The smoke workflow's `record` job (S5) uploads one
// `smoke_check` row per run as `kanon-smoke-row-<run id>-<attempt>-<position>`, named as a deploy
// row's artifact is and also outside the `kanon-telemetry-` prefix. The same sweep lists them and
// checks and sends each as it does a deploy row; the store keys it `<key>#smoke_check` the same
// way. A collector pinned before S3 doesn't list the family, and its artifacts expire unsent.
//
// NOTIFY ROWS (plan 0011 §11, step N5). Each lane's `notify` job uploads one `notify` row as
// `kanon-delivery-<lane>-<run id>-<attempt>`, the job's own run and attempt, holding
// `kanon-delivery.json`, also outside the `kanon-telemetry-` prefix. The same sweep lists them,
// checks each row against its artifact (lane, run, attempt) and with `validate`, and sends it
// beside the run rows. The store keys it in the lane's partition under `notify#`, so a re-sent row
// overwrites itself and never a run row. A collector pinned before N5 doesn't list the family, and
// its artifacts expire unsent.
//
// LOGS HOLD COUNTS, IDS, LANES, FIELD NAMES AND THE STORE'S CODES, NEVER A ROW'S VALUE OR A TOKEN
// (ADR 0007).
//
//   node "$KANON/scripts/telemetry-collect.mjs" check   the collect job's step before the sweep:
//                                                       the inputs, before any token is minted
//   node "$KANON/scripts/telemetry-collect.mjs"         the sweep, or the erasure on `erase: yes`

import { appendFileSync } from 'node:fs';

import { describeErrors, MAX_FINDINGS, SCHEMAS, validate } from '../actions/agent-telemetry/schema.mjs';
import { nameContext, verify } from '../actions/agent-telemetry/scrub.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import {
  ARTIFACT_FILE, DELIVERY_ARTIFACT_FILE, DEPLOY_ARTIFACT_FILE, FINDING_ARTIFACT_FILE, ghApi, ghDownload, listTelemetryArtifacts, readZipEntry,
  SMOKE_ARTIFACT_FILE,
} from './lib/telemetry-artifacts.mjs';
import { codeOf, HOSTED_INGEST_URL, REFUSED_TITLE, storeOf, storeRequest, TokenError, UNPUBLISHED_JOB } from './lib/telemetry-token.mjs';
import { readUpstreamFindingsFrom, SENT_VALUES } from './lib/upstream-findings.mjs';
import { ghAsync, workItemStep } from './telemetry-work-items.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The floor: even when the last sweep was minutes ago, overlap by this much. */
export const WINDOW_MINUTES = 90;
/** The ceiling: the function's 8-day `recorded_at` window less a day's slack (§4, §1.2). */
export const SWEEP_CAP_DAYS = 7;
/**
 * Rows per `POST`, the function's own `MAX_ROWS` (§4). Not imported from it: the function's
 * directory links the schema module, and this script runs from the Kanon tree a lane downloads.
 */
export const MAX_ROWS = 25;
/** The collect job's name in `telemetry-collect.yml`, by which a run's success is judged. */
export const COLLECT_JOB = 'Collect telemetry rows';
/**
 * The same job's name on a `window_minutes` override. Never a watermark: an override sweeps the
 * operator's span, which may start after the last full sweep, so anchoring on it would drop the
 * rows in between without a warning (kanon#315).
 */
export const COLLECT_JOB_OVERRIDE = `${COLLECT_JOB} (window override)`;
/** The same job's name on an `erase: yes` dispatch, which sweeps nothing, so is never a watermark. */
export const ERASE_JOB = 'Erase telemetry';
/**
 * The same job's name at a release whose hosted store's URL is unpublished, when the caller names
 * no store of its own: the run skips, green, so it is never a watermark. Anchoring on it would make
 * the first real sweep, at the release that publishes the URL, reach back 90 minutes instead of to
 * the last sweep before the skips, and drop the rows in between (#843). The job's name is
 * evaluated before this script runs, so the workflow at such a release held its own literal for
 * the case; this tree publishes the URL, and its workflow has none, which
 * tests/unit/telemetry-collect-lane.test.ts holds to `HOSTED_INGEST_URL`. The name stays because
 * a caller pinned at an older release still runs under it, and the watermark and `kanon doctor`
 * read those runs.
 */
export { UNPUBLISHED_JOB };

/** A finding row's free-text fields (plan 0006 §2.2), read from the schema: the `text` type. */
export const TEXT_FIELDS = Object.freeze(Object.entries(/** @type {Record<string, { type: string }>} */ (SCHEMAS.finding?.[1] ?? {}))
  .filter(([, f]) => f.type === 'text').map(([name]) => name));
/** What `sent` strips from a row: the text, and the scrub version that goes with it. */
const EVIDENCE_FIELDS = Object.freeze([...TEXT_FIELDS, 'scrub_version']);

/**
 * A finding row at `codes`: the evidence fields dropped, the level lowered. A copy.
 * @param {Record<string, unknown>} row
 */
export function codesOnly(row) {
  /** @type {Record<string, unknown>} */
  const out = { ...row, evidence_level: 'codes' };
  for (const f of EVIDENCE_FIELDS) delete out[f];
  return out;
}

/**
 * A finding row as the adoption record's level lets it leave (plan 0006 §3.1), or null when the
 * level sends none. `sent` strips the evidence of a row above it; `sent with evidence` sends it as
 * built. Never raises a row's level.
 * @param {Record<string, unknown>} row
 * @param {string} level the record's `Upstream findings` value
 * @returns {{ row: Record<string, unknown>, stripped: boolean } | null}
 */
export function underLevel(row, level) {
  if (!(/** @type {readonly string[]} */ (SENT_VALUES)).includes(level)) return null;
  if (level === 'sent' && row.evidence_level !== 'codes') return { row: codesOnly(row), stripped: true };
  return { row, stripped: false };
}

/**
 * The scrub rules that would still fire on a finding row's text, by field, with the context intake
 * uses for this repository: its owner's and name's words (plan 0006 §4.2). Never the text.
 * @param {Record<string, unknown>} row
 * @param {Set<string>} nameHashes
 * @returns {{ field: string, rules: string[] }[]}
 */
export function textFailures(row, nameHashes) {
  return TEXT_FIELDS.filter((f) => typeof row[f] === 'string')
    .map((field) => ({ field, rules: verify(/** @type {string} */ (row[field]), { nameHashes }) }))
    .filter((x) => x.rules.length);
}

/**
 * @typedef {import('./lib/telemetry-artifacts.mjs').Api} Api
 * @typedef {import('./lib/telemetry-artifacts.mjs').Download} Download
 * @typedef {{ status: number, json: any, retryAfter?: string | null }} PostResult
 * @typedef {(rows: object[]) => Promise<PostResult>} Post
 * @typedef {(since: number) => Promise<import('./telemetry-work-items.mjs').StepResult>} WorkItems
 */

/**
 * How far back the sweep reaches, and whether rows were lost past its cap.
 *
 * An override (`window_minutes`) is an operator instruction and is honoured exactly, up to the
 * cap. Otherwise: the last successful sweep's start, no later than the floor and no earlier than
 * the cap. With no successful sweep, or an unreadable one, everything reachable: sweeping too
 * much overwrites identically, and sweeping too little loses rows silently.
 *
 * @param {{ lastSuccess: string | null, now: number, windowMinutes?: number, overridden?: boolean, retentionDays?: number | null }} opts
 * @returns {{ since: number, capped: boolean, capDays: number }}
 */
export function sweepSince({ lastSuccess, now, windowMinutes = WINDOW_MINUTES, overridden = false, retentionDays = null }) {
  const capDays = retentionDays !== null && retentionDays < SWEEP_CAP_DAYS ? retentionDays : SWEEP_CAP_DAYS;
  const cap = now - capDays * DAY;
  const floor = now - windowMinutes * MINUTE;
  if (overridden) return { since: Math.max(floor, cap), capped: floor < cap, capDays };
  const watermark = lastSuccess === null ? NaN : Date.parse(lastSuccess);
  if (!Number.isFinite(watermark)) return { since: cap, capped: false, capDays };
  if (watermark > floor) return { since: floor, capped: false, capDays };
  if (watermark < cap) return { since: cap, capped: true, capDays };
  return { since: watermark, capped: false, capDays };
}

/**
 * The top-level workflow's file, from `GITHUB_WORKFLOW_REF`
 * (`<owner>/<repo>/.github/workflows/<file>@<ref>`). In a called workflow that is the CALLER's,
 * which is where GitHub files the run, so the watermark needs no fixed file name.
 * @param {string | undefined} ref
 */
export function workflowFileOf(ref) {
  return /\/\.github\/workflows\/([^/@]+\.ya?ml)@/.exec(ref ?? '')?.[1] ?? null;
}

/**
 * When the last sweep whose collect job succeeded started, or null when there was none.
 *
 * The RUN's success isn't enough: a run that skipped collecting because the store isn't set up
 * yet also succeeds, and anchoring on it would drop the rows of the time before. So each
 * successful run on the branch is checked for the collect job's own success, newest first.
 * A `window_minutes` override's run is passed over the same way: its job is named
 * `COLLECT_JOB_OVERRIDE`, which matches neither form below (kanon#315). So is a run that skipped
 * because the hosted store's URL is unpublished, named `UNPUBLISHED_JOB` (#843).
 *
 * @param {{ api: Api, repo: string, file: string, branch: string, selfRunId: string, limit?: number }} opts
 */
export function lastSuccessfulSweep({ api, repo, file, branch, selfRunId, limit = 20 }) {
  const runs = api(`repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?status=success&branch=${encodeURIComponent(branch)}&per_page=${limit}`)?.workflow_runs ?? [];
  for (const run of runs) {
    // Never this run: it would be its own watermark and conclude that no time has passed.
    if (String(run.id) === selfRunId) continue;
    const jobs = api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)?.jobs ?? [];
    const collected = jobs.some((/** @type {any} */ j) => (j.name === COLLECT_JOB || String(j.name).endsWith(` / ${COLLECT_JOB}`)) && j.conclusion === 'success');
    if (collected) return String(run.created_at);
  }
  return null;
}

export { REFUSED_TITLE };
/** The limits a 429 names (plan 0008 §6), a closed list. */
const LIMITS = ['rows_per_day', 'requests_per_hour', 'registrations'];

/**
 * @typedef {{ status: number, code: string, red: boolean, words: string }} Refusal
 */

/**
 * A store's answer that stops the sweep (plan 0008 §3.2, §6, §7), or null: 403 `suspended` and
 * 429 `quota`, red; 410 `erased`, and 409 `erased` or `erasing` on registering, green, since the
 * adopter asked for it. Any other 403, a check on the token's workflow, event, owner or branch, is
 * red too: every later batch would be refused the same. Said in the store's codes, never a value.
 * @param {number} status @param {any} json @param {string | null} [retryAfter]
 * @returns {Refusal | null}
 */
export function refusalOf(status, json, retryAfter = null) {
  const code = codeOf(json) ?? 'none';
  const said = `the store answered ${status} ${code}`;
  if ((status === 410 && code === 'erased') || (status === 409 && (code === 'erased' || code === 'erasing'))) {
    return { status, code, red: false, words: `${said}: this repository's telemetry was erased at its request, so nothing is sent. To send again, dispatch the caller with register: yes; to stop for good, delete the caller (docs/sharing.md).` };
  }
  if (status === 403 && code === 'suspended') {
    return { status, code, red: true, words: `${said}: Kanon's operator suspended this repository's registration, so nothing is stored until the operator resumes it (docs/telemetry.md, "The register table").` };
  }
  if (status === 429) {
    const limit = LIMITS.includes(json?.limit) ? json.limit : 'a limit';
    const resets = typeof json?.resets_at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(json.resets_at) ? json.resets_at : (retryAfter && /^\d{1,6}$/.test(retryAfter) ? `in ${retryAfter} s` : 'later');
    return { status, code, red: true, words: `${said}: past ${limit}, which resets at ${resets}. Nothing from the request was stored, and the next sweep after the reset sends the same span again (docs/telemetry.md, "Quotas").` };
  }
  if (status === 403) {
    return { status, code, red: true, words: `${said}: the store refused this job's token (plan 0008 §2.2, check \`${code}\`). The collector sends only from its caller's schedule or a dispatch on the default branch, at a Kanon release (docs/telemetry.md, "Who can write").` };
  }
  return null;
}

/**
 * @typedef {import('./lib/telemetry-token.mjs').Store} Store
 * @typedef {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch, mask?: (secret: string) => void }} TokenIo
 */

/**
 * The default `post(rows)`: `POST /v1/rows` with a fresh token. On 404 `not-registered`, the
 * first default-branch run registers, once, with `POST /v1/registrations`, and sends the rows
 * again (plan 0008 §3.2); a registration that isn't answered 200 or 201 is the answer.
 * @param {Store} store @param {TokenIo} io
 * @returns {Post}
 */
export const tokenPost = (store, io) => {
  let registered = false;
  return async (rows) => {
    let res = await storeRequest(store, { method: 'POST', path: 'v1/rows', body: rows }, io);
    if (res.status === 404 && codeOf(res.json) === 'not-registered' && !registered) {
      registered = true;
      const reg = await storeRequest(store, { method: 'POST', path: 'v1/registrations', body: {} }, io);
      if (reg.status !== 200 && reg.status !== 201) return reg;
      res = await storeRequest(store, { method: 'POST', path: 'v1/rows', body: rows }, io);
    }
    return res;
  };
};

/**
 * The registration's status, for a run that sent no row: `GET /v1/registrations/self`, and on
 * 404 `not-registered`, `POST /v1/registrations`, so the first default-branch run registers
 * whether or not it has rows (plan 0008 §8). A refusal is returned as one.
 * @param {Store} store @param {TokenIo} io
 * @returns {Promise<{ status: string } | { refusal: Refusal } | { failure: string }>}
 */
export async function ensureRegistered(store, io) {
  const got = await storeRequest(store, { method: 'GET', path: 'v1/registrations/self' }, io);
  if (got.status === 200 && typeof got.json?.status === 'string') {
    if (got.json.status === 'erased') return { refusal: /** @type {Refusal} */ (refusalOf(410, { error: 'erased' })) };
    if (got.json.status === 'suspended') return { refusal: /** @type {Refusal} */ (refusalOf(403, { error: 'suspended' })) };
    return { status: String(got.json.status) };
  }
  if (got.status === 404 && codeOf(got.json) === 'not-registered') {
    const reg = await storeRequest(store, { method: 'POST', path: 'v1/registrations', body: {} }, io);
    if (reg.status === 200 || reg.status === 201) return { status: 'active' };
    const refusal = refusalOf(reg.status, reg.json, reg.retryAfter);
    return refusal ? { refusal } : { failure: `registering: the store answered ${reg.status}${codeOf(reg.json) ? ` (${codeOf(reg.json)})` : ''}` };
  }
  const refusal = refusalOf(got.status, got.json, got.retryAfter);
  return refusal ? { refusal } : { failure: `reading the registration: the store answered ${got.status}${codeOf(got.json) ? ` (${codeOf(got.json)})` : ''}` };
}

/**
 * The erasure (plan 0008 §7): `DELETE /v1/registrations/self`, then the status, said in two
 * lines. Sends no row.
 * @param {Store} store @param {TokenIo} io
 * @returns {Promise<{ lines: string[], failure?: string, refusal?: Refusal }>}
 */
export async function eraseSelf(store, io) {
  const del = await storeRequest(store, { method: 'DELETE', path: 'v1/registrations/self' }, io);
  if (del.status === 404 && codeOf(del.json) === 'not-registered') return { lines: ["Telemetry erasure: this repository is not registered with the store, so there is nothing to erase."] };
  if (del.status !== 200 && del.status !== 202) {
    const refusal = refusalOf(del.status, del.json, del.retryAfter);
    if (refusal && refusal.red) return { lines: [], refusal };
    return { lines: [], failure: `the erasure was refused: the store answered ${del.status}${codeOf(del.json) ? ` (${codeOf(del.json)})` : ''}` };
  }
  const at = typeof del.json?.erased_at === 'string' ? del.json.erased_at : 'now';
  const done = del.json?.rows_erased === true;
  return {
    lines: [
      `Telemetry erasure: this repository's registration is erased as of ${at}; nothing more is sent or read for it.`,
      done
        ? "Its rows are deleted from the store's table; backups drop them within 35 days (docs/sharing.md, \"Stop and erase\")."
        : "Its rows are being deleted from the store's table, within minutes; dispatch again with erase: yes to see them gone. Backups drop them within 35 days (docs/sharing.md, \"Stop and erase\").",
    ],
  };
}

/** A `yes`/`no` dispatch input; empty, on a schedule, is `no`. Null for anything else. @param {string | undefined} v */
const yesNo = (v) => {
  const t = String(v ?? '').trim().toLowerCase();
  return t === '' || t === 'no' || t === 'false' ? false : t === 'yes' || t === 'true' ? true : null;
};

/** Why a caller with the SigV4 path's `url` and no `audience` is refused, and what to do (Owner decision of 2026-10-14, #842). */
export const LEGACY_REFUSAL = "the caller passes `url` without `audience`, as callers of the SigV4 path did, so nothing is sent and nothing is registered: no token is minted, and the URL is never swapped for another store's. Run `kanon init` again to write the new caller, which passes neither and sends to Kanon's hosted store; or, for a store of your own, add `audience:` beside `url:` (docs/telemetry.md, \"Collect the rows\")";

/**
 * The collect job's inputs, read before any token is minted: the store, the `erase` and `register`
 * dispatch inputs, and what to warn of. A caller written before the token path passes `url` and no
 * `audience`: that is REFUSED HERE, before any token is minted, so nothing is sent and nothing is
 * registered (Owner decision of 2026-10-14, #842). The `url` is never cleared to fall back to the
 * hosted store: a caller that named a store of its own must not start sending to Kanon's. Its
 * `writer-role`, the SigV4 path's other input, is gone since plan 0008 J9: GitHub refuses the call
 * before this step runs.
 * @param {Record<string, string | undefined>} env
 * @returns {{ store: ReturnType<typeof storeOf>, erase: boolean, register: boolean, problems: string[], warnings: string[] }}
 */
export function inputsOf(env) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const audience = String(env.KANON_TELEMETRY_AUDIENCE ?? '');
  const url = String(env.KANON_TELEMETRY_URL ?? '');
  /** @type {ReturnType<typeof storeOf>} */
  let store;
  if (!audience.trim() && url.trim()) {
    // A URL alone, as the SigV4 path's callers passed it: refused, never redirected (#842).
    store = { ok: false, why: LEGACY_REFUSAL };
    problems.push(LEGACY_REFUSAL);
  } else {
    store = storeOf({ url, audience, hostedUrl: HOSTED_INGEST_URL });
    if (!store.ok && !store.unpublished) problems.push(store.why);
  }
  const erase = yesNo(env.ERASE);
  const register = yesNo(env.REGISTER);
  if (erase === null) problems.push('`erase` is neither yes nor no');
  if (register === null) problems.push('`register` is neither yes nor no');
  if (erase && register) problems.push('`erase` and `register` are both yes: dispatch one at a time');
  return { store, erase: erase === true, register: register === true, problems, warnings };
}

/**
 * One sweep. Pure apart from what it is given.
 *
 * `level` reads the adoption record's `Upstream findings` value from the default branch; it is
 * called at most once a sweep, and only when there is a finding artifact to send.
 *
 * `workItems` is the work-item step (plan 0003 M4), given the span's start: its rows are sent
 * beside the run rows, and its failures turn the run red as theirs do. Left out, no work-item row
 * is derived.
 *
 * @param {{
 *   repo: string, now: number, lastSuccess: string | null, window?: string,
 *   api: Api, download: Download, post: Post, log?: (line: string) => void, level?: () => string,
 *   workItems?: WorkItems,
 * }} opts
 * A refusal (`refusalOf`) stops the sending, and is returned as `refusal` rather than a failure:
 * the caller says it with its own title, red or green as it says.
 *
 * @returns {Promise<{ since: number, listed: number, sent: number, stored: number, foreign: number, withheld: number, workItems: number, failures: string[], warnings: string[], refusal?: Refusal | null }>}
 */
export async function collect({ repo, now, lastSuccess, window = '', api, download, post, log = () => {}, level = () => readUpstreamFindingsFrom(repo), workItems }) {
  const overridden = window.trim() !== '';
  const windowMinutes = overridden ? Number(window) : WINDOW_MINUTES;
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const warnings = [];
  if (overridden && !(Number.isInteger(windowMinutes) && windowMinutes > 0)) {
    return { since: now, listed: 0, sent: 0, stored: 0, foreign: 0, withheld: 0, workItems: 0, failures: [`window_minutes is '${window}', not a whole number of minutes`], warnings };
  }

  // One listing back to the furthest the sweep could reach; the span is cut from it below, once
  // the retention it measured is known. The ONLY listing: unreadable means the sweep saw nothing,
  // which must not read as "there was nothing".
  let listing;
  try {
    listing = listTelemetryArtifacts({ repo, from: now - SWEEP_CAP_DAYS * DAY, api, findings: true, deploys: true, deliveries: true, smokes: true });
  } catch (err) {
    failures.push(`could not list artifacts (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
    return { since: now, listed: 0, sent: 0, stored: 0, foreign: 0, withheld: 0, workItems: 0, failures, warnings };
  }
  const { since, capped, capDays } = sweepSince({ lastSuccess, now, windowMinutes, overridden, retentionDays: listing.retentionDays });
  if (capped) {
    warnings.push(overridden
      ? `window_minutes=${windowMinutes} reaches past the ${capDays}-day cap, so the sweep starts there`
      : `the last successful sweep was at ${lastSuccess}, before the ${capDays}-day cap: rows recorded before ${new Date(since).toISOString()} are lost, because their artifacts have expired or the store refuses them (plan 0002 S1a, #212)`);
  }
  const artifacts = listing.artifacts.filter((a) => a.createdAt >= since);
  const spanMin = Math.round((now - since) / MINUTE);
  log(`sweeping ${artifacts.length} telemetry artifact(s) since ${new Date(since).toISOString()} (${spanMin}m; ${overridden ? 'window_minutes override' : lastSuccess ? `since the last successful sweep at ${lastSuccess}` : 'no prior successful sweep, so everything reachable'})`);
  if (listing.foreign) log(`ignored ${listing.foreign} artifact(s) not from this repository's own runs`);
  // A span far past the floor means ticks were dropped: the watermark recovered them.
  if (!overridden && !capped && lastSuccess && spanMin > WINDOW_MINUTES * 2) {
    warnings.push(`swept ${spanMin} minutes, well past the ${WINDOW_MINUTES}-minute floor: scheduled sweeps were dropped or delayed, and this sweep recovered their rows`);
  }

  /** @type {{ row: Record<string, unknown>, where: string }[]} */
  const rows = [];
  // The record's level, read once, and only when a finding artifact is about to be sent. Null
  // when it can't be read: then no finding row is sent.
  /** @type {string | null | undefined} */
  let declared;
  const levelOf = () => {
    if (declared === undefined) {
      try {
        declared = level();
      } catch (err) {
        declared = null;
        failures.push(`no finding row is sent: the adoption record's Upstream findings level can't be read on the default branch (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
      }
    }
    return declared;
  };
  const names = nameContext({ repository: repo });
  let withheld = 0;
  for (const a of artifacts) {
    if (a.kind === 'finding') {
      const where = `${a.lane} findings run ${a.runId} attempt ${a.attempt} (artifact ${a.id})`;
      /** @type {unknown} */
      let list;
      try {
        const file = readZipEntry(download(a.id), FINDING_ARTIFACT_FILE);
        if (!file) throw new Error(`no ${FINDING_ARTIFACT_FILE}`);
        list = JSON.parse(file.toString('utf8'));
      } catch (err) {
        failures.push(`${where}: unreadable (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
        continue;
      }
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_FINDINGS) {
        failures.push(`${where}: not a list of 1 to ${MAX_FINDINGS} finding rows`);
        continue;
      }
      const value = levelOf();
      if (value === null) continue;
      for (const [i, raw] of list.entries()) {
        const at = `${where} row ${i}`;
        const r = /** @type {Record<string, unknown>} */ (raw);
        if (!r || typeof r !== 'object' || r.row_kind !== 'finding' || r.reporter !== a.lane || r.run_id !== a.runId || r.run_attempt !== a.attempt) {
          failures.push(`${at}: the row's row_kind, reporter, run_id or run_attempt is not its artifact's`);
          continue;
        }
        const leaving = underLevel(r, value);
        if (!leaving) { withheld += 1; continue; }
        let out = leaving.row;
        const fired = textFailures(out, names);
        if (fired.length) {
          out = codesOnly(out);
          warnings.push(`${at}: sent at codes, without its text, because the scrub still finds ${fired.map((x) => `${x.field} (${x.rules.join(', ')})`).join(', ')} (plan 0006 §5)`);
        }
        const v = validate(out);
        if (!v.ok) {
          failures.push(`${at}: fails the schema (${describeErrors(v.errors)})`);
          continue;
        }
        rows.push({ row: out, where: at });
      }
      continue;
    }
    if (a.kind === 'deploy' || a.kind === 'smoke_check') {
      const where = `${a.kind} run ${a.runId} attempt ${a.attempt} position ${a.position} (artifact ${a.id})`;
      const fileName = a.kind === 'deploy' ? DEPLOY_ARTIFACT_FILE : SMOKE_ARTIFACT_FILE;
      let row;
      try {
        const file = readZipEntry(download(a.id), fileName);
        if (!file) throw new Error(`no ${fileName}`);
        row = JSON.parse(file.toString('utf8'));
      } catch (err) {
        failures.push(`${where}: unreadable (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
        continue;
      }
      const v = validate(row);
      if (!v.ok) {
        failures.push(`${where}: fails the schema (${describeErrors(v.errors)})`);
        continue;
      }
      if (row.row_kind !== a.kind || row.run_id !== a.runId || row.run_attempt !== a.attempt || row.position !== a.position) {
        failures.push(`${where}: the row's row_kind, run_id, run_attempt or position is not its artifact's`);
        continue;
      }
      rows.push({ row, where });
      continue;
    }
    if (a.kind === 'notify') {
      const where = `${a.lane} notify run ${a.runId} attempt ${a.attempt} (artifact ${a.id})`;
      let row;
      try {
        const file = readZipEntry(download(a.id), DELIVERY_ARTIFACT_FILE);
        if (!file) throw new Error(`no ${DELIVERY_ARTIFACT_FILE}`);
        row = JSON.parse(file.toString('utf8'));
      } catch (err) {
        failures.push(`${where}: unreadable (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
        continue;
      }
      const v = validate(row);
      if (!v.ok) {
        failures.push(`${where}: fails the schema (${describeErrors(v.errors)})`);
        continue;
      }
      if (row.row_kind !== 'notify' || row.lane !== a.lane || row.run_id !== a.runId || row.run_attempt !== a.attempt) {
        failures.push(`${where}: the row's row_kind, lane, run_id or run_attempt is not its artifact's`);
        continue;
      }
      rows.push({ row, where });
      continue;
    }
    const where = `${a.lane} run ${a.runId} attempt ${a.attempt} (artifact ${a.id})`;
    let row;
    try {
      const file = readZipEntry(download(a.id), ARTIFACT_FILE);
      if (!file) throw new Error(`no ${ARTIFACT_FILE}`);
      row = JSON.parse(file.toString('utf8'));
    } catch (err) {
      failures.push(`${where}: unreadable (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
      continue;
    }
    const v = validate(row);
    if (!v.ok) {
      failures.push(`${where}: fails the schema (${describeErrors(v.errors)})`);
      continue;
    }
    if (row.row_kind !== 'run' || row.lane !== a.lane || row.run_id !== a.runId || row.run_attempt !== a.attempt) {
      failures.push(`${where}: the row's row_kind, lane, run_id or run_attempt is not its artifact's`);
      continue;
    }
    rows.push({ row, where });
  }

  // The work-item rows (plan 0003 M4), over the same span.
  let items = 0;
  if (workItems) {
    const step = await workItems(since);
    rows.push(...step.rows);
    failures.push(...step.failures);
    warnings.push(...step.warnings);
    items = step.rows.length;
  }

  let stored = 0;
  /** @type {Refusal | null} */
  let refusal = null;
  for (let i = 0; i < rows.length; i += MAX_ROWS) {
    const batch = rows.slice(i, i + MAX_ROWS);
    let res;
    try {
      res = await post(batch.map((r) => r.row));
    } catch (err) {
      failures.push(`rows ${i + 1}-${i + batch.length}: the request failed (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
      continue;
    }
    const results = Array.isArray(res.json?.results) ? res.json.results : null;
    if (!results || results.length !== batch.length) {
      // A refusal stops the sweep: every later batch would be refused the same (plan 0008 §3.2).
      const stop = refusalOf(res.status, res.json, /** @type {any} */ (res).retryAfter ?? null);
      if (stop) {
        refusal = stop;
        break;
      }
      failures.push(`rows ${i + 1}-${i + batch.length}: the store answered ${res.status}${codeOf(res.json) ? ` (${codeOf(res.json)})` : ''}`);
      continue;
    }
    results.forEach((/** @type {any} */ r, /** @type {number} */ n) => {
      const where = /** @type {{ where: string }} */ (batch[n]).where;
      if (r?.status === 'stored') stored += 1;
      else if (r?.status === 'rejected') failures.push(`${where}: rejected by the store (${(r.errors ?? []).map((/** @type {any} */ e) => `${e.field}: ${e.problem}`).join(', ')})`);
      else failures.push(`${where}: the store failed to write it`);
    });
  }
  if (withheld) log(`withheld ${withheld} finding row(s): the adoption record's Upstream findings level is \`${String(declared)}\`, which sends none`);
  return { since, listed: artifacts.length, sent: rows.length, stored, foreign: listing.foreign, withheld, workItems: items, failures, warnings, refusal };
}

/**
 * The `check` step: the inputs, before any token is minted. Exits 1 on a problem, naming it;
 * says the deprecated inputs and an unpublished hosted URL as warnings.
 * @param {Record<string, string | undefined>} env @param {(line: string) => void} [out]
 * @returns {number} the exit code
 */
export function checkStep(env, out = (line) => console.log(line)) {
  const { store, problems, warnings } = inputsOf(env);
  for (const w of warnings) out(`::warning title=telemetry-collect::${w}`);
  if (problems.length) {
    for (const p of problems) out(`::error title=telemetry-collect::${p}. Nothing was sent, and no token was minted.`);
    return 1;
  }
  if (!store.ok) out(`::warning title=telemetry-collect::${store.why}`);
  else out(`Sending to ${store.hosted ? "Kanon's hosted telemetry store" : 'a self-hosted telemetry store'}, with GitHub's OIDC token for its audience.`);
  return 0;
}

async function main() {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('telemetry-collect: GITHUB_REPOSITORY must be set; the runner sets it, and the collector never guesses a repository');
    process.exit(2);
  }
  /** @param {string} line */
  const summary = (line) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const fail = (/** @type {string} */ why) => {
    console.log(`::error title=telemetry-collect::${why}`);
    process.exit(1);
  };
  /** A refusal, with the title doctor reads, red or green as it says. @param {Refusal} r */
  const refused = (r) => {
    console.log(`::${r.red ? 'error' : 'warning'} title=${REFUSED_TITLE}::${r.words}`);
    summary(`Telemetry collector **${r.code === 'erased' || r.code === 'erasing' ? 'erased' : 'refused'}**: ${r.words}`);
    if (r.red) process.exit(1);
  };
  const { store, erase, register, problems } = inputsOf(env);
  if (problems.length) fail(`${problems.join('; ')}. Nothing was sent, and no token was minted.`);
  if (!store.ok) {
    // Reached only at a release whose hosted URL is unpublished: the collector skips, green, as it
    // did before its variables were set, and that release's workflow names the job
    // `UNPUBLISHED_JOB`, so the run is no sweep. This tree publishes the URL, so `storeOf` never
    // answers `unpublished` here, and `inputsOf` makes any other refusal a problem above.
    summary(`Telemetry collector **skipped**: ${store.why}. This run is not a sweep: the first sweep at a release that publishes it reaches back to the last sweep before, up to ${SWEEP_CAP_DAYS} days.`);
    return;
  }
  const file = workflowFileOf(env.GITHUB_WORKFLOW_REF);
  if (!file) fail('GITHUB_WORKFLOW_REF names no workflow file, so the last successful sweep cannot be found');
  const io = { env };

  try {
    // ERASURE (plan 0008 §7): sends nothing, and says when the rows are gone.
    if (erase) {
      const r = await eraseSelf(store, io);
      if (r.refusal) refused(r.refusal);
      if (r.failure) fail(r.failure);
      for (const l of r.lines) summary(l);
      return;
    }
    // RE-REGISTRATION after an erasure (§3.3): a new key, then the sweep as usual.
    if (register) {
      const reg = await storeRequest(store, { method: 'POST', path: 'v1/registrations', body: { reregister: true } }, io);
      if (reg.status !== 200 && reg.status !== 201) {
        const r = refusalOf(reg.status, reg.json, reg.retryAfter);
        if (r && r.red) refused(r);
        fail(`registering again: the store answered ${reg.status}${codeOf(reg.json) ? ` (${codeOf(reg.json)})` : ''}${codeOf(reg.json) === 'erasing' ? ': the earlier erasure is still deleting rows; dispatch again in a few minutes' : ''}`);
      }
      summary(`Telemetry registration: ${reg.status === 201 ? 'registered again, under a new key' : 'already active'}.`);
    }
  } catch (err) {
    fail(err instanceof TokenError ? err.message : `the store could not be reached (${err instanceof Error ? err.name : 'error'})`);
  }

  const api = ghApi();
  const overridden = (env.WINDOW ?? '').trim() !== '';
  let lastSuccess = null;
  if (!overridden) {
    try {
      lastSuccess = lastSuccessfulSweep({ api, repo, file: /** @type {string} */ (file), branch: env.GITHUB_REF_NAME ?? '', selfRunId: env.GITHUB_RUN_ID ?? '' });
    } catch (err) {
      console.log(`::warning title=telemetry-collect::could not read the last successful sweep, so this one takes everything reachable (${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]})`);
    }
  }
  const now = Date.now();
  const post = tokenPost(store, io);
  const result = await collect({
    repo, now, lastSuccess, window: env.WINDOW ?? '',
    api, download: ghDownload(repo),
    post: async (rows) => {
      try {
        return await post(rows);
      } catch (err) {
        // A token the runner wouldn't mint is said by its reason; anything else by its name only.
        throw new Error(err instanceof TokenError ? err.message : `the store could not be reached (${err instanceof Error ? err.name : 'error'})`);
      }
    },
    log: (line) => console.log(line),
    workItems: (since) => workItemStep({ repo, since, now, gh: ghAsync, log: (line) => console.log(line), callerFile: file }),
  });
  for (const w of result.warnings) console.log(`::warning title=telemetry-collect::${w}`);
  const line = `Telemetry collector: ${result.stored} of ${result.sent} row(s) stored from ${result.listed} artifact(s) and ${result.workItems} work item(s) since ${new Date(result.since).toISOString()}; ${result.withheld ? `${result.withheld} finding row(s) withheld by the adoption record; ` : ''}${result.failures.length} failure(s).`;
  summary(line);
  // The registration's status, from the rows' answer, or asked for when no row was sent: a quiet
  // repository's first run registers too (plan 0008 §8).
  let refusal = result.refusal ?? null;
  if (!refusal && result.sent === 0) {
    try {
      const r = await ensureRegistered(store, io);
      if ('refusal' in r) refusal = r.refusal;
      else if ('failure' in r) result.failures.push(r.failure);
      else summary(`Telemetry registration: ${r.status}.`);
    } catch (err) {
      result.failures.push(err instanceof TokenError ? err.message : `reading the registration: the store could not be reached (${err instanceof Error ? err.name : 'error'})`);
    }
  } else if (!refusal && result.stored > 0) summary('Telemetry registration: active.');
  // A red run is the page (§9): the next sweep re-covers the same span through the watermark, so
  // failing loses no row.
  for (const f of result.failures) console.log(`::error title=telemetry-collect::${f}`);
  if (refusal) refused(refusal);
  if (result.failures.length) process.exit(1);
}

if (isCliEntry(import.meta.url)) {
  if (process.argv[2] === 'check') process.exitCode = checkStep(process.env);
  else await main();
}
