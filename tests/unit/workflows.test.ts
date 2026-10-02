import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: unknown;
};
type Job = {
  name?: string;
  if?: string;
  strategy?: unknown;
  permissions?: Record<string, string>;
  uses?: string;
  concurrency?: unknown;
  steps: Step[];
};
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };

const load = (name: string): { text: string; wf: Workflow } => {
  const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
  return { text, wf: parse(text) as Workflow };
};
const stepsOf = (wf: Workflow): Step[] => Object.values(wf.jobs).flatMap((job) => job.steps ?? []);

const ON_PULL_REQUEST = "github.event_name == 'pull_request'";
const ON_MERGE_GROUP = "github.event_name == 'merge_group'";

// A check that reads the pull request has nothing to read on merge_group, so on that
// event it runs one step that passes, and its real steps only on pull_request. Every
// step is gated one way or the other, so neither event runs both, or neither.
const expectPassesOnMergeGroup = (wf: Workflow, action: string) => {
  const steps = stepsOf(wf);
  const real = steps.filter((s) => s.uses === action || s.uses?.startsWith('actions/checkout@'));
  expect(real.map((s) => s.uses)).toEqual([action]);
  for (const s of real) expect(s.if).toBe(ON_PULL_REQUEST);
  const passes = steps.filter((s) => s.if === ON_MERGE_GROUP);
  expect(passes).toHaveLength(1);
  expect(passes[0]?.uses).toBeUndefined();
  expect(steps.filter((s) => s.if !== ON_PULL_REQUEST && s.if !== ON_MERGE_GROUP)).toEqual([]);
};

describe('CI runs lint, type-check and unit tests on every pull request', () => {
  const { wf } = load('ci.yml');
  const runs = stepsOf(wf).map((s) => s.run ?? '');

  it('triggers on pull_request, and on merge_group so the merge queue tests the combined commit', () => {
    expect(Object.keys(wf.on)).toContain('pull_request');
    expect(Object.keys(wf.on)).toContain('merge_group');
  });

  it('runs all three, none of them allowed to fail', () => {
    for (const command of ['npm run lint', 'npm run typecheck', 'npm test']) expect(runs).toContain(command);
    const steps = stepsOf(wf);
    expect(steps.filter((s) => s['continue-on-error'])).toEqual([]);
  });

  it('reads contents only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeUndefined();
  });
});

describe('K-SHIP-4 Kanon dogfoods its PR-title action', () => {
  const { wf, text } = load('pr-title.yml');

  it('runs on pull requests, including title edits, and on merge_group', () => {
    expect(wf.on.pull_request).toMatchObject({ types: expect.arrayContaining(['opened', 'edited', 'synchronize']) });
    expect(Object.keys(wf.on)).toContain('merge_group');
  });

  it('checks the title on pull requests only, and passes on merge_group', () => {
    expectPassesOnMergeGroup(wf, '$/actions/pr-title');
  });

  it('uses the action through the self-reference, which needs no checkout (plan 0001 §4)', () => {
    const uses = stepsOf(wf).map((s) => s.uses);
    expect(uses).toContain('$/actions/pr-title');
    expect(uses.filter((u) => u?.startsWith('actions/checkout@'))).toEqual([]);
  });

  it('reads contents only, and never interpolates the title itself', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(text).not.toContain('github.event.pull_request.title');
  });
});

describe('ADR 0010 Kanon dogfoods its DCO action', () => {
  const { wf } = load('dco.yml');

  it('runs on pull requests opened, pushed to and reopened, and on merge_group', () => {
    expect(wf.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] }, merge_group: null });
  });

  it('checks the commits on pull requests only, and passes on merge_group', () => {
    expectPassesOnMergeGroup(wf, '$/actions/dco');
  });

  it('uses the action through the self-reference, which needs no checkout (plan 0001 §4)', () => {
    const uses = stepsOf(wf).map((s) => s.uses);
    expect(uses).toContain('$/actions/dco');
    expect(uses.filter((u) => u?.startsWith('actions/checkout@'))).toEqual([]);
  });

  it('reads contents and pull requests only, and grants nothing per job', () => {
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeUndefined();
  });

  it('interpolates no expression into any run line', () => {
    for (const s of stepsOf(wf)) expect(s.run ?? '').not.toContain('${{');
  });
});

describe('K-SHIP-7 the reusable release workflow', () => {
  const { wf, text } = load('release.yml');
  const jobs = Object.values(wf.jobs);
  const steps = stepsOf(wf);
  // Throws when no step matches, so an ordering assertion can never compare against -1.
  const index = (predicate: (s: Step) => boolean) => {
    const i = steps.findIndex(predicate);
    if (i < 0) throw new Error(`no step matches ${predicate.toString()}`);
    return i;
  };
  const guard = steps.find((s) => s.id === 'merge-settings');
  const release = steps.find((s) => s.uses?.startsWith('googleapis/release-please-action@'));
  const explain = steps.find((s) => s.name === 'Explain a failed release');
  const moveTag = steps.find((s) => s.run?.includes('git/refs'));

  it('is called, never triggered, and takes no inputs or secrets (ADR 0002)', () => {
    expect(wf.on).toEqual({ workflow_call: null });
  });

  it('grants nothing at the top, and exactly contents and pull-requests write on its one job', () => {
    expect(wf.permissions).toEqual({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
  });

  it('never cancels a release in progress', () => {
    expect(jobs[0]?.concurrency).toEqual({ group: 'kanon-release', 'cancel-in-progress': false });
  });

  it('checks the merge settings first, before release-please, with the workflow token', () => {
    expect(index((s) => s.id === 'merge-settings')).toBe(0);
    expect(index((s) => s.id === 'release')).toBeGreaterThan(0);
    expect(guard?.shell).toBe('node {0}');
    expect(guard?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(guard?.run).toContain('`repos/${repo}`');
    expect(guard?.run).toContain('process.env.GITHUB_REPOSITORY');
  });

  it('runs release-please v5 against the repository config and manifest, and lets it fail the job', () => {
    expect(release?.uses).toBe('googleapis/release-please-action@v5');
    expect(release?.id).toBe('release');
    expect(release?.with).toEqual({
      'config-file': 'release-please-config.json',
      'manifest-file': '.release-please-manifest.json',
    });
    expect(steps.filter((s) => s['continue-on-error'] !== undefined)).toEqual([]);
  });

  it('explains a failed release-please run, only when release-please itself failed', () => {
    expect(index((s) => s.name === 'Explain a failed release')).toBe(index((s) => s.id === 'release') + 1);
    expect(explain?.if).toBe("failure() && steps.release.conclusion == 'failure'");
    expect(explain?.shell).toBe('node {0}');
    expect(explain?.env).toMatchObject({ STARTED: '${{ steps.merge-settings.outputs.started }}' });
  });

  it('moves the major tag to the released commit, only when a release was created', () => {
    expect(index((s) => s === moveTag)).toBeGreaterThan(index((s) => s.id === 'release'));
    expect(moveTag?.if).toBe("steps.release.outputs.release_created == 'true'");
    expect(moveTag?.env).toMatchObject({
      MAJOR: '${{ steps.release.outputs.major }}',
      SHA: '${{ steps.release.outputs.sha }}',
    });
    expect(moveTag?.run).toContain('TAG="v$MAJOR"');
    expect(moveTag?.run).toContain('force=true');
  });

  it('interpolates no expression into any run line', () => {
    for (const s of steps) expect(s.run ?? '').not.toContain('${{');
  });

  it('says in its header why it has no inputs, and which permission the guard needs', () => {
    const end = text.indexOf('\nname:');
    expect(end).toBeGreaterThan(0);
    const header = text.slice(0, end);
    expect(header).toContain('ADR 0002');
    expect(header).toContain('No inputs');
    expect(header).toContain('contents: write');
  });
});

describe("K-SHIP-7 Kanon's release caller", () => {
  const { wf } = load('release-please.yml');
  const jobs = Object.values(wf.jobs);

  it('runs on every push to main, and nowhere else', () => {
    expect(wf.on).toEqual({ push: { branches: ['main'] } });
  });

  it('calls the reusable workflow through `$/`, from its one job', () => {
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.uses).toBe('$/.github/workflows/release.yml');
    expect(jobs[0]?.steps).toBeUndefined();
  });

  it('grants nothing at the top, and the two writes on the calling job only', () => {
    expect(wf.permissions).toEqual({});
    expect(jobs[0]?.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
  });
});

describe('no workflow interpolates github.event into a run line', () => {
  const names = readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter((n) => n.endsWith('.yml'));

  it.each(names)('%s', (name) => {
    for (const s of stepsOf(load(name).wf)) expect(s.run ?? '').not.toContain('github.event');
  });
});

// The ruleset on main (id 24259403) requires these checks by name. A merge queue waits
// for each one on the queue's branch, so each must report there under the same name it
// reports under on the pull request (K-MERGE-7). The agent blocks smoke run joins them
// once the ruleset names it (plan 0001 §4).
const REQUIRED_CHECKS = ['Lint, type-check and unit tests', 'Conventional title', 'Signed-off commits', 'Agent blocks smoke', 'Agent lanes smoke'];

describe('K-MERGE-7 every required check reports on pull requests and in the merge queue, under one name', () => {
  const names = readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter((n) => n.endsWith('.yml'));
  const jobs = names.flatMap((file) => {
    const { wf } = load(file);
    return Object.values(wf.jobs).map((job) => ({ file, on: wf.on, job }));
  });

  it.each(REQUIRED_CHECKS)('%s', (check) => {
    const matches = jobs.filter(({ job }) => job.name === check);
    expect(matches.map(({ file }) => file)).toHaveLength(1);
    const { on, job } = matches[0]!;
    expect(Object.keys(on)).toEqual(expect.arrayContaining(['pull_request', 'merge_group']));
    // The same literal name under both events: a job-level `if` would skip it on one of
    // them, and an expression or a matrix would change the name the check reports. The one
    // `if` allowed is `always()`, which skips on no event. A summary job that `needs` others
    // must carry it: without it, a failed dependency SKIPS the summary, and a skipped
    // required check counts as passing.
    expect(job.if === undefined || job.if === 'always()').toBe(true);
    expect(job.strategy).toBeUndefined();
    expect(job.name).not.toContain('${{');
  });
});

describe('plan 0001 §4 the agent blocks smoke run', () => {
  const { wf } = load('agent-blocks-smoke.yml');
  const jobs = Object.values(wf.jobs);
  const steps = stepsOf(wf);
  const block = (name: string) => steps.find((s) => s.uses === `$/actions/${name}`);

  it('runs on pull requests and in the merge queue, under one literal job name (K-MERGE-7)', () => {
    expect(Object.keys(wf.on)).toEqual(expect.arrayContaining(['pull_request', 'merge_group']));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('Agent blocks smoke');
    expect(jobs[0]?.if).toBeUndefined();
    expect(jobs[0]?.strategy).toBeUndefined();
    // No step reads the pull request, so every step runs on both events.
    for (const s of steps) expect(s.if ?? '').not.toContain('event_name');
  });

  it('calls every block through `$/`, so each PR runs its own version', () => {
    for (const name of ['agent-setup', 'agent-run', 'agent-finish', 'agent-classify']) {
      expect(block(name), name).toBeDefined();
    }
  });

  it('never runs the agent, so it never calls the model', () => {
    expect(block('agent-run')?.if).toBe("github.run_id == '0'");
  });

  it('checks what the classify and finish blocks produced, and lets neither fail quietly', () => {
    const checks = steps.filter((s) => s.run?.includes('test "$KIND"'));
    expect(checks).toHaveLength(2);
    expect(steps.filter((s) => s['continue-on-error'] !== undefined)).toEqual([]);
    expect(block('agent-finish')?.with?.['job-status']).toBe('failure');
  });

  it('reads contents only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const job of jobs) expect(job.permissions).toBeUndefined();
  });
});

describe('plan 0001 step 2: the agent lanes smoke run', () => {
  const { wf } = load('agent-lanes-smoke.yml');
  const jobs = Object.entries(wf.jobs);
  const callers = jobs.filter(([, j]) => j.uses);

  it('runs on pull requests and in the merge queue, under one literal job name (K-MERGE-7)', () => {
    expect(Object.keys(wf.on)).toEqual(expect.arrayContaining(['pull_request', 'merge_group']));
    const named = jobs.filter(([, j]) => j.name);
    expect(named.map(([, j]) => j.name)).toEqual(['Agent lanes smoke']);
    expect(named[0]?.[1].strategy).toBeUndefined();
  });

  it('calls every Kanon lane through `$/`, with no inputs, and never inherits secrets', () => {
    const lanes = readdirSync(new URL('../../.github/workflows/', import.meta.url))
      .filter((n) => /^agent-.*\.yml$/.test(n) && !['agent-lane.yml', 'agent-lanes-smoke.yml', 'agent-blocks-smoke.yml'].includes(n));
    expect(callers.map(([, j]) => j.uses).sort()).toEqual(lanes.map((n) => `$/.github/workflows/${n}`).sort());
    for (const [, j] of callers) {
      expect((j as { with?: unknown }).with).toBeUndefined();
      expect((j as { secrets?: unknown }).secrets).toEqual(expect.any(Object));
    }
  });

  it('grants each lane exactly the permissions the lane declares, and the workflow reads contents only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const [, j] of callers) {
      const lane = load(String(j.uses).replace('$/.github/workflows/', '')).wf as {
        permissions?: Record<string, string>; jobs?: Record<string, { permissions?: Record<string, string> }>;
      };
      // What the lane declares at its top level and on each job: a job-level grant in a
      // called workflow is held to this ceiling too (the implement lane's crash recovery).
      const rank = (v?: string) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);
      const want: Record<string, string> = {};
      for (const p of [lane.permissions, ...Object.values(lane.jobs ?? {}).map((x) => x.permissions)]) {
        for (const [k, v] of Object.entries(p ?? {})) if (rank(v) > rank(want[k])) want[k] = v;
      }
      expect(j.permissions, String(j.uses)).toEqual(want);
    }
  });

  it('passes only when every lane resolved and turned the event away without failing', () => {
    const smoke = wf.jobs.smoke;
    expect(smoke?.if).toBe('always()');
    expect([(smoke as { needs?: string[] }).needs].flat().sort()).toEqual(callers.map(([k]) => k).sort());
    expect(smoke?.steps[0]?.run).toContain('all(.value.result == "success" or .value.result == "skipped")');
  });
});

describe('plan 0001 decision 14: claude-code-action is pinned exactly, and Dependabot bumps it', () => {
  const run = parse(readFileSync(new URL('../../actions/agent-run/action.yml', import.meta.url), 'utf8')) as {
    runs: { steps: Step[] };
  };
  const dependabot = parse(readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8')) as {
    updates: { 'package-ecosystem': string; directories?: string[] }[];
  };

  it('names an exact version of claude-code-action in agent-run, never a moving tag', () => {
    const agent = run.runs.steps.filter((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
    expect(agent).toHaveLength(1);
    expect(agent[0]?.uses).toMatch(/^anthropics\/claude-code-action@v\d+\.\d+\.\d+$/);
  });

  it('has Dependabot watch the workflows and every action directory', () => {
    const actions = dependabot.updates.find((u) => u['package-ecosystem'] === 'github-actions');
    expect(actions?.directories).toEqual(expect.arrayContaining(['/', '/actions/*']));
  });
});
