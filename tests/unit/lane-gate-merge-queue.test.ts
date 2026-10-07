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

/**
 * kanon#484: so the rebase lane's caller also starts it on the merged pull request
 * (`pull_request_target`, `closed`), which fires once the queue has merged it. Measured on Kanon's
 * own `main` (2026-10-07): a pull request the queue merged names the member who queued it as
 * `merged_by`. The gate judges that member, never `sender`, and refuses a close that isn't a merge.
 */
describe('a pull request merged through the queue (kanon#484)', () => {
  const env = {};
  const merged = { action: 'closed', pull_request: { merged: true, merged_by: { login: 'a-member' } }, sender: { login: 'github-merge-queue[bot]' } };

  it('is the member who queued it, by merged_by alone', () => {
    expect(triggeringActor('pull_request_target', merged, env)).toEqual({ actor: { login: 'a-member', source: 'user who merged it' } });
  });

  it('refuses a close that is not a merge, whoever closed it', () => {
    for (const pull_request of [{ merged: false, merged_by: null }, { merged: false, merged_by: { login: 'a-member' } }, {}, undefined]) {
      const r = triggeringActor('pull_request_target', { action: 'closed', pull_request, sender: { login: 'a-member' } }, env);
      expect(r, JSON.stringify(pull_request)).toEqual({ refuse: 'the pull_request_target event closed a pull request without merging it, and a lane acts on that close only as a merge' });
    }
  });

  it('refuses a merge that names no merger, rather than reading the sender', () => {
    expect(triggeringActor('pull_request_target', { action: 'closed', pull_request: { merged: true }, sender: { login: 'a-member' } }, env)).toHaveProperty('refuse');
  });

  it('leaves a pull_request close as it was: whoever merged it, else whoever closed it', () => {
    expect(triggeringActor('pull_request', { action: 'closed', pull_request: { merged: false }, sender: { login: 'closer' } }, env))
      .toEqual({ actor: { login: 'closer', source: 'user who closed it' } });
  });
});

/**
 * A schedule on a merge-queue repository. Measured on Kanon's own `main` (2026-10-07, run
 * 37638246558): every merge changes the default branch as the queue, so GitHub runs every
 * schedule as it, and `GITHUB_ACTOR` is `github-merge-queue`, without the `[bot]` suffix. The
 * gate looked that up as a person and failed red. On a schedule alone the queue is admitted:
 * only someone with write access (a member, or an App the repository installed) can queue a merge.
 */
describe('a schedule run as the merge queue', () => {
  const lookups = {
    registeredApps: () => new Map([['Lead', 'example-lead']]),
    permissionOf: () => {
      throw new Error('looked up a permission for the merge queue');
    },
  };

  it('names the queue by its login, with or without the suffix, and admits it without a lookup', () => {
    for (const GITHUB_ACTOR of ['github-merge-queue', 'github-merge-queue[bot]']) {
      const r = triggeringActor('schedule', { schedule: '30 7 */3 * *' }, { GITHUB_ACTOR });
      if (!('actor' in r)) throw new Error(r.refuse);
      expect(r.actor.login).toBe('github-merge-queue[bot]');
      expect(decide(r.actor, lookups)).toEqual({ member: true, reason: expect.stringContaining('only someone with write access') });
    }
  });

  it('is still refused on any other event', () => {
    for (const [name, event, env] of [
      ['workflow_dispatch', {}, { GITHUB_ACTOR: 'github-merge-queue[bot]' }],
      ['workflow_run', { workflow_run: { actor: { login: 'github-merge-queue[bot]' } } }, {}],
      ['pull_request_target', { action: 'labeled', sender: { login: 'github-merge-queue[bot]' } }, {}],
    ] as const) {
      const r = triggeringActor(name, event, env);
      if (!('actor' in r)) throw new Error(r.refuse);
      expect(decide(r.actor, lookups).member, name).toBe(false);
    }
  });

  it('leaves any other schedule actor to the usual checks', () => {
    expect(triggeringActor('schedule', {}, { GITHUB_ACTOR: 'a-member' })).toEqual({ actor: { login: 'a-member', source: 'user who last changed the schedule' } });
  });
});
