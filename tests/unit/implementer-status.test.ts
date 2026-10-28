import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SPAWNS } from './helpers/spawns.js';
import { writeStub } from './helpers/stub-bin.js';

const { CONTEXT, carryDecision, patchFingerprint, pickOpened, redeliverDecision, verifiedAsApp } = await import('../../actions/implementer-status/implementer-status.mjs');

/**
 * The implementer commit status, `kanon/role: implementer` (plan 0005 §3.3, question 6; step
 * L3). A fixed step of the Implementer's lanes sets it, never the agent, and since L4 the Merger
 * requires it (`tests/library/two-apps.test.ts`). The decisions are pure and held here case by case; the wiring below holds every lane
 * to "a job after the agent's, holding no agent".
 */

const REPO = 'acme/widgets';
const SLUG = 'acme-implementer';
const APP = `${SLUG}[bot]`;
const EMAIL = `42+${APP}@users.noreply.github.com`;
const SINCE = '2026-10-05T10:00:00Z';
const before = ['main', 'feat/1-old'];
const sha = (c: string) => c.repeat(40);
/** What GitHub's API says of a commit: the accounts it resolved from the commit's emails, and its verification. */
type Who = { verified?: unknown; reason?: string; login?: string; type?: string; committer?: string; email?: string };
// A commit the Author App's token created through the API: GitHub signed it, and the App's account is its author.
const APP_COMMIT: Who = { verified: true, reason: 'valid', login: APP, type: 'Bot', committer: 'web-flow', email: EMAIL };
// A person's push: unsigned, under their own account.
const PERSON: Who = { verified: false, reason: 'unsigned', login: 'a-person', type: 'User', committer: 'a-person', email: 'person@example.com' };
const commitBy = (s: string, who: Who = APP_COMMIT, parents: string[] = []) => {
  const w = { ...APP_COMMIT, ...who };
  return {
    sha: s, parents: parents.map((p) => ({ sha: p })),
    author: { login: w.login, type: w.type }, committer: { login: w.committer },
    commit: { author: { email: w.email }, verification: { verified: w.verified, reason: w.reason } },
  };
};
// #1358: a person's commit under the App's noreply address. GitHub resolves the App's account
// from that email, as author and committer, but nothing signed it.
const FORGED: Who = { verified: false, reason: 'unsigned' };
const pr = (number: number, ref: string, head: string, created = '2026-10-05T10:30:00Z', repo = REPO) =>
  ({ number, created_at: created, head: { ref, sha: head, repo: { full_name: repo } } });
// The heads this run's agent job held when the agent finished (#324). By default, the one head
// `sha('a')`, on the branch the cases below call this run's.
const ours = [{ ref: 'feat/1-new', sha: sha('a') }, { ref: 'HEAD', sha: sha('a') }];
const opened = (prs: ReturnType<typeof pr>[], commits: Record<string, ReturnType<typeof commitBy>>, over: Record<string, unknown> = {}) =>
  pickOpened({ prs, repo: REPO, since: SINCE, branchesBefore: before, slug: SLUG, heads: ours, headCommit: (s: string) => commits[s], ...over });

// Its cases run the step in `bash` against a stub `gh`, so the block takes the spawn budget (#436).
describe('the summary an adopter reads when the App lacks Commit statuses write (L4)', SPAWNS, () => {
  it('says what now requires the status, and no longer that nothing does', () => {
    const src = readFileSync('actions/implementer-status/implementer-status.mjs', 'utf8');
    expect(src).not.toMatch(/until L4/);
    expect(src).toMatch(/the Merger skips this pull request as \\`not-the-implementer\\`, and the revise and rebase lanes refuse it/);
  });

  // #474: an adopter installs the Author App, which holds the Implementer; there is no
  // Implementer's App to grant the permission to.
  it('names the Author App, the one the adopter installs, as the App to grant the permission', () => {
    const say = (env: Record<string, string>) => execFileSync('node', ['actions/implementer-status/implementer-status.mjs'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_REPOSITORY: REPO, ...env },
    });
    const noRead = say({});
    expect(noRead).toContain('the Author App (the Implementer\'s) could not mint a read token');
    const noWrite = say({ APP_SLUG: SLUG, READ_TOKEN: 'read' });
    expect(noWrite).toContain('the Author App (the Implementer\'s) could not mint a token with Commit statuses write. Grant it that permission');
    for (const out of [noRead, noWrite]) expect(out).not.toMatch(/Implementer's App/);
  });
});

describe('open: the first status goes only on the pull request this run opened', () => {
  it('stamps the one PR opened after the run started, from a new branch, at a head the App authored', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) })).toEqual({ pr: 7, sha: sha('a') });
  });

  it('never stamps a forged PR already open before the run, though it closes the same issue', () => {
    // Opened before `since`, from a branch the snapshot lists: two independent refusals.
    const forged = pr(6, 'feat/1-old', sha('f'), '2026-10-05T09:00:00Z');
    expect(opened([forged], { [sha('f')]: commitBy(sha('f')) })).toMatchObject({ none: expect.stringMatching(/no open pull request/) });
    // Even opened during the run, a branch that existed before it is not this run's.
    expect(opened([pr(6, 'feat/1-old', sha('f'))], { [sha('f')]: commitBy(sha('f')) })).toMatchObject({ none: expect.any(String) });
    // And beside the real one, it changes nothing.
    expect(opened([forged, pr(7, 'feat/1-new', sha('a'))], { [sha('f')]: commitBy(sha('f')), [sha('a')]: commitBy(sha('a')) })).toEqual({ pr: 7, sha: sha('a') });
  });

  it('never stamps a PR from a new branch that was opened before the run started', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'), '2026-10-05T09:59:59Z')], { [sha('a')]: commitBy(sha('a')) })).toHaveProperty('none');
  });

  it('stamps neither of two candidates its own job held, and says so by number', () => {
    const v = opened([pr(7, 'feat/1-new', sha('a')), pr(8, 'feat/1-other', sha('b'))], { [sha('a')]: commitBy(sha('a')), [sha('b')]: commitBy(sha('b')) }, {
      heads: [...ours, { ref: 'feat/1-other', sha: sha('b') }],
    });
    expect(v).toEqual({ none: expect.stringContaining('2 pull requests match (#7, #8)') });
  });

  // #324: the App's email is every Author run's, so it binds no pull request to a run.
  it('two overlapping runs of the shared App each stamp their own pull request, by the head their job pushed', () => {
    // Run A started at SINCE, run B a little later; each opened one PR before either status job
    // read the list, so each sees both: opened after its start, from a new branch, App-authored.
    const both = [pr(7, 'feat/1-new', sha('a'), '2026-10-05T10:30:00Z'), pr(8, 'feat/2-new', sha('b'), '2026-10-05T10:31:00Z')];
    const commits = { [sha('a')]: commitBy(sha('a')), [sha('b')]: commitBy(sha('b')) };
    expect(opened(both, commits)).toEqual({ pr: 7, sha: sha('a') });
    expect(opened(both, commits, { since: '2026-10-05T10:10:00Z', heads: [{ ref: 'feat/2-new', sha: sha('b') }] })).toEqual({ pr: 8, sha: sha('b') });
  });

  it('a run that pushed no pull request stamps nothing, though another Author lane opened one during it', () => {
    const lanes = [pr(9, 'feat/3-lead', sha('c'))];
    const commits = { [sha('c')]: commitBy(sha('c')) };
    // Its job held only the default branch's head it checked out, or nothing at all.
    expect(opened(lanes, commits, { heads: [{ ref: 'main', sha: sha('0') }, { ref: 'HEAD', sha: sha('0') }] })).toMatchObject({ none: expect.stringMatching(/at a head this run's agent job pushed \(it held main@0000000, HEAD@0000000\)/) });
    expect(opened(lanes, commits, { heads: [] })).toMatchObject({ none: expect.stringMatching(/it held none/) });
  });

  it('matches the head, not the branch name: a PR whose branch the job held at another commit is not this run\'s', () => {
    expect(opened([pr(7, 'feat/1-new', sha('d'))], { [sha('d')]: commitBy(sha('d')) })).toHaveProperty('none');
  });

  it('stamps nothing when the heads the agent\'s job held are unknown', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) }, { heads: null })).toMatchObject({ none: expect.stringMatching(/heads the agent's job held are unknown/) });
  });

  it('refuses a head the App did not author, a fork\'s branch, and an unknown start or snapshot', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a'), PERSON) })).toHaveProperty('none');
    expect(opened([pr(7, 'feat/1-new', sha('a'), undefined, 'fork/widgets')], { [sha('a')]: commitBy(sha('a')) })).toHaveProperty('none');
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) }, { since: '' })).toMatchObject({ none: expect.stringMatching(/start time/) });
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) }, { branchesBefore: null })).toMatchObject({ none: expect.stringMatching(/branches/) });
  });

  it('[LANE-20] stamps only a head GitHub verified, with the App\'s bot account as its author', () => {
    const one = (who: Who) => opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a'), who) });
    expect(one(APP_COMMIT)).toEqual({ pr: 7, sha: sha('a') });
    // #1358: the App's address, so the App's account, but unsigned.
    expect(one(FORGED)).toMatchObject({ none: expect.stringMatching(/`aaaaaaa` is not verified \(unsigned\)/) });
    // Verified, but another account's: a person's signed commit, or another App's.
    expect(one({ login: 'a-person', type: 'User', committer: 'a-person' })).toMatchObject({ none: expect.stringMatching(/author is a-person, not acme-implementer\[bot\]/) });
    expect(one({ login: 'acme-lead[bot]' })).toMatchObject({ none: expect.stringMatching(/author is acme-lead\[bot\]/) });
    // The App's account as author, but a person committed and signed it with their own key.
    expect(one({ committer: 'a-person' })).toMatchObject({ none: expect.stringMatching(/committer is a-person/) });
    // A head commit that could not be read stamps nothing.
    expect(opened([pr(7, 'feat/1-new', sha('a'))], {})).toHaveProperty('none');
  });
});

describe('verifiedAsApp: GitHub\'s verification and accounts, never an email', () => {
  const check = (who: Who) => verifiedAsApp(commitBy(sha('2'), who), SLUG);

  it('holds for a verified commit, the App\'s bot account its author, GitHub or the App its committer', () => {
    expect(check(APP_COMMIT)).toEqual({ ok: true, why: '' });
    expect(check({ committer: APP })).toEqual({ ok: true, why: '' });
  });

  it('fails an unverified commit, naming GitHub\'s reason, whatever account it names', () => {
    expect(check(FORGED)).toEqual({ ok: false, why: 'commit `2222222` is not verified (unsigned)' });
    expect(check({ verified: 'true' }).ok).toBe(false);
    expect(verifiedAsApp({ sha: sha('2'), author: { login: APP, type: 'Bot' }, committer: { login: 'web-flow' } }, SLUG)).toEqual({ ok: false, why: 'commit `2222222` is not verified (no reason given)' });
  });

  it('fails a verified commit whose author is not the App\'s bot account, or whose committer is a person', () => {
    expect(check({ login: 'a-person', type: 'User' })).toMatchObject({ ok: false, why: expect.stringMatching(/author is a-person, not acme-implementer\[bot\]/) });
    // Another App's commit, which GitHub signed for that App.
    expect(check({ login: 'acme-lead[bot]' })).toMatchObject({ ok: false, why: expect.stringMatching(/author is acme-lead\[bot\], not/) });
    expect(check({ type: 'User' })).toMatchObject({ ok: false, why: expect.stringMatching(/as a User account/) });
    expect(check({ login: '', type: '' })).toMatchObject({ ok: false, why: expect.stringMatching(/author is no account/) });
    expect(check({ committer: 'a-person' })).toMatchObject({ ok: false, why: expect.stringMatching(/committer is a-person, not web-flow or acme-implementer\[bot\]/) });
    expect(check({ committer: 'acme-lead[bot]' })).toMatchObject({ ok: false, why: expect.stringMatching(/committer is acme-lead\[bot\]/) });
    expect(check({ committer: '' })).toMatchObject({ ok: false, why: expect.stringMatching(/committer is no account/) });
    expect(verifiedAsApp(undefined, SLUG).ok).toBe(false);
  });

  it('[LANE-19] reads no email: the App\'s address is not the App, and a stranger\'s address on a verified App commit is', () => {
    expect(check({ ...FORGED, email: EMAIL }).ok).toBe(false);
    expect(check({ email: 'someone-else@example.com' }).ok).toBe(true);
    // And the module keeps no email check of its own, nor the account read that built the address.
    const src = readFileSync('actions/implementer-status/implementer-status.mjs', 'utf8');
    expect(src).not.toMatch(/byApp|\.email\b|users\//);
  });
});

describe('carry: the status is a chain, not a stamp', () => {
  const start = sha('1');
  const mine = { context: CONTEXT, state: 'success', creator: { login: `${SLUG}[bot]` } };
  // By default the run's agent job checked out the start and left the branch at `sha('3')`.
  const carry = (over: Record<string, unknown>) => carryDecision({
    startHead: start, head: sha('3'), slug: SLUG, startStatuses: [mine],
    compare: { status: 'ahead', commits: [commitBy(sha('2'), APP_COMMIT, [start]), commitBy(sha('3'), APP_COMMIT, [sha('2')])] },
    heads: [{ ref: 'feat/1-new', sha: sha('3') }, { ref: 'HEAD', sha: sha('3') }], base: start, fixSha: '',
    ...over,
  });

  it('moves to the new head when the start had it and every commit since is the App\'s', () => {
    expect(carry({})).toEqual({ carry: sha('3') });
  });

  it('carries through the rebase lane\'s merge: the default branch\'s commits are its second parent', () => {
    const merge = commitBy(sha('3'), APP_COMMIT, [start, sha('9')]);
    expect(carry({ compare: { status: 'ahead', commits: [commitBy(sha('9'), PERSON, [sha('8')]), merge] } })).toEqual({ carry: sha('3') });
  });

  it('refuses a forged PR: no status on the start, or one another App created, or one not successful', () => {
    expect(carry({ startStatuses: [] })).toMatchObject({ none: expect.stringMatching(/carries no `kanon\/role: implementer` status/) });
    expect(carry({ startStatuses: [{ ...mine, creator: { login: 'acme-lead[bot]' } }] })).toHaveProperty('none');
    expect(carry({ startStatuses: [{ ...mine, state: 'pending' }] })).toHaveProperty('none');
    expect(carry({ startStatuses: [{ ...mine, context: 'kanon/role: lead' }] })).toHaveProperty('none');
  });

  it('a person\'s push ends the chain', () => {
    const v = carry({ compare: { status: 'ahead', commits: [commitBy(sha('2'), PERSON, [start]), commitBy(sha('3'), APP_COMMIT, [sha('2')])] } });
    expect(v).toMatchObject({ none: expect.stringMatching(/a person's push ends the chain/) });
  });

  describe('only across commits GitHub verified as the App\'s (#1358)', () => {
    const path = (mid: Who, tip: Who = APP_COMMIT) => ({ status: 'ahead', commits: [commitBy(sha('2'), mid, [start]), commitBy(sha('3'), tip, [sha('2')])] });

    it('[LANE-19] an unverified commit under the App\'s noreply email, below a verified head, ends the chain', () => {
      const v = carry({ compare: path(FORGED) });
      expect(v).toEqual({ none: 'the path since `1111111` is not all the App\'s, as GitHub verified it: commit `2222222` is not verified (unsigned), and a person\'s push ends the chain' });
    });

    it('[LANE-19] a verified commit under another account, or committed by a person, ends the chain', () => {
      expect(carry({ compare: path({ login: 'a-person', type: 'User', committer: 'a-person' }) })).toMatchObject({ none: expect.stringMatching(/`2222222`.*author is a-person/) });
      expect(carry({ compare: path({ login: 'acme-lead[bot]' }) })).toMatchObject({ none: expect.stringMatching(/author is acme-lead\[bot\]/) });
      expect(carry({ compare: path({ committer: 'a-person' }) })).toMatchObject({ none: expect.stringMatching(/committer is a-person/) });
      // The head itself, too.
      expect(carry({ compare: path(APP_COMMIT, FORGED) })).toMatchObject({ none: expect.stringMatching(/commit `3333333` is not verified/) });
    });

    it('[LANE-19] a merge whose first parent is unverified ends the chain; its second parent\'s commits are not walked', () => {
      const merge = commitBy(sha('3'), APP_COMMIT, [sha('2'), sha('9')]);
      expect(carry({ compare: { status: 'ahead', commits: [commitBy(sha('2'), FORGED, [start]), commitBy(sha('9'), PERSON, [sha('8')]), merge] } }))
        .toMatchObject({ none: expect.stringMatching(/commit `2222222` is not verified/) });
      expect(carry({ compare: { status: 'ahead', commits: [commitBy(sha('2'), APP_COMMIT, [start]), commitBy(sha('9'), FORGED, [sha('8')]), merge] } }))
        .toEqual({ carry: sha('3') });
    });

    it('[LANE-19] compares no email: a verified chain under strangers\' addresses carries, the App\'s address unverified doesn\'t', () => {
      expect(carry({ compare: path({ email: 'stranger@example.com' }, { email: 'other@example.com' }) })).toEqual({ carry: sha('3') });
      expect(carry({ compare: path({ ...PERSON, email: EMAIL }) })).toHaveProperty('none');
    });
  });

  it('refuses a head that doesn\'t descend from the start, an unreadable path, and an unknown start', () => {
    expect(carry({ compare: { status: 'diverged', commits: [] } })).toMatchObject({ none: expect.stringMatching(/does not descend/) });
    expect(carry({ compare: null })).toMatchObject({ none: expect.stringMatching(/unreadable/) });
    expect(carry({ compare: { status: 'ahead', commits: [commitBy(sha('3'), APP_COMMIT, [sha('2')])] } })).toMatchObject({ none: expect.stringMatching(/could not be read whole/) });
    expect(carry({ startHead: '' })).toMatchObject({ none: expect.stringMatching(/unknown/) });
  });

  it('sets nothing when the run pushed nothing', () => {
    expect(carry({ head: start })).toMatchObject({ none: expect.stringMatching(/already carries/) });
  });

  // #1263: the App's email binds nothing; the carry is bound to what this run checked out and pushed.
  describe('bound to what this run checked out and pushed (#1263)', () => {
    it('a legitimate multi-commit revise still carries', () => {
      const commits = [commitBy(sha('2'), APP_COMMIT, [start]), commitBy(sha('4'), APP_COMMIT, [sha('2')]), commitBy(sha('3'), APP_COMMIT, [sha('4')])];
      expect(carry({ compare: { status: 'ahead', commits } })).toEqual({ carry: sha('3') });
    });

    it('refuses a forged-email commit below the tip the run pushed: the job checked out the forgery, not the start', () => {
      // A person pushed `P` under the App's address before the agent's job checked out; the agent
      // built `H` on it, and its job held `H`. Every commit on the path reads as the App's.
      const P = sha('2');
      const v = carry({ base: P, compare: { status: 'ahead', commits: [commitBy(P, FORGED, [start]), commitBy(sha('3'), APP_COMMIT, [P])] } });
      expect(v).toMatchObject({ none: expect.stringMatching(/checked out `2222222`, not `1111111`.*not the Implementer's/) });
    });

    it('refuses a person\'s push after the agent, though it carries the App\'s address', () => {
      const Q = sha('5');
      const commits = [commitBy(sha('2'), APP_COMMIT, [start]), commitBy(sha('3'), APP_COMMIT, [sha('2')]), commitBy(Q, APP_COMMIT, [sha('3')])];
      const v = carry({ head: Q, compare: { status: 'ahead', commits } });
      expect(v).toMatchObject({ none: expect.stringMatching(/`5555555` is not one this run pushed \(its agent's job held 3333333\)/) });
    });

    it('the fix-push path carries: no agent job ran, the fix commit is the head and was made on the start', () => {
      const F = sha('6');
      const v = carry({ head: F, heads: null, base: start, fixSha: F, compare: { status: 'ahead', commits: [commitBy(F, APP_COMMIT, [start])] } });
      expect(v).toEqual({ carry: F });
      // And a push on top of the fix is not the fix.
      const after = carry({ head: sha('7'), heads: null, base: start, fixSha: F, compare: { status: 'ahead', commits: [commitBy(F, APP_COMMIT, [start]), commitBy(sha('7'), APP_COMMIT, [F])] } });
      expect(after).toMatchObject({ none: expect.stringMatching(/not one this run pushed \(the heads its agent's job held are unknown, its fix pushed `6666666`\)/) });
    });

    it('fails closed: unknown heads and no fix, or an unknown checkout, carry nothing', () => {
      expect(carry({ heads: null })).toMatchObject({ none: expect.stringMatching(/heads its agent's job held are unknown/) });
      expect(carry({ heads: [] })).toMatchObject({ none: expect.stringMatching(/held none/) });
      expect(carry({ heads: undefined, fixSha: undefined })).toHaveProperty('none');
      expect(carry({ base: '' })).toMatchObject({ none: expect.stringMatching(/checked out is unknown/) });
      expect(carry({ base: undefined })).toHaveProperty('none');
      expect(carry({ fixSha: 'not-a-sha', heads: null })).toHaveProperty('none');
    });
  });
});

// #1379: a changes-request that lands on a head before its status does is skipped by the revise
// filter ("not provably the Implementer's"), and nothing retried it. After writing the status the
// job re-delivers it, once, by re-adding `agent:revise`.
describe('re-delivery: a changes-request filed before the status is written reaches the revise lane (#1379)', () => {
  const H = sha('3');
  const STAMPED = '2026-10-23T14:32:20Z';
  const review = (state: string, commit: string, at: string) => ({ state, commit_id: commit, submitted_at: at });
  const decide = (reviews: unknown, over: Record<string, unknown> = {}) =>
    redeliverDecision({ reviews, head: H, statusAt: STAMPED, sameContent: () => false, ...over });

  it('re-delivers a changes-request on the head submitted before the status (#1374\'s race)', () => {
    expect(decide([review('CHANGES_REQUESTED', H, '2026-10-23T14:31:42Z')])).toMatchObject({ redeliver: expect.stringMatching(/before the status/) });
  });

  it('re-delivers one on another commit carrying the head\'s content, as the label path reads it', () => {
    const other = sha('2');
    expect(decide([review('CHANGES_REQUESTED', other, '2026-10-23T14:31:42Z')], { sameContent: (s: string) => s === other })).toHaveProperty('redeliver');
  });

  it('not an approval, and not a changes-request an approval since superseded', () => {
    expect(decide([review('APPROVED', H, '2026-10-23T14:31:42Z')])).toMatchObject({ none: expect.stringMatching(/APPROVED/) });
    expect(decide([review('CHANGES_REQUESTED', H, '2026-10-23T14:30:00Z'), review('APPROVED', H, '2026-10-23T14:31:42Z')])).toHaveProperty('none');
    // A COMMENTED review decides nothing: the changes-request before it still stands.
    expect(decide([review('CHANGES_REQUESTED', H, '2026-10-23T14:30:00Z'), review('COMMENTED', H, '2026-10-23T14:31:42Z')])).toHaveProperty('redeliver');
  });

  it('not a changes-request submitted after the status: its own event saw the status', () => {
    expect(decide([review('CHANGES_REQUESTED', H, '2026-10-23T14:33:00Z')])).toMatchObject({ none: expect.stringMatching(/after the status/) });
    expect(decide([review('CHANGES_REQUESTED', H, STAMPED)])).toHaveProperty('none');
  });

  it('not a changes-request on other content', () => {
    expect(decide([review('CHANGES_REQUESTED', sha('2'), '2026-10-23T14:31:42Z')])).toMatchObject({ none: expect.stringMatching(/no verdict stands/) });
  });

  it('nothing on an unknown time, unread reviews, or a review with no commit or time', () => {
    expect(decide([review('CHANGES_REQUESTED', H, '2026-10-23T14:31:42Z')], { statusAt: '' })).toHaveProperty('none');
    expect(decide(null)).toMatchObject({ none: expect.stringMatching(/could not be read/) });
    expect(decide([review('CHANGES_REQUESTED', '', '2026-10-23T14:31:42Z')])).toHaveProperty('none');
    expect(decide([review('CHANGES_REQUESTED', H, '')])).toHaveProperty('none');
  });

  it('fingerprints a patch as the revise filter does: base churn moves nothing, content does', () => {
    const diff = (content: string, churn: string) => [
      'diff --git a/x.mjs b/x.mjs', `index ${churn}..abc 100644`, '--- a/x.mjs', '+++ b/x.mjs',
      `@@ -1,3 +1,3 @@ ${churn}`, ` context ${churn}`, '-old', `+${content}`, '',
    ].join('\n');
    expect(patchFingerprint(diff('new', 'aaa'))).toBe(patchFingerprint(diff('new', 'bbb')));
    expect(patchFingerprint(diff('new', 'aaa'))).not.toBe(patchFingerprint(diff('other', 'aaa')));
  });
});

// The GitHub half, run against a stub `gh`: what the job writes, and with which token.
describe('re-delivery: the job re-adds `agent:revise` with its third token, and only after a status write (#1379)', SPAWNS, () => {
  const START = sha('1');
  const H = sha('3');
  const STUB = `#!/usr/bin/env bash
printf '%s|%s\\n' "$GH_TOKEN" "$*" >> "$CALLS"
case "$*" in
  "api -X POST repos/acme/widgets/statuses/"*) [ -n "\${STATUS_FAILS:-}" ] && { echo 'HTTP 403' >&2; exit 1; }; echo '{"created_at":"2026-10-23T14:32:20Z"}' ;;
  "api --paginate --slurp repos/acme/widgets/commits/"*) printf '[%s]' "$STATUSES" ;;
  "api --paginate --slurp repos/acme/widgets/pulls/7/reviews"*) printf '[%s]' "$REVIEWS" ;;
  "api repos/acme/widgets/pulls/7") printf '{"head":{"sha":"%s"},"base":{"ref":"main"}}' "$HEAD_SHA" ;;
  "api repos/acme/widgets/compare/main..."*) printf 'diff --git a/x b/x\\n+%s\\n' "\${2##*...}" ;;
  "api repos/acme/widgets/compare/"*) printf '%s' "$COMPARE" ;;
  "label list"*) echo '[{"name":"agent:revise"}]' ;;
  "api -X DELETE "*|"api -X POST repos/acme/widgets/issues/"*) echo '{}' ;;
  *) echo "unexpected: $*" >&2; exit 3 ;;
esac
`;
  const run = ({ reviews = [{ state: 'CHANGES_REQUESTED', commit_id: H, submitted_at: '2026-10-23T14:31:42Z' }] as unknown[], statusFails = false, prToken = 'pr-tok' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'implementer-redeliver-'));
    try {
      writeStub(join(dir, 'gh'), STUB);
      const calls = join(dir, 'calls');
      const out = execFileSync('node', ['actions/implementer-status/implementer-status.mjs'], {
        encoding: 'utf8',
        env: {
          PATH: `${dir}:${process.env.PATH ?? ''}`, CALLS: calls, GITHUB_REPOSITORY: REPO, MODE: 'carry', PR: '7',
          APP_SLUG: SLUG, READ_TOKEN: 'read-tok', STATUS_TOKEN: 'status-tok', PR_TOKEN: prToken,
          START_HEAD: START, HEAD_SHA: H, BASE: START, FIX_SHA: '', HEADS: JSON.stringify([{ ref: 'feat/7-x', sha: H }]),
          STATUSES: JSON.stringify([{ context: CONTEXT, state: 'success', creator: { login: `${SLUG}[bot]` } }]),
          COMPARE: JSON.stringify({ status: 'ahead', commits: [commitBy(H, APP_COMMIT, [START])] }),
          REVIEWS: JSON.stringify(reviews), STATUS_FAILS: statusFails ? '1' : '',
        },
      });
      const log = (() => { try { return readFileSync(calls, 'utf8').trim().split('\n'); } catch { return []; } })();
      return { out, log, labels: log.filter((l) => /issues\/7\/labels/.test(l)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('removes and re-adds `agent:revise` with the Pull requests token after the status is set', () => {
    const r = run();
    expect(r.out).toMatch(/set on PR #7/);
    expect(r.labels).toEqual([
      'pr-tok|api -X DELETE repos/acme/widgets/issues/7/labels/agent%3Arevise',
      'pr-tok|api -X POST repos/acme/widgets/issues/7/labels -f labels[]=agent:revise',
    ]);
    expect(r.out).toMatch(/re-delivered/i);
  });

  it('adds nothing when the status write failed', () => {
    const r = run({ statusFails: true });
    expect(r.labels).toEqual([]);
    expect(r.log.some((l) => /reviews/.test(l))).toBe(false);
  });

  it('adds nothing on an approval, and says so', () => {
    const r = run({ reviews: [{ state: 'APPROVED', commit_id: H, submitted_at: '2026-10-23T14:31:42Z' }] });
    expect(r.labels).toEqual([]);
    expect(r.out).toMatch(/nothing to re-deliver/);
  });

  it('adds nothing, and says why, when the third token could not be minted', () => {
    const r = run({ prToken: '' });
    expect(r.labels).toEqual([]);
    expect(r.out).toMatch(/set on PR #7/);
    expect(r.out).toMatch(/Pull requests write/);
  });

  it('the action mints the third token with Pull requests write alone, never failing the caller, and hands it to the script', () => {
    type A = { runs: { steps: Array<{ id?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; 'continue-on-error'?: boolean }> } };
    const action = parse(readFileSync('actions/implementer-status/action.yml', 'utf8')) as A;
    const mint = action.runs.steps.find((s) => s.id === 'pr-token')!;
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(mint['continue-on-error']).toBe(true);
    expect(Object.entries(mint.with ?? {}).filter(([k]) => k.startsWith('permission-'))).toEqual([['permission-pull-requests', 'write']]);
    expect(action.runs.steps.at(-1)!.env?.PR_TOKEN).toBe('${{ steps.pr-token.outputs.token }}');
    // The fingerprint's compare roots at the base branch as a REST path, as the revise lane's does (kanon#1432).
    expect(readFileSync('actions/implementer-status/implementer-status.mjs', 'utf8')).toContain('compare/${branchPath(base)}...${sha}');
  });
});

/**
 * The four Implementer lanes: the workflow their status job is in, the job each runs its agent
 * in, and the mode their status step uses. The rebase lane's status job runs once per entry, in
 * `rebase-run.yml` after that entry's agent (#1379), so each pull request it resolved is stamped
 * when its own entry ends, not after every entry has, and keeps its status.
 */
const LANES = {
  'agent-implement.yml': { agent: 'implement', mode: 'open', file: 'agent-implement.yml' },
  'agent-triage.yml': { agent: 'triage-fix', mode: 'open', file: 'agent-triage.yml' },
  'agent-implement-revise.yml': { agent: 'revise', mode: 'carry', file: 'agent-implement-revise.yml' },
  'agent-rebase.yml': { agent: 'resolve', mode: 'carry', file: 'rebase-run.yml' },
} as const;
type Step = { uses?: string; run?: string; with?: Record<string, string>; id?: string; 'continue-on-error'?: boolean };
type Job = { needs?: string | string[]; if?: string; uses?: string; steps?: Step[]; with?: Record<string, unknown>; outputs?: Record<string, string>; secrets?: Record<string, string> };
const wf = (f: string) => parse(readFileSync(`.github/workflows/${f}`, 'utf8')) as { jobs: Record<string, Job> };

describe('every Implementer lane sets it in a fixed job after its agent\'s, never in it', () => {
  it.each(Object.entries(LANES))('%s', (lane, { agent, mode, file }) => {
    const { jobs } = wf(file);
    const job = jobs['implementer-status']!;
    expect(job, 'the lane has an implementer-status job').toBeDefined();
    // The revise lane's `fix-push` too, whose fix commit the carry binds to (#1263). The rebase
    // lane's runs in its entry's own call (#1379), after that entry's push, which runs after its
    // agent (kanon#1384).
    expect([job.needs].flat()).toEqual(lane === 'agent-implement-revise.yml' ? ['filter', 'fix-push', agent] : lane === 'agent-rebase.yml' ? ['push'] : ['filter', agent]);
    expect(job.if).toMatch(/!cancelled\(\)/);
    const steps = job.steps ?? [];
    // Nothing but Kanon's Node and the action: no agent, no `./` action, no checkout.
    expect(steps.map((s) => s.uses)).toEqual(['$/actions/kanon-path', '$/actions/implementer-status']);
    const call = steps[1]!;
    expect(call['continue-on-error']).toBe(true);
    expect(call.with?.mode).toBe(mode);
    if (lane === 'agent-rebase.yml') {
      // The entry's call holds the key its lane maps from the Author App's secrets.
      expect(call.with?.['app-id']).toBe('${{ secrets.app-id }}');
      expect(call.with?.['app-private-key']).toBe('${{ secrets.app-private-key }}');
      expect(wf(lane).jobs.resolve!.secrets).toMatchObject({ 'app-id': '${{ secrets.AUTHOR_APP_ID }}', 'app-private-key': '${{ secrets.AUTHOR_APP_PRIVATE_KEY }}' });
    } else {
      expect(call.with?.['app-id']).toBe('${{ secrets.AUTHOR_APP_ID }}');
      expect(call.with?.['app-private-key']).toBe('${{ secrets.AUTHOR_APP_PRIVATE_KEY }}');
    }
    // What the chain or the pick reads was recorded by the filter job, before any agent ran.
    const inputs = Object.values(call.with ?? {}).join(' ');
    if (mode === 'open') {
      expect(call.with?.since).toBe('${{ needs.filter.outputs.since }}');
      expect(call.with?.['branches-before']).toBe('${{ needs.filter.outputs.branches }}');
      // The one input read from the lane's call (#324): the heads its push job moved, which bind
      // the pick to the head this run pushed (`[LANE-16]`). Nothing else of that call.
      expect(call.with?.heads).toBe(`\${{ needs.${agent}.outputs.push-heads }}`);
      const rest = Object.entries(call.with ?? {}).filter(([k]) => k !== 'heads').map(([, v]) => v).join(' ');
      expect(rest).not.toMatch(new RegExp(`needs\\.${agent}\\.`));
    } else {
      // The rebase lane's start is the filter's record too, handed into the entry's call.
      expect(inputs).toMatch(lane === 'agent-rebase.yml' ? /inputs\.start-head/ : /needs\.filter\.outputs\.(head_sha|heads)/);
      // #1263: the binding to what the push moved, and nothing else of it. The rebase lane's push
      // job is in its entry's call, beside the agent's job, whose outputs it never reads (`[LANE-16]`).
      const from = lane === 'agent-rebase.yml' ? 'push' : agent;
      const read = [...inputs.matchAll(new RegExp(`needs\\.${from}\\.outputs\\.([\\w-]+)`, 'g'))].map((m) => m[1]);
      expect([...new Set(read)].sort()).toEqual(lane === 'agent-rebase.yml' ? ['checked'] : ['push-base', 'push-heads']);
      if (lane === 'agent-rebase.yml') expect(inputs).not.toMatch(new RegExp(`needs\\.${agent}\\.`));
    }
  });

  // #1263: every output the carry reads really reaches the step, through `needs` and each called
  // workflow's `outputs:` block.
  describe('carry: the binding is wired from the agent\'s job to the step (#1263)', SPAWNS, () => {
    type Called = { on: { workflow_call: { outputs?: Record<string, { value: string }> } }; jobs: Record<string, Job> };
    const called = (f: string) => parse(readFileSync(`.github/workflows/${f}`, 'utf8')) as Called;

    it('the revise lane: heads and base from the spine, or the fix commit and its parent from fix-push', () => {
      const { jobs } = wf('agent-implement-revise.yml');
      const job = jobs['implementer-status']!;
      expect([job.needs].flat()).toEqual(expect.arrayContaining(['filter', 'fix-push', 'revise']));
      const call = job.steps![1]!;
      expect(call.with).toMatchObject({
        'start-head': '${{ needs.filter.outputs.head_sha }}',
        heads: '${{ needs.revise.outputs.push-heads }}',
        base: '${{ needs.revise.outputs.push-base || needs.fix-push.outputs.base }}',
        'fix-sha': '${{ needs.fix-push.outputs.sha }}',
      });
      expect(jobs.revise!.uses).toBe('$/.github/workflows/agent-lane.yml');
      expect(jobs['fix-push']!.outputs).toMatchObject({ sha: '${{ steps.push.outputs.sha }}', base: '${{ steps.push.outputs.base }}' });
      const push = jobs['fix-push']!.steps!.find((s) => s.id === 'push')!;
      expect(push.run).toMatch(/revise-fix\.mjs" push .*--head "\$HEAD_SHA"/s);
      expect(readFileSync('scripts/revise-fix.mjs', 'utf8')).toContain("output({ pushed: 'true', sha, base })");
      // The spine passes both up from its push job, which builds on the commit the agent's job
      // checked out, read from that job's checkout before the agent ran (kanon#1383).
      expect(called('agent-lane.yml').on.workflow_call.outputs).toMatchObject({ 'push-heads': { value: '${{ jobs.push.outputs.heads }}' }, 'push-base': { value: '${{ jobs.push.outputs.base }}' } });
      expect(called('agent-lane.yml').jobs.push!.outputs).toMatchObject({ heads: '${{ steps.push.outputs.heads }}', base: '${{ steps.push.outputs.base }}' });
      const spine = called('lane-agent-job.yml');
      expect(spine.on.workflow_call.outputs).toMatchObject({ start: { value: '${{ jobs.run.outputs.start }}' } });
      expect(spine.jobs.run!.outputs).toMatchObject({ start: '${{ steps.checkout.outputs.commit }}' });
      const steps = spine.jobs.run!.steps!;
      const checkout = steps.findIndex((s) => s.id === 'checkout');
      expect(steps[checkout]!.uses).toMatch(/^actions\/checkout@/);
      expect(checkout).toBeLessThan(steps.findIndex((s) => s.id === 'agent'));
    });

    it('[LANE-16] on the spine\'s lanes, the status reads heads and base only from the push job or fix-push, never the agent\'s job', () => {
      const spineOutputs = called('agent-lane.yml').on.workflow_call.outputs ?? {};
      // What the spine hands up from the agent's job is how it ended, never a head or a base.
      const fromRun = Object.entries(spineOutputs).filter(([, o]) => /jobs\.run\./.test(o.value)).map(([k]) => k);
      expect(fromRun.sort()).toEqual(['kind', 'outcome']);
      for (const k of ['push-heads', 'push-base', 'push-pr']) expect(spineOutputs[k]?.value, k).toMatch(/^\$\{\{ jobs\.push\.outputs\.\w+ \}\}$/);
      // And each spine lane's status reads its call's push outputs, or the revise lane's fix-push.
      for (const file of ['agent-implement.yml', 'agent-triage.yml', 'agent-implement-revise.yml'] as const) {
        const { agent } = LANES[file];
        const call = wf(file).jobs['implementer-status']!.steps![1]!;
        for (const key of ['heads', 'base'] as const) {
          const v = call.with?.[key];
          if (v === undefined) continue;
          const reads = [...v.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)].map((m) => `${m[1]}.${m[2]}`);
          expect(reads.length, `${file} ${key}`).toBeGreaterThan(0);
          for (const r of reads) expect([`${agent}.push-${key}`, `fix-push.${key}`], `${file} ${key} reads ${r}`).toContain(r);
        }
      }
    });

    it('[LANE-16] on the rebase lane, the status reads heads and base only from the push job, never the agent\'s job', () => {
      const { jobs } = wf('agent-rebase.yml');
      expect(jobs.resolve!.uses).toBe('$/.github/workflows/rebase-run.yml');
      // #1379: no status job after the whole matrix; each entry's call stamps its own pull request.
      expect(jobs['implementer-status']).toBeUndefined();
      expect(jobs.resolve!.with).toMatchObject({
        pr: '${{ matrix.pr }}',
        'start-head': "${{ fromJson(needs.filter.outputs.heads || '{}')[format('{0}', matrix.pr)] }}",
      });
      const run = called('rebase-run.yml');
      const status = run.jobs['implementer-status']!;
      expect([status.needs].flat()).toEqual(['push']);
      const call = status.steps![1]!;
      const C = "fromJson(needs.push.outputs.checked || '{}')";
      expect(call.with).toMatchObject({
        pr: '${{ inputs.pr }}',
        'start-head': '${{ inputs.start-head }}',
        heads: `\${{ ${C}.pr == inputs.pr && ${C}.heads || '' }}`,
        base: `\${{ ${C}.pr == inputs.pr && ${C}.base || '' }}`,
      });
      expect(call.with?.['fix-sha']).toBeUndefined();
      expect(JSON.stringify(status)).not.toMatch(/needs\.resolve\./);
      expect(run.on.workflow_call.outputs?.checked?.value).toBe('${{ jobs.push.outputs.checked }}');
      // The push job builds it from the input and its own step's outputs: the branch it moved, with
      // GitHub's commit id, and the head it built on. `toJSON` quotes each value, so the heads text
      // adds no key; and it is empty unless the push moved a branch.
      expect(run.jobs.push!.outputs).toMatchObject({
        heads: '${{ steps.push.outputs.heads }}',
        base: '${{ steps.push.outputs.base }}',
        checked: `\${{ steps.push.outputs.base && format('{{"pr":{0},"base":{1},"heads":{2}}}', toJSON(inputs.pr), toJSON(steps.push.outputs.base), toJSON(steps.push.outputs.heads)) || '' }}`,
      });
      // The agent's job hands up no head and no `checked`: GitHub re-creates the agent's commits. Its
      // `attempt` names only the bundle the push job reads (kanon#1465).
      expect(run.jobs.resolve!.uses).toBe('$/.github/workflows/rebase-agent-job.yml');
      const agentJob = called('rebase-agent-job.yml');
      expect(Object.keys(agentJob.on.workflow_call.outputs ?? {}).sort()).toEqual(['attempt', 'commits', 'head-ref', 'merged', 'start']);
      expect(Object.keys(agentJob.jobs.resolve!.outputs ?? {}).sort()).toEqual(['attempt', 'commits', 'head-ref', 'merged', 'start']);
      type S = Step & { env?: Record<string, string>; if?: string };
      const steps = agentJob.jobs.resolve!.steps! as S[];
      const at = (id: string) => steps.findIndex((s) => s.id === id);
      expect(at('heads')).toBe(-1);
      // The records before the agent, after the checkout, and before the project's own code.
      expect(at('checkout')).toBeLessThan(at('base'));
      expect(at('base')).toBeLessThan(at('project'));
      expect(at('base')).toBeLessThan(at('agent'));
      expect(steps[at('base')]!['continue-on-error']).toBe(true);
    });

    it('the rebase lane\'s record reads what the job fetched, and the push job\'s `checked` is the shape the carry reads', () => {
      const steps = called('rebase-agent-job.yml').jobs.resolve!.steps!;
      const step = (id: string) => steps.find((s) => s.id === id)!.run!;
      const dir = mkdtempSync(join(tmpdir(), 'implementer-checked-'));
      try {
        const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
        git('init', '-q', '-b', 'main');
        git('commit', '-q', '--allow-empty', '-m', 'base');
        const fetched = git('rev-parse', 'HEAD');
        git('update-ref', 'refs/remotes/origin/feat/7-mine', fetched);
        git('commit', '-q', '--allow-empty', '-m', 'the default branch');
        const merged = git('rev-parse', 'HEAD');
        git('update-ref', 'refs/remotes/origin/main', merged);
        const bin = join(dir, '.bin');
        execFileSync('mkdir', ['-p', bin]);
        execFileSync('bash', ['-c', `printf '#!/bin/sh\\ncase "$*" in *headRefName*) echo feat/7-mine ;; *defaultBranchRef*) echo main ;; *) exit 1 ;; esac\\n' > "${bin}/gh" && chmod +x "${bin}/gh"`]);
        const out = join(dir, '.out');
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_OUTPUT: out, PR_NUMBER: '7', REPO: REPO };
        execFileSync('bash', ['-c', step('base')], { cwd: dir, env });
        expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual([`base=${fetched}`, 'ref=feat/7-mine', `merged=${merged}`]);
        // The push job moved the branch to the merge GitHub created on the fetched head, and its
        // `checked`, as its `format` and `toJSON` build it, carries `heads` as the spine's JSON array text.
        const pushed = 'c'.repeat(40);
        const headsText = JSON.stringify([{ ref: 'feat/7-mine', sha: pushed }]);
        const checked = JSON.parse(`{"pr":${JSON.stringify(7)},"base":${JSON.stringify(fetched)},"heads":${JSON.stringify(headsText)}}`) as { pr: number; base: string; heads: string };
        expect(checked).toEqual({ pr: 7, base: fetched, heads: headsText });
        // And the carry reads exactly that shape.
        const v = carryDecision({
          startHead: fetched, head: pushed, slug: SLUG, startStatuses: [{ context: CONTEXT, state: 'success', creator: { login: `${SLUG}[bot]` } }],
          compare: { status: 'ahead', commits: [commitBy(pushed, APP_COMMIT, [fetched, merged])] }, heads: JSON.parse(checked.heads), base: checked.base, fixSha: '',
        });
        expect(v).toEqual({ carry: pushed });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('and no other job of any workflow calls the action', () => {
    const all = readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f));
    const callers = all.flatMap((f) => Object.entries(wf(f).jobs ?? {}).filter(([, j]) => (j.steps ?? []).some((s) => s.uses === '$/actions/implementer-status')).map(([n]) => `${f}:${n}`));
    expect(callers.sort()).toEqual(Object.values(LANES).map(({ file }) => `${file}:implementer-status`).sort());
  });

  it.each(['agent-implement.yml', 'agent-triage.yml'])('%s snapshots the start and the branches in its filter job, never failing it', (file) => {
    const filter = wf(file).jobs.filter!;
    expect(filter.outputs).toMatchObject({ since: '${{ steps.before.outputs.since }}', branches: '${{ steps.before.outputs.branches }}' });
    const step = (filter.steps ?? []).find((s) => s.id === 'before')!;
    expect(step['continue-on-error']).toBe(true);
    // The time first, so nothing the listing takes can push a branch before it.
    expect(step.run!.indexOf('since=')).toBeLessThan(step.run!.indexOf('branches'));
  });

  it('the rebase lane records each PR\'s head in its filter job', () => {
    const filter = wf('agent-rebase.yml').jobs.filter!;
    expect(filter.outputs?.heads).toBe('${{ steps.heads.outputs.heads }}');
    expect((filter.steps ?? []).find((s) => s.id === 'heads')?.['continue-on-error']).toBe(true);
  });
});

// #324: the binding the `open` pick matches on. Since kanon#1383 the push job records it: the
// heads it moved through GitHub, not what the agent's job held (`LANE-16`).
describe('the push job records the heads it moved, for the open pick', () => {
  const lane = parse(readFileSync('.github/workflows/agent-lane.yml', 'utf8')) as {
    on: { workflow_call: { outputs: Record<string, { value: string }> } }; jobs: Record<string, { outputs?: Record<string, string> }>;
  };

  it('passes them up from the push job as `push-heads`, and the agent\'s job passes up none', () => {
    expect(lane.on.workflow_call.outputs['push-heads']?.value).toBe('${{ jobs.push.outputs.heads }}');
    expect(lane.jobs.push?.outputs?.heads).toBe('${{ steps.push.outputs.heads }}');
    expect(lane.on.workflow_call.outputs.heads).toBeUndefined();
  });

  it('in the shape the pick reads: the pull request at a moved head is this run\'s', () => {
    // `scripts/lane-push.mjs` writes `heads=<JSON [{ref, sha}]>`, one entry per branch it moved.
    const mine = 'a'.repeat(40);
    const theirs = 'b'.repeat(40);
    const heads = [{ ref: 'feat/7-mine', sha: mine }];
    const v = pickOpened({ prs: [pr(7, 'feat/7-mine', mine), pr(8, 'feat/8-theirs', theirs)], repo: REPO, since: SINCE, branchesBefore: ['main'], slug: SLUG, heads, headCommit: (x: string) => commitBy(x) });
    expect(v).toEqual({ pr: 7, sha: mine });
  });
});
