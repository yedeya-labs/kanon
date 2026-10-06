#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-2118 — a crashed implementer run must not hold a WIP slot for 48 hours.
//
// WHAT HAPPENED. On 2026-09-19 three project-RA-27 dispatches failed inside
// `claude-code-action` after ~28 turns each, posting no comment and no PR. The issues
// kept `agent:implement`, so `occupiesSlot` in `lead-reconcile.mjs` counted all three as
// in flight, `QA_LEAD_GLOBAL_WIP` (3) was spent, and six of seven projects were handed
// nothing on every hourly tick — including RA-1292, launch-gating, holding a `sev:critical`.
// The only thing that reclaimed the slots was the daily dispatch sweep at its 48h
// staleness, so one crash cost up to two days of the whole pipeline's throughput,
// silently and with a green reconciler.
//
// WHAT THIS DOES. `agent-implement.yml` runs it on `failure()`, after the spine has
// classified the red run. For a PROJECT member whose run produced NOTHING, it records a
// crash marker and removes `agent:implement`, so the next hourly tick re-dispatches it —
// recovery drops from ~48h to ~1h. It is bounded, because the tick is hourly and a
// DETERMINISTIC crash re-dispatched without a count is ~$2 an hour forever: the runaway
// `dispatch-sweep.mjs`'s `MAX_REDISPATCH` exists to bound, reached by a shorter path.
//
// THE DECISION IS `decide()`, PURE AND EXPORTED, so every branch is testable without a
// token; `main()` only gathers its inputs and performs its verdict.
//
// A RUN THAT ENDS GREEN WITH NOTHING TO SHOW IS THE SAME FAILURE (kanon#181). Four of seven
// consecutive implementer runs in the reference adopter ended `success` after 128-181 turns
// with no branch, no PR and no comment. The spine called them green, so this job never ran
// and the issue sat on its label exactly as a crash's did. `MODE=detect` is the check the
// workflow runs after a GREEN implement job: it reads what the run left, and when it left
// nothing it reds the run by name and says so in its outputs, so this same recovery runs
// with `KIND=empty` — the same retry, the same marker, the same cap.
//
// Env: GH_TOKEN (the workflow's default token — see the workflow for why not the App's),
//      LABEL_TOKEN (the Implementer's App token, for the `qa:needs-split` label alone),
//      GITHUB_REPOSITORY, ISSUE, RUN_ID, KIND (the classifier's verdict), APPLY.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { AGENT_LOGIN, linkedPrIndex, norm } from './dispatch-sweep.mjs';
import { SPLIT_LABEL, exhaustedRoute, projectOf } from './split-lineage.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { beforeApply } from './lib/labels.mjs';
import { asRole, markedRole, slugOf } from './lib/role-marker.mjs';

const REPO = process.env.GITHUB_REPOSITORY;
const IMPLEMENT = 'agent:implement';
/** Where an issue goes when retrying cannot help. The dispatch sweep's own terminal
 *  label, and deliberately NOT `needs:human`: on a project member, `lead-reconcile`'s
 *  `eligible` filter excludes `qa:needs-info` and does not exclude `needs:human`, so the
 *  latter would be re-dispatched on the very next tick. */
export const STOP_LABEL = 'qa:needs-info';
/** The crash marker. Counted, so it is load-bearing: changing it resets every issue's
 *  crash count to zero, which is the runaway the cap bounds. */
export const CRASH_MARKER = '<!-- qa:implement-crash -->';
/** The login the marker must come from. The workflow's default token comments as
 *  `github-actions`, so a human quoting the marker is not a crash (RA-1079's lesson). */
export const CRASH_AUTHOR = 'github-actions';
/** Retries before a human. Two, matching `MAX_REDISPATCH`: at ~$2 a crashed run that is
 *  ~$4 per issue, against a two-day stall of every project. */
export const MAX_CRASH_RETRIES = Number(process.env.QA_IMPLEMENT_CRASH_RETRIES || 2);

/** The verdict `MODE=detect` gives a green run that left nothing (kanon#181). Not one of
 *  the classifier's: that one explains a RED run, and this run was red only once the
 *  check below made it so. `decide` treats it as a crash, which is what it is. */
export const EMPTY_KIND = 'empty';

/** A branch the implementer pushes for an issue: the `<type>/<n>-` shape `linkedPrIndex`
 *  reads a PR's head by, so the two cannot disagree about whose branch it is. */
export const branchPattern = (issue) => new RegExp(`^[a-z]+/${issue}-`);

/**
 * Did a GREEN run leave nothing anyone can see? Pure (kanon#181).
 *
 * Empty means all three: no open PR closes the issue, no branch of the issue's shape was
 * pushed during the run, and the implementer did not comment during it. A comment is
 * enough to make a run non-empty, whatever it says: a SCOPE-FIRST BAIL, a question, or a
 * progress note is the agent explaining why it stopped, and parks the issue on purpose.
 *
 * Every unknown reads as OUTPUT, never as empty, because the wrong answer in that direction
 * is a red run and a retry of work that exists: no start time, or a branch whose head
 * commit has no readable date.
 *
 * @param {{ issue: number|string, branches: {name: string, committedAt?: string}[], hasPr: boolean, spoke: boolean, since: string }} i
 * @returns {{ empty: boolean, why: string }}
 */
export function emptyRun({ issue, branches, hasPr, spoke, since }) {
  if (hasPr) return { empty: false, why: 'an open PR would close this issue' };
  if (spoke) return { empty: false, why: 'the implementer commented on the issue during this run' };
  const t = Date.parse(since ?? '');
  if (!Number.isFinite(t)) return { empty: false, why: 'the run\'s start time is unknown, so nothing can be called new' };
  const pattern = branchPattern(issue);
  // A branch from an EARLIER run is not this run's output: only one whose head was
  // committed after the run started counts. An unreadable date counts (see above).
  const pushed = (branches ?? []).filter((b) => pattern.test(b.name) && !(Date.parse(b.committedAt ?? '') < t));
  if (pushed.length) return { empty: false, why: `\`${pushed[0].name}\` was pushed during this run` };
  return { empty: true, why: `no open PR closes it, no \`<type>/${issue}-…\` branch was pushed since the run started, and the implementer did not comment` };
}

/** The project an issue belongs to — moved to `split-lineage.mjs` so the crash job, the
 *  sweep and the split lane read membership one way; re-exported for existing callers. */
export { projectOf };

/** Crash markers this workflow left on the issue — counted by author AND marker. */
export function priorCrashes(comments) {
  return (comments ?? []).filter((c) => norm(c.login ?? c.author?.login) === CRASH_AUTHOR
    && String(c.body ?? '').includes(CRASH_MARKER)).length;
}

/** Did the implementer say anything on this issue since the run started? */
export function agentSpokeSince(comments, since) {
  const t = Date.parse(since ?? '');
  // No start time is no evidence of silence: treat it as "spoke", which keeps the label.
  if (!Number.isFinite(t)) return true;
  // The Implementer's login and, from L4, its role marker (plan 0005 §3.3).
  return (comments ?? []).some((c) => asRole('Implementer', { login: norm(c.login ?? c.author?.login), expected: AGENT_LOGIN, body: c.body })
    && Date.parse(c.createdAt) >= t);
}

/**
 * How many comments the Implementer's App posted on the issue since the run started that carry
 * NO role marker (kanon#336). Since L4 `agentSpokeSince` reads such a comment as silence, so a
 * run whose agent left its header off reads as one that said nothing; this count lets the job
 * say so by name rather than leave "the implementer did not comment" as the only account.
 * A comment carrying another role's marker (the Lead's, on the same App) is that role's, and
 * not counted.
 * @param {{ login?: string, author?: { login?: string }, createdAt: string, body?: string }[]} comments
 * @param {string} since
 */
export function unmarkedSince(comments, since) {
  const t = Date.parse(since ?? '');
  if (!Number.isFinite(t)) return 0;
  return (comments ?? []).filter((c) => slugOf(norm(c.login ?? c.author?.login)) === slugOf(AGENT_LOGIN)
    && markedRole(c.body) === null && Date.parse(c.createdAt) >= t).length;
}

/** The warning `unmarkedSince` asks for, or '' when there is nothing to say. */
export function unmarkedWarning(issue, n) {
  return n > 0
    ? `::warning title=unmarked comment::#${issue}: ${n} comment(s) by the Implementer's App since the run started carry no role marker, so none is read as the Implementer speaking (plan 0005 §3.3; the agent left off its header, kanon#336).`
    : '';
}

/**
 * What to do about a failed implement run. Pure.
 *
 * @param {object} i
 * @param {string} i.kind       `classify-agent-result.mjs`'s verdict ('' if it never ran)
 * @param {string[]} i.labels   the issue's labels now
 * @param {number|null} i.project the project it belongs to, or null
 * @param {boolean} i.spoke     the implementer commented since the run started
 * @param {boolean} i.hasPr     an open PR would close it
 * @param {number} i.crashes    crash markers already on it
 * @param {string} [i.body]     the issue body — read for the split-lineage marker (RA-1781)
 * @param {number} [i.max]
 * @returns {{act: 'none'|'retry'|'stop', why: string, label?: string}} `label` is where a
 *   `stop` sends the issue
 */
export function decide({ kind, labels, project, spoke, hasPr, crashes, body = '', max = MAX_CRASH_RETRIES }) {
  if (!labels.includes(IMPLEMENT)) return { act: 'none', why: `\`${IMPLEMENT}\` is already off — nothing holds a slot` };
  // A PR EXISTS — work was produced, whatever the run did after.
  if (hasPr) return { act: 'none', why: 'a PR would close this issue — work exists' };
  // ONLY A PROJECT MEMBER. Removing the label is only a retry because `lead-reconcile`
  // re-dispatches brief items; an issue a human labelled by hand has no such tick, and
  // dropping its label would strand it. The dispatch sweep owns that one, as before.
  //
  // A GREEN RUN THAT LEFT NOTHING (`empty`, kanon#181) is left alone here too, comment
  // included. The sweep reads a bot comment as the conversation's last word, so a notice on
  // an issue that keeps its label would turn a human's unanswered reply (`answered`, which
  // the sweep re-dispatches) into `in-flight` and then `awaiting-human`, which it does not.
  // The red run is the signal, and the sweep reads it: the run's jobs show the empty check
  // failed and this recovery ran, and the issue reads `ran-empty` there (kanon#254).
  if (project == null) return { act: 'none', why: 'not a project member, so no tick would re-dispatch it — the dispatch sweep owns its retry' };
  // NEVER REACHED THE MODEL. A cap or an outage is a fact about the pipeline, and an
  // hourly retry into it spends the attempts RA-1517 says must not be charged. The sweep's
  // `unavailable` discount owns this.
  if (kind === 'unavailable' || kind === 'not-reached') {
    return { act: 'none', why: `the run never reached the model (\`${kind}\`) — retrying hourly into a cap or an outage would spend attempts on the pipeline's fault (RA-1517)` };
  }
  // TOO BIG FOR ONE RUN. A retry of an exhausted run is deterministic failure at the
  // turn cap's price — RA-1694 spent ~$70 learning that three times. It wants DECOMPOSING,
  // and since RA-1781 that is the Lead's split lane rather than a human — unless this issue
  // is already a split child, because a split is allowed once per lineage.
  //
  // BEFORE `spoke`, deliberately: a run that commented early (a plan, a progress note)
  // and then ran to its cap is not parked on what it said — it kept working until the
  // cap stopped it. A SCOPE-FIRST BAIL ends the run, so it never reaches this verdict.
  if (kind === 'exhausted') {
    const route = exhaustedRoute({ project, body });
    return { act: 'stop', label: route.label, why: `the run hit its turn or budget cap — this issue is too large for one run and a retry repeats it. It wants DECOMPOSING into smaller issues, not re-running: ${route.why}` };
  }
  // THE RUN SAID SOMETHING — a SCOPE-FIRST BAIL that then crashed. That issue is parked
  // on purpose and must keep its label (RA-2118 AC2); `occupiesSlot` already frees a
  // parked issue's slot (RA-2038).
  if (spoke) return { act: 'none', why: 'the implementer commented during this run, so it is parked on what it said, not crashed' };
  if (crashes >= max) {
    return { act: 'stop', label: STOP_LABEL, why: `${crashes} earlier crash(es) already retried — re-dispatching again would loop. The acceptance criteria may need sharpening, or this needs building by hand` };
  }
  return { act: 'retry', why: `crash ${crashes + 1} of ${max} retried — the next hourly \`lead-reconcile\` tick re-dispatches it` };
}

/** The comment `main` posts. Exported so the marker's presence is asserted, not assumed. */
export function renderComment({ act, why, label = STOP_LABEL }, { runUrl, kind }) {
  // A GREEN RUN THAT LEFT NOTHING is not called a crash on the issue: the run log says it
  // completed, and a comment contradicting the log sends a human looking for an error
  // that is not there (kanon#181).
  const what = kind === EMPTY_KIND
    ? 'The implementer run completed but left no PR, no pushed branch and no comment'
    : 'The implementer run crashed and produced nothing';
  return [
    CRASH_MARKER,
    act === 'retry'
      ? `**${what}** — removing \`${IMPLEMENT}\` so this issue stops holding a WIP slot (RA-2118${kind === EMPTY_KIND ? ', kanon#181' : ''}).`
      : label === SPLIT_LABEL
        ? `**The implementer run hit its cap and produced nothing, and retrying will not help** — removing \`${IMPLEMENT}\` and labelling \`${SPLIT_LABEL}\`, so the Lead proposes a split of this issue's brief item (RA-1781).`
        : `**${what}, and retrying will not help** — removing \`${IMPLEMENT}\` and labelling \`${label}\` for a human.`,
    '',
    `- run: ${runUrl}`,
    `- classifier verdict: \`${kind || 'none — the classify step did not run'}\``,
    `- ${why}.`,
    '',
    label === SPLIT_LABEL
      ? `_Posted by \`scripts/implement-crash.mjs\` (RA-2118, RA-1781). To re-run it unchanged instead of splitting, remove \`${SPLIT_LABEL}\` (the split lane skips an issue without it) and then re-add \`${IMPLEMENT}\`._`
      : `_Posted by \`scripts/implement-crash.mjs\` (RA-2118). If this is wrong, re-add \`${IMPLEMENT}\`; the crash count is read from these comments._`,
  ].join('\n');
}

/**
 * What `main` does with a verdict, in order, and on which token: `workflow` is the job's
 * default token, `app` the Implementer's. PURE, so the order and the token of every call
 * are testable without one.
 *
 * ONE CALL RIDES THE APP TOKEN: adding `qa:needs-split`. A label the default token adds
 * raises no event, so the split lane would never hear of it; the App's label raises
 * `issues: labeled`, which starts `agent-lead-split.yml` through its membership gate as a
 * registered App (`K-AGENT-45`). This replaced a `gh workflow run` on the default token,
 * which the gate refuses: its actor is `github-actions[bot]`, outside the App register
 * (plan 0001 decision 21, the Owner's option (a)). The Implementer already holds Issues
 * write; no App holds the Actions write a dispatch would need.
 *
 * EVERYTHING ELSE STAYS ON THE DEFAULT TOKEN, deliberately: the crash marker must read as
 * `github-actions` (`CRASH_AUTHOR`), never as the Implementer, or it would read as "the
 * agent spoke" and park the issue; and the other edits need no event.
 *
 * @param {{act: string, label?: string}} verdict
 * @param {string} issue
 * @param {string} body the comment
 * @returns {{args: string[], token: 'workflow'|'app'}[]}
 */
export function plan(verdict, issue, body) {
  const on = (token, ...args) => ({ args: [...args, '--repo', REPO], token });
  if (verdict.act === 'none') return [];
  if (verdict.act === 'stop') {
    // The stop label FIRST: if the removal then failed the issue is still parked for a
    // human rather than left carrying neither label and invisible to every lane. The split
    // lane's own gate skips an issue still carrying `agent:implement`; it reads the labels
    // a runner and a checkout later, well after the removal below.
    return [
      on(verdict.label === SPLIT_LABEL ? 'app' : 'workflow', 'issue', 'edit', issue, '--add-label', verdict.label),
      on('workflow', 'issue', 'edit', issue, '--remove-label', IMPLEMENT),
      on('workflow', 'issue', 'comment', issue, '--body', body),
    ];
  }
  // The comment FIRST, because it is what records the attempt — the order the sweep's
  // `redispatch()` uses and for its reason: an uncounted retry is an uncapped one.
  return [
    on('workflow', 'issue', 'comment', issue, '--body', body),
    on('workflow', 'issue', 'edit', issue, '--remove-label', IMPLEMENT),
  ];
}

function gh(args, token) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  // Created with the token that applies it: the split label rides the App (see `plan`).
  beforeApply(args, (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env, stdio: ['ignore', 'pipe', 'pipe'] }));
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env });
}
const ghJson = (args) => JSON.parse(gh(args));

/** The branches of the issue's shape, each with its head commit's date. Only the
 *  matching ones are dated, so the cost is one list plus a read per candidate. */
function issueBranches(issue) {
  const pattern = branchPattern(issue);
  const names = gh(['api', '--paginate', `repos/${REPO}/branches?per_page=100`, '--jq', '.[].name'])
    .split('\n').map((n) => n.trim()).filter((n) => pattern.test(n));
  return names.map((name) => {
    let committedAt = '';
    try {
      committedAt = gh(['api', `repos/${REPO}/commits/${encodeURIComponent(name)}`, '--jq', '.commit.committer.date']).trim();
    } catch { /* undated reads as output — see `emptyRun` */ }
    return { name, committedAt };
  });
}

/**
 * `MODE=detect`: after a GREEN implement job, red the run by name when it left nothing
 * (kanon#181). It changes nothing on the issue: the recovery job that follows a red run
 * does, through `decide`, so a run that left nothing is retried exactly as a crash is.
 * `empty=true` goes to `$GITHUB_OUTPUT` BEFORE the exit, because that output — not the
 * red — is what tells the recovery the run was empty rather than that this check broke.
 */
function detect(issue, runId) {
  const since = ghJson(['api', `repos/${REPO}/actions/runs/${runId}`]).run_started_at;
  const view = ghJson(['issue', 'view', issue, '--repo', REPO, '--json', 'comments,state']);
  if (view.state !== 'OPEN') {
    console.log(`#${issue}: closed — nothing to check`);
    return;
  }
  const comments = (view.comments ?? []).map((c) => ({ login: c.author?.login, createdAt: c.createdAt, body: c.body ?? '' }));
  const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '200', '--json', 'number,headRefName,closingIssuesReferences']);
  const verdict = emptyRun({
    issue,
    branches: issueBranches(issue),
    hasPr: Boolean(linkedPrIndex(prs)(Number(issue))),
    spoke: agentSpokeSince(comments, since),
    since,
  });
  const unmarked = unmarkedWarning(issue, unmarkedSince(comments, since));
  if (unmarked) console.log(unmarked);
  if (!verdict.empty) {
    console.log(`#${issue}: the run left output — ${verdict.why}`);
    return;
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'empty=true\n');
  console.log(`::error title=implement run left nothing::#${issue}: the implementer run ended \`success\` but left no observable output — ${verdict.why} (kanon#181). Failing the run so crash recovery retries it within its cap.`);
  process.exit(1);
}

function main() {
  if (!REPO) {
    console.error('implement-crash: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const issue = String(process.env.ISSUE ?? '');
  const runId = String(process.env.RUN_ID ?? '');
  const kind = String(process.env.KIND ?? '');
  const apply = process.env.APPLY === '1';
  if (!/^\d+$/.test(issue)) {
    console.log('::notice title=implement-crash::no issue number on this run (a bare workflow_dispatch re-run?) — nothing to reclaim');
    return;
  }
  if (process.env.MODE === 'detect') return detect(issue, runId);
  const since = ghJson(['api', `repos/${REPO}/actions/runs/${runId}`]).run_started_at;
  const view = ghJson(['issue', 'view', issue, '--repo', REPO, '--json', 'body,labels,comments,state']);
  if (view.state !== 'OPEN') return;
  const comments = (view.comments ?? []).map((c) => ({ login: c.author?.login, createdAt: c.createdAt, body: c.body ?? '' }));
  const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '200', '--json', 'number,headRefName,closingIssuesReferences']);
  const verdict = decide({
    kind,
    labels: (view.labels ?? []).map((l) => l.name),
    project: projectOf(view.body),
    spoke: agentSpokeSince(comments, since),
    hasPr: Boolean(linkedPrIndex(prs)(Number(issue))),
    crashes: priorCrashes(comments),
    body: view.body,
  });
  const unmarked = unmarkedWarning(issue, unmarkedSince(comments, since));
  if (unmarked) console.log(unmarked);
  console.log(`#${issue}: ${verdict.act} — ${verdict.why}`);
  if (verdict.act === 'none' || !apply) return;
  const body = renderComment(verdict, { runUrl: `https://github.com/${REPO}/actions/runs/${runId}`, kind });
  const calls = plan(verdict, issue, body);
  // NO APP TOKEN, NO SPLIT: fail before the first edit, by name, rather than add the label
  // on the default token, where it would start nothing and look done.
  const appToken = process.env.LABEL_TOKEN ?? '';
  if (calls.some((c) => c.token === 'app') && !appToken) {
    console.log(`::error title=implement-crash::#${issue} must be split, and the split lane starts only on a \`${SPLIT_LABEL}\` label added by an App; LABEL_TOKEN (the Implementer's App token) is not set, so nothing was changed`);
    process.exit(1);
  }
  for (const c of calls) gh(c.args, c.token === 'app' ? appToken : undefined);
  console.log(`::warning title=implement-crash::#${issue} ${verdict.act === 'retry' ? 'released for re-dispatch' : `handed on (${verdict.label})`} — ${verdict.why}`);
}

const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) main();
