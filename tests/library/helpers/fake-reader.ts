/**
 * A reader double for code that reads GitHub through an injected reader (`scripts/status/reader.mjs`):
 * a REST `GET`, every page of one, and a GraphQL query. Each answer comes from a small world of
 * plain fixtures, shaped as the API shapes it, and every request is recorded, so a test can say
 * what was asked as well as what came back.
 *
 * Anything the world doesn't answer throws `unrouted: …`, as the `gh` doubles it replaced did, so
 * a read the code under test didn't used to make fails the test by name.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A pull request, as the reconciler reads one. Every field is optional. */
export interface FakePr {
  number?: number;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeCommit?: { oid: string } | null;
  title?: string;
  body?: string;
  headRefOid?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  /** Newest last, as `gh pr view --json commits` gave them; only the last is read. */
  commits?: Array<{ committedDate?: string }>;
  reviews?: Array<Record<string, unknown>>;
}

/** A workflow run, in the reconciler's shape (`gh run list --json`). */
export interface FakeRun {
  databaseId: number;
  displayTitle: string;
  status: string;
  conclusion?: string | null;
  url?: string;
}

export interface FakeWorld {
  /** issue → the pull requests that close it: a number for one in the repository read, or
   *  `{ number, repo, state }` for one in another repository (kanon#1412) */
  closedBy?: Record<number, Array<number | { number: number; repo: string; state?: string }>>;
  /** pull request number → the pull request */
  prs?: Record<number, FakePr>;
  /** issue → its comments, `{ author: { login }, body, createdAt }` */
  comments?: Record<number, Array<Record<string, unknown>>>;
  /** issue → its state and label names */
  issues?: Record<number, { state?: string; labels?: string[] }>;
  /** issue → its REST events */
  events?: Record<number, Array<Record<string, unknown>>>;
  /** every label in the repository */
  labels?: string[];
  /** search query → the issues found, in `gh issue list --json`'s shape (labels as `{ name }`) */
  search?: (q: string) => Array<Record<string, unknown>>;
  /** branch → the pull requests opened from it, `{ number, state, createdAt }` */
  branchPrs?: Record<string, Array<Record<string, unknown>>>;
  /** release tags, newest first */
  releases?: string[];
  /** a deploy workflow's runs, newest first, whatever the workflow */
  runs?: FakeRun[];
  /** run id → its jobs, `{ name, conclusion }`; `undefined` answers without a `jobs` array */
  jobs?: Record<number, Array<Record<string, unknown>> | undefined>;
  /** `compare/<base>...<head>`'s status */
  compare?: (base: string, head: string) => string;
  /** `compare/<base>...<head>`'s commits, `{ sha, commit: { message } }` */
  compareCommits?: (base: string, head: string) => Array<Record<string, unknown>>;
  /** tag → the commit it points at */
  tagShas?: Record<string, string>;
  /** files on the default branch, path → text */
  files?: Record<string, string>;
  /** the default branch's name, `main` when unset */
  branch?: string;
  /** any other REST `GET`, consulted first */
  get?: (path: string) => unknown;
  /** any other REST pages read, consulted first */
  pages?: (path: string) => unknown[] | undefined;
  /** any GraphQL operation, by name, consulted first */
  graphql?: Record<string, (variables: Record<string, Any>) => unknown>;
}

/** A connection with every node on one page. */
export const connection = (nodes: unknown[]) => ({
  nodes,
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: null },
});

/** A failed read with an HTTP status, as `ReadError` carries one. */
export class FakeHttpError extends Error {
  status: number;
  expected = false;
  constructor(read: string, status: number) {
    super(`HTTP ${status}`);
    this.name = read;
    this.status = status;
  }
}

const unrouted = (what: string) => new Error(`unrouted: ${what}`);
const opOf = (query: string) => /query\s+(\w+)/.exec(query)?.[1] ?? 'query';

/** The pull request a fixture names, in the GraphQL shape the reconciler's queries ask for. */
const prNode = (number: number, pr: FakePr) => ({
  number: pr.number ?? number,
  state: pr.state ?? 'MERGED',
  mergeCommit: pr.mergeCommit === undefined ? { oid: 'sha1' } : pr.mergeCommit,
  title: pr.title ?? '',
  body: pr.body ?? '',
  headRefOid: pr.headRefOid ?? null,
  mergeable: pr.mergeable,
  mergeStateStatus: pr.mergeStateStatus,
  commits: { nodes: (pr.commits ?? []).slice(-1).map((commit) => ({ commit })) },
  reviews: connection(pr.reviews ?? []),
});

/**
 * A reader over a fake world, and the requests it saw: `GET <path>`, `PAGES <path>`, and
 * `GraphQL <operation> <variables as JSON>`.
 */
export function fakeReader(world: FakeWorld = {}) {
  const seen: string[] = [];
  const get = (path: string): unknown => {
    seen.push(`GET ${path}`);
    if (world.get) {
      const r = world.get(path);
      if (r !== undefined) return r;
    }
    const [bare] = path.split('?');
    let m: RegExpExecArray | null;
    if (/^repos\/[^/]+\/[^/]+$/.test(bare!)) return { default_branch: world.branch ?? 'main' };
    if (/^repos\/[^/]+\/[^/]+\/releases$/.test(bare!) && world.releases) return world.releases.map((tag_name) => ({ tag_name }));
    if ((m = /^repos\/[^/]+\/[^/]+\/compare\/(.+)\.\.\.(.+)$/.exec(bare!)) && world.compare) return { status: world.compare(m[1]!, m[2]!) };
    if ((m = /^repos\/[^/]+\/[^/]+\/commits\/(.+)$/.exec(bare!)) && world.tagShas) {
      if (!(m[1]! in world.tagShas)) throw new FakeHttpError(`GET ${path}`, 404);
      return { sha: world.tagShas[m[1]!] };
    }
    if (/^repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/runs$/.test(bare!) && world.runs) {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      return {
        workflow_runs: world.runs.slice((page - 1) * 100, page * 100).map((r) => ({
          id: r.databaseId, display_title: r.displayTitle, status: r.status, conclusion: r.conclusion ?? null, html_url: r.url,
        })),
      };
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(bare!)) && world.files) {
      const text = world.files[decodeURIComponent(m[1]!)];
      if (text === undefined) throw new FakeHttpError(`GET ${path}`, 404);
      return { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), sha: 'blob' };
    }
    throw unrouted(`GET ${path}`);
  };
  const pages = (path: string): unknown[] => {
    seen.push(`PAGES ${path}`);
    if (world.pages) {
      const r = world.pages(path);
      if (r !== undefined) return r;
    }
    const [bare] = path.split('?');
    let m: RegExpExecArray | null;
    if ((m = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/.exec(bare!)) && world.jobs) {
      const jobs = world.jobs[Number(m[1])];
      return [jobs === undefined ? {} : { total_count: jobs.length, jobs }];
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/compare\/(.+)\.\.\.(.+)$/.exec(bare!))) {
      return [{ commits: world.compareCommits?.(m[1]!, m[2]!) ?? [] }];
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events$/.exec(bare!)) && world.events) {
      return [world.events[Number(m[1])] ?? []];
    }
    throw unrouted(`PAGES ${path}`);
  };
  const graphql = (query: string, variables: Record<string, Any> = {}): unknown => {
    const op = opOf(query);
    seen.push(`GraphQL ${op} ${JSON.stringify(variables)}`);
    const own = world.graphql?.[op];
    if (own) return own(variables);
    const n = Number(variables.number);
    const repository = (inner: unknown) => ({ repository: inner });
    switch (op) {
      case 'ClosedBy':
        if (!world.closedBy) break;
        // Each node names its repository, as the real connection does: the read's own unless the
        // world says another (kanon#1412).
        return repository({ issue: { closedByPullRequestsReferences: connection((world.closedBy[n] ?? []).map((ref) => (typeof ref === 'number'
          ? { number: ref, repository: { nameWithOwner: `${variables.owner}/${variables.name}` } }
          : { number: ref.number, state: ref.state ?? 'MERGED', repository: { nameWithOwner: ref.repo } }))) } });
      case 'PullRequestMerge':
      case 'PullRequest': {
        const pr = world.prs?.[n] ?? (world.prs ? undefined : {});
        if (pr === undefined) throw unrouted(`GraphQL ${op} #${n}`);
        return repository({ pullRequest: prNode(n, pr) });
      }
      case 'Comments':
        if (!world.comments) break;
        return repository({ issue: { comments: connection(world.comments[n] ?? []) } });
      case 'Issue': {
        const issue = world.issues?.[n];
        if (!issue) break;
        return repository({ issue: { state: issue.state ?? 'OPEN', labels: connection((issue.labels ?? []).map((name) => ({ name }))) } });
      }
      case 'Labels':
        if (!world.labels) break;
        return repository({ labels: connection(world.labels.map((name) => ({ name }))) });
      case 'Members': {
        if (!world.search) break;
        const found = world.search(String(variables.q)).map((i) => ({
          ...i,
          labels: connection(((i.labels as Array<{ name: string } | string>) ?? []).map((l) => (typeof l === 'string' ? { name: l } : l))),
        }));
        return { search: { ...connection(found), issueCount: found.length } };
      }
      case 'PullRequestsOn':
        if (!world.branchPrs) break;
        return repository({ pullRequests: connection(world.branchPrs[String(variables.head)] ?? []) });
      default:
        break;
    }
    throw unrouted(`GraphQL ${op} ${JSON.stringify(variables)}`);
  };
  return { reader: { get, pages, graphql }, seen };
}

/** The reads a reconciler io object takes, over a fake world: `{ reader, repo, warn }`. */
export function fakeReads(world: FakeWorld = {}, { repo = 'o/r', warn = () => {} }: { repo?: string; warn?: (m: string) => void } = {}) {
  const { reader, seen } = fakeReader(world);
  return { reader, repo, warn, seen };
}
