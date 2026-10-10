import { describe, expect, it } from 'vitest';
import { stamp } from '../../infra/telemetry/function/index.mjs';
import { SCHEMAS, validate } from '../../actions/agent-telemetry/schema.mjs';
import { collect } from '../../scripts/telemetry-collect.mjs';
import { mentionsOf, pinOf, workItemStep } from '../../scripts/telemetry-work-items.mjs';
import { followupsOf } from '../../scripts/metrics/followups.mjs';
import { referencingCommits, SOURCE_LABELS, toPullRequest } from '../../cli/metrics-read.mjs';
import { workItemRow } from '../../scripts/metrics/work-item.mjs';

/**
 * Plan 0003 M4 (kanon#658): the collector's work-item step. Each sweep writes one row per pull
 * request closed in its span, and writes again the row of an earlier item whose story the span
 * changed: a revert, a linked fix, a Reviewer follow-up closed for any reason. The store keys a
 * work item by its PR number alone, so a PR closed, reopened and merged is one row.
 *
 * GitHub is a fake that answers the metrics reader's GraphQL queries and the step's REST reads from
 * a small world of pull requests and issues, changed between sweeps as time passes. The store is
 * the ingest function's own `stamp`, its keys and its windows, over a map: what it holds after a
 * sweep is what the table would.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL- and REST-shaped fixtures
type Node = Record<string, any>;

const REPO = 'example/adopter';
const KEY = 'k1';
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-05T12:40:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha = (n: number | string) => String(n).padStart(40, 'a');

const AUTHOR = { login: 'acme-author', __typename: 'Bot' };
const JUDGE = { login: 'acme-judge', __typename: 'Bot' };
const HUMAN = { login: 'octo-zebra-login', __typename: 'User' };
const REGISTER = `# Agent identities

| Role | App slug |
| --- | --- |
| Implementer | \`acme-author\` |
| Reviewer | \`acme-judge\` |
| Merger | \`acme-judge\` |
`;
const CALLER = (v: string) => `jobs:\n  collect:\n    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@v${v}\n`;

/** A GitHub of pull requests and issues, read the way the step reads it. */
class World {
  prs = new Map<number, Node>();
  issues = new Map<number, Node>();
  comments = new Map<number, string[]>();
  pins = new Map<string, string>();
  calls: string[][] = [];

  pr(number: number, o: { opened: number; closed?: number | null; merged?: boolean; files?: string[]; body?: string; title?: string; author?: object; closes?: number[]; commits?: string[] }) {
    const closed = o.closed ?? null;
    const merged = closed !== null && o.merged !== false;
    const node: Node = {
      number, title: o.title ?? `feat: zebra-title-${number}`, body: o.body ?? 'zebra body',
      state: closed === null ? 'OPEN' : merged ? 'MERGED' : 'CLOSED',
      createdAt: iso(o.opened), updatedAt: iso(closed ?? o.opened), closedAt: closed === null ? null : iso(closed), mergedAt: merged ? iso(closed as number) : null,
      author: o.author ?? AUTHOR, mergedBy: merged ? JUDGE : null,
      mergeCommit: merged ? { oid: sha(number), parents: { nodes: [{ oid: sha(`p${number}`) }] } } : null,
      labels: [], reviews: [],
      files: (o.files ?? ['app/zebra.ts']).map((path) => ({ path, additions: 10, deletions: 2, changeType: 'MODIFIED' })),
      commits: (o.commits ?? ['work']).map((message, k) => ({ commit: {
        oid: sha(`h${number}${k}`), message, committedDate: iso(o.opened + MIN), author: { name: 'x', user: { login: AUTHOR.login } }, committer: { name: 'x', user: { login: AUTHOR.login } },
      } })),
      timelineItems: [],
      referenced: [],
      closes: o.closes ?? [],
    };
    this.prs.set(number, node);
    return node;
  }

  issue(number: number, o: { labels: string[]; body?: string; state?: 'OPEN' | 'CLOSED'; reason?: string | null; closed?: number | null; updated?: number }) {
    const node: Node = { number, labels: o.labels, body: o.body ?? 'zebra issue', state: o.state ?? 'OPEN', stateReason: o.reason ?? null, closedAt: o.closed ?? null, updatedAt: o.updated ?? o.closed ?? T0 - 30 * DAY };
    this.issues.set(number, node);
    return node;
  }

  /** GitHub's own record of a mention: a cross-referenced event on the PR, from an issue or PR. */
  mention(pr: number, by: number, at: number) {
    const p = this.prs.get(pr)!;
    p.timelineItems.push({ __typename: 'CrossReferencedEvent', createdAt: iso(at), actor: HUMAN, source: { __typename: this.prs.has(by) ? 'PullRequest' : 'Issue', number: by } });
    p.updatedAt = iso(Math.max(Date.parse(p.updatedAt), at));
  }

  /** GitHub's record of a commit naming a PR (`#n` in its message): a referenced event on the PR, for each of `by`'s commits. */
  reference(pr: number, by: number) {
    const p = this.prs.get(pr)!;
    for (const { commit } of this.prs.get(by)!.commits) {
      p.referenced.push({ __typename: 'ReferencedEvent', commit: { oid: commit.oid, message: commit.message, associatedPullRequests: { nodes: [{ number: by, repository: { nameWithOwner: REPO } }] } } });
    }
  }

  merge(number: number, at: number) {
    const p = this.prs.get(number)!;
    Object.assign(p, { state: 'MERGED', closedAt: iso(at), mergedAt: iso(at), updatedAt: iso(at), mergedBy: JUDGE, mergeCommit: { oid: sha(number), parents: { nodes: [{ oid: sha(`p${number}`) }] } } });
  }

  closeIssue(number: number, at: number, reason: 'COMPLETED' | 'NOT_PLANNED') {
    Object.assign(this.issues.get(number)!, { state: 'CLOSED', stateReason: reason, closedAt: at, updatedAt: at });
    for (const p of this.prs.values()) if (p.timelineItems.some((e: Node) => e.source?.number === number)) p.updatedAt = iso(Math.max(Date.parse(p.updatedAt), at));
  }

  private source(s: Node) {
    const i = this.issues.get(s.number);
    if (s.__typename === 'PullRequest' || !i) return { ...s, repository: { nameWithOwner: REPO } };
    return { ...s, repository: { nameWithOwner: REPO }, state: i.state, stateReason: i.stateReason, labels: { totalCount: i.labels.length, nodes: i.labels.map((name: string) => ({ name })) } };
  }

  private conn(all: Node[]) {
    return { totalCount: all.length, pageInfo: { hasNextPage: false, endCursor: 'c' }, nodes: all };
  }

  private shape(p: Node) {
    const closing = (p.closes as number[]).map((n) => {
      const i = this.issues.get(n)!;
      return {
        number: n, body: i.body, author: HUMAN, issueDependenciesSummary: { totalBlockedBy: 0 },
        labels: this.conn(i.labels.map((name: string) => ({ name }))),
        timelineItems: this.conn([{ __typename: 'LabeledEvent', createdAt: iso(Date.parse(p.createdAt) - MIN), actor: HUMAN, label: { name: 'agent:implement' } }]),
      };
    });
    return {
      ...p, __typename: 'PullRequest',
      labels: this.conn(p.labels), files: this.conn(p.files), commits: this.conn(p.commits), reviews: this.conn(p.reviews),
      timelineItems: this.conn(p.timelineItems.map((e: Node) => (e.source ? { ...e, source: this.source(e.source) } : e))),
      closingIssuesReferences: this.conn(closing),
    };
  }

  gh = async (args: string[]) => {
    this.calls.push(args);
    const ok = (data: object) => ({ status: 0, stdout: JSON.stringify({ data: { ...data, rateLimit: { cost: 1, remaining: 4000, resetAt: iso(T0) } } }), stderr: '' });
    const json = (doc: unknown) => ({ status: 0, stdout: JSON.stringify(doc), stderr: '' });
    if (args[1] === 'graphql') {
      const query = (args[3] ?? '').slice('query='.length);
      const vars: Record<string, string> = {};
      for (let i = 4; i < args.length; i += 2) { const [k, ...v] = (args[i + 1] ?? '').split('='); vars[k ?? ''] = v.join('='); }
      if (query.includes('DryRunList')) {
        const sorted = [...this.prs.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((p) => this.shape(p));
        return ok({ repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: 'c' }, nodes: sorted } } });
      }
      if (query.includes('WorkItemOne')) {
        const n = Number(vars.number);
        const p = this.prs.get(n);
        return ok({ repository: { issueOrPullRequest: p ? this.shape(p) : this.issues.has(n) ? { __typename: 'Issue' } : null } });
      }
      if (query.includes('WorkItemClosers')) {
        const n = Number(vars.number);
        return ok({ repository: { issue: { closedByPullRequestsReferences: { nodes: [...this.prs.values()].filter((p) => p.closes.includes(n)).map((p) => ({ number: p.number })) } } } });
      }
      if (query.includes('WorkItemReferences')) {
        const p = this.prs.get(Number(vars.number));
        return ok({ repository: { pullRequest: p ? { timelineItems: this.conn(p.referenced) } : null } });
      }
      return { status: 1, stdout: '', stderr: `unexpected query ${query.slice(0, 40)}` };
    }
    const path = args.at(-1) ?? '';
    const contents = /^repos\/example\/adopter\/contents\/([^?]+)(?:\?ref=(\w+))?$/.exec(path);
    if (contents) {
      const [, file, ref] = contents;
      if (file === 'docs/qa/agent-identities.md') return { status: 0, stdout: REGISTER, stderr: '' };
      if (file === '.github/workflows/telemetry.yml' && ref && this.pins.has(ref)) return { status: 0, stdout: CALLER(this.pins.get(ref)!), stderr: '' };
      return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    }
    const pulls = /^repos\/example\/adopter\/commits\/(\w+)\/pulls$/.exec(path);
    if (pulls) return json([...this.prs.values()].filter((p) => p.mergeCommit?.oid === pulls[1]).map((p) => ({ number: p.number })));
    if (/^repos\/example\/adopter\/commits\?until=/.test(path)) return json([{ sha: 'base' }]);
    const comments = /^repos\/example\/adopter\/issues\/(\d+)\/comments/.exec(path);
    if (comments) return json([(this.comments.get(Number(comments[1])) ?? []).map((body) => ({ body }))]);
    const listing = /^repos\/example\/adopter\/issues\?state=closed&labels=follow-up,agent%3Areviewer&since=([^&]+)&per_page=100$/.exec(path);
    if (listing) {
      const since = Date.parse(listing[1]!);
      return json([[...this.issues.values()]
        .filter((i) => i.state === 'CLOSED' && i.labels.includes('follow-up') && i.labels.includes('agent:reviewer') && i.updatedAt >= since)
        .map((i) => ({ number: i.number, body: i.body, closed_at: iso(i.closedAt), labels: i.labels.map((name: string) => ({ name })) }))]);
    }
    const bugs = /^repos\/example\/adopter\/issues\?state=all&labels=bug&since=([^&]+)&per_page=100$/.exec(path);
    if (bugs) {
      const since = Date.parse(bugs[1]!);
      return json([[...this.issues.values()]
        .filter((i) => i.labels.includes('bug') && i.updatedAt >= since)
        .map((i) => ({ number: i.number, body: i.body, labels: i.labels.map((name: string) => ({ name })) }))]);
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
}

/** The store: the ingest function's `stamp` (its keys, its windows) over a map. */
class Store {
  items = new Map<string, Record<string, unknown>>();
  rejected: unknown[] = [];
  now = T0;
  post = async (rows: object[]) => ({
    status: 200,
    json: {
      results: rows.map((row) => {
        const s = stamp(row, { caller: { kind: 'writer', key: KEY }, key: KEY, now: this.now });
        if (!s.ok) { this.rejected.push(s.errors); return { status: 'rejected', errors: s.errors }; }
        this.items.set(`${s.item.pk}|${s.item.sk}`, s.item);
        return { status: 'stored' };
      }),
    },
  });
  work() {
    return [...this.items.values()].filter((i) => i.pk === `${KEY}#work`);
  }
  row(pr: number) {
    const rows = this.work().filter((i) => i.pr_number === pr);
    expect(rows.length, `rows for PR #${pr}`).toBeLessThanOrEqual(1);
    return rows[0];
  }
}

const noArtifacts = (path: string) => {
  if (/actions\/artifacts\?/.test(path)) return { artifacts: [] };
  throw new Error(`unexpected path ${path}`);
};

/** One hourly sweep at `now`, the last one an hour before, as the collector runs it. */
async function sweep(world: World, store: Store, now: number) {
  store.now = now;
  return collect({
    repo: REPO, now, lastSuccess: iso(now - 60 * MIN), api: noArtifacts, download: () => { throw new Error('no artifact'); }, post: store.post,
    workItems: (since) => workItemStep({ repo: REPO, since, now, gh: world.gh, sleep: async () => {}, callerFile: 'telemetry.yml' }),
  });
}

describe('the work-item step writes one row per closed PR (plan 0003 M4)', () => {
  it('a PR merged in the span has its row in the store after one sweep, with the caller pin at its merge commit', async () => {
    const world = new World();
    world.issue(4, { labels: ['project:2'] });
    world.pr(41, { opened: T0 - 3 * 60 * MIN, closed: T0 - 30 * MIN, closes: [4] });
    world.pins.set(sha(41), '0.39.0');
    const store = new Store();
    const res = await sweep(world, store, T0);
    expect(res.failures).toEqual([]);
    expect(res.workItems).toBe(1);
    const row = store.row(41)!;
    expect(row).toMatchObject({ pk: `${KEY}#work`, sk: 'pr-0000000041', row_kind: 'work_item', fate: 'merged', closing_issues: '4', kanon_version: '0.39.0', author_kind: 'implementer', merged_by: 'merger' });
    // The row expires 13 months after it closed, whenever it is written (plan 0002 §10).
    expect(row.expires_at).toBe(Math.floor(Date.parse('2027-11-05T12:10:00Z') / 1000));
  });

  it('a PR closed before the span, an open PR and a release PR get no row', async () => {
    const world = new World();
    world.pr(1, { opened: T0 - 9 * DAY, closed: T0 - 8 * DAY });
    world.pr(2, { opened: T0 - 40 * MIN });
    world.pr(3, { opened: T0 - 50 * MIN, closed: T0 - 20 * MIN, title: 'chore(main): release 1.2.3', author: { login: 'github-actions', __typename: 'Bot' } });
    const store = new Store();
    const res = await sweep(world, store, T0);
    expect(res.failures).toEqual([]);
    expect(store.work()).toEqual([]);
  });

  it("leaves kanon_version out when the caller isn't at the commit, and reads a closed-unmerged PR's at the default branch then", async () => {
    const world = new World();
    world.pr(5, { opened: T0 - 2 * 60 * MIN, closed: T0 - 30 * MIN });
    world.pr(6, { opened: T0 - 2 * 60 * MIN, closed: T0 - 20 * MIN, merged: false });
    world.pins.set('base', '0.38.0');
    const store = new Store();
    await sweep(world, store, T0);
    expect(store.row(5)).not.toHaveProperty('kanon_version');
    expect(store.row(6)).toMatchObject({ fate: 'closed_unmerged', kanon_version: '0.38.0' });
  });
});

describe('a later event rewrites the earlier row, whole (plan 0003 §3.1, §3.5)', () => {
  /** PR #41, merged on T0 - 30 min and written by the first sweep. */
  const start = async () => {
    const world = new World();
    world.issue(4, { labels: ['project:2'] });
    world.pr(41, { opened: T0 - 3 * 60 * MIN, closed: T0 - 30 * MIN, closes: [4], files: ['app/zebra.ts', 'app/other.ts'] });
    const store = new Store();
    await sweep(world, store, T0);
    expect(store.row(41)).not.toHaveProperty('revert_pr');
    return { world, store };
  };

  it('a revert of it, merged two days later, rewrites its row with revert_pr set', async () => {
    const { world, store } = await start();
    const at = T0 + 2 * DAY;
    world.pr(50, { opened: at - 50 * MIN, closed: at - 10 * MIN, body: `Reverts ${REPO}#41`, commits: [`Revert "feat"\n\nThis reverts commit ${sha(41)}.`] });
    world.mention(41, 50, at - 50 * MIN);
    const res = await sweep(world, store, at);
    expect(res.failures).toEqual([]);
    expect(store.row(41)).toMatchObject({ revert_pr: 50, revert_days: 2, fate: 'merged', recorded_at: iso(at) });
    expect(store.row(50)).toMatchObject({ fate: 'merged' });
  });

  it("a revert named by its commit alone (git revert, no cross-reference) still finds the item, through the commit's pull request", async () => {
    const { world, store } = await start();
    const at = T0 + 3 * DAY;
    world.pr(51, { opened: at - 50 * MIN, closed: at - 10 * MIN, body: 'undo it', commits: [`Revert\n\nThis reverts commit ${sha(41)}.`] });
    await sweep(world, store, at);
    expect(store.row(41)).toMatchObject({ revert_pr: 51, revert_days: 3 });
  });

  it('a linked fix (a bug issue naming it, a shared code file) rewrites its row with fix_prs', async () => {
    const { world, store } = await start();
    const at = T0 + 5 * DAY;
    world.issue(90, { labels: ['bug'], body: '### Introduced by\n\n#41\n\n### What happened\n\nzebra' });
    world.pr(91, { opened: at - 50 * MIN, closed: at - 10 * MIN, title: 'fix: zebra', closes: [90], files: ['app/zebra.ts'] });
    world.mention(41, 90, at - 2 * DAY);
    const res = await sweep(world, store, at);
    expect(res.failures).toEqual([]);
    expect(store.row(41)).toMatchObject({ fix_prs: '91', first_fix_days: 5 });
  });

  it('a follow-up closed as not planned rewrites its source row with followups_not_planned raised, and keeps the revert found before', async () => {
    const { world, store } = await start();
    world.issue(60, { labels: ['follow-up', 'agent:reviewer', 'sev:low'], body: 'Surfaced by PR #41.' });
    world.mention(41, 60, T0 - 20 * MIN);
    // A revert, written by a sweep two days on.
    const revertAt = T0 + 2 * DAY;
    world.pr(50, { opened: revertAt - 50 * MIN, closed: revertAt - 10 * MIN, body: `Reverts ${REPO}#41` });
    world.mention(41, 50, revertAt - 50 * MIN);
    await sweep(world, store, revertAt);
    expect(store.row(41)).toMatchObject({ followups_filed: 1, followups_open: 1, followups_not_planned: 0, revert_pr: 50 });
    // Then the follow-up is closed as not planned: no PR merges.
    const at = T0 + 4 * DAY;
    world.closeIssue(60, at - 15 * MIN, 'NOT_PLANNED');
    const res = await sweep(world, store, at);
    expect(res.failures).toEqual([]);
    expect(store.row(41)).toMatchObject({ followups_filed: 1, followups_open: 0, followups_not_planned: 1, followups_sev_low: 1, revert_pr: 50, revert_days: 2, recorded_at: iso(at) });
  });

  it('a follow-up closed while its PR is still open sends no row; the PR row, when it closes, counts its fate', async () => {
    const world = new World();
    world.pr(70, { opened: T0 - 2 * DAY });
    world.issue(71, { labels: ['follow-up', 'agent:reviewer', 'sev:medium'], body: 'Surfaced by PR #70.' });
    world.mention(70, 71, T0 - DAY);
    world.closeIssue(71, T0 - 15 * MIN, 'COMPLETED');
    const store = new Store();
    const first = await sweep(world, store, T0);
    expect(first.failures).toEqual([]);
    expect(store.work()).toEqual([]);
    const at = T0 + DAY;
    world.merge(70, at - 10 * MIN);
    await sweep(world, store, at);
    expect(store.row(70)).toMatchObject({ fate: 'merged', followups_filed: 1, followups_completed: 1, followups_open: 0, followups_sev_medium: 1 });
  });

  it('a PR closed unmerged, reopened and merged leaves one row in the #work partition, with fate: merged', async () => {
    const world = new World();
    world.pr(80, { opened: T0 - 2 * 60 * MIN, closed: T0 - 30 * MIN, merged: false });
    const store = new Store();
    await sweep(world, store, T0);
    expect(store.work()).toHaveLength(1);
    expect(store.row(80)).toMatchObject({ fate: 'closed_unmerged', closed_at: iso(T0 - 30 * MIN) });
    // Reopened, then merged three days later.
    const at = T0 + 3 * DAY;
    world.merge(80, at - 10 * MIN);
    await sweep(world, store, at);
    expect(store.work()).toHaveLength(1);
    expect(store.row(80)).toMatchObject({ fate: 'merged', closed_at: iso(at - 10 * MIN) });
  });

  it('an item closed 13 months ago or more is not written again: its row has expired, and the store would refuse it', async () => {
    const world = new World();
    const old = T0 - 400 * DAY;
    world.pr(20, { opened: old - DAY, closed: old });
    world.issue(21, { labels: ['follow-up', 'agent:reviewer'], body: 'Surfaced by PR #20.' });
    world.mention(20, 21, old - DAY);
    world.closeIssue(21, T0 - 15 * MIN, 'NOT_PLANNED');
    const store = new Store();
    const res = await sweep(world, store, T0);
    expect(res.failures).toEqual([]);
    expect(store.rejected).toEqual([]);
    expect(store.work()).toEqual([]);
  });

  it('a PR a follow-up names in passing, with no cross-reference of its own, is not written again', async () => {
    const { world, store } = await start();
    world.pr(30, { opened: T0 - 9 * DAY, closed: T0 - 8 * DAY });
    world.issue(31, { labels: ['follow-up', 'agent:reviewer'], body: 'Like #30, surfaced elsewhere.' });
    const at = T0 + DAY;
    world.closeIssue(31, at - 15 * MIN, 'COMPLETED');
    await sweep(world, store, at);
    expect(store.row(30)).toBeUndefined();
  });

  it('a plain git revert, which never cross-references the item, is kept when a follow-up of the item closes later', async () => {
    const { world, store } = await start();
    world.issue(60, { labels: ['follow-up', 'agent:reviewer', 'sev:low'], body: 'Surfaced by PR #41.' });
    world.mention(41, 60, T0 - 20 * MIN);
    // `git revert` of the squash commit `feat: zebra-title-41 (#41)`, in a PR that names only the
    // SHA. Its commit's `#41` is GitHub's one record of it on the item: a referenced event.
    const revertAt = T0 + 3 * DAY;
    world.pr(51, { opened: revertAt - 50 * MIN, closed: revertAt - 10 * MIN, body: `Reverts ${sha(41).slice(0, 7)}`, commits: [`Revert "feat: zebra-title-41 (#41)"\n\nThis reverts commit ${sha(41)}.`] });
    world.reference(41, 51);
    await sweep(world, store, revertAt);
    expect(store.row(41)).toMatchObject({ revert_pr: 51, revert_days: 3 });
    // A day on, the follow-up is closed as not planned, and the row is written again.
    const at = T0 + 4 * DAY;
    world.closeIssue(60, at - 15 * MIN, 'NOT_PLANNED');
    const res = await sweep(world, store, at);
    expect(res.failures).toEqual([]);
    expect(store.row(41)).toMatchObject({ followups_not_planned: 1, revert_pr: 51, revert_days: 3, recorded_at: iso(at) });
  });

  it('a linked fix named by a bare "Introduced by" number, which GitHub never links, is kept when a revert rewrites the item later', async () => {
    const { world, store } = await start();
    const fixAt = T0 + 5 * DAY;
    world.issue(90, { labels: ['bug'], body: '### Introduced by\n\n41\n\n### What happened\n\nzebra' });
    world.pr(91, { opened: fixAt - 50 * MIN, closed: fixAt - 10 * MIN, title: 'fix: zebra', closes: [90], files: ['app/zebra.ts'] });
    world.closeIssue(90, fixAt - 10 * MIN, 'COMPLETED');
    await sweep(world, store, fixAt);
    expect(store.row(41)).toMatchObject({ fix_prs: '91', first_fix_days: 5 });
    // Two days on, a revert of #41 merges, and the row is written again.
    const at = T0 + 7 * DAY;
    world.pr(50, { opened: at - 50 * MIN, closed: at - 10 * MIN, body: `Reverts ${REPO}#41` });
    world.mention(41, 50, at - 50 * MIN);
    const res = await sweep(world, store, at);
    expect(res.failures).toEqual([]);
    expect(store.row(41)).toMatchObject({ revert_pr: 50, revert_days: 7, fix_prs: '91', first_fix_days: 5, recorded_at: iso(at) });
  });

  it('reads, per earlier item, its referencing commits once and only the PRs whose commit reverts it, and the bug issues once a sweep', async () => {
    const { world, store } = await start();
    const named = (args: string[], query: string, n?: number) => args.join(' ').includes(query) && (n === undefined || args.includes(`number=${n}`));
    const count = (query: string, n?: number) => world.calls.filter((a) => named(a, query, n)).length;
    // A sweep with no earlier item reads neither.
    expect(count('WorkItemReferences') + count('labels=bug')).toBe(0);
    world.issue(60, { labels: ['follow-up', 'agent:reviewer'], body: 'Surfaced by PR #41.' });
    world.mention(41, 60, T0 - 20 * MIN);
    // A commit that names #41 without reverting it, and a bug issue introduced by another PR.
    world.pr(45, { opened: T0 + DAY - 50 * MIN, closed: T0 + DAY - 10 * MIN, commits: ['refactor: zebra, after #41'] });
    world.reference(41, 45);
    world.issue(92, { labels: ['bug'], body: '### Introduced by\n\n30', updated: T0 + DAY });
    const at = T0 + 4 * DAY;
    world.closeIssue(60, at - 15 * MIN, 'NOT_PLANNED');
    world.calls = [];
    const res = await sweep(world, store, at);
    expect(res.failures).toEqual([]);
    expect(store.row(41)).toMatchObject({ followups_not_planned: 1 });
    expect(count('WorkItemReferences', 41)).toBe(1);
    expect(count('labels=bug')).toBe(1);
    expect(count('WorkItemOne', 45)).toBe(0);
    expect(count('WorkItemClosers', 92)).toBe(0);
  });

  it("turns the sweep red, naming the PR, when an earlier item can't be read", async () => {
    const { world, store } = await start();
    const at = T0 + DAY;
    world.pr(52, { opened: at - 50 * MIN, closed: at - 10 * MIN, body: `Reverts ${REPO}#41` });
    const gh = world.gh;
    world.gh = async (args: string[]) => (args.join(' ').includes('WorkItemOne') ? { status: 1, stdout: '', stderr: 'gh: Something went wrong (HTTP 500)' } : gh(args));
    const res = await sweep(world, store, at);
    expect(res.failures).toEqual([expect.stringMatching(/^work items: an earlier item or its later pull requests could not be read/)]);
  });
});

describe('what the step reads a candidate from', () => {
  it("finds this repository's numbers in a text, never another's", () => {
    expect(mentionsOf(`Surfaced by PR #41, see ${REPO}#7 and https://github.com/${REPO}/pull/9; not other/place#11, &#12; or a#13`, REPO)).toEqual([7, 9, 41]);
    expect(mentionsOf(null, REPO)).toEqual([]);
  });

  it("reads every page of a PR's referencing commits, with only this repository's PRs, and skips a commit GitHub hides", async () => {
    const commit = (message: string, ...prs: [number, string][]) => ({ commit: { message, associatedPullRequests: { nodes: prs.map(([number, nameWithOwner]) => ({ number, repository: { nameWithOwner } })) } } });
    const pages: Record<string, Node> = {
      first: { pageInfo: { hasNextPage: true, endCursor: 'p2' }, nodes: [commit('one', [51, REPO], [7, 'other/place']), { commit: null }] },
      p2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [commit('two', [52, REPO.toUpperCase()])] },
    };
    const gh = async (args: string[]) => {
      const after = args.find((a) => a.startsWith('after='))?.slice('after='.length) ?? 'first';
      return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { timelineItems: pages[after] } }, rateLimit: { remaining: 4000 } } }), stderr: '' };
    };
    expect(await referencingCommits({ gh, sleep: async () => {}, progress: () => {} }, REPO, 41)).toEqual([{ message: 'one', prs: [51] }, { message: 'two', prs: [52] }]);
  });

  it("reads the caller's pin of the collector, and nothing else", () => {
    expect(pinOf(CALLER('1.2.3'))).toBe('1.2.3');
    expect(pinOf('    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@main\n')).toBeUndefined();
    expect(pinOf(null)).toBeUndefined();
  });
});

describe("a PR's Reviewer follow-ups, from its own timeline (followupsOf)", () => {
  const xref = (number: number, o: Node = {}) => ({ event: 'cross-referenced', created_at: iso(T0), source: { type: 'issue', number, repository: REPO, labels: ['follow-up', 'agent:reviewer'], state: 'open', ...o } });
  const pr = (timeline?: Node[]) => ({ number: 1, state: 'closed', created_at: iso(T0), closed_at: iso(T0), merged_at: null, author: null, labels: [], timeline }) as never;

  it('counts an issue of this repository with both labels, once, at its state now', () => {
    expect(followupsOf(pr([xref(5), xref(5), xref(6, { state: 'closed', state_reason: 'not_planned' })]), REPO)).toEqual([
      { labels: ['follow-up', 'agent:reviewer'], state: 'open', state_reason: null },
      { labels: ['follow-up', 'agent:reviewer'], state: 'closed', state_reason: 'not_planned' },
    ]);
  });

  it("counts neither an issue with one of the labels, another repository's, nor a PR", () => {
    expect(followupsOf(pr([xref(5, { labels: ['follow-up'] }), xref(6, { repository: 'other/place' }), xref(7, { type: 'pull_request' })]), REPO)).toEqual([]);
  });

  it('is unknown, not zero, when the timeline or a source issue was not read whole', () => {
    expect(followupsOf(pr(undefined), REPO)).toBeUndefined();
    expect(followupsOf(pr([xref(5), xref(6, { labels: undefined })]), REPO)).toBeUndefined();
    expect(followupsOf(pr([xref(6, { state: undefined })]), REPO)).toBeUndefined();
  });
});

describe("the reader reads a cross-referencing issue's labels and state, or leaves them unknown", () => {
  const empty = { nodes: [] };
  const node = (labels: Node) => ({
    number: 1, state: 'MERGED', createdAt: iso(T0), closedAt: iso(T0), mergedAt: iso(T0), author: null, mergedBy: null,
    labels: empty, files: empty, commits: empty, reviews: empty, closingIssuesReferences: empty,
    timelineItems: { nodes: [{ __typename: 'CrossReferencedEvent', createdAt: iso(T0), actor: null, source: {
      __typename: 'Issue', number: 5, repository: { nameWithOwner: REPO }, state: 'CLOSED', stateReason: 'NOT_PLANNED', labels,
    } }] },
  });
  it('reads them whole', () => {
    const pr = toPullRequest(node({ totalCount: 2, nodes: [{ name: 'follow-up' }, { name: 'agent:reviewer' }] }));
    expect(pr.timeline?.[0]?.source).toEqual({ type: 'issue', number: 5, repository: REPO, labels: ['follow-up', 'agent:reviewer'], state: 'closed', state_reason: 'not_planned' });
  });
  it('leaves labels cut short by the page out, so the follow-ups are unknown, never miscounted', () => {
    const many = Array.from({ length: SOURCE_LABELS }, (_, i) => ({ name: `l${i}` }));
    const pr = toPullRequest(node({ totalCount: SOURCE_LABELS + 1, nodes: many }));
    expect(pr.timeline?.[0]?.source).not.toHaveProperty('labels');
    expect(followupsOf(pr, REPO)).toBeUndefined();
  });
});

describe('no work-item field accepts a login (ADR 0007, K-OBS-16)', () => {
  const row = workItemRow({
    pr: { number: 41, state: 'closed', created_at: iso(T0 - DAY), closed_at: iso(T0), merged_at: iso(T0), author: null, labels: [] },
    declarations: { register: new Map() }, tag: 'test', recorded_at: iso(T0),
  } as never);
  // Logins as GitHub issues them: people, Apps, and GitHub's own accounts. A login that is also an
  // enum word (`human`, `dev`) is the one shape no closed list can refuse; every one here has a
  // digit or a `[bot]` suffix, as most do, and none is a word any list holds.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const random = Array.from({ length: 40 }, () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-';
    const n = 4 + Math.floor(rand() * 16);
    let s = String.fromCharCode(97 + Math.floor(rand() * 26));
    for (let i = 1; i < n; i++) s += chars[Math.floor(rand() * chars.length)];
    return `${s.replace(/-+$/, '')}${Math.floor(rand() * 10)}`;
  });
  const LOGINS = ['octocat1', 'acme-author[bot]', 'dependabot[bot]', 'web-flow', 'github-actions[bot]', 'renovate[bot]', 'zebra-42', ...random];

  it('a valid row first', () => {
    expect(validate(row)).toEqual({ ok: true });
  });

  it('a login in any field fails validate, naming the field', () => {
    const fields = Object.keys(SCHEMAS.work_item![1]!).filter((f) => !['schema_version', 'row_kind'].includes(f));
    const accepted: string[] = [];
    for (const field of fields) {
      for (const login of LOGINS) {
        const v = validate({ ...row, [field]: login });
        if (v.ok || !v.errors.some((e) => e.field === field)) accepted.push(`${field}=${login}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('a login under a field of its own fails validate as an unknown field', () => {
    for (const field of ['login', 'author', 'author_login', 'merged_by_login', 'reviewer', 'repository', 'title', 'body']) {
      const v = validate({ ...row, [field]: 'octocat1' });
      expect(v.ok, field).toBe(false);
      expect(!v.ok && v.errors).toEqual([{ field, problem: 'unknown' }]);
    }
  });
});
