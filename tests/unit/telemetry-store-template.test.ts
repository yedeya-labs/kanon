import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { FUNCTION_DIR, registerProblems, render, TEMPLATE_PATH } from '../../infra/telemetry/render.mjs';
import { ATTRIBUTES, TOKEN_ALIAS } from '../../infra/telemetry/function/aggregate.mjs';
import { nameHashesOf } from '../../infra/telemetry/function/index.mjs';
import {
  AGGREGATE_GET, AGGREGATE_SCAN, FUNCTION_FIELDS, INGEST_SCAN, KEY_ITEM_PREFIX, OPERATOR_FIELDS, REGISTER_TABLE, REGISTRATION_PREFIX,
  TOMBSTONE_FIELDS,
} from '../../infra/telemetry/function/register-fields.mjs';
import { sha256 } from '../../actions/agent-telemetry/public-words.mjs';
import { KANON_WORDS, nameContext } from '../../actions/agent-telemetry/scrub.mjs';
import { writeStub } from './helpers/stub-bin.js';

/**
 * Plan 0002 step S3: the store's CloudFormation template, as rendered from the example
 * register. Parsed, never deployed: every property §3 to §5, §7, §9 and §10 rely on is
 * asserted here, so a change that drops one is red without AWS.
 */

// The rendered template is untyped JSON, read by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Res = { Type: string, Condition?: string, DeletionPolicy?: string, UpdateReplacePolicy?: string, Properties: Record<string, J> };

const example = JSON.parse(readFileSync('infra/telemetry/register.example.json', 'utf8'));
const register = { ...example, owner_principal_arn: `arn:aws:iam::${'1'.repeat(12)}:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_Admin_ab` };
/**
 * A stand-in for `gh api`: each repository's default branch and OIDC subject customization, as
 * GitHub reports them. Unknown repositories fail, as `gh` would.
 */
type Repo = { full_name?: string, default_branch?: string, customization?: Record<string, unknown> };
const fakeGh = (repos: Record<string, Repo>) => (args: string[]): string => {
  const path = args[1] ?? '';
  const m = /^repos\/([^/]+\/[^/]+)(\/actions\/oidc\/customization\/sub)?$/.exec(path);
  const r = m ? repos[m[1]!] : undefined;
  if (!m || !r) throw new Error(`gh: HTTP 404 for ${path}`);
  return JSON.stringify(m[2] ? r.customization ?? { use_default: true, use_immutable_subject: false } : { full_name: r.full_name ?? m[1], default_branch: r.default_branch ?? 'main' });
};
const gh = fakeGh({ 'yedeya-labs/kanon': {}, 'o/r': {}, 'o/s': {} });
const { template, parameters, subjects } = render(register, { gh });
const R = template.Resources as Record<string, Res>;
const key = example.repositories[0].key as string;
const repo = example.repositories[0].repository as string;
const id = key.replace(/[^A-Za-z0-9]/g, '');
const byType = (t: string) => Object.entries(R).filter(([, r]) => r.Type === t);
const statements = (doc: J): J[] => doc.Statement;

describe('the table (§5, §10, K-OBS-17)', () => {
  const table = R.Table!;
  it('is retained on delete and on replace, and protected from deletion', () => {
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.UpdateReplacePolicy).toBe('Retain');
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
  });
  it('has point-in-time recovery, and TTL on expires_at', () => {
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'expires_at', Enabled: true });
  });
  it('is on demand, keyed pk and sk, with the AWS-owned key (§9)', () => {
    expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    expect(table.Properties.ProvisionedThroughput).toBeUndefined();
    expect(table.Properties.SSESpecification).toBeUndefined();
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }]);
  });
  it('its resource policy denies every write to all but the function, the Owner, and the self-read role the function alone assumes (§4; plan 0008 §7)', () => {
    const [deny, ...rest] = statements(table.Properties.ResourcePolicy.PolicyDocument);
    expect(rest).toEqual([]);
    expect(deny).toMatchObject({ Effect: 'Deny', Principal: '*' });
    expect([...deny.Action].sort()).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(deny.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': [
      { 'Fn::GetAtt': ['IngestRole', 'Arn'] }, { Ref: 'OwnerPrincipalArn' }, { 'Fn::GetAtt': ['SelfReadRole', 'Arn'] },
    ] } });
  });
});

describe('the register table (plan 0008 §5.1, §5.3)', () => {
  const table = R.RegisterTable!;
  const tableArn = { 'Fn::Sub': 'arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/kanon-telemetry-register' };
  /** Every statement of a role's policies that names the register table. */
  const onRegister = (role: string): J[] => (R[role]!.Properties.Policies as J[])
    .flatMap((p) => statements(p.PolicyDocument))
    .filter((s) => JSON.stringify(s.Resource ?? '').includes('table/kanon-telemetry-register'));
  const actions = (s: J): string[] => [s.Action].flat();
  const attributes = (s: J): string[] => [...s.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']].sort();

  it('is retained on delete and on replace, deletion-protected, with point-in-time recovery', () => {
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.UpdateReplacePolicy).toBe('Retain');
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
  });
  it('is on demand, keyed pk alone, named kanon-telemetry-register, with TTL on expires_at for the counters', () => {
    expect(table.Properties.TableName).toBe(REGISTER_TABLE);
    expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'expires_at', Enabled: true });
  });
  it('is encrypted with KMS under the AWS-managed key, not a customer-managed one (Owner decision 4)', () => {
    expect(table.Properties.SSESpecification).toEqual({ SSEEnabled: true, SSEType: 'KMS' });
    expect(byType('AWS::KMS::Key')).toEqual([]);
  });
  it('its resource policy denies every action to every principal but the four of §5.3', () => {
    const [deny, ...rest] = statements(table.Properties.ResourcePolicy.PolicyDocument);
    expect(rest).toEqual([]);
    expect(deny).toMatchObject({ Effect: 'Deny', Principal: '*', Action: 'dynamodb:*', Resource: tableArn });
    expect(Object.keys(deny.Condition)).toEqual(['ArnNotEquals']);
    expect(Object.keys(deny.Condition.ArnNotEquals)).toEqual(['aws:PrincipalArn']);
    const three = [{ 'Fn::GetAtt': ['IngestRole', 'Arn'] }, { 'Fn::GetAtt': ['AggregateRole', 'Arn'] }, { Ref: 'OwnerPrincipalArn' }];
    // Without the operator's job roles, exactly three; with them, the same three and the list.
    expect(deny.Condition.ArnNotEquals['aws:PrincipalArn']).toEqual({ 'Fn::If': ['HasOperatorJobRoles',
      { 'Fn::Split': [',', { 'Fn::Join': [',', [...three, { 'Fn::Join': [',', { Ref: 'OperatorJobRoleArns' }] }]] }] }, three] });
    expect(template.Parameters.OperatorJobRoleArns).toMatchObject({ Type: 'CommaDelimitedList', Default: '' });
    expect(template.Conditions.HasOperatorJobRoles).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ 'Fn::Join': ['', { Ref: 'OperatorJobRoleArns' }] }, ''] }] });
  });
  it("the ingest role's writes list every field but the operator's, so IAM refuses it a write that sets one", () => {
    const writes = onRegister('IngestRole').filter((s) => actions(s).some((a) => /Put|Update|Write/.test(a)));
    expect(writes).toHaveLength(1);
    const [w] = writes;
    expect(actions(w).sort()).toEqual(['dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(Object.keys(w.Condition)).toEqual(['ForAllValues:StringEquals']);
    expect(attributes(w)).toEqual([...FUNCTION_FIELDS].sort());
    for (const f of OPERATOR_FIELDS) expect(attributes(w), f).not.toContain(f);
    expect(attributes(w).filter((f) => /^(quota_|suspended_)/.test(f))).toEqual([]);
    expect(FUNCTION_FIELDS.filter((f) => OPERATOR_FIELDS.includes(f))).toEqual([]);
  });
  it('the ingest role may delete key items alone, which is the one delete §5.3 grants, on erasure', () => {
    // A DeleteItem names no attribute, so dynamodb:Attributes can't hold it: the partition can.
    const deletes = onRegister('IngestRole').filter((s) => actions(s).some((a) => /Delete/.test(a)));
    expect(deletes).toHaveLength(1);
    const [d] = deletes;
    expect(actions(d)).toEqual(['dynamodb:DeleteItem']);
    expect(d.Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${KEY_ITEM_PREFIX}*`] } });
    expect(`${KEY_ITEM_PREFIX}*`.startsWith(REGISTRATION_PREFIX)).toBe(false);
  });
  it("the ingest role reads registrations, and Scans pk alone, for assertNoKey's keys", () => {
    const s = onRegister('IngestRole');
    expect(s.map(actions)).toEqual([['dynamodb:GetItem', 'dynamodb:Query'], ['dynamodb:Scan'], expect.any(Array), ['dynamodb:DeleteItem']]);
    expect(s[0].Condition).toBeUndefined();
    expect(attributes(s[1])).toEqual([...INGEST_SCAN]);
    expect(s[1].Condition.StringEquals).toEqual({ 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' });
  });
  it("the aggregate role Scans exactly pk, key, status and the label, and GetItems exactly the caller's checks", () => {
    const [scan, get, ...rest] = onRegister('AggregateRole');
    expect(rest).toEqual([]);
    expect(actions(scan)).toEqual(['dynamodb:Scan']);
    expect(attributes(scan)).toEqual([...AGGREGATE_SCAN].sort());
    expect(attributes(scan)).not.toContain('repository');
    expect(attributes(scan)).not.toContain('repository_owner_id');
    expect(scan.Condition.StringEquals).toEqual({ 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' });
    expect(actions(get)).toEqual(['dynamodb:GetItem']);
    expect(attributes(get)).toEqual([...AGGREGATE_GET].sort());
    expect(attributes(get)).not.toContain('repository');
    expect(get.Condition.StringEqualsIfExists).toEqual({ 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' });
    expect(Object.keys(get.Condition).sort()).toEqual(['ForAllValues:StringEquals', 'StringEqualsIfExists']);
  });
  it('no other role names the register table, and nothing is granted on it with a wildcard', () => {
    for (const [name, r] of byType('AWS::IAM::Role')) {
      if (name === 'IngestRole' || name === 'AggregateRole') continue;
      expect(JSON.stringify(r.Properties.Policies ?? []), name).not.toContain('kanon-telemetry-register');
    }
    for (const s of [...onRegister('IngestRole'), ...onRegister('AggregateRole')]) {
      expect(s.Effect).toBe('Allow');
      for (const a of actions(s)) expect(a).not.toContain('*');
    }
  });
  it('the tombstone keeps the two ids, the status and two dates, and the ingest role may write each', () => {
    expect([...TOMBSTONE_FIELDS].sort()).toEqual(['erased_at', 'pk', 'repository_id', 'repository_owner_id', 'rows_erased_at', 'status']);
    for (const f of TOMBSTONE_FIELDS) expect(FUNCTION_FIELDS).toContain(f);
  });
});

describe('the ingest function and its URL (§4)', () => {
  const fn = R.IngestFunction!.Properties;
  it('the unqualified URLs are IAM-authenticated; the public ones are each function\'s `live` alias\'s (plan 0008 §9, J3 and J4)', () => {
    expect(byType('AWS::Lambda::Url').map(([name, r]) => [name, r.Properties.AuthType, r.Properties.Qualifier])).toEqual([
      ['IngestUrl', 'AWS_IAM', undefined], ['IngestLiveUrl', 'NONE', 'live'], ['AggregateUrl', 'AWS_IAM', undefined], ['AggregateLiveUrl', 'NONE', TOKEN_ALIAS],
    ]);
    expect(R.IngestLiveUrl!.Properties.TargetFunctionArn).toEqual({ 'Fn::GetAtt': ['IngestFunction', 'Arn'] });
  });
  it('the aliases are `live` and `erase`, and the aggregate function\'s `live`, on $LATEST, and no URL serves `erase`', () => {
    expect(byType('AWS::Lambda::Alias').map(([name, r]) => [name, r.Properties.Name, r.Properties.FunctionVersion, r.Properties.FunctionName])).toEqual([
      ['IngestLiveAlias', 'live', '$LATEST', { Ref: 'IngestFunction' }], ['IngestEraseAlias', 'erase', '$LATEST', { Ref: 'IngestFunction' }],
      ['AggregateLiveAlias', TOKEN_ALIAS, '$LATEST', { Ref: 'AggregateFunction' }],
    ]);
  });
  it('the only public permissions are the two `live` aliases\', through their URLs; every other is held to IAM auth', () => {
    const open = byType('AWS::Lambda::Permission').filter(([, p]) => p.Properties.Principal === '*');
    expect(open.map(([name, p]) => [name, p.Properties])).toEqual([
      ['IngestLiveUrlPermission', { FunctionName: { Ref: 'IngestLiveAlias' }, Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' }],
      ['IngestLiveInvokePermission', { FunctionName: { Ref: 'IngestLiveAlias' }, Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true }],
      ['AggregateLiveUrlPermission', { FunctionName: { Ref: 'AggregateLiveAlias' }, Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' }],
      ['AggregateLiveInvokePermission', { FunctionName: { Ref: 'AggregateLiveAlias' }, Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true }],
    ]);
    for (const [, p] of byType('AWS::Lambda::Permission')) {
      if (p.Properties.Principal === '*') continue;
      expect(p.Properties.FunctionUrlAuthType).toBe('AWS_IAM');
    }
  });
  it('the token path\'s role grants: a self-read session, and the `erase` alias, nothing more', () => {
    const doc = R.IngestRole!.Properties.Policies.find((x: J) => x.PolicyName === 'token-path').PolicyDocument;
    expect(statements(doc)).toEqual([
      { Sid: 'AssumeTheSelfReadRole', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/kanon-telemetry-self-read' } },
      { Sid: 'StartTheErasureWalk', Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:kanon-telemetry-ingest:erase' } },
    ]);
  });
  it('the self-read role trusts the ingest function\'s role alone, and may only Query and delete rows (plan 0008 §3.5)', () => {
    const role = R.SelfReadRole!.Properties;
    expect(role.RoleName).toBe('kanon-telemetry-self-read');
    expect(statements(role.AssumeRolePolicyDocument)).toEqual([{ Effect: 'Allow', Principal: { AWS: { 'Fn::GetAtt': ['IngestRole', 'Arn'] } }, Action: 'sts:AssumeRole' }]);
    expect(role.Policies).toHaveLength(1);
    expect(statements(role.Policies[0].PolicyDocument)).toEqual([{
      Effect: 'Allow', Action: ['dynamodb:Query', 'dynamodb:BatchWriteItem'],
      Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/kanon-telemetry' },
    }]);
  });
  it('is told the token path\'s settings, and the audience is a parameter defaulting to kanon-telemetry', () => {
    expect(fn.Environment.Variables).toMatchObject({
      REGISTER_TABLE: REGISTER_TABLE, AUDIENCE: { Ref: 'Audience' }, MIN_TOKEN_VERSION: { Ref: 'MinTokenVersion' },
      SELF_READ_ROLE: { 'Fn::GetAtt': ['SelfReadRole', 'Arn'] }, CURSOR_KEY: { Ref: 'CursorKey' },
    });
    expect(template.Parameters.Audience.Default).toBe('kanon-telemetry');
    expect(template.Parameters.CursorKey.NoEcho).toBe(true);
    for (const [name, ok, bad] of [['MinTokenVersion', '0.40.0', '0.40'], ['CursorKey', 'ab'.repeat(32), 'AB'.repeat(32)]] as const) {
      const re = new RegExp(template.Parameters[name].AllowedPattern);
      expect(re.test(ok) && re.test('') && !re.test(bad), name).toBe(true);
    }
  });
  it('its role may PutItem and write its own logs, and nothing else', () => {
    const doc = R.IngestRole!.Properties.Policies[0].PolicyDocument;
    expect(statements(doc).flatMap((s) => [s.Action].flat()).sort()).toEqual(['dynamodb:PutItem', 'logs:CreateLogStream', 'logs:PutLogEvents']);
  });
  it('is small and has no VPC (§9): no NAT, no always-on compute', () => {
    expect(fn.MemorySize).toBe(128);
    expect(fn.VpcConfig).toBeUndefined();
    expect(fn.Runtime).toBe('nodejs24.x');
  });
  it('reserves a concurrency of 2 by default, and 0 removes the reservation', () => {
    expect(template.Parameters.ReservedConcurrency.Default).toBe(2);
    expect(fn.ReservedConcurrentExecutions).toEqual({ 'Fn::If': ['HasReservedConcurrency', { Ref: 'ReservedConcurrency' }, { Ref: 'AWS::NoValue' }] });
    expect(template.Conditions.HasReservedConcurrency).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ReservedConcurrency' }, 0] }] });
  });
  it('logs to a group kept 30 days', () => {
    expect(R.IngestLogGroup!.Properties.RetentionInDays).toBe(30);
    expect(fn.LoggingConfig.LogGroup).toEqual({ Ref: 'IngestLogGroup' });
  });
  it('is told the registered keys, and the importer and backfill roles only while they exist', () => {
    expect(fn.Environment.Variables.WRITER_KEYS).toBe(key);
    expect(fn.Environment.Variables.IMPORTER_ROLE).toEqual({ 'Fn::If': ['ImporterOn', 'kanon-telemetry-importer', ''] });
    expect(fn.Environment.Variables.BACKFILL_ROLE).toEqual({ 'Fn::If': ['BackfillOn', 'kanon-telemetry-backfill', ''] });
  });
  it("is told each key's repository as the hashes of its words, never the words, and none of Kanon's own (plan 0006 §4.2, F4; kanon#612)", () => {
    const words = repo.toLowerCase().match(/[a-z0-9]+/g)!.filter((w) => !KANON_WORDS.has(w));
    expect(fn.Environment.Variables.NAME_HASHES).toBe(`${key}=${[...new Set(words.map(sha256))].sort().join(':')}`);
    for (const w of words) expect(fn.Environment.Variables.NAME_HASHES).not.toContain(w);
    // The function reads back exactly the scrub's context for that repository.
    expect(nameHashesOf({ NAME_HASHES: fn.Environment.Variables.NAME_HASHES }, key))
      .toEqual(nameContext({ repository: repo }));
    const two = render({ ...register, repositories: [{ key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'] }, { key: 'k2', repository: 'o/s', readers: ['ref:refs/heads/main'] }] }, { gh });
    expect(two.template.Resources.IngestFunction.Properties.Environment.Variables.NAME_HASHES)
      .toBe(`k1=${[sha256('o'), sha256('r')].sort().join(':')},k2=${[sha256('o'), sha256('s')].sort().join(':')}`);
  });
  it("refuses a register whose environment would pass Lambda's 4 KB", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, repository: `owner${i}/name${i}-and-more-words`, readers: ['ref:refs/heads/main'] }));
    const lots = fakeGh(Object.fromEntries(many.map((e) => [e.repository, {}])));
    expect(() => render({ ...register, repositories: many }, { gh: lots })).toThrow(/environment would be \d+ bytes for 20 repositories, past Lambda's 4096/);
    expect(() => render({ ...register, repositories: many.slice(0, 5) }, { gh: lots })).not.toThrow();
  });
});

describe('the code that is packaged (§5)', () => {
  it('is the function directory, and its schema module IS the lanes\' schema module', () => {
    expect(R.IngestFunction!.Properties.Code).toBe(FUNCTION_DIR);
    expect(lstatSync(join(FUNCTION_DIR, 'schema.mjs')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(FUNCTION_DIR, 'schema.mjs'))).toBe(realpathSync('actions/agent-telemetry/schema.mjs'));
  });
  it('its indicators ARE the report\'s core, linked with the import-free files it reads (plan 0003 M7)', () => {
    for (const f of ['indicators.mjs', 'band.mjs', 'join.mjs', 'stats.mjs']) {
      expect(lstatSync(join(FUNCTION_DIR, f)).isSymbolicLink(), f).toBe(true);
      expect(realpathSync(join(FUNCTION_DIR, f)), f).toBe(realpathSync(`scripts/metrics/${f}`));
    }
  });
  it('its scrub and the scrub\'s word check ARE the lanes\' files, linked like the schema (plan 0006 §4.2)', () => {
    for (const [f, real] of [['scrub.mjs', 'actions/agent-telemetry/scrub.mjs'], ['public-words.mjs', 'actions/agent-telemetry/public-words.mjs']] as const) {
      expect(lstatSync(join(FUNCTION_DIR, f)).isSymbolicLink(), f).toBe(true);
      expect(realpathSync(join(FUNCTION_DIR, f)), f).toBe(realpathSync(real));
    }
  });
  it('imports nothing but node: built-ins and its own files, each of which is in the package', () => {
    for (const f of readdirSync(FUNCTION_DIR)) {
      const specs = [...readFileSync(join(FUNCTION_DIR, f), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]!);
      for (const s of specs) {
        expect(s, `${f} imports ${s}`).toMatch(/^(node:|\.\/[a-z0-9-]+\.mjs$)/);
        // `aws cloudformation package` zips this directory alone, so a sibling import must be here.
        if (s.startsWith('./')) expect(existsSync(join(FUNCTION_DIR, s)), `${f} imports ${s}, which the package lacks`).toBe(true);
      }
    }
  });
});

describe('the roles (§3, §6, §7)', () => {
  const writer = R[`WriterRole${id}`]!.Properties;
  const reader = R[`ReaderRole${id}`]!.Properties;
  const oidc = (role: Record<string, J>) => statements(role.AssumeRolePolicyDocument)[0];

  it('the writer trusts only its repository\'s default-branch ref, never an environment', () => {
    expect(writer.RoleName).toBe(`kanon-telemetry-${key}-writer`);
    expect(oidc(writer).Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(oidc(writer).Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${repo}:ref:refs/heads/main`,
      },
    });
    expect(subjects[key]).toEqual({ writer: [`repo:${repo}:ref:refs/heads/main`], readers: [`repo:${repo}:ref:refs/heads/main`] });
    expect(JSON.stringify(template)).not.toMatch(/environment:/);
  });
  it('the writer may invoke the URL and nothing else, and InvokeFunction only through the URL', () => {
    const s = statements(writer.Policies[0].PolicyDocument);
    expect(s.map((x) => x.Action)).toEqual(['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction']);
    expect(s[0].Condition).toEqual({ StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } });
    expect(s[1].Condition).toEqual({ Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } });
    expect(s.every((x) => x.Resource['Fn::GetAtt'][0] === 'IngestFunction')).toBe(true);
  });
  it('the reader trusts its listed subjects exactly, and reads only its own key', () => {
    expect(oidc(reader).Condition.StringEquals['token.actions.githubusercontent.com:sub']).toBe(`repo:${repo}:ref:refs/heads/main`);
    const [s, ...rest] = statements(reader.Policies[0].PolicyDocument);
    expect(rest).toEqual([]);
    expect(s.Action).toEqual(['dynamodb:Query', 'dynamodb:GetItem']);
    expect(s.Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${key}#*`] } });
  });
  it('no trust condition is a pattern', () => {
    for (const [, r] of byType('AWS::IAM::Role')) {
      for (const s of statements(r.Properties.AssumeRolePolicyDocument)) {
        if (s['Fn::If']) continue;
        expect(Object.keys(s.Condition ?? {}).filter((k) => /Like/.test(k))).toEqual([]);
      }
    }
  });
  it('a reader with several subjects lists each, exactly', () => {
    const two = render({ ...register, repositories: [{ key: 'k2', repository: 'o/r', readers: ['ref:refs/heads/main', 'ref:refs/heads/release'] }] }, { gh });
    const s = statements((two.template.Resources.ReaderRolek2 as Res).Properties.AssumeRolePolicyDocument)[0];
    expect(s.Condition.StringEquals['token.actions.githubusercontent.com:sub']).toEqual(['repo:o/r:ref:refs/heads/main', 'repo:o/r:ref:refs/heads/release']);
  });
  it('the Owner may assume a writer or reader only while EnableVerify is on', () => {
    for (const role of [writer, reader]) {
      const v = statements(role.AssumeRolePolicyDocument)[1];
      expect(v['Fn::If'][0]).toBe('VerifyOn');
      expect(v['Fn::If'][1].Condition).toEqual({ ArnEquals: { 'aws:PrincipalArn': { Ref: 'OwnerPrincipalArn' } } });
      expect(v['Fn::If'][2]).toEqual({ Ref: 'AWS::NoValue' });
    }
    expect(template.Parameters.EnableVerify.Default).toBe('false');
  });
  it('the importer and backfill roles exist only behind their parameters, for the Owner only', () => {
    for (const [name, cond, param] of [['ImporterRole', 'ImporterOn', 'EnableImporter'], ['BackfillRole', 'BackfillOn', 'EnableBackfill']] as const) {
      expect(R[name]!.Condition).toBe(cond);
      expect(template.Parameters[param].Default).toBe('false');
      const [t, ...rest] = statements(R[name]!.Properties.AssumeRolePolicyDocument);
      expect(rest).toEqual([]);
      expect(t.Condition).toEqual({ ArnEquals: { 'aws:PrincipalArn': { Ref: 'OwnerPrincipalArn' } } });
    }
  });
  it('the write probe exists only while EnableVerify is on, for the Owner only, allowed exactly the denied writes (kanon#101)', () => {
    const probe = R.VerifyProbeRole!;
    expect(probe.Condition).toBe('VerifyOn');
    expect(probe.Properties.RoleName).toBe('kanon-telemetry-verify-probe');
    const [t, ...rest] = statements(probe.Properties.AssumeRolePolicyDocument);
    expect(rest).toEqual([]);
    expect(t.Condition).toEqual({ ArnEquals: { 'aws:PrincipalArn': { Ref: 'OwnerPrincipalArn' } } });
    const [policy, ...others] = probe.Properties.Policies;
    expect(others).toEqual([]);
    const [allow, ...more] = statements(policy.PolicyDocument);
    expect(more).toEqual([]);
    expect(allow.Effect).toBe('Allow');
    // The same four writes, on the same table, that the table's resource policy denies: so
    // only that deny can refuse the probe, which is what verify.mjs check 7 needs.
    const deny = statements(R.Table!.Properties.ResourcePolicy.PolicyDocument)[0];
    expect([...allow.Action].sort()).toEqual([...deny.Action].sort());
    expect(allow.Resource).toEqual(deny.Resource);
    // And the deny's exceptions don't name it.
    expect(JSON.stringify(deny.Condition)).not.toContain('VerifyProbeRole');
  });
  it('the OIDC provider is created only when the parameter says so', () => {
    expect(R.OidcProvider!.Condition).toBe('CreateOidc');
    expect(template.Parameters.CreateOidcProvider.Default).toBe('true');
    expect(oidc(writer).Principal.Federated['Fn::If'][0]).toBe('CreateOidc');
  });
});

describe('the aggregate-only function (§6.1, decided by the Owner 2026-10-07)', () => {
  const fn = R.AggregateFunction!.Properties;
  const role = R.AggregateRole!.Properties;
  const invoker = R[`AggregateInvokerRole${id}`]!.Properties;
  it('runs the aggregate module from the same package as the ingest function', () => {
    expect(fn.Handler).toBe('aggregate.handler');
    expect(fn.Code).toBe(FUNCTION_DIR);
    expect(fn.VpcConfig).toBeUndefined();
    expect(fn.Role).toEqual({ 'Fn::GetAtt': ['AggregateRole', 'Arn'] });
    expect(R.AggregateLogGroup!.Properties.RetentionInDays).toBe(30);
  });
  it('its role may Query only with exactly the aggregate projection and Select named, and log; nothing else', () => {
    const [q, logs, ...rest] = statements(role.Policies[0].PolicyDocument);
    expect(rest).toEqual([]);
    expect(q.Action).toBe('dynamodb:Query');
    expect([...q.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']].sort()).toEqual([...ATTRIBUTES, 'sk'].sort());
    expect(q.Condition.StringEquals).toEqual({ 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' });
    expect(Object.keys(q.Condition).sort()).toEqual(['ForAllValues:StringEquals', 'StringEquals']);
    expect([...logs.Action].sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(statements(role.AssumeRolePolicyDocument)).toEqual([{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]);
  });
  it('is told every key, the declared own-figure labels and the invoker keys, from the register', () => {
    expect(fn.Environment.Variables).toMatchObject({ AGGREGATE_KEYS: key, OWN_FIGURES: `${key}=kanon`, INVOKER_KEYS: key });
    const quiet = render({ ...register, repositories: [{ key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'] }] }, { gh }).template;
    expect(quiet.Resources.AggregateFunction.Properties.Environment.Variables).toMatchObject({ AGGREGATE_KEYS: 'k1', OWN_FIGURES: '', INVOKER_KEYS: '' });
    expect(Object.keys(quiet.Resources).filter((n) => n.startsWith('AggregateInvoker') || n.startsWith('AggregateUrlPermission'))).toEqual([]);
  });
  it('an invoker role trusts only its repository\'s default-branch ref, and may only call the aggregate URL', () => {
    expect(invoker.RoleName).toBe(`kanon-telemetry-${key}-aggregates`);
    const trust = statements(invoker.AssumeRolePolicyDocument);
    expect(trust).toHaveLength(1);
    expect(trust[0].Condition.StringEquals['token.actions.githubusercontent.com:sub']).toBe(`repo:${repo}:ref:refs/heads/main`);
    const s = statements(invoker.Policies[0].PolicyDocument);
    expect(s.map((x) => x.Action)).toEqual(['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction']);
    expect(s[1].Condition).toEqual({ Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } });
    expect(s.every((x) => x.Resource['Fn::GetAtt'][0] === 'AggregateFunction')).toBe(true);
    expect(R[`AggregateUrlPermission${id}`]!.Properties).toEqual({
      FunctionName: { Ref: 'AggregateFunction' }, Action: 'lambda:InvokeFunctionUrl',
      Principal: { 'Fn::GetAtt': [`AggregateInvokerRole${id}`, 'Arn'] }, FunctionUrlAuthType: 'AWS_IAM',
    });
  });
  it('no writer or reader may call the aggregate URL, and no invoker the ingest URL', () => {
    for (const [, p] of byType('AWS::Lambda::Permission')) {
      if (p.Properties.Principal === '*') continue; // the `live` alias's URL, held above
      const principal = p.Properties.Principal['Fn::GetAtt'][0] as string;
      expect(p.Properties.FunctionName.Ref).toBe(principal.startsWith('AggregateInvokerRole') ? 'AggregateFunction' : 'IngestFunction');
    }
  });
  it('its token URL is on its own alias, `live`, which the handler tells apart by the invoked ARN (plan 0008 §9, J4)', () => {
    expect(R.AggregateLiveAlias).toEqual({
      Type: 'AWS::Lambda::Alias',
      Properties: { FunctionName: { Ref: 'AggregateFunction' }, FunctionVersion: '$LATEST', Name: TOKEN_ALIAS },
    });
    expect(R.AggregateLiveUrl!.Properties).toEqual({ TargetFunctionArn: { 'Fn::GetAtt': ['AggregateFunction', 'Arn'] }, Qualifier: TOKEN_ALIAS, AuthType: 'NONE' });
    expect(template.Outputs.AggregateTokenUrl).toEqual({ Value: { 'Fn::GetAtt': ['AggregateLiveUrl', 'FunctionUrl'] } });
    // Its IAM URL stays on the unqualified function for the overlap, and no invoker reaches the alias.
    expect(R.AggregateUrl!.Properties.Qualifier).toBeUndefined();
    expect(JSON.stringify(invoker.Policies)).not.toContain('AggregateLiveAlias');
  });
  it('is told the same audience, version floor and register table as the ingest function, and its public URL is bounded by a reservation (plan 0008 §12)', () => {
    expect(fn.Environment.Variables).toMatchObject({
      AUDIENCE: { Ref: 'Audience' }, MIN_TOKEN_VERSION: { Ref: 'MinTokenVersion' }, REGISTER_TABLE: REGISTER_TABLE,
    });
    // One definition of each, shared with the ingest function (J3): the floor's default, empty, admits no token.
    expect(template.Parameters.MinTokenVersion.Default).toBe('');
    expect(fn.ReservedConcurrentExecutions).toEqual(R.IngestFunction!.Properties.ReservedConcurrentExecutions);
  });
});

describe('the region and the cost (§5, §9)', () => {
  it('the template refuses any region but eu-central-1', () => {
    expect(template.Rules.Frankfurt.Assertions[0].Assert).toEqual({ 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'eu-central-1'] });
  });
  it('creates only resource types inside plan 0002 §9\'s estimate', () => {
    const allowed = new Set(['AWS::DynamoDB::Table', 'AWS::IAM::Role', 'AWS::IAM::OIDCProvider', 'AWS::Lambda::Function',
      'AWS::Lambda::Url', 'AWS::Lambda::Permission', 'AWS::Logs::LogGroup', 'AWS::Lambda::Alias']);
    expect(Object.values(R).map((r) => r.Type).filter((t) => !allowed.has(t))).toEqual([]);
  });
  it('the static template parses as plain YAML, with no short-form tags', () => {
    expect(readFileSync(TEMPLATE_PATH, 'utf8')).not.toMatch(/!(Ref|GetAtt|Sub|If|Equals|Not)\b/);
    expect(parse(readFileSync(TEMPLATE_PATH, 'utf8')).Resources.Table).toBeDefined();
  });
});

describe('the register (§5)', () => {
  it('renders the parameters the deploy takes', () => {
    expect(parameters).toEqual([
      `OwnerPrincipalArn=${register.owner_principal_arn}`, 'CreateOidcProvider=true', 'ReservedConcurrency=0',
      'EnableVerify=false', 'EnableImporter=false', 'EnableBackfill=false',
    ]);
    expect(render(register, { verify: true, importer: true, backfill: true, gh }).parameters.slice(3))
      .toEqual(['EnableVerify=true', 'EnableImporter=true', 'EnableBackfill=true']);
  });
  it("writes OperatorJobRoleArns only when given, as role ARNs, so a later deploy without it keeps the stack's value (plan 0008 §5.3)", () => {
    const a = `arn:aws:iam::${'1'.repeat(12)}:role/ops-job-a`;
    const b = `arn:aws:iam::${'1'.repeat(12)}:role/ops-job-b`;
    expect(parameters.some((p: string) => p.startsWith('OperatorJobRoleArns='))).toBe(false);
    expect(render(register, { operatorJobRoles: `${a},${b}`, gh }).parameters.at(-1)).toBe(`OperatorJobRoleArns=${a},${b}`);
    for (const bad of ['', `${a},`, 'arn:aws:iam::*:role/x', `${a},arn:aws:sts::${'1'.repeat(12)}:assumed-role/x/y`]) {
      expect(() => render(register, { operatorJobRoles: bad, gh }), bad).toThrow(/--operator-job-roles must list role ARNs/);
    }
  });
  it('the example names only Kanon', () => {
    expect(example.repositories.map((r: { repository: string }) => r.repository)).toEqual(['yedeya-labs/kanon']);
  });
  it('rejects a register that would widen a trust or clash', () => {
    const one = (r: object) => registerProblems({ ...register, repositories: [{ key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'], ...r }] });
    expect(one({})).toEqual([]);
    expect(one({ repository: 'o/*' })).not.toEqual([]);
    expect(one({ repository: 'o' })).not.toEqual([]);
    expect(one({ key: 'K#1' })).not.toEqual([]);
    expect(one({ key: 'a'.repeat(33) })).not.toEqual([]);
    expect(one({ readers: ['environment:*'] })).not.toEqual([]);
    expect(one({ readers: ['environment:qa'] })).not.toEqual([]);
    expect(one({ readers: ['ref:refs/heads/main', 'environment:kanon-telemetry'] })).not.toEqual([]);
    expect(one({ writer_subjects: [] })).not.toEqual([]);
    expect(one({ reader_subjects: 'repo:o/r:ref:refs/heads/main' })).not.toEqual([]);
    expect(one({ readers: undefined, reader_subjects: ['repo:o/r:ref:refs/heads/main'] })).toEqual([]);
    expect(one({ reader_subjects: ['repo:o/r:ref:refs/heads/main'] })).toEqual(['repositories[0] gives both readers and reader_subjects']);
    expect(one({ readers: ['pull_request'] })).not.toEqual([]);
    expect(one({ readers: [] })).not.toEqual([]);
    const dup = { key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'] };
    expect(registerProblems({ ...register, repositories: [dup, { ...dup, repository: 'o/s' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, repositories: [dup, { ...dup, key: 'k2' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, repositories: [{ ...dup, key: 'k-1' }, { ...dup, key: 'k1', repository: 'o/s' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, owner_principal_arn: 'arn:aws:iam::*:role/x' })).not.toEqual([]);
    // §6.1: a label for an adopter's own figures is a label, never a key, and unique; the
    // invoker flag is a boolean.
    expect(one({ publish_own_figures_as: 'kanon' })).toEqual([]);
    expect(one({ publish_own_figures_as: 'k1' })).toEqual(['repositories[0].publish_own_figures_as is a key']);
    expect(one({ publish_own_figures_as: 'Kanon!' })).toEqual(['repositories[0].publish_own_figures_as is not a label']);
    expect(one({ publish_own_figures_as: true })).toEqual(['repositories[0].publish_own_figures_as is not a label']);
    expect(registerProblems({ ...register, repositories: [{ ...dup, publish_own_figures_as: 'x' }, { ...dup, key: 'k2', repository: 'o/s', publish_own_figures_as: 'x' }] }))
      .toEqual(['repositories[1].publish_own_figures_as duplicates another label']);
    expect(registerProblems({ ...register, repositories: [{ ...dup, publish_own_figures_as: 'k2' }, { ...dup, key: 'k2', repository: 'o/s' }] }))
      .toEqual(['repositories[0].publish_own_figures_as is a key']);
    expect(one({ aggregate_invoker: true })).toEqual([]);
    expect(one({ aggregate_invoker: 'yes' })).toEqual(['repositories[0].aggregate_invoker is not true or false']);
    expect(() => render({ ...register, repositories: [] }, { gh })).toThrow(/register/);
  });

  it('holds the time to first review for 13 months after its review row, and no longer (decision 18)', () => {
    const now = Date.parse('2027-11-02T12:00:00Z');
    const one = (first_review: unknown) => registerProblems({ ...register, repositories: [{ key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'], first_review }] }, now);
    expect(one({ minutes: 95, review_recorded_at: '2026-10-02T12:00:01Z' })).toEqual([]);
    // A lane-written row's recorded_at has milliseconds, and the runbook says to copy it as it is.
    expect(one({ minutes: 95, review_recorded_at: '2026-10-02T12:00:00.123Z' })).toEqual([]);
    expect(one({ minutes: 95, review_recorded_at: '2026-10-02T12:00:00.000Z' })).toEqual(['repositories[0].first_review is past its 13 months (decision 18): remove it']);
    expect(one({ minutes: 95, review_recorded_at: '2026-10-02T12:00:00Z' })).toEqual(['repositories[0].first_review is past its 13 months (decision 18): remove it']);
    expect(one({ minutes: 95, review_recorded_at: '2026-09-01T00:00:00Z' })).toEqual(['repositories[0].first_review is past its 13 months (decision 18): remove it']);
    for (const bad of [{ minutes: -1, review_recorded_at: '2027-01-01T00:00:00Z' }, { minutes: 1.5, review_recorded_at: '2027-01-01T00:00:00Z' }, { minutes: 5 }, { minutes: 5, review_recorded_at: 'yesterday' }, 7]) {
      expect(one(bad)).toEqual(['repositories[0].first_review must be { minutes, review_recorded_at }']);
    }
    // An expired value stops the render, and so the deploy.
    const expired = { ...register, repositories: [{ ...register.repositories[0], first_review: { minutes: 1, review_recorded_at: '2026-09-01T00:00:00Z' } }] };
    expect(() => render(expired, { gh, now })).toThrow(/first_review is past/);
  });
});

describe('the subjects come from GitHub, in the form each repository issues (§3)', () => {
  const sub = (role: Res) => statements(role.Properties.AssumeRolePolicyDocument)[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'];
  const entry = { key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/trunk'] };
  const immutable = { use_default: true, use_immutable_subject: true, sub_claim_prefix: 'repo:o@11/r@22' };
  const one = (repo: Repo, e: object = {}) => render({ ...register, repositories: [{ ...entry, ...e }] }, { gh: fakeGh({ 'o/r': repo }) });

  it('a classic repository gets repo:<owner>/<repo>, on the default branch GitHub reports', () => {
    const { template: t } = one({ default_branch: 'trunk' });
    expect(sub(t.Resources.WriterRolek1)).toBe('repo:o/r:ref:refs/heads/trunk');
    expect(sub(t.Resources.ReaderRolek1)).toBe('repo:o/r:ref:refs/heads/trunk');
  });
  it('a repository with an immutable subject gets the prefix GitHub reports, for writer and reader', () => {
    const { template: t } = one({ default_branch: 'trunk', customization: immutable });
    expect(sub(t.Resources.WriterRolek1)).toBe('repo:o@11/r@22:ref:refs/heads/trunk');
    expect(sub(t.Resources.ReaderRolek1)).toBe('repo:o@11/r@22:ref:refs/heads/trunk');
  });
  it('refuses an immutable prefix that is not repo:<owner>@<id>/<repo>@<id>, or names another repository', () => {
    expect(() => one({ customization: { ...immutable, sub_claim_prefix: 'repo:o/r' } })).toThrow(/immutable/);
    expect(() => one({ customization: { ...immutable, sub_claim_prefix: 'repo:x@11/r@22' } })).toThrow(/not a subject of o\/r/);
  });
  it('refuses a custom subject template unless the entry names the exact subjects', () => {
    const custom = { use_default: false, include_claim_keys: ['repo', 'context', 'job_workflow_ref'] };
    expect(() => one({ customization: custom })).toThrow(/customizes its OIDC subject/);
    const exact = { writer_subjects: ['repo:o/r:ref:refs/heads/main:job_workflow_ref:o/r/.github/workflows/c.yml@refs/heads/main'], readers: undefined, reader_subjects: ['repo:o/r:ref:refs/heads/main'] };
    expect(sub(one({ customization: custom }, exact).template.Resources.WriterRolek1)).toBe(exact.writer_subjects[0]);
  });
  it('exact subjects pass the same checks: the default branch for the writer, no environment, pull request, pattern or other repository', () => {
    const w = (s: string) => () => one({}, { writer_subjects: [s] });
    expect(w('repo:o/r:ref:refs/heads/main')).not.toThrow();
    expect(w('repo:o@11/r@22:ref:refs/heads/main')).not.toThrow();
    expect(w('repo:o/r:ref:refs/heads/other')).toThrow(/default branch 'main'/);
    expect(w('repo:o/r:environment:kanon-telemetry')).toThrow(/not a branch ref/);
    expect(w('repo:o/r:environment:x:ref:refs/heads/main')).toThrow(/environment or a pull request/);
    expect(w('repo:o/r:pull_request')).toThrow(/not a branch ref/);
    expect(w('repo:o/*:ref:refs/heads/main')).toThrow(/pattern/);
    expect(w('repo:o/x:ref:refs/heads/main')).toThrow(/not a subject of o\/r/);
    expect(w('ref:refs/heads/main')).toThrow(/names no repository/);
    expect(() => one({}, { readers: undefined, reader_subjects: ['repo:o/r:environment:qa'] })).toThrow(/reader/);
    expect(() => one({}, { readers: undefined, reader_subjects: ['repo:o/r:ref:refs/heads/any'] })).not.toThrow();
  });
  it('both forms may be trusted while a repository migrates', () => {
    const both = ['repo:o/r:ref:refs/heads/main', 'repo:o@11/r@22:ref:refs/heads/main'];
    expect(sub(one({}, { writer_subjects: both }).template.Resources.WriterRolek1)).toEqual(both);
  });
  it('a repository GitHub does not answer for stops the render, under its index, never its key', () => {
    expect(() => render({ ...register, repositories: [{ ...entry, repository: 'o/gone' }] }, { gh })).toThrow(/^register: repositories\[0\]: gh: HTTP 404/);
  });
  it('refuses an entry GitHub spells differently: a rename redirect, or another case', () => {
    expect(() => one({ full_name: 'o/renamed' })).toThrow(/GitHub calls o\/r 'o\/renamed'/);
    expect(() => one({ full_name: 'O/r' })).toThrow(/GitHub calls o\/r 'O\/r'/);
  });
  it('refuses a default branch GitHub reports with pattern characters', () => {
    expect(() => one({ default_branch: 'ma*n' })).toThrow(/default branch/);
  });
});

describe('what render.mjs prints names each entry by its repository, never by its key (docs/telemetry.md, kanon#628)', () => {
  // A key no other text holds, so finding it anywhere in the output is the leak.
  const secret = 'kq7x2z9wleak';
  const entries = [
    { key: secret, repository: 'o/r', readers: ['ref:refs/heads/main'], publish_own_figures_as: 'own-label', aggregate_invoker: true },
    { key: 'kother', repository: 'o/s', readers: ['ref:refs/heads/main'] },
  ];
  /** Run the CLI as the Owner does, with `gh` answering for `o/r` and `o/s` only. */
  const run = (repositories: object[] | string) => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-render-'));
    writeStub(join(dir, 'gh'), [
      '#!/usr/bin/env bash',
      'case "$2" in',
      '  repos/o/r|repos/o/s) printf \'{"full_name":"%s","default_branch":"main"}\' "${2#repos/}" ;;',
      '  repos/o/r/actions/oidc/customization/sub|repos/o/s/actions/oidc/customization/sub) echo \'{"use_default":true}\' ;;',
      '  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'));
    const reg = join(dir, 'register.json');
    writeFileSync(reg, typeof repositories === 'string' ? repositories : JSON.stringify({ ...register, repositories }));
    return spawnSync('node', ['infra/telemetry/render.mjs', '--register', reg, '--out', join(dir, 'out')], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  };

  it('prints the subjects the Owner checks, by repository, and no key on stdout or stderr', () => {
    const r = run(entries);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('o/r: writer trusts repo:o/r:ref:refs/heads/main; reader trusts repo:o/r:ref:refs/heads/main\n');
    expect(r.stdout).toContain('o/s: writer trusts repo:o/s:ref:refs/heads/main; reader trusts repo:o/s:ref:refs/heads/main\n');
    expect(r.stdout).toContain('o/r: aggregate invoker trusts repo:o/r:ref:refs/heads/main\n');
    expect(r.stdout).toContain('o/r: own figures publishable as own-label\n');
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toContain('kother');
  });

  it('names a refused entry by its index, never by its key', () => {
    const r = run([entries[0]!, { ...entries[1]!, repository: 'o/gone' }]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^register: repositories\[1\]: /m);
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toContain('kother');
  });

  it('a register that is not JSON is refused without quoting it', () => {
    // Unquoted, so JSON.parse's own message would quote the text around it, the key's start.
    const r = run(`{ "repositories": [{ "key": ${secret} }] }`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not JSON/);
    expect(r.stdout + r.stderr).not.toContain(secret.slice(0, 8));
  });
});

describe('the register and what is rendered from it never live in a repository where Kanon\'s lanes run (docs/telemetry.md, kanon#629)', () => {
  // A private repository that adopts Kanon is no safer than a public one: the Reviewer's model
  // reads a pull request's diff, and the lanes' agents read any file in their checkout.
  const doc = readFileSync('docs/telemetry.md', 'utf8');
  const section = (heading: string) => (doc.split(`\n${heading}\n`)[1] ?? '').split('\n## ')[0]!;

  it('says where the register belongs, public or private, and why', () => {
    const where = section('## Where the register lives');
    expect(where).toMatch(/never lives in a repository where Kanon's lanes run, public or private/);
    expect(where).toMatch(/Reviewer's model/);
    expect(where).toMatch(/any file in their checkout/);
  });

  it('names the safe places: an untracked file, a repository with no Kanon lanes, a secrets store', () => {
    const where = section('## Where the register lives');
    expect(where).toMatch(/\*\*An untracked file\*\*/);
    expect(where).toMatch(/\*\*A repository with no Kanon lanes\*\*/);
    expect(where).toMatch(/\*\*A secrets store\*\*/);
  });

  it('says what to do with a register already tracked in an adopting repository', () => {
    expect(section('## Where the register lives')).toMatch(/\*\*If a register is already tracked in a repository where Kanon's lanes run,\*\*/);
  });

  it('holds the rendered template.json and parameters.json to the same rule', () => {
    expect(section('## Where the register lives')).toMatch(/`template\.json` and `parameters\.json`/);
    expect(section('## Deploy')).toMatch(/\[Where the register lives\]\(#where-the-register-lives\)/);
    // The header comment wraps, so a line break and its `//` may fall between any two words.
    expect(readFileSync('infra/telemetry/render.mjs', 'utf8').replace(/\n\/\/ ?/g, ' ')).toMatch(/never in a repository where Kanon's lanes run, public or private/);
  });

  it('points the first-deploy and add-a-repository steps at it', () => {
    expect(section('## Before the first deploy')).toMatch(/^1\. \*\*Keep the register out of every repository where Kanon's lanes run\*\* \(\[Where the register lives\]\(#where-the-register-lives\)\)/m);
    expect(section('## Add a repository')).toMatch(/^1\. Add an entry to the register, where \[it lives\]\(#where-the-register-lives\):/m);
  });
});
