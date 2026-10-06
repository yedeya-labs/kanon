import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asAgent } from './helpers/sign.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT } from './helpers/adopter.js';
import { appLogin } from '../../scripts/app-register.mjs';

// The sweep reads the repository it acts on when it loads (`REPO`), and the recordings under
// `tests/fixtures/gh/` are of this repository's own public payloads.
process.env.GITHUB_REPOSITORY = 'yedeya-labs/kanon';
const { MARKER, classify, isBot, linkedPrIndex, norm, breakerTripped, AGENT_LOGIN, SWEEP_LOGIN, LANES, laneTag, isLaneComment, terminalVerdict, actionable, unreachedByIssue, unreachedWindowStart, costStamp, parseCostStamp, makeSweepTriggerCheck, PAIR_WINDOW_MINUTES, attemptsCell, exhaustedAtByIssue, lastLabeledAt, makeLabeledAtReader, COST_PROJECTION, makeCommentsReader, redactSecrets, READ_SHAPES, keyPaths, shapeDrift } = await import('../../scripts/dispatch-sweep.mjs');

/** The fixture adopter's App logins (`tests/fixtures/adopter/docs/qa/agent-identities.md`). */
const REVIEWER_LOGIN = appLogin('Reviewer');

/**
 * RA-912 — the dispatch reconciler's classifier.
 *
 * Why this is unit-tested rather than trusted: the classifier's whole job is to
 * tell three states apart that look identical from the outside (an open issue
 * carrying `agent:implement`), and getting it wrong is expensive in both
 * directions — a false `never-ran` spends a full the Implementer run of subscription
 * quota, while a false `has-pr` re-buries the stall the script exists to end.
 *
 * The first test below is a real regression: `gh issue view --json comments`
 * returns `author.login` WITHOUT the `[bot]` suffix, while `gh api .../reviews`
 * returns it WITH. The first draft matched on `oholiab-the-craftsman[bot]`, so
 * every agent comment read as absent and 11 of 17 issues classified as
 * `never-ran` — i.e. the sweep would have re-dispatched four issues that were
 * actually waiting on a human, including one whose work was already finished.
 */

const HOUR = 3600_000;
const NOW = Date.parse('2026-08-23T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();
const issue = { number: 1, title: 't', createdAt: ago(1000) };

const comment = (login: string, hours: number, body = 'hello') => ({
  login,
  createdAt: ago(hours),
  body: asAgent(login, body),
});
// The sweep runs as its OWN App, deliberately not as the implementer it watches.
const sweepComment = (hours: number) => comment(SWEEP_LOGIN, hours, `${MARKER}\nre-dispatching`);

const verdict = (comments: ReturnType<typeof comment>[], hasPr = false, opts = {}) =>
  classify(issue, comments, hasPr, { now: NOW, ...opts });

describe('login normalisation', () => {
  it('strips a [bot] suffix so either gh payload shape compares equal', () => {
    expect(norm(`${AGENT_LOGIN}[bot]`)).toBe(AGENT_LOGIN);
    expect(norm(AGENT_LOGIN)).toBe(AGENT_LOGIN);
    expect(norm(undefined)).toBe('');
  });

  it('recognises the pipeline bots in either shape', () => {
    expect(isBot(REVIEWER_LOGIN)).toBe(true);
    expect(isBot(`${REVIEWER_LOGIN}[bot]`)).toBe(true);
    expect(isBot(appLogin('Releaser'))).toBe(true);
  });

  it('treats an unknown login as human, erring toward re-dispatch not toward stalling', () => {
    expect(isBot('some-new-contributor')).toBe(false);
  });
});

describe('classify', () => {
  it('is never-ran when the agent has not spoken', () => {
    expect(verdict([])).toMatchObject({ state: 'never-ran', act: 'dispatch' });
  });

  it('is never-ran when OTHER bots commented but the implementer did not (RA-701)', () => {
    // the Reviewer leaving a scope note is not evidence that the Implementer ever ran.
    expect(verdict([comment(REVIEWER_LOGIN, 300)])).toMatchObject({
      state: 'never-ran',
      act: 'dispatch',
    });
  });

  it('sees an agent comment carrying the [bot] suffix — the shape bug this test pins', () => {
    const v = verdict([comment(`${AGENT_LOGIN}[bot]`, 300)]);
    expect(v.state).not.toBe('never-ran');
    expect(v.state).toBe('awaiting-human');
  });

  it('is awaiting-human once the agent has had the last word past the stale window', () => {
    expect(verdict([comment(AGENT_LOGIN, 300)])).toMatchObject({
      state: 'awaiting-human',
      act: null,
    });
  });

  it('is in-flight while the agent just spoke', () => {
    expect(verdict([comment(AGENT_LOGIN, 2)])).toMatchObject({
      state: 'in-flight',
      act: null,
    });
  });

  it('is answered when a human replied after the agent and nothing re-fired', () => {
    expect(
      verdict([comment(AGENT_LOGIN, 300), comment('a-human', 200)]),
    ).toMatchObject({ state: 'answered', act: 'dispatch' });
  });

  it('holds when a human replies to the SWEEP rather than to the agent', () => {
    // The sweep invites a reply ("if this is wrong, remove the label"), so answering
    // in prose must not be punished with another dispatch. Reachable through
    // never-ran: a broken implementer never comments, the sweep re-dispatches, a
    // human replies "stop, this needs design".
    expect(verdict([sweepComment(100), comment('a-human', 50)])).toMatchObject({
      state: 'human-held',
      act: null,
    });
  });

  it('keeps the hold when a third-party bot comments afterwards', () => {
    // The hold must be a property of "a human spoke after the sweep with no agent
    // run since", not of who happens to hold the last slot. Both of these bots
    // comment on issues in this repo, so a hold that depended on `last` was cleared
    // routinely — re-arming a dispatch a human had just objected to, and asserting
    // "silence means the run never happened" about an issue explicitly held.
    const held = [sweepComment(100), comment('a-human', 50, 'stop, needs design')];
    for (const bot of [REVIEWER_LOGIN, 'github-actions']) {
      expect(verdict([...held, comment(bot, 10)])).toMatchObject({
        state: 'human-held',
        act: null,
      });
    }
  });

  it('still dispatches when the human is answering the AGENT, not the sweep', () => {
    // The discriminator is whether the agent spoke between the sweep's last comment
    // and the human's. Here it did, so the human is answering a real question.
    expect(
      verdict([sweepComment(200), comment(AGENT_LOGIN, 150), comment('a-human', 100)]),
    ).toMatchObject({ state: 'answered', act: 'dispatch' });
  });

  it('does not read its own comment as agent output when the marker is lost', () => {
    // With the sweep on its own identity, MARKER is no longer the only thing
    // separating "the agent spoke" from "the sweep spoke". Losing it used to strand
    // the issue in a human queue permanently.
    const markerless = { ...sweepComment(100), body: 're-dispatching' };
    expect(verdict([markerless])).toMatchObject({ state: 'never-ran' });
  });

  it('lets a linked PR outrank every other signal', () => {
    expect(verdict([], true)).toMatchObject({ state: 'has-pr', act: null });
    expect(verdict([comment(AGENT_LOGIN, 300)], true)).toMatchObject({
      state: 'has-pr',
      act: null,
    });
  });

  it('counts only its OWN marker comments as re-dispatches', () => {
    // An agent comment that merely quotes the sweep must not inflate the count,
    // which is why the marker is an HTML comment and not prose.
    expect(verdict([sweepComment(100), comment(AGENT_LOGIN, 90)]).redispatches).toBe(1);
  });

  it('stops at the re-dispatch budget instead of looping forever', () => {
    expect(verdict([sweepComment(200), sweepComment(100)])).toMatchObject({
      state: 'exhausted',
      act: 'stop',
    });
  });

  it('holds off inside the cooldown so a slow run is not re-dispatched underneath itself', () => {
    const v = verdict([sweepComment(2)]);
    expect(v.state).toBe('never-ran');
    expect(v.act).toBeNull();
  });

  it('dispatches again once the cooldown has elapsed', () => {
    expect(verdict([sweepComment(100)])).toMatchObject({ state: 'never-ran', act: 'dispatch' });
  });

  it('does not strip the trigger label off an issue the agent is actively working', () => {
    // The cap is a bound on DISPATCHING, not a verdict on the issue. Checking it
    // before the in-flight guard let an at-cap issue whose agent had just commented
    // classify `exhausted` -> `stop`, applying `qa:needs-info` on top of live work.
    const v = verdict([sweepComment(200), sweepComment(100), comment(AGENT_LOGIN, 2)]);
    expect(v.state).toBe('in-flight');
    expect(v.act).toBeNull();
  });

  it('still exhausts an at-cap issue once the agent has gone quiet', () => {
    expect(verdict([sweepComment(300), sweepComment(200)])).toMatchObject({
      state: 'exhausted',
      act: 'stop',
    });
  });

  it('carries the injected cap through to the verdict so the comment cannot misreport it', () => {
    expect(verdict([], false, { maxRedispatch: 5 }).maxRedispatch).toBe(5);
  });
});

describe('linkedPrIndex', () => {
  /**
   * This predicate had NO test in the first draft, which is why a live dry run
   * caught its defect and a green unit tier did not. `has-pr` outranks every other
   * signal, so a false positive here silently re-buries the stall the script exists
   * to end — the expensive direction, as the header note above says.
   *
   * The original bug: the body was regexed for a bare `#N`, so any cross-reference
   * counted. Opening the pull request that ADDED this script cited RA-855, RA-852, RA-730
   * and RA-159 as its motivating evidence and thereby reclassified all four from
   * `awaiting-human` to `has-pr`.
   */
  // `body` and `title` MUST be on this fixture even though the current predicate
   // never reads them: they are the fields the buggy version read, so without them
   // the "does NOT match a mention" assertions below hold trivially and pass against
   // the very code they exist to outlaw. (They did, in the first attempt at this
   // test — verified by re-running the old predicate over the bodyless fixture.)
  const pr = (
    number: number,
    opts: { closes?: number[]; branch?: string; body?: string; title?: string } = {},
  ) => ({
    number,
    headRefName: opts.branch ?? `chore/misc-${number}`,
    body: opts.body ?? '',
    title: opts.title ?? `PR ${number}`,
    // The real `gh pr list --json closingIssuesReferences` shape, not a reduction of
    // it: `repository` is present on EVERY reference (same-repo included) and is
    // `{ id, name, owner: { id, login } }` — there is no `nameWithOwner`. A fixture
    // that omitted `repository` let a guard reading a non-existent sub-field pass,
    // while the same guard skipped all 23 live references. Fixtures written to the
    // code instead of the payload is how both vacuous tests on this PR happened.
    closingIssuesReferences: (opts.closes ?? []).map((n) => ({
      number: n,
      repository: { name: 'kanon', owner: { login: 'yedeya-labs' } },
    })),
  });

  it('matches a PR that GitHub says will close the issue', () => {
    expect(linkedPrIndex([pr(858, { closes: [848] })])(848)).toMatchObject({ number: 858 });
  });

  it('matches a PR by the <type>/<number>-<slug> branch convention', () => {
    // Covers a PR whose body forgot the closing keyword — RA-845/PR RA-863 in practice.
    expect(linkedPrIndex([pr(863, { branch: 'feat/845-capability-labels' })])(845)).toMatchObject({
      number: 863,
    });
  });

  it('does NOT match a PR that merely mentions the issue — the regression', () => {
    // This is PR RA-914 itself: it closes RA-912 and cites four other issues as the
    // evidence motivating the change. Under the old predicate that citation alone
    // made all four `has-pr`, which outranks every other signal — so opening this
    // pull request silenced the exact stalls its body was written to surface.
    const mentioner = pr(914, {
      closes: [912],
      branch: 'feat/912-dispatch-sweep',
      body: 'Motivating evidence: #730 has waited 390h for a human, #855 and #852 205h, #159 longer still.',
      title: 'ci(qa): reconcile stalled agent:implement dispatches',
    });
    const index = linkedPrIndex([mentioner]);
    expect(index(730)).toBeUndefined();
    expect(index(855)).toBeUndefined();
    expect(index(159)).toBeUndefined();
    // ...while the issue it genuinely closes still resolves.
    expect(index(912)).toMatchObject({ number: 914 });
  });

  it('does NOT match a mention in the TITLE either', () => {
    const index = linkedPrIndex([pr(900, { title: 'fix: follow-up to #730' })]);
    expect(index(730)).toBeUndefined();
  });

  it('registers a same-repo closing reference in the real payload shape', () => {
    // Red against a guard reading `repository.nameWithOwner`: that field does not
    // exist, so the comparison skipped every reference and this arm contributed
    // nothing while the dry-run output stayed identical by coincidence.
    expect(linkedPrIndex([pr(889, { closes: [883] })])(883)).toMatchObject({ number: 889 });
  });

  it('covers what the branch arm structurally cannot — a multi-issue PR', () => {
    // A branch can encode one number; PR RA-889 closes six. Live proof that the
    // closing-reference arm is not redundant with the branch arm.
    const multi = pr(889, { closes: [883, 884, 893], branch: 'feat/876-forgotten-review' });
    const index = linkedPrIndex([multi]);
    for (const n of [883, 884, 893]) expect(index(n)).toMatchObject({ number: 889 });
  });

  it('ignores a closing reference that belongs to another repository', () => {
    const cross = {
      ...pr(901),
      closingIssuesReferences: [
        { number: 730, repository: { name: 'other-repo', owner: { login: 'someone' } } },
      ],
    };
    expect(linkedPrIndex([cross])(730)).toBeUndefined();
  });

  it('compares the repository case-insensitively', () => {
    const odd = {
      ...pr(902),
      closingIssuesReferences: [
        { number: 730, repository: { name: 'KANON', owner: { login: 'Yedeya-Labs' } } },
      ],
    };
    expect(linkedPrIndex([odd])(730)).toMatchObject({ number: 902 });
  });

  it('does not match a branch whose number is a prefix of another issue', () => {
    // `feat/1590-...` must not satisfy issue RA-159.
    expect(linkedPrIndex([pr(9, { branch: 'feat/1590-something' })])(159)).toBeUndefined();
  });

  it('returns nothing when no open PR claims the issue', () => {
    expect(linkedPrIndex([pr(1), pr(2)])(730)).toBeUndefined();
  });
});

describe('RA-1517 — a dispatch that never reached the model is not an attempt', () => {
  const H = 3600e3;
  const now = Date.now();
  const issue = (n: number) => ({ number: n, title: `t${n}`, createdAt: new Date(now - 500 * H).toISOString() });
  const sweepAt = (h: number) => ({ login: SWEEP_LOGIN, body: `x ${MARKER}`, createdAt: new Date(now - h * H).toISOString() });

  describe('unreachedByIssue', () => {
    // One sweep comment at 2026-09-02T00:00Z, and every row lands ten minutes behind it
    // unless a test says otherwise — a sweep dispatch's own `unavailable` run.
    const M = Date.parse('2026-09-02T00:00:00Z');
    const markers = new Map([[10, [M]], [99, [M]]]);
    const behind = '20260902T001000Z';
    const bySweep = () => true;

    it('counts only `unavailable` rows, and only for issues asked about', () => {
      const rows = [
        { ts: behind, issue_number: '10', outcome: 'failed' },      // the agent RAN and died — charge it
        { ts: behind, issue_number: '10', outcome: 'ok' },
        { ts: behind, issue_number: '10', outcome: 'unavailable' },
        { ts: behind, issue_number: '99', outcome: 'unavailable' }, // a different issue
      ];
      expect([...unreachedByIssue(rows, [10], { markers, triggeredBySweep: bySweep })]).toEqual([[10, 1]]);
    });

    it('ignores a row with no issue number rather than attributing it', () => {
      // `workflow_dispatch` and a re-run carry no issue in the payload, so the row
      // records `issue_number` absent. Coercing that to 0 — or to the issue being
      // asked about — would discount an attempt on evidence from a different run.
      const rows = [
        { ts: behind, issue_number: null, outcome: 'unavailable' },
        { ts: behind, issue_number: '', outcome: 'unavailable' },
        { ts: behind, issue_number: 'abc', outcome: 'unavailable' },
      ];
      expect(unreachedByIssue(rows, [10], { markers, triggeredBySweep: bySweep }).size).toBe(0);
    });

    it('returns an empty map for an unreadable store', () => {
      expect(unreachedByIssue(null as never, [10], { markers, triggeredBySweep: bySweep }).size).toBe(0);
      expect(unreachedByIssue([], [10], { markers, triggeredBySweep: bySweep }).size).toBe(0);
    });
  });

  describe('classify charges dispatched minus unreached', () => {
    // Two sweep comments is the cap. With one of them never having reached the model,
    // only one attempt is charged and the issue is still dispatchable.
    const twoDispatches = [sweepAt(300), sweepAt(200)];

    it('exhausts at the cap when every dispatch reached the model', () => {
      const v = classify(issue(1), twoDispatches, false, { now });
      expect(v.state).toBe('exhausted');
      expect(v.act).toBe('stop');
      expect(v.redispatches).toBe(2);
    });

    it('does NOT exhaust when one dispatch never reached the model', () => {
      // THE DEFECT. Two bad days used to exhaust an issue and strip its label with a
      // comment blaming its acceptance criteria — both stated causes false, because no
      // agent ever read it.
      const v = classify(issue(1), twoDispatches, false, { now, unreached: 1 });
      expect(v.state, 'still dispatchable').not.toBe('exhausted');
      expect(v.act).not.toBe('stop');
      expect(v.redispatches, 'one of the two is not charged').toBe(1);
    });

    it('reports what it did not charge, so the count is explicable', () => {
      // "attempt 1 of 2" under three visible sweep comments reads as a bug unless the
      // run says why.
      const v = classify(issue(1), [sweepAt(300), sweepAt(200), sweepAt(100)], false, { now, unreached: 2 });
      expect(v.dispatched).toBe(3);
      expect(v.unreached).toBe(2);
      expect(v.redispatches).toBe(1);
    });

    it('DEFAULTS to charging every dispatch — absence must not un-exhaust', () => {
      // FAIL CLOSED. A caller that cannot read the store gets the pre-#1517 behaviour.
      // The opposite direction hands an issue unlimited attempts, which is the runaway
      // MAX_REDISPATCH exists to bound, reached from the other side.
      expect(classify(issue(1), twoDispatches, false, { now }).act).toBe('stop');
      expect(classify(issue(1), twoDispatches, false, { now, unreached: 0 }).act).toBe('stop');
    });

    it('never goes negative on a stale or over-broad read', () => {
      // The store is read over a window; the comments are counted over all time. More
      // `unavailable` rows than comments must floor at zero, not wrap into free attempts.
      const v = classify(issue(1), twoDispatches, false, { now, unreached: 99 });
      expect(v.redispatches).toBe(0);
      expect(v.unreached).toBe(99);
    });
  });

  it('the lookback window actually excludes rows outside it', () => {
    // WAS `toMatch(/sk > :s/)` — a SUBSTRING, and it passed with the window doing
    // nothing (RA-1573 review). The bound was built with `toISOString()`, extended ISO
    // (`2026-09-04T12:02:45.050Z`), while the sort key is basic (`20260904T120245Z`).
    // DynamoDB compares `S` keys as bytes: at index 4 the key has a digit and the
    // bound has `-` (0x2D < 0x30), so once the year matched, `sk > :s` was
    // unconditionally true. A January row passed a 14-day window.
    //
    // Which inverted the safety property: an issue with N `unavailable` runs anywhere
    // that year carried an N-attempt discount forever — `MAX_REDISPATCH` silently
    // raised to 2 + N, the un-exhausting direction this change exists to prevent.
    const now = Date.parse('2026-09-04T12:00:00Z');
    const since = unreachedWindowStart(now, 14);
    expect(since, 'the bound is in the sort key\'s own format').toMatch(/^\d{8}T\d{6}Z$/);

    const included = (sk: string) => sk > since;
    expect(included('20260902T120000Z'), 'two days ago').toBe(true);
    expect(included('20260822T000000Z'), 'just inside').toBe(true);
    expect(included('20260805T120000Z'), 'thirty days ago').toBe(false);
    expect(included('20260103T000000Z'), 'January of the same year').toBe(false);
    expect(included('20251230T000000Z'), 'last year').toBe(false);
  });

  it('agrees with the format the store writer actually stamps', () => {
    // `push-run.sh`'s `date -u +%Y%m%dT%H%M%SZ` default (Kanon's AWS store) and the adopter's
    // collector are the producers of `COST#` sort keys, and the artifact reader stamps its rows
    // the same way. If either changes shape, the window silently stops filtering again.
    const sh = readFileSync(join(ROOT, 'infra/qa-store/aws/push-run.sh'), 'utf8');
    expect(sh).toMatch(/date -u \+%Y%m%dT%H%M%SZ/);
    expect(costStamp(Date.parse('2026-09-04T12:02:45.050Z'))).toBe('20260904T120245Z');
  });

  describe('a row discounts only the dispatch that triggered it (RA-1579)', () => {
    // Sweep comments at T1 and T3, a day apart. Each row below is `unavailable`.
    const T1 = Date.parse('2026-09-01T00:00:00Z');
    const T3 = Date.parse('2026-09-02T00:00:00Z');
    const markers = new Map([[7, [T1, T3]]]);
    const row = (ts: string, run_id = '1') => ({ ts, issue_number: '7', outcome: 'unavailable', run_id });
    const bySweep = () => true;

    it('does not subtract a run from before the sweep ever spoke', () => {
      // The RA-1573 floor, preserved: a row older than the FIRST marker is never a sweep's.
      const rows = [row('20260831T000000Z'), row('20260901T000500Z')];
      expect(unreachedByIssue(rows, [7], { markers, triggeredBySweep: bySweep }).get(7), 'only the later run counts').toBe(1);
    });

    it('THE RA-1579 SHAPE: a human re-label between two sweep dispatches discounts nothing', () => {
      // T1 sweep (reached the model) → T2 a human re-applies the label and THAT run is
      // `unavailable` → T3 sweep (reached the model). The count-vs-count subtraction
      // charged 2 − 1 = 1 and the cap receded. Hours after T1 is outside its window,
      // and the run was triggered by a person.
      const human = row('20260901T120000Z', '555');
      expect(unreachedByIssue([human], [7], { markers, triggeredBySweep: bySweep }).size, 'outside every window').toBe(0);
      const soonAfter = row('20260901T001000Z', '555');
      const actorIsSweep = (r: { run_id: string }) => r.run_id !== '555';
      expect(unreachedByIssue([soonAfter], [7], { markers, triggeredBySweep: actorIsSweep }).size, 'in the window, but a human triggered it').toBe(0);
    });

    it('lets each marker discount at most itself', () => {
      // Three rows behind ONE sweep comment is one dispatch, not three.
      const rows = [row('20260901T000500Z', '1'), row('20260901T000600Z', '2'), row('20260901T000700Z', '3')];
      expect(unreachedByIssue(rows, [7], { markers: new Map([[7, [T1]]]), triggeredBySweep: bySweep }).get(7)).toBe(1);
      // And with two markers, a row can only be claimed once.
      expect(unreachedByIssue([row('20260901T000500Z')], [7], { markers, triggeredBySweep: bySweep }).get(7)).toBe(1);
      expect(unreachedByIssue([row('20260901T000500Z'), row('20260902T000500Z', '2')], [7], { markers, triggeredBySweep: bySweep }).get(7)).toBe(2);
    });

    it('charges a same-second tie and a row past the window — the safe direction', () => {
      expect(unreachedByIssue([row('20260901T000000Z')], [7], { markers, triggeredBySweep: bySweep }).size, 'tie').toBe(0);
      const late = new Date(T1 + (PAIR_WINDOW_MINUTES + 1) * 60_000).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
      expect(unreachedByIssue([row(late)], [7], { markers, triggeredBySweep: bySweep }).size, 'one minute past the window').toBe(0);
      const inside = new Date(T1 + (PAIR_WINDOW_MINUTES - 1) * 60_000).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
      expect(unreachedByIssue([row(inside)], [7], { markers, triggeredBySweep: bySweep }).get(7), 'one minute inside it').toBe(1);
    });

    it('discounts nothing for an issue the sweep never dispatched', () => {
      expect(unreachedByIssue([row('20260901T000500Z')], [7], { triggeredBySweep: bySweep }).size).toBe(0);
    });

    it('DEFAULTS to charging: with no trigger check, no row is the sweep’s', () => {
      expect(unreachedByIssue([row('20260901T000500Z')], [7], { markers }).size).toBe(0);
    });

    it('skips a row with no timestamp rather than assuming it is recent', () => {
      const rows = [{ ts: null, issue_number: '7', outcome: 'unavailable', run_id: '1' }];
      expect(unreachedByIssue(rows, [7], { markers, triggeredBySweep: bySweep }).size, 'unattributable is not a free attempt').toBe(0);
      expect(parseCostStamp('2026-09-01T00:05:00Z'), 'extended ISO is not a store key').toBeNull();
      expect(parseCostStamp('20260901T000500Z')).toBe(Date.parse('2026-09-01T00:05:00Z'));
    });

    it('reads the triggering actor from the run, and fails closed', () => {
      const calls: string[][] = [];
      const json = (args: string[]) => {
        calls.push(args);
        if (args[1].endsWith('/1')) return { triggering_actor: { login: `${SWEEP_LOGIN}[bot]` } };
        if (args[1].endsWith('/2')) return { triggering_actor: { login: 'a-human' } };
        throw new Error('HTTP 502');
      };
      const check = makeSweepTriggerCheck({ json });
      expect(check({ run_id: '1' }), 'the sweep’s App, [bot] suffix and all').toBe(true);
      expect(check({ run_id: '2' }), 'a person').toBe(false);
      expect(check({ run_id: '3' }), 'unreadable is not the sweep').toBe(false);
      expect(check({ run_id: null }), 'no run id is not the sweep').toBe(false);
      expect(check({ run_id: '1' })).toBe(true);
      expect(calls.filter((a) => a[1].endsWith('/1')), 'memoised per run').toHaveLength(1);
    });
  });

  it('the step summary explains a discounted attempt count', () => {
    // The re-dispatch COMMENT explains it only on states that re-dispatch, so
    // `in-flight` and `awaiting-human` never carry it — and the step summary is what
    // a human reads during an outage.
    expect(attemptsCell({ redispatches: 1, maxRedispatch: 2, unreached: 1 })).toBe('1/2 (−1 unreached)');
    expect(attemptsCell({ redispatches: 2, maxRedispatch: 2, unreached: 0 }), 'silent when nothing was discounted').toBe('2/2');
  });

  it('the store read is bounded and read-only', () => {
    // The query moved into Kanon's AWS store action at P9 (`queryCostRows`), and the sweep's
    // direct read calls it; `qa-store-aws.test.ts` asserts its exact argv. This holds the
    // bound on the source: projected, windowed, and never a write.
    const src = readFileSync(join(ROOT, 'infra/qa-store/aws/cost-rows.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('export function queryCostRows'), src.indexOf('const cause ='));
    expect(fn).toContain("'dynamodb', 'query'");
    expect(fn, 'projected, and to the constant').toMatch(/'--projection-expression', COST_PROJECTION/);
    expect(fn, 'and windowed, since the partition grows without bound').toMatch(/sk > :s/);
    expect(fn, 'it must never write').not.toMatch(/put-item|update-item|delete-item|batch-write/);
  });

  it('the projection bound is the four attributes the sweep reads (RA-1586)', () => {
    // The reference adopter also holds its records of this bound to the constant; those
    // records are its documents, not Kanon's.
    expect(COST_PROJECTION).toEqual(['sk', 'issue_number', 'outcome', 'run_id']);
  });

  it('each lane names the telemetry agent whose partition holds its runs', () => {
    // TWO IDENTIFIERS FOR ONE ACTOR, and conflating them queries a partition that does
    // not exist and silently finds nothing — which fails closed, so it would look
    // exactly like "no capped runs" forever.
    for (const lane of LANES) {
      expect(lane.telemetryAgent, `${lane.key} needs a telemetry agent name`).toBeTruthy();
      expect(lane.telemetryAgent, 'which is NOT the App login').not.toBe(lane.agent);
    }
    // Both lanes are Kanon's, and call the spine with the agent name the telemetry row is
    // written under and the issue it was dispatched for.
    for (const lane of LANES) {
      const doc = parse(readFileSync(join(ROOT, '.github/workflows', lane.workflow), 'utf8')) as {
        jobs: Record<string, { uses?: string; with?: Record<string, string> }>;
      };
      const calls = Object.values(doc.jobs).filter((j) => j.uses === '$/.github/workflows/agent-lane.yml');
      expect(calls, `${lane.workflow} calls the spine once`).toHaveLength(1);
      expect(calls[0]!.with?.agent, `${lane.workflow} must write rows under the name the sweep queries`).toBe(lane.telemetryAgent);
      expect(calls[0]!.with?.['issue-number'], `${lane.workflow} must record the issue it was dispatched for`)
        .toMatch(/github\.event\.issue\.number/);
    }
  });
});

describe('the mass-strip circuit breaker (RA-916)', () => {
  // VERDICTS ARE BUILT BY `classify()`, NOT BY HAND. The first version of these tests
  // wrote `{ state: 'never-ran', act: 'stop' }` — a shape the producer CANNOT emit,
  // because the stop path relabels the state to `exhausted`. So the fleet-wide arm
  // keyed on `state === 'never-ran'`, which forbids any verdict being a stop, and the
  // arm could only ever be true in a run with nothing to withhold: a warning with an
  // empty body. The tests passed because they built the world the code wanted.
  //
  // That is the RA-917 mistake in this same PR, made inside the fix for RA-916.
  const H = 3600e3;
  const now = Date.now();
  const issue = (number: number) => ({ number, title: `t${number}`, createdAt: new Date(now - 500 * H).toISOString() });
  const sweepAt = (h: number) => ({ login: SWEEP_LOGIN, body: `x ${MARKER}`, createdAt: new Date(now - h * H).toISOString() });
  const agentAt = (h: number) => ({ login: AGENT_LOGIN, body: asAgent(AGENT_LOGIN, 'built it'), createdAt: new Date(now - h * H).toISOString() });
  const humanAt = (h: number) => ({ login: 'geoffry', body: 'stop, this needs design', createdAt: new Date(now - h * H).toISOString() });

  /** An issue the implementer never answered, at the re-dispatch cap -> exhausted/stop. */
  const fleetDown = (n: number) => classify(issue(n), [sweepAt(300), sweepAt(200)], false, { now });
  /** An issue the agent HAS spoken on, so the fleet-wide signal does not apply. */
  const answered = (n: number) => classify(issue(n), [sweepAt(300), sweepAt(200), agentAt(100)], false, { now });
  /** One dispatch spent, cap not reached -> never-ran/dispatch, still agent-silent. */
  const dispatched = (n: number) => classify(issue(n), [sweepAt(300)], false, { now });
  /** A PR exists but the agent never commented -> has-pr/null, agent-silent. */
  const withPr = (n: number) => classify(issue(n), [sweepAt(300), sweepAt(200)], true, { now });
  /** A human answered the sweep in prose -> human-held/null, agent-silent. */
  const heldDown = (n: number) => classify(issue(n), [sweepAt(300), humanAt(250)], false, { now });

  it('the producer relabels a stop to `exhausted` — the fact the breaker needs is `sawAgent`', () => {
    const v = fleetDown(1);
    expect(v.act).toBe('stop');
    expect(v.state, 'the stop path replaces the state').toBe('exhausted');
    expect(v.sawAgent, 'which is why the underlying fact is carried separately').toBe(false);
    expect(answered(2).sawAgent).toBe(true);
  });

  it('lets a normal run through', () => {
    expect(breakerTripped([fleetDown(1), answered(2), answered(3)]).tripped).toBe(false);
  });

  it('holds when EVERY open issue has never heard from the agent', () => {
    // THE CASE THAT WAS UNREACHABLE. Two issues, both stop-bearing, implementer down:
    // before the fix this returned `{tripped:false}` and stripped both labels.
    const r = breakerTripped([fleetDown(1), fleetDown(2)]);
    expect(r.tripped).toBe(true);
    // "agent", not "implementer": with the triage lane on the same App (RA-1336) the
    // outage this describes is not specific to the implement half.
    expect(r.reason).toMatch(/evidence about the agent/);
  });

  it('holds when one run would stop more than the bound', () => {
    const r = breakerTripped([fleetDown(1), fleetDown(2), fleetDown(3)]);
    expect(r.tripped).toBe(true);
  });

  it('does NOT become the stall — a lone stuck issue is still stopped', () => {
    // The check RA-916 asks for: a breaker that never opens means genuinely-unbuildable
    // issues keep the label forever, which is the state RA-912 was filed to end.
    expect(breakerTripped([fleetDown(1)]).tripped).toBe(false);
  });

  it('is a bound on one RUN, not a latch', () => {
    const held = [fleetDown(1), fleetDown(2), fleetDown(3)];
    expect(breakerTripped(held).tripped).toBe(true);
    expect(breakerTripped([held[0], answered(4), answered(5)]).tripped).toBe(false);
  });

  it('never withholds a dispatch — only a stop', () => {
    // WAS A TEST OF THE MESSAGE, NOT THE BEHAVIOUR (RA-1272). It asserted the reason
    // string contains `Re-dispatch is unaffected`; the behaviour it names lived in
    // `main`'s filter, which no test reached. A run could have withheld every action
    // and this stayed green.
    // PRODUCER-BUILT, not overridden (RA-1527). This block's own preamble forbids
    // hand-built verdicts — it is the RA-917 lesson — and the first version of these
    // three spread `classify()` output and then overwrote `act`. Harmless only for as
    // long as the producer happens to agree; an override outlives that agreement
    // silently, which is the whole failure the preamble describes.
    const verdicts = [fleetDown(1), dispatched(2), heldDown(3)];
    expect(verdicts.map((v) => v.act), 'the shapes must come from the producer')
      .toEqual(['stop', 'dispatch', null]);
    const { tripped } = breakerTripped(verdicts);
    expect(tripped, 'the fleet-wide arm must actually be open for this to test anything').toBe(true);
    const acted = actionable(verdicts, tripped);
    expect(acted.map((v: { act: string }) => v.act), 'the dispatch survives, the stop does not').toEqual(['dispatch']);
  });

  it('acts on everything when the breaker is shut', () => {
    // NON-VACUITY: a filter that dropped stops unconditionally would pass the test
    // above and be catastrophically wrong.
    const verdicts = [fleetDown(1), dispatched(2)];
    expect(actionable(verdicts, false).map((v: { act: string }) => v.act)).toEqual(['stop', 'dispatch']);
  });

  it('never returns a verdict with no action to take', () => {
    expect(actionable([heldDown(1)], false), 'a verdict with no action is not acted on').toEqual([]);
  });

  it('the warning describes the fact the code TESTED, not a state it cannot produce', () => {
    // The reason said "every open issue classified `never-ran`" while the predicate
    // keys on `sawAgent`. By the time a verdict carries `act: 'stop'` its state has
    // been relabelled `exhausted`, so no run could ever produce the classification the
    // operator was told to look for — and the step summary showed `exhausted` beside it.
    const r = breakerTripped([fleetDown(1), fleetDown(2)]);
    expect(r.reason).toMatch(/no open .* issue has EVER had a comment from the agent/);
    expect(r.reason, 'and must not name the state it deliberately stopped reading').not.toMatch(/never-ran/);
  });

  it('counts a has-pr issue towards the fleet-wide arm, deliberately', () => {
    // MEASURED, NOT ASSUMED (RA-1272). `has-pr` with no agent comment is reachable —
    // 8 of 112 closed `agent:implement` issues that carried a PR had none, measured
    // over the whole population on 2026-09-04 (two earlier attempts sampled 40 of 114
    // and reported it as a population fact) — and a
    // human-opened PR is poor evidence that the implementer is down, so excluding it
    // looks like a strict improvement. It is not: on a fleet outage of three issues
    // where two happen to carry a PR, excluding them drops the trip and STRIPS the
    // labels this arm exists to protect. A withheld stop leaves the label on and
    // visible until the fleet-wide condition clears — not merely next run (RA-1534); a
    // stripped one is gone. Only one of the two directions is recoverable.
    const outage = [fleetDown(1), withPr(2), withPr(3)];
    expect(outage.map((v) => v.state), 'producer-built, not overridden (RA-1527)')
      .toEqual(['exhausted', 'has-pr', 'has-pr']);
    expect(outage.every((v) => v.sawAgent === false), 'and all agent-silent').toBe(true);
    expect(breakerTripped(outage).tripped, 'the PRs must not exempt the fleet from the check').toBe(true);
  });

  it('counts a human-held issue towards the fleet-wide arm too, deliberately', () => {
    // ASSERTED IN THREE PLACES AND LOCKED IN NONE (RA-1527). PR RA-1526 recorded the
    // decision to keep `has-pr` AND `human-held` in the fleet-wide arm — in the code
    // comment, in `docs/observability.md` and in a test — but the test covered
    // `has-pr` only, so half the recorded decision had nothing holding it.
    //
    // `human-held` reaches `sawAgent === false` the same way: a human answering the
    // sweep in prose, with the agent never having spoken. Same argument as `has-pr`:
    // excluding it would drop the trip on a real outage that happens to contain one,
    // and a withheld stop is recoverable where a stripped label is not.
    const outage = [fleetDown(1), heldDown(2), heldDown(3)];
    expect(outage.map((v) => v.state)).toEqual(['exhausted', 'human-held', 'human-held']);
    expect(outage.every((v) => v.sawAgent === false)).toBe(true);
    expect(breakerTripped(outage).tripped, 'a human hold must not exempt the fleet').toBe(true);
  });

  it('and a mixed fleet of both non-waiting states still trips', () => {
    // The two states together, which is what a real outage looks like once a couple of
    // issues have moved on.
    const outage = [fleetDown(1), withPr(2), heldDown(3)];
    expect(breakerTripped(outage).tripped).toBe(true);
  });
});

describe('hand-built gh --json fixtures match what gh actually returns (RA-917)', () => {
  // TWICE IN ONE PR a hand-built fixture omitted or mis-shaped the exact field the
  // code reads, and the tier stayed green over a broken predicate:
  //
  //   1. the `linkedPrIndex` factory had no `body`/`title`, so the three "does NOT
  //      match a bare mention" assertions — the whole point of the test — passed
  //      against the buggy predicate they existed to outlaw;
  //   2. the code compared `ref.repository.nameWithOwner`, a field `gh` does not emit.
  //      Every same-repo reference compared `undefined !== REPO`, so the entire
  //      `closingIssuesReferences` arm was skipped: 23 live references, 0 indexed.
  //      Both the positive and negative fixtures were written to that invented shape,
  //      so the tier could not see it.
  //
  // Both were caught by a reviewer running a node harness against the live API, which
  // is not a repeatable guard. These payloads are RECORDED FROM THE REAL API and
  // committed, so the unit tier needs no network.
  const load = (f: string) =>
    JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/gh', f), 'utf8'));

  it('the recorded payloads are present and non-empty', () => {
    // A deleted or emptied recording must fail loudly rather than vacuously passing
    // every assertion below — the stale-golden-file problem one level up.
    for (const f of ['pr-list-linked.json', 'issue-list-basic.json', 'issue-comments.json']) {
      const data = load(f);
      expect(Array.isArray(data) ? data.length : Object.keys(data).length, `${f} is empty`)
        .toBeGreaterThan(0);
    }
  });

  it('every field path the sweep reads exists in the real payload', () => {
    // Explicit — this is the half that is NOT automatic, and the half that catches an
    // INVENTED field name in the code (instance 2). Checked against a real recording
    // rather than against another hand-built object.
    const prs = load('pr-list-linked.json');
    expect(Object.keys(prs[0])).toEqual(expect.arrayContaining(['number', 'headRefName', 'closingIssuesReferences']));

    const ref = prs.flatMap((p: { closingIssuesReferences?: unknown[] }) => p.closingIssuesReferences ?? [])[0];
    if (ref) {
      expect(Object.keys(ref)).toEqual(expect.arrayContaining(['number', 'repository']));
      expect(Object.keys(ref.repository)).toEqual(expect.arrayContaining(['name', 'owner']));
      expect(Object.keys(ref.repository.owner)).toContain('login');
      expect(ref.repository, 'nameWithOwner does not exist — the field instance 2 compared')
        .not.toHaveProperty('nameWithOwner');
    }

    // Re-recorded for RA-1262 with `labels`, the field the terminal-verdict check reads —
    // `gh issue list … --json number,title,createdAt,labels`, the sweep's own call shape.
    expect(Object.keys(load('issue-list-basic.json')[0]))
      .toEqual(expect.arrayContaining(['number', 'title', 'createdAt', 'labels']));

    const c = load('issue-comments.json').comments[0];
    expect(Object.keys(c)).toEqual(expect.arrayContaining(['body', 'createdAt', 'author']));
    expect(Object.keys(c.author), 'the sweep classifies on author.login').toContain('login');
  });

  it('the real predicate resolves a closing reference in the recorded payload', () => {
    // THE HALF THAT ACTUALLY BITES. Reading `Object.keys` documents a shape without
    // exercising anything — my first version asserted a three-key literal declared two
    // lines above its own assertion, so `built` WAS the list it claimed not to be.
    //
    // This runs the shipped `linkedPrIndex` over the recording, with the
    // `headRefName` arm neutralised so only the `closingIssuesReferences` path can
    // answer. Under the `nameWithOwner` predicate that instance 2 shipped, this
    // returns `undefined` — every same-repo reference compared `undefined !== REPO`
    // and the whole arm was skipped.
    const prs = load('pr-list-linked.json').map((p: { headRefName?: string }) => ({ ...p, headRefName: '' }));
    expect(linkedPrIndex(prs)(195)?.number).toBe(231);
  });

  // A field `gh` REMOVES later still reads as present in a recording until it is
  // re-recorded — so the SWEEP checks each live payload against `READ_SHAPES` and warns
  // on the run (RA-1262). These cases hold that constant and the recordings in agreement,
  // and prove the runtime check fires. Refresh by re-running the `gh ... --json` calls
  // in `.kanon/scripts/dispatch-sweep.mjs` and committing the output.
  const RECORDING_FOR = {
    'pr list': 'pr-list-linked.json',
    'issue list': 'issue-list-basic.json',
    'issue comments': 'issue-comments.json',
  } as const;

  it('READ_SHAPES names only paths the real recordings carry, for every payload kind', () => {
    expect(Object.keys(READ_SHAPES).sort()).toEqual(Object.keys(RECORDING_FOR).sort());
    for (const [kind, file] of Object.entries(RECORDING_FOR)) {
      const shape = READ_SHAPES[kind as keyof typeof READ_SHAPES];
      expect(shape.length, kind).toBeGreaterThan(0);
      const have = keyPaths(load(file));
      for (const path of shape) expect(have.has(path), `${kind}: ${path} absent from ${file}`).toBe(true);
      expect(shapeDrift(load(file), shape), kind).toEqual([]);
    }
  });

  it('the runtime drift check reports a field gh stopped emitting (RA-1262)', () => {
    const prs = load('pr-list-linked.json');
    for (const pr of prs) for (const ref of pr.closingIssuesReferences ?? []) delete ref.repository.owner.login;
    expect(shapeDrift(prs, READ_SHAPES['pr list'])).toEqual(['[].closingIssuesReferences[].repository.owner.login']);

    const c = load('issue-comments.json');
    for (const x of c.comments) delete x.author;
    expect(shapeDrift(c, READ_SHAPES['issue comments'])).toEqual(['comments[].author.login']);
  });

  it('does not read an empty list as drift', () => {
    expect(shapeDrift([{ number: 1, headRefName: 'x', closingIssuesReferences: [] }], READ_SHAPES['pr list'])).toEqual([]);
    expect(shapeDrift([], READ_SHAPES['issue list'])).toEqual([]);
    expect(shapeDrift({ comments: [] }, READ_SHAPES['issue comments'])).toEqual([]);
  });

  it('the sweep wires the drift check into every live fetch', () => {
    const src = readFileSync(join(ROOT, 'scripts/dispatch-sweep.mjs'), 'utf8');
    for (const kind of Object.keys(READ_SHAPES)) expect(src, kind).toContain(`noteDrift('${kind}'`);
  });
});

describe('the identity constants are checked where they can be (RA-918)', () => {
  // A wrong login is silent AND errs toward action: `isBot` reads an unrecognised login as a
  // person, which is the `answered` -> re-dispatch path. No unit test can catch the value
  // itself, because the fixtures are built from the same constants; the only ground truth is
  // the identity the token authenticates as. So the lane asserts its minted slug against
  // `SWEEP_LOGIN` (`dispatch-sweep-lane.test.ts` holds that step), and the implement lane's
  // check runs in the adopter's project-setup hook.
  it('exports the constants the workflows assert against', () => {
    // If either export is renamed, the lane's `node -e` prints `undefined`, the comparison
    // fails every run, and the fix is a rename rather than a mystery.
    expect(AGENT_LOGIN).toBeTruthy();
    expect(SWEEP_LOGIN).toBeTruthy();
  });
});


describe('the qa:needs-triage lane (RA-1336)', () => {
  // WHY THESE EXIST. RA-903 and RA-904 sat `qa:needs-triage` with zero comments for
  // twelve days after the 2026-08-19 hang, because this sweep reconciled one label
  // and the orphaned issues carried the other. Everything below asserts that the
  // second lane behaves like the first — the classifier is reused, so the risk is
  // not the logic but the WIRING: a lane that reads the wrong label, counts the
  // wrong comments, or churns the wrong label back on.

  const [implement, triage] = LANES;
  const at = (login: string, hours: number, body = 'hello') =>
    ({ login, createdAt: ago(hours), body: asAgent(login, body) });
  const bug = { number: 903, title: 'bug(admin): …', createdAt: ago(300) };
  const v = (comments: ReturnType<typeof at>[], lane = triage, opts = {}) =>
    classify(bug, comments, false, { now: NOW, lane, ...opts });

  it('reconciles qa:needs-triage, and that is the label it churns', () => {
    expect(triage.key).toBe('triage');
    expect(triage.label).toBe('qa:needs-triage');
    expect(triage.workflow).toBe('agent-triage.yml');
  });

  it('reads agent silence on a needs-triage bug as never-ran — the RA-903/#904 shape', () => {
    // Zero comments is exactly what RA-903 and RA-904 look like. Before this lane the
    // sweep never queried them at all, so this verdict had no way to exist.
    const r = v([]);
    expect(r.state).toBe('never-ran');
    expect(r.act).toBe('dispatch');
    expect(r.lane.label).toBe('qa:needs-triage');
  });

  it('does NOT re-dispatch a bug triage deliberately parked for human design', () => {
    // agent-triage.yml KEEPS qa:needs-triage when it decides a bug needs human
    // design. That is not a stall, and the discriminator is that the Implementer commented.
    const r = v([at(AGENT_LOGIN, 200, 'this needs a product decision first')]);
    expect(r.state).not.toBe('never-ran');
    expect(r.act).toBeNull();
  });

  it('re-fires when a human answered the triage agent and nothing restarted it', () => {
    const r = v([at(AGENT_LOGIN, 200, 'which behaviour is correct?'), at('a-human', 100, 'the second')]);
    expect(r.state).toBe('answered');
    expect(r.act).toBe('dispatch');
  });

  it('holds a bug whose human reply answered the SWEEP, not the agent', () => {
    const sweep = at(SWEEP_LOGIN, 200, `${MARKER}\n${laneTag(triage)}\nre-dispatching`);
    const r = v([sweep, at('a-human', 100, 'stop, this is by design')]);
    expect(r.state).toBe('human-held');
    expect(r.act).toBeNull();
  });

  it('counts attempts per lane — an implement attempt is not a triage attempt', () => {
    // The bug this prevents is a shared counter: an issue that exhausted its two
    // implement attempts would arrive in the triage lane already `exhausted` and be
    // stripped of `qa:needs-triage` without a single triage run.
    const implementAttempt = at(SWEEP_LOGIN, 300, `${MARKER}\n${laneTag(implement)}\nre-dispatching`);
    const r = v([implementAttempt, implementAttempt]);
    expect(r.redispatches, 'the triage lane must not count implement attempts').toBe(0);
    expect(r.state).toBe('never-ran');
  });

  it('stops after its own attempts are exhausted', () => {
    const attempt = (h: number) => at(SWEEP_LOGIN, h, `${MARKER}\n${laneTag(triage)}\nre-dispatching`);
    const r = v([attempt(300), attempt(200)]);
    expect(r.redispatches).toBe(2);
    expect(r.state).toBe('exhausted');
    expect(r.act).toBe('stop');
    expect(r.lane.stopLabel).toBe('qa:needs-info');
  });

  it('the human-held hold is per-lane — a ruling, not a side effect (RA-1383)', () => {
    // A human objected to the IMPLEMENT lane's sweep comment. The implement lane holds;
    // the triage lane, whose sweep never spoke, does not. The alternative (cross-lane)
    // would hold triage permanently on a question nobody asked it — see the ruling
    // beside `humanRepliedToSweep`. Changing this test means changing that paragraph.
    const implementSweep = at(SWEEP_LOGIN, 200, `${MARKER}\n${laneTag(implement)}\nre-dispatching`);
    const objection = at('a-human', 100, 'stop, this is by design');
    expect(v([implementSweep, objection], implement).state, 'the addressed lane holds').toBe('human-held');
    const other = v([implementSweep, objection], triage);
    expect(other.state, 'the other lane is not held').not.toBe('human-held');
    expect(other.act).toBe('dispatch');
    const src = readFileSync(join(ROOT, 'scripts/dispatch-sweep.mjs'), 'utf8');
    expect(src, 'the ruling is stated where the predicate is').toMatch(/THE HOLD IS PER-LANE, AND THAT IS A RULING/);
  });

  it('excludes EVERY lane’s sweep comments from the conversation', () => {
    // A cross-lane sweep comment read as a human reply would trip humanRepliedToSweep
    // and hold the issue forever — silent, and the exact failure mode this whole
    // script exists to end.
    const other = at(SWEEP_LOGIN, 100, `${MARKER}\n${laneTag(implement)}\nre-dispatching`);
    const r = v([other]);
    expect(r.state).toBe('never-ran');
  });
});

describe('lane comment tagging (RA-1336)', () => {
  const [implement, triage] = LANES;

  it('reads an UNTAGGED marker comment as the legacy implement lane', () => {
    // Every sweep comment written before RA-1336 is untagged. Reading that history as
    // "belongs to no lane" would reset every issue's attempt count to zero and
    // re-dispatch issues that had already exhausted their budget.
    const legacy = `${MARKER}\nre-dispatching`;
    expect(isLaneComment(legacy, implement)).toBe(true);
    expect(isLaneComment(legacy, triage)).toBe(false);
  });

  it('keeps tagged comments in their own lane', () => {
    const tagged = `${MARKER}\n${laneTag(triage)}\nre-dispatching`;
    expect(isLaneComment(tagged, triage)).toBe(true);
    expect(isLaneComment(tagged, implement)).toBe(false);
  });

  it('never claims a comment that is not the sweep’s at all', () => {
    expect(isLaneComment('a human wrote this', implement)).toBe(false);
    expect(isLaneComment(laneTag(triage), triage), 'the marker is still required').toBe(false);
  });

  it('gives every lane a distinct tag, and none a prefix of another', () => {
    // `body.includes()` is substring matching, so a tag that prefixes another would
    // silently merge two lanes’ attempt counts.
    const tags = LANES.map(laneTag);
    expect(new Set(tags).size).toBe(LANES.length);
    for (const a of tags) for (const b of tags) {
      if (a !== b) expect(a.includes(b), `${a} contains ${b}`).toBe(false);
    }
  });

  it('has exactly one legacy lane — a second would inherit untagged history', () => {
    expect(LANES.filter((l: { legacy: boolean }) => l.legacy)).toHaveLength(1);
  });
});


describe('a terminal triage verdict leaves the lane (RA-1380)', () => {
  // ANSWERED LEAVES, WAITING STAYS. `qa:needs-triage` is the lane's membership query,
  // so an issue keeps it until something removes it — and on `qa:cannot-reproduce` /
  // `qa:false-positive` the triage question is settled. Left in, it classifies
  // `awaiting-human` forever (a daily warning no human action clears) and sits one
  // human reply away from `answered` -> re-firing an 80-minute job with Postgres and
  // Chromium on a closed question.
  const [implement, triage] = LANES;
  const at = (login: string, hours: number, body = 'hello') =>
    ({ login, createdAt: ago(hours), body: asAgent(login, body) });
  const bug = (labels: string[]) =>
    ({ number: 903, title: 'bug(x)', createdAt: ago(300), labels: labels.map((name) => ({ name })) });
  const v = (labels: string[], comments: ReturnType<typeof at>[] = [], hasPr = false) =>
    classify(bug(labels), comments, hasPr, { now: NOW, lane: triage });

  it.each(['qa:cannot-reproduce', 'qa:false-positive'])(
    '%s is settled, and no action is taken', (label) => {
      const r = v(['bug', 'qa:needs-triage', label], [at(AGENT_LOGIN, 200, 'could not reproduce')]);
      expect(r.state).toBe('triage-settled');
      expect(r.act).toBeNull();
    });

  it('does not emit the awaiting-human warning that nobody could clear', () => {
    // The warning is the lane's only human-attention signal; a growing floor of
    // settled issues is what makes it stop being read.
    expect(v(['qa:needs-triage', 'qa:false-positive'], [at(AGENT_LOGIN, 300)]).state)
      .not.toBe('awaiting-human');
  });

  it('closes the wasted-re-dispatch path — a human agreeing is not an answer to re-fire on', () => {
    // Without this, the last non-sweep comment being a non-bot reaches `answered`.
    const r = v(
      ['qa:needs-triage', 'qa:false-positive'],
      [at(AGENT_LOGIN, 300, 'not a bug'), at('a-human', 100, 'agreed, not a bug')]);
    expect(r.state).toBe('triage-settled');
    expect(r.act).toBeNull();
  });

  it('outranks has-pr — the verdict is about the TRIAGE, not about the work', () => {
    expect(v(['qa:needs-triage', 'qa:cannot-reproduce'], [], true).state).toBe('triage-settled');
  });

  it('leaves the SCOPE-FIRST bail in the lane, which is the deliberate keep', () => {
    // agent-triage.yml keeps the label on purpose for a human-design hand-off. That is
    // a real hand-off and must still surface; only the two terminal labels exit.
    const r = v(['bug', 'qa:needs-triage'], [at(AGENT_LOGIN, 300, 'needs human design')]);
    expect(r.state).toBe('awaiting-human');
  });

  it('does NOT treat qa:reproduced as terminal — triage found a bug and is proceeding', () => {
    expect(v(['qa:needs-triage', 'qa:reproduced'], [at(AGENT_LOGIN, 300)]).state)
      .toBe('awaiting-human');
  });

  it('still re-dispatches an untriaged bug — the lane keeps working', () => {
    // The RA-903/#904 case must survive this change untouched.
    expect(v(['bug', 'qa:needs-triage'], [])).toMatchObject({ state: 'never-ran', act: 'dispatch' });
  });

  it('never applies triage\'s verdicts to the implement lane, whose one terminal label is a human\'s park (kanon#170)', () => {
    // The implement lane's only terminal label is `qa:needs-info`, which a human adds to park
    // an issue, and an issue carrying it reports `parked`, not `triage-settled`
    // (`dispatch-sweep-park.test.ts` holds the park itself). Triage's two verdicts mean
    // nothing to it: inventing them for this lane would be guessing.
    expect(implement.terminal).toEqual(['qa:needs-info']);
    expect(implement.settled).toBe('parked');
    expect(triage.terminal).toEqual(['qa:cannot-reproduce', 'qa:false-positive']);
    for (const label of triage.terminal ?? []) expect(terminalVerdict(bug([label]), implement), label).toBe(false);
    expect(terminalVerdict(bug(['qa:needs-info']), implement)).toBe(true);
  });

  it('tolerates both gh label shapes and a missing labels field', () => {
    expect(terminalVerdict({ labels: ['qa:false-positive'] }, triage)).toBe(true);
    expect(terminalVerdict({ labels: [{ name: 'qa:false-positive' }] }, triage)).toBe(true);
    expect(terminalVerdict({}, triage)).toBe(false);
  });
});

describe('the attempt count and its floor come from ONE snapshot (RA-1587)', () => {
  // Since RA-1573 `main()` reads an issue's comments twice per lane — once for the
  // unreached floor, once in the classify loop — and the comment that change added
  // claims both halves of `max(0, dispatched - unreached)` describe one set. With two
  // fetches that was true by construction rather than by fact.
  const payload = { comments: [{ author: { login: AGENT_LOGIN }, createdAt: '2026-09-01T00:00:00Z', body: 'hi' }] };

  it('fetches an issue once however many times a run asks', () => {
    const calls: string[][] = [];
    const read = makeCommentsReader({ json: (args: string[]) => { calls.push(args); return payload; } });
    const a = read(7);
    const b = read(7);
    expect(calls.length, 'one fetch, so the two reads cannot disagree').toBe(1);
    expect(b, 'and the same snapshot, identically').toBe(a);
  });

  it('still reads each distinct issue', () => {
    const calls: string[][] = [];
    const read = makeCommentsReader({ json: (args: string[]) => { calls.push(args); return payload; } });
    read(7); read(8); read(7);
    expect(calls.length).toBe(2);
  });

  it('is per-run, not module-global — two readers do not share a snapshot', () => {
    // Scoped structurally rather than by remembering to reset: a snapshot must never
    // survive into a later run, where the sweep's own marker comments would be missing.
    let n = 0;
    const json = () => { n += 1; return payload; };
    makeCommentsReader({ json })(7);
    makeCommentsReader({ json })(7);
    expect(n).toBe(2);
  });
});

describe('the sweep carries its own redactor, and it must not drift (RA-1945)', () => {
  // `SweepFatal`'s message reaches a `::error` annotation and, via `stop()`, a comment
  // on a public issue — the same exposure `lead-reconcile.mjs` guards, through a second
  // copy of the same function. Until RA-1284's two copies are deduplicated, only a test
  // that reads BOTH files can tell that fixing one fixed the other: the copy here had
  // no coverage at all, so the narrow body class survived here even once the reconciler
  // was tested.
  const sourceOf = (file: string) =>
    readFileSync(join(ROOT, 'scripts', file), 'utf8');

  /** The whole `.replace(...)` chain, from the declaration to the line that ends it.
   *
   *  Deliberately NOT the declaration line itself: the two copies name their parameter
   *  differently (`str` here, `s` in the reconciler), so a byte comparison that included
   *  it could never pass and the test would have to be weakened to compensate. Everything
   *  below that line is what has to stay identical, and all of it is compared.
   *
   *  The first version of this matched ONE rule — the `gh[pousr]_` literal — which RA-1955
   *  is: its name promised parity and it delivered a spot check, so narrowing only the
   *  sweep's `github_pat_` class left the suite green. */
  const rulesOf = (src: string) => {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.startsWith('export const redactSecrets = '));
    if (start < 0) return null;
    const rules: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      rules.push(lines[i]);
      if (lines[i].trimEnd().endsWith(';')) break;
    }
    return rules.join('\n');
  };

  it('matches the reconciler byte for byte, across every rule', () => {
    const [mine, theirs] = ['dispatch-sweep.mjs', 'lead-reconcile.mjs'].map((f) => rulesOf(sourceOf(f)));
    expect(mine, 'the sweep still declares a redactor to compare').toBeTruthy();
    expect(mine).toBe(theirs);

    // Count them too, or the assertion above is satisfiable by deleting the same rule
    // from both copies — identical, and identically unguarded.
    expect(mine?.match(/\.replace\(/g)?.length, 'shape, PAT and basic-auth').toBe(3);
  });

  it('redacts a stateless installation token whole', () => {
    // A ~520-character `ghs_` JWT: two dots, base64url `-`/`_` in the segments. A body
    // class of `[A-Za-z0-9]` stops at the first dot and leaves the payload and part of
    // the signature in the annotation.
    const payload = 'eyJpbnN0YWxsYXRpb25faWQiOjEyMzQ1Njc4OSwiZXhwIjoxNzk5OTk5OTk5fQ';
    const token = `ghs_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.c2ln-bmF0dXJl_cGFydA-aGVyZQ`;

    const out = redactSecrets(`remote: token ${token} rejected`);
    expect(out).toBe('remote: token gh?_«redacted» rejected');
    expect(out, 'the installation id and expiry ride in the payload segment').not.toContain(payload);

    expect(redactSecrets(`https://x-access-token:${token}@github.com/o/r`))
      .toBe('https://«redacted»@github.com/o/r');
  });

  it('leaves the classic format and a PAT redacted as before', () => {
    expect(redactSecrets('token ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 leaked'))
      .toBe('token gh?_«redacted» leaked');
    // The body carries an `_` — a fine-grained PAT is a 22-character prefix, an
    // underscore, then the secret. A fixture without one cannot tell this rule's
    // class from the shape rule's, and so cannot fail when the `_` is dropped.
    expect(redactSecrets('token github_pat_11ALAWJTY0abcdefghijklmn_o9PQrsTUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz012 leaked'))
      .toBe('token github_pat_«redacted» leaked');
  });
});

describe('RA-1781 — an issue whose latest run EXHAUSTED its cap is stopped, not re-dispatched', () => {
  const at = NOW - 2 * HOUR;
  const member = { ...issue, body: 'work\n\n<!-- qa:project 27 -->' };
  const tooBig = (comments: ReturnType<typeof comment>[], opts = {}, i: object = member) =>
    classify(i, comments, false, { now: NOW, exhaustedAt: at, ...opts });
  // Only a `too-big` verdict carries its own stop label; the union type says so.
  const labelOf = (v: object) => (v as { stopLabel?: string }).stopLabel;

  it('a silent issue after a capped run is `too-big`, stopped at once — no attempt spent', () => {
    const v = tooBig([]);
    expect(v.state).toBe('too-big');
    expect(v.act).toBe('stop');
    expect(v.redispatches, 'it cost no sweep attempt to find out').toBe(0);
  });

  it('a project member goes to the split lane; a non-member and a split child go to a human', () => {
    expect(labelOf(tooBig([]))).toBe('qa:needs-split');
    expect(labelOf(tooBig([], {}, { ...issue, body: 'no marker' }))).toBe('qa:needs-info');
    const child = { ...issue, body: 'work\n<!-- qa:split-of #1694 -->\n\n<!-- qa:project 27 -->' };
    expect(labelOf(tooBig([], {}, child))).toBe('qa:needs-info');
  });

  it('outranks the cooldown — the next run is already known to fail', () => {
    expect(tooBig([sweepComment(1)]).act).toBe('stop');
  });

  it('a HUMAN word after the capped run lifts it — that is the escape hatch', () => {
    const v = tooBig([comment(AGENT_LOGIN, 50), comment('a-human', 1, 'narrowed it, go again')]);
    expect(v.state).toBe('answered');
    expect(v.act).toBe('dispatch');
  });

  it('a human word from BEFORE the capped run does not', () => {
    expect(tooBig([comment(AGENT_LOGIN, 50), comment('a-human', 5)]).state).toBe('too-big');
  });

  it('only the implement lane decomposes — a triage run is in no brief', () => {
    const triage = LANES.find((l: { key: string }) => l.key === 'triage');
    expect(tooBig([], { lane: triage }).state).toBe('never-ran');
  });

  it('with no store reading it dispatches as before (null is the default)', () => {
    expect(classify(member, [], false, { now: NOW }).state).toBe('never-ran');
  });

  it('is evidence the agent RAN for the fleet-wide arm, but still counts toward the volume cap', () => {
    const v = tooBig([]);
    // Three silent never-ran issues and one too-big: the too-big is proof the agent is
    // up, so "no agent comment anywhere" no longer holds and the evidence arm is off.
    const quiet = [1, 2].map((n) => ({ ...verdict([]), issue: { ...issue, number: n } }));
    expect(breakerTripped([v, ...quiet]).tripped).toBe(false);
    // …but many stops in one run are a fleet-level smell (a lowered cap, a classifier
    // bug), so too-big stops count toward MAX_STOPS_PER_RUN and are withheld with the rest.
    const three = [v, { ...v, issue: { ...issue, number: 2 } }, { ...v, issue: { ...issue, number: 3 } }];
    const { tripped } = breakerTripped(three);
    expect(tripped).toBe(true);
    expect(actionable(three, tripped)).toEqual([]);
  });

  it('a capped run that SPOKE early is still too-big — it did not park, it ran out', () => {
    const early = comment(AGENT_LOGIN, 3, 'plan: …');
    expect(tooBig([early]).state, 'in-flight window').toBe('too-big');
    expect(tooBig([comment(AGENT_LOGIN, 60, 'plan')]).state, 'awaiting-human window').toBe('too-big');
  });

  it('an AGENT word after the capped run lifts it — a later run happened', () => {
    expect(tooBig([comment(AGENT_LOGIN, 1, 'later run')]).state).not.toBe('too-big');
  });

  it('the trigger label RE-APPLIED after the capped run lifts it — a re-run is under way', () => {
    expect(tooBig([], { labeledAt: at + 60_000 }).state).toBe('never-ran');
    expect(tooBig([], { labeledAt: at - 60_000 }).state, 'the label from before the run does not').toBe('too-big');
  });

  it('never overrides a PR, a human hold, or a settled triage verdict', () => {
    expect(classify(member, [], true, { now: NOW, exhaustedAt: at }).state).toBe('has-pr');
    // A human replied to the sweep's own comment, and the capped run came AFTER that
    // reply — so no word lifts it, and only `OWNED` keeps the hold.
    const held = [sweepComment(3), comment('a-human', 1, 'stop, this needs design')];
    expect(classify(member, held, false, { now: NOW, exhaustedAt: NOW - 0.5 * HOUR }).state).toBe('human-held');
    // `triage-settled` is a triage-lane state, and that lane never decomposes. `OWNED`
    // lists it anyway, so the rule holds if a decomposing lane ever gains a terminal verdict.
    const settled = { ...LANES.find((l: { key: string }) => l.key === 'triage')!, decomposes: true };
    const bug = { ...member, labels: [{ name: 'qa:false-positive' }] };
    expect(classify(bug, [], false, { now: NOW, exhaustedAt: at, lane: settled }).state).toBe('triage-settled');
  });
});

describe('RA-1781 — main wires the store reading and the body into classify', () => {
  // `main` needs `gh` and the store, so it is asserted by source — the pure half being
  // tested while nothing covers the derivation is the trap RA-1061 records.
  const src = readFileSync(join(ROOT, 'scripts/dispatch-sweep.mjs'), 'utf8');
  it('passes each issue its lane’s exhaustion time', () => {
    expect(src).toMatch(/const exhaustedAt = exhaustedPerLane\.get\(lane\.key\)\?\.get\(issue\.number\) \?\? null/);
    expect(src).toMatch(/lane\.decomposes \? exhaustedAtByIssue\(rowsPerLane\.get\(lane\.key\)/);
  });
  it('fetches the body, which is where the project and the lineage live', () => {
    expect(src).toContain("`number,title,createdAt,labels${lane.decomposes ? ',body' : ''}`");
  });
});

describe('RA-1781 — lastLabeledAt', () => {
  const ev = (event: string, name: string, t: string) => ({ event, label: { name }, created_at: t });
  it('is the latest `labeled` event for THAT label', () => {
    const e = [ev('labeled', 'agent:implement', '2026-09-20T00:00:00Z'), ev('unlabeled', 'agent:implement', '2026-09-22T00:00:00Z'),
      ev('labeled', 'agent:implement', '2026-09-21T00:00:00Z'), ev('labeled', 'bug', '2026-09-23T00:00:00Z')];
    expect(lastLabeledAt(e, 'agent:implement')).toBe(Date.parse('2026-09-21T00:00:00Z'));
    expect(lastLabeledAt([], 'agent:implement')).toBeNull();
  });
  it('an unreadable event list is `undefined`, which main turns into "no exhaustion"', () => {
    const read = makeLabeledAtReader({ json: () => { throw new Error('HTTP 502'); } });
    expect(read(1, 'agent:implement')).toBeUndefined();
    const src = readFileSync(join(ROOT, 'scripts/dispatch-sweep.mjs'), 'utf8');
    expect(src).toMatch(/exhaustedAt: labeledAt === undefined \? null : exhaustedAt/);
  });
});

describe('RA-1781 — exhaustedAtByIssue reads the LATEST row only', () => {
  const row = (sk: string, n: number, outcome: string) => ({ ts: sk, issue_number: String(n), outcome });

  it('names an issue whose latest row is `exhausted`, with that row’s time', () => {
    const m = exhaustedAtByIssue([row('20260920T100000Z', 7, 'ok'), row('20260921T100000Z', 7, 'exhausted')], [7]);
    expect(m.get(7)).toBe(Date.parse('2026-09-21T10:00:00Z'));
  });

  it('ignores an exhaustion a later run superseded, and issues not asked about', () => {
    const m = exhaustedAtByIssue([row('20260921T100000Z', 7, 'exhausted'), row('20260922T100000Z', 7, 'failed'), row('20260922T100000Z', 8, 'exhausted')], [7]);
    expect(m.size).toBe(0);
  });

  it('skips a row with no parseable stamp rather than letting it win or mask', () => {
    const m = exhaustedAtByIssue([row('20260921T100000Z', 7, 'exhausted'), row('garbage', 7, 'ok')], [7]);
    expect(m.has(7)).toBe(true);
  });
});
