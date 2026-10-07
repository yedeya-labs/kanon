/**
 * The time a case may take when it starts processes: `git`, `bash`, `node`, or a stub on PATH
 * (#436).
 *
 * Vitest's 5 s default fits a case that runs in-process, and it stays the default, so a case
 * that hangs or slows down in-process still fails fast. A case that starts processes pays for
 * each one, and what it pays depends on the machine's load, not on the code under test. On a
 * 16-core Mac, alone, such cases take 0.3–4 s. With a second full run and other work beside it
 * (load about 100), the same cases took two to four times as long, and single ones up to eleven
 * times: 0.65 s became 7.7 s. Several agents running the suite at once reach a load of 200.
 *
 * So a block whose cases start processes takes this budget, about ten times what its slowest
 * case takes alone: `describe(name, SPAWNS, ...)`, or `vi.setConfig({ testTimeout:
 * SPAWNS.timeout })` for a file whose every case does. A case still fails on a real hang, at
 * this budget; a child process that can hang gets a `timeout` of its own, since a synchronous
 * spawn blocks the event loop that vitest's own timer needs.
 */
export const SPAWNS = { timeout: 30_000 } as const;
