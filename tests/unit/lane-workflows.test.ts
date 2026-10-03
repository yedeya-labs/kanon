import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { laneBlockOf, resolvedAgentJobs } from './helpers/agent-lanes.mjs';
import { blockOf, callsSpine, effectiveSteps, readBlock, readSpine, spineJobFor } from './helpers/spine.js';
import { type WorkflowStep } from './helpers/workflow-step.js';

/**
 * Kanon's lane workflows (plan 0001, step 2): the spine and the three lanes that run no
 * workspace script, each a reusable workflow an adopter calls from a trigger-only caller.
 *
 * Each lane's own behaviour is tested in its own file (`agent-triage` has no steps of its
 * own; `agent-implement-revise.test.ts`, `agent-lead-revise.test.ts`,
 * `revise-round-record.test.ts`). This file holds what every lane shares: the calling
 * contract (§3, §8), the concurrency decision (decision 11), the flags each arm passes, the
 * retry breadcrumbs, and the rule that nothing in them names a project.
 */
const WF = '.github/workflows';
const LANES = [
  'agent-triage.yml', 'agent-implement.yml', 'agent-implement-revise.yml', 'agent-lead-revise.yml', 'agent-merge-reconcile.yml',
  'agent-lead.yml', 'agent-lead-split.yml', 'agent-rebase.yml',
] as const;
/** The lanes that call the blocks themselves; the rest hand their body to the spine. */
const DIRECT_LANES: readonly string[] = ['agent-merge-reconcile.yml', 'agent-lead-split.yml', 'agent-rebase.yml'];
const SPINE_LANES = LANES.filter((f) => !DIRECT_LANES.includes(f));
type Job = {
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, string> | string;
  steps?: WorkflowStep[];
  needs?: string | string[];
  if?: string;
};
type Lane = {
  name?: string;
  on: Record<string, { inputs?: Record<string, { type: string; required?: boolean }>; secrets?: Record<string, { required?: boolean }> }>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  permissions?: Record<string, string>;
  env?: unknown;
  jobs: Record<string, Job>;
};
const text = (file: string) => readFileSync(join(process.cwd(), WF, file), 'utf8');
const lane = (file: string) => parse(text(file)) as Lane;
const spineCalls = (file: string) => Object.entries(lane(file).jobs).filter(([, j]) => callsSpine(j as never));

/** The role each lane runs as, and so the fixed secret names it takes (plan 0001 §8). */
const ROLE: Record<(typeof LANES)[number], string> = {
  'agent-triage.yml': 'IMPLEMENTER',
  'agent-implement.yml': 'IMPLEMENTER',
  'agent-implement-revise.yml': 'IMPLEMENTER',
  'agent-lead-revise.yml': 'LEAD',
  'agent-merge-reconcile.yml': 'REVIEWER',
  'agent-lead.yml': 'LEAD',
  'agent-lead-split.yml': 'LEAD',
  'agent-rebase.yml': 'IMPLEMENTER',
};

describe('plan 0001 §3: each lane is a reusable workflow, called with its inputs and its secrets', () => {
  it.each(LANES)('%s is called, never triggered', (file) => {
    expect(Object.keys(lane(file).on)).toEqual(['workflow_call']);
  });

  it.each(LANES)('%s takes its secrets by their fixed names, all required (§8, decision 7)', (file) => {
    const secrets = lane(file).on.workflow_call!.secrets ?? {};
    const role = ROLE[file];
    expect(Object.keys(secrets).sort()).toEqual([`${role}_APP_ID`, `${role}_APP_PRIVATE_KEY`, 'CLAUDE_CODE_OAUTH_TOKEN'].sort());
    for (const s of Object.values(secrets)) expect(s.required).toBe(true);
  });

  it.each(LANES)('%s takes no required input, so every trigger of its caller can pass them through', (file) => {
    // A caller passes `${{ inputs.x }}`, which is '' on every trigger but the dispatch. A
    // required or boolean input refuses that ("Unexpected value ''", measured on the lane
    // concurrency smoke's sibling probe), so every input is an optional string.
    for (const [name, input] of Object.entries(lane(file).on.workflow_call!.inputs ?? {})) {
      expect(input.type, `${file}: ${name}`).toBe('string');
      expect(input.required, `${file}: ${name}`).toBe(false);
    }
  });

  it.each(SPINE_LANES)('%s hands its body to the spine through `$/`, with its own secrets mapped explicitly', (file) => {
    const calls = spineCalls(file);
    expect(calls).toHaveLength(1);
    const [, job] = calls[0]!;
    expect(job.uses).toBe('$/.github/workflows/agent-lane.yml');
    const role = ROLE[file];
    expect(job.secrets).toEqual({
      'app-id': `\${{ secrets.${role}_APP_ID }}`,
      'app-private-key': `\${{ secrets.${role}_APP_PRIVATE_KEY }}`,
      'claude-token': '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    });
  });

  it.each([...LANES, 'agent-lane.yml'])('%s inherits no secrets and declares no workflow-level env', (file) => {
    // `secrets: inherit` would hand every adopter secret to Kanon's code (decision 7). A
    // workflow-level `env:` is not propagated into a called workflow's jobs (plan §3).
    for (const job of Object.values(lane(file).jobs)) expect(job.secrets).not.toBe('inherit');
    expect(lane(file).env).toBeUndefined();
  });

  it.each(LANES)('%s declares the permissions it needs, which its caller must grant (§3)', (file) => {
    expect(lane(file).permissions).toMatchObject({ contents: 'read' });
  });
});

describe('plan 0001 decision 11: each lane keeps its concurrency group at the top level', () => {
  // MEASURED, NOT ASSUMED. `lane-concurrency-smoke.yml` calls `lane-concurrency-probe.yml`,
  // which holds a top-level group for 90 seconds; four runs pushed in quick succession each
  // started only after the previous one ended. So the key is honoured in a called workflow,
  // and the group stays with the lane that knows what it serialises. A caller must not
  // repeat it: the same group on both levels would have the caller wait on itself, which is
  // why `lane-check` refuses a caller with any `concurrency`.
  // The split lane's group is on its JOB, as it was in the adopter (RA-1781's review): every
  // label event on the issue reaches the workflow, and at workflow level each would join the
  // group and could replace a pending real run.
  const JOB_GROUP: Record<string, string> = { 'agent-lead-split.yml': 'split' };
  it.each(LANES.filter((f) => !(f in JOB_GROUP)))('%s', (file) => {
    const c = lane(file).concurrency;
    expect(c?.group).toBeTruthy();
    expect(c?.['cancel-in-progress']).toBe(false);
  });
  it.each(Object.entries(JOB_GROUP))('%s, on its %s job', (file, job) => {
    expect(lane(file).concurrency).toBeUndefined();
    const c = (lane(file).jobs[job] as { concurrency?: { group: string; 'cancel-in-progress': boolean } }).concurrency;
    expect(c?.group).toBeTruthy();
    expect(c?.['cancel-in-progress']).toBe(false);
  });

  it('the probe is the shape the lanes rely on', () => {
    const probe = lane('lane-concurrency-probe.yml');
    expect(Object.keys(probe.on)).toEqual(['workflow_call']);
    expect(probe.concurrency).toEqual({ group: 'kanon-lane-concurrency-probe', 'cancel-in-progress': false });
    const smoke = lane('lane-concurrency-smoke.yml');
    expect(Object.values(smoke.jobs).map((j) => j.uses)).toEqual(['$/.github/workflows/lane-concurrency-probe.yml']);
  });
});

describe('every arm passes the flags its run is measured and bounded by', () => {
  // Moved from the reference adopter's fleet-wide flag tests (RA-1477, RA-1880, RA-1879),
  // over Kanon's lanes. The adopter keeps the fleet-wide decisions for its own lanes.
  const arms = LANES.flatMap((file) => resolvedAgentJobs(lane(file)).map((e: { job: string; claudeArgs?: unknown; agent?: unknown }) => ({
    file, job: e.job, agent: String(e.agent), args: String(e.claudeArgs ?? ''),
  })));
  const flag = (args: string, name: string) => new RegExp(`(?:^|\\s)${name}[\\s=]+(\\S+)`).exec(args)?.[1];

  it('finds one arm per lane', () => {
    expect(arms.map((a) => a.file)).toEqual([...LANES]);
    expect(arms.map((a) => a.agent)).toEqual(['triage-fix', 'implementer', 'implementer-revise', 'lead-revise', 'merge-reconcile', 'lead', 'lead-split', 'rebase-lane']);
  });

  it.each(['--model', '--effort', '--max-turns', '--max-budget-usd', '--allowedTools'])('every arm passes %s', (name) => {
    expect(arms.filter((a) => !flag(a.args, name)).map((a) => a.file)).toEqual([]);
  });

  it('every arm falls back to claude-opus-5-5, the decided chain for the Opus 5 arms (RA-1880)', () => {
    for (const a of arms) {
      expect(flag(a.args, '--model'), a.file).toBe('claude-opus-5');
      expect(flag(a.args, '--fallback-model'), a.file).toBe('claude-opus-5-5');
    }
  });

  it('no spine lane pins the 5-minute prompt cache: each runs tests or idles past it (RA-2058)', () => {
    for (const file of SPINE_LANES) {
      for (const [, job] of spineCalls(file)) expect(job.with?.['prompt-cache-ttl'], file).toBeUndefined();
    }
  });

  it('merge-reconcile pins it, deliberately: every run ends well inside 5 minutes (RA-2058)', () => {
    const run = lane('agent-merge-reconcile.yml').jobs.reconcile!.steps!.find((st) => laneBlockOf(st) === 'agent-run');
    expect(run?.with?.['prompt-cache-ttl']).toBe('5m');
  });

  it('only the implement lane sets an --autocompact window: that experiment is its alone (RA-1949)', () => {
    expect(arms.filter((a) => /--autocompact/.test(a.args)).map((a) => a.file)).toEqual(['agent-implement.yml']);
  });

  it('every arm sets its own timeout, never the spine default', () => {
    for (const file of SPINE_LANES) {
      for (const [, job] of spineCalls(file)) expect(job.with?.['timeout-minutes'], file).toEqual(expect.any(Number));
    }
    // A lane on its own jobs bounds each of them itself.
    for (const file of DIRECT_LANES) {
      for (const job of Object.values(lane(file).jobs)) expect((job as { 'timeout-minutes'?: number })['timeout-minutes'], file).toEqual(expect.any(Number));
    }
  });
});

/**
 * The retry breadcrumbs (RA-2519). A PR lane's recovery reads a run's jobs by STEP NAME to
 * find a run that died of its cause, so the names are a protocol, and these are the names
 * the recovery reads. Moved from the reference adopter's `lane-retry` test, whose reader
 * stays there with the pipeline library until step 3.
 */
const RETRY_STEPS = Object.freeze({
  unreachable: 'Retryable once the cause clears: the model was unreachable (RA-2519)',
  api_error: 'Retryable once the cause clears: the model API failed mid-run (RA-2519)',
});

describe('every PR lane leaves the breadcrumbs (RA-2519)', () => {
  const lanes: [string, string][] = [
    ['agent-implement-revise.yml', 'revise'],
    ['agent-lead-revise.yml', 'revise'],
  ];
  it.each(lanes)('%s', (file, jobName) => {
    type Step = WorkflowStep & { id?: string; name?: string; if?: string; run?: string };
    const job = lane(file).jobs[jobName];
    expect(job, `${file} has no job ${jobName}`).toBeTruthy();
    const spine = spineJobFor(job as never);
    const steps = spine.steps as Step[];
    const own = spine.laneSteps as Step[];
    for (const [cls, name] of Object.entries(RETRY_STEPS)) {
      const crumb = steps.find((s) => s.name === name);
      expect(crumb, `${file} lacks "${name}"`).toBeTruthy();
      // A JOB-LEVEL STEP, never one inside a block: the jobs API lists a composite action
      // as ONE step, so a breadcrumb inside one could never be read by its name.
      expect(blockOf(crumb!), `${file}: "${name}" sits inside a block`).toBeUndefined();
      const m = /steps\.([\w-]+)\.outputs\.retry == '([\w]+)'/.exec(String(crumb!.if));
      expect(m, `${file}: "${name}" must key on a step's retry output`).toBeTruthy();
      expect(m![2]).toBe(cls);
      expect(String(crumb!.if)).toMatch(/^failure\(\) && /);
      let source = own.find((s) => s.id === m![1]);
      expect(source, `${file}: steps.${m![1]} is not a step of this job`).toBeTruthy();
      // Through the block, and through the block that block calls (RA-2691), until a step
      // that runs something.
      const levelIn = (s: Step, call: Step): Step | undefined => {
        for (let at = s, from = blockOf(at); from; at = from.call as Step, from = blockOf(at)) if (from.call === call) return at;
        return undefined;
      };
      let ran: Step | undefined = laneBlockOf(source) ? undefined : source;
      for (let hops = 0; source && laneBlockOf(source); hops++) {
        expect(hops, `${file}: the retry output never reaches a step that runs`).toBeLessThan(3);
        const block = laneBlockOf(source)!;
        const inner = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.retry\s*\}\}$/.exec(String(readBlock(block).outputs?.retry?.value ?? ''));
        expect(inner, `${file}: ${block} must export the classifier's \`retry\` output`).toBeTruthy();
        const call = source;
        ran = steps.find((s) => levelIn(s, call)?.id === inner![1]);
        source = ran && levelIn(ran, call);
      }
      expect(source?.run ?? '', `${file}: steps.${m![1]} must run classify-agent-result.mjs`).toMatch(/classify-agent-result\.mjs/);
      expect(steps.indexOf(crumb!)).toBeGreaterThan(steps.indexOf(ran!));
    }
  });

  it('the rebase lane, which calls the blocks itself, leaves them after its finish block', () => {
    // Its matrix job is the one `scripts/rebase-lane.mjs` reads them from, per PR.
    type Step = WorkflowStep & { id?: string; name?: string; if?: string };
    const steps = lane('agent-rebase.yml').jobs.resolve!.steps as Step[];
    const finish = steps.findIndex((s) => laneBlockOf(s) === 'agent-finish');
    expect(steps[finish]?.id).toBe('finish');
    for (const [cls, name] of Object.entries(RETRY_STEPS)) {
      const at = steps.findIndex((s) => s.name === name);
      expect(at, `the rebase lane lacks "${name}"`).toBeGreaterThan(finish);
      expect(steps[at]!.if).toBe(`failure() && steps.finish.outputs.retry == '${cls}'`);
    }
  });

  it('the spine carries exactly these two, under exactly these names', () => {
    const names = (readSpine().jobs.run.steps ?? []).map((s) => s.name ?? '').filter((n) => n.startsWith('Retryable'));
    expect(names).toEqual(Object.values(RETRY_STEPS));
  });
});

describe('plan 0001 §5: nothing in the spine or a lane names a project', () => {
  // The P2 grep, kept: every project literal lives in the adopter's own files — its
  // project-setup hook, its stack document (`docs/qa/stack.md`), its playbooks (K-LAYOUT-17).
  // Over the WHOLE parsed workflow, PROMPTS INCLUDED (kanon#36): a prompt states the process,
  // and names the project's commands, database, settings and milestones only by the section
  // of the project's file that holds them. Comments are not read: the parse drops them.
  const LITERALS = new RegExp([
    // The reference adopter's toolchain and setup (P2).
    'node-version', 'npm ci', '\\bnpm (run|test|install)\\b', '\\bnpx\\b', 'package-lock', 'AGENT_QUIET', '--reporter',
    // Its database commands and concepts.
    'db:(init|push|setup)', '\\bRLS\\b', '[Tt]enant', 'drizzle', '5433',
    // Its hook's own steps; the starting map's fixed PATH is Kanon's (K-LAYOUT-17), a script is not.
    'starting-map(?!\\.md)', 'expect-slug',
    // Its roadmap milestones (the buckets' names are Kanon's, K-WORK-4), cloud, and documents.
    'Production Ready', 'AI Capabilities', 'Development Ready', '\\bAWS\\b', 'docs/agentic-', 'payments\\.md',
  ].join('|'));
  const parsed = (file: string) => {
    const doc = lane(file);
    // The implement lane's crash recovery runs Kanon's own script on Node 24 (`engines`),
    // which is Kanon's requirement, not a project's.
    for (const job of Object.values(doc.jobs)) for (const st of job.steps ?? []) {
      if (String(st.uses ?? '').startsWith('actions/setup-node') && st.with?.['node-version'] === '24') delete st.with['node-version'];
    }
    return JSON.stringify(doc, null, 1).split('\n');
  };

  it.each(['agent-lane.yml', ...LANES, 'agent-review.yml', 'agent-verify-acs.yml'])('%s', (file) => {
    expect(parsed(file).filter((l) => LITERALS.test(l))).toEqual([]);
  });

  it('reads the prompts: the scan still sees a prompt line (kanon#36)', () => {
    // Guards the exclusion's removal itself: were prompts dropped again, this would fail.
    expect(parsed('agent-implement.yml').some((l) => l.includes('TEST-FIRST'))).toBe(true);
  });

  it('the spine passes the hook exactly what Kanon documents (§5), from the checked-out tree', () => {
    const call = (readSpine().jobs.run.steps ?? []).find((s) => s.uses === './.github/actions/project-setup');
    expect(Object.keys(call?.with ?? {}).sort()).toEqual(
      ['app-slug', 'browsers', 'database', 'github-token', 'install', 'issue-number', 'lane'].sort(),
    );
    // The Claude token is never passed to the hook.
    expect(JSON.stringify(call?.with)).not.toContain('claude-token');
  });

  it('every block the spine runs is expanded, so the checks above see what it runs', () => {
    expect(effectiveSteps(readSpine().jobs.run.steps).length).toBeGreaterThan((readSpine().jobs.run.steps ?? []).length);
  });
});
