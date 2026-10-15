// The extra App permissions a repository declares in its adoption record (`K-AGENT-3`): one
// bullet each, under `## Choices`, naming one of Kanon's Apps, one permission and the reason:
//
//   ## Choices
//
//   - **Extra App permission:** `releaser` `workflows: write` (why this repository's App holds it)
//
// The bullet is the record of the broadening `K-AGENT-3` asks for, and the only place an App's
// grant widens: `kanon apps` builds the App's manifest and register rows with it, `apps-check`
// expects it on the installation, and doctor's `app.permission-missing` asks for it, all in the
// repository that declares it and nowhere else. Kanon's shared grant in
// `rulebook/agent-permissions.json` never changes for one repository's need. The reader is in the
// same shape as doctor's waivers and accepted id-token holders: a bullet in another shape,
// outside `## Choices`, naming an App Kanon doesn't have, a permission level other than `read`
// or `write`, no reason, or the same App and permission twice is an error naming its line.

import { fencedLines } from '../spec-lib.mjs';

// The record's path and heading, as `deploy-declaration.mjs` names them, held here so this
// module, which credential-holding runs reach (`apps-check`), imports nothing outside its
// escalation path.
/** The adoption record (`K-LAYOUT-10`). */
export const ADOPTION_RECORD = 'docs/qa/adoption.md';
/** The section the declaration sits in. */
export const CHOICES_HEADING = '## Choices';

/** The bullet's bold label, under `## Choices`. */
export const EXTRA_LABEL = 'Extra App permission';

/** @typedef {Record<string, Record<string, string>>} AppExtras App key → permission → level */

/**
 * @param {string | null} text the adoption record, or null when there is none
 * @param {string[]} apps the keys of Kanon's Apps (`agent-permissions.json`'s `apps` block)
 * @returns {{ extras: AppExtras, reasons: Record<string, string>, errors: string[] }}
 *   reasons: `<app>.<permission>` → the bullet's reason
 */
export const readAppExtras = (text, apps) => {
  /** @type {AppExtras} */
  const extras = {};
  /** @type {Record<string, string>} */
  const reasons = {};
  /** @type {string[]} */
  const errors = [];
  if (!text) return { extras, reasons, errors };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fencedLines(lines);
  const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${EXTRA_LABEL}:\\*\\*`, 'i');
  const entry = new RegExp(`^[-*] \\*\\*${EXTRA_LABEL}:\\*\\* \`([a-z]+)\` \`([a-z_]+): (read|write)\` \\((.*\\S.*)\\)\\s*$`);
  let section = '';
  lines.forEach((line, i) => {
    if (inFence.has(i)) return;
    if (/^#{1,6} /.test(line)) section = line.trimEnd();
    if (!mention.test(line)) return;
    const m = entry.exec(line);
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    if (!m) return errors.push(`${where} is not \`- **${EXTRA_LABEL}:** \`<app>\` \`<permission>: <read | write>\` (<why the App holds it>)\``);
    if (section !== CHOICES_HEADING) return errors.push(`${where} declares an extra App permission outside \`${CHOICES_HEADING}\``);
    const [app, permission, level, reason] = [/** @type {string} */ (m[1]), /** @type {string} */ (m[2]), /** @type {string} */ (m[3]), /** @type {string} */ (m[4]).trim()];
    if (!apps.includes(app)) return errors.push(`${where} names the App \`${app}\`, which is none of Kanon's (${apps.join(', ')})`);
    if (extras[app]?.[permission]) return errors.push(`${where} declares \`${permission}\` for the ${app} App a second time`);
    (extras[app] ??= {})[permission] = level;
    reasons[`${app}.${permission}`] = reason;
  });
  return { extras, reasons, errors };
};

const LEVEL = /** @type {Record<string, number>} */ ({ read: 1, write: 2 });

/**
 * An App's permissions with the repository's declared extras: each extra raises a permission to
 * its level, and never lowers one.
 * @param {Record<string, string>} permissions @param {Record<string, string> | undefined} extra
 * @returns {Record<string, string>}
 */
export const withExtras = (permissions, extra) => {
  const out = { ...permissions };
  for (const [k, v] of Object.entries(extra ?? {})) if ((LEVEL[v] ?? 0) > (LEVEL[out[k] ?? ''] ?? 0)) out[k] = v;
  return out;
};
