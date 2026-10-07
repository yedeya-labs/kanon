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
//   issues `closed`          whoever closed it, `sender`, checked the same way. The reconciler
//                            ticks on it (plan 0004 step 8): an issue a merge closes is closed
//                            by whoever merged, and one closed by hand by whoever closed it.
//   pull_request `opened`    whoever opened it, `sender`, checked the same way.
//   pull_request_target      as `pull_request`: the review lane's label trigger runs the base
//                            branch's copy of its caller, with the same payload. EXCEPT
//                            `closed`, which a lane acts on only as a MERGE (the Overseer's
//                            runtime-version trigger, kanon#423, and the rebase lane's start
//                            after a merge, kanon#484): it is judged by `pull_request.merged_by`
//                            alone, never `sender`, and a pull request closed unmerged is
//                            refused. Anyone may close their own pull request, a fork's
//                            included, and this event runs with the base's secrets. On a
//                            merge-queue merge, `merged_by` is the member who queued it.
//   workflow_run             whoever pushed the commit the finished workflow ran on,
//                            `workflow_run.triggering_actor` (else `workflow_run.actor`),
//                            checked the same way. The rebase lane fires on CI finishing on
//                            the default branch, where the pusher is who acted. With a merge
//                            queue the pusher is `github-merge-queue[bot]`, an App outside the
//                            register, so that trigger is refused (kanon#79, docs/lanes.md):
//                            the merge lane's sweep waits for its schedule, and the rebase
//                            lane starts on the merged pull request instead (kanon#484).
//   workflow_run, review     THE REVIEW LANE sets `LANE_GATE_WORKFLOW_RUN=review-label` and
//                            is judged by whoever applied the review label on the PR, not the
//                            pusher (kanon#81). Its CI completion is a deferred label: a label
//                            added while CI runs waits for it, and on a dependency bot's PR the
//                            pusher is that bot, which is not the repository's App, so the
//                            member's request was refused. The PR is the first open one whose
//                            head is the commit (the lane's filter picks the same), and the
//                            actor is the user on the latest `labeled` event among the review
//                            labels on it now. No such PR, or no review label: refused. A
//                            fork's head is refused separately, by the lane's own filter.
//   workflow_dispatch        whoever ran it, `GITHUB_TRIGGERING_ACTOR` (else `GITHUB_ACTOR`),
//                            checked the same way. Only someone with write access can
//                            dispatch, so this cannot refuse a human today; it is checked
//                            anyway so that every path through every lane asks one question,
//                            and so that a dispatch by an App outside the register is refused.
//   schedule                 the user GitHub runs it as, `GITHUB_ACTOR`: whoever last changed
//                            the cron in the caller on the default branch, or changed the
//                            default branch itself. It has no other actor, and that user is
//                            the one GitHub holds to the schedule. Checked the same way, so a
//                            schedule set by someone who has since lost access is refused,
//                            not run on their behalf. The rebase lane's daily floor runs on it.
//                            EXCEPT the merge queue: where merges go through one, every merge
//                            changes the default branch as the queue, so GitHub runs every
//                            schedule as it, and `GITHUB_ACTOR` is then `github-merge-queue`,
//                            without the `[bot]` an App's login carries (measured on Kanon's
//                            own `main`, 2026-10-07: the run's API record names
//                            `github-merge-queue[bot]`). On a schedule alone, it is admitted:
//                            only a member can queue a merge, so the default branch the queue
//                            last changed got there through a member. Refusing it would leave
//                            every scheduled lane skipped forever on a merge-queue repository,
//                            and the schedules are the floor the queue's refused push and
//                            CI-completion triggers fall back to (kanon#263). On every other
//                            event the queue is still an App outside the register, and refused.
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
// THE CALLER'S KANON PIN IS CHECKED TOO, for a member (kanon#69): a lane run from a branch
// other than the default whose caller pins a different Kanon version than the default branch's
// caller is refused the same way. See `caller-pin.mjs`.
//
// A REFUSAL IS VISIBLE: a notice and a line in the step summary naming who was refused and
// why, and `member=false` in the step's outputs. The lane's later steps and jobs read
// `member` and skip. It exits 0, so a refused event is a skipped lane, not a red run.
//
// NODE BUILTINS ONLY: lanes run it from the action cache through `kanon-path`, in a filter
// job with no install. It calls `gh`, which GitHub's hosted runners provide.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

import { parseAppRegister } from './app-register.mjs';
import { checkCallerPin } from './caller-pin.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The `author_association` values that make a member (`K-AGENT-45`). */
export const MEMBER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** GitHub's merge queue, as `GITHUB_ACTOR` names it on a schedule, and as its login. */
export const MERGE_QUEUE_ACTOR = 'github-merge-queue';
export const MERGE_QUEUE_LOGIN = 'github-merge-queue[bot]';

/** The repository permissions, from the lookup's `user.permissions`, that make a member. */
const MEMBER_PERMISSIONS = ['admin', 'maintain', 'push', 'triage'];

/**
 * @typedef {{ login: string, association?: string, source: string, admitted?: string }} Actor
 * @typedef {{ actor: Actor } | { refuse: string }} ActorResult
 * @typedef {{ member: boolean, reason: string }} Verdict
 * @typedef {{ login?: string } | null | undefined} User
 * @typedef {{
 *   action?: string,
 *   sender?: User,
 *   review?: { user?: User, author_association?: string },
 *   pull_request?: { merged?: boolean, merged_by?: User },
 *   workflow_run?: { triggering_actor?: User, actor?: User, head_sha?: string },
 *   schedule?: string,
 *   repository?: { default_branch?: string },
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
    case 'pull_request_target':
      if (event.action === 'labeled') return found(event.sender?.login, 'user who applied the label');
      if (eventName !== 'issues' && event.action === 'opened') return found(event.sender?.login, 'user who opened it');
      if (event.action === 'closed') {
        // A `pull_request_target` close is acted on only as a merge, and judged by who merged it.
        if (eventName === 'pull_request_target') {
          return event.pull_request?.merged === true
            ? found(event.pull_request.merged_by?.login, 'user who merged it')
            : { refuse: 'the pull_request_target event closed a pull request without merging it, and a lane acts on that close only as a merge' };
        }
        return eventName !== 'issues' && event.pull_request?.merged_by?.login
          ? found(event.pull_request.merged_by.login, 'user who merged it')
          : found(event.sender?.login, 'user who closed it');
      }
      return { refuse: `the ${eventName} event's \`${event.action ?? ''}\` action is not one a lane acts on` };
    case 'workflow_dispatch':
      return found(env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR, 'user who ran it');
    case 'workflow_run':
      return found(event.workflow_run?.triggering_actor?.login || event.workflow_run?.actor?.login, 'user whose push the finished workflow ran on');
    case 'schedule':
      // The merge queue, on a schedule alone: admitted, and named by its login (see the header).
      if (env.GITHUB_ACTOR === MERGE_QUEUE_ACTOR || env.GITHUB_ACTOR === MERGE_QUEUE_LOGIN) {
        return {
          actor: {
            login: MERGE_QUEUE_LOGIN,
            source: 'merge queue that last changed the default branch',
            admitted: 'on a schedule the merge queue is admitted, since only a member can queue the merges it makes',
          },
        };
      }
      return found(env.GITHUB_ACTOR, 'user who last changed the schedule');
    default:
      return { refuse: `no lane acts on a ${eventName || 'nameless'} event` };
  }
}

/** The labels that ask the review lane for a review (its filter reads the same three). */
export const REVIEW_LABELS = ['review:please', 'agent:triage', 'agent:implement'];

/**
 * @typedef {{ number?: number, state?: string, head?: { sha?: string }, labels?: { name?: string }[] }} PullRef
 * @typedef {{ event?: string, label?: { name?: string }, actor?: User }} IssueEvent
 */

/**
 * On a review lane's `workflow_run`, the actor is whoever applied the review label (kanon#81).
 *
 * @param {string | undefined} sha `workflow_run.head_sha`
 * @param {() => PullRef[]} pullsFor the open-or-closed PRs whose head is that commit
 * @param {(n: number) => IssueEvent[]} eventsOf the PR's issue events, oldest first
 * @returns {ActorResult}
 */
export function reviewLabeller(sha, pullsFor, eventsOf) {
  if (!sha) return { refuse: 'the workflow_run event names no head commit' };
  const pr = pullsFor().find((p) => p.state === 'open');
  if (!pr?.number) return { refuse: `no open pull request has ${sha.slice(0, 7)} as its head` };
  const onIt = new Set((pr.labels ?? []).map((l) => l.name).filter((n) => n !== undefined && REVIEW_LABELS.includes(n)));
  if (onIt.size === 0) return { refuse: `pull request #${pr.number} carries no review label (${REVIEW_LABELS.join(', ')})` };
  const login = eventsOf(pr.number)
    .filter((e) => e.event === 'labeled' && onIt.has(e.label?.name ?? ''))
    .at(-1)?.actor?.login;
  return login
    ? { actor: { login, source: `user who applied the review label on #${pr.number}` } }
    : { refuse: `pull request #${pr.number}'s timeline names no one who applied its review label` };
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
  if (actor.admitted) return { member: true, reason: actor.admitted };
  const bot = /^(.+)\[bot\]$/.exec(actor.login);
  if (bot) {
    const slug = bot[1];
    // Since plan 0005's L4 several roles share one App's slug (§3.4): name them all.
    const roles = [...registeredApps()].filter(([, s]) => s === slug).map(([r]) => r);
    const role = roles.length ? roles.join(', ') : undefined;
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

  // A pure read of the payload, except on the review lane's `workflow_run`, which asks the API
  // who applied the review label. A failed read fails the step by name, as the lookups below do.
  /** @type {ActorResult} */
  let who;
  if (eventName === 'workflow_run' && env.LANE_GATE_WORKFLOW_RUN === 'review-label') {
    const wr = event.workflow_run ?? {};
    try {
      who = reviewLabeller(
        wr.head_sha,
        () => JSON.parse(ghApi([`repos/${repo}/commits/${wr.head_sha}/pulls`])),
        (n) => JSON.parse(ghApi(['--paginate', '--slurp', `repos/${repo}/issues/${n}/events?per_page=100`])).flat(),
      );
    } catch (e) {
      console.log(`::error title=Membership gate::could not read who applied the review label for ${wr.head_sha ?? 'the head'} on ${repo}: ${stderrOf(e)}`);
      return 1;
    }
  } else {
    who = triggeringActor(eventName, event, env);
  }
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
      // THE CALLER'S KANON PIN (kanon#69): a lane run from a branch other than the default runs
      // the version the default branch pins, or not at all. Checked for members only, so a
      // refused stranger costs no read. `scripts/caller-pin.mjs` says when and why.
      const pin = checkCallerPin(
        { workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: env.GITHUB_WORKFLOW_SHA, repo, defaultBranch: event.repository?.default_branch },
        (path, ref) => {
          try {
            return ghApi([`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, '-H', 'Accept: application/vnd.github.raw']);
          } catch (e) {
            if (/\b404\b/.test(stderrOf(e))) return null;
            throw new Error(`could not read the caller ${path} at ${ref} on ${repo}: ${stderrOf(e)}`);
          }
        },
      );
      if (!pin.ok) {
        output('member', 'false');
        console.log(`::notice title=Kanon pin::Refused because ${pin.reason}.`);
        summary(`**Kanon pin: refused.** ${actor.login} is a member, but ${pin.reason}. Run it from the default branch, or merge the pin there first.`);
        return 0;
      }
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

if (isCliEntry(import.meta.url)) {
  process.exitCode = main();
}
