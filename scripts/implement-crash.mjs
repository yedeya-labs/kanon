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
// Env: GH_TOKEN (the workflow's default token — see the workflow for why not the App's),
//      LABEL_TOKEN (the Implementer's App token, for the `qa:needs-split` label alone),
//      GITHUB_REPOSITORY, ISSUE, RUN_ID, KIND (the classifier's verdict), APPLY.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AGENT_LOGIN, linkedPrIndex, norm } from './dispatch-sweep.mjs';
import { SPLIT_LABEL, exhaustedRoute, projectOf } from './split-lineage.mjs';

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
  return (comments ?? []).some((c) => norm(c.login ?? c.author?.login) === AGENT_LOGIN
    && Date.parse(c.createdAt) >= t);
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
  return [
    CRASH_MARKER,
    act === 'retry'
      ? `**The implementer run crashed and produced nothing** — removing \`${IMPLEMENT}\` so this issue stops holding a WIP slot (RA-2118).`
      : label === SPLIT_LABEL
        ? `**The implementer run hit its cap and produced nothing, and retrying will not help** — removing \`${IMPLEMENT}\` and labelling \`${SPLIT_LABEL}\`, so the Lead proposes a split of this issue's brief item (RA-1781).`
        : `**The implementer run crashed and produced nothing, and retrying will not help** — removing \`${IMPLEMENT}\` and labelling \`${label}\` for a human.`,
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
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env });
}
const ghJson = (args) => JSON.parse(gh(args));

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

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (IS_CLI) main();
