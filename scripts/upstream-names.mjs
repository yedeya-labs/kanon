#!/usr/bin/env node
// The App register's names, which the scrub's `name` rule removes from an upstream finding's
// evidence (plan 0006 §4.2; F3), as hashes, for the gate job of the Overseer's and the telemetry
// Explorer's lanes when the repository sends findings with evidence:
//
//   names="$(node "$KANON/scripts/upstream-names.mjs")"
//
// WHY THE GATE JOB. The register (`docs/qa/agent-identities.md`, `K-LAYOUT-6`) is read from the
// default branch, like every declaration a lane acts on (`K-MERGE-17`), on the gate job's token,
// which reads contents, before any agent runs. The filing job checks out nothing, and its token
// writes issues and reads no contents. So the gate job hands the names on as its output, as it
// hands on the `Upstream findings:` choice, and the agent can change neither.
//
// HASHES, NEVER NAMES. Each word of each App slug is hashed (`nameContext`), as the scrub reads
// them, so no name is written into an output or a log (`namesForbiddenWord`'s rule).
//
// KANON'S OWN WORDS ARE LEFT OUT (kanon#588, from F1's review). The `name` rule removes every word
// of every name it is given, wherever it appears. An App slug is usually the adopter's word and a
// role's (`acme-reviewer`), so hashing it whole would remove "the reviewer" from all evidence,
// which the upstream-finding skill tells the agent to write instead of a login. So a role's, an
// App's or a lane's word, or `kanon`, is not hashed: the adopter's own words still are, and the
// slug is still removed wherever it appears whole, since one of its words is.
//
// WHAT THE OUTPUT SAYS. The hashes, comma-separated; `none` when the register's slugs hold only
// Kanon's words; and nothing when the register couldn't be read (missing, malformed or a read
// error), with a warning. The filing job withholds every text on nothing (fail closed), and the
// audit still runs: a register problem is lane-check's to report, not a reason to lose an audit.
//
// Reads `GITHUB_REPOSITORY`, and `gh`'s token from the environment. Exits 2 without the repository.
// `node:` builtins only, like every script under scripts/ (`K-SELF-8`).

import { LANES, ROLES as TELEMETRY_ROLES } from '../actions/agent-telemetry/schema.mjs';
import { nameContext } from '../actions/agent-telemetry/scrub.mjs';
import { APP_OF, APP_REGISTER, ROLES, parseAppRegister } from './app-register.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { defaultBranchFile } from './lib/declarations.mjs';

/** Kanon's own words, which no App slug's hash includes: its roles, its Apps, its lanes' words and its name. */
export const KANON_WORDS = new Set(
  ['kanon', ...ROLES, ...TELEMETRY_ROLES, ...Object.values(APP_OF), ...LANES]
    .flatMap((w) => w.toLowerCase().match(/[a-z0-9]+/g) ?? []),
);

/**
 * The words of the App slugs the scrub removes: each slug's `[a-z0-9]` runs, once, but Kanon's own.
 * @param {Iterable<string>} slugs
 * @returns {string[]}
 */
export const appNameWords = (slugs) =>
  [...new Set([...slugs].flatMap((s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? []))].filter((w) => !KANON_WORDS.has(w));

/**
 * The register's names, as hashes, or null when it couldn't be read, with notes saying why.
 * @param {{ repo: string, run?: (args: string[], opts?: object) => string }} o
 * @returns {{ hashes: string[] | null, notes: string[] }}
 */
export function upstreamNames({ repo, run }) {
  try {
    const { branch, read } = defaultBranchFile(repo, run);
    const text = read(APP_REGISTER);
    if (text === null) return { hashes: null, notes: [`the App register, ${APP_REGISTER}, doesn't exist on \`${branch}\``] };
    const register = parseAppRegister(text, APP_REGISTER);
    return { hashes: [...nameContext({ apps: appNameWords(register.values()) })], notes: [] };
  } catch (e) {
    return { hashes: null, notes: [`the App register couldn't be read: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`] };
  }
}

/**
 * @param {{ repo?: string, run?: (args: string[], opts?: object) => string }} [io]
 * @returns {{ code: number, out: string, notes: string[] }}
 */
export function upstreamNamesCli({ repo = process.env.GITHUB_REPOSITORY, run } = {}) {
  if (!repo) return { code: 2, out: '', notes: ['upstream-names: GITHUB_REPOSITORY must be set'] };
  const { hashes, notes } = upstreamNames({ repo, run });
  if (hashes === null) {
    return { code: 0, out: '', notes: notes.map((n) => `::warning title=upstream names::${n}, so an upstream finding's evidence is withheld, and it is sent as codes only (plan 0006 §4.2)`) };
  }
  return { code: 0, out: hashes.length ? hashes.join(',') : 'none', notes };
}

if (isCliEntry(import.meta.url)) {
  const { code, out, notes } = upstreamNamesCli();
  for (const line of notes) process.stderr.write(`${line}\n`);
  process.stdout.write(`${out}\n`);
  process.exitCode = code;
}
