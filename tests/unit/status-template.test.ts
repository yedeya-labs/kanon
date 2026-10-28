import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENV } from '../../infra/status/function/handler.mjs';

/**
 * Project #1327, Issue I: the hosted status server's CloudFormation template,
 * `infra/status/template.yaml`, parsed and never deployed. The resource types it may create are
 * exactly the list below (`[MCP-10]`), so a new resource, a table or a bucket above all, is red
 * here before it reaches AWS. Beside that list, what the Owner answered on the issue on
 * 2026-10-26: the function's reserved concurrency, always set and 4 by default; its log group kept
 * 30 days; a role that may write its log and read the one secret parameter, and nothing else; and
 * a key only that role can seal with, under `seal.mjs`'s encryption context, deleted with the
 * stack and not rotated.
 */

// The template is untyped YAML, read by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Res = { Type: string, DependsOn?: string, DeletionPolicy?: string, UpdateReplacePolicy?: string, Properties: Record<string, J> };

const text = readFileSync('infra/status/template.yaml', 'utf8');
const template = parse(text) as J;
const R = template.Resources as Record<string, Res>;
const P = template.Parameters as Record<string, J>;
const byType = (t: string) => Object.entries(R).filter(([, r]) => r.Type === t).map(([, r]) => r);
const fn = R.StatusFunction!;
const role = R.StatusRole!;
const key = R.StatusKey!;
const statements = (r: Res): J[] => r.Properties.Policies.flatMap((p: J) => p.PolicyDocument.Statement);

/** The resource types the hosted server's stack creates, each once but the URL's two grants. */
const TYPES = {
  'AWS::Lambda::Function': 1,
  'AWS::Lambda::Url': 1,
  'AWS::Lambda::Permission': 2,
  'AWS::IAM::Role': 1,
  'AWS::Logs::LogGroup': 1,
  'AWS::KMS::Key': 1,
};

describe("the hosted status server's template", () => {
  it('[MCP-10] creates only the resource types its test lists, sets the function\'s reserved concurrency, and creates no table and no bucket', () => {
    const counts: Record<string, number> = {};
    for (const r of Object.values(R)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
    expect(counts).toEqual(TYPES);
    expect(Object.values(R).filter((r) => /^AWS::(DynamoDB|S3)::/.test(r.Type))).toEqual([]);
    // Always set, from a parameter that can't be 0: no condition drops it, as the telemetry
    // template's `HasReservedConcurrency` can.
    expect(fn.Properties.ReservedConcurrentExecutions).toEqual({ Ref: 'ReservedConcurrency' });
    expect(P.ReservedConcurrency).toMatchObject({ Type: 'Number', MinValue: 1, Default: 4 });
    expect(text).not.toMatch(/HasReservedConcurrency/);
  });

  it('is kept in Frankfurt (decision 2)', () => {
    expect(template.Rules.Frankfurt.Assertions[0].Assert).toEqual({ 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'eu-central-1'] });
  });

  it('has the function the Owner sized: 256 MB, 60 s, arm64, Node 24, no VPC, its own log group', () => {
    expect(fn.Properties).toMatchObject({
      FunctionName: 'kanon-status', Runtime: 'nodejs24.x', Architectures: ['arm64'], MemorySize: 256, Timeout: 60,
      Handler: 'infra/status/function/handler.handler', Code: 'function',
      Role: { 'Fn::GetAtt': ['StatusRole', 'Arn'] },
      LoggingConfig: { LogGroup: { Ref: 'StatusLogGroup' }, LogFormat: 'Text' },
    });
    expect(fn.Properties.VpcConfig).toBeUndefined();
    expect(R.StatusLogGroup!.Properties).toEqual({ LogGroupName: '/aws/lambda/kanon-status', RetentionInDays: 30 });
  });

  it("holds the client secret parameter's name, never a secret, in the function's environment", () => {
    const vars = fn.Properties.Environment.Variables as Record<string, J>;
    expect(Object.keys(vars).sort()).toEqual(Object.values(ENV).sort());
    expect(vars[ENV.keyId]).toEqual({ Ref: 'StatusKey' });
    expect(vars[ENV.clientId]).toEqual({ Ref: 'GitHubClientId' });
    expect(vars[ENV.secretParameter]).toEqual({ Ref: 'GitHubClientSecretParameter' });
    expect(vars[ENV.redirects]).toEqual({ Ref: 'Redirects' });
    expect(vars[ENV.release]).toEqual({ Ref: 'Release' });
    expect(vars[ENV.deprecated]).toEqual({ Ref: 'LegacyDeprecatedSince' });
    expect(Object.keys(P).sort()).toEqual(['GitHubClientId', 'GitHubClientSecretParameter', 'LegacyDeprecatedSince', 'PermissionsBoundaryArn', 'Redirects', 'Release', 'ReservedConcurrency']);
    // The deprecation's date has no default: every deploy passes one.
    expect(P.LegacyDeprecatedSince).toMatchObject({ Type: 'String', AllowedPattern: '^\\d{4}-\\d{2}-\\d{2}$' });
    expect(P.LegacyDeprecatedSince).not.toHaveProperty('Default');
    expect(Object.values(P).filter((p: J) => p.NoEcho)).toEqual([]);
    // The parameter is a name under /kanon-status/, which the Owner puts by hand (Q1).
    expect(P.GitHubClientSecretParameter.Default).toBe('/kanon-status/github-client-secret');
    const pattern = new RegExp(P.GitHubClientSecretParameter.AllowedPattern);
    expect(pattern.test('/kanon-status/github-client-secret')).toBe(true);
    for (const other of ['/kanon-telemetry/cursor', 'kanon-status/x', '/kanon-status/../x', '/kanon-status/*']) expect(pattern.test(other), other).toBe(false);
  });

  it('serves a public URL the server authenticates itself, with the two grants it needs and no more', () => {
    expect(R.StatusUrl!.Properties).toEqual({ TargetFunctionArn: { 'Fn::GetAtt': ['StatusFunction', 'Arn'] }, AuthType: 'NONE', InvokeMode: 'BUFFERED' });
    const grants = byType('AWS::Lambda::Permission').map((r) => r.Properties);
    expect(grants).toEqual(expect.arrayContaining([
      { FunctionName: { Ref: 'StatusFunction' }, Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' },
      { FunctionName: { Ref: 'StatusFunction' }, Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true },
    ]));
  });

  it('gives the role two statements: its own log, and the one secret parameter', () => {
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]);
    expect(role.Properties.PermissionsBoundary).toEqual({ 'Fn::If': ['HasPermissionsBoundary', { Ref: 'PermissionsBoundaryArn' }, { Ref: 'AWS::NoValue' }] });
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    const s = statements(role);
    expect(s).toEqual([
      { Sid: 'WriteItsLog', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: { 'Fn::GetAtt': ['StatusLogGroup', 'Arn'] } },
      { Sid: 'ReadTheClientSecret', Effect: 'Allow', Action: 'ssm:GetParameter', Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter${GitHubClientSecretParameter}' } },
    ]);
    // Its key use is the key policy's grant, below, and nowhere else.
    expect(JSON.stringify(s)).not.toMatch(/kms:/);
  });

  it("lets only the function's role seal under the key, with seal.mjs's encryption context", () => {
    const policy = key.Properties.KeyPolicy.Statement as J[];
    expect(policy).toHaveLength(2);
    const [admin, use] = policy;
    expect(admin.Principal).toEqual({ AWS: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' } });
    // The account administers the key through IAM, and can't use it: no cryptographic operation,
    // and no grant, which would hand one out.
    const crypto = /^kms:(Encrypt|Decrypt|ReEncrypt|GenerateDataKey|CreateGrant|\*)/;
    expect(admin.Action.filter((a: string) => crypto.test(a))).toEqual([]);
    expect(admin.Action).toEqual(expect.arrayContaining(['kms:PutKeyPolicy', 'kms:ScheduleKeyDeletion', 'kms:TagResource']));
    expect(use).toEqual({
      Sid: 'TheFunctionSealsUnderIt',
      Effect: 'Allow',
      Principal: { AWS: { 'Fn::GetAtt': ['StatusRole', 'Arn'] } },
      Action: ['kms:GenerateDataKey', 'kms:Decrypt'],
      Resource: '*',
      Condition: { StringEquals: { 'kms:EncryptionContext:service': 'kanon-status' } },
    });
    const seal = readFileSync('infra/status/function/seal.mjs', 'utf8');
    expect(seal).toMatch(/const CONTEXT = \{ service: 'kanon-status' \};/);
  });

  it('keeps the key symmetric, unrotated, deleted with the stack after 7 days, and tagged for the bootstrap stack (Q2, Q3)', () => {
    expect(key.DeletionPolicy).toBe('Delete');
    expect(key.UpdateReplacePolicy).toBe('Delete');
    expect(key.Properties).toMatchObject({
      KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', EnableKeyRotation: false, PendingWindowInDays: 7,
      Tags: [{ Key: 'kanon:stack', Value: 'kanon-status' }],
    });
  });

  it("outputs the server's address and its log group's name", () => {
    expect(template.Outputs).toEqual({
      McpUrl: { Value: { 'Fn::Sub': '${StatusUrl.FunctionUrl}mcp' } },
      LogGroupName: { Value: { Ref: 'StatusLogGroup' } },
    });
  });
});
