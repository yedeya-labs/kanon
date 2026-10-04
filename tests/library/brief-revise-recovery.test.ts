import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
const { CONFLICT_WHY } = await import('../../scripts/conflict-state.mjs');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runWorkflowStep } from '../unit/helpers/workflow-step.js';
import { asOneWorkflow, readCaller, readKanonLane } from './helpers/kanon-lane.js';
const {
  BRIEF_PATH, LEAD_LOGIN, REVISE_LABEL, WORKFLOW,
  briefPrs, briefReviseRecovery, briefReviseRunsFor, normaliseLogin, report, standingChangesRequest,
} = await import('../../scripts/brief-revise-recovery.mjs');
import { writeStub } from '../unit/helpers/stub-bin.js';
import { ownRegister, runRegisterStep, withSlug, withoutRole } from '../unit/helpers/register-step.js';
import { ROOT } from './helpers/adopter.js';
/** A value of the untyped library, as the reference adopter's helper named it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibraryValue = any;

/**
 * RA-1595 — the brief PR's changes-request was a one-shot event with nothing behind it.
 *
 * The failure modes here are all "acted when it should not have": churned a head that
 * already has a run going, churned on an unreadable listing, churned a PR that is not
 * a brief or not the Lead's, or churned against a review he has already answered. The
 * decision is a pure function of the world it read, so every one of them is testable
 * without GitHub — which is the point, since the alternative is discovering them on
 * the developer's single gate.
 */

const HOURS = 4;
const NOW = Date.parse('2026-09-05T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type Review = { state: string; commit?: { oid: string }; submittedAt?: string; body?: string };
const pr = ({
  number = 1,
  login = 'app/example-lead',
  state = 'OPEN',
  files = [`${BRIEF_PATH}961.md`],
  headRefOid = 'aaaaaaa1',
  reviews = [{ state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(9) }] as Review[],
  // Declared on every fixture, because `conflictState` throws on a PR object that never
  // asked (RA-1722) — a fixture must not be able to skip the conflict gate silently.
  mergeStateStatus = 'CLEAN',
  mergeable = 'MERGEABLE',
} = {}) => ({
  number, author: { login }, state, files: files.map((path) => ({ path })), headRefOid, reviews,
  mergeStateStatus, mergeable,
});

/** No run has ever fired for this head — the state the recovery exists for. */
const noRuns = () => [];
const decide = (prs: unknown[], runsFor: (sha: string) => unknown[] | null = noRuns) =>
  briefReviseRecovery(prs, { runsFor, now: NOW, hours: HOURS });

describe('whose PRs this lane is even about', () => {
  it.each([
    ['app/example-lead', LEAD_LOGIN],
    ['example-lead[bot]', LEAD_LOGIN],
    ['example-lead', LEAD_LOGIN],
  ])('normalises %s', (raw, expected) => {
    // One identity, three spellings across three endpoints. Matching two of the three
    // is what made revise mode skip every dispatch for its first weeks — it failed
    // closed and said why, which is why nobody noticed.
    expect(normaliseLogin(raw)).toBe(expected);
  });

  it('takes his PRs that touch a brief, and only those', () => {
    const prs = [
      pr({ number: 1 }),
      pr({ number: 2, login: 'example-implementer' }),
      pr({ number: 3, files: ['src/x.ts'] }),
      pr({ number: 4, state: 'MERGED' }),
      pr({ number: 5, login: 'example-lead[bot]' }),
    ];
    expect(briefPrs(prs).map((p: { number: number }) => p.number)).toEqual([1, 5]);
  });
});

describe('which verdict counts as parked', () => {
  it('a changes-request standing on the current head does', () => {
    expect(standingChangesRequest(pr())?.state).toBe('CHANGES_REQUESTED');
  });

  it('a COMMENTED review landing after it does NOT clear it (RA-1081)', () => {
    // The reviewer-playbook permitted a COMMENT verdict on a red required check until
    // RA-2299, those reviews still stand, a standalone inline comment makes one, and a
    // brief PR is docs-only — its checks are the ones most likely to be red for
    // reasons the brief did not cause. Taking the last review regardless would read a
    // trailing COMMENTED as an answer and decide the brief is not parked.
    const p = pr({ reviews: [
      { state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(9) },
      { state: 'COMMENTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(8) },
    ] });
    expect(standingChangesRequest(p)?.state).toBe('CHANGES_REQUESTED');
  });

  it('an APPROVE landing after it DOES clear it', () => {
    const p = pr({ reviews: [
      { state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(9) },
      { state: 'APPROVED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(8) },
    ] });
    expect(standingChangesRequest(p)).toBeNull();
  });

  it('a verdict on an older head does not', () => {
    // The Lead answered it with a push; the head moved and nothing is owed.
    const p = pr({ reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: 'older00' }, submittedAt: ago(9) }] });
    expect(standingChangesRequest(p)).toBeNull();
  });
});

describe('which commit a verdict is about (RA-1725)', () => {
  // RA-1680: GitHub files a review under the head at SUBMISSION. The reviewer job stamps
  // the SHA it read; that wins, and `commit.oid` is the fallback for an unstamped one.
  const stamp = (sha: string) => `findings\n\n<!-- reviewed: sha=${sha} run=35848261456 -->`;

  it('a request filed under the head but READ against an older commit does not stand', () => {
    const p = pr({ reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(9), body: stamp('0ddba11') }] });
    expect(standingChangesRequest(p)).toBeNull();
    expect(decide([p]).churn, 'so the push that answered it is not re-fired against it').toEqual([]);
  });

  it('a request filed under an older commit but READ against the head does', () => {
    const p = pr({ reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: '0ddba11' }, submittedAt: ago(9), body: stamp('aaaaaaa1') }] });
    expect(standingChangesRequest(p)).not.toBeNull();
    expect(decide([p]).churn).toHaveLength(1);
  });

  it('an unstamped review falls back to commit.oid', () => {
    const p = pr({ reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(9), body: 'no stamp here' }] });
    expect(standingChangesRequest(p)).not.toBeNull();
  });

  it('reads the body the listing already returns', () => {
    // `gh pr list --json reviews` carries each review's body, so the stamp needs no
    // second read — but only while `reviews` stays in the list.
    const src = readFileSync(join(ROOT, 'scripts/brief-revise-recovery.mjs'), 'utf8');
    expect(src).toMatch(/'--json', `number,author,state,files,headRefOid,reviews,/);
  });
});

describe('the churn, and what bounds it', () => {
  it('re-labels a head with no revise run at all', () => {
    const { churn, noted } = decide([pr()]);
    expect(churn).toEqual([{ number: 1, sha: 'aaaaaaa1' }]);
    expect(noted).toEqual([]);
  });

  it('does NOT re-label once a run exists for that head', () => {
    // THE ONLY THING BOUNDING THIS LOOP. After a churn a run exists, so the same head
    // cannot be churned twice — drop this and the recovery re-fires every hour on a
    // brief that is already being revised.
    const { churn, noted } = decide([pr()], () => [{ status: 'completed', conclusion: 'success', databaseId: 7 }]);
    expect(churn).toEqual([]);
    expect(noted).toHaveLength(1);
    expect(noted[0].why).toContain('The run did not fail');
  });

  it('reports a FAILED run rather than repeating it', () => {
    // A cap or an outage answered by re-firing is a cap or an outage repeated.
    const { churn, noted } = decide([pr()], () => [{ status: 'completed', conclusion: 'failure', databaseId: 8 }]);
    expect(churn).toEqual([]);
    expect(noted[0].why).toContain('classify annotation');
  });

  it('says nothing needs doing while a run is still in flight', () => {
    const { churn, noted } = decide([pr()], () => [{ status: 'in_progress', conclusion: null, databaseId: 9 }]);
    expect(churn).toEqual([]);
    expect(noted[0].why).toContain('has NOT finished');
  });

  it('churns nothing when the run listing cannot be READ', () => {
    // `null` is not `[]`, and the difference decides whether anything is churned.
    // Failing to read Actions must never manufacture a "no run ever fired".
    const { churn, noted } = decide([pr()], () => null);
    expect(churn).toEqual([]);
    expect(noted[0].why).toContain('could not read');
  });

  it('ignores a changes-request younger than the stall window', () => {
    const p = pr({ reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(1) }] });
    expect(decide([p]).churn).toEqual([]);
  });

  it('ignores a review with no timestamp rather than inventing a stall', () => {
    const p = pr({ reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' } }] });
    expect(decide([p]).churn).toEqual([]);
  });

  it('ignores a PR with no standing changes-request at all', () => {
    const p = pr({ reviews: [{ state: 'APPROVED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(9) }] });
    expect(decide([p]).churn).toEqual([]);
    expect(decide([p]).noted).toEqual([]);
  });
});

describe('which runs count as a delivery', () => {
  // The default `runsFor` is what production uses, and the injected one above never
  // exercises it. Both halves of its contract are load-bearing in opposite directions.
  const REVIEWED = ago(9);
  const listing = (runs: unknown[], since: string | undefined = REVIEWED) =>
    briefReviseRunsFor('aaaaaaa1', since, { json: () => runs });
  // Every fixture below starts AFTER the review unless it is the point of the test,
  // so the `conclusion` half of the contract is what each one is measuring.
  const after = ago(8);

  it('discards the runs a foreign label event left behind', () => {
    // A brief PR collects `review:please` at open and `agent:reviewer` on its first
    // review, both on the head the first changes-request lands on, and each starts this
    // workflow. The job-level `if` makes them conclude `skipped`; counting them would
    // suppress the churn on precisely the head this recovery exists for.
    expect(listing([{ headSha: 'aaaaaaa1', conclusion: 'skipped', createdAt: after }])).toEqual([]);
  });

  it('discards a run that started BEFORE the review it would be delivering', () => {
    // RA-1690, and the twin of the defect measured on the implementer lane. The same
    // label burst that produces the `skipped` runs above also produces ones the
    // workflow's `concurrency` group CANCELS — and `cancelled` is not `skipped`, so
    // the filter above lets them through. PR RA-1660 parked for two days on exactly one
    // of those: a run that began ten minutes before the review existed.
    //
    // A `cancelled` run is the reachable case; the rule is about the CLOCK, not the
    // conclusion, so a `success` before the review is discarded just the same.
    expect(listing([{ headSha: 'aaaaaaa1', conclusion: 'cancelled', createdAt: ago(10) }]),
      'cancelled ten minutes before the review delivered nothing').toEqual([]);
    expect(listing([{ headSha: 'aaaaaaa1', conclusion: 'success', createdAt: ago(10) }]),
      'and neither did a successful one').toEqual([]);
  });

  it('keeps a genuinely broken run that started AFTER the review', () => {
    // The direction that must NOT regress. A cap or an outage IS a delivery attempt,
    // and RA-1595 forbids answering it by repeating it — so the timestamp filter must
    // discriminate on time alone and not become "cancelled runs do not count".
    expect(listing([{ headSha: 'aaaaaaa1', conclusion: 'cancelled', createdAt: after }])).toHaveLength(1);
  });

  it('keeps the run the churn itself starts', () => {
    // "After a churn a run exists" is the ONLY thing bounding this loop. Exclude the
    // churn's own run and the same head is re-churned every hour forever — and a
    // churn's run is necessarily after the review, which is why RA-1690's filter is
    // safe here.
    expect(listing([{ headSha: 'aaaaaaa1', conclusion: 'success', createdAt: after }])).toHaveLength(1);
    expect(listing([{ headSha: 'aaaaaaa1', conclusion: null, createdAt: after }])).toHaveLength(1);
  });

  it('an unreadable clock on either side counts the run, so nothing is churned', () => {
    // Fail-closed, the same direction as an unreadable listing: an unknown timestamp
    // must suppress a re-fire rather than cause one.
    expect(listing([{ headSha: 'aaaaaaa1', conclusion: 'success' }]), 'run with no createdAt')
      .toHaveLength(1);
    // Called directly: a `undefined` argument re-triggers `listing`'s default, so the
    // helper cannot express "no review timestamp at all".
    expect(briefReviseRunsFor('aaaaaaa1', undefined, { json: () => [{ headSha: 'aaaaaaa1', conclusion: 'success', createdAt: ago(10) }] }),
      'review with no submittedAt').toHaveLength(1);
  });

  it('discards a cancelled run a NEWER run superseded — the displaced label event (RA-1724)', () => {
    // PR RA-1895, the one measured instance on this lane: the Reviewer's review run (success),
    // his `agent:reviewer` label run pending behind it, displaced to `cancelled`. It
    // would have concluded `skipped`; counting it named it as the broken run.
    const at = (s: number) => new Date(Date.parse(REVIEWED) + s * 1000).toISOString();
    const runs = [
      { headSha: 'aaaaaaa1', conclusion: 'success', databaseId: 34882111016, createdAt: at(1) },
      { headSha: 'aaaaaaa1', conclusion: 'cancelled', databaseId: 34882111802, createdAt: at(1) },
      { headSha: 'aaaaaaa1', conclusion: 'success', databaseId: 34882115318, createdAt: at(3) },
    ];
    const kept = briefReviseRunsFor('aaaaaaa1', REVIEWED, { json: () => runs, churnedAfter: ago(9 - HOURS) });
    expect((kept ?? []).map((r: LibraryValue) => r.databaseId)).toEqual([34882111016, 34882115318]);
    // And the recovery hands the boundary over, or the rule above is inert.
    let seen: unknown;
    briefReviseRecovery([pr()], { runsFor: (_s: string, _since?: string, o?: { churnedAfter?: string | null }) => { seen = o?.churnedAfter; return []; }, now: NOW, hours: HOURS });
    expect(seen).toBe(ago(9 - HOURS));
  });

  it('asks the API for the fields the filter needs', () => {
    // The filter is only as good as the listing: without `createdAt` in `--json`,
    // every run reads as an unknown clock and RA-1690 silently reverts to its old
    // behaviour while every test above still passes on injected fixtures. Without
    // `event`, RA-2301 does the same: a cancelled review run falls back to "anything
    // newer" and is dropped as superseded.
    const src = readFileSync(join(ROOT, 'scripts/brief-revise-recovery.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('export function briefReviseRunsFor'), src.indexOf('const BROKEN'));
    expect(fn).toMatch(/'--json', 'headSha,event,status,conclusion,databaseId,createdAt'/);
  });

  it('keeps a cancelled REVIEW-event run however many label runs follow it (RA-2301)', () => {
    const at = (s: number) => new Date(Date.parse(REVIEWED) + s * 1000).toISOString();
    const runs = [
      { headSha: 'aaaaaaa1', event: 'pull_request_review', conclusion: 'cancelled', databaseId: 1, createdAt: at(3) },
      { headSha: 'aaaaaaa1', event: 'pull_request', conclusion: 'skipped', databaseId: 2, createdAt: at(4) },
    ];
    const kept = briefReviseRunsFor('aaaaaaa1', REVIEWED, { json: () => runs, churnedAfter: ago(9 - HOURS) });
    expect((kept ?? []).map((r: LibraryValue) => r.databaseId)).toEqual([1]);
  });

  it('returns null rather than [] when the listing throws', () => {
    expect(briefReviseRunsFor('aaaaaaa1', REVIEWED, { json: () => { throw new Error('403'); } })).toBeNull();
  });
});

describe('what a human reads', () => {
  it('says so when nothing is parked, rather than printing nothing', () => {
    expect(report({ churn: [], noted: [] })).toContain('That is a finding, not an absence');
  });

  it('names every head it did not churn, not just how many', () => {
    const text = report({ churn: [{ number: 1, sha: 'aaaaaaa1' }], noted: [{ number: 2, sha: 'bbbbbbb2', why: 'because' }] });
    expect(text).toContain('PR #1');
    expect(text).toContain('PR #2');
    expect(text).toContain('because');
  });
});

describe('the label is the one the workflow actually triggers on', () => {
  // The gate and the filter are Kanon's lane's since RA-2709 (read from the checkout at the
  // pinned tag); this repo's caller holds only the triggers.
  const caller = readCaller('agent-lead-revise.yml');
  const reviseWf = readKanonLane(caller.jobs.revise);

  it('matches the marker in the job gate and in the filter step', () => {
    // The churn and the trigger are in different files, and a rename in one is a
    // recovery that re-labels something nothing listens for — green on both sides.
    // The gate and the step live in the `filter` job since RA-2592 (the agent half calls
    // the spine), and it is the workflow's only root job, so its gate is the run's.
    expect(reviseWf.jobs.filter.if).toContain(`'${REVISE_LABEL}'`);
    const filter = reviseWf.jobs.filter!.steps!.find((s: { id?: string }) => s.id === 'filter') as { env?: Record<string, string> } | undefined;
    expect(filter?.env?.REVISE_LABEL).toBe(REVISE_LABEL);
  });

  it('is not a label another workflow treats as a trigger', () => {
    // `review:please` starts `agent-review.yml`, so churning it would ask the Reviewer to
    // review again as a side effect of asking the Lead to revise; `agent:revise` starts
    // `agent-implement-revise.yml`, which is the implementer's lane.
    expect(REVISE_LABEL).not.toBe('review:please');
    expect(REVISE_LABEL).not.toBe('agent:revise');
  });

  it('bounds itself on the runs of that same workflow', () => {
    expect(WORKFLOW).toBe('agent-lead-revise.yml');
  });
});

describe('the hourly tick can see brief PRs at all (RA-1595)', () => {
  /**
   * The reason this needed a new pre-filter rather than a lane in `lead-reconcile.mjs`:
   * that script's world is keyed off a MERGED brief, and `agent-lead-reconcile.yml`
   * enumerates projects with `ls docs/projects/*.md`. A brief PR is one that has not
   * merged, so it is invisible to that read — the artifact the developer gates on was
   * the one thing the tick could not reach.
   */
  const wf = asOneWorkflow('agent-lead-reconcile.yml');
  const step = wf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'briefs');
  // The login the briefs step filters on, as the tick's `lead` step reads it from the App
  // register on the default branch (RA-2741) — executed, not copied into the test.
  const lead = wf.jobs.tick.steps.find((s: { id?: string }) => s.id === 'lead');
  let leadLogin = '';
  beforeAll(() => {
    const r = runRegisterStep(lead, ownRegister());
    expect(r.status, r.output).toBe(0);
    leadLogin = r.outputs.login;
  });

  const runBriefs = (prs: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'lead-briefs-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prs.json'), JSON.stringify(prs));
    // A generic `gh` stub: it runs whatever `--jq` the step passes through the real
    // jq, exactly as gh does. Shaping the answer per case would smuggle the expected
    // result into the fixture instead of testing the filter the step ships.
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
f=""; prev=""
for a in "$@"; do if [ "$prev" = "--jq" ]; then f="$a"; fi; prev="$a"; done
jq -r "$f" ${join(dir, 'prs.json')}
`);
    return runWorkflowStep(step, {
      dir,
      env: { PATH: `${dir}:${process.env.PATH}`, REPO: 'owner/repo', LEAD_LOGIN: leadLogin },
    });
  };

  it("reads the Lead's login from the App register's default-branch copy, not a literal (RA-2741)", () => {
    expect(step.env.LEAD_LOGIN).toBe('${{ steps.lead.outputs.login }}');
    expect(leadLogin).toBe(LEAD_LOGIN);
    const r = runRegisterStep(lead, ownRegister());
    expect(r.ghArgs).toHaveLength(1);
    expect(r.ghArgs[0]).toContain('repos/owner/repo/contents/docs/qa/agent-identities.md');
    expect(r.ghArgs[0]).not.toMatch(/ref=/);
    // Before the briefs step, which reads it.
    const ids = wf.jobs.tick.steps.map((s: { id?: string }) => s.id);
    expect(ids.indexOf('lead')).toBeGreaterThan(-1);
    expect(ids.indexOf('lead')).toBeLessThan(ids.indexOf('briefs'));
    // No Lead App slug in the workflow outside a comment.
    const code = readFileSync(join(ROOT, '.github/workflows/agent-lead-reconcile.yml'), 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toContain(LEAD_LOGIN);
  });

  it('fails the tick when the minted App is not the register\'s Lead, so a typo cannot read as idle', () => {
    const assert = wf.jobs.tick.steps.find((s: { name?: string }) => s.name === "Assert the minted App is the register's Lead");
    expect(assert.env).toEqual({ MINTED_SLUG: '${{ steps.app-token.outputs.app-slug }}', LEAD_LOGIN: '${{ steps.lead.outputs.login }}' });
    const ids = wf.jobs.tick.steps.map((s: { id?: string; name?: string }) => s.id ?? s.name);
    expect(ids.indexOf("Assert the minted App is the register's Lead")).toBe(ids.indexOf('app-token') + 1);
    const ok = runWorkflowStep(assert, { env: { MINTED_SLUG: leadLogin, LEAD_LOGIN: leadLogin } });
    expect(ok.status, ok.output).toBe(0);
    const bad = runWorkflowStep(assert, { env: { MINTED_SLUG: leadLogin, LEAD_LOGIN: 'example-lead-typo' } });
    expect(bad.status).not.toBe(0);
    expect(bad.output).toContain("the register's Lead row says 'example-lead-typo'");
  });

  it('fails the tick by name when the register has no Lead row', () => {
    const r = runRegisterStep(lead, withoutRole(ownRegister(), 'Lead'));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('::error title=App register::');
    expect(r.output).toContain('lists the role Lead 0 times');
    expect(r.outputs.login).toBeUndefined();
  });

  it('follows a renamed Lead App: the old login no longer counts as his', () => {
    const r = runRegisterStep(lead, withSlug(ownRegister(), 'Lead', 'example-lead-renamed'));
    expect(r.outputs.login).toBe('example-lead-renamed');
  });

  it('counts his brief PRs under every spelling of his login', () => {
    const r = runBriefs([pr({ number: 1 }), pr({ number: 2, login: 'example-lead[bot]' })]);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.parked).toBe('2');
  });

  it('emits nothing on an idle tick, so the heartbeat mints no token', () => {
    // §8's biggest cost lever, and the property the gates on every later step depend
    // on: most heartbeats have no open brief PR at all.
    const r = runBriefs([pr({ number: 3, login: 'example-implementer' }), pr({ number: 4, files: ['src/x.ts'] })]);
    expect(r.status, r.output).toBe(0);
    expect(r.outputs.parked).toBe('');
  });

  it('fails the step rather than reporting "no brief PR" when the read is denied', () => {
    // Treating a denied read as an absence is the inert-but-green shape this
    // workflow's own `scope` step carries six lines of comment about.
    const dir = mkdtempSync(join(tmpdir(), 'lead-briefs-denied-'));
    writeStub(join(dir, 'gh'), '#!/usr/bin/env bash\necho "HTTP 403" >&2\nexit 1\n');
    const r = runWorkflowStep(step, {
      dir,
      env: { PATH: `${dir}:${process.env.PATH}`, REPO: 'r/r', LEAD_LOGIN: leadLogin },
    });
    expect(r.status).not.toBe(0);
  });

  it('fails the step rather than reading an EMPTY answer as "none" (RA-1659 review)', () => {
    // The other door into the same swallow, and the one `set -e` does not cover: a
    // command in an `if` condition is exempt from it, so a `gh` that exits 0 with
    // nothing on stdout would have taken the `else` branch and reported no brief PR.
    const dir = mkdtempSync(join(tmpdir(), 'lead-briefs-empty-'));
    writeStub(join(dir, 'gh'), '#!/usr/bin/env bash\nexit 0\n');
    const r = runWorkflowStep(step, {
      dir,
      env: { PATH: `${dir}:${process.env.PATH}`, REPO: 'r/r', LEAD_LOGIN: leadLogin },
    });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('Refusing to read an empty answer');
    expect(r.outputs.parked ?? '').toBe('');
  });

  it('runs the recovery on the App token, without which a churn raises no event', () => {
    const recovery = wf.jobs.tick.steps.find((s: { name?: string }) => s.name?.includes('Re-deliver a parked brief PR'));
    expect(recovery.env.GH_TOKEN).toContain('app-token');
    expect(recovery.run).toContain('brief-revise-recovery.mjs');
    expect(recovery.if).toContain("steps.briefs.outputs.parked != ''");
  });
});

describe('a conflicting brief PR is hard-stopped, not slow (RA-1722)', () => {
  it('reports the rebase and churns nothing', () => {
    // `agent-lead-revise.yml`'s `labeled` trigger IS this lane's remedy (RA-1595), and a
    // conflicting PR receives no `pull_request` event at all — so the run listing stays
    // empty, which is exactly the condition that licenses the churn. Left alone it
    // churns hourly and reports success at doing nothing.
    const out = decide([pr({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' })]);
    expect(out.churn).toEqual([]);
    expect(out.noted).toHaveLength(1);
    expect(out.noted[0].why).toBe(CONFLICT_WHY);
  });

  it('still churns the same PR when it is clean — the control', () => {
    const out = decide([pr()]);
    expect(out.churn.map((c: { number: number }) => c.number)).toEqual([1]);
  });
});
