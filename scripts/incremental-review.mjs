#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// QA pipeline — scope a re-review to what changed since the last reviewed commit (RA-2455).
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Re-review rounds were 55% of reviewer spend (2026-09-04 → 09-25: 559 runs over 223
// PRs, $623 of the $1,129 on rounds 2+). Every round re-read the whole diff, although
// most of it had already been judged at the commit the previous verdict read. So when
// a prior verdict exists at commit X and HEAD still builds on X, the reviewer is handed
// `X..HEAD` plus its own prior findings, and the full diff becomes context.
//
// ── WHICH X, AND WHY ONLY THE STAMP ─────────────────────────────────────────
// X is the RA-1680 reviewed-sha STAMP on the Reviewer's most recent verdict, never `commit_id`.
// `commit_id` is what GitHub filed the review under — the head AT SUBMISSION — and a push
// landing mid-review moves it to a commit the run never read (PR RA-2462's first verdict
// is filed under `dca7dbc` and stamped `b4cc21e`). Diffing from a `commit_id` like that
// would silently drop the commits between what was read and what it was filed under,
// which is the one failure an incremental review must not have. So an UNSTAMPED latest
// verdict — a manual session, or one from the RA-2281 window when the stamp's write failed
// — means a full review, not a fallback to `commit_id`. Full is always safe; it is only
// more expensive.
//
// ── WHEN X..HEAD IS NOT "WHAT THE AUTHOR CHANGED" (kanon#525) ───────────────
// Two shapes make X..HEAD wrong while the author's own change is still small:
//   · The base was MERGED into the branch: X is still an ancestor, but the merge-base
//     moved, so X..HEAD carries every base commit the merge brought in.
//   · The branch was REBASED (or force-pushed): every commit is rewritten, so X is no
//     longer in HEAD's history even when nothing conflicted.
// Both used to be full reviews. They are now incremental against a different "from":
// the tree R that re-applies the change the verdict READ (B..X, B being X's merge-base
// with the base branch) to the base the head now builds on (B'), by a clean three-way
// merge `merge-tree X B'` whose merge-base is B. The Reviewer is handed `git diff R HEAD`.
//
// WHY THAT CANNOT CARRY A VERDICT ACROSS A CHANGE TO THE PR'S OWN DIFF. R is computed from
// X (the commit the verdict read) and B' (a base-branch commit), and from nothing the
// PR has written since X. So every byte by which the head's tree differs from R, a new
// commit, a conflict resolution, an "evil" merge, a hunk a rebase dropped or rewrote, is
// in `git diff R HEAD`. An EMPTY diff means the head's tree IS the reviewed change on the
// newer base, and the PR's diff against its base is the reviewed one re-applied cleanly.
// Nothing is approved without a run: the Reviewer still reads that diff (possibly empty),
// the prior findings and where the base moved under the PR's files, and posts a verdict on
// the head like any other round. The merge-tree runs with no working tree and with
// attributes read from B' (the base), so the PR's own `.gitattributes` (`merge=union`)
// cannot turn a conflict into a "clean" R (tests/library/incremental-review.test.ts).
//
// Still full reviews:
//   · Re-applying B..X to B' CONFLICTS: a resolution can't be told from a new change.
//   · X's or the head's merge-base with the base branch is not unique (criss-cross), or
//     B' does not descend from B (the base was rewritten, or the PR retargeted).
//   · X is absent from the clone and can't be fetched by its SHA.
//   · X == HEAD — a same-commit re-review is RA-1351's explicit human request, which asks
//     for a fresh look, not an empty diff.
//
// The decision is `decideScope`, with git injected so it is testable without a repo;
// `gitFacts` is the real implementation, exercised against real repos in
// tests/library/incremental-review.test.ts (rebase, merge-from-base, force-push, conflicts).
//
// ── HOW THE WORKFLOW RUNS THIS ──────────────────────────────────────────────
// Kanon's review lane runs this file from the action cache, at the Kanon tag its caller
// pins (plan 0001 §3), never from the PR's checkout: a PR must not supply the logic that
// decides how much of it is read. The reference adopter extracted it and its imports from
// the base branch for the same reason; with the library in Kanon there is nothing left to
// extract. It runs before any PR code executes, and never fails the job: any error is a
// full review.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appLogin } from './app-register.mjs';
import { asRole } from './lib/role-marker.mjs';
import { readTrailer } from './review-trailer.mjs';

// EXACT login, not a prefix: the review supplies both X and the "prior findings" text,
// so an account merely NAMED like the reviewer must not be able to scope a run.
//
// WHOSE LOGIN (RA-2701). The reviewer's slug is the App register's `Reviewer` row, not a
// constant here. The default reads the working tree's register, which is right for the
// unit tier and for any checkout of `main`. It is NOT right in CI: the workflow runs
// this file against the PR's checkout, where the working tree's register is the PR's —
// and a PR must not choose whose verdicts scope its own review. So `main` takes the
// register's path as `--register` (the workflow writes the default branch's copy there,
// `K-MERGE-17`) and passes the login to every function below explicitly.
const reviewerLogins = (reviewer) => new Set([`${reviewer}[bot]`, reviewer]);
const VERDICTS = new Set(['APPROVED', 'CHANGES_REQUESTED']);

/**
 * The Reviewer's real verdicts (APPROVE / REQUEST_CHANGES — a `COMMENT` is not a verdict,
 * RA-378), oldest first.
 *
 * @param {Array<{id?: number, user?: {login?: string}, state?: string, submitted_at?: string, body?: string, commit_id?: string}>} reviews
 */
export function reviewerVerdicts(reviews, reviewer = appLogin('Reviewer')) {
  const logins = reviewerLogins(reviewer);
  // The Reviewer's exact login and, from L4, its role marker (plan 0005 §3.3).
  const mine = (reviews ?? []).filter(
    (r) => logins.has(String(r?.user?.login ?? ''))
      && asRole('Reviewer', { login: r?.user?.login, expected: reviewer, body: r?.body })
      && VERDICTS.has(r?.state ?? ''),
  );
  return mine.sort((a, b) =>
    String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')) || (a.id ?? 0) - (b.id ?? 0),
  );
}

/** The Reviewer's most recent real verdict, or null. */
export const latestVerdict = (reviews, reviewer = appLogin('Reviewer')) => reviewerVerdicts(reviews, reviewer).at(-1) ?? null;

/**
 * @typedef {{
 *   resolve: (sha: string) => string|null,
 *   isAncestor: (a: string, b: string) => boolean,
 *   mergeBases: (sha: string) => string[],
 *   replay: (sha: string, onto: string) => string|null,
 *   fetch?: (sha: string) => void,
 * }} GitFacts
 *
 * `replay(X, B')` is the tree of a clean three-way merge of X and B', or null when it conflicts.
 * `decideScope` calls it only when B, X's one merge-base with the base branch, is B' or an
 * ancestor of it. Then B is also the one merge-base of X and B' (every common ancestor of X
 * and B' is one of X and the base tip, so is below B, and B is one), and the merge is B..X
 * re-applied to B'.
 *
 * @typedef {'descends'|'base-merged'|'rewritten'} Kind
 * @typedef {{mode: 'full', reason: string}
 *   | {mode: 'incremental', kind: Kind, reason: string, priorSha: string, review: object, from: string, baseSha?: string, priorBaseSha?: string}} Scope
 *
 * `from` is what the incremental diff starts at: X itself when the head descends from X with
 * an unchanged merge-base, else the tree of X's change re-applied to the head's base.
 */

const short = (sha) => String(sha).slice(0, 7);

/**
 * Decide whether this run can review incrementally.
 *
 * @param {{reviews: object[], headSha: string, git: GitFacts, reviewer?: string}} input
 * @returns {Scope}
 */
export function decideScope({ reviews, headSha, git, reviewer = appLogin('Reviewer') }) {
  const full = (reason) => ({ mode: /** @type {const} */ ('full'), reason });
  const review = latestVerdict(reviews, reviewer);
  if (!review) return full('no prior verdict by the Reviewer on this PR — first review');

  const stamped = readTrailer(review).reviewedSha;
  if (!stamped) {
    return full(
      `the Reviewer's latest verdict (review ${review.id}) carries no reviewed-sha stamp, so what it read is unknown — \`commit_id\` may name a commit it never saw (RA-1680/RA-2281)`,
    );
  }

  const head = git.resolve(headSha);
  if (!head) return full(`the head ${short(headSha)} is not in the clone`);
  let prior = git.resolve(stamped);
  // A rebase or force-push leaves X out of the head's history, so the clone's fetch of the
  // head never brought it. GitHub still serves it by its SHA until it is collected.
  if (!prior && git.fetch) {
    try { git.fetch(stamped); } catch { /* absent stays absent */ }
    prior = git.resolve(stamped);
  }
  if (!prior) {
    return full(`the last reviewed commit ${short(stamped)} is not in the clone and could not be fetched — force-pushed away and collected`);
  }
  if (prior === head) {
    return full(`the head ${short(head)} is the commit last reviewed — a same-commit re-review is an explicit request for a fresh look (RA-1351)`);
  }

  const before = git.mergeBases(prior);
  const after = git.mergeBases(head);
  if (!before.length || !after.length) {
    return full('could not compute the merge-base with the base branch, so whether the base moved is unknown');
  }
  const descends = git.isAncestor(prior, head);
  if (descends && before.join(',') === after.join(',')) {
    return {
      mode: 'incremental',
      kind: 'descends',
      reason: `HEAD descends from the last reviewed commit ${short(prior)} with an unchanged merge-base`,
      priorSha: prior,
      review,
      from: prior,
    };
  }

  // The base moved under the branch, or its history was rewritten (kanon#525). Isolate the
  // author's change by re-applying the reviewed one to the head's base; see the header.
  const shape = descends
    ? `the base was merged in (merge-base ${before.map(short).join(',')} → ${after.map(short).join(',')})`
    : `the last reviewed commit ${short(prior)} is not an ancestor of the head — the branch was rebased or force-pushed`;
  if (before.length !== 1 || after.length !== 1) {
    return full(`${shape}, and a merge-base is not unique (criss-cross), so the reviewed change can't be re-applied unambiguously`);
  }
  const [priorBase] = before;
  const [base] = after;
  if (!git.isAncestor(priorBase, base)) {
    return full(`${shape}, onto ${short(base)}, which does not descend from ${short(priorBase)}, the base the reviewed commit built on — an older base, a rewritten one, or a retargeted PR`);
  }
  const from = git.replay(prior, base);
  if (!from) {
    return full(`${shape}, and the reviewed change ${short(priorBase)}..${short(prior)} does not re-apply cleanly to ${short(base)} — a conflict resolution can't be told apart from a new change`);
  }
  return {
    mode: 'incremental',
    kind: descends ? 'base-merged' : 'rewritten',
    reason: `${shape}; the reviewed change ${short(priorBase)}..${short(prior)} re-applies cleanly to ${short(base)}, so the head is reviewed against that`,
    priorSha: prior,
    review,
    from,
    baseSha: base,
    priorBaseSha: priorBase,
  };
}

function runGit(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, ...opts });
}

/**
 * The real git answers, against a clone at `cwd` whose base branch is at `baseRef`.
 * With `remote`, a reviewed commit absent from the clone is fetched from it by SHA.
 *
 * @param {{cwd?: string, baseRef: string, remote?: string}} opts
 * @returns {GitFacts}
 */
export function gitFacts({ cwd = process.cwd(), baseRef, remote }) {
  return {
    resolve(sha) {
      try {
        return runGit(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).trim() || null;
      } catch {
        return null;
      }
    },
    isAncestor(a, b) {
      try {
        runGit(cwd, ['merge-base', '--is-ancestor', a, b]);
        return true;
      } catch {
        return false;
      }
    },
    mergeBases(sha) {
      try {
        return runGit(cwd, ['merge-base', '--all', sha, baseRef]).split('\n').filter(Boolean).sort();
      } catch {
        return [];
      }
    },
    replay(sha, onto) {
      return replayTree(cwd, sha, onto);
    },
    ...(remote
      ? {
          // The stamp is hex by `readTrailer`'s pattern, so it never reaches git as an option.
          fetch(sha) {
            runGit(cwd, ['fetch', '--no-tags', '--quiet', remote, sha], { timeout: 120_000 });
          },
        }
      : {}),
  };
}

/**
 * The merge of X and B' (see `GitFacts`), as a tree id, or null. The merge runs in an empty
 * directory against the clone's git dir as a bare repository, with attributes read from B',
 * so nothing in the PR's working tree, index or commits (a `merge=union` in its
 * `.gitattributes`) decides how the merge resolves.
 */
function replayTree(cwd, sha, onto) {
  let scratch;
  try {
    const gitDir = runGit(cwd, ['rev-parse', '--absolute-git-dir']).trim();
    scratch = mkdtempSync(join(tmpdir(), 'kanon-replay-'));
    const env = { ...process.env, GIT_DIR: gitDir, GIT_ATTR_SOURCE: onto };
    for (const k of ['GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
    const out = runGit(scratch, ['-c', 'core.bare=true', '-c', `attr.tree=${onto}`, 'merge-tree', '--write-tree', '--no-messages', sha, onto], { env });
    const tree = out.split('\n')[0].trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } catch {
    // A conflict exits 1; an old git without `--write-tree` exits 129. Both are a full review.
    return null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

const TRAILER_LINE = /<!--[ \t]*reviewed:[^>]*-->/gi;

/**
 * A code fence longer than any backtick run in `text`, so PR content — a diff line of
 * a Markdown file that is itself a fence — cannot close it early and spill into what
 * reads as the workflow's own text.
 */
export function fence(text, info = '') {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return [`${f}${info}`, String(text).replace(/\n$/, ''), f];
}

/**
 * What the context says the diff is, per kind of scope (kanon#525).
 *
 * @param {Extract<Scope, {mode: 'incremental'}>} scope
 */
function scopeStatement(scope, headSha) {
  if (scope.kind !== 'base-merged' && scope.kind !== 'rewritten') {
    return [`The head \`${headSha}\` descends from it with the same merge-base, so the commits below are exactly what the author changed since.`];
  }
  const how = scope.kind === 'base-merged'
    ? 'The base branch was merged into the PR since, so the diff from that commit would carry every base change the merge brought in.'
    : 'The branch was rebased or force-pushed since, so that commit is no longer in the head\'s history.';
  return [
    `${how} Instead, the workflow re-applied the change your verdict read (\`${short(scope.priorBaseSha)}..${short(scope.priorSha)}\`) to the base the head now builds on (\`${scope.baseSha}\`), by a three-way merge with no conflicts, and diffed the head \`${headSha}\` against that.`,
    'So the diff below is everything the head differs from your reviewed change on the newer base: new commits, conflict resolutions, and anything the rebase or merge dropped or rewrote. An empty diff means the head is exactly the change you reviewed, on the newer base.',
  ];
}

/**
 * The file the reviewer reads on an incremental run: prior findings first, then the
 * new commits and their diff.
 *
 * @param {{scope: Extract<Scope, {mode: 'incremental'}>, headSha: string, reviews?: object[], comments?: object[], log: string, stat: string, diff: string, overlap?: string, reviewer?: string}} input
 */
export function renderContext({ scope, headSha, reviews = [], comments = [], log, stat, diff, overlap = '', reviewer = appLogin('Reviewer') }) {
  const r = /** @type {{id: number, state: string, submitted_at?: string, body?: string}} */ (scope.review);
  const body = String(r.body ?? '').replace(TRAILER_LINE, '').trim() || '_(empty body)_';
  const inline = comments
    .filter((c) => c?.pull_request_review_id === r.id)
    .map((c) => {
      const line = c.line ?? c.original_line;
      return `- \`${c.path}${line ? `:${line}` : ''}\` — ${String(c.body ?? '').trim()}`;
    });
  // Earlier rounds are LISTED, not inlined: a chain of incremental rounds otherwise
  // paraphrases a round-1 finding into nothing by round 3.
  const earlier = reviewerVerdicts(reviews, reviewer)
    .filter((v) => v.id !== r.id)
    .map((v) => {
      const sha = readTrailer(v).reviewedSha;
      return `- review ${v.id} — \`${v.state}\`${v.submitted_at ? ` ${v.submitted_at}` : ''}${sha ? ` on \`${sha.slice(0, 7)}\`` : ' (unstamped)'}`;
    });
  const x = short(scope.priorSha);
  const h = short(headSha);
  const from = short(scope.from ?? scope.priorSha);
  const moved = scope.kind === 'base-merged' || scope.kind === 'rewritten';
  return [
    `# Incremental re-review context — ${x}..${h}`,
    '',
    `Written by the review workflow from the BASE branch's \`scripts/incremental-review.mjs\` (RA-2455), not by the PR.`,
    `Your last verdict on this PR was \`${r.state}\` (review ${r.id}${r.submitted_at ? `, ${r.submitted_at}` : ''}), formed on \`${scope.priorSha}\`.`,
    ...scopeStatement(scope, headSha),
    '',
    '## Your prior review',
    '',
    body,
    '',
    ...(inline.length ? ['### Its inline comments', '', ...inline, ''] : []),
    ...(earlier.length
      ? [
          '### Your earlier verdicts on this PR',
          '',
          'Findings the prior review only refers to by name are in these; read one with `gh api repos/{owner}/{repo}/pulls/<n>/reviews/<id>` (and `/comments` for its inline notes).',
          '',
          ...earlier,
          '',
        ]
      : []),
    `## Commits since (${moved ? `the head's commits not in \`${x}\` or the base` : `${x}..${h}`})`,
    '',
    ...fence(log.trim() || '(none)'),
    '',
    '## Files changed since',
    '',
    ...fence(stat.trim() || '(none)'),
    '',
    ...(moved
      ? [
          `## Where the base moved under this PR (\`${short(scope.priorBaseSha)}..${short(scope.baseSha)}\`)`,
          '',
          'Files the base changed since your verdict that the PR also changes. The merge was clean, but check that the PR\'s change still fits what the base did to them.',
          '',
          ...fence(overlap.trim() || '(none)'),
          '',
        ]
      : []),
    `## Incremental diff (\`git diff ${from} ${h}\`${moved ? `, \`${from}\` being the tree of your reviewed change on \`${short(scope.baseSha)}\`` : ''})`,
    '',
    ...fence(diff || '(empty: the head is the reviewed change on the newer base)', 'diff'),
    '',
  ].join('\n');
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readJson(path, fallback) {
  if (!path) return fallback;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * CLI. Prints one JSON line `{mode, reason, prior_sha?}` and, when incremental, writes
 * the context file. NEVER exits non-zero: an unexpected failure prints a full-review
 * decision, because a full review is the safe answer to every question this asks.
 *
 *   node incremental-review.mjs --reviews r.json [--comments c.json] --head <sha> --base-ref origin/main \
 *     --register agent-identities.md --out ctx.md [--remote origin]
 *
 * `--remote` names where to fetch the last reviewed commit from by its SHA when the clone
 * lacks it, as after a rebase or force-push (kanon#525).
 *
 * `--register` is REQUIRED, and names the App register to read the reviewer's login
 * from (RA-2701). There is no working-tree default here on purpose: in CI the working tree
 * is the PR's, so a default would let the PR name the reviewer. A missing or malformed
 * register is a full review, like every other failure.
 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const headSha = arg(argv, '--head');
    const baseRef = arg(argv, '--base-ref');
    const out = arg(argv, '--out');
    const register = arg(argv, '--register');
    if (!headSha || !baseRef || !out || !register) throw new Error('usage: --reviews <f> --head <sha> --base-ref <ref> --register <f> --out <f>');
    const reviewer = appLogin('Reviewer', register);
    const reviews = readJson(arg(argv, '--reviews'), null);
    if (!Array.isArray(reviews)) {
      return { mode: 'full', reason: "could not read the PR's reviews" };
    }
    const remote = arg(argv, '--remote');
    const scope = decideScope({ reviews, headSha, git: gitFacts({ cwd, baseRef, remote }), reviewer });
    if (scope.mode !== 'incremental') return scope;
    const range = [scope.from, headSha];
    const noDrivers = ['--text', '--no-ext-diff', '--no-textconv'];
    const names = (a, b) => new Set(runGit(cwd, ['diff', '--name-only', '--no-renames', ...noDrivers, a, b]).split('\n').filter(Boolean));
    const text = renderContext({
      scope,
      headSha,
      reviews,
      reviewer,
      comments: readJson(arg(argv, '--comments'), []),
      // The head's own commits: a merge brings the base's in, and a rebase rewrites all.
      log: runGit(cwd, ['log', '--no-decorate', '--format=%h %s', headSha, `^${scope.priorSha}`, ...(scope.baseSha ? [`^${scope.baseSha}`] : [])]),
      // `--text --no-ext-diff --no-textconv`: the checkout is the PR's, so its own
      // `.gitattributes` must not be able to render a change as "Binary files differ"
      // or through a driver of its choosing — the rule that a PR does not control how
      // much of itself the reviewer reads.
      stat: runGit(cwd, ['diff', '--stat', ...noDrivers, ...range]),
      diff: runGit(cwd, ['diff', ...noDrivers, ...range]),
      ...(scope.baseSha && scope.priorBaseSha
        ? (() => {
            const pr = names(scope.baseSha, headSha);
            return { overlap: [...names(scope.priorBaseSha, scope.baseSha)].filter((f) => pr.has(f)).join('\n') };
          })()
        : {}),
    });
    writeFileSync(out, text);
    return { mode: 'incremental', reason: scope.reason, prior_sha: scope.priorSha };
  } catch (e) {
    return { mode: 'full', reason: `scope resolution failed (${e instanceof Error ? e.message : String(e)}) — reviewing in full` };
  }
}

// realpath, because a symlinked temp dir (macOS `/var` → `/private/var`) makes the
// resolved module URL and argv[1] disagree and the CLI would silently print nothing.
const isMain = () => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
};

if (isMain()) {
  const result = main();
  process.stdout.write(`${JSON.stringify({ mode: result.mode, reason: result.reason, prior_sha: result.prior_sha ?? '' })}\n`);
}
