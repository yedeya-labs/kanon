import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeStub } from '../unit/helpers/stub-bin.js';
import { ESCALATE_PATHS } from './helpers/escalations.js';

const { appLogin } = await import('../../scripts/app-register.mjs');
const { headerLine, setMarkerPhase } = await import('../../scripts/lib/role-marker.mjs');
const { mergeVerdict, holdOn, readPr, ESCALATION_HEADER } = await import('../../scripts/merge-gate.mjs');
const { mergerMarker } = await import('../../scripts/lib/protocol-spellings.mjs');
const { classify, isSweepComment, MARKER } = await import('../../scripts/dispatch-sweep.mjs');
const { explorerQaComments } = await import('../../scripts/lead-reconcile.mjs');
const { briefPrs } = await import('../../scripts/brief-revise-recovery.mjs');
const { ineligible } = await import('../../scripts/rebase-lane.mjs');
const { reviewerVerdicts } = await import('../../scripts/incremental-review.mjs');
const { verdictOnHead } = await import('../../scripts/review-recovery.mjs');

/**
 * Plan 0005 step L3: every reader in §3.3's table reads the role marker beside today's login,
 * through `asRole` (`scripts/lib/role-marker.mjs`), and in this release answers exactly what
 * the login answers.
 *
 * Each reader runs against one object authored by the role's App three ways: with the role's
 * own marker, with ANOTHER role's marker, and with none. Under L3's phase (`additive`) the
 * three read the same, which is today's answer. The same three then run under L4's phase
 * (`required`): the role's own marker still reads as today, and the other two are what L4
 * flips, named per reader in `L4_FLIPS`. A reader that stops routing through `asRole` reads
 * the same under both phases and fails here.
 *
 * NOT IN THE TABLE, and why (§3.3): the reads of an event with no body carry no marker and stay
 * by login: the Merger's `needs:human` hold (`mergersHold`, the label's last actor), the
 * review lane's churn evidence (`reviewAttempts`, a run's actor), and the sweep's trigger
 * check (`makeSweepTriggerCheck`, a run's triggering actor).
 */

const HEAD = 'ee4530d1111111111111111111111111111111111'.slice(0, 40);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped library's role names
const login = (role: string) => `${appLogin(role as any)}[bot]`;
const own = (role: string, body = 'body') => `${headerLine(role)}\n\n${body}`;
const OTHER: Record<string, string> = { Implementer: 'Lead', Reviewer: 'Merger', Merger: 'Reviewer', Lead: 'Implementer', Explorer: 'Overseer' };
const variants = (role: string, body = 'body') => ({
  own: own(role, body),
  other: own(OTHER[role]!, body),
  none: body,
});
type Variant = keyof ReturnType<typeof variants>;

/** One reader: run it with the given author body, return what it decided, as a comparable value. */
type Reader = { role: string; read: (body: string) => unknown };

const NOW = Date.parse('2026-08-23T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const gatePr = (over: Record<string, unknown> = {}) => ({
  number: 1234, author: login('Implementer'), body: own('Implementer'), state: 'OPEN', isDraft: false,
  labels: ['agent:implement'], files: ['src/app/page.tsx'], headSha: HEAD,
  reviews: [{ state: 'APPROVED', sha: HEAD, author: login('Reviewer'), body: own('Reviewer') }],
  checks: [{ name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', rebaseAttempted: false,
  closing: { mergeClosesUndeclared: [], unverifiable: false }, workflowRuns: [],
  ...over,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fixture of the untyped library
const verdictOf = (p: any) => {
  const v = mergeVerdict(p, { escalations: ESCALATE_PATHS, now: NOW });
  return `${v.action}:${v.rule}`;
};

const READERS: Record<string, Reader> = {
  'merge-gate: the PR author (mergeVerdict)': {
    role: 'Implementer',
    read: (body) => verdictOf(gatePr({ body })),
  },
  'merge-gate: the Reviewer\'s verdicts (mergeVerdict)': {
    role: 'Reviewer',
    read: (body) => verdictOf(gatePr({ reviews: [{ state: 'APPROVED', sha: HEAD, author: login('Reviewer'), body }] })),
  },
  'merge-gate: the Merger\'s escalation comments (holdOn)': {
    role: 'Merger',
    read: (body) => {
      const comment = { login: login('Merger'), body: `${body.replace(/body$/, '')}${ESCALATION_HEADER}\n\n${mergerMarker('checks-failed', HEAD)}` };
      const gh = (args: string[]) => (String(args[1]).includes('/events')
        ? login('Merger')
        : JSON.stringify(comment));
      return holdOn(1, 'o/r', gh)?.escalations.length;
    },
  },
  'dispatch-sweep: the Implementer\'s comments (classify)': {
    role: 'Implementer',
    read: (body) => classify({ number: 1, title: 't', createdAt: ago(1000) },
      [{ login: login('Implementer'), createdAt: ago(300), body }], false, { now: NOW }).state,
  },
  'dispatch-sweep: the sweep\'s own comments (isSweepComment)': {
    role: 'Lead',
    // Without the sweep's MARKER, so only the login (and from L4 the role marker) can say it.
    // `classify` excludes these from the conversation, and while the Lead has its own App the
    // exclusion is invisible there (the Lead is a bot either way), so the predicate is read.
    read: (body) => isSweepComment({ login: appLogin('Lead'), body }),
  },
  'lead-reconcile: the Explorer\'s verification rounds (explorerQaComments)': {
    role: 'Explorer',
    read: (body) => explorerQaComments([{ author: { login: appLogin('Explorer') }, body: `${body}\n<!-- qa:verified -->` }]).length,
  },
  'brief-revise-recovery: the Lead\'s brief PRs (briefPrs)': {
    role: 'Lead',
    read: (body) => briefPrs([{ state: 'OPEN', author: { login: `app/${appLogin('Lead')}` }, body, files: [{ path: 'docs/projects/p.md' }] }]).length,
  },
  'rebase-lane: the Implementer\'s PRs (ineligible)': {
    role: 'Implementer',
    read: (body) => ineligible({ state: 'OPEN', author: { login: `app/${appLogin('Implementer')}` }, body, isDraft: false, labels: [{ name: 'agent:implement' }] }) === null,
  },
  'incremental-review: the Reviewer\'s verdicts (reviewerVerdicts)': {
    role: 'Reviewer',
    read: (body) => reviewerVerdicts([{ id: 1, user: { login: login('Reviewer') }, state: 'APPROVED', body }], appLogin('Reviewer')).length,
  },
  'review-recovery: the Reviewer\'s verdict on the head (verdictOnHead)': {
    role: 'Reviewer',
    read: (body) => verdictOnHead({ headRefOid: HEAD, reviews: [{ author: { login: login('Reviewer') }, state: 'APPROVED', body, commit: { oid: HEAD } }] }) !== null,
  },
};

/** What L4 flips: the variants whose answer changes under `required`. The same for every reader. */
const L4_FLIPS: Variant[] = ['other', 'none'];

afterEach(() => { setMarkerPhase('additive'); });

describe('plan 0005 L3: each reader of §3.3 reads the marker beside the login, and answers as today', () => {
  it.each(Object.entries(READERS))('%s: the three variants read the same in this release', (_, { role, read }) => {
    const v = variants(role);
    const today = read(v.none);
    expect(read(v.own)).toEqual(today);
    expect(read(v.other)).toEqual(today);
  });

  it.each(Object.entries(READERS))('%s: under L4\'s rule the own marker reads as today, and another\'s or none flips', (_, { role, read }) => {
    const v = variants(role);
    const today = read(v.none);
    setMarkerPhase('required');
    expect(read(v.own)).toEqual(today);
    for (const flip of L4_FLIPS) expect(read(v[flip]), `${flip} must flip at L4`).not.toEqual(today);
  });

  it('covers every reader §3.3 names that has a body to carry a marker', () => {
    expect(Object.keys(READERS)).toHaveLength(10);
  });
});

describe('the Merger reads the bodies its markers ride on', () => {
  it('readPr carries the PR body and each review\'s body into the verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-marker-readpr-'));
    try {
      const meta = {
        number: 1234, author: { login: login('Implementer') }, state: 'OPEN', isDraft: false,
        labels: [{ name: 'agent:implement' }], headRefOid: HEAD, statusCheckRollup: [],
        mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', title: 't', body: own('Implementer', 'Closes #1'),
        closingIssuesReferences: [{ number: 1 }], commits: [{ messageHeadline: 'x', messageBody: '' }],
      };
      const reviews = [{ id: 1, state: 'APPROVED', commit_id: HEAD, user: { login: login('Reviewer') }, body: own('Reviewer') }];
      writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  "pr view"*)           printf '%s' '${JSON.stringify(meta)}' ;;
  *"/files"*)           printf '%s\\n' 'src/a.ts' ;;
  *"/reviews"*)         printf '%s' '${JSON.stringify(reviews)}' ;;
  *"issues?per_page"*)  printf '%s' '0' ;;
  "run list"*)          printf '%s' '[]' ;;
esac
`);
      const read = readPr(1234, 'o/r', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      expect(read.body).toBe(meta.body);
      expect(read.reviews.map((r: { body?: string }) => r.body)).toEqual([own('Reviewer')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plan 0005 L3: the Merger refuses a pull request that touches docs/projects/', () => {
  it('escalates it as an escalating path, whatever the adopter\'s escalation file says', () => {
    const v = mergeVerdict(gatePr({ files: ['src/app/page.tsx', 'docs/projects/42.md'] }), { escalations: ESCALATE_PATHS, now: NOW });
    expect(v.action).toBe('escalate');
    expect(v.rule).toBe('escalating-path');
    expect(v.why).toContain('`docs/projects/42.md`');
  });

  it('merges the same pull request without the brief', () => {
    expect(verdictOf(gatePr())).toBe('merge:green-zone');
  });
});

describe('the sweep marker still counts on its own', () => {
  it('reads a comment carrying the sweep MARKER as the sweep\'s under both phases', () => {
    for (const phase of ['additive', 'required'] as const) {
      setMarkerPhase(phase);
      const v = classify({ number: 1, title: 't', createdAt: ago(1000) },
        [{ login: login('Lead'), createdAt: ago(100), body: `${MARKER}\nre-dispatching` }, { login: 'a-human', createdAt: ago(50), body: 'stop' }],
        false, { now: NOW });
      expect(v.state).toBe('human-held');
    }
  });
});
