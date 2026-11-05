import { describe, expect, it } from 'vitest';
import { failureCause, RATE_WAITS, RETRIES, retryable, SERVER_WAITS, transient, withRetry, WRITE_PACE, writes } from '../../cli/gh-retry.mjs';

// kanon#1607 point 9: `gh` retried, with writes spaced out, so a burst such as init's 39 label
// creates doesn't fail on GitHub's secondary rate limit, and what still fails is told apart from
// a permission the token lacks. The delay is injected: no test sleeps.
const SECONDARY = 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)';
const PERMISSION = 'gh: Resource not accessible by personal access token (HTTP 403)';
type R = { status: number | null; stdout: string; stderr: string };
const ok: R = { status: 0, stdout: '{}', stderr: '' };
const no = (stderr: string): R => ({ status: 1, stdout: '', stderr });

/** A fake clock that the injected sleep moves, and a gh that answers from a script. */
const harness = (answers: R[]) => {
  let t = 0;
  const slept: number[] = [];
  const calls: Array<{ args: string[]; at: number }> = [];
  const gh = async (args: string[]) => {
    calls.push({ args, at: t });
    return answers.shift() ?? ok;
  };
  const sleep = async (ms: number) => {
    slept.push(ms);
    t += ms;
  };
  const lines: string[] = [];
  return { run: withRetry(gh, { sleep, now: () => t, progress: (l) => lines.push(l) }), slept, calls, lines };
};

describe('gh-retry (#1607)', () => {
  it('tells a rate limit and a 5xx from a permission', () => {
    for (const e of [SECONDARY, 'gh: HTTP 429', 'gh: Bad Gateway (HTTP 502)', 'gh: Internal Server Error (HTTP 500)', 'abuse detection mechanism', 'request timed out']) {
      expect(retryable(e), e).toBe(true);
      expect(transient(e), e).toBe(true);
    }
    // The primary limit isn't worth a retry (it resets within the hour), but it isn't the token either.
    expect(retryable('gh: API rate limit exceeded for user ID 1. (HTTP 403)')).toBe(false);
    expect(transient('gh: API rate limit exceeded for user ID 1. (HTTP 403)')).toBe(true);
    for (const e of [PERMISSION, 'gh: Not Found (HTTP 404)', 'gh: Validation Failed (HTTP 422)']) {
      expect(retryable(e), e).toBe(false);
      expect(transient(e), e).toBe(false);
    }
  });

  it('says why writes failed: transient only when every one was, a permission on a plain 403 or 404', () => {
    expect(failureCause([])).toBe('permission');
    expect(failureCause([SECONDARY, 'gh: HTTP 503'])).toBe('transient');
    expect(failureCause([SECONDARY, PERMISSION])).toBe('permission');
    expect(failureCause(['gh: Not Found (HTTP 404)'])).toBe('permission');
    expect(failureCause(['gh: Validation Failed (HTTP 422)'])).toBe('other');
    // A rate limit's own 403 never makes a mixed set a permission.
    expect(failureCause([SECONDARY, 'gh: Validation Failed (HTTP 422)'])).toBe('other');
  });

  it('knows a write from a read', () => {
    expect(writes(['label', 'create', 'x'])).toBe(true);
    expect(writes(['api', '-X', 'PATCH', 'repos/a/b'])).toBe(true);
    expect(writes(['api', '--method=DELETE', 'repos/a/b'])).toBe(true);
    expect(writes(['api', 'repos/a/b/milestones', '-f', 'title=x'])).toBe(true);
    expect(writes(['api', 'graphql', '-X', 'GET', '-f', 'q=1'])).toBe(false);
    expect(writes(['api', 'repos/a/b'])).toBe(false);
    expect(writes(['label', 'list'])).toBe(false);
  });

  it('asks again after a rate limit, waiting longer each time, and returns the answer that worked', async () => {
    const h = harness([no(SECONDARY), no(SECONDARY), ok]);
    expect(await h.run(['api', 'repos/a/b'])).toEqual(ok);
    expect(h.calls).toHaveLength(3);
    expect(h.slept).toEqual([RATE_WAITS[0], RATE_WAITS[1]]);
    expect(h.lines[0]).toMatch(/asked to slow down/);
  });

  it('waits less for a 5xx, and gives up after its retries with the last answer', async () => {
    const h = harness(Array.from({ length: RETRIES + 2 }, () => no('gh: HTTP 503')));
    expect((await h.run(['api', 'repos/a/b'])).stderr).toBe('gh: HTTP 503');
    expect(h.calls).toHaveLength(RETRIES + 1);
    expect(h.slept).toEqual(SERVER_WAITS.slice(0, RETRIES));
  });

  it('never asks again after a permission refusal', async () => {
    const h = harness([no(PERMISSION), ok]);
    expect((await h.run(['label', 'create', 'x'])).stderr).toBe(PERMISSION);
    expect(h.calls).toHaveLength(1);
    expect(h.slept).toEqual([]);
  });

  it('spaces writes out, and leaves reads alone', async () => {
    const h = harness([]);
    for (const n of ['a', 'b', 'c']) await h.run(['label', 'create', n]);
    await h.run(['api', 'repos/a/b']);
    expect(h.calls.map((c) => c.at)).toEqual([0, WRITE_PACE, 2 * WRITE_PACE, 2 * WRITE_PACE]);
    expect(h.slept).toEqual([WRITE_PACE, WRITE_PACE]);
  });
});
