import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { hookFile } from '../../cli/callers.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { REQ, checkout, fakeGitHub, hasYq, laneCheck, parse, read, run } from './helpers/kanon-init.js';

// Each case runs `kanon init` against a real git checkout (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

/**
 * #1608 and #1607 point 12: a new ci.yml runs the brief guard where a Lead lane is chosen and the
 * stack's gates after the project-setup hook, and init says when a chosen lane calls a hook that is
 * still its stub.
 */
const HOOK = REQ.hook.path;
const CI = '.github/workflows/ci.yml';
type Doc = ReturnType<typeof parse>;
const stub = (d: Doc) => d.findings.filter((f: { id: string }) => f.id === 'hook.stub');
const jobs = (dir: string) => Object.keys((parseYaml(read(dir, CI)) as { jobs: Record<string, unknown> }).jobs);
const init = async (lanes: string, files: Record<string, string> = {}, gates = 'npm test') => {
  const dir = checkout(files);
  const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--lanes', lanes, '--gates', gates]));
  return { dir, d };
};

describe('kanon init and the jobs of a new ci.yml', () => {
  it('writes the Brief guard job with a Lead lane, and the Gates job from the gates answer', async () => {
    const { dir } = await init('review,lead');
    expect(jobs(dir)).toEqual(['lanes', 'gates', 'brief-guard']);
    const wf = parseYaml(read(dir, CI)) as { jobs: Record<string, { steps: Array<{ uses?: string; run?: string }> }> };
    expect(wf.jobs.gates!.steps.map((s) => s.uses ?? s.run)).toEqual(['actions/checkout@v7', './.github/actions/project-setup', 'npm test']);
  });

  it.skipIf(!hasYq)('writes a ci.yml that lane-check passes, the brief guard pinned with the rest', async () => {
    // With the Apps' stub, which writes the register the callers need.
    const dir = checkout();
    expect((await run(dir, fakeGitHub(), ['--yes', '--lanes', 'review,lead', '--gates', 'npm test'])).status).toBe(0);
    expect(jobs(dir)).toContain('brief-guard');
    const lc = laneCheck(dir);
    expect(lc.status, lc.out).toBe(0);
  }, 30_000);

  it('writes neither without a Lead lane or a gate', async () => {
    const { dir } = await init('review', {}, 'none');
    expect(jobs(dir)).toEqual(['lanes']);
  });

  it('leaves a ci.yml the project has alone', async () => {
    const own = 'name: CI\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n';
    const { dir } = await init('review,lead', { [CI]: own });
    expect(read(dir, CI)).toBe(own);
  });
});

describe('kanon init and a stub project-setup hook (hook.stub)', () => {
  it('reports the stub it writes while a chosen lane calls the hook, naming the lanes', async () => {
    const { d } = await init('review,rebase', {}, 'none');
    expect(stub(d)).toEqual([expect.objectContaining({ id: 'hook.stub', category: 'hook', blocking: false, subject: HOOK })]);
    expect(stub(d)[0]!.message).toContain('agent-rebase calls it');
  });

  it("counts the Gates job it writes into a new ci.yml as a caller, so the Review feature's gates are named too", async () => {
    const { d } = await init('review');
    expect(stub(d)).toHaveLength(1);
    expect(stub(d)[0]!.message).toContain('.github/workflows/ci.yml job gates calls it');
  });

  it('reports a stub the project kept as it was', async () => {
    const { d } = await init('review,rebase', { [HOOK]: hookFile(REQ.hook.inputs) });
    expect(stub(d)).toHaveLength(1);
  });

  it('is quiet where no chosen lane calls the hook, or the hook installs something', async () => {
    // The review lane and the Lead's brief lane never call it, and with no gate no Gates job does.
    expect(stub((await init('review,lead', {}, 'none')).d)).toEqual([]);
    const filled = hookFile(REQ.hook.inputs).replace(/run: echo[^\n]*/, 'run: npm ci');
    expect(stub((await init('review,rebase', { [HOOK]: filled })).d)).toEqual([]);
  });
});
