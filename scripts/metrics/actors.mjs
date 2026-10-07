// How the work-item step tells people from agents (plan 0003 §3.2).
//
// THE CLASS IS DERIVED ADOPTER-SIDE, AND THE LOGIN IS DISCARDED. A GitHub account is one of:
//   a role       its login is an App the App register (`K-LAYOUT-6`) lists;
//   `other_bot`  any other bot account;
//   `human`      everything else.
// Only the class reaches the row (`author_kind`, `merged_by`) or a count per class
// (`human_reviews`, `human_commits`). No function here returns a login.
//
// ONE APP, SEVERAL ROLES (plan 0005 §3.4, L4). §3.2 was written when each role had its own App,
// so a login named one role. Since L4 the Author App plays the Implementer, the Lead, the
// Explorer and the Overseer, and the Judge App the Reviewer and the Merger. A login then names
// the App, and which of its roles acted is read the way Kanon's own checks read it
// (`scripts/lib/role-marker.mjs`): the role marker on what the account wrote. Where the object
// has no body (a merge, a commit), the caller says which role the action implies (a merge by
// the Judge is the Merger's), and that hint is taken only when the App plays that role. With
// neither, the class is unknown, and left out, rather than guessed.
//
// ROLES OUTSIDE THE ROW'S LIST. The register may also list the Releaser and Intake, which the
// telemetry schema's `ACTOR_CLASSES` doesn't: their accounts are bots of no delivery role, so
// they are `other_bot`.

import { ACTOR_CLASSES } from '../../actions/agent-telemetry/schema.mjs';
import { markedRole, slugOf } from '../lib/role-marker.mjs';

/** @typedef {typeof ACTOR_CLASSES[number]} ActorClass */

/** Whether an account is a bot: GitHub's `type`, or the `[bot]` and `app/` spellings of an App's login. */
const isBot = (/** @type {import('./types.mjs').Actor} */ actor) =>
  actor.type === 'Bot' || /\[bot\]$/i.test(actor.login) || /^app\//i.test(actor.login);

/**
 * The dependency-update bots `origin` names `dependency_bot` (§3.3). Kanon's list, by App
 * slug: they are the same Apps on every repository.
 */
export const DEPENDENCY_BOTS = Object.freeze(['dependabot', 'renovate', 'dependabot-preview']);

/**
 * The roles the register's App `slug` plays, in the schema's spelling, each one the row can
 * carry.
 * @param {Map<string, string>} register role name → slug, as `parseAppRegister` returns it
 * @param {string} slug
 * @returns {string[]}
 */
function rolesOf(register, slug) {
  const want = slug.toLowerCase();
  return [...register]
    .filter(([, s]) => s.toLowerCase() === want)
    .map(([role]) => role.toLowerCase())
    .filter((role) => (/** @type {readonly string[]} */ (ACTOR_CLASSES)).includes(role));
}

/**
 * Whether `slug` is an App the register lists under any role, including one the row can't
 * carry (the Releaser, Intake).
 * @param {Map<string, string>} register
 * @param {string} slug
 */
const registered = (register, slug) => [...register.values()].some((s) => s.toLowerCase() === slug.toLowerCase());

/**
 * An account's class (§3.2): the role it acted as, `human` or `other_bot`. Undefined when the
 * account is unknown (`null`: deleted, or a commit email GitHub links to no account), or when
 * it is an App of several roles and neither the marker in `body` nor `expect` says which.
 * @param {import('./types.mjs').Actor | null | undefined} actor
 * @param {Map<string, string>} register role name → App slug (`parseAppRegister`)
 * @param {{ body?: string | null, expect?: string }} [hint] `body`: what the account wrote, for
 *   its role marker; `expect`: the role the action implies, in the schema's spelling
 * @returns {ActorClass | undefined}
 */
export function classifyActor(actor, register, { body, expect } = {}) {
  if (!actor || typeof actor.login !== 'string' || actor.login === '') return undefined;
  const slug = slugOf(actor.login);
  const roles = rolesOf(register, slug);
  if (roles.length === 1) return /** @type {ActorClass} */ (roles[0]);
  if (roles.length > 1) {
    const marked = markedRole(body)?.toLowerCase();
    if (marked && roles.includes(marked)) return /** @type {ActorClass} */ (marked);
    if (expect && roles.includes(expect)) return /** @type {ActorClass} */ (expect);
    return undefined;
  }
  if (registered(register, slug) || isBot(actor)) return 'other_bot';
  return 'human';
}

/**
 * Whether an account is a dependency-update bot (`DEPENDENCY_BOTS`): a bot whose App slug is
 * one of them. Read for `origin` only; the class is still `other_bot`.
 * @param {import('./types.mjs').Actor | null | undefined} actor
 */
export function isDependencyBot(actor) {
  if (!actor || typeof actor.login !== 'string' || !isBot(actor)) return false;
  return DEPENDENCY_BOTS.includes(slugOf(actor.login).toLowerCase());
}

/** Whether a class is a role of Kanon's, not `human` or `other_bot`. @param {string | undefined} cls */
export const isAgentClass = (cls) => cls !== undefined && cls !== 'human' && cls !== 'other_bot';
