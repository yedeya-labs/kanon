import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  ESCALATION_CATEGORIES,
  ESCALATION_REASONS,
  GUARDS,
  KANON_ERRORS,
  LANES,
  LANE_ROLES,
  REASON_OUTCOME,
  RESERVED_PARTITION,
  ROLES,
  SCHEMAS,
  STAGES,
  STORE_FIELDS,
  describeErrors,
  validate,
} from '../../actions/agent-telemetry/schema.mjs';
import {
  failedStage,
  kanonVersion,
  parseStages,
  TIMEOUT_SLACK_MS,
  runBoth,
  timedOut,
  transcriptCounts,
} from '../../actions/agent-telemetry/agent-telemetry.mjs';
import { classifyResult, parseObjects } from '../../actions/agent-classify/classify-agent-result.mjs';
import { ESCALATION_CATEGORIES as FILE_CATEGORIES } from '../../scripts/lib/escalation-paths.mjs';

/**
 * Plan 0002 step S1 and plan 0003 step M1: the schema module, the reason codes, the
 * attribution fields and the version-2 row. Every check in the S1 and M1 rows of those plans'
 * order of moves is here, by name.
 */

type Row = Record<string, unknown>;
const RUN = SCHEMAS.run![2]!;
const WORK = SCHEMAS.work_item![1]!;

const BASE_ENV = {
  TELEMETRY_NOW: '2026-10-02T10:00:00.000Z',
  GITHUB_RUN_ID: '33679229731',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_WORKFLOW: 'Review (Reviewer)',
  GITHUB_JOB: 'review',
  TELEMETRY_CLAUDE_ARGS: '--model claude-opus-5\n--effort high\n--max-turns 70',
  TELEMETRY_LANE: 'review',
  TELEMETRY_KANON_REF: 'v0.12.0',
  TELEMETRY_JOB_STATUS: 'success',
};

const dir = mkdtempSync(join(tmpdir(), 'telemetry-v2-'));
const file = (name: string, objects: unknown[]) => {
  const f = join(dir, name);
  writeFileSync(f, objects.map((o) => JSON.stringify(o, null, 2)).join('\n'));
  return f;
};
const INIT = { type: 'system', subtype: 'init', model: 'claude-opus-5' };
const RESULT = {
  type: 'result', is_error: false, terminal_reason: 'completed', num_turns: 12, duration_ms: 90_000,
  total_cost_usd: 0.8, usage: { input_tokens: 5, output_tokens: 50 },
  modelUsage: { 'claude-opus-5': { canonicalModel: 'claude-opus-5', costUSD: 0.8 } },
};

/** Execution files for every classifier branch, beside the fixtures already in the tree. */
const CASES: Record<string, { file: string | null; env?: Record<string, string>; outcome: string; reason: string }> = {
  none: { file: file('ok.json', [INIT, RESULT]), outcome: 'ok', reason: 'none' },
  model_never_ran: {
    file: file('capped.json', [INIT, { type: 'result', is_error: true, num_turns: 1, modelUsage: { 'claude-haiku-4-5': {} } }]),
    outcome: 'unavailable', reason: 'model_never_ran',
  },
  no_model_ran: {
    file: file('nomodel.json', [{ type: 'result', is_error: true, num_turns: 1, modelUsage: {} }]),
    env: { TELEMETRY_CLAUDE_ARGS: '--max-turns 5' },
    outcome: 'unavailable', reason: 'no_model_ran',
  },
  turn_cap: {
    file: file('turns.json', [INIT, { ...RESULT, is_error: true, terminal_reason: 'max_turns' }]),
    outcome: 'exhausted', reason: 'turn_cap',
  },
  budget_cap: {
    file: file('budget.json', [INIT, { ...RESULT, is_error: true, terminal_reason: 'budget_exhausted' }]),
    outcome: 'exhausted', reason: 'budget_cap',
  },
  did_not_finish: {
    file: file('failed.json', [INIT, { ...RESULT, is_error: true, terminal_reason: 'api_error', api_error_status: 529 }]),
    env: { TELEMETRY_STAGES: 'token=success checkout=success hook=success setup=success agent=failure' },
    outcome: 'failed', reason: 'did_not_finish',
  },
  no_result_file: {
    file: null,
    env: { TELEMETRY_STAGES: 'token=success checkout=failure hook=skipped setup=skipped agent=skipped', TELEMETRY_JOB_STATUS: 'failure' },
    outcome: 'not-reached', reason: 'no_result_file',
  },
};

const both = (execution: string | null, env: Record<string, string> = {}) =>
  runBoth({ agent: 'reviewer', ...(execution ? { execution_file: execution } : {}) }, { ...BASE_ENV, ...env });

/** A valid run row to mutate: the fixture that finished. */
const finished = () => both('tests/fixtures/agent-blocks/finished.json').v2 as Row;

describe('the field lists (plan 0002 §2.1, plan 0003 §3.3)', () => {
  it('a run row has fifty-nine fields and a work-item row eighty-four', () => {
    expect(Object.keys(RUN)).toHaveLength(59);
    expect(Object.keys(WORK)).toHaveLength(84);
  });

  it('marks exactly the plans\' required fields', () => {
    const required = (fields: Record<string, { required?: boolean }>) =>
      Object.entries(fields).filter(([, f]) => f.required).map(([k]) => k).sort();
    expect(required(RUN)).toEqual([
      'kanon_version', 'lane', 'outcome', 'reason', 'recorded_at', 'role', 'row_kind', 'run_attempt',
      'run_id', 'schema_version', 'tag',
    ]);
    expect(required(WORK)).toEqual(['closed_at', 'fate', 'pr_number', 'recorded_at', 'row_kind', 'schema_version', 'tag']);
  });

  it('carries none of the fields version 2 drops, and none the store sets', () => {
    for (const dropped of ['reason_text', 'workflow', 'job', 'commit', 'agent', 'outcome_label', 'severities', 'model_arg', 'additions', 'deletions', 'models', ...STORE_FIELDS]) {
      expect(Object.keys(RUN)).not.toContain(dropped);
      expect(Object.keys(WORK)).not.toContain(dropped);
    }
  });

  it('reserves `work`: no lane may take the work-item partition\'s name (plan 0002 §4)', () => {
    expect(RESERVED_PARTITION).toBe('work');
    expect(LANES).not.toContain(RESERVED_PARTITION);
    expect(LANES.length).toBeGreaterThan(0);
  });

  it('runs every lane as one of the six roles', () => {
    for (const lane of LANES) expect(ROLES).toContain(LANE_ROLES[lane]);
  });

  it('holds the Merger\'s escalation list to the rules merge-gate.mjs escalates by', () => {
    const src = readFileSync('scripts/merge-gate.mjs', 'utf8');
    const rules = [...new Set([...src.matchAll(/\bstop\('([a-z-]+)'/g)].map((m) => m[1]))].sort();
    expect(rules.length).toBeGreaterThan(0);
    expect([...ESCALATION_REASONS].sort()).toEqual(rules);
  });

  it("holds the escalation categories to the escalation file's closed list, and builds one boolean per category (kanon#54)", () => {
    expect(FILE_CATEGORIES.length).toBeGreaterThan(0);
    expect([...ESCALATION_CATEGORIES]).toEqual([...FILE_CATEGORIES]);
    expect(Object.keys(WORK).filter((k) => k.startsWith('esc_'))).toEqual(FILE_CATEGORIES.map((c) => `esc_${c}`));
    for (const c of FILE_CATEGORIES) expect(WORK[`esc_${c}`]).toEqual({ type: 'bool' });
    const item = { schema_version: 1, row_kind: 'work_item', tag: 'run', recorded_at: '2026-10-02T10:00:00Z', pr_number: 7, closed_at: '2026-10-01T09:00:00Z', fate: 'merged' };
    expect(validate({ ...item, esc_pipeline: true, esc_payments: false, esc_other: true })).toEqual({ ok: true });
    expect(validate({ ...item, esc_billing: true })).toEqual({ ok: false, errors: [{ field: 'esc_billing', problem: 'unknown' }] });
  });

  it('names a guard Kanon ships for every entry of the guard list', () => {
    for (const guard of GUARDS) {
      const found = [`scripts/${guard}.mjs`, `actions/${guard}/action.yml`].some((p) => {
        try { readFileSync(p); return true; } catch { return false; }
      });
      expect(found, guard).toBe(true);
    }
  });
});

describe('the reason codes (plan 0002 §2.3)', () => {
  it('classifies every branch to its code, and each code belongs to its kind', () => {
    for (const [code, c] of Object.entries(CASES)) {
      const { row, v2 } = both(c.file, c.env);
      expect(row.outcome, code).toBe(c.outcome);
      expect(v2?.reason, code).toBe(c.reason);
      expect(REASON_OUTCOME[c.reason]).toBe(c.outcome);
    }
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(REASON_OUTCOME).sort());
  });

  it('returns a code beside the sentence, and the sentence never reaches the version-2 row', () => {
    const c = classifyResult({ is_error: true, num_turns: 1, modelUsage: {} }, 'claude-opus-5');
    expect(c.code).toBe('model_never_ran');
    expect(c.why).toMatch(/never ran/);
    const { row, v2 } = both(CASES.model_never_ran!.file);
    expect(String(row.reason)).toMatch(/never ran/); // the version-1 row is unchanged
    expect(JSON.stringify(v2)).not.toContain(String(row.reason));
  });

  it('names the dollar cap by its subtype too, as the classifier does', () => {
    expect(classifyResult({ is_error: true, subtype: 'error_max_budget_usd', modelUsage: { 'claude-opus-5': {} } }, 'claude-opus-5').code).toBe('budget_cap');
  });
});

describe('every fixture\'s version-2 row validates (S1, M1)', () => {
  const fixtures = [
    ...readdirSync('tests/fixtures/agent-blocks').map((f) => join('tests/fixtures/agent-blocks', f)),
    'tests/fixtures/telemetry/transcript.json',
    'tests/fixtures/telemetry/transcript-real.json',
  ];

  it.each(fixtures)('%s', (path) => {
    const { v2, errors } = both(path, { TELEMETRY_STAGES: 'token=success checkout=success hook=success setup=success agent=success' });
    expect(errors).toEqual([]);
    expect(validate(v2)).toEqual({ ok: true });
  });

  it.each(Object.keys(CASES))('the %s case', (code) => {
    const c = CASES[code]!;
    const { v2, errors } = both(c.file, c.env);
    expect(errors).toEqual([]);
    expect(validate(v2)).toEqual({ ok: true });
  });

  it('derives the role from the lane', () => {
    expect(both('tests/fixtures/agent-blocks/finished.json', { TELEMETRY_LANE: 'implement' }).v2).toMatchObject({ lane: 'implement', role: 'implementer' });
    expect(both('tests/fixtures/agent-blocks/finished.json', { TELEMETRY_LANE: 'lead-split' }).v2).toMatchObject({ lane: 'lead-split', role: 'lead' });
  });

  it('a smoke row validates with its tag, and the tag defaults to run', () => {
    expect(both('tests/fixtures/agent-blocks/finished.json', { TELEMETRY_TAG: 'smoke' }).v2?.tag).toBe('smoke');
    expect(finished().tag).toBe('run');
  });

  it('writes no version-2 row without a lane, so an adopter\'s own older lane is unchanged', () => {
    const { row, v2 } = both('tests/fixtures/agent-blocks/finished.json', { TELEMETRY_LANE: '' });
    expect(v2).toBeNull();
    expect(row.schema).toBe(1);
  });

  it('carries a run id above 2³¹, which GitHub already issues', () => {
    expect(finished().run_id).toBe(33679229731);
  });
});

describe('an imported run row carries no kanon_version (plan 0002 decision 17)', () => {
  const without = () => { const r = { ...finished() }; delete r.kanon_version; return r; };

  it('is required on every row but the importer\'s', () => {
    expect(validate(without())).toEqual({ ok: false, errors: [{ field: 'kanon_version', problem: 'required' }] });
    expect(validate(without(), { imported: true })).toEqual({ ok: true });
  });

  it('is refused on an imported row, whatever its value', () => {
    for (const kanon_version of ['0.27.0', 'dev']) {
      expect(validate({ ...without(), kanon_version }, { imported: true })).toEqual({ ok: false, errors: [{ field: 'kanon_version', problem: 'not-allowed' }] });
    }
  });

  it('lets an imported not-reached row omit failed_stage, and nothing else (decision 19)', () => {
    const row = (outcome: string, reason: string) => { const r: Row = { ...without(), outcome, reason }; delete r.failed_stage; return r; };
    expect(validate(row('not-reached', 'no_result_file'), { imported: true })).toEqual({ ok: true });
    expect(validate(row('failed', 'did_not_finish'), { imported: true })).toEqual({ ok: false, errors: [{ field: 'failed_stage', problem: 'required' }] });
    expect(validate({ ...row('not-reached', 'no_result_file'), kanon_version: '0.27.0' })).toEqual({ ok: false, errors: [{ field: 'failed_stage', problem: 'required' }] });
  });

  it('changes nothing else an imported row is checked for', () => {
    expect(validate({ ...without(), surplus: 1 }, { imported: true })).toEqual({ ok: false, errors: [{ field: 'surplus', problem: 'unknown' }] });
    const noReason = without();
    delete noReason.reason;
    expect(validate(noReason, { imported: true })).toEqual({ ok: false, errors: [{ field: 'reason', problem: 'required' }] });
  });
});

describe('the mutations plan 0002 §8 lists each fail validate', () => {
  const fails = (row: Row, field: string) => {
    const v = validate(row);
    expect(v.ok, field).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.field)).toContain(field);
  };

  it('an extra field', () => fails({ ...finished(), workflow: 'Review' }, 'workflow'));
  it('a reason sentence', () => fails({ ...finished(), reason: 'the agent ran and did not finish (num_turns 3)' }, 'reason'));
  it('turn_cap with outcome ok', () => fails({ ...finished(), reason: 'turn_cap' }, 'reason'));
  it('not-reached without failed_stage', () => {
    const { v2 } = both(null, CASES.no_result_file!.env);
    expect(validate(v2)).toEqual({ ok: true });
    const row = { ...(v2 as Row) };
    delete row.failed_stage;
    fails(row, 'failed_stage');
  });
  it('a failed_stage on a run that finished', () => fails({ ...finished(), failed_stage: 'agent' }, 'failed_stage'));
  it('a kanon_error outside the list', () => fails({ ...finished(), kanon_error: 'disk_full' }, 'kanon_error'));
  it('a lane named work', () => fails({ ...finished(), lane: 'work' }, 'lane'));
  it('a role its lane does not run as', () => fails({ ...finished(), role: 'lead' }, 'role'));
  it('a run row with row_kind work_item', () => fails({ ...finished(), row_kind: 'work_item', schema_version: 1 }, 'run_id'));
  it('a work-item row carrying a run field', () => {
    const item = { schema_version: 1, row_kind: 'work_item', tag: 'run', recorded_at: '2026-10-02T10:00:00Z', pr_number: 7, closed_at: '2026-10-01T09:00:00Z', fate: 'merged' };
    expect(validate(item)).toEqual({ ok: true });
    fails({ ...item, total_cost_usd: 1.2 }, 'total_cost_usd');
  });
  it('a version the kind does not have', () => {
    fails({ ...finished(), schema_version: 1 }, 'schema_version');
    fails({ ...finished(), schema_version: 3 }, 'schema_version');
    const item = { schema_version: 2, row_kind: 'work_item', tag: 'run', recorded_at: '2026-10-02T10:00:00Z', pr_number: 7, closed_at: '2026-10-01T09:00:00Z', fate: 'merged' };
    fails(item, 'schema_version');
  });
  it('a time that is not ISO-8601 UTC', () => {
    fails({ ...finished(), recorded_at: '2026-10-02 10:00:00' }, 'recorded_at');
    fails({ ...finished(), recorded_at: '2026-10-02T10:00:00+02:00' }, 'recorded_at');
    fails({ ...finished(), recorded_at: '2026-13-45T10:00:00Z' }, 'recorded_at');
  });
  it('a field the store sets', () => fails({ ...finished(), received_at: '2026-10-02T10:00:00Z' }, 'received_at'));
  it('a value of the wrong type', () => fails({ ...finished(), num_turns: '20' }, 'num_turns'));
  it('an integer at 2³¹', () => fails({ ...finished(), num_turns: 2 ** 31 }, 'num_turns'));
  it('a model id that is not one', () => fails({ ...finished(), model: 'Opus, the big one' }, 'model'));
  it('a missing required field', () => {
    const row = finished();
    delete row.kanon_version;
    fails(row, 'kanon_version');
  });

  it('checks a work item\'s lists element by element', () => {
    const item = { schema_version: 1, row_kind: 'work_item', tag: 'run', recorded_at: '2026-10-02T10:00:00Z', pr_number: 7, closed_at: '2026-10-01T09:00:00Z', fate: 'merged' };
    expect(validate({ ...item, closing_issues: '12,40', escalation_reasons: 'checks-failed,escalating-path', guard_failures: 'dco:2,spec-guard:1' })).toEqual({ ok: true });
    fails({ ...item, closing_issues: '12,src/x.ts' }, 'closing_issues');
    fails({ ...item, escalation_reasons: 'checks-failed,looked odd' }, 'escalation_reasons');
    fails({ ...item, escalation_reasons: 'made-up-rule' }, 'escalation_reasons');
    fails({ ...item, guard_failures: 'dco:2,not-a-guard:1' }, 'guard_failures');
    fails({ ...item, closing_issues: Array.from({ length: 21 }, (_, i) => i + 1).join(',') }, 'closing_issues');
  });

  it('names fields, never values', () => {
    const secret = 'src/payments/charge.ts leaked a stack trace';
    const v = validate({ ...finished(), reason: secret, workflow: secret, [secret]: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(JSON.stringify(v.errors)).not.toContain(secret);
      expect(describeErrors(v.errors)).not.toContain(secret);
      expect(v.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['reason', 'workflow', '(unnamed)']));
    }
  });
});

describe('fault attribution (plan 0002 §2.6)', () => {
  it('reads kanon_version from the action ref, and an untagged ref is dev', () => {
    expect(kanonVersion('v0.12.0')).toBe('0.12.0');
    expect(kanonVersion('0.12.0')).toBe('0.12.0');
    expect(kanonVersion('main')).toBe('dev');
    expect(kanonVersion('ef04d1a95c3d1b9f0e1c5f6a7b8c9d0e1f2a3b4c')).toBe('dev');
    expect(kanonVersion('')).toBe('dev');
  });

  it('takes the first stage that ended the run, in the order the lane gave', () => {
    const o = parseStages('token=success checkout=success hook=failure setup=skipped agent=skipped finish=success');
    expect(failedStage(o, 'not-reached')).toBe('hook');
    expect(failedStage(o, 'ok')).toBeUndefined();
    expect(failedStage(parseStages('token=success checkout=success hook=success setup=success agent=cancelled'), 'not-reached')).toBe('agent');
    expect(failedStage(parseStages('token=skipped checkout=skipped hook=skipped setup=skipped agent=skipped finish=skipped'), 'not-reached')).toBe('token');
    expect(failedStage(parseStages('token=success checkout=success hook=success setup=success agent=success finish=skipped'), 'failed')).toBe('agent');
    expect(failedStage(parseStages('token=success checkout=success hook=success setup=success agent=success finish=failure'), 'failed')).toBe('finish');
    expect(failedStage(parseStages('token=failure checkout=skipped hook=skipped setup=skipped agent=failure'), 'failed')).toBe('token');
    expect(failedStage([], 'failed')).toBeUndefined();
    expect([...STAGES].sort()).toEqual(['agent', 'checkout', 'finish', 'hook', 'setup', 'token']);
  });

  it('keeps the lane\'s own order: the review lane mints its token last', () => {
    // A Kanon step between the checkout and agent-setup failed: the first stage the review
    // lane never reached is `setup`, not `token`, which it runs after the hook.
    const review = parseStages('checkout=success setup=skipped hook=skipped token=skipped agent=skipped finish=success');
    expect(review.map(([s]) => s)).toEqual(['checkout', 'setup', 'hook', 'token', 'agent', 'finish']);
    expect(failedStage(review, 'not-reached')).toBe('setup');
    expect(failedStage(parseStages('checkout=success token=failure setup=skipped agent=skipped'), 'not-reached')).toBe('token');
    expect(parseStages('hook=failure hook=success')).toEqual([['hook', 'failure']]);
  });

  it('never blames a stage the lane ran on past: a tolerated hook, then a failed agent, is the agent', () => {
    // The review lane's hook steps are `continue-on-error`: their CONCLUSION is success, which
    // is what the lane passes. The agent's is too (its reconcile step reds the job instead).
    const { v2, errors } = both(CASES.did_not_finish!.file, {
      TELEMETRY_STAGES: 'checkout=success setup=success hook=success token=success agent=success',
      TELEMETRY_LANE: 'review',
    });
    expect(errors).toEqual([]);
    expect(v2).toMatchObject({ outcome: 'failed', failed_stage: 'agent' });
  });

  it('a lane whose hook fails records failed_stage hook, and nothing else from the hook', () => {
    const { v2, errors } = both(null, {
      TELEMETRY_STAGES: 'token=success checkout=success hook=failure setup=skipped agent=skipped finish=skipped',
      TELEMETRY_JOB_STATUS: 'failure',
    });
    expect(errors).toEqual([]);
    expect(v2).toMatchObject({ outcome: 'not-reached', reason: 'no_result_file', failed_stage: 'hook' });
    expect(v2).not.toHaveProperty('kanon_error');
    // Only the stage outcomes come in: nothing names the hook's own steps.
    expect(parseStages('hook=failure install=failure Run_npm_ci=failure')).toEqual([['hook', 'failure']]);
  });

  it('a missing hook records Kanon\'s code for it', () => {
    const { v2, errors } = both(null, {
      TELEMETRY_STAGES: 'token=success checkout=success hook=failure setup=skipped agent=skipped',
      TELEMETRY_KANON_ERROR: 'hook_missing',
    });
    expect(errors).toEqual([]);
    expect(v2).toMatchObject({ failed_stage: 'hook', kanon_error: 'hook_missing' });
  });

  it('a kanon_error outside the list leaves the row unwritten, naming the field', () => {
    const { errors } = both(null, {
      TELEMETRY_STAGES: 'token=failure',
      TELEMETRY_KANON_ERROR: 'something else',
    });
    expect(errors.map((e) => e.field)).toEqual(['kanon_error']);
  });

  it('keeps the error list and its emitters in step', () => {
    const emitted = new Set<string>();
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    for (const path of [...walk('actions'), ...walk('.github'), ...walk('scripts')]) {
      if (!/\.(mjs|js|sh|ya?ml)$/.test(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (/^\s*(#|\/\/|\*)/.test(line)) continue;
        for (const m of line.matchAll(/kanon-error=([a-z0-9_]+)/g)) emitted.add(m[1]!);
      }
    }
    expect([...emitted].sort()).toEqual([...KANON_ERRORS].sort());
  });
});

describe('plan 0003 M1: the job and transcript fields', () => {
  it('a cancelled job records job_status cancelled', () => {
    const { v2, errors } = both('tests/fixtures/agent-blocks/finished.json', { TELEMETRY_JOB_STATUS: 'cancelled' });
    expect(errors).toEqual([]);
    expect(v2?.job_status).toBe('cancelled');
  });

  it('a cancelled job that ran its timeout timed out; one that did not, or wasn\'t cancelled, did not', () => {
    const now = '2026-10-02T10:00:00.000Z';
    expect(timedOut('cancelled', '2026-10-02T09:15:00Z', '45', now)).toBe(true);
    // Cancelled AT its limit, stamped 16 s after the job started (a measured setup), recorded
    // 5 s after the cancel: the stamp sees 44m49s, and it is still the timeout.
    expect(timedOut('cancelled', '2026-10-02T09:15:16Z', '45', '2026-10-02T10:00:05Z')).toBe(true);
    // …and with a slow image pull, a minute and a half late.
    expect(timedOut('cancelled', '2026-10-02T09:16:30Z', '45', '2026-10-02T10:00:05Z')).toBe(true);
    // Cancelled clearly before the limit: by hand, ten minutes short, or just past the slack.
    expect(timedOut('cancelled', '2026-10-02T09:25:00Z', '45', now)).toBe(false);
    expect(timedOut('cancelled', '2026-10-02T09:18:01Z', '45', now)).toBe(false);
    expect(TIMEOUT_SLACK_MS).toBe(180_000);
    expect(timedOut('failure', '2026-10-02T09:00:00Z', '45', now)).toBe(false);
    expect(timedOut('cancelled', '', '45', now)).toBeUndefined();
    expect(timedOut('', '2026-10-02T09:00:00Z', '45', now)).toBeUndefined();
    const { v2 } = both('tests/fixtures/agent-blocks/finished.json', {
      TELEMETRY_JOB_STATUS: 'cancelled', TELEMETRY_JOB_STARTED_AT: '2026-10-02T09:00:00Z', TELEMETRY_TIMEOUT_MINUTES: '45',
    });
    expect(v2?.timed_out).toBe(true);
  });

  it('an execution file with no tool events leaves tool_errors absent, not 0', () => {
    const v2 = finished();
    expect(v2).not.toHaveProperty('tool_errors');
    expect(v2).not.toHaveProperty('tool_calls');
    expect(v2).not.toHaveProperty('compactions');
  });

  it('counts tool calls, tool errors and compactions when the transcript is there', () => {
    const path = 'tests/fixtures/telemetry/transcript.json';
    expect(transcriptCounts(parseObjects(readFileSync(path, 'utf8')))).toEqual({ tool_calls: 3, tool_errors: 1, compactions: 1 });
    expect(both(path).v2).toMatchObject({ tool_calls: 3, tool_errors: 1, compactions: 1, subagents_spawned: 1, cache_write_5m_tokens: 2000 });
  });

  // #97: a real Reviewer run's execution file (claude-code-action@v1.0.239), with every text,
  // thinking block, tool input and tool output stripped. Its run made 33 tool calls, and 6 of
  // them failed (5 permission denials and one command that exited non-zero); it didn't compact.
  const REAL = 'tests/fixtures/telemetry/transcript-real.json';
  type Block = { type?: string; id?: string; tool_use_id?: string };
  type Message = { type?: string; message?: { content?: unknown } };
  const realObjects = () => parseObjects(readFileSync(REAL, 'utf8')) as Message[];

  it('counts a real execution file: every tool call, every failed one, and no compaction', () => {
    expect(transcriptCounts(realObjects())).toEqual({ tool_calls: 33, tool_errors: 6, compactions: 0 });
    expect(both(REAL).v2).toMatchObject({ tool_calls: 33, tool_errors: 6, compactions: 0, permission_denials: 5 });
  });

  it('the real file carries a result for every tool call, so its tool_errors is a count, not a guess', () => {
    const ids = (type: string, key: string) => realObjects()
      .flatMap((o) => (Array.isArray(o.message?.content) ? (o.message.content as Block[]) : []))
      .filter((b) => b.type === type)
      .map((b) => b[key as 'id' | 'tool_use_id'])
      .sort();
    expect(ids('tool_use', 'id')).toHaveLength(33);
    expect(ids('tool_result', 'tool_use_id')).toEqual(ids('tool_use', 'id'));
  });

  it('a file without the CLI\'s system events leaves compactions absent, not 0', () => {
    const counts = transcriptCounts(realObjects().filter((o) => o.type !== 'system'));
    expect(counts).toEqual({ tool_calls: 33, tool_errors: 6 });
    expect(counts).not.toHaveProperty('compactions');
  });

  it('a compaction is evidence of itself, with or without the init event', () => {
    const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } };
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } };
    expect(transcriptCounts([tool, { type: 'system', subtype: 'compact_boundary' }, result]))
      .toEqual({ tool_calls: 1, tool_errors: 0, compactions: 1 });
  });

  it('tool calls with no tool results leave tool_errors absent, not 0', () => {
    const counts = transcriptCounts(realObjects().filter((o) => o.type !== 'user'));
    expect(counts).toEqual({ tool_calls: 33, compactions: 0 });
    expect(counts).not.toHaveProperty('tool_errors');
  });

  it('a transcript with no tool calls records zero tool errors, which it can know', () => {
    const counts = transcriptCounts([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }]);
    expect(counts).toEqual({ tool_calls: 0, tool_errors: 0, compactions: 0 });
  });

  it('maps a terminal reason the schema doesn\'t know to other, so a CLI release can\'t fail rows', () => {
    const path = file('newreason.json', [INIT, { ...RESULT, terminal_reason: 'some_new_reason' }]);
    expect(both(path).v2?.terminal_reason).toBe('other');
  });
});

describe('where the rows go', () => {
  const telemetry = parse(readFileSync('actions/agent-telemetry/action.yml', 'utf8')) as {
    runs: { steps: { uses?: string; with?: Record<string, string> }[] };
  };
  const uploads = telemetry.runs.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact'));

  it('falsifier: the old collector\'s prefix still matches exactly one artifact, the version-1 row', () => {
    const names = uploads.map((s) => String(s.with?.name));
    expect(names.filter((n) => n.startsWith('agent-telemetry-'))).toEqual([
      'agent-telemetry-${{ inputs.agent }}-${{ github.run_id }}-${{ github.run_attempt }}',
    ]);
    expect(uploads.find((s) => s.with?.name?.startsWith('agent-telemetry-'))?.with?.path).toBe('qa-agent-telemetry.json');
  });

  it('uploads the version-2 row as a second artifact, kanon-telemetry-<lane>-<run id>-<attempt>', () => {
    const v2 = uploads.filter((s) => s.with?.name?.startsWith('kanon-telemetry-'));
    expect(v2.map((s) => s.with)).toEqual([expect.objectContaining({
      name: 'kanon-telemetry-${{ inputs.lane }}-${{ github.run_id }}-${{ github.run_attempt }}',
      path: 'kanon-telemetry.json',
    })]);
  });

  type Step = { uses?: string; with?: Record<string, unknown> };
  type Workflow = { jobs: Record<string, { uses?: string; with?: Record<string, unknown>; steps?: Step[] }> };
  const workflows = readdirSync('.github/workflows').filter((f) => f.endsWith('.yml'))
    .map((f) => ({ f, doc: parse(readFileSync(join('.github/workflows', f), 'utf8')) as Workflow }));
  const finishCalls = workflows.flatMap(({ f, doc }) => Object.values(doc.jobs).flatMap((j) =>
    (j.steps ?? []).filter((s) => s.uses === '$/actions/agent-finish').map((s) => ({ f, with: s.with ?? {} }))));
  const spineCalls = workflows.flatMap(({ f, doc }) => Object.values(doc.jobs)
    .filter((j) => j.uses === '$/.github/workflows/agent-lane.yml').map((j) => ({ f, with: j.with ?? {} })));

  it('every Kanon lane names a lane from the schema\'s list', () => {
    const lanes = [...finishCalls, ...spineCalls].filter((c) => c.f !== 'agent-lane.yml' && c.f !== 'lane-agent-job.yml' && c.f !== 'agent-blocks-smoke.yml');
    expect(lanes.length).toBe(15);
    for (const c of lanes) expect(LANES, c.f).toContain(c.with.lane);
  });

  type Job = { 'timeout-minutes'?: number; steps?: (Step & { id?: string; name?: string; run?: string; 'continue-on-error'?: boolean })[] };
  const laneJobs = workflows.flatMap(({ f, doc }) => Object.values(doc.jobs as Record<string, Job>)
    .filter((j) => (j.steps ?? []).some((s) => s.uses === '$/actions/agent-finish'))
    .map((j) => ({ f, job: j, with: j.steps!.find((s) => s.uses === '$/actions/agent-finish')!.with ?? {} })))
    .filter((c) => c.f !== 'agent-blocks-smoke.yml');

  it('passes each stage as a step conclusion, in the order the job runs those steps', () => {
    expect(laneJobs.length).toBe(11);
    for (const c of laneJobs) {
      expect(Object.keys(c.with).filter((k) => k.endsWith('-outcome')), c.f).toEqual([]);
      const pairs = String(c.with.stages ?? '').trim().split(/\s+(?=[a-z]+=)/);
      // A job that mints an App token passes that stage too; the digests mint none (plan 0004
      // step 10), so theirs are the checkout, the set-up and the agent.
      const mints = c.job.steps!.some((s) => s.id === 'app-token');
      expect(pairs.length, c.f).toBeGreaterThanOrEqual(mints ? 4 : 3);
      if (mints) expect(pairs.some((p) => p.startsWith('token=')), c.f).toBe(true);
      const at: number[] = [];
      for (const pair of pairs) {
        const m = /^([a-z]+)=\$\{\{ (.*) \}\}$/.exec(pair);
        expect(m, `${c.f} ${pair}`).not.toBeNull();
        expect(STAGES, c.f).toContain(m![1]);
        // A conclusion, so a tolerated step is never blamed; never an output a step wrote.
        expect(m![2], `${c.f} ${pair}`).not.toMatch(/\.outcome|outputs/);
        const ids = [...m![2]!.matchAll(/steps\.([a-z-]+)\.conclusion/g)].map((x) => x[1]);
        expect(ids.length, `${c.f} ${pair}`).toBeGreaterThan(0);
        at.push(c.job.steps!.findIndex((s) => s.id === ids[0]));
      }
      expect(at.every((i) => i >= 0), c.f).toBe(true);
      expect(at, `${c.f}: stages out of the job's order`).toEqual([...at].sort((x, y) => x - y));
      expect(pairs.at(-1), c.f).toBe('agent=${{ steps.agent.conclusion }}');
    }
  });

  it('passes no Kanon code from a step the lane runs on past', () => {
    for (const c of laneJobs) {
      for (const id of [...String(c.with['kanon-error'] ?? '').matchAll(/steps\.([a-z-]+)\.outputs\.kanon-error/g)].map((m) => m[1])) {
        expect(c.job.steps!.find((s) => s.id === id)?.['continue-on-error'], `${c.f} ${id}`).not.toBe(true);
      }
    }
  });

  it('every lane stamps its start first and passes its own timeout, so a timed-out run says so', () => {
    for (const c of laneJobs) {
      expect(c.job.steps![0]?.id, c.f).toBe('job');
      expect(c.job.steps![0]?.run, c.f).toContain('started-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)');
      expect(c.with['job-started-at'], c.f).toBe('${{ steps.job.outputs.started-at }}');
      // The spine's agent job (kanon#274) is handed the lane's timeout as an input.
      if (c.f === 'lane-agent-job.yml') expect(c.with['timeout-minutes']).toBe('${{ inputs.timeout-minutes }}');
      else expect(Number(c.with['timeout-minutes']), c.f).toBe(c.job['timeout-minutes']);
    }
  });

  it('the spine hands the finish block both Kanon codes and its lane', () => {
    const spine = laneJobs.find((c) => c.f === 'lane-agent-job.yml')!.with;
    expect(String(spine['kanon-error'])).toContain('steps.hook.outputs.kanon-error');
    expect(String(spine['kanon-error'])).toContain('steps.setup.outputs.kanon-error');
    expect(spine.lane).toBe('${{ inputs.lane }}');
  });

  it('the spine reports no hook failure for a lane that runs no hook (kanon#326)', () => {
    const spine = laneJobs.find((c) => c.f === 'lane-agent-job.yml')!.with;
    expect(String(spine.stages)).toContain("hook=${{ !inputs.project-setup && 'success' || steps.hook.conclusion");
    // A Lead run whose label step (after agent-setup) fails ends at the agent, and one whose
    // PATH step (before it) fails ends at the set-up: never at the hook it never runs.
    expect(failedStage(parseStages('token=success checkout=success hook=success setup=success agent=skipped finish=success'), 'not-reached')).toBe('agent');
    expect(failedStage(parseStages('token=success checkout=success hook=success setup=skipped agent=skipped finish=success'), 'not-reached')).toBe('setup');
  });

  it('the finish block hands all of it to the telemetry action', () => {
    const finish = parse(readFileSync('actions/agent-finish/action.yml', 'utf8')) as { runs: { steps: Step[] } };
    const t = finish.runs.steps.find((s) => s.uses === '$/actions/agent-telemetry')!.with!;
    expect(t.stages).toBe('${{ inputs.stages }} finish=${{ steps.quality.conclusion }}');
    expect(String(t.kanon_error)).toContain('inputs.kanon-error');
    expect(String(t.kanon_error)).toContain('steps.quality.outputs.kanon-error');
    expect(t).toMatchObject({ lane: '${{ inputs.lane }}', tag: '${{ inputs.tag }}', job_status: '${{ inputs.job-status }}' });
  });

  it('every hook-missing error writes its code', () => {
    const files = workflows.map(({ f }) => join('.github/workflows', f));
    let errors = 0;
    for (const path of files) {
      const src = readFileSync(path, 'utf8');
      // The project-setup hook's, and the Explorer's sweep hook's (plan 0004 step 12).
      const n = (src.match(/title=(project-setup|explore-sweep) hook missing::/g) ?? []).length;
      errors += n;
      expect((src.match(/echo "kanon-error=hook_missing" >> "\$GITHUB_OUTPUT"/g) ?? []).length, path).toBe(n);
    }
    // The review lane calls no hook since kanon#185, so it has no presence check either.
    // The explore lane checks two hooks, the project-setup hook and its sweep hook (plan 0004 step 12).
    expect(errors).toBe(6);
  });

  it('the blocks smoke marks its row smoke', () => {
    const smoke = finishCalls.find((c) => c.f === 'agent-blocks-smoke.yml');
    expect(smoke?.with.tag).toBe('smoke');
  });
});

describe('the script writes the version-2 row only when it validates', () => {
  const runScript = (env: Record<string, string>) => {
    const out = mkdtempSync(join(tmpdir(), 'telemetry-cli-'));
    const v1 = join(out, 'v1.json');
    const v2 = join(out, 'v2.json');
    const stdout = execFileSync('node', [
      'actions/agent-telemetry/agent-telemetry.mjs', '--agent', 'reviewer',
      '--execution-file', 'tests/fixtures/agent-blocks/finished.json', '--out', v1, '--out-v2', v2,
    ], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...BASE_ENV, ...env } });
    return { stdout, v1: existsSync(v1), v2: existsSync(v2) ? JSON.parse(readFileSync(v2, 'utf8')) as Row : null };
  };

  it('a valid row is written', () => {
    const r = runScript({});
    expect(r.v1).toBe(true);
    expect(r.v2).toMatchObject({ schema_version: 2, lane: 'review', kanon_version: '0.12.0' });
  });

  it('an invalid row is not written, and the warning names the field, not its value', () => {
    const r = runScript({ TELEMETRY_KANON_ERROR: 'quoted src/app.ts' });
    expect(r.v1).toBe(true);
    expect(r.v2).toBeNull();
    expect(r.stdout).toMatch(/::warning title=agent-telemetry::.*kanon_error \(enum\)/);
    expect(r.stdout.split('\n').filter((l) => l.startsWith('::'))).not.toContainEqual(expect.stringContaining('src/app.ts'));
  });

  it('no lane, no version-2 row', () => {
    expect(runScript({ TELEMETRY_LANE: '' }).v2).toBeNull();
  });
});
