import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { STACK, commands } from '../../infra/status/deploy.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { writeStub } from './helpers/stub-bin.js';

/**
 * Project #1327, Issue I: the deploy hook's script, `infra/status/deploy.mjs`, which the operator's
 * deploy job runs at the pinned Kanon with the environment's role. It packages the build into the
 * artifacts bucket and deploys `kanon-status` through the CloudFormation service role, every
 * parameter from the environment's variables. No secret passes through it (the Owner's Q1): the
 * client secret is the SSM parameter the Owner puts by hand, and only its name is a parameter.
 */

const ROLE = 'arn:aws:iam::123456789012:role/kanon-deploy-cloudformation';
const OPTIONS = {
  artifact: '/runner/build', packaged: '/runner/tmp/packaged.yaml', bucket: 'kanon-deploy-artifacts', roleArn: ROLE, region: 'eu-central-1',
  release: 'v0.43.0', clientId: 'Iv23liStatusApp', secretParameter: '/kanon-status/github-client-secret', redirects: '', reservedConcurrency: '4', permissionsBoundaryArn: '',
};

describe("the status server's deploy", () => {
  it('packages, then deploys kanon-status through the service role with every parameter, then reads its status and address', () => {
    expect(STACK).toBe('kanon-status');
    expect(commands(OPTIONS)).toEqual([
      ['cloudformation', 'package', '--region', 'eu-central-1', '--template-file', '/runner/build/template.yaml', '--s3-bucket', 'kanon-deploy-artifacts', '--s3-prefix', 'kanon-status', '--output-template-file', '/runner/tmp/packaged.yaml'],
      ['cloudformation', 'deploy', '--region', 'eu-central-1', '--stack-name', 'kanon-status', '--template-file', '/runner/tmp/packaged.yaml', '--role-arn', ROLE,
        '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--parameter-overrides',
        'GitHubClientId=Iv23liStatusApp', 'GitHubClientSecretParameter=/kanon-status/github-client-secret', 'Redirects=', 'Release=v0.43.0', 'ReservedConcurrency=4', 'PermissionsBoundaryArn='],
    ]);
  });

  it('passes every template parameter, so a variable removed resets it rather than keeping the last value', () => {
    const params = Object.keys(parse(readFileSync('infra/status/template.yaml', 'utf8')).Parameters);
    const deploy = commands(OPTIONS)[1]!;
    const passed = deploy.slice(deploy.indexOf('--parameter-overrides') + 1).map((p) => p.split('=')[0]);
    expect(passed.sort()).toEqual(params.sort());
  });
});

describe("the status server's deploy, as the hook runs it", SPAWNS, () => {
  const setup = (describe: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'status-deploy-'));
    const calls = join(dir, 'calls');
    writeStub(join(dir, 'aws'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [ "$2" = describe-stacks ]; then ${describe}; fi
`);
    const run = (args: string[]) => spawnSync(process.execPath, ['infra/status/deploy.mjs', ...args], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir } });
    return { dir, calls, run };
  };
  const ARGS = ['--artifact', '/runner/build', '--bucket', 'kanon-deploy-artifacts', '--role-arn', ROLE, '--release', 'v0.43.0', '--client-id', 'Iv23liStatusApp'];

  it("runs the three calls, and prints the stack's status and the server's address alone", () => {
    const { calls, run } = setup("printf 'UPDATE_COMPLETE\\thttps://abc.lambda-url.eu-central-1.on.aws/mcp\\n'");
    const r = run(ARGS);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('kanon-status: UPDATE_COMPLETE, serving https://abc.lambda-url.eu-central-1.on.aws/mcp\n');
    const lines = readFileSync(calls, 'utf8').trim().split('\n');
    expect(lines.map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['cloudformation package', 'cloudformation deploy', 'cloudformation describe-stacks']);
    expect(lines[1]).toContain('ReservedConcurrency=4 PermissionsBoundaryArn=');
    expect(lines[1]).toContain('GitHubClientSecretParameter=/kanon-status/github-client-secret');
  });

  it('fails when the stack is not complete', () => {
    const { run } = setup("printf 'UPDATE_ROLLBACK_COMPLETE\\tNone\\n'");
    const r = run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/kanon-status is UPDATE_ROLLBACK_COMPLETE/);
  });

  it('refuses before any call when an input is missing or malformed', () => {
    for (const [args, message] of [
      [ARGS.filter((a, i) => a !== '--bucket' && ARGS[i - 1] !== '--bucket'), /--bucket/],
      [ARGS.filter((a, i) => a !== '--client-id' && ARGS[i - 1] !== '--client-id'), /--client-id/],
      [ARGS.map((a) => (a === ROLE ? 'kanon-deploy' : a)), /--role-arn/],
      [[...ARGS, '--reserved-concurrency', '0'], /--reserved-concurrency/],
    ] as const) {
      const { calls, run } = setup('true');
      const r = run([...args]);
      expect(r.status, String(message)).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(() => readFileSync(calls, 'utf8')).toThrow();
    }
  });
});
