// Each environment's deploy target (kanon#1555, the Owner's decision of 2026-11-01): one
// repository variable, `KANON_DEPLOY_TARGETS`, a JSON object naming each declared environment's
// role identifier, such as a cloud role's ARN. The deploy hook is a composite action, which can't
// read `vars`, and the trust probe's job has no environment and no secret, so neither could learn
// a role without its identifier being committed. A reusable workflow's caller can read `vars`, so
// the caller `kanon init` writes maps the variable into `deploy-release.yml`'s `targets` input;
// the gate reads it here, and the lane hands the hook its value: the probe the whole object, of
// the declared environments, as `KANON_DEPLOY_TARGETS`, and each environment's deploy job its own,
// as `KANON_DEPLOY_TARGET`.
//
// It is NOT a secret. A role's identifier names the role; what refuses a job outside its
// environment is the role's trust condition on the token's subject, which no job can change
// (plan 0010 §5). GitHub prints a step's environment in the run's log, so the value is logged.
//
// Unset, or empty, the lane hands the hook nothing, as before the variable existed. Set, it must
// be a JSON object naming every declared environment with a non-empty string; the gate fails on
// anything else, by the variable's name, before anything is built or deployed. Keys the
// declaration doesn't name are left out of what the lane hands on, so an environment dropped from
// the list needs no change to the variable.

/** The repository variable the deploy caller maps into `deploy-release.yml`'s `targets` input. */
export const TARGETS_VARIABLE = 'KANON_DEPLOY_TARGETS';
/** What the probe's hook step reads: the declared environments' targets, as a JSON object. */
export const TARGETS_ENV = 'KANON_DEPLOY_TARGETS';
/** What each environment's deploy hook step reads: its own target. */
export const TARGET_ENV = 'KANON_DEPLOY_TARGET';

/** Why a `KANON_DEPLOY_TARGETS` value can't be used, naming the variable. */
export class TargetsError extends Error {}

/**
 * The declared environments' targets, from the variable's text: `null` when it is unset or empty,
 * else an object of exactly the declared environments, in their order. Throws `TargetsError`,
 * naming the variable and each environment at fault, on text that isn't a JSON object, on a
 * declared environment it leaves out, and on one whose value isn't a non-empty string.
 * @param {string | undefined | null} text the variable's value
 * @param {string[]} environments the declared list
 * @returns {Record<string, string> | null}
 */
export function parseTargets(text, environments) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not the parser's message, which quotes the text back.
    throw new TargetsError(`${TARGETS_VARIABLE} is not JSON: it must be one JSON object naming each declared environment's role identifier, such as {"production":"<role identifier>"}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TargetsError(`${TARGETS_VARIABLE} is JSON but not an object: it must be one JSON object naming each declared environment's role identifier, such as {"production":"<role identifier>"}`);
  }
  const given = /** @type {Record<string, unknown>} */ (parsed);
  const missing = environments.filter((e) => !Object.hasOwn(given, e));
  const blank = environments.filter((e) => Object.hasOwn(given, e) && (typeof given[e] !== 'string' || !String(given[e]).trim()));
  if (missing.length || blank.length) {
    const names = (/** @type {string[]} */ l) => l.map((e) => `\`${e}\``).join(', ');
    throw new TargetsError(`${TARGETS_VARIABLE} ${[
      ...(missing.length ? [`doesn't name ${names(missing)}`] : []),
      ...(blank.length ? [`gives ${names(blank)} no role identifier, only a non-empty string is one`] : []),
    ].join(', and ')}: it must name every declared environment (${names(environments)})`);
  }
  return Object.fromEntries(environments.map((e) => [e, String(given[e]).trim()]));
}
