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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(HERE, 'template.yaml');
export const FUNCTION_DIR = join(HERE, 'function');

/** The environment only the collector job declares (§3, `K-OBS-13`). */
export const WRITER_ENVIRONMENT = 'kanon-telemetry';
const OIDC_HOST = 'token.actions.githubusercontent.com';

const OWNER = /^arn:aws:iam::\d{12}:role\/.+$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const READER = /^(ref:refs\/heads\/[A-Za-z0-9._/-]+|environment:[A-Za-z0-9._-]+)$/;

/**
 * @typedef {{ key: string, repository: string, readers: string[] }} Entry
 * @typedef {{ owner_principal_arn: string, create_oidc_provider?: boolean, reserved_concurrency?: number, repositories: Entry[] }} Register
 */

/**
 * Check the register, and say what's wrong with it without echoing anything but its keys.
 * @param {any} register
 * @returns {string[]}
 */
export function registerProblems(register) {
  const out = [];
  if (!register || typeof register !== 'object') return ['the register is not an object'];
  if (typeof register.owner_principal_arn !== 'string' || !OWNER.test(register.owner_principal_arn)) {
    out.push('owner_principal_arn is not a role ARN');
  }
  const repos = register.repositories;
  if (!Array.isArray(repos) || repos.length === 0) return [...out, 'repositories is empty'];
  const keys = new Set();
  const ids = new Set();
  const names = new Set();
  repos.forEach((r, i) => {
    const at = `repositories[${i}]`;
    if (typeof r?.key !== 'string' || !KEY.test(r.key)) out.push(`${at}.key is not a key`);
    else {
      if (keys.has(r.key)) out.push(`${at}.key is a duplicate`);
      if (ids.has(logicalId(r.key))) out.push(`${at}.key collides with another once punctuation is removed`);
      keys.add(r.key);
      ids.add(logicalId(r.key));
    }
    if (typeof r?.repository !== 'string' || !REPOSITORY.test(r.repository)) out.push(`${at}.repository is not owner/name`);
    else if (names.has(r.repository.toLowerCase())) out.push(`${at}.repository is a duplicate`);
    else names.add(r.repository.toLowerCase());
    if (!Array.isArray(r?.readers) || r.readers.length === 0 || !r.readers.every((/** @type {unknown} */ s) => typeof s === 'string' && READER.test(s))) {
      out.push(`${at}.readers must list ref:refs/heads/<branch> or environment:<name> subjects`);
    }
  });
  return out;
}

const logicalId = (/** @type {string} */ key) => key.replace(/[^A-Za-z0-9]/g, '');
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
 * The resources for one repository.
 * @param {Entry} entry
 * @param {object} invokePolicy the importer's policy document, which writers share
 */
export function repositoryResources(entry, invokePolicy) {
  const id = logicalId(entry.key);
  return {
    [`WriterRole${id}`]: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `kanon-telemetry-${entry.key}-writer`,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [oidcTrust([`repo:${entry.repository}:environment:${WRITER_ENVIRONMENT}`]), ownerForVerify],
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
          Statement: [oidcTrust(entry.readers.map((s) => `repo:${entry.repository}:${s}`)), ownerForVerify],
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
 * The deployable template and its parameter overrides.
 * @param {Register} register
 * @param {{ verify?: boolean, importer?: boolean, backfill?: boolean, templateText?: string, functionDir?: string }} [opts]
 */
export function render(register, opts = {}) {
  const problems = registerProblems(register);
  if (problems.length) throw new Error(`register: ${problems.join('; ')}`);
  const template = parse(opts.templateText ?? readFileSync(TEMPLATE_PATH, 'utf8'));
  const fn = template.Resources.IngestFunction.Properties;
  fn.Code = opts.functionDir ?? FUNCTION_DIR;
  fn.Environment.Variables.WRITER_KEYS = register.repositories.map((r) => r.key).join(',');
  const invokePolicy = template.Resources.ImporterRole.Properties.Policies[0].PolicyDocument;
  for (const entry of register.repositories) Object.assign(template.Resources, repositoryResources(entry, invokePolicy));
  for (const entry of register.repositories) {
    const id = logicalId(entry.key);
    template.Outputs[`WriterRole${id}`] = { Value: { 'Fn::GetAtt': [`WriterRole${id}`, 'Arn'] } };
    template.Outputs[`ReaderRole${id}`] = { Value: { 'Fn::GetAtt': [`ReaderRole${id}`, 'Arn'] } };
  }
  const parameters = [
    `OwnerPrincipalArn=${register.owner_principal_arn}`,
    `CreateOidcProvider=${register.create_oidc_provider === false ? 'false' : 'true'}`,
    `ReservedConcurrency=${register.reserved_concurrency ?? 2}`,
    `EnableVerify=${opts.verify ? 'true' : 'false'}`,
    `EnableImporter=${opts.importer ? 'true' : 'false'}`,
    `EnableBackfill=${opts.backfill ? 'true' : 'false'}`,
  ];
  return { template, parameters };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    const { template, parameters } = render(JSON.parse(readFileSync(values.register, 'utf8')), values);
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'template.json'), `${JSON.stringify(template, null, 2)}\n`);
    writeFileSync(join(values.out, 'parameters.json'), `${JSON.stringify(parameters, null, 2)}\n`);
    console.log(`rendered ${Object.keys(template.Resources).length} resources to ${values.out}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
