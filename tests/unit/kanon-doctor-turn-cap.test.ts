import { describe, expect, it, vi } from 'vitest';
import { EXIT, FINDINGS, TURN_CAP, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { ARTIFACT_FILE } from '../../scripts/lib/telemetry-artifacts.mjs';
import { zipOf } from '../library/helpers/zip.js';
import { checkout, clone, fakeGitHub, healthyFiles, ids, NEXT, REPO, REQ, run, type FakeArtifact, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon doctor` on a lane whose runs keep ending at their turn limit (#1004, the fourth
 * acceptance criterion of #891): it reads each installed lane's version-2 run rows from the
 * repository's own `kanon-telemetry-*` artifacts, and reports a lane whose recent runs keep ending
 * with `terminal_reason: max_turns`, with the turns each run took against the lane's limit and
 * its ceiling (`requirements.json`'s `turns`), so an adopter can tell "raise `max_turns`" from
 * "split the work" without reading the rows by hand. The fixtures are helpers/doctor.ts's: the
 * healthy installation calls the review and code-audit lanes.
 */
vi.setConfig({ testTimeout: SPAWNS.timeout });

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const OWN = 4242;
const FORK = 9999;
const CALLER = '.github/workflows/agent-review.yml';
const LIMIT = REQ.lanes['agent-review']!.turns!.default;
const CEILING = REQ.lanes['agent-review']!.turns!.ceiling;

type Run = { id: number; daysAgo?: number; turns?: number | null; cap?: number; reason?: string | null; lane?: string; fork?: boolean; zip?: Buffer | null; tag?: string; over?: Record<string, unknown> };

/** A lane's run row, as `agent-telemetry` writes it: the limit that bound it, the turns taken, how it ended. */
const row = (r: Run) => {
  const lane = r.lane ?? 'review';
  const cap = r.cap ?? LIMIT;
  const turns = r.turns === undefined ? cap : r.turns;
  const reason = r.reason === undefined ? (turns !== null && turns >= cap ? 'max_turns' : 'completed') : r.reason;
  return {
    schema_version: 2, row_kind: 'run', tag: r.tag ?? 'run', recorded_at: new Date(NOW - (r.daysAgo ?? 1) * DAY).toISOString(),
    run_id: r.id, run_attempt: 1, role: lane === 'review' ? 'reviewer' : 'explorer', lane, outcome: reason === 'max_turns' ? 'exhausted' : 'ok',
    terminal_reason: reason, max_turns: cap, num_turns: turns, ...r.over,
  };
};

/** The artifact a run uploads its row as, listed newest first by the fake. */
const artifact = (r: Run): FakeArtifact => {
  const created = NOW - (r.daysAgo ?? 1) * DAY + 5_000;
  return {
    id: r.id * 10,
    name: `kanon-telemetry-${r.lane ?? 'review'}-${r.id}-1`,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + 90 * DAY).toISOString(),
    workflow_run: { id: r.id, repository_id: OWN, head_repository_id: r.fork ? FORK : OWN },
    zip: r.zip === undefined ? zipOf(ARTIFACT_FILE, JSON.stringify(row(r))) : r.zip,
  };
};

const github = (runs: Run[]) => {
  const g = fakeGitHub();
  g.st.artifacts = runs.map(artifact).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return g;
};

/** `n` artifacts other jobs uploaded, such as CI's coverage, created evenly from `fromDays` to `toDays` ago, newest first. */
const filler = (n: number, fromDays: number, toDays: number): FakeArtifact[] =>
  Array.from({ length: n }, (_, i) => {
    const created = NOW - (fromDays + ((toDays - fromDays) * i) / n) * DAY;
    return {
      id: 100_000 + i, name: `coverage-${i}`, created_at: new Date(created).toISOString(), expires_at: new Date(created + 90 * DAY).toISOString(),
      workflow_run: { id: 50_000 + i, repository_id: OWN, head_repository_id: OWN }, zip: null,
    };
  });
const byDate = (xs: FakeArtifact[]) => xs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
/** The pages of the artifact listing doctor read. */
const listings = (g: ReturnType<typeof github>) => g.calls.filter((c) => /\/actions\/artifacts\?per_page=100&page=\d+$/.test(c[1] ?? '')).length;

const check = (runs: Run[],g = github(runs), argv: string[] = []) => run(checkout(healthyFiles()), g, ['--json', ...argv], NOW);
const finding = (r: Result) => r.json.findings.find((f: { id: string }) => f.id === 'lane.turn-cap');
const turnUnchecked = (r: Result) => r.json.unchecked.filter((u: { check: string }) => u.check === 'turn-cap-runs');

describe('kanon doctor on a lane whose runs keep ending at its turn limit (#1004)', () => {
  it('finds nothing on a healthy installation whose lanes have no telemetry artifacts (the mutations\' baseline)', async () => {
    const r = await check([]);
    expect(ids(r)).toEqual([]);
    expect(turnUnchecked(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
  });

  it('reports the caller of a lane whose runs keep ending at max_turns, as a note that never blocks', async () => {
    const r = await check([{ id: 905 }, { id: 904 }, { id: 903, turns: 12 }, { id: 902 }, { id: 901, turns: 33 }]);
    expect(ids(r)).toEqual([`lane.turn-cap ${CALLER}`]);
    const f = finding(r);
    expect(f.blocking).toBe(false);
    expect(FINDINGS['lane.turn-cap']).toEqual({ category: 'caller', blocking: false });
    expect(r.status).toBe(EXIT.healthy);
    expect(f.message).toContain('3 of its 5 runs that reached the model in the last 14 days ended at the turn limit (`terminal_reason: max_turns`)');
  });

  it('shows the lane\'s turn distribution, newest first, against its limit and its ceiling from the checked release\'s requirements', async () => {
    const r = await check([{ id: 905 }, { id: 904 }, { id: 903, turns: 12 }, { id: 901, turns: 33 }]);
    const f = finding(r);
    expect(f.message).toContain(`Turns taken, newest first: ${LIMIT} of ${LIMIT} (run 905, at the limit), ${LIMIT} of ${LIMIT} (run 904, at the limit), 12 of ${LIMIT} (run 903), 33 of ${LIMIT} (run 901)`);
    expect(f.message).toContain(`median ${(33 + LIMIT) / 2}, most ${LIMIT}`);
    expect(f.message).toContain(`The lane's limit is ${LIMIT} turns, and its ceiling for one dispatched run ${CEILING}`);
    // The numbers come from the checked release's requirements, not from the code: --to NEXT reads NEXT's.
    const next = clone(REQ);
    next.lanes['agent-review']!.turns = { default: 75, ceiling: 150 };
    const g = github([{ id: 905 }, { id: 904 }]);
    g.st.releases[NEXT] = next;
    const moved = finding(await check([], g, ['--to', NEXT]));
    expect(moved.message).toContain("The lane's limit is 75 turns, and its ceiling for one dispatched run 150");
  });

  it('marks a run raised for one dispatch, and says the work wants splitting when a run raised to the ceiling still ended there', async () => {
    const raised = await check([{ id: 905 }, { id: 904, cap: 100 }, { id: 903, turns: 20 }]);
    expect(finding(raised).message).toContain(`100 of 100 (run 904, raised, at the limit)`);
    expect(finding(raised).message).not.toContain('wants splitting');
    const atCeiling = await check([{ id: 905 }, { id: 904, cap: CEILING }, { id: 903, turns: 20 }]);
    expect(finding(atCeiling).message).toContain(`${CEILING} of ${CEILING} (run 904, raised, at the limit)`);
    expect(finding(atCeiling).message).toContain(`. Run 904 was raised to the ceiling, ${CEILING}, and still ended at it: this work wants splitting`);
  });

  it('gives the split-or-raise fix, naming docs/lanes.md and each run that ended at the limit', async () => {
    const f = finding(await check([{ id: 905 }, { id: 904 }, { id: 903, turns: 12 }]));
    expect(f.fix.text).toContain('docs/lanes.md, "The turn budget"');
    expect(f.fix.text).toMatch(/split it into parts each finishable in one run/);
    expect(f.fix.text).toContain(`max_turns at most ${CEILING} and a reason`);
    expect(f.fix.text).toMatch(/plain re-run fails the same way/);
    expect(f.fix.commands).toEqual([`gh run view 905 -R ${REPO}`, `gh run view 904 -R ${REPO}`]);
  });

  it('needs at least two such runs: one run at the limit is not "keep ending"', async () => {
    expect(TURN_CAP).toEqual({ runs: 2, share: 0.25, days: 14, perLane: 20, maxPages: 50, downloads: 8 });
    expect(finding(await check([{ id: 905 }, { id: 904, turns: 10 }]))).toBeUndefined();
  });

  it('needs them to be at least a quarter of the runs that reached the model, so a busy lane\'s rare cap is quiet', async () => {
    const busy = (hits: number) => Array.from({ length: 12 }, (_, i) => ({ id: 900 - i, turns: i < hits ? LIMIT : 10 }));
    expect(finding(await check(busy(2)))).toBeUndefined();
    expect(finding(await check(busy(3)))).toBeDefined();
    // A run that never reached the model ended with no terminal reason, and counts on neither side.
    const unreached = Array.from({ length: 10 }, (_, i) => ({ id: 800 - i, turns: null, reason: null }));
    expect(finding(await check([{ id: 905 }, { id: 904 }, ...Array.from({ length: 6 }, (_, i) => ({ id: 903 - i, turns: 10 })), ...unreached]))).toBeDefined();
  });

  it('reads the row\'s terminal reason, never the turns against the limit: a run that finished at its last turn did not hit the cap', async () => {
    expect(finding(await check([{ id: 905, reason: 'completed' }, { id: 904, reason: 'completed' }]))).toBeUndefined();
    expect(finding(await check([{ id: 905, reason: 'budget_exhausted', turns: 40 }, { id: 904, reason: 'budget_exhausted', turns: 41 }]))).toBeUndefined();
  });

  it('reads only the last 14 days, and at most the newest 20 runs of each lane', async () => {
    expect(finding(await check([{ id: 905, daysAgo: 15 }, { id: 904, daysAgo: 16 }, { id: 903, turns: 10 }]))).toBeUndefined();
    const g = github([...Array.from({ length: 20 }, (_, i) => ({ id: 950 - i, turns: 10 })), { id: 905, daysAgo: 5 }, { id: 904, daysAgo: 5 }, { id: 903, daysAgo: 5 }]);
    expect(finding(await check([], g))).toBeUndefined();
    expect(g.calls.filter((c) => /\/actions\/artifacts\/\d+\/zip$/.test(c[1] ?? '')).length).toBe(20);
  });

  it('reads each installed lane on its own, and no lane the repository does not call', async () => {
    const audit = (id: number, turns = REQ.lanes['agent-code-audit']!.turns!.default) => ({ id, lane: 'code-audit', turns, cap: REQ.lanes['agent-code-audit']!.turns!.default });
    const r = await check([audit(705), audit(704), { id: 905, turns: 10 }, { id: 904, turns: 10 }, { id: 903, turns: 10 }]);
    expect(ids(r)).toEqual(['lane.turn-cap .github/workflows/agent-code-audit.yml']);
    // The triage lane has no caller here: its rows are never downloaded.
    const g = github([{ id: 605, lane: 'triage' }, { id: 604, lane: 'triage' }]);
    expect(ids(await check([], g))).toEqual([]);
    expect(g.calls.filter((c) => /\/zip$/.test(c[1] ?? ''))).toEqual([]);
  });

  it('counts only this repository\'s own runs: a fork\'s artifact is neither read nor counted', async () => {
    const g = github([{ id: 905, fork: true }, { id: 904, fork: true }, { id: 903, turns: 10 }]);
    expect(finding(await check([], g))).toBeUndefined();
    expect(g.calls.filter((c) => /\/zip$/.test(c[1] ?? '')).map((c) => c[1])).toEqual([`repos/${REPO}/actions/artifacts/9030/zip`]);
  });

  it('skips a smoke or test row, and a row whose lane, run or attempt is not its artifact\'s', async () => {
    expect(finding(await check([{ id: 905, tag: 'smoke' }, { id: 904, tag: 'test' }, { id: 903, turns: 10 }]))).toBeUndefined();
    const mismatched = await check([{ id: 905, over: { run_id: 906 } }, { id: 904, over: { lane: 'triage' } }, { id: 903, over: { run_attempt: 2 } }, { id: 902, over: { num_turns: 'many' } }]);
    expect(finding(mismatched)).toBeUndefined();
    expect(turnUnchecked(mismatched)).toEqual([{ check: 'turn-cap-runs', subject: CALLER, reason: expect.stringContaining('4 of its 4 telemetry artifacts in the window could not be read') }]);
  });

  it('on a busy repository, stops listing once every lane it reads holds its newest 20 runs', async () => {
    const review = Array.from({ length: 20 }, (_, i) => ({ id: 900 - i, daysAgo: 0.05 + i * 0.01, turns: i < 6 ? LIMIT : 10 }));
    const auditCap = REQ.lanes['agent-code-audit']!.turns!.default;
    const audit = Array.from({ length: 20 }, (_, i) => ({ id: 700 - i, lane: 'code-audit', daysAgo: 0.05 + i * 0.01, turns: 10, cap: auditCap }));
    const g = github([...review, ...audit]);
    // Thousands of artifacts other jobs uploaded across the window, as Kanon's own CI does.
    g.st.artifacts = byDate([...g.st.artifacts, ...filler(6000, 0, 13)]);
    const r = await check([], g);
    expect(ids(r)).toEqual([`lane.turn-cap ${CALLER}`]);
    expect(finding(r).message).toContain('6 of its 20 runs that reached the model in the last 14 days');
    expect(listings(g)).toBeLessThanOrEqual(3);
    expect(turnUnchecked(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
  });

  it('stops at its page cap short of the window and says what it read, a note and never unchecked', async () => {
    const recent = [{ id: 905, daysAgo: 0.001 }, { id: 904, daysAgo: 0.002 }, { id: 903, daysAgo: 0.003 }];
    // Past the cap: ten runs that finished, which would make 3 of 13 at the limit, under a quarter.
    const older = Array.from({ length: 10 }, (_, i) => ({ id: 800 - i, daysAgo: 5, turns: 10 }));
    const g = github([...recent, ...older]);
    g.st.artifacts = byDate([...g.st.artifacts, ...filler(TURN_CAP.maxPages * 100 + 500, 0.01, 1)]);
    const r = await check([], g);
    expect(listings(g)).toBe(TURN_CAP.maxPages);
    expect(turnUnchecked(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`lane.turn-cap ${CALLER}`]);
    expect(finding(r).message).toMatch(/3 of its 3 runs that reached the model since 2026-10-1\d \d\d:\d\d UTC, where the artifact listing's cap stopped, ended at the turn limit/);
    const note = r.json.notes.find((n: string) => n.includes('`lane.turn-cap`'));
    expect(note).toMatch(/reached its 50-page cap at artifacts from 2026-10-1\d \d\d:\d\d UTC, before the 14-day window's start/);
    expect(note).toContain(`read .github/workflows/agent-code-audit.yml, ${CALLER} over their runs since then, fewer than the newest 20`);
  });

  it(`downloads the artifacts ${TURN_CAP.downloads} at a time, never one by one, and still lists the turns newest first`, async () => {
    const g = github(Array.from({ length: 20 }, (_, i) => ({ id: 900 - i, turns: i < 6 ? LIMIT : 10 + i })));
    const download = g.download;
    let flying = 0;
    let most = 0;
    g.download = async (repo: string, id: number) => {
      most = Math.max(most, (flying += 1));
      await new Promise((done) => setTimeout(done, 5));
      flying -= 1;
      return download(repo, id);
    };
    const r = await check([], g);
    expect(most).toBe(TURN_CAP.downloads);
    expect(finding(r).message).toContain(`, 16 of ${LIMIT} (run 894), 17 of ${LIMIT} (run 893), `);
  });

  it('is unchecked, never a finding, when the token can\'t list the artifacts', async () => {
    const g = github([{ id: 905 }, { id: 904 }]);
    g.st.artifactsRefused = 'gh: Resource not accessible by personal access token (HTTP 403)';
    const r = await check([], g);
    expect(finding(r)).toBeUndefined();
    expect(turnUnchecked(r)).toEqual([{ check: 'turn-cap-runs', subject: REPO, reason: expect.stringMatching(/can't list the repository's artifacts .*HTTP 403.*Actions: read/) }]);
    expect(r.status).toBe(EXIT.incomplete);
  });

  it('is unchecked for the lane whose artifact it can\'t download or read, and still reports what it read', async () => {
    const r = await check([{ id: 906, zip: null }, { id: 905 }, { id: 904 }, { id: 903, zip: Buffer.from('not a zip') }]);
    expect(ids(r)).toEqual([`lane.turn-cap ${CALLER}`]);
    expect(turnUnchecked(r)).toEqual([{ check: 'turn-cap-runs', subject: CALLER, reason: expect.stringContaining('2 of its 4 telemetry artifacts in the window could not be read') }]);
    expect(r.status).toBe(EXIT.incomplete);
  });

  it('asks nothing against a release whose requirements give no lane a turn limit', async () => {
    const old = clone(REQ);
    for (const l of Object.values(old.lanes)) delete (l as { turns?: unknown }).turns;
    const g = github([{ id: 905 }, { id: 904 }]);
    g.st.releases[NEXT] = old;
    const r = await check([], g, ['--to', NEXT]);
    expect(finding(r)).toBeUndefined();
    expect(g.calls.some((c) => /actions\/artifacts/.test(c[1] ?? ''))).toBe(false);
  });

  it('can be waived for its caller, as any other note', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += `- **${WAIVER_LABEL}:** \`lane.turn-cap\` on \`${CALLER}\` (the review lane reads one large generated diff by design)\n`;
    const r = await run(checkout(files), github([{ id: 905 }, { id: 904 }]), ['--json'], NOW);
    expect(ids(r)).toEqual([]);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['lane.turn-cap']);
  });
});
