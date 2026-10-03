#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// Fail lint when a repo-relative path cited in a doc or a code comment names a file that
// does not exist (RA-919).
//
// THE INSTANCE. PR RA-914 cited `docs/agentic-lead-engineer.md` four times — a code
// comment, two workflow comments and a rendered markdown link — as the design of record
// for the change and as one of three reasons to create a GitHub App. The file did not
// exist. It passed four review rounds, each of which found a real defect elsewhere in the
// same files. The cost is not the 404: it is that the REASON for a decision becomes
// unauditable, and nothing distinguishes a citation to a document that was never written
// from a correct one. `citation-guard` does not: it reads `file:line` coordinates, and a
// path cited without a line is only an antecedent there, never resolved.
//
// TWO RULES, sized by what was measured before adopting them (2026-09-24):
//
//   1. A MARKDOWN LINK TARGET in any tracked `.md` — `[x](../y.md)` — resolves, relative
//      to the linking file, to a tracked file or directory. The unambiguous subset: a link
//      is a claim that a reader can follow it. 165 local links, 0 broken.
//
//   2. A PATH NAMED IN TEXT — `docs/…`, `scripts/…`, `.github/…` with a file extension —
//      in any tracked markdown (minus the dated briefs) — `docs/**`, and also AGENTS.md,
//      the `.claude/**` skills and agents and the `.github/**` templates, which are the
//      files an agent actually executes — or in a source/workflow file
//      outside the test trees resolves to a tracked file. Narrower on purpose: the same
//      regex over every root and every file found 119 distinct missing paths, and all but
//      a handful were FIXTURES in `tests/`/`e2e/` (`src/a.ts`, `docs/x.md`) — a test
//      names paths that do not exist because that is what a fixture is. Outside the test
//      trees, `src/` and `drizzle/` mentions are overwhelmingly illustrative
//      (`src/server/services/foo.ts:42` in a prompt's example), so those roots are out too.
//      What is left is the RA-914 shape exactly: a design doc, a script, a workflow.
//
// Illustrative and historical mentions that survive the narrowing are EXEMPTED BY NAME
// below, one (file, path) pair each with its reason, and an exemption that no longer
// matches anything fails the run — a list that only grows is how a guard narrows to
// nothing (the stale-exemption rule `mutation-refresh-convention` and RA-998's guard follow).
//
//   3. A HEADING ANCHOR in a markdown link — `[x](./y.md#some-heading)` or `[x](#h)` —
//      names a heading (or an explicit `<a id|name="…">`) that exists in the target
//      file (RA-2001). A renamed heading otherwise rots every link into it silently: the
//      link still renders and lands the reader at the top of a 1,700-line doc. RA-1997
//      renamed `observability.md` §2b.1 and `deployment.md`'s link into it kept the old
//      slug through a green CI run. Slugs follow GitHub's algorithm (github-slugger):
//      lowercase, drop every character that is not a letter, mark, number, `_`, `-` or
//      space, spaces → `-` (so `2b.1 The — x` → `2b1-the--x`), and `-1`, `-2` … for a
//      repeated heading. Only links whose target is a readable `.md` are checked.
//
// Out of scope, as RA-919 set it: `§5.5`-style prose anchors and external URLs. A fenced
// code block is skipped in markdown: it illustrates commands and output, not claims.
//
// Exit 1 on any finding. Usage: node scripts/doc-path-guard.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
// `fencedLines` only — spec-lib reads no file at module load, so this adds no spec dependency.
import { fencedLines } from './spec-lib.mjs';
import { TABLE_EXT } from './lib/test-conventions.mjs';

/** A markdown inline link or image target: `](target)` or `](target "title")`. */
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Rule 2's path shape. The look-behind keeps it off the tail of a longer path or URL. */
const TEXT_PATH = /(?<![\w./@~-])((?:docs|scripts|\.github)\/[\w./[\]-]*[\w\]]\.(?:md|mjs|cjs|js|ts|tsx|py|go|yml|yaml|sh|json))(?![\w/])/g;

/** Source files rule 2 reads outside `docs/`: workflows, shell, and the languages of the
 *  per-language table (`scripts/lib/test-conventions.mjs`, kanon#20), so a Python or Go
 *  project's source is read as a JavaScript project's is. */
const CODE = new RegExp(`\\.(?:${TABLE_EXT}|cjs|yml|yaml|sh)$`);

/** Trees whose files are fixtures by construction, never read by rule 2 (see header). */
const TEST_TREES = ['tests/', 'e2e/'];

/** Dated records — a brief measures a commit that has passed (the same exclusion
 *  `citation-guard.mjs`'s `PROJECTS_TREE` makes, RA-1742), and a release note names the
 *  files as they were when it shipped. Rule 1 still reads them. */
const DATED_TREES = ['docs/projects/', 'CHANGELOG.md'];

/**
 * Mentions that name a path which does not exist ON PURPOSE. Keyed on the exact
 * (citing file, cited path) pair, so an exemption cannot spread to a second file or a
 * second path.
 */
export const EXEMPTIONS = [
  { file: 'docs/deferred-features.md', path: 'docs/TODO.md', reason: 'names the TODO file retired 2026-06-20, as history' },
  { file: 'docs/fe-gap-analysis.md', path: 'docs/TODO.md', reason: 'dated gap analysis recording where its action items were tracked at the time' },
  { file: 'docs/legacy-service-api.md', path: 'docs/api.md', reason: 'the LEGACY CakePHP repo\'s doc, not this repository\'s' },
  { file: 'docs/qa/capability-ledger.md', path: 'docs/configuration.md', reason: 'a file:line in the claude-code-action repository, quoted as evidence' },
  { file: 'docs/qa/capability-ledger.md', path: 'docs/security.md', reason: 'a file:line in the claude-code-action repository, quoted as evidence' },
  { file: 'docs/agentic-qa-pipeline.md', path: 'docs/a.md', reason: 'the same illustrative cite, in the doc describing that telemetry field' },
  { file: '.github/ISSUE_TEMPLATE/agent-implement.md', path: 'docs/qa/specs/____.md', reason: 'a blank the issue author fills in' },
];

/** This file names every exempted path in the list above, so rule 2 does not read it.
 *  Rule 1 reads only `.md` files, so the exclusion hides no link. */
export const SELF = 'scripts/qa/doc-path-guard.mjs';

const isExternal = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//');

/**
 * GitHub's heading slug (github-slugger), applied to the heading's RENDERED text: inline
 * links and images collapse to their text, HTML tags vanish, and emphasis `_` markers at
 * a word edge are dropped before slugging (a literal `snake_case` underscore survives) —
 * the last two only outside a code span.
 */
// A PAIRED `_x_` / `__x__` at word edges is emphasis and renders without the markers; a
// lone edge underscore (`FOO_`) is literal text and survives into the slug.
const EMPHASIS_UNDERSCORE = /(^|[^\w])_{1,2}(?=\S)(.+?)(?<=\S)_{1,2}(?=[^\w]|$)/g;

export const slugify = (heading) =>
  heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Tags and emphasis are markup only OUTSIDE a code span: `(#<n>)` in backticks renders
    // as the literal text `<n>`, so its `n` survives into the slug.
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/<[^>]+>/g, '').replace(EMPHASIS_UNDERSCORE, '$1$2')))
    .join('')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');

/** Every anchor a markdown file exposes: heading slugs (deduplicated as GitHub does) and
 *  explicit `<a id="…">` / `<a name="…">` targets. Fenced lines are not headings. */
export const anchorsOf = (src) => {
  const lines = src.split('\n');
  const skip = fencedLines(lines);
  const out = new Set();
  const seen = new Map();
  lines.forEach((line, i) => {
    if (skip.has(i)) return;
    for (const m of line.matchAll(/<a\s[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) out.add(m[1]);
    // ATX (`## x`), or setext: a text line underlined by `===` / `---` (a table's
    // `|---|` row has pipes, and a blank line above `---` is a rule, not a heading).
    const atx = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    const next = lines[i + 1];
    const setext =
      !atx && line.trim() && !skip.has(i + 1) && next !== undefined && /^ {0,3}(?:=+|-+)\s*$/.test(next) && !/^\s*[-*+>|]/.test(line)
        ? line.trim()
        : null;
    const text = atx ? atx[1] : setext;
    if (text === null || text === undefined) return;
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  });
  return out;
};

/**
 * @param {string[]} files the files to read (repo-relative)
 * @param {(path: string) => string} readFile
 * @param {string[]} tracked every tracked path — what a citation must resolve to
 * @returns {{findings: {at: string, path: string, rule: 'link'|'text'|'fence'|'anchor'}[], links: number,
 *            mentions: number, anchors: number, exemptionsUsed: Set<number>}}
 */
export const auditPaths = (files, readFile, tracked) => {
  const known = new Set(tracked);
  const dirs = new Set();
  for (const f of tracked) for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) dirs.add(d);
  const findings = [];
  const exemptionsUsed = new Set();
  let links = 0;
  let mentions = 0;
  let anchors = 0;
  const anchorCache = new Map();
  const anchorsFor = (path) => {
    if (!anchorCache.has(path)) {
      let src;
      try { src = readFile(path); } catch { src = undefined; }
      anchorCache.set(path, typeof src === 'string' ? anchorsOf(src) : null);
    }
    return anchorCache.get(path);
  };
  const checkAnchor = (at, raw, targetFile, fragment) => {
    if (!fragment || !targetFile.endsWith('.md')) return;
    const known = anchorsFor(targetFile);
    if (!known) return;
    anchors += 1;
    let frag;
    try { frag = decodeURIComponent(fragment); } catch { frag = fragment; }
    if (!known.has(frag) && !known.has(frag.toLowerCase())) findings.push({ at, path: raw, rule: 'anchor' });
  };

  for (const file of files) {
    const isMd = file.endsWith('.md');
    const readsText =
      file !== SELF &&
      !TEST_TREES.some((t) => file.startsWith(t)) &&
      (isMd ? !DATED_TREES.some((t) => file.startsWith(t)) : CODE.test(file));
    if (!isMd && !readsText) continue;
    const lines = readFile(file).split('\n');
    const skip = isMd ? fencedLines(lines) : new Set();
    // An unclosed fence would hide everything below it from both rules — say so instead.
    if (isMd && skip.unclosed !== -1) findings.push({ at: `${file}:${skip.unclosed + 1}`, path: '```', rule: 'fence' });
    lines.forEach((line, i) => {
      if (skip.has(i)) return;
      const at = `${file}:${i + 1}`;
      if (isMd) {
        for (const m of line.matchAll(LINK)) {
          const raw = m[1];
          if (isExternal(raw) || raw.startsWith('<')) continue;
          const fragment = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : '';
          if (raw.startsWith('#')) { checkAnchor(at, raw, file, fragment); continue; }
          const target = raw.split('#')[0].split('?')[0];
          if (!target) continue;
          links += 1;
          let decoded;
          try { decoded = decodeURIComponent(target); } catch { decoded = target; }
          const resolved = decoded.startsWith('/')
            ? decoded.slice(1).replace(/\/$/, '')
            : posix.normalize(posix.join(posix.dirname(file), decoded)).replace(/\/$/, '');
          if (!known.has(resolved) && !dirs.has(resolved)) findings.push({ at, path: raw, rule: 'link' });
          else if (known.has(resolved)) checkAnchor(at, raw, resolved, fragment);
        }
      }
      if (!readsText) return;
      for (const m of line.matchAll(TEXT_PATH)) {
        mentions += 1;
        const path = m[1];
        if (known.has(path)) continue;
        const k = EXEMPTIONS.findIndex((e) => e.file === file && e.path === path);
        if (k !== -1) { exemptionsUsed.add(k); continue; }
        findings.push({ at, path, rule: 'text' });
      }
    });
  }
  return { findings, links, mentions, anchors, exemptionsUsed };
};

const main = () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch (e) {
    console.error(`doc-path-guard: could not read the git index — ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const files = tracked.filter((f) => !f.startsWith('node_modules/') && (f.endsWith('.md') || CODE.test(f)));
  const r = auditPaths(files, (p) => readFileSync(p, 'utf8'), tracked);
  const stale = EXEMPTIONS.filter((_, k) => !r.exemptionsUsed.has(k));
  if (r.findings.length || stale.length) {
    if (r.findings.length) {
      console.error(`doc-path-guard: ${r.findings.length} cited path(s) name no file in the repository:\n`);
      for (const f of r.findings) {
        const why = { link: 'a markdown link a reader cannot follow', anchor: 'a heading anchor no heading in the target produces (RA-2001)', text: 'a path this text cites as real', fence: 'a code fence that never closes, hiding every line below it from this guard' };
        console.error(`  ${f.at}\n    ${f.path} — ${why[f.rule]}`);
      }
      console.error(
        '\nA citation to a file that does not exist makes the reason it gives unauditable (RA-919). Fix the\n' +
          'path, drop the citation, or — if the mention is deliberately illustrative or historical — add\n' +
          'one (file, path) entry with its reason to EXEMPTIONS in scripts/doc-path-guard.mjs.',
      );
    }
    for (const e of stale) {
      console.error(`doc-path-guard: stale exemption — ${e.file} no longer names ${e.path}, or it now exists. Remove the entry.`);
    }
    process.exitCode = 1;
    return;
  }
  // A RUN THAT READ NOTHING IS A BROKEN RUN (RA-945): say how much was read, and refuse zero.
  if (!r.links || !r.mentions || !r.anchors) {
    console.error(`doc-path-guard: read ${r.links} link(s), ${r.anchors} anchor(s) and ${r.mentions} path mention(s) — a zero means the guard is not reading, not that the corpus is clean.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `doc-path-guard: ${r.links} markdown link(s), ${r.anchors} heading anchor(s) and ${r.mentions} path mention(s) resolve; ` +
      `${EXEMPTIONS.length} deliberately illustrative or historical mention(s) exempted by name.`,
  );
};

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
