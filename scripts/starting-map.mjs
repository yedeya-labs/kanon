#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-2456 part 2 — a pre-computed starting map for the implementer.
//
// WHY. The implementer is the fleet's largest spend, and every turn re-reads the whole
// context from cache. Its first turns were the same every run: `gh issue view`, then
// grep for each file the issue names, then open the spec a `[PAY-12]` points at. Each of
// those is a turn whose output every later turn pays for again. This does that work once,
// before the model starts, with no model: one file holding the issue (body + comments),
// the text of every spec clause it cites, and which of the paths it names exist in the tree.
//
// DETERMINISTIC AND CHEAP. One `gh issue view`, one `git ls-files`, and a parse of
// docs/qa/specs/. No search beyond exact-path, suffix and basename matches — a fuzzy
// "related files" guess would be a claim the agent then has to verify, which is a turn.
//
// TOLERATES MISSING PIECES. A failed read writes a map that SAYS what is missing, so the
// agent fetches that piece itself rather than trusting an empty section. And the script
// always exits 0: the workflow step is `continue-on-error` as well, because a helper must
// never red the run it helps.
//
// `node:` builtins only, like every script under scripts/.
//
// Usage: starting-map.mjs --issue <n> [--out <path>]   (default out: .agent/starting-map.md)

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DECL, SPEC_DIR, idPattern, parseAll } from './spec-lib.mjs';

const REPO = process.env.GITHUB_REPOSITORY;

/** Where the map is written, relative to the checkout. Gitignored, and named in
 *  runner-artifact-guard's DIRS, so an agent's `git add -A` cannot commit it. */
export const MAP_PATH = '.agent/starting-map.md';

/** Bounds, so a long comment thread cannot turn the map into the cost it exists to cut. */
export const MAX_COMMENTS = 10;
export const MAX_COMMENT_CHARS = 6000;
/** All shown comments together. Newest first until this is spent, so a long thread keeps
 *  its latest word (a ruling, a prior run's progress note) and says where the rest is. */
export const COMMENT_BUDGET = 20000;
export const MAX_BASENAME_MATCHES = 5;

/** Every distinct spec clause id the text cites, in first-seen order. Uses `idPattern`,
 *  so only the registered area prefixes count — `[F-1]` is not a clause. */
export function specIds(text) {
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(idPattern('g'))) seen.add(`${m[1]}-${m[2]}`);
  return [...seen];
}

/**
 * A declaration plus its continuation: the lines after it, up to the first blank line,
 * line indented no deeper than the declaration, or next declaration. A clause whose
 * conditions sit in indented sub-bullets is otherwise shown as its headline alone.
 * @param {string[]} lines  the spec file
 * @param {number} line     1-based line of the declaration
 */
export function clauseBlock(lines, line) {
  const first = lines[line - 1] ?? '';
  const indent = /^\s*/.exec(first)[0].length;
  const block = [first];
  for (let i = line; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*/.exec(l)[0].length <= indent || DECL.test(l)) break;
    block.push(l);
  }
  return block.join('\n').trim();
}

/**
 * The declaration of each cited id, and the ids no spec declares.
 * @param {string[]} ids
 * @param {{id: string|null, file: string, line: number, raw: string}[]} clauses
 * @param {(file: string) => string[]} [linesOf]  the spec file's lines, for continuations
 */
export function lookupClauses(ids, clauses, linesOf) {
  const byId = new Map(clauses.filter((c) => c.id).map((c) => [c.id, c]));
  const found = [];
  const missing = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) { missing.push(id); continue; }
    let text = c.raw.trim();
    try { if (linesOf) text = clauseBlock(linesOf(c.file), c.line); } catch { /* headline only */ }
    found.push({ id, where: `docs/qa/specs/${c.file}:${c.line}`, text });
  }
  return { found, missing };
}

/**
 * Which comments the map shows: newest first, at most `MAX_COMMENTS`, each cut at
 * `MAX_COMMENT_CHARS`, until `COMMENT_BUDGET` is spent — the newest is always shown.
 * Returned oldest-first, as the thread reads.
 */
export function shownComments(comments) {
  const out = [];
  let spent = 0;
  for (const c of [...(comments ?? [])].reverse()) {
    if (out.length >= MAX_COMMENTS) break;
    const full = String(c.body ?? '');
    const text = full.slice(0, MAX_COMMENT_CHARS);
    if (out.length && spent + text.length > COMMENT_BUDGET) break;
    spent += text.length;
    out.push({ ...c, text, truncated: full.length > text.length });
  }
  return out.reverse();
}

const EXT = '(?:tsx?|mjs|cjs|jsx?|json|ya?ml|md|sql|sh|css|html|toml)';
const PATH_RE = new RegExp(`[A-Za-z0-9_.@\\-\\[\\]()/]*[A-Za-z0-9_\\-\\])]\\.${EXT}\\b`, 'g');

/** Path-shaped tokens the text names, normalised (no `./`, no `:line`), first-seen order.
 *  URLs are removed first: a GitHub blob link names a file, but its host is not a path. */
export function pathMentions(text) {
  const plain = String(text ?? '').replace(/https?:\/\/\S+/g, ' ');
  const seen = new Set();
  for (const m of plain.matchAll(PATH_RE)) {
    let p = m[0];
    // Prose brackets are not route segments: `(see src/x.ts)` opens a paren the path never
    // closes, while `src/app/(portal)/page.tsx` balances its own.
    const count = (c) => p.split(c).length - 1;
    while (p.startsWith('(') && count('(') > count(')')) p = p.slice(1);
    while (p.startsWith('[') && count('[') > count(']')) p = p.slice(1);
    // `@/x` is the tsconfig alias for `src/x`; `../` and `./` are relative to somewhere
    // the issue does not say, so the suffix match below is the honest resolution.
    p = p.replace(/^@\//, 'src/').replace(/^(?:\.\.?\/)+/, '').replace(/^\/+/, '');
    if (p) seen.add(p);
  }
  return [...seen];
}

/**
 * Resolve each mention against the tracked tree: an exact path, else every tracked file
 * the mention is a path SUFFIX of (`specs/payments.md` → `docs/qa/specs/payments.md`,
 * and a bare `robots.ts` → `src/app/robots.ts`). What resolves nowhere is reported, not
 * dropped: a file the issue asks for that does not exist yet is what the agent creates.
 *
 * A bare name another mention already spells out in full (`robots.ts` beside
 * `src/app/robots.ts`) is dropped as a duplicate, and one that matches more than
 * `MAX_BASENAME_MATCHES` files (`page.tsx`) is reported as AMBIGUOUS rather than listed —
 * sixty route files is noise the agent would pay to re-read, not a lead.
 *
 * @param {string[]} mentions
 * @param {string[]} tracked
 */
export function resolvePaths(mentions, tracked) {
  const set = new Set(tracked);
  const resolved = [];
  const unresolved = [];
  const ambiguous = [];
  for (const m of mentions) {
    if (set.has(m)) { resolved.push({ named: m, files: [m] }); continue; }
    // A duplicate only of a longer mention that itself RESOLVES: `robots.ts` beside a
    // missing `src/app/legacy/robots.ts` still points at the file that does exist.
    if (mentions.some((o) => o !== m && o.endsWith(`/${m}`) && set.has(o))) continue;
    const hits = tracked.filter((f) => f.endsWith(`/${m}`));
    if (hits.length > MAX_BASENAME_MATCHES) ambiguous.push({ named: m, count: hits.length });
    else if (hits.length) resolved.push({ named: m, files: hits });
    // An unresolved BARE word is prose far more often than a file to create (`Next.js`,
    // `Node.js`); a new file worth naming is named with its directory.
    else if (m.includes('/')) unresolved.push(m);
  }
  return { resolved, unresolved, ambiguous };
}

const fence = (s) => {
  // A fence longer than any backtick run inside, so the body cannot close it early.
  const longest = Math.max(2, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
};

/**
 * The map itself. Every section states its own absence, so an empty one is never read as
 * "the issue named nothing" when it means "the read failed".
 */
export function render({ number, issue, issueError, clauses, specError, files, treeError }) {
  const out = [];
  out.push(`# Starting map for issue #${number}`, '');
  out.push('Written before this run started, by `scripts/starting-map.mjs` (no model; RA-2456).',
    'It is the issue as it stood at dispatch, the text of every spec clause it cites, and which',
    'of the paths it names exist. Use it instead of re-fetching or searching for these; fetch a',
    'piece yourself only where a section below says it is missing or you need more than it holds.', '');

  out.push('## Issue');
  if (!issue) {
    out.push('', `UNAVAILABLE — the read failed (${issueError ?? 'unknown error'}). Run \`gh issue view ${number} --comments\` yourself.`, '');
  } else {
    const labels = (issue.labels ?? []).map((l) => l.name ?? l).join(', ') || '(none)';
    out.push('', `**#${number} — ${issue.title}**`, `Labels: ${labels}`, '');
    const body = issue.body ?? '';
    const f = fence(body);
    out.push(f + 'markdown', body, f, '');
    const comments = issue.comments ?? [];
    const shown = shownComments(comments);
    const fetchAll = `run \`gh issue view ${number} --comments\``;
    out.push(`### Comments (${comments.length}${comments.length > shown.length ? `, latest ${shown.length} shown — ${fetchAll} for the earlier ones` : ''})`, '');
    if (!shown.length) out.push('(none)', '');
    for (const c of shown) {
      const cf = fence(c.text);
      // The association, as `gh issue view --comments` shows it: a drive-by NONE is not a
      // maintainer's ruling, and the agent is told not to re-fetch to find out.
      const who = `**${c.author?.login ?? 'unknown'}** (${String(c.authorAssociation ?? 'unknown').toLowerCase()})`;
      out.push(`- ${who} at ${c.createdAt ?? '?'}${c.truncated ? ` — TRUNCATED at ${MAX_COMMENT_CHARS} chars; ${fetchAll} for the rest` : ''}:`, '');
      out.push(cf + 'markdown', c.text, cf, '');
    }
  }

  out.push('## Spec clauses it cites');
  if (specError) out.push('', `UNAVAILABLE — docs/qa/specs/ could not be parsed (${specError}). Grep the ids yourself.`);
  else if (!clauses.found.length && !clauses.missing.length) out.push('', '(the issue cites no spec clause id)');
  for (const c of clauses?.found ?? []) out.push('', `### \`[${c.id}]\` — ${c.where}`, '', c.text);
  if (clauses?.missing?.length) out.push('', `Cited but declared by no spec (a new clause to allocate, or a typo): ${clauses.missing.map((i) => `\`[${i}]\``).join(', ')}`);
  out.push('');

  out.push('## Repo files it names');
  if (treeError) out.push('', `UNAVAILABLE — \`git ls-files\` failed (${treeError}).`);
  else if (!files.resolved.length && !files.unresolved.length && !files.ambiguous?.length) out.push('', '(the issue names no file path)');
  for (const r of files?.resolved ?? []) {
    out.push(r.files.length === 1 && r.files[0] === r.named ? `- \`${r.named}\`` : `- \`${r.named}\` → ${r.files.join(', ')}`);
  }
  if (files?.ambiguous?.length) out.push('', `Too common to resolve by name alone: ${files.ambiguous.map((a) => `\`${a.named}\` (${a.count} files)`).join(', ')}`);
  if (files?.unresolved?.length) out.push('', `Named but not in the tree (new, renamed, or not a path): ${files.unresolved.map((p) => `\`${p}\``).join(', ')}`);
  out.push('');
  return out.join('\n');
}

const msg = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 200);

/** Gather, render, write. Never throws: each piece that fails is rendered as missing. */
export function build(number, {
  readIssue = (n) => JSON.parse(execFileSync('gh', ['issue', 'view', String(n), '--repo', REPO, '--json', 'title,body,labels,comments'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })),
  readTree = () => execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean),
  readClauses = () => parseAll(),
  readSpecLines = (file) => readFileSync(join(SPEC_DIR, file), 'utf8').split('\n'),
} = {}) {
  let issue = null; let issueError = null;
  try { issue = readIssue(number); } catch (err) { issueError = msg(err); }
  // The comments the map SHOWS count too — a human's clarification after `qa:needs-info`
  // is part of the spec — but not ones it hides: a clause or file listed with no visible
  // source reads as scope nobody can trace.
  const text = issue ? [issue.title, issue.body, ...shownComments(issue.comments).map((c) => c.text)].join('\n') : '';

  let clauses = { found: [], missing: [] }; let specError = null;
  try { clauses = lookupClauses(specIds(text), readClauses(), readSpecLines); } catch (err) { specError = msg(err); }

  let files = { resolved: [], unresolved: [], ambiguous: [] }; let treeError = null;
  try { files = resolvePaths(pathMentions(text), readTree()); } catch (err) { treeError = msg(err); }

  return render({ number, issue, issueError, clauses, specError, files, treeError });
}

function main() {
  if (!REPO) {
    console.error('starting-map: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const number = Number(arg('--issue'));
  const out = arg('--out') ?? MAP_PATH;
  if (!Number.isInteger(number) || number <= 0) {
    console.log('::warning title=starting-map::no --issue number; writing no map');
    return;
  }
  try {
    const map = build(number);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, map);
    console.log(`starting map for #${number}: ${out} (${map.length} chars)`);
  } catch (err) {
    console.log(`::warning title=starting-map::could not write ${out}: ${msg(err)}`);
  }
}

const IS_CLI = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (IS_CLI) main();
