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
// - A role appears once: a repeated row is a register that says two things. A slug may
//   appear on several rows, but only on the roles of ONE App (plan 0005 §3.4, decision 2):
//   the Author's four rows name one slug, the Judge's two another, the Releaser's a third.
//   Any two of the Author, the Judge and the Releaser sharing one is an error here, at run
//   time: Author and Judge sharing a slug would let an App approve what it authored, and the
//   Releaser sharing one would make its release bypass another role's. A role outside Kanon's
//   three Apps (Intake) shares no slug. The Author's roles naming TWO slugs (the per-role
//   Apps before L4) still reads, since every reader keys on a role's own row: `appShape`
//   reports it, and lane-check fails it by name, so a register is migrated on the adopter's
//   pull request rather than by a lane crashing.
// - An App that is not an agent, and has no role of Kanon's, has an `Other App` row (`OTHER_APP`,
//   `K-AGENT-3`), and there may be several, one per App. They are the exception to "a role
//   appears once", so they are not in the role → slug map every reader keys on: `parseOtherApps`
//   gives their slugs. An Other App row names an App no other row names. Sharing an agent App's
//   slug would re-label that App, and two rows naming one App say one thing twice.
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
// `app-slug` against the logins the scripts export) are what turn the claim into a check. The
// dispatch sweep exports its two as functions, read on call (kanon#1321), so a workflow calls them.
//
// WHERE IT IS READ FROM. `docs/qa/agent-identities.md` relative to the working directory —
// the same convention as `spec-lib`'s `SPEC_DIR`, and what every workflow and test runs
// from. A caller that runs base-branch code against a PR's checkout (`incremental-review`)
// passes the path of the BASE copy explicitly, because there the working tree's register
// is the PR's and a PR must not choose the login it is judged by. The Merger's lane checks
// out the default branch for the same reason (`agent-merge.yml`, kanon#210).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PERMISSION_COLUMNS } from '../cli/app-register.mjs';
import { withExtras } from './lib/app-extras.mjs';
import { fencedLines } from './spec-lib.mjs';

/** The App register's path (`K-LAYOUT-6`). */
export const APP_REGISTER = 'docs/qa/agent-identities.md';

/** Kanon's role names (rulebook `03-agents.md`, the roles table) that run under, or are, a GitHub App. */
export const ROLES = /** @type {const} */ ([
  'Explorer', 'Implementer', 'Reviewer', 'Merger', 'Lead', 'Overseer', 'Releaser', 'Intake',
]);

/**
 * The role of an App installed on the repository that is not an agent and plays none of `ROLES`
 * (rulebook `03-agents.md`, `K-AGENT-3`). Unlike a role in `ROLES`, it may have several rows, each
 * naming its own App, so its rows are read with `parseOtherApps`, never from the role → slug map:
 * no reader that maps a role to a login, the membership gate among them, sees one (`[REG-3]`).
 */
export const OTHER_APP = 'Other App';

/**
 * Which of Kanon's three Apps each role belongs to (ADR 0013, decision 2), from the `apps`
 * block of `rulebook/agent-permissions.json`, read from this Kanon tree: role name → App name.
 * A role in no App (Intake) is absent.
 * @type {Record<string, string>}
 */
const PERMISSIONS = JSON.parse(readFileSync(new URL('../rulebook/agent-permissions.json', import.meta.url), 'utf8'));

export const APP_OF = (() => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const app of Object.values(PERMISSIONS.apps)) {
    for (const key of app.roles) out[PERMISSIONS.roles[key]?.role ?? key[0].toUpperCase() + key.slice(1)] = app.app;
  }
  return out;
})();

/**
 * Each of Kanon's Apps' shared grant (`K-ADOPT-8`), from the same `apps` block: App key (`author`,
 * `judge`, `releaser`) → permission → `read` | `write`.
 * @type {Record<string, Record<string, string>>}
 */
export const APP_GRANTS = Object.fromEntries(Object.entries(PERMISSIONS.apps).map(([key, app]) => [key, { ...app.permissions }]));

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
 * Read a register's text: role → slug, and the Other App rows' slugs. Throws on every malformation.
 *
 * @param {string} text the register's markdown
 * @param {string} source its path, for messages
 * @returns {{ roles: Map<string, string>, others: string[] }}
 */
function readRegister(text, source) {
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
  const others = [];
  const slugs = new Map();
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
    const [rawRole = '', rawSlug = ''] = cells(lines[i]);
    const role = unbold(rawRole);
    const other = role === OTHER_APP;
    if (!other && !ROLES.includes(/** @type {any} */ (role))) {
      throw new Error(`${where(i)}: \`${rawRole}\` is not a role. The first column is one of: ${[...ROLES, OTHER_APP].join(', ')}.`);
    }
    const m = /^`([^`]*)`$/.exec(unbold(rawSlug));
    if (!m || !SLUG.test(m[1])) {
      throw new Error(`${where(i)}: the ${role} row's App slug \`${rawSlug}\` is malformed — write the slug GitHub derives from the App's name (lowercase letters, digits, hyphens) in backticks.`);
    }
    const slug = m[1];
    if (!other && roles.has(role)) throw new Error(`${where(i)}: role ${role} is listed twice (also ${where(roles.get(role).line)}). One identity per role.`);
    const app = APP_OF[role] ?? role;
    const first = slugs.get(slug);
    if (first && (other || first.other)) {
      throw new Error(`${where(i)}: the ${role} row names \`${slug}\`, the App the ${first.role} row names (${where(first.line)}). An ${OTHER_APP} row is an App that isn't an agent, so it names an App no other row names: one naming an agent's App would re-label it, and two naming one App say one thing twice (K-LAYOUT-6).`);
    }
    if (first && first.app !== app) {
      const of = (/** @type {string} */ r) => (APP_OF[r] ? `the ${APP_OF[r]}` : 'no App of Kanon\'s three');
      throw new Error(`${where(i)}: the ${role} row names \`${slug}\`, the App the ${first.role} row names (${where(first.line)}), but the ${role} belongs to ${of(role)} and the ${first.role} to ${of(first.role)}. Each of the Author, the Judge and the Releaser is its own App (plan 0005 §3.4).`);
    }
    if (other) others.push(slug);
    else roles.set(role, { slug, line: i });
    if (!first) slugs.set(slug, { app, role, line: i, other });
  }
  if (roles.size === 0 && others.length === 0) throw new Error(`${where(start)}: the App register table has no rows.`);
  return { roles: new Map([...roles].map(([role, { slug }]) => [role, slug])), others };
}

/**
 * Parse a register's text into role → slug, for the roles in `ROLES`. Throws on every
 * malformation, an Other App row's included; the Other App rows themselves are `parseOtherApps`'s.
 *
 * @param {string} text the register's markdown
 * @param {string} [source] its path, for messages
 * @returns {Map<string, string>}
 */
export function parseAppRegister(text, source = APP_REGISTER) {
  return readRegister(text, source).roles;
}

/**
 * The slugs of a register's Other App rows (`OTHER_APP`), in the register's order. Throws on every
 * malformation `parseAppRegister` throws on.
 *
 * @param {string} text the register's markdown
 * @param {string} [source] its path, for messages
 * @returns {string[]}
 */
export function parseOtherApps(text, source = APP_REGISTER) {
  return readRegister(text, source).others;
}

/**
 * What `parseAppRegister` reads but a register after plan 0005's L4 must not say: roles of one
 * App (the Author's four, the Judge's two) naming more than one slug. One message per App,
 * naming each role's slug. lane-check fails each (`actions/lane-check/declarations.mjs`).
 *
 * @param {Map<string, string>} register role → slug, as `parseAppRegister` returns it
 * @returns {string[]}
 */
export function appShape(register) {
  /** @type {Map<string, Array<[string, string]>>} */
  const byApp = new Map();
  for (const [role, slug] of register) {
    const app = APP_OF[role];
    if (!app) continue;
    byApp.set(app, [...(byApp.get(app) ?? []), [role, slug]]);
  }
  return [...byApp].flatMap(([app, rows]) => {
    const slugs = [...new Set(rows.map(([, s]) => s))];
    if (slugs.length < 2) return [];
    return [`the ${app}'s roles name ${slugs.length} App slugs (${rows.map(([r, s]) => `${r} \`${s}\``).join(', ')}): one App, one slug, on every one of its roles' rows (plan 0005 §3.4). Since L4 the ${app} is one GitHub App; run \`kanon apps --apps ${app.toLowerCase()}\` and write its slug on each row.`];
  });
}

// ── FOOTNOTES (`K-AGENT-3`, `K-LAYOUT-6`; kanon#1250) ─────────────────────────────────────
//
// A permission a row records beyond its App's grant needs its reason beside it: a numbered
// footnote below the table, marked `[^N]` in the cell (or on the `Other` cell's entry). The grant
// is Kanon's shared one (`K-ADOPT-8`, which records its own broadening), plus the extra App
// permissions this repository's adoption record declares (`K-LAYOUT-10`), whose bullets are the
// record `K-AGENT-3` asks for. `kanon apps` writes exactly that grant, so a register it wrote
// passes; only a hand-written widening needs a footnote. Rows outside Kanon's three Apps (Intake,
// `Other App`) have no shared grant to be broader than, so only their markers are read. A marker
// that no `[^N]:` below the table defines is refused on any row: it points at nothing.
//
// Read only by lane-check, never by a lane: a missing reason is a fault of the record, not of
// who is who, so it must not stop a lane that maps a role to a login.

/** `[^N]` in a cell, never the `[^N]:` that defines one. */
const MARKER = /\[\^([^\]\s]+)\](?!:)/g;

/** A register cell's level, after its markers and bold: 0, 1 or 2, or undefined when it says none of them. */
const levelOf = (/** @type {string} */ cell) => {
  const bare = cell.replace(MARKER, '').replace(/\*\*|__/g, '').trim().toLowerCase();
  return /** @type {Record<string, number>} */ ({ 'no access': 0, none: 0, read: 1, 'read & write': 2, 'read and write': 2, write: 2 })[bare];
};
const LEVEL_OF_GRANT = /** @type {Record<string, number>} */ ({ read: 1, write: 2 });
const LABEL = ['No access', 'Read', 'Read & write'];

/**
 * What a register says about footnotes that it must not: a permission beyond its App's grant with
 * no footnote, and a marker no footnote defines. One message per finding, each naming its line.
 * Throws on every malformation `parseAppRegister` throws on.
 *
 * @param {string} text the register's markdown
 * @param {Record<string, Record<string, string>>} [extras] what the adoption record declares, App key → permission → level (`readAppExtras`)
 * @param {string} [source] its path, for messages
 * @returns {string[]}
 */
export function registerFootnotes(text, extras = {}, source = APP_REGISTER) {
  readRegister(text, source);
  const lines = text.split('\n');
  const fenced = fencedLines(lines);
  const where = (/** @type {number} */ i) => `${source}:${i + 1}`;
  const start = lines.findIndex((l, i) => {
    if (fenced.has(i) || !/^\s*\|/.test(l)) return false;
    const c = cells(l);
    return c.length >= 2 && unbold(c[0]) === 'Role' && unbold(c[1]) === 'App slug';
  });
  const defined = new Set(lines.flatMap((l, i) => {
    const m = fenced.has(i) ? null : /^\[\^([^\]\s]+)\]:/.exec(l);
    return m ? [m[1]] : [];
  }));
  const byName = new Map(PERMISSION_COLUMNS.map(([key, name]) => [name.toLowerCase(), key]));
  const keyOf = (/** @type {string} */ name) => byName.get(name.trim().toLowerCase()) ?? name.trim().toLowerCase().replace(/\s+/g, '_');
  const header = cells(lines[start]).map(unbold);
  /** @type {string[]} */
  const out = [];
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
    const row = cells(lines[i]);
    const role = unbold(row[0] ?? '');
    for (const cell of row) {
      for (const [, n] of cell.matchAll(MARKER)) {
        if (!defined.has(n)) out.push(`${where(i)}: the ${role} row cites the footnote [^${n}], which no \`[^${n}]:\` below the table defines (K-LAYOUT-6).`);
      }
    }
    const app = APP_OF[role]?.toLowerCase();
    const grant = app && APP_GRANTS[app] ? withExtras(APP_GRANTS[app], extras[app]) : null;
    if (!grant) continue;
    /** @type {Array<[string, string, string]>} name, permission key, the cell or entry */
    const claims = [];
    header.forEach((h, c) => {
      if (c < 2 || c >= row.length) return;
      if (h === 'Other') {
        for (const entry of (row[c] ?? '').split(/,\s*(?=[^,:]+:)/)) {
          const m = /^([^:]+):\s*(.+)$/.exec(entry.trim());
          if (m) claims.push([m[1].trim(), keyOf(m[1]), m[2]]);
        }
      } else if (byName.has(h.toLowerCase())) claims.push([h, keyOf(h), row[c] ?? '']);
    });
    for (const [name, key, cell] of claims) {
      const level = levelOf(cell);
      const allowed = LEVEL_OF_GRANT[grant[key] ?? ''] ?? 0;
      if (level === undefined || level <= allowed) continue;
      if ([...cell.matchAll(MARKER)].length) continue;
      const declared = extras[app]?.[key] ? ', with what the adoption record declares for it' : '';
      out.push(`${where(i)}: the ${role} row's ${name}: ${LABEL[level]} is broader than the ${APP_OF[role]} App's grant (${name}: ${LABEL[allowed]}; K-ADOPT-8${declared}) and carries no numbered footnote. Mark it [^N] and say below the table why it was granted and what bounds its use (K-AGENT-3, K-LAYOUT-6), or declare it as an extra App permission in docs/qa/adoption.md for this repository's App (K-LAYOUT-10).`);
    }
  }
  return out;
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

/**
 * The login of the App that plays `role`, read when a module loads: `appLogin`'s answer, or
 * `undefined` when there is no register at `path` at all (kanon#1396).
 *
 * WHY A SECOND READ. A lane module that keeps a login as a constant reads it when it is
 * imported, and the status core imports the merge gate in a process with no checkout (the hosted
 * status server), where that import would throw before the core read anything. The core passes
 * the logins it read from the default branch instead. So only an ABSENT register is soft here: a
 * register that is there and malformed, or lists no such role, still throws at import, as before.
 * Code that compares the login when it runs falls back to `appLogin` while the constant is
 * `undefined`, which throws the register's own error, so no comparison runs against nobody.
 *
 * @param {typeof ROLES[number]} role
 * @param {string} [path]
 * @returns {string | undefined}
 */
export function appLoginAtLoad(role, path = APP_REGISTER) {
  return existsSync(resolve(path)) ? appLogin(role, path) : undefined;
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
