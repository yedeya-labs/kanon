import { describe, expect, it } from 'vitest';

import { DENIED_WRITES, OTHER_KEY, PROBE_PK, runChecks, testRow } from '../../infra/telemetry/verify.mjs';
import { erase, partitionsOf } from '../../infra/telemetry/erase.mjs';
import { handle, SHORT_RETENTION_MS } from '../../infra/telemetry/function/index.mjs';
import { validate, LANES } from '../../actions/agent-telemetry/schema.mjs';

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
      const kind = role.endsWith('-writer') ? 'writer' : role.endsWith('-verify-probe') ? 'probe' : 'reader';
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
      return ok(item ? { Item: { expires_at: item.expires_at } } : {});
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const post = async (_url: string, body: string, creds: Creds) => {
    const ev = {
      requestContext: { http: { method: 'POST' }, authorizer: { iam: { userArn: `arn:aws:sts::${ACCOUNT}:assumed-role/kanon-telemetry-kk-${creds.accessKeyId}/v` } } },
      body,
    };
    const res = await handle(ev, {
      env: { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT, WRITER_KEYS: 'kk' },
      now: () => NOW,
      put: async (item: Record<string, unknown>) => {
        const expires = over.brokenHandler ? (item.expires_at as number) + 86_400 : item.expires_at;
        table.set(`${item.pk}|${item.sk}`, { pk: { S: String(item.pk) }, expires_at: { N: String(expires) } });
      },
      log: () => {},
    });
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
  return { aws, post, table };
}

const PROBE_CHECK = "every write by a role allowed them is denied by the table's resource policy";
const WRITE_OPS: Record<string, string> = { 'put-item': 'PutItem', 'update-item': 'UpdateItem', 'delete-item': 'DeleteItem', 'batch-write-item': 'BatchWriteItem' };
const NOW = Date.parse('2026-10-02T12:00:00Z');
let n = 100;
const deps = (f: ReturnType<typeof fakeAws>) => ({ aws: f.aws, post: f.post, now: () => NOW, runId: () => n++ });

describe('verify.mjs runs S3\'s falsifiers', () => {
  it('its test row is a valid run row tagged test', () => {
    expect(validate(testRow(NOW, 1))).toEqual({ ok: true });
    expect(testRow(NOW, 1).tag).toBe('test');
  });

  it('passes all seven against a store that behaves', async () => {
    const results = await runChecks('kk', 'kanon', deps(fakeAws()));
    expect(results.map((r) => [r.name, r.pass])).toEqual([
      ['a valid row gets 200', true],
      ['a row with an extra field gets 422 naming that field', true],
      ['a row naming a partition gets 422', true],
      ['the reader querying another key gets AccessDeniedException', true],
      ['a direct PutItem with the writer role is denied', true],
      ["the stored row's expires_at is 30 days out", true],
      [PROBE_CHECK, true],
    ]);
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
    expect(r).toHaveLength(7);
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

  it('walks every lane\'s partition and the work partition', () => {
    expect(partitionsOf('kk')).toEqual([...LANES.map((l) => `kk#${l}`), 'kk#work']);
  });

  it('only counts without --apply', () => {
    const f = fake({ 'kk#review': 3, 'kk#work': 2 });
    const counts = erase('kk', { aws: f.aws, profile: 'kanon', apply: false });
    expect(counts.filter((c) => c.rows)).toEqual([{ partition: 'kk#review', rows: 3 }, { partition: 'kk#work', rows: 2 }]);
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
