import { describe, expect, it } from 'vitest';

import {
  addMonths,
  handle,
  keysOf,
  MAX_ROWS,
  PARTITIONS,
  putItem,
  stamp,
  TEXT_FIELDS,
  toAttributes,
} from '../../infra/telemetry/function/index.mjs';
import { ATTRIBUTES, readPage, rowOf, WORK_PROJECTION } from '../../infra/telemetry/function/aggregate.mjs';
import { closingIssues } from '../../scripts/metrics/join.mjs';
import { sign } from '../../infra/telemetry/function/sigv4.mjs';
import { DEPLOY_REFUSALS, LANES, SCHEMAS } from '../../actions/agent-telemetry/schema.mjs';
import { nameContext } from '../../actions/agent-telemetry/scrub.mjs';
import { keysCache } from '../../infra/telemetry/function/register-store.mjs';
import { fakeDynamo, REGISTER, type Fake } from './helpers/fake-dynamo.js';

/**
 * Plan 0002 step S3: the ingest function (§4), its stamps (§10) and its signer, against fake
 * function URL events, on the SigV4 path (the unqualified function's IAM URL). Since plan 0008 J3
 * that path reads its keys from the register table (§9), here `helpers/fake-dynamo.ts`, where k1
 * and k2 are registered and active. The token path's endpoints are `telemetry-endpoints.test.ts`.
 * No AWS.
 */

type Row = Record<string, unknown>;
type Item = Record<string, unknown>;

const ACCOUNT = '1'.repeat(6) + '2'.repeat(6);
const NOW = Date.parse('2026-10-02T12:00:00Z');
const DAY = 86_400_000;
const env = { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT, IMPORTER_ROLE: '', BACKFILL_ROLE: '' };

/**
 * A registration in the fake register: the registration item and its key item. `name_hashes`
 * only when a repository is given, as the import writes them.
 */
const register = (f: Fake, key: string, id: string, over: Record<string, unknown> = {}, repository?: string) => {
  f.seed(REGISTER, {
    pk: `repo#${id}`, repository_id: id, repository_owner_id: '9', key, status: 'active', default_ref: 'refs/heads/main', source: 'import',
    ...(repository ? { repository, name_hashes: [...nameContext({ repository })].sort() } : {}), ...over,
  });
  f.seed(REGISTER, { pk: `key#${key}`, repository_id: id });
};
/** k1 and k2, active, with no name hashes. */
const plainRegister = (f: Fake) => { register(f, 'k1', '1'); register(f, 'k2', '2'); };
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const runRow = (over: Row = {}): Row => ({
  schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 2,
  role: 'reviewer', lane: 'review', outcome: 'ok', reason: 'none', kanon_version: '0.12.0', pr_number: 42, ...over,
});
const workRow = (over: Row = {}): Row => ({
  schema_version: 1, row_kind: 'work_item', tag: 'run', recorded_at: iso(NOW - 60_000), pr_number: 42,
  closed_at: '2026-09-30T08:00:00Z', fate: 'merged', ...over,
});

const event = (body: unknown, opts: { role?: string, account?: string, method?: string, key?: string, raw?: string, base64?: boolean } = {}) => {
  const text = opts.raw ?? JSON.stringify(body);
  return {
    requestContext: {
      http: { method: opts.method ?? 'POST' },
      authorizer: { iam: { userArn: `arn:aws:sts::${opts.account ?? ACCOUNT}:assumed-role/${opts.role ?? 'kanon-telemetry-k1-writer'}/GitHubActions` } },
    },
    ...(opts.key !== undefined ? { queryStringParameters: { key: opts.key } } : {}),
    body: opts.base64 ? Buffer.from(text).toString('base64') : text,
    isBase64Encoded: Boolean(opts.base64),
  };
};

async function call(ev: unknown, envOver: Record<string, string> = {}, setup: (f: Fake) => void = plainRegister) {
  const puts: Item[] = [];
  const logs: string[] = [];
  const f = fakeDynamo();
  setup(f);
  const res = await handle(ev, {
    env: { ...env, ...envOver },
    now: () => NOW,
    put: async (item: Item) => { puts.push(item); },
    log: (l: string) => logs.push(l),
    db: f.db,
    keys: keysCache(),
  });
  return { status: res.statusCode, body: JSON.parse(res.body), puts, logs };
}

describe('the ingest function accepts a valid row and stamps it', () => {
  it('a valid run row gets 200 and is stored under the caller\'s key', async () => {
    const r = await call(event([runRow()]));
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ status: 'stored' }]);
    expect(r.puts).toHaveLength(1);
    expect(r.puts[0]).toMatchObject({
      pk: 'k1#review',
      sk: '20261002T115900Z#33679229731-2-42',
      source: 'collector',
      received_at: new Date(NOW).toISOString(),
      expires_at: Math.floor(Date.parse('2027-11-02T11:59:00Z') / 1000),
    });
  });

  it('the sort key falls back to the issue number, then to 0', async () => {
    const { puts } = await call(event([runRow({ pr_number: undefined, issue_number: 7 }), runRow({ pr_number: undefined, run_id: 5 })]));
    expect(puts.map((p) => p.sk)).toEqual(['20261002T115900Z#33679229731-2-7', '20261002T115900Z#5-2-0']);
  });

  it('a test or smoke row expires 30 days after recorded_at', async () => {
    const { puts } = await call(event([runRow({ tag: 'test' }), runRow({ tag: 'smoke' })]));
    const want = Math.floor((NOW - 60_000 + 30 * DAY) / 1000);
    expect(puts.map((p) => p.expires_at)).toEqual([want, want]);
  });

  it('a work item is keyed by its PR alone and expires 13 months after closed_at', async () => {
    const { status, puts } = await call(event([workRow()]));
    expect(status).toBe(200);
    expect(puts[0]).toMatchObject({ pk: 'k1#work', sk: 'pr-0000000042', expires_at: Math.floor(Date.parse('2027-10-30T08:00:00Z') / 1000) });
  });

  it('a body may be base64-encoded', async () => {
    expect((await call(event([runRow()], { base64: true }))).status).toBe(200);
  });

  it('13 calendar months clamp to the end of a shorter month', () => {
    expect(new Date(addMonths(Date.parse('2026-01-31T10:00:00Z'), 13)).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(new Date(addMonths(Date.parse('2026-10-02T10:00:00Z'), -13)).toISOString()).toBe('2025-09-02T10:00:00.000Z');
  });
});

describe('the ingest function rejects, naming fields only', () => {
  it('a row with an extra field gets 422 naming that field, and is not stored', async () => {
    const r = await call(event([runRow({ surplus_field: 'SECRET-CONTENT' })]));
    expect(r.status).toBe(422);
    expect(r.body.results[0].errors).toEqual([{ field: 'surplus_field', problem: 'unknown' }]);
    expect(r.puts).toEqual([]);
    expect(JSON.stringify(r.body) + r.logs.join('\n')).not.toContain('SECRET-CONTENT');
  });

  it('a row naming its partition gets 422', async () => {
    for (const field of ['pk', 'sk', 'source', 'received_at', 'expires_at']) {
      const r = await call(event([runRow({ [field]: 'k2#review' })]));
      expect(r.status).toBe(422);
      expect(r.body.results[0].errors.map((e: { field: string }) => e.field)).toContain(field);
      expect(r.puts).toEqual([]);
    }
  });

  it('the batch answers per row: the valid rows are stored, the response is 422', async () => {
    const r = await call(event([runRow(), runRow({ surplus_field: 1 }), runRow({ run_id: 9 })]));
    expect(r.status).toBe(422);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['stored', 'rejected', 'stored']);
    expect(r.puts).toHaveLength(2);
  });

  it('logs keys and field names, never a value', async () => {
    const r = await call(event([runRow(), runRow({ reason: 'claude-opus never ran: SECRET-CONTENT' })]));
    expect(r.logs).toHaveLength(1);
    expect(JSON.parse(r.logs[0]!)).toEqual({
      caller: 'writer', key: 'k1',
      rows: [{ index: 0, pk: 'k1#review', sk: '20261002T115900Z#33679229731-2-42' }, { index: 1, rejected: ['reason'] }],
    });
  });
});

describe('the recorded_at window (§4): 8 days back, 10 minutes ahead', () => {
  const at = async (ms: number, envOver = {}, opts = {}) =>
    (await call(event([runRow({ recorded_at: iso(ms) })], opts), envOver)).body.results[0];

  it('accepts a row recorded just inside the window, at either end', async () => {
    expect(await at(NOW - 8 * DAY + 1000)).toEqual({ status: 'stored' });
    expect(await at(NOW + 9 * 60_000)).toEqual({ status: 'stored' });
  });

  it('rejects a row recorded more than 8 days ago, or more than 10 minutes ahead', async () => {
    expect(await at(NOW - 8 * DAY - 1000)).toEqual({ status: 'rejected', errors: [{ field: 'recorded_at', problem: 'window' }] });
    expect(await at(NOW + 11 * 60_000)).toEqual({ status: 'rejected', errors: [{ field: 'recorded_at', problem: 'window' }] });
  });

  it('a work item must have closed in the past, at most 13 months ago', async () => {
    for (const closed of [NOW + 60_000, addMonths(NOW, -13) - 1000]) {
      const r = await call(event([workRow({ closed_at: iso(closed) })]));
      expect(r.body.results[0].errors).toEqual([{ field: 'closed_at', problem: 'window' }]);
    }
  });

  it('the importer may backdate to 13 months, and no further', async () => {
    const importer = { IMPORTER_ROLE: 'kanon-telemetry-importer' };
    const opts = { role: 'kanon-telemetry-importer', key: 'k2' };
    const ok = await call(event([runRow({ kanon_version: undefined, recorded_at: iso(addMonths(NOW, -13) + 60_000) })], opts), importer);
    expect(ok.status).toBe(200);
    expect(ok.puts[0]).toMatchObject({ pk: 'k2#review', source: 'import' });
    const old = await call(event([runRow({ kanon_version: undefined, recorded_at: iso(addMonths(NOW, -13) - 60_000) })], opts), importer);
    expect(old.body.results[0].errors).toEqual([{ field: 'recorded_at', problem: 'window' }]);
  });

  it('an imported row carries no kanon_version, and every other row must (decision 17)', async () => {
    const importer = { IMPORTER_ROLE: 'kanon-telemetry-importer' };
    const opts = { role: 'kanon-telemetry-importer', key: 'k2' };
    const imported = await call(event([runRow({ kanon_version: undefined })], opts), importer);
    expect(imported.status).toBe(200);
    expect(imported.puts[0]).not.toHaveProperty('kanon_version');
    // A version on an imported row would claim a Kanon release the run never had.
    for (const v of ['0.12.0', 'dev']) {
      const r = await call(event([runRow({ kanon_version: v })], opts), importer);
      expect(r.status).toBe(422);
      expect(r.body.results[0].errors).toEqual([{ field: 'kanon_version', problem: 'not-allowed' }]);
    }
    // A writer's row without one is refused, as before.
    const writer = await call(event([runRow({ kanon_version: undefined })]));
    expect(writer.status).toBe(422);
    expect(writer.body.results[0].errors).toEqual([{ field: 'kanon_version', problem: 'required' }]);
  });

  it('the backfill role writes work items only, in the normal window', async () => {
    const backfill = { BACKFILL_ROLE: 'kanon-telemetry-backfill' };
    const opts = { role: 'kanon-telemetry-backfill', key: 'k2' };
    const ok = await call(event([workRow()], opts), backfill);
    expect(ok.status).toBe(200);
    expect(ok.puts[0]).toMatchObject({ pk: 'k2#work', source: 'backfill' });
    expect((await call(event([runRow()], opts), backfill)).body.results[0].errors).toEqual([{ field: 'row_kind', problem: 'not-allowed' }]);
    const old = await call(event([workRow({ recorded_at: iso(NOW - 9 * DAY) })], opts), backfill);
    expect(old.body.results[0].errors).toEqual([{ field: 'recorded_at', problem: 'window' }]);
  });
});

describe('a deploy row is stored under <key>#deploy (plan 0010 §10, D9)', () => {
  const deployRow = (over: Row = {}): Row => ({
    schema_version: 1, row_kind: 'deploy', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 1,
    kanon_version: '0.12.0', role: 'production', position: 2, outcome: 'ok', ...over,
  });

  it('is keyed <key>#deploy, by time, run, attempt and the environment\'s position', () => {
    expect(keysOf('k1', deployRow())).toEqual({ pk: 'k1#deploy', sk: '20261002T115900Z#33679229731-1-2' });
  });

  it('a valid deploy row is stored, from the writer and the importer, each under its own key', async () => {
    const writer = await call(event([deployRow()]));
    expect(writer.status).toBe(200);
    expect(writer.puts).toEqual([expect.objectContaining({
      pk: 'k1#deploy', sk: '20261002T115900Z#33679229731-1-2', row_kind: 'deploy', source: 'collector',
      expires_at: Math.floor(addMonths(NOW - 60_000, 13) / 1000),
    })]);
    const importer = await call(event([deployRow()], { role: 'kanon-telemetry-importer', key: 'k2' }), { IMPORTER_ROLE: 'kanon-telemetry-importer' });
    expect(importer.status).toBe(200);
    expect(importer.puts).toEqual([expect.objectContaining({ pk: 'k2#deploy', source: 'import' })]);
  });

  it('a smoke or test deploy row keeps 30 days; the backfill role may not send one', async () => {
    const smoke = await call(event([deployRow({ tag: 'smoke' })]));
    expect(smoke.puts[0]).toMatchObject({ pk: 'k1#deploy', expires_at: Math.floor((NOW - 60_000 + 30 * DAY) / 1000) });
    const backfill = await call(event([deployRow()], { role: 'kanon-telemetry-backfill', key: 'k2' }), { BACKFILL_ROLE: 'kanon-telemetry-backfill' });
    expect(backfill.body.results[0].errors).toEqual([{ field: 'row_kind', problem: 'not-allowed' }]);
    expect(backfill.puts).toEqual([]);
  });

  it('every refusal code the schema admits is stored (the intake reads the schema\'s list, not its own)', async () => {
    const rows = DEPLOY_REFUSALS.map((refusal) => deployRow({ outcome: 'refused', failed_stage: 'gate', refusal }));
    const r = await call(event(rows.slice(0, MAX_ROWS)));
    expect(r.status).toBe(200);
    expect(r.puts.every((p) => p.pk === 'k1#deploy')).toBe(true);
  });

  it('beside a run row, each lands in its own partition', async () => {
    const r = await call(event([runRow(), deployRow()]));
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['stored', 'stored']);
    expect(r.puts.map((p) => p.pk)).toEqual(['k1#review', 'k1#deploy']);
  });

  it("the aggregate never reads it: no Query names <key>#deploy, and no projection names a deploy field (decision 11)", async () => {
    const fieldsOf = (kind: string) => new Set(Object.values(SCHEMAS[kind as keyof typeof SCHEMAS] as Record<string, Record<string, unknown>>).flatMap((v) => Object.keys(v)));
    const deployOnly = [...fieldsOf('deploy')].filter((f) => !fieldsOf('run').has(f) && !fieldsOf('work_item').has(f));
    expect(deployOnly).toEqual(expect.arrayContaining(['position', 'since_release_ms', 'redeploy', 'rollback']));
    const requests: Array<{ ExpressionAttributeValues: Record<string, { S: string }>, ExpressionAttributeNames: Record<string, string> }> = [];
    await readPage({ k1: 'acme' }, async (req) => { requests.push(req as (typeof requests)[number]); return { Items: [] }; }, 'kanon-telemetry');
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(req.ExpressionAttributeValues[':p']?.S).not.toMatch(/#deploy$/);
      const projected = Object.values(req.ExpressionAttributeNames as Record<string, string>);
      expect(projected.filter((f) => deployOnly.includes(f))).toEqual([]);
    }
    expect(ATTRIBUTES.filter((f) => deployOnly.includes(f))).toEqual([]);
  });
});

describe('plan 0013 S2 at intake: deploy row version 2 is stored, a smoke-check row is refused until S3', () => {
  const deployV2 = (over: Row = {}): Row => ({
    schema_version: 2, row_kind: 'deploy', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 1,
    kanon_version: '0.12.0', role: 'production', position: 2, outcome: 'smoke_failed', failed_stage: 'reset', reset_ms: 4_000, ...over,
  });
  const smokeCheck = (over: Row = {}): Row => ({
    schema_version: 1, row_kind: 'smoke_check', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 1,
    trigger: 'schedule', kanon_version: '0.12.0', role: 'pre-production', position: 1, outcome: 'ok', reset_ran: true, ...over,
  });

  it('a deploy row at version 2, failed at `reset`, is stored under <key>#deploy like version 1', async () => {
    const r = await call(event([deployV2()]));
    expect(r.status).toBe(200);
    expect(r.puts).toEqual([expect.objectContaining({ pk: 'k1#deploy', schema_version: 2, failed_stage: 'reset', reset_ms: 4_000 })]);
  });

  it('a valid smoke-check row gets 422 naming row_kind, from the writer and the importer, and nothing is stored', async () => {
    const writer = await call(event([smokeCheck()]));
    expect(writer.status).toBe(422);
    expect(writer.body.results[0].errors).toEqual([{ field: 'row_kind', problem: 'not-allowed' }]);
    expect(writer.puts).toEqual([]);
    const importer = await call(event([smokeCheck()], { role: 'kanon-telemetry-importer', key: 'k2' }), { IMPORTER_ROLE: 'kanon-telemetry-importer' });
    expect(importer.status).toBe(422);
    expect(importer.body.results[0].errors).toEqual([{ field: 'row_kind', problem: 'not-allowed' }]);
    expect(importer.puts).toEqual([]);
  });

  it('the rows beside it are still stored, and no partition is named for it yet', async () => {
    const r = await call(event([runRow(), smokeCheck({ outcome: 'failed', failed_stage: 'smoke' })]));
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['stored', 'rejected']);
    expect(r.puts.map((p) => p.pk)).toEqual(['k1#review']);
    expect(PARTITIONS).not.toContain('smoke_check');
  });

  it('a smoke-check row with an environment field is rejected for the field, not only for its kind', async () => {
    const r = await call(event([smokeCheck({ environment: 'staging' })]));
    expect(r.status).toBe(422);
    expect(r.body.results[0].errors).toEqual([{ field: 'environment', problem: 'unknown' }]);
    expect(JSON.stringify(r.body)).not.toContain('staging');
  });
});

describe('a notify row is stored in its lane\'s partition under notify# (plan 0011 §11, N5)', () => {
  const notifyRow = (over: Row = {}): Row => ({
    schema_version: 1, row_kind: 'notify', tag: 'run', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 2,
    producer_attempt: 2, lane: 'project-digest', kanon_version: '0.12.0', kind: 'project-digest', contract_version: 1,
    hook: 'slack', outcome: 'posted', duration_ms: 900, ...over,
  });
  /** The run row the same run's producer wrote: same lane, run and attempt, same second. */
  const producerRow = () => runRow({ lane: 'project-digest', role: 'overseer', run_attempt: 2, pr_number: undefined });

  it('is keyed <key>#<lane>, under notify#, by time, run and attempt', () => {
    expect(keysOf('k1', notifyRow())).toEqual({ pk: 'k1#project-digest', sk: 'notify#20261002T115900Z#33679229731-2' });
  });

  it('never collides with the run row of the same run, and a re-run of notify alone is its own item', () => {
    const run = keysOf('k1', producerRow());
    const notify = keysOf('k1', notifyRow());
    expect(notify.pk).toBe(run.pk);
    expect(notify.sk).not.toBe(run.sk);
    expect(keysOf('k1', notifyRow({ run_attempt: 3, producer_attempt: 2 })).sk).not.toBe(notify.sk);
  });

  it('falls outside every time window a run-row read asks for, whose sort keys begin with the time', () => {
    // GET /v1/rows/self reads a lane between compact(from) and compact(to) + '~': here the day both rows were written.
    const within = (sk: string) => sk >= '20261002T000000Z' && sk <= '20261002T235959Z~';
    expect(within(keysOf('k1', producerRow()).sk)).toBe(true);
    expect(within(keysOf('k1', notifyRow()).sk)).toBe(false);
  });

  it('a row of each outcome is stored from the writer, and from the importer under its own key', async () => {
    const rows = [
      notifyRow(),
      notifyRow({ outcome: 'failed', failure: 'hook-step-failed', run_id: 2 }),
      notifyRow({ outcome: 'skipped', skip_reason: 'no-secret', producer_attempt: undefined, contract_version: undefined, run_id: 3 }),
    ].map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
    const writer = await call(event(rows));
    expect(writer.status).toBe(200);
    expect(writer.puts.map((p) => [p.pk, String(p.sk).slice(0, 7), p.source])).toEqual([
      ['k1#project-digest', 'notify#', 'collector'], ['k1#project-digest', 'notify#', 'collector'], ['k1#project-digest', 'notify#', 'collector'],
    ]);
    expect(writer.puts[0]).toMatchObject({ expires_at: Math.floor(addMonths(NOW - 60_000, 13) / 1000) });
    const importer = await call(event([notifyRow()], { role: 'kanon-telemetry-importer', key: 'k2' }), { IMPORTER_ROLE: 'kanon-telemetry-importer' });
    expect(importer.puts).toEqual([expect.objectContaining({ pk: 'k2#project-digest', source: 'import' })]);
  });

  it('a smoke notify row keeps 30 days; the backfill role may not send one', async () => {
    const smoke = await call(event([notifyRow({ tag: 'smoke' })]));
    expect(smoke.puts[0]).toMatchObject({ expires_at: Math.floor((NOW - 60_000 + 30 * DAY) / 1000) });
    const backfill = await call(event([notifyRow()], { role: 'kanon-telemetry-backfill', key: 'k2' }), { BACKFILL_ROLE: 'kanon-telemetry-backfill' });
    expect(backfill.body.results[0].errors).toEqual([{ field: 'row_kind', problem: 'not-allowed' }]);
    expect(backfill.puts).toEqual([]);
  });

  it('beside its producer\'s run row, both are stored, in the same partition under different keys', async () => {
    const r = await call(event([producerRow(), notifyRow()]));
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['stored', 'stored']);
    expect(new Set(r.puts.map((p) => p.pk))).toEqual(new Set(['k1#project-digest']));
    expect(new Set(r.puts.map((p) => p.sk)).size).toBe(2);
  });

  it('a row carrying a URL is refused whole, naming the field, and the value reaches neither the answer nor the log', async () => {
    const r = await call(event([notifyRow({ url: 'https://hooks.slack.com/services/T0/B0/secret' })]));
    expect(r.status).toBe(422);
    expect(r.body.results[0].errors).toEqual([{ field: 'url', problem: 'unknown' }]);
    expect(r.puts).toEqual([]);
    expect(JSON.stringify(r.body) + r.logs.join('\n')).not.toContain('hooks.slack.com');
  });

  it('erasure reaches it: its partition is one PARTITIONS names', () => {
    expect(PARTITIONS.map((p) => `k1#${p}`)).toContain(keysOf('k1', notifyRow()).pk);
  });
});

describe('a finding row at intake (plan 0006 §5 step 4, F4)', () => {
  // Invented repositories: k1's words are `acme`, `corp`, `widget` and `shop`; k2's are not. Since
  // plan 0008 J3 the SigV4 path reads them from each key's registration, as the import writes them.
  const named = (f: Fake) => { register(f, 'k1', '1', {}, 'acme-corp/widget-shop'); register(f, 'k2', '2', {}, 'zorblax/quintet'); };
  const findingRow = (over: Row = {}): Row => ({
    schema_version: 1, row_kind: 'finding', tag: 'test', recorded_at: iso(NOW - 60_000), run_id: 33679229731, run_attempt: 2,
    finding_index: 3, reporter: 'overseer', subject: 'guard', kanon_version: '0.37.0', fix_category: 'guard', evidence_level: 'codes', ...over,
  });
  const withText = (evidence: string): Row => findingRow({
    subject: 'lane', lane: 'review', reason: 'did_not_finish', evidence_level: 'evidence', evidence,
    suggested_fix: 'Cap the re-reads in the review prompt.', scrub_version: 1,
  });
  const CLEAN = 'Expected: the review lane finishes within its turn cap (K-AGENT-12).\nObserved: it stopped at stage `agent`.';
  const errorsOf = (r: { body: { results: Array<{ errors?: unknown }> } }) => r.body.results[0]!.errors;

  it('is keyed <key>#finding, by time, run, attempt and its place in the report (§2.3)', () => {
    expect(keysOf('k1', findingRow())).toEqual({ pk: 'k1#finding', sk: '20261002T115900Z#33679229731-2-3' });
  });

  it("a writer's valid finding, codes or evidence, gets 200 and is stored under the writer's key", async () => {
    const r = await call(event([findingRow(), withText(CLEAN)]), {}, named);
    expect(r.status).toBe(200);
    expect(r.puts).toHaveLength(2);
    expect(r.puts[0]).toMatchObject({ pk: 'k1#finding', sk: '20261002T115900Z#33679229731-2-3', source: 'collector', expires_at: Math.floor((NOW - 60_000 + 30 * DAY) / 1000) });
    expect(r.puts[1]).toMatchObject({ pk: 'k1#finding', evidence: CLEAN, scrub_version: 1 });
  });

  it('scrub_version 2 is stored, and 1 still is, for the overlap until every lane sends 2 (kanon#724)', async () => {
    const r = await call(event([withText(CLEAN), { ...withText(CLEAN), finding_index: 4, scrub_version: 2 }]), {}, named);
    expect(r.status).toBe(200);
    expect(r.puts.map((p) => p.scrub_version)).toEqual([1, 2]);
  });

  it('an unknown scrub_version gets 422 naming scrub_version (range), and nothing is stored', async () => {
    for (const v of [0, 3]) {
      const r = await call(event([{ ...withText(CLEAN), scrub_version: v }]), {}, named);
      expect(r.status).toBe(422);
      expect(errorsOf(r)).toEqual([{ field: 'scrub_version', problem: 'range' }]);
      expect(r.puts).toEqual([]);
    }
  });

  it('a run-tagged finding is kept 13 months, as a run row (decision 11)', async () => {
    const r = await call(event([findingRow({ tag: 'run' })]), {}, named);
    expect(r.puts[0]!.expires_at).toBe(Math.floor(Date.parse('2027-11-02T11:59:00Z') / 1000));
  });

  it('is refused from the importer and the backfill role, naming row_kind: writers only', async () => {
    const roles = [
      [{ role: 'kanon-telemetry-importer', key: 'k2' }, { IMPORTER_ROLE: 'kanon-telemetry-importer' }],
      [{ role: 'kanon-telemetry-backfill', key: 'k2' }, { BACKFILL_ROLE: 'kanon-telemetry-backfill' }],
    ] as const;
    for (const [opts, envOver] of roles) {
      const r = await call(event([findingRow()], opts), envOver, named);
      expect(r.status).toBe(422);
      expect(errorsOf(r)).toEqual([{ field: 'row_kind', problem: 'not-allowed' }]);
      expect(r.puts).toEqual([]);
    }
  });

  it('a URL in the evidence gets 422 naming evidence (url), and the URL is never echoed or logged', async () => {
    const r = await call(event([withText('Observed: the lane read https://example.com/SECRET-CONTENT first.')]), {}, named);
    expect(r.status).toBe(422);
    expect(errorsOf(r)).toContainEqual({ field: 'evidence', problem: 'url' });
    expect(JSON.stringify(r.body) + r.logs.join('\n')).not.toContain('SECRET-CONTENT');
  });

  it("checks the text against the SENDER's name hashes: a word of its own repository's name is refused, another's is not", async () => {
    const text = 'Observed: the widget lane stopped at stage `agent`.';
    const own = await call(event([withText(text)]), {}, named);
    expect(own.status).toBe(422);
    expect(errorsOf(own)).toEqual([{ field: 'evidence', problem: 'name' }]);
    const other = await call(event([withText(text)], { role: 'kanon-telemetry-k2-writer' }), {}, named);
    expect(other.status).toBe(200);
    // The same in the suggested fix.
    const fix = await call(event([{ ...withText(CLEAN), suggested_fix: 'Rename the Shop step.' }]), {}, named);
    expect(errorsOf(fix)).toEqual([{ field: 'suggested_fix', problem: 'name' }]);
  });

  // kanon#612, the case seen live: Kanon's own name in the evidence of a sender whose repository is `kanon`.
  it("Kanon's own vocabulary is never a name: \"the flags Kanon writes\" is stored from a sender whose repository is `kanon`", async () => {
    const kanon = (f: Fake) => register(f, 'k1', '1', {}, 'acme-corp/kanon');
    const text = 'Observed: the flags Kanon writes. The Author App ran on GitHub Actions.';
    const r = await call(event([{ ...withText(text), suggested_fix: 'Nothing to change in Kanon.' }]), {}, kanon);
    expect(r.status).toBe(200);
    expect(r.puts[0]).toMatchObject({ evidence: text, suggested_fix: 'Nothing to change in Kanon.' });
    // The sender's own word is still refused.
    const own = await call(event([withText('Observed: the Acme lane stopped.')]), {}, kanon);
    expect(errorsOf(own)).toEqual([{ field: 'evidence', problem: 'name' }]);
  });

  it("stores no finding for a key without name hashes, or with malformed ones: the sender's check can't run", async () => {
    const hashes = (repository: string) => [...nameContext({ repository })].sort();
    for (const over of [{}, { name_hashes: [] }, { name_hashes: ['not-a-hash'] }, { name_hashes: [...hashes('acme-corp/widget-shop'), 'x'] }, { name_hashes: 'abc' }]) {
      // Hashes in the environment, as `render.mjs` wrote them before kanon#607, never count: only the registration's do.
      const r = await call(event([findingRow()]), { NAME_HASHES: `k1=${hashes('acme-corp/widget-shop').join(':')}` }, (f) => register(f, 'k1', '1', over));
      expect(r.status).toBe(422);
      expect(errorsOf(r)).toEqual([{ field: 'row_kind', problem: 'no-sender-context' }]);
    }
  });

  it("refuses a registered key held in the text as a word, whoever's it is, naming the field and never the key", async () => {
    // `k2` has neither a key's hex shape nor a partition's, so only intake's key check finds it.
    const r = await call(event([withText('Observed: the row named k2 as its partition.')]), {}, named);
    expect(r.status).toBe(422);
    expect(errorsOf(r)).toEqual([{ field: 'evidence', problem: 'key' }]);
    // Inside a longer run of letters and digits it is not the key.
    expect((await call(event([withText('Observed: the k2x step.')]), {}, named)).status).toBe(200);
  });

  it('refuses a key joined to its neighbours by -, and a key that itself holds - (#737)', async () => {
    const hyphenated = (f: Fake) => { named(f); register(f, 'ab-c7d9', '3', {}, 'zorblax/sextet'); };
    for (const text of ['Observed: k2-prod failed.', 'Observed: the pre-k2 step.', 'Observed: the ab-c7d9 lane.', 'Observed: x-ab-c7d9-prod failed.']) {
      const r = await call(event([withText(text)]), {}, hyphenated);
      expect(r.status, text).toBe(422);
      expect(errorsOf(r), text).toEqual([{ field: 'evidence', problem: 'key' }]);
    }
    // The same in the suggested fix.
    const fix = await call(event([{ ...withText(CLEAN), suggested_fix: 'Retry k2-prod.' }]), {}, hyphenated);
    expect(errorsOf(fix)).toEqual([{ field: 'suggested_fix', problem: 'key' }]);
    // Inside a longer run of letters and digits a key that holds - is not the key either.
    for (const text of ['Observed: the ab-c7d9e step.', 'Observed: the zab-c7d9 step.']) {
      expect((await call(event([withText(text)]), {}, hyphenated)).status, text).toBe(200);
    }
  });

  it('runs assertNoKey over every field: a vocabulary value that is a registered key is refused', async () => {
    const r = await call(event([findingRow({ kanon_version: 'dev' })]), {}, (f) => { named(f); f.seed(REGISTER, { pk: 'key#dev', repository_id: '3' }); });
    expect(r.status).toBe(422);
    expect(errorsOf(r)).toEqual([{ field: 'kanon_version', problem: 'key' }]);
  });

  it('reads the text fields from the schema', () => {
    expect(TEXT_FIELDS).toEqual(['evidence', 'suggested_fix']);
  });
});

describe('the partition comes from the caller\'s role, never the request', () => {
  it('a writer for another registered key writes that key', async () => {
    expect((await call(event([runRow()], { role: 'kanon-telemetry-k2-writer' }))).puts[0]!.pk).toBe('k2#review');
  });

  it('a writer may not name a key', async () => {
    const r = await call(event([runRow()], { key: 'k2' }));
    expect(r.status).toBe(400);
    expect(r.puts).toEqual([]);
  });

  it('the importer and backfill roles must name a registered key', async () => {
    const importer = { IMPORTER_ROLE: 'kanon-telemetry-importer' };
    for (const key of [undefined, 'k9']) {
      const r = await call(event([runRow()], { role: 'kanon-telemetry-importer', ...(key ? { key } : {}) }), importer);
      expect(r.status).toBe(400);
    }
  });

  it('any other caller gets 403', async () => {
    const cases: Array<[Parameters<typeof event>[1], Partial<typeof env>]> = [
      [{ role: 'kanon-telemetry-k9-writer' }, {}], // not in the register
      [{ role: 'kanon-telemetry-k1-reader' }, {}],
      [{ role: 'AWSReservedSSO_Admin_x' }, {}],
      [{ account: '3'.repeat(12) }, {}], // another account
      [{ role: 'kanon-telemetry-importer', key: 'k1' }, {}], // the importer, while disabled
      [{ role: 'kanon-telemetry-backfill', key: 'k1' }, {}], // the backfill role, while disabled
    ];
    for (const [opts, envOver] of cases) {
      const r = await call(event([runRow()], opts), envOver);
      expect(r.status).toBe(403);
      expect(r.puts).toEqual([]);
    }
  });

  it('an event with no IAM context gets 403', async () => {
    const ev = event([runRow()]);
    delete (ev.requestContext as { authorizer?: unknown }).authorizer;
    expect((await call(ev)).status).toBe(403);
  });
});

describe('the SigV4 path reads its keys from the register table (plan 0008 §9)', () => {
  const importer = { IMPORTER_ROLE: 'kanon-telemetry-importer' };
  const backfill = { BACKFILL_ROLE: 'kanon-telemetry-backfill' };
  const suspendedK1 = (f: Fake) => { register(f, 'k1', '1', { status: 'suspended', suspended_at: '2026-10-01T00:00:00Z', suspended_reason: 'abuse' }); register(f, 'k2', '2'); };

  it('a suspended key is refused, 403 `suspended`: from its writer, and from the importer or the backfill role naming it', async () => {
    const cases: Array<[Parameters<typeof event>[1], Record<string, string>, unknown[]]> = [
      [{}, {}, [runRow()]],
      [{ role: 'kanon-telemetry-importer', key: 'k1' }, importer, [runRow({ kanon_version: undefined })]],
      [{ role: 'kanon-telemetry-backfill', key: 'k1' }, backfill, [workRow()]],
    ];
    for (const [opts, envOver, rows] of cases) {
      const r = await call(event(rows, opts), envOver, suspendedK1);
      expect(r.status, JSON.stringify(opts)).toBe(403);
      expect(r.body).toEqual({ error: 'suspended' });
      expect(r.puts).toEqual([]);
    }
    // The other key is not touched by k1's suspension.
    expect((await call(event([runRow()], { role: 'kanon-telemetry-k2-writer' }), {}, suspendedK1)).status).toBe(200);
  });

  it('an erased key is refused, 410 `erased`, while its walk runs', async () => {
    const r = await call(event([runRow()]), {}, (f) => register(f, 'k1', '1', { status: 'erased', erased_at: '2026-10-01T00:00:00Z' }));
    expect(r).toMatchObject({ status: 410, body: { error: 'erased' }, puts: [] });
  });

  it('a key the table does not hold is refused, whatever the environment says: WRITER_KEYS is no longer read', async () => {
    const r = await call(event([runRow()]), { WRITER_KEYS: 'k1,k2' }, () => {});
    expect(r).toMatchObject({ status: 403, body: { error: 'caller' }, puts: [] });
    const imp = await call(event([runRow({ kanon_version: undefined })], { role: 'kanon-telemetry-importer', key: 'k1' }), { ...importer, WRITER_KEYS: 'k1' }, () => {});
    expect(imp).toMatchObject({ status: 400, body: { error: 'key' }, puts: [] });
  });

  it('a key item whose registration holds another key finds nothing', async () => {
    const r = await call(event([runRow()]), {}, (f) => { register(f, 'k2', '1'); f.seed(REGISTER, { pk: 'key#k1', repository_id: '1' }); });
    expect(r).toMatchObject({ status: 403, puts: [] });
  });
});

describe('the request limits (§4)', () => {
  it('only POST', async () => expect((await call(event([runRow()], { method: 'GET' }))).status).toBe(405));
  it('at most 25 rows, at least one, as an array', async () => {
    expect(MAX_ROWS).toBe(25);
    expect((await call(event(Array.from({ length: 25 }, (_, i) => runRow({ run_id: i + 1 }))))).status).toBe(200);
    expect((await call(event(Array.from({ length: 26 }, (_, i) => runRow({ run_id: i + 1 }))))).status).toBe(400);
    expect((await call(event([]))).status).toBe(400);
    expect((await call(event(runRow()))).status).toBe(400);
    expect((await call(event(null, { raw: '{not json' }))).status).toBe(400);
  });
  it('at most 256 KB', async () => {
    expect((await call(event(null, { raw: `[${' '.repeat(256 * 1024)}]` }))).status).toBe(413);
  });
  it('a failed write answers 502 for that row', async () => {
    const f = fakeDynamo();
    plainRegister(f);
    const res = await handle(event([runRow()]), { env, now: () => NOW, put: async () => { throw new Error('throttled'); }, log: () => {}, db: f.db });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).results).toEqual([{ status: 'failed' }]);
  });
});

describe('the write and its signature', () => {
  it('signs exactly as AWS\'s published SigV4 example', () => {
    const h = sign({
      method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, region: 'us-east-1', service: 'iam',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, '
      + 'SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('signs the body: a different body gets a different signature', () => {
    const at = (body: string) => sign({ method: 'POST', url: 'https://x.example/', body, region: 'eu-central-1', service: 'lambda',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S' }, now: new Date('2026-10-02T12:00:00Z') }).authorization;
    expect(at('[1]')).not.toBe(at('[2]'));
    expect(at('[1]')).toBe(at('[1]'));
  });

  it('signs a session token in', () => {
    const h = sign({ method: 'POST', url: 'https://x.example/', region: 'eu-central-1', service: 'lambda',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' } });
    expect(h['x-amz-security-token']).toBe('T');
    expect(h.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });

  it('PutItem goes to the region\'s DynamoDB with typed attributes', async () => {
    const s = stamp(runRow({ is_error: false, total_cost_usd: 0.5 }), { caller: { kind: 'writer', key: 'k1' }, key: 'k1', now: NOW });
    if (!s.ok) throw new Error('row did not validate');
    const seen: { url: string, init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await putItem(s.item, { ...env, AWS_REGION: 'eu-central-1' }, fakeFetch);
    expect(seen[0]!.url).toBe('https://dynamodb.eu-central-1.amazonaws.com/');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers['x-amz-target']).toBe('DynamoDB_20120810.PutItem');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 .*\/eu-central-1\/dynamodb\/aws4_request/);
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.TableName).toBe('kanon-telemetry');
    expect(body.Item).toMatchObject({ pk: { S: 'k1#review' }, run_id: { N: '33679229731' }, is_error: { BOOL: false }, expires_at: { N: expect.any(String) } });
  });

  it('a DynamoDB error throws, so the row is reported failed', async () => {
    const fakeFetch = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    await expect(putItem({ pk: 'k1#review' }, env, fakeFetch)).rejects.toThrow('PutItem failed: HTTP400');
    // DynamoDB's own error names its code alone, never its message, which can quote the request.
    const quoting = (async () => new Response(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#ValidationException', message: 'k1#review is bad' }), { status: 400 })) as unknown as typeof fetch;
    await expect(putItem({ pk: 'k1#review' }, env, quoting)).rejects.toThrow(/^PutItem failed: ValidationException$/);
  });

  it('the partitions erasure walks are every lane, work, finding and deploy (plan 0006 §2.3, plan 0010 D9)', () => {
    expect(PARTITIONS).toEqual([...LANES, 'work', 'finding', 'deploy']);
  });
});

describe("a work item's closing_issues, through the write and back (kanon#754)", () => {
  it('is stored as the schema declares a list, a comma-separated string, and the page view reads it back', () => {
    const s = stamp(workRow({ closing_issues: '12,34' }), { caller: { kind: 'writer', key: 'k1' }, key: 'k1', now: NOW });
    if (!s.ok) throw new Error('row did not validate');
    const item = toAttributes(s.item);
    expect(item.closing_issues).toEqual({ S: '12,34' });
    const read = rowOf(item, WORK_PROJECTION) as Record<string, unknown>;
    expect(read.closing_issues).toBe('12,34');
    expect(closingIssues(read.closing_issues as string)).toEqual([12, 34]);
  });

  it('an array is refused at intake, naming the field, never stored without it', async () => {
    const r = await call(event([workRow({ closing_issues: [12, 34] })]));
    expect(r.status).toBe(422);
    expect(r.body.results[0].errors).toEqual([{ field: 'closing_issues', problem: 'type' }]);
    expect(r.puts).toHaveLength(0);
  });

  it('toAttributes refuses a value it has no form for, naming the field and never the value', () => {
    for (const v of [[12, 34], { n: 12 }, null]) {
      expect(() => toAttributes({ pk: 'k1#work', closing_issues: v })).toThrow(/^toAttributes: closing_issues is not a string, number or boolean$/);
    }
    // An undefined field is an absent one, as JSON carries it.
    expect(toAttributes({ pk: 'k1#work', closing_issues: undefined })).toEqual({ pk: { S: 'k1#work' } });
  });
});
