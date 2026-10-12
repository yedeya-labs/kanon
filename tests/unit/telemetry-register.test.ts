import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { attr, plain, run } from '../../infra/telemetry/register.mjs';
import { REGISTER_TABLE, TOMBSTONE_FIELDS } from '../../infra/telemetry/function/register-fields.mjs';
import { PARTITIONS } from '../../infra/telemetry/function/index.mjs';
import { nameContext } from '../../actions/agent-telemetry/scrub.mjs';
import { writeStub } from './helpers/stub-bin.js';

/**
 * Plan 0008 J2: the operator's register CLI, against an in-memory register and rows table. No
 * AWS: every `aws` call is answered here and recorded, so each subcommand's call is checked, and
 * so is every line it prints, against a register full of keys.
 */

// DynamoDB items in attribute-value form, read by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Call = { op: string, args: string[] };

const REGISTER = fileURLToPath(new URL('../../infra/telemetry/register.mjs', import.meta.url));
const NOW = Date.parse('2026-10-12T12:00:00Z');
/** Keys no other text holds, so finding one anywhere in the output is the leak. */
const KEYS = ['ktestaaaa1111', 'ktestbbbb2222', 'ktestcccc3333', 'ktestdddd4444', 'ktesteeee5555'] as const;
const [KA, KB, KC, KD, KE] = KEYS;

const item = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, attr(v)]));
const arg = (args: string[], name: string) => args[args.indexOf(name) + 1]!;

/** Four registrations, in every state, each with its key item, and rows under each key. */
function seed() {
  const reg = new Map<string, Record<string, J>>();
  const add = (o: Record<string, unknown>) => reg.set(String(o.pk), item(o));
  add({ pk: 'repo#101', repository_id: '101', repository_owner_id: '11', repository: 'o/r', key: KA, status: 'active', default_ref: 'refs/heads/main',
    aggregate_invoker: true, publish_own_figures_as: 'own-label', page_reader: true, source: 'import' });
  add({ pk: 'repo#102', repository_id: '102', repository_owner_id: '11', repository: 'o/s', key: KB, status: 'suspended', suspended_reason: 'abuse',
    suspended_at: '2026-10-01T00:00:00.000Z', default_ref: 'refs/heads/main', source: 'api' });
  add({ pk: 'repo#103', repository_id: '103', repository_owner_id: '12', repository: 'p/t', key: KC, status: 'active', default_ref: 'refs/heads/trunk',
    first_review: { minutes: 95, review_recorded_at: '2026-10-02T12:00:01Z' }, source: 'api' });
  add({ pk: 'repo#104', repository_id: '104', repository_owner_id: '12', status: 'erased', erased_at: '2026-09-01T00:00:00.000Z', rows_erased_at: '2026-09-01T00:05:00.000Z' });
  for (const [i, k] of [KA, KB, KC].entries()) add({ pk: `key#${k}`, repository_id: String(101 + i) });
  add({ pk: `count#${KA}#2026-10-12`, n: 40, expires_at: 1 });
  const rows = new Map<string, J[]>();
  rows.set(`${KA}#review`, [{ pk: { S: `${KA}#review` }, sk: { S: 'a' } }, { pk: { S: `${KA}#review` }, sk: { S: 'b' } }]);
  rows.set(`${KA}#work`, [{ pk: { S: `${KA}#work` }, sk: { S: 'pr-0000000001' } }]);
  rows.set(`${KB}#review`, [{ pk: { S: `${KB}#review` }, sk: { S: 'c' } }]);
  return { reg, rows };
}

type Over = { fail?: Record<string, string>, ghFails?: string[], ghName?: Record<string, string> };

/**
 * The register and the rows table as `aws` sees them. A scan answers every item whole, whatever
 * the projection asks, so a register full of keys reaches the script; the filter is honoured.
 * `fail` makes an operation exit 254 with a stderr that quotes every key, as a careless error could.
 */
function fake(over: Over = {}) {
  const { reg, rows } = seed();
  const calls: Call[] = [];
  const leakyStderr = (op: string) => `An error occurred (${over.fail![op]}) when calling the ${op} operation: request ${KEYS.join(' ')}`;
  const aws = (args: string[]) => {
    const [service, op = ''] = args;
    calls.push({ op, args });
    expect(service).toBe('dynamodb');
    expect(arg(args, '--profile')).toBe('kanon');
    expect(arg(args, '--region')).toBe('eu-central-1');
    if (over.fail?.[op]) return { code: 254, stdout: '', stderr: leakyStderr(op) };
    const ok = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
    const table = args.includes('--table-name') ? arg(args, '--table-name') : undefined;
    if (op === 'scan') {
      expect(table).toBe(REGISTER_TABLE);
      const prefix = JSON.parse(arg(args, '--expression-attribute-values'))[':r'].S as string;
      return ok({ Items: [...reg.values()].filter((i) => i.pk.S.startsWith(prefix)) });
    }
    if (op === 'get-item') return ok(reg.has(JSON.parse(arg(args, '--key')).pk.S) ? { Item: reg.get(JSON.parse(arg(args, '--key')).pk.S) } : {});
    if (op === 'update-item') return ok({});
    if (op === 'transact-write-items') {
      for (const t of JSON.parse(arg(args, '--transact-items'))) {
        if (t.Put && t.Put.ConditionExpression === 'attribute_not_exists(pk)' && reg.has(t.Put.Item.pk.S)) {
          return { code: 254, stdout: '', stderr: 'An error occurred (TransactionCanceledException) when calling the TransactWriteItems operation: ConditionalCheckFailed' };
        }
      }
      for (const t of JSON.parse(arg(args, '--transact-items'))) {
        if (t.Put) reg.set(t.Put.Item.pk.S, t.Put.Item);
        if (t.Delete) reg.delete(t.Delete.Key.pk.S);
      }
      return ok({});
    }
    if (op === 'query') {
      expect(table).toBe('kanon-telemetry');
      const pk = JSON.parse(arg(args, '--expression-attribute-values'))[':p'].S as string;
      return ok({ Items: rows.get(pk) ?? [] });
    }
    if (op === 'batch-write-item') {
      const req = JSON.parse(arg(args, '--request-items'))['kanon-telemetry'] as J[];
      for (const r of req) rows.set(r.DeleteRequest.Key.pk.S, (rows.get(r.DeleteRequest.Key.pk.S) ?? []).filter((x) => x.sk.S !== r.DeleteRequest.Key.sk.S));
      return ok({});
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const ghCalls: string[][] = [];
  const gh = (args: string[]) => {
    ghCalls.push(args);
    const repo = (args[1] ?? '').replace(/^repos\//, '');
    if (over.ghFails?.includes(repo)) throw new Error(`gh: Not Found (HTTP 404) ${KEYS.join(' ')}`);
    const ids: Record<string, [number, number, string]> = { 'o/r': [101, 11, 'main'], 'o/s': [102, 11, 'main'], 'p/t': [103, 12, 'trunk'], 'q/u': [105, 13, 'main'], 'q/v': [106, 13, 'dev'] };
    const [id, owner, branch] = ids[repo] ?? [999, 99, 'main'];
    return JSON.stringify({ id, owner: { id: owner }, full_name: over.ghName?.[repo] ?? repo, default_branch: branch });
  };
  const files = new Map<string, string>();
  const deps = { aws, gh, profile: 'kanon', now: () => NOW, readFile: (p: string) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p)!; } };
  const cli = (...argv: string[]) => run(argv, deps);
  return { reg, rows, calls, ghCalls, files, cli, of: (op: string) => calls.filter((c) => c.op === op) };
}

/** Every line a result printed, both streams. */
const text = (r: { out: string[], err: string[] }) => [...r.out, ...r.err].join('\n');
const noKey = (r: { out: string[], err: string[] }) => { for (const k of KEYS) expect(text(r), k).not.toContain(k); };

const OWNER_ARN = `arn:aws:iam::${'1'.repeat(12)}:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_Admin_ab`;
const registerFile = (repositories: object[]) => JSON.stringify({ owner_principal_arn: OWNER_ARN, repositories });

describe('list', () => {
  it('counts by status, then names each registration by its repository, and prints no key', () => {
    const f = fake();
    const r = f.cli('list');
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      '4 registrations: 2 active, 1 suspended, 1 erased',
      'o/r: active; aggregate invoker; own figures as own-label; page reader',
      'o/s: suspended (abuse)',
      'p/t: active',
      'repository id 104: erased, rows erased 2026-09-01T00:05:00.000Z',
    ]);
    noKey(r);
  });
  it('scans registrations only, and never asks for the key', () => {
    const f = fake();
    f.cli('list');
    const [scan, ...rest] = f.of('scan');
    expect(rest).toEqual([]);
    expect(arg(scan!.args, '--filter-expression')).toBe('begins_with(pk, :r)');
    expect(JSON.parse(arg(scan!.args, '--expression-attribute-values'))).toEqual({ ':r': { S: 'repo#' } });
    expect(Object.values(JSON.parse(arg(scan!.args, '--expression-attribute-names')))).not.toContain('key');
  });
  it('follows a scan past its first page', () => {
    const f = fake();
    let first = true;
    const r = run(['list'], { aws: (args: string[]) => {
      if (args[1] !== 'scan') return { code: 1, stdout: '', stderr: '' };
      const page = first ? { Items: [item({ pk: 'repo#1', repository: 'o/r', status: 'active', key: KA })], LastEvaluatedKey: { pk: { S: `key#${KA}` } } }
        : { Items: [item({ pk: 'repo#2', repository: 'o/s', status: 'active', key: KB })] };
      if (!first) expect(arg(args, '--exclusive-start-key')).toBe(JSON.stringify({ pk: { S: `key#${KA}` } }));
      first = false;
      return { code: 0, stdout: JSON.stringify(page), stderr: '' };
    }, gh: () => '', profile: 'kanon', now: () => NOW, readFile: () => '' });
    expect(r.out[0]).toBe('2 registrations: 2 active, 0 suspended, 0 erased');
    noKey(r);
    expect(f.calls).toEqual([]);
  });
});

describe('suspend and resume', () => {
  it('suspend is one UpdateItem on the registration, effective at once, with a reason from the closed list', () => {
    const f = fake();
    const r = f.cli('suspend', '--repository', 'O/R', '--reason', 'quota');
    expect(r).toEqual({ code: 0, out: ['O/R: suspended (quota)'], err: [] });
    const [u, ...rest] = f.of('update-item');
    expect(rest).toEqual([]);
    expect(arg(u!.args, '--table-name')).toBe(REGISTER_TABLE);
    expect(JSON.parse(arg(u!.args, '--key'))).toEqual({ pk: { S: 'repo#101' } });
    expect(arg(u!.args, '--update-expression')).toBe('SET #s = :s, suspended_at = :t, suspended_reason = :r');
    expect(arg(u!.args, '--condition-expression')).toBe('attribute_exists(pk) AND (#s = :a OR #s = :s)');
    expect(JSON.parse(arg(u!.args, '--expression-attribute-values'))).toEqual({
      ':s': { S: 'suspended' }, ':a': { S: 'active' }, ':t': { S: '2026-10-12T12:00:00.000Z' }, ':r': { S: 'quota' } });
    expect(f.of('put-item')).toEqual([]);
  });
  it('refuses a reason outside the list, and a repository with no registration, before any write', () => {
    const f = fake();
    expect(f.cli('suspend', '--repository', 'o/r', '--reason', 'because')).toMatchObject({ code: 1, err: [expect.stringMatching(/--reason must be one of abuse, quota/)] });
    expect(f.cli('suspend', '--repository', 'x/y', '--reason', 'abuse')).toMatchObject({ code: 1, err: ['x/y: no registration'] });
    expect(f.of('update-item')).toEqual([]);
  });
  it('resume sets active and removes the suspension, only from suspended', () => {
    const f = fake();
    expect(f.cli('resume', '--repository', 'o/s')).toEqual({ code: 0, out: ['o/s: active'], err: [] });
    const [u] = f.of('update-item');
    expect(JSON.parse(arg(u!.args, '--key'))).toEqual({ pk: { S: 'repo#102' } });
    expect(arg(u!.args, '--update-expression')).toBe('SET #s = :a REMOVE suspended_at, suspended_reason');
    expect(arg(u!.args, '--condition-expression')).toBe('attribute_exists(pk) AND #s = :s');
  });
  it('a condition DynamoDB refuses is said plainly, without its stderr', () => {
    const f = fake({ fail: { 'update-item': 'ConditionalCheckFailedException' } });
    const r = f.cli('resume', '--repository', 'o/r');
    expect(r).toMatchObject({ code: 1, err: ['o/r: not suspended, so not resumed'] });
    noKey(r);
  });
});

describe('set', () => {
  it("sets the operator's fields in one UpdateItem, refusing an erased registration", () => {
    const f = fake();
    const r = f.cli('set', '--repository', 'p/t', '--aggregate-invoker', 'true', '--page-reader', 'false', '--publish-own-figures-as', 'pt-label',
      '--rows-per-day', '9000', '--requests-per-hour', '240', '--first-review', '30@2026-10-10T10:00:00.123Z');
    expect(r.code, text(r)).toBe(0);
    expect(r.out).toEqual(['p/t: set aggregate_invoker, page_reader, quota_rows_per_day, quota_requests_per_hour, first_review, publish_own_figures_as']);
    const [u, ...rest] = f.of('update-item');
    expect(rest).toEqual([]);
    expect(JSON.parse(arg(u!.args, '--key'))).toEqual({ pk: { S: 'repo#103' } });
    expect(arg(u!.args, '--update-expression')).toBe('SET aggregate_invoker = :aggregate_invoker, page_reader = :page_reader, '
      + 'quota_rows_per_day = :quota_rows_per_day, quota_requests_per_hour = :quota_requests_per_hour, first_review = :first_review, '
      + 'publish_own_figures_as = :publish_own_figures_as');
    expect(arg(u!.args, '--condition-expression')).toBe('attribute_exists(pk) AND #s <> :e');
    expect(JSON.parse(arg(u!.args, '--expression-attribute-values'))).toEqual({
      ':aggregate_invoker': { BOOL: true }, ':page_reader': { BOOL: false }, ':quota_rows_per_day': { N: '9000' }, ':quota_requests_per_hour': { N: '240' },
      ':first_review': { M: { minutes: { N: '30' }, review_recorded_at: { S: '2026-10-10T10:00:00.123Z' } } },
      ':publish_own_figures_as': { S: 'pt-label' }, ':e': { S: 'erased' } });
    noKey(r);
  });
  it('--no-publish-own-figures removes the label', () => {
    const f = fake();
    expect(f.cli('set', '--repository', 'o/r', '--no-publish-own-figures').out).toEqual(['o/r: set publish_own_figures_as removed']);
    expect(arg(f.of('update-item')[0]!.args, '--update-expression')).toBe('REMOVE publish_own_figures_as');
  });
  it('refuses, without echoing it, a label that is a key, another registration\'s, or not a label', () => {
    const f = fake();
    for (const [label, why] of [[KB, 'is a key'], ['own-label', "is another registration's label"], ['Not A Label', 'is not a label']] as const) {
      const r = f.cli('set', '--repository', 'p/t', '--publish-own-figures-as', label);
      expect(r).toMatchObject({ code: 1, err: [`--publish-own-figures-as ${why}`] });
      noKey(r);
    }
    // Its own label again is no clash.
    expect(f.cli('set', '--repository', 'o/r', '--publish-own-figures-as', 'own-label').code).toBe(0);
    expect(f.of('update-item')).toHaveLength(1);
  });
  it('refuses a bad value, nothing to set, and a first review past its 13 months', () => {
    const f = fake();
    const refused = (...a: string[]) => expect(f.cli('set', '--repository', 'o/r', ...a).code).toBe(1);
    refused('--aggregate-invoker', 'yes');
    refused('--page-reader', '1');
    refused('--rows-per-day', '0');
    refused('--requests-per-hour', '1.5');
    refused('--first-review', '30');
    refused('--first-review', '30@yesterday');
    refused('--first-review', '30@2025-09-01T00:00:00Z');
    refused('--publish-own-figures-as', 'x', '--no-publish-own-figures');
    refused();
    expect(f.of('update-item')).toEqual([]);
  });
});

describe('erase', () => {
  it('without --apply counts by lane, writes nothing, and prints no key', () => {
    const f = fake();
    const r = f.cli('erase', '--repository', 'o/r');
    expect(r.code, text(r)).toBe(0);
    expect(r.out).toEqual(['review: 2 found', 'work: 1 found', 'o/r: 3 rows found (dry run; pass --apply to erase)']);
    expect([...f.of('update-item'), ...f.of('batch-write-item'), ...f.of('transact-write-items')]).toEqual([]);
    // Every partition the key can hold, as erase.mjs walks it.
    expect(f.of('query').map((c) => JSON.parse(arg(c.args, '--expression-attribute-values'))[':p'].S)).toEqual(PARTITIONS.map((p) => `${KA}#${p}`));
    noKey(r);
  });
  it('with --apply marks it erased, deletes every row, then leaves the tombstone alone and drops the key item', () => {
    const f = fake();
    const r = f.cli('erase', '--repository', 'o/r', '--apply');
    expect(r.code, text(r)).toBe(0);
    expect(r.out.at(-1)).toBe('o/r: erased; 3 rows deleted; the tombstone is kept');
    noKey(r);
    const [u] = f.of('update-item');
    expect(arg(u!.args, '--update-expression')).toBe('SET #s = :e, erased_at = :t');
    expect(f.rows.get(`${KA}#review`)).toEqual([]);
    expect(f.rows.get(`${KA}#work`)).toEqual([]);
    expect(f.rows.get(`${KB}#review`)).toHaveLength(1);
    // The tombstone: TOMBSTONE_FIELDS and nothing else; no key, no name, no operator field.
    const tomb = f.reg.get('repo#101')!;
    expect(Object.keys(tomb).sort()).toEqual([...TOMBSTONE_FIELDS].sort());
    expect(Object.fromEntries(Object.entries(tomb).map(([k, v]) => [k, plain(v)]))).toEqual({
      pk: 'repo#101', repository_id: '101', repository_owner_id: '11', status: 'erased', erased_at: '2026-10-12T12:00:00.000Z', rows_erased_at: '2026-10-12T12:00:00.000Z' });
    expect(f.reg.has(`key#${KA}`)).toBe(false);
    // The tombstone replaces the registration only while it still holds that key.
    const [t] = f.of('transact-write-items');
    expect(JSON.parse(arg(t!.args, '--transact-items'))[0].Put.ConditionExpression).toBe('#k = :k');
  });
  it('a finished erasure says so; a walk that fails names the lane, never the key', () => {
    const f = fake();
    expect(f.cli('erase', '--repository', 'o/r', '--apply').code).toBe(0);
    // The tombstone has no name, so it is found by nothing: the operator sees it in list by id.
    expect(f.cli('erase', '--repository', 'o/r')).toMatchObject({ code: 1, err: ['o/r: no registration'] });
    const g = fake({ fail: { query: 'ProvisionedThroughputExceededException' } });
    const r = g.cli('erase', '--repository', 'o/s', '--apply');
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/^o\/s: query failed on [a-z-]+$/);
    noKey(r);
  });
  it('a tombstone that fails to write says so, and prints no key', () => {
    const f = fake({ fail: { 'transact-write-items': 'ValidationException' } });
    const r = f.cli('erase', '--repository', 'o/r', '--apply');
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe('o/r: rows deleted, but the tombstone was not written: aws dynamodb transact-write-items exited 254 (ValidationException); run erase again');
    noKey(r);
  });
});

describe('import (plan 0008 §9 step 3)', () => {
  const entries = [
    { key: KE, repository: 'q/u', readers: ['ref:refs/heads/main'], publish_own_figures_as: 'qu-label', aggregate_invoker: true,
      first_review: { minutes: 42, review_recorded_at: '2026-10-05T09:00:00.000Z' } },
    { key: KD, repository: 'q/v', readers: ['ref:refs/heads/dev'] },
  ];
  it('keeps every key exactly, resolves the ids and default branch from GitHub, and carries the operator fields', () => {
    const f = fake();
    f.reg.clear();
    f.files.set('/reg.json', registerFile(entries));
    const r = f.cli('import', '--register', '/reg.json');
    expect(r.code, text(r)).toBe(0);
    expect(r.out).toEqual([
      'q/u: imported (repository id 105, default branch main)',
      'q/v: imported (repository id 106, default branch dev)',
      'import: 2 registrations, every key unchanged',
    ]);
    noKey(r);
    const u = Object.fromEntries(Object.entries(f.reg.get('repo#105')!).map(([k, v]) => [k, plain(v)]));
    expect(u).toEqual({
      pk: 'repo#105', repository_id: '105', repository_owner_id: '13', repository: 'q/u', key: KE, status: 'active', default_ref: 'refs/heads/main',
      name_hashes: [...nameContext({ repository: 'q/u' })].sort(), registered_at: '2026-10-12T12:00:00.000Z', source: 'import',
      aggregate_invoker: true, publish_own_figures_as: 'qu-label', first_review: { minutes: 42, review_recorded_at: '2026-10-05T09:00:00.000Z' },
    });
    expect(plain(f.reg.get('repo#106')!.key)).toBe(KD);
    expect(f.reg.get('repo#106')!.aggregate_invoker).toBeUndefined();
    expect(plain(f.reg.get('repo#106')!.default_ref)).toBe('refs/heads/dev');
    // Each key item names its registration, and is written in the same transaction, conditional on neither existing.
    expect(plain(f.reg.get(`key#${KE}`)!.repository_id)).toBe('105');
    expect(plain(f.reg.get(`key#${KD}`)!.repository_id)).toBe('106');
    for (const c of f.of('transact-write-items')) {
      expect(JSON.parse(arg(c.args, '--transact-items')).map((t: J) => t.Put.ConditionExpression)).toEqual(['attribute_not_exists(pk)', 'attribute_not_exists(pk)']);
    }
    expect(f.ghCalls).toEqual([['api', 'repos/q/u'], ['api', 'repos/q/v']]);
  });
  it('a rerun leaves what is there; a repository under another key is refused', () => {
    const f = fake();
    f.files.set('/reg.json', registerFile(entries));
    expect(f.cli('import', '--register', '/reg.json').code).toBe(0);
    const again = f.cli('import', '--register', '/reg.json');
    expect(again.out).toEqual(['q/u: already imported', 'q/v: already imported', 'import: 2 registrations, every key unchanged']);
    expect(f.of('transact-write-items')).toHaveLength(2);
    f.files.set('/other.json', registerFile([{ ...entries[0], key: 'kanotherkey99' }]));
    const r = f.cli('import', '--register', '/other.json');
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain('q/u: refused: registered under another key');
    noKey(r);
    expect(text(r)).not.toContain('kanotherkey99');
  });
  it('a key already registered to another repository is refused by the transaction', () => {
    const f = fake();
    f.files.set('/reg.json', registerFile([{ key: KA, repository: 'q/u', readers: ['ref:refs/heads/main'] }]));
    const r = f.cli('import', '--register', '/reg.json');
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain('q/u: refused: its key is already registered to another repository');
    expect(f.reg.has('repo#105')).toBe(false);
    noKey(r);
  });
  it('an entry GitHub does not answer for, or spells differently, stops the import before any write, named by index', () => {
    const f = fake({ ghFails: ['q/v'] });
    f.files.set('/reg.json', registerFile(entries));
    const r = f.cli('import', '--register', '/reg.json');
    expect(r).toMatchObject({ code: 1, out: [], err: ['import: nothing written: repositories[1]: GitHub does not answer for q/v'] });
    expect([...f.of('get-item'), ...f.of('transact-write-items')]).toEqual([]);
    const g = fake({ ghName: { 'q/u': 'q/renamed' } });
    g.files.set('/reg.json', registerFile(entries));
    expect(g.cli('import', '--register', '/reg.json').err).toEqual(["import: nothing written: repositories[0]: GitHub calls q/u 'q/renamed'"]);
    expect(g.of('transact-write-items')).toEqual([]);
  });
  it('a register that is not JSON, or fails its checks, is refused without quoting it', () => {
    const f = fake();
    f.files.set('/bad.json', `{ "repositories": [{ "key": ${KE} }] }`);
    const r = f.cli('import', '--register', '/bad.json');
    expect(r).toMatchObject({ code: 1, err: ['import: /bad.json is not a JSON register'] });
    noKey(r);
    f.files.set('/dup.json', registerFile([entries[0]!, { ...entries[1]!, key: KE }]));
    const d = f.cli('import', '--register', '/dup.json');
    expect(d.err[0]).toMatch(/^import: repositories\[1\]\.key duplicates another key/);
    noKey(d);
    expect(f.calls).toEqual([]);
  });
});

describe('no output names a key (kanon#628, Owner decision 3)', () => {
  it('every subcommand, succeeding or failing on any call with a stderr that quotes every key', () => {
    const argvs = [
      ['list'], ['suspend', '--repository', 'o/r', '--reason', 'abuse'], ['resume', '--repository', 'o/s'],
      ['set', '--repository', 'p/t', '--publish-own-figures-as', 'fresh', '--page-reader', 'true'],
      ['erase', '--repository', 'o/r'], ['erase', '--repository', 'o/s', '--apply'], ['import', '--register', '/reg.json'],
    ];
    for (const fail of [undefined, 'scan', 'get-item', 'update-item', 'query', 'batch-write-item', 'transact-write-items']) {
      for (const argv of argvs) {
        const f = fake(fail ? { fail: { [fail]: 'AccessDeniedException' } } : {});
        f.files.set('/reg.json', registerFile([{ key: KD, repository: 'q/v', readers: ['ref:refs/heads/main'] }]));
        const r = f.cli(...argv);
        noKey(r);
        if (fail && r.code !== 0) expect(text(r)).not.toContain('request');
      }
    }
  });
  it('a usage error prints the usage, and exits 2', () => {
    const f = fake();
    for (const argv of [[], ['nope'], ['suspend'], ['set'], ['import'], ['list', 'extra'], ['list', '--bogus']]) {
      const r = f.cli(...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err[0]).toMatch(/^usage: register\.mjs/);
    }
  });
  it('the CLI, run as the Owner runs it, prints by repository on stdout and no key on either stream', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-register-'));
    const scan = JSON.stringify({ Items: [item({ pk: 'repo#1', repository: 'o/r', key: KA, status: 'active' }), item({ pk: 'repo#2', repository: 'o/s', key: KB, status: 'suspended', suspended_reason: 'other' })] });
    writeFileSync(join(dir, 'scan.json'), scan);
    writeStub(join(dir, 'aws'), [
      '#!/usr/bin/env bash',
      `if [ "$2" = scan ]; then cat '${join(dir, 'scan.json')}'; exit 0; fi`,
      `echo "An error occurred (AccessDeniedException) ${KA} ${KB}" >&2; exit 254`,
      '',
    ].join('\n'));
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const ok = spawnSync('node', [REGISTER, 'list'], { encoding: 'utf8', timeout: 30_000, env });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('2 registrations: 1 active, 1 suspended, 0 erased\no/r: active\no/s: suspended (other)\n');
    const bad = spawnSync('node', [REGISTER, 'suspend', '--repository', 'o/r', '--reason', 'abuse'], { encoding: 'utf8', timeout: 30_000, env });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe('aws dynamodb update-item exited 254 (AccessDeniedException)\n');
    for (const k of KEYS) expect(ok.stdout + ok.stderr + bad.stdout + bad.stderr).not.toContain(k);
  });
});
