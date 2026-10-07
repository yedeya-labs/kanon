import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { SPAWNS } from './helpers/spawns.js';

/**
 * The `kanon` CLI as an adopter installs it: `npx --yes --package github:yedeya-labs/kanon#vX.Y.Z
 * kanon …` (README, docs/apps.md). npm packs the clone and extracts it with pacote, which drops
 * every symbolic link, so a file the CLI imports must be a real file. PR #600 made the CLI load
 * the telemetry scrub through `cli/metrics.mjs` → `schema.mjs`, and the scrub's sibling was a link:
 * every `kanon` command failed with ERR_MODULE_NOT_FOUND, and no test saw it, because every test
 * runs from the git checkout, where links resolve.
 */

const PKG = JSON.parse(readFileSync('package.json', 'utf8')) as { bin: Record<string, string> };
const ENTRIES = Object.values(PKG.bin).map((p) => normalize(p));

/** Relative specifiers in a module's static `import … from` and `export … from` statements. */
const IMPORT = /^\s*(?:import|export)\s[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|^\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/gm;

/** Every file the CLI's entry points reach by static relative imports, from the repository root. */
function importGraph(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) queue.push(normalize(join(dirname(file), m[1] ?? m[2]!)));
  }
  return [...seen].sort();
}

describe("the CLI's import graph holds no symbolic link (PR #600)", () => {
  const graph = importGraph(ENTRIES);

  it('walks from every bin entry into the library, the schema and the scrub', () => {
    expect(ENTRIES).toContain('cli/kanon.mjs');
    for (const f of ['cli/metrics.mjs', 'actions/agent-telemetry/schema.mjs', 'actions/agent-telemetry/scrub.mjs',
      'actions/agent-telemetry/public-words.mjs']) expect(graph, f).toContain(f);
  });

  it('every file in it exists and is a real file, so npm keeps it when it installs the CLI from GitHub', () => {
    const missing = graph.filter((f) => !existsSync(f));
    const links = graph.filter((f) => existsSync(f) && lstatSync(f).isSymbolicLink());
    expect(missing).toEqual([]);
    expect(links).toEqual([]);
  });
});

describe('the CLI, packed and installed as npm installs it, runs', SPAWNS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-cli-install-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('npm pack, then npm install of the tarball, then `kanon --help`', () => {
    // `npm pack` applies the same filter pacote applies to a GitHub install: no links.
    const tgz = execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', dir], { encoding: 'utf8', timeout: 25_000 }).trim().split('\n').pop()!;
    const app = join(dir, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), '{"private":true}');
    execFileSync('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--silent', join(dir, tgz)], { cwd: app, encoding: 'utf8', timeout: 25_000 });
    const out = execFileSync(join(app, 'node_modules', '.bin', 'kanon'), ['--help'], { cwd: app, encoding: 'utf8', timeout: 25_000 });
    expect(out).toContain('Usage: kanon <command>');
  });
});
