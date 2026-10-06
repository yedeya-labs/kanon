import { asAgent } from './helpers/sign.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asOneWorkflow } from './helpers/kanon-lane.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
const { redUnreviewed, report } = await import('../../scripts/red-unreviewed.mjs');
import { ROOT } from './helpers/adopter.js';

/**
 * RA-1723 parts 2–3 — a PR that is red, stalled, and has no review verdict on its head is
 * REPORTED (never dispatched). Every arm below is one condition of that conjunction,
 * asserted both ways, plus the wiring and the no-action decision.
 */

const NOW = Date.parse('2026-09-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600e3).toISOString();
const HEAD = 'a'.repeat(40);

/** The RA-1719 shape: an implement PR, head pushed a day ago, no reviews. */
const pr = (o: Record<string, unknown> = {}) => ({
  number: 1719,
  state: 'OPEN',
  isDraft: false,
  labels: [{ name: 'agent:implement' }],
  headRefOid: HEAD,
  commits: [{ committedDate: hoursAgo(24) }],
  reviews: [],
  // What `hydrate` asks for (`CONFLICT_JSON`), so the default is a real read.
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  ...o,
});

const red = [
  { name: 'Integration (Postgres + RLS)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: hoursAgo(23) },
  { name: 'Build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: hoursAgo(23) },
];
const green = [{ name: 'Build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: hoursAgo(23) }];

const io = (checks: unknown[] = red, runs: unknown[] | null = []) => ({
  readChecks: () => checks,
  runsFor: () => runs,
  now: NOW,
  hours: 4,
});

describe('redUnreviewed — the conjunction', () => {
  it('flags the RA-1719 shape: red, a day old, no verdict', () => {
    const { flagged } = redUnreviewed([pr()], io());
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ number: 1719, sha: HEAD });
    expect(flagged[0].failed).toEqual(['Integration (Postgres + RLS) (FAILURE)']);
    expect(flagged[0].review).toBe('no review run has attempted this head');
  });

  it('is silent on a GREEN head', () => {
    expect(redUnreviewed([pr()], io(green)).flagged).toEqual([]);
  });

  it('is silent inside the stall window — CI and the Reviewer are still running', () => {
    expect(redUnreviewed([pr({ commits: [{ committedDate: hoursAgo(1) }] })], io()).flagged).toEqual([]);
    expect(redUnreviewed([pr({ commits: [] })], io()).flagged, 'undated is not stalled').toEqual([]);
  });

  it('is silent once the Reviewer has a VERDICT on this head — the revise lane owns it', () => {
    const verdict = { author: { login: 'example-reviewer' }, state: 'CHANGES_REQUESTED', commit: { oid: HEAD }, body: asAgent('example-reviewer', '') };
    expect(redUnreviewed([pr({ reviews: [verdict] })], io()).flagged).toEqual([]);
  });

  it('still flags when the only review is a COMMENT, or a verdict on an OLDER head', () => {
    const comment = { author: { login: 'example-reviewer' }, state: 'COMMENTED', commit: { oid: HEAD }, body: '' };
    const stale = { author: { login: 'example-reviewer' }, state: 'APPROVED', commit: { oid: 'b'.repeat(40) }, body: '' };
    expect(redUnreviewed([pr({ reviews: [comment] })], io()).flagged).toHaveLength(1);
    expect(redUnreviewed([pr({ reviews: [stale] })], io()).flagged).toHaveLength(1);
  });

  it('only examines pipeline PRs — no review label, not a draft', () => {
    expect(redUnreviewed([pr({ labels: [{ name: 'dependencies' }] })], io()).flagged).toEqual([]);
    expect(redUnreviewed([pr({ isDraft: true })], io()).flagged).toEqual([]);
  });

  it('uses merge-gate’s supersede: a failure re-run to success on the same head is green', () => {
    const rerun = [
      { name: 'check', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: hoursAgo(23) },
      { name: 'check', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: hoursAgo(22) },
    ];
    expect(redUnreviewed([pr()], io(rerun)).flagged).toEqual([]);
  });

  it('a CANCELLED check nothing superseded is red too — merge-gate treats it as blocking', () => {
    const cancelled = [{ name: 'Integration', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', completedAt: hoursAgo(23) }];
    expect(redUnreviewed([pr()], io(cancelled)).flagged[0]?.failed).toEqual(['Integration (CANCELLED)']);
  });

  it('pending is not red — CI still running is the pipeline working', () => {
    const pending = [{ name: 'E2E', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: null }];
    expect(redUnreviewed([pr()], io(pending))).toEqual({ flagged: [], unreadable: [], conflicting: [] });
  });

  it('an EMPTY rollup past the window is unreadable, never green — the short-scope trap', () => {
    expect(redUnreviewed([pr()], io([]))).toEqual({ flagged: [], unreadable: [1719], conflicting: [] });
  });

  it('an EMPTY rollup on a CONFLICTING PR says so, and names the rebase rather than the token', () => {
    const dirty = pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    const found = redUnreviewed([dirty], io([]));
    expect(found).toEqual({ flagged: [], unreadable: [], conflicting: [1719] });
    const text = report(found, { hours: 4 });
    expect(text).toMatch(/No checks, because conflicting:\*\* #1719/);
    expect(text).toMatch(/needs its base merged in/);
    expect(text).not.toMatch(/Could not read/);
  });

  it('a read that did not ask for the conflict fields is a code defect, not an unreadable PR', () => {
    const bare: Record<string, unknown> = { ...pr() };
    delete bare.mergeable;
    delete bare.mergeStateStatus;
    expect(() => redUnreviewed([bare], io([]))).toThrow(/conflictState/);
  });

  it('a review running NOW is not a stall', () => {
    const running = [{ id: 1, actor: 'x', event: 'workflow_run', status: 'in_progress', conclusion: null, createdAt: hoursAgo(0.1) }];
    expect(redUnreviewed([pr()], io(red, running)).flagged).toEqual([]);
  });

  it('the Lead labelling his own PR at creation is not a recovery attempt (RA-1714)', () => {
    const atCreation = [{ id: 1, actor: 'example-lead', event: 'pull_request_target', status: 'completed', conclusion: 'skipped', createdAt: hoursAgo(24) }];
    expect(redUnreviewed([pr()], io(red, atCreation)).flagged[0].review).toBe('no review run has attempted this head');
  });

  it('reports an unreadable rollup rather than reading it as green', () => {
    const boom = { ...io(), readChecks: () => { throw new Error('403'); } };
    const out = redUnreviewed([pr()], boom);
    expect(out.flagged).toEqual([]);
    expect(out.unreadable).toEqual([1719]);
  });
});

describe('what it says about the review', () => {
  it('distinguishes attempted, never attempted, and unknown', () => {
    const crashed = [{ id: 1, actor: 'someone', event: 'pull_request_target', status: 'completed', conclusion: 'failure', createdAt: hoursAgo(20) }];
    expect(redUnreviewed([pr()], io(red, crashed)).flagged[0].review).toMatch(/^a review WAS attempted/);
    expect(redUnreviewed([pr()], io(red, null)).flagged[0].review).toMatch(/UNKNOWN/);
  });

  it('the report names every flagged PR and says nothing is dispatched', () => {
    const text = report(redUnreviewed([pr()], io()), { hours: 4 });
    expect(text).toContain('PR #1719');
    expect(text).toMatch(/nothing is dispatched/);
    expect(report({ flagged: [], unreadable: [] }, { hours: 4 })).toMatch(/No open pipeline PR is red and unreviewed/);
  });
});

describe('the decision and the wiring', () => {
  const src = readFileSync(join(ROOT, 'scripts/red-unreviewed.mjs'), 'utf8');

  it('REPORT ONLY — it never edits, labels, comments or dispatches', () => {
    expect(src).not.toMatch(/'(?:edit|comment|merge)'|--add-label|--remove-label|workflow', 'run'|agent:fix-ci'/);
  });

  it('imports the three existing readers rather than writing a fourth', () => {
    expect(src).toMatch(/import \{ checkPartition, readPr \} from '\.\/merge-gate\.mjs'/);
    expect(src).toMatch(/from '\.\/review-run-evidence\.mjs'/);
    expect(src).toMatch(/from '\.\/review-recovery\.mjs'/);
    expect(src, 'no rollup read of its own').not.toMatch(/statusCheckRollup|check-runs/);
  });

  it('runs on the hourly lead-reconcile tick, with the workflow token', () => {
    const wf = asOneWorkflow('agent-lead-reconcile.yml') as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string; if?: string; env?: Record<string, string> }> }>;
    };
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
    const step = steps.find((s) => (s.run ?? '').includes('red-unreviewed.mjs'));
    expect(step, 'the detector is actually run').toBeTruthy();
    expect(step?.if).toContain('steps.unreviewed.outputs.parked');
    expect(step?.if, 'an earlier red step must not silence it').toContain('!cancelled()');
  });

  it('reads the rollup with a token that CAN see it — the App cannot', () => {
    // The Lead's App lacks `Checks: Read` / `Commit statuses: Read`, and a rollup read
    // without them comes back SHORT, not as an error: silently green forever.
    const raw = readFileSync(join(ROOT, '.github/workflows/agent-lead-reconcile.yml'), 'utf8');
    const wf = parse(raw) as { permissions: Record<string, string>; jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, string> }> }> };
    const step = Object.values(wf.jobs).flatMap((j) => j.steps ?? []).find((s) => (s.run ?? '').includes('red-unreviewed.mjs'));
    expect(step?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(wf.permissions.checks).toBe('read');
    expect(wf.permissions.statuses).toBe('read');
    expect(wf.permissions.actions).toBe('read');
  });
});
