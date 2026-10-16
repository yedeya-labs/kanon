import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { laneBlockOf } from './helpers/agent-lanes.mjs';
import { callerInputs, realGroup } from './helpers/smoke-group.js';
import { secretsRead, startsNotify } from './helpers/notify-jobs.js';

/**
 * The two digests (plan 0004 step 10), moved from the reference adopter: the daily project
 * digest with its health job, and the weekly digest. What their scripts decide is tested in
 * `tests/library/` (project-digest, weekly-digest, workflow-health); this file
 * holds the lanes' own wiring, including the reference adopter's workflow tests that moved
 * with them (RA-1473's narrative step, RA-1036's health job).
 */

const ROOT = process.cwd();
type Step = WorkflowStep & { id?: string; name?: string; if?: string; run?: string; 'continue-on-error'?: boolean };
type Job = { if?: string; needs?: string | string[]; permissions?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[] };
type Lane = {
  on: { workflow_call: { inputs: Record<string, { type: string; required: boolean }>; secrets: Record<string, { required: boolean }> } };
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const text = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const lane = (file: string) => parse(text(`.github/workflows/${file}`)) as Lane;
const caller = (file: string) => parse(text(`tests/fixtures/lane-check/extra/${file}`)) as {
  on: Record<string, { cron: string }[] | { inputs: Record<string, unknown> }>;
  permissions: Record<string, string>;
  jobs: Record<string, { uses: string; with?: Record<string, string>; secrets: Record<string, string> }>;
};

const PROJECT = 'agent-project-digest.yml';
const WEEKLY = 'agent-weekly-digest.yml';
const DIGESTS = [PROJECT, WEEKLY] as const;
/** The project digest's producer starts only when the digest will be posted, or on a dry run (plan 0011 N7). */
const PROJECT_DIGEST_IF = "needs.gate.outputs.member == 'true' && (needs.gate.outputs.post == 'true' || inputs.dry_run == 'true')";

const step = (file: string, job: string, pred: (s: Step) => boolean): Step => {
  const s = (lane(file).jobs[job]?.steps ?? []).find(pred);
  if (!s) throw new Error(`no such step in ${file}:${job}`);
  return s;
};
const narrative = (file: string) => step(file, 'digest', (s) => s.id === 'agent');
/** The step that runs the digest's script and writes its message (plan 0011 N7 and N8). */
const post = (file: string) => step(file, 'digest', (s) => s.id === 'message');
const finish = (file: string) => step(file, 'digest', (s) => s.id === 'finish');
const flag = (args: unknown, name: string) => new RegExp(`(?:^|\\s)${name}[\\s=]+(\\S+)`).exec(String(args ?? ''))?.[1];

/** `github.event_name == '…'`, joined by `||` and `&&`, for one event. */
const admits = (cond: string | undefined, event: string): boolean => {
  const js = String(cond)
    .replace(/github\.event_name/g, JSON.stringify(event))
    .replace(/'([^']*)'/g, (_m, s: string) => JSON.stringify(s))
    .replace(/==/g, '===');
  if (/github\.|\w+\s*\(/.test(js)) throw new Error(`unmodelled expression: ${js}`);
  return Boolean(new Function(`return (${js});`)());
};

describe('each digest is a called lane, with its caller’s two triggers', () => {
  it.each(DIGESTS)('%s: the gate job starts only on the schedule or a dispatch', (file) => {
    const cond = lane(file).jobs.gate?.if;
    expect(admits(cond, 'schedule')).toBe(true);
    expect(admits(cond, 'workflow_dispatch')).toBe(true);
    for (const e of ['push', 'pull_request', 'merge_group', 'pull_request_review', 'issues', 'workflow_run']) expect(admits(cond, e), e).toBe(false);
  });

  it.each([PROJECT])('%s: every other job waits for the gate and its verdict', (file) => {
    for (const [id, job] of Object.entries(lane(file).jobs)) {
      if (id === 'gate') continue;
      // The project digest's `notify` job (plan 0011 N7) needs the producer too, and its `if:` is
      // `notify-jobs.ts`'s, held by notify-guard.test.ts and lane-gate.test.ts.
      if (file === PROJECT && id === 'notify') { expect([job.needs].flat()).toEqual(['gate', 'digest']); continue; }
      expect([job.needs].flat(), `${file}:${id}`).toEqual(['gate']);
      expect(job.if, `${file}:${id}`).toBe(file === PROJECT && id === 'digest' ? PROJECT_DIGEST_IF : "needs.gate.outputs.member == 'true'");
    }
    expect(lane(file).jobs.gate?.outputs?.member).toBe('${{ steps.gate.outputs.member }}');
  });

  it.each(DIGESTS)('%s: takes one Claude credential, and its chat secret optionally, and no App', (file) => {
    const secrets = lane(file).on.workflow_call.secrets;
    // Each digest's kind's secret replaces DIGEST_WEBHOOK (plan 0011 N7 and N8, decision 17).
    const chat = file === PROJECT ? 'KANON_CHAT_PROJECT_DIGEST' : 'KANON_CHAT_WEEKLY_DIGEST';
    expect(Object.keys(secrets).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', chat]);
    // The token or an API key, its caller maps one (plan 0009 §10): `agent-run` refuses both or neither.
    expect(secrets.CLAUDE_CODE_OAUTH_TOKEN?.required).toBe(false);
    expect(secrets.ANTHROPIC_API_KEY?.required).toBe(false);
    // Without it the digest posts nothing and stays green (plan 0004 §6, plan 0011 §8).
    expect(secrets[chat]?.required).toBe(false);
    expect(text(`.github/workflows/${file}`)).not.toMatch(/create-github-app-token|_APP_ID/);
  });

  it.each(DIGESTS)('%s: takes its inputs as optional strings, passed through by the caller', (file) => {
    for (const [name, input] of Object.entries(lane(file).on.workflow_call.inputs)) {
      expect(input, `${file}: ${name}`).toMatchObject({ type: 'string', required: false });
    }
    const job = Object.values(caller(file).jobs)[0]!;
    expect(job.with).toEqual(Object.fromEntries(Object.keys(callerInputs(lane(file).on.workflow_call.inputs)!).map((k) => [k, `\${{ inputs.${k} }}`])));
  });

  it('keeps `dry_run` on both and `week_end` on the weekly one', () => {
    expect(Object.keys(callerInputs(lane(PROJECT).on.workflow_call.inputs)!)).toEqual(['dry_run']);
    expect(Object.keys(callerInputs(lane(WEEKLY).on.workflow_call.inputs)!)).toEqual(['week_end', 'dry_run']);
    expect(post(WEEKLY).env?.WEEK_END).toBe('${{ inputs.week_end }}');
  });

  it.each(DIGESTS)('%s: holds its own concurrency group, never cancelling a post in flight', (file) => {
    const c = lane(file).concurrency!;
    expect({ ...c, group: realGroup(c.group) }).toEqual({ group: expect.stringMatching(/^kanon-.*digest$/), 'cancel-in-progress': false });
  });

  it('the fixture callers keep the reference adopter’s schedules, in under 40 lines', () => {
    expect(caller(PROJECT).on.schedule).toEqual([{ cron: '35 7 * * *' }]);
    expect(caller(WEEKLY).on.schedule).toEqual([{ cron: '0 8 * * 1' }]);
    for (const file of DIGESTS) expect(text(`tests/fixtures/lane-check/extra/${file}`).trimEnd().split('\n').length, file).toBeLessThan(40);
  });
});

describe('a dry run is a dry run, and the schedule is not one', () => {
  // `dry_run` reaches the lane as a STRING: `'false'` from an unticked dispatch is truthy, so
  // `inputs.dry_run && '1'` would make every dispatch a dry run.
  it.each(DIGESTS)('%s: the post is dry only on `true`', (file) => {
    expect(post(file).env?.DRY_RUN).toBe("${{ inputs.dry_run == 'true' && '1' || '' }}");
  });

  it('the health check files on the schedule and on a dispatch that is not dry', () => {
    const health = step(PROJECT, 'health', (s) => /workflow-health\.mjs/.test(s.run ?? ''));
    expect(health.env?.APPLY).toBe("${{ inputs.dry_run != 'true' && '1' || '' }}");
  });
});

describe('each digest runs its script, and names no webhook (plan 0011 N7 and N8)', () => {
  it.each(DIGESTS)('%s: names neither DIGEST_WEBHOOK nor a Slack webhook', (file) => {
    expect(JSON.stringify(lane(file))).not.toMatch(/DIGEST_WEBHOOK|SLACK_[A-Z_]*WEBHOOK/);
  });

  it.each(DIGESTS)('%s: runs Kanon’s script, from Kanon’s tree', (file) => {
    const script = file === PROJECT ? 'project-digest' : 'weekly-digest';
    expect(post(file).run).toContain(`node "$KANON/scripts/${script}.mjs"`);
    expect(text(`.github/workflows/${file}`)).not.toMatch(/\bnode (?!"\$KANON)|scripts\/qa\//);
  });
});

/**
 * RA-1473: the narrative step is `continue-on-error` and its output is read with `|| true`,
 * so it can lose its tools and still report success — which is exactly what shipped: 21
 * turns, 13 permission denials, no narrative, every guard green.
 */
describe('the narrative step can actually do its job (RA-1473)', () => {
  it.each(DIGESTS)('%s: declares claude_args, granting every tool the prompt requires', (file) => {
    const args = narrative(file).with?.claude_args;
    expect(args).toBeDefined();
    // Read: the briefs or releases. Bash: `gh`. Write: narrative.txt, the step's ONLY output.
    expect(flag(args, '--allowedTools')?.split(',')).toEqual(expect.arrayContaining(['Read', 'Bash', 'Write']));
  });

  it.each(DIGESTS)('%s: pins a model and bounds the turns and the budget', (file) => {
    const args = narrative(file).with?.claude_args;
    expect(flag(args, '--model')).toMatch(/^claude-/);
    expect(Number(flag(args, '--max-turns'))).toBeGreaterThan(0);
    expect(Number(flag(args, '--max-budget-usd'))).toBeGreaterThan(0);
  });

  it('moves each arm’s model chain as the reference adopter ran it', () => {
    expect([flag(narrative(PROJECT).with?.claude_args, '--model'), flag(narrative(PROJECT).with?.claude_args, '--fallback-model')])
      .toEqual(['claude-sonnet-5', 'claude-opus-5-5']);
    expect([flag(narrative(WEEKLY).with?.claude_args, '--model'), flag(narrative(WEEKLY).with?.claude_args, '--fallback-model')])
      .toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  it.each(DIGESTS)('%s: the finish block records the flags the agent ran with', (file) => {
    expect(finish(file).with?.claude_args).toBe(narrative(file).with?.claude_args);
  });

  it.each(DIGESTS)('%s: the prompt names narrative.txt, which is what the post step reads', (file) => {
    expect(narrative(file).with?.prompt).toContain('narrative.txt');
    expect(post(file).run).toContain('narrative.txt');
  });

  it.each(DIGESTS)('%s: keeps the narrative non-fatal and the post fatal', (file) => {
    expect(narrative(file)['continue-on-error']).toBe(true);
    expect(post(file)['continue-on-error']).toBeUndefined();
    expect(post(file).run).toContain('set -euo pipefail');
  });

  it.each(DIGESTS)('%s: explains a failed narrative from the step, not the job, and never reds the job', (file) => {
    const classify = step(file, 'digest', (s) => String(s.uses).endsWith('/agent-classify'));
    expect(classify.if).toBe("always() && steps.agent.outcome == 'failure'");
    expect(classify.with?.['non-fatal']).toBe('true');
    expect(finish(file).with?.classify).toBe('false');
  });

  it('only the project digest pins the 5-minute cache: every run ends inside it (RA-2058)', () => {
    expect(narrative(PROJECT).with?.['prompt-cache-ttl']).toBe('5m');
    expect(narrative(WEEKLY).with?.['prompt-cache-ttl']).toBeUndefined();
  });
});

describe('the weekly prompt names no adopter’s audience or product (plan 0004 §5)', () => {
  // What the reference adopter's prompt said, and Kanon's lane must not: its audience, and the
  // examples drawn from its product and stack.
  it('says none of the reference adopter’s words', () => {
    const prompt = String(narrative(WEEKLY).with?.prompt);
    expect(prompt).not.toMatch(/co-founder|runway|PaymentIntents|Stripe|hydration|\bRLS\b|tax calculated|by card/i);
  });

  it('names the audience the adoption record declares, read before the agent (kanon#218)', () => {
    const steps = lane(WEEKLY).jobs.digest!.steps!;
    const read = steps.findIndex((s) => s.id === 'audience');
    expect(read, 'no audience step').toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(steps.findIndex((s) => s.id === 'agent'));
    expect(steps[read]!.if, 'a malformed record must stop the run, not be skipped').toBeUndefined();
    expect(steps[read]!['continue-on-error']).toBeUndefined();
    expect(steps[read]!.run).toContain('audience="$(node "$KANON/scripts/digest-audience.mjs")"');
    expect(steps[read]!.run).toContain('set -euo pipefail');
    expect(steps[read]!.env).toMatchObject({ GH_TOKEN: '${{ github.token }}', GITHUB_REPOSITORY: '${{ github.repository }}' });
    expect(String(narrative(WEEKLY).with?.prompt)).toContain('The reader is ${{ steps.audience.outputs.audience }}.');
    // The declared audience alone says who reads it (the Owner, 2026-10-04): no sentence
    // that presumes a non-technical reader. The plain-language rules stay.
    expect(String(narrative(WEEKLY).with?.prompt)).not.toMatch(/not a\s+developer/i);
    expect(String(narrative(WEEKLY).with?.prompt)).toMatch(/Plain language\./);
  });
});

describe('the health job (RA-1036)', () => {
  const wf = lane(PROJECT);

  it('is a separate job, so the digest job keeps its refusal of `actions: read`', () => {
    expect(wf.jobs.health?.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' });
    expect(wf.jobs.digest?.permissions?.actions, 'the digest job must not read Actions').toBeUndefined();
    expect(wf.permissions.actions, 'nor the workflow').toBeUndefined();
  });

  it('does not wait for the digest, so a chat outage cannot hide a dead workflow', () => {
    expect([wf.jobs.health?.needs].flat()).toEqual(['gate']);
  });

  it('runs Kanon’s script in the adopter’s checkout, with the repository named', () => {
    const steps = wf.jobs.health!.steps!;
    expect(String(steps[0]?.uses)).toMatch(/^actions\/checkout@/);
    const run = steps.find((s) => /workflow-health\.mjs/.test(s.run ?? ''))!;
    expect(run.run).toBe('node "$KANON/scripts/workflow-health.mjs"');
    expect(run.env).toMatchObject({ GH_TOKEN: '${{ github.token }}', GITHUB_REPOSITORY: '${{ github.repository }}' });
  });
});

// Plan 0011 step N7: the project digest posts through the notify job. The gate decides whether
// anything will post (kanon#836's step "Will the digest be posted?", moved out of the `digest` job,
// which holds the Claude credential, and widened from DIGEST_WEBHOOK to the hook and the kind's
// secret); the `digest` job writes the message and holds no chat secret; the `notify` job posts.
describe('the project digest posts through the notify job (plan 0011 N7)', () => {
  const wf = lane(PROJECT);
  const gate = wf.jobs.gate!;
  const decide = step(PROJECT, 'gate', (s) => s.id === 'post');
  const CHAT = 'KANON_CHAT_PROJECT_DIGEST';
  const CLAUDE = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

  /** Run the gate's decision in a checkout with or without the hook, with or without the secret. */
  const decideIn = (hook: boolean, secret: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-gate-'));
    if (hook) {
      mkdirSync(join(dir, '.github/actions/notify'), { recursive: true });
      writeFileSync(join(dir, '.github/actions/notify/action.yml'), 'runs:\n  using: composite\n  steps: []\n');
    }
    return runWorkflowStep(decide, { cwd: dir, env: { HAS_SECRET: secret ? 'true' : 'false' } });
  };

  /** Does the `digest` job start, for its `if:` in this world? */
  const digestStarts = (cond: string | undefined, world: { member: string; post: string; dryRun: string }) => {
    const js = String(cond)
      .replace(/needs\.gate\.outputs\.member/g, JSON.stringify(world.member))
      .replace(/needs\.gate\.outputs\.post/g, JSON.stringify(world.post))
      .replace(/inputs\.dry_run/g, JSON.stringify(world.dryRun))
      .replace(/'([^']*)'/g, (_m, x: string) => JSON.stringify(x))
      .replace(/==/g, '===');
    if (/needs\.|inputs\.|github\.|\w+\s*\(/.test(js)) throw new Error(`unmodelled expression: ${js}`);
    return Boolean(new Function(`return (${js});`)());
  };
  const worlds = (cond: string | undefined) => ({
    posting: digestStarts(cond, { member: 'true', post: 'true', dryRun: '' }),
    noPost: digestStarts(cond, { member: 'true', post: 'false', dryRun: '' }),
    dryRun: digestStarts(cond, { member: 'true', post: 'false', dryRun: 'true' }),
    refused: digestStarts(cond, { member: 'false', post: '', dryRun: 'true' }),
  });

  it('the lane declares no DIGEST_WEBHOOK at all, so a caller still mapping it is refused (decision 17)', () => {
    expect(Object.keys(wf.on.workflow_call.secrets)).not.toContain('DIGEST_WEBHOOK');
    expect(JSON.stringify(wf)).not.toContain('DIGEST_WEBHOOK');
    // The fixture caller maps the kind's secret in its place.
    const secrets = Object.values(caller(PROJECT).jobs)[0]!.secrets;
    expect(secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}', [CHAT]: `\${{ secrets.${CHAT} }}` });
  });

  it("the gate decides, reading the hook from a sparse checkout that keeps no credential and the secret as one presence boolean", () => {
    expect(gate.outputs).toEqual({ member: '${{ steps.gate.outputs.member }}', hook: '${{ steps.post.outputs.hook }}', post: '${{ steps.post.outputs.post }}' });
    expect(decide.if).toBe("steps.gate.outputs.member == 'true'");
    expect(decide.env).toEqual({ HAS_SECRET: `\${{ secrets.${CHAT} != '' }}` });
    const checkout = gate.steps!.find((s) => String(s.uses).startsWith('actions/checkout@'))!;
    expect(checkout.if).toBe("steps.gate.outputs.member == 'true'");
    expect(checkout.with).toEqual({ 'persist-credentials': false, 'sparse-checkout': '.github/actions/notify', 'sparse-checkout-cone-mode': false });
    expect(gate.steps!.indexOf(checkout)).toBeLessThan(gate.steps!.findIndex((s) => s.id === 'post'));
    expect(secretsRead(gate)).toEqual([CHAT]);
  });

  it.each([
    ['a hook and the secret', true, true, 'present', 'true', null],
    ['the secret and no hook (decision 2: nothing posts)', false, true, 'none', 'false', 'No notify hook: nothing was posted'],
    ['a hook and no secret', true, false, 'present', 'false', 'No chat secret for the project digest: this kind was not posted'],
    ['neither', false, false, 'none', 'false', 'No notify hook: nothing was posted'],
  ] as const)('with %s: hook=%s, post=%s', (_name, hook, secret, wantHook, wantPost, said) => {
    const r = decideIn(hook, secret);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs).toMatchObject({ hook: wantHook, post: wantPost });
    if (said) expect(r.summary).toContain(said);
    else expect(r.summary).toBe('');
    if (said) expect(r.summary).toContain('no model runs. The health job still runs');
  });

  it('with the secret and no hook nothing posts: the digest is skipped and the notify job does not start (decision 2)', () => {
    const r = decideIn(false, true);
    expect(worlds(wf.jobs.digest!.if).noPost).toBe(false);
    const notify = wf.jobs.notify!;
    const world = { member: 'true', hook: r.outputs.hook!, dryRun: '', cancelled: false, gate: 'success', producer: 'skipped' } as const;
    expect(startsNotify(notify.if, [notify.needs ?? []].flat(), world)).toBe(false);
    // …and with the hook, it starts, and records the skip or the post.
    expect(startsNotify(notify.if, [notify.needs ?? []].flat(), { ...world, hook: decideIn(true, true).outputs.hook! })).toBe(true);
  });

  it('the digest job runs, and so its model, only when the digest will be posted or printed by a dry run', () => {
    expect(worlds(wf.jobs.digest!.if)).toEqual({ posting: true, noPost: false, dryRun: true, refused: false });
  });

  it("goes red when the digest job's if: loses the hook condition (mutation)", () => {
    expect(worlds("needs.gate.outputs.member == 'true'").noPost).toBe(true);
    expect(wf.jobs.digest!.if).not.toBe("needs.gate.outputs.member == 'true'");
  });

  it('no step of the digest job decides, or reads a chat secret: only the Claude credential', () => {
    const steps = wf.jobs.digest!.steps!;
    const problems = (ss: Step[]) => ss.flatMap((s) => [
      ...(s.id === 'post' || /steps\.post\./.test(JSON.stringify(s)) ? [`${s.name ?? s.id ?? s.uses}: kanon#836's decision`] : []),
      ...secretsRead(s).filter((x) => !CLAUDE.includes(x)).map((x) => `${s.name ?? s.id ?? s.uses}: ${x}`),
    ]);
    expect(problems(steps)).toEqual([]);
    // N0's step left in the digest job, as it was before N7, is caught (mutation).
    const n0 = { name: 'Will the digest be posted?', id: 'post', env: { DIGEST_WEBHOOK: '${{ secrets.DIGEST_WEBHOOK }}' }, run: 'true' };
    expect(problems([n0, ...steps])).toEqual(["Will the digest be posted?: kanon#836's decision", 'Will the digest be posted?: DIGEST_WEBHOOK']);
    expect(problems([...steps, { name: 'Post', env: { URL: `\${{ secrets.${CHAT} }}` }, run: 'curl "$URL"' }])).toEqual([`Post: ${CHAT}`]);
  });

  it('the agent blocks run whenever the job does: the job itself is the decision', () => {
    const steps = wf.jobs.digest!.steps!;
    for (const b of ['agent-setup', 'agent-run']) expect(steps.find((s) => laneBlockOf(s) === b)?.if, b).toBeUndefined();
    expect(steps.find((s) => laneBlockOf(s) === 'agent-finish')?.if).toBe('always()');
  });

  /** A stub `$KANON/scripts/project-digest.mjs` that records what it was run with. */
  const runMessageStep = (dryRun: string) => {
    const kanon = mkdtempSync(join(tmpdir(), 'digest-kanon-'));
    mkdirSync(join(kanon, 'scripts'));
    writeFileSync(join(kanon, 'scripts/project-digest.mjs'), "console.log(`ran dry=${process.env.DRY_RUN ?? ''} dir=${process.env.MESSAGE_DIR ?? ''}`);\n");
    const message = post(PROJECT);
    return runWorkflowStep(message, {
      cwd: mkdtempSync(join(tmpdir(), 'digest-ws-')),
      env: { KANON: kanon, DRY_RUN: dryRun, MESSAGE_DIR: '/tmp/m', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '3' },
    });
  };

  it('names the artifact with its own run and attempt, and a dry run names none, so nothing is uploaded (§4)', () => {
    const real = runMessageStep('');
    expect(real.status, real.output).toBe(0);
    expect(real.stdout).toContain('ran dry= dir=/tmp/m');
    expect(real.outputs.artifact).toBe('kanon-notify-project-digest-digest-42-3');
    const dry = runMessageStep('1');
    expect(dry.status, dry.output).toBe(0);
    expect(dry.stdout).toContain('ran dry=1');
    expect(dry.outputs.artifact).toBeUndefined();
    const upload = step(PROJECT, 'digest', (s) => s.id === 'upload');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
    expect(upload.if).toBe("steps.message.outputs.artifact != ''");
    expect(upload.with).toMatchObject({ name: '${{ steps.message.outputs.artifact }}', path: '${{ runner.temp }}/kanon-notify-message/message.json', 'if-no-files-found': 'error' });
    expect(post(PROJECT).env?.MESSAGE_DIR).toBe('${{ runner.temp }}/kanon-notify-message');
    // Published as the job's output only once uploaded: the notify job reads it, never computes it.
    expect(wf.jobs.digest!.outputs).toEqual({ 'message-artifact': "${{ steps.upload.outcome == 'success' && steps.message.outputs.artifact || '' }}" });
  });

  it('with a hook, the notify job hands it KANON_CHAT_PROJECT_DIGEST and the digest job\'s message, and no other secret', () => {
    const notify = wf.jobs.notify!;
    expect(notify.steps).toEqual([{ uses: '$/actions/notify', id: 'notify', with: { kind: 'project-digest', artifact: '${{ needs.digest.outputs.message-artifact }}', secret: `\${{ secrets.${CHAT} }}` } }]);
    expect(secretsRead(notify)).toEqual([CHAT]);
  });

  it('the health job runs whatever the gate decides on posting, and writes no message (decision 13)', () => {
    const health = wf.jobs.health!;
    expect(health.if).toBe("needs.gate.outputs.member == 'true'");
    expect(health.outputs).toBeUndefined();
    expect(JSON.stringify(health)).not.toMatch(/upload-artifact|message|KANON_CHAT_|needs\.gate\.outputs\.(?:post|hook)/);
  });
});

/**
 * Plan 0011 step N8: the weekly digest moves behind the `notify` job. Its gate decides whether
 * anything will be posted (a hook at `.github/actions/notify/action.yml`, and the kind's secret,
 * `KANON_CHAT_WEEKLY_DIGEST`), before any model runs and outside the job that holds the Claude
 * credential; with nothing to post the `digest` job, whose whole output is the message, doesn't
 * run. The `digest` job writes and uploads the message and holds no chat secret; the `notify`
 * job, of the shape `notify-guard.test.ts` holds, posts it.
 */
describe('the weekly digest posts only through its notify job (plan 0011 N8)', () => {
  const wf = lane(WEEKLY);
  const gate = wf.jobs.gate!;
  const digest = wf.jobs.digest!;
  const decide = step(WEEKLY, 'gate', (s) => s.id === 'post');
  const DIGEST_IF = "needs.gate.outputs.member == 'true' && needs.gate.outputs.narrate == 'true'";

  /** A job's `if:` of `needs.gate.outputs.<x>` comparisons joined by `&&`, against the gate's outputs. */
  const holds = (cond: string | undefined, outputs: Record<string, string>): boolean => {
    const js = String(cond)
      .replace(/needs\.gate\.outputs\.([\w-]+)/g, (_m, k: string) => JSON.stringify(outputs[k] ?? ''))
      .replace(/'([^']*)'/g, (_m, s: string) => JSON.stringify(s))
      .replace(/==/g, '===');
    if (/needs\.|github\.|inputs\.|\w+\s*\(/.test(js)) throw new Error(`unmodelled expression: ${js}`);
    return Boolean(new Function(`return (${js});`)());
  };
  /** The decision step, run in a checkout with or without the hook. */
  const run = (hook: boolean, env: { HAS_SECRET: string; DRY_RUN: string }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'weekly-gate-'));
    if (hook) {
      mkdirSync(join(cwd, '.github/actions/notify'), { recursive: true });
      writeFileSync(join(cwd, '.github/actions/notify/action.yml'), 'name: notify\n');
    }
    return runWorkflowStep(decide, { env, cwd });
  };

  it('decides in the gate job, after the membership gate, from a checkout that runs nothing and one presence boolean', () => {
    expect(gate.outputs).toEqual({
      member: '${{ steps.gate.outputs.member }}',
      hook: '${{ steps.post.outputs.hook }}',
      narrate: '${{ steps.post.outputs.narrate }}',
    });
    const steps = gate.steps!;
    const at = (pred: (s: Step) => boolean) => steps.findIndex(pred);
    const checkout = steps.find((s) => String(s.uses).startsWith('actions/checkout@'))!;
    expect(checkout.with).toEqual({ 'persist-credentials': false, 'sparse-checkout': '.github/actions/notify', 'sparse-checkout-cone-mode': false });
    expect(at((s) => s.id === 'gate')).toBeLessThan(steps.indexOf(checkout));
    expect(steps.indexOf(checkout)).toBeLessThan(at((s) => s.id === 'post'));
    for (const s of [checkout, decide]) expect(s.if).toBe("steps.gate.outputs.member == 'true'");
    expect(decide.env).toEqual({
      HAS_SECRET: "${{ secrets.KANON_CHAT_WEEKLY_DIGEST != '' }}",
      DRY_RUN: "${{ inputs.dry_run == 'true' && '1' || '' }}",
    });
    expect(secretsRead(gate)).toEqual(['KANON_CHAT_WEEKLY_DIGEST']);
  });

  it.each([
    ['a hook and the secret', true, 'true', '', 'present', 'true'],
    ['a hook and no secret', true, 'false', '', 'present', 'false'],
    ['the secret and no hook', false, 'true', '', 'none', 'false'],
    ['neither', false, 'false', '', 'none', 'false'],
    ['a dry run with neither', false, 'false', '1', 'none', 'true'],
  ] as const)('with %s, the gate decides the hook and whether to narrate', (_name, hook, secret, dry, wantHook, wantNarrate) => {
    const r = run(hook, { HAS_SECRET: secret, DRY_RUN: dry });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs).toEqual({ hook: wantHook, narrate: wantNarrate });
    if (wantHook === 'none') expect(r.summary).toContain('No notify hook: nothing was posted');
    else if (secret !== 'true') expect(r.summary).toContain('No chat secret for the weekly digest');
  });

  it('with the secret set and no hook, nothing posts and no model runs (decision 2)', () => {
    const r = run(false, { HAS_SECRET: 'true', DRY_RUN: '' });
    const outputs = { member: 'true', ...r.outputs };
    expect(holds(digest.if, outputs)).toBe(false);
    expect(startsNotify(wf.jobs.notify!.if, ['gate', 'digest'], { member: 'true', hook: r.outputs.hook!, dryRun: '', cancelled: false, gate: 'success', producer: 'skipped' })).toBe(false);
    // A decision that reads the secret alone, as a built-in fallback would, posts (mutation).
    const fallback = { ...decide, run: decide.run!.replace('if [ -f .github/actions/notify/action.yml ]; then', 'if [ "$HAS_SECRET" = true ]; then') };
    expect(runWorkflowStep(fallback, { env: { HAS_SECRET: 'true', DRY_RUN: '' }, cwd: mkdtempSync(join(tmpdir(), 'weekly-gate-')) }).outputs.hook).toBe('present');
  });

  it("runs the digest job, and so the model, only when the gate's decision says so", () => {
    expect(digest.if).toBe(DIGEST_IF);
    expect([digest.needs].flat()).toEqual(['gate']);
    expect(holds(digest.if, { member: 'true', narrate: 'true' })).toBe(true);
    for (const outputs of [{ member: 'true', narrate: 'false' }, { member: 'false', narrate: 'true' }, { member: '', narrate: '' }]) {
      expect(holds(digest.if, outputs), JSON.stringify(outputs)).toBe(false);
    }
    // The `if:` without the hook's decision runs the model for a post nothing makes (mutation).
    expect(holds("needs.gate.outputs.member == 'true'", { member: 'true', narrate: 'false' })).toBe(true);
  });

  it('holds no chat secret in the digest job, and no decision of its own', () => {
    expect(secretsRead(digest).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(digest.steps!.some((s) => s.id === 'post'), "N0's step belongs to the gate").toBe(false);
    expect(JSON.stringify(digest)).not.toMatch(/KANON_CHAT_|DIGEST_WEBHOOK/);
    // The mutation: the decision left in the digest job turns this red.
    const mutated = { ...digest, steps: [decide, ...digest.steps!] };
    expect(secretsRead(mutated)).toContain('KANON_CHAT_WEEKLY_DIGEST');
  });

  it('writes the message, uploads it once under its name, and publishes that name', () => {
    const write = post(WEEKLY);
    expect(write.env).toEqual({
      GITHUB_TOKEN: '${{ github.token }}',
      GITHUB_REPOSITORY: '${{ github.repository }}',
      WEEK_END: '${{ inputs.week_end }}',
      DRY_RUN: "${{ inputs.dry_run == 'true' && '1' || '' }}",
      MESSAGE_PATH: '${{ runner.temp }}/kanon-notify-message/message.json',
    });
    const upload = step(WEEKLY, 'digest', (s) => s.id === 'upload');
    expect(String(upload.uses)).toMatch(/^actions\/upload-artifact@/);
    expect(upload.if).toBe(`steps.${write.id}.outputs.message != ''`);
    expect(upload.with).toMatchObject({ name: 'kanon-notify-weekly-digest-digest-${{ github.run_id }}-${{ github.run_attempt }}', path: `\${{ steps.${write.id}.outputs.message }}` });
    expect(digest.outputs).toEqual({
      'message-artifact': "${{ steps.upload.outputs.artifact-id && format('kanon-notify-weekly-digest-digest-{0}-{1}', github.run_id, github.run_attempt) || '' }}",
    });
    expect(wf.jobs.notify?.steps?.[0]?.with).toMatchObject({ kind: 'weekly-digest', artifact: '${{ needs.digest.outputs.message-artifact }}', secret: '${{ secrets.KANON_CHAT_WEEKLY_DIGEST }}' });
  });

  it('the caller maps KANON_CHAT_WEEKLY_DIGEST, and no DIGEST_WEBHOOK', () => {
    const job = Object.values(caller(WEEKLY).jobs)[0]!;
    expect(job.secrets).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
      KANON_CHAT_WEEKLY_DIGEST: '${{ secrets.KANON_CHAT_WEEKLY_DIGEST }}',
    });
  });
});
