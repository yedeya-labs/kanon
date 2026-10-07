import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { unlinkedQuery } from '../../scripts/capability-interlock.mjs';
import { STORE_SECRETS, STORE_SECRETS_WITH, idTokenProblems, isOverseerTelemetryJob, storeLaneProblems, telemetryReads, type Job, type Workflow } from './helpers/store-jobs.js';
import { handedIn, mintFor, readFlattened, workflowText } from './helpers/called-workflow.js';
import { callerInputs, realGroup } from './helpers/smoke-group.js';
import { parseCondition } from './helpers/job-condition.js';

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
    expect(storeLaneProblems(wf, telemetryReads(), { file: 'agent-overseer.yml' })).toEqual([]);
  });

  it('no job declares an environment, and only the store job and the telemetry read job hold id-token', () => {
    const withEnv = Object.entries(wf.jobs).filter(([, j]) => j.environment !== undefined).map(([n]) => n);
    expect(withEnv).toEqual([]);
    const withToken = Object.entries(wf.jobs).filter(([, j]) => typeof j.permissions === 'object' && 'id-token' in j.permissions).map(([n]) => n);
    // The store job, and the telemetry read job (kanon#470), held to its shape below.
    expect(withToken).toEqual(['export', 'telemetry']);
  });

  it('the overseer job declares its own permissions without id-token, and no environment', () => {
    expect(overseer.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'read' });
    expect(overseer.environment).toBeUndefined();
  });

  it('exports the Overseer\'s kind before the agent, and the agent reads that export', () => {
    expect(wf.jobs.export!.steps).toEqual([{ uses: '$/actions/qa-store', id: 'store', with: { operation: 'export', secrets: STORE_SECRETS_WITH, kind: 'overseer' } }]);
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
      return storeLaneProblems(l, telemetryReads(), { file: 'agent-overseer.yml' });
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
    expect(file.needs).toEqual(['gate', 'overseer']);
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
      UPSTREAM: '${{ needs.gate.outputs.upstream }}',
    });
  });

  // kanon#423, `K-LAYOUT-10`: where upstream findings go is the repository's declaration, read
  // before any agent runs, and reaching the filing job only as the gate job's output.
  describe('the upstream choice comes from the gate job, never from the agent', () => {
    const gate = wf.jobs.gate!;
    const gateSteps = (gate.steps ?? []) as Step[];
    const read = gateSteps.find((s) => s.id === 'upstream')!;

    it('is read in the gate job, after the membership gate and only when an audit is due, from the default branch', () => {
      expect(gateSteps.findIndex((s) => s.id === 'upstream')).toBeGreaterThan(gateSteps.findIndex((s) => s.id === 'runtime'));
      expect(gateSteps.findIndex((s) => s.id === 'runtime')).toBeGreaterThan(gateSteps.findIndex((s) => s.id === 'gate'));
      expect(read.if).toBe("steps.runtime.outputs.due == 'true'");
      expect(read.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
      expect(read.run).toContain('upstream="$(node "$KANON/scripts/upstream-findings.mjs")"');
      expect(read.run).toContain('printf \'upstream=%s\\n\' "$upstream" >> "$GITHUB_OUTPUT"');
      expect((gate as { outputs?: Record<string, string> }).outputs?.upstream).toBe('${{ steps.upstream.outputs.upstream }}');
      // Nothing the agent's job produces feeds it: the gate waits for no job.
      expect(gate.needs).toBeUndefined();
    });

    it('fails the gate job on a malformed record, before the agent: the assignment carries the reader\'s exit', () => {
      // GitHub runs `run:` under `bash -e`. The reader exits 1 on a malformed record.
      const script = (reader: string) => `${read.run!.replace('node "$KANON/scripts/upstream-findings.mjs"', reader)}\necho reached`;
      const bash = (reader: string) => spawnSync('bash', ['-e', '-c', script(reader)], { env: { ...process.env, GITHUB_OUTPUT: '/dev/null' }, encoding: 'utf8' });
      const failed = bash('exit 1');
      expect(failed.status).toBe(1);
      expect(failed.stdout).not.toContain('reached');
      expect(bash('echo "filed here"').stdout).toBe('reached\n');
    });

    it('no other job names the choice, and the agent\'s job is never handed it', () => {
      for (const [name, j] of Object.entries(wf.jobs)) {
        const text = JSON.stringify(j);
        if (name === 'gate' || name === 'file') continue;
        expect(text, name).not.toMatch(/outputs\.upstream|\bUPSTREAM\b|upstream-findings/);
      }
      expect(JSON.stringify(fileSteps.filter((s) => s.id !== 'file'))).not.toMatch(/UPSTREAM|outputs\.upstream/);
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
    // Only the telemetry read job (kanon#470) assumes a role; the agent's jobs and every other job
    // of the lane name none.
    const rest = Object.fromEntries(Object.entries(wf.jobs).filter(([n]) => n !== 'telemetry'));
    const agentText = ['.github/workflows/overseer-run.yml', '.github/workflows/overseer-agent-job.yml'].map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const text of [JSON.stringify(rest), agentText]) {
      expect(text).not.toMatch(/configure-aws-credentials|role-to-assume|QA_DYNAMO_TABLE|QA_S3_BUCKET|QA_AWS|vars\.QA_|aws dynamodb|aws s3|environment: qa\b/);
    }
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

  // Plan 0006 F2a (§4.1): one skill for every lane that writes to Kanon, read from Kanon's tree
  // at the lane's release, so the two lanes' evidence can't drift apart.
  it('sends the agent to the upstream-finding skill before it writes an upstream finding\'s evidence', () => {
    expect(flat).toContain("Before writing an upstream finding's `evidence` or `suggested_fix`, read and follow `$KANON/skills/upstream-finding/SKILL.md`.");
    expect(existsSync('skills/upstream-finding/SKILL.md')).toBe(true);
    expect(byId('agent').env?.KANON).toBe('${{ steps.kanon.outputs.path }}');
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
    expect(Object.keys(wf.on.workflow_call.secrets).sort()).toEqual(['AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'KANON_TELEMETRY_READER_ROLE', ...STORE_SECRETS]);
    // Optional, and marked so for lane-check: a caller maps it once its repository has a reader role.
    expect(wf.on.workflow_call.secrets.KANON_TELEMETRY_READER_ROLE).toEqual({ required: false });
    expect(LANE_TEXT).toMatch(/^# OPTIONAL SECRET: KANON_TELEMETRY_READER_ROLE$/m);
  });

  it('keeps the weekly schedule, and a dispatch with no inputs', () => {
    expect(caller.on.schedule).toEqual([{ cron: '0 7 * * 1' }]);
    expect(LANE_TEXT).toContain('schedule: "0 7 * * 1"');
    expect(callerInputs(wf.on.workflow_call.inputs)).toBeUndefined();
  });

  it('the caller grants what the store job, the agent job and the delete job need', () => {
    expect(caller.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'write', 'id-token': 'write' });
  });

  it('serialises runs, admits only its caller\'s triggers, and bounds every job', () => {
    expect({ ...wf.concurrency, group: realGroup(wf.concurrency.group) }).toEqual({ group: 'agent-overseer', 'cancel-in-progress': false });
    expect(wf.jobs.gate!.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request_target' && github.event.action == 'closed' && github.event.pull_request.merged == true)");
    for (const [name, job] of Object.entries(wf.jobs)) expect(job['timeout-minutes'], name).toBeGreaterThan(0);
  });

  it('with no hook, nothing in the lane waits on the store being present: the audit runs without memory', () => {
    for (const [name, job] of Object.entries(wf.jobs)) expect(String(job.if ?? ''), name).not.toMatch(/outputs\.(present|state)/);
  });
});

// kanon#423 (plan 0004 decision 12, amended 2026-10-06): the runtime-version trigger. A caller
// may also run the lane on a merged pull request that moves its Kanon pin, and the lane audits
// only when the agent runtime changed (the Owner's decision), which `scripts/runtime-bump.mjs`
// decides in the gate job (tests/library/runtime-bump.test.ts holds the decision).
describe('the runtime-version trigger', () => {
  const gate = wf.jobs.gate!;
  const gateSteps = (gate.steps ?? []) as Step[];
  const runtime = gateSteps.find((s) => s.id === 'runtime')!;

  /** The gate job's `if:`, evaluated against one event (`==` is case-insensitive on strings, as GitHub's). */
  type Ctx = Record<string, string | boolean | undefined>;
  type Cond = ReturnType<typeof parseCondition>;
  const value = (n: Cond, ctx: Ctx): unknown => {
    switch (n.kind) {
      case 'lit': return n.value;
      case 'ref': return ctx[n.path];
      case 'not': return !value(n.arg, ctx);
      case 'and': return Boolean(value(n.left, ctx)) && Boolean(value(n.right, ctx));
      case 'or': return Boolean(value(n.left, ctx)) || Boolean(value(n.right, ctx));
      case 'cmp': {
        const [l, r] = [value(n.left, ctx), value(n.right, ctx)];
        if (n.op === '==') return l === r;
        if (n.op === '!=') return l !== r;
        throw new Error(`unmodelled ${n.op}`);
      }
      default: throw new Error(`unmodelled ${n.kind}`);
    }
  };
  const admits = (event: string, action?: string, merged?: boolean) => value(parseCondition(String(gate.if)), {
    'github.event_name': event, 'github.event.action': action, 'github.event.pull_request.merged': merged,
  });

  it('starts the gate job on a merged pull_request_target, beside the schedule and a dispatch', () => {
    expect(admits('schedule')).toBe(true);
    expect(admits('workflow_dispatch')).toBe(true);
    expect(admits('pull_request_target', 'closed', true)).toBe(true);
  });

  it('turns away a pull request closed unmerged, any other action, and the smoke run\'s events', () => {
    expect(admits('pull_request_target', 'closed', false)).toBe(false);
    expect(admits('pull_request_target', 'opened', false)).toBe(false);
    expect(admits('pull_request_target', 'labeled', true)).toBe(false);
    for (const event of ['pull_request', 'merge_group', 'push', 'workflow_run']) expect(admits(event, 'closed', true), event).toBe(false);
  });

  it('decides in the gate job, right after the membership gate and the capability watch, and only when it admitted', () => {
    expect(gateSteps.findIndex((s) => s.id === 'watch')).toBe(gateSteps.findIndex((s) => s.id === 'gate') + 1);
    expect(gateSteps.findIndex((s) => s.id === 'runtime')).toBe(gateSteps.findIndex((s) => s.id === 'watch') + 1);
    expect(runtime.if).toBe("steps.gate.outputs.member == 'true'");
    expect(runtime.env).toEqual({ GH_TOKEN: '${{ github.token }}', CAPABILITY_WATCH: '${{ steps.watch.outputs.watch }}' });
    expect(runtime.run).toContain('due="$(node "$KANON/scripts/runtime-bump.mjs")"');
    expect(runtime.run).toContain('printf \'due=%s\\n\' "$due" >> "$GITHUB_OUTPUT"');
    expect((gate as { outputs?: Record<string, string> }).outputs?.due).toBe('${{ steps.runtime.outputs.due }}');
  });

  it('holds the store job, and so the agent and the filing, behind the answer', () => {
    expect(wf.jobs.export!.if).toBe("needs.gate.outputs.member == 'true' && needs.gate.outputs.due == 'true'");
    // Everything that spends goes through the export: the agent's job needs it to succeed. It
    // also needs the gate, for the capability watch the gate read (kanon#477).
    expect(overseer.needs).toEqual(['gate', 'export', 'telemetry']);
    expect(wf.jobs.telemetry!.if).toBe("needs.gate.outputs.member == 'true' && needs.gate.outputs.due == 'true' && needs.gate.outputs.reader == 'true' && github.event_name != 'pull_request_target'");
  });

  // The review on #430: the agent must learn the trigger from the workflow, and on it the weekly
  // due test and the store's expected refusal must not cancel or taint the review it was run for.
  it('tells the agent its trigger, from the event, not by inference', () => {
    expect(prompt).toContain("THIS RUN'S TRIGGER is `${{ github.event_name }}`.");
    expect(flat).toContain('`pull_request_target` is the RUNTIME-VERSION TRIGGER');
  });

  it('makes the capability review due whatever the week on that trigger, and keeps the weekly due test otherwise', () => {
    expect(flat).toContain('DUE TEST: ON THE RUNTIME-VERSION TRIGGER (`pull_request_target`) THE REVIEW IS ALWAYS DUE, whatever the week: skip this test and run it');
    expect(flat).toContain("Otherwise: if the last capability audit's line reads `ran, through …` AND that audit is dated in the CURRENT ISO week (Monday to Sunday, UTC), print exactly `Capability watch: not due this audit`");
    // The anchor rules hold: the triggered audit carries its delta and anchors the next run.
    expect(flat).toContain('A runtime-triggered audit is a capability audit like any other: it carries its `Ledger delta` and becomes the anchor');
  });

  it('treats a degraded store as expected on that trigger, and as a finding otherwise', () => {
    expect(flat).toContain('an unreadable store is a finding, not a pass. EXCEPT ON THE RUNTIME-VERSION TRIGGER (`pull_request_target`)');
    expect(flat).toContain('so a `degraded` store is EXPECTED there. Say in one line that the store is not read on this trigger, and raise no finding for it. An `absent` store is judged as on any run.');
  });

  it('fails the gate job if the decision itself fails, rather than reading an empty answer', () => {
    const script = (reader: string) => `${runtime.run!.replace('node "$KANON/scripts/runtime-bump.mjs"', reader)}\necho reached`;
    const bash = (reader: string) => spawnSync('bash', ['-e', '-c', script(reader)], { env: { ...process.env, GITHUB_OUTPUT: '/dev/null' }, encoding: 'utf8' });
    expect(bash('exit 2').stdout).not.toContain('reached');
    expect(bash('echo false').stdout).toBe('reached\n');
  });
});

// kanon#477 (the Owner's decision of 2026-10-07): the capability watch is the adoption record's
// `Capability watch:` choice, off by default. The gate job reads it from the default branch
// before any agent runs; off, the runtime-version trigger doesn't audit
// (tests/library/runtime-bump.test.ts) and the prompt skips the capability section.
describe('the capability watch is a declared choice, off by default', () => {
  const gate = wf.jobs.gate!;
  const gateSteps = (gate.steps ?? []) as Step[];
  const read = gateSteps.find((s) => s.id === 'watch')!;

  it('is read in the gate job, from the default branch, before the runtime check and any agent', () => {
    expect(read.if).toBe("steps.gate.outputs.member == 'true'");
    expect(read.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(read.run).toContain('watch="$(node "$KANON/scripts/capability-watch.mjs")"');
    expect(read.run).toContain('printf \'watch=%s\\n\' "$watch" >> "$GITHUB_OUTPUT"');
    expect((gate as { outputs?: Record<string, string> }).outputs?.watch).toBe('${{ steps.watch.outputs.watch }}');
  });

  it('fails the gate job on a malformed record, before the agent: the assignment carries the reader\'s exit', () => {
    const script = (reader: string) => `${read.run!.replace('node "$KANON/scripts/capability-watch.mjs"', reader)}\necho reached`;
    const bash = (reader: string) => spawnSync('bash', ['-e', '-c', script(reader)], { env: { ...process.env, GITHUB_OUTPUT: '/dev/null' }, encoding: 'utf8' });
    expect(bash('exit 1').stdout).not.toContain('reached');
    expect(bash('echo on').stdout).toBe('reached\n');
  });

  it('reaches the agent\'s job only as the gate job\'s output, through both called workflows', () => {
    expect(handedIn(LANE_FILE, 'overseer', 'capability-watch')).toBe('${{ needs.gate.outputs.watch }}');
    const run = parse(readFileSync('.github/workflows/overseer-run.yml', 'utf8')) as { on: { workflow_call: { inputs: Record<string, { default?: string }> } }; jobs: Record<string, { with?: Record<string, string> }> };
    expect(run.on.workflow_call.inputs['capability-watch']?.default).toBe('off');
    expect(run.jobs.overseer!.with?.['capability-watch']).toBe('${{ inputs.capability-watch }}');
    const job = parse(readFileSync('.github/workflows/overseer-agent-job.yml', 'utf8')) as { on: { workflow_call: { inputs: Record<string, { default?: string }> } } };
    expect(job.on.workflow_call.inputs['capability-watch']?.default).toBe('off');
    expect(prompt).toContain('is `${{ inputs.capability-watch }}`');
  });

  it('tells the agent, with the watch off, to print the off-by-choice status line and skip the review', () => {
    expect(flat).toContain('IF IT IS NOT `on`, the watch is OFF BY CHOICE: print exactly `Capability watch: off by choice — this repository\'s adoption record does not declare it` as the `### Capability watch` section, and skip the rest of this bullet.');
    expect(flat).toContain('Read no ledger and no changelog, write no `Ledger delta` block and no `Watermark:` line');
    expect(flat).toMatch(/raise no finding for the absent review or a missing ledger/);
    // The status-line rule (K-SELF-17) names it as one of the lines a section opens with.
    expect(flat).toMatch(/`Capability watch: degraded — <what failed>`, or, with the watch off, the `off by choice` line above/);
  });
});

// kanon#470 (the Owner's decision, option A): the Overseer's own cost view, read from the hosted
// telemetry store with the repository's reader role, in a store job of its own, handed to the
// agent as two files and a status, never as rows.
describe('the telemetry read job (kanon#470)', () => {
  const job = wf.jobs.telemetry!;
  const s = (job.steps ?? []) as Step[];
  const all = () => Object.fromEntries(readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, parse(readFileSync(join('.github/workflows', f), 'utf8')) as Workflow]));

  it('is allowed to hold id-token by its exact shape, and holds nothing else', () => {
    expect(isOverseerTelemetryJob('agent-overseer.yml', 'telemetry', job)).toBe(true);
    expect(job.permissions).toEqual({ 'id-token': 'write' });
    expect(job.environment).toBeUndefined();
    expect(s.map((x) => x.uses ?? x.name)).toEqual(['$/actions/kanon-path', "Mask the reader role's account id and key, and resolve the store",
      'aws-actions/configure-aws-credentials@v6', "Read this repository's telemetry into the two reports", 'actions/upload-artifact@v7']);
    expect(s[2]!.with).toEqual({ 'role-to-assume': '${{ secrets.KANON_TELEMETRY_READER_ROLE }}', 'aws-region': '${{ steps.resolve.outputs.region }}', 'role-session-name': 'kanon-overseer-telemetry' });
    expect(s[2]!['continue-on-error']).toBe(true);
    expect(s[4]!.if).toBe("steps.read.outputs.status == 'ran'");
    expect(s[4]!.with).toMatchObject({ path: '${{ runner.temp }}/overseer-telemetry', 'retention-days': 1 });
  });

  it('runs only with a reader role, which the gate job says without printing it', () => {
    const reader = (wf.jobs.gate!.steps as Step[]).find((x) => x.id === 'reader')!;
    expect(reader.env).toEqual({ ROLE: '${{ secrets.KANON_TELEMETRY_READER_ROLE }}' });
    expect(reader.run).not.toMatch(/echo "\$ROLE"|printf[^\n]*\$ROLE/);
    expect((wf.jobs.gate as { outputs?: Record<string, string> }).outputs?.reader).toBe('${{ steps.reader.outputs.reader }}');
  });

  it('hands the agent\'s job a status and the artifact, never the role, and deletes the artifact after it', () => {
    expect(handedIn(LANE_FILE, 'overseer', 'telemetry-status')).toBe("${{ needs.gate.outputs.reader != 'true' && 'not configured' || github.event_name == 'pull_request_target' && 'not run on this trigger' || (needs.telemetry.outputs.status == 'ran' && needs.telemetry.outputs.attempt == github.run_attempt) && 'ran' || 'failed' }}");
    expect(handedIn(LANE_FILE, 'overseer', 'telemetry-artifact-name')).toBe('kanon-overseer-telemetry-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(JSON.stringify(overseer)).not.toContain('KANON_TELEMETRY_READER_ROLE');
    const del = wf.jobs['delete-telemetry']!;
    expect(del.if).toBe('always()');
    expect(del.permissions).toEqual({ 'actions': 'write' });
    expect(del.steps).toEqual([{ uses: '$/actions/qa-store', with: { operation: 'delete-export', 'artifact-id': '${{ needs.telemetry.outputs.artifact-id }}', 'export-attempt': '${{ needs.telemetry.outputs.attempt }}', 'agent-result': '${{ needs.overseer.result }}', 'artifact-kind': 'telemetry' } }]);
  });

  it('adds the two files and the status to the export before the token trend and the agent', () => {
    const download = at((x) => x.name === 'Download the telemetry read');
    const add = at((x) => x.name === 'Add the telemetry read to the export');
    expect(download).toBeGreaterThan(at((x) => x.id === 'kanon'));
    expect(add).toBe(download + 1);
    expect(add).toBeLessThan(at((x) => x.id === 'trend'));
    expect(steps[download]!.if).toBe("inputs.telemetry-status == 'ran'");
    expect(steps[download]!['continue-on-error']).toBe(true);
    expect(steps[add]!.run).toBe('node "$KANON/scripts/overseer-telemetry.mjs" merge');
    expect(steps[add]!.env).toEqual({ TELEMETRY_STATUS: '${{ inputs.telemetry-status }}', TELEMETRY_DIR: '${{ runner.temp }}/overseer-telemetry', EXPORT_DIR: 'qa-store-export' });
    expect(byId('trend').run).toContain('.telemetry');
    expect(byId('trend').run).not.toContain('.store)');
  });

  it('tells the agent to report the read\'s status, and never to infer an absent store', () => {
    expect(flat).toContain('`ran` (both files are computed from this repository\'s own telemetry rows), `not configured` (no telemetry reader role is mapped, so it wasn\'t read), `not run on this trigger`');
    expect(flat).toContain('or `failed` (the read was tried and didn\'t work)');
    expect(flat).toContain('a missing file NEVER means that the telemetry store, the QA store or telemetry itself is absent or not installed, so never say so.');
    expect(flat).toContain('`cache-ttl: UNAVAILABLE — no cache-ttl.md (telemetry read: <status>)`');
    expect(flat).toContain('ON THE RUNTIME-VERSION TRIGGER (`pull_request_target`) the status is `not run on this trigger`: report it as it is, in one line, and raise no finding for it.');
    expect(flat).toContain('`not run on this trigger` (the runtime-version trigger, whose token the reader role refuses, so the read wasn\'t tried)');
  });

  // kanon#499: on the runtime-version trigger the role refuses the token, so the job isn't run
  // and the status says so, as a fourth value.
  describe('the runtime-version trigger: the read is not run, and says so', () => {
    type Ctx = Record<string, string | boolean | undefined>;
    type Cond = ReturnType<typeof parseCondition>;
    const value = (n: Cond, ctx: Ctx): unknown => {
      switch (n.kind) {
        case 'lit': return n.value;
        case 'ref': return ctx[n.path];
        case 'not': return !value(n.arg, ctx);
        case 'and': { const l = value(n.left, ctx); return l ? value(n.right, ctx) : l; }
        case 'or': { const l = value(n.left, ctx); return l ? l : value(n.right, ctx); }
        case 'cmp': {
          const [l, r] = [value(n.left, ctx), value(n.right, ctx)];
          if (n.op === '==') return l === r;
          if (n.op === '!=') return l !== r;
          throw new Error(`unmodelled ${n.op}`);
        }
        default: throw new Error(`unmodelled ${n.kind}`);
      }
    };
    const expr = (e: string) => e.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const runs = (event: string) => Boolean(value(parseCondition(String(wf.jobs.telemetry!.if)), {
      'needs.gate.outputs.member': 'true', 'needs.gate.outputs.due': 'true', 'needs.gate.outputs.reader': 'true', 'github.event_name': event,
    }));
    const status = (ctx: Ctx) => value(parseCondition(expr(String(handedIn(LANE_FILE, 'overseer', 'telemetry-status')))), {
      'needs.gate.outputs.reader': 'true', 'github.event_name': 'schedule', 'github.run_attempt': '1', 'needs.telemetry.outputs.attempt': '1', 'needs.telemetry.outputs.status': 'ran', ...ctx,
    });

    it('runs the read job on the schedule and a dispatch, and not on the trigger', () => {
      expect(runs('schedule')).toBe(true);
      expect(runs('workflow_dispatch')).toBe(true);
      expect(runs('pull_request_target')).toBe(false);
    });

    it('hands the agent each of the four statuses', () => {
      expect(status({})).toBe('ran');
      expect(status({ 'needs.gate.outputs.reader': 'false' })).toBe('not configured');
      expect(status({ 'github.event_name': 'pull_request_target', 'needs.telemetry.outputs.status': undefined, 'needs.telemetry.outputs.attempt': undefined })).toBe('not run on this trigger');
      expect(status({ 'needs.gate.outputs.reader': 'false', 'github.event_name': 'pull_request_target' })).toBe('not configured');
      expect(status({ 'needs.telemetry.outputs.status': 'failed' })).toBe('failed');
      expect(status({ 'needs.telemetry.outputs.attempt': '2' })).toBe('failed');
    });
  });

  // kanon#499 (Owner, 2026-10-07: repository variables, not a caller-setting marker): the table and
  // region come from the repository variables, resolved ONCE by the mask step, whose outputs every
  // later step takes, so an unset or empty variable is the hosted store's value everywhere.
  it('reads the table and region from the repository variables once, and hands every later step the resolved value', () => {
    expect(s[1]!.id).toBe('resolve');
    expect(s[1]!.env).toEqual({ ROLE: '${{ secrets.KANON_TELEMETRY_READER_ROLE }}', TABLE: '${{ vars.KANON_TELEMETRY_TABLE }}', REGION: '${{ vars.KANON_TELEMETRY_REGION }}' });
    expect(s[2]!.with?.['aws-region']).toBe('${{ steps.resolve.outputs.region }}');
    expect(s[3]!.env).toMatchObject({ TABLE: '${{ steps.resolve.outputs.table }}', REGION: '${{ steps.resolve.outputs.region }}' });
    // No other step, and no job of the lane, reads the variables raw.
    const raw = JSON.stringify(wf.jobs).match(/vars\.KANON_TELEMETRY_(TABLE|REGION)/g) ?? [];
    expect(raw).toEqual(['vars.KANON_TELEMETRY_TABLE', 'vars.KANON_TELEMETRY_REGION']);
    expect(wf.on.workflow_call.inputs).not.toHaveProperty('telemetry-table');
    expect(LANE_TEXT).not.toMatch(/CALLER SETTING/);
  });

  describe('mutations: each turns the id-token guard red, by name', () => {
    const red = (change: (j: LaneJob) => void) => {
      const w = all();
      change(w['agent-overseer.yml']!.jobs.telemetry as LaneJob);
      return idTokenProblems(w);
    };
    const named = [
      "agent-overseer.yml: job telemetry holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the store maintenance job, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may",
    ];
    it('the guard is green as shipped', () => expect(idTokenProblems(all())).toEqual([]));
    it('a step added', () => expect(red((j) => { j.steps!.push({ run: 'echo hi' }); })).toEqual(named));
    it('the read step handed NODE_OPTIONS', () => expect(red((j) => { j.steps![3]!.env = { ...j.steps![3]!.env, NODE_OPTIONS: '-r x' }; })).toEqual(named));
    it('another mode of the script in the read step', () => expect(red((j) => { j.steps![3]!.run = 'node "$KANON/scripts/overseer-telemetry.mjs" merge'; })).toEqual(named));
    it('the masking step handed every variable', () => expect(red((j) => { j.steps![1]!.env = { VARS: '${{ toJSON(vars) }}' }; })).toEqual(named));
    it('the role from anywhere but the lane\'s secret', () => expect(red((j) => { (j.steps![2]!.with as Record<string, unknown>)['role-to-assume'] = '${{ vars.KANON_TELEMETRY_READER_ROLE }}'; })).toEqual(named));
    it('a wider grant', () => expect(red((j) => { j.permissions = { 'id-token': 'write', contents: 'read' }; })).toEqual(named));
    it('the upload from the workspace', () => expect(red((j) => { (j.steps![4]!.with as Record<string, unknown>).path = 'overseer-telemetry'; })).toEqual(named));
    it('a job env', () => expect(red((j) => { (j as Record<string, unknown>).env = { NODE_OPTIONS: '-r x' }; })).toEqual(named));
    it('a region read raw, not the one the mask step resolved', () => expect(red((j) => { (j.steps![2]!.with as Record<string, unknown>)['aws-region'] = '${{ vars.KANON_TELEMETRY_REGION }}'; })).toEqual(named));
    it('a table read raw by the read step', () => expect(red((j) => { j.steps![3]!.env = { ...j.steps![3]!.env, TABLE: '${{ vars.KANON_TELEMETRY_TABLE }}' }; })).toEqual(named));
    it('the variables left out of the mask step, which resolves them first', () => expect(red((j) => { j.steps![1]!.env = { ROLE: '${{ secrets.KANON_TELEMETRY_READER_ROLE }}' }; })).toEqual(named));
    it('the mask step without its id, so nothing reads what it resolved', () => expect(red((j) => { delete (j.steps![1] as Record<string, unknown>).id; })).toEqual(named));
    it('the same job under another name, or in another workflow, is not allowed by this shape', () => {
      const w = all();
      w['agent-code-audit.yml']!.jobs.telemetry = structuredClone(w['agent-overseer.yml']!.jobs.telemetry!);
      expect(idTokenProblems(w)).toEqual(["agent-code-audit.yml: job telemetry holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the store maintenance job, the telemetry collector job, the aggregate read job or the Overseer telemetry read job, may"]);
      expect(isOverseerTelemetryJob('agent-overseer.yml', 'reader', w['agent-overseer.yml']!.jobs.telemetry!)).toBe(false);
    });
  });
});

describe("Kanon's Overseer playbook names every lane caller it waives (kanon#450)", () => {
  // The playbook's liveness table is where the Overseer finds a lane's runs on Kanon, whose
  // callers aren't at their lanes' names. Each such caller is waived by name in the adoption
  // record, so a caller waived there and missing from the table is a lane whose liveness the
  // Overseer would read from a lookup that comes back empty.
  const waived = [...readFileSync('docs/qa/adoption.md', 'utf8')
    .matchAll(/^- \*\*Waived doctor finding:\*\* `caller\.misplaced` on `\.github\/workflows\/([^`]+)`/gm)].map((m) => m[1]);
  const liveness = readFileSync('docs/qa/overseer-playbook.md', 'utf8').split(/^## /m).find((s) => s.startsWith('Liveness queries')) ?? '';
  const table = new Set([...liveness.matchAll(/^\| [^|]+ \| `([^`]+)` \|/gm)].map((m) => m[1]));

  it('reads both, so the check is not vacuous', () => {
    expect(waived.length).toBeGreaterThanOrEqual(6);
    expect(table.size).toBeGreaterThanOrEqual(6);
  });

  it('has a liveness row for each waived caller', () => {
    expect(waived.filter((f) => !table.has(f))).toEqual([]);
  });
});
