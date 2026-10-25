/**
 * A repository's default branch and issues, as the status core reads them through its reader
 * (`scripts/status/`): the fixture adopter's declarations, a brief for its project 7, the issues
 * carrying the project marker and their pull requests. Shared by the core's tests and the
 * `kanon status` command's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NO_VERDICT_STEP, RETRY_STEPS } from '../../../scripts/lane-retry.mjs';
import { ADOPTER } from './adopter.js';
import { connection, fakeReader, type FakeWorld } from './fake-reader.js';

export const PROJECT = 7;
export const marker = (project = PROJECT) => `Part of #${project}.\n\n<!-- qa:project ${project} -->`;

/** A brief whose items cite the fixture adopter's storefront invariants. */
export const BRIEF = [
  '# Project 7', '', '## Decomposition', '',
  '### Issue A — Show the price', '', '**Milestone:** Product Backlog · **Labels:** `enhancement`', '',
  '- `[STORE-1]` — the price before confirm.', '',
  '### Issue B — Place an order once', '', '**Milestone:** Product Backlog · **Labels:** `enhancement`',
  '**Depends on:** Issue A (it shows the price first)', '',
  '- `[STORE-2]` — once, however many presses.', '- `[STORE-99]` — not an invariant.', '',
  '### Issue C — Take payment', '', '**Milestone:** Product Backlog · **Labels:** `enhancement`',
  '**Depends on:** Issue B (it takes the order)', '',
  'It takes the payment.', '',
].join('\n');

/** The fixture adopter's declarations, as its default branch holds them. */
export const adopterFiles = (root = ADOPTER, extra: Record<string, string> = {}) => {
  const files: Record<string, string> = {};
  for (const f of ['docs/qa/agent-identities.md', 'docs/qa/adoption.md', 'docs/qa/stack.md']) {
    try {
      files[f] = readFileSync(join(root, f), 'utf8');
    } catch {
      // not every tree declares every file
    }
  }
  for (const f of readdirSync(join(root, 'docs/qa/specs'))) files[`docs/qa/specs/${f}`] = readFileSync(join(root, 'docs/qa/specs', f), 'utf8');
  return { ...files, ...extra };
};

export type Issue = { number: number; title: string; state?: string; labels?: string[]; body?: string; closedAt?: string | null };

/**
 * A repository's default branch and issues, as the core reads them: `files` at `branch`, the
 * test files in its tree, the issues carrying the project marker, and their pull requests.
 */
export function repoWorld({
  repo = 'acme/shop', branch = 'main', project = PROJECT, files, tests = {}, issues = [], tracking = { state: 'OPEN', labels: [] as string[] },
  trackingComments = [] as Array<Record<string, unknown>>, prs = {} as Record<number, Array<{ number: number; state: string }>>,
  overrides = {} as Partial<FakeWorld>,
}: {
  repo?: string; branch?: string; project?: number; files: Record<string, string>; tests?: Record<string, string>; issues?: Issue[];
  tracking?: { state: string; labels: string[] }; trackingComments?: Array<Record<string, unknown>>;
  prs?: Record<number, Array<{ number: number; state: string }>>; overrides?: Partial<FakeWorld>;
}) {
  const sha = (i: number) => i.toString(16).padStart(40, '0');
  const testList = Object.entries(tests);
  const queries: string[] = [];
  const world: FakeWorld = {
    branch,
    files,
    labels: ['enhancement', 'agent:implement'],
    get: (path) => {
      const dir = new RegExp(`^repos/${repo}/contents/(.+)\\?ref=${branch}$`).exec(path);
      if (dir && !(decodeURIComponent(dir[1]!) in files)) {
        const prefix = `${decodeURIComponent(dir[1]!)}/`;
        const inside = Object.keys(files).filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'));
        if (inside.length) return inside.map((f) => ({ name: f.slice(prefix.length), path: f, type: 'file' }));
      }
      if (path === `repos/${repo}/git/trees/${branch}?recursive=1`) {
        return { truncated: false, tree: [...testList.map(([p], i) => ({ path: p, type: 'blob', sha: sha(i + 1) })), { path: 'tests', type: 'tree', sha: sha(999) }] };
      }
      return undefined;
    },
    search: (q) => {
      const asked = /qa:project (\d+)/.exec(q)?.[1];
      return issues.filter(() => asked === String(project)).map((i) => ({
        state: 'OPEN', body: marker(project), closedAt: null, ...i,
        labels: (i.labels ?? []).map((name) => ({ name })),
      }));
    },
    issues: { [project]: tracking },
    comments: { [project]: trackingComments },
    closedBy: {},
    events: {},
    branchPrs: {},
    ...overrides,
    graphql: {
      ItemPullRequests: (v) => ({ repository: { issue: { closedByPullRequestsReferences: connection((prs[Number(v.number)] ?? []).map((p) => ({ ...p, url: `https://example.test/pull/${p.number}` }))) } } }),
      TestFiles: () => {
        const q = queries.at(-1) ?? '';
        const repository: Record<string, unknown> = {};
        for (const m of q.matchAll(/b(\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
          const at = parseInt(m[2]!, 16) - 1;
          repository[`b${m[1]}`] = { text: testList[at]![1], isTruncated: false, isBinary: false };
        }
        return { repository };
      },
      Labelled: () => ({ repository: { issues: connection([]) } }),
      ...overrides.graphql,
    },
  };
  const { reader: inner, seen } = fakeReader(world);
  const reader = {
    get: inner.get,
    pages: inner.pages,
    graphql: (query: string, variables?: Record<string, unknown>) => {
      queries.push(query);
      return inner.graphql(query, variables);
    },
  };
  return { reader, repo, seen, queries };
}

/** The fixture adopter's project 7: A done and merged, B open with a pull request, C not filed. */
export const adopterProject = (opts: Partial<Parameters<typeof repoWorld>[0]> = {}) => repoWorld({
  files: adopterFiles(ADOPTER, { [`docs/projects/${PROJECT}.md`]: BRIEF }),
  tests: {
    'tests/price.test.ts': "import { it } from 'vitest';\nit('[STORE-1] shows the price before confirm', () => {});\n",
    'tests/helpers/notes.ts': '// [STORE-2] is only mentioned here\n',
  },
  issues: [
    { number: 11, title: 'Show the price', state: 'CLOSED', closedAt: '2026-10-01T00:00:00Z' },
    { number: 12, title: 'Place an order once', labels: ['enhancement'] },
  ],
  prs: { 11: [{ number: 21, state: 'MERGED' }, { number: 20, state: 'CLOSED' }], 12: [{ number: 22, state: 'OPEN' }] },
  ...opts,
});

/** A workflow run, in the REST shape the lane-health view reads. */
export type LaneRun = { id: number; conclusion: string | null; run_attempt?: number; created_at?: string; html_url?: string };

/** A lane caller's workflow: one job that calls the Kanon lane `lane` at a release. */
export const laneCaller = (lane: string, name = lane) =>
  `name: ${name}\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  ${lane}:\n    uses: yedeya-labs/kanon/.github/workflows/agent-${lane}.yml@v0.42.0\n`;

/**
 * A repository's default-branch workflows and their runs, as the lane-health view reads them:
 * `workflows` under `.github/workflows/`, each workflow's runs newest first, each run's jobs, and
 * each earlier attempt of a re-run run (`<run>/<attempt>` → its conclusion).
 */
export function laneWorld({
  repo = 'acme/shop', branch = 'main', workflows, runs = {}, jobs = {}, attempts = {}, overrides = {} as Partial<FakeWorld>,
}: {
  repo?: string; branch?: string; workflows: Record<string, string>; runs?: Record<string, LaneRun[]>;
  jobs?: Record<number, Array<Record<string, unknown>> | undefined>; attempts?: Record<string, string>; overrides?: Partial<FakeWorld>;
}) {
  const files = Object.fromEntries(Object.entries(workflows).map(([f, text]) => [`.github/workflows/${f}`, text]));
  const queries: string[] = [];
  const world: FakeWorld = {
    branch,
    files,
    jobs,
    get: (path) => {
      if (path === `repos/${repo}/contents/.github/workflows?ref=${branch}`) {
        return Object.keys(workflows).map((name) => ({ name, path: `.github/workflows/${name}`, type: 'file' }));
      }
      let m: RegExpExecArray | null;
      if ((m = new RegExp(`^repos/${repo}/actions/workflows/([^/]+)/runs\\?per_page=(\\d+)$`).exec(path))) {
        const all = runs[decodeURIComponent(m[1]!)] ?? [];
        return { total_count: all.length, workflow_runs: all.slice(0, Number(m[2])).map((r) => ({ run_attempt: 1, created_at: '2026-10-24T00:00:00Z', html_url: `https://example.test/runs/${r.id}`, ...r })) };
      }
      if ((m = new RegExp(`^repos/${repo}/actions/runs/(\\d+)/attempts/(\\d+)$`).exec(path))) {
        const conclusion = attempts[`${m[1]}/${m[2]}`];
        if (conclusion === undefined) return undefined;
        return { id: Number(m[1]), run_attempt: Number(m[2]), conclusion, created_at: '2026-10-23T00:00:00Z', html_url: `https://example.test/runs/${m[1]}/attempts/${m[2]}` };
      }
      return undefined;
    },
    ...overrides,
  };
  const { reader: inner, seen } = fakeReader(world);
  const reader = {
    get: inner.get,
    pages: inner.pages,
    graphql: (query: string, variables?: Record<string, unknown>) => {
      queries.push(query);
      return inner.graphql(query, variables);
    },
  };
  return { reader, repo, seen, queries };
}

/** A job that failed, and the breadcrumb step it ran, if any. */
export const failedJob = (name: string, breadcrumb?: string) => ({
  name,
  conclusion: 'failure',
  steps: [
    { name: 'Run the agent', conclusion: 'failure' },
    ...(breadcrumb ? [{ name: breadcrumb, conclusion: 'success' }] : []),
    // A breadcrumb that didn't run is the step saying "not this class".
    { name: RETRY_STEPS.api_error === breadcrumb ? RETRY_STEPS.unreachable : RETRY_STEPS.api_error, conclusion: 'skipped' },
  ],
});
export const fail = (id: number, extra: Partial<LaneRun> = {}): LaneRun => ({ id, conclusion: 'failure', ...extra });
export const ok = (id: number, extra: Partial<LaneRun> = {}): LaneRun => ({ id, conclusion: 'success', ...extra });

/** Five callers, each a different answer, beside two workflows the lane check doesn't read. */
export const laneFleet = () => laneWorld({
  workflows: {
    'review.yml': laneCaller('review'),
    'implement.yml': laneCaller('implement'),
    'rebase.yml': laneCaller('rebase'),
    'merge.yml': laneCaller('merge'),
    'triage.yml': laneCaller('triage'),
    'ci.yml': 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
    // The spine is no lane, so a workflow that calls only it is no lane caller.
    'spine.yml': 'name: spine\non: [push]\njobs:\n  x:\n    uses: yedeya-labs/kanon/.github/workflows/agent-lane.yml@v0.42.0\n',
    'README.md': 'not a workflow',
  },
  runs: {
    // Red on every run, and every failure is one the classifier recorded: flaky, not red.
    'review.yml': [fail(101), fail(102), fail(103), { id: 104, conclusion: 'cancelled' }],
    // Red on every run, and none recorded: red.
    'implement.yml': [fail(201), { id: 202, conclusion: 'timed_out' }, fail(203)],
    // A matrix run with one capped job and one that genuinely failed, and a run a re-run fixed.
    'rebase.yml': [fail(301), ok(302, { run_attempt: 2 }), ok(303), ok(304)],
    // Green, and its one failure an attempt a re-run fixed: flaky.
    'merge.yml': [ok(401, { run_attempt: 3 }), ok(402), ok(403)],
    // Too few decisive runs to judge.
    'triage.yml': [ok(501), { id: 502, conclusion: null }],
  },
  jobs: {
    101: [failedJob('review / review', RETRY_STEPS.unreachable), { name: 'review / notify', conclusion: 'skipped', steps: [] }],
    102: [failedJob('review / review', RETRY_STEPS.api_error)],
    103: [failedJob('review / review', NO_VERDICT_STEP)],
    201: [failedJob('implement / implement')],
    202: [{ ...failedJob('implement / implement'), conclusion: 'timed_out' }],
    203: [],
    301: [failedJob('rebase / resolve (12)', RETRY_STEPS.unreachable), failedJob('rebase / resolve (13)')],
  },
  attempts: { '302/1': 'failure', '401/2': 'startup_failure', '401/1': 'cancelled' },
});
