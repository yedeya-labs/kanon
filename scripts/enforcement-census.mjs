#!/usr/bin/env node
// How much of the rulebook is enforced, counted from the rules' own "Enforced by." lines (#1236).
//
//   node scripts/enforcement-census.mjs           a summary for a person
//   node scripts/enforcement-census.mjs --json    one JSON document: the counts and every rule
//
// Run it from a Kanon checkout; it reads `rulebook/NN-*.md` and nothing else, and writes nothing.
//
// THE CONVENTION IT READS. Every rule has the shape the rulebook's README fixes, and its
// "Enforced by." line names "the guard that fails when the rule is broken, or prose only". A rule
// that is prose only says so first: its line opens with "Prose only", and whatever follows is a
// note, such as what the agent instructions carry or what an adjacent mechanism checks. A line
// that names a guard but leaves part of the rule to prose says which part is prose only. A guard
// the rulebook means to build is "a guard is planned". A retired rule keeps its heading, marked
// `(**retired**)`, and has no "Enforced by." line. So each rule falls in exactly one category:
//
//   enforced                    the line opens with the mechanism that fails when the rule is
//                               broken, and says no part of the rule is prose only and no guard
//                               is still planned for it;
//   enforced in part            the line opens with a mechanism, and also says that part of the
//                               rule is prose only (anywhere in it: "the rest is prose only",
//                               "For an adopter, prose only"), or that a guard for part of it is
//                               planned, or it opens with "Partly";
//   prose only                  the line opens with "Prose only" and plans no guard;
//   prose only, guard planned   the line opens with "Prose only" and says "a guard is planned";
//   retired                     the heading is marked retired, and the rule has no line.
//
// The match is on the words, case-insensitive. A line that names no mechanism and doesn't open
// with "Prose only" can't be told from one that names one, so it counts as enforced: the
// rulebook's shape test, not this script, holds lines to the convention. A rule that is neither
// retired nor has a line is a defect the script reports, and it then exits 1.
//
// WHAT THE COUNTS ARE NOT. They count what the rulebook says enforces each rule on a repository
// that runs every mechanism. Which mechanisms run on a given repository is its adoption record's
// `## Mechanisms` list (`K-ADOPT-9`); on Kanon's own repository, `docs/qa/adoption.md`.
//
// Exit 0 with the counts, 1 when a rule has no line, 2 on a usage error.
//
// Node built-ins only.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/cli-entry.mjs';

export const CATEGORIES = /** @type {const} */ (['enforced', 'enforced in part', 'prose only', 'prose only, guard planned']);

/** @typedef {(typeof CATEGORIES)[number] | 'retired' | 'no line'} Category */
/** @typedef {{ id: string, chapter: string, category: Category, planned: boolean, line: string | null }} Rule */

const HEADING = /^### `(K-[A-Z]+-\d+)`(.*)$/;
const ENFORCED = /^\*\*Enforced by\.\*\*\s*(.*)$/;
const PLANNED = /\ba guard is planned\b/i;

/**
 * The category of one "Enforced by." line, by the rulebook's convention (the header above).
 * @param {string} line the text after "**Enforced by.**"
 * @returns {(typeof CATEGORIES)[number]}
 */
export const categoryOf = (line) => {
  const text = line.trim();
  const planned = PLANNED.test(text);
  if (/^prose only\b/i.test(text)) return planned ? 'prose only, guard planned' : 'prose only';
  if (planned || /^partly\b/i.test(text) || /\bprose only\b/i.test(text)) return 'enforced in part';
  return 'enforced';
};

/**
 * Every rule of the chapters given, each with its category.
 * @param {Array<{ chapter: string, text: string }>} chapters
 * @returns {Rule[]}
 */
export const rulesOf = (chapters) => {
  /** @type {Rule[]} */
  const rules = [];
  for (const { chapter, text } of chapters) {
    /** @type {Rule | undefined} */
    let rule;
    for (const raw of text.split(/\r?\n/)) {
      const h = HEADING.exec(raw);
      if (h) {
        rule = { id: /** @type {string} */ (h[1]), chapter, category: /\(\*\*retired\*\*\)/i.test(h[2] ?? '') ? 'retired' : 'no line', planned: false, line: null };
        rules.push(rule);
        continue;
      }
      const e = ENFORCED.exec(raw);
      if (e && rule && rule.line === null) {
        rule.line = (e[1] ?? '').trim();
        rule.category = categoryOf(rule.line);
        rule.planned = PLANNED.test(rule.line);
      }
    }
  }
  return rules;
};

/**
 * The rulebook's chapters, `NN-*.md`, in order.
 * @param {string} root a Kanon checkout
 * @returns {Array<{ chapter: string, text: string }>}
 */
export const readChapters = (root) => {
  const dir = join(root, 'rulebook');
  return readdirSync(dir)
    .filter((f) => /^\d\d-.*\.md$/.test(f))
    .sort()
    .map((f) => ({ chapter: f, text: readFileSync(join(dir, f), 'utf8') }));
};

/**
 * The counts: every rule that isn't retired falls in one category; `planned` counts the lines,
 * prose only or in part, that say a guard is planned.
 * @param {Rule[]} rules
 */
export const census = (rules) => {
  const live = rules.filter((r) => r.category !== 'retired');
  /** @type {Record<(typeof CATEGORIES)[number], number>} */
  const counts = /** @type {any} */ (Object.fromEntries(CATEGORIES.map((c) => [c, 0])));
  for (const r of live) if (r.category !== 'no line' && r.category !== 'retired') counts[r.category] += 1;
  return {
    rules: live.length,
    retired: rules.length - live.length,
    counts,
    planned: live.filter((r) => r.planned).length,
    missing: live.filter((r) => r.category === 'no line').map((r) => r.id),
  };
};

/**
 * @param {ReturnType<typeof census>} c
 * @returns {string}
 */
export const render = (c) => {
  const pct = (/** @type {number} */ n) => `${Math.round((100 * n) / Math.max(c.rules, 1))}%`;
  const width = Math.max(...CATEGORIES.map((k) => k.length));
  return [
    `${c.rules} rules${c.retired ? `, and ${c.retired} retired` : ''}, by their "Enforced by." lines:`,
    ...CATEGORIES.map((k) => `  ${k.padEnd(width)}  ${String(c.counts[k]).padStart(4)}  ${pct(c.counts[k]).padStart(4)}`),
    `${c.planned} of them say a guard is planned, prose only or in part.`,
    ...(c.missing.length ? [`No "Enforced by." line, which every rule that isn't retired has: ${c.missing.join(', ')}.`] : []),
    '',
  ].join('\n');
};

/**
 * @param {string[]} argv
 * @param {string} root
 * @returns {{ status: number, out: string, err: string }}
 */
export const main = (argv, root) => {
  const unknown = argv.filter((a) => a !== '--json');
  if (unknown.length) return { status: 2, out: '', err: `enforcement-census: unknown argument ${unknown.join(' ')}; the one option is --json\n` };
  const rules = rulesOf(readChapters(root));
  const c = census(rules);
  const out = argv.includes('--json')
    ? `${JSON.stringify({ ...c, byRule: rules.map(({ id, chapter, category, planned }) => ({ id, chapter, category, planned })) }, null, 2)}\n`
    : render(c);
  return { status: c.missing.length ? 1 : 0, out, err: '' };
};

if (isCliEntry(import.meta.url)) {
  const r = main(process.argv.slice(2), fileURLToPath(new URL('..', import.meta.url)));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exitCode = r.status;
}
