import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validate } from '../../actions/agent-telemetry/schema.mjs';
import {
  classifyEnvironment, classifyRelease, DEPLOY_ARTIFACT_FILE, deployArtifactName, environmentRow, heldOrUnrecorded, releaseRow,
} from '../../scripts/deploy-row.mjs';
import { issueTitle, report, reportFrom } from '../../scripts/deploy-report.mjs';

/**
 * Plan 0010 step D4: the deploy lane's two reusable workflows, `deploy-release.yml` (gate, probe,
 * record, report) and `deploy.yml` (declare, deploy, record, report, for one environment),
 * held to their shape, and the scripts that write the lane's rows and issues, on fixtures.
 *
 * `laneProblems` is the shape, as a list of what is wrong, so each mutation the plan names is a
 * case below that changes a copy of the parsed workflows and must name its problem: a guard that
 * can't fail is no guard (`K-PRIN-11`).
 */

const WF = '.github/workflows';
const RELEASE = 'deploy-release.yml';
const ENV = 'deploy.yml';
const LANE = [RELEASE, ENV];

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = {
  name?: string; needs?: string | string[]; if?: string; uses?: string; environment?: unknown; permissions?: Record<string, string> | string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean; queue?: string } | string; steps?: Step[]; secrets?: unknown; with?: Record<string, unknown>;
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

/** Everything wrong with the lane's shape, by file, job and step. */
export function laneProblems(w: Record<string, Workflow>): string[] {
  const out: string[] = [];
  for (const file of LANE) {
    const wf = w[file];
    if (!wf) { out.push(`${file} is missing`); continue; }
    if (JSON.stringify(wf.permissions) !== '{}') out.push(`${file}: the workflow grants something at the top`);
    if (wf.on?.workflow_call?.secrets !== undefined) out.push(`${file}: declares secrets its caller would map`);
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
        if (!only) out.push(`${at}:${s.id ?? s.name ?? s.uses}: references a secret; only deploy.yml's deploy hook step may, KANON_DEPLOY_SECRET in its env:`);
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
  }
  const declare = w[ENV]?.jobs.declare;
  if (declare && JSON.stringify(declare.permissions) !== '{"contents":"read"}') out.push(`${ENV}:declare: holds more than contents: read`);
  const inputs = Object.keys(w[ENV]?.on?.workflow_call?.inputs ?? {}).sort();
  if (JSON.stringify(inputs) !== '["environment","position"]') out.push(`${ENV}: takes ${inputs.join(', ')}, not the environment and its position alone`);
  if (/inputs\.role\b/.test(JSON.stringify(w[ENV] ?? {}))) out.push(`${ENV}: reads a role from its caller`);
  const probe = w[RELEASE]?.jobs.probe;
  if (probe) {
    if (probe.if !== "needs.gate.outputs.fallback != 'no-environments'") out.push(`${RELEASE}:probe: runs under the no-environments marker`);
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
    expect(Object.keys(PARSED[RELEASE]!.jobs)).toEqual(['gate', 'probe', 'record', 'report']);
    expect(Object.keys(PARSED[ENV]!.jobs)).toEqual(['declare', 'deploy', 'record', 'report']);
    // The run lists the environment's job as `<caller job> / deploy` (kanon#890), which the reference deploy names.
    expect(PARSED[ENV]!.jobs.deploy!.name).toBe('deploy');
    expect(step(PARSED[ENV]!.jobs.deploy!, 'deploy').env).toEqual({ KANON_DEPLOY_SECRET: ALLOWED_SECRET });
  });

  it('every checkout of the two workflows persists no credential, and checks out the release commit the gate or the declaration resolved', () => {
    const checkouts = LANE.flatMap((f) => Object.values(PARSED[f]!.jobs).flatMap((j) => (j.steps ?? []).filter(isCheckout)));
    expect(checkouts).toHaveLength(2);
    expect(checkouts.map((s) => s.with?.ref)).toEqual(['${{ needs.gate.outputs.sha }}', '${{ needs.declare.outputs.sha }}']);
  });

  it('the hooks get the inputs plan 0010 §7 lists, and the smoke hook never the secret', () => {
    const dep = PARSED[ENV]!.jobs.deploy!;
    const hooks = (dep.steps ?? []).filter((s) => String(s.uses ?? '').startsWith('./'));
    expect(hooks.map((s) => [s.uses, Object.keys(s.with ?? {})])).toEqual([
      ['./.github/actions/deploy', ['environment', 'role', 'release', 'sha', 'artifact', 'probe', 'environments']],
      ['./.github/actions/smoke', ['environment', 'role', 'release']],
    ]);
    expect(hooks[1]!.env).toBeUndefined();
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
    it('the probe run under the `no-environments` marker', () => red((w) => { delete job(w, RELEASE, 'probe').if; }, /runs under the no-environments marker/));
    it('the deploy job run whatever `declare` holds', () => red((w) => { delete job(w, ENV, 'deploy').if; }, /runs when declare holds production/));
    it("the hold moved into the caller: a fallback input on deploy.yml", () => red((w) => { w[ENV]!.on!.workflow_call!.inputs!.fallback = { type: 'string' }; }, /not the environment and its position alone/));
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

  it('times the deploy: the wait, the hooks, the job and the release lead time', () => {
    const r = row({ result: 'success', outputs: { 'started-at': T(10), 'deploy-started-at': T(11), 'deploy-ended-at': T(14), 'ended-at': T(15) } });
    expect(r).toMatchObject({ wait_ms: 600_000, deploy_ms: 180_000, smoke_ms: 60_000, duration_ms: 300_000, since_release_ms: 75 * 60_000 });
  });

  it('records the declaration\'s role, and a refused or failed declaration at the gate', () => {
    expect(row(ok, { role: 'pre-production', position: '1' })).toMatchObject({ role: 'pre-production', position: 1 });
    const refused = environmentRow({ ...RUN, NEEDS: JSON.stringify({ declare: { result: 'failure', outputs: { refusal: 'declaration-mismatch', role: 'production' } }, deploy: { result: 'skipped' } }), ENVIRONMENT: 'staging', POSITION: '2' }, { api: () => [] });
    expect(refused).toMatchObject({ outcome: 'refused', failed_stage: 'gate', refusal: 'declaration-mismatch', position: 2 });
  });

  it("a dispatch's rollback is marked; a release can't be one", () => {
    expect(environmentRow({ ...RUN, GITHUB_EVENT_NAME: 'workflow_dispatch', NEEDS: JSON.stringify({ declare: declared(), deploy: { result: 'success', outputs: { rollback: 'true', redeploy: 'false' } } }), ENVIRONMENT: 'production', POSITION: '1' }, { api: () => ({}) }))
      .toMatchObject({ trigger: 'workflow_dispatch', rollback: true });
  });

  it('writes no row for a held production, nor for a production dispatch refused to a non-Maintainer (kanon#894)', () => {
    const held = { result: 'success', outputs: { ...declared().outputs, held: 'true' } };
    expect(environmentRow({ ...RUN, NEEDS: JSON.stringify({ declare: held, deploy: { result: 'skipped' } }), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => [] })).toBeNull();
    const refused = { result: 'failure', outputs: { role: 'production', unauthorized: 'not-maintainer' } };
    expect(environmentRow({ ...RUN, NEEDS: JSON.stringify({ declare: refused, deploy: { result: 'skipped' } }), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => [] })).toBeNull();
    // MUTATION: a record that ignores the hold writes a cancelled production row here.
    expect(classifyEnvironment({ declare: held, deploy: { result: 'skipped' }, environment: 'production' })).toEqual({ outcome: 'cancelled', failed_stage: 'approval' });
  });

  it('a failed `declare` is never a hold: a non-ok row, and the report files (the #892 review)', () => {
    // `declare` failed before writing `held`, so `deploy` was skipped: the same skip a hold makes.
    const needs = { declare: { result: 'failure', outputs: {} }, deploy: { result: 'skipped', outputs: {} } };
    const r = environmentRow({ ...RUN, NEEDS: JSON.stringify(needs), ENVIRONMENT: 'production', POSITION: '2' }, { api: () => [] });
    // `gate` is the closest existing stage, pending #886.
    expect(r).toMatchObject({ outcome: 'failed', failed_stage: 'gate', role: 'production', position: 2 });
    expect(validate(r)).toEqual({ ok: true });
    const filed = reportFrom({ NEEDS: JSON.stringify({ ...needs, record: { result: 'success', outputs: { written: 'true', outcome: 'failed', stage: 'gate', refusal: '' } } }), ENVIRONMENT: 'production', POSITION: '2' }, 'environment');
    expect(filed).toMatchObject({ outcome: 'failed', failed_stage: 'gate' });
    // MUTATION: a record that treats deploy's `skipped` as the hold writes no row for this fixture.
    const skippedAsHeld = (n: typeof needs) => n.deploy.result === 'skipped' || heldOrUnrecorded(n.declare);
    expect(skippedAsHeld(needs)).toBe(true);
    expect(heldOrUnrecorded(needs.declare)).toBe(false);
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

  it('writes nothing when the run went on: the probe passed, or was skipped under the `no-environments` marker', () => {
    expect(rel({ gate: gateOk(), probe: ok })).toBeNull();
    expect(rel({ gate: gateOk('no-environments'), probe: { result: 'skipped', outputs: {} } })).toBeNull();
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
    const went = { gate: { result: 'success', outputs: {} }, probe: ok, record: { result: 'success', outputs: { written: 'false' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(went), ENVIRONMENTS: 'staging production' }, 'release')).toBeNull();
  });

  it('a held production neither files, comments nor closes; a refused non-Maintainer dispatch files as a refusal (kanon#894)', () => {
    const held = { declare: { result: 'success', outputs: { role: 'production', held: 'true' } }, deploy: { result: 'skipped' }, record: { result: 'success', outputs: { written: 'false' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(held), ENVIRONMENT: 'production', POSITION: '2' }, 'environment')).toBeNull();
    const refused = { declare: { result: 'failure', outputs: { role: 'production', unauthorized: 'not-maintainer' } }, deploy: { result: 'skipped' }, record: { result: 'success', outputs: { written: 'false' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(refused), ENVIRONMENT: 'production', POSITION: '2' }, 'environment'))
      .toMatchObject({ outcome: 'refused', refusal: 'not-maintainer', role: 'production' });
  });

  it("an environment's report reads the record's outcome, which saw the approvals, and the declaration's role", () => {
    const needs = { declare: declared('pre-production'), deploy: { result: 'failure', outputs: {} }, record: { result: 'success', outputs: { outcome: 'rejected', stage: 'approval', refusal: '' } } };
    expect(reportFrom({ NEEDS: JSON.stringify(needs), ENVIRONMENT: 'staging', POSITION: '1' }, 'environment')).toMatchObject({ outcome: 'rejected', role: 'pre-production', position: 1 });
  });
});
