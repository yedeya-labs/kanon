// The membership gate every agent lane runs before it mints a token (`K-AGENT-45`, kanon#46).
//
// A lane starts real work only when the actor of the triggering event is a member: GitHub's
// `author_association` of `OWNER`, `MEMBER` or `COLLABORATOR`, or one of the repository's own
// agent Apps, `<slug>[bot]` for a slug in the App register (`K-LAYOUT-6`). On a public
// repository anyone can leave a review, and a stranger's changes-request would otherwise
// start an agent whose App token can push, with the stranger's text as its input.
//
// WHO THE ACTOR IS, per event (the `github` context of a called workflow is its caller's):
//   pull_request_review      the reviewer: `review.user` and `review.author_association`.
//   issues / pull_request    `labeled`: whoever applied the label, `sender`. The payload
//                            carries no association for the sender, so it is read from
//                            `GET /repos/{o}/{r}/collaborators/{login}/permission`, which needs
//                            only the Metadata read every workflow token holds.
//   pull_request `closed`    whoever merged it, `pull_request.merged_by` (else `sender`),
//                            checked like a label's sender.
//   workflow_dispatch        whoever ran it, `GITHUB_TRIGGERING_ACTOR` (else `GITHUB_ACTOR`),
//                            checked the same way. Only someone with write access can
//                            dispatch, so this cannot refuse a human today; it is checked
//                            anyway so that every path through every lane asks one question,
//                            and so that a dispatch by an App outside the register is refused.
//   anything else            refused: no lane acts on another event, and a lane that starts
//                            to must decide who its actor is here first.
//
// WHAT A MEMBER IS, per source of the answer:
//   a login ending `[bot]`   only the App register decides. A bot is never a collaborator,
//                            and an App the repository did not register is not its agent.
//   an association           `OWNER`, `MEMBER` or `COLLABORATOR`.
//   a permission lookup      triage access or more. On a public repository the endpoint
//                            answers `read` for ANY user, so read is not membership; and
//                            applying a label, merging and dispatching all need triage or
//                            more, so a member who did the act always passes.
//
// THE REGISTER IS READ FROM THE DEFAULT BRANCH, over the API (a filter job has no checkout),
// and only when the actor is a bot. Not from the pull request's base: a stacked pull
// request's base is another pull request's branch, which its author can write
// (`K-MERGE-17`). A missing register means no App is registered, so a bot is refused; a
// malformed one, or any failed API call, fails the step by name rather than guessing.
//
// A REFUSAL IS VISIBLE: a notice and a line in the step summary naming who was refused and
// why, and `member=false` in the step's outputs. The lane's later steps and jobs read
// `member` and skip. It exits 0, so a refused event is a skipped lane, not a red run.
//
// NODE BUILTINS ONLY: lanes run it from the action cache through `kanon-path`, in a filter
// job with no install. It calls `gh`, which GitHub's hosted runners provide.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseAppRegister } from './app-register.mjs';

/** The `author_association` values that make a member (`K-AGENT-45`). */
export const MEMBER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** The repository permissions, from the lookup's `user.permissions`, that make a member. */
const MEMBER_PERMISSIONS = ['admin', 'maintain', 'push', 'triage'];

/**
 * @typedef {{ login: string, association?: string, source: string }} Actor
 * @typedef {{ actor: Actor } | { refuse: string }} ActorResult
 * @typedef {{ member: boolean, reason: string }} Verdict
 * @typedef {{ login?: string } | null | undefined} User
 * @typedef {{
 *   action?: string,
 *   sender?: User,
 *   review?: { user?: User, author_association?: string },
 *   pull_request?: { merged_by?: User },
 * }} GitHubEvent
 */

/**
 * Who triggered the event, and where that answer came from.
 *
 * @param {string} eventName `GITHUB_EVENT_NAME`
 * @param {GitHubEvent} event the payload at `GITHUB_EVENT_PATH`
 * @param {Record<string, string | undefined>} env for `GITHUB_TRIGGERING_ACTOR` and `GITHUB_ACTOR`
 * @returns {ActorResult}
 */
export function triggeringActor(eventName, event, env) {
  /** @param {string | undefined} login @param {string} source @param {string} [association] @returns {ActorResult} */
  const found = (login, source, association) =>
    login ? { actor: { login, source, ...(association === undefined ? {} : { association }) } } : { refuse: `the ${eventName} event names no ${source}` };
  switch (eventName) {
    case 'pull_request_review':
      return found(event.review?.user?.login, 'reviewer', event.review?.author_association ?? '');
    case 'issues':
    case 'pull_request':
      if (event.action === 'labeled') return found(event.sender?.login, 'user who applied the label');
      if (eventName === 'pull_request' && event.action === 'closed') {
        return event.pull_request?.merged_by?.login
          ? found(event.pull_request.merged_by.login, 'user who merged it')
          : found(event.sender?.login, 'user who closed it');
      }
      return { refuse: `the ${eventName} event's \`${event.action ?? ''}\` action is not one a lane acts on` };
    case 'workflow_dispatch':
      return found(env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR, 'user who ran it');
    default:
      return { refuse: `no lane acts on a ${eventName || 'nameless'} event` };
  }
}

/**
 * Is the actor a member?
 *
 * @param {Actor} actor
 * @param {{
 *   registeredApps: () => Map<string, string>,
 *   permissionOf: (login: string) => { permissions?: Record<string, boolean>, role_name?: string },
 * }} lookups the register (role → slug) and the permission lookup, each called only when needed
 * @returns {Verdict}
 */
export function decide(actor, { registeredApps, permissionOf }) {
  const bot = /^(.+)\[bot\]$/.exec(actor.login);
  if (bot) {
    const slug = bot[1];
    const role = [...registeredApps()].find(([, s]) => s === slug)?.[0];
    return role
      ? { member: true, reason: `it is the repository's ${role} App in the App register` }
      : { member: false, reason: `it is an App that is not in the App register (docs/qa/agent-identities.md on the default branch)` };
  }
  if (actor.association !== undefined) {
    return MEMBER_ASSOCIATIONS.includes(actor.association)
      ? { member: true, reason: `its author_association is ${actor.association}` }
      : { member: false, reason: `its author_association is ${actor.association || 'empty'}, not ${MEMBER_ASSOCIATIONS.join(', ')}` };
  }
  const { permissions = {}, role_name: roleName = '' } = permissionOf(actor.login);
  const held = MEMBER_PERMISSIONS.find((p) => permissions[p] === true);
  return held
    ? { member: true, reason: `it has ${roleName || held} access to the repository` }
    : { member: false, reason: `it has ${roleName || 'no'} access to the repository; a member has triage or more` };
}

/** `gh api …`, or throw with what `gh` said. @param {string[]} args @returns {string} */
const ghApi = (args) => execFileSync('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** @param {unknown} e @returns {string} */
const stderrOf = (e) => {
  const err = /** @type {{ stderr?: string | Buffer, message?: string }} */ (e);
  return String(err.stderr || err.message || e).trim();
};

/** Run the gate for this job's event, and write its outputs and summary. */
export function main(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('lane-gate: GITHUB_REPOSITORY must be set; the runner sets it, and the gate never guesses a repository');
    return 2;
  }
  const eventName = env.GITHUB_EVENT_NAME ?? '';
  /** @type {GitHubEvent} */
  let event = {};
  if (env.GITHUB_EVENT_PATH) event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));

  /** @param {string} name @param {string} value */
  const output = (name, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  /** @param {string} line */
  const summary = (line) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  /** @param {string} line */
  const refuse = (line) => {
    output('member', 'false');
    console.log(`::notice title=Membership gate::${line}`);
    summary(`**Membership gate: refused.** ${line} This lane acts only on members' work (K-AGENT-45).`);
  };

  const who = triggeringActor(eventName, event, env);
  if ('refuse' in who) {
    output('actor', '');
    refuse(`Refused because ${who.refuse}.`);
    return 0;
  }
  const { actor } = who;
  output('actor', actor.login);

  try {
    const verdict = decide(actor, {
      registeredApps: () => {
        let text;
        try {
          text = ghApi([`repos/${repo}/contents/docs/qa/agent-identities.md`, '-H', 'Accept: application/vnd.github.raw']);
        } catch (e) {
          if (/\b404\b/.test(stderrOf(e))) return new Map();
          throw new Error(`could not read the App register from the default branch of ${repo}: ${stderrOf(e)}`);
        }
        return parseAppRegister(text);
      },
      permissionOf: (login) => {
        try {
          return JSON.parse(ghApi([`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, '--jq', '{permissions: .user.permissions, role_name}']));
        } catch (e) {
          throw new Error(`could not read ${login}'s permission on ${repo}: ${stderrOf(e)}`);
        }
      },
    });
    if (verdict.member) {
      output('member', 'true');
      console.log(`→ ${actor.login}, the ${actor.source}, is a member: ${verdict.reason}`);
      summary(`Membership gate: ${actor.login}, the ${actor.source}, is a member (${verdict.reason}).`);
    } else {
      refuse(`Refused ${actor.login}, the ${actor.source} of this ${eventName} event: ${verdict.reason}.`);
    }
    return 0;
  } catch (e) {
    console.log(`::error title=Membership gate::${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
