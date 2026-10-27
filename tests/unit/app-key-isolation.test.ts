import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeStub } from './helpers/stub-bin.js';

/**
 * `K-AGENT-49` (kanon#274, kanon#279): no job that runs an agent, the project's code, or a pull
 * request's code holds an App's private key. The rule's Why is in `rulebook/03-agents.md`: it is
 * the job that must lack the key, not a step, so this checks jobs.
 *
 * WHAT COUNTS AS RUNNING SOMEONE ELSE'S CODE:
 *   • the agent: Kanon's `agent-run` block, or `claude-code-action` called directly;
 *   • a `./` action: the project's own code from the checkout (the project-setup hook);
 *   • Kanon's `notify` block, which runs the adopter's notify hook from the checkout it makes, at
 *     the run's commit, whatever branch it is on (plan 0011 §5, step N6);
 *   • a checkout with a `ref:`: a branch other than the triggering commit (a PR's head). The
 *     default branch by name is not one: it is merged code (the Merger's job checks it out).
 *
 * NO EXCEPTIONS (kanon#279). Every lane runs its agent the one way the spine does: a called
 * workflow holding exactly a `mint` job, which holds the key and runs nothing else, and the
 * agent's job, a call to a workflow of its own that is handed the token through `secrets:`.
 * The spine is `agent-lane.yml` → `lane-agent-job.yml`; a lane that calls the blocks itself is
 * `<lane>-run.yml` → `<lane>-agent-job.yml`. The second half of this file holds every such
 * pair to the spine's handoff, and the agent's job's token steps to the spine's, byte for byte.
 */

const WF = '.github/workflows';
type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { uses?: string; needs?: string | string[]; if?: string; with?: Record<string, unknown>; secrets?: Record<string, unknown> | string; steps?: Step[]; outputs?: Record<string, string>; concurrency?: unknown; strategy?: unknown; permissions?: unknown };
type Workflow = { on?: { workflow_call?: { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> } }; jobs?: Record<string, Job> };

const read = (f: string) => parse(readFileSync(join(WF, f), 'utf8')) as Workflow;
const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f)).sort();

/** A reference to an App private key: `secrets.X_PRIVATE_KEY`, `secrets.app-private-key`, or a computed `secrets[…PRIVATE_KEY…]`. */
const KEY = /secrets\s*(?:\.\s*[\w-]*private[-_]key\b|\[[^\]]*private[-_]key[^\]]*\])/i;
const holdsKey = (job: Job): boolean => KEY.test(JSON.stringify(job));

const isAgent = (s: Step) => /(^|\/)actions\/agent-run(@|$)/.test(String(s.uses ?? '')) || String(s.uses ?? '').startsWith('anthropics/claude-code-action');
const isLocal = (s: Step) => String(s.uses ?? '').startsWith('./');
/** The `notify` block, which calls `./.github/actions/notify` inside it (plan 0011 §5). */
const isNotify = (s: Step) => /^(?:\$\/|yedeya-labs\/kanon\/)actions\/notify(?:@|$)/.test(String(s.uses ?? ''));
/** The default branch is merged, reviewed code: the Merger checks it out by name to run Kanon's scripts on it. */
const DEFAULT_BRANCH = /^\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}$/;
const isRefCheckout = (s: Step) => String(s.uses ?? '').startsWith('actions/checkout@')
  && String(s.with?.ref ?? '') !== '' && !DEFAULT_BRANCH.test(String(s.with?.ref));
/** Why a job runs code other than Kanon's and the job's own, or `undefined` when it runs none. */
const runsOthersCode = (job: Job): string | undefined => {
  const steps = job.steps ?? [];
  if (steps.some(isAgent)) return 'runs the agent';
  const local = steps.find(isLocal);
  if (local) return `runs \`${local.uses}\` from the checkout`;
  if (steps.some(isNotify)) return 'runs the notify hook from the checkout';
  if (steps.some(isRefCheckout)) return 'checks out a ref other than the triggering commit';
  return undefined;
};

/** Every `file:job` that both holds a key and runs someone else's code, with why. */
const violations = (docs: Record<string, Workflow>): Record<string, string> =>
  Object.fromEntries(Object.entries(docs).flatMap(([f, doc]) => Object.entries(doc.jobs ?? {}).flatMap(([name, job]) => {
    const why = runsOthersCode(job);
    return why && holdsKey(job) ? [[`${f}:${name}`, why] as const] : [];
  })));

const docs = Object.fromEntries(files.map((f) => [f, read(f)]));

// ── The handoff, for every pair ──────────────────────────────────────────────────────────────

/** `uses: $/.github/workflows/<file>`, Kanon's call to one of its own workflows. */
const CALL = /^\$\/\.github\/workflows\/([\w.-]+\.ya?ml)$/;
const callee = (job: Job): string | undefined => CALL.exec(String(job.uses ?? ''))?.[1];

/** An agent's job: a called workflow handed the token as the `app-token` secret. */
const AGENT_JOBS = files.filter((f) => docs[f]!.on?.workflow_call?.secrets?.['app-token'] !== undefined);
/** Each agent's job's one caller: the job that hands it the token, and the workflow that job is in. */
const callers = (target: string) => Object.entries(docs).flatMap(([f, d]) => Object.entries(d.jobs ?? {})
  .filter(([, j]) => callee(j) === target).map(([name, job]) => ({ file: f, name, job })));
const PAIRS = AGENT_JOBS.map((agentFile) => {
  const [call, ...more] = callers(agentFile);
  return { agentFile, call: call!, more, runFile: call?.file ?? '' };
});

/** The spine's token steps, which every other agent's job repeats exactly. */
const SPINE_STEPS = docs['lane-agent-job.yml']!.jobs!.run!.steps!;
const RECEIVE = SPINE_STEPS.find((s) => s.id === 'app-token')!;
const REVOKE = SPINE_STEPS.at(-1)!;
const tokenStep = (s: Step) => ({ name: s.name, env: s.env, run: s.run });

/**
 * THE CLAUDE CREDENTIALS (plan 0009 §10, step A2): the subscription token or an Anthropic API key,
 * each handed down by its own name, both optional, from the lane to the `agent-run` block, which
 * puts the one the caller mapped in the agent step's `env:`. The spine's declarations and its
 * `agent-run` step are what every pair repeats.
 */
const CREDENTIALS = ['claude-token', 'anthropic-api-key'] as const;
const isAgentRun = (s: Step) => /(^|\/)actions\/agent-run(@|$)/.test(String(s.uses ?? ''));
const SPINE_CALL_SECRETS = docs['agent-lane.yml']!.on!.workflow_call!.secrets!;
const SPINE_JOB_SECRETS = docs['lane-agent-job.yml']!.on!.workflow_call!.secrets!;
const SPINE_AGENT_RUN = SPINE_STEPS.find(isAgentRun)!;
const credentialInputs = (s: Step) => Object.fromEntries(CREDENTIALS.map((k) => [k, s.with?.[k]]));

/** A reference to a Claude credential's secret, by any of its names, or a computed one. */
const CREDENTIAL = /secrets\s*(?:\.\s*(?:CLAUDE_CODE_OAUTH_TOKEN|claude-token|ANTHROPIC_API_KEY|anthropic-api-key)\b|\[[^\]]*(?:oauth|api[-_]key|claude|anthropic)[^\]]*\])/i;
/** The `agent-run` input each credential may reach, read from the reference's name. */
const inputFor = (v: string) => (/ANTHROPIC_API_KEY|anthropic-api-key/i.test(v) ? 'anthropic-api-key' : 'claude-token');
/**
 * Every place a Claude credential reaches other than its two channels: a reusable call's
 * `secrets:`, and the `agent-run` input of its own name, which the block moves into the agent
 * step's `env:` (A1). So never a `run:`, an `env:`, a mint job, or a `with:` of anything else,
 * `claude-code-action`'s above all, which copies every input into `ALL_INPUTS` (§8).
 */
const credentialLeaks = (all: Record<string, Workflow>): string[] =>
  Object.entries(all).flatMap(([f, doc]) => Object.entries(doc.jobs ?? {}).flatMap(([name, job]) => {
    if (job.uses === undefined && holdsKey(job) && CREDENTIAL.test(JSON.stringify(job))) return [`${f}:${name}: a Claude credential in the job that holds the App key`];
    const { steps = [], secrets, ...rest } = job;
    const out: string[] = [];
    if (CREDENTIAL.test(JSON.stringify(rest))) out.push(`${f}:${name}: a Claude credential outside the call's secrets:`);
    if (secrets !== undefined && job.uses === undefined && CREDENTIAL.test(JSON.stringify(secrets))) out.push(`${f}:${name}: secrets: on a job that calls no workflow`);
    steps.forEach((s, i) => {
      const at = `${f}:${name}:${s.id ?? s.name ?? i}`;
      const { with: inputs = {}, ...other } = s;
      if (CREDENTIAL.test(JSON.stringify(other))) out.push(`${at}: a Claude credential in its run:, env: or if:`);
      for (const [k, v] of Object.entries(inputs)) {
        if (!CREDENTIAL.test(String(v))) continue;
        if (!isAgentRun(s)) out.push(`${at}: \`${k}\` hands a Claude credential to \`${String(s.uses)}\``);
        else if (k !== inputFor(String(v))) out.push(`${at}: \`${k}\` is handed the other credential`);
      }
    });
    return out;
  }));

describe('K-AGENT-49: no job that runs an agent or project code holds an App private key', () => {
  it('finds the jobs it is about, so the check is not vacuous', () => {
    const running = Object.entries(docs).flatMap(([f, d]) => Object.entries(d.jobs ?? {}).filter(([, j]) => runsOthersCode(j)).map(([n]) => `${f}:${n}`));
    expect(running).toEqual(expect.arrayContaining(PAIRS.map(({ agentFile }) => `${agentFile}:${Object.keys(docs[agentFile]!.jobs!)[0]}`)));
    const keyed = Object.entries(docs).flatMap(([f, d]) => Object.entries(d.jobs ?? {}).filter(([, j]) => holdsKey(j)).map(([n]) => `${f}:${n}`));
    expect(keyed).toEqual(expect.arrayContaining(['agent-lane.yml:mint', 'apps-check.yml:check', ...PAIRS.map(({ runFile }) => `${runFile}:mint`)]));
  });

  it('holds for every job, with no exception', () => {
    expect(violations(docs)).toEqual({});
  });

  it('finds the spine and all nine lanes that call the blocks themselves', () => {
    expect(AGENT_JOBS).toEqual([
      'code-audit-agent-job.yml', 'explore-agent-job.yml', 'explore-telemetry-agent-job.yml', 'lane-agent-job.yml', 'lead-split-agent-job.yml',
      'merge-reconcile-agent-job.yml', 'overseer-agent-job.yml', 'rebase-agent-job.yml', 'review-agent-job.yml',
      'verify-acs-agent-job.yml',
    ]);
  });
});

describe.each(PAIRS)('$agentFile gets the token from a mint job of its own (kanon#274, kanon#279)', ({ agentFile, call, more, runFile }) => {
  const agent = docs[agentFile]!;
  const [jobName, job] = Object.entries(agent.jobs ?? {})[0]!;
  const steps = job.steps ?? [];
  const run = docs[runFile]!;

  it('declares no key it could be handed, and is one job that never mints', () => {
    expect(Object.keys(agent.on?.workflow_call?.secrets ?? {}).sort()).toEqual(['anthropic-api-key', 'app-token', 'claude-token']);
    expect(KEY.test(readFileSync(join(WF, agentFile), 'utf8'))).toBe(false);
    expect(Object.keys(agent.jobs ?? {})).toHaveLength(1);
    expect(steps.some((s) => String(s.uses ?? '').startsWith('actions/create-github-app-token@'))).toBe(false);
  });

  it('is called from exactly one place: a workflow that holds the mint and this call, and nothing else', () => {
    expect(call, `${agentFile} is called by no workflow`).toBeDefined();
    expect(more.map((c) => `${c.file}:${c.name}`)).toEqual([]);
    // The spine's third job pushes the agent's commits with a token of its own (kanon#1383), and
    // so does the rebase lane's (kanon#1384), whose fourth sets the implementer status on the
    // entry's pull request after its push (#1379). Each holds the key, so each runs only Kanon's
    // Node, never a checkout of the pull request or the agent (the check above, `lane-push.test.ts`
    // and `implementer-status.test.ts`).
    const after = runFile === 'agent-lane.yml' ? ['push'] : runFile === 'rebase-run.yml' ? ['push', 'implementer-status'] : [];
    expect(Object.keys(run.jobs ?? {}).sort()).toEqual([call.name, 'mint', ...after].sort());
    if (runFile === 'rebase-run.yml') {
      for (const name of after) {
        expect(runsOthersCode(run.jobs![name]!), `${runFile}:${name}`).toBeUndefined();
        expect(holdsKey(run.jobs![name]!), `${runFile}:${name}`).toBe(true);
      }
      expect(run.jobs!.push!.needs, `${runFile}:push runs after the agent's job`).toEqual([call.name]);
      expect(run.jobs!['implementer-status']!.needs, `${runFile}:implementer-status runs after the push`).toEqual(['push']);
    }
    expect(Object.keys(run.on?.workflow_call?.secrets ?? {})).toEqual(expect.arrayContaining(['app-id', 'app-private-key', 'claude-token', 'anthropic-api-key']));
  });

  it('the mint runs only the mint and the seal, and leaves the revoke to the agent\'s job', () => {
    const mint = run.jobs!.mint!;
    const spine = runFile === 'agent-lane.yml';
    // The spine's mint also proves the push job's token can be minted, before the agent's (the
    // push probe, kanon#1383), and lists the branches that exist before the agent runs: each
    // only when its switch is on, and none running anything but GitHub's API.
    const core = spine ? mint.steps!.filter((s) => s.id === 'app-token' || s.id === 'seal') : mint.steps!;
    if (spine) {
      expect(mint.steps!.map((s) => s.id ?? s.name)).toEqual(['push-probe', "Revoke the push probe's token", 'Say why the push probe failed', 'app-token', 'seal', 'branches']);
      for (const s of mint.steps!.filter((x) => !core.includes(x))) expect(s.if, s.name).toMatch(/inputs\.push|steps\.push-probe\./);
    }
    expect(core.map((s) => s.uses ?? s.id)).toEqual(['actions/create-github-app-token@v3', 'seal']);
    expect(core[0]!.with).toMatchObject({ 'client-id': '${{ secrets.app-id }}', 'private-key': '${{ secrets.app-private-key }}', 'skip-token-revoke': 'true' });
    expect(mint.outputs).toEqual({
      sealed: '${{ steps.seal.outputs.sealed }}', 'app-slug': '${{ steps.app-token.outputs.app-slug }}', attempt: '${{ github.run_attempt }}',
      ...(spine ? { branches: '${{ steps.branches.outputs.branches }}' } : {}),
    });
    expect(core[1]!.run).toBe(docs['agent-lane.yml']!.jobs!.mint!.steps!.find((s) => s.id === 'seal')!.run);
    // No gate of its own: it runs when the call does, inside the calling job's scope.
    expect(mint.needs).toBeUndefined();
    expect(mint.if).toBeUndefined();
    expect(holdsKey(mint)).toBe(true);
    expect(runsOthersCode(mint)).toBeUndefined();
  });

  it('hands the token through the call\'s `secrets:`, the one channel that arrives masked, and every input unchanged', () => {
    const c = call.job;
    expect(c.needs).toBe('mint');
    // A failed mint still reaches the agent's job, so the run is recorded as `token=failure`.
    expect(c.if).toMatch(/!cancelled\(\)/);
    expect(c.secrets).toEqual({ 'app-token': '${{ needs.mint.outputs.sealed }}', 'claude-token': '${{ secrets.claude-token }}', 'anthropic-api-key': '${{ secrets.anthropic-api-key }}' });
    expect(holdsKey(c)).toBe(false);
    expect(c.with?.['app-slug']).toBe('${{ needs.mint.outputs.app-slug }}');
    expect(c.with?.['mint-attempt']).toBe('${{ needs.mint.outputs.attempt }}');
    for (const [k, v] of Object.entries(c.with ?? {}).filter(([k]) => k !== 'app-slug' && k !== 'mint-attempt')) {
      // Never the token as an input: an input is printed in a step's header.
      expect(v, k).toBe(`\${{ inputs.${k} }}`);
    }
    // THE MINT WAITS WITH THE AGENT: a group or a matrix on this call would put the mint outside
    // it, and a token minted before a wait can expire under it. Those sit on the lane's call.
    expect(c.concurrency).toBeUndefined();
    expect(c.strategy).toBeUndefined();
  });

  it('hands both Claude credentials down byte for byte as the spine does, each to its own input of `agent-run` (plan 0009 §10)', () => {
    for (const k of CREDENTIALS) {
      expect(run.on?.workflow_call?.secrets?.[k], `${runFile} ${k}`).toEqual(SPINE_CALL_SECRETS[k]);
      expect(agent.on?.workflow_call?.secrets?.[k], `${agentFile} ${k}`).toEqual(SPINE_JOB_SECRETS[k]);
    }
    const runs = steps.filter(isAgentRun);
    expect(runs).toHaveLength(1);
    expect(credentialInputs(runs[0]!)).toEqual(credentialInputs(SPINE_AGENT_RUN));
  });

  it('receives the token with the spine\'s step: masked before any output, a stale attempt refused', () => {
    const receive = steps.filter((s) => s.id === 'app-token');
    expect(receive).toHaveLength(1);
    expect(tokenStep(receive[0]!)).toEqual(tokenStep(RECEIVE));
    const at = steps.indexOf(receive[0]!);
    // Before any step that uses it, and before the agent.
    const firstUse = steps.findIndex((s) => /steps\.app-token\.outputs/.test(JSON.stringify(s)));
    expect(at).toBeLessThan(firstUse);
    expect(at).toBeLessThan(steps.findIndex(isAgent));
    expect(job.outputs ? JSON.stringify(job.outputs) : '').not.toMatch(/app-token/);
    expect(jobName).toBeTruthy();
  });

  it('revokes the token as its last step, whatever happened before', () => {
    expect(tokenStep(steps.at(-1)!)).toEqual(tokenStep(REVOKE));
    expect(steps.at(-1)!.if).toBe('always()');
  });
});

describe('the Claude credentials reach only `agent-run`, each by its own input (plan 0009 §10, step A2)', () => {
  it('in every workflow, no credential is in a run:, an env:, a mint job, or any other with:', () => {
    expect(credentialLeaks(docs)).toEqual([]);
  });

  it('the spine declares both optional and hands each to its own input', () => {
    for (const k of CREDENTIALS) {
      expect(SPINE_CALL_SECRETS[k], k).toEqual({ required: false });
      expect(SPINE_JOB_SECRETS[k], k).toEqual({ required: false });
      expect(docs['agent-lane.yml']!.jobs!.run!.secrets, k).toMatchObject({ [k]: `\${{ secrets.${k} }}` });
    }
    expect(credentialInputs(SPINE_AGENT_RUN)).toEqual({ 'claude-token': '${{ secrets.claude-token }}', 'anthropic-api-key': '${{ secrets.anthropic-api-key }}' });
  });

  it('catches what it is for: the key in a mint job, a run:, an env:, the action\'s with:, or the wrong input', () => {
    const KEY_REF = '${{ secrets.ANTHROPIC_API_KEY }}';
    const mintStep: Step = { uses: 'actions/create-github-app-token@v3', with: { 'private-key': '${{ secrets.app-private-key }}' } };
    const bad: Record<string, Workflow> = { 'x.yml': { jobs: {
      mint: { env: { ANTHROPIC_API_KEY: KEY_REF }, steps: [mintStep] } as Job,
      run: { steps: [{ run: 'echo ${{ secrets.anthropic-api-key }}' }] },
      env: { steps: [{ uses: '$/actions/agent-run', env: { ANTHROPIC_API_KEY: KEY_REF } }] },
      action: { steps: [{ uses: 'anthropics/claude-code-action@v1', with: { anthropic_api_key: KEY_REF } }] },
      swapped: { steps: [{ uses: '$/actions/agent-run', with: { 'claude-token': KEY_REF } }] },
    } } };
    expect(credentialLeaks(bad).map((l) => l.split(':').slice(0, 2).join(':'))).toEqual(['x.yml:mint', 'x.yml:run', 'x.yml:env', 'x.yml:action', 'x.yml:swapped']);
    const good: Record<string, Workflow> = { 'x.yml': { jobs: {
      call: { uses: '$/.github/workflows/x-run.yml', secrets: { 'anthropic-api-key': KEY_REF } },
      agent: { steps: [{ uses: '$/actions/agent-run', with: { 'anthropic-api-key': '${{ secrets.anthropic-api-key }}', 'claude-token': '${{ secrets.claude-token }}' } }] },
    } } };
    expect(credentialLeaks(good)).toEqual([]);
  });
});

describe('the spine\'s own handoff (kanon#274)', () => {
  const spine = docs['agent-lane.yml']!;
  const { mint, run } = spine.jobs as { mint: Job; run: Job };
  const agentJob = docs['lane-agent-job.yml']!;
  const steps = agentJob.jobs!.run!.steps!;

  it('passes every other input through unchanged, under its own name', () => {
    // The push job's switches are the spine's alone: the probe runs in the mint, and the push job
    // mints with `push-workflows`. The agent's job gets `push`, for its handoff (kanon#1383).
    const spineInputs = Object.keys(spine.on!.workflow_call!.inputs!).filter((k) => !k.startsWith('permission-') && k !== 'push-probe' && k !== 'push-workflows');
    const jobInputs = Object.keys(agentJob.on!.workflow_call!.inputs!);
    expect(jobInputs.sort()).toEqual([...spineInputs, 'app-slug', 'mint-attempt'].sort());
    for (const k of spineInputs) expect(run.with?.[k], k).toBe(`\${{ inputs.${k} }}`);
  });

  it('receives the token before the checkout, which persists it as the push credential', () => {
    expect(steps.findIndex((s) => s.id === 'app-token')).toBeLessThan(steps.findIndex((s) => String(s.uses).startsWith('actions/checkout@')));
    expect(mint.steps!.find((s) => s.id === 'app-token')!.with?.['permission-contents']).toBe('${{ inputs.permission-contents }}');
  });

  it('refuses a token minted for another attempt, by name, before writing it to an output', () => {
    // "Re-run failed jobs" re-runs the agent's job alone, with the earlier attempt's token,
    // which that attempt revoked: without this the checkout fails on bad credentials.
    expect(RECEIVE.env).toMatchObject({ SEALED: '${{ secrets.app-token }}', MINT_ATTEMPT: '${{ inputs.mint-attempt }}', RUN_ATTEMPT: '${{ github.run_attempt }}' });
    const script = String(RECEIVE.run);
    const check = script.indexOf('if [ "$MINT_ATTEMPT" != "$RUN_ATTEMPT" ]');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(script.indexOf('token=$TOKEN'));
    expect(script.slice(check)).toMatch(/Re-run all jobs[\s\S]*exit 1/);
    expect(script.indexOf('::add-mask::$TOKEN')).toBeGreaterThan(-1);
    expect(script.indexOf('::add-mask::$TOKEN')).toBeLessThan(script.indexOf('token=$TOKEN'));
  });

  it('revokes from the secret itself, so a run that ended before the receive still revokes', () => {
    expect(REVOKE.name).toBe('Revoke the App token');
    expect(REVOKE.env).toMatchObject({ SEALED: '${{ secrets.app-token }}', MINT_ATTEMPT: '${{ inputs.mint-attempt }}', RUN_ATTEMPT: '${{ github.run_attempt }}' });
    const script = String(REVOKE.run);
    expect(script).toContain('/installation/token');
    expect(script.indexOf('::add-mask::$TOKEN')).toBeGreaterThan(-1);
    expect(script.indexOf('::add-mask::$TOKEN')).toBeLessThan(script.indexOf('curl'));
    // Never an earlier attempt's: that attempt revoked it, and its value is not this run's.
    expect(script).toMatch(/\[ "\$MINT_ATTEMPT" != "\$RUN_ATTEMPT" \][\s\S]*exit 0[\s\S]*curl/);
  });
});

/**
 * Plan 0010 §9, step D4: no model in the deploy path. The deploy lane's two workflows run the
 * adopter's deploy hook with a cloud credential, so none of their jobs runs an agent, holds an
 * App key, mints an App token or reads a Claude credential: an instruction hidden in a release
 * note or a log would otherwise meet that credential.
 */
const DEPLOY_LANE = ['deploy-release.yml', 'deploy.yml'];
const modelInDeploy = (all: Record<string, Workflow>): string[] => DEPLOY_LANE.flatMap((f) => Object.entries(all[f]?.jobs ?? {}).flatMap(([name, job]) => {
  const why = [
    ...(holdsKey(job) ? ['holds an App key'] : []),
    ...((job.steps ?? []).some(isAgent) ? ['runs the agent'] : []),
    ...((job.steps ?? []).some((s) => String(s.uses ?? '').startsWith('actions/create-github-app-token')) ? ['mints an App token'] : []),
    ...(CREDENTIAL.test(JSON.stringify(job)) ? ['reads a Claude credential'] : []),
  ];
  return why.map((w) => `${f}:${name}: ${w}`);
}));

describe('no model in the deploy path (plan 0010 §9, step D4)', () => {
  it('reads both workflows, and finds nothing in any job', () => {
    for (const f of DEPLOY_LANE) expect(Object.keys(docs[f]?.jobs ?? {}).length, f).toBeGreaterThanOrEqual(4);
    expect(modelInDeploy(docs)).toEqual([]);
  });

  it('MUTATION: an `agent-run` step in report, a mint, or a Claude credential turns it red', () => {
    const bad = structuredClone(docs);
    bad['deploy.yml']!.jobs!.report!.steps!.push({ uses: '$/actions/agent-run' });
    bad['deploy-release.yml']!.jobs!.gate!.steps!.push({ uses: 'actions/create-github-app-token@v3', with: { 'private-key': '${{ secrets.AUTHOR_APP_PRIVATE_KEY }}' } });
    bad['deploy.yml']!.jobs!.record!.steps!.push({ run: 'x', env: { T: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' } });
    expect(modelInDeploy(bad)).toEqual([
      'deploy-release.yml:gate: holds an App key', 'deploy-release.yml:gate: mints an App token',
      'deploy.yml:record: reads a Claude credential', 'deploy.yml:report: runs the agent',
    ]);
  });
});

describe('the check catches what it is for', () => {
  const agent: Step = { uses: '$/actions/agent-run' };
  const mint: Step = { uses: 'actions/create-github-app-token@v3', with: { 'private-key': '${{ secrets.AUTHOR_APP_PRIVATE_KEY }}' } };

  it('a mint in the agent\'s job, before or after the agent', () => {
    expect(violations({ 'x.yml': { jobs: { a: { steps: [mint, agent] }, b: { steps: [agent, mint] } } } })).toEqual({ 'x.yml:a': 'runs the agent', 'x.yml:b': 'runs the agent' });
  });

  it('an agent called without the block, and the block at a pinned release', () => {
    for (const uses of ['anthropics/claude-code-action@v1.0.239', 'yedeya-labs/kanon/actions/agent-run@v1.2.3']) {
      expect(Object.keys(violations({ 'x.yml': { jobs: { a: { steps: [mint, { uses }] } } } })), uses).toEqual(['x.yml:a']);
    }
  });

  it('every spelling of the key: a dash, a computed name, a reusable workflow\'s own secret', () => {
    for (const k of ['${{ secrets.app-private-key }}', "${{ secrets[format('{0}_APP_PRIVATE_KEY', matrix.app)] }}", '${{ secrets.Reviewer_App_Private_Key }}']) {
      expect(holdsKey({ steps: [{ uses: 'x', with: { 'private-key': k } }] }), k).toBe(true);
    }
    expect(holdsKey({ steps: [{ uses: 'x', with: { token: '${{ secrets.claude-token }}' } }] })).toBe(false);
  });

  it('the key in a step\'s env, the job\'s env, or a reusable call\'s secrets', () => {
    const run = { run: 'true', env: { K: '${{ secrets.AUTHOR_APP_PRIVATE_KEY }}' } };
    expect(Object.keys(violations({ 'x.yml': { jobs: { a: { steps: [agent, run] } } } }))).toEqual(['x.yml:a']);
    expect(Object.keys(violations({ 'x.yml': { jobs: { a: { env: { K: '${{ secrets.X_PRIVATE_KEY }}' }, steps: [agent] } as Job } } }))).toEqual(['x.yml:a']);
  });

  it('project code and a PR checkout, as well as the agent', () => {
    expect(violations({ 'x.yml': { jobs: {
      hook: { steps: [mint, { uses: './.github/actions/project-setup' }] },
      pr: { steps: [mint, { uses: 'actions/checkout@v7', with: { ref: '${{ inputs.ref }}' } }] },
      plain: { steps: [mint, { uses: 'actions/checkout@v7' }] },
      main: { steps: [mint, { uses: 'actions/checkout@v7', with: { ref: '${{ github.event.repository.default_branch }}' } }] },
    } } })).toEqual({ 'x.yml:hook': 'runs `./.github/actions/project-setup` from the checkout', 'x.yml:pr': 'checks out a ref other than the triggering commit' });
  });

  it('the notify block, which runs the adopter\'s hook, at Kanon\'s commit or a release (plan 0011 step N6)', () => {
    for (const uses of ['$/actions/notify', 'yedeya-labs/kanon/actions/notify@v1.2.3']) {
      expect(violations({ 'x.yml': { jobs: { notify: { steps: [mint, { uses, with: { secret: '${{ secrets.KANON_CHAT_PROJECT_DIGEST }}' } }] } } } }), uses)
        .toEqual({ 'x.yml:notify': 'runs the notify hook from the checkout' });
    }
    expect(violations({ 'x.yml': { jobs: { notify: { steps: [{ uses: '$/actions/notify', with: { secret: '${{ secrets.KANON_CHAT_PROJECT_DIGEST }}' } }] } } } })).toEqual({});
    // Kanon's prebuilt hooks' own actions are not the block: they run only inside the hook.
    expect(violations({ 'x.yml': { jobs: { a: { steps: [mint, { uses: 'yedeya-labs/kanon/actions/notify/slack@v1.2.3' }] } } } })).toEqual({});
  });
});

describe('the receive and revoke steps work as written', () => {
  // Run with a harmless placeholder, never a real token: the decode is `printf` and `sed`, and a
  // doubled backslash lost to an edit would hand the checkout garbage instead of the token.
  const placeholder = 'ghs_placeholder0123456789';
  const sealed = Buffer.from(placeholder).toString('hex');
  const runIt = (script: string, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'app-token-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    // A `curl` that records its arguments and answers 204, so the revoke never reaches a network.
    // A link to the shared shim, never a new executable that macOS scans on its first run (#436).
    writeStub(join(dir, 'curl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/curl.args"\nprintf 204\n`);
    const stdout = execFileSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, ...env } });
    let curl = '';
    try { curl = readFileSync(join(dir, 'curl.args'), 'utf8'); } catch { /* not called */ }
    return { stdout, output: readFileSync(out, 'utf8'), curl };
  };

  it('the receive step decodes the token, masks it, and outputs it', () => {
    const r = runIt(String(RECEIVE.run), { SEALED: sealed, APP_SLUG: 'x-bot', MINT_ATTEMPT: '1', RUN_ATTEMPT: '1' });
    expect(r.stdout).toContain(`::add-mask::${placeholder}`);
    expect(r.output).toContain(`token=${placeholder}\n`);
    expect(r.output).toContain('app-slug=x-bot\n');
  });

  it('the revoke step decodes the same token and revokes with it, and skips another attempt\'s', () => {
    const r = runIt(String(REVOKE.run), { SEALED: sealed, MINT_ATTEMPT: '2', RUN_ATTEMPT: '2', API_URL: 'https://api.invalid' });
    expect(r.stdout).toContain(`::add-mask::${placeholder}`);
    expect(r.curl).toContain(`Authorization: Bearer ${placeholder}`);
    expect(r.curl).toContain('https://api.invalid/installation/token');
    expect(r.stdout).toContain('App token revoked');
    const stale = runIt(String(REVOKE.run), { SEALED: sealed, MINT_ATTEMPT: '1', RUN_ATTEMPT: '2', API_URL: 'https://api.invalid' });
    expect(stale.curl).toBe('');
  });
});
