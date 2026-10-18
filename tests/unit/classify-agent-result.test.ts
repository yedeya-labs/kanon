import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { laneBlockOf } from './helpers/agent-lanes.mjs';
import { interpolate } from './helpers/expression.js';
import { readBlock } from './helpers/blocks.js';
import { runWorkflowStep } from './helpers/workflow-step.js';
import {
  classifyResult, parseObjects, readConfiguredModel, readResult, renderNotice,
} from '../../actions/agent-classify/classify-agent-result.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * RA-1408 — why a red agent run went red.
 *
 * Since RA-1400 a review run that posts no verdict reds the job and prints
 * `gh workflow run agent-review.yml -f pr_number=N`. That advice is WRONG for the most
 * common cause. Measured over every `agent-review.yml` failure in the last 300 runs
 * (2026-09-01..09-03) — 10 failures:
 *
 *   3  usage cap                        re-dispatching fails the same way
 *   2  agent finished, posted nothing   a re-run costs ~$4 to reproduce
 *   5  restore script absent            already fixed by RA-1411
 *
 * So the fix is the annotation, not a retry — and the fixtures below are the real
 * numbers off those runs rather than invented shapes.
 */

// `modelUsage` DOES NOT CARRY TOKEN COUNTS. Every fixture below is the real object off
// a real run, and the values are `contextWindow`/`maxOutputTokens` — per-model CONFIG
// metadata, keyed by model id. An earlier revision of this file invented `inputTokens`
// fields here, and that invention is what let the shipped classifier key the cap on
// `total_cost_usd === 0` and get OPUS_CAPPED wrong. Do not re-add them.
const HAIKU = { 'claude-haiku-4-5-20251001': { contextWindow: 200000, maxOutputTokens: 32000 } };
const OPUS = { 'claude-opus-5': { contextWindow: 1000000, maxOutputTokens: 64000 } };

// Verbatim from run 33679229731 (PR RA-1468) — capped at the door, nothing ran at all.
const CAPPED = {
  type: 'result', subtype: 'success', is_error: true,
  duration_ms: 504, num_turns: 1, total_cost_usd: 0,
  permission_denials_count: 0, modelUsage: {},
};
// Verbatim from run 33764297592 (PR RA-1503's own re-review) — CAPPED ON OPUS ONLY.
// Three and a half minutes, one turn, $0.003, and `modelUsage` lists Haiku and NOT the
// `claude-opus-5` the run was configured for: the cheap pre-flight went through and the
// expensive model was refused. The first cut of this classifier called this `failed`
// and told a human to re-run into a live cap — the exact wrong advice RA-1408 exists to
// remove, on the very PR that removes it.
const OPUS_CAPPED = {
  type: 'result', subtype: 'success', is_error: true,
  duration_ms: 211391, num_turns: 1, total_cost_usd: 0.002961,
  permission_denials_count: 0, modelUsage: { ...HAIKU },
};
// Verbatim from run 33686795190 (same head SHA as CAPPED, the dispatch that worked).
const HEALTHY = {
  type: 'result', subtype: 'success', is_error: false,
  duration_ms: 191909, num_turns: 20, total_cost_usd: 1.2906039999999996,
  modelUsage: { ...HAIKU, ...OPUS },
};
// The mid-run shape: reached Opus, spent real money, did not finish.
const MID_RUN = {
  type: 'result', subtype: 'error', is_error: true,
  duration_ms: 696361, num_turns: 50, total_cost_usd: 4.0319945,
  modelUsage: { ...HAIKU, ...OPUS },
};
const OPUS_5 = 'claude-opus-5';

// RA-1781 — OUT OF TURNS. Verbatim off run 34684281020, the first of two dispatches that
// tried to build RA-1694 and died the same way half an hour apart.
const EXHAUSTED = {
  type: 'result', subtype: 'error', is_error: true, terminal_reason: 'max_turns',
  duration_ms: 2027005, num_turns: 151, total_cost_usd: 23.08,
  modelUsage: { ...HAIKU, ...OPUS },
};
// THE TWO NEGATIVE CONTROLS, AND THE REASON THIS IS NOT KEYED ON A TURN COUNT.
// Both are real `COST#` rows from the first week of telemetry (runs 34208110278 and
// 34499944510): `num_turns` ABOVE the configured `--max-turns 150`, `terminal_reason:
// 'completed'`, `is_error: false`. The cap is not the hard stop it reads as, so
// `num_turns >= max_turns` — the obvious rule — would have called 2 of the window's 22
// successful implement runs oversized and sent healthy issues to be decomposed.
const OVER_CAP_BUT_FINISHED = [
  {
    type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed',
    duration_ms: 1_800_000, num_turns: 166, total_cost_usd: 18.69,
    modelUsage: { ...HAIKU, ...OPUS },
  },
  {
    type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed',
    duration_ms: 1_700_000, num_turns: 157, total_cost_usd: 14.97,
    modelUsage: { ...HAIKU, ...OPUS },
  },
];

// KANON#1008. Verbatim off run 38628914592 (the Lead's revise of PR #915), whose row said
// `completed`. `claude-code-action` since #1607 fails the step itself when a result says
// `success` past `--max-turns` ("Claude reported a successful result after 100 turns,
// exceeding the configured maximum of 90"), so the CLI's terminal reason is not the one
// that ended the run.
const OVERSHOT = {
  type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed',
  duration_ms: 718909, num_turns: 100, total_cost_usd: 5.2277682,
  modelUsage: { ...HAIKU, 'claude-opus-5-5': { contextWindow: 1000000, maxOutputTokens: 128000 } },
};

// THE REAL FILE, verbatim off run 33764297592 — two PRETTY-PRINTED objects concatenated
// with no separator and no enclosing array. Neither `JSON.parse` of the whole text nor a
// line-by-line parse reads a single object out of this, which is how the first cut of
// this script came to report `not-reached` for a run it had all the evidence about.
const REAL_STREAM = `{
  "type": "system",
  "subtype": "init",
  "message": "Claude Code initialized",
  "model": "claude-opus-5"
}
{
  "type": "result",
  "subtype": "success",
  "is_error": true,
  "duration_ms": 211391,
  "num_turns": 1,
  "total_cost_usd": 0.002961,
  "permission_denials_count": 0,
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  }
}
`;

describe('classifyResult', () => {
  it('calls a run where nothing ran at all a cap', () => {
    const r = classifyResult(CAPPED, OPUS_5);
    expect(r.kind).toBe('unavailable');
    expect(r.why, 'and says what made it one').toMatch(/never ran/);
  });

  it('calls a run capped on Opus alone a cap, not a mid-run failure', () => {
    // THE REGRESSION TEST FOR THE SHIPPED DEFECT. Spend and turn count say "something
    // happened" ($0.003 over 3.5 minutes); the only field that says WHAT happened is
    // the absence of `claude-opus-5` from `modelUsage`. Key on cost and this reads as a
    // crash worth re-running.
    const r = classifyResult(OPUS_CAPPED, OPUS_5);
    expect(r.kind).toBe('unavailable');
    expect(r.why, 'naming the model that never ran').toContain(OPUS_5);
    expect(r.why, 'and what did run, so the reader can check').toMatch(/claude-haiku/);
  });

  it('calls a run that reached the model and died a failure, not a cap', () => {
    // THE DISTINCTION THAT MATTERS: this one is worth re-running, the cap is not.
    expect(classifyResult(MID_RUN, OPUS_5).kind).toBe('failed');
  });

  it('calls a clean run ok', () => {
    expect(classifyResult(HEALTHY, OPUS_5).kind).toBe('ok');
  });

  it('matches a dated key against the family the init named', () => {
    // The init says `claude-opus-5`; a key may arrive as `claude-opus-5-20260101`. A
    // strict equality test would read that as "Opus never ran" and call a HEALTHY run
    // a cap — failing towards `capped`, the one direction that must never happen.
    const dated = { ...MID_RUN, is_error: false, modelUsage: { ...HAIKU, 'claude-opus-5-20260101': OPUS[OPUS_5] } };
    expect(classifyResult(dated, OPUS_5).kind).toBe('ok');
    expect(classifyResult({ ...dated, is_error: true }, OPUS_5).kind).toBe('failed');
  });

  describe('it fails towards `failed`, never towards `capped`', () => {
    // Calling a crash a cap tells a human to WAIT when they should ACT — the same class
    // of wrong advice this file removes, pointed the other way. So every case where the
    // evidence is incomplete lands on `failed`.
    it('reports failed when the configured model is unknown, even on the cap shape', () => {
      // No init message means no model to look for, and a non-empty `modelUsage` could
      // be a complete run. Only the `{}` case is unambiguous without it.
      expect(classifyResult(OPUS_CAPPED, '').kind).toBe('failed');
      expect(classifyResult(CAPPED, '').kind, 'but nothing at all still is').toBe('unavailable');
    });

    it('and a run that did not error is never a cap however cheap', () => {
      expect(classifyResult({ ...CAPPED, is_error: false }, OPUS_5).kind).toBe('ok');
    });
  });

  it('calls a run that hit its turn cap `exhausted`, not a mid-run failure', () => {
    // `failed` advises "a re-run is reasonable", and for this shape it is the one
    // remedy that cannot work: the issue is too big for one run, so the re-run
    // reproduces it after the same ~34 minutes. RA-1694 paid that twice.
    expect(classifyResult(EXHAUSTED, OPUS_5).kind).toBe('exhausted');
    expect(classifyResult(EXHAUSTED, OPUS_5).why).toMatch(/turn cap/i);
  });

  it('calls a run stopped by --max-budget-usd `exhausted`, never `unavailable` or `ok` (RA-1879)', () => {
    // The CLI's result for a dollar-capped run (2.1.280): `subtype: 'error_max_budget_usd'`,
    // `is_error: true`, `terminal_reason: 'budget_exhausted'`. The configured model RAN —
    // it spent up to the cap — so this is not `unavailable`; and before RA-1879 it fell
    // through to `failed`, whose "a re-run is reasonable" is the one wrong advice.
    const OVER_BUDGET = {
      ...EXHAUSTED, subtype: 'error_max_budget_usd', terminal_reason: 'budget_exhausted', total_cost_usd: 60.4,
    };
    const c = classifyResult(OVER_BUDGET, OPUS_5);
    expect(c.kind).toBe('exhausted');
    expect(c.why).toMatch(/--max-budget-usd/);
    expect(c.why).not.toMatch(/turn cap/);
    // Either signal alone suffices — a CLI that reports one and not the other is still a cap.
    expect(classifyResult({ ...OVER_BUDGET, subtype: 'error' }, OPUS_5).kind).toBe('exhausted');
    expect(classifyResult({ ...OVER_BUDGET, terminal_reason: undefined }, OPUS_5).kind).toBe('exhausted');
    // And the notice names the dollar cap and its remedy, not the turn cap's.
    const n = renderNotice(c.kind, c.why, { arm: 'implementer agent' });
    expect(n.title).toMatch(/dollar cap/);
    expect(n.body).toMatch(/RE-RUN REPRODUCES THIS/);
    expect(n.body).not.toMatch(/--max-turns|max_turns/);
    expect(n.body).not.toMatch(/re-run is reasonable/i);
    // Non-vacuity: the turn-cap notice is unchanged.
    expect(renderNotice('exhausted', classifyResult(EXHAUSTED, OPUS_5).why, { arm: 'x' }).body)
      .toMatch(/its turn cap is the thing to raise .*re-dispatch this run with a higher `max_turns` and a `reason`, up to Kanon's ceiling/);
  });

  it('does NOT call a run oversized just because it passed its turn count', () => {
    // The non-vacuity case for the rule above, on real rows: both of these are over
    // `--max-turns 150` and both finished. A classifier keyed on the count reddens here,
    // and that is the defect this case exists to catch — it sends healthy issues to be
    // decomposed, which is worse than the missing detection it was meant to add.
    for (const run of OVER_CAP_BUT_FINISHED) {
      expect(classifyResult(run, OPUS_5).kind, `num_turns ${run.num_turns} finished cleanly`).toBe('ok');
      // Still `ok` with the cap known, while the step that ran it passed: these two finished
      // on an action that didn't yet enforce `--max-turns` (kanon#1008).
      expect(classifyResult(run, OPUS_5, { maxTurns: 150, stepFailed: false }).kind).toBe('ok');
    }
  });

  it('calls a run the action failed past its turn cap `exhausted` (kanon#1008)', () => {
    const c = classifyResult(OVERSHOT, 'claude-opus-5-5', { maxTurns: 90, stepFailed: true });
    expect(c.kind).toBe('exhausted');
    expect(c.code).toBe('turn_cap');
    expect(c.why).toMatch(/turn cap/);
    expect(c.why, 'naming the count and the cap').toMatch(/num_turns 100 past --max-turns 90/);
    // And the turn cap's notice, not the dollar cap's.
    expect(renderNotice(c.kind, c.why, { arm: 'x' }).body)
      .toMatch(/its turn cap is the thing to raise .*re-dispatch this run with a higher `max_turns` and a `reason`/);
  });

  it('needs the failed step, the cap and the action\'s whole predicate to call an overshoot (kanon#1008)', () => {
    const model = 'claude-opus-5-5';
    // No failed step: the run finished, as the two rows above did.
    expect(classifyResult(OVERSHOT, model, { maxTurns: 90, stepFailed: false }).kind).toBe('ok');
    // No cap known: nothing to be past.
    expect(classifyResult(OVERSHOT, model, { stepFailed: true }).kind).toBe('ok');
    expect(classifyResult(OVERSHOT, model).kind).toBe('ok');
    // AT the cap is not past it: the action fails a step only on `num_turns > maxTurns`.
    expect(classifyResult({ ...OVERSHOT, num_turns: 90 }, model, { maxTurns: 90, stepFailed: true }).kind).toBe('ok');
    // An errored result is the action's other failure, and stays `failed`.
    expect(classifyResult({ ...OVERSHOT, subtype: 'error', is_error: true }, model, { maxTurns: 90, stepFailed: true }).kind)
      .toBe('failed');
    expect(classifyResult({ ...OVERSHOT, subtype: 'error_during_execution' }, model, { maxTurns: 90, stepFailed: true }).kind)
      .toBe('ok');
    // And a model that never ran is still `unavailable`, whatever the count.
    expect(classifyResult({ ...OPUS_CAPPED, num_turns: 100 }, OPUS_5, { maxTurns: 90, stepFailed: true }).kind)
      .toBe('unavailable');
  });

  it('still prefers `unavailable` when the model never ran, cap or no cap', () => {
    // Ordering is load-bearing: a run refused at the door spent no turns on the work, so
    // "decompose the issue" would be nonsense advice. `unavailable` wins.
    expect(classifyResult({ ...OPUS_CAPPED, terminal_reason: 'max_turns' }, OPUS_5).kind)
      .toBe('unavailable');
  });

  it('keys on the terminal reason even when is_error disagrees', () => {
    // If the two ever contradict each other, proposing a decomposition is the safe
    // direction — it suggests work rather than asserting the run was fine.
    expect(classifyResult({ ...EXHAUSTED, is_error: false }, OPUS_5).kind).toBe('exhausted');
  });

  it('leaves every other terminal reason classified as before', () => {
    expect(classifyResult({ ...MID_RUN, terminal_reason: 'api_error' }, OPUS_5).kind).toBe('failed');
    expect(classifyResult({ ...HEALTHY, terminal_reason: 'completed' }, OPUS_5).kind).toBe('ok');
    // An absent terminal_reason must not be read as a cap — 9 rows in the first week
    // carry none at all.
    expect(classifyResult(MID_RUN, OPUS_5).kind).toBe('failed');
  });

  it('no longer keys on spend or turn count', () => {
    // These were three quarters of the shipped predicate. They are now inert, and that
    // is the point: OPUS_CAPPED has real spend and CAPPED has none, and both are caps.
    expect(classifyResult({ ...CAPPED, num_turns: 30, total_cost_usd: 9 }, OPUS_5).kind).toBe('unavailable');
    expect(classifyResult({ ...MID_RUN, num_turns: 1, total_cost_usd: 0 }, OPUS_5).kind).toBe('failed');
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['a number', 7],
  ])('reports not-reached for %s rather than throwing', (_l, input) => {
    // WAS `unknown` (RA-1503 review). No result file is its own answer: these steps run
    // on `if: failure()`, true when ANY earlier step failed, and in most arms the agent
    // is near-last behind checkout, `npm ci`, `db:init` and a token mint. The absence
    // of the file is the evidence the agent never ran; "could not tell a cap from a
    // failure" there points the reader at the agent when the real failure is upstream
    // and already red — the noise `agent-review.yml:1841` fixed one PR earlier.
    expect(classifyResult(input as never).kind).toBe('not-reached');
  });

  it('treats a missing modelUsage key the same as an empty one', () => {
    const { modelUsage, ...noKey } = CAPPED;
    expect(modelUsage).toEqual({});
    expect(classifyResult(noKey, OPUS_5).kind).toBe('unavailable');
  });
});

describe('readResult', () => {
  const write = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-'));
    const f = join(dir, 'out.json');
    writeFileSync(f, body);
    return f;
  };

  it('reads the result out of a JSON array', () => {
    expect(readResult(write(JSON.stringify([{ type: 'system' }, CAPPED])))?.num_turns).toBe(1);
  });

  it('reads a bare result object', () => {
    expect(readResult(write(JSON.stringify(CAPPED)))?.num_turns).toBe(1);
  });

  it('reads the LAST result from a stream of objects', () => {
    // The action's output shape has changed across versions, so the result is found by
    // shape rather than by position — same reason `classifyResult` keys on fields.
    const body = `${JSON.stringify({ type: 'system' })}\n${JSON.stringify(HEALTHY)}\n${JSON.stringify(CAPPED)}`;
    expect(readResult(write(body))?.num_turns).toBe(1);
  });

  it('returns null for a missing file rather than throwing', () => {
    expect(readResult('/nonexistent/nope.json')).toBeNull();
  });

  it('returns null for a file with no result in it', () => {
    expect(readResult(write(JSON.stringify([{ type: 'system' }])))).toBeNull();
  });

  it('reads the REAL pretty-printed stream, which parses as neither shape', () => {
    // THE SILENT ABSENCE THIS FILE SHIPPED WITH. `JSON.parse` of the whole text throws
    // and no single line is a document, so the two handlers that existed both came back
    // empty and the script reported `not-reached` — healthy-looking output about a run
    // whose result was sitting right there.
    const r = readResult(write(REAL_STREAM));
    expect(r, 'the result must be found').not.toBeNull();
    expect(r?.duration_ms).toBe(211391);
  });
});

describe('parseObjects', () => {
  it.each([
    ['a JSON array', '[{"a":1},{"a":2}]', 2],
    ['a bare object', '{"a":1}', 1],
    ['one object per line', '{"a":1}\n{"a":2}', 2],
    ['concatenated pretty-printed objects', '{\n  "a": 1\n}\n{\n  "a": 2\n}', 2],
  ])('handles %s', (_l, raw, count) => {
    expect(parseObjects(raw)).toHaveLength(count);
  });

  it('does not let a brace inside a string move the depth', () => {
    // THE BRACES MUST BE UNBALANCED for this to test anything — mutation-checked. An
    // earlier version of this case used `"a { and a }"`, and a scanner with string
    // tracking removed still found both objects, because the two braces cancelled and
    // the depth landed back in the right place anyway. A single unmatched `{` inside a
    // string is what a prompt or an error message actually contains, and it makes a
    // naive scanner swallow the next object whole: depth never returns to 0, so the
    // result is never emitted and the arm reports `not-reached`.
    const raw = '{\n  "msg": "an unclosed { brace and a \\" quote"\n}\n{\n  "type": "result"\n}';
    const objs = parseObjects(raw);
    expect(objs).toHaveLength(2);
    expect(objs[0].msg).toBe('an unclosed { brace and a " quote');
    expect(objs[1].type, 'the object AFTER the tricky one must survive').toBe('result');
  });

  it('does not let an escaped quote end the string early', () => {
    // `\\"` inside a JSON string: a scanner that treats every `"` as a delimiter flips
    // back into brace-counting mid-string and mis-reads the `}` that follows.
    const objs = parseObjects('{"msg":"he said \\"hi}\\" loudly"}\n{"type":"result"}');
    expect(objs).toHaveLength(2);
    expect(objs[1].type).toBe('result');
  });

  it('ignores surrounding log text rather than choking on it', () => {
    const objs = parseObjects('Log saved to /tmp/x.json\n{"type":"result"}\n##[error] boom }');
    expect(objs).toHaveLength(1);
  });

  it('returns [] for text with no objects at all', () => {
    expect(parseObjects('not json')).toEqual([]);
  });
});

describe('readConfiguredModel', () => {
  const write = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-model-'));
    const f = join(dir, 'out.json');
    writeFileSync(f, body);
    return f;
  };

  it('reads the model out of the init message', () => {
    expect(readConfiguredModel(write(REAL_STREAM))).toBe(OPUS_5);
  });

  it('reads it out of a JSON array too', () => {
    const body = JSON.stringify([{ type: 'system', subtype: 'init', model: OPUS_5 }, CAPPED]);
    expect(readConfiguredModel(write(body))).toBe(OPUS_5);
  });

  it('returns empty rather than throwing when there is no init or no file', () => {
    // Empty is the SAFE answer: `classifyResult` without a model reports `failed` for
    // anything with a non-empty `modelUsage`, which advises acting rather than waiting.
    expect(readConfiguredModel(write(JSON.stringify(CAPPED)))).toBe('');
    expect(readConfiguredModel('/nonexistent/nope.json')).toBe('');
  });
});

describe('renderNotice', () => {
  it('tells a human to WAIT when the model was unreachable, and not to re-run now', () => {
    // The whole point. The pre-RA-1408 annotation said "Re-run with: gh workflow run …"
    // for every no-verdict run, which is the wrong instruction for 3 of the 10
    // measured failures.
    const n = renderNotice('unavailable', 'x never ran', { arm: 'review agent', recover: 'gh workflow run x' });
    expect(n.body).toMatch(/\bwait\b/i);
    // IT MAY STILL EXONERATE THE PR — that half was accurate and is worth keeping; only
    // "or the workflow" was the over-claim, since a configuration defect IS in the
    // workflow. The hedge covers the one case where the PR is implicated: a PR that
    // edits the arm's own model id or `claude_args`.
    expect(n.body, 'it must say this is not the PR\'s fault').toMatch(/not a defect in the PR's code/i);
    expect(n.body, 'but not exonerate the workflow').not.toMatch(/or the workflow/);
    expect(n.body, 'and must warn that retrying now repeats it').toMatch(/fails the same way/);
    expect(n.body, 'and it still hands over the recovery command').toContain('gh workflow run x');
  });

  it('names BOTH causes and asserts neither', () => {
    // IT CANNOT TELL THEM APART, and it was caught claiming it could: the developer
    // read "this is the Claude subscription's usage cap" during an Anthropic OUTAGE.
    // The signature is identical — the request is refused before it bills either way —
    // so the honest annotation offers both and gives the status page to settle it.
    const n = renderNotice('unavailable', 'x never ran', { arm: 'review agent' });
    expect(n.body).toMatch(/usage cap/);
    expect(n.body).toMatch(/outage/);
    expect(n.body, 'with somewhere to check which').toContain('status.anthropic.com');
    expect(n.body, 'and it must not assert one of them').not.toMatch(/This is the Claude/);
  });

  it('still advises waiting when there is no recovery command to give', () => {
    // All but one arm pass no `--recover` (they are event-triggered, so a
    // dispatch line would be noise). The wait advice must not hang off it.
    const n = renderNotice('unavailable', 'x never ran', { arm: 'Overseer' });
    expect(n.body).toMatch(/\bwait\b/i);
    expect(n.body).toMatch(/re-trigger this arm/);
  });

  it('tells a human a plain re-run reproduces a turn-cap stop', () => {
    const n = renderNotice('exhausted', 'it stopped at its turn cap (num_turns 151)', {
      arm: 'implementer agent',
    });
    expect(n.level).toBe('error');
    expect(n.body).toMatch(/RE-RUN REPRODUCES THIS/);
    // And it must NOT carry the sentence that makes `failed` wrong here.
    expect(n.body).not.toMatch(/re-run is reasonable/i);
  });

  it('names BOTH remedies and asserts neither, because every arm emits this', () => {
    // ROUND 1 FINDING. The first cut asserted implement-lane facts — "no PR and no
    // branch", "DECOMPOSE the issue" — on a notice every arm renders. It would have
    // printed them on the Overseer and the two digests, where no issue is being built,
    // and CONTRADICTED `agent-code-audit.yml`'s overage warning, which says to raise the
    // cap on this exact path per RA-846. (The Overseer's arm said so too until RA-1939; it
    // now asserts no cause. This path is unaffected — it fires only on a real
    // `max_turns` terminal reason, where raising the cap IS the remedy.)
    const n = renderNotice('exhausted', 'x', { arm: 'Overseer agent' });
    expect(n.body).toMatch(/splitting/);
    expect(n.body).toMatch(/its turn cap is the thing to raise/);
    expect(n.body).toMatch(/RA-846/);
    // kanon#891: the remedy names the input an adopter can set, its ceiling, the one doc that
    // states both, and the telemetry that tells "raise" from "split".
    expect(n.body).toMatch(/re-dispatch this run with a higher `max_turns` and a `reason`, up to Kanon's ceiling for the lane, which raises the limit for that one run/);
    expect(n.body).toMatch(/or split the work/);
    expect(n.body).toMatch(/docs\/lanes\.md, "The turn budget"/);
    expect(n.body).toMatch(/telemetry row shows the turns it took/);
    // The consequences it cannot observe must be gone for good.
    expect(n.body).not.toMatch(/no PR and no branch/);
    expect(n.body).not.toMatch(/reviewable-sized PR/);
    expect(n.body).not.toMatch(/DECOMPOSE the issue/);
  });

  it('names no re-dispatch on a lane no dispatch can raise, the deploy-diagnose lane (kanon#1009)', () => {
    // ADR 0005 as amended by #1001: `max_turns` is raised only for one dispatched run, and the
    // deploy-diagnose lane's caller has no dispatch (docs/lanes.md, "The turn budget").
    const n = renderNotice('exhausted', 'x', { arm: 'deploy diagnose agent', raisable: false });
    expect(n.body).not.toMatch(/re-dispatch|max_turns/);
    expect(n.body).toMatch(/This lane's limit can't be raised for one run, since no dispatch starts it, so split the work if it divides/);
    expect(n.body).toMatch(/that is Kanon's to change \(docs\/lanes\.md, "The turn budget"\)/);
    expect(n.body).toMatch(/telemetry row shows the turns it took/);
    // Non-vacuity: the default is a lane that takes the raise.
    expect(renderNotice('exhausted', 'x', { arm: 'deploy diagnose agent' }).body).toMatch(/re-dispatch this run with a higher `max_turns`/);
  });

  it('frames a recovery command instead of appending it bare after "do not re-run"', () => {
    // ROUND 1 FINDING. `agent-review.yml` is the only arm passing `--recover`, and its
    // value IS a re-dispatch command — so appending it unframed produced "a re-run
    // reproduces this … gh workflow run agent-review.yml". Its two sibling arms frame
    // theirs for exactly this reason; this one had to as well.
    const n = renderNotice('exhausted', 'x', {
      arm: 'review agent', recover: 'gh workflow run agent-review.yml -f pr_number=123',
    });
    expect(n.body).toMatch(/Once it is done: gh workflow run agent-review\.yml/);
    expect(n.body).toMatch(/Decide which before re-triggering/);
    // Non-vacuity: with nothing to recover with, no dangling framing is printed.
    expect(renderNotice('exhausted', 'x', { arm: 'review agent' }).body)
      .not.toMatch(/Once it is done/);
  });

  it('tells a human a re-run IS reasonable after a mid-run failure', () => {
    const n = renderNotice('failed', 'x', { arm: 'review agent', recover: 'gh workflow run x' });
    expect(n.body).toMatch(/re-run is reasonable/i);
    expect(n.body).toContain('gh workflow run x');
  });

  it('does not assert WHICH cause left no result file', () => {
    // THE SAME OVER-CLAIM `capped`->`unavailable` fixed, one kind over (RA-1503 review):
    // it said "This job failed BEFORE the agent started", but two causes leave no file
    // — the job died before the agent step, or the agent step died before writing one —
    // and nothing here can tell them apart. Asserting the first tells a reader to look
    // upstream when the agent itself may be the failing step.
    const n = renderNotice('not-reached', 'the agent produced no result file', { arm: 'review agent' });
    expect(n.body, 'the job-died-first cause').toMatch(/failed BEFORE/);
    expect(n.body, 'AND the agent-died-first cause').toMatch(/died before writing one/);
    expect(n.body, 'stated as alternatives, not as a finding').toMatch(/cannot tell which/);
    expect(n.body, 'and it must not be read as cap evidence').toMatch(/not evidence either way/);
  });

  it('carries the recovery command on the not-reached path too', () => {
    // `agent-review.yml`'s failure branch used to point at "the annotation above" as
    // the only carrier of the dispatch command, and this path dropped it.
    const n = renderNotice('not-reached', 'x', { arm: 'review agent', recover: 'gh workflow run x' });
    expect(n.body).toContain('gh workflow run x');
  });

  it('names a CONFIGURATION defect as the third unreachable cause', () => {
    // A cap and an outage both resolve by waiting; an expired `CLAUDE_CODE_OAUTH_TOKEN`,
    // an unreachable model id or bad `claude_args` produce the IDENTICAL observable
    // (errored, configured model absent from `modelUsage`) and never resolve. Telling a
    // human to wait on those is the wait-when-you-should-act direction again — and the
    // widened predicate dropped the turn/spend corroboration that used to separate
    // "refused at the door" from "died before the first call" (RA-1503 review).
    const n = renderNotice('unavailable', 'x never ran', { arm: 'digest agent' });
    expect(n.body).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(n.body, 'and how a human tells it apart: waiting stops working').toMatch(/keeps reporting unreachable across a reset/);
    expect(n.body, 'so it must not claim the workflow is exonerated').not.toMatch(/NOT a defect in the PR or the workflow/);
  });

  describe('a non-fatal agent step (the two digests)', () => {
    // `continue-on-error: true` means the job finishes GREEN when the agent fails, so
    // an `::error` annotation would read as the thing that failed when nothing did.
    it('drops the level to warning and says the job is not red because of this', () => {
      const n = renderNotice('unavailable', 'x never ran', { arm: 'digest agent', nonFatal: true });
      expect(n.level, 'error would misread as the cause of a green run').toBe('warning');
      expect(n.body).toMatch(/non-fatal/);
      expect(n.body, 'and it must redirect a reader who IS looking at a red run').toMatch(/read it above/);
    });

    it('leaves the level alone for the eleven arms that red their job', () => {
      expect(renderNotice('unavailable', 'x', { arm: 'a' }).level).toBe('error');
      expect(renderNotice('failed', 'x', { arm: 'a' }).level).toBe('error');
    });
  });

  it('falls towards ACT, not WAIT, when it cannot tell', () => {
    // Failing towards "capped" would advise waiting on a real crash — the same class
    // of wrong advice this removes, pointed the other way.
    const n = renderNotice('unknown', 'no result object');
    expect(n.level).toBe('warning');
    expect(n.body).toMatch(/Treating it as a real failure/);
    expect(n.body).not.toMatch(/wait for the cap/i);
  });
});

// Its cases run the classifier's CLI in `node`, so the block takes the spawn budget (#436).
describe('the CLI, run as the workflow runs it', SPAWNS, () => {
  const script = join(process.cwd(), 'actions/agent-classify/classify-agent-result.mjs');

  const run = (body: string | null, extra: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-cli-'));
    const file = join(dir, 'claude-execution-output.json');
    if (body !== null) writeFileSync(file, body);
    const out = join(dir, 'out.txt');
    const summary = join(dir, 'summary.md');
    writeFileSync(out, '');
    writeFileSync(summary, '');
    const r = spawnSync(process.execPath, [script, '--file', file, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    });
    return {
      status: r.status,
      stdout: r.stdout,
      outputs: readFileSync(out, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
    };
  };

  it('annotates an unreachable model and exposes kind=unavailable', () => {
    const r = run(JSON.stringify(CAPPED), ['--arm', 'review agent']);
    expect(r.stdout).toMatch(/^::error title=the model was unreachable, not a failed run::/m);
    expect(r.outputs).toContain('kind=unavailable');
    expect(r.summary).toMatch(/⏳/);
  });

  it('calls the REAL Opus-cap run a cap, end to end', () => {
    // THE WHOLE PR IN ONE ASSERTION, and the one the unit tests could not make: it runs
    // the CLI over the actual bytes run 33764297592 produced. It fails if the reader
    // cannot parse that shape, if the init model is not plumbed into `classifyResult`,
    // or if the predicate goes back to keying on spend — the three separate ways this
    // shipped wrong.
    const r = run(REAL_STREAM, ['--arm', 'review agent']);
    expect(r.outputs, 'a cap, not a crash worth re-running').toContain('kind=unavailable');
    expect(r.stdout).toMatch(/^::error title=the model was unreachable, not a failed run::/m);
    expect(r.stdout, 'and it names the model that was refused').toContain(OPUS_5);
    expect(r.stdout, 'all three causes named, none asserted').toMatch(/usage cap, an Anthropic outage/);
    expect(r.stdout).toMatch(/status\.anthropic\.com/);
  });

  it('annotates a mid-run failure differently', () => {
    const r = run(JSON.stringify(MID_RUN));
    expect(r.stdout).toMatch(/failed mid-run/);
    expect(r.outputs).toContain('kind=failed');
  });

  it('ALWAYS exits 0, so explaining a red run cannot create one', () => {
    // A classifier bug must not turn a healthy arm red. The arm's own steps decide the
    // job outcome, exactly as before this script existed.
    for (const body of [JSON.stringify(CAPPED), JSON.stringify(MID_RUN), JSON.stringify(HEALTHY), 'not json', null]) {
      expect(run(body).status, `exit 0 for ${String(body).slice(0, 18)}`).toBe(0);
    }
  });

  it('sends a missing result file to the failing step, without blaming the agent', () => {
    // THIS CASE LOCKED THE AMBIGUOUS WORDING IN PLACE (RA-1503 review): it asserted
    // `not classified` for a missing file, the same noise `agent-review.yml` had
    // already fixed — an annotation pointing at the agent makes the actionable message
    // harder to find. It then locked in the OPPOSITE over-claim for one round, naming
    // "this job failed before the agent started" as fact.
    const r = run(null);
    expect(r.stdout).toMatch(/no result to classify/);
    expect(r.stdout).toMatch(/read the failing step above this one/i);
    expect(r.stdout, 'both causes, neither asserted').toMatch(/cannot tell which/);
    expect(r.stdout, 'and must not implicate a cap or an outage').not.toMatch(/status\.anthropic\.com/);
    expect(r.outputs).toContain('kind=not-reached');
  });

  it('says a clean agent run is not the cause, when something later failed', () => {
    // `ok` had no branch and fell through to the `unknown` text — reporting "could not
    // tell" about a run it HAD classified, on exactly the path this change measured and
    // did not fix (2 of 10: agent finished, produced no artifact).
    const r = run(JSON.stringify(HEALTHY), ['--arm', 'Overseer agent']);
    expect(r.stdout).toMatch(/finished cleanly/);
    expect(r.stdout).toMatch(/downstream of it/);
    expect(r.outputs).toContain('kind=ok');
  });

  // KANON#1015. Run 38628914592's telemetry row said `exhausted` once #1012 handed the
  // classifier the cap and the step's outcome, and its notice still said "finished cleanly",
  // because the CLI handed it neither.
  it('says a run the action failed past its turn cap hit its turn cap (kanon#1015)', () => {
    const r = run(JSON.stringify(OVERSHOT), [
      '--arm', 'Lead agent', '--claude-args', '--model claude-opus-5-5\n--max-turns 90\n', '--agent-outcome', 'failure',
    ]);
    expect(r.outputs).toContain('kind=exhausted');
    expect(r.stdout).toMatch(/^::error title=Lead agent ran out of turns/m);
    expect(r.stdout).toMatch(/num_turns 100 past --max-turns 90/);
    expect(r.stdout, 'and not the clean finish it used to print').not.toMatch(/finished cleanly|downstream of it/);
    expect(r.summary).toMatch(/🪫/);
  });

  it('keeps the clean-finish notice when the agent step did not fail, or the cap is unknown (kanon#1015)', () => {
    const args = ['--claude-args', '--max-turns 90'];
    // The agent step passed, so whatever reddened the job is downstream of it.
    for (const extra of [[...args, '--agent-outcome', 'success'], args, ['--agent-outcome', 'failure'],
      ['--claude-args', '--model claude-opus-5-5', '--agent-outcome', 'failure'], []]) {
      const r = run(JSON.stringify(OVERSHOT), extra);
      expect(r.outputs, extra.join(' ')).toContain('kind=ok');
      expect(r.stdout).toMatch(/finished cleanly/);
    }
  });
});

/**
 * RA-2691 — the `agent-classify` block, run as the runner runs it: its one step, under its
 * own shell, from the block's own directory (`$GITHUB_ACTION_PATH`). Its three inputs reach
 * the CLI as the flags the six callers used to write by hand, and its two outputs are the
 * CLI's — so a red run prints the same `kind` and `retry` through the block as it did
 * inline.
 */
// Its cases run the block's step in `bash`, which runs `node`, so the block takes the spawn budget (#436).
describe('the agent-classify block, run as the runner runs it (RA-2691)', SPAWNS, () => {
  const block = readBlock('agent-classify');
  const step = block.runs.steps[0]!;
  type Inputs = { arm?: string; recover?: string; nonFatal?: string; claudeArgs?: string; agentOutcome?: string; raisable?: string };
  const run = (result: unknown, inputs: Inputs = {}) => {
    const temp = mkdtempSync(join(tmpdir(), 'classify-block-'));
    if (result !== null) writeFileSync(join(temp, 'claude-execution-output.json'), JSON.stringify(result));
    return runWorkflowStep(step as never, {
      cwd: tmpdir(),
      env: {
        GITHUB_ACTION_PATH: join(process.cwd(), 'actions/agent-classify'),
        RUNNER_TEMP: temp,
        ARM: inputs.arm ?? 'x agent',
        RECOVER: inputs.recover ?? '',
        NON_FATAL: inputs.nonFatal ?? 'false',
        CLAUDE_ARGS: inputs.claudeArgs ?? '',
        AGENT_OUTCOME: inputs.agentOutcome ?? '',
        RAISABLE: inputs.raisable ?? 'true',
      },
    });
  };

  it('is one step, wired to the block\'s inputs through env and to its outputs by id', () => {
    expect(block.runs.steps).toHaveLength(1);
    expect(step.id).toBe('classify');
    expect(step.if, 'the caller gates it').toBeUndefined();
    expect(step.env).toEqual({
      ARM: '${{ inputs.arm }}', RECOVER: '${{ inputs.recover }}', NON_FATAL: '${{ inputs.non-fatal }}',
      CLAUDE_ARGS: '${{ inputs.claude-args }}', AGENT_OUTCOME: '${{ inputs.agent-outcome }}',
      RAISABLE: '${{ inputs.raisable }}',
    });
    expect(String(step.run), 'no input is spliced into the script text').not.toMatch(/\$\{\{/);
    expect(block.outputs?.kind?.value).toBe('${{ steps.classify.outputs.kind }}');
    expect(block.outputs?.retry?.value).toBe('${{ steps.classify.outputs.retry }}');
    // TWO OUTPUTS, AS THIS SUITE'S HEADER SAYS (#314). It said two while the block declared
    // three, because nothing asserted the SET: the third, `code`, was read by no caller and
    // its description sent the reader to `agent-telemetry`, which derives that value itself.
    expect(Object.keys(block.outputs ?? {})).toEqual(['kind', 'retry']);
    expect(Object.keys(block.inputs ?? {}).sort()).toEqual(['agent-outcome', 'arm', 'claude-args', 'non-fatal', 'raisable', 'recover']);
    expect(block.inputs?.recover?.default).toBe('');
    expect(block.inputs?.['non-fatal']?.default).toBe('false');
    expect(block.inputs?.['claude-args']?.default).toBe('');
    expect(block.inputs?.['agent-outcome']?.default).toBe('');
    expect(block.inputs?.raisable?.default).toBe('true');
  });

  it('names no re-dispatch with `max_turns` when the lane is not raisable, and does by default (kanon#1009)', () => {
    expect(run(EXHAUSTED, { raisable: 'false' }).stdout).not.toMatch(/re-dispatch|max_turns/);
    expect(run(EXHAUSTED).stdout).toMatch(/re-dispatch this run with a higher `max_turns`/);
  });

  it('calls a run the action failed past its turn cap `exhausted`, from the flags and the outcome it is handed (kanon#1015)', () => {
    // The flags arrive as the multi-line block a lane writes, and stay one value.
    const flags = '--model claude-opus-5-5\n--max-turns 90\n--allowedTools "Bash(git *)"\n';
    const r = run(OVERSHOT, { claudeArgs: flags, agentOutcome: 'failure' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toMatchObject({ kind: 'exhausted', retry: '' });
    expect(r.stdout).toMatch(/ran out of turns/);
    // A step that failed only downstream keeps its notice, and so does a caller that hands neither.
    expect(run(OVERSHOT, { claudeArgs: flags, agentOutcome: 'success' }).outputs.kind).toBe('ok');
    expect(run(OVERSHOT).outputs.kind).toBe('ok');
  });

  it('keeps hostile flags as data (kanon#1015)', () => {
    const r = run(OVERSHOT, { claudeArgs: `--max-turns 90 $(touch /tmp/never) "q'`, agentOutcome: 'failure' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs.kind).toBe('exhausted');
  });

  it('runs the script in its own directory, not the checked-out tree\'s', () => {
    // cwd is a directory with no `.github/` at all: only `$GITHUB_ACTION_PATH` can find it.
    const r = run(CAPPED);
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs.kind).toBe('unavailable');
    expect(String(step.run)).toContain('"$GITHUB_ACTION_PATH/classify-agent-result.mjs"');
  });

  it('prints the same kind and retry as the CLI run by hand, for each retry class', () => {
    // And writes NOTHING ELSE to `$GITHUB_OUTPUT` (#314): a step output the block does not
    // publish has no reader, inside the block or outside it.
    expect(Object.keys(run(CAPPED).outputs).sort()).toEqual(['kind', 'retry']);
    expect(run(CAPPED).outputs).toMatchObject({ kind: 'unavailable', retry: 'unreachable' });
    expect(run({ ...MID_RUN, terminal_reason: 'api_error' }).outputs).toMatchObject({ kind: 'failed', retry: 'api_error' });
    expect(run(MID_RUN).outputs).toMatchObject({ kind: 'failed', retry: '' });
    expect(run(EXHAUSTED).outputs).toMatchObject({ kind: 'exhausted', retry: '' });
    expect(run(HEALTHY).outputs).toMatchObject({ kind: 'ok', retry: '' });
    expect(run(null).outputs).toMatchObject({ kind: 'not-reached', retry: '' });
  });

  it('names the arm, and keeps a hostile one as data', () => {
    const r = run(MID_RUN, { arm: `it's $(touch /tmp/never) "quoted"` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`it's $(touch /tmp/never) "quoted" failed mid-run`);
  });

  it('passes `recover` only when there is one, and `non-fatal` only when it is \'true\'', () => {
    const plain = run(MID_RUN);
    expect(plain.stdout).toMatch(/^::error title=x agent failed mid-run::/m);
    expect(plain.stdout).not.toMatch(/gh workflow run/);
    const recover = run(MID_RUN, { recover: 'gh workflow run agent-review.yml -f pr_number=7' });
    expect(recover.stdout).toContain('A re-run is reasonable here. gh workflow run agent-review.yml -f pr_number=7');
    const nonFatal = run(MID_RUN, { nonFatal: 'true' });
    expect(nonFatal.stdout, 'a non-fatal step warns').toMatch(/^::warning title=/m);
    expect(nonFatal.stdout).toMatch(/non-fatal/);
    expect(run(MID_RUN, { nonFatal: 'false' }).stdout, "'false' is not non-fatal").toMatch(/^::error /m);
  });
});

/**
 * KANON#1015 — every caller of `agent-classify` hands it the flags the agent ran with and the
 * agent step's outcome, which the classifier needs to call a run the action failed past its turn
 * cap (kanon#1008). A caller that hands neither still classifies, by the terminal reason alone,
 * so a missing pair is silent: the notice says "finished cleanly" beside a telemetry row that
 * says `exhausted`. Hence the census.
 */
describe('every caller hands agent-classify the flags that ran and the agent step\'s outcome (kanon#1015)', () => {
  type Step = { id?: string; uses?: string; with?: Record<string, string> };
  const isClassify = (s: Step) => laneBlockOf(s) === 'agent-classify';
  // The smoke classifies a fixture it copies into place: there is no agent step to read.
  const NO_AGENT = 'agent-blocks-smoke.yml';
  const calls = readdirSync('.github/workflows').filter((f) => f.endsWith('.yml')).flatMap((f) => {
    const d = parse(readFileSync(join('.github/workflows', f), 'utf8'));
    return Object.entries<{ steps?: Step[] }>(d?.jobs ?? {}).flatMap(([job, def]) => (def.steps ?? [])
      .filter(isClassify).map((s) => ({ where: `${f}:${job}`, file: f, step: s, steps: def.steps! })));
  });

  it('finds the calls it is about', () => {
    expect(calls.map((c) => c.file).sort()).toEqual([
      'agent-blocks-smoke.yml', 'agent-project-digest.yml', 'agent-weekly-digest.yml', 'code-audit-agent-job.yml',
      'explore-telemetry-agent-job.yml', 'overseer-agent-job.yml', 'review-agent-job.yml',
    ]);
  });

  it.each(calls.filter((c) => c.file !== NO_AGENT).map((c) => [c.where, c] as const))(
    '%s passes its agent-run call\'s flags and outcome',
    (_w, c) => {
      const agent = c.steps.find((s) => laneBlockOf(s) === 'agent-run');
      expect(agent?.id, 'the job runs its agent through agent-run, with an id to read').toBeTruthy();
      expect(c.step.with?.['claude-args']).toBe(`\${{ steps.${agent!.id}.outputs.claude-args }}`);
      expect(c.step.with?.['agent-outcome']).toBe(`\${{ steps.${agent!.id}.outcome }}`);
    },
  );

  it('agent-finish passes the flags its row records, and whether the agent stage failed', () => {
    const finish = readBlock('agent-finish');
    const step = finish.runs.steps.find((s) => s.id === 'classify')!;
    const telemetry = finish.runs.steps.find((s) => s.uses === '$/actions/agent-telemetry')!;
    expect(step.with?.['claude-args'], 'the same flags as the telemetry row').toBe(telemetry.with?.claude_args);
    expect(step.with?.['claude-args']).toBe('${{ inputs.claude-args-ran || inputs.claude_args }}');
    // A lane whose agent step can fail reports it in its `agent` stage; one that runs it
    // `continue-on-error` passes the outcome, and classifies in a step of its own anyway.
    expect(step.with?.['agent-outcome'])
      .toBe("${{ inputs.agent-outcome || contains(inputs.stages, 'agent=failure') && 'failure' || '' }}");
    // What it evaluates to, on the folded stages a lane writes and the outcome one passes.
    const outcome = (inputs: Record<string, string>) =>
      interpolate(step.with?.['agent-outcome'], { inputs: { 'agent-outcome': '', stages: '', ...inputs } });
    expect(outcome({ stages: 'token=success checkout=success hook=success setup=success agent=failure' })).toBe('failure');
    expect(outcome({ stages: 'token=success checkout=success hook=success setup=success\nagent=failure' })).toBe('failure');
    expect(outcome({ stages: 'token=success checkout=success hook=success setup=success agent=success' }), 'failed downstream').toBe('');
    expect(outcome({ stages: 'token=success checkout=failure hook=skipped setup=skipped agent=skipped' })).toBe('');
    expect(outcome({ 'agent-outcome': 'failure', stages: 'agent=success' })).toBe('failure');
    expect(outcome({})).toBe('');
  });
});
