import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qaToolingImport, referenceCorpus } from '../../scripts/spec-lib.mjs';
import { mentionsWithoutTitle } from '../../scripts/spec-coverage.mjs';
import { readsCodeComments } from '../../scripts/citation-shift.mjs';
import { UNDECLARED } from '../../scripts/lib/code-areas.mjs';
import { ROOT } from './helpers/adopter.js';
import { SPAWNS } from '../unit/helpers/spawns.js';

/**
 * kanon#54: a test that imports the adopter's own pipeline code is a test of the tooling, and
 * its spec ids are fixtures. Which directories that code lives in is the adopter's, declared
 * under `## Pipeline code` in `docs/qa/escalation-paths.md` (`K-LAYOUT-8`). It was a constant
 * naming the reference adopter's directory, so on any other repository a tooling test's
 * fixture ids counted as coverage and as references to renumbered ids.
 */

const STATIC = (path: string) => `import { check } from '${path}';\n`;
const SPEC = '# S\n\n**Id prefix:** `STORE`\n\n## A\n\n- `[STORE-102]` `[seed]` one\n- `[STORE-103]` `[seed]` two\n';
const ESCALATIONS = (pipeline: string) => `# Escalation paths\n\n## Escalation paths\n\n## Pipeline code\n\n${pipeline}\n`;

// The adopter declares its test tree, so the only default a CLI can take here is the escalation
// file's.
const STACK = '# Stack\n\n## Gates\n\n1. `make test`\n\n## Code areas\n\n- `tests/` — tests: the suite\n';

const adopter = (escalations: string | null, stack: string | null = STACK) => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-imports-'));
  const w = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
  w('docs/qa/specs/storefront.md', SPEC);
  w('docs/qa/specs/_locked-floor.json', '{ "locked": [] }\n');
  w('docs/qa/specs/_id-registry.json', JSON.stringify({ STORE: 103, renumbered: { 'STORE-102': { to: 'STORE-103', by: 2003 } } }));
  // A tooling test under the declared directory's name: its id is a fixture.
  w('tests/tool.test.ts', `${STATIC('../tools/pipeline/guard.mjs')}// [STORE-102] is a fixture here\n`);
  if (escalations !== null) w('docs/qa/escalation-paths.md', escalations);
  if (stack !== null) w('docs/qa/stack.md', stack);
  return dir;
};

describe('qaToolingImport reads the declared pipeline-code directories', () => {
  it('matches an import from a declared directory, after any relative prefix', () => {
    const re = qaToolingImport(['tools/pipeline/']);
    expect(re.test(STATIC('../../tools/pipeline/guard.mjs'))).toBe(true);
    expect(re.test(STATIC('tools/pipeline/lib/x.mjs'))).toBe(true);
    expect(re.test("const m = await importKanon('../../tools/pipeline/guard.mjs');")).toBe(true);
  });

  it("doesn't match the reference adopter's directory unless it is declared", () => {
    expect(qaToolingImport(['tools/pipeline/']).test(STATIC('../../scripts/qa/guard.mjs'))).toBe(false);
    expect(qaToolingImport([]).test(STATIC('../../scripts/qa/guard.mjs'))).toBe(false);
  });

  it('matches a directory as a whole path segment, not as the tail of a longer name', () => {
    expect(qaToolingImport(['tools/pipeline/']).test(STATIC('../mytools/pipeline/guard.mjs'))).toBe(false);
  });

  it("always matches Kanon's library from an adopter's `.kanon/scripts/` checkout", () => {
    expect(qaToolingImport([]).test("const m = await importKanon('../../.kanon/scripts/spec-lib.mjs');")).toBe(true);
  });

  it('refuses to guess when it is given no declaration', () => {
    expect(() => qaToolingImport(undefined as never)).toThrow(/pipeline-code directories/);
    expect(() => referenceCorpus(process.cwd(), undefined as never)).toThrow(/pipeline-code directories/);
    expect(() => mentionsWithoutTitle(new Set(), new Set(), undefined as never)).toThrow(/pipeline-code directories/);
  });

  it("citation-shift reads a test's comments unless it imports declared pipeline code", () => {
    const text = STATIC('../../tools/pipeline/guard.mjs');
    expect(readsCodeComments('tests/unit/a.test.ts', text, ['tools/pipeline/'], UNDECLARED)).toBe(false);
    expect(readsCodeComments('tests/unit/a.test.ts', text, ['scripts/pipeline/'], UNDECLARED)).toBe(true);
  });

  it('referenceCorpus leaves out a test that imports declared pipeline code, and only that', () => {
    const dir = adopter(null);
    expect(referenceCorpus(dir, ['tools/pipeline/'])).not.toContain('tests/tool.test.ts');
    expect(referenceCorpus(dir, ['scripts/pipeline/'])).toContain('tests/tool.test.ts');
  });
});

// Its cases run the CLIs in `node`, so the block takes the spawn budget (#436).
describe("the CLIs read the declaration, and name Kanon's default without it", SPAWNS, () => {
  const run = (script: string, dir: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8' });

  it('spec-id-renumbered skips the tooling test the declaration names', () => {
    const r = run('spec-id-renumbered.mjs', adopter(ESCALATIONS('- `tools/pipeline/` — our pipeline\n')));
    expect(r.stderr).not.toContain('tests/tool.test.ts');
    expect(r.status, r.stderr).toBe(0);
  });

  it('spec-id-renumbered reports the same test when the declaration names other code', () => {
    const r = run('spec-id-renumbered.mjs', adopter(ESCALATIONS('- `scripts/pipeline/` — our pipeline\n')));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tests/tool.test.ts:2  [STORE-102]');
  });

  it("spec-coverage doesn't list a tooling test's fixture id as mentioned, and does list another test's", () => {
    const mentioned = (pipeline: string) => {
      const r = run('spec-coverage.mjs', adopter(ESCALATIONS(pipeline)), '--json');
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout).mentionedNotCited;
    };
    expect(mentioned('- `tools/pipeline/` — our pipeline\n')).toEqual([]);
    expect(mentioned('- `scripts/pipeline/` — our pipeline\n')).toEqual([{ id: 'STORE-102', files: ['tests/tool.test.ts'] }]);
  });

  it.each([
    ['spec-id-renumbered.mjs', []],
    ['spec-coverage.mjs', ['--quiet']],
    ['spec-coverage.mjs', ['--json']],
    ['spec-coverage.mjs', []],
  ])("%s %j reads a missing declaration as Kanon's default, no pipeline code, and says so (plan 0005 §5.2)", (script, args) => {
    const missing = run(script, adopter(null), ...args);
    const none = run(script, adopter(ESCALATIONS('')), ...args);
    expect(missing.stderr).toMatch(/: docs\/qa\/escalation-paths\.md doesn't exist, so Kanon's default applies: only the pipeline's own paths escalate.*K-LAYOUT-8/);
    expect(none.stderr, 'a declared file takes no default').not.toMatch(/Kanon's default applies/);
    // Then it reads on exactly as a file that declares no pipeline code would.
    expect(missing.status).toBe(none.status);
    expect(missing.stdout).toBe(none.stdout);
    expect(missing.stderr.replace(/^.*Kanon's default applies.*\n/m, '')).toBe(none.stderr);
  });

  it('spec-coverage reads a JavaScript test by the declared trees, or by its suffix when none is declared (kanon#20)', () => {
    const locks = (stack: string | null) => {
      const dir = adopter(ESCALATIONS(''), stack);
      mkdirSync(join(dir, 'e2e'), { recursive: true });
      writeFileSync(join(dir, 'e2e/checkout.ts'), "test('[STORE-103] checks out', () => {});\n");
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/cart.spec.ts'), "it('[STORE-102] adds to the cart', () => {});\n");
      // A spec's back-link is a claim only when it names a test file, by the same trees.
      writeFileSync(join(dir, 'docs/qa/specs/storefront.md'), SPEC.replace('one\n', 'one (Confirmed by `e2e/smoke.ts`)\n'));
      const r = run('spec-coverage.mjs', dir, '--json');
      expect(r.status, r.stderr).toBe(0);
      const { seedWithTest, claimsMissingFile } = JSON.parse(r.stdout);
      return { locked: seedWithTest, claims: claimsMissingFile.map((c: { claim: string }) => c.claim) };
    };
    // Declared: every file in `e2e/` is a test, suffix or not, and a suffixed file outside every tree isn't.
    expect(locks(`${STACK}- \`e2e/\` \`playwright\` — tests: the browser suite\n`)).toEqual({ locked: ['STORE-103'], claims: ['e2e/smoke.ts'] });
    // Undeclared: only the suffix makes a test.
    expect(locks(null)).toEqual({ locked: ['STORE-102'], claims: [] });
  });

  it("spec-coverage names the stack document's default when it declares no `## Code areas`, and fails by name on a malformed one (kanon#20)", () => {
    const missing = run('spec-coverage.mjs', adopter(ESCALATIONS(''), null), '--json');
    expect(missing.stderr).toMatch(/^spec-coverage: docs\/qa\/stack\.md declares no `## Code areas`, so Kanon's default applies: .*a `\*\.test\.\*` or `\*\.spec\.\*` file that no runner runs \(K-LAYOUT-17\)$/m);
    const malformed = run('spec-coverage.mjs', adopter(ESCALATIONS(''), `${STACK}- \`tests/\` \`jest\` — tests: x\n`), '--json');
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toMatch(/^spec-coverage: docs\/qa\/stack\.md:\d+: `jest` isn't a runner/m);
  });

  it.each([
    ['spec-id-renumbered.mjs', []],
    ['spec-coverage.mjs', ['--quiet']],
  ])('%s fails by name when the declaration is malformed', (script, args) => {
    const r = run(script, adopter(ESCALATIONS('  - `tools/pipeline/` — indented\n')), ...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/qa/escalation-paths.md:');
    expect(r.stdout + r.stderr).not.toContain('tests/tool.test.ts');
  });
});

describe('announce-deploy names no environment of its own (kanon#54)', () => {
  it('exits 1 by name when STAGE is unset, rather than announcing to a default', () => {
    const env = { PATH: process.env.PATH ?? '', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', VERSION: '1.0.0', DRY_RUN: '1' };
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/announce-deploy.mjs')], { cwd: tmpdir(), env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Missing required env:.*\bSTAGE\b/);
  });
});
