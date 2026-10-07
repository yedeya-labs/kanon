import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DETAILS_SCHEMA, EXIT, SCHEMA, diffRanges, metrics, parseArgs } from '../../cli/metrics.mjs';
import { RATE_FLOOR } from '../../cli/metrics-read.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon metrics dry-run` (plan 0003 §7, M2 part C, kanon#516). `gh` is a fake GitHub that
 * answers the GraphQL listing and page queries from full fixture pull requests, cutting every
 * nested list to the page size the query asks for, so the reader's paging is exercised; SZZ
 * blames in a tiny git repository whose merge commits the fixtures name.
 *
 * The fixture's titles, logins and paths are distinctive, and no test lets one reach standard
 * output (ADR 0007, `K-OBS-16`).
 */

// The repository is built with git, and every dry run with --dir runs git diff and blame.
vi.setConfig({ testTimeout: SPAWNS.timeout, hookTimeout: SPAWNS.timeout });

const REPO = 'acme/widgets';
const SINCE = '2026-09-01';
const HUMAN = { login: 'octo-secret-login', __typename: 'User' };
const AUTHOR_APP = { login: 'acme-author', __typename: 'Bot' };
const JUDGE_APP = { login: 'acme-judge', __typename: 'Bot' };
const DEPENDABOT = { login: 'dependabot', __typename: 'Bot' };

const REGISTER = `# Agent identities

| Role | App slug |
| --- | --- |
| Implementer | \`acme-author\` |
| Lead | \`acme-author\` |
| Explorer | \`acme-author\` |
| Overseer | \`acme-author\` |
| Reviewer | \`acme-judge\` |
| Merger | \`acme-judge\` |
`;
const STACK = '# Stack\n\n## Code areas\n\n- `app/` — code: the app\n';

// ── The tiny repository SZZ blames in ────────────────────────────────────────────────────────

let base = '';
let dir = '';
const sha: Record<string, string> = {};
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  }).trim();
const lines = (edit: Record<number, string> = {}) =>
  Array.from({ length: 10 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'kanon-metrics-'));
  dir = join(base, 'checkout');
  mkdirSync(join(dir, 'app'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'qa'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  writeFileSync(join(dir, 'docs/qa/agent-identities.md'), REGISTER);
  writeFileSync(join(dir, 'docs/qa/stack.md'), STACK);
  const commit = (name: string, files: Record<string, string>) => {
    for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text);
    git('add', '-A');
    git('commit', '-q', '-m', name);
    sha[name] = git('rev-parse', 'HEAD');
  };
  commit('c0', { 'app/calc.js': lines(), 'README.md': 'readme\n' });
  commit('m1', { 'app/calc.js': lines({ 3: 'a', 4: 'b', 5: 'c' }) });
  commit('m2', { 'app/calc.js': lines({ 3: 'a', 4: 'B', 5: 'c' }) });
  commit('m3', { 'README.md': 'readme, fixed\n' });
  commit('m4', { 'app/calc.js': lines({ 3: 'a', 4: 'B', 5: 'c', 9: 'nine' }) });
  commit('m5', { 'app/other.js': 'x\n' });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

// ── Fixture pull requests, in GraphQL's shape, every list whole ─────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL-shaped fixtures, read by known paths
type Node = Record<string, any>;
const at = (day: string, h = 12) => `2026-${day}T${String(h).padStart(2, '0')}:00:00Z`;
const file = (path: string, additions: number, deletions: number, changeType = 'MODIFIED') => ({ path, additions, deletions, changeType });
const issue = (number: number, labels: string[], author: object = HUMAN, body = 'the issue') => ({
  number, body, author, issueDependenciesSummary: { totalBlockedBy: 0 }, labels: labels.map((name) => ({ name })), timelineItems: [],
});
const xref = (number: number, repository: string, day: string) => ({
  __typename: 'CrossReferencedEvent', createdAt: at(day), actor: HUMAN, source: { __typename: 'Issue', number, repository: { nameWithOwner: repository } },
});
const pr = (number: number, o: Node): Node => ({
  number, state: 'MERGED', title: `feat: zebra-title-${number}`, body: 'zebra body',
  createdAt: at(o.created ?? '09-01', 1), updatedAt: at(o.day, 13), closedAt: at(o.day), mergedAt: at(o.day),
  author: HUMAN, mergedBy: HUMAN, mergeCommit: null,
  labels: [], files: [], commits: [{ commit: { oid: `head${number}`.padEnd(40, '0'), message: 'work', committedDate: at(o.created ?? '09-01', 2), author: { name: 'x', user: { login: HUMAN.login } }, committer: { name: 'x', user: null } } }],
  reviews: [], timelineItems: [], closingIssuesReferences: [],
  ...o.node,
});

const merge = (name: string, parent: string) => ({ oid: sha[name], parents: { nodes: [{ oid: sha[parent] }] } });

const fixtures = (): Node[] => [
  pr(1, { day: '09-02', node: {
    author: AUTHOR_APP, mergedBy: JUDGE_APP, mergeCommit: merge('m1', 'c0'), body: 'Implements it.\n\nCloses #20',
    labels: [{ name: 'review:please' }],
    files: [file('app/calc.js', 3, 3), file('app/util.js', 1, 0), file('docs/zebra-path.md', 1, 0)],
    reviews: [{ state: 'APPROVED', submittedAt: at('09-02', 10), body: 'ok', author: JUDGE_APP, commit: { oid: 'head1'.padEnd(40, '0') } }],
    timelineItems: [xref(10, REPO, '09-04'), xref(11, 'other/place', '09-06'),
      { __typename: 'LabeledEvent', createdAt: at('09-01', 3), actor: AUTHOR_APP, label: { name: 'review:please' } }],
    closingIssuesReferences: [issue(20, ['project:3'], AUTHOR_APP)],
  } }),
  pr(2, { day: '09-05', node: {
    title: 'fix: zebra-title-2', mergeCommit: merge('m2', 'm1'), files: [file('app/calc.js', 1, 1)],
    closingIssuesReferences: [issue(10, ['bug'])],
  } }),
  pr(3, { day: '09-06', node: { title: 'fix: zebra-title-3', mergeCommit: merge('m3', 'm2'), files: [file('README.md', 1, 1)] } }),
  pr(4, { day: '09-07', node: {
    title: 'fix: zebra-title-4', mergeCommit: merge('m4', 'm3'), files: [file('app/calc.js', 1, 1)],
    closingIssuesReferences: [issue(11, ['bug', 'follow-up', 'agent:reviewer'], JUDGE_APP)],
  } }),
  pr(5, { day: '09-08', node: {
    title: 'chore: zebra-title-5', author: DEPENDABOT, mergeCommit: merge('m5', 'm4'),
    files: [file('app/zebra-renamed.js', 300, 0, 'RENAMED')],
    commits: [{ commit: { oid: 'rev5'.padEnd(40, '0'), message: `Revert it\n\nThis reverts commit ${sha.m1}.`, committedDate: at('09-08', 1), author: { name: 'dependabot[bot]', user: null }, committer: { name: 'x', user: null } } }],
  } }),
  pr(6, { day: '09-09', node: { state: 'CLOSED', mergedAt: null, files: [file('app/calc.js', 2, 0)] } }),
  pr(7, { day: '09-10', node: { state: 'OPEN', closedAt: null, mergedAt: null, created: '09-10' } }),
  pr(8, { day: '08-20', created: '08-01', node: { updatedAt: at('08-21') } }),
  pr(9, { day: '08-19', created: '08-01', node: { updatedAt: at('08-19') } }),
  pr(10, { day: '08-18', created: '08-01', node: { updatedAt: at('08-18') } }),
];

// ── The fake GitHub ─────────────────────────────────────────────────────────────────────────

type Gh = { status: number; stdout: string; stderr: string };
const ok = (data: object, remaining = 4000) => ({ status: 0, stdout: JSON.stringify({ data: { ...data, rateLimit: { cost: 1, remaining, resetAt: '2026-10-07T13:00:00Z' } } }), stderr: '' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL-shaped fixtures
const conn = (all: any[], first: number, after: string | undefined, total?: number) => {
  const from = after ? Number(after.slice(1)) : 0;
  const nodes = all.slice(from, from + first);
  const end = from + nodes.length;
  return { totalCount: total ?? all.length, pageInfo: { hasNextPage: end < all.length, endCursor: `c${end}` }, nodes };
};
const shapeIssue = (i: Node, n: number) => ({ ...i, labels: conn(i.labels, n, undefined), timelineItems: conn(i.timelineItems, n, undefined) });
const shapePr = (p: Node, n: number) => ({
  ...p,
  labels: conn(p.labels, n, undefined),
  files: conn(p.files, n, undefined, p.filesTotal),
  commits: conn(p.commits, n, undefined),
  reviews: conn(p.reviews, n, undefined),
  timelineItems: conn(p.timelineItems, n, undefined),
  closingIssuesReferences: conn(p.closingIssuesReferences.map((i: Node) => shapeIssue(i, n)), Math.min(n, 25), undefined),
});

type FakeOpts = { prs?: Node[]; remaining?: number; failPage?: number; graphqlError?: boolean; slowDownOnce?: boolean; contents?: Record<string, string> };
const fakeGitHub = (opts: FakeOpts = {}) => {
  const prs = opts.prs ?? fixtures();
  const calls: string[][] = [];
  let slowed = false;
  const gh = async (args: string[]): Promise<Gh> => {
    calls.push(args);
    if (args[1] === 'user') return { status: 0, stdout: 'octo-secret-login\n', stderr: '' };
    if (args[1] === 'graphql') {
      if (opts.slowDownOnce && !slowed) { slowed = true; return { status: 1, stdout: '', stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)' }; }
      if (opts.graphqlError) return { status: 1, stdout: JSON.stringify({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }), stderr: 'gh: error' };
      const query = (args[args.indexOf('-f') + 1] ?? '').slice('query='.length);
      const vars: Record<string, string> = {};
      for (let i = 4; i < args.length; i += 2) { const [k, ...v] = (args[i + 1] ?? '').split('='); vars[k ?? ''] = v.join('='); }
      if (query.includes('DryRunList')) {
        const first = Number(/pullRequests\(first: (\d+)/.exec(query)?.[1]);
        const n = Number(/files\(first: (\d+)/.exec(query)?.[1]);
        const sorted = [...prs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((p) => shapePr(p, n));
        return ok({ repository: { pullRequests: conn(sorted, first, vars.after) } }, opts.remaining);
      }
      const m = /(pullRequest|issue)\(number: \$number\) \{ (\w+)\(first: (\d+)/.exec(query);
      const [, kind, field, first] = m ?? [];
      const number = Number(vars.number);
      if (opts.failPage === number) return { status: 1, stdout: '', stderr: 'gh: Something went wrong (HTTP 500)' };
      if (kind === 'pullRequest') {
        const p = prs.find((x) => x.number === number) as Node;
        const all = field === 'closingIssuesReferences' ? p[field].map((i: Node) => shapeIssue(i, Number(first))) : p[field as string];
        return ok({ repository: { pullRequest: { [field as string]: conn(all, Number(first), vars.after, field === 'files' ? p.filesTotal : undefined) } } });
      }
      const i = prs.flatMap((p) => p.closingIssuesReferences).find((x: Node) => x.number === number);
      return ok({ repository: { issue: { [field as string]: conn(i[field as string], Number(first), vars.after) } } });
    }
    const files = /pulls\/(\d+)\/files/.exec(args.join(' '));
    if (files) {
      const p = prs.find((x) => x.number === Number(files[1])) as Node;
      return { status: 0, stdout: JSON.stringify([p.files.map((f: Node) => ({ filename: f.path, ...(f.changeType === 'RENAMED' ? { previous_filename: 'app/zebra-old.js' } : {}) }))]), stderr: '' };
    }
    const contents = /contents\/(.+)$/.exec(args.at(-1) ?? '');
    if (contents) {
      const text = opts.contents?.[contents[1] as string];
      return text === undefined ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : { status: 0, stdout: text, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { gh, calls };
};

const run = async (argv: string[], github = fakeGitHub(), extra: object = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const sleeps: number[] = [];
  const status = await metrics(argv, {
    gh: github.gh, env: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l),
    release: () => 'v9.9.9', now: () => new Date('2026-10-07T12:00:00Z'),
    sleep: async (ms: number) => { sleeps.push(ms); },
    writeFile: (p: string, t: string) => { written[p] = t; },
    sizes: { prPage: 2, nestedPage: 2 },
    ...extra,
  });
  return { status, out: out.join('\n'), err: err.join('\n'), written, sleeps, calls: github.calls };
};
const dryRun = (...more: string[]) => ['dry-run', '--since', SINCE, ...more];
const json = (r: { out: string }) => JSON.parse(r.out);

// Every title, login and path in the fixtures: none may reach standard output.
const SECRETS = () => {
  const all = fixtures();
  return [
    ...all.map((p) => p.title as string),
    HUMAN.login, AUTHOR_APP.login, JUDGE_APP.login, DEPENDABOT.login,
    ...all.flatMap((p) => p.files.map((f: Node) => f.path as string)), 'app/zebra-old.js', 'zebra',
  ];
};

describe('kanon metrics dry-run: the counts', () => {
  it('reads the window, derives every row, and counts bands, areas, origins and actor classes', async () => {
    const r = await run(dryRun('--dir', dir, '--json'));
    expect(r.status).toBe(EXIT.ok);
    const doc = json(r);
    expect(doc).toMatchObject({ schema: SCHEMA, kanon: 'v9.9.9', status: 'ok', exitCode: 0, repo: REPO, window: { since: SINCE, until: null } });
    expect(doc.declarations).toEqual({ source: 'checkout', register: 'read', codeAreas: 'declared', escalationFile: 'default' });
    expect(doc.prs).toEqual({ read: 6, merged: 5, closedUnmerged: 1 });
    expect(doc.leftOut).toEqual({ open: 1, truncated: 0, unreadable: 0 });
    expect(doc.rows).toEqual({ valid: 6, invalid: 0, invalidFields: {} });
    expect(doc.bands).toEqual({ merged: { S: 4, M: 1, L: 0, XL: 0, none: 0 }, closedUnmerged: { S: 1, M: 0, L: 0, XL: 0, none: 0 } });
    expect(doc.areas).toEqual({ deps: 0, workflows: 0, migrations: 0, specs: 0, tests: 0, docs: 2, config: 0, code: 6 });
    expect(doc.escalation).toBeNull();
    expect(doc.origins).toMatchObject({ brief: 1, human: 3, reviewer_followup: 1, dependency_bot: 1, unknown: 0 });
    expect(doc.authors).toMatchObject({ implementer: 1, human: 4, other_bot: 1, unknown: 0 });
    expect(doc.mergedBy).toMatchObject({ merger: 1, human: 4, unknown: 0 });
  });

  it('prints the explicit and SZZ linked fixes side by side, and the reverts', async () => {
    const doc = json(await run(dryRun('--dir', dir, '--json')));
    expect(doc.linkedFixes).toEqual({ fixes: 3, explicit: 1, szz: 1, both: 1, explicitOnly: 0, szzOnly: 0, neither: 2, undetected: 2, nonCodeGap: 1 });
    expect(doc.reverts).toEqual({ reverting: 1, revertedItems: 1 });
    expect(doc.szz).toEqual({ status: 'ran', reason: null, blameFailures: 0 });
  });

  it('pages every nested list past its first page, and reads a rename\'s old path from REST', async () => {
    const r = await run(dryRun('--dir', dir, '--json'));
    const pages = r.calls.filter((c) => c[1] === 'graphql' && c.join(' ').includes('DryRunPage'));
    expect(pages.some((c) => c.join(' ').includes('files(first: 2'))).toBe(true);
    expect(pages.some((c) => c.join(' ').includes('timelineItems(first: 2'))).toBe(true);
    expect(r.calls.some((c) => c.join(' ').includes(`repos/${REPO}/pulls/5/files`))).toBe(true);
    expect(r.calls.filter((c) => c.join(' ').includes('/files?')).length).toBe(1);
  });

  it('stops listing at the first page that ends before --since, and never reads a PR closed before it', async () => {
    const r = await run(dryRun('--dir', dir, '--json'), fakeGitHub(), { sizes: { prPage: 3, nestedPage: 100 } });
    const lists = r.calls.filter((c) => c.join(' ').includes('DryRunList'));
    // Pages of 3, newest-updated first: 7 6 5 | 4 3 2 | 1 8 9 | 10. The third ends before --since.
    expect(lists.length).toBe(3);
    expect(json(r).prs.read).toBe(6);
  });

  it('honours --until, leaving out what closed on or after it', async () => {
    const doc = json(await run(dryRun('--until', '2026-09-06', '--dir', dir, '--json')));
    expect(doc.prs).toEqual({ read: 2, merged: 2, closedUnmerged: 0 });
    expect(doc.window).toEqual({ since: SINCE, until: '2026-09-06' });
  });

  it('prints the same result as prose, and the token line on standard error', async () => {
    const r = await run(dryRun('--dir', dir));
    expect(r.status).toBe(0);
    expect(r.out).toContain('Read: 6 (5 merged, 1 closed unmerged).');
    expect(r.out).toContain('Bands, merged: S 4, M 1, L 0, XL 0, none 0.');
    expect(r.out).toContain('Linked fixes, over 3 merged fix PRs: explicit 1, SZZ 1; both 1, explicit only 0, SZZ only 0, neither 2.');
    expect(r.out).toContain('of which 1 change no code-area file');
    expect(r.err).toContain('Using gh\'s stored login, which belongs to octo-secret-login.');
  });
});

describe('kanon metrics dry-run: one adapter feeds the detectors and the rows (kanon#527)', () => {
  it("doesn't link a fix whose bug issue only shares a number with another repository's cross-reference", async () => {
    // #4 closes bug #11 and shares app/calc.js with #1; the only cross-reference to #11 on #1 is
    // from other/place. Read as this repository, it would be a second explicit link.
    const d = await run(dryRun('--dir', dir, '--details', join(base, 'd.json')));
    const details = JSON.parse(Object.values(d.written)[0] as string);
    const fix4 = details.fixes.find((f: Node) => f.pr === 4);
    expect(fix4.explicit).toEqual([]);
    const fix2 = details.fixes.find((f: Node) => f.pr === 2);
    expect(fix2.explicit).toEqual([{ pr: 1, via: ['cross-reference'], days: 3 }]);
    expect(fix2.szz).toEqual([{ pr: 1, days: 3 }]);
  });

  it('puts the detectors\' links into the item\'s row', async () => {
    const d = await run(dryRun('--dir', dir, '--details', join(base, 'd.json')));
    const rows = JSON.parse(Object.values(d.written)[0] as string).rows;
    const item = rows.find((r: Node) => r.pr_number === 1);
    expect(item).toMatchObject({ fix_prs: '2', first_fix_days: 3, revert_pr: 5, revert_days: 6, band: 'S', origin: 'brief', author_kind: 'implementer', merged_by: 'merger' });
    expect(rows.find((r: Node) => r.pr_number === 6)).toMatchObject({ fate: 'closed_unmerged' });
  });
});

describe('kanon metrics dry-run: privacy', () => {
  it('prints no title, login or path from the pull requests, as prose or as JSON', async () => {
    for (const argv of [dryRun('--dir', dir), dryRun('--dir', dir, '--json'), dryRun('--repo', REPO, '--json')]) {
      const r = await run(argv);
      for (const s of SECRETS()) expect(r.out, `${argv.join(' ')}: ${s}`).not.toContain(s);
    }
  });

  it('writes the details file only when asked, outside the checkout, with rows and links and no path', async () => {
    expect(Object.keys((await run(dryRun('--dir', dir))).written)).toEqual([]);
    const target = join(base, 'ops', 'details.json');
    const r = await run(dryRun('--dir', dir, '--details', target));
    expect(Object.keys(r.written)).toEqual([target]);
    const text = r.written[target] as string;
    const details = JSON.parse(text);
    expect(details).toMatchObject({ schema: DETAILS_SCHEMA, repo: REPO, window: { since: SINCE, until: null } });
    expect(details.rows).toHaveLength(6);
    expect(details.leftOut).toEqual([{ pr: 7, reason: 'open' }]);
    expect(details.fixes.map((f: Node) => f.pr)).toEqual([2, 3, 4]);
    for (const p of ['app/calc.js', 'README.md', 'docs/zebra-path.md', HUMAN.login]) expect(text).not.toContain(p);
    expect(r.err).toContain('keep it private');
  });

  it('refuses a details file inside the checkout being measured, and writes nothing', async () => {
    const r = await run(dryRun('--dir', dir, '--json', '--details', join(dir, 'details.json')));
    expect(r.status).toBe(EXIT.error);
    expect(json(r).error).toMatch(/inside the checkout/);
    expect(r.written).toEqual({});
  });
});

describe('kanon metrics dry-run: a row that fails validation', () => {
  it('is counted by its field names only, and exits 1, ahead of an incomplete read', async () => {
    const prs = fixtures();
    (prs[1] as Node).closingIssuesReferences[0].issueDependenciesSummary.totalBlockedBy = -1;
    (prs[2] as Node).filesTotal = 3001;
    const r = await run(dryRun('--dir', dir, '--json'), fakeGitHub({ prs }));
    expect(r.status).toBe(EXIT.invalid);
    const doc = json(r);
    expect(doc).toMatchObject({ status: 'invalid-rows', exitCode: EXIT.invalid });
    expect(doc.rows).toEqual({ valid: 4, invalid: 1, invalidFields: { blocked_by_count: 1 } });
    expect(doc.leftOut.truncated).toBe(1);
    const prose = await run(dryRun('--dir', dir), fakeGitHub({ prs }));
    expect(prose.out).toContain('Rows: 4 valid, 1 failed validation (fields: blocked_by_count 1).');
  });
});

describe('kanon metrics dry-run: what it can\'t read is said, never dropped', () => {
  it('leaves out a PR whose list GitHub stops short of its total, as truncated, and exits incomplete', async () => {
    const prs = fixtures();
    (prs[1] as Node).filesTotal = 3001;
    const r = await run(dryRun('--dir', dir, '--json'), fakeGitHub({ prs }));
    expect(r.status).toBe(EXIT.incomplete);
    const doc = json(r);
    expect(doc.status).toBe('incomplete');
    expect(doc.leftOut).toEqual({ open: 1, truncated: 1, unreadable: 0 });
    expect(doc.prs.read).toBe(5);
  });

  it('leaves out a PR whose nested page fails, as unreadable', async () => {
    const r = await run(dryRun('--dir', dir, '--json'), fakeGitHub({ failPage: 1 }));
    expect(r.status).toBe(EXIT.incomplete);
    expect(json(r).leftOut).toEqual({ open: 1, truncated: 0, unreadable: 1 });
  });

  it('stops before the rate limit runs out, as an error document', async () => {
    const r = await run(dryRun('--dir', dir, '--json'), fakeGitHub({ remaining: RATE_FLOOR - 1 }));
    expect(r.status).toBe(EXIT.error);
    expect(json(r)).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: EXIT.error, error: expect.stringMatching(/GraphQL points left/) });
  });

  it('stops on a GraphQL error', async () => {
    const r = await run(dryRun('--repo', REPO, '--json'), fakeGitHub({ graphqlError: true }));
    expect(r.status).toBe(EXIT.error);
    expect(json(r).error).toMatch(/NOT_FOUND/);
  });

  it('waits and tries again when GitHub asks it to slow down', async () => {
    const r = await run(dryRun('--dir', dir, '--json'), fakeGitHub({ slowDownOnce: true }));
    expect(r.status).toBe(EXIT.ok);
    expect(r.sleeps).toEqual([30_000]);
  });

  it('reports SZZ as not run, with null counts, without a checkout, and reads the declarations from GitHub', async () => {
    const r = await run(dryRun('--repo', REPO, '--json'), fakeGitHub({ contents: { 'docs/qa/agent-identities.md': REGISTER, 'docs/qa/stack.md': STACK } }));
    const doc = json(r);
    expect(r.status).toBe(EXIT.ok);
    expect(doc.szz).toEqual({ status: 'not-run', reason: 'no checkout was given (--dir)', blameFailures: 0 });
    expect(doc.linkedFixes).toEqual({ fixes: 3, explicit: 1, szz: null, both: null, explicitOnly: null, szzOnly: null, neither: null, undetected: 2, nonCodeGap: 1 });
    expect(doc.declarations).toEqual({ source: 'github', register: 'read', codeAreas: 'declared', escalationFile: 'default' });
    expect(doc.authors).toMatchObject({ implementer: 1 });
  });

  it("reports SZZ as not run when the checkout lacks a fix's merge commit", async () => {
    const prs = fixtures();
    (prs[1] as Node).mergeCommit = { oid: 'f'.repeat(40), parents: { nodes: [{ oid: sha.m1 }] } };
    const doc = json(await run(dryRun('--dir', dir, '--json'), fakeGitHub({ prs })));
    expect(doc.szz.status).toBe('not-run');
    expect(doc.szz.reason).toMatch(/lacks a fix's merge commit/);
    expect(doc.linkedFixes.szz).toBeNull();
  });

  it('refuses a checkout of another repository', async () => {
    const r = await run(['dry-run', '--since', SINCE, '--repo', 'acme/other', '--dir', dir, '--json']);
    expect(r.status).toBe(EXIT.error);
    expect(json(r).error).toMatch(/not a checkout of acme\/other/);
  });
});

describe('kanon metrics: arguments', () => {
  it('requires --since, and a real date', () => {
    expect(() => parseArgs(['dry-run', '--repo', REPO])).toThrow('--since is required');
    expect(() => parseArgs(['dry-run', '--since', '2026-02-30', '--repo', REPO])).toThrow(/takes a date/);
    expect(() => parseArgs(['dry-run', '--since', SINCE, '--until', SINCE, '--repo', REPO])).toThrow(/after --since/);
    expect(() => parseArgs(['dry-run', '--since', SINCE])).toThrow(/--repo/);
    expect(() => parseArgs(['report'])).toThrow(/unknown subcommand/);
    expect(() => parseArgs(['dry-run', '--since', SINCE, '--dir', '--json'])).toThrow(/not the flag/);
  });

  it('prints the usage for --help, and an error document for --help with --json', async () => {
    const help = await run(['dry-run', '--help']);
    expect(help.status).toBe(0);
    expect(help.out).toMatch(/keep it private/);
    const both = await run(['dry-run', '--help', '--json']);
    expect(both.status).toBe(EXIT.usage);
    expect(json(both)).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: EXIT.usage });
  });
});

describe('diffRanges', () => {
  it('reads each file\'s old-side hunks, by its path after the change, a deleted file by its old one', () => {
    const diff = [
      'diff --git a/app/a.js b/app/a.js', '--- a/app/a.js', '+++ b/app/a.js', '@@ -4 +4 @@', '-x', '+y', '@@ -9,2 +8,0 @@',
      'diff --git a/old.js b/new.js', 'similarity index 90%', '--- a/old.js', '+++ b/new.js', '@@ -2,3 +2,1 @@',
      'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1,5 +0,0 @@',
      'diff --git a/added.js b/added.js', '--- /dev/null', '+++ b/added.js', '@@ -0,0 +1,3 @@',
    ].join('\n');
    expect(Object.fromEntries(diffRanges(diff))).toEqual({
      'app/a.js': [{ start: 4, count: 1 }, { start: 9, count: 2 }],
      'new.js': [{ start: 2, count: 3 }],
      'gone.js': [{ start: 1, count: 5 }],
      'added.js': [{ start: 0, count: 0 }],
    });
  });
});
