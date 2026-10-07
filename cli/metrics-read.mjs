// What `kanon metrics dry-run` reads from GitHub (plan 0003 M2, kanon#516): the pull requests
// closed in a window, each with its files, commits, reviews, timeline and closing issues, in
// `scripts/metrics/types.mjs`'s `PullRequest` shape. Reads only: every call is a GraphQL query
// or a REST GET.
//
// GRAPHQL WHERE IT SAVES CALLS. One query lists a page of pull requests with every list nested,
// so a repository's month of pull requests is a few dozen calls, not one per list per pull
// request. A nested list longer than its first page is paged on its own, for that pull request
// only. GraphQL has no rename's old path, so a pull request with a renamed file has its files
// read once more from REST's `pulls/{n}/files`, which has it.
//
// THE WINDOW. Pull requests are listed newest-updated first, and the listing stops at the first
// page that ends before `since`: a pull request's `updatedAt` is never before its `closedAt`, so
// none closed in the window is further down. A pull request updated while the listing runs
// moves to the top and may shift another across a page boundary; the listing is deduplicated by
// number, and a run that needs every last one is run again.
//
// NOTHING IS DROPPED SILENTLY. GitHub caps a pull request's commits at 250 and its files at
// 3,000. A list GitHub stops short of its `totalCount` is TRUNCATED, and that pull request is
// left out under that reason, as one whose nested page couldn't be read is left out as
// UNREADABLE; the command's exit code says the run is incomplete. A listing that can't be
// finished, an exhausted rate limit or a GraphQL error stops the run.

/** @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult */
/** @typedef {(args: string[]) => Promise<GhResult>} Gh */

/** Thrown when the reading can't go on; the message names no title, login or path. */
export class ReadError extends Error {}

/** The GraphQL points below which the reader stops, rather than spend the token's last ones. */
export const RATE_FLOOR = 100;

/** How often a call refused by a secondary rate limit or a gateway error is tried again. */
export const RETRIES = 3;

/** The timeline events the work-item row and the detectors read (`types.mjs`, `stages.mjs`). */
const PR_EVENTS = [
  'LABELED_EVENT', 'UNLABELED_EVENT', 'MERGED_EVENT', 'CLOSED_EVENT', 'HEAD_REF_FORCE_PUSHED_EVENT',
  'CROSS_REFERENCED_EVENT', 'ADDED_TO_MERGE_QUEUE_EVENT', 'REMOVED_FROM_MERGE_QUEUE_EVENT',
];

const ACTOR = 'login __typename';
const PAGE = 'pageInfo { hasNextPage endCursor }';

/** Each nested list: where it hangs, its arguments and the fields of one node. */
const LISTS = {
  labels: { on: 'pullRequest', args: '', node: 'name', counted: true },
  files: { on: 'pullRequest', args: '', node: 'path additions deletions changeType', counted: true },
  commits: {
    on: 'pullRequest', args: '', counted: true,
    node: 'commit { oid message committedDate author { name user { login } } committer { name user { login } } }',
  },
  reviews: { on: 'pullRequest', args: '', node: `state submittedAt body author { ${ACTOR} } commit { oid }`, counted: true },
  timelineItems: {
    on: 'pullRequest', args: `, itemTypes: [${PR_EVENTS.join(', ')}]`, counted: false,
    node: `__typename
      ... on LabeledEvent { createdAt actor { ${ACTOR} } label { name } }
      ... on UnlabeledEvent { createdAt actor { ${ACTOR} } label { name } }
      ... on MergedEvent { createdAt actor { ${ACTOR} } commit { oid } }
      ... on ClosedEvent { createdAt actor { ${ACTOR} } }
      ... on HeadRefForcePushedEvent { createdAt actor { ${ACTOR} } afterCommit { oid } }
      ... on AddedToMergeQueueEvent { createdAt actor { ${ACTOR} } }
      ... on RemovedFromMergeQueueEvent { createdAt actor { ${ACTOR} } }
      ... on CrossReferencedEvent { createdAt actor { ${ACTOR} } source {
        __typename
        ... on Issue { number repository { nameWithOwner } }
        ... on PullRequest { number repository { nameWithOwner } } } }`,
  },
  closingIssuesReferences: { on: 'pullRequest', args: '', node: '', counted: true }, // node: ISSUE, below
  issueLabels: { on: 'issue', field: 'labels', args: '', node: 'name', counted: true },
  issueTimeline: {
    on: 'issue', field: 'timelineItems', args: ', itemTypes: [LABELED_EVENT]', counted: false,
    node: `__typename ... on LabeledEvent { createdAt actor { ${ACTOR} } label { name } }`,
  },
};

/** A connection's selection, `first` nodes from `after`. @param {string} field @param {number} first @param {string} args @param {string} node */
const connection = (field, first, args, node) => `${field}(first: ${first}${args}) { totalCount ${PAGE} nodes { ${node} } }`;

/** @param {number} n the nested page size */
const issueNode = (n) => `number body createdAt author { ${ACTOR} }
  issueDependenciesSummary { totalBlockedBy }
  ${connection('labels', n, '', LISTS.issueLabels.node)}
  ${connection('timelineItems', n, LISTS.issueTimeline.args, LISTS.issueTimeline.node)}`;

/** @param {number} n */
const prNode = (n) => `number state title body createdAt updatedAt closedAt mergedAt
  author { ${ACTOR} } mergedBy { ${ACTOR} }
  mergeCommit { oid parents(first: 1) { nodes { oid } } }
  ${['labels', 'files', 'commits', 'reviews', 'timelineItems'].map((k) => {
    const l = LISTS[/** @type {'labels'} */ (k)];
    return connection(k, n, l.args, l.node);
  }).join('\n  ')}
  ${connection('closingIssuesReferences', Math.min(n, 25), '', issueNode(n))}`;

const RATE = 'rateLimit { cost remaining resetAt }';

/** The listing query, one page of pull requests. @param {number} first @param {number} nested */
export const listQuery = (first, nested) => `query DryRunList($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${first}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      ${PAGE} nodes { ${prNode(nested)} }
    }
  }
  ${RATE}
}`;

/**
 * The query for the rest of one nested list of one pull request or issue.
 * @param {keyof typeof LISTS} list @param {number} first
 */
export const pageQuery = (list, first) => {
  const l = LISTS[list];
  const field = 'field' in l && l.field ? l.field : list;
  // A closing issue nests two lists of its own, so its pages stay at 25, as in the listing.
  const issues = list === 'closingIssuesReferences';
  const node = issues ? issueNode(first) : l.node;
  return `query DryRunPage($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    ${l.on}(number: $number) { ${field}(first: ${issues ? Math.min(first, 25) : first}, after: $after${l.args}) { totalCount ${PAGE} nodes { ${node} } } }
  }
  ${RATE}
}`;
};

/**
 * @typedef {{ gh: Gh, sleep: (ms: number) => Promise<void>, progress: (line: string) => void }} ReadDeps
 * @typedef {{ prPage?: number, nestedPage?: number }} ReadSizes
 */

/** @param {string} stderr */
const retryable = (stderr) => /secondary rate limit|abuse detection|HTTP 429|HTTP 502|HTTP 503|HTTP 504|timed? ?out/i.test(stderr);

/**
 * One GraphQL call, its `data` returned. Retries a secondary rate limit or a gateway error;
 * stops on a GraphQL error, a failed call, or a primary rate limit about to run out.
 * @param {ReadDeps} deps @param {string} query @param {Record<string, string | number | null>} vars
 */
async function graphql(deps, query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  /** @type {GhResult} */
  let r = { status: null, stdout: '', stderr: '' };
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    r = await deps.gh(args);
    if (r.status === 0 || !retryable(r.stderr)) break;
    if (attempt < RETRIES) {
      deps.progress(`GitHub asked to slow down; trying again in ${30 * (attempt + 1)} s.`);
      await deps.sleep(30_000 * (attempt + 1));
    }
  }
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(r.stdout || 'null');
  } catch {
    doc = null;
  }
  if (doc?.errors?.length) {
    const types = [...new Set(doc.errors.map((/** @type {any} */ e) => e.type ?? 'error'))].join(', ');
    throw new ReadError(`GitHub's GraphQL API answered with an error (${types}): ${String(doc.errors[0]?.message ?? '').slice(0, 200)}`);
  }
  if (r.status !== 0 || !doc?.data) throw new ReadError(`a GitHub GraphQL call failed: ${(r.stderr.trim() || `gh exited ${r.status}`).slice(0, 300)}`);
  const rate = doc.data.rateLimit;
  if (rate && typeof rate.remaining === 'number' && rate.remaining < RATE_FLOOR) {
    throw new ReadError(`the token has ${rate.remaining} GraphQL points left, under the ${RATE_FLOOR} this command keeps; they reset at ${rate.resetAt}. Run it again then.`);
  }
  return doc.data;
}

/** Marks a pull request as one the reader leaves out. */
class LeftOut extends Error {
  /** @param {'truncated' | 'unreadable'} reason */
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * The rest of a nested list, from the cursor its first page ended on.
 * @param {ReadDeps} deps @param {{ owner: string, name: string }} repo
 * @param {keyof typeof LISTS} list @param {number} number @param {any} first the first page's connection
 * @param {number} size
 */
async function wholeList(deps, repo, list, number, first, size) {
  const nodes = [...first.nodes];
  let page = first.pageInfo;
  while (page.hasNextPage) {
    /** @type {any} */
    let data;
    try {
      data = await graphql(deps, pageQuery(list, size), { owner: repo.owner, name: repo.name, number, after: page.endCursor });
    } catch (e) {
      if (/GraphQL points left/.test(/** @type {Error} */ (e).message)) throw e;
      throw new LeftOut('unreadable');
    }
    const l = LISTS[list];
    const field = 'field' in l && l.field ? l.field : list;
    const conn = data.repository?.[l.on]?.[field];
    if (!conn) throw new LeftOut('unreadable');
    nodes.push(...conn.nodes);
    page = conn.pageInfo;
  }
  if (LISTS[list].counted && typeof first.totalCount === 'number' && nodes.length < first.totalCount) throw new LeftOut('truncated');
  return nodes;
}

/** @param {any} a @returns {import('../scripts/metrics/types.mjs').Actor | null} */
const actor = (a) => (a && typeof a.login === 'string' ? { login: a.login, type: a.__typename } : null);

/** A commit's author or committer: the account GitHub links its email to, else a bot by its name. @param {any} g */
const gitActor = (g) => {
  const login = g?.user?.login;
  if (typeof login === 'string') return { login, type: /\[bot\]$/.test(login) ? 'Bot' : 'User' };
  if (typeof g?.name === 'string' && /\[bot\]$/.test(g.name)) return { login: g.name, type: 'Bot' };
  return null;
};

const STATUS = /** @type {const} */ ({ ADDED: 'added', DELETED: 'removed', MODIFIED: 'modified', RENAMED: 'renamed', COPIED: 'copied', CHANGED: 'changed' });

/** @param {any} ev @returns {import('../scripts/metrics/types.mjs').TimelineEvent | null} */
function timelineEvent(ev) {
  const base = { created_at: ev.createdAt, actor: actor(ev.actor) };
  switch (ev.__typename) {
    case 'LabeledEvent': return { event: 'labeled', ...base, label: ev.label?.name };
    case 'UnlabeledEvent': return { event: 'unlabeled', ...base, label: ev.label?.name };
    case 'MergedEvent': return { event: 'merged', ...base, ...(ev.commit?.oid ? { commit_id: ev.commit.oid } : {}) };
    case 'ClosedEvent': return { event: 'closed', ...base };
    case 'HeadRefForcePushedEvent': return { event: 'head_ref_force_pushed', ...base, ...(ev.afterCommit?.oid ? { commit_id: ev.afterCommit.oid } : {}) };
    case 'AddedToMergeQueueEvent': return { event: 'added_to_merge_queue', ...base };
    case 'RemovedFromMergeQueueEvent': return { event: 'removed_from_merge_queue', ...base };
    case 'CrossReferencedEvent': {
      const s = ev.source;
      if (!s || typeof s.number !== 'number' || !s.repository?.nameWithOwner) return { event: 'cross-referenced', ...base };
      return {
        event: 'cross-referenced', ...base,
        source: { type: s.__typename === 'PullRequest' ? 'pull_request' : 'issue', number: s.number, repository: s.repository.nameWithOwner },
      };
    }
    default: return null;
  }
}

/**
 * One GraphQL pull request, its nested lists whole, in `types.mjs`'s shape.
 * @param {any} node @param {Map<string, string>} renames new path → old path, from REST
 * @returns {import('../scripts/metrics/types.mjs').PullRequest}
 */
export function toPullRequest(node, renames = new Map()) {
  return {
    number: node.number,
    state: node.state === 'OPEN' ? 'open' : 'closed',
    title: node.title ?? '',
    created_at: node.createdAt,
    closed_at: node.closedAt ?? null,
    merged_at: node.mergedAt ?? null,
    merge_commit_sha: node.mergeCommit?.oid ?? null,
    parent_sha: node.mergeCommit?.parents?.nodes?.[0]?.oid ?? null,
    author: actor(node.author),
    merged_by: actor(node.mergedBy),
    body: node.body ?? null,
    labels: node.labels.nodes.map((/** @type {any} */ l) => l.name),
    files: node.files.nodes.map((/** @type {any} */ f) => ({
      path: f.path,
      status: STATUS[/** @type {keyof typeof STATUS} */ (f.changeType)] ?? 'changed',
      additions: f.additions,
      deletions: f.deletions,
      ...(renames.has(f.path) ? { previous_path: renames.get(f.path) } : {}),
    })),
    commits: node.commits.nodes.map((/** @type {any} */ { commit: c }) => ({
      sha: c.oid, message: c.message, committed_at: c.committedDate, author: gitActor(c.author), committer: gitActor(c.committer),
    })),
    reviews: node.reviews.nodes.filter((/** @type {any} */ r) => r.submittedAt).map((/** @type {any} */ r) => ({
      state: r.state, submitted_at: r.submittedAt, author: actor(r.author), commit_id: r.commit?.oid ?? '', body: r.body ?? null,
    })),
    timeline: node.timelineItems.nodes.map(timelineEvent).filter((/** @type {any} */ e) => e !== null),
    closing_issues: node.closingIssuesReferences.nodes.map((/** @type {any} */ i) => ({
      number: i.number,
      labels: i.labels.nodes.map((/** @type {any} */ l) => l.name),
      body: i.body ?? null,
      ...(i.createdAt ? { created_at: i.createdAt } : {}),
      author: actor(i.author),
      timeline: i.timelineItems.nodes.map(timelineEvent).filter((/** @type {any} */ e) => e !== null),
      ...(typeof i.issueDependenciesSummary?.totalBlockedBy === 'number' ? { blocked_by: i.issueDependenciesSummary.totalBlockedBy } : {}),
    })),
  };
}

/**
 * A renamed file's old path, by its new one, from REST, which GraphQL lacks.
 * @param {ReadDeps} deps @param {string} repo @param {number} number
 */
async function renamesOf(deps, repo, number) {
  const r = await deps.gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/files?per_page=100`]);
  if (r.status !== 0) throw new LeftOut('unreadable');
  /** @type {any[]} */
  let files;
  try {
    files = JSON.parse(r.stdout).flat();
  } catch {
    throw new LeftOut('unreadable');
  }
  return new Map(files.filter((f) => f.previous_filename).map((f) => [f.filename, f.previous_filename]));
}

/**
 * Fills one pull request's nested lists whole, and its renames.
 * @param {ReadDeps} deps @param {{ owner: string, name: string }} repo @param {any} node @param {number} size
 */
async function complete(deps, repo, node, size) {
  for (const list of /** @type {const} */ (['labels', 'files', 'commits', 'reviews', 'timelineItems', 'closingIssuesReferences'])) {
    node[list] = { ...node[list], nodes: await wholeList(deps, repo, list, node.number, node[list], size) };
  }
  for (const issue of node.closingIssuesReferences.nodes) {
    issue.labels = { nodes: await wholeList(deps, repo, 'issueLabels', issue.number, issue.labels, size) };
    issue.timelineItems = { nodes: await wholeList(deps, repo, 'issueTimeline', issue.number, issue.timelineItems, size) };
  }
  const renamed = node.files.nodes.some((/** @type {any} */ f) => f.changeType === 'RENAMED');
  return toPullRequest(node, renamed ? await renamesOf(deps, `${repo.owner}/${repo.name}`, node.number) : new Map());
}

/**
 * Every pull request of `repo` closed in [since, until), read whole, and those left out.
 * @param {ReadDeps} deps @param {string} repo `owner/name` @param {{ since: Date, until: Date | null }} window
 * @param {ReadSizes} [sizes]
 * @returns {Promise<{
 *   prs: import('../scripts/metrics/types.mjs').PullRequest[],
 *   leftOut: { pr: number, reason: 'open' | 'truncated' | 'unreadable' }[],
 *   calls: number,
 * }>}
 */
export async function readPullRequests(deps, repo, window, { prPage = 15, nestedPage = 100 } = {}) {
  const [owner = '', name = ''] = repo.split('/');
  const since = window.since.getTime();
  const until = window.until ? window.until.getTime() : Infinity;
  const inWindow = (/** @type {string | null} */ t) => t !== null && Date.parse(t) >= since && Date.parse(t) < until;
  let calls = 0;
  const counting = { ...deps, gh: /** @type {Gh} */ ((args) => { calls += 1; return deps.gh(args); }) };
  /** @type {Map<number, import('../scripts/metrics/types.mjs').PullRequest>} */
  const prs = new Map();
  /** @type {Map<number, 'open' | 'truncated' | 'unreadable'>} */
  const left = new Map();
  /** @type {string | null} */
  let after = null;
  for (let page = 1; ; page += 1) {
    const data = await graphql(counting, listQuery(prPage, nestedPage), { owner, name, after });
    const conn = data.repository?.pullRequests;
    if (!conn) throw new ReadError(`GitHub returned no pull requests for ${repo}; check the name and that the token can read it`);
    deps.progress(`Read page ${page} of the pull requests.`);
    for (const node of conn.nodes) {
      if (prs.has(node.number) || left.has(node.number)) continue;
      if (node.state === 'OPEN') {
        if (inWindow(node.createdAt)) left.set(node.number, 'open');
        continue;
      }
      if (!inWindow(node.closedAt)) continue;
      try {
        prs.set(node.number, await complete(counting, { owner, name }, node, nestedPage));
      } catch (e) {
        if (e instanceof LeftOut) left.set(node.number, e.reason);
        else throw e;
      }
    }
    const last = conn.nodes.at(-1);
    if (!conn.pageInfo.hasNextPage || !last || Date.parse(last.updatedAt) < since) break;
    after = conn.pageInfo.endCursor;
  }
  const byNumber = (/** @type {{ pr: number }} */ a, /** @type {{ pr: number }} */ b) => a.pr - b.pr;
  return {
    prs: [...prs.values()].sort((a, b) => a.number - b.number),
    leftOut: [...left].map(([pr, reason]) => ({ pr, reason })).sort(byNumber),
    calls,
  };
}
