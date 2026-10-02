import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { blockCallOf, expandableOf, expandLaneBlocks, laneBlockOf, laneBlockPath } from './agent-lanes.mjs';
import { agentPrompt, type WorkflowStep } from './workflow-step.js';

/**
 * What a lane that CALLS `agent-lane.yml` actually runs (RA-2592).
 *
 * A converted lane's job is `uses:` + `with:`; its steps live in the spine and are
 * switched by the lane's inputs (`database`, `browsers`, `ref`, …). A suite that asserted
 * "this lane's job provisions Postgres" against the lane's own steps now has nothing to
 * read — and the tempting fix, asserting that the SPINE has a Postgres step, is true for
 * every caller including the ones that turn it off. So this resolves the spine FOR ONE
 * CALLER: its declared inputs, defaulted as `workflow_call` defaults them, and every
 * spine `if:` / service image that depends only on those inputs evaluated.
 *
 * DELIBERATELY NARROW. It evaluates only the expression shapes the spine and its blocks
 * use on their inputs — `inputs.x`, `inputs.x != ''`, `inputs.x == 'lit'`, `always()`,
 * joined by `&&` (or by `||` alone, RA-2694), and the `inputs.x && 'image' || ''` service
 * form — and returns
 * `undefined` (runtime-dependent) for anything else, e.g. `failure()` or a `steps.` output.
 * An unknown shape is never guessed to be true or false; a suite that needs it asserts on
 * it directly.
 *
 * THROUGH THE BLOCKS (RA-2666). The spine's job is built from composite actions, so
 * what a lane RUNS is the spine's steps with each block call replaced by the block's steps
 * — `expandLaneBlocks` in `scripts/qa/lib/agent-lanes.mjs`, the resolver the CI scanners
 * share. A block's `if:` reads the BLOCK's inputs, which are the strings the call's
 * `with:` evaluates to for this lane: a boolean the spine passes arrives as 'true'/'false'
 * (a composite input has no boolean type), so each block's switches compare against
 * 'true', and this evaluates them against exactly those strings.
 */
type Job = {
  uses?: string;
  with?: Record<string, unknown>;
  steps?: WorkflowStep[];
  services?: Record<string, { image?: string }>;
  if?: string;
  needs?: string | string[];
};

const SPINE = '.github/workflows/agent-lane.yml';

type Spine = {
  on: { workflow_call: { inputs: Record<string, { default?: unknown; type: string }>; outputs: Record<string, { value: string }> } };
  jobs: { run: Job & { outputs?: Record<string, string>; permissions?: unknown } };
  permissions?: unknown;
};

export const readSpine = (): Spine => parse(readFileSync(join(process.cwd(), SPINE), 'utf8')) as Spine;

/** A block's parsed `action.yml`, by repo-relative path — the reader `expandLaneBlocks` takes. */
export const readAction = (path: string) => parse(readFileSync(join(process.cwd(), path), 'utf8'));

type Block = {
  inputs?: Record<string, { default?: string; required?: boolean }>;
  outputs?: Record<string, { value: string }>;
  runs: { using: string; steps: WorkflowStep[] };
};
/** A lane block's parsed `action.yml`, by name (`agent-run`, …). */
/** Since RA-2704 a block is read from the Kanon checkout at the pinned tag (`laneBlockPath`). */
export const readBlock = (name: string): Block => readAction(laneBlockPath(name)) as Block;

/**
 * A job's steps as it RUNS them: every lane-block call replaced by the block's own steps,
 * whole-value inputs substituted, nothing evaluated. The view for an assertion about the
 * spine as a whole ("the spine classifies a red run"), where no one caller's switches
 * apply. `blockOf(step)` names the block an expanded step came from.
 */
export const effectiveSteps = (steps: WorkflowStep[] | undefined): WorkflowStep[] =>
  expandLaneBlocks(steps ?? [], readAction) as WorkflowStep[];

/**
 * A job's steps as it runs them, with each block step whose `if:` is statically false for
 * the LITERAL inputs its call passes dropped — e.g. `agent-setup`'s `npm ci` for a call
 * passing `install: 'false'`. For any job, spine or not; a templated input stays unknown,
 * so a step is only ever dropped on a value written down.
 */
export const stepsAsRun = (steps: WorkflowStep[] | undefined): WorkflowStep[] => {
  const inputs = new Map<WorkflowStep, Record<string, unknown>>();
  const of = (call: WorkflowStep) => {
    if (!inputs.has(call)) inputs.set(call, blockInputsFor(call, {}));
    return inputs.get(call)!;
  };
  return effectiveSteps(steps).filter((s) => runsThroughItsCalls(s, of));
};

/**
 * Whether a step expanded out of a block runs, as far as the literal inputs decide it: its
 * own `if:` against the inputs its call passes, and then — for a block a block calls
 * (RA-2691: `agent-finish` → `agent-classify`) — that nested call's own `if:` against the
 * inputs of the call around it, and so on out to the job's step. A step dropped anywhere in
 * the chain does not run. The job-level call's own `if:` is the job's to decide, not this.
 */
const runsThroughItsCalls = (step: WorkflowStep, inputsOf: (call: WorkflowStep) => Record<string, unknown>): boolean => {
  let at = step;
  for (let from = blockOf(at); from; at = from.call, from = blockOf(at)) {
    if (evalInputsIf(at.if, inputsOf(from.call)) === false) return false;
  }
  return true;
};

/** The spine's job steps, through its blocks, for no caller in particular. */
export const spineSteps = (): WorkflowStep[] => effectiveSteps(readSpine().jobs.run.steps);

/** The block an expanded step came from, and the spine step that called it. */
export const blockOf = (step: WorkflowStep) => blockCallOf(step) as { block: string; call: WorkflowStep } | undefined;
export { laneBlockOf };

/** True when a job hands its body to the spine. */
export const callsSpine = (job: Job | undefined) => job?.uses === `$/${SPINE}`;

/** The inputs a caller's run sees: `workflow_call` defaults, overridden by its `with:`. */
export const spineInputsFor = (job: Job): Record<string, unknown> => {
  const declared = readSpine().on.workflow_call.inputs;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(declared)) out[k] = v.default;
  for (const [k, v] of Object.entries(job.with ?? {})) {
    if (!(k in declared)) throw new Error(`the caller passes \`${k}\`, which the spine does not declare`);
    out[k] = v;
  }
  return out;
};

const truthy = (v: unknown) => v !== undefined && v !== null && v !== false && v !== '' && v !== 0;

/**
 * `v != ''` as GitHub evaluates it. Its `!=` coerces mismatched types to NUMBERS, so a
 * boolean `false` (0) or a null (0) EQUALS '' (0) — a plain `String(v) !== ''` would
 * call `false != ''` true and keep a step the caller switched off.
 */
const notEmpty = (v: unknown) =>
  typeof v === 'string' ? v !== '' : v === undefined || v === null ? false : Number(v) !== 0;

/**
 * `a == b` as GitHub evaluates it: two strings compare CASE-INSENSITIVELY, and mismatched
 * types coerce to numbers — so a boolean `true` (1) does NOT equal 'true' (NaN). That is
 * the trap a spine-level `inputs.flag == 'true'` would fall into, which is why only the
 * blocks (whose inputs are strings) use this form. A value that is still a template is
 * decided at run time: `undefined`.
 */
const ghEquals = (v: unknown, lit: string): boolean | undefined => {
  if (typeof v === 'string') return v.includes('${{') ? undefined : v.toLowerCase() === lit.toLowerCase();
  const n = v === undefined || v === null ? 0 : Number(v);
  const m = lit === '' ? 0 : Number(lit);
  return !Number.isNaN(n) && !Number.isNaN(m) && n === m;
};

/**
 * Evaluate a spine (or block) `if:` against one caller's (or call's) inputs. `true`/`false` when it depends only
 * on inputs (and `always()`); `undefined` when any term is decided at run time.
 */
export const evalInputsIf = (expr: string | undefined, inputs: Record<string, unknown>): boolean | undefined => {
  if (expr === undefined) return true;
  // A DISJUNCTION OF PLAIN TERMS (RA-2694): the project-setup hook's per-lane switches read
  // `inputs.lane == 'a' || inputs.lane == 'b'`. Only with no `&&` and no parentheses, so
  // each side is one term and precedence cannot be misread: true when any side is, false
  // when every side is, and unknown otherwise.
  const text = String(expr);
  if (text.includes('||') && !/&&|[()]/.test(text)) {
    const sides = text.split('||').map((t) => evalInputsIf(t.trim(), inputs));
    if (sides.some((v) => v === true)) return true;
    return sides.every((v) => v === false) ? false : undefined;
  }
  // A conjunction: ONE statically-false input term makes the whole step false for this
  // caller whatever the runtime terms say, so it must not be reported as "depends on run
  // time" — that would keep a step the caller has switched off (e.g. `failure() &&
  // inputs.x` with x off). Unknown only when nothing decides it statically.
  if (/\|\||!\(/.test(String(expr))) return undefined;
  const terms = String(expr).split('&&').map((t) => t.trim());
  let unknown = false;
  for (const t of terms) {
    if (t === 'always()') continue;
    let m = /^inputs\.([\w-]+)$/.exec(t);
    if (m) { if (!truthy(inputs[m[1]!])) return false; continue; }
    m = /^inputs\.([\w-]+) != ''$/.exec(t);
    if (m) { if (!notEmpty(inputs[m[1]!])) return false; continue; }
    m = /^inputs\.([\w-]+) == '([^']*)'$/.exec(t);
    if (m) {
      const eq = ghEquals(inputs[m[1]!], m[2]!);
      if (eq === false) return false;
      if (eq === undefined) unknown = true;
      continue;
    }
    unknown = true;
  }
  return unknown ? undefined : true;
};

/** A template value (`${{ inputs.x }}`, or the service-image form) resolved for one caller. */
export const resolveInputsValue = (value: unknown, inputs: Record<string, unknown>): unknown => {
  if (typeof value !== 'string') return value;
  const whole = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(value.trim());
  if (!whole) return value;
  const expr = whole[1]!;
  let m = /^inputs\.([\w-]+)$/.exec(expr);
  if (m) return inputs[m[1]!];
  m = /^inputs\.([\w-]+) && '([^']*)' \|\| ''$/.exec(expr);
  if (m) return truthy(inputs[m[1]!]) ? m[2]! : '';
  return value;
};

/**
 * The string a composite input receives for one call: its `with:` value evaluated for
 * this caller (or the block's default), then stringified as the runner does — `true`
 * becomes 'true', a number its decimal, an absent value ''. A value still a template
 * (`${{ job.status }}`, a step output) stays the template: decided at run time — EXCEPT
 * the output of a spine step this caller never runs (`dropped`), which is '' because a
 * skipped step sets no outputs.
 */
export const blockInputsFor = (
  call: WorkflowStep,
  callerInputs: Record<string, unknown>,
  dropped: ReadonlySet<string> = new Set(),
): Record<string, unknown> => {
  // A block, or the project-setup hook (RA-2694), which a lane's job is expanded through too.
  const name = expandableOf(call);
  if (!name) throw new Error(`\`${String(call.uses)}\` is not a lane block or the project-setup hook`);
  const declared = readBlock(name).inputs ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(declared)) {
    const given = call.with && k in call.with ? call.with[k] : undefined;
    // An `inputs.x` this caller does not have (a non-spine job's own dispatch input) is
    // not known here: kept as the template, never read as ''.
    const unknownInput = typeof given === 'string' && /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/.exec(given.trim());
    let raw = given === undefined ? d.default ?? ''
      : unknownInput && !(unknownInput[1]! in callerInputs) ? given
        : resolveInputsValue(given, callerInputs);
    const ofStep = typeof raw === 'string' ? /^\$\{\{\s*steps\.([\w-]+)\.outputs\.[\w-]+\s*\}\}$/.exec(raw.trim()) : null;
    if (ofStep && dropped.has(ofStep[1]!)) raw = '';
    out[k] = raw === undefined || raw === null ? '' : String(raw);
  }
  return out;
};

/**
 * The spine job as ONE caller runs it, through its blocks: a spine step whose `if:` is
 * statically false for the caller's inputs is dropped, as is a block step whose `if:` is
 * statically false for the inputs that block call receives (a runtime-dependent one is
 * kept either way); and every service whose image resolves to '' is dropped — GitHub
 * starts no service with an empty image.
 *
 * `steps` is the effective list; `laneSteps` is the spine's own list before the blocks
 * are expanded, for an assertion about a block CALL (its `id`, its `with:`).
 */
export const spineJobFor = (job: Job) => {
  if (!callsSpine(job)) throw new Error(`this job does not call ${SPINE}`);
  const inputs = spineInputsFor(job);
  const run = readSpine().jobs.run;
  const laneSteps = (run.steps ?? []).filter((s) => evalInputsIf(s.if, inputs) !== false);
  const dropped = new Set((run.steps ?? []).filter((s) => !laneSteps.includes(s)).map((s) => s.id).filter((id): id is string => !!id));
  const callInputs = new Map<WorkflowStep, Record<string, unknown>>();
  const of = (call: WorkflowStep) => {
    if (!callInputs.has(call)) callInputs.set(call, blockInputsFor(call, inputs, dropped));
    return callInputs.get(call)!;
  };
  const steps = effectiveSteps(laneSteps).filter((s) => runsThroughItsCalls(s, of));
  const services: Record<string, { image?: string }> = {};
  for (const [id, svc] of Object.entries(run.services ?? {})) {
    const image = resolveInputsValue(svc.image, inputs);
    if (image !== '') services[id] = { ...svc, image: String(image) };
  }
  return { inputs, steps, laneSteps, services, run };
};

/** A job's agent prompt in either shape: its own agent step, or the input it passes the spine. */
export const jobPrompt = (job: Job): string => {
  if (callsSpine(job)) {
    const p = job.with?.prompt;
    if (typeof p !== 'string') throw new Error('the spine caller passes no `prompt`');
    return p;
  }
  return agentPrompt(job.steps);
};
