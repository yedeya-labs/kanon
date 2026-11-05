import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { briefGuardJob, briefGuardJobs, ciFile, hookFile, isStubHook, LEAD_LANES } from '../../cli/callers.mjs';

/**
 * The jobs `kanon init` writes into a new ci.yml (#1608, #1607 point 12): Kanon's brief guard where a
 * Lead lane is chosen, and the stack document's gates after the project-setup hook; and the action
 * the first one calls, `actions/brief-guard`.
 */
const ROOT = join(import.meta.dirname, '..', '..');
type Step = { uses?: string; run?: string; name?: string; with?: Record<string, string>; env?: Record<string, string>; id?: string };
type Job = { name?: string; permissions?: Record<string, string>; steps: Step[] };
const ci = (o?: Parameters<typeof ciFile>[2]) => parse(ciFile('v9.9.9', 'main', o)) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kanon-brief-guard-'));
  dirs.push(d);
  return d;
};

describe('ciFile', () => {
  it('writes the lane check alone, as before, with no gates and no Lead lane', () => {
    expect(Object.keys(ci().jobs)).toEqual(['lanes']);
  });

  it('adds the Brief guard job, at the release, with issues: read, where asked', () => {
    const wf = ci({ briefGuard: true });
    expect(Object.keys(wf.jobs)).toEqual(['lanes', 'brief-guard']);
    const job = wf.jobs['brief-guard']!;
    expect(job.name).toBe('Brief guard');
    expect(job.permissions).toEqual({ contents: 'read', issues: 'read' });
    expect(job.steps.map((s) => s.uses)).toEqual(['actions/checkout@v7', 'yedeya-labs/kanon/actions/brief-guard@v9.9.9']);
    // The doctor's fix is the same job.
    expect(ciFile('v9.9.9', 'main', { briefGuard: true })).toContain(briefGuardJob('v9.9.9').join('\n'));
  });

  it('adds the Gates job: the project-setup hook, then each gate in order, and no language setup of its own (#15)', () => {
    const wf = ci({ gates: ['npm test', 'npm run build', 'echo "a: b"'] });
    expect(Object.keys(wf.jobs)).toEqual(['lanes', 'gates']);
    const job = wf.jobs.gates!;
    expect(job.name).toBe('Gates');
    expect(job.steps.map((s) => s.uses ?? s.run)).toEqual(['actions/checkout@v7', './.github/actions/project-setup', 'npm test', 'npm run build', 'echo "a: b"']);
    expect(job.steps[1]!.with).toEqual({ lane: 'ci', install: 'true', database: 'false' });
    expect(ci({ gates: ['npm test'], database: true }).jobs.gates!.steps[1]!.with!.database).toBe('true');
    expect(ciFile('v9.9.9', 'main', { gates: ['npm test'] })).not.toMatch(/setup-node|setup-python|setup-go/);
    // No gate, no job.
    expect(Object.keys(ci({ gates: [], briefGuard: true }).jobs)).toEqual(['lanes', 'brief-guard']);
  });

  it('names the four Lead lanes, each a lane of the release', () => {
    const req = JSON.parse(readFileSync(join(ROOT, 'requirements.json'), 'utf8')) as { lanes: Record<string, unknown> };
    expect(LEAD_LANES).toEqual(['agent-lead', 'agent-lead-revise', 'agent-lead-split', 'agent-lead-reconcile']);
    for (const l of LEAD_LANES) expect(req.lanes[l], l).toBeDefined();
  });
});

describe('briefGuardJobs: the jobs that run the brief guard on pull requests', () => {
  const wf = (on: unknown, step: Step) => ({ on, jobs: { g: { steps: [{ uses: 'actions/checkout@v7' }, step] } } });
  it('finds the action at a pin, and the script run from kanon-path', () => {
    expect(briefGuardJobs(new Map([['.github/workflows/ci.yml', parse(ciFile('v1.0.0', 'main', { briefGuard: true }))]]))).toEqual(['.github/workflows/ci.yml job brief-guard']);
    expect(briefGuardJobs(new Map([['a.yml', wf({ pull_request: { paths: ['docs/projects/**'] } }, { run: 'node "$KANON/scripts/brief-guard.mjs"' })]]))).toEqual(['a.yml job g']);
    expect(briefGuardJobs(new Map([['a.yml', wf(['push', 'pull_request'], { uses: 'yedeya-labs/kanon/actions/brief-guard@v1.0.0' })]]))).toEqual(['a.yml job g']);
    expect(briefGuardJobs(new Map([['a.yml', wf('pull_request', { uses: 'yedeya-labs/kanon/actions/brief-guard@v1.0.0' })]]))).toEqual(['a.yml job g']);
  });

  it('finds none in a workflow that runs on no pull request, or with no such step', () => {
    expect(briefGuardJobs(new Map([['a.yml', wf({ push: null }, { uses: 'yedeya-labs/kanon/actions/brief-guard@v1.0.0' })]]))).toEqual([]);
    expect(briefGuardJobs(new Map([['a.yml', wf({ pull_request: null }, { run: 'node scripts/spec-guard.mjs' })]]))).toEqual([]);
    expect(briefGuardJobs(new Map([['.github/workflows/ci.yml', parse(ciFile('v1.0.0', 'main'))]]))).toEqual([]);
  });
});

describe('isStubHook', () => {
  it("knows init's starting hook, whatever its inputs", () => {
    expect(isStubHook(hookFile(['lane', 'install']), parse)).toBe(true);
    expect(isStubHook(hookFile([]).replace(/^#.*\n/gm, ''), parse)).toBe(true);
  });

  it('calls a hook with a step of the project\'s own, or one that does not parse, or none, no stub', () => {
    const filled = hookFile(['lane']).replace(/ {4}- shell: bash\n {6}run: echo[^\n]*\n/, '    - uses: actions/setup-node@v4\n    - shell: bash\n      run: npm ci\n');
    expect(filled).not.toBe(hookFile(['lane']));
    expect(isStubHook(filled, parse)).toBe(false);
    expect(isStubHook(`${hookFile(['lane'])}    - shell: bash\n      run: npm ci\n`, parse)).toBe(false);
    expect(isStubHook('runs: [', parse)).toBe(false);
    expect(isStubHook(null, parse)).toBe(false);
  });
});

describe('actions/brief-guard', () => {
  const action = parse(readFileSync(join(ROOT, 'actions/brief-guard/action.yml'), 'utf8')) as { inputs?: unknown; runs: { using: string; steps: Step[] } };

  it("runs Kanon's guard from kanon-path, at the pin, with the workflow token, and takes no inputs", () => {
    expect(action.inputs).toBeUndefined();
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps[0]).toEqual({ uses: '$/actions/kanon-path', id: 'kanon' });
    expect(action.runs.steps[1]!.env).toEqual({ KANON: '${{ steps.kanon.outputs.path }}', GH_TOKEN: '${{ github.token }}' });
    expect(action.runs.steps[1]!.run).toContain('node "$KANON/scripts/brief-guard.mjs"');
  });

  /** The action's step, run in `cwd` against this tree's guard. */
  const step = (cwd: string) =>
    spawnSync('bash', ['-c', action.runs.steps[1]!.run!], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, KANON: ROOT, BRIEF_GUARD_SKIP_TRACKING_ISSUES: '1', GIT_CONFIG_NOSYSTEM: '1' } });
  const repo = (files: Record<string, string>) => {
    const d = temp();
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(d, rel, '..'), { recursive: true });
      writeFileSync(join(d, rel), text);
    }
    spawnSync('git', ['add', '-A'], { cwd: d });
    return d;
  };

  it('passes a repository with no brief yet, saying so, which the guard alone fails', () => {
    const d = repo({ 'docs/projects/_template.md': readFileSync(join(ROOT, 'rulebook/templates/brief.md'), 'utf8') });
    const r = step(d);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('no brief under docs/projects/ yet');
    const alone = spawnSync('node', [join(ROOT, 'scripts/brief-guard.mjs')], { cwd: d, encoding: 'utf8', env: { ...process.env, BRIEF_GUARD_SKIP_TRACKING_ISSUES: '1' } });
    expect(alone.status).not.toBe(0);
  });

  it('runs the guard on a brief, and fails a broken one', () => {
    const r = step(repo({ 'docs/projects/12.md': '# Not a brief\n' }));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('nothing to check');
  });

  it('fails outside a checkout, rather than passing', () => {
    const r = step(temp());
    expect(r.status).not.toBe(0);
  });
});
