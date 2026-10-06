import { asAgent } from './helpers/sign.js';
import { describe, expect, it } from 'vitest';
import { AGENT_LOGIN, LANES, classify, terminalVerdict } from '../../scripts/dispatch-sweep.mjs';

/**
 * kanon#170 — a human-parked implement issue must leave the sweep's lane.
 *
 * The Maintainer parked an issue by hand ("built by hand, do not re-dispatch"), kept
 * `agent:implement` and added `qa:needs-info`. The Lead's eligible filter excludes that
 * issue; the sweep read the human's last word as `answered` and re-dispatched it, because
 * the implement lane declared no `terminal` labels and `qa:needs-info` was only ever its
 * own stop label.
 */

const [implement, triage] = LANES;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const agent = { login: AGENT_LOGIN, createdAt: '2026-10-01T00:00:00Z', body: asAgent(AGENT_LOGIN, 'Plan: … SCOPE-FIRST BAIL') };
const human = { login: 'maintainer', createdAt: '2026-10-02T00:00:00Z', body: 'Built by hand, do not re-dispatch.' };
const issue = (labels: string[]) => ({ number: 7, title: 't', labels: labels.map((name) => ({ name })) });

describe('the implement lane leaves an issue a human parked with `qa:needs-info`', () => {
  it('an issue with `qa:needs-info` and `agent:implement`, a human speaking last, is parked — not `answered`', () => {
    const v = classify(issue(['agent:implement', 'qa:needs-info']), [agent, human], false, { now: NOW, lane: implement });
    expect(v.state).toBe('parked');
    expect(v.act).toBeNull();
  });

  it('the control: without `qa:needs-info` the same conversation is `answered` and dispatches', () => {
    const v = classify(issue(['agent:implement']), [agent, human], false, { now: NOW, lane: implement });
    expect(v.state).toBe('answered');
    expect(v.act).toBe('dispatch');
  });

  it('a parked issue is never stopped, even with its attempts spent and a capped run on record', () => {
    const sweep = (at: string) => ({ login: 'example-lead', createdAt: at, body: '<!-- qa:dispatch-sweep -->' });
    const comments = [sweep('2026-09-01T00:00:00Z'), sweep('2026-09-05T00:00:00Z')];
    const v = classify(issue(['agent:implement', 'qa:needs-info']), comments, false,
      { now: NOW, lane: implement, exhaustedAt: Date.parse('2026-09-06T00:00:00Z') });
    expect(v.state).toBe('parked');
    expect(v.act).toBeNull();
  });

  it('`qa:needs-info` is terminal for the implement lane only — triage keeps its own verdicts', () => {
    expect(implement.terminal).toEqual(['qa:needs-info']);
    expect(terminalVerdict(issue(['qa:needs-info']), triage)).toBe(false);
    expect(classify(issue(['qa:false-positive']), [], false, { now: NOW, lane: triage }).state).toBe('triage-settled');
  });
});
