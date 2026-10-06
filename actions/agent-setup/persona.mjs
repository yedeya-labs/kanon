// Which role the agent speaks as, and how it says so (plan 0005 §3.3, step L3). Run by
// `agent-setup` before the commit identity, so `agent-commits.sh` can author the agent's
// commits with the persona's name.
//
// THE ROLE. The lane's `role` input when it gives one (the review lane, whose App token
// doesn't exist yet when it calls the block). Otherwise the register row whose slug is the
// minted App's, read from the DEFAULT branch, as `agent-commits.sh` reads the delegation: a
// pull request's checkout must not choose the role its own agent speaks as. That lookup is
// unambiguous while each role has its own App; at L4, when roles share an App, every lane
// passes `role` and the lookup goes.
//
// WHAT IT WRITES, to `$GITHUB_ENV` for the steps after it, the agent's included:
//   KANON_ROLE         the role, as the roles table spells it
//   KANON_PERSONA      the persona: the register's `Persona` cell for the role (default
//                      branch), or the role itself when it is blank or absent (§3.3)
//   KANON_POST_HEADER  the header line that opens every post: `**<persona> (<Role>)**` and the marker
// `agent-run` asks the agent to open every post with KANON_POST_HEADER.
//
// NO ROLE, AND NO SLUG OR THE WORKFLOW TOKEN'S OWN (`github-actions`), writes nothing and says
// so: an agent that posts as no App (the digests, the Overseer's files-nothing agent, the
// blocks smoke) has no role to speak as (`NO_PERSONA` in `tests/unit/role-marker.test.ts`).
//
// A ROLE IT CAN'T RESOLVE FAILS THE STEP, by name (Owner decision, 2026-10-06, kanon#336). It
// used to warn and let the agent run unsigned. Since L4 every reader requires the role's
// marker, so such a run's posts read as no role's and the work it produced stalls in silence.
// A malformed `Persona` cell still only warns: the header falls back to the role's own name,
// which every reader accepts, and lane-check fails the cell by name.
//
// Inputs, by environment only: ROLE, APP_SLUG, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_ENV.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { APP_REGISTER, parseAppRegister, parsePersonas } from '../../scripts/app-register.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { MARKED_ROLES, headerLine } from '../../scripts/lib/role-marker.mjs';

/**
 * The role to speak as, from the lane's input or the register.
 * @param {{ role?: string, slug?: string, register?: () => string }} input
 * @returns {{ role: string } | { problem: string }}
 */
export function resolveRole({ role = '', slug = '', register = () => '' }) {
  if (role) {
    const r = MARKED_ROLES.find((x) => x.toLowerCase() === role.toLowerCase());
    return r ? { role: r } : { problem: `the lane's role \`${role}\` is not an agent role (${MARKED_ROLES.join(', ')})` };
  }
  if (!slug) return { problem: 'the lane passed no role and no App slug' };
  let rows;
  try {
    rows = parseAppRegister(register(), `${APP_REGISTER} on the default branch`);
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
  const roles = [...rows].filter(([, s]) => s === slug).map(([r]) => r).filter((r) => MARKED_ROLES.includes(/** @type {any} */ (r)));
  if (roles.length !== 1) {
    return { problem: `${APP_REGISTER} on the default branch gives the App \`${slug}\` ${roles.length ? `${roles.length} agent roles (${roles.join(', ')})` : 'no agent role'}, not one` };
  }
  return { role: /** @type {string} */ (roles[0]) };
}

/** The workflow token's own login: a run that mints no App and posts as no role. */
const WORKFLOW_TOKEN_SLUG = 'github-actions';

/**
 * Whether the run asks for no role at all: no role, and no App slug or the workflow token's.
 * Such a run's agent posts as no App, so it has no persona to resolve and nothing to fail.
 * @param {{ role?: string, slug?: string }} input
 */
export function speaksAsNoRole({ role = '', slug = '' }) {
  return !role && (!slug || slug === WORKFLOW_TOKEN_SLUG);
}

/**
 * The role's persona from the register's optional `Persona` column, or null for the role's own
 * name. A register that can't be read, or a malformed column, gives null and says why: the
 * persona is a display name, and lane-check is what fails a malformed one, by name.
 * @param {string} role
 * @param {() => string} register
 * @returns {{ persona: string | null, problem?: string }}
 */
export function resolvePersona(role, register) {
  try {
    return { persona: parsePersonas(register(), `${APP_REGISTER} on the default branch`).get(role) ?? null };
  } catch (e) {
    return { persona: null, problem: (e instanceof Error ? e.message : String(e)).split('\n')[0] };
  }
}

/**
 * The environment lines for a resolved role.
 * @param {string} role
 * @param {string | null} [persona]
 */
export function personaEnv(role, persona = null) {
  return [
    `KANON_ROLE=${role}`,
    `KANON_PERSONA=${persona || role}`,
    `KANON_POST_HEADER=${headerLine(role, persona)}`,
  ];
}

if (isCliEntry(import.meta.url) && speaksAsNoRole({ role: process.env.ROLE ?? '', slug: process.env.APP_SLUG ?? '' })) {
  console.log('No role and no App slug were passed, so the agent speaks as no persona (plan 0005 §3.3).');
} else if (isCliEntry(import.meta.url)) {
  // Read once, from the default branch, for both the role and the persona.
  /** @type {string | undefined} */
  let text;
  const register = () => (text ??= execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/contents/${APP_REGISTER}`,
    '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const r = resolveRole({ role: process.env.ROLE ?? '', slug: process.env.APP_SLUG ?? '', register });
  if ('problem' in r) {
    console.log(`::error title=agent-setup::cannot tell which role this agent speaks as: ${r.problem.split('\n')[0]}. Its posts would carry no role marker, and since plan 0005's L4 no reader counts an unmarked post as any role's, so its work would stall with no signal. Pass the lane's \`role\` to agent-setup, or fix the App register (plan 0005 §3.3, kanon#336).`);
    process.exitCode = 1;
  } else {
    const p = resolvePersona(r.role, register);
    if (p.problem) console.log(`::warning title=agent-setup::the ${r.role} speaks under its role's own name: ${p.problem}`);
    appendFileSync(String(process.env.GITHUB_ENV), `${personaEnv(r.role, p.persona).join('\n')}\n`);
    console.log(`The agent speaks as the ${r.role}: ${headerLine(r.role, p.persona)}`);
  }
}
