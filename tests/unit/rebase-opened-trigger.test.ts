import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TRIGGERS, callerFile } from '../../cli/callers.mjs';
import { REQ, ROOT } from './helpers/kanon-init.js';
import { evaluate } from './helpers/expression.js';

/**
 * kanon#1427: an Implementer pull request opened already conflicting with the default branch got
 * no rebase-lane run until the daily floor. The merges that made it conflict started the lane
 * before it existed, and through a merge queue the CI run after it is the queue's, which the gate
 * turns away (#79). So the rebase lane's caller also starts on a finished run of each lane that
 * opens an Implementer pull request: the implement and triage callers. No new permission and no
 * gate change: the gate judges a `workflow_run` by its triggering actor, the member or registered
 * App that started the implement run. This file holds the trigger to the lanes that open such
 * pull requests, the lane's filter to admitting only a run that did something, and Kanon's own
 * caller and docs to both.
 */

const WF = join(ROOT, '.github/workflows');
type Step = { uses?: string; with?: Record<string, string> };
type Workflow = { name?: string; on?: { workflow_run?: { workflows?: string[] } }; jobs: Record<string, { if?: string; steps?: Step[] }> };
const read = (file: string) => parse(readFileSync(join(WF, file), 'utf8')) as Workflow;
const OPENERS = TRIGGERS['agent-rebase']!.openers;

describe("the rebase lane starts after a run that opens an Implementer pull request (kanon#1427)", () => {
  it('names exactly the lanes whose implementer status runs in `open` mode', () => {
    // A lane opens an Implementer pull request when its status job stamps one in `open` mode.
    const opening = readdirSync(WF).filter((f) => /^agent-.*\.yml$/.test(f)).filter((f) =>
      Object.values(read(f).jobs ?? {}).some((j) => (j.steps ?? []).some((s) => /\/actions\/implementer-status$/.test(s.uses ?? '') && s.with?.mode === 'open')))
      .map((f) => f.replace(/\.yml$/, '')).sort();
    expect(opening).toEqual(['agent-implement', 'agent-triage']);
    expect([...(OPENERS ?? [])].sort()).toEqual(opening);
  });

  it("writes them into the caller's one `workflow_run`, beside CI, on the default branch", () => {
    const on = (names?: Map<string, string>) => (parse(callerFile('agent-rebase', REQ.lanes['agent-rebase']!, { release: 'v1.2.3', ciName: 'Tests', defaultBranch: 'trunk', names })) as Workflow).on!;
    expect(on().workflow_run).toEqual({
      workflows: ['Tests', TRIGGERS['agent-implement']!.name, TRIGGERS['agent-triage']!.name],
      types: ['completed'],
      branches: ['trunk'],
    });
    // A caller the repository already has is named by its own name, as the re-ask's are (#1023).
    expect(on(new Map([['agent-implement', 'Build it']])).workflow_run?.workflows).toEqual(['Tests', 'Build it', TRIGGERS['agent-triage']!.name]);
  });

  it("Kanon's own rebase caller names its implement and triage callers as they are named", () => {
    const run = read('rebase.yml').on!.workflow_run;
    expect(run).toEqual({ workflows: ['CI', read('implement.yml').name, read('triage.yml').name], types: ['completed'], branches: ['main'] });
  });

  // An issue labelled anything but the lane's label starts an implement run whose jobs all skip
  // (268 of 295 in Kanon's week to 2026-10-27), so the filter must turn those away.
  it("the lane's filter admits a finished run that did something, and no skipped or cancelled one", () => {
    const cond = read('agent-rebase.yml').jobs.filter!.if!;
    const ctx = (conclusion: string) => ({ github: { event_name: 'workflow_run', event: { workflow_run: { conclusion } } } });
    for (const c of ['success', 'failure', 'timed_out']) expect(evaluate(cond, ctx(c)), c).toBe(true);
    for (const c of ['skipped', 'cancelled']) expect(evaluate(cond, ctx(c)), c).toBe(false);
  });

  it('docs/lanes.md says so where it lists and explains the triggers', () => {
    const doc = readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| Rebase (resolve a conflict) | `agent-rebase.yml` | Implementer |'))!;
    expect(row).toMatch(/`workflow_run` of your `CI` workflow and of your implement and triage callers/);
    const section = doc.split('\n## The rebase lane\n')[1]!.split('\n## ')[0]!;
    expect(section).toMatch(/an implement or triage run finishing/);
    expect(section).toContain('#1427');
  });
});
