// lane-check's reader for the declaration files the guards, the Merger and the reconciler read
// (kanon#153): `docs/qa/escalation-paths.md` (`K-LAYOUT-8`), `docs/qa/exemptions.md`
// (`K-LAYOUT-15`), and the reference environment's deploy in the adoption record,
// `docs/qa/adoption.md` (`K-LAYOUT-10`, plan 0004 P6), with the weekly digest's audience beside
// it (kanon#218) and whether the production promotion is human-gated (`K-MERGE-4`, kanon#158),
// whether the Overseer is installed, held to the callers (plan 0004 step 13), and where its
// upstream findings go (kanon#423), and that a record sending them has the telemetry collector's
// caller to send them (plan 0006 §3.1, kanon#585), and whether the Overseer runs the capability
// watch (kanon#477),
// and the code areas in the stack document, `docs/qa/stack.md`'s `## Code areas`
// (`K-LAYOUT-17`, kanon#54), which the guards and the code-audit lane read.
//
// Each is read with the library's own reader, from this Kanon tree (the version the adopter
// pinned), so a file this passes is one the readers accept, and a malformed one fails the
// adopter's CI on the pull request that broke it, by name, rather than only when a guard or
// the Merger next reads it.
//
//   node declarations.mjs <overseer> <register> [<telemetry>]
//     overseer  `true` when a workflow calls the Overseer's lane, else `false`
//     register  `true` to read the App register's `Persona` column (plan 0005 §3.3) and its
//               shape (§3.4: one slug per App, none shared between Apps): when a caller's lane
//               runs as a role and the register exists, else `false`
//     telemetry `true` when a workflow calls Kanon's telemetry collector, else `false` (the
//               default): `Upstream findings: sent` needs it (plan 0006 §3.1)
//
// lane-check calls `declarationFindings` in its own Node process (kanon#381). As a script, run
// from the root of the adopter's checkout, it runs every reader in one process and prints one
// tab-separated line per finding: `notice<TAB><file><TAB><line>` for each default a reader took
// (an omitted file or section, plan 0005 §5.2), and `error<TAB><file><TAB><message>` for a declaration that doesn't parse,
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
import { checkUpstreamSent, readUpstreamFindings } from '../../scripts/lib/upstream-findings.mjs';
import { readCapabilityWatch } from '../../scripts/lib/capability-watch.mjs';
import { APP_REGISTER, appShape, parseAppRegister, parsePersonas } from '../../scripts/app-register.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Every finding, one tab-separated line each, as the CLI prints them: lane-check runs this in its
 * own process (kanon#381), and the CLI below is the same readers for a person or a test.
 * @param {boolean} overseer @param {boolean} register @param {string} root
 * @param {boolean} [telemetry] whether a workflow calls Kanon's telemetry collector
 * @returns {string[]}
 */
export const declarationFindings = (overseer, register, root, telemetry = false) => {
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
      readUpstreamFindings(root);
      readCapabilityWatch(root);
      return [];
    }],
    // Only `## Code areas`: the other sections are checked by lane-check itself, and only when a
    // called lane reads the document. A stack document without the section is Kanon's default.
    ['docs/qa/stack.md', (root) => codeAreasDefaults(readCodeAreas(root))],
    // A record that sends upstream findings (`sent`, `sent with evidence`) with no caller of the
    // telemetry collector sends nothing (plan 0006 §3.1, `upstream.unsent`). A malformed bullet
    // is named once, by the record's readers above.
    ['docs/qa/adoption.md', (root) => {
      try { readUpstreamFindings(root); } catch { return []; }
      checkUpstreamSent(root, telemetry);
      return [];
    }],
    // Called for every repository, record or not: a record that doesn't say is Kanon's default,
    // `not installed`, and a caller of the Overseer's lane needs a record that says `installed`.
    ['docs/qa/adoption.md', (root) => checkOverseerInstall({ root, caller: overseer }).defaults],
    // The App register's optional `Persona` column (plan 0005 §3.3): a malformed persona fails by
    // name here, where the lanes would only warn. The slugs are the awk reader's, per role.
    ...(register
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
  /** @type {string[]} */
  const found = [];
  for (const [file, read] of READERS) {
    try {
      for (const line of read(root)) found.push(`notice\t${file}\t${oneLine(line)}`);
    } catch (e) {
      found.push(`error\t${file}\t${oneLine(/** @type {Error} */ (e).message)}`);
    }
  }
  return found;
};

const main = () => {
  const [caller, register, telemetry = 'false'] = process.argv.slice(2);
  const bool = (/** @type {string | undefined} */ v) => v === 'true' || v === 'false';
  if (!bool(caller) || !bool(register) || !bool(telemetry)) {
    process.stderr.write('usage: declarations.mjs <overseer: true|false> <register: true|false> [<telemetry: true|false>]\n');
    process.exit(2);
  }
  for (const line of declarationFindings(caller === 'true', register === 'true', process.cwd(), telemetry === 'true')) process.stdout.write(`${line}\n`);
};
const isMain = () => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
};
if (isMain()) main();
