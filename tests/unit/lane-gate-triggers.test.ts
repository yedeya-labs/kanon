import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { callerFile, TRIGGERS as CALLER_TRIGGERS, type Lane } from '../../cli/callers.mjs';
import { triggeringActor } from '../../scripts/lane-gate.mjs';
import { TRIGGERS, eventFor, gateOf, read, type Trigger } from './helpers/lane-gate.js';

/**
 * kanon#1665: every activity type a caller `kanon init` writes subscribes a lane to is one the
 * membership gate decides an actor for. A trigger the gate refuses never starts the lane, and
 * nothing goes red, so #1664's `ready_for_review` could have shipped refused. This holds the gate
 * tests' trigger list to the caller templates, and each subscribed type to `triggeringActor`.
 */
const REQ = JSON.parse(readFileSync(join(process.cwd(), 'requirements.json'), 'utf8')) as { lanes: Record<string, Lane> };

/** The event and activity type each of the gate tests' triggers stands for. */
const EVENT_OF: Record<Trigger, string> = {
  review: 'pull_request_review:submitted',
  'issue-label': 'issues:labeled',
  'issue-opened': 'issues:opened',
  'issue-closed': 'issues:closed',
  'pr-label': 'pull_request:labeled',
  merged: 'pull_request:closed',
  dispatch: 'workflow_dispatch',
  'ci-finished': 'workflow_run:completed',
  'deploy-failed': 'workflow_run:completed',
  'lane-finished': 'workflow_run:completed',
  'pr-target-label': 'pull_request_target:labeled',
  'pr-target-opened': 'pull_request_target:opened',
  'pr-target-ready': 'pull_request_target:ready_for_review',
  'pr-target-milestoned': 'pull_request_target:milestoned',
  'pr-target-merged': 'pull_request_target:closed',
  schedule: 'schedule',
  'release-published': 'release:published',
};

/** What a lane's caller, as `kanon init` writes it, subscribes the lane to: `event` or `event:type`. */
const subscribed = (lane: string): string[] => {
  const on = (parse(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.0.0', ciName: 'CI', defaultBranch: 'main' })) as { on: Record<string, { types?: string[] } | null> }).on;
  return Object.entries(on).flatMap(([event, v]) => (v?.types?.length ? v.types.map((t) => `${event}:${t}`) : [event])).sort();
};

const lanes = Object.keys(CALLER_TRIGGERS).filter((l) => REQ.lanes[l]);

describe('every trigger a caller template subscribes a lane to passes the membership gate (kanon#1665)', () => {
  it('covers every lane the templates write', () => {
    expect(lanes.length).toBeGreaterThan(15);
    for (const lane of lanes) expect(TRIGGERS[`${lane}.yml`], lane).toBeDefined();
  });

  it.each(lanes)("%s: the gate tests' triggers are exactly what its caller subscribes it to", (lane) => {
    const tested = [...new Set((TRIGGERS[`${lane}.yml`] ?? []).map((t) => EVENT_OF[t]))].sort();
    expect(tested).toEqual(subscribed(lane));
  });

  it.each(lanes)('%s: the gate decides an actor for each type it is subscribed to', (lane) => {
    // The lane's own gate-step environment, such as the backstop's `LANE_GATE_ISSUE_OPENED`.
    const wf = read(`${lane}.yml`);
    const g = gateOf(wf)!;
    const gateEnv = (wf.jobs[g.jobId]!.steps![g.index] as { env?: Record<string, string> }).env ?? {};
    for (const trigger of TRIGGERS[`${lane}.yml`] ?? []) {
      const e = eventFor(trigger, { login: 'a-member' });
      const r = triggeringActor(e.name, e.payload as never, { ...gateEnv, ...e.env });
      expect('actor' in r ? r.actor.login : `refused: ${(r as { refuse: string }).refuse}`, `${lane} on ${EVENT_OF[trigger]}`).not.toMatch(/^refused/);
    }
  });
});
