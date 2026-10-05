import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { readFlattened } from './helpers/called-workflow.js';

/**
 * kanon#177 — the merge-reconcile lane skips its model pass when every latest review on
 * the merged head declares zero open items, and runs it on anything else.
 *
 * These EXECUTE the shipped `decide` step (RA-1032) against a `gh` stub that answers the
 * one read it makes, so the jq that decides is the workflow's own.
 */
const wf = readFlattened(join(process.cwd(), '.github/workflows/agent-merge-reconcile.yml'));
const decide = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'decide');
const review = readFlattened(join(process.cwd(), '.github/workflows/agent-review.yml'));

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

type Review = { author: { login: string }; state: string; submittedAt: string; body: string; commit: { oid: string } };
const rv = (over: Partial<Review> & { open?: number | null } = {}): Review => {
  const { open = 0, ...rest } = over;
  return {
    author: { login: 'example-reviewer' }, state: 'APPROVED', submittedAt: '2026-10-04T12:00:00Z',
    commit: { oid: HEAD },
    body: open === null ? 'Approve.' : `Approve.\n\n<!-- qa:open-items ${open} -->`,
    ...rest,
  };
};

const runDecide = (state: Record<string, unknown> | null) => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-reconcile-filter-'));
  // THE ANSWER IS A FILE THE STUB `cat`s, never text spliced into the stub's source: a
  // body carrying a backtick or a `$` would otherwise be run as shell, the stub would
  // print nothing, and the step would take its `could not read PR` skip (kanon#235 review).
  const answer = join(dir, 'answer.json');
  if (state !== null) writeFileSync(answer, JSON.stringify(state));
  writeStub(join(dir, 'gh'), state === null
    ? `#!/usr/bin/env bash\nexit 1\n`
    : `#!/usr/bin/env bash\ncat ${JSON.stringify(answer)}\n`);
  const r = runWorkflowStep(decide, {
    dir,
    env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 't', REPO: 'example-org/example-repo', PR: '177' },
  });
  return { ...r, run: /^run=(\w+)$/m.exec(r.outputFile)?.[1] ?? null };
};
/** Skipped BY THE GATE, named by its reason: every other skip path also says `run=false`. */
const skipsOnZero = (state: Record<string, unknown>) => {
  const r = runDecide(state);
  expect(r.run).toBe('false');
  expect(r.stdout).toMatch(/declares zero open items/);
};
const merged = (reviews: Review[], head: string | null = HEAD) =>
  ({ mergedAt: '2026-10-04T12:30:00Z', headRefOid: head, reviews });

describe('the open-items gate skips the model only on a declared zero (kanon#177)', () => {
  it('skips when the only review declares zero on the merged head, and says so on the run', () => {
    const r = runDecide(merged([rv()]));
    expect(r.status).toBe(0);
    expect(r.run).toBe('false');
    expect(r.stdout).toMatch(/declares zero open items/);
    expect(r.summary).toMatch(/\*\*Skipped:\*\* every latest review on `aaaaaaa` declares zero open items/);
  });

  it('runs when the review carries no marker — every review older than the marker', () => {
    const r = runDecide(merged([rv({ open: null })]));
    expect(r.run).toBe('true');
    // The reason, not only the outcome: a missing marker also fails open by way of a jq
    // error, and the log should say which it was.
    expect(r.stdout).toMatch(/carries no open-items marker/);
  });

  it('runs when the review declares open items', () => {
    const r = runDecide(merged([rv({ open: 2 })]));
    expect(r.run).toBe('true');
    expect(r.stdout).toMatch(/declares open items/);
  });

  it('runs when a commit landed after the zero was declared', () => {
    const r = runDecide(merged([rv({ commit: { oid: OLD } })]));
    expect(r.run).toBe('true');
    expect(r.stdout).toMatch(/read before the merged head/);
  });

  it('reads the commit from the stamp before `commit`, as the review lane does (RA-1680)', () => {
    // Filed under the head, read on an older commit: the stamp says what was read.
    const misfiled = rv({ body: `Approve.\n\n<!-- qa:open-items 0 -->\n\n<!-- reviewed: sha=${OLD} run=1 -->` });
    expect(runDecide(merged([misfiled])).run).toBe('true');
    // And a short stamp naming the head counts as the head.
    const short = rv({ commit: { oid: OLD }, body: `Approve.\n\n<!-- qa:open-items 0 -->\n\n<!-- reviewed: sha=${HEAD.slice(0, 7)} run=1 -->` });
    skipsOnZero(merged([short]));
  });

  it('runs when a review names no commit at all', () => {
    const bare: Partial<Review> = rv();
    delete bare.commit;
    expect(runDecide(merged([bare as Review])).run).toBe('true');
  });

  it('reads each author by their LATEST review, so an earlier count is superseded', () => {
    const earlier = rv({ open: 3, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-04T10:00:00Z', commit: { oid: OLD } });
    skipsOnZero(merged([earlier, rv()]));
    const later = rv({ open: 1, submittedAt: '2026-10-04T12:10:00Z' });
    expect(runDecide(merged([rv(), later])).run).toBe('true');
  });

  it('runs when any other author left a review without a marker — a person, or a thread reply', () => {
    const human = rv({ author: { login: 'a-person' }, state: 'COMMENTED', open: null, body: 'Why this way?' });
    expect(runDecide(merged([rv(), human])).run).toBe('true');
  });

  it('takes the LAST marker, so a quoted format does not decide the count', () => {
    const quotes = rv({ body: 'Discussing `<!-- qa:open-items 0 -->` in the prompt.\n\n<!-- qa:open-items 1 -->' });
    expect(runDecide(merged([quotes])).run).toBe('true');
    const quotesNonZero = rv({ body: 'An old run said <!-- qa:open-items 4 --> here.\n\n<!-- qa:open-items 0 -->' });
    skipsOnZero(merged([quotesNonZero]));
  });

  it('reads a body carrying backticks and `$` as text', () => {
    // Its only marker sits inside backticks, so a stub that ran the body as shell loses
    // it: bash 3.2 substitutes it away (no marker, so the model runs) and bash 5 fails the
    // whole line (no answer, so `could not read`). Read as text, it skips.
    skipsOnZero(merged([rv({ body: 'Keeps $HOME and $(true) literal, and ends `<!-- qa:open-items 0 -->`' })]));
  });

  it('runs when the merged head is unknown', () => {
    for (const head of [null, 'not-a-sha']) {
      const r = runDecide(merged([rv()], head));
      expect(r.run).toBe('true');
      expect(r.stdout).toMatch(/the merged head is unknown/);
    }
  });

  it('runs on an answer it cannot parse', () => {
    expect(runDecide({ mergedAt: '2026-10-04T12:30:00Z', headRefOid: HEAD, reviews: [{ body: 7 }] }).run).toBe('true');
  });

  it('keeps the earlier skips: unread, unmerged and unreviewed PRs never reach the gate', () => {
    const unread = runDecide(null);
    expect(unread.run).toBe('false');
    expect(unread.stdout).toMatch(/could not read PR 177/);
    const unmerged = runDecide({ mergedAt: null, headRefOid: HEAD, reviews: [rv({ open: 2 })] });
    expect(unmerged.run).toBe('false');
    expect(unmerged.stdout).toMatch(/PR not merged/);
    const unreviewed = runDecide(merged([]));
    expect(unreviewed.run).toBe('false');
    expect(unreviewed.stdout).toMatch(/no reviews to reconcile/);
  });
});

describe('the Reviewer is asked for the marker the gate reads (kanon#177)', () => {
  const prompt: string = review.jobs.review.steps.find((s: { id?: string }) => s.id === 'agent').with.prompt;

  it('demands the exact marker, on every verdict, counting un-applied and un-filed items', () => {
    expect(prompt).toContain('`<!-- qa:open-items N -->`');
    expect(prompt).toMatch(/every verdict/);
    expect(prompt).toMatch(/neither applied[\s\S]*nor filed/);
    expect(prompt).toMatch(/carried over/);
    expect(prompt).toMatch(/when unsure, count it/);
  });

  it('spells the marker as the gate parses it', () => {
    const example = prompt.match(/`(<!-- qa:open-items N -->)`/)![1]!.replace('N', '0');
    skipsOnZero(merged([rv({ body: `Approve.\n\n${example}` })]));
  });
});
