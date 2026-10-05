// lane-check's reader for the declaration files the guards, the Merger and the reconciler read
// (kanon#153): `docs/qa/escalation-paths.md` (`K-LAYOUT-8`), `docs/qa/exemptions.md`
// (`K-LAYOUT-15`), and the reference environment's deploy in the adoption record,
// `docs/qa/adoption.md` (`K-LAYOUT-10`, plan 0004 P6), with the weekly digest's audience beside
// it (kanon#218), whether the Overseer is installed, held to the callers (plan 0004 step 13),
// and the code areas in the stack document, `docs/qa/stack.md`'s `## Code areas`
// (`K-LAYOUT-17`, kanon#54), which the guards and the code-audit lane read.
//
// Each is read with the library's own reader, from this Kanon tree (the version the adopter
// pinned), so a file this passes is one the readers accept, and a malformed one fails the
// adopter's CI on the pull request that broke it, by name, rather than only when a guard or
// the Merger next reads it.
//
//   node declarations.mjs <escalation-paths|exemptions|adoption|stack|register>
//   node declarations.mjs overseer <true|false>   # whether a workflow calls the Overseer's lane
//
// Run from the root of the adopter's checkout. Exits 0 when the file parses, printing on standard
// output one line for each default it took (an omitted section, plan 0005 §5.2), and 1 with the
// reader's own message on standard error when it doesn't parse. lane-check calls it only for a
// file that exists: a missing file is the reader's documented default, and lane-check says so
// itself. An adoption record that declares no reference environment passes here: the reconciler
// fails on it, by name, when a project reaches its deploy phase (K-PROJ-11).

import { readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { readExemptions } from '../../scripts/lib/exemptions.mjs';
import { readDigestAudience } from '../../scripts/lib/digest-audience.mjs';
import { readReferenceDeploy } from '../../scripts/lib/reference-deploy.mjs';
import { codeAreasDefaults, readCodeAreas } from '../../scripts/lib/code-areas.mjs';
import { checkOverseerInstall } from '../../scripts/lib/overseer-install.mjs';
import { APP_REGISTER, parsePersonas } from '../../scripts/app-register.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Each reader returns the defaults it took, one line each. @type {Record<string, (root: string) => string[]>} */
const READERS = {
  'escalation-paths': (root) => readEscalationFile(root).defaults,
  exemptions: (root) => readExemptions(root).defaults,
  // Both of the record's declarations, so a malformed one of either fails by name.
  adoption: (root) => {
    readReferenceDeploy(root);
    readDigestAudience(root);
    return [];
  },
  // Only `## Code areas`: the other sections are checked by lane-check itself, and only when a
  // called lane reads the document. A stack document without the section is Kanon's default.
  stack: (root) => codeAreasDefaults(readCodeAreas(root)),
  // Called for every repository, record or not: a record that doesn't say is Kanon's default,
  // `not installed`, and a caller of the Overseer's lane needs a record that says `installed`.
  overseer: (root) => checkOverseerInstall({ root, caller: process.argv[3] === 'true' }).defaults,
  // The App register's optional `Persona` column (plan 0005 §3.3). The slugs are the awk
  // reader's, per role; this reads only what the persona writers read.
  register: (root) => {
    parsePersonas(readFileSync(join(root, APP_REGISTER), 'utf8'));
    return [];
  },
};

const which = process.argv[2] ?? '';
const read = READERS[which];
if (!read) {
  process.stderr.write(`usage: declarations.mjs <${Object.keys(READERS).join('|')}>\n`);
  process.exit(2);
}
try {
  for (const line of read(process.cwd())) process.stdout.write(`${line}\n`);
} catch (e) {
  process.stderr.write(`${/** @type {Error} */ (e).message}\n`);
  process.exit(1);
}
