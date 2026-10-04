// A lane's version-2 telemetry rows, read from its run artifacts (plan 0004 step P7, §3.3; kanon#201).
//
// WHY ARTIFACTS. The dispatch sweep reads 14 days of the `implement` and `triage` lanes' cost rows
// to see which dispatches never reached the model, and which issue's latest run hit its cap. It
// read them from the adopter's QA store (`readCostRows` in `dispatch-sweep.mjs`), which is the
// only reason its caller holds cloud credentials. Both lanes are Kanon lanes, and every run of
// either uploads its version-2 row as an artifact, `kanon-telemetry-<lane>-<run id>-<attempt>`
// (plan 0002, S1), asking for 90 days (S1a). The row carries every field the sweep reads. So this
// is plan 0002's `query(lane, from, to)`, answered from artifacts instead of a store: when that
// store exists, the reader can switch to it without the sweep changing.
//
// THE SAME SHAPE AS THE STORE READ. `readArtifactCostRows` returns what `readCostRows` returns,
// `{ rows: [{ ts, issue_number, outcome, run_id }], error }`, with `ts` in the store's basic-ISO
// sort-key form (`20260904T120245Z`) and the other three as the strings the store query yields.
// The store's key is stamped from the same `recorded_at` the version-2 row carries, so a run read
// both ways gives the same `ts`.
//
// A ROW THAT FAILS `validate` IS SKIPPED AND COUNTED, NEVER READ AS "NO RUN" (P7's mutation). A
// skipped artifact is a run that happened and can't be read, and the sweep must not treat it as
// one that didn't: a missing `unavailable` row charges an attempt, which is safe, but a missing
// latest row can make an older `exhausted` one look like the issue's last, and stop it as too
// big. So any skipped artifact fails the lane's read CLOSED: `rows` is empty and `error` says how
// many of how many were skipped, and why, by field name only (ADR 0007: a rejected row is never
// echoed). That is exactly what an unreadable store does today, and the sweep already reports it.
// The rows a lane's action uploads have already passed `validate`, so a skip is a version skew or
// a damaged artifact, and it should be loud.
//
// RETENTION IS THE REPOSITORY'S, NOT THE ROW'S. The upload asks for 90 days, but a repository (or
// its organisation) can keep artifacts for less, and GitHub then caps the artifact. An artifact
// past its retention is gone, not skipped: the read can't see a run older than that. Losing the
// oldest rows is the safe direction for both uses (an older `unavailable` row only discounts an
// attempt, and the latest visible row is still the latest), but it is not the window the sweep
// asked for, so the result carries the retention it measured and `artifactRetentionNote` says
// when it is shorter than the window (`K-PRIN-8`).

import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

import { describeErrors, validate } from '../../actions/agent-telemetry/schema.mjs';

/** Every version-2 artifact's name starts with this (`actions/agent-telemetry/action.yml`). */
export const ARTIFACT_PREFIX = 'kanon-telemetry-';
/** The file inside the artifact. */
export const ARTIFACT_FILE = 'kanon-telemetry.json';
/** The sweep's window, in days, as `dispatch-sweep.mjs`'s `UNREACHED_WINDOW_DAYS` defaults it. */
export const WINDOW_DAYS = 14;
/** Pages of 100 the listing may read before it gives up and fails the read. */
export const MAX_PAGES = 50;

const DAY = 86_400_000;
/** Artifact ids, which the listing is ordered by, can trail `created_at` by minutes. */
const LISTING_SLACK = 3_600_000;

/**
 * A `COST#` sort key, `20260904T120245Z`, from epoch-ms. The same stamp `dispatch-sweep.mjs`'s
 * `costStamp` and the store's collector build; repeated here so that reading this module doesn't
 * load the sweep, which reads the adopter's files when it is imported.
 * @param {number} ms
 */
export function costStamp(ms) {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * The exact name pattern of one lane's artifacts. Anchored and numeric on both ids, so the
 * `implement` lane never matches `kanon-telemetry-implement-revise-…`.
 * @param {string} lane
 */
export function laneArtifactPattern(lane) {
  const escaped = lane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${ARTIFACT_PREFIX}${escaped}-(\\d+)-(\\d+)$`);
}

// ----------------------------------------------------------------------------- zip

/**
 * One file's bytes from a zip, by name, or null when the zip has no such file. Reads the central
 * directory, because `actions/upload-artifact` writes its entries with a data descriptor, so the
 * local header's sizes are zero. Stored and deflated entries only; anything else throws.
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer | null}
 */
export function readZipEntry(buf, name) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const entries = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const next = at + 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === name) {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (size === 0xffffffff || start + size > buf.length) throw new Error('bad entry size');
      const data = buf.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error('unsupported compression');
    }
    at = next;
  }
  return null;
}

// ------------------------------------------------------------------------- GitHub

/**
 * @typedef {(path: string) => any} Api           a `gh api` GET of one path, parsed
 * @typedef {(id: number) => Buffer} Download     one artifact's zip, by id
 * @typedef {{ id: number, name: string, runId: number, attempt: number, createdAt: number, expiresAt: number }} LaneArtifact
 */

/** @param {unknown} err */
const causeOf = (err) => {
  const e = /** @type {{ stderr?: unknown, message?: unknown }} */ (err ?? {});
  const text = String(e.stderr || e.message || '').trim().split('\n')[0] ?? '';
  return text.slice(0, 200) || 'no detail';
};

/**
 * The default `gh api` reader, for the repository the sweep runs in.
 * @returns {Api}
 */
export const ghApi = () => (path) =>
  JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

/**
 * The default artifact download: the zip's bytes, by id (plan 0002 §7: download each by id).
 * @param {string} repo
 * @returns {Download}
 */
export const ghDownload = (repo) => (id) =>
  execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${id}/zip`], { maxBuffer: 32 * 1024 * 1024 });

/**
 * One lane's unexpired artifacts created since `from`, from the repository's artifact list, which
 * is newest first. Stops at the first page whose newest artifact is older than the window (less
 * an hour's slack for ids that trail their timestamps), or at a short page.
 *
 * Also measures the repository's retention: the shortest `expires_at - created_at` of any
 * version-2 artifact listed, in whole days, or null when none was.
 *
 * @param {string} lane
 * @param {{ repo: string, from: number, api: Api, maxPages?: number }} opts
 * @returns {{ artifacts: LaneArtifact[], retentionDays: number | null }}
 */
export function listLaneArtifacts(lane, { repo, from, api, maxPages = MAX_PAGES }) {
  const pattern = laneArtifactPattern(lane);
  /** @type {LaneArtifact[]} */
  const artifacts = [];
  const seen = new Set();
  let retention = Infinity;
  for (let page = 1; ; page += 1) {
    if (page > maxPages) throw new Error(`the artifact listing passed ${maxPages} pages before reaching the window's start`);
    const res = api(`repos/${repo}/actions/artifacts?per_page=100&page=${page}`);
    const list = Array.isArray(res?.artifacts) ? res.artifacts : [];
    let newest = -Infinity;
    for (const a of list) {
      const createdAt = Date.parse(a?.created_at);
      const expiresAt = Date.parse(a?.expires_at);
      if (Number.isFinite(createdAt)) newest = Math.max(newest, createdAt);
      const name = String(a?.name ?? '');
      if (!name.startsWith(ARTIFACT_PREFIX) || !Number.isFinite(createdAt)) continue;
      if (Number.isFinite(expiresAt)) retention = Math.min(retention, expiresAt - createdAt);
      const m = pattern.exec(name);
      if (!m || a.expired || createdAt < from || seen.has(a.id)) continue;
      seen.add(a.id);
      artifacts.push({ id: a.id, name, runId: Number(m[1]), attempt: Number(m[2]), createdAt, expiresAt });
    }
    if (list.length < 100 || newest < from - LISTING_SLACK) break;
  }
  return { artifacts, retentionDays: Number.isFinite(retention) ? Math.round(retention / DAY) : null };
}

// ------------------------------------------------------------------------- the read

/**
 * @typedef {{ invalid: number, unreadable: number, mismatched: number }} Skipped
 * @typedef {{
 *   rows: Record<string, any>[], listed: number, skipped: Skipped, otherTags: number,
 *   invalidFields: string[], retentionDays: number | null,
 * }} RunRows
 */

/**
 * Plan 0002's `query(lane, from, to)`, from run artifacts: every `tag: run` version-2 row of the
 * lane whose `recorded_at` stamp is after `from` (strictly, like the store query's `sk > :s`) and
 * not after `to`. Each artifact is downloaded by id, its row checked with `validate`, and then
 * against its own name: a row whose `lane`, `run_id` or `run_attempt` isn't the artifact's is
 * mismatched. A `smoke` or `test` row is left out, as every read of the store leaves it out.
 *
 * Pure apart from `api` and `download`, which the caller injects. Throws only when the listing
 * itself fails; a bad artifact is counted in `skipped`, never dropped.
 *
 * @param {string} lane
 * @param {number} from  epoch-ms
 * @param {number} to    epoch-ms
 * @param {{ repo: string, api: Api, download: Download, maxPages?: number }} deps
 * @returns {RunRows}
 */
export function queryRunRows(lane, from, to, { repo, api, download, maxPages }) {
  const { artifacts, retentionDays } = listLaneArtifacts(lane, { repo, from, api, maxPages });
  const after = costStamp(from);
  const until = Number.isFinite(to) ? costStamp(to) : null;
  /** @type {Record<string, any>[]} */
  const rows = [];
  /** @type {Skipped} */
  const skipped = { invalid: 0, unreadable: 0, mismatched: 0 };
  const fields = new Set();
  let otherTags = 0;
  for (const a of artifacts) {
    let row;
    try {
      const file = readZipEntry(download(a.id), ARTIFACT_FILE);
      if (!file) throw new Error('no row file');
      row = JSON.parse(file.toString('utf8'));
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    const v = validate(row);
    if (!v.ok) {
      skipped.invalid += 1;
      for (const f of describeErrors(v.errors).split(', ')) fields.add(f);
      continue;
    }
    if (row.row_kind !== 'run' || row.lane !== lane || row.run_id !== a.runId || row.run_attempt !== a.attempt) {
      skipped.mismatched += 1;
      continue;
    }
    if (row.tag !== 'run') { otherTags += 1; continue; }
    const stamp = costStamp(Date.parse(row.recorded_at));
    if (stamp <= after || (until !== null && stamp > until)) continue;
    rows.push(row);
  }
  return { rows, listed: artifacts.length, skipped, otherTags, invalidFields: [...fields].sort(), retentionDays };
}

/**
 * One version-2 row as the store query returns it (`readCostRows`).
 * @param {Record<string, any>} row
 * @returns {{ ts: string, issue_number: string | null, outcome: string, run_id: string }}
 */
export function toCostRow(row) {
  return {
    ts: costStamp(Date.parse(row.recorded_at)),
    issue_number: row.issue_number == null ? null : String(row.issue_number),
    outcome: row.outcome,
    run_id: String(row.run_id),
  };
}

/** @param {Skipped} s */
const skippedTotal = (s) => s.invalid + s.unreadable + s.mismatched;

/**
 * @typedef {{
 *   rows: { ts: string, issue_number: string | null, outcome: string, run_id: string }[],
 *   error: string | null, listed: number, skipped: Skipped, retentionDays: number | null, days: number,
 * }} CostRead
 */

/**
 * A sweep lane's cost rows from its artifacts, in `readCostRows`'s shape (`{ rows, error }`), plus
 * what was listed and skipped and the retention measured. FAILS CLOSED, as the store read does:
 * `rows` is empty whenever `error` is set, which charges every dispatch, and the sweep's
 * `costReadLine` already says so.
 *
 * @param {{ key: string }} lane  a `dispatch-sweep.mjs` lane; its `key` is its telemetry lane
 * @param {number} [now]
 * @param {{ repo?: string, api?: Api, download?: Download, days?: number, maxPages?: number }} [deps]
 * @returns {CostRead}
 */
export function readArtifactCostRows(lane, now = Date.now(), deps = {}) {
  const days = deps.days ?? WINDOW_DAYS;
  const empty = { invalid: 0, unreadable: 0, mismatched: 0 };
  const repo = deps.repo ?? process.env.GITHUB_REPOSITORY ?? '';
  if (!repo) return { rows: [], error: 'GITHUB_REPOSITORY is unset', listed: 0, skipped: empty, retentionDays: null, days };
  const api = deps.api ?? ghApi();
  const download = deps.download ?? ghDownload(repo);
  let read;
  try {
    read = queryRunRows(lane.key, now - days * DAY, Infinity, { repo, api, download, maxPages: deps.maxPages });
  } catch (err) {
    return { rows: [], error: `the artifact listing failed (${causeOf(err)})`, listed: 0, skipped: empty, retentionDays: null, days };
  }
  const { listed, skipped, retentionDays } = read;
  const bad = skippedTotal(skipped);
  if (bad) {
    const kinds = /** @type {const} */ (['invalid', 'unreadable', 'mismatched'])
      .filter((k) => skipped[k]).map((k) => `${skipped[k]} ${k}`).join(', ');
    const fields = read.invalidFields.length ? `; failed fields: ${read.invalidFields.join(', ')}` : '';
    return {
      rows: [],
      error: `${bad} of ${listed} \`${ARTIFACT_PREFIX}${lane.key}\` artifacts skipped (${kinds}${fields})`,
      listed, skipped, retentionDays, days,
    };
  }
  return { rows: read.rows.map(toCostRow), error: null, listed, skipped, retentionDays, days };
}

/**
 * The sentence a summary carries when the repository keeps artifacts for less than the window,
 * or '' when it doesn't (or when no artifact said). The rows older than that are gone, not
 * skipped, which is the safe direction for the sweep but not the window it asked for.
 * @param {{ retentionDays: number | null, days: number }} read
 */
export function artifactRetentionNote({ retentionDays, days }) {
  if (retentionDays === null || retentionDays >= days) return '';
  return `The repository keeps artifacts ${retentionDays} days, so the artifact read covers ${retentionDays} of the ${days}-day window.`;
}
