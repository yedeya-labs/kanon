import { describe, expect, it } from 'vitest';
import { decide, triggeringActor } from '../../scripts/lane-gate.mjs';

/**
 * kanon#79: who the gate sees when CI finishes on a default branch that a merge queue pushes.
 *
 * Measured on Kanon's own `main` (2026-10-04): every `push` run there, CI included, carries
 * `actor` and `triggering_actor` both `github-merge-queue[bot]` — the queue pushes the merge,
 * not the member who queued it. The payload below is that shape. A bot is judged by the App
 * register alone, and the queue is not one of the repository's agent Apps, so the rebase
 * lane and the merge lane's sweep are refused on that trigger and fall back to their
 * schedules. docs/lanes.md says so; this pins the behaviour the paragraph describes, so the
 * paragraph goes stale only with a red test.
 */
describe('a CI completion on a merge-queue push (kanon#79)', () => {
  const event = {
    action: 'completed',
    workflow_run: {
      head_sha: 'a218007',
      actor: { login: 'github-merge-queue[bot]' },
      triggering_actor: { login: 'github-merge-queue[bot]' },
    },
    sender: { login: 'a-member' },
  };
  const register = () => new Map([['Lead', 'example-lead'], ['Implementer', 'example-implementer'], ['Merger', 'example-merger']]);
  const noLookup = () => {
    throw new Error('looked up a permission for a bot');
  };

  it('is the queue, not the member who queued the pull request', () => {
    const r = triggeringActor('workflow_run', event, {});
    expect(r).toEqual({ actor: { login: 'github-merge-queue[bot]', source: 'user whose push the finished workflow ran on' } });
  });

  it('is refused, by the register alone, as an App outside it', () => {
    const r = triggeringActor('workflow_run', event, {});
    if (!('actor' in r) || !r.actor) throw new Error('no actor');
    const verdict = decide(r.actor, { registeredApps: register, permissionOf: noLookup });
    expect(verdict.member).toBe(false);
    expect(verdict.reason).toContain('not in the App register');
  });
});
