import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkflowStep } from '../unit/helpers/workflow-step.js';
import { asOneWorkflow, readCaller, readKanonLane } from './helpers/kanon-lane.js';
const { CONFLICT_WHY, ConflictFieldsUnread } = await import('../../scripts/conflict-state.mjs');
import { readRepoDoc } from './helpers/adopter-doc.js';
const { SPLIT_LABEL } = await import('../../scripts/split-lineage.mjs');
const { itemSatisfied, satisfiedTitles, classifyDeploy, readDeploy: kanonReadDeploy, closingMergeShas, isReviewBlocked, awaitingReview, dependencyCycles, needsVerification, verificationCaveat, declaresMembership, findDeployRun, nextActions, reachesPhase6, renderCloseAction, renderCloseComment, ownFailureCaveat, DEPLOY_PHASE, reconcileAll, report, retro, parseProposed, phaseOf, readBudget, reviewRecovery, chargeable, reviseRecovery, reviseRunsFor, startedAfter, standingChangesRequest, projectReviews, execute, qaIssueOf, hold, renderHoldComment, applyDecision, repoLabels, ghCause, redactSecrets, isTransient, holdMarker, occupiesSlot, isParkedOnHuman, linkedPrsRead, laneStateOf, adoptedProvenance, HUMAN_ACTION, carriedOut, inDecomposition, isProjectWork, SPEC_FINDING, FINDING_ANCHOR, openGatingWork, blockedOf, labelMirror, mirrorLabels, mirrorCap, projectLabel, qaIssueTitle, isQaIssueTitle } = await import('../../scripts/lead-reconcile.mjs');
import { writeStub } from '../unit/helpers/stub-bin.js';
import { ROOT } from './helpers/adopter.js';
/** A value of the untyped library, as the reference adopter's helper named it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibraryValue = any;

/**
 * The reference environment's deploy as the reference adopter declares it (plan 0004 P6). The
 * reconciler reads it from the adoption record on the default branch; these tests hand it in,
 * so `readDeploy` reads no record over the network.
 */
const DECLARED = { environment: 'staging', workflow: 'deploy-staging.yml', job: 'deploy' };
const readDeploy = (issues: LibraryValue, io: Record<string, unknown> = {}) => kanonReadDeploy(issues, { declared: () => DECLARED, ...io });

/**
 * RA-955 — the Lead's reconcile tick.
 *
 * The tick's whole safety argument is that state is DERIVED, so the decision is a
 * pure function of the world it read. That makes the decision testable without
 * GitHub, which is the point: the failure modes here are all "acted when it should
 * not have" — dispatched past a WIP cap, routed around a blocked issue, re-filed
 * something already filed, or re-labelled work already in progress.
 */

/**
 * Build the world the way `readWorld` does — brief first, issues joined onto it by
 * title — rather than by hand.
 *
 * This is the fix for the defect these tests missed. The old helper took an
 * arbitrary `extra`, so tests passed `order` and `dependsOn` straight in and
 * constructed a shape the derivation could NOT produce: the sort compared
 * undefined to undefined and was a no-op, the dependency filter was vacuously
 * true, and both tests passed anyway. Third time this session that a fixture was
 * written to the code instead of to reality (RA-925, RA-929, here).
 */
/**
 * RA-1208 — THIS SUITE MUST NOT WRITE INTO THE REAL CI JOB SUMMARY.
 *
 * `report()` appends its rendered text to `$GITHUB_STEP_SUMMARY` when that variable is
 * set, and GitHub Actions sets it for EVERY step. So every `report(...)` here wrote a
 * fabricated the Lead reconcile tick — for a tracking project that does not exist — into
 * the `Lint · Typecheck · Unit` job's own summary, on every CI run. Reproduced at the
 * time: 1442 bytes, opening `## the Lead — reconcile tick, project RA-42`.
 *
 * That is the misleading-operational-surface class this whole file's subject exists to
 * remove, produced by its own tests. It also made the suite non-hermetic — its side
 * effects depended on ambient CI env.
 *
 * FILE-WIDE, not scoped to the two calls RA-1199 added: `report` is now reached from
 * several describes and `reconcileAll` reaches it indirectly, so a narrow stub is a
 * thing to remember at exactly the moment a new test forgets it. The guard below fails
 * if this is ever removed while the variable is set.
 */
const REAL_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
beforeAll(() => { delete process.env.GITHUB_STEP_SUMMARY; });
afterAll(() => {
  if (REAL_STEP_SUMMARY === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  else process.env.GITHUB_STEP_SUMMARY = REAL_STEP_SUMMARY;
});

describe('this suite is isolated from the real step summary (RA-1208)', () => {
  it('never lets report() reach $GITHUB_STEP_SUMMARY', () => {
    // Vacuous locally, load-bearing in CI — which is the only place the variable is
    // set, and the only place the defect was reachable.
    expect(process.env.GITHUB_STEP_SUMMARY ?? '').toBe('');
  });
});

const KEYS = 'ABCDEFGH';
/** The shape a real brief uses (PR RA-964), not the one-liner it replaced. */
const BRIEF = (titles: string[], milestone: string | null = 'Product Backlog', deps: Record<number, string> = {}) =>
  ['# Brief', '', '## Decomposition', '',
    ...titles.flatMap((t, i) => [
      `### Issue ${KEYS[i]} — ${t}`,
      '',
      milestone ? `**Milestone:** ${milestone} · **Labels:** \`pipeline-improvement\`` : '**Labels:** `pipeline-improvement`',
      ...(deps[i] ? ['', `**Depends on:** Issue ${deps[i]} (because)`] : []),
      '',
      'It does a thing.',
      '',
    ]),
  ].join('\n');

/** Mirrors readWorld's join, so a test cannot invent a field production lacks. */
const worldFrom = (brief: string, issues: Array<{ number: number; title: string; state?: string; labels?: string[]; closedAt?: string; body?: string }> = []) => {
  const proposed = parseProposed(brief);   // carries body/labels/dropped* for the guards
  const all: Array<Record<string, unknown>> = issues.map((i) => {
    // MIRRORS readWorld's join — by title OR by adoption. Re-implementing only the
    // title half is what let `does not adopt twice` pass over a deadlock: the harness
    // proved a copy of the join rather than the join, so a defect in the real one was
    // invisible here (RA-1213 review).
    const fromBrief = proposed.find((p: { title: string }) => p.title === i.title)
      ?? proposed.find((p: { closes?: number[] }) => (p.closes ?? []).includes(i.number));
    return {
      state: 'OPEN',
      labels: [],
      ...i,
      order: fromBrief?.order,
      key: fromBrief?.key,
      dependsOnKeys: fromBrief?.dependsOnKeys ?? [],
      briefTitle: fromBrief?.title,
    };
  });
  // Mirrors readWorld's key→number resolution, so a test cannot invent a
  // dependency the derivation could not produce.
  const byKey = new Map(all.filter((i) => i.key).map((i) => [i.key, i.number]));
  for (const i of all) {
    i.dependsOn = (i.dependsOnKeys as string[]).map((k) => byKey.get(k)).filter((n) => n != null);
    i.unfiledDeps = (i.dependsOnKeys as string[]).filter((k) => !byKey.has(k));
  }
  const open = all.filter((i) => i.state === 'OPEN');
  return {
    project: '952',
    briefMerged: true,
    briefPath: 'docs/projects/952.md',
    proposed,
    filed: all,
    open,
    // Mirrors readWorld: only a member that gates closure can block (RA-1783).
    blocked: blockedOf(open, proposed),
    unmilestoned: proposed.filter((p: { milestone: string | null }) => !p.milestone),
    all,
    searchHits: all.length,
  };
};

const world = (o: Partial<Record<string, unknown>> = {}) => ({
  ...worldFrom(BRIEF([])),
  ...o,
});
const issue = (number: number, labels: string[] = []) =>
  ({ number, title: `t${number}`, state: 'OPEN', labels });

describe('phaseOf', () => {
  it('does nothing until the developer has merged the brief', () => {
    // The brief IS the gate. A tick that files issues before it is approved would
    // make the gate retrospective.
    expect(phaseOf(world({ briefMerged: false, proposed: [{ title: 'x' }] }))).toBe('awaiting-brief');
  });

  it('files while the brief proposes more than has been filed', () => {
    expect(phaseOf(world({ proposed: [{ title: 'a' }, { title: 'b' }], filed: [issue(1)] }))).toBe('file');
  });

  it('reconciles once everything is filed and something is open', () => {
    // Through the real join: the filed issue must carry the brief's own title, or
    // the file phase correctly reports there is still something to file.
    expect(phaseOf(worldFrom(BRIEF(['a']), [{ number: 1, title: 'a' }]))).toBe('reconcile');
  });

  it('is NOT complete merely because every filed issue has closed (RA-1056)', () => {
    // Closed is not deployed. Treating them as the same is how a project reports
    // itself done while its code sits in a merge no release has picked up.
    expect(phaseOf(worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]))).toBe('awaiting-release');
  });

  it('stops entirely when a human owes an answer', () => {
    // Routing around a blocked issue would make the project look like it is
    // progressing while the question that stalled it goes unanswered.
    const b = issue(1, ['qa:needs-info']);
    expect(phaseOf(world({ proposed: [{ title: 'a' }], filed: [b], open: [b], blocked: [b] }))).toBe('blocked');
  });
});

describe('filing', () => {
  it('files only what the brief proposes and has not been filed', () => {
    // Through the real join. Hand-building `proposed: [{title:'a'}]` produces
    // issues with no body, which the empty-body guard correctly refuses — a world
    // the parser cannot produce, caught by the guard rather than by review.
    const { actions } = nextActions(worldFrom(BRIEF(['a', 'b']), [{ number: 1, title: 'a' }]));
    expect(actions.map((a: { title: string }) => a.title)).toEqual(['b']);
  });

  it('decides the file phase by TITLE, so a hand-filed issue cannot suppress a real one', () => {
    // `filed.length < proposed.length` compared counts while nextActions compared
    // titles. One `Part of #N` issue the brief never named made `2 >= 2` skip the
    // file phase, and "b" was never filed — then the project reported `complete`.
    const w = worldFrom(BRIEF(['a', 'b']), [
      { number: 1, title: 'a' },
      { number: 7, title: 'hand-filed by a human' },
    ]);
    expect(phaseOf(w)).toBe('file');
    expect(nextActions(w).actions.map((a: { title: string }) => a.title)).toEqual(['b']);
  });

  it('is idempotent — a re-run after a tick that died files nothing twice', () => {
    const w = world({ proposed: [{ title: 'a' }], filed: [{ ...issue(1), title: 'a' }] });
    expect(nextActions(w).actions).toEqual([]);
  });
});

describe('dispatching', () => {
  // Built through the real join, not by hand: `filed` must carry the titles the
  // brief proposes, because that is the only world readWorld can produce — and the
  // file phase now decides by title, so a mismatched fixture is a fiction.
  const THREE = BRIEF(['a', 'b', 'c']);
  const filed = [
    { number: 1, title: 'a' }, { number: 2, title: 'b' }, { number: 3, title: 'c' },
  ];
  const base = worldFrom(THREE, filed);

  it('dispatches up to the default WIP cap of 3, in brief order', () => {
    // 1 during the pilot, 3 since the Merger (RA-965). At 1 the cap was not a throughput
    // limit but a SERIALISATION: one issue that stopped moving stopped the project,
    // and with an autonomous merger the ways an issue stops multiply — anything
    // touching the pipeline, payments, auth, the schema or infrastructure is
    // escalated to a developer who is checking in every couple of days by design.
    const { actions } = nextActions({ ...base });
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ kind: 'dispatch', number: 1 });
  });

  it('stops dispatching once the cap is full', () => {
    // Each dispatch is a full the Implementer run; the cap is a quota control as much as a
    // quality one. Asserted at the cap rather than at 1, so raising the default
    // again cannot make this test vacuous.
    const open = base.open.map((i) => ({ ...i, labels: ['agent:implement'] }));
    const r = nextActions({ ...base, open }, { wip: open.length });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/WIP cap/);
  });

  it('honours a cap lower than the default', () => {
    expect(nextActions({ ...base }, { wip: 2 }).actions).toHaveLength(2);
    expect(nextActions({ ...base }, { wip: 1 }).actions).toHaveLength(1);
  });

  it('never re-labels an issue already dispatched', () => {
    // Re-labelling re-fires the implementer on work already in progress.
    const open = [{ ...base.open[0], labels: ['agent:implement'] }];
    expect(nextActions({ ...base, open }, { wip: 5 }).actions).toEqual([]);
  });

  it('skips an issue a human has parked with qa:needs-info', () => {
    const open = [{ ...base.open[0], labels: ['qa:needs-info'] }, base.open[1]];
    const { actions } = nextActions({ ...base, open, blocked: [] });
    expect(actions[0]).toMatchObject({ number: 2 });
  });

  it('dispatches in the BRIEF order, not the order the search returned', () => {
    // Derived, not injected: `order` is joined from the brief by title, exactly as
    // readWorld does. Issue #9 is listed first by the search but is second in the
    // brief, so #4 must go first. Against the pre-fix code this is a coin flip,
    // because the sort compared undefined to undefined.
    const w = worldFrom(BRIEF(['first', 'second']), [
      { number: 9, title: 'second' },
      { number: 4, title: 'first' },
    ]);
    expect(nextActions(w).actions[0]).toMatchObject({ number: 4 });
  });

  it('holds an issue whose declared dependency is still open', () => {
    // Derived from `**Depends on:** Issue A`, not injected. B and C both wait for
    // A; with A open only A is eligible.
    const w = worldFrom(BRIEF(['a', 'b', 'c'], 'Product Backlog', { 1: 'A', 2: 'A' }), [
      { number: 1, title: 'a' }, { number: 2, title: 'b' }, { number: 3, title: 'c' },
    ]);
    expect(nextActions(w, { wip: 3 }).actions.map((a: { number: number }) => a.number)).toEqual([1]);
  });

  it('unblocks the dependants together once the dependency closes', () => {
    // The real brief's shape: C "runs in parallel with B", both gated on A.
    const w = worldFrom(BRIEF(['a', 'b', 'c'], 'Product Backlog', { 1: 'A', 2: 'A' }), [
      { number: 1, title: 'a', state: 'CLOSED' }, { number: 2, title: 'b' }, { number: 3, title: 'c' },
    ]);
    expect(nextActions(w, { wip: 3 }).actions.map((a: { number: number }) => a.number)).toEqual([2, 3]);
  });

  it('reports the held issues when a dependency blocks everything', () => {
    // Reaches the `held` path specifically: an issue eligible-but-waiting rather
    // than merely capped, so `stopped` must name it and why. A LINEAR dependency —
    // this fixture used a mutual one, which since RA-977 is reported as a cycle
    // rather than as a wait, and so no longer exercises the held path at all.
    // #1 is already in flight, so it is not eligible; #2 waits on it. Nothing to
    // dispatch, and `stopped` must say which issue is waiting and on what.
    const w = worldFrom(BRIEF(['a', 'b'], 'Product Backlog', { 1: 'A' }), [
      { number: 1, title: 'a', labels: ['agent:implement'] }, { number: 2, title: 'b' },
    ]);
    const r = nextActions(w, { wip: 5 });
    expect(r.actions).toEqual([]);
    expect(r.stopped ?? '').toMatch(/#2 waits on #1/);
  });

  it('calls a dependency CYCLE a brief defect, not a wait (RA-977)', () => {
    // The same fixture that used to prove the held path, and the reason this issue
    // exists: a cycle rendered the identical sentence a legitimate wait produces,
    // so the surface could not tell "waiting correctly" from "will never proceed" —
    // hourly, green, forever. It is decidable from the brief alone, which is the
    // standard the neighbouring `unfiledDeps` case already applies.
    const w = worldFrom(BRIEF(['a', 'b'], 'Product Backlog', { 0: 'B', 1: 'A' }), [
      { number: 1, title: 'a' }, { number: 2, title: 'b' },
    ]);
    const r = nextActions(w, { wip: 5 });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/dependency cycle/i);
    expect(r.stopped, 'a cycle can never clear, and the report must say so').toMatch(/brief defect|can ever be eligible/i);
    // It escalates rather than only printing: a warning nobody reads is what this
    // failure mode already was.
    expect(r.escalate?.length, 'a permanent stall must reach a human').toBeGreaterThan(0);
  });

  it('never returns zero actions without saying which issues it held', () => {
    // Every other zero-action path sets `stopped`. This one did not, so a deadlock
    // rendered as "Nothing to do this tick. That is a finding, not an absence" —
    // hourly, green, indefinitely, in the surface this design offers as its answer
    // to silent-absence.
    const w = worldFrom(BRIEF(['a', 'b'], 'Product Backlog', { 1: 'A' }), [
      { number: 1, title: 'a', labels: ['agent:implement'] },
      { number: 2, title: 'b' },
    ]);
    const r = nextActions(w, { wip: 1 });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toBeTruthy();
  });

  it('calls an unresolvable dependency a brief defect, not a wait', () => {
    // By the reconcile phase every proposed issue is filed, so a key naming
    // nothing names nothing that will ever exist.
    // Derived, not injected: the brief names Issue F, and no issue is filed for it.
    const brief = ['# Brief', '', '## Decomposition', '',
      '### Issue A — a', '', '**Milestone:** Product Backlog', '',
      '**Depends on:** Issue F (which the brief never defines)', ''].join('\n');
    const w = worldFrom(brief, [{ number: 1, title: 'a' }]);
    const r = nextActions(w);
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/brief defect, not a wait/);
  });

  it('puts an issue the brief does not name last rather than first', () => {
    // A hand-filed issue carrying `Part of #N` has no ordinal. `?? Infinity` keeps
    // it from silently jumping the queue, which `?? 0` would have done.
    const w = worldFrom(BRIEF(['planned']), [
      { number: 7, title: 'filed by a human' },
      { number: 8, title: 'planned' },
    ]);
    expect(nextActions(w).actions[0]).toMatchObject({ number: 8 });
  });

  it('stops rather than continuing when the tick budget is spent', () => {
    const r = nextActions({ ...base }, { budgetLeft: 0 });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/budget/);
  });

  it('SLICES the file phase by the budget — the one unbounded loop', () => {
    // Wired to a constant, the guard could never fire: 6 <= 0 is never true. It
    // now bounds the only genuinely unbounded thing a tick does — the file phase
    // returned EVERY unfiled issue at once.
    const w = worldFrom(BRIEF(['a', 'b', 'c', 'd']));
    const r = nextActions(w, { budgetLeft: 2 });
    expect(r.actions).toHaveLength(2);
    expect(r.stopped).toMatch(/filing 2 of 4/);
  });

  it('resolves a malformed budget env to NO budget, in both directions', () => {
    // `Number('')` is 0 — read as "exhausted", every tick would stop green forever.
    // `Number('x')` is NaN, and `NaN <= 0` is false — the guard silently off. The
    // ambiguity is resolved at the env boundary so `nextActions` can keep 0
    // meaning exhausted, which is what it means in a real countdown.
    expect(readBudget('')).toBe(Infinity);
    expect(readBudget(undefined)).toBe(Infinity);
    expect(readBudget('x')).toBe(Infinity);
    expect(readBudget('0')).toBe(Infinity);
    expect(readBudget('-3')).toBe(Infinity);
    expect(readBudget('6')).toBe(6);
  });
});

describe('the guards on what actually gets filed', () => {
  /**
   * Filing is a run-once, unamendable transformation — the file phase dedups by
   * title, so a corrected script never re-files or repairs what a bad parse
   * produced. Three review rounds found defects in heuristics that dropped
   * something silently, each fix creating the next round's edge. These guards sit
   * on the OUTPUT instead, which is what ends that sequence: a wrong heuristic
   * becomes a refusal to file rather than a permanent GitHub issue.
   */
  const file = (lines: string[]) => {
    const proposed = parseProposed(lines.join('\n'));
    return nextActions({
      project: '1', briefMerged: true, briefPath: 'p', proposed,
      filed: [], open: [], blocked: [],
      unmilestoned: proposed.filter((p: { milestone: string | null }) => !p.milestone),
      all: [], searchHits: 0,
    });
  };

  it('refuses to file an issue whose body did not survive the parse', () => {
    // A lowercase opening sentence reads as a metadata continuation, so the body
    // is emptied — and the filed issue would carry no acceptance criteria at all
    // while the implementer is dispatched onto it.
    const r = file(['## Decomposition', '### Issue A — a', '**Milestone:** X',
      'the whole body is one lowercase sentence.']);
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/EMPTY body/);
  });

  it('refuses when a label is welded to prose, instead of losing it', () => {
    // The previous shape filter dropped the token silently. Before that, the bad
    // token reached `gh issue create --label`, which REJECTS it — loud, and the
    // issue is not filed. The filter turned a loud failure into a quiet one, and
    // `sev:critical` is exactly the signal RA-729/RA-730 exist to retrofit.
    const r = file(['## Decomposition', '### Issue A — a',
      '**Milestone:** X · **Labels:** `follow-up` Closes #897', '', 'Real body.']);
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/not labels/);
  });

  it('does NOT refuse on a legitimately dropped metadata continuation', () => {
    // The real brief wraps its `**Depends on:**` line. Blocking on any dropped
    // line would refuse the only real artifact in existence — so a dropped line is
    // reported, and the empty-body guard is what catches a heuristic that ate
    // something load-bearing.
    const r = file(['## Decomposition', '### Issue A — a', '**Milestone:** X',
      '**Depends on:** Issue B (a thing), and the PR', 'continuation here.', '', 'Real body.']);
    expect(r.actions).toHaveLength(1);
  });

  it('files the real brief cleanly — all four issues, no refusal', () => {
    const proposed = parseProposed(readFileSync(join(ROOT, 'tests/fixtures/brief-decomposition.md'), 'utf8'));
    const r = nextActions({
      project: '961', briefMerged: true, briefPath: 'p', proposed,
      filed: [], open: [], blocked: [], unmilestoned: [], all: [], searchHits: 0,
    });
    expect(r.actions).toHaveLength(4);
    expect(r.stopped).toBeUndefined();
  });
});

describe('the milestone fail-closed guard', () => {
  it('refuses to file anything when a proposed issue names no milestone', () => {
    // AGENTS.md: no issue is filed without one. Filing bare would let the
    // default-milestone backstop route it to Product Backlog, which reads as
    // correctly triaged and stops showing up in the query that finds mistakes.
    const w = worldFrom(BRIEF(['a', 'b'], null));
    const r = nextActions(w);
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/no milestone/);
  });

  it('carries the brief\'s milestone onto the action', () => {
    const w = worldFrom(BRIEF(['a'], 'Production Ready'));
    expect(nextActions(w).actions[0]).toMatchObject({ kind: 'file', milestone: 'Production Ready' });
  });
});

describe('parseProposed — derived from the first real brief (PR RA-964)', () => {
  /**
   * The format this replaces — `- [ ] **Title** — summary — milestone: X` — was
   * invented the same afternoon and the first real brief disagreed within hours:
   * it parsed ZERO items, and a good 640-line brief would have been reported
   * `brief-unparseable`. RA-949's argument, proven on n=1.
   *
   * These tests run against the ACTUAL decomposition section of that brief,
   * checked in as a fixture, so the parser is pinned to a real artifact rather
   * than to another guess about one.
   */
  const REAL = readFileSync(join(ROOT, 'tests/fixtures/brief-decomposition.md'), 'utf8');

  it('parses every issue out of the real brief', () => {
    const p = parseProposed(REAL);
    expect(p.map((x: { key: string }) => x.key)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('reads the milestone off its own metadata line, not a trailing marker', () => {
    // `**Milestone:** Production Ready · **Labels:** ...` — the separator is a
    // middle dot and labels follow on the same line.
    const p = parseProposed(REAL);
    expect(p.map((x: { milestone: string | null }) => x.milestone)).toEqual([
      'Development Automation', 'Production Ready', 'Development Automation', 'Production Ready',
    ]);
  });

  it('files the issue\'s whole section, not a one-line summary', () => {
    // "First non-metadata paragraph" returned the string `Acceptance criteria:` —
    // a colon-terminated section label — on THREE of the four issues in the only
    // real brief that exists. Three GitHub issues whose entire body is a label,
    // with the implementer dispatched onto them, and nothing to correct them
    // afterwards because the file phase dedups by title.
    const p = parseProposed(REAL);
    for (const issue of p) {
      expect(issue.body, `Issue ${issue.key}`).not.toMatch(/^[A-Z][a-z ]+:$/);
      expect(issue.body.length, `Issue ${issue.key}`).toBeGreaterThan(120);
    }
    // And the criteria the implementer builds to are actually in there.
    expect(p.find((x: { key: string }) => x.key === 'B')!.body).toMatch(/\[PAY-1\]/);
  });

  it('drops a wrapped metadata line, not just its first line', () => {
    // The real brief wraps "**Depends on:** Issue A (…), and on the PR RA-869 /
    // disposition (decision 1)." across two lines, so filtering only lines that
    // START with the marker left "disposition (decision 1)." as the filed issue's
    // opening sentence.
    const b = parseProposed(REAL).find((x: { key: string }) => x.key === 'B')!;
    expect(b.body).not.toMatch(/^disposition/);
    expect(b.body).not.toMatch(/decision 1/);
  });

  it('keeps a body line that follows the metadata with no blank line', () => {
    // The wrapped-`**Depends on:**` fix skipped every non-blank line until a blank
    // one, so prose written directly under the metadata was eaten — the fix
    // over-reached into the thing it was protecting.
    const md = ['## Decomposition', '### Issue A — a', '**Milestone:** X',
      'This body line follows immediately.', '', 'More body.'].join('\n');
    expect(parseProposed(md)[0].body).toMatch(/^This body line follows immediately\./);
  });

  it('still drops a WRAPPED metadata continuation', () => {
    const md = ['## Decomposition', '### Issue A — a',
      '**Depends on:** Issue B (needs the thing), and on the PR #869',
      'disposition (decision 1).', '', 'Real body.'].join('\n');
    expect(parseProposed(md)[0].body).toBe('Real body.');
  });

  it('takes every label, not just the first', () => {
    // `·` separates labels from each other AND metadata fields from each other, so
    // stopping at the first one dropped every label after it.
    const md = ['## Decomposition', '### Issue A — a',
      '**Milestone:** X · **Labels:** `sev:high` · `follow-up`'].join('\n');
    expect(parseProposed(md)[0].labels).toEqual(['sev:high', 'follow-up']);
  });

  it('does not turn trailing prose into a label', () => {
    // The real brief writes "**Labels:** `sev:critical` · **Closes RA-897; supersedes
    // the caller-side guards in PR RA-869**" — that clause is prose.
    const md = ['## Decomposition', '### Issue A — a',
      '**Milestone:** X · **Labels:** `sev:critical` · **Closes #897; supersedes the guards**'].join('\n');
    expect(parseProposed(md)[0].labels).toEqual(['sev:critical']);
  });

  it('captures the labels the brief chose', () => {
    // Prompted for, parsed AROUND, and dropped — so `sev:critical` on Issue B was
    // read and discarded. A label added later is a label nobody adds.
    expect(parseProposed(REAL).map((x: { labels: string[] }) => x.labels)).toEqual([
      ['pipeline-improvement'], ['sev:critical'], ['pipeline-improvement'], ['follow-up'],
    ]);
  });

  it('reads the dependencies the brief actually declared', () => {
    // `dependsOn` was deleted hours earlier on the grounds that "nothing parses a
    // dependency from a brief". The first author wrote them unprompted on three of
    // four issues, and WIP-1 order is wrong without them.
    const p = parseProposed(REAL);
    expect(p.map((x: { dependsOnKeys: string[] }) => x.dependsOnKeys)).toEqual([[], ['A'], ['A'], ['B']]);
  });

  it('keeps the issues in brief order, which is dispatch order', () => {
    expect(parseProposed(REAL).map((x: { order: number }) => x.order)).toEqual([0, 1, 2, 3]);
  });

  it('does not truncate at the `### Issue` headings themselves', () => {
    // The terminator was `#{1,4}`, so `###` ended the section — and `###` is the
    // very level the issues live at, so the section ended at its own first issue.
    expect(parseProposed(REAL).length).toBeGreaterThan(1);
  });

  it('counts what it did NOT take, so a partial parse cannot read as the whole', () => {
    // The parser takes only `### Issue X — Title`. Anything written slightly
    // differently is dropped, and as long as ONE sibling parses the tick proceeds
    // on a partial list, files a prefix, and reports `complete`. Same outcome as
    // the truncation bug, through a different door — and MORE likely now, because
    // this format is n=1.
    const deeper = ['## Decomposition', '### Issue A — a', '**Milestone:** X',
      '#### Issue B — b', '### Issue C — c', '**Milestone:** X'].join('\n');
    const p = parseProposed(deeper) as unknown as { residue: string[] };
    expect(parseProposed(deeper).map((x: { key: string }) => x.key)).toEqual(['A', 'C']);
    expect(p.residue).toHaveLength(1);
    expect(phaseOf(world({ proposed: parseProposed(deeper) }))).toBe('brief-partially-parsed');
  });

  it('allows an ordinary sub-heading inside an issue body', () => {
    // The prompt leaves the issue body to the author — "everything else about the
    // format stays yours" — so `#### Acceptance criteria` is legitimate structure.
    // Counting any deeper heading as residue stalled the tick and asked a human to
    // delete real content from an approved brief. Depth alone is not the signal.
    const md = ['## Decomposition', '### Issue A — a', '**Milestone:** X',
      '#### Acceptance criteria', '1. thing',
      '### Issue B — b', '**Milestone:** X'].join('\n');
    const p = parseProposed(md) as unknown as { residue: string[] };
    expect(parseProposed(md).map((x: { key: string }) => x.key)).toEqual(['A', 'B']);
    expect(p.residue).toEqual([]);
  });

  it('still catches a deeper heading that IS an issue', () => {
    // Shape, not just depth: `#### Issue B — b` is a decomposition item written one
    // level too deep, and dropping it silently is the bug the residue count exists
    // for. Narrowing by depth alone reopened it.
    const md = ['## Decomposition', '### Issue A — a', '**Milestone:** X',
      '#### Issue B — b', '### Issue C — c', '**Milestone:** X'].join('\n');
    expect(phaseOf(world({ proposed: parseProposed(md) }))).toBe('brief-partially-parsed');
  });

  it('catches a title separator the contract does not describe', () => {
    const colon = ['## Decomposition', '### Issue A: a', '### Issue B — b', '**Milestone:** X'].join('\n');
    expect(phaseOf(world({ proposed: parseProposed(colon) }))).toBe('brief-partially-parsed');
  });

  it('catches a brief still written to the OLD one-liner contract', () => {
    // A brief authored against the previous prompt uses `- [ ] **Title** — …`.
    // Silently taking zero of them and one heading would be the same failure.
    const mixed = ['## Decomposition', '### Issue A — a', '**Milestone:** X',
      '- [ ] **Old style** — from the previous contract'].join('\n');
    expect(phaseOf(world({ proposed: parseProposed(mixed) }))).toBe('brief-partially-parsed');
  });

  it('leaves the real brief with no residue', () => {
    const p = parseProposed(readFileSync(join(ROOT, 'tests/fixtures/brief-decomposition.md'), 'utf8')) as unknown as { residue: string[]; endedAt: string };
    expect(p.residue).toEqual([]);
    expect(p.endedAt).toBeTruthy();     // the report prints this; it must be derived
  });

  it('harvests dependencies from the issue references, not the prose', () => {
    // The whole `**Depends on:**` line was scanned, so an incidental "Issue F" in
    // the explanation became a permanent dependency on nothing. The real fixture
    // survives only by luck: Issue C says "Runs in parallel with B", not "with
    // Issue B".
    const md = ['## Decomposition', '### Issue A — a', '**Milestone:** X',
      '**Depends on:** Issue B (see also Issue F for context)'].join('\n');
    expect(parseProposed(md)[0].dependsOnKeys).toEqual(['B']);
  });

  it('says WHY when a decomposition does not parse, rather than just failing', () => {
    // `reason` is a non-enumerable property on the array, so it does not disturb
    // `toEqual` comparisons of the items themselves.
    const noHeading = parseProposed('# Brief\n\nprose') as unknown as { reason: string | null };
    const noIssues = parseProposed('## Decomposition\n\nprose only') as unknown as { reason: string | null };
    expect(String(noHeading.reason)).toMatch(/no Decomposition heading/);
    // The message names BOTH accepted forms, because it is what a future author
    // reads when a parse fails — and naming only the unnumbered one is how RA-1046
    // survived: the prompt, the fixture and the error all agreed with each other
    // and disagreed with the brief.
    expect(String(noHeading.reason)).toMatch(/## 3\. Decomposition/);
    expect(String(noIssues.reason)).toMatch(/no `### Issue X/);
  });

  it('ignores an issue-shaped heading outside the decomposition section', () => {
    const md = ['## Decomposition', '', '### Issue A — real', '', '**Milestone:** X', '',
      '## Out of scope', '', '### Issue Z — not ours', '', '**Milestone:** X'].join('\n');
    expect(parseProposed(md).map((x: { key: string }) => x.key)).toEqual(['A']);
  });
});

describe('the tick workflow', () => {
  const wf = asOneWorkflow('agent-lead-reconcile.yml');

  it('closes the cascade AND carries a heartbeat', () => {
    // The cascade (a merged PR fires the next tick) is what makes this
    // self-driving; the heartbeat is what makes it survive an event that never
    // arrives — the class behind RA-378 and RA-912.
    expect(Object.keys(wf.on).sort()).toEqual(['issues', 'pull_request', 'schedule', 'workflow_dispatch']);
    expect(wf.on.pull_request.types).toEqual(['closed']);
    expect(wf.on.schedule).toEqual([{ cron: '25 * * * *' }]);
  });

  it('serialises ticks, because two would derive the same world and act twice', () => {
    expect(wf.concurrency.group).toBe('agent-lead-reconcile');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  // BY IDENTITY, NOT POSITION. These four asserted about `steps.at(-1)` and about
  // `steps.slice(2)`, which held only while the reconcile step happened to be last and
  // the pre-filters happened to be the first two. RA-1595 appended a second pre-filter
  // and a second acting step, and two of these assertions did not fail — they silently
  // moved onto the NEW last step and passed about it, which is the failure mode the
  // `agentStep` helper exists to stop one file over.
  const reconcileStep = wf.jobs.tick.steps.find((s: { name?: string }) => s.name === 'Reconcile');
  const preFilters = ['Is there a project to reconcile?', 'Is a brief PR parked on an unanswered review?', 'Is any PR parked with no review?'];

  it('pre-filters before minting a token, so an idle heartbeat costs no tokens', () => {
    // §8's biggest cost lever: most heartbeats have nothing to do. THREE subjects since
    // RA-1689 — an open project; a brief PR parked on an unanswered review, which belongs
    // to no project the first pre-filter can enumerate; and any review-labelled PR
    // parked with no review at all, which belongs to neither — so the invariant is that
    // every step past them is gated on a pre-filter's OUTPUT, and that on an idle tick
    // every one of those outputs is empty.
    const names = wf.jobs.tick.steps.map((s: { name?: string; uses?: string }) => s.name ?? s.uses);
    for (const f of preFilters) expect(names.indexOf(f)).toBeLessThan(names.indexOf('Mint lead App token'));
    const last = Math.max(...preFilters.map((f) => names.indexOf(f)));
    for (const st of wf.jobs.tick.steps.slice(last + 1)) {
      expect(st.if, `${st.name ?? st.uses} must be gated on a pre-filter`).toMatch(/steps\.(scope|briefs|unreviewed)\.outputs\./);
    }
  });

  it('gates the expensive steps on EITHER subject, so neither starves the other', () => {
    // A tick with a parked brief PR and no open project must still mint a token, and a
    // tick with a project and no brief PR must still reconcile it.
    const mint = wf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'app-token');
    expect(mint.if).toContain("steps.scope.outputs.project != ''");
    expect(mint.if).toContain("steps.briefs.outputs.parked != ''");
    // RA-1689 — a tick whose ONLY subject is a PR parked with no review must still mint.
    // This lane is the one most likely to be the only one: it needs no open project and
    // no brief PR, just a labelled PR whose review never landed.
    expect(mint.if).toContain("steps.unreviewed.outputs.parked != ''");
    expect(reconcileStep.if).toBe("steps.scope.outputs.project != ''");
  });

  it('uses the App token, without which the cascade cannot fire', () => {
    // Events raised by the default GITHUB_TOKEN never trigger another workflow, so
    // labelling with it would start nothing.
    expect(reconcileStep.env.GH_TOKEN).toContain('app-token');
  });

  it('grants issues:read, without which the pre-filter denies its own read', () => {
    // A permissions block sets every unlisted scope to `none`. Without this the
    // pre-filter's `gh issue view` 403s on this private repo, the failure is
    // swallowed, `project` comes back empty, and every automatic path goes inert
    // while the run stays green. The previous assertion here was
    // `toEqual({ contents: 'read' })` — pinning the defect in place.
    expect(wf.permissions.issues).toBe('read');
    expect(wf.permissions.contents).toBe('read');
  });

  it('does not swallow a failed ISSUE read', () => {
    // Narrow on purpose: `ls docs/projects/*.md 2>/dev/null` is fine — a missing
    // directory means no projects. What must never be swallowed is the `gh issue
    // view`, because treating a denied read as "no project" is what made every
    // automatic path inert while the run stayed green.
    const step = wf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'scope');
    const issueRead = step.run.split('\n').find((l: string) => l.includes('gh issue view'));
    expect(issueRead).toBeDefined();
    expect(issueRead).not.toContain('2>/dev/null');
    expect(issueRead).not.toContain('|| echo');
    expect(step.run).toContain('::error');
  });

  it('names a slug brief it cannot reconcile, rather than dropping it silently', () => {
    // readWorld keys the whole project off a numeric tracking issue, so a
    // slug-named brief can never be reconciled — and the pre-filter's numeric
    // grep dropped it without a word, printing "no project to reconcile" with a
    // merged brief sitting in the directory.
    const step = wf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'scope');
    expect(step.run).toContain('non-numeric brief file');
  });

  it('picks projects numerically and names the ones it skipped', () => {
    // Glob order is lexical: `1010.md` sorts before `952.md`, so the lower project
    // would starve — silently, without the warning.
    const step = wf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'scope');
    expect(step.run).toContain('sort -n');
    expect(step.run).toContain('skipped this tick');
  });

  it('passes the tick budget the guard needs', () => {
    // The budget was defined, guarded and tested while main() never passed it — so
    // the bound the PR body claimed was unreachable.
    expect(reconcileStep.env.QA_LEAD_TICK_BUDGET).toBeTruthy();
  });

  it('applies on a cascade or heartbeat, and dry-runs a bare manual dispatch', () => {
    expect(reconcileStep.env.APPLY).toContain("github.event_name != 'workflow_dispatch'");
    expect(wf.on.workflow_dispatch.inputs.apply.default).toBe(false);
  });

  it('gives the brief-PR recovery the same dry-run rule (RA-1595)', () => {
    // A churn re-fires an Opus agent, so a bare manual dispatch must not do it by
    // accident — the same rule the reconcile step follows, on the same input.
    const recovery = wf.jobs.tick.steps.find((s: { name?: string }) => s.name?.includes('Re-deliver a parked brief PR'));
    expect(recovery.env.APPLY).toContain("github.event_name != 'workflow_dispatch'");
  });
});


describe('the pre-filter, executed (RA-1032)', () => {
  /**
   * This step exited 1 on EVERY run for two weeks — 16 failures, 0 successes, from
   * the day RA-956 merged until the pilot brief was merged and nothing happened.
   *
   * The cause was a `grep` in a status-bearing position:
   *
   *   nonnumeric="$(ls docs/projects/*.md | … | grep -vE '^[0-9]+$' | tr '\n' ' ')"
   *
   * `grep -v` exits 1 when it matches NOTHING, which is exactly the case where
   * every brief filename is well-formed. `set -e` takes an assignment's status from
   * its substitution, and `pipefail` carries the failure past the trailing `tr`. So
   * the guard against a malformed brief succeeded only when a malformed brief
   * existed, and killed the step the rest of the time.
   *
   * Every prior assertion about this workflow was a string match on its source, and
   * none of them could see it. These EXECUTE the step.
   */
  const wf = asOneWorkflow('agent-lead-reconcile.yml');
  const scope = wf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'scope');

  const runScope = ({ briefs, openIssues }: { briefs: string[]; openIssues: number[] }) => {
    const dir = mkdtempSync(join(tmpdir(), 'lead-scope-'));
    mkdirSync(join(dir, 'docs/projects'), { recursive: true });
    for (const b of briefs) writeFileSync(join(dir, 'docs/projects', b), '# brief\n');
    // `gh issue view <n> --json state --jq .state`
    writeStub(join(dir, 'gh'),
      `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in [0-9]*) n="$a"; break;; esac; done\ncase " ${openIssues.join(' ')} " in *" $n "*) echo OPEN;; *) echo CLOSED;; esac\n`);
    const r = runWorkflowStep(scope, {
      dir,
      cwd: dir,
      env: { PATH: `${dir}:${process.env.PATH}`, INPUT_PROJECT: '' },
    });
    return { status: r.status, stdout: r.stdout, project: r.outputs.project ?? null };
  };

  it('picks the open project when every brief is well-formed', () => {
    // The exact state on main the moment RA-964 merged. Before the fix: exit 1.
    const r = runScope({ briefs: ['961.md'], openIssues: [961] });
    expect(r.status).toBe(0);
    expect(r.project).toBe('961');
  });

  it('exits 0 with no project when there are no briefs at all', () => {
    // The state for the two weeks before any brief existed — also a red run.
    const r = runScope({ briefs: [], openIssues: [] });
    expect(r.status).toBe(0);
    expect(r.project).toBe('');
  });

  it('still warns about a non-numeric brief, and keeps going', () => {
    const r = runScope({ briefs: ['961.md', 'order-settlement.md'], openIssues: [961] });
    expect(r.status).toBe(0);
    expect(r.project).toBe('961');
    expect(r.stdout).toContain('order-settlement');
  });

  it('orders numerically, not lexically', () => {
    // UPDATED BY RA-1447, deliberately. This asserted `'952'` — that the lower project
    // was PICKED and the other dropped. Every open project is now emitted, so the
    // property this case exists for is the ORDER, which still matters: it is the order
    // the shared tick budget is consumed in, and `1010.md` sorts before `952.md`
    // lexically. Starvation is no longer the failure mode; consuming the budget in
    // glob order would be.
    const r = runScope({ briefs: ['1010.md', '952.md'], openIssues: [952, 1010] });
    expect(r.project).toBe('952,1010');
  });

  it('skips a project whose tracking issue is closed', () => {
    const r = runScope({ briefs: ['961.md'], openIssues: [] });
    expect(r.status).toBe(0);
    expect(r.project).toBe('');
  });
});




describe('phases 4 and 6 — deploy watch, then close (RA-1056)', () => {
  // Phase 6 is only reachable once QA PASSED — a CLOSED QA issue (RA-1063). Tests
  // that are about phase 4 or 6 pass this so phase 5 does not intercept.
  const qaPassed = { number: 2000, state: 'CLOSED', rounds: 1, lastVerifiedAt: '2026-08-26T20:00:00Z' };

  const allClosed = (extra: Record<string, unknown> = {}) => ({
    ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
    project: '961',
    ...extra,
  });

  describe('phase 4 — the work is closed, but is it on staging?', () => {
    const CASES: Array<[Record<string, unknown> | undefined, string]> = [
      [undefined, 'awaiting-release'],
      [{ state: 'awaiting-release' }, 'awaiting-release'],
      [{ state: 'deploying', tag: 'v0.38.5' }, 'deploying'],
      [{ state: 'failed', tag: 'v0.38.5' }, 'deploy-failed'],
      // Deployed is no longer close: phase 5 verifies before phase 6 closes (RA-1063).
      [{ state: 'deployed', tag: 'v0.38.5' }, 'file-qa'],
      // A `success` run CONCLUSION is not a deploy: deploy-staging's gate skips the
      // deploy job when the tag range has no deploying commits, and the run still
      // concludes success. 8 of the last 25 runs. A QA project landing as `docs:`
      // is exactly this case, so it is the LIKELY path here, not an exotic one.
      [{ state: 'gate-declined', tag: 'v0.38.2' }, 'deploy-gate-declined'],
      // `v0.38.1` used to substring-match the run for `v0.38.10`, and newest-first
      // ordering made it prefer the wrong one.
      [{ state: 'run-not-found', tag: 'v0.38.5' }, 'deploy-run-not-found'],
      [{ state: 'run-unreadable', tag: 'v0.38.5' }, 'deploy-run-unreadable'],
      // RA-1369: a completed run whose jobs contain no `deploy` job. Distinct from
      // `run-unreadable` because it is PERMANENT — the job set never changes.
      [{ state: 'deploy-job-absent', tag: 'v0.38.5' }, 'deploy-job-absent'],
      // Nothing merged closed these issues, so nothing shipped — but it must not
      // block, and it must not claim a deploy either.
      [{ state: 'nothing-to-deploy' }, 'file-qa'],
      // A state nobody mapped must not become a phase name by accident.
      [{ state: 'something-new' }, 'deploy-unknown'],
    ];
    it.each(CASES)('deploy=%j -> %s', (deploy, expected) => {
      expect(phaseOf(allClosed({ deploy }))).toBe(expected);
    });

    it('covers every state the map knows', () => {
      // The table above is a hand-kept list and RA-1369's state landed in the map
      // without landing in it (RA-1440 review). Enumerating it against the map is what
      // makes the next addition impossible to forget rather than merely unlikely.
      const covered = new Set(CASES.map(([d]) => (d as { state?: string } | undefined)?.state));
      for (const state of Object.keys(DEPLOY_PHASE)) {
        expect(covered, `${state} is in DEPLOY_PHASE but not in this table`).toContain(state);
      }
    });

    it.each([
      ['deploy-gate-declined', { state: 'gate-declined', tag: 'v0.38.2' }, /deploy job was SKIPPED/],
      ['deploy-run-not-found', { state: 'run-not-found', tag: 'v0.38.5' }, /does NOT resolve itself/],
      ['deploy-run-unreadable', { state: 'run-unreadable', tag: 'v0.38.5' }, /refusing to treat unknown as deployed/],
      ['deploy-unknown', { state: 'something-new' }, /refusing to guess/],
    ])('%s stops with its OWN reason, not a shared one', (_p, deploy, re) => {
      // Four different facts used to print "waiting for the release that contains
      // their merges" — patience for something already past, in two of the cases.
      const r = nextActions(allClosed({ deploy }));
      expect(r.actions).toEqual([]);
      expect(r.stopped).toMatch(re);
    });

    it('is idempotent for nothing-to-deploy too, not only for deployed', () => {
      // `trackingClosed` was derived only when the state was `deployed`, so this
      // path kept `undefined` forever: `phaseOf` returned `close` every tick and
      // the project was re-closed with a fresh retro each hour. Idempotence is the
      // one property deriving state instead of storing it should give for free.
      const r = nextActions(allClosed({ deploy: { state: 'nothing-to-deploy' }, qaIssue: qaPassed, trackingClosed: true }));
      expect(r.phase).toBe('complete');
      expect(r.actions).toEqual([]);
    });

    it('never claims a deploy when nothing was deployed', () => {
      // `nothing-to-deploy` used to be spelled `deployed`, which produced three
      // separate assertions of a deploy that provably did not happen — including a
      // retro reading "the work is on staging in `(untagged)`".
      const r = nextActions(allClosed({ deploy: { state: 'nothing-to-deploy' }, qaIssue: qaPassed }));
      expect(r.actions).toEqual([{ kind: 'close-project', number: 961, tag: null, environment: null }]);
    });

    it('a failed deploy STOPS, and never advances to close', () => {
      // The state that must not become "complete". A project whose code did not
      // reach staging is not one whose code works, and the next tick re-derives
      // the same failure rather than retrying past it.
      const r = nextActions(allClosed({ deploy: { state: 'failed', tag: 'v0.38.5', url: 'https://…/runs/1' } }));
      expect(r.phase).toBe('deploy-failed');
      expect(r.actions).toEqual([]);
      // Named by the declared environment since plan 0004 P6, or as "the reference
      // environment" when the verdict carries none, as here.
      expect(r.stopped).toMatch(/the deploy to the reference environment FAILED/);
      expect(r.stopped).toContain('v0.38.5');
    });

    it('says WHAT it is waiting for, rather than reporting nothing to do', () => {
      // "Nothing to do" and "waiting on a named thing" are different findings, and
      // only one of them is distinguishable from a broken tick.
      expect(nextActions(allClosed()).stopped).toMatch(/no release contains their merges yet/);
      expect(nextActions(allClosed({ deploy: { state: 'deploying', tag: 'v0.38.5' } })).stopped).toContain('v0.38.5');
    });
  });

  describe('phase 6 — close', () => {
    const deployed = { state: 'deployed', tag: 'v0.38.5' };

    it('closes the TRACKING issue, not any work', () => {
      const r = nextActions(allClosed({ deploy: deployed, qaIssue: qaPassed }));
      expect(r.phase).toBe('close');
      expect(r.actions).toEqual([{ kind: 'close-project', number: 961, tag: 'v0.38.5', environment: null }]);
    });

    it('is complete once the tracking issue is closed, and does nothing twice', () => {
      // `complete` means the close ALREADY happened, so a re-run is a no-op rather
      // than a second retro comment — the same derived-state discipline as the
      // file phase's dedup by title.
      const r = nextActions(allClosed({ deploy: deployed, qaIssue: qaPassed, trackingClosed: true }));
      expect(r.phase).toBe('complete');
      expect(r.actions).toEqual([]);
    });

    it('never reaches close while an issue is still open', () => {
      const world = { ...worldFrom(BRIEF(['a', 'b']), [{ number: 1, title: 'a', state: 'CLOSED' }, { number: 2, title: 'b', state: 'OPEN' }]), deploy: deployed, qaIssue: qaPassed };
      expect(phaseOf(world)).toBe('reconcile');
    });

    it('never reaches close while a human owes an answer', () => {
      const world = allClosed({ deploy: deployed, qaIssue: qaPassed });
      expect(phaseOf({ ...world, blocked: [{ number: 1, title: 'a' }] })).toBe('blocked');
    });
  });
});


describe('phase 4 — the deploy derivation itself (RA-1061)', () => {
  /**
   * ~60 lines that shell out to `gh` to walk closed issue -> closing PR -> merge SHA
   * -> containing release -> deploy run, and they decide whether the Lead AUTO-CLOSES
   * a project (the tick runs `APPLY=1`). Every test in the phase-4 block hand-built
   * the `deploy` object it wanted, so the pure half was covered and the half that
   * PRODUCES those objects was not covered at all.
   *
   * That is the failure `phaseOf`'s own comment records — "The test that claimed to
   * cover it passed `order` in by hand, building a world the derivation could not
   * produce" — reproduced at four times the size.
   */
  const CLOSED = [{ number: 1, state: 'CLOSED' }];

  /** A `gh` double: routes on the argv shape, like the real CLI. */
  const fakeGh = (routes: Record<string, unknown>) => ({
    json: (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'view') return routes.issue ?? { closedByPullRequestsReferences: [] };
      if (args[0] === 'pr' && args[1] === 'view') return routes.pr ?? { state: 'MERGED', mergeCommit: { oid: 'sha1' } };
      if (args[0] === 'api' && String(args[1]).includes('releases')) return routes.releases ?? [];
      if (args[0] === 'run' && args[1] === 'list') return routes.runs ?? [];
      if (args[0] === 'run' && args[1] === 'view') return routes.runView ?? { jobs: [] };
      throw new Error(`unrouted: ${args.join(' ')}`);
    },
    text: () => (routes.compare as string) ?? 'behind',
  });

  it('every state it can emit is a state phaseOf knows', () => {
    // THE RENAME BUG THIS LOCKS. `readDeploy`'s vocabulary and `phaseOf`'s branches
    // agreed only by eye: rename `'failed'` to `'deploy-failed'` in the derivation
    // and every existing test still passed, while a failed deploy silently became an
    // unknown phase. Enumerated from `classifyDeploy`'s real returns.
    const states = [
      classifyDeploy({ shas: [], tag: null, run: null, deployJob: null }),
      classifyDeploy({ shas: ['a'], tag: null, run: null, deployJob: null }),
      classifyDeploy({ shas: ['a'], tag: 'v1', run: null, deployJob: null }),
      classifyDeploy({ shas: ['a'], tag: 'v1', run: { status: 'in_progress' }, deployJob: null }),
      classifyDeploy({ shas: ['a'], tag: 'v1', run: { status: 'completed', conclusion: 'failure' }, deployJob: null }),
      classifyDeploy({ shas: ['a'], tag: 'v1', run: { status: 'completed', conclusion: 'success' }, deployJob: null }),
      classifyDeploy({ shas: ['a'], tag: 'v1', run: { status: 'completed', conclusion: 'success' }, deployJob: { conclusion: 'skipped' } }),
      classifyDeploy({ shas: ['a'], tag: 'v1', run: { status: 'completed', conclusion: 'success' }, deployJob: { conclusion: 'failure' } }),
      classifyDeploy({ shas: ['a'], tag: 'v1', run: { status: 'completed', conclusion: 'success' }, deployJob: { conclusion: 'success' } }),
    ].map((d) => d.state);

    expect(new Set(states).size, 'the fixture must reach more than one state').toBeGreaterThan(5);

    // THE ASSERTION THAT BITES: `phaseOf` answers `deploy-unknown` for a state it
    // does not have a branch for, so a state the derivation emits landing there IS
    // the drift. My first version asserted `reachesPhase6(state)` was a boolean —
    // which it always is, whatever the input — and `phaseOf(...)` was defined, which
    // it always is. Both passed under the rename; neither tested anything.
    // The world must actually REACH the deploy check. My first attempt used a bare
    // object literal, and `phaseOf` short-circuited at `brief-unparseable` for every
    // input — so the loop below passed without once testing a deploy state. The
    // non-vacuity assertion at the end is what exposed that; it is the only reason
    // this test is not still green and worthless.
    const w = (state: string) => ({
      ...worldFrom(BRIEF(['a']), [{ number: 1049, title: 'a', state: 'CLOSED', closedAt: '2026-08-26T18:00:00Z' }]),
      project: '961',
      deploy: { state },
    });
    for (const state of states) {
      expect(phaseOf(w(state)), `phaseOf has no branch for the state "${state}"`).not.toBe('deploy-unknown');
    }
    // NOT VACUOUS: an invented state does land there, from this same world.
    expect(phaseOf(w('deploy-failed'))).toBe('deploy-unknown');
  });

  it('an issue closed with no merged PR yields no SHA — and that is nothing-to-deploy', () => {
    // `closed !== deployed`. Issues get closed as duplicates, or by a human who did
    // the work another way; calling that `deployed` asserted a deploy that provably
    // did not happen, including a retro reading "on staging in `(untagged)`".
    const io = fakeGh({ issue: { closedByPullRequestsReferences: [] } });
    expect(closingMergeShas(CLOSED, io)).toEqual([]);
    expect(readDeploy(CLOSED, io).state).toBe('nothing-to-deploy');
  });

  it('an OPEN closing PR is not a merge', () => {
    const io = fakeGh({
      issue: { closedByPullRequestsReferences: [{ number: 9 }] },
      pr: { state: 'OPEN', mergeCommit: null },
    });
    expect(closingMergeShas(CLOSED, io)).toEqual([]);
  });

  it('a tag whose deploy run is not in the window read is run-not-found, not deployed', () => {
    // `gh run list --limit 30`. An older release falls out of that window; treating
    // absence as success would auto-close a project on no evidence.
    const io = fakeGh({
      issue: { closedByPullRequestsReferences: [{ number: 9 }] },
      releases: [{ tag: 'v1.0.0' }],
      runs: [{ displayTitle: 'v9.9.9', status: 'completed', conclusion: 'success', databaseId: 1 }],
    });
    expect(readDeploy(CLOSED, io).state).toBe('run-not-found');
  });

  it('a SKIPPED deploy job is gate-declined, however green the run is', () => {
    // 32% of releases. `deploy-staging.yml` is a `gate` job plus a `deploy` job
    // guarded on it, so the run concludes `success` with nothing shipped. The
    // workflow RAN is not the code SHIPPED.
    const io = fakeGh({
      issue: { closedByPullRequestsReferences: [{ number: 9 }] },
      releases: [{ tag: 'v1.0.0' }],
      runs: [{ displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u' }],
      runView: { jobs: [{ name: 'deploy', conclusion: 'skipped' }] },
    });
    const d = readDeploy(CLOSED, io);
    expect(d.state).toBe('gate-declined');
    expect(reachesPhase6(d.state), 'and it must NOT close the project').toBe(false);
  });

  it('finds a deploy started by the release CI, titled by the tag commit SHA (RA-1190)', () => {
    const sha = 'c'.repeat(40);
    const base = fakeGh({
      issue: { closedByPullRequestsReferences: [{ number: 9 }] },
      releases: [{ tag: 'v1.0.0' }],
      runs: [{ displayTitle: sha, status: 'completed', conclusion: 'success', databaseId: 1, url: 'u' }],
      runView: { jobs: [{ name: 'deploy', conclusion: 'success' }] },
    });
    const io = {
      ...base,
      json: (args: string[]) =>
        args[0] === 'api' && String(args[1]).endsWith('/commits/v1.0.0') ? { sha } : base.json(args),
    };
    expect(readDeploy(CLOSED, io).state).toBe('deployed');
    // And the window is wide enough for the per-merge no-op runs (RA-1190).
    const seen: string[][] = [];
    readDeploy(CLOSED, { ...io, json: (a: string[]) => (seen.push(a), io.json(a)) });
    expect(seen.find((a) => a[0] === 'run' && a[1] === 'list')).toContain('200');
  });

  it('the gate job is not mistaken for the deploy job', () => {
    const io = fakeGh({
      issue: { closedByPullRequestsReferences: [{ number: 9 }] },
      releases: [{ tag: 'v1.0.0' }],
      runs: [{ displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u' }],
      runView: { jobs: [{ name: 'gate', conclusion: 'success' }, { name: 'deploy', conclusion: 'success' }] },
    });
    expect(readDeploy(CLOSED, io).state).toBe('deployed');
  });

  it('walks past a DECLINED gate to the release that actually deployed (RA-1258)', () => {
    // The earliest containing release never changes, so classifying from it alone made
    // `gate-declined` permanent: project RA-961 had every issue closed and its code on
    // staging via v0.48.9, while the tick read v0.48.8 — whose deploy was skipped —
    // forever. Nothing could ever move it.
    const jobsByRun: Record<string, unknown> = {
      1: { jobs: [{ name: 'deploy', conclusion: 'skipped' }] },   // v1.0.0 — gate declined
      2: { jobs: [{ name: 'deploy', conclusion: 'success' }] },   // v1.0.1 — shipped
    };
    const io = {
      json: (args: string[]) => {
        if (args[0] === 'issue') return { closedByPullRequestsReferences: [{ number: 9 }] };
        if (args[0] === 'pr') return { state: 'MERGED', mergeCommit: { oid: 'sha1' } };
        if (args[0] === 'api') return [{ tag: 'v1.0.1' }, { tag: 'v1.0.0' }];   // newest first
        if (args[0] === 'run' && args[1] === 'list') return [
          { displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u1' },
          { displayTitle: 'v1.0.1', status: 'completed', conclusion: 'success', databaseId: 2, url: 'u2' },
        ];
        if (args[0] === 'run' && args[1] === 'view') return jobsByRun[args[2]];
        throw new Error(`unrouted: ${args.join(' ')}`);
      },
      text: () => 'behind',
    };
    const d = readDeploy([{ number: 1, state: 'CLOSED' }], io);
    expect(d.state).toBe('deployed');
    expect(d.tag, 'must name the tag actually BUILT, not the earliest containing one')
      .toBe('v1.0.1');
    expect(reachesPhase6(d.state), 'and the project can now reach phase 5/6').toBe(true);
  });

  it('still reports gate-declined when NO containing release deployed', () => {
    const io = {
      json: (args: string[]) => {
        if (args[0] === 'issue') return { closedByPullRequestsReferences: [{ number: 9 }] };
        if (args[0] === 'pr') return { state: 'MERGED', mergeCommit: { oid: 'sha1' } };
        if (args[0] === 'api') return [{ tag: 'v1.0.0' }];
        if (args[0] === 'run' && args[1] === 'list') return [
          { displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u1' },
        ];
        if (args[0] === 'run' && args[1] === 'view') return { jobs: [{ name: 'deploy', conclusion: 'skipped' }] };
        throw new Error('unrouted');
      },
      text: () => 'behind',
    };
    const d = readDeploy([{ number: 1, state: 'CLOSED' }], io);
    expect(d.state).toBe('gate-declined');
    expect(d.tag, 'and names the first declined release, not nothing').toBe('v1.0.0');
  });

  it('carries a real failure forward rather than discarding OR parking on it', () => {
    // DELIBERATELY REWRITTEN (RA-1372), and the argument matters because this case
    // predates RA-1364 and locked the opposite behaviour.
    //
    // What it protected is the RA-1056 lesson: walking forward from a failure must not
    // report a later green "as though the failure had not happened". That still holds
    // and is asserted below — the verdict names the failed release.
    //
    // What it did not settle is that the two facts are NOT exclusive. "This project's
    // own release failed" and "this project's code is on staging via a later
    // whole-tree deploy" can both be true, and returning at the first candidate could
    // only report one of them — so it reported the failure and parked the project
    // forever. That is the last member of the family RA-1258/RA-1268/RA-1271 belong to.
    //
    // The failure is now carried on the verdict instead of ending the walk, so the
    // project reaches phase 5 and every artifact still says its release failed.
    const io = {
      json: (args: string[]) => {
        if (args[0] === 'issue') return { closedByPullRequestsReferences: [{ number: 9 }] };
        if (args[0] === 'pr') return { state: 'MERGED', mergeCommit: { oid: 'sha1' } };
        if (args[0] === 'api') return [{ tag: 'v1.0.1' }, { tag: 'v1.0.0' }];
        if (args[0] === 'run' && args[1] === 'list') return [
          { displayTitle: 'v1.0.0', status: 'completed', conclusion: 'failure', databaseId: 1, url: 'u1' },
          { displayTitle: 'v1.0.1', status: 'completed', conclusion: 'success', databaseId: 2, url: 'u2' },
        ];
        if (args[0] === 'run' && args[1] === 'view') return { jobs: [{ name: 'deploy', conclusion: 'success' }] };
        throw new Error('unrouted');
      },
      text: () => 'behind',
    };
    const d = readDeploy([{ number: 1, state: 'CLOSED' }], io);
    expect(d.state, 'the later whole-tree deploy really did ship this code').toBe('deployed');
    expect(d.tag, 'and the tag named is the one that actually deployed').toBe('v1.0.1');
    expect(d.failedAt, 'the #1056 property: the failure is not discarded').toBe('v1.0.0');
    expect(d.failedUrl, 'and a human can still reach the failed run').toBe('u1');
  });

  it('an unreadable compare is not containment', () => {
    // The `catch` returns false deliberately: unreadable must not read as "contained",
    // which would name a release that may not hold the merge.
    const io = {
      ...fakeGh({
        issue: { closedByPullRequestsReferences: [{ number: 9 }] },
        releases: [{ tag: 'v1.0.0' }],
      }),
      text: () => { throw new Error('boom'); },
    };
    expect(readDeploy(CLOSED, io).state).toBe('awaiting-release');
  });

  it('picks the EARLIEST release containing every merge', () => {
    // Locks the walk's START ORDER and its short-circuit: it begins at the oldest
    // containing release and stops at the first one that deployed. Reversed, a later
    // release would be named while an earlier one had already shipped the work.
    const io = fakeGh({
      issue: { closedByPullRequestsReferences: [{ number: 9 }] },
      releases: [{ tag: 'v2.0.0' }, { tag: 'v1.0.0' }],   // gh returns newest-first
      runs: [
        { displayTitle: 'v1.0.0', status: 'completed', conclusion: 'success', databaseId: 1, url: 'u1' },
        { displayTitle: 'v2.0.0', status: 'completed', conclusion: 'success', databaseId: 2, url: 'u2' },
      ],
      runView: { jobs: [{ name: 'deploy', conclusion: 'success' }] },
    });
    expect(readDeploy(CLOSED, io).tag).toBe('v1.0.0');
  });

  it('a throwing gh is absorbed per-issue, not propagated', () => {
    // The tick must not die on one unreadable issue.
    const io = { json: () => { throw new Error('403'); }, text: () => 'behind' };
    expect(closingMergeShas(CLOSED, io)).toEqual([]);
  });
});

describe('reachesPhase6 — which states need the tracking issue read (RA-1056)', () => {
  // Gating on `deployed` alone left `nothing-to-deploy` with `trackingClosed:
  // undefined` forever, so `phaseOf` returned `close` on every tick and re-closed
  // the project with a fresh retro each hour. Idempotence is the property deriving
  // state instead of storing it is supposed to give for free.
  it.each([
    ['deployed', true],
    ['nothing-to-deploy', true],
  ])('%s reaches phase 6', (state, expected) => {
    expect(reachesPhase6(state)).toBe(expected);
  });

  // DERIVED FROM THE MAP, plus one state that is deliberately not in it (RA-1440
  // review). This was a hardcoded list and RA-1369's `deploy-job-absent` landed in the
  // map without landing here — the drift the map exists to prevent, one level out.
  it.each([
    ...Object.entries(DEPLOY_PHASE).filter(([, phase]) => phase !== null).map(([state]) => [state]),
    ['something-new'],
  ])('%s does not', (state) => {
    expect(reachesPhase6(state)).toBe(false);
  });

  it('agrees with phaseOf, because both read one map', () => {
    // Two hand-kept lists that must agree is the bug they would exist to prevent:
    // a state falling through to phase 6 in `phaseOf` while `reachesPhase6` omits
    // it is exactly the non-idempotent close.
    // EVERY state the map knows, read from the map — this loop was itself a third
    // hand-kept list, and it drifted (RA-1440 review).
    for (const state of Object.keys(DEPLOY_PHASE)) {
      // With a PASSED QA issue, so phase 5 does not intercept: `reachesPhase6`
      // answers "can this deploy state ever reach phase 6", and since RA-1063 that
      // route runs through verification.
      const fallsThrough = ['close', 'complete'].includes(
        phaseOf({
          ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
          project: '961',
          deploy: { state },
          qaIssue: { number: 2000, state: 'CLOSED', rounds: 1, lastVerifiedAt: '2026-08-26T20:00:00Z' },
          trackingClosed: false,
        }),
      );
      expect(reachesPhase6(state), `${state}`).toBe(fallsThrough);
    }
  });
});

describe('findDeployRun — exact tag, never a substring (RA-1056)', () => {
  // `gh run list` returns newest-first, so `includes` did not merely risk the wrong
  // run — it PREFERRED it. And this is wrong exactly as a project ages past `.9`.
  const runs = [
    { displayTitle: 'v0.38.10', url: 'ten' },
    { displayTitle: 'v0.38.1', url: 'one' },
  ];

  it('picks v0.38.1, not the newer v0.38.10 that contains it', () => {
    expect(findDeployRun(runs, 'v0.38.1')?.url).toBe('one');
  });

  it('picks v0.38.10 for v0.38.10', () => {
    expect(findDeployRun(runs, 'v0.38.10')?.url).toBe('ten');
  });

  it('returns null rather than a near-miss', () => {
    expect(findDeployRun(runs, 'v0.38.2')).toBeNull();
  });

  it('matches a workflow_run deploy titled by the release commit SHA (RA-1190), exactly', () => {
    const sha = 'a'.repeat(40);
    const byRun = [{ displayTitle: sha.slice(0, 39) + 'b', url: 'other' }, { displayTitle: sha, url: 'mine' }];
    expect(findDeployRun(byRun, 'v1.0.0', sha)?.url).toBe('mine');
    expect(findDeployRun(byRun, 'v1.0.0'), 'no sha, no SHA match').toBeNull();
    expect(findDeployRun([{ displayTitle: sha.slice(0, 7), url: 'short' }], 'v1.0.0', sha)).toBeNull();
  });
});

describe('classifyDeploy — the evidence, not the workflow status (RA-1056)', () => {
  /**
   * Both defects the review found lived here, and both ESCAPED a mutation run,
   * because the phase tests inject a `deploy` object — they cover the consumer and
   * never the producer. That is the same gap as every other one today, so the
   * classification is split out and executed.
   */
  const ok = { status: 'completed', conclusion: 'success', url: 'u' };
  const shas = ['abc123'];

  it('a SKIPPED deploy job is not a deploy, however the run concluded', () => {
    // deploy-staging is a `gate` job plus a `deploy` job guarded on it. A tag range
    // with no deploying commits skips `deploy` and the run still concludes
    // `success` — 8 of the last 25 runs, and the likely path for a QA project that
    // lands as `docs:`. Calling it deployed put "the work is on staging in
    // v0.38.2" in a permanent retro about a release that never touched staging.
    expect(classifyDeploy({ shas, tag: 'v0.38.2', run: ok, deployJob: { conclusion: 'skipped' } }).state)
      .toBe('gate-declined');
  });

  it('a successful deploy job IS a deploy', () => {
    expect(classifyDeploy({ shas, tag: 'v0.38.5', run: ok, deployJob: { conclusion: 'success' } }).state)
      .toBe('deployed');
  });

  // DELIBERATELY SPLIT (RA-1369). This case asserted `deployJob: null -> run-unreadable`,
  // which collapsed two causes with opposite lifetimes into one state. Neither half of
  // the original property is weakened: both still refuse, and neither can read as
  // `deployed`. What changes is that only ONE of them claims to be transient.
  it('an unreadable job list is UNKNOWN, never deployed — and is transient', () => {
    // `undefined`: the API read failed or returned no `jobs` array. A later tick
    // re-issues it, so parking here is correct.
    expect(classifyDeploy({ shas, tag: 'v0.38.5', run: ok, deployJob: undefined }).state)
      .toBe('run-unreadable');
  });

  it('a job list that HAS no deploy job is absent, never deployed — and is permanent', () => {
    // `null`: the jobs came back and none matched. A completed run's job set never
    // changes, so this cannot clear on a later tick — it is negative evidence, and
    // reporting it as `run-unreadable` told a human to wait for a tick that could
    // never differ.
    expect(classifyDeploy({ shas, tag: 'v0.38.5', run: ok, deployJob: null }).state)
      .toBe('deploy-job-absent');
  });

  it('no merged PR closed anything -> nothing-to-deploy, and never a tag', () => {
    const r = classifyDeploy({ shas: [], tag: null, run: null, deployJob: null });
    expect(r.state).toBe('nothing-to-deploy');
    expect(r.tag).toBeUndefined();
  });

  it.each([
    [{ shas, tag: null, run: null, deployJob: null }, 'awaiting-release'],
    [{ shas, tag: 'v0.38.5', run: null, deployJob: null }, 'run-not-found'],
    [{ shas, tag: 'v0.38.5', run: { status: 'in_progress' }, deployJob: null }, 'deploying'],
    [{ shas, tag: 'v0.38.5', run: { status: 'completed', conclusion: 'failure' }, deployJob: null }, 'failed'],
    [{ shas, tag: 'v0.38.5', run: ok, deployJob: { conclusion: 'failure' } }, 'failed'],
  ])('%j -> %s', (evidence, expected) => {
    expect(classifyDeploy(evidence).state).toBe(expected);
  });
});


describe('nothing-to-deploy never reads as a deploy, in ANY artifact (RA-1056)', () => {
  /**
   * The same sentence had to be corrected three times, in three artifacts, across
   * two review rounds: the retro, the close comment, and the action line the APPLY
   * run prints to its step summary. Each contradicted the issue the SAME run wrote.
   *
   * `report` is not dry-run-only — `main` calls it before `execute`, always — so a
   * string there is as public as the issue comment.
   */
  it('the action line says nothing was deployed, not "deployed in `(untagged)`"', () => {
    const line = renderCloseAction({ number: 999, tag: null });
    expect(line).toContain('nothing deployed');
    expect(line).not.toContain('(untagged)');
  });

  it('and still names the tag when there is one', () => {
    expect(renderCloseAction({ number: 999, tag: 'v0.38.5' })).toContain('v0.38.5');
  });

  it('no live string in the module claims a deploy for an untagged close', () => {
    // The guard that would have caught copies two and three. Comments ABOUT the
    // bug are allowed; a template that renders it is not.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const live = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .filter((l) => l.includes('(untagged)'));
    expect(live).toEqual([]);
  });
});


describe('declaresMembership — a declaration, not a quotation (RA-1066)', () => {
  /**
   * Three documents were absorbed by project RA-961 within an hour, each by
   * DISCUSSING the mechanism that absorbed them:
   *
   *   RA-1063  the phase-5 design doc, which wrote the marker as an EXAMPLE
   *   RA-1066  the bug report about RA-1063 — captured by the bug it reported
   *   RA-1066  again, after proposing the fix, because it quoted the NEW marker too
   *
   * Two live consequences, both one tick away. Project RA-961 could never reach
   * phase 4, which gates on `!open.length` with a permanently-open member. And a
   * DESIGN DOCUMENT was dispatchable to an implementer — it had a milestone, a
   * plausible title, and a body full of acceptance-criteria-shaped prose, so
   * nothing downstream would have flinched.
   *
   * Presence cannot separate the two and neither can syntax: prose about a marker
   * is textually identical to a use of it. Position can.
   */
  const filed = (n = 961) => `Acceptance criteria…\n\nPart of #${n}.\n\n_Filed by the Lead…_\n\n<!-- qa:project ${n} -->`;

  it('a filed issue declares', () => {
    expect(declaresMembership(filed(), 961)).toBe(true);
  });

  it('trailing blank lines do not break it', () => {
    expect(declaresMembership(`${filed()}\n\n   \n`, 961)).toBe(true);
  });

  it('a document QUOTING the marker does not declare', () => {
    // RA-1066's own shape: the marker appears, and prose follows it.
    const doc = 'The fix is a marker like `<!-- qa:project 961 -->` that prose cannot\nreproduce by accident.\n\nThat is the strongest argument in this issue.';
    expect(declaresMembership(doc, 961)).toBe(false);
  });

  it('the marker mid-body does not declare, however often it appears', () => {
    const doc = '<!-- qa:project 961 -->\n\nprose\n\n<!-- qa:project 961 -->\n\nmore prose';
    expect(declaresMembership(doc, 961)).toBe(false);
  });

  it('the old prose form alone no longer declares', () => {
    // RA-1063 carried `Part of RA-961` as an example and was absorbed for it.
    expect(declaresMembership('Part of #961 appears here as an example.\n\nprose', 961)).toBe(false);
  });

  it('does not confuse one project for another', () => {
    expect(declaresMembership(filed(999), 961)).toBe(false);
    expect(declaresMembership(filed(96), 961)).toBe(false);
  });

  it('an empty or missing body declares nothing', () => {
    expect(declaresMembership('', 961)).toBe(false);
    expect(declaresMembership(undefined as unknown as string, 961)).toBe(false);
  });

  it('the marker the Lead writes is the one the reader accepts', () => {
    // The two halves are in different functions ~200 lines apart. A rename on one
    // side would silently stop every future project from having any members, and
    // `phaseOf` would report `file` and RE-FILE all of them — unamendable.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const written = src.match(/`<!-- qa:project \$\{world\.project\} -->`/g) ?? [];
    const read = src.match(/`<!-- qa:project \$\{project\} -->`/g) ?? [];
    // The point was never a WRITER COUNT — it is that every writer agrees with the
    // reader. Asserting the count made a third writer (RA-976's `adopt`, which joins an
    // existing issue rather than filing a rival) fail a test about marker agreement,
    // which is a test failing for the wrong reason. There are three writers today:
    // the filed issues, the QA issue phase 5 appends (RA-1063), and adopt.
    expect(written.length, 'at least one writer').toBeGreaterThan(0);
    expect(read.length, 'the marker declaresMembership accepts').toBe(1);
    // The real property: no OTHER spelling of the marker exists anywhere in the file.
    // A rename on one side would otherwise stop every future project from having
    // members, and `phaseOf` would report `file` and RE-FILE all of them.
    const spellings = new Set((src.match(/<!-- qa:project [^>]*-->/g) ?? []).map((m) => m.replace(/\$\{[^}]+\}/, '<n>')));
    expect([...spellings], 'one spelling, however many writers').toEqual(['<!-- qa:project <n> -->']);
  });
});


describe('busy is not the same as blocked (RA-1077)', () => {
  /**
   * "WIP cap reached (1/1)" was printed hourly for six hours about a project that
   * had STOPPED. PR RA-1057 was reviewed CHANGES_REQUESTED at 12:57 and nothing
   * re-invoked the implementer, because `agent-implement.yml` had no
   * `pull_request_review` trigger.
   *
   * Three detectors each reported it healthy: no trigger fired, the reconciler
   * counted a full WIP slot, and the dispatch sweep saw `has-pr` and correctly
   * treated it as not-actionable. Three correct components, one deadlocked project
   * described as normal — the developer found it, not the pipeline.
   */
  const pr = (o: Partial<{ state: string; headSha: string; reviews: { state: string; sha: string }[] }> = {}) => ({
    state: 'OPEN', headSha: 'abc', reviews: [], ...o,
  });

  it('a changes-request on the current head is blocked', () => {
    expect(isReviewBlocked([pr({ reviews: [{ state: 'CHANGES_REQUESTED', sha: 'abc' }] })])).toBe(true);
  });

  it('a changes-request on an OLDER head is not — the push answered it', () => {
    // Otherwise every healthy revision round reads as a stall, which would make
    // the signal useless exactly when the loop is working.
    expect(isReviewBlocked([pr({ headSha: 'def', reviews: [{ state: 'CHANGES_REQUESTED', sha: 'abc' }] })])).toBe(false);
  });

  it('the LATEST review on the head decides, not any of them', () => {
    expect(isReviewBlocked([pr({ reviews: [{ state: 'CHANGES_REQUESTED', sha: 'abc' }, { state: 'APPROVED', sha: 'abc' }] })])).toBe(false);
  });

  it('an approved or unreviewed PR is in progress, not blocked', () => {
    expect(isReviewBlocked([pr({ reviews: [{ state: 'APPROVED', sha: 'abc' }] })])).toBe(false);
    expect(isReviewBlocked([pr()])).toBe(false);
  });

  it('a closed or merged PR is not blocked', () => {
    expect(isReviewBlocked([pr({ state: 'MERGED', reviews: [{ state: 'CHANGES_REQUESTED', sha: 'abc' }] })])).toBe(false);
  });

  it('no linked PR is not blocked', () => {
    // Failing to READ is not evidence of a stall either — `linkedPrs` returns []
    // on error, and an unreadable PR must not be reported as blocked.
    expect(isReviewBlocked([])).toBe(false);
  });

  it('the tick SAYS blocked rather than reporting a full slot', () => {
    const world = {
      ...worldFrom(BRIEF(['a', 'b']), [
        { number: 1049, title: 'a', state: 'OPEN', labels: ['agent:implement'] },
        { number: 1050, title: 'b', state: 'OPEN', labels: [] },
      ]),
      project: '961',
    };
    world.open = world.open.map((i) => (i.number === 1049 ? { ...i, reviewBlocked: true } : i));

    const r = nextActions(world, { wip: 1 });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/BLOCKED on a review/);
    expect(r.stopped).toContain('#1049');
    expect(r.stopped).toMatch(/not progress/);
  });

  it('and still says plain WIP when the work really is in progress', () => {
    const world = {
      ...worldFrom(BRIEF(['a', 'b']), [
        { number: 1049, title: 'a', state: 'OPEN', labels: ['agent:implement'] },
        { number: 1050, title: 'b', state: 'OPEN', labels: [] },
      ]),
      project: '961',
    };
    const r = nextActions(world, { wip: 1 });
    expect(r.stopped).toBe('WIP cap reached (1/1)');
  });
});


describe('phase 5 — staging verification (RA-1063)', () => {
  /**
   * Deployed is not working. Phase 6 closing on a deploy alone is the weakness
   * RA-1056 shipped with and said so; this is the piece that removes it.
   *
   * The shape was chosen against a stress test. Holding each IMPLEMENTATION issue
   * open until QA verifies it deadlocks — phase 4 gates on `!open.length` and QA
   * needs to know it is deployed — stalls the WIP cap on QA latency, and makes the
   * dispatch sweep re-dispatch merged work. A QA ISSUE that is part of the project
   * removes all three.
   */
  const deployed = { state: 'deployed', tag: 'v0.38.5' };
  const world = (extra: Record<string, unknown> = {}) => ({
    ...worldFrom(BRIEF(['a']), [{ number: 1049, title: 'a', state: 'CLOSED', closedAt: '2026-08-26T18:00:00Z' }]),
    project: '961',
    deploy: deployed,
    ...extra,
  });

  describe('the QA issue is appended, not left to the brief', () => {
    it('files one when the project is deployed and has none', () => {
      // A brief that forgets to propose QA is exactly the failure mode, and "the
      // Lead must remember" is the weakest available guard.
      const r = nextActions(world({ qaIssue: null }));
      expect(r.phase).toBe('file-qa');
      expect(r.actions).toEqual([{ kind: 'file-qa', title: expect.stringContaining('#961'), tag: 'v0.38.5', environment: null }]);
    });

    it('does not file one before the work is deployed', () => {
      expect(phaseOf(world({ qaIssue: null, deploy: { state: 'deploying', tag: 'v0.38.5' } }))).toBe('deploying');
    });
  });

  describe('the QA issue is not implementation work', () => {
    it('does not hold the project in reconcile', () => {
      // It is open for as long as the project is unverified. Counting it as work
      // would keep `open.length` non-zero forever and phase 4 would never run.
      const w = {
        ...world({ qaIssue: { number: 2000, state: 'OPEN', rounds: 0, lastVerifiedAt: null } }),
      };
      w.open = [{ number: 2000, title: 'Verify', state: 'OPEN', labels: ['qa:verify'] }];
      expect(phaseOf(w)).toBe('verify');
    });

    it('and a real open issue still does', () => {
      const w = { ...world({ qaIssue: { number: 2000, state: 'OPEN', rounds: 0, lastVerifiedAt: null } }) };
      w.open = [
        { number: 2000, title: 'Verify', state: 'OPEN', labels: ['qa:verify'] },
        // A phase-5 finding, as `agent-verify-acs.yml` files it (RA-1783: the label is
        // what makes a non-brief member the project's WORK rather than carried out).
        { number: 1050, title: 'b', state: 'OPEN', labels: ['signal:spec-violation'], body: 'env: local build of `v1` (targeted-invariant mode) — NOT staging' },
      ];
      expect(phaseOf(w)).toBe('reconcile');
    });
  });

  describe('when to re-verify', () => {
    it('never verified -> verify', () => {
      expect(needsVerification([{ closedAt: '2026-08-26T18:00:00Z' }], null)).toBe(true);
    });

    it('an unrelated release does NOT trigger a re-verify', () => {
      // The signal that was rejected: a release was cut on EVERY merge (until RA-2594) —
      // v0.38.2 through v0.38.5 inside one hour, almost all unrelated — so a
      // tag-based trigger would wake the Explorer constantly and verify nothing.
      // Nothing in this world closed after the verification, so nothing fires.
      expect(needsVerification([{ closedAt: '2026-08-26T18:00:00Z' }], '2026-08-26T19:00:00Z')).toBe(false);
    });

    it('a project issue closing AFTER the last verification does', () => {
      expect(needsVerification([{ closedAt: '2026-08-26T20:00:00Z' }], '2026-08-26T19:00:00Z')).toBe(true);
    });

    it('an unreadable timestamp verifies rather than skipping', () => {
      // Failing toward re-verification is the safe direction: the cost is a the Explorer
      // run, and the alternative is a project closed on evidence nobody gathered.
      expect(needsVerification([{ closedAt: '2026-08-26T20:00:00Z' }], 'not-a-date')).toBe(true);
    });

    it('an issue with no closedAt is not a trigger', () => {
      expect(needsVerification([{}], '2026-08-26T19:00:00Z')).toBe(false);
    });
  });

  describe('the tick', () => {
    it('dispatches the Explorer when verification is due', () => {
      const r = nextActions(world({ qaIssue: { number: 2000, state: 'OPEN', rounds: 0, lastVerifiedAt: null } }));
      expect(r.phase).toBe('verify');
      expect(r.actions).toEqual([{ kind: 'verify', number: 2000, project: 961, tag: 'v0.38.5' }]);
    });

    it('an open finding is reconcile, not a phase-5 wait (RA-1241)', () => {
      // MY FIRST VERSION OF THIS TEST BUILT A WORLD `readWorld` CANNOT PRODUCE. It
      // appended the open finding to `all` WITHOUT adding it to `open`, and asserted
      // `awaiting-qa` — while a test six lines earlier asserts `reconcile` for the same
      // real situation with `open` set consistently. Two adjacent tests, opposite
      // phases, one scenario. That is the anti-pattern this very PR quotes twice and
      // the whole thesis of its RA-1061 half, reintroduced in the change that cites it.
      //
      // `worldFrom` derives `open` from `all` the way `readWorld` does, which is what
      // makes this assertion mean something.
      const base = worldFrom(BRIEF(['a']), [
        { number: 1049, title: 'a', state: 'CLOSED', closedAt: '2026-08-26T18:00:00Z' },
        { number: 1050, title: 'a finding', state: 'OPEN', labels: ['signal:spec-violation'], body: 'env: local build of `v1` (targeted-invariant mode) — NOT staging' },
      ]);
      const r = nextActions({
        ...base, project: '961', deploy: deployed,
        qaIssue: { number: 2000, state: 'OPEN', rounds: 1, lastVerifiedAt: '2026-08-26T19:00:00Z' },
      });
      expect(r.phase).toBe('reconcile');
    });

    it('escalates instead of waiting forever when nothing is left to fix (RA-1091)', () => {
      // WAITING FOR NOTHING — and before this, there was no exit. the Explorer is told not to
      // file for `unverifiable`/`not-run` and not to close the QA issue unless
      // everything passed, so round 1 leaves an open QA issue, `rounds === 1` and no
      // new project issue. `needsVerification` keys on a `closedAt` later than
      // `lastVerifiedAt`, and phase 5 is only reachable once every work issue is
      // already closed — so it is false forever. Nothing re-dispatches the Explorer, `rounds`
      // stays 1, and `qa-exhausted` (`>= 2`) is unreachable. Every hour, forever.
      const r = nextActions(world({ qaIssue: { number: 2000, state: 'OPEN', rounds: 1, lastVerifiedAt: '2026-08-26T19:00:00Z' } }));
      expect(r.phase).toBe('qa-unverifiable');
      expect(r.actions, 'must not close the project — nothing verified it').toEqual([]);
      expect(r.stopped).toMatch(/NO project issue is left to fix/);
      expect(r.stopped, 'and must say why another round would not help').toMatch(/report the same thing/);
      expect(r.stopped, 'no unanchored finding, no caveat').not.toMatch(/without the phase-5 anchor/);
    });

    it('names an UNANCHORED spec-violation member rather than claim nothing is left to fix (RA-1783 review)', () => {
      const lost = { number: 1060, title: 'AC failed, anchor lost', state: 'OPEN', labels: ['signal:spec-violation', 'sev:medium'], body: 'local build in targeted-invariant mode' };
      const r = nextActions(world({ open: [lost], qaIssue: { number: 2000, state: 'OPEN', rounds: 1, lastVerifiedAt: '2026-08-26T19:00:00Z' } }));
      expect(r.phase).toBe('qa-unverifiable');
      expect(r.stopped).toMatch(/BUT #1060 carries `signal:spec-violation` without the phase-5 anchor/);
      expect(r.escalate?.[0]).toMatch(/#1060 carries/);
    });

    it('does not escalate before the Explorer has run at all', () => {
      // rounds === 0 is a project awaiting its FIRST verification, not a stall.
      const r = nextActions(world({ qaIssue: { number: 2000, state: 'OPEN', rounds: 0, lastVerifiedAt: null } }));
      expect(r.phase).not.toBe('qa-unverifiable');
    });

    it('stops when the round count cannot be read, rather than dispatching', () => {
      // The first version returned `lastVerifiedAt: new Date(0)` — 1970, which is
      // BEFORE every closedAt this phase can see, so it was identical to `null` and
      // dispatched the Explorer every hour: the exact loop its own comment claimed to
      // prevent. An unreadable count is not evidence either way.
      const r = nextActions(world({ qaIssue: { number: 2000, state: 'OPEN', rounds: 0, lastVerifiedAt: null, readable: false } }));
      expect(r.phase).toBe('qa-unreadable');
      expect(r.actions).toEqual([]);
      expect(r.stopped).toMatch(/UNKNOWN/);
      // NAMES A REACHABLE CAUSE (RA-1103). This asserted `issues: read`, which sent the
      // operator to the workflow's `permissions:` block — that block governs the
      // pre-filter on `github.token`, while the Reconcile step runs on the the Lead
      // App token. The message was pointing at a file that was already correct.
      expect(r.stopped, 'must name the token it actually runs on').toMatch(/App token/i);
      expect(r.stopped, 'and where its permissions live').toMatch(/App installation/i);
      expect(
        r.stopped,
        'and must not send the reader to the permissions block, which governs a different call',
      ).not.toMatch(/this job needs/i);
    });

    it('escalates after two QA rounds instead of running a third', () => {
      const r = nextActions(world({ qaIssue: { number: 2000, state: 'OPEN', rounds: 2, lastVerifiedAt: '2026-08-26T19:00:00Z' } }));
      expect(r.phase).toBe('qa-exhausted');
      expect(r.actions).toEqual([]);
      expect(r.stopped).toMatch(/belongs with the developer/);
      expect(r.stopped).toMatch(/NOT closed/);
    });

    it('closes the project only once QA has passed', () => {
      const passed = { number: 2000, state: 'CLOSED', rounds: 1, lastVerifiedAt: '2026-08-26T19:00:00Z' };
      expect(nextActions(world({ qaIssue: passed })).phase).toBe('close');
    });
  });
});


describe('the labels this tick applies must exist in the repo (RA-1087)', () => {
  /**
   * `qa:verify` did not exist. `gh issue create --label qa:verify` fails outright,
   * so phase 5 would have died at the moment of filing — and the label is also what
   * excludes the QA issue from the work view, so a hand-created issue without it
   * would have been dispatched to an implementer as work to build.
   *
   * A label is a live repo fact, not a constant, and nothing in the suite checked
   * one. RA-1004 is the same shape from the other direction — a real label the parser
   * refused.
   */
  // Repo-RELATIVE, and read through `readRepoDoc`: the third candidate is in the
  // reviewer's pinned set, so a plain read would check the PR's labels against base's
  // declaration in that one tree (RA-1677). No such file exists today; the candidate does.
  const labelsFile = ['.github/labels.yml', '.github/labels.yaml', 'docs/qa/labels.md']
    .find((f) => existsSync(join(process.cwd(), f)));

  it.runIf(labelsFile)('every label the reconciler applies is declared', () => {
    const declared = readRepoDoc(labelsFile!);
    // `VERIFY` lives with the closure rule in `project-closure.mjs`, which the reconciler
    // imports; both homes are read, and BOTH constants must be found, so the move cannot
    // silently narrow this to one.
    const src = ['scripts/lead-reconcile.mjs', 'scripts/project-closure.mjs']
      .map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    const applied = [...src.matchAll(/^(?:export )?const (?:IMPLEMENT|VERIFY) = '([^']+)'/gm)].map((m) => m[1]);
    expect(applied).toHaveLength(2);
    for (const l of applied) expect(declared, `${l} is not declared in ${labelsFile}`).toContain(l);
  });

  it('names the labels it applies in one place, so they can be checked at all', () => {
    // Without a declared list this can only be verified against the live repo, which
    // a unit test cannot reach. Asserting the constants exist is the floor.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    expect(src).toMatch(/^const IMPLEMENT = 'agent:implement';$/m);
    const closure = readFileSync(join(ROOT, 'scripts/project-closure.mjs'), 'utf8');
    expect(closure).toMatch(/^export const VERIFY = 'qa:verify';$/m);
  });
});


describe('what phase 5 verified, said the same way everywhere (RA-1087)', () => {
  /**
   * This sentence has been corrected FOUR times in four artifacts across three PRs
   * — the retro, the close comment, the tick's action line, and the QA issue body.
   * Each copy drifted separately because each was written separately, and twice a
   * commit claimed to have fixed "the" claim while fixing one instance of it.
   */
  it('names the tag it verified against', () => {
    expect(verificationCaveat('v0.38.5')).toContain('v0.38.5');
    expect(verificationCaveat('v0.38.5')).toMatch(/not against the reference environment itself/);
    // The declared environment by name, since kanon#199.
    expect(verificationCaveat('v0.38.5', 1, true, 'preview')).toMatch(/not against `preview` itself/);
  });

  it('says NOTHING WAS DEPLOYED rather than naming a release, when none exists', () => {
    // On this path `execute` omits `-f ref`, so the Explorer verifies the default branch.
    // Claiming a "build of the deployed tag" is false twice over: no tag, no deploy.
    const c = verificationCaveat(null);
    expect(c).toMatch(/NOTHING WAS DEPLOYED/);
    expect(c).toMatch(/no release backs this/);
    expect(c).not.toMatch(/deployed tag/);
  });

  it('always states the unverifiable rule, whichever branch it takes', () => {
    for (const tag of ['v0.38.5', null]) {
      expect(verificationCaveat(tag)).toMatch(/`unverifiable`, never `passed`/);
    }
  });

  it('is the only place the claim is written — COMMENTS included', () => {
    // The first version of this guard was titled "is the only place the claim is
    // written" and was not: two COMMENTS saying phase 5 does not exist survived it,
    // in the commit that builds phase 5. It only scanned for the live templates it
    // had just fixed, which is a guard written to pass rather than to catch.
    //
    // Comments are the artifact the next reader trusts most, so they count.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export const verificationCaveat'));
    const rest = src.replace(body.slice(0, body.indexOf('\n\n')), '');
    // KEYED ON WHAT THE RENDERER EMITS (RA-1102). This asserted on
    // `against a build of the deployed tag` — a phrase deleted from the file two
    // commits before the merge, so it matched nothing anywhere, and the
    // `body.slice()`/`replace()` exclusion above it protected nothing: removing the
    // exclusion entirely changed no result. Worse, the most probable fifth copy —
    // someone pasting what the function actually emits — sailed straight through.
    //
    // `itself (RA-1063, option c)` occurs exactly once today (the renderer), which
    // is what makes it usable as a key; the assertion below pins that count so this
    // cannot quietly become unkeyable again. (It was `not against staging itself` until
    // the caveat named the declared environment, kanon#199.)
    expect(rest, 'a second rendering of the caveat').not.toMatch(/itself \(RA-1063, option c\)/i);
    // Kept as a historical tripwire: it costs nothing and the old spelling
    // reappearing is still a copy.
    expect(rest, 'a second rendering, old spelling').not.toMatch(/against a build of the deployed tag/i);
    // Every way of saying phase 5 is absent, not just the one spelling I fixed.
    expect(rest, 'a claim that phase 5 is unbuilt').not.toMatch(/phase 5[\s\S]{0,60}(is not built|does not exist|is NOT built)/i);
    expect(rest, 'DEPLOYED-not-VERIFIED, which phase 5 supersedes').not.toMatch(/means DEPLOYED, not VERIFIED/i);

    // The key has to stay unique for the exclusion to mean anything.
    expect(
      (src.match(/itself \(RA-1063, option c\)/gi) ?? []).length,
      'the caveat key must occur exactly once — in the renderer',
    ).toBe(1);
  });

  it('the guard is not vacuous — a copy of the LIVE wording is caught', () => {
    // What the previous version missed. Reproduces the realistic fifth copy: text
    // pasted from what `verificationCaveat` emits, sitting outside the renderer.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export const verificationCaveat'));
    const excluded = body.slice(0, body.indexOf('\n\n'));
    const withCopy = src.replace(excluded, excluded) +
      '\n// verified against a **build of `${tag}`**, not against staging itself\n';
    const rest = withCopy.replace(excluded, '');
    expect(rest).toMatch(/not against staging itself/i);
  });
});


describe('everything a human reads from a tick agrees with itself (RA-1064)', () => {
  /**
   * `retro`, the close comment, `report`'s completion line and the action line are
   * four copies of one fact. The untagged-deploy case was fixed in three of them on
   * three consecutive review rounds — every fix a one-line string change, every one
   * verified by eye, every one leaving the next copy behind. Nothing in `tests/`
   * contained "Closed by the Lead" or "NOTHING was deployed", so the only mechanism
   * available was a reviewer re-reading the file.
   *
   * So this asserts AGREEMENT rather than four separate strings: whatever the wording
   * becomes, the surfaces cannot diverge on whether anything shipped.
   */
  const world = (proposedCount = 2) => ({
    project: 42,
    briefPath: 'docs/projects/42.md',
    proposed: Array.from({ length: proposedCount }, (_, i) => ({ title: `t${i}`, order: i })),
    all: Array.from({ length: proposedCount }, (_, i) => ({ number: i + 1, title: `t${i}`, state: 'CLOSED', labels: [] })),
    open: [], filed: [], blocked: [], unmilestoned: [],
  });

  const surfaces = (tag: string | null) => {
    const a = { kind: 'close-project', number: 42, tag };
    return {
      retro: retro(world(), a),
      close: renderCloseComment(a),
      action: renderCloseAction(a),
      caveat: verificationCaveat(tag),
    };
  };

  it('every surface says the work shipped when there is a tag', () => {
    const s = surfaces('v1.2.3');
    for (const [name, text] of Object.entries(s)) {
      expect(text, `${name} must name the release`).toContain('v1.2.3');
      expect(text, `${name} must not claim nothing shipped`).not.toMatch(/nothing (was )?deployed/i);
    }
  });

  it('every surface says NOTHING shipped when there is no tag', () => {
    // The exact defect: `(untagged)` reaching a human as though it were a release.
    const s = surfaces(null);
    for (const [name, text] of Object.entries(s)) {
      expect(text, `${name} must say nothing shipped`).toMatch(/nothing (was )?deployed|nothing deployed/i);
      expect(text, `${name} must not invent a release name`).not.toContain('(untagged)');
    }
  });

  it('report reaches the same conclusion as the comments it accompanies', () => {
    const w = world();
    const a = { kind: 'close-project', number: 42, tag: null };
    const text = report({ ...w, trackingClosed: false }, { phase: 'close', actions: [a], stopped: null });
    expect(text).toMatch(/nothing deployed/i);
    expect(text, 'the step summary of the run that closes the project must not disagree with the comment it posts').not.toContain('(untagged)');
  });

  it('report always names the project and phase, whatever else it says', () => {
    const text = report(world(), { phase: 'reconcile', actions: [], stopped: 'nothing eligible — #1 waits on #2' });
    expect(text).toContain('#42');
    expect(text).toContain('nothing eligible');
  });
});

describe('a held project takes no actions (RA-963)', () => {
  /**
   * State is derived, so a tick that failed re-reads the same world, computes the same
   * action and retries it. A brief naming a milestone that does not exist was retried
   * every hour, forever, each time producing a green run and a `::warning` nobody
   * reads. The hold is the memory — derived state on the tracking issue, which a human
   * can see in `gh issue list` and clear, rather than a checkpoint file.
   */
  const heldWorld = { project: 7, briefMerged: true, proposed: [{ title: 'a' }], filed: [], open: [], blocked: [], all: [], projectHeld: true };

  it('phaseOf reports `held` above every other phase', () => {
    expect(phaseOf(heldWorld)).toBe('held');
    // Above the brief gate too: a hold outranks "there is no brief yet", because the
    // hold may be the reason the brief cannot be read.
    expect(phaseOf({ ...heldWorld, briefMerged: false })).toBe('held');
  });

  it('proposes nothing and says why, naming what clears it', () => {
    const r = nextActions(heldWorld);
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/needs:human/);
    expect(r.stopped, 'a hold nobody knows how to clear is a deadlock').toMatch(/remove the label/i);
  });

  it('an unheld project is unaffected', () => {
    expect(phaseOf({ ...heldWorld, projectHeld: false })).not.toBe('held');
  });
});

describe('a review that never came is not progress (RA-1081)', () => {
  const HEAD = 'a'.repeat(40);
  const pr = (over = {}) => ({ state: 'OPEN', headSha: HEAD, reviews: [], ...over });

  it('a COMMENTED review does not clear a CHANGES_REQUESTED on the same head', () => {
    // Reachable: the playbook permitted a COMMENT verdict on a red required check
    // until RA-2299, a standalone inline comment makes one, and 19 of the Reviewer's last 96 reviews were
    // COMMENTED. Taking the last review regardless flipped the answer to "not blocked"
    // and reported a stopped project as in-progress.
    const reviews = [{ state: 'CHANGES_REQUESTED', sha: HEAD }, { state: 'COMMENTED', sha: HEAD }];
    expect(isReviewBlocked([pr({ reviews })])).toBe(true);
  });

  it('an APPROVED after a CHANGES_REQUESTED does clear it', () => {
    const reviews = [{ state: 'CHANGES_REQUESTED', sha: HEAD }, { state: 'APPROVED', sha: HEAD }];
    expect(isReviewBlocked([pr({ reviews })])).toBe(false);
  });

  it('flags a head with no review at all once it is old enough', () => {
    const old = new Date(Date.now() - 5 * 3600e3).toISOString();
    expect(awaitingReview([pr({ headPushedAt: old })])).toHaveLength(1);
  });

  it('does NOT flag a freshly pushed head — every healthy PR looks like this briefly', () => {
    expect(awaitingReview([pr({ headPushedAt: new Date().toISOString() })])).toEqual([]);
  });

  it('does not manufacture a stall from a missing timestamp', () => {
    expect(awaitingReview([pr({ headPushedAt: null })])).toEqual([]);
  });
});

/**
 * RA-1408 — recovering a review that never landed.
 *
 * `awaitingReview` has detected this hourly since RA-1081 and printed a note telling a
 * HUMAN to check `agent-review.yml`. The note was correct and nothing acted on it,
 * which is how PR RA-1503 sat unreviewed with its own fix inside it.
 */
describe('reviewRecovery', () => {
  const OLD = new Date(Date.now() - 5 * 3600e3).toISOString();
  const HEAD = 'deadbeefcafe';
  const prOn = (over = {}) => ({ number: 77, state: 'OPEN', headSha: HEAD, reviews: [], headPushedAt: OLD, ...over });
  const worldWith = (prs: unknown[], labels = ['agent:implement']) =>
    world({ open: [{ ...issue(5, labels), prs }] });
  const noRuns = () => [];
  /**
   * A run as `review-run-evidence.mjs` normalises it. `actor` is the field the whole
   * RA-1594 fix turns on — it is what separates a run this recovery started from the
   * label noise every implement PR manufactures — and it is why the read is the REST
   * runs endpoint rather than `gh run list`, which has no such field.
   */
  let seq = 0;
  /**
   * `createdAt` defaults to AFTER the head became churnable (`OLD` + 4h = an hour ago),
   * because that is where a run this recovery started necessarily sits — the tick only
   * churns once the head is that old. A run created BEFORE that boundary was started by
   * something else, which is the whole of RA-1714 and is asserted separately below.
   */
  const churnable = () => Date.now() - 30 * 60e3;
  const run = (over: Record<string, unknown> = {}) => ({
    id: ++seq, actor: 'example-implementer', event: 'pull_request',
    status: 'completed', conclusion: 'success',
    createdAt: new Date(churnable() + seq * 1000).toISOString(), ...over,
  });

  it('re-labels a head that has NO review run at all — PR RA-1503\'s own failure', () => {
    // MEASURED, not hypothetical: head `9ec0f389` had green CI across all five checks
    // and zero `agent-review` runs on any event. The PR sat on a CHANGES_REQUESTED
    // from an older SHA until a human dispatched by hand.
    const { churn, noted } = reviewRecovery(worldWith([prOn()]), { runsFor: noRuns });
    expect(churn).toHaveLength(1);
    expect(churn[0]).toMatchObject({ kind: 'review-churn', number: 77, sha: HEAD, issue: 5 });
    expect(noted, 'nothing to report when it acted').toEqual([]);
  });

  it('does NOT re-label a head whose review run FAILED — that is the cap or outage case', () => {
    // THE ONE THING THIS MUST NOT DO. Re-firing into a live cap fails the same way and
    // can extend the window; into an outage it just burns a run. A failed run IS
    // evidence the review was attempted, so the head is reported, never churned.
    const runs = () => [run({ id: 42, conclusion: 'failure' })];
    const { churn, noted } = reviewRecovery(worldWith([prOn()]), { runsFor: runs });
    expect(churn, 'a run exists — re-firing repeats it').toEqual([]);
    expect(noted).toHaveLength(1);
    expect(noted[0].why, 'and it points at the run to read').toMatch(/run 42/);
  });

  it('does not re-label while a review run is still in progress', () => {
    const runs = () => [run({ id: 43, status: 'in_progress', conclusion: null })];
    expect(reviewRecovery(worldWith([prOn()]), { runsFor: runs }).churn).toEqual([]);
  });

  it.each([
    ['in_progress', 'in_progress'],
    ['queued', 'queued'],
  ])('describes a %s run as UNFINISHED, not as a filter decline', (_l, status) => {
    // THE STATE THIS FEATURE CREATES. A churn fires a run, so the very next hourly
    // tick reads exactly one unfinished run for that head — this is the commonest
    // reading of a head the recovery has just acted on, not an edge case.
    //
    // `declined = !broken` put every null conclusion into the decline arm, so the note
    // said "the `filter` job declined this head" two clauses after printing
    // `in_progress`, and sent the reader to evidence lines for a decline that had not
    // happened. The existing in-progress test asserted only `churn === []` and never
    // looked at the text, which is why nothing caught it.
    const runs = () => [run({ id: 43, status, conclusion: null })];
    const { noted } = reviewRecovery(worldWith([prOn()]), { runsFor: runs });
    expect(noted[0].why).toMatch(/has NOT finished/);
    expect(noted[0].why, 'nothing to do about a run that is still going').toMatch(/nothing needs doing/);
    expect(noted[0].why, 'and it must not claim a decline').not.toMatch(/declined this head/);
    expect(noted[0].why, 'nor a failure').not.toMatch(/classify annotation for cap/);
  });

  it('prefers a FAILED run over an unfinished one when both exist for a head', () => {
    // A re-run leaves both. The failure is the actionable one and must win.
    const runs = () => [
      run({ id: 50, status: 'in_progress', conclusion: null }),
      run({ id: 49, conclusion: 'failure' }),
    ];
    const { noted } = reviewRecovery(worldWith([prOn()]), { runsFor: runs });
    expect(noted[0].why).toMatch(/run 49/);
    expect(noted[0].why).toMatch(/classify annotation/);
  });

  it('churns AT MOST ONCE per head, with no counter — the bound is the evidence', () => {
    // There is no attempt count, no marker comment and no state to reset. After a
    // churn a run exists for that head, so the next tick reads a run and reports
    // instead. This asserts the property that makes that true, by running the two
    // ticks in sequence against a store that the first tick populates.
    let store: Array<Record<string, unknown>> = [];
    const runsFor = () => store;
    const w = worldWith([prOn()]);

    const first = reviewRecovery(w, { runsFor });
    expect(first.churn, 'tick 1 acts').toHaveLength(1);
    // The churn fires a `labeled` event, which starts a run on that head.
    store = [run({ id: 44, actor: 'example-lead', status: 'in_progress', conclusion: null })];
    expect(reviewRecovery(w, { runsFor }).churn, 'tick 2 must not act again').toEqual([]);
  });

  it('names the NEWEST run, not the oldest — gh lists newest first', () => {
    // `runs.at(-1)` was the fallback, and `gh run list` returns newest-first (verified:
    // `createdAt` and `databaseId` both descend). So whenever no run had a non-success
    // conclusion — the all-green and still-running cases — the reader was handed the
    // OLDEST run for that head, labelled `latest`. Every fixture in the first cut had
    // one run, where oldest and newest are the same object.
    const runs = () => [
      run({ id: 999, actor: 'example-lead', createdAt: new Date(churnable() + 60e3).toISOString() }),
      run({ id: 111, actor: 'example-lead', createdAt: new Date(churnable()).toISOString() }),
    ];
    const { noted } = reviewRecovery(worldWith([prOn()]), { runsFor: runs });
    expect(noted[0].why, 'the newest is 999').toMatch(/run 999/);
    expect(noted[0].why, 'not the oldest').not.toMatch(/run 111/);
  });

  it('a run this recovery already fired is explained as the bound working, not as a cap', () => {
    // THE ONLY WAY A FINISHED, UNBROKEN RUN IS AN ATTEMPT: this recovery started it. It
    // carries no classify annotation — nothing failed — so pointing a reader at one
    // would send them looking for something that does not exist.
    const runs = () => [run({ id: 7, actor: 'example-lead', conclusion: 'success' })];
    const { noted } = reviewRecovery(worldWith([prOn()]), { runsFor: runs });
    expect(noted[0].why).toMatch(/ALREADY been recovered once/);
    expect(noted[0].why, 'pointing at evidence that exists').toMatch(/LAST_REVIEWED/);
    // It may MENTION the annotation to say there isn't one; it must not SEND you to it.
    expect(noted[0].why, 'and not send the reader to one').not.toMatch(/read that run's classify annotation/);
    expect(noted[0].why, 'saying plainly that none exists').toMatch(/no classify annotation/);
  });

  it('a FAILED run still gets the cap-vs-outage-vs-crash text', () => {
    const runs = () => [run({ id: 8, conclusion: 'failure' })];
    const { noted } = reviewRecovery(worldWith([prOn()]), { runsFor: runs });
    expect(noted[0].why).toMatch(/classify annotation/);
    expect(noted[0].why).not.toMatch(/ALREADY been recovered/);
  });

  /**
   * RA-1594 — the bound counted runs that never tried to review the head.
   *
   * `agent-review.yml` subscribes to `pull_request: [labeled]` and its job-level `if`
   * admits any label event on a PR that CARRIES a review label. So on an
   * `agent:implement` PR every label event manufactures a run: the two labels applied
   * at open, the Merger's `needs:human`, the Reviewer's own `agent:reviewer`.
   *
   * MEASURED on PR RA-1591, `"reviews": []`, head `b972df20` — the exact listing below.
   * Five runs, zero reviews. Had that head sat past the stall gate, the recovery would
   * have read `runs.length === 5`, taken the note branch, and — because one of them is a
   * concurrency-superseded `cancelled` — reported "re-firing repeats it, read the
   * classify annotation" about a head nothing had ever tried to review. The recovery
   * RA-1408 shipped was inert on exactly the head its motivating incidents sat on.
   */
  describe('what counts as a review ATTEMPT (RA-1594)', () => {
    // PR RA-1591's real listing, actors and all.
    const pr1591 = () => [
      run({ id: 33877416563, actor: 'example-reviewer', conclusion: 'skipped', createdAt: '2026-09-04T13:20:51Z' }),
      run({ id: 33877416564, actor: 'example-merger', conclusion: 'success', createdAt: '2026-09-04T13:19:25Z' }),
      run({ id: 33876870508, conclusion: 'success', createdAt: '2026-09-04T13:13:29Z' }),
      run({ id: 33876870010, conclusion: 'cancelled', createdAt: '2026-09-04T13:13:28Z' }),
      run({ id: 33876864567, conclusion: 'skipped', createdAt: '2026-09-04T13:13:25Z' }),
    ];

    it('churns an implement PR\'s initial head, where five label-triggered runs stand', () => {
      const { churn, noted } = reviewRecovery(worldWith([prOn()]), { runsFor: pr1591 });
      expect(churn, 'the head nothing has tried to review').toHaveLength(1);
      expect(noted).toEqual([]);
    });

    it('does not treat a SUPERSEDED cancelled run as a crash', () => {
      // Constraint 2 of RA-1594. `cancel-in-progress` is the ordinary death of a label
      // event here, and reporting the casualty as a crash sends a reader to a classify
      // annotation that was never written.
      const runs = () => [
        run({ id: 2, conclusion: 'success', createdAt: '2026-09-04T13:13:29Z' }),
        run({ id: 1, conclusion: 'cancelled', createdAt: '2026-09-04T13:13:28Z' }),
      ];
      expect(reviewRecovery(worldWith([prOn()]), { runsFor: runs }).churn).toHaveLength(1);
    });

    it('DOES treat a cancelled run with nothing newer as a break', () => {
      // NON-VACUITY on the rule above: a genuinely cancelled run — a timeout, a manual
      // cancel — is not superseded by anything, and re-firing it repeats it.
      const runs = () => [run({ id: 1, conclusion: 'cancelled' })];
      const { churn, noted } = reviewRecovery(worldWith([prOn()]), { runsFor: runs });
      expect(churn).toEqual([]);
      expect(noted[0].why).toMatch(/classify annotation/);
    });

    it('counts the churn\'s OWN run whatever it concluded — that is the entire loop bound', () => {
      // The hazard the actor rule closes. A head whose push was docs-only, or whose
      // commit carries `[skip-review]`, gets a churn run that legitimately DECLINES and
      // concludes `success` — and if a decline did not count, that head would be churned
      // every hour forever. There is no counter to fall back on.
      for (const conclusion of ['success', 'skipped', 'failure', 'cancelled']) {
        const runs = () => [run({ actor: 'example-lead', conclusion })];
        expect(reviewRecovery(worldWith([prOn()]), { runsFor: runs }).churn, conclusion).toEqual([]);
      }
    });

    it('does NOT count a the Lead-actored run that predates the churn window (RA-1714)', () => {
      // The actor is the App that applied a LABEL, and the Lead applies `review:please`
      // to its own brief PR at creation. Keying on the actor alone made such a head
      // permanently "already attempted" — RA-1594's inertness shape narrowed to one actor
      // class, on exactly the PRs RA-1689 was filed over (PR RA-1659 is one of the Lead's).
      //
      // What separates them is WHEN: this recovery only churns a head older than the
      // stall window, so its run is created at least that long after the push, while a
      // label applied at PR creation fires within seconds of it.
      const atCreation = () => [run({
        actor: 'example-lead', conclusion: 'success',
        createdAt: new Date(Date.now() - 5 * 3600e3 + 2000).toISOString(),
      })];
      expect(reviewRecovery(worldWith([prOn()]), { runsFor: atCreation }).churn).toHaveLength(1);
    });

    it('accepts the app/ and [bot] spellings of the recovery identity', () => {
      // One identity, three spellings across three endpoints. Matching the bare form
      // alone is what made revise mode skip every dispatch for its first weeks.
      for (const actor of ['example-lead', 'example-lead[bot]', 'app/example-lead']) {
        const runs = () => [run({ actor, conclusion: 'success' })];
        expect(reviewRecovery(worldWith([prOn()]), { runsFor: runs }).churn, actor).toEqual([]);
      }
    });
  });

  it('an UNREADABLE Actions listing churns nothing — absence of evidence is not evidence', () => {
    // FAIL CLOSED. `reviewRunsFor` returns null when `gh run list` throws, and null
    // must never be read as "no run has ever fired" — that would re-fire a review on
    // top of one already running, every hour, for as long as the read stays broken.
    const { churn, noted } = reviewRecovery(worldWith([prOn()]), { runsFor: () => null });
    expect(churn).toEqual([]);
    expect(noted[0].why).toMatch(/could not read/);
  });

  it('ignores a head that is freshly pushed, or already reviewed', () => {
    const fresh = prOn({ headPushedAt: new Date().toISOString() });
    expect(reviewRecovery(worldWith([fresh]), { runsFor: noRuns }).churn).toEqual([]);
    const reviewed = prOn({ reviews: [{ state: 'APPROVED', sha: HEAD }] });
    expect(reviewRecovery(worldWith([reviewed]), { runsFor: noRuns }).churn).toEqual([]);
  });

  it('looks the runs up BY COMMIT, so the listing is not a time window', () => {
    // `--limit N` is a time window in disguise: measured on this repo, 80 runs of
    // `agent-review.yml` covered 6.1 hours against a 4h age gate and no upper bound on
    // how long a PR stays unreviewed. A head whose review failed before the window
    // lists as ZERO runs and gets churned — the one thing this must never do, and it
    // degrades exactly on a busy day.
    //
    // Static, because the call is the io seam the rest of this suite injects past.
    const src = readFileSync(join(ROOT, 'scripts/review-run-evidence.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('export function reviewRunsFor'), src.indexOf('export function reviewAttempts'));
    expect(fn, 'the lookup must be scoped to the commit server-side').toMatch(/head_sha=\$\{sha\}/);
    // AND to this workflow, server-side. The repo-wide `actions/runs` form makes this
    // workflow compete for 100 unpaginated slots with every other workflow on the head,
    // and the direction of that loss is the forbidden one: under-counted attempts mean a
    // churn into a live or broken run.
    expect(fn, 'and to this workflow, server-side').toMatch(/actions\/workflows\/\$\{REVIEW_WORKFLOW_FILE\}\/runs/);
  });

  it('only looks at in-flight issues', () => {
    expect(reviewRecovery(worldWith([prOn()], []), { runsFor: noRuns }).churn).toEqual([]);
  });

  it('survives a world with no open issues at all', () => {
    expect(reviewRecovery(world({ open: [] }), { runsFor: noRuns })).toEqual({ churn: [], noted: [] });
    expect(reviewRecovery(undefined as never, { runsFor: noRuns }).churn).toEqual([]);
  });
});

/**
 * RA-1524 — the other half of RA-1408: a changes-request the implementer never answered.
 *
 * `isReviewBlocked` has detected this hourly since RA-1081 and printed a note telling a
 * human to "check that it ran". RA-1408 deliberately left it, because
 * `agent-implement-revise.yml` had no label to churn — it has one now.
 */
describe('reviseRecovery', () => {
  const OLD = new Date(Date.now() - 5 * 3600e3).toISOString();
  // The review's own clock, which is what this lane times and measures against since
  // RA-1690. Deliberately LATER than `headPushedAt`: the head always predates the review.
  const REVIEWED = new Date(Date.now() - 4.5 * 3600e3).toISOString();
  const AFTER = new Date(Date.now() - 4 * 3600e3).toISOString();
  const HEAD = 'cafed00dbeef';
  const blocked = (over = {}) => ({
    number: 55, state: 'OPEN', headSha: HEAD, headPushedAt: OLD,
    reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD, submittedAt: REVIEWED }], ...over,
  });
  const worldWith = (prs: unknown[], labels = ['agent:implement']) =>
    world({ open: [{ ...issue(9, labels), prs }] });
  const noRuns = () => [];

  it('re-labels a blocked head with NO revise run at all', () => {
    const { churn, noted } = reviseRecovery(worldWith([blocked()]), { runsFor: noRuns });
    expect(churn).toHaveLength(1);
    expect(churn[0]).toMatchObject({ kind: 'revise-churn', number: 55, sha: HEAD, issue: 9 });
    expect(noted).toEqual([]);
  });

  it('does NOT re-label when a revise run already exists', () => {
    // Same bound as the review lane: after a churn a run exists, so a head cannot be
    // churned twice — and a FAILED run is a run, so a cap or an outage is reported
    // rather than answered by repeating it.
    const runs = () => [{ headSha: HEAD, status: 'completed', conclusion: 'failure', databaseId: 21, createdAt: AFTER }];
    const { churn, noted } = reviseRecovery(worldWith([blocked()]), { runsFor: runs });
    expect(churn).toEqual([]);
    expect(noted[0].why).toMatch(/run 21/);
    expect(noted[0].why).toMatch(/classify annotation/);
  });

  it('describes an unfinished run as unfinished', () => {
    const runs = () => [{ headSha: HEAD, status: 'in_progress', conclusion: null, databaseId: 22, createdAt: AFTER }];
    expect(reviseRecovery(worldWith([blocked()]), { runsFor: runs }).noted[0].why)
      .toMatch(/has NOT finished/);
  });

  it('points a skipped run at the round cap rather than at a crash', () => {
    // The commonest non-churn case here is the round cap, which is the filter
    // declining — not a failure, and it carries no classify annotation.
    const runs = () => [{ headSha: HEAD, status: 'completed', conclusion: 'success', databaseId: 23, createdAt: AFTER }];
    const why = reviseRecovery(worldWith([blocked()]), { runsFor: runs }).noted[0].why;
    expect(why).toMatch(/round cap/);
    expect(why).not.toMatch(/classify annotation/);
  });

  it('ignores a head with no standing changes-request', () => {
    // An APPROVED after a CHANGES_REQUESTED on the same head clears it, and a request
    // against an OLDER commit was answered by the push that replaced it.
    const approved = blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD }, { state: 'APPROVED', sha: HEAD }] });
    expect(reviseRecovery(worldWith([approved]), { runsFor: noRuns }).churn).toEqual([]);
    const stale = blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: 'older' }] });
    expect(reviseRecovery(worldWith([stale]), { runsFor: noRuns }).churn).toEqual([]);
  });

  it('ignores a freshly SUBMITTED changes-request — the real run has not had time to start', () => {
    // CLOCKED ON THE REVIEW, NOT THE PUSH (RA-1690). What is being timed is "how long
    // has this request gone unanswered", and the head predates the review by
    // definition — so `headPushedAt` timed the wrong interval, always generously.
    const fresh = blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD, submittedAt: new Date().toISOString() }] });
    expect(reviseRecovery(worldWith([fresh]), { runsFor: noRuns }).churn).toEqual([]);
    // And the mutation that proves the clock actually moved: an OLD push carrying a
    // FRESH review is exactly the case the old gate got wrong. `headPushedAt` is `OLD`
    // on this fixture, so a gate still reading it would churn here.
    expect(fresh.headPushedAt, 'the head is stale while the review is not').toBe(OLD);
  });

  it('ignores a changes-request with no timestamp rather than inventing a stall', () => {
    const undated = blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD }] });
    expect(reviseRecovery(worldWith([undated]), { runsFor: noRuns }).churn).toEqual([]);
  });

  it('churns a head whose only run started BEFORE the review — PR RA-1660', () => {
    // THE DEFECT, as measured. The Reviewer requested changes on `9bfd43e` at 15:05:53 and
    // `agent-implement-revise.yml` never ran; the `pull_request_review` event was
    // lost. `reviseRecovery` still declined to churn, hourly for two days, because
    // run 33973225308 — `cancelled` at 14:55:06 by the concurrency group that killed
    // the duplicate label events at PR-open — counted as a delivery of a review that
    // did not yet exist. Worse, `cancelled` classifies as `broken`, so the note told a
    // human "re-firing repeats it" about a run that never saw the review.
    //
    // `runsFor` is the seam and production filters inside it, so a caller handing over
    // a pre-review run models a reader that has NOT filtered — the failure mode.
    const preReview = () => [{
      headSha: HEAD, status: 'completed', conclusion: 'cancelled', databaseId: 33973225308,
      createdAt: new Date(Date.parse(REVIEWED) - 10 * 60_000).toISOString(),
    }];
    expect(reviseRecovery(worldWith([blocked()]), { runsFor: (sha: LibraryValue, since: LibraryValue) => preReview().filter((r) => startedAfter(r, since)) }).churn,
      'the production reader drops it, so the churn happens').toHaveLength(1);
    expect(reviseRecovery(worldWith([blocked()]), { runsFor: preReview }).churn,
      'and a reader that leaked it would suppress the churn — the two-day park').toEqual([]);
  });

  it('passes the review timestamp to the reader, or the filter can never run', () => {
    // The seam carries the clock. Without this argument `reviseRunsFor` has nothing to
    // compare against, every run reads as an unknown clock, and RA-1690 reverts silently.
    let seen: unknown;
    reviseRecovery(worldWith([blocked()]), { runsFor: (_sha: LibraryValue, since: LibraryValue) => { seen = since; return []; } });
    expect(seen).toBe(REVIEWED);
  });

  it('an UNREADABLE run listing churns nothing', () => {
    const { churn, noted } = reviseRecovery(worldWith([blocked()]), { runsFor: () => null });
    expect(churn).toEqual([]);
    expect(noted[0].why).toMatch(/could not read/);
  });

  it('only looks at in-flight issues', () => {
    expect(reviseRecovery(worldWith([blocked()], []), { runsFor: noRuns }).churn).toEqual([]);
  });

  it('renders a revise note under its own heading, not the review lane\'s', () => {
    // OPPOSITE CONDITIONS (RA-1592 review). A review-lane note is a head with NO
    // verdict; a revise-lane note is a head that HAS one and is waiting on the
    // implementer. Both were printed under "Heads with no verdict", so half of them
    // read as the opposite of what they are.
    const w = world({ open: [issue(9, ['agent:implement'])] });
    const out = report(w, {
      phase: 'reconcile', actions: [], stopped: null,
      reviewNotes: [
        { pr: 11, sha: 'aaaaaaa1', why: 'no verdict here' },
        { lane: 'revise', pr: 22, sha: 'bbbbbbb2', why: 'the implementer has not answered' },
      ],
    });
    expect(out).toMatch(/NOT re-labelled for review/);
    expect(out).toMatch(/standing changes-request that were NOT re-labelled for revision/);
    const reviewIdx = out.indexOf('NOT re-labelled for review');
    const reviseIdx = out.indexOf('NOT re-labelled for revision');
    expect(out.indexOf('PR #11'), 'the review note under the review heading')
      .toBeGreaterThan(reviewIdx);
    expect(out.indexOf('PR #11'), 'and above the revise heading').toBeLessThan(reviseIdx);
    expect(out.indexOf('PR #22'), 'the revise note under the revise heading').toBeGreaterThan(reviseIdx);
  });

  it('a label-skip run is not a delivery, so the churn still happens', () => {
    // THE DEFECT THE TRIGGER INTRODUCED (RA-1592 review). Subscribing to
    // `pull_request: [labeled]` means every label event starts a run on that head —
    // and an implement PR collects `agent:implement` + `review:please` at open and
    // `agent:reviewer` on the first review, ALL on the head the first
    // changes-request lands on. Counting those as deliveries suppressed the churn on
    // exactly the head the recovery exists for.
    //
    // Measured on this PR's own head: three runs, two of them label events
    // concluding `success`. The job-level `if` makes non-marker label events
    // conclude `skipped` instead, and `reviseRunsFor` drops those.
    const skipped = () => [
      { headSha: HEAD, status: 'completed', conclusion: 'skipped', databaseId: 31, createdAt: AFTER },
      { headSha: HEAD, status: 'completed', conclusion: 'skipped', databaseId: 32, createdAt: AFTER },
    ];
    // `runsFor` is the seam; production filters `skipped` inside it, so a caller that
    // hands them over models a reader that has NOT filtered — the failure mode.
    expect(reviseRecovery(worldWith([blocked()]), { runsFor: () => [] }).churn, 'nothing to see -> churn')
      .toHaveLength(1);
    expect(reviseRecovery(worldWith([blocked()]), { runsFor: skipped }).churn,
      'and a reader that leaked skips would suppress it').toEqual([]);
  });

  it('the reader drops skipped runs but keeps the churn\'s own', () => {
    // THE BOUND DEPENDS ON THIS. "After a churn a run exists" is the only thing
    // stopping an hourly re-churn — so the filter must drop non-deliveries WITHOUT
    // dropping the delivery the churn itself made, or the same head is re-churned
    // forever. BEHAVIOURAL since RA-1724 moved the rules into `revise-run-evidence.mjs`;
    // the only source assertion left is the one a fixture cannot reach — the listing
    // must ask for the fields the rules read.
    const read = (runs: unknown[]) => reviseRunsFor(HEAD, REVIEWED, { json: () => runs });
    expect(read([{ headSha: HEAD, conclusion: 'skipped', createdAt: AFTER }]), 'skipped runs are not deliveries').toEqual([]);
    for (const conclusion of ['success', null, 'failure'])
      expect(read([{ headSha: HEAD, conclusion, createdAt: AFTER }]), `a ${conclusion} run is`).toHaveLength(1);
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('export function reviseRunsFor'), src.indexOf('\n}', src.indexOf('export function reviseRunsFor')));
    // `event` since RA-2301: without it a cancelled review-event delivery falls back to
    // "anything newer" and is dropped as superseded.
    expect(fn, 'which needs the fields the rules read')
      .toMatch(/'--json', 'headSha,event,status,conclusion,databaseId,createdAt'/);
    expect(fn, 'and hands them over RAW, skipped included — a skipped run is what supersedes (#1724)')
      .toMatch(/reviseDeliveries\(runs, \{ sha, since, churnedAfter \}\)/);
  });

  it('keeps a cancelled REVIEW-event delivery however many label runs follow it (RA-2301)', () => {
    const at = (s: number) => new Date(Date.parse(REVIEWED) + s * 1000).toISOString();
    const runs = [
      { headSha: HEAD, event: 'pull_request_review', status: 'completed', conclusion: 'cancelled', databaseId: 1, createdAt: at(3) },
      { headSha: HEAD, event: 'pull_request', status: 'completed', conclusion: 'skipped', databaseId: 2, createdAt: at(4) },
    ];
    const kept = reviseRunsFor(HEAD, REVIEWED, { json: () => runs, churnedAfter: at(4 * 3600) });
    expect((kept ?? []).map((r: { databaseId?: number }) => r.databaseId)).toEqual([1]);
  });

  describe('a cancelled run a newer one superseded is not a delivery (RA-1724)', () => {
    // PR RA-2267 head `6b48ca6`, measured: the Reviewer's review (35848261456, success), his
    // `agent:reviewer` label run pending behind it (35848263198), and the Merger's
    // `needs:human` 20 s later (35848293949, skipped) displacing that to `cancelled`.
    // 15 of 52 cancelled implement-revise runs have this shape.
    const at = (s: number) => new Date(Date.parse(REVIEWED) + s * 1000).toISOString();
    const burst = [
      { headSha: HEAD, status: 'completed', conclusion: 'success', databaseId: 35848261456, createdAt: at(3) },
      { headSha: HEAD, status: 'completed', conclusion: 'cancelled', databaseId: 35848263198, createdAt: at(4) },
      { headSha: HEAD, status: 'completed', conclusion: 'skipped', databaseId: 35848293949, createdAt: at(24) },
    ];

    it('the reader drops the displaced label run and keeps the review run', () => {
      const runs = reviseRunsFor(HEAD, REVIEWED, { json: () => burst, churnedAfter: at(4 * 3600) });
      expect((runs ?? []).map((r: LibraryValue) => r.databaseId)).toEqual([35848261456]);
    });

    it('so a parked head is NOT reported as broken with "re-firing repeats it"', () => {
      // RA-1690's inverted advice. The deliveries decide the note: the round cap's
      // `success` is the real reason, and it carries no classify annotation.
      const runsFor = (sha: string, since: string, o: { churnedAfter?: string | null } = {}) =>
        reviseRunsFor(sha, since, { json: () => burst, ...o });
      const why = reviseRecovery(worldWith([blocked()]), { runsFor }).noted[0].why;
      expect(why).not.toMatch(/Re-firing repeats it/);
      expect(why).toMatch(/run 35848261456/);
    });

    it('recovery passes the churn boundary, or a superseded churn run would be re-churned hourly', () => {
      // THE BOUND. Without `churnedAfter` the reader fails closed and keeps every
      // post-review cancelled run — the fix inert. With it, a run the churn started
      // counts whatever it concluded, superseded or not.
      let seen: unknown;
      reviseRecovery(worldWith([blocked()]), { runsFor: (_s: string, _since: string, o?: { churnedAfter?: string | null }) => { seen = o?.churnedAfter; return []; } });
      expect(seen).toBe(new Date(Date.parse(REVIEWED) + 4 * 3600e3).toISOString());
      const churnRun = { headSha: HEAD, status: 'completed', conclusion: 'cancelled', databaseId: 9, createdAt: at(5 * 3600) };
      const later = { headSha: HEAD, status: 'completed', conclusion: 'skipped', databaseId: 10, createdAt: at(5 * 3600 + 30) };
      expect(reviseRunsFor(HEAD, REVIEWED, { json: () => [churnRun, later], churnedAfter: seen as string }),
        'the churn\'s own run still counts when displaced').toHaveLength(1);
    });
  });

  it('the world carries the review clock the whole lane depends on', () => {
    // THE ROOT OF RA-1660, and the one thing every other test here assumes. `linkedPrs`
    // is io and unexported, so while this projection lived inline nothing could
    // observe it — `submittedAt` was simply missing and no test noticed. Dropping the
    // field must now be a red test, not a silent revert to `headPushedAt`.
    expect(projectReviews([{ state: 'CHANGES_REQUESTED', commit: { oid: HEAD }, submittedAt: REVIEWED }]))
      .toEqual([{ state: 'CHANGES_REQUESTED', sha: HEAD, reviewedSha: null, submittedAt: REVIEWED }]);
    // RA-1725: the stamp is parsed into the world, so `standingChangesRequest` can read
    // what the review READ rather than what GitHub filed it under.
    expect(projectReviews([{ state: 'CHANGES_REQUESTED', commit: { oid: HEAD }, submittedAt: REVIEWED,
      body: `findings\n\n<!-- reviewed: sha=${'a'.repeat(40)} run=7 -->` }])[0].reviewedSha).toBe('a'.repeat(40));
    expect(projectReviews([{ state: 'APPROVED', commit: { oid: HEAD } }])[0].submittedAt,
      'an undated review is explicitly null, so every consumer fails closed on it').toBeNull();
    expect(projectReviews(undefined), 'a PR with no reviews is not a crash').toEqual([]);
  });

  it('standingChangesRequest returns the review, not just the fact of it', () => {
    // `isReviewBlocked` stays a boolean for its other callers; this is what gives the
    // revise lane the timestamp. Same RA-1081 rule about COMMENTED not being a verdict.
    const pr = blocked();
    expect(standingChangesRequest(pr)?.submittedAt).toBe(REVIEWED);
    expect(standingChangesRequest(blocked({ reviews: [
      { state: 'CHANGES_REQUESTED', sha: HEAD, submittedAt: REVIEWED },
      { state: 'COMMENTED', sha: HEAD, submittedAt: AFTER },
    ] }))?.submittedAt, 'a trailing COMMENTED does not answer it').toBe(REVIEWED);
    expect(standingChangesRequest(blocked({ state: 'MERGED' })), 'a merged PR is not blocked').toBeNull();
    expect(standingChangesRequest(blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: 'older', submittedAt: REVIEWED }] })),
      'a request against an older head was answered by the push').toBeNull();
  });

  it('standingChangesRequest matches on what the review READ, not where GitHub filed it (RA-1725)', () => {
    // RA-1680's shape: the Reviewer read `older`, a push made the head HEAD before he
    // submitted, and GitHub filed the review under HEAD. The stamp says `older`.
    const misfiled = blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD, reviewedSha: 'older', submittedAt: REVIEWED }] });
    expect(standingChangesRequest(misfiled), 'the push answered a review of an older commit').toBeNull();
    expect(reviseRecovery(worldWith([misfiled]), { runsFor: noRuns }).churn, 'so nothing is churned').toEqual([]);
    // The reverse: filed under an older commit, but it read the head.
    expect(standingChangesRequest(blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: 'older', reviewedSha: HEAD, submittedAt: REVIEWED }] })))
      .not.toBeNull();
    // No stamp falls back to `commit.oid` — every review predating RA-1680, and every
    // out-of-band one. The bare-`sha` fixtures above are that fallback.
    expect(standingChangesRequest(blocked({ reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD, reviewedSha: null, submittedAt: REVIEWED }] })))
      .not.toBeNull();
    // End to end through the projection: the body a `gh pr view --json reviews` read returns.
    const [projected] = projectReviews([{ state: 'CHANGES_REQUESTED', commit: { oid: HEAD }, submittedAt: REVIEWED,
      body: 'x\n\n<!-- reviewed: sha=0ddba11 run=1 -->' }]);
    expect(standingChangesRequest(blocked({ reviews: [projected] }))).toBeNull();
  });

  it('the reader itself drops a pre-review run and keeps a post-review one', () => {
    // BEHAVIOURAL, not a source-text assertion (RA-1690). The `skipped` half of this
    // filter was pinned by reading the source, and a source assertion cannot tell a
    // filter that WORKS from one that merely reads right — the cancelled runs went
    // through it for two days. So the reader now takes a `json` seam, like its sibling.
    const run = (over: object) => ({ headSha: HEAD, conclusion: 'cancelled', ...over });
    const read = (runs: unknown[], since?: string) => reviseRunsFor(HEAD, since, { json: () => runs });
    expect(read([run({ createdAt: new Date(Date.parse(REVIEWED) - 600_000).toISOString() })], REVIEWED),
      'cancelled before the review').toEqual([]);
    expect(read([run({ createdAt: AFTER })], REVIEWED),
      'cancelled after it is a real delivery attempt and must NOT be repeated').toHaveLength(1);
    expect(read([run({ conclusion: 'skipped', createdAt: AFTER })], REVIEWED),
      'a non-marker label event after the review is still not a delivery').toEqual([]);
    expect(read([run({ headSha: 'other', createdAt: AFTER })], REVIEWED),
      'and another head is not this head').toEqual([]);
  });

  it('the reader returns null rather than [] when the listing throws', () => {
    expect(reviseRunsFor(HEAD, REVIEWED, { json: () => { throw new Error('403'); } })).toBeNull();
  });

  it('startedAfter fails closed on either clock being unreadable', () => {
    // An unknown timestamp counts the run, which SUPPRESSES a churn. Same direction as
    // an unreadable run listing: never manufacture a re-fire out of missing data.
    expect(startedAfter({ createdAt: AFTER }, REVIEWED), 'after').toBe(true);
    expect(startedAfter({ createdAt: OLD }, REVIEWED), 'before').toBe(false);
    expect(startedAfter({ createdAt: REVIEWED }, REVIEWED), 'exactly at the review counts').toBe(true);
    expect(startedAfter({}, REVIEWED), 'run with no clock').toBe(true);
    expect(startedAfter({ createdAt: OLD }, undefined), 'review with no clock').toBe(true);
    expect(startedAfter({ createdAt: 'not a date' }, REVIEWED), 'unparseable').toBe(true);
  });

  it('the marker gate is on the JOB, so a non-marker label concludes skipped', () => {
    // An in-script skip exits 0 and the RUN concludes `success`, which the reconciler
    // reads as a delivery. Only a job-level `if` produces `skipped`.
    // The gate is the Kanon lane's since RA-2709; this repo's caller has no `if`, so the
    // lane's filter job is the run's only root job, and its gate is the run's.
    const caller = readCaller('agent-implement-revise.yml');
    expect(Object.values(caller.jobs as Record<string, { if?: string }>).map((j) => j.if)).toEqual([undefined]);
    const wf = readKanonLane(Object.values(caller.jobs as Record<string, { uses?: string }>)[0]!) as unknown as {
      jobs: Record<string, { if?: string }>;
    };
    expect(wf.jobs.filter?.if, 'the filter job must gate on the marker')
      .toMatch(/github\.event\.label\.name == 'agent:revise'/);
    expect(wf.jobs.filter?.if, 'and must not gate out the review or dispatch paths')
      .toMatch(/github\.event_name != 'pull_request'/);
  });

  it('the label it churns is one the revise workflow actually triggers on', () => {
    // THE WIRING IS THE FEATURE. A churn of a label no workflow subscribes to is a
    // no-op that reports success — the silent-inertness shape this pipeline keeps
    // rediscovering — and fail-closed reporting would make it invisible.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const label = src.match(/^const REVISE = '([^']+)';$/m)?.[1];
    expect(label, 'the reconciler must name a label').toBeTruthy();

    const wf = readCaller('agent-implement-revise.yml') as unknown as {
      on?: Record<string, { types?: string[] }>;
      jobs: Record<string, { steps?: Array<{ id?: string; env?: Record<string, string> }> }>;
    };
    const on = (wf as unknown as { on?: Record<string, { types?: string[] }>; true?: Record<string, { types?: string[] }> });
    const triggers = on.on ?? on.true ?? {};
    expect(triggers.pull_request?.types, 'the workflow must subscribe to label events')
      .toContain('labeled');

    // The filter is the Kanon lane's since RA-2709, read from the checkout at the pinned tag.
    const lane = readKanonLane(Object.values(wf.jobs as Record<string, { uses?: string }>)[0]!) as unknown as typeof wf;
    const filter = Object.values(lane.jobs ?? {}).flatMap((j) => j.steps ?? []).find((st) => st.id === 'filter');
    expect(filter?.env?.REVISE_LABEL, 'and gate on the same label the reconciler churns')
      .toBe(label);
  });

  it('and the revise churn is not charged to the tick budget either', () => {
    expect(chargeable([{ kind: 'revise-churn' }, { kind: 'review-churn' }])).toBe(0);
    expect(chargeable([{ kind: 'revise-churn' }, { kind: 'dispatch' }])).toBe(1);
  });
});

describe('the review recovery reaches every tick, not just the capped one (RA-1408)', () => {
  const OLD = new Date(Date.now() - 5 * 3600e3).toISOString();
  const HEAD = 'f00df00d';
  const prOn = () => ({ number: 88, state: 'OPEN', headSha: HEAD, reviews: [], headPushedAt: OLD });

  it('fires on a project UNDER its WIP cap — the branch the old detector never reached', () => {
    // THE DEFECT THIS CLOSES. `awaitingReview` was evaluated only inside the
    // `slots <= 0` branch, so a project with room never ran the check at all. That is
    // the common case, and it is the case where work is still flowing past a PR nobody
    // will ever review.
    const w = world({ open: [{ ...issue(5, ['agent:implement']), prs: [prOn()] }] });
    const d = nextActions(w, { wip: 10, runsFor: () => [] });
    expect(d.actions.filter((a: { kind: string }) => a.kind === 'review-churn')).toHaveLength(1);
  });

  it('fires even when the tick budget is exhausted', () => {
    // A review churn starts no implementer and takes no WIP slot, so charging it to
    // the implementer budget would mean the most starved tick is the one that cannot
    // unblock itself.
    const w = world({ open: [{ ...issue(5, ['agent:implement']), prs: [prOn()] }] });
    const d = nextActions(w, { budgetLeft: 0, runsFor: () => [] });
    expect(d.stopped, 'the tick still reports why it did nothing else').toMatch(/budget exhausted/);
    expect(d.actions.filter((a: { kind: string }) => a.kind === 'review-churn')).toHaveLength(1);
  });

  it('leaves a tick with nothing to recover exactly as it was', () => {
    const w = world({ open: [issue(5, ['agent:implement'])] });
    const plain = nextActions(w, { runsFor: () => [] });
    expect(plain.reviewNotes, 'no key added when there is nothing to say').toBeUndefined();
  });

  it('renders a churn as itself, not as a phantom dispatch', () => {
    // The action-line ternary ends in an UNGUARDED `dispatch` arm, so an unrecognised
    // kind renders as "`dispatch` — #N **undefined**" — a plausible line about an
    // implementer run that is not happening.
    const w = world({ open: [{ ...issue(5, ['agent:implement']), prs: [prOn()] }] });
    const out = report(w, { phase: 'reconcile', actions: [{ kind: 'review-churn', number: 88, sha: HEAD, issue: 5 }], stopped: null });
    expect(out).toMatch(/review-churn/);
    expect(out).toMatch(/re-label PR #88 for review/);
    expect(out, 'and never as a dispatch').not.toMatch(/`dispatch` — #88/);
    expect(out).not.toMatch(/undefined/);
  });

  it('renders a revise churn as itself, not as a phantom dispatch (RA-1598)', () => {
    // The same unguarded fall-through, reached from the third churn arm.
    const w = world({ open: [{ ...issue(5, ['agent:implement']), prs: [prOn()] }] });
    const out = report(w, { phase: 'reconcile', actions: [{ kind: 'revise-churn', number: 88, sha: HEAD, issue: 5 }], stopped: null });
    expect(out).toMatch(/revise-churn/);
    expect(out).toMatch(/re-label PR #88 for revision/);
    expect(out, 'and never as a dispatch').not.toMatch(/`dispatch` — #88/);
    expect(out).not.toMatch(/undefined/);
  });

  it.each([
    ['review-churn', "REVIEW_PLEASE"],
    ['verify', 'VERIFY'],
    // RA-1598: the third arm, and the one where the order matters on EVERY head after
    // the first — `agent:revise` is sticky, so the remove is the only thing that makes
    // the add a `labeled` event.
    ['revise-churn', 'REVISE'],
  ])('%s removes the label BEFORE re-adding it', (kind, label) => {
    // ALL THREE CHURN ARMS DEPEND ON THIS ORDER and none was guarded — the `verify` arm
    // has carried the reasoning in a comment since RA-1281 and nothing enforced it.
    // Adding a label the target already has is a NO-OP that fires no event, so an
    // add-then-remove ordering leaves the workflow untriggered AND the label gone: a
    // tick that reports it acted and did nothing, in the arm whose entire job is
    // firing an event.
    //
    // Static, because `execute` shells `gh` and is not reachable from a unit test.
    // A source-shape assertion is weaker than a behavioural one; it is also the only
    // thing standing between a plausible edit and a silent no-op.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const arm = src.slice(src.indexOf(`} else if (a.kind === '${kind}')`));
    const remove = arm.indexOf(`'--remove-label', ${label}`);
    const add = arm.indexOf(`'--add-label', ${label}`);
    expect(remove, `${kind} must remove ${label}`).toBeGreaterThan(-1);
    expect(add, `${kind} must re-add ${label}`).toBeGreaterThan(-1);
    expect(remove, `${kind}: the remove is what makes the add an event`).toBeLessThan(add);
  });

  it('reports the heads it deliberately did NOT churn', () => {
    // "detected 3, churned 1" with no explanation reads as two silently dropped.
    const w = world({ open: [issue(5, ['agent:implement'])] });
    const out = report(w, {
      phase: 'reconcile', actions: [], stopped: null,
      reviewNotes: [{ pr: 88, sha: HEAD, why: '1 review run(s) exist for this head and none posted a verdict (latest: completed/failure, run 42)' }],
    });
    expect(out).toMatch(/NOT re-labelled/);
    expect(out).toMatch(/PR #88/);
    // THE HEADER MUST NOT RESTATE PER-NOTE GUIDANCE (RA-1523 review round 3). It said
    // "a review run already exists for each, so re-firing repeats whatever it hit.
    // Read that run's classify annotation" — which contradicts the bullet under it for
    // a skipped run (there is no annotation) and is FALSE for an unreadable listing,
    // where no run is known to exist and the recovery is blind.
    expect(out, 'the header must not assert a run exists').not.toMatch(/a review run already exists for each/);
    expect(out, 'nor send everyone to an annotation').not.toMatch(/NOT re-labelled\*\* — .*classify annotation/);
    expect(out, 'it must say the reasons differ').toMatch(/different responses/);
  });
});

describe('a dependency cycle is decidable and is not a wait (RA-977)', () => {
  it('finds a two-issue cycle', () => {
    expect(dependencyCycles([{ number: 1, dependsOn: [2] }, { number: 2, dependsOn: [1] }])).toEqual([[1, 2]]);
  });

  it('finds a longer cycle', () => {
    expect(dependencyCycles([
      { number: 1, dependsOn: [2] }, { number: 2, dependsOn: [3] }, { number: 3, dependsOn: [1] },
    ])).toEqual([[1, 2, 3]]);
  });

  it('reports one cycle once, however it is entered', () => {
    // `A→B→A` and `B→A→B` are the same finding; reporting both would double-count.
    expect(dependencyCycles([{ number: 2, dependsOn: [1] }, { number: 1, dependsOn: [2] }])).toHaveLength(1);
  });

  it('says nothing about an acyclic graph, including a long chain', () => {
    expect(dependencyCycles([
      { number: 1, dependsOn: [] }, { number: 2, dependsOn: [1] }, { number: 3, dependsOn: [2] },
    ])).toEqual([]);
  });

  it('ignores a dependency on an issue outside the set', () => {
    // A dep on something not open here is `unfiledDeps`' business, not a cycle.
    expect(dependencyCycles([{ number: 1, dependsOn: [99] }])).toEqual([]);
  });
});

describe('a real label with a space is a label (RA-1004)', () => {
  const brief = ['## Decomposition', '### Issue A — a', '**Milestone:** Product Backlog',
    '**Labels:** `good first issue` · `follow-up`', '', 'body'].join('\n');

  it('accepts it when the repo says it exists', () => {
    const [issue] = parseProposed(brief, { knownLabels: new Set(['good first issue', 'follow-up']) });
    expect(issue.labels).toEqual(['good first issue', 'follow-up']);
    expect(issue.droppedLabels).toEqual([]);
  });

  it('drops one the repo does not have, so it still fails closed', () => {
    const [issue] = parseProposed(brief, { knownLabels: new Set(['follow-up']) });
    expect(issue.droppedLabels).toEqual(['good first issue']);
  });

  it('falls back to shape when the repo cannot be read, and a space no longer fails', () => {
    // `undefined` knownLabels means the label list was unreadable. Rejecting every
    // label there would deadlock the project on an API hiccup — failing closed on the
    // wrong axis.
    const [issue] = parseProposed(brief);
    expect(issue.labels).toContain('good first issue');
  });

  it('still rejects prose that drifted into the labels line', () => {
    const bad = ['## Decomposition', '### Issue A — a', '**Milestone:** X',
      '**Labels:** `this is definitely not a label and is far too long to be one`', '', 'b'].join('\n');
    expect(parseProposed(bad)[0].droppedLabels).toHaveLength(1);
  });
});

describe('a brief may name an issue that already exists (RA-976)', () => {
  /**
   * The first real brief does: `**Closes RA-897; supersedes the caller-side guards in
   * PR RA-869**`. Nothing read it, so the tick filed a SECOND issue for work RA-897
   * already tracked. The implementer's PR closed the new one and RA-897 stayed open
   * forever — permanently, because the file phase dedups by title and never re-files.
   */
  const BRIEF_ADOPT = ['# Brief', '', '## Decomposition', '',
    '### Issue A — adopted work', '',
    '**Milestone:** Production Ready · **Labels:** `sev:critical` · **Closes #897; supersedes the caller-side guards in PR #869**', '',
    'It does a thing.', ''].join('\n');

  it('parses the issue number, and only from the leading run', () => {
    const [issue] = parseProposed(BRIEF_ADOPT);
    // 869 is a PR named in the rationale. Adopting it would have the tick dispatch an
    // implementer at a pull request.
    expect(issue.closes).toEqual([897]);
  });

  it('adopts rather than filing a rival issue', () => {
    const w = worldFrom(BRIEF_ADOPT, []);
    const r = nextActions(w, { wip: 5 });
    expect(r.actions.map((a: { kind: string }) => a.kind)).toEqual(['adopt']);
    expect(r.actions[0]).toMatchObject({ number: 897, title: 'adopted work' });
  });

  it('does not adopt twice, on an issue whose title is its OWN', () => {
    // THE FIXTURE MATTERS AND THE FIRST ONE WAS UNREACHABLE. It gave RA-897 the brief's
    // own proposed title — the single state in which adoption never happens at all,
    // because the file phase's dedup would have suppressed filing. So the test was
    // green over a deadlock (RA-1213 review). An adopted issue keeps the title its
    // author wrote, which is the only realistic shape.
    const w = worldFrom(BRIEF_ADOPT, [{ number: 897, title: 'settleOrderWith needs a from-set' }]);
    const kinds = nextActions(w, { wip: 5 }).actions.map((a: { kind: string }) => a.kind);
    expect(kinds).not.toContain('adopt');
    expect(kinds).not.toContain('file');
  });

  it('LEAVES the file phase once the adoption lands', () => {
    // The blocking defect: `phaseOf` compared titles only, and an adopted issue never
    // carries the brief's item title — if it did, no adoption would have been needed.
    // So the project never left `file`, `nextActions` produced no action AND no
    // `stopped`, and the tick was a silent hourly no-op, green, forever. That is the
    // class this whole change set exists to close, committed inside it.
    const w = worldFrom(BRIEF_ADOPT, [{ number: 897, title: 'settleOrderWith needs a from-set' }]);
    expect(phaseOf(w)).not.toBe('file');
  });

  it('never returns zero actions in the file phase without saying why', () => {
    // The second half of the same defect. Whatever the phase gate does, a tick that
    // proposes nothing must say so — silence is what made this survivable.
    const w = worldFrom(BRIEF_ADOPT, [{ number: 897, title: 'settleOrderWith needs a from-set' }]);
    const r = nextActions(w, { wip: 5 });
    if (!r.actions.length) expect(r.stopped ?? r.phase).toBeTruthy();
  });

  it('resolves a LATER item\'s dependency on an adopted one', () => {
    // The Reviewer's second-order case, from the real brief: Issue D depends on Issue B, and
    // B was adopted. A title-only join left B with `key: undefined`, so `byKey` never
    // learned 'B' and D's dependency became a permanent `unfiledDeps`, reported as
    // "a brief defect, not a wait" — which it is not, it is the adoption.
    const brief = ['## Decomposition', '',
      '### Issue B — adopted work', '', '**Milestone:** Product Backlog · **Closes #897**', '', 'body.', '',
      '### Issue D — dependent work', '', '**Milestone:** Product Backlog', '', '**Depends on:** Issue B (because)', '', 'body.', ''].join('\n');
    const w = worldFrom(brief, [
      { number: 897, title: 'settleOrderWith needs a from-set' },
      { number: 2, title: 'dependent work' },
    ]);
    const d = (w.all as Array<Record<string, unknown>>).find((i) => i.number === 2) as
      { unfiledDeps: string[]; dependsOn: number[] } | undefined;
    expect(d?.unfiledDeps, 'B is adopted, not missing').toEqual([]);
    expect(d?.dependsOn).toEqual([897]);
  });

  it('an item that adopts is never also filed', () => {
    const w = worldFrom(BRIEF_ADOPT, []);
    expect(nextActions(w, { wip: 5 }).actions.some((a: { kind: string }) => a.kind === 'file')).toBe(false);
  });

  it('adoptions do not stall the brief\'s other issues', () => {
    // Returning adoptions ALONE held the rest for a tick for no reason — they are
    // different actions on different issues.
    const mixed = BRIEF_ADOPT + ['### Issue B — ordinary work', '', '**Milestone:** Production Ready', '', 'thing.', ''].join('\n');
    const kinds = nextActions(worldFrom(mixed, []), { wip: 5 }).actions.map((a: { kind: string }) => a.kind);
    expect(kinds).toContain('adopt');
    expect(kinds).toContain('file');
  });
});

describe('a lost membership marker is not a reason to duplicate (RA-1069)', () => {
  /**
   * Membership is the body's last non-empty line being the marker — right for the
   * false POSITIVE it fixes, and it widened the false negative, which is the
   * unamendable one. A human appending "Blocked on X" below the marker un-files the
   * issue, and the next tick re-files a duplicate of work that may be in progress.
   * The marker is an HTML comment, invisible when rendered, so nothing warns them.
   */
  const B = BRIEF(['a']);

  it('refuses to re-file a title that already exists outside the project', () => {
    const w = { ...worldFrom(B, []), searchTitles: ['a'] };
    const r = nextActions(w, { wip: 5 });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/lost the project marker/i);
  });

  it('escalates it, because a member that stopped declaring membership is a real defect', () => {
    const w = { ...worldFrom(B, []), searchTitles: ['a'] };
    expect(nextActions(w, { wip: 5 }).escalate?.length).toBeGreaterThan(0);
  });

  it('says how to fix it — the marker must be the LAST line', () => {
    const w = { ...worldFrom(B, []), searchTitles: ['a'] };
    expect(nextActions(w, { wip: 5 }).stopped).toMatch(/last line/i);
  });

  it('still files a title that genuinely does not exist', () => {
    const w = { ...worldFrom(B, []), searchTitles: ['something else'] };
    expect(nextActions(w, { wip: 5 }).actions.map((a: { kind: string }) => a.kind)).toEqual(['file']);
  });
});

describe('a reopened tracking issue is a human decision (RA-1062)', () => {
  /**
   * Phase 6's "a re-run is a no-op, not a second retro" held only while the issue
   * stayed closed. Reopening it is how a human says *this project is not done* — and
   * the next hourly tick re-derived `close`, posted the retro again and closed it
   * again, within the hour, every time. `blocked` is consulted on the FILED issues,
   * never on the tracking issue, so the one issue a human is most likely to act on sat
   * outside the pipeline's own rule about not routing around a human's answer.
   */
  // A world that has REACHED phase 6: the brief parsed, its issue was filed and is
  // closed, and the work deployed. Anything less stops at an earlier phase, which is
  // what makes an empty `proposed` the wrong fixture here.
  const base = {
    project: 42, briefMerged: true, briefPath: 'docs/projects/42.md',
    proposed: [{ title: 'a', order: 0 }],
    filed: [{ number: 1, title: 'a', state: 'CLOSED', labels: [] }],
    all: [{ number: 1, title: 'a', state: 'CLOSED', labels: [] }],
    open: [], blocked: [], unmilestoned: [],
    deploy: { state: 'deployed', tag: 'v1' },
    // Phase 5 sits between the deploy watch and the close, so a world that has not
    // been verified stops there rather than reaching the branch under test.
    qaIssue: { number: 9, state: 'CLOSED', rounds: 1, readable: true },
  };

  it('does not re-close a project a human reopened', () => {
    const w = { ...base, trackingClosed: false, trackingReopened: true };
    expect(phaseOf(w)).toBe('reopened');
    expect(nextActions(w).actions).toEqual([]);
  });

  it('says what it is refusing and how to proceed', () => {
    const r = nextActions({ ...base, trackingClosed: false, trackingReopened: true });
    expect(r.stopped).toMatch(/reopened/i);
    expect(r.stopped, 'a refusal nobody can clear is a deadlock').toMatch(/by hand|delete the brief/i);
  });

  it('still closes a project that was never closed', () => {
    expect(phaseOf({ ...base, trackingClosed: false, trackingReopened: false })).toBe('close');
  });

  it('still reports complete when it is closed', () => {
    expect(phaseOf({ ...base, trackingClosed: true, trackingReopened: false })).toBe('complete');
  });
});

describe('the parser says WHAT it discarded, not just how many (RA-1006)', () => {
  it('prints the discarded lines', () => {
    // The count alone reads `1` on the only real brief that exists AND on a brief
    // whose body sentence the parser ate — same number, nothing to tell them apart.
    const brief = ['## Decomposition', '', '### Issue A — a', '',
      '**Milestone:** Product Backlog', '  a wrapped continuation the parser drops', '', 'body.', ''].join('\n');
    const w = worldFrom(brief, []);
    const text = report(w, { phase: 'file', actions: [], stopped: null });
    expect(text).toMatch(/Lines the parser discarded/);
    expect(text).toContain('a wrapped continuation the parser drops');
  });

  it('says nothing when nothing was discarded', () => {
    const text = report(worldFrom(BRIEF(['a']), []), { phase: 'file', actions: [], stopped: null });
    expect(text).not.toMatch(/Lines the parser discarded/);
  });
});

describe('the harness cannot diverge from the join it mirrors (RA-1213 review)', () => {
  /**
   * `worldFrom` re-implements readWorld's brief↔issue join, so a defect in the real
   * one is invisible to every test built on the harness — which is exactly how `does
   * not adopt twice` stayed green over a deadlock. Mirroring is unavoidable (the
   * harness has no GitHub), so the mirror is pinned to the original instead.
   *
   * If this fails, the two joins have drifted: make them agree, and check whether the
   * tests that depend on the harness were proving the copy rather than the code.
   */
  it('readWorld joins by title OR by adoption, as the harness does', () => {
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    expect(src, 'the title half').toMatch(/proposed\.find\(\(p\) => p\.title === i\.title\)/);
    expect(src, 'the adoption half — without it an adopted item is never satisfied')
      .toMatch(/proposed\.find\(\(p\) => \(p\.closes \?\? \[\]\)\.includes\(i\.number\)\)/);
  });

  it('every reader of the brief↔issue join uses the same definition', () => {
    // There were THREE copies and the first fix caught two, so the third stranded the
    // project in `awaiting-release` forever instead of in `file` (RA-1213 review). A
    // shape that recurs three times in one file recurs a fourth, so the rule is one
    // definition — asserted by counting call sites rather than by matching the
    // expression, which is what made the previous version of this test go stale the
    // moment the duplication was removed.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    // COUNTING CALL SITES WAS NOT ENOUGH — `>= 3` was satisfied by three of FIVE, and
    // the `not.toMatch` pinned only the one expression the previous commit had left
    // behind, so a differently-spelled fifth copy in `retro` passed both (RA-1213
    // review). The property is that NO reader rebuilds the join by hand, so that is
    // what this asserts: no title-set over issues, and no title-to-title comparison,
    // anywhere in the file.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, 'a hand-built title set over issues is a copy of the join')
      .not.toMatch(/new Set\((?:world\.)?(?:all|filed)\.map\(\(i\) => i\.title\)\)/);
    expect(code, 'and so is comparing an issue title to a proposed one')
      .not.toMatch(/i\.title === p(?:r)?\.title/);
    // The three READERS — phaseOf, nothingLeftToFile, retro. The definition is
    // `itemSatisfied = (`, which this pattern does not match, so the count is the
    // call sites alone. (`nextActions` reaches it through `already`, which is
    // `satisfiedTitles`.)
    expect((src.match(/itemSatisfied\(/g) ?? []).length, 'every reader goes through the predicate')
      .toBeGreaterThanOrEqual(3);
  });

  it('satisfiedTitles accepts an adopted issue for the item that named it', () => {
    // The behaviour the three readers share, asserted once rather than inferred from
    // each caller.
    const set = satisfiedTitles([{ title: 'what its author wrote', briefTitle: 'what the brief proposed' }]);
    expect([...set].sort()).toEqual(['what its author wrote', 'what the brief proposed']);
  });

  it('reaches the deploy watch on a brief whose item adopted (RA-1213 review)', () => {
    // The third copy's own failure, end to end: `nothingLeftToFile` was false forever,
    // so `readDeploy` never ran and the project reported "no release contains their
    // merges yet" hourly with every issue closed and the work long since shipped.
    const brief = ['## Decomposition', '', '### Issue A — adopted work', '',
      '**Milestone:** Product Backlog · **Closes #897**', '', 'body.', ''].join('\n');
    const w = worldFrom(brief, [{ number: 897, title: 'what its author wrote', state: 'CLOSED' }]);
    expect(phaseOf(w), 'not stuck in `file`').not.toBe('file');
    // `worldFrom` does not compute `deploy`, so the assertion that matters here is
    // that the file phase is satisfied — which is what gates `readDeploy` in
    // `readWorld`, and is exactly what title-only comparison denied forever.
    const satisfied = satisfiedTitles(w.all as Array<{ title?: string; briefTitle?: string }>);
    expect(w.proposed.every((p: { title: string }) => satisfied.has(p.title))).toBe(true);
  });
});

describe('an item that names N issues needs all N (RA-1213 review)', () => {
  /**
   * `**Closes RA-897, RA-633 and RA-871**` — three numbers, one title. `briefTitle` is
   * stamped on each adopted issue, so a title-set said "satisfied" the moment the
   * FIRST landed: `phaseOf` left the file phase, the adoptions arm was never consulted
   * again, and RA-633 and RA-871 were never adopted, dispatched, verified or counted —
   * one tick after the tick promised "the rest next tick".
   *
   * Reachable two ways, and the second needs no budget at all: adoptions can exceed
   * the tick budget, and `execute` catches per action, so adopting one can succeed
   * while another fails. The second is worse, because `hold()` tells the human the
   * next tick "resumes from wherever the project actually is" — which for this action
   * kind had stopped being true.
   */
  const ITEM = { title: 'B', closes: [897, 633, 871] };

  it.each([
    [[], false],
    [[897], false],
    [[897, 633], false],
    [[897, 633, 871], true],
  ])('members %j -> satisfied: %s', (numbers, expected) => {
    expect(itemSatisfied(ITEM, (numbers as number[]).map((number) => ({ number, briefTitle: 'B' })))).toBe(expected);
  });

  it('still proposes the remaining adoptions after the first lands', () => {
    // The `already` gate held the item's title once ANY of its numbers was a member,
    // so the rest were never re-proposed. It was redundant with the per-number filter,
    // which is the check that actually makes this idempotent.
    const brief = ['## Decomposition', '', '### Issue B — three at once', '',
      '**Milestone:** Product Backlog · **Closes #897, #633 and #871**', '', 'body.', ''].join('\n');
    const w = worldFrom(brief, [{ number: 897, title: 'what its author wrote' }]);
    const nums = nextActions(w, { wip: 5 }).actions
      .filter((a: { kind: string }) => a.kind === 'adopt')
      .map((a: { number: number }) => a.number);
    expect(nums.sort((x: number, y: number) => x - y)).toEqual([633, 871]);
  });

  it('an item with no `closes` is still satisfied by its title', () => {
    expect(itemSatisfied({ title: 'A' }, [{ number: 1, title: 'A' }])).toBe(true);
    expect(itemSatisfied({ title: 'A' }, [{ number: 1, title: 'other' }])).toBe(false);
  });
});

describe('the retro does not tell a human to duplicate adopted work (RA-1213 review)', () => {
  /**
   * The fifth copy of the join, and the one that does the most damage: an adopted item
   * landed in `missing`, so the retro's table contradicted its own prose two lines
   * above and printed an instruction to create work that already exists — the RA-976
   * failure this PR is named after, in the artifact this file calls "the last thing
   * written before nobody looks again".
   */
  const brief = ['## Decomposition', '',
    '### Issue A — filed normally', '', '**Milestone:** Product Backlog', '', 'body.', '',
    '### Issue B — adopted', '', '**Milestone:** Product Backlog · **Closes #897**', '', 'body.', ''].join('\n');

  it('counts an adopted item as filed', () => {
    const w = worldFrom(brief, [
      { number: 1, title: 'filed normally', state: 'CLOSED' },
      { number: 897, title: 'what its author wrote', state: 'CLOSED' },
    ]);
    const text = retro(w, { kind: 'close-project', number: 42, tag: 'v1.2.3' });
    expect(text).not.toMatch(/proposed but never filed \| 1/);
    expect(text, 'and must not name the adopted item as missing').not.toContain('adopted');
  });

  it('still reports a genuinely missing item', () => {
    const w = worldFrom(brief, [{ number: 1, title: 'filed normally', state: 'CLOSED' }]);
    const text = retro(w, { kind: 'close-project', number: 42, tag: 'v1.2.3' });
    expect(text).toContain('adopted');
  });

  it('does not claim verification when the Explorer never ran (RA-1095)', () => {
    // `phaseOf` reaches phase 6 the moment the QA issue is not OPEN and checks nothing
    // about whether the Explorer ran, so a HAND-CLOSED QA issue produced a retro asserting
    // that phase 5 verified the criteria. RA-1091 is how a human gets there: closing the
    // QA issue by hand is the obvious unstick for a permanent `awaiting-qa` stall.
    const w = worldFrom(brief, [
      { number: 1, title: 'filed normally', state: 'CLOSED' },
      { number: 897, title: 'what its author wrote', state: 'CLOSED' },
    ]);
    const text = retro(
      { ...w, qaIssue: { number: 2000, state: 'CLOSED', rounds: 0 } },
      { kind: 'close-project', number: 42, tag: 'v1.2.3' },
    );
    expect(text, 'must say plainly that nothing verified these criteria')
      .toMatch(/No verification round ran/);
    expect(text, 'and must NOT assert the criteria were verified')
      .not.toMatch(/acceptance criteria were verified/);
  });

  it('does not call an UNREADABLE comment thread an absence (RA-1240)', () => {
    // `readQaRounds` returns `{ rounds: 0, readable: false }` on ANY `gh` failure, and
    // `readable` is consulted only inside the `state === 'OPEN'` branch — but the close
    // path runs with the QA issue CLOSED, so `rounds: 0` was read at face value and the
    // retro asserted nobody verified anything. RA-1095 inverted: a positive claim of
    // absence from a source that could not be read. The close happens once, so a single
    // transient blip wrote it permanently.
    const w = worldFrom(brief, [
      { number: 1, title: 'filed normally', state: 'CLOSED' },
      { number: 897, title: 'what its author wrote', state: 'CLOSED' },
    ]);
    const text = retro(
      { ...w, qaIssue: { number: 2000, state: 'CLOSED', rounds: 0, readable: false } },
      { kind: 'close-project', number: 42, tag: 'v1.2.3' },
    );
    expect(text, 'unknown is not the same as never').toMatch(/UNKNOWN/);
    expect(text, 'and must not assert that no round ran').not.toMatch(/No verification round ran/);
    expect(text, 'nor that the criteria were verified').not.toMatch(/acceptance criteria were verified/);
  });

  it('still states the caveat when the Explorer did run', () => {
    // Not vacuous in the other direction — `rounds >= 1` keeps the existing claim.
    const w = worldFrom(brief, [
      { number: 1, title: 'filed normally', state: 'CLOSED' },
      { number: 897, title: 'what its author wrote', state: 'CLOSED' },
    ]);
    const text = retro(
      { ...w, qaIssue: { number: 2000, state: 'CLOSED', rounds: 1 } },
      { kind: 'close-project', number: 42, tag: 'v1.2.3' },
    );
    expect(text).toMatch(/acceptance criteria were verified/);
    expect(text).not.toMatch(/No verification round ran/);
  });

  it('counts only the issues the brief named — not the tracking or QA issue (RA-1219)', () => {
    // `world.all` is every MARKER-CARRYING issue, which always includes two the brief
    // never proposed: the tracking issue and the QA issue. The retro renders only on
    // `close-project`, downstream of phase 5, so both are always there — a fixed +2
    // on every project. The old row read `world.all.length` and printed
    // "proposed 2, filed 5, never filed 0" for a project that filed 3.
    const w = worldFrom(brief, [
      { number: 1, title: 'filed normally', state: 'CLOSED' },
      { number: 897, title: 'what its author wrote', state: 'CLOSED' },
      { number: 42, title: 'Project: something', state: 'CLOSED' },              // tracking
      { number: 43, title: 'QA: verify something', state: 'CLOSED', labels: ['qa:verify'] },
    ]);
    const text = retro(w, { kind: 'close-project', number: 42, tag: 'v1.2.3' });

    expect(text, 'the brief named two issues, not four').toContain('| filed | 2 issue(s) |');
    expect(text, 'and the prose must agree with the table').toContain('which named **2** issue(s)');
    expect(text, 'items and issues are different units and must say so')
      .toContain('| proposed by the brief | 2 item(s) |');
    // Not vacuous in the other direction: nothing is reported missing here.
    expect(text).toContain('| proposed but never filed | 0 |');
  });
});

describe('phase 5 reaches the Explorer by label, not by dispatch (RA-1281)', () => {
  const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
  // The lane is Kanon's since RA-2718; its caller holds the `issues: labeled` trigger.
  // The adopter's caller (its triggers), then the lane (its gates), as one text.
  const wf = readFileSync(join(ROOT, 'tests/fixtures/lane-check/extra/agent-verify-acs.yml'), 'utf8')
    + readFileSync(join(ROOT, '.github/workflows/agent-verify-acs.yml'), 'utf8');

  it('does not dispatch the verify workflow', () => {
    // `gh workflow run` needs `actions: write`, and agent-identities.md footnote 2
    // gives the Lead `Actions: No access` deliberately — "label churn achieves the same
    // with strictly less authority". That reasoning had a hole here: the Explorer was
    // `workflow_dispatch`-only, so there was no label to churn, the dispatch 403'd,
    // and the pilot project held. This pins the lower-authority route so a later edit
    // cannot quietly re-introduce the requirement.
    // Scoped to what the tick EXECUTES. The QA issue body still tells a human how to
    // dispatch it by hand — `workflow_dispatch` is retained precisely for that — so
    // asserting the filename is absent would forbid the documentation, not the call.
    expect(src, 'phase 5 must not need actions: write')
      .not.toMatch(/gh\(\[\s*['"]workflow['"]\s*,\s*['"]run['"]/);
  });

  it('churns the marker label remove-then-add', () => {
    // Adding a label the issue already carries is a no-op that fires nothing, so the
    // REMOVE is what makes the re-add an event. Order is the whole mechanism.
    const verify = src.slice(src.indexOf("a.kind === 'verify'"));
    const body = verify.slice(0, verify.indexOf("a.kind === 'close-project'"));
    expect(body.indexOf('--remove-label'), 'remove must precede add')
      .toBeLessThan(body.indexOf('--add-label'));
  });

  it('the workflow accepts that trigger, and only for the marker label', () => {
    // A label event fires on EVERY label; without the guard the Explorer would start for the
    // other dozen, each run costing an agent invocation.
    expect(wf).toMatch(/issues:\s*\n\s*types:\s*\[labeled\]/);
    expect(wf).toContain("github.event.label.name == 'qa:verify'");
    // ...and it must still be dispatchable by hand, which is how a human re-runs it.
    expect(wf).toContain('workflow_dispatch');
    expect(wf).toMatch(/github\.event_name == 'workflow_dispatch'/);
  });

  it('the workflow can recover both dispatch inputs from the QA issue body', () => {
    // The check agent-identities.md's own discipline demands before preferring the
    // lower-authority route: it must be able to express everything the higher one did.
    // The QA issue `file-qa` writes states both, so these two regexes are load-bearing.
    const filed = ['Verify project #961 on staging, per acceptance criterion.',
      'The work is deployed in `v0.48.9`. This issue is where that is CHECKED.'].join('\n');
    expect(filed.match(/[Vv]erify project #(\d+)/)?.[1]).toBe('961');
    expect(filed.match(/deployed in `([^`]*)`/)?.[1]).toBe('v0.48.9');
    // and the workflow greps for exactly those shapes
    expect(wf).toContain('[Vv]erify project #');
    expect(wf).toContain('deployed in `');
  });
});

describe('brief metadata is read from the metadata line, and nothing is dropped in silence (RA-1300/RA-1303/RA-1310)', () => {
  const chunk = (body: string[]) => ['# Brief', '', '## 3. Decomposition', '', ...body, '', '## 4. Next', ''].join('\n');

  describe('a parenthetical must not truncate the dependency list', () => {
    // FAILS OPEN, which is the dangerous direction: `nextActions` filters out an issue
    // with an open dependency, so a dropped one makes an issue look ready and
    // dispatches an implementer at work whose prerequisite has not landed.
    it('keeps both references when a reason sits between them', () => {
      const p = parseProposed(chunk([
        '### Issue A — First', '', '**Milestone:** Product Backlog', '',
        '### Issue B — Second', '', '**Milestone:** Product Backlog', '',
        '### Issue C — Third', '', '**Milestone:** Product Backlog', '',
        '**Depends on:** Issue A (the schema change) and Issue B (the counter)',
      ]));
      expect(p.find((x: { key: string }) => x.key === 'C')!.dependsOnKeys).toEqual(['A', 'B']);
    });

    it('still creates no dependency from an incidental reference in prose', () => {
      // The leading-run anchor is why the restriction exists — an incidental "Issue F"
      // in a rationale became a permanent dependency on nothing. Stripping
      // parentheticals must not weaken that, so it is asserted, not assumed.
      const p = parseProposed(chunk([
        '### Issue A — First', '', '**Milestone:** Product Backlog', '',
        '### Issue C — Third', '', '**Milestone:** Product Backlog', '',
        '**Depends on:** Issue A — see the note about Issue F below',
      ]));
      expect(p.find((x: { key: string }) => x.key === 'C')!.dependsOnKeys).toEqual(['A']);
    });

    it('and the form that already worked still works', () => {
      const p = parseProposed(chunk([
        '### Issue A — First', '', '**Milestone:** Product Backlog', '',
        '### Issue B — Second', '', '**Milestone:** Product Backlog', '',
        '### Issue C — Third', '', '**Milestone:** Product Backlog', '',
        '**Depends on:** Issue A, Issue B (both needed)',
      ]));
      expect(p.find((x: { key: string }) => x.key === 'C')!.dependsOnKeys).toEqual(['A', 'B']);
    });
  });

  describe('a Closes adoption comes from the metadata line only', () => {
    it('does not let bold body prose beat the metadata line', () => {
      // The measured case: brief RA-1291's Issue B opened `**Closes RA-720's successor
      // question**`, and `exec` returns the FIRST match anywhere, so RA-720 — an
      // unrelated issue — was adopted over the real marker.
      const p = parseProposed(chunk([
        '### Issue B — Second', '',
        "**Closes #720's successor question** is what this really answers.", '',
        '**Milestone:** Production Ready · **Closes #999**',
      ]));
      expect(p[0].closes, 'the metadata line is the authority').toEqual([999]);
      expect(p[0].droppedCloses, 'and the prose reference is reported, not obeyed').toEqual([720]);
    });

    it('reads the real mid-line form every brief on disk uses', () => {
      // NOT `^\\*\\*Closes`. The form is `**Milestone:** … · **Labels:** … · **Closes
      // RA-603**`, so a column-zero anchor would have matched none of the four briefs.
      const p = parseProposed(chunk([
        '### Issue B — Second', '',
        '**Milestone:** Production Ready · **Labels:** `sev:critical` · **Closes #897; supersedes the caller-side guards in PR #869**',
      ]));
      expect(p[0].closes, 'the leading run only — #869 is a PR in the rationale').toEqual([897]);
      expect(p[0].droppedCloses).toEqual([]);
    });
  });

  describe('a closing reference the parser cannot read is reported, never ignored', () => {
    it('reports a plain-prose Closes that the metadata line does not carry', () => {
      // With `closes` empty the tick takes the FILE branch and files a DUPLICATE — and
      // the original can then never be closed, because the file phase dedups by title
      // and never re-files. Irreversible, which is why this reports rather than guesses.
      const p = parseProposed(chunk([
        '### Issue B — Second', '', '**Milestone:** Production Ready', '', 'Closes #1178.',
      ]));
      expect(p[0].closes).toEqual([]);
      expect(p[0].droppedCloses).toEqual([1178]);
    });

    it('does not flag a deliberate non-close, or a passing mention mid-sentence', () => {
      // `docs/projects/1291.md`'s `**This adopts RA-326's gap 4 ONLY and does NOT close
      // RA-326**` line writes it on purpose (cited by CONTENT, not by line: RA-1291 is an
      // open project, so its line numbers move and a `:727` re-arms the drift — RA-1362). A
      // bare /close\s+#\d+/ would stop that project on every tick, forever — the false
      // escalation RA-1303 named as the thing to check before adopting a detector.
      const p = parseProposed(chunk([
        '### Issue B — Second', '', '**Milestone:** Production Ready', '',
        "**This adopts #326's gap 4 ONLY and does NOT close #326** — deliberately no marker.", '',
        'This closes the gap that #159 describes, but #159 stays open when this project closes.',
      ]));
      expect(p[0].droppedCloses).toEqual([]);
    });

    it('does not flag the number the metadata line already adopted', () => {
      // A brief that restates its own adoption in prose is not an error.
      const p = parseProposed(chunk([
        '### Issue B — Second', '', '**Milestone:** Production Ready · **Closes #1178**', '',
        'Closes #1178 once the migration lands.',
      ]));
      expect(p[0].closes).toEqual([1178]);
      expect(p[0].droppedCloses).toEqual([]);
    });

    it('stops the tick rather than filing a duplicate', () => {
      // Blocking, like a dropped LABEL and unlike a dropped LINE: the blast radius is
      // the gate. The three references RA-1303 measured are all on `Production Ready`,
      // so the failure is duplicates on the gate beside originals nothing can close.
      const brief = chunk([
        '### Issue B — Second', '',
        '**Milestone:** Production Ready · **Labels:** `sev:high`', '', 'Closes #1178.',
      ]);
      const out = nextActions(worldFrom(brief));
      expect(out.actions, 'nothing may be filed while a marker is unread').toEqual([]);
      expect(out.stopped).toMatch(/closing reference the parser does not read/);
      expect(out.stopped, 'and it must name which one').toContain('#1178');
    });

    it('files normally once the marker is on the metadata line', () => {
      // Non-vacuity: the stop above must be caused by the stray marker, not by
      // something else in the fixture refusing to file.
      const brief = chunk([
        '### Issue B — Second', '',
        '**Milestone:** Production Ready · **Labels:** `sev:high` · **Closes #1178**', '',
        'It does a thing.',
      ]);
      const out = nextActions(worldFrom(brief));
      expect(out.stopped).toBeUndefined();
      expect(out.actions.length).toBeGreaterThan(0);
    });
  });

});

describe('phase 4: only POSITIVE evidence ends the candidate walk (RA-1271/RA-1268)', () => {
  // RA-1258 continued past `gate-declined` alone. That fixed one permanent park by
  // converting it into two rarer ones of the same shape — a NEGATIVE reading of one
  // candidate ending a search that still had candidates left. Both sequences here put
  // the project's commits on staging and then parked forever, because neither state
  // recovers with time: the run window only ages further away, and the earliest
  // containing release never changes.

  /** Builds the `io` seam for a release sequence, oldest LAST (as the API returns it). */
  const deployWorld = (tags: Array<{ tag: string; deploy: 'success' | 'skipped' | 'failure' | 'missing' | 'running' | 'nojob' | 'unreadable' }>) => {
    const ids = new Map(tags.map((t, i) => [t.tag, i + 1]));
    return {
      json: (args: string[]) => {
        if (args[0] === 'issue') return { closedByPullRequestsReferences: [{ number: 9 }] };
        if (args[0] === 'pr') return { state: 'MERGED', mergeCommit: { oid: 'sha1' } };
        if (args[0] === 'api') return tags.map((t) => ({ tag: t.tag }));
        if (args[0] === 'run' && args[1] === 'list') {
          return tags.filter((t) => t.deploy !== 'missing').map((t) => ({
            displayTitle: t.tag,
            status: t.deploy === 'running' ? 'in_progress' : 'completed',
            conclusion: t.deploy === 'running' ? null : (t.deploy === 'failure' ? 'failure' : 'success'),
            databaseId: ids.get(t.tag),
            url: `u-${t.tag}`,
          }));
        }
        if (args[0] === 'run' && args[1] === 'view') {
          const tag = [...ids].find(([, id]) => String(id) === args[2])?.[0];
          const d = tags.find((t) => t.tag === tag)!.deploy;
          // RA-1369's two causes, which the shipped code must tell apart:
          //   `unreadable` — the call throws (or returns no `jobs`): TRANSIENT.
          //   `nojob`      — jobs come back and none is the deploy job: PERMANENT,
          //                  which is what a rename of `deploy` produces for every
          //                  release cut under the old name.
          if (d === 'unreadable') throw new Error('gh: 502');
          if (d === 'nojob') return { jobs: [{ name: 'gate', conclusion: 'success' }] };
          return { jobs: [{ name: 'deploy', conclusion: d === 'skipped' ? 'skipped' : 'success' }] };
        }
        throw new Error(`unrouted: ${args.join(' ')}`);
      },
      // Every tag contains the merge — the walk's containment check is not what is
      // under test here, and `readDeploy` re-checks it by ancestry per candidate.
      text: () => 'behind',
    };
  };
  const CLOSED = [{ number: 1, state: 'CLOSED' }];
  /** A world at phase 4: every proposed issue closed, so `nextActions` reaches the
   *  deploy outcomes. Mirrors the helper the phase-4/6 block uses. */
  const atPhase4 = (deploy: Record<string, unknown>) => ({
    ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
    project: '961',
    deploy,
  });
  // Newest first, as `releases?per_page=30` returns them; the walk reverses it.
  const seq = (...t: Array<{ tag: string; deploy: 'success' | 'skipped' | 'failure' | 'missing' | 'running' | 'nojob' | 'unreadable' }>) => [...t].reverse();

  it('RA-1268 — walks past a run that aged out of the 30-run window, to a later success', () => {
    // vA declined · vB's run fell out of the window · vC deployed. `deploy-staging.yml`
    // checks out the tag and runs a whole-tree `sst deploy`, so vC's success really is
    // evidence for this project's commits.
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'missing' },
      { tag: 'v1.0.2', deploy: 'success' },
    )));
    expect(d.state).toBe('deployed');
    expect(d.tag, 'and it names the release that actually deployed').toBe('v1.0.2');
  });

  it('RA-1271 — walks past an unrelated later failure, to a success after it', () => {
    // vA declined · vB failed · vC deployed. At candidate two or later the failing
    // release is whatever release happened to fail next; the project was being parked
    // on someone else's failure.
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'failure' },
      { tag: 'v1.0.2', deploy: 'success' },
    )));
    expect(d.state).toBe('deployed');
    expect(d.tag).toBe('v1.0.2');
  });

  it("names the project's OWN failed release even when a later one deployed", () => {
    // REWRITTEN WITH RA-1364's OWN REASONING CORRECTED (RA-1372). I wrote this case to
    // lock "terminate on the first containing failure", on the RA-1056 argument. The
    // argument was right about what must not be LOST and wrong about what must be
    // RETURNED: discarding the failure and parking are not the only two options.
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'failure' },
      { tag: 'v1.0.1', deploy: 'success' },
    )));
    expect(d.state).toBe('deployed');
    expect(d.tag).toBe('v1.0.1');
    expect(d.failedAt).toBe('v1.0.0');
  });

  it('never carries a failure onto itself', () => {
    // RA-1440 review. When the reported state IS the own failure, `remembered.get('failed')`
    // and `ownFailure` are the same object, so an ungated spread gives `failedAt === tag`
    // — a sentence reading "release vA failed; the work reached staging only via the
    // later deploy of vA". Unreachable through any artifact today, because
    // `deploy-failed` never gets to a caveat renderer, so it is asserted on the VERDICT
    // where it is actually decidable rather than left to be caught if that ever changes.
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'failure' },
      { tag: 'v1.0.1', deploy: 'skipped' },
    )));
    expect(d.state).toBe('failed');
    expect(d.failedAt, 'the verdict IS the failure — it must not also carry it').toBeUndefined();
  });

  it('reports the failure alone when nothing later deployed', () => {
    // NON-VACUITY for the row above: if no candidate deploys, the verdict is still
    // `failed` and still parks — carrying the failure forward must not have turned
    // every failure into a pass.
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'failure' },
      { tag: 'v1.0.1', deploy: 'skipped' },
    )));
    expect(d.state).toBe('failed');
    expect(d.tag).toBe('v1.0.0');
  });

  it('does not invent a failedAt when the project\'s own release was fine', () => {
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'success' },
    )));
    expect(d.state).toBe('deployed');
    expect(d.failedAt).toBeUndefined();
  });

  it('absent evidence still never reads as deployed', () => {
    // The property RA-1056 exists for, and the one thing continuing must never buy: only
    // a candidate whose own deploy job concluded success may return `deployed`.
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'missing' },
      { tag: 'v1.0.2', deploy: 'missing' },
    )));
    expect(d.state).toBe('run-not-found');
  });

  describe('when no candidate ever deploys, it reports the most actionable negative', () => {
    it('prefers a failure over a declined gate', () => {
      // A `failed` names a run a human can re-run; `gate-declined` is evidence of
      // nothing. RA-1271 names this preference explicitly.
      const d = readDeploy(CLOSED, deployWorld(seq(
        { tag: 'v1.0.0', deploy: 'skipped' },
        { tag: 'v1.0.1', deploy: 'failure' },
      )));
      expect(d.state).toBe('failed');
      expect(d.tag, 'and names the tag that actually failed').toBe('v1.0.1');
    });

    it('prefers an aged-out run over a declined gate', () => {
      const d = readDeploy(CLOSED, deployWorld(seq(
        { tag: 'v1.0.0', deploy: 'skipped' },
        { tag: 'v1.0.1', deploy: 'missing' },
      )));
      expect(d.state).toBe('run-not-found');
    });

    it('still reports a declined gate when that is all there is', () => {
      // RA-1258's own case must be unchanged, and it must name the FIRST declined tag so
      // the message stays honest about which release was examined.
      const d = readDeploy(CLOSED, deployWorld(seq(
        { tag: 'v1.0.0', deploy: 'skipped' },
        { tag: 'v1.0.1', deploy: 'skipped' },
      )));
      expect(d.state).toBe('gate-declined');
      expect(d.tag).toBe('v1.0.0');
    });
  });

  it('waits on an in-flight deploy rather than walking past it', () => {
    // `deploying` is deliberately NOT in the continue set. It is transient — the next
    // tick reads a completed run — so it can never park a project, and waiting on a
    // containing release's running deploy is the right answer rather than reaching for
    // a later one.
    const d = readDeploy(CLOSED, deployWorld(seq(
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'running' },
      { tag: 'v1.0.2', deploy: 'success' },
    )));
    expect(d.state).toBe('deploying');
    expect(d.tag).toBe('v1.0.1');
  });

  describe('the verdict says what it EXAMINED, not only what it found', () => {
    // Now that the walk covers every containing release, a message naming one tag reads
    // as though one tag was checked — which is exactly what the old behaviour did. This
    // is what lets a human tell "we looked at the one release" from "we looked at all
    // of them and none deployed", and stops them re-checking later releases by hand.
    it('counts the containing releases it classified', () => {
      const d = readDeploy(CLOSED, deployWorld(seq(
        { tag: 'v1.0.0', deploy: 'skipped' },
        { tag: 'v1.0.1', deploy: 'skipped' },
        { tag: 'v1.0.2', deploy: 'skipped' },
      )));
      expect(d.state).toBe('gate-declined');
      expect(d.examined).toBe(3);
    });

    it('surfaces the count in the stopped message, and stays silent at one', () => {
      expect(nextActions(atPhase4({ state: 'gate-declined', tag: 'v1.0.0', examined: 3 })).stopped)
        .toContain('3 containing releases examined; none deployed');
      expect(nextActions(atPhase4({ state: 'run-not-found', tag: 'v1.0.0', examined: 4 })).stopped)
        .toContain('4 containing releases examined; none deployed');
      expect(nextActions(atPhase4({ state: 'failed', tag: 'v1.0.0', examined: 2 })).stopped)
        .toContain('2 containing releases examined; none deployed');

      expect(nextActions(atPhase4({ state: 'gate-declined', tag: 'v1.0.0', examined: 1 })).stopped,
        'one release is the common case — the tag already says which')
        .not.toContain('containing releases examined');
    });
  });

  it('the tag it reports is always one the walk classified', () => {
    // `verificationCaveat` and the retro line both print this tag, so a verdict naming
    // a release the walk never examined would be a false statement about what was built.
    for (const s of [
      seq({ tag: 'v2.0.0', deploy: 'skipped' }, { tag: 'v2.0.1', deploy: 'failure' }, { tag: 'v2.0.2', deploy: 'success' }),
      seq({ tag: 'v2.0.0', deploy: 'skipped' }, { tag: 'v2.0.1', deploy: 'missing' }),
      seq({ tag: 'v2.0.0', deploy: 'skipped' }, { tag: 'v2.0.1', deploy: 'skipped' }),
    ]) {
      const d = readDeploy(CLOSED, deployWorld(s));
      expect(s.map((t) => t.tag), `${d.state} named ${d.tag}`).toContain(d.tag);
    }
  });
});

describe('a carried failure reaches every artifact that closes the project (RA-1372)', () => {
  // The whole justification for continuing past a first-candidate failure is that the
  // failure travels WITH the verdict rather than being discarded. If a close could
  // omit it, this would be the RA-1056 mistake — "report a later green as though the
  // failure had not happened" — arriving through the artifact instead of through the
  // classifier. One renderer, for `verificationCaveat`'s reason (RA-1087): this sentence
  // is exactly the shape that drifted across four artifacts before it had one.
  const deployed = { state: 'deployed', tag: 'v1.0.1', url: 'u2' };
  const carried = { ...deployed, failedAt: 'v1.0.0', failedUrl: 'u1' };

  it('says nothing when the project\'s own release was fine', () => {
    expect(ownFailureCaveat(deployed)).toBe('');
    expect(ownFailureCaveat(undefined)).toBe('');
  });

  it('names the failed release, its run, and the tag that actually shipped', () => {
    const out = ownFailureCaveat(carried);
    expect(out).toContain('v1.0.0');
    expect(out).toContain('u1');
    expect(out, 'the reader must know which tag DID deploy').toContain('v1.0.1');
    expect(out).toMatch(/unexamined/);
  });

  it('reaches the tracking issue\'s close comment — through the ACTION production builds', () => {
    // THE SHAPE MATTERS, NOT THE SIGNATURE (RA-1440 review). My first version passed the
    // deploy VERDICT here. Production passes the close-project ACTION, which had no
    // `failedAt` — so the caveat rendered empty in production while three tests passed.
    // Same class as the mistake this PR's own body describes one level down: the
    // classifier's split is not the shipped behaviour, and neither is a renderer's
    // signature — the caller's argument is.
    // Mirrors the phase-4/6 block's `allClosed`: every proposed issue closed, a passing
    // QA issue, tracking not yet closed — which is what puts `phaseOf` on `close`.
    const w = {
      ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
      project: '961',
      deploy: { state: 'deployed', tag: 'v1.0.1', url: 'u2', failedAt: 'v1.0.0', failedUrl: 'u1' },
      qaIssue: { number: 2000, state: 'CLOSED', rounds: 1, lastVerifiedAt: '2026-08-26T20:00:00Z' },
      trackingClosed: false,
    };
    const [action] = nextActions(w).actions;
    expect(action.kind, 'this must be the close path').toBe('close-project');
    expect(action.failedAt, 'the action is what carries it to the renderer').toBe('v1.0.0');

    const close = renderCloseComment(action);
    expect(close).toContain('v1.0.0');
    expect(close).toContain('u1');
    expect(close, 'and the tag that actually shipped').toContain('v1.0.1');
  });

  it('reaches retro() — the comment posted to the tracking issue, not the step summary', () => {
    // My first version called `report()` and was titled "the retro". `report()` is the
    // STEP SUMMARY — ephemeral, gone when the run ages out. `retro()` is the durable
    // artifact posted alongside the close comment, and it never called the renderer.
    //
    // Executed rather than inspected, for the reason the earlier version got right:
    // `ownFailureCaveat` is declared below its callers, so a temporal-dead-zone const
    // would throw only when the line runs — the RA-1240 shape.
    const out = retro(world({ proposed: [], all: [], briefPath: 'docs/projects/961.md' }),
      { kind: 'close-project', number: 961, tag: 'v1.0.1', failedAt: 'v1.0.0', failedUrl: 'u1' });
    expect(out).toContain('v1.0.0');
    expect(out).toContain('unexamined');
  });

  it('says nothing extra on an ordinary close, in every artifact', () => {
    // NON-VACUITY across all three surfaces at once: the caveat must appear only when
    // a failure was actually carried.
    const clean = { kind: 'close-project', number: 961, tag: 'v1.0.1' };
    expect(renderCloseComment(clean)).not.toMatch(/FAILED/);
    expect(retro(world({ proposed: [], all: [] }), clean)).not.toMatch(/FAILED/);
  });

  it('the step summary says it too', () => {
    const w = {
      ...world({ proposed: [], all: [], filed: [], open: [], blocked: [], unmilestoned: [] }),
      deploy: { state: 'deployed', tag: 'v1.0.1', url: 'u2', failedAt: 'v1.0.0', failedUrl: 'u1' },
      qaIssue: { rounds: 1, readable: true },
      trackingClosed: true,
    };
    expect(report(w, { phase: 'complete', actions: [], stopped: undefined })).toContain('v1.0.0');
  });
});

describe('a run whose jobs have no deploy job is permanent, not unreadable (RA-1369)', () => {
  // THROUGH `readDeploy`, NOT `classifyDeploy`. The classifier's split is asserted
  // elsewhere; what matters here is that the PRODUCER emits the tri-state and that the
  // WALK acts on it. Testing only the classifier proves a copy of the rule — reverting
  // either `?? null` or the CONTINUE_PAST entry left the classifier tests green.
  const world = (tags: Array<{ tag: string; deploy: string }>) => {
    const ids = new Map(tags.map((t, i) => [t.tag, i + 1]));
    return {
      json: (args: string[]) => {
        if (args[0] === 'issue') return { closedByPullRequestsReferences: [{ number: 9 }] };
        if (args[0] === 'pr') return { state: 'MERGED', mergeCommit: { oid: 'sha1' } };
        if (args[0] === 'api') return [...tags].reverse().map((t) => ({ tag: t.tag }));
        if (args[0] === 'run' && args[1] === 'list') {
          return tags.map((t) => ({
            displayTitle: t.tag, status: 'completed', conclusion: 'success',
            databaseId: ids.get(t.tag), url: `u-${t.tag}`,
          }));
        }
        if (args[0] === 'run' && args[1] === 'view') {
          const tag = [...ids].find(([, id]) => String(id) === args[2])?.[0];
          const d = tags.find((t) => t.tag === tag)!.deploy;
          if (d === 'unreadable') throw new Error('gh: 502');
          // `.jobs` ABSENT is the issue's cause 2 — the answer came back and is
          // unusable, which is transient like a throw and unlike `nojob`.
          if (d === 'nojobs-key') return {};
          if (d === 'nojob') return { jobs: [{ name: 'gate', conclusion: 'success' }] };
          return { jobs: [{ name: 'deploy', conclusion: d === 'skipped' ? 'skipped' : 'success' }] };
        }
        throw new Error(`unrouted: ${args.join(' ')}`);
      },
      text: () => 'behind',
    };
  };
  const CLOSED = [{ number: 1, state: 'CLOSED' }];
  /** A world at phase 4, so `nextActions` reaches the deploy outcomes. */
  const at4 = (deploy: Record<string, unknown>) => ({
    ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
    project: '961',
    deploy,
  });

  it('the producer emits the two causes distinctly', () => {
    expect(readDeploy(CLOSED, world([{ tag: 'v1.0.0', deploy: 'nojob' }])).state)
      .toBe('deploy-job-absent');
    expect(readDeploy(CLOSED, world([{ tag: 'v1.0.0', deploy: 'unreadable' }])).state)
      .toBe('run-unreadable');
    // All THREE producer paths, because the issue enumerates three and only one of
    // them is permanent. A missing `jobs` key is an unusable answer, not an answer
    // saying there is no deploy job — collapsing it would make a transient API shape
    // park the project forever.
    expect(readDeploy(CLOSED, world([{ tag: 'v1.0.0', deploy: 'nojobs-key' }])).state)
      .toBe('run-unreadable');
  });

  it('an absent jobs key does not continue the walk either', () => {
    const d = readDeploy(CLOSED, world([
      { tag: 'v1.0.0', deploy: 'nojobs-key' },
      { tag: 'v1.0.1', deploy: 'success' },
    ]));
    expect(d.state, 'transient: the next tick re-reads it').toBe('run-unreadable');
  });

  it('the walk continues past an absent deploy job, to a later real deploy', () => {
    // The reachable case: `deploy-staging.yml`'s job names come from the workflow as it
    // was at that tag, and the walk deliberately reads OLDER releases — so a rename of
    // `deploy` makes every release cut under the old name classify this way, forever.
    const d = readDeploy(CLOSED, world([
      { tag: 'v1.0.0', deploy: 'nojob' },
      { tag: 'v1.0.1', deploy: 'success' },
    ]));
    expect(d.state).toBe('deployed');
    expect(d.tag).toBe('v1.0.1');
  });

  it('but still refuses when nothing later deployed', () => {
    // Absent evidence never reads as a deploy — RA-1056's property, and the one thing
    // continuing must not buy.
    const d = readDeploy(CLOSED, world([
      { tag: 'v1.0.0', deploy: 'nojob' },
      { tag: 'v1.0.1', deploy: 'nojob' },
    ]));
    expect(d.state).toBe('deploy-job-absent');
  });

  it('does NOT continue past a genuinely unreadable run', () => {
    // NON-VACUITY on the split: an API failure is transient, so parking one tick is
    // correct and the walk must still stop there.
    const d = readDeploy(CLOSED, world([
      { tag: 'v1.0.0', deploy: 'unreadable' },
      { tag: 'v1.0.1', deploy: 'success' },
    ]));
    expect(d.state).toBe('run-unreadable');
    expect(d.tag).toBe('v1.0.0');
  });

  it('prefers it over run-not-found when reporting, being strictly more informative', () => {
    const d = readDeploy(CLOSED, world([
      { tag: 'v1.0.0', deploy: 'skipped' },
      { tag: 'v1.0.1', deploy: 'nojob' },
    ]));
    expect(d.state).toBe('deploy-job-absent');
  });

  it('tells a human it will not clear on its own', () => {
    const r = nextActions(at4({ state: 'deploy-job-absent', tag: 'v1.0.0', url: 'u1' }));
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/does NOT resolve itself/);
    expect(r.stopped, 'and why — a completed run\'s jobs never change').toMatch(/never change/);
  });
});

describe('markdown punctuation does not hide a stray Closes (RA-1330)', () => {
  const chunk = (body: string[]) => ['# Brief', '', '## 3. Decomposition', '', ...body, '', '## 4. Next', ''].join('\n');
  const item = (prose: string) => parseProposed(chunk([
    '### Issue B — Second', '', '**Milestone:** Production Ready', '', prose,
  ]))[0];

  // `^` under /m anchors at column zero, so the form authors most often write — a list
  // item — was neither adopted NOR reported, falling back into RA-1303's silent
  // duplicate. A numbered `1. ` matched only incidentally via the sentence lookbehind,
  // so two list markers behaved differently on identical content.
  it.each([
    ['a plain sentence', 'Closes #1178.'],
    ['an ordered-list marker', '1. Closes #1178'],
    ['a bold span', '**Closes #1178**'],
    ['a dash bullet', '- Closes #1178'],
    ['a star bullet', '* Closes #1178 — the original'],
    ['a plus bullet', '+ Closing #1178'],
    ['a blockquote', '> Closes #1178'],
    ['a nested blockquote bullet', '> - Closes #1178'],
    ['bare indentation', '  Closes #1178'],
    ['two spaces after a full stop', 'Done.  Closes #1178'],
  ])('reports one behind %s', (_label, prose) => {
    expect(item(prose).droppedCloses).toEqual([1178]);
  });

  it.each([
    ['a deliberate non-close', "**This adopts #326's gap 4 ONLY and does NOT close #326** — deliberately no marker."],
    ['a passing mention mid-sentence', 'This closes the gap that #159 describes, but #159 stays open when this project closes.'],
    ['a mid-sentence gerund', 'See also the note about closing #99 elsewhere in this brief.'],
  ])('stays silent on %s', (_label, prose) => {
    // The widening must not become an escalation machine: a stray report STOPS the
    // tick, so a false one parks a live project until a human edits the brief.
    expect(item(prose).droppedCloses).toEqual([]);
  });

  it('still does not report the marker the metadata line legitimately carries', () => {
    const p = parseProposed(chunk([
      '### Issue B — Second', '',
      '**Milestone:** Production Ready · **Labels:** `sev:high` · **Closes #1178**',
    ]))[0];
    expect(p.closes).toEqual([1178]);
    expect(p.droppedCloses, 'the metadata line is removed before the prose scan').toEqual([]);
  });
});

describe('a dependency the run did not take is reported, not guessed (RA-1331)', () => {
  const chunk = (dep: string) => ['# Brief', '', '## 3. Decomposition', '',
    '### Issue A — a', '', '**Milestone:** X', '',
    '### Issue B — b', '', '**Milestone:** X', '',
    '### Issue C — c', '', '**Milestone:** X', '', `**Depends on:** ${dep}`,
    '', '## 4. Next', ''].join('\n');
  const c = (dep: string) => parseProposed(chunk(dep)).find((x: { key: string }) => x.key === 'C')!;

  it.each([
    ['a parenthetical between references', 'Issue A (why) and Issue B', ['A', 'B'], []],
    ['a comma', 'Issue A, Issue B', ['A', 'B'], []],
    ['an em-dash rationale', 'Issue A — the schema change — and Issue B', ['A'], ['B']],
    ['a semicolon', 'Issue A; Issue B', ['A'], ['B']],
  ])('%s', (_label, dep, taken, dropped) => {
    expect(c(dep).dependsOnKeys).toEqual(taken);
    expect(c(dep).droppedDeps).toEqual(dropped);
  });

  it('still creates no dependency from an incidental reference in prose', () => {
    // THE PROPERTY IN TENSION, and the reason this reports instead of widening the
    // separator: accepting `—` would make this yield ['A','F'] — a permanent
    // dependency on nothing, the exact bug the leading-run anchor exists for.
    const d = c('Issue A — see the note about Issue F below');
    expect(d.dependsOnKeys).toEqual(['A']);
    // UPDATED BY RA-1454, deliberately. This asserted `['F']`. `F` is not a key this
    // brief declares — the fixture has A, B, C — so reporting it was noise about an
    // issue that does not exist. The report is now anchored on declared keys, which is
    // what lets a bare `B` be reported without prose becoming a stream of false
    // entries. The property this case exists for is unchanged and is the line above:
    // an incidental reference must never be ENFORCED.
    expect(d.droppedDeps, 'F is not a key this brief declares').toEqual([]);
  });

  it('does not report a reference inside a parenthetical as dropped', () => {
    // Rationale is not a reference. Stripped before BOTH reads, or the fix for RA-1300
    // would have created a new false report.
    expect(c('Issue A (parallel with Issue F) and Issue B').droppedDeps).toEqual([]);
  });

  it('surfaces them in the report, and does not stop the tick', () => {
    // The file's own distinction: a dropped LABEL blocks (no legitimate reason
    // exists); a dropped LINE is reported (the wrapped metadata continuation is a
    // real, intended drop). Dependencies pattern with the LINE, because the prose
    // mention above is indistinguishable from a real prerequisite.
    const w = worldFrom(chunk('Issue A; Issue B'));
    const out = report(w, { phase: 'file', actions: [], stopped: undefined });
    expect(out).toMatch(/Dependency references the run did not take/);
    expect(out).toContain('Issue B');
    expect(nextActions(w).stopped, 'reported, not blocking').not.toMatch(/Depends on/);
  });
});


describe('every CommonMark list marker hides a stray Closes equally (RA-1455)', () => {
  const item = (prose: string) => parseProposed(['# B', '', '## 3. Decomposition', '',
    '### Issue B — Second', '', '**Milestone:** Production Ready', '', prose, '', '## 4. Next', ''].join('\n'))[0];

  // RA-1330's own tell was "two markers that behave differently on identical content".
  // The fix accepted `1.` and not `1)`, and `-` but not `- [ ]` — the same asymmetry
  // one paren over. Both render identically on GitHub, so an author has no way to know
  // which form is read, and an unread `Closes` files a permanent duplicate (RA-1303).
  it.each([
    ['an ordered dot marker', '1. Closes #9'],
    ['an ordered paren marker', '1) Closes #9'],
    ['a nested blockquote + paren', '> 1) Closes #9'],
  ])('reports one behind %s', (_l, prose) => expect(item(prose).droppedCloses).toEqual([9]));

  it.each([
    ['a task list, unchecked', '- [ ] Closes #10'],
    ['a task list, checked', '- [x] Closes #10'],
    ['an upper-case task list', '- [X] Closes #10'],
  ])('reports one behind %s', (_l, prose) => expect(item(prose).droppedCloses).toEqual([10]));

  it('still stays silent on prose, so the widening is not an escalation machine', () => {
    expect(item("**This adopts #326's gap ONLY and does NOT close #326** — deliberate.").droppedCloses).toEqual([]);
    expect(item('This closes the gap that #159 describes.').droppedCloses).toEqual([]);
  });
});

describe('a prerequisite named without the word "Issue" is reported (RA-1454)', () => {
  const chunk = (dep: string) => ['# B', '', '## 3. Decomposition', '',
    '### Issue A — a', '', '**Milestone:** X', '',
    '### Issue B — b', '', '**Milestone:** X', '',
    '### Issue C — c', '', '**Milestone:** X', '', `**Depends on:** ${dep}`,
    '', '## 4. Next', ''].join('\n');
  const c = (dep: string) => parseProposed(chunk(dep)).find((x: { key: string }) => x.key === 'C')!;

  // `all` used the SAME `Issue <KEY>` token as `taken`, so anything outside that shape
  // was invisible to both reads and could not appear in the difference — taken
  // silently, reported nowhere, which is the fail-open direction the field exists for.
  it.each([
    ['a bare key after "and"', 'Issue A and B', ['A'], ['B']],
    ['a bare key after a comma', 'Issue A, B', ['A'], ['B']],
    ['a transitive prerequisite in the rationale', 'Issue A — which itself depends on B', ['A'], ['B']],
  ])('%s', (_l, dep, taken, dropped) => {
    expect(c(dep).dependsOnKeys).toEqual(taken);
    expect(c(dep).droppedDeps).toEqual(dropped);
  });

  it('reports BOTH when the plural form takes nothing at all', () => {
    // The worst of the three: `dependsOnKeys` comes back empty, so the item reads as
    // having no prerequisites, and nothing said a `**Depends on:**` line was present
    // and unread.
    const d = c('Issues A and B');
    expect(d.dependsOnKeys).toEqual([]);
    expect(d.droppedDeps).toEqual(['A', 'B']);
  });

  it('reports only keys the brief actually declares', () => {
    // Anchored on declared keys, so prose naming a capital letter cannot become noise.
    expect(c('Issue A — see the note about the Z path').droppedDeps).toEqual([]);
  });

  it('keeps reporting an EXPLICIT reference in a later sentence (RA-1468 review)', () => {
    // THE REGRESSION THE SENTENCE BOUNDARY INTRODUCED. `main` reported `B` here, and
    // restricting the whole read to the first sentence silenced it — the fail-open
    // direction this field exists for, in the field being widened.
    //
    // The two reads have different scopes on purpose: an author who wrote the word
    // `Issue` left no ambiguity to bound, so that counts anywhere on the line; a BARE
    // key is the new inference and is the one that needs the sentence boundary.
    const d = c('Issue A. Issue B must also land first.');
    expect(d.dependsOnKeys, 'still not enforced — the run anchor does not move').toEqual(['A']);
    expect(d.droppedDeps).toEqual(['B']);
  });

  it('reads the declaring SENTENCE for a BARE key, so a disclaimer is not read as a prerequisite', () => {
    // THE BOUNDARY THAT MAKES THIS SAFE, measured on the live corpus: `961.md:453`
    // writes `Issue A (…). Runs in parallel with B.` and `:564` writes `nothing. Runs
    // at any time, independently of A–D.` Reporting those would assert the exact
    // opposite of what they say. A phrase list would be the opt-in maintenance RA-1214
    // deleted a file for; a sentence boundary needs nothing remembered.
    expect(c('Issue A (needs the list). Runs in parallel with B.').droppedDeps).toEqual([]);
    expect(c('nothing. Runs at any time, independently of A and B.').droppedDeps).toEqual([]);
  });

  it('does not widen what is ENFORCED — only what is reported', () => {
    // The leading-run anchor is the whole defence against a phantom dependency and
    // must not move. A bare key is reported, never taken.
    for (const dep of ['Issue A and B', 'Issues A and B', 'Issue A — which itself depends on B']) {
      expect(c(dep).dependsOnKeys, `${dep} must not gain an enforced key`).not.toContain('B');
    }
  });
});

describe('the Examined table survives a dropped-* block (RA-1456)', () => {
  it('keeps every count row inside the table', () => {
    // The blocks were spliced BETWEEN the count rows, each wrapped in blank lines,
    // which terminates the GFM table — so `| filed |` onward rendered as literal
    // pipe-separated text with no delimiter row above it. Those are the counts a human
    // reads at close.
    const md = ['# B', '', '## 3. Decomposition', '',
      '### Issue A — a', '', '**Milestone:** X', '',
      '### Issue B — b', '', '**Milestone:** X', '',
      '### Issue C — c', '', '**Milestone:** X', '', '**Depends on:** Issue A; Issue B',
      '', '## 4. Next', ''].join('\n');
    const w = worldFrom(md);
    const out = report(w, { phase: 'file', actions: [], stopped: undefined });

    expect(out, 'the block must still appear').toMatch(/Dependency references the run did not take/);

    // Every `| … |` row up to the first blank line after the header must be contiguous.
    const lines = out.split('\n');
    const start = lines.findIndex((l: LibraryValue) => l.startsWith('| Examined |'));
    expect(start).toBeGreaterThan(-1);
    const table: string[] = [];
    for (let i = start; i < lines.length && lines[i].trim() !== ''; i++) table.push(lines[i]);
    for (const row of ['| filed |', '| open |', '| blocked, awaiting a human |', '| deploy to ']) {
      expect(table.some((l) => l.startsWith(row)), `${row} must be inside the table`).toBe(true);
    }
    // And the detail block comes after the table, not inside it.
    const blockAt = lines.findIndex((l: LibraryValue) => l.includes('Dependency references'));
    expect(blockAt).toBeGreaterThan(start + table.length - 1);
  });
});

describe('every open project is reconciled, not just the lowest-numbered one (RA-1447)', () => {
  // Not a slow queue — a stop. A project only advanced once every lower-numbered one
  // had CLOSED. Measured when this was written: RA-1015 open since 2026-08-26 and 1 of 5
  // done, while RA-1291 (9 proposed items) and RA-1292 (8) had filed ZERO issues between
  // them for four days. RA-1305 amplified it: one bailed issue held three others and both
  // higher-numbered projects for three days.
  const reconcileWf = asOneWorkflow('agent-lead-reconcile.yml');
  const scopeStep = reconcileWf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'scope');

  const runScopeMulti = ({ briefs, openIssues }: { briefs: string[]; openIssues: number[] }) => {
    const dir = mkdtempSync(join(tmpdir(), 'lead-scope-multi-'));
    mkdirSync(join(dir, 'docs/projects'), { recursive: true });
    for (const b of briefs) writeFileSync(join(dir, 'docs/projects', b), '# brief\n');
    writeStub(join(dir, 'gh'),
      `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in [0-9]*) n="$a"; break;; esac; done\ncase " ${openIssues.join(' ')} " in *" $n "*) echo OPEN;; *) echo CLOSED;; esac\n`);
    const r = runWorkflowStep(scopeStep, {
      dir, cwd: dir,
      env: { PATH: `${dir}:${process.env.PATH}`, INPUT_PROJECT: '' },
    });
    return { status: r.status, stdout: r.stdout, project: r.outputs.project ?? null };
  };

  it('emits every open project, in numeric order', () => {
    // The live shape at the time of the fix: three open, two of them starved.
    const r = runScopeMulti({
      briefs: ['961.md', '1015.md', '1291.md', '1292.md'],
      openIssues: [1015, 1291, 1292],
    });
    expect(r.status).toBe(0);
    expect(r.project).toBe('1015,1291,1292');
  });

  it('omits the closed ones', () => {
    const r = runScopeMulti({ briefs: ['961.md', '1015.md'], openIssues: [1015] });
    expect(r.project).toBe('1015');
  });

  it('still emits nothing when no project is open', () => {
    const r = runScopeMulti({ briefs: ['961.md'], openIssues: [] });
    expect(r.status).toBe(0);
    expect(r.project).toBe('');
  });

  it('keeps numeric ordering rather than the lexical glob order', () => {
    // `1010.md` sorts before `952.md` lexically. The order is what the shared tick
    // budget is consumed in, so it has to stay numeric.
    const r = runScopeMulti({ briefs: ['1010.md', '952.md'], openIssues: [952, 1010] });
    expect(r.project).toBe('952,1010');
  });
});

describe('reconcileAll: the loop, the shared budget and the global cap (RA-1447)', () => {
  // Driven through the SHIPPED function via its io seam, not a re-implementation of
  // the loop — the loop is what changed, so a copy would assert nothing.
  const proj = (n: number, opts: { open?: number; inFlight?: number } = {}) => {
    const open = opts.open ?? 2;
    const inFlight = opts.inFlight ?? 0;
    const issues = Array.from({ length: open }, (_, i) => ({
      number: n * 100 + i,
      title: `t${i}`,
      state: 'OPEN',
      labels: i < inFlight ? ['agent:implement'] : [],
      order: i,
    }));
    return {
      ...worldFrom(BRIEF(Array.from({ length: open }, (_, i) => `t${i}`))),
      project: String(n),
      all: issues,
      open: issues,
      filed: issues,
    };
  };

  const run = (worlds: Record<string, unknown>, o: Record<string, unknown> = {}) => {
    const seen: string[] = [];
    // The `read` seam returns whatever `readWorld` does; these fixtures are
    // deliberately partial worlds, so the options object is typed once here rather
    // than each field being widened.
    const opts = {
      read: (p: string) => {
        seen.push(p);
        const w = worlds[p];
        if (w instanceof Error) throw w;
        return w;
      },
      onDecision: () => {},
      budget: Infinity,
      ...o,
    } as unknown as Parameters<typeof reconcileAll>[1];
    const r = reconcileAll(Object.keys(worlds), opts);
    return { ...r, seen };
  };

  it('reads every project, in the order given', () => {
    // The whole point: RA-1291 and RA-1292 had filed ZERO issues for four days because
    // RA-1015 was open. Nothing about that was a queue — they were never read.
    const r = run({ 1015: proj(1015), 1291: proj(1291), 1292: proj(1292) });
    expect(r.seen).toEqual(['1015', '1291', '1292']);
    expect(r.decisions).toHaveLength(3);
  });

  it('does NOT charge a review churn to the shared tick budget (RA-1523 review)', () => {
    // THE ARITHMETIC, DIRECTLY. `nextActions` never consults the budget, so the claim
    // "a churn is not charged" was true there and false in `reconcileAll`, which
    // decremented by `decision.actions.length` — churns included.
    expect(chargeable([{ kind: 'review-churn' }]), 'a churn is free').toBe(0);
    expect(chargeable([{ kind: 'file' }, { kind: 'dispatch' }]), 'real work is not').toBe(2);
    expect(chargeable([{ kind: 'review-churn' }, { kind: 'file' }]), 'and it is per-action').toBe(1);
    expect(chargeable([]), 'nothing costs nothing').toBe(0);
    expect(chargeable(undefined as never), 'a missing list is not a crash').toBe(0);
  });

  it('and reconcileAll charges through it, not through actions.length', () => {
    // THE BINDING ASSERTION. `chargeable` being correct is worth nothing if the loop
    // stops calling it — and the loop is where the budget actually moves, reachable
    // only with `gh`. The damage is cross-project: a churn on the first project
    // silently removes a file or dispatch from the third, so the tick where work is
    // piling up behind unreviewed PRs is exactly the tick that files least.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const loop = src.slice(src.indexOf('export function reconcileAll'));
    expect(loop).toMatch(/budgetLeft -= chargeable\(decision\.actions\);/);
    expect(loop, 'the raw count is what charged the churn').not.toMatch(/budgetLeft -= decision\.actions\.length/);
    // The sibling line was always right; it must stay that way.
    expect(loop).toMatch(/globalLeft -= inFlightCount\(world\)/);
  });

  it('shares ONE tick budget across projects rather than granting it to each', () => {
    // Otherwise reconciling N projects would let a tick do N times more than the
    // bound `QA_LEAD_TICK_BUDGET` exists to impose.
    const r = run({ 1: proj(1, { open: 3 }), 2: proj(2, { open: 3 }), 3: proj(3, { open: 3 }) }, { budget: 4 });
    const total = r.decisions.reduce((n: number, d: { decision: { actions: unknown[] } }) => n + d.decision.actions.length, 0);
    expect(total, 'the shared budget bounds the whole tick').toBeLessThanOrEqual(4);
    expect(r.budgetLeft).toBeGreaterThanOrEqual(0);
  });

  it('bounds in-flight work GLOBALLY, not just per project', () => {
    // wip answers "how many of THIS project's issues may be in flight" — a statement
    // about the brief's dependency order. Once every project is reconciled, that stops
    // bounding the total: three projects at wip 3 is nine concurrent implementer runs,
    // and the Implementer's real ceiling is quota (a usage cap was hit 2026-09-02).
    const r = run({ 1: proj(1, { open: 4, inFlight: 3 }), 2: proj(2, { open: 4 }) }, { globalWip: 3, wipPerProject: 3 });
    // Project 1 consumes the whole global allowance, so project 2 gets wip 0 and
    // dispatches nothing — it is still READ and reported, which is the fix.
    expect(r.seen).toEqual(['1', '2']);
    expect(r.globalLeft).toBeLessThanOrEqual(0);
    const second = r.decisions.find((d: { project: string }) => d.project === '2');
    expect(second, 'project 2 must still be READ and reported — that is the fix').toBeDefined();
    expect(second!.decision.actions.filter((a: { kind: string }) => a.kind === 'dispatch')).toEqual([]);
  });

  it('bounds the total this tick DISPATCHES, not only what was already labelled', () => {
    // THE CASE THE FIRST VERSION OF THIS SUITE WAS MISSING (RA-1483 review), and the
    // reason the cap shipped broken: every global-cap fixture pre-set `inFlight`, so
    // only the branch that works was exercised — a project whose allowance is
    // consumed by EXISTING labels. No case had a project that dispatches, which is
    // the entire mechanism. `inFlightCount` reads the `agent:implement` label, which
    // `execute` applies AFTER the decision, so charging it alone spent the cap on
    // history and never on the thing it exists to bound.
    //
    // Production settings from the workflow: budget 6, wip 3, globalWip 3, three open
    // projects, NOTHING in flight — the live RA-1015/RA-1291/RA-1292 shape. Before the fix
    // this dispatched 6 under a guard reading 3, and settled there permanently.
    const r = run(
      { 1015: proj(1015, { open: 4 }), 1291: proj(1291, { open: 4 }), 1292: proj(1292, { open: 4 }) },
      { budget: 6, globalWip: 3, wipPerProject: 3 },
    );
    const dispatched = r.decisions.reduce(
      (n: number, d: { decision: { actions: Array<{ kind: string }> } }) =>
        n + d.decision.actions.filter((a) => a.kind === 'dispatch').length, 0);
    expect(dispatched, 'the global cap must bound the tick, not just its history').toBe(3);
    expect(r.globalLeft).toBeLessThanOrEqual(0);
  });

  it('says WHICH cap stopped a project, when the shared allowance is what ran out', () => {
    // `wip` is now min(own cap, global remaining), so a project with NOTHING in flight
    // could be stopped at `WIP cap reached (0/0)` — which reads as its own cap and is
    // not. More visible after the fix above, not less.
    const r = run(
      { 1: proj(1, { open: 4 }), 2: proj(2, { open: 4 }) },
      { budget: 6, globalWip: 3, wipPerProject: 3 },
    );
    const second = r.decisions.find((d: { project: string }) => d.project === '2');
    expect(second!.decision.stopped).toMatch(/shared implementer allowance is spent/);
    expect(second!.decision.stopped, 'and must not blame the project\'s own cap').not.toMatch(/WIP cap reached/);
  });

  it('changes nothing at one open project', () => {
    // GLOBAL_WIP_DEFAULT is WIP_DEFAULT, so the two caps are the same number and bind
    // identically until a second project exists. That is what makes this safe to ship.
    const one = run({ 1015: proj(1015, { open: 3 }) }, { globalWip: 3, wipPerProject: 3 });
    expect(one.failures).toEqual([]);
    expect(one.decisions).toHaveLength(1);
  });

  it('one project failing does not strand the rest', () => {
    // THE COUPLING THIS CHANGE REMOVES, and the way it could come back worse: a throw
    // reconciling RA-1015 used to take every higher-numbered project with it. Now it can
    // reach every project, so isolation is load-bearing rather than tidy.
    const r = run({ 1015: new Error('gh: 502'), 1291: proj(1291), 1292: proj(1292) });
    expect(r.seen).toEqual(['1015', '1291', '1292']);
    expect(r.failures).toEqual([{ project: '1015', message: 'gh: 502' }]);
    expect(r.decisions.map((d: { project: string }) => d.project)).toEqual(['1291', '1292']);
  });

  it('reports a failure rather than swallowing it', () => {
    const r = run({ 1015: new Error('boom') });
    expect(r.failures).toHaveLength(1);
    expect(r.decisions).toEqual([]);
  });
});

describe('a tick that could not reconcile does not report success (RA-1483 review)', () => {
  // Before the loop, `main()` let a read throw out and the tick went RED. Catching per
  // project is right — it is what stops one project stranding the others — but
  // dropping `failures` made "nothing was reconciled at all" indistinguishable from
  // "everything was fine", on a green run, retried hourly forever. That is the
  // swallowed-403 shape this workflow carries three comments about, and it would sit
  // BELOW RA-1036's detector, which watches for a workflow red on EVERY run.
  const script = join(ROOT, 'scripts/lead-reconcile.mjs');

  const runCli = (ghBody: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'lead-exit-'));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\n${ghBody}\n`);
    const r = spawnSync(process.execPath, [script, '--project', '1015,1291'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', QA_LEAD_APPLY: '' },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('exits non-zero when every project fails to be read', () => {
    // What a lost App permission looks like. The isolation must still hold — both
    // projects are attempted — but the run must not end green.
    const r = runCli('echo "HTTP 403: Resource not accessible by integration" >&2; exit 1');
    expect(r.status, 'a tick that reconciled nothing must be red').not.toBe(0);
    expect(r.out).toMatch(/1015/);
    expect(r.out, 'the isolation still attempts the second project').toMatch(/1291/);
  });

  it('says NONE was reconciled rather than claiming an unaffected rest', () => {
    const r = runCli('echo "HTTP 403" >&2; exit 1');
    expect(r.out).toMatch(/NONE was reconciled/);
    expect(r.out).not.toMatch(/the rest were unaffected/);
  });
});

describe('a wrapped `**Depends on:**` line is a field, not a line (RA-1636)', () => {
  // `DEPENDS_RE` is `/…(.+?)$/m` with no `s` flag, so it read the FIRST PHYSICAL LINE.
  // The rest went to `droppedLines`, which deliberately does not block — so a
  // dependency the brief declared vanished from `dependsOnKeys` and the dispatch gate
  // acted on the truncation, releasing an issue for `agent:implement` ahead of its
  // prerequisite. Fail-open, in the one field whose job is holding work back.
  const wrapped = [
    '# Brief', '', '## Decomposition', '',
    '### Issue B — bee', '', '**Milestone:** Product Backlog', '', 'It does a thing.', '',
    '### Issue C — cee', '', '**Milestone:** Product Backlog', '', 'It does a thing.', '',
    '### Issue D — dee', '',
    '**Milestone:** Product Backlog',
    '**Depends on:** Issue B (it must land first, so that D exercises',
    '  another real charge) and Issue C (it drives the settle path with a live card, and #1134 is a',
    '  double-settle on it)', '',
    'It does a thing.', '',
  ].join('\n');

  it('reads a dependency named on a continuation line', () => {
    const d = parseProposed(wrapped).find((p: { key: string }) => p.key === 'D');
    expect(d?.dependsOnKeys, 'C is declared on the wrapped half of the field').toEqual(['B', 'C']);
  });

  it('holds dispatch on the continuation dependency, which is the harm', () => {
    // The report is read AFTER the tick has acted, and dispatch is the action — so the
    // property to hold is the gate, not the rendering.
    //
    // B IS CLOSED AND C IS OPEN, deliberately. With B still open, D is held by the
    // dependency the parser DID read, and the test would pass over the defect — which
    // is what a first draft of it did. Only the continuation-line dependency can hold
    // D here, so nothing but the fix makes this green.
    const w = worldFrom(wrapped, [
      { number: 2, title: 'bee', state: 'CLOSED' },
      { number: 3, title: 'cee' },
      { number: 4, title: 'dee' },
    ]);
    const out = nextActions(w, { wip: 3 });
    const dispatched = out.actions.map((a: { number: number }) => a.number);
    expect(dispatched, 'D must wait on C, which only the wrapped half declares').not.toContain(4);
    expect(dispatched, 'C itself is eligible').toEqual([3]);
  });

  it('still refuses a phantom dependency from prose after the run', () => {
    // The leading-run anchor is untouched: reading MORE of the field must not widen
    // what the run takes. `F` is prose and stays report-only (RA-1331).
    const brief = [
      '# Brief', '', '## Decomposition', '',
      '### Issue A — ay', '', '**Milestone:** Product Backlog', '', 'x', '',
      '### Issue F — eff', '', '**Milestone:** Product Backlog', '', 'x', '',
      '### Issue G — gee', '',
      '**Milestone:** Product Backlog',
      '**Depends on:** Issue A — see the note about Issue F below', '',
      'x', '',
    ].join('\n');
    const g = parseProposed(brief).find((p: { key: string }) => p.key === 'G');
    expect(g?.dependsOnKeys).toEqual(['A']);
    expect(g?.droppedDeps).toEqual(['F']);
  });

  it('leaves every brief on disk parsing exactly as it did', () => {
    // The widening must be inert on the corpus, or it is a change to live projects
    // rather than a fix. Re-measured here rather than asserted.
    for (const f of readdirSync('docs/projects').filter((n) => /^\d+\.md$/.test(n))) {
      const parsed = parseProposed(readFileSync(`docs/projects/${f}`, 'utf8'));
      for (const p of parsed as Array<{ key: string; dependsOnKeys: string[] }>) {
        // Every taken key is one the decomposition declares — the property that would
        // break first if the field read swallowed a following section.
        const declared = new Set((parsed as Array<{ key: string }>).map((x) => x.key));
        for (const k of p.dependsOnKeys) {
          expect(declared.has(k), `${f} item ${p.key} depends on undeclared ${k}`).toBe(true);
        }
      }
    }
  });
});

describe('an adopted issue joins its project completely (RA-1637)', () => {
  const MARKER = '<!-- qa:project 952 -->';
  const w = () => ({ ...worldFrom(BRIEF(['t'])), project: '952', briefPath: 'docs/projects/952.md' });
  const adopt = { kind: 'adopt', number: 897, title: 'the item title', milestone: 'Production Ready' };

  /** A `gh` stand-in that records argv and answers the two reads the arm makes. */
  const runner = (body: string, milestone: string | null = null) => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ body, milestone: milestone ? { title: milestone } : null });
      return '';
    };
    return { calls, run };
  };

  it('applies the milestone the decomposition item names', () => {
    // `--milestone` appeared on the `file` arm and the phase-5 arm and not on this one,
    // though the value was already on the action. A brief that states gate movement and
    // silently does not perform it is the failure AGENTS.md's gate rule exists to stop.
    const { calls, run } = runner('body text');
    execute(w(), [adopt], { run });
    const edit = calls.find((c) => c.includes('--milestone'));
    expect(edit, 'the adopt arm must set the brief\'s milestone').toBeTruthy();
    expect(edit).toContain('Production Ready');
    expect(edit).toContain('897');
  });

  it('does not re-issue the milestone edit when it already matches', () => {
    const { calls, run } = runner(`body\n\n${MARKER}`, 'Production Ready');
    execute(w(), [adopt], { run });
    expect(calls.some((c) => c.includes('--milestone'))).toBe(false);
  });

  it('guards on membership, not on the marker appearing anywhere', () => {
    // Present-but-not-last is exactly the state a human produces by appending below the
    // marker. The old guard called that "already declares membership" — false — and
    // skipped the edit, every tick, forever.
    const { calls, run } = runner(`body\n\n${MARKER}\n\nBlocked on X`);
    execute(w(), [adopt], { run });
    const edit = calls.find((c) => c.includes('--body'));
    expect(edit, 'a buried marker must fall through to the rewrite').toBeTruthy();
    const newBody = edit![edit!.indexOf('--body') + 1];
    expect(declaresMembership(newBody, 952), 'the rewrite must make it a member').toBe(true);
    expect(newBody.split(MARKER).length - 1, 'exactly one marker, not two').toBe(1);
    expect(newBody, 'the human\'s own text survives').toContain('Blocked on X');
  });

  it('still skips the body edit when the issue really is a member', () => {
    const { calls, run } = runner(`body\n\n${MARKER}`);
    execute(w(), [adopt], { run });
    expect(calls.some((c) => c.includes('--body'))).toBe(false);
  });

  it('does not stack the adoption note when repairing a buried marker', () => {
    const prior = 'Adopted into project #952 by the Lead, from the decomposition item **the item title**.';
    const { calls, run } = runner(`body\n\n${prior}\n\n${MARKER}\n\nappended`);
    execute(w(), [adopt], { run });
    const edit = calls.find((c) => c.includes('--body'))!;
    const newBody = edit[edit.indexOf('--body') + 1];
    expect(newBody.split('Adopted into project #952 by the Lead').length - 1).toBe(1);
  });
});

describe('the closing references the parser did not read are named, not counted (RA-1352)', () => {
  const stray = [
    '# Brief', '', '## Decomposition', '',
    '### Issue A — ay', '', '**Milestone:** Product Backlog', '',
    'Closes #4242 as part of this.', '',
  ].join('\n');

  it('names them outside the file phase, where the stop is unreachable', () => {
    // `droppedCloses > 0` stops in the `file` phase and the stop names every reference.
    // Once every item is filed the phase moves on, that branch is unreachable, and the
    // reader was left with `| closing references not on a metadata line | 1 |`.
    const w = worldFrom(stray, [{ number: 7, title: 'ay', state: 'CLOSED' }]);
    const text = report(w, { phase: 'complete', actions: [], stopped: null });
    expect(text).toContain('Closing references the parser did not read');
    expect(text).toContain('#4242');
    expect(text).toContain('ay');
  });

  it('is suppressed when there is nothing to name', () => {
    const text = report(worldFrom(BRIEF(['a']), []), { phase: 'file', actions: [], stopped: null });
    expect(text).not.toContain('Closing references the parser did not read');
  });
});

describe('the reconciler names the declared reference environment, not `staging` (kanon#199)', () => {
  const allClosedWith = (extra: Record<string, unknown> = {}) => ({
    ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
    project: '961',
    ...extra,
  });
  const DEPLOYED_PREVIEW = { state: 'deployed', tag: 'v1.2.0', environment: 'preview', workflow: 'deploy-preview.yml', job: 'ship' };

  it('titles a new QA issue with the declared environment, and describes it when none is declared', () => {
    expect(qaIssueTitle(961, 'preview')).toBe('Verify project #961 on preview — every acceptance criterion, per ID');
    expect(qaIssueTitle(961)).toBe('Verify project #961 on the reference environment — every acceptance criterion, per ID');
    // An adopter that declares `staging` files under the title it always did.
    expect(qaIssueTitle(961, 'staging')).toBe('Verify project #961 on staging — every acceptance criterion, per ID');
  });

  it('files the QA issue under the declared environment’s title', () => {
    const r = nextActions(allClosedWith({ deploy: DEPLOYED_PREVIEW, qaIssue: null }));
    expect(r.phase).toBe('file-qa');
    expect(r.actions).toEqual([{ kind: 'file-qa', title: 'Verify project #961 on preview — every acceptance criterion, per ID', tag: 'v1.2.0', environment: 'preview' }]);
  });

  it('recovers an open QA issue filed under the old `staging` title, so it is not filed twice', () => {
    // The title is a recovery anchor (RA-1286): an adopter whose record now declares
    // `preview` still has QA issues titled `on staging`. Matched, they are this project's QA
    // issue; missed, the tick files a second one with its round count reset.
    for (const env of ['staging', 'preview', 'the reference environment', 'a renamed one']) {
      const orphan = { number: 9, title: `Verify project #961 on ${env} — every acceptance criterion, per ID`, body: 'gh workflow run agent-verify-acs.yml -f project=961', labels: [] as string[] };
      expect(qaIssueOf([orphan], 961).issue?.number, env).toBe(9);
    }
    const old = { number: 9, title: 'Verify project #961 on staging — every acceptance criterion, per ID', body: 'gh workflow run agent-verify-acs.yml -f project=961', labels: [] as string[], state: 'OPEN' };
    const { issue } = qaIssueOf([old], 961);
    const r = nextActions(allClosedWith({ deploy: DEPLOYED_PREVIEW, qaIssue: { ...issue, state: 'OPEN', rounds: 0, readable: true } }));
    expect(r.actions.filter((a: { kind: string }) => a.kind === 'file-qa')).toEqual([]);
  });

  it('matches no other project’s title, and no title of another shape', () => {
    const body = 'gh workflow run agent-verify-acs.yml -f project=961';
    for (const title of [
      'Verify project #9610 on staging — every acceptance criterion, per ID',
      'Verify project #961 on  — every acceptance criterion, per ID'.replace('  ', ' '),
      'Verify project #961 on staging — some criteria',
      'Re: Verify project #961 on staging — every acceptance criterion, per ID',
    ]) {
      expect(isQaIssueTitle(title, 961), title).toBe(false);
      expect(qaIssueOf([{ number: 9, title, body, labels: [] as string[] }], 961).issue, title).toBeUndefined();
    }
  });

  it('names it in the close comment, the retro, the report row and both caveats', () => {
    const close = { kind: 'close-project', number: 961, tag: 'v1.2.0', environment: 'preview', failedAt: 'v1.1.0', failedUrl: 'u' };
    expect(renderCloseComment(close)).toContain('the work is on `preview` in `v1.2.0`');
    expect(ownFailureCaveat(close)).toContain('the work reached `preview` only via');
    const r = retro(allClosedWith({ deploy: DEPLOYED_PREVIEW, qaIssue: { number: 2, state: 'CLOSED', rounds: 1, readable: true } }), close);
    expect(r).toContain('The work is on `preview` in `v1.2.0`');
    expect(r).toContain('**That the work behaves on `preview`.**');
    expect(r).toContain('not against `preview` itself');
    const text = report(allClosedWith({ deploy: DEPLOYED_PREVIEW }), { phase: 'close', actions: [], stopped: null });
    expect(text).toContain('| deploy to `preview` | deployed (`v1.2.0`) |');
    for (const t of [renderCloseComment(close), ownFailureCaveat(close), r, text]) expect(t).not.toMatch(/staging/i);
  });

  it('describes the environment where a verdict names none, never `staging`', () => {
    const close = { kind: 'close-project', number: 961, tag: 'v1.2.0' };
    expect(renderCloseComment(close)).toContain('the work is on the reference environment in `v1.2.0`');
    expect(retro(allClosedWith({ deploy: { state: 'nothing-to-deploy' } }), { kind: 'close-project', number: 961, tag: null }))
      .toContain('the reference environment was never touched');
  });
});

describe('the QA issue survives the verification churn (RA-1286)', () => {
  const QA_TITLE = 'Verify project #952 on staging — every acceptance criterion, per ID';
  const QA_BODY = 'Verify project #952 on staging, per acceptance criterion.\n\n```\ngh workflow run agent-verify-acs.yml -f project=952\n```\n\n<!-- qa:project 952 -->';

  it('finds the QA issue by its label when it has one', () => {
    const all = [{ number: 9, title: QA_TITLE, body: QA_BODY, labels: ['qa:verify'] }];
    expect(qaIssueOf(all, 952)).toMatchObject({ issue: { number: 9 }, labelMissing: false });
  });

  it('recovers it when a tick died between the remove and the re-add', () => {
    // The label is BOTH the marker `readWorld` reads and the trigger the tick must
    // churn, so there is a window in which the QA issue carries no marker at all.
    const orphan = { number: 9, title: QA_TITLE, body: QA_BODY, labels: [] as string[] };
    const out = qaIssueOf([orphan], 952);
    expect(out.labelMissing, 'the recovery must say it recovered').toBe(true);
    expect(out.issue?.number).toBe(9);
    expect(orphan.labels, 'the label is synthesised so every downstream filter agrees').toContain('qa:verify');
  });

  it('does not dispatch an implementer at a QA issue whose label is missing', () => {
    // The reachable harm, and the worse half of RA-1286: without the label the QA issue
    // is ordinary open work, and the reconcile arm would set the Implementer loose on it.
    const orphan = { number: 9, title: QA_TITLE, body: QA_BODY, labels: [] as string[], state: 'OPEN' };
    qaIssueOf([orphan], 952);
    const w = { ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]) } as Record<string, unknown>;
    (w.open as unknown[]) = [orphan];
    (w.all as unknown[]) = [orphan];
    const out = nextActions(w, { wip: 3 });
    expect(out.actions.filter((a: { kind: string }) => a.kind === 'dispatch')).toHaveLength(0);
  });

  it('refuses to mistake a project issue that merely mentions the workflow', () => {
    // Precision over recall, deliberately: matching loosely files nothing and treats a
    // finding as the QA issue, which is worse than falling back to today's behaviour.
    const mention = { number: 9, title: 'Harden agent-verify-acs.yml', body: 'agent-verify-acs.yml is flaky', labels: [] as string[] };
    expect(qaIssueOf([mention], 952)).toMatchObject({ issue: undefined, labelMissing: false });
  });

  it('re-adds the label even when the remove fails, which is the orphan state', () => {
    // Once a previous tick has stripped it, `--remove-label` exits non-zero on a label
    // the issue does not carry — and the one action that would restore the marker
    // failed on its first call and held the project instead.
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args.includes('--remove-label')) throw new Error('gh issue edit failed: label not found');
      return '';
    };
    execute(world(), [{ kind: 'verify', number: 9, project: 952, tag: 'v1.0.0' }], { run });
    expect(calls.some((c) => c.includes('--add-label') && c.includes('qa:verify')),
      'the add is the event and must not be skipped').toBe(true);
  });
});

describe('every escalation says which KIND of hold it is (RA-1671 review)', () => {
  it('no `escalate:` site can be added without an `escalateKind:`', () => {
    // `renderHoldComment` has three openings and `applyDecision` defaults to `defect`,
    // so an `escalate:` added without a kind opens with "the brief describes something
    // no tick can act on" — which is silently wrong for a failed action or a terminal
    // stop, and reads as deliberate. Raised as a nit on RA-1671 and held here rather
    // than left to the next author to remember.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const sites = [...src.matchAll(/^\s*escalate:/gm)];
    expect(sites.length, 'the scan must find the sites it claims to guard').toBeGreaterThanOrEqual(4);
    for (const m of sites) {
      // The kind sits on the line immediately above, inside the same object literal.
      const before = src.slice(0, m.index).split('\n').slice(-2).join('\n');
      expect(before, `an \`escalate:\` at offset ${m.index} carries no \`escalateKind:\``)
        .toMatch(/escalateKind:/);
    }
  });
});

describe('the half of the hold that WRITES it (RA-1202)', () => {
  // The READ half — `phaseOf` returning `held` above every other phase, `nextActions`
  // proposing nothing — was well covered. The write half had no test at all: deleting
  // `if (failures.length) hold(world, failures)` left the whole unit tier green and put
  // the tick back to RA-963's behaviour, a `::warning` and a green run, hourly, forever.
  const w = () => ({ ...worldFrom(BRIEF(['t'])), project: '952' });

  /** Records argv; `answers` decides what a read returns and what throws. */
  const spy = (fail: (args: string[]) => boolean = () => false, comments = '') => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (fail(args)) { const e = new Error('gh issue edit failed: HTTP 422 milestone not found'); throw e; }
      if (args.includes('comments')) return comments;
      if (args[1] === 'view') return JSON.stringify({ body: '', milestone: null });
      return '';
    };
    return { calls, run };
  };

  it('a failed action holds the project', () => {
    const { calls, run } = spy((a) => a.includes('--add-label') && a.includes('agent:implement'));
    execute(w(), [{ kind: 'dispatch', number: 5, title: 'x' }], { run });
    const label = calls.find((c) => c.includes('--add-label') && c.includes('needs:human'));
    expect(label, 'a permanent failure must put `needs:human` on the tracking issue').toBeTruthy();
    expect(label).toContain('952');
    expect(calls.some((c) => c[1] === 'comment'), 'and say why, once').toBe(true);
  });

  it('says nothing a second time when its marker is already on the issue', () => {
    // Without this an hourly tick turns one permanent failure into a comment an hour —
    // the same invisibility as no comment, from the opposite direction.
    const reasons = ['`dispatch` for #5 — gh issue edit failed: HTTP 422 milestone not found'];
    const { calls, run } = spy(
      (a) => a.includes('--add-label') && a.includes('agent:implement'),
      renderHoldComment(reasons),
    );
    execute(w(), [{ kind: 'dispatch', number: 5, title: 'x' }], { run });
    expect(calls.some((c) => c[1] === 'comment'), 'the marker suppresses the repeat').toBe(false);
    expect(calls.some((c) => c.includes('--add-label') && c.includes('needs:human')),
      'but the label is still asserted — it is idempotent').toBe(true);
  });

  it('does say a DIFFERENT reason, which one marker for all reasons silenced', () => {
    // RA-1242: a project held for a failed action that later enters a terminal stop had
    // the new reason — the one a human is being asked to decide — written nowhere.
    const older = renderHoldComment(['`file` for “a” — HTTP 422 milestone not found']);
    const { calls, run } = spy(() => false, older);
    hold(w(), ['phase 5 is `qa-exhausted`: two rounds and no pass'], { run, kind: 'stop' });
    expect(calls.some((c) => c[1] === 'comment')).toBe(true);
  });

  it('escalate routing turns a decision into a hold, not just a report', () => {
    // `nextActions` returning `escalate` for a dependency cycle is asserted; that the
    // tick's apply path turns it into a hold was not, because it lived in a default
    // parameter no test could reach without letting the real `gh` run.
    const { calls, run } = spy();
    applyDecision(w(), { phase: 'reconcile', actions: [], escalate: ['dependency cycle: #1 → #2 → #1'] }, { run, apply: true });
    expect(calls.some((c) => c.includes('--add-label') && c.includes('needs:human'))).toBe(true);
  });

  it('takes no action at all when the tick is a dry run', () => {
    const { calls, run } = spy();
    applyDecision(w(), { phase: 'reconcile', actions: [{ kind: 'dispatch', number: 5, title: 'x' }], escalate: ['x'] }, { run, apply: false });
    expect(calls, 'a dry run reports and writes nothing').toEqual([]);
  });

  it('repoLabels returns undefined, not an empty set, when the read fails', () => {
    // The property that stops an API hiccup deadlocking a project: an empty set rejects
    // EVERY label the brief names, and a dropped label fails closed.
    expect(repoLabels({ json: () => { throw new Error('gh label list failed: HTTP 502'); } })).toBeUndefined();
    expect(repoLabels({ json: () => [{ name: 'sev:critical' }] })).toEqual(new Set(['sev:critical']));
  });
});

describe('an escalation says WHY the command failed (RA-1284)', () => {
  it('takes the cause off stderr, not the argv line', () => {
    // `execFileSync` throws with `message = "Command failed: <argv>\n<stderr>"`, and
    // every caller took `.split('\n')[0]` — the one line that says nothing. A 403, a
    // 404, a malformed input and a blip produced byte-identical escalations.
    expect(ghCause({ stderr: 'HTTP 403: Resource not accessible by integration\nmore\n' }))
      .toBe('HTTP 403: Resource not accessible by integration');
    expect(ghCause({ message: 'Command failed: gh workflow run x\nHTTP 403: nope\n' }))
      .toBe('HTTP 403: nope');
    expect(ghCause({ message: 'Command failed: gh x' }), 'nothing to say is empty, not the argv').toBe('');
  });

  it('never publishes a token, because the hold comment is public', () => {
    expect(redactSecrets('fatal: https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAA@github.com/o/r'))
      .not.toMatch(/ghs_A{8}/);
    expect(redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked')).toContain('«redacted»');
    expect(ghCause({ stderr: 'x'.repeat(500) }).length, 'bounded — a comment is not a log file').toBe(300);
  });

  it("redacts the STATELESS token format too, whole (RA-1945)", () => {
    // GitHub is replacing the opaque `ghs_` installation token with a ~520-character
    // JWT: three base64url segments, two dots, `-` and `_` inside them. The original
    // body class was `[A-Za-z0-9]`, so the match stopped at the FIRST DOT and published
    // the payload and part of the signature — an installation id, an expiry and a
    // credential fragment, on the public issue this function exists to keep them off.
    //
    // Asserted as an exact string rather than `not.toContain`, because the interesting
    // failure is a PARTIAL redaction that a `toContain('«redacted»')` check passes.
    const [header, payload, signature] = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJpbnN0YWxsYXRpb25faWQiOjEyMzQ1Njc4OSwiZXhwIjoxNzk5OTk5OTk5fQ',
      'c2ln-bmF0dXJl_cGFydA-aGVyZQ_YWJjMTIzNDU2Nzg5',
    ];
    const token = `ghs_${header}.${payload}.${signature}`;

    const out = redactSecrets(`fatal: token ${token} leaked`);
    expect(out).toBe('fatal: token gh?_«redacted» leaked');
    for (const segment of [header, payload, signature]) expect(out).not.toContain(segment);

    // The URL form is redacted twice over — by shape and by the basic-auth rule — and
    // must stay clean whichever token format rides in it.
    expect(redactSecrets(`fatal: https://x-access-token:${token}@github.com/o/r`))
      .toBe('fatal: https://«redacted»@github.com/o/r');

    // The classic opaque format did not regress on the way.
    expect(redactSecrets('token ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 leaked'))
      .toBe('token gh?_«redacted» leaked');

    // RA-1955: the PAT rule was covered in `dispatch-sweep.test.ts` and not here — so the
    // copy that writes to the TRACKING ISSUE, the more exposed of the two, was the less
    // tested one. A fine-grained PAT carries `_` in its body, which is why that rule's
    // class differs from the shape rule's and has to be asserted separately.
    // The body carries an `_` — a fine-grained PAT is a 22-character prefix, an
    // underscore, then the secret. A fixture without one cannot tell this rule's
    // class from the shape rule's, and so cannot fail when the `_` is dropped.
    expect(redactSecrets('token github_pat_11ALAWJTY0abcdefghijklmn_o9PQrsTUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz012 leaked'))
      .toBe('token github_pat_«redacted» leaked');
  });

  it('reaches the hold comment a human reads', () => {
    const text = renderHoldComment(['`verify` for #1281 — gh workflow run failed: HTTP 403: Resource not accessible by integration']);
    expect(text).toContain('HTTP 403');
  });
});

describe('a blip is not a defect (RA-1203)', () => {
  it('classifies what a retry can fix, and fails closed on everything else', () => {
    for (const t of ['HTTP 502: Bad gateway', 'You have exceeded a secondary rate limit',
      'error connecting: ETIMEDOUT', 'HTTP 503', 'socket hang up', 'dial tcp: EAI_AGAIN']) {
      expect(isTransient(t), `${t} is transient`).toBe(true);
    }
    for (const p of ['HTTP 422: milestone not found', 'HTTP 403: Resource not accessible by integration',
      'HTTP 404: Not Found', "could not add label: 'sev:critical' not found", '']) {
      expect(isTransient(p), `${p} must NOT be treated as transient`).toBe(false);
    }
  });

  const w = () => ({ ...worldFrom(BRIEF(['t'])), project: '952' });
  const spyThrowing = (stderr: string) => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args.includes('--add-label') && args.includes('agent:implement')) {
        const e: Error & { ghCause?: string } = new Error(`gh issue edit failed: ${stderr}`);
        e.ghCause = stderr;
        throw e;
      }
      return '';
    };
    return { calls, run };
  };

  it('does not hold the project on a transient failure', () => {
    const before = process.exitCode;
    try {
      const { calls, run } = spyThrowing('HTTP 502: Bad gateway');
      execute(w(), [{ kind: 'dispatch', number: 5, title: 'x' }], { run });
      expect(calls.some((c) => c.includes('needs:human')),
        'a blip must not need a human to restart the project').toBe(false);
      expect(process.exitCode, 'but the tick goes RED so it is not invisible either').toBe(1);
    } finally {
      process.exitCode = before;
    }
  });

  it('still holds on a failure no retry can fix, which is RA-963', () => {
    const before = process.exitCode;
    try {
      const { calls, run } = spyThrowing('HTTP 422: milestone not found');
      execute(w(), [{ kind: 'dispatch', number: 5, title: 'x' }], { run });
      expect(calls.some((c) => c.includes('needs:human'))).toBe(true);
    } finally {
      process.exitCode = before;
    }
  });
});

describe('a terminal stop phase reaches a human (RA-1242)', () => {
  // Both phases say, in their own text, that a human owes the project a decision — and
  // delivered it as a `**Stopped:**` line inside the job summary of a run that
  // concludes GREEN, hourly, indefinitely. The observable difference between "stalled,
  // decide something" and "progressing normally" was nothing.
  const closed = (qa: Record<string, unknown>) => ({
    ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
    deploy: { state: 'deployed', tag: 'v1.0.0' },
    trackingClosed: false,
    qaIssue: { number: 9, state: 'OPEN', ...qa },
  });

  it('qa-unverifiable escalates rather than only reporting', () => {
    const out = nextActions(closed({ rounds: 1, readable: true, lastVerifiedAt: '2026-09-01T00:00:00Z' }));
    expect(out.phase).toBe('qa-unverifiable');
    expect(out.escalate?.length, 'the step summary is not a surface a human reads').toBeGreaterThan(0);
    expect(out.escalateKind).toBe('stop');
  });

  it('qa-exhausted escalates too — the subject is the class', () => {
    const out = nextActions(closed({ rounds: 2, readable: true, lastVerifiedAt: '2026-09-01T00:00:00Z' }));
    expect(out.phase).toBe('qa-exhausted');
    expect(out.escalate?.length).toBeGreaterThan(0);
    expect(out.escalateKind).toBe('stop');
  });

  it('a terminal stop does not claim an action failed', () => {
    expect(renderHoldComment(['x'], 'stop')).toContain('permanent by construction');
    expect(renderHoldComment(['x'], 'stop')).not.toContain('took an action that failed');
    expect(renderHoldComment(['x'], 'defect')).toContain('no tick can act on');
    expect(renderHoldComment(['x'])).toContain('took an action that failed');
  });

  it('the deploy permanents deliberately do NOT escalate', () => {
    // They read as permanent and are not: the phase-4 walk re-examines every containing
    // release each tick, so a later release that deploys clears them with nobody
    // editing anything. Permanent-by-construction is the admission test.
    for (const state of ['deploy-run-not-found', 'deploy-job-absent', 'deploy-failed']) {
      const out = nextActions({
        ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
        deploy: { state: state.replace('deploy-', '') === 'failed' ? 'failed' : state, tag: 'v1.0.0' },
      });
      expect(out.escalate ?? [], `${state} must stay report-only`).toEqual([]);
    }
  });
});

describe('one PR snapshot per in-flight issue per tick (RA-1207)', () => {
  it('reads the linked PRs once, so `prs` and `reviewBlocked` cannot disagree', () => {
    // Two calls under the identical guard meant two snapshots of one PR: a review
    // landing between them left the report's `awaitingReview` path (which consumes
    // `prs`) contradicting its `stalled` line (which consumes `reviewBlocked`) — a
    // self-inconsistent tick report about the very question RA-1081 exists to make
    // trustworthy. Asserted on the source because `readWorld` is the one derivation
    // here that shells out for everything it does.
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('function readWorld(project) {'), src.indexOf('// Report — what it examined'));
    // Matched on the CURRENT name: RA-2107 renamed this to `linkedPrsRead`, which
    // returns `{ prs, ok }` so a failed read is distinguishable from "no PR". An
    // earlier draft kept a `linkedPrs` wrapper and this comment described it; the
    // wrapper had no callers and was deleted, so the alternation that allowed for
    // it is gone too. The invariant is unchanged and is about the number of READS,
    // not the name — one snapshot per issue per tick.
    const reads = (fn.match(/linkedPrsRead\(i\.number\)/g) ?? []).length;
    expect(reads, 'exactly one read per issue').toBe(1);
    expect(fn, 'and both fields derive from it').toMatch(/reviewBlocked: isReviewBlocked\(prs\)/);
  });

  it('keeps the not-in-flight defaults exactly as they were', () => {
    expect(isReviewBlocked([]), 'an issue with no PRs is not blocked').toBe(false);
  });
});

describe('the WIP-cap stop names the cap that actually bound it (RA-1501)', () => {
  // This line is what a person reads when a project stops moving, and after RA-1483 it
  // could name the wrong cap — or a cause that does not exist.
  /** `n` in flight, plus one issue waiting — so the phase is always `reconcile` and
   *  the cap branch is what stops it, even at n = 0. */
  const withInFlight = (n: number) => {
    const issues = [
      ...Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, labels: ['agent:implement'] })),
      { number: n + 1, title: `t${n + 1}`, labels: [] as string[] },
    ];
    return worldFrom(BRIEF(issues.map((i) => i.title)), issues);
  };

  it('does not call the shared allowance this project\'s own cap of zero', () => {
    // `wip = min(wipPerProject, globalLeft)`, so a later project carrying issues
    // labelled on a PREVIOUS tick gets `wip: 0` with `inFlight: 2` and rendered
    // `WIP cap reached (2/0)` — "(2/0)" reading as its own cap of zero, which is
    // exactly the misdirection the shared-allowance branch was added to remove.
    const out = nextActions(withInFlight(2), { wip: 0, wipPerProject: 3, earlierProjects: 1 });
    expect(out.stopped).toContain('shared implementer allowance is spent');
    expect(out.stopped).toContain('NOT at its own cap (2/3)');
    expect(out.stopped).not.toMatch(/\(2\/0\)/);
  });

  it('does not claim an earlier project when this is the first', () => {
    // With one open project and `QA_LEAD_GLOBAL_WIP=0`, the first and only project of
    // the tick printed "an earlier project in this tick used it" as fact. The message
    // exists precisely to stop sending a reader somewhere wrong.
    const out = nextActions(withInFlight(0), { wip: 0, wipPerProject: 3, earlierProjects: 0 });
    expect(out.stopped).not.toContain('earlier project');
    expect(out.stopped).toContain('QA_LEAD_GLOBAL_WIP');
  });

  it('does not claim an earlier project when the shared allowance was never non-zero (RA-1676)', () => {
    // The residue of RA-1501. `earlierProjects` counts projects DECIDED, not allowance
    // CONSUMED, so with `QA_LEAD_GLOBAL_WIP=0` every project after the first was told
    // an earlier one spent an allowance that was never non-zero — the reader sent to
    // chase "which project took my slot" when none did. The first project was already
    // correct; this is every other position.
    const out = nextActions(withInFlight(2), { wip: 0, wipPerProject: 3, earlierProjects: 2, globalWip: 0 });
    expect(out.stopped).not.toContain('earlier project');
    expect(out.stopped).toContain('`QA_LEAD_GLOBAL_WIP` is set to 0');
    expect(out.stopped).toContain('NOT at its own cap (2/3)');
  });

  it('still blames the earlier projects when there really was an allowance to spend', () => {
    // The other half: `globalWip` must not silence the true message. Threading it in
    // with a wrong default would have swapped one wrong sentence for another.
    const out = nextActions(withInFlight(2), { wip: 0, wipPerProject: 3, earlierProjects: 2, globalWip: 3 });
    expect(out.stopped).toContain('shared implementer allowance is spent — 2 earlier project(s)');
  });

  it('names the operator kill-switch as itself', () => {
    // `QA_LEAD_WIP=0` is the obvious way to pause dispatch, and nothing is wrong.
    const out = nextActions(withInFlight(0), { wip: 0, wipPerProject: 0, earlierProjects: 0 });
    expect(out.stopped).toContain('dispatch is paused for every project');
    expect(out.stopped).toContain('QA_LEAD_WIP');
  });

  it('still says plain "WIP cap reached" when the project really is at its own cap', () => {
    const out = nextActions(withInFlight(3), { wip: 3, wipPerProject: 3, earlierProjects: 1 });
    expect(out.stopped).toMatch(/^WIP cap reached \(3\/3\)/);
  });

  it('names the shared allowance when it binds BELOW the project cap', () => {
    const out = nextActions(withInFlight(1), { wip: 1, wipPerProject: 3, earlierProjects: 1 });
    expect(out.stopped).toContain('SHARED allowance');
    expect(out.stopped).toContain('own cap of 3');
  });

  it('carries the stalled/unreviewed notes onto the shared-allowance path', () => {
    // They were dropped there — harmless while that path implied nothing in flight, and
    // not harmless now it is reachable WITH in-flight issues, since the notes are the
    // half that says whether those issues are stalled.
    const issues = [{ number: 1, title: 't1', labels: ['agent:implement'] }];
    const w = worldFrom(BRIEF(['t1']), issues) as Record<string, unknown>;
    (w.open as Array<Record<string, unknown>>)[0].reviewBlocked = true;
    const out = nextActions(w, { wip: 0, wipPerProject: 3, earlierProjects: 1 });
    expect(out.stopped).toContain('BLOCKED on a review');
  });
});

describe('a project allocated nothing says so (RA-1484)', () => {
  // The shared budget is consumed in strict numeric order with no rotation, so the last
  // project can be handed nothing several ticks running. That is a slow queue rather
  // than a stop — but unmeasured it is indistinguishable, on every surface, from a
  // project with nothing to do, which is this pipeline's `silent-absence` rule applied
  // to the new shared resource.
  // The `read` seam returns whatever `readWorld` does; these are deliberately partial
  // worlds, so the options object is cast once here — the same idiom as the RA-1447 suite.
  const runTick = (proposedPerProject: number, budget: number) => reconcileAll(['1', '2'], {
    read: () => worldFrom(BRIEF(Array.from({ length: proposedPerProject }, (_, i) => `t${i + 1}`)), []),
    onDecision: () => {},
    budget,
  } as unknown as Parameters<typeof reconcileAll>[1]);

  it('records what each project was allowed and what it took', () => {
    const out = runTick(5, 3);
    expect(out.allocations.map((a: { project: string; spent: number }) => [a.project, a.spent]))
      .toEqual([['1', 3], ['2', 0]]);
  });

  it('distinguishes STARVED from cut short, which is the whole point', () => {
    const out = runTick(5, 3);
    expect(out.allocations[0]).toMatchObject({ starved: false, cutShort: true });
    expect(out.allocations[1]).toMatchObject({ starved: true, cutShort: false });
  });

  it('says nothing when the budget never bound', () => {
    const out = runTick(1, 10);
    expect(out.allocations.every((a: { starved: boolean; cutShort: boolean }) => !a.starved && !a.cutShort)).toBe(true);
  });

  it('does not call a project with nothing to ask for STARVED (RA-1679)', () => {
    // The conflation RA-1484 was filed about, re-created by its own measurement.
    // `starved` was `budgetAtStart <= 0`, evaluated before anything about the project's
    // world — and it cannot be otherwise from inside the decision, because the budget
    // gate is `nextActionsCore`'s first statement and returns before the phase logic
    // decides whether there is any work. So on an ordinary tick every later project was
    // recorded starved alike, and the step summary asserted unmet demand about a
    // project that simply had nothing pending.
    //
    // #1 proposes 5 issues and drains the budget of 3; #2's brief proposes nothing, so
    // it reaches an exhausted budget with nothing to ask for.
    const out = reconcileAll(['1', '2'], {
      read: (project: string) => (project === '1'
        ? worldFrom(BRIEF(['t1', 't2', 't3', 't4', 't5']), [])
        // Every proposed issue already filed AND closed: nothing to file, nothing to
        // dispatch. A healthy project, not a queued one.
        : worldFrom(BRIEF(['done']), [{ number: 9, title: 'done', state: 'CLOSED' }])),
      onDecision: () => {},
      budget: 3,
    } as unknown as Parameters<typeof reconcileAll>[1]);

    expect(out.allocations[0]).toMatchObject({ starved: false, cutShort: true });
    expect(out.allocations[1]).toMatchObject({ budgetAtStart: 0, starved: false, cutShort: false, demand: 0 });
  });

  it('records HOW MUCH the starved project could not take, not just that it got nothing', () => {
    // "Allocated nothing" is what `budgetAtStart <= 0` already said. The number is what
    // makes the line a measurement of the queue rather than a restatement of the tick.
    const out = runTick(5, 3);
    expect(out.allocations[1]).toMatchObject({ starved: true, demand: 5 });
  });
});

describe('the step summary does not assert an absence it could not read (RA-1244)', () => {
  // PR RA-1239 fixed `verificationCaveat` at BOTH claim-bearing call sites; only the
  // retro's was covered. Reverting `report()`'s to its pre-RA-1240 form left all 217
  // tests passing, so the renderer was locked and this caller was not.
  const closeWorld = (qa: Record<string, unknown>) => ({
    ...worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]),
    deploy: { state: 'deployed', tag: 'v1.0.0' },
    trackingClosed: true,
    qaIssue: { number: 9, state: 'CLOSED', ...qa },
  });

  it('calls an UNREADABLE comment thread unknown, not an absence', () => {
    const w = closeWorld({ rounds: 0, readable: false });
    const text = report(w, nextActions(w));
    expect(text).toContain('UNKNOWN');
    expect(text, 'a failed read is not evidence that nobody verified').not.toContain('No verification round ran');
    expect(text, 'nor evidence that anybody did').not.toContain('phase 5 verified its acceptance criteria');
  });

  it('still says nobody ran when the thread WAS readable and empty', () => {
    const w = closeWorld({ rounds: 0, readable: true });
    const text = report(w, nextActions(w));
    expect(text).toContain('No verification round ran');
    expect(text).not.toContain('UNKNOWN');
  });

  it('claims the verification only when a round is on record', () => {
    const w = closeWorld({ rounds: 1, readable: true });
    expect(report(w, nextActions(w))).toContain('phase 5 verified its acceptance criteria');
  });

  it('never calls an unreadable thread verified, WHATEVER the round count', () => {
    // THE CONJUNCT THAT WOULD OTHERWISE BE DEAD. RA-1244 predicts it: `readable === false`
    // implies `rounds === 0` today, because `readQaRounds`'s catch is the only producer
    // of `readable: false` and it returns `rounds: 0` alongside — so the
    // `|| world.qaIssue?.readable === false` half of the suppression cannot change an
    // answer, and re-running the mutation set after RA-1659 merged confirmed it: dropping
    // that half ALONE left the suite green.
    //
    // The file's own precedent is to delete a conjunct that cannot fire (RA-1241, and the
    // digest's "a guard that cannot fire reads as protection and provides none"). Kept
    // and made LIVE instead, because deleting it makes the renderer depend on a
    // coincidence in a different function: the moment any producer returns
    // `readable: false` with a non-zero count, the suppression silently stops firing
    // and the summary claims a verification while its own next sentence says UNKNOWN.
    //
    // `report()` is a pure renderer over a world, so the property is checkable now: an
    // unreadable thread is never described as verified, whatever the count says.
    const w = closeWorld({ rounds: 1, readable: false });
    const text = report(w, nextActions(w));
    expect(text, 'the count must not override the failed read').not.toContain('phase 5 verified its acceptance criteria');
    expect(text).toContain('UNKNOWN');
  });
});

describe("the hold marker's digest is a wire format, not an implementation detail (RA-1963)", () => {
  // `holdMarker` is written into a hold comment ON THE TRACKING ISSUE and matched back
  // against comments already posted (`seen.includes(holdMarker(reasons))`). The hash is
  // therefore persisted OUTSIDE this repo, in issues this test cannot see: change what it
  // produces and every hold already sitting on an issue stops being recognised, so the
  // reconciler posts a duplicate of a comment a human has already read.
  //
  // Pinned as literals for exactly that reason. These are not "whatever the function
  // returns today" — they are the values live issues are already carrying, captured from
  // `main` before RA-1963 touched the separator and unchanged by it.
  it('hashes known inputs to the values already on live issues', () => {
    expect(holdMarker([])).toBe('<!-- qa:lead-held:45h -->');
    expect(holdMarker(['one'])).toBe('<!-- qa:lead-held:375ny9 -->');
    expect(holdMarker(['gh workflow run failed: HTTP 403', 'verify for #1281']))
      .toBe('<!-- qa:lead-held:ceb7r7 -->');
  });

  it('is order-independent, because the reasons are a set', () => {
    expect(holdMarker(['b', 'a'])).toBe(holdMarker(['a', 'b']));
  });

  it('separates the reasons with an escaped NUL, not a raw byte', () => {
    // RA-1963: the separator was a literal 0x00 in the source. NUL is the right SEPARATOR —
    // it cannot occur in a reason string — but spelling it as a raw byte made `grep`
    // classify this 3,000-line file as binary, so piped searches printed NOTHING rather
    // than their matches, and `rg` stopped searching at that offset. Three searches for
    // `redactSecrets` came back empty during RA-1945 and the function is defined here.
    //
    // `'\x00'` is the identical one-character string, which is why the digests above did
    // not move. Anything that changes the separator ITSELF breaks them, which is the
    // point — that failure belongs in this suite, not on a live tracking issue.
    const src = readFileSync(join(ROOT, 'scripts', 'lead-reconcile.mjs'), 'utf8');
    expect(src, 'a raw NUL makes the file unsearchable').not.toContain('\u0000');
    expect(src).toContain("join('\\x00')");
  });
});

describe('RA-2038 — an issue parked on a human does not occupy an implementer slot', () => {
  const IMPL = 'agent:implement';
  const issue = (n: number, o: Record<string, unknown> = {}) => ({
    number: n, title: `t${n}`, state: 'OPEN', labels: [IMPL], order: n, ...o,
  });

  it('linkedPrsRead reports ok:false when the read throws — the arm that only runs on a bad day', () => {
    // WITHOUT THIS, `ok` IS UNTESTED. Mutating `ok: false` to `ok: true` passed a
    // full green tier: `isParkedOnHuman` takes `prOk` as an INPUT, so the decision
    // was covered and the reader producing it was not. That is RA-2106's finding one
    // level up, and it is why this uses the injectable `json` seam (RA-1061).
    const boom = () => { throw new Error('gh exploded'); };
    expect(linkedPrsRead(1, { json: boom })).toEqual({ prs: [], ok: false });

    // And the success path still reports ok:true with the PRs.
    const fake = (args: string[]) => (args[1] === 'view' && args[0] === 'issue'
      ? { closedByPullRequestsReferences: [{ number: 7 }] }
      : { number: 7, state: 'OPEN', headRefOid: 'abc', commits: [], reviews: [], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
    const good = linkedPrsRead(1, { json: fake as never });
    expect(good.ok).toBe(true);
    expect(good.prs.map((p: { number: number }) => p.number)).toEqual([7]);
    expect(good.prs[0].conflicting, 'mergeability is normalised onto the PR (#1722)').toBe(false);
  });

  it('a PR read that forgot to ask about mergeability REDS the tick, it does not degrade (RA-1722)', () => {
    // THE WHOLE POINT OF THE THROW. Every other failure in `linkedPrsRead` becomes
    // `ok: false` — a warning line the tick already prints for 502s and deleted
    // branches — and a trimmed `--json` list arriving on that line would leave the
    // conflict detector answering "clear" for every PR while looking like a bad day.
    // So the caller's defect is a different class and is re-thrown past the degrade.
    const trimmed = (args: string[]) => (args[1] === 'view' && args[0] === 'issue'
      ? { closedByPullRequestsReferences: [{ number: 7 }] }
      : { number: 7, state: 'OPEN', headRefOid: 'abc', commits: [], reviews: [] });
    expect(() => linkedPrsRead(1, { json: trimmed as never })).toThrow(ConflictFieldsUnread);
  });

  it('marks a conflicting PR so every consumer reads one answer (RA-1722)', () => {
    const dirty = (args: string[]) => (args[1] === 'view' && args[0] === 'issue'
      ? { closedByPullRequestsReferences: [{ number: 7 }] }
      : { number: 7, state: 'OPEN', headRefOid: 'abc', commits: [], reviews: [], mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' });
    expect(linkedPrsRead(1, { json: dirty as never }).prs[0].conflicting).toBe(true);
  });

  it('the DERIVATION fails closed three ways (RA-2106/RA-2107)', () => {
    // The five tests below set `parkedOnHuman` as a literal, which tests the
    // ACCOUNTING and not the decision that produces it. This tests the decision.
    const base = { labels: [IMPL], state: 'OPEN', hasPr: false, prOk: true, laneState: 'awaiting-human' };
    expect(isParkedOnHuman(base), 'the ordinary parked shape').toBe(true);

    // 1. A live PR: work is happening, whatever the comments say.
    expect(isParkedOnHuman({ ...base, hasPr: true })).toBe(false);
    // 2. An UNREADABLE PR list is not evidence of no PR (RA-2107). Before this,
    //    `linkedPrs` caught its error and returned [], so a `gh` blip on an issue
    //    with a live PR read as parked and freed its slot.
    expect(isParkedOnHuman({ ...base, prOk: false })).toBe(false);
    // 3. An unreadable comment list leaves the lane unknown; keep the slot.
    expect(isParkedOnHuman({ ...base, laneState: null })).toBe(false);

    // The label needs no read at all, and outranks everything.
    expect(isParkedOnHuman({ labels: ['qa:needs-info'], state: 'OPEN', prOk: false })).toBe(true);
    // Not dispatched, or not open => never occupying a slot to begin with.
    expect(isParkedOnHuman({ ...base, labels: [] })).toBe(false);
    expect(isParkedOnHuman({ ...base, state: 'CLOSED' })).toBe(false);
    // `human-held` is parked too (RA-2108) — `classify` sets it when a human replied
    // to the SWEEP, and its own comment says "Held for a human on purpose". RA-2038
    // freed only `awaiting-human`, so its bug survived in the state named for its
    // condition: the sweep stops dispatching and the slot is held forever.
    // Once STALE (RA-2112) — a fresh `human-held` may be a human replying mid-run.
    expect(isParkedOnHuman({ ...base, laneState: 'human-held', laneLastAt: '2020-01-01T00:00:00Z' })).toBe(true);

    // The sweep's two ACTIONABLE states are not parked — something is about to run.
    expect(isParkedOnHuman({ ...base, laneState: 'answered' })).toBe(false);
    expect(isParkedOnHuman({ ...base, laneState: 'never-ran' })).toBe(false);
    expect(isParkedOnHuman({ ...base, laneState: 'in-flight' })).toBe(false);
    expect(isParkedOnHuman({ ...base, laneState: 'has-pr' })).toBe(false);
  });

  it('occupiesSlot: the label alone is not enough — parked issues are excluded', () => {
    // The whole change in one assertion. `agent:implement` does two jobs and only
    // one of them is "an agent is running".
    expect(occupiesSlot(issue(1))).toBe(true);
    expect(occupiesSlot(issue(2, { parkedOnHuman: true }))).toBe(false);
    // Not the label => never a slot, parked or not.
    expect(occupiesSlot(issue(3, { labels: [] }))).toBe(false);
    expect(occupiesSlot(issue(4, { labels: [], parkedOnHuman: true }))).toBe(false);
  });

  it('frees the slot: a project at its cap on a parked issue dispatches again', () => {
    const base = worldFrom(BRIEF(['a', 'b']), [
      { number: 90, title: 'a', state: 'OPEN', labels: [IMPL] },
      { number: 91, title: 'b', state: 'OPEN', labels: [] },
    ]);
    const held = { ...base, project: '1292' };
    // Before: one in flight, cap 1, nothing moves — the RA-1292 shape exactly.
    expect(nextActions(held, { wip: 1, wipPerProject: 1 }).actions).toEqual([]);

    // After: the same world with RA-90 parked on a human.
    const freed = { ...held, open: held.open.map((i: Record<string, unknown>) => (i.number === 90 ? { ...i, parkedOnHuman: true } : i)) };
    const r = nextActions(freed, { wip: 1, wipPerProject: 1 });
    expect(r.actions.map((a: { number: number }) => a.number), 'the UNPARKED issue is dispatched').toEqual([91]);
  });

  it('SAFETY: freeing the slot must not re-dispatch the parked issue itself', () => {
    // The property the whole design turns on. `agent:implement` is also what stops
    // the reconciler re-dispatching, and a bail re-dispatched just bails again at
    // ~$23 a time — so the slot is freed WITHOUT re-arming the dispatch. If this
    // ever fails, RA-2038 has traded a starved queue for a money leak.
    const world = {
      ...worldFrom(BRIEF(['a']), [{ number: 92, title: 'a', state: 'OPEN', labels: [IMPL] }]),
      project: '284',
    };
    const parked = { ...world, open: world.open.map((i: Record<string, unknown>) => ({ ...i, parkedOnHuman: true })) };
    const r = nextActions(parked, { wip: 3, wipPerProject: 3 });
    expect(r.actions.map((a: { number: number }) => a.number)).not.toContain(92);
  });

  it('reports the exclusion, so a freed slot is not silent', () => {
    // A slot freed silently is indistinguishable from one never taken, and naming
    // the issue is what makes a FALSE positive findable.
    const world = {
      ...worldFrom(BRIEF(['a', 'b']), [
        { number: 93, title: 'a', state: 'OPEN', labels: [IMPL] },
        { number: 94, title: 'b', state: 'OPEN', labels: [IMPL] },
      ]),
      project: '1291',
    };
    const mixed = { ...world, open: world.open.map((i: Record<string, unknown>) => (i.number === 93 ? { ...i, parkedOnHuman: true } : i)) };
    const r = nextActions(mixed, { wip: 1, wipPerProject: 1 });
    expect(r.stopped, 'the cap counts only the unparked one').toContain('(1/1)');
    expect(r.stopped).toContain('#93');
    expect(r.stopped).toMatch(/parked on a human/);
    expect(r.stopped).not.toContain('#94');
    // THE SEAM, asserted here and not only in the notes-present test below — the
    // two are a pair. This one is the no-notes path, where the stop sentence does
    // not punctuate itself, so the note must supply the stop. Unasserted, a fix
    // that dropped it read as green (RA-2111 review).
    expect(r.stopped, 'the note is a new sentence').toMatch(/\(1\/1\)\. 1 issue/);
  });

  it('supplies its own stop on the kill-switch branch too', () => {
    // `dispatch is paused … \`QA_LEAD_WIP\` is 0` is the worst place to lose the
    // separator: `is 0 1 issue(s)` reads as a number pair, on the exact line a
    // person checks when a project has stopped moving.
    const world = {
      ...worldFrom(BRIEF(['a']), [{ number: 97, title: 'a', state: 'OPEN', labels: [IMPL] }]),
      project: '1291',
    };
    const parked = { ...world, open: world.open.map((i: Record<string, unknown>) => ({ ...i, parkedOnHuman: true })) };
    const r = nextActions(parked, { wip: 0, wipPerProject: 0 });
    expect(r.stopped).toMatch(/QA_LEAD_WIP` is 0\. 1 issue/);
    expect(r.stopped).not.toMatch(/is 0 1 issue/);
  });

  it('joins cleanly when there are notes AND a parked issue', () => {
    // The combination the first separator fix did not cover (RA-2111 review): both
    // `notes` entries already end in `.`, so a fixed `.` produced
    // `…re-firing repeats it.. 1 issue(s) carry…`. The separator keys on the
    // preceding text now, so a note that punctuates itself gets no second stop.
    const world = {
      ...worldFrom(BRIEF(['a', 'b']), [
        { number: 95, title: 'a', state: 'OPEN', labels: [IMPL] },
        { number: 96, title: 'b', state: 'OPEN', labels: [IMPL] },
      ]),
      project: '1291',
    };
    const mixed = {
      ...world,
      open: world.open.map((i: Record<string, unknown>) => (i.number === 95
        ? { ...i, parkedOnHuman: true }
        : { ...i, reviewBlocked: true })),
    };
    const r = nextActions(mixed, { wip: 1, wipPerProject: 1 });
    expect(r.stopped, 'a note is present').toMatch(/BLOCKED on a review/);
    expect(r.stopped, 'and the parked note too').toContain('#95');
    expect(r.stopped, 'with no doubled full stop').not.toMatch(/\.\./);
  });

  it('the shared allowance is not spent on parked issues either (reconcileAll)', () => {
    // THE MEASURED RA-1292 SHAPE, and the assertion is a BEFORE/AFTER on one world.
    //
    // The first version of this test asserted the wrong thing and is worth
    // recording: it gave each earlier project a parked issue AND a spare eligible
    // one, so freeing the slots let those projects dispatch real work — which spent
    // the shared allowance legitimately and starved project 4 anyway. That is
    // correct behaviour, not a bug: a freed slot filled by a running agent is a
    // slot in use.
    //
    // The shape that actually starved RA-1292 on 2026-09-18 is narrower: the earlier
    // projects' parked issue was their ONLY eligible work (RA-284's RA-66 is its only
    // open issue; RA-1019's dependents are all blocked behind RA-1694). So the slot was
    // held and never used, by three projects at once, and the fourth got nothing.
    const onlyParked = (n: number, parked: boolean) => {
      const issues = [{ number: n * 100, title: 't0', state: 'OPEN', labels: [IMPL], order: 0, parkedOnHuman: parked }];
      return { ...worldFrom(BRIEF(['t0'])), project: String(n), all: issues, open: issues, filed: issues };
    };
    const target = () => {
      const issues = [{ number: 400, title: 't0', state: 'OPEN', labels: [], order: 0 }];
      return { ...worldFrom(BRIEF(['t0'])), project: '4', all: issues, open: issues, filed: issues };
    };
    const runWith = (parked: boolean) => {
      const worlds: Record<string, unknown> = {
        1: onlyParked(1, parked), 2: onlyParked(2, parked), 3: onlyParked(3, parked), 4: target(),
      };
      // Same cast the `run` helper above uses: these are deliberately partial
      // worlds, so the options object is widened once rather than each field.
      const out = reconcileAll(['1', '2', '3', '4'], {
        read: (p: string) => worlds[p], onDecision: () => {}, budget: 6, globalWip: 3, wipPerProject: 3,
      } as unknown as Parameters<typeof reconcileAll>[1]);
      return out.decisions.find((d: { project: string }) => d.project === '4')!.decision;
    };

    // Before: three held-but-idle slots spend the whole shared allowance.
    const before = runWith(false);
    expect(before.actions).toEqual([]);
    expect(before.stopped).toMatch(/shared implementer allowance is spent/);

    // After: the slots are not occupied, so the allowance reaches project 4.
    expect(runWith(true).actions.map((a: { number: number }) => a.number)).toEqual([400]);
  });
});

/**
 * RA-1722 — a conflicting PR dispatches no `pull_request` events, so BOTH churn arms in
 * this file raise events GitHub cannot deliver, and the WIP-cap note describes the
 * result as an unanswered review or an unreviewed head depending on what landed last.
 *
 * PR RA-1708 sat in exactly that state for 36 hours: 12 remove/add pairs of
 * `agent:revise`, 25 label events, zero workflow runs, and a tick reporting the
 * documented remedy as applied every hour.
 */
describe('neither churn arm fires at a PR no event can reach (RA-1722)', () => {
  const OLD = new Date(Date.now() - 5 * 3600e3).toISOString();
  const REVIEWED = new Date(Date.now() - 4.5 * 3600e3).toISOString();
  const HEAD = 'cafed00dbeef';
  const noRuns = () => [];
  const worldWith = (prs: unknown[]) => world({ open: [{ ...issue(9, ['agent:implement']), prs }] });
  /** A world whose phase is `reconcile` and whose WIP cap is reached, built the way
   *  `withInFlight` above does — a hand-made `world({ open })` has no brief behind it,
   *  so `phaseOf` never reaches the cap branch and `stopped` comes back undefined. */
  const atCapWith = (prs: unknown[], over: Record<string, unknown> = {}) => {
    const w = worldFrom(BRIEF(['t1', 't2']), [
      { number: 55, title: 't1', labels: ['agent:implement'] },
      { number: 56, title: 't2', labels: [] },
    ]);
    Object.assign(w.open[0] as Record<string, unknown>, { prs }, over);
    return w;
  };

  const blockedPr = (over = {}) => ({
    number: 55, state: 'OPEN', headSha: HEAD, headPushedAt: OLD,
    reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD, submittedAt: REVIEWED }], ...over,
  });
  const unreviewedPr = (over = {}) => ({
    number: 56, state: 'OPEN', headSha: HEAD, headPushedAt: OLD, reviews: [], ...over,
  });

  it('reviseRecovery reports the rebase instead of churning `agent:revise`', () => {
    const { churn, noted } = reviseRecovery(worldWith([blockedPr({ conflicting: true })]), { runsFor: noRuns });
    expect(churn).toEqual([]);
    expect(noted).toHaveLength(1);
    expect(noted[0].why).toBe(CONFLICT_WHY);
  });

  it('reviewRecovery reports the rebase instead of churning `review:please`', () => {
    const { churn, noted } = reviewRecovery(worldWith([unreviewedPr({ conflicting: true })]), { runsFor: noRuns });
    expect(churn).toEqual([]);
    expect(noted).toHaveLength(1);
    expect(noted[0].why).toBe(CONFLICT_WHY);
  });

  it('both still churn the same PRs when they are clean — the controls', () => {
    // Without these, "churns nothing" is satisfied by a gate that blocks every PR,
    // which is the inertness RA-1594 measured one lane over.
    expect(reviseRecovery(worldWith([blockedPr()]), { runsFor: noRuns }).churn).toHaveLength(1);
    expect(reviewRecovery(worldWith([unreviewedPr()]), { runsFor: noRuns }).churn).toHaveLength(1);
  });

  it('the WIP-cap note says REBASE, and says it supersedes the other two lines', () => {
    // This line is what a person reads when a project stops moving. A conflicting PR
    // is normally in one of the other two lists as well — it is both unanswered and
    // unreviewed, because neither CI nor the Reviewer ever ran — so the rebase has to be
    // named and has to be named first, or the reader is sent to a remedy that cannot
    // work.
    // `reviewBlocked` is what `readWorld` derives for this same PR — a conflicting PR
    // carrying an unanswered changes-request is in BOTH lists, which is the collision
    // the ordering is about.
    const out = nextActions(atCapWith([blockedPr({ conflicting: true })], { reviewBlocked: true }), { wip: 1 });
    expect(out.stopped).toMatch(/blocked on a REBASE/);
    expect(out.stopped).toMatch(/#55/);
    expect(out.stopped).toMatch(/RA-1722/);
    // Ordered ahead of the review lines it supersedes.
    const stopped = out.stopped as string;
    expect(stopped.indexOf('REBASE')).toBeLessThan(stopped.indexOf('BLOCKED on a review'));
  });

  it('says nothing about a rebase when every in-flight PR is clean', () => {
    expect(nextActions(atCapWith([blockedPr()]), { wip: 1 }).stopped).not.toMatch(/REBASE/);
  });

  it('ignores a conflicting PR that is already closed', () => {
    expect(nextActions(atCapWith([blockedPr({ conflicting: true, state: 'CLOSED' })]), { wip: 1 }).stopped)
      .not.toMatch(/REBASE/);
  });
});


describe('RA-2112 — `human-held` frees a slot only once it is stale', () => {
  const IMPL = 'agent:implement';
  const NOW = Date.parse('2026-09-24T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW - h * 3600e3).toISOString();
  const base = { labels: [IMPL], state: 'OPEN', hasPr: false, prOk: true, now: NOW, staleHours: 48 };

  it('a human reply DURING a run keeps the slot — the reachable RA-2112 shape', () => {
    // Sweep re-dispatched, the implementer is running (it comments only when it
    // finishes), a human answers the sweep's invitation an hour later: `classify` says
    // `human-held`, and freeing the slot here would run QA_LEAD_WIP + 1 implementers.
    expect(isParkedOnHuman({ ...base, laneState: 'human-held', laneLastAt: hoursAgo(1) })).toBe(false);
    expect(isParkedOnHuman({ ...base, laneState: 'human-held', laneLastAt: hoursAgo(47) })).toBe(false);
  });

  it('…and still frees it once nothing has happened for the window — RA-2038 is not reintroduced', () => {
    expect(isParkedOnHuman({ ...base, laneState: 'human-held', laneLastAt: hoursAgo(49) })).toBe(true);
  });

  it('an undated last word is not evidence of age', () => {
    expect(isParkedOnHuman({ ...base, laneState: 'human-held', laneLastAt: null })).toBe(false);
    expect(isParkedOnHuman({ ...base, laneState: 'human-held', laneLastAt: 'garbage' })).toBe(false);
  });

  it('`awaiting-human` is unchanged — `classify` already aged it', () => {
    expect(isParkedOnHuman({ ...base, laneState: 'awaiting-human', laneLastAt: null })).toBe(true);
  });

  it('laneStateOf carries the last word’s time from `classify`, and null on a failed read', () => {
    const classify = () => ({ state: 'human-held', last: { createdAt: '2026-09-20T00:00:00Z' } });
    expect(laneStateOf(1, { comments: () => [], classify: classify as never })).toEqual({ state: 'human-held', lastAt: '2026-09-20T00:00:00Z' });
    const boom = () => { throw new Error('502'); };
    expect(laneStateOf(1, { comments: boom as never })).toEqual({ state: null, lastAt: null });
  });

  it('reads the SAME window the sweep ages `awaiting-human` with', () => {
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bSTALE_HOURS\b[^}]*\} from '\.\/dispatch-sweep\.mjs'/);
    expect(src).toMatch(/staleHours = STALE_HOURS/);
  });
});

describe('RA-1301 — an item a human owes an action does not park its project', () => {
  const IMPL = 'agent:implement';

  it('is never dispatched, and the rest of the project proceeds', () => {
    const w = worldFrom(BRIEF(['console work', 'code work']), [
      { number: 40, title: 'console work', labels: [HUMAN_ACTION] },
      { number: 41, title: 'code work' },
    ]);
    expect(phaseOf(w), 'not the project-wide `blocked`').toBe('reconcile');
    const r = nextActions(w, { wip: 3 });
    expect(r.actions.map((a: { number: number }) => a.number)).toEqual([41]);
  });

  it('says what it is waiting for by name when it is all that is left', () => {
    const w = worldFrom(BRIEF(['console work', 'code work']), [
      { number: 40, title: 'console work', labels: [HUMAN_ACTION] },
      { number: 41, title: 'code work', state: 'CLOSED' },
    ]);
    const r = nextActions(w, { wip: 3 });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/#40 awaits a HUMAN action/);
  });

  it('`qa:needs-info` still parks the whole project — that meaning is unchanged', () => {
    const w = worldFrom(BRIEF(['a', 'b']), [
      { number: 40, title: 'a', labels: ['qa:needs-info'] },
      { number: 41, title: 'b' },
    ]);
    expect(phaseOf(w)).toBe('blocked');
  });

  it('never occupies a WIP slot, even if someone labelled it for an implementer', () => {
    expect(isParkedOnHuman({ labels: [IMPL, HUMAN_ACTION], state: 'OPEN', hasPr: false, prOk: true, laneState: null })).toBe(true);
  });

  it('the label exists under this exact name', () => {
    expect(HUMAN_ACTION).toBe('qa:human-action');
  });
});

describe('RA-1781 — an item awaiting a split is never dispatched, and does not park its project', () => {
  it('is skipped by dispatch while the rest of the project proceeds', () => {
    const w = worldFrom(BRIEF(['too big', 'code work']), [
      { number: 40, title: 'too big', labels: [SPLIT_LABEL] },
      { number: 41, title: 'code work' },
    ]);
    expect(phaseOf(w), 'not the project-wide `blocked` that `qa:needs-info` means').toBe('reconcile');
    expect(nextActions(w, { wip: 3 }).actions.map((a: { number: number }) => a.number)).toEqual([41]);
  });

  it('says what it is waiting for, and how to re-deliver it, when it is all that is left', () => {
    const w = worldFrom(BRIEF(['too big', 'code work']), [
      { number: 40, title: 'too big', labels: [SPLIT_LABEL] },
      { number: 41, title: 'code work', state: 'CLOSED' },
    ]);
    const r = nextActions(w, { wip: 3 });
    expect(r.actions).toEqual([]);
    expect(r.stopped).toMatch(/#40 awaits a SPLIT \(`qa:needs-split`\)/);
    expect(r.stopped).toContain('agent-lead-split.yml');
  });

  it('re-delivers a dead split through nextActions, without spending the budget (RA-2406)', () => {
    const w = worldFrom(BRIEF(['too big', 'code work']), [
      { number: 40, title: 'too big', labels: [SPLIT_LABEL] },
      { number: 41, title: 'code work' },
    ]);
    (w.open.find((i) => i.number === 40) as Record<string, unknown>).split =
      { labeledAt: ['2026-09-01T00:00:00Z'], prs: [] };
    const r = nextActions(w, { wip: 3, budgetLeft: 1, now: Date.parse('2026-09-02T00:00:00Z') });
    expect(r.actions.map((a: { kind: string; number: number }) => `${a.kind}:${a.number}`)).toEqual(['split-churn:40', 'dispatch:41']);
    expect(chargeable(r.actions)).toBe(1);
  });
});

describe('RA-1971 — the adopt arm applies the brief’s labels too', () => {
  const w = () => ({ ...worldFrom(BRIEF(['t'])), project: '952', briefPath: 'docs/projects/952.md' });
  const runner = (labels: string[]) => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ body: 'b\n\n<!-- qa:project 952 -->', milestone: { title: 'Production Ready' }, labels: labels.map((name) => ({ name })) });
      }
      return '';
    };
    return { calls, run };
  };
  const adopt = (labels: string[]) => ({ kind: 'adopt', number: 1701, title: 'C3', milestone: 'Production Ready', labels });

  it('ADDS the declared labels the issue lacks, never replacing', () => {
    const { calls, run } = runner(['sev:medium', 'follow-up', 'agent:reviewer']);
    execute(w(), [adopt(['enhancement'])], { run });
    const edit = calls.find((c) => c.includes('--add-label'));
    expect(edit, 'the adopt arm must apply `**Labels:**`').toBeTruthy();
    expect(edit).toContain('enhancement');
    expect(calls.some((c) => c.includes('--remove-label')), 'provenance is never erased').toBe(false);
  });

  it('does not re-add a label the issue already carries', () => {
    const { calls, run } = runner(['enhancement']);
    execute(w(), [adopt(['enhancement'])], { run });
    expect(calls.some((c) => c.includes('--add-label'))).toBe(false);
  });

  it('never dispatches by adoption — `agent:implement` is the dispatch arm’s', () => {
    const { calls, run } = runner([]);
    execute(w(), [adopt(['agent:implement', 'enhancement'])], { run });
    const edit = calls.find((c) => c.includes('--add-label'))!;
    expect(edit).toContain('enhancement');
    expect(edit).not.toContain('agent:implement');
  });

  it('names the provenance labels the brief did not declare — the RA-1701 shape', () => {
    expect(adoptedProvenance(['sev:medium', 'follow-up', 'agent:reviewer', 'bug'], ['enhancement']))
      .toEqual(['sev:medium', 'follow-up', 'agent:reviewer']);
    expect(adoptedProvenance(['sev:high'], ['sev:high']), 'a declared one is the brief’s own call').toEqual([]);
    expect(adoptedProvenance(['bug', 'enhancement'], [])).toEqual([]);
  });
});

describe('RA-1783 — membership is not closure: the project WORK gates, carried-out members are reported', () => {
  const FU = (number: number, sev: string, extra: string[] = []) =>
    ({ number, title: `follow-up ${number}`, labels: ['follow-up', 'agent:reviewer', sev, ...extra] });

  it('a sev:low / sev:medium follow-up does NOT hold a project whose brief work is closed', () => {
    const w = worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }, FU(2, 'sev:low'), FU(3, 'sev:medium')]);
    expect(phaseOf(w), 'past reconcile, into the deploy watch').not.toBe('reconcile');
    expect(carriedOut(w).map((i: { number: number }) => i.number)).toEqual([2, 3]);
  });

  it('a sev:high or sev:critical member DOES hold it — and is not this tick’s to dispatch', () => {
    for (const sev of ['sev:high', 'sev:critical']) {
      const w = worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }, FU(2, sev)]);
      expect(phaseOf(w), sev).toBe('reconcile');
      const r = nextActions(w, { wip: 3 });
      expect(r.actions, sev).toEqual([]);
      expect(r.stopped).toMatch(new RegExp(`#2 is a \`${sev}\` member outside the decomposition — it holds the project open`));
    }
  });

  it('dispatches the brief’s work and a phase-5 finding, never a carried-out member', () => {
    const w = worldFrom(BRIEF(['a']), [
      { number: 1, title: 'a' },
      FU(2, 'sev:low'),
      { number: 3, title: 'AC failed', labels: [SPEC_FINDING, 'sev:medium'], body: `x ${FINDING_ANCHOR} y` },
      // The general explorer applies the same label — without the phase-5 anchor it is
      // an inherited bug, carried out, not the project's work (RA-1783 review).
      { number: 4, title: 'swept bug', labels: [SPEC_FINDING, 'sev:low'], body: 'environment: staging' },
    ]);
    expect(nextActions(w, { wip: 3 }).actions.map((a: { number: number }) => a.number)).toEqual([1, 3]);
  });

  it('a carried-out member in flight does not spend the project’s WIP', () => {
    const w = worldFrom(BRIEF(['a']), [
      { number: 1, title: 'a' },
      ...[2, 3, 4].map((n) => ({ ...FU(n, 'sev:low'), labels: ['follow-up', 'sev:low', 'agent:implement'] })),
    ]);
    expect(nextActions(w, { wip: 3 }).actions.map((a: { number: number }) => a.number)).toEqual([1]);
  });

  it('openGatingWork and blockedOf are the one definition phaseOf and readWorld share', () => {
    const p = parseProposed(BRIEF(['a']));
    const open = [
      { number: 1, title: 'a', labels: ['qa:needs-info'] },
      { number: 2, title: 'x', labels: ['sev:low', 'qa:needs-info'] },
      { number: 3, title: 'y', labels: ['sev:high', 'blocked'] },
      { number: 4, title: 'v', labels: ['qa:verify'] },
    ];
    expect(openGatingWork(open, p).map((i: { number: number }) => i.number)).toEqual([1, 3]);
    expect(blockedOf(open, p).map((i: { number: number }) => i.number)).toEqual([1, 3]);
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    expect(src).toContain('const blocked = blockedOf(open, proposed);');
    expect(src.match(/const openWork = openGatingWork\(open, proposed\);/g)).toHaveLength(2);
  });

  it('a carried-out member is not named as holding anything when nothing is eligible', () => {
    const w = worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', labels: ['agent:implement'] }, FU(2, 'sev:low')]);
    const r = nextActions(w, { wip: 3 });
    expect(r.actions).toEqual([]);
    expect(r.stopped ?? '').not.toContain('#2');
  });

  it('an adopted issue is the project’s work by its `Closes #N`, whatever its own title', () => {
    const brief = ['## Decomposition', '', '### Issue A — the item', '**Milestone:** Product Backlog · **Closes #9**', '', 'body', ''].join('\n');
    expect(isProjectWork({ number: 9, title: 'its own title', labels: [] }, parseProposed(brief))).toBe(true);
    expect(inDecomposition({ number: 8, title: 'its own title', labels: [] }, parseProposed(brief))).toBe(false);
  });

  it('a carried-out member closing does not spend a phase-5 round', () => {
    const base = worldFrom(BRIEF(['a']), [
      { number: 1, title: 'a', state: 'CLOSED', closedAt: '2026-08-26T18:00:00Z' },
      { ...FU(2, 'sev:low'), state: 'CLOSED', closedAt: '2026-08-27T18:00:00Z' },
    ]);
    const w = { ...base, deploy: { state: 'deployed', tag: 'v1' }, qaIssue: { number: 2000, state: 'OPEN', rounds: 1, lastVerifiedAt: '2026-08-26T19:00:00Z' } };
    expect(phaseOf(w)).not.toBe('verify');
    // …while a gating member closing after the last round still re-verifies.
    const g = { ...w, all: [...w.all, { number: 4, title: 'x', state: 'CLOSED', closedAt: '2026-08-27T18:00:00Z', labels: ['sev:high'] }] };
    expect(phaseOf(g)).toBe('verify');
  });

  it('readWorld waits on staging only for gating members’ merges', () => {
    const src = readFileSync(join(ROOT, 'scripts/lead-reconcile.mjs'), 'utf8');
    expect(src).toMatch(/readDeploy\(all\.filter\(\(i\) => gatesClosure\(i, proposed\)\)\)/);
  });

  it('the tick report names each carried-out member by number and severity', () => {
    const w = worldFrom(BRIEF(['a']), [{ number: 1, title: 'a' }, FU(1452, 'sev:low')]);
    const text = report(w, { phase: 'reconcile', actions: [], stopped: null });
    expect(text).toContain('| carried out — open members outside the project\'s work, not holding it open (RA-1783) | 1 |');
    expect(text).toContain('- #1452 `sev:low` — follow-up 1452');
  });

  it('the retro lists what it left open at close — and says "none" when it left nothing', () => {
    const a = { kind: 'close-project', number: 42, tag: 'v1.2.3' };
    const left = worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }, FU(1452, 'sev:medium')]);
    expect(retro(left, a)).toContain('### Left open at close');
    expect(retro(left, a)).toContain('- #1452 `sev:medium` — follow-up 1452');
    const none = worldFrom(BRIEF(['a']), [{ number: 1, title: 'a', state: 'CLOSED' }]);
    expect(retro(none, a)).toContain('None — every member of this project is closed.');
  });
});

describe('RA-1783 — the `project:<n>` label mirrors the marker, and the tick is its only writer', () => {
  const MARK = '\n\n<!-- qa:project 952 -->';
  const w = (o: Record<string, unknown> = {}) => ({
    ...worldFrom(BRIEF(['a', 'b']), [
      { number: 1, title: 'a', labels: ['project:952'] },
      { number: 2, title: 'b' },
    ]),
    project: '952', briefPath: 'docs/projects/952.md',
    knownLabels: new Set(['project:952']),
    labelled: [{ number: 1, body: `a${MARK}` }, { number: 7, body: 'marker lost\n<!-- qa:project 952 -->\nappended below' }],
    ...o,
  });

  it('PARITY: a member missing the label is added; a holder that is not a member is removed', () => {
    const m = labelMirror(w());
    expect(m.label).toBe(projectLabel('952'));
    expect(m.add).toEqual([2]);
    expect(m.remove, 'the marker is not the LAST line on #7 (#1066), so it is not a member').toEqual([7]);
    expect(m.create).toBe(false);
  });

  it('agreeing marker and label propose nothing', () => {
    const m = labelMirror(w({ labelled: [{ number: 1, body: `a${MARK}` }, { number: 2, body: `b${MARK}` }], all: [
      { number: 1, labels: ['project:952'] }, { number: 2, labels: ['project:952'] }] }));
    expect([m.add, m.remove, m.create]).toEqual([[], [], false]);
  });

  it('creates the label when it does not exist, and removes nothing it could not read', () => {
    const m = labelMirror(w({ knownLabels: new Set(), labelled: undefined, all: [{ number: 2, labels: [] }] }));
    expect(m.create).toBe(true);
    expect(m.remove).toEqual([]);
  });

  it('an issue HOLDING the label proves it exists, past `repoLabels`’ capped list', () => {
    expect(labelMirror(w({ knownLabels: new Set() })).create).toBe(false);
  });

  it('the per-tick cap falls back to 10 on anything but a positive integer', () => {
    expect([mirrorCap('5'), mirrorCap(undefined), mirrorCap(''), mirrorCap('-1'), mirrorCap('ten'), mirrorCap('0'), mirrorCap('2.5')]).toEqual([5, 10, 10, 10, 10, 10, 10]);
  });

  it('mirrors nothing for a project whose brief has not merged', () => {
    expect(labelMirror(w({ briefMerged: false }))).toMatchObject({ create: false, add: [], remove: [] });
  });

  it('caps the edits per tick and says how many it deferred', () => {
    const many = Array.from({ length: 13 }, (_, k) => ({ number: 100 + k, labels: [] }));
    const m = labelMirror(w({ all: many, labelled: [] }), { cap: 10 });
    expect(m.add).toHaveLength(10);
    expect(m.deferred).toBe(3);
  });

  it('mirrorLabels creates FIRST, then edits; a failed create edits nothing and reports not-ready', () => {
    const calls: string[][] = [];
    const ok = mirrorLabels(w(), { label: 'project:952', create: true, add: [2], remove: [7], deferred: 0 }, { run: (a: string[]) => { calls.push(a); return ''; } });
    expect(ok).toBe(true);
    expect(calls[0].slice(0, 3)).toEqual(['label', 'create', 'project:952']);
    expect(calls[1]).toEqual(expect.arrayContaining(['issue', 'edit', '2', '--add-label', 'project:952']));
    expect(calls[2]).toEqual(expect.arrayContaining(['issue', 'edit', '7', '--remove-label', 'project:952']));
    const none: string[][] = [];
    const bad = mirrorLabels(w(), { label: 'project:952', create: true, add: [2], remove: [], deferred: 0 }, { run: (a: string[]) => { none.push(a); if (a[0] === 'label') throw new Error('HTTP 403'); return ''; } });
    expect(bad).toBe(false);
    expect(none).toHaveLength(1);
  });

  it('the file arm applies the label at creation — only once it is known to exist', () => {
    const file = { kind: 'file', title: 'c', body: 'b', milestone: 'Product Backlog', labels: [] };
    const seen: string[][] = [];
    const run = (a: string[]) => { seen.push(a); return 'https://x/issues/1'; };
    execute({ ...w(), labelReady: true }, [file], { run });
    expect(seen[0]).toEqual(expect.arrayContaining(['--label', 'project:952']));
    seen.length = 0;
    execute({ ...w(), labelReady: false }, [file], { run });
    expect(seen[0]).not.toContain('project:952');
  });

  it('the adopt arm adds it with the brief’s labels', () => {
    const calls: string[][] = [];
    const run = (a: string[]) => {
      calls.push(a);
      if (a[0] === 'issue' && a[1] === 'view') return JSON.stringify({ body: `b${MARK}`, milestone: { title: 'Product Backlog' }, labels: [] });
      return '';
    };
    execute({ ...w(), labelReady: true }, [{ kind: 'adopt', number: 9, title: 'a', milestone: 'Product Backlog', labels: ['enhancement'] }], { run });
    expect(calls.find((c) => c.includes('--add-label'))).toEqual(expect.arrayContaining(['--add-label', 'project:952', '--add-label', 'enhancement']));
  });

  it('applyDecision runs the mirror BEFORE the actions, so the file arm finds the label', () => {
    const calls: string[][] = [];
    const run = (a: string[]) => { calls.push(a); return 'https://x/issues/1'; };
    const file = { kind: 'file', title: 'c', body: 'b', milestone: 'Product Backlog', labels: [] };
    applyDecision(w({ knownLabels: new Set(), labelled: [], all: [] }), { phase: 'file', actions: [file] }, { run, apply: true });
    const create = calls.findIndex((c) => c[0] === 'label' && c[1] === 'create');
    const filed = calls.findIndex((c) => c[0] === 'issue' && c[1] === 'create');
    expect(create).toBeGreaterThanOrEqual(0);
    expect(filed).toBeGreaterThan(create);
    expect(calls[filed]).toEqual(expect.arrayContaining(['--label', 'project:952']));
  });

  it('the report states the mirror, including what it could not read', () => {
    expect(report(w(), { phase: 'reconcile', actions: [], stopped: null })).toContain('| `project:952` label mirror | +1 / −1 |');
    expect(report(w({ labelled: undefined }), { phase: 'reconcile', actions: [], stopped: null })).toContain('label holders unreadable, nothing removed');
  });
});

/**
 * RA-2519 — the implementer's revise lane and the review lane retry a head ONCE when its
 * only run died of its cause (the model unreachable, or its API failing mid-run), after
 * a cool-down. The second half of PR RA-2446: its revise run died at 45 turns on
 * `terminal_reason: api_error`, and "a failed run is a run" parked it for good.
 * `lane-retry.test.ts` holds the shared decision; these hold the wiring in this tick.
 */
describe('retrying a run that died of its cause (RA-2519)', () => {
  const REVIEWED = new Date(Date.now() - 9 * 3600e3).toISOString();
  const RAN = new Date(Date.now() - 8 * 3600e3).toISOString();
  const DIED = new Date(Date.now() - 6 * 3600e3).toISOString();
  const HEAD = 'e22d4c8000000000000000000000000000000000';
  const blocked = () => ({
    number: 2446, state: 'OPEN', headSha: HEAD, headPushedAt: REVIEWED,
    reviews: [{ state: 'CHANGES_REQUESTED', sha: HEAD, submittedAt: REVIEWED }],
  });
  const reviseRun = (id: number) => ({ headSha: HEAD, event: 'pull_request_review', status: 'completed', conclusion: 'failure', databaseId: id, createdAt: RAN });
  const worldWith = (prs: unknown[]) => world({ open: [{ ...issue(2440, ['agent:implement']), prs }] });
  const died = (classification: string | null) => () => (classification ? { classification, at: DIED } : null);

  it('re-churns a revise head whose only run ended api_error, and names the evidence', () => {
    const out = reviseRecovery(worldWith([blocked()]), { runsFor: () => [reviseRun(36134805412)], evidenceOf: died('api_error'), retryHours: 5 });
    expect(out.churn).toEqual([{ kind: 'revise-churn', number: 2446, sha: HEAD, issue: 2440,
      retry: { runId: 36134805412, classification: 'api_error', at: DIED } }]);
    const text = report(world(), { phase: 'reconcile', actions: out.churn, stopped: null });
    expect(text).toMatch(/revise-churn.*run 36134805412, which died retryably \(`api_error`\)/);
  });

  it('does not re-churn a genuine failure, nor a second failure on the same head', () => {
    const genuine = reviseRecovery(worldWith([blocked()]), { runsFor: () => [reviseRun(1)], evidenceOf: died(null), retryHours: 5 });
    expect(genuine.churn).toEqual([]);
    expect(genuine.noted[0].why).toMatch(/Re-firing repeats it/);
    const twice = reviseRecovery(worldWith([blocked()]), { runsFor: () => [reviseRun(2), reviseRun(1)], evidenceOf: died('api_error'), retryHours: 5 });
    expect(twice.churn).toEqual([]);
    expect(twice.noted[0].why).toMatch(/2 revise run\(s\) exist/);
  });

  it('waits out the cool-down before re-churning', () => {
    const out = reviseRecovery(worldWith([blocked()]), { runsFor: () => [reviseRun(1)], evidenceOf: died('unreachable'), retryHours: 24 });
    expect(out.churn).toEqual([]);
    expect(out.noted[0].why).toMatch(/cause gets 24h to clear/);
  });

  it('never reads a run as retryable by default, so the unit tier never shells out', () => {
    expect(reviseRecovery(worldWith([blocked()]), { runsFor: () => [reviseRun(1)] }).churn).toEqual([]);
  });

  it('re-churns a review head whose only attempt never reached the model', () => {
    const pr = { number: 2446, state: 'OPEN', headSha: HEAD, reviews: [], headPushedAt: REVIEWED };
    const runs = () => [{ id: 77, actor: 'example-implementer', event: 'workflow_run', status: 'completed', conclusion: 'failure', createdAt: RAN }];
    const out = reviewRecovery(worldWith([pr]), { runsFor: runs, evidenceOf: died('unreachable'), retryHours: 5 });
    expect(out.churn).toEqual([{ kind: 'review-churn', number: 2446, sha: HEAD, issue: 2440,
      retry: { runId: 77, classification: 'unreachable', at: DIED } }]);
    expect(reviewRecovery(worldWith([pr]), { runsFor: runs, evidenceOf: died(null), retryHours: 5 }).churn).toEqual([]);
  });

  it('reaches both lanes from reconcileAll, and the churn stays off the budget', () => {
    const decisions: { actions: { kind: string; retry?: unknown }[] }[] = [];
    reconcileAll(['1'], {
      read: () => worldWith([blocked()]),
      onDecision: (_w: unknown, d: { actions: { kind: string }[] }) => decisions.push(d),
      runsFor: () => [reviseRun(9)],
      evidenceOf: died('api_error'),
      budget: 0,
    } as unknown as Parameters<typeof reconcileAll>[1]);
    expect(decisions[0].actions.find((a) => a.kind === 'revise-churn')?.retry).toMatchObject({ runId: 9, classification: 'api_error' });
    expect(chargeable(decisions[0].actions)).toBe(0);
  });
});
