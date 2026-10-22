import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { checkPush, main, readers, renderNotice } from '../../scripts/force-push-notice.mjs';
import { gitFacts } from '../../scripts/incremental-review.mjs';
import { trailerFor } from '../../scripts/review-trailer.mjs';
import { releasedUses } from './helpers/release-ref.js';
import { SPAWNS } from './helpers/spawns.js';
import { writeStub } from './helpers/stub-bin.js';

/**
 * #1244: `K-MERGE-15`'s prose half, "never force-push over a branch a reviewer has read unless
 * asked", caught by a check with no model. A push whose old head is not an ancestor of its new
 * one rewrote the branch, and every review that read a commit the old head had and the new one
 * hasn't is named in a notice. It never fails the run: the rule allows a force-push that was
 * asked for, and the events can't tell one apart.
 *
 * Against real repositories, as `incremental-review.test.ts` is, because a rewrite is exactly
 * where a stubbed `isAncestor` would agree with whatever the code assumed.
 */

let dir: string;
let repo: string;

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args: string[]) => gitIn(repo, ...args);

function commit(path: string, content: string, msg: string): string {
  writeFileSync(join(repo, path), content);
  git('add', '-A');
  git('commit', '-qm', msg);
  return git('rev-parse', 'HEAD');
}

const AUTHOR = 'someone';
let nextId = 1;
function review(sha: string, extra: Record<string, unknown> = {}) {
  return { id: nextId++, user: { login: 'a-reviewer' }, state: 'APPROVED', commit_id: sha, body: 'Looks right.', html_url: 'https://example.test/r', ...extra };
}

const facts = (cwd = repo, remote?: string) => gitFacts({ cwd, baseRef: 'HEAD', ...(remote ? { remote } : {}) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'force-push-notice-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  commit('a.txt', 'base\n', 'base');
  git('checkout', '-qb', 'feature');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('K-MERGE-15 the force-push check', SPAWNS, () => {
  it('a fast-forward push over a reviewed commit is not a force-push, and names no review', () => {
    const before = commit('f.txt', 'one\n', 'one');
    const after = commit('f.txt', 'two\n', 'two');
    const result = checkPush({ before, after, author: AUTHOR, reviews: [review(before)], git: facts() });
    expect(result.forced).toBe(false);
    expect(result.detached).toEqual([]);
  });

  it('a merge of the base into a reviewed branch is not a force-push', () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('checkout', '-q', 'main');
    commit('m.txt', 'moved\n', 'base moved');
    git('checkout', '-q', 'feature');
    git('merge', '-q', '--no-edit', 'main');
    const after = git('rev-parse', 'HEAD');
    const result = checkPush({ before, after, author: AUTHOR, reviews: [review(before)], git: facts() });
    expect(result.forced).toBe(false);
    expect(result.detached).toEqual([]);
  });

  it('an amend force-pushed over the reviewed head detaches the review that read it', () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    const r = review(before, { state: 'CHANGES_REQUESTED' });
    const result = checkPush({ before, after, author: AUTHOR, reviews: [r], git: facts() });
    expect(result.forced).toBe(true);
    expect(result.detached.map((d) => [d.review.id, d.sha])).toEqual([[r.id, before]]);
  });

  it('a rebase onto a moved base detaches a review of the old head', () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('checkout', '-q', 'main');
    commit('m.txt', 'moved\n', 'base moved');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    const after = git('rev-parse', 'HEAD');
    const result = checkPush({ before, after, author: AUTHOR, reviews: [review(before)], git: facts() });
    expect(result.forced).toBe(true);
    expect(result.detached).toHaveLength(1);
  });

  it('names only the reviews of commits the rewrite dropped, not one of a commit the new head keeps', () => {
    const kept = commit('f.txt', 'one\n', 'one');
    const dropped = commit('g.txt', 'two\n', 'two');
    git('reset', '-q', '--hard', kept);
    const after = commit('g.txt', 'two, again\n', 'two again');
    const old = review(kept);
    const read = review(dropped);
    const result = checkPush({ before: dropped, after, author: AUTHOR, reviews: [old, read], git: facts() });
    expect(result.forced).toBe(true);
    expect(result.detached.map((d) => d.review.id)).toEqual([read.id]);
  });

  it('a force-push over a branch no review has read is reported as one, with nothing detached', () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    const result = checkPush({ before, after, author: AUTHOR, reviews: [], git: facts() });
    expect(result.forced).toBe(true);
    expect(result.detached).toEqual([]);
  });

  it("reads the commit a review read from the Reviewer's stamp before its commit_id", () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    // Filed under the new head (a push landed mid-review), stamped with the commit it read.
    const r = review(after, { body: `Read it.\n\n${trailerFor({ sha: before, runId: 7 })}` });
    const result = checkPush({ before, after, author: AUTHOR, reviews: [r], git: facts() });
    expect(result.detached.map((d) => d.sha)).toEqual([before]);
  });

  it("counts a reviewer's submitted reviews only: not a pending one, and not the author's own", () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    const pending = review(before, { state: 'PENDING' });
    const own = review(before, { state: 'COMMENTED', user: { login: AUTHOR } });
    const comment = review(before, { state: 'COMMENTED', user: { login: 'a-human' } });
    expect(readers([pending, own, comment], AUTHOR).map((r) => r.id)).toEqual([comment.id]);
    const result = checkPush({ before, after, author: AUTHOR, reviews: [pending, own, comment], git: facts() });
    expect(result.detached.map((d) => d.review.id)).toEqual([comment.id]);
  });

  it('fetches the old head by its SHA when the clone lacks it, as a clone of the new head does', () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    // GitHub serves a force-pushed-away commit by its SHA until it is collected; a local
    // repository does so once it allows it.
    git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    const clone = join(dir, 'clone');
    execFileSync('git', ['clone', '-q', '--no-local', '--branch', 'feature', repo, clone]);
    expect(() => gitIn(clone, 'cat-file', '-e', `${before}^{commit}`)).toThrow();
    const result = checkPush({ before, after, author: AUTHOR, reviews: [review(before)], git: facts(clone, 'origin') });
    expect(result.forced).toBe(true);
    expect(result.detached).toHaveLength(1);
  });

  it("says it can't tell when the old head is gone, and names no review", () => {
    const after = commit('f.txt', 'one\n', 'one');
    const gone = 'e'.repeat(40);
    const result = checkPush({ before: gone, after, author: AUTHOR, reviews: [review(gone)], git: facts() });
    expect(result.forced).toBeNull();
    expect(result.reason).toMatch(/not in the clone/);
    expect(result.detached).toEqual([]);
  });

  it.each([
    ['no old head', ''],
    ['the zero SHA', '0'.repeat(40)],
    ['something that is not a SHA', '--upload-pack=touch /tmp/x'],
  ])('checks nothing for %s', (_label, before) => {
    const after = commit('f.txt', 'one\n', 'one');
    const result = checkPush({ before, after, author: AUTHOR, reviews: [review(after)], git: facts() });
    expect(result.forced).toBeNull();
    expect(result.reason).toMatch(/names no old head/);
    expect(result.detached).toEqual([]);
  });

  it('does not name again a review an earlier force-push detached, of a commit the old head no longer had', () => {
    const first = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const before = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'one, amended again');
    const after = git('rev-parse', 'HEAD');
    const earlier = review(first);
    const latest = review(before);
    const result = checkPush({ before, after, author: AUTHOR, reviews: [earlier, latest], git: facts() });
    expect(result.detached.map((d) => d.review.id)).toEqual([latest.id]);
  });
});

describe('K-MERGE-15 the notice names every detached review, and never fails the run', SPAWNS, () => {
  const BEFORE = 'a'.repeat(40);
  const AFTER = 'b'.repeat(40);

  it('renders a warning annotation naming each review, its reviewer, its state and the commit it read', () => {
    const r1 = { id: 11, user: { login: 'kanon-reviewer[bot]' }, state: 'APPROVED', html_url: 'https://example.test/r11' };
    const r2 = { id: 12, user: { login: 'a-human' }, state: 'COMMENTED', html_url: 'https://example.test/r12' };
    const { annotation, summary } = renderNotice({
      before: BEFORE,
      after: AFTER,
      number: '7',
      result: { forced: true, reason: 'x', detached: [{ review: r1, sha: BEFORE }, { review: r2, sha: 'c'.repeat(40) }] },
    })!;
    expect(annotation).toMatch(/^::warning title=Force-push over a reviewed branch \(K-MERGE-15\)::/);
    expect(annotation).not.toContain('\n');
    for (const s of ['review 11 by kanon-reviewer[bot] (APPROVED) on aaaaaaa', 'review 12 by a-human (COMMENTED) on ccccccc', 'aaaaaaa', 'bbbbbbb', '#7']) {
      expect(annotation).toContain(s);
    }
    expect(annotation).toMatch(/unless asked/);
    expect(summary).toContain('[review 11](https://example.test/r11)');
    expect(summary).toContain('[review 12](https://example.test/r12)');
  });

  it("encodes a review's text so it can't end the annotation or start a command of its own", () => {
    const r = { id: 13, user: { login: 'x%0A::error::y\nz' }, state: 'APPROVED' };
    const { annotation } = renderNotice({ before: BEFORE, after: AFTER, number: '7', result: { forced: true, reason: 'x', detached: [{ review: r, sha: BEFORE }] } })!;
    expect(annotation).not.toContain('\n');
    expect(annotation).toContain('x%250A::error::y%0Az');
  });

  it('renders nothing when no review was detached', () => {
    expect(renderNotice({ before: BEFORE, after: AFTER, number: '7', result: { forced: true, reason: 'x', detached: [] } })).toBeNull();
    expect(renderNotice({ before: BEFORE, after: AFTER, number: '7', result: { forced: false, reason: 'x', detached: [] } })).toBeNull();
  });

  const run = (env: Record<string, string>, reviews: () => ReturnType<typeof review>[]) => {
    const lines: string[] = [];
    const summaries: string[] = [];
    const code = main({ env, cwd: repo, readReviews: reviews, log: (l: string) => lines.push(l), appendSummary: (s: string) => summaries.push(s) });
    return { code, lines, summaries };
  };

  it('on a force-push over a review, prints the annotation, writes the summary, and exits 0', () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    const r = review(before);
    const { code, lines, summaries } = run({ BEFORE: before, AFTER: after, PR_NUMBER: '7', PR_AUTHOR: AUTHOR }, () => [r]);
    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith('::warning '))).toHaveLength(1);
    expect(lines.join('\n')).toContain(`review ${r.id} by a-reviewer (APPROVED)`);
    expect(summaries.join('')).toContain(`review ${r.id}`);
  });

  it('on a fast-forward, warns nothing and exits 0', () => {
    const before = commit('f.txt', 'one\n', 'one');
    const after = commit('f.txt', 'two\n', 'two');
    const { code, lines, summaries } = run({ BEFORE: before, AFTER: after, PR_NUMBER: '7', PR_AUTHOR: AUTHOR }, () => [review(before)]);
    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith('::warning'))).toEqual([]);
    expect(summaries).toEqual([]);
    expect(lines.join('\n')).toMatch(/not a force-push/);
  });

  it("when it can't tell, says so in a notice and exits 0", () => {
    const after = commit('f.txt', 'one\n', 'one');
    const { code, lines } = run({ BEFORE: 'e'.repeat(40), AFTER: after, PR_NUMBER: '7', PR_AUTHOR: AUTHOR }, () => []);
    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith('::notice '))).toHaveLength(1);
  });

  it("fails loudly when it can't read the pull request's reviews, rather than reporting none", () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    const { code, lines } = run({ BEFORE: before, AFTER: after, PR_NUMBER: '7', PR_AUTHOR: AUTHOR }, () => {
      throw new Error('HTTP 502');
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/::error .*HTTP 502/);
  });

  it("reads the reviews with gh, every page, when run as the workflow runs it", () => {
    const before = commit('f.txt', 'one\n', 'one');
    git('commit', '-q', '--amend', '-m', 'one, amended');
    const after = git('rev-parse', 'HEAD');
    const bin = join(dir, 'bin');
    const args = join(dir, 'gh-args');
    execFileSync('mkdir', ['-p', bin]);
    const pages = JSON.stringify([[review(before, { id: 41 })], [review(before, { id: 42 })]]);
    writeStub(join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > '${args}'\nprintf '%s' '${pages}'\n`);
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const out = spawnSync(process.execPath, [join(process.cwd(), 'scripts/force-push-notice.mjs')], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO: 'o/r', PR_NUMBER: '7', PR_AUTHOR: AUTHOR, BEFORE: before, AFTER: after, GITHUB_STEP_SUMMARY: summary },
    });
    expect(out.status).toBe(0);
    expect(readFileSync(args, 'utf8').trim()).toBe('api --paginate --slurp repos/o/r/pulls/7/reviews?per_page=100');
    expect(out.stdout).toContain('review 41 by a-reviewer');
    expect(out.stdout).toContain('review 42 by a-reviewer');
    expect(readFileSync(summary, 'utf8')).toContain('review 42');
  });
});

describe('K-MERGE-15 force-push-notice.yml runs the notice on every push to a pull request', () => {
  type Step = { id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: unknown };
  type Workflow = { on: unknown; permissions?: Record<string, string>; jobs: Record<string, { name?: string; if?: string; permissions?: unknown; steps: Step[] }> };
  const wf = parse(readFileSync('.github/workflows/force-push-notice.yml', 'utf8')) as Workflow;
  const jobs = Object.values(wf.jobs);
  const steps = jobs[0]!.steps;

  it('starts on a push to a pull request only, from one job that every push runs', () => {
    expect(wf.on).toEqual({ pull_request: { types: ['synchronize'] } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.if).toBeUndefined();
  });

  it('reads the code and the reviews, and writes nothing', () => {
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(jobs[0]!.permissions).toBeUndefined();
  });

  it("checks out the history with no credential kept, and runs Kanon's notice from `kanon-path` at an exact release", () => {
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@/);
    expect(steps[0]?.with?.['persist-credentials']).toBe(false);
    expect(steps[0]?.with?.['fetch-depth']).toBe(0);
    const kanon = steps.filter((s) => s.uses?.includes('kanon-path'));
    expect(kanon.map((s) => s.uses)).toEqual([expect.stringMatching(releasedUses('actions/kanon-path'))]);
    const runs = steps.filter((s) => s.run);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.run).toContain('node "$KANON/scripts/force-push-notice.mjs"');
    expect(runs[0]!.env?.KANON).toBe(`\${{ steps.${kanon[0]!.id}.outputs.path }}`);
    expect(steps.filter((s) => s['continue-on-error'])).toEqual([]);
  });

  it("hands the event's values to the script in its environment, and none of them to the shell", () => {
    const run = steps.find((s) => s.run)!;
    expect(run.run).not.toContain('${{');
    expect(run.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}',
      REPO: '${{ github.repository }}',
      PR_NUMBER: '${{ github.event.pull_request.number }}',
      PR_AUTHOR: '${{ github.event.pull_request.user.login }}',
      BEFORE: '${{ github.event.before }}',
      AFTER: '${{ github.event.after }}',
    });
  });

  it('checks nothing, and says so, at a pinned release that predates the notice', () => {
    const run = steps.find((s) => s.run)!;
    const kanon = mkdtempSync(join(tmpdir(), 'force-push-notice-pin-'));
    try {
      const out = spawnSync('bash', ['-c', run.run!], { encoding: 'utf8', env: { ...process.env, KANON: kanon } });
      expect(out.status).toBe(0);
      expect(out.stdout).toMatch(/^::notice .*predates/m);
    } finally {
      rmSync(kanon, { recursive: true, force: true });
    }
  });
});
