import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LANES as SCHEMA_LANES, validate } from '../../actions/agent-telemetry/schema.mjs';
import { LANES, costReadLine, costStamp as sweepCostStamp, exhaustedAtByIssue } from '../../scripts/dispatch-sweep.mjs';
import {
  ARTIFACT_FILE,
  artifactRetentionNote,
  costStamp,
  laneArtifactPattern,
  readArtifactCostRows,
  readZipEntry,
  toCostRow,
} from '../../scripts/lib/telemetry-artifacts.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * Plan 0004 step P7 (kanon#201): the dispatch sweep's cost rows, read from the `implement` and
 * `triage` lanes' version-2 telemetry artifacts instead of the store. The reader must return
 * what the store read returns, and an artifact it can't use must be counted and fail the lane's
 * read closed, never be read as a run that didn't happen.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-04T05:00:00Z');
const REPO = 'example/adopter';

// ------------------------------------------------------------------ fixtures

/** A zip as `actions/upload-artifact` writes it: deflated, with a data descriptor, so the local
 *  header's sizes are zero and only the central directory has them. */
function zipOf(name: string, content: string, { stored = false } = {}): Buffer {
  const raw = Buffer.from(content, 'utf8');
  const data = stored ? raw : deflateRawSync(raw);
  const method = stored ? 0 : 8;
  const fname = Buffer.from(name, 'utf8');
  const crc = crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0008, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(fname.length, 26);
  const desc = Buffer.alloc(16);
  desc.writeUInt32LE(0x08074b50, 0);
  desc.writeUInt32LE(crc, 4);
  desc.writeUInt32LE(data.length, 8);
  desc.writeUInt32LE(raw.length, 12);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0008, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(fname.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + fname.length + data.length + desc.length;
  const cd = Buffer.concat([central, fname]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, fname, data, desc, cd, eocd]);
}

const ROLE: Record<string, string> = { implement: 'implementer', triage: 'implementer', 'implement-revise': 'implementer', review: 'reviewer' };

/** A version-2 run row that passes `validate`. */
function row(lane: string, runId: number, at: string, over: Record<string, unknown> = {}) {
  const outcome = (over.outcome as string) ?? 'ok';
  const reason = { ok: 'none', unavailable: 'model_never_ran', exhausted: 'turn_cap' }[outcome] ?? 'none';
  return {
    schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: at, run_id: runId, run_attempt: 1,
    role: ROLE[lane], lane, outcome, reason, kanon_version: '0.20.0', ...over,
  };
}

type Run = { id: number; repository_id: number; head_repository_id: number } | undefined;
type Fake = { id: number; name: string; created_at: string; expires_at: string; expired?: boolean; workflow_run: Run; zip: Buffer | (() => Buffer) };
const OWN = 1001;
const FORK = 2002;

/** An artifact holding `r`, named for its lane, run and attempt, created a few seconds after it. */
function artifact(id: number, r: Record<string, unknown>, opts: Partial<Fake> = {}): Fake {
  const created = new Date(Date.parse(String(r.recorded_at)) + 5_000);
  return {
    id,
    name: `kanon-telemetry-${r.lane}-${r.run_id}-${r.run_attempt}`,
    created_at: created.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expires_at: new Date(created.getTime() + 90 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    zip: zipOf(ARTIFACT_FILE, JSON.stringify(r)),
    ...opts,
    workflow_run: 'workflow_run' in opts ? opts.workflow_run
      : { id: Number(/-(\d+)-\d+$/.exec(opts.name ?? `-${r.run_id}-1`)?.[1]), repository_id: OWN, head_repository_id: OWN },
  };
}

/** A repository's artifact list, newest first, 100 to a page, and its downloads by id. */
function github(artifacts: Fake[]) {
  const sorted = [...artifacts].sort((a, b) => b.id - a.id);
  const pages: string[] = [];
  const downloads: number[] = [];
  return {
    pages,
    downloads,
    api: (path: string) => {
      pages.push(path);
      const m = /^repos\/example\/adopter\/actions\/artifacts\?per_page=100&page=(\d+)$/.exec(path);
      if (!m) throw new Error(`unexpected path ${path}`);
      const page = Number(m[1]);
      return {
        total_count: sorted.length,
        artifacts: sorted.slice((page - 1) * 100, page * 100).map((a) => ({
          expired: false, id: a.id, name: a.name, created_at: a.created_at, expires_at: a.expires_at,
          ...(a.expired === undefined ? {} : { expired: a.expired }),
          ...(a.workflow_run === undefined ? {} : { workflow_run: a.workflow_run }),
        })),
      };
    },
    download: (id: number) => {
      downloads.push(id);
      const a = sorted.find((x) => x.id === id);
      if (!a) throw new Error('404');
      return typeof a.zip === 'function' ? a.zip() : a.zip;
    },
  };
}

const implement = { key: 'implement' };
const triage = { key: 'triage' };
const read = (lane: { key: string }, gh: ReturnType<typeof github>, extra = {}) =>
  readArtifactCostRows(lane, NOW, { repo: REPO, api: gh.api, download: gh.download, ...extra });

// ------------------------------------------------------------------ tests

describe('readZipEntry', () => {
  it('reads a real `actions/upload-artifact` zip, whose row validates', () => {
    const zip = readFileSync(join(ROOT, 'tests/fixtures/telemetry-artifacts/review-smoke.zip'));
    const file = readZipEntry(zip, ARTIFACT_FILE);
    expect(file).not.toBeNull();
    const r = JSON.parse(String(file));
    expect(validate(r)).toEqual({ ok: true });
    expect([r.lane, r.tag, r.run_id]).toEqual(['review', 'smoke', 37187067926]);
  });

  it('reads stored and deflated entries, returns null for a missing file, and throws on a non-zip', () => {
    expect(String(readZipEntry(zipOf('a.json', '{"x":1}', { stored: true }), 'a.json'))).toBe('{"x":1}');
    expect(String(readZipEntry(zipOf('a.json', '{"x":2}'), 'a.json'))).toBe('{"x":2}');
    expect(readZipEntry(zipOf('a.json', '{}'), ARTIFACT_FILE)).toBeNull();
    expect(() => readZipEntry(Buffer.from('not a zip at all, but long enough'), ARTIFACT_FILE)).toThrow(/not a zip/);
    expect(() => readZipEntry(zipOf(ARTIFACT_FILE, ' '.repeat(2 * 1024 * 1024)), ARTIFACT_FILE), 'a row inflates to at most 1 MiB').toThrow();
  });
});

describe('which artifacts are a lane\'s', () => {
  it('the implement lane never matches implement-revise', () => {
    const p = laneArtifactPattern('implement');
    expect(p.test('kanon-telemetry-implement-37122391333-1')).toBe(true);
    expect(p.test('kanon-telemetry-implement-revise-37122391333-1')).toBe(false);
    expect(p.test('agent-telemetry-implementer-37122391333-1')).toBe(false);
    expect(p.test('kanon-telemetry-implement-37122391333-1-copy')).toBe(false);
  });

  it("every sweep lane's key is a Kanon telemetry lane, so the reader looks under the right name", () => {
    for (const lane of LANES) expect(SCHEMA_LANES, lane.key).toContain(lane.key);
  });
});

describe('readArtifactCostRows — the store read\'s shape, from artifacts', () => {
  it('returns each in-window `run` row of the lane as the store query does', () => {
    const r1 = row('implement', 37000000001, '2026-10-01T12:02:45.050Z', { outcome: 'unavailable', issue_number: 42 });
    const r2 = row('implement', 37000000002, '2026-10-03T08:00:00.000Z', { outcome: 'exhausted', issue_number: 43 });
    const gh = github([
      artifact(10, r1),
      artifact(11, r2),
      artifact(12, row('implement-revise', 37000000003, '2026-10-03T09:00:00.000Z')),
      artifact(13, row('triage', 37000000004, '2026-10-03T10:00:00.000Z')),
      artifact(14, row('implement', 37000000005, '2026-10-03T11:00:00.000Z', { tag: 'smoke' })),
      artifact(15, row('implement', 37000000006, '2026-10-02T11:00:00.000Z'), { expired: true }),
      artifact(16, row('implement', 37000000007, '2026-09-19T11:00:00.000Z')),
    ]);
    const res = read(implement, gh);
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([
      { ts: '20261003T080000Z', issue_number: '43', outcome: 'exhausted', run_id: '37000000002' },
      { ts: '20261001T120245Z', issue_number: '42', outcome: 'unavailable', run_id: '37000000001' },
    ]);
    expect(gh.downloads.sort(), 'only the lane\'s unexpired in-window artifacts are downloaded').toEqual([10, 11, 14]);
    expect(res.listed).toBe(3);
    expect(costReadLine(new Map([['implement', res]]))).toBe('Cost rows read (RA-1517): 2 `implement`.');
  });

  it('reads the triage lane under its own name', () => {
    const gh = github([
      artifact(20, row('triage', 37000000010, '2026-10-02T00:00:00.000Z', { issue_number: 7, outcome: 'unavailable' })),
      artifact(21, row('implement', 37000000011, '2026-10-02T00:00:00.000Z', { issue_number: 7 })),
    ]);
    expect(read(triage, gh).rows).toEqual([{ ts: '20261002T000000Z', issue_number: '7', outcome: 'unavailable', run_id: '37000000010' }]);
  });

  it('a row is the store row for the same run, so the sweep derives the same verdicts from either', () => {
    const r = row('implement', 37000000020, '2026-09-04T12:02:45.050Z', { outcome: 'exhausted', issue_number: 9 });
    // What `readCostRows` builds from the store item the collector wrote for this run.
    const storeRow = { ts: sweepCostStamp(Date.parse(r.recorded_at)), issue_number: '9', outcome: 'exhausted', run_id: '37000000020' };
    expect(toCostRow(r)).toEqual(storeRow);
    expect(costStamp(Date.parse(r.recorded_at))).toBe('20260904T120245Z');
    expect(exhaustedAtByIssue([toCostRow(r)], [9])).toEqual(exhaustedAtByIssue([storeRow], [9]));
  });

  it('keeps the window strict at its start, like the store query\'s `sk > :s`', () => {
    const start = new Date(NOW - 14 * DAY).toISOString();
    const gh = github([
      artifact(30, row('implement', 37000000030, start)),
      artifact(31, row('implement', 37000000031, new Date(NOW - 14 * DAY + 1000).toISOString())),
    ]);
    expect(read(implement, gh).rows.map((r) => r.run_id)).toEqual(['37000000031']);
  });

  it('pages until a page is older than the window, and no further', () => {
    const old = Array.from({ length: 250 }, (_, i) => artifact(100 + i, row('review', 36000000000 + i, '2026-09-01T00:00:00.000Z')));
    const fresh = Array.from({ length: 120 }, (_, i) => artifact(1000 + i, row('implement', 37000001000 + i, '2026-10-02T00:00:00.000Z')));
    const gh = github([...old, ...fresh]);
    const res = read(implement, gh);
    expect(res.rows).toHaveLength(120);
    expect(gh.pages, 'page 2 straddles the window, page 3 is full but wholly older, and ends it').toHaveLength(3);
  });

  it('fails the read, by name, when the listing never reaches the window\'s start', () => {
    const many = Array.from({ length: 250 }, (_, i) => artifact(5000 + i, row('review', 37000005000 + i, '2026-10-03T00:00:00.000Z')));
    const res = read(implement, github(many), { maxPages: 2 });
    expect(res).toMatchObject({ rows: [], error: 'the artifact listing failed (the artifact listing passed 2 pages before reaching the window\'s start)' });
  });

  it('a failed listing fails the lane closed and says why', () => {
    const res = readArtifactCostRows(implement, NOW, { repo: REPO, api: () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 403: Resource not accessible by integration\n' }); }, download: () => Buffer.alloc(0) });
    expect(res).toMatchObject({ rows: [], error: 'the artifact listing failed (HTTP 403: Resource not accessible by integration)' });
    expect(costReadLine(new Map([['implement', res]]))).toMatch(/^\*\*Cost rows NOT read: the artifact listing failed/);
  });

  it('without a repository it reads nothing and says so', () => {
    expect(readArtifactCostRows(implement, NOW, { repo: '', api: () => ({}), download: () => Buffer.alloc(0) }).error)
      .toBe('GITHUB_REPOSITORY is unset');
  });
});

describe('a skipped artifact is counted, never read as "no run" (P7\'s mutation)', () => {
  const good = row('implement', 37000000040, '2026-10-01T00:00:00.000Z', { outcome: 'exhausted', issue_number: 5 });
  // A later run of the same issue whose row fails `validate`. Dropped silently, it would leave
  // the older `exhausted` row as the issue's latest, and the sweep would stop the issue as too big.
  const SECRET = 'a free-text reason quoting code';
  const bad = { ...row('implement', 37000000041, '2026-10-02T00:00:00.000Z', { issue_number: 5 }), reason: SECRET };

  it('an invalid row fails the lane closed, counts it, and names its fields but never its values', () => {
    const res = read(implement, github([artifact(40, good), artifact(41, bad)]));
    expect(res.rows).toEqual([]);
    expect(res.skipped).toEqual({ invalid: 1, unreadable: 0, mismatched: 0 });
    expect(res.error).toBe('1 of 2 `kanon-telemetry-implement` artifacts skipped (1 invalid; failed fields: reason (enum))');
    expect(res.error).not.toContain(SECRET);
    expect(exhaustedAtByIssue(res.rows, [5]).size, 'no stale exhaustion survives').toBe(0);
    expect(costReadLine(new Map([['implement', res], ['triage', read(triage, github([]))]])))
      .toBe('**Cost rows NOT read for `implement`: 1 of 2 `kanon-telemetry-implement` artifacts skipped (1 invalid; failed fields: reason (enum)); every dispatch charged and no run-cap exhaustion seen.** Read: 0 `triage`.');
  });

  it('an artifact that can\'t be downloaded or unzipped, or holds no row, is counted as unreadable', () => {
    const res = read(implement, github([
      artifact(50, good),
      artifact(51, good, { name: 'kanon-telemetry-implement-37000000051-1', zip: () => { throw new Error('HTTP 410'); } }),
      artifact(52, good, { name: 'kanon-telemetry-implement-37000000052-1', zip: Buffer.from('garbage that is not a zip file') }),
      artifact(53, good, { name: 'kanon-telemetry-implement-37000000053-1', zip: zipOf('other.json', '{}') }),
      artifact(54, good, { name: 'kanon-telemetry-implement-37000000054-1', zip: zipOf(ARTIFACT_FILE, '{not json') }),
    ]));
    expect(res).toMatchObject({ rows: [], skipped: { invalid: 0, unreadable: 4, mismatched: 0 } });
    expect(res.error).toBe('4 of 5 `kanon-telemetry-implement` artifacts skipped (4 unreadable)');
  });

  it('a valid row that isn\'t the run its artifact is named for is counted as mismatched', () => {
    const res = read(implement, github([
      artifact(60, good, { name: 'kanon-telemetry-implement-37000000099-1' }),
      artifact(61, row('triage', 37000000061, '2026-10-01T00:00:00.000Z'), { name: 'kanon-telemetry-implement-37000000061-1' }),
      artifact(62, row('implement', 37000000062, '2026-10-01T00:00:00.000Z', { run_attempt: 2 }), { name: 'kanon-telemetry-implement-37000000062-1' }),
    ]));
    expect(res).toMatchObject({ rows: [], skipped: { invalid: 0, unreadable: 0, mismatched: 3 } });
    expect(res.error).toBe('3 of 3 `kanon-telemetry-implement` artifacts skipped (3 mismatched)');
  });
});

describe("only this repository's own runs are read (K-AGENT-45)", () => {
  const real = row('implement', 37000000090, '2026-10-01T00:00:00.000Z', { issue_number: 5 });
  // What a fork's `pull_request` run can upload: a row that passes `validate`, under a lane's name,
  // claiming its issue's latest run hit the cap.
  const forged = row('implement', 37000000091, '2026-10-02T00:00:00.000Z', { outcome: 'exhausted', issue_number: 5 });
  const fromFork = { id: 37000000091, repository_id: OWN, head_repository_id: FORK };

  it("a fork's valid row under a lane's name is ignored: not read, not skipped, only counted", () => {
    const gh = github([artifact(90, real), artifact(91, forged, { workflow_run: fromFork })]);
    const res = read(implement, gh);
    expect(res.error).toBeNull();
    expect(res.rows.map((r) => r.run_id)).toEqual(['37000000090']);
    expect(res).toMatchObject({ listed: 1, foreign: 1, skipped: { invalid: 0, unreadable: 0, mismatched: 0 } });
    expect(exhaustedAtByIssue(res.rows, [5]).size, 'the forged exhaustion stops nothing').toBe(0);
    expect(gh.downloads, "the fork's artifact is never downloaded").toEqual([90]);
  });

  it("a fork's junk under a lane's name doesn't fail the lane's read", () => {
    const res = read(implement, github([artifact(90, real), artifact(92, real, { name: 'kanon-telemetry-implement-37000000092-1', zip: Buffer.from('junk junk junk junk junk'), workflow_run: { ...fromFork, id: 37000000092 } })]));
    expect(res).toMatchObject({ error: null, listed: 1, foreign: 1 });
  });

  it('an artifact whose run is another run than its name says, or that names no run, is ignored', () => {
    const res = read(implement, github([
      artifact(93, forged, { workflow_run: { id: 1, repository_id: OWN, head_repository_id: OWN } }),
      artifact(94, forged, { name: 'kanon-telemetry-implement-37000000094-1', workflow_run: undefined }),
    ]));
    expect(res).toMatchObject({ rows: [], error: null, listed: 0, foreign: 2 });
  });
});

describe('retention shorter than the window is said, not hidden', () => {
  it('measures the repository\'s retention from the artifacts it lists', () => {
    const r = row('implement', 37000000070, '2026-10-03T00:00:00.000Z');
    const five = artifact(70, r);
    five.expires_at = new Date(Date.parse(five.created_at) + 5 * DAY - 150_000).toISOString();
    const res = read(implement, github([five]));
    expect(res.retentionDays).toBe(5);
    expect(artifactRetentionNote(res)).toBe('The repository keeps artifacts 5 days, so the artifact read covers 5 of the 14-day window.');
  });

  it("a fork's artifact can't set the retention the read reports", () => {
    const own = artifact(85, row('implement', 37000000085, '2026-10-03T00:00:00.000Z'));
    const fork = artifact(86, row('review', 37000000086, '2026-10-03T00:00:00.000Z'), { workflow_run: { id: 37000000086, repository_id: OWN, head_repository_id: FORK } });
    fork.expires_at = new Date(Date.parse(fork.created_at) + DAY).toISOString();
    expect(read(implement, github([own, fork])).retentionDays).toBe(90);
  });

  it('says nothing when retention covers the window, or when no artifact told it', () => {
    const res = read(implement, github([artifact(80, row('implement', 37000000080, '2026-10-03T00:00:00.000Z'))]));
    expect(res.retentionDays).toBe(90);
    expect(artifactRetentionNote(res)).toBe('');
    expect(artifactRetentionNote(read(implement, github([])))).toBe('');
  });
});
