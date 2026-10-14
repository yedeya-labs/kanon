import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TRIGGERS } from '../../cli/callers.mjs';
import { MAX_RUNS_READ, callerFileOf, ranJob, reaskDue } from '../../scripts/reask-due.mjs';
import { evaluate } from './helpers/expression.js';
import { SPAWNS } from './helpers/spawns.js';
import { writeStub } from './helpers/stub-bin.js';

/**
 * kanon#813: no lane may need a schedule to fire on time to be correct. GitHub's `schedule` is
 * best effort, so the dispatch sweep and the Lead's reconciler are also re-asked by a
 * `workflow_run` of the lanes whose runs they recover (docs/lanes.md, "Schedules are best
 * effort"). This file holds the re-ask's three promises:
 *
 *   - ONLY A REAL RUN ASKS, AND NEVER THE LANE'S OWN CALLER: each lane's admission, evaluated;
 *   - THE CADENCE IS KEPT: `scripts/reask-due.mjs` acts only when no run of the caller worked
 *     inside the window, and a declined re-ask does not count;
 *   - NO LOOP: no lane admits its own caller's run, the documented triggers and Kanon's callers
 *     form no `workflow_run` cycle, and the run a sweep or tick starts finds that sweep or tick
 *     inside the window.
 */

const WF = '.github/workflows';
type Step = { id?: string; name?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, string> };
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[] };
type Workflow = { name?: string; on?: Record<string, unknown>; jobs: Record<string, Job> };
const read = (file: string) => parse(readFileSync(join(WF, file), 'utf8')) as Workflow;
const SWEEP = read('agent-dispatch-sweep.yml');
const TICK = read('agent-lead-reconcile.yml');
const inner = (v: string) => v.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');

/** The `github` context of a run, the caller at `caller`, on `event`. */
const ctx = (event: string, o: { caller?: string; ran?: string; conclusion?: string } = {}) => ({
  github: {
    event_name: event,
    workflow_ref: `owner/repo/.github/workflows/${o.caller ?? 'dispatch-sweep.yml'}@refs/heads/main`,
    event: event === 'workflow_run' ? { workflow_run: { path: `.github/workflows/${o.ran ?? 'implement.yml'}`, conclusion: o.conclusion ?? 'success' } } : { action: 'closed' },
  },
});

describe('only a real run of another caller asks (kanon#813)', () => {
  const lanes = [
    ['the dispatch sweep\'s gate', SWEEP.jobs.gate!.if!, 'dispatch-sweep.yml'],
    ['the reconciler\'s tick', TICK.jobs.tick!.if!, 'lead-reconcile.yml'],
  ] as const;

  it.each(lanes)('%s admits a run of another caller that worked', (_n, cond, caller) => {
    for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out']) {
      expect(evaluate(cond, ctx('workflow_run', { caller, conclusion })), conclusion).toBe(true);
    }
  });

  it.each(lanes)('%s turns away a run whose jobs all skipped', (_n, cond, caller) => {
    expect(evaluate(cond, ctx('workflow_run', { caller, conclusion: 'skipped' }))).toBe(false);
  });

  it.each(lanes)('%s never admits a run of its own caller, whatever the caller lists', (_n, cond, caller) => {
    expect(evaluate(cond, ctx('workflow_run', { caller, ran: caller }))).toBe(false);
    // Under another file name too: the guard reads the caller's own `workflow_ref`.
    expect(evaluate(cond, ctx('workflow_run', { caller: 'my-sweep.yml', ran: 'my-sweep.yml' }))).toBe(false);
    // A file whose name ends the same is someone else's.
    expect(evaluate(cond, ctx('workflow_run', { caller, ran: `x-${caller}` }))).toBe(true);
  });

  it.each(lanes)('%s keeps its schedule and its dispatch', (_n, cond, caller) => {
    expect(evaluate(cond, ctx('schedule', { caller }))).toBe(true);
    expect(evaluate(cond, ctx('workflow_dispatch', { caller }))).toBe(true);
  });
});

describe('the cadence is kept: a re-ask works only when the lane has not, inside its window', () => {
  it('the sweep\'s gate says due on its own triggers, and on a re-ask only when its check said so', () => {
    const due = inner(SWEEP.jobs.gate!.outputs!.due!);
    const at = (event: string, said: string) => evaluate(due, { github: { event_name: event }, steps: { reask: { outputs: { due: said } } } });
    expect(at('schedule', '')).toBe(true);
    expect(at('workflow_dispatch', '')).toBe(true);
    expect(at('workflow_run', 'true')).toBe(true);
    expect(at('workflow_run', 'false')).toBe(false);
    // A check that never ran (a failed mint) is not a yes.
    expect(at('workflow_run', '')).toBe(false);
    for (const job of ['store', 'sweep']) expect(SWEEP.jobs[job]!.if, job).toContain("needs.gate.outputs.due == 'true'");
  });

  it('the sweep\'s check counts its `sweep` job, over 20 hours, on a token narrowed to Actions: read', () => {
    const steps = SWEEP.jobs.gate!.steps!;
    const check = steps.find((s) => s.id === 'reask')!;
    expect(check.run).toBe('node "$KANON/scripts/reask-due.mjs"');
    expect(check.env).toMatchObject({ REASK_JOB: 'sweep', REASK_HOURS: '20', GH_TOKEN: '${{ steps.reask-token.outputs.token }}' });
    expect(Object.keys(SWEEP.jobs)).toContain('sweep');
    const mint = steps.find((s) => s.id === 'reask-token')!;
    expect(mint.if).toBe("github.event_name == 'workflow_run' && steps.app.outputs.ready == 'true'");
    expect(Object.keys(mint.with!).filter((k) => k.startsWith('permission-'))).toEqual(['permission-actions']);
  });

  it('the tick\'s check counts its `scope` step, over 45 minutes, and a no skips every step after it', () => {
    const steps = TICK.jobs.tick!.steps!;
    const check = steps.find((s) => s.id === 'reask')!;
    expect(check.if).toBe("steps.gate.outputs.member == 'true' && github.event_name == 'workflow_run'");
    expect(check.env).toMatchObject({ REASK_JOB: 'tick', REASK_HOURS: '0.75', GH_TOKEN: '${{ github.token }}' });
    // The step it counts is the tick's own first piece of work, by its exact name.
    expect(steps.find((s) => s.id === 'scope')!.name).toBe(check.env!.REASK_STEP);
    // Every step that waited only on the gate now waits on the check too; the rest wait on those.
    const gated = steps.filter((s) => s.id !== 'reask' && s.if?.includes('steps.gate.outputs.member'));
    expect(gated.map((s) => s.id ?? s.uses)).toEqual(['actions/checkout@v7', 'lead', 'scope', 'briefs', 'unreviewed']);
    for (const s of gated) {
      expect(s.if).toBe("steps.gate.outputs.member == 'true' && steps.reask.outputs.due != 'false'");
      const on = (said: string) => evaluate(s.if!, { steps: { gate: { outputs: { member: 'true' } }, reask: { outputs: { due: said } } } });
      expect(on('')).toBe(true); // every other trigger: the check is skipped
      expect(on('true')).toBe(true);
      expect(on('false')).toBe(false);
    }
  });
});

describe('scripts/reask-due.mjs', () => {
  const job = (name: string, conclusion: string | null, status = 'completed', steps?: Array<{ name: string; conclusion: string | null; status?: string }>) =>
    ({ name, status, conclusion, steps: steps?.map((s) => ({ status: 'completed', ...s })) });
  const at = (h: number) => new Date(Date.UTC(2026, 9, 14, h)).toISOString();

  it('reads the caller\'s file from GITHUB_WORKFLOW_REF', () => {
    expect(callerFileOf('owner/repo/.github/workflows/dispatch-sweep.yml@refs/heads/main')).toBe('dispatch-sweep.yml');
    expect(callerFileOf('owner/repo/.github/workflows/x.yaml@refs/pull/1/merge')).toBe('x.yaml');
    expect(callerFileOf('owner/repo/elsewhere/x.yml@main')).toBeNull();
    expect(callerFileOf(undefined)).toBeNull();
  });

  it('a job ran when it concluded anything but skipped, or has not finished', () => {
    expect(ranJob([job('sweep / sweep', 'success')], 'sweep')).toBe(true);
    expect(ranJob([job('sweep / sweep', 'failure')], 'sweep')).toBe(true);
    expect(ranJob([job('sweep / sweep', null, 'in_progress')], 'sweep')).toBe(true);
    expect(ranJob([job('sweep / sweep', 'skipped')], 'sweep')).toBe(false);
    expect(ranJob([job('sweep / gate', 'success')], 'sweep')).toBe(false);
    expect(ranJob([job('sweep / sweeper', 'success')], 'sweep')).toBe(false);
    expect(ranJob([], 'sweep')).toBe(false);
  });

  it('with a step named, the job ran only when that step did', () => {
    const scope = 'Is there a project to reconcile?';
    expect(ranJob([job('reconcile / tick', 'success', 'completed', [{ name: scope, conclusion: 'success' }])], 'tick', scope)).toBe(true);
    // A declined re-ask: the tick job succeeded, its working steps skipped.
    expect(ranJob([job('reconcile / tick', 'success', 'completed', [{ name: scope, conclusion: 'skipped' }])], 'tick', scope)).toBe(false);
    expect(ranJob([job('reconcile / tick', 'success', 'completed', [])], 'tick', scope)).toBe(false);
    // A tick that has not started yet lists no steps: it is about to work.
    expect(ranJob([job('reconcile / tick', null, 'queued', [])], 'tick', scope)).toBe(true);
  });

  it('is not due when another run worked inside the window, and says which', () => {
    const jobs: Record<string, ReturnType<typeof job>[]> = { 1: [job('s / sweep', 'success')], 2: [job('s / sweep', 'skipped')] };
    const d = reaskDue({ runs: [{ id: 1, created_at: at(1) }, { id: 2, created_at: at(2) }], jobsOf: (id) => jobs[String(id)]!, job: 'sweep', runId: 3 });
    expect(d).toMatchObject({ due: false, by: { id: 1 } });
  });

  it('is due when every other run inside the window declined, and never counts itself', () => {
    const seen: Array<number | string> = [];
    const jobsOf = (id: number | string) => { seen.push(id); return String(id) === '3' ? [job('s / sweep', null, 'in_progress')] : [job('s / sweep', 'skipped')]; };
    const d = reaskDue({ runs: [{ id: 1, created_at: at(1) }, { id: 2, created_at: at(2) }, { id: 3, created_at: at(3) }], jobsOf, job: 'sweep', runId: '3' });
    expect(d.due).toBe(true);
    expect(seen).toEqual([2, 1]); // newest first, and not run 3, the run asking
  });

  // kanon#835: the turned-away re-asks outnumber real runs, and must not use up the reads.
  it('drops runs that skipped whole before reading any jobs, so they cannot hide a sweep', () => {
    const skips = Array.from({ length: MAX_RUNS_READ + 5 }, (_v, i) => ({ id: 100 + i, conclusion: 'skipped', created_at: new Date(Date.UTC(2026, 9, 14, 10, i)).toISOString() }));
    const read: Array<number | string> = [];
    const d = reaskDue({
      runs: [...skips, { id: 1, conclusion: 'success', created_at: at(1) }],
      jobsOf: (id) => { read.push(id); return id === 1 ? [job('s / sweep', 'success')] : []; },
      job: 'sweep',
    });
    expect(d).toMatchObject({ due: false, by: { id: 1 } });
    expect(read).toEqual([1]);
  });

  it(`reads at most ${MAX_RUNS_READ} runs, and is due past them`, () => {
    let reads = 0;
    const runs = Array.from({ length: MAX_RUNS_READ + 5 }, (_v, i) => ({ id: i + 1, created_at: new Date(Date.UTC(2026, 9, 14, 0, i)).toISOString() }));
    const d = reaskDue({ runs, jobsOf: () => { reads += 1; return [job('s / sweep', 'skipped')]; }, job: 'sweep' });
    expect(d.due).toBe(true);
    expect(reads).toBe(MAX_RUNS_READ);
  });

  // THE LOOP, END TO END. A scheduled sweep at 04:30 re-dispatches an issue; the implement run
  // it starts completes at 05:40 and re-asks the sweep, which finds the 04:30 sweep and stops.
  // Its decline leaves `sweep` skipped, so the next day's first re-ask, past 20 hours, sweeps.
  it('stops the loop through a re-dispatch, and still sweeps the next day', () => {
    const history: Array<{ id: number; created_at: string; jobs: ReturnType<typeof job>[] }> = [
      { id: 10, created_at: '2026-10-14T04:30:00Z', jobs: [job('sweep / sweep', 'success')] },
    ];
    const inWindow = (now: string) => history.filter((r) => Date.parse(now) - Date.parse(r.created_at) <= 20 * 3600_000);
    const ask = (id: number, now: string) => {
      const d = reaskDue({ runs: [...inWindow(now), { id, created_at: now }], jobsOf: (r) => history.find((h) => h.id === r)!.jobs, job: 'sweep', runId: id });
      history.push({ id, created_at: now, jobs: [job('sweep / sweep', d.due ? 'success' : 'skipped')] });
      return d.due;
    };
    expect(ask(11, '2026-10-14T05:40:00Z')).toBe(false);
    expect(ask(12, '2026-10-14T09:00:00Z')).toBe(false);
    expect(ask(13, '2026-10-15T01:00:00Z')).toBe(true);
    expect(ask(14, '2026-10-15T02:00:00Z')).toBe(false);
  });

  const run = (env: Record<string, string>, gh?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'reask-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    if (gh) writeStub(join(dir, 'gh'), gh);
    const r = spawnSync('node', ['scripts/reask-due.mjs'], {
      ...SPAWNS, encoding: 'utf8',
      env: {
        ...process.env, PATH: gh ? `${dir}:${process.env.PATH}` : process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '',
        GITHUB_REPOSITORY: 'owner/repo', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/dispatch-sweep.yml@refs/heads/main',
        GITHUB_RUN_ID: '3', REASK_JOB: 'sweep', REASK_HOURS: '20', ...env,
      },
    });
    return { status: r.status, stdout: r.stdout, output: readFileSync(out, 'utf8') };
  };

  it('fails open: a listing it cannot read runs the lane, with a warning', () => {
    // The suite's trap `gh` refuses every call (tests/unit/helpers/offline.ts).
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.output).toBe('due=true\n');
    expect(r.stdout).toMatch(/::warning title=reask-due::could not read the runs of dispatch-sweep\.yml/);
  });

  it('fails open on inputs it cannot read', () => {
    const r = run({ REASK_HOURS: 'soon' });
    expect(r.output).toBe('due=true\n');
    expect(r.stdout).toContain('::warning title=reask-due::cannot tell whether the re-ask is due');
  });

  it('lists the caller\'s runs inside the window, then their jobs, and says no', () => {
    const r = run({}, [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *"/actions/workflows/dispatch-sweep.yml/runs"*) echo \'{"workflow_runs":[{"id":3,"created_at":"2026-10-14T05:00:00Z"},{"id":2,"created_at":"2026-10-14T04:30:00Z"}]}\' ;;',
      '  *"/actions/runs/2/jobs"*) echo \'{"jobs":[{"name":"sweep / sweep","status":"completed","conclusion":"success"}]}\' ;;',
      '  *) exit 9 ;;',
      'esac',
    ].join('\n'));
    expect(r.status).toBe(0);
    expect(r.output).toBe('due=false\n');
    expect(r.stdout).toContain('not due: run 2 ran `sweep` inside the window (20h)');
  }, SPAWNS.timeout);
});

describe('no loop: the documented re-asks and Kanon\'s callers form no `workflow_run` cycle', () => {
  const lanesDoc = readFileSync('docs/lanes.md', 'utf8');
  /** The two snippets docs/lanes.md gives, by the lane whose caller they go in. */
  const snippets = Object.fromEntries([...lanesDoc.matchAll(/```yaml\n# In the (dispatch sweep|reconciler)'s caller\n([\s\S]*?)```/g)]
    .map((m) => [m[1] === 'dispatch sweep' ? 'agent-dispatch-sweep' : 'agent-lead-reconcile', (parse(m[2]!) as { workflow_run: { workflows: string[]; types: string[] } }).workflow_run]));
  const callerName = (lane: string) => (TRIGGERS as Record<string, { name: string }>)[lane]!.name;

  it('docs/lanes.md gives both, on completion, naming the callers `kanon init` writes', () => {
    expect(Object.keys(snippets).sort()).toEqual(['agent-dispatch-sweep', 'agent-lead-reconcile']);
    expect(snippets['agent-dispatch-sweep']).toEqual({ workflows: ['agent-implement', 'agent-triage'].map(callerName), types: ['completed'] });
    expect(snippets['agent-lead-reconcile']).toEqual({ workflows: ['agent-review', 'agent-implement-revise', 'agent-lead-revise', 'agent-implement'].map(callerName), types: ['completed'] });
  });

  it('neither lists its own caller', () => {
    for (const [lane, t] of Object.entries(snippets)) expect(t.workflows, lane).not.toContain(callerName(lane));
  });

  /** Every edge "a run of A completing starts B", from Kanon's workflows and the snippets, by name. */
  const edges = (): Map<string, Set<string>> => {
    const g = new Map<string, Set<string>>();
    const add = (from: string, to: string) => g.set(from, (g.get(from) ?? new Set()).add(to));
    for (const f of readdirSync(WF).filter((x) => /\.ya?ml$/.test(x))) {
      const w = read(f);
      const wr = (w.on as { workflow_run?: { workflows?: string[] } } | undefined)?.workflow_run;
      for (const from of wr?.workflows ?? []) add(from, w.name ?? f);
    }
    for (const [lane, t] of Object.entries(snippets)) for (const from of t.workflows) add(from, callerName(lane));
    // An adopter's CI is named `CI`, and every caller `kanon init` writes listens to it by that name.
    for (const t of Object.values(TRIGGERS as Record<string, { name: string; ci?: string }>)) if (t.ci) add('CI', t.name);
    return g;
  };
  const cycle = (g: Map<string, Set<string>>): string[] | null => {
    const state = new Map<string, 'open' | 'done'>();
    const walk = (n: string, path: string[]): string[] | null => {
      if (state.get(n) === 'open') return [...path, n];
      if (state.get(n) === 'done') return null;
      state.set(n, 'open');
      for (const m of g.get(n) ?? []) { const c = walk(m, [...path, n]); if (c) return c; }
      state.set(n, 'done');
      return null;
    };
    for (const n of g.keys()) { const c = walk(n, []); if (c) return c; }
    return null;
  };

  it('has no cycle', () => {
    expect(cycle(edges())).toBeNull();
  });

  it('would be caught: a sweep caller listing itself, or a reviewer listening to the reconciler', () => {
    const g = edges();
    const self = new Map(g);
    self.set(callerName('agent-dispatch-sweep'), new Set([callerName('agent-dispatch-sweep')]));
    expect(cycle(self)).not.toBeNull();
    const around = new Map(g);
    around.set(callerName('agent-lead-reconcile'), new Set([callerName('agent-review')]));
    expect(cycle(around)).not.toBeNull();
  });
});
