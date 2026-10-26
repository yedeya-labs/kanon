// The implementer commit status, `kanon/role: implementer` (plan 0005 §3.3, question 6; step L3).
//
// WHY A STATUS. Once the Implementer and the Lead share the Author App (L4), a role marker is
// a claim any Author agent can write. The Merger's green zone needs a signal no other Author
// lane's agent can produce: a commit status set by a FIXED step of the Implementer's lanes,
// after the agent has finished, with a token narrowed to Commit statuses write, which no
// agent's token holds (`K-AGENT-46`). Since L4 the Merger requires it on a green-zone head, and
// the revise and rebase lanes refuse a pull request whose head lacks it.
//
// TWO MODES, because the status is a chain, not a stamp:
//
//   open   (implement, triage): the FIRST status, only on the pull request THIS run opened. It
//          is never found by its link to the issue, its label or its author, all of which an
//          agent can forge. It is the one pull request that was opened after the run started,
//          from a branch that didn't exist before the run (the filter job's snapshot), whose
//          head commit is authored by the App, AT A HEAD THIS RUN'S PUSH JOB MOVED (the lane
//          spine's `push-heads` output, #324; never the agent's job, `LANE-16`). The App's email alone binds
//          nothing: every run of the shared Author App commits under it, so two overlapping
//          runs would each see both pull requests, and a run that opened none would stamp
//          another lane's. None, or more than one, and it stamps nothing and says so by name.
//   carry  (implement-revise, rebase): the status moves to the new head only when the head the
//          run started from carried one created by this App, and only to a head THIS RUN
//          PUSHED, built on exactly what it checked out (#1263). All three must hold: the new
//          head is one the run's push moved (`heads`: the spine's push job, or the rebase lane's
//          agent job) or the commit the revise lane's no-model fix pushed (`fix-sha`); the head
//          that push built on (`base`) is the head the run started from, so nothing landed between
//          the filter's read and the checkout; and every commit on the first-parent path from
//          the new head back to it is authored by the App. The email alone binds nothing, as
//          for `open`: a person's commit under the App's address, pushed below the run's tip
//          or above it, fails the second or the first. A missing input carries nothing. A
//          person's push breaks the chain, and so does a head that never had the status: the
//          lane says so, and sets none.
//
// A CHANGES-REQUEST FILED BEFORE THE STATUS IS RE-DELIVERED, ONCE (#1379). The revise lane
// refuses a head without the status, and it can't tell "not the Implementer's" from "not stamped
// yet": a review that lands between the run's push and this job's write is skipped, and nothing
// fired it again (#1374 sat six hours). So after the write, the job reads the pull request's
// reviews, and when the verdict deciding the new head, as the revise lane's label path reads it,
// is a changes-request submitted before the status, it removes and re-adds `agent:revise` with a
// third token, narrowed to Pull requests write. A review submitted after the write saw the status
// and needs nothing. The revise lane skips a re-delivered request the Implementer already
// answered, so a run that acted on it anyway costs no second round.
//
// NEVER FAILS THE LANE. Every outcome, the App lacking the permission included, is a line in
// the run's summary; the action's call is `continue-on-error` besides.
//
// Inputs, by environment: MODE, GITHUB_REPOSITORY, READ_TOKEN (contents and pull requests
// read), STATUS_TOKEN (Commit statuses write), PR_TOKEN (pull requests write), APP_SLUG,
// RUN_URL, and SINCE + BRANCHES_BEFORE + HEADS (open) or PR + START_HEAD + HEADS + BASE +
// FIX_SHA (carry).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { ensureLabels } from '../../scripts/lib/labels.mjs';
import { IMPLEMENTER_STATUS, implementerStatusOn } from '../../scripts/lib/role-marker.mjs';

/** The status context the Merger requires on the head since L4 (`mergeVerdict`). */
export const CONTEXT = IMPLEMENTER_STATUS;

/** The label that starts the Implementer's revise lane on a pull request (`K-WORK-12`). */
export const REVISE_LABEL = 'agent:revise';

/** What a GitHub API commit says about its author, as this module reads it. */
/** @typedef {{ sha: string, parents?: Array<{ sha: string }>, commit?: { author?: { email?: string } } }} ApiCommit */

/**
 * Whether the App authored `commit`: its noreply address as the author's email. The email is
 * read, not the name: the name is the bot account's (`K-AGENT-1`), and any pusher can set it.
 * @param {ApiCommit | undefined} commit
 * @param {string} email
 */
export const byApp = (commit, email) => String(commit?.commit?.author?.email ?? '').toLowerCase() === email.toLowerCase();

/**
 * The pull request this run opened, by what the run created and nothing an agent can claim.
 *
 * @param {{
 *   prs: Array<{ number: number, created_at: string, head: { ref: string, sha: string, repo?: { full_name?: string } | null } }>,
 *   repo: string, since: string, branchesBefore: string[] | null, email: string,
 *   heads: Array<{ ref?: string, sha?: string }> | null,
 *   headCommit: (sha: string) => ApiCommit | undefined,
 * }} input
 * @returns {{ pr: number, sha: string } | { none: string }}
 */
export function pickOpened({ prs, repo, since, branchesBefore, email, heads, headCommit }) {
  const t = Date.parse(since);
  if (Number.isNaN(t)) return { none: 'the run\'s start time is unknown, so no pull request can be shown to be this run\'s' };
  if (!Array.isArray(branchesBefore)) return { none: 'the branches that existed before the run are unknown, so no branch can be shown to be first pushed in it' };
  if (!Array.isArray(heads)) return { none: 'the heads the agent\'s job held are unknown, so no pull request\'s head can be shown to be the one this run pushed' };
  const before = new Set(branchesBefore);
  // THE BINDING (#324): the head this run's agent job held. The App's email, checked below
  // too, is shared by every run of the App and every Author lane, so it binds nothing alone.
  const pushed = new Set(heads.map((h) => String(h?.sha ?? '').toLowerCase()).filter((x) => /^[0-9a-f]{40}$/.test(x)));
  const candidates = prs.filter((p) =>
    p.head?.repo?.full_name === repo
    && !before.has(p.head.ref)
    && Date.parse(p.created_at) >= t
    && pushed.has(String(p.head.sha).toLowerCase())
    && byApp(headCommit(p.head.sha), email));
  if (candidates.length === 0) {
    return { none: `no open pull request was opened after the run started, from a branch first pushed in it, at a head this run's agent job pushed (${pushed.size ? `it held ${heads.slice(0, 5).map((h) => `${h.ref}@${String(h.sha).slice(0, 7)}`).join(', ')}${heads.length > 5 ? ', …' : ''}` : 'it held none'}) and the App authored` };
  }
  if (candidates.length > 1) {
    return { none: `${candidates.length} pull requests match (#${candidates.map((p) => p.number).join(', #')}), so none is provably this run's` };
  }
  const [only] = /** @type {[typeof candidates[number]]} */ (/** @type {unknown} */ (candidates));
  return { pr: only.number, sha: only.head.sha };
}

/**
 * Whether the status may move from the head the run started from to the pull request's head.
 * `heads` and `base` are what the agent's job recorded (null and '' when unknown); `fixSha` is
 * the commit the revise lane's no-model fix pushed ('' when it pushed none).
 *
 * @param {{
 *   startHead: string, head: string, slug: string, email: string,
 *   startStatuses: Array<{ context?: string, state?: string, creator?: { login?: string } | null }>,
 *   compare: { status?: string, commits?: ApiCommit[] } | null,
 *   heads: Array<{ ref?: string, sha?: string }> | null, base: string, fixSha: string,
 * }} input
 * @returns {{ carry: string } | { none: string }}
 */
export function carryDecision({ startHead, head, slug, email, startStatuses, compare, heads, base, fixSha }) {
  if (!/^[0-9a-f]{40}$/i.test(startHead)) return { none: 'the head the run started from is unknown' };
  // The same question the Merger and the rebase lane ask (`implementerStatusOn`): the NEWEST
  // status of the context is the App's success.
  const had = implementerStatusOn(startStatuses, slug);
  if (!had.ok) {
    return { none: `the head it started from, \`${startHead.slice(0, 7)}\`, is not provably the Implementer's (${had.why}), so the chain has no start` };
  }
  if (head === startHead) return { none: `the head is still \`${startHead.slice(0, 7)}\`, which already carries the status` };
  // THE BINDING (#1263), failing closed: a head this run pushed, on exactly the head it started
  // from. Unknown heads and no fix commit bind nothing; an unknown checkout is not the start.
  const pushed = new Set((Array.isArray(heads) ? heads : []).map((h) => String(h?.sha ?? '').toLowerCase()).filter((x) => /^[0-9a-f]{40}$/.test(x)));
  const fix = /^[0-9a-f]{40}$/i.test(fixSha) ? fixSha.toLowerCase() : '';
  if (!pushed.has(head.toLowerCase()) && head.toLowerCase() !== fix) {
    return { none: `the head \`${head.slice(0, 7)}\` is not one this run pushed (${Array.isArray(heads) ? `its agent's job held ${pushed.size ? [...pushed].slice(0, 5).map((x) => x.slice(0, 7)).join(', ') : 'none'}` : 'the heads its agent\'s job held are unknown'}${fix ? `, its fix pushed \`${fix.slice(0, 7)}\`` : ''}): a push after the run's is not the Implementer's` };
  }
  if (!/^[0-9a-f]{40}$/i.test(base)) return { none: 'the head the agent\'s job checked out is unknown, so nothing shows the run built on the head it started from' };
  if (base.toLowerCase() !== startHead.toLowerCase()) {
    return { none: `the agent's job checked out \`${base.slice(0, 7)}\`, not \`${startHead.slice(0, 7)}\`, the head the run started from: what landed between is not the Implementer's` };
  }
  if (!compare || compare.status !== 'ahead') {
    return { none: `the new head \`${head.slice(0, 7)}\` does not descend from \`${startHead.slice(0, 7)}\` (${compare?.status ?? 'unreadable'})` };
  }
  // THE FIRST-PARENT PATH from the new head back to the start, which is the checkout, as above;
  // every commit on it the App's. A merge's second parent is what it merged in (the default
  // branch, for the rebase lane), so its commits are other people's by design; the merge itself
  // must be the App's.
  const bySha = new Map((compare.commits ?? []).map((c) => [c.sha, c]));
  for (let sha = head, steps = 0; sha !== startHead; steps += 1) {
    const c = bySha.get(sha);
    if (!c || steps > bySha.size) {
      return { none: `the path from \`${head.slice(0, 7)}\` back to \`${startHead.slice(0, 7)}\` could not be read whole` };
    }
    if (!byApp(c, email)) {
      return { none: `commit \`${sha.slice(0, 7)}\` since \`${startHead.slice(0, 7)}\` is not the App's: a person's push ends the chain` };
    }
    sha = c.parents?.[0]?.sha ?? '';
  }
  return { carry: head };
}

/**
 * A pull request's effective patch, as the revise lane's filter fingerprints it (RA-1841): the
 * three-dot diff against its base with `index` lines, hunk headers, context lines and blank
 * lines dropped, so a merge of the base branch that changes nothing the reviewer read moves
 * nothing.
 * @param {string} diff
 */
export function patchFingerprint(diff) {
  const kept = String(diff).split('\n').filter((l) => !/^(index |@@| )/.test(l) && l.trim() !== '');
  return createHash('sha256').update(kept.join('\n')).digest('hex');
}

/**
 * Whether the run that just stamped `head` must re-deliver a changes-request to the revise lane
 * (#1379). The deciding verdict is the revise lane's label path's: the last APPROVED or
 * CHANGES_REQUESTED review on the head or on a commit carrying its content. Only a
 * changes-request submitted before the status was written was skipped for the head's lack of it.
 *
 * @param {{
 *   reviews: unknown, head: string, statusAt: string,
 *   sameContent: (sha: string) => boolean,
 * }} input  `reviews` as the REST API lists them, oldest first
 * @returns {{ redeliver: string } | { none: string }}
 */
export function redeliverDecision({ reviews, head, statusAt, sameContent }) {
  const stamped = Date.parse(statusAt);
  if (Number.isNaN(stamped)) return { none: 'the time the status was written is unknown' };
  if (!Array.isArray(reviews)) return { none: 'the pull request\'s reviews could not be read' };
  /** @type {{ state?: string, commit_id?: string, submitted_at?: string } | undefined} */
  let deciding;
  for (const r of /** @type {Array<{ state?: string, commit_id?: string, submitted_at?: string }>} */ (reviews)) {
    if (r?.state !== 'APPROVED' && r?.state !== 'CHANGES_REQUESTED') continue;
    const at = String(r.commit_id ?? '').toLowerCase();
    // A review carrying no commit decides nothing, as in the label path.
    if (at && (at === head.toLowerCase() || sameContent(at))) deciding = r;
  }
  const short = head.slice(0, 7);
  if (!deciding) return { none: `no verdict stands on \`${short}\`` };
  if (deciding.state !== 'CHANGES_REQUESTED') return { none: `the verdict deciding \`${short}\` is ${deciding.state}` };
  const submitted = Date.parse(String(deciding.submitted_at ?? ''));
  if (Number.isNaN(submitted)) return { none: `the changes-request on \`${short}\` has no time it was submitted` };
  if (submitted >= stamped) return { none: `the changes-request on \`${short}\` was submitted after the status, so its own event saw it` };
  return { redeliver: `the changes-request on \`${short}\` was submitted at ${deciding.submitted_at}, before the status, so the revise lane skipped it for the status it lacked` };
}

/* c8 ignore start -- the GitHub half; the decisions above are what the tests hold. */
/** @param {string[]} args @param {string} token */
function gh(args, token) {
  return execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
/** @param {string[]} args @param {string} token */
const ghJson = (args, token) => JSON.parse(gh(args, token));
/** @param {string} line */
function say(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function main() {
  const env = process.env;
  const repo = String(env.GITHUB_REPOSITORY);
  const slug = String(env.APP_SLUG ?? '');
  const read = String(env.READ_TOKEN ?? '');
  const write = String(env.STATUS_TOKEN ?? '');
  const lead = `**Implementer status** (\`${CONTEXT}\`, plan 0005 §3.3):`;
  if (!read || !slug) return say(`${lead} not set: the Author App (the Implementer's) could not mint a read token, so nothing could be checked.`);
  if (!write) {
    return say(`${lead} not set: the Author App (the Implementer's) could not mint a token with Commit statuses write. Grant it that permission (a broadened permission, recorded in the App register, \`K-AGENT-3\`). Without the status the Merger skips this pull request as \`not-the-implementer\`, and the revise and rebase lanes refuse it, so a person merges it.`);
  }
  const id = ghJson(['api', `users/${slug}%5Bbot%5D`], read).id;
  const host = String(env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  const email = `${id}+${slug}[bot]@users.noreply.${host}`;

  let target;
  if (env.MODE === 'open') {
    /** @type {string[] | null} */
    let branchesBefore;
    try { branchesBefore = JSON.parse(String(env.BRANCHES_BEFORE ?? '')); } catch { branchesBefore = null; }
    /** @type {Array<{ ref?: string, sha?: string }> | null} */
    let heads;
    try { heads = JSON.parse(String(env.HEADS ?? '')); } catch { heads = null; }
    const prs = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=open&per_page=100`], read).flat();
    const verdict = pickOpened({
      prs, repo, since: String(env.SINCE ?? ''), branchesBefore, email, heads,
      headCommit: (sha) => ghJson(['api', `repos/${repo}/commits/${sha}`], read),
    });
    if ('none' in verdict) return say(`${lead} not set: ${verdict.none}.`);
    target = verdict;
  } else if (env.MODE === 'carry') {
    const pr = ghJson(['api', `repos/${repo}/pulls/${env.PR}`], read);
    const startHead = String(env.START_HEAD ?? '');
    const head = String(pr.head?.sha ?? '');
    let compare = null;
    if (/^[0-9a-f]{40}$/i.test(startHead) && head !== startHead) {
      try { compare = ghJson(['api', `repos/${repo}/compare/${startHead}...${head}`], read); } catch { compare = null; }
    }
    /** @type {Array<{ ref?: string, sha?: string }> | null} */
    let heads;
    try { heads = JSON.parse(String(env.HEADS ?? '')); } catch { heads = null; }
    const verdict = carryDecision({
      startHead, head, slug, email, compare, heads, base: String(env.BASE ?? ''), fixSha: String(env.FIX_SHA ?? ''),
      startStatuses: /^[0-9a-f]{40}$/i.test(startHead) ? ghJson(['api', '--paginate', '--slurp', `repos/${repo}/commits/${startHead}/statuses?per_page=100`], write).flat() : [],
    });
    if ('none' in verdict) return say(`${lead} not carried to PR #${env.PR}: ${verdict.none}.`);
    target = { pr: Number(env.PR), sha: verdict.carry };
  } else {
    throw new Error(`MODE is \`${env.MODE}\`, not \`open\` or \`carry\``);
  }
  const posted = ghJson(['api', '-X', 'POST', `repos/${repo}/statuses/${target.sha}`, '-f', 'state=success', '-f', `context=${CONTEXT}`,
    '-f', 'description=Set by a fixed step of the Implementer\'s lane, never its agent', '-f', `target_url=${env.RUN_URL ?? ''}`], write);
  say(`${lead} set on PR #${target.pr} at \`${target.sha.slice(0, 7)}\`.`);
  // After the write only: a failed write threw above, and a head without the status is one the
  // revise lane refuses whatever the label says.
  try {
    redeliver({ repo, pr: target.pr, head: target.sha, statusAt: String(posted?.created_at ?? ''), read, prToken: String(env.PR_TOKEN ?? '') });
  } catch (e) {
    say(`**Re-delivery** (#1379): the status is set, but whether a changes-request filed before it needs re-delivering could not be settled: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
  }
}

/**
 * Re-add `agent:revise` when a changes-request was filed on `head` before its status (#1379).
 * @param {{ repo: string, pr: number, head: string, statusAt: string, read: string, prToken: string }} input
 */
function redeliver({ repo, pr, head, statusAt, read, prToken }) {
  const lead = '**Re-delivery** (#1379):';
  const reviews = ghJson(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews?per_page=100`], read).flat();
  /** @type {Map<string, string>} */
  const prints = new Map();
  let base = '';
  const fingerprint = (/** @type {string} */ sha) => {
    if (!prints.has(sha)) {
      try {
        base ||= String(ghJson(['api', `repos/${repo}/pulls/${pr}`], read).base?.ref ?? '');
        prints.set(sha, base ? patchFingerprint(gh(['api', `repos/${repo}/compare/${base}...${sha}`, '-H', 'Accept: application/vnd.github.v3.diff'], read)) : '');
      } catch {
        prints.set(sha, '');
      }
    }
    return /** @type {string} */ (prints.get(sha));
  };
  // An unreadable patch matches nothing but its own commit, so it re-delivers nothing on a guess.
  const sameContent = (/** @type {string} */ sha) => { const a = fingerprint(head); return a !== '' && a === fingerprint(sha); };
  const verdict = redeliverDecision({ reviews, head, statusAt, sameContent });
  if ('none' in verdict) return say(`${lead} nothing to re-deliver on PR #${pr}: ${verdict.none}.`);
  if (!prToken) {
    return say(`${lead} not re-delivered on PR #${pr}, though ${verdict.redeliver}: the Author App could not mint a token with Pull requests write. Add \`${REVISE_LABEL}\` to the pull request by hand.`);
  }
  ensureLabels([REVISE_LABEL], { repo, run: (a) => gh(a, prToken) });
  // Remove, then add: a label already on the pull request adds no event, so the removal is what
  // makes the add start the lane. The removal fails when the label isn't there; the add is still
  // the event.
  try {
    gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${pr}/labels/${encodeURIComponent(REVISE_LABEL)}`], prToken);
  } catch {
    // not labelled
  }
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/labels`, '-f', `labels[]=${REVISE_LABEL}`], prToken);
  say(`${lead} re-delivered PR #${pr} to the revise lane with \`${REVISE_LABEL}\`: ${verdict.redeliver}.`);
}

if (isCliEntry(import.meta.url)) {
  try {
    main();
  } catch (e) {
    say(`**Implementer status** not set: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
  }
}
/* c8 ignore stop */
