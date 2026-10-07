import { describe, expect, it } from 'vitest';

import {
  addMonths,
  handle,
  keysOf,
  MAX_ROWS,
  nameHashesOf,
  PARTITIONS,
  putItem,
  stamp,
  TEXT_FIELDS,
} from '../../infra/telemetry/function/index.mjs';
import { sign } from '../../infra/telemetry/function/sigv4.mjs';
import { LANES } from '../../actions/agent-telemetry/schema.mjs';
import { nameContext } from '../../actions/agent-telemetry/scrub.mjs';

/**
 * Plan 0002 step S3: the ingest function (§4), its stamps (§10) and its signer, against fake
 * function URL events. No AWS.
 */

type Row = Record<string, unknown>;
type Item = Record<string, unknown>;

const ACCOUNT = '1'.repeat(6) + '2'.repeat(6);
const NOW = Date.parse('2026-10-02T12:00:00Z');
const DAY = 86_400_000;
const env = { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT, WRITER_KEYS: 'k1,k2', NAME_HASHES: '', IMPORTER_ROLE: '', BACKFILL_ROLE: '' };
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

async function call(ev: unknown, envOver: Partial<typeof env> = {}) {
  const puts: Item[] = [];
  const logs: string[] = [];
  const res = await handle(ev, {
    env: { ...env, ...envOver },
    now: () => NOW,
    put: async (item: Item) => { puts.push(item); },
    log: (l: string) => logs.push(l),
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

describe('a finding row at intake (plan 0006 §5 step 4, F4)', () => {
  // Invented repositories: k1's words are `acme`, `corp`, `widget` and `shop`; k2's are not.
  const hashes = (repository: string) => [...nameContext({ repository })].sort().join(':');
  const findingEnv = { NAME_HASHES: `k1=${hashes('acme-corp/widget-shop')},k2=${hashes('zorblax/quintet')}` };
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
    const r = await call(event([findingRow(), withText(CLEAN)]), findingEnv);
    expect(r.status).toBe(200);
    expect(r.puts).toHaveLength(2);
    expect(r.puts[0]).toMatchObject({ pk: 'k1#finding', sk: '20261002T115900Z#33679229731-2-3', source: 'collector', expires_at: Math.floor((NOW - 60_000 + 30 * DAY) / 1000) });
    expect(r.puts[1]).toMatchObject({ pk: 'k1#finding', evidence: CLEAN, scrub_version: 1 });
  });

  it('a run-tagged finding is kept 13 months, as a run row (decision 11)', async () => {
    const r = await call(event([findingRow({ tag: 'run' })]), findingEnv);
    expect(r.puts[0]!.expires_at).toBe(Math.floor(Date.parse('2027-11-02T11:59:00Z') / 1000));
  });

  it('is refused from the importer and the backfill role, naming row_kind: writers only', async () => {
    const roles = [
      [{ role: 'kanon-telemetry-importer', key: 'k2' }, { IMPORTER_ROLE: 'kanon-telemetry-importer' }],
      [{ role: 'kanon-telemetry-backfill', key: 'k2' }, { BACKFILL_ROLE: 'kanon-telemetry-backfill' }],
    ] as const;
    for (const [opts, envOver] of roles) {
      const r = await call(event([findingRow()], opts), { ...findingEnv, ...envOver });
      expect(r.status).toBe(422);
      expect(errorsOf(r)).toEqual([{ field: 'row_kind', problem: 'not-allowed' }]);
      expect(r.puts).toEqual([]);
    }
  });

  it('a URL in the evidence gets 422 naming evidence (url), and the URL is never echoed or logged', async () => {
    const r = await call(event([withText('Observed: the lane read https://example.com/SECRET-CONTENT first.')]), findingEnv);
    expect(r.status).toBe(422);
    expect(errorsOf(r)).toContainEqual({ field: 'evidence', problem: 'url' });
    expect(JSON.stringify(r.body) + r.logs.join('\n')).not.toContain('SECRET-CONTENT');
  });

  it("checks the text against the SENDER's name hashes: a word of its own repository's name is refused, another's is not", async () => {
    const text = 'Observed: the widget lane stopped at stage `agent`.';
    const own = await call(event([withText(text)]), findingEnv);
    expect(own.status).toBe(422);
    expect(errorsOf(own)).toEqual([{ field: 'evidence', problem: 'name' }]);
    const other = await call(event([withText(text)], { role: 'kanon-telemetry-k2-writer' }), findingEnv);
    expect(other.status).toBe(200);
    // The same in the suggested fix.
    const fix = await call(event([{ ...withText(CLEAN), suggested_fix: 'Rename the Shop step.' }]), findingEnv);
    expect(errorsOf(fix)).toEqual([{ field: 'suggested_fix', problem: 'name' }]);
  });

  it("stores no finding for a key without name hashes, or with malformed ones: the sender's check can't run", async () => {
    for (const NAME_HASHES of ['', `k2=${hashes('zorblax/quintet')}`, 'k1=not-a-hash', 'k1=']) {
      const r = await call(event([findingRow()]), { NAME_HASHES });
      expect(r.status).toBe(422);
      expect(errorsOf(r)).toEqual([{ field: 'row_kind', problem: 'no-sender-context' }]);
    }
    expect(nameHashesOf({ ...env, ...findingEnv }, 'k1')?.size).toBe(4);
    expect(nameHashesOf({ ...env, ...findingEnv }, 'k3')).toBeNull();
  });

  it("refuses a registered key held in the text as a word, whoever's it is, naming the field and never the key", async () => {
    // `k2` has neither a key's hex shape nor a partition's, so only intake's key check finds it.
    const r = await call(event([withText('Observed: the row named k2 as its partition.')]), findingEnv);
    expect(r.status).toBe(422);
    expect(errorsOf(r)).toEqual([{ field: 'evidence', problem: 'key' }]);
    // Inside a longer run of key characters it is not the key.
    expect((await call(event([withText('Observed: the k2x step.')]), findingEnv)).status).toBe(200);
  });

  it('runs assertNoKey over every field: a vocabulary value that is a registered key is refused', async () => {
    const r = await call(event([findingRow({ kanon_version: 'dev' })]), { ...findingEnv, WRITER_KEYS: 'k1,k2,dev' });
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
    const res = await handle(event([runRow()]), { env, now: () => NOW, put: async () => { throw new Error('throttled'); }, log: () => {} });
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
    await expect(putItem({ pk: 'k1#review' }, env, fakeFetch)).rejects.toThrow('PutItem 400');
  });

  it('the partitions erasure walks are every lane, work and finding (plan 0006 §2.3)', () => {
    expect(PARTITIONS).toEqual([...LANES, 'work', 'finding']);
  });
});
