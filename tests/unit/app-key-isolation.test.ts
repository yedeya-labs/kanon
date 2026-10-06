import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * `K-AGENT-49` (kanon#274, kanon#279): no job that runs an agent, the project's code, or a pull
 * request's code holds an App's private key. The rule's Why is in `rulebook/03-agents.md`: it is
 * the job that must lack the key, not a step, so this checks jobs.
 *
 * WHAT COUNTS AS RUNNING SOMEONE ELSE'S CODE:
 *   • the agent: Kanon's `agent-run` block, or `claude-code-action` called directly;
 *   • a `./` action: the project's own code from the checkout (the project-setup hook);
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

  it('finds the spine and all eight lanes that call the blocks themselves', () => {
    expect(AGENT_JOBS).toEqual([
      'code-audit-agent-job.yml', 'explore-agent-job.yml', 'lane-agent-job.yml', 'lead-split-agent-job.yml',
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
    expect(Object.keys(agent.on?.workflow_call?.secrets ?? {}).sort()).toEqual(['app-token', 'claude-token']);
    expect(KEY.test(readFileSync(join(WF, agentFile), 'utf8'))).toBe(false);
    expect(Object.keys(agent.jobs ?? {})).toHaveLength(1);
    expect(steps.some((s) => String(s.uses ?? '').startsWith('actions/create-github-app-token@'))).toBe(false);
  });

  it('is called from exactly one place: a workflow that holds the mint and this call, and nothing else', () => {
    expect(call, `${agentFile} is called by no workflow`).toBeDefined();
    expect(more.map((c) => `${c.file}:${c.name}`)).toEqual([]);
    expect(Object.keys(run.jobs ?? {}).sort()).toEqual([call.name, 'mint'].sort());
    expect(Object.keys(run.on?.workflow_call?.secrets ?? {})).toEqual(expect.arrayContaining(['app-id', 'app-private-key', 'claude-token']));
  });

  it('the mint runs only the mint and the seal, and leaves the revoke to the agent\'s job', () => {
    const mint = run.jobs!.mint!;
    expect(mint.steps!.map((s) => s.uses ?? s.id)).toEqual(['actions/create-github-app-token@v3', 'seal']);
    expect(mint.steps![0]!.with).toMatchObject({ 'client-id': '${{ secrets.app-id }}', 'private-key': '${{ secrets.app-private-key }}', 'skip-token-revoke': 'true' });
    expect(mint.outputs).toEqual({ sealed: '${{ steps.seal.outputs.sealed }}', 'app-slug': '${{ steps.app-token.outputs.app-slug }}', attempt: '${{ github.run_attempt }}' });
    expect(mint.steps![1]!.run).toBe(docs['agent-lane.yml']!.jobs!.mint!.steps![1]!.run);
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
    expect(c.secrets).toEqual({ 'app-token': '${{ needs.mint.outputs.sealed }}', 'claude-token': '${{ secrets.claude-token }}' });
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

describe('the spine\'s own handoff (kanon#274)', () => {
  const spine = docs['agent-lane.yml']!;
  const { mint, run } = spine.jobs as { mint: Job; run: Job };
  const agentJob = docs['lane-agent-job.yml']!;
  const steps = agentJob.jobs!.run!.steps!;

  it('passes every other input through unchanged, under its own name', () => {
    const spineInputs = Object.keys(spine.on!.workflow_call!.inputs!).filter((k) => !k.startsWith('permission-'));
    const jobInputs = Object.keys(agentJob.on!.workflow_call!.inputs!);
    expect(jobInputs.sort()).toEqual([...spineInputs, 'app-slug', 'mint-attempt'].sort());
    for (const k of spineInputs) expect(run.with?.[k], k).toBe(`\${{ inputs.${k} }}`);
  });

  it('receives the token before the checkout, which persists it as the push credential', () => {
    expect(steps.findIndex((s) => s.id === 'app-token')).toBeLessThan(steps.findIndex((s) => String(s.uses).startsWith('actions/checkout@')));
    expect(mint.steps![0]!.with?.['permission-contents']).toBe('${{ inputs.permission-contents }}');
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
    writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/curl.args"\nprintf 204\n`, { mode: 0o755 });
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
