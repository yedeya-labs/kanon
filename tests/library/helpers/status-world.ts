/**
 * A repository's default branch and issues, as the status core reads them through its reader
 * (`scripts/status/`): the fixture adopter's declarations, a brief for its project 7, the issues
 * carrying the project marker and their pull requests. Shared by the core's tests and the
 * `kanon status` command's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
