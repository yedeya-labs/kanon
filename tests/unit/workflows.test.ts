import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { auditAreas, readCodeAreas } from '../../scripts/lib/code-areas.mjs';

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
type Workflow = { name?: string; on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };

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

// #47: a check that judges a PR runs Kanon's last release, an exact version Dependabot bumps,
// never the PR's own copy through `$/`. Returns the one released reference to `action` in
// the workflow, and fails unless there is exactly one.
const RELEASED = (action: string) => new RegExp(`^yedeya-labs/kanon/actions/${action}@v\\d+\\.\\d+\\.\\d+$`);
const judge = (wf: Workflow, action: string): string => {
  const refs = stepsOf(wf).map((s) => s.uses ?? '').filter((u) => RELEASED(action).test(u));
  expect(refs).toHaveLength(1);
  return refs[0]!;
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

describe('K-SHIP-4 Kanon runs its PR-title action from its last release', () => {
  const { wf, text } = load('pr-title.yml');

  it('runs on pull requests, including title edits, and on merge_group', () => {
    expect(wf.on.pull_request).toMatchObject({ types: expect.arrayContaining(['opened', 'edited', 'synchronize']) });
    expect(Object.keys(wf.on)).toContain('merge_group');
  });

  it('checks the title on pull requests only, and passes on merge_group', () => {
    expectPassesOnMergeGroup(wf, judge(wf, 'pr-title'));
  });

  it('uses the released action, never the PR copy, and needs no checkout (#47)', () => {
    const uses = stepsOf(wf).map((s) => s.uses);
    expect(uses).toContain(judge(wf, 'pr-title'));
    expect(uses.filter((u) => u?.startsWith('actions/checkout@'))).toEqual([]);
  });

  it('reads contents only, and never interpolates the title itself', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(text).not.toContain('github.event.pull_request.title');
  });
});

describe('ADR 0010 Kanon runs its DCO action from its last release', () => {
  const { wf } = load('dco.yml');

  it('runs on pull requests opened, pushed to and reopened, and on merge_group', () => {
    expect(wf.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] }, merge_group: null });
  });

  it('checks the commits on pull requests only, and passes on merge_group', () => {
    expectPassesOnMergeGroup(wf, judge(wf, 'dco'));
  });

  it('uses the released action, never the PR copy, and needs no checkout (#47)', () => {
    const uses = stepsOf(wf).map((s) => s.uses);
    expect(uses).toContain(judge(wf, 'dco'));
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

  it('is called, never triggered, takes no inputs (ADR 0002), and only the optional Releaser secrets (plan 0005 §3.5)', () => {
    expect(wf.on).toEqual({ workflow_call: { secrets: {
      RELEASER_APP_ID: { required: false },
      RELEASER_APP_PRIVATE_KEY: { required: false },
    } } });
  });

  it('opens the release PR as the Releaser when the caller maps its secrets, and with the workflow token otherwise', () => {
    const mint = steps.find((s) => s.id === 'releaser');
    expect(mint?.uses).toBe('actions/create-github-app-token@v3');
    expect(mint?.if).toBe("env.RELEASER_SET == 'true'");
    expect((jobs[0] as { env?: unknown } | undefined)?.env).toEqual({ RELEASER_SET: "${{ secrets.RELEASER_APP_ID != '' && 'true' || '' }}" });
    // Narrowed to what release-please uses: the Releaser's whole grant, and no more.
    expect(mint?.with).toEqual({
      'client-id': '${{ secrets.RELEASER_APP_ID }}',
      'private-key': '${{ secrets.RELEASER_APP_PRIVATE_KEY }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(release?.with?.token).toBe('${{ steps.releaser.outputs.token || github.token }}');
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
      token: '${{ steps.releaser.outputs.token || github.token }}',
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

// ADR 0011, plan 0001 step 4b: Kanon runs its own review lane, from its last release.
describe('step 4b: Kanon reviews its own pull requests, through the lane at its last release', () => {
  const { wf } = load('review.yml');
  const jobs = Object.values(wf.jobs);
  const job = jobs[0] as Job & { with?: Record<string, string>; secrets?: unknown };

  it('calls the review lane at an exact release, never through `$/`, from its one job', () => {
    expect(jobs).toHaveLength(1);
    expect(job.uses).toMatch(/^yedeya-labs\/kanon\/\.github\/workflows\/agent-review\.yml@v\d+\.\d+\.\d+$/);
  });

  it('is started by CI finishing, a review label or a dispatch, and CI is the workflow it names', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request_target', 'workflow_dispatch', 'workflow_run']);
    expect(wf.on.workflow_run).toEqual({ workflows: [load('ci.yml').wf.name], types: ['completed'] });
    expect(wf.on.pull_request_target).toEqual({ types: ['opened', 'labeled'] });
  });

  it('passes only the dispatch input, and maps the three secrets by name, never inheriting', () => {
    expect(job.with).toEqual({ pr_number: '${{ inputs.pr_number }}' });
    expect(job.secrets).toEqual({
      REVIEWER_APP_ID: '${{ secrets.REVIEWER_APP_ID }}',
      REVIEWER_APP_PRIVATE_KEY: '${{ secrets.REVIEWER_APP_PRIVATE_KEY }}',
      CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    });
  });

  it('has CI run lane-check at a released version, never the PR\'s own copy', () => {
    const ci = load('ci.yml').wf;
    judge(ci, 'lane-check');
    expect(stepsOf(ci).filter((s) => s.uses?.includes('lane-check') && !RELEASED('lane-check').test(s.uses))).toEqual([]);
  });

  it('pins one Kanon version across every workflow that names one (K-ADOPT-11)', () => {
    const names = readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter((n) => n.endsWith('.yml'));
    const versions = names.flatMap((n) => {
      const w = load(n).wf;
      return [...Object.values(w.jobs).map((j) => j.uses), ...stepsOf(w).map((st) => st.uses)]
        .filter((u): u is string => typeof u === 'string' && u.startsWith('yedeya-labs/kanon/'))
        .map((u) => u.replace(/^.*@/, ''));
    });
    expect(versions.length).toBeGreaterThanOrEqual(4);
    expect(new Set(versions).size).toBe(1);
  });
});

// ADR 0011, stage 2: Kanon builds its own issues with the Implementer, through the lanes at its
// last release, like the Reviewer above. Inert until the Owner creates the App: the secrets are
// then unset, and the lanes skip or fail at the mint.
describe('stage 2: Kanon runs the Implementer on itself, through the lanes at its last release', () => {
  const SECRETS = {
    IMPLEMENTER_APP_ID: '${{ secrets.IMPLEMENTER_APP_ID }}',
    IMPLEMENTER_APP_PRIVATE_KEY: '${{ secrets.IMPLEMENTER_APP_PRIVATE_KEY }}',
    CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
  };
  it.each([
    ['implement.yml', 'agent-implement', {
      issues: { types: ['labeled'] },
      workflow_dispatch: { inputs: { issue_number: { description: 'Issue number to implement', required: true } } },
    }, { issue_number: '${{ inputs.issue_number }}' }],
    ['implement-revise.yml', 'agent-implement-revise', {
      pull_request_review: { types: ['submitted'] },
      pull_request: { types: ['labeled'] },
      workflow_dispatch: { inputs: {
        pr_number: { description: 'PR to revise', required: true },
        reset: { description: expect.any(String), type: 'boolean', default: false },
      } },
    }, { pr_number: '${{ inputs.pr_number }}', reset: '${{ inputs.reset }}' }],
  ])('%s calls %s at an exact release from its one job, with the lane\'s triggers and its secrets by name', (file, lane, triggers, inputs) => {
    const { wf } = load(file);
    const jobs = Object.values(wf.jobs) as (Job & { with?: Record<string, string>; secrets?: unknown })[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.uses).toMatch(new RegExp(`^yedeya-labs/kanon/\\.github/workflows/${lane}\\.yml@v\\d+\\.\\d+\\.\\d+$`));
    expect(wf.on).toEqual(triggers);
    expect(jobs[0]?.with).toEqual(inputs);
    expect(jobs[0]?.secrets).toEqual(SECRETS);
  });
});

// ADR 0011, the Explorer (plan 0004 step 11a): Kanon audits its own code with the code-audit
// lane, at its last release, like the Reviewer and the Implementer above. Inert until the Owner
// creates the Explorer's App: the secrets are then unset, and the audit job fails at the mint.
describe('step 11a: Kanon audits its own code, through the lane at its last release', () => {
  const { wf } = load('code-audit.yml');
  const jobs = Object.values(wf.jobs) as (Job & { with?: unknown; secrets?: unknown })[];

  it('calls the code-audit lane at an exact release, never through `$/`, from its one job', () => {
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.uses).toMatch(/^yedeya-labs\/kanon\/\.github\/workflows\/agent-code-audit\.yml@v\d+\.\d+\.\d+$/);
  });

  it("runs on the lane's two triggers only: its schedule and a dispatch with no inputs", () => {
    expect(wf.on).toEqual({ schedule: [{ cron: expect.stringMatching(/^\S+ \S+ \S+ \S+ \S+$/) }], workflow_dispatch: null });
  });

  it('passes no inputs, and maps the three secrets by name, never inheriting', () => {
    expect(jobs[0]?.with).toBeUndefined();
    expect(jobs[0]?.secrets).toEqual({
      EXPLORER_APP_ID: '${{ secrets.EXPLORER_APP_ID }}',
      EXPLORER_APP_PRIVATE_KEY: '${{ secrets.EXPLORER_APP_PRIVATE_KEY }}',
      CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    });
  });

  // The plan's areas: Kanon's rules, docs, guards and scripts. Without `audit` areas the lane
  // would read only the `code` trees, and never set a rule beside the code that holds it.
  it("audits Kanon's rules, docs, guards and scripts, as its stack document declares them", () => {
    const { source, lines } = auditAreas(readCodeAreas());
    expect(source).toBe('audit');
    const paths = lines.map((l) => /^- `([^`]+)`/.exec(l)?.[1]);
    expect(paths).toEqual(expect.arrayContaining(['rulebook/', 'docs/', 'tests/', 'scripts/', 'actions/']));
  });

  it('has the playbook section the lane sends the audit to', () => {
    expect(readFileSync('docs/qa/explorer-playbook.md', 'utf8').split('\n')).toContain('## Code-reading mode');
  });
});

// The ruleset on main (id 24259403) requires these checks by name. A merge queue waits
// for each one on the queue's branch, so each must report there under the same name it
// reports under on the pull request (K-MERGE-7). The agent blocks smoke run joins them
// once the ruleset names it (plan 0001 §4). The public-text check joined them after #258.
const REQUIRED_CHECKS = ['Lint, type-check and unit tests', 'Conventional title', 'Signed-off commits', 'Agent blocks smoke', 'Agent lanes smoke', 'No reference-adopter names'];

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

// #47, ADR 0011's bootstrap applied to a check's code: a required check that judges the PR
// runs Kanon's last release, so a PR can't weaken the check that passes it. The smoke runs
// are required too, but they test the PR's own code, so `$/` is their point.
const JUDGES: Record<string, string> = { 'Signed-off commits': 'dco', 'Conventional title': 'pr-title' };
const SMOKES = ['Agent blocks smoke', 'Agent lanes smoke'];
// A required check that judges with a script read from the PR's BASE commit, not an action:
// the same bootstrap, since the PR's own copy of the script never runs.
const BASE_JUDGES = ['No reference-adopter names'];

describe('#47 no required check judges a PR with the PR\'s own copy of its action', () => {
  const names = readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter((n) => n.endsWith('.yml'));
  const jobs = names.flatMap((file) => Object.values(load(file).wf.jobs).map((job) => ({ file, job })));
  const usesOf = (job: Job): string[] =>
    [job.uses, ...(job.steps ?? []).map((s) => s.uses)].filter((u): u is string => typeof u === 'string');

  it('accounts for every required check as a judge, a smoke or CI', () => {
    expect([...Object.keys(JUDGES), ...SMOKES, ...BASE_JUDGES, 'Lint, type-check and unit tests'].sort()).toEqual([...REQUIRED_CHECKS].sort());
  });

  it.each(BASE_JUDGES)('%s checks out only the base commit, and runs no action', (check) => {
    const { job } = jobs.find(({ job: j }) => j.name === check)!;
    const checkouts = (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with?.ref).toBe('${{ github.event.pull_request.base.sha }}');
    expect(usesOf(job).filter((u) => !u.startsWith('actions/checkout@'))).toEqual([]);
  });

  it.each(Object.entries(JUDGES))('%s calls its action at a released version, never through `$/`', (check, action) => {
    const { job } = jobs.find(({ job: j }) => j.name === check)!;
    const uses = usesOf(job);
    expect(uses.filter((u) => RELEASED(action).test(u))).toHaveLength(1);
    expect(uses.filter((u) => u.startsWith('$/'))).toEqual([]);
  });

  it('no required check other than a smoke run calls anything through `$/`', () => {
    const bad = jobs
      .filter(({ job }) => REQUIRED_CHECKS.includes(job.name ?? '') && !SMOKES.includes(job.name ?? ''))
      .flatMap(({ file, job }) => usesOf(job).filter((u) => u.startsWith('$/')).map((u) => `${file}: ${u}`));
    expect(bad).toEqual([]);
  });
});

describe('#47 the PR\'s own copy of each judging action still runs, as a test', () => {
  const { wf } = load('judging-actions-smoke.yml');
  const jobs = Object.values(wf.jobs);
  const steps = stepsOf(wf);

  it('runs on pull requests, including title edits, and is not a required check', () => {
    expect(wf.on.pull_request).toMatchObject({ types: expect.arrayContaining(['opened', 'edited', 'synchronize']) });
    expect(jobs).toHaveLength(1);
    expect(REQUIRED_CHECKS).not.toContain(jobs[0]?.name);
  });

  it('calls each judging action through `$/`, so the PR runs its own version', () => {
    for (const action of Object.values(JUDGES)) expect(steps.map((s) => s.uses), action).toContain(`$/actions/${action}`);
  });

  it('checks that the PR-title action fails a bad title, not only that it passes a good one', () => {
    const bad = steps.find((s) => s.id === 'bad-title');
    expect(bad?.uses).toBe('$/actions/pr-title');
    expect(bad?.with?.title).toBe('Not a conventional title');
    expect(bad?.['continue-on-error']).toBe(true);
    const check = steps.at(-1);
    expect(check?.env).toEqual({ OUTCOME: '${{ steps.bad-title.outcome }}' });
    expect(check?.run).toContain('test "$OUTCOME" = failure');
    expect(check?.['continue-on-error']).toBeUndefined();
  });

  it('reads contents and pull requests only', () => {
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    for (const job of jobs) expect(job.permissions).toBeUndefined();
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

  it('calls every Kanon lane through `$/`, with only the `smoke` input, and never inherits secrets', () => {
    const lanes = readdirSync(new URL('../../.github/workflows/', import.meta.url))
      .filter((n) => /^agent-.*\.yml$/.test(n) && !['agent-lane.yml', 'agent-lanes-smoke.yml', 'agent-blocks-smoke.yml'].includes(n));
    expect(callers.map(([, j]) => j.uses).sort()).toEqual(lanes.map((n) => `$/.github/workflows/${n}`).sort());
    for (const [, j] of callers) {
      expect((j as { with?: unknown }).with).toEqual({ smoke: 'agent-lanes-smoke' });
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
    updates: {
      'package-ecosystem': string;
      directories?: string[];
      groups?: Record<string, { patterns?: string[] }>;
      schedule?: { interval?: string };
      cooldown?: { 'default-days'?: number; exclude?: string[] };
      'commit-message'?: Record<string, unknown>;
    }[];
  };

  it('names an exact version of claude-code-action in agent-run, never a moving tag', () => {
    const agent = run.runs.steps.filter((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
    expect(agent).toHaveLength(1);
    expect(agent[0]?.uses).toMatch(/^anthropics\/claude-code-action@v\d+\.\d+\.\d+$/);
  });

  it('has Dependabot watch the workflows and every action directory', () => {
    const actions = dependabot.updates.find((u) => u['package-ecosystem'] === 'github-actions');
    expect(actions?.directories).toEqual(expect.arrayContaining(['/', '/actions/*', '/.github/actions/*']));
  });

  it('proposes each Kanon release to the judging checks in a group of its own, exempt from the cooldown (#47, #233, K-ADOPT-11)', () => {
    const actions = dependabot.updates.find((u) => u['package-ecosystem'] === 'github-actions');
    // Dependabot puts a dependency in the FIRST group whose patterns match it, so Kanon's
    // group comes before the catch-all.
    const groups = Object.entries(actions?.groups ?? {});
    expect(groups[0]?.[1].patterns).toEqual(['yedeya-labs/kanon*']);
    // An entry with no `cooldown` still gets Dependabot's default of 3 days, which held Kanon's
    // pins on v0.10.0 through 13 releases (#233). So the cooldown is written out, and excludes
    // Kanon; third-party actions keep the 3 days.
    expect(actions?.cooldown).toEqual({ 'default-days': 3, exclude: ['yedeya-labs/kanon*'] });
    // Checked daily, as adopters are told to: a weekly entry reached each Kanon release up to
    // a week late, and the cooldown exemption only helps once Dependabot looks.
    expect(actions?.schedule?.interval).toBe('daily');
    // Titled `ci(deps): …`, so the PR passes K-SHIP-4.
    expect(actions?.['commit-message']).toEqual({ prefix: 'ci', include: 'scope' });
  });
});
