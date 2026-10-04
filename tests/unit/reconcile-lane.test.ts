import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ownRegister, runRegisterStep, withSlug, withoutRole } from './helpers/register-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';

/**
 * The Lead's reconciler, `agent-lead-reconcile.yml` (plan 0004 step 8), moved from the reference
 * adopter. What its library scripts decide is tested in `tests/library/` (lead-reconcile,
 * brief-revise-recovery, review-recovery, red-unreviewed); this file holds what the move
 * changed: the triggers it admits as a called lane, the tick budget as the lane's constant, the
 * Lead's login from the App register, and the Actions probe that names the declared deploy.
 */

const ROOT = process.cwd();
type Job = { if?: string; steps?: WorkflowStep[] };
const LANE_TEXT = readFileSync(join(ROOT, '.github/workflows/agent-lead-reconcile.yml'), 'utf8');
const wf = parse(LANE_TEXT) as {
  on: { workflow_call: { inputs: Record<string, { type: string; required: boolean }>; secrets: Record<string, unknown> } };
  permissions: Record<string, string>;
  jobs: { tick: Job };
};
const caller = parse(readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-lead-reconcile.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  jobs: Record<string, { with?: Record<string, string> }>;
};
const steps = wf.jobs.tick.steps!;
const step = (pred: (s: WorkflowStep) => boolean): WorkflowStep => {
  const s = steps.find(pred);
  if (!s) throw new Error('no such step in the tick job');
  return s;
};

/** `github.event_name == '…'` and `github.event.action == '…'`, joined by `||` and `&&`. */
const admits = (event_name: string, action?: string): boolean => {
  const js = String(wf.jobs.tick.if)
    .replace(/github\.event_name/g, JSON.stringify(event_name))
    .replace(/github\.event\.action/g, JSON.stringify(action ?? ''))
    .replace(/'([^']*)'/g, (_m, s: string) => JSON.stringify(s))
    .replace(/==/g, '===');
  if (/github\.|\w+\s*\(/.test(js)) throw new Error(`unmodelled expression: ${js}`);
  return Boolean(new Function(`return (${js});`)());
};

describe('the reconciler is a called lane, with the caller’s four triggers', () => {
  it('the fixture caller holds the triggers the lane documents', () => {
    expect(Object.keys(caller.on).sort()).toEqual(['issues', 'pull_request', 'schedule', 'workflow_dispatch']);
    expect(caller.on.schedule).toEqual([{ cron: '25 * * * *' }]);
    expect(LANE_TEXT).toContain('#   schedule: "25 * * * *"');
  });

  it.each([
    ['workflow_dispatch', undefined, true],
    ['schedule', undefined, true],
    ['pull_request', 'closed', true],
    ['issues', 'closed', true],
    ['pull_request', 'opened', false],
    ['pull_request', 'synchronize', false],
    ['issues', 'labeled', false],
    ['push', undefined, false],
    ['merge_group', undefined, false],
    ['pull_request_review', 'submitted', false],
  ] as const)('%s %s: admitted %s', (event, action, want) => {
    expect(admits(event, action)).toBe(want);
  });

  it('takes the Lead’s two secrets and no Claude token: it runs no model', () => {
    expect(Object.keys(wf.on.workflow_call.secrets).sort()).toEqual(['LEAD_APP_ID', 'LEAD_APP_PRIVATE_KEY']);
    expect(LANE_TEXT).not.toMatch(/claude-code-action|agent-run|CLAUDE_CODE_OAUTH_TOKEN:/);
  });

  it('takes `project` and `apply` as optional strings, passed through by the caller', () => {
    for (const k of ['project', 'apply']) expect(wf.on.workflow_call.inputs[k]).toMatchObject({ type: 'string', required: false });
    expect(caller.jobs.tick!.with).toEqual({ project: '${{ inputs.project }}', apply: '${{ inputs.apply }}' });
  });

  it('runs only Kanon’s scripts, from Kanon’s tree', () => {
    const runs = steps.map((s) => s.run ?? '').join('\n');
    for (const script of ['lane-gate', 'lead-reconcile', 'brief-revise-recovery', 'review-recovery', 'red-unreviewed', 'reference-deploy']) {
      expect(runs).toContain(`"$KANON/scripts/${script}.mjs"`);
    }
    expect(runs).not.toMatch(/\bnode (?!"\$KANON)/);
    expect(runs).not.toMatch(/scripts\/qa\/|deploy-staging/);
  });
});

describe('the tick budget is the lane’s constant (plan 0004 §5)', () => {
  const reconcile = step((s) => s.name === 'Reconcile');
  it('is 6, set on the Reconcile step, and nowhere else', () => {
    expect(reconcile.env?.QA_LEAD_TICK_BUDGET).toBe('6');
    expect(LANE_TEXT.match(/QA_LEAD_TICK_BUDGET:/g)).toHaveLength(1);
  });
  it('is no input, so a caller cannot pass a setting for it (ADR 0002)', () => {
    expect(Object.keys(wf.on.workflow_call.inputs)).not.toContain('budget');
    expect(LANE_TEXT).not.toMatch(/inputs\.[a-z_]*budget/i);
  });
  it('is the env var the library reads it from', () => {
    expect(readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8')).toMatch(/readBudget\(process\.env\.QA_LEAD_TICK_BUDGET\)/);
  });
  it('passes the project through the environment, never into the shell line', () => {
    expect(reconcile.run).toBe('node "$KANON/scripts/lead-reconcile.mjs" --project "$PROJECT"');
    expect(reconcile.env?.PROJECT).toBe('${{ steps.scope.outputs.project }}');
  });
});

describe('the Lead’s login comes from the App register on the default branch (plan 0004 P5)', () => {
  const lead = step((s) => s.id === 'lead');
  it('reads the Lead row over the API, with no `ref`', () => {
    const r = runRegisterStep(lead, ownRegister());
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.login).toBe('example-lead');
    expect(r.ghArgs).toHaveLength(1);
    expect(r.ghArgs[0]).toContain('repos/owner/repo/contents/docs/qa/agent-identities.md');
    expect(r.ghArgs[0]).not.toMatch(/ref=/);
  });
  it('follows a renamed Lead App', () => {
    expect(runRegisterStep(lead, withSlug(ownRegister(), 'Lead', 'example-lead-renamed')).outputs.login).toBe('example-lead-renamed');
  });
  it('fails the tick by name without a Lead row, or without a register', () => {
    const missing = runRegisterStep(lead, withoutRole(ownRegister(), 'Lead'));
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain('lists the role Lead 0 times');
    const absent = runRegisterStep(lead, null);
    expect(absent.status).not.toBe(0);
    expect(absent.output).toContain('could not read docs/qa/agent-identities.md from the default branch');
  });
  it('is read only once the gate admitted, like every step after it', () => {
    expect(lead.if).toBe("steps.gate.outputs.member == 'true'");
  });
});

describe('the Actions probe names the declared deploy workflow (plan 0004 P6)', () => {
  const probe = step((s) => String(s.name).startsWith('Probe that the App can read Actions'));
  const RECORD = (decl: string) => `# Adoption record\n\n## Choices\n\n${decl}`;
  const DECLARED = RECORD('- **Reference environment:** `preview`\n- **Reference deploy workflow:** `deploy-preview.yml`\n- **Reference deploy job:** `ship`\n');

  /** The step, executed with a `gh` that serves the adoption record (or none) and the run list. */
  const runProbe = ({ record, runList = 'ok' }: { record: string | null; runList?: 'ok' | 'denied' }) => {
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-probe-'));
    const calls = join(dir, 'calls');
    writeFileSync(calls, '');
    if (record !== null) writeFileSync(join(dir, 'adoption.md'), record);
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in
  "api repos/owner/repo --jq .default_branch") echo main ;;
  *contents/docs/qa/adoption.md*) ${record === null ? 'echo "gh: Not Found (HTTP 404)" >&2; exit 1' : `cat ${JSON.stringify(join(dir, 'adoption.md'))}`} ;;
  "run list"*) ${runList === 'ok' ? 'echo "[]"' : 'echo "HTTP 403: Resource not accessible by integration" >&2; exit 1'} ;;
  *) echo "unexpected gh call: $*" >&2; exit 3 ;;
esac
`);
    const r = runWorkflowStep({ ...probe, run: String(probe.run).replace(/\/tmp\//g, `${dir}/`) }, {
      dir,
      env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'app-token', GITHUB_REPOSITORY: 'owner/repo', LEAD_LOGIN: 'example-lead', KANON: ROOT },
    });
    return { ...r, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
  };

  it('lists one run of the declared workflow, and creates nothing', () => {
    const r = runProbe({ record: DECLARED });
    expect(r.status, r.output).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('run list'))).toEqual(['run list --repo owner/repo --workflow deploy-preview.yml --limit 1']);
    expect(r.output).toContain('the reference deploy workflow, deploy-preview.yml');
  });

  it('probes any workflow’s runs when the record declares no deploy, and says so — never red on that alone', () => {
    // `readDeploy` names a missing declaration itself when a project reaches its deploy phase
    // (K-PROJ-11); a tick with no project there must not fail on it.
    for (const record of [RECORD('- **Chat channel:** none yet.\n'), null]) {
      const r = runProbe({ record });
      expect(r.status, r.output).toBe(0);
      expect(r.output).toContain('::notice title=agent-lead-reconcile::No reference deploy workflow to probe');
      expect(r.calls.filter((c) => c.startsWith('run list'))).toEqual(['run list --repo owner/repo --limit 1']);
    }
  });

  it('fails the tick by name when the App cannot read Actions, on either path', () => {
    for (const record of [DECLARED, null]) {
      const r = runProbe({ record, runList: 'denied' });
      expect(r.status).toBe(1);
      expect(r.output).toContain('::error title=agent-lead-reconcile::example-lead cannot read Actions');
    }
  });

  it('fails a malformed declaration as no declaration here, leaving the red to the reconcile', () => {
    const r = runProbe({ record: RECORD('- **Reference environment:** `preview`\n') });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('No reference deploy workflow to probe');
  });
});
