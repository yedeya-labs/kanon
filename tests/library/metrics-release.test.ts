import { describe, expect, it } from 'vitest';
import { RELEASE_TITLE, isReleasePr } from '../../scripts/metrics/release.mjs';

/**
 * Plan 0003 §1.2, the Owner on kanon#538: a release PR is left out of the metrics, recognised by
 * what the release workflow produces (its labels, the Releaser App), never by a repository's
 * name, and never by its title alone.
 */

const REGISTER = new Map([['Implementer', 'acme-author'], ['Reviewer', 'acme-judge'], ['Releaser', 'acme-releaser']]);
const PR = (o: Record<string, unknown> = {}) => ({
  number: 1, state: 'closed' as const, created_at: '2026-09-01T00:00:00Z', closed_at: '2026-09-02T00:00:00Z', merged_at: '2026-09-02T00:00:00Z',
  author: { login: 'octocat', type: 'User' }, labels: [] as string[], title: 'feat: a thing', ...o,
});
const ACTIONS = { login: 'github-actions[bot]', type: 'Bot' };

describe('isReleasePr', () => {
  it("is true for release-please's labels, whoever opened it", () => {
    expect(isReleasePr(PR({ labels: ['autorelease: pending'] }), REGISTER)).toBe(true);
    expect(isReleasePr(PR({ labels: ['autorelease: tagged'] }), REGISTER)).toBe(true);
    expect(isReleasePr(PR({ labels: ['autorelease'] }), REGISTER)).toBe(false);
  });

  it("is true for the register's Releaser App, by REST or GraphQL login", () => {
    expect(isReleasePr(PR({ author: { login: 'acme-releaser[bot]', type: 'Bot' } }), REGISTER)).toBe(true);
    expect(isReleasePr(PR({ author: { login: 'acme-releaser', type: 'Bot' } }), REGISTER)).toBe(true);
    expect(isReleasePr(PR({ author: { login: 'acme-author[bot]', type: 'Bot' } }), REGISTER)).toBe(false);
    expect(isReleasePr(PR({ author: { login: 'acme-releaser', type: 'User' } }), REGISTER)).toBe(false);
    expect(isReleasePr(PR({ author: { login: 'acme-releaser[bot]', type: 'Bot' } }), new Map())).toBe(false);
  });

  it('is true for github-actions[bot] with a release title, from before the Releaser App', () => {
    expect(isReleasePr(PR({ author: ACTIONS, title: 'chore(main): release 0.35.0' }), REGISTER)).toBe(true);
    expect(isReleasePr(PR({ author: ACTIONS, title: 'chore: bump the cache' }), REGISTER)).toBe(false);
  });

  it("is false for a person's PR with only a release title", () => {
    expect(isReleasePr(PR({ title: 'chore(main): release 0.35.0' }), REGISTER)).toBe(false);
    expect(isReleasePr(PR({ author: null, title: 'chore(main): release 0.35.0' }), REGISTER)).toBe(false);
  });

  it('reads the conventional release title exactly', () => {
    for (const t of ['chore(main): release 0.35.0', 'chore(release-1.x): release v1.2.3', 'chore(main): release 2.0.0-rc.1']) expect(RELEASE_TITLE.test(t), t).toBe(true);
    for (const t of ['chore: release 0.35.0', 'feat(main): release 1.0.0', 'chore(main): release notes', 'chore(main): release 1.0.0 and more']) expect(RELEASE_TITLE.test(t), t).toBe(false);
  });
});
