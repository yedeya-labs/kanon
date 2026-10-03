// lane-check's reader for the two declaration files the guards and the Merger read
// (kanon#153): `docs/qa/escalation-paths.md` (`K-LAYOUT-8`) and `docs/qa/exemptions.md`
// (`K-LAYOUT-15`).
//
// Each is read with the library's own reader, from this Kanon tree (the version the adopter
// pinned), so a file this passes is one the readers accept, and a malformed one fails the
// adopter's CI on the pull request that broke it, by name, rather than only when a guard or
// the Merger next reads it.
//
//   node declarations.mjs <escalation-paths|exemptions>
//
// Run from the root of the adopter's checkout. Exits 0 when the file parses, and 1 with the
// reader's own message on standard error when it doesn't. lane-check calls it only for a file
// that exists: a missing file is failed by the guard or lane that reads it (K-LAYOUT-8,
// K-LAYOUT-15), and a repository that runs none of them has no reader to fail.

import { readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { readExemptions } from '../../scripts/lib/exemptions.mjs';

/** @type {Record<string, (root: string) => unknown>} */
const READERS = { 'escalation-paths': readEscalationFile, exemptions: readExemptions };

const which = process.argv[2] ?? '';
const read = READERS[which];
if (!read) {
  process.stderr.write(`usage: declarations.mjs <${Object.keys(READERS).join('|')}>\n`);
  process.exit(2);
}
try {
  read(process.cwd());
} catch (e) {
  process.stderr.write(`${/** @type {Error} */ (e).message}\n`);
  process.exit(1);
}
