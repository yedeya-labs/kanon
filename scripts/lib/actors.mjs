// Who did something on GitHub: a person, or an automation. The label guard's test, moved here so
// the red-test check reads a label's applier by the same one (`K-MERGE-13`, #666).
//
// ⚠️ The actor is the TOKEN, not the intent. A local agent session using a person's own `gh`
// login is recorded as that person. No event field tells the two apart.

/**
 * A GitHub actor that is an automation rather than a person: any App, the agents' included, and
 * GitHub's own `github-actions[bot]`.
 * @param {{ type?: unknown, login?: unknown } | null | undefined} actor
 */
export const isAgentActor = (actor) =>
  actor?.type === 'Bot' || /\[bot\]$/.test(typeof actor?.login === 'string' ? actor.login : '');
