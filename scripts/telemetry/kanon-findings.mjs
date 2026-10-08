#!/usr/bin/env node
// Upstream findings, filed privately beside #41's signals (plan 0006 §6, step F5): the public
// logic. Pure: rows in, a plan of private issues out, with no network, no AWS, no git and no clock.
//
// WHERE IT RUNS. The Owner's private operations repository (the #41 job) reads the run rows AND the
// finding rows (`<key>#finding`, plan 0006 §2.3), calls this module at the Kanon release it pins,
// and files what it returns as private issues there. This file computes and prints; it reads files
// and writes stdout, and files nothing. Nothing it returns is meant for a public issue: public
// filing stays the signals' and rises' own (`kanon-bugs.mjs`), whose bodies never hold a finding.
//
// WHAT IT DOES.
//   1. Runs `kanon-bugs.mjs`'s `detect` over the run rows, unchanged, for the signals and rises.
//   2. Reads every finding row of the asked tag, and checks each again (§6, item 2):
//      - `validate`, the schema's own check, at this release;
//      - `verify`, the scrub, on `evidence` and `suggested_fix`, with that key's name hashes
//        (from the register, as `render.mjs` builds them for intake) and the release's tree;
//      - no adopter key: `assertNoKey` over every field, and each text searched for a key as a word;
//      - each `kanon_paths` entry must be a file in the tree of the finding's `kanon_version`.
//      A finding that fails any check is still filed, privately, marked `gate: failed` with the
//      check's name (field and rule, never a value). Its text and any path outside the tree are
//      withheld from the issue, and it can never be promoted (§7.1).
//   3. Groups the findings by `signature()`, the same function as the signals' (§2.4). A finding
//      with a signal's signature goes on that signal's issue: the issue's body becomes the signal's
//      counts followed by every finding with the signature, so the job updates the one issue and
//      files no second. A second finding with the same signature is one more entry on the same issue.
//
// THE TREE. A release's file list is not something this module can read without git, so the job
// gives it as a file (`--trees`): `{ "<kanon_version>": ["<path>", ...] }`, one list per release
// a finding names, as `git ls-tree -r --name-only v<version>` prints it from a Kanon clone. A
// release with no list (no such tag, or `dev`, which is no release) checks nothing against a tree,
// so a finding of it with a path or a text fails the gate, `kanon_version (no-tree)`.
//
// THE KEYS AND THE NAMES. `--register` is the private register `render.mjs` reads: every key in it
// joins the keys the output is checked against, and each entry's repository gives that key's name
// hashes through the scrub's `nameContext`, as intake has them (plan 0006 §4.2). A key with no
// entry has no name context, so a text of it fails the gate, `evidence (no-sender-context)`.
//
// NOTHING IDENTIFYING LEAVES INTO A TITLE. Titles and every line but the two text blocks are built
// from Kanon's codes, rule ids, paths in Kanon's tree, counts and days. The text blocks are the
// scrubbed evidence, shown only in the PRIVATE issue, and only when the finding passed the gate.
// Never a key, a repository, a run id or a login. The whole output is checked for every key the
// input and the register held, as a value and as a word inside any string, and refused whole if
// one appears.
//
//   node scripts/telemetry/kanon-findings.mjs --rows <file> [--known <file>] [--tag run|smoke|test]
//     [--trees <file>] [--register <file>] [--json]
//   --rows: run rows and finding rows together, a JSON array or one row per line
//   --known, --tag: as `kanon-bugs.mjs`
//   prints: with --json, `kanon-bugs.mjs`'s `{ signals, rises, skipped }` and `findings`:
//     `{ issues, skipped, total, gate_failed }`, each issue a private one (`signature`, `labels`,
//     `issue: { signature, title, body }`); without, a summary of counts
//
// `node:` built-ins only, like every script under scripts/ (`K-SELF-8`).

import { readFileSync } from 'node:fs';

import { FINDING_SUBJECTS, FIX_CATEGORIES, KANON_ERRORS, LANES, REASONS, REPORTERS, RULE_IDS, SCHEMAS, STAGES, validate } from '../../actions/agent-telemetry/schema.mjs';
import { KANON_PATH, nameContext, verify } from '../../actions/agent-telemetry/scrub.mjs';
import { assertNoKey, keyOf } from '../../infra/telemetry/function/aggregate.mjs';
import { isCliEntry } from '../lib/cli-entry.mjs';
import { MARKER, detect, parseRows, signature, summary as signalSummary } from './kanon-bugs.mjs';

/** The label every issue the job files carries, and the class labels a finding's issue adds. */
export const LABELS = Object.freeze({ bug: 'kanon-bug', finding: 'finding', gateFailed: 'gate-failed' });
/** The class labels a signal carries beside `kanon-bug`, as the job files signals: the classification itself. */
const SIGNAL_CLASS_LABELS = Object.freeze(['platform', 'adopter']);
/** The two free-text fields of a finding row (plan 0006 §2.2). */
export const TEXT_FIELDS = Object.freeze(['evidence', 'suggested_fix']);
/** What a row holds that the store set, not the lane: read for the key, never checked as the row. */
const STORE_ONLY = Object.freeze(['pk', 'sk', 'adopter', 'source', 'received_at', 'expires_at']);
/** A GitHub issue body holds 65,536 characters; past this, a finding's text is left out and counted. */
export const BODY_BUDGET = 60_000;
/** The schema's `kanon_version` pattern, read from the finding row's field list rather than copied. */
const VERSION = (() => {
  const f = /** @type {{ re?: RegExp } | undefined} */ (SCHEMAS.finding?.[1]?.kanon_version);
  if (!f?.re) throw new Error("the schema's finding row has no kanon_version pattern");
  return f.re;
})();

/**
 * @typedef {import('./kanon-bugs.mjs').Row} Row
 * @typedef {import('./kanon-bugs.mjs').Signal} Signal
 * @typedef {{ field: string, problem: string }} Problem
 * @typedef {{ key: string, reporter: string, subject: string, lane: string | null, failed_stage: string | null,
 *   kanon_error: string | null, reason: string | null, kanon_version: string, rules: string[], paths: string[],
 *   withheld_paths: number, fix_category: string, evidence_level: string, evidence: string | null,
 *   suggested_fix: string | null, recorded_at: string, order: string, problems: Problem[], signature: string }} Finding
 * @typedef {{ kind: 'finding', signature: string, signal: boolean, labels: string[], findings: number,
 *   adopters: number, gate_failed: number, issue: { signature: string, title: string, body: string } }} FindingIssue
 * @typedef {{ not_finding: number, no_version: number, no_adopter: number }} FindingSkipped
 * @typedef {{ trees?: Record<string, readonly string[]>, names?: Record<string, Iterable<string>>, keys?: Iterable<string>,
 *   known?: Iterable<string>, tag?: string }} Options
 */

/** A code read only when it is in Kanon's list; absent or anything else is `null`. */
const codeIn = (/** @type {unknown} */ v, /** @type {readonly string[]} */ list) => (typeof v === 'string' && list.includes(v) ? v : null);
/** A list field's items, as the schema stores it (comma-separated) or as an array. */
const items = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v !== '' ? v.split(',') : []);
/** Whether a text holds a key as a word, not inside a longer run of key characters (as intake reads it). */
export const holdsKey = (/** @type {string} */ text, /** @type {string} */ key) =>
  key !== '' && new RegExp(`(?<![a-z0-9-])${key.replace(/[-]/g, '\\-')}(?![a-z0-9-])`).test(text.toLowerCase());

/**
 * Refuse a value that holds an adopter key: as a whole value (`assertNoKey`), or as a word inside
 * any string, which an issue body would carry where `assertNoKey` can't see it.
 * @param {unknown} value
 * @param {Set<string>} keys
 */
export function assertNoKeyIn(value, keys) {
  assertNoKey(value, keys);
  const walk = (/** @type {unknown} */ v) => {
    if (typeof v === 'string') { for (const k of keys) if (holdsKey(v, k)) throw new Error('the output holds an adopter key; nothing is returned'); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value);
}

/**
 * The register's keys and each key's name hashes, as `render.mjs` builds `NAME_HASHES` for intake:
 * the words of the registered repository's owner and name, hashed. Reads nothing else of it.
 * @param {any} register
 * @returns {{ keys: string[], names: Record<string, string[]> }}
 */
export function registerContext(register) {
  const entries = Array.isArray(register?.repositories) ? register.repositories : null;
  if (!entries) throw new Error('the register has no repositories');
  /** @type {Record<string, string[]>} */
  const names = {};
  for (const e of entries) {
    if (typeof e?.key !== 'string' || e.key === '' || typeof e.repository !== 'string' || e.repository === '') throw new Error('a register entry has no key or repository');
    names[e.key] = [...nameContext({ repository: e.repository })].sort();
  }
  return { keys: Object.keys(names), names };
}

/**
 * One finding row, read and checked again (plan 0006 §6, item 2). Returns null for a row this
 * module doesn't read (another kind or tag, no version, no key), with the reason.
 * @param {Row} row
 * @param {{ tag: string, trees: Record<string, readonly string[]>, names: Record<string, Iterable<string>>, keys: Set<string> }} ctx
 * @returns {{ finding: Finding } | { skip: keyof FindingSkipped }}
 */
export function readFinding(row, { tag, trees, names, keys }) {
  if (row === null || typeof row !== 'object' || row.row_kind !== 'finding' || row.tag !== tag) return { skip: 'not_finding' };
  const version = typeof row.kanon_version === 'string' && VERSION.test(row.kanon_version) ? row.kanon_version : null;
  if (!version) return { skip: 'no_version' };
  const key = typeof row.adopter === 'string' && row.adopter !== '' ? row.adopter : keyOf(row.pk);
  if (!key) return { skip: 'no_adopter' };

  /** @type {Problem[]} */
  const problems = [];
  const own = Object.fromEntries(Object.entries(row).filter(([k]) => !STORE_ONLY.includes(k)));
  const v = validate(own);
  if (!v.ok) problems.push(...v.errors);

  const tree = Object.hasOwn(trees, version) ? new Set(trees[version]) : null;
  const paths = items(row.kanon_paths).filter((p) => KANON_PATH.test(p));
  const texts = TEXT_FIELDS.filter((f) => typeof row[f] === 'string' && row[f] !== '');
  if (!tree && (paths.length || texts.length)) problems.push({ field: 'kanon_version', problem: 'no-tree' });
  const inTree = tree ? paths.filter((p) => tree.has(p)) : [];
  if (tree && inTree.length < items(row.kanon_paths).length) problems.push({ field: 'kanon_paths', problem: 'not-in-tree' });

  const nameHashes = Object.hasOwn(names, key) ? new Set(names[key]) : null;
  for (const f of texts) {
    if (!nameHashes) { problems.push({ field: f, problem: 'no-sender-context' }); continue; }
    if (!tree) continue;
    for (const rule of verify(/** @type {string} */ (row[f]), { nameHashes, kanonFiles: tree })) problems.push({ field: f, problem: rule });
  }
  // A key as any field's value or as a word inside it, the texts included (as intake checks them).
  for (const [field, value] of Object.entries(own)) {
    if (typeof value === 'string' && [...keys].some((k) => holdsKey(value, k))) problems.push({ field, problem: 'key' });
  }

  const unique = [...new Map(problems.map((p) => [`${p.field} (${p.problem})`, p])).values()];
  const passed = unique.length === 0;
  const s = {
    lane: codeIn(row.lane, LANES), failed_stage: codeIn(row.failed_stage, STAGES),
    kanon_error: codeIn(row.kanon_error, KANON_ERRORS), reason: codeIn(row.reason, REASONS),
  };
  const rules = items(row.rules).filter((r) => RULE_IDS.includes(r));
  /** @type {Finding} */
  const finding = {
    key, ...s, kanon_version: version,
    reporter: codeIn(row.reporter, REPORTERS) ?? 'unknown', subject: codeIn(row.subject, FINDING_SUBJECTS) ?? 'unknown',
    rules, paths: inTree, withheld_paths: items(row.kanon_paths).length - inTree.length,
    fix_category: codeIn(row.fix_category, FIX_CATEGORIES) ?? 'unknown',
    evidence_level: row.evidence_level === 'evidence' ? 'evidence' : 'codes',
    evidence: passed && typeof row.evidence === 'string' ? row.evidence : null,
    suggested_fix: passed && typeof row.suggested_fix === 'string' ? row.suggested_fix : null,
    recorded_at: typeof row.recorded_at === 'string' ? row.recorded_at : '',
    // The order on the issue: by time, then reporter and place, never by anything identifying.
    order: `${typeof row.recorded_at === 'string' ? row.recorded_at : ''}\u0000${String(row.reporter)}\u0000${String(row.finding_index).padStart(2, '0')}`,
    problems: unique,
    // The row's own codes, as stored, so a finding signs as its lane sent it (§2.4).
    signature: signature({ ...s, kanon_version: version, rules: items(row.rules), kanon_paths: items(row.kanon_paths) }),
  };
  return { finding };
}

const day = (/** @type {string} */ t) => t.slice(0, 10);
const code = (/** @type {string | null} */ v) => (v === null ? 'none' : `\`${v}\``);
/** A fence longer than any run of backticks in the text, so the text can't close it. */
const fenced = (/** @type {string} */ text) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}text`, text, fence];
};

/** One finding's entry on the issue. @param {Finding} f @param {number} n @param {boolean} withText */
function renderFinding(f, n, withText) {
  const out = [
    `### Finding ${n}: ${f.reporter}, subject \`${f.subject}\`, ${day(f.recorded_at)}`,
    '',
    f.problems.length
      ? `- **gate: failed**: ${f.problems.map((p) => `\`${p.field} (${p.problem})\``).join(', ')}. Its text and any path outside the release's tree are withheld, and it can never be promoted.`
      : '- gate: passed.',
    `- Codes: lane ${code(f.lane)}, stage ${code(f.failed_stage)}, error ${code(f.kanon_error)}, reason ${code(f.reason)}, version \`${f.kanon_version}\``,
    `- Rules: ${f.rules.map((r) => `\`${r}\``).join(', ') || 'none'}`,
    `- Kanon paths: ${f.paths.map((p) => `\`${p}\``).join(', ') || 'none'}${f.withheld_paths ? ` (${f.withheld_paths} withheld: not a file in the release's tree)` : ''}`,
    `- Fix category: \`${f.fix_category}\`; level \`${f.evidence_level}\``,
  ];
  if (f.evidence !== null || f.suggested_fix !== null) {
    if (!withText) out.push('- Evidence and suggested fix: not shown, the issue body is full. Read them in the store.');
    else {
      if (f.evidence !== null) out.push('', '**Evidence** (scrubbed in the adopter\'s lane; private):', '', ...fenced(f.evidence));
      if (f.suggested_fix !== null) out.push('', '**Suggested fix** (private):', '', ...fenced(f.suggested_fix));
    }
  }
  return out.join('\n');
}

/** A finding-only issue's title, from codes only. @param {Finding} f */
function findingTitle(f) {
  if (f.lane) {
    const what = f.kanon_error ?? f.reason;
    return `Kanon finding: ${f.lane} lane${what ? `, \`${what}\`` : ''}${f.failed_stage ? ` at stage \`${f.failed_stage}\`` : ''}, on ${f.kanon_version}`;
  }
  const named = [...f.rules, ...f.paths];
  const what = named.length ? `, ${named.slice(0, 3).join(', ')}${named.length > 3 ? ` and ${named.length - 3} more` : ''}` : '';
  return `Kanon finding: ${f.subject}${what}, on ${f.kanon_version}`;
}

/**
 * The private issue of one signature: the signal's body, if there is one, then every finding.
 * @param {string} sig
 * @param {Finding[]} findings sorted
 * @param {Signal | undefined} signal
 * @returns {FindingIssue}
 */
export function renderFindingIssue(sig, findings, signal) {
  const first = /** @type {Finding} */ (findings[0]);
  const adopters = new Set(findings.map((f) => f.key)).size;
  const failed = findings.filter((f) => f.problems.length).length;
  const tail = `\n\n<!-- ${MARKER}=${sig} -->`;
  const head = signal
    ? [signal.issue.body.endsWith(tail) ? signal.issue.body.slice(0, -tail.length) : signal.issue.body, '']
    : [
      `Upstream findings sent by adopters' lanes (plan 0006), with no matching signal in the run rows. Codes, Kanon's paths and counts only, except for the evidence text below. No adopter, repository or run is named.`,
      '',
      'A human triages this issue; the job that filed it does nothing else (`K-PRIN-6`).',
      '',
    ];
  const intro = [
    `## Upstream findings: ${findings.length}, from ${adopters} adopter(s)${failed ? `, ${failed} failing the gate` : ''}`,
    '',
    "**Private.** The evidence and suggested fix below are for Kanon's maintainer only, and never go into a public issue (plan 0006 §7.6).",
  ];
  /** @type {string[]} */
  const blocks = [];
  let size = [...head, ...intro].join('\n').length + tail.length;
  let textless = 0;
  let unlisted = 0;
  findings.forEach((f, i) => {
    let block = renderFinding(f, i + 1, true);
    if (size + block.length + 2 > BODY_BUDGET) {
      block = renderFinding(f, i + 1, false);
      if (size + block.length + 2 > BODY_BUDGET) { unlisted += 1; return; }
      if (f.evidence !== null || f.suggested_fix !== null) textless += 1;
    }
    size += block.length + 2;
    blocks.push(block);
  });
  const full = [
    textless ? `${textless} finding(s) shown without their text: the issue body is full.` : '',
    unlisted ? `${unlisted} more finding(s) with this signature not listed: the issue body is full.` : '',
  ].filter(Boolean);
  const body = [...head, ...intro, '', blocks.join('\n\n'), ...(full.length ? ['', ...full] : [])].join('\n').replace(/\n+$/, '') + tail;
  const labels = [LABELS.bug, ...(signal && SIGNAL_CLASS_LABELS.includes(signal.classification) ? [signal.classification] : []), LABELS.finding, ...(failed ? [LABELS.gateFailed] : [])];
  return {
    kind: 'finding', signature: sig, signal: Boolean(signal), labels, findings: findings.length, adopters, gate_failed: failed,
    issue: { signature: sig, title: signal ? signal.issue.title : findingTitle(first), body },
  };
}

/**
 * The plan: `detect`'s signals and rises, unchanged, and one private issue per signature that has
 * a finding (the file's head says what each holds).
 * @param {Row[]} rows run rows and finding rows together
 * @param {Options} [opts]
 */
export function plan(rows, { trees = {}, names = {}, keys = [], known = [], tag = 'run' } = {}) {
  const runRows = rows.filter((r) => r?.row_kind !== 'finding');
  const findingRows = rows.filter((r) => r?.row_kind === 'finding');
  const bugs = detect(runRows, { known, tag });
  /** @type {Set<string>} */
  const allKeys = new Set(keys);
  for (const r of rows) {
    const k = r && typeof r === 'object' ? (typeof r.adopter === 'string' && r.adopter !== '' ? r.adopter : keyOf(r.pk)) : '';
    if (k) allKeys.add(k);
  }
  /** @type {FindingSkipped} */
  const skipped = { not_finding: 0, no_version: 0, no_adopter: 0 };
  /** @type {Map<string, Finding[]>} */
  const groups = new Map();
  for (const row of findingRows) {
    const r = readFinding(row, { tag, trees, names, keys: allKeys });
    if ('skip' in r) { skipped[r.skip] += 1; continue; }
    const g = groups.get(r.finding.signature) ?? [];
    g.push(r.finding);
    groups.set(r.finding.signature, g);
  }
  const signals = new Map(bugs.signals.map((s) => [s.signature, s]));
  const issues = [...groups].map(([sig, fs]) => renderFindingIssue(sig, fs.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)), signals.get(sig)))
    .sort((a, b) => a.signature.localeCompare(b.signature));
  const total = issues.reduce((n, i) => n + i.findings, 0);
  const result = { ...bugs, findings: { issues, skipped, total, gate_failed: issues.reduce((n, i) => n + i.gate_failed, 0) } };
  assertNoKeyIn(result, allKeys);
  return result;
}

/** The summary line, counts only. @param {ReturnType<typeof plan>} r */
export function summary(r) {
  const f = r.findings;
  const skipped = Object.entries(f.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replaceAll('_', ' ')}`).join(', ');
  return `${signalSummary(r)} ${f.total} finding(s) on ${f.issues.length} private issue(s), `
    + `${f.issues.filter((i) => i.signal).length} of them a signal's; ${f.gate_failed} failed the gate.${skipped ? ` Finding rows skipped: ${skipped}.` : ''}`;
}

/**
 * The CLI, as a function the tests call.
 * @param {string[]} argv
 * @returns {{ code: number, out: string }}
 */
export function main(argv) {
  const usage = 'usage: kanon-findings.mjs --rows <file> [--known <file>] [--tag run|smoke|test] [--trees <file>] [--register <file>] [--json]';
  /** @type {Record<string, string>} */
  const opts = {};
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (['--rows', '--known', '--tag', '--trees', '--register'].includes(String(a)) && argv[i + 1] !== undefined) { opts[String(a).slice(2)] = /** @type {string} */ (argv[i + 1]); i += 1; continue; }
    return { code: 2, out: usage };
  }
  if (!opts.rows) return { code: 2, out: usage };
  if (opts.tag && !['run', 'smoke', 'test'].includes(opts.tag)) return { code: 2, out: usage };
  /** @type {Options} */
  const o = { tag: opts.tag ?? 'run' };
  let rows;
  try {
    rows = parseRows(readFileSync(opts.rows, 'utf8'));
    if (opts.known) {
      const k = JSON.parse(readFileSync(opts.known, 'utf8'));
      if (!Array.isArray(k) || !k.every((s) => typeof s === 'string')) return { code: 2, out: '--known is not a JSON array of signatures' };
      o.known = k;
    }
    if (opts.trees) {
      const t = JSON.parse(readFileSync(opts.trees, 'utf8'));
      if (!t || typeof t !== 'object' || Array.isArray(t) || !Object.values(t).every((l) => Array.isArray(l) && l.every((p) => typeof p === 'string'))) {
        return { code: 2, out: '--trees is not a JSON object of path lists' };
      }
      o.trees = t;
    }
    if (opts.register) Object.assign(o, registerContext(JSON.parse(readFileSync(opts.register, 'utf8'))));
  } catch (e) {
    // The error's name only: a message could quote a row or the register.
    return { code: 2, out: `could not read the input (${e instanceof Error ? e.name : 'error'})` };
  }
  let r;
  try {
    r = plan(rows, o);
  } catch {
    return { code: 2, out: 'refused: the output would hold an adopter key, so nothing is printed' };
  }
  return { code: 0, out: json ? JSON.stringify(r, null, 2) : summary(r) };
}

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  const { code, out } = main(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exit(code);
}
/* c8 ignore stop */
