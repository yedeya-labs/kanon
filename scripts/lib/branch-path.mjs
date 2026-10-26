// A branch name as a GitHub REST path's tail (kanon#1392, kanon#1432).
//
// WHY. Git allows a `#` and a `%` in a branch name. Sent unencoded in a path, a `#` ends the path,
// as the start of the URL's fragment, and a `%` is decoded into another name, so the request reads
// or moves another ref. Each `/`-separated segment is percent-encoded and the slashes kept, which
// is how GitHub reads a ref path (`git/ref/heads/<name>`, `compare/<base>...<head>`).
//
// One encoder for every caller: the verified-commit helper imports it, and a lane's shell runs it.
//
// Usage: node scripts/lib/branch-path.mjs <branch>
// Prints the encoded path with no newline, for `$(...)`; exits 2 without exactly one non-empty name.

import { isCliEntry } from './cli-entry.mjs';

/**
 * `branch` as a ref path's tail, each `/`-separated segment percent-encoded, so GitHub receives the
 * whole name: unencoded, a `#` would end the path, as the start of the URL's fragment, and a `%`
 * would be decoded into another name.
 */
export const branchPath = (/** @type {string} */ branch) => branch.split('/').map(encodeURIComponent).join('/');

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    process.stderr.write('usage: node scripts/lib/branch-path.mjs <branch>\n');
    process.exit(2);
  }
  process.stdout.write(branchPath(args[0]));
}
