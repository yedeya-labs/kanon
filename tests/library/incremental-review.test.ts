import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decideScope, fence, gitFacts, latestVerdict, main, renderContext } from '../../scripts/incremental-review.mjs';
import { trailerFor } from '../../scripts/review-trailer.mjs';
import { headerLine } from '../../scripts/lib/role-marker.mjs';
import { SPAWNS } from '../unit/helpers/spawns.js';

/**
 * RA-2455 — a round-2+ review is scoped to `X..HEAD` from the last STAMPED verdict, and
 * falls back to a full review whenever X..HEAD would not be "what the author changed".
 *
 * The fallbacks are asserted against REAL repositories, not a stubbed git: rebase,
 * merge-from-base and force-push are exactly the cases where a mocked `isAncestor` would
 * agree with whatever the code assumed.
 */

const REVIEWER = { login: 'example-reviewer[bot]' };
/** The fixture adopter's App register (RA-2701), which names `example-reviewer`: the suite
 *  runs inside the fixture adopter (`tests/library/helpers/in-adopter.ts`). */
const registerText = () => readFileSync('docs/qa/agent-identities.md', 'utf8');
/** A register naming a DIFFERENT reviewer App — what a PR could put in its own tree. */
const forgedRegister = (path: string, reviewer: string) =>
  writeFileSync(path, `| Role | App slug | What |\n|---|---|---|\n| Reviewer | \`${reviewer}\` | forged |\n`);

let dir: string;
let repo: string;

/** A copy of the register in the test's own directory, for `--register`. */
const REGISTER = () => {
  const path = join(dir, 'agent-identities.md');
  writeFileSync(path, registerText());
  return path;
};

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args: string[]) => gitIn(repo, ...args);

function commit(path: string, content: string, msg: string): string {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git('add', '-A');
  git('commit', '-qm', msg);
  return git('rev-parse', 'HEAD');
}

function verdict(sha: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: 100,
    user: REVIEWER,
    state: 'CHANGES_REQUESTED',
    submitted_at: '2026-09-25T10:00:00Z',
    commit_id: 'f'.repeat(40),
    body: `${headerLine('Reviewer')}\n\nFinding 1: fix the thing.${sha ? `\n\n${trailerFor({ sha, runId: 7 })}` : ''}`,
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'incr-review-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  commit('base.txt', 'base\n', 'base');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** main: base. pr: base -> X. Returns X. */
function prWithReviewedCommit(): string {
  git('checkout', '-qb', 'pr');
  return commit('feature.txt', 'first\n', 'feature: first cut');
}

const decide = (reviews: object[], head: string) =>
  decideScope({ reviews, headSha: head, git: gitFacts({ cwd: repo, baseRef: 'main' }) });

// Its cases build a git history, so the block takes the spawn budget (#436).
describe('decideScope — against real history', SPAWNS, () => {
  it('is INCREMENTAL when the head descends from the stamped commit with the same merge-base', () => {
    const x = prWithReviewedCommit();
    const head = commit('feature.txt', 'first\nsecond\n', 'address review');
    const s = decide([verdict(x)], head);
    expect(s.mode).toBe('incremental');
    expect(s.mode === 'incremental' && s.priorSha).toBe(x);
  });

  it('accepts a SHORT stamp and resolves it to the full commit', () => {
    const x = prWithReviewedCommit();
    const head = commit('feature.txt', 'second\n', 'more');
    const s = decide([verdict(x.slice(0, 7))], head);
    expect(s.mode === 'incremental' && s.priorSha).toBe(x);
  });

  it('stays INCREMENTAL when main moved but was NOT brought into the branch', () => {
    const x = prWithReviewedCommit();
    git('checkout', '-q', 'main');
    commit('other.txt', 'someone else\n', 'unrelated main change');
    git('checkout', '-q', 'pr');
    const head = commit('feature.txt', 'first\nsecond\n', 'address review');
    expect(decide([verdict(x)], head).mode).toBe('incremental');
  });

  it('is FULL when X is not in the clone at all', () => {
    prWithReviewedCommit();
    const head = commit('feature.txt', 'second\n', 'more');
    const s = decide([verdict('abcdef1234567890abcdef1234567890abcdef12')], head);
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/not in the clone and could not be fetched/);
  });

  it('is FULL when X is the head — a same-commit re-review is an explicit request (RA-1351)', () => {
    const x = prWithReviewedCommit();
    const s = decide([verdict(x)], x);
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/RA-1351/);
  });

  it('is FULL when the latest verdict is UNSTAMPED — never falls back to commit_id (RA-1680/RA-2281)', () => {
    const x = prWithReviewedCommit();
    const head = commit('feature.txt', 'second\n', 'more');
    // commit_id names a perfectly good ancestor — and is still not trusted.
    const s = decide([verdict(null, { commit_id: x })], head);
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/no reviewed-sha stamp/);
  });

  it('is FULL on a first review', () => {
    const head = prWithReviewedCommit();
    expect(decide([], head).mode).toBe('full');
  });
});

/** Runs the CLI on `head` against the latest verdict stamped `x`, in the test repo. */
function context(x: string, head: string) {
  writeFileSync(join(dir, 'reviews.json'), JSON.stringify([verdict(x)]));
  const out = join(dir, 'ctx.md');
  rmSync(out, { force: true });
  const r = main(['--reviews', join(dir, 'reviews.json'), '--head', head, '--base-ref', 'main', '--register', REGISTER(), '--out', out], repo);
  return { r, text: r.mode === 'incremental' ? readFileSync(out, 'utf8') : '' };
}
/** The context's incremental diff, alone. */
const diffSection = (text: string) => text.slice(text.indexOf('## Incremental diff'));

/** main: base -> M (other.txt). pr: base -> X (feature.txt), not yet built on M. Returns X. */
function baseMovesAfterReview(): string {
  const x = prWithReviewedCommit();
  git('checkout', '-q', 'main');
  commit('other.txt', 'someone else\n', 'unrelated main change');
  git('checkout', '-q', 'pr');
  return x;
}

// kanon#525. Its cases build a git history, so the block takes the spawn budget (#436).
describe('a merge of the base or a rebase — incremental against the reviewed change re-applied', SPAWNS, () => {
  it('a CLEAN REBASE plus a new commit: incremental, and the diff is the new commit alone', () => {
    const x = baseMovesAfterReview();
    git('rebase', '-q', 'main');
    const head = commit('feature.txt', 'first\nsecond\n', 'address review');
    const s = decide([verdict(x)], head);
    expect(s.mode).toBe('incremental');
    expect(s.mode === 'incremental' && s.kind).toBe('rewritten');
    expect(s.reason).toMatch(/rebased or force-pushed.*re-applies cleanly/);
    const { text } = context(x, head);
    const diff = diffSection(text);
    expect(diff).toContain('+second');
    expect(diff).not.toContain('other.txt'); // the base's change is not the author's
    expect(diff).not.toContain('+first'); // nor is the change already reviewed
    // Both rebased commits, newest first, and none of the base's.
    expect(text).toMatch(/## Commits since[^\n]*\n\n`+\n[0-9a-f]+ address review\n[0-9a-f]+ feature: first cut\n`+\n/);
  });

  it('a CLEAN REBASE and nothing else: incremental, with an empty diff', () => {
    const x = baseMovesAfterReview();
    git('rebase', '-q', 'main');
    const head = git('rev-parse', 'HEAD');
    const { r, text } = context(x, head);
    expect(r.mode).toBe('incremental');
    expect(diffSection(text)).toContain('(empty: the head is the reviewed change on the newer base)');
  });

  it('a CLEAN MERGE of the base plus a new commit: incremental, without the base’s commits', () => {
    const x = baseMovesAfterReview();
    git('merge', '-q', '--no-edit', 'main');
    const head = commit('feature.txt', 'first\nsecond\n', 'address review');
    const s = decide([verdict(x)], head);
    expect(s.mode === 'incremental' && s.kind).toBe('base-merged');
    expect(s.reason).toMatch(/base was merged in.*re-applies cleanly/);
    const { text } = context(x, head);
    const diff = diffSection(text);
    expect(diff).toContain('+second');
    expect(diff).not.toContain('other.txt');
    expect(text).not.toMatch(/unrelated main change/); // the log lists the head's own commits
    expect(text).toMatch(/Merge branch 'main'/);
  });

  it('a force-push that rewrote X on the same base: incremental against X, showing every rewritten line', () => {
    const x = prWithReviewedCommit();
    git('reset', '-q', '--hard', 'main');
    const head = commit('feature.txt', 'rewritten\n', 'start over');
    // Not "descends": the context must not tell the Reviewer the head extends X.
    const s = decide([verdict(x)], head);
    expect(s.mode === 'incremental' && s.kind).toBe('rewritten');
    const { r, text } = context(x, head);
    expect(r.mode).toBe('incremental');
    expect(text).not.toMatch(/descends from it/);
    expect(diffSection(text)).toMatch(/-first\n\+rewritten/);
  });

  it('lists a file both the base and the PR changed, when the re-application is clean', () => {
    commit('shared.txt', 'a\nb\nc\nd\ne\nf\ng\n', 'shared on main');
    const x = prWithReviewedCommit();
    commit('shared.txt', 'PR\nb\nc\nd\ne\nf\ng\n', 'pr edits the top');
    const y = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    commit('shared.txt', 'a\nb\nc\nd\ne\nf\nBASE\n', 'base edits the bottom');
    commit('other.txt', 'x\n', 'base touches a file the PR does not');
    git('checkout', '-q', 'pr');
    git('rebase', '-q', 'main');
    expect(x).not.toBe(y);
    const { r, text } = context(y, git('rev-parse', 'HEAD'));
    expect(r.mode).toBe('incremental');
    const section = text.slice(text.indexOf('## Where the base moved'), text.indexOf('## Incremental diff'));
    expect(section).toContain('shared.txt');
    expect(section).not.toContain('other.txt');
  });
});

// kanon#525's safety property. Its cases build a git history, so the block takes the spawn budget (#436).
describe('never carries a verdict across a change to the PR’s own diff', SPAWNS, () => {
  it('a rebase that also EDITS the reviewed change: the edit is in the diff', () => {
    const x = baseMovesAfterReview();
    git('rebase', '-q', 'main');
    writeFileSync(join(repo, 'feature.txt'), 'first\nconst bypass = true;\n');
    git('commit', '-qa', '--amend', '--no-edit'); // still one commit, still "feature: first cut"
    const { r, text } = context(x, git('rev-parse', 'HEAD'));
    expect(r.mode).toBe('incremental');
    expect(diffSection(text)).toContain('+const bypass = true;');
  });

  it('a rebase that DROPS a reviewed commit: the removal is in the diff', () => {
    git('checkout', '-qb', 'pr');
    commit('check.txt', 'assert(authorised)\n', 'add the check');
    const x = commit('feature.txt', 'first\n', 'feature');
    git('checkout', '-q', 'main');
    commit('other.txt', 'someone else\n', 'unrelated main change');
    git('checkout', '-q', 'pr');
    git('rebase', '-q', '--onto', 'main', `${x}~1`); // replays only "feature": the check is gone
    const { r, text } = context(x, git('rev-parse', 'HEAD'));
    expect(r.mode).toBe('incremental');
    expect(diffSection(text)).toContain('-assert(authorised)');
  });

  it('an "evil" merge of the base, with a change of its own: the change is in the diff', () => {
    const x = baseMovesAfterReview();
    git('merge', '-q', '--no-commit', 'main');
    writeFileSync(join(repo, 'feature.txt'), 'first\nhidden in the merge\n');
    git('add', '-A');
    git('commit', '-q', '--no-edit');
    const { r, text } = context(x, git('rev-parse', 'HEAD'));
    expect(r.mode).toBe('incremental');
    expect(diffSection(text)).toContain('+hidden in the merge');
  });

  it('a merge that rewrites what the BASE brought in: that rewrite is the PR’s, and is in the diff', () => {
    const x = baseMovesAfterReview();
    git('merge', '-q', '--no-commit', 'main');
    writeFileSync(join(repo, 'other.txt'), 'someone else, edited by the PR\n');
    git('add', '-A');
    git('commit', '-q', '--no-edit');
    const { r, text } = context(x, git('rev-parse', 'HEAD'));
    expect(r.mode).toBe('incremental');
    expect(diffSection(text)).toContain('+someone else, edited by the PR');
  });

  it('a merge of the base that needed a CONFLICT RESOLUTION: full', () => {
    git('checkout', '-qb', 'pr');
    const x = commit('base.txt', 'pr\n', 'pr edits base.txt');
    git('checkout', '-q', 'main');
    commit('base.txt', 'main\n', 'main edits base.txt');
    git('checkout', '-q', 'pr');
    try { git('merge', '-q', '--no-edit', 'main'); } catch { /* the conflict */ }
    writeFileSync(join(repo, 'base.txt'), 'resolved\n');
    git('add', '-A');
    git('commit', '-q', '--no-edit');
    const s = decide([verdict(x)], git('rev-parse', 'HEAD'));
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/does not re-apply cleanly/);
  });

  it('a rebase that needed a conflict resolution: full', () => {
    git('checkout', '-qb', 'pr');
    const x = commit('base.txt', 'pr\n', 'pr edits base.txt');
    git('checkout', '-q', 'main');
    const m = commit('base.txt', 'main\n', 'main edits base.txt');
    git('checkout', '-q', '--detach', m);
    const head = commit('base.txt', 'resolved\n', 'pr edits base.txt');
    const s = decide([verdict(x)], head);
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/rebased or force-pushed.*does not re-apply cleanly/);
  });

  // The PR's own attributes must not decide how the reviewed change re-applies: `merge=union`
  // turns the conflict above into a "clean" merge of both sides that nobody reviewed.
  for (const where of ['the head’s working tree', 'the reviewed commit']) {
    it(`ignores a \`merge=union\` in ${where}: the conflict is still a conflict, so full`, () => {
      git('checkout', '-qb', 'pr');
      if (where === 'the reviewed commit') commit('.gitattributes', 'base.txt merge=union\n', 'attributes');
      const x = commit('base.txt', 'pr\n', 'pr edits base.txt');
      git('checkout', '-q', 'main');
      commit('base.txt', 'main\n', 'main edits base.txt');
      git('checkout', '-q', 'pr');
      git('merge', '-q', '--no-edit', '-X', 'ours', 'main');
      writeFileSync(join(repo, '.gitattributes'), 'base.txt merge=union\n');
      writeFileSync(join(repo, 'base.txt'), 'pr\nmain\n');
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'union, as the attribute would merge it');
      // The trap, as plain git shows it from the PR's checkout.
      expect(() => git('merge-tree', '--write-tree', x, 'main')).not.toThrow();
      const s = decide([verdict(x)], git('rev-parse', 'HEAD'));
      expect(s.mode).toBe('full');
      expect(s.reason).toMatch(/does not re-apply cleanly/);
    });
  }

  it('a head built on an OLDER base than X: full', () => {
    const m = commit('other.txt', 'someone else\n', 'main change');
    git('checkout', '-qb', 'pr');
    const x = commit('feature.txt', 'first\n', 'feature');
    git('rebase', '-q', '--onto', `${m}~1`, m);
    const s = decide([verdict(x)], git('rev-parse', 'HEAD'));
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/does not descend from/);
  });

  it('a criss-cross history, where a merge-base is not unique: full', () => {
    const x = prWithReviewedCommit();
    git('checkout', '-q', 'main');
    const m1 = commit('other.txt', 'someone else\n', 'main change');
    git('merge', '-q', '--no-ff', '--no-edit', x); // main takes X …
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-ff', '--no-edit', m1); // … and the PR takes main's older commit
    const head = git('rev-parse', 'HEAD');
    expect(git('merge-base', '--all', head, 'main').split('\n')).toHaveLength(2);
    const s = decide([verdict(x)], head);
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/not unique/);
  });
});

describe('decideScope — fetching the reviewed commit', () => {
  const fake = (present: Set<string>, fetchable: Set<string>, calls: string[]) => ({
    resolve: (sha: string) => (present.has(sha) ? sha : null),
    isAncestor: () => true,
    mergeBases: () => ['b'.repeat(40)],
    replay: () => null,
    fetch: (sha: string) => {
      calls.push(sha);
      if (fetchable.has(sha)) present.add(sha);
    },
  });
  const x = 'a'.repeat(40);
  const head = 'c'.repeat(40);

  it('fetches X by its SHA when the clone lacks it, and goes on with it', () => {
    const calls: string[] = [];
    const s = decideScope({ reviews: [verdict(x)], headSha: head, git: fake(new Set([head]), new Set([x]), calls) });
    expect(calls).toEqual([x]);
    expect(s.mode).toBe('incremental');
  });

  it('is FULL when the fetch cannot find it either', () => {
    const calls: string[] = [];
    const s = decideScope({ reviews: [verdict(x)], headSha: head, git: fake(new Set([head]), new Set(), calls) });
    expect(calls).toEqual([x]);
    expect(s.mode).toBe('full');
    expect(s.reason).toMatch(/could not be fetched/);
  });
});

describe('latestVerdict', () => {
  it('takes the Reviewer’s newest APPROVE/REQUEST_CHANGES, ignoring COMMENTs and other reviewers', () => {
    const reviews = [
      verdict('a'.repeat(40), { id: 1, submitted_at: '2026-09-25T09:00:00Z' }),
      verdict('b'.repeat(40), { id: 2, submitted_at: '2026-09-25T10:00:00Z', state: 'APPROVED' }),
      verdict('c'.repeat(40), { id: 3, submitted_at: '2026-09-25T11:00:00Z', state: 'COMMENTED' }),
      verdict('d'.repeat(40), { id: 4, submitted_at: '2026-09-25T12:00:00Z', user: { login: 'someone' } }),
    ];
    expect(latestVerdict(reviews)?.id).toBe(2);
  });

  it('does not reach past an unstamped latest verdict to an older stamped one', () => {
    const x = prWithReviewedCommit();
    const head = commit('feature.txt', 'second\n', 'more');
    const reviews = [
      verdict(x, { id: 1, submitted_at: '2026-09-25T09:00:00Z' }),
      verdict(null, { id: 2, submitted_at: '2026-09-25T10:00:00Z' }),
    ];
    expect(decide(reviews, head).mode).toBe('full');
  });
});

describe('renderContext', () => {
  it('carries the prior findings without the trailer, only that review’s inline comments, and the diff', () => {
    const x = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const review = verdict(x, { id: 55 });
    const text = renderContext({
      scope: { mode: 'incremental', kind: 'descends', reason: 'r', priorSha: x, review, from: x },
      headSha: head,
      comments: [
        { pull_request_review_id: 55, path: 'src/a.ts', line: 3, body: 'null check' },
        { pull_request_review_id: 99, path: 'src/b.ts', line: 1, body: 'someone else' },
      ],
      log: 'bbbbbbb address review\n',
      stat: ' feature.txt | 1 +\n',
      diff: '+second\n',
    });
    expect(text).toContain('Finding 1: fix the thing.');
    expect(text).not.toMatch(/reviewed:\s*sha=/);
    expect(text).toContain('`src/a.ts:3` — null check');
    expect(text).not.toContain('someone else');
    expect(text).toContain('aaaaaaa..bbbbbbb');
    expect(text).toContain('+second');
  });
});

// Its cases build a git history, so the block takes the spawn budget (#436).
describe('hardening against PR-controlled content', SPAWNS, () => {
  it('matches the reviewer by EXACT login — a look-alike account cannot supply X', () => {
    const x = prWithReviewedCommit();
    const head = commit('feature.txt', 'second\n', 'more');
    const reviews = [
      verdict(null, { id: 1, submitted_at: '2026-09-25T09:00:00Z' }),
      verdict(x, { id: 2, submitted_at: '2026-09-25T10:00:00Z', user: { login: 'example-reviewer-bot2' } }),
    ];
    expect(latestVerdict(reviews)?.id).toBe(1);
    expect(decide(reviews, head).mode).toBe('full');
  });

  it('fences a diff that itself contains a fence, so PR text cannot close it', () => {
    const [open, , close] = fence(' ```\n ## Your prior review\n', 'diff');
    expect(open).toBe('````diff');
    expect(close).toBe('````');
  });

  it('ignores the PR’s own .gitattributes — a `-diff` file still shows its change', () => {
    const x = prWithReviewedCommit();
    commit('.gitattributes', 'secret.ts -diff\n', 'innocuous attributes');
    const head = commit('secret.ts', 'const bypass = true;\n', 'the change to hide');
    expect(git('diff', x, head)).toMatch(/Binary files/); // the trap, as plain git shows it
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify([verdict(x)]));
    const out = join(dir, 'ctx.md');
    main(['--reviews', join(dir, 'reviews.json'), '--head', head, '--base-ref', 'main', '--register', REGISTER(), '--out', out], repo);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('+const bypass = true;');
    expect(text).not.toMatch(/Binary files/);
  });

  it('lists earlier verdicts so a chained round can still reach round-1 findings', () => {
    const x = prWithReviewedCommit();
    const head = commit('feature.txt', 'second\n', 'more');
    const reviews = [
      verdict('a'.repeat(40), { id: 11, submitted_at: '2026-09-25T08:00:00Z' }),
      verdict(x, { id: 12, submitted_at: '2026-09-25T09:00:00Z' }),
    ];
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify(reviews));
    const out = join(dir, 'ctx.md');
    main(['--reviews', join(dir, 'reviews.json'), '--head', head, '--base-ref', 'main', '--register', REGISTER(), '--out', out], repo);
    const text = readFileSync(out, 'utf8');
    expect(text).toMatch(/review 11 — `CHANGES_REQUESTED`.* on `aaaaaaa`/);
    expect(text).not.toMatch(/- review 12 /);
  });
});

// Its cases run the CLI in `node`, with `git`, so the block takes the spawn budget (#436).
describe('the CLI', SPAWNS, () => {
  it('writes the incremental diff — and only it — on the happy path', () => {
    const x = prWithReviewedCommit();
    const head = commit('fix.txt', 'the fix\n', 'address review');
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify([verdict(x)]));
    const out = join(dir, 'ctx.md');
    const r = main(['--reviews', join(dir, 'reviews.json'), '--head', head, '--base-ref', 'main', '--register', REGISTER(), '--out', out], repo);
    expect(r.mode).toBe('incremental');
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('fix.txt');
    expect(text).toContain('+the fix');
    expect(text).not.toContain('+first'); // X's own change is not in X..HEAD
  });

  it('never throws — unreadable reviews or a missing argument are a FULL review', () => {
    expect(main(['--reviews', join(dir, 'nope.json'), '--head', 'x', '--base-ref', 'main', '--register', REGISTER(), '--out', join(dir, 'o')], repo).mode).toBe('full');
    expect(main([], repo).mode).toBe('full');
  });

  // RA-2701 — the reviewer's login comes from the App register NAMED ON THE COMMAND LINE,
  // which the workflow extracts from BASE. There is no working-tree default.
  it('requires --register: without it, even a perfect incremental case is a FULL review', () => {
    const x = prWithReviewedCommit();
    const head = commit('fix.txt', 'the fix\n', 'address review');
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify([verdict(x)]));
    const r = main(['--reviews', join(dir, 'reviews.json'), '--head', head, '--base-ref', 'main', '--out', join(dir, 'ctx.md')], repo);
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/--register/);
  });

  it('reads the reviewer from that register — a register naming another App finds no prior verdict', () => {
    const x = prWithReviewedCommit();
    const head = commit('fix.txt', 'the fix\n', 'address review');
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify([verdict(x)]));
    const forged = join(dir, 'forged.md');
    forgedRegister(forged, 'someone-else');
    const r = main(['--reviews', join(dir, 'reviews.json'), '--head', head, '--base-ref', 'main', '--register', forged, '--out', join(dir, 'ctx.md')], repo);
    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/no prior verdict/);
  });

  it('a missing or malformed register is a FULL review, never a throw', () => {
    const x = prWithReviewedCommit();
    const head = commit('fix.txt', 'the fix\n', 'address review');
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify([verdict(x)]));
    const bad = join(dir, 'bad.md');
    writeFileSync(bad, '# no table here\n');
    for (const register of [join(dir, 'absent.md'), bad]) {
      const r = main(['--reviews', join(dir, 'reviews.json'), '--head', head, '--base-ref', 'main', '--register', register, '--out', join(dir, 'ctx.md')], repo);
      expect(r.mode).toBe('full');
      expect(r.reason).toMatch(/register/i);
    }
  });
});

