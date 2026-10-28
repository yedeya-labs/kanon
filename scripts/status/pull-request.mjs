// THE PULL-REQUEST READINESS VIEW (project #1327, Issue C): where one pull request stands, read
// live, as the Merger would read it on its next sweep, and nothing written anywhere.
//
// THE MERGE GATE JUDGES, NOT THIS FILE (`[STAT-7]`, `K-PRIN-2`). The pull request is read into
// the shape the merge gate's `readPr` builds, through the injected reader rather than `gh`, and
// `mergeVerdict` answers for it. `readPr` shells out to `gh`, which a hosted function doesn't
// have, so `readPullRequest` below reads the same facts over the REST and GraphQL APIs and builds
// the same object; `tests/library/status-readiness.test.ts` holds the two together over one
// fixture, so a field one of them gains and the other doesn't is a red test. The pure pieces of
// `readPr` are imported, never copied: the closing-set analysis, the trailer, the spec-promotion
// read, the markers. What is copied is only how `gh pr view --json` projects a check, which
// `readPr` maps from and an API answer doesn't carry.
//
// A PERSON'S PULL REQUEST IS COMPOSED, NOT JUDGED (`[STAT-14]`, decision 13). The gate skips a
// pull request that isn't provably the Implementer's. For one, the view composes four functions
// that exist already: the gate's `checkPartition`, `conflictState`, the review-recovery lane's
// `verdictOnHead`, and, for a brief, the brief guard's `openDecisions`, and applies no other test.
//
// A TOKEN THAT CAN'T READ CHECK RUNS STILL GETS AN ANSWER. A fine-grained personal access token
// has no Checks permission to grant, so GitHub refuses it the check rollup. The view then reads
// the head's workflow runs and commit statuses instead (`checksFromRuns`), and says so
// (`checks.source`); the refusal is the answer to that one read, not a failure of the view (`[STAT-15]`).
//
// INCOMPLETE IS AN ERROR (`[STAT-3]`). `readPr` reads some answers softly, as `null`, which the
// gate waits on; a status answer built on one would be partial, so here every failed read is the
// view's error, by name, and every listing that ends before its count is one.

import { APP_REGISTER, parseAppRegister } from '../app-register.mjs';
import { REQUIRED_SECTIONS, briefSections, isBrief, openDecisions } from '../brief-guard.mjs';
import { analyse } from '../closing-refs.mjs';
import { conflictState } from '../conflict-state.mjs';
import { judgingInputs } from '../judging-inputs.mjs';
import { defaultBranchReader } from '../lib/declarations.mjs';
import { ESCALATION_FILE, escalatingPaths, readEscalationFileAt } from '../lib/escalation-paths.mjs';
import { EXEMPTIONS_FILE, defaultExemptions, parseExemptions } from '../lib/exemptions.mjs';
import { readProductionPromotionAt } from '../lib/production-promotion.mjs';
import { HANDBACK, isEscalation, mergerMarker, mergerMarkerSpellings, mergerMarkersIn } from '../lib/protocol-spellings.mjs';
import { ADOPTION_RECORD } from '../lib/reference-deploy.mjs';
import { asRole, slugOf } from '../lib/role-marker.mjs';
import { isSpecFile, specPromotions } from '../lib/spec-promotions.mjs';
import { LAPSES_WITH_HEAD, checkPartition, mergeVerdict } from '../merge-gate.mjs';
import { attemptOn as rebaseAttemptOn } from '../rebase-lane.mjs';
import { verdictOnHead } from '../review-recovery.mjs';
import { evidenceSha, readTrailer } from '../review-trailer.mjs';
import { isAcDeclaration } from '../verify-acs.mjs';
import { IncompleteRead } from './project.mjs';
import { ReadError, graphqlRead, ownerAndName, requireComplete, watched } from './reader.mjs';
import { readSpecLayer } from './spec-layer.mjs';

/** What the readiness view reads of a pull request, but its checks. */
const PR_FIELDS = `
      id number title url body state isDraft headRefOid mergeable mergeStateStatus isMergeQueueEnabled isInMergeQueue
      author { __typename login }
      labels(first: 100) { totalCount nodes { name } }
      closingIssuesReferences(first: 100) { totalCount nodes { number body repository { nameWithOwner } } }
      commits(first: 100) { totalCount nodes { commit { messageHeadline messageBody } } }
      timelineItems(itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT], last: 1) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } }`;

/** The head's checks, as the merge gate reads them: a token that can't read check runs is refused this. */
const HEAD_CHECKS = `
      head: commits(last: 1) {
        nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
          __typename
          ... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
          ... on StatusContext { context state createdAt }
        } } } } }
      }`;

const Q_PR = `query PullRequestGate($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {${PR_FIELDS}${HEAD_CHECKS}
    }
  }
}`;

/**
 * The same read without the checks, for a token GitHub won't show check runs to: a fine-grained
 * personal access token has no Checks permission to grant, and an App token may lack it. The
 * head's checks are then read from its workflow runs and commit statuses (`checksFromRuns`).
 */
export const Q_PR_NO_CHECKS = `query PullRequestGateNoChecks($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {${PR_FIELDS}
    }
  }
}`;

/** GitHub's answer to a token that may not read the check runs a query asks for. */
const CHECKS_REFUSED = /Resource not accessible|FORBIDDEN/i;

/** The marker rule of the Merger's record that it queued a head (`merge-gate.mjs`, kanon#1104). */
const QUEUED = 'queued';

/** The `StatusContext` states that haven't reported yet, as `readPr` reads them (#821). */
const UNREPORTED_STATES = new Set(['PENDING', 'EXPECTED']);

/** Go's zero time, which `gh` prints for a check run's time that GitHub left empty. */
const ZERO_TIME = '0001-01-01T00:00:00Z';

/** The gate rules that skip a pull request as not the Implementer's (`[STAT-14]`). */
const NOT_THE_IMPLEMENTERS = new Set(['not-the-implementer', 'not-implementer-label']);

/** An escalation pattern nothing matches: the gate's verdict with the declared paths lifted. */
const NO_PATHS = [/** @type {const} */ ([/(?!)/, 'no declared path'])];

/**
 * One check, as `readPr` builds it from `gh pr view --json statusCheckRollup`. `gh` projects a
 * check run's empty conclusion as `""` and its empty times as Go's zero time, and a status
 * context's `createdAt` as `startedAt`, so this projects the API's node the same way first.
 * @param {any} node a `statusCheckRollup` context
 */
function checkOf(node) {
  const c = node?.__typename === 'StatusContext'
    ? { context: node.context, startedAt: node.createdAt, state: node.state }
    : {
      name: node?.name, workflowName: node?.checkSuite?.workflowRun?.workflow?.name ?? '', status: node?.status,
      conclusion: node?.conclusion ?? '', startedAt: node?.startedAt ?? ZERO_TIME, completedAt: node?.completedAt ?? ZERO_TIME, detailsUrl: node?.detailsUrl ?? '',
    };
  const s = /** @type {any} */ (c);
  return {
    name: s.name ?? s.context,
    workflowName: s.workflowName,
    startedAt: s.startedAt ?? s.createdAt,
    completedAt: s.completedAt,
    databaseId: s.databaseId,
    runId: /\/actions\/runs\/(\d+)(?:\/|$)/.exec(s.detailsUrl ?? '')?.[1],
    jobId: /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(s.detailsUrl ?? '')?.[1],
    ...(s.status === undefined && UNREPORTED_STATES.has(s.state)
      ? { status: s.state, conclusion: null }
      : { status: s.status ?? 'COMPLETED', conclusion: s.conclusion ?? (s.state === 'SUCCESS' ? 'SUCCESS' : s.state ?? null) }),
  };
}

/**
 * The head's checks, read from what a token without the Checks permission can read: each workflow
 * run on the head is one check, named by its workflow, and each commit status context its newest
 * status, both in the shape `checkOf` gives. A run stands in for its jobs, so a run with a failed
 * job is one failed check, and a run still going is one pending check.
 * @param {any[]} runs the head's workflow runs, as the REST listing has them
 * @param {any[]} statuses the head's commit statuses, newest first, as the REST listing has them
 */
export function checksFromRuns(runs, statuses) {
  const fromRuns = runs.map((r) => {
    const done = r?.status === 'completed';
    return {
      name: String(r?.name ?? ''),
      workflowName: String(r?.name ?? ''),
      startedAt: r?.run_started_at ?? r?.created_at ?? ZERO_TIME,
      completedAt: done ? (r?.updated_at ?? ZERO_TIME) : ZERO_TIME,
      databaseId: undefined,
      runId: r?.id === undefined ? undefined : String(r.id),
      jobId: undefined,
      status: done ? 'COMPLETED' : String(r?.status ?? 'queued').toUpperCase(),
      conclusion: done ? String(r?.conclusion ?? '').toUpperCase() : '',
    };
  });
  /** @type {Set<string>} */
  const seen = new Set();
  const newest = statuses.filter((s) => !seen.has(String(s?.context)) && seen.add(String(s?.context)));
  const fromStatuses = newest.map((s) => checkOf({ __typename: 'StatusContext', context: s.context, state: String(s.state ?? '').toUpperCase(), createdAt: s.created_at ?? ZERO_TIME }));
  return [...fromRuns, ...fromStatuses];
}

/**
 * Every entry of a paged REST listing. `at` picks a page's entries; a page without them is a
 * failed read, and so is a listing that ends before the count it reports, when `total` reads one.
 * @param {import('./reader.mjs').Reader} reader @param {string} path
 * @param {(page: any) => unknown} [at] @param {(page: any) => number | undefined} [total]
 * @returns {Promise<any[]>}
 */
export async function listing(reader, path, at = (p) => p, total = () => undefined) {
  const pages = await reader.pages(path);
  if (!Array.isArray(pages)) throw new ReadError(`GET ${path}`, 'the answer has no pages');
  /** @type {any[]} */
  const out = [];
  for (const page of pages) {
    const entries = at(page);
    if (!Array.isArray(entries)) throw new ReadError(`GET ${path}`, 'a page has no entries');
    out.push(...entries);
  }
  requireComplete(`GET ${path}`, out.length, pages.length ? total(pages[0]) : undefined, reader);
  return out;
}

/**
 * A connection's nodes, all of them on this page, or a failed read naming it (`[STAT-3]`).
 * @param {any} conn @param {string} name @param {import('./reader.mjs').Reader} reader
 * @returns {any[]}
 */
function wholeConnection(conn, name, reader) {
  if (!conn || !Array.isArray(conn.nodes)) throw new ReadError(`${graphqlRead(Q_PR)} ${name}`, 'the answer has no such connection');
  requireComplete(`${graphqlRead(Q_PR)} ${name}`, conn.nodes.length, conn.totalCount, reader);
  return conn.nodes;
}

/**
 * One pull request, in the shape the merge gate's `readPr` builds, read through `reader`: `pr` is
 * that shape, and `node` the GraphQL answer it was built from, for what the view adds.
 * @param {import('./reader.mjs').Reader} reader
 * @param {string} repo `owner/name`
 * @param {number} number
 * @param {{ merger: string, implementer: string }} logins the Merger's login, whose comments say
 *   what it did, and the Implementer's, whose comments alone carry the rebase lane's attempt
 *   (kanon#1486): the default branch's register's, never the working directory's (kanon#1396)
 */
export async function readPullRequest(reader, repo, number, { merger, implementer }) {
  const vars = { ...ownerAndName(repo), number };
  /** Where the head's checks were read from: its check rollup, or, for a token refused that, its runs. */
  let checksFrom = /** @type {'rollup' | 'runs'} */ ('rollup');
  let data;
  try {
    data = /** @type {any} */ (await reader.graphql(Q_PR, vars));
  } catch (e) {
    const why = e instanceof ReadError ? e.why : String(/** @type {Error} */ (e)?.message ?? e);
    if (!CHECKS_REFUSED.test(why)) throw e;
    // Read again without the checks: the refusal is answered, not lost (`[STAT-3]`).
    if (e instanceof ReadError) e.expected = true;
    data = /** @type {any} */ (await reader.graphql(Q_PR_NO_CHECKS, vars));
    checksFrom = 'runs';
  }
  const node = data?.repository?.pullRequest;
  if (!node) throw new ReadError(graphqlRead(Q_PR), `${repo} has no pull request #${number}`);
  const head = String(node.headRefOid);
  const labels = wholeConnection(node.labels, 'labels', reader).map((l) => l.name);
  const closes = wholeConnection(node.closingIssuesReferences, 'closingIssuesReferences', reader);
  const commits = wholeConnection(node.commits, 'commits', reader);

  const base = `repos/${repo}`;
  const changed = await listing(reader, `${base}/pulls/${number}/files?per_page=100`);
  const files = changed.map((f) => String(f.filename));
  const reviews = await listing(reader, `${base}/pulls/${number}/reviews?per_page=100`);
  const runs = await listing(reader, `${base}/actions/runs?head_sha=${head}&status=failure&per_page=100`, (p) => p?.workflow_runs, (p) => p?.total_count);
  const statuses = await listing(reader, `${base}/commits/${head}/statuses?per_page=100`);
  const rollup = node.head?.nodes?.at(-1)?.commit?.statusCheckRollup;
  const checks = checksFrom === 'runs'
    ? checksFromRuns(await listing(reader, `${base}/actions/runs?head_sha=${head}&per_page=100`, (p) => p?.workflow_runs, (p) => p?.total_count), statuses)
    : (rollup ? wholeConnection(rollup.contexts, 'statusCheckRollup', reader) : []).map(checkOf);
  await reader.get(`${base}/issues?per_page=1`);

  /** @type {Promise<Array<{ login: string, body: string, at: string }>> | null} */
  let said = null;
  const comments = () => (said ??= listing(reader, `${base}/issues/${number}/comments?per_page=100`)
    .then((cs) => cs.map((c) => ({ login: String(c?.user?.login ?? ''), body: String(c?.body ?? ''), at: String(c?.created_at ?? '') }))));
  const byMerger = (/** @type {{ login: string, body: string }} */ c) => asRole('Merger', { login: c.login, expected: merger, body: c.body });

  const conflicting = conflictState({ mergeable: node.mergeable, mergeStateStatus: node.mergeStateStatus }) === 'conflicting';
  const removed = node.timelineItems?.nodes?.at(-1);
  /** @type {any} */
  const mergeQueue = {
    enabled: node.isMergeQueueEnabled, queued: node.isInMergeQueue, id: node.id,
    removed: removed ? { reason: removed.reason ?? null, at: removed.createdAt } : null,
  };
  if (mergeQueue.enabled && !mergeQueue.queued && mergeQueue.removed) {
    const spellings = mergerMarkerSpellings(QUEUED, head);
    mergeQueue.queuedHere = (await comments()).some((c) => byMerger(c) && spellings.some((m) => c.body.includes(m)));
  }

  const who = node.author;
  const pr = {
    number: node.number,
    author: who ? (who.__typename === 'Bot' ? `app/${who.login}` : String(who.login)) : '',
    body: node.body ?? '',
    state: node.state,
    isDraft: node.isDraft,
    labels,
    files,
    headSha: head,
    headStatuses: statuses.map((s) => ({ context: s.context, state: s.state, creator: s.creator?.login ?? '' })),
    workflowRuns: runs.map((r) => ({ name: r.name, conclusion: r.conclusion })),
    reviews: reviews.map((r) => ({ id: r.id, state: r.state, sha: r.commit_id, author: r.user?.login ?? '', body: r.body ?? '', ...readTrailer(r) })),
    checks,
    mergeStateStatus: node.mergeStateStatus,
    mergeable: node.mergeable,
    closing: analyse({
      body: node.body,
      title: node.title,
      willClose: closes.map((i) => i.number),
      commitMessages: commits.map((c) => `${c.commit?.messageHeadline}\n${c.commit?.messageBody ?? ''}`),
      repo,
      issuesReadable: true,
    }),
    rebaseAttempted: conflicting ? rebaseAttemptOn(await comments(), head, { implementer }) : false,
    hold: labels.includes('needs:human') ? await holdOf(reader, `${base}/issues/${number}/events?per_page=100`, await comments(), byMerger) : undefined,
    handback: checkPartition(checks).failed.length
      ? ((found) => (found ? { at: found.at } : false))((await comments()).find((c) => byMerger(c) && c.body.includes(mergerMarker(HANDBACK, head))))
      : undefined,
    specDiff: files.some(isSpecFile)
      ? specPromotions(changed.filter((f) => isSpecFile(String(f.filename))).map((f) => ({ file: String(f.filename), patch: f.patch ?? null, changes: Number(f.changes) || 0 })))
      : undefined,
    mergeQueue,
  };
  return { pr, node, changed, checksFrom };
}

/**
 * Who last applied `needs:human`, and the (rule, head) of each escalation the Merger posted, as
 * the merge gate's `holdOn` reads them.
 * @param {import('./reader.mjs').Reader} reader @param {string} path the issue's events
 * @param {Array<{ login: string, body: string }>} comments
 * @param {(c: { login: string, body: string }) => boolean} byMerger
 */
async function holdOf(reader, path, comments, byMerger) {
  const events = await listing(reader, path);
  const labeledBy = events.filter((e) => e?.event === 'labeled' && e?.label?.name === 'needs:human').map((e) => String(e?.actor?.login ?? '')).filter(Boolean).at(-1) ?? '';
  // Both groups of a marker always match: `mergerMarkersIn`'s type only can't say so.
  const escalations = /** @type {{ rule: string, sha: string }[]} */ (comments.filter((c) => byMerger(c) && isEscalation(c.body)).flatMap((c) => mergerMarkersIn(c.body)));
  return { labeledBy, escalations };
}

/**
 * The escalating paths the merge gate judges with, from the default branch, as its
 * `readEscalations` reads them: the escalation file, widened by a human-gated production
 * promotion to all but the paths marked `always` and the judging inputs (`K-MERGE-4`).
 * @param {import('../lib/declarations.mjs').BranchFiles} files
 * @param {import('./reader.mjs').Reader} reader @param {string} repo
 */
async function escalationsAt(files, reader, repo) {
  /** @type {Map<string, string | null>} */
  const read = new Map();
  for (const path of [ESCALATION_FILE, ADOPTION_RECORD]) read.set(path, await files.read(path));
  const at = (/** @type {string} */ path) => /** @type {string | null} */ (read.get(path) ?? null);
  const file = readEscalationFileAt(files.branch, at);
  const promotion = readProductionPromotionAt(files.branch, at);
  if (promotion.gate === null) return escalatingPaths(file);
  return escalatingPaths(file, { judgingInputs: await judgingInputsAt(files, reader, repo) });
}

/**
 * `judgingInputs` of the default branch, over the reader. The tree is one read; the function asks
 * for a markdown file's text as it follows a delegation, so it runs again with each file it asked
 * for read, until it asks for none it hasn't been given.
 * @param {import('../lib/declarations.mjs').BranchFiles} files
 * @param {import('./reader.mjs').Reader} reader @param {string} repo
 */
async function judgingInputsAt(files, reader, repo) {
  const path = `repos/${repo}/git/trees/${encodeURIComponent(files.branch)}?recursive=1`;
  const tree = /** @type {{ tree?: Array<{ path?: string, type?: string, mode?: string }>, truncated?: boolean }} */ (await reader.get(path));
  if (!Array.isArray(tree?.tree)) throw new ReadError(`GET ${path}`, 'the answer has no tree');
  if (tree.truncated) throw new ReadError(`GET ${path}`, 'GitHub cut the tree short, so not every judging input was listed');
  const regular = new Set(tree.tree.filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755')).map((e) => String(e.path)));
  /** @type {Map<string, string | null>} */
  const texts = new Map();
  for (;;) {
    /** @type {Set<string>} */
    const asked = new Set();
    const found = judgingInputs({
      under: (dir) => [...regular].filter((p) => (dir === '.' ? !p.includes('/') : p.startsWith(`${dir}/`))),
      isFile: (p) => regular.has(p),
      read: (p) => {
        if (!regular.has(p)) return null;
        if (!texts.has(p)) asked.add(p);
        return texts.get(p) ?? null;
      },
    });
    if (!asked.size) return found;
    for (const p of asked) texts.set(p, await files.read(p));
  }
}

/**
 * The acceptance-criterion ids an issue body cites: those its bullets declare (`isAcDeclaration`,
 * the form `verify-acs` counts as a commitment), then those it only mentions.
 * @param {string} body
 */
function acsOf(body) {
  const id = (/** @type {string} */ s) => /`\[([A-Z]+-\d+)\]`/.exec(s)?.[1];
  const declared = new Set(String(body).split('\n').filter(isAcDeclaration).map(id).filter((x) => x !== undefined));
  const mentioned = new Set([...String(body).matchAll(/`\[([A-Z]+-\d+)\]`/g)].map((m) => /** @type {string} */ (m[1])).filter((x) => !declared.has(x)));
  return [...[...declared].map((x) => ({ id: /** @type {string} */ (x), declared: true })), ...[...mentioned].map((x) => ({ id: x, declared: false }))];
}

/**
 * The open decisions of each brief a pull request adds or changes, read at its head as the brief
 * guard reads them, or null when it changes no brief. Whether a brief is pre-standard is the
 * default branch's exemptions file's to say, never the pull request's.
 * @param {any[]} changed the REST files listing
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, head: string, files: import('../lib/declarations.mjs').BranchFiles }} io
 */
async function decisionsOf(changed, { reader, repo, head, files }) {
  const briefs = changed.filter((f) => isBrief(String(f.filename)));
  if (!briefs.length) return null;
  const exemptionsText = await files.read(EXEMPTIONS_FILE);
  const exemptions = exemptionsText === null ? defaultExemptions() : parseExemptions(exemptionsText);
  const decisions = /** @type {{ match: RegExp }} */ (REQUIRED_SECTIONS.find((r) => r.key === 'decisions'));
  /** @type {Array<{ brief: string, n: number, headline: string, marker: string }>} */
  const out = [];
  for (const f of briefs) {
    const path = String(f.filename);
    if (f.status === 'removed') continue;
    const file = /** @type {any} */ (await reader.get(`repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${head}`));
    if (file?.type !== 'file' || typeof file.content !== 'string') throw new ReadError(`GET repos/${repo}/contents/${path}?ref=${head}`, `${path} at the head isn't a file GitHub sent whole`);
    const text = Buffer.from(file.content, 'base64').toString('utf8');
    const preStandard = exemptions.briefs.some((/** @type {{ brief: string }} */ b) => b.brief === path);
    for (const sec of briefSections(text).filter((s) => decisions.match.test(s.title))) {
      for (const d of openDecisions(sec.body, preStandard)) out.push({ brief: path, n: d.n, headline: d.headline, marker: d.marker });
    }
  }
  return out;
}

/**
 * Whether the Merger's `needs:human` on a pull request stands for an escalation path alone: every
 * escalation it posted is the path rule, or a rule that lapsed with a head that isn't this one.
 * Then lifting the paths lifts what the label is about, as the gate's own release reasons.
 * @param {any} pr @param {string} merger
 */
const heldForPathAlone = (pr, merger) => {
  const h = pr.hold;
  if (!h || slugOf(h.labeledBy) !== slugOf(merger) || !Array.isArray(h.escalations) || !h.escalations.length) return false;
  const head12 = String(pr.headSha).slice(0, 12);
  return h.escalations.every((/** @type {{ rule: string, sha: string }} */ e) => e.rule === 'escalating-path' || (LAPSES_WITH_HEAD.has(e.rule) && String(e.sha).slice(0, 12) !== head12));
};

/**
 * The readiness view of one pull request. Reads only through `reader`; writes nothing.
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, pr: number | string, now?: number }} args
 */
export async function readinessView({ reader: given, repo, pr: number, now = Date.now() }) {
  const { reader, failures } = watched(given);
  try {
    const answer = await readinessOf(Number(number), { reader, repo, now, context: await readinessContext(reader, repo) });
    const failed = failures();
    if (failed.length) throw new IncompleteRead(`pull request #${number}`, failed);
    return answer;
  } catch (e) {
    if (e instanceof IncompleteRead) throw e;
    const failed = failures();
    if (e instanceof ReadError && !failed.includes(e)) failed.push(e);
    if (failed.length) throw new IncompleteRead(`pull request #${number}`, failed);
    throw e;
  }
}

/**
 * What the readiness view reads from the default branch once, whichever pull request it judges:
 * the App register, the logins the gate compares, and the escalating paths. A view that judges
 * every open pull request (the needs-the-Owner view) reads it once for all of them.
 * @param {import('./reader.mjs').Reader} reader @param {string} repo
 */
export async function readinessContext(reader, repo) {
  const files = await defaultBranchReader(reader, repo);
  const registerText = await files.read(APP_REGISTER);
  const where = `${APP_REGISTER} on \`${files.branch}\``;
  const register = registerText === null ? new Map() : parseAppRegister(registerText, where);
  // The logins the gate compares, from the default branch's register and from nowhere else: the
  // view may run where there is no checkout, and a checkout's register is a branch's, not the
  // repository's (kanon#1396). A role the register doesn't list has no login to judge by, so the
  // view stops, naming it, as the gate's own read of the register does.
  const login = (/** @type {'Implementer' | 'Reviewer' | 'Merger'} */ role) => {
    const slug = register.get(role);
    if (!slug) throw new Error(`${registerText === null ? `${repo} has no App register (${where})` : `${where} lists no ${role} App`}, so the merge gate has no ${role} login to judge ${repo}'s pull requests by (K-LAYOUT-6).`);
    return slug;
  };
  const logins = { implementer: login('Implementer'), reviewer: login('Reviewer'), merger: login('Merger') };
  const escalations = await escalationsAt(files, reader, repo);
  return { files, register, logins, escalations };
}

/**
 * One pull request's readiness, over a context `readinessContext` read. Throws the first read that
 * failed; a caller that tolerates none checks its watched reader's failures after.
 * @param {number} number
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now: number, context: Awaited<ReturnType<typeof readinessContext>> }} io
 */
export async function readinessOf(number, { reader, repo, now, context }) {
  const { files, logins, escalations } = context;
  const { pr, node, changed, checksFrom } = await readPullRequest(reader, repo, number, { merger: logins.merger, implementer: logins.implementer });
  const gate = { escalations, now, implementer: logins.implementer, reviewer: logins.reviewer, merger: logins.merger };
  const verdict = mergeVerdict(pr, gate);
  const parts = checkPartition(pr.checks);

  // The Reviewer's latest verdict, and the commit it read (`evidenceSha`, the trailer's stamp).
  const reviewer = logins.reviewer;
  const latest = pr.reviews.filter((/** @type {any} */ r) => (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
    && asRole('Reviewer', { login: r.author, expected: reviewer, body: r.body })).at(-1);
  const review = latest ? { state: latest.state, commit: evidenceSha(latest), current: evidenceSha(latest) === pr.headSha } : null;

  // The criteria of the issues it closes in this repository, with their status in the spec layer.
  const closing = (node.closingIssuesReferences?.nodes ?? []).filter((/** @type {any} */ i) => (i.repository?.nameWithOwner ?? repo).toLowerCase() === repo.toLowerCase());
  const cited = closing.map((/** @type {any} */ i) => ({ number: i.number, acs: acsOf(i.body ?? '') }));
  const spec = cited.some((/** @type {any} */ c) => c.acs.length) ? await readSpecLayer(files) : { clauses: new Map() };
  const closes = cited.map((/** @type {any} */ c) => ({ number: c.number, acs: c.acs.map((/** @type {any} */ a) => ({ ...a, clause: spec.clauses.get(a.id)?.status ?? null })) }));

  const decisions = await decisionsOf(changed, { reader, repo, head: pr.headSha, files });
  const readiness = NOT_THE_IMPLEMENTERS.has(verdict.rule) && verdict.action === 'skip'
    ? personsReadiness(pr, parts, decisions, reviewer)
    : implementersReadiness(pr, verdict, gate, logins.merger);

  /** @param {any[]} cs */
  const names = (cs) => cs.map((c) => c.name);
  return {
    number: pr.number,
    title: node.title ?? '',
    url: node.url ?? '',
    state: pr.state,
    draft: pr.isDraft,
    author: pr.author,
    head: pr.headSha,
    branch: files.branch,
    checks: {
      source: checksFrom,
      relevant: parts.relevant.map((/** @type {any} */ c) => ({ name: c.name, workflow: c.workflowName || null, status: c.status, conclusion: c.conclusion || null })),
      pending: names(parts.pending),
      cancelled: names(parts.cancelled),
      failed: names(parts.failed),
    },
    review,
    closes,
    verdict: { action: verdict.action, rule: verdict.rule, why: verdict.why },
    decisions,
    readiness,
  };
}

/**
 * The Implementer's pull request (`[STAT-7]`): ready for the Merger when the gate answers merge;
 * ready for a person's merge when it escalates on an escalation path alone, which is when the
 * gate, given the same pull request with the declared paths lifted, answers merge. Every other
 * answer isn't ready, and the gate's rule is what it lacks.
 * @param {any} pr @param {any} verdict @param {any} gate @param {string} merger
 */
function implementersReadiness(pr, verdict, gate, merger) {
  if (verdict.action === 'merge') return { by: 'merger', ready: true, lacks: [], why: `the merge gate answers merge: ${verdict.why}` };
  if (verdict.action === 'escalate' && verdict.rule === 'escalating-path') {
    const lifted = mergeVerdict(heldForPathAlone(pr, merger) ? { ...pr, labels: pr.labels.filter((/** @type {string} */ l) => l !== 'needs:human') } : pr, { ...gate, escalations: NO_PATHS });
    if (lifted.action === 'merge') return { by: 'person', ready: true, lacks: [], why: `an escalation path is all that stops the Merger: ${verdict.why}` };
    return { by: 'person', ready: false, lacks: [lifted.rule], why: `it ${verdict.why}, and besides that the merge gate answers ${lifted.action} (${lifted.rule}): ${lifted.why}` };
  }
  const by = verdict.action === 'escalate' || verdict.rule === 'draft' || verdict.rule === 'not-open' ? 'person' : 'merger';
  return { by, ready: false, lacks: [verdict.rule], why: `the merge gate answers ${verdict.action} (${verdict.rule}): ${verdict.why}` };
}

/**
 * A pull request the gate skips as not the Implementer's (`[STAT-14]`): a person's to merge,
 * ready only when the gate's check partition finds a relevant check and none pending, cancelled
 * or failed, GitHub doesn't report it conflicting (`conflictState`, so a mergeability GitHub is
 * still computing doesn't hold it), the review-recovery lane reads an approval on its head, and,
 * for a brief, the brief guard finds no open decision. Nothing else is asked of it.
 * @param {any} pr @param {ReturnType<typeof checkPartition>} parts
 * @param {Array<{ n: number }> | null} decisions @param {string} reviewer
 */
function personsReadiness(pr, parts, decisions, reviewer) {
  /** @type {string[]} */
  const lacks = [];
  /** @type {string[]} */
  const why = [];
  if (!parts.relevant.length) {
    lacks.push('checks');
    why.push('no check has run on its head');
  } else if (parts.pending.length || parts.cancelled.length || parts.failed.length) {
    lacks.push('checks');
    why.push(`its checks aren't green (${[...parts.pending.map((c) => `${c.name} running`), ...parts.cancelled.map((c) => `${c.name} cancelled`), ...parts.failed.map((c) => `${c.name} ${c.conclusion}`)].join(', ')})`);
  }
  if (conflictState({ mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus }) === 'conflicting') {
    lacks.push('mergeable');
    why.push('it conflicts with its base branch');
  }
  const onHead = verdictOnHead({
    headRefOid: pr.headSha,
    reviews: pr.reviews.map((/** @type {any} */ r) => ({ author: { login: r.author }, state: r.state, body: r.body, commit: { oid: r.sha } })),
  }, { reviewer });
  if (onHead?.state !== 'APPROVED') {
    lacks.push('approval');
    why.push(onHead ? 'its head has no approval: the Reviewer requested changes on it' : 'the Reviewer has not approved its head');
  }
  if (decisions?.length) {
    lacks.push('decisions');
    why.push(`its brief has ${decisions.length} open decision${decisions.length === 1 ? '' : 's'} (${decisions.map((d) => d.n).join(', ')})`);
  }
  return {
    by: 'person',
    ready: lacks.length === 0,
    lacks,
    why: lacks.length ? `a person's to merge, not ready: ${why.join('; ')}` : "a person's to merge: its checks are green, it doesn't conflict with its base branch, the Reviewer approved its head" + (decisions ? ', and its brief has no open decision' : ''),
  };
}
