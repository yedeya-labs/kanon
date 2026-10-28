// THE NEEDS-THE-OWNER VIEW (project #1327, Issue F): what in a repository waits on a person now,
// each with its link and its reason, read live, and nothing written anywhere.
//
// A CLOSED LIST, AND EVERY ENTRY ANOTHER DECIDER'S ANSWER (`[STAT-10]`). The view lists six
// things and nothing else, and judges none of them itself:
//   - the pull requests ready for a person's merge: the readiness view's answer for each open
//     pull request (`readinessOf`), both the Implementer's the merge gate escalates for a path
//     alone and those it skips as not the Implementer's (`[STAT-7]`, `[STAT-14]`, decision 13);
//   - the Implementer's stops that wait on a person: `qa:needs-info` and `qa:needs-split` on an
//     open issue, and, for an issue in one of the dispatch sweep's lanes, the sweep's own
//     `classify` over the same conversation, open pull requests and live runs: its
//     `awaiting-human` state, or a scope-first bail (`BAIL_RE`, as the project digest names one)
//     as the Implementer's last word with nobody's answer after it;
//   - the Lead's holds: `needs:human` on an issue with the hold marker in the Lead's own comment,
//     as the reconciler counts it (`leadComments`, kanon#1399);
//   - each open decision in an open brief pull request, as the readiness view reads it with the
//     brief guard's `openDecisions`;
//   - each open issue or pull request labelled `decision:needed`, with the link of the decision
//     asked on it, as `askState` reads its comments (`K-WORK-24`);
//   - the lanes the lane-health view reports `red`.
//
// THE INBOX IS TWO OF THEM (`[STAT-16]`). `inboxView` answers "what waits on me?" with the two
// lists a person acts on from one place, the pull requests ready for their merge and the
// decisions asked of them, computed the same way and read nowhere else. It is pull-only: it is
// read when asked, and nothing it reads is ever sent anywhere.
//
// A COMMENT'S BODY NEVER LEAVES THE PROCESS (decision 4). It is read to find a bail or a hold
// marker, and the answer carries only the fact and its link: numbers, titles and links, never a
// comment or an issue body.
//
// WHAT IT CAN'T READ, IT SAYS SO. The sweep also reads the telemetry store's cost rows, which mark
// an issue whose last run hit its cap or left nothing. A status read has no store, so an issue the
// sweep would call `too-big` or `ran-empty` reads here as its conversation reads, which
// docs/status.md says. INCOMPLETE IS AN ERROR (`[STAT-3]`), as in every view.

import { leadComments, HELD, HELD_MARKER, NEEDS_INFO, issueComments } from '../lead-reconcile.mjs';
import { LANES, classify as classifyLane, commentRows, linkedPrIndex, liveRunsByIssue, LIVE_RUN_STATUSES, norm, registerBotLogins } from '../dispatch-sweep.mjs';
import { asRole } from '../lib/role-marker.mjs';
import { BAIL_RE } from '../project-digest.mjs';
import { DECISION_LABEL, askState } from '../lib/decision-asks.mjs';
import { SPLIT_LABEL } from '../split-lineage.mjs';
import { laneHealthView } from './lanes.mjs';
import { IncompleteRead } from './project.mjs';
import { listing, readinessContext, readinessOf } from './pull-request.mjs';
import { ReadError, allNodes, graphqlRead, ownerAndName, requireComplete, watched } from './reader.mjs';

/** The labels a stop is read from, each its own reason. */
const STOP_LABELS = [NEEDS_INFO, SPLIT_LABEL];

/** The sweep's states in which the Implementer's word is the last one and nobody is running. */
const SPOKE_LAST = new Set(['in-flight', 'awaiting-human']);

const Q_OPEN_PRS = `query OpenPullRequests($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      totalCount
      nodes {
        number title url headRefName
        labels(first: 100) { totalCount nodes { name } }
        closingIssuesReferences(first: 100) { totalCount nodes { number repository { nameWithOwner } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const Q_ISSUES = `query OwnerIssues($owner: String!, $name: String!, $labels: [String!], $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, labels: $labels, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      totalCount
      nodes { number title url labels(first: 100) { totalCount nodes { name } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * @typedef {'qa:needs-info' | 'qa:needs-split' | 'scope-first-bail' | 'awaiting-human'} StopReason
 * @typedef {object} NeedsOwner
 * @property {string} branch the default branch the declarations were read from
 * @property {Array<{ number: number, title: string, url: string, rule: string, reason: string }>} merges
 * @property {Array<{ number: number, title: string, url: string, reasons: StopReason[] }>} stops
 * @property {Array<{ number: number, title: string, url: string }>} holds
 * @property {Array<{ number: number, title: string, url: string, brief: string, n: number, headline: string, marker: string }>} decisions
 * @property {Ask[]} asks
 * @property {Array<{ file: string, url: string, failed: number, decisive: number }>} lanes
 * @typedef {{ number: number, title: string, url: string, kind: 'issue' | 'pr', ask: string | null, form: 'ok' | 'incomplete' | 'missing', answered: boolean }} Ask
 * @typedef {{ branch: string, merges: NeedsOwner['merges'], asks: Ask[] }} Inbox
 */

/**
 * The needs-the-Owner view of one repository. Reads only through `reader`; writes nothing.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now?: number }} args
 * @returns {Promise<NeedsOwner>}
 */
export async function needsOwnerView({ reader, repo, now = Date.now() }) {
  return whole('the needs-the-Owner view', reader, (r) => view({ reader: r, repo, now }));
}

/**
 * The inbox of one repository (`[STAT-16]`): the pull requests ready for a person's merge and the
 * decisions asked of a person, each list as the needs-the-Owner view gives it. Reads only through
 * `reader`; writes nothing.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now?: number }} args
 * @returns {Promise<Inbox>}
 */
export async function inboxView({ reader, repo, now = Date.now() }) {
  return whole('the inbox', reader, async (r) => {
    const context = await readinessContext(r, repo);
    const prs = await allNodes(r, Q_OPEN_PRS, ownerAndName(repo), (d) => d?.repository?.pullRequests);
    const { merges } = await readinessOfEach(prs, { reader: r, repo, now, context });
    const issues = await openIssues(r, repo, [DECISION_LABEL]);
    return { branch: context.files.branch, merges, asks: await asksOf(r, repo, issues, prs) };
  });
}

/**
 * A view's answer, read through a watched reader, or the error naming every read that failed
 * (`[STAT-3]`), even one a caller inside tolerated.
 * @template T
 * @param {string} what @param {import('./reader.mjs').Reader} given
 * @param {(reader: import('./reader.mjs').Reader) => Promise<T>} read
 * @returns {Promise<T>}
 */
async function whole(what, given, read) {
  const { reader, failures } = watched(given);
  try {
    const answer = await read(reader);
    const failed = failures();
    if (failed.length) throw new IncompleteRead(what, failed);
    return answer;
  } catch (e) {
    if (e instanceof IncompleteRead && e.message.startsWith(what)) throw e;
    const failed = failures();
    if (e instanceof ReadError && !failed.includes(e) && !e.expected) failed.push(e);
    if (failed.length) throw new IncompleteRead(what, failed);
    throw e;
  }
}

/**
 * Each open pull request, as the readiness view answers for it: those ready for a person's merge,
 * and each open decision in a brief.
 * @param {any[]} prs
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now: number, context: Awaited<ReturnType<typeof readinessContext>> }} io
 */
async function readinessOfEach(prs, { reader, repo, now, context }) {
  /** @type {NeedsOwner['merges']} */
  const merges = [];
  /** @type {NeedsOwner['decisions']} */
  const decisions = [];
  for (const p of prs) {
    const r = await readinessOf(Number(p.number), { reader, repo, now, context });
    if (r.readiness.by === 'person' && r.readiness.ready) merges.push({ number: r.number, title: r.title, url: r.url, rule: r.verdict.rule, reason: r.readiness.why });
    for (const d of r.decisions ?? []) decisions.push({ number: r.number, title: r.title, url: r.url, brief: d.brief, n: d.n, headline: d.headline, marker: d.marker });
  }
  return { merges, decisions };
}

/**
 * The open issues carrying any of `labels`, each with all its label names.
 * @param {import('./reader.mjs').Reader} reader @param {string} repo @param {string[]} labels
 */
async function openIssues(reader, repo, labels) {
  return (await allNodes(reader, Q_ISSUES, { ...ownerAndName(repo), labels }, (d) => d?.repository?.issues))
    .map((i) => ({ number: Number(i.number), title: String(i.title ?? ''), url: String(i.url ?? ''), labels: namesOf(i, reader, graphqlRead(Q_ISSUES)) }));
}

/**
 * The decisions asked of a person (`K-WORK-24`): each open issue and open pull request labelled
 * `decision:needed`, with the link of the latest ask on it, whether that ask has the fixed form,
 * and whether an answer was recorded after it with the label left on. A comment is read only for
 * its marker and its parts; its text never leaves (decision 4).
 * @param {import('./reader.mjs').Reader} reader @param {string} repo
 * @param {Array<{ number: number, title: string, url: string, labels: string[] }>} issues
 * @param {any[]} prs the open pull requests, as `Q_OPEN_PRS` reads them
 * @returns {Promise<Ask[]>}
 */
async function asksOf(reader, repo, issues, prs) {
  const threads = [
    ...issues.filter((i) => i.labels.includes(DECISION_LABEL)).map((i) => ({ ...i, kind: /** @type {const} */ ('issue') })),
    ...prs.map((p) => ({ number: Number(p.number), title: String(p.title ?? ''), url: String(p.url ?? ''), labels: namesOf(p, reader, `${graphqlRead(Q_OPEN_PRS)}`), kind: /** @type {const} */ ('pr') }))
      .filter((p) => p.labels.includes(DECISION_LABEL)),
  ].sort((a, b) => a.number - b.number);
  /** @type {Ask[]} */
  const asks = [];
  for (const t of threads) {
    const comments = await listing(reader, `repos/${repo}/issues/${t.number}/comments?per_page=100`);
    const state = askState(comments.map((c) => ({ body: String(c?.body ?? ''), url: String(c?.html_url ?? '') })));
    asks.push({ number: t.number, title: t.title, url: t.url, kind: t.kind, ...state });
  }
  return asks;
}

/**
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now: number }} io
 * @returns {Promise<NeedsOwner>}
 */
async function view({ reader, repo, now }) {
  const context = await readinessContext(reader, repo);
  const { register } = context;
  const prs = await allNodes(reader, Q_OPEN_PRS, ownerAndName(repo), (d) => d?.repository?.pullRequests);

  // Each open pull request, as the readiness view answers for it.
  const { merges, decisions } = await readinessOfEach(prs, { reader, repo, now, context });

  // The open issues that carry a stop, a lane's trigger, a hold or an ask.
  const watchedLabels = [...STOP_LABELS, ...LANES.map((l) => l.label), HELD, DECISION_LABEL];
  const issues = await openIssues(reader, repo, watchedLabels);
  const isLinked = linkedPrIndex(prs.map((p) => ({ headRefName: p.headRefName, closingIssuesReferences: closingOf(p, repo, reader) })));
  const inLane = issues.filter((i) => LANES.some((l) => i.labels.includes(l.label)));
  const live = inLane.length ? await liveRuns(reader, repo) : [];
  const running = new Map(LANES.map((lane) => [lane.key, liveRunsByIssue(live, inLane.filter((i) => i.labels.includes(lane.label)), lane, { now })]));

  const bots = registerBotLogins(register);
  const agent = register.get('Implementer') ?? null;
  const lead = register.get('Lead') ?? null;
  /** @type {NeedsOwner['stops']} */
  const stops = [];
  /** @type {NeedsOwner['holds']} */
  const holds = [];
  for (const issue of issues) {
    /** @type {Set<StopReason>} */
    const reasons = new Set(/** @type {StopReason[]} */ (STOP_LABELS.filter((l) => issue.labels.includes(l))));
    const lanes = LANES.filter((l) => issue.labels.includes(l.label));
    const comments = lanes.length || issue.labels.includes(HELD) ? await issueComments(issue.number, { reader, repo }) : [];
    for (const lane of lanes) {
      const rows = commentRows(comments);
      const v = classifyLane(issue, rows, Boolean(isLinked(issue.number)), {
        lane,
        now,
        liveRun: running.get(lane.key)?.get(issue.number) ?? null,
        isBot: (/** @type {string} */ login) => bots.has(norm(login)),
        agent,
        sweep: lead,
      });
      if (!SPOKE_LAST.has(v.state)) continue;
      const lastWord = rows.filter((c) => agent != null && asRole('Implementer', { login: c.login, expected: agent, body: c.body })).at(-1);
      if (lastWord && BAIL_RE.test(lastWord.body)) reasons.add('scope-first-bail');
      else if (v.state === 'awaiting-human') reasons.add('awaiting-human');
    }
    if (reasons.size) stops.push({ number: issue.number, title: issue.title, url: issue.url, reasons: [...reasons] });
    if (issue.labels.includes(HELD) && leadComments(comments, lead).some((c) => String(c.body ?? '').includes(HELD_MARKER))) {
      holds.push({ number: issue.number, title: issue.title, url: issue.url });
    }
  }

  // The lanes the lane-health view reports red.
  const health = await laneHealthView({ reader, repo });
  const lanes = health.callers.filter((c) => c.health === 'red')
    .map((c) => ({ file: c.file, url: `https://github.com/${repo}/actions/workflows/${encodeURIComponent(c.file)}`, failed: c.failed, decisive: c.decisive }));

  // The decisions asked of a person.
  const asks = await asksOf(reader, repo, issues, prs);

  return { branch: context.files.branch, merges, stops, holds, decisions, asks, lanes };
}

/**
 * An issue's or pull request's label names, all of them, or a failed read naming it (`[STAT-3]`).
 * @param {any} item @param {import('./reader.mjs').Reader} reader @param {string} read the query's name
 * @returns {string[]}
 */
function namesOf(item, reader, read) {
  const conn = item?.labels;
  if (!conn || !Array.isArray(conn.nodes)) throw new ReadError(`${read} labels of #${item?.number}`, 'the answer has no such connection');
  requireComplete(`${read} labels of #${item.number}`, conn.nodes.length, conn.totalCount, reader);
  return conn.nodes.map((/** @type {{ name: string }} */ l) => String(l.name));
}

/**
 * The issues in this repository a pull request closes, as the sweep's `linkedPrIndex` reads them:
 * another repository's are dropped here, so its `repository` field isn't needed.
 * @param {any} pr @param {string} repo @param {import('./reader.mjs').Reader} reader
 * @returns {Array<{ number: number }>}
 */
function closingOf(pr, repo, reader) {
  const conn = pr?.closingIssuesReferences;
  const read = `${graphqlRead(Q_OPEN_PRS)} closingIssuesReferences of #${pr?.number}`;
  if (!conn || !Array.isArray(conn.nodes)) throw new ReadError(read, 'the answer has no such connection');
  requireComplete(read, conn.nodes.length, conn.totalCount, reader);
  return conn.nodes
    .filter((/** @type {any} */ i) => String(i?.repository?.nameWithOwner ?? repo).toLowerCase() === repo.toLowerCase())
    .map((/** @type {any} */ i) => ({ number: Number(i.number) }));
}

/**
 * The repository's queued and in-progress runs fired by an issue, every page of each status the
 * sweep counts as live, as its `makeLiveRunsReader` reads them.
 * @param {import('./reader.mjs').Reader} reader @param {string} repo
 */
async function liveRuns(reader, repo) {
  const out = [];
  for (const status of LIVE_RUN_STATUSES) {
    out.push(...await listing(reader, `repos/${repo}/actions/runs?status=${status}&event=issues&per_page=100`, (p) => p?.workflow_runs, (p) => p?.total_count));
  }
  return out;
}
