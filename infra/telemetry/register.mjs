#!/usr/bin/env node
// The operator's CLI for the register table (plan 0008 §5.3), run by the Owner with the Owner's
// profile. Nothing else reads or writes the table until the token path (plan 0008 J3).
//
//   node infra/telemetry/register.mjs list [--profile kanon]
//   node infra/telemetry/register.mjs suspend --repository <owner/name> --reason <code>
//   node infra/telemetry/register.mjs resume --repository <owner/name>
//   node infra/telemetry/register.mjs set --repository <owner/name> [--aggregate-invoker true|false]
//       [--publish-own-figures-as <label> | --no-publish-own-figures] [--page-reader true|false]
//       [--rows-per-day <n>] [--requests-per-hour <n>] [--first-review <minutes>@<recorded_at>]
//   node infra/telemetry/register.mjs erase --repository <owner/name> [--apply]
//   node infra/telemetry/register.mjs import --register <register.json>
//
// WHAT IT PRINTS NAMES NO KEY (kanon#628, plan 0008 Owner decision 3). Each line names a
// registration by its repository, or by its index in the register file for a refusal, or by its
// repository id once a tombstone has dropped the name. A key is read where a call needs it (the
// erasure's walk, the import's writes) and never printed: a failed `aws` call is reported by its
// operation and DynamoDB's error code, never its stderr or its arguments, which can hold one.
//
// THE OPERATOR'S FIELDS ARE THIS SCRIPT'S ALONE (`function/register-fields.mjs`): the ingest
// function's role may not write `aggregate_invoker`, `publish_own_figures_as`, `page_reader`,
// `quota_*`, `suspended_*` or `first_review`, so `set`, `suspend` and `resume` are the only way
// they change, and none needs a deploy.
//
// `import` is plan 0008 §9 step 3's one-time move from today's register file: each entry's key is
// kept exactly, its ids and default branch are read from GitHub through `gh api`, and its
// `aggregate_invoker`, `publish_own_figures_as` and `first_review` are carried across. An entry
// that can't be resolved stops the whole import before anything is written.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ISO_UTC } from '../../actions/agent-telemetry/schema.mjs';
import { nameContext } from '../../actions/agent-telemetry/scrub.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { erase as walk, REGION } from './erase.mjs';
import { REGISTER_TABLE, SUSPENDED_REASONS, TOMBSTONE_FIELDS } from './function/register-fields.mjs';
import { firstReviewExpired, KEY, registerProblems } from './render.mjs';

/**
 * @typedef {{ code: number, stdout: string, stderr?: string }} AwsResult
 * @typedef {(args: string[]) => AwsResult} Aws
 * @typedef {(args: string[]) => string} Gh runs `gh`, and throws when it fails
 * @typedef {{ aws: Aws, gh: Gh, profile: string, now: () => number, readFile: (path: string) => string }} Deps
 * @typedef {{ code: number, out: string[], err: string[] }} Result
 * @typedef {Record<string, any>} Item a DynamoDB item, attribute-value form
 */

/** A refusal: its message is printed as it is, so it is built to name no key. */
class Refusal extends Error {}

const USAGE = [
  'usage: register.mjs list [--profile kanon]',
  '       register.mjs suspend --repository <owner/name> --reason <code>',
  '       register.mjs resume --repository <owner/name>',
  '       register.mjs set --repository <owner/name> [--aggregate-invoker true|false] [--publish-own-figures-as <label> | --no-publish-own-figures]',
  '                        [--page-reader true|false] [--rows-per-day <n>] [--requests-per-hour <n>] [--first-review <minutes>@<recorded_at>]',
  '       register.mjs erase --repository <owner/name> [--apply]',
  '       register.mjs import --register <register.json>',
].join('\n');

const REGISTRATION = 'repo#';
const KEY_ITEM = 'key#';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COUNT = /^[1-9][0-9]{0,8}$/;

// ------------------------------------------------------------------------- DynamoDB's form

/** A plain value in DynamoDB's attribute-value form. @param {unknown} v @returns {any} */
export function attr(v) {
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(attr) };
  if (v && typeof v === 'object') return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, attr(x)])) };
  throw new Error(`no attribute form for ${typeof v}`);
}

/** An attribute value as a plain value. @param {any} a @returns {any} */
export function plain(a) {
  if (!a || typeof a !== 'object') return undefined;
  if ('S' in a) return a.S;
  if ('N' in a) return Number(a.N);
  if ('BOOL' in a) return a.BOOL;
  if ('L' in a) return a.L.map(plain);
  if ('M' in a) return Object.fromEntries(Object.entries(a.M).map(([k, x]) => [k, plain(x)]));
  return undefined;
}

/** @param {Record<string, unknown>} o @returns {Item} */
const itemOf = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, attr(v)]));

// ------------------------------------------------------------------------- calls

/**
 * Why an `aws` call failed: the operation and DynamoDB's error code, never stderr as it is, since
 * a `ValidationException` can quote the request, and the request can hold a key.
 * @param {string} op @param {AwsResult} r @param {string} profile
 */
export function awsFailure(op, r, profile) {
  const stderr = r.stderr ?? '';
  if (/SSO session .*(expired|invalid)|Token has expired|ExpiredToken|Error loading SSO Token|Unable to locate credentials/i.test(stderr)) {
    return `aws dynamodb ${op} failed: no valid AWS session for profile ${profile}; run \`aws sso login --profile ${profile}\`, then re-run`;
  }
  const code = /An error occurred \(([A-Za-z]+)\)/.exec(stderr)?.[1];
  return `aws dynamodb ${op} exited ${r.code}${code ? ` (${code})` : ''}`;
}

/**
 * One `aws dynamodb` call against the register table, as the Owner.
 * @param {Deps} deps @param {string} op @param {string[]} args
 * @returns {{ ok: true, json: any } | { ok: false, failure: string, code: string | undefined }}
 */
function dynamo(deps, op, args) {
  const r = deps.aws(['dynamodb', op, ...args, '--profile', deps.profile, '--region', REGION, '--output', 'json']);
  if (r.code === 0) return { ok: true, json: JSON.parse(r.stdout || '{}') };
  return { ok: false, failure: awsFailure(op, r, deps.profile), code: /An error occurred \(([A-Za-z]+)\)/.exec(r.stderr ?? '')?.[1] };
}

/** The same, throwing a refusal on failure. @param {Deps} deps @param {string} op @param {string[]} args */
function must(deps, op, args) {
  const r = dynamo(deps, op, args);
  if (!r.ok) throw new Refusal(r.failure);
  return r.json;
}

/**
 * Every registration, projected. Key items and counters are left out by the filter.
 * @param {Deps} deps @param {string[]} fields
 * @returns {Item[]}
 */
function scanRegistrations(deps, fields) {
  /** @type {Record<string, string>} */
  const names = {};
  const projection = fields.map((f, i) => { names[`#f${i}`] = f; return `#f${i}`; }).join(', ');
  /** @type {Item[]} */
  const items = [];
  /** @type {string | undefined} */
  let start;
  do {
    const page = must(deps, 'scan', ['--table-name', REGISTER_TABLE, '--projection-expression', projection,
      '--filter-expression', 'begins_with(pk, :r)', '--expression-attribute-names', JSON.stringify(names),
      '--expression-attribute-values', JSON.stringify({ ':r': { S: REGISTRATION } }), ...(start ? ['--exclusive-start-key', start] : [])]);
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey ? JSON.stringify(page.LastEvaluatedKey) : undefined;
  } while (start);
  return items;
}

/**
 * The partition key of the one registration for `repository`, compared as GitHub does, without
 * case. Refused when there is none or more than one.
 * @param {Deps} deps @param {string} repository
 */
function findRegistration(deps, repository) {
  if (!REPOSITORY.test(repository)) throw new Refusal('--repository must be <owner>/<name>');
  const hits = scanRegistrations(deps, ['pk', 'repository'])
    .filter((i) => String(plain(i.repository) ?? '').toLowerCase() === repository.toLowerCase());
  if (hits.length === 0) throw new Refusal(`${repository}: no registration`);
  if (hits.length > 1) throw new Refusal(`${repository}: ${hits.length} registrations name it`);
  return /** @type {string} */ (plain(hits[0]?.pk));
}

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

// ------------------------------------------------------------------------- the subcommands

/** `list`: counts by status, then each registration by repository. @param {Deps} deps */
export function list(deps) {
  const fields = ['pk', 'repository_id', 'repository', 'status', 'suspended_reason', 'aggregate_invoker', 'publish_own_figures_as',
    'page_reader', 'erased_at', 'rows_erased_at'];
  const regs = scanRegistrations(deps, fields).map((i) => Object.fromEntries(fields.map((f) => [f, plain(i[f])])));
  /** @type {Record<string, number>} */
  const counts = { active: 0, suspended: 0, erased: 0 };
  for (const r of regs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const name = (/** @type {Record<string, any>} */ r) => r.repository ?? `repository id ${r.repository_id}`;
  const lines = regs.sort((a, b) => String(name(a)).localeCompare(String(name(b)))).map((r) => {
    const notes = [];
    if (r.status === 'suspended') notes.push(`suspended (${r.suspended_reason ?? 'no reason'})`);
    else if (r.status === 'erased') notes.push(r.rows_erased_at ? `erased, rows erased ${r.rows_erased_at}` : `erased ${r.erased_at}, rows not yet erased`);
    else notes.push(String(r.status));
    if (r.aggregate_invoker === true) notes.push('aggregate invoker');
    if (r.publish_own_figures_as !== undefined) notes.push(`own figures as ${r.publish_own_figures_as}`);
    if (r.page_reader === true) notes.push('page reader');
    return `${name(r)}: ${notes.join('; ')}`;
  });
  return [`${regs.length} registrations: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ')}`, ...lines];
}

/** `suspend`: one UpdateItem, effective on the next request. @param {Deps} deps @param {string} repository @param {string} reason */
export function suspend(deps, repository, reason) {
  if (!SUSPENDED_REASONS.includes(reason)) throw new Refusal(`--reason must be one of ${SUSPENDED_REASONS.join(', ')}`);
  const pk = findRegistration(deps, repository);
  const r = dynamo(deps, 'update-item', ['--table-name', REGISTER_TABLE, '--key', JSON.stringify({ pk: { S: pk } }),
    '--update-expression', 'SET #s = :s, suspended_at = :t, suspended_reason = :r',
    '--condition-expression', 'attribute_exists(pk) AND (#s = :a OR #s = :s)',
    '--expression-attribute-names', JSON.stringify({ '#s': 'status' }),
    '--expression-attribute-values', JSON.stringify({ ':s': { S: 'suspended' }, ':a': { S: 'active' }, ':t': { S: iso(deps.now()) }, ':r': { S: reason } })]);
  if (!r.ok) throw new Refusal(r.code === 'ConditionalCheckFailedException' ? `${repository}: not active, so not suspended` : r.failure);
  return [`${repository}: suspended (${reason})`];
}

/** `resume`: the suspension's fields go with it. @param {Deps} deps @param {string} repository */
export function resume(deps, repository) {
  const pk = findRegistration(deps, repository);
  const r = dynamo(deps, 'update-item', ['--table-name', REGISTER_TABLE, '--key', JSON.stringify({ pk: { S: pk } }),
    '--update-expression', 'SET #s = :a REMOVE suspended_at, suspended_reason',
    '--condition-expression', 'attribute_exists(pk) AND #s = :s',
    '--expression-attribute-names', JSON.stringify({ '#s': 'status' }),
    '--expression-attribute-values', JSON.stringify({ ':s': { S: 'suspended' }, ':a': { S: 'active' } })]);
  if (!r.ok) throw new Refusal(r.code === 'ConditionalCheckFailedException' ? `${repository}: not suspended, so not resumed` : r.failure);
  return [`${repository}: active`];
}

/** @param {string | undefined} v @param {string} flag */
const bool = (v, flag) => {
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Refusal(`${flag} must be true or false`);
};

/**
 * `--first-review <minutes>@<recorded_at>`, refused past its 13 months (plan 0002 decision 18).
 * @param {string} v @param {number} now
 */
export function firstReviewOf(v, now) {
  const m = /^(\d+)@(.+)$/.exec(v);
  if (!m || !ISO_UTC.test(/** @type {string} */ (m[2])) || Number.isNaN(Date.parse(/** @type {string} */ (m[2])))) {
    throw new Refusal('--first-review must be <minutes>@<the review row\'s recorded_at>');
  }
  const fr = { minutes: Number(m[1]), review_recorded_at: /** @type {string} */ (m[2]) };
  if (firstReviewExpired(fr, now)) throw new Refusal('--first-review is past its 13 months (decision 18)');
  return fr;
}

/**
 * `set`: the operator's fields, in one UpdateItem. A label is refused, without echoing it, when it
 * is a key, is not a label, or is another registration's.
 * @param {Deps} deps @param {string} repository
 * @param {{ aggregateInvoker?: string, publishOwnFiguresAs?: string, noPublishOwnFigures?: boolean, pageReader?: string,
 *   rowsPerDay?: string, requestsPerHour?: string, firstReview?: string }} o
 */
export function set(deps, repository, o) {
  /** @type {string[]} */
  const sets = [];
  /** @type {string[]} */
  const removes = [];
  /** @type {Record<string, any>} */
  const values = {};
  const put = (/** @type {string} */ field, /** @type {unknown} */ v) => { sets.push(`${field} = :${field}`); values[`:${field}`] = attr(v); };
  if (o.aggregateInvoker !== undefined) put('aggregate_invoker', bool(o.aggregateInvoker, '--aggregate-invoker'));
  if (o.pageReader !== undefined) put('page_reader', bool(o.pageReader, '--page-reader'));
  for (const [v, field, flag] of /** @type {const} */ ([[o.rowsPerDay, 'quota_rows_per_day', '--rows-per-day'], [o.requestsPerHour, 'quota_requests_per_hour', '--requests-per-hour']])) {
    if (v === undefined) continue;
    if (!COUNT.test(v)) throw new Refusal(`${flag} must be a positive whole number`);
    put(field, Number(v));
  }
  if (o.firstReview !== undefined) put('first_review', firstReviewOf(o.firstReview, deps.now()));
  if (o.publishOwnFiguresAs !== undefined && o.noPublishOwnFigures) throw new Refusal('give --publish-own-figures-as or --no-publish-own-figures, not both');
  if (o.noPublishOwnFigures) removes.push('publish_own_figures_as');
  const pk = o.publishOwnFiguresAs === undefined ? null : labelCheck(deps, repository, o.publishOwnFiguresAs);
  if (o.publishOwnFiguresAs !== undefined) put('publish_own_figures_as', o.publishOwnFiguresAs);
  if (!sets.length && !removes.length) throw new Refusal('set: nothing to set');
  const target = pk ?? findRegistration(deps, repository);
  const expression = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' ');
  const r = dynamo(deps, 'update-item', ['--table-name', REGISTER_TABLE, '--key', JSON.stringify({ pk: { S: target } }),
    '--update-expression', expression,
    '--condition-expression', 'attribute_exists(pk) AND #s <> :e',
    '--expression-attribute-names', JSON.stringify({ '#s': 'status' }),
    '--expression-attribute-values', JSON.stringify({ ...values, ':e': { S: 'erased' } })]);
  if (!r.ok) throw new Refusal(r.code === 'ConditionalCheckFailedException' ? `${repository}: erased, so nothing is set` : r.failure);
  const changed = [...sets.map((s) => s.split(' = ')[0]), ...removes.map((f) => `${f} removed`)];
  return [`${repository}: set ${changed.join(', ')}`];
}

/**
 * A label's rules, `render.mjs`'s today (`registerProblems`): the key's pattern, never a key,
 * unique. Returns the registration's partition key.
 * @param {Deps} deps @param {string} repository @param {string} label
 */
function labelCheck(deps, repository, label) {
  if (!KEY.test(label)) throw new Refusal('--publish-own-figures-as is not a label');
  if (!REPOSITORY.test(repository)) throw new Refusal('--repository must be <owner>/<name>');
  const regs = scanRegistrations(deps, ['pk', 'repository', 'key', 'publish_own_figures_as']);
  const mine = regs.filter((i) => String(plain(i.repository) ?? '').toLowerCase() === repository.toLowerCase());
  if (mine.length !== 1) throw new Refusal(mine.length ? `${repository}: ${mine.length} registrations name it` : `${repository}: no registration`);
  if (regs.some((i) => plain(i.key) === label)) throw new Refusal('--publish-own-figures-as is a key');
  if (regs.some((i) => i !== mine[0] && plain(i.publish_own_figures_as) === label)) throw new Refusal('--publish-own-figures-as is another registration\'s label');
  return /** @type {string} */ (plain(mine[0]?.pk));
}

/**
 * `erase`: §7's three steps, as the operator. Without `apply`, counts only. With it: the
 * registration's `status` becomes `erased` at once; every partition of the key is walked and
 * deleted (`erase.mjs`); and when nothing is left, the key item goes and the registration is
 * replaced by its tombstone, `TOMBSTONE_FIELDS` and nothing else. A rerun finishes an unfinished
 * erasure, and says so of a finished one.
 * @param {Deps} deps @param {string} repository @param {boolean} apply
 */
export function eraseRegistration(deps, repository, apply) {
  const pk = findRegistration(deps, repository);
  const got = must(deps, 'get-item', ['--table-name', REGISTER_TABLE, '--key', JSON.stringify({ pk: { S: pk } }), '--consistent-read',
    '--projection-expression', 'pk, #k, #s, repository_id, repository_owner_id, erased_at, rows_erased_at',
    '--expression-attribute-names', JSON.stringify({ '#k': 'key', '#s': 'status' })]).Item;
  if (!got) throw new Refusal(`${repository}: no registration`);
  const reg = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, plain(v)]));
  if (typeof reg.key !== 'string') {
    if (reg.status === 'erased' && reg.rows_erased_at) return [`${repository}: already erased, rows erased ${reg.rows_erased_at}`];
    throw new Refusal(`${repository}: the registration holds no key`);
  }
  const key = reg.key;
  const now = iso(deps.now());
  const erasedAt = typeof reg.erased_at === 'string' ? reg.erased_at : now;
  if (apply && reg.status !== 'erased') {
    must(deps, 'update-item', ['--table-name', REGISTER_TABLE, '--key', JSON.stringify({ pk: { S: pk } }),
      '--update-expression', 'SET #s = :e, erased_at = :t', '--condition-expression', 'attribute_exists(pk)',
      '--expression-attribute-names', JSON.stringify({ '#s': 'status' }),
      '--expression-attribute-values', JSON.stringify({ ':e': { S: 'erased' }, ':t': { S: erasedAt } })]);
  }
  /** @type {{ partition: string, rows: number }[]} */
  let counts;
  try {
    counts = walk(key, { aws: deps.aws, profile: deps.profile, apply });
    // Deleted, then counted again: the tombstone is written only over a key with nothing left.
    if (apply && walk(key, { aws: deps.aws, profile: deps.profile, apply: false }).some((c) => c.rows > 0)) {
      throw new Error('rows remain after the walk; run erase again');
    }
  } catch (e) {
    // erase.mjs names the partition it failed on, `<key>#<lane>`: the lane alone is kept.
    const said = String(/** @type {Error} */ (e)?.message ?? e).split(`${key}#`).join('').split(key).join('<key>');
    throw new Refusal(`${repository}: ${said}`);
  }
  const lanes = counts.filter((c) => c.rows > 0).map((c) => `${c.partition.slice(key.length + 1)}: ${c.rows} ${apply ? 'deleted' : 'found'}`);
  const total = counts.reduce((n, c) => n + c.rows, 0);
  if (!apply) return [...lanes, `${repository}: ${total} rows found (dry run; pass --apply to erase)`];
  const tombstone = {
    pk, repository_id: reg.repository_id, repository_owner_id: reg.repository_owner_id, status: 'erased', erased_at: erasedAt, rows_erased_at: now,
  };
  const r = dynamo(deps, 'transact-write-items', ['--transact-items', JSON.stringify([
    { Put: { TableName: REGISTER_TABLE, Item: itemOf(Object.fromEntries(TOMBSTONE_FIELDS.map((f) => [f, /** @type {Record<string, unknown>} */ (tombstone)[f]]))),
      ConditionExpression: '#k = :k', ExpressionAttributeNames: { '#k': 'key' }, ExpressionAttributeValues: { ':k': { S: key } } } },
    { Delete: { TableName: REGISTER_TABLE, Key: { pk: { S: `${KEY_ITEM}${key}` } } } },
  ])]);
  if (!r.ok) throw new Refusal(`${repository}: rows deleted, but the tombstone was not written: ${r.failure}; run erase again`);
  return [...lanes, `${repository}: erased; ${total} rows deleted; the tombstone is kept`];
}

/**
 * `import`: today's register file into the table, every key unchanged (plan 0008 §9 step 3).
 * Every entry is resolved through GitHub first; one that can't be stops the import before any
 * write. A registration already imported with the same key is left as it is, so a rerun is
 * harmless; one under another key is refused.
 * @param {Deps} deps @param {string} path
 */
export function importRegister(deps, path) {
  /** @type {any} */
  let register;
  // JSON.parse's message quotes the text around the fault, which may be a key.
  try { register = JSON.parse(deps.readFile(path)); } catch { throw new Refusal(`import: ${path} is not a JSON register`); }
  const problems = registerProblems(register, deps.now());
  if (problems.length) throw new Refusal(`import: ${problems.join('; ')}`);
  /** @type {{ entry: any, id: string, ownerId: string, defaultBranch: string }[]} */
  const resolved = [];
  /** @type {string[]} */
  const refused = [];
  register.repositories.forEach((/** @type {any} */ entry, /** @type {number} */ i) => {
    /** @type {any} */
    let repo;
    try { repo = JSON.parse(deps.gh(['api', `repos/${entry.repository}`])); } catch { refused.push(`repositories[${i}]: GitHub does not answer for ${entry.repository}`); return; }
    const id = String(repo?.id ?? '');
    const ownerId = String(repo?.owner?.id ?? '');
    if (repo?.full_name !== entry.repository) refused.push(`repositories[${i}]: GitHub calls ${entry.repository} '${repo?.full_name}'`);
    else if (!/^[1-9][0-9]{0,19}$/.test(id) || !/^[1-9][0-9]{0,19}$/.test(ownerId)) refused.push(`repositories[${i}]: GitHub gave ${entry.repository} no repository or owner id`);
    else if (typeof repo.default_branch !== 'string' || !repo.default_branch) refused.push(`repositories[${i}]: GitHub gave ${entry.repository} no default branch`);
    else resolved.push({ entry, id, ownerId, defaultBranch: repo.default_branch });
  });
  if (refused.length) throw new Refusal(`import: nothing written: ${refused.join('; ')}`);
  const out = [];
  let failed = 0;
  for (const { entry, id, ownerId, defaultBranch } of resolved) {
    const pk = `${REGISTRATION}${id}`;
    const there = must(deps, 'get-item', ['--table-name', REGISTER_TABLE, '--key', JSON.stringify({ pk: { S: pk } }), '--consistent-read',
      '--projection-expression', '#k', '--expression-attribute-names', JSON.stringify({ '#k': 'key' })]).Item;
    if (there) {
      if (plain(there.key) === entry.key) out.push(`${entry.repository}: already imported`);
      else { out.push(`${entry.repository}: refused: registered under another key`); failed += 1; }
      continue;
    }
    const registration = itemOf({
      pk,
      repository_id: id,
      repository_owner_id: ownerId,
      repository: entry.repository,
      key: entry.key,
      status: 'active',
      default_ref: `refs/heads/${defaultBranch}`,
      name_hashes: [...nameContext({ repository: entry.repository })].sort(),
      registered_at: iso(deps.now()),
      source: 'import',
      aggregate_invoker: entry.aggregate_invoker,
      publish_own_figures_as: entry.publish_own_figures_as,
      first_review: entry.first_review,
    });
    const r = dynamo(deps, 'transact-write-items', ['--transact-items', JSON.stringify([
      { Put: { TableName: REGISTER_TABLE, Item: registration, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: REGISTER_TABLE, Item: { pk: { S: `${KEY_ITEM}${entry.key}` }, repository_id: { S: id } }, ConditionExpression: 'attribute_not_exists(pk)' } },
    ])]);
    if (r.ok) out.push(`${entry.repository}: imported (repository id ${id}, default branch ${defaultBranch})`);
    else {
      out.push(`${entry.repository}: refused: ${r.code === 'TransactionCanceledException' ? 'its key is already registered to another repository' : r.failure}`);
      failed += 1;
    }
  }
  if (failed) throw new Refusal([...out, `import: ${failed} of ${resolved.length} refused`].join('\n'));
  return [...out, `import: ${resolved.length} registrations, every key unchanged`];
}

// ------------------------------------------------------------------------- the CLI

/**
 * Run one subcommand. Every line it returns, on `out` or `err`, names no key.
 * @param {string[]} argv @param {Deps} deps
 * @returns {Result}
 */
export function run(argv, deps) {
  /** @type {any} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        profile: { type: 'string', default: 'kanon' },
        repository: { type: 'string' },
        reason: { type: 'string' },
        apply: { type: 'boolean', default: false },
        register: { type: 'string' },
        'aggregate-invoker': { type: 'string' },
        'publish-own-figures-as': { type: 'string' },
        'no-publish-own-figures': { type: 'boolean', default: false },
        'page-reader': { type: 'string' },
        'rows-per-day': { type: 'string' },
        'requests-per-hour': { type: 'string' },
        'first-review': { type: 'string' },
      },
    });
  } catch {
    return { code: 2, out: [], err: [USAGE] };
  }
  const { values: v, positionals } = parsed;
  const [command, ...rest] = positionals;
  const d = { ...deps, profile: v.profile };
  const needs = (/** @type {unknown} */ x) => { if (!x) throw new Refusal(USAGE); };
  try {
    if (rest.length) throw new Refusal(USAGE);
    /** @type {string[]} */
    let out;
    switch (command) {
      case 'list': out = list(d); break;
      case 'suspend': needs(v.repository && v.reason); out = suspend(d, v.repository, v.reason); break;
      case 'resume': needs(v.repository); out = resume(d, v.repository); break;
      case 'set': needs(v.repository); out = set(d, v.repository, {
        aggregateInvoker: v['aggregate-invoker'], publishOwnFiguresAs: v['publish-own-figures-as'], noPublishOwnFigures: v['no-publish-own-figures'],
        pageReader: v['page-reader'], rowsPerDay: v['rows-per-day'], requestsPerHour: v['requests-per-hour'], firstReview: v['first-review'],
      }); break;
      case 'erase': needs(v.repository); out = eraseRegistration(d, v.repository, v.apply); break;
      case 'import': needs(v.register); out = importRegister(d, v.register); break;
      default: return { code: 2, out: [], err: [USAGE] };
    }
    return { code: 0, out, err: [] };
  } catch (e) {
    if (e instanceof Refusal) return { code: e.message === USAGE ? 2 : 1, out: [], err: [e.message] };
    // Anything else is a fault of this script; its message is not trusted to be key-free.
    return { code: 1, out: [], err: [`${command}: failed (${e instanceof Error ? e.name : 'error'})`] };
  }
}

if (isCliEntry(import.meta.url)) {
  /** @type {Aws} */
  const aws = (args) => {
    const r = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const gh = (/** @type {string[]} */ args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const r = run(process.argv.slice(2), { aws, gh, profile: 'kanon', now: Date.now, readFile: (p) => readFileSync(p, 'utf8') });
  for (const line of r.out) console.log(line);
  for (const line of r.err) console.error(line);
  process.exit(r.code);
}
