#!/usr/bin/env node
// kanon#609 — the backlog feeder. Run by the Lead's daily dispatch sweep, after its own
// reconcile, on the same App token; it adds no schedule of its own.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// The implement → review → merge cascade is complete, but nothing fed it from the backlog:
// `agent:implement` came only from a person or from the Lead's reconciler for a project
// member. Measured on the reference adopter: 126 open reviewer follow-ups, each already a spec
// (a file cite, a failure scenario, a severity), and 4 issues carrying the label. The pipeline
// idled while its own output piled up. This is the valve.
//
// ── EACH TICK ───────────────────────────────────────────────────────────────
//  1. The valve. `QA_BACKLOG_FEED` (a repository variable) is how many issues a tick may
//     feed. Unset or 0 is closed, the default: nothing is read and nothing is written.
//  2. Capacity. The implementer slots in use are counted across EVERY open `agent:implement`
//     issue with the reconciler's `occupiesSlot`, parked-on-a-human read exactly as
//     `readWorld` reads it (`parkedRead`). No action at `QA_LEAD_GLOBAL_WIP` or above, and
//     none while an issue this feeder fed still occupies a slot. Projects keep priority: the
//     feeder only takes a slot the reconciler left free. A fed issue whose run bailed is
//     parked once the sweep reads it as `awaiting-human`, so it frees the feeder too; a
//     label-only check held it "in flight" forever (the adopter's first-bail bug).
//  3. Selection (`ineligibility`, `selectFeed`). An open reviewer follow-up (`follow-up` +
//     `agent:reviewer`) at `sev:medium` or `sev:low`, on a bucket milestone named in
//     `QA_BACKLOG_MILESTONES` (default Product Backlog), carrying none of the labels that
//     mean a person, a project, a split or a gate owns it, not a project member, and never
//     one this feeder fed before or the Implementer already posted on, whoever dispatched it.
//     `sev:medium` before `sev:low`, then oldest first.
//  4. Dispatch. Adds `agent:implement`, which raises the `issues: labeled` event the
//     implement lane starts on, then posts the `<!-- qa:backlog-feed -->` marker naming the
//     tick and why this issue.
//  5. Report. The step summary says the slots in use, the candidates, the one chosen and
//     why, or why nothing: never a silent no-op.
//
// STATELESS, LIKE THE SWEEP. Its only memory is the marker comments it left.
//
// NON-FATAL, like the sweep that runs it: a failed read or write is a ::warning:: and exit 0.
// A missed tick feeds nothing, which is the safe direction.
// SAFE BY DEFAULT: without APPLY=1 (or --apply) it prints what it would feed.
//
// DEPENDENCY-FREE: `node:` and `gh` only, like every script under scripts/ (`K-SELF-8`).
//
// Env: GH_TOKEN (the Lead's App token in the sweep), GITHUB_REPOSITORY, APPLY,
//      QA_BACKLOG_FEED, QA_BACKLOG_MILESTONES.
// Usage: node "$KANON/scripts/backlog-feed.mjs" [--apply]

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { appPersona } from './app-register.mjs';
import { makeCommentsReader } from './dispatch-sweep.mjs';
import {
  DEFAULT_MILESTONE, GATE_CANDIDATE_LABEL, isReviewerFollowUp, severityOf,
} from './issue-triage-defaults.mjs';
import {
  GLOBAL_WIP_DEFAULT, HUMAN_ACTION, laneStateOf, linkedPrsRead, occupiesSlot, parkedRead,
} from './lead-reconcile.mjs';
import { SPLIT_LABEL } from './split-lineage.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { isDatedMilestone } from './lib/milestones.mjs';
import { markedRole, signed } from './lib/role-marker.mjs';

/** The feeder's own record that it fed an issue. Changing it re-feeds every issue it fed. */
export const FEED_MARKER = '<!-- qa:backlog-feed -->';

const IMPLEMENT = 'agent:implement';

/**
 * Labels that take an issue out of the feed: dispatched already, owed by a person, awaiting a
 * split, parked with its project, untriaged, a project's verification, or a gate question.
 */
export const EXCLUDED_LABELS = [
  IMPLEMENT, 'qa:needs-info', HUMAN_ACTION, SPLIT_LABEL, 'blocked', 'qa:needs-triage', 'qa:verify', GATE_CANDIDATE_LABEL,
];

/** The severities the feeder takes, in the order it takes them. A gate severity is the Stakeholder's. */
export const FEED_SEVERITIES = ['sev:medium', 'sev:low'];

/** Any project's membership marker, wherever it sits in the body: the reconciler owns it. */
const PROJECT_MARKER = /<!--\s*qa:project\s+\d+\s*-->/;
const PROJECT_LABEL = /^project:\d+$/;

/**
 * @typedef {{ name?: string } | string} Label
 * @typedef {{ title?: string, due_on?: string | null, dueOn?: string | null, state?: string } | null | undefined} Milestone
 * @typedef {{ number: number, title?: string, state?: string, pull_request?: unknown, body?: string | null, labels?: Label[], milestone?: Milestone, created_at?: string }} Issue
 * @typedef {{ number: number, occupies: boolean, fed: boolean }} Slot
 * @typedef {{ body: string }} Comment
 * @typedef {{ number: number, title: string, severity: string, reason: string }} Choice
 * @typedef {'closed' | 'fed-in-flight' | 'full' | 'none-eligible' | 'all-handled' | 'fed'} Why
 * @typedef {{ valve: number, globalWip: number, milestones: string[], inUse: number[], fedInFlight: number[], followUps: number, eligible: number, chosen: Choice[], skipped: { number: number, why: string }[], why: Why }} Plan
 */

/** @param {Issue} issue */
const labelNames = (issue) =>
  (issue.labels ?? []).map((l) => ((typeof l === 'string' ? l : l?.name) ?? '').toLowerCase());

/**
 * `QA_BACKLOG_FEED` as a count. Unset, empty or 0 is the closed valve. Anything that is not a
 * whole number is closed too, and said, so a typo never opens it.
 * @param {string | undefined} raw
 * @returns {{ n: number, note: string | null }}
 */
export function feedValve(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { n: 0, note: null };
  if (!/^\d+$/.test(s)) return { n: 0, note: `\`QA_BACKLOG_FEED\` is \`${s}\`, which is not a whole number, so the valve reads as closed.` };
  return { n: Number(s), note: null };
}

/**
 * `QA_BACKLOG_MILESTONES`: the bucket milestones to feed from, comma-separated. Default
 * Product Backlog, the bucket a product follow-up lands on.
 * @param {string | undefined} raw
 */
export function feedMilestones(raw) {
  const list = String(raw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return list.length ? list : [DEFAULT_MILESTONE];
}

/**
 * Why this issue is not one to feed, or null when it is. Reads the issue alone: whether it
 * was fed before is in its comments (`handledBefore`).
 * @param {Issue} issue
 * @param {{ milestones: string[] }} opts
 * @returns {string | null}
 */
export function ineligibility(issue, { milestones }) {
  if (issue.pull_request) return 'a pull request';
  if ((issue.state ?? 'open').toLowerCase() !== 'open') return 'not open';
  const labels = labelNames(issue);
  if (!isReviewerFollowUp(labels)) return 'not a reviewer follow-up (`follow-up` + `agent:reviewer`)';
  const excluded = EXCLUDED_LABELS.find((l) => labels.includes(l.toLowerCase()));
  if (excluded) return `carries \`${excluded}\``;
  const sev = severityOf(labels);
  if (sev === null) return 'carries no severity';
  if (!FEED_SEVERITIES.includes(sev)) return `carries \`${sev}\`, a gate severity`;
  if (PROJECT_MARKER.test(issue.body ?? '') || labels.some((l) => PROJECT_LABEL.test(l))) return 'a project member: the reconciler dispatches it';
  const m = issue.milestone;
  if (!m?.title) return 'on no milestone';
  const named = milestones.some((t) => t.toLowerCase() === String(m.title).toLowerCase());
  if (!named) return `on ${m.title}, which \`QA_BACKLOG_MILESTONES\` does not name`;
  if (isDatedMilestone(m)) return `on ${m.title}, a roadmap milestone (it has a due date), not a bucket`;
  return null;
}

/**
 * Has this issue been through the Implementer before? `fed`: it carries this feeder's marker.
 * `implementer`: the Implementer posted on it, whoever dispatched it (a person, the sweep, the
 * reconciler), which on an open issue without `agent:implement` means a person took the label
 * off after a stop. Either way it is not fed again.
 * @param {Comment[]} comments
 * @returns {'fed' | 'implementer' | null}
 */
export function handledBefore(comments) {
  if (comments.some((c) => String(c.body ?? '').includes(FEED_MARKER))) return 'fed';
  if (comments.some((c) => markedRole(c.body) === 'Implementer')) return 'implementer';
  return null;
}

/**
 * Feed order: `sev:medium` before `sev:low`, then the oldest, then the lowest number.
 * @param {Issue} a @param {Issue} b
 */
const byFeedOrder = (a, b) => {
  const rank = (/** @type {Issue} */ i) => FEED_SEVERITIES.indexOf(/** @type {string} */ (severityOf(labelNames(i))));
  return rank(a) - rank(b)
    || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    || a.number - b.number;
};

/**
 * THE SELECTION. Pure but for `commentsOf`, which it calls only for the candidates it walks,
 * in feed order, until it has what the valve and the free slots allow.
 * @param {{ valve: number, globalWip: number, slots: Slot[], issues: Issue[], milestones: string[], commentsOf: (n: number) => Comment[] }} input
 * @returns {Plan}
 */
export function selectFeed({ valve, globalWip, slots, issues, milestones, commentsOf }) {
  const inUse = slots.filter((s) => s.occupies);
  /** @type {Plan} */
  const plan = {
    valve, globalWip, milestones,
    inUse: inUse.map((s) => s.number),
    fedInFlight: inUse.filter((s) => s.fed).map((s) => s.number),
    followUps: 0, eligible: 0, chosen: [], skipped: [], why: 'closed',
  };
  if (valve <= 0) return plan;
  if (plan.fedInFlight.length) return { ...plan, why: 'fed-in-flight' };
  const free = globalWip - inUse.length;
  if (free <= 0) return { ...plan, why: 'full' };
  const allowance = Math.min(valve, free);

  const followUps = issues.filter((i) => !i.pull_request && isReviewerFollowUp(labelNames(i)));
  const eligible = followUps.filter((i) => ineligibility(i, { milestones }) === null).sort(byFeedOrder);
  plan.followUps = followUps.length;
  plan.eligible = eligible.length;
  for (const [at, i] of eligible.entries()) {
    if (plan.chosen.length >= allowance) break;
    let comments;
    try {
      comments = commentsOf(i.number);
    } catch {
      // FAIL CLOSED: an unread thread may carry the marker.
      plan.skipped.push({ number: i.number, why: 'unreadable' });
      continue;
    }
    const before = handledBefore(comments);
    if (before) {
      plan.skipped.push({ number: i.number, why: before });
      continue;
    }
    const severity = /** @type {string} */ (severityOf(labelNames(i)));
    const opened = String(i.created_at ?? '').slice(0, 10) || 'on an unknown date';
    plan.chosen.push({
      number: i.number,
      title: i.title ?? '',
      severity,
      reason: `\`${severity}\`, opened ${opened}: number ${at + 1} of ${eligible.length} eligible reviewer follow-up(s) on ${milestones.join(', ')} in feed order (\`sev:medium\` before \`sev:low\`, then oldest first), and the first not fed or run before`,
    });
  }
  plan.why = plan.chosen.length ? 'fed' : eligible.length ? 'all-handled' : 'none-eligible';
  return plan;
}

/** Why nothing was fed, one sentence each. @type {Record<Exclude<Why, 'fed'>, (p: Plan) => string>} */
const NOTHING = {
  closed: () => 'the valve is closed: `QA_BACKLOG_FEED` is unset or 0. Set the repository variable to the number of reviewer follow-ups to feed a day (docs/lanes.md, "The backlog feeder").',
  'fed-in-flight': (p) => `${p.fedInFlight.map((n) => `#${n}`).join(', ')}, which this feeder fed, still occupies an implementer slot. It waits until that merges, closes or parks on a person.`,
  full: (p) => `every implementer slot is in use (${p.inUse.length} of ${p.globalWip}, \`QA_LEAD_GLOBAL_WIP\`). Projects keep priority; the feeder only takes a slot left free.`,
  'none-eligible': (p) => `no open reviewer follow-up is eligible (${p.followUps} read).`,
  'all-handled': (p) => `each of the ${p.eligible} eligible follow-up(s) walked was fed before, already ran the Implementer, or could not be read.`,
};

/**
 * The step summary. Every state renders a reason, so nothing reads as a silent no-op.
 * @param {Plan} plan
 * @param {{ apply: boolean, fed?: number[], failed?: { number: number, step: string }[], note?: string | null }} opts
 */
export function renderFeedSummary(plan, { apply, fed = [], failed = [], note = null }) {
  const lines = ['### Backlog feeder (kanon#609)', ''];
  if (note) lines.push(note, '');
  if (plan.why === 'closed') {
    lines.push(`Nothing fed: ${NOTHING.closed(plan)}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Valve: \`QA_BACKLOG_FEED\` = ${plan.valve}. Feeding from: ${plan.milestones.join(', ')}.`);
  lines.push(`Implementer slots in use: ${plan.inUse.length} of ${plan.globalWip}${plan.inUse.length ? ` (${plan.inUse.map((n) => `#${n}${plan.fedInFlight.includes(n) ? ', backlog-fed' : ''}`).join('; ')})` : ''}.`);
  if (!['fed-in-flight', 'full'].includes(plan.why)) lines.push(`Candidates: ${plan.eligible} eligible of ${plan.followUps} open reviewer follow-up(s).`);
  for (const s of plan.skipped) {
    const why = s.why === 'fed' ? 'fed before (it carries the marker)' : s.why === 'implementer' ? 'the Implementer already posted on it' : 'its comments could not be read';
    lines.push(`- #${s.number}: skipped, ${why}`);
  }
  for (const c of plan.chosen) {
    const f = failed.find((x) => x.number === c.number);
    const done = !apply ? 'would add `agent:implement` (dry run)'
      : fed.includes(c.number) ? (f ? `fed, but the marker comment FAILED (${f.step}), so it won't count as backlog-fed in flight` : 'fed (`agent:implement` added)')
        : f ? `FAILED to add \`agent:implement\` (${f.step}); retried next tick` : 'not attempted';
    lines.push(`- #${c.number}: ${done}. ${c.reason}.`);
  }
  if (!plan.chosen.length) lines.push('', `Nothing fed: ${NOTHING[/** @type {Exclude<Why, 'fed'>} */ (plan.why)](plan)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The marker comment, signed as the Lead: the sweep reads a Lead-signed comment as its own, so
 * this is never mistaken for a person's reply, and it counts as none of the sweep's attempts.
 * @param {Choice} choice
 * @param {{ tick?: string | null, persona?: string | null }} [opts]
 */
export function feedComment(choice, { tick = null, persona = null } = {}) {
  return signed([
    FEED_MARKER,
    `Fed to the Implementer from the backlog by the dispatch sweep's backlog feeder${tick ? ` ([tick](${tick}))` : ''}: ${choice.reason}.`,
    '',
    'The feeder labels at most `QA_BACKLOG_FEED` reviewer follow-ups a day, only into an implementer slot nothing else is using, and never the same issue twice. To take this one back, remove `agent:implement`.',
  ].join('\n'), 'Lead', persona);
}

// ── I/O ────────────────────────────────────────────────────────────────────

/** @param {string} msg */
const warn = (msg) => console.log(`::warning title=backlog-feed::${msg.replace(/\r?\n/g, ' ')}`);
/** @param {unknown} e */
const firstLine = (e) => String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0] ?? '';

/**
 * Every open issue (not pull request) carrying all of `labels`, through core REST, to the last page.
 * @param {string} repo
 * @param {string[]} labels
 * @param {(args: string[]) => string} gh
 * @param {number} [maxPages]
 * @returns {Issue[]}
 */
export function readOpen(repo, labels, gh, maxPages = 10) {
  /** @type {Issue[]} */
  const items = [];
  for (let page = 1; ; page++) {
    const r = JSON.parse(gh(['api', `repos/${repo}/issues?state=open&labels=${encodeURIComponent(labels.join(','))}&per_page=100&page=${page}`]));
    if (!Array.isArray(r)) throw new Error('the issues endpoint did not return a list');
    items.push(...r.filter((i) => !i.pull_request));
    if (r.length < 100) return items;
    if (page >= maxPages) throw new Error(`more than ${maxPages * 100} open items carry ${labels.join(' + ')}`);
  }
}

/**
 * The implementer slots: each open `agent:implement` issue, whether it occupies a slot as the
 * reconciler counts one, and whether this feeder fed it. An unreadable thread counts as fed,
 * failing closed: the feeder waits rather than double-feeding.
 * @param {string} repo
 * @param {{ gh: (args: string[]) => string, commentsOf: (n: number) => Comment[] }} io
 * @returns {Slot[]}
 */
export function readSlots(repo, { gh, commentsOf }) {
  const json = (/** @type {string[]} */ args) => JSON.parse(gh(args));
  return readOpen(repo, [IMPLEMENT], gh).map((i) => {
    const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name) ?? '');
    const { parkedOnHuman } = parkedRead(i.number, { labels, state: 'OPEN' }, {
      prs: (/** @type {number} */ n) => linkedPrsRead(n, { json }),
      lane: (/** @type {number} */ n, /** @type {{ labels: string[] }} */ o) => laneStateOf(n, /** @type {any} */ ({ ...o, comments: commentsOf })),
    });
    let fed = true;
    try {
      fed = handledBefore(commentsOf(i.number)) === 'fed';
    } catch (e) {
      warn(`#${i.number}: its comments could not be read, so it counts as backlog-fed in flight: ${firstLine(e)}`);
    }
    return { number: i.number, occupies: occupiesSlot({ labels, parkedOnHuman }), fed };
  });
}

/**
 * Read, select, and (with `apply`) feed. Never throws.
 * @param {{ repo: string, apply: boolean, gh: (args: string[]) => string, env?: Record<string, string | undefined>, summary?: (text: string) => void, tick?: string | null, globalWip?: number, persona?: string | null }} io
 */
export function run({ repo, apply, gh, env = process.env, summary = () => {}, tick = null, globalWip = GLOBAL_WIP_DEFAULT, persona = null }) {
  const valve = feedValve(env.QA_BACKLOG_FEED);
  const milestones = feedMilestones(env.QA_BACKLOG_MILESTONES);
  if (valve.note) warn(valve.note);
  /** @type {number[]} */
  const fed = [];
  /** @type {{ number: number, step: string }[]} */
  const failed = [];
  if (valve.n <= 0) {
    const plan = selectFeed({ valve: 0, globalWip, slots: [], issues: [], milestones, commentsOf: () => [] });
    summary(renderFeedSummary(plan, { apply, note: valve.note }));
    return { plan, fed, failed };
  }
  const commentsOf = makeCommentsReader({ json: (/** @type {string[]} */ args) => JSON.parse(gh(args)) });
  let slots;
  let issues;
  try {
    slots = readSlots(repo, { gh, commentsOf });
    issues = readOpen(repo, ['follow-up', 'agent:reviewer'], gh);
  } catch (e) {
    warn(`could not read the implementer slots or the reviewer follow-ups, so nothing was fed this tick: ${firstLine(e)}`);
    summary('### Backlog feeder (kanon#609)\n\nNothing fed: the feeder could not read the implementer slots or the reviewer follow-ups. The next tick tries again.\n');
    return { plan: null, fed, failed };
  }
  const plan = selectFeed({ valve: valve.n, globalWip, slots, issues, milestones, commentsOf });
  if (apply) {
    for (const c of plan.chosen) {
      try {
        gh(['api', '-X', 'POST', `repos/${repo}/issues/${c.number}/labels`, '-f', `labels[]=${IMPLEMENT}`]);
      } catch (e) {
        failed.push({ number: c.number, step: firstLine(e) });
        warn(`#${c.number}: adding ${IMPLEMENT} failed: ${firstLine(e)}`);
        continue;
      }
      fed.push(c.number);
      try {
        gh(['api', '-X', 'POST', `repos/${repo}/issues/${c.number}/comments`, '-f', `body=${feedComment(c, { tick, persona })}`]);
      } catch (e) {
        // The issue is dispatched and carries `agent:implement`, so it is not re-fed; what is
        // lost is the in-flight check, which the summary and this warning name.
        failed.push({ number: c.number, step: firstLine(e) });
        warn(`#${c.number}: fed, but its ${FEED_MARKER} comment failed, so it won't count as backlog-fed in flight; post the marker by hand: ${firstLine(e)}`);
      }
    }
  }
  summary(renderFeedSummary(plan, { apply, fed, failed, note: valve.note }));
  return { plan, fed, failed };
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
  const { GITHUB_SERVER_URL: server, GITHUB_RUN_ID: runId } = process.env;
  const tick = server && runId ? `${server}/${repo}/actions/runs/${runId}` : null;
  run({ repo, apply, gh, summary, tick, persona: appPersona('Lead') });
}

if (isCliEntry(import.meta.url)) main();
