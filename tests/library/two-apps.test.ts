import { describe, expect, it } from 'vitest';
import { ESCALATE_PATHS } from './helpers/escalations.js';

const { IMPLEMENTER_STATUS, headerLine } = await import('../../scripts/lib/role-marker.mjs');
const { ESCALATION_HEADER, MERGER_LOGIN, holdOn, mergeVerdict } = await import('../../scripts/merge-gate.mjs');
const { REVIEWER_LOGIN } = await import('../../scripts/review-recovery.mjs');
const { mergerMarker } = await import('../../scripts/lib/protocol-spellings.mjs');
const { ineligible } = await import('../../scripts/rebase-lane.mjs');
const { reviewerVerdicts } = await import('../../scripts/incremental-review.mjs');
const { verdictOnHead } = await import('../../scripts/review-recovery.mjs');
const { carryDecision, pickOpened } = await import('../../actions/implementer-status/implementer-status.mjs');

/**
 * Plan 0005 step L4: the falsifiable checks and mutations of the L4 row, in a repository whose
 * roles share two Apps, as §3.4's register gives them: the Author (Implementer, Lead, Explorer,
 * Overseer) and the Judge (Reviewer, Merger). Every reader below is handed those two logins,
 * so the login can't tell two roles of one App apart, and only the role marker and the
 * implementer status can.
 */

const AUTHOR = 'example-author';
const JUDGE = 'example-judge';
const OTHER_APP = 'example-ci';
const EMAIL = `1+${AUTHOR}[bot]@users.noreply.github.com`;
const HEAD = 'a'.repeat(40);
const START = 'b'.repeat(40);
const NOW = Date.parse('2026-10-05T12:00:00Z');

const stamp = (creator = `${AUTHOR}[bot]`, state = 'success') => ({ context: IMPLEMENTER_STATUS, state, creator });

/** An Author PR in every other respect in the green zone: approved by the Judge as the Reviewer, green, clean. */
const authorPr = (over: Record<string, unknown> = {}) => ({
  number: 7, author: `${AUTHOR}[bot]`, body: `${headerLine('Implementer')}\n\nCloses #3`, state: 'OPEN', isDraft: false,
  labels: ['agent:implement'], files: ['src/app/page.tsx'], headSha: HEAD,
  headStatuses: [stamp()],
  reviews: [{ state: 'APPROVED', sha: HEAD, author: `${JUDGE}[bot]`, body: `${headerLine('Reviewer')}\n\nApproved.` }],
  checks: [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', rebaseAttempted: false,
  closing: { mergeClosesUndeclared: [], unverifiable: false }, workflowRuns: [],
  ...over,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fixture of the untyped library
const verdict = (pr: any) => mergeVerdict(pr, { escalations: ESCALATE_PATHS, implementer: AUTHOR, reviewer: JUDGE, now: NOW });

describe('L4: the Merger\'s green zone is the Author App, marked `implementer`, with the implementer status', () => {
  it('merges the control: an Author PR marked `implementer` with the status the Author App set', () => {
    expect(verdict(authorPr()).action).toBe('merge');
  });

  it('refuses an Author PR marked `lead`, every other condition met', () => {
    expect(verdict(authorPr({ body: `${headerLine('Lead')}\n\nCloses #3` })).rule).toBe('not-the-implementer');
  });

  it('refuses a FORGED one: marked `implementer`, labelled `agent:implement`, on code paths, without the status', () => {
    const v = verdict(authorPr({ headStatuses: [] }));
    expect(v.rule).toBe('not-the-implementer');
    expect(v.why).toContain(IMPLEMENTER_STATUS);
  });

  it('refuses one whose status another App created, or whose newest status is not `success`', () => {
    expect(verdict(authorPr({ headStatuses: [stamp(`${OTHER_APP}[bot]`)] })).rule).toBe('not-the-implementer');
    // The NEWEST decides: a later status from another App is not outvoted by an older one.
    expect(verdict(authorPr({ headStatuses: [stamp(`${OTHER_APP}[bot]`), stamp()] })).rule).toBe('not-the-implementer');
    expect(verdict(authorPr({ headStatuses: [stamp(undefined, 'failure'), stamp()] })).rule).toBe('not-the-implementer');
    // A status on the context from the Judge, which holds Commit statuses read only, is not it either.
    expect(verdict(authorPr({ headStatuses: [stamp(`${JUDGE}[bot]`)] })).rule).toBe('not-the-implementer');
  });

  it('waits on an unread status list rather than reading it as none', () => {
    expect(verdict(authorPr({ headStatuses: null })).rule).toBe('statuses-unreadable');
  });

  it('takes a person\'s push out of the green zone: the new head carries no status', () => {
    // The real Implementer PR, after a person pushed `HEAD` onto it: the status was on the
    // commit before, and the carry step refuses to move it past a commit that isn't the App's.
    const carry = carryDecision({
      startHead: START, head: HEAD, slug: AUTHOR, email: EMAIL, startStatuses: [{ context: IMPLEMENTER_STATUS, state: 'success', creator: { login: `${AUTHOR}[bot]` } }],
      compare: { status: 'ahead', commits: [{ sha: HEAD, parents: [{ sha: START }], commit: { author: { email: 'a.person@example.com' } } }] },
    });
    expect(carry).toHaveProperty('none');
    expect(String((carry as { none: string }).none)).toContain('a person\'s push ends the chain');
    expect(verdict(authorPr({ headStatuses: [] })).rule).toBe('not-the-implementer');
  });
});

describe('L4: the implement lane stamps only the PR its own run opened', () => {
  const since = '2026-10-05T10:00:00Z';
  const pr = (number: number, ref: string, createdAt: string, sha: string) =>
    ({ number, created_at: createdAt, head: { ref, sha, repo: { full_name: 'o/r' } } });
  const appCommit = () => ({ sha: HEAD, commit: { author: { email: EMAIL } } });

  it('leaves a forged Author PR already open and saying `Closes #N` unstamped, and stamps the run\'s own', () => {
    // The forged PR was open before the run started, from a branch that already existed.
    const forged = pr(5, 'fix/3-forged', '2026-10-05T09:00:00Z', HEAD);
    const ours = pr(6, 'feat/3-thing', '2026-10-05T10:05:00Z', HEAD);
    // `heads`: what the run's agent job held after the agent (#324), its own branch's head.
    const picked = pickOpened({ prs: [forged, ours], repo: 'o/r', since, branchesBefore: ['main', 'fix/3-forged'], email: EMAIL, heads: [{ ref: 'feat/3-thing', sha: HEAD }], headCommit: appCommit });
    expect(picked).toEqual({ pr: 6, sha: HEAD });
    // So the forged PR's head has no status, and the Merger still refuses it.
    expect(verdict(authorPr({ number: 5, headStatuses: [] })).rule).toBe('not-the-implementer');
  });

  it('stamps neither of two candidates, and says so by number', () => {
    const a = pr(6, 'feat/3-a', '2026-10-05T10:05:00Z', HEAD);
    const b = pr(8, 'feat/3-b', '2026-10-05T10:06:00Z', HEAD);
    const picked = pickOpened({ prs: [a, b], repo: 'o/r', since, branchesBefore: ['main'], email: EMAIL, heads: [{ ref: 'feat/3-a', sha: HEAD }, { ref: 'feat/3-b', sha: HEAD }], headCommit: appCommit });
    expect(picked).toHaveProperty('none');
    expect(String((picked as { none: string }).none)).toMatch(/#6, #8/);
  });
});

describe('L4: implement-revise and the rebase lane refuse a forged PR, so neither launders it', () => {
  const forged = (over: Record<string, unknown> = {}) => ({
    state: 'OPEN', author: { login: `app/${AUTHOR}` }, body: `${headerLine('Implementer')}\n\nCloses #3`,
    isDraft: false, labels: [{ name: 'agent:implement' }], headStatuses: [], ...over,
  });

  it('the rebase lane refuses it by name, and accepts the real one', () => {
    expect(ineligible(forged(), { implementer: AUTHOR })).toMatch(/not provably the Implementer's: it carries no `kanon\/role: implementer` status/);
    expect(ineligible(forged({ headStatuses: [stamp(`${OTHER_APP}[bot]`)] }), { implementer: AUTHOR })).toMatch(/not provably the Implementer's/);
    expect(ineligible(forged({ headStatuses: null }), { implementer: AUTHOR })).toMatch(/could not be read/);
    expect(ineligible(forged({ headStatuses: [stamp()] }), { implementer: AUTHOR })).toBeNull();
  });

  it('even were it pushed to, the carry step sets no status on its new head, and the Merger still refuses it', () => {
    const carry = carryDecision({
      startHead: START, head: HEAD, slug: AUTHOR, email: EMAIL, startStatuses: [],
      compare: { status: 'ahead', commits: [{ sha: HEAD, parents: [{ sha: START }], commit: { author: { email: EMAIL } } }] },
    });
    expect(String((carry as { none: string }).none)).toContain('the chain has no start');
    expect(verdict(authorPr({ headStatuses: [] })).rule).toBe('not-the-implementer');
  });
});

describe('L4: the Judge plays the Reviewer and the Merger, told apart by the marker', () => {
  const review = (role: string, state = 'APPROVED') => ({ state, sha: HEAD, author: `${JUDGE}[bot]`, body: `${headerLine(role)}\n\nVerdict.` });

  it('counts a Judge review marked `reviewer` as the Reviewer\'s', () => {
    expect(verdict(authorPr({ reviews: [review('Reviewer')] })).action).toBe('merge');
    expect(reviewerVerdicts([{ id: 1, user: { login: `${JUDGE}[bot]` }, state: 'APPROVED', body: review('Reviewer').body }], JUDGE)).toHaveLength(1);
  });

  it('does not count a Judge post with the Merger\'s marker as the Reviewer\'s', () => {
    expect(verdict(authorPr({ reviews: [review('Merger')] })).action).not.toBe('merge');
    expect(reviewerVerdicts([{ id: 1, user: { login: `${JUDGE}[bot]` }, state: 'APPROVED', body: review('Merger').body }], JUDGE)).toHaveLength(0);
    // `verdictOnHead` reads the register's Reviewer row; the login is that row's, the marker the Merger's.
    expect(verdictOnHead({ headRefOid: HEAD, reviews: [{ author: { login: REVIEWER_LOGIN }, state: 'APPROVED', body: review('Merger').body, commit: { oid: HEAD } }] })).toBeNull();
  });
});

describe('L4: the Merger lifts `needs:human` only on its own lapsed escalations (§3.3, the `holdOn` row)', () => {
  // A label event has no body, so its actor (the Judge) can't say which role applied it.
  // Lifting needs the Merger's own escalations, every one about a head that is gone.
  const held = (escalations: Array<{ rule: string, sha: string }>) =>
    authorPr({ labels: ['agent:implement', 'needs:human'], hold: { labeledBy: `${MERGER_LOGIN}[bot]`, escalations } });

  it('does not lift a `needs:human` the Judge applied with no Merger escalation on the PR at all', () => {
    const v = verdict(held([]));
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('escalating-label');
  });

  it('lifts one whose Merger escalations are all about other heads (`escalation-lapsed`)', () => {
    expect(verdict(held([{ rule: 'checks-failed', sha: START.slice(0, 12) }])).rule).toBe('escalation-lapsed');
  });

  it('keeps one whose Merger escalation is about the current head', () => {
    expect(verdict(held([{ rule: 'checks-failed', sha: HEAD.slice(0, 12) }])).rule).toBe('escalating-label');
  });

  it('reads the escalations from the Merger\'s marker, never from a Reviewer-marked comment of the same App', () => {
    const comment = (role: string) => ({ login: `${MERGER_LOGIN}[bot]`, body: `${headerLine(role)}\n\n${ESCALATION_HEADER}\n\n${mergerMarker('checks-failed', START)}` });
    const gh = (comments: unknown[]) => (args: string[]) => (String(args[1]).includes('/events')
      ? `${MERGER_LOGIN}[bot]`
      : comments.map((c) => JSON.stringify(c)).join('\n'));
    expect(holdOn(7, 'o/r', gh([comment('Merger')]))?.escalations).toHaveLength(1);
    expect(holdOn(7, 'o/r', gh([comment('Reviewer')]))?.escalations).toEqual([]);
  });
});
