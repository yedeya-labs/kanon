import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Put a bash stub on PATH WITHOUT creating a new executable file (RA-2337, RA-1160).
 *
 * WHY. On macOS the FIRST exec of a newly created executable is scanned by the OS
 * before it runs, and every later exec of the same file is free. Measured on a dev Mac
 * (2026-09-24): a two-line `#!/usr/bin/env bash` stub cost 0.16–0.8s on its first exec
 * idle and up to 2.15s with other suites running, then 0.00s on every exec after. The
 * scan is serialised system-wide, so under load it stalls many vitest workers AT ONCE:
 * one loaded `npm test` showed five unrelated stub-writing suites each peak at ~10.7s
 * in the same run. Linux has no such scan, which is why CI never saw it.
 *
 * The suites that execute workflow step bodies wrote a fresh `gh`/`npx`/`aws` stub PER
 * TEST, so they paid that scan once per assertion — `agent-review-filter` alone spent
 * ~44s of summed test time doing it, idle. That, not the `bash`/`git` spawns RA-1160
 * suspected, is where the time went: `bash file` of a new NON-executable file is free.
 *
 * HOW. Every stub is a symlink to ONE shared shim, which runs the per-test body with
 * `bash` rather than exec'ing it. The shim is created once per machine (atomically, so
 * concurrent workers cannot see a half-written one), so the OS scans it once; exec
 * through a symlink or hard link to an already-scanned file is free (measured: 0.01s).
 *
 * Semantics match a real `#!/usr/bin/env bash` stub: arguments, stdin, exit status and
 * cwd pass straight through `exec`. The one difference is `$0` inside the body, which is
 * `<name>.stub`; no stub in this repo reads it.
 */
const SHIM_BODY = '#!/usr/bin/env bash\nexec bash "$0.stub" "$@"\n';
// Versioned by name: a shim whose body changes gets a new file, never an in-place edit
// that a concurrent worker could exec half-written.
const SHIM = join(tmpdir(), 'kanon-test-stub-shim', 'bash-v1');

const shim = (): string => {
  if (!existsSync(SHIM) || readFileSync(SHIM, 'utf8') !== SHIM_BODY) {
    mkdirSync(join(SHIM, '..'), { recursive: true });
    const tmp = `${SHIM}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, SHIM_BODY, { mode: 0o755 });
    renameSync(tmp, SHIM);
  }
  return SHIM;
};

/**
 * Write a bash stub at `path` (e.g. `join(dir, 'gh')`), replacing any earlier one. The
 * body must be a `#!/usr/bin/env bash` script — the shim runs it with bash, so a stub
 * written for another interpreter would silently run under the wrong one.
 */
export const writeStub = (path: string, body: string): void => {
  if (!body.startsWith('#!/usr/bin/env bash\n')) {
    throw new Error(`writeStub(${path}): the body must start with "#!/usr/bin/env bash" — the shim runs it with bash`);
  }
  writeFileSync(`${path}.stub`, body);
  rmSync(path, { force: true });
  symlinkSync(shim(), path);
};

/**
 * Create the shim and exec it once, so the OS scan happens here and not in fifteen
 * workers at once. Run as the unit project's `globalSetup` (vitest.config.ts): without
 * it, the first run on a machine — or after the temp dir is cleared — has every
 * stub-writing suite race to create the shim, and each racer's file is scanned.
 */
export const setup = (): void => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-shim-warm-'));
  try {
    writeStub(join(dir, 'warm'), '#!/usr/bin/env bash\nexit 0\n');
    execFileSync(join(dir, 'warm'), { stdio: 'ignore' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
