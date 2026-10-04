import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type WorkflowStep } from './helpers/workflow-step.js';

/**
 * The two digests (plan 0004 step 10), moved from the reference adopter: the daily project
 * digest with its health job, and the weekly digest. What their scripts decide is tested in
 * `tests/library/` (project-digest, weekly-digest, workflow-health, digest-webhook); this file
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

const step = (file: string, job: string, pred: (s: Step) => boolean): Step => {
  const s = (lane(file).jobs[job]?.steps ?? []).find(pred);
  if (!s) throw new Error(`no such step in ${file}:${job}`);
  return s;
};
const narrative = (file: string) => step(file, 'digest', (s) => s.id === 'agent');
const post = (file: string) => step(file, 'digest', (s) => s.name === 'Post the digest');
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

  it.each(DIGESTS)('%s: every other job waits for the gate and its verdict', (file) => {
    for (const [id, job] of Object.entries(lane(file).jobs)) {
      if (id === 'gate') continue;
      expect([job.needs].flat(), `${file}:${id}`).toEqual(['gate']);
      expect(job.if, `${file}:${id}`).toBe("needs.gate.outputs.member == 'true'");
    }
    expect(lane(file).jobs.gate?.outputs?.member).toBe('${{ steps.gate.outputs.member }}');
  });

  it.each(DIGESTS)('%s: takes the Claude token, and the webhook optionally, and no App', (file) => {
    const secrets = lane(file).on.workflow_call.secrets;
    expect(Object.keys(secrets).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'DIGEST_WEBHOOK']);
    expect(secrets.CLAUDE_CODE_OAUTH_TOKEN?.required).toBe(true);
    // Without the webhook the digest posts nothing and stays green (plan 0004 §6).
    expect(secrets.DIGEST_WEBHOOK?.required).toBe(false);
    expect(text(`.github/workflows/${file}`)).not.toMatch(/create-github-app-token|_APP_ID/);
  });

  it.each(DIGESTS)('%s: takes its inputs as optional strings, passed through by the caller', (file) => {
    for (const [name, input] of Object.entries(lane(file).on.workflow_call.inputs)) {
      expect(input, `${file}: ${name}`).toMatchObject({ type: 'string', required: false });
    }
    const job = Object.values(caller(file).jobs)[0]!;
    expect(job.with).toEqual(Object.fromEntries(Object.keys(lane(file).on.workflow_call.inputs).map((k) => [k, `\${{ inputs.${k} }}`])));
  });

  it('keeps `dry_run` on both and `week_end` on the weekly one', () => {
    expect(Object.keys(lane(PROJECT).on.workflow_call.inputs)).toEqual(['dry_run']);
    expect(Object.keys(lane(WEEKLY).on.workflow_call.inputs)).toEqual(['week_end', 'dry_run']);
    expect(post(WEEKLY).env?.WEEK_END).toBe('${{ inputs.week_end }}');
  });

  it.each(DIGESTS)('%s: holds its own concurrency group, never cancelling a post in flight', (file) => {
    expect(lane(file).concurrency).toEqual({ group: expect.stringMatching(/^kanon-.*digest$/), 'cancel-in-progress': false });
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

describe('the webhook is the caller’s DIGEST_WEBHOOK (plan 0004, decision 7)', () => {
  it.each(DIGESTS)('%s: the post step passes it under its own name, and nothing else of the kind', (file) => {
    expect(post(file).env?.DIGEST_WEBHOOK).toBe('${{ secrets.DIGEST_WEBHOOK }}');
    expect(text(`.github/workflows/${file}`)).not.toMatch(/SLACK_[A-Z_]*WEBHOOK/);
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
    expect(prompt).toMatch(/stakeholder who follows the project from outside the\s+day-to-day work/);
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
