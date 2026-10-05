import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { idTokenProblems, idTokenSource, type Job, type Workflow } from './helpers/store-jobs.js';

/**
 * The widened id-token guard (`K-OBS-17`; decision 9, as the Owner changed it on 2026-10-05).
 *
 * The QA store's role no longer trusts a GitHub Environment that only store jobs declare: it
 * trusts the default branch's ref, so ANY job of a default-branch run that can mint an OIDC
 * token could assume it. What scopes the store to its store jobs is therefore which jobs hold
 * `id-token: write`, and that is held here, for every workflow Kanon ships (the lanes, the
 * spine, the smoke callers and the maintenance workflow alike): a job may hold it, by its own
 * grant or by inheriting the workflow's, only when it runs the qa-store block alone (kanon#225's
 * allow-list) or the AWS store's maintenance block alone, or when it calls one of these
 * workflows that has such a job. Without the grant GitHub never gives a job the token-request
 * variables, so a job that holds none cannot ask for a token at all.
 */
const WORKFLOWS = '.github/workflows';
const load = (): Record<string, Workflow> => Object.fromEntries(readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => [f, parse(readFileSync(join(WORKFLOWS, f), 'utf8')) as Workflow]));
const mutate = (change: (w: Record<string, Workflow>) => void) => {
  const w = load();
  change(w);
  return idTokenProblems(w);
};
const job = (w: Record<string, Workflow>, file: string, name: string): Job => {
  const j = w[file]?.jobs[name];
  if (!j) throw new Error(`${file} has no job ${name}: the mutation would pass for the wrong reason`);
  return j;
};
const grant = (j: Job) => { j.permissions = { ...(typeof j.permissions === 'object' ? j.permissions : {}), 'id-token': 'write' }; };

describe('every Kanon workflow', () => {
  it('passes the guard: only store jobs, and the callers of their lanes, hold id-token', () => {
    expect(idTokenProblems(load())).toEqual([]);
  });

  it('the guard is not vacuous: it sees the store jobs, the maintenance job and the smoke callers that hold id-token', () => {
    const w = load();
    const holders = Object.entries(w).flatMap(([f, wf]) => Object.entries(wf.jobs ?? {})
      .filter(([, j]) => idTokenSource(wf, j)).map(([n]) => `${f}:${n}`)).sort();
    expect(holders).toEqual([
      'agent-code-audit.yml:export', 'agent-code-audit.yml:put',
      'agent-dispatch-sweep.yml:store',
      'agent-explore.yml:last-green', 'agent-explore.yml:put', 'agent-explore.yml:record-skip',
      'agent-lanes-smoke.yml:code-audit', 'agent-lanes-smoke.yml:dispatch-sweep', 'agent-lanes-smoke.yml:explore',
      'qa-store-aws-maintenance.yml:maintenance',
    ]);
  });

  it('no job of any of them declares an environment', () => {
    const w = load();
    const declared = Object.entries(w).flatMap(([f, wf]) => Object.entries(wf.jobs ?? {})
      .filter(([, j]) => j.environment !== undefined).map(([n]) => `${f}:${n}`));
    expect(declared).toEqual([]);
  });
});

describe('the mutations: any other job holding id-token turns the guard red, by name', () => {
  it('an agent job given id-token: write', () => {
    expect(mutate((w) => grant(job(w, 'agent-explore.yml', 'explore'))))
      .toEqual(['agent-explore.yml: job explore holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone may']);
    expect(mutate((w) => grant(job(w, 'agent-code-audit.yml', 'audit'))))
      .toEqual(['agent-code-audit.yml: job audit holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone may']);
  });

  it('a gate job given id-token: write', () => {
    expect(mutate((w) => grant(job(w, 'agent-explore.yml', 'gate'))))
      .toEqual(['agent-explore.yml: job gate holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone may']);
  });

  it('a job of a lane that never touches the store', () => {
    expect(mutate((w) => grant(job(w, 'agent-review.yml', Object.keys(w['agent-review.yml']!.jobs).find((n) => w['agent-review.yml']!.jobs[n]!.permissions)!))))
      .toEqual([expect.stringMatching(/^agent-review\.yml: job \S+ holds id-token: write \(its own permissions grant\); only a job that runs the qa-store block alone may$/)]);
  });

  it('a job that inherits id-token from the workflow-level permissions', () => {
    // The spine declares no permissions anywhere: a workflow-level grant reaches every job.
    const spine = mutate((w) => { w['agent-lane.yml']!.permissions = { contents: 'read', 'id-token': 'write' }; });
    expect(spine.length).toBeGreaterThan(0);
    for (const p of spine) expect(p).toMatch(/^agent-lane\.yml: job \S+ holds id-token: write \(it declares no permissions, so it inherits the workflow's\); only a job that runs the qa-store block alone may$/);
    // A job that drops its own block in a lane whose workflow grants it.
    expect(mutate((w) => {
      w['agent-explore.yml']!.permissions = { contents: 'read', 'id-token': 'write' };
      delete job(w, 'agent-explore.yml', 'change').permissions;
    })).toEqual(["agent-explore.yml: job change holds id-token: write (it declares no permissions, so it inherits the workflow's); only a job that runs the qa-store block alone may"]);
    // `write-all` grants id-token too.
    expect(mutate((w) => { job(w, 'agent-explore.yml', 'gate').permissions = 'write-all'; }))
      .toEqual(['agent-explore.yml: job gate holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone may']);
  });

  it('a caller that passes id-token to a lane with no store job', () => {
    expect(mutate((w) => grant(job(w, 'agent-lanes-smoke.yml', 'triage'))))
      .toEqual(['agent-lanes-smoke.yml: job triage holds id-token: write (its own permissions grant) and calls agent-triage.yml, which has no store job to pass it to']);
    expect(mutate((w) => grant(job(w, 'agent-triage.yml', Object.keys(w['agent-triage.yml']!.jobs).find((n) => w['agent-triage.yml']!.jobs[n]!.uses)!))))
      .toEqual([expect.stringMatching(/^agent-triage\.yml: job \S+ holds id-token: write \(its own permissions grant\) and calls agent-lane\.yml, which has no store job to pass it to$/)]);
  });

  it('a store job that runs anything beside the block loses its exemption', () => {
    expect(mutate((w) => { job(w, 'agent-explore.yml', 'put').steps!.push({ run: 'echo hi' }); }))
      .toEqual(['agent-explore.yml: job put holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone may']);
    expect(mutate((w) => { (job(w, 'qa-store-aws-maintenance.yml', 'maintenance') as Record<string, unknown>).env = { NODE_OPTIONS: '-r x' }; }))
      .toEqual(["qa-store-aws-maintenance.yml: job maintenance holds id-token: write (it declares no permissions, so it inherits the workflow's); only a job that runs the qa-store block alone may"]);
  });

  it('id-token: none is no grant', () => {
    expect(mutate((w) => { (job(w, 'agent-explore.yml', 'gate').permissions as Record<string, string>)['id-token'] = 'none'; })).toEqual([]);
  });
});
