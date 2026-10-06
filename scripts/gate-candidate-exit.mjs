#!/usr/bin/env node
// kanon#171 — `gate-candidate` comes off an issue once the Stakeholder has decided it
// (`K-WORK-10`). Run by the Lead's daily dispatch sweep, after its own reconcile, on the same
// App token; it adds no schedule of its own.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// The Stakeholder's queue is `is:issue is:open label:gate-candidate`. Agents only ever ADD
// the label, and nothing took it off, so the queue only grew: a candidate the Stakeholder
// placed on the launch gate, or declined, read exactly like one still waiting. "Decided" was
// indistinguishable from "pending", which is the one thing the queue is for.
//
// ── THE TWO DECISIONS, AND HOW EACH IS READ ─────────────────────────────────
//  - PLACED: the issue sits on a roadmap milestone (`isRoadmapMilestone`: open and dated).
//    The placement is the record, and it is the Stakeholder's own act (`K-WORK-5`,
//    `K-WORK-22`); this script never writes a milestone.
//  - DECLINED: the issue carries `gate:declined`, which only a person applies. A label and not
//    a comment, because the sweep reads it from the same list call that finds the candidates,
//    with no per-issue read and no prose to parse, and because it stays on the issue as the
//    record of the decision once `gate-candidate` is gone.
// Both at once is a contradiction this script does not resolve: it leaves the label, so the
// issue stays in the queue, and says so.
//
// ── WHAT IT WRITES ──────────────────────────────────────────────────────────
// It only REMOVES `gate-candidate`, from an open issue already decided. It never adds a label,
// never writes a milestone and never closes anything, so it transcribes a decision rather than
// making one. The issue's timeline keeps who removed it and when.
//
// NON-FATAL, like the sweep that runs it: a failed read or write is a ::warning:: and exit 0.
// Nothing is lost by a missed tick: the queue still lists the issue, and the next tick retries.
// SAFE BY DEFAULT: without APPLY=1 (or --apply) it prints what it would remove.
//
// DEPENDENCY-FREE: `node:` and `gh` only, like every script under scripts/ (`K-SELF-8`).
//
// Env: GH_TOKEN (the Lead's App token in the sweep), GITHUB_REPOSITORY, APPLY.
// Usage: node "$KANON/scripts/gate-candidate-exit.mjs" [--apply]

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { GATE_CANDIDATE_LABEL } from './issue-triage-defaults.mjs';
import { isRoadmapMilestone } from './lib/milestones.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The Stakeholder's "not on the gate". Applied by a person only, never by a lane. */
export const GATE_DECLINED_LABEL = 'gate:declined';

/** The Stakeholder's queue, as `K-WORK-10` states it. */
export const GATE_CANDIDATE_QUERY = `is:issue is:open label:${GATE_CANDIDATE_LABEL}`;

/**
 * @typedef {{ name?: string } | string} Label
 * @typedef {{ title?: string, due_on?: string | null, dueOn?: string | null, state?: string } | null | undefined} Milestone
 * @typedef {{ number: number, state?: string, pull_request?: unknown, labels?: Label[], milestone?: Milestone }} Issue
 * @typedef {'placed' | 'declined' | 'conflict' | null} Decision
 */

/**
 * Label names, lowercased: GitHub matches label names case-insensitively, so `Gate:Declined`
 * is the same label and must read as one.
 * @param {Issue} issue
 */
const labelNames = (issue) =>
  (issue.labels ?? []).map((l) => ((typeof l === 'string' ? l : l?.name) ?? '').toLowerCase());

/**
 * What the Stakeholder decided about a `gate-candidate`, or null while it still waits. Reads
 * the issue only; whether it carries `gate-candidate` is the caller's question.
 * @param {Issue} issue
 * @returns {Decision}
 */
export function gateCandidateDecision(issue) {
  const placed = isRoadmapMilestone(issue.milestone);
  const declined = labelNames(issue).includes(GATE_DECLINED_LABEL);
  if (placed && declined) return 'conflict';
  if (placed) return 'placed';
  if (declined) return 'declined';
  return null;
}

/**
 * REST `/issues` items → what to do. Pull requests, closed issues and issues without the label
 * are dropped, so the plan is right whatever the caller fetched.
 * @param {Issue[]} items
 * @returns {{ retire: { number: number, decision: 'placed' | 'declined', milestone: string | null }[], conflicts: number[], awaiting: number[] }}
 */
export function exitPlan(items) {
  const candidates = items.filter((i) => !i.pull_request && (i.state ?? 'open') === 'open'
    && labelNames(i).includes(GATE_CANDIDATE_LABEL.toLowerCase()));
  /** @type {{ number: number, decision: 'placed' | 'declined', milestone: string | null }[]} */
  const retire = [];
  /** @type {number[]} */
  const conflicts = [];
  /** @type {number[]} */
  const awaiting = [];
  for (const i of candidates) {
    const d = gateCandidateDecision(i);
    if (d === 'conflict') conflicts.push(i.number);
    else if (d === null) awaiting.push(i.number);
    else retire.push({ number: i.number, decision: d, milestone: d === 'placed' ? i.milestone?.title ?? null : null });
  }
  return { retire, conflicts, awaiting };
}

/**
 * The step summary. Every state renders, so an empty run and a run that never read look
 * different.
 * @param {ReturnType<typeof exitPlan>} plan
 * @param {{ apply: boolean, removed?: number[], failed?: number[] }} opts
 */
export function renderSummary(plan, { apply, removed = [], failed = [] }) {
  const lines = [`### \`${GATE_CANDIDATE_LABEL}\` exit (K-WORK-10)`, ''];
  lines.push(`${plan.awaiting.length} awaiting the Stakeholder, ${plan.retire.length} decided, ${plan.conflicts.length} contradictory.`);
  for (const r of plan.retire) {
    const why = r.decision === 'placed' ? `placed on ${r.milestone ?? 'a roadmap milestone'}` : `declined (\`${GATE_DECLINED_LABEL}\`)`;
    const done = !apply ? 'would remove the label (dry run)' : removed.includes(r.number) ? 'label removed' : failed.includes(r.number) ? 'removal FAILED, retried next tick' : 'not attempted';
    lines.push(`- #${r.number}: ${why}; ${done}`);
  }
  for (const n of plan.conflicts) {
    lines.push(`- #${n}: on a roadmap milestone AND \`${GATE_DECLINED_LABEL}\`; label left on, the Stakeholder decides which`);
  }
  return `${lines.join('\n')}\n`;
}

// ── I/O ────────────────────────────────────────────────────────────────────

/** @param {string} msg */
const warn = (msg) => console.log(`::warning title=gate-candidate-exit::${msg.replace(/\r?\n/g, ' ')}`);

/**
 * Every open issue carrying the label, through core REST (no search budget), to the last page.
 * @param {string} repo
 * @param {(args: string[]) => string} gh
 * @param {number} [maxPages]
 * @returns {Issue[]}
 */
export function readCandidates(repo, gh, maxPages = 10) {
  /** @type {Issue[]} */
  const items = [];
  for (let page = 1; ; page++) {
    const r = JSON.parse(gh(['api', `repos/${repo}/issues?state=open&labels=${encodeURIComponent(GATE_CANDIDATE_LABEL)}&per_page=100&page=${page}`]));
    if (!Array.isArray(r)) throw new Error('the issues endpoint did not return a list');
    items.push(...r);
    if (r.length < 100) return items;
    if (page >= maxPages) throw new Error(`more than ${maxPages * 100} open items carry ${GATE_CANDIDATE_LABEL}`);
  }
}

/**
 * Read, plan, and (with `apply`) remove the label from each decided candidate. Never throws.
 * @param {{ repo: string, apply: boolean, gh: (args: string[]) => string, summary?: (text: string) => void }} io
 */
export function run({ repo, apply, gh, summary = () => {} }) {
  let items;
  try {
    items = readCandidates(repo, gh);
  } catch (e) {
    warn(`could not read the ${GATE_CANDIDATE_LABEL} issues, so none was retired this tick: ${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]}`);
    summary(`### \`${GATE_CANDIDATE_LABEL}\` exit (K-WORK-10)\n\nThe candidates could not be read; nothing was removed. Check \`${GATE_CANDIDATE_QUERY}\` by hand.\n`);
    return { plan: null, removed: [], failed: [] };
  }
  const plan = exitPlan(items);
  /** @type {number[]} */
  const removed = [];
  /** @type {number[]} */
  const failed = [];
  if (apply) {
    for (const r of plan.retire) {
      try {
        gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${r.number}/labels/${encodeURIComponent(GATE_CANDIDATE_LABEL)}`]);
        removed.push(r.number);
      } catch (e) {
        // Gone already (a person took it off between the read and now): the outcome is the same.
        if (/\b404\b|Label does not exist/i.test(String(/** @type {{ stderr?: string }} */ (e)?.stderr ?? '') + String(/** @type {Error} */ (e)?.message ?? ''))) {
          removed.push(r.number);
          continue;
        }
        failed.push(r.number);
        warn(`#${r.number}: removing ${GATE_CANDIDATE_LABEL} failed: ${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]}`);
      }
    }
  }
  for (const n of plan.conflicts) warn(`#${n} is on a roadmap milestone and carries ${GATE_DECLINED_LABEL}; ${GATE_CANDIDATE_LABEL} left on for the Stakeholder`);
  summary(renderSummary(plan, { apply, removed, failed }));
  return { plan, removed, failed };
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    warn('GITHUB_REPOSITORY is not set; nothing to read');
    return;
  }
  const apply = process.argv.includes('--apply') || process.env.APPLY === '1';
  const gh = (/** @type {string[]} */ args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const summary = (/** @type {string} */ text) => {
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  };
  run({ repo, apply, gh, summary });
}

if (isCliEntry(import.meta.url)) main();
