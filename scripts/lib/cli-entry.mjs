// "Am I the CLI?" — the one entry-point check every Kanon script uses (kanon#191).
//
// WHY ONE HELPER. Scripts decided this four different ways, and three were wrong in a way
// that does not error: run through a symlinked path (a `node_modules/.bin` link, a
// symlinked checkout, macOS's `/tmp` → `/private/tmp`), a script that compares against
// the raw `process.argv[1]` sees a different path from its own `import.meta.url` and
// exits 0 having done nothing. A `file://${argv[1]}` template also breaks on any path
// that URL-encodes (a space, `#`, `%`, non-ASCII), and `argv[1].endsWith(name)` is true
// for ANY file of that name, including a different script that imports this one.
//
// Node resolves the main module through `realpath` before it builds `import.meta.url`,
// so the comparison that agrees with it is `pathToFileURL(realpathSync(argv[1]))`.
//
// THE CALLER'S URL, NOT THIS FILE'S. The helper does the `realpathSync` itself, so it
// must be handed the caller's `import.meta.url`; comparing against its own would be
// true for no script at all.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Whether the module whose `import.meta.url` is `moduleUrl` is the process's entry point.
 *
 * @param {string} moduleUrl the CALLER's `import.meta.url`
 * @param {string | undefined} [argv1] defaults to `process.argv[1]`; undefined when the
 *   module is imported by a test runner, a REPL or a worker, which is never the CLI
 * @returns {boolean}
 */
export function isCliEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  // `try`, because `realpathSync` THROWS on a path that does not exist — an import with
  // an unrelated argv[1] must not crash on the entry-point guard.
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
