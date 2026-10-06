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
// REQUIRED SINCE L4. L3 wrote and read the marker without requiring it, while every role still
// had its own App and the login alone told the roles apart. Step L4 (two Apps: the Author and
// the Judge) flipped `markerPhase` to `required`: two roles of one App share a login, so every
// reader that routes through `asRole` needs the login AND the role's marker.
// `tests/library/role-marker-readers.test.ts` runs each reader of §3.3's table under both
// phases and holds the shipped phase to `required`.
//
// WHERE A PERSONA IS DECLARED is not settled by L3: `K-AGENT-2` says the project supplies the
// display names of its personas, and no file carries them yet. Every writer here takes the
// persona as an argument and falls back to the role, which is the header §3.3 defines for a
// project that declares none.
//
// Run as a CLI, it prints one header line, for a workflow's shell step: with the persona given,
// or with the one the App register on standard input declares for the role (never failing: a
// malformed or missing column gives the role's own header, which lane-check fails by name).
//   node scripts/lib/role-marker.mjs header Implementer [persona]
//   … | node scripts/lib/role-marker.mjs header-from-register Implementer
// It signs a body on standard input as the role, opening it with the header line unless its
// first marker is already the role's (`signedAs`), for the review lane's stamp step (kanon#336):
//   … | node scripts/lib/role-marker.mjs sign Reviewer [persona]
// And it judges a head's commit statuses (the REST list, on standard input) for the
// implementer status, for the revise lane's filter (plan 0005 §3.3, L4):
//   … | node scripts/lib/role-marker.mjs implementer-status <author-slug>

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
 * `body`, made to read as `role`'s: returned unchanged when its first marker is already
 * `role`'s, and otherwise opened with `role`'s header line. Unlike `signed`, a first line that
 * carries ANOTHER role's marker is opened too, so `markedRole` of the result is always `role`.
 * For a fixed step that knows whose post it is signing, never for an agent's guess: the review
 * lane's stamp step, on the verdict its own agent posted (kanon#336).
 * @param {string} body
 * @param {string} role
 * @param {string | null} [persona]
 */
export function signedAs(body, role, persona = null) {
  const text = String(body ?? '');
  if (markedRole(text) === known(role)) return text;
  return `${headerLine(role, persona)}\n\n${text}`;
}

/**
 * What the readers require. `additive` (L3, kept for the reader-table test): the login
 * decides, and the marker is read but not required. `required` (L4, shipped): the login and
 * the role's marker both.
 * @typedef {'additive' | 'required'} MarkerPhase
 */

/** @type {MarkerPhase} */
let phase = 'required';

/** The phase every reader runs under. */
export const markerPhase = () => phase;

/**
 * Set the phase, for the reader-table test only: it runs each reader under L3's rule too, to
 * name what L4's flip changed. Returns the previous phase.
 * @param {MarkerPhase} next
 * @returns {MarkerPhase}
 */
export function setMarkerPhase(next) {
  if (next !== 'additive' && next !== 'required') throw new Error(`unknown marker phase \`${next}\``);
  const was = phase;
  phase = next;
  return was;
}

/**
 * The implementer commit status's context (plan 0005 §3.3, question 6). Set by a fixed step of
 * the Implementer's lanes (`actions/implementer-status`), never by an agent, and required by
 * the Merger on the current head, created by the Author App (L4).
 */
export const IMPLEMENTER_STATUS = 'kanon/role: implementer';

/** An App login as the APIs spell it, reduced to the slug: `app/x`, `x[bot]` and `x` are one. */
export const slugOf = (/** @type {unknown} */ login) => String(login ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '');

/**
 * Whether a commit's statuses carry the implementer status from the Author App (`expected`):
 * the NEWEST status of the context, as the REST list orders them, is `success` and created by
 * that App. The newest decides, so a later status from another App, or a failure, refuses
 * rather than being outvoted. The Merger's green zone, and the revise and rebase lanes' chain,
 * all ask this one question (plan 0005 §3.3, question 6).
 *
 * @param {unknown} statuses `[{ context, state, creator }]`, `creator` a login or `{ login }`
 * @param {string} expected the Author App's login
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function implementerStatusOn(statuses, expected) {
  if (!Array.isArray(statuses)) return { ok: false, why: 'its commit statuses could not be read' };
  const newest = statuses.find((s) => s?.context === IMPLEMENTER_STATUS);
  if (!newest) return { ok: false, why: `it carries no \`${IMPLEMENTER_STATUS}\` status` };
  const by = typeof newest.creator === 'object' && newest.creator ? newest.creator.login : newest.creator;
  if (newest.state !== 'success' || slugOf(by) !== slugOf(expected)) {
    return { ok: false, why: `its newest \`${IMPLEMENTER_STATUS}\` status is \`${newest.state}\` from \`${slugOf(by) || 'unknown'}\`, not \`success\` from \`${slugOf(expected)}\`` };
  }
  return { ok: true };
}

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
  if (cmd === 'implementer-status' && role) {
    // `… statuses JSON on stdin | role-marker.mjs implementer-status <author-slug>`: exit 0
    // when the newest implementer status is the Author App's success, else 1 with the reason.
    const { readFileSync } = await import('node:fs');
    let listed = null;
    try { listed = JSON.parse(readFileSync(0, 'utf8')); } catch { listed = null; }
    const v = implementerStatusOn(Array.isArray(listed) ? listed.flat() : null, role);
    if (v.ok) process.exit(0);
    console.log(v.why);
    process.exit(1);
  }
  if (cmd === 'header-from-register' && role) {
    const { readFileSync } = await import('node:fs');
    const { parsePersonas } = await import('../app-register.mjs');
    let declared = null;
    try { declared = parsePersonas(readFileSync(0, 'utf8')).get(known(role)) ?? null; } catch { declared = null; }
    console.log(headerLine(role, declared));
    process.exit(0);
  }
  if (cmd === 'sign' && role) {
    // `… body on stdin | role-marker.mjs sign <Role> [persona]`: the body, opened with the
    // role's header unless its first marker is already the role's (`signedAs`).
    const { readFileSync } = await import('node:fs');
    try {
      process.stdout.write(signedAs(readFileSync(0, 'utf8'), role, persona || null));
      process.exit(0);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  if (cmd !== 'header' || !role) {
    console.error('usage: role-marker.mjs header <Role> [persona] | header-from-register <Role> | sign <Role> [persona] | implementer-status <author-slug>');
    process.exit(2);
  }
  try {
    console.log(headerLine(role, persona ?? null));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
