// The private register file's checks (plan 0002 §5), kept for `register.mjs import`, plan 0008 §9
// step 3's one-time move of the file into the register table, and for `register.mjs set`'s labels
// and first reviews, which follow the file's rules. Moved here from `render.mjs`, which plan 0008 J9
// removed with the per-adopter roles it rendered from the file: no deploy reads the file since.
// The file itself is deleted from the operator's storage once J9 is deployed (§9 step 7).
//
// A REFUSAL NAMES AN ENTRY BY ITS INDEX, NEVER BY ITS KEY (kanon#628), and echoes nothing in it.

import { addMonths, RETENTION_MONTHS } from './function/rows.mjs';
import { ISO_UTC } from '../../actions/agent-telemetry/schema.mjs';

// One role: its path's and name's characters only, so no `*` or `?`, which `ArnNotEquals` reads as
// wildcards, and no `,`, which the register table's `Fn::Split` reads as a second principal. The
// template's `OwnerPrincipalArn` holds the same pattern.
const OWNER = /^arn:aws:iam::\d{12}:role\/(?:[\w+=.@-]+\/)*[\w+=.@-]+$/;
/** A key, and a label for own figures, which shares its pattern. */
export const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const READER = /^ref:refs\/heads\/[A-Za-z0-9._/-]+$/;

/**
 * @typedef {{ minutes: number, review_recorded_at: string }} FirstReview
 * @typedef {{ key: string, repository: string, readers?: string[], writer_subjects?: string[], reader_subjects?: string[], first_review?: FirstReview,
 *   publish_own_figures_as?: string, aggregate_invoker?: boolean }} Entry
 * @typedef {{ owner_principal_arn: string, create_oidc_provider?: boolean, reserved_concurrency?: number, repositories: Entry[] }} Register
 */

/**
 * Whether an entry's time from install to first review is past its bound (plan 0002 decision 18):
 * 13 months after the review row it was computed from, the same retention as the row itself.
 * Past it, the value comes out of the register, and so out of the published distribution.
 * @param {FirstReview} firstReview
 * @param {number} now
 */
export const firstReviewExpired = (firstReview, now) =>
  addMonths(Date.parse(firstReview.review_recorded_at), RETENTION_MONTHS) <= now;

/** Keys that differ only in punctuation were one role's logical id, so the file refuses them. */
const logicalId = (/** @type {string} */ key) => key.replace(/[^A-Za-z0-9]/g, '');

/**
 * Check the register, and say what's wrong with it, naming each entry by its index and echoing
 * nothing in it, its key least of all.
 * A time to first review past its 13 months is a problem too (decision 18), so no import goes
 * out while the register still holds one.
 * @param {any} register
 * @param {number} [now]
 * @returns {string[]}
 */
export function registerProblems(register, now = Date.now()) {
  const out = [];
  if (!register || typeof register !== 'object') return ['the register is not an object'];
  if (typeof register.owner_principal_arn !== 'string' || !OWNER.test(register.owner_principal_arn)) {
    out.push('owner_principal_arn is not a role ARN');
  }
  const repos = register.repositories;
  if (!Array.isArray(repos) || repos.length === 0) return [...out, 'repositories is empty'];
  const ids = new Set();
  const names = new Set();
  const keys = new Set(repos.map((r) => r?.key));
  const labels = new Set();
  repos.forEach((r, i) => {
    const at = `repositories[${i}]`;
    if (typeof r?.key !== 'string' || !KEY.test(r.key)) out.push(`${at}.key is not a key`);
    else {
      if (ids.has(logicalId(r.key))) out.push(`${at}.key duplicates another key`);
      ids.add(logicalId(r.key));
    }
    if (typeof r?.repository !== 'string' || !REPOSITORY.test(r.repository)) out.push(`${at}.repository is not owner/name`);
    else if (names.has(r.repository.toLowerCase())) out.push(`${at}.repository is a duplicate`);
    else names.add(r.repository.toLowerCase());
    // `readers` is the usual form; `reader_subjects` replaces it with exact subjects. Never both.
    if (r?.reader_subjects !== undefined && r?.readers !== undefined) out.push(`${at} gives both readers and reader_subjects`);
    else if (r?.reader_subjects === undefined) {
      if (!Array.isArray(r?.readers) || r.readers.length === 0 || !r.readers.every((/** @type {unknown} */ s) => typeof s === 'string' && READER.test(s))) {
        out.push(`${at}.readers must list ref:refs/heads/<branch> subjects, and nothing else (no environment)`);
      }
    }
    const fr = r?.first_review;
    if (fr !== undefined) {
      if (!fr || typeof fr !== 'object' || !Number.isInteger(fr.minutes) || fr.minutes < 0
        || typeof fr.review_recorded_at !== 'string' || !ISO_UTC.test(fr.review_recorded_at) || Number.isNaN(Date.parse(fr.review_recorded_at))) {
        out.push(`${at}.first_review must be { minutes, review_recorded_at }`);
      } else if (firstReviewExpired(fr, now)) {
        out.push(`${at}.first_review is past its ${RETENTION_MONTHS} months (decision 18): remove it`);
      }
    }
    // §6.1: an adopter's own figures are published only if it declares so, under a label it
    // chooses. Off by default; never a key, so the label can't name one.
    const label = r?.publish_own_figures_as;
    if (label !== undefined) {
      if (typeof label !== 'string' || !KEY.test(label)) out.push(`${at}.publish_own_figures_as is not a label`);
      else if (keys.has(label)) out.push(`${at}.publish_own_figures_as is a key`);
      else if (labels.has(label)) out.push(`${at}.publish_own_figures_as duplicates another label`);
      else labels.add(label);
    }
    if (r?.aggregate_invoker !== undefined && typeof r.aggregate_invoker !== 'boolean') out.push(`${at}.aggregate_invoker is not true or false`);
    for (const field of ['writer_subjects', 'reader_subjects']) {
      const v = r?.[field];
      if (v !== undefined && (!Array.isArray(v) || v.length === 0 || !v.every((/** @type {unknown} */ s) => typeof s === 'string'))) {
        out.push(`${at}.${field}, when given, must list exact subjects`);
      }
    }
  });
  return out;
}
