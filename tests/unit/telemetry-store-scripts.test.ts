import { describe, expect, it } from 'vitest';

import { OTHER_KEY, runChecks, testRow } from '../../infra/telemetry/verify.mjs';
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
function fakeAws(over: { brokenHandler?: boolean, readerSeesAll?: boolean, writerMayPut?: boolean, noVerify?: boolean } = {}) {
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
      const kind = arg(args, '--role-arn').endsWith('-writer') ? 'writer' : 'reader';
      return ok({ Credentials: { AccessKeyId: kind, SecretAccessKey: SECRET, SessionToken: 'tok' } });
    }
    if (op === 'query') {
      const pk = JSON.parse(arg(args, '--expression-attribute-values'))[':p'].S as string;
      if (roleOf(creds) === 'reader' && !pk.startsWith('kk#') && !over.readerSeesAll) return deniedRun('Query');
      return ok({ Items: [...table.values()].filter((i) => i.pk!.S === pk) });
    }
    if (op === 'put-item') return over.writerMayPut ? ok({}) : deniedRun('PutItem');
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

const NOW = Date.parse('2026-10-02T12:00:00Z');
let n = 100;
const deps = (f: ReturnType<typeof fakeAws>) => ({ aws: f.aws, post: f.post, now: () => NOW, runId: () => n++ });

describe('verify.mjs runs S3\'s falsifiers', () => {
  it('its test row is a valid run row tagged test', () => {
    expect(validate(testRow(NOW, 1))).toEqual({ ok: true });
    expect(testRow(NOW, 1).tag).toBe('test');
  });

  it('passes all six against a store that behaves', async () => {
    const results = await runChecks('kk', 'kanon', deps(fakeAws()));
    expect(results.map((r) => [r.name, r.pass])).toEqual([
      ['a valid row gets 200', true],
      ['a row with an extra field gets 422 naming that field', true],
      ['a row naming a partition gets 422', true],
      ['the reader querying another key gets AccessDeniedException', true],
      ['a direct PutItem with the writer role is denied', true],
      ["the stored row's expires_at is 30 days out", true],
    ]);
  });

  it('fails the reader check when the reader can read another key', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ readerSeesAll: true })));
    expect(r.filter((x) => !x.pass).map((x) => x.name)).toEqual(['the reader querying another key gets AccessDeniedException']);
  });

  it('fails the PutItem check when the writer can write the table', async () => {
    const r = await runChecks('kk', 'kanon', deps(fakeAws({ writerMayPut: true })));
    expect(r.filter((x) => !x.pass).map((x) => x.name)).toEqual(['a direct PutItem with the writer role is denied']);
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
