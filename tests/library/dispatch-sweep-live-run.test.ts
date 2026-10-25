import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeStub } from '../unit/helpers/stub-bin.js';
import { SPAWNS } from '../unit/helpers/spawns.js';
import { asAgent } from './helpers/sign.js';
import { ROOT } from './helpers/adopter.js';
import {
  agentLogin, LANES, LIVE_RUN_STATUSES, MARKER, classify, laneTag, liveRunsByIssue, makeLiveRunsReader, renderReport,
} from '../../scripts/dispatch-sweep.mjs';

const AGENT_LOGIN = agentLogin();

/**
 * kanon#1410: the sweep never re-dispatches an issue whose lane run is still queued or in
 * progress, and never reads it as `never-ran`.
 *
 * On 2026-10-25 #1355 and #1353 were labelled `agent:implement` at 06:12:18Z, their runs started
 * at once, and a sweep at 06:26:27Z read both as `never-ran` — the Implementer had not commented
 * yet, and its cost row is written only at the end of a run — and re-dispatched them. Each second
 * run pushed onto the first's branch, which left both pull requests with heads no lane would stamp.
 */

const [implement, triage] = LANES;
const SWEPT = Date.parse('2026-10-25T06:26:27Z');
const issue = { number: 1355, title: 'Add the release view', labels: [{ name: 'agent:implement' }] };
const other = { number: 1353, title: 'Add the lane-health view', labels: [{ name: 'agent:implement' }] };

type Run = Record<string, unknown>;
/** A run as `GET /repos/{repo}/actions/runs` lists it (tests/fixtures/gh/run-list-live.json). */
const run = (over: Run = {}): Run => ({
  id: 40168273113,
  name: 'Implement',
  event: 'issues',
  status: 'in_progress',
  conclusion: null,
  display_title: issue.title,
  created_at: '2026-10-25T06:12:21Z',
  referenced_workflows: [
    { path: `example-org/kanon/.github/workflows/${implement.workflow}@v0.42.0` },
    { path: 'example-org/kanon/.github/workflows/agent-lane.yml@0123abc' },
  ],
  ...over,
});
const live = (runs: Run[], issues = [issue, other], lane = implement, opts: Record<string, unknown> = {}) =>
  liveRunsByIssue(runs, issues, lane, { now: SWEPT, ...opts });

describe('a lane run still queued or in progress is matched to its issue', () => {
  it('by the lane workflow it calls and the issue title it was started with', () => {
    const m = live([run()]);
    expect([...m.keys()]).toEqual([1355]);
    expect(m.get(1355)).toMatchObject({ id: 40168273113, status: 'in_progress', at: Date.parse('2026-10-25T06:12:21Z') });
  });

  it('over the recorded run list: this issue\'s own Implement run, in the implement lane only', () => {
    const page = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/gh/run-list-live.json'), 'utf8'));
    const mine = page.workflow_runs.find((r: Run) => r.name === 'Implement');
    const it1410 = { number: 1410, title: String(mine.display_title) };
    const at = { now: Date.parse(mine.created_at) + 15 * 60_000 };
    expect(liveRunsByIssue(page.workflow_runs, [it1410], implement, at).get(1410)).toMatchObject({ id: mine.id, status: 'in_progress' });
    expect(liveRunsByIssue(page.workflow_runs, [it1410], triage, at).size).toBe(0);
  });

  it('every status GitHub gives a run that has not completed is live', () => {
    expect([...LIVE_RUN_STATUSES].sort()).toEqual(['in_progress', 'pending', 'queued', 'requested', 'waiting']);
    for (const status of LIVE_RUN_STATUSES) expect(live([run({ status })]).has(1355), status).toBe(true);
    expect(live([run({ status: 'completed', conclusion: 'success' })]).size).toBe(0);
  });

  it('a run of the other lane, of no lane, or with another title is not this issue\'s', () => {
    const triageRun = run({ referenced_workflows: [{ path: `example-org/kanon/.github/workflows/${triage.workflow}@v0.42.0` }] });
    expect(live([triageRun]).size).toBe(0);
    expect(live([triageRun], [issue], triage).has(1355)).toBe(true);
    expect(live([run({ referenced_workflows: [] })]).size).toBe(0);
    expect(live([run({ referenced_workflows: undefined })]).size).toBe(0);
    // A lane file whose name only ends the same way is another workflow.
    expect(live([run({ referenced_workflows: [{ path: `o/r/.github/workflows/x-${implement.workflow}@v1` }] })]).size).toBe(0);
    expect(live([run({ display_title: 'Add the release view, again' })]).size).toBe(0);
    expect(live([run({ display_title: other.title })]).has(1353)).toBe(true);
  });

  it('a dispatched run is not attributed: its title is the workflow\'s, not the issue\'s', () => {
    expect(live([run({ event: 'workflow_dispatch', display_title: issue.title })]).size).toBe(0);
  });

  it('a run left unfinished for longer than any run lasts is not believed, nor one with no stamp', () => {
    expect(live([run({ created_at: '2026-10-24T18:26:28Z' })], [issue], implement, { hours: 12 }).has(1355)).toBe(true);
    expect(live([run({ created_at: '2026-10-24T18:26:26Z' })], [issue], implement, { hours: 12 }).size).toBe(0);
    expect(live([run({ created_at: '2026-10-24T18:26:26Z' })], [issue], implement, { hours: 24 }).has(1355)).toBe(true);
    expect(live([run({ created_at: null })]).size).toBe(0);
    expect(live([run({ created_at: 'yesterday' })]).size).toBe(0);
  });

  it('the newest live run is the one kept, and no runs or no read is an empty map', () => {
    const m = live([run({ id: 1, created_at: '2026-10-25T06:12:21Z' }), run({ id: 2, status: 'pending', created_at: '2026-10-25T06:20:00Z' })]);
    expect(m.get(1355)).toMatchObject({ id: 2, status: 'pending' });
    expect(live([]).size).toBe(0);
    expect(liveRunsByIssue(null, [issue], implement, { now: SWEPT }).size).toBe(0);
  });
});

describe('an issue with a live run reads `running`, never `never-ran`, and is not dispatched', () => {
  const at = (iso: string) => Date.parse(iso);
  const liveRun = { id: 40168273113, status: 'in_progress', at: at('2026-10-25T06:12:21Z') };
  const sweepComment = (iso: string) => ({ login: 'example-lead', createdAt: iso, body: `${MARKER}\n${laneTag(implement)}\nRe-dispatching` });
  const agent = (iso: string) => ({ login: AGENT_LOGIN, createdAt: iso, body: asAgent(AGENT_LOGIN, 'Plan: building it.') });
  const human = (iso: string) => ({ login: 'maintainer', createdAt: iso, body: 'Go ahead.' });

  it('#1355 as the sweep met it: labelled 14 minutes before, no comment yet, the run in progress', () => {
    expect(classify(issue, [], false, { now: SWEPT, lane: implement })).toMatchObject({ state: 'never-ran', act: 'dispatch' });
    const v = classify(issue, [], false, { now: SWEPT, lane: implement, liveRun });
    expect(v.state).toBe('running');
    expect(v.act).toBeNull();
    expect(v.liveRun).toEqual(liveRun);
  });

  it('end to end from the run list, for both issues of 2026-10-25', () => {
    const m = live([run(), run({ id: 40168269966, display_title: other.title, created_at: '2026-10-25T06:12:20Z' })]);
    for (const i of [issue, other]) {
      const v = classify(i, [], false, { now: SWEPT, lane: implement, liveRun: m.get(i.number) ?? null });
      expect(v.state, `#${i.number}`).toBe('running');
      expect(v.act, `#${i.number}`).toBeNull();
    }
  });

  it('it outranks the other dispatching states, `answered` and `ran-empty`', () => {
    const answered = [agent('2026-10-24T10:00:00Z'), human('2026-10-25T06:00:00Z')];
    expect(classify(issue, answered, false, { now: SWEPT, lane: implement }).state).toBe('answered');
    expect(classify(issue, answered, false, { now: SWEPT, lane: implement, liveRun })).toMatchObject({ state: 'running', act: null });
    const spoke = [agent('2026-10-20T10:00:00Z')];
    const empty = { now: SWEPT, lane: implement, emptyAt: at('2026-10-25T05:00:00Z') };
    expect(classify(issue, spoke, false, empty).state).toBe('ran-empty');
    expect(classify(issue, spoke, false, { ...empty, liveRun }).state).toBe('running');
  });

  it('and the conversation\'s waiting states: the agent is working, not waiting on a person', () => {
    expect(classify(issue, [agent('2026-10-20T10:00:00Z')], false, { now: SWEPT, lane: implement }).state).toBe('awaiting-human');
    expect(classify(issue, [agent('2026-10-20T10:00:00Z')], false, { now: SWEPT, lane: implement, liveRun }).state).toBe('running');
  });

  it('it is not stopped as `too-big` or `exhausted` mid-run', () => {
    const capped = { now: SWEPT, lane: implement, exhaustedAt: at('2026-10-25T05:00:00Z'), labeledAt: at('2026-10-25T04:00:00Z') };
    expect(classify(issue, [], false, capped).state).toBe('too-big');
    expect(classify(issue, [], false, { ...capped, liveRun })).toMatchObject({ state: 'running', act: null });
    const spent = [sweepComment('2026-10-20T00:00:00Z'), sweepComment('2026-10-22T00:00:00Z')];
    expect(classify(issue, spent, false, { now: SWEPT, lane: implement })).toMatchObject({ state: 'exhausted', act: 'stop' });
    expect(classify(issue, spent, false, { now: SWEPT, lane: implement, liveRun })).toMatchObject({ state: 'running', act: null });
  });

  it('a pull request, a person\'s hold and a park still own the issue', () => {
    expect(classify(issue, [], true, { now: SWEPT, lane: implement, liveRun }).state).toBe('has-pr');
    const held = [sweepComment('2026-10-24T00:00:00Z'), human('2026-10-24T01:00:00Z')];
    expect(classify(issue, held, false, { now: SWEPT, lane: implement, liveRun }).state).toBe('human-held');
    const parked = { ...issue, labels: [...issue.labels, { name: 'qa:needs-info' }] };
    expect(classify(parked, [], false, { now: SWEPT, lane: implement, liveRun }).state).toBe('parked');
  });

  it('without a live run nothing changes, which is what an unread run list gives', () => {
    expect(classify(issue, [], false, { now: SWEPT, lane: implement, liveRun: null }).state).toBe('never-ran');
  });

  it('the report names `running` and the run, apart from `never-ran`', () => {
    const { text } = renderReport([classify(issue, [], false, { now: SWEPT, lane: implement, liveRun })], { apply: false });
    expect(text).toContain('| `running` (run 40168273113, in_progress) | — |');
    expect(text).toContain('**1 running**');
    expect(text).not.toContain('never-ran');
  });
});

describe('the run list is read once, every live status, from issue-fired runs', () => {
  it('asks for each status with `event=issues`, every page, and joins them', () => {
    const asked: string[][] = [];
    const read = makeLiveRunsReader({
      json: (args: string[]) => {
        asked.push(args);
        const status = /status=([a-z_]+)/.exec(args.at(-1) ?? '')?.[1];
        return status === 'in_progress' ? [{ workflow_runs: [run({ id: 1 })] }, { workflow_runs: [run({ id: 2 })] }]
          : status === 'pending' ? [{ workflow_runs: [run({ id: 3, status: 'pending' })] }] : [{ total_count: 0, workflow_runs: [] }];
      },
    });
    expect(read()?.map((r) => r.id)).toEqual([3, 1, 2]);
    expect(asked).toHaveLength(LIVE_RUN_STATUSES.length);
    for (const a of asked) {
      expect(a.slice(0, 3)).toEqual(['api', '--paginate', '--slurp']);
      expect(a.at(-1)).toMatch(/^repos\/[^/]+\/[^/]+\/actions\/runs\?status=[a-z_]+&event=issues&per_page=100$/);
    }
  });

  it('a failed read is null, never an empty list: the caller says it could not see the runs', () => {
    const read = makeLiveRunsReader({ json: () => { throw new Error('HTTP 403'); } });
    expect(read()).toBeNull();
  });
});

// Its cases run the sweep end to end, against a stub `gh` on PATH, so the block takes the spawn budget (#436).
describe('the sweep, run end to end, holds an issue whose run is going', SPAWNS, () => {
  let bin: string;
  let summary: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'sweep-live-'));
    summary = join(bin, 'summary.md');
    writeFileSync(summary, '');
  });
  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  const ISSUE = JSON.stringify([{ number: 7, title: 'Add the release view', createdAt: '2026-10-25T06:00:00Z', labels: [{ name: 'agent:implement' }], body: '' }]);
  /** `gh` answering the sweep's reads; `runs` is the in-progress page of `actions/runs`, or a failure. */
  const sweep = (runs: string | null) => {
    const live = runs === null ? 'echo "HTTP 403" >&2; exit 1' : `case "$*" in *status=in_progress*) echo '[${runs}]';; *) echo '[{"total_count":0,"workflow_runs":[]}]';; esac`;
    writeStub(join(bin, 'gh'), `#!/usr/bin/env bash\n${[
      'case "$1 $2" in',
      `  "issue list") case "$*" in *agent:implement*) echo '${ISSUE}';; *) echo '[]';; esac;;`,
      '  "pr list") echo \'[]\';;',
      '  "issue view") echo \'{"comments":[]}\';;',
      `  "api --paginate") ${live};;`,
      '  *) echo "unexpected: gh $*" >&2; exit 1;;',
      'esac',
    ].join('\n')}\n`);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QA_|APPLY$|GITHUB_STEP_SUMMARY$)/.test(k)));
    const out = execFileSync('node', [join(ROOT, 'scripts/dispatch-sweep.mjs')], {
      encoding: 'utf8',
      env: { ...clean, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'example-org/example-repo', GITHUB_STEP_SUMMARY: summary, QA_STORE_RESULT: 'failure' },
    });
    return { out, summary: readFileSync(summary, 'utf8') };
  };
  const page = (title: string) => JSON.stringify({ total_count: 1, workflow_runs: [run({ id: 99, display_title: title, created_at: new Date(Date.now() - 14 * 60_000).toISOString().slice(0, 19) + 'Z' })] });

  it('a live run of the issue reads `running` and dispatches nothing', () => {
    const r = sweep(page('Add the release view'));
    expect(r.summary).toContain('| `running` (run 99, in_progress) | — |');
    expect(r.summary).not.toContain('never-ran');
    expect(r.out).not.toMatch(/queued and in-progress runs/);
  });

  it('MUTATION: the same sweep with no live run of the issue reads `never-ran`, as it did on 2026-10-25', () => {
    const r = sweep(page('Another issue'));
    expect(r.summary).toContain('| `never-ran` | dispatch |');
  });

  it('a failed read of the runs is said, on the run and in the summary, and classifies as before', () => {
    const r = sweep(null);
    expect(r.out).toContain('::warning title=qa-dispatch-sweep::Could not read the queued and in-progress runs');
    expect(r.summary).toContain('Could not read the queued and in-progress runs');
    expect(r.summary).toContain('| `never-ran` | dispatch |');
  });
});
