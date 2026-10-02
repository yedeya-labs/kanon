#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter, which does not type-check its scripts.
// Typing it is separate work; a move changes no line it doesn't have to (ADR 0009).
// Why a red agent run went red — the MODEL WAS UNREACHABLE, or a real failure (RA-1408).
//
// THE PROBLEM THIS SOLVES IS ADVICE, NOT DETECTION. Since RA-1400 a review run that
// posts no verdict reds the job and prints `gh workflow run agent-review.yml -f
// pr_number=N`. That instruction is WRONG for the most common cause: measured over
// every `agent-review.yml` failure in the last 300 runs (2026-09-01..09-03), 3 of 10
// were the subscription's usage cap, where re-dispatching immediately fails the same
// way and can extend the window. A human reads that annotation at exactly the moment
// they are deciding what to do.
//
// AND ONLY ONE ARM COULD EVEN SAY IT. Many workflows run `claude-code-action`;
// before this script only `agent-review.yml` referenced the result JSON at all, so a
// cap in any of the others produced a bare red with nothing to read.
//
// THE DISCRIMINATOR IS WHICH MODEL RAN, and it is data the action already writes to
// `$RUNNER_TEMP/claude-execution-output.json`. Three measured runs, all configured for
// `claude-opus-5`:
//
//   run 33679229731   1 turn    $0        modelUsage {}              refused at the door
//   run 33764297592   1 turn    $0.003    modelUsage Haiku ONLY      Opus refused
//   run 33686795190   20 turns  $1.29     modelUsage Haiku + Opus    healthy
//
// The middle row is why spend is not the test: the cheap Haiku pre-flight bills even
// when the expensive model is refused, so a four-field conjunction keyed on
// `total_cost_usd === 0` called it a mid-run crash worth re-running. What separates
// the rows is PRESENCE of the configured model, read from the `init` message.
//
// NEVER FAILS TOWARDS "UNAVAILABLE", which is the only direction that matters. Where
// the evidence is incomplete — no init message to name the model, a `modelUsage` that
// could belong to a complete run — the answer is `failed`. Both `failed` and
// `unavailable` are advice, and calling a real crash an outage tells a human to wait
// when they should act: the same wrong advice this exists to remove, pointed the other
// way.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Did the model the run was CONFIGURED for actually get used?
 *
 *  `modelUsage` DOES NOT CARRY TOKEN COUNTS — it is per-model config metadata
 *  (`contextWindow`, `maxOutputTokens`) keyed by model id. An earlier version of this
 *  file assumed usage figures and keyed the cap on `total_cost_usd === 0`, which
 *  misses the shape measured on run 33764297592: configured for `claude-opus-5`,
 *  3.5 minutes, ONE turn, $0.003, and `modelUsage` containing **only Haiku**. Opus was
 *  capped; Haiku — the cheap pre-flight — still worked, so the cost was non-zero and
 *  the object was non-empty. The old rule called that a mid-run failure and advised a
 *  re-run, which is the exact wrong advice this file exists to remove.
 *
 *  The discriminator is presence, not spend: if the configured model is absent from
 *  `modelUsage`, it never ran.
 */
const configuredModelRan = (usage, model) => {
  if (usage == null || typeof usage !== 'object') return false;
  const keys = Object.keys(usage);
  if (keys.length === 0) return false;            // nothing ran at all
  if (!model) return true;                        // cannot tell which was wanted
  // Prefix match: the init names `claude-opus-5` and the key may carry a date suffix.
  const family = String(model).split('-').slice(0, 2).join('-');
  return keys.some((k) => k === model || k.startsWith(family));
};

/**
 * Classify a `claude-code-action` result object.
 *
 * `unavailable` — the configured model was never reached. Waiting is the remedy.
 *
 *   NAMED FOR THE OBSERVABLE, NOT FOR A CAUSE. This was `capped`, and the annotation
 *   asserted "the Claude subscription's usage cap" — but the identical signature is
 *   produced by an Anthropic OUTAGE, and the developer caught this file blaming their
 *   subscription during one. The result JSON cannot tell the two apart: both refuse the
 *   request before it bills, and both leave the configured model absent from
 *   `modelUsage`. What they share is the ADVICE — wait, do not re-dispatch — which is
 *   the whole output of this file, so one kind covering both is right. Naming a cause
 *   it cannot observe was not.
 * `exhausted` — the agent stopped because it reached its turn cap. A plain retry is NOT
 *   reasonable: it spends the same turns on the same work. Either the work wants
 *   splitting or this arm's `--max-turns` wants raising, and the notice names BOTH
 *   because the result JSON cannot tell which — see `renderNotice` (RA-1781, RA-846).
 *
 *   NAMED FOR THE OBSERVABLE, like the two below it, and keyed on the one field that IS
 *   the observable: `terminal_reason === 'max_turns'`, reported by the action itself.
 *   NOT on `num_turns >= max_turns`, which looks equivalent and is not — two runs in the
 *   first week of telemetry finished CLEANLY while over their configured cap
 *   (`num_turns` 166 and 157 against `--max-turns 150`, both `terminal_reason:
 *   'completed'`), so that rule would send healthy issues to be decomposed. The cap is
 *   not the hard stop it reads as; the reported terminal reason is authoritative.
 *   ALSO the dollar cap (RA-1879): `terminal_reason === 'budget_exhausted'` from
 *   `--max-budget-usd`. Same advice, so same kind; the `why` says which cap.
 * `failed` — the agent ran and did not finish cleanly. Retrying is reasonable.
 * `ok`      — the agent finished cleanly. Any red is downstream of it.
 * `not-reached` — no result file was produced. NAMED FOR THE OBSERVABLE TOO (RA-1503
 *   review): two causes leave no file — the job died before the agent step, or the
 *   agent step died before writing one — and this cannot see which. It used to assert
 *   the first, in the same breath as `unavailable` was corrected for asserting a cause
 *   it could not observe.
 *
 * There is no `unknown` return. `renderNotice` keeps an arm for it as a fall-through
 * for an unexpected caller, but every path above returns one of the five.
 */
export function classifyResult(result, model = '') {
  if (!result || typeof result !== 'object') {
    // NO RESULT FILE IS ITS OWN ANSWER (RA-1503 review). These steps run on
    // `if: failure()`, which is true when ANY earlier step failed — and in most arms
    // the agent is near-last, behind checkout, the install, the schema setup, a token mint and
    // more. A job that died before the agent has no result to classify, and the
    // ABSENCE of the file is the evidence of that. Reporting "could not tell a cap
    // from a failure" there points a reader at the agent when the real failure is
    // several steps up and already red — the noise `agent-review.yml:1814` fixed one
    // PR earlier for the same reason.
    return { kind: 'not-reached', why: 'the agent produced no result file' };
  }
  const turns = Number(result.num_turns);
  const cost = Number(result.total_cost_usd);
  const errored = result.is_error === true;

  // ERRORED **AND** THE CONFIGURED MODEL NEVER RAN. Both halves are load-bearing: a
  // healthy run also lists Haiku, so absence of the configured model is what
  // distinguishes "the expensive model was capped" from "it worked". Spend is NOT part
  // of the test any more — the Opus cap still bills ~$0.003 of Haiku pre-flight.
  if (errored && !configuredModelRan(result.modelUsage, model)) {
    const ran = Object.keys(result.modelUsage ?? {});
    return {
      kind: 'unavailable',
      why: model
        ? `\`${model}\` never ran (modelUsage: ${ran.length ? ran.join(', ') : 'empty'}, `
          + `num_turns ${Number.isFinite(turns) ? turns : '?'}, `
          + `total_cost_usd ${Number.isFinite(cost) ? cost : '?'}, ${Number(result.duration_ms) || 0}ms)`
        : `no model ran at all (num_turns ${Number.isFinite(turns) ? turns : '?'}, `
          + `${Number(result.duration_ms) || 0}ms)`,
    };
  }
  // OUT OF TURNS IS A REFINEMENT OF `failed`, AND ITS ADVICE IS THE OPPOSITE (RA-1781).
  // Placed between the two deliberately: AFTER `unavailable`, because a run that never
  // reached the model cannot have spent turns on the work, and BEFORE `failed`, whose
  // "a re-run is reasonable" is the one thing that cannot help here — the issue is too
  // big for one run, so a re-run is deterministic failure at ~35 minutes a time. The
  // implement lane ended 3 of 25 runs this way in the first week of telemetry.
  //
  // Not gated on `errored`: the terminal reason is the observable and it is
  // authoritative, so a run reporting `max_turns` is classified by that whatever
  // `is_error` says. If the two ever disagree, advising a decomposition is the safe
  // direction — it proposes work rather than asserting the run was fine.
  if (result.terminal_reason === 'max_turns') {
    return {
      kind: 'exhausted',
      why: `it stopped at its turn cap (num_turns ${Number.isFinite(turns) ? turns : '?'}, `
        + `total_cost_usd ${Number.isFinite(cost) ? cost.toFixed(2) : '?'})`,
    };
  }
  // THE DOLLAR CAP IS THE SAME SHAPE AS THE TURN CAP (RA-1879). `--max-budget-usd` ends a
  // run with `subtype: 'error_max_budget_usd'`, `is_error: true` and
  // `terminal_reason: 'budget_exhausted'` (read off the CLI's result builder, 2.1.280).
  // Left unhandled it fell through to `failed` — "a re-run is reasonable" — which is the
  // one wrong answer: the same work against the same cap spends the same dollars again.
  // It is never `unavailable` (the configured model ran — it spent up to the cap) and
  // never `ok`. Same kind as the turn cap because the ADVICE is the same; the `why`
  // names which cap, and `renderNotice` reads that to pick its remedy.
  if (result.terminal_reason === 'budget_exhausted' || result.subtype === 'error_max_budget_usd') {
    return {
      kind: 'exhausted',
      why: `it stopped at its dollar cap, --max-budget-usd (total_cost_usd `
        + `${Number.isFinite(cost) ? cost.toFixed(2) : '?'}, num_turns ${Number.isFinite(turns) ? turns : '?'})`,
    };
  }
  if (errored) {
    return {
      kind: 'failed',
      why: `the agent ran and did not finish (num_turns ${Number.isFinite(turns) ? turns : '?'}, `
        + `total_cost_usd ${Number.isFinite(cost) ? cost.toFixed(2) : '?'})`,
    };
  }
  return { kind: 'ok', why: `num_turns ${Number.isFinite(turns) ? turns : '?'}` };
}

/**
 * Whether a red run died of a cause that WAITING cures, and which (RA-2519) — `unreachable`,
 * `api_error`, or null.
 *
 * A REFINEMENT FOR THE RETRY LANES, NOT A NEW KIND. `classifyResult`'s five kinds are the
 * telemetry row's `outcome`, and a mid-run `api_error` stays `failed` there: the advice
 * ("a re-run is reasonable") is right for a human. What the PR lanes' reconcilers need
 * is narrower — may this head be re-fired ONCE, later, without a human — and only two
 * shapes qualify:
 *   · `unreachable` — the `unavailable` kind: the configured model never ran (a cap or
 *     an outage; the result JSON cannot tell which, and the remedy is the same);
 *   · `api_error`   — the model ran and the API failed under it part-way through
 *     (`terminal_reason: 'api_error'`, measured on PR RA-2446's revise run: 45 turns, $2.66,
 *     inside the 2026-09-25 cap window).
 * Everything else is null and keeps report-only: the turn and dollar caps reproduce on a
 * re-run, and a run that finished and failed is not an outage.
 */
export function retryClass(result, model = '') {
  const { kind } = classifyResult(result, model);
  if (kind === 'unavailable') return 'unreachable';
  if (kind === 'failed' && result?.terminal_reason === 'api_error') return 'api_error';
  return null;
}

/**
 * Every top-level JSON object in the action's output file.
 *
 * FOUR SHAPES, AND THE FOURTH IS THE ONE THAT SHIPS. Depending on the action version
 * the file is a JSON array, a single object, one object per line — or a stream of
 * PRETTY-PRINTED objects concatenated with no separator, which is what the action
 * actually printed on run 33764297592:
 *
 *     {
 *       "type": "system", "subtype": "init", "model": "claude-opus-5"
 *     }
 *     {
 *       "type": "result", ...
 *     }
 *
 * That shape parses as neither a document nor as lines, and the first cut of this file
 * handled only the first three: it read the real file as EMPTY, returned `not-reached`
 * for every arm, and the whole of RA-1408 was inert while looking healthy — a silent
 * absence, the failure mode this repo keeps rediscovering. So objects are extracted by
 * scanning brace depth, which subsumes all four rather than guessing between them.
 */
export function parseObjects(raw) {
  const text = String(raw);
  // The fast paths first: a well-formed document needs no scanning.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((o) => o && typeof o === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch { /* not one document — scan it */ }

  const out = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      // A brace inside a string must not move the depth, and `\"` must not end it.
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (c === '}') {
      depth -= 1;
      if (depth === 0 && start > -1) {
        try {
          const o = JSON.parse(text.slice(start, i + 1));
          if (o && typeof o === 'object') out.push(o);
        } catch { /* a brace-balanced run that is not JSON — skip it */ }
        start = -1;
      }
      if (depth < 0) depth = 0;   // stray `}` in surrounding log text
    }
  }
  return out;
}

const readObjects = (path, read) => {
  try { return parseObjects(read(path, 'utf8')); } catch { return []; }
};

/** The model the run was CONFIGURED for, from the `init` message. */
export function readConfiguredModel(path, { read = readFileSync } = {}) {
  const init = readObjects(path, read).find((o) => o.subtype === 'init' && o.model);
  return init ? String(init.model) : '';
}

/** The last `{"type":"result"}` object in the action's output file, or null. */
export function readResult(path, { read = readFileSync } = {}) {
  // Found by SHAPE rather than by position, the same reason `classifyResult` keys on
  // fields and not on a version string.
  return readObjects(path, read).filter((o) => o.type === 'result').at(-1) ?? null;
}

/**
 * The annotation and summary a red run should carry, given its classification.
 *
 * `nonFatal` — the agent step is `continue-on-error: true`, so its failure does NOT red
 * the job. Two arms are like this (`project-digest`, `weekly-digest`: the narrative is a
 * best-effort addition and the digest posts without it), and they are the reason this
 * option exists (RA-1503 review).
 *
 * ELEVEN ARMS GATE ON `failure()`; THESE TWO CANNOT. A `continue-on-error` step that
 * fails sets `outcome == 'failure'` but `conclusion == 'success'`, so the job stays
 * green and `failure()` is false — the classify step was wired into both digests and
 * could never fire for the capped narrative it was added for, while firing on the only
 * reds they CAN produce (checkout, or the post script), where the agent is by
 * construction not the cause. Both directions wrong, and both fixed by gating on
 * `steps.<id>.outcome` instead. See RA-1476, which owns "a missing narrative leaves no
 * trace on the daily digest" — this is the cap-shaped instance of it.
 *
 * The level drops to `warning` because an `::error` on a job that finishes GREEN reads
 * as the thing that failed, and nothing here did.
 */
export function renderNotice(kind, why, { arm = 'agent', recover = '', nonFatal = false } = {}) {
  const soften = (n) => (nonFatal
    ? {
      ...n,
      level: 'warning',
      body: `${n.body} This step is non-fatal, so it did not red the job on its own — the `
        + 'digest posts without its narrative. If this run IS red, the cause is a different '
        + 'step: read it above rather than acting on this notice.',
    }
    : n);
  if (kind === 'unavailable') {
    return soften({
      level: 'error',
      title: 'the model was unreachable, not a failed run',
      body: `The ${arm} never reached the model — ${why}. Not a defect in the PR's code `
        + "(unless this PR changes the arm's own model id or `claude_args`). THREE causes "
        + "produce this and the result JSON cannot tell them apart: the Claude subscription's usage cap, an "
        + 'Anthropic outage (check https://status.anthropic.com), or a CONFIGURATION defect — '
        + 'an expired `CLAUDE_CODE_OAUTH_TOKEN`, a model id this account cannot reach, or bad '
        + '`claude_args`. The first two want the same response: wait, because re-running NOW '
        + 'fails the same way and against a cap can extend the window. The third never '
        + 'resolves on its own, so if this arm keeps reporting unreachable across a reset, '
        + `stop waiting and check the configuration. Then: ${recover || 're-trigger this arm'} `
        + '(RA-1408)',
    });
  }
  if (kind === 'exhausted' && /--max-budget-usd/.test(String(why))) {
    // THE DOLLAR CAP (RA-1879). Every arm's cap is its turn cap × $0.40, rounded up to the
    // next $5 — $0.40 being 2.5× the worst per-turn cost any run in the telemetry window
    // paid. It is NOT sized from each arm's own spend. The derivation is the "Per-run spend
    // ceilings" table in the reference adopter's pipeline doc, §7; `agent-step-flags.test.ts` only
    // holds that table and the workflows together. So the turn cap is meant to bind first,
    // and reaching the dollar cap is not "the budget was a bit tight" — it is a run whose
    // per-turn cost averaged well above anything observed (runaway fan-out, oversized
    // reads). Read the transcript before doing anything; a plain re-run reproduces it.
    return soften({
      level: 'error',
      title: `${arm} hit its dollar cap — a runaway run, not a flake`,
      body: `The ${arm} reached the model and was stopped by \`--max-budget-usd\` — ${why}. `
        + 'A PLAIN RE-RUN REPRODUCES THIS: the same work against the same cap spends the '
        + 'same dollars and stops at the same place, having produced nothing. The cap is '
        + 'sized so the turn cap binds first on any run whose per-turn cost resembles one '
        + "ever recorded, so first read this run's transcript for the loop or the oversized "
        + 'read that got it here. Then either the WORK wants splitting, or — if the run was '
        + 'genuinely productive — the cap wants raising, by changing the per-turn rate or '
        + "this arm's turn cap in the derivation table (\"Per-run spend ceilings\") and "
        + 'the workflow together. Decide which before '
        + `re-triggering.${recover ? ` Once it is done: ${recover}` : ''} (RA-1879)`,
    });
  }
  if (kind === 'exhausted') {
    // TRUE FOR EVERY ARM THAT CAN EMIT IT, which is all of them — each sets its own
    // `--max-turns` (60 explore … 150 implement), so each can reach this. The first cut
    // of this body asserted implement-lane facts ("no PR and no branch", "DECOMPOSE the
    // issue") and would have printed them on the Overseer and the two digests, where
    // there is no issue being built and the durable artifact is an issue or a comment.
    //
    // It would also have CONTRADICTED a recorded decision on the same run:
    // `agent-code-audit.yml`'s overage warning says to raise the cap on this exact path,
    // which is RA-846's deliberate conclusion for that arm. (The Overseer's reconcile
    // annotations used to say it too; they no longer assert any cause, because telemetry
    // showed the cap has never been one there — RA-1939. This `exhausted` path is
    // unaffected: it fires only when `terminal_reason` really is `max_turns`, and
    // raising the cap IS the remedy then.) So this
    // names both remedies and picks neither — the result JSON cannot observe which arm's
    // work is divisible, and asserting a consequence it cannot see is the same defect
    // `capped`->`unavailable` and `not-reached` were each corrected for.
    return soften({
      level: 'error',
      title: `${arm} ran out of turns — a budget problem, not a flake`,
      body: `The ${arm} reached the model and stopped at its turn cap — ${why}. `
        + 'A PLAIN RE-RUN REPRODUCES THIS: the same work against the same cap spends the '
        + 'same turns, so it fails again after the same wall-clock having produced nothing. '
        + 'Something has to change first, and which of two things depends on the arm: '
        + 'either the WORK is divisible and wants splitting into parts each finishable in '
        + 'one run (the implement lane — RA-1781, with RA-1694 as the worked example), or the '
        + "arm's budget is genuinely too small and `--max-turns` is the thing to raise "
        + '(the Overseer and the code audit both record that conclusion on this path — '
        + `RA-846). Decide which before re-triggering.${recover ? ` Once it is done: ${recover}` : ''} (RA-1781)`,
    });
  }
  if (kind === 'failed') {
    return soften({
      level: 'error',
      title: `${arm} failed mid-run`,
      body: `The ${arm} reached the model and did not finish — ${why}. `
        + `A re-run is reasonable here.${recover ? ` ${recover}` : ''} (RA-1408)`,
    });
  }
  if (kind === 'not-reached') {
    return soften({
      level: 'warning',
      title: 'no result to classify',
      body: `No result file was produced — ${why}. Either this job failed BEFORE the `
        + `${arm} started, or the ${arm} died before writing one; this cannot tell which, `
        + 'so it is not evidence either way about a cap or an outage. Read the failing '
        + 'step above this one — if that step IS the agent, the run died mid-flight '
        + `(RA-1408).${recover ? ` Recovery, once the cause is understood: ${recover}` : ''}`,
    });
  }
  if (kind === 'ok') {
    // THE MOST USEFUL SENTENCE AVAILABLE, and the one this could not say (RA-1503
    // review): three branches for four kinds meant `ok` fell through to the `unknown`
    // text and reported "could not tell" about a run it had classified. Reachable on
    // exactly the path this change measured and did not fix — an agent that finishes
    // cleanly and produces no artifact, 2 of the 10 failures.
    return soften({
      level: 'warning',
      title: `${arm} finished cleanly`,
      body: `The ${arm} reached the model and finished — ${why}. This red is NOT the `
        + 'agent: whatever failed is downstream of it, in a later step of this job. '
        + 'Neither waiting nor re-running the agent addresses it (RA-1408).',
    });
  }
  return soften({
    level: 'warning',
    title: `${arm} outcome not classified`,
    body: `Could not tell a quota cap from a real failure — ${why}. Treating it as a real `
      + 'failure, which is the safe direction: it advises acting rather than waiting (RA-1408).',
  });
}

/**
 * CLI: `node classify-agent-result.mjs [--arm <name>] [--recover <cmd>] [--file <path>]
 *                                       [--non-fatal]`
 *
 * Emits the annotation, appends a line to `$GITHUB_STEP_SUMMARY`, and writes
 * `kind=<kind>` to `$GITHUB_OUTPUT` so a later step can branch on it.
 *
 * ALWAYS EXITS 0. This step explains a red run; it must not be the thing that makes one,
 * or a classifier bug would turn a healthy agent arm red and this would be a new failure
 * mode rather than a description of an existing one. The arm's own steps decide the
 * job's outcome, exactly as they did before.
 */
function cli() {
  const arg = (name, fallback = '') => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const file = arg('file', `${process.env.RUNNER_TEMP || '/tmp'}/claude-execution-output.json`);
  const arm = arg('arm', 'agent');
  const recover = arg('recover');
  const nonFatal = process.argv.includes('--non-fatal');

  const result = readResult(file);
  const model = readConfiguredModel(file);
  const { kind, why } = classifyResult(result, model);
  const { level, title, body } = renderNotice(kind, why, { arm, recover, nonFatal });

  console.log(`::${level} title=${title}::${body}`);
  if (process.env.GITHUB_OUTPUT) {
    // `retry` is read by the PR lanes' breadcrumb steps (scripts/qa/lane-retry.mjs):
    // empty when waiting would not help.
    appendFileSync(process.env.GITHUB_OUTPUT, `kind=${kind}\nretry=${retryClass(result, model) ?? ''}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const icon = {
      unavailable: '⏳', exhausted: '🪫', failed: '❌', ok: '✅', 'not-reached': '⏭️',
    }[kind] ?? '❔';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${icon} **${title}** — ${body}\n`);
  }
}

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (IS_CLI) cli();
