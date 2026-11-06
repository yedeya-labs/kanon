// The decision gate the implement and triage lanes run after their membership gate (kanon#1594).
//
// An issue labelled `decision:needed` waits on a person's decision (`K-WORK-24`), so its
// deliverable is an answer, not a build: an agent that builds one decides product intent in code,
// which is a person's to decide. A feeder, a person labelling by habit, or a brief can still hand
// such an issue to a lane, so the lane refuses it here, before any token is minted or model run.
// The Lead's reconcile tick and the dispatch sweep's backlog feed never label one for the
// Implementer either; this is the lane's own guard behind them.
//
// It reads the issue's labels from the event's payload (`LABELS`, the label event's
// `issue.labels`), and from GitHub with the workflow token for a dispatch, which carries none, and for
// a comment, whose payload holds the labels from before the implement lane's restart step took
// `decision:needed` off (kanon#1649).
// A read that fails admits the run, with a warning: a dispatch is a person's explicit act, and
// refusing it on a flaky read would be the silent stop this gate exists to replace with a word.
//
// It writes `admit=true|false` to the step's outputs, and on a refusal says why in the run's
// summary and, when `COMMENT` is `true` (the implement lane, whose caller grants `issues: write`),
// in one comment on the issue naming the label. It exits 0 either way: a refused issue is a
// skipped lane, not a red run, and it is no dispatch attempt.
//
// Node built-ins only, and `gh`.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The label that marks an issue awaiting a person's decision (`K-WORK-24`). */
export const DECISION_NEEDED = 'decision:needed';

/** The marker on the refusal's comment. */
export const REFUSAL_MARKER = '<!-- kanon:decision-gate -->';

/** Label names from a payload's `labels` (objects or names), or null when there is no list. @param {unknown} raw */
export const labelNames = (raw) => (Array.isArray(raw) ? raw.map((l) => String(typeof l === 'object' && l !== null ? /** @type {any} */ (l).name : l)) : null);

/** The comment a refused issue gets. @param {string} lane */
export const refusalComment = (lane) =>
  `${REFUSAL_MARKER}\nThe ${lane} lane didn't start: this issue carries \`${DECISION_NEEDED}\`, so it waits on a person's decision, and an agent building it would make that decision in code (K-WORK-24). Record the decision here and remove \`${DECISION_NEEDED}\`; then add the lane's label again.`;

/**
 * @param {{ env: Record<string, string | undefined>, gh?: (args: string[]) => string }} deps
 * @returns {{ admit: boolean, reason: string }}
 */
export const decide = ({ env, gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }) }) => {
  let labels = null;
  try {
    labels = labelNames(JSON.parse(env.LABELS || 'null'));
  } catch {
    labels = null;
  }
  if (labels === null || (labels.length === 0 && env.EVENT === 'workflow_dispatch')) {
    try {
      labels = labelNames(JSON.parse(gh(['api', `repos/${env.REPO}/issues/${env.ISSUE}`, '--jq', '.labels'])));
    } catch {
      labels = null;
    }
  }
  if (labels === null) return { admit: true, reason: `could not read issue #${env.ISSUE}'s labels, so whether it carries \`${DECISION_NEEDED}\` is unknown: admitting this ${env.EVENT === 'issue_comment' ? 'reply to a scope-first bail' : 'dispatch'}` };
  if (labels.includes(DECISION_NEEDED)) return { admit: false, reason: `issue #${env.ISSUE} carries \`${DECISION_NEEDED}\`: it waits on a person's decision, which an agent mustn't make in code (K-WORK-24)` };
  return { admit: true, reason: `issue #${env.ISSUE} doesn't carry \`${DECISION_NEEDED}\`` };
};

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const v = decide({ env });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `admit=${v.admit}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `**decision gate:** ${v.admit ? 'admitted' : 'refused'}: ${v.reason}\n`);
  if (!v.admit) {
    console.log(`::notice title=decision gate::${v.reason}`);
    if (env.COMMENT === 'true') {
      try {
        execFileSync('gh', ['issue', 'comment', String(env.ISSUE), '--repo', String(env.REPO), '--body', refusalComment(String(env.LANE || 'agent'))], { stdio: 'inherit' });
      } catch {
        console.log(`::warning title=decision gate::could not comment on #${env.ISSUE}; the refusal stands`);
      }
    }
  } else if (v.reason.startsWith('could not read')) console.log(`::warning title=decision gate::${v.reason}`);
}
