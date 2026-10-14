import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_ROWS as FUNCTION_MAX_ROWS } from '../../infra/telemetry/function/index.mjs';
import {
  COLLECT_JOB,
  COLLECT_JOB_OVERRIDE,
  MAX_ROWS,
  SWEEP_CAP_DAYS,
  UNPUBLISHED_JOB,
  WINDOW_MINUTES,
  codesOnly,
  collect,
  checkStep,
  ensureRegistered,
  eraseSelf,
  inputsOf,
  LEGACY_REFUSAL,
  lastSuccessfulSweep,
  refusalOf,
  sweepSince,
  tokenPost,
  underLevel,
  workflowFileOf,
} from '../../scripts/telemetry-collect.mjs';
import {
  ARTIFACT_FILE, ARTIFACT_PREFIX, DELIVERY_ARTIFACT_FILE, DELIVERY_ARTIFACT_PREFIX, deliveryArtifactName, DEPLOY_ARTIFACT_FILE, FINDING_ARTIFACT_FILE,
  findingArtifactName,
} from '../../scripts/lib/telemetry-artifacts.mjs';
import { HOSTED_AUDIENCE, HOSTED_INGEST_URL, mintToken, storeOf, storeRequest } from '../../scripts/lib/telemetry-token.mjs';
import { zipOf } from './helpers/zip.js';

/**
 * Plan 0002 S7: the collector, moved into Kanon. It sweeps this repository's version-2 rows from
 * their artifacts, back to its last successful sweep, and sends them to the store's function,
 * 25 to a request. Any row it can't send turns it red, by artifact and field name, never value.
 */

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-05T12:40:00Z');
const REPO = 'example/adopter';
const OWN = 1001;
const FORK = 2002;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

let nextRun = 37_000_000_000;
/** A valid version-2 run row, recorded `ago` ms before NOW. */
function row(ago: number, over: Record<string, unknown> = {}) {
  nextRun += 1;
  return {
    schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: iso(NOW - ago), run_id: nextRun, run_attempt: 1,
    role: 'reviewer', lane: 'review', outcome: 'ok', reason: 'none', kanon_version: '0.25.0', ...over,
  };
}

type Fake = { id: number; name: string; created_at: string; expires_at: string; workflow_run: { id: number; repository_id: number; head_repository_id: number }; zip: Buffer };
let nextId = 5000;
function artifact(r: Record<string, unknown>, opts: Partial<Fake> & { retentionDays?: number; content?: string } = {}): Fake {
  const created = Date.parse(String(r.recorded_at)) + 5_000;
  nextId += 1;
  return {
    id: nextId,
    name: `kanon-telemetry-${r.lane}-${r.run_id}-${r.run_attempt}`,
    created_at: iso(created),
    expires_at: iso(created + (opts.retentionDays ?? 90) * DAY),
    workflow_run: { id: Number(r.run_id), repository_id: OWN, head_repository_id: OWN },
    zip: zipOf(ARTIFACT_FILE, opts.content ?? JSON.stringify(r)),
    ...opts,
  };
}

function github(artifacts: Fake[], { listingFails = false } = {}) {
  const sorted = [...artifacts].sort((a, b) => b.id - a.id);
  const downloads: number[] = [];
  return {
    downloads,
    api: (path: string) => {
      if (listingFails) throw new Error('HTTP 502');
      const m = /^repos\/example\/adopter\/actions\/artifacts\?per_page=100&page=(\d+)$/.exec(path);
      if (!m) throw new Error(`unexpected path ${path}`);
      const page = Number(m[1]);
      return { artifacts: sorted.slice((page - 1) * 100, page * 100).map((a) => ({ expired: false, id: a.id, name: a.name, created_at: a.created_at, expires_at: a.expires_at, workflow_run: a.workflow_run })) };
    },
    download: (id: number) => {
      downloads.push(id);
      const a = sorted.find((x) => x.id === id);
      if (!a) throw new Error('404');
      return a.zip;
    },
  };
}

/** A store that stores every row, unless `answer` says otherwise. */
function store(answer?: (rows: Record<string, unknown>[]) => { status: number; json: unknown }) {
  const posts: Record<string, unknown>[][] = [];
  return {
    posts,
    post: async (rows: object[]) => {
      posts.push(rows as Record<string, unknown>[]);
      return answer ? answer(rows as Record<string, unknown>[]) : { status: 200, json: { results: rows.map(() => ({ status: 'stored' })) } };
    },
  };
}

const run = (gh: ReturnType<typeof github>, s: ReturnType<typeof store>, opts: { lastSuccess?: string | null; window?: string } = {}) =>
  collect({ repo: REPO, now: NOW, lastSuccess: opts.lastSuccess ?? iso(NOW - 60 * MIN), window: opts.window ?? '', api: gh.api, download: gh.download, post: s.post });

describe('the sweep reaches back to the last successful sweep (moved unchanged)', () => {
  const at = (ago: number) => iso(NOW - ago);
  it('reaches back to the last successful sweep, however long ago', () => {
    expect(sweepSince({ lastSuccess: at(5 * 60 * MIN), now: NOW })).toEqual({ since: NOW - 5 * 60 * MIN, capped: false, capDays: 7 });
  });
  it('still overlaps by the floor when the last sweep was recent', () => {
    expect(sweepSince({ lastSuccess: at(10 * MIN), now: NOW }).since).toBe(NOW - WINDOW_MINUTES * MIN);
  });
  it('takes everything reachable when there was never a successful sweep, or its time is unreadable', () => {
    expect(sweepSince({ lastSuccess: null, now: NOW })).toEqual({ since: NOW - 7 * DAY, capped: false, capDays: 7 });
    expect(sweepSince({ lastSuccess: 'not a date', now: NOW }).since).toBe(NOW - 7 * DAY);
  });
  it('honours an override exactly, up to the cap', () => {
    expect(sweepSince({ lastSuccess: at(5 * DAY), now: NOW, windowMinutes: 30, overridden: true })).toEqual({ since: NOW - 30 * MIN, capped: false, capDays: 7 });
    expect(sweepSince({ lastSuccess: null, now: NOW, windowMinutes: 30 * 24 * 60, overridden: true })).toEqual({ since: NOW - 7 * DAY, capped: true, capDays: 7 });
  });
});

describe('the cap: 7 days, or the repository retention when shorter (S1a, #212)', () => {
  it('stops at 7 days, inside the function window of 8, and says rows were lost past it', () => {
    expect(SWEEP_CAP_DAYS).toBe(7);
    expect(sweepSince({ lastSuccess: iso(NOW - 10 * DAY), now: NOW })).toEqual({ since: NOW - 7 * DAY, capped: true, capDays: 7 });
  });
  it('stops at a shorter retention', () => {
    expect(sweepSince({ lastSuccess: iso(NOW - 6 * DAY), now: NOW, retentionDays: 5 })).toEqual({ since: NOW - 5 * DAY, capped: true, capDays: 5 });
    expect(sweepSince({ lastSuccess: null, now: NOW, retentionDays: 5 }).since).toBe(NOW - 5 * DAY);
    // A longer retention changes nothing: the function refuses rows older than 8 days.
    expect(sweepSince({ lastSuccess: null, now: NOW, retentionDays: 90 }).since).toBe(NOW - 7 * DAY);
  });
  it('measures the retention from the artifacts and warns when a stopped collector lost rows', async () => {
    const r = row(2 * DAY);
    const res = await run(github([artifact(r, { retentionDays: 3 })]), store(), { lastSuccess: iso(NOW - 4 * DAY) });
    expect(res.since).toBe(NOW - 3 * DAY);
    expect(res.warnings).toEqual([expect.stringMatching(/before the 3-day cap: rows recorded before .* are lost/)]);
    expect(res.stored).toBe(1);
  });
});

describe('the run listing finds the caller by GITHUB_WORKFLOW_REF, and judges the collect job', () => {
  it('reads the top-level workflow file', () => {
    expect(workflowFileOf('yedeya-labs/kanon/.github/workflows/telemetry.yml@refs/heads/main')).toBe('telemetry.yml');
    expect(workflowFileOf(undefined)).toBeNull();
  });

  const runs = (list: Array<{ id: number; created_at: string; jobs: Array<{ name: string; conclusion: string }> }>) => {
    const paths: string[] = [];
    return {
      paths,
      api: (path: string) => {
        paths.push(path);
        if (path.includes('/actions/workflows/')) return { workflow_runs: list.map(({ id, created_at }) => ({ id, created_at })) };
        const m = /actions\/runs\/(\d+)\/jobs/.exec(path);
        return { jobs: list.find((r) => String(r.id) === m?.[1])?.jobs ?? [] };
      },
    };
  };

  it('anchors on the newest run whose collect job succeeded, never this run or a run that only skipped', () => {
    const gh = runs([
      { id: 9, created_at: 'self', jobs: [{ name: `collect / ${COLLECT_JOB}`, conclusion: 'success' }] },
      { id: 8, created_at: 'skipped', jobs: [{ name: 'collect / unset', conclusion: 'success' }, { name: `collect / ${COLLECT_JOB}`, conclusion: 'skipped' }] },
      { id: 7, created_at: '2026-10-05T10:40:00Z', jobs: [{ name: `collect / ${COLLECT_JOB}`, conclusion: 'success' }] },
    ]);
    expect(lastSuccessfulSweep({ api: gh.api, repo: REPO, file: 'telemetry.yml', branch: 'main', selfRunId: '9' })).toBe('2026-10-05T10:40:00Z');
    expect(gh.paths[0]).toBe('repos/example/adopter/actions/workflows/telemetry.yml/runs?status=success&branch=main&per_page=20');
  });

  it('passes over an override run, so a short window never becomes the watermark (kanon#315)', () => {
    // Sweeps were red for hours; an operator's 30-minute check went green. The next sweep must
    // still reach back to the last FULL sweep, not to the start of the check.
    const gh = runs([
      { id: 8, created_at: '2026-10-05T14:00:00Z', jobs: [{ name: `collect / ${COLLECT_JOB_OVERRIDE}`, conclusion: 'success' }] },
      { id: 7, created_at: '2026-10-05T10:40:00Z', jobs: [{ name: `collect / ${COLLECT_JOB}`, conclusion: 'success' }] },
    ]);
    expect(lastSuccessfulSweep({ api: gh.api, repo: REPO, file: 'telemetry.yml', branch: 'main', selfRunId: '9' })).toBe('2026-10-05T10:40:00Z');
  });

  it('passes over a run that skipped because the hosted store is unpublished, so the first real sweep reaches back past it (#843)', () => {
    // A release with the hosted URL empty skipped, green, every hour; the next release sends. Its
    // first sweep must reach back to the last real sweep, up to the cap, not to the last skip.
    const gh = runs([
      { id: 8, created_at: '2026-10-05T14:00:00Z', jobs: [{ name: `collect / ${UNPUBLISHED_JOB}`, conclusion: 'success' }] },
      { id: 7, created_at: '2026-10-05T10:40:00Z', jobs: [{ name: `collect / ${COLLECT_JOB}`, conclusion: 'success' }] },
    ]);
    expect(lastSuccessfulSweep({ api: gh.api, repo: REPO, file: 'telemetry.yml', branch: 'main', selfRunId: '9' })).toBe('2026-10-05T10:40:00Z');
    expect(lastSuccessfulSweep({ api: runs([{ id: 8, created_at: 'x', jobs: [{ name: UNPUBLISHED_JOB, conclusion: 'success' }] }]).api, repo: REPO, file: 'telemetry.yml', branch: 'main', selfRunId: '9' })).toBeNull();
  });

  it('returns null when no sweep collected', () => {
    const gh = runs([{ id: 8, created_at: 'x', jobs: [{ name: `collect / ${COLLECT_JOB}`, conclusion: 'skipped' }] }]);
    expect(lastSuccessfulSweep({ api: gh.api, repo: REPO, file: 'telemetry.yml', branch: 'main', selfRunId: '1' })).toBeNull();
  });
});

describe('every row in the span is sent, 25 to a request', () => {
  it('sends the function maximum per request', async () => {
    expect(MAX_ROWS).toBe(FUNCTION_MAX_ROWS);
    const arts = Array.from({ length: 30 }, (_, i) => artifact(row(i * MIN)));
    const s = store();
    const res = await run(github(arts), s);
    expect(s.posts.map((p) => p.length)).toEqual([25, 5]);
    expect(res).toMatchObject({ listed: 30, sent: 30, stored: 30, failures: [] });
  });

  it('sends the row as uploaded: smoke rows keep tag smoke', async () => {
    const r = row(5 * MIN, { tag: 'smoke' });
    const s = store();
    await run(github([artifact(r)]), s);
    expect(s.posts).toEqual([[r]]);
  });

  it('downloads each artifact by id, so two that share a name are both sent', async () => {
    const a = row(5 * MIN);
    const b = { ...a, pr_number: 12 };
    const gh = github([artifact(a), artifact(b, { name: `kanon-telemetry-review-${a.run_id}-1` })]);
    const s = store();
    const res = await run(gh, s);
    expect(gh.downloads).toHaveLength(2);
    expect(res.stored).toBe(2);
  });

  it('sends nothing and stays green when there is nothing in the span', async () => {
    const s = store();
    const res = await run(github([artifact(row(3 * 60 * MIN))]), s);
    expect(s.posts).toEqual([]);
    expect(res).toMatchObject({ listed: 0, sent: 0, failures: [] });
  });

  it('ignores version-1 artifacts and other names', async () => {
    const r = row(5 * MIN);
    const s = store();
    const res = await run(github([artifact(r, { name: `agent-telemetry-reviewer-${r.run_id}-1` }), artifact(row(5 * MIN), { name: 'coverage' })]), s);
    expect(res.listed).toBe(0);
    expect(s.posts).toEqual([]);
  });

  it("ignores a fork's artifacts: only this repository's own runs are sent", async () => {
    const r = row(5 * MIN);
    const fork = artifact(r);
    fork.workflow_run = { id: Number(r.run_id), repository_id: OWN, head_repository_id: FORK };
    const s = store();
    const res = await run(github([fork, artifact(row(6 * MIN))]), s);
    expect(res).toMatchObject({ listed: 1, sent: 1, foreign: 1, failures: [] });
  });

  it('warns when the span shows dropped schedules', async () => {
    const res = await run(github([]), store(), { lastSuccess: iso(NOW - 5 * 60 * MIN) });
    expect(res.warnings).toEqual([expect.stringMatching(/swept 300 minutes, well past the 90-minute floor/)]);
  });
});

describe('a row that cannot be sent turns the run red, by name and never by value', () => {
  const SENTENCE = 'claude-opus never ran (modelUsage: secret detail)';

  it('a row that fails the schema names the field', async () => {
    const r = row(5 * MIN, { reason: SENTENCE });
    const s = store();
    const res = await run(github([artifact(r)]), s);
    expect(s.posts).toEqual([]);
    expect(res.failures).toEqual([expect.stringMatching(new RegExp(`^review run ${r.run_id} attempt 1 \\(artifact \\d+\\): fails the schema \\(.*reason.*\\)$`))]);
    expect(res.failures.join('\n')).not.toContain('secret detail');
  });

  it("a row whose lane, run or attempt isn't its artifact's", async () => {
    const r = row(5 * MIN);
    const res = await run(github([artifact(r, { name: `kanon-telemetry-implement-${r.run_id}-1` }), artifact({ ...row(5 * MIN), run_attempt: 2 }, { name: `kanon-telemetry-review-${nextRun}-1` })]), store());
    expect(res.failures).toHaveLength(2);
    expect(res.failures.every((f) => f.endsWith("the row's row_kind, lane, run_id or run_attempt is not its artifact's"))).toBe(true);
  });

  it('an artifact with no row file, or one that is not JSON', async () => {
    const res = await run(github([artifact(row(5 * MIN), { zip: zipOf('other.json', '{}') }), artifact(row(5 * MIN), { content: '{nope' })]), store());
    expect(res.failures).toHaveLength(2);
    expect(res.failures).toContainEqual(expect.stringContaining(': unreadable (no kanon-telemetry.json)'));
    expect(res.failures).toContainEqual(expect.stringMatching(/: unreadable \(.*JSON/));
  });

  it('a row the store rejects names the fields it gave', async () => {
    const good = row(5 * MIN);
    const bad = row(6 * MIN);
    const s = store((rows) => ({ status: 422, json: { results: rows.map((x) => (x.run_id === bad.run_id ? { status: 'rejected', errors: [{ field: 'recorded_at', problem: 'window' }] } : { status: 'stored' })) } }));
    const res = await run(github([artifact(good), artifact(bad)]), s);
    expect(res.stored).toBe(1);
    expect(res.failures).toEqual([expect.stringMatching(new RegExp(`review run ${bad.run_id} attempt 1 \\(artifact \\d+\\): rejected by the store \\(recorded_at: window\\)$`))]);
  });

  it('a request the store refuses whole, or a write it failed', async () => {
    const refused = await run(github([artifact(row(5 * MIN))]), store(() => ({ status: 401, json: { error: 'aud' } })));
    expect(refused.failures).toEqual(['rows 1-1: the store answered 401 (aud)']);
    const notJson = await run(github([artifact(row(5 * MIN))]), store(() => ({ status: 500, json: null })));
    expect(notJson.failures).toEqual(['rows 1-1: the store answered 500']);
    // A code outside the store's closed list is never echoed.
    const odd = await run(github([artifact(row(5 * MIN))]), store(() => ({ status: 400, json: { error: 'Some <value> from a row' } })));
    expect(odd.failures).toEqual(['rows 1-1: the store answered 400']);
    const failed = await run(github([artifact(row(5 * MIN))]), store((rows) => ({ status: 502, json: { results: rows.map(() => ({ status: 'failed' })) } })));
    expect(failed.failures).toEqual([expect.stringMatching(/: the store failed to write it$/)]);
    const thrown = await run(github([artifact(row(5 * MIN))]), { posts: [], post: async () => { throw new Error('ECONNRESET'); } });
    expect(thrown.failures).toEqual(['rows 1-1: the request failed (ECONNRESET)']);
  });

  it('a listing that fails is a failure, not an empty sweep', async () => {
    const res = await run(github([], { listingFails: true }), store());
    expect(res.failures).toEqual(['could not list artifacts (HTTP 502)']);
  });

  it('a window_minutes that is not a whole number is refused', async () => {
    const res = await run(github([]), store(), { window: 'ninety' });
    expect(res.failures).toEqual(["window_minutes is 'ninety', not a whole number of minutes"]);
  });

  it('every other row is still sent: one bad artifact fails the run, not the sweep', async () => {
    const s = store();
    const res = await run(github([artifact(row(5 * MIN, { lane: 'nope' })), artifact(row(6 * MIN))]), s);
    expect(res.stored).toBe(1);
    expect(res.failures).toHaveLength(1);
  });
});

describe('finding rows (plan 0006 §5 step 3, F4): sent under the level the record declares on the default branch', () => {
  /** A valid finding row of the overseer's run `runId`, recorded `ago` ms before NOW. */
  const finding = (runId: number, index: number, over: Record<string, unknown> = {}) => ({
    schema_version: 1, row_kind: 'finding', tag: 'run', recorded_at: iso(NOW - 5 * MIN), run_id: runId, run_attempt: 1, finding_index: index,
    reporter: 'overseer', subject: 'lane', lane: 'review', reason: 'did_not_finish', kanon_version: '0.37.0', fix_category: 'lane-behaviour',
    evidence_level: 'codes', ...over,
  });
  const TEXT = { evidence_level: 'evidence', evidence: 'Expected: the review lane finishes (K-AGENT-12).\nObserved: it stopped at stage `agent`.', suggested_fix: 'Cap the re-reads.', scrub_version: 1 };
  function findingArtifact(rows: Record<string, unknown>[], opts: { name?: string; content?: string; retentionDays?: number; runId?: number; fork?: boolean } = {}): Fake {
    const runId = opts.runId ?? Number(rows[0]?.run_id);
    const created = NOW - 4 * MIN;
    nextId += 1;
    return {
      id: nextId,
      name: opts.name ?? findingArtifactName('overseer', runId, 1),
      created_at: iso(created),
      expires_at: iso(created + (opts.retentionDays ?? 90) * DAY),
      workflow_run: { id: runId, repository_id: OWN, head_repository_id: opts.fork ? FORK : OWN },
      zip: zipOf(FINDING_ARTIFACT_FILE, opts.content ?? JSON.stringify(rows)),
    };
  }
  const sweep = (gh: ReturnType<typeof github>, s: ReturnType<typeof store>, level: () => string) =>
    collect({ repo: REPO, now: NOW, lastSuccess: iso(NOW - 60 * MIN), window: '', api: gh.api, download: gh.download, post: s.post, level });
  const sent = (s: ReturnType<typeof store>) => s.posts.flat().filter((r) => r.row_kind === 'finding');

  it('agrees with the lanes on the artifact: its name and its file come from one module', () => {
    expect(findingArtifactName('explore-telemetry', 42, 2)).toBe('kanon-finding-explore-telemetry-42-2');
    expect(FINDING_ARTIFACT_FILE).toBe('kanon-finding.json');
  });

  it('`sent with evidence`: sends every row as the lane built it, beside the run rows', async () => {
    nextRun += 1;
    const rows = [finding(nextRun, 0), finding(nextRun, 1, TEXT)];
    const r = row(5 * MIN);
    const s = store();
    const res = await sweep(github([artifact(r), findingArtifact(rows)]), s, () => 'sent with evidence');
    expect(res).toMatchObject({ listed: 2, sent: 3, stored: 3, withheld: 0, failures: [], warnings: [] });
    expect(sent(s)).toEqual(rows);
  });

  it('`sent`: sends each row as codes only, with no evidence, suggested fix or scrub version', async () => {
    nextRun += 1;
    const rows = [finding(nextRun, 0), finding(nextRun, 1, TEXT)];
    const s = store();
    const res = await sweep(github([findingArtifact(rows)]), s, () => 'sent');
    expect(res).toMatchObject({ sent: 2, stored: 2, failures: [] });
    expect(sent(s)).toEqual([rows[0], finding(nextRun, 1)]);
    expect(JSON.stringify(s.posts)).not.toContain('Observed');
  });

  it('a record turned from `sent with evidence` to `sent` sends the next sweep the same level-2 artifact without its text', async () => {
    nextRun += 1;
    const gh = github([findingArtifact([finding(nextRun, 0, TEXT)])]);
    const first = store();
    await sweep(gh, first, () => 'sent with evidence');
    expect(sent(first)[0]).toMatchObject({ evidence_level: 'evidence', evidence: TEXT.evidence });
    const next = store();
    await sweep(gh, next, () => 'sent');
    expect(sent(next)).toEqual([finding(nextRun, 0)]);
  });

  it('`drafted` and `filed here` send none, and say how many they held back; the run rows still go', async () => {
    for (const value of ['drafted', 'filed here']) {
      nextRun += 1;
      const s = store();
      const lines: string[] = [];
      const gh = github([artifact(row(5 * MIN)), findingArtifact([finding(nextRun, 0), finding(nextRun, 1)])]);
      const res = await collect({ repo: REPO, now: NOW, lastSuccess: iso(NOW - 60 * MIN), api: gh.api, download: gh.download, post: s.post, level: () => value, log: (l) => lines.push(l) });
      expect(sent(s)).toEqual([]);
      expect(res).toMatchObject({ stored: 1, withheld: 2, failures: [] });
      expect(lines).toContainEqual(expect.stringContaining(`level is \`${value}\`, which sends none`));
    }
  });

  it('reads the level once a sweep, and not at all when there is no finding artifact', async () => {
    let reads = 0;
    const level = () => { reads += 1; return 'sent'; };
    await sweep(github([artifact(row(5 * MIN))]), store(), level);
    expect(reads).toBe(0);
    nextRun += 1;
    const a = nextRun;
    nextRun += 1;
    await sweep(github([findingArtifact([finding(a, 0)]), findingArtifact([finding(nextRun, 0)])]), store(), level);
    expect(reads).toBe(1);
  });

  it("a record that can't be read sends no finding row and turns the run red; the run rows are still sent", async () => {
    nextRun += 1;
    const s = store();
    const res = await sweep(github([artifact(row(5 * MIN)), findingArtifact([finding(nextRun, 0)])]), s, () => { throw new Error('docs/qa/adoption.md:7 is malformed (K-LAYOUT-10)'); });
    expect(sent(s)).toEqual([]);
    expect(res.stored).toBe(1);
    expect(res.failures).toEqual([expect.stringMatching(/^no finding row is sent: .*can't be read on the default branch \(docs\/qa\/adoption.md:7 is malformed/)]);
  });

  it("refuses a row whose reporter, run or attempt isn't its artifact's, or that is not a finding", async () => {
    nextRun += 1;
    const id = nextRun;
    const rows = [finding(id, 0, { reporter: 'explore-telemetry' }), finding(id + 1, 1), finding(id, 2, { run_attempt: 2 }), row(5 * MIN, { run_id: id }), finding(id, 4)];
    const s = store();
    const res = await sweep(github([findingArtifact(rows, { runId: id })]), s, () => 'sent');
    expect(res.failures).toHaveLength(4);
    expect(res.failures.every((f) => f.endsWith("the row's row_kind, reporter, run_id or run_attempt is not its artifact's"))).toBe(true);
    expect(sent(s)).toEqual([rows[4]]);
  });

  it('sends a text the scrub still finds something in as codes, with a warning naming the field and the rule, never the text', async () => {
    // An older lane's weaker scrub, or a word of this repository's own name (`example/adopter`).
    nextRun += 1;
    const rows = [
      finding(nextRun, 0, { ...TEXT, evidence: 'Observed: the lane read https://SECRET.example.com/x first.' }),
      finding(nextRun, 1, { ...TEXT, suggested_fix: 'Rename the Example step.' }),
    ];
    const s = store();
    const res = await sweep(github([findingArtifact(rows)]), s, () => 'sent with evidence');
    expect(res.failures).toEqual([]);
    expect(sent(s)).toEqual([finding(nextRun, 0), finding(nextRun, 1)]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/row 0: sent at codes, without its text, because the scrub still finds evidence \(url, path/),
      expect.stringMatching(/row 1: sent at codes, without its text, because the scrub still finds suggested_fix \(name\)/),
    ]);
    expect(res.warnings.join('\n')).not.toContain('SECRET');
  });

  it('an artifact that is not a list of 1 to 20 rows, or is unreadable, is a failure', async () => {
    nextRun += 1;
    const many = Array.from({ length: 21 }, (_, i) => finding(nextRun, i % 20));
    const res = await sweep(github([
      findingArtifact(many),
      findingArtifact([], { runId: nextRun + 1 }),
      findingArtifact([], { runId: nextRun + 2, content: '{"not":"a list"}' }),
      findingArtifact([], { runId: nextRun + 3, content: '{nope' }),
    ]), store(), () => 'sent');
    nextRun += 3;
    expect(res.failures).toHaveLength(4);
    expect(res.failures.filter((f) => f.endsWith('not a list of 1 to 20 finding rows'))).toHaveLength(3);
    expect(res.failures).toContainEqual(expect.stringMatching(/: unreadable \(.*JSON/));
  });

  it("ignores a fork's finding artifact, and a name with a reporter outside the schema's list", async () => {
    nextRun += 1;
    const s = store();
    const res = await sweep(github([
      findingArtifact([finding(nextRun, 0)], { fork: true }),
      findingArtifact([finding(nextRun, 0)], { name: `kanon-finding-review-${nextRun}-1` }),
    ]), s, () => 'sent');
    expect(res).toMatchObject({ listed: 0, sent: 0, foreign: 1, failures: [] });
  });

  it("measures the retention from the run artifacts alone: a finding artifact's own does not move the cap", async () => {
    nextRun += 1;
    const gh = github([artifact(row(5 * MIN)), findingArtifact([finding(nextRun, 0)], { retentionDays: 1 })]);
    const s = store();
    // The last sweep was two days ago: a one-day cap would cut the span and warn that rows were lost.
    const res = await collect({ repo: REPO, now: NOW, lastSuccess: iso(NOW - 2 * DAY), api: gh.api, download: gh.download, post: s.post, level: () => 'sent' });
    expect(res.since).toBe(NOW - 2 * DAY);
    expect(res.warnings.filter((w) => w.includes('cap'))).toEqual([]);
    expect(res.stored).toBe(2);
  });

  it('strips by level, and never raises one', () => {
    const coded = finding(1, 0);
    const texted = finding(1, 0, TEXT);
    expect(underLevel(texted, 'sent')).toEqual({ row: coded, stripped: true });
    expect(underLevel(coded, 'sent')).toEqual({ row: coded, stripped: false });
    expect(underLevel(texted, 'sent with evidence')).toEqual({ row: texted, stripped: false });
    expect(underLevel(coded, 'drafted')).toBeNull();
    expect(underLevel(coded, 'filed here')).toBeNull();
    expect(codesOnly(texted)).toEqual(coded);
  });
});

describe('deploy rows (plan 0010 §8, §10, D9): sent from the deploy lane\'s `kanon-deploy-row-*` artifacts', () => {
  /** A valid deploy row of the current run, for the environment at `position`. */
  const deployRow = (position: number, over: Record<string, unknown> = {}) => ({
    schema_version: 1, row_kind: 'deploy', tag: 'run', recorded_at: iso(NOW - 10 * MIN), run_id: nextRun, run_attempt: 1,
    kanon_version: '0.50.0', role: position === 2 ? 'production' : 'pre-production', position, outcome: 'ok', ...over,
  });
  const deployArtifact = (r: Record<string, unknown>, opts: { fork?: boolean; name?: string; content?: string } = {}): Fake => {
    nextId += 1;
    const created = Date.parse(String(r.recorded_at)) + 5_000;
    return {
      id: nextId,
      name: opts.name ?? `kanon-deploy-row-${r.run_id}-${r.run_attempt}-${r.position}`,
      created_at: iso(created),
      expires_at: iso(created + 90 * DAY),
      workflow_run: { id: Number(r.run_id), repository_id: OWN, head_repository_id: opts.fork ? FORK : OWN },
      zip: zipOf(DEPLOY_ARTIFACT_FILE, opts.content ?? JSON.stringify(r)),
    };
  };

  it("sends each environment's row beside the run rows", async () => {
    const runRow = row(5 * MIN);
    nextRun += 1;
    const s = store();
    const res = await run(github([artifact(runRow), deployArtifact(deployRow(1)), deployArtifact(deployRow(2))]), s);
    expect(res).toMatchObject({ listed: 3, sent: 3, stored: 3, failures: [] });
    const sent = s.posts.flat();
    expect(sent.filter((r) => r.row_kind === 'deploy').map((r) => r.position).sort()).toEqual([1, 2]);
    expect(sent.filter((r) => r.row_kind === 'run')).toHaveLength(1);
  });

  it("refuses a row whose run, attempt or position isn't its artifact's, or that is not a deploy row", async () => {
    nextRun += 1;
    const s = store();
    const res = await run(github([
      deployArtifact(deployRow(1), { name: `kanon-deploy-row-${nextRun}-1-2` }),
      deployArtifact({ ...row(5 * MIN, { run_id: nextRun }), position: 3 }),
    ]), s);
    expect(res.sent).toBe(0);
    expect(res.failures.sort()).toEqual([
      expect.stringMatching(/^deploy run \d+ attempt 1 position 2 .*: the row's row_kind, run_id, run_attempt or position is not its artifact's$/),
      expect.stringMatching(/^deploy run \d+ attempt 1 position 3 .*: (the row's row_kind, run_id, run_attempt or position is not its artifact's|fails the schema)/),
    ]);
  });

  it('a row that fails the schema names the field, never the value; an unreadable artifact is a failure', async () => {
    nextRun += 1;
    const res = await run(github([
      deployArtifact(deployRow(1, { environment: 'prod-eu' })),
      deployArtifact(deployRow(2), { content: 'not json' }),
    ]), store());
    expect(res.sent).toBe(0);
    expect(res.failures).toContainEqual(expect.stringMatching(/position 1 .*fails the schema \(.*environment/));
    expect(res.failures.join('\n')).not.toContain('prod-eu');
    expect(res.failures).toContainEqual(expect.stringMatching(/position 2 .*: unreadable/));
  });

  it("ignores a fork's deploy artifact", async () => {
    nextRun += 1;
    const res = await run(github([deployArtifact(deployRow(1), { fork: true })]), store());
    expect(res).toMatchObject({ listed: 0, sent: 0, foreign: 1, failures: [] });
  });
});

describe('notify rows (plan 0011 §11, N5): sent from each lane\'s `kanon-delivery-*` artifacts', () => {
  /** A valid notify row of a fresh run of the project digest's `notify` job. */
  const notifyRow = (over: Record<string, unknown> = {}) => {
    nextRun += 1;
    return {
      schema_version: 1, row_kind: 'notify', tag: 'run', recorded_at: iso(NOW - 10 * MIN), run_id: nextRun, run_attempt: 1,
      producer_attempt: 1, lane: 'project-digest', kanon_version: '0.50.0', kind: 'project-digest', contract_version: 1,
      hook: 'slack', outcome: 'posted', duration_ms: 800, ...over,
    };
  };
  const deliveryArtifact = (r: Record<string, unknown>, opts: { fork?: boolean; name?: string; content?: string } = {}): Fake => {
    nextId += 1;
    const created = Date.parse(String(r.recorded_at)) + 5_000;
    return {
      id: nextId,
      name: opts.name ?? deliveryArtifactName(String(r.lane), Number(r.run_id), Number(r.run_attempt)),
      created_at: iso(created),
      expires_at: iso(created + 90 * DAY),
      workflow_run: { id: Number(r.run_id), repository_id: OWN, head_repository_id: opts.fork ? FORK : OWN },
      zip: zipOf(DELIVERY_ARTIFACT_FILE, opts.content ?? JSON.stringify(r)),
    };
  };

  it('names the family as the plan does, outside the run rows\' reserved prefix (kanon#826)', () => {
    expect(DELIVERY_ARTIFACT_PREFIX).toBe('kanon-delivery-');
    expect(DELIVERY_ARTIFACT_FILE).toBe('kanon-delivery.json');
    expect(deliveryArtifactName('weekly-digest', 12, 3)).toBe('kanon-delivery-weekly-digest-12-3');
    expect(DELIVERY_ARTIFACT_PREFIX.startsWith(ARTIFACT_PREFIX)).toBe(false);
  });

  it('sends a row of each outcome beside the run rows', async () => {
    const runRow = row(5 * MIN);
    const s = store();
    const res = await run(github([
      artifact(runRow),
      deliveryArtifact(notifyRow()),
      deliveryArtifact(notifyRow({ outcome: 'failed', failure: 'hook-step-failed', lane: 'weekly-digest', kind: 'weekly-digest' })),
      deliveryArtifact(notifyRow({ outcome: 'skipped', skip_reason: 'no-message', producer_attempt: undefined, contract_version: undefined })),
    ]), s);
    expect(res).toMatchObject({ listed: 4, sent: 4, stored: 4, failures: [] });
    const sent = s.posts.flat();
    expect(sent.filter((r) => r.row_kind === 'notify').map((r) => r.outcome).sort()).toEqual(['failed', 'posted', 'skipped']);
    expect(sent.filter((r) => r.row_kind === 'run')).toHaveLength(1);
  });

  it('sends a re-run of notify alone: its own attempt in the name, the producer\'s in the row', async () => {
    const s = store();
    const res = await run(github([deliveryArtifact(notifyRow({ run_attempt: 2, producer_attempt: 1 }))]), s);
    expect(res).toMatchObject({ sent: 1, failures: [] });
    expect(s.posts.flat()[0]).toMatchObject({ run_attempt: 2, producer_attempt: 1 });
  });

  it("refuses a row whose lane, run or attempt isn't its artifact's, or that is not a notify row", async () => {
    const wrongLane = notifyRow();
    const wrongRun = notifyRow();
    const wrongAttempt = notifyRow();
    const runInside = notifyRow();
    const res = await run(github([
      deliveryArtifact(wrongLane, { name: deliveryArtifactName('weekly-digest', Number(wrongLane.run_id), 1) }),
      deliveryArtifact(wrongRun, { name: deliveryArtifactName('project-digest', Number(wrongRun.run_id) + 1, 1) }),
      deliveryArtifact(wrongAttempt, { name: deliveryArtifactName('project-digest', Number(wrongAttempt.run_id), 2) }),
      deliveryArtifact(runInside, { content: JSON.stringify(row(5 * MIN, { run_id: runInside.run_id, lane: 'project-digest', role: 'overseer' })) }),
    ].map((a, i) => (i === 1 ? { ...a, workflow_run: { ...a.workflow_run, id: Number(wrongRun.run_id) + 1 } } : a))), store());
    expect(res.sent).toBe(0);
    expect(res.failures).toHaveLength(4);
    for (const f of res.failures) expect(f).toMatch(/notify run \d+ attempt \d+ .*: the row's row_kind, lane, run_id or run_attempt is not its artifact's$/);
    expect(res.failures.filter((f) => f.startsWith('weekly-digest notify'))).toHaveLength(1);
  });

  it('a row that fails the schema names the field, never the value; an unreadable artifact is a failure', async () => {
    const res = await run(github([
      deliveryArtifact(notifyRow({ url: 'https://hooks.slack.com/services/T0/B0/xyz', channel: '#general' })),
      deliveryArtifact(notifyRow(), { content: 'not json' }),
    ]), store());
    expect(res.sent).toBe(0);
    expect(res.failures).toContainEqual(expect.stringMatching(/notify run .*fails the schema \(url \(unknown\), channel \(unknown\)\)/));
    expect(res.failures.join('\n')).not.toMatch(/hooks\.slack\.com|#general/);
    expect(res.failures).toContainEqual(expect.stringMatching(/notify run .*: unreadable/));
  });

  it("ignores a fork's delivery artifact, and a name outside the lanes", async () => {
    const r = notifyRow();
    const res = await run(github([
      deliveryArtifact(r, { fork: true }),
      deliveryArtifact(notifyRow(), { name: `kanon-delivery-not-a-lane-${nextRun}-1` }),
    ]), store());
    expect(res).toMatchObject({ listed: 0, sent: 0, foreign: 1, failures: [] });
  });
});

// ── The token path (plan 0008 §2.1, §3.2, §7, §8; step J5) ─────────────────────────────────────

const SELF_URL = 'https://abc123def.lambda-url.eu-central-1.on.aws/';
const SELF_AUDIENCE = 'acme-telemetry';
/** A JWS-shaped token, minted by the fake runner: never a real one. */
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

/** The runner's OIDC endpoint and a store, as one fake `fetch`, recording every call. */
function fakeNet(answer: (method: string, path: string, body: unknown) => { status: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; method: string; path: string; auth?: string; body?: unknown }> = [];
  let minted = 0;
  const fetchImpl = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(url);
    if (u.host === 'runner.example') {
      minted += 1;
      calls.push({ url, method: 'GET', path: 'oidc', auth: init.headers?.authorization });
      return new Response(JSON.stringify({ value: `${TOKEN}${minted}` }), { status: 200 });
    }
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method ?? 'GET', path: u.pathname, auth: init.headers?.authorization, body });
    const a = answer(init.method ?? 'GET', u.pathname, body);
    return new Response(a.json === undefined ? '' : JSON.stringify(a.json), { status: a.status, headers: a.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, minted: () => minted };
}
const RUNNER_ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://runner.example/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token' };
const SELF = { ok: true as const, url: SELF_URL, audience: SELF_AUDIENCE, hosted: false };

describe('which store: the hosted URL is fixed with its audience, and a self-hosted one takes url and audience together (§2.1)', () => {
  it('the hosted store when neither is given; unpublished until the operator publishes the URL (Owner decision 10)', () => {
    const s = storeOf({ hostedUrl: HOSTED_INGEST_URL });
    if (HOSTED_INGEST_URL) expect(s).toEqual({ ok: true, url: HOSTED_INGEST_URL, audience: HOSTED_AUDIENCE, hosted: true });
    else expect(s).toMatchObject({ ok: false, unpublished: true });
    expect(storeOf({ hostedUrl: SELF_URL })).toEqual({ ok: true, url: SELF_URL, audience: 'kanon-telemetry', hosted: true });
  });

  it('a self-hosted store by both together', () => {
    expect(storeOf({ url: SELF_URL, audience: SELF_AUDIENCE, hostedUrl: '' })).toEqual(SELF);
  });

  it('refuses one without the other', () => {
    expect(storeOf({ url: SELF_URL, hostedUrl: '' })).toMatchObject({ ok: false, why: expect.stringContaining('only `url` is given') });
    expect(storeOf({ audience: SELF_AUDIENCE, hostedUrl: '' })).toMatchObject({ ok: false, why: expect.stringContaining('only `audience` is given') });
  });

  it('refuses the hosted audience sent to a URL of its own (the mutation J5 names)', () => {
    expect(storeOf({ url: SELF_URL, audience: HOSTED_AUDIENCE, hostedUrl: 'https://hosted1.lambda-url.eu-central-1.on.aws/' })).toMatchObject({ ok: false, why: expect.stringContaining('only ever sent to the hosted store') });
    expect(storeOf({ url: SELF_URL, audience: HOSTED_AUDIENCE, hostedUrl: '' })).toMatchObject({ ok: false });
  });

  it('refuses a URL that is not a function URL, and an audience of the wrong shape', () => {
    for (const url of ['http://abc.lambda-url.eu-central-1.on.aws/', 'https://evil.example/', 'https://abc.lambda-url.eu-central-1.on.aws/x', 'https://abc.lambda-url.eu-central-1.on.aws.evil.example/']) {
      expect(storeOf({ url, audience: SELF_AUDIENCE, hostedUrl: '' })).toMatchObject({ ok: false });
    }
    expect(storeOf({ url: SELF_URL, audience: 'https://x', hostedUrl: '' })).toMatchObject({ ok: false });
  });
});

describe("the collect job's inputs, checked before any token is minted", () => {
  it('url without audience refuses, and the check step exits 1 naming it', () => {
    const lines: string[] = [];
    expect(checkStep({ KANON_TELEMETRY_URL: SELF_URL }, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toMatch(/::error title=telemetry-collect::the caller passes `url` or `writer-role` without `audience`.*no token was minted/);
    // audience alone is refused by the store check, naming what is missing.
    const alone: string[] = [];
    expect(checkStep({ KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE }, (l) => alone.push(l))).toBe(1);
    expect(alone.join('\n')).toMatch(/only `audience` is given.*no token was minted/);
  });

  // Owner decision of 2026-10-14 (#842): the SigV4 path's inputs are refused, never redirected.
  it('a caller that still passes url and writer-role without audience is refused, and its url is never swapped for the hosted store', () => {
    const r = inputsOf({ KANON_TELEMETRY_URL: 'https://old123.lambda-url.eu-central-1.on.aws/', LEGACY: 'true' });
    expect(r.problems).toEqual([LEGACY_REFUSAL]);
    expect(r.store).toMatchObject({ ok: false });
    expect(LEGACY_REFUSAL).toMatch(/nothing is sent and nothing is registered/);
    expect(LEGACY_REFUSAL).toMatch(/Run `kanon init` again/);
    expect(LEGACY_REFUSAL).toMatch(/add `audience:` beside `url:`/);
    // writer-role alone, with no url, is refused the same.
    expect(inputsOf({ LEGACY: 'true' }).problems).toEqual([LEGACY_REFUSAL]);
    // Beside a self-hosted url and audience, writer-role is ignored, with a warning.
    const self = inputsOf({ KANON_TELEMETRY_URL: SELF_URL, KANON_TELEMETRY_AUDIENCE: SELF_AUDIENCE, LEGACY: 'true' });
    expect(self).toMatchObject({ problems: [], store: SELF });
    expect(self.warnings).toEqual([expect.stringContaining('`writer-role`, which this release of the collector ignores')]);
  });

  it('a legacy self-hosted caller sends nothing, registers nothing, and stays red: the run stops before any token (#842)', () => {
    // The whole script, as the job runs it, against a runner endpoint that would answer: a mint, a
    // registration or a row would each have to reach it, and the run must stop before all three.
    const script = fileURLToPath(new URL('../../scripts/telemetry-collect.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, GITHUB_REPOSITORY: REPO, GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/telemetry.yml@refs/heads/main`,
        KANON_TELEMETRY_URL: 'https://old123.lambda-url.eu-central-1.on.aws/', LEGACY: 'true', ERASE: '', REGISTER: '',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://127.0.0.1:9/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('nothing is sent and nothing is registered');
    for (const s of ['add-mask', 'OIDC endpoint', 'could not be reached', 'Telemetry registration', 'Telemetry collector:']) expect(r.stdout + r.stderr).not.toContain(s);
    const lines: string[] = [];
    expect(checkStep({ KANON_TELEMETRY_URL: 'https://old123.lambda-url.eu-central-1.on.aws/', LEGACY: 'true' }, (l) => lines.push(l))).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/^::error title=telemetry-collect::the caller passes `url` or `writer-role` without `audience`/)]);
  });

  it('erase and register are yes or no, empty on a schedule, never both', () => {
    expect(inputsOf({ ERASE: '', REGISTER: '' })).toMatchObject({ erase: false, register: false, problems: [] });
    expect(inputsOf({ ERASE: 'yes', REGISTER: 'no' })).toMatchObject({ erase: true, register: false });
    expect(inputsOf({ ERASE: 'maybe' }).problems).toEqual(['`erase` is neither yes nor no']);
    expect(inputsOf({ ERASE: 'yes', REGISTER: 'yes' }).problems).toEqual(['`erase` and `register` are both yes: dispatch one at a time']);
  });
});

describe('a fresh token per request, masked before anything prints, never written', () => {
  it('asks the runner for the store\'s audience, masks it first, and sends it as a bearer token', async () => {
    const net = fakeNet(() => ({ status: 200, json: { status: 'active' } }));
    const masked: string[] = [];
    const a = await storeRequest(SELF, { method: 'GET', path: 'v1/registrations/self' }, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: (t) => masked.push(t) });
    expect(a.status).toBe(200);
    expect(net.calls[0]).toMatchObject({ url: `${RUNNER_ENV.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${SELF_AUDIENCE}`, auth: 'Bearer runner-request-token' });
    expect(masked).toEqual([`${TOKEN}1`]);
    expect(net.calls[1]).toMatchObject({ url: `${SELF_URL}v1/registrations/self`, auth: `Bearer ${TOKEN}1` });
  });

  it('mints a new token for each request', async () => {
    const net = fakeNet((_m, _p, body) => ({ status: 200, json: { results: (body as unknown[]).map(() => ({ status: 'stored' })) } }));
    const post = tokenPost(SELF, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {} });
    await post([{ a: 1 }]);
    await post([{ a: 2 }]);
    const sent = net.calls.filter((c) => c.path === '/v1/rows').map((c) => c.auth);
    expect(sent).toEqual([`Bearer ${TOKEN}1`, `Bearer ${TOKEN}2`]);
  });

  it('never prints or writes the token: the only line holding it is the runner\'s own mask command', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const log = console.log;
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    try {
      const net = fakeNet(() => ({ status: 404, json: { error: 'not-registered' } }));
      await ensureRegistered(SELF, { env: RUNNER_ENV, fetchImpl: net.fetchImpl });
      await eraseSelf(SELF, { env: RUNNER_ENV, fetchImpl: net.fetchImpl });
    } finally {
      process.stdout.write = write;
      console.log = log;
    }
    const holding = out.join('').split('\n').filter((l) => l.includes(TOKEN));
    expect(holding.length).toBeGreaterThan(0);
    for (const l of holding) expect(l).toMatch(new RegExp(`^::add-mask::${TOKEN}\\d+$`));
  });

  it('a job without id-token: write says so, and sends nothing', async () => {
    const net = fakeNet(() => ({ status: 200, json: {} }));
    await expect(mintToken(SELF_AUDIENCE, { env: {}, fetchImpl: net.fetchImpl, mask: () => {} })).rejects.toThrow(/needs `id-token: write`/);
    expect(net.calls).toEqual([]);
  });
});

describe('registration is the first run (§3.2, §8)', () => {
  it('a 404 not-registered on the rows registers once, with an empty body, and sends the rows again', async () => {
    let registered = false;
    const net = fakeNet((m, p, body) => {
      if (p === '/v1/registrations') {
        registered = true;
        return { status: 201, json: { status: 'active', registered_at: '2026-10-14T00:00:00Z' } };
      }
      if (!registered) return { status: 404, json: { error: 'not-registered' } };
      return { status: 200, json: { results: (body as unknown[]).map(() => ({ status: 'stored' })) } };
    });
    const post = tokenPost(SELF, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {} });
    const res = await run(github([artifact(row(5 * MIN))]), { posts: [], post });
    expect(res).toMatchObject({ stored: 1, failures: [], refusal: null });
    expect(net.calls.filter((c) => c.path !== 'oidc').map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/rows', 'POST /v1/registrations', 'POST /v1/rows']);
    expect(net.calls.find((c) => c.path === '/v1/registrations')?.body).toEqual({});
  });

  it('a run with no row asks the registration\'s status, and registers on a 404', async () => {
    const net = fakeNet((m) => (m === 'GET' ? { status: 404, json: { error: 'not-registered' } } : { status: 201, json: { status: 'active' } }));
    expect(await ensureRegistered(SELF, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {} })).toEqual({ status: 'active' });
    expect(net.calls.filter((c) => c.path !== 'oidc').map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/registrations/self', 'POST /v1/registrations']);
  });
});

describe('a refusal stops the sweep, said in the store\'s codes (§3.2, §6, §7)', () => {
  it('403 suspended is red, and nothing more is sent', async () => {
    const s = store(() => ({ status: 403, json: { error: 'suspended' } }));
    const res = await run(github(Array.from({ length: 30 }, (_, i) => artifact(row(i * MIN)))), s);
    expect(s.posts.length).toBe(1);
    expect(res.refusal).toMatchObject({ status: 403, code: 'suspended', red: true });
    expect(res.failures).toEqual([]);
  });

  it('410 erased is green, with words saying how to come back', () => {
    expect(refusalOf(410, { error: 'erased' })).toMatchObject({ red: false, words: expect.stringContaining('register: yes') });
    expect(refusalOf(409, { error: 'erasing' })).toMatchObject({ red: false });
  });

  it('429 names the limit and when it resets, never another value', () => {
    expect(refusalOf(429, { error: 'quota', limit: 'rows_per_day', resets_at: '2026-10-15T00:00:00Z' })).toMatchObject({ red: true, words: expect.stringContaining('past rows_per_day, which resets at 2026-10-15T00:00:00Z') });
    expect(refusalOf(429, { error: 'quota', limit: '<script>', resets_at: 'soon' }, '120')?.words).toContain('past a limit, which resets at in 120 s');
  });

  it('another 403, a token check, is red too; a 401 or a 5xx is an ordinary failure', () => {
    expect(refusalOf(403, { error: 'workflow' })).toMatchObject({ red: true, code: 'workflow' });
    expect(refusalOf(401, { error: 'aud' })).toBeNull();
    expect(refusalOf(503, { error: 'jwks-unavailable' })).toBeNull();
  });
});

describe('erasure is one dispatch (§7)', () => {
  it('DELETE, then says whether the rows are gone yet', async () => {
    const net = fakeNet(() => ({ status: 202, json: { status: 'erased', erased_at: '2026-10-14T10:00:00Z', rows_erased: false } }));
    const r = await eraseSelf(SELF, { env: RUNNER_ENV, fetchImpl: net.fetchImpl, mask: () => {} });
    expect(net.calls.filter((c) => c.path !== 'oidc').map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /v1/registrations/self']);
    expect(r.lines.join(' ')).toMatch(/erased as of 2026-10-14T10:00:00Z.*being deleted/);
    const done = fakeNet(() => ({ status: 200, json: { status: 'erased', erased_at: '2026-10-14T10:00:00Z', rows_erased: true } }));
    expect((await eraseSelf(SELF, { env: RUNNER_ENV, fetchImpl: done.fetchImpl, mask: () => {} })).lines.join(' ')).toMatch(/rows are deleted/);
  });

  it('a repository never registered has nothing to erase; a suspended one is refused, red', async () => {
    const none = fakeNet(() => ({ status: 404, json: { error: 'not-registered' } }));
    expect((await eraseSelf(SELF, { env: RUNNER_ENV, fetchImpl: none.fetchImpl, mask: () => {} })).lines[0]).toMatch(/not registered/);
    const suspended = fakeNet(() => ({ status: 403, json: { error: 'suspended' } }));
    expect((await eraseSelf(SELF, { env: RUNNER_ENV, fetchImpl: suspended.fetchImpl, mask: () => {} })).refusal).toMatchObject({ red: true, code: 'suspended' });
  });
});
