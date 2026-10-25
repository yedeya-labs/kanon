import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AGGREGATE_FILE, AGGREGATE_JOB, AGGREGATE_TOKEN_ENV, agentJobProblems, idTokenProblems, isAggregateJob, telemetryReads, type Job, type Workflow } from './helpers/store-jobs.js';
import { handedIn, mintFor, readFlattened, workflowText } from './helpers/called-workflow.js';
import { LANES, LANE_ROLES } from '../../actions/agent-telemetry/schema.mjs';
import { TRIGGERS } from '../../cli/callers.mjs';
import { FINDING_ARTIFACT_FILE, findingArtifactName } from '../../scripts/lib/telemetry-artifacts.mjs';

/**
 * Plan 0004 step 14 (decision 13), plan 0002 §6.1: the Explorer's telemetry mode, a lane of its
 * own (`agent-explore-telemetry.yml`). One job, `aggregate`, holds `id-token: write`: it sends a
 * fresh GitHub OIDC token to the aggregate-only function's token URL with a `GET` (plan 0008 §3.6,
 * step J5), and hands the checked answer on as an artifact. The agent's job holds no cloud credentials and
 * a token that reads only. A `file` job with no agent checks the agent's findings against the
 * aggregate and files them (`scripts/telemetry-file.mjs`, held by
 * `tests/library/telemetry-file.test.ts`).
 */

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: boolean };
type LaneJob = Job & { steps?: Step[]; 'timeout-minutes'?: number };
type Lane = Workflow & { on: { workflow_call: { inputs?: Record<string, unknown>; secrets: Record<string, unknown> } }; jobs: Record<string, LaneJob> };

const WF = '.github/workflows';
const LANE_FILE = `${WF}/agent-explore-telemetry.yml`;
const raw = (): Lane => parse(readFileSync(LANE_FILE, 'utf8')) as Lane;
const wf = raw();
const flat = readFlattened(LANE_FILE) as Lane;
const explore = flat.jobs.explore!;
const steps = (explore.steps ?? []) as Step[];
const byId = (id: string) => steps.find((s) => s.id === id)!;
const prompt = String(byId('agent').with?.prompt).replace(/\s+/g, ' ');
const all = (): Record<string, Workflow> => Object.fromEntries(readdirSync(WF).filter((f) => /\.ya?ml$/.test(f))
  .map((f) => [f, parse(readFileSync(join(WF, f), 'utf8')) as Workflow]));

describe('where the mode lives: a lane of its own, any repository can install', () => {
  it('is a lane in the telemetry schema, the caller catalogue and the Explorer\'s role', () => {
    expect(LANES).toContain('explore-telemetry');
    expect(LANE_ROLES['explore-telemetry']).toBe('explorer');
    expect(TRIGGERS['agent-explore-telemetry']).toEqual({ name: 'Explore the telemetry (Explorer)', job: 'explore', schedule: '30 6 * * 2', dispatch: {} });
    expect(readFileSync(LANE_FILE, 'utf8')).toMatch(/^# KANON ROLE: Explorer$/m);
    expect(byId('finish').with).toMatchObject({ lane: 'explore-telemetry', agent: 'telemetry-explorer' });
  });

  it('names no repository, no account and no key, and takes no role: a self-hosted store is two variables, the hosted one a constant (plan 0008 J5)', () => {
    const text = workflowText(LANE_FILE);
    expect(text).not.toMatch(/arn:aws|\d{12}|lambda-url\.[a-z0-9-]+\.on\.aws\//);
    expect(text).not.toMatch(/yedeya-labs\/kanon[^/]|github\.repository == /);
    const vars = [...new Set([...text.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
    expect(vars).toEqual(['KANON_AGGREGATE_TOKEN_URL', 'KANON_TELEMETRY_AUDIENCE']);
    // No AWS credential anywhere in the lane: the token is the only way in.
    expect(JSON.stringify(wf.jobs)).not.toMatch(/configure-aws-credentials|KANON_AGGREGATE_ROLE|KANON_AGGREGATE_URL\b/);
    // The invoker role's secret stays declared, optional and read by no job, so a caller that
    // still maps it isn't refused when its pin moves (plan 0008 §9 step 4).
    expect(wf.on.workflow_call.secrets).toEqual({
      AUTHOR_APP_ID: { required: true }, AUTHOR_APP_PRIVATE_KEY: { required: true }, CLAUDE_CODE_OAUTH_TOKEN: { required: false },
      ANTHROPIC_API_KEY: { required: false },
      KANON_AGGREGATE_ROLE: { required: false },
    });
    expect(text).toMatch(/^# OPTIONAL SECRET: KANON_AGGREGATE_ROLE$/m);
  });
});

describe('the aggregate job: the only one with id-token (K-OBS-17\'s shape)', () => {
  it('holds id-token, and no other job of the lane does', () => {
    const withToken = Object.entries(wf.jobs).filter(([, j]) => typeof j.permissions === 'object' && 'id-token' in j.permissions).map(([n]) => n);
    expect(withToken).toEqual([AGGREGATE_JOB]);
    expect(Object.values(wf.jobs).filter((j) => j.environment !== undefined)).toEqual([]);
    expect(isAggregateJob('agent-explore-telemetry.yml', AGGREGATE_JOB, wf.jobs.aggregate!)).toBe(true);
    expect(AGGREGATE_FILE).toBe('agent-explore-telemetry.yml');
  });

  it('reads on the token URL in three steps, the two variables by name, and never passes toJSON(vars) (plan 0008 J5, kanon#433)', () => {
    const s = wf.jobs.aggregate!.steps as Step[];
    expect(s.map((x) => x.uses ?? x.name)).toEqual(['$/actions/kanon-path', 'Read the aggregate', 'actions/upload-artifact@v7']);
    expect(s[1]!.run).toBe('node "$KANON/scripts/aggregate-read.mjs" token');
    expect(s[1]!.env).toEqual(AGGREGATE_TOKEN_ENV);
    expect(AGGREGATE_TOKEN_ENV).toEqual({ KANON_AGGREGATE_TOKEN_URL: '${{ vars.KANON_AGGREGATE_TOKEN_URL }}', KANON_TELEMETRY_AUDIENCE: '${{ vars.KANON_TELEMETRY_AUDIENCE }}', OUT: '${{ runner.temp }}/aggregate' });
    expect(workflowText(LANE_FILE)).not.toMatch(/\$\{\{\s*toJSON\(vars\)/);
    expect(s[2]!.with).toMatchObject({ path: '${{ runner.temp }}/aggregate/aggregate.json', 'retention-days': 1, 'if-no-files-found': 'error' });
  });

  it('runs only for a member, with a store to call, on the default branch\'s ref, which the store admits', () => {
    const cond = String(wf.jobs.aggregate!.if).replace(/\s+/g, ' ');
    expect(cond).toBe("needs.gate.outputs.member == 'true' && needs.gate.outputs.configured == 'true' && (github.event_name == 'schedule' || github.ref_name == github.event.repository.default_branch)");
    // The gate's step asks the read script whether there is a store, before any token is minted.
    const gate = wf.jobs.gate!.steps as Step[];
    const configured = gate.find((x) => x.id === 'configured')!;
    expect(configured.if).toBe("steps.gate.outputs.member == 'true'");
    expect(configured.env).toEqual({ GH_TOKEN: '${{ github.token }}', KANON_AGGREGATE_TOKEN_URL: '${{ vars.KANON_AGGREGATE_TOKEN_URL }}', KANON_TELEMETRY_AUDIENCE: '${{ vars.KANON_TELEMETRY_AUDIENCE }}' });
    expect(configured.run).toContain('configured="$(node "$KANON/scripts/explore-telemetry-check.mjs")"');
    expect(wf.jobs.gate!.permissions).toEqual({ contents: 'read' });
    // And when it doesn't run, a job says why, green.
    expect(String(wf.jobs.unconfigured!.if).replace(/\s+/g, ' ')).toContain("needs.gate.outputs.configured != 'true'");
    expect(wf.jobs.unconfigured!.permissions).toEqual({});
  });

  describe('mutations: each turns the id-token guard red, by name', () => {
    const red = (change: (j: LaneJob) => void) => {
      const w = all();
      change(w[AGGREGATE_FILE]!.jobs[AGGREGATE_JOB] as LaneJob);
      return idTokenProblems(w);
    };
    // The job itself, and the two callers that grant id-token to a lane left with no job that
    // may hold it: the smoke caller, and Kanon's own caller (kanon#443), whose workflow grants it.
    const named = [
      `${AGGREGATE_FILE}: job ${AGGREGATE_JOB} holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the store maintenance job, the telemetry collector job, the aggregate read job, the Overseer telemetry read job or the metrics page read job, may`,
      `agent-lanes-smoke.yml: job explore-telemetry holds id-token: write (its own permissions grant) and calls ${AGGREGATE_FILE}, which has no store job to pass it to`,
      `explore-telemetry.yml: job explore holds id-token: write (it declares no permissions, so it inherits the workflow's) and calls ${AGGREGATE_FILE}, which has no store job to pass it to`,
    ];
    it('the guard is green as shipped', () => expect(idTokenProblems(all())).toEqual([]));
    it('a step added', () => expect(red((j) => { j.steps!.push({ run: 'echo hi' }); })).toEqual(named));
    it('the read step handed NODE_OPTIONS', () => expect(red((j) => { j.steps![1]!.env = { ...j.steps![1]!.env, NODE_OPTIONS: '-r x' }; })).toEqual(named));
    it('the read step handed every variable', () => expect(red((j) => { j.steps![1]!.env = { ...j.steps![1]!.env, VARS: '${{ toJSON(vars) }}' }; })).toEqual(named));
    it('another script in the read step', () => expect(red((j) => { j.steps![1]!.run = 'node "$KANON/scripts/telemetry-collect.mjs"'; })).toEqual(named));
    it('the SigV4 read back in the job', () => expect(red((j) => { j.steps![1]!.run = 'node "$KANON/scripts/aggregate-read.mjs"'; })).toEqual(named));
    it('an AWS credentials step back in the job', () => expect(red((j) => { j.steps!.splice(1, 0, { uses: 'aws-actions/configure-aws-credentials@v6', with: { 'role-to-assume': '${{ secrets.KANON_AGGREGATE_ROLE }}' } }); })).toEqual(named));
    it('the read dropped, so the job only uploads', () => expect(red((j) => { j.steps!.splice(1, 1); })).toEqual(named));
    it('a wider grant', () => expect(red((j) => { j.permissions = { 'id-token': 'write', contents: 'read' }; })).toEqual(named));
    it('the upload from the workspace', () => expect(red((j) => { (j.steps![2]!.with as Record<string, unknown>).path = 'qa-telemetry'; })).toEqual(named));
    it('a job env', () => expect(red((j) => { (j as Record<string, unknown>).env = { NODE_OPTIONS: '-r x' }; })).toEqual(named));
    it('the same job in another workflow is not allowed by this shape', () => {
      const w = all();
      w['agent-code-audit.yml']!.jobs[AGGREGATE_JOB] = structuredClone(w[AGGREGATE_FILE]!.jobs[AGGREGATE_JOB]!);
      expect(idTokenProblems(w)).toEqual([`agent-code-audit.yml: job ${AGGREGATE_JOB} holds id-token: write (its own permissions grant); only a job that runs the qa-store block alone, the store maintenance job, the telemetry collector job, the aggregate read job, the Overseer telemetry read job or the metrics page read job, may`]);
    });
  });
});

describe('the agent\'s job: no cloud credentials, a token that reads, and something to read', () => {
  it('declares its own permissions without id-token, and reads what the telemetry step reads (P9\'s check)', () => {
    expect(wf.jobs.explore!.permissions).toEqual({ contents: 'read', issues: 'read', actions: 'read' });
    expect(agentJobProblems('explore', explore, telemetryReads())).toEqual([]);
  });

  it('mints a token that reads the tree and issues, and nothing that writes', () => {
    const mint = mintFor(LANE_FILE, 'explore');
    const perms = Object.fromEntries(Object.entries(mint.with as Record<string, string>).filter(([k]) => k.startsWith('permission-')));
    expect(perms).toEqual({ 'permission-contents': 'read', 'permission-issues': 'read' });
    expect(byId('agent').with?.['github-token']).toBe('${{ steps.app-token.outputs.token }}');
  });

  it('runs only when the aggregate holds something, and only on the attempt that read it', () => {
    expect(wf.jobs.explore!.if).toBe("needs.aggregate.outputs.empty == 'false' && needs.aggregate.outputs.attempt == github.run_attempt");
    expect(handedIn(LANE_FILE, 'explore', 'artifact-name')).toBe('kanon-explore-aggregate-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(byId('agent') ? steps.find((s) => s.uses?.startsWith('actions/download-artifact@'))!.with : null).toEqual({ name: '${{ inputs.artifact-name }}', path: 'qa-telemetry' });
  });

  it('is told the report\'s shape the filing step reads, and the rules it holds each finding to', () => {
    for (const key of ['qa-telemetry-findings.json', '"examined"', '"held_back"', '"findings"', '"signals"', '"cells"', '"severity"', '"source": "own"', '"source": "cross_adopter"']) expect(prompt).toContain(key);
    expect(prompt).toContain('NO DIGIT IN THE TITLE OR THE BODY');
    expect(prompt).toContain('You file nothing and comment on nothing');
    expect(prompt).toContain('No findings is a good run');
    expect(prompt).toContain('qa-telemetry/aggregate.json');
    expect(prompt).not.toMatch(/aws |dynamodb|curl /i);
  });

  // Plan 0006 F2a (§4.1): the same skill the Overseer reads, from Kanon's tree at the lane's release.
  it('is sent to the upstream-finding skill before it writes an upstream finding\'s evidence', () => {
    expect(prompt).toContain("Before writing an upstream finding's `evidence` or `suggested_fix`, read and follow `$KANON/skills/upstream-finding/SKILL.md`.");
    expect(existsSync('skills/upstream-finding/SKILL.md')).toBe(true);
    expect(byId('agent').env?.KANON).toBe('${{ steps.kanon.outputs.path }}');
  });

  it('uploads its report whatever happened, after the telemetry row', () => {
    const report = byId('report');
    expect(report.if).toBe('always()');
    expect(report.with).toMatchObject({ name: 'qa-telemetry-findings-${{ github.run_id }}-${{ github.run_attempt }}', path: 'qa-telemetry-findings.json', 'retention-days': 1 });
    expect(steps.findIndex((s) => s.id === 'finish')).toBeLessThan(steps.findIndex((s) => s.id === 'report'));
  });

  // GATED ON THE AGENT STEP TOO (kanon#1260). The agent step is `continue-on-error`, so its
  // failure leaves the job green and `failure()` false: gated on `failure()` alone, the notice
  // RA-1408 added for a capped agent never printed for this lane's own agent.
  it('explains a failed agent, though its job stays green, and a red job', () => {
    expect(steps.at(-1)!.name).toBe('Revoke the App token');
    const classify = steps[steps.length - 2]!;
    expect(classify.uses).toBe('$/actions/agent-classify');
    expect(byId('agent')['continue-on-error']).toBe(true);
    expect(classify.if).toBe("always() && (steps.agent.outcome == 'failure' || failure())");
    expect(classify.with?.['agent-outcome']).toBe('${{ steps.agent.outcome }}');
    expect(byId('finish').with?.classify).toBe('false');
  });
});

describe('the file job: no agent, and the only token that writes', () => {
  const file = wf.jobs.file!;
  const fsteps = (file.steps ?? []) as Step[];
  const perms = (s: Step) => Object.entries(s.with ?? {}).filter(([k]) => k.startsWith('permission-'));
  it('checks out nothing, runs no agent, and mints issues: write alone, only when the repository files its findings itself', () => {
    expect(fsteps.some((s) => /agent-(run|setup|finish)|claude-code-action|actions\/checkout@/.test(s.uses ?? ''))).toBe(false);
    expect(file.permissions).toEqual({});
    const mint = fsteps.filter((s) => s.uses?.startsWith('actions/create-github-app-token@'));
    expect(mint.map((s) => s.id)).toEqual(['file-token', 'names-token']);
    expect(mint[0]!.if).toBe("needs.gate.outputs.upstream == 'filed here'");
    expect(perms(mint[0]!)).toEqual([['permission-issues', 'write']]);
  });

  // The Owner's decision on kanon#606 (`K-AGENT-46`): with `sent with evidence`, and only then,
  // the file job mints a READ-ONLY token, so the filing step can read the participants and the
  // collaborators whose logins the scrub removes (plan 0006 §4.2).
  it('mints a read-only token (issues and pull requests: read) only when the record says `sent with evidence`, and hands it to the filing step', () => {
    const names = fsteps.find((s) => s.id === 'names-token')!;
    expect(names.uses).toBe('actions/create-github-app-token@v3');
    expect(perms(names)).toEqual([['permission-issues', 'read'], ['permission-pull-requests', 'read']]);
    expect(names.with).toMatchObject({ 'client-id': '${{ secrets.AUTHOR_APP_ID }}', 'private-key': '${{ secrets.AUTHOR_APP_PRIVATE_KEY }}' });
    // Minted for exactly one value of the record, and never together with the filing token.
    const minted = (s: Step, value: string) => {
      const m = /^needs\.gate\.outputs\.upstream == '([^']*)'$/.exec(s.if ?? '');
      if (!m) throw new Error(`${s.id}'s condition is not a single equality on the record: ${s.if}`);
      return m[1] === value;
    };
    const fileToken = fsteps.find((s) => s.id === 'file-token')!;
    for (const value of ['drafted', 'filed here', 'sent', 'sent with evidence', '']) {
      expect(minted(names, value), value).toBe(value === 'sent with evidence');
      expect(minted(names, value) && minted(fileToken, value), value).toBe(false);
    }
    const step = fsteps.find((s) => s.id === 'file')!;
    expect(fsteps.indexOf(names)).toBeLessThan(fsteps.indexOf(step));
    expect(step.env!.GH_TOKEN).toBe('${{ steps.file-token.outputs.token || steps.names-token.outputs.token }}');
  });

  it('judges the findings against the aggregate the read job uploaded, downloaded outside a workspace', () => {
    const downloads = fsteps.filter((s) => s.uses?.startsWith('actions/download-artifact@')).map((s) => s.with);
    expect(downloads).toEqual([
      { name: 'kanon-explore-aggregate-${{ github.run_id }}-${{ github.run_attempt }}', path: '${{ runner.temp }}/aggregate' },
      { name: 'qa-telemetry-findings-${{ github.run_id }}-${{ github.run_attempt }}', path: '${{ runner.temp }}/report' },
    ]);
    const last = fsteps.find((x) => x.id === 'file')!;
    expect(last.run).toBe('node "$KANON/scripts/telemetry-file.mjs"');
    expect(last.env).toMatchObject({ UPSTREAM: '${{ needs.gate.outputs.upstream }}', AGGREGATE_PATH: '${{ runner.temp }}/aggregate/aggregate.json', REPORT_PATH: '${{ runner.temp }}/report/qa-telemetry-findings.json' });
  });

  it('starts on the agent job\'s success, whatever the agent concluded, and refuses an earlier attempt\'s report first', () => {
    expect(file.if).toBe("${{ !cancelled() && needs.explore.result == 'success' }}");
    expect(fsteps[0]!.name).toBe('Refuse a report from an earlier attempt');
    expect(byId('agent')['continue-on-error']).toBe(true);
  });
});

describe('where findings go: the adoption record\'s Upstream findings choice (kanon#471, as the Overseer\'s, kanon#426)', () => {
  const gate = wf.jobs.gate!;
  const gsteps = gate.steps as Step[];
  const read = gsteps.find((s) => s.id === 'upstream')!;
  it('is read in the gate job, from the default branch, before any agent runs, and handed to the file job alone', () => {
    expect(read.run).toContain('upstream="$(node "$KANON/scripts/upstream-findings.mjs")"');
    expect(read.if).toBe("steps.configured.outputs.configured == 'true'");
    expect((gate as { outputs?: Record<string, string> }).outputs?.upstream).toBe('${{ steps.upstream.outputs.upstream }}');
    expect([wf.jobs.file!.needs].flat()).toContain('gate');
    // No other job, and nothing the agent's job runs, names the choice.
    for (const [name, j] of Object.entries(wf.jobs)) {
      if (name === 'gate' || name === 'file') continue;
      expect(JSON.stringify(j), name).not.toMatch(/outputs\.upstream|UPSTREAM|upstream-findings/);
    }
    for (const f of ['explore-telemetry-run.yml', 'explore-telemetry-agent-job.yml']) {
      expect(readFileSync(`${WF}/${f}`, 'utf8'), f).not.toMatch(/outputs\.upstream|\bUPSTREAM\b|upstream-findings/);
    }
  });
});

// Issue #1401 (`K-AGENT-1`): the file job checks out nothing and its tokens read no contents, so
// the Explorer's persona is read in the gate job, from the register on the default branch.
describe('the persona the filing step signs with (kanon#1401)', () => {
  it('is read in the gate job, from the default branch, and handed to the file job alone', () => {
    const gate = wf.jobs.gate!;
    const gsteps = gate.steps as Step[];
    const read = gsteps.find((s) => s.id === 'persona')!;
    expect(read, 'the gate job\'s persona step').toBeDefined();
    expect(gsteps.indexOf(read)).toBeGreaterThan(gsteps.findIndex((s) => s.id === 'configured'));
    expect(read.if).toBe("steps.configured.outputs.configured == 'true'");
    expect(read.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(read.run).toContain('persona="$(node "$KANON/scripts/lane-persona.mjs" Explorer)"');
    expect(read.run).toContain('printf \'persona=%s\\n\' "$persona" >> "$GITHUB_OUTPUT"');
    expect((gate as { outputs?: Record<string, string> }).outputs?.persona).toBe('${{ steps.persona.outputs.persona }}');
    const file = ((wf.jobs.file!.steps ?? []) as Step[]).find((s) => s.id === 'file')!;
    expect(file.env?.PERSONA).toBe('${{ needs.gate.outputs.persona }}');
    for (const [name, j] of Object.entries(wf.jobs)) if (name !== 'gate' && name !== 'file') expect(JSON.stringify(j), name).not.toMatch(/outputs\.persona|lane-persona/);
  });
});

// Plan 0006 §5, steps 1 and 2 (F3, kanon#588): with `sent` or `sent with evidence`, the filing step
// also writes finding rows, and the file job uploads them for the telemetry collector. The scrub's
// App names are read in the gate job, from the default branch, before the agent runs.
describe('finding rows for Kanon\'s telemetry store (plan 0006 F3)', () => {
  const gsteps = wf.jobs.gate!.steps as Step[];
  const fsteps = (wf.jobs.file!.steps ?? []) as Step[];
  const file = fsteps.find((s) => s.id === 'file')!;
  it('reads the App register\'s names in the gate job, after the choice, only for `sent with evidence`, and hands them to the file job alone', () => {
    const names = gsteps.find((s) => s.id === 'names')!;
    expect(gsteps.indexOf(names)).toBeGreaterThan(gsteps.findIndex((s) => s.id === 'upstream'));
    expect(names.if).toBe("steps.upstream.outputs.upstream == 'sent with evidence'");
    expect(names.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(names.run).toContain('names="$(node "$KANON/scripts/upstream-names.mjs")"');
    expect(names.run).toContain('printf \'names=%s\\n\' "$names" >> "$GITHUB_OUTPUT"');
    expect((wf.jobs.gate as { outputs?: Record<string, string> }).outputs?.names).toBe('${{ steps.names.outputs.names }}');
    for (const [name, j] of Object.entries(wf.jobs)) if (name !== 'gate' && name !== 'file') expect(JSON.stringify(j), name).not.toMatch(/outputs\.names|upstream-names/);
  });

  it('gives the filing step the run\'s names, tag, release and where to write the rows', () => {
    expect(file.env).toMatchObject({
      APP_NAME_HASHES: '${{ needs.gate.outputs.names }}',
      PERSONA: '${{ needs.gate.outputs.persona }}',
      TAG: "${{ inputs.smoke != '' && 'smoke' || 'run' }}",
      KANON_WORKFLOW_REF: '${{ job.workflow_ref }}',
      KANON_WORKFLOW_SHA: '${{ job.workflow_sha }}',
      FINDINGS_PATH: '${{ runner.temp }}/finding/kanon-finding.json',
    });
  });

  it('uploads the rows the filing step wrote, after it, as `kanon-finding-explore-telemetry-*`, only when it wrote some', () => {
    const up = fsteps.at(-1)!;
    expect(fsteps.indexOf(up)).toBeGreaterThan(fsteps.indexOf(file));
    expect(up.uses).toBe('actions/upload-artifact@v7');
    expect(up.if).toBe("${{ !cancelled() && steps.file.outputs.finding-rows != '' }}");
    expect(up.with).toEqual({
      name: 'kanon-finding-explore-telemetry-${{ github.run_id }}-${{ github.run_attempt }}',
      path: file.env!.FINDINGS_PATH, 'retention-days': 8, 'if-no-files-found': 'error',
    });
  });

  it('names the artifact and its file as the collector reads them (`telemetry-artifacts.mjs`)', () => {
    const up = fsteps.at(-1)!;
    expect(up.with!.name).toBe(findingArtifactName('explore-telemetry', '${{ github.run_id }}', '${{ github.run_attempt }}'));
    expect(String(file.env!.FINDINGS_PATH).split('/').at(-1)).toBe(FINDING_ARTIFACT_FILE);
  });

  it('tells the agent what `upstream` holds, that its codes are the signal\'s, and that the no-digit rule holds for its text', () => {
    expect(prompt).toContain('"upstream": {"rules": ["K-..."], "kanon_paths": ["scripts/..."], "fix_category": "..."');
    expect(prompt).toContain('Its lane and codes are the first signal\'s, or the first cell\'s lane, never yours.');
    expect(prompt).toMatch(/no-digit rule holds for `evidence` and `suggested_fix` too/);
  });
});
