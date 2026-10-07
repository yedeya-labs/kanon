import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeStub } from './helpers/stub-bin.js';
import { STACK_NAME, TEMPLATE_PATH, deployCommands, lifecycleProblems, readTemplate, trustProblems, trustedSubjects } from '../../infra/qa-store/aws/provision.mjs';
import { toRow, unmarshal } from '../../infra/qa-store/aws/export.mjs';
import { readCostRowsFile } from '../../actions/qa-store/qa-store.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * Plan 0004 step P9: Kanon's AWS implementation of the QA store contract (`infra/qa-store/aws`).
 * The template is parsed, never deployed, and each script runs against a stub `aws` that records
 * what it was asked and answers from a fixture: no test reaches AWS.
 */

// The template is untyped YAML, read by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const fresh = (): J => readTemplate();

describe('the template: the store outlives its stack and every stage (K-OBS-17)', () => {
  const t = fresh();
  it('passes its own checks', () => {
    expect(lifecycleProblems(t)).toEqual([]);
    expect(trustProblems(t)).toEqual([]);
  });

  it('retains the table and the bucket on delete and on replace, and protects the table from deletion', () => {
    for (const id of ['Table', 'Bucket']) {
      expect(t.Resources[id].DeletionPolicy).toBe('Retain');
      expect(t.Resources[id].UpdateReplacePolicy).toBe('Retain');
      expect(t.Resources[id].Condition).toBeUndefined();
    }
    expect(t.Resources.Table.Properties.DeletionProtectionEnabled).toBe(true);
  });

  it('a table without deletion protection fails', () => {
    const m = fresh();
    delete m.Resources.Table.Properties.DeletionProtectionEnabled;
    expect(lifecycleProblems(m)).toEqual(['Table has no deletion protection']);
    m.Resources.Table.Properties.DeletionProtectionEnabled = false;
    expect(lifecycleProblems(m)).toEqual(['Table has no deletion protection']);
  });

  it('a store resource that the stack deletes or replaces fails', () => {
    const m = fresh();
    m.Resources.Bucket.DeletionPolicy = 'Delete';
    delete m.Resources.Table.UpdateReplacePolicy;
    expect(lifecycleProblems(m)).toEqual(['Table has no UpdateReplacePolicy: Retain', 'Bucket has no DeletionPolicy: Retain']);
  });

  it('a stage name in a resource\'s lifecycle fails: in its name, through a parameter, or as its condition', () => {
    const named = fresh();
    named.Resources.Table.Properties.TableName = 'kanon-qa-store-staging';
    expect(lifecycleProblems(named)).toEqual(["Table.Properties.TableName names a stage ('kanon-qa-store-staging')"]);

    const param = fresh();
    param.Parameters.Stage = { Type: 'String', AllowedValues: ['dev', 'prod'] };
    param.Resources.Bucket.Properties.BucketName = { 'Fn::Sub': 'kanon-qa-store-${Stage}-${AWS::AccountId}' };
    expect(lifecycleProblems(param)).toEqual([
      'parameter Stage names a stage',
      "Bucket.Properties.BucketName.Fn::Sub names a stage ('kanon-qa-store-${Stage}-${AWS::AccountId}')",
      'Bucket.Properties.BucketName.Fn::Sub depends on the parameter Stage',
    ]);

    const env = fresh();
    env.Parameters.AppEnv = { Type: 'String' };
    env.Conditions.IsMain = { 'Fn::Equals': [{ Ref: 'AppEnv' }, 'main'] };
    env.Resources.Table.Condition = 'IsMain';
    env.Resources.Table.Properties.TableName = { Ref: 'AppEnv' };
    expect(lifecycleProblems(env)).toEqual(['Table exists only under the condition IsMain', 'Table.Properties.TableName is the parameter AppEnv']);
  });

  it('a template with no table, or two, fails', () => {
    const none = fresh();
    delete none.Resources.Table;
    expect(lifecycleProblems(none)).toEqual(['the template has 0 AWS::DynamoDB::Table resources, not one table']);
  });
});

describe('the role trusts exactly the default branch\'s ref subjects it is given (decision 9, as changed 2026-10-05)', () => {
  const sub = (t: J) => t.Resources.Role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals;
  it('its subject is exactly the Subjects parameter, by StringEquals, and its audience STS', () => {
    expect(sub(fresh())).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': { Ref: 'Subjects' },
    });
    expect(fresh().Parameters.Subjects.Type).toBe('CommaDelimitedList');
    expect(fresh().Parameters.Repository).toBeUndefined();
  });

  it('the old environment subject, a hard-coded subject or a pattern fails', () => {
    for (const x of [{ 'Fn::Sub': 'repo:${Repository}:environment:kanon-qa-store' }, 'repo:o/r:ref:refs/heads/main', [{ Ref: 'Subjects' }, 'repo:o/r:pull_request']]) {
      const m = fresh();
      sub(m)['token.actions.githubusercontent.com:sub'] = x;
      expect(trustProblems(m)).toEqual([`Role trusts ${JSON.stringify(x)}, not exactly the Subjects parameter`]);
    }
    const like = fresh();
    like.Resources.Role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringLike = { 'token.actions.githubusercontent.com:sub': 'repo:*' };
    expect(trustProblems(like)).toEqual(['Role trusts a pattern']);
    const aud = fresh();
    delete sub(aud)['token.actions.githubusercontent.com:aud'];
    expect(trustProblems(aud)).toEqual(['Role trusts an audience other than sts.amazonaws.com']);
    const noParam = fresh();
    noParam.Parameters.Subjects.Type = 'String';
    expect(trustProblems(noParam)).toEqual(['the template has no Subjects parameter of type CommaDelimitedList']);
  });
});

describe('the subjects: the default branch\'s ref, in the repository\'s own subject form', () => {
  // The checks themselves live in `scripts/lib/oidc-subject.mjs`, shared with the telemetry store,
  // and are tested in `oidc-subject.test.ts` (kanon#295). This is how `provision.mjs` calls them.
  const IMMUTABLE = 'repo:yedeya-labs@335343289/qa-store-sandbox@1405862401';
  const gh = (asked: string[][], repo: Record<string, unknown>, customization: Record<string, unknown>) => (args: string[]) => {
    asked.push(args);
    return JSON.stringify(args[1]!.endsWith('/actions/oidc/customization/sub') ? customization : repo);
  };

  it('asks GitHub for the default branch and the prefix, through the shared reading', () => {
    const asked: string[][] = [];
    expect(trustedSubjects('yedeya-labs/qa-store-sandbox', [], gh(asked, { full_name: 'yedeya-labs/qa-store-sandbox', default_branch: 'main' }, { use_default: true, use_immutable_subject: true, sub_claim_prefix: IMMUTABLE })))
      .toEqual({ defaultBranch: 'main', subjects: [`${IMMUTABLE}:ref:refs/heads/main`] });
    expect(asked).toEqual([
      ['api', 'repos/yedeya-labs/qa-store-sandbox'],
      ['api', 'repos/yedeya-labs/qa-store-sandbox/actions/oidc/customization/sub'],
    ]);
    expect(trustedSubjects('o/r', [], gh([], { full_name: 'o/r', default_branch: 'trunk' }, { use_default: true }))).toEqual({ defaultBranch: 'trunk', subjects: ['repo:o/r:ref:refs/heads/trunk'] });
  });

  it('keeps the given subjects, but still reads the default branch they must name', () => {
    const given = ['repo:o/r:context:ref:refs/heads/trunk:job_workflow_ref:o/r/.github/workflows/x.yml@refs/heads/trunk'];
    expect(trustedSubjects('o/r', given, gh([], { full_name: 'o/r', default_branch: 'trunk' }, { use_default: false }))).toEqual({ defaultBranch: 'trunk', subjects: given });
  });

  it('refuses a custom subject template without --subject, and a repository GitHub spells differently', () => {
    expect(() => trustedSubjects('o/r', [], gh([], { full_name: 'o/r', default_branch: 'main' }, { use_default: false, include_claim_keys: ['repo', 'context'] }))).toThrow(/customizes its OIDC subject.*--subject/);
    expect(() => trustedSubjects('o/r', [], gh([], { full_name: 'O/R', default_branch: 'main' }, { use_default: true }))).toThrow(/GitHub calls o\/r 'O\/R'/);
  });
});

describe('the role\'s grant', () => {
  it('may write and read the store, and delete only COVERAGE rows', () => {
    const [s3, list, ddb, del, ...rest] = fresh().Resources.Role.Properties.Policies[0].PolicyDocument.Statement;
    expect(rest).toEqual([]);
    expect(s3.Action).toEqual(['s3:PutObject', 's3:GetObject']);
    // Without ListBucket on the bucket, S3 answers a missing report with 403, which export.mjs
    // (rightly) doesn't read as "no report", so one missing report would fail the whole export.
    expect(list).toEqual({ Effect: 'Allow', Action: 's3:ListBucket', Resource: { 'Fn::GetAtt': ['Bucket', 'Arn'] } });
    expect(ddb.Action).toEqual(['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:Query']);
    expect(del.Action).toBe('dynamodb:DeleteItem');
    expect(del.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['COVERAGE'] } });
  });
});

describe('the template\'s cost and shape', () => {
  it('creates only free or pay-per-use resource types: no compute, no network, no key, no alarm', () => {
    const allowed = new Set(['AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::IAM::Role', 'AWS::IAM::OIDCProvider']);
    expect(Object.values(fresh().Resources).map((r: J) => r.Type).filter((x: string) => !allowed.has(x))).toEqual([]);
    expect(fresh().Resources.Table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
  });

  it('keeps the bucket private, and refuses plain HTTP', () => {
    const b = fresh().Resources.Bucket.Properties;
    expect(Object.values(b.PublicAccessBlockConfiguration)).toEqual([true, true, true, true]);
    expect(fresh().Resources.BucketPolicy.Properties.PolicyDocument.Statement[0]).toMatchObject({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } });
  });

  it('parses as plain YAML, with no short-form tags', () => {
    expect(readFileSync(TEMPLATE_PATH, 'utf8')).not.toMatch(/!(Ref|GetAtt|Sub|If|Equals|Not)\b/);
  });
});

// Its cases run the script in `bash` against a stub `aws`, so the block takes the spawn budget (#436).
describe('the provisioning script', SPAWNS, () => {
  it('deploys the stack, protects it from termination, and prints its outputs', () => {
    const subjects = ['repo:o/r:ref:refs/heads/main'];
    const [deploy, protect, describe_] = deployCommands({ repository: 'o/r', subjects, defaultBranch: 'main', region: 'eu-central-1', profile: 'p' });
    expect(deploy).toEqual(['aws', 'cloudformation', 'deploy', '--region', 'eu-central-1', '--profile', 'p', '--stack-name', STACK_NAME,
      '--template-file', TEMPLATE_PATH, '--parameter-overrides', 'Subjects=repo:o/r:ref:refs/heads/main', 'CreateOidcProvider=true',
      '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset']);
    expect(protect).toContain('--enable-termination-protection');
    expect(describe_).toContain('Stacks[0].Outputs');
    expect(deployCommands({ repository: 'o/r', subjects, defaultBranch: 'main', region: 'us-east-2', oidcProvider: false })[0]).toContain('CreateOidcProvider=false');
    expect(deployCommands({ repository: 'o/r', subjects: [...subjects, 'repo:o@1/r@2:ref:refs/heads/main'], defaultBranch: 'main', region: 'us-east-2' })[0])
      .toContain('Subjects=repo:o/r:ref:refs/heads/main,repo:o@1/r@2:ref:refs/heads/main');
  });

  it('refuses a repository or region it can\'t trust exactly', () => {
    const subjects = ['repo:o/r:ref:refs/heads/main'];
    expect(() => deployCommands({ repository: 'o/*', subjects, defaultBranch: 'main', region: 'eu-central-1' })).toThrow(/owner\/name/);
    expect(() => deployCommands({ repository: 'o/r', subjects, defaultBranch: 'main', region: 'europe' })).toThrow(/region/);
    expect(() => deployCommands({ repository: 'o/r', subjects: ['repo:o/r:environment:kanon-qa-store'], defaultBranch: 'main', region: 'eu-central-1' })).toThrow(/refusing to trust/);
    expect(() => deployCommands({ repository: 'o/r', subjects, defaultBranch: 'trunk', region: 'eu-central-1' })).toThrow(/not o\/r's default branch 'trunk'/);
  });

  // A stub `gh` answering the default branch, `trunk`, and the subject customization.
  const withGh = <T>(customization: string, body: (run: (...extra: string[]) => ReturnType<typeof spawnSync>) => T): T => {
    const work = mkdtempSync(join(tmpdir(), 'qa-store-provision-'));
    try {
      writeStub(join(work, 'gh'), `#!/usr/bin/env bash\ncase "$2" in\n  repos/o/r) echo '{"full_name":"o/r","default_branch":"trunk"}' ;;\n  *) echo '${customization}' ;;\nesac\n`);
      return body((...extra) => spawnSync(process.execPath, ['infra/qa-store/aws/provision.mjs', '--repository', 'o/r', '--region', 'eu-central-1', '--dry-run', ...extra],
        { encoding: 'utf8', env: { ...process.env, PATH: `${work}:/usr/bin:/bin` } }));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  it('prints the commands and runs none on a dry run, after checking the template', () => withGh('{"use_default":true}', (run) => {
    const r = run('--subject', 'repo:o/r:ref:refs/heads/trunk', '--subject', 'repo:o@1/r@2:ref:refs/heads/trunk');
    expect(r.status).toBe(0);
    expect(String(r.stdout).split('\n').filter((l) => l.startsWith('$ aws cloudformation '))).toHaveLength(3);
    expect(String(r.stdout)).toContain('Subjects=repo:o/r:ref:refs/heads/trunk,repo:o@1/r@2:ref:refs/heads/trunk');
  }));

  it('refuses a --subject on any branch but the default, which it reads from GitHub all the same', () => withGh('{"use_default":true}', (run) => {
    const r = run('--subject', 'repo:o/r:ref:refs/heads/feature-x');
    expect(r.status).toBe(1);
    expect(String(r.stderr)).toMatch(/names the branch 'feature-x', not o\/r's default branch 'trunk'/);
    expect(String(r.stdout)).not.toMatch(/\$ aws/);
  }));

  it('without --subject, reads it from GitHub, and refuses a custom subject template', () => {
    withGh('{"use_default":true,"use_immutable_subject":true,"sub_claim_prefix":"repo:o@7/r@9"}', (run) => {
      const r = run();
      expect(r.status).toBe(0);
      expect(String(r.stdout)).toContain('Subjects=repo:o@7/r@9:ref:refs/heads/trunk');
    });
    withGh('{"use_default":false,"include_claim_keys":["repo","context"]}', (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(String(r.stderr)).toMatch(/customizes its OIDC subject/);
    });
  });
});

describe('the actions', () => {
  type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
  const load = (p: string) => parse(readFileSync(p, 'utf8')) as { inputs: Record<string, unknown>; runs: { using: string; steps: Step[] } };

  it('the store action takes the contract\'s five inputs and the store\'s coordinates, and assumes the role first', () => {
    const a = load('infra/qa-store/aws/action.yml');
    expect(Object.keys(a.inputs).sort()).toEqual(['bucket', 'dir', 'from', 'kind', 'operation', 'region', 'role-arn', 'table', 'to']);
    expect(a.runs.steps[0]?.uses).toBe('aws-actions/configure-aws-credentials@v6');
    expect(a.runs.steps[0]?.with).toEqual({ 'role-to-assume': '${{ inputs.role-arn }}', 'aws-region': '${{ inputs.region }}', 'mask-aws-account-id': true });
    expect(a.runs.steps[1]?.run?.trim()).toBe('bash "$GITHUB_ACTION_PATH/store.sh"');
  });

  it('the maintenance workflow runs in no environment, with id-token and nothing else', () => {
    const wf = parse(readFileSync('.github/workflows/qa-store-aws-maintenance.yml', 'utf8')) as J;
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    expect(wf.permissions).toEqual({ 'id-token': 'write' });
    expect(wf.jobs.maintenance.environment).toBeUndefined();
    expect(wf.jobs.maintenance.steps).toEqual([expect.objectContaining({ uses: '$/infra/qa-store/aws/maintenance' })]);
    expect(wf.on.workflow_call.inputs.apply.default).toBe(false);
  });
});

// Its cases run the store's scripts in `bash` against a stub `aws`, so the block takes the spawn budget (#436).
describe('the scripts, against a stub aws', SPAWNS, () => {
  let work: string;
  let bin: string;
  let dir: string;
  let calls: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'qa-store-aws-'));
    bin = join(work, 'bin');
    dir = join(work, 'store');
    calls = join(work, 'calls');
    mkdirSync(bin);
    mkdirSync(dir);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  /** A stub `aws` that logs each call's arguments, one JSON array per line, and runs `body`. */
  const aws = (body: string) => writeStub(join(bin, 'aws'),
    `#!/usr/bin/env bash\nnode -e 'process.stdout.write(JSON.stringify(process.argv.slice(1))+"\\n")' -- "$@" >> ${JSON.stringify(calls)}\n${body}\n`);
  const logged = (): string[][] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const run = (op: string, extra: Record<string, string> = {}) => spawnSync('bash', ['infra/qa-store/aws/store.sh'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPERATION: op, DIR: dir, QA_AWS_REGION: 'eu-central-1', QA_DYNAMO_TABLE: 't', QA_S3_BUCKET: 'b', ...extra },
  });
  const SHA = 'd'.repeat(40);

  describe('last-green (the Explorer gate\'s queries, moved)', () => {
    it('writes the newest green full sweep\'s commit, from a server-side filtered query', () => {
      aws(`echo '{"Items":[{"commit":{"S":"${SHA}"}}]}'`);
      const r = run('last-green');
      expect(r.status).toBe(0);
      expect(readFileSync(join(dir, 'last-green'), 'utf8')).toBe(`${SHA}\n`);
      const [q] = logged();
      expect(q).toEqual(expect.arrayContaining(['--filter-expression', '#f = :zero AND #t = :all', '--max-items', '1', '--no-scan-index-forward', '--output', 'json']));
    });

    it('an empty store is a quiet ok with no commit', () => {
      aws(`echo '{"Items":[]}'`);
      const r = run('last-green');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('no sweep in the store yet');
      expect(readFileSync(join(dir, 'last-green'), 'utf8')).toBe('');
      expect(logged()).toHaveLength(2);
    });

    it('a red streak is a quiet ok with no commit', () => {
      aws(`case "$*" in *filter-expression*) echo '{"Items":[]}';; *) echo '{"Items":[{"sk":{"S":"20261001T000000Z"},"failed":{"N":"2"},"tier":{"S":"all"}}]}';; esac`);
      const r = run('last-green');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('no green full-tier sweep among the recorded runs (newest: failed=2 tier=all');
    });

    it('a failed query, filter drift and a non-SHA are degraded: exit 1 with the gate\'s warning, and no commit', () => {
      aws('echo "AccessDenied" >&2; exit 254');
      expect(run('last-green')).toMatchObject({ status: 1, stdout: expect.stringContaining('::warning title=Explorer change-gate degraded::the baseline query failed') });
      aws(`case "$*" in *filter-expression*) echo '{"Items":[]}';; *) echo '{"Items":[{"skipped":{"BOOL":true}}]}';; esac`);
      expect(run('last-green')).toMatchObject({ status: 1, stdout: expect.stringContaining('The filter has likely drifted') });
      aws(`echo '{"Items":[{"commit":{"S":"not-a-sha"}}]}'`);
      expect(run('last-green')).toMatchObject({ status: 1, stdout: expect.stringContaining('non-sha value') });
      expect(readFileSync(join(dir, 'last-green'), 'utf8')).toBe('');
    });
  });

  it('record-skip writes the gate\'s skip row: no failed attribute, skipped and a reason', () => {
    aws('exit 0');
    writeFileSync(join(dir, 'skip.json'), JSON.stringify({ commit: SHA, trigger: 'schedule', tier: 'all', reason: 'unchanged-commit' }));
    expect(run('record-skip').status).toBe(0);
    const [call] = logged();
    expect(call?.slice(0, 2)).toEqual(['dynamodb', 'put-item']);
    const item = JSON.parse(call![call!.indexOf('--item') + 1]!);
    expect(item).toEqual({
      pk: { S: 'RUN#explorer' }, sk: { S: expect.stringMatching(/^\d{8}T\d{6}Z$/) }, commit: { S: SHA },
      trigger: { S: 'schedule' }, tier: { S: 'all' }, skipped: { BOOL: true }, reason: { S: 'unchanged-commit' },
    });
    writeFileSync(join(dir, 'skip.json'), JSON.stringify({ commit: 'short' }));
    expect(run('record-skip').status).not.toBe(0);
  });

  describe('put (push-run.sh, moved)', () => {
    it('writes an Explorer run: the raw report, its RUN row and a COVERAGE row per route', () => {
      aws('exit 0');
      writeFileSync(join(dir, 'report.json'), JSON.stringify({
        commit: SHA, trigger: 'schedule', tier: 'all', routes_swept: 2, passed: 1, failed: 1,
        routes: [{ route: '/a', status: 'passed' }, { route: '/b', status: 'failed', signal: 'pageerror' }],
      }));
      const r = run('put', { KIND: 'explorer', QA_RUN_TS: '20261004T120000Z' });
      expect(r.status).toBe(0);
      const c = logged();
      expect(c[0]).toEqual(['s3', 'cp', join(dir, 'report.json'), 's3://b/explorer/20261004T120000Z.json', '--region', 'eu-central-1', '--only-show-errors']);
      const items = c.slice(1).map((x) => JSON.parse(x[x.indexOf('--item') + 1]!));
      expect(items[0]).toEqual({ pk: { S: 'RUN#explorer' }, sk: { S: '20261004T120000Z' }, commit: { S: SHA }, trigger: { S: 'schedule' }, tier: { S: 'all' }, routes_swept: { N: '2' }, passed: { N: '1' }, failed: { N: '1' } });
      expect(items.slice(1).map((i) => [i.pk.S, i.sk.S, i.last_status.S])).toEqual([['COVERAGE', '/a', 'passed'], ['COVERAGE', '/b', 'failed']]);
    });

    it('writes an audit run with its liveness flags only where the report has them, and an AREAS row per area', () => {
      aws('exit 0');
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ commit: SHA, trigger: 'schedule', files_read: 3, lines_cited: 9, turns: 20, complete: true, areas_scanned: ['scripts/a.mjs — the gate'] }));
      expect(run('put', { KIND: 'audit', QA_RUN_TS: '20261004T120000Z' }).status).toBe(0);
      const items = logged().slice(1).map((x) => JSON.parse(x[x.indexOf('--item') + 1]!));
      expect(items[0]).toMatchObject({ pk: { S: 'RUN#audit' }, complete: { BOOL: true } });
      expect(items[0]).not.toHaveProperty('no_report');
      expect(items[1]).toMatchObject({ pk: { S: 'AREAS' }, sk: { S: 'scripts/a.mjs' }, detail: { S: 'scripts/a.mjs — the gate' } });
    });

    it('skips a missing Explorer report, and fails a missing audit report', () => {
      aws('exit 0');
      expect(run('put', { KIND: 'explorer' })).toMatchObject({ status: 0, stdout: expect.stringContaining('skipping (benign)') });
      expect(run('put', { KIND: 'audit' }).status).toBe(1);
      expect(logged()).toEqual([]);
    });

    it('fails the job when a write fails', () => {
      aws('case "$1" in dynamodb) echo "ValidationException" >&2; exit 254;; esac');
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ commit: SHA, routes: [] }));
      expect(run('put', { KIND: 'explorer' }).status).not.toBe(0);
    });
  });

  describe('export', () => {
    it('writes the Overseer\'s files from the partitions, unmarshalled, and its raw reports', () => {
      aws([
        'case "$*" in',
        `  *RUN#explorer*) echo '{"Items":[{"pk":{"S":"RUN#explorer"},"sk":{"S":"20261003T000000Z"},"commit":{"S":"${SHA}"},"failed":{"N":"0"}},{"pk":{"S":"RUN#explorer"},"sk":{"S":"20261002T000000Z"},"skipped":{"BOOL":true}}]}';;`,
        `  *RUN#audit*) echo '{"Items":[{"pk":{"S":"RUN#audit"},"sk":{"S":"20261001T000000Z"},"complete":{"BOOL":false}}]}';;`,
        `  *COVERAGE*) echo '{"Items":[{"pk":{"S":"COVERAGE"},"sk":{"S":"/a"},"last_status":{"S":"passed"}}]}';;`,
        `  *AREAS*) echo '{"Items":[]}';;`,
        '  s3\\ cp\\ s3://b/audit/*) echo "fatal error: An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 1;;',
        '  s3\\ cp*) echo "{}" > "$4";;',
        'esac',
      ].join('\n'));
      const r = run('export', { KIND: 'overseer', FROM: '20260904T000000Z' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const read = (f: string) => JSON.parse(readFileSync(join(dir, 'export', f), 'utf8'));
      expect(read('runs-explorer.json')).toEqual([{ ts: '20261003T000000Z', commit: SHA, failed: 0 }, { ts: '20261002T000000Z', skipped: true }]);
      expect(read('runs-audit.json')).toEqual([{ ts: '20261001T000000Z', complete: false }]);
      expect(read('coverage.json')).toEqual([{ route: '/a', last_status: 'passed' }]);
      expect(read('areas.json')).toEqual([]);
      expect(existsSync(join(dir, 'export/reports/explorer/20261003T000000Z.json'))).toBe(true);
      expect(existsSync(join(dir, 'export/reports/explorer/20261002T000000Z.json'))).toBe(false);
      expect(r.stdout).toContain('no raw report at audit/20261001T000000Z.json');
      const windowed = logged().find((c) => c.join(' ').includes('RUN#explorer'))!;
      expect(windowed).toEqual(expect.arrayContaining(['pk = :p AND sk > :s', '--no-scan-index-forward']));
      const ledger = logged().find((c) => c.join(' ').includes('AREAS'))!;
      expect(ledger).toContain('pk = :p');
    });

    it('a forbidden report is not a missing one: a 403 fails the export, so a wrong role is never read as "no report"', () => {
      aws([
        'case "$*" in',
        `  *RUN#explorer*) echo '{"Items":[{"pk":{"S":"RUN#explorer"},"sk":{"S":"20261003T000000Z"}}]}';;`,
        '  s3\\ cp*) echo "fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden" >&2; exit 1;;',
        `  *) echo '{"Items":[]}';;`,
        'esac',
      ].join('\n'));
      expect(run('export', { KIND: 'overseer', FROM: '20260904T000000Z' })).toMatchObject({ status: 1, stdout: expect.stringContaining('the export failed') });
    });

    it('an audit export reads the code-reading ledger alone', () => {
      aws(`echo '{"Items":[{"pk":{"S":"AREAS"},"sk":{"S":"scripts/a.mjs"},"commit":{"S":"${SHA}"}}]}'`);
      expect(run('export', { KIND: 'audit', FROM: '20260904T000000Z' }).status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'export/areas.json'), 'utf8'))).toEqual([{ area: 'scripts/a.mjs', commit: SHA }]);
      expect(logged()).toHaveLength(1);
    });

    it('fails when a read fails, so the block reports it degraded', () => {
      aws('echo AccessDenied >&2; exit 254');
      expect(run('export', { KIND: 'audit', FROM: '20260904T000000Z' })).toMatchObject({ status: 1, stdout: expect.stringContaining('the export failed') });
    });

    it('unmarshals every attribute type it can meet, and leaves an absent one absent', () => {
      expect(unmarshal({ M: { a: { L: [{ N: '1' }, { NULL: true }, { SS: ['x'] }] } } })).toEqual({ a: [1, null, ['x']] });
      expect(toRow({ pk: { S: 'AREAS' }, sk: { S: 'x' }, complete: { BOOL: false } }, 'area')).toEqual({ area: 'x', complete: false });
    });
  });

  describe('cost-rows (readCostRows\' query, moved)', () => {
    const ROWS = '{"Items":[{"sk":{"S":"20261001T000000Z"},"issue_number":{"N":"7"},"outcome":{"S":"unavailable"},"run_id":{"S":"9"}},{"sk":{"S":"20261003T000000Z"},"outcome":{"S":"ok"}}]}';
    it('writes one agent\'s rows after FROM in readCostRows\' shape, with the sweep\'s query', () => {
      aws(`echo '${ROWS}'`);
      expect(run('cost-rows', { KIND: 'implementer', FROM: '20260920T000000Z' }).status).toBe(0);
      expect(readCostRowsFile(join(dir, 'cost-rows.json'))).toEqual({ rows: [
        { ts: '20261001T000000Z', issue_number: '7', outcome: 'unavailable', run_id: '9' },
        { ts: '20261003T000000Z', issue_number: null, outcome: 'ok', run_id: null },
      ], error: null });
      const [q] = logged();
      expect(q).toEqual(['dynamodb', 'query', '--table-name', 't', '--region', 'eu-central-1', '--key-condition-expression', 'pk = :p AND sk > :s',
        '--expression-attribute-values', '{":p":{"S":"COST#implementer"},":s":{"S":"20260920T000000Z"}}',
        '--projection-expression', 'sk, issue_number, outcome, run_id', '--output', 'json']);
    });

    it('drops rows after TO, the contract\'s upper bound', () => {
      aws(`echo '${ROWS}'`);
      run('cost-rows', { KIND: 'implementer', FROM: '20260920T000000Z', TO: '20261002T000000Z' });
      expect(readCostRowsFile(join(dir, 'cost-rows.json')).rows.map((r) => r.ts)).toEqual(['20261001T000000Z']);
    });

    it('fails closed, says why in the file, and exits 1', () => {
      aws('echo "Unable to locate credentials" >&2; exit 255');
      expect(run('cost-rows', { KIND: 'implementer', FROM: '20260920T000000Z' }).status).toBe(1);
      expect(readCostRowsFile(join(dir, 'cost-rows.json'))).toEqual({ rows: [], error: 'the store query failed (Unable to locate credentials)' });
    });
  });

  it('an unknown operation fails by name', () => {
    expect(run('scan')).toMatchObject({ status: 2, stdout: expect.stringContaining("unknown operation 'scan'") });
  });

  it('the maintenance purge is a dry run unless APPLY is 1, and deletes only COVERAGE rows', () => {
    aws(`case "$2" in query) printf 'signal sweep (dynamic): /a\\tsignal sweep (dynamic): /b\\n';; esac`);
    const purge = (apply: string) => spawnSync('bash', ['infra/qa-store/aws/purge-legacy-coverage.sh'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_AWS_REGION: 'r', QA_DYNAMO_TABLE: 't', APPLY: apply },
    });
    expect(purge('').stdout).toContain('2 legacy COVERAGE key(s) found');
    expect(logged().filter((c) => c[1] === 'delete-item')).toEqual([]);
    expect(purge('1').stdout).toContain('deleted 2 legacy COVERAGE key(s)');
    expect(logged().filter((c) => c[1] === 'delete-item').map((c) => JSON.parse(c[c.indexOf('--key') + 1]!).pk.S)).toEqual(['COVERAGE', 'COVERAGE']);
  });
});
