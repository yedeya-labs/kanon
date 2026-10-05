import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The shape plan 0004 §3.2 fixes for a lane that reaches the QA store (step P9), as a check
 * that each store-coupled lane's test applies to its own workflow: the dispatch sweep (step 9),
 * the code audit (11), the Explorer (12) and the Overseer (13). P9 tests it on a fixture lane.
 *
 * - **Store jobs** run `actions/qa-store` and nothing else of the lane's: each declares an
 *   explicit `permissions:` that grants `id-token: write`, and no environment. The store's role
 *   trusts the default branch's ref subject alone (decision 9, as the Owner changed it on
 *   2026-10-05), and an environment would replace the ref in the subject. Their steps are the block's, plus `actions/download-artifact` in a job that `put`s, to fetch the
 *   report it writes; nothing else runs with the store's credentials (kanon#225). A step
 *   carries only `uses`, `id`, `name`, `with`, `if` and `timeout-minutes`, and a job only the
 *   keys in `STORE_JOB_KEYS`: no `env:` (a `NODE_OPTIONS` would run code inside the block), no
 *   `container:`, `services:` or `defaults:`. The delete job is held to the same, with the
 *   block's `delete-export` step alone.
 * - **The agent job** declares an explicit `permissions:` without `id-token`. Without its own block it would inherit the caller's `id-token: write`, as
 *   every job of `agent-lane.yml` inherits its caller's grant. The block must still grant every
 *   read the telemetry step makes with the default token, because narrowing that grant once
 *   cost the telemetry step a read (RA-2592): `telemetryReads` derives them from the action.
 * - **Every other job** declares its own `permissions:` without `id-token`, so only a store job
 *   can ever hold the store's credentials. `idTokenProblems` holds every Kanon workflow, not
 *   only the store-coupled lanes, to that last rule.
 * - **No job declares an environment.** The store no longer uses one (decision 9 as changed),
 *   and one on a store job would make its subject `:environment:<name>`, which the role refuses.
 * - **The export's delete job** runs `actions/qa-store` with `operation: delete-export`, needs
 *   the export job and the agent job, runs `if: always()` and nothing else, and is the only job
 *   granted `actions: write`, which is all it is granted.
 * - **A re-run of the agent job alone reads no deleted export** (kanon#224). "Re-run failed
 *   jobs" reuses the export job's outputs, and the earlier attempt's delete job has already
 *   deleted the artifact they name. So a lane that exports runs one agent job, which needs the
 *   export job and runs only on its attempt (`needs.<export>.outputs.attempt ==
 *   github.run_attempt`, a top-level conjunct of its `if:`); the export job outputs the block's
 *   `attempt`; and the delete step is handed the export's `artifact-id` and `attempt` and the
 *   agent job's `result`, so it turns that re-run red and says "Re-run all jobs".
 */

type Step = { id?: string; name?: string; uses?: string; with?: Record<string, unknown>; run?: string; if?: string; env?: Record<string, string> };
export type Job = {
  uses?: string;
  with?: Record<string, unknown>;
  steps?: Step[];
  permissions?: Record<string, string> | string;
  environment?: string | { name?: string };
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
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

/** The keys a store job, or the export's delete job, may carry (kanon#225). */
export const STORE_JOB_KEYS = ['name', 'needs', 'if', 'runs-on', 'permissions', 'outputs', 'steps', 'timeout-minutes', 'concurrency'];
/** The keys a step of one may carry: no `env:`, `run:`, `shell:`, `working-directory:` or `continue-on-error:`. */
export const STORE_STEP_KEYS = ['uses', 'id', 'name', 'with', 'if', 'timeout-minutes'];
const downloadsArtifact = (s: Step) => typeof s.uses === 'string' && /^actions\/download-artifact@[^/\s]+$/.test(s.uses);
const describeStep = (s: Step, i: number) => `step ${i + 1} (${s.name ?? s.id ?? s.uses ?? (s.run ? `run: ${s.run.split('\n')[0]!.slice(0, 40)}` : '?')})`;

/**
 * kanon#225: what a store job or the delete job runs besides the block. `delete` holds the delete
 * job to its one step; a store job may also download the report it `put`s.
 */
function extraStepProblems(name: string, j: Job, kind: 'store' | 'delete'): string[] {
  const out: string[] = [];
  const what = kind === 'store' ? 'a store job' : "the export's delete job";
  for (const key of Object.keys(j)) {
    if (key === 'environment' && kind === 'delete') continue; // the rule for every other job names it
    if (key === 'environment') out.push(`${name}: ${what} declares environment '${envName(j)}', which would replace the default branch's ref in its OIDC subject, so the store's role would refuse it`);
    else if (!STORE_JOB_KEYS.includes(key)) out.push(`${name}: ${what} carries '${key}', which a store job never needs`);
  }
  const puts = storeSteps(j).some((s) => s.with?.operation === 'put');
  (j.steps ?? []).forEach((s, i) => {
    // A delete-export step in a store job, or a store operation in the delete job, is already
    // red: the job is then both (`a store job also deletes the export`).
    const download = kind === 'store' && puts && downloadsArtifact(s);
    if (!usesBlock(s, 'qa-store') && !download) {
      out.push(`${name}: ${what} runs ${describeStep(s, i)}, which is ${kind === 'store' ? 'neither the qa-store block nor the download of the report it puts' : 'not the qa-store block'}`);
      return;
    }
    for (const key of Object.keys(s)) if (!STORE_STEP_KEYS.includes(key)) out.push(`${name}: ${what}'s ${describeStep(s, i)} carries '${key}'`);
  });
  return out;
}

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
  if (j.environment !== undefined) out.push(`${name}: the agent job declares environment '${envName(j)}'; no job of a store-coupled lane declares one`);
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

/**
 * Everything wrong with a store-coupled lane's jobs. Empty when the lane has the plan's shape.
 *
 * `agentless`: a lane that runs no model, the dispatch sweep (plan 0004 step 9). It must then
 * have no agent job, and its script's job is held to the rule for every other job: its own
 * `permissions:` without `id-token`.
 */
export function storeLaneProblems(wf: Workflow, reads: TelemetryRead[] = telemetryReads(), { agentless = false }: { agentless?: boolean } = {}): string[] {
  const out: string[] = [];
  const jobs = Object.entries(wf.jobs ?? {});
  const store = jobs.filter(([, j]) => isStoreJob(j));
  const agents = jobs.filter(([, j]) => isAgentJob(j) && !isStoreJob(j));
  const deletes = jobs.filter(([, j]) => isDeleteJob(j));
  if (store.length === 0) out.push('the lane has no store job');
  if (agentless && agents.length) out.push(`a lane that runs no model has an agent job (${agents.map(([n]) => n).join(', ')})`);
  if (!agentless && agents.length === 0) out.push('the lane has no agent job');

  for (const [name, j] of jobs) {
    const p = grants(j);
    if (isStoreJob(j)) {
      if (!p || p['id-token'] !== 'write') out.push(`${name}: a store job declares no permissions block granting id-token: write`);
      if (isAgentJob(j)) out.push(`${name}: a store job runs the agent`);
      if (isDeleteJob(j)) out.push(`${name}: a store job also deletes the export`);
      if (p && rank(p.actions) === 2) out.push(`${name}: a store job grants actions: write`);
      if (!isAgentJob(j) && !isDeleteJob(j)) out.push(...extraStepProblems(name, j, 'store'));
      continue;
    }
    if (isAgentJob(j)) {
      out.push(...agentJobProblems(name, j, reads));
    } else {
      if (j.environment !== undefined) out.push(`${name}: declares environment '${envName(j)}'; no job of a store-coupled lane declares one`);
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
    out.push(...extraStepProblems(name, j, 'delete'));
  }
  out.push(...rerunProblems(jobs, exporters, agents.map(([n]) => n)));
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `value` is exactly the expression `${{ <expr> }}`, give or take whitespace. */
const isExpr = (value: unknown, expr: string) => typeof value === 'string'
  && new RegExp(`^\\$\\{\\{\\s*${expr.split(/\s+/).map(esc).join('\\s+')}\\s*\\}\\}$`).test(value.trim());
/** The top-level `&&` conjuncts of a job's `if:`, or null when it has an `||` (which could bypass one). */
const conjuncts = (cond: string | undefined) => {
  const c = (cond ?? '').trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
  if (c === '' || c.includes('||')) return null;
  return c.split('&&').map((x) => x.trim().replace(/\s+/g, ' '));
};

/** kanon#224: a partial re-run of a lane that exports never runs its agent on a deleted export. */
function rerunProblems(jobs: Array<[string, Job]>, exporters: string[], agents: string[]): string[] {
  if (exporters.length === 0) return [];
  const out: string[] = [];
  if (agents.length !== 1) out.push(`a lane that exports the store runs one agent job, not ${agents.length} (${agents.join(', ')})`);
  const byName = new Map(jobs);
  const deleteSteps = jobs.filter(([, j]) => isDeleteJob(j)).flatMap(([n, j]) => storeSteps(j)
    .filter((s) => s.with?.operation === 'delete-export').map((s) => [n, s] as const));
  for (const e of exporters) {
    const j = byName.get(e)!;
    const ids = storeSteps(j).filter((s) => s.with?.operation === 'export').map((s) => s.id);
    if (!ids.some((id) => id && isExpr(j.outputs?.attempt, `steps.${id}.outputs.attempt`))) {
      out.push(`${e}: the export job doesn't output its attempt (attempt: \${{ steps.<id>.outputs.attempt }}), which the agent job's if: compares with the run's`);
    }
    for (const a of agents) {
      const aj = byName.get(a)!;
      if (!needsOf(aj).includes(e)) out.push(`${a}: the agent job doesn't need the export job ${e}`);
      const gate = `needs.${e}.outputs.attempt == github.run_attempt`;
      if (!(conjuncts(aj.if) ?? []).includes(gate)) {
        out.push(`${a}: the agent job's if: '${aj.if ?? ''}' lacks the conjunct '${gate}', so a re-run of it alone reads an export already deleted`);
      }
    }
    const mine = deleteSteps.filter(([, s]) => isExpr(s.with?.['artifact-id'], `needs.${e}.outputs.artifact-id`));
    if (mine.length === 0 && deleteSteps.length > 0) out.push(`no delete-export step is handed the export job's artifact-id (\${{ needs.${e}.outputs.artifact-id }})`);
    for (const [d, s] of mine) {
      if (!isExpr(s.with?.['export-attempt'], `needs.${e}.outputs.attempt`)) out.push(`${d}: the delete-export step isn't handed export-attempt: \${{ needs.${e}.outputs.attempt }}`);
      if (agents.length === 1 && !isExpr(s.with?.['agent-result'], `needs.${agents[0]}.result`)) {
        out.push(`${d}: the delete-export step isn't handed agent-result: \${{ needs.${agents[0]}.result }}, so a partial re-run that skipped the agent stays green`);
      }
    }
  }
  return out;
}

/** Where a job's `id-token` grant comes from, if it has one. */
export type IdTokenSource = 'job' | 'workflow';

const grantsIdToken = (p: Workflow['permissions']) =>
  p === 'write-all' || (typeof p === 'object' && p !== null && 'id-token' in p && p['id-token'] !== 'none');

/**
 * Whether a job holds `id-token: write`: from its own `permissions:`, or inherited from the
 * workflow's when it declares none. A job with neither inherits its caller's grant: the guard
 * holds it as a holder whenever a caller passes `id-token` (`idTokenProblems`).
 */
export function idTokenSource(wf: Workflow, j: Job): IdTokenSource | null {
  if (j.permissions !== undefined) return grantsIdToken(j.permissions) ? 'job' : null;
  return grantsIdToken(wf.permissions) ? 'workflow' : null;
}

const usesMaintenance = (s: Step) => typeof s.uses === 'string' && /^(\$\/|yedeya-labs\/kanon\/)infra\/qa-store\/aws\/maintenance(@|$)/.test(s.uses);

/** The collector's workflow and job (plan 0002 S7), the one holder outside the QA store's. */
export const COLLECTOR_FILE = 'telemetry-collect.yml';
export const COLLECTOR_JOB = 'collect';
/** What the collector's script step may be handed: nothing that runs code, such as `NODE_OPTIONS`. */
export const COLLECTOR_ENV = ['GH_TOKEN', 'KANON_TELEMETRY_URL', 'WINDOW'];
const COLLECTOR_RUN = 'node "$KANON/scripts/telemetry-collect.mjs"';
const CREDENTIALS = /^aws-actions\/configure-aws-credentials@v\d+(\.\d+){0,2}$/;
const only = (o: object | undefined, keys: string[]) => Object.keys(o ?? {}).every((k) => keys.includes(k));

/**
 * The telemetry collector's job (plan 0002 S7): `collect` in `telemetry-collect.yml`, and only
 * when its steps are exactly Kanon's path, the AWS credentials for the writer role, and the
 * collector script, with nothing beside them that could run other code: no job `env:`,
 * `container:`, `services:` or `defaults:` (`STORE_JOB_KEYS`), and only the script's own
 * variables on its step. The writer trusts every default-branch job that holds `id-token`
 * (docs/telemetry.md, "Who can write"), so the shape is what keeps the set to this job.
 */
export function isCollectorJob(file: string | undefined, name: string, j: Job): boolean {
  if (file !== COLLECTOR_FILE || name !== COLLECTOR_JOB || !only(j, STORE_JOB_KEYS)) return false;
  const steps = (j.steps ?? []) as Array<Record<string, unknown>>;
  if (steps.length !== 3) return false;
  const [path, creds, run] = steps as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  return only(path, ['uses']) && path.uses === '$/actions/kanon-path'
    && only(creds, ['uses', 'with']) && CREDENTIALS.test(String(creds.uses))
    && only(creds.with as object, ['role-to-assume', 'aws-region', 'role-session-name'])
    && only(run, ['name', 'env', 'run']) && String(run.run).trim() === COLLECTOR_RUN
    && only(run.env as object, COLLECTOR_ENV);
}

/**
 * A job that may hold `id-token: write`: one that runs the qa-store block alone (kanon#225's
 * allow-list: the block, plus the download of the report a `put` writes), or the AWS store's
 * maintenance block alone, with nothing that could run other code beside it, or the telemetry
 * collector's job (`isCollectorJob`), which needs its workflow's file name.
 */
export function mayHoldIdToken(name: string, j: Job, file?: string): boolean {
  if (isCollectorJob(file, name, j)) return true;
  if (isStoreJob(j)) return !isAgentJob(j) && !isDeleteJob(j) && extraStepProblems(name, j, 'store').length === 0;
  const steps = j.steps ?? [];
  return steps.length === 1 && usesMaintenance(steps[0]!)
    && Object.keys(j).every((k) => STORE_JOB_KEYS.includes(k))
    && Object.keys(steps[0]!).every((k) => STORE_STEP_KEYS.includes(k));
}

/** The workflow file a job calls, when it is one of Kanon's own. */
const calledWorkflow = (j: Job) =>
  (typeof j.uses === 'string' ? /^(?:\$\/|\.\/|yedeya-labs\/kanon\/)\.github\/workflows\/([^/@]+\.ya?ml)(?:@|$)/.exec(j.uses)?.[1] : undefined);

/**
 * The widened id-token guard (decision 9, as the Owner changed it on 2026-10-05). The store's
 * role trusts every run of the default branch, so which job of such a run may ask GitHub for an
 * OIDC token is held here: in every workflow given, a job that holds `id-token: write`, whether
 * its own grant or inherited from the workflow's, must be one that `mayHoldIdToken`, or a job
 * that calls one of the given workflows that has such a job (a caller has to grant what its
 * callee's store jobs ask for). A caller's grant also reaches every callee job that declares no
 * permissions in a callee with no workflow-level block, so each of those must be one that
 * `mayHoldIdToken` too. Anything else is named, with where its grant comes from.
 */
export function idTokenProblems(workflows: Record<string, Workflow>): string[] {
  const out: string[] = [];
  const holdsLegitimately = (file: string, wf: Workflow) => Object.entries(wf.jobs ?? {}).some(([n, j]) => idTokenSource(wf, j) && mayHoldIdToken(n, j, file));
  for (const [file, wf] of Object.entries(workflows)) {
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      const source = idTokenSource(wf, j);
      if (!source) continue;
      const how = source === 'job' ? 'its own permissions grant' : "it declares no permissions, so it inherits the workflow's";
      const callee = calledWorkflow(j);
      if (callee !== undefined) {
        const target = workflows[callee];
        if (!target) out.push(`${file}: job ${name} holds id-token: write (${how}) and calls ${callee}, which the guard was not given`);
        else if (!holdsLegitimately(callee, target)) out.push(`${file}: job ${name} holds id-token: write (${how}) and calls ${callee}, which has no store job to pass it to`);
        else if (target.permissions === undefined) {
          for (const [n, cj] of Object.entries(target.jobs ?? {})) {
            if (cj.permissions === undefined && !mayHoldIdToken(n, cj, callee)) {
              out.push(`${callee}: job ${n} declares no permissions in a workflow with none, so it inherits id-token: write from ${file}'s job ${name}; only a job that runs the qa-store block alone, or the telemetry collector job, may`);
            }
          }
        }
        continue;
      }
      if (!mayHoldIdToken(name, j, file)) out.push(`${file}: job ${name} holds id-token: write (${how}); only a job that runs the qa-store block alone, or the telemetry collector job, may`);
    }
  }
  return out;
}
