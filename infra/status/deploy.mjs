#!/usr/bin/env node
// The hosted status server's deploy (project #1327, Issue I), which the operator's deploy hook
// runs at the pinned Kanon, after it has assumed the `production` environment's role:
//
//   node "$KANON/infra/status/deploy.mjs" --artifact <the build> --bucket <artifacts bucket> \
//     --role-arn <CloudFormation service role> --release <tag> --client-id <the App's client id> \
//     [--secret-parameter <name>] [--redirects <list>] [--reserved-concurrency <n>] \
//     [--permissions-boundary-arn <arn>] [--legacy-deprecated-since <YYYY-MM-DD>] [--region eu-central-1]
//
// It packages the build (`build.mjs`'s output) into the artifacts bucket, deploys the stack
// `kanon-status` through the service role, and prints the stack's status and the server's address,
// and nothing else. Every template parameter is passed on every deploy, from the environment's
// variables the hook maps to these flags, so a variable removed resets its parameter rather than
// keeping the last deploy's value.
//
// THE DATE 2025-11-25 WAS DEPRECATED (#1423), which every answer at that MCP revision carries, is
// `--legacy-deprecated-since`. With none, it is this deploy's own date, in UTC: the first deploy
// ships the deprecation, so the operator sets the variable to that date to keep it.
//
// NO SECRET PASSES THROUGH IT (the Owner's Q1, 2026-10-26). The status App's client secret is an
// SSM parameter the Owner puts by hand, and only its name is a parameter. So the hook needs no
// `KANON_DEPLOY_SECRET`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** The stack's name. */
export const STACK = 'kanon-status';
/** The states a deploy or a smoke accepts the stack in. */
export const COMPLETE = ['CREATE_COMPLETE', 'UPDATE_COMPLETE'];

/**
 * @typedef {{
 *   artifact: string, packaged: string, bucket: string, roleArn: string, region: string,
 *   release: string, clientId: string, secretParameter: string, redirects: string,
 *   reservedConcurrency: string, permissionsBoundaryArn: string, deprecatedSince: string,
 * }} Options
 */

/**
 * The `aws` calls that package and deploy, in order.
 * @param {Options} o
 * @returns {string[][]}
 */
export function commands(o) {
  return [
    ['cloudformation', 'package', '--region', o.region, '--template-file', join(o.artifact, 'template.yaml'), '--s3-bucket', o.bucket, '--s3-prefix', STACK, '--output-template-file', o.packaged],
    ['cloudformation', 'deploy', '--region', o.region, '--stack-name', STACK, '--template-file', o.packaged, '--role-arn', o.roleArn,
      '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--parameter-overrides',
      `GitHubClientId=${o.clientId}`, `GitHubClientSecretParameter=${o.secretParameter}`, `Redirects=${o.redirects}`, `Release=${o.release}`,
      `ReservedConcurrency=${o.reservedConcurrency}`, `PermissionsBoundaryArn=${o.permissionsBoundaryArn}`, `LegacyDeprecatedSince=${o.deprecatedSince}`],
  ];
}

/**
 * The stack's status and the server's address, as `aws` reports them.
 * @param {string} region
 * @param {(args: string[]) => string} [aws]
 * @returns {{ status: string, url: string | null }}
 */
export function stackState(region, aws = (args) => execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })) {
  const out = aws(['cloudformation', 'describe-stacks', '--region', region, '--stack-name', STACK, '--query', "Stacks[0].[StackStatus, Outputs[?OutputKey=='McpUrl'].OutputValue | [0]]", '--output', 'text']);
  const [status = '', url = ''] = out.trim().split(/\s+/);
  return { status, url: /^https?:\/\//.test(url) ? url : null };
}

/** A usage error: exit 2, before any call. @param {string} message */
const usage = (message) => {
  process.stderr.write(`kanon-status: ${message}\n`);
  process.exit(2);
};

if (isCliEntry(import.meta.url)) {
  const { values: v } = parseArgs({
    options: Object.fromEntries(['artifact', 'bucket', 'role-arn', 'release', 'client-id', 'secret-parameter', 'redirects', 'reserved-concurrency', 'permissions-boundary-arn', 'legacy-deprecated-since', 'region'].map((k) => [k, { type: 'string' }])),
  });
  for (const k of ['artifact', 'bucket', 'role-arn', 'release', 'client-id']) if (!v[k]) usage(`--${k} is required`);
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(String(v['role-arn']))) usage('--role-arn is a role ARN: the CloudFormation service role the bootstrap stack holds');
  if (v['reserved-concurrency'] && !/^[1-9]\d*$/.test(String(v['reserved-concurrency']))) usage('--reserved-concurrency is a whole number of 1 or more');
  const since = String(v['legacy-deprecated-since'] || new Date().toISOString().slice(0, 10));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(since) ? Date.parse(`${since}T00:00:00Z`) : NaN;
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== since) usage('--legacy-deprecated-since is a date, YYYY-MM-DD');
  const region = String(v.region || 'eu-central-1');
  /** @type {Options} */
  const options = {
    artifact: resolve(String(v.artifact)),
    packaged: join(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'kanon-status-')), 'packaged.yaml'),
    bucket: String(v.bucket),
    roleArn: String(v['role-arn']),
    region,
    release: String(v.release),
    clientId: String(v['client-id']),
    secretParameter: String(v['secret-parameter'] || '/kanon-status/github-client-secret'),
    redirects: String(v.redirects ?? ''),
    reservedConcurrency: String(v['reserved-concurrency'] || '4'),
    permissionsBoundaryArn: String(v['permissions-boundary-arn'] ?? ''),
    deprecatedSince: since,
  };
  try {
    // `aws`'s own output names the stack's resources and the change set, so it isn't printed.
    for (const args of commands(options)) execFileSync('aws', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    process.stderr.write(`kanon-status: the deploy failed: read the stack's events (aws cloudformation describe-stack-events --stack-name ${STACK})\n`);
    process.exit(1);
  }
  const { status, url } = stackState(region);
  if (!COMPLETE.includes(status) || !url) {
    process.stderr.write(`kanon-status: ${STACK} is ${status || 'unknown'}, not ${COMPLETE.join(' or ')} with an address\n`);
    process.exit(1);
  }
  process.stdout.write(`${STACK}: ${status}, serving ${url}\n`);
}
