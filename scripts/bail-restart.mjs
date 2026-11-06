#!/usr/bin/env node
// kanon#1649 — a scope-first bail waits for a person where they can see it, and their reply
// restarts the work (the Owner's decision of 2026-11-06, option A).
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// The Implementer stops on a scope-first bail (`K-AGENT-13`) with its plan and "Reply approved
// and I'll build exactly this". The run ended green, the issue kept `agent:implement`, and nothing
// said a person was owed an answer: no `decision:needed`, so `kanon inbox` listed nothing. And a
// reply restarted nothing, since the implement caller started only on a label or a dispatch, so
// the work waited for the dispatch sweep's daily tick, or for someone who knew which lane to run.
//
// ── WHAT IT DOES, BY MODE ───────────────────────────────────────────────────
//   MODE=ask      after a green implement run (its `bail-ask` job): when the Implementer's last
//                 word on the issue is a scope-first bail posted during this run, it labels the
//                 issue `decision:needed` and posts the ask in `K-WORK-24`'s fixed form, linking
//                 the bail, so `kanon inbox` lists it. An issue that carries the label already is
//                 left alone. The ask promises that a reply restarts the run only when the caller
//                 takes `issue_comment` (kanon#1678): it reads the caller's file at the ref that
//                 started this run (`github.workflow_ref`, the caller's in a called workflow). A
//                 caller written before #1649 has no `issue_comment`, so a reply starts nothing
//                 there, and the ask says how to restart by hand instead. When it can't read the
//                 caller, the ask says so, and how to restart by hand if no run starts.
//   MODE=restart  in the lane's `filter` job, on an `issue_comment` the membership gate admitted:
//                 it restarts the run (`restart=true`) when the issue still carries
//                 `decision:needed`, the Implementer's last word is a scope-first bail, and the
//                 comment came after it from someone other than an App. It takes
//                 `decision:needed` off BEFORE the run goes on, so a later reply restarts nothing,
//                 and a gate that refuses a labelled issue admits this one. Anything else is
//                 `restart=false`, and every later job skips.
//                 TAKING THE LABEL OFF IS THE CLAIM (kanon#1677). Two replies close together each
//                 start a run, and both can read `decision:needed` before either takes it off. So
//                 the label comes off through the endpoint that answers 404 when the issue no
//                 longer carries it, and only the run whose removal succeeds restarts. The other
//                 says another reply took it, and starts nothing.
//
// The default token, in both modes: its comment reads as `github-actions`, never as the
// Implementer, so the bail stays the Implementer's last word; and its label edits start no
// workflow.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY (required), ISSUE, MODE, SINCE (ask: when the run started),
//      WORKFLOW_REF (ask: `github.workflow_ref`, the caller's file and ref), COMMENT_ID (restart:
//      the triggering comment), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseAppRegister } from './app-register.mjs';
import { BAIL_RE } from './project-digest.mjs';
import { DECISION_LABEL, askBody } from './lib/decision-asks.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { beforeApply } from './lib/labels.mjs';

/** @typedef {{ id: number, body?: string | null, created_at: string, html_url?: string, user?: { login?: string, type?: string } | null }} Comment */

/** Is this comment a scope-first bail? The phrase the Implementer's prompt opens one with. @param {string | null | undefined} body */
export const isBail = (body) => BAIL_RE.test(String(body ?? ''));

/** `comments` oldest first. @param {Comment[]} comments */
const ordered = (comments) => [...comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

/** The Implementer's last comment, by its App's login (`<slug>[bot]`), or null. @param {Comment[]} comments @param {string} implementer */
export function lastWordOf(comments, implementer) {
  return ordered(comments).filter((c) => c.user?.login === implementer).at(-1) ?? null;
}

/**
 * The caller file and ref in `github.workflow_ref` (`owner/repo/path@ref`), when it is a file of
 * this repository; else null.
 * @param {string | undefined} workflowRef @param {string} repo
 * @returns {{ path: string, ref: string } | null}
 */
export function callerOf(workflowRef, repo) {
  const m = /^([^/]+\/[^/]+)\/(.+?)@(.+)$/.exec(String(workflowRef ?? ''));
  if (!m || m[1]?.toLowerCase() !== repo.toLowerCase()) return null;
  return { path: /** @type {string} */ (m[2]), ref: /** @type {string} */ (m[3]) };
}

/**
 * Does a caller's `on:` take `issue_comment`? Read from the text: a lane step has no YAML parser
 * (it runs outside any install), and the caller is a short file `kanon init` wrote. Comments are
 * dropped, and a quoted name, as in an `if:`, is not a trigger.
 * @param {string} text
 */
export function takesComments(text) {
  const bare = String(text).split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  return /(^|[\s[,{])issue_comment\s*(?=[:,\]}]|$)/m.test(bare);
}

/**
 * The ask posted for a bail, in the fixed form (`K-WORK-24`). It promises that a reply restarts
 * the Implementer only when the caller takes `issue_comment` (`restarts` true); otherwise it says
 * how to restart it by hand (kanon#1678): `false` when the caller takes no `issue_comment`, `null`
 * when the lane couldn't read the caller.
 * @param {string} bailUrl @param {boolean | null} [restarts]
 */
export function bailAsk(bailUrl, restarts = true) {
  const question = `The Implementer stopped on a scope-first bail and posted its plan (${bailUrl}). Should it build that plan?`;
  if (restarts !== true) {
    const restart = 'then remove `decision:needed` and apply `agent:implement` again, or dispatch the implement lane with this issue\'s number';
    return askBody({
      question,
      options: [
        `Approve: reply \`approved\`, with any changes, ${restart}. The Implementer restarts and builds the plan.`,
        `Change it: reply with what to change, ${restart}. The Implementer restarts and reads your reply.`,
        'Drop it: remove `agent:implement`. Nothing restarts.',
      ],
      recommendation: restarts === false
        ? 'Read the plan and reply on this issue. This repository\'s implement caller takes no `issue_comment`, so a reply alone restarts nothing: restart it by hand as above. Adding the trigger, as `kanon doctor` says, makes a reply restart it.'
        : 'Read the plan and reply on this issue. The lane could not read this repository\'s implement caller, so it can\'t tell whether a reply restarts the Implementer: if no implement run starts after your reply, restart it by hand as above.',
    });
  }
  return askBody({
    question,
    options: [
      'Approve: reply `approved`, with any changes. The Implementer restarts at once and builds the plan.',
      'Change it: reply with what to change. The Implementer restarts at once and reads your reply.',
      'Drop it: remove `agent:implement`. Nothing restarts.',
    ],
    recommendation: 'Read the plan, and reply on this issue: any reply from a member restarts the Implementer, and takes `decision:needed` off.',
  });
}

/**
 * Take `decision:needed` off as the restart's claim (kanon#1677): `remove` calls the endpoint
 * that answers 404 when the issue doesn't carry the label. True when this call took it off;
 * false on a 404, when another reply's run took it first. Any other failure is thrown.
 * @param {() => unknown} remove
 */
export function claimLabel(remove) {
  try {
    remove();
    return true;
  } catch (e) {
    const err = /** @type {{ message?: string, stderr?: unknown }} */ (e);
    if (/HTTP 404/.test(`${err.message ?? ''}\n${String(err.stderr ?? '')}`)) return false;
    throw e;
  }
}

/**
 * MODE=ask: whether to label the issue and post the ask. `restarts`: whether the caller takes
 * `issue_comment`, so a reply restarts the run.
 * @param {{ comments: Comment[], implementer: string, labels: string[], since: string, restarts?: boolean | null }} c
 * @returns {{ ask: false, why: string } | { ask: true, body: string }}
 */
export function askStep({ comments, implementer, labels, since, restarts = true }) {
  if (labels.includes(DECISION_LABEL)) return { ask: false, why: `it carries \`${DECISION_LABEL}\` already` };
  const last = lastWordOf(comments, implementer);
  if (!last || !isBail(last.body)) return { ask: false, why: "the Implementer's last word is not a scope-first bail" };
  const t = Date.parse(since);
  if (Number.isNaN(t) || Date.parse(last.created_at) < t) return { ask: false, why: 'the bail was not posted during this run' };
  return { ask: true, body: bailAsk(last.html_url ?? '', restarts) };
}

/**
 * MODE=restart: whether this comment restarts the run.
 * @param {{ comments: Comment[], implementer: string, labels: string[], commentId: number }} c
 * @returns {{ restart: boolean, why: string }}
 */
export function restartStep({ comments, implementer, labels, commentId }) {
  if (!labels.includes(DECISION_LABEL)) return { restart: false, why: `it no longer carries \`${DECISION_LABEL}\`, so nothing waits on a reply` };
  const reply = comments.find((c) => c.id === commentId);
  if (!reply) return { restart: false, why: `comment ${commentId} is not on the issue` };
  if (reply.user?.type === 'Bot' || /\[bot\]$/.test(reply.user?.login ?? '')) return { restart: false, why: 'an App wrote the comment' };
  const before = comments.filter((c) => Date.parse(c.created_at) <= Date.parse(reply.created_at) && c.id !== commentId);
  const last = lastWordOf(before, implementer);
  if (!last || !isBail(last.body)) return { restart: false, why: "the Implementer's last word before the comment is not a scope-first bail" };
  if (lastWordOf(comments, implementer)?.id !== last.id) return { restart: false, why: 'the Implementer has spoken since' };
  return { restart: true, why: `a reply to the Implementer's scope-first bail (${last.html_url ?? last.id})` };
}

/* c8 ignore start — the CLI: `gh` calls around the two steps. */
if (isCliEntry(import.meta.url)) {
  const REPO = process.env.GITHUB_REPOSITORY;
  if (!REPO) {
    console.error('bail-restart: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const ISSUE = String(process.env.ISSUE ?? '');
  const MODE = process.env.MODE ?? '';
  const say = (/** @type {string} */ line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const output = (/** @type {string} */ line) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`); };
  /** A label it applies is created first, if the repository lacks it (plan 0005 §5.3). @param {string[]} args */
  const gh = (args) => {
    beforeApply(args, (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  };
  if (MODE === 'restart') output('restart=false');
  try {
    if (!/^\d+$/.test(ISSUE) || !['ask', 'restart'].includes(MODE)) throw new Error(`ISSUE must be a number and MODE ask or restart (got ${ISSUE || 'nothing'}, ${MODE || 'nothing'})`);
    const register = gh(['api', `repos/${REPO}/contents/docs/qa/agent-identities.md`, '-H', 'Accept: application/vnd.github.raw']);
    const slug = parseAppRegister(register).get('Implementer');
    if (!slug) throw new Error('the App register lists no Implementer App');
    const implementer = `${slug}[bot]`;
    /** @type {Comment[]} */
    const comments = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${REPO}/issues/${ISSUE}/comments?per_page=100`])).flat();
    /** @type {string[]} */
    const labels = JSON.parse(gh(['api', `repos/${REPO}/issues/${ISSUE}/labels?per_page=100`])).map((/** @type {{ name: string }} */ l) => l.name);
    if (MODE === 'ask') {
      // Whether a reply restarts the run: the caller's own triggers, at the ref that started it (kanon#1678).
      /** @type {boolean | null} */
      let restarts = null;
      const caller = callerOf(process.env.WORKFLOW_REF, REPO);
      try {
        if (!caller) throw new Error(`\`${process.env.WORKFLOW_REF || 'nothing'}\` names no file of ${REPO}`);
        restarts = takesComments(gh(['api', `repos/${REPO}/contents/${caller.path}?ref=${encodeURIComponent(caller.ref)}`, '-H', 'Accept: application/vnd.github.raw']));
      } catch (e) {
        say(`Bail: could not read the implement caller (${String(/** @type {Error} */ (e).message).split('\n')[0]}), so the ask says how to restart by hand.`);
      }
      const d = askStep({ comments, implementer, labels, since: process.env.SINCE ?? '', restarts });
      if (!d.ask) say(`Bail: nothing to ask on #${ISSUE}: ${d.why}.`);
      else {
        gh(['issue', 'edit', ISSUE, '--repo', REPO, '--add-label', DECISION_LABEL]);
        gh(['api', `repos/${REPO}/issues/${ISSUE}/comments`, '-f', `body=${d.body}`]);
        say(`Bail: #${ISSUE} waits on a person's decision; labelled \`${DECISION_LABEL}\` and asked in the fixed form (kanon#1649).`);
      }
    } else {
      const d = restartStep({ comments, implementer, labels, commentId: Number(process.env.COMMENT_ID) });
      if (!d.restart) say(`Restart: not restarting #${ISSUE}: ${d.why}.`);
      else {
        // Off BEFORE the run goes on: a gate that refuses `decision:needed` admits it, and a second
        // reply restarts nothing. The removal is the claim: it answers 404 to every run but the
        // first, when two replies' runs both got this far (kanon#1677).
        if (!claimLabel(() => gh(['api', '-X', 'DELETE', `repos/${REPO}/issues/${ISSUE}/labels/${encodeURIComponent(DECISION_LABEL)}`]))) {
          say(`Restart: not restarting #${ISSUE}: another reply's run took \`${DECISION_LABEL}\` off first, and restarts it (kanon#1677).`);
        } else {
          output('restart=true');
          say(`Restart: #${ISSUE}: ${d.why}. Took \`${DECISION_LABEL}\` off; the Implementer restarts (kanon#1649).`);
        }
      }
    }
  } catch (e) {
    console.log(`::warning title=bail-restart::${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
  }
}
/* c8 ignore stop */
