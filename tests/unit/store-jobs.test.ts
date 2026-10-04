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

describe('a re-run of the agent job alone never reads a deleted export (kanon#224)', () => {
  const step = (wf: Workflow, name: string) => job(wf, name).steps!.find((s) => s.uses === '$/actions/qa-store')!;

  it('the agent job runs only on the export\'s attempt', () => {
    const gate = "agent: the agent job's if: '%s' lacks the conjunct 'needs.export.outputs.attempt == github.run_attempt', so a re-run of it alone reads an export already deleted";
    expect(mutate((wf) => { delete job(wf, 'agent').if; })).toEqual([gate.replace('%s', '')]);
    for (const cond of [
      'always()',
      "needs.export.outputs.attempt == github.run_attempt || inputs.issue != ''",
      // `||` binds looser than `&&`: this runs whenever an issue is given, whatever the attempt.
      "inputs.issue != '' || always() && needs.export.outputs.attempt == github.run_attempt",
      'needs.export.outputs.attempt != github.run_attempt',
      'needs.export.outputs.artifact-id == github.run_attempt',
    ]) {
      expect(mutate((wf) => { job(wf, 'agent').if = cond; })).toEqual([gate.replace('%s', cond)]);
    }
    // Another conjunct beside it, or the expression wrapped in ${{ }}, still holds the gate.
    expect(mutate((wf) => { job(wf, 'agent').if = "${{ inputs.issue != '' && needs.export.outputs.attempt  ==  github.run_attempt }}"; })).toEqual([]);
  });

  it('the agent job needs the export job', () => {
    expect(mutate((wf) => { job(wf, 'agent').needs = []; })).toEqual(["agent: the agent job doesn't need the export job export"]);
  });

  it('the export job outputs the block\'s attempt', () => {
    const msg = 'export: the export job doesn\'t output its attempt (attempt: ${{ steps.<id>.outputs.attempt }}), which the agent job\'s if: compares with the run\'s';
    expect(mutate((wf) => { delete job(wf, 'export').outputs!.attempt; })).toEqual([msg]);
    expect(mutate((wf) => { job(wf, 'export').outputs!.attempt = '${{ github.run_attempt }}'; })).toEqual([msg]);
    expect(mutate((wf) => { job(wf, 'export').outputs!.attempt = '${{ steps.other.outputs.attempt }}'; })).toEqual([msg]);
    expect(mutate((wf) => { delete step(wf, 'export').id; })).toEqual([msg]);
  });

  it('the delete step is handed the export\'s artifact-id and attempt and the agent job\'s result', () => {
    expect(mutate((wf) => { step(wf, 'delete-export').with!['artifact-id'] = '${{ needs.agent.outputs.artifact-id }}'; }))
      .toEqual(['no delete-export step is handed the export job\'s artifact-id (${{ needs.export.outputs.artifact-id }})']);
    expect(mutate((wf) => { delete step(wf, 'delete-export').with!['export-attempt']; }))
      .toEqual(['delete-export: the delete-export step isn\'t handed export-attempt: ${{ needs.export.outputs.attempt }}']);
    expect(mutate((wf) => { step(wf, 'delete-export').with!['export-attempt'] = '${{ github.run_attempt }}'; }))
      .toEqual(['delete-export: the delete-export step isn\'t handed export-attempt: ${{ needs.export.outputs.attempt }}']);
    expect(mutate((wf) => { step(wf, 'delete-export').with!['agent-result'] = 'skipped'; }))
      .toEqual(['delete-export: the delete-export step isn\'t handed agent-result: ${{ needs.agent.result }}, so a partial re-run that skipped the agent stays green']);
  });

  it('a lane that exports runs one agent job', () => {
    expect(mutate((wf) => {
      wf.jobs.agent2 = { ...job(wf, 'agent') };
      job(wf, 'delete-export').needs = ['export', 'agent', 'agent2'];
    })).toEqual(['a lane that exports the store runs one agent job, not 2 (agent, agent2)']);
  });
});

describe('a store job runs the block and nothing else (kanon#225)', () => {
  it('a run: step in a store job turns the check red', () => {
    expect(mutate((wf) => { job(wf, 'put').steps!.splice(1, 0, { run: 'node "$KANON/scripts/anything.mjs" "$(cat report.json)"' }); }))
      .toEqual(['put: a store job runs step 2 (run: node "$KANON/scripts/anything.mjs" "$(ca), which is neither the qa-store block nor the download of the report it puts']);
  });

  it('a third-party action in a store job turns the check red', () => {
    expect(mutate((wf) => { job(wf, 'export').steps!.unshift({ uses: 'some/third-party@v1' }); }))
      .toEqual(['export: a store job runs step 1 (some/third-party@v1), which is neither the qa-store block nor the download of the report it puts']);
    // A look-alike of the block, or of the download, is a third party too.
    expect(mutate((wf) => { job(wf, 'put').steps!.push({ uses: 'evil/kanon/actions/qa-store@v1', with: { operation: 'put' } }); }))
      .toEqual(['put: a store job runs step 3 (evil/kanon/actions/qa-store@v1), which is neither the qa-store block nor the download of the report it puts']);
    expect(mutate((wf) => { job(wf, 'put').steps![0]!.uses = 'actions/download-artifact-evil@v7'; }))
      .toEqual(['put: a store job runs step 1 (actions/download-artifact-evil@v7), which is neither the qa-store block nor the download of the report it puts']);
  });

  it('only a job that puts downloads an artifact', () => {
    expect(mutate((wf) => { job(wf, 'export').steps!.unshift({ uses: 'actions/download-artifact@v7', with: { name: 'x' } }); }))
      .toEqual(['export: a store job runs step 1 (actions/download-artifact@v7), which is neither the qa-store block nor the download of the report it puts']);
  });

  it('a step may not set env, shell or continue-on-error', () => {
    expect(mutate((wf) => { job(wf, 'export').steps![0]!.env = { NODE_OPTIONS: '--require ./x.js' }; }))
      .toEqual(["export: a store job's step 1 (store) carries 'env'"]);
    expect(mutate((wf) => { (job(wf, 'put').steps![1] as Record<string, unknown>)['continue-on-error'] = true; }))
      .toEqual(["put: a store job's step 2 ($/actions/qa-store) carries 'continue-on-error'"]);
  });

  it('a job may not set env, defaults, a container or services', () => {
    for (const key of ['env', 'defaults', 'container', 'services']) {
      expect(mutate((wf) => { (job(wf, 'put') as Record<string, unknown>)[key] = {}; })).toEqual([`put: a store job carries '${key}', which a store job never needs`]);
    }
  });

  it('the delete job runs the block\'s delete-export alone', () => {
    expect(mutate((wf) => { job(wf, 'delete-export').steps!.push({ run: 'echo hi' }); }))
      .toEqual(["delete-export: the export's delete job runs step 2 (run: echo hi), which is not the qa-store block"]);
    expect(mutate((wf) => { job(wf, 'delete-export').steps!.unshift({ uses: 'actions/download-artifact@v7' }); }))
      .toEqual(["delete-export: the export's delete job runs step 1 (actions/download-artifact@v7), which is not the qa-store block"]);
    expect(mutate((wf) => { (job(wf, 'delete-export') as Record<string, unknown>).env = { GH_TOKEN: 'x' }; }))
      .toEqual(["delete-export: the export's delete job carries 'env', which a store job never needs"]);
    // A store operation in the delete job makes it a store job too, which is red already.
    expect(mutate((wf) => { job(wf, 'delete-export').steps!.push({ uses: '$/actions/qa-store', with: { operation: 'put', kind: 'audit' } }); }))
      .toContain('delete-export: a store job also deletes the export');
  });
});
