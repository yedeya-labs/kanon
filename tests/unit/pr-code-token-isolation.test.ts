import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { calledFiles } from './helpers/called-workflow.js';

/**
 * `K-AGENT-50` (kanon#243): a job that runs the code under test holds no write credential.
 *
 * `K-AGENT-49` keeps the App's private KEY out of every job that runs someone else's code. This
 * is the same rule one level down, for the TOKEN the key mints. Inside one job step order is not
 * a boundary (`K-AGENT-49`'s Why: the runner, its action cache and the workspace are the job
 * user's, with `sudo`), so a token a job holds at any point is reachable from code that ran in
 * it earlier. A job is checked, not a step.
 *
 * WHAT COUNTS AS RUNNING THE CODE UNDER TEST, in a lane or a workflow a lane calls:
 *   • a `./` action: the project's own code from the checkout (the project-setup hook);
 *   • a `run:` that invokes a package manager or build tool (`npm`, `npx`, `pnpm`, `yarn`,
 *     `bun`, `make`), which runs the tree's scripts, `postinstall` included;
 *   • Kanon's criteria runner with `--run` (`verify-acs.mjs`), which runs the tests a brief cites.
 * The agent's own shell is NOT counted: what an agent runs is set by its prompt and flags, and
 * the review lane's allow-list (`K-AGENT-24`) is where that is limited.
 *
 * WHAT COUNTS AS HOLDING A WRITE CREDENTIAL:
 *   • any `secrets.` reference in the job (a secret is the job's from its first step);
 *   • being an agent's job (a called workflow handed `app-token`), whose secrets are its own;
 *   • a checkout that persists a credential that may write (no `persist-credentials: false`,
 *     and a token handed to it or a grant that is not read-only), which leaves it in
 *     `.git/config` for every later step;
 *   • a `write` grant in the job's (or, without one, the workflow's) `permissions:`;
 *   • a step running the code under test that is handed `github.token`, a secret or a minted token.
 *
 * NAMED EXCEPTIONS, each with its reason, and each must STILL violate (so a lane that is fixed
 * leaves the list, and the list cannot hide a new lane). Two are the default branch's own code,
 * which the rule does not cover; two are the lanes whose agent tests the code it pushes, which
 * wait on the Owner's decision on kanon#243.
 */

const WF = '.github/workflows';
type Step = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { uses?: string; permissions?: unknown; steps?: Step[] };
type Workflow = { on?: { workflow_call?: { secrets?: Record<string, unknown> } }; permissions?: unknown; jobs?: Record<string, Job> };

const read = (path: string) => parse(readFileSync(path, 'utf8')) as Workflow;

/** Every lane, and every workflow a lane calls through `$/`: the files this rule is about. */
const LANES = readdirSync(WF).filter((f) => /^agent-.*\.ya?ml$/.test(f)).sort();
const files = (lanes: string[]) => [...new Set(lanes.flatMap((f) => calledFiles(join(WF, f))))].sort();

const TOOL = /(^|[\s;&|(`]|\$\()(npm|npx|pnpm|yarn|bun|make)(\s|$)/m;
const CRITERIA = /verify-acs\.mjs\b[^\n]*--run\b/;
/** Why a step runs the code under test, or `undefined`. */
export const runsCodeUnderTest = (s: Step): string | undefined => {
  if (String(s.uses ?? '').startsWith('./')) return `runs \`${s.uses}\` from the checkout`;
  const run = String(s.run ?? '').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const tool = TOOL.exec(run);
  if (tool) return `runs \`${tool[2]}\``;
  if (CRITERIA.test(run)) return 'runs the acceptance criteria';
  return undefined;
};

const CREDENTIAL = /secrets\s*[.[]|github\.token|steps\.app-token\.outputs/;
const grantsWrite = (p: unknown) => (p === 'write-all') || (typeof p === 'object' && p !== null && Object.values(p).includes('write'));

/** Every reason the job holds a write credential, beside code it runs. */
export const credentials = (wf: Workflow, job: Job): string[] => {
  const steps = job.steps ?? [];
  const why: string[] = [];
  if (wf.on?.workflow_call?.secrets?.['app-token'] !== undefined) why.push('is an agent\'s job, handed the App token');
  if (/secrets\s*[.[]/.test(JSON.stringify(job))) why.push('references a secret');
  // A job with no `permissions:` (nor its workflow) gets its caller's or the repository's
  // default, which may write, so it is read as writing.
  const granted = job.permissions ?? wf.permissions;
  const mayWrite = granted === undefined || grantsWrite(granted);
  for (const s of steps.filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'))) {
    const persists = String(s.with?.['persist-credentials']) !== 'false';
    if (persists && (s.with?.token !== undefined || mayWrite)) why.push(`checkout${s.id ? ` \`${s.id}\`` : ''} persists a credential that may write`);
  }
  if (grantsWrite(granted)) why.push('is granted a `write` permission');
  for (const s of steps.filter((s) => runsCodeUnderTest(s))) {
    if (CREDENTIAL.test(JSON.stringify({ with: s.with, env: s.env }))) why.push(`hands \`${s.name ?? s.uses ?? s.id}\` a token`);
  }
  return why;
};

/** `file:job` → why it breaks the rule, for every job that runs the code under test and holds a credential. */
export const violations = (paths: string[]): Record<string, string> =>
  Object.fromEntries(paths.flatMap((path) => {
    const wf = read(path);
    return Object.entries(wf.jobs ?? {}).flatMap(([name, job]) => {
      const code = (job.steps ?? []).map(runsCodeUnderTest).find(Boolean);
      const held = code ? credentials(wf, job) : [];
      return held.length ? [[`${basename(path)}:${name}`, `${code}, and ${held.join('; ')}`] as const] : [];
    });
  }));

const EXCEPTIONS: Record<string, string> = {
  'lane-agent-job.yml:run':
    'the spine: implement-revise and lead-revise check out the pull request\'s head and run its hook with the token persisted, and every spine lane\'s agent runs the tests on what it pushes. Waits on the Owner\'s decision (kanon#243)',
  'rebase-agent-job.yml:resolve':
    'the rebase lane\'s hook is the default branch\'s, but its agent checks out the pull request, merges and runs the gates with the token it pushes with. Waits on the Owner\'s decision (kanon#243)',
  'lead-split-agent-job.yml:split':
    'checks out the triggering commit, the default branch\'s reviewed code, which this rule does not cover',
  'explore-agent-job.yml:explore':
    'checks out the triggering commit, the default branch\'s reviewed code, which this rule does not cover',
};

const PATHS = files(LANES);

describe('K-AGENT-50: no job that runs the code under test holds a write credential', () => {
  it('reads every lane and every workflow a lane calls, so the check is not vacuous', () => {
    expect(LANES.length).toBeGreaterThan(15);
    for (const f of ['agent-verify-acs.yml', 'verify-acs-agent-job.yml', 'lane-agent-job.yml', 'rebase-agent-job.yml', 'review-agent-job.yml']) {
      expect(PATHS.map((p) => basename(p))).toContain(f);
    }
    // It finds the code under test where it is known to run, credential or not.
    const running = PATHS.flatMap((p) => Object.entries(read(p).jobs ?? {})
      .filter(([, j]) => (j.steps ?? []).some(runsCodeUnderTest)).map(([n]) => `${basename(p)}:${n}`));
    expect(running).toEqual(expect.arrayContaining(['agent-verify-acs.yml:criteria', ...Object.keys(EXCEPTIONS)]));
  });

  it('holds for every job but the named exceptions', () => {
    const found = violations(PATHS);
    const unexpected = Object.fromEntries(Object.entries(found).filter(([k]) => !(k in EXCEPTIONS)));
    expect(unexpected).toEqual({});
  });

  it('every named exception still violates it, so a fixed lane leaves the list', () => {
    expect(Object.keys(violations(PATHS)).sort()).toEqual(Object.keys(EXCEPTIONS).sort());
  });

  it('the verify-acs lane runs its criteria in a job that is handed nothing, before the job that receives the token', () => {
    const lane = read(join(WF, 'agent-verify-acs.yml'));
    const criteria = lane.jobs!.criteria! as Job & { needs?: unknown };
    expect(credentials(lane, criteria)).toEqual([]);
    const verify = lane.jobs!.verify! as Job & { needs?: unknown; with?: Record<string, unknown> };
    expect(([] as unknown[]).concat(verify.needs)).toContain('criteria');
    expect(verify.uses).toBe('$/.github/workflows/verify-acs-run.yml');
    const agentJob = read(join(WF, 'verify-acs-agent-job.yml'));
    for (const job of Object.values(agentJob.jobs ?? {})) {
      expect((job.steps ?? []).map(runsCodeUnderTest).filter(Boolean)).toEqual([]);
      for (const s of (job.steps ?? []).filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'))) {
        expect(s.with?.['persist-credentials']).toBe(false);
      }
    }
  });
});

describe('the detector', () => {
  const job = (steps: Step[], extra: Partial<Job> = {}): Job => ({ ...extra, steps });
  const one = (j: Job, wf: Workflow = {}) => {
    const code = (j.steps ?? []).map(runsCodeUnderTest).find(Boolean);
    return code ? credentials(wf, j) : [];
  };
  const clean = (steps: Step[]) => job([{ uses: 'actions/checkout@v7', with: { 'persist-credentials': false } }, ...steps], { permissions: { contents: 'read' } });

  it('sees each spelling of the code under test', () => {
    for (const run of ['npm ci', 'npx vitest', 'pnpm install && make test', 'yarn', 'bun test', 'make', 'cd x && npm test', 'X=1 npm run lint', 'echo $(npm -v)',
      'node "$KANON/scripts/verify-acs.mjs" "$P" --run --json=x.json']) {
      expect(runsCodeUnderTest({ run }), run).toBeDefined();
    }
    expect(runsCodeUnderTest({ uses: './.github/actions/project-setup' })).toBeDefined();
    for (const run of ['node "$KANON/scripts/verify-acs.mjs" "$P"', 'echo npmish', '# npm ci', 'gh pr view 1', 'git restore -- x']) {
      expect(runsCodeUnderTest({ run }), run).toBeUndefined();
    }
  });

  it('passes a job that runs the code but holds nothing', () => {
    expect(one(clean([{ run: 'npm ci' }]))).toEqual([]);
  });

  it('fails each way of holding a credential', () => {
    expect(one(clean([{ run: 'npm ci', env: { X: '${{ secrets.TOKEN }}' } }]))).toEqual(expect.arrayContaining(['references a secret']));
    // A persisted credential counts when it may write: a token handed to the checkout, or a
    // job whose grant is unknown (none declared). The read-only workflow token does not.
    expect(one(job([{ uses: 'actions/checkout@v7' }, { run: 'npm ci' }], { permissions: { contents: 'read' } }))).toEqual([]);
    expect(one(job([{ uses: 'actions/checkout@v7' }, { run: 'npm ci' }]))).toEqual(['checkout persists a credential that may write']);
    expect(one(job([{ uses: 'actions/checkout@v7', with: { token: '${{ steps.app-token.outputs.token }}' } }, { run: 'npm ci' }], { permissions: { contents: 'read' } })))
      .toEqual(['checkout persists a credential that may write']);
    expect(one(clean([{ run: 'npm ci' }]), { on: { workflow_call: { secrets: { 'app-token': {} } } } })).toEqual(['is an agent\'s job, handed the App token']);
    expect(one(job([{ uses: 'actions/checkout@v7', with: { 'persist-credentials': false } }, { run: 'npm ci' }], { permissions: { contents: 'write' } }))).toEqual(['is granted a `write` permission']);
    expect(one(job([{ uses: 'actions/checkout@v7', with: { 'persist-credentials': false } }, { run: 'npm ci' }]), { permissions: 'write-all' })).toEqual(['is granted a `write` permission']);
    expect(one(clean([{ uses: './.github/actions/project-setup', with: { 'github-token': '${{ github.token }}' } }]))).toEqual(['hands `./.github/actions/project-setup` a token']);
  });
});
