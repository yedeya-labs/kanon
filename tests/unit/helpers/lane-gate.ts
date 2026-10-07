import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { runWorkflowStep, type WorkflowStep } from './workflow-step.js';
import { writeStub } from './stub-bin.js';
import { runsUnadmitted } from './job-condition.js';
import { GH_REGISTER_ARM, REGISTER_FIXTURE } from './register.js';


/**
 * The lanes, their triggers, the gate-step runner and its `gh` stub that the lane-gate tests
 * share (tests/unit/lane-gate*.test.ts, split by area in kanon#381).
 */
export const WORKFLOWS = join(process.cwd(), '.github/workflows');
export type Job = { needs?: string | string[]; if?: string; steps?: WorkflowStep[]; uses?: string };
export type Workflow = { on?: { workflow_call?: unknown }; jobs: Record<string, Job> };
export const read = (file: string): Workflow => parse(readFileSync(join(WORKFLOWS, file), 'utf8'));

/** A lane is an `agent-*.yml` reusable workflow; the spine, `agent-lane.yml`, is not one. */
export const LANES = readdirSync(WORKFLOWS)
  .filter((f) => /^agent-.*\.yml$/.test(f) && f !== 'agent-lane.yml')
  .filter((f) => read(f).on?.workflow_call !== undefined)
  .sort();

/** The triggers each lane's caller holds (docs/lanes.md), as the event the gate sees. */
export type Trigger = 'review' | 'issue-label' | 'pr-label' | 'merged' | 'issue-closed' | 'dispatch' | 'ci-finished' | 'pr-target-label' | 'pr-target-opened' | 'pr-target-merged' | 'schedule';
export const TRIGGERS: Record<string, Trigger[]> = {
  'agent-implement-revise.yml': ['review', 'pr-label', 'dispatch'],
  'agent-implement.yml': ['issue-label', 'dispatch'],
  'agent-lead-revise.yml': ['review', 'pr-label', 'dispatch'],
  'agent-lead-reconcile.yml': ['dispatch', 'merged', 'issue-closed', 'schedule'],
  'agent-lead-split.yml': ['issue-label', 'dispatch'],
  'agent-lead.yml': ['dispatch'],
  'agent-merge-reconcile.yml': ['merged', 'review', 'dispatch'],
  'agent-merge.yml': ['review', 'ci-finished', 'schedule', 'dispatch'],
  'agent-rebase.yml': ['ci-finished', 'schedule', 'dispatch'],
  'agent-review.yml': ['ci-finished', 'pr-target-label', 'pr-target-opened', 'dispatch'],
  'agent-triage.yml': ['issue-label', 'dispatch'],
  'agent-verify-acs.yml': ['issue-label', 'dispatch'],
  'agent-project-digest.yml': ['schedule', 'dispatch'],
  'agent-weekly-digest.yml': ['schedule', 'dispatch'],
  'agent-explore.yml': ['schedule', 'dispatch'],
  'agent-dispatch-sweep.yml': ['schedule', 'dispatch'],
  'agent-code-audit.yml': ['schedule', 'dispatch'],
  'agent-explore-telemetry.yml': ['schedule', 'dispatch'],
  // The runtime-version trigger (kanon#423): a merged pull request, judged by who merged it.
  'agent-overseer.yml': ['schedule', 'dispatch', 'pr-target-merged'],
};

/** The job holding the gate step, and the step's index in it. */
export const gateOf = (wf: Workflow): { jobId: string; index: number } | undefined => {
  for (const [jobId, job] of Object.entries(wf.jobs)) {
    const index = (job.steps ?? []).findIndex((s) => s.id === 'gate');
    if (index >= 0) return { jobId, index };
  }
  return undefined;
};

export const needsOf = (job: Job): string[] => [job.needs ?? []].flat();

/**
 * The lane's gates: the first job's `id: gate` step, and any later job's step that runs the
 * membership gate itself (another lane's step may be called `gate` for a gate of its own, as
 * the split lane's lineage gate is).
 */
export const gatesOf = (wf: Workflow): { jobId: string; index: number }[] => {
  const first = gateOf(wf);
  if (!first) return [];
  return [first, ...Object.entries(wf.jobs).filter(([jobId]) => jobId !== first.jobId).flatMap(([jobId, job]) => {
    const index = (job.steps ?? []).findIndex((s) => s.id === 'gate' && /scripts\/lane-gate\.mjs/.test(s.run ?? ''));
    return index >= 0 ? [{ jobId, index }] : [];
  })];
};

/**
 * Every way the gate can be missing or bypassed, for one lane: empty when it is sound.
 *
 * A lane has one gate, first in its first job, or — when its triggers start different jobs
 * (the Merger's review path starts `logins`, its sweep starts `merge` alone, plan 0004 step 7)
 * — one first in each job that can start without another gated job's verdict. Either way:
 * every gate is the gate step, unconditional, after `kanon-path` alone; every later step in a
 * gate's job skips on a refusal; and every job without a gate waits for a gated job, reads
 * its verdict in its `if:`, and cannot start unless a gate admitted (kanon#209).
 */
export const gateProblems = (wf: Workflow): string[] => {
  const problems: string[] = [];
  const gates = gatesOf(wf);
  if (!gates.length) return ['no step with `id: gate`'];
  const gateJobs = new Set(gates.map((g) => g.jobId));
  for (const gate of gates) {
    const job = wf.jobs[gate.jobId]!;
    const steps = job.steps ?? [];
    const step = steps[gate.index]!;
    if (!/^node "\$KANON\/scripts\/lane-gate\.mjs"\s*$/.test(step.run ?? '')) problems.push('the gate step does not run scripts/lane-gate.mjs');
    if (step.if) problems.push('the gate step is itself conditional');
    if (step.env?.GH_TOKEN !== '${{ github.token }}') problems.push('the gate step does not read with the workflow token');
    const before = steps.slice(0, gate.index);
    if (before.length !== 1 || before[0]!.uses !== '$/actions/kanon-path') problems.push('something other than kanon-path runs before the gate');
    // A gate's job may wait only for another gate's job: anything else would run first.
    const waits = needsOf(job).filter((n) => !gateJobs.has(n));
    if (waits.length) problems.push(`the gate's job ${gate.jobId} waits for another job`);

    // Every later step in the gate's job is skipped on a refusal: it reads the gate's
    // output, or the output of a step that does.
    const gated = new Set(['gate']);
    for (const s of steps.slice(gate.index + 1)) {
      const reads = [...String(s.if ?? '').matchAll(/steps\.([\w-]+)\.outputs\./g)].map((m) => m[1]!);
      if (!reads.some((id) => gated.has(id))) problems.push(`step "${s.name ?? s.uses}" runs whether or not the gate admitted`);
      else if (s.id) gated.add(s.id);
    }
  }

  // Every job without a gate waits for a gated job and reads its result or outputs in its `if`.
  const gatedJobs = new Set(gateJobs);
  let changed = true;
  const rest = Object.entries(wf.jobs).filter(([id]) => !gateJobs.has(id));
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
  // THE EXPORT'S DELETE JOB IS THE ONE EXCEPTION (plan 0004 §3.2): it runs `if: always()`,
  // which `tests/unit/helpers/store-jobs.ts` requires, so it also runs after a refusal. It is
  // inert there: its one step deletes the artifact a gated job names (the export, or the
  // Overseer's report), and a refused run uploaded nothing, so it is handed no id and deletes
  // nothing.
  const inertDelete = (j: Job) => {
    const steps = j.steps ?? [];
    const w = (steps[0] as { with?: Record<string, unknown> } | undefined)?.with ?? {};
    const from = /^\$\{\{\s*needs\.([\w-]+)\.outputs\.(?:[\w-]+-)?artifact-id\s*\}\}$/.exec(String(w['artifact-id'] ?? ''))?.[1];
    return steps.length === 1 && steps[0]!.uses === '$/actions/qa-store' && w.operation === 'delete-export'
      && from !== undefined && gatedJobs.has(from) && needsOf(j).includes(from);
  };
  for (const [id, j] of rest) if (!gatedJobs.has(id) && !inertDelete(j)) problems.push(`job ${id} can run without the gate admitting`);

  // And its `if:` cannot hold unless a gate admitted (kanon#209). Reading a verdict is not
  // requiring one: `needs.logins.outputs.member == 'true' || github.event_name == 'schedule'`
  // reads it and still runs on every schedule. So each condition is EVALUATED over every world
  // in which no gate admitted (`helpers/job-condition.ts`): a gate's job concluded success with
  // `member` refused or empty, or was skipped, or failed, and every job behind it was skipped.
  // That covers a status function letting a job start with the gate's job skipped (the Merger's
  // sweep starts `merge` with `logins` skipped, so `merge` holds a gate of its own, plan 0004
  // step 7), and an empty output passing a `!=` test (`needs.filter.outputs.prs != '[]'` is
  // true on a refused event).
  const ancestorsOf = (id: string, seen = new Set<string>()): string[] => {
    for (const n of needsOf(wf.jobs[id] ?? {})) if (!seen.has(n)) { seen.add(n); ancestorsOf(n, seen); }
    return [...seen];
  };
  const held = new Set<string>();
  const pending = rest.filter(([id]) => gatedJobs.has(id));
  while (pending.length) {
    const next = pending.findIndex(([, j]) => needsOf(j).every((n) => gateJobs.has(n) || held.has(n) || !pending.some(([p]) => p === n)));
    if (next < 0) throw new Error('a cycle in the lane\'s needs');
    const [[id, j]] = pending.splice(next, 1) as [[string, Job]];
    const world = runsUnadmitted(j.if, j.needs, ancestorsOf(id), gateJobs, held);
    if (world === null) held.add(id);
    else problems.push(`job ${id} runs with no gate admitting, when ${world}`);
  }
  return problems;
};

// ── The gate step of each lane, executed ────────────────────────────────────────────────

export const REPO = 'example-org/example-repo';
/** The permission lookup's answers, by login, in the API's own shape. */
export const PERMS: Record<string, { role_name: string; permissions: Record<string, boolean> }> = {
  'a-member': { role_name: 'write', permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } },
  'a-triager': { role_name: 'triage', permissions: { admin: false, maintain: false, push: false, triage: true, pull: true } },
  // What the endpoint answers for ANY user on a public repository.
  'a-stranger': { role_name: 'read', permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } },
};

export const GH_STUB = `#!/usr/bin/env bash
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
# kanon#81: the review lane's CI completion asks who applied the review label.
if [ "\${1:-}" = "api" ] && [[ "$*" == *"/commits/"*"/pulls"* ]]; then
  [ -z "\${STUB_PULLS_FAILS:-}" ] || { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }
  printf '%s' "\${STUB_PULLS:-[]}"; exit 0
fi
if [ "\${1:-}" = "api" ] && [[ "$*" == *"/issues/"*"/events"* ]]; then
  printf '%s' "\${STUB_EVENTS:-[[]]}"; exit 0
fi
# kanon#69: the caller, at the branch's commit (STUB_CALLER_BRANCH) and at main (STUB_CALLER_MAIN).
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == */contents/.github/workflows/*"?ref="* ]]; then
  printf '%s\n' "$2" >> "\${STUB_CALLS:-/dev/null}"
  [ -z "\${STUB_CALLER_FAILS:-}" ] || { echo "HTTP 500: Server Error" >&2; exit 1; }
  # kanon#118: a local wrapper the caller calls, at the branch's commit and at main.
  case "\${2##*/workflows/}" in
    lanes.yml?ref=main) body="\${STUB_WRAPPER_MAIN:-}" ;;
    lanes.yml?*)        body="\${STUB_WRAPPER_BRANCH:-}" ;;
    *?ref=main)         body="\${STUB_CALLER_MAIN:-}" ;;
    *)                   body="\${STUB_CALLER_BRANCH:-}" ;;
  esac
  [ -n "$body" ] || { echo "HTTP 404: Not Found" >&2; exit 1; }
  printf '%s\n' "$body"; exit 0
fi
echo "unexpected gh call: $*" >&2
exit 3
`;

export type Actor = { login: string; association?: string };
export const CI_SHA = 'c'.repeat(40);
/** The open PR whose head CI ran on, carrying `labels`, as `commits/<sha>/pulls` answers. */
export const pullsWith = (labels: string[], state = 'open') =>
  JSON.stringify([{ number: 7, state, head: { sha: CI_SHA }, labels: labels.map((name) => ({ name })) }]);
/** The PR's issue events, slurped into pages as `gh api --paginate --slurp` prints them. */
export const eventsOf = (...events: [string, string, string?][]) =>
  JSON.stringify([events.map(([actor, label, kind = 'labeled']) => ({ event: kind, label: { name: label }, actor: { login: actor } }))]);
export const eventFor = (trigger: Trigger, actor: Actor): { name: string; payload: object; env: Record<string, string> } => {
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
    case 'issue-closed':
      return { name: 'issues', payload: { action: 'closed', issue: { number: 7, state: 'closed' }, sender: user }, env: {} };
    case 'dispatch':
      return { name: 'workflow_dispatch', payload: {}, env: { GITHUB_ACTOR: 'someone-else', GITHUB_TRIGGERING_ACTOR: actor.login } };
    case 'ci-finished':
      return { name: 'workflow_run', payload: { action: 'completed', workflow_run: { head_sha: CI_SHA, triggering_actor: user, actor: { login: 'someone-else' } }, sender: { login: 'someone-else' } }, env: {} };
    case 'pr-target-label':
      return { name: 'pull_request_target', payload: { action: 'labeled', sender: user }, env: {} };
    case 'pr-target-opened':
      return { name: 'pull_request_target', payload: { action: 'opened', sender: user }, env: {} };
    case 'pr-target-merged':
      return { name: 'pull_request_target', payload: { action: 'closed', pull_request: { merged: true, merged_by: user }, sender: { login: 'someone-else' } }, env: {} };
    case 'schedule':
      return { name: 'schedule', payload: { schedule: '50 5 * * *' }, env: { GITHUB_ACTOR: actor.login } };
  }
};

export const runGate = (file: string, trigger: Trigger, actor: Actor, extra: Record<string, string> = {}, payload: object = {}) => {
  const wf = read(file);
  const { jobId, index } = gateOf(wf)!;
  const step = wf.jobs[jobId]!.steps![index]!;
  const dir = mkdtempSync(join(tmpdir(), 'lane-gate-'));
  writeStub(join(dir, 'gh'), GH_STUB);
  const ev = eventFor(trigger, actor);
  const eventPath = join(dir, 'event.json');
  // Every real payload names the repository's default branch; a test drops it by overriding.
  writeFileSync(eventPath, JSON.stringify({ ...ev.payload, repository: { default_branch: 'main' }, ...payload }));
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
      // The runner always names the caller; here it ran from the default branch, so the pin
      // check (kanon#69) takes its real default-branch path. Set here, never inherited: on a
      // runner `process.env` names CI's own workflow, in another repository.
      GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/caller.yml@refs/heads/main`,
      GITHUB_WORKFLOW_SHA: 'e'.repeat(40),
      ...ev.env,
      STUB_REGISTER: REGISTER_FIXTURE,
      STUB_PERMS: JSON.stringify(PERMS),
      // On the review lane's CI completion the actor is the review label's applier
      // (kanon#81), so the generic cases have the actor apply it.
      STUB_PULLS: pullsWith(['review:please']),
      STUB_EVENTS: eventsOf([actor.login, 'review:please']),
      ...extra,
    },
  });
};

/** A member for this trigger: by association on a review, by permission otherwise. */
export const MEMBER: Actor = { login: 'a-member', association: 'COLLABORATOR' };
export const STRANGER: Actor = { login: 'a-stranger', association: 'NONE' };

export const CASES = LANES.flatMap((file) => (TRIGGERS[file] ?? []).map((trigger) => [file, trigger] as const));

/**
 * kanon#69: a lane run from a branch other than the default (a stacked pull request's base on
 * `pull_request_target`, a dispatch with `--ref`) runs the Kanon version the default branch's
 * caller pins, or it refuses, visibly.
 */
export const caller = (version: string, lane = 'agent-review.yml') =>
  `name: Review\non: [workflow_dispatch]\njobs:\n  review:\n    uses: yedeya-labs/kanon/.github/workflows/${lane}@${version}\n`;
export const STACKED = {
  GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/review.yml@refs/heads/feature-a`,
  GITHUB_WORKFLOW_SHA: 'f'.repeat(40),
};
export const REPOSITORY = { repository: { default_branch: 'main' } };
