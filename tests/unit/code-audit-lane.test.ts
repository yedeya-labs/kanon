import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STORE_SECRETS, STORE_SECRETS_WITH, storeLaneProblems, telemetryReads, type Job, type Workflow } from './helpers/store-jobs.js';
import { handedIn, mintFor, readFlattened, workflowText } from './helpers/called-workflow.js';
import { callerInputs, realGroup } from './helpers/smoke-group.js';

/**
 * Plan 0004 step 11: the code audit, moved from the reference adopter as a Kanon lane
 * (`agent-code-audit.yml`). It reads the code-reading ledger through the store hook's `export` and
 * writes its run through `put`, each in a store job of its own (§3.2, P9's check), and reads what
 * to audit from the stack document's `## Code areas` (§5, decision 6).
 *
 * What moved with it from the reference adopter: the report protocol (written first, stamped,
 * recorded before the job is judged, RA-504 and RA-846). What it left behind: the cloud
 * credentials in the agent's job, the cloud CLI in its prompt, and the adopter's own areas,
 * milestone and persona.
 */

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string>; 'continue-on-error'?: boolean };
type LaneJob = Job & { steps?: Step[]; 'timeout-minutes'?: number };
type Lane = Workflow & {
  name: string;
  on: { workflow_call: { inputs?: Record<string, unknown>; secrets: Record<string, { required?: boolean }> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, LaneJob>;
};

const LANE_FILE = '.github/workflows/agent-code-audit.yml';
const LANE_TEXT = workflowText(LANE_FILE);
const lane = (): Lane => readFlattened(LANE_FILE) as Lane;
const wf = lane();
const audit = wf.jobs.audit!;
const steps = (audit.steps ?? []) as Step[];
const at = (p: (s: Step) => boolean) => steps.findIndex(p);
const byId = (id: string) => steps.find((s) => s.id === id)!;
const prompt = String(byId('agent').with?.prompt);
const caller = parse(readFileSync('tests/fixtures/lane-check/extra/agent-code-audit.yml', 'utf8')) as {
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
  permissions: Record<string, string>;
};

describe('the store jobs and the audit job (plan 0004 P9\'s check, applied at step 11)', () => {
  it('the lane has the store-coupled shape', () => {
    expect(storeLaneProblems(wf, telemetryReads())).toEqual([]);
  });

  it('no job declares an environment, and only the store jobs hold id-token', () => {
    const withEnv = Object.entries(wf.jobs).filter(([, j]) => j.environment !== undefined).map(([n]) => n);
    expect(withEnv).toEqual([]);
    const withToken = Object.entries(wf.jobs).filter(([, j]) => typeof j.permissions === 'object' && 'id-token' in j.permissions).map(([n]) => n);
    expect(withToken).toEqual(['export', 'put']);
  });

  it('the agent job declares its own permissions without id-token, and no environment', () => {
    expect(audit.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'read' });
    expect(audit.environment).toBeUndefined();
  });

  it('grants the reads the quality step makes with the workflow token: its own run, and the issues it filed', () => {
    // A permissions block sets every unlisted scope to none, and `gh` prints a 403 body to
    // standard output, where it would read as data (RA-1504).
    const quality = byId('quality');
    expect(quality.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(quality.run).toContain('gh run view "$GITHUB_RUN_ID"');
    expect(quality.run).toContain("agent-quality-columns.mjs\" --filed-since \"$SINCE\" --label 'agent:explorer'");
    expect(audit.permissions).toMatchObject({ actions: 'read', issues: 'read' });
  });

  it('exports the audit\'s ledger before the agent, and puts the audit\'s report after it', () => {
    expect(wf.jobs.export!.steps).toEqual([{ uses: '$/actions/qa-store', id: 'store', with: { operation: 'export', variables: '${{ toJSON(vars) }}', secrets: STORE_SECRETS_WITH, kind: 'audit' } }]);
    const put = wf.jobs.put!.steps!.find((s) => s.uses === '$/actions/qa-store')!;
    expect(put.with).toEqual({ operation: 'put', variables: '${{ toJSON(vars) }}', secrets: STORE_SECRETS_WITH, kind: 'audit', report: '${{ runner.temp }}/report/qa-audit-summary.json' });
    // The report the put job downloads is the one the audit job uploads.
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    const download = wf.jobs.put!.steps!.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with?.name).toBe(upload.with?.name);
    expect(upload.with?.path).toBe('qa-audit-summary.json');
    // And the export the audit job downloads is the export job's.
    const exported = steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(handedIn(LANE_FILE, 'audit', 'artifact-name')).toBe('${{ needs.export.outputs.artifact-name }}');
    expect(exported.with).toEqual({ name: '${{ inputs.artifact-name }}', path: 'qa-store-export' });
  });

  it('puts the report whether the audit went red or green, never after a skip or a cancel', () => {
    expect(wf.jobs.put!.needs).toBe('audit');
    expect(wf.jobs.put!.if).toBe("always() && (needs.audit.result == 'success' || needs.audit.result == 'failure')");
  });

  describe('mutations: each turns the check red', () => {
    const mutate = (change: (l: Lane) => void) => {
      const l = lane();
      change(l);
      return storeLaneProblems(l, telemetryReads());
    };
    it('id-token on the audit job', () =>
      expect(mutate((l) => { (l.jobs.audit!.permissions as Record<string, string>)['id-token'] = 'write'; })).toEqual(['audit: the agent job grants id-token: write']));
    it('the audit job with no permissions of its own, inheriting the caller\'s id-token', () =>
      expect(mutate((l) => { delete l.jobs.audit!.permissions; })).toEqual(["audit: the agent job declares no permissions block of its own, so it inherits the caller's grant, id-token included"]));
    it('the audit job in an environment', () =>
      expect(mutate((l) => { l.jobs.audit!.environment = 'qa'; })).toEqual(["audit: the agent job declares environment 'qa'; no job of a store-coupled lane declares one"]));
    it('the put job under the adopter\'s old environment name', () =>
      expect(mutate((l) => { l.jobs.put!.environment = 'qa'; })).toEqual(["put: a store job declares environment 'qa', which would replace the default branch's ref in its OIDC subject, so the store's role would refuse it"]));
    it('the agent job run on a partial re-run', () =>
      expect(mutate((l) => { l.jobs.audit!.if = 'always()'; })).toEqual(["audit: the agent job's if: 'always()' lacks the conjunct 'needs.export.outputs.attempt == github.run_attempt', so a re-run of it alone reads an export already deleted"]));
    it('the delete job conditioned on the audit', () =>
      expect(mutate((l) => { l.jobs['delete-export']!.if = "needs.audit.result == 'success'"; })).toEqual(["delete-export: the export's delete job runs if 'needs.audit.result == 'success'', not always()"]));
  });
});

describe('what the agent is told', () => {
  it('names no cloud, no credentials and no store query: the store comes as files', () => {
    expect(LANE_TEXT).not.toMatch(/configure-aws-credentials|role-to-assume|QA_DYNAMO_TABLE|QA_AWS|vars\.QA_|aws dynamodb|environment: qa\b/);
    expect(prompt).toContain('qa-store-export/manifest.json');
    expect(prompt).toContain('qa-store-export/areas.json');
    expect(prompt).toMatch(/`present`, `absent` or `degraded`/);
    expect(prompt).toMatch(/When\s+the store is absent or degraded there is no ledger: say so/);
    expect(prompt).toContain('Do not query any store');
  });

  it('reads its areas from the stack document, through a step that fails by name before the token is minted', () => {
    const areas = byId('areas');
    expect(areas.run).toContain('node "$KANON/scripts/code-areas.mjs"');
    expect(areas.run).toContain('set -euo pipefail');
    expect(areas.if).toBeUndefined();
    expect(at((s) => s.id === 'areas')).toBeLessThan(at((s) => s.id === 'app-token'));
    expect(prompt).toContain('${{ steps.areas.outputs.list }}');
    expect(prompt).toContain('`## Code areas` section of\ndocs/qa/stack.md');
  });

  it('carries none of the reference adopter\'s own facts', () => {
    // Its source directories, its examples, and the milestone it named by its own name.
    expect(prompt).not.toMatch(/src\/server|src\/app|src\/db|catalog|kiosk|Production Ready/);
    expect(prompt).toMatch(/Milestone: Product\s+Backlog, a bucket/);
  });

  it('keeps the report protocol: a skeleton first, re-written as it goes, complete only on the last write', () => {
    expect(prompt).toContain('WRITE `qa-audit-summary.json` at the repo root **BEFORE you start\nauditing**');
    expect(prompt).toContain('{"complete":false,"timestamp":"<ISO-8601 UTC>","areas_scanned":[],"filed":[],');
    expect(prompt).toContain('Do NOT self-report a `lines_cited` number');
  });

  it('runs the configuration it records', () => {
    expect(byId('finish').with?.claude_args).toBe(byId('agent').with?.claude_args);
    expect(byId('finish').with?.agent).toBe('auditor');
    expect(byId('finish').with?.lane).toBe('code-audit');
  });
});

describe('the report is recorded before the job is judged (RA-504, RA-846)', () => {
  const upload = at((s) => s.uses?.startsWith('actions/upload-artifact@') ?? false);

  it('stamps, then uploads, then decides, each whatever happened before', () => {
    expect(at((s) => s.id === 'stamp')).toBeLessThan(upload);
    expect(upload).toBeLessThan(at((s) => s.name?.startsWith('Reconcile the agent') ?? false));
    expect(upload).toBeLessThan(at((s) => s.name?.startsWith('Fail on a no-report') ?? false));
    for (const s of [byId('stamp'), steps[upload]!]) expect(s.if).toBe('always()');
    expect(steps[upload]!.with?.['if-no-files-found']).toBe('error');
  });

  it('runs the agent with continue-on-error, so a complete report after a capped exit stays green', () => {
    expect(byId('agent')['continue-on-error']).toBe(true);
    const reconcile = steps.find((s) => s.name?.startsWith('Reconcile the agent'))!;
    expect(reconcile.if).toBe("always() && steps.agent.outcome == 'failure'");
    expect(reconcile.run).toMatch(/COMPLETE" = "true" \]; then[\s\S]*?exit 0[\s\S]*?::error title=degraded audit run::[\s\S]*?exit 1/);
  });

  it('synthesizes a no_report or report_invalid run, flagged before any further work', () => {
    const stamp = String(byId('stamp').run);
    expect(stamp).toContain('"no_report":true');
    expect(stamp.indexOf("'report_invalid=true\\n'")).toBeLessThan(stamp.indexOf('const raw ='));
    expect(stamp).toContain('const cites = invalid ? new Set()');
  });

  it('explains a red run last', () => {
    // Then only the token's revoke, the job's last step (kanon#279, `K-AGENT-49`).
    expect(steps.at(-1)!.name).toBe('Revoke the App token');
    const last = steps[steps.length - 2]!;
    expect(last.uses).toBe('$/actions/agent-classify');
    expect(last.if).toBe('failure()');
    expect(byId('finish').with?.classify).toBe('false');
  });
});

describe('the workflow around it (moved from the reference adopter)', () => {
  it('mints the Explorer\'s App, narrowed to what the agent does', () => {
    // In a job of its own (kanon#279): the agent's job receives the token, and never the key.
    expect(byId('app-token').name).toBe('Receive the App token');
    const minter = mintFor(LANE_FILE, 'audit');
    expect(minter.uses).toBe('actions/create-github-app-token@v3');
    expect(minter.with).toMatchObject({
      'client-id': '${{ secrets.AUTHOR_APP_ID }}',
      'private-key': '${{ secrets.AUTHOR_APP_PRIVATE_KEY }}',
      'permission-contents': 'read',
      'permission-issues': 'write',
    });
    expect(Object.keys(wf.on.workflow_call.secrets).sort()).toEqual(['AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', ...STORE_SECRETS]);
  });

  it('keeps the schedule every three days at 07:30, and a dispatch with no inputs', () => {
    expect(caller.on.schedule).toEqual([{ cron: '30 7 */3 * *' }]);
    expect(LANE_TEXT).toContain('schedule: "30 7 */3 * *"');
    expect(callerInputs(wf.on.workflow_call.inputs)).toBeUndefined();
  });

  it('the caller grants what the store jobs and the delete job need', () => {
    expect(caller.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'write', 'id-token': 'write' });
  });

  it('serialises runs, admits only its caller\'s two triggers, and bounds every job', () => {
    expect({ ...wf.concurrency, group: realGroup(wf.concurrency.group) }).toEqual({ group: 'agent-code-audit', 'cancel-in-progress': false });
    expect(wf.jobs.gate!.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    for (const [name, job] of Object.entries(wf.jobs)) expect(job['timeout-minutes'], name).toBeGreaterThan(0);
  });

  it('with no hook, nothing in the lane waits on the store being present: the audit runs without memory', () => {
    // The block says the store is absent (qa-store-block.test.ts); no job here reads that as a reason to stop.
    for (const [name, job] of Object.entries(wf.jobs)) expect(String(job.if ?? ''), name).not.toMatch(/outputs\.(present|state)/);
  });
});
