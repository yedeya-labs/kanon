#!/usr/bin/env node
// Provision Kanon's AWS QA store in the adopter's own account (plan 0004 §3.2, step P9;
// `K-OBS-17`), from `template.yaml`, with nothing beyond Node and the AWS CLI.
//
//   node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> \
//     [--profile <profile>] [--no-oidc-provider] [--dry-run]
//
// It checks the template first, with the same functions the unit test runs, and refuses to deploy
// one that fails them: the table and the bucket must be retained and the table protected from
// deletion, nothing in their lifecycle may name or depend on an application stage, and the role
// must trust exactly the repository's `kanon-qa-store` environment. Then it deploys the stack
// `kanon-qa-store`, turns on the stack's termination protection, and prints the outputs the
// adopter's store hook names. `--dry-run` prints the commands and runs none.
//
// One store per account and region: the table is `kanon-qa-store`, and the bucket carries the
// account id and region, because bucket names are global. The commands are the account owner's to
// run (`K-OBS-9`): nothing here costs anything until they do.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

import { STORE_ENVIRONMENT } from '../../../actions/qa-store/qa-store.mjs';
import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(HERE, 'template.yaml');
export const STACK_NAME = 'kanon-qa-store';
/** The resources that hold the adopter's QA data, and must outlive the stack. */
export const STORE_RESOURCES = { table: 'AWS::DynamoDB::Table', bucket: 'AWS::S3::Bucket' };

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const OIDC_SUB = 'token.actions.githubusercontent.com:sub';
/** A word that names an application stage, wherever it appears in a store resource's lifecycle. */
const STAGE_WORD = /(^|[^a-z])(stages?|staging|prod|production|dev|development|preview)([^a-z]|$)/i;

/** @typedef {{ Type: string, Condition?: string, DeletionPolicy?: string, UpdateReplacePolicy?: string, Properties?: Record<string, any> }} Resource */

/** Every string in a value, with the path it sits at. @param {unknown} v @param {string} at @returns {Array<[string, string]>} */
const strings = (v, at) => {
  if (typeof v === 'string') return [[at, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${at}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [...strings(k, `${at}.<key>`), ...strings(x, `${at}.${k}`)]);
  return [];
};

/**
 * What in the template ties the store's lifecycle to the stack or to a stage (`K-OBS-17`'s
 * lifecycle clause), and what leaves the table deletable.
 * @param {any} template
 * @returns {string[]}
 */
export function lifecycleProblems(template) {
  /** @type {string[]} */
  const out = [];
  const resources = /** @type {Record<string, Resource>} */ (template?.Resources ?? {});
  const params = Object.keys(template?.Parameters ?? {});
  for (const p of params) if (STAGE_WORD.test(p)) out.push(`parameter ${p} names a stage`);
  for (const [kind, type] of Object.entries(STORE_RESOURCES)) {
    const found = Object.entries(resources).filter(([, r]) => r.Type === type);
    if (found.length !== 1) { out.push(`the template has ${found.length} ${type} resources, not one ${kind}`); continue; }
    const [id, r] = /** @type {[string, Resource]} */ (found[0]);
    if (r.DeletionPolicy !== 'Retain') out.push(`${id} has no DeletionPolicy: Retain`);
    if (r.UpdateReplacePolicy !== 'Retain') out.push(`${id} has no UpdateReplacePolicy: Retain`);
    if (r.Condition !== undefined) out.push(`${id} exists only under the condition ${r.Condition}`);
    if (type === STORE_RESOURCES.table && r.Properties?.DeletionProtectionEnabled !== true) out.push(`${id} has no deletion protection`);
    for (const [at, s] of strings({ id, ...r }, id)) {
      if (STAGE_WORD.test(s)) out.push(`${at} names a stage ('${s}')`);
      // A reference to a parameter makes the resource's name or existence the parameter's.
      const ref = /\$\{([A-Za-z0-9]+)\}/g;
      for (const m of s.matchAll(ref)) if (params.includes(m[1] ?? '')) out.push(`${at} depends on the parameter ${m[1]}`);
    }
    for (const [at, v] of Object.entries(r.Properties ?? {})) {
      if (v && typeof v === 'object' && 'Ref' in v && params.includes(v.Ref)) out.push(`${id}.Properties.${at} is the parameter ${v.Ref}`);
    }
  }
  return out;
}

/**
 * Every OIDC subject a role in the template trusts, and what's wrong with any of them: each must
 * be exactly `repo:${Repository}:environment:kanon-qa-store` (decision 9).
 * @param {any} template
 * @returns {string[]}
 */
export function environmentProblems(template) {
  /** @type {string[]} */
  const out = [];
  const want = `repo:\${Repository}:environment:${STORE_ENVIRONMENT}`;
  const roles = Object.entries(/** @type {Record<string, Resource>} */ (template?.Resources ?? {})).filter(([, r]) => r.Type === 'AWS::IAM::Role');
  if (roles.length === 0) out.push('the template has no role');
  for (const [id, r] of roles) {
    for (const s of r.Properties?.AssumeRolePolicyDocument?.Statement ?? []) {
      const cond = s.Condition ?? {};
      if (Object.keys(cond).some((k) => /Like/.test(k))) out.push(`${id} trusts a pattern`);
      const sub = cond.StringEquals?.[OIDC_SUB];
      const subs = [sub].flat().map((x) => (x && typeof x === 'object' && 'Fn::Sub' in x ? x['Fn::Sub'] : x));
      if (sub === undefined) { out.push(`${id} trusts no OIDC subject`); continue; }
      for (const x of subs) if (x !== want) out.push(`${id} trusts '${x}', not '${want}'`);
    }
  }
  return out;
}

/**
 * The commands that provision the store.
 * @param {{ repository: string, region: string, profile?: string, oidcProvider?: boolean, template?: string }} o
 * @returns {string[][]}
 */
export function deployCommands({ repository, region, profile, oidcProvider = true, template = TEMPLATE_PATH }) {
  if (!REPOSITORY.test(repository)) throw new Error(`--repository '${repository}' is not owner/name`);
  if (!REGION.test(region)) throw new Error(`--region '${region}' is not an AWS region`);
  const common = ['--region', region, ...(profile ? ['--profile', profile] : [])];
  return [
    ['aws', 'cloudformation', 'deploy', ...common, '--stack-name', STACK_NAME, '--template-file', template,
      '--parameter-overrides', `Repository=${repository}`, `CreateOidcProvider=${oidcProvider ? 'true' : 'false'}`,
      '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset'],
    ['aws', 'cloudformation', 'update-termination-protection', ...common, '--stack-name', STACK_NAME, '--enable-termination-protection'],
    ['aws', 'cloudformation', 'describe-stacks', ...common, '--stack-name', STACK_NAME, '--query', 'Stacks[0].Outputs', '--output', 'table'],
  ];
}

/** @param {string} [path] */
export const readTemplate = (path = TEMPLATE_PATH) => parse(readFileSync(path, 'utf8'));

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      region: { type: 'string' },
      profile: { type: 'string' },
      'no-oidc-provider': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  try {
    if (!values.repository || !values.region) throw new Error('usage: provision.mjs --repository <owner>/<repo> --region <region> [--profile <profile>] [--no-oidc-provider] [--dry-run]');
    const problems = [...lifecycleProblems(readTemplate()), ...environmentProblems(readTemplate())];
    if (problems.length) throw new Error(`the template fails its checks: ${problems.join('; ')}`);
    const commands = deployCommands({ repository: values.repository, region: values.region, profile: values.profile, oidcProvider: !values['no-oidc-provider'] });
    for (const c of commands) {
      console.log(`$ ${c.join(' ')}`);
      if (!values['dry-run']) execFileSync(c[0] ?? 'aws', c.slice(1), { stdio: 'inherit' });
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
