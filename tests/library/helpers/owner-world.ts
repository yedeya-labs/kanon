/**
 * A repository as the needs-the-Owner view reads it (project #1327, Issue F): its open pull
 * requests, each one's own world as the readiness view reads it (`pr-world.ts`), its open issues
 * with their labels and comments, the runs still going, and its lane callers with their runs
 * (`status-world.ts`'s `laneWorld`), all over one recording reader.
 */
import { DEFAULT_FILES, REPO, approval, implementerPr, readerFor, type PrWorld } from './pr-world.js';
import { connection } from './fake-reader.js';
import { laneWorld, type LaneRun } from './status-world.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export type OwnerIssue = {
  number: number;
  title: string;
  labels: string[];
  /** oldest first, as `{ author: { login }, body, createdAt }` */
  comments?: Array<{ login: string; body: string; createdAt: string }>;
};

/** A head of its own for each pull request, so no two share one. */
export const headOf = (n: number) => n.toString(16).padStart(40, 'c');

/** `w` as pull request `n`, on a head of its own, its Reviewer's stamps moved to that head. */
export const numbered = (n: number, w: PrWorld): PrWorld => ({
  ...w,
  number: n,
  head: headOf(n),
  reviews: w.reviews.map((r) => (r.commit === w.head ? { ...approval(r.id, headOf(n), r.state), login: r.login } : r)),
});

/** A run of the implement lane still going, fired by the issue titled `title`, started `at`. */
export const liveRun = (id: number, title: string, at: string) => ({
  id, event: 'issues', status: 'in_progress', display_title: title, created_at: at,
  referenced_workflows: [{ path: 'yedeya-labs/kanon/.github/workflows/agent-implement.yml@v0.42.0' }],
});

export function ownerWorld({
  prs = [], issues = [], live = [], workflows = {}, runs = {}, jobs = {}, branches = {}, defaultFiles = DEFAULT_FILES(),
  overrides = {},
}: {
  prs?: PrWorld[]; issues?: OwnerIssue[]; live?: Array<Record<string, unknown>>; workflows?: Record<string, string>;
  runs?: Record<string, LaneRun[]>; jobs?: Record<number, Array<Record<string, unknown>> | undefined>;
  /** pull request → its head branch's name; `pr-<n>` unless given */
  branches?: Record<number, string>;
  defaultFiles?: Record<string, string>;
  overrides?: { get?: (p: string) => unknown; pages?: (p: string) => unknown[] | undefined; graphql?: Record<string, (v: Any) => unknown> };
}) {
  const files = { ...defaultFiles, ...Object.fromEntries(Object.entries(workflows).map(([f, text]) => [`.github/workflows/${f}`, text])) };
  const per = prs.map((w) => readerFor({ ...w, defaultFiles: files }));
  // The default branch's files, for a world with no pull request to answer them.
  const home = readerFor({ ...numbered(99999, implementerPr()), defaultFiles: files });
  const lanes = laneWorld({ workflows, runs, jobs });
  const seen: string[] = [];
  const queries: string[] = [];
  const whose = (path: string) => {
    const i = prs.findIndex((w) => path.includes(`/pulls/${w.number}/`) || path.includes(`/issues/${w.number}/`) || path.includes(w.head));
    return i < 0 ? null : per[i]!;
  };
  const isLane = (path: string) => /\/actions\/(workflows\/[^/]+\/runs|runs\/\d+\/(jobs|attempts))/.test(path);
  const base = `repos/${REPO}`;
  const issueNode = (i: OwnerIssue) => ({ number: i.number, title: i.title, url: `https://github.com/${REPO}/issues/${i.number}`, labels: connection(i.labels.map((name) => ({ name }))) });
  const reader = {
    get: (path: string) => {
      seen.push(`GET ${path}`);
      const own = overrides.get?.(path);
      if (own !== undefined) return own;
      if (isLane(path)) return lanes.reader.get(path);
      return (whose(path) ?? home).reader.get(path);
    },
    pages: (path: string) => {
      seen.push(`PAGES ${path}`);
      const own = overrides.pages?.(path);
      if (own !== undefined) return own;
      const status = new RegExp(`^${base}/actions/runs\\?status=(\\w+)&event=issues&per_page=100$`).exec(path)?.[1];
      if (status) {
        const found = live.filter((r) => r.status === status);
        return [{ total_count: found.length, workflow_runs: found }];
      }
      if (isLane(path)) return lanes.reader.pages(path);
      return (whose(path) ?? home).reader.pages(path);
    },
    graphql: (query: string, variables: Record<string, Any> = {}) => {
      queries.push(query);
      const op = /query\s+(\w+)/.exec(query)?.[1] ?? 'query';
      seen.push(`GraphQL ${op} ${JSON.stringify(variables)}`);
      const own = overrides.graphql?.[op];
      if (own) return own(variables);
      if (op === 'OpenPullRequests') {
        return {
          repository: {
            pullRequests: connection(prs.map((w) => ({
              number: w.number,
              headRefName: branches[w.number] ?? `pr-${w.number}`,
              closingIssuesReferences: connection(w.closes.map((i) => ({ number: i.number, repository: { nameWithOwner: i.repo ?? REPO } }))),
            }))),
          },
        };
      }
      if (op === 'OwnerIssues') {
        const wanted = new Set(variables.labels as string[]);
        return { repository: { issues: connection(issues.filter((i) => i.labels.some((l) => wanted.has(l))).map(issueNode)) } };
      }
      if (op === 'Comments') {
        const i = issues.find((x) => x.number === Number(variables.number));
        if (!i) throw new Error(`unrouted: GraphQL Comments #${variables.number}`);
        return { repository: { issue: { comments: connection((i.comments ?? []).map((c) => ({ author: { login: c.login }, body: c.body, createdAt: c.createdAt }))) } } };
      }
      if (op === 'PullRequestGate') {
        const i = prs.findIndex((w) => w.number === Number(variables.number));
        if (i < 0) throw new Error(`unrouted: GraphQL PullRequestGate #${variables.number}`);
        return per[i]!.reader.graphql(query, variables);
      }
      return home.reader.graphql(query, variables);
    },
  };
  return { reader, repo: REPO, seen, queries };
}
