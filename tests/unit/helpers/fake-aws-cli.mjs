#!/usr/bin/env node
// A stand-in for the `aws` CLI over one QA store (kanon#1346): a table and a bucket kept as JSON in
// a state directory, so a test can run several store operations, from several repositories,
// against one store and read what each one sees. A stub `aws` on PATH runs it as
// `node fake-aws-cli.mjs <state dir> "$@"`. It answers only the calls the AWS store's scripts make:
//   dynamodb put-item [--condition-expression attribute_not_exists(pk)], query (the key conditions
//   `pk = :p` and `pk = :p AND sk > :s`, last-green's filter, --no-scan-index-forward,
//   --max-items, --projection-expression), scan; s3 cp (file → bucket, bucket → file, bucket →
//   bucket); s3api list-objects-v2 --prefix. Like DynamoDB, it refuses a query that compares a key
//   with an empty string, with a ValidationException.
// Every call is appended to `<state>/calls`, one JSON array per line. No test reaches AWS.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = String(process.argv[2]);
const args = process.argv.slice(3);
appendFileSync(join(state, 'calls'), `${JSON.stringify(args)}\n`);
const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const load = (/** @type {string} */ f, /** @type {unknown} */ empty) => (existsSync(join(state, f)) ? JSON.parse(readFileSync(join(state, f), 'utf8')) : empty);
const save = (/** @type {string} */ f, /** @type {unknown} */ v) => writeFileSync(join(state, f), JSON.stringify(v));
/** @type {Array<Record<string, any>>} */
const table = load('table.json', []);
/** @type {Record<string, string>} */
const bucket = load('bucket.json', {});
const fail = (/** @type {string} */ msg, code = 254) => { process.stderr.write(`${msg}\n`); process.exit(code); };

const [service, op] = args;
if (service === 'dynamodb' && op === 'put-item') {
  const item = JSON.parse(/** @type {string} */ (opt('--item')));
  const at = table.findIndex((it) => it.pk.S === item.pk.S && it.sk.S === item.sk.S);
  if (at >= 0 && opt('--condition-expression') === 'attribute_not_exists(pk)') {
    fail('An error occurred (ConditionalCheckFailedException) when calling the PutItem operation: The conditional request failed');
  }
  if (at >= 0) table[at] = item; else table.push(item);
  save('table.json', table);
} else if (service === 'dynamodb' && op === 'query') {
  const values = JSON.parse(/** @type {string} */ (opt('--expression-attribute-values')));
  const key = opt('--key-condition-expression');
  // As DynamoDB does: a key attribute can't be an empty string, so neither can a value the key
  // condition compares it with.
  for (const name of String(key).match(/:[A-Za-z0-9_]+/g) ?? []) {
    if (values[name]?.S === '') fail(`An error occurred (ValidationException) when calling the Query operation: One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ${name}`);
  }
  let items = table.filter((it) => it.pk.S === values[':p'].S);
  if (key === 'pk = :p AND sk > :s') items = items.filter((it) => it.sk.S > values[':s'].S);
  else if (key !== 'pk = :p') fail(`fake aws: key condition '${key}' not modelled`, 2);
  items.sort((a, b) => a.sk.S.localeCompare(b.sk.S));
  if (args.includes('--no-scan-index-forward')) items.reverse();
  const filter = opt('--filter-expression');
  if (filter === '#f = :zero AND #t = :all') items = items.filter((it) => it.failed?.N === '0' && it.tier?.S === 'all');
  else if (filter) fail(`fake aws: filter '${filter}' not modelled`, 2);
  const max = opt('--max-items');
  if (max) items = items.slice(0, Number(max));
  const projection = opt('--projection-expression');
  if (projection) {
    const keep = projection.split(',').map((s) => s.trim());
    items = items.map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => keep.includes(k))));
  }
  process.stdout.write(JSON.stringify({ Items: items }));
} else if (service === 'dynamodb' && op === 'scan') {
  process.stdout.write(JSON.stringify({ Items: table }));
} else if (service === 's3' && op === 'cp') {
  const from = String(args[2]);
  const to = String(args[3]);
  const inBucket = (/** @type {string} */ u) => u.replace(/^s3:\/\/[^/]+\//, '');
  if (!from.startsWith('s3://')) bucket[inBucket(to)] = readFileSync(from, 'utf8');
  else if (!(inBucket(from) in bucket)) fail('fatal error: An error occurred (404) when calling the HeadObject operation: Not Found', 1);
  else if (to.startsWith('s3://')) bucket[inBucket(to)] = String(bucket[inBucket(from)]);
  else writeFileSync(to, String(bucket[inBucket(from)]));
  save('bucket.json', bucket);
} else if (service === 's3api' && op === 'list-objects-v2') {
  const prefix = opt('--prefix') ?? '';
  const keys = Object.keys(bucket).filter((k) => k.startsWith(prefix)).sort();
  process.stdout.write(keys.length ? JSON.stringify({ Contents: keys.map((Key) => ({ Key })) }) : '');
} else {
  fail(`fake aws: ${args.join(' ')} not modelled`, 2);
}
