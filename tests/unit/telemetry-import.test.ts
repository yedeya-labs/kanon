import { describe, expect, it } from 'vitest';

import { AGENT_LANES, dryRun, reasonCode, report, send, transform } from '../../infra/telemetry/import.mjs';
import { LANE_ROLES, LANES, validate } from '../../actions/agent-telemetry/schema.mjs';
import { classifyResult } from '../../actions/agent-classify/classify-agent-result.mjs';

/**
 * Plan 0002 §7, step S5: the history import's transform, dry run and send, against fake
 * version-1 items. No AWS.
 */

type Attr = { S: string } | { N: string } | { BOOL: boolean };
type V1 = Record<string, string | number | boolean | undefined>;

/** A version-1 `COST#` item in DynamoDB's attribute-value form, as `aws dynamodb scan` prints it. */
const item = (over: V1 = {}): Record<string, Attr> => {
  const v: V1 = {
    pk: 'COST#reviewer', sk: '20260918T101500Z', agent: 'reviewer', outcome: 'ok', commit: 'abc1234', trigger: 'pull_request',
    workflow: 'agent-review', run_id: '17795526731', run_attempt: '1', reason: 'num_turns 12', model: 'claude-opus-4-1',
    effort: 'high', terminal_reason: 'completed', outcome_label: 'APPROVED', severities: 'critical:0,high:1,medium:2,low:0',
    total_cost_usd: 1.25, num_turns: 12, pr_number: 42, changed_lines: 120, is_error: false, ...over,
  };
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k,
    typeof x === 'number' ? { N: String(x) } : typeof x === 'boolean' ? { BOOL: x } : { S: String(x) }] as [string, Attr]));
};
const rowOf = (over: V1 = {}) => {
  const t = transform(item(over));
  if (!t.ok) throw new Error(`stopped: ${t.stop}`);
  return t.row;
};

describe('§7 step 2: the transform', () => {
  it('maps a version-1 item to a version-2 run row the importer may send', () => {
    const row = rowOf();
    expect(row).toEqual({
      schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: '2026-09-18T10:15:00Z', role: 'reviewer', lane: 'review',
      outcome: 'ok', reason: 'none', trigger: 'pull_request', run_id: 17795526731, run_attempt: 1, model: 'claude-opus-4-1',
      effort: 'high', terminal_reason: 'completed', total_cost_usd: 1.25, num_turns: 12, pr_number: 42, changed_lines: 120,
      is_error: false, verdict: 'approved', severities_critical: 0, severities_high: 1, severities_medium: 2, severities_low: 0,
    });
    expect(validate(row, { imported: true })).toEqual({ ok: true });
  });

  it('leaves kanon_version absent (decision 17), so only the importer path accepts the row', () => {
    const row = rowOf();
    expect(row).not.toHaveProperty('kanon_version');
    expect(validate(row)).toEqual({ ok: false, errors: [{ field: 'kanon_version', problem: 'required' }] });
  });

  it('converts the three version-1 strings to integers', () => {
    const row = rowOf({ outcome: 'failed', reason: 'the agent ran and did not finish (num_turns 3, total_cost_usd 0.10)', api_error_status: '529', run_attempt: '2' });
    expect(row).toMatchObject({ run_id: 17795526731, run_attempt: 2, api_error_status: 529 });
  });

  it('maps every agent in §7\'s table to a lane in the enum, with that lane\'s role', () => {
    expect(Object.keys(AGENT_LANES)).toHaveLength(15);
    for (const [agent, lane] of Object.entries(AGENT_LANES)) {
      expect(LANES).toContain(lane);
      expect(rowOf({ agent, pk: `COST#${agent}` })).toMatchObject({ lane, role: LANE_ROLES[lane as keyof typeof LANE_ROLES] });
    }
  });

  it('stops an unmapped agent and a sort key that isn\'t a time, and guesses neither', () => {
    expect(transform(item({ agent: 'mystery' }))).toEqual({ ok: false, lane: '(unmapped)', stop: 'agent' });
    expect(transform(item({ sk: 'COST#x' }))).toEqual({ ok: false, lane: 'review', stop: 'recorded_at' });
  });

  it('maps a terminal_reason outside the enum to other, as the normaliser does', () => {
    const t = transform(item({ terminal_reason: 'prompt_too_long' }));
    expect(t).toMatchObject({ ok: true, terminalReason: 'prompt_too_long', row: { terminal_reason: 'other' } });
  });
});

describe('the reason code (decision 17)', () => {
  // The sentences come from the classifier itself, so a changed template fails here.
  const opus = 'claude-opus-4-1';
  const sentences: Array<[string, string, string]> = [
    [classifyResult(null).why, 'not-reached', 'no_result_file'],
    [classifyResult({ is_error: true, num_turns: 1, total_cost_usd: 0.003, modelUsage: { 'claude-haiku-4-5': {} } }, opus).why, 'unavailable', 'model_never_ran'],
    [classifyResult({ is_error: true, num_turns: 0, modelUsage: {} }, '').why, 'unavailable', 'no_model_ran'],
    [classifyResult({ terminal_reason: 'max_turns', num_turns: 150, total_cost_usd: 9 }, opus).why, 'exhausted', 'turn_cap'],
    [classifyResult({ terminal_reason: 'budget_exhausted', is_error: true, num_turns: 40, total_cost_usd: 5, modelUsage: { [opus]: {} } }, opus).why, 'exhausted', 'budget_cap'],
    [classifyResult({ is_error: true, num_turns: 30, total_cost_usd: 2, modelUsage: { [opus]: {} } }, opus).why, 'failed', 'did_not_finish'],
    [classifyResult({ num_turns: 12, modelUsage: { [opus]: {} } }, opus).why, 'ok', 'none'],
  ];

  it.each(sentences)('the classifier\'s sentence %j is its code', (reason, outcome, code) => {
    expect(reasonCode({ reason, outcome })).toEqual({ code, derived: false });
  });

  it('derives the code an outcome decides, when the sentence is missing or unmatched', () => {
    for (const reason of [undefined, 'something the templates never said']) {
      expect(reasonCode({ reason, outcome: 'ok' })).toEqual({ code: 'none', derived: true });
      expect(reasonCode({ reason, outcome: 'failed' })).toEqual({ code: 'did_not_finish', derived: true });
      expect(reasonCode({ reason, outcome: 'not-reached' })).toEqual({ code: 'no_result_file', derived: true });
      expect(reasonCode({ reason, outcome: 'exhausted', terminal_reason: 'max_turns' })).toEqual({ code: 'turn_cap', derived: true });
      expect(reasonCode({ reason, outcome: 'exhausted', terminal_reason: 'budget_exhausted' })).toEqual({ code: 'budget_cap', derived: true });
    }
  });

  it('a sentence that disagrees with the outcome is not trusted: the outcome decides', () => {
    expect(reasonCode({ reason: 'num_turns 12', outcome: 'failed' })).toEqual({ code: 'did_not_finish', derived: true });
  });

  it('stops what the row can\'t decide: unavailable, and exhausted without a cap', () => {
    expect(reasonCode({ outcome: 'unavailable' })).toBeNull();
    expect(reasonCode({ outcome: 'exhausted', terminal_reason: 'completed' })).toBeNull();
    expect(reasonCode({ outcome: 'exhausted' })).toBeNull();
    expect(transform(item({ outcome: 'unavailable', reason: 'no idea' }))).toEqual({ ok: false, lane: 'review', stop: 'reason' });
  });
});

describe('§7 step 3: the dry run', () => {
  it('counts per lane, by cause, and names fields only', () => {
    const d = dryRun([
      item(),
      item({ reason: undefined }),
      item({ outcome: 'unavailable', reason: undefined }),
      item({ agent: 'mystery' }),
      item({ agent: 'implementer', pk: 'COST#implementer', terminal_reason: 'prompt_too_long' }),
      // Plan 0002 decision 19 (open): a failed row needs a `failed_stage` no version-1 row has.
      item({ outcome: 'failed', reason: undefined }),
    ]);
    expect(d.rows).toHaveLength(3);
    expect(d.stopped).toBe(3);
    expect(d.lanes.review).toMatchObject({ exported: 4, toImport: 2, reasonsDerived: 2, stopped: { reason: 1, invalid: 1 }, invalid: { 'failed_stage (required)': 1 } });
    expect(d.lanes['(unmapped)']).toMatchObject({ exported: 1, toImport: 0, stopped: { agent: 1 } });
    const text = report(d).join('\n');
    expect(text).toContain('implement: exported 1, to import 1, stopped none, reasons derived 0, terminal_reason [prompt_too_long]');
    expect(text).toContain('stopped in all: 3');
    // No value from a row: no sentence, commit, model or run id.
    for (const v of ['num_turns 12', 'abc1234', 'claude-opus', '17795526731']) expect(text).not.toContain(v);
  });
});

describe('§7 step 4: send', () => {
  it('assumes the importer role, names the key, and sends 25 rows to a POST', async () => {
    const calls: string[][] = [];
    const aws = (args: string[]) => {
      calls.push(args);
      const out = args[1] === 'get-caller-identity' ? { Account: '123456789012' }
        : args[1] === 'describe-stacks' ? { Stacks: [{ Outputs: [{ OutputKey: 'IngestUrl', OutputValue: 'https://u.example/' }] }] }
          : { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't' } };
      return { code: 0, stdout: JSON.stringify(out), stderr: '' };
    };
    const posts: Array<{ url: string, n: number }> = [];
    const post = async (url: string, body: string) => {
      const rows = JSON.parse(body) as unknown[];
      posts.push({ url, n: rows.length });
      return { status: 200, json: { results: rows.map((_, i) => (i === 0 && posts.length === 1 ? { status: 'rejected', errors: [{ field: 'recorded_at', problem: 'window' }] } : { status: 'stored' })) } };
    };
    const rows = Array.from({ length: 30 }, () => rowOf());
    const r = await send(rows, 'k2', { aws, post, profile: 'kanon' });
    expect(posts).toEqual([{ url: 'https://u.example/?key=k2', n: 25 }, { url: 'https://u.example/?key=k2', n: 5 }]);
    expect(r).toEqual({ stored: 29, refused: { 'recorded_at (window)': 1 } });
    expect(calls.find((c) => c[1] === 'assume-role')).toContain('arn:aws:iam::123456789012:role/kanon-telemetry-importer');
  });

  it('refuses to send when the importer role is not deployed', async () => {
    const aws = (args: string[]) => ({ code: args[1] === 'assume-role' ? 254 : 0, stdout: args[1] === 'assume-role' ? '' : JSON.stringify({ Account: '1', Stacks: [{ Outputs: [{ OutputKey: 'IngestUrl', OutputValue: 'u' }] }] }), stderr: '' });
    await expect(send([rowOf()], 'k2', { aws, post: async () => ({ status: 200, json: {} }), profile: 'kanon' })).rejects.toThrow(/--importer/);
  });
});
