import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep, agentPrompt, type WorkflowStep } from './helpers/workflow-step.js';
import { effectiveSteps, laneBlockOf, stepsAsRun } from './helpers/spine.js';
import { LANE_BLOCKS, STAGE_BLOCKS, laneBlockPath } from './helpers/agent-lanes.mjs';
import { FINDING_ANCHOR } from '../../scripts/project-closure.mjs';

/**
 * RA-1068 — the Explorer's targeted-invariant mode, a Kanon lane since step 4 of plan 0001.
 *
 * Same shape as its sweep: a deterministic producer writes JSON, and the agent reads the
 * artifact and files issues. The producer here is Kanon's `scripts/verify-acs.mjs`, read from
 * the action cache through `kanon-path`.
 *
 * Halves that stay in the reference adopter: "the playbook and the prompt agree" (RA-1082),
 * which reads its `docs/qa/explorer-playbook.md`; and the hook's own content (its `npm ci`,
 * `db:init` and Chromium), which is the adopter's hook, not Kanon's.
 */
type Step = WorkflowStep & { with?: Record<string, unknown> };
type Wf = {
  on: { workflow_call: { inputs: Record<string, { required?: boolean; type?: string }>; secrets: Record<string, { required?: boolean }> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; needs?: string; uses?: string; outputs?: Record<string, string>; services?: { postgres?: unknown }; env?: Record<string, string>; steps: Step[] }>;
};
const FILE = join(process.cwd(), '.github/workflows/agent-verify-acs.yml');
const raw = readFileSync(FILE, 'utf8');
const wf = parse(raw) as Wf;
const steps: Step[] = wf.jobs.verify!.steps;
// THROUGH THE BLOCKS (RA-2661): the job calls `agent-run`, so the prompt is read off the
// claude-code-action step as the job RUNS it, with the call's literal inputs substituted.
const prompt: string = agentPrompt(effectiveSteps(steps));
const flat = prompt.replace(/\s+/g, ' ');
const step = (needle: string): Step =>
  steps.find((s) => s.name?.includes(needle) || s.uses?.includes(needle) || s.run?.includes(needle))!;

describe('a Kanon lane, called by a trigger-only caller', () => {
  it('is a reusable workflow taking the dispatch inputs as optional strings, and the Explorer’s secrets by their fixed names', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    const { inputs, secrets } = wf.on.workflow_call;
    expect(Object.keys(inputs).sort()).toEqual(['project', 'ref']);
    for (const i of Object.values(inputs)) expect(i).toMatchObject({ required: false, type: 'string' });
    expect(Object.keys(secrets).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'EXPLORER_APP_ID', 'EXPLORER_APP_PRIVATE_KEY']);
    for (const s of Object.values(secrets)) expect(s.required).toBe(true);
    expect(raw).not.toMatch(/QA_EXPLORER/);
  });

  it('starts only on `qa:verify` or a dispatch, in a filter job that holds the membership gate', () => {
    const filter = wf.jobs.filter!;
    expect(String(filter.if)).toContain("github.event_name == 'workflow_dispatch'");
    expect(String(filter.if)).toContain("github.event.label.name == 'qa:verify'");
    expect(filter.steps.map((s) => s.uses ?? s.id)).toEqual(['$/actions/kanon-path', 'gate']);
    expect(filter.outputs?.member).toBe('${{ steps.gate.outputs.member }}');
    expect(wf.jobs.verify!.needs).toBe('filter');
    expect(wf.jobs.verify!.if).toBe("needs.filter.outputs.member == 'true'");
  });

  it('runs Kanon’s producer from the action cache, never the checkout', () => {
    const at = steps.findIndex((s) => s.uses === '$/actions/kanon-path');
    const run = steps.findIndex((s) => s.name?.includes('Resolve and run'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(run);
    expect(steps[run]!.run).toContain('node "$KANON/scripts/verify-acs.mjs"');
    expect(raw).not.toMatch(/node (\.\/)?scripts\/|\.kanon\/scripts/);
  });
});

describe('what it verifies, and at which ref', () => {
  it('checks out the REQUESTED ref, not always the default branch', () => {
    // Verifying a tag's code against a newer brief's criteria would judge a release by
    // acceptance criteria it never had. The ref comes from `resolve`, authoritative for
    // BOTH triggers (RA-1281).
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout'))!;
    expect(String(checkout.with?.ref)).toContain('steps.resolve.outputs.ref');
    const resolve = steps.findIndex((s) => s.id === 'resolve');
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeLessThan(steps.findIndex((s) => s.uses?.startsWith('actions/checkout')));
  });

  it('prints the tag ONCE when there is one, and says so when there is not', () => {
    // `${TAG:-x}` is not an else-branch for `${TAG:+y}`. Executed, both ways, into a real
    // temp file (appending to /dev/stdout differs between Linux and macOS).
    const run = (tag: string) => {
      const original = step('Say what is being verified');
      const script = String(original.run)
        .replace('TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"', `TAG='${tag}'`)
        .replace('SHA="$(git rev-parse HEAD)"', "SHA='abc1234'");
      const r = runWorkflowStep({ ...original, run: script }, { env: { REQUESTED: 'v1.2.3' } });
      expect(r.status, `step aborted under the runner's shell: ${r.output}`).toBe(0);
      return r.summary;
    };
    // Guard the guard: a `.replace` that silently matched nothing would run real git here.
    const src = String(step('Say what is being verified').run);
    expect(src).toContain('TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"');
    expect(src).toContain('SHA="$(git rev-parse HEAD)"');

    const tagged = run('v1.2.3').split('\n').find((l) => l.includes('tagged release')) ?? '';
    expect(tagged.match(/v1\.2\.3/g) ?? []).toHaveLength(1);
    expect(run('')).toMatch(/not a released commit/);
  });
});

describe('the artifact is the contract', () => {
  it('lets a FAILING criterion through — it is the finding, not a broken job', () => {
    expect(step('Resolve and run')['continue-on-error']).toBe(true);
  });
  it('but a MISSING artifact fails the job loudly', () => {
    const guard = String(step('The artifact must exist').run);
    expect(guard).toContain('::error');
    expect(guard).toContain('exit 1');
    expect(guard).toMatch(/NOT 'no criteria to verify'/);
  });
  it('uploads it with if-no-files-found: error', () => {
    expect(steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))!.with?.['if-no-files-found']).toBe('error');
  });
  it('runs the producer with --run and --json, not resolution only', () => {
    expect(step('Resolve and run').run).toContain('--run');
    expect(step('Resolve and run').run).toContain('--json=qa-verify-acs.json');
  });
});

describe('the prompt', () => {
  it('files a finding ONLY for a failed criterion', () => {
    expect(flat).toMatch(/FILE ONE FINDING PER FAILED CRITERION, and nothing for any other status/);
    expect(flat).toMatch(/`unverifiable` and `not-run` are NOT findings against the project/);
  });
  it('requires the project marker, from the RESOLVED project, as the LAST line', () => {
    expect(prompt).toContain('<!-- qa:project ${{ steps.resolve.outputs.project }} -->');
    expect(flat).toMatch(/must be the LAST non-empty line/);
    expect(flat).toMatch(/merely QUOTES it is not a member/);
  });
  it('distinguishes "everything passed" from "nothing was verifiable"', () => {
    expect(flat).toMatch(/A run that files nothing because everything passed and a run that files nothing because nothing was verifiable are DIFFERENT outcomes/);
  });
  it('leaves the verification marker the round cap counts (RA-1088)', () => {
    expect(prompt).toContain('<!-- qa:verified -->');
    expect(flat).toMatch(/present even when everything passed and even when you filed nothing/);
  });
  it('closes the QA issue only when every criterion passed', () => {
    expect(flat).toMatch(/CLOSE THAT ISSUE ONLY IF EVERY CRITERION PASSED/);
    expect(flat).toMatch(/`unverifiable` or `not-run` criterion means the project is not verified/);
  });
  it('withholds promotion and code edits', () => {
    expect(flat).toMatch(/DO NOT edit code/);
    expect(flat).toMatch(/promotion is a human act/);
  });
  it('tells the agent the producer already ran', () => {
    expect(flat).toMatch(/has ALREADY RUN/);
    expect(flat).toMatch(/Do NOT run it yourself/);
  });
  it('demands the phase-5 anchor the reconciler reads, verbatim (RA-1783)', () => {
    expect(prompt).toContain(FINDING_ANCHOR);
    expect(flat).toMatch(/MUST ALSO contain, verbatim and with its parentheses, the text `\(targeted-invariant mode\)`/);
  });
  it('never calls the environment staging', () => {
    expect(flat).toMatch(/NOT staging/);
  });
});

describe('scope and cost', () => {
  it('serialises runs per project', () => {
    expect(wf.concurrency.group).toContain('agent-verify-acs-');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });
  it('declares exactly the permissions it declares', () => {
    expect(wf.permissions).toEqual({ contents: 'read', issues: 'read' });
  });
});

describe('nothing reads inputs.project on the label route (RA-1285)', () => {
  it('leaves only the uses that are correct by design', () => {
    const uses = raw.split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /inputs\.(project|ref)/.test(line) && !line.trim().startsWith('#'));
    // 1. `concurrency.group`, evaluated before any step runs; 2/3. the `resolve` step's own env.
    const allowed = /concurrency|group:|DISPATCH_PROJECT|DISPATCH_REF/;
    expect(uses.filter(([, line]) => !allowed.test(line)).map(([n, l]) => `${n}: ${l.trim()}`), 'must use steps.resolve.outputs').toEqual([]);
    expect(uses.length, 'and the three legitimate uses must still be there').toBe(3);
  });
  it('the project marker is stamped from the resolved value', () => {
    expect(raw).toContain('<!-- qa:project ${{ steps.resolve.outputs.project }} -->');
    expect(raw).not.toContain('<!-- qa:project ${{ inputs.project }} -->');
  });
});

/**
 * RA-2661 — the lane keeps its own job and calls the agent-lane blocks around its own steps:
 * the criteria run and the agent share ONE workspace and ONE database.
 */
describe('the criteria run shares the agent’s job, workspace and database (RA-2661)', () => {
  const idx = (pred: (s: Step) => boolean) => steps.findIndex(pred);
  const call = (block: string) => idx((s) => laneBlockOf(s) === block);
  const named = (needle: string) => idx((s) => String(s.name ?? '').includes(needle));
  const restore = () => steps[named('Put the ref under test back exactly as it is')]!;
  const hookCall = () => steps[idx((s) => s.uses === './.github/actions/project-setup')]!;
  const hookLoad = () => steps[named('Load the project-setup hook from the commit that defined this lane')]!;

  it('is one job that runs its own steps, never a caller of the spine', () => {
    expect(Object.keys(wf.jobs)).toEqual(['filter', 'verify']);
    expect(wf.jobs.verify!.uses).toBeUndefined();
    // The database is the project's declaration (kanon#18), started by a step, never a service.
    expect(wf.jobs.verify!.services).toBeUndefined();
    expect(wf.jobs.verify!.env?.DATABASE_URL).toBeUndefined();
    expect(steps.filter((s) => laneBlockOf(s)).map((s) => laneBlockOf(s))).toEqual([...STAGE_BLOCKS]);
  });

  it('runs the criteria, checks and uploads the artifact, and mints the App — in that order, between setup and the agent', () => {
    // The hook runs whatever the adopter's hook runs; Kanon only passes it the switches.
    expect(stepsAsRun([hookCall()]).length).toBeGreaterThan(0);
    const order = [
      steps.indexOf(hookLoad()),
      steps.indexOf(hookCall()),
      call('agent-setup'),
      named('Put the ref under test back exactly as it is'),
      named('Resolve and run the project\'s acceptance criteria'),
      named('The artifact must exist'),
      idx((s) => String(s.uses).startsWith('actions/upload-artifact')),
      idx((s) => s.id === 'app-token'),
      call('agent-run'),
      call('agent-finish'),
    ];
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the App identity where it was: minted after the criteria run, immediately before the agent', () => {
    expect(steps[call('agent-setup')]!.with).toEqual({ arm: 'acceptance-criteria agent', 'app-slug': '' });
    expect(hookCall().with).toEqual({ lane: 'verify-acs', install: 'true', database: '${{ steps.database.outputs.database }}', browsers: 'true' });
    const mint = steps[idx((s) => s.id === 'app-token')]!;
    expect(mint.with?.['client-id']).toBe('${{ secrets.EXPLORER_APP_ID }}');
    expect(mint.with?.['private-key']).toBe('${{ secrets.EXPLORER_APP_PRIVATE_KEY }}');
    expect(steps[call('agent-run')]!.with?.['github-token']).toBe('${{ steps.app-token.outputs.token }}');
  });

  it('puts the ref under test back before verifying it, and puts nothing in the tree for the agent', () => {
    expect(restore().if).toBeUndefined();
    expect(restore().env).toBeUndefined();
    expect(restore().run).toBe('git restore --source=HEAD --staged --worktree -- .github/actions/project-setup');
    expect(steps.indexOf(restore())).toBeGreaterThan(call('agent-setup'));
    expect(steps.indexOf(restore())).toBeLessThan(named('Resolve and run the project\'s acceptance criteria'));
    const between = steps.slice(steps.indexOf(restore()) + 1, call('agent-run'));
    expect(between.filter((s) => /\.github\//.test(String(s.run ?? ''))).map((s) => s.name)).toEqual([]);
    // The hook's load is the hook's own, from `github.sha` — in a called workflow the
    // CALLER's commit — and the blocks are Kanon's, through `$/`.
    expect(hookLoad().env).toEqual({ SHA: '${{ github.sha }}' });
    expect(steps.filter((s) => laneBlockOf(s)).every((s) => String(s.uses).startsWith('$/actions/'))).toBe(true);
    expect(hookCall().uses).toBe('./.github/actions/project-setup');
  });

  it('records and explains the run under its own arm, with the flags that ran', () => {
    const run = steps[call('agent-run')]!;
    const finish = steps[call('agent-finish')]!;
    expect(finish.with?.agent).toBe('verify-acs');
    expect(finish.with?.arm).toBe('acceptance-criteria agent');
    expect(finish.with?.claude_args).toBe(run.with?.claude_args);
    expect(finish.with?.['execution_file']).toBe('${{ steps.agent.outputs.execution_file }}');
  });

  // RUN FOR REAL (RA-1044): an adopter release tag cut before the blocks moved to Kanon, one
  // whose copies of them differ, and one with today's. The criteria run must see the tag byte
  // for byte, with the hook from the defining commit loaded and taken back out.
  describe('against real git, at a tag', () => {
    let root = '';
    let work = '';
    let sha = '';
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const runStep = (s: Step, env: Record<string, string>) => runWorkflowStep(s, { cwd: work, env });
    const HOOK = '.github/actions/project-setup/action.yml';
    const HOOK_SOURCE = readFileSync(laneBlockPath('project-setup'), 'utf8');
    const taggedBlockPath = (name: string) => `.github/actions/${name}/action.yml`;
    const writeBlocks = (dir: string, body: (name: string) => string) => {
      for (const name of LANE_BLOCKS) {
        mkdirSync(join(dir, '.github/actions', name), { recursive: true });
        writeFileSync(join(dir, taggedBlockPath(name)), body(name));
      }
    };

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'verify-acs-'));
      work = join(root, 'work');
      mkdirSync(work);
      git(work, 'init', '-q', '-b', 'main');
      git(work, 'config', 'user.email', 't@example.com');
      git(work, 'config', 'user.name', 't');
      writeFileSync(join(work, 'README.md'), 'x\n');
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', 'base');
      git(work, 'tag', 'v-before');
      writeBlocks(work, (n) => `# ${n} as the tag had it\n`);
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', 'old blocks');
      git(work, 'tag', 'v-old-blocks');
      writeBlocks(work, (n) => readFileSync(laneBlockPath(n), 'utf8'));
      mkdirSync(join(work, '.github/actions/project-setup'), { recursive: true });
      writeFileSync(join(work, HOOK), HOOK_SOURCE);
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', 'the commit that defined the lane, with its hook');
      sha = git(work, 'rev-parse', 'HEAD');
      git(work, 'tag', 'v-same-blocks');
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const putBack = () => steps.find((s) => s.name === 'Put the project-setup hook back for its post steps')!;
    const taggedHook = () => (existsSync(join(work, HOOK)) ? readFileSync(join(work, HOOK), 'utf8') : null);

    it.each(['v-before', 'v-old-blocks', 'v-same-blocks'])('%s: verified as tagged, and handed to the agent as tagged', (tag) => {
      git(work, 'checkout', '-q', '-f', tag);
      git(work, 'clean', '-qfdx');
      const tagged = (n: string) => (existsSync(join(work, taggedBlockPath(n))) ? readFileSync(join(work, taggedBlockPath(n)), 'utf8') : null);
      const before = LANE_BLOCKS.map(tagged);
      const hookBefore = taggedHook();

      const hook = runStep(hookLoad(), { SHA: sha });
      expect(hook.status, hook.output).toBe(0);
      expect(hook.outputs.sha).toBe(sha);
      expect(taggedHook(), 'the hook the lane calls is the defining commit\'s').toBe(HOOK_SOURCE);
      if (tag !== 'v-same-blocks') {
        expect(git(work, 'status', '--porcelain', '--untracked-files=all'), 'the load changed the tree').not.toBe('');
      }

      const restored = runStep(restore(), {});
      expect(restored.status, restored.output).toBe(0);
      expect(git(work, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(LANE_BLOCKS.map(tagged)).toEqual(before);
      expect(taggedHook()).toBe(hookBefore);

      const hookBack = runStep(putBack(), { SHA: hook.outputs.sha! });
      expect(hookBack.status, hookBack.output).toBe(0);
      expect(taggedHook(), 'the hook is back for its post step').toBe(HOOK_SOURCE);
      expect(LANE_BLOCKS.map(tagged)).toEqual(before);
    });
  });
});
