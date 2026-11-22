import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionFiles } from './helpers/actions.js';
import { codeFilesUnder, importClosure, moduleLoads, treeOf, type Tree } from './helpers/import-closure.js';

/**
 * `K-SELF-8` (kanon#1771): a script that runs in a job with no install step uses only the
 * runtime's built-ins. The lanes run Kanon's library from the action cache as
 * `node "$KANON/scripts/<name>.mjs"`, and that copy has no `node_modules`: the Overseer's job,
 * the reconciler's and most lanes' admission jobs install nothing. The `kanon` command under
 * `cli/` uses Node's built-ins only too, so nothing is installed to run it (docs/apps.md). A bare
 * import there passes every test here, where `npm ci` has put the devDependencies on disk, and
 * fails only on an adopter's runner.
 *
 * So this walks every code file under `scripts/` and `cli/`, and everything each one links,
 * directly or through another, static or lazy (`tests/unit/helpers/import-closure.ts` says what
 * it follows), and holds every load in that closure to a `node:` built-in or a relative path. A
 * file a script names by `new URL(…, import.meta.url)` only to read it, or a directory, is not a
 * load, so the walk runs with `fileUrls: false`; a worker's script is one, and is followed.
 * The blocks under `actions/` are held the same way in `agent-lane-blocks.test.ts`.
 * `.github/scripts/` is run only by Kanon's own workflows, never from `$KANON`, so it is not walked.
 */
const ENTRIES = [...codeFilesUnder('scripts'), ...codeFilesUnder('cli')];

/** Each load in the entries' closure that is neither a `node:` built-in nor relative, and each load the walk could not read. */
function outsideBuiltIns(tree: Tree = treeOf()): string[] {
  const { modules, problems } = importClosure(ENTRIES, { tree, fileUrls: false });
  const bare = modules.filter((m) => /\.(?:mjs|cjs|js)$/.test(m)).flatMap((m) =>
    moduleLoads(m, tree.text(m), { fileUrls: false }).specifiers
      .filter((s) => !s.startsWith('node:') && !/^\.{1,2}\//.test(s))
      .map((s) => `${m}: ${s}`));
  return [...bare, ...problems];
}

/** A tree with `line` put at the top of `file`. */
const withLine = (file: string, line: string) => treeOf({ [file]: `${line}\n${readFileSync(file, 'utf8')}` });

/** Every `$KANON/scripts/…` or `$KANON/cli/…` a workflow or an action runs. */
const KANON_RUNS = [
  ...readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f)).map((f) => join('.github/workflows', f)),
  ...actionFiles(),
].flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\$\{?KANON\}?\/((?:scripts|cli)\/[\w./-]+\.mjs)/g)].map((m) => m[1]!));

describe('K-SELF-8: the scripts a no-install job runs from $KANON', () => {
  it('walks every script a workflow or an action runs through $KANON, so the check below is not vacuous', () => {
    expect(KANON_RUNS.length).toBeGreaterThan(20);
    expect(KANON_RUNS).toContain('scripts/lane-gate.mjs');
    expect(KANON_RUNS).toContain('scripts/overseer-telemetry.mjs');
    expect([...new Set(KANON_RUNS)].filter((f) => !ENTRIES.includes(f))).toEqual([]);
  });

  it('import nothing but node: built-ins and their own files, directly or through another', () => {
    expect(outsideBuiltIns()).toEqual([]);
  });

  // The guard's own mutation checks: each bare load below, put into the real tree, turns it red.
  it.each([
    ['a static import, in a script the Overseer runs', 'scripts/overseer-telemetry.mjs', "import { parse } from 'yaml';", 'scripts/overseer-telemetry.mjs: yaml'],
    ['a re-export, in the `kanon` command', 'cli/kanon.mjs', "export { parse } from 'yaml';", 'cli/kanon.mjs: yaml'],
    ['a literal dynamic import', 'scripts/lane-gate.mjs', "await import('yaml');", 'scripts/lane-gate.mjs: yaml'],
    ['a bare side-effect import', 'scripts/lane-gate.mjs', "import 'vitest';", 'scripts/lane-gate.mjs: vitest'],
  ])('fails on %s', (_name, file, line, found) => {
    expect(outsideBuiltIns(withLine(file, line))).toContain(found);
  });

  // A module reached only through another is held too: the scripts link modules under
  // `actions/` and `infra/`, and the status view's worker, which Node loads as a module.
  it.each([
    'actions/qa-store/qa-store.mjs',
    'infra/telemetry/function/sigv4.mjs',
    'scripts/status/promotion-worker.mjs',
  ])('follows the scripts\' imports to %s, and fails on a bare import there', (target) => {
    expect(importClosure(ENTRIES, { fileUrls: false }).modules).toContain(target);
    expect(outsideBuiltIns(withLine(target, "import { parse } from 'yaml';"))).toContain(`${target}: yaml`);
  });

  it('fails on a load it cannot read, rather than skipping it', () => {
    expect(outsideBuiltIns(withLine('scripts/lane-gate.mjs', 'const m = "yaml"; await import(m);')).join('\n'))
      .toMatch(/scripts\/lane-gate\.mjs:1: a dynamic import\(\) whose specifier isn't a literal/);
  });
});
