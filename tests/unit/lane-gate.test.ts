import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decide, triggeringActor } from '../../scripts/lane-gate.mjs';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { GH_REGISTER_ARM, IMPLEMENTER_LOGIN, LEAD_LOGIN, REGISTER_FIXTURE } from './helpers/register.js';

/**
 * kanon#46, `K-AGENT-45`: every lane starts real work only on a member's act, and checks it
 * before any App token is minted. Three halves:
 *
 *   1. every lane in Kanon carries the gate, first in its first job, and every later step
 *      and job waits for it (so a lane that moves later without it fails here);
 *   2. for each trigger of each lane, the lane's OWN gate step, executed, refuses a
 *      non-member and a bot outside the App register, and admits a member and a registered
 *      App, with the refusal visible in the step summary;
 *   3. the actor rules themselves, per event.
 */

const WORKFLOWS = join(process.cwd(), '.github/workflows');
type Job = { needs?: string | string[]; if?: string; steps?: WorkflowStep[]; uses?: string };
type Workflow = { on?: { workflow_call?: unknown }; jobs: Record<string, Job> };
const read = (file: string): Workflow => parse(readFileSync(join(WORKFLOWS, file), 'utf8'));

/** A lane is an `agent-*.yml` reusable workflow; the spine, `agent-lane.yml`, is not one. */
const LANES = readdirSync(WORKFLOWS)
  .filter((f) => /^agent-.*\.yml$/.test(f) && f !== 'agent-lane.yml')
  .filter((f) => read(f).on?.workflow_call !== undefined)
  .sort();

/** The triggers each lane's caller holds (docs/lanes.md), as the event the gate sees. */
type Trigger = 'review' | 'issue-label' | 'pr-label' | 'merged' | 'dispatch' | 'ci-finished' | 'pr-target-label' | 'pr-target-opened' | 'schedule';
const TRIGGERS: Record<string, Trigger[]> = {
  'agent-implement-revise.yml': ['review', 'pr-label', 'dispatch'],
  'agent-implement.yml': ['issue-label', 'dispatch'],
  'agent-lead-revise.yml': ['review', 'pr-label', 'dispatch'],
  'agent-lead-split.yml': ['issue-label', 'dispatch'],
  'agent-lead.yml': ['dispatch'],
  'agent-merge-reconcile.yml': ['merged', 'review', 'dispatch'],
  'agent-rebase.yml': ['ci-finished', 'schedule', 'dispatch'],
  'agent-review.yml': ['ci-finished', 'pr-target-label', 'pr-target-opened', 'dispatch'],
  'agent-triage.yml': ['issue-label', 'dispatch'],
  'agent-verify-acs.yml': ['issue-label', 'dispatch'],
};

/** The job holding the gate step, and the step's index in it. */
const gateOf = (wf: Workflow): { jobId: string; index: number } | undefined => {
  for (const [jobId, job] of Object.entries(wf.jobs)) {
    const index = (job.steps ?? []).findIndex((s) => s.id === 'gate');
    if (index >= 0) return { jobId, index };
  }
  return undefined;
};

const needsOf = (job: Job): string[] => [job.needs ?? []].flat();

/** Every way the gate can be missing or bypassed, for one lane: empty when it is sound. */
const gateProblems = (wf: Workflow): string[] => {
  const problems: string[] = [];
  const gate = gateOf(wf);
  if (!gate) return ['no step with `id: gate`'];
  const job = wf.jobs[gate.jobId]!;
  const steps = job.steps ?? [];
  const step = steps[gate.index]!;
  if (!/^node "\$KANON\/scripts\/lane-gate\.mjs"\s*$/.test(step.run ?? '')) problems.push('the gate step does not run scripts/lane-gate.mjs');
  if (step.if) problems.push('the gate step is itself conditional');
  if (step.env?.GH_TOKEN !== '${{ github.token }}') problems.push('the gate step does not read with the workflow token');
  const before = steps.slice(0, gate.index);
  if (before.length !== 1 || before[0]!.uses !== '$/actions/kanon-path') problems.push('something other than kanon-path runs before the gate');
  if (needsOf(job).length) problems.push(`the gate's job ${gate.jobId} waits for another job`);

  // Every later step in the gate's job is skipped on a refusal: it reads the gate's
  // output, or the output of a step that does.
  const gated = new Set(['gate']);
  for (const s of steps.slice(gate.index + 1)) {
    const reads = [...String(s.if ?? '').matchAll(/steps\.([\w-]+)\.outputs\./g)].map((m) => m[1]!);
    if (!reads.some((id) => gated.has(id))) problems.push(`step "${s.name ?? s.uses}" runs whether or not the gate admitted`);
    else if (s.id) gated.add(s.id);
  }

  // Every other job waits for a gated job and reads its result or outputs in its `if`.
  const gatedJobs = new Set([gate.jobId]);
  let changed = true;
  const rest = Object.entries(wf.jobs).filter(([id]) => id !== gate.jobId);
  while (changed) {
    changed = false;
    for (const [id, j] of rest) {
      if (gatedJobs.has(id)) continue;
      const reads = [...String(j.if ?? '').matchAll(/needs\.([\w-]+)\.(?:outputs|result)\b/g)].map((m) => m[1]!);
      if (reads.some((r) => gatedJobs.has(r) && needsOf(j).includes(r))) {
        gatedJobs.add(id);
        changed = true;
      }
    }
  }
  for (const [id] of rest) if (!gatedJobs.has(id)) problems.push(`job ${id} can run without the gate admitting`);

  // A refusal leaves every output of the gate's job EMPTY, and an empty output passes any
  // `!=` test: `needs.filter.outputs.prs != '[]'` is true on a refused event. So a job that
  // tests one of that job's outputs with `!=` must also require the verdict itself.
  for (const [id, j] of rest) {
    const cond = String(j.if ?? '');
    const negated = new RegExp(`needs\\.${gate.jobId}\\.outputs\\.[\\w-]+\\s*!=`).test(cond);
    const verdict = new RegExp(`needs\\.${gate.jobId}\\.outputs\\.member\\s*==\\s*'true'\\s*&&`).test(cond);
    if (negated && !verdict) problems.push(`job ${id} tests an output of ${gate.jobId} with != without requiring its member verdict first`);
  }
  return problems;
};

describe('every lane carries the membership gate (K-AGENT-45)', () => {
  it('finds the lanes, and knows each one’s triggers', () => {
    expect(LANES.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(TRIGGERS).sort(), 'a lane added to Kanon needs its triggers listed here').toEqual(LANES);
  });

  it.each(LANES)('%s: the gate is first, and nothing runs past a refusal', (file) => {
    expect(gateProblems(read(file))).toEqual([]);
  });

  describe('the check fails a lane that lacks it, or lets something past it', () => {
    const lane = (file: string) => structuredClone(read(file));
    it('no gate step', () => {
      const wf = lane('agent-implement-revise.yml');
      wf.jobs.filter!.steps = wf.jobs.filter!.steps!.filter((s) => s.id !== 'gate');
      expect(gateProblems(wf)).toEqual(['no step with `id: gate`']);
    });
    it('a later step not gated', () => {
      const wf = lane('agent-lead-revise.yml');
      delete wf.jobs.filter!.steps!.find((s) => s.id === 'filter')!.if;
      expect(gateProblems(wf).join()).toContain('"Should this review be acted on?" runs whether or not');
    });
    it('a token minted before the gate', () => {
      const wf = lane('agent-merge-reconcile.yml');
      wf.jobs.filter!.steps!.unshift({ name: 'Mint', uses: 'actions/create-github-app-token@v3' });
      expect(gateProblems(wf)).toContain('something other than kanon-path runs before the gate');
    });
    it('an agent job that does not wait for the gate', () => {
      const wf = lane('agent-triage.yml');
      wf.jobs['triage-fix']!.if = "github.event.label.name == 'qa:needs-triage'";
      expect(gateProblems(wf)).toEqual(['job triage-fix can run without the gate admitting']);
    });
    it('a job that reads an empty, refused output as a value', () => {
      // The rebase lane's matrix job: `'' != '[]'` is true when the gate refused.
      const wf = lane('agent-rebase.yml');
      wf.jobs.resolve!.if = "needs.filter.outputs.prs != '[]'";
      expect(gateProblems(wf)).toEqual(['job resolve tests an output of filter with != without requiring its member verdict first']);
    });
    it('a job reading a gated job it does not need', () => {
      const wf = lane('agent-implement.yml');
      wf.jobs.implement!.needs = [];
      expect(gateProblems(wf)).toContain('job implement can run without the gate admitting');
    });
  });
});

// ── The gate step of each lane, executed ────────────────────────────────────────────────

const REPO = 'example-org/example-repo';
/** The permission lookup's answers, by login, in the API's own shape. */
const PERMS: Record<string, { role_name: string; permissions: Record<string, boolean> }> = {
  'a-member': { role_name: 'write', permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } },
  'a-triager': { role_name: 'triage', permissions: { admin: false, maintain: false, push: false, triage: true, pull: true } },
  // What the endpoint answers for ANY user on a public repository.
  'a-stranger': { role_name: 'read', permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } },
};

const GH_STUB = `#!/usr/bin/env bash
${GH_REGISTER_ARM}
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" =~ /collaborators/([^/]+)/permission$ ]]; then
  [ -z "\${STUB_PERMISSION_FAILS:-}" ] || { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }
  login="$(printf '%b' "\${BASH_REMATCH[1]//%/\\\\x}")"
  entry="$(printf '%s' "$STUB_PERMS" | jq -c --arg l "$login" '.[$l] // {role_name: "", permissions: {admin: false, maintain: false, push: false, triage: false, pull: false}}')"
  payload="$(printf '%s' "$entry" | jq -c --arg l "$login" '{permission: "none", role_name, user: {login: $l, permissions}}')"
  expr=""; while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && expr="$2"; shift; done
  if [ -n "$expr" ]; then printf '%s' "$payload" | jq -c "$expr"; else printf '%s' "$payload"; fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 3
`;

type Actor = { login: string; association?: string };
const eventFor = (trigger: Trigger, actor: Actor): { name: string; payload: object; env: Record<string, string> } => {
  const user = { login: actor.login };
  switch (trigger) {
    case 'review':
      return { name: 'pull_request_review', payload: { action: 'submitted', review: { state: 'changes_requested', user, author_association: actor.association ?? 'NONE' } }, env: {} };
    case 'issue-label':
      return { name: 'issues', payload: { action: 'labeled', sender: user }, env: {} };
    case 'pr-label':
      return { name: 'pull_request', payload: { action: 'labeled', sender: user }, env: {} };
    case 'merged':
      return { name: 'pull_request', payload: { action: 'closed', pull_request: { merged: true, merged_by: user }, sender: { login: 'someone-else' } }, env: {} };
    case 'dispatch':
      return { name: 'workflow_dispatch', payload: {}, env: { GITHUB_ACTOR: 'someone-else', GITHUB_TRIGGERING_ACTOR: actor.login } };
    case 'ci-finished':
      return { name: 'workflow_run', payload: { action: 'completed', workflow_run: { triggering_actor: user, actor: { login: 'someone-else' } }, sender: { login: 'someone-else' } }, env: {} };
    case 'pr-target-label':
      return { name: 'pull_request_target', payload: { action: 'labeled', sender: user }, env: {} };
    case 'pr-target-opened':
      return { name: 'pull_request_target', payload: { action: 'opened', sender: user }, env: {} };
    case 'schedule':
      return { name: 'schedule', payload: { schedule: '50 5 * * *' }, env: { GITHUB_ACTOR: actor.login } };
  }
};

const runGate = (file: string, trigger: Trigger, actor: Actor, extra: Record<string, string> = {}) => {
  const wf = read(file);
  const { jobId, index } = gateOf(wf)!;
  const step = wf.jobs[jobId]!.steps![index]!;
  const dir = mkdtempSync(join(tmpdir(), 'lane-gate-'));
  writeStub(join(dir, 'gh'), GH_STUB);
  const ev = eventFor(trigger, actor);
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(ev.payload));
  return runWorkflowStep(step, {
    dir,
    env: {
      ...step.env,
      GH_TOKEN: 'unused',
      KANON: process.cwd(),
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: REPO,
      GITHUB_EVENT_NAME: ev.name,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_ACTOR: '',
      GITHUB_TRIGGERING_ACTOR: '',
      ...ev.env,
      STUB_REGISTER: REGISTER_FIXTURE,
      STUB_PERMS: JSON.stringify(PERMS),
      ...extra,
    },
  });
};

/** A member for this trigger: by association on a review, by permission otherwise. */
const MEMBER: Actor = { login: 'a-member', association: 'COLLABORATOR' };
const STRANGER: Actor = { login: 'a-stranger', association: 'NONE' };

const CASES = LANES.flatMap((file) => (TRIGGERS[file] ?? []).map((trigger) => [file, trigger] as const));

describe.each(CASES)('%s on a %s', (file, trigger) => {
  it('refuses a non-member, visibly', () => {
    const r = runGate(file, trigger, STRANGER);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('Membership gate: refused.');
    expect(r.summary).toContain('a-stranger');
    expect(r.output).toContain('::notice title=Membership gate::');
  });
  it('admits a member', () => {
    const r = runGate(file, trigger, MEMBER);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.summary).toContain('a-member');
  });
  it('admits a registered agent App', () => {
    const r = runGate(file, trigger, { login: `${LEAD_LOGIN}[bot]`, association: 'NONE' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('true');
    expect(r.summary).toContain("the repository's Lead App");
  });
  it('refuses a bot outside the App register', () => {
    // Even one the permission lookup would pass: a bot is judged by the register alone.
    const r = runGate(file, trigger, { login: 'dependabot[bot]', association: 'COLLABORATOR' }, {
      STUB_PERMS: JSON.stringify({ 'dependabot[bot]': PERMS['a-member'] }),
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('dependabot[bot]');
    expect(r.summary).toContain('not in the App register');
  });
});

describe('the gate step’s failure paths', () => {
  const file = 'agent-implement-revise.yml';
  it('fails the job, by name, when the permission lookup fails, rather than guessing', () => {
    const r = runGate(file, 'pr-label', MEMBER, { STUB_PERMISSION_FAILS: '1' });
    expect(r.status).toBe(1);
    expect(r.output).toContain("::error title=Membership gate::could not read a-member's permission");
    expect(r.outputs.member).toBeUndefined();
  });
  it('refuses a bot when the default branch has no App register', () => {
    const r = runGate(file, 'review', { login: `${IMPLEMENTER_LOGIN}[bot]` }, { STUB_REGISTER: '' });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
  });
  it('fails the job when the App register is malformed', () => {
    const r = runGate(file, 'review', { login: `${IMPLEMENTER_LOGIN}[bot]` }, { STUB_REGISTER: '# no table\n' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('::error title=Membership gate::');
  });
  it('refuses, visibly, an event no lane acts on', () => {
    const wf = read(file);
    const { jobId, index } = gateOf(wf)!;
    const r = runWorkflowStep(wf.jobs[jobId]!.steps![index]!, {
      env: { KANON: process.cwd(), GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '' },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.member).toBe('false');
    expect(r.summary).toContain('no lane acts on a push event');
  });
  it('admits a triager, who can apply a label, and does not read a public repository’s `read` as membership', () => {
    expect(runGate(file, 'pr-label', { login: 'a-triager' }).outputs.member).toBe('true');
    expect(runGate(file, 'pr-label', { login: 'a-stranger' }).outputs.member).toBe('false');
  });
});

// ── The actor rules ─────────────────────────────────────────────────────────────────────

describe('who the actor is', () => {
  const env = { GITHUB_ACTOR: 'the-actor', GITHUB_TRIGGERING_ACTOR: 'the-rerunner' };
  it('a review: the reviewer and their association, never the PR author or sender', () => {
    expect(triggeringActor('pull_request_review', {
      sender: { login: 'sender' }, review: { user: { login: 'reviewer' }, author_association: 'NONE' },
    }, env)).toEqual({ actor: { login: 'reviewer', association: 'NONE', source: 'reviewer' } });
  });
  it('a label: whoever applied it, with no association to trust', () => {
    expect(triggeringActor('issues', { action: 'labeled', sender: { login: 'labeller' } }, env))
      .toEqual({ actor: { login: 'labeller', source: 'user who applied the label' } });
  });
  it('a pull_request_target label or opening: the sender, as for pull_request', () => {
    expect(triggeringActor('pull_request_target', { action: 'labeled', sender: { login: 'labeller' } }, env))
      .toEqual({ actor: { login: 'labeller', source: 'user who applied the label' } });
    expect(triggeringActor('pull_request_target', { action: 'opened', sender: { login: 'opener' } }, env))
      .toEqual({ actor: { login: 'opener', source: 'user who opened it' } });
    expect(triggeringActor('issues', { action: 'opened', sender: { login: 'opener' } }, env)).toHaveProperty('refuse');
  });
  it('a finished workflow: whoever pushed the commit it ran on, never the sender', () => {
    expect(triggeringActor('workflow_run', { workflow_run: { triggering_actor: { login: 'pusher' }, actor: { login: 'a' } }, sender: { login: 's' } }, env))
      .toEqual({ actor: { login: 'pusher', source: 'user whose push the finished workflow ran on' } });
    expect(triggeringActor('workflow_run', { workflow_run: { actor: { login: 'a' } } }, env))
      .toEqual({ actor: { login: 'a', source: 'user whose push the finished workflow ran on' } });
  });
  it('a merge: whoever merged it', () => {
    expect(triggeringActor('pull_request', { action: 'closed', pull_request: { merged_by: { login: 'merger' } }, sender: { login: 'x' } }, env))
      .toEqual({ actor: { login: 'merger', source: 'user who merged it' } });
  });
  it('a dispatch: whoever ran it, re-runs included', () => {
    expect(triggeringActor('workflow_dispatch', {}, env)).toEqual({ actor: { login: 'the-rerunner', source: 'user who ran it' } });
    expect(triggeringActor('workflow_dispatch', {}, { GITHUB_ACTOR: 'the-actor' })).toEqual({ actor: { login: 'the-actor', source: 'user who ran it' } });
  });
  it('a schedule: the user GitHub runs it as, whoever last changed it', () => {
    expect(triggeringActor('schedule', { schedule: '50 5 * * *' }, env)).toEqual({ actor: { login: 'the-actor', source: 'user who last changed the schedule' } });
    expect(triggeringActor('schedule', {}, {})).toHaveProperty('refuse');
  });
  it('anything else is refused, as is an event with no actor', () => {
    for (const name of ['push', 'merge_group', 'workflow_run', 'issue_comment', '']) expect(triggeringActor(name, {}, env)).toHaveProperty('refuse');
    expect(triggeringActor('pull_request', { action: 'synchronize', sender: { login: 'a' } }, env)).toHaveProperty('refuse');
    expect(triggeringActor('pull_request_review', { review: {} }, env)).toHaveProperty('refuse');
  });
});

describe('what a member is', () => {
  const register = () => new Map([['Lead', 'example-lead']]);
  const noLookup = () => {
    throw new Error('looked up a permission it did not need');
  };
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('association %s is a member', (association) => {
    expect(decide({ login: 'u', association, source: 'reviewer' }, { registeredApps: noLookup, permissionOf: noLookup }).member).toBe(true);
  });
  it.each(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', ''])('association %s is not', (association) => {
    expect(decide({ login: 'u', association, source: 'reviewer' }, { registeredApps: noLookup, permissionOf: noLookup }).member).toBe(false);
  });
  it('a bot is judged by the register alone', () => {
    expect(decide({ login: 'example-lead[bot]', association: 'NONE', source: 'reviewer' }, { registeredApps: register, permissionOf: noLookup }).member).toBe(true);
    expect(decide({ login: 'example-leader[bot]', association: 'MEMBER', source: 'reviewer' }, { registeredApps: register, permissionOf: noLookup }).member).toBe(false);
    // The slug, not the bare login: a user named like an App is not the App.
    expect(decide({ login: 'example-lead', association: 'NONE', source: 'reviewer' }, { registeredApps: register, permissionOf: noLookup }).member).toBe(false);
  });
  it('a lookup admits triage or more, and nothing less', () => {
    const lookup = (permissions: Record<string, boolean>) => () => ({ permissions, role_name: 'custom' });
    for (const p of ['admin', 'maintain', 'push', 'triage']) {
      expect(decide({ login: 'u', source: 's' }, { registeredApps: noLookup, permissionOf: lookup({ [p]: true }) }).member).toBe(true);
    }
    expect(decide({ login: 'u', source: 's' }, { registeredApps: noLookup, permissionOf: lookup({ pull: true }) }).member).toBe(false);
    expect(decide({ login: 'u', source: 's' }, { registeredApps: noLookup, permissionOf: () => ({}) }).member).toBe(false);
  });
});
