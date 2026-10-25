// THE NEEDS-THE-OWNER VIEW (project #1327, Issue F): what in a repository waits on a person now,
// each with its link and its reason, read live, and nothing written anywhere.
//
// A CLOSED LIST, AND EVERY ENTRY ANOTHER DECIDER'S ANSWER (`[STAT-10]`). The view lists five
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
//   - the lanes the lane-health view reports `red`.
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
      nodes { number headRefName closingIssuesReferences(first: 100) { totalCount nodes { number repository { nameWithOwner } } } }
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
 * @property {Array<{ file: string, url: string, failed: number, decisive: number }>} lanes
 */

/**
 * The needs-the-Owner view of one repository. Reads only through `reader`; writes nothing.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now?: number }} args
 * @returns {Promise<NeedsOwner>}
 */
export async function needsOwnerView({ reader: given, repo, now = Date.now() }) {
  const what = 'the needs-the-Owner view';
  const { reader, failures } = watched(given);
  try {
    const answer = await view({ reader, repo, now });
    const failed = failures();
    if (failed.length) throw new IncompleteRead(what, failed);
    return answer;
  } catch (e) {
    if (e instanceof IncompleteRead && e.message.startsWith(what)) throw e;
    const failed = failures();
    if (e instanceof ReadError && !failed.includes(e)) failed.push(e);
    if (failed.length) throw new IncompleteRead(what, failed);
    throw e;
  }
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
  /** @type {NeedsOwner['merges']} */
  const merges = [];
  /** @type {NeedsOwner['decisions']} */
  const decisions = [];
  for (const p of prs) {
    const r = await readinessOf(Number(p.number), { reader, repo, now, context });
    if (r.readiness.by === 'person' && r.readiness.ready) merges.push({ number: r.number, title: r.title, url: r.url, rule: r.verdict.rule, reason: r.readiness.why });
    for (const d of r.decisions ?? []) decisions.push({ number: r.number, title: r.title, url: r.url, brief: d.brief, n: d.n, headline: d.headline, marker: d.marker });
  }

  // The open issues that carry a stop, a lane's trigger or a hold.
  const watchedLabels = [...STOP_LABELS, ...LANES.map((l) => l.label), HELD];
  const issues = (await allNodes(reader, Q_ISSUES, { ...ownerAndName(repo), labels: watchedLabels }, (d) => d?.repository?.issues))
    .map((i) => ({ number: Number(i.number), title: String(i.title ?? ''), url: String(i.url ?? ''), labels: namesOf(i, reader) }));
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

  return { branch: context.files.branch, merges, stops, holds, decisions, lanes };
}

/**
 * An issue's label names, all of them, or a failed read naming the issue (`[STAT-3]`).
 * @param {any} issue @param {import('./reader.mjs').Reader} reader
 * @returns {string[]}
 */
function namesOf(issue, reader) {
  const conn = issue?.labels;
  if (!conn || !Array.isArray(conn.nodes)) throw new ReadError(`${graphqlRead(Q_ISSUES)} labels of #${issue?.number}`, 'the answer has no such connection');
  requireComplete(`${graphqlRead(Q_ISSUES)} labels of #${issue.number}`, conn.nodes.length, conn.totalCount, reader);
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
