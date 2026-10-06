import { asAgent } from './helpers/sign.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { retryClass } from '../../actions/agent-classify/classify-agent-result.mjs';
import { ROOT } from './helpers/adopter.js';

import {
  RETRY_STEPS, RETRY_STEP_NAMES, describeRetry, makeRetryEvidenceReader, retryCoolDownHours, retryDecision, retryEvidenceIn,
} from '../../scripts/lane-retry.mjs';
import { attemptComment, attemptsIn, rebaseDecision, report as rebaseReport } from '../../scripts/rebase-lane.mjs';
import { briefReviseRecovery, report as briefReport, BRIEF_PATH } from '../../scripts/brief-revise-recovery.mjs';
import { reviewRecovery as standaloneReviewRecovery, report as reviewReport } from '../../scripts/review-recovery.mjs';

/**
 * RA-2519 — a PR-lane run that died of its CAUSE (the model unreachable, or its API failing
 * mid-run) is retried once per head, after a cool-down. Everything else stays report-only.
 *
 * The measured case is PR RA-2446: its revise run died at 45 turns on `terminal_reason:
 * api_error` in the 2026-09-25 cap window, then the rebase lane's only attempt never
 * reached the model (550 ms, empty `modelUsage`) — and each lane deferred to the other.
 */
const NOW = Date.parse('2026-09-26T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const HOURS = 5;

/** A run's jobs payload as `GET /repos/{r}/actions/runs/{id}/jobs` returns it. */
const jobs = (crumb: keyof typeof RETRY_STEPS | null, { job = 'review', at = ago(6) } = {}) => ({
  jobs: [{
    name: job,
    steps: [
      { name: 'Run anthropics/claude-code-action@v1', conclusion: 'failure', completed_at: at },
      ...Object.entries(RETRY_STEPS).map(([k, name]) => ({
        name, conclusion: k === crumb ? 'success' : 'skipped', completed_at: at,
      })),
    ],
  }],
});
const evidence = (classification: string | null, at = ago(6)) =>
  () => (classification ? { classification, at } : null);

describe('reading how a run ended (RA-2519)', () => {
  it('reads the breadcrumb that RAN, not the one that was skipped', () => {
    expect(retryEvidenceIn(jobs('unreachable'))).toEqual({ classification: 'unreachable', at: ago(6) });
    expect(retryEvidenceIn(jobs('api_error'))).toEqual({ classification: 'api_error', at: ago(6) });
    // A genuine failure: both breadcrumbs skipped — report-only.
    expect(retryEvidenceIn(jobs(null))).toBeNull();
    // A run from before the breadcrumbs existed has no such steps at all.
    expect(retryEvidenceIn({ jobs: [{ name: 'review', steps: [{ name: 'x', conclusion: 'failure' }] }] })).toBeNull();
    expect(retryEvidenceIn(null)).toBeNull();
  });

  it("reads only the named job, so one PR's capped matrix job cannot license another's retry", () => {
    const payload = jobs('unreachable', { job: 'resolve (2446)' });
    expect(retryEvidenceIn(payload, { job: (n) => n === 'resolve (2446)' })?.classification).toBe('unreachable');
    expect(retryEvidenceIn(payload, { job: (n) => n === 'resolve (2447)' })).toBeNull();
  });

  it('answers undefined, never "not retryable", when the jobs cannot be read', () => {
    const read = makeRetryEvidenceReader({ json: () => { throw new Error('HTTP 403'); } });
    expect(read(123)).toBeUndefined();
    // No run id is no read at all.
    expect(makeRetryEvidenceReader({ json: () => jobs('unreachable') })(null)).toBeUndefined();
    const ok = makeRetryEvidenceReader({ json: (args: string[]) => {
      expect(args).toEqual(['api', 'repos/o/r/actions/runs/123/jobs?per_page=100']);
      return jobs('api_error');
    }, repo: 'o/r' });
    expect(ok(123)?.classification).toBe('api_error');
  });

  it('defaults the cool-down to five hours on anything but a positive number', () => {
    for (const raw of [undefined, '', 'x', '0', '-3']) expect(retryCoolDownHours(raw)).toBe(5);
    expect(retryCoolDownHours('2')).toBe(2);
  });
});

describe('the retry decision (RA-2519)', () => {
  const failed = (id = 21) => ({ databaseId: id, conclusion: 'failure' });

  it('retries the ONLY attempt when it died retryably and the cool-down has passed', () => {
    expect(retryDecision([failed()], { evidenceOf: evidence('unreachable'), now: NOW, hours: HOURS }))
      .toEqual({ retry: { runId: 21, classification: 'unreachable', at: ago(6) } });
    // The REST listing says `id`, not `databaseId`.
    expect(retryDecision([{ id: 7, conclusion: 'failure' }], { evidenceOf: evidence('api_error'), now: NOW, hours: HOURS }))
      .toMatchObject({ retry: { runId: 7 } });
  });

  it('waits out the cause, and says until when', () => {
    const d = retryDecision([failed()], { evidenceOf: evidence('unreachable', ago(1)), now: NOW, hours: HOURS });
    expect(d?.retry).toBeUndefined();
    expect(d?.why).toMatch(/retried once after 2026-09-26T16:00Z/);
  });

  it('does NOT retry a genuine failure — the agent ran and failed, or hit a turn or dollar cap', () => {
    // No breadcrumb ran: `retryClass` returned null for those, below.
    expect(retryDecision([failed()], { evidenceOf: evidence(null), now: NOW, hours: HOURS })).toBeNull();
  });

  it('does NOT retry a second failure on the same head — the retry is itself an attempt', () => {
    let reads = 0;
    const d = retryDecision([failed(22), failed(21)], {
      evidenceOf: () => { reads++; return { classification: 'unreachable', at: ago(6) }; }, now: NOW, hours: HOURS,
    });
    expect(d).toBeNull();
    expect(reads, 'and it does not even read the evidence').toBe(0);
  });

  it('never retries on an unreadable fact, an unfinished run, or a failure time it cannot read', () => {
    expect(retryDecision([failed()], { evidenceOf: () => undefined, now: NOW, hours: HOURS })).toBeNull();
    expect(retryDecision([{ databaseId: 21, conclusion: null }], { evidenceOf: evidence('unreachable'), now: NOW, hours: HOURS })).toBeNull();
    expect(retryDecision([{ databaseId: 21, conclusion: 'cancelled' }], { evidenceOf: evidence('unreachable'), now: NOW, hours: HOURS })).toBeNull();
    const noTime = retryDecision([failed()], { evidenceOf: () => ({ classification: 'unreachable', at: null }), now: NOW, hours: HOURS });
    expect(noTime?.retry).toBeUndefined();
    expect(noTime?.why).toMatch(/cool-down cannot be measured/);
  });

  it('names the retry and its evidence for the report', () => {
    const line = describeRetry({ runId: 21, classification: 'api_error', at: '2026-09-26T06:00:00Z' });
    expect(line).toContain('run 21');
    expect(line).toContain('`api_error`');
    expect(line).toContain('2026-09-26T06:00');
  });
});

describe('which failures the classifier calls retryable (RA-2519)', () => {
  const init = { type: 'system', subtype: 'init', model: 'claude-opus-5' };
  it('unreachable: the configured model never ran', () => {
    expect(retryClass({ is_error: true, num_turns: 1, total_cost_usd: 0, modelUsage: {} }, 'claude-opus-5')).toBe('unreachable');
  });
  it('api_error: the model ran and its API failed mid-run (PR RA-2446, 45 turns)', () => {
    const r = { is_error: true, num_turns: 45, total_cost_usd: 2.66, terminal_reason: 'api_error',
      modelUsage: { 'claude-opus-5': {} } };
    expect(retryClass(r, 'claude-opus-5')).toBe('api_error');
  });
  it('null for everything a re-run reproduces or that did not fail', () => {
    const ran = { modelUsage: { 'claude-opus-5': {} } };
    expect(retryClass({ ...ran, is_error: true, terminal_reason: 'max_turns' }, 'claude-opus-5')).toBeNull();
    expect(retryClass({ ...ran, is_error: true, terminal_reason: 'budget_exhausted' }, 'claude-opus-5')).toBeNull();
    expect(retryClass({ ...ran, is_error: true, terminal_reason: 'completed' }, 'claude-opus-5')).toBeNull();
    expect(retryClass({ ...ran, is_error: false }, 'claude-opus-5')).toBeNull();
    expect(retryClass(null)).toBeNull();
  });

  it('writes retry=<class> for the breadcrumb steps to read, and empty otherwise', () => {
    const script = join(ROOT, 'actions/agent-classify/classify-agent-result.mjs');
    const cli = (result: object) => {
      const dir = mkdtempSync(join(tmpdir(), 'lane-retry-cli-'));
      const file = join(dir, 'out.json');
      writeFileSync(file, JSON.stringify([init, { type: 'result', ...result }]));
      const out = join(dir, 'gh_out');
      writeFileSync(out, '');
      spawnSync(process.execPath, [script, '--file', file], { env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, 's') } });
      return readFileSync(out, 'utf8');
    };
    expect(cli({ is_error: true, num_turns: 1, modelUsage: {} })).toMatch(/^retry=unreachable$/m);
    expect(cli({ is_error: true, num_turns: 45, terminal_reason: 'api_error', modelUsage: { 'claude-opus-5': {} } })).toMatch(/^retry=api_error$/m);
    expect(cli({ is_error: true, num_turns: 150, terminal_reason: 'max_turns', modelUsage: { 'claude-opus-5': {} } })).toMatch(/^retry=$/m);
  });
});

/**
 * THE PROTOCOL: the reader finds a retryable run by a breadcrumb step's NAME, and each
 * lane's workflow must run that step exactly when its classifier said so. A rename on
 * either side reads every capped run as a genuine failure, silently — so the four lanes
 * and `RETRY_STEPS` are held together here.
 *
 * A LANE THAT CALLS THE SPINE (RA-2592) carries them in `agent-lane.yml`, beside the
 * classifier they read. It is checked against the spine AS RESOLVED FOR ITS INPUTS, so a
 * breadcrumb gated off for that caller would fail here rather than pass on the spine's
 * text. The jobs API names that job `revise / run`, and the reader filters these lanes'
 * jobs by nothing, so the name change is invisible to it.
 */
describe('every spelling of a breadcrumb is read (RA-2709, #53)', () => {
  // Kanon's lanes write the bare name since #53; runs from before it carry `(RA-2519)`
  // (Kanon's spine) or `(#2519)` (the reference adopter's own lanes). A reader of one
  // spelling would read the others' capped runs as genuine failures: no retry, silently.
  // The old spellings are written out, so dropping one before the census says so is red.
  it.each(Object.entries(RETRY_STEP_NAMES))('%s', (cls, names) => {
    const current = RETRY_STEPS[cls as keyof typeof RETRY_STEPS];
    expect(current).not.toMatch(/\(/);
    expect(names).toEqual([current, `${current} (RA-2519)`, `${current} (#2519)`]);
    for (const name of names) {
      const payload = { jobs: [{ name: 'revise / revise / run', steps: [{ name, conclusion: 'success', completed_at: ago(6) }] }] };
      expect(retryEvidenceIn(payload), name).toEqual({ classification: cls, at: ago(6) });
    }
  });
});


describe('the rebase lane, first half of PR RA-2446 (RA-2519)', () => {
  const HEAD = 'cafed00dbeef0000000000000000000000000000';
  const pr = (number = 2446) => ({
    number, author: { login: 'example-implementer' }, state: 'OPEN', isDraft: false,
    headRefOid: HEAD, headRefName: `fix/${number}`, labels: [{ name: 'agent:implement' }],
    mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING',
    // The Implementer's marker and status (plan 0005 §3.3, L4): the PR is in the chain.
    body: asAgent('example-implementer', 'Closes #1'),
    headStatuses: [{ context: 'kanon/role: implementer', state: 'success', creator: { login: 'example-implementer[bot]' } }],
  });
  const once = [attemptComment(HEAD, '36142146720')];
  const decide = (bodies: string[] | null, ev: ReturnType<typeof evidence>, now = NOW) => rebaseDecision([pr()], {
    hasMarker: () => true,
    attemptsOf: () => (bodies === null ? null : attemptsIn(bodies, HEAD)),
    evidenceOf: ev, now, retryHours: HOURS,
  });

  it('records which run made the attempt, and still matches the attempt marker', () => {
    const body = attemptComment(HEAD, '36142146720');
    expect(attemptsIn([body], HEAD)).toEqual([{ runId: '36142146720' }]);
    // A comment from before RA-2519 counts as an attempt with no run to read.
    expect(attemptsIn([attemptComment(HEAD)], HEAD)).toEqual([{ runId: null }]);
    expect(attemptsIn([body], 'deadbeef0000')).toEqual([]);
  });

  it('re-hands a head whose only attempt never reached the model, once the cool-down has passed', () => {
    const out = decide(once, evidence('unreachable'));
    expect(out.resolve).toEqual([{ number: 2446, sha: HEAD, branch: 'fix/2446',
      retry: { runId: '36142146720', classification: 'unreachable', at: ago(6) } }]);
    expect(rebaseReport(out)).toMatch(/run 36142146720, which died retryably \(`unreachable`\)/);
  });

  it('waits while the cause may still hold', () => {
    const out = decide(once, evidence('unreachable', ago(1)));
    expect(out.resolve).toEqual([]);
    expect(out.noted[0]).toMatchObject({ reason: 'cooling' });
  });

  it('does not re-hand a genuine failure, a second attempt, an old marker, or an unreadable thread', () => {
    for (const [bodies, ev] of [
      [once, evidence(null)],
      [[...once, attemptComment(HEAD, '36199999999')], evidence('unreachable')],
      [[attemptComment(HEAD)], evidence('unreachable')],
      [null, evidence('unreachable')],
    ] as const) {
      const out = decide(bodies as string[] | null, ev);
      expect(out.resolve).toEqual([]);
      expect(out.noted[0]).toMatchObject({ reason: 'attempted' });
    }
  });
});

describe('the brief and standalone review lanes (RA-2519)', () => {
  it('re-churns a brief PR whose only revise run died on api_error', () => {
    const pr = {
      number: 3, author: { login: 'app/example-lead' }, body: asAgent('example-lead', 'A brief.'), state: 'OPEN', files: [{ path: `${BRIEF_PATH}1.md` }],
      headRefOid: 'aaaaaaa1', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
      reviews: [{ state: 'CHANGES_REQUESTED', commit: { oid: 'aaaaaaa1' }, submittedAt: ago(9) }],
    };
    const runs = () => [{ headSha: 'aaaaaaa1', event: 'pull_request_review', status: 'completed', conclusion: 'failure', databaseId: 41, createdAt: ago(8) }];
    const out = briefReviseRecovery([pr], { runsFor: runs, now: NOW, hours: 4, evidenceOf: evidence('api_error'), retryHours: HOURS });
    expect(out.churn).toEqual([{ number: 3, sha: 'aaaaaaa1', retry: { runId: 41, classification: 'api_error', at: ago(6) } }]);
    expect(briefReport(out, { apply: true })).toContain('run 41');
    // A genuine failure keeps today's note.
    const genuine = briefReviseRecovery([pr], { runsFor: runs, now: NOW, hours: 4, evidenceOf: evidence(null), retryHours: HOURS });
    expect(genuine.churn).toEqual([]);
    expect(genuine.noted[0].why).toMatch(/Re-firing repeats it/);
  });

  it('re-churns a PR whose only review attempt never reached the model', () => {
    const HEAD = 'bb8232b0000000000000000000000000000000aa';
    const pr = {
      number: 1659, state: 'OPEN', isDraft: false, labels: [{ name: 'agent:implement' }],
      headRefOid: HEAD, reviews: [], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
      commits: [{ oid: HEAD, committedDate: ago(9) }],
    };
    const runs = () => [{ id: 51, actor: 'example-implementer', event: 'workflow_run', status: 'completed', conclusion: 'failure', createdAt: ago(8) }];
    const out = standaloneReviewRecovery([pr], {
      runsFor: runs, ciSettled: () => true, now: NOW, hours: 4, evidenceOf: evidence('unreachable'), retryHours: HOURS,
    });
    expect(out.churn).toEqual([{ number: 1659, sha: HEAD, retry: { runId: 51, classification: 'unreachable', at: ago(6) } }]);
    expect(reviewReport(out, { apply: true })).toContain('run 51');
  });
});
