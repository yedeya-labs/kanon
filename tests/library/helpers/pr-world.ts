/**
 * One pull request's world on GitHub, as two readers see it (project #1327, Issue C): `gh`, which
 * the merge gate's `readPr` shells out to, and the status core's injected reader, which asks the
 * REST and GraphQL APIs. Both are built from the same fixture, so a test can hold the shape the
 * readiness view builds to the shape `readPr` builds for the same pull request (`[STAT-7]`).
 *
 * The `gh` side prints what `gh` prints: `gh pr view --json` projects a bot author as
 * `app/<slug>`, a status context as `{ context, state, startedAt, targetUrl }`, and a check run
 * still running with an empty conclusion and Go's zero time (measured on this repository's own
 * pull requests, `gh pr view --json author,statusCheckRollup`). Every `--jq` filter `readPr` passes
 * is applied here by hand, by the argument it is.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStub } from '../../unit/helpers/stub-bin.js';
import { ADOPTER } from './adopter.js';
import { connection, fakeReader, type FakeWorld } from './fake-reader.js';
import { adopterFiles } from './status-world.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const { headerLine, IMPLEMENTER_STATUS } = await import('../../../scripts/lib/role-marker.mjs');
const { trailerFor } = await import('../../../scripts/review-trailer.mjs');

export const REPO = 'acme/shop';
export const NUMBER = 42;
export const HEAD = 'ee4530d1'.padEnd(40, '1');
export const OLD = 'aaaaaaa2'.padEnd(40, '2');
export const READ_AT = Date.parse('2026-10-25T12:00:00Z');

/** A check run, or a commit status, on the head, as GraphQL's `statusCheckRollup` has it. */
export type Check =
  | { kind: 'CheckRun'; name: string; workflow?: string | null; status?: string; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; detailsUrl?: string | null }
  | { kind: 'StatusContext'; context: string; state: string; createdAt: string };

export interface PrWorld {
  number: number;
  title: string;
  body: string;
  author: { type: 'Bot' | 'User'; login: string };
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  head: string;
  mergeable: string;
  mergeStateStatus: string;
  labels: string[];
  /** the issues it closes, with their bodies */
  closes: Array<{ number: number; body: string; repo?: string }>;
  commits: Array<{ headline: string; body: string }>;
  checks: Check[];
  /** the changed files, as the REST files listing has them */
  files: Array<{ filename: string; status?: string; patch?: string | null; changes?: number }>;
  /** files at the head commit, path → text */
  headFiles: Record<string, string>;
  /** REST reviews, oldest first */
  reviews: Array<{ id: number; state: string; login: string; body: string; commit: string }>;
  /** the failed workflow runs on the head */
  failedRuns: Array<{ name: string; conclusion: string }>;
  /** every workflow run on the head, as the REST listing has them: read only when GitHub refuses the token the check rollup */
  headRuns?: Array<{ id: number; name: string; status: string; conclusion: string | null; event?: string; run_started_at?: string; updated_at?: string }>;
  /** GitHub refuses this token the check rollup, as it refuses a fine-grained personal access token */
  checksRefused?: boolean;
  /** the head's commit statuses, newest first */
  statuses: Array<{ context: string; state: string; creator: string }>;
  /** issue comments, oldest first */
  comments: Array<{ login: string; body: string; at: string }>;
  /** issue events, oldest first */
  events: Array<{ event: string; label?: string; actor: string }>;
  queue: { enabled: boolean; queued: boolean; removed: { reason: string | null; at: string } | null };
  /** the default branch's files; the fixture adopter's declarations unless given */
  defaultFiles: Record<string, string>;
}

/** The fixture adopter's declarations on its default branch, its escalation and exemptions files among them. */
export const DEFAULT_FILES = () => adopterFiles(ADOPTER, Object.fromEntries(
  ['docs/qa/escalation-paths.md', 'docs/qa/exemptions.md'].map((f) => [f, readFileSync(join(ADOPTER, f), 'utf8')]),
));

export const IMPLEMENTER_HEADER = headerLine('Implementer');
export const REVIEWER_HEADER = headerLine('Reviewer');
export const MERGER_HEADER = headerLine('Merger');
export const LEAD_HEADER = headerLine('Lead');

/** An approval by the Reviewer, stamped with the commit it read. */
export const approval = (id: number, commit = HEAD, state = 'APPROVED') => ({
  id, state, login: 'example-reviewer[bot]', body: `${REVIEWER_HEADER}\n\nLooks right.\n\n${trailerFor({ sha: commit, runId: 900 + id })}`, commit,
});

/** A check run of Actions, by job. */
export const ci = (name: string, conclusion: string | null = 'SUCCESS', over: Partial<Extract<Check, { kind: 'CheckRun' }>> = {}): Check => ({
  kind: 'CheckRun', name, workflow: 'CI', status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED', conclusion,
  startedAt: '2026-10-25T10:00:00Z', completedAt: conclusion === null ? null : '2026-10-25T10:05:00Z',
  detailsUrl: `https://github.com/${REPO}/actions/runs/700/job/${700 + name.length}`, ...over,
});

/** The Implementer's pull request: approved on its head, green, closing #12, which cites two criteria. */
export function implementerPr(over: Partial<PrWorld> = {}): PrWorld {
  return {
    number: NUMBER,
    title: 'feat: place an order once',
    body: `${IMPLEMENTER_HEADER}\n\nCloses #12.`,
    author: { type: 'Bot', login: 'example-implementer' },
    state: 'OPEN',
    isDraft: false,
    head: HEAD,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: ['agent:implement', 'enhancement'],
    closes: [{ number: 12, body: 'Acceptance criteria:\n\n- `[STORE-2]` — once, however many presses.\n- `[STORE-99]` — not an invariant.\n\nAs `[STORE-1]` already shows.' }],
    commits: [{ headline: 'feat: place an order once', body: 'Closes #12.' }],
    checks: [ci('test'), { kind: 'StatusContext', context: IMPLEMENTER_STATUS, state: 'SUCCESS', createdAt: '2026-10-25T10:06:00Z' }],
    files: [{ filename: 'src/order.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', changes: 2 }],
    headFiles: {},
    reviews: [approval(1)],
    failedRuns: [],
    statuses: [{ context: IMPLEMENTER_STATUS, state: 'success', creator: 'example-implementer[bot]' }],
    comments: [],
    events: [],
    queue: { enabled: false, queued: false, removed: null },
    defaultFiles: DEFAULT_FILES(),
    ...over,
  };
}

/** A person's pull request, with no Implementer marker or status on it. */
export function personPr(over: Partial<PrWorld> = {}): PrWorld {
  return implementerPr({
    title: 'docs: say how to order',
    body: 'Closes #12.',
    author: { type: 'User', login: 'octo' },
    labels: ['documentation'],
    statuses: [],
    checks: [ci('test')],
    ...over,
  });
}

/** A brief with one decision, `headline` as given. */
export const briefText = (headline: string) => [
  '# Project 9', '', '## 1. The real problem', '', 'Prose.', '', '## 3. Decomposition', '', '### Issue A — Do it', '',
  '## 7. Decisions', '', `1. **${headline}** Why it matters.`, '', '2. **Which colour? ✅ ANSWERED: blue.**', '',
  '## 8. What I did not examine', '', 'Nothing.', '',
].join('\n');

/** The Lead's brief pull request for project 9. */
export function briefPr(headline: string, over: Partial<PrWorld> = {}, path = 'docs/projects/9.md'): PrWorld {
  return implementerPr({
    title: 'docs(projects): brief for #9',
    body: `${LEAD_HEADER}\n\nThe brief for #9.`,
    author: { type: 'Bot', login: 'example-lead' },
    labels: ['lead:brief'],
    closes: [],
    statuses: [],
    checks: [ci('test')],
    files: [{ filename: path, status: 'added', patch: '@@ +1 @@', changes: 20 }],
    headFiles: { [path]: briefText(headline) },
    ...over,
  });
}

// ── The `gh` side, as `readPr` reads it ─────────────────────────────────────────────────────────

const ZERO_TIME = '0001-01-01T00:00:00Z';

/** `gh pr view --json`'s projection of the pull request. */
function ghMeta(w: PrWorld) {
  return {
    number: w.number,
    author: w.author.type === 'Bot' ? { is_bot: true, login: `app/${w.author.login}` } : { is_bot: false, login: w.author.login, name: '' },
    state: w.state,
    isDraft: w.isDraft,
    labels: w.labels.map((name) => ({ name })),
    headRefOid: w.head,
    statusCheckRollup: w.checks.map((c) => (c.kind === 'StatusContext'
      ? { __typename: 'StatusContext', context: c.context, startedAt: c.createdAt, state: c.state, targetUrl: '' }
      : {
        __typename: 'CheckRun', completedAt: c.completedAt ?? ZERO_TIME, conclusion: c.conclusion ?? '', detailsUrl: c.detailsUrl ?? '',
        name: c.name, startedAt: c.startedAt ?? ZERO_TIME, status: c.status ?? 'COMPLETED', workflowName: c.workflow ?? '',
      })),
    title: w.title,
    body: w.body,
    closingIssuesReferences: w.closes.map((i) => ({ number: i.number })),
    commits: w.commits.map((c) => ({ messageHeadline: c.headline, messageBody: c.body })),
    mergeable: w.mergeable,
    mergeStateStatus: w.mergeStateStatus,
  };
}

/** The stub `gh`: answers each call `readPr` makes, from the world in `world.json` beside it. */
const GH = String.raw`
import { readFileSync } from 'node:fs';
const w = JSON.parse(readFileSync(new URL('./world.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const all = args.join(' ');
const jq = args.includes('--jq') ? args[args.indexOf('--jq') + 1] : null;
const out = (s) => process.stdout.write(s);
const json = (v) => out(JSON.stringify(v));
const lines = (vs) => out(vs.map((v) => v + '\n').join(''));
// The rebase lane's read, COMMENTS_JQ: each body with its author, a bot's as GraphQL spells it.
if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) json(w.comments.map((c) => ({ login: c.login.replace(/\[bot\]$/, ''), body: c.body })));
else if (args[0] === 'pr' && args[1] === 'view') json(w.meta);
else if (args[0] === 'run' && args[1] === 'list') json(w.failedRuns);
else if (args[0] === 'api' && args[1] === 'graphql') json(w.queueNode);
else if (all.includes('/pulls/' + w.number + '/files') && jq === '.[].filename') lines(w.files.map((f) => f.filename));
else if (all.includes('/pulls/' + w.number + '/files')) lines(w.files.map((f) => JSON.stringify([f.filename, f.patch ?? null, f.changes ?? 0])));
else if (all.includes('/pulls/' + w.number + '/reviews')) json(w.reviewsRest);
else if (all.includes('/statuses')) json(w.statuses.map((s) => ({ context: s.context, state: s.state, creator: { login: s.creator } })));
else if (all.includes('/issues?per_page=1')) out('1\n');
else if (all.includes('/issues/' + w.number + '/events')) lines(w.events.filter((e) => e.event === 'labeled' && e.label === 'needs:human').map((e) => e.actor));
else if (all.includes('/issues/' + w.number + '/comments') && jq.includes('at:')) lines(w.comments.map((c) => JSON.stringify({ login: c.login, body: c.body, at: c.at })));
else if (all.includes('/issues/' + w.number + '/comments')) lines(w.comments.map((c) => JSON.stringify({ login: c.login, body: c.body })));
else { process.stderr.write('unrouted gh ' + all + '\n'); process.exit(1); }
`;

/** `readPr`'s options for this world: a stub `gh` first on PATH. */
export function ghFor(w: PrWorld) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-world-'));
  const last = w.queue.removed ? [{ createdAt: w.queue.removed.at, reason: w.queue.removed.reason }] : [];
  writeFileSync(join(dir, 'world.json'), JSON.stringify({
    ...w,
    meta: ghMeta(w),
    reviewsRest: restReviews(w),
    queueNode: { id: `PR_${w.number}`, isMergeQueueEnabled: w.queue.enabled, isInMergeQueue: w.queue.queued, timelineItems: { nodes: last } },
  }));
  writeFileSync(join(dir, 'gh.mjs'), GH);
  writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(dir, 'gh.mjs')}" "$@"\n`);
  return { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
}

const restReviews = (w: PrWorld) => w.reviews.map((r) => ({ id: r.id, state: r.state, user: { login: r.login }, body: r.body, commit_id: r.commit }));

// ── The API side, as the status core's reader reads it ──────────────────────────────────────────

/** The pull request, as the readiness view's GraphQL query asks for it. */
function graphqlPr(w: PrWorld) {
  return {
    id: `PR_${w.number}`,
    number: w.number,
    title: w.title,
    url: `https://github.com/${REPO}/pull/${w.number}`,
    body: w.body,
    state: w.state,
    isDraft: w.isDraft,
    headRefOid: w.head,
    mergeable: w.mergeable,
    mergeStateStatus: w.mergeStateStatus,
    isMergeQueueEnabled: w.queue.enabled,
    isInMergeQueue: w.queue.queued,
    author: { __typename: w.author.type, login: w.author.login },
    labels: connection(w.labels.map((name) => ({ name }))),
    closingIssuesReferences: connection(w.closes.map((i) => ({ number: i.number, body: i.body, repository: { nameWithOwner: i.repo ?? REPO } }))),
    commits: connection(w.commits.map((c) => ({ commit: { messageHeadline: c.headline, messageBody: c.body } }))),
    head: {
      nodes: [{
        commit: {
          statusCheckRollup: w.checks.length ? {
            contexts: connection(w.checks.map((c) => (c.kind === 'StatusContext'
              ? { __typename: 'StatusContext', context: c.context, state: c.state, createdAt: c.createdAt }
              : {
                __typename: 'CheckRun', name: c.name, status: c.status ?? 'COMPLETED', conclusion: c.conclusion ?? null, startedAt: c.startedAt ?? null,
                completedAt: c.completedAt ?? null, detailsUrl: c.detailsUrl ?? null, checkSuite: { workflowRun: c.workflow ? { workflow: { name: c.workflow } } : null },
              }))),
          } : null,
        },
      }],
    },
    timelineItems: { nodes: w.queue.removed ? [{ createdAt: w.queue.removed.at, reason: w.queue.removed.reason }] : [] },
  };
}

/** A recording reader over the world: the default branch's declarations, and the pull request. */
export function readerFor(w: PrWorld, overrides: Partial<FakeWorld> = {}) {
  const queries: string[] = [];
  const base = `repos/${REPO}`;
  const world: FakeWorld = {
    files: w.defaultFiles,
    ...overrides,
    get: (path) => {
      const own = overrides.get?.(path);
      if (own !== undefined) return own;
      const atHead = new RegExp(`^${base}/contents/(.+)\\?ref=${w.head}$`).exec(path);
      if (atHead) {
        const text = w.headFiles[decodeURIComponent(atHead[1]!)];
        if (text === undefined) throw Object.assign(new Error('HTTP 404'), { status: 404 });
        return { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), sha: 'blob' };
      }
      if (path === `${base}/issues?per_page=1`) return [{ number: 1 }];
      const dir = new RegExp(`^${base}/contents/(.+)\\?ref=main$`).exec(path);
      if (dir && !(decodeURIComponent(dir[1]!) in w.defaultFiles)) {
        const prefix = `${decodeURIComponent(dir[1]!)}/`;
        const inside = Object.keys(w.defaultFiles).filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'));
        if (inside.length) return inside.map((f) => ({ name: f.slice(prefix.length), path: f, type: 'file' }));
      }
      return undefined;
    },
    pages: (path) => {
      const own = overrides.pages?.(path);
      if (own !== undefined) return own;
      if (path === `${base}/pulls/${w.number}/files?per_page=100`) return [w.files.map((f) => ({ status: 'modified', changes: 0, ...f }))];
      if (path === `${base}/pulls/${w.number}/reviews?per_page=100`) return [restReviews(w)];
      if (path === `${base}/commits/${w.head}/statuses?per_page=100`) return [w.statuses.map((s) => ({ context: s.context, state: s.state, creator: { login: s.creator } }))];
      if (path === `${base}/actions/runs?head_sha=${w.head}&status=failure&per_page=100`) return [{ total_count: w.failedRuns.length, workflow_runs: w.failedRuns }];
      if (path === `${base}/actions/runs?head_sha=${w.head}&per_page=100`) return [{ total_count: (w.headRuns ?? []).length, workflow_runs: w.headRuns ?? [] }];
      if (path === `${base}/issues/${w.number}/comments?per_page=100`) return [w.comments.map((c, k) => ({ user: { login: c.login }, body: c.body, created_at: c.at, html_url: `https://github.com/${REPO}/pull/${w.number}#issuecomment-${k + 1}` }))];
      if (path === `${base}/issues/${w.number}/events?per_page=100`) return [w.events.map((e) => ({ event: e.event, label: e.label ? { name: e.label } : undefined, actor: { login: e.actor } }))];
      return undefined;
    },
    graphql: {
      PullRequestGate: (v: Any) => {
        if (Number(v.number) !== w.number) throw Object.assign(new Error(`Could not resolve to a PullRequest with the number of ${v.number}.`), { status: 404 });
        // GitHub's answer when the query asks for check runs the token may not read.
        if (w.checksRefused) throw new Error('Resource not accessible by personal access token');
        return { repository: { pullRequest: graphqlPr(w) } };
      },
      PullRequestGateNoChecks: (v: Any) => {
        if (Number(v.number) !== w.number) throw Object.assign(new Error(`Could not resolve to a PullRequest with the number of ${v.number}.`), { status: 404 });
        const rest: Record<string, unknown> = { ...graphqlPr(w) };
        delete rest.head;
        return { repository: { pullRequest: rest } };
      },
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
  return { reader, repo: REPO, seen, queries };
}
