// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-2701 — the agents' App logins, read from the App register instead of restated in code.
//
// WHY. Until RA-2701 every script that compares a bot login carried its own constant —
// `AGENT_LOGIN`, `SWEEP_LOGIN`, `IMPLEMENTER_LOGIN` (twice), `MERGER_LOGIN`,
// `REVIEWER_LOGIN`, `LEAD_LOGIN`, `RECOVERY_LOGIN`, `EXPLORER_LOGIN`, a `BOT_LOGINS` set
// and two inline reviewer literals. Those are one project's App names, so the pipeline
// library could not move to Kanon whole while they lived in it (Kanon move plan, P4). The
// register, `docs/qa/agent-identities.md`, is where Kanon puts them (`K-LAYOUT-6`), and it
// was already the page that explained them — so it is now the one place they are written.
//
// THE FORMAT this reads, and nothing looser:
//
//   | Role | App slug | …any further columns… |
//   |---|---|---|
//   | Implementer | `example-implementer` | … |
//
// - Exactly ONE table whose header row starts with the cells `Role` and `App slug`. None,
//   or two, is an error: two would make every lookup ambiguous.
// - A row's role is one of Kanon's role names (`ROLES`), optionally in bold. A slug is the
//   App's slug exactly as GitHub derives it from the App's name — lowercase letters,
//   digits and single hyphens — in backticks, optionally in bold. That is the login a
//   comment's author reads as (plus `[bot]` / `app/` decorations the callers strip).
// - A role appears once and a slug appears once: one identity per role is `K-AGENT-2`, and
//   a repeated row is a register that says two things.
// - A table inside a fenced code block is an example and is not read.
//
// FAIL LOUDLY. Every one of those is a thrown error naming the register's path and line,
// and so is a lookup of a role the register does not list. The failure this replaces was
// silent and pointed toward ACTION: `dispatch-sweep`'s `isBot()` reads an unknown login as
// a human, which is the re-dispatch path. A wrong or missing register entry must therefore
// stop the script, never degrade to "no login matches".
//
// WHAT THIS DOES NOT PROVE. The register is a claim; the live App's slug is not in any
// file. `K-AGENT-5`'s run-time slug assertions (the workflows compare the minted
// `app-slug` against these exported values) are what turn the claim into a check, and
// they keep working unchanged because the exports keep their names.
//
// WHERE IT IS READ FROM. `docs/qa/agent-identities.md` relative to the working directory —
// the same convention as `spec-lib`'s `SPEC_DIR`, and what every workflow and test runs
// from. A caller that runs base-branch code against a PR's checkout (`incremental-review`)
// passes the path of the BASE copy explicitly, because there the working tree's register
// is the PR's and a PR must not choose the login it is judged by. The Merger's lane checks
// out the default branch for the same reason (`agent-merge.yml`, kanon#210).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fencedLines } from './spec-lib.mjs';

/** The App register's path (`K-LAYOUT-6`). */
export const APP_REGISTER = 'docs/qa/agent-identities.md';

/** Kanon's role names (rulebook `03-agents.md`, the roles table) that run under, or are, a GitHub App. */
export const ROLES = /** @type {const} */ ([
  'Explorer', 'Implementer', 'Reviewer', 'Merger', 'Lead', 'Overseer', 'Releaser', 'Intake',
]);

/** A slug as GitHub derives it from an App's name. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Split one markdown table row into trimmed cells, honouring `\|` escapes. */
function cells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** `**x**` / `__x__` → `x`. */
const unbold = (s) => s.replace(/^(\*\*|__)(.*)\1$/, '$2').trim();

/**
 * Parse a register's text into role → slug. Throws on every malformation.
 *
 * @param {string} text the register's markdown
 * @param {string} [source] its path, for messages
 * @returns {Map<string, string>}
 */
export function parseAppRegister(text, source = APP_REGISTER) {
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  const where = (i) => `${source}:${i + 1}`;
  const isHeader = (l) => {
    const c = cells(l);
    return c.length >= 2 && unbold(c[0]) === 'Role' && unbold(c[1]) === 'App slug';
  };
  const headers = lines.flatMap((l, i) => (!fenced.has(i) && /^\s*\|/.test(l) && isHeader(l) ? [i] : []));
  if (headers.length === 0) {
    throw new Error(`${source}: no App register table — expected one table whose header row starts \`| Role | App slug |\` (K-LAYOUT-6).`);
  }
  if (headers.length > 1) {
    throw new Error(`${source}: ${headers.length} App register tables (${headers.map(where).join(', ')}) — there must be exactly one, or every lookup is ambiguous.`);
  }

  const start = headers[0];
  if (!/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(lines[start + 1] ?? '')) {
    throw new Error(`${where(start + 1)}: the App register's header row is not followed by a \`|---|\` delimiter row.`);
  }

  const roles = new Map();
  const slugs = new Map();
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
    const [rawRole = '', rawSlug = ''] = cells(lines[i]);
    const role = unbold(rawRole);
    if (!ROLES.includes(/** @type {any} */ (role))) {
      throw new Error(`${where(i)}: \`${rawRole}\` is not a role. The first column is one of: ${ROLES.join(', ')}.`);
    }
    const m = /^`([^`]*)`$/.exec(unbold(rawSlug));
    if (!m || !SLUG.test(m[1])) {
      throw new Error(`${where(i)}: the ${role} row's App slug \`${rawSlug}\` is malformed — write the slug GitHub derives from the App's name (lowercase letters, digits, hyphens) in backticks.`);
    }
    const slug = m[1];
    if (roles.has(role)) throw new Error(`${where(i)}: role ${role} is listed twice (also ${where(roles.get(role).line)}). One identity per role.`);
    if (slugs.has(slug)) throw new Error(`${where(i)}: App \`${slug}\` is listed twice (also ${where(slugs.get(slug))}). One role per App.`);
    roles.set(role, { slug, line: i });
    slugs.set(slug, i);
  }
  if (roles.size === 0) throw new Error(`${where(start)}: the App register table has no rows.`);
  return new Map([...roles].map(([role, { slug }]) => [role, slug]));
}

const cache = new Map();

/**
 * The register at `path`, parsed once per process. Throws if it is missing or malformed.
 *
 * @returns {Map<string, string>} role → slug
 */
export function loadAppRegister(path = APP_REGISTER) {
  const key = resolve(path);
  if (!cache.has(key)) {
    let text;
    try {
      text = readFileSync(key, 'utf8');
    } catch (e) {
      throw new Error(`App register ${path} is unreadable (${e instanceof Error ? e.message : String(e)}). The pipeline's bot logins are read from it (K-LAYOUT-6).`);
    }
    cache.set(key, parseAppRegister(text, path));
  }
  return cache.get(key);
}

/**
 * The login of the App that plays `role`, as the register records it. Throws when the
 * register does not list the role — never returns a value that matches nobody.
 *
 * @param {typeof ROLES[number]} role
 * @param {string} [path]
 * @returns {string}
 */
export function appLogin(role, path = APP_REGISTER) {
  const slug = loadAppRegister(path).get(role);
  if (!slug) throw new Error(`App register ${path} lists no ${role} App — add its row (Role | App slug) before code that compares its login can run.`);
  return slug;
}

// ── PERSONAS (plan 0005 §3.3; decided by the Owner, 2026-10-05) ───────────────────────────
//
// An optional `Persona` column, anywhere after `App slug`, gives a role the display name its
// posts open with (`**<persona> (<Role>)**`) and its agent's commits are authored under. A
// blank cell, or no column at all, means the role's own name. Read only where a persona is
// written (the agent-setup block, the fixed steps that post, lane-check), never by code that
// compares a login, so a malformed persona can't stop a lane deciding who is who: lane-check
// fails it by name on the adopter's pull request, and a writer falls back to the role.

/** Agent roles: the only rows a persona may name, since only an agent posts as a persona. */
const PERSONA_ROLES = ['Explorer', 'Implementer', 'Reviewer', 'Merger', 'Lead', 'Overseer'];

/** A display name: a letter first, then letters, digits, spaces and `.'-`, at most 40 in all. */
const PERSONA = /^[A-Za-z][A-Za-z0-9 .'-]{0,39}$/;

/**
 * The register's personas, role → persona, for the rows that declare one. Throws, naming the
 * line, on a malformed one: two `Persona` columns, a persona outside `PERSONA`, one on a row
 * that isn't an agent's, or one that is another role's name (a header would then read as that
 * role's). A persona equal to its own role is the default, written out, and is dropped.
 *
 * @param {string} text the register's markdown
 * @param {string} [source] its path, for messages
 * @returns {Map<string, string>}
 */
export function parsePersonas(text, source = APP_REGISTER) {
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  const where = (i) => `${source}:${i + 1}`;
  const start = lines.findIndex((l, i) => {
    if (fenced.has(i) || !/^\s*\|/.test(l)) return false;
    const c = cells(l);
    return c.length >= 2 && unbold(c[0]) === 'Role' && unbold(c[1]) === 'App slug';
  });
  const personas = new Map();
  if (start < 0) return personas;
  const header = cells(lines[start]).map(unbold);
  const columns = header.flatMap((h, i) => (h === 'Persona' ? [i] : []));
  if (columns.length > 1) throw new Error(`${where(start)}: the App register has ${columns.length} \`Persona\` columns, not one.`);
  if (columns.length === 0) return personas;
  const [col] = columns;
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
    const row = cells(lines[i]);
    const role = unbold(row[0] ?? '');
    const persona = unbold(row[col] ?? '');
    if (persona === '') continue;
    if (!PERSONA_ROLES.includes(role)) {
      throw new Error(`${where(i)}: the ${role} row declares the persona \`${persona}\`, but only an agent role has one (${PERSONA_ROLES.join(', ')}).`);
    }
    if (!PERSONA.test(persona)) {
      throw new Error(`${where(i)}: the ${role} row's persona \`${persona}\` is malformed: write a display name of at most 40 characters, a letter first, then letters, digits, spaces and . ' -, or leave it blank for the role's own name.`);
    }
    if (persona !== role && ROLES.includes(/** @type {any} */ (persona))) {
      throw new Error(`${where(i)}: the ${role} row's persona \`${persona}\` is another role's name, so its posts would read as the ${persona}'s.`);
    }
    if (persona !== role) personas.set(role, persona);
  }
  return personas;
}

/**
 * The persona a fixed step posts `role`'s comments under, from the register at `path`, or null
 * for the role's own name. Never throws: a missing or malformed register gives null, so a post
 * falls back to the role's header rather than failing (lane-check fails the malformed column).
 *
 * @param {string} role
 * @param {string} [path]
 * @returns {string | null}
 */
export function appPersona(role, path = APP_REGISTER) {
  try {
    return parsePersonas(readFileSync(resolve(path), 'utf8'), path).get(role) ?? null;
  } catch {
    return null;
  }
}
