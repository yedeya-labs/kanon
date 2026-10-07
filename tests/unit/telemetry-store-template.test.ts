import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { FUNCTION_DIR, registerProblems, render, TEMPLATE_PATH } from '../../infra/telemetry/render.mjs';
import { PROJECTION } from '../../infra/telemetry/function/aggregate.mjs';

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
  it('the URLs are IAM-authenticated, and there are two: the ingest URL and the aggregate URL', () => {
    expect(byType('AWS::Lambda::Url').map(([name, r]) => [name, r.Properties.AuthType])).toEqual([['IngestUrl', 'AWS_IAM'], ['AggregateUrl', 'AWS_IAM']]);
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
    expect([...q.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']].sort()).toEqual([...PROJECTION, 'sk'].sort());
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
      const principal = p.Properties.Principal['Fn::GetAtt'][0] as string;
      expect(p.Properties.FunctionName.Ref).toBe(principal.startsWith('AggregateInvokerRole') ? 'AggregateFunction' : 'IngestFunction');
    }
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
    expect(render(register, { verify: true, importer: true, backfill: true, gh }).parameters.slice(3))
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
  it('a repository GitHub does not answer for stops the render, under its key', () => {
    expect(() => render({ ...register, repositories: [{ ...entry, repository: 'o/gone' }] }, { gh })).toThrow(/^register: k1: gh: HTTP 404/);
  });
  it('refuses an entry GitHub spells differently: a rename redirect, or another case', () => {
    expect(() => one({ full_name: 'o/renamed' })).toThrow(/GitHub calls o\/r 'o\/renamed'/);
    expect(() => one({ full_name: 'O/r' })).toThrow(/GitHub calls o\/r 'O\/r'/);
  });
  it('refuses a default branch GitHub reports with pattern characters', () => {
    expect(() => one({ default_branch: 'ma*n' })).toThrow(/default branch/);
  });
});
