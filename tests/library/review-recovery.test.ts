import { asAgent } from './helpers/sign.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asOneWorkflow } from './helpers/kanon-lane.js';
import { describe, expect, it } from 'vitest';
const {
  CHURN_LABEL, REVIEW_LABELS, ciSettledFor, hydrate,
  report, reviewPrs, reviewRecovery, verdictOnHead,
} = await import('../../scripts/review-recovery.mjs');
const { reviewAttempts, reviewRunsFor } = await import('../../scripts/review-run-evidence.mjs');
const { CONFLICT_WHY } = await import('../../scripts/conflict-state.mjs');
import { ROOT } from './helpers/adopter.js';

/**
 * RA-1689 — the implement/review PR lane could park with no review run and no signal.
 *
 * `agent-review.yml` fires on `workflow_run` (CI completion), which fires ONCE. When it
 * does not deliver — a dropped queue, a cap, an outage — nothing re-fires it and the PR
 * sits green, labelled and unreviewed. PR RA-1659 parked on BOTH its heads (`bb8232b`,
 * `5cd7880`: CI complete on each, no review run after either) and a human recovered
 * both by churning `review:please`. The first cost about a day.
 *
 * Every failure mode here is "acted when it should not have" — churned into a live run,
 * churned on an unreadable listing, churned while CI was still going (which would
 * re-introduce RA-378's `COMMENTED` verdict), churned twice. The decision is a pure
 * function of the world it read, so each of them is testable without GitHub.
 */
const HOURS = 4;
const NOW = Date.parse('2026-09-07T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const HEAD = 'bb8232b0000000000000000000000000000000aa';
const OLD = '5cd58770000000000000000000000000000000bb';

const pr = ({
  number = 1659,
  state = 'OPEN',
  isDraft = false,
  labels = ['agent:implement'],
  headRefOid = HEAD,
  reviews = [] as unknown[],
  pushedAt = ago(9),
  // EVERY FIXTURE DECLARES MERGEABILITY (RA-1722). `conflictState` throws rather than
  // answering "clear" for a PR object that never asked, so a fixture cannot quietly
  // opt out of the conflict gate the way `merge-gate.mjs`'s defaulted approval let its
  // cases opt out of the review one. Defaulting to CLEAN here is the healthy PR every
  // other assertion in this file is about; the conflicting case sets it explicitly.
  mergeStateStatus = 'CLEAN',
  mergeable = 'MERGEABLE',
} = {}) => ({
  number, state, isDraft,
  labels: labels.map((name) => ({ name })),
  headRefOid, reviews, mergeStateStatus, mergeable,
  commits: [{ oid: headRefOid, committedDate: pushedAt }],
});

const review = (over: Record<string, unknown> = {}) => ({
  author: { login: 'example-reviewer' }, state: 'APPROVED',
  commit: { oid: HEAD }, body: asAgent('example-reviewer', 'Approve.'), submittedAt: ago(5), ...over,
});

let seq = 0;
/**
 * `createdAt` defaults to AFTER the head became churnable (`ago(9)` + 4h = five hours
 * before NOW), because that is where a run this recovery started necessarily sits — the
 * tick only churns once the head is that old. A run created before that boundary was
 * started by something else, which is RA-1714 and is asserted separately.
 */
const CHURNABLE = NOW - 4 * 3600_000;
const run = (over: Record<string, unknown> = {}) => ({
  id: ++seq, actor: 'example-implementer', event: 'pull_request',
  status: 'completed', conclusion: 'success',
  createdAt: new Date(CHURNABLE + seq * 1000).toISOString(), ...over,
});

const noRuns = () => [];
const decide = (prs: unknown[], {
  runsFor = noRuns as (sha: string) => unknown[] | null,
  ciSettled = () => true as boolean | null,
} = {}) => reviewRecovery(prs, { runsFor, ciSettled, now: NOW, hours: HOURS });

describe('whose PRs this lane is about', () => {
  it('takes any open, non-draft PR carrying a review label', () => {
    const prs = [
      pr({ number: 1, labels: ['agent:implement'] }),
      pr({ number: 2, labels: ['agent:triage'] }),
      pr({ number: 3, labels: ['review:please'] }),
      pr({ number: 4, labels: ['documentation'] }),
      pr({ number: 5, labels: ['review:please'], isDraft: true }),
      pr({ number: 6, labels: ['review:please'], state: 'MERGED' }),
    ];
    expect(reviewPrs(prs).map((p: { number: number }) => p.number)).toEqual([1, 2, 3]);
  });

  it('covers the world `reviewRecovery` in lead-reconcile.mjs cannot see', () => {
    // THE WHOLE POINT OF A SECOND READER. That lane walks `readWorld(project)` — issues
    // carrying `qa:project <n>` whose brief has MERGED — filtered to `agent:implement`.
    // A human's `review:please` PR and an `agent:triage` bug-fix belong to no such
    // issue, and PR RA-1659 (the Lead's own) belonged to no project at all.
    expect([...REVIEW_LABELS].sort()).toEqual(['agent:implement', 'agent:triage', 'review:please']);
  });
});

describe('what counts as a review already standing on the head', () => {
  it('takes a real verdict on the head', () => {
    expect(verdictOnHead(pr({ reviews: [review()] }))).toBeTruthy();
    expect(decide([pr({ reviews: [review()] })]).churn).toEqual([]);
  });

  it('does not count a COMMENTED review — it is invisible to everything downstream', () => {
    // The RA-1081 rule, and the same one `merge-gate.mjs` and the workflow's own reconcile
    // step apply. A head carrying only a `COMMENT` is a head with no verdict (RA-378).
    expect(verdictOnHead(pr({ reviews: [review({ state: 'COMMENTED' })] }))).toBeNull();
  });

  it('does not count a verdict on an older commit', () => {
    expect(verdictOnHead(pr({ reviews: [review({ commit: { oid: OLD } })] }))).toBeNull();
  });

  it('does not count a verdict GitHub filed under the head that a run read elsewhere (RA-1680)', () => {
    // `commit_id` is the head at SUBMISSION time. A verdict formed against an earlier
    // commit reads as one about this one — which would make this recovery decide a
    // parked head had been reviewed and leave it parked forever. The stamp the reviewer
    // job writes is what separates them.
    const misattributed = review({ body: `Approve.\n\n<!-- reviewed: sha=${OLD} run=5 -->` });
    expect(verdictOnHead(pr({ reviews: [misattributed] }))).toBeNull();
    expect(decide([pr({ reviews: [misattributed] })]).churn).toHaveLength(1);
  });

  it('ignores a review by anyone who is not the Reviewer', () => {
    expect(verdictOnHead(pr({ reviews: [review({ author: { login: 'a-person' } })] }))).toBeNull();
  });

  it('accepts the [bot] and app/ spellings of his identity', () => {
    for (const login of ['example-reviewer', 'example-reviewer[bot]', 'app/example-reviewer']) {
      expect(verdictOnHead(pr({ reviews: [review({ author: { login } })] })), login).toBeTruthy();
    }
  });
});

describe('when it acts', () => {
  it('churns a head with settled CI, no verdict and no review run — PR RA-1659\'s own failure', () => {
    const { churn, noted } = decide([pr()]);
    expect(churn).toEqual([{ number: 1659, sha: HEAD }]);
    expect(noted, 'nothing to report when it acted').toEqual([]);
  });

  it('hands the head\'s push time to the run read, which floors RA-1717\'s title read on it', () => {
    const seen: unknown[] = [];
    reviewRecovery([pr()], {
      runsFor: (_sha: string, since?: string) => { seen.push(since); return []; },
      ciSettled: () => true, now: NOW, hours: HOURS,
    });
    expect(seen).toEqual([ago(9)]);
  });

  it('does not churn a freshly-pushed head', () => {
    // A PR pushed a minute ago has no review either; calling that a stall would fire on
    // every healthy PR in the window CI takes to run.
    expect(decide([pr({ pushedAt: ago(1) })]).churn).toEqual([]);
  });

  it('does not churn when the push date is unknown', () => {
    const bare = { ...pr(), commits: [] };
    expect(decide([bare]).churn).toEqual([]);
  });
});

describe('it must not pre-empt the CI-pending defer (RA-378)', () => {
  /**
   * The Reviewer is invoked after CI settles deliberately: firing on the push raced CI, and
   * because he was forbidden to wait he posted a `COMMENT` verdict carrying an approve
   * in its prose that nothing re-fired. Three of seven measured PRs ended there.
   *
   * There is a second, sharper reason here. A churn fired into running CI produces a run
   * that merely DEFERS — and because that run counts as a recovery attempt, the bound is
   * then spent on a head that was never reviewed and can never be churned again.
   */
  it('reports rather than churns while CI is still running', () => {
    const { churn, noted } = decide([pr()], { ciSettled: () => false });
    expect(churn).toEqual([]);
    expect(noted[0].why).toMatch(/CI has not finished/);
    expect(noted[0].why, 'and says whose job the next move is').toMatch(/RA-378/);
  });

  it('reports rather than churns when CI\'s runs could not be read', () => {
    // FAILS CLOSED in the direction that matters here: an unreadable listing must not
    // license a churn. That is the opposite direction from `agent-review.yml`'s own
    // filter, where an unreadable read must not DEFER — the two are asking different
    // questions and the safe answer differs.
    const { churn, noted } = decide([pr()], { ciSettled: () => null });
    expect(churn).toEqual([]);
    expect(noted[0].why).toMatch(/unknown/);
  });

  it('treats a head with no CI run at all as not settled', () => {
    // `ciSettledFor` answers `false`, never `true`, for an empty listing: "no CI run has
    // registered" is not "CI finished". That is the same mistake RA-1413 fixed in the
    // filter, arriving here by a different door.
    const json = () => [];
    expect(ciSettledFor(HEAD, { json })).toBe(false);
    expect(ciSettledFor(HEAD, { json: () => [{ headSha: HEAD, status: 'completed' }] })).toBe(true);
    expect(ciSettledFor(HEAD, { json: () => [{ headSha: HEAD, status: 'in_progress' }] })).toBe(false);
    // A run for a DIFFERENT commit is not evidence about this one.
    expect(ciSettledFor(HEAD, { json: () => [{ headSha: OLD, status: 'completed' }] })).toBe(false);
    expect(ciSettledFor(HEAD, { json: () => { throw new Error('403'); } })).toBeNull();
  });
});

describe('the bound is the evidence, not a counter', () => {
  it('churns AT MOST ONCE per head, with no state to keep or reset', () => {
    // After a churn a run started by the recovery exists for that head, whatever it goes
    // on to conclude — so the next tick reads an attempt and reports instead. This runs
    // two ticks in sequence against a store the first populates.
    let store: unknown[] = [];
    const runsFor = () => store;
    const world = [pr()];
    expect(decide(world, { runsFor }).churn, 'tick 1 acts').toHaveLength(1);
    store = [run({ actor: 'example-lead', status: 'in_progress', conclusion: null })];
    expect(decide(world, { runsFor }).churn, 'tick 2 must not act again').toEqual([]);
  });

  it('is not blocked by a the Lead run from the PR\'s own creation (RA-1714)', () => {
    // The Lead applies `review:please` to its OWN brief PR at creation, so its login is
    // the actor of a run on that head. Keying the loop bound on the actor alone marked
    // such a head permanently "already attempted" — and PR RA-1659, the incident RA-1689 was
    // filed over, is one of the Lead's own PRs. The boundary is time, not identity: this
    // recovery only churns a head past the stall window, so its run is created at least
    // that long after the push.
    const atCreation = () => [run({
      actor: 'example-lead', conclusion: 'success',
      createdAt: new Date(NOW - 9 * 3600_000 + 2000).toISOString(),
    })];
    expect(decide([pr()], { runsFor: atCreation }).churn).toHaveLength(1);
  });

  it('IS blocked by a the Lead run started after the head became churnable', () => {
    // NON-VACUITY on the rule above — this is the loop bound itself, and weakening it
    // re-churns the same head every hour forever.
    const afterChurn = () => [run({ actor: 'example-lead', conclusion: 'success' })];
    expect(decide([pr()], { runsFor: afterChurn }).churn).toEqual([]);
  });

  it('does not re-fire into a run that FAILED — a cap or an outage is reported', () => {
    // THE ONE THING THIS MUST NOT DO. Re-firing into a live cap fails the same way and
    // can extend the window.
    const { churn, noted } = decide([pr()], { runsFor: () => [run({ id: 42, conclusion: 'failure' })] });
    expect(churn).toEqual([]);
    expect(noted[0].why).toMatch(/run 42/);
  });

  it('churns nothing on an unreadable Actions listing', () => {
    const { churn, noted } = decide([pr()], { runsFor: () => null });
    expect(churn).toEqual([]);
    expect(noted[0].why).toMatch(/could not read/);
  });

  it('is not blocked by the label noise every implement PR manufactures (RA-1594)', () => {
    // The same defect the older lane had, and the reason both import one classifier: a
    // second copy of this rule is a second place for it to be wrong. PR RA-1591's real
    // listing — five runs, zero reviews, all from label events.
    const noise = () => [
      run({ actor: 'example-reviewer', conclusion: 'skipped', createdAt: '2026-09-04T13:20:51Z' }),
      run({ actor: 'example-merger', conclusion: 'success', createdAt: '2026-09-04T13:19:25Z' }),
      run({ conclusion: 'success', createdAt: '2026-09-04T13:13:29Z' }),
      run({ conclusion: 'cancelled', createdAt: '2026-09-04T13:13:28Z' }),
      run({ conclusion: 'skipped', createdAt: '2026-09-04T13:13:25Z' }),
    ];
    expect(reviewAttempts(noise())).toEqual([]);
    expect(decide([pr()], { runsFor: noise }).churn).toHaveLength(1);
  });

  it('reads the runs BY COMMIT and BY WORKFLOW FILE, so the listing is not a time window', () => {
    // `--limit N` is a time window in disguise: 80 runs of this workflow covered 6.1
    // hours against a 4h stall gate with no upper bound on how long a PR stays
    // unreviewed. A head whose review failed before the window would list as ZERO runs
    // and be churned — the one thing this must never do, and it degrades on a busy day.
    const calls: string[][] = [];
    reviewRunsFor(HEAD, { repo: 'o/r', json: (args: string[]) => { calls.push(args); return { workflow_runs: [] }; } });
    expect(calls[0].join(' ')).toContain(`head_sha=${HEAD}`);
    // AND server-side by workflow. The repo-wide `actions/runs` form makes this workflow
    // compete for 100 unpaginated slots with every other workflow on the head (26 on the
    // busiest measured), and an under-count means a churn into a live or broken run.
    expect(calls[0].join(' ')).toContain('actions/workflows/agent-review.yml/runs');
  });
});

describe('the reads the CLI actually makes', () => {
  /**
   * THE ONE-READ FORM DOES NOT WORK, and only the real API says so. Asking `gh pr list`
   * for `reviews` and `commits` across 100 PRs multiplies two connections by the page
   * size and GitHub rejects the query outright:
   *
   *   GraphQL: By the time this query traverses to the authors connection, it is
   *   requesting up to 1,000,000 possible nodes which exceeds the maximum limit of
   *   500,000.
   *
   * Measured against this repo before this lane ever ran a tick. The failure is TOTAL —
   * no result, non-zero exit — so the whole recovery would have died on its first
   * heartbeat with a green unit suite behind it. That is RA-1032's shape: a workflow that
   * had never once succeeded while its tests passed.
   *
   * Asserted on the SOURCE because the failure lives in GitHub's query planner and
   * cannot be reproduced from a stub — which is exactly the case where a source
   * assertion earns its keep rather than substituting for a behavioural one.
   */
  const src = readFileSync(join(ROOT, 'scripts/review-recovery.mjs'), 'utf8');

  it('does not ask the LIST endpoint for per-PR connections', () => {
    // The `--json` field list of the one `gh pr list` call, taken as written.
    const listFields = /'pr', 'list',[\s\S]*?'--json', '([^']+)'/.exec(src)?.[1];
    expect(listFields, 'no `gh pr list` call found at all').toBeTruthy();
    expect(listFields, 'the cheap pass asks for scalars only').toBe('number,state,isDraft,labels');
    expect(listFields, 'reviews is a connection and blows the node budget').not.toContain('reviews');
    expect(listFields, 'so is commits').not.toContain('commits');
  });

  it('fetches the connections per PR instead, and reports one it cannot read', () => {
    // An unreadable PR must be REPORTED, never dropped: treating it as "nothing parked
    // here" is the swallow this pipeline keeps producing.
    const failed: number[] = [];
    const out = hydrate([{ number: 7 }, { number: 8 }], {
      json: (args: string[]) => {
        expect(args.slice(0, 2)).toEqual(['pr', 'view']);
        expect(args.at(-1)).toContain('reviews');
        if (args[2] === '8') throw new Error('403');
        return { number: 7 };
      },
      onError: (n: number) => failed.push(n),
    });
    expect(out).toEqual([{ number: 7 }]);
    expect(failed).toEqual([8]);
  });
});

describe('what a human reads', () => {
  it('says so when it examined everything and found nothing', () => {
    // Two lanes of nothing is still a finding. A report that renders empty is
    // indistinguishable from a run that did not happen.
    expect(report({ churn: [], noted: [] })).toMatch(/No PR is parked without a review/);
  });

  it('names every head it did NOT act on, and why', () => {
    // NAMED, NOT COUNTED. "detected 3, churned 1" reads as two silently dropped; the
    // reasons want different responses and most of them want none.
    const text = report({ churn: [{ number: 7, sha: HEAD }], noted: [{ number: 8, sha: OLD, why: 'CI has not finished' }] });
    expect(text).toMatch(/PR #7/);
    expect(text).toMatch(/PR #8/);
    expect(text).toMatch(/CI has not finished/);
  });
});

describe('the hourly tick runs it, with the authority it needs and no more', () => {
  const wf = asOneWorkflow('agent-lead-reconcile.yml');
  const steps = wf.jobs.tick.steps as { name?: string; if?: string; env?: Record<string, string>; run?: string }[];
  const lane = steps.find((s) => s.name === 'Re-deliver a review that never landed');

  it('is wired into the tick', () => {
    expect(lane?.run).toContain('"$KANON/scripts/review-recovery.mjs"');
  });

  it('uses the App token, without which the churn raises no event at all', () => {
    // An event raised by the default GITHUB_TOKEN never triggers another workflow, so a
    // churn with it would re-deliver nothing while looking like it had.
    expect(lane?.env?.GH_TOKEN).toContain('app-token');
  });

  it('churns a label instead of dispatching — the RA-1281 constraint', () => {
    // The Lead's row in `rulebook/03-agents.md` gives it no Actions WRITE on purpose: label
    // churn achieves the same with strictly less authority (`K-AGENT-4`), and RA-1281 is what reaching
    // for `gh workflow run` cost — a 403 and a held pilot.
    // CODE, NOT PROSE. The file's header EXPLAINS why it does not dispatch, so a
    // whole-file match would be satisfied by the sentence saying it never dispatches —
    // the position-not-presence trap this repo has hit six times.
    const code = readFileSync(join(ROOT, 'scripts/review-recovery.mjs'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/'workflow', 'run'|gh workflow run/);
    expect(code).toContain('--add-label');
    expect(CHURN_LABEL).toBe('review:please');
  });

  it('is gated on its own pre-filter, so an idle heartbeat costs nothing', () => {
    expect(lane?.if).toBe("steps.unreviewed.outputs.parked != ''");
  });
});

describe('a conflicting PR is hard-stopped, not slow (RA-1722)', () => {
  /** What GitHub actually reports for a PR that conflicts with its base. */
  const dirty = (over = {}) => pr({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', ...over });

  it('reports the rebase and churns nothing', () => {
    // A churn here raises a `pull_request: [labeled]` event that GitHub cannot
    // dispatch, because it has no merge ref to run the workflow against. 25 of them
    // produced zero runs on PR RA-1708.
    const out = decide([dirty()], { ciSettled: () => false });
    expect(out.churn).toEqual([]);
    expect(out.noted).toHaveLength(1);
    // The SHARED sentence, not a paraphrase — `conflict-state.test.ts` pins what it
    // has to say, and this pins that this lane is the thing saying it (RA-2154's lesson
    // one lane over: a second copy drifts while still agreeing logically).
    expect(out.noted[0].why).toBe(CONFLICT_WHY);
  });

  it('is asked BEFORE the CI question, so the note names the real remedy', () => {
    // THE ORDER IS THE FIX. CI was never dispatched for this head either, so the
    // CI-pending branch catches it first and says "Nothing to recover yet" — true of a
    // PR whose CI is slow, false of one where CI will never start. Same detector,
    // opposite remedy. Mutation: move the conflict gate below `ciSettled` and this is
    // the only assertion in the file that fails.
    const out = decide([dirty()], { ciSettled: () => false });
    expect(out.noted[0].why).not.toMatch(/Nothing to recover yet/);
    expect(out.noted[0].why).not.toMatch(/CI has not finished/);
  });

  it('still churns an otherwise identical PR that is merely clean', () => {
    // The control. Without it, "churns nothing" is satisfied by a gate that blocks
    // every PR, which is the failure this lane was built to stop (RA-1689).
    const out = decide([pr()], { ciSettled: () => true });
    expect(out.churn.map((c: { number: number }) => c.number)).toEqual([1659]);
  });

  it('churns a PR whose mergeability GitHub has not computed yet', () => {
    // `computing` proceeds — see `conflict-state.mjs`. Refusing would park a healthy
    // PR on a value that resolves seconds later.
    const out = decide([pr({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' })], { ciSettled: () => true });
    expect(out.churn).toHaveLength(1);
  });
});
