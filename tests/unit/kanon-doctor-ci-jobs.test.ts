import { describe, expect, it, vi } from 'vitest';
import { briefGuardJob, callerFile, ciFile, hookFile } from '../../cli/callers.mjs';
import { FINDINGS } from '../../scripts/lib/waivers.mjs';
import { checkout, fakeGitHub, healthyFiles, PINNED, REQ, run, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

/**
 * #1608 and #1607 point 12: doctor notes a Lead lane with no CI job that runs the brief guard
 * (`ci.brief-guard-missing`), and a lane that calls a project-setup hook still as init's stub
 * (`hook.stub`). Both are notes.
 */
const CI = '.github/workflows/ci.yml';
const withLane = (lane: string, files = healthyFiles()) => {
  files[`.github/workflows/${lane}.yml`] = callerFile(lane, REQ.lanes[lane]!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
  return files;
};
const of = (r: Result, id: string) => r.json.findings.filter((f: { id: string }) => f.id === id);

describe('ci.brief-guard-missing', () => {
  it('is a note, in the declaration category', () => {
    expect(FINDINGS['ci.brief-guard-missing']).toEqual({ category: 'declaration', blocking: false });
  });

  it("names a Lead lane with no job that runs the guard, with the job to add at the checked release", async () => {
    const r = await run(checkout(withLane('agent-lead-reconcile')), fakeGitHub(), ['--json']);
    expect(of(r, 'ci.brief-guard-missing')).toEqual([{
      id: 'ci.brief-guard-missing',
      category: 'declaration',
      blocking: false,
      subject: CI,
      message: expect.stringContaining('agent-lead-reconcile is installed'),
      fix: { text: expect.stringContaining(`(${PINNED})`), commands: briefGuardJob(PINNED), url: null },
    }]);
  });

  it("is quiet once ci.yml runs the guard, or a workflow runs Kanon's script, or no Lead lane is installed", async () => {
    const files = withLane('agent-lead');
    files[CI] = ciFile(PINNED, 'main', { briefGuard: true });
    expect(of(await run(checkout(files), fakeGitHub(), ['--json']), 'ci.brief-guard-missing')).toEqual([]);
    const script = withLane('agent-lead');
    script['.github/workflows/guards.yml'] = `name: Guards\non:\n  pull_request:\n    paths: [docs/projects/**]\npermissions:\n  contents: read\njobs:\n  brief:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      issues: read\n    steps:\n      - uses: actions/checkout@v7\n      - uses: yedeya-labs/kanon/actions/kanon-path@${PINNED}\n      - run: node "$KANON/scripts/brief-guard.mjs"\n`;
    expect(of(await run(checkout(script), fakeGitHub(), ['--json']), 'ci.brief-guard-missing')).toEqual([]);
    expect(of(await run(checkout(healthyFiles()), fakeGitHub(), ['--json']), 'ci.brief-guard-missing')).toEqual([]);
  });
});

describe('hook.stub', () => {
  it('is a note, in the declaration category', () => {
    expect(FINDINGS['hook.stub']).toEqual({ category: 'declaration', blocking: false });
  });

  it("names a lane that calls a hook still as init's stub", async () => {
    const r = await run(checkout(withLane('agent-rebase')), fakeGitHub(), ['--json']);
    expect(of(r, 'hook.stub')).toEqual([expect.objectContaining({ category: 'declaration', blocking: false, subject: REQ.hook.path, message: expect.stringContaining('agent-rebase calls it') })]);
  });

  it('is quiet where the hook installs something, or no installed lane calls it', async () => {
    const files = withLane('agent-rebase');
    files[REQ.hook.path] = hookFile(REQ.hook.inputs).replace(/run: echo[^\n]*/, 'run: npm ci');
    expect(of(await run(checkout(files), fakeGitHub(), ['--json']), 'hook.stub')).toEqual([]);
    // The healthy fixture's review and code-audit lanes never call it, and its hook is the stub.
    expect(of(await run(checkout(healthyFiles()), fakeGitHub(), ['--json']), 'hook.stub')).toEqual([]);
  });
});
