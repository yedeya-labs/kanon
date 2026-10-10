// The collector's work-item step (plan 0003 §3.1, §4, M4, kanon#658): one work-item row per pull
// request closed in the sweep's span, and the row again of an earlier item whose story changed,
// handed to the collector, which sends them to the store with the run rows. The store keys a work
// item by its PR number alone, `<key>#work` / `pr-<n>` (plan 0002 §4), so a row sent again
// overwrites the one before.
//
// THE ROWS ARE THE DRY RUN'S. Every row is built by `deriveRows` (`scripts/metrics/derive.mjs`),
// the function `kanon metrics dry-run` builds its rows with, from pull requests read by the dry
// run's own reader (`cli/metrics-read.mjs`), with the declarations it reads from the default
// branch. What this step adds is only WHICH pull requests it derives, and the Kanon version.
//
// WHICH PULL REQUESTS (§3.1, §3.5):
//   1. every PR closed in the span, merged or not. A PR closed, reopened and closed again is one
//      item: it is derived whole on its last close, and its key is its number (§3.1);
//   2. an earlier item a PR merged in the span REVERTS or FIXES (§3.5): the PR's revert targets
//      (`This reverts commit <sha>.`, `Reverts <repo>#<n>`) and, for a PR closing a `bug` issue,
//      the PRs its body, its comments, and its bug issues' bodies and comments name, read again
//      and kept when the detectors confirm the link;
//   3. a PR a Reviewer follow-up closed in the span cross-references, for any reason it closed
//      (§3.1), kept when its own timeline holds the follow-up's cross-reference.
// An earlier item is derived again only when it is closed, and closed less than 13 months ago,
// less a day's margin, inside the store's `closed_at` window (§3.1, plan 0002 §4): a row the
// store refuses would turn the collector red for nothing. A PR still open has no row yet, and
// the row it gets when it closes reads the follow-up's fate then.
//
// A REWRITE IS ONE WHOLE DERIVATION (§3.1). An earlier item's later reverts and fixes are found
// from ITS side too, and read for the detectors beside the span's PRs: the PRs that
// cross-reference it; the PRs that close a `bug` issue that cross-references it, or whose
// "Introduced by" names it by a bare number, which GitHub doesn't link; and the PRs of the commits
// that reference it and revert its merge commit, which is how a `git revert` names it (kanon#672).
// So a row rewritten because a follow-up closed keeps the revert or the fix an earlier sweep found.
// A revert whose commit names neither the item's number nor its merge commit, nor its body the
// Revert button's `Reverts <repo>#<n>`, is found only by the sweep it merges in.
//
// WHAT A REWRITE COSTS. Only when the span has an earlier merged item: ONE listing a sweep of the
// `bug` issues updated since the oldest such item merged (a call per 100 of them), and for each
// item, a call per 100 commits that reference it, a call per bug issue linked to it, and a whole
// read of each PR so found, each PR read once a sweep. A commit that names the item without
// reverting it, and a bug issue introduced by another PR, cost no read.
//
// THE KANON VERSION (§3.3) is the tag the collector's own caller pins, read from that file at the
// merge commit, or, for a PR closed unmerged, at the default branch's head when it closed. A file
// that isn't there, or doesn't pin a release, leaves the field out, as does a read that fails.
//
// NOTHING READ HERE LEAVES IN A ROW BUT WHAT `workItemRow` PUTS THERE, and the schema refuses any
// field outside its list (ADR 0007, `K-OBS-16`). Logs hold counts and PR numbers, never a title,
// a login or a path. A read that fails turns the sweep red, as an unreadable artifact does, and
// the next sweep covers the same span again.

import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

import { addMonths, RETENTION_MONTHS } from '../infra/telemetry/function/index.mjs';
import { declarations } from '../cli/metrics.mjs';
import { issueClosers, readPullRequest, readPullRequests, referencingCommits } from '../cli/metrics-read.mjs';
import { revertTargets } from './lib/reverts.mjs';
import { toDetectorPr } from './metrics/adapter.mjs';
import { BUG_LABEL, codeAreaTest, fixesOf, introducedBy, revertsOf, sameSha } from './metrics/detectors.mjs';
import { deriveRows } from './metrics/derive.mjs';
import { FOLLOWUP_LABELS } from './metrics/followups.mjs';
import { isReleasePr } from './metrics/release.mjs';

const DAY = 86_400_000;

/**
 * @typedef {import('../cli/metrics-read.mjs').Gh} Gh
 * @typedef {import('./metrics/types.mjs').PullRequest} PullRequest
 * @typedef {{ row: Record<string, unknown>, where: string }} Sendable
 * @typedef {{ rows: Sendable[], failures: string[], warnings: string[], closed: number, rewritten: number }} StepResult
 */

/** The first line of an error's message. @param {unknown} e */
const firstLine = (e) => String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0];

/** A time as the store's rows have it, to the second. @param {number} ms */
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The issue and PR numbers of `repo` a text names: `#N`, `<repo>#N`, or a link to one. Another
 * repository's `owner/name#N` names nothing here. Used only to find candidates, which the
 * detectors or the item's own timeline then confirm.
 * @param {string | null | undefined} text @param {string} repo `owner/name`
 * @returns {number[]}
 */
export function mentionsOf(text, repo) {
  const t = String(text ?? '');
  const r = escapeRe(repo);
  const found = new Set([
    ...[...t.matchAll(/(?<![\w/&#.-])#(\d{1,9})\b/g)].map((m) => Number(m[1])),
    ...[...t.matchAll(new RegExp(`(?<![\\w/.-])${r}#(\\d{1,9})\\b`, 'gi'))].map((m) => Number(m[1])),
    ...[...t.matchAll(new RegExp(`https://github\\.com/${r}/(?:pull|issues)/(\\d{1,9})\\b`, 'gi'))].map((m) => Number(m[1])),
  ]);
  return [...found].sort((a, b) => a - b);
}

/** The release a caller pins Kanon's collector at, without its `v`, or undefined. @param {string | null} text */
export function pinOf(text) {
  return /yedeya-labs\/kanon\/\.github\/workflows\/telemetry-collect\.yml@v(\d+\.\d+\.\d+)\s*$/m.exec(text ?? '')?.[1];
}

/** `gh`, asynchronously, as the metrics reader takes it. @type {Gh} */
export const ghAsync = (args) =>
  new Promise((done) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ status: null, stdout, stderr: String(e.message) }));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });

/**
 * One REST read. A paginated one is every page's items, flattened.
 * @param {Gh} gh @param {string} path @param {{ paginate?: boolean }} [opts]
 * @returns {Promise<any>}
 */
async function rest(gh, path, { paginate = false } = {}) {
  const r = await gh(['api', ...(paginate ? ['--paginate', '--slurp'] : []), path]);
  if (r.status !== 0) throw new Error(`GitHub answered: ${(r.stderr.trim() || `gh exited ${r.status}`).split('\n')[0]}`);
  const doc = JSON.parse(r.stdout || 'null');
  return paginate && Array.isArray(doc) ? doc.flat() : doc;
}

/**
 * The work-item step. Reads GitHub with the collector's token; sends nothing itself.
 * @param {{
 *   repo: string, since: number, now: number, gh: Gh,
 *   sleep?: (ms: number) => Promise<void>, log?: (line: string) => void,
 *   callerFile?: string | null,
 *   sizes?: import('../cli/metrics-read.mjs').ReadSizes,
 * }} opts
 * @returns {Promise<StepResult>}
 */
export async function workItemStep({ repo, since, now, gh, sleep = (ms) => wait(ms).then(() => undefined), log = () => {}, callerFile = null, sizes }) {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const warnings = [];
  const done = (/** @type {Sendable[]} */ rows = [], closed = 0, rewritten = 0) => ({ rows, failures, warnings, closed, rewritten });
  const readDeps = { gh, sleep, progress: (/** @type {string} */ line) => log(`work items: ${line}`) };
  const sameRepo = (/** @type {string | undefined} */ r) => !!r && r.toLowerCase() === repo.toLowerCase();

  // The adopter's declarations, from the default branch, as the dry run reads them without --dir.
  /** @type {import('./metrics/types.mjs').Declarations} */
  let decl;
  try {
    const deps = /** @type {any} */ ({ gh, err: (/** @type {string} */ line) => log(`work items: ${line}`), readFile: () => null });
    decl = (await declarations(deps, repo, null)).decl;
  } catch (e) {
    failures.push(`work items: the declarations could not be read (${firstLine(e)})`);
    return done();
  }

  // 1. Every PR closed in the span.
  /** @type {Awaited<ReturnType<typeof readPullRequests>>} */
  let read;
  try {
    read = await readPullRequests(readDeps, repo, { since: new Date(since), until: null }, sizes);
  } catch (e) {
    failures.push(`work items: the pull requests closed in the span could not be read (${firstLine(e)})`);
    return done();
  }
  /** @param {number} n @param {'truncated' | 'unreadable'} reason */
  const leftOut = (n, reason) => {
    if (reason === 'unreadable') failures.push(`work item PR #${n}: one of its lists could not be read; the next sweep reads it again`);
    else warnings.push(`work item PR #${n}: GitHub cuts one of its lists short, so it has no work-item row (plan 0003 §3.1)`);
  };
  for (const l of read.leftOut) if (l.reason !== 'open') leftOut(l.pr, l.reason);
  const closed = read.prs;
  /** @type {Map<number, PullRequest>} */
  const known = new Map(closed.map((p) => [p.number, p]));
  /** @type {Map<number, PullRequest | null>} */
  const cache = new Map();
  /** @param {number} n */
  const readOne = async (n) => {
    const had = known.get(n) ?? cache.get(n);
    if (had !== undefined) return had;
    const res = await readPullRequest(readDeps, repo, n, sizes);
    const pr = 'pr' in res ? res.pr : null;
    if ('leftOut' in res) leftOut(n, res.leftOut);
    cache.set(n, pr);
    return pr;
  };

  // 2 and 3. The earlier items the span's merges and follow-up closes may have changed.
  /** @type {Set<number>} */
  const candidates = new Set();
  /** @type {Set<number>} */
  const followups = new Set();
  const triggers = closed.filter((p) => p.merged_at && !isReleasePr(p, decl.register));
  try {
    for (const r of triggers) {
      for (const text of [r.body, ...(r.commits ?? []).map((c) => c.message)]) {
        const t = revertTargets(text ?? '', repo);
        for (const n of t.prs) candidates.add(n);
        for (const sha of t.shas) for (const p of await rest(gh, `repos/${repo}/commits/${sha}/pulls`)) if (typeof p?.number === 'number') candidates.add(p.number);
      }
      const bugs = (r.closing_issues ?? []).filter((i) => i.labels.includes(BUG_LABEL));
      if (bugs.length === 0) continue;
      const texts = [r.body, ...(await rest(gh, `repos/${repo}/issues/${r.number}/comments?per_page=100`, { paginate: true })).map((/** @type {any} */ c) => c.body)];
      for (const b of bugs) {
        for (const n of introducedBy(b.body, repo)) candidates.add(n);
        texts.push(b.body ?? '', ...(await rest(gh, `repos/${repo}/issues/${b.number}/comments?per_page=100`, { paginate: true })).map((/** @type {any} */ c) => c.body));
      }
      for (const t of texts) for (const n of mentionsOf(t, repo)) candidates.add(n);
    }
    const labels = FOLLOWUP_LABELS.map(encodeURIComponent).join(',');
    const listed = await rest(gh, `repos/${repo}/issues?state=closed&labels=${labels}&since=${iso(since)}&per_page=100`, { paginate: true });
    for (const f of listed) {
      if (f?.pull_request || typeof f?.closed_at !== 'string' || Date.parse(f.closed_at) < since) continue;
      followups.add(f.number);
      const comments = await rest(gh, `repos/${repo}/issues/${f.number}/comments?per_page=100`, { paginate: true });
      for (const t of [f.body, ...comments.map((/** @type {any} */ c) => c.body)]) for (const n of mentionsOf(t, repo)) candidates.add(n);
    }
  } catch (e) {
    failures.push(`work items: the span's reverts, fixes and follow-ups could not be read (${firstLine(e)})`);
    return done();
  }

  const floor = addMonths(now, -RETENTION_MONTHS) + DAY;
  const isCode = codeAreaTest({ codeAreas: decl.codeAreas, escalationFile: decl.escalationFile });
  /** @type {import('./metrics/detectors.mjs').DetectorPr[]} */
  const later = [];
  for (const r of triggers) {
    try {
      later.push(toDetectorPr(r));
    } catch {
      // `deriveRows` reports it as unreadable below.
    }
  }
  /** @type {PullRequest[]} */
  const earlier = [];
  /** @type {PullRequest[]} */
  const context = [];
  try {
    for (const n of [...candidates].sort((a, b) => a - b)) {
      if (known.has(n)) continue;
      const pr = await readOne(n);
      // Open: no row yet (§3.1). Past the window: its row has expired. A release PR has none.
      if (!pr || pr.state !== 'closed' || !pr.closed_at || Date.parse(pr.closed_at) < floor || isReleasePr(pr, decl.register)) continue;
      const named = (pr.timeline ?? []).some((ev) => ev.event === 'cross-referenced' && ev.source?.type === 'issue'
        && sameRepo(ev.source.repository) && followups.has(ev.source.number));
      let linked = false;
      if (pr.merged_at) {
        try {
          const item = toDetectorPr(pr);
          linked = revertsOf(item, later, { repo }).length > 0 || fixesOf(item, later, { repo, isCode }).length > 0;
        } catch {
          // A merged item the detectors can't judge is derived only if a follow-up names it.
        }
      }
      if (named || linked) earlier.push(pr);
    }
    // The earlier items' own later PRs, for a whole derivation: the PRs that cross-reference each,
    // the PRs that close a `bug` issue that does (§3.5's conditions 1 and 2), and the two links
    // that leave no cross-reference (kanon#672): a revert's commit, and a bare "Introduced by".
    const mergedEarlier = earlier.filter((p) => p.merged_at);
    const oldest = Math.min(...mergedEarlier.map((p) => Date.parse(/** @type {string} */ (p.merged_at))));
    /** @type {any[]} */
    const bugs = mergedEarlier.length === 0 ? [] : await rest(gh, `repos/${repo}/issues?state=all&labels=${BUG_LABEL}&since=${iso(oldest)}&per_page=100`, { paginate: true });
    for (const item of mergedEarlier) {
      /** @type {Set<number>} */
      const linked = new Set();
      /** @type {Set<number>} */
      const issues = new Set();
      for (const ev of item.timeline ?? []) {
        const s = ev.source;
        if (ev.event !== 'cross-referenced' || !s || !sameRepo(s.repository)) continue;
        if (s.type === 'pull_request') linked.add(s.number);
        else if (!s.labels || s.labels.includes(BUG_LABEL)) issues.add(s.number);
      }
      // A bug form's "Introduced by" holding a bare number names the item without linking it.
      for (const b of bugs) if (!b?.pull_request && typeof b?.number === 'number' && introducedBy(b.body, repo).includes(item.number)) issues.add(b.number);
      for (const n of [...issues].sort((a, b) => a - b)) for (const c of await issueClosers(readDeps, repo, n)) linked.add(c);
      // A `git revert` of the item names it only in its commit, whose message quotes the item's
      // subject and so its `(#n)`: GitHub's `referenced` event. Only a commit that reverts the
      // item's merge commit is followed to its PR.
      const sha = item.merge_commit_sha;
      if (sha) {
        for (const c of await referencingCommits(readDeps, repo, item.number)) {
          if (revertTargets(c.message, repo).shas.some((t) => sameSha(t, sha))) for (const n of c.prs) linked.add(n);
        }
      }
      for (const n of [...linked].sort((a, b) => a - b)) {
        if (n === item.number) continue;
        const pr = await readOne(n);
        if (pr?.merged_at && Date.parse(pr.merged_at) > Date.parse(/** @type {string} */ (item.merged_at)) && !context.includes(pr)) context.push(pr);
      }
    }
  } catch (e) {
    failures.push(`work items: an earlier item or its later pull requests could not be read (${firstLine(e)})`);
    return done();
  }

  // The Kanon version each item ran under: the caller's pin at its merge, or at the default
  // branch's head when it closed unmerged.
  /** @type {Map<string, string | undefined>} */
  const pins = new Map();
  /** @type {Map<number, string | undefined>} */
  const versions = new Map();
  let unpinned = 0;
  for (const pr of [...closed, ...earlier]) {
    if (!callerFile) break;
    try {
      const ref = pr.merged_at ? pr.merge_commit_sha : (await rest(gh, `repos/${repo}/commits?until=${iso(Date.parse(/** @type {string} */ (pr.closed_at)))}&per_page=1`))?.[0]?.sha;
      if (typeof ref !== 'string' || !ref) throw new Error('no commit');
      if (!pins.has(ref)) {
        const r = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/.github/workflows/${encodeURIComponent(callerFile)}?ref=${ref}`]);
        if (r.status !== 0 && !/HTTP 404|Not Found/i.test(r.stderr)) throw new Error('unreadable');
        pins.set(ref, r.status === 0 ? pinOf(r.stdout) : undefined);
      }
      versions.set(pr.number, pins.get(ref));
    } catch {
      unpinned += 1;
    }
  }
  if (unpinned) log(`work items: ${unpinned} item(s) leave kanon_version out: the caller's pin could not be read at their commit`);

  const derived = deriveRows([...closed, ...earlier], {
    declarations: decl, repo, recordedAt: iso(now), kanonVersion: (pr) => versions.get(pr.number), context,
  });
  for (const l of derived.leftOut) if (l.reason === 'unreadable') failures.push(`work item PR #${l.pr}: merged, but a list the detectors read is missing`);
  for (const i of derived.invalid) failures.push(`work item PR #${i.pr}: fails the schema (${i.fields.join(', ')})`);
  const rewritten = derived.rows.filter((r) => !known.has(/** @type {number} */ (r.pr_number))).length;
  log(`work items: ${closed.length} pull request(s) closed in the span, ${earlier.length} earlier item(s) whose story changed; ${derived.rows.length} row(s) to send`);
  return done(derived.rows.map((row) => ({ row, where: `work item PR #${row.pr_number}` })), closed.length, rewritten);
}
