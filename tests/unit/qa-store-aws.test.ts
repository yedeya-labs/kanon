import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeStub } from './helpers/stub-bin.js';
import { STACK_NAME, TEMPLATE_PATH, deployCommands, lifecycleProblems, readTemplate, trustProblems, trustedSubjects } from '../../infra/qa-store/aws/provision.mjs';
import { PARTITIONS, toRow, unmarshal } from '../../infra/qa-store/aws/export.mjs';
import { REPORTS_ROOT, UNKEYED_PARTITIONS } from '../../infra/qa-store/aws/keys.mjs';
import { readCostRowsFile } from '../../actions/qa-store/qa-store.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { ID_TOKEN_HOLDERS } from './helpers/store-jobs.js';

/**
 * Plan 0004 step P9: Kanon's AWS implementation of the QA store contract (`infra/qa-store/aws`).
 * The template is parsed, never deployed, and each script runs against a stub `aws` that records
 * what it was asked and answers from a fixture: no test reaches AWS.
 */

// The template is untyped YAML, read by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const fresh = (): J => readTemplate();
/** Two repositories' ids, as the runner's `GITHUB_REPOSITORY_ID` gives them (kanon#1346). */
const REPO = '101';
const OTHER = '202';

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

  it('its comment names the id-token holders the guard admits besides the store jobs, and leaves the rest to kanon doctor (kanon#526)', () => {
    // The comment block right above the role, which an adopter reads for why the trust is safe.
    const lines = readFileSync(TEMPLATE_PATH, 'utf8').split('\n');
    const role = lines.indexOf('  Role:');
    let start = role;
    while (lines[start - 1]?.trimStart().startsWith('#')) start--;
    const comment = lines.slice(start, role).map((l) => l.replace(/^\s*#\s?/, '')).join(' ');
    expect(comment).not.toMatch(/only a store job holds/);
    // The holders the guard admits besides the store jobs and their callers, from the list the
    // guard itself reads (kanon#531), so a holder added to it turns this red too.
    for (const holder of ID_TOKEN_HOLDERS) expect(comment, holder.says).toContain(holder.cited);
    expect(comment).toContain('`kanon doctor`');
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
    expect(trustedSubjects(['yedeya-labs/qa-store-sandbox'], [], gh(asked, { full_name: 'yedeya-labs/qa-store-sandbox', default_branch: 'main' }, { use_default: true, use_immutable_subject: true, sub_claim_prefix: IMMUTABLE })))
      .toEqual({ defaultBranches: { 'yedeya-labs/qa-store-sandbox': 'main' }, subjects: [`${IMMUTABLE}:ref:refs/heads/main`] });
    expect(asked).toEqual([
      ['api', 'repos/yedeya-labs/qa-store-sandbox'],
      ['api', 'repos/yedeya-labs/qa-store-sandbox/actions/oidc/customization/sub'],
    ]);
    expect(trustedSubjects(['o/r'], [], gh([], { full_name: 'o/r', default_branch: 'trunk' }, { use_default: true }))).toEqual({ defaultBranches: { 'o/r': 'trunk' }, subjects: ['repo:o/r:ref:refs/heads/trunk'] });
  });

  it('keeps the given subjects, but still reads the default branch they must name', () => {
    const given = ['repo:o/r:context:ref:refs/heads/trunk:job_workflow_ref:o/r/.github/workflows/x.yml@refs/heads/trunk'];
    expect(trustedSubjects(['o/r'], given, gh([], { full_name: 'o/r', default_branch: 'trunk' }, { use_default: false }))).toEqual({ defaultBranches: { 'o/r': 'trunk' }, subjects: given });
  });

  it('refuses a custom subject template without --subject, and a repository GitHub spells differently', () => {
    expect(() => trustedSubjects(['o/r'], [], gh([], { full_name: 'o/r', default_branch: 'main' }, { use_default: false, include_claim_keys: ['repo', 'context'] }))).toThrow(/customizes its OIDC subject.*--subject/);
    expect(() => trustedSubjects(['o/r'], [], gh([], { full_name: 'O/R', default_branch: 'main' }, { use_default: true }))).toThrow(/GitHub calls o\/r 'O\/R'/);
  });

  // Several repositories on one store (kanon#1339): plan 0012's E15 trusts the harness's and the
  // fixture's `main`. Each repository is read on its own, and each subject is held to its own
  // repository's default branch.
  const two = (asked: string[][], fixtureCustomization: Record<string, unknown> = { use_default: true }) => (args: string[]) => {
    asked.push(args);
    const answers: Record<string, unknown> = {
      'repos/e/harness': { full_name: 'e/harness', default_branch: 'main' },
      'repos/e/harness/actions/oidc/customization/sub': { use_default: true, use_immutable_subject: true, sub_claim_prefix: 'repo:e@1/harness@2' },
      'repos/e/fixture': { full_name: 'e/fixture', default_branch: 'trunk' },
      'repos/e/fixture/actions/oidc/customization/sub': fixtureCustomization,
    };
    return JSON.stringify(answers[args[1]!]);
  };

  it('trusts each repository named, reading every one\'s default branch and prefix from GitHub', () => {
    const asked: string[][] = [];
    expect(trustedSubjects(['e/harness', 'e/fixture'], [], two(asked))).toEqual({
      defaultBranches: { 'e/harness': 'main', 'e/fixture': 'trunk' },
      subjects: ['repo:e@1/harness@2:ref:refs/heads/main', 'repo:e/fixture:ref:refs/heads/trunk'],
    });
    expect(asked.map((a) => a[1])).toEqual(['repos/e/harness', 'repos/e/harness/actions/oidc/customization/sub', 'repos/e/fixture', 'repos/e/fixture/actions/oidc/customization/sub']);
  });

  it('names the repository whose custom subject template needs --subject, and refuses a repository named twice', () => {
    expect(() => trustedSubjects(['e/harness', 'e/fixture'], [], two([], { use_default: false, include_claim_keys: ['repo', 'context'] }))).toThrow(/e\/fixture customizes its OIDC subject.*--subject/);
    const given = ['repo:e/fixture:context:ref:refs/heads/trunk', 'repo:e@1/harness@2:ref:refs/heads/main'];
    expect(trustedSubjects(['e/harness', 'e/fixture'], given, two([], { use_default: false }))).toEqual({ defaultBranches: { 'e/harness': 'main', 'e/fixture': 'trunk' }, subjects: given });
    expect(() => trustedSubjects(['e/harness', 'E/Harness'], [], two([]))).toThrow(/--repository 'E\/Harness' is named twice/);
  });
});

describe('repositories sharing one store read only their own rows, and the docs say so (kanon#1346)', () => {
  // Every partition a lane reads is keyed by the repository's id (`keys.mjs`), which the docs must
  // say where they let a store serve several, along with what the keys don't do: hold the role.
  // The scripts' behaviour is held by "the store keys every row by repository" below.
  const paragraph = (start: string) => {
    const found = readFileSync('docs/qa-store.md', 'utf8').split('\n').filter((l) => l.startsWith(start));
    if (found.length !== 1) throw new Error(`docs/qa-store.md has ${found.length} paragraphs starting ${JSON.stringify(start)}, not one`);
    return found[0]!;
  };

  it('reads and writes partitions keyed by the repository\'s id', () => {
    expect(Object.values(PARTITIONS).map((p) => p.pk)).toEqual([...UNKEYED_PARTITIONS]);
    const gate = readFileSync('infra/qa-store/aws/last-green.sh', 'utf8');
    expect(gate).toContain('own="RUN#explorer#$repo"');
    expect(gate).toContain('for pk in "$own" "$unkeyed"; do');
    expect(readFileSync('infra/qa-store/aws/record-skip.sh', 'utf8')).toContain('pk: {S: ("RUN#explorer#" + $r)}');
  });

  it('says that each repository reads only its own rows, that the role still reaches every row, and that old rows wait for the migration', () => {
    expect(paragraph('The store\'s role trusts, for each repository it serves')).toContain('its lanes read only their own rows (below)');
    const own = paragraph('**Each repository on a store reads and writes only its own rows.**');
    expect(own).toContain('keyed by the repository\'s id');
    expect(own).toContain('(#rows-by-repository)');
    expect(own).toContain('the role still lets every repository it trusts reach every row');
    expect(own).toContain('keeps its unkeyed rows until the account owner migrates them');
    expect(readFileSync('docs/qa-store.md', 'utf8')).not.toContain('share its rows');
    expect(paragraph('It needs `gh`, signed in with read access')).toContain('then read and write only its own rows');
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
    // Every repository's own COVERAGE partition and the unkeyed one written before kanon#1346,
    // and nothing else: `RUN#…`, `AREAS…` and `COST#…` are not re-derivable.
    expect(del.Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['COVERAGE', 'COVERAGE#*'] } });
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
    const [deploy, protect, describe_] = deployCommands({ defaultBranches: { 'o/r': 'main' }, subjects, region: 'eu-central-1', profile: 'p' });
    expect(deploy).toEqual(['aws', 'cloudformation', 'deploy', '--region', 'eu-central-1', '--profile', 'p', '--stack-name', STACK_NAME,
      '--template-file', TEMPLATE_PATH, '--parameter-overrides', 'Subjects=repo:o/r:ref:refs/heads/main', 'CreateOidcProvider=true',
      '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset']);
    expect(protect).toContain('--enable-termination-protection');
    expect(describe_).toContain('Stacks[0].Outputs');
    expect(deployCommands({ defaultBranches: { 'o/r': 'main' }, subjects, region: 'us-east-2', oidcProvider: false })[0]).toContain('CreateOidcProvider=false');
    expect(deployCommands({ defaultBranches: { 'o/r': 'main' }, subjects: [...subjects, 'repo:o@1/r@2:ref:refs/heads/main'], region: 'us-east-2' })[0])
      .toContain('Subjects=repo:o/r:ref:refs/heads/main,repo:o@1/r@2:ref:refs/heads/main');
  });

  it('refuses a repository or region it can\'t trust exactly', () => {
    const subjects = ['repo:o/r:ref:refs/heads/main'];
    expect(() => deployCommands({ defaultBranches: { 'o/*': 'main' }, subjects, region: 'eu-central-1' })).toThrow(/owner\/name/);
    expect(() => deployCommands({ defaultBranches: { 'o/r': 'main' }, subjects, region: 'europe' })).toThrow(/region/);
    expect(() => deployCommands({ defaultBranches: { 'o/r': 'main' }, subjects: ['repo:o/r:environment:kanon-qa-store'], region: 'eu-central-1' })).toThrow(/refusing to trust/);
    expect(() => deployCommands({ defaultBranches: { 'o/r': 'trunk' }, subjects, region: 'eu-central-1' })).toThrow(/not o\/r's default branch 'trunk'/);
  });

  it('holds each subject to its own repository\'s default branch when the store trusts several', () => {
    const defaultBranches = { 'e/harness': 'main', 'e/fixture': 'trunk' };
    const subjects = ['repo:e@1/harness@2:ref:refs/heads/main', 'repo:e/fixture:ref:refs/heads/trunk'];
    expect(deployCommands({ defaultBranches, subjects, region: 'eu-central-1' })[0]).toContain(`Subjects=${subjects.join(',')}`);
    // The fixture's subject on the harness's default branch is a subject of neither at its own.
    expect(() => deployCommands({ defaultBranches, subjects: [subjects[0]!, 'repo:e/fixture:ref:refs/heads/main'], region: 'eu-central-1' }))
      .toThrow(/'repo:e\/fixture:ref:refs\/heads\/main' is a subject of none of the repositories named .*names the branch 'main', not e\/fixture's default branch 'trunk'/);
    expect(() => deployCommands({ defaultBranches, subjects: [...subjects, 'repo:e/other:ref:refs/heads/main'], region: 'eu-central-1' }))
      .toThrow(/'repo:e\/other:ref:refs\/heads\/main' is a subject of none of the repositories named/);
    expect(() => deployCommands({ defaultBranches, subjects: [...subjects, 'repo:e/fixture:pull_request'], region: 'eu-central-1' })).toThrow(/refusing to trust/);
    // A repository named and left untrusted is a slip the operator should see, not a quiet no-op.
    expect(() => deployCommands({ defaultBranches, subjects: [subjects[0]!], region: 'eu-central-1' })).toThrow(/no subject of e\/fixture/);
    expect(() => deployCommands({ defaultBranches: {}, subjects, region: 'eu-central-1' })).toThrow(/no repository/);
    expect(() => deployCommands({ defaultBranches: { 'e/harness': 'main', 'e/*': 'main' }, subjects, region: 'eu-central-1' })).toThrow(/'e\/\*' is not owner\/name/);
  });

  it('takes --repository more than once, and trusts each one\'s default branch', () => {
    const work = mkdtempSync(join(tmpdir(), 'qa-store-provision-'));
    try {
      writeStub(join(work, 'gh'), `#!/usr/bin/env bash
case "$2" in
  repos/e/harness) echo '{"full_name":"e/harness","default_branch":"main"}' ;;
  repos/e/fixture) echo '{"full_name":"e/fixture","default_branch":"trunk"}' ;;
  repos/e/harness/*) echo '{"use_default":true,"use_immutable_subject":true,"sub_claim_prefix":"repo:e@1/harness@2"}' ;;
  *) echo '{"use_default":true}' ;;
esac
`);
      const run = (...extra: string[]) => spawnSync(process.execPath, ['infra/qa-store/aws/provision.mjs', '--repository', 'e/harness', '--repository', 'e/fixture', '--region', 'eu-central-1', '--dry-run', ...extra],
        { encoding: 'utf8', env: { ...process.env, PATH: `${work}:/usr/bin:/bin` } });
      const ok = run();
      expect(ok.status).toBe(0);
      expect(String(ok.stdout)).toContain('Subjects=repo:e@1/harness@2:ref:refs/heads/main,repo:e/fixture:ref:refs/heads/trunk');
      const wrong = run('--subject', 'repo:e@1/harness@2:ref:refs/heads/main', '--subject', 'repo:e/fixture:ref:refs/heads/main');
      expect(wrong.status).toBe(1);
      expect(String(wrong.stderr)).toMatch(/not e\/fixture's default branch 'trunk'/);
      expect(String(wrong.stdout)).not.toMatch(/\$ aws/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPERATION: op, DIR: dir, QA_AWS_REGION: 'eu-central-1', QA_DYNAMO_TABLE: 't', QA_S3_BUCKET: 'b', GITHUB_REPOSITORY_ID: REPO, ...extra },
  });
  const SHA = 'd'.repeat(40);
  /** The values a logged query asked for. */
  const asked = (c: string[]) => JSON.parse(c[c.indexOf('--expression-attribute-values') + 1]!)[':p'].S as string;

  describe('last-green (the Explorer gate\'s queries, moved)', () => {
    it('writes the newest green full sweep\'s commit, from a server-side filtered query', () => {
      aws(`echo '{"Items":[{"commit":{"S":"${SHA}"}}]}'`);
      const r = run('last-green');
      expect(r.status).toBe(0);
      expect(readFileSync(join(dir, 'last-green'), 'utf8')).toBe(`${SHA}\n`);
      const [q] = logged();
      expect(q).toEqual(expect.arrayContaining(['--filter-expression', '#f = :zero AND #t = :all', '--max-items', '1', '--no-scan-index-forward', '--output', 'json']));
      expect(asked(q!), 'this repository\'s own partition (kanon#1346)').toBe(`RUN#explorer#${REPO}`);
      expect(logged()).toHaveLength(1);
    });

    it('an empty store is a quiet ok with no commit, after reading its own partition and then the unkeyed one', () => {
      aws(`echo '{"Items":[]}'`);
      const r = run('last-green');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('no sweep in the store yet');
      expect(readFileSync(join(dir, 'last-green'), 'utf8')).toBe('');
      expect(logged().map(asked)).toEqual([`RUN#explorer#${REPO}`, `RUN#explorer#${REPO}`, 'RUN#explorer', 'RUN#explorer']);
    });

    it('refuses to read with no repository id: degraded, so the lane sweeps', () => {
      aws(`echo '{"Items":[{"commit":{"S":"${SHA}"}}]}'`);
      expect(run('last-green', { GITHUB_REPOSITORY_ID: '' })).toMatchObject({ status: 1, stdout: expect.stringContaining('GITHUB_REPOSITORY_ID is \'\'') });
      expect(logged()).toEqual([]);
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
      pk: { S: `RUN#explorer#${REPO}` }, sk: { S: expect.stringMatching(/^\d{8}T\d{6}Z$/) }, commit: { S: SHA },
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
      expect(c[0]).toEqual(['s3', 'cp', join(dir, 'report.json'), `s3://b/repository/${REPO}/explorer/20261004T120000Z.json`, '--region', 'eu-central-1', '--only-show-errors']);
      const items = c.slice(1).map((x) => JSON.parse(x[x.indexOf('--item') + 1]!));
      expect(items[0]).toEqual({ pk: { S: `RUN#explorer#${REPO}` }, sk: { S: '20261004T120000Z' }, commit: { S: SHA }, trigger: { S: 'schedule' }, tier: { S: 'all' }, routes_swept: { N: '2' }, passed: { N: '1' }, failed: { N: '1' } });
      expect(items.slice(1).map((i) => [i.pk.S, i.sk.S, i.last_status.S])).toEqual([[`COVERAGE#${REPO}`, '/a', 'passed'], [`COVERAGE#${REPO}`, '/b', 'failed']]);
    });

    it('writes an audit run with its liveness flags only where the report has them, and an AREAS row per area', () => {
      aws('exit 0');
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ commit: SHA, trigger: 'schedule', files_read: 3, lines_cited: 9, turns: 20, complete: true, areas_scanned: ['scripts/a.mjs — the gate'] }));
      expect(run('put', { KIND: 'audit', QA_RUN_TS: '20261004T120000Z' }).status).toBe(0);
      const items = logged().slice(1).map((x) => JSON.parse(x[x.indexOf('--item') + 1]!));
      expect(logged()[0]).toContain(`s3://b/repository/${REPO}/audit/20261004T120000Z.json`);
      expect(items[0]).toMatchObject({ pk: { S: `RUN#audit#${REPO}` }, complete: { BOOL: true } });
      expect(items[0]).not.toHaveProperty('no_report');
      expect(items[1]).toMatchObject({ pk: { S: `AREAS#${REPO}` }, sk: { S: 'scripts/a.mjs' }, detail: { S: 'scripts/a.mjs — the gate' } });
      expect(items[0]).not.toHaveProperty('ended_unmarked');
    });

    it('writes an audit run that ended without its final write as `complete: true` and `ended_unmarked: true` (kanon#1135, kanon#1144)', () => {
      aws('exit 0');
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ commit: SHA, trigger: 'schedule', turns: 20, complete: true, ended_unmarked: true, no_report: false, report_invalid: false, areas_scanned: [] }));
      expect(run('put', { KIND: 'audit', QA_RUN_TS: '20261004T120000Z' }).status).toBe(0);
      const [row] = logged().slice(1).map((x) => JSON.parse(x[x.indexOf('--item') + 1]!));
      expect(row).toMatchObject({ pk: { S: `RUN#audit#${REPO}` }, complete: { BOOL: true }, ended_unmarked: { BOOL: true }, no_report: { BOOL: false }, report_invalid: { BOOL: false } });
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
        '  s3\\ cp\\ s3://b/repository/101/audit/*) echo "fatal error: An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 1;;',
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
      expect(r.stdout).toContain('no raw report at repository/101/audit/20261001T000000Z.json');
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
        '--expression-attribute-values', '{":p":{"S":"COST#implementer#101"},":s":{"S":"20260920T000000Z"}}',
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
    // This repository's own partition holds /a and /b (the migration copies legacy keys too), the
    // unkeyed one /c; another repository's partition is never asked for.
    aws([
      'case "$*" in',
      `  *query*COVERAGE#${REPO}*) printf 'signal sweep (dynamic): /a\\tsignal sweep (dynamic): /b\\n';;`,
      `  *query*'"COVERAGE"'*) printf 'signal sweep (dynamic): /c\\n';;`,
      '  *query*) echo None;;',
      'esac',
    ].join('\n'));
    const purge = (apply: string, repo = REPO) => spawnSync('bash', ['infra/qa-store/aws/purge-legacy-coverage.sh'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_AWS_REGION: 'r', QA_DYNAMO_TABLE: 't', APPLY: apply, GITHUB_REPOSITORY_ID: repo },
    });
    expect(purge('').stdout).toContain('3 legacy COVERAGE key(s) found');
    expect(logged().filter((c) => c[1] === 'delete-item')).toEqual([]);
    expect(logged().map(asked)).toEqual([`COVERAGE#${REPO}`, 'COVERAGE']);
    expect(purge('1').stdout).toContain('deleted 3 legacy COVERAGE key(s)');
    expect(logged().filter((c) => c[1] === 'delete-item').map((c) => {
      const key = JSON.parse(c[c.indexOf('--key') + 1]!);
      return [key.pk.S, key.sk.S];
    })).toEqual([[`COVERAGE#${REPO}`, 'signal sweep (dynamic): /a'], [`COVERAGE#${REPO}`, 'signal sweep (dynamic): /b'], ['COVERAGE', 'signal sweep (dynamic): /c']]);
    expect(purge('', OTHER).stdout).toContain('1 legacy COVERAGE key(s) found');
    expect(purge('', '').status).toBe(2);
  });
});

// kanon#1346 (the Owner's option 2) and kanon#1367: every row and raw report carries the
// repository, so repositories on one store read only their own; the unkeyed rows written before
// are read only while a repository has none of its own; the Owner's migration copies them under
// one repository's keys. Each case runs the store's scripts against `helpers/fake-aws-cli.mjs`, one
// table and one bucket in a temp directory that every call of the case shares.
describe('the store keys every row by repository (kanon#1346)', SPAWNS, () => {
  let work: string;
  let bin: string;
  let state: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'qa-store-keys-'));
    bin = join(work, 'bin');
    state = join(work, 'state');
    mkdirSync(bin);
    mkdirSync(state);
    writeStub(join(bin, 'aws'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(join(process.cwd(), 'tests/unit/helpers/fake-aws-cli.mjs'))} ${JSON.stringify(state)} "$@"\n`);
    writeStub(join(bin, 'gh'), `#!/usr/bin/env bash\necho '{"id":${REPO},"full_name":"o/r"}'\n`);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  type Item = Record<string, Record<string, unknown>>;
  const table = (): Item[] => (existsSync(join(state, 'table.json')) ? JSON.parse(readFileSync(join(state, 'table.json'), 'utf8')) : []);
  const bucket = (): Record<string, string> => (existsSync(join(state, 'bucket.json')) ? JSON.parse(readFileSync(join(state, 'bucket.json'), 'utf8')) : {});
  const seed = (items: Item[], objects: Record<string, string> = {}) => {
    writeFileSync(join(state, 'table.json'), JSON.stringify(items));
    writeFileSync(join(state, 'bucket.json'), JSON.stringify(objects));
  };
  const calls = (): string[][] => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** One store operation, as `repo`, in a fresh directory; returns the run and the directory. */
  const op = (repo: string, operation: string, extra: Record<string, string> = {}, files: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(work, 'op-'));
    for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), JSON.stringify(v));
    const r = spawnSync('bash', ['infra/qa-store/aws/store.sh'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPERATION: operation, DIR: dir, QA_AWS_REGION: 'r', QA_DYNAMO_TABLE: 't', QA_S3_BUCKET: 'b', GITHUB_REPOSITORY_ID: repo, ...extra },
    });
    return { r, dir, read: (f: string) => readFileSync(join(dir, f), 'utf8') };
  };
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const TS = '20261020T100000Z';
  const sweep = (commit: string, route: string) => ({ commit, trigger: 'schedule', tier: 'all', routes_swept: 1, passed: 1, failed: 0, routes: [{ route, status: 'passed' }] });
  const unkeyedSweep = (commit: string, sk: string): Item => ({ pk: { S: 'RUN#explorer' }, sk: { S: sk }, commit: { S: commit }, tier: { S: 'all' }, failed: { N: '0' }, trigger: { S: 'schedule' } });

  it('two repositories on one table see only their own rows: the gate, the coverage ledger, the areas, the cost rows and the export', () => {
    for (const [repo, commit, route, area] of [[REPO, A, '/a', 'src/a.ts'], [OTHER, B, '/b', 'src/b.ts']] as const) {
      expect(op(repo, 'put', { KIND: 'explorer', QA_RUN_TS: TS }, { 'report.json': sweep(commit, route) }).r.status).toBe(0);
      expect(op(repo, 'put', { KIND: 'audit', QA_RUN_TS: TS }, { 'report.json': { commit, trigger: 'schedule', complete: true, areas_scanned: [area] } }).r.status).toBe(0);
      expect(op(repo, 'put', { KIND: 'telemetry', QA_RUN_TS: TS }, { 'report.json': { agent: 'implementer', commit, outcome: 'ok', issue_number: Number(repo) } }).r.status).toBe(0);
    }
    // The keys, pinned: `COST#<agent>` included, which no test held before.
    expect(table().map((i) => i.pk!.S).sort()).toEqual([REPO, OTHER].flatMap((id) => [
      `AREAS#${id}`, `COST#implementer#${id}`, `COVERAGE#${id}`, `RUN#audit#${id}`, `RUN#explorer#${id}`,
    ]).sort());
    expect(Object.keys(bucket()).sort()).toEqual([REPO, OTHER].flatMap((id) => [
      `repository/${id}/audit/${TS}.json`, `repository/${id}/explorer/${TS}.json`, `repository/${id}/telemetry/implementer/${TS}.json`,
    ]).sort());

    // The gate: each repository's own newest green sweep, never the other's.
    expect(op(REPO, 'last-green').read('last-green')).toBe(`${A}\n`);
    expect(op(OTHER, 'last-green').read('last-green')).toBe(`${B}\n`);

    // The export: the runs, the coverage ledger, the areas and the raw reports, each its own.
    const e = op(REPO, 'export', { KIND: 'overseer', FROM: '20261001T000000Z' });
    expect(e.r.status, e.r.stdout + e.r.stderr).toBe(0);
    const ex = (f: string) => JSON.parse(e.read(`export/${f}`));
    expect(ex('runs-explorer.json').map((r: J) => r.commit)).toEqual([A]);
    expect(ex('runs-audit.json').map((r: J) => r.commit)).toEqual([A]);
    expect(ex('coverage.json').map((r: J) => r.route)).toEqual(['/a']);
    expect(ex('areas.json').map((r: J) => r.area)).toEqual(['src/a.ts']);
    expect(JSON.parse(e.read(`export/reports/explorer/${TS}.json`)).commit).toBe(A);
    expect(JSON.parse(e.read(`export/reports/audit/${TS}.json`)).commit).toBe(A);
    expect(op(OTHER, 'export', { KIND: 'audit', FROM: '20261001T000000Z' }).read('export/areas.json')).toContain('src/b.ts');

    // The cost rows: one repository's, under the same agent.
    const c = JSON.parse(op(REPO, 'cost-rows', { KIND: 'implementer', FROM: '20261001T000000Z' }).read('cost-rows.json'));
    expect(c).toEqual({ rows: [{ ts: TS, issue_number: REPO, outcome: 'ok', run_id: null }], error: null });

    // No read of either repository's lanes touched an unkeyed partition: each had rows of its own.
    const reads = calls().filter((x) => x[1] === 'query').map((x) => JSON.parse(x[x.indexOf('--expression-attribute-values') + 1]!)[':p'].S);
    expect(reads.filter((pk: string) => !/#\d+$/.test(pk))).toEqual([]);
  });

  it('two repositories putting the same kind in the same second keep both runs and both raw reports (kanon#1367)', () => {
    op(REPO, 'put', { KIND: 'explorer', QA_RUN_TS: TS }, { 'report.json': sweep(A, '/a') });
    op(OTHER, 'put', { KIND: 'explorer', QA_RUN_TS: TS }, { 'report.json': sweep(B, '/a') });
    const runs = table().filter((i) => String(i.pk!.S).startsWith('RUN#explorer#') && i.sk!.S === TS);
    expect(runs.map((i) => [i.pk!.S, i.commit!.S]).sort()).toEqual([[`RUN#explorer#${REPO}`, A], [`RUN#explorer#${OTHER}`, B]]);
    expect(JSON.parse(bucket()[`repository/${REPO}/explorer/${TS}.json`]!).commit).toBe(A);
    expect(JSON.parse(bucket()[`repository/${OTHER}/explorer/${TS}.json`]!).commit).toBe(B);
    // The same route, swept by both: two ledger rows, not one overwritten.
    expect(table().filter((i) => String(i.pk!.S).startsWith('COVERAGE#')).map((i) => i.last_seen_commit!.S).sort()).toEqual([A, B]);
  });

  it('a write with no repository id is refused, never written unkeyed', () => {
    const { r } = op('', 'put', { KIND: 'explorer', QA_RUN_TS: TS }, { 'report.json': sweep(A, '/a') });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GITHUB_REPOSITORY_ID is \'\'');
    expect(op('', 'record-skip', {}, { 'skip.json': { commit: A } }).r.status).toBe(2);
    expect(table()).toEqual([]);
    expect(bucket()).toEqual({});
  });

  describe('the unkeyed rows, written before kanon#1346, are read only while a partition has none of its own', () => {
    const UNKEYED: Item[] = [
      unkeyedSweep(A, '20261010T000000Z'),
      { pk: { S: 'COVERAGE' }, sk: { S: '/old' }, last_status: { S: 'passed' } },
      { pk: { S: 'AREAS' }, sk: { S: 'src/old.ts' }, commit: { S: A } },
      { pk: { S: 'RUN#audit' }, sk: { S: '20261010T000000Z' }, commit: { S: A } },
      { pk: { S: 'COST#implementer' }, sk: { S: '20261010T000000Z' }, outcome: { S: 'ok' } },
    ];

    it('before the repository writes anything: the gate, the export with its raw reports, and the cost rows read the unkeyed rows, and say so', () => {
      seed(UNKEYED, { 'explorer/20261010T000000Z.json': JSON.stringify({ commit: A }) });
      const g = op(REPO, 'last-green');
      expect(g.read('last-green')).toBe(`${A}\n`);
      expect(g.r.stdout).toContain(`RUN#explorer#${REPO} holds no sweep of this repository's yet, so the gate reads the store's unkeyed RUN#explorer`);

      const e = op(REPO, 'export', { KIND: 'overseer', FROM: '20261001T000000Z' });
      expect(e.r.status, e.r.stdout + e.r.stderr).toBe(0);
      expect(JSON.parse(e.read('export/coverage.json'))).toEqual([{ route: '/old', last_status: 'passed' }]);
      expect(JSON.parse(e.read('export/areas.json')).map((r: J) => r.area)).toEqual(['src/old.ts']);
      expect(JSON.parse(e.read('export/reports/explorer/20261010T000000Z.json'))).toEqual({ commit: A });
      expect(e.r.stdout).toContain('::notice title=qa-store export::this repository has no COVERAGE rows of its own yet');

      expect(JSON.parse(op(REPO, 'cost-rows', { KIND: 'implementer', FROM: '20261001T000000Z' }).read('cost-rows.json')).rows.map((r: J) => r.ts)).toEqual(['20261010T000000Z']);
    });

    it('after its first row in a partition, the repository reads only its own there', () => {
      // Unkeyed rows inside the later window too, so a fallback on an empty window would show.
      seed([...UNKEYED, unkeyedSweep(A, '20261101T000000Z'), { pk: { S: 'COST#implementer' }, sk: { S: '20261101T000000Z' }, outcome: { S: 'ok' } }]);
      op(REPO, 'put', { KIND: 'explorer', QA_RUN_TS: TS }, { 'report.json': sweep(B, '/new') });
      op(REPO, 'put', { KIND: 'telemetry', QA_RUN_TS: TS }, { 'report.json': { agent: 'implementer', commit: B, outcome: 'ok' } });
      expect(op(REPO, 'last-green').read('last-green')).toBe(`${B}\n`);
      const e = op(REPO, 'export', { KIND: 'overseer', FROM: '20261001T000000Z' });
      expect(JSON.parse(e.read('export/coverage.json')).map((r: J) => r.route)).toEqual(['/new']);
      expect(JSON.parse(e.read('export/runs-explorer.json')).map((r: J) => r.commit)).toEqual([B]);
      // The audit has written nothing of its own yet, so its partitions still fall back.
      expect(JSON.parse(e.read('export/areas.json')).map((r: J) => r.area)).toEqual(['src/old.ts']);
      // An empty window is not an empty partition: no fallback when the repository has rows before it.
      expect(JSON.parse(op(REPO, 'export', { KIND: 'overseer', FROM: '20261031T000000Z' }).read('export/runs-explorer.json'))).toEqual([]);
      expect(JSON.parse(op(REPO, 'cost-rows', { KIND: 'implementer', FROM: '20261031T000000Z' }).read('cost-rows.json')).rows).toEqual([]);
    });

    it('a repository whose own partition holds only the skip the gate recorded against the unkeyed baseline still reads that baseline', () => {
      seed(UNKEYED);
      expect(op(REPO, 'record-skip', {}, { 'skip.json': { commit: A } }).r.status).toBe(0);
      const g = op(REPO, 'last-green');
      expect(g.r.status, g.r.stdout).toBe(0);
      expect(g.read('last-green')).toBe(`${A}\n`);
    });
  });

  it('the docs name every keyed partition, the raw reports\' root, the fallback and the migration\'s command', () => {
    const doc = readFileSync('docs/qa-store.md', 'utf8');
    const section = doc.slice(doc.indexOf('### Rows by repository'), doc.indexOf('### Provision a store'));
    for (const pk of [...UNKEYED_PARTITIONS, 'COST#<agent>']) expect(section).toContain(`\`${pk}#<id>\``);
    expect(section).toContain(`\`${REPORTS_ROOT}/<id>/<kind>/<ts>.json\``);
    expect(section).toContain('no row of its own');
    expect(doc).toContain('node infra/qa-store/aws/migrate-to-repository-keys.mjs --repository <owner>/<repo> --region <region> --bucket <BucketName>');
  });

  describe('the migration (migrate-to-repository-keys.mjs, the Owner runs it)', () => {
    const migrate = (...flags: string[]) => spawnSync('node', ['infra/qa-store/aws/migrate-to-repository-keys.mjs',
      '--repository', 'o/r', '--region', 'r', '--bucket', 'b', '--table', 't', ...flags], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const STORE: Item[] = [
      unkeyedSweep(A, '20261010T000000Z'),
      { pk: { S: 'COVERAGE' }, sk: { S: '/a' }, last_status: { S: 'failed' } },
      { pk: { S: 'COVERAGE' }, sk: { S: '/old' }, last_status: { S: 'passed' } },
      { pk: { S: 'COST#implementer' }, sk: { S: '20261010T000000Z' }, outcome: { S: 'ok' } },
      // Written by the repository's lane since the pin moved: newer, and kept as it is.
      { pk: { S: `COVERAGE#${REPO}` }, sk: { S: '/a' }, last_status: { S: 'passed' } },
      // Another repository's own row, which the migration never touches.
      { pk: { S: `COVERAGE#${OTHER}` }, sk: { S: '/b' }, last_status: { S: 'passed' } },
    ];
    const OBJECTS = { 'explorer/20261010T000000Z.json': '{"commit":"x"}', 'telemetry/implementer/20261010T000000Z.json': '{}', [`repository/${OTHER}/explorer/${TS}.json`]: '{}' };

    it('a dry run prints what it would copy and writes nothing', () => {
      seed(STORE, OBJECTS);
      const r = migrate();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`o/r is repository id ${REPO}`);
      expect(r.stdout).toContain(`COVERAGE → COVERAGE#${REPO}: would copy 1 row(s); 1 already there.`);
      expect(r.stdout).toContain(`RUN#explorer → RUN#explorer#${REPO}: would copy 1 row(s); 0 already there.`);
      expect(r.stdout).toContain(`COST#implementer → COST#implementer#${REPO}: would copy 1 row(s)`);
      expect(r.stdout).toContain(`Raw reports → repository/${REPO}/: would copy 2; 0 already there.`);
      expect(r.stdout).toContain('Dry run: nothing written. Re-run with --apply to copy 3 row(s) and 2 report(s).');
      expect(calls().filter((c) => c[1] === 'put-item' || c[1] === 'cp')).toEqual([]);
      expect(table()).toEqual(STORE);
      expect(bucket()).toEqual(OBJECTS);
    });

    it('--apply copies under the repository\'s keys, keeps what is there, deletes nothing, and a second run copies nothing', () => {
      seed(STORE, OBJECTS);
      const r = migrate('--apply');
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Copied 3 row(s) and 2 report(s)');
      const after = table();
      expect(after).toEqual(expect.arrayContaining(STORE));
      expect(after).toHaveLength(STORE.length + 3);
      const own = (pk: string, sk: string) => after.find((i) => i.pk!.S === pk && i.sk!.S === sk);
      expect(own(`COVERAGE#${REPO}`, '/a')!.last_status).toEqual({ S: 'passed' });
      expect(own(`COVERAGE#${REPO}`, '/old')!.last_status).toEqual({ S: 'passed' });
      expect(own(`RUN#explorer#${REPO}`, '20261010T000000Z')!.commit).toEqual({ S: A });
      expect(own(`COST#implementer#${REPO}`, '20261010T000000Z')!.outcome).toEqual({ S: 'ok' });
      expect(after.filter((i) => i.pk!.S === `COVERAGE#${OTHER}`)).toHaveLength(1);
      for (const put of calls().filter((c) => c[1] === 'put-item')) expect(put).toEqual(expect.arrayContaining(['--condition-expression', 'attribute_not_exists(pk)']));
      expect(bucket()[`repository/${REPO}/explorer/20261010T000000Z.json`]).toBe('{"commit":"x"}');
      expect(bucket()[`repository/${REPO}/telemetry/implementer/20261010T000000Z.json`]).toBe('{}');
      expect(bucket()['explorer/20261010T000000Z.json']).toBe('{"commit":"x"}');

      // The readers now find the history under the repository's own key.
      expect(op(REPO, 'last-green').read('last-green')).toBe(`${A}\n`);
      expect(calls().filter((c) => c[1] === 'query').every((c) => /#\d+"/.test(c[c.indexOf('--expression-attribute-values') + 1]!))).toBe(true);

      const again = migrate('--apply');
      expect(again.stdout).toContain('Copied 0 row(s) and 0 report(s)');
      expect(table()).toHaveLength(STORE.length + 3);
    });

    it('refuses without its required flags, and fails when GitHub gives no id', () => {
      expect(spawnSync('node', ['infra/qa-store/aws/migrate-to-repository-keys.mjs', '--repository', 'o/r'], { encoding: 'utf8' }).status).toBe(2);
      writeStub(join(bin, 'gh'), '#!/usr/bin/env bash\necho \'{"message":"Not Found"}\'\n');
      const r = migrate();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('GitHub gave no repository id for o/r');
      expect(calls()).toEqual([]);
    });
  });
});
