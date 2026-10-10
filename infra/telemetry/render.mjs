#!/usr/bin/env node
// Render the deployable telemetry template from template.yaml and the Owner's private register
// (plan 0002 §3, §5).
//
//   node infra/telemetry/render.mjs --register <register.json> --out <dir> [--verify] [--importer] [--backfill]
//
// Writes <dir>/template.json, which `aws cloudformation package` takes, and <dir>/parameters.json,
// which `aws cloudformation deploy --parameter-overrides file://...` takes. Both hold the
// register's contents, so <dir> belongs outside the public tree, beside the register.
//
// Per repository it adds a writer role, a reader role and the function URL permission. The
// repository appears only in the two trust policies' `sub` conditions, never with a wildcard.
// The roles carry the opaque key, and so does every row.
//
// WHAT IT PRINTS NAMES NO KEY (kanon#628). The key is opaque and says nothing about the
// repository (docs/telemetry.md), so its pairing with one is the register's to keep. Standard
// output and error land in scrollback, CI logs and agent transcripts, so what this prints names an
// entry by its repository, for the subjects the Owner checks, or by its index, for a refusal.
//
// THE WRITER TRUSTS THE DEFAULT BRANCH'S REF, NEVER AN ENVIRONMENT (plan 0002 §3, as the Owner
// decided on 2026-10-05 to drop GitHub Environments). Its subject is
// `<prefix>:ref:refs/heads/<default branch>`, and each reader subject is `<prefix>:<reader>`. Both
// halves come from GitHub's API through `gh`, at render time: the default branch, and the prefix
// the repository really issues, `repo:<owner>/<repo>` or, for a repository created after
// 2026-07-15, the immutable `repo:<owner>@<id>/<repo>@<id>` (`scripts/lib/oidc-subject.mjs`).
// A repository with a custom subject template is refused unless its entry names the exact
// subjects (`writer_subjects`, `reader_subjects`), which are checked the same way: exact, a branch
// ref of that repository, no environment or pull request, and for the writer the default branch.
// "Only the collector reaches the store" (`K-OBS-13`) is then held by which jobs hold
// `id-token: write`, not by an environment.
//
// THE SENDER'S NAME HASHES (plan 0006 §4.2, F4). The ingest function checks a finding row's text
// with the scrub's `verify`, in the context of the repository that sent it: the words of its owner
// and name. It is told them as `NAME_HASHES`, `<key>=<hash>:<hash>…` per key, the SHA-256 of each
// lowercase `[a-z0-9]` run, as the scrub's `nameContext` hashes them, NEVER THE WORDS, so the
// function's configuration names no repository. Lambda holds a function's whole environment to
// 4 KB, so a register too large for it is refused here, before a deploy.

import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { readRepositorySubject, subjectProblems } from '../../scripts/lib/oidc-subject.mjs';
import { addMonths, RETENTION_MONTHS } from './function/index.mjs';
import { ISO_UTC } from '../../actions/agent-telemetry/schema.mjs';
import { nameContext } from '../../actions/agent-telemetry/scrub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(HERE, 'template.yaml');
export const FUNCTION_DIR = join(HERE, 'function');

const OIDC_HOST = 'token.actions.githubusercontent.com';

const OWNER = /^arn:aws:iam::\d{12}:role\/.+$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const READER = /^ref:refs\/heads\/[A-Za-z0-9._/-]+$/;

/**
 * @typedef {{ minutes: number, review_recorded_at: string }} FirstReview
 * @typedef {{ key: string, repository: string, readers?: string[], writer_subjects?: string[], reader_subjects?: string[], first_review?: FirstReview,
 *   publish_own_figures_as?: string, aggregate_invoker?: boolean }} Entry
 * @typedef {{ writer: string[], readers: string[] }} Subjects
 * @typedef {{ owner_principal_arn: string, create_oidc_provider?: boolean, reserved_concurrency?: number, repositories: Entry[] }} Register
 */

/**
 * Whether an entry's time from install to first review is past its bound (plan 0002 decision 18):
 * 13 months after the review row it was computed from, the same retention as the row itself.
 * Past it, the value comes out of the register, and so out of the published distribution.
 * @param {FirstReview} firstReview
 * @param {number} now
 */
export const firstReviewExpired = (firstReview, now) =>
  addMonths(Date.parse(firstReview.review_recorded_at), RETENTION_MONTHS) <= now;

/**
 * Check the register, and say what's wrong with it, naming each entry by its index and echoing
 * nothing in it, its key least of all.
 * A time to first review past its 13 months is a problem too (decision 18), so no render, and so
 * no deploy, goes out while the register still holds one.
 * @param {any} register
 * @param {number} [now]
 * @returns {string[]}
 */
export function registerProblems(register, now = Date.now()) {
  const out = [];
  if (!register || typeof register !== 'object') return ['the register is not an object'];
  if (typeof register.owner_principal_arn !== 'string' || !OWNER.test(register.owner_principal_arn)) {
    out.push('owner_principal_arn is not a role ARN');
  }
  const repos = register.repositories;
  if (!Array.isArray(repos) || repos.length === 0) return [...out, 'repositories is empty'];
  const ids = new Set();
  const names = new Set();
  const keys = new Set(repos.map((r) => r?.key));
  const labels = new Set();
  repos.forEach((r, i) => {
    const at = `repositories[${i}]`;
    if (typeof r?.key !== 'string' || !KEY.test(r.key)) out.push(`${at}.key is not a key`);
    else {
      // Roles' logical ids drop the punctuation, so `k-1` and `k1` are one key here.
      if (ids.has(logicalId(r.key))) out.push(`${at}.key duplicates another key`);
      ids.add(logicalId(r.key));
    }
    if (typeof r?.repository !== 'string' || !REPOSITORY.test(r.repository)) out.push(`${at}.repository is not owner/name`);
    else if (names.has(r.repository.toLowerCase())) out.push(`${at}.repository is a duplicate`);
    else names.add(r.repository.toLowerCase());
    // `readers` is the usual form; `reader_subjects` replaces it with exact subjects. Never both,
    // so the register says exactly what is trusted.
    if (r?.reader_subjects !== undefined && r?.readers !== undefined) out.push(`${at} gives both readers and reader_subjects`);
    else if (r?.reader_subjects === undefined) {
      if (!Array.isArray(r?.readers) || r.readers.length === 0 || !r.readers.every((/** @type {unknown} */ s) => typeof s === 'string' && READER.test(s))) {
        out.push(`${at}.readers must list ref:refs/heads/<branch> subjects, and nothing else (no environment)`);
      }
    }
    const fr = r?.first_review;
    if (fr !== undefined) {
      if (!fr || typeof fr !== 'object' || !Number.isInteger(fr.minutes) || fr.minutes < 0
        || typeof fr.review_recorded_at !== 'string' || !ISO_UTC.test(fr.review_recorded_at) || Number.isNaN(Date.parse(fr.review_recorded_at))) {
        out.push(`${at}.first_review must be { minutes, review_recorded_at }`);
      } else if (firstReviewExpired(fr, now)) {
        out.push(`${at}.first_review is past its ${RETENTION_MONTHS} months (decision 18): remove it`);
      }
    }
    // §6.1: an adopter's own figures are published only if it declares so, under a label it
    // chooses. Off by default; never a key, so the label can't name one.
    const label = r?.publish_own_figures_as;
    if (label !== undefined) {
      if (typeof label !== 'string' || !KEY.test(label)) out.push(`${at}.publish_own_figures_as is not a label`);
      else if (keys.has(label)) out.push(`${at}.publish_own_figures_as is a key`);
      else if (labels.has(label)) out.push(`${at}.publish_own_figures_as duplicates another label`);
      else labels.add(label);
    }
    if (r?.aggregate_invoker !== undefined && typeof r.aggregate_invoker !== 'boolean') out.push(`${at}.aggregate_invoker is not true or false`);
    for (const field of ['writer_subjects', 'reader_subjects']) {
      const v = r?.[field];
      if (v !== undefined && (!Array.isArray(v) || v.length === 0 || !v.every((/** @type {unknown} */ s) => typeof s === 'string'))) {
        out.push(`${at}.${field}, when given, must list exact subjects`);
      }
    }
  });
  return out;
}

const logicalId = (/** @type {string} */ key) => key.replace(/[^A-Za-z0-9]/g, '');

/** Lambda's limit on a function's environment variables, names and values together. */
export const LAMBDA_ENV_BYTES = 4096;
/** What a value CloudFormation resolves at deploy time (an account id, a role name) is allowed. */
const RESOLVED_VALUE_BYTES = 64;

/**
 * `NAME_HASHES` for the ingest function: per key, the SHA-256 of each word of its repository's
 * owner and name, sorted, never the words, and none of Kanon's own vocabulary, which `nameContext`
 * leaves out for the lanes too (plan 0006 §4.2, kanon#612).
 * @param {Entry[]} entries
 */
export const nameHashesVariable = (entries) =>
  entries.map((e) => `${e.key}=${[...nameContext({ repository: e.repository })].sort().join(':')}`).join(',');

/**
 * The size Lambda counts for an environment: each name and value, a value CloudFormation resolves
 * counted at `RESOLVED_VALUE_BYTES`.
 * @param {Record<string, unknown>} variables
 */
export const environmentBytes = (variables) =>
  Object.entries(variables).reduce((n, [k, v]) => n + Buffer.byteLength(k) + (typeof v === 'string' ? Buffer.byteLength(v) : RESOLVED_VALUE_BYTES), 0);
const providerArn = {
  'Fn::If': [
    'CreateOidc',
    { Ref: 'OidcProvider' },
    { 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:oidc-provider/${OIDC_HOST}` },
  ],
};
const tableArn = { 'Fn::Sub': 'arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/kanon-telemetry' };
/** Lets the Owner assume a writer or reader role while EnableVerify is true, and only then. */
const ownerForVerify = {
  'Fn::If': [
    'VerifyOn',
    {
      Effect: 'Allow',
      Principal: { AWS: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' } },
      Action: 'sts:AssumeRole',
      Condition: { ArnEquals: { 'aws:PrincipalArn': { Ref: 'OwnerPrincipalArn' } } },
    },
    { Ref: 'AWS::NoValue' },
  ],
};

/**
 * The GitHub OIDC trust for a list of `sub` values: exact matches, never a pattern.
 * @param {string[]} subjects
 */
const oidcTrust = (subjects) => ({
  Effect: 'Allow',
  Principal: { Federated: providerArn },
  Action: 'sts:AssumeRoleWithWebIdentity',
  Condition: {
    StringEquals: {
      [`${OIDC_HOST}:aud`]: 'sts.amazonaws.com',
      [`${OIDC_HOST}:sub`]: subjects.length === 1 ? subjects[0] : subjects,
    },
  },
});

/**
 * The subjects one entry's roles trust. The writer's is the default branch's ref, in the form
 * the repository issues; the readers' are its `readers` under the same prefix. Exact subjects
 * in the entry replace the derived ones and pass the same checks.
 * @param {Entry} entry
 * @param {(args: string[]) => string} [gh] runs `gh`, for GitHub's API
 * @returns {Subjects}
 */
export function entrySubjects(entry, gh) {
  // The default branch is read even when every subject is given, so a writer subject naming any
  // other branch is refused.
  const { defaultBranch, prefix, problem } = readRepositorySubject(entry.repository, gh);
  const exactly = (/** @type {string[] | undefined} */ given, /** @type {() => string[]} */ derive) => {
    if (given) return given;
    if (prefix === null) throw new Error(`${problem ?? 'no subject prefix'}: writer_subjects and reader_subjects`);
    return derive();
  };
  const writer = exactly(entry.writer_subjects, () => [`${prefix}:ref:refs/heads/${defaultBranch}`]);
  const readers = exactly(entry.reader_subjects, () => (entry.readers ?? []).map((s) => `${prefix}:${s}`));
  const problems = [
    ...subjectProblems(writer, entry.repository, defaultBranch).map((p) => `writer: ${p}`),
    ...subjectProblems(readers, entry.repository, null).map((p) => `reader: ${p}`),
  ];
  if (problems.length) throw new Error(`refusing to trust these subjects: ${problems.join('; ')}`);
  return { writer, readers };
}

/**
 * The resources for one repository.
 * @param {Entry} entry
 * @param {object} invokePolicy the importer's policy document, which writers share
 * @param {Subjects} subjects from `entrySubjects`
 */
export function repositoryResources(entry, invokePolicy, subjects) {
  const id = logicalId(entry.key);
  return {
    [`WriterRole${id}`]: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `kanon-telemetry-${entry.key}-writer`,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [oidcTrust(subjects.writer), ownerForVerify],
        },
        // Invoke the ingest URL. Nothing else: no DynamoDB action at all.
        Policies: [{ PolicyName: 'invoke-ingest-url', PolicyDocument: invokePolicy }],
      },
    },
    [`WriterUrlPermission${id}`]: {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: { Ref: 'IngestFunction' },
        Action: 'lambda:InvokeFunctionUrl',
        Principal: { 'Fn::GetAtt': [`WriterRole${id}`, 'Arn'] },
        FunctionUrlAuthType: 'AWS_IAM',
      },
    },
    [`ReaderRole${id}`]: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `kanon-telemetry-${entry.key}-reader`,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [oidcTrust(subjects.readers), ownerForVerify],
        },
        // Query and GetItem on its own key's partitions only (§6): IAM denies any other key.
        Policies: [{
          PolicyName: 'read-own-partitions',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Action: ['dynamodb:Query', 'dynamodb:GetItem'],
              Resource: tableArn,
              Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${entry.key}#*`] } },
            }],
          },
        }],
      },
    },
  };
}

/**
 * For an entry that sets `aggregate_invoker` (§6.1): a role its default-branch jobs assume to call
 * the aggregate-only function's URL, and nothing else, and the URL's permission for that role.
 * It trusts the writer's subjects, the default branch's ref, never a reader's other branches.
 * @param {Entry} entry
 * @param {object} invokePolicy the importer's policy document, aimed here at the aggregate function
 * @param {Subjects} subjects from `entrySubjects`
 */
export function invokerResources(entry, invokePolicy, subjects) {
  if (entry.aggregate_invoker !== true) return {};
  const id = logicalId(entry.key);
  const policy = JSON.parse(JSON.stringify(invokePolicy).replaceAll('"IngestFunction"', '"AggregateFunction"'));
  return {
    [`AggregateInvokerRole${id}`]: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `kanon-telemetry-${entry.key}-aggregates`,
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [oidcTrust(subjects.writer)] },
        Policies: [{ PolicyName: 'invoke-aggregate-url', PolicyDocument: policy }],
      },
    },
    [`AggregateUrlPermission${id}`]: {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: { Ref: 'AggregateFunction' },
        Action: 'lambda:InvokeFunctionUrl',
        Principal: { 'Fn::GetAtt': [`AggregateInvokerRole${id}`, 'Arn'] },
        FunctionUrlAuthType: 'AWS_IAM',
      },
    },
  };
}

/**
 * The deployable template and its parameter overrides.
 * @param {Register} register
 * @param {{ verify?: boolean, importer?: boolean, backfill?: boolean, templateText?: string, functionDir?: string, gh?: (args: string[]) => string, now?: number }} [opts]
 *   `gh` runs `gh` for GitHub's API; the default is the real one
 * @returns {{ template: any, parameters: string[], subjects: Record<string, Subjects> }} `subjects` by key
 */
export function render(register, opts = {}) {
  const problems = registerProblems(register, opts.now);
  if (problems.length) throw new Error(`register: ${problems.join('; ')}`);
  /** @type {Record<string, Subjects>} */
  const subjects = {};
  /** @type {string[]} */
  const refused = [];
  register.repositories.forEach((entry, i) => {
    try {
      subjects[entry.key] = entrySubjects(entry, opts.gh);
    } catch (e) {
      refused.push(`repositories[${i}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (refused.length) throw new Error(`register: ${refused.join('; ')}`);
  const template = parse(opts.templateText ?? readFileSync(TEMPLATE_PATH, 'utf8'));
  const fn = template.Resources.IngestFunction.Properties;
  fn.Code = opts.functionDir ?? FUNCTION_DIR;
  fn.Environment.Variables.WRITER_KEYS = register.repositories.map((r) => r.key).join(',');
  fn.Environment.Variables.NAME_HASHES = nameHashesVariable(register.repositories);
  const bytes = environmentBytes(fn.Environment.Variables);
  if (bytes > LAMBDA_ENV_BYTES) {
    throw new Error(`register: the ingest function's environment would be ${bytes} bytes for ${register.repositories.length} repositories, past Lambda's ${LAMBDA_ENV_BYTES}`);
  }
  const invokePolicy = template.Resources.ImporterRole.Properties.Policies[0].PolicyDocument;
  for (const entry of register.repositories) Object.assign(template.Resources, repositoryResources(entry, invokePolicy, /** @type {Subjects} */ (subjects[entry.key])));
  const agg = template.Resources.AggregateFunction.Properties;
  agg.Code = fn.Code;
  agg.Environment.Variables.AGGREGATE_KEYS = fn.Environment.Variables.WRITER_KEYS;
  agg.Environment.Variables.OWN_FIGURES = register.repositories.filter((r) => r.publish_own_figures_as !== undefined)
    .map((r) => `${r.key}=${r.publish_own_figures_as}`).join(',');
  agg.Environment.Variables.INVOKER_KEYS = register.repositories.filter((r) => r.aggregate_invoker === true).map((r) => r.key).join(',');
  for (const entry of register.repositories) Object.assign(template.Resources, invokerResources(entry, invokePolicy, /** @type {Subjects} */ (subjects[entry.key])));
  for (const entry of register.repositories) {
    const id = logicalId(entry.key);
    template.Outputs[`WriterRole${id}`] = { Value: { 'Fn::GetAtt': [`WriterRole${id}`, 'Arn'] } };
    template.Outputs[`ReaderRole${id}`] = { Value: { 'Fn::GetAtt': [`ReaderRole${id}`, 'Arn'] } };
    if (entry.aggregate_invoker === true) template.Outputs[`AggregateInvokerRole${id}`] = { Value: { 'Fn::GetAtt': [`AggregateInvokerRole${id}`, 'Arn'] } };
  }
  const parameters = [
    `OwnerPrincipalArn=${register.owner_principal_arn}`,
    `CreateOidcProvider=${register.create_oidc_provider === false ? 'false' : 'true'}`,
    `ReservedConcurrency=${register.reserved_concurrency ?? 2}`,
    `EnableVerify=${opts.verify ? 'true' : 'false'}`,
    `EnableImporter=${opts.importer ? 'true' : 'false'}`,
    `EnableBackfill=${opts.backfill ? 'true' : 'false'}`,
  ];
  return { template, parameters, subjects };
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      register: { type: 'string' },
      out: { type: 'string' },
      verify: { type: 'boolean', default: false },
      importer: { type: 'boolean', default: false },
      backfill: { type: 'boolean', default: false },
    },
  });
  if (!values.register || !values.out) {
    console.error('usage: render.mjs --register <register.json> --out <dir> [--verify] [--importer] [--backfill]');
    process.exit(2);
  }
  try {
    const text = readFileSync(values.register, 'utf8');
    /** @type {Register} */
    let register;
    // JSON.parse's message quotes the text around the fault, which may be a key.
    try { register = JSON.parse(text); } catch { throw new Error(`register: ${values.register} is not JSON`); }
    const { template, parameters, subjects } = render(register, values);
    // The Owner checks these before deploying: each is what that repository's tokens carry. By
    // repository, never by key.
    for (const e of register.repositories) {
      const s = /** @type {Subjects} */ (subjects[e.key]);
      console.log(`${e.repository}: writer trusts ${s.writer.join(', ')}; reader trusts ${s.readers.join(', ')}`);
      if (e.aggregate_invoker === true) console.log(`${e.repository}: aggregate invoker trusts ${s.writer.join(', ')}`);
      if (e.publish_own_figures_as !== undefined) console.log(`${e.repository}: own figures publishable as ${e.publish_own_figures_as}`);
    }
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'template.json'), `${JSON.stringify(template, null, 2)}\n`);
    writeFileSync(join(values.out, 'parameters.json'), `${JSON.stringify(parameters, null, 2)}\n`);
    console.log(`rendered ${Object.keys(template.Resources).length} resources to ${values.out}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
