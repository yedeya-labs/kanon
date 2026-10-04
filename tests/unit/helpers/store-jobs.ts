import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { STORE_ENVIRONMENT } from '../../../actions/qa-store/qa-store.mjs';

/**
 * The shape plan 0004 §3.2 fixes for a lane that reaches the QA store (step P9), as a check
 * that each store-coupled lane's test applies to its own workflow: the dispatch sweep (step 9),
 * the code audit (11), the Explorer (12) and the Overseer (13). P9 tests it on a fixture lane.
 *
 * - **Store jobs** run `actions/qa-store` and nothing else of the lane's: each declares the
 *   `kanon-qa-store` environment, and no other name, and an explicit `permissions:` that grants
 *   `id-token: write`. The store's role trusts that environment's OIDC subject alone.
 * - **The agent job** declares an explicit `permissions:` without `id-token`, and no
 *   `environment:`. Without its own block it would inherit the caller's `id-token: write`, as
 *   every job of `agent-lane.yml` inherits its caller's grant. The block must still grant every
 *   read the telemetry step makes with the default token, because narrowing that grant once
 *   cost the telemetry step a read (RA-2592): `telemetryReads` derives them from the action.
 * - **Every other job** declares its own `permissions:` without `id-token` and no environment,
 *   so only a store job can ever hold the store's credentials.
 * - **The export's delete job** runs `actions/qa-store` with `operation: delete-export`, needs
 *   the export job and the agent job, runs `if: always()` and nothing else, and is the only job
 *   granted `actions: write`, which is all it is granted.
 */

type Step = { uses?: string; with?: Record<string, unknown>; run?: string; if?: string; env?: Record<string, string> };
export type Job = {
  uses?: string;
  with?: Record<string, unknown>;
  steps?: Step[];
  permissions?: Record<string, string> | string;
  environment?: string | { name?: string };
  needs?: string | string[];
  if?: string;
};
export type Workflow = { permissions?: Record<string, string> | string; jobs: Record<string, Job> };

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A read the telemetry step makes with the workflow's default token, and when it makes it. */
export type TelemetryRead = { scope: string; when: 'always' | 'pr' | 'issue' };

const GH_SCOPES: Array<[RegExp, string]> = [
  [/\bgh\s+pr\b/, 'pull-requests'],
  [/\bgh\s+issue\b/, 'issues'],
  [/\bgh\s+run\b/, 'actions'],
];

/**
 * The reads `agent-telemetry` makes with `github.token`, from its own `action.yml`. A step that
 * uses the default token in a way this can't map fails here by name, so the check grows with
 * the action instead of going stale.
 */
export function telemetryReads(actionText = readFileSync(`${ROOT}actions/agent-telemetry/action.yml`, 'utf8')): TelemetryRead[] {
  const action = parse(actionText) as { runs: { steps: Step[] } };
  const reads: TelemetryRead[] = [];
  for (const step of action.runs.steps) {
    if (!/github\.token/.test(String(step.env?.GH_TOKEN ?? ''))) continue;
    const scopes = GH_SCOPES.filter(([re]) => re.test(step.run ?? '')).map(([, s]) => s);
    if (scopes.length === 0 || /\bgh\s+api\b/.test(step.run ?? '')) {
      throw new Error(`agent-telemetry's step "${step.run?.slice(0, 60)}" uses the default token in a way telemetryReads can't map to a permission`);
    }
    const cond = step.if?.trim();
    const when = cond === undefined ? 'always'
      : cond === "inputs.pr_number != ''" ? 'pr'
        : cond === "inputs.issue_number != ''" ? 'issue'
          : null;
    if (when === null) throw new Error(`agent-telemetry's step has a condition telemetryReads can't read: ${cond}`);
    for (const scope of scopes) reads.push({ scope, when });
  }
  return reads;
}

const usesBlock = (s: Step | Job, name: string) => typeof s.uses === 'string' && new RegExp(`(^\\$/|^yedeya-labs/kanon/)actions/${name}(@|$)`).test(s.uses);
const callsSpine = (j: Job) => typeof j.uses === 'string' && /(^\$\/|^yedeya-labs\/kanon\/)\.github\/workflows\/agent-lane\.yml(@|$)/.test(j.uses);
const storeSteps = (j: Job) => (j.steps ?? []).filter((s) => usesBlock(s, 'qa-store'));

/** A job that runs a store operation through the hook. */
export const isStoreJob = (j: Job) => storeSteps(j).some((s) => s.with?.operation !== 'delete-export');
/** A job that deletes the export's artifact. */
export const isDeleteJob = (j: Job) => storeSteps(j).some((s) => s.with?.operation === 'delete-export');
/** A job that runs the agent: through the spine, or the blocks, or the action itself. */
export const isAgentJob = (j: Job) => callsSpine(j)
  || (j.steps ?? []).some((s) => usesBlock(s, 'agent-run') || /^anthropics\/claude-code-action@/.test(s.uses ?? ''));

const envName = (j: Job) => (typeof j.environment === 'object' ? j.environment?.name : j.environment);
const grants = (j: Job) => (typeof j.permissions === 'object' && j.permissions !== null ? j.permissions : null);
const needsOf = (j: Job) => [j.needs ?? []].flat();
const rank = (v?: string) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);

/** The telemetry inputs a job passes: through the spine, `agent-finish` or `agent-telemetry`. */
function telemetryInputs(j: Job): { pr: unknown; issue: unknown } | null {
  if (callsSpine(j)) return { pr: j.with?.['pr-number'], issue: j.with?.['issue-number'] };
  const finish = (j.steps ?? []).find((s) => usesBlock(s, 'agent-finish'));
  if (finish) return { pr: finish.with?.['pr-number'], issue: finish.with?.['issue-number'] };
  const telemetry = (j.steps ?? []).find((s) => usesBlock(s, 'agent-telemetry'));
  if (telemetry) return { pr: telemetry.with?.pr_number, issue: telemetry.with?.issue_number };
  return null;
}

/**
 * What's wrong with one agent job: plan 0004 P9's check. `reads` defaults to the telemetry
 * action's own.
 */
export function agentJobProblems(name: string, j: Job, reads: TelemetryRead[] = telemetryReads()): string[] {
  const out: string[] = [];
  if (j.environment !== undefined) out.push(`${name}: the agent job declares environment '${envName(j)}'; only store jobs declare one`);
  const p = grants(j);
  if (!p) {
    out.push(`${name}: the agent job declares no permissions block of its own, so it inherits the caller's grant, id-token included`);
    return out;
  }
  if ('id-token' in p) out.push(`${name}: the agent job grants id-token: ${p['id-token']}`);
  const inputs = telemetryInputs(j);
  if (!inputs) {
    out.push(`${name}: the agent job runs no telemetry step (agent-finish or agent-telemetry)`);
    return out;
  }
  const set = (v: unknown) => v !== undefined && v !== null && v !== '';
  for (const r of reads) {
    if (r.when === 'pr' && !set(inputs.pr)) continue;
    if (r.when === 'issue' && !set(inputs.issue)) continue;
    if (rank(p[r.scope]) < 1) out.push(`${name}: the agent job lacks ${r.scope}: read, which the telemetry step reads${r.when === 'always' ? '' : ` when it has a ${r.when} number`}`);
  }
  return out;
}

/** Everything wrong with a store-coupled lane's jobs. Empty when the lane has the plan's shape. */
export function storeLaneProblems(wf: Workflow, reads: TelemetryRead[] = telemetryReads()): string[] {
  const out: string[] = [];
  const jobs = Object.entries(wf.jobs ?? {});
  const store = jobs.filter(([, j]) => isStoreJob(j));
  const agents = jobs.filter(([, j]) => isAgentJob(j) && !isStoreJob(j));
  const deletes = jobs.filter(([, j]) => isDeleteJob(j));
  if (store.length === 0) out.push('the lane has no store job');
  if (agents.length === 0) out.push('the lane has no agent job');

  for (const [name, j] of jobs) {
    const p = grants(j);
    if (isStoreJob(j)) {
      if (envName(j) !== STORE_ENVIRONMENT) out.push(`${name}: a store job's environment is '${envName(j) ?? ''}', not '${STORE_ENVIRONMENT}'`);
      if (!p || p['id-token'] !== 'write') out.push(`${name}: a store job declares no permissions block granting id-token: write`);
      if (isAgentJob(j)) out.push(`${name}: a store job runs the agent`);
      if (isDeleteJob(j)) out.push(`${name}: a store job also deletes the export`);
      if (p && rank(p.actions) === 2) out.push(`${name}: a store job grants actions: write`);
      continue;
    }
    if (isAgentJob(j)) {
      out.push(...agentJobProblems(name, j, reads));
    } else {
      if (j.environment !== undefined) out.push(`${name}: declares environment '${envName(j)}'; only store jobs declare one`);
      if (!p) out.push(`${name}: declares no permissions block of its own, so it inherits the caller's grant, id-token included`);
      else if ('id-token' in p) out.push(`${name}: grants id-token: ${p['id-token']}; only store jobs do`);
    }
    if (p && rank(p.actions) === 2 && !isDeleteJob(j)) out.push(`${name}: grants actions: write; only the export's delete job does`);
  }

  const exporters = store.filter(([, j]) => storeSteps(j).some((s) => s.with?.operation === 'export')).map(([n]) => n);
  if (exporters.length && deletes.length === 0) out.push(`the lane exports the store (${exporters.join(', ')}) and has no job that deletes the export`);
  for (const [name, j] of deletes) {
    if (j.if !== 'always()') out.push(`${name}: the export's delete job runs if '${j.if ?? ''}', not always()`);
    const needs = needsOf(j);
    for (const e of exporters) if (!needs.includes(e)) out.push(`${name}: the export's delete job doesn't need the export job ${e}`);
    for (const [a] of agents) if (!needs.includes(a)) out.push(`${name}: the export's delete job doesn't need the agent job ${a}`);
    const p = grants(j);
    if (JSON.stringify(p) !== JSON.stringify({ actions: 'write' })) out.push(`${name}: the export's delete job grants ${JSON.stringify(p)}, not exactly actions: write`);
    if (j.environment !== undefined) out.push(`${name}: the export's delete job declares an environment`);
  }
  return out;
}
