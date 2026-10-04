// lane-check's reader for the declaration files the guards, the Merger and the reconciler read
// (kanon#153): `docs/qa/escalation-paths.md` (`K-LAYOUT-8`), `docs/qa/exemptions.md`
// (`K-LAYOUT-15`), and the reference environment's deploy in the adoption record,
// `docs/qa/adoption.md` (`K-LAYOUT-10`, plan 0004 P6), with the weekly digest's audience beside
// it (kanon#218), and the code areas in the stack document, `docs/qa/stack.md`'s `## Code areas`
// (`K-LAYOUT-17`, kanon#54), which the guards and the code-audit lane read.
//
// Each is read with the library's own reader, from this Kanon tree (the version the adopter
// pinned), so a file this passes is one the readers accept, and a malformed one fails the
// adopter's CI on the pull request that broke it, by name, rather than only when a guard or
// the Merger next reads it.
//
//   node declarations.mjs <escalation-paths|exemptions|adoption|stack>
//
// Run from the root of the adopter's checkout. Exits 0 when the file parses, and 1 with the
// reader's own message on standard error when it doesn't. lane-check calls it only for a file
// that exists: a missing file is failed by the guard or lane that reads it (K-LAYOUT-8,
// K-LAYOUT-15), and a repository that runs none of them has no reader to fail. An adoption
// record that declares no reference environment passes here: the reconciler fails on it, by
// name, when a project reaches its deploy phase (K-PROJ-11).

import { readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { readExemptions } from '../../scripts/lib/exemptions.mjs';
import { readDigestAudience } from '../../scripts/lib/digest-audience.mjs';
import { readReferenceDeploy } from '../../scripts/lib/reference-deploy.mjs';
import { readCodeAreas } from '../../scripts/lib/code-areas.mjs';

/** @type {Record<string, (root: string) => unknown>} */
const READERS = {
  'escalation-paths': readEscalationFile,
  exemptions: readExemptions,
  // Both of the record's declarations, so a malformed one of either fails by name.
  adoption: (root) => [readReferenceDeploy(root), readDigestAudience(root)],
  // Only `## Code areas`: the four required sections are checked by lane-check itself, and only
  // when a called lane reads the document. A stack document without the section declares none.
  stack: readCodeAreas,
};

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
