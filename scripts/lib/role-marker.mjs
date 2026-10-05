// The persona header and the role marker (plan 0005 §3.3, step L3; ADR 0013, decision 3).
//
// WHAT A READER SEES. Every post a lane writes as one of its Apps (a comment, a review, an
// issue or pull request body) opens with a persona header, `**<persona> (<Role>)**`, or with
// the role alone, `**<Role>**`, when no persona is declared. Every commit an agent makes is
// authored with the persona as its name (`actions/agent-setup/agent-commits.sh`).
//
// WHAT A MACHINE READS. A hidden role marker, `<!-- kanon:role=<role> -->`, on the header's
// line. A check trusts a marker only on an object the expected App authored: the login says
// which App, the marker which of its roles. A marker on its own proves nothing, because every
// agent of an App can write the same bytes.
//
// L3 IS ADDITIVE. Today every role has its own App, so the login alone still tells the roles
// apart, and `asRole` answers exactly what the login answers: the marker is written and read,
// and nothing requires it. Step L4 (two Apps) flips `markerPhase` to `required`, and every
// reader that routes through `asRole` then also needs the role's marker. That is the one
// switch L4 throws: `tests/library/role-marker-readers.test.ts` runs each reader of §3.3's
// table under both phases and names what the flip changes.
//
// WHERE A PERSONA IS DECLARED is not settled by L3: `K-AGENT-2` says the project supplies the
// display names of its personas, and no file carries them yet. Every writer here takes the
// persona as an argument and falls back to the role, which is the header §3.3 defines for a
// project that declares none.
//
// Run as a CLI, it prints one header line, for a workflow's shell step:
//   node scripts/lib/role-marker.mjs header Implementer [persona]

import { isCliEntry } from './cli-entry.mjs';

/** The agent roles a header or a marker may name (rulebook `03-agents.md`, the roles table). */
export const MARKED_ROLES = /** @type {const} */ (['Explorer', 'Implementer', 'Reviewer', 'Merger', 'Lead', 'Overseer']);

/** `<!-- kanon:role=<role> -->`, the role in lower case. Spaces inside the comment are tolerated on read. */
const MARKER_RE = /<!--\s*kanon:role=([a-z]+)\s*-->/;

/** @param {string} role */
function known(role) {
  const r = MARKED_ROLES.find((x) => x.toLowerCase() === String(role ?? '').toLowerCase());
  if (!r) throw new Error(`\`${role}\` is not an agent role. A persona header names one of: ${MARKED_ROLES.join(', ')}.`);
  return r;
}

/**
 * The hidden role marker for `role`.
 * @param {string} role
 */
export function roleMarker(role) {
  return `<!-- kanon:role=${known(role).toLowerCase()} -->`;
}

/**
 * The persona header: `**<persona> (<Role>)**`, or `**<Role>**` without a persona (or with one
 * that is just the role's name).
 * @param {string} role
 * @param {string | null} [persona]
 */
export function personaHeader(role, persona = null) {
  const r = known(role);
  const p = String(persona ?? '').replace(/[\r\n*]/g, ' ').trim();
  return p && p !== r ? `**${p} (${r})**` : `**${r}**`;
}

/**
 * The header and the marker, on one line: what opens every post.
 * @param {string} role
 * @param {string | null} [persona]
 */
export function headerLine(role, persona = null) {
  return `${personaHeader(role, persona)} ${roleMarker(role)}`;
}

/**
 * The role the first marker in `body` names, or null when it carries none. The FIRST, because
 * the header opens the post: a marker further down is a quotation of someone else's.
 * @param {unknown} body
 * @returns {string | null} the role, capitalised as the roles table spells it
 */
export function markedRole(body) {
  const m = MARKER_RE.exec(String(body ?? ''));
  if (!m) return null;
  return MARKED_ROLES.find((r) => r.toLowerCase() === m[1]) ?? null;
}

/**
 * `body`, opened with `role`'s header line. A body that already opens with a marker (the
 * agent wrote it, or a step signed it once already) is returned unchanged, so signing is
 * idempotent and never stacks two headers.
 * @param {string} body
 * @param {string} role
 * @param {string | null} [persona]
 */
export function signed(body, role, persona = null) {
  const text = String(body ?? '');
  if (MARKER_RE.test(text.split('\n', 1)[0] ?? '')) return text;
  return `${headerLine(role, persona)}\n\n${text}`;
}

/**
 * What the readers require. `additive` (L3): the login decides, and the marker is read but
 * not required. `required` (L4): the login and the role's marker both.
 * @typedef {'additive' | 'required'} MarkerPhase
 */

/** @type {MarkerPhase} */
let phase = 'additive';

/** The phase every reader runs under. */
export const markerPhase = () => phase;

/**
 * Set the phase, for the reader-table test only: it runs each reader under L4's rule before
 * L4 ships, to name what the flip changes. Returns the previous phase.
 * @param {MarkerPhase} next
 * @returns {MarkerPhase}
 */
export function setMarkerPhase(next) {
  if (next !== 'additive' && next !== 'required') throw new Error(`unknown marker phase \`${next}\``);
  const was = phase;
  phase = next;
  return was;
}

/** An App login as the APIs spell it, reduced to the slug: `app/x`, `x[bot]` and `x` are one. */
export const slugOf = (/** @type {unknown} */ login) => String(login ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '');

/**
 * Whether an object was written by `role`: its author's login is the role's App (`expected`),
 * and, from L4, its body carries the role's marker.
 *
 * @param {string} role
 * @param {{ login: unknown, expected: string, body?: unknown }} who
 */
export function asRole(role, { login, expected, body }) {
  if (slugOf(login) !== slugOf(expected)) return false;
  if (phase === 'additive') return true;
  return markedRole(body) === known(role);
}

/**
 * The lane's prompt, with the instruction to open every post with `header` appended. With no
 * role (the block's persona step resolved none) the prompt is returned unchanged.
 * @param {string} prompt
 * @param {string} role
 * @param {string} header the line `headerLine` built for the role
 */
export function withPersona(prompt, role, header) {
  if (!role || !header) return prompt;
  return [
    prompt.trimEnd(),
    '',
    `WHO YOU SPEAK AS (plan 0005 §3.3). You are the ${known(role)}. Open every comment, review,`,
    'issue body and pull request body you write with this exact line, then a blank line:',
    '',
    header,
    '',
    'The HTML comment on it is your role marker: keep it as written, and never write another',
    "role's marker.",
  ].join('\n');
}

if (isCliEntry(import.meta.url)) {
  const [cmd, role, persona] = process.argv.slice(2);
  if (cmd !== 'header' || !role) {
    console.error('usage: role-marker.mjs header <Role> [persona]');
    process.exit(2);
  }
  try {
    console.log(headerLine(role, persona ?? null));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
