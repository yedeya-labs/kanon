/**
 * The inbox (`K-WORK-24`, `K-WORK-25`): what waits on a person, read from GitHub when they ask.
 * Two lists and nothing else, both computed: the pull requests ready for a person's merge, by the
 * readiness view's definition, and the decisions asked of a person, each a thread labelled
 * `decision:needed` with its ask in the fixed form.
 *
 * WHY THE DEFINITION OF READY IS PINNED HERE, PART BY PART. "Ready to merge" was what each session
 * kept its own way, and the inbox replaces every one of those lists, so a part of the definition
 * that silently drops (a stale approval counted, a red check missed, a conflict ignored) would
 * offer the person a merge the gate's own checks refuse. Each case below changes one fact of a
 * pull request that is otherwise ready, and asserts it leaves the inbox, so removing any one test
 * from the readiness view turns exactly one case red.
 */
import { describe, expect, it } from 'vitest';
import { HEAD, OLD, READ_AT, REPO, approval, ci, implementerPr, personPr, type PrWorld } from './helpers/pr-world.js';
import { numbered, ownerWorld, type OwnerIssue } from './helpers/owner-world.js';

const { inboxView } = await import('../../scripts/status/needs-owner.mjs');
const { readinessView, checksFromRuns, Q_PR_NO_CHECKS } = await import('../../scripts/status/pull-request.mjs');
const { IncompleteRead } = await import('../../scripts/status/project.mjs');
const { inbox } = await import('../../cli/inbox.mjs');
const { EXIT, SCHEMA } = await import('../../cli/status.mjs');
const { DECISION_LABEL, ASK_MARKER, ANSWER_MARKER, askBody, answerBody, askState, isWholeAsk, kindOf } = await import('../../scripts/lib/decision-asks.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const AT = '2026-10-27T09:00:00Z';
const ASK = () => askBody({ question: 'PRIVATE: which provider?', options: ['PRIVATE one', 'PRIVATE two'], recommendation: 'PRIVATE one.' });

/** The numbers of the pull requests the inbox offers for a person's merge, over these. */
async function readyOf(prs: PrWorld[]): Promise<number[]> {
  const w = ownerWorld({ prs });
  const v: Any = await inboxView({ reader: w.reader, repo: w.repo, now: READ_AT });
  return v.merges.map((m: Any) => m.number);
}

/** A workflow run on the head, as the REST listing has one. */
const run = (id: number, name: string, status: string, conclusion: string | null) => ({ id, name, status, conclusion, event: 'pull_request', run_started_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:05:00Z' });

describe('the inbox', () => {
  it('[STAT-16] lists the pull requests ready for a person\'s merge and the decisions asked of a person, and nothing else', async () => {
    const issues: OwnerIssue[] = [
      { number: 60, title: 'Pick a payment provider', labels: [DECISION_LABEL], comments: [{ login: 'octo', body: ASK(), createdAt: AT }] },
      { number: 61, title: 'Choose a font', labels: [DECISION_LABEL], comments: [] },
      // Things the needs-the-Owner view lists, and the inbox doesn't.
      { number: 30, title: 'Pick a store', labels: ['qa:needs-info'] },
    ];
    const w = ownerWorld({ prs: [numbered(44, personPr()), numbered(45, personPr({ checks: [ci('test', 'FAILURE')] }))], issues });
    const v: Any = await inboxView({ reader: w.reader, repo: w.repo, now: READ_AT });
    expect(Object.keys(v).sort()).toEqual(['asks', 'branch', 'merges']);
    expect(v.merges.map((m: Any) => [m.number, m.url])).toEqual([[44, `https://github.com/${REPO}/pull/44`]]);
    expect(v.asks).toEqual([
      { number: 60, title: 'Pick a payment provider', url: `https://github.com/${REPO}/issues/60`, kind: 'issue', ask: `https://github.com/${REPO}/issues/60#issuecomment-1`, form: 'ok', answered: false },
      { number: 61, title: 'Choose a font', url: `https://github.com/${REPO}/issues/61`, kind: 'issue', ask: null, form: 'missing', answered: false },
    ]);
    // The issues are asked for by the label alone; no lane, hold or stop label is read.
    const asked = w.seen.filter((s) => s.startsWith('GraphQL OwnerIssues '));
    expect(asked.map((s) => JSON.parse(s.slice('GraphQL OwnerIssues '.length)).labels)).toEqual([[DECISION_LABEL]]);
    // No comment's text leaves the process.
    expect(JSON.stringify(v)).not.toMatch(/PRIVATE/);
  });

  it('[STAT-16] makes the inbox an error when a read fails, never a shorter list', async () => {
    const w = ownerWorld({
      prs: [numbered(44, personPr())],
      issues: [{ number: 60, title: 'Pick', labels: [DECISION_LABEL], comments: [] }],
      overrides: { pages: (p) => { if (p.includes('issues/60/comments')) throw new Error('API rate limit exceeded'); return undefined; } },
    });
    const err: Any = await inboxView({ reader: w.reader, repo: w.repo, now: READ_AT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteRead);
    expect(err.message).toMatch(/^the inbox couldn't be read whole.*issues\/60\/comments\?per_page=100 failed: API rate limit exceeded/);
  });
});

describe('[K-WORK-25] what the inbox calls ready for a person\'s merge', () => {
  it('[STAT-14] offers a person\'s pull request that is green, mergeable and approved on its head', async () => {
    expect(await readyOf([numbered(44, personPr())])).toEqual([44]);
  });

  // One fact changed at a time, each enough on its own to take the pull request out.
  const NOT_READY: Array<[string, Partial<PrWorld>]> = [
    ['an approval of an older commit, not the head', { reviews: [approval(1, OLD)] }],
    ['changes requested on the head', { reviews: [approval(1, HEAD, 'CHANGES_REQUESTED')] }],
    ['an approval on the head, then changes requested on it', { reviews: [approval(1, HEAD), approval(2, HEAD, 'CHANGES_REQUESTED')] }],
    ['only a comment on the head, after an approval of an older commit', { reviews: [approval(1, OLD), approval(2, HEAD, 'COMMENTED')] }],
    ['no review at all', { reviews: [] }],
    ['an approval by someone who is not the Reviewer', { reviews: [{ ...approval(1), login: 'octo' }] }],
    ['a required check failed', { checks: [ci('test', 'FAILURE')] }],
    ['a check still running', { checks: [ci('test'), ci('lint', null)] }],
    ['a check cancelled and not re-run', { checks: [ci('test', 'CANCELLED')] }],
    ['no check has run on the head', { checks: [] }],
    ['GitHub reports it conflicting', { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }],
    ['already merged', { state: 'MERGED' }],
    ['closed', { state: 'CLOSED' }],
  ];
  it.each(NOT_READY)('[STAT-14] leaves it out when it has %s', async (_name, over) => {
    const pr = numbered(44, personPr(over));
    const w = ownerWorld({ prs: [pr] });
    const v: Any = await inboxView({ reader: w.reader, repo: w.repo, now: READ_AT });
    expect(v.merges).toEqual([]);
    const r: Any = await readinessView({ reader: ownerWorld({ prs: [pr] }).reader, repo: REPO, pr: 44, now: READ_AT });
    expect(r.readiness.ready).toBe(false);
  });

  it('[STAT-16] asks GitHub for open pull requests only, so one a person merged or closed is never offered', async () => {
    const w = ownerWorld({ prs: [numbered(44, personPr())] });
    await inboxView({ reader: w.reader, repo: w.repo, now: READ_AT });
    const listing = w.queries.find((q) => /query OpenPullRequests/.test(q))!;
    expect(listing).toMatch(/pullRequests\(states: OPEN,/);
  });

  it("[STAT-14] offers the Implementer's pull request only when an escalation path alone stops the Merger", async () => {
    // The Merger's to merge: green, approved, no escalation path. Not the person's.
    expect(await readyOf([numbered(42, implementerPr())])).toEqual([]);
    // Escalated for a path alone: the person's.
    expect(await readyOf([numbered(43, implementerPr({ files: [{ filename: 'migrations/001.sql' }] }))])).toEqual([43]);
    // Escalated for a path, and red besides: not ready for anyone.
    expect(await readyOf([numbered(43, implementerPr({ files: [{ filename: 'migrations/001.sql' }], checks: [ci('test', 'FAILURE')] }))])).toEqual([]);
  });
});

describe('a token GitHub refuses the check runs', () => {
  const refused = (over: Partial<PrWorld>) => numbered(44, personPr({ checksRefused: true, checks: [], ...over }));

  it('[STAT-15] reads the head\'s checks from its workflow runs and statuses, says so, and answers as over the check runs', async () => {
    const green = refused({ headRuns: [run(1, 'CI', 'completed', 'success')] });
    const w = ownerWorld({ prs: [green] });
    const r: Any = await readinessView({ reader: w.reader, repo: REPO, pr: 44, now: READ_AT });
    expect(r.checks.source).toBe('runs');
    expect(r.checks.relevant.map((c: Any) => [c.name, c.status, c.conclusion])).toEqual([['CI', 'COMPLETED', 'SUCCESS']]);
    expect(r.readiness).toMatchObject({ by: 'person', ready: true });
    expect(w.seen).toContain('GraphQL PullRequestGateNoChecks {"owner":"acme","name":"shop","number":44}');
    expect(Q_PR_NO_CHECKS).not.toMatch(/statusCheckRollup|CheckRun/);
    expect(await readyOf([green])).toEqual([44]);
    // The same pull request over the check runs gives the same answer, from the rollup.
    const rollup: Any = await readinessView({ reader: ownerWorld({ prs: [numbered(44, personPr())] }).reader, repo: REPO, pr: 44, now: READ_AT });
    expect([rollup.checks.source, rollup.readiness.ready]).toEqual(['rollup', true]);
  });

  it.each([
    ['a run that failed', [run(1, 'CI', 'completed', 'success'), run(2, 'Tests', 'completed', 'failure')], [], 'checks'],
    ['a run still going', [run(1, 'CI', 'in_progress', null)], [], 'checks'],
    ['no run at all', [], [], 'checks'],
    ['a commit status that failed', [run(1, 'CI', 'completed', 'success')], [{ context: 'deploy/preview', state: 'failure', created_at: AT }], 'checks'],
  ] as Array<[string, Any[], Any[], string]>)('[STAT-15] is not ready over %s', async (_name, headRuns, statuses, lack) => {
    const pr = refused({ headRuns, statuses: statuses.map((s: Any) => ({ context: s.context, state: s.state, creator: 'ci-bot' })) });
    const r: Any = await readinessView({ reader: ownerWorld({ prs: [pr] }).reader, repo: REPO, pr: 44, now: READ_AT });
    expect(r.checks.source).toBe('runs');
    expect(r.readiness.lacks).toContain(lack);
  });

  it('[STAT-15] takes each run as one check named by its workflow, and each status context at its newest', () => {
    const checks = checksFromRuns(
      [run(1, 'CI', 'completed', 'success'), run(2, 'Review (Reviewer)', 'completed', 'failure'), run(3, 'CI', 'queued', null)],
      [{ context: 'ci/x', state: 'success', created_at: '2026-10-25T11:00:00Z' }, { context: 'ci/x', state: 'pending', created_at: '2026-10-25T10:00:00Z' }],
    );
    expect(checks.map((c: Any) => [c.name, c.workflowName ?? null, c.status, c.conclusion])).toEqual([
      ['CI', 'CI', 'COMPLETED', 'SUCCESS'],
      ['Review (Reviewer)', 'Review (Reviewer)', 'COMPLETED', 'FAILURE'],
      ['CI', 'CI', 'QUEUED', ''],
      ['ci/x', null, 'COMPLETED', 'SUCCESS'],
    ]);
  });

  it('[STAT-3] still errors when the read without the checks fails too', async () => {
    const pr = refused({});
    const w = ownerWorld({ prs: [pr], overrides: { graphql: { PullRequestGateNoChecks: () => { throw new Error('Something went wrong'); } } } });
    await expect(readinessView({ reader: w.reader, repo: REPO, pr: 44, now: READ_AT })).rejects.toThrow(/PullRequestGateNoChecks failed: Something went wrong/);
    // And any other refusal of the first read is the view's error, not a reason to read again.
    const other = ownerWorld({ prs: [numbered(44, personPr())], overrides: { graphql: { PullRequestGate: () => { throw new Error('Bad credentials'); } } } });
    await expect(readinessView({ reader: other.reader, repo: REPO, pr: 44, now: READ_AT })).rejects.toThrow(/PullRequestGate failed: Bad credentials/);
    expect(other.seen.some((s) => s.startsWith('GraphQL PullRequestGateNoChecks'))).toBe(false);
  });
});

describe('[K-WORK-24] the decision forms', () => {
  it('writes an ask and an answer in the fixed form, and reads each by its first line only', () => {
    const ask = ASK();
    expect(ask.split('\n')[0]).toBe(ASK_MARKER);
    expect(kindOf(ask)).toBe('ask');
    expect(isWholeAsk(ask)).toBe(true);
    for (const part of ['**Question.**', '**Options.**', '**Recommendation.**']) {
      expect(isWholeAsk(ask.split('\n').filter((l) => !l.startsWith(part)).join('\n')), part).toBe(false);
    }
    const answer = answerBody({ decision: 'One.', by: 'the Owner, in chat' });
    expect(answer.split('\n')[0]).toBe(ANSWER_MARKER);
    expect(kindOf(answer)).toBe('answer');
    expect(kindOf(`\n\n${ASK_MARKER}\n**Question.** x`)).toBe('ask');
    expect(kindOf(`Quoting: ${ASK_MARKER}`)).toBeNull();
    expect(kindOf(`> ${ASK_MARKER}`)).toBeNull();
  });

  it('[STAT-16] reads a thread\'s latest ask, its form, and whether an answer followed it', () => {
    const c = (body: string, n: number) => ({ body, url: `u#${n}` });
    expect(askState([])).toEqual({ ask: null, form: 'missing', answered: false });
    expect(askState([c(answerBody({ decision: 'x', by: 'y' }), 1)])).toEqual({ ask: null, form: 'missing', answered: false });
    expect(askState([c(ASK(), 1)])).toEqual({ ask: 'u#1', form: 'ok', answered: false });
    expect(askState([c(ASK(), 1), c(answerBody({ decision: 'x', by: 'y' }), 2)])).toEqual({ ask: 'u#1', form: 'ok', answered: true });
    // A new ask after an answer is open again, and the latest ask is the one linked.
    expect(askState([c(ASK(), 1), c(answerBody({ decision: 'x', by: 'y' }), 2), c(`${ASK_MARKER}\n**Question.** again?`, 3)])).toEqual({ ask: 'u#3', form: 'incomplete', answered: false });
  });
});

describe('kanon inbox', () => {
  /** Runs `kanon inbox` over a world, with every outside effect injected, as `kanon status`'s test does. */
  async function cli(argv: string[], w: { reader: Any } | null) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await inbox(argv, {
      git: (args: string[]) => (args.join(' ') === 'remote get-url origin' ? { status: 0, stdout: 'git@github.com:acme/shop.git\n', stderr: '' } : { status: 128, stdout: '', stderr: '' }),
      gh: async () => ({ status: 0, stdout: 'octo\n', stderr: '' }),
      reader: () => {
        if (!w) throw new Error('this case reads nothing');
        return w.reader;
      },
      env: {},
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      release: () => 'v9.9.9',
      now: () => new Date('2026-10-28T09:30:00.000Z'),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  const world = () => ownerWorld({
    prs: [numbered(44, personPr()), numbered(49, personPr({ title: 'Rename the plan', labels: [DECISION_LABEL], checks: [ci('test', 'FAILURE')] }))],
    issues: [{ number: 60, title: 'Pick a payment provider', labels: [DECISION_LABEL], comments: [{ login: 'octo', body: ASK(), createdAt: AT }] }],
  });

  it('[STAT-17] prints the inbox as kanon status --inbox does, as one document or as prose with the same exit code', async () => {
    const json = await cli(['--json'], world());
    expect(json.code).toBe(EXIT.ok);
    const doc = JSON.parse(json.out);
    expect(Object.keys(doc).slice(0, 4)).toEqual(['schema', 'kanon', 'status', 'exitCode']);
    expect(doc).toMatchObject({ schema: SCHEMA, status: 'ok', repo: 'acme/shop' });
    expect(Object.keys(doc).filter((k) => !['schema', 'kanon', 'status', 'exitCode', 'repo', 'readAt'].includes(k))).toEqual(['inbox']);
    expect(doc.inbox).toEqual(await inboxView({ reader: world().reader, repo: 'acme/shop', now: Date.parse('2026-10-28T09:30:00.000Z') }));

    const prose = await cli([], world());
    expect(prose.code).toBe(json.code);
    expect(prose.out).toBe([
      'acme/shop, read at 2026-10-28T09:30:00.000Z',
      '',
      'Ready for your merge: 1',
      '  #44 docs: say how to order https://github.com/acme/shop/pull/44',
      '',
      'Decisions waiting on you: 2',
      '  Pull request #49 Rename the plan: labelled decision:needed, with no decision asked in the fixed form: https://github.com/acme/shop/pull/49',
      '  Issue #60 Pick a payment provider: https://github.com/acme/shop/issues/60#issuecomment-1',
    ].join('\n'));

    const empty = await cli([], ownerWorld({}));
    expect(empty.out).toContain('Ready for your merge: none');
    expect(empty.out).toContain('Decisions waiting on you: none');
  });

  it('[STAT-17] takes only --repo and --json, and reads nothing on a usage error', async () => {
    expect((await cli(['--repo', 'acme/shop', '--json'], world())).code).toBe(EXIT.ok);
    expect((await cli(['--repo=acme/shop'], world())).code).toBe(EXIT.ok);
    for (const argv of [['--needs-owner'], ['--pr', '44'], ['--lanes', '--json'], ['extra']]) {
      const r = await cli(argv, null);
      expect(r.code, argv.join(' ')).toBe(EXIT.usage);
      if (argv.includes('--json')) expect(JSON.parse(r.out)).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: EXIT.usage });
      else expect(r.err).toContain('kanon inbox: unknown argument');
    }
    const help = await cli(['--help'], null);
    expect([help.code, help.out]).toEqual([EXIT.ok, expect.stringContaining('Usage: kanon inbox')]);
  });
});
