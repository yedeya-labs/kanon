import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validate } from '../../actions/agent-telemetry/schema.mjs';
import {
  classifyEnvironment, classifyRelease, DEPLOY_ARTIFACT_FILE, deployArtifactName, environmentRow, isHeld, releaseRow,
} from '../../scripts/deploy-row.mjs';
import { callerFile, issueOf, issueTitle, report, reportFrom, smokeIssueTitle } from '../../scripts/deploy-report.mjs';
import { deployCallerFile } from '../../cli/init.mjs';
import { loadRequirements } from '../../cli/callers.mjs';
import * as collected from '../../scripts/lib/telemetry-artifacts.mjs';
import { CI_POLL_MS, CI_WAIT_CEILING, deployCheck, GATE_MARGIN_MINUTES } from '../../scripts/deploy-gate.mjs';
import { BUILD_DIR, buildArtifactName, checkBuild, listFiles, readBuild, treeDigest } from '../../scripts/deploy-build.mjs';

/**
 * Plan 0010 steps D4 and D5: the deploy lane's two reusable workflows, `deploy-release.yml`
 * (gate, probe, build, record, report) and `deploy.yml` (declare, deploy, record, report, for one
 * environment), held to their shape, and the scripts that check the build's artifact and write
 * the lane's rows and issues, on fixtures.
 *
 * `laneProblems` is the shape, as a list of what is wrong, so each mutation the plan names is a
 * case below that changes a copy of the parsed workflows and must name its problem: a guard that
 * can't fail is no guard (`K-PRIN-11`).
 */

const WF = '.github/workflows';
const RELEASE = 'deploy-release.yml';
const ENV = 'deploy.yml';
const LANE = [RELEASE, ENV];

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; 'continue-on-error'?: boolean | string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = {
  name?: string; 'timeout-minutes'?: number; needs?: string | string[]; if?: string; uses?: string; environment?: unknown; permissions?: Record<string, string> | string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean; queue?: string } | string; steps?: Step[]; secrets?: unknown; with?: Record<string, unknown>; outputs?: Record<string, string>;
};
type Workflow = { on?: { workflow_call?: { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> } }; permissions?: unknown; jobs: Record<string, Job> };

const PARSED: Record<string, Workflow> = Object.fromEntries(readdirSync(WF).filter((f) => /\.ya?ml$/.test(f))
  .map((f) => [f, parse(readFileSync(join(WF, f), 'utf8')) as Workflow]));
const load = () => structuredClone(PARSED);
const job = (w: Record<string, Workflow>, file: string, name: string): Job => {
  const j = w[file]?.jobs[name];
  if (!j) throw new Error(`${file} has no job ${name}: the mutation would pass for the wrong reason`);
  return j;
};
const step = (j: Job, id: string): Step => {
  const s = (j.steps ?? []).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const MODEL = /agent-run|claude-code-action|create-github-app-token|secrets\s*(?:\.|\[\s*['"])(?:CLAUDE_|ANTHROPIC_|[A-Za-z0-9_-]*PRIVATE_KEY)/i;
const SECRET = /secrets\s*(?:\.\s*([A-Za-z0-9_-]+)|\[)/g;
const isCheckout = (s: Step) => String(s.uses ?? '').startsWith('actions/checkout@');
const grants = (j: Job) => (typeof j.permissions === 'object' ? j.permissions : {});
const ALLOWED_SECRET = '${{ secrets.KANON_DEPLOY_SECRET }}';
/** The announcement's secret (plan 0011 N9): an optional `workflow_call` secret of deploy.yml, read by its `notify` step alone. */
const CHAT_SECRET = '${{ secrets.KANON_CHAT_DEPLOY }}';
/**
 * deploy.yml's two declared secrets, exactly, both optional: the announcement's, and the deploy
 * hook's, which the caller maps as `${{ secrets.KANON_DEPLOY_SECRET }}` so that GitHub resolves it
 * in the deploy job's scope, the environment's first (kanon#1049: undeclared or unmapped, it is empty).
 */
const DECLARED = {
  KANON_CHAT_DEPLOY: { description: 'Where the adopter\'s notify hook posts this environment\'s deploy announcement. Optional.', required: false },
  KANON_DEPLOY_SECRET: { description: 'The deploy hook\'s secret, the environment\'s own, which the caller maps by the same name. Optional.', required: false },
};

/** Everything wrong with the lane's shape, by file, job and step. */
export function laneProblems(w: Record<string, Workflow>): string[] {
  const out: string[] = [];
  for (const file of LANE) {
    const wf = w[file];
    if (!wf) { out.push(`${file} is missing`); continue; }
    if (JSON.stringify(wf.permissions) !== '{}') out.push(`${file}: the workflow grants something at the top`);
    // deploy.yml declares two secrets, the announcement's and the deploy hook's, both optional; deploy-release.yml none.
    const declared = wf.on?.workflow_call?.secrets;
    if (file === ENV ? JSON.stringify(declared) !== JSON.stringify(DECLARED) : declared !== undefined) out.push(`${file}: declares secrets its caller would map, beyond KANON_CHAT_DEPLOY and KANON_DEPLOY_SECRET, optional, in deploy.yml`);
    if (/\bvars\./.test(JSON.stringify(wf))) out.push(`${file}: reads a repository variable: where the hook finds each role is the hook's`);
    for (const [name, j] of Object.entries(wf.jobs)) {
      const at = `${file}:${name}`;
      // No model in the deploy path (§9).
      if (MODEL.test(JSON.stringify(j))) out.push(`${at}: runs a model or holds an App key or a Claude credential`);
      // The only secret: KANON_DEPLOY_SECRET in the deploy hook step's env of deploy.yml's deploy job.
      const { steps = [], ...rest } = j;
      if ([...JSON.stringify(rest).matchAll(SECRET)].length) out.push(`${at}: references a secret outside a step`);
      for (const s of steps) {
        const refs = [...JSON.stringify(s).matchAll(SECRET)];
        if (!refs.length) continue;
        const here = file === ENV && name === 'deploy' && s.id === 'deploy';
        const only = here && refs.length === 1 && s.env?.KANON_DEPLOY_SECRET === ALLOWED_SECRET;
        // …and deploy.yml's notify step, the block, handed KANON_CHAT_DEPLOY as its `secret` (plan 0011 N9).
        const post = file === ENV && name === 'notify' && s.id === 'notify' && refs.length === 1 && s.uses === '$/actions/notify' && s.with?.secret === CHAT_SECRET && !s.env;
        if (!only && !post) out.push(`${at}:${s.id ?? s.name ?? s.uses}: references a secret; only deploy.yml's deploy hook step may, KANON_DEPLOY_SECRET in its env:, and its notify step, KANON_CHAT_DEPLOY as the block's secret`);
      }
      // Grants.
      const g = grants(j);
      const holdsIdToken = g['id-token'] === 'write' || j.permissions === 'write-all';
      const idTokenJob = (file === RELEASE && name === 'probe') || (file === ENV && name === 'deploy');
      if (holdsIdToken !== idTokenJob) out.push(`${at}: ${holdsIdToken ? 'holds' : 'lacks'} id-token: write; only deploy-release.yml's probe and deploy.yml's deploy hold it`);
      const writes = Object.entries(g).filter(([k, v]) => v === 'write' && k !== 'id-token').map(([k]) => k);
      const isReport = name === 'report';
      if (isReport ? JSON.stringify(writes) !== '["issues"]' : writes.length) out.push(`${at}: grants ${writes.join(', ') || 'no write'}; each report job alone holds issues: write`);
      if (j.permissions === undefined || typeof j.permissions === 'string') out.push(`${at}: declares no permissions block of its own`);
      if (name === 'record' && JSON.stringify(g) !== '{"actions":"read"}') out.push(`${at}: the record job holds more than actions: read`);
      if (isReport && j.if !== 'always()') out.push(`${at}: the report job runs on \`${j.if ?? 'success()'}\`, not always(), so a success can't close the issue`);
      if (isReport && steps.some(isCheckout)) out.push(`${at}: the report job checks out`);
      for (const s of steps.filter(isCheckout)) {
        if (s.with?.['persist-credentials'] !== false) out.push(`${at}: a checkout persists its credential`);
      }
      // Kanon declares no environment: only the environment job sets one, from the declaration.
      if (j.environment !== undefined && !(file === ENV && name === 'deploy')) out.push(`${at}: sets an environment`);
    }
  }
  const dep = w[ENV]?.jobs.deploy;
  if (dep) {
    const c = typeof dep.concurrency === 'object' ? dep.concurrency : {};
    if (!String(c.group ?? '').includes('${{ inputs.environment }}')) out.push(`${ENV}:deploy: the concurrency group is not one per environment`);
    if (c['cancel-in-progress'] !== false) out.push(`${ENV}:deploy: a newer run could cancel a deploy in progress`);
    if (c.queue !== 'max') out.push(`${ENV}:deploy: the queue keeps one pending deploy, so a newer one cancels it`);
    if (dep.environment !== '${{ needs.declare.outputs.environment }}') out.push(`${ENV}:deploy: the environment is not the declaration's (none under no-environments)`);
    const hook = (dep.steps ?? []).find((s) => s.uses === './.github/actions/deploy');
    if (hook?.with?.role !== '${{ needs.declare.outputs.role }}') out.push(`${ENV}:deploy: the role is not the one the declaration derives`);
    if (hook?.with?.probe !== 'false') out.push(`${ENV}:deploy: the deploy hook is not told it deploys`);
    if (dep.if !== "needs.declare.outputs.held == 'false'") out.push(`${ENV}:deploy: runs when declare holds production (kanon#894)`);
    // The deploy job's own Maintainer check, which a "Re-run failed jobs" re-runs (#906's review).
    const check = (dep.steps ?? []).find((s) => s.id === 'supersede');
    if (check?.env?.FALLBACK !== '${{ needs.declare.outputs.fallback }}' || check?.env?.ROLE !== '${{ needs.declare.outputs.role }}') {
      out.push(`${ENV}:deploy: the deploy job's own check isn't handed the fallback and the role, so a re-run skips the Maintainer check`);
    }
    if (dep.outputs?.unauthorized !== '${{ steps.supersede.outputs.unauthorized }}') out.push(`${ENV}:deploy: doesn't output its Maintainer refusal for record and report`);
    // #904: the step runs the check, judges the runner's own actors (never ones the workflow sets),
    // and stands before the build is read and the deploy hook runs.
    if (!/deploy-gate\.mjs" supersede$/.test(String(check?.run ?? '').trim())) out.push(`${ENV}:deploy: the deploy job's own check doesn't run \`deploy-gate.mjs supersede\``);
    if (Object.keys(check?.env ?? {}).some((k) => /^GITHUB_(TRIGGERING_)?ACTOR$/.test(k))) out.push(`${ENV}:deploy: the deploy job's own check is handed an actor instead of the runner's`);
    const at = (id: string) => (dep.steps ?? []).findIndex((s) => s.id === id);
    if (at('supersede') < 0 || at('supersede') > at('build-input') || at('supersede') > at('deploy')) out.push(`${ENV}:deploy: the Maintainer check runs after the build is read or the deploy hook runs`);
    // A refusal stops the job (#995's review): the check itself runs unconditionally and fails the
    // job, and no step from it up to the deploy hook runs after a failure. A status function in
    // an `if:` (`always()`, `!cancelled()`, `failure()`) passes only when the step is also gated on
    // an earlier gated step's success, as `build-check` is on `build-input`, which a refusal skips.
    if (check && (check.if !== undefined || (check['continue-on-error'] !== undefined && check['continue-on-error'] !== false))) {
      out.push(`${ENV}:deploy: the Maintainer check carries an \`if:\` or \`continue-on-error\`, so a refusal may not stop the job`);
    }
    if (at('supersede') >= 0 && at('deploy') > at('supersede')) {
      const gated = new Set<string>();
      for (const s of (dep.steps ?? []).slice(at('supersede') + 1, at('deploy') + 1)) {
        const cond = String(s.if ?? '');
        const statusFn = /\b(always|cancelled|failure)\s*\(\s*\)/.test(cond);
        const onSuccessOf = [...cond.matchAll(/steps\.([A-Za-z0-9_-]+)\.(?:outcome|conclusion)\s*==\s*'success'/g)].map((m) => m[1]!);
        const safe = !statusFn || (/&&/.test(cond) && !/\|\|/.test(cond) && onSuccessOf.some((id) => gated.has(id)));
        if (!safe) out.push(`${ENV}:deploy:${s.id ?? s.name ?? s.uses}: can run after the Maintainer check failed (\`if: ${cond}\`)`);
        else if (s.id) gated.add(s.id);
        if (s['continue-on-error'] !== undefined && s['continue-on-error'] !== false) out.push(`${ENV}:deploy:${s.id ?? s.name ?? s.uses}: continues on error before the deploy hook`);
      }
    }
  }
  out.push(...smokeProblems(w));
  const declare = w[ENV]?.jobs.declare;
  if (declare && JSON.stringify(declare.permissions) !== '{"contents":"read"}') out.push(`${ENV}:declare: holds more than contents: read`);
  const inputs = Object.keys(w[ENV]?.on?.workflow_call?.inputs ?? {}).sort();
  if (JSON.stringify(inputs) !== '["build","environment","position"]') out.push(`${ENV}: takes ${inputs.join(', ')}, not the environment, its position and the build alone`);
  out.push(...buildProblems(w));
  if (/inputs\.role\b/.test(JSON.stringify(w[ENV] ?? {}))) out.push(`${ENV}: reads a role from its caller`);
  // The gate's CI wait ends inside its job (#912): the longest wait and the margin for the setup,
  // checks 1 to 3 and the last poll (several polls' worth), all within the job's limit, so a CI that
  // never finishes is refused `ci-timeout`, which is filed, never cancelled, which files nothing.
  const limit = w[RELEASE]?.jobs.gate?.['timeout-minutes'];
  if (typeof limit !== 'number' || CI_WAIT_CEILING + GATE_MARGIN_MINUTES > limit || GATE_MARGIN_MINUTES * 60_000 < 5 * CI_POLL_MS) {
    out.push(`${RELEASE}:gate: its timeout-minutes (${limit}) can end the CI wait (up to ${CI_WAIT_CEILING} minutes, after the setup) in a cancellation instead of \`ci-timeout\``);
  }
  const probe = w[RELEASE]?.jobs.probe;
  if (probe) {
    if (probe.if !== "needs.gate.outputs.fallback != 'no-environments'") out.push(`${RELEASE}:probe: runs under the no-environments marker`);
    // A refused gate (a dispatch away from its release's tag among its refusals, #914) stops the
    // probe: it needs the gate and its `if:` has no status function that would run it anyway.
    if (JSON.stringify(probe.needs) !== '"gate"' || /always\(\)|failure\(\)|cancelled\(\)/.test(String(probe.if))) out.push(`${RELEASE}:probe: can run after a refused gate`);
    const hook = (probe.steps ?? []).find((s) => s.uses === './.github/actions/deploy');
    if (hook?.with?.probe !== 'true' || hook?.with?.environments !== '${{ needs.gate.outputs.environments }}') out.push(`${RELEASE}:probe: doesn't run the deploy hook as a probe of the declared list`);
    if ((probe.steps ?? []).findIndex((s) => s.id === 'judge') < (probe.steps ?? []).indexOf(hook!)) out.push(`${RELEASE}:probe: judges before the hook answers`);
  }
  // Nothing else in Kanon calls the lane or sets an environment (the placement decision).
  for (const [file, wf] of Object.entries(w)) {
    if (LANE.includes(file)) continue;
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      if (/\.github\/workflows\/deploy(-release)?\.yml/.test(String(j.uses ?? ''))) out.push(`${file}:${name}: calls the deploy lane, which Kanon's own repository never does`);
      if (j.environment !== undefined) out.push(`${file}:${name}: sets an environment, which Kanon's own repository declares none of`);
    }
  }
  return out;
}

// ── Live, smoke failed (plan 0013 §6, §7.1, step S4) ──────────────────────────────────────

const RESET_HOOK = '.github/actions/smoke-reset/action.yml';

/** Everything wrong with the reset and smoke steps and the `verdict` job. */
function smokeProblems(w: Record<string, Workflow>): string[] {
  const out: string[] = [];
  const dep = w[ENV]?.jobs.deploy;
  if (!dep) return out;
  const ds = dep.steps ?? [];
  const reset = ds.find((s) => s.uses === './.github/actions/smoke-reset');
  const smoke = ds.find((s) => s.uses === './.github/actions/smoke');
  for (const [name, s] of [['reset', reset], ['smoke', smoke]] as const) {
    if (!s) { out.push(`${ENV}:deploy: has no ${name} step`); continue; }
    if (s['continue-on-error'] !== true) out.push(`${ENV}:deploy:${name}: doesn't continue on error, so a failed ${name} fails the deploy job and GitHub marks a live release's deployment failed`);
    if (s.id !== name) out.push(`${ENV}:deploy:${name}: isn't the step \`${name}\`, whose outcome the job outputs`);
    if (JSON.stringify(s.env) !== '{"KANON_SMOKE_TRIGGER":"deploy"}') out.push(`${ENV}:deploy:${name}: isn't handed KANON_SMOKE_TRIGGER=deploy, and nothing else`);
  }
  if (reset && String(reset.if ?? '') !== `hashFiles('${RESET_HOOK}') != ''`) out.push(`${ENV}:deploy:reset: runs whether or not the reset hook exists`);
  if (smoke && String(smoke.if ?? '') !== "steps.reset.outcome != 'failure'") out.push(`${ENV}:deploy:smoke: runs after a failed reset, on data in an unknown state`);
  if (reset && smoke && ds.indexOf(reset) > ds.indexOf(smoke)) out.push(`${ENV}:deploy: the reset runs after the smoke check`);
  if (dep.outputs?.['reset-outcome'] !== '${{ steps.reset.outcome }}' || dep.outputs?.['smoke-outcome'] !== '${{ steps.smoke.outcome }}') out.push(`${ENV}:deploy: doesn't output the reset's and the smoke check's outcomes`);
  const v = w[ENV]?.jobs.verdict;
  if (!v) return [...out, `${ENV}: has no verdict job, so a failed smoke check no longer stops the chain`];
  if (JSON.stringify(v.needs) !== '"deploy"' || v.if !== 'always()') out.push(`${ENV}:verdict: doesn't run after the deploy job, whatever it concluded`);
  if (JSON.stringify(v.permissions) !== '{}') out.push(`${ENV}:verdict: holds a permission`);
  const vs = v.steps ?? [];
  if (vs.length !== 1 || vs[0]!.uses !== undefined || vs[0]!.env?.RESET !== '${{ needs.deploy.outputs.reset-outcome }}' || vs[0]!.env?.SMOKE !== '${{ needs.deploy.outputs.smoke-outcome }}') out.push(`${ENV}:verdict: isn't one step reading the reset's and the smoke check's outcomes`);
  for (const [name, j] of Object.entries(w[ENV]?.jobs ?? {})) {
    if (([] as string[]).concat(j.needs ?? []).includes('verdict')) out.push(`${ENV}:${name}: waits for the verdict, which fails on a live release`);
  }
  return out;
}

// ── The build (plan 0010 decision 8, step D5) ─────────────────────────────────────────────

type Needed = Record<string, { result: string; outputs?: Record<string, string> }>;
/** A step's place in its job, for `jobRuns` reading a step's `if:`: the steps so far, whether one failed the job, and the checkout's files. */
type StepContext = { steps: Record<string, { outcome: string; conclusion: string; outputs: Record<string, string> }>; failed: boolean; files: string[] };

/**
 * Whether a job whose `if:` is `expression` runs, given its needed jobs' results and outputs, as
 * GitHub decides it: an `if:` that calls no status function has `success()` ANDed in, and
 * `success()` holds only when every needed job succeeded. It reads `needs.<job>.result`,
 * `needs.<job>.outputs.<name>`, strings, `==`, `!=`, `!`, `&&`, `||` and the four status
 * functions; anything else throws, so a new `if:` can't pass for a reason this doesn't read.
 */
export function jobRuns(expression: string | undefined, needs: Needed, runCancelled = false, ctx?: StepContext): boolean {
  let text = String(expression ?? '').trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
  // A step's `hashFiles('<path>')`: non-empty when the file is in the checkout (`ctx.files`).
  text = text.replace(/hashFiles\('([^']*)'\)/g, (_m, path: string) => (ctx?.files.includes(path) ? "'digest'" : "''"));
  if (!/\b(?:always|success|failure|cancelled)\s*\(/.test(text)) text = text ? `success() && (${text})` : 'success()';
  const tokens = [...text.matchAll(/\s*('(?:[^']|'')*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.-]*)/g)].map((m) => m[1]!);
  if (tokens.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) throw new Error(`can't read ${text}`);
  let i = 0;
  const results = Object.values(needs).map((n) => n.result);
  const value = (t: string): string | boolean => {
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    const st = /^steps\.([\w-]+)\.(outcome|conclusion|outputs\.([\w-]+))$/.exec(t);
    if (st && ctx) {
      const done = ctx.steps[st[1]!];
      if (!done) return '';
      return st[2] === 'outputs.' + st[3] ? done.outputs[st[3]!] ?? '' : done[st[2] as 'outcome' | 'conclusion'];
    }
    const m = /^needs\.([\w-]+)\.(result|outputs\.([\w-]+))$/.exec(t);
    if (!m) throw new Error(`can't read ${t}`);
    const n = needs[m[1]!];
    if (!n) throw new Error(`${m[1]} isn't needed`);
    return m[2] === 'result' ? n.result : n.outputs?.[m[3]!] ?? '';
  };
  const primary = (): string | boolean => {
    const t = tokens[i++]!;
    if (t === '(') { const v = or(); if (tokens[i++] !== ')') throw new Error('expected )'); return v; }
    if (t === '!') return !truthy(primary());
    if (tokens[i] === '(') {
      i += 2;
      if (t === 'always') return true;
      if (t === 'cancelled') return runCancelled;
      // Inside a job (`ctx`), the status functions read the job's own steps so far.
      if (t === 'success') return !runCancelled && (ctx ? !ctx.failed : results.every((r) => r === 'success'));
      if (t === 'failure') return ctx ? ctx.failed : results.some((r) => r === 'failure');
      throw new Error(`can't call ${t}`);
    }
    const left = value(t);
    const op = tokens[i];
    if (op !== '==' && op !== '!=') return left;
    i += 1;
    const right = value(tokens[i++]!);
    return (String(left).toLowerCase() === String(right).toLowerCase()) === (op === '==');
  };
  const truthy = (v: string | boolean) => v !== '' && v !== false;
  const and = (): boolean => { let v = truthy(primary()); while (tokens[i] === '&&') { i += 1; v = truthy(primary()) && v; } return v; };
  const or = (): boolean => { let v = and(); while (tokens[i] === '||') { i += 1; v = and() || v; } return v; };
  const result = or();
  if (i !== tokens.length) throw new Error(`trailing ${tokens.slice(i).join(' ')}`);
  return result;
}

const BUILD_HOOK = './.github/actions/build';
const BUILD_NAME = 'kanon-deploy-build-${{ github.run_id }}-${{ github.run_attempt }}';
/** The gate's and the probe's results, as the build job's `if:` reads them. */
const gateProbe = (gate: string, probe: string, fallback = '') => ({ gate: { result: gate, outputs: { fallback } }, probe: { result: probe, outputs: {} } });

/** Everything wrong with the build job and the environments' use of its artifact. */
function buildProblems(w: Record<string, Workflow>): string[] {
  const out: string[] = [];
  const rel = w[RELEASE];
  const b = rel?.jobs.build;
  if (!b) return [`${RELEASE}: has no build job`];
  const at = `${RELEASE}:build`;
  if (JSON.stringify(b.permissions) !== '{"contents":"read"}') out.push(`${at}: holds more than contents: read`);
  if (JSON.stringify(b.needs) !== '["gate","probe"]') out.push(`${at}: doesn't need the gate and the probe`);
  // Its `if:`, on each way the gate and the probe can end.
  const runsOn = (needs: Needed, cancelled = false) => { try { return jobRuns(b.if, needs, cancelled); } catch { return undefined; } };
  if (runsOn(gateProbe('success', 'success')) !== true) out.push(`${at}: doesn't run after a gate and a probe that passed`);
  if (runsOn(gateProbe('success', 'skipped', 'no-environments')) !== true) out.push(`${at}: skipped under the no-environments marker, so no environment deploys`);
  for (const probe of ['failure', 'cancelled']) if (runsOn(gateProbe('success', probe)) !== false || runsOn(gateProbe('success', probe, 'no-environments')) !== false) out.push(`${at}: runs after a ${probe === 'failure' ? 'failed' : 'cancelled'} probe`);
  if (runsOn(gateProbe('success', 'skipped', 'no-reviewers')) !== false || runsOn(gateProbe('success', 'skipped')) !== false) out.push(`${at}: runs after a probe skipped without the no-environments marker`);
  for (const gate of ['failure', 'cancelled', 'skipped']) if (runsOn(gateProbe(gate, 'skipped', 'no-environments')) !== false) out.push(`${at}: runs after a ${gate} gate`);
  if (runsOn(gateProbe('success', 'success'), true) !== false) out.push(`${at}: runs in a cancelled run`);
  // Its steps: the release's commit, the hook, the digest, then the one upload.
  const steps = b.steps ?? [];
  const hookAt = steps.findIndex((s) => s.uses === BUILD_HOOK);
  const hook = steps[hookAt];
  if (!hook) out.push(`${at}: doesn't run the build hook`);
  else if (JSON.stringify(Object.keys(hook.with ?? {})) !== '["release","sha","output"]' || hook.with?.sha !== '${{ needs.gate.outputs.sha }}' || hook.with?.output !== '${{ runner.temp }}/kanon-deploy-artifact') out.push(`${at}: the build hook isn't given the release, its commit and the directory to fill`);
  const checkout = steps.find(isCheckout);
  if (checkout?.with?.ref !== '${{ needs.gate.outputs.sha }}') out.push(`${at}: doesn't build the release's commit, the gate's`);
  const digestAt = steps.findIndex((s) => s.id === 'digest');
  const uploads = steps.filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
  const uploadAt = steps.indexOf(uploads[0]!);
  if (digestAt < 0 || !/deploy-build\.mjs" digest$/.test(String(steps[digestAt]!.run)) || digestAt < hookAt || uploadAt < digestAt) out.push(`${at}: doesn't digest the build after the hook and before the upload`);
  if (uploads.length !== 1) out.push(`${at}: uploads ${uploads.length} artifacts, not one`);
  const up = uploads[0]?.with ?? {};
  if (up.name !== BUILD_NAME || up.path !== '${{ runner.temp }}/kanon-deploy-artifact') out.push(`${at}: the artifact isn't the run-scoped ${BUILD_NAME}`);
  if (up['retention-days'] !== 35) out.push(`${at}: the artifact isn't kept 35 days, so a production approval can outlive it`);
  if (up['include-hidden-files'] !== true) out.push(`${at}: the upload drops hidden files the digest counts`);
  if (b.outputs?.build !== '${{ steps.digest.outputs.build }}') out.push(`${at}: doesn't output the build with its digest`);
  const callOut = (rel?.on?.workflow_call as { outputs?: Record<string, { value?: string }> } | undefined)?.outputs?.build?.value;
  if (callOut !== '${{ jobs.build.outputs.build }}') out.push(`${RELEASE}: doesn't publish the build's output to its caller`);
  for (const name of ['record', 'report']) {
    if (!([] as string[]).concat(rel?.jobs[name]?.needs ?? []).includes('build')) out.push(`${RELEASE}:${name}: doesn't read the build's result, so a failed build is never recorded`);
  }
  // The environment's job: this run's artifact, by name, checked before the deploy hook. Never built there.
  for (const [file, wf] of Object.entries(w)) {
    if (!LANE.includes(file)) continue;
    for (const [name, j] of Object.entries(wf.jobs)) {
      if (!(file === RELEASE && name === 'build') && (j.steps ?? []).some((s) => s.uses === BUILD_HOOK)) out.push(`${file}:${name}: runs the build hook`);
    }
  }
  const dep = w[ENV]?.jobs.deploy;
  const ds = dep?.steps ?? [];
  const idx = (id: string) => ds.findIndex((s) => s.id === id);
  const input = ds[idx('build-input')];
  const download = ds[idx('download')];
  const check = ds[idx('build-check')];
  const deployAt = idx('deploy');
  if (input?.env?.BUILD !== '${{ inputs.build }}' || !/deploy-build\.mjs" input$/.test(String(input?.run))) out.push(`${ENV}:deploy: doesn't read the build from its input`);
  if (!String(download?.uses ?? '').startsWith('actions/download-artifact@') || download?.with?.name !== '${{ steps.build-input.outputs.artifact }}' || download?.with?.path !== '${{ runner.temp }}/kanon-deploy-artifact') out.push(`${ENV}:deploy: doesn't download the build's artifact by its run-scoped name`);
  // A "Re-run failed jobs" reuses attempt 1's build output and its artifact, `…-1` (measured on
  // #940): a name rebuilt from the attempt would look for one that was never uploaded.
  // The announcement's message artifact carries its own job's attempt, as every producer's does (plan 0011 §4).
  const unattempted = JSON.stringify(w[ENV] ?? {})
    .replace(/kanon-deploy-row-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g, '')
    .replace(/kanon-notify-deploy-announce-\$\{\{ inputs\.position \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g, '')
    .replace(/format\('kanon-notify-deploy-announce-\{0\}-\{1\}-\{2\}', inputs\.position, github\.run_id, github\.run_attempt\)/g, '');
  if (/run_attempt/.test(unattempted)) out.push(`${ENV}: rebuilds the build's artifact name from the run attempt, so a re-run of the failed jobs misses attempt 1's artifact`);
  if (!/deploy-build\.mjs" check$/.test(String(check?.run)) || check?.env?.DIGEST !== '${{ steps.build-input.outputs.digest }}') out.push(`${ENV}:deploy: doesn't check the build's digest`);
  if (!(idx('build-input') < idx('download') && idx('download') < idx('build-check') && idx('build-check') < deployAt) || idx('build-input') < 0) out.push(`${ENV}:deploy: the deploy hook can run before the build is checked`);
  if (ds[deployAt]?.with?.artifact !== '${{ steps.build-check.outputs.path }}') out.push(`${ENV}:deploy: the deploy hook isn't given the checked build`);
  const failed = String(dep?.outputs?.['build-failed'] ?? '');
  if (!['build-input', 'download', 'build-check'].every((id) => failed.includes(`steps.${id}.outcome == 'failure'`))) out.push(`${ENV}:deploy: a failed download or check isn't output for the record's \`build\` stage`);
  return out;
}

const mutate = (change: (w: Record<string, Workflow>) => void) => {
  const w = load();
  change(w);
  return laneProblems(w);
};

describe('the deploy lane holds its shape', () => {
  it('has no problem as shipped', () => {
    expect(laneProblems(load())).toEqual([]);
  });

  it('reads the jobs it is about, so the checks are not vacuous', () => {
    expect(Object.keys(PARSED[RELEASE]!.jobs)).toEqual(['gate', 'probe', 'build', 'record', 'report']);
    expect(Object.keys(PARSED[ENV]!.jobs)).toEqual(['declare', 'deploy', 'verdict', 'record', 'report', 'announce', 'notify']);
    // The run lists the environment's job as `<caller job> / deploy` (kanon#890), which the reference deploy names.
    expect(PARSED[ENV]!.jobs.deploy!.name).toBe('deploy');
    expect(step(PARSED[ENV]!.jobs.deploy!, 'deploy').env).toEqual({ KANON_DEPLOY_SECRET: ALLOWED_SECRET });
  });

  it('every checkout of the two workflows persists no credential, and checks out the release commit the gate or the declaration resolved', () => {
    const checkouts = LANE.flatMap((f) => Object.values(PARSED[f]!.jobs).flatMap((j) => (j.steps ?? []).filter(isCheckout)));
    expect(checkouts).toHaveLength(4);
    // The probe's and the build's: the gate's commit, which on a dispatch is the one the release's tag resolves to.
    // The announcement's: the notify hook's directory alone, at the run's commit, where the notify block reads the hook (plan 0011 decision 8).
    expect(checkouts.map((s) => s.with?.ref)).toEqual(['${{ needs.gate.outputs.sha }}', '${{ needs.gate.outputs.sha }}', '${{ needs.declare.outputs.sha }}', undefined]);
    expect(checkouts[3]!.with).toEqual({ 'persist-credentials': false, 'sparse-checkout': '.github/actions/notify' });
  });

  it('the hooks get the inputs plan 0010 §7 and plan 0013 §6 list, and the reset and smoke hooks never the secret, only the trigger', () => {
    const dep = PARSED[ENV]!.jobs.deploy!;
    const hooks = (dep.steps ?? []).filter((s) => String(s.uses ?? '').startsWith('./'));
    expect(hooks.map((s) => [s.uses, Object.keys(s.with ?? {})])).toEqual([
      ['./.github/actions/deploy', ['environment', 'role', 'release', 'sha', 'artifact', 'probe', 'environments']],
      ['./.github/actions/smoke-reset', ['environment', 'role', 'release']],
      ['./.github/actions/smoke', ['environment', 'role', 'release']],
    ]);
    // Neither the reset's step nor the smoke's references KANON_DEPLOY_SECRET, or any secret.
    for (const h of hooks.slice(1)) {
      expect(h.env).toEqual({ KANON_SMOKE_TRIGGER: 'deploy' });
      expect(JSON.stringify(h)).not.toMatch(/secrets\.|KANON_DEPLOY_SECRET/);
    }
    const build = (PARSED[RELEASE]!.jobs.build!.steps ?? []).filter((s) => String(s.uses ?? '').startsWith('./'));
    expect(build.map((s) => [s.uses, Object.keys(s.with ?? {})])).toEqual([[BUILD_HOOK, ['release', 'sha', 'output']]]);
    expect(build[0]!.env).toBeUndefined();
  });

  it('the build runs after the gate and the probe, or after the gate alone when the probe is skipped under the `no-environments` marker, and never after a failed or cancelled probe', () => {
    const b = PARSED[RELEASE]!.jobs.build!;
    expect(jobRuns(b.if, gateProbe('success', 'success'))).toBe(true);
    // The no-environments fixture: the probe skipped under the marker, the build runs, the
    // workflow call succeeds, so the caller's environment calls run, and `record` writes no row.
    expect(jobRuns(b.if, gateProbe('success', 'skipped', 'no-environments'))).toBe(true);
    expect(releaseRow({ ...RUN, NEEDS: JSON.stringify({ ...gateProbe('success', 'skipped', 'no-environments'), build: { result: 'success', outputs: {} } }), ENVIRONMENTS: 'production' })).toBeNull();
    for (const probe of ['failure', 'cancelled']) expect(jobRuns(b.if, gateProbe('success', probe, 'no-environments')), probe).toBe(false);
    expect(jobRuns(b.if, gateProbe('failure', 'skipped', 'no-environments'))).toBe(false);
    expect(jobRuns(b.if, gateProbe('success', 'skipped', 'no-reviewers'))).toBe(false);
    // GitHub's own rule, which the `if:` exists to override: without one, a skipped need skips the job.
    expect(jobRuns(undefined, gateProbe('success', 'skipped', 'no-environments'))).toBe(false);
    // It holds no credential, no secret, no environment.
    expect(b.permissions).toEqual({ contents: 'read' });
    expect(b.environment).toBeUndefined();
    expect(JSON.stringify(b)).not.toMatch(/secrets|id-token/);
  });

  describe('the mutations plan 0010 D4 names each turn it red', () => {
    const red = (change: (w: Record<string, Workflow>) => void, problem: RegExp) => {
      const found = mutate(change);
      expect(found.some((p) => problem.test(p)), `expected a problem matching ${problem}, got ${JSON.stringify(found)}`).toBe(true);
    };
    const conc = (w: Record<string, Workflow>) => job(w, ENV, 'deploy').concurrency as { group: string; 'cancel-in-progress': boolean; queue?: string };

    it('`cancel-in-progress: true` on deploy', () => red((w) => { conc(w)['cancel-in-progress'] = true; }, /could cancel a deploy in progress/));
    it('`queue` removed', () => red((w) => { delete conc(w).queue; }, /queue keeps one pending/));
    it('a fixed concurrency group shared by all environments', () => red((w) => { conc(w).group = 'kanon-deploy-${{ github.repository }}'; }, /not one per environment/));
    it('`id-token: write` on record', () => {
      red((w) => { (job(w, ENV, 'record').permissions as Record<string, string>)['id-token'] = 'write'; }, /deploy\.yml:record: holds id-token/);
      red((w) => { (job(w, RELEASE, 'record').permissions as Record<string, string>)['id-token'] = 'write'; }, /deploy-release\.yml:record: holds id-token/);
    });
    it('an `agent-run` step in report', () => red((w) => { job(w, ENV, 'report').steps!.push({ uses: '$/actions/agent-run' }); }, /report: runs a model/));
    it("report's `if:` narrowed to `failure()`", () => red((w) => { job(w, ENV, 'report').if = 'failure()'; }, /not always\(\), so a success can't close/));
    it('`role` read from a caller input', () => red((w) => {
      w[ENV]!.on!.workflow_call!.inputs!.role = { type: 'string', required: true };
      step(job(w, ENV, 'deploy'), 'deploy').with!.role = '${{ inputs.role }}';
    }, /role is not the one the declaration derives|reads a role from its caller/));
    it('`KANON_DEPLOY_SECRET` passed to the smoke step or the probe', () => {
      red((w) => { step(job(w, ENV, 'deploy'), 'smoke').env = { KANON_DEPLOY_SECRET: ALLOWED_SECRET }; }, /deploy\.yml:deploy:smoke: references a secret/);
      red((w) => { (job(w, RELEASE, 'probe').steps!.find((s) => s.uses === './.github/actions/deploy')!).env = { KANON_DEPLOY_SECRET: ALLOWED_SECRET }; }, /deploy-release\.yml:probe:.*references a secret/);
      red((w) => { (job(w, ENV, 'deploy') as Record<string, unknown>).env = { KANON_DEPLOY_SECRET: ALLOWED_SECRET }; }, /references a secret outside a step/);
    });
    it('`KANON_CHAT_DEPLOY` read anywhere but the notify step, or handed to it otherwise (plan 0011 N9)', () => {
      red((w) => { step(job(w, ENV, 'announce'), 'message').env!.URL = CHAT_SECRET; }, /deploy\.yml:announce:message: references a secret/);
      red((w) => { step(job(w, ENV, 'deploy'), 'deploy').env!.KANON_CHAT_DEPLOY = CHAT_SECRET; }, /deploy\.yml:deploy:deploy: references a secret/);
      red((w) => { step(job(w, ENV, 'notify'), 'notify').env = { SECRET: CHAT_SECRET }; }, /deploy\.yml:notify:notify: references a secret/);
      red((w) => { step(job(w, ENV, 'notify'), 'notify').with!.secret = ALLOWED_SECRET; }, /deploy\.yml:notify:notify: references a secret/);
      red((w) => { (job(w, ENV, 'notify') as Record<string, unknown>).env = { SECRET: CHAT_SECRET }; }, /deploy\.yml:notify: references a secret outside a step/);
    });
    it('a secret declared beyond the optional KANON_CHAT_DEPLOY and KANON_DEPLOY_SECRET, one dropped, or one made required (plan 0011 N9, kanon#1049)', () => {
      red((w) => { (w[ENV]!.on!.workflow_call!.secrets as Record<string, unknown>).KANON_OTHER = { required: false }; }, /deploy\.yml: declares secrets its caller would map/);
      red((w) => { delete (w[ENV]!.on!.workflow_call!.secrets as Record<string, unknown>).KANON_DEPLOY_SECRET; }, /deploy\.yml: declares secrets its caller would map/);
      red((w) => { (w[ENV]!.on!.workflow_call!.secrets as Record<string, { required: boolean }>).KANON_CHAT_DEPLOY!.required = true; }, /deploy\.yml: declares secrets its caller would map/);
      red((w) => { (w[ENV]!.on!.workflow_call!.secrets as Record<string, { required: boolean }>).KANON_DEPLOY_SECRET!.required = true; }, /deploy\.yml: declares secrets its caller would map/);
      red((w) => { w[RELEASE]!.on!.workflow_call!.secrets = structuredClone(DECLARED); }, /deploy-release\.yml: declares secrets its caller would map/);
    });
    it('a write, or an OIDC grant, on the announcement or its post', () => {
      red((w) => { (job(w, ENV, 'announce').permissions as Record<string, string>).deployments = 'write'; }, /deploy\.yml:announce: grants deployments/);
      red((w) => { (job(w, ENV, 'notify').permissions as Record<string, string>)['id-token'] = 'write'; }, /deploy\.yml:notify: holds id-token/);
    });
    it("the gate job's limit lowered under the CI wait plus its setup (#912)", () => {
      red((w) => { job(w, RELEASE, 'gate')['timeout-minutes'] = CI_WAIT_CEILING; }, /gate: its timeout-minutes \(345\) can end the CI wait/);
      red((w) => { job(w, RELEASE, 'gate')['timeout-minutes'] = CI_WAIT_CEILING + GATE_MARGIN_MINUTES - 1; }, /gate: its timeout-minutes/);
      red((w) => { delete job(w, RELEASE, 'gate')['timeout-minutes']; }, /gate: its timeout-minutes \(undefined\)/);
    });
    it('the probe run under the `no-environments` marker', () => red((w) => { delete job(w, RELEASE, 'probe').if; }, /runs under the no-environments marker/));
    it("the deploy job's own Maintainer check not handed the fallback or the role, or its refusal not output", () => {
      red((w) => { delete step(job(w, ENV, 'deploy'), 'supersede').env!.FALLBACK; }, /a re-run skips the Maintainer check/);
      red((w) => { delete step(job(w, ENV, 'deploy'), 'supersede').env!.ROLE; }, /a re-run skips the Maintainer check/);
      red((w) => { delete (job(w, ENV, 'deploy') as { outputs: Record<string, string> }).outputs.unauthorized; }, /doesn't output its Maintainer refusal/);
      red((w) => { (job(w, ENV, 'deploy') as { outputs: Record<string, string> }).outputs.unauthorized = '${{ steps.supersede.outputs.refusal }}'; }, /doesn't output its Maintainer refusal/);
      red((w) => { step(job(w, ENV, 'deploy'), 'supersede').env!.FALLBACK = "${{ needs.declare.outputs.fallback == 'no-environments' && 'no-environments' || '' }}"; }, /a re-run skips the Maintainer check/);
    });
    it("the deploy job's own Maintainer check skipped, handed an actor, or moved after the hook (#904)", () => {
      red((w) => { step(job(w, ENV, 'deploy'), 'supersede').run = 'node "$KANON/scripts/deploy-gate.mjs" declare'; }, /doesn't run `deploy-gate\.mjs supersede`/);
      red((w) => { step(job(w, ENV, 'deploy'), 'supersede').env!.GITHUB_TRIGGERING_ACTOR = '${{ github.actor }}'; }, /handed an actor instead of the runner's/);
      red((w) => { step(job(w, ENV, 'deploy'), 'supersede').env!.GITHUB_ACTOR = '${{ github.event.inputs.release }}'; }, /handed an actor instead of the runner's/);
      red((w) => {
        const steps = job(w, ENV, 'deploy').steps!;
        const [check] = steps.splice(steps.findIndex((s) => s.id === 'supersede'), 1);
        steps.push(check!);
      }, /Maintainer check runs after the build is read or the deploy hook runs/);
      red((w) => { const steps = job(w, ENV, 'deploy').steps!; steps.splice(steps.findIndex((s) => s.id === 'supersede'), 1); }, /Maintainer check runs after|a re-run skips the Maintainer check/);
    });
    it("a refusal by the deploy job's own check that doesn't stop the job (#995's review)", () => {
      red((w) => { step(job(w, ENV, 'deploy'), 'supersede')['continue-on-error'] = true; }, /Maintainer check carries an `if:` or `continue-on-error`/);
      red((w) => { step(job(w, ENV, 'deploy'), 'supersede').if = 'false'; }, /Maintainer check carries an `if:` or `continue-on-error`/);
      red((w) => { step(job(w, ENV, 'deploy'), 'deploy').if = 'always()'; }, /deploy:deploy: can run after the Maintainer check failed/);
      red((w) => { step(job(w, ENV, 'deploy'), 'build-input').if = '!cancelled()'; }, /deploy:build-input: can run after the Maintainer check failed/);
      red((w) => { step(job(w, ENV, 'deploy'), 'build-check').if = "always() || steps.build-input.outcome == 'success'"; }, /deploy:build-check: can run after the Maintainer check failed/);
      // Today's `build-check` (`!cancelled() && steps.build-input.outcome == 'success'`) is no problem.
      expect(laneProblems(load()).filter((p) => /Maintainer check failed/.test(p))).toEqual([]);
    });
    it('the probe run after a refused gate', () => {
      red((w) => { job(w, RELEASE, 'probe').if = "always() && needs.gate.outputs.fallback != 'no-environments'"; }, /can run after a refused gate|runs under the no-environments marker/);
      red((w) => { delete job(w, RELEASE, 'probe').needs; }, /can run after a refused gate/);
    });
    it('the deploy job run whatever `declare` holds', () => red((w) => { delete job(w, ENV, 'deploy').if; }, /runs when declare holds production/));
    it("the hold moved into the caller: a fallback input on deploy.yml", () => red((w) => { w[ENV]!.on!.workflow_call!.inputs!.fallback = { type: 'string' }; }, /not the environment, its position and the build alone/));
    it("a workflow calling `deploy.yml` added to Kanon's `.github/workflows/`", () => {
      red((w) => { w['ship.yml'] = { jobs: { prod: { uses: '$/.github/workflows/deploy.yml', with: { environment: 'production', position: 1 } } } }; }, /ship\.yml:prod: calls the deploy lane/);
      red((w) => { w['ship.yml'] = { jobs: { prod: { environment: 'production', steps: [] } } }; }, /ship\.yml:prod: sets an environment/);
    });
    it('a second id-token holder, a write grant, a persisted checkout, a variable read', () => {
      red((w) => { (job(w, RELEASE, 'gate').permissions as Record<string, string>)['id-token'] = 'write'; }, /gate: holds id-token/);
      red((w) => { (job(w, RELEASE, 'gate').permissions as Record<string, string>).contents = 'write'; }, /gate: grants contents/);
      red((w) => { (job(w, ENV, 'deploy').steps!.find(isCheckout)!).with!['persist-credentials'] = true; }, /persists its credential/);
      red((w) => { step(job(w, ENV, 'deploy'), 'deploy').with!.role = '${{ vars.DEPLOY_ROLE }}'; }, /reads a repository variable/);
      red((w) => { job(w, ENV, 'declare').environment = 'production'; }, /declare: sets an environment/);
    });
  });

  describe('the mutations plan 0013 S4 names each turn the shape red', () => {
    const red = (change: (w: Record<string, Workflow>) => void, problem: RegExp) => {
      const found = mutate(change);
      expect(found.some((p) => problem.test(p)), `expected a problem matching ${problem}, got ${JSON.stringify(found)}`).toBe(true);
    };
    it('`continue-on-error` left off the smoke step', () => red((w) => { delete step(job(w, ENV, 'deploy'), 'smoke')['continue-on-error']; }, /smoke: doesn't continue on error/));
    it('`continue-on-error` left off the reset step', () => red((w) => { delete step(job(w, ENV, 'deploy'), 'reset')['continue-on-error']; }, /reset: doesn't continue on error/));
    it('the verdict job dropped', () => red((w) => { delete w[ENV]!.jobs.verdict; }, /no verdict job/));
    it('the reset step run whether or not the hook exists', () => red((w) => { delete step(job(w, ENV, 'deploy'), 'reset').if; }, /whether or not the reset hook exists/));
    it('the smoke step run after a failed reset', () => red((w) => { delete step(job(w, ENV, 'deploy'), 'smoke').if; }, /after a failed reset/));
    it('`KANON_DEPLOY_SECRET` handed to the reset step', () => red((w) => { step(job(w, ENV, 'deploy'), 'reset').env!.KANON_DEPLOY_SECRET = ALLOWED_SECRET; }, /reset: references a secret/));
    it('a write on the verdict job', () => red((w) => { job(w, ENV, 'verdict').permissions = { issues: 'write' }; }, /verdict: holds a permission/));
  });

  describe('the mutations plan 0010 D5 names each turn it red', () => {
    const red = (change: (w: Record<string, Workflow>) => void, problem: RegExp) => {
      const found = mutate(change);
      expect(found.some((p) => problem.test(p)), `expected a problem matching ${problem}, got ${JSON.stringify(found)}`).toBe(true);
    };
    const bsteps = (w: Record<string, Workflow>) => job(w, RELEASE, 'build').steps!;
    const dsteps = (w: Record<string, Workflow>) => job(w, ENV, 'deploy').steps!;

    it('`id-token: write` on build', () => red((w) => { (job(w, RELEASE, 'build').permissions as Record<string, string>)['id-token'] = 'write'; }, /build: holds id-token/));
    it("`KANON_DEPLOY_SECRET` in build's `env:`", () => {
      red((w) => { (bsteps(w).find((s) => s.uses === BUILD_HOOK)!).env = { KANON_DEPLOY_SECRET: ALLOWED_SECRET }; }, /deploy-release\.yml:build:.*references a secret/);
      red((w) => { (job(w, RELEASE, 'build') as Record<string, unknown>).env = { KANON_DEPLOY_SECRET: ALLOWED_SECRET }; }, /build: references a secret outside a step/);
    });
    it('the digest check removed', () => {
      red((w) => { dsteps(w).splice(dsteps(w).findIndex((s) => s.id === 'build-check'), 1); }, /doesn't check the build's digest/);
      red((w) => { delete step(job(w, ENV, 'deploy'), 'build-check').env!.DIGEST; }, /doesn't check the build's digest/);
    });
    it('the build hook called in the environment job', () => red((w) => {
      dsteps(w).splice(dsteps(w).findIndex((s) => s.id === 'download'), 0, { uses: BUILD_HOOK, with: { release: 'x', sha: 'y', output: 'z' } });
    }, /deploy\.yml:deploy: runs the build hook/));
    it("the build's `if:` dropped (the no-environments fixture skips the build and every deploy)", () => red((w) => { delete job(w, RELEASE, 'build').if; }, /skipped under the no-environments marker/));
    it('a build that runs after a failed probe', () => {
      red((w) => { job(w, RELEASE, 'build').if = "${{ !cancelled() && needs.gate.result == 'success' }}"; }, /runs after a failed probe/);
      red((w) => { job(w, RELEASE, 'build').if = 'always()'; }, /runs after a failed probe/);
    });
    it("`record` writing a `probe` row for a probe skipped under the marker", () => {
      // The D4 classifier, which read any skipped probe as a stop: the no-environments fixture then records a stop at `probe`.
      const d4 = (n: { probe: { result: string } }) => (n.probe.result === 'success' ? null : { outcome: 'failed', failed_stage: 'probe' });
      const fixture = { ...gateProbe('success', 'skipped', 'no-environments'), build: { result: 'success', outputs: {} } };
      expect(d4(fixture)).toEqual({ outcome: 'failed', failed_stage: 'probe' });
      expect(classifyRelease(fixture)).toBeNull();
    });
    it('the upload kept less than 35 days, renamed off the run, or the build not published to the caller', () => {
      red((w) => { bsteps(w).find((s) => String(s.uses).startsWith('actions/upload-artifact@'))!.with!['retention-days'] = 7; }, /kept 35 days/);
      red((w) => { bsteps(w).find((s) => String(s.uses).startsWith('actions/upload-artifact@'))!.with!.name = 'kanon-deploy-build'; }, /run-scoped/);
      red((w) => { delete (w[RELEASE]!.on!.workflow_call as { outputs?: unknown }).outputs; }, /doesn't publish the build's output/);
      red((w) => { step(job(w, ENV, 'deploy'), 'download').with!.name = 'kanon-deploy-build'; }, /by its run-scoped name/);
    });
    it('the deploy hook run before the check, or not given the checked build', () => {
      red((w) => { const s = dsteps(w); const at = s.findIndex((x) => x.id === 'build-check'); const [c] = s.splice(at, 1); s.push(c!); }, /can run before the build is checked/);
      red((w) => { step(job(w, ENV, 'deploy'), 'deploy').with!.artifact = ''; }, /isn't given the checked build/);
    });
    it("the build's name rebuilt from `github.run_attempt` in the environment's job (a re-run of the failed jobs, #940)", () => {
      red((w) => { step(job(w, ENV, 'deploy'), 'download').with!.name = BUILD_NAME; }, /rebuilds the build's artifact name from the run attempt/);
      red((w) => { step(job(w, ENV, 'deploy'), 'build-input').env!.GITHUB_RUN_ATTEMPT = '${{ github.run_attempt }}'; }, /rebuilds the build's artifact name from the run attempt/);
    });
    it("`record` not reading the build's result", () => red((w) => { job(w, RELEASE, 'record').needs = ['gate', 'probe']; }, /record: doesn't read the build's result/));
  });
});

// ── The rows ──────────────────────────────────────────────────────────────────────────────

const ok = { result: 'success', outputs: {} };
const declared = (role = 'production') => ({ result: 'success', outputs: { role, prerelease: 'false', 'published-at': '2026-10-14T10:00:00Z', tag: 'v1.2.0', sha: 'a'.repeat(40) } });
const RUN = { GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'release', KANON_WORKFLOW_REF: 'yedeya-labs/kanon/.github/workflows/deploy.yml@refs/tags/v0.41.0', KANON_WORKFLOW_SHA: 'c'.repeat(40) };
const T = (m: number) => new Date(Date.UTC(2026, 9, 14, 11, m)).toISOString();

describe("deploy-row.mjs: one environment's row (plan 0010 §8, §10)", () => {
  const row = (deploy: object, opts: { approvals?: unknown, role?: string, position?: string } = {}) => environmentRow(
    { ...RUN, NEEDS: JSON.stringify({ declare: declared(opts.role), deploy }), ENVIRONMENT: 'staging', POSITION: opts.position ?? '1' },
    { now: new Date('2026-10-14T12:00:00Z'), api: (p: string) => (p.endsWith('/approvals') ? opts.approvals ?? [] : { run_started_at: T(0) }) },
  );

  it('writes one valid row for each way the job can end, with the role and position and never the name', () => {
    const cases: Array<[object, object]> = [
      [{ result: 'success', outputs: { 'started-at': T(10), 'deploy-started-at': T(11), 'deploy-ended-at': T(14), 'ended-at': T(15), redeploy: 'false', rollback: 'false' } }, { outcome: 'ok' }],
      [{ result: 'failure', outputs: { 'started-at': T(10), 'deploy-outcome': 'failure', 'smoke-outcome': 'skipped' } }, { outcome: 'failed', failed_stage: 'deploy' }],
      [{ result: 'failure', outputs: { 'started-at': T(10), 'deploy-ended-at': T(14), 'smoke-outcome': 'failure' } }, { outcome: 'smoke_failed', failed_stage: 'smoke' }],
      [{ result: 'failure', outputs: { 'started-at': T(10), refusal: 'superseded' } }, { outcome: 'refused', failed_stage: 'deploy', refusal: 'superseded' }],
      [{ result: 'cancelled', outputs: {} }, { outcome: 'cancelled', failed_stage: 'approval' }],
      [{ result: 'cancelled', outputs: { 'started-at': T(10) } }, { outcome: 'cancelled', failed_stage: 'deploy' }],
      [{ result: 'failure', outputs: {} }, { outcome: 'failed', failed_stage: 'approval' }],
    ];
    for (const [deploy, want] of cases) {
      const r = row(deploy);
      expect(r, JSON.stringify(deploy)).toMatchObject({ row_kind: 'deploy', role: 'production', position: 1, run_id: 123456, kanon_version: '0.41.0', trigger: 'release', ...want });
      expect(validate(r)).toEqual({ ok: true });
      expect(JSON.stringify(r)).not.toMatch(/staging|v1\.2\.0|a{40}|acme/);
    }
  });

  it("fails at `build` when the job's download or digest check failed, before any hook, and carries the build's time (plan 0010 D5)", () => {
    const failed = row({ result: 'failure', outputs: { 'started-at': T(10), 'build-failed': 'true', 'deploy-outcome': '', 'smoke-outcome': '' } });
    expect(failed).toMatchObject({ outcome: 'failed', failed_stage: 'build' });
    expect(validate(failed)).toEqual({ ok: true });
    // A deploy hook that failed after a good build is still `deploy`.
    expect(row({ result: 'failure', outputs: { 'started-at': T(10), 'build-failed': 'false', 'deploy-outcome': 'failure' } })).toMatchObject({ failed_stage: 'deploy' });
    const timed = environmentRow(
      { ...RUN, NEEDS: JSON.stringify({ declare: declared(), deploy: ok }), ENVIRONMENT: 'staging', POSITION: '1', BUILD: JSON.stringify({ artifact: 'kanon-deploy-build-123456-1', digest: 'f'.repeat(64), build_ms: 95_000 }) },
      { api: () => ({}) },
    );
    expect(timed).toMatchObject({ outcome: 'ok', build_ms: 95_000 });
    expect(JSON.stringify(timed)).not.toMatch(/kanon-deploy-build|f{64}/);
  });

  it('times the deploy: the wait, the hooks, the job and the release lead time', () => {
    const r = row({ result: 'success', outputs: { 'started-at': T(10), 'deploy-started-at': T(11), 'deploy-ended-at': T(14), 'ended-at': T(15) } });
    expect(r).toMatchObject({ wait_ms: 600_000, deploy_ms: 180_000, smoke_ms: 60_000, duration_ms: 300_000, since_release_ms: 75 * 60_000 });
  });

  it('records the declaration\'s role', () => {
    expect(row(ok, { role: 'pre-production', position: '1' })).toMatchObject({ role: 'pre-production', position: 1 });
  });

  it("records a refusal at the stage of the job that refused, not of its code: `declare`'s at `deploy` (kanon#886)", () => {
    // `declaration-mismatch`, `no-release` and `draft` are the gate's codes too, but here the
    // environment's `declare` job raised them, after the gate passed.
    for (const refusal of ['declaration-mismatch', 'no-release', 'draft']) {
      const refused = environmentRow({ ...RUN, NEEDS: JSON.stringify({ declare: { result: 'failure', outputs: { refusal, role: 'production' } }, deploy: { result: 'skipped' } }), ENVIRONMENT: 'staging', POSITION: '2' }, { api: () => [] });
      expect(refused, refusal).toMatchObject({ outcome: 'refused', failed_stage: 'deploy', refusal, position: 2 });
      expect(validate(refused)).toEqual({ ok: true });
    }
    // MUTATION: the stage read from the code (the gate's codes at `gate`) turns this red; the
    // gate's own refusal stays at `gate` (the release row's test).
  });

  it("a dispatch's rollback is marked; a release can't be one", () => {
    expect(environmentRow({ ...RUN, GITHUB_EVENT_NAME: 'workflow_dispatch', NEEDS: JSON.stringify({ declare: declared(), deploy: { result: 'success', outputs: { rollback: 'true', redeploy: 'false' } } }), ENVIRONMENT: 'production', POSITION: '1' }, { api: () => ({}) }))
      .toMatchObject({ trigger: 'workflow_dispatch', rollback: true });
  });

  it('writes no row for a held production (kanon#894)', () => {
    const held = { result: 'success', outputs: { ...declared().outputs, held: 'true' } };
    expect(environmentRow({ ...RUN, NEEDS: JSON.stringify({ declare: held, deploy: { result: 'skipped' } }), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => [] })).toBeNull();
    // MUTATION: a record that ignores the hold writes a cancelled production row here.
    expect(classifyEnvironment({ declare: held, deploy: { result: 'skipped' }, environment: 'production' })).toEqual({ outcome: 'cancelled', failed_stage: 'approval' });
  });

  it('records a production attempt refused to a non-Maintainer as `refused` at `deploy`, `not-maintainer` (§10, §13, kanon#913)', () => {
    const want = { outcome: 'refused', failed_stage: 'deploy', refusal: 'not-maintainer', role: 'production', position: 2 };
    // Refused by `declare`, before any approval wait: `deploy` is skipped.
    const refused = { declare: { result: 'failure', outputs: { role: 'production', unauthorized: 'not-maintainer' } }, deploy: { result: 'skipped' } };
    const r = environmentRow({ ...RUN, GITHUB_EVENT_NAME: 'workflow_dispatch', NEEDS: JSON.stringify(refused), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => [] });
    expect(r).toMatchObject(want);
    expect(validate(r)).toEqual({ ok: true });
    // A "Re-run failed jobs" by a non-Maintainer: `declare`'s outputs are reused and `deploy`'s own check refuses.
    const rerun = { declare: { result: 'success', outputs: { ...declared().outputs, held: 'false', fallback: 'no-reviewers' } }, deploy: { result: 'failure', outputs: { 'started-at': T(1), unauthorized: 'not-maintainer', 'ended-at': T(2) } } };
    const again = environmentRow({ ...RUN, GITHUB_EVENT_NAME: 'workflow_dispatch', NEEDS: JSON.stringify(rerun), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => ({}) });
    expect(again).toMatchObject(want);
    expect(validate(again)).toEqual({ ok: true });
    expect(isHeld(refused.declare)).toBe(false);
    expect(isHeld(rerun.declare)).toBe(false);
    // MUTATION: `stopped` reading the stage from the code instead of the job that refused
    // (`not-maintainer` defaulting to `gate`) files both at `gate`; `refusalOf` reading only
    // `refusal` files both as plain `failed`.
  });

  it("from the deploy job's own check to the row: a non-Maintainer's attempt under `no-reviewers` is `refused` at `deploy`, `not-maintainer` (#904)", () => {
    // The check's real outputs, not a fixture of them, so a change on either side turns this red.
    const record = '# Adoption record\n\n## People\n\n| Role | Who |\n|---|---|\n| Maintainer | M Person (`@maint`) |\n\n## Deploy\n\n- **Environments:** `staging`, `production`\n- **Fallback:** `no-reviewers`\n';
    const api = (p: string) => (p.includes('/contents/') ? record : []);
    const attempt = (actors: Record<string, string>) => {
      const checked = deployCheck({ GITHUB_REPOSITORY: 'acme/app', GITHUB_EVENT_NAME: 'workflow_dispatch', ENVIRONMENT: 'production', SHA: 'a'.repeat(40), FALLBACK: 'no-reviewers', ROLE: 'production', ...actors }, { api });
      const deploy = checked.ok
        ? { result: 'success', outputs: { 'started-at': T(1), ...checked.outputs, 'deploy-started-at': T(2), 'deploy-ended-at': T(3), 'ended-at': T(4) } }
        : { result: 'failure', outputs: { 'started-at': T(1), ...checked.outputs, 'ended-at': T(2) } };
      const needs = { declare: { result: 'success', outputs: { ...declared().outputs, held: 'false', fallback: 'no-reviewers' } }, deploy };
      return environmentRow({ ...RUN, GITHUB_EVENT_NAME: 'workflow_dispatch', NEEDS: JSON.stringify(needs), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => ({}) });
    };
    const want = { outcome: 'refused', failed_stage: 'deploy', refusal: 'not-maintainer', role: 'production', position: 2 };
    for (const actors of [{ GITHUB_ACTOR: 'owner' }, { GITHUB_ACTOR: 'maint', GITHUB_TRIGGERING_ACTOR: 'owner' }] as Array<Record<string, string>>) {
      const r = attempt(actors);
      expect(r, JSON.stringify(actors)).toMatchObject(want);
      expect(validate(r)).toEqual({ ok: true });
    }
    expect(attempt({ GITHUB_ACTOR: 'maint' })).toMatchObject({ outcome: 'ok', role: 'production' });
    // MUTATION: the row's stage read from the code, or its refusal from `refusal` alone, turns this red.
  });

  it('a failed `declare` is never a hold: a non-ok row, and the report files (the #892 review)', () => {
    // `declare` failed before writing `held`, so `deploy` was skipped: the same skip a hold makes.
    const needs = { declare: { result: 'failure', outputs: {} }, deploy: { result: 'skipped', outputs: {} } };
    const r = environmentRow({ ...RUN, NEEDS: JSON.stringify(needs), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => [] });
    // At `deploy`, the stage of the environment's call that `declare` opens (kanon#886).
    expect(r).toMatchObject({ outcome: 'failed', failed_stage: 'deploy', role: 'production', position: 2 });
    expect(validate(r)).toEqual({ ok: true });
    expect(classifyEnvironment({ declare: { result: 'cancelled', outputs: {} }, deploy: { result: 'skipped' }, environment: 'production' }))
      .toEqual({ outcome: 'cancelled', failed_stage: 'deploy' });
    const filed = reportFrom({ NEEDS: JSON.stringify({ ...needs, record: { result: 'success', outputs: { written: 'true', outcome: 'failed', stage: 'deploy', refusal: '' } } }), ENVIRONMENT: 'production', POSITION: '2' }, 'environment');
    expect(filed).toMatchObject({ outcome: 'failed', failed_stage: 'deploy' });
    // With no row recorded, the report classifies it the same way.
    expect(reportFrom({ NEEDS: JSON.stringify({ ...needs, record: { result: 'failure', outputs: {} } }), ENVIRONMENT: 'production', POSITION: '2' }, 'environment'))
      .toMatchObject({ outcome: 'failed', failed_stage: 'deploy' });
    // MUTATION: a record that treats deploy's `skipped` as the hold writes no row for this fixture.
    const skippedAsHeld = (n: typeof needs) => n.deploy.result === 'skipped' || isHeld(n.declare);
    expect(skippedAsHeld(needs)).toBe(true);
    expect(isHeld(needs.declare)).toBe(false);
  });

  describe('a rejection is read from the approvals, never from the conclusion alone (kanon#890)', () => {
    // D0's probe 7: a rejected job concludes `failure`, with no step and no log.
    const rejectedJob = { result: 'failure', outputs: {} };
    const approval = (state: string, name = 'staging') => [{ state, environments: [{ name }], comment: '' }];

    it('`rejected` in the run\'s approvals for this environment is `rejected` at `approval`', () => {
      expect(row(rejectedJob, { approvals: approval('rejected') })).toMatchObject({ outcome: 'rejected', failed_stage: 'approval' });
    });
    it('`approved` and `skipped` admitted it: the same conclusion is a failure', () => {
      expect(row(rejectedJob, { approvals: approval('approved') })).toMatchObject({ outcome: 'failed', failed_stage: 'approval' });
      expect(row(rejectedJob, { approvals: approval('skipped') })).toMatchObject({ outcome: 'failed', failed_stage: 'approval' });
      expect(row(rejectedJob, { approvals: approval('rejected', 'production') })).toMatchObject({ outcome: 'failed' });
    });
    it('reads the approvals only for a job that failed before its first step', () => {
      let read = 0;
      classifyEnvironment({ declare: ok, deploy: { result: 'failure', outputs: { 'started-at': T(1) } }, environment: 'staging', approvals: () => { read += 1; return approval('rejected'); } });
      expect(read).toBe(0);
    });
    it('MUTATION: reading the job conclusion alone turns the rejection fixture red', () => {
      // The classifier without its approvals read: what the record would write.
      const conclusionAlone = classifyEnvironment({ declare: ok, deploy: rejectedJob, environment: 'staging' });
      expect(conclusionAlone.outcome).not.toBe('rejected');
      expect(classifyEnvironment({ declare: ok, deploy: rejectedJob, environment: 'staging', approvals: () => approval('rejected') }).outcome).toBe('rejected');
    });
  });
});

describe("deploy-row.mjs: the release's row, only when the run stopped before any environment (open-question decision 4)", () => {
  const rel = (needs: object, environments = 'staging production') => releaseRow({ ...RUN, NEEDS: JSON.stringify(needs), ENVIRONMENTS: environments }, { now: new Date('2026-10-14T12:00:00Z') });
  const gateOk = (fallback = '') => ({ result: 'success', outputs: { fallback, environments: 'staging production', prerelease: 'true' } });

  it('writes nothing when the run went on: the probe passed, or was skipped under the `no-environments` marker, and the build passed', () => {
    expect(rel({ gate: gateOk(), probe: ok, build: ok })).toBeNull();
    expect(rel({ gate: gateOk('no-environments'), probe: { result: 'skipped', outputs: {} }, build: ok })).toBeNull();
  });

  it('writes one row at `build` when the build failed or was cancelled, timed, and never at `probe` for a probe skipped under the marker (plan 0010 D5)', () => {
    const built = { 'started-at': T(1), 'ended-at': T(4) };
    for (const fallback of ['', 'no-environments']) {
      const probe = fallback ? { result: 'skipped', outputs: {} } : ok;
      const failed = rel({ gate: gateOk(fallback), probe, build: { result: 'failure', outputs: built } });
      expect(failed, fallback).toMatchObject({ outcome: 'failed', failed_stage: 'build', build_ms: 180_000, position: 1, role: 'pre-production' });
      expect(validate(failed)).toEqual({ ok: true });
      expect(rel({ gate: gateOk(fallback), probe, build: { result: 'cancelled', outputs: {} } })).toMatchObject({ outcome: 'cancelled', failed_stage: 'build' });
    }
    // A run cancelled before the build started skips it: cancelled at `build`, not failed.
    expect(rel({ gate: gateOk(), probe: ok, build: { result: 'skipped', outputs: {} } })).toMatchObject({ outcome: 'cancelled', failed_stage: 'build' });
    // A failed probe stops the run at `probe`, the build skipped after it.
    expect(rel({ gate: gateOk('no-reviewers'), probe: { result: 'failure', outputs: { refusal: 'probe-unconfigured' } }, build: { result: 'skipped' } })).toMatchObject({ failed_stage: 'probe', refusal: 'probe-unconfigured' });
    // The report files a failed build on the first environment's issue, at `build`.
    const needs = { gate: gateOk(), probe: ok, build: { result: 'failure', outputs: {} }, record: { result: 'success', outputs: { written: 'true', outcome: 'failed', stage: 'build', refusal: '' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(needs), ENVIRONMENTS: 'staging production', RELEASE: 'v1', RUN_URL: 'u' }, 'release')).toMatchObject({ environment: 'staging', outcome: 'failed', failed_stage: 'build' });
  });

  it('writes one row, for the first environment, when the gate or the probe stopped it', () => {
    const refused = rel({ gate: { result: 'failure', outputs: { refusal: 'ci-red', environments: 'staging production' } }, probe: { result: 'skipped' } });
    expect(refused).toMatchObject({ role: 'pre-production', position: 1, outcome: 'refused', failed_stage: 'gate', refusal: 'ci-red' });
    expect(validate(refused)).toEqual({ ok: true });
    expect(rel({ gate: gateOk(), probe: { result: 'failure', outputs: { refusal: 'trust-unbound' } } })).toMatchObject({ outcome: 'refused', failed_stage: 'probe', refusal: 'trust-unbound', prerelease: true });
    expect(rel({ gate: gateOk(), probe: { result: 'failure', outputs: {} } })).toMatchObject({ outcome: 'failed', failed_stage: 'probe' });
    expect(rel({ gate: { result: 'cancelled', outputs: {} }, probe: { result: 'skipped' } })).toMatchObject({ outcome: 'cancelled', failed_stage: 'gate' });
    // A probe skipped without the marker didn't prove anything: the run stopped there.
    expect(classifyRelease({ gate: gateOk(), probe: { result: 'skipped' } })).toEqual({ outcome: 'failed', failed_stage: 'probe' });
  });

  it('with one environment, the first is production', () => {
    expect(rel({ gate: { result: 'failure', outputs: { refusal: 'draft' } } }, 'production')).toMatchObject({ role: 'production', position: 1 });
  });

  describe('the CLI writes the file the upload step sends, named by run, attempt and position', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-row-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it('writes it and says so in its outputs', () => {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = spawnSync('node', ['scripts/deploy-row.mjs', 'environment'], {
        encoding: 'utf8',
        env: { ...process.env, ...RUN, RUNNER_TEMP: dir, GITHUB_OUTPUT: out, ENVIRONMENT: 'production', POSITION: '1', NEEDS: JSON.stringify({ declare: declared(), deploy: ok }) },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(out, 'utf8')).toContain('written=true\noutcome=ok\n');
      expect(JSON.parse(readFileSync(join(dir, 'kanon-deploy-row', DEPLOY_ARTIFACT_FILE), 'utf8'))).toMatchObject({ outcome: 'ok', role: 'production' });
      expect(deployArtifactName(123, 1, 2)).toBe('kanon-deploy-row-123-1-2');
      // The workflows upload under that name and file.
      for (const [file, pos] of [[RELEASE, '1'], [ENV, '${{ inputs.position }}']] as const) {
        const up = job(PARSED, file, 'record').steps!.find((s) => String(s.uses).startsWith('actions/upload-artifact@'))!;
        expect(up.with).toMatchObject({ name: deployArtifactName('${{ github.run_id }}', '${{ github.run_attempt }}', pos), path: `\${{ runner.temp }}/kanon-deploy-row/${DEPLOY_ARTIFACT_FILE}` });
      }
    });

    // kanon#919: an upload the collector's listing doesn't match is skipped, not counted, so a
    // rename on either side would stop the deploy rows reaching the store with nothing red.
    it('names the artifact and its file from the collector\'s own definition, so the two cannot disagree', () => {
      expect(deployArtifactName).toBe(collected.deployArtifactName);
      expect(DEPLOY_ARTIFACT_FILE).toBe(collected.DEPLOY_ARTIFACT_FILE);
      expect(collected.DEPLOY_ARTIFACT.test(deployArtifactName(123, 1, 2))).toBe(true);
      // Each upload, its expressions stood in for by numbers, is a name the collector lists.
      const run = { '${{ github.run_id }}': '123', '${{ github.run_attempt }}': '1', '${{ inputs.position }}': '2' };
      for (const file of LANE) {
        const up = job(PARSED, file, 'record').steps!.find((s) => String(s.uses).startsWith('actions/upload-artifact@'))!;
        const name = Object.entries(run).reduce((n, [expr, v]) => n.replaceAll(expr, v), String(up.with?.name));
        expect(name, file).toMatch(collected.DEPLOY_ARTIFACT);
        expect(String(up.with?.path).split('/').at(-1), file).toBe(collected.DEPLOY_ARTIFACT_FILE);
      }
    });
  });
});

// ── The issues ────────────────────────────────────────────────────────────────────────────

describe("deploy-report.mjs: one issue per environment (plan 0010 §8, decision 10)", () => {
  /** GitHub's issues as a fixture: the open ones, and every write. */
  const issues = (open: Array<{ number: number, title: string }> = []) => {
    const writes: Array<{ path: string, method?: string, body?: unknown }> = [];
    const api = (path: string, opts: { method?: string, body?: unknown } = {}) => {
      if (!opts.method || opts.method === 'GET') return path.includes('page=1') ? open : [];
      writes.push({ path, ...opts });
      return { number: 42 };
    };
    return { api, writes };
  };
  const base = { repo: 'acme/app', release: 'v1.2.0', runUrl: 'https://github.com/acme/app/actions/runs/1' };

  it('files an issue titled for the failed environment: `sev:high` for production, the last', () => {
    const { api, writes } = issues();
    expect(report({ ...base, api, environment: 'production', role: 'production', position: 2, outcome: 'failed', failed_stage: 'deploy' })).toEqual({ action: 'filed', number: 42 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: 'repos/acme/app/issues', method: 'POST', body: { title: 'Deploy to production failed', labels: ['bug', 'sev:high'] } });
  });

  it('and `sev:medium` for a pre-production environment (MUTATION: `sev:high` there turns this red)', () => {
    const { api, writes } = issues();
    report({ ...base, api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'smoke_failed', failed_stage: 'smoke' });
    expect((writes[0]!.body as { labels: string[] }).labels).toEqual(['bug', 'sev:medium']);
  });

  it('files a refusal too, naming its code, and no log line', () => {
    const { api, writes } = issues();
    report({ ...base, api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'refused', failed_stage: 'deploy', refusal: 'superseded' });
    const body = (writes[0]!.body as { body: string }).body;
    expect(body).toContain('`superseded`');
    expect(body).toContain('v1.2.0');
    expect(body).toContain(base.runUrl);
  });

  it('comments on the open issue instead of filing a second', () => {
    const { api, writes } = issues([{ number: 7, title: issueTitle('staging') }, { number: 8, title: 'Deploy to staging failed again' }]);
    expect(report({ ...base, api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'failed', failed_stage: 'deploy' })).toEqual({ action: 'commented', number: 7 });
    expect(writes.map((x) => [x.method, x.path])).toEqual([['POST', 'repos/acme/app/issues/7/comments']]);
  });

  it("outputs the issue a failure filed or commented on, for the announcement's link, and none after a close (plan 0011 N9)", () => {
    expect(issueOf({ action: 'filed', number: 9 })).toBe('9');
    expect(issueOf({ action: 'commented', number: 7 })).toBe('7');
    expect(issueOf({ action: 'closed', number: 7 })).toBe('');
    expect(issueOf({ action: 'none' })).toBe('');
    const rep = PARSED[ENV]!.jobs.report!;
    expect(rep.outputs).toEqual({ issue: '${{ steps.issue.outputs.issue }}' });
    expect(step(PARSED[ENV]!.jobs.announce!, 'message').env!.ISSUE).toBe('${{ needs.report.outputs.issue }}');
  });

  it("closes the environment's open issue on its next success, and does nothing when none is open", () => {
    const { api, writes } = issues([{ number: 7, title: issueTitle('staging') }]);
    expect(report({ ...base, api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'ok' })).toEqual({ action: 'closed', number: 7 });
    expect(writes.map((x) => [x.method, x.path, x.body])).toEqual([
      ['POST', 'repos/acme/app/issues/7/comments', expect.anything()],
      ['PATCH', 'repos/acme/app/issues/7', { state: 'closed', state_reason: 'completed' }],
    ]);
    const none = issues();
    expect(report({ ...base, api: none.api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'ok' })).toEqual({ action: 'none' });
    expect(none.writes).toEqual([]);
  });

  it('files nothing for a rejection or a cancellation: a person decided it', () => {
    for (const outcome of ['rejected', 'cancelled']) {
      const { api, writes } = issues();
      expect(report({ ...base, api, environment: 'production', role: 'production', position: 1, outcome, failed_stage: 'approval' })).toEqual({ action: 'none' });
      expect(writes).toEqual([]);
    }
  });

  it("a run stopped before any environment reports on the first environment's issue: sev:medium, or sev:high when it is the only one", () => {
    const stopped = { gate: { result: 'failure', outputs: { refusal: 'ci-red' } }, probe: { result: 'skipped' }, record: { result: 'success', outputs: { written: 'true', outcome: 'refused', stage: 'gate', refusal: 'ci-red' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(stopped), ENVIRONMENTS: 'staging production', RELEASE: 'v1', RUN_URL: 'u' }, 'release'))
      .toMatchObject({ environment: 'staging', role: 'pre-production', position: 1, outcome: 'refused', failed_stage: 'gate', refusal: 'ci-red' });
    expect(reportFrom({ NEEDS: JSON.stringify(stopped), ENVIRONMENTS: 'production', RELEASE: 'v1', RUN_URL: 'u' }, 'release')).toMatchObject({ environment: 'production', role: 'production' });
    const went = { gate: { result: 'success', outputs: {} }, probe: ok, build: ok, record: { result: 'success', outputs: { written: 'false' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(went), ENVIRONMENTS: 'staging production' }, 'release')).toBeNull();
  });

  it('a held production neither files, comments nor closes; a refused non-Maintainer dispatch files as a refusal at `deploy` (kanon#894, kanon#913)', () => {
    const held = { declare: { result: 'success', outputs: { role: 'production', held: 'true' } }, deploy: { result: 'skipped' }, record: { result: 'success', outputs: { written: 'false' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(held), ENVIRONMENT: 'production', POSITION: '2' }, 'environment')).toBeNull();
    // A record that failed before writing its row: the report reads the jobs' own outputs.
    const refused = { declare: { result: 'failure', outputs: { role: 'production', unauthorized: 'not-maintainer' } }, deploy: { result: 'skipped' }, record: { result: 'failure', outputs: {} } };
    expect(reportFrom({ NEEDS: JSON.stringify(refused), ENVIRONMENT: 'production', POSITION: '2' }, 'environment'))
      .toMatchObject({ outcome: 'refused', refusal: 'not-maintainer', role: 'production', failed_stage: 'deploy' });
    // A "Re-run failed jobs" by a non-Maintainer: `declare`'s outputs are reused and `deploy`'s own check refuses.
    const rerun = { declare: { result: 'success', outputs: { role: 'production', held: 'false', fallback: 'no-reviewers' } }, deploy: { result: 'failure', outputs: { 'started-at': T(1), unauthorized: 'not-maintainer' } }, record: { result: 'failure', outputs: {} } };
    expect(reportFrom({ NEEDS: JSON.stringify(rerun), ENVIRONMENT: 'production', POSITION: '2' }, 'environment'))
      .toMatchObject({ outcome: 'refused', refusal: 'not-maintainer', failed_stage: 'deploy' });
    // The record wrote the row (kanon#913): the report files what it recorded, at the same stage.
    for (const needs of [refused, rerun]) {
      const recorded = { ...needs, record: { result: 'success', outputs: { written: 'true', outcome: 'refused', stage: 'deploy', refusal: 'not-maintainer' } } };
      expect(reportFrom({ NEEDS: JSON.stringify(recorded), ENVIRONMENT: 'production', POSITION: '2' }, 'environment'))
        .toMatchObject({ outcome: 'refused', refusal: 'not-maintainer', role: 'production', failed_stage: 'deploy' });
    }
  });

  it("an environment's report reads the record's outcome, which saw the approvals, and the declaration's role", () => {
    const needs = { declare: declared('pre-production'), deploy: { result: 'failure', outputs: {} }, record: { result: 'success', outputs: { outcome: 'rejected', stage: 'approval', refusal: '' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(needs), ENVIRONMENT: 'staging', POSITION: '1' }, 'environment')).toMatchObject({ outcome: 'rejected', role: 'pre-production', position: 1 });
  });
});

// ── The build's artifact (plan 0010 decision 8, step D5) ──────────────────────────────────

describe('deploy-build.mjs: one build, digested once and checked in every environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-build-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  /** A runner's temp directory whose build directory holds `files`. */
  const temp = (files: Record<string, string> = {}) => {
    const dir = join(root, `t${n += 1}`);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, BUILD_DIR, path)), { recursive: true });
      writeFileSync(join(dir, BUILD_DIR, path), text);
    }
    return dir;
  };
  const cli = (command: string, runnerTemp: string, env: Record<string, string> = {}) => {
    const out = join(runnerTemp, 'github-output');
    mkdirSync(runnerTemp, { recursive: true });
    writeFileSync(out, '');
    const r = spawnSync('node', ['scripts/deploy-build.mjs', command], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2', RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: out, ...env },
    });
    return { status: r.status, stderr: r.stderr, outputs: Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
  };
  const SITE = { 'index.html': '<h1>v1.2.0</h1>', 'assets/app.js': 'go()', '.well-known/security.txt': 'Contact: x' };

  it('the build job names the run-scoped artifact and outputs its digest, which the workflow uploads under that name', () => {
    const r = cli('digest', temp(SITE), { STARTED_AT: '2026-10-14T11:00:00Z' });
    expect(r.status, r.stderr).toBe(0);
    const build = JSON.parse(r.outputs.build!);
    expect(build).toMatchObject({ artifact: 'kanon-deploy-build-123456-2', digest: expect.stringMatching(/^[0-9a-f]{64}$/), build_ms: expect.any(Number) });
    expect(buildArtifactName('${{ github.run_id }}', '${{ github.run_attempt }}')).toBe(BUILD_NAME);
  });

  it('the build job fails, by name, when the hook built nothing', () => {
    const r = cli('digest', temp());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('wrote nothing');
    expect(r.outputs.build).toBeUndefined();
  });

  it("the digest is the contents': the same files give the same digest, hidden files count, and any change differs", () => {
    const a = temp(SITE);
    const digest = treeDigest(join(a, BUILD_DIR));
    expect(treeDigest(join(temp(SITE), BUILD_DIR))).toBe(digest);
    expect(treeDigest(join(temp({ ...SITE, 'index.html': '<h1>v1.2.1</h1>' }), BUILD_DIR))).not.toBe(digest);
    expect(treeDigest(join(temp({ 'index.html': SITE['index.html'], 'assets/app.js': SITE['assets/app.js'] }), BUILD_DIR))).not.toBe(digest);
    // The same bytes at another path.
    expect(treeDigest(join(temp({ 'index.html': SITE['index.html'], 'app.js': 'go()', '.well-known/security.txt': 'Contact: x' }), BUILD_DIR))).not.toBe(digest);
    expect(listFiles(join(a, BUILD_DIR))).toEqual(['.well-known/security.txt', 'assets/app.js', 'index.html']);
  });

  it('every environment reads the build from its input, held to this run', () => {
    const digest = 'a'.repeat(64);
    const good = cli('input', temp(), { BUILD: JSON.stringify({ artifact: 'kanon-deploy-build-123456-1', digest, build_ms: 5 }) });
    expect(good.status, good.stderr).toBe(0);
    // Attempt 2 (`GITHUB_RUN_ATTEMPT` 2, a "Re-run failed jobs") downloads attempt 1's artifact,
    // the name the reused build output gives, never one rebuilt from the attempt (#940).
    expect(good.outputs).toEqual({ artifact: 'kanon-deploy-build-123456-1', digest });
    expect(readBuild(JSON.stringify({ artifact: 'kanon-deploy-build-123456-3', digest }), '123456')).toEqual({ artifact: 'kanon-deploy-build-123456-3', digest });
    for (const bad of ['', 'not json', JSON.stringify({ artifact: 'kanon-deploy-build-999-1', digest }), JSON.stringify({ artifact: 'kanon-deploy-build-123456-1', digest: 'abc' }), JSON.stringify({ artifact: 'kanon-deploy-row-123456-1-1', digest })]) {
      const r = cli('input', temp(), { BUILD: bad });
      expect(r.status, bad).toBe(1);
      expect(r.outputs.artifact, bad).toBeUndefined();
    }
  });

  it('the downloaded build passes its check when its digest is the build job\'s, and the hook gets its path', () => {
    const built = temp(SITE);
    const { outputs } = cli('digest', built);
    const { digest, artifact } = JSON.parse(outputs.build!);
    const downloaded = temp(SITE);
    const r = cli('check', downloaded, { ARTIFACT: artifact, DIGEST: digest });
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs.path).toBe(join(downloaded, BUILD_DIR));
  });

  it('a fixture run whose artifact digest differs fails at the `build` stage, before the deploy hook', () => {
    const { outputs } = cli('digest', temp(SITE));
    const { digest, artifact } = JSON.parse(outputs.build!);
    const swapped = cli('check', temp({ ...SITE, 'assets/app.js': 'steal()' }), { ARTIFACT: artifact, DIGEST: digest });
    expect(swapped.status).toBe(1);
    expect(swapped.stderr).toContain("isn't what the build job uploaded");
    expect(swapped.outputs.path).toBeUndefined();
    // The job's outputs then say so, and the record writes `failed` at `build`.
    expect(classifyEnvironment({ declare: ok, deploy: { result: 'failure', outputs: { 'started-at': T(1), 'build-failed': 'true' } }, environment: 'staging' })).toEqual({ outcome: 'failed', failed_stage: 'build' });
    // MUTATION: the digest check removed. The swapped artifact would reach the deploy hook.
    expect(() => checkBuild({ dir: join(temp({ ...SITE, 'assets/app.js': 'steal()' }), BUILD_DIR), artifact, digest })).toThrow(/isn't what the build job uploaded/);
  });

  it('an expired artifact fails by name: nothing was downloaded', () => {
    const r = cli('check', temp(), { ARTIFACT: 'kanon-deploy-build-123456-1', DIGEST: 'a'.repeat(64) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("wasn't downloaded: it expired");
    expect(r.stderr).toContain('kanon-deploy-build-123456-1');
  });
});

// ── Live, smoke failed, from the workflow to the row and the chain (plan 0013 §7.1, step S4) ──

/**
 * The deploy job of `deploy.yml`, run on paper as GitHub runs it: each step's `if:` read with
 * `jobRuns` against the steps so far, a hook whose `action.yml` isn't in the checkout failing as
 * GitHub's missing action does, a failing step under `continue-on-error: true` concluding
 * `success`, and the job's outputs resolved from the steps. `fail` names the steps that fail.
 */
function runDeployJob(w: Record<string, Workflow>, { fail = [] as string[], files = [] as string[] } = {}) {
  const dep = job(w, ENV, 'deploy');
  const ctx: StepContext = { steps: {}, failed: false, files };
  let minute = 10;
  for (const s of dep.steps ?? []) {
    const id = s.id ?? s.name ?? String(s.uses);
    if (!jobRuns(s.if, {}, false, ctx)) { ctx.steps[id] = { outcome: 'skipped', conclusion: 'skipped', outputs: {} }; continue; }
    const hook = /^\.\/(\.github\/actions\/[a-z-]+)$/.exec(String(s.uses ?? ''))?.[1];
    const outcome = fail.includes(id) || (hook && !files.includes(`${hook}/action.yml`)) ? 'failure' : 'success';
    const conclusion = outcome === 'failure' && s['continue-on-error'] === true ? 'success' : outcome;
    if (conclusion === 'failure') ctx.failed = true;
    ctx.steps[id] = { outcome, conclusion, outputs: /\bat=\$\(date/.test(String(s.run ?? '')) ? { at: T(minute++) } : {} };
  }
  const resolve = (v: string) => {
    const m = /^\$\{\{ steps\.([\w-]+)\.(outcome|outputs\.([\w-]+)) \}\}$/.exec(v);
    const done = m ? ctx.steps[m[1]!] : undefined;
    return !m || !done ? '' : m[2] === 'outcome' ? done.outcome : done.outputs[m[3]!] ?? '';
  };
  return { result: ctx.failed ? 'failure' : 'success', outputs: Object.fromEntries(Object.entries(dep.outputs ?? {}).map(([k, v]) => [k, resolve(v)])) };
}

/** The `verdict` job, run: its `if:` against the deploy job, then its script under bash with its `env:` resolved. */
function runVerdict(w: Record<string, Workflow>, deploy: { result: string; outputs: Record<string, string> }) {
  const v = w[ENV]?.jobs.verdict;
  if (!v) return 'absent';
  if (!jobRuns(v.if, { deploy })) return 'skipped';
  const first = v.steps![0]!;
  const env = Object.fromEntries(Object.entries(first.env ?? {}).map(([k, x]) => [k, String(x).replace(/^\$\{\{ needs\.deploy\.outputs\.([\w-]+) \}\}$/, (_m, o: string) => deploy.outputs[o] ?? '')]));
  const r = spawnSync('bash', ['-c', String(first.run)], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return r.status === 0 ? 'success' : 'failure';
}

/** Whether the next environment's call starts: the caller `kanon init` writes, after this call concluded. */
function nextStarts(call: string) {
  const caller = parse(deployCallerFile(['staging', 'production'], loadRequirements(), 'v9.9.9')) as Workflow;
  const next = caller.jobs['deploy-2']!;
  expect(next.needs).toEqual(['release', 'deploy-1']);
  return jobRuns(next.if, { release: { result: 'success' }, 'deploy-1': { result: call } });
}

describe('live, smoke failed: the deploy job succeeds, the verdict stops the chain (plan 0013 §7.1)', () => {
  const HOOKS = ['.github/actions/deploy/action.yml', '.github/actions/smoke/action.yml'];
  const WITH_RESET = [...HOOKS, RESET_HOOK];
  const lane = (opts: { fail?: string[]; files?: string[] }, w = load()) => {
    const deploy = runDeployJob(w, opts);
    const verdict = runVerdict(w, deploy);
    const call = [deploy.result, verdict].includes('failure') ? 'failure' : 'success';
    const r = environmentRow({ ...RUN, NEEDS: JSON.stringify({ declare: declared('pre-production'), deploy }), ENVIRONMENT: 'staging', POSITION: '1' }, { api: () => ({ run_started_at: T(0) }) })!;
    return { deploy, verdict, call, row: r, next: nextStarts(call) };
  };

  it('a failed smoke check: the deploy job concludes success, the verdict fails the call, and the next environment does not start', () => {
    const run = lane({ fail: ['smoke'], files: HOOKS });
    expect(run.deploy.result).toBe('success');
    expect(run.deploy.outputs).toMatchObject({ 'deploy-outcome': 'success', 'reset-outcome': 'skipped', 'smoke-outcome': 'failure' });
    expect(run.verdict).toBe('failure');
    expect(run.call).toBe('failure');
    expect(run.next).toBe(false);
    expect(run.row).toMatchObject({ schema_version: 1, outcome: 'smoke_failed', failed_stage: 'smoke', role: 'pre-production' });
    expect(validate(run.row)).toEqual({ ok: true });
  });

  it('a failed reset: the smoke check does not run, and the row is `smoke_failed` at `reset`, at version 2', () => {
    const run = lane({ fail: ['reset'], files: WITH_RESET });
    expect(run.deploy.result).toBe('success');
    expect(run.deploy.outputs).toMatchObject({ 'reset-outcome': 'failure', 'smoke-outcome': 'skipped' });
    expect(run.verdict).toBe('failure');
    expect(run.next).toBe(false);
    expect(run.row).toMatchObject({ schema_version: 2, outcome: 'smoke_failed', failed_stage: 'reset' });
    expect(run.row.reset_ms).toBeGreaterThanOrEqual(0);
    expect(run.row).not.toHaveProperty('smoke_ms');
    expect(validate(run.row)).toEqual({ ok: true });
  });

  it('a passing reset and smoke check: `ok` at version 2 with both times, and the chain goes on', () => {
    const run = lane({ files: WITH_RESET });
    expect(run.verdict).toBe('success');
    expect(run.next).toBe(true);
    expect(run.row).toMatchObject({ schema_version: 2, outcome: 'ok', reset_ms: 60_000, smoke_ms: 60_000 });
    expect(validate(run.row)).toEqual({ ok: true });
  });

  it('no reset step runs when the hook is absent, the summary says so, and the row stays at version 1', () => {
    const run = lane({ files: HOOKS });
    expect(run.deploy.outputs['reset-outcome']).toBe('skipped');
    expect(run.deploy.outputs['smoke-outcome']).toBe('success');
    expect(run.next).toBe(true);
    expect(run.row).toMatchObject({ schema_version: 1, outcome: 'ok' });
    expect(run.row).not.toHaveProperty('reset_ms');
    const said = (PARSED[ENV]!.jobs.deploy!.steps ?? []).find((x) => x.name === 'Say there is no reset hook')!;
    expect(said.if).toBe(`hashFiles('${RESET_HOOK}') == ''`);
    expect(said.run).toContain('$GITHUB_STEP_SUMMARY');
  });

  it('a failed deploy hook still fails the deploy job, runs neither the reset nor the smoke check, and the verdict adds nothing', () => {
    const run = lane({ fail: ['deploy'], files: WITH_RESET });
    expect(run.deploy.result).toBe('failure');
    expect(run.deploy.outputs).toMatchObject({ 'reset-outcome': 'skipped', 'smoke-outcome': 'skipped' });
    expect(run.verdict).toBe('success');
    expect(run.next).toBe(false);
    expect(run.row).toMatchObject({ schema_version: 1, outcome: 'failed', failed_stage: 'deploy' });
  });

  it('MUTATION: `continue-on-error` left off the smoke step fails the deploy job, which GitHub marks a failed deployment', () => {
    const w = load();
    delete step(job(w, ENV, 'deploy'), 'smoke')['continue-on-error'];
    expect(lane({ fail: ['smoke'], files: HOOKS }, w).deploy.result).toBe('failure');
  });

  it('MUTATION: the verdict dropped lets the next environment start after a failed smoke check', () => {
    const w = load();
    delete w[ENV]!.jobs.verdict;
    const run = lane({ fail: ['smoke'], files: HOOKS }, w);
    expect(run.verdict).toBe('absent');
    expect(run.next).toBe(true);
  });

  it('a cancel during the reset is `cancelled` at `reset`, during the smoke check at `smoke`', () => {
    expect(classifyEnvironment({ declare: ok, deploy: { result: 'cancelled', outputs: { 'started-at': T(1), 'deploy-ended-at': T(2), 'reset-outcome': 'cancelled' } }, environment: 'staging' }))
      .toEqual({ outcome: 'cancelled', failed_stage: 'reset' });
    expect(classifyEnvironment({ declare: ok, deploy: { result: 'cancelled', outputs: { 'started-at': T(1), 'deploy-ended-at': T(2), 'reset-outcome': 'success' } }, environment: 'staging' }))
      .toEqual({ outcome: 'cancelled', failed_stage: 'smoke' });
  });
});

describe('the smoke issue (plan 0013 §7.2, decision 4)', () => {
  const issues = (open: Array<{ number: number, title: string }> = []) => {
    const writes: Array<{ path: string, method?: string, body?: unknown }> = [];
    const api = (path: string, opts: { method?: string, body?: unknown } = {}) => {
      if (!opts.method || opts.method === 'GET') return path.includes('page=1') ? open : [];
      writes.push({ path, ...opts });
      return { number: 42 };
    };
    return { api, writes };
  };
  const base = { repo: 'acme/app', release: 'v1.2.0', runUrl: 'https://github.com/acme/app/actions/runs/1', caller: 'deploy.yml' };

  it('files `Smoke check on <environment> failed`, saying the release is live, the stage, the run and how to check it again, and closes the deploy issue', () => {
    const { api, writes } = issues([{ number: 7, title: issueTitle('production') }]);
    expect(report({ ...base, api, environment: 'production', role: 'production', position: 2, outcome: 'smoke_failed', failed_stage: 'smoke' })).toEqual({ action: 'filed', number: 42 });
    expect(writes.map((x) => [x.method, x.path])).toEqual([
      ['POST', 'repos/acme/app/issues/7/comments'],
      ['PATCH', 'repos/acme/app/issues/7'],
      ['POST', 'repos/acme/app/issues'],
    ]);
    expect(writes[1]!.body).toEqual({ state: 'closed', state_reason: 'completed' });
    const filed = writes[2]!.body as { title: string, body: string, labels: string[] };
    expect(filed.title).toBe('Smoke check on production failed');
    expect(filed.labels).toEqual(['bug', 'sev:high']);
    expect(filed.body).toContain('Release `v1.2.0` is live on `production`');
    expect(filed.body).toContain('its smoke check failed at the `smoke` stage');
    expect(filed.body).toContain('--ref v1.2.0 -f release=v1.2.0');
    expect(filed.body).toContain(`Run: ${base.runUrl}`);
    expect(filed.body).not.toMatch(/failed to deploy|deploy of release/);
  });

  it('a failed reset says the smoke check did not run; a later failure comments on the open smoke issue', () => {
    const { api, writes } = issues([{ number: 9, title: smokeIssueTitle('staging') }]);
    expect(report({ ...base, api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'smoke_failed', failed_stage: 'reset' })).toEqual({ action: 'commented', number: 9 });
    expect(writes).toHaveLength(1);
    expect((writes[0]!.body as { body: string }).body).toContain("its reset hook failed, so its smoke check didn't run");
  });

  it('a failed deploy never touches the smoke issue, and an `ok` closes both', () => {
    const failed = issues([{ number: 9, title: smokeIssueTitle('staging') }]);
    expect(report({ ...base, api: failed.api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'failed', failed_stage: 'deploy' })).toEqual({ action: 'filed', number: 42 });
    expect((failed.writes[0]!.body as { title: string }).title).toBe('Deploy to staging failed');
    const both = issues([{ number: 7, title: issueTitle('staging') }, { number: 9, title: smokeIssueTitle('staging') }]);
    expect(report({ ...base, api: both.api, environment: 'staging', role: 'pre-production', position: 1, outcome: 'ok' })).toEqual({ action: 'closed', number: 7 });
    expect(both.writes.filter((x) => x.method === 'PATCH').map((x) => x.path)).toEqual(['repos/acme/app/issues/7', 'repos/acme/app/issues/9']);
  });

  it("names the deploy caller's file from the runner's workflow ref", () => {
    expect(callerFile('acme/app/.github/workflows/ship.yml@refs/tags/v1.2.0')).toBe('ship.yml');
    expect(callerFile(undefined)).toBe('deploy.yml');
    expect(reportFrom({ NEEDS: JSON.stringify({ declare: declared(), deploy: ok, record: { result: 'success', outputs: { outcome: 'smoke_failed', stage: 'smoke' } } }), ENVIRONMENT: 'staging', POSITION: '1', GITHUB_WORKFLOW_REF: 'acme/app/.github/workflows/deploy.yml@refs/tags/v1' }, 'environment'))
      .toMatchObject({ outcome: 'smoke_failed', failed_stage: 'smoke', caller: 'deploy.yml' });
  });
});
