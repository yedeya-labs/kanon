import { describe, expect, it } from 'vitest';
import { classifyResult, preconditionStop, STOP_MARKER } from '../../actions/agent-classify/classify-agent-result.mjs';
import { STOP_RULE, withHeadless } from '../../actions/agent-run/persona-prompt.mjs';
import { stopNotice } from '../../actions/agent-run/stop-check.mjs';
import { failedStage } from '../../actions/agent-telemetry/agent-telemetry.mjs';
import { REASON_OUTCOME } from '../../actions/agent-telemetry/schema.mjs';

// kanon#1564: an agent that starts, finds a precondition its run needs doesn't hold, and stops
// without doing its work, ended green and silent, its row `ok`. It now ends its final message with
// a `KANON-STOP:` line, which agent-run warns on and agent-telemetry records as `failed`.
const MODEL = 'claude-opus-5';
const clean = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.4, terminal_reason: 'completed', modelUsage: { [MODEL]: {} }, result: text });

describe('a precondition the agent finds mid-run (#1564)', () => {
  it('asks every lane\'s agent for the marker line, only for a precondition, never for a stop that is the work', () => {
    expect(withHeadless('Do the work.').endsWith(STOP_RULE)).toBe(true);
    expect(STOP_RULE).toContain('`KANON-STOP: <what didn\'t hold, in one sentence>`');
    expect(STOP_RULE).toMatch(/Never write\s+it for a stop your instructions make part of the work/);
    expect(STOP_MARKER).toBe('KANON-STOP:');
  });

  it('classifies a clean run that ends with the marker as failed, precondition_stop, never ok', () => {
    const stopped = clean('I looked at #12 and #13.\nNeither is a project tracking issue, so I stopped.\nKANON-STOP: the context names no project tracking issue');
    expect(preconditionStop(stopped)).toBe('the context names no project tracking issue');
    expect(classifyResult(stopped, MODEL)).toEqual({ kind: 'failed', code: 'precondition_stop', why: 'the agent stopped on a precondition it found mid-run: the context names no project tracking issue' });
    // kanon#1639: its own code, under `failed`.
    expect(REASON_OUTCOME.precondition_stop).toBe('failed');
    // The row is valid: a failed outcome needs a failed stage, and a run whose stages all passed gets `agent`.
    expect(failedStage([['agent', 'success'], ['finish', 'success']], 'failed')).toBe('agent');
  });

  it('counts only a line that starts with the marker, and leaves every other clean run ok', () => {
    for (const text of ['Done: opened #5.', `I would write ${STOP_MARKER} here, but nothing failed.`, '']) {
      expect(preconditionStop(clean(text)), text).toBeNull();
      expect(classifyResult(clean(text), MODEL).kind, text).toBe('ok');
    }
    expect(preconditionStop(clean('KANON-STOP:'))).toBe('no reason given');
    expect(preconditionStop(clean(`KANON-STOP: ${'x'.repeat(400)}`))).toHaveLength(300);
    // A turn cap is still a turn cap, whatever the last message says.
    expect(classifyResult({ ...clean('KANON-STOP: x'), terminal_reason: 'max_turns' }, MODEL).kind).toBe('exhausted');
  });

  it('warns with the agent\'s reason, which can write no workflow command of its own', () => {
    expect(stopNotice(clean('Done.'))).toBeNull();
    const n = stopNotice(clean('KANON-STOP: 100% gone\r::error::injected'))!;
    expect(n.annotation).toBe('::warning title=agent-run::The agent stopped on a precondition and did no work: 100%25 gone%0D::error::injected');
    expect(n.summary).toContain('### The agent stopped on a precondition');
    // A line break can't reach the annotation: the reason is one line, and CR and LF are encoded.
    const crlf = stopNotice({ ...clean(''), result: 'KANON-STOP: a\rb' })!;
    expect(crlf.annotation).not.toMatch(/[\r\n]/);
  });

  // kanon#1639: the importer knows the sentence, and the rise comparison leaves the code out.
  it("imports the sentence as its code, and the rise leaves it out while it groups as a signal of its own", async () => {
    const { reasonCode } = await import('../../infra/telemetry/import.mjs');
    expect(reasonCode({ outcome: 'failed', reason: 'the agent stopped on a precondition it found mid-run: no tracking issue' })).toEqual({ code: 'precondition_stop', derived: false });
    const { RISE, RISE_EXCLUDED_REASONS, detect } = await import('../../scripts/telemetry/kanon-bugs.mjs');
    expect(RISE_EXCLUDED_REASONS).toEqual(['precondition_stop']);
    const row = (i: number, version: string, reason: string, outcome = 'failed') => ({
      adopter: `a${i % 3}`, row_kind: 'run', tag: 'run', recorded_at: `2026-11-0${(i % 5) + 1}T00:00:00Z`, lane: 'lead', outcome, reason,
      ...(outcome === 'ok' ? {} : { failed_stage: 'agent' }), kanon_version: version,
    });
    const n = RISE.minRuns;
    const rows = [
      ...Array.from({ length: n }, (_, i) => row(i, '0.43.0', 'none', 'ok')),
      ...Array.from({ length: n }, (_, i) => row(i, '0.44.0', 'precondition_stop')),
    ];
    const r = detect(rows);
    expect(r.rises).toEqual([]);
    expect(r.signals.map((s: { reason: string; kanon_version: string }) => `${s.reason} ${s.kanon_version}`)).toEqual(['precondition_stop 0.44.0']);
    // The same runs as an agent that errored are a rise.
    const errored = detect([...rows.slice(0, n), ...Array.from({ length: n }, (_, i) => row(i, '0.44.0', 'did_not_finish'))]);
    expect(errored.rises).toHaveLength(1);
  });
});
