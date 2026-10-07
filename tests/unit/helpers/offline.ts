import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { writeStub } from './stub-bin.js';

/**
 * Keep the real `gh` and `aws` out of reach of every test (#524).
 *
 * WHY. Most of the library calls `gh` (and the QA store `aws`) by name, through PATH, and a
 * case stubs it by putting a fake first on PATH (writeStub) or by injecting a function. A
 * case that forgets reaches the real one, with the login of whoever runs the suite: PR
 * #523 found three `lead-reconcile` cases that ran the real `gh run list`, and failed only
 * because `REPO` happened to be unset. With `GITHUB_REPOSITORY` set, as in every Actions
 * job, they would have read GitHub as the caller.
 *
 * HOW. Two layers, set in the main process before the workers start, so every worker and
 * every process a case starts with `process.env` inherits them:
 *   · a trap `gh` and `aws` first on PATH, which fail at once and say why. A case's own
 *     stub still wins, because it puts its directory before this one.
 *   · for a case that builds a PATH of its own without the trap: no GitHub or AWS token
 *     in the environment, and a `GH_CONFIG_DIR` with no stored login, so a real `gh` stops
 *     at "gh auth login" before any request. Likewise a real `aws` (#534): it reads config
 *     and credentials files that don't exist rather than `~/.aws`, whose default profile
 *     (static keys, SSO, `credential_process`) would otherwise sign it in, and it asks no
 *     instance metadata service, so it stops at "Unable to locate credentials".
 */
const TOOLS = ['gh', 'aws'];
const SECRETS = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_BEARER_TOKEN_BEDROCK',
];

const trap = (tool: string): string => [
  '#!/usr/bin/env bash',
  `echo "tests: the real ${tool} is unreachable from the test suite (tests/unit/helpers/offline.ts), and this case ran \\\`${tool} $*\\\`." >&2`,
  `echo "Stub it: put a fake ${tool} first on PATH (writeStub, tests/unit/helpers/stub-bin.ts), or inject the function that calls it." >&2`,
  'exit 1',
  '',
].join('\n');

/** Run as a `globalSetup` (vitest.config.ts); returns the teardown. */
export const setup = (): (() => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-test-offline-'));
  const bin = join(dir, 'bin');
  const config = join(dir, 'gh-config');
  mkdirSync(bin);
  mkdirSync(config);
  for (const tool of TOOLS) writeStub(join(bin, tool), trap(tool));
  for (const name of SECRETS) delete process.env[name];
  process.env.GH_CONFIG_DIR = config;
  process.env.AWS_CONFIG_FILE = join(dir, 'aws', 'config');
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'aws', 'credentials');
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  return () => rmSync(dir, { recursive: true, force: true });
};
