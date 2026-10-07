import { describe, expect, it } from 'vitest';
import { classifyActor, isAgentClass, isDependencyBot } from '../../scripts/metrics/actors.mjs';
import { originOf } from '../../scripts/metrics/origin.mjs';
import { roleMarker } from '../../scripts/lib/role-marker.mjs';
import { parseAppRegister } from '../../scripts/app-register.mjs';

/**
 * Plan 0003 §3.2: an actor is a role (its login is an App in the register), `other_bot` or
 * `human`, and only the class is kept. §3.3's `origin`: the first closing issue's labels in a
 * fixed order, first match wins, then the author's class.
 */

// Since plan 0005's L4: the Author App plays four roles, the Judge two, the Releaser one.
const REGISTER = parseAppRegister([
  '| Role | App slug |', '|---|---|',
  '| Implementer | `acme-author` |', '| Lead | `acme-author` |', '| Explorer | `acme-author` |', '| Overseer | `acme-author` |',
  '| Reviewer | `acme-judge` |', '| Merger | `acme-judge` |', '| Releaser | `acme-releaser` |', '',
].join('\n'));
// Before L4: one App per role.
const PER_ROLE = new Map([['Implementer', 'acme-implementer'], ['Reviewer', 'acme-reviewer'], ['Merger', 'acme-merger']]);

type Actor = { login: string; type?: string };
type Issue = { number: number; labels: string[]; author: Actor | null; body: string };
const user = (login: string) => ({ login, type: 'User' });
const bot = (slug: string) => ({ login: `${slug}[bot]`, type: 'Bot' });

describe('classifyActor', () => {
  it('reads a login of a one-role App as that role, in every spelling the APIs use', () => {
    for (const login of ['acme-reviewer[bot]', 'app/acme-reviewer', 'acme-reviewer', 'ACME-Reviewer[bot]']) {
      expect(classifyActor({ login, type: 'Bot' }, PER_ROLE), login).toBe('reviewer');
    }
  });

  it("tells an App's roles apart by the marker on what it wrote", () => {
    expect(classifyActor(bot('acme-author'), REGISTER, { body: `${roleMarker('Explorer')}\n\nfound a bug` })).toBe('explorer');
    expect(classifyActor(bot('acme-judge'), REGISTER, { body: `**Merger** ${roleMarker('Merger')}` })).toBe('merger');
  });

  it('takes the role the action implies only when the App plays it, and the marker before it', () => {
    expect(classifyActor(bot('acme-judge'), REGISTER, { expect: 'merger' })).toBe('merger');
    expect(classifyActor(bot('acme-judge'), REGISTER, { expect: 'implementer' })).toBeUndefined();
    expect(classifyActor(bot('acme-judge'), REGISTER, { body: roleMarker('Reviewer'), expect: 'merger' })).toBe('reviewer');
  });

  it("ignores a marker naming a role the App doesn't play", () => {
    expect(classifyActor(bot('acme-author'), REGISTER, { body: roleMarker('Reviewer') })).toBeUndefined();
  });

  it('leaves an App of several roles unknown when nothing says which, rather than guessing', () => {
    expect(classifyActor(bot('acme-author'), REGISTER)).toBeUndefined();
  });

  it("reads a register App of no delivery role, and any other bot, as other_bot", () => {
    expect(classifyActor(bot('acme-releaser'), REGISTER)).toBe('other_bot');
    expect(classifyActor({ login: 'acme-releaser' }, REGISTER)).toBe('other_bot');
    expect(classifyActor(bot('dependabot'), REGISTER)).toBe('other_bot');
    expect(classifyActor({ login: 'app/some-ci' }, REGISTER)).toBe('other_bot');
    expect(classifyActor({ login: 'some-ci', type: 'Bot' }, REGISTER)).toBe('other_bot');
  });

  it("reads GitHub's own committer, web-flow, as other_bot: it is no person (kanon#521)", () => {
    // A User-type account, the committer of every commit GitHub creates through the API or the web UI.
    expect(classifyActor(user('web-flow'), REGISTER)).toBe('other_bot');
    expect(classifyActor({ login: 'Web-Flow' }, REGISTER)).toBe('other_bot');
    // A person whose login merely contains it is still a person.
    expect(classifyActor(user('web-flow-fan'), REGISTER)).toBe('human');
  });

  it('reads everyone else as human', () => {
    expect(classifyActor(user('octocat'), REGISTER)).toBe('human');
    expect(classifyActor({ login: 'octocat' }, REGISTER)).toBe('human');
  });

  it('leaves an unknown account unknown', () => {
    expect(classifyActor(null, REGISTER)).toBeUndefined();
    expect(classifyActor(undefined, REGISTER)).toBeUndefined();
    expect(classifyActor({ login: '' }, REGISTER)).toBeUndefined();
  });

  it('returns a class and never a login', () => {
    const classes = [bot('acme-judge'), bot('acme-releaser'), user('octocat')].map((a) => classifyActor(a, REGISTER, { expect: 'reviewer' }));
    expect(classes).toEqual(['reviewer', 'other_bot', 'human']);
  });

  it('isAgentClass is true of the roles only', () => {
    expect(['implementer', 'merger'].every(isAgentClass)).toBe(true);
    expect(['human', 'other_bot', undefined].some(isAgentClass)).toBe(false);
  });
});

describe('isDependencyBot', () => {
  it('is the dependency-update Apps only, as bots', () => {
    expect(isDependencyBot(bot('dependabot'))).toBe(true);
    expect(isDependencyBot({ login: 'app/renovate' })).toBe(true);
    expect(isDependencyBot(user('dependabot'))).toBe(false);
    expect(isDependencyBot(bot('some-ci'))).toBe(false);
    expect(isDependencyBot(null)).toBe(false);
  });
});

describe('originOf', () => {
  const pr = (issue: Issue | null, author: Actor | null = user('octocat'), body = '') => ({
    number: 7, state: 'closed' as const, created_at: '2026-09-01T00:00:00Z', closed_at: '2026-09-02T00:00:00Z', merged_at: null,
    author, body, labels: [] as string[], closing_issues: issue ? [issue] : [] as Issue[] | undefined,
  });
  const issue = (labels: string[], author: Actor | null = user('octocat'), body = ''): Issue => ({ number: 3, labels, author, body });

  it('reads a Reviewer follow-up that also carries project:<n> as reviewer_followup, not brief (§7 mutation)', () => {
    expect(originOf(pr(issue(['project:4', 'follow-up', 'agent:reviewer'])), REGISTER)).toBe('reviewer_followup');
  });

  it('needs both labels for a Reviewer follow-up', () => {
    expect(originOf(pr(issue(['follow-up', 'project:4'])), REGISTER)).toBe('brief');
    expect(originOf(pr(issue(['agent:reviewer', 'project:4'])), REGISTER)).toBe('brief');
  });

  it('checks explorer, then overseer, before project:<n>', () => {
    expect(originOf(pr(issue(['project:4', 'agent:explorer', 'agent:overseer'])), REGISTER)).toBe('explorer');
    expect(originOf(pr(issue(['project:4', 'agent:overseer'])), REGISTER)).toBe('overseer');
    expect(originOf(pr(issue(['follow-up', 'agent:reviewer', 'agent:explorer'])), REGISTER)).toBe('reviewer_followup');
  });

  it('reads project:<n> as brief, and only a numbered project', () => {
    expect(originOf(pr(issue(['project:12'])), REGISTER)).toBe('brief');
    expect(originOf(pr(issue(['project:<n>'])), REGISTER)).toBe('human');
  });

  it("falls back to the issue author's class", () => {
    expect(originOf(pr(issue(['bug'])), REGISTER)).toBe('human');
    expect(originOf(pr(issue([], bot('some-ci'))), REGISTER)).toBe('other_bot');
    expect(originOf(pr(issue([], bot('dependabot'))), REGISTER)).toBe('dependency_bot');
    expect(originOf(pr(issue([], bot('acme-author'), roleMarker('Lead'))), REGISTER)).toBe('brief');
    expect(originOf(pr(issue([], bot('acme-author'), roleMarker('Explorer'))), REGISTER)).toBe('explorer');
  });

  it('reads only the first closing issue', () => {
    const p = { ...pr(issue(['bug'])), closing_issues: [issue(['bug']), issue(['agent:explorer'])] };
    expect(originOf(p, REGISTER)).toBe('human');
  });

  it("takes the PR author's class when the PR closes no issue", () => {
    expect(originOf(pr(null, bot('dependabot')), REGISTER)).toBe('dependency_bot');
    expect(originOf(pr(null, user('octocat')), REGISTER)).toBe('human');
    expect(originOf(pr(null, bot('acme-author'), roleMarker('Lead')), REGISTER)).toBe('brief');
  });

  it('leaves the origin unknown when the deciding author is, or has no origin of its own', () => {
    expect(originOf(pr(issue([], null)), REGISTER)).toBeUndefined();
    expect(originOf(pr(issue([], bot('acme-author'))), REGISTER)).toBeUndefined();
    expect(originOf(pr(null, bot('acme-author'), roleMarker('Implementer')), REGISTER)).toBeUndefined();
  });

  it("leaves it unknown when the closing issues weren't read, rather than taking the PR author's", () => {
    expect(originOf({ ...pr(null), closing_issues: undefined }, REGISTER)).toBeUndefined();
  });
});
