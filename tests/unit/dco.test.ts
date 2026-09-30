import { describe, expect, it } from 'vitest';
import {
  checkCommit,
  EXEMPT_BOTS,
  fetchCommits,
  isAutomated,
  main,
  offending,
  signOffs,
  trailers,
} from '../../actions/dco/dco.mjs';

type Commit = Parameters<typeof checkCommit>[0];

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const sob = (who: { name: string; email: string } = ADA) => `Signed-off-by: ${who.name} <${who.email}>`;

let n = 0;
const commit = (message: string, over: Partial<Commit> = {}, author = ADA): Commit => {
  n += 1;
  return {
    sha: `${String(n).padStart(4, '0')}abcdef0123456789`,
    parents: [{ sha: 'p' }],
    author: { login: 'ada', type: 'User' },
    committer: { login: 'ada' },
    commit: { message, author, verification: { verified: false } },
    ...over,
  };
};

/** A commit GitHub created for a bot: bot author, web-flow committer, GitHub-signed. */
const botCommit = (login: string, message: string, over: Partial<Commit> = {}): Commit => {
  const c = commit(message, {}, { name: login, email: `1+${login}@users.noreply.github.com` });
  return {
    ...c,
    author: { login, type: 'Bot' },
    committer: { login: 'web-flow' },
    commit: { ...c.commit, verification: { verified: true } },
    ...over,
  };
};

describe('ADR 0010 the DCO check, over commit lists', () => {
  it('passes a list where every commit is signed off by its author', () => {
    const list = [commit(`feat: one\n\n${sob()}`), commit(`fix: two\n\nWhy it matters.\n\n${sob()}`)];
    expect(offending(list)).toEqual([]);
  });

  it('fails exactly the one unsigned commit in a list', () => {
    const unsigned = commit('fix: forgot to sign\n\nA body with no trailers.');
    const list = [commit(`feat: one\n\n${sob()}`), unsigned, commit(`feat: three\n\n${sob()}`)];
    const bad = offending(list);
    expect(bad.map((b) => b.commit.sha)).toEqual([unsigned.sha]);
    expect(bad[0]?.reason).toContain('no Signed-off-by');
  });

  it('fails a commit signed off by someone other than its author, and names both', () => {
    const result = checkCommit(commit(`feat: one\n\n${sob({ name: 'Bob', email: 'bob@example.com' })}`));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('Bob <bob@example.com>');
    expect(!result.ok && result.reason).toContain('Ada Lovelace <ada@example.com>');
  });

  it("fails a sign-off with the author's email but another name", () => {
    expect(checkCommit(commit(`feat: one\n\n${sob({ name: 'A. Lovelace', email: ADA.email })}`)).ok).toBe(false);
  });

  it("fails a sign-off with the author's name but another email", () => {
    expect(checkCommit(commit(`feat: one\n\n${sob({ name: ADA.name, email: 'ada@elsewhere.com' })}`)).ok).toBe(false);
  });

  it('passes an email that differs from the author only in case', () => {
    expect(checkCommit(commit(`feat: one\n\n${sob({ name: ADA.name, email: 'Ada@Example.COM' })}`))).toEqual({ ok: true });
  });

  it('passes when one of several trailers, and one of several sign-offs, is the author', () => {
    const message = [
      'feat: one',
      '',
      'Body.',
      '',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      sob({ name: 'Bob', email: 'bob@example.com' }),
      sob(),
      'Reviewed-by: Carol <carol@example.com>',
    ].join('\n');
    expect(checkCommit(commit(message))).toEqual({ ok: true });
  });

  it('reads the trailer key case-insensitively, as git does', () => {
    expect(checkCommit(commit(`feat: one\n\nsigned-off-by: ${ADA.name} <${ADA.email}>`))).toEqual({ ok: true });
  });

  it('accepts CRLF line endings', () => {
    expect(checkCommit(commit(`feat: one\r\n\r\n${sob()}\r\n`))).toEqual({ ok: true });
  });

  it('does not count a sign-off in the body when a later paragraph ends the message', () => {
    const result = checkCommit(commit(`feat: one\n\n${sob()}\n\nA closing paragraph of prose.`));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('no Signed-off-by');
  });

  it('does not count a sign-off inside a paragraph that is mostly prose', () => {
    const prose = ['This paragraph talks about', 'how to sign off, and quotes', 'an example line', 'of text here:', sob()];
    expect(checkCommit(commit(`feat: one\n\n${prose.join('\n')}`)).ok).toBe(false);
  });

  it('counts a sign-off in a last paragraph that is at least a quarter trailers', () => {
    const mixed = ['A note git leaves in place', 'across three', 'lines.', sob()];
    expect(checkCommit(commit(`feat: one\n\n${mixed.join('\n')}`))).toEqual({ ok: true });
  });

  it('does not count a sign-off written as the subject line', () => {
    expect(checkCommit(commit(sob())).ok).toBe(false);
  });

  it('exempts a merge commit, signed or not', () => {
    const merge = commit("Merge branch 'main' into feat/x", { parents: [{ sha: 'a' }, { sha: 'b' }] });
    expect(checkCommit(merge)).toEqual({ ok: true, skipped: 'merge' });
  });

  it('exempts a GitHub-created Dependabot commit, whose own sign-off is not its author email', () => {
    const dep = botCommit('dependabot[bot]', 'build(deps): bump x\n\nSigned-off-by: dependabot[bot] <support@github.com>');
    expect(checkCommit(dep)).toEqual({ ok: true, skipped: 'bot' });
  });

  it('exempts a GitHub-created github-actions release commit', () => {
    expect(checkCommit(botCommit('github-actions[bot]', 'chore(main): release 0.2.0'))).toEqual({ ok: true, skipped: 'bot' });
  });

  it('exempts exactly Dependabot and the github-actions bot', () => {
    expect([...EXEMPT_BOTS].sort()).toEqual(['dependabot[bot]', 'github-actions[bot]']);
    expect(checkCommit(botCommit('renovate[bot]', 'chore: bump')).ok).toBe(false);
  });

  it('does not exempt a bot author GitHub did not sign, so a spoofed author email fails', () => {
    const unsigned = botCommit('dependabot[bot]', 'build(deps): bump x', {});
    unsigned.commit.verification = { verified: false };
    expect(checkCommit(unsigned).ok).toBe(false);
  });

  it('does not exempt a bot author whose committer is not GitHub', () => {
    expect(checkCommit(botCommit('dependabot[bot]', 'build(deps): bump x', { committer: { login: 'mallory' } })).ok).toBe(false);
  });

  it('does not exempt a user account that merely has a bot login', () => {
    expect(checkCommit(botCommit('dependabot[bot]', 'build(deps): bump x', { author: { login: 'dependabot[bot]', type: 'User' } })).ok).toBe(false);
  });

  it('checks a human commit pushed onto a bot branch', () => {
    const list = [botCommit('dependabot[bot]', 'build(deps): bump x'), commit('fix: adjust after the bump')];
    expect(offending(list)).toHaveLength(1);
  });

  it('fails a commit with no author identity', () => {
    const c = commit(`feat: one\n\n${sob()}`);
    c.commit.author = null;
    expect(checkCommit(c).ok).toBe(false);
  });
});

describe('ADR 0010 a sign-off must be a person, never an AI or a bot', () => {
  const CLAUDE = { name: 'Claude', email: 'noreply@anthropic.com' };
  const CO_AUTHOR = 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>';

  it('fails a commit signed off only by Claude', () => {
    const result = checkCommit(commit(`feat: one\n\n${CO_AUTHOR}\n${sob(CLAUDE)}`));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('a person must sign off');
  });

  it('fails a commit authored and signed off by Claude, though the sign-off matches the author', () => {
    const result = checkCommit(commit(`feat: one\n\n${sob(CLAUDE)}`, {}, CLAUDE));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('a person must sign off');
  });

  it('passes a commit signed off by its human author, with a Claude Co-Authored-By', () => {
    expect(checkCommit(commit(`feat: one\n\n${CO_AUTHOR}\n${sob()}`))).toEqual({ ok: true });
  });

  it('names the author mismatch when a person, not the author, signed off an AI-authored commit', () => {
    const result = checkCommit(commit(`feat: one\n\n${sob(CLAUDE)}\n${sob({ name: 'Bob', email: 'bob@example.com' })}`, {}, CLAUDE));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('not by its author');
  });

  it('passes a human sign-off alongside a Claude sign-off', () => {
    expect(checkCommit(commit(`feat: one\n\n${sob(CLAUDE)}\n${sob()}`))).toEqual({ ok: true });
  });

  it('fails a human-authored commit signed off by a bot, even an exempt one', () => {
    const bot = { name: 'dependabot[bot]', email: 'support@github.com' };
    const result = checkCommit(commit(`fix: one\n\n${sob(bot)}`));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('a person must sign off');
  });

  it('fails a bot-authored commit that GitHub did not create, even signed off as itself', () => {
    const bot = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
    expect(checkCommit(commit(`chore: one\n\n${sob(bot)}`, {}, bot)).ok).toBe(false);
  });

  it.each([
    [CLAUDE, true],
    [{ name: 'Someone', email: 'Someone@Mail.Anthropic.COM' }, true],
    [{ name: 'Renovate[Bot]', email: 'r@example.com' }, true],
    [{ name: 'Helper', email: '1+helper[bot]@users.noreply.github.com' }, true],
    [{ name: 'Ada', email: 'ada@notanthropic.com' }, false],
    [{ name: 'Ada', email: 'anthropic.com@example.com' }, false],
    [{ name: 'Ada', email: 'ada@anthropic.com.example.org' }, false],
    [ADA, false],
  ])('classifies %j as automated: %s', (who, automated) => {
    expect(isAutomated(who)).toBe(automated);
  });
});

describe('ADR 0010 trailer parsing follows git', () => {
  it('reads continuation lines as part of the trailer before them', () => {
    expect(trailers('s\n\nSigned-off-by: Ada\n  Lovelace <ada@example.com>')).toEqual([
      'Signed-off-by: Ada Lovelace <ada@example.com>',
    ]);
  });

  it('ignores trailing blank lines', () => {
    expect(signOffs(`s\n\n${sob()}\n\n\n`)).toEqual([ADA]);
  });

  it('finds nothing in a subject-only message', () => {
    expect(trailers('feat: one')).toEqual([]);
  });

  it('finds nothing when the last paragraph has no trailer at all', () => {
    expect(trailers('feat: one\n\njust prose')).toEqual([]);
  });

  it('reads a block of trailers with no sign-off as trailers', () => {
    expect(trailers('s\n\nCo-Authored-By: C <c@x>\nReviewed-by: R <r@x>')).toEqual([
      'Co-Authored-By: C <c@x>',
      'Reviewed-by: R <r@x>',
    ]);
  });

  it('needs a Signed-off-by before it reads a partly-prose paragraph as trailers', () => {
    expect(trailers('s\n\nOne line of prose,\nanother,\nand a third.\nCo-Authored-By: C <c@x>')).toEqual([]);
  });

  it('ignores a malformed sign-off with no email', () => {
    expect(signOffs('s\n\nSigned-off-by: Ada Lovelace')).toEqual([]);
  });
});

type Page = { status?: number; body: unknown };
const fakeFetch = (routes: Record<string, Page>) => {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t0k');
    const path = u.replace('https://api.example/repos/o/r/pulls/7', '');
    const page = routes[path];
    if (!page) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
};
const env = { PR_NUMBER: '7', REPOSITORY: 'o/r', GITHUB_TOKEN: 't0k', GITHUB_API_URL: 'https://api.example', BASE_REF: 'main' };
const capture = () => {
  const out = { logs: [] as string[], errors: [] as string[] };
  return { out, sink: { log: (s: string) => out.logs.push(s), error: (s: string) => out.errors.push(s) } };
};

describe('ADR 0010 reading the pull request through the API', () => {
  it('pages through the commits, 100 at a time, until a short page', async () => {
    const full = Array.from({ length: 100 }, () => commit(`feat: x\n\n${sob()}`));
    const { impl, calls } = fakeFetch({
      '': { body: { commits: 130 } },
      '/commits?per_page=100&page=1': { body: full },
      '/commits?per_page=100&page=2': { body: full.slice(0, 30) },
    });
    const got = await fetchCommits({ api: 'https://api.example', repository: 'o/r', number: '7', token: 't0k' }, impl);
    expect(got.commits).toHaveLength(130);
    expect(got.expected).toBe(130);
    expect(calls).toHaveLength(3);
  });

  it('fails closed when the API lists fewer commits than the pull request has', async () => {
    const { impl } = fakeFetch({
      '': { body: { commits: 300 } },
      '/commits?per_page=100&page=1': { body: [commit(`feat: x\n\n${sob()}`)] },
    });
    const { out, sink } = capture();
    expect(await main(env, impl, sink)).toBe(1);
    expect(out.errors.join('\n')).toContain('Read 1 of the pull request\'s 300 commits');
  });

  it('fails closed when the API call fails', async () => {
    const { impl } = fakeFetch({ '': { status: 403, body: {} } });
    const { out, sink } = capture();
    expect(await main(env, impl, sink)).toBe(1);
    expect(out.errors.join('\n')).toContain('HTTP 403');
  });

  it('fails without a pull request number, as outside a pull_request event', async () => {
    const { impl, calls } = fakeFetch({});
    const { sink } = capture();
    expect(await main({ ...env, PR_NUMBER: '' }, impl, sink)).toBe(1);
    expect(calls).toEqual([]);
  });

  it('exits 0 and prints nothing to stderr when every commit is signed off', async () => {
    const { impl } = fakeFetch({
      '': { body: { commits: 1 } },
      '/commits?per_page=100&page=1': { body: [commit(`feat: x\n\n${sob()}`)] },
    });
    const { out, sink } = capture();
    expect(await main(env, impl, sink)).toBe(0);
    expect(out.errors).toEqual([]);
    expect(out.logs.join('\n')).toContain('DCO OK');
  });

  it('lists each offending commit by short SHA and subject, and prints the fix', async () => {
    const bad = commit('fix: the unsigned one\n\nBody.');
    const { impl } = fakeFetch({
      '': { body: { commits: 2 } },
      '/commits?per_page=100&page=1': { body: [commit(`feat: x\n\n${sob()}`), bad] },
    });
    const { out, sink } = capture();
    expect(await main(env, impl, sink)).toBe(1);
    const printed = out.errors.join('\n');
    expect(printed).toContain('1 of 2 commit(s)');
    expect(printed).toContain(`${bad.sha.slice(0, 7)} fix: the unsigned one`);
    expect(printed).not.toContain(bad.sha.slice(0, 8));
    expect(printed).toContain('git commit --amend -s');
    expect(printed).toContain('git rebase --signoff origin/main');
    expect(printed).toContain('force');
  });
});
