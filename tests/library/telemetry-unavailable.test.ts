import { describe, expect, it } from 'vitest';
import { MAX_RETRY_AFTER_MS, UNAVAILABLE, UNAVAILABLE_WAITS_MS, isUnavailable, retryUnavailable, type Answer } from '../../scripts/lib/telemetry-token.mjs';

/**
 * #1440: the store answers 503 `jwks-unavailable` to every token while it can't fetch GitHub's
 * signing keys, and never uses a stale one (plan 0008 §2.4), so the callers wait and ask again,
 * a bounded number of times and inside their deadline, rather than fail on the first refusal.
 */

const unavailable = (retryAfter: string | null = null): Answer => ({ status: 503, json: { error: UNAVAILABLE }, retryAfter });
const ok: Answer = { status: 200, json: { rows: [] }, retryAfter: null };

/** `answers` in turn, one per attempt; a clock that the waits move. */
function scripted(answers: Answer[]) {
  let now = 0;
  const slept: number[] = [];
  let tries = 0;
  return {
    slept,
    tries: () => tries,
    attempt: async () => {
      tries += 1;
      return answers[Math.min(tries, answers.length) - 1] as Answer;
    },
    sleep: async (ms: number) => { slept.push(ms); now += ms; },
    clock: () => now,
  };
}

describe('retryUnavailable: the store\'s 503 jwks-unavailable is asked again, bounded (#1440)', () => {
  it('waits past a cold container\'s 5-second refetch, then past a warm one\'s minute, and asks afresh each time', async () => {
    expect(UNAVAILABLE_WAITS_MS).toEqual([6_000, 61_000]);
    const s = scripted([unavailable(), unavailable(), ok]);
    expect(await retryUnavailable(s.attempt, s)).toBe(ok);
    expect(s.tries()).toBe(3);
    expect(s.slept).toEqual([6_000, 61_000]);
  });

  it('gives up after its waits, answering the store\'s last 503', async () => {
    const s = scripted([unavailable()]);
    expect(isUnavailable(await retryUnavailable(s.attempt, s))).toBe(true);
    expect(s.tries()).toBe(UNAVAILABLE_WAITS_MS.length + 1);
  });

  it('answers any other status at once: a 503 of another code, a 5xx, a refusal, a success', async () => {
    for (const a of [{ status: 503, json: { error: 'config' }, retryAfter: null }, { status: 502, json: null, retryAfter: null }, { status: 429, json: { error: 'quota' }, retryAfter: '60' }, { status: 401, json: { error: 'kid' }, retryAfter: null }, ok]) {
      const s = scripted([a, ok]);
      expect(await retryUnavailable(s.attempt, s), String(a.status)).toBe(a);
      expect(s.tries()).toBe(1);
      expect(s.slept).toEqual([]);
    }
  });

  it('waits the store\'s Retry-After instead, in whole seconds, up to its cap', async () => {
    expect(MAX_RETRY_AFTER_MS).toBe(90_000);
    const s = scripted([unavailable('2'), unavailable('3600'), ok]);
    await retryUnavailable(s.attempt, s);
    expect(s.slept).toEqual([2_000, MAX_RETRY_AFTER_MS]);
    const odd = scripted([unavailable('soon'), unavailable('1.5'), ok]);
    await retryUnavailable(odd.attempt, odd);
    expect(odd.slept).toEqual([...UNAVAILABLE_WAITS_MS]);
  });

  it('begins no wait that would end at or past its deadline, and answers the 503 instead', async () => {
    const s = scripted([unavailable(), unavailable(), ok]);
    expect(isUnavailable(await retryUnavailable(s.attempt, { ...s, deadline: 6_000 + 61_000 }))).toBe(true);
    expect(s.slept).toEqual([6_000]);
    const none = scripted([unavailable(), ok]);
    expect(isUnavailable(await retryUnavailable(none.attempt, { ...none, deadline: 6_000 }))).toBe(true);
    expect(none.slept).toEqual([]);
  });
});
