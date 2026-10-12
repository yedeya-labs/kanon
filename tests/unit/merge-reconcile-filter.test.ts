import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { readFlattened } from './helpers/called-workflow.js';

/**
 * kanon#177 — the merge-reconcile lane skips its model pass when every review on the PR is a
 * Reviewer verdict and the latest, read on the merged head, declares zero open items, and runs
 * it on anything else.
 *
 * These EXECUTE the shipped `decide` step (RA-1032) against a `gh` stub that answers its two
 * reads (the PR, and the App register), with `KANON` this tree, so what decides is the
 * workflow's own shell and `scripts/merge-reconcile-gate.mjs`. Each case of the decision itself
 * is in `merge-reconcile-gate.test.ts`.
 */
const ROOT = process.cwd();
const wf = readFlattened(join(ROOT, '.github/workflows/agent-merge-reconcile.yml'));
const decide = wf.jobs.filter.steps.find((s: { id?: string }) => s.id === 'decide');
const review = readFlattened(join(ROOT, '.github/workflows/agent-review.yml'));

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const REGISTER = '| Role | App slug |\n|---|---|\n| Reviewer | `example-reviewer` |\n| Merger | `example-reviewer` |\n';
const SIGNED = '**Reviewer** <!-- kanon:role=reviewer -->\n\n';

type Review = { id?: string; author: { login: string }; state: string; submittedAt: string; body: string; commit: { oid: string } };
const rv = (over: Partial<Review> & { open?: number | null } = {}): Review => {
  const { open = 0, ...rest } = over;
  return {
    id: 'PRR_1', author: { login: 'example-reviewer' }, state: 'APPROVED', submittedAt: '2026-10-04T12:00:00Z',
    commit: { oid: HEAD },
    body: open === null ? `${SIGNED}Approve.` : `${SIGNED}Approve.\n\n<!-- qa:open-items ${open} -->`,
    ...rest,
  };
};

const runDecide = (state: Record<string, unknown> | null, { register = REGISTER as string | null, kanon = ROOT } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-reconcile-filter-'));
  // THE ANSWERS ARE FILES THE STUB `cat`s, never text spliced into the stub's source: a
  // body carrying a backtick or a `$` would otherwise be run as shell, the stub would
  // print nothing, and the step would take its `could not read PR` skip (kanon#235 review).
  const answer = join(dir, 'answer.json');
  const reg = join(dir, 'register.md');
  if (state !== null) writeFileSync(answer, JSON.stringify(state));
  if (register !== null) writeFileSync(reg, register);
  const api = register === null ? 'exit 1' : `cat ${JSON.stringify(reg)}`;
  const view = state === null ? 'exit 1' : `cat ${JSON.stringify(answer)}`;
  writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\nif [ "$1" = api ]; then ${api}; else ${view}; fi\n`);
  const r = runWorkflowStep(decide, {
    dir,
    env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 't', REPO: 'example-org/example-repo', PR: '177', KANON: kanon },
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
  it('skips when the only review is a Reviewer verdict declaring zero on the merged head, and says so on the run', () => {
    const r = runDecide(merged([rv()]));
    expect(r.status).toBe(0);
    expect(r.run).toBe('false');
    expect(r.stdout).toMatch(/the Reviewer's latest verdict, on aaaaaaa, declares zero open items/);
    expect(r.summary).toMatch(/\*\*Skipped:\*\* the latest verdict the Reviewer \(`example-reviewer`\) posted/);
    expect(r.summary).toMatch(/- review `PRR_1`, APPROVED at 2026-10-04T12:00:00Z on `aaaaaaa`: `open-items 0`/);
  });

  it('runs when the review carries no marker — every review older than the marker', () => {
    const r = runDecide(merged([rv({ open: null })]));
    expect(r.run).toBe('true');
    // The reason, not only the outcome, so the log says which it was.
    expect(r.stdout).toMatch(/carries no open-items marker/);
    expect(r.summary).toBe('');
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

  it('skips when an earlier round requested changes and the latest verdict declares zero, the run the issue removes', () => {
    const earlier = rv({ id: 'PRR_0', open: 3, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-04T10:00:00Z', commit: { oid: OLD } });
    const r = runDecide(merged([earlier, rv()]));
    expect(r.run).toBe('false');
    expect(r.summary).toMatch(/- review `PRR_1`, APPROVED/);
    expect(r.summary).toMatch(/carried over from the Reviewer's 1 earlier verdict,/);
    expect(r.summary).not.toMatch(/PRR_0/);
  });

  it('runs when any other author left a review — a person, with or without a marker', () => {
    const human = rv({ author: { login: 'a-person' }, state: 'COMMENTED', open: null, body: 'Why this way?' });
    expect(runDecide(merged([rv(), human])).run).toBe('true');
    const claimsZero = rv({ author: { login: 'a-person' }, state: 'COMMENTED', body: `${SIGNED}<!-- qa:open-items 0 -->` });
    const r = runDecide(merged([claimsZero]));
    expect(r.run).toBe('true');
    expect(r.stdout).toMatch(/a review by `a-person` is not the Reviewer's verdict/);
  });

  it('runs when the Reviewer cannot be named: the App register is unreadable', () => {
    const r = runDecide(merged([rv()]), { register: null });
    expect(r.run).toBe('true');
    expect(r.stdout).toMatch(/the Reviewer's login is unknown/);
  });

  it('runs when the gate gives no answer: its script could not run', () => {
    const r = runDecide(merged([rv()]), { kanon: mkdtempSync(join(tmpdir(), 'no-kanon-')) });
    expect(r.status).toBe(0);
    expect(r.run).toBe('true');
    expect(r.stdout).toMatch(/the open-items gate gave no answer/);
  });

  it('reads a body carrying backticks and `$` as text', () => {
    // Its only marker sits inside backticks, so a stub that ran the body as shell loses
    // it: bash 3.2 substitutes it away (no marker, so the model runs) and bash 5 fails the
    // whole line (no answer, so `could not read`). Read as text, it skips.
    skipsOnZero(merged([rv({ body: `${SIGNED}Keeps $HOME and $(true) literal, and ends \`<!-- qa:open-items 0 -->\`` })]));
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
    skipsOnZero(merged([rv({ body: `${SIGNED}Approve.\n\n${example}` })]));
  });
});
