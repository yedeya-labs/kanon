import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_MARKER,
  AUDIT_MAX_AGE_DAYS,
  MIN_DECISIVE,
  WINDOW,
  HEALTH_MARKER,
  OVERSEER_WORKFLOW,
  auditIssueIn,
  auditMarker,
  classifyAudit,
  classifyWorkflow,
  closeDecision,
  fleetGate,
  healthMarker,
  nextRedSet,
  overseerInstalled,
  positiveInt,
  relationWarning,
  positiveNumber,
  runBoth,
  redSetIn,
  renderAuditFinding,
  renderClose,
  renderFinding,
  watchedWorkflows,
} from '../../scripts/workflow-health.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-1036 — a workflow red on every run must escalate. Moved from the reference adopter with
 * the script (plan 0004 step 10); the job that runs it is tested with its lane, in
 * `tests/unit/digest-lanes.test.ts`.
 *
 * In the reference adopter, `agent-lead-reconcile.yml` exited 1 on its pre-filter on EVERY run from the day RA-956
 * merged until RA-1032 was filed: 16 `failure`, 4 `cancelled`, 0 `success`. Nothing
 * noticed. The detector's whole risk is the OPPOSITE error — paging on a workflow that
 * is quiet, or on a run cancelled by a concurrency race — because a detector that cries
 * wolf gets muted and then the real case is invisible again. So most of what is held
 * here is what must NOT fire.
 */

const run = (conclusion: string | null, url = 'https://x/1') => ({ conclusion, url, createdAt: '2026-09-01T00:00:00Z' });

describe('what counts as red', () => {
  it('is red only when every decisive run failed', () => {
    const out = classifyWorkflow('agent-lead-reconcile.yml', [run('failure'), run('failure'), run('failure')]);
    expect(out.status).toBe('red');
    expect(out.failures).toBe(3);
    expect(out.url, 'the newest failure, so a reader lands on evidence').toBe('https://x/1');
  });

  it('is NOT red when one run in the window succeeded', () => {
    expect(classifyWorkflow('w.yml', [run('failure'), run('success'), run('failure'), run('failure')]).status).toBe('ok');
  });

  it('drops cancelled runs rather than counting them either way', () => {
    // The reconciler alone shows four `cancelled` from concurrency-group races. Counted
    // as failures they manufacture a red fleet; counted as successes they hide one.
    expect(classifyWorkflow('w.yml', [run('cancelled'), run('cancelled'), run('failure')]).status)
      .toBe('quiet');
    expect(classifyWorkflow('w.yml', [run('cancelled'), run('failure'), run('failure'), run('failure')]))
      .toMatchObject({ status: 'red', decisive: 3 });
  });

  it('drops skipped and in-flight runs too', () => {
    expect(classifyWorkflow('w.yml', [run('skipped'), run(null), run('success')]).status).toBe('quiet');
  });

  it('never calls a quiet workflow broken', () => {
    // An event-gated workflow may have almost no history. "No success in the last K"
    // read naively pages on it, which is the false positive that gets a detector muted.
    expect(classifyWorkflow('w.yml', []).status).toBe('quiet');
    expect(classifyWorkflow('w.yml', [run('failure')]).status).toBe('quiet');
    expect(classifyWorkflow('w.yml', [run('failure'), run('failure')]).status).toBe('quiet');
  });

  it('calls an unreadable history unreadable, not healthy', () => {
    // A detector that reads "cannot see" as "fine" is the silent-absence class it
    // exists to close — and without `actions: read` this is exactly what it gets.
    expect(classifyWorkflow('w.yml', null)).toMatchObject({ status: 'unreadable' });
    expect(classifyWorkflow('w.yml', undefined)).toMatchObject({ status: 'unreadable' });
  });
});

describe('the escalation body', () => {
  const rows = [
    classifyWorkflow('agent-lead-reconcile.yml', [run('failure'), run('failure'), run('failure')]),
    classifyWorkflow('agent-explore.yml', [run('success'), run('success'), run('success')]),
    classifyWorkflow('agent-merge.yml', null),
  ];

  it('names the red workflows and not the healthy ones', () => {
    const text = renderFinding(rows);
    expect(text).toContain('agent-lead-reconcile.yml');
    expect(text).not.toContain('| `agent-explore.yml`');
  });

  it('says an unreadable workflow is not evidence of health', () => {
    expect(renderFinding(rows)).toContain('agent-merge.yml');
    expect(renderFinding(rows)).toContain('not evidence of health');
  });

  it('records the red SET in the marker, so a repeat is exactly comparable', () => {
    // Refreshing daily with the same content is the "one comment an hour" invisibility
    // `hold()` is commented about, one cadence slower — and a set that GREW is news.
    const text = renderFinding(rows);
    expect(redSetIn(text)).toEqual(['agent-lead-reconcile.yml']);
    expect(text).toContain(HEALTH_MARKER);
  });

  it('distinguishes a grown set from an unchanged one', () => {
    expect(redSetIn(healthMarker(['b.yml', 'a.yml']))).toEqual(['a.yml', 'b.yml']);
    expect(redSetIn(healthMarker(['a.yml', 'b.yml']))).not.toEqual(redSetIn(healthMarker(['a.yml'])));
    expect(redSetIn('no marker here')).toBeNull();
    expect(redSetIn(healthMarker([])), 'a body with no red set is an empty set, not null').toEqual([]);
  });
});

/** An adopter's `.github/workflows/`, holding these files. */
const workflowsDir = (files: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-health-'));
  for (const f of files) writeFileSync(join(dir, f), 'name: x\n');
  return dir;
};

describe('what it watches', () => {
  it('covers every lane caller, read from disk', () => {
    // NOT a list of the lanes that run a model: that OMITS `agent-lead-reconcile.yml`,
    // the workflow this check was written for. Every caller is named after its lane
    // (K-LAYOUT-18), so the prefix finds them all.
    const dir = workflowsDir(['agent-lead-reconcile.yml', 'agent-review.yml', 'agent-new-lane.yml', 'ci.yml', 'release.yml', 'agent-notes.yaml']);
    expect(watchedWorkflows(dir)).toEqual(['agent-lead-reconcile.yml', 'agent-new-lane.yml', 'agent-review.yml']);
  });

  it('watches its own host, so the detector is not its own blind spot', () => {
    expect(watchedWorkflows(workflowsDir(['agent-project-digest.yml', 'agent-weekly-digest.yml']))).toEqual(['agent-project-digest.yml', 'agent-weekly-digest.yml']);
  });

  it('watches no other workflow of the adopter\'s, which are not lanes', () => {
    expect(watchedWorkflows(workflowsDir(['ci.yml', 'project-digest.yml', 'deploy.yml']))).toEqual([]);
  });
});

describe('the heartbeat runs only where an Overseer is installed (plan 0004, decision 12)', () => {
  it('reads that from the Overseer caller among the watched files', () => {
    expect(OVERSEER_WORKFLOW).toBe('agent-overseer.yml');
    expect(overseerInstalled(watchedWorkflows(workflowsDir(['agent-overseer.yml', 'agent-review.yml'])))).toBe(true);
  });

  it('the heartbeat asks it before it reads anything (wiring, which the CLI half does not test)', () => {
    const src = readFileSync(join(ROOT, 'scripts/workflow-health.mjs'), 'utf8');
    const body = src.slice(src.indexOf('function auditHeartbeat() {'));
    if (body.length === src.length) throw new Error('auditHeartbeat moved: re-anchor this check');
    const first = body.split('\n').slice(1).find((l) => l.trim())!;
    expect(first.trim()).toBe('if (!overseerInstalled(watchedWorkflows())) {');
    expect(body.indexOf('return 0;')).toBeLessThan(body.indexOf('auditIssues()'));
  });

  it('expects no audit from a repository without one', () => {
    expect(overseerInstalled(watchedWorkflows(workflowsDir(['agent-review.yml', 'agent-project-digest.yml'])))).toBe(false);
    expect(overseerInstalled([])).toBe(false);
  });
});

/**
 * RA-1877 finding 1 — a MISSED weekly audit must escalate, and the red check above cannot
 * see one.
 *
 * `agent-overseer.yml` failed on 2026-09-07 and filed nothing. The prior audit silently
 * aged to fourteen days; nothing noticed for a week. The risk here is the mirror of the
 * red check's: this shares an escalation surface with it, so firing on a healthy week —
 * or on the human closing an audit issue they had finished with — is what gets the whole
 * script muted. Most of what is held below is again what must NOT fire.
 */
const MONDAY = '2026-09-07T07:00:00Z'; // the tick that was lost
const audit = (number: number, createdAt: string) => ({ number, createdAt, url: `https://x/${number}` });

describe('the weekly audit heartbeat', () => {
  it('is fresh across a normal weekly gap', () => {
    const out = classifyAudit([audit(1336, '2026-08-31T14:40:00Z')], '2026-09-07T12:00:00Z');
    expect(out.status).toBe('fresh');
    expect(out.number).toBe(1336);
  });

  it('is still fresh the day after a missed tick, so scheduler drift cannot fire it', () => {
    // The 09-14 run was queued for 07:00Z and started 13:27Z. Hours of drift is normal;
    // a bound of 7-and-a-bit would escalate on a healthy week.
    expect(classifyAudit([audit(1336, '2026-08-31T14:40:00Z')], '2026-09-08T23:00:00Z').status).toBe('fresh');
  });

  it('goes stale on the Thursday after a missed Monday', () => {
    // 08-31 + 9 days = 09-09; the check runs daily at 07:35Z, so 09-10 is the first tick
    // past the bound. Seven days of invisibility become three.
    const out = classifyAudit([audit(1336, '2026-08-31T14:40:00Z')], '2026-09-10T07:35:00Z');
    expect(out.status).toBe('stale');
    expect(Math.floor(out.ageDays!)).toBe(9);
  });

  it('ages the NEWEST audit, not the open one — curating the backlog must not silence it', () => {
    // The trap this exists to avoid: age the single OPEN audit issue and a human closing
    // RA-1336 once its findings are filed zeroes the heartbeat, so the check goes quiet
    // exactly when someone is paying attention. State is deliberately not an input here.
    const out = classifyAudit(
      [audit(1336, '2026-08-31T14:40:00Z'), audit(1877, '2026-09-14T13:36:00Z'), audit(900, '2026-08-24T07:48:00Z')],
      '2026-09-15T07:35:00Z',
    );
    expect(out.status).toBe('fresh');
    expect(out.number).toBe(1877);
  });

  it('calls an unreadable list unreadable, not healthy', () => {
    expect(classifyAudit(null, MONDAY).status).toBe('unreadable');
    expect(classifyAudit(undefined, MONDAY).status).toBe('unreadable');
  });

  it('treats an empty answer as a broken query rather than as silence', () => {
    // The heartbeat runs only where an Overseer is installed, and the reference adopter's
    // had filed eighteen audits. Zero means the label or title convention moved under the
    // search — reading that as `fresh` would be the detector certifying its own blindness.
    expect(classifyAudit([], MONDAY).status).toBe('missing');
  });

  it('leaves the bound overridable but defaults to nine days', () => {
    expect(AUDIT_MAX_AGE_DAYS).toBe(9);
    expect(classifyAudit([audit(1, '2026-09-01T00:00:00Z')], '2026-09-05T00:00:00Z', { maxAgeDays: 3 }).status)
      .toBe('stale');
  });
});

describe('the heartbeat escalation body', () => {
  const stale = classifyAudit([audit(1336, '2026-08-31T14:40:00Z')], '2026-09-14T07:35:00Z');

  it('names the stale audit and its age', () => {
    const body = renderAuditFinding(stale);
    expect(body).toContain('#1336');
    expect(body).toContain('13 days ago');
  });

  it('points the reader at the failing step and warns the logs expire', () => {
    const body = renderAuditFinding(stale);
    expect(body).toContain("Reconcile the agent's exit with what it durably produced");
    expect(body, 'the reference adopter\'s 09-07 root cause was already HTTP 410 when the next audit looked')
      .toMatch(/expire with the repository's log retention/);
  });

  it('records the audit number in the marker, NOT the age', () => {
    // An age-bearing marker changes daily, so every tick would read as "something
    // changed" and comment — the once-a-day restatement that gets an escalation ignored.
    const body = renderAuditFinding(stale);
    expect(body).toContain(auditMarker(1336));
    expect(auditIssueIn(body)).toBe('1336');
    expect(body).not.toContain(auditMarker(1337));
  });

  it('says so plainly when the query itself came back empty', () => {
    const body = renderAuditFinding(classifyAudit([], MONDAY));
    expect(body).toContain('could be found at all');
    expect(auditIssueIn(body)).toBe('none');
  });

  it('keeps its own marker distinct from the red check\'s', () => {
    expect(AUDIT_MARKER).not.toBe(HEALTH_MARKER);
    expect(renderAuditFinding(stale)).not.toContain(HEALTH_MARKER);
    expect(renderFinding([classifyWorkflow('w.yml', [run('failure'), run('failure'), run('failure')])]))
      .not.toContain(AUDIT_MARKER);
  });
});

describe('why the red check cannot answer this', () => {
  it('reads a weekly workflow with one red tick among greens as healthy', () => {
    // `--limit 12` is half a day for an hourly workflow and three months for a weekly
    // one. The real shape: agent-overseer.yml read `ok | 1/7` on 2026-09-14, a week
    // after the audit it lost. This must stay true — it is correct behaviour for the
    // red check, and precisely why the heartbeat exists.
    const weekly = classifyWorkflow('agent-overseer.yml', [
      run('success'), run('failure'), run('success'), run('success'),
      run('success'), run('success'), run('success'),
    ]);
    expect(weekly.status).toBe('ok');
    expect(weekly.failures).toBe(1);
  });
});

/**
 * RA-1885 review — the two checks must not be able to hide each other, and the bound must
 * not be able to disable itself. Both were previously claims in a comment.
 */
describe('neither check may hide the other', () => {
  it('runs the heartbeat even when the red check throws', () => {
    // The throwing path is the one taken exactly when the fleet IS red: `issue create`
    // is outside any try. A rate-limited write on a bad afternoon used to take the audit
    // heartbeat offline, with the job red for the other reason so nobody read the absence.
    let ran = false;
    const code = runBoth(
      () => {
        throw new Error('rate limited');
      },
      () => {
        ran = true;
        return 0;
      },
      () => {},
    );
    expect(ran, 'the heartbeat must still run').toBe(true);
    expect(code, 'and the job must still go red for the red check').toBe(1);
  });

  it('says on the job which half failed, rather than dying silently', () => {
    const said: string[] = [];
    runBoth(
      () => {
        throw new Error('rate limited\nsecond line');
      },
      () => 0,
      (m) => said.push(m),
    );
    expect(said.join('\n')).toContain('::error title=workflow-health::');
    expect(said.join('\n')).toContain('rate limited');
    expect(said.join('\n'), 'only the first line of a multi-line error').not.toContain('second line');
  });

  it('reports the heartbeat\'s own failure when the red check was fine', () => {
    expect(runBoth(() => {}, () => 1, () => {})).toBe(1);
    expect(runBoth(() => {}, () => 0, () => {})).toBe(0);
  });

  it('lets a heartbeat throw escape — it runs last, and hiding it would hide a real bug', () => {
    expect(() =>
      runBoth(
        () => {},
        () => {
          throw new Error('detector bug');
        },
        () => {},
      ),
    ).toThrow('detector bug');
  });
});

describe('a tuning value cannot silently disable the check it tunes', () => {
  // NaN does not throw — it makes a comparison `false` forever. Each of these three sits
  // on the wrong side of such a comparison, and each failure is silent.
  const malformed = ['9d', 'nine', 'NaN', '12runs', 'three', undefined, null, ''];

  it('falls back on a malformed value rather than yielding NaN', () => {
    for (const bad of malformed) {
      expect(positiveNumber(bad, 9), `${String(bad)} must fall back`).toBe(9);
      expect(positiveInt(bad, 12), `${String(bad)} must fall back`).toBe(12);
    }
  });

  it('rejects zero and negatives, which mute the detector through noise instead', () => {
    // MIN_DECISIVE=0 escalates on a single red run; QA_AUDIT_MAX_AGE_DAYS=0 escalates on
    // every healthy week. Same muting, opposite sign.
    for (const bad of ['0', '-3', 0, -3]) {
      expect(positiveNumber(bad, 9)).toBe(9);
      expect(positiveInt(bad, 3)).toBe(3);
    }
  });

  it('honours a real override', () => {
    expect(positiveNumber('14', 9)).toBe(14);
    expect(positiveInt('25', 12)).toBe(25);
  });

  it('allows a fractional number of DAYS but never a fractional COUNT', () => {
    // The whole reason there are two guards. `7.5` days is sensible; `gh run list
    // --limit 7.5` is not, and neither is a fractional `decisive.length` threshold.
    expect(positiveNumber('7.5', 9)).toBe(7.5);
    expect(positiveInt('7.5', 12), 'a fractional --limit must fall back').toBe(12);
    expect(positiveInt('1e3', 12), 'exponent notation is still an integer').toBe(1000);
    expect(positiveNumber('1e400', 9), 'Infinity is not finite').toBe(9);
    expect(positiveInt('1e400', 12)).toBe(12);
  });

  it('pins the DEFAULTS the module exports when nothing is set', () => {
    // WHAT THIS DOES AND DOES NOT COVER (RA-1914). It pins the default VALUES only. It
    // says nothing about the wiring: nothing in the repo sets these variables, and with
    // them unset `positiveInt(undefined, 12)` and `Number(undefined || 12)` return the
    // same 12 — so this assertion holds identically with the guard and without it. The
    // earlier version of this case claimed "a regression in the wiring is caught too",
    // which it never did. The wiring is pinned by the re-import block below.
    expect(AUDIT_MAX_AGE_DAYS).toBe(9);
    expect(WINDOW).toBe(12);
    expect(MIN_DECISIVE).toBe(3);
    expect(Number.isInteger(WINDOW) && Number.isInteger(MIN_DECISIVE)).toBe(true);
  });
});

/**
 * RA-1914 — the constants must actually ROUTE THROUGH their guards.
 *
 * They are evaluated at module import from `process.env`, so the only way to observe the
 * wiring is to set a value and re-import. Nothing in the repo sets these variables, which
 * is why the previous "pins the live constants" case passed identically with and without
 * the guard — it asserted the defaults, which both the guarded and unguarded expressions
 * produce.
 *
 * EVERY FALLBACK CASE IS PAIRED WITH A VALID OVERRIDE, and that pairing is the point. A
 * fallback assertion alone is vacuous under a cached module: if `resetModules()` did not
 * re-evaluate, the import would return the default and the test would pass for the wrong
 * reason. The override case can only pass if the module really was re-read — so it is
 * what makes the fallback case mean something. (Verified before writing these: with a
 * valid `QA_HEALTH_WINDOW=25` the re-import yields 25, not 12.)
 */
describe('RA-1914 — the constants route through their guards', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // `as unknown as` rather than a direct cast: the module's type does not overlap
  // `Record<string, number>` (it exports functions too), and TS rejects the one-step
  // conversion. Indexing by name is what lets the three constants share one table.
  const reimport = async (key: string, value: string): Promise<Record<string, number>> => {
    vi.resetModules();
    vi.stubEnv(key, value);
    return (await import('../../scripts/workflow-health.mjs')) as unknown as Record<string, number>;
  };

  it.each([
    ['QA_HEALTH_WINDOW', 'WINDOW', '12runs', 12, '25', 25],
    ['QA_HEALTH_MIN_DECISIVE', 'MIN_DECISIVE', 'three', 3, '5', 5],
    ['QA_AUDIT_MAX_AGE_DAYS', 'AUDIT_MAX_AGE_DAYS', '9d', 9, '14', 14],
  ] as const)(
    '%s falls back on a malformed value and honours a valid one',
    async (envKey, exportName, bad, fallback, good, overridden) => {
      const malformed = await reimport(envKey, bad);
      expect(
        malformed[exportName],
        `${envKey}=${bad} must fall back, not become NaN`,
      ).toBe(fallback);

      const valid = await reimport(envKey, good);
      expect(
        valid[exportName],
        'if this is the default, the module was cached and the case above proved nothing',
      ).toBe(overridden);
    },
  );

  it('rejects a fractional WINDOW, which would reach `gh run list --limit`', async () => {
    const m = await reimport('QA_HEALTH_WINDOW', '7.5');
    expect(m.WINDOW).toBe(12);
  });
});

describe('RA-1914 — MIN_DECISIVE above WINDOW silently disables the red check', () => {
  it('warns when no workflow could ever reach the minimum', () => {
    // `decisive` can never exceed the `--limit WINDOW` the runs were read with, so a
    // minimum above the window makes `decisive.length < minDecisive` true for every
    // workflow: every verdict is `quiet` and nothing can ever be called red.
    const w = relationWarning(12, 99);
    expect(w).toContain('QA_HEALTH_MIN_DECISIVE (99)');
    expect(w).toContain('QA_HEALTH_WINDOW (12)');
    expect(w, 'must say what the consequence IS, not just that it is odd').toMatch(/red check is effectively off/);
  });

  it('is silent on a coherent pair, including the boundary', () => {
    // Equal is fine: a workflow with exactly WINDOW decisive runs reaches the minimum.
    expect(relationWarning(12, 3)).toBeNull();
    expect(relationWarning(12, 12)).toBeNull();
  });

  it('defaults to the live constants, so the CLI needs no arguments', () => {
    expect(relationWarning()).toBeNull();
  });

  it('proves the failure it describes is real', () => {
    // Not a hypothetical: with a minimum above the window, a fleet that IS all-red
    // classifies as `quiet` and escalates nothing.
    const allRed = [run('failure'), run('failure'), run('failure')];
    expect(classifyWorkflow('w.yml', allRed, { minDecisive: 3 }).status).toBe('red');
    expect(classifyWorkflow('w.yml', allRed, { minDecisive: 99 }).status).toBe('quiet');
  });
});

describe('RA-2027 — a check that cannot return red exits like one that looked at nothing', () => {
  const row = (file: string, status: 'red' | 'ok' | 'quiet' | 'unreadable') => ({
    file, status, decisive: 0, failures: 0, url: null,
  });

  it('refuses to act, and exits non-zero, when MIN_DECISIVE exceeds WINDOW', () => {
    const g = fleetGate([row('a.yml', 'quiet'), row('b.yml', 'quiet')], { relation: relationWarning(12, 99) });
    expect(g.act, 'every verdict is quiet by construction — closing on them would assert a recovery').toBe(false);
    expect(g.exitCode).toBe(1);
    expect(g.error).toMatch(/QA_HEALTH_MIN_DECISIVE \(99\)/);
  });

  it('refuses to act, and exits non-zero, when every workflow is unreadable', () => {
    const g = fleetGate([row('a.yml', 'unreadable'), row('b.yml', 'unreadable')]);
    expect(g).toMatchObject({ act: false, exitCode: 1 });
    expect(g.error).toMatch(/actions: read/);
  });

  it('acts on a coherent, partly readable fleet', () => {
    expect(fleetGate([row('a.yml', 'unreadable'), row('b.yml', 'ok')], { relation: relationWarning(12, 3) }))
      .toEqual({ act: true, exitCode: 0, error: null });
  });
});

describe('RA-1675 — the escalation closes only on evidence this tick read', () => {
  const row = (file: string, status: 'ok' | 'quiet' | 'unreadable') => ({
    file, status, decisive: 0, failures: 0, url: null,
  });

  it('holds the issue open while a workflow it names could not be read', () => {
    const d = closeDecision([row('a.yml', 'unreadable'), row('b.yml', 'ok')], ['a.yml']);
    expect(d.close, 'a failed read on the red workflow is not its recovery').toBe(false);
    expect(d.held).toEqual(['a.yml']);
  });

  it('is not held by an unreadable workflow the issue never named', () => {
    const d = closeDecision([row('a.yml', 'ok'), row('z.yml', 'unreadable')], ['a.yml']);
    expect(d).toMatchObject({ close: true, held: [], recovered: ['a.yml'] });
  });

  it('accepts quiet and gone as a way out, so the hold cannot become permanent', () => {
    const d = closeDecision([row('a.yml', 'quiet')], ['a.yml', 'deleted.yml']);
    expect(d).toMatchObject({ close: true, quiet: ['a.yml'], gone: ['deleted.yml'], recovered: [] });
  });

  it('is not pinned open by an unrelated flaky read when the issue carries no marker', () => {
    // No marker names nothing checkable. Holding on ANY unreadable row would pin the issue
    // open on a flaky read of a workflow that was never red.
    const d = closeDecision([row('a.yml', 'ok'), row('z.yml', 'unreadable')], null);
    expect(d).toMatchObject({ close: true, held: [], recovered: [] });
    expect(renderClose(d), 'and it claims no named recovery').toMatch(/^No watched workflow is red any more/);
  });

  it('carries an unreadable named workflow into the refreshed marker, so a refresh cannot launder the hold', () => {
    // Issue names a + b; a's read fails this tick and b is still red. Dropping a from the
    // marker would let the close arm close the issue once b recovers, with a never observed.
    const rows = [row('a.yml', 'unreadable'), { ...row('b.yml', 'ok'), status: 'red' as const }];
    const next = nextRedSet(rows, ['a.yml', 'b.yml']);
    expect(next).toEqual({ red: ['a.yml', 'b.yml'], carried: ['a.yml'] });
    const body = renderFinding(rows, 12, { carried: next.carried });
    expect(redSetIn(body)).toEqual(['a.yml', 'b.yml']);
    expect(body).toMatch(/unreadable this tick, so not known to have recovered: `a\.yml`/);
    // An unreadable workflow the issue never named is not carried.
    expect(nextRedSet(rows, ['b.yml']).carried).toEqual([]);
  });

  it('names what recovered and never calls a quiet workflow a success', () => {
    const text = renderClose(closeDecision([row('a.yml', 'ok'), row('b.yml', 'quiet')], ['a.yml', 'b.yml', 'c.yml']));
    expect(text).toMatch(/`a\.yml` has a successful run/);
    expect(text).toMatch(/`b\.yml` no longer has enough decisive runs[^.]*\. That is not a success/);
    expect(text).toMatch(/`c\.yml` is no longer in/);
    expect(text, 'the old blanket claim asserted health for every workflow, read or not').not.toMatch(/Every watched workflow/);
  });
});
