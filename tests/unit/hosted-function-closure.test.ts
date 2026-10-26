import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { codeFilesUnder, importClosure, moduleLoads, treeOf, type Closure } from './helpers/import-closure.js';

/**
 * kanon#1345: every local module a hosted function links, directly or through another, matches
 * an `always` entry in `docs/qa/escalation-paths.md`.
 *
 * A change to a module a function links changes the deployed function's code. It reaches the
 * deploy through the release pull request and the Owner's deploy dispatch, both human gates, but
 * neither asks the Owner to read it, so the Merger must not merge it: the Owner does (decided
 * 2026-10-26, following the telemetry functions' precedent, `holds-key.mjs` and
 * `scripts/metrics/`). The hosted status server's handler (`infra/status/`, project #1327) calls
 * the status core, and the core calls the deciders the lanes run (the reconciler, review
 * recovery, workflow health, the brief guard and what they import), so its closure reaches well
 * outside `scripts/status/`. This walks it from every code file under each function's directory
 * (`tests/unit/helpers/import-closure.ts` says what it follows), so a new import, static or lazy,
 * that reaches a green-zone module turns this red before it merges.
 *
 * Only `always` entries count: Kanon's adoption record declares its production promotion
 * human-gated, under which an entry without the marker stops escalating (`K-MERGE-4`).
 */
const FUNCTIONS = ['infra/status', 'infra/telemetry/function'] as const;
const ALWAYS = readEscalationFile().paths.filter(({ always }) => always).map(({ pattern }) => pattern);
const unescalated = (closure: Closure) => closure.modules.filter((m) => !ALWAYS.some((re) => re.test(m)));
const STATUS_ENTRIES = codeFilesUnder('infra/status');
const STATUS = importClosure(STATUS_ENTRIES);
const withLine = (file: string, line: string) => treeOf({ [file]: `${line}\n${readFileSync(file, 'utf8')}` });

describe.each(FUNCTIONS)('the modules %s links', (dir) => {
  const closure = importClosure(codeFilesUnder(dir));

  it('are all followed to a file', () => {
    expect(closure.problems).toEqual([]);
  });

  it('each match an `always` escalation path', () => {
    expect(unescalated(closure), `linked into ${dir}, so a change to it changes deployed code: give it an \`always\` entry in docs/qa/escalation-paths.md (#1345)`).toEqual([]);
  });
});

describe("the status server's closure", () => {
  it('reaches the deciders the status core calls, through the status core', () => {
    for (const m of ['scripts/status/views.mjs', 'scripts/lead-reconcile.mjs', 'scripts/review-recovery.mjs', 'scripts/workflow-health.mjs', 'scripts/brief-guard.mjs', 'scripts/lib/lane-caller.mjs', 'scripts/lib/waivers.mjs']) {
      expect(STATUS.modules, m).toContain(m);
    }
  });

  // `views.mjs` loads the readiness and the needs-owner views lazily; PR #1424 imports them
  // statically. Either way they are linked.
  it('follows a literal dynamic import()', () => {
    const LAZY = 'scripts/lib/cache-ttl.mjs';
    const tree = withLine('scripts/status/views.mjs', "const lazy = () => import('../lib/cache-ttl.mjs');");
    expect(importClosure(STATUS_ENTRIES, { tree }).modules).toContain(LAZY);
    expect(importClosure(STATUS_ENTRIES, { tree, dynamicImports: false }).modules).not.toContain(LAZY);
  });

  it("follows a worker's new URL(…, import.meta.url) script", () => {
    expect(STATUS.modules).toContain('scripts/status/promotion-worker.mjs');
  });

  // kanon#1345: lane-caller read the waivers from cli/doctor.mjs, which linked doctor and init,
  // thousands of lines the lanes change weekly, into the server. They read scripts/lib/waivers.mjs.
  it("doesn't link doctor or init", () => {
    for (const m of ['cli/doctor.mjs', 'cli/init.mjs']) expect(STATUS.modules, m).not.toContain(m);
    const linked = importClosure(STATUS_ENTRIES, { tree: withLine('scripts/lib/lane-caller.mjs', "import { kanonCall } from '../../cli/doctor.mjs';") });
    expect(linked.modules).toContain('cli/doctor.mjs');
    expect(unescalated(linked)).toContain('cli/doctor.mjs');
  });

  it('fails on a new import of a green-zone module into a module it links', () => {
    const GREEN = 'scripts/lib/cache-ttl.mjs';
    expect(ALWAYS.some((re) => re.test(GREEN)), `${GREEN} must be green for this to mean anything`).toBe(false);
    const widened = importClosure(STATUS_ENTRIES, { tree: withLine('scripts/review-recovery.mjs', "import './lib/cache-ttl.mjs';") });
    expect(unescalated(widened)).toContain(GREEN);
  });

  it('names what it cannot follow, so nothing escapes it', () => {
    const at = (line: string) => importClosure(STATUS_ENTRIES, { tree: withLine('scripts/status/views.mjs', line) }).problems;
    expect(at('const m = await import(`./${name}.mjs`);')).toEqual(['scripts/status/views.mjs:1: a dynamic import() whose specifier isn\'t a literal']);
    expect(at('const m = require(name);')).toEqual(['scripts/status/views.mjs:1: a require() whose specifier isn\'t a literal']);
    expect(at('new Worker(path);')).toEqual(["scripts/status/views.mjs:1: a new Worker() whose script isn't a literal new URL(…, import.meta.url)"]);
    expect(at('readFileSync(new URL(name, import.meta.url));')).toEqual(["scripts/status/views.mjs:1: a new URL(…, import.meta.url) whose specifier isn't a literal"]);
    expect(at("import './missing.mjs';")).toEqual(["scripts/status/views.mjs: './missing.mjs' names no file in this tree"]);
  });
});

describe('moduleLoads', () => {
  it('reads code, never comments, and skips built-ins and packages', () => {
    const text = [
      "import { a } from './a.mjs';",
      "import './side.mjs';",
      "export { b } from '../b.mjs';",
      "export * from './c.mjs';",
      "const d = await import('./d.mjs');",
      'const e = await import(`./e.mjs`);',
      "const f = new URL('./f.json', import.meta.url);",
      "import { readFileSync } from 'node:fs';",
      "import { parse } from 'yaml';",
      "/** @param {import('./typed.mjs').T} t */",
      "// import { x } from './commented.mjs';",
      "const s = './just-a-string.mjs';",
    ].join('\n');
    expect(moduleLoads('x.mjs', text)).toEqual({ specifiers: ['./a.mjs', './side.mjs', '../b.mjs', './c.mjs', './d.mjs', './e.mjs', './f.json', 'node:fs', 'yaml'], unreadable: [] });
    expect(moduleLoads('x.mjs', text, { dynamicImports: false }).specifiers).not.toContain('./d.mjs');
  });
});
