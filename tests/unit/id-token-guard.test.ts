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
// Every workflow is read and parsed once, and each case gets its own copy to change: parsing them
// all again for each mutation made one case take over 5 s under a loaded run (#436).
const PARSED: Record<string, Workflow> = Object.fromEntries(readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => [f, parse(readFileSync(join(WORKFLOWS, f), 'utf8')) as Workflow]));
const load = (): Record<string, Workflow> => structuredClone(PARSED);
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

  it('the guard is not vacuous: it sees the store jobs, the maintenance job, and the smoke and lane callers that hold id-token', () => {
    const w = load();
    const holders = Object.entries(w).flatMap(([f, wf]) => Object.entries(wf.jobs ?? {})
      .filter(([, j]) => idTokenSource(wf, j)).map(([n]) => `${f}:${n}`)).sort();
    expect(holders).toEqual([
      'agent-code-audit.yml:export', 'agent-code-audit.yml:put',
      'agent-dispatch-sweep.yml:store',
      // The telemetry Explorer's read job (plan 0004 step 14), which calls the aggregate function.
      'agent-explore-telemetry.yml:aggregate',
      'agent-explore.yml:last-green', 'agent-explore.yml:put', 'agent-explore.yml:record-skip',
      'agent-lanes-smoke.yml:code-audit', 'agent-lanes-smoke.yml:dispatch-sweep', 'agent-lanes-smoke.yml:explore',
      'agent-lanes-smoke.yml:explore-telemetry', 'agent-lanes-smoke.yml:overseer',
      'agent-overseer.yml:export',
      // The Overseer's telemetry read job (kanon#470), which assumes the reader role.
      'agent-overseer.yml:telemetry',
      // Kanon's own caller of the code-audit lane (plan 0004 step 11a): it calls a lane with
      // store jobs, so it grants their id-token, and no job of its own runs anything.
      'code-audit.yml:audit',
      // And of the telemetry Explorer's lane (kanon#443): its one holder is the lane's aggregate job.
      'explore-telemetry.yml:explore',
      // And of the Overseer's lane (kanon#423), the same way: its store job is the lane's export.
      'overseer.yml:oversee',
      'qa-store-aws-maintenance.yml:maintenance',
      'telemetry-collect.yml:collect', 'telemetry.yml:collect',
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
    // The agent's job itself, in the called workflow it runs in since kanon#279.
    expect(mutate((w) => grant(job(w, 'explore-agent-job.yml', 'explore'))))
      .toEqual(['explore-agent-job.yml: job explore holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may']);
    expect(mutate((w) => grant(job(w, 'code-audit-agent-job.yml', 'audit'))))
      .toEqual(['code-audit-agent-job.yml: job audit holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may']);
    // And the lane's call to it, whose grant is the ceiling of every job it runs.
    expect(mutate((w) => grant(job(w, 'agent-explore.yml', 'explore'))))
      .toEqual(['agent-explore.yml: job explore holds id-token: write (its own permissions grant) and calls explore-run.yml, which has no store job to pass it to']);
    expect(mutate((w) => grant(job(w, 'agent-overseer.yml', 'overseer'))))
      .toEqual(['agent-overseer.yml: job overseer holds id-token: write (its own permissions grant) and calls overseer-run.yml, which has no store job to pass it to']);
  });

  it('a gate job given id-token: write', () => {
    expect(mutate((w) => grant(job(w, 'agent-explore.yml', 'gate'))))
      .toEqual(['agent-explore.yml: job gate holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may']);
  });

  it('a job of a lane that never touches the store', () => {
    expect(mutate((w) => grant(job(w, 'agent-review.yml', Object.keys(w['agent-review.yml']!.jobs).find((n) => w['agent-review.yml']!.jobs[n]!.permissions)!))))
      .toEqual([expect.stringMatching(/^agent-review\.yml: job \S+ holds id-token: write \(its own permissions grant\); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may$/)]);
  });

  it('a job that inherits id-token from the workflow-level permissions', () => {
    // The spine declares no permissions anywhere: a workflow-level grant reaches every job. Its
    // `mint` job runs steps, and its `run` job calls `lane-agent-job.yml` (kanon#281), which
    // holds the agent job: each is named in its own form.
    const inherits = "(it declares no permissions, so it inherits the workflow's)";
    expect(mutate((w) => { w['agent-lane.yml']!.permissions = { contents: 'read', 'id-token': 'write' }; })).toEqual([
      `agent-lane.yml: job mint holds id-token: write ${inherits}; only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may`,
      `agent-lane.yml: job run holds id-token: write ${inherits} and calls lane-agent-job.yml, which has no store job to pass it to`,
    ]);
    // The spine's agent job, in the workflow it calls.
    expect(mutate((w) => { w['lane-agent-job.yml']!.permissions = { contents: 'read', 'id-token': 'write' }; }))
      .toEqual([`lane-agent-job.yml: job run holds id-token: write ${inherits}; only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may`]);
    // A job that drops its own block in a lane whose workflow grants it.
    expect(mutate((w) => {
      w['agent-explore.yml']!.permissions = { contents: 'read', 'id-token': 'write' };
      delete job(w, 'agent-explore.yml', 'change').permissions;
    })).toEqual(["agent-explore.yml: job change holds id-token: write (it declares no permissions, so it inherits the workflow's); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may"]);
    // `write-all` grants id-token too.
    expect(mutate((w) => { job(w, 'agent-explore.yml', 'gate').permissions = 'write-all'; }))
      .toEqual(['agent-explore.yml: job gate holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may']);
  });

  it('a caller that passes id-token to a lane with no store job', () => {
    expect(mutate((w) => grant(job(w, 'agent-lanes-smoke.yml', 'triage'))))
      .toEqual(['agent-lanes-smoke.yml: job triage holds id-token: write (its own permissions grant) and calls agent-triage.yml, which has no store job to pass it to']);
    expect(mutate((w) => grant(job(w, 'agent-triage.yml', Object.keys(w['agent-triage.yml']!.jobs).find((n) => w['agent-triage.yml']!.jobs[n]!.uses)!))))
      .toEqual([expect.stringMatching(/^agent-triage\.yml: job \S+ holds id-token: write \(its own permissions grant\) and calls agent-lane\.yml, which has no store job to pass it to$/)]);
  });

  it('a callee job that inherits the caller\'s id-token, in a callee with no permissions anywhere', () => {
    expect(mutate((w) => {
      delete w['agent-explore.yml']!.permissions;
      delete job(w, 'agent-explore.yml', 'change').permissions;
    })).toEqual(["agent-explore.yml: job change declares no permissions in a workflow with none, so it inherits id-token: write from agent-lanes-smoke.yml's job explore; only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may"]);
    // With the workflow-level block in place the job inherits that, which grants no id-token.
    expect(mutate((w) => { delete job(w, 'agent-explore.yml', 'change').permissions; })).toEqual([]);
  });

  it('a store job that runs anything beside the block loses its exemption', () => {
    expect(mutate((w) => { job(w, 'agent-explore.yml', 'put').steps!.push({ run: 'echo hi' }); }))
      .toEqual(['agent-explore.yml: job put holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may']);
    expect(mutate((w) => { (job(w, 'qa-store-aws-maintenance.yml', 'maintenance') as Record<string, unknown>).env = { NODE_OPTIONS: '-r x' }; }))
      .toEqual(["qa-store-aws-maintenance.yml: job maintenance holds id-token: write (it declares no permissions, so it inherits the workflow's); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may"]);
  });

  // Plan 0002 S7: the telemetry collector's job is the one holder outside the QA store's, and
  // only in its exact shape.
  it('any other job of telemetry-collect.yml given id-token: write', () => {
    expect(mutate((w) => grant(job(w, 'telemetry-collect.yml', 'unset'))))
      .toEqual(['telemetry-collect.yml: job unset holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may']);
    expect(mutate((w) => {
      const wf = w['telemetry-collect.yml']!;
      wf.jobs.extra = { ...structuredClone(job(w, 'telemetry-collect.yml', 'collect')) };
    })).toEqual(['telemetry-collect.yml: job extra holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may']);
    // A workflow-level grant reaches the job that declares none.
    expect(mutate((w) => {
      w['telemetry-collect.yml']!.permissions = { 'id-token': 'write' };
      delete job(w, 'telemetry-collect.yml', 'unset').permissions;
    })).toEqual(["telemetry-collect.yml: job unset holds id-token: write (it declares no permissions, so it inherits the workflow's); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may"]);
  });

  it('the collector job loses its exemption for anything beside its four steps', () => {
    const red = ["telemetry-collect.yml: job collect holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may",
      "telemetry.yml: job collect holds id-token: write (it declares no permissions, so it inherits the workflow's) and calls telemetry-collect.yml, which has no store job to pass it to"];
    const steps = (w: Record<string, Workflow>) => job(w, 'telemetry-collect.yml', 'collect').steps as Array<{ run?: string; uses?: string; env: Record<string, string> }>;
    expect(mutate((w) => { steps(w).push({ run: 'echo hi', env: {} }); })).toEqual(red);
    expect(mutate((w) => { steps(w)[3]!.run = 'node "$KANON/scripts/telemetry-collect.mjs" && curl evil'; })).toEqual(red);
    expect(mutate((w) => { steps(w)[3]!.env.NODE_OPTIONS = '-r x'; })).toEqual(red);
    expect(mutate((w) => { steps(w)[0]!.uses = './.github/actions/kanon-path'; })).toEqual(red);
    expect(mutate((w) => { steps(w)[2]!.uses = 'someone/configure-aws-credentials@v6'; })).toEqual(red);
    // The mask step (kanon#514) runs Kanon's script with the role alone, and nothing else.
    expect(mutate((w) => { steps(w)[1]!.run = 'node "$KANON/scripts/telemetry-collect.mjs" mask; curl evil'; })).toEqual(red);
    expect(mutate((w) => { steps(w)[1]!.env.NODE_OPTIONS = '-r x'; })).toEqual(red);
    expect(mutate((w) => { steps(w)[1]!.env.ROLE = '${{ inputs.url }}'; })).toEqual(red);
    expect(mutate((w) => { steps(w).splice(1, 1); })).toEqual(red);
    expect(mutate((w) => { (job(w, 'telemetry-collect.yml', 'collect') as Record<string, unknown>).env = { NODE_OPTIONS: '-r x' }; })).toEqual(red);
    expect(mutate((w) => { (job(w, 'telemetry-collect.yml', 'collect') as Record<string, unknown>).container = 'node:24'; })).toEqual(red);
    // The same job under another name, or in another workflow, is not the collector.
    expect(mutate((w) => {
      const wf = w['telemetry-collect.yml']!;
      wf.jobs.sweep = job(w, 'telemetry-collect.yml', 'collect');
      delete wf.jobs.collect;
    })).toEqual([
      "telemetry-collect.yml: job sweep holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may",
      "telemetry.yml: job collect holds id-token: write (it declares no permissions, so it inherits the workflow's) and calls telemetry-collect.yml, which has no store job to pass it to",
    ]);
    expect(mutate((w) => { w['agent-review.yml']!.jobs.collect = structuredClone(job(w, 'telemetry-collect.yml', 'collect')); }))
      .toEqual(["agent-review.yml: job collect holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may"]);
  });

  it('the collector job declares no environment', () => {
    // The writer trusts the default branch's ref; an environment would replace it in the subject.
    const w = load();
    expect(job(w, 'telemetry-collect.yml', 'collect').environment).toBeUndefined();
    expect(mutate((x) => { job(x, 'telemetry-collect.yml', 'collect').environment = 'kanon-telemetry'; })).toEqual([
      "telemetry-collect.yml: job collect holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may",
      "telemetry.yml: job collect holds id-token: write (it declares no permissions, so it inherits the workflow's) and calls telemetry-collect.yml, which has no store job to pass it to",
    ]);
  });

  it('id-token: none is no grant', () => {
    expect(mutate((w) => { (job(w, 'agent-explore.yml', 'gate').permissions as Record<string, string>)['id-token'] = 'none'; })).toEqual([]);
  });
});
