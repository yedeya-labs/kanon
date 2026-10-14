#!/usr/bin/env node
// Intake first (kanon#794), run by the Owner before a release reaches adopters.
//
//   node infra/telemetry/intake-first.mjs --deployed <release intake was deployed from> [--release <ref>]
//
// A lane writes what its release's schema allows, and the ingest function refuses what its own
// release's schema doesn't: a raised `SCRUB_VERSION` is a 422 `scrub_version` `range`, a new row
// version or lane a 422 `enum`, and the collector turns red. So a release that widens the schema
// needs intake deployed from it before any repository's pin reaches it (plan 0006 §4.2). This
// compares the schema at the release intake was deployed from with the release's own (HEAD by
// default), both read from git, and names every widening: a row kind, version or field the
// deployed intake doesn't know, a value or bound it refuses, a field the release makes optional or
// drops where the deployed intake requires it, and a pattern or type that differs.
//
// It names every narrowing too, the same comparison the other way round: a row the deployed
// intake accepts that the release's schema refuses (kanon#828). A repository on an older pin
// writes only what the deployed intake accepts, or its collector is red already, so intake
// deployed from such a release can refuse that repository's rows. Deploying first doesn't help
// it: the deploy itself turns it red, until its pin moves past the narrowing.
//
// It reads `SCHEMAS` alone. The cross-field rules in `validate` are code, not data, so a change to
// them is not seen here; the scrub's rules are, through `scrub_version`, which a change to them
// raises (plan 0006 §4.2).
//
// It exits 0 when it names nothing, 1 when it names widenings alone, 3 when it names a narrowing,
// with or without widenings, and 2 when `--deployed` is missing or it can't read a ref.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** Where the schema the lanes write and the function validates with lives, in every release. */
export const SCHEMA_DIR = 'actions/agent-telemetry';

const INT_MAX = 2 ** 31 - 1;

/**
 * @typedef {Record<string, unknown> & { type: string, required?: boolean }} Field
 * @typedef {Record<string, Record<string, Record<string, Field>>>} Schemas
 */

const article = (/** @type {string} */ t) => (/^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`);
/** The bounds `validate` reads when a field sets none. */
const minOf = (/** @type {Field} */ f) => /** @type {number} */ (f.min ?? 0);
const maxOf = (/** @type {Field} */ f) => /** @type {number} */ (f.max ?? INT_MAX);
const reOf = (/** @type {Field} */ f) => (f.re instanceof RegExp ? `${f.re.source}/${f.re.flags}` : undefined);

/**
 * What a field accepts as `is` that it refused as `was`, the schema named `other`.
 * @param {Field} was
 * @param {Field} is
 * @param {string} other
 * @returns {string[]}
 */
function fieldWidenings(was, is, other) {
  if (was.type !== is.type) return [`${article(is.type)}, where ${other} has ${article(was.type)}`];
  const out = [];
  if (was.required && !is.required) out.push(`optional, where ${other} requires it`);
  if (is.type === 'enum' || is.type === 'list') {
    const known = /** @type {readonly unknown[] | undefined} */ (was.values);
    const values = /** @type {readonly unknown[] | undefined} */ (is.values);
    if (known && !values) out.push(`accepts any value, where ${other} holds a list`);
    for (const v of known && values ? values.filter((x) => !known.includes(x)) : []) out.push(`accepts ${v}, which ${other} does not`);
  }
  if (is.type === 'int' || is.type === 'number') {
    if (minOf(is) < minOf(was)) out.push(`accepts from ${minOf(is)}, ${other} from ${minOf(was)}`);
    if (maxOf(is) > maxOf(was)) out.push(`accepts up to ${maxOf(is)}, ${other} up to ${maxOf(was)}`);
  }
  if (is.type === 'text' && maxOf(is) > maxOf(was)) out.push(`accepts up to ${maxOf(is)} characters, ${other} up to ${maxOf(was)}`);
  if (is.type === 'list' && maxOf(is) > maxOf(was)) out.push(`accepts up to ${maxOf(is)} items, ${other} up to ${maxOf(was)}`);
  if (is.pair !== was.pair) out.push(`its pairing differs from ${other}'s`);
  // A regular expression's language can't be compared, so any change is named.
  if (reOf(is) !== reOf(was)) out.push(`its pattern differs from ${other}'s`);
  return out;
}

/**
 * Every row `to` accepts that `from`, named `other`, refuses, one line each, in `to`'s order: by
 * row kind, version and field. `absent` says what a field `from` requires and `to` lacks is.
 * @param {Schemas} from
 * @param {Schemas} to
 * @param {{ other: string, absent: string }} words
 * @returns {string[]}
 */
function accepted(from, to, { other, absent }) {
  const out = [];
  for (const [kind, versions] of Object.entries(to)) {
    if (!Object.hasOwn(from, kind)) { out.push(`${kind}: a row kind ${other} does not know`); continue; }
    for (const [version, fields] of Object.entries(versions)) {
      const was = from[kind]?.[version];
      const at = `${kind} v${version}`;
      if (!was) { out.push(`${at}: a version ${other} does not know`); continue; }
      for (const [name, f] of Object.entries(fields)) {
        const old = was[name];
        if (!old) { out.push(`${at} ${name}: a field ${other} does not know`); continue; }
        for (const w of fieldWidenings(old, f, other)) out.push(`${at} ${name}: ${w}`);
      }
      for (const [name, old] of Object.entries(was)) {
        if (old.required && !Object.hasOwn(fields, name)) out.push(`${at} ${name}: ${absent}, where ${other} requires it`);
      }
    }
  }
  return out;
}

/**
 * Every row the release's schema accepts that the deployed intake's refuses, one line each, in
 * the release's order: by row kind, version and field.
 * @param {Schemas} deployed
 * @param {Schemas} release
 * @returns {string[]}
 */
export const widenings = (deployed, release) =>
  accepted(deployed, release, { other: 'the deployed intake', absent: 'no longer in the schema' });

/**
 * Every row the deployed intake's schema accepts that the release's refuses, one line each, in
 * the deployed intake's order (kanon#828). Each line says what the deployed intake accepts.
 * @param {Schemas} deployed
 * @param {Schemas} release
 * @returns {string[]}
 */
export const narrowings = (deployed, release) =>
  accepted(release, deployed, { other: 'the release', absent: 'absent from every row the deployed intake accepts' });

/**
 * The `SCHEMAS` a ref holds: its `actions/agent-telemetry/` modules copied out of git into a
 * scratch directory and imported from there, so the checkout's own files play no part.
 * @param {string} ref
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<Schemas>}
 */
export async function schemasAt(ref, { cwd = process.cwd() } = {}) {
  const git = (/** @type {string[]} */ ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args[0]} ${ref}: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    return r.stdout;
  };
  const commit = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim();
  const files = git('ls-tree', '--name-only', commit, `${SCHEMA_DIR}/`).split('\n').filter((p) => p.endsWith('.mjs'));
  if (!files.some((p) => p === `${SCHEMA_DIR}/schema.mjs`)) throw new Error(`${ref} holds no ${SCHEMA_DIR}/schema.mjs`);
  const dir = mkdtempSync(join(tmpdir(), 'intake-first-'));
  try {
    for (const p of files) writeFileSync(join(dir, p.slice(SCHEMA_DIR.length + 1)), git('show', `${commit}:${p}`));
    const mod = await import(pathToFileURL(join(dir, 'schema.mjs')).href);
    if (!mod.SCHEMAS) throw new Error(`${ref}'s schema.mjs exports no SCHEMAS`);
    return mod.SCHEMAS;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { deployed: { type: 'string' }, release: { type: 'string', default: 'HEAD' } } });
  if (!values.deployed) {
    console.error('usage: intake-first.mjs --deployed <release intake was deployed from> [--release <ref>]');
    return 2;
  }
  let wide, narrow;
  try {
    const deployed = await schemasAt(values.deployed);
    const release = await schemasAt(values.release);
    wide = widenings(deployed, release);
    narrow = narrowings(deployed, release);
  } catch (e) {
    console.error(`intake-first: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
  if (wide.length === 0) {
    console.log(`Intake deployed from ${values.deployed} accepts every row ${values.release} can write, as far as the schema says.`);
  } else {
    console.log(`Intake deployed from ${values.deployed} refuses rows ${values.release} can write:`);
    for (const line of wide) console.log(`  - ${line}`);
    console.log('So deploy intake from this release, and run verify.mjs, before it reaches adopters (docs/release.md, Intake first).');
  }
  if (narrow.length === 0) return wide.length === 0 ? 0 : 1;
  console.log('');
  console.log(`Intake deployed from ${values.release} would refuse rows intake deployed from ${values.deployed} accepts, which a repository on an older pin can write:`);
  for (const line of narrow) console.log(`  - ${line}`);
  console.log(wide.length === 0
    ? 'So hold the deploy of intake from this release until no repository\'s pin writes them (docs/release.md, Intake first).'
    : 'Either way, a repository\'s collector turns red: this release\'s without the deploy, an older pin\'s with it. Decide before merging (docs/release.md, Intake first).');
  return 3;
}

if (isCliEntry(import.meta.url)) process.exitCode = await main();
