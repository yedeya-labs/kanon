import { asAgent } from './helpers/sign.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_LOGIN, LANES, MARKER, classify, exhaustedAtByIssue, latestRunByIssue, laneTag, makeRunJobsReader,
  renderReport, runLeftNothing,
} from '../../scripts/dispatch-sweep.mjs';

/**
 * kanon#254: an issue outside a project whose latest implement run ended green with nothing to
 * show (kanon#181) is re-dispatched by the sweep, within its attempt cap.
 *
 * Crash recovery leaves such an issue alone by the Owner's decision on kanon#252: no comment,
 * label kept. When the Implementer had commented on an EARLIER run, the conversation reads
 * `in-flight` and then `awaiting-human`, which the sweep never re-dispatched, so the issue
 * waited on a human for a question nobody asked.
 */

const [implement, triage] = LANES;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const RUN_AT = Date.parse('2026-10-04T10:00:00Z');
const agent = (at: string) => ({ login: AGENT_LOGIN, createdAt: at, body: asAgent(AGENT_LOGIN, 'Progress: half done, continuing next run.') });
const sweep = (at: string) => ({ login: 'example-lead', createdAt: at, body: `${MARKER}\n${laneTag(implement)}\nRe-dispatching` });
const issue = { number: 7, title: 't', labels: [{ name: 'agent:implement' }] };
const run = (comments: Array<{ login: string, createdAt: string, body: string }>, opts: Record<string, unknown> = {}) =>
  classify(issue, comments, false, { now: NOW, lane: implement, emptyAt: RUN_AT, ...opts });

describe('a latest run that left nothing lifts the conversation\'s waiting states', () => {
  it('`in-flight` (the agent spoke on an earlier run, recently) becomes `ran-empty` and dispatches', () => {
    expect(classify(issue, [agent('2026-10-03T12:00:00Z')], false, { now: NOW, lane: implement }).state).toBe('in-flight');
    const v = run([agent('2026-10-03T12:00:00Z')]);
    expect(v.state).toBe('ran-empty');
    expect(v.act).toBe('dispatch');
  });

  it('`awaiting-human` (the agent spoke long ago) becomes `ran-empty` too', () => {
    expect(classify(issue, [agent('2026-09-01T00:00:00Z')], false, { now: NOW, lane: implement }).state).toBe('awaiting-human');
    expect(run([agent('2026-09-01T00:00:00Z')]).state).toBe('ran-empty');
  });

  it('is bounded by the attempt cap: with the attempts spent it stops for a human', () => {
    const v = run([sweep('2026-09-01T00:00:00Z'), sweep('2026-09-10T00:00:00Z'), agent('2026-09-11T00:00:00Z')]);
    expect(v.state).toBe('exhausted');
    expect(v.act).toBe('stop');
  });

  it('and by the cooldown: a sweep dispatch inside it waits', () => {
    const v = run([agent('2026-09-01T00:00:00Z'), sweep('2026-10-04T00:00:00Z')]);
    expect(v.state).toBe('ran-empty');
    expect(v.act).toBeNull();
  });

  it('an implementer comment after the empty run keeps the conversation\'s reading', () => {
    expect(run([agent('2026-10-04T11:00:00Z')]).state).toBe('in-flight');
  });

  it('the trigger label applied after the empty run keeps it too — a re-run is under way', () => {
    expect(run([agent('2026-09-01T00:00:00Z')], { labeledAt: RUN_AT + 60_000 }).state).toBe('awaiting-human');
    expect(run([agent('2026-09-01T00:00:00Z')], { labeledAt: RUN_AT - 60_000 }).state).toBe('ran-empty');
  });

  it('states owned by a PR, a person or a park are untouched, and `never-ran` stays `never-ran`', () => {
    expect(classify(issue, [agent('2026-09-01T00:00:00Z')], true, { now: NOW, lane: implement, emptyAt: RUN_AT }).state).toBe('has-pr');
    const parked = { ...issue, labels: [{ name: 'agent:implement' }, { name: 'qa:needs-info' }] };
    expect(classify(parked, [agent('2026-09-01T00:00:00Z')], false, { now: NOW, lane: implement, emptyAt: RUN_AT }).state).toBe('parked');
    const held = [sweep('2026-09-01T00:00:00Z'), { login: 'maintainer', createdAt: '2026-09-02T00:00:00Z', body: 'Hold.' }];
    expect(run(held).state).toBe('human-held');
    expect(run([]).state).toBe('never-ran');
  });

  it('without an empty run nothing changes (the pre-#254 reading)', () => {
    expect(classify(issue, [agent('2026-09-01T00:00:00Z')], false, { now: NOW, lane: implement, emptyAt: null }).state).toBe('awaiting-human');
  });

  it('the report names `ran-empty`, apart from `in-flight`', () => {
    const { text } = renderReport([run([agent('2026-09-01T00:00:00Z')])], { apply: false });
    expect(text).toContain('`ran-empty`');
    expect(text).toContain('**1 ran-empty**');
  });
});

describe('runLeftNothing reads the lane\'s own verdict off the run\'s jobs', () => {
  const job = (name: string, conclusion: string | null, status = 'completed') => ({ name, status, conclusion });
  const empty = [job('implement / implement', 'success'), job('implement / empty-check', 'failure'), job('implement / crash-recovery', 'success')];

  it('a failed check whose recovery ran is a run that left nothing', () => {
    expect(runLeftNothing(empty, implement)).toBe(true);
    expect(runLeftNothing([job('empty-check', 'failure'), job('crash-recovery', 'failure')], implement)).toBe(true);
  });

  it('a failed check whose recovery was skipped is a check that broke, not an empty run', () => {
    expect(runLeftNothing([empty[0], empty[1], job('implement / crash-recovery', 'skipped')], implement)).toBe(false);
  });

  it('a recovery still running has not shown which way its condition went', () => {
    expect(runLeftNothing([empty[0], empty[1], job('implement / crash-recovery', null, 'in_progress')], implement)).toBe(false);
  });

  it('a passing check, a missing job, unreadable jobs or a lane with no check are not empty', () => {
    expect(runLeftNothing([empty[0], job('implement / empty-check', 'success'), empty[2]], implement)).toBe(false);
    expect(runLeftNothing([empty[0], empty[2]], implement)).toBe(false);
    expect(runLeftNothing([empty[0], empty[1]], implement)).toBe(false);
    expect(runLeftNothing(null, implement)).toBe(false);
    expect(runLeftNothing(empty, triage)).toBe(false);
  });

  it('a job whose name only ends in the key without the separator is not the check', () => {
    expect(runLeftNothing([job('not-empty-check', 'failure'), empty[2]], implement)).toBe(false);
  });
});

describe('the run read', () => {
  it('reads a run\'s jobs once per run, and an unreadable or unnumbered run is null', () => {
    const calls: string[][] = [];
    const read = makeRunJobsReader({ json: (args: string[]) => { calls.push(args); return { jobs: [{ name: 'x' }] }; } });
    expect(read('42')).toEqual([{ name: 'x' }]);
    expect(read(42)).toEqual([{ name: 'x' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.join(' ')).toMatch(/actions\/runs\/42\/jobs/);
    expect(read(null)).toBeNull();
    expect(makeRunJobsReader({ json: () => { throw new Error('403'); } })('43')).toBeNull();
  });

  it('the latest row per issue carries its run, and `exhaustedAtByIssue` reads the same latest row', () => {
    const rows = [
      { ts: '20261004T090000Z', issue_number: '7', outcome: 'exhausted', run_id: '1' },
      { ts: '20261004T100000Z', issue_number: '7', outcome: 'success', run_id: '2' },
      { ts: 'bad', issue_number: '7', outcome: 'exhausted', run_id: '3' },
      { ts: '20261004T080000Z', issue_number: '8', outcome: 'exhausted', run_id: '4' },
    ];
    expect(latestRunByIssue(rows, [7, 8]).get(7)).toEqual({ at: RUN_AT, outcome: 'success', runId: '2' });
    expect([...exhaustedAtByIssue(rows, [7, 8]).keys()]).toEqual([8]);
  });
});

describe('the job names the lane reads are the workflow\'s', () => {
  const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/agent-implement.yml', import.meta.url)), 'utf8');

  it('both jobs exist, and the recovery runs on the check\'s `empty` output', () => {
    const { check, recovery } = implement.emptyCheck!;
    expect(wf).toMatch(new RegExp(`^  ${check}:\\n`, 'm'));
    const block = wf.split(new RegExp(`^  ${recovery}:\\n`, 'm'))[1] ?? '';
    expect(block).not.toBe('');
    expect(block).toMatch(new RegExp(`needs: \\[implement, ${check}\\]`));
    expect(block).toMatch(new RegExp(`needs\\.${check}\\.outputs\\.empty == 'true'`));
  });
});
