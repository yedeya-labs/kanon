import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { FUNCTION_DIR, registerProblems, render, TEMPLATE_PATH } from '../../infra/telemetry/render.mjs';

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
const { template, parameters } = render(register);
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
  it('its resource policy denies every write to all but the function and the Owner (§4)', () => {
    const [deny, ...rest] = statements(table.Properties.ResourcePolicy.PolicyDocument);
    expect(rest).toEqual([]);
    expect(deny).toMatchObject({ Effect: 'Deny', Principal: '*' });
    expect([...deny.Action].sort()).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(deny.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': [{ 'Fn::GetAtt': ['IngestRole', 'Arn'] }, { Ref: 'OwnerPrincipalArn' }] } });
  });
});

describe('the ingest function and its URL (§4)', () => {
  const fn = R.IngestFunction!.Properties;
  it('the URL is IAM-authenticated, and is the only one', () => {
    expect(byType('AWS::Lambda::Url').map(([, r]) => r.Properties.AuthType)).toEqual(['AWS_IAM']);
  });
  it('no permission is public, and each is held to IAM auth', () => {
    for (const [, p] of byType('AWS::Lambda::Permission')) {
      expect(p.Properties.Principal).not.toBe('*');
      expect(p.Properties.FunctionUrlAuthType).toBe('AWS_IAM');
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
});

describe('the code that is packaged (§5)', () => {
  it('is the function directory, and its schema module IS the lanes\' schema module', () => {
    expect(R.IngestFunction!.Properties.Code).toBe(FUNCTION_DIR);
    expect(lstatSync(join(FUNCTION_DIR, 'schema.mjs')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(FUNCTION_DIR, 'schema.mjs'))).toBe(realpathSync('actions/agent-telemetry/schema.mjs'));
  });
  it('imports nothing but node: built-ins and its own files', () => {
    for (const f of readdirSync(FUNCTION_DIR)) {
      const specs = [...readFileSync(join(FUNCTION_DIR, f), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]!);
      for (const s of specs) expect(s, `${f} imports ${s}`).toMatch(/^(node:|\.\/[a-z0-9]+\.mjs$)/);
    }
  });
});

describe('the roles (§3, §6, §7)', () => {
  const writer = R[`WriterRole${id}`]!.Properties;
  const reader = R[`ReaderRole${id}`]!.Properties;
  const oidc = (role: Record<string, J>) => statements(role.AssumeRolePolicyDocument)[0];

  it('the writer trusts only the kanon-telemetry environment of its repository', () => {
    expect(writer.RoleName).toBe(`kanon-telemetry-${key}-writer`);
    expect(oidc(writer).Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(oidc(writer).Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${repo}:environment:kanon-telemetry`,
      },
    });
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
    const two = render({ ...register, repositories: [{ key: 'k2', repository: 'o/r', readers: ['ref:refs/heads/main', 'environment:qa'] }] });
    const s = statements((two.template.Resources.ReaderRolek2 as Res).Properties.AssumeRolePolicyDocument)[0];
    expect(s.Condition.StringEquals['token.actions.githubusercontent.com:sub']).toEqual(['repo:o/r:ref:refs/heads/main', 'repo:o/r:environment:qa']);
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

describe('the region and the cost (§5, §9)', () => {
  it('the template refuses any region but eu-central-1', () => {
    expect(template.Rules.Frankfurt.Assertions[0].Assert).toEqual({ 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'eu-central-1'] });
  });
  it('creates only resource types inside plan 0002 §9\'s estimate', () => {
    const allowed = new Set(['AWS::DynamoDB::Table', 'AWS::IAM::Role', 'AWS::IAM::OIDCProvider', 'AWS::Lambda::Function',
      'AWS::Lambda::Url', 'AWS::Lambda::Permission', 'AWS::Logs::LogGroup']);
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
    expect(render(register, { verify: true, importer: true, backfill: true }).parameters.slice(3))
      .toEqual(['EnableVerify=true', 'EnableImporter=true', 'EnableBackfill=true']);
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
    expect(one({ readers: ['pull_request'] })).not.toEqual([]);
    expect(one({ readers: [] })).not.toEqual([]);
    const dup = { key: 'k1', repository: 'o/r', readers: ['ref:refs/heads/main'] };
    expect(registerProblems({ ...register, repositories: [dup, { ...dup, repository: 'o/s' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, repositories: [dup, { ...dup, key: 'k2' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, repositories: [{ ...dup, key: 'k-1' }, { ...dup, key: 'k1', repository: 'o/s' }] })).not.toEqual([]);
    expect(registerProblems({ ...register, owner_principal_arn: 'arn:aws:iam::*:role/x' })).not.toEqual([]);
    expect(() => render({ ...register, repositories: [] })).toThrow(/register/);
  });
});
