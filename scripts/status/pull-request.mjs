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
// pull request that isn't provably the Implementer's. For one, the view composes three functions
// that exist already: the gate's `checkPartition`, the review-recovery lane's `verdictOnHead`,
// and, for a brief, the brief guard's `openDecisions`, and applies no other test.
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
import { IMPLEMENTER_LOGIN, LAPSES_WITH_HEAD, MERGER_LOGIN, REVIEWER_LOGIN, checkPartition, mergeVerdict } from '../merge-gate.mjs';
import { marker as rebaseMarker } from '../rebase-lane.mjs';
import { verdictOnHead } from '../review-recovery.mjs';
import { evidenceSha, readTrailer } from '../review-trailer.mjs';
import { isAcDeclaration } from '../verify-acs.mjs';
import { IncompleteRead } from './project.mjs';
import { ReadError, graphqlRead, ownerAndName, requireComplete, watched } from './reader.mjs';
import { readSpecLayer } from './spec-layer.mjs';

const Q_PR = `query PullRequestGate($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title url body state isDraft headRefOid mergeable mergeStateStatus isMergeQueueEnabled isInMergeQueue
      author { __typename login }
      labels(first: 100) { totalCount nodes { name } }
      closingIssuesReferences(first: 100) { totalCount nodes { number body repository { nameWithOwner } } }
      commits(first: 100) { totalCount nodes { commit { messageHeadline messageBody } } }
      head: commits(last: 1) {
        nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
          __typename
          ... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
          ... on StatusContext { context state createdAt }
        } } } } }
      }
      timelineItems(itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT], last: 1) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } }
    }
  }
}`;

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
 * Every entry of a paged REST listing. `at` picks a page's entries; a page without them is a
 * failed read, and so is a listing that ends before the count it reports, when `total` reads one.
 * @param {import('./reader.mjs').Reader} reader @param {string} path
 * @param {(page: any) => unknown} [at] @param {(page: any) => number | undefined} [total]
 * @returns {Promise<any[]>}
 */
async function listing(reader, path, at = (p) => p, total = () => undefined) {
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
 * @param {{ merger?: string }} [logins] the Merger's login, whose comments say what it did
 */
export async function readPullRequest(reader, repo, number, { merger = MERGER_LOGIN } = {}) {
  const data = /** @type {any} */ (await reader.graphql(Q_PR, { ...ownerAndName(repo), number }));
  const node = data?.repository?.pullRequest;
  if (!node) throw new ReadError(graphqlRead(Q_PR), `${repo} has no pull request #${number}`);
  const head = String(node.headRefOid);
  const labels = wholeConnection(node.labels, 'labels', reader).map((l) => l.name);
  const closes = wholeConnection(node.closingIssuesReferences, 'closingIssuesReferences', reader);
  const commits = wholeConnection(node.commits, 'commits', reader);
  const rollup = node.head?.nodes?.at(-1)?.commit?.statusCheckRollup;
  const checks = (rollup ? wholeConnection(rollup.contexts, 'statusCheckRollup', reader) : []).map(checkOf);

  const base = `repos/${repo}`;
  const changed = await listing(reader, `${base}/pulls/${number}/files?per_page=100`);
  const files = changed.map((f) => String(f.filename));
  const reviews = await listing(reader, `${base}/pulls/${number}/reviews?per_page=100`);
  const runs = await listing(reader, `${base}/actions/runs?head_sha=${head}&status=failure&per_page=100`, (p) => p?.workflow_runs, (p) => p?.total_count);
  const statuses = await listing(reader, `${base}/commits/${head}/statuses?per_page=100`);
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
    rebaseAttempted: conflicting ? (await comments()).map((c) => c.body).join('\n').includes(rebaseMarker(head)) : false,
    hold: labels.includes('needs:human') ? await holdOf(reader, `${base}/issues/${number}/events?per_page=100`, await comments(), byMerger) : undefined,
    handback: checkPartition(checks).failed.length
      ? ((found) => (found ? { at: found.at } : false))((await comments()).find((c) => byMerger(c) && c.body.includes(mergerMarker(HANDBACK, head))))
      : undefined,
    specDiff: files.some(isSpecFile)
      ? specPromotions(changed.filter((f) => isSpecFile(String(f.filename))).map((f) => ({ file: String(f.filename), patch: f.patch ?? null, changes: Number(f.changes) || 0 })))
      : undefined,
    mergeQueue,
  };
  return { pr, node, changed };
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
    return await view(Number(number), { reader, repo, now, failures });
  } catch (e) {
    const failed = failures();
    if (e instanceof ReadError && !failed.includes(e)) failed.push(e);
    if (failed.length) throw new IncompleteRead(`pull request #${number}`, failed);
    throw e;
  }
}

/**
 * @param {number} number
 * @param {{ reader: import('./reader.mjs').Reader, repo: string, now: number, failures: () => ReadError[] }} io
 */
async function view(number, { reader, repo, now, failures }) {
  const files = await defaultBranchReader(reader, repo);
  const registerText = await files.read(APP_REGISTER);
  const register = registerText === null ? new Map() : parseAppRegister(registerText, `${APP_REGISTER} on \`${files.branch}\``);
  // The logins the gate compares, from the default branch's register; the gate's own, read where
  // it runs, only for a role the register doesn't list.
  const logins = {
    implementer: register.get('Implementer') ?? IMPLEMENTER_LOGIN,
    reviewer: register.get('Reviewer') ?? REVIEWER_LOGIN,
    merger: register.get('Merger') ?? MERGER_LOGIN,
  };
  const escalations = await escalationsAt(files, reader, repo);
  const { pr, node, changed } = await readPullRequest(reader, repo, number, { merger: logins.merger });
  const gate = { escalations, now, implementer: logins.implementer, reviewer: logins.reviewer };
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

  const failed = failures();
  if (failed.length) throw new IncompleteRead(`pull request #${number}`, failed);
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
 * or failed, the review-recovery lane reads an approval on its head, and, for a brief, the brief
 * guard finds no open decision. Nothing else is asked of it.
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
    why: lacks.length ? `a person's to merge, not ready: ${why.join('; ')}` : "a person's to merge: its checks are green, the Reviewer approved its head" + (decisions ? ', and its brief has no open decision' : ''),
  };
}
