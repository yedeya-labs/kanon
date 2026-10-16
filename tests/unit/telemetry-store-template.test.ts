import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { registerProblems } from '../../infra/telemetry/register-file.mjs';
import { ATTRIBUTES, TOKEN_ALIAS } from '../../infra/telemetry/function/aggregate.mjs';
import { BACKFILL, IMPORT } from '../../infra/telemetry/function/index.mjs';
import {
  AGGREGATE_GET, AGGREGATE_SCAN, FUNCTION_FIELDS, INGEST_SCAN, KEY_ITEM_PREFIX, OPERATOR_FIELDS, REGISTER_TABLE, REGISTRATION_PREFIX,
  TOMBSTONE_FIELDS,
} from '../../infra/telemetry/function/register-fields.mjs';

/**
 * Plan 0002 step S3 and plan 0008: the store's CloudFormation template, as it is deployed, with
 * account-level parameters alone (plan 0008 J9: no render, no register material). Parsed, never
 * deployed: every property §3 to §5, §7, §9 and §10 rely on is asserted here, so a change that
 * drops one is red without AWS.
 */

// The template is untyped YAML, read by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Res = { Type: string, Condition?: string, DeletionPolicy?: string, UpdateReplacePolicy?: string, Properties: Record<string, J> };

const TEMPLATE_PATH = 'infra/telemetry/template.yaml';
const FUNCTION_DIR = 'infra/telemetry/function';
const template = parse(readFileSync(TEMPLATE_PATH, 'utf8'));
const R = template.Resources as Record<string, Res>;
const byType = (t: string) => Object.entries(R).filter(([, r]) => r.Type === t);
const statements = (doc: J): J[] => doc.Statement;
/** GitHub's OIDC issuer, which a role trusting GitHub names. */
const OIDC_HOST = 'token.actions.githubusercontent.com';

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
  it("the only URLs are each function's `live` alias's, with no IAM auth: no `AWS_IAM` URL is left (plan 0008 §9, J9)", () => {
    expect(byType('AWS::Lambda::Url').map(([name, r]) => [name, r.Properties.AuthType, r.Properties.Qualifier])).toEqual([
      ['IngestLiveUrl', 'NONE', 'live'], ['AggregateLiveUrl', 'NONE', TOKEN_ALIAS],
    ]);
    for (const [name, r] of byType('AWS::Lambda::Url')) expect(r.Properties.AuthType, name).not.toBe('AWS_IAM');
    expect(R.IngestLiveUrl!.Properties.TargetFunctionArn).toEqual({ 'Fn::GetAtt': ['IngestFunction', 'Arn'] });
    expect(Object.keys(template.Outputs).sort()).toEqual(['AggregateTokenUrl', 'IngestTokenUrl', 'RegisterTableName', 'TableName']);
  });
  it("the aliases are `live` and `erase`, the Owner's `import` and `backfill` behind their parameters, and the aggregate function's `live`, all on $LATEST; no URL serves any but `live`", () => {
    expect(byType('AWS::Lambda::Alias').map(([name, r]) => [name, r.Properties.Name, r.Properties.FunctionVersion, r.Properties.FunctionName, r.Condition])).toEqual([
      ['IngestLiveAlias', 'live', '$LATEST', { Ref: 'IngestFunction' }, undefined], ['IngestEraseAlias', 'erase', '$LATEST', { Ref: 'IngestFunction' }, undefined],
      ['IngestImportAlias', IMPORT, '$LATEST', { Ref: 'IngestFunction' }, 'ImporterOn'], ['IngestBackfillAlias', BACKFILL, '$LATEST', { Ref: 'IngestFunction' }, 'BackfillOn'],
      ['AggregateLiveAlias', TOKEN_ALIAS, '$LATEST', { Ref: 'AggregateFunction' }, undefined],
    ]);
  });
  it("the only permissions are the two `live` aliases' public ones, through their URLs", () => {
    expect(byType('AWS::Lambda::Permission').map(([name, p]) => [name, p.Properties])).toEqual([
      ['IngestLiveUrlPermission', { FunctionName: { Ref: 'IngestLiveAlias' }, Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' }],
      ['IngestLiveInvokePermission', { FunctionName: { Ref: 'IngestLiveAlias' }, Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true }],
      ['AggregateLiveUrlPermission', { FunctionName: { Ref: 'AggregateLiveAlias' }, Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' }],
      ['AggregateLiveInvokePermission', { FunctionName: { Ref: 'AggregateLiveAlias' }, Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true }],
    ]);
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
  it('is told no key, no repository and no role name: neither function has a per-key environment (plan 0008 J9)', () => {
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual(['ACCOUNT_ID', 'AUDIENCE', 'CURSOR_KEY', 'MIN_TOKEN_VERSION', 'REGISTER_TABLE', 'SELF_READ_ROLE', 'TABLE_NAME']);
    expect(Object.keys(R.AggregateFunction!.Properties.Environment.Variables).sort()).toEqual(['ACCOUNT_ID', 'AUDIENCE', 'MIN_TOKEN_VERSION', 'REGISTER_TABLE', 'TABLE_NAME']);
    for (const name of ['WRITER_KEYS', 'NAME_HASHES', 'IMPORTER_ROLE', 'BACKFILL_ROLE', 'AGGREGATE_KEYS', 'OWN_FIGURES', 'INVOKER_KEYS']) {
      expect(readFileSync(TEMPLATE_PATH, 'utf8'), name).not.toContain(name);
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
});

describe('the code that is packaged (§5)', () => {
  it('is the function directory beside the template, and its schema module IS the lanes\' schema module', () => {
    // `aws cloudformation package` resolves a local path against the template's own directory.
    expect(R.IngestFunction!.Properties.Code).toBe('function');
    expect(join(dirname(TEMPLATE_PATH), R.IngestFunction!.Properties.Code)).toBe(FUNCTION_DIR);
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
  it('its key-in-text check IS the #41 job\'s and Jev\'s, linked like the schema (#737)', () => {
    expect(lstatSync(join(FUNCTION_DIR, 'holds-key.mjs')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(FUNCTION_DIR, 'holds-key.mjs'))).toBe(realpathSync('scripts/telemetry/holds-key.mjs'));
    for (const f of [join(FUNCTION_DIR, 'rows.mjs'), 'scripts/telemetry/kanon-findings.mjs', 'scripts/telemetry/jev.mjs']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/^import \{ holdsKey \} from '\.\/holds-key\.mjs';$/m);
      expect(src, `${f} defines a key check of its own`).not.toMatch(/(?:function|const) holdsKey\b/);
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
  /** Whether a trust statement names GitHub's OIDC provider, however it is spelled. */
  const trustsGitHub = (statement: J) => JSON.stringify(statement).includes(OIDC_HOST) || JSON.stringify(statement).includes('OidcProvider')
    || JSON.stringify(statement).includes('AssumeRoleWithWebIdentity');

  it("no role trusts GitHub's OIDC provider: GitHub can assume none of them (plan 0008 J9)", () => {
    const roles = byType('AWS::IAM::Role');
    expect(roles.map(([name]) => name)).toEqual(['IngestRole', 'SelfReadRole', 'ImporterRole', 'BackfillRole', 'VerifyProbeRole', 'AggregateRole']);
    for (const [name, r] of roles) {
      for (const st of statements(r.Properties.AssumeRolePolicyDocument)) expect(trustsGitHub(st), name).toBe(false);
    }
    // The guard sees the old writer's trust, as render.mjs wrote it.
    const writer = { Effect: 'Allow', Principal: { Federated: { 'Fn::If': ['CreateOidc', { Ref: 'OidcProvider' }, { 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:oidc-provider/${OIDC_HOST}` }] } }, Action: 'sts:AssumeRoleWithWebIdentity' };
    expect(trustsGitHub(writer)).toBe(true);
  });
  it('no trust condition is a pattern', () => {
    for (const [, r] of byType('AWS::IAM::Role')) {
      for (const st of statements(r.Properties.AssumeRolePolicyDocument)) {
        expect(Object.keys(st.Condition ?? {}).filter((k) => /Like/.test(k))).toEqual([]);
      }
    }
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
  it('each may invoke its own alias directly, and nothing else: not the function, not the other alias, not a URL (plan 0008 §9)', () => {
    for (const [name, alias] of [['ImporterRole', IMPORT], ['BackfillRole', BACKFILL]] as const) {
      const policies = R[name]!.Properties.Policies;
      expect(policies, name).toHaveLength(1);
      expect(statements(policies[0].PolicyDocument), name).toEqual([{
        Effect: 'Allow', Action: 'lambda:InvokeFunction',
        Resource: { 'Fn::Sub': `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:kanon-telemetry-ingest:${alias}` },
      }]);
    }
  });
  it('the write probe exists only while EnableVerify is on, for the Owner only, allowed exactly the denied writes (kanon#101)', () => {
    const probe = R.VerifyProbeRole!;
    expect(probe.Condition).toBe('VerifyOn');
    expect(template.Parameters.EnableVerify.Default).toBe('false');
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
    // only that deny can refuse the probe, which is what verify.mjs's probe check needs.
    const deny = statements(R.Table!.Properties.ResourcePolicy.PolicyDocument)[0];
    expect([...allow.Action].sort()).toEqual([...deny.Action].sort());
    expect(allow.Resource).toEqual(deny.Resource);
    // And the deny's exceptions don't name it.
    expect(JSON.stringify(deny.Condition)).not.toContain('VerifyProbeRole');
  });
  it('the OIDC provider is created only when the parameter says so, and retained if it is ever removed, since roles outside the stack may trust it', () => {
    expect(R.OidcProvider!.Condition).toBe('CreateOidc');
    expect(template.Parameters.CreateOidcProvider.Default).toBe('true');
    expect(R.OidcProvider!.DeletionPolicy).toBe('Retain');
    expect(R.OidcProvider!.UpdateReplacePolicy).toBe('Retain');
  });
});

describe('the permissions boundary (plan 0010 decision 15, D11)', () => {
  const roles = byType('AWS::IAM::Role');
  const boundaryRef = { Ref: 'PermissionsBoundaryArn' };
  /** The role's PermissionsBoundary as CloudFormation resolves it, with HasPermissionsBoundary given. */
  const resolved = (r: Res, has: boolean): J => {
    if (!('PermissionsBoundary' in r.Properties)) return undefined;
    const v = r.Properties.PermissionsBoundary;
    if (v && typeof v === 'object' && 'Fn::If' in v && v['Fn::If'][0] === 'HasPermissionsBoundary') {
      const picked = v['Fn::If'][has ? 1 : 2];
      return JSON.stringify(picked) === JSON.stringify({ Ref: 'AWS::NoValue' }) ? undefined : picked;
    }
    return v;
  };
  /** Every place the template names the parameter or its condition, in its resources and outputs. */
  const uses = (t: J): string[] => {
    const at: string[] = [];
    const walk = (v: J, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      else if (v === 'PermissionsBoundaryArn' || v === 'HasPermissionsBoundary') at.push(path);
    };
    walk(t.Resources, 'Resources');
    walk(t.Outputs, 'Outputs');
    return at.sort();
  };
  const onBoundariesOnly = (rs: [string, Res][]) => rs.flatMap(([name]) => [
    `Resources.${name}.Properties.PermissionsBoundary.Fn::If[0]`,
    `Resources.${name}.Properties.PermissionsBoundary.Fn::If[1].Ref`,
  ]).sort();

  it('is an optional parameter, empty by default, which only an IAM policy ARN fills', () => {
    const p = template.Parameters.PermissionsBoundaryArn;
    expect(p).toMatchObject({ Type: 'String', Default: '' });
    const re = new RegExp(p.AllowedPattern);
    expect(re.test('')).toBe(true);
    expect(re.test(`arn:aws:iam::${'1'.repeat(12)}:policy/kanon-deploy-boundary`)).toBe(true);
    expect(re.test(`arn:aws:iam::${'1'.repeat(12)}:role/kanon-deploy-boundary`)).toBe(false);
    expect(template.Conditions.HasPermissionsBoundary).toEqual({ 'Fn::Not': [{ 'Fn::Equals': [boundaryRef, ''] }] });
  });
  it('the template holds six roles, and no per-repository one (plan 0008 J9)', () => {
    expect(roles.length).toBe(6);
  });
  it('with the parameter, every role carries it', () => {
    for (const [name, r] of roles) expect(resolved(r, true), name).toEqual(boundaryRef);
  });
  it('without it, no role carries a boundary', () => {
    for (const [name, r] of roles) expect(resolved(r, false), name).toBeUndefined();
  });
  it('the parameter and its condition are used on the roles\' boundaries alone, so the template is otherwise unchanged', () => {
    expect(uses(template)).toEqual(onBoundariesOnly(roles));
  });
});

describe('the aggregate-only function (§6.1, decided by the Owner 2026-10-07)', () => {
  const fn = R.AggregateFunction!.Properties;
  const role = R.AggregateRole!.Properties;
  it('runs the aggregate module from the same package as the ingest function', () => {
    expect(fn.Handler).toBe('aggregate.handler');
    expect(fn.Code).toBe(R.IngestFunction!.Properties.Code);
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
  it('its token URL is on its own alias, `live`, which the handler tells apart by the invoked ARN (plan 0008 §9, J4)', () => {
    expect(R.AggregateLiveAlias).toEqual({
      Type: 'AWS::Lambda::Alias',
      Properties: { FunctionName: { Ref: 'AggregateFunction' }, FunctionVersion: '$LATEST', Name: TOKEN_ALIAS },
    });
    expect(R.AggregateLiveUrl!.Properties).toEqual({ TargetFunctionArn: { 'Fn::GetAtt': ['AggregateFunction', 'Arn'] }, Qualifier: TOKEN_ALIAS, AuthType: 'NONE' });
    expect(template.Outputs.AggregateTokenUrl).toEqual({ Value: { 'Fn::GetAtt': ['AggregateLiveUrl', 'FunctionUrl'] } });
    // Its IAM URL and the invoker roles are gone (J9): no role names the aggregate function.
    expect(R.AggregateUrl).toBeUndefined();
    for (const [name, r] of byType('AWS::IAM::Role')) expect(JSON.stringify(r.Properties.Policies ?? []), name).not.toMatch(/AggregateFunction|kanon-telemetry-aggregate\b/);
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

describe("the template's parameters are account-level alone, so a deploy needs no register material (plan 0008 J9, plan 0010 §15.1)", () => {
  it('names no key, no repository and no subject', () => {
    expect(Object.keys(template.Parameters).sort()).toEqual([
      'Audience', 'CreateOidcProvider', 'CursorKey', 'EnableBackfill', 'EnableImporter', 'EnableVerify', 'MinTokenVersion', 'OperatorJobRoleArns',
      'OwnerPrincipalArn', 'PermissionsBoundaryArn', 'ReservedConcurrency',
    ]);
    expect(existsSync('infra/telemetry/render.mjs')).toBe(false);
    expect(existsSync('infra/telemetry/register.example.json')).toBe(false);
  });
  it("the OwnerPrincipalArn pattern refuses more than one role, and what the register file refuses (#798)", () => {
    // CloudFormation's dialect is Java's, which reads `\w` and `(?:…)` as JavaScript does.
    const re = new RegExp(template.Parameters.OwnerPrincipalArn.AllowedPattern as string);
    const acct = `arn:aws:iam::${'1'.repeat(12)}`;
    const owner = `${acct}:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_Admin_ab`;
    const fileOk = (arn: string) => registerProblems({ owner_principal_arn: arn, repositories: [{ key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'] }] }).length === 0;
    const cases = [
      `${acct}:role/*`, `${acct}:role/a?`, `${acct}:role/a,b`, `${acct}:role/a,${acct}:role/b`, `${acct}:role/aws-reserved/*/x`,
      `${acct}:role/`, `${acct}:role/x/`, 'arn:aws:iam::*:role/x', `${acct}:user/x`,
      `${acct}:role/a+b=c.d@e_f-g`, owner, `${acct}:role/x`,
    ];
    for (const arn of cases) expect(re.test(arn), arn).toBe(fileOk(arn));
    for (const bad of [`${acct}:role/*`, `${acct}:role/a?`, `${acct}:role/a,b`]) expect(re.test(bad), bad).toBe(false);
    expect(re.test(owner)).toBe(true);
  });
  it('OperatorJobRoleArns is a list, empty by default, which the register table\'s resource policy lets in when set (plan 0008 §5.3)', () => {
    expect(template.Parameters.OperatorJobRoleArns).toMatchObject({ Type: 'CommaDelimitedList', Default: '' });
    expect(template.Parameters.MinTokenVersion.AllowedPattern).toBe('^$|^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$');
    expect(template.Parameters.CursorKey).toMatchObject({ NoEcho: true, AllowedPattern: '^$|^[0-9a-f]{64}$' });
  });
});

describe('the register file the one-time import reads (plan 0008 §9 step 3, `register.mjs import`)', () => {
  const register = {
    owner_principal_arn: `arn:aws:iam::${'1'.repeat(12)}:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_Admin_ab`,
    repositories: [{ key: 'k3f9c2a71', repository: 'yedeya-labs/kanon', readers: ['ref:refs/heads/main'], publish_own_figures_as: 'kanon', aggregate_invoker: true }],
  };
  it('rejects a register that would clash, or names a key where a label goes', () => {
    expect(registerProblems(register)).toEqual([]);
    const one = (r: object) => registerProblems({ ...register, repositories: [{ key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'], ...r }] });
    expect(one({})).toEqual([]);
    expect(one({ repository: 'o/*' })).not.toEqual([]);
    expect(one({ repository: 'o' })).not.toEqual([]);
    expect(one({ key: 'K#1' })).not.toEqual([]);
    expect(one({ key: 'a'.repeat(33) })).not.toEqual([]);
    expect(one({ readers: ['environment:*'] })).not.toEqual([]);
    expect(one({ writer_subjects: [] })).not.toEqual([]);
    expect(one({ readers: undefined, reader_subjects: ['repo:o/r:ref:refs/heads/main'] })).toEqual([]);
    expect(one({ reader_subjects: ['repo:o/r:ref:refs/heads/main'] })).toEqual(['repositories[0] gives both readers and reader_subjects']);
    const dup = { key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'] };
    expect(registerProblems({ ...register, repositories: [dup, { ...dup, repository: 'o/s' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, repositories: [dup, { ...dup, key: 'k2' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, repositories: [{ ...dup, key: 'k-1' }, { ...dup, key: 'k1', repository: 'o/s' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, repositories: [] })).toEqual(['repositories is empty']);
    expect(one({ publish_own_figures_as: 'kanon' })).toEqual([]);
    expect(one({ publish_own_figures_as: 'k1' })).toEqual(['repositories[0].publish_own_figures_as is a key']);
    expect(one({ publish_own_figures_as: 'Kanon!' })).toEqual(['repositories[0].publish_own_figures_as is not a label']);
    expect(registerProblems({ ...register, repositories: [{ ...dup, publish_own_figures_as: 'x' }, { ...dup, key: 'k2', repository: 'o/s', publish_own_figures_as: 'x' }] }))
      .toEqual(['repositories[1].publish_own_figures_as duplicates another label']);
    expect(one({ aggregate_invoker: 'yes' })).toEqual(['repositories[0].aggregate_invoker is not true or false']);
    // A refusal names the entry by its index, never its key.
    expect(JSON.stringify(one({ key: 'Kq7x!', publish_own_figures_as: 'Kq7x!' }))).not.toContain('Kq7x');
  });
  it('holds the time to first review for 13 months after its review row, and no longer (decision 18)', () => {
    const now = Date.parse('2027-11-02T12:00:00Z');
    const one = (first_review: unknown) => registerProblems({ ...register, repositories: [{ key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'], first_review }] }, now);
    expect(one({ minutes: 95, review_recorded_at: '2026-10-02T12:00:01Z' })).toEqual([]);
    // A lane-written row's recorded_at has milliseconds, and the runbook says to copy it as it is.
    expect(one({ minutes: 95, review_recorded_at: '2026-10-02T12:00:00.123Z' })).toEqual([]);
    expect(one({ minutes: 95, review_recorded_at: '2026-10-02T12:00:00.000Z' })).toEqual(['repositories[0].first_review is past its 13 months (decision 18): remove it']);
    expect(one({ minutes: 95, review_recorded_at: '2026-09-01T00:00:00Z' })).toEqual(['repositories[0].first_review is past its 13 months (decision 18): remove it']);
    for (const bad of [{ minutes: -1, review_recorded_at: '2027-01-01T00:00:00Z' }, { minutes: 5 }, { minutes: 5, review_recorded_at: 'yesterday' }, 7]) {
      expect(one(bad)).toEqual(['repositories[0].first_review must be { minutes, review_recorded_at }']);
    }
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
  });

  // The add-a-repository step that pointed at it went with the SigV4 path's register entries (J9).
  it('points the first-deploy step at it', () => {
    expect(section('## Before the first deploy')).toMatch(/^1\. \*\*Keep the register out of every repository where Kanon's lanes run\*\* \(\[Where the register lives\]\(#where-the-register-lives\)\)/m);
  });
});
