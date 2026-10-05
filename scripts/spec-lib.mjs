#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-913 — the single definition of "what an L2 invariant is".
//
// Three consumers must agree on this or the whole scheme is decorative: the
// backfiller that allocates IDs, the coverage report that finds un-tested
// invariants, and the CI guard that rejects drift. They share this module rather
// than each carrying a regex, because three regexes that were once the same is how
// RA-917's class of bug happens.
//
// WHAT COUNTS. An invariant DECLARES itself: the line begins with an optional list
// marker and then the promotion tag. A tag appearing anywhere else in a line is
// prose ABOUT tags — the per-file legend ("Promotion tags as in storefront.md:
// `[structural]`, `[confirmed]`, `[seed]`"), a promotion-pass note, or a
// coverage-gap paragraph. Measured 2026-08-24, and stated precisely because an
// earlier version of this comment conflated lines with occurrences: **337 tag
// occurrences** across **278 distinct lines**; of those lines **240 are
// declarations** (222 invariants + 18 legend entries) and **38 are prose**, all 38
// verified by hand. Occurrences exceed lines because some invariants name a second
// tag inside their own text. That split is no longer re-derived by hand: `spec-guard`'s
// rule 7 refuses a line SHAPED like a declaration (`DECL_LIKE`) that `DECL` does not
// read, and a fenced example is not read at all (`fencedLines`) — RA-926.
//
// WHAT DOES NOT COUNT, and the trap it set. Every spec opens with a LEGEND defining
// the three tags — "- `[confirmed]` — a human has confirmed this is intended
// behavior" — which is bulleted and tag-leading and therefore indistinguishable from
// an invariant by shape alone. The first backfill silently numbered all 18 of them,
// making the legend key of storefront.md into STORE-1..3. Caught by reading the diff,
// not by a check: the parser had been validated only for MISSED invariants, never for
// spurious ones.
//
// The rule is POSITIONAL, not punctuational: invariants live in sections, the legend
// lives in the preamble. Verified 2026-08-24 — all 18 legend lines fall before the
// file's first `##` heading, and zero real invariants do, so the two populations are
// cleanly separated. `isLegend` marks them; `parseAll` drops them by default.
//
// Two shapes are both real and both must be matched:
//   - `[confirmed]` **Browsing /classes renders …**        (bulleted; the majority)
//   `[structural]` `kioskLogin.input` validates …          (bare paragraph)
// The bare form carries most of the `[structural]` contracts in corporate.md,
// kiosk.md, instructor.md, student.md and superadmin.md. A bullets-only rule drops
// 38 real invariants, which is why the leading list marker is optional here.

import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { codeTrees, isTestPath, readCodeAreas } from './lib/code-areas.mjs';

export const SPEC_DIR = 'docs/qa/specs';
export const REGISTRY = join(SPEC_DIR, '_id-registry.json');

// THE ONE AUTHORITY for the promotion statuses. `/** @type {const} */` makes the
// element type the literal union rather than `string`, so a JSDoc consumer can say
// `typeof STATUSES[number]` and get the four names — `citation-guard.mjs`'s `Clause`
// typedef does (RA-2138) — without restating them.
export const STATUSES = /** @type {const} */ (['confirmed', 'seed', 'structural', 'retired']);

// An invariant line, with or without its ID. Group 3 is the ID when already
// assigned; group 4 is the promotion status.
//
// DERIVED FROM STATUSES (RA-2122). This was the last literal restatement of the four,
// one line below the list it restated, and the silent half of the class this file's
// header describes: a fifth status added to STATUSES and not here would be an
// invariant that does not exist as far as spec-guard, spec-coverage and the
// backfiller are concerned. The consumers read the groups POSITIONALLY (`m[3]` id,
// `m[4]` status, here and in `spec-ids.mjs`), so the alternation sits INSIDE group 4
// exactly as the literal did, and the group count is unchanged.
export const DECL = new RegExp(
  `^(\\s*)([-*]\\s+)?(?:\`\\[([A-Z]+-\\d+)\\]\`\\s*)?\`\\[(${STATUSES.join('|')})\\]\``,
);

/**
 * A line that is SHAPED like a declaration — the promotion tag (optionally after an id)
 * at the start of the line, after any mix of list markers, ordered-list numbers,
 * blockquote markers and emphasis — whether or not `DECL` reads it (RA-926).
 *
 * `DECL` admits only `-`/`*` bullets and bare paragraphs, so `1. \`[seed]\` …`,
 * `+ \`[seed]\` …` and `> \`[seed]\` …` parsed as NOTHING: no id demanded, no coverage
 * row, `spec-guard` green — the same outcome as the invariant not existing. Widening
 * `DECL` would be the wrong fix (a blockquote is where promotion-pass notes live, and the
 * allocator writes an id at a position it computes from `DECL`'s groups), so the guard
 * instead refuses a line this matches and `DECL` does not, and the author picks one of
 * the two shapes that parse. A tag AFTER other prose on the line is not matched: that is
 * prose about tags (a legend reference, a promotion note), which is the population
 * `spec-lib`'s header counts as non-declarations.
 */
export const DECL_LIKE = new RegExp(
  `^\\s*(?:(?:[-*+]|\\d+[.)])\\s+|>\\s*|\\*\\*|__|\\*|_)*(?:\`\\[[A-Z]+-\\d+\\]\`\\s*)?\`\\[(${STATUSES.join('|')})\\]\``,
);

/**
 * The 0-based indices of every line inside a fenced code block, delimiters included (RA-926).
 *
 * The parser was line-based with no fence awareness, so a DOCUMENTED EXAMPLE of a
 * declaration — the natural thing to write once RA-925 made a declaration's shape a
 * convention — was read as a real invariant: `spec-guard` failed "invariant has no ID",
 * and the remedy it printed (`spec-ids.mjs --apply`) would have burnt a permanent id into
 * a code sample. CommonMark's rule, closely enough: a fence opens on 3+ backticks or
 * tildes (a backtick fence's info string may not itself contain a backtick, so
 * `` ```x``` `` inline is NOT a fence) and closes on a run of the SAME character at least
 * as long.
 *
 * AN UNCLOSED FENCE IS A FINDING, NOT A QUIET EOF. CommonMark runs it to the end of the
 * file, and so does this — which silently hides every declaration below it from the
 * parser and from rule 7 alike. So `.unclosed` carries the opener's index (or -1), and
 * `spec-guard` refuses a spec that has one rather than trusting a skip it cannot see.
 *
 * @param {string[]} lines
 * @returns {Set<number> & {unclosed: number}}
 */
export function fencedLines(lines) {
  const out = new Set();
  let open = null;
  let openedAt = -1;
  lines.forEach((l, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    const isFence = m && !(m[1][0] === '`' && m[2].includes('`'));
    if (open) {
      out.add(i);
      if (isFence && m[1][0] === open[0] && m[1].length >= open.length && m[2].trim() === '') open = null;
      return;
    }
    if (isFence) { open = m[1]; openedAt = i; out.add(i); }
  });
  return Object.assign(out, { unclosed: open ? openedAt : -1 });
}

// ── AREA PREFIXES (RA-2701, Kanon `K-LAYOUT-2`) ─────────────────────────────────
//
// Each spec file DECLARES its own area prefix, in its preamble, on a line of its own:
//
//     **Id prefix:** `KIOSK`
//
// Until RA-2701 the prefixes were a 16-entry map in this file, which made the library
// carry one project's areas — the thing that kept it from moving to Kanon whole. The
// map was deliberately explicit rather than derived from the filename, and that reason
// still holds: a file rename must not silently renumber every invariant it contains,
// because an id is a permanent citation. A declaration in the file keeps that property
// (the prefix travels with the file, not with its name) and drops the second home.
//
// FAIL LOUDLY. A file with no declaration, two declarations, a declaration outside the
// preamble or a malformed one (a lowercase prefix, no backticks, a trailing word) is
// refused rather than skipped, and so is one prefix declared by two files. Each of those
// would otherwise make a file's invariants invisible, or make one id answer to two
// areas, with nothing failing. `prefixProblems` collects them without throwing, so a
// guard can report every one; `loadPrefixes` and `parseSpec` throw on them.

/** The one accepted shape: the bold label, one space or more, the prefix in backticks,
 *  nothing after. A prefix is uppercase ASCII letters only (`K-LAYOUT-2`). */
export const ID_PREFIX_LINE = /^\*\*Id prefix:\*\*[ \t]+`([A-Z]+)`[ \t]*$/;

/** A line that is TRYING to declare a prefix — any case, any list or quote marker, any
 *  emphasis — whether or not `ID_PREFIX_LINE` reads it. The gap between the two is
 *  what makes a typo a finding instead of a missing declaration. */
export const ID_PREFIX_LIKE = /^\s*(?:[-*+>]\s*|\d+[.)]\s*)*(?:\*\*|__|\*|_)?\s*id[- ]prefix\b/i;

/**
 * The prefix one spec file declares, or the problems that stop it having one.
 *
 * @param {string[]} lines the whole file
 * @param {string} file its name, for messages
 * @returns {{prefix: string|null, problems: string[]}}
 */
export function declaredPrefix(lines, file) {
  const firstSection = lines.findIndex((l) => /^## /.test(l));
  const preambleEnds = firstSection < 0 ? Infinity : firstSection;
  const fenced = fencedLines(lines);
  const problems = [];
  const found = [];
  lines.forEach((l, i) => {
    if (fenced.has(i) || !ID_PREFIX_LIKE.test(l)) return;
    const m = ID_PREFIX_LINE.exec(l);
    if (!m) {
      problems.push(`${file}:${i + 1} — malformed area-prefix declaration. Write it exactly as **Id prefix:** \`AREA\` — the label in bold, the prefix in backticks, uppercase letters only — on a line of its own.\n    ${l.trim().slice(0, 90)}`);
    } else if (i >= preambleEnds) {
      problems.push(`${file}:${i + 1} — the area-prefix declaration sits below the first \`##\` heading. It belongs in the preamble.`);
    } else {
      found.push({ prefix: m[1], line: i + 1 });
    }
  });
  if (found.length > 1) {
    problems.push(`${file} — declares its area prefix ${found.length} times (lines ${found.map((f) => f.line).join(', ')}). Keep exactly one.`);
  }
  if (!found.length && !problems.length && fenced.unclosed !== -1 && fenced.unclosed < preambleEnds) {
    // An unclosed fence runs to the end of the file, so it hides any declaration below
    // it — and the guard's own "fence never closes" rule waits on this one. Say so here,
    // or the author adds a second declaration instead of closing the fence.
    problems.push(`${file}:${fenced.unclosed + 1} — declares no area prefix that can be read: a code fence opens here and never closes, so every line below it is an example. Close the fence.`);
  } else if (!found.length && !problems.length) {
    problems.push(`${file} — declares no area prefix. Add the line **Id prefix:** \`AREA\` (the prefix in backticks) above the first \`##\` heading.`);
  }
  return { prefix: problems.length ? null : found[0].prefix, problems };
}

function readLines(file, dir) {
  return readFileSync(join(dir, file), 'utf8').split('\n');
}

/**
 * Every declaration problem in the corpus, including one prefix declared by two files.
 * Never throws on a declaration — the guard reports these as findings.
 *
 * @returns {{prefixes: Record<string, string>, problems: string[]}}
 */
export function prefixProblems(dir = SPEC_DIR) {
  const prefixes = {};
  const problems = [];
  const owner = new Map();
  for (const file of specFiles(dir)) {
    const d = declaredPrefix(readLines(file, dir), file);
    problems.push(...d.problems);
    if (!d.prefix) continue;
    if (owner.has(d.prefix)) {
      problems.push(`${file} — declares area prefix \`${d.prefix}\`, which ${owner.get(d.prefix)} already declares. A prefix names one area; pick another for one of them.`);
      continue;
    }
    owner.set(d.prefix, file);
    prefixes[file] = d.prefix;
  }
  return { prefixes, problems };
}

/**
 * Area prefix per spec file, as the files declare them: `{ 'kiosk.md': 'KIOSK', … }`.
 * Throws, naming every problem, if any file's declaration is missing, repeated,
 * misplaced or malformed, or if two files declare one prefix.
 *
 * @returns {Readonly<Record<string, string>>}
 */
export function loadPrefixes(dir = SPEC_DIR) {
  const { prefixes, problems } = prefixProblems(dir);
  if (problems.length) throw new Error(`spec area prefixes:\n  • ${problems.join('\n  • ')}`);
  return Object.freeze(prefixes);
}

const patternSource = new Map();

/** What `idPattern`'s cache is keyed on: the directory AND each spec's size and mtime, so
 *  a declaration edited mid-process is seen by `idPattern` exactly as by `loadPrefixes`. */
function corpusKey(dir) {
  return [resolve(dir), ...specFiles(dir).map((f) => {
    const s = statSync(join(dir, f));
    return `${f}:${s.size}:${s.mtimeMs}`;
  })].join('|');
}

/** Matches ONLY the real area prefixes the specs declare — it is derived from them, so
 *  adding an area needs no edit here. A loose `[A-Z]+-\d+` also matches
 *  unrelated repo notation — `[F-1]` in instructor.md is a feature-flag citation
 *  that predates this scheme — so anything scanning free text (the coverage report
 *  scanning tests, the guard scanning docs) must use this, not the loose form.
 *
 *  The alternation is cached per directory, keyed on every spec's size and mtime: this
 *  is called in loops over hundreds of files, and a stat is far cheaper than a re-read. */
export function idPattern(flags = 'g', dir = SPEC_DIR) {
  const key = corpusKey(dir);
  if (!patternSource.has(key)) patternSource.set(key, Object.values(loadPrefixes(dir)).join('|'));
  return new RegExp(`\\[(${patternSource.get(key)})-(\\d+)\\]`, flags);
}

export function specFiles(dir = SPEC_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

/** Every invariant declaration in one file, in document order. */
export function parseSpec(file, dir = SPEC_DIR) {
  const lines = readLines(file, dir);
  const { prefix, problems } = declaredPrefix(lines, file);
  if (!prefix) throw new Error(problems.join('\n'));
  const firstSection = lines.findIndex((l) => /^## /.test(l));
  const preambleEnds = firstSection < 0 ? Infinity : firstSection;
  const fenced = fencedLines(lines);
  const out = [];
  lines.forEach((text, i) => {
    // An example in a code fence is not a declaration (RA-926) — see `fencedLines`.
    if (fenced.has(i)) return;
    const m = DECL.exec(text);
    if (!m) return;
    out.push({
      legend: i < preambleEnds,
      file,
      prefix,
      line: i + 1,
      id: m[3] ?? null,
      status: m[4],
      // The invariant's own words, minus the markers — enough to identify it in a
      // report without reproducing the whole paragraph.
      text: text.slice(m[0].length).replace(/\s+/g, ' ').trim(),
      raw: text,
    });
  });
  return out;
}

/** Real invariants only. Pass `{ legend: true }` to include the preamble key — the
 *  guard needs it to flag a declaration parked in the preamble by mistake. */
export function parseAll(dir = SPEC_DIR, { legend = false } = {}) {
  // Validates the whole corpus's declarations first — including one prefix declared by
  // two files, which no single `parseSpec` can see.
  loadPrefixes(dir);
  const all = specFiles(dir).flatMap((f) => parseSpec(f, dir));
  return legend ? all : all.filter((i) => !i.legend);
}

/** The registry key that holds the renumber trail (RA-2004) rather than a high-water mark. */
export const RENUMBERED = 'renumbered';

function readRegistryFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** Highest-ever-allocated number per prefix. IDs are never reused, so this is the
 *  high-water mark and NOT `max(current IDs)` — deleting the last invariant in a
 *  file must not free its number for the next one.
 *
 *  MARKS ONLY. The file also carries the `renumbered` map (see `loadRenumbered`), and
 *  every caller of this reads `registry[prefix]` as a number or spreads the object
 *  into the marks it writes back — so the map is kept out of it here, once, rather
 *  than being skipped by each caller. */
export function loadRegistry(path = REGISTRY) {
  const marks = readRegistryFile(path);
  delete marks[RENUMBERED];
  return marks;
}

/**
 * The RENUMBER TRAIL (RA-2004): `{"STORE-102": {"to": "STORE-103", "by": 2003}}` — every
 * id that has been on `main` naming one clause and was then moved to another number,
 * with the PR that moved it.
 *
 * WHY IT EXISTS. A renumbered id still resolves — `[STORE-102]` is RA-1854's reminder
 * clause since RA-2003 moved RA-1891's send-refusal clause off it — so a reference written
 * against the old numbering points at a real, wrong invariant, and no existence check
 * can see that. Detecting it after the fact was measured and rejected (anchoring a
 * reference to its clause by shared issue number was wrong on 51 of 177). So the
 * renumber leaves a trail instead, and `spec-id-renumbered.mjs` makes every reference
 * to a moved-off id be looked at once.
 *
 * WHO WRITES IT: whoever resolves the collision, in the same change as the renumber.
 * `spec-guard`'s duplicate-id message, `spec-ids.mjs` and `spec-id-claims.mjs` say so.
 * Entries are permanent, like the ids themselves.
 *
 * @returns {Record<string, {to: string, by: number}>}
 */
export function loadRenumbered(path = REGISTRY) {
  return readRegistryFile(path)[RENUMBERED] ?? {};
}

/** A test of the id TOOLING — it imports the adopter's own pipeline code (the directories it
 *  declares under `## Pipeline code` in `docs/qa/escalation-paths.md`, `K-LAYOUT-8`), or the
 *  library from an adopter's `.kanon/scripts/` checkout of Kanon, statically or through an
 *  `import…(` helper — whose ids are deliberate fixtures (`[STORE-500]` exists to prove the
 *  high-water rule rejects it). Keyed on the import, not on a list of names, so the next
 *  tooling test qualifies the day it is written (RA-1214). `spec-coverage.mjs`'s
 *  mentioned-not-cited section, `citation-shift` and the reference corpus below share this one
 *  definition.
 *
 *  THE DIRECTORIES ARE THE ADOPTER'S (kanon#54). This was a constant naming the reference
 *  adopter's `scripts/qa/`, so on any other repository a test of its own pipeline code counted
 *  its fixture ids as coverage and as references. A directory is matched as a whole path
 *  segment, after any relative prefix (`../../scripts/pipeline/x.mjs`).
 *
 *  @param {string[]} pipelineDirs the declared pipeline-code directories, each ending in `/`
 *  @returns {RegExp} */
export function qaToolingImport(pipelineDirs) {
  if (!Array.isArray(pipelineDirs)) throw new TypeError('qaToolingImport needs the declared pipeline-code directories (K-LAYOUT-8)');
  const escape = (d) => d.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const dirs = ['.kanon/scripts/', ...pipelineDirs].map(escape).join('|');
  return new RegExp(`(?:from\\s+|import\\w*\\s*\\(\\s*)['"](?:[^'"]*/)?(?:${dirs})[^'"]*['"]`);
}

/** The tree an `[AREA-N]` reference outside the specs can live in beside the code areas: the
 *  project's documents, at Kanon's fixed path. */
export const REFERENCE_DOCS = 'docs';

/**
 * Every file that may cite a spec id WITHOUT being a spec: the code and test trees the stack
 * document declares under `## Code areas` (`K-LAYOUT-17`, `scripts/lib/code-areas.mjs`), and
 * `docs/`, minus `docs/qa/specs/**`, and minus the id tooling's own tests (above). One
 * definition for the two consumers that must agree on it — the existence sweep in
 * `tests/library/spec-ids.test.ts` and the renumber check (RA-2004) — so widening one
 * cannot leave the other behind.
 *
 * THE TREES ARE THE PROJECT'S (kanon#54). They were a constant, `src/`, `e2e/`, `tests/` and
 * `docs/`, the reference adopter's. A project that declares no code tree has the whole
 * repository read: a reference left unread is the silent failure, and an extra one read is not.
 *
 * THE WHOLE REPOSITORY IS WHAT GIT TRACKS (kanon#266), the same read the two other guards that
 * share this fallback make — `citation-shift` (`git grep`) and `doc-path-guard` (`git ls-files`).
 * Walking the working tree instead made the three disagree, and read whatever the project-setup
 * hook had installed into the checkout: an untracked `vendor/`, `venv/`, `target/` or `dist/`
 * was walked for `[AREA-N]` references, and third-party text could raise a renumber finding.
 * Only `node_modules/` was special-cased, which is a Node opinion; git's ignore list is every
 * stack's. Outside a git repository (a fixture tree, an exported archive) the walk stands in,
 * as it does in `spec-coverage.mjs`.
 *
 * AND NEVER CRASHES ON A FILE IT CANNOT READ. A dangling symlink anywhere in the tree used to
 * throw `ENOENT` out of `statSync`, which `spec-id-renumbered` reports as a stack trace rather
 * than as a finding. A file the corpus cannot read is a file no consumer can read either — they
 * all `readFileSync` what this returns — so it is left out, never thrown on.
 *
 * MINUS THE PROJECT'S OWN PIPELINE CODE, the directories it declares under `## Pipeline code`
 * (`K-LAYOUT-8`). A `code` tree such as `scripts/` can hold the pipeline, whose ids are
 * fixtures as its tests' are; `citation-shift` skips the same directories for the same reason.
 * The trees this replaced never reached `scripts/`.
 *
 * @param {string} [root]
 * @param {string[]} pipelineDirs the declared pipeline-code directories (`qaToolingImport`)
 * @returns {string[]} repo-relative paths
 */
export function referenceCorpus(root = process.cwd(), pipelineDirs) {
  const tooling = qaToolingImport(pipelineDirs);
  const areas = readCodeAreas(root);
  const trees = codeTrees(areas);
  const scope = trees === null ? null : [...new Set([...trees, `${REFERENCE_DOCS}/`])];
  const files = trackedFiles(root) ?? walkTree(root, scope);
  return [...new Set(files.map((f) => f.split('\\').join('/')))]
    .filter((f) => /\.(ts|tsx|mjs|md)$/.test(f))
    .filter((f) => scope === null || scope.some((d) => f.startsWith(d)))
    .filter((f) => !f.startsWith(`${SPEC_DIR}/`))
    .filter((f) => !pipelineDirs.some((d) => f.startsWith(d)))
    .filter((f) => isReadableFile(join(root, f)))
    .filter((f) => !(isTestPath(f, areas) && tooling.test(readText(join(root, f)))))
    .sort();
}

/** Every file git tracks in the repository `root` IS, repository-relative, or null when `root`
 *  is not a repository's root — a fixture tree, an archive, or a directory inside a repository,
 *  where `git ls-files` would answer about a tree other than the one asked about. */
function trackedFiles(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e9 });
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  try {
    const top = real(git('rev-parse', '--show-toplevel').trim());
    if (top === null || top !== real(root)) return null;
    return git('ls-files', '-z').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** The walk that stands in outside a git repository: `scope`'s trees, or the whole tree.
 *  @param {string} root
 *  @param {string[] | null} scope the trees to read, or null for the whole tree */
function walkTree(root, scope) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // There is no ignore list here, so the walk makes the two skips git would have made.
      if (scope === null && (e.name.startsWith('.') || e.name === 'node_modules')) continue;
      // A directory by the entry's OWN type: a symlink is never followed and never stat'd, so a
      // dangling one is a file this leaves to `isReadableFile`, not a crash (kanon#266).
      if (e.isDirectory()) walk(join(dir, e.name));
      else out.push(relative(root, join(dir, e.name)));
    }
  };
  if (scope === null) walk(root);
  else for (const d of scope) walk(join(root, d));
  return out;
}

/** Whether a path is a file whose contents a consumer of the corpus can actually read. */
function isReadableFile(path) {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A file's text, or '' when it can't be read — the corpus never throws on a file (kanon#266). */
function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
