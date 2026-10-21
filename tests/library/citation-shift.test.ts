import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentCoordinates, committedCoordinates, committedLines, lineMapper, parseDiff, readsCodeComments as readsWith, rebasedCoordinates, rebasedLines, retarget, rewrittenLines, shiftedCoordinates } from '../../scripts/citation-shift.mjs';
import { UNDECLARED, parseCodeAreas } from '../../scripts/lib/code-areas.mjs';
import { ROOT } from './helpers/adopter.js';
import { SPAWNS } from '../unit/helpers/spawns.js';

/**
 * RA-1384 — the coordinates a diff moved, derived from the diff.
 *
 * KANON'S HALF (plan 0001, step 3). The reference adopter keeps the halves that read its own tree and its CI wiring.
 *
 *
 * `citation-guard` judges a coordinate against one tree, so the range-checked-only
 * majority drifted silently (until kanon#387, which fails a coordinate that names no
 * identifier): RA-811's three `course-wizard.tsx` coordinates pointed at a
 * Back button on its head with every gate green, and RA-873's merge commit carried 50
 * coordinates it had moved and left. This check builds the old->new line map from the
 * hunks and pushes each coordinate the diff LEFT AS IT WAS through it.
 *
 * Fixtures, not history: the unit tier runs at checkout depth 1 and reads no commits.
 * The replay against RA-873's real merge is recorded in the script's header.
 */

/** A source file of 20 lines with 3 lines inserted after line 5 — everything from 6 moves +3. */
const INSERT_3_AFTER_5 = `diff --git a/src/wizard.tsx b/src/wizard.tsx
--- a/src/wizard.tsx
+++ b/src/wizard.tsx
@@ -5,0 +6,3 @@ ctx
+a
+b
+c
`;

const run = (docs: Record<string, string>, diffText: string, tracked = ['src/wizard.tsx', 'src/other.ts']) =>
  shiftedCoordinates({
    docs: Object.keys(docs),
    readHead: (p: string) => docs[p],
    trackedHead: [...tracked, ...Object.keys(docs)],
    trackedBase: [...tracked, ...Object.keys(docs)],
    diff: parseDiff(diffText),
  });

describe('the line map', () => {
  it('shifts lines below an insertion and leaves lines above it', () => {
    const map = lineMapper(parseDiff(INSERT_3_AFTER_5).get('src/wizard.tsx'));
    expect(map(5)).toBe(5);
    expect(map(6)).toBe(9);
    expect(map(20)).toBe(23);
  });

  it('reports a rewritten or deleted line as null, and shifts past a deletion', () => {
    const d = parseDiff(`+++ b/f.ts
@@ -10,4 +10,1 @@
-x
-y
-z
-w
+q
`);
    const map = lineMapper(d.get('f.ts'));
    expect(map(9)).toBe(9);
    expect([10, 11, 12, 13].map(map)).toEqual([null, null, null, null]);
    expect(map(14)).toBe(11);
  });

  it('rewrites the numbers of every coordinate form, and nothing else', () => {
    expect(retarget('`course-wizard.tsx:797-800`', 756, 759)).toBe('`course-wizard.tsx:756-759`');
    expect(retarget('`:297`', 256, 256)).toBe('`:256`');
    expect(retarget('`tenancy.ts` L179-214', 187, 222)).toBe('`tenancy.ts` L187-222');
  });
});

describe('what it flags', () => {
  it('a coordinate on an UNTOUCHED doc line below the move — the RA-811 shape', () => {
    const r = run({ 'docs/a.md': 'The badge (`wizard.tsx:12`).' }, INSERT_3_AFTER_5);
    expect(r.moved).toHaveLength(1);
    expect(r.moved[0]).toMatchObject({ at: 'docs/a.md:1', citation: '`wizard.tsx:12`', replacement: '`wizard.tsx:15`' });
  });

  it('a coordinate carried unchanged through a doc line the diff DID edit — the RA-873 shape', () => {
    // The fix commit re-pointed one coordinate on the line and left its neighbour.
    const docDiff = `+++ b/docs/a.md
@@ -1,1 +1,1 @@
-Loads (\`wizard.tsx:10\`) then saves (\`:12\`).
+Loads (\`wizard.tsx:13\`) then saves (\`:12\`).
`;
    const r = run({ 'docs/a.md': 'Loads (`wizard.tsx:13`) then saves (`:12`).' }, INSERT_3_AFTER_5 + docDiff);
    expect(r.moved.map((m: { citation: string; replacement: string }) => [m.citation, m.replacement])).toEqual([['`:12`', '`:15`']]);
  });

  it('the L-form, which citation-guard now reads too (RA-2224)', () => {
    const r = run({ 'docs/a.md': 'See `src/wizard.tsx` L6-8.' }, INSERT_3_AFTER_5);
    expect(r.moved[0].replacement).toBe('`src/wizard.tsx` L9-11');
  });

  it('a coordinate whose cited lines were EDITED is advisory, not fatal', () => {
    const d = `+++ b/src/wizard.tsx
@@ -12,1 +12,1 @@
-old
+new
`;
    const r = run({ 'docs/a.md': 'The guard (`wizard.tsx:12`).' }, d);
    expect(r.moved).toEqual([]);
    expect(r.edited).toHaveLength(1);
  });
});

describe('what it deliberately leaves alone', () => {
  it('a coordinate above the move', () => {
    expect(run({ 'docs/a.md': 'Top (`wizard.tsx:4`).' }, INSERT_3_AFTER_5).moved).toEqual([]);
  });

  it('a coordinate the diff re-pointed', () => {
    const docDiff = `+++ b/docs/a.md
@@ -1,1 +1,1 @@
-The badge (\`wizard.tsx:12\`).
+The badge (\`wizard.tsx:15\`).
`;
    const r = run({ 'docs/a.md': 'The badge (`wizard.tsx:15`).' }, INSERT_3_AFTER_5 + docDiff);
    expect(r.moved).toEqual([]);
    expect(r.pointing).toBe(1);
  });

  it('a coordinate re-pointed ONTO a number another edited line moved away from — paired line by line', () => {
    // Two table rows, both re-pointed: row 1 `:9` -> `:12`, row 2 `:12` -> `:15`. Pooled
    // over the hunk, row 1's new `:12` matched row 2's REMOVED `:12` and read as carried
    // through unchanged, so a correct coordinate was flagged stale.
    const docDiff = `+++ b/docs/a.md
@@ -1,2 +1,2 @@
-| a | \`wizard.tsx:9\` |
-| b | \`wizard.tsx:12\` |
+| a | \`wizard.tsx:12\` |
+| b | \`wizard.tsx:15\` |
`;
    const r = run({ 'docs/a.md': '| a | `wizard.tsx:12` |\n| b | `wizard.tsx:15` |' }, INSERT_3_AFTER_5 + docDiff);
    expect(r.moved).toEqual([]);
  });

  it('a coordinate the diff WROTE — it was written against the new tree', () => {
    const docDiff = `+++ b/docs/a.md
@@ -1,0 +2,1 @@
+New claim (\`wizard.tsx:12\`).
`;
    const r = run({ 'docs/a.md': 'Old line.\nNew claim (`wizard.tsx:12`).' }, INSERT_3_AFTER_5 + docDiff);
    expect(r.moved).toEqual([]);
  });

  it('a full citation naming line 0 — a typo citation-guard reports, never "moved" (RA-1221)', () => {
    // `--fix` would otherwise rewrite `:0-8` to `:0-11`: one typo for another.
    const r = run({ 'docs/a.md': 'Typo (`wizard.tsx:0-8`) and a real one (`wizard.tsx:12`).' }, INSERT_3_AFTER_5);
    expect(r.moved, 'only the real coordinate moved').toHaveLength(1);
    expect(JSON.stringify(r.moved)).not.toMatch(/:0-/);
  });

  it('a coordinate into a file the diff did not change', () => {
    expect(run({ 'docs/a.md': 'Elsewhere (`other.ts:12`).' }, INSERT_3_AFTER_5).moved).toEqual([]);
  });

  it('a coordinate into an untracked dependency, which citation-guard counts as external (#108)', () => {
    const d = INSERT_3_AFTER_5.replaceAll('src/wizard.tsx', '.venv/lib/site-packages/x/wizard.py');
    expect(run({ 'docs/a.md': 'Dep (`.venv/lib/site-packages/x/wizard.py:12`).' }, d, []).moved).toEqual([]);
  });

  it('a tracked file under a dependency-looking folder is the repository\'s own, and shifts (#108)', () => {
    const d = INSERT_3_AFTER_5.replaceAll('src/wizard.tsx', 'node_modules/x/wizard.mjs');
    expect(run({ 'docs/a.md': 'Dep (`node_modules/x/wizard.mjs:12`).' }, d, ['node_modules/x/wizard.mjs']).moved).toHaveLength(1);
  });

  it('a coordinate into a MOVED file — no line map exists, so it is skipped and counted, never flagged (RA-2294 review)', () => {
    // `--no-renames` shows `git mv foo/a.ts bar/a.ts` as a delete plus a whole-file add,
    // whose hunk would map every line n to n+N and `--fix` would write past EOF.
    const moveDiff = `+++ /dev/null
@@ -1,40 +0,0 @@
-x
+++ b/bar/a.ts
@@ -0,0 +1,40 @@
+x
`;
    const r = shiftedCoordinates({
      docs: ['docs/x.md'],
      readHead: () => 'Untouched (`a.ts:10`).',
      trackedHead: ['bar/a.ts', 'docs/x.md'],
      trackedBase: ['foo/a.ts', 'docs/x.md'],
      diff: parseDiff(moveDiff),
    });
    expect(r.moved).toEqual([]);
    expect(r.edited).toEqual([]);
    expect(r.unmapped).toBe(1);
  });

  it('counts, rather than guesses at, a basename that matches several files', () => {
    const r = run({ 'docs/a.md': 'Ambiguous (`wizard.tsx:12`).' }, INSERT_3_AFTER_5, ['src/wizard.tsx', 'app/wizard.tsx']);
    expect(r.moved).toEqual([]);
    expect(r.ambiguous).toBe(1);
  });
});

describe('code comments are read too (RA-2293)', () => {
  const runCode = (files: Record<string, string>, diffText: string) =>
    shiftedCoordinates({
      docs: [],
      code: Object.keys(files),
      readHead: (p: string) => files[p],
      trackedHead: ['src/wizard.tsx', 'src/other.ts', ...Object.keys(files)],
      trackedBase: ['src/wizard.tsx', 'src/other.ts', ...Object.keys(files)],
      diff: parseDiff(diffText),
    });

  it("flags RA-1384's own example shape — a docblock coordinate the diff moved — and says it is code", () => {
    const r = runCode({ 'e2e/helpers.ts': '/**\n * state and bails at `wizard.tsx:12`) — the wizard stays\n */' }, INSERT_3_AFTER_5);
    expect(r.moved.map((m) => [m.at, m.replacement, m.kind])).toEqual([['e2e/helpers.ts:2', 'wizard.tsx:15', 'code']]);
    expect(r.pointingCode).toBe(1);
  });

  it('reads the un-backticked form and a trailing `//` comment', () => {
    const r = runCode({ 'src/a.ts': 'const x = 1; // checkout (wizard.tsx:9, #253)\n' }, INSERT_3_AFTER_5);
    expect(r.moved.map((m) => [m.citation, m.replacement])).toEqual([['wizard.tsx:9', 'wizard.tsx:12']]);
  });

  it('never reads code or a string literal — a fixture is not a claim', () => {
    const r = runCode({ 'tests/a.test.ts': "expect(out).toContain('src/wizard.tsx:9');\nconst p = 'wizard.tsx:12';" }, INSERT_3_AFTER_5);
    expect(r.moved).toEqual([]);
    expect(r.pointing).toBe(0);
  });

  it('commentCoordinates keeps offsets into the RAW line, so --fix splices the right span', () => {
    const line = 'foo(); // see wizard.tsx:9-10 and `other.ts:3`';
    const cs = commentCoordinates(line);
    expect(cs.map((c: { i: number; text: string }) => line.slice(c.i, c.i + c.text.length))).toEqual(['wizard.tsx:9-10', 'other.ts:3']);
    // …and does not start a match inside a longer token.
    expect(commentCoordinates('// https://host.example/x.tsx:80')).toHaveLength(1);
    expect(commentCoordinates('// @scope/pkg.ts:3')).toEqual([]);
  });

  // The adopter's declared pipeline code (`## Pipeline code` in docs/qa/escalation-paths.md, kanon#54).
  const PIPELINE = ['scripts/qa/'];
  // The reference adopter's code areas, as its stack document declares them (`## Code areas`,
  // K-LAYOUT-17): the trees this guard read before they were declared.
  const AREAS = parseCodeAreas([
    '## Code areas', '- `src/` — code: the application', '- `scripts/` — code: scripts',
    '- `.github/scripts/` — code: workflow helpers', '- `tests/` — tests: unit', '- `e2e/` — tests: browser',
  ].join('\n'));
  const readsCodeComments = (path: string, text: string, dirs?: string[], areas = AREAS) => readsWith(path, text, dirs, areas);

  it("excludes the QA tooling's own source and tests by what they ARE, not by name (RA-1384 criterion 3)", () => {
    expect(readsCodeComments('src/server/services/payments.ts', '', PIPELINE)).toBe(true);
    expect(readsCodeComments('e2e/helpers.ts', '', PIPELINE)).toBe(true);
    expect(readsCodeComments('scripts/seed.ts', '', PIPELINE)).toBe(true);
    expect(readsCodeComments('scripts/qa/citation-guard.mjs', '', PIPELINE)).toBe(false);
    expect(readsCodeComments('tests/unit/any.test.ts', "import { x } from '../../scripts/qa/citation-guard.mjs';", PIPELINE)).toBe(false);
    // An adopter imports the library from its checkout of Kanon after the move (plan 0001 §3).
    expect(readsCodeComments('tests/unit/any.test.ts', "const m = await importKanon('../../.kanon/scripts/citation-guard.mjs');", PIPELINE)).toBe(false);
    expect(readsCodeComments('tests/unit/any.test.ts', "import { x } from '@/lib/x';", PIPELINE)).toBe(true);
    expect(readsCodeComments('docs/a.md', '', PIPELINE)).toBe(false);
    expect(readsCodeComments('drizzle/0001.sql', '', PIPELINE)).toBe(false);
  });

  it("excludes exactly the adopter's declared pipeline code, which is the adopter's to name (kanon#54)", () => {
    expect(readsCodeComments('scripts/qa/citation-guard.mjs', '', [])).toBe(true);
    expect(readsCodeComments('scripts/qa/citation-guard.mjs', '', ['scripts/pipeline/'])).toBe(true);
    expect(readsCodeComments('scripts/pipeline/triage.py', '', ['scripts/pipeline/'])).toBe(false);
    expect(() => readsCodeComments('scripts/seed.ts', '')).toThrow(/pipeline-code directories/);
  });

  it('reads workflow helper scripts under `.github/scripts/`, unless declared pipeline code (kanon#180)', () => {
    expect(readsCodeComments('.github/scripts/weekly-digest.mjs', '', PIPELINE)).toBe(true);
    expect(readsCodeComments('.github/scripts/lib/milestones.mjs', '', PIPELINE)).toBe(true);
    expect(readsCodeComments('.github/scripts/weekly-digest.mjs', '', ['.github/scripts/'])).toBe(false);
    // Only the scripts tree: a workflow file is YAML, not a code comment this reads.
    expect(readsCodeComments('.github/workflows/ci.yml', '', PIPELINE)).toBe(false);
  });

  it('reads the declared code areas, and the whole repository when none is declared (kanon#54)', () => {
    const custom = parseCodeAreas('## Code areas\n- `lib/` — code: the package\n- `spec/` — tests: the suite\n');
    expect(readsCodeComments('lib/orders.ts', '', [], custom)).toBe(true);
    expect(readsCodeComments('src/orders.ts', '', [], custom)).toBe(false);
    // A test that imports the pipeline is a tooling test in a declared test tree; one that doesn't is read.
    expect(readsCodeComments('spec/x.test.ts', "import { x } from '../scripts/qa/a.mjs';", PIPELINE, custom)).toBe(false);
    expect(readsCodeComments('spec/x.test.ts', "import { x } from '../lib/x';", PIPELINE, custom)).toBe(true);
    // Undeclared: every code file, and a test is what its language calls one.
    expect(readsCodeComments('lib/orders.ts', '', [], UNDECLARED)).toBe(true);
    expect(readsCodeComments('anywhere/deep/x.py', '', [], UNDECLARED)).toBe(true);
    expect(readsCodeComments('tests/x.test.ts', "import { x } from '../scripts/qa/a.mjs';", PIPELINE, UNDECLARED)).toBe(false);
    expect(readsCodeComments('docs/a.md', '', [], UNDECLARED)).toBe(false);
    expect(() => readsWith('src/a.ts', '', [])).toThrow(/declared code areas/);
  });

  it('reads Python and Go source by their own comment syntax (kanon#20)', () => {
    expect(readsCodeComments('src/orders/core.py', '', [])).toBe(true);
    expect(readsCodeComments('tests/test_core.py', '', [])).toBe(true);
    expect(readsCodeComments('src/orders/core.go', '', [])).toBe(true);
    // A `#` comment, whole-line or trailing, and a coordinate into any language a doc can cite.
    expect(commentCoordinates('# the entry point is src/orders/core.py:4-6', 'hash').map((c: { text: string }) => c.text)).toEqual(['src/orders/core.py:4-6']);
    expect(commentCoordinates('x = 1  # see core.go:12', 'hash').map((c: { text: string }) => c.text)).toEqual(['core.go:12']);
    // Code and strings are not comments: a dict lookup, and a Python line with no `#`.
    expect(commentCoordinates('path = "core.py:4"', 'hash')).toEqual([]);
    // `//` is not a Python comment, and `#` is not a JavaScript one.
    expect(commentCoordinates('x // core.py:4', 'hash')).toEqual([]);
    expect(commentCoordinates('# core.py:4')).toEqual([]);
    // Go uses the JavaScript syntax.
    expect(commentCoordinates('\tplace() // see core.go:12').map((c: { text: string }) => c.text)).toEqual(['core.go:12']);
  });
});

// Its cases run the CLI in `node`, with `git`, so the block takes the spawn budget (#436).
describe('the CLI reads code comments end to end (RA-2293)', SPAWNS, () => {
  it('fails on a `.github/scripts/` comment coordinate the working tree moved, and --fix re-points it (kanon#180)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cshift-gh-'));
    const sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    sh('init', '-q');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    w('.github/workflows/review.yml', Array.from({ length: 20 }, (_, i) => `# line${i + 1}`).join('\n') + '\n');
    w('.github/scripts/review-helper.mjs', '// the gate step lives at review.yml:12\nexport const x = 1;\n');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    sh('add', '.');
    sh('commit', '-qm', 'base');
    w('.github/workflows/review.yml', ['# line1', '# new-a', '# new-b', ...Array.from({ length: 19 }, (_, i) => `# line${i + 2}`)].join('\n') + '\n');
    const cli = join(ROOT, 'scripts/citation-shift.mjs');
    const r = spawnSync(process.execPath, [cli, '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('.github/scripts/review-helper.mjs:1  review.yml:12  ->  review.yml:14');
    const f = spawnSync(process.execPath, [cli, '--base', 'HEAD', '--fix'], { cwd: dir, encoding: 'utf8' });
    expect(f.status).toBe(0);
    expect(readFileSync(join(dir, '.github/scripts/review-helper.mjs'), 'utf8')).toContain('lives at review.yml:14');
  });

  it('fails on a comment coordinate the working tree moved, and --fix re-points it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cshift-'));
    const sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    sh('init', '-q');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    w('src/wizard.tsx', Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    w('e2e/helpers.ts', '/**\n * bails at `wizard.tsx:12`\n */\nexport const x = 1;\n');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    sh('add', '.');
    sh('commit', '-qm', 'base');
    w('src/wizard.tsx', ['line1', 'line2', 'new-a', 'new-b', ...Array.from({ length: 18 }, (_, i) => `line${i + 3}`)].join('\n') + '\n');
    const cli = join(ROOT, 'scripts/citation-shift.mjs');
    const r = spawnSync(process.execPath, [cli, '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('e2e/helpers.ts:2  wizard.tsx:12  ->  wizard.tsx:14');
    const f = spawnSync(process.execPath, [cli, '--base', 'HEAD', '--fix'], { cwd: dir, encoding: 'utf8' });
    expect(f.status).toBe(0);
    expect(readFileSync(join(dir, 'e2e/helpers.ts'), 'utf8')).toContain('bails at `wizard.tsx:14`');
  });
});

/**
 * kanon#175 — a code-comment coordinate the diff itself wrote is skipped by the move check,
 * and `citation-guard` reads Markdown only, so nothing checked it. Read here as ADVICE.
 */
// Its cases run the CLI in `node`, with `git`, so the block takes the spawn budget (#436).
describe('a code-comment coordinate this diff wrote is read as advice (kanon#175)', SPAWNS, () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `# line${i + 1}`).join('\n') + '\n';
  // The workflow gained 2 lines after line 1 and 2 more after line 5, so base :12 is head :16.
  const WF = `+++ b/.github/workflows/review.yml
@@ -1,0 +2,2 @@
+# a
+# b
@@ -5,0 +8,2 @@
+# c
+# d
`;
  const runRw = (head: string, extraDiff = '', target = lines(24)) =>
    shiftedCoordinates({
      docs: [],
      code: ['tests/a.test.ts'],
      readHead: (p: string) => (p === 'tests/a.test.ts' ? head : target),
      trackedHead: ['tests/a.test.ts', '.github/workflows/review.yml'],
      trackedBase: ['tests/a.test.ts', '.github/workflows/review.yml'],
      diff: parseDiff(WF + extraDiff),
    });
  const repoint = (to: string) => `+++ b/tests/a.test.ts
@@ -1 +1 @@
-// the step is at review.yml:12
+// the step is at review.yml:${to}
`;

  it('flags a re-point the diff\'s own map disagrees with — the replayed case: --fix, then 2 more lines above', () => {
    const r = runRw('// the step is at review.yml:14\n', repoint('14'));
    expect(r.moved).toEqual([]);
    expect(r.rewritten).toEqual([
      { at: 'tests/a.test.ts:1', doc: 'tests/a.test.ts', line: 1, citation: 'review.yml:14', path: '.github/workflows/review.yml', shape: 'off-map', base: [12, 12], mapped: [16, 16] },
    ]);
  });

  it('says nothing when the re-point agrees with the map', () => {
    expect(runRw('// the step is at review.yml:16\n', repoint('16')).rewritten).toEqual([]);
  });

  it('says nothing about a coordinate on a line the diff did not touch (the move check owns it)', () => {
    const r = runRw('// the step is at review.yml:12\n');
    expect(r.rewritten).toEqual([]);
    expect(r.moved).toHaveLength(1);
    expect(runRw('// the step is at review.yml:99\n').rewritten).toEqual([]);
  });

  it('flags a coordinate the diff wrote past the end of its file, changed by the diff or not', () => {
    const add = `+++ b/tests/a.test.ts
@@ -0,0 +1 @@
+// see review.yml:40
`;
    expect(runRw('// see review.yml:40\n', add).rewritten.map((x: { shape: string; length?: number }) => [x.shape, x.length])).toEqual([['past-eof', 24]]);
    expect(runRw('// see review.yml:24\n', add).rewritten).toEqual([]);
    // A target the diff did NOT change: only the comment's own hunk is in the diff.
    const unchanged = shiftedCoordinates({
      docs: [],
      code: ['tests/a.test.ts'],
      readHead: (p: string) => (p === 'tests/a.test.ts' ? '// see review.yml:40\n' : lines(24)),
      trackedHead: ['tests/a.test.ts', '.github/workflows/review.yml'],
      trackedBase: ['tests/a.test.ts', '.github/workflows/review.yml'],
      diff: parseDiff(add),
    });
    expect(unchanged.rewritten.map((x: { shape: string; path: string }) => [x.shape, x.path])).toEqual([['past-eof', '.github/workflows/review.yml']]);
  });

  it('never reads a doc this way — citation-guard judges those', () => {
    const r = shiftedCoordinates({
      docs: ['docs/a.md'],
      readHead: (p: string) => (p === 'docs/a.md' ? 'At `review.yml:14`.\n' : lines(24)),
      trackedHead: ['docs/a.md', '.github/workflows/review.yml'],
      trackedBase: ['docs/a.md', '.github/workflows/review.yml'],
      diff: parseDiff(WF + '+++ b/docs/a.md\n@@ -1 +1 @@\n-At `review.yml:12`.\n+At `review.yml:14`.\n'),
    });
    expect(r.rewritten).toEqual([]);
  });

  it('prints one warning per coordinate, as an annotation in CI', () => {
    const x = { at: 't.ts:1', doc: 't.ts', line: 1, citation: 'review.yml:14', path: 'review.yml', shape: 'off-map' as const, base: [12, 12], mapped: [16, 16] };
    const [l] = rewrittenLines([x], false);
    expect(l).toMatch(/^citation-shift \(advisory\): t\.ts:1 {2}review\.yml:14 — /);
    expect(l).toContain('replaced :12, which this diff\'s own line map sends to :16');
    expect(rewrittenLines([x], true)[0]).toMatch(/^::warning::citation-shift \(advisory\)/);
  });

  it('end to end over two commits: advisory printed, exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cshift-rw-'));
    const sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    sh('init', '-q');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    const wf = (extra: string[]) => ['# line1', ...extra, ...Array.from({ length: 19 }, (_, i) => `# line${i + 2}`)].join('\n') + '\n';
    w('.github/workflows/review.yml', wf([]));
    w('tests/review.test.ts', '// the gate step lives at review.yml:12\nexport const x = 1;\n');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    sh('add', '.');
    sh('commit', '-qm', 'base');
    const base = sh('rev-parse', 'HEAD').stdout.trim();
    // Commit 1: the step moves 2 lines and the comment is re-pointed (what --fix writes).
    w('.github/workflows/review.yml', wf(['# a', '# b']));
    w('tests/review.test.ts', '// the gate step lives at review.yml:14\nexport const x = 1;\n');
    sh('commit', '-qam', 'one');
    // Commit 2: two more lines above the step; the comment is left as commit 1 wrote it.
    w('.github/workflows/review.yml', wf(['# a', '# b', '# c', '# d']));
    sh('commit', '-qam', 'two');
    const cli = join(ROOT, 'scripts/citation-shift.mjs');
    const r = spawnSync(process.execPath, [cli, '--base', base, '--head', 'HEAD'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('citation-shift (advisory): tests/review.test.ts:1  review.yml:14');
    expect(r.stdout).toContain('sends to :16');
  });
});

/**
 * kanon#347 — a code-comment coordinate the diff writes FRESH, with no old coordinate on its
 * line to map, was checked only against the end of its file. Its comment's own identifiers are
 * now looked for in the cited lines and their enclosing scope, as `citation-guard` reads a doc.
 */
describe('a fresh code-comment coordinate is read against what its comment names (kanon#347)', () => {
  const ORDERS = [
    'export const loadOrder = (id) => {',
    '  return db.find(id);',
    '};',
    '',
    'export const saveOrder = (o) => {',
    '  return db.insert(o);',
    '};',
    '',
  ].join('\n');
  const added = (line: string) => `+++ b/tests/a.test.ts\n@@ -0,0 +1 @@\n+${line}\n`;
  const run = (line: string, diff = added(line)) =>
    shiftedCoordinates({
      docs: [],
      code: ['tests/a.test.ts'],
      readHead: (p: string) => (p === 'tests/a.test.ts' ? `${line}\n` : ORDERS),
      trackedHead: ['tests/a.test.ts', 'src/orders.ts'],
      trackedBase: ['tests/a.test.ts', 'src/orders.ts'],
      diff: parseDiff(diff),
    }).rewritten;

  it('flags a fresh coordinate whose lines name none of what its comment does, though the target is not in the diff', () => {
    expect(run('// `saveOrder` writes it (orders.ts:2)')).toEqual([
      { at: 'tests/a.test.ts:1', doc: 'tests/a.test.ts', line: 1, citation: 'orders.ts:2', path: 'src/orders.ts', shape: 'off-anchor', anchors: ['saveOrder'] },
    ]);
  });

  it('says nothing when the range or its enclosing scope names it', () => {
    expect(run('// `db.insert` writes it (orders.ts:6)')).toEqual([]);
    expect(run('// `saveOrder` writes it (orders.ts:6)')).toEqual([]);
  });

  it('gives no verdict on a comment that names no identifier before the coordinate', () => {
    expect(run('// it is written at orders.ts:2')).toEqual([]);
    expect(run('// orders.ts:2 is where `saveOrder` writes it')).toEqual([]);
  });

  it('leaves a re-point, and a coordinate carried through an edit, to the map', () => {
    const repoint = '+++ b/tests/a.test.ts\n@@ -1 +1 @@\n-// `saveOrder` writes it (orders.ts:5)\n+// `saveOrder` writes it (orders.ts:2)\n';
    expect(run('// `saveOrder` writes it (orders.ts:2)', repoint)).toEqual([]);
  });

  it('says nothing about a line the diff did not write, and the move check is unchanged', () => {
    const elsewhere = '+++ b/tests/a.test.ts\n@@ -1,0 +2 @@\n+// unrelated\n';
    expect(run('// `saveOrder` writes it (orders.ts:2)', elsewhere)).toEqual([]);
  });

  it('prints what the comment names, as advice', () => {
    const x = { at: 't.ts:1', doc: 't.ts', line: 1, citation: 'orders.ts:2', path: 'src/orders.ts', shape: 'off-anchor' as const, anchors: ['saveOrder'] };
    const [l] = rewrittenLines([x], false);
    expect(l).toMatch(/^citation-shift \(advisory\): t\.ts:1 {2}orders\.ts:2 — /);
    expect(l).toContain('points at lines of src/orders.ts that name none of what the comment does before it (`saveOrder`)');
  });
});

// Its cases run the CLI in `node`, with `git`, so the block takes the spawn budget (#436).
describe('the docs it maps are the guard\'s `--path` list, `docs/**/*.md` by default (kanon#388)', SPAWNS, () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cshift-paths-'));
    const sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    sh('init', '-q');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    w('src/wizard.tsx', Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    w('rulebook/r.md', '# A rule\n\nThe wizard bails at `src/wizard.tsx:12`.\n');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    sh('add', '.');
    sh('commit', '-qm', 'base');
    w('src/wizard.tsx', ['line1', 'line2', 'new-a', 'new-b', ...Array.from({ length: 18 }, (_, i) => `line${i + 3}`)].join('\n') + '\n');
    const cli = join(ROOT, 'scripts/citation-shift.mjs');
    return (...args: string[]) => spawnSync(process.execPath, [cli, '--base', 'HEAD', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  };

  it('leaves a rulebook/ coordinate alone by default, and reports it moved once rulebook/ is on the list', () => {
    const run = setup();
    const byDefault = run();
    expect(byDefault.status, byDefault.stdout + byDefault.stderr).toBe(0);
    const listed = run('--path', 'docs/**/*.md', '--path', 'rulebook/**/*.md');
    expect(listed.status, listed.stdout + listed.stderr).toBe(1);
    expect(listed.stderr).toContain('rulebook/r.md:3  `src/wizard.tsx:12`  ->  `src/wizard.tsx:14`');
  });

  it('fails a glob that selects nothing it reads, by name', () => {
    const r = setup()('--path', 'rulbook/**/*.md');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('citation-shift: `--path rulbook/**/*.md` selected no tracked Markdown file it reads');
  });
});

/**
 * kanon#1108 — a coordinate into a path a file-system router produces (`app/[id]/page.tsx`,
 * `(group)`, `[...slug]`, `@slot`) was not read, so a diff that moved lines in one reported
 * "none left behind by a move" over six stale coordinates in an adopter's `[confirmed]` clauses.
 */
describe("a coordinate into a file-system router's path moves like any other (kanon#1108)", () => {
  const ROUTES = [
    'src/app/x/page.tsx',
    'src/app/[id]/page.tsx',
    'src/app/[...slug]/page.tsx',
    'src/app/[[...opt]]/page.tsx',
    'src/app/(group)/page.tsx',
    'src/app/@slot/page.tsx',
    'src/app/@modal/(..)photo/[id]/page.tsx',
    'src/routes/[[lang=locale]]/+page.ts',
    'app/routes/($lang).posts.$postId.tsx',
  ];
  const insert3After5 = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -5,0 +6,3 @@ ctx\n+a\n+b\n+c\n`;

  it.each(ROUTES)('reports a doc coordinate into `%s` the diff moved, and its replacement', (path) => {
    const r = run({ 'docs/a.md': `The page loads it at \`${path}:12\`, \`:3\`, and \`${path}\` L9-10.\n` }, insert3After5(path), [path, 'src/other.ts']);
    expect(r.moved.map((m) => [m.citation, m.replacement])).toEqual([
      [`\`${path}:12\``, `\`${path}:15\``],
      [`\`${path}\` L9-10`, `\`${path}\` L12-13`],
    ]);
  });

  it.each(ROUTES)('reports a code-comment coordinate into `%s` the diff moved', (path) => {
    const r = shiftedCoordinates({
      docs: [],
      code: ['e2e/helpers.ts'],
      readHead: () => `// bails at ${path}:12 (see \`${path}:3\`)\nexport const x = 1;\n`,
      trackedHead: [path, 'e2e/helpers.ts'],
      trackedBase: [path, 'e2e/helpers.ts'],
      diff: parseDiff(insert3After5(path)),
    });
    expect(r.moved.map((m) => [m.citation, m.replacement])).toEqual([[`${path}:12`, `${path}:15`]]);
    expect(r.pointingCode).toBe(2);
  });

  it('still reads the prose around a coordinate in a code comment as prose', () => {
    const texts = (line: string) => commentCoordinates(line).map((c: { text: string }) => c.text);
    expect(texts('// checkout (wizard.tsx:9, #253)')).toEqual(['wizard.tsx:9']);
    expect(texts('// checkout (src/app/(group)/page.tsx:9)')).toEqual(['src/app/(group)/page.tsx:9']);
    expect(texts('// file=src/a.ts:3')).toEqual(['src/a.ts:3']);
    expect(texts('// see app/@modal/page.tsx:3')).toEqual(['app/@modal/page.tsx:3']);
    expect(texts('// @scope/pkg.ts:3 and @/lib/a.ts:4')).toEqual([]);
  });
});

// Its cases run the CLI in `node`, with `git`, so the block takes the spawn budget (#436).
describe('the CLI moves a coordinate into a dynamic route end to end (kanon#1108)', SPAWNS, () => {
  it('fails on `app/[id]/page.tsx` and `app/(group)/[...slug]/page.tsx` coordinates the working tree moved, and --fix re-points them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cshift-route-'));
    const sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    sh('init', '-q');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    w('src/app/[id]/page.tsx', lines.join('\n') + '\n');
    w('src/app/(group)/[...slug]/page.tsx', lines.join('\n') + '\n');
    w('docs/qa/specs/tenants.md', '# Tenants\n\nThe page reads it at `src/app/[id]/page.tsx:12` and `src/app/(group)/[...slug]/page.tsx:15`.\n');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    sh('add', '.');
    sh('commit', '-qm', 'base');
    const moved = ['line1', 'line2', 'new-a', 'new-b', ...lines.slice(2)].join('\n') + '\n';
    w('src/app/[id]/page.tsx', moved);
    w('src/app/(group)/[...slug]/page.tsx', moved);
    const cli = join(ROOT, 'scripts/citation-shift.mjs');
    const env = { ...process.env, GITHUB_ACTIONS: '' };
    const r = spawnSync(process.execPath, [cli, '--base', 'HEAD'], { cwd: dir, encoding: 'utf8', env });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('docs/qa/specs/tenants.md:3  `src/app/[id]/page.tsx:12`  ->  `src/app/[id]/page.tsx:14`');
    expect(r.stderr).toContain('`src/app/(group)/[...slug]/page.tsx:15`  ->  `src/app/(group)/[...slug]/page.tsx:17`');
    const f = spawnSync(process.execPath, [cli, '--base', 'HEAD', '--fix'], { cwd: dir, encoding: 'utf8', env });
    expect(f.status, f.stdout + f.stderr).toBe(0);
    expect(readFileSync(join(dir, 'docs/qa/specs/tenants.md'), 'utf8')).toContain('at `src/app/[id]/page.tsx:14` and `src/app/(group)/[...slug]/page.tsx:17`.');
    const again = spawnSync(process.execPath, [cli, '--base', 'HEAD'], { cwd: dir, encoding: 'utf8', env });
    expect(again.status, again.stdout + again.stderr).toBe(0);
  });
});

/**
 * kanon#166 — after a rebase, a clause both sides re-pointed is a per-coordinate mix, which no
 * "take one side" answer gets right and the ordinary check can't see (every value on the line
 * looks re-derived). `--rebase <old-head>` re-derives each from the side its value came from.
 *
 * The seven-coordinate case, as the reference adopter met it. `src/svc.ts` has 40 lines on the old
 * base. The branch inserts 2 lines after line 5; the default branch, meanwhile, inserts 3 after
 * line 15. Seven coordinates into the old base's lines 8, 12, 18, 25, 30, 33 and 35 read
 *   on the branch (old head)  10, 14, 20, 27, 32, 35, 37
 *   on the new base           8, 12, 21, 28, 33, 36, 38
 *   right on the new head     10, 14, 23, 30, 35, 38, 40
 * and the conflict was resolved by taking three from the branch (10, 20, 32), three from the new
 * base (12, 28, 36), and one from neither (39).
 */
describe('--rebase re-derives each coordinate from the side it came from (kanon#166)', () => {
  const clause = (ns: number[], lead = 'The flow') => `${lead}: ${ns.map((n) => `\`src/svc.ts:${n}\``).join(', ')}.`;
  const OLD_HEAD = clause([10, 14, 20, 27, 32, 35, 37], 'The branch flow');
  const NEW_BASE = clause([8, 12, 21, 28, 33, 36, 38], 'The main flow');
  const MIXED = clause([10, 12, 20, 28, 32, 36, 39], 'The merged flow');
  const docDiff = (from: string, to: string) => `+++ b/docs/spec.md\n@@ -3 +3 @@\n-${from}\n+${to}\n`;
  // old head -> new head: the default branch's 3 lines, after old-head line 17 (old base 15).
  const FROM_OLD_HEAD_SRC = '+++ b/src/svc.ts\n@@ -17,0 +18,3 @@\n+m1\n+m2\n+m3\n';
  // new base -> new head: the branch's 2 lines, after line 5.
  const FROM_NEW_BASE_SRC = '+++ b/src/svc.ts\n@@ -5,0 +6,2 @@\n+b1\n+b2\n';
  const tracked = ['src/svc.ts', 'docs/spec.md'];
  const rebase = (head: string, fromOldHead: string, fromNewBase: string) =>
    rebasedCoordinates({
      docs: ['docs/spec.md'],
      readHead: () => head,
      trackedHead: tracked,
      trackedOldHead: tracked,
      trackedNewBase: tracked,
      fromOldHead: parseDiff(fromOldHead),
      fromNewBase: parseDiff(fromNewBase),
    });
  const head = `# Spec\n\n${MIXED}\n`;

  it('the seven-coordinate mixed case: each value pushed through its own side\'s map, and the one from neither reported', () => {
    const r = rebase(head, docDiff(OLD_HEAD, MIXED) + FROM_OLD_HEAD_SRC, docDiff(NEW_BASE, MIXED) + FROM_NEW_BASE_SRC);
    expect(r.read).toBe(7);
    expect(r.proposed.map((p) => [p.from[0], p.to[0], p.side])).toEqual([
      [12, 14, 'main'], [20, 23, 'branch'], [28, 30, 'main'], [32, 35, 'branch'], [36, 38, 'main'],
    ]);
    expect(r.proposed[0]!.replacement).toBe('`src/svc.ts:14`');
    // `:10` came from the branch and is already right on the new head: nothing to say.
    expect(r.neither.map((x) => x.citation)).toEqual(['`src/svc.ts:39`']);
    expect(r.ambiguous).toEqual([]);
    expect(r.edited).toEqual([]);
  });

  it('the ordinary check sees only the new base\'s half: the branch\'s values read as re-derived', () => {
    const r = shiftedCoordinates({
      docs: ['docs/spec.md'], readHead: () => head, trackedHead: tracked, trackedBase: tracked,
      diff: parseDiff(docDiff(NEW_BASE, MIXED) + FROM_NEW_BASE_SRC),
    });
    expect(r.moved.map((m) => [m.from[0], m.to[0]])).toEqual([[12, 14], [28, 30], [36, 38]]);
  });

  it('reads only lines the branch wrote: a line the new base has as it is is the ordinary check\'s', () => {
    const untouched = `# Spec\n\n${NEW_BASE}\n`;
    const r = rebase(untouched, docDiff(OLD_HEAD, NEW_BASE) + FROM_OLD_HEAD_SRC, FROM_NEW_BASE_SRC);
    expect(r.read).toBe(0);
    expect(r.proposed).toEqual([]);
  });

  it('takes the branch\'s line itself when the rebase left it as the branch wrote it', () => {
    const branchSide = `# Spec\n\n${OLD_HEAD}\n`;
    const r = rebase(branchSide, FROM_OLD_HEAD_SRC, docDiff(NEW_BASE, OLD_HEAD) + FROM_NEW_BASE_SRC);
    expect(r.proposed.map((p) => [p.from[0], p.to[0], p.side])).toEqual([[20, 23, 'branch'], [27, 30, 'branch'], [32, 35, 'branch'], [35, 38, 'branch'], [37, 40, 'branch']]);
    expect(r.neither).toEqual([]);
  });

  it('a value on both sides whose maps agree is placed; one whose maps disagree is reported, not chosen', () => {
    const one = (n: number) => `# Spec\n\nThe step (\`src/svc.ts:${n}\`), now worded anew.\n`;
    const side = (n: number, w: string) => `The step (\`src/svc.ts:${n}\`), ${w}.`;
    // `:3` is above both insertions: both maps leave it.
    const agree = rebase(one(3), docDiff(side(3, 'b'), 'x') + FROM_OLD_HEAD_SRC, docDiff(side(3, 'm'), 'x') + FROM_NEW_BASE_SRC);
    expect([agree.proposed, agree.ambiguous, agree.neither]).toEqual([[], [], []]);
    // `:20` on both: the branch's map gives 23, the new base's 22.
    const clash = rebase(one(20), docDiff(side(20, 'b'), 'x') + FROM_OLD_HEAD_SRC, docDiff(side(20, 'm'), 'x') + FROM_NEW_BASE_SRC);
    expect(clash.proposed).toEqual([]);
    expect(clash.ambiguous.map((a) => a.options)).toEqual([{ branch: [23, 23], main: [22, 22] }]);
  });

  it('a value whose cited lines the other side rewrote is listed as edited', () => {
    const h = `# Spec\n\n${clause([10])}\n`;
    const rewrite = '+++ b/src/svc.ts\n@@ -10 +10 @@\n-line8\n+changed\n';
    const r = rebase(h, docDiff(clause([10], 'b'), 'x') + rewrite, docDiff(clause([8], 'm'), 'x') + FROM_NEW_BASE_SRC);
    expect(r.edited.map((e) => [e.citation, e.sides])).toEqual([['`src/svc.ts:10`', ['branch']]]);
  });

  it('prints its proposals, what to re-derive, and a count — advice only', () => {
    const r = rebase(head, docDiff(OLD_HEAD, MIXED) + FROM_OLD_HEAD_SRC, docDiff(NEW_BASE, MIXED) + FROM_NEW_BASE_SRC);
    const out = rebasedLines(r, { oldHead: 'abc123', base: '--base' }).join('\n');
    expect(out).toContain('docs/spec.md:3  `src/svc.ts:20`  ->  `src/svc.ts:23`  (from the branch before the rebase)');
    expect(out).toContain('docs/spec.md:3  `src/svc.ts:12`  ->  `src/svc.ts:14`  (from the new base)');
    expect(out).toContain('1 coordinate(s) match neither side');
    expect(out).toContain('read 7 coordinate(s) on lines the branch wrote, against `abc123` and the new base (--base); 5 to re-point, 1 to re-derive, 0 on edited lines. Run again with --fix');
  });
});

describe('--rebase end to end over a real rebase (kanon#166)', SPAWNS, () => {
  it('proposes the mixed clause\'s values, exits 0, and --fix writes them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cshift-rebase-'));
    const sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    const src = (after5: string[], after15: string[]) => {
      const l = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
      return [...l.slice(0, 5), ...after5, ...l.slice(5, 15), ...after15, ...l.slice(15)].join('\n') + '\n';
    };
    const clause = (ns: number[], lead: string) => `# Spec\n\n${lead}: ${ns.map((n) => `\`src/svc.ts:${n}\``).join(', ')}.\n`;
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    w('src/svc.ts', src([], []));
    w('docs/spec.md', clause([8, 12, 18, 25, 30, 33, 35], 'The flow'));
    sh('add', '.');
    sh('commit', '-qm', 'old base');
    sh('checkout', '-qb', 'branch');
    w('src/svc.ts', src(['b1', 'b2'], []));
    w('docs/spec.md', clause([10, 14, 20, 27, 32, 35, 37], 'The branch flow'));
    sh('commit', '-qam', 'branch');
    const oldHead = sh('rev-parse', 'HEAD').stdout.trim();
    sh('checkout', '-q', 'main');
    w('src/svc.ts', src([], ['m1', 'm2', 'm3']));
    w('docs/spec.md', clause([8, 12, 21, 28, 33, 36, 38], 'The main flow'));
    sh('commit', '-qam', 'main');
    const newBase = sh('rev-parse', 'HEAD').stdout.trim();
    // The rebase: the source merges cleanly, the clause conflicts and is resolved by hand.
    sh('checkout', '-q', 'branch');
    sh('rebase', '-q', 'main');
    w('src/svc.ts', src(['b1', 'b2'], ['m1', 'm2', 'm3']));
    w('docs/spec.md', clause([10, 12, 20, 28, 32, 36, 39], 'The merged flow'));
    sh('add', '.');
    sh('-c', 'core.editor=true', 'rebase', '--continue');
    expect(sh('rev-parse', 'HEAD^').stdout.trim()).toBe(newBase);
    const cli = join(ROOT, 'scripts/citation-shift.mjs');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--base', newBase, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
    // The ordinary check catches the new base's three and is blind to the branch's.
    const plain = run('--head', 'HEAD');
    expect(plain.status, plain.stdout + plain.stderr).toBe(1);
    expect(plain.stderr).toContain('3 coordinate(s) point at lines this diff MOVED');
    expect(plain.stderr).not.toContain('svc.ts:20');
    const advice = run('--rebase', oldHead, '--head', 'HEAD');
    expect(advice.status, advice.stdout + advice.stderr).toBe(0);
    expect(advice.stdout).toContain('5 to re-point, 1 to re-derive');
    const fixed = run('--rebase', oldHead, '--fix');
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(readFileSync(join(dir, 'docs/spec.md'), 'utf8')).toBe(clause([10, 14, 23, 30, 35, 38, 39], 'The merged flow'));
    const missing = run('--rebase', 'no-such-rev');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--rebase needs the branch\'s head from before the rebase');
  });
});

/**
 * kanon#166, the related shape — a PR re-points a coordinate correctly in one commit, and a later
 * commit of the same PR adds lines above its target. Base to head the coordinate's line changed, so
 * the ordinary check reads it as re-derived and stays green. `--commits` judges each coordinate
 * against the diff since the commit that wrote it.
 *
 * `src/svc.ts` has 40 lines on the base, cited at `:20` and `:35`. Commit 1 inserts 2 lines after
 * line 5 and re-points `:20` to `:22`, adding a fresh `:30` (the base's 28), both right for commit
 * 1, and leaving `:35` as it was. The head, commit 2, inserts 3 lines after line 10, so the right
 * values are now 25, 33 and 40, and writes a fresh `:14` it derived against itself.
 */
describe('--commits judges each coordinate from the commit that wrote it (kanon#166)', () => {
  const BASE_LINE = 'The flow: `src/svc.ts:20`, `src/svc.ts:35`.';
  const HEAD_LINE = 'The flow: `src/svc.ts:22`, `src/svc.ts:30`, `src/svc.ts:35`.';
  const LATER = 'Later: `src/svc.ts:14`.';
  const head = `# Spec\n\n${HEAD_LINE}\n\n${LATER}\n`;
  const tracked = ['src/svc.ts', 'docs/spec.md'];
  // base -> head: the doc line rewritten and two added; the source's 2 + 3 lines.
  const FROM_BASE = `+++ b/docs/spec.md\n@@ -3 +3,3 @@\n-${BASE_LINE}\n+${HEAD_LINE}\n+\n+${LATER}\n` +
    '+++ b/src/svc.ts\n@@ -5,0 +6,2 @@\n+b1\n+b2\n@@ -8,0 +11,3 @@\n+c1\n+c2\n+c3\n';
  // commit 1 -> head: the two doc lines commit 2 added; its 3 source lines, after commit 1's line 10.
  const FROM_C1 = `+++ b/docs/spec.md\n@@ -3,0 +4,2 @@\n+\n+${LATER}\n` +
    '+++ b/src/svc.ts\n@@ -10,0 +11,3 @@\n+c1\n+c2\n+c3\n';
  const commits = (history: { rev: string; diff: string }[], text = head, fromBase = FROM_BASE) => committedCoordinates({
    docs: ['docs/spec.md'],
    readHead: () => text,
    trackedHead: tracked,
    base: { diff: parseDiff(fromBase), tracked },
    history: history.map((h) => ({ rev: h.rev, diff: parseDiff(h.diff), tracked })),
  });

  it('proposes the values a later commit moved, through the map since the commit that wrote them', () => {
    const r = commits([{ rev: 'c1c1c1c1c1c1c1', diff: FROM_C1 }]);
    expect(r.read).toBe(4);
    expect(r.proposed.map((p) => [p.from[0], p.to[0], p.since])).toEqual([[22, 25, 'c1c1c1c1c1c1c1'], [30, 33, 'c1c1c1c1c1c1c1']]);
    expect(r.proposed[0]!.replacement).toBe('`src/svc.ts:25`');
    expect(r.edited).toEqual([]);
  });

  it('the ordinary check is green on the same diff: both values read as re-derived', () => {
    const r = shiftedCoordinates({ docs: ['docs/spec.md'], readHead: () => head, trackedHead: tracked, trackedBase: tracked, diff: parseDiff(FROM_BASE) });
    // Only the base's `:35`, carried through the rewrite, is the ordinary check's.
    expect(r.moved.map((m) => [m.from[0], m.to[0]])).toEqual([[35, 40]]);
  });

  it('says nothing of a value the head wrote, or one carried from the base', () => {
    const r = commits([{ rev: 'c1', diff: FROM_C1 }]);
    expect(r.proposed.map((p) => p.citation)).not.toContain('`src/svc.ts:14`');
    expect(r.proposed.map((p) => p.citation)).not.toContain('`src/svc.ts:35`');
    // With no commit below the head, every value on the line was written by the head.
    expect(commits([]).proposed).toEqual([]);
    // A line the base has as it is is not read at all: it is the ordinary check's.
    const SRC_ONLY = '+++ b/src/svc.ts\n@@ -5,0 +6,2 @@\n+b1\n+b2\n';
    const untouched = commits([{ rev: 'c1', diff: SRC_ONLY }], `# Spec\n\n${BASE_LINE}\n`, SRC_ONLY);
    expect([untouched.read, untouched.proposed]).toEqual([0, []]);
  });

  it('lists a value whose cited lines a later commit rewrote as edited, not moved', () => {
    const rewrite = `+++ b/docs/spec.md\n@@ -3,0 +4,2 @@\n+\n+${LATER}\n+++ b/src/svc.ts\n@@ -22 +22 @@\n-line20\n+changed\n`;
    const r = commits([{ rev: 'c1', diff: rewrite }]);
    expect(r.edited.map((e) => e.citation)).toEqual(['`src/svc.ts:22`']);
    expect(r.proposed).toEqual([]);
  });

  it('prints each proposal with the commit that wrote it, and a count — advice only', () => {
    const out = committedLines(commits([{ rev: 'c1c1c1c1c1c1c1', diff: FROM_C1 }]), { commits: 1 }).join('\n');
    expect(out).toContain('docs/spec.md:3  `src/svc.ts:22`  ->  `src/svc.ts:25`  (written in c1c1c1c1c1c1)');
    expect(out).toContain('read 4 coordinate(s) on lines the branch wrote, against each of its 1 commit(s) below the head; 2 to re-point, 0 on edited lines. Run again with --fix');
  });
});

describe('--commits end to end over a real branch of three commits (kanon#166)', SPAWNS, () => {
  it('maps from the commit that wrote each value, not the newest that carries it, exits 0, and --fix writes them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cshift-commits-'));
    const sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
    // `inserts` are [after base line, count] pairs, applied to the base's 40 lines.
    const src = (inserts: [number, number][]) => {
      const out: string[] = [];
      for (let i = 1; i <= 40; i += 1) {
        out.push(`line${i}`);
        for (const [after, k] of inserts) if (after === i) for (let j = 0; j < k; j += 1) out.push(`ins${i}-${j}`);
      }
      return out.join('\n') + '\n';
    };
    const doc = (body: string) => `# Spec\n\n${body}\n`;
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 't@t');
    sh('config', 'user.name', 't');
    w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
    w('src/svc.ts', src([]));
    w('docs/spec.md', doc('The flow: `src/svc.ts:20`.'));
    sh('add', '.');
    sh('commit', '-qm', 'base');
    const base = sh('rev-parse', 'HEAD').stdout.trim();
    sh('checkout', '-qb', 'branch');
    // Commit 1: 2 lines after base line 5; the clause re-pointed right, and a fresh `:30` (base 28).
    w('src/svc.ts', src([[5, 2]]));
    w('docs/spec.md', doc('The flow: `src/svc.ts:22`, `src/svc.ts:30`.'));
    sh('commit', '-qam', 'one');
    // Commit 2: 3 lines after base line 8, which moves both; the clause is not touched.
    w('src/svc.ts', src([[5, 2], [8, 3]]));
    sh('commit', '-qam', 'two');
    // Commit 3: 1 line after base line 3, and a fresh `:15` (base 8) derived against itself.
    w('src/svc.ts', src([[3, 1], [5, 2], [8, 3]]));
    w('docs/spec.md', doc('The flow: `src/svc.ts:22`, `src/svc.ts:30`.\n\nLater: `src/svc.ts:15`.'));
    sh('commit', '-qam', 'three');
    const cli = join(ROOT, 'scripts/citation-shift.mjs');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--base', base, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
    // The ordinary check is green: every value on the clause changed base to head.
    const plain = run('--head', 'HEAD');
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    expect(plain.stdout).toContain('none left behind by a move');
    // Right on the head: base 20 -> 26, base 28 -> 34. Commit 2 carries both values too, but
    // commit 1 wrote them, so its map (6 lines since) applies, not commit 2's (1 line since).
    const advice = run('--commits', '--head', 'HEAD');
    expect(advice.status, advice.stdout + advice.stderr).toBe(0);
    expect(advice.stdout).toContain('docs/spec.md:3  `src/svc.ts:22`  ->  `src/svc.ts:26`');
    expect(advice.stdout).toContain('`src/svc.ts:30`  ->  `src/svc.ts:34`');
    expect(advice.stdout).toContain('against each of its 2 commit(s) below the head; 2 to re-point');
    const fixed = run('--commits', '--fix');
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(readFileSync(join(dir, 'docs/spec.md'), 'utf8')).toBe(doc('The flow: `src/svc.ts:26`, `src/svc.ts:34`.\n\nLater: `src/svc.ts:15`.'));
    const both = run('--commits', '--rebase', base);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain('--rebase and --commits read different histories');
  });
});
