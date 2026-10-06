#!/usr/bin/env node
// The reference adopter's history import (plan 0002 §7, step S5), run once by the Owner.
//
//   node infra/telemetry/import.mjs --export <scan.json>                                  # dry run
//   node infra/telemetry/import.mjs --export <scan.json> --key <key> --apply [--profile kanon]
//
// <scan.json> is the Owner's read-only export of every `COST#` item (§7 step 1), as
// `aws dynamodb scan --output json` prints it. The transform (§7 step 2) maps each version-1
// item to a version-2 run row; the dry run (step 3) prints per-lane counts, field names and enum
// values only, never a row or a value from one. `--apply` (step 4) sends the rows through the
// ingest function with the importer role, 25 to a `POST`, naming the adopter's key; the stack
// must be deployed with `render.mjs --importer`. A re-sent row overwrites itself, so a re-run is
// harmless.
//
// NOTHING IS GUESSED. An `agent` outside §7's table stops the row, and so does a required field
// the version-1 row can't decide. The Owner's decision 17 (2026-10-06) settles two of them:
// `kanon_version` is ABSENT on an imported row (no Kanon release ran it; the function refuses one
// that has it), and a `reason` that matches no classifier template is DERIVED where the row
// decides it — `outcome` alone for `ok`, `failed` and `not-reached`, and `terminal_reason` for
// `exhausted`. `unavailable` has two codes and nothing else to tell them apart, so it stops.
// Decision 19 settles the third: `failed_stage` is `agent` on a `failed` row, because that run
// reached the model, and absent on a `not-reached` one, which only an imported row may be.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseSeverities, verdictOf } from '../../actions/agent-telemetry/agent-telemetry.mjs';
import { LANE_ROLES, REASON_OUTCOME, TERMINAL_REASONS, validate } from '../../actions/agent-telemetry/schema.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { aws, post, REGION, STACK } from './verify.mjs';

/** §7's table: the reference adopter's `agent` name -> the lane. The role is the lane's own. */
export const AGENT_LANES = Object.freeze({
  reviewer: 'review',
  'merge-reconcile': 'merge-reconcile',
  implementer: 'implement',
  'implementer-revise': 'implement-revise',
  'triage-fix': 'triage',
  'rebase-lane': 'rebase',
  lead: 'lead',
  'lead-revise': 'lead-revise',
  'lead-split': 'lead-split',
  explorer: 'explore',
  auditor: 'code-audit',
  'verify-acs': 'verify-acs',
  overseer: 'overseer',
  'weekly-digest': 'weekly-digest',
  'project-digest': 'project-digest',
});

/**
 * The classifier's seven sentence templates (`classifyResult`), each to its code. A version-1
 * `reason` is the sentence; version 2 stores the code.
 * @type {ReadonlyArray<[RegExp, string]>}
 */
export const REASON_TEMPLATES = Object.freeze([
  [/^the agent produced no result file$/, 'no_result_file'],
  [/^`[^`]+` never ran \(modelUsage: /, 'model_never_ran'],
  [/^no model ran at all \(num_turns /, 'no_model_ran'],
  [/^it stopped at its turn cap \(num_turns /, 'turn_cap'],
  [/^it stopped at its dollar cap, --max-budget-usd \(/, 'budget_cap'],
  [/^the agent ran and did not finish \(num_turns /, 'did_not_finish'],
  [/^num_turns (\d+|\?)$/, 'none'],
]);

/** Decision 17: the code each outcome decides on its own. `exhausted` needs `terminal_reason`. */
const DERIVED = Object.freeze({ ok: 'none', failed: 'did_not_finish', 'not-reached': 'no_result_file' });
const DERIVED_EXHAUSTED = Object.freeze({ max_turns: 'turn_cap', budget_exhausted: 'budget_cap' });

/** Version-1 attributes that are not carried (§7 step 2), or are mapped to other fields. */
const DROPPED = new Set(['pk', 'sk', 'agent', 'workflow', 'commit', 'reason', 'outcome_label', 'severities']);
/** Stored as DynamoDB strings in version 1, integers in version 2. */
const TO_INTEGER = new Set(['run_id', 'run_attempt', 'api_error_status']);
const SORT_KEY = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** One DynamoDB attribute value as a plain value. */
const plain = (/** @type {any} */ v) => ('S' in v ? v.S : 'N' in v ? Number(v.N) : 'BOOL' in v ? v.BOOL : undefined);

/**
 * The reason code: the template's, when the sentence matches one that agrees with the outcome;
 * otherwise derived from the outcome (decision 17); otherwise null.
 * @param {Record<string, any>} v1
 * @returns {{ code: string, derived: boolean } | null}
 */
export function reasonCode(v1) {
  const sentence = typeof v1.reason === 'string' ? v1.reason : '';
  const hit = REASON_TEMPLATES.find(([re]) => re.test(sentence));
  if (hit && REASON_OUTCOME[hit[1]] === v1.outcome) return { code: hit[1], derived: false };
  const code = v1.outcome === 'exhausted'
    ? DERIVED_EXHAUSTED[/** @type {keyof typeof DERIVED_EXHAUSTED} */ (v1.terminal_reason)]
    : DERIVED[/** @type {keyof typeof DERIVED} */ (v1.outcome)];
  return code ? { code, derived: true } : null;
}

/**
 * §7 step 2 for one exported item.
 * @param {Record<string, any>} item a DynamoDB item, attribute-value form
 * @returns {{ ok: true, lane: string, row: Record<string, any>, derivedReason: boolean, terminalReason?: string }
 *   | { ok: false, lane: string, stop: string }}
 */
export function transform(item) {
  /** @type {Record<string, any>} */
  const v1 = Object.fromEntries(Object.entries(item).map(([k, v]) => [k, plain(v)]));
  const lane = Object.hasOwn(AGENT_LANES, v1.agent) ? AGENT_LANES[/** @type {keyof typeof AGENT_LANES} */ (v1.agent)] : null;
  if (!lane) return { ok: false, lane: '(unmapped)', stop: 'agent' };
  const ts = SORT_KEY.exec(String(v1.sk ?? ''));
  if (!ts) return { ok: false, lane, stop: 'recorded_at' };
  const reason = reasonCode(v1);
  if (!reason) return { ok: false, lane, stop: 'reason' };
  /** @type {Record<string, any>} */
  const row = {
    schema_version: 2,
    row_kind: 'run',
    tag: 'run',
    recorded_at: `${ts[1]}-${ts[2]}-${ts[3]}T${ts[4]}:${ts[5]}:${ts[6]}Z`,
    role: LANE_ROLES[/** @type {keyof typeof LANE_ROLES} */ (lane)],
    lane,
    reason: reason.code,
  };
  for (const [k, v] of Object.entries(v1)) {
    if (DROPPED.has(k) || v === undefined) continue;
    row[k] = TO_INTEGER.has(k) && /^\d+$/.test(String(v)) ? Number(v) : v;
  }
  // A CLI value the enum doesn't list is `other`, as the normaliser maps it. The dry run lists
  // the raw values.
  const terminalReason = typeof row.terminal_reason === 'string' ? row.terminal_reason : undefined;
  if (terminalReason !== undefined && !TERMINAL_REASONS.includes(terminalReason)) row.terminal_reason = 'other';
  // Decision 19: a `failed` run reached the model, so the agent stage is where it failed. A
  // `not-reached` one leaves `failed_stage` absent: the history doesn't say where it stopped.
  if (row.outcome === 'failed') row.failed_stage = 'agent';
  const verdict = verdictOf(v1.outcome_label);
  if (verdict) row.verdict = verdict;
  Object.assign(row, parseSeverities(v1.severities));
  return { ok: true, lane, row, derivedReason: reason.derived, ...(terminalReason ? { terminalReason } : {}) };
}

/**
 * §7 step 3: per lane, the rows exported, to import and stopped (by cause), the reasons derived,
 * the rows `validate` would refuse (by field name), and the distinct raw `terminal_reason`s.
 * @param {Record<string, any>[]} items
 */
export function dryRun(items) {
  /** @type {Record<string, { exported: number, toImport: number, stopped: Record<string, number>, reasonsDerived: number, invalid: Record<string, number>, terminalReasons: Set<string> }>} */
  const lanes = {};
  /** @type {Record<string, any>[]} */
  const rows = [];
  for (const item of items) {
    const t = transform(item);
    const l = (lanes[t.lane] ??= { exported: 0, toImport: 0, stopped: {}, reasonsDerived: 0, invalid: {}, terminalReasons: new Set() });
    l.exported += 1;
    if (!t.ok) { l.stopped[t.stop] = (l.stopped[t.stop] ?? 0) + 1; continue; }
    if (t.terminalReason) l.terminalReasons.add(t.terminalReason);
    if (t.derivedReason) l.reasonsDerived += 1;
    const v = validate(t.row, { imported: true });
    if (!v.ok) {
      for (const e of v.errors) l.invalid[`${e.field} (${e.problem})`] = (l.invalid[`${e.field} (${e.problem})`] ?? 0) + 1;
      l.stopped.invalid = (l.stopped.invalid ?? 0) + 1;
      continue;
    }
    l.toImport += 1;
    rows.push(t.row);
  }
  const stopped = Object.values(lanes).reduce((n, l) => n + Object.values(l.stopped).reduce((a, b) => a + b, 0), 0);
  return { lanes, rows, stopped };
}

/** The dry run as lines: counts, field names and enum values only. */
export function report(/** @type {ReturnType<typeof dryRun>} */ d) {
  const lines = Object.entries(d.lanes).sort(([a], [b]) => a.localeCompare(b)).map(([lane, l]) => {
    const stops = Object.entries(l.stopped).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    const invalid = Object.entries(l.invalid).map(([k, n]) => `${k} ${n}`).join(', ');
    return `${lane}: exported ${l.exported}, to import ${l.toImport}, stopped ${stops}, reasons derived ${l.reasonsDerived}`
      + `${invalid ? `, invalid fields ${invalid}` : ''}, terminal_reason [${[...l.terminalReasons].sort().join(', ')}]`;
  });
  return [...lines, `stopped in all: ${d.stopped}`];
}

/**
 * §7 step 4: send the rows with the importer role, 25 to a `POST`. Returns the rows stored and
 * the rows refused, by field name.
 * @param {Record<string, any>[]} rows
 * @param {string} key
 * @param {{ aws: typeof aws, post: typeof post, profile: string }} deps
 */
export async function send(rows, key, deps) {
  const owner = ['--profile', deps.profile, '--region', REGION, '--output', 'json'];
  const who = JSON.parse(deps.aws(['sts', 'get-caller-identity', ...owner]).stdout || '{}');
  const stack = JSON.parse(deps.aws(['cloudformation', 'describe-stacks', '--stack-name', STACK, ...owner]).stdout || '{}');
  const url = (stack?.Stacks?.[0]?.Outputs ?? []).find((/** @type {any} */ o) => o.OutputKey === 'IngestUrl')?.OutputValue;
  const c = JSON.parse(deps.aws(['sts', 'assume-role', '--role-arn', `arn:aws:iam::${who.Account}:role/kanon-telemetry-importer`,
    '--role-session-name', 'kanon-import', ...owner]).stdout || '{}')?.Credentials;
  if (!who.Account || !url || !c) throw new Error('the stack or the importer role is not reachable: is it deployed with --importer?');
  const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  let stored = 0;
  /** @type {Record<string, number>} */
  const refused = {};
  for (let i = 0; i < rows.length; i += 25) {
    const res = await deps.post(`${url}?key=${encodeURIComponent(key)}`, JSON.stringify(rows.slice(i, i + 25)), creds);
    if (!Array.isArray(res.json?.results)) throw new Error(`the function answered ${res.status}`);
    for (const r of res.json.results) {
      if (r.status === 'stored') stored += 1;
      else for (const e of r.errors ?? [{ field: '(row)', problem: 'refused' }]) refused[`${e.field} (${e.problem})`] = (refused[`${e.field} (${e.problem})`] ?? 0) + 1;
    }
  }
  return { stored, refused };
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({ options: {
    export: { type: 'string' }, key: { type: 'string' }, apply: { type: 'boolean', default: false }, profile: { type: 'string', default: 'kanon' },
  } });
  if (!values.export || (values.apply && !values.key)) {
    console.error('usage: import.mjs --export <scan.json> [--key <key> --apply] [--profile kanon]');
    process.exit(2);
  }
  const items = JSON.parse(readFileSync(values.export, 'utf8')).Items ?? [];
  const d = dryRun(items);
  for (const line of report(d)) console.log(line);
  if (values.apply) {
    const { stored, refused } = await send(d.rows, /** @type {string} */ (values.key), { aws, post, profile: values.profile });
    console.log(`stored ${stored}; refused ${Object.entries(refused).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
    process.exit(d.stopped === 0 && Object.keys(refused).length === 0 ? 0 : 1);
  }
  process.exit(d.stopped === 0 ? 0 : 1);
}
