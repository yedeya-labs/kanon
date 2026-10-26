#!/usr/bin/env node
// The hosted status server's build (project #1327, Issue I), which the operator's build hook runs
// at the pinned Kanon, `node "$KANON/infra/status/build.mjs" --output <dir>`, with no credential.
//
// It fills `<dir>` with what every deploy of `kanon-status` deploys:
// - `template.yaml`, this directory's, as it is;
// - `function/`, the function's import closure, each file at its path in Kanon's tree, which is
//   where the template's `Code` and `Handler` point. The function imports across the tree (the
//   status core, the deciders the lanes run, the telemetry function's signer), so a link inside
//   the function's directory, as the telemetry store's build uses, would break their own imports.
//
// WHAT IT COPIES IS WHAT IS ESCALATED. The closure is the list in `closure.json`, which
// `tests/unit/status-build.test.ts` holds equal to the walk `tests/unit/hosted-function-closure.test.ts`
// holds to the `always` escalation paths. The walk needs TypeScript's parser, which the pinned
// tree in an action's cache doesn't install, and this script uses Node's built-ins alone
// (`K-SELF-8`), so it reads the walk's answer.
//
// IT REFUSES A TREE THAT DOESN'T LOAD ON ITS OWN. It stages into a fresh temporary directory, with
// no `node_modules` above it, and imports the staged handler in a child process with an empty
// environment. A missing file, or an import of a package, fails there, before the output is
// written and before production deploys.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** Kanon's tree, the one this script is in. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The function's import closure, repository-relative, which the build copies. */
export const CLOSURE_PATH = 'infra/status/closure.json';
/** The template, beside which the function is staged. */
export const TEMPLATE_PATH = 'infra/status/template.yaml';
/** The function's entry point, as the template's `Handler` names it. */
export const HANDLER_PATH = 'infra/status/function/handler.mjs';

/** The closure's files, from `closure.json`. @param {string} [root] @returns {string[]} */
export const readClosure = (root = ROOT) => JSON.parse(readFileSync(join(root, CLOSURE_PATH), 'utf8')).files;

/** A plain repository-relative path: no `.` or `..` segment, not absolute, no backslash. */
const PLAIN = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/;

/**
 * Stage the template and `files` from `root` into `output`, once they load on their own.
 * @param {{ root?: string, files?: string[], output: string }} args
 * @returns {number} the function's files staged
 */
export function stage({ root = ROOT, files = readClosure(root), output }) {
  for (const f of files) {
    if (!PLAIN.test(f)) throw new Error(`'${f}' isn't a path inside Kanon's tree`);
  }
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`'${f}' isn't a file in Kanon's tree`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'kanon-status-build-'));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(scratch, 'function', f)), { recursive: true });
      cpSync(join(root, f), join(scratch, 'function', f));
    }
    cpSync(join(root, TEMPLATE_PATH), join(scratch, 'template.yaml'));
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv.at(-1));', pathToFileURL(join(scratch, 'function', HANDLER_PATH)).href], {
        cwd: scratch, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 60_000,
      });
    } catch (e) {
      const stderr = String(/** @type {any} */ (e)?.stderr ?? '').replaceAll(scratch, '<staged>');
      throw new Error(`the staged function doesn't load: ${stderr.trim() || String(e)}`, { cause: e });
    }
    mkdirSync(output, { recursive: true });
    cpSync(scratch, output, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return files.length;
}

if (isCliEntry(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  if (!values.output) {
    process.stderr.write('usage: build.mjs --output <dir>\n');
    process.exit(2);
  }
  try {
    const n = stage({ output: resolve(values.output) });
    process.stdout.write(`kanon-status: staged the template and ${n} files of the function\n`);
  } catch (e) {
    process.stderr.write(`kanon-status: the build failed: ${/** @type {Error} */ (e).message}\n`);
    process.exit(1);
  }
}
