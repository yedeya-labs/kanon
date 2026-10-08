import { describe, expect, it } from 'vitest';

import { DENIED_WRITES, OTHER_KEY, PROBE_PK, runChecks, testFinding, testRow } from '../../infra/telemetry/verify.mjs';
import { erase, partitionsOf } from '../../infra/telemetry/erase.mjs';
import { handle, SHORT_RETENTION_MS } from '../../infra/telemetry/function/index.mjs';
import { validate, LANES } from '../../actions/agent-telemetry/schema.mjs';
import { nameContext, verify } from '../../actions/agent-telemetry/scrub.mjs';

/**
 * Plan 0002 step S3: the Owner's verify script (its falsifiers) and the erase script (§10),
 * against a fake AWS. The fake store runs the real ingest handler and applies IAM's two
 * outcomes the template asserts: a reader is denied another key, a writer is denied PutItem.
 */

const ACCOUNT = '4'.repeat(12);
const SECRET = 'SECRET-ACCESS-KEY-VALUE';
type Run = { code: number, stdout: string, stderr: string };
type Creds = { accessKeyId: string, secretAccessKey: string, sessionToken: string };

/** A fake account: the stack, two assumable roles, the function, and a table. */
function fakeAws(over: {
  brokenHandler?: boolean, readerSeesAll?: boolean, writerMayPut?: boolean, noVerify?: boolean,
  // kanon#101: the writes the table's resource policy denies (all four when it is deployed as
  // written; `[]` is a table with no resource policy), and a stack without the probe role.
  tableDenies?: string[], noProbe?: boolean,
  // Plan 0006 F4: a stack deployed without --importer.
  noImporter?: boolean,
} = {}) {
  const tableDenies = over.tableDenies ?? DENIED_WRITES;
  const table = new Map<string, Record<string, { S?: string, N?: string }>>();
  const deniedRun = (op: string): Run => ({ code: 254, stdout: '', stderr: `An error occurred (AccessDeniedException) when calling the ${op} operation` });
  const ok = (v: unknown): Run => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
  const roleOf = (c?: Creds) => c?.accessKeyId;
  const arg = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const aws = (args: string[], creds?: Creds): Run => {
    const [svc, op] = args;
    if (svc === 'sts' && op === 'get-caller-identity') return ok({ Account: ACCOUNT });
    if (svc === 'cloudformation') return ok({ Stacks: [{ Outputs: [{ OutputKey: 'IngestUrl', OutputValue: 'https://u.example/' }, { OutputKey: 'TableName', OutputValue: 'kanon-telemetry' }] }] });
    if (svc === 'sts' && op === 'assume-role') {
      if (over.noVerify) return { code: 254, stdout: '', stderr: 'AccessDenied' };
      const role = arg(args, '--role-arn');
      if (role.endsWith('-verify-probe') && over.noProbe) return { code: 254, stdout: '', stderr: 'AccessDenied' };
      if (role.endsWith('-importer') && over.noImporter) return { code: 254, stdout: '', stderr: 'AccessDenied' };
      const kind = role.endsWith('-writer') ? 'writer' : role.endsWith('-verify-probe') ? 'probe' : role.endsWith('-importer') ? 'importer' : 'reader';
      return ok({ Credentials: { AccessKeyId: kind, SecretAccessKey: SECRET, SessionToken: 'tok' } });
    }
    if (op === 'query') {
      const pk = JSON.parse(arg(args, '--expression-attribute-values'))[':p'].S as string;
      if (roleOf(creds) === 'reader' && !pk.startsWith('kk#') && !over.readerSeesAll) return deniedRun('Query');
      return ok({ Items: [...table.values()].filter((i) => i.pk!.S === pk) });
    }
    // IAM's order for a write: the table's explicit deny first, then the caller's own grants.
    // The writer holds no DynamoDB action (unless `writerMayPut`); the probe holds all four.
    const write = WRITE_OPS[op ?? ''];
    if (write) {
      const message = (why: string) => ({ code: 254, stdout: '', stderr:
        `An error occurred (AccessDeniedException) when calling the ${write} operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/x/kanon-verify is not authorized to perform: dynamodb:${write} on resource: arn:aws:dynamodb:eu-central-1:${ACCOUNT}:table/kanon-telemetry ${why}` });
      if (tableDenies.includes(write)) return message('with an explicit deny in a resource-based policy');
      const allowed = roleOf(creds) === 'probe' || (roleOf(creds) === 'writer' && write === 'PutItem' && over.writerMayPut);
      return allowed ? ok({}) : message(`because no identity-based policy allows the dynamodb:${write} action`);
    }
    if (op === 'get-item') {
      const k = JSON.parse(arg(args, '--key'));
      const item = table.get(`${k.pk.S}|${k.sk.S}`);
      const attr = arg(args, '--projection-expression');
      return ok(item ? { Item: { [attr]: item[attr] } } : {});
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const post = async (url: string, body: string, creds: Creds) => {
    const role = creds.accessKeyId === 'importer' ? 'kanon-telemetry-importer' : `kanon-telemetry-kk-${creds.accessKeyId}`;
    const key = new URL(url).searchParams.get('key');
    const ev = {
      requestContext: { http: { method: 'POST' }, authorizer: { iam: { userArn: `arn:aws:sts::${ACCOUNT}:assumed-role/${role}/v` } } },
      ...(key !== null ? { queryStringParameters: { key } } : {}),
      body,
    };
    const res = await handle(ev, {
      env: { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT, WRITER_KEYS: 'kk', IMPORTER_ROLE: 'kanon-telemetry-importer', NAME_HASHES: `kk=${[...nameContext({ repository: 'acme-corp/widget-shop' })].join(':')}` },
      now: () => NOW,
      put: async (item: Record<string, unknown>) => {
        const expires = over.brokenHandler ? (item.expires_at as number) + 86_400 : item.expires_at;
        table.set(`${item.pk}|${item.sk}`, { pk: { S: String(item.pk) }, sk: { S: String(item.sk) }, row_kind: { S: String(item.row_kind) }, expires_at: { N: String(expires) } });
      },
      log: () => {},
    });
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
  return { aws, post, table };
}

const PROBE_CHECK = "every write by a role allowed them is denied by the table's resource policy";
/** Plan 0006 F4's checks, 8 to 13, in order. */
const FINDING_CHECKS = [
  'a valid finding gets 200 and lands in <key>#finding',
  'a finding with a URL in its evidence gets 422 naming evidence (url)',
  'a finding holding a registered key gets 422',
  'the importer sending a finding gets 422',
  "the aggregate's answer is unchanged by a stored finding",
  "erase.mjs's walk of the key reaches the stored finding in <key>#finding",
] as const;
const WRITE_OPS: Record<string, string> = { 'put-item': 'PutItem', 'update-item': 'UpdateItem', 'delete-item': 'DeleteItem', 'batch-write-item': 'BatchWriteItem' };
const NOW = Date.parse('2026-10-02T12:00:00Z');
let n = 100;
const deps = (f: ReturnType<typeof fakeAws>) => ({ aws: f.aws, post: f.post, now: () => NOW, runId: () => n++ });

describe('verify.mjs runs S3\'s falsifiers', () => {
  it('its test row is a valid run row tagged test', () => {
    expect(validate(testRow(NOW, 1))).toEqual({ ok: true });
    expect(testRow(NOW, 1).tag).toBe('test');
  });

  it('its test finding is a valid finding row tagged test, at evidence, whose text passes the scrub', () => {
    const f = testFinding(NOW, 1);
    expect(validate(f)).toEqual({ ok: true });
    expect(f).toMatchObject({ tag: 'test', evidence_level: 'evidence' });
    expect(verify(String(f.evidence))).toEqual([]);
  });

  it('passes all thirteen against a store that behaves', async () => {
    const results = await runChecks('kk', 'kanon', deps(fakeAws()));
    expect(results.map((r) => [r.name, r.pass])).toEqual([
      ['a valid row gets 200', true],
      ['a row with an extra field gets 422 naming that field', true],
      ['a row naming a partition gets 422', true],
      ['the reader querying another key gets AccessDeniedException', true],
      ['a direct PutItem with the writer role is denied', true],
      ["the stored row's expires_at is 30 days out", true],
      [PROBE_CHECK, true],
      ...FINDING_CHECKS.map((name) => [name, true]),
    ]);
  });

  // Plan 0006 F4's checks, each against a store that gets one thing wrong.
  it('fails the finding checks against an ingest function that refuses every finding, as F1 left it', async () => {
    const f = fakeAws();
    const refusing = async (url: string, body: string, creds: Creds) => {
      const rows = JSON.parse(body) as Array<{ row_kind: string }>;
      if (rows[0]!.row_kind === 'finding') return { status: 422, json: { results: [{ status: 'rejected', errors: [{ field: 'row_kind', problem: 'not-allowed' }] }] } };
      return f.post(url, body, creds);
    };
    const r = await runChecks('kk', 'kanon', { ...deps(f), post: refusing });
    expect(r.filter((x) => !x.pass).map((x) => x.name)).toEqual([
      FINDING_CHECKS[0], FINDING_CHECKS[1], FINDING_CHECKS[2], FINDING_CHECKS[5],
    ]);
  });

  it('fails the importer check when the stack has no importer, saying so', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ noImporter: true })));
    expect(r.filter((x) => !x.pass)).toEqual([{ name: FINDING_CHECKS[3], pass: false,
      why: 'assume-role failed for kanon-telemetry-importer: is the stack deployed with --importer?' }]);
  });

  it('fails the aggregate check when a stored finding changes the figures', async () => {
    const f = fakeAws();
    // An aggregate that read the finding partition would count the finding as a run of its lane.
    const leaky = (args: string[], creds?: Creds) => {
      if (args[1] === 'query' && args.includes('--filter-expression')) {
        const p = JSON.parse(args[args.indexOf('--expression-attribute-values') + 1]!)[':p'].S as string;
        if (p === 'kk#review') {
          const found = [...f.table.values()].filter((i) => i.row_kind?.S === 'finding');
          return { code: 0, stdout: JSON.stringify({ Items: found.map(() => ({ pk: { S: 'kk#review' }, row_kind: { S: 'run' }, tag: { S: 'run' }, recorded_at: { S: new Date(NOW).toISOString() }, lane: { S: 'review' }, outcome: { S: 'failed' }, reason: { S: 'did_not_finish' }, failed_stage: { S: 'agent' }, kanon_version: { S: 'dev' } })) }), stderr: '' };
        }
      }
      return f.aws(args, creds);
    };
    const r = await runChecks('kk', 'kanon', { ...deps(f), aws: leaky });
    expect(r.filter((x) => !x.pass)).toEqual([{ name: FINDING_CHECKS[4], pass: false, why: 'it changed' }]);
  });

  // kanon#101: check 5 passes on the writer's identity policy alone, so a table with no
  // resource policy used to pass every check.
  it('fails exactly the probe check when the table has no resource policy', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ tableDenies: [] })));
    expect(r.filter((x) => !x.pass)).toEqual([{ name: PROBE_CHECK, pass: false,
      why: 'PutItem: no error; UpdateItem: no error; DeleteItem: no error; BatchWriteItem: no error' }]);
  });

  it('fails it, naming the write, when the deny leaves one write out', async () => {
    for (const missing of DENIED_WRITES) {
      const r = await runChecks('kk', 'kanon', deps(fakeAws({ tableDenies: DENIED_WRITES.filter((w) => w !== missing) })));
      expect(r.filter((x) => !x.pass), missing).toEqual([{ name: PROBE_CHECK, pass: false, why: `${missing}: no error` }]);
    }
  });

  it('does not count a denial that is not the table\'s: the probe must be refused by the resource policy', async () => {
    const f = fakeAws();
    const identityOnly = (args: string[], creds?: Creds) => creds?.accessKeyId === 'probe' && args[0] === 'dynamodb'
      ? { code: 254, stdout: '', stderr: 'An error occurred (AccessDeniedException) when calling the PutItem operation: User: x is not authorized to perform: dynamodb:PutItem on resource: y because no identity-based policy allows the dynamodb:PutItem action' }
      : f.aws(args, creds);
    const r = await runChecks('kk', 'kanon', { ...deps(f), aws: identityOnly });
    expect(r.filter((x) => !x.pass)).toEqual([{ name: PROBE_CHECK, pass: false,
      why: DENIED_WRITES.map((w) => `${w}: denied, but not by a resource-based policy`).join('; ') }]);
  });

  it('aims every probe write at a partition no register holds, expiring within the hour', async () => {
    const f = fakeAws({ tableDenies: [] });
    const seen: string[][] = [];
    await runChecks('kk', 'kanon', { ...deps(f), aws: (args: string[], creds?: Creds) => {
      if (creds?.accessKeyId === 'probe') seen.push(args);
      return f.aws(args, creds);
    } });
    expect(seen.map((a) => a[1])).toEqual(['put-item', 'update-item', 'delete-item', 'batch-write-item']);
    for (const a of seen) {
      const text = a.join(' ');
      expect(text).toContain(PROBE_PK);
      expect(text).not.toContain('kk#');
      expect(a).toContain('--region');
    }
    const expiry = Number(JSON.parse(seen[0]![seen[0]!.indexOf('--item') + 1]!).expires_at.N);
    expect(expiry - NOW / 1000).toBe(3600);
  });

  it('fails the probe check alone when the stack has no probe role', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ noProbe: true })));
    expect(r.filter((x) => !x.pass).map((x) => [x.name, x.why])).toEqual([[PROBE_CHECK,
      'assume-role failed for kanon-telemetry-verify-probe: is the stack deployed with --verify?']]);
    expect(r).toHaveLength(13);
  });

  it('fails the reader check when the reader can read another key', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ readerSeesAll: true })));
    expect(r.filter((x) => !x.pass).map((x) => x.name)).toEqual(['the reader querying another key gets AccessDeniedException']);
  });

  it('fails the PutItem check when the writer can write the table', async () => {
    // Only with no deny on the table as well: the writer is not one of its exceptions.
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ writerMayPut: true, tableDenies: [] })));
    expect(r.filter((x) => !x.pass).map((x) => x.name)).toEqual(['a direct PutItem with the writer role is denied', PROBE_CHECK]);
  });

  it('fails the expiry check when the stored expiry is off', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ brokenHandler: true })));
    expect(r.filter((x) => !x.pass)).toEqual([{ name: "the stored row's expires_at is 30 days out", pass: false, why: 'off by 86400 s' }]);
  });

  it('fails the store checks when the store accepts anything', async () => {
    const f = fakeAws();
    const lax = async () => ({ status: 200, json: { results: [{ status: 'stored' }] } });
    const r = await runChecks('kk', 'kanon', { ...deps(f), post: lax });
    expect(r.filter((x) => !x.pass).map((x) => x.name)).toEqual([
      'a row with an extra field gets 422 naming that field',
      'a row naming a partition gets 422',
      "the stored row's expires_at is 30 days out",
      FINDING_CHECKS[0], FINDING_CHECKS[1], FINDING_CHECKS[2], FINDING_CHECKS[3], FINDING_CHECKS[5],
    ]);
  });

  it('fails each store check on the wrong answer, not just on any answer', async () => {
    const f = fakeAws();
    const wrongField = async () => ({ status: 422, json: { results: [{ status: 'rejected', errors: [{ field: 'recorded_at', problem: 'window' }] }] } });
    const r = await runChecks('kk', 'kanon', { ...deps(f), post: wrongField });
    expect(r.filter((x) => !x.pass).map((x) => x.name)).toEqual([
      'a valid row gets 200',
      'a row with an extra field gets 422 naming that field',
      'a row naming a partition gets 422',
      "the stored row's expires_at is 30 days out",
      FINDING_CHECKS[0], FINDING_CHECKS[1], FINDING_CHECKS[2], FINDING_CHECKS[3], FINDING_CHECKS[5],
    ]);
    const accepted = async () => ({ status: 202, json: { results: [{ status: 'stored' }] } });
    const r2 = await runChecks('kk', 'kanon', { ...deps(f), post: accepted });
    expect(r2[0]).toEqual({ name: 'a valid row gets 200', pass: false, why: 'status 202' });
  });

  it('counts only AccessDeniedException as denied, not any error', async () => {
    const f = fakeAws();
    const missing = (args: string[], creds?: Creds) => ['query', 'put-item'].includes(args[1]!)
      ? { code: 254, stdout: '', stderr: 'An error occurred (ResourceNotFoundException) when calling the Query operation' }
      : f.aws(args, creds);
    const r = await runChecks('kk', 'kanon', { ...deps(f), aws: missing });
    expect(r.filter((x) => !x.pass)).toEqual([
      { name: 'the reader querying another key gets AccessDeniedException', pass: false, why: 'ResourceNotFoundException' },
      { name: 'a direct PutItem with the writer role is denied', pass: false, why: 'ResourceNotFoundException' },
      { name: PROBE_CHECK, pass: false, why: 'PutItem: ResourceNotFoundException' },
      { name: FINDING_CHECKS[4], pass: false, why: 'the aggregate could not be computed' },
      { name: FINDING_CHECKS[5], pass: false, why: 'a query failed' },
    ]);
  });

  it('stops with one FAIL when the roles can\'t be assumed, and never reports a credential', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ noVerify: true })));
    expect(r).toHaveLength(1);
    expect(r[0]!.pass).toBe(false);
    const all = JSON.stringify(await runChecks('kk', 'kanon', deps(fakeAws({ readerSeesAll: true, writerMayPut: true, brokenHandler: true }))));
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('tok');
  });

  it('asks about a key no register holds', () => {
    expect(OTHER_KEY).not.toBe('kk');
    expect(SHORT_RETENTION_MS).toBe(30 * 86_400_000);
  });
});

describe('erase.mjs deletes every partition of a key (§10)', () => {
  const fake = (rows: Record<string, number>) => {
    const calls: string[][] = [];
    let unprocessedOnce = true;
    const aws = (args: string[]) => {
      calls.push(args);
      if (args[1] === 'query') {
        const pk = JSON.parse(args[args.indexOf('--expression-attribute-values') + 1]!)[':p'].S as string;
        const items = Array.from({ length: rows[pk] ?? 0 }, (_, i) => ({ pk: { S: pk }, sk: { S: String(i) } }));
        return { code: 0, stdout: JSON.stringify({ Items: items }) };
      }
      const req = JSON.parse(args[args.indexOf('--request-items') + 1]!);
      const leftover = unprocessedOnce ? { 'kanon-telemetry': req['kanon-telemetry'].slice(0, 1) } : {};
      unprocessedOnce = false;
      return { code: 0, stdout: JSON.stringify({ UnprocessedItems: leftover }) };
    };
    return { aws, calls };
  };

  it('walks every lane\'s partition, the work partition and the finding partition (plan 0006 §2.3)', () => {
    expect(partitionsOf('kk')).toEqual([...LANES.map((l) => `kk#${l}`), 'kk#work', 'kk#finding']);
  });

  it('erasing a key with a stored finding leaves <key>#finding empty (plan 0006 F4)', async () => {
    // The finding is stored by the real ingest function, through verify's fake account.
    const f = fakeAws();
    await runChecks('kk', 'kanon', deps(f));
    const inFindings = () => [...f.table.values()].filter((i) => i.pk!.S === 'kk#finding').length;
    expect(inFindings()).toBe(1);
    const owner = (args: string[]) => {
      if (args[1] === 'batch-write-item') {
        const req = JSON.parse(args[args.indexOf('--request-items') + 1]!) as Record<string, Array<{ DeleteRequest: { Key: { pk: { S: string }, sk: { S: string } } } }>>;
        for (const d of req['kanon-telemetry'] ?? []) f.table.delete(`${d.DeleteRequest.Key.pk.S}|${d.DeleteRequest.Key.sk.S}`);
        return { code: 0, stdout: JSON.stringify({ UnprocessedItems: {} }) };
      }
      return f.aws(args);
    };
    const counts = erase('kk', { aws: owner, profile: 'kanon', apply: true });
    expect(counts.find((c) => c.partition === 'kk#finding')).toEqual({ partition: 'kk#finding', rows: 1 });
    expect(inFindings()).toBe(0);
    expect([...f.table.keys()].filter((k) => k.startsWith('kk#'))).toEqual([]);
  });

  it('only counts without --apply', () => {
    const f = fake({ 'kk#review': 3, 'kk#work': 2, 'kk#finding': 4 });
    const counts = erase('kk', { aws: f.aws, profile: 'kanon', apply: false });
    expect(counts.filter((c) => c.rows)).toEqual([
      { partition: 'kk#review', rows: 3 }, { partition: 'kk#work', rows: 2 }, { partition: 'kk#finding', rows: 4 },
    ]);
    expect(f.calls.filter((c) => c[1] === 'batch-write-item')).toEqual([]);
  });

  it('deletes in batches of 25, retrying what DynamoDB left unprocessed', () => {
    const f = fake({ 'kk#review': 30 });
    erase('kk', { aws: f.aws, profile: 'kanon', apply: true });
    const sizes = f.calls.filter((c) => c[1] === 'batch-write-item')
      .map((c) => JSON.parse(c[c.indexOf('--request-items') + 1]!)['kanon-telemetry'].length);
    expect(sizes).toEqual([25, 1, 5]);
    expect(f.calls.every((c) => c.includes('--profile') && c[c.indexOf('--region') + 1] === 'eu-central-1')).toBe(true);
  });
});
