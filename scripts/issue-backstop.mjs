#!/usr/bin/env node
// kanon#768 — the issue-opened backstop (`K-WORK-1`). Run by the `agent-issue-backstop.yml` lane
// when an issue is opened, on the Lead's App token narrowed to Issues write.
//
// ── WHAT IT DECIDES ─────────────────────────────────────────────────────────
// Nothing of its own. `decide()` in `issue-triage-defaults.mjs` is the one copy of the routing
// table (`K-WORK-4`), the severity presence check (`K-WORK-9`) and the gate-candidate rule
// (`K-WORK-10`), and this file only reads the issue, asks it, and writes what it says. It reads
// the issue LIVE, never the webhook payload: a filer that creates and then edits opens the issue
// bare, so the payload says "no milestone" while the real one is landing (`K-WORK-2`).
//
// ── WHAT IT WRITES, AND NOTHING ELSE ────────────────────────────────────────
//   - a BUCKET milestone, only on an issue that still has none on the re-read just before the
//     write (`K-WORK-5`: `decide()` proposes nothing but `BUCKET_MILESTONES`, and this file
//     refuses anything else, so a change there can't make the lane place roadmap work);
//   - `gate-candidate`, added, on a gate-severity reviewer follow-up that lacks it;
//   - `qa:needs-severity`, added, with the rubric comment, on a reviewer follow-up with no
//     `sev:*`, unless it already carries `qa:needs-severity`. The comment opens with the Lead's
//     header line (plan 0005 §3.3), its persona read from the App register in the checkout.
// So a second run on the same issue (a re-run, or a dispatch) writes nothing new: the milestone
// is there, and each label is only added when missing. It never removes a label, never changes
// a milestone an issue has, and never reads the issue's title or body.
//
// ── AND A PULL REQUEST'S MILESTONE, TAKEN OFF (`K-WORK-7`, kanon#1242) ─────────
// A pull request never carries a milestone: GitHub counts it in the milestone's open and closed
// totals, so it inflates the burndown. With PR_NUMBER set (the lane's `pull_request_target:
// milestoned` trigger), `runPull` reads that number's milestone and whether it is a pull
// request, LIVE, and nothing else: never its title, body, diff or branch. If it is a pull request
// that still carries a milestone, it takes the milestone off, and writes one step-summary line
// saying which. A re-run finds no milestone and writes nothing.
//
// SAFE BY DEFAULT: without APPLY=1 it prints what it would write. The lane sets APPLY on the
// `issues: opened` event, and on a dispatch only when `apply` is ticked.
//
// DEPENDENCY-FREE: `node:` and `gh` only, like every script under scripts/ (`K-SELF-8`).
//
// Env: GH_TOKEN (the Lead's App token in the lane), GITHUB_REPOSITORY, ISSUE_NUMBER or
// PR_NUMBER, APPLY.
// Usage: node "$KANON/scripts/issue-backstop.mjs"
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { BUCKET_MILESTONES, GATE_CANDIDATE_LABEL, NEEDS_SEVERITY_LABEL, decide, needsSeverityComment, shadow, shadowLine } from './issue-triage-defaults.mjs';
import { appPersona } from './app-register.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { beforeApply } from './lib/labels.mjs';
import { signed } from './lib/role-marker.mjs';

/**
 * @typedef {{ name?: string } | string} Label
 * @typedef {{ labels?: Label[], milestone?: { title?: string } | null, state?: string }} Issue
 * @typedef {{ labels: string[], milestone: string }} Live
 * @typedef {{ what: string, args: string[] }} Write
 */

/** The issue as `decide()` reads it: label names and the milestone's title, '' when bare. @param {Issue} issue @returns {Live} */
export const liveOf = (issue) => ({
  labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean),
  milestone: issue.milestone?.title ?? '',
});

/**
 * The writes `decide()`'s answer asks for, as `gh` invocations, in order: the milestone, then
 * the labels, then the comment. Pure.
 * @param {number} number @param {string} repo @param {Live} live
 * @returns {{ decision: ReturnType<typeof decide>, writes: Write[] }}
 */
export function plannedWrites(number, repo, live) {
  const decision = decide(live);
  const R = ['--repo', repo];
  /** @type {Write[]} */
  const writes = [];
  if (decision.milestone) {
    // `decide()` only ever proposes a bucket. Held here too, because this is the step that writes.
    if (!BUCKET_MILESTONES.includes(decision.milestone)) throw new Error(`refusing to write "${decision.milestone}", which is not a bucket (K-WORK-5)`);
    writes.push({ what: `milestone "${decision.milestone}" (${decision.reason})`, args: ['issue', 'edit', String(number), ...R, '--milestone', decision.milestone] });
  }
  if (decision.addGateCandidate) {
    writes.push({ what: `label ${GATE_CANDIDATE_LABEL} (${decision.severity} reviewer follow-up, K-WORK-10)`, args: ['issue', 'edit', String(number), ...R, '--add-label', GATE_CANDIDATE_LABEL] });
  }
  if (decision.needsSeverity && !live.labels.includes(NEEDS_SEVERITY_LABEL)) {
    writes.push({ what: `label ${NEEDS_SEVERITY_LABEL} (reviewer follow-up with no sev:*, K-WORK-9)`, args: ['issue', 'edit', String(number), ...R, '--add-label', NEEDS_SEVERITY_LABEL] });
    writes.push({ what: 'the severity rubric comment', args: ['issue', 'comment', String(number), ...R, '--body', signed(needsSeverityComment(), 'Lead', appPersona('Lead'))] });
  }
  return { decision, writes };
}

/** @param {string} repo @param {number} number @param {(args: string[]) => string} gh @returns {Issue} */
const readIssue = (repo, number, gh) => JSON.parse(gh(['issue', 'view', String(number), '--repo', repo, '--json', 'milestone,labels,state']));

/**
 * Read the issue, decide, and (with `apply`) write. Throws on a failed read or write: the run
 * goes red, which is the signal, since nothing else re-runs the backstop on this issue.
 * @param {{ repo: string, number: number, apply: boolean, gh: (args: string[]) => string, log?: (line: string) => void, summary?: (text: string) => void }} io
 * @returns {{ live: Live, writes: Write[], written: Write[] }}
 */
export function run({ repo, number, apply, gh, log = () => {}, summary = () => {} }) {
  const live = liveOf(readIssue(repo, number, gh));
  const { decision, writes } = plannedWrites(number, repo, live);
  const s = shadow(live);
  if (s) log(shadowLine(s));
  const lines = [`### Issue backstop: #${number} (K-WORK-1)`, ''];
  lines.push(live.milestone ? `Milestone: \`${live.milestone}\`, left as it is.` : `Milestone: none; ${decision.milestone ? `the bucket is \`${decision.milestone}\` (${decision.reason}).` : 'nothing to write.'}`);
  /** @type {Write[]} */
  const written = [];
  if (!writes.length) lines.push('Nothing to write.');
  for (const w of writes) {
    if (!apply) {
      lines.push(`- would write ${w.what} (dry run)`);
      continue;
    }
    gh(w.args);
    written.push(w);
    lines.push(`- wrote ${w.what}`);
  }
  if (s) lines.push('', shadowLine(s));
  summary(`${lines.join('\n')}\n`);
  return { live, writes, written };
}

/**
 * The `gh` call that takes a pull request's milestone off, through the issues endpoint, which
 * holds a pull request's milestone and takes the App's Issues write. Pure.
 * @param {string} repo @param {number} number @returns {string[]}
 */
export const unmilestoneArgs = (repo, number) => ['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`, '-F', 'milestone=null', '--silent'];

/**
 * What the pull-request path reads: the milestone's title and whether the number is a pull
 * request, and nothing of the pull request's text (`K-AGENT-45`). Pure.
 * @param {string} repo @param {number} number @returns {string[]}
 */
export const pullReadArgs = (repo, number) => ['api', `repos/${repo}/issues/${number}`, '--jq', '{milestone: (.milestone.title // ""), pull: (.pull_request != null)}'];

/**
 * A pull request's milestone, taken off (`K-WORK-7`). Reads the number live; refuses an issue
 * (this path is the pull request's alone, and an issue's milestone is the backstop's to set,
 * never to clear); writes nothing on a pull request with no milestone. Throws on a failed read or
 * write, so the run goes red.
 * @param {{ repo: string, number: number, apply: boolean, gh: (args: string[]) => string, summary?: (text: string) => void }} io
 * @returns {{ milestone: string, removed: boolean }}
 */
export function runPull({ repo, number, apply, gh, summary = () => {} }) {
  const live = /** @type {{ milestone?: string, pull?: boolean }} */ (JSON.parse(gh(pullReadArgs(repo, number))));
  if (live.pull !== true) throw new Error(`#${number} is not a pull request, and this path takes a milestone off a pull request only`);
  const milestone = live.milestone ?? '';
  const lines = [`### Pull request backstop: #${number} (K-WORK-7)`, ''];
  let removed = false;
  if (!milestone) lines.push('No milestone: nothing to write.');
  else if (!apply) lines.push(`- would take the milestone \`${milestone}\` off (dry run): a pull request never carries a milestone (K-WORK-7)`);
  else {
    gh(unmilestoneArgs(repo, number));
    removed = true;
    lines.push(`- took the milestone \`${milestone}\` off: a pull request never carries a milestone, since GitHub counts it in the milestone's totals (K-WORK-7)`);
  }
  summary(`${lines.join('\n')}\n`);
  return { milestone, removed };
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('issue-backstop: GITHUB_REPOSITORY must be set');
    process.exitCode = 2;
    return;
  }
  const pull = Boolean(process.env.PR_NUMBER);
  const number = Number(pull ? process.env.PR_NUMBER : process.env.ISSUE_NUMBER);
  if (!Number.isInteger(number) || number < 1) {
    console.log(pull
      ? `::error title=issue-backstop::needs a pull request number in PR_NUMBER (got "${process.env.PR_NUMBER}")`
      : `::error title=issue-backstop::needs an issue number in ISSUE_NUMBER (got "${process.env.ISSUE_NUMBER ?? ''}")`);
    process.exitCode = 1;
    return;
  }
  const gh = (/** @type {string[]} */ args) => {
    beforeApply(args, (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const summary = (/** @type {string} */ text) => {
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  };
  try {
    const apply = process.env.APPLY === '1';
    if (pull) runPull({ repo, number, apply, gh, summary });
    else run({ repo, number, apply, gh, log: (line) => console.error(line), summary });
  } catch (e) {
    const err = /** @type {{ message?: string, stderr?: string }} */ (e);
    console.log(`::error title=issue-backstop::#${number}: ${String(err?.stderr || err?.message || e).split('\n')[0]}`);
    process.exitCode = 1;
  }
}

if (isCliEntry(import.meta.url)) main();
