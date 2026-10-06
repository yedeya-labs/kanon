import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { unlinkedQuery } from '../../scripts/capability-interlock.mjs';
import { storeLaneProblems, telemetryReads, type Job, type Workflow } from './helpers/store-jobs.js';
import { handedIn, mintFor, readFlattened, workflowText } from './helpers/called-workflow.js';
import { callerInputs, realGroup } from './helpers/smoke-group.js';

/**
 * Plan 0004 step 13: the Overseer, moved from the reference adopter as a Kanon lane
 * (`agent-overseer.yml`), adopter-scoped and optional (decision 12). It reads the QA store
 * through the hook's `export`, in a store job of its own (§3.2, P9's check); its agent's token
 * reads only; and a step after the agent files what it wrote down, by who can act on each
 * finding (`scripts/overseer-file.mjs`, held by `tests/library/overseer-file.test.ts`).
 *
 * What moved with it: the audit's scope, the token trend and the cache-TTL facts pasted verbatim,
 * the capability review and its watermark anchor (RA-899), and the interlock. What it left
 * behind: the cloud credentials and the cloud CLI in the agent's job, the semantic-recall pair
 * (the adopter's store hook writes `qa-clusters.md`), and the adopter's repository, persona and
 * workflow ids.
 */

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string>; 'continue-on-error'?: boolean };
type LaneJob = Job & { steps?: Step[]; 'timeout-minutes'?: number };
type Lane = Workflow & {
  name: string;
  on: { workflow_call: { inputs?: Record<string, unknown>; secrets: Record<string, { required?: boolean }> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, LaneJob>;
};

const LANE_FILE = '.github/workflows/agent-overseer.yml';
const LANE_TEXT = workflowText(LANE_FILE);
const lane = (): Lane => readFlattened(LANE_FILE) as Lane;
const wf = lane();
const overseer = wf.jobs.overseer!;
const steps = (overseer.steps ?? []) as Step[];
const at = (p: (s: Step) => boolean) => steps.findIndex(p);
const byId = (id: string) => steps.find((s) => s.id === id)!;
const prompt = String(byId('agent').with?.prompt);
const flat = prompt.replace(/\s+/g, ' ');
const caller = parse(readFileSync('tests/fixtures/lane-check/extra/agent-overseer.yml', 'utf8')) as {
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
  permissions: Record<string, string>;
};

describe('the store job and the overseer job (plan 0004 P9\'s check, applied at step 13)', () => {
  it('the lane has the store-coupled shape', () => {
    expect(storeLaneProblems(wf, telemetryReads())).toEqual([]);
  });

  it('no job declares an environment, and only the store job holds id-token', () => {
    const withEnv = Object.entries(wf.jobs).filter(([, j]) => j.environment !== undefined).map(([n]) => n);
    expect(withEnv).toEqual([]);
    const withToken = Object.entries(wf.jobs).filter(([, j]) => typeof j.permissions === 'object' && 'id-token' in j.permissions).map(([n]) => n);
    expect(withToken).toEqual(['export']);
  });

  it('the overseer job declares its own permissions without id-token, and no environment', () => {
    expect(overseer.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'read' });
    expect(overseer.environment).toBeUndefined();
  });

  it('exports the Overseer\'s kind before the agent, and the agent reads that export', () => {
    expect(wf.jobs.export!.steps).toEqual([{ uses: '$/actions/qa-store', id: 'store', with: { operation: 'export', kind: 'overseer' } }]);
    const exported = steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(handedIn(LANE_FILE, 'overseer', 'artifact-name')).toBe('${{ needs.export.outputs.artifact-name }}');
    expect(exported.with).toEqual({ name: '${{ inputs.artifact-name }}', path: 'qa-store-export' });
    // It writes nothing back: the Overseer's durable output is its issues.
    expect(Object.values(wf.jobs).flatMap((j) => j.steps ?? []).filter((s) => (s as Step).with?.operation === 'put')).toEqual([]);
  });

  it('starts the agent only when the export itself succeeded, with an explicit status function (kanon#261)', () => {
    // Without one GitHub prepends success(), which is false when ANY job up the needs chain
    // was skipped or failed, so the agent job could be skipped while its condition reads true.
    expect(overseer.if).toBe("${{ !cancelled() && needs.export.result == 'success' && needs.export.outputs.attempt == github.run_attempt }}");
  });

  describe('mutations: each turns the check red', () => {
    const mutate = (change: (l: Lane) => void) => {
      const l = lane();
      change(l);
      return storeLaneProblems(l, telemetryReads());
    };
    it('id-token on the overseer job', () =>
      expect(mutate((l) => { (l.jobs.overseer!.permissions as Record<string, string>)['id-token'] = 'write'; })).toEqual(['overseer: the agent job grants id-token: write']));
    it('the overseer job with no permissions of its own, inheriting the caller\'s id-token', () =>
      expect(mutate((l) => { delete l.jobs.overseer!.permissions; })).toEqual(["overseer: the agent job declares no permissions block of its own, so it inherits the caller's grant, id-token included"]));
    it('the overseer job in an environment', () =>
      expect(mutate((l) => { l.jobs.overseer!.environment = 'qa'; })).toEqual(["overseer: the agent job declares environment 'qa'; no job of a store-coupled lane declares one"]));
    it('the export job under the adopter\'s old environment name', () =>
      expect(mutate((l) => { l.jobs.export!.environment = 'qa'; })).toEqual(["export: a store job declares environment 'qa', which would replace the default branch's ref in its OIDC subject, so the store's role would refuse it"]));
    it('the agent job run on a partial re-run', () =>
      expect(mutate((l) => { l.jobs.overseer!.if = "${{ !cancelled() && needs.export.result == 'success' }}"; }))
        .toEqual(["overseer: the agent job's if: '${{ !cancelled() && needs.export.result == 'success' }}' lacks the conjunct 'needs.export.outputs.attempt == github.run_attempt', so a re-run of it alone reads an export already deleted"]));
    it('the delete job conditioned on the overseer', () =>
      expect(mutate((l) => { l.jobs['delete-export']!.if = "needs.overseer.result == 'success'"; })).toEqual(["delete-export: the export's delete job runs if 'needs.overseer.result == 'success'', not always()"]));
  });
});

describe('who files what (decision 12)', () => {
  const file = wf.jobs.file!;
  const fileSteps = (file.steps ?? []) as Step[];
  const mints = (j: LaneJob) => ((j.steps ?? []) as Step[]).filter((s) => s.uses?.startsWith('actions/create-github-app-token@'));
  const writes = (s: Step) => Object.entries(s.with ?? {}).filter(([k, v]) => k.startsWith('permission-') && v === 'write').map(([k]) => k);

  it('the agent job holds no token that writes: its one mint reads only, and its workflow token too', () => {
    // Minted in a job of its own (kanon#279), received here: the agent's job mints nothing.
    expect(mints(overseer)).toEqual([]);
    expect(byId('app-token').name).toBe('Receive the App token');
    const mint = mintFor(LANE_FILE, 'overseer');
    expect(mint.with).toMatchObject({
      'client-id': '${{ secrets.AUTHOR_APP_ID }}',
      'permission-contents': 'read',
      'permission-issues': 'read',
      'permission-pull-requests': 'read',
      'permission-actions': 'read',
    });
    expect(writes(mint)).toEqual([]);
    expect(Object.values(overseer.permissions as Record<string, string>)).not.toContain('write');
    expect(byId('agent').with?.['github-token']).toBe('${{ steps.app-token.outputs.token }}');
  });

  it('the file job runs no agent, checks out nothing, and holds the only writing token', () => {
    expect(fileSteps.some((s) => /agent-(run|setup|finish)|claude-code-action/.test(s.uses ?? ''))).toBe(false);
    expect(fileSteps.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(file.permissions).toEqual({});
    expect(file.environment).toBeUndefined();
    const mint = mints(file);
    expect(mint.map((s) => s.id)).toEqual(['file-token']);
    expect(Object.entries(mint[0]!.with ?? {}).filter(([k]) => k.startsWith('permission-'))).toEqual([['permission-issues', 'write'], ['permission-pull-requests', 'read']]);
    // No other job mints a token that writes.
    for (const [name, j] of Object.entries(wf.jobs)) if (name !== 'file') for (const m of mints(j)) expect(writes(m), `${name}#${m.id}`).toEqual([]);
  });

  it('the file job starts on the agent job\'s success, whatever the agent concluded (kanon#261)', () => {
    expect(file.needs).toBe('overseer');
    expect(file.if).toBe("${{ !cancelled() && needs.overseer.result == 'success' }}");
    expect(byId('agent')['continue-on-error']).toBe(true);
  });

  it('hands the report over as an artifact: uploaded whatever happened, downloaded outside a workspace, deleted after', () => {
    const upload = byId('report');
    expect(upload.if).toBe('always()');
    expect(upload.with).toMatchObject({ path: 'qa-overseer-audit.json', 'retention-days': 1, 'if-no-files-found': 'ignore' });
    expect(at((s) => s.id === 'finish')).toBeLessThan(at((s) => s.id === 'report'));
    const download = fileSteps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with).toEqual({ name: upload.with?.name, path: '${{ runner.temp }}/report' });
    expect(overseer.outputs).toMatchObject({ 'report-artifact-id': '${{ steps.report.outputs.artifact-id }}', 'agent-outcome': '${{ steps.agent.outcome }}' });
    const del = wf.jobs['delete-report']!;
    expect(del.if).toBe('always()');
    expect([del.needs].flat()).toContain('file');
    expect(del.steps).toEqual([{ uses: '$/actions/qa-store', with: { operation: 'delete-export', 'artifact-id': '${{ needs.overseer.outputs.report-artifact-id }}', 'export-attempt': '${{ needs.export.outputs.attempt }}', 'agent-result': '${{ needs.overseer.result }}' } }]);
  });

  describe('a partial re-run of the file job says to re-run all jobs (kanon#286)', () => {
    const guard = fileSteps[0]!;
    const run = (reportAttempt: string, runAttempt: string) => {
      try {
        execFileSync('bash', ['-c', guard.run!], { env: { ...process.env, REPORT_ATTEMPT: reportAttempt, RUN_ATTEMPT: runAttempt }, encoding: 'utf8', stdio: 'pipe' });
        return { code: 0, out: '' };
      } catch (e) {
        const err = e as { status: number, stdout: string };
        return { code: err.status, out: err.stdout };
      }
    };

    it('checks the report\'s attempt first, before anything is downloaded or minted', () => {
      expect(guard.name).toBe('Refuse a report from an earlier attempt');
      expect(guard.if).toBeUndefined();
      expect(guard.env).toEqual({ REPORT_ATTEMPT: '${{ needs.overseer.outputs.report-attempt }}', RUN_ATTEMPT: '${{ github.run_attempt }}' });
    });

    it('carries the attempt that uploaded the report up through both called workflows', () => {
      // Reused on a partial re-run, as the report's artifact id is: that is what makes it an
      // earlier attempt's. An expression on the job, not a step's output, so the agent can't set it.
      expect(overseer.outputs).toMatchObject({ 'report-attempt': '${{ github.run_attempt }}' });
      for (const called of ['.github/workflows/overseer-run.yml', '.github/workflows/overseer-agent-job.yml']) {
        const doc = parse(readFileSync(called, 'utf8')) as { on: { workflow_call: { outputs: Record<string, { value: string }> } } };
        expect(doc.on.workflow_call.outputs['report-attempt'], called).toEqual({ value: '${{ jobs.overseer.outputs.report-attempt }}' });
      }
    });

    it('passes on the attempt that wrote the report', () => {
      expect(run('1', '1')).toEqual({ code: 0, out: '' });
      expect(run('3', '3').code).toBe(0);
    });

    it('reds on a later attempt, saying the report is gone and to re-run all jobs', () => {
      const r = run('1', '2');
      expect(r.code).toBe(1);
      expect(r.out).toContain('::error title=overseer::this is attempt 2, but the agent\'s report is from attempt 1');
      expect(r.out).toContain('Use "Re-run all jobs"');
    });

    it('reds on a report attempt it cannot read, rather than downloading on a guess', () => {
      expect(run('', '1').code).toBe(1);
    });
  });

  it('files through overseer-file.mjs, on the filing token, from the downloaded report', () => {
    const step = fileSteps.find((s) => s.id === 'file')!;
    expect(step.name).toBe("Reconcile the agent's exit with what it durably produced"); // workflow-health.mjs names it
    expect(step.run).toBe('node "$KANON/scripts/overseer-file.mjs"');
    expect(step.if).toBeUndefined();
    expect(step.env).toEqual({
      GH_TOKEN: '${{ steps.file-token.outputs.token }}',
      AGENT_OUTCOME: '${{ needs.overseer.outputs.agent-outcome }}',
      REPORT_PATH: '${{ runner.temp }}/report/qa-overseer-audit.json',
      KANON: '${{ steps.kanon.outputs.path }}',
    });
  });

  it('tells the agent it files nothing, and how to say who can act', () => {
    expect(flat).toContain('You file nothing, comment on nothing and close nothing: your token reads only.');
    expect(flat).toContain('`qa-overseer-audit.json`');
    for (const s of ['declaration', 'playbook', 'hook', 'app', 'permissions', 'cost', 'schedule', 'labels', 'milestones', 'coverage', 'lane', 'guard', 'rule', 'library']) {
      expect(flat, s).toContain(`\`${s}\``);
    }
    expect(flat).toMatch(/These are NEVER filed here: they go under the audit issue's `## Upstream` heading as drafts/);
    expect(flat).toMatch(/name nothing of this project, not its issues, paths, people, product or data/);
    expect(prompt).not.toMatch(/gh issue (create|close|comment)/);
  });
});

describe('what the agent is told', () => {
  it('names no cloud, no credentials and no store query: the store comes as files', () => {
    expect(LANE_TEXT).not.toMatch(/configure-aws-credentials|role-to-assume|QA_DYNAMO_TABLE|QA_S3_BUCKET|QA_AWS|vars\.QA_|aws dynamodb|aws s3|environment: qa\b/);
    expect(flat).toContain('Do not query any store yourself.');
    for (const f of ['manifest.json', 'runs-explorer.json', 'runs-audit.json', 'coverage.json', 'areas.json', 'reports/<kind>/<ts>.json', 'token-trend.md', 'cache-ttl.md', 'qa-clusters.md']) {
      expect(prompt, f).toContain(f);
    }
    expect(flat).toMatch(/`present`, `absent` or `degraded`/);
  });

  it('pastes the cache-TTL facts and the token trend verbatim, and calls an absent one a finding', () => {
    expect(flat).toMatch(/paste ALL of `qa-store-export\/cache-ttl\.md` into the audit VERBATIM/);
    expect(flat).toMatch(/paste `qa-store-export\/token-trend\.md` into the audit VERBATIM, under a `## Token efficiency` heading/);
    expect(flat).toContain('cache-ttl: UNAVAILABLE');
  });

  it('writes the token trend to the step summary before the agent, saying so when it is missing', () => {
    expect(at((s) => s.id === 'trend')).toBeLessThan(at((s) => s.id === 'agent'));
    expect(byId('trend').run).toContain('qa-store-export/token-trend.md');
    expect(byId('trend').run).toContain('This is not a quiet week.');
  });

  it('reaches Kanon\'s scripts through `$KANON`, never the adopter\'s pipeline directory', () => {
    expect(prompt).toContain('node "$KANON/scripts/cc-sweep.mjs" slice <WATERMARK>');
    expect(prompt).toContain('node "$KANON/scripts/capability-interlock.mjs"');
    expect(byId('agent').env?.KANON).toBe('${{ steps.kanon.outputs.path }}');
  });

  it('carries none of the reference adopter\'s own facts', () => {
    // Its route source and its milestones; its names and personas are `adopter-literals.test.ts`'s
    // and `public-tree.test.ts`'s to keep out. The repository is the one the lane runs in.
    expect(LANE_TEXT).not.toMatch(/src\/app|page\.tsx|Production Ready|--workflow \d+/i);
    expect(prompt).toContain('The repository is ${{ github.repository }}.');
    // Issue references in a prompt would point at Kanon's issues, not the adopter's.
    expect(prompt).not.toMatch(/(?<![\w-])#\d+/);
  });

  it('sends the agent to the playbook sections K-LAYOUT-17 names', () => {
    for (const s of ['Backlog dynamics', 'Liveness queries', 'Capability review']) expect(flat).toContain(`the playbook's "${s}"`);
    expect(prompt).toContain('docs/qa/overseer-playbook.md');
    expect(prompt).toContain('docs/qa/capability-ledger.md');
  });

  it('keeps the backlog rule: issues only, observations never a target', () => {
    expect(flat).toContain('`is:issue` is mandatory');
    expect(flat).toContain('These are OBSERVATIONS, NEVER A TARGET');
    expect(flat).toMatch(/Never propose a filing threshold, a deferral bar, or any remedy whose effect is "file less"/);
  });

  it('runs the configuration it records', () => {
    expect(byId('finish').with?.claude_args).toBe(byId('agent').with?.claude_args);
    expect(byId('finish').with?.agent).toBe('overseer');
    expect(byId('finish').with?.lane).toBe('overseer');
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

describe('the capability interlock: the agent runs the script, and the query it quotes is the script\'s', () => {
  it('tells the agent to RUN the script, and to treat a failure as a closed interlock', () => {
    expect(flat).toMatch(/run `node "\$KANON\/scripts\/capability-interlock\.mjs"`/);
    expect(flat).toMatch(/IF IT EXITS NON-ZERO OR PRINTS `unknown`, THE INTERLOCK IS CLOSED/);
    expect(flat).toMatch(/DO NOT run that query on its own/);
  });

  it('quotes the script\'s own cohort query, on the repository the lane runs in', () => {
    const quoted = [...flat.matchAll(/q='([^']*label:capability[^']*)'/g)].map((m) => m[1]);
    expect(quoted).toEqual([unlinkedQuery('${{ github.repository }}')]);
  });
});

/**
 * RA-899: the capability review's anchor query, run as composed. The `--jq` program is pulled
 * out of the PARSED prompt (so the block scalar's escaping applies as the runner applies it), run
 * through `bash -c "jq '<program>'"` (so the shell's quoting applies as the agent's Bash tool
 * applies it), and only then does `jq` read `\r?\n`. `jq` is required, not optional: a guard
 * that skips itself is the silent absence it exists to close.
 */
describe('the capability anchor query, run as composed (RA-899)', () => {
  const m = /"audit-summary in:title"[^`]*?--jq '([^']*)'/.exec(prompt);
  if (!m) throw new Error('the anchor query was not found in the prompt; if it was reworded, update this extractor');
  const PROGRAM = m[1]!;
  const anchor = (issues: Array<{ number: number; body: string }>): number | null => {
    const input = JSON.stringify(issues.map((i) => ({ ...i, state: 'CLOSED', title: 'audit-summary', createdAt: '2026-09-01T07:00:00Z' })));
    const out = execFileSync('bash', ['-c', `jq -c '${PROGRAM}'`], { input, encoding: 'utf8' }).trim();
    return (JSON.parse(out) as { number: number | null } | null)?.number ?? null;
  };
  const selects = (body: string) => anchor([{ number: 1, body }]) === 1;
  const wrap = (line: string) => `## Summary\n\nsome prose\n\n### Ledger delta\n\n${line}\n- one — adopted\n`;

  it('has jq available, so nothing below can pass by being skipped', () => {
    expect(() => execFileSync('jq', ['--version'], { encoding: 'utf8' })).not.toThrow();
  });

  it('searches this repository\'s audits, newest first', () => {
    expect(prompt).toContain('gh search issues --repo ${{ github.repository }} "audit-summary in:title" --limit 30 --sort created --order desc');
  });

  it.each([
    'Watermark: 2.1.260', 'Watermark: `2.1.260`', 'Watermark:2.1.260', '**Watermark:** 2.1.260', '**Watermark**: 2.1.260',
    '_Watermark_: 2.1.260', '`Watermark: 2.1.260`', 'Watermark : 2.1.260', '- Watermark: 2.1.260', '> Watermark: 2.1.260',
    '#### Watermark: 2.1.260', '   Watermark: 2.1.260', '\tWatermark: 2.1.260',
  ])('SELECTS a delta whose Watermark line is %j', (line) => {
    expect(selects(wrap(line))).toBe(true);
  });

  it('SELECTS a Watermark line on the first line, and across CRLF line endings', () => {
    expect(selects('Watermark: 2.1.260\n- one — adopted')).toBe(true);
    expect(selects('## Summary\r\n\r\n### Ledger delta\r\n\r\nWatermark: 2.1.260\r\n- one — adopted')).toBe(true);
  });

  it.each([
    'This run read the Watermark: field from the last audit.',
    'Capability watch: degraded — capability state not carried this run.',
    'No `Ledger delta` block is emitted: the run was cut short.',
    '1. Watermark: 2.1.260',
  ])('REJECTS %j', (body) => {
    expect(selects(`## Summary\n\n${body}\n`)).toBe(false);
  });

  it('selects any Watermark line, value or not, which is why the prompt forbids one without a delta', () => {
    for (const line of ['Watermark: unknown', '**Watermark:** none', '- Watermark: none']) expect(selects(`## Summary\n\n${line}\n`), line).toBe(true);
    expect(flat).toMatch(/WHEN YOU EMIT NO `Ledger delta` BLOCK, WRITE NO `Watermark:` LINE/);
  });

  it('picks the NEWEST carrying audit, stepping over a newer block-less one', () => {
    const newerBlockless = { number: 20, body: '## Summary\n\nCapability watch: not due — capability state not carried this run.\n' };
    expect(anchor([newerBlockless, { number: 10, body: wrap('Watermark: 2.1.260') }, { number: 5, body: wrap('Watermark: 2.1.200') }])).toBe(10);
    expect(anchor([newerBlockless])).toBeNull();
  });
});

describe('the workflow around it', () => {
  it('maps the Overseer\'s App secrets and the Claude token, by name', () => {
    expect(Object.keys(wf.on.workflow_call.secrets).sort()).toEqual(['AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('keeps the weekly schedule, and a dispatch with no inputs', () => {
    expect(caller.on.schedule).toEqual([{ cron: '0 7 * * 1' }]);
    expect(LANE_TEXT).toContain('schedule: "0 7 * * 1"');
    expect(callerInputs(wf.on.workflow_call.inputs)).toBeUndefined();
  });

  it('the caller grants what the store job, the agent job and the delete job need', () => {
    expect(caller.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'write', 'id-token': 'write' });
  });

  it('serialises runs, admits only its caller\'s two triggers, and bounds every job', () => {
    expect({ ...wf.concurrency, group: realGroup(wf.concurrency.group) }).toEqual({ group: 'agent-overseer', 'cancel-in-progress': false });
    expect(wf.jobs.gate!.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    for (const [name, job] of Object.entries(wf.jobs)) expect(job['timeout-minutes'], name).toBeGreaterThan(0);
  });

  it('with no hook, nothing in the lane waits on the store being present: the audit runs without memory', () => {
    for (const [name, job] of Object.entries(wf.jobs)) expect(String(job.if ?? ''), name).not.toMatch(/outputs\.(present|state)/);
  });
});
