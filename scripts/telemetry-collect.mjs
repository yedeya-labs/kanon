#!/usr/bin/env node
// The telemetry collector (plan 0002 S7): sweeps this repository's version-2 run rows from
// their artifacts and sends each to the hosted store's ingest function, as its one writer.
//
// MOVED, NOT REWRITTEN (ADR 0009). This is the reference adopter's hourly collector, with the
// parts S7 changes and nothing else:
//   - it sends only version 2, the `kanon-telemetry-*` artifacts, to the function, 25 rows to a
//     signed `POST` (§4), where it used to push the version-1 row to the adopter's own table and
//     bucket; there is one store and one step (ADR 0009 §2: no second live copy);
//   - its credentials are the adopter's writer role, which can invoke the function and nothing
//     else (§3), not the adopter's QA role;
//   - a row is checked with `validate` before it is sent, so a bad row fails the collector with
//     the field's NAME (§2.5), and a row whose lane, run or attempt isn't its artifact's is
//     refused, because the artifact listing is the only thing vouching for it;
//   - only this repository's own runs count (`listTelemetryArtifacts`): a fork's run can upload
//     any row under any name, and this job holds the writer.
// What is kept as it was: the watermark, the floor and the override, the one paginated artifact
// scan, the download by id, and the red run as the page. One thing changed since (kanon#315): an
// override's run is no longer a watermark, so a short override can't hide the rows before it.
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
// LOGS HOLD COUNTS, IDS, LANES AND FIELD NAMES, NEVER A ROW'S VALUE (ADR 0007).
//
// `mask` FIRST (kanon#514). The writer role's ARN is a repository variable, which the runner
// never masks, and an AWS error names its account in other ARNs besides. So the job's step before
// the credentials runs this script as `mask`, with the ARN as ROLE, to register the ARN and its
// account id with `::add-mask::`, as the telemetry Explorer's read job does (`aggregate-mask.mjs`).

import { appendFileSync } from 'node:fs';

import { describeErrors, MAX_FINDINGS, SCHEMAS, validate } from '../actions/agent-telemetry/schema.mjs';
import { nameContext, verify } from '../actions/agent-telemetry/scrub.mjs';
import { sign } from '../infra/telemetry/function/sigv4.mjs';
import { masksOf } from './aggregate-mask.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { ARTIFACT_FILE, FINDING_ARTIFACT_FILE, ghApi, ghDownload, listTelemetryArtifacts, readZipEntry } from './lib/telemetry-artifacts.mjs';
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
 * @typedef {{ status: number, json: any }} PostResult
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
 * `COLLECT_JOB_OVERRIDE`, which matches neither form below (kanon#315).
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

/** The function URL's region: `https://<id>.lambda-url.<region>.on.aws/`. */
export function regionOf(/** @type {string} */ url) {
  try {
    return /\.lambda-url\.([a-z0-9-]+)\.on\.aws$/.exec(new URL(url).host)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The default `put(rows)`: one signed `POST` to the function URL with the writer role's
 * credentials, which `configure-aws-credentials` put in the environment.
 * @param {string} url
 * @param {string} region
 * @param {NodeJS.ProcessEnv} env
 * @returns {Post}
 */
export const signedPost = (url, region, env) => async (rows) => {
  const body = JSON.stringify(rows);
  const headers = { 'content-type': 'application/json' };
  const credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '', sessionToken: env.AWS_SESSION_TOKEN };
  const res = await fetch(url, { method: 'POST', headers: { ...headers, ...sign({ method: 'POST', url, headers, body, region, service: 'lambda', credentials }) }, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An answer that isn't JSON is judged by its status alone; its body is never printed.
  }
  return { status: res.status, json };
};

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
 * @returns {Promise<{ since: number, listed: number, sent: number, stored: number, foreign: number, withheld: number, workItems: number, failures: string[], warnings: string[] }>}
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
    listing = listTelemetryArtifacts({ repo, from: now - SWEEP_CAP_DAYS * DAY, api, findings: true });
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
      failures.push(`rows ${i + 1}-${i + batch.length}: the store answered ${res.status}${res.json?.error ? ` (${String(res.json.error)})` : ''}`);
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
  return { since, listed: artifacts.length, sent: rows.length, stored, foreign: listing.foreign, withheld, workItems: items, failures, warnings };
}

async function main() {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('telemetry-collect: GITHUB_REPOSITORY must be set; the runner sets it, and the collector never guesses a repository');
    process.exit(2);
  }
  const url = env.KANON_TELEMETRY_URL ?? '';
  const file = workflowFileOf(env.GITHUB_WORKFLOW_REF);
  const region = regionOf(url);
  const fail = (/** @type {string} */ why) => {
    console.log(`::error title=telemetry-collect::${why}`);
    process.exit(1);
  };
  if (!file) fail('GITHUB_WORKFLOW_REF names no workflow file, so the last successful sweep cannot be found');
  if (!region) fail("KANON_TELEMETRY_URL is not a Lambda function URL (https://<id>.lambda-url.<region>.on.aws/): set it to the store's IngestUrl output");

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
  const result = await collect({
    repo, now, lastSuccess, window: env.WINDOW ?? '',
    api, download: ghDownload(repo), post: signedPost(url, /** @type {string} */ (region), env),
    log: (line) => console.log(line),
    workItems: (since) => workItemStep({ repo, since, now, gh: ghAsync, log: (line) => console.log(line), callerFile: file }),
  });
  for (const w of result.warnings) console.log(`::warning title=telemetry-collect::${w}`);
  const line = `Telemetry collector: ${result.stored} of ${result.sent} row(s) stored from ${result.listed} artifact(s) and ${result.workItems} work item(s) since ${new Date(result.since).toISOString()}; ${result.withheld ? `${result.withheld} finding row(s) withheld by the adoption record; ` : ''}${result.failures.length} failure(s).`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  // A red run is the page (§9): the next sweep re-covers the same span through the watermark, so
  // failing loses no row.
  if (result.failures.length) {
    for (const f of result.failures) console.log(`::error title=telemetry-collect::${f}`);
    process.exit(1);
  }
}

if (isCliEntry(import.meta.url)) {
  if (process.argv[2] === 'mask') {
    for (const m of masksOf({ ROLE: process.env.ROLE })) process.stdout.write(`::add-mask::${m}\n`);
  } else await main();
}
