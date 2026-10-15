import { parseCondition } from './job-condition.js';
import { KIND_SECRETS } from '../../../scripts/lib/notify-contract.mjs';
import { TAGS } from '../../../actions/agent-telemetry/schema.mjs';

/**
 * The shape plan 0011 §5 fixes for a lane's `notify` job (step N6, `K-OBS-19`), as
 * `store-jobs.ts` fixes the QA store's jobs: the one job of a notifying lane that runs the
 * adopter's hook, so the one job that may hold a chat secret.
 *
 * - **It is called `notify`** (doctor reads its log line by that name, `cli/doctor.mjs`'s
 *   `NOTIFY_JOB`), and **needs the gate's job and the one producing job**, the job whose output
 *   `message-artifact` names the message.
 * - **Its `if:` is exactly `NOTIFY_IF`:** only past an admitting gate, only with a hook (`hook ==
 *   'present'`, never `!= 'none'`, which an empty output passes), never on a dry run, and never on
 *   a cancelled run (`!cancelled()`, never a job-level `always()`, which would start it after a
 *   cancel). It does run after a failed or skipped producer, so a message not posted is recorded
 *   as `skipped`. `startsNotify` evaluates it in each of those worlds.
 * - **It holds one secret, its kind's**, by name, handed to the block as one input (`K-AGENT-47`),
 *   a workflow token that reads contents and nothing else, and no job-level `env:` (a
 *   `NODE_OPTIONS` could reach the block), `container:`, `services:`, `defaults:`, `strategy:`,
 *   `environment:` or `secrets:`.
 * - **Its one step is the block**, `$/actions/notify`, with `kind`, the producer's
 *   `message-artifact` output as `artifact` (never a name it builds: after "Re-run failed jobs"
 *   its own attempt is one past the producer's), and the kind's secret as `secret`.
 */

export type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
export type Job = {
  name?: string;
  uses?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: unknown;
  'timeout-minutes'?: number;
  permissions?: unknown;
  outputs?: Record<string, string>;
  steps?: Step[];
  secrets?: unknown;
  [key: string]: unknown;
};
export type Workflow = { on?: unknown; jobs?: Record<string, Job> };

/** The block a `notify` job runs. */
export const NOTIFY_BLOCK = '$/actions/notify';
/** The job's id, as doctor reads it. */
export const NOTIFY_JOB = 'notify';
/** The one `if:` a `notify` job may have (plan 0011 §5.1). */
export const NOTIFY_IF = "!cancelled() && needs.gate.outputs.member == 'true' && needs.gate.outputs.hook == 'present' && inputs.dry_run != 'true'";
/** The producing job's output that names its message artifact (§4). */
export const MESSAGE_OUTPUT = 'message-artifact';

/**
 * Kanon's notifying lanes and their kinds (§3.2). The deploy lane joins with plan 0010's step
 * that wires its announcement in.
 */
export const NOTIFYING_LANES: Record<string, string> = {
  'agent-project-digest.yml': 'project-digest',
  'agent-weekly-digest.yml': 'weekly-digest',
};

const JOB_KEYS = new Set(['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'permissions', 'outputs', 'steps']);
const STEP_KEYS = new Set(['uses', 'id', 'name', 'with']);
const WITH_KEYS = new Set(['kind', 'artifact', 'secret', 'tag']);
const BLOCK_OUTPUTS = new Set(['outcome']);

/** An expression's text, its `${{ }}` stripped and its spaces collapsed. */
export const bare = (expr: unknown): string => String(expr ?? '').trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').replace(/\s+/g, ' ').trim();

/** The job holding the membership gate (`id: gate`). */
export const gateJobOf = (wf: Workflow): string | undefined =>
  Object.entries(wf.jobs ?? {}).find(([, j]) => (j.steps ?? []).some((s) => s.id === 'gate'))?.[0];

/** The jobs that publish a message artifact. */
export const producersOf = (wf: Workflow): string[] =>
  Object.entries(wf.jobs ?? {}).filter(([, j]) => j.outputs && Object.hasOwn(j.outputs, MESSAGE_OUTPUT)).map(([id]) => id);

/** The jobs that run the `notify` block, whatever they are called. */
export const notifyJobsOf = (wf: Workflow): string[] =>
  Object.entries(wf.jobs ?? {}).filter(([, j]) => (j.steps ?? []).some((s) => String(s.uses ?? '').replace(/@.*$/, '') === NOTIFY_BLOCK)).map(([id]) => id);

/** The canonical `notify` job, for a lane whose gate is `gate` and whose producer is `producer`. */
export const notifyJob = (kind: string, producer: string): Job => ({
  needs: ['gate', producer],
  if: `\${{ ${NOTIFY_IF} }}`,
  'runs-on': 'ubuntu-latest',
  'timeout-minutes': 5,
  permissions: { contents: 'read' },
  outputs: { outcome: '${{ steps.notify.outputs.outcome }}' },
  steps: [{
    uses: NOTIFY_BLOCK,
    id: 'notify',
    with: {
      kind,
      artifact: `\${{ needs.${producer}.outputs.${MESSAGE_OUTPUT} }}`,
      secret: `\${{ secrets.${KIND_SECRETS[kind]} }}`,
    },
  }],
});

/** Every `secrets.<NAME>` (or computed `secrets[…]`) a value reads. */
export const secretsRead = (value: unknown): string[] =>
  [...JSON.stringify(value ?? null).matchAll(/secrets\s*(?:\.\s*([\w-]+)|\[([^\]]*)\])/g)].map((m) => m[1] ?? `[${m[2]}]`);

/**
 * Every way job `id` of `wf` breaks the `notify` job's shape, for kind `kind`: empty when it holds.
 */
export const notifyJobProblems = (wf: Workflow, id: string, kind: string): string[] => {
  const job = wf.jobs?.[id];
  if (!job) return [`no job ${id}`];
  const problems: string[] = [];
  const secret = KIND_SECRETS[kind];
  if (!secret) return [`${kind} is not a message kind`];
  if (id !== NOTIFY_JOB) problems.push(`the job is called ${id}, not ${NOTIFY_JOB}`);
  for (const k of Object.keys(job)) if (!JOB_KEYS.has(k)) problems.push(`the job declares \`${k}:\``);
  const gate = gateJobOf(wf);
  const producers = producersOf(wf);
  if (producers.length !== 1) problems.push(`the lane has ${producers.length} producing jobs, not one`);
  const producer = producers[0];
  const needs = [job.needs ?? []].flat().sort();
  if (!gate || !producer || JSON.stringify(needs) !== JSON.stringify([gate, producer].sort())) problems.push(`it needs ${needs.join(', ') || 'nothing'}, not the gate's job and the producing job`);
  if (bare(job.if) !== NOTIFY_IF) problems.push(`its if: is not \`${NOTIFY_IF}\``);
  if (JSON.stringify(job.permissions) !== JSON.stringify({ contents: 'read' })) problems.push(`its permissions are ${JSON.stringify(job.permissions ?? null)}, not contents: read alone`);
  if (typeof job['timeout-minutes'] !== 'number' || job['timeout-minutes'] > 10) problems.push('it has no timeout of at most 10 minutes');
  for (const [k, v] of Object.entries(job.outputs ?? {})) {
    if (!BLOCK_OUTPUTS.has(k) || bare(v) !== `steps.notify.outputs.${k}`) problems.push(`its output ${k} is not the block's`);
  }
  const steps = job.steps ?? [];
  if (steps.length !== 1) problems.push(`it has ${steps.length} steps, not the block's one`);
  const step = steps[0];
  if (step) {
    if (step.uses !== NOTIFY_BLOCK) problems.push(`its step runs ${step.uses ?? step.run ?? 'nothing'}, not ${NOTIFY_BLOCK}`);
    if (step.id !== 'notify') problems.push('its step is not `id: notify`');
    for (const k of Object.keys(step)) if (!STEP_KEYS.has(k)) problems.push(`its step declares \`${k}:\``);
    const w = step.with ?? {};
    for (const k of Object.keys(w)) if (!WITH_KEYS.has(k)) problems.push(`its step hands the block \`${k}\``);
    if (w.kind !== kind) problems.push(`its kind is ${String(w.kind)}, not ${kind}`);
    if (!producer || bare(w.artifact) !== `needs.${producer}.outputs.${MESSAGE_OUTPUT}`) problems.push('its artifact is not the producing job\'s message-artifact output');
    if (bare(w.secret) !== `secrets.${secret}`) problems.push(`its secret is not ${secret}`);
    if (w.tag !== undefined && !TAGS.includes(String(w.tag))) problems.push(`its tag is ${String(w.tag)}`);
  }
  const read = secretsRead(job);
  if (read.length !== 1 || read[0] !== secret) problems.push(`it reads the secrets ${read.join(', ') || 'none'}, not ${secret} alone`);
  return problems;
};

// ── The `if:`, evaluated ─────────────────────────────────────────────────────────────────────

type Node = ReturnType<typeof parseCondition>;
type Value = string | number | boolean | null;

/** One world a `notify` job's `if:` is evaluated in. */
export type NotifyWorld = {
  /** The gate's `member` and `hook` outputs, empty when the gate's job didn't run. */
  member: string;
  hook: string;
  /** The lane's `dry_run` input. */
  dryRun: string;
  /** Whether the run was cancelled. */
  cancelled: boolean;
  /** The gate's and the producer's results. */
  gate: 'success' | 'failure' | 'skipped';
  producer: 'success' | 'failure' | 'skipped';
};

const STATUS = new Set(['always', 'success', 'failure', 'cancelled']);
const usesStatus = (n: Node): boolean =>
  n.kind === 'call' ? STATUS.has(n.name) || n.args.some(usesStatus)
    : n.kind === 'not' ? usesStatus(n.arg)
      : n.kind === 'and' || n.kind === 'or' || n.kind === 'cmp' ? usesStatus(n.left) || usesStatus(n.right)
        : false;

/**
 * Does the job start in `world`? GitHub's rules: with no status function its `if:` holds only
 * when every job it needs succeeded (the implicit `success()`); a cancelled run skips a job whose
 * `if:` doesn't hold under `cancelled()`, and `always()` holds even then.
 */
export const startsNotify = (cond: string | undefined, needs: string[], world: NotifyWorld, gate = 'gate'): boolean => {
  const text = bare(cond);
  const tree = text ? parseCondition(text) : null;
  const results: Record<string, string> = Object.fromEntries(needs.map((n) => [n, n === gate ? world.gate : world.producer]));
  const allSucceeded = needs.every((n) => results[n] === 'success');
  if (!tree || !usesStatus(tree)) {
    if (world.cancelled || !allSucceeded) return false;
    if (!tree) return true;
  }
  const loose = (v: Value) => (typeof v === 'string' ? v.toLowerCase() : v === null ? '' : String(v).toLowerCase());
  const value = (n: Node): Value => {
    switch (n.kind) {
      case 'lit': return n.value;
      case 'ref': {
        const out = /^needs\.([\w-]+)\.outputs\.([\w-]+)$/.exec(n.path);
        if (out) return out[1] === gate && world.gate !== 'skipped' ? (out[2] === 'member' ? world.member : out[2] === 'hook' ? world.hook : '') : '';
        const res = /^needs\.([\w-]+)\.result$/.exec(n.path);
        if (res) return results[res[1]!] ?? '';
        if (n.path === 'inputs.dry_run') return world.dryRun;
        throw new Error(`notify condition: unmodelled context ${n.path}`);
      }
      case 'call':
        switch (n.name) {
          case 'always': return true;
          case 'cancelled': return world.cancelled;
          case 'success': return allSucceeded && !world.cancelled;
          case 'failure': return needs.some((x) => results[x] === 'failure');
        }
        throw new Error(`notify condition: unmodelled function ${n.name}()`);
      case 'not': return !value(n.arg);
      case 'and': { const l = value(n.left); return l ? value(n.right) : l; }
      case 'or': { const l = value(n.left); return l ? l : value(n.right); }
      case 'cmp': {
        const eq = loose(value(n.left)) === loose(value(n.right));
        if (n.op === '==') return eq;
        if (n.op === '!=') return !eq;
        throw new Error(`notify condition: unmodelled operator ${n.op}`);
      }
    }
  };
  return Boolean(tree && value(tree));
};
