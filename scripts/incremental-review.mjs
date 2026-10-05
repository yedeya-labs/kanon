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
// ── WHEN X..HEAD IS NOT "WHAT THE AUTHOR CHANGED" ───────────────────────────
// Three shapes, each a full review:
//   · X is not an ancestor of HEAD — a force-push that dropped it, or a REBASE (every
//     commit is rewritten, so X is no longer in HEAD's history even when nothing
//     conflicted). Also X absent from the clone entirely.
//   · The merge-base with the base branch moved — base was MERGED into the branch. X is
//     still an ancestor, but X..HEAD now carries every base commit the merge brought in,
//     which the reviewer would read as the author's change.
//   · X == HEAD — a same-commit re-review is RA-1351's explicit human request, which asks
//     for a fresh look, not an empty diff.
//
// The decision is `decideScope`, with git injected so it is testable without a repo;
// `gitFacts` is the real implementation, exercised against real repos in
// tests/unit/incremental-review.test.ts (rebase, merge-from-base, force-push).
//
// ── HOW THE WORKFLOW RUNS THIS ──────────────────────────────────────────────
// Kanon's review lane runs this file from the action cache, at the Kanon tag its caller
// pins (plan 0001 §3), never from the PR's checkout: a PR must not supply the logic that
// decides how much of it is read. The reference adopter extracted it and its imports from
// the base branch for the same reason; with the library in Kanon there is nothing left to
// extract. It runs before any PR code executes, and never fails the job: any error is a
// full review.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
 * }} GitFacts
 *
 * @typedef {{mode: 'full', reason: string} | {mode: 'incremental', reason: string, priorSha: string, review: object}} Scope
 */

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
  if (!head) return full(`the head ${headSha.slice(0, 7)} is not in the clone`);
  const prior = git.resolve(stamped);
  if (!prior) {
    return full(`the last reviewed commit ${stamped.slice(0, 7)} is not in the clone — force-pushed or rebased away`);
  }
  if (prior === head) {
    return full(`the head ${head.slice(0, 7)} is the commit last reviewed — a same-commit re-review is an explicit request for a fresh look (RA-1351)`);
  }
  if (!git.isAncestor(prior, head)) {
    return full(`the last reviewed commit ${prior.slice(0, 7)} is not an ancestor of the head — the branch was rebased or force-pushed`);
  }

  const before = git.mergeBases(prior);
  const after = git.mergeBases(head);
  if (!before.length || !after.length) {
    return full('could not compute the merge-base with the base branch, so whether the base moved is unknown');
  }
  if (before.join(',') !== after.join(',')) {
    return full(
      `the merge-base with the base branch moved (${before.map((s) => s.slice(0, 7)).join(',')} → ${after.map((s) => s.slice(0, 7)).join(',')}) — the base was merged in, so ${prior.slice(0, 7)}..HEAD would include base-branch changes`,
    );
  }

  return {
    mode: 'incremental',
    reason: `HEAD descends from the last reviewed commit ${prior.slice(0, 7)} with an unchanged merge-base`,
    priorSha: prior,
    review,
  };
}

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The real git answers, against a clone at `cwd` whose base branch is at `baseRef`.
 *
 * @param {{cwd?: string, baseRef: string}} opts
 * @returns {GitFacts}
 */
export function gitFacts({ cwd = process.cwd(), baseRef }) {
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
  };
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
 * The file the reviewer reads on an incremental run: prior findings first, then the
 * new commits and their diff.
 *
 * @param {{scope: Extract<Scope, {mode: 'incremental'}>, headSha: string, reviews?: object[], comments?: object[], log: string, stat: string, diff: string, reviewer?: string}} input
 */
export function renderContext({ scope, headSha, reviews = [], comments = [], log, stat, diff, reviewer = appLogin('Reviewer') }) {
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
  const x = scope.priorSha.slice(0, 7);
  const h = headSha.slice(0, 7);
  return [
    `# Incremental re-review context — ${x}..${h}`,
    '',
    `Written by the review workflow from the BASE branch's \`scripts/incremental-review.mjs\` (RA-2455), not by the PR.`,
    `Your last verdict on this PR was \`${r.state}\` (review ${r.id}${r.submitted_at ? `, ${r.submitted_at}` : ''}), formed on \`${scope.priorSha}\`.`,
    `The head \`${headSha}\` descends from it with the same merge-base, so the commits below are exactly what the author changed since.`,
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
    `## Commits since (${x}..${h})`,
    '',
    ...fence(log.trim() || '(none)'),
    '',
    '## Files changed since',
    '',
    ...fence(stat.trim() || '(none)'),
    '',
    `## Incremental diff (\`git diff ${x} ${h}\`)`,
    '',
    ...fence(diff, 'diff'),
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
 *     --register agent-identities.md --out ctx.md
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
    const scope = decideScope({ reviews, headSha, git: gitFacts({ cwd, baseRef }), reviewer });
    if (scope.mode !== 'incremental') return scope;
    const range = [scope.priorSha, headSha];
    const text = renderContext({
      scope,
      headSha,
      reviews,
      reviewer,
      comments: readJson(arg(argv, '--comments'), []),
      log: runGit(cwd, ['log', '--no-decorate', '--format=%h %s', `${range[0]}..${range[1]}`]),
      // `--text --no-ext-diff --no-textconv`: the checkout is the PR's, so its own
      // `.gitattributes` must not be able to render a change as "Binary files differ"
      // or through a driver of its choosing — the rule that a PR does not control how
      // much of itself the reviewer reads.
      stat: runGit(cwd, ['diff', '--stat', '--text', '--no-ext-diff', '--no-textconv', ...range]),
      diff: runGit(cwd, ['diff', '--text', '--no-ext-diff', '--no-textconv', ...range]),
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
