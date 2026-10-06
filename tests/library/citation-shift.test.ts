import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentCoordinates, lineMapper, parseDiff, readsCodeComments as readsWith, retarget, rewrittenLines, shiftedCoordinates } from '../../scripts/citation-shift.mjs';
import { UNDECLARED, parseCodeAreas } from '../../scripts/lib/code-areas.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * RA-1384 — the coordinates a diff moved, derived from the diff.
 *
 * KANON'S HALF (plan 0001, step 3). The reference adopter keeps the halves that read its own tree and its CI wiring.
 *
 *
 * `citation-guard` judges a coordinate against one tree, so the range-checked-only
 * majority drifts silently: RA-811's three `course-wizard.tsx` coordinates pointed at a
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

describe('the CLI reads code comments end to end (RA-2293)', () => {
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
 * and `citation-guard` reads `docs/` only, so nothing checked it. Read here as ADVICE.
 */
describe('a code-comment coordinate this diff wrote is read as advice (kanon#175)', () => {
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
