// lane-check's reader for the declaration files the guards, the Merger and the reconciler read
// (kanon#153): `docs/qa/escalation-paths.md` (`K-LAYOUT-8`), `docs/qa/exemptions.md`
// (`K-LAYOUT-15`), and the reference environment's deploy in the adoption record,
// `docs/qa/adoption.md` (`K-LAYOUT-10`, plan 0004 P6), with the weekly digest's audience beside
// it (kanon#218) and whether the production promotion is human-gated (`K-MERGE-4`, kanon#158),
// whether the Overseer is installed, held to the callers (plan 0004 step 13),
// and the code areas in the stack document, `docs/qa/stack.md`'s `## Code areas`
// (`K-LAYOUT-17`, kanon#54), which the guards and the code-audit lane read.
//
// Each is read with the library's own reader, from this Kanon tree (the version the adopter
// pinned), so a file this passes is one the readers accept, and a malformed one fails the
// adopter's CI on the pull request that broke it, by name, rather than only when a guard or
// the Merger next reads it.
//
//   node declarations.mjs <overseer> <register>
//     overseer  `true` when a workflow calls the Overseer's lane, else `false`
//     register  `true` to read the App register's `Persona` column (plan 0005 §3.3) and its
//               shape (§3.4: one slug per App, none shared between Apps): when a caller's lane
//               runs as a role and the register exists, else `false`
//
// Run from the root of the adopter's checkout. Runs every reader, in one process (one Node start
// per lane-check run, not one per reader), and prints one tab-separated line per finding:
// `notice<TAB><file><TAB><line>` for each default a reader took (an omitted file or section,
// plan 0005 §5.2), and `error<TAB><file><TAB><message>` for a declaration that doesn't parse,
// with the reader's own message. Exits 0 when it ran, whatever it found; 2 on a usage error. An
// adoption record that declares no reference environment passes here: the reconciler fails on
// it, by name, when a project reaches its deploy phase (K-PROJ-11).

import { readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { readExemptions } from '../../scripts/lib/exemptions.mjs';
import { readDigestAudience } from '../../scripts/lib/digest-audience.mjs';
import { readProductionPromotion } from '../../scripts/lib/production-promotion.mjs';
import { readReferenceDeploy } from '../../scripts/lib/reference-deploy.mjs';
import { codeAreasDefaults, readCodeAreas } from '../../scripts/lib/code-areas.mjs';
import { checkOverseerInstall } from '../../scripts/lib/overseer-install.mjs';
import { APP_REGISTER, appShape, parseAppRegister, parsePersonas } from '../../scripts/app-register.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [caller, register] = process.argv.slice(2);
const bool = (/** @type {string | undefined} */ v) => v === 'true' || v === 'false';
if (!bool(caller) || !bool(register)) {
  process.stderr.write('usage: declarations.mjs <overseer: true|false> <register: true|false>\n');
  process.exit(2);
}

/** Each reader, by the file it reads, returns the defaults it took, one line each. @type {Array<[string, (root: string) => string[]]>} */
const READERS = [
  ['docs/qa/escalation-paths.md', (root) => readEscalationFile(root).defaults],
  ['docs/qa/exemptions.md', (root) => readExemptions(root).defaults],
  // The record's declarations, so a malformed one of any fails by name. The production
  // promotion's default (not declared) is named by the Merger, which acts on it.
  ['docs/qa/adoption.md', (root) => {
    readReferenceDeploy(root);
    readDigestAudience(root);
    readProductionPromotion(root);
    return [];
  }],
  // Only `## Code areas`: the other sections are checked by lane-check itself, and only when a
  // called lane reads the document. A stack document without the section is Kanon's default.
  ['docs/qa/stack.md', (root) => codeAreasDefaults(readCodeAreas(root))],
  // Called for every repository, record or not: a record that doesn't say is Kanon's default,
  // `not installed`, and a caller of the Overseer's lane needs a record that says `installed`.
  ['docs/qa/adoption.md', (root) => checkOverseerInstall({ root, caller: caller === 'true' }).defaults],
  // The App register's optional `Persona` column (plan 0005 §3.3): a malformed persona fails by
  // name here, where the lanes would only warn. The slugs are the awk reader's, per role.
  ...(register === 'true'
    ? [/** @type {[string, (root: string) => string[]]} */ ([APP_REGISTER, (root) => {
        const text = readFileSync(join(root, APP_REGISTER), 'utf8');
        parsePersonas(text);
        // The register's shape since plan 0005's L4 (§3.4): no slug shared across the Author,
        // the Judge and the Releaser (the parser refuses it), and one slug per App.
        const shape = appShape(parseAppRegister(text));
        if (shape.length) throw new Error(shape.join(' Also, '));
        return [];
      }])]
    : []),
];

/** One finding per line: a message never spans lines here. @param {string} s */
const oneLine = (s) => s.split('\n')[0] ?? '';
for (const [file, read] of READERS) {
  try {
    for (const line of read(process.cwd())) process.stdout.write(`notice\t${file}\t${oneLine(line)}\n`);
  } catch (e) {
    process.stdout.write(`error\t${file}\t${oneLine(/** @type {Error} */ (e).message)}\n`);
  }
}
