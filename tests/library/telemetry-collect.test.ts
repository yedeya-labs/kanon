import { describe, expect, it } from 'vitest';
import { MAX_ROWS as FUNCTION_MAX_ROWS } from '../../infra/telemetry/function/index.mjs';
import {
  COLLECT_JOB,
  COLLECT_JOB_OVERRIDE,
  MAX_ROWS,
  SWEEP_CAP_DAYS,
  WINDOW_MINUTES,
  codesOnly,
  collect,
  lastSuccessfulSweep,
  regionOf,
  sweepSince,
  underLevel,
  workflowFileOf,
} from '../../scripts/telemetry-collect.mjs';
import { ARTIFACT_FILE, FINDING_ARTIFACT_FILE, findingArtifactName } from '../../scripts/lib/telemetry-artifacts.mjs';
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

  it('returns null when no sweep collected', () => {
    const gh = runs([{ id: 8, created_at: 'x', jobs: [{ name: `collect / ${COLLECT_JOB}`, conclusion: 'skipped' }] }]);
    expect(lastSuccessfulSweep({ api: gh.api, repo: REPO, file: 'telemetry.yml', branch: 'main', selfRunId: '1' })).toBeNull();
  });
});

describe('the function URL names its region', () => {
  it('reads it from the host', () => {
    expect(regionOf('https://abc123.lambda-url.eu-central-1.on.aws/')).toBe('eu-central-1');
    expect(regionOf('https://example.com/')).toBeNull();
    expect(regionOf('not a url')).toBeNull();
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
    const refused = await run(github([artifact(row(5 * MIN))]), store(() => ({ status: 403, json: { error: 'caller' } })));
    expect(refused.failures).toEqual(['rows 1-1: the store answered 403 (caller)']);
    const notJson = await run(github([artifact(row(5 * MIN))]), store(() => ({ status: 403, json: null })));
    expect(notJson.failures).toEqual(['rows 1-1: the store answered 403']);
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
