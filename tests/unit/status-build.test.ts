import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CLOSURE_PATH, readClosure, stage } from '../../infra/status/build.mjs';
import { codeFilesUnder, importClosure, moduleLoads } from './helpers/import-closure.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * Project #1327, Issue I: the build hook's script, `infra/status/build.mjs`, which the operator's
 * build job runs at the pinned Kanon with no credential. The function imports across the tree
 * (the status core, the deciders, the telemetry function's signer), so it copies the function's
 * import closure, with the repository's layout kept, beside the template.
 *
 * WHAT IT COPIES IS WHAT IS ESCALATED. The list it copies, `infra/status/closure.json`, is the
 * walk `tests/unit/hosted-function-closure.test.ts` holds to the `always` escalation paths, from
 * the function's directory. The walk needs TypeScript's parser, a dev dependency that the pinned
 * tree in an action's cache doesn't install, and the build may use only Node's built-ins
 * (`K-SELF-8`), so the walk stays in the test helper and its answer is kept in the file, held
 * equal here. When an import changes, write it again with
 * `KANON_WRITE_STATUS_CLOSURE=1 npx vitest run tests/unit/status-build.test.ts`.
 */

const FUNCTION = importClosure(codeFilesUnder('infra/status/function'));
if (process.env.KANON_WRITE_STATUS_CLOSURE === '1') {
  const about = JSON.parse(readFileSync(CLOSURE_PATH, 'utf8')).about;
  writeFileSync(CLOSURE_PATH, `${JSON.stringify({ about, files: FUNCTION.modules }, null, 2)}\n`);
}

const walk = (dir: string): string[] => {
  const out: string[] = [];
  const go = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) go(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  go(dir);
  return out.sort();
};

/** A tree of `files` (path to text) in a fresh directory. */
const treeWith = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'status-build-root-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const TEMPLATE = { 'infra/status/template.yaml': 'Resources: {}\n' };

describe("the function's closure, as the build copies it", () => {
  it('is the walk the escalation test holds, from the function directory', () => {
    expect(FUNCTION.problems).toEqual([]);
    expect(readClosure(), 'the function links another module: write infra/status/closure.json again (KANON_WRITE_STATUS_CLOSURE=1)').toEqual(FUNCTION.modules);
    expect(FUNCTION.modules).toContain('infra/status/function/handler.mjs');
  });

  it("imports nothing but Node's built-ins (K-SELF-8)", () => {
    const bare = FUNCTION.modules.filter((m) => /\.m?js$/.test(m)).flatMap((m) =>
      moduleLoads(m, readFileSync(m, 'utf8')).specifiers.filter((s) => !/^\.{1,2}\//.test(s) && !s.startsWith('node:')).map((s) => `${m}: ${s}`));
    expect(bare).toEqual([]);
  });
});

describe('the build', SPAWNS, () => {
  it('stages the template and exactly the closure, a tree that loads on its own and answers', () => {
    const out = mkdtempSync(join(tmpdir(), 'status-build-out-'));
    const printed = execFileSync(process.execPath, ['infra/status/build.mjs', '--output', out], { encoding: 'utf8' });
    expect(printed).toBe(`kanon-status: staged the template and ${FUNCTION.modules.length} files of the function\n`);
    expect(readFileSync(join(out, 'template.yaml'), 'utf8')).toBe(readFileSync('infra/status/template.yaml', 'utf8'));
    expect(walk(out)).toEqual(['template.yaml', ...FUNCTION.modules.map((m) => `function/${m}`)].sort());

    // Somewhere no node_modules is above it, the staged handler answers as Lambda would call it.
    const away = mkdtempSync(join(tmpdir(), 'status-build-away-'));
    cpSync(join(out, 'function'), away, { recursive: true });
    const event = { rawPath: '/mcp', headers: {}, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', requestContext: { http: { method: 'POST' }, domainName: 'abc.lambda-url.eu-central-1.on.aws' } };
    const script = `const { handler } = await import(${JSON.stringify(join(away, 'infra/status/function/handler.mjs'))});
process.stdout.write(JSON.stringify(await handler(${JSON.stringify(event)})));`;
    // With no environment it is unconfigured, so it answers 500 before any AWS call: the whole
    // closure loaded, and its two log lines and the reply are all it printed.
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: away, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH } });
    expect(r.stderr).toBe('');
    const lines = r.stdout.trim().split('\n');
    expect(lines.slice(0, 2).map((l) => JSON.parse(l))).toEqual([{ startup: 'client_secret', code: 'Unconfigured' }, expect.objectContaining({ route: '/mcp', outcome: 'error' })]);
    expect(JSON.parse(lines[2]!)).toMatchObject({ statusCode: 500, body: '{"error":"server_error"}' });
  });

  it('refuses a path outside the tree, and a file that is not there', () => {
    const root = treeWith({ ...TEMPLATE, 'infra/status/function/handler.mjs': 'export const handler = () => null;\n' });
    const out = mkdtempSync(join(tmpdir(), 'status-build-out-'));
    for (const [files, message] of [
      [['../outside.mjs'], "'../outside.mjs' isn't a path inside Kanon's tree"],
      [['/etc/passwd'], "'/etc/passwd' isn't a path inside Kanon's tree"],
      [['infra/status/function/./handler.mjs'], "'infra/status/function/./handler.mjs' isn't a path inside Kanon's tree"],
      [['infra/status/function/handler.mjs', 'scripts/gone.mjs'], "'scripts/gone.mjs' isn't a file in Kanon's tree"],
    ] as const) {
      expect(() => stage({ root, files: [...files], output: out }), message).toThrow(message);
    }
  });

  it("refuses a staged tree that doesn't load on its own: a missing module, or a package", () => {
    for (const [line, message] of [
      ["import './gone.mjs';", /the staged function doesn't load: .*gone\.mjs/s],
      ["import 'yaml';", /the staged function doesn't load: .*'yaml'/s],
    ] as const) {
      const root = treeWith({ ...TEMPLATE, 'infra/status/function/handler.mjs': `${line}\nexport const handler = () => null;\n` });
      const out = mkdtempSync(join(tmpdir(), 'status-build-out-'));
      expect(() => stage({ root, files: ['infra/status/function/handler.mjs'], output: out }), line).toThrow(message);
      expect(readdirSync(out), line).toEqual([]);
    }
  });

  it('refuses to run without an output directory', () => {
    const r = spawnSync(process.execPath, ['infra/status/build.mjs'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--output/);
  });
});
