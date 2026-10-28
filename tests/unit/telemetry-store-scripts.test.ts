import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DENIED_WRITES, FUNCTIONS, INGEST_FUNCTION, PROBE_PK, runChecks, testFinding, testRow } from '../../infra/telemetry/verify.mjs';
import { erase, partitionsOf } from '../../infra/telemetry/erase.mjs';
import { handle, SHORT_RETENTION_MS, stamp } from '../../infra/telemetry/function/index.mjs';
import { validate, LANES } from '../../actions/agent-telemetry/schema.mjs';
import { verify } from '../../actions/agent-telemetry/scrub.mjs';
import { keysCache } from '../../infra/telemetry/function/register-store.mjs';
import { fakeDynamo, REGISTER } from './helpers/fake-dynamo.js';

/**
 * Plan 0002 step S3, as plan 0008 J9 leaves it (§13): the Owner's verify script (its falsifiers)
 * and the erase script (§10), against a fake AWS. The fake account runs the real ingest handler
 * on the alias the CLI names, and applies IAM's outcomes the template asserts: the importer role
 * may invoke its own alias and nothing else, and the probe role is allowed the four writes the
 * table's resource policy denies.
 */

const ACCOUNT = '4'.repeat(12);
const SECRET = 'SECRET-ACCESS-KEY-VALUE';
type Run = { code: number, stdout: string, stderr: string };
type Creds = { accessKeyId: string, secretAccessKey: string, sessionToken: string };
/** What the fake function answers: the handler's own answer, or what a test puts in its place. */
type Answer = { statusCode: number, body: string };

/** A fake account: the stack, two assumable roles, the function's aliases and URLs, and a table. */
function fakeAws(over: {
  brokenHandler?: boolean,
  // kanon#101: the writes the table's resource policy denies (all four when it is deployed as
  // written; `[]` is a table with no resource policy), and a stack without the probe role.
  tableDenies?: string[], noProbe?: boolean,
  // A stack deployed without EnableImporter.
  noImporter?: boolean,
  // Plan 0008 J9: a stack that still has an IAM URL, as an output or a function URL.
  iamOutput?: boolean, iamUrlOn?: string,
  // An importer role granted more than its own alias.
  importerMayBackfill?: boolean,
  // A function that answers its unqualified invocation.
  unqualifiedAnswers?: boolean,
  // In place of the handler's answer on the `import` alias.
  answer?: (event: { key: string, rows: unknown[] }) => Answer,
} = {}) {
  const tableDenies = over.tableDenies ?? DENIED_WRITES;
  const table = new Map<string, Record<string, { S?: string, N?: string }>>();
  const ok = (v: unknown): Run => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
  const roleOf = (c?: Creds) => c?.accessKeyId;
  const arg = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const fnArn = (fn: string, q?: string) => `arn:aws:lambda:eu-central-1:${ACCOUNT}:function:${fn}${q ? `:${q}` : ''}`;
  const run = async (event: unknown, qualifier: string | undefined): Promise<Answer> => {
    // The register, as plan 0008 J3 has it: `kk`, active.
    const register = fakeDynamo();
    register.seed(REGISTER, { pk: 'repo#1', repository_id: '1', key: 'kk', status: 'active' });
    register.seed(REGISTER, { pk: 'key#kk', repository_id: '1' });
    return handle(event, {
      env: { TABLE_NAME: 'kanon-telemetry', ACCOUNT_ID: ACCOUNT },
      db: register.db,
      keys: keysCache(),
      now: () => NOW,
      invokedFunctionArn: fnArn(INGEST_FUNCTION, qualifier),
      put: async (item: Record<string, unknown>) => {
        const expires = over.brokenHandler ? (item.expires_at as number) + 86_400 : item.expires_at;
        table.set(`${item.pk}|${item.sk}`, { pk: { S: String(item.pk) }, sk: { S: String(item.sk) }, row_kind: { S: String(item.row_kind) }, expires_at: { N: String(expires) } });
      },
      log: () => {},
    });
  };
  const aws = (args: string[], creds?: Creds): Run => {
    const [svc, op] = args;
    if (svc === 'sts' && op === 'get-caller-identity') return ok({ Account: ACCOUNT });
    if (svc === 'cloudformation') {
      const outputs = { TableName: 'kanon-telemetry', RegisterTableName: 'kanon-telemetry-register', IngestTokenUrl: 'https://i.example/', AggregateTokenUrl: 'https://a.example/', ...(over.iamOutput ? { IngestUrl: 'https://u.example/' } : {}) };
      return ok({ Stacks: [{ Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] });
    }
    if (svc === 'sts' && op === 'assume-role') {
      const role = arg(args, '--role-arn')!;
      if (role.endsWith('-verify-probe') && over.noProbe) return { code: 254, stdout: '', stderr: 'AccessDenied' };
      if (role.endsWith('-importer') && over.noImporter) return { code: 254, stdout: '', stderr: 'AccessDenied' };
      const kind = role.endsWith('-verify-probe') ? 'probe' : role.endsWith('-importer') ? 'importer' : 'other';
      return ok({ Credentials: { AccessKeyId: kind, SecretAccessKey: SECRET, SessionToken: 'tok' } });
    }
    if (svc === 'lambda' && op === 'list-function-url-configs') {
      const fn = arg(args, '--function-name')!;
      const configs = [{ FunctionArn: fnArn(fn, 'live'), AuthType: 'NONE' }, ...(over.iamUrlOn === fn ? [{ FunctionArn: fnArn(fn), AuthType: 'AWS_IAM' }] : [])];
      return ok({ FunctionUrlConfigs: configs });
    }
    if (svc === 'lambda' && op === 'invoke') {
      const qualifier = arg(args, '--qualifier');
      // IAM: the importer role may invoke the `import` alias alone; the Owner's own principal anything.
      if (roleOf(creds) === 'importer' && qualifier !== 'import' && !(qualifier === 'backfill' && over.importerMayBackfill)) {
        return { code: 254, stdout: '', stderr: `\nAn error occurred (AccessDeniedException) when calling the Invoke operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/kanon-telemetry-importer/kanon-verify is not authorized to perform: lambda:InvokeFunction\n` };
      }
      const event = JSON.parse(readFileSync(arg(args, '--payload')!.replace(/^fileb:\/\//, ''), 'utf8'));
      const out = args.at(-1)!;
      if (over.answer && qualifier === 'import') writeFileSync(out, JSON.stringify(over.answer(event)));
      else if (over.unqualifiedAnswers && qualifier === undefined) writeFileSync(out, JSON.stringify({ statusCode: 200, body: '{"results":[]}' }));
      else {
        // The handler is async, so this one call answers a promise, which `invokeIngest` awaits.
        return run(event, qualifier).then((a) => { writeFileSync(out, JSON.stringify(a)); return ok({ StatusCode: 200 }); }) as unknown as Run;
      }
      return ok({ StatusCode: 200 });
    }
    // IAM's order for a write: the table's explicit deny first, then the caller's own grants.
    const write = WRITE_OPS[op ?? ''];
    if (write) {
      const message = (why: string) => ({ code: 254, stdout: '', stderr:
        `An error occurred (AccessDeniedException) when calling the ${write} operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/x/kanon-verify is not authorized to perform: dynamodb:${write} on resource: arn:aws:dynamodb:eu-central-1:${ACCOUNT}:table/kanon-telemetry ${why}` });
      if (tableDenies.includes(write)) return message('with an explicit deny in a resource-based policy');
      return roleOf(creds) === 'probe' ? ok({}) : message(`because no identity-based policy allows the dynamodb:${write} action`);
    }
    if (op === 'get-item') {
      const k = JSON.parse(arg(args, '--key')!);
      const item = table.get(`${k.pk.S}|${k.sk.S}`);
      const attr = arg(args, '--projection-expression')!;
      return ok(item ? { Item: { [attr]: item[attr] } } : {});
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { aws, table };
}

const PROBE_CHECK = "every write by a role allowed them is denied by the table's resource policy";
const CHECKS = [
  "both functions' IAM URLs are gone",
  'a valid row sent through the import alias gets 200',
  'a row with an extra field gets 422 naming that field',
  'a row naming a partition gets 422',
  "the stored row's expires_at is 30 days out",
  PROBE_CHECK,
  'the importer sending a finding gets 422',
  'a direct invocation of the unqualified ingest function is refused by the function',
  'the importer role invoking the backfill alias is denied by IAM',
] as const;
const ROW_CHECKS = CHECKS.slice(1, 5);
const WRITE_OPS: Record<string, string> = { 'put-item': 'PutItem', 'update-item': 'UpdateItem', 'delete-item': 'DeleteItem', 'batch-write-item': 'BatchWriteItem' };
const NOW = Date.parse('2026-10-02T12:00:00Z');
let n = 100;
const deps = (f: ReturnType<typeof fakeAws>) => ({ aws: f.aws, now: () => NOW, runId: () => n++ });
const failed = (r: Array<{ name: string, pass: boolean, why?: string }>) => r.filter((x) => !x.pass);

describe("verify.mjs runs S3's falsifiers, as plan 0008 J9 leaves them (§13)", () => {
  it('its test row is a valid run row tagged test, as the importer may send it: no kanon_version', () => {
    expect(validate(testRow(NOW, 1), { imported: true })).toEqual({ ok: true });
    expect(testRow(NOW, 1).tag).toBe('test');
    expect(testRow(NOW, 1)).not.toHaveProperty('kanon_version');
  });

  it('its test finding is a valid finding row tagged test, at evidence, whose text passes the scrub', () => {
    const f = testFinding(NOW, 1);
    expect(validate(f)).toEqual({ ok: true });
    expect(f).toMatchObject({ tag: 'test', evidence_level: 'evidence' });
    expect(verify(String(f.evidence))).toEqual([]);
  });

  it('passes all nine against a store that behaves', async () => {
    const results = await runChecks('kk', 'kanon', deps(fakeAws()));
    expect(results.map((r) => [r.name, r.pass])).toEqual(CHECKS.map((name) => [name, true]));
  });

  it('reports either IAM URL still there, as an output or as a function URL, naming the function', async () => {
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ iamOutput: true }))))).toEqual([{ name: CHECKS[0], pass: false, why: 'output IngestUrl' }]);
    for (const fn of FUNCTIONS) {
      expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ iamUrlOn: fn }))))).toEqual([{ name: CHECKS[0], pass: false, why: `${fn}: a AWS_IAM URL on the unqualified function` }]);
    }
  });

  it('fails the backfill check when the importer role may invoke another alias', async () => {
    // The backfill alias answers its own refusal of a run row; what matters is that IAM let it through.
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ importerMayBackfill: true }))))).toEqual([{ name: CHECKS[8], pass: false, why: 'status 422' }]);
  });

  it('fails the unqualified check when the unqualified function answers', async () => {
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ unqualifiedAnswers: true }))))).toEqual([{ name: CHECKS[7], pass: false, why: 'status 200' }]);
  });

  it('fails every check that needs the importer when the stack has none, saying so', async () => {
    const r = failed(await runChecks('kk', 'kanon', deps(fakeAws({ noImporter: true }))));
    const why = 'assume-role failed for kanon-telemetry-importer: is the stack deployed with EnableImporter=true?';
    expect(r.map((x) => x.name)).toEqual([...ROW_CHECKS.slice(0, 3), CHECKS[4], CHECKS[6], CHECKS[8]]);
    for (const x of r.filter((y) => y.name !== CHECKS[4])) expect(x.why, x.name).toBe(why);
  });

  // kanon#101: a table with no resource policy used to pass every check.
  it('fails exactly the probe check when the table has no resource policy', async () => {
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ tableDenies: [] }))))).toEqual([{ name: PROBE_CHECK, pass: false,
      why: 'PutItem: no error; UpdateItem: no error; DeleteItem: no error; BatchWriteItem: no error' }]);
  });

  it('fails it, naming the write, when the deny leaves one write out', async () => {
    for (const missing of DENIED_WRITES) {
      const r = await runChecks('kk', 'kanon', deps(fakeAws({ tableDenies: DENIED_WRITES.filter((w) => w !== missing) })));
      expect(failed(r), missing).toEqual([{ name: PROBE_CHECK, pass: false, why: `${missing}: no error` }]);
    }
  });

  it("does not count a denial that is not the table's: the probe must be refused by the resource policy", async () => {
    const f = fakeAws();
    const identityOnly = (args: string[], creds?: Creds) => creds?.accessKeyId === 'probe' && args[0] === 'dynamodb'
      ? { code: 254, stdout: '', stderr: 'An error occurred (AccessDeniedException) when calling the PutItem operation: User: x is not authorized to perform: dynamodb:PutItem on resource: y because no identity-based policy allows the dynamodb:PutItem action' }
      : f.aws(args, creds);
    const r = await runChecks('kk', 'kanon', { ...deps(f), aws: identityOnly });
    expect(failed(r)).toEqual([{ name: PROBE_CHECK, pass: false, why: DENIED_WRITES.map((w) => `${w}: denied, but not by a resource-based policy`).join('; ') }]);
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
    expect(failed(r).map((x) => [x.name, x.why])).toEqual([[PROBE_CHECK, 'assume-role failed for kanon-telemetry-verify-probe: is the stack deployed with EnableVerify=true?']]);
    expect(r).toHaveLength(CHECKS.length);
  });

  it('fails the expiry check when the stored expiry is off', async () => {
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ brokenHandler: true }))))).toEqual([{ name: CHECKS[4], pass: false, why: 'off by 86400 s' }]);
  });

  it('fails the row checks when the function accepts anything', async () => {
    const lax = () => ({ statusCode: 200, body: JSON.stringify({ results: [{ status: 'stored' }] }) });
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ answer: lax })))).map((x) => x.name)).toEqual([
      CHECKS[2], CHECKS[3], CHECKS[4], CHECKS[6],
    ]);
  });

  it('fails each row check on the wrong answer, not just on any answer', async () => {
    const wrongField = () => ({ statusCode: 422, body: JSON.stringify({ results: [{ status: 'rejected', errors: [{ field: 'recorded_at', problem: 'window' }] }] }) });
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ answer: wrongField })))).map((x) => x.name)).toEqual([
      CHECKS[1], CHECKS[2], CHECKS[3], CHECKS[4], CHECKS[6],
    ]);
    const accepted = () => ({ statusCode: 202, body: JSON.stringify({ results: [{ status: 'stored' }] }) });
    expect(failed(await runChecks('kk', 'kanon', deps(fakeAws({ answer: accepted }))))[0]).toEqual({ name: CHECKS[1], pass: false, why: 'status 202' });
  });

  it('counts only AccessDeniedException as denied, not any error', async () => {
    const f = fakeAws();
    const missing = (args: string[], creds?: Creds) => (args[1] === 'invoke' && args.includes('backfill')) || args[1] === 'put-item'
      ? { code: 254, stdout: '', stderr: 'An error occurred (ResourceNotFoundException) when calling the operation' }
      : f.aws(args, creds);
    expect(failed(await runChecks('kk', 'kanon', { ...deps(f), aws: missing }))).toEqual([
      { name: PROBE_CHECK, pass: false, why: 'PutItem: ResourceNotFoundException' },
      { name: CHECKS[8], pass: false, why: 'ResourceNotFoundException' },
    ]);
  });

  it('stops with one FAIL when the stack cannot be read, and never reports a credential or the key', async () => {
    const f = fakeAws();
    const r = await runChecks('kk', 'kanon', { ...deps(f), aws: (args: string[], creds?: Creds) => (args[0] === 'cloudformation' ? { code: 254, stdout: '', stderr: 'x' } : f.aws(args, creds)) });
    expect(r).toHaveLength(1);
    expect(r[0]!.pass).toBe(false);
    const all = JSON.stringify(await runChecks('kk', 'kanon', deps(fakeAws({ brokenHandler: true, iamUrlOn: INGEST_FUNCTION, importerMayBackfill: true }))));
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('tok');
    expect(all).not.toMatch(/\bkk\b/);
  });

  it('sends the key in the payload file only: no command line names it', async () => {
    const f = fakeAws();
    const lines: string[][] = [];
    await runChecks('kk', 'kanon', { ...deps(f), aws: (args: string[], creds?: Creds) => { lines.push(args); return f.aws(args, creds); } });
    const invokes = lines.filter((a) => a[1] === 'invoke');
    expect(invokes.length).toBe(6);
    for (const a of invokes) expect(a.join(' ')).not.toMatch(/\bkk\b/);
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

  it('walks every lane\'s partition, the work, finding, deploy and smoke-check partitions (plan 0006 §2.3, plan 0010 D9, plan 0013 S3)', () => {
    expect(partitionsOf('kk')).toEqual([...LANES.map((l) => `kk#${l}`), 'kk#work', 'kk#finding', 'kk#deploy', 'kk#smoke_check']);
  });

  const row = {
    deploy: {
      schema_version: 1, row_kind: 'deploy', tag: 'run', recorded_at: '2026-10-02T11:59:00Z', run_id: 33679229731, run_attempt: 1,
      kanon_version: '0.50.0', role: 'production', position: 1, outcome: 'ok',
    },
    smoke_check: {
      schema_version: 1, row_kind: 'smoke_check', tag: 'run', recorded_at: '2026-10-02T11:59:00Z', run_id: 33679229731, run_attempt: 1,
      trigger: 'schedule', kanon_version: '0.50.0', role: 'production', position: 2, outcome: 'failed', failed_stage: 'smoke', reset_ran: true,
    },
  };

  it.each([
    { kind: 'deploy', plan: 'plan 0010 D9' },
    { kind: 'smoke_check', plan: 'plan 0013 S3' },
  ] as const)('erasing a key with a stored $kind row leaves <key>#$kind empty ($plan)', ({ kind }) => {
    // The item is the one the ingest function stamps, keyed by its own keysOf.
    const s = stamp(row[kind], { caller: { kind: 'writer', key: 'kk' }, key: 'kk', now: Date.parse('2026-10-02T12:00:00Z') });
    if (!s.ok) throw new Error(`the ${kind} row did not validate`);
    const table = new Map<string, { pk: string, sk: string }>([[`${s.item.pk}|${s.item.sk}`, { pk: s.item.pk, sk: s.item.sk }]]);
    const aws = (args: string[]) => {
      if (args[1] === 'query') {
        const pk = JSON.parse(args[args.indexOf('--expression-attribute-values') + 1]!)[':p'].S as string;
        const items = [...table.values()].filter((i) => i.pk === pk).map((i) => ({ pk: { S: i.pk }, sk: { S: i.sk } }));
        return { code: 0, stdout: JSON.stringify({ Items: items }) };
      }
      const req = JSON.parse(args[args.indexOf('--request-items') + 1]!) as Record<string, Array<{ DeleteRequest: { Key: { pk: { S: string }, sk: { S: string } } } }>>;
      for (const d of req['kanon-telemetry'] ?? []) table.delete(`${d.DeleteRequest.Key.pk.S}|${d.DeleteRequest.Key.sk.S}`);
      return { code: 0, stdout: JSON.stringify({ UnprocessedItems: {} }) };
    };
    expect(s.item.pk).toBe(`kk#${kind}`);
    const counts = erase('kk', { aws, profile: 'kanon', apply: true });
    expect(counts.find((c) => c.partition === `kk#${kind}`)).toEqual({ partition: `kk#${kind}`, rows: 1 });
    expect(table.size).toBe(0);
  });

  it('erasing a key with a stored finding leaves <key>#finding empty (plan 0006 F4)', () => {
    // The item is the one the ingest function stamps for a collector's finding, keyed by its own keysOf.
    const s = stamp(testFinding(Date.parse('2026-10-02T11:59:00Z'), 7), {
      caller: { kind: 'writer', key: 'kk' }, key: 'kk', now: Date.parse('2026-10-02T12:00:00Z'), finding: { nameHashes: new Set(), keys: new Set(['kk']) },
    });
    if (!s.ok) throw new Error('the finding did not validate');
    expect(s.item.pk).toBe('kk#finding');
    const table = new Map<string, { pk: string, sk: string }>([[`${s.item.pk}|${s.item.sk}`, { pk: s.item.pk, sk: s.item.sk }]]);
    const aws = (args: string[]) => {
      if (args[1] === 'query') {
        const pk = JSON.parse(args[args.indexOf('--expression-attribute-values') + 1]!)[':p'].S as string;
        return { code: 0, stdout: JSON.stringify({ Items: [...table.values()].filter((i) => i.pk === pk).map((i) => ({ pk: { S: i.pk }, sk: { S: i.sk } })) }) };
      }
      const req = JSON.parse(args[args.indexOf('--request-items') + 1]!) as Record<string, Array<{ DeleteRequest: { Key: { pk: { S: string }, sk: { S: string } } } }>>;
      for (const d of req['kanon-telemetry'] ?? []) table.delete(`${d.DeleteRequest.Key.pk.S}|${d.DeleteRequest.Key.sk.S}`);
      return { code: 0, stdout: JSON.stringify({ UnprocessedItems: {} }) };
    };
    const counts = erase('kk', { aws, profile: 'kanon', apply: true });
    expect(counts.find((c) => c.partition === 'kk#finding')).toEqual({ partition: 'kk#finding', rows: 1 });
    expect(table.size).toBe(0);
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
