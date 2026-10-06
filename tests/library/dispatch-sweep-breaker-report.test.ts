import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asAgent } from './helpers/sign.js';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
const { MARKER, actionCell, breakerTripped, classify, renderReport, SWEEP_LOGIN, AGENT_LOGIN } = await import('../../scripts/dispatch-sweep.mjs');

/**
 * RA-1260 — the step summary must say what the run DID, and a dry run must preview the
 * RA-916 breaker.
 *
 * The table was rendered before the breaker decided, with the Action column reading
 * `v.act` unconditionally, and a dry run returned ahead of the breaker entirely. So the
 * exact scenario the breaker exists for — the implementer down, every issue agent-silent
 * — produced a persistent summary reading "stop" on every row of a run that stopped
 * none, and the preview a human runs first showed the unbounded verdicts.
 */

const H = 3600e3;
const now = Date.now();
const issue = (number: number) => ({ number, title: `t${number}`, createdAt: new Date(now - 500 * H).toISOString() });
const sweepAt = (h: number) => ({ login: SWEEP_LOGIN, body: `x ${MARKER}`, createdAt: new Date(now - h * H).toISOString() });
const agentAt = (h: number) => ({ login: AGENT_LOGIN, body: asAgent(AGENT_LOGIN, 'built it'), createdAt: new Date(now - h * H).toISOString() });
/** Never answered, at the re-dispatch cap -> stop, agent-silent. */
const fleetDown = (n: number) => classify(issue(n), [sweepAt(300), sweepAt(200)], false, { now });
/** The agent HAS spoken, so the fleet-wide arm does not apply. */
const answered = (n: number) => classify(issue(n), [sweepAt(300), sweepAt(200), agentAt(100)], false, { now });

const actionColumn = (text: string) =>
  text.split('\n').filter((l) => /^\| \[#\d+\]/.test(l)).map((l) => l.split('|')[4].trim());

describe('RA-1260 — a withheld stop is reported as withheld', () => {
  const verdicts = [fleetDown(1), fleetDown(2), fleetDown(3)];
  const breaker = breakerTripped(verdicts);

  it('the fixture trips the breaker and carries stops — so the assertions below can fail', () => {
    expect(breaker.tripped).toBe(true);
    expect(verdicts.every((v) => v.act === 'stop')).toBe(true);
  });

  it('the Action column never says a bare `stop` on a tripped run', () => {
    const { text } = renderReport(verdicts, { apply: true, breaker });
    expect(actionColumn(text)).toEqual(['stop (withheld)', 'stop (withheld)', 'stop (withheld)']);
  });

  it('the summary carries the breaker\'s reason and a withheld count, not only the annotation', () => {
    const { text } = renderReport(verdicts, { apply: true, breaker });
    expect(text).toContain('Circuit breaker (RA-916) withheld every stop this run.');
    expect(text).toContain(breaker.reason);
    expect(text).toMatch(/3 stop\(s\) withheld by the breaker/);
  });

  it('a DRY RUN previews it — "would withhold" — rather than showing the unbounded verdicts', () => {
    const { text } = renderReport(verdicts, { apply: false, breaker });
    expect(text).toContain('**Dry run.**');
    expect(text).toContain('Circuit breaker (RA-916) would withhold every stop this run.');
    expect(actionColumn(text)).toEqual(['stop (withheld)', 'stop (withheld)', 'stop (withheld)']);
  });

  it('an untripped run still reports a plain `stop`', () => {
    const v = [fleetDown(1), answered(2), answered(3)];
    const b = breakerTripped(v);
    expect(b.tripped).toBe(false);
    expect(v[0].act).toBe('stop');
    const { text } = renderReport(v, { apply: true, breaker: b });
    expect(actionColumn(text)).toContain('stop');
    expect(text).not.toContain('Circuit breaker');
    expect(text).not.toContain('withheld');
  });

  it('never marks a dispatch withheld — the breaker only ever holds stops', () => {
    expect(actionCell({ act: 'dispatch' }, { tripped: true })).toBe('dispatch');
    expect(actionCell({ act: null }, { tripped: true })).toBe('—');
  });
});

describe('RA-1260 — main() decides the breaker before it reports and before a dry run returns', () => {
  const src = readFileSync(join(ROOT, 'scripts/dispatch-sweep.mjs'), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    if (i === -1 || src.indexOf(needle, i + 1) !== -1) throw new Error(`anchor missing or not unique — re-point: ${needle}`);
    return i;
  };

  it('orders: breakerTripped(verdicts) → report(verdicts, breaker) → if (!APPLY) return', () => {
    const decide = at('const breaker = breakerTripped(verdicts);');
    const rep = at('report(verdicts, breaker, costLine);');
    const dry = at('if (!APPLY) return;');
    expect(decide).toBeLessThan(rep);
    expect(rep).toBeLessThan(dry);
  });
});
