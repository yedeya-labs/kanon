#!/usr/bin/env node
// The persona a lane's filing step signs its posts with (`K-AGENT-1`, kanon#1401), for the gate
// job of a lane whose filing job checks out nothing: the Overseer's and the telemetry Explorer's.
//
//   persona="$(node "$KANON/scripts/lane-persona.mjs" Overseer)"
//
// WHY THE GATE JOB. `appPersona` (`app-register.mjs`) reads the App register
// (`docs/qa/agent-identities.md`, `K-LAYOUT-6`) from the working directory, and the filing job
// has no checkout there, and a token that reads no contents, so it would always answer null and
// every post would drop the persona. So the register is read here from the default branch, like
// every declaration a lane acts on (`K-MERGE-17`), on the gate job's token, which reads contents,
// before any agent runs, and the persona is handed on as the gate job's output, as the scrub's
// names are (`upstream-names.mjs`). The agent's job can write neither.
//
// WHAT THE OUTPUT SAYS. The role's persona, or nothing when the register declares none for it
// (or doesn't exist), so the posts open with the role's own name, as `appPersona` falls back.
// A register that can't be read, or whose `Persona` column is malformed, prints nothing too, with
// a warning: lane-check reports the malformed column, and a header is no reason to lose a run.
//
// Reads `GITHUB_REPOSITORY`, and `gh`'s token from the environment. Exits 2 without the
// repository, or with an argument that is not one of Kanon's roles.
// `node:` builtins only, like every script under scripts/ (`K-SELF-8`).

import { APP_REGISTER, ROLES, parsePersonas } from './app-register.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { defaultBranchFile } from './lib/declarations.mjs';

/**
 * `role`'s persona in the register on the default branch, or null for the role's own name, with
 * notes saying why when the register couldn't be read.
 * @param {{ repo: string, role: string, run?: (args: string[], opts?: object) => string }} o
 * @returns {{ persona: string | null, notes: string[] }}
 */
export function lanePersona({ repo, role, run }) {
  try {
    const { read } = defaultBranchFile(repo, run);
    const text = read(APP_REGISTER);
    if (text === null) return { persona: null, notes: [] };
    return { persona: parsePersonas(text, APP_REGISTER).get(role) ?? null, notes: [] };
  } catch (e) {
    return { persona: null, notes: [`the App register couldn't be read: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`] };
  }
}

/**
 * @param {{ repo?: string, role?: string, run?: (args: string[], opts?: object) => string }} [io]
 * @returns {{ code: number, out: string, notes: string[] }}
 */
export function lanePersonaCli({ repo = process.env.GITHUB_REPOSITORY, role = process.argv[2], run } = {}) {
  if (!repo) return { code: 2, out: '', notes: ['lane-persona: GITHUB_REPOSITORY must be set'] };
  if (!ROLES.includes(/** @type {any} */ (role))) return { code: 2, out: '', notes: [`lane-persona: name one of Kanon's roles (${ROLES.join(', ')}), not \`${role ?? ''}\``] };
  const { persona, notes } = lanePersona({ repo, role: String(role), run });
  return { code: 0, out: persona ?? '', notes: notes.map((n) => `::warning title=lane persona::${n}, so the ${role}'s posts open with its own name (K-AGENT-1)`) };
}

if (isCliEntry(import.meta.url)) {
  const { code, out, notes } = lanePersonaCli();
  for (const line of notes) process.stderr.write(`${line}\n`);
  process.stdout.write(`${out}\n`);
  process.exitCode = code;
}
