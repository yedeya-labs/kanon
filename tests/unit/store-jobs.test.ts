import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { agentJobProblems, storeLaneProblems, telemetryReads, type Job, type Workflow } from './helpers/store-jobs.js';

/**
 * Plan 0004 step P9: no agent job ever holds the QA store's credentials (§3.2, `K-OBS-17`,
 * `K-OBS-13`'s rule applied to the QA store). `storeLaneProblems` is the check each
 * store-coupled lane's own test applies when it moves (steps 9, 11, 12 and 13); here it runs on
 * a fixture lane in the plan's shape, and every mutation the plan names turns it red.
 */

const fixture = (): Workflow => parse(readFileSync('tests/fixtures/qa-store/lane.yml', 'utf8')) as Workflow;
const mutate = (change: (wf: Workflow) => void): string[] => {
  const wf = fixture();
  change(wf);
  return storeLaneProblems(wf);
};
const job = (wf: Workflow, name: string): Job => wf.jobs[name]!;

describe('the telemetry step\'s reads, from its own action', () => {
  it('are the PR diff size and the issue body, each only when the row names one', () => {
    expect(telemetryReads()).toEqual([
      { scope: 'pull-requests', when: 'pr' },
      { scope: 'issues', when: 'issue' },
    ]);
  });

  it('grow with the action: a new unconditional read of runs is required too', () => {
    const text = [
      'runs:', '  using: composite', '  steps:',
      '    - shell: bash', '      env:', '        GH_TOKEN: ${{ github.token }}', '      run: gh run view "$RUN"',
    ].join('\n');
    expect(telemetryReads(text)).toEqual([{ scope: 'actions', when: 'always' }]);
  });

  it('fail by name on a default-token read they can\'t map, rather than missing it', () => {
    const api = 'runs:\n  steps:\n    - env:\n        GH_TOKEN: ${{ github.token }}\n      run: gh api repos/o/r/commits\n';
    expect(() => telemetryReads(api)).toThrow(/can't map/);
    const cond = 'runs:\n  steps:\n    - if: always()\n      env:\n        GH_TOKEN: ${{ github.token }}\n      run: gh pr view 1\n';
    expect(() => telemetryReads(cond)).toThrow(/condition/);
  });
});

describe('a store-coupled lane in the plan\'s shape', () => {
  it('passes the check', () => {
    expect(storeLaneProblems(fixture())).toEqual([]);
  });
});

describe('the agent job holds no store credentials (P9\'s mutations)', () => {
  it('removing its permissions block turns the check red: it would inherit the caller\'s id-token', () => {
    expect(mutate((wf) => { delete job(wf, 'agent').permissions; })).toEqual([
      expect.stringMatching(/^agent: the agent job declares no permissions block of its own, so it inherits the caller's grant, id-token included$/),
    ]);
  });

  it('adding id-token: write to it turns the check red', () => {
    expect(mutate((wf) => { (job(wf, 'agent').permissions as Record<string, string>)['id-token'] = 'write'; }))
      .toEqual(['agent: the agent job grants id-token: write']);
  });

  it('giving it an environment turns the check red', () => {
    expect(mutate((wf) => { job(wf, 'agent').environment = 'kanon-qa-store'; }))
      .toEqual(["agent: the agent job declares environment 'kanon-qa-store'; only store jobs declare one"]);
  });

  it('dropping a read the telemetry step uses turns the check red (RA-2592)', () => {
    expect(mutate((wf) => { delete (job(wf, 'agent').permissions as Record<string, string>).issues; }))
      .toEqual(['agent: the agent job lacks issues: read, which the telemetry step reads when it has a issue number']);
    // A PR lane needs the diff-size read as well.
    expect(mutate((wf) => { job(wf, 'agent').with!['pr-number'] = '${{ inputs.pr }}'; }))
      .toEqual(['agent: the agent job lacks pull-requests: read, which the telemetry step reads when it has a pr number']);
  });

  it('a job that runs the blocks directly is held to the same reads', () => {
    const direct: Job = {
      permissions: { contents: 'read' },
      steps: [{ uses: '$/actions/agent-run' }, { uses: '$/actions/agent-finish', with: { 'pr-number': '${{ inputs.pr }}' } }],
    };
    expect(agentJobProblems('direct', direct)).toEqual(['direct: the agent job lacks pull-requests: read, which the telemetry step reads when it has a pr number']);
    expect(agentJobProblems('direct', { ...direct, permissions: { contents: 'read', 'pull-requests': 'read' } })).toEqual([]);
  });
});

describe('the store jobs run in kanon-qa-store, and only they hold id-token', () => {
  it('a store job under any other environment name turns the check red', () => {
    for (const name of ['qa', 'kanon-telemetry', 'kanon-qa-store-staging']) {
      expect(mutate((wf) => { job(wf, 'put').environment = name; })).toEqual([`put: a store job's environment is '${name}', not 'kanon-qa-store'`]);
    }
    expect(mutate((wf) => { job(wf, 'export').environment = { name: 'qa' }; })).toEqual(["export: a store job's environment is 'qa', not 'kanon-qa-store'"]);
    expect(mutate((wf) => { delete job(wf, 'export').environment; })).toEqual(["export: a store job's environment is '', not 'kanon-qa-store'"]);
  });

  it('a store job without id-token: write turns the check red', () => {
    expect(mutate((wf) => { delete (job(wf, 'put').permissions as Record<string, string>)['id-token']; }))
      .toEqual(['put: a store job declares no permissions block granting id-token: write']);
  });

  it('a store job that runs the agent turns the check red', () => {
    expect(mutate((wf) => { job(wf, 'put').steps!.push({ uses: '$/actions/agent-run' }); }))
      .toEqual(['put: a store job runs the agent']);
  });

  it('any other job with id-token, an environment or no permissions of its own turns the check red', () => {
    const gate = (j: Job) => mutate((wf) => { wf.jobs.gate = j; });
    expect(gate({ permissions: { contents: 'read', 'id-token': 'write' }, steps: [{ run: 'true' }] })).toEqual(['gate: grants id-token: write; only store jobs do']);
    expect(gate({ permissions: { contents: 'read' }, environment: 'kanon-qa-store', steps: [{ run: 'true' }] })).toEqual(["gate: declares environment 'kanon-qa-store'; only store jobs declare one"]);
    expect(gate({ steps: [{ run: 'true' }] })).toEqual(["gate: declares no permissions block of its own, so it inherits the caller's grant, id-token included"]);
  });
});

describe('the export is deleted by a job of its own, always (§3.2)', () => {
  it('any condition but always() turns the check red', () => {
    for (const cond of ['success()', "always() && needs.agent.result == 'success'", 'failure()']) {
      expect(mutate((wf) => { job(wf, 'delete-export').if = cond; })).toEqual([`delete-export: the export's delete job runs if '${cond}', not always()`]);
    }
    expect(mutate((wf) => { delete job(wf, 'delete-export').if; })).toEqual(["delete-export: the export's delete job runs if '', not always()"]);
  });

  it('it needs the export job and the agent job', () => {
    expect(mutate((wf) => { job(wf, 'delete-export').needs = ['export']; })).toEqual(["delete-export: the export's delete job doesn't need the agent job agent"]);
    expect(mutate((wf) => { job(wf, 'delete-export').needs = 'agent'; })).toEqual(["delete-export: the export's delete job doesn't need the export job export"]);
  });

  it('it alone holds actions: write, and nothing more', () => {
    expect(mutate((wf) => { (job(wf, 'delete-export').permissions as Record<string, string>).contents = 'read'; }))
      .toEqual(['delete-export: the export\'s delete job grants {"actions":"write","contents":"read"}, not exactly actions: write']);
    expect(mutate((wf) => { (job(wf, 'agent').permissions as Record<string, string>).actions = 'write'; }))
      .toEqual(['agent: grants actions: write; only the export\'s delete job does']);
  });

  it('a lane that exports and never deletes turns the check red', () => {
    expect(mutate((wf) => { delete wf.jobs['delete-export']; })).toEqual(['the lane exports the store (export) and has no job that deletes the export']);
  });
});
