// Which live artifacts still carry an old spelling of a protocol string (#53).
//
// `lib/protocol-spellings.mjs` keeps reading the old spellings until this says none are
// left, so the day they are dropped is measured, not assumed. Run it in the adopter's
// checkout, with `gh` authenticated for its repository:
//
//   GITHUB_REPOSITORY=<owner>/<repo> node "$KANON/scripts/protocol-census.mjs"
//
// It asks every question a reader of an old spelling asks (#157), so that an exit 0 means
// no reader would misread anything once the spelling is dropped. Each read, and its reader:
//   · the adopter's caller workflows, by their `name:` (`lane-check`'s caller names);
//   · every open pull request: all its comments (the Merger's markers and escalation
//     header, `merge-gate.mjs`), its checks (the merge gate's caller names, on runs
//     already made), the failed runs on its head (the retry breadcrumbs the review,
//     revise and brief-revise recoveries read) and the runs its rebase-lane markers name
//     (the rebase lane's retry, whose run is `main`'s, not the head's);
//   · every pull request merged in the Merger's follow-up window: its comments (the
//     marker `followQueueMerges` reads back on a merged pull request);
//   · every issue, open or closed: its body (the Lead's adoption sentence, which the
//     adopt arm reads on whichever issue a brief names);
//   · every open issue labelled for a split: the pull requests in ANY state on each old
//     spelling of its split branch (`splitEvidenceRead` in `lead-reconcile.mjs`, which
//     reads a closed split pull request whose branch is gone);
//   · every branch (the split branch, `split-lineage.mjs`'s gate).
//
// Exit 0 when nothing carries an old spelling, 1 when something does (each one printed),
// and 2 when a read failed: an unread artifact is never counted as clean.
//
// NODE BUILTINS ONLY, like the lanes' other scripts.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LEGACY } from './lib/protocol-spellings.mjs';
import { SPLIT_LABEL } from './split-lineage.mjs';
import { trustedSearchSync } from './lib/search.mjs';

// Two facts of readers this script cannot import: `merge-gate.mjs` and `rebase-lane.mjs` read
// the App register when loaded, which a checkout from before the two Apps lacks. A test holds
// each to its reader's.

/** `FOLLOW_UP_MS` in `merge-gate.mjs`: how long after a merge `followQueueMerges` reads the PR. */
export const FOLLOW_UP_MS = 24 * 60 * 60 * 1000;

/** The run ids the rebase lane's `runMarker`s name for this head (`attemptsIn` in `rebase-lane.mjs`). */
export const rebaseRunIds = (/** @type {unknown[]} */ bodies, /** @type {string} */ sha) => {
  const re = new RegExp(`<!-- rebase-lane:run:${String(sha).slice(0, 12)}:(\\d+) -->`, 'g');
  return [...new Set((bodies ?? []).flatMap((b) => [...String(b ?? '').matchAll(re)].map((m) => String(m[1]))))];
};

/**
 * Every old spelling a live artifact carries. PURE.
 *
 * @param {{callers?: {file: string, name: string}[], prs?: any[], mergedPrs?: any[], issues?: any[], branches?: string[],
 *          failedJobs?: Record<string, any[]>, splitPrs?: Record<string, any[]>}} world `failedJobs` is keyed
 *          by PR number: the jobs of every failed run on that PR's head and of every run its rebase-lane
 *          markers name. `mergedPrs` are the PRs merged in the Merger's follow-up window, with their
 *          comments. `splitPrs` is keyed by issue number: the PRs in any state on its split branches.
 * @returns {{protocol: string, where: string, spelling: string}[]}
 */
export function censusOf({ callers = [], prs = [], mergedPrs = [], issues = [], branches = [], failedJobs = {}, splitPrs = {} }) {
  /** @type {{protocol: string, where: string, spelling: string}[]} */
  const found = [];
  /** @param {string} protocol @param {string} where @param {string} spelling */
  const add = (protocol, where, spelling) => found.push({ protocol, where, spelling });
  const legacyWorkflows = [...LEGACY.selfChecks, ...LEGACY.reviewEventChecks.map((r) => r.workflow)];

  for (const c of callers) {
    if (legacyWorkflows.includes(c.name)) add('caller name', c.file, c.name);
  }
  /** @param {any} pr @param {string} at */
  const comments = (pr, at) => {
    for (const c of pr.comments ?? []) {
      const body = String(c?.body ?? '');
      for (const m of LEGACY.mergerMarkers) if (body.includes(`<!-- ${m}:`)) add('merger marker', at, `<!-- ${m}:…`);
      for (const h of LEGACY.escalationHeaders) if (body.includes(h)) add('escalation header', at, h);
    }
  };
  for (const pr of mergedPrs) comments(pr, `PR #${pr.number} (merged)`);
  for (const pr of prs) {
    const at = `PR #${pr.number}`;
    comments(pr, at);
    for (const check of pr.statusCheckRollup ?? []) {
      if (legacyWorkflows.includes(check?.workflowName)) add('caller name', `${at} (a check on its head)`, check.workflowName);
    }
    for (const p of LEGACY.splitPrefixes) {
      if (String(pr.headRefName ?? '').startsWith(p)) add('split branch', at, pr.headRefName);
    }
    for (const job of failedJobs[pr.number] ?? []) {
      for (const s of job?.steps ?? []) {
        if (LEGACY.retrySteps.includes(s?.name) && s?.conclusion === 'success') {
          add('retry breadcrumb', `${at} (job ${job.name})`, s.name);
        }
      }
    }
  }
  for (const i of issues) {
    for (const by of LEGACY.adoptedBy) {
      if (new RegExp(`Adopted into project #\\d+ by ${by}\\b`).test(String(i.body ?? ''))) {
        add('adoption note', `issue #${i.number}`, `… by ${by}`);
      }
    }
  }
  // An OPEN one is the open pull request above, already counted; a closed or merged one is
  // what `splitEvidenceRead` reads and nothing else here sees, its branch often deleted.
  for (const [issue, list] of Object.entries(splitPrs)) {
    for (const pr of list ?? []) {
      if (pr?.state === 'OPEN') continue;
      for (const p of LEGACY.splitPrefixes) {
        if (String(pr?.headRefName ?? '').startsWith(p)) {
          add('split branch', `PR #${pr.number} (${String(pr.state).toLowerCase()}, a split of issue #${issue})`, pr.headRefName);
        }
      }
    }
  }
  for (const b of branches) {
    for (const p of LEGACY.splitPrefixes) if (b.startsWith(p)) add('split branch', `branch ${b}`, b);
  }
  return found;
}

/** The adopter's caller workflows and their `name:`, from the working directory. */
export function callersIn(dir = '.github/workflows') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) => {
      const m = /^name:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, f), 'utf8'));
      return m ? [{ file: join(dir, f), name: String(m[1]).replace(/^(['"])(.*)\1$/, '$2') }] : [];
    });
}

/** Whether a `gh` failure was a 404: a run that no longer exists, which no reader can read either. */
const notFound = (/** @type {any} */ e) => /HTTP 404|Not Found/.test(`${e?.message ?? ''} ${e?.stderr ?? ''}`);

/**
 * Everything `censusOf` reads, from GitHub. Throws on any failed read: an unread artifact is
 * never counted as clean. The one exception is a run a rebase-lane marker names that no longer
 * exists, which the rebase lane cannot read either, so it cannot misread it.
 *
 * @param {string} repo
 * @param {{json?: (args: string[]) => any, now?: number, callers?: () => {file: string, name: string}[]}} [io]
 */
export function readWorld(repo, {
  json = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })),
  now = Date.now(),
  callers = callersIn,
} = {}) {
  // Every comment, paginated, as the merge gate reads them: `gh pr list` returns only a page.
  const commentsOf = (/** @type {number} */ n) =>
    json(['api', '--paginate', '--slurp', `repos/${repo}/issues/${n}/comments?per_page=100`]).flat()
      .map((/** @type {any} */ c) => ({ body: c?.body ?? '' }));
  const jobsOf = (/** @type {number|string} */ runId) => json(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]).jobs ?? [];

  const prs = json(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '1000',
    '--json', 'number,headRefName,headRefOid,statusCheckRollup']).map((/** @type {any} */ pr) => ({ ...pr, comments: commentsOf(pr.number) }));
  // The window and the query are `followQueueMerges`' own.
  const since = now - FOLLOW_UP_MS;
  // Settled before the census counts it: search can answer nothing for a query that has matches
  // (kanon#1322), and an empty answer would print a census with no merged pull request in it.
  const mergedPrs = trustedSearchSync(() => json(['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${new Date(since).toISOString()}`,
    '--limit', '100', '--json', 'number,mergedAt']), { what: 'the merged pull requests', size: (/** @type {any} */ a) => a?.length, partial: () => false })
    .filter((/** @type {any} */ pr) => Date.parse(pr?.mergedAt) >= since)
    .map((/** @type {any} */ pr) => ({ ...pr, comments: commentsOf(pr.number) }));
  // Open and closed: the adopt arm edits whichever issue a brief names. The REST listing
  // carries pull requests too, which no adoption reader reads.
  const issues = json(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=all&per_page=100`]).flat()
    .filter((/** @type {any} */ i) => !i?.pull_request)
    .map((/** @type {any} */ i) => ({ number: i.number, body: i.body ?? '', state: String(i.state ?? '').toUpperCase(),
      labels: (i.labels ?? []).map((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.name)) }));
  const branches = json(['api', '--paginate', '--slurp', `repos/${repo}/branches?per_page=100`]).flat().map((/** @type {any} */ b) => b.name);
  /** @type {Record<string, any[]>} */
  const splitPrs = {};
  for (const i of issues.filter((/** @type {any} */ x) => x.state === 'OPEN' && x.labels.includes(SPLIT_LABEL))) {
    // `splitEvidenceRead`'s own query, on each old spelling of the branch: `--state all`.
    splitPrs[i.number] = LEGACY.splitPrefixes.flatMap((p) => json(['pr', 'list', '--repo', repo, '--state', 'all', '--head', `${p}${i.number}`,
      '--json', 'number,state,headRefName']) ?? []);
  }
  /** @type {Record<string, any[]>} */
  const failedJobs = {};
  for (const pr of prs) {
    const runs = json(['api', `repos/${repo}/actions/runs?head_sha=${pr.headRefOid}&status=failure&per_page=100`]).workflow_runs ?? [];
    const jobs = runs.flatMap((/** @type {any} */ r) => jobsOf(r.id));
    // The rebase lane's attempts, by the run ids its markers name for this head. That run is
    // `main`'s, so the head's failed runs above miss it. Every job of it is read: the lane
    // reads only this PR's, and another PR's job is that PR's own marker's to name.
    for (const runId of rebaseRunIds(pr.comments.map((/** @type {any} */ c) => c.body), pr.headRefOid)) {
      try {
        jobs.push(...jobsOf(runId));
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    }
    failedJobs[pr.number] = jobs;
  }
  return { callers: callers(), prs, mergedPrs, issues, branches, failedJobs, splitPrs };
}

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(String(process.argv[1]))).href; } catch { return false; }
})();
if (IS_CLI) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('protocol-census: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  let found;
  try {
    found = censusOf(readWorld(repo));
  } catch (e) {
    console.error(`protocol-census: a read failed, so nothing is known: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  for (const f of found) console.log(`${f.protocol}: ${f.where} carries ${f.spelling}`);
  console.log(found.length
    ? `${found.length} live artifact(s) still carry an old spelling; the readers must keep them.`
    : 'No live artifact carries an old spelling; the readers can drop them.');
  process.exit(found.length ? 1 : 0);
}
