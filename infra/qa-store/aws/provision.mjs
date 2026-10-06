#!/usr/bin/env node
// Provision Kanon's AWS QA store in the adopter's own account (plan 0004 §3.2, step P9;
// `K-OBS-17`), from `template.yaml`, with nothing beyond Node, `gh` and the AWS CLI.
//
//   node infra/qa-store/aws/provision.mjs --repository <owner>/<repo> --region <region> \
//     [--subject <exact OIDC subject>]... [--profile <profile>] [--no-oidc-provider] [--dry-run]
//
// It checks the template first, with the same functions the unit test runs, and refuses to deploy
// one that fails them: the table and the bucket must be retained and the table protected from
// deletion, nothing in their lifecycle may name or depend on an application stage, and the role
// must trust exactly the `Subjects` parameter, never a pattern.
//
// THE SUBJECT IS THE DEFAULT BRANCH'S REF (decision 9, as the Owner changed it on 2026-10-05):
// `<prefix>:ref:refs/heads/<default branch>`. Both halves come from GitHub's API, never from a
// guess: the default branch from `repos/<o>/<r>`, and the prefix from
// `repos/<o>/<r>/actions/oidc/customization/sub`, because GitHub gives a repository created after
// 2026-07-15 an immutable subject (`repo:<owner>@<owner id>/<repo>@<repo id>`), which a role
// trusting `repo:<owner>/<repo>` refuses. A repository with a custom subject template is refused
// unless `--subject` names the exact subject. `--subject` may be repeated, to trust both forms
// while a repository migrates between them; each must still be a ref subject of the repository
// named, for its default branch, which is read from the API even when every subject is given.
//
// Then it deploys the stack `kanon-qa-store`, turns on the stack's termination protection, and
// prints the outputs the adopter's store hook names. `--dry-run` reads GitHub's API and prints the
// AWS commands, running none.
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

import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';
import { readRepositorySubject, subjectProblems } from '../../../scripts/lib/oidc-subject.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(HERE, 'template.yaml');
export const STACK_NAME = 'kanon-qa-store';
/** The resources that hold the adopter's QA data, and must outlive the stack. */
export const STORE_RESOURCES = { table: 'AWS::DynamoDB::Table', bucket: 'AWS::S3::Bucket' };

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const OIDC_SUB = 'token.actions.githubusercontent.com:sub';
const OIDC_AUD = 'token.actions.githubusercontent.com:aud';
/** The template parameter that carries the subjects. */
export const SUBJECTS_PARAMETER = 'Subjects';
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
 * What's wrong with the template's trust (decision 9): every role trusts GitHub's OIDC audience
 * for STS and exactly the `Subjects` parameter as the subject, by `StringEquals`. The subjects
 * themselves are checked by `subjectProblems` before they are passed.
 * @param {any} template
 * @returns {string[]}
 */
export function trustProblems(template) {
  /** @type {string[]} */
  const out = [];
  const param = template?.Parameters?.[SUBJECTS_PARAMETER];
  if (param?.Type !== 'CommaDelimitedList') out.push(`the template has no ${SUBJECTS_PARAMETER} parameter of type CommaDelimitedList`);
  const roles = Object.entries(/** @type {Record<string, Resource>} */ (template?.Resources ?? {})).filter(([, r]) => r.Type === 'AWS::IAM::Role');
  if (roles.length === 0) out.push('the template has no role');
  for (const [id, r] of roles) {
    for (const s of r.Properties?.AssumeRolePolicyDocument?.Statement ?? []) {
      const cond = s.Condition ?? {};
      if (Object.keys(cond).some((k) => /Like/.test(k))) out.push(`${id} trusts a pattern`);
      if (cond.StringEquals?.[OIDC_AUD] !== 'sts.amazonaws.com') out.push(`${id} trusts an audience other than sts.amazonaws.com`);
      const sub = cond.StringEquals?.[OIDC_SUB];
      if (sub === undefined) { out.push(`${id} trusts no OIDC subject`); continue; }
      if (JSON.stringify(sub) !== JSON.stringify({ Ref: SUBJECTS_PARAMETER })) out.push(`${id} trusts ${JSON.stringify(sub)}, not exactly the ${SUBJECTS_PARAMETER} parameter`);
    }
  }
  return out;
}

/**
 * The repository's default branch and the subjects the store trusts: `given` when there are any,
 * else the default branch's ref subject in the repository's own form. Both are read from GitHub's
 * API through `scripts/lib/oidc-subject.mjs`, the one reading the telemetry store's `render.mjs`
 * uses too, so the two stores can't come to trust different subjects (kanon#295). The default
 * branch is read even when every subject is given, so a `--subject` naming another branch is
 * refused; so is a `--repository` GitHub spells differently (a rename's redirect, another case),
 * since IAM compares the subject case-sensitively.
 * @param {string} repository owner/name
 * @param {string[]} given the `--subject` values
 * @param {(args: string[]) => string} [gh]
 * @returns {{ defaultBranch: string, subjects: string[] }}
 */
export function trustedSubjects(repository, given, gh) {
  const { defaultBranch, prefix, problem } = readRepositorySubject(repository, gh);
  if (given.length) return { defaultBranch, subjects: given };
  if (prefix === null) throw new Error(`${problem} (pass each with --subject)`);
  return { defaultBranch, subjects: [`${prefix}:ref:refs/heads/${defaultBranch}`] };
}

/**
 * The commands that provision the store.
 * @param {{ repository: string, subjects: string[], defaultBranch: string, region: string, profile?: string, oidcProvider?: boolean, template?: string }} o
 * @returns {string[][]}
 */
export function deployCommands({ repository, subjects, defaultBranch: branch, region, profile, oidcProvider = true, template = TEMPLATE_PATH }) {
  if (!REPOSITORY.test(repository)) throw new Error(`--repository '${repository}' is not owner/name`);
  if (!REGION.test(region)) throw new Error(`--region '${region}' is not an AWS region`);
  const problems = subjectProblems(subjects, repository, branch);
  if (problems.length) throw new Error(`refusing to trust these subjects: ${problems.join('; ')}`);
  const common = ['--region', region, ...(profile ? ['--profile', profile] : [])];
  return [
    ['aws', 'cloudformation', 'deploy', ...common, '--stack-name', STACK_NAME, '--template-file', template,
      '--parameter-overrides', `${SUBJECTS_PARAMETER}=${subjects.join(',')}`, `CreateOidcProvider=${oidcProvider ? 'true' : 'false'}`,
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
      subject: { type: 'string', multiple: true },
      profile: { type: 'string' },
      'no-oidc-provider': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  try {
    if (!values.repository || !values.region) throw new Error('usage: provision.mjs --repository <owner>/<repo> --region <region> [--subject <subject>]... [--profile <profile>] [--no-oidc-provider] [--dry-run]');
    const problems = [...lifecycleProblems(readTemplate()), ...trustProblems(readTemplate())];
    if (problems.length) throw new Error(`the template fails its checks: ${problems.join('; ')}`);
    if (!REPOSITORY.test(values.repository)) throw new Error(`--repository '${values.repository}' is not owner/name`);
    const { defaultBranch: branch, subjects } = trustedSubjects(values.repository, values.subject ?? []);
    console.log(`trusting ${subjects.join(', ')}`);
    const commands = deployCommands({ repository: values.repository, subjects, defaultBranch: branch, region: values.region, profile: values.profile, oidcProvider: !values['no-oidc-provider'] });
    for (const c of commands) {
      console.log(`$ ${c.join(' ')}`);
      if (!values['dry-run']) execFileSync(c[0] ?? 'aws', c.slice(1), { stdio: 'inherit' });
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
