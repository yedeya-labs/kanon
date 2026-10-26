import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { comparePatch } from './helpers/compare-diff.js';
import { writeStub } from './helpers/stub-bin.js';
import { registerEnv } from './helpers/register.js';
import { SPAWNS } from './helpers/spawns.js';
import { wf, filter, GH_STUB, runFilter } from './helpers/implement-revise.js';

// Its cases run the lane's steps in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// The round cap, and what counts as a round. Split out of agent-implement-revise.test.ts (#1204);
// the fixtures are in tests/unit/helpers/implement-revise.ts.

describe('the round cap', () => {
  it.each([[0, true], [1, true], [2, false], [3, false]])('%i prior revisions -> acts: %s', (rounds, expected) => {
    expect(runFilter({ rounds }).act).toBe(expected);
  });

  it('warns loudly when it gives up, and names the way back', () => {
    const { stdout } = runFilter({ rounds: 2 });
    expect(stdout).toContain('::warning');
    expect(stdout).toContain('reset=true');
  });

  it('an explicit reset clears the cap', () => {
    expect(runFilter({ rounds: 3, isDispatch: true, reset: true }).act).toBe(true);
  });

  it('refuses to let a non-dispatch path clear the cap', () => {
    // A review event cannot set an input today — so only an adversarial fixture
    // can prove the IS_DISPATCH half is load-bearing rather than incidental.
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-adv-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary'), '');
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: 'true',
        STUB_META: JSON.stringify({ author: { login: 'app/example-author' }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [
          { author: { login: 'example-author' }, body: '<!-- qa:implement-revise -->' },
          { author: { login: 'example-author' }, body: '<!-- qa:implement-revise -->' },
        ] }),
      },
    });
    expect(r.status, `step aborted: ${r.output}`).toBe(0);
    expect(r.outputFile).toContain('act=false');
  });

  it('does not announce a bypass that never happened', () => {
    const { act, summary } = runFilter({ rounds: 0, isDispatch: true, reset: true });
    expect(act).toBe(true);
    expect(summary).not.toContain('Round cap cleared');
  });
});
describe('the round cap counts THE IMPLEMENTER', () => {
  it('filters the marker count by author, with the login inlined', () => {
    // The comment claimed "the Implementer's own marker comments" and the jq counted
    // anyone's — so a human quoting the marker while discussing the cap, or a
    // review doing so, would count as a round and stop the loop early.
    //
    // Inlined rather than passed with `--arg`, because `gh` has NO --arg
    // passthrough: it reads `--arg` as the jq expression. The stub caught that —
    // `jq: --arg takes two parameters` — which is the argument for a stub that
    // runs the real jq instead of pretending.
    expect(filter.run).toMatch(/author\.login/);
    expect(filter.run).toContain('$IMPL_LOGIN');
    // Deliberately NOT asserting the absence of the string `--arg`: the comment
    // above the jq explains why gh has no such passthrough, and an assertion that
    // forbids its own documentation is a guard against the wrong thing.
    expect(filter.run).not.toMatch(/--jq\s+--arg/);
    // And it normalises: `--json comments` returns the BARE slug while the other
    // two endpoints return `app/<slug>` and `<slug>[bot]` (RA-1007).
    expect(filter.run).toContain('^app/');
    // Escaped for jq's regex, so the literal brackets are backslash-separated.
    expect(filter.run).toContain('bot');
  });

  it('does not count a marker left by anyone else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-other-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary'), '');
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: 'app/example-author' }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        // Two markers, neither from the Implementer: a human discussing the cap, and the
        // reviewer quoting it. Under the old count this read as "cap reached".
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [
          { author: { login: 'a-developer' }, body: 'the marker is <!-- qa:implement-revise -->' },
          { author: { login: 'example-reviewer' }, body: '<!-- qa:implement-revise -->' },
        ] }),
      },
    });
    expect(r.status, `step aborted: ${r.output}`).toBe(0);
    expect(r.outputFile).toContain('act=true');
  });
});
describe('a deleted author does not abort the round count', () => {
  it('guards a null login before sub()', () => {
    // jq's sub() on null aborts the whole filter, so one ghost comment would fail
    // the job rather than skip the comment.
    // Escaped for the shell, so the literal is `.author.login // \"\"`.
    expect(filter.run).toContain('.author.login //');
  });

  it('counts correctly when a comment has no author', () => {
    const dir = mkdtempSync(join(tmpdir(), 'impl-revise-ghost-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary'), '');
    const r = runWorkflowStep(filter, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, KANON: process.cwd(),
        REPO: 'r', ...registerEnv(filter), PR: '1',
        STATE: 'changes_requested', IS_DISPATCH: 'false', RESET: '',
        STUB_META: JSON.stringify({ author: { login: 'app/example-author' }, state: 'OPEN', headRefName: 'b', labels: [{ name: 'agent:implement' }] }),
        STUB_REVIEWS: JSON.stringify({ reviews: [{ state: 'CHANGES_REQUESTED' }] }),
        STUB_COMMENTS: JSON.stringify({ comments: [
          { author: null, body: 'a comment whose author deleted their account' },
          { author: { login: 'example-author' }, body: '<!-- qa:implement-revise -->' },
        ] }),
      },
    });
    expect(r.status, `step aborted: ${r.output}`).toBe(0);
    const out = r.outputFile;
    expect(out).toContain('act=true');
    expect(out).toContain('round=2');
  });
});
describe('the cap binds on a round that left no marker (RA-969, RA-1099)', () => {
  /**
   * The cap was counted from a marker the AGENT is asked to leave, bounding the
   * agent's own iteration. Two ways that under-counts, both leaving the loop live:
   *
   *   • the round pushed and ended without the marker — max-turns, a failed `gh`, the
   *     model not doing the last step;
   *   • the marker landed where the counter cannot see it. `--json comments` is the
   *     GraphQL IssueComment connection — top-level comments only, no review bodies
   *     and no thread replies — while the prompt routes two exits to a "reply" (RA-1099).
   *
   * The loop is closed and re-fires on every push, so an unadvanced cap means two Opus
   * agents iterating without a bound. The floor is the REVIEWER's count — since RA-1841
   * the count of DISTINCT PATCHES he faulted, not of his reviews. That is weaker than
   * RA-969's "no agent behaviour changes it": the agent moves it by pushing content, and
   * a run that pushed and then crashed before leaving a marker used to raise neither
   * count. Since RA-1981 the WORKFLOW leaves the marker in that case — pinned by
   * `revise-round-record.test.ts`. The cases below are the floor's own half — a
   * reviewer faulting three DIFFERENT patches binds the cap whether or not a marker
   * was ever left.
   */
  it('stops after two reviewer requests even with ZERO markers', () => {
    // The RA-969 shape exactly: three CHANGES_REQUESTED reviews, no marker ever left.
    // Counted by markers this is round 0 and revise fires again, forever.
    expect(runFilter({ rounds: 0, changesRequested: 3 }).act).toBe(false);
  });

  it('still acts on a genuine first round', () => {
    // One CHANGES_REQUESTED — the one that triggered this run — is zero prior rounds.
    expect(runFilter({ rounds: 0, changesRequested: 1 }).act).toBe(true);
  });

  it('still acts on a second round', () => {
    expect(runFilter({ rounds: 0, changesRequested: 2 }).act).toBe(true);
  });

  it('takes the LARGER of the two counts, never the smaller', () => {
    // Biased toward over-counting, which is `dispatch-sweep`'s direction: stopping
    // early costs a dispatch, stopping late costs an unbounded loop. Markers ahead of
    // reviews must not be pulled down by the review floor.
    expect(runFilter({ rounds: 2, changesRequested: 1 }).act).toBe(false);
  });

  it('reports both numbers, so a disagreement between them is visible', () => {
    const { stdout } = runFilter({ rounds: 0, changesRequested: 3 });
    expect(stdout).toMatch(/markers=0/);
    expect(stdout).toMatch(/changes-requested=3/);
  });
});
describe('a content-free rebase is neither an answer nor a round (RA-1841)', () => {
  /**
   * PR RA-1822: THREE HEADS, ONE PATCH. Two of them came from GitHub's "Update branch"
   * button (`committer=Geoffry Nagy`, `author=claude[bot]`), and the effective patch at
   * each is identical apart from one hunk header and three context lines of base churn
   * in `scripts/qa/spec-coverage.mjs`. Both reads in this filter asked whether the SHA
   * moved rather than whether the CONTENT did, so both halves fired:
   *
   *   • the label path found no verdict on the new head and discarded a changes-request
   *     nobody had answered — `→ skipped (no changes-request stands on 68d5a8d …)`;
   *   • `REQUESTED` counted all three anyway, SHA-independently, so at 3 requests and 0
   *     markers `ROUNDS` reached the cap and the lane refused every further trigger.
   *
   * Together they stopped a PR the implementer had never once been dispatched on — a
   * cap whose stated purpose is bounding "an unbounded review->revise loop between two
   * Opus agents", fired having never invoked one of them.
   */

  it('keeps a changes-request standing when the head moved but the patch did not', () => {
    // The label path, on RA-1822's exact shape: one changes-request, on a commit the
    // head has since left behind without changing anything it faulted.
    expect(runFilter({ isLabel: true, headMoved: 'content-free', changesRequested: 1 }).act).toBe(true);
  });

  it('still lets a real push answer it, which is what the SHA check was protecting', () => {
    // The property that must survive: a label churn may not re-fire against a review
    // the implementer has already answered with a push. Here the head carries a
    // DIFFERENT patch from the reviewed commit, so nothing stands.
    const r = runFilter({ isLabel: true, headMoved: 'revised', changesRequested: 1 });
    expect(r.act).toBe(false);
    expect(r.summary).toContain('no changes-request stands');
  });

  it('counts three requests against one unchanged patch as ONE round, not three', () => {
    // RA-1822 measured: MARKED=0, REQUESTED=3 -> ROUNDS=2 -> capped, with the implementer
    // never dispatched. One distinct patch was faulted, so zero rounds were spent.
    const r = runFilter({ rounds: 0, changesRequested: 3, headMoved: 'content-free' });
    expect(r.act).toBe(true);
    expect(r.stdout).toContain('changes-requested=1 distinct of 3');
  });

  it('still reaches the cap when three DIFFERENT patches were faulted', () => {
    // The loop RA-969/RA-1099 closed stays closed: the reviewer floor still binds whenever
    // the implementer actually produced new content to fault.
    expect(runFilter({ rounds: 0, changesRequested: 3 }).act).toBe(false);
  });

  it('still counts a round the implementer spent DISAGREEING, which changes no content', () => {
    // The marker floor is what makes the content count safe to lower: a round that
    // pushed nothing is invisible to the patch, and visible to `MARKED`.
    expect(runFilter({ rounds: 2, changesRequested: 3, headMoved: 'content-free' }).act).toBe(false);
  });

  it('degrades to the SHA when the diff cannot be read, which is the old behaviour', () => {
    // FAILS TOWARD OVER-COUNTING. A deleted commit, a compare truncated at 300 files, a
    // 404 — none of them may LOWER the cap on a guess. Same three heads, same one
    // patch, but no readable diff: every head is its own round again.
    const r = runFilter({ rounds: 0, changesRequested: 3, headMoved: 'content-free', readableDiffs: false });
    expect(r.act).toBe(false);
    expect(r.stdout).toContain('changes-requested=3 distinct of 3');
  });

  it('reads the patch from the compare API, since this step runs before checkout', () => {
    // `git patch-id` is the right tool and is not reachable: the filter job has no
    // checkout on purpose, so an unrelated review costs Actions seconds rather than a
    // minted token and a clone. The signal has to come over the API.
    expect(filter.run).toContain('/compare/');
    expect(filter.run).toContain('vnd.github.v3.diff');
    expect(wf.jobs.filter.steps.some((s: { uses?: string }) => s.uses?.startsWith('actions/checkout'))).toBe(false);
  });

  it('asks the PR for the base the compare is rooted at', () => {
    // A three-dot compare against the base branch is what makes the patch at a commit
    // the base has since moved past still read as it was reviewed. Without
    // `baseRefName` in the META query the ref is empty and every fingerprint degrades
    // to its SHA — the defect back, silently, with the suite green on the diff lines.
    expect(filter.run).toContain('baseRefName');
    expect(filter.run).toContain('"$BASE_REF")...$sha');
  });

  // kanon#1432: unencoded, a `#` in the base began the URL's fragment, so the compare lost its
  // `...sha` half, and a `%` was decoded into another branch's name.
  it.each([
    ['main', 'main'],
    ['main#x', 'main%23x'],
    ['feat/a%2fb', 'feat/a%252fb'],
    ['rel/1.0', 'rel/1.0'],
  ])('sends the base %j whole, each segment percent-encoded', (baseRefName, path) => {
    const r = runFilter({ changesRequested: 2, baseRefName });
    expect(r.compares.length).toBeGreaterThan(0);
    const prefix = `repos/example-org/example-repo/compare/${path}...`;
    for (const c of r.compares) {
      expect(c.startsWith(prefix), c).toBe(true);
      expect(c.slice(prefix.length)).toMatch(/^[0-9a-z-]+$/);
    }
  });

  it('normalises away exactly what a rebase moves, and nothing else', () => {
    // index blob oids, hunk headers and context lines are base churn; the +/- lines and
    // the file headers are the change. Asserted on the fixture rather than on the shell,
    // so the two patches this suite calls "the same content" really are byte-different.
    const a = comparePatch({ content: 'rows.filter(Boolean)', churn: 'aa' });
    const b = comparePatch({ content: 'rows.filter(Boolean)', churn: 'cccccccc' });
    expect(a).not.toBe(b);
    expect(b).toContain('index cccccccc..bbbbbbb');
    expect(a.split('\n').filter((l) => /^[+-][^+-]/.test(l)))
      .toEqual(b.split('\n').filter((l) => /^[+-][^+-]/.test(l)));
  });
});
