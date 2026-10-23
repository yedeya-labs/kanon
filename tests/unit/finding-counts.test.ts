import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { count, findingRules, isReviewers, parseArgs, parsePage, renderTable, tally, weekOf } from '../../scripts/finding-counts.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { writeStub } from './helpers/stub-bin.js';

/**
 * `K-SELF-14`: a review finding's class is the rule id it cites, and `scripts/finding-counts.mjs`
 * counts the Reviewer's findings and follow-ups per rule id over a window, so a gate's rule has a
 * baseline before the gate is switched on and a count after.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const REVIEWER = '**Reviewer** <!-- kanon:role=reviewer -->';
const MERGER = '**Merger** <!-- kanon:role=merger -->';
const bot = { login: 'judge[bot]', type: 'Bot' };

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('what in a review is a finding (K-SELF-14)', () => {
  it('reads the ids of the findings and of the text before the first heading, each once, and none from a section that reports what holds', () => {
    const body = [
      REVIEWER,
      '',
      '**Verdict: request changes.** The body is false (`K-SHIP-3`).',
      '',
      '## What I checked',
      '- The sign-off is a human\'s (`K-AGENT-44`).',
      '### Security',
      '- The token is read-only (`K-AGENT-46`).',
      '## Findings',
      '**1. A neighbour the edit made false (`K-AGENT-20`). Blocking.**',
      '**2. The same again (`K-AGENT-20`), and a missing mutation (`K-PRIN-11`).**',
      '### Fold in',
      '- Small (`K-WORK-17`).',
      '## Checked, no finding',
      '- `K-MERGE-17` holds.',
    ].join('\n');
    expect(findingRules(body)).toEqual(['K-SHIP-3', 'K-AGENT-20', 'K-PRIN-11', 'K-WORK-17']);
  });

  it('leaves out a restated prior finding and what was filed, and picks the findings up again at the next heading of the same level', () => {
    const body = [
      REVIEWER,
      'Incremental re-review.',
      '## Prior findings',
      '**1. Addressed (`K-AGENT-20`).**',
      '### Not addressed',
      '- Still open (`K-WORK-17`).',
      '## New in this round',
      '**2. A new one (`K-WORK-18`).**',
      '## Filed',
      '- #12, a follow-up (`K-WORK-9`).',
      '## Follow-ups',
      '- #13 (`K-WORK-15`).',
      '## Verified',
      '- CI is green (`K-AGENT-24`).',
    ].join('\n');
    expect(findingRules(body)).toEqual(['K-WORK-18']);
  });

  it('skips a section only by the words its heading starts with, so a finding whose title contains a skip word still counts', () => {
    const body = [
      REVIEWER,
      '**Verdict: request changes.**',
      '## Blocking: the red checks',
      '- The suite is red (`K-AGENT-20`).',
      '## Findings',
      '### 1. `ci.yml`\'s guard is fail-open (`K-MERGE-8`)',
      '- It passes on a skipped job.',
      '### 2. The guard holds nothing on a fork (`K-PRIN-8`)',
      '- A fork has no secrets.',
      '### 3) Verified only by hand (`K-PRIN-11`)',
      '## Finding: a checklist nobody reads (`K-WORK-3`)',
      '## Checklist drift (`K-WORK-4`)',
      '## `ci.yml` runs on a fork (`K-AGENT-46`)',
      '## **What I checked**',
      '- The sign-off (`K-AGENT-44`).',
      '## CI',
      '- Green (`K-AGENT-24`).',
      '## `CI`: green',
      '- Still green (`K-AGENT-25`).',
      '## Notes (no action needed)',
      '- A spawn could be a call (`K-WORK-17`).',
    ].join('\n');
    expect(findingRules(body)).toEqual(['K-AGENT-20', 'K-MERGE-8', 'K-PRIN-8', 'K-PRIN-11', 'K-WORK-3', 'K-WORK-4', 'K-AGENT-46']);
  });
});

describe('whose review counts (K-SELF-14)', () => {
  it('counts a bot\'s review whose first marker is the Reviewer\'s, and a review by a login named for the history before the marker', () => {
    expect(isReviewers({ user: bot, body: REVIEWER }, [])).toBe(true);
    expect(isReviewers({ user: bot, body: `${MERGER}\n> ${REVIEWER}` }, [])).toBe(false);
    expect(isReviewers({ user: { login: 'someone', type: 'User' }, body: REVIEWER }, [])).toBe(false);
    expect(isReviewers({ user: { login: 'old-reviewer[bot]', type: 'Bot' }, body: 'no marker' }, [])).toBe(false);
    expect(isReviewers({ user: { login: 'old-reviewer[bot]', type: 'Bot' }, body: 'no marker' }, ['old-reviewer[bot]'])).toBe(true);
  });
});

describe('the tally (K-SELF-14)', () => {
  const review = (body: string) => ({ user: bot, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-14T10:00:00Z', body: `${REVIEWER}\n${body}` });

  it('counts each review once per id, each pull request once, and each follow-up once per id it cites', () => {
    const rows = tally({
      reviews: [
        { pr: 1, review: review('`K-AGENT-20` and `K-AGENT-20` again, and `K-WORK-17`') },
        { pr: 1, review: review('`K-AGENT-20`') },
        { pr: 2, review: review('`K-AGENT-20`') },
      ],
      followUps: [
        { number: 9, created_at: '2026-10-14T00:00:00Z', body: 'Surfaced by PR #1 review. `K-WORK-17`, `K-WORK-17`.' },
        { number: 10, created_at: '2026-10-14T00:00:00Z', body: 'Surfaced by PR #2 review. `K-PRIN-4`.' },
      ],
    });
    expect(rows).toEqual([
      { rule: 'K-AGENT-20', findings: 3, pullRequests: 2, followUps: 0 },
      { rule: 'K-WORK-17', findings: 1, pullRequests: 1, followUps: 1 },
      { rule: 'K-PRIN-4', findings: 0, pullRequests: 0, followUps: 1 },
    ]);
  });

  it('with named rules, lists exactly those, in that order, a zero included', () => {
    const rows = tally({ reviews: [{ pr: 1, review: review('`K-AGENT-20`') }], followUps: [], rules: ['K-SPEC-2', 'K-AGENT-20'] });
    expect(rows).toEqual([
      { rule: 'K-SPEC-2', findings: 0, pullRequests: 0, followUps: 0 },
      { rule: 'K-AGENT-20', findings: 1, pullRequests: 1, followUps: 0 },
    ]);
  });

  it('puts a date in the week that starts on its Monday, UTC', () => {
    expect(weekOf('2026-10-19T00:00:00Z')).toBe('2026-10-19');
    expect(weekOf('2026-10-25T23:59:59Z')).toBe('2026-10-19');
    expect(weekOf('2026-10-18T23:59:59Z')).toBe('2026-10-12');
  });
});

/** The pull requests, their reviews and the follow-ups a fake `gh api` answers from. */
const FIXTURE = {
  // Newest update first, as the listing sorts them: #3 is older than the window, so the read stops there.
  pulls: [
    { number: 5, updated_at: '2026-10-20T12:00:00Z' },
    { number: 4, updated_at: '2026-10-15T12:00:00Z' },
    { number: 3, updated_at: '2026-10-01T12:00:00Z' },
  ],
  reviews: {
    5: [
      { user: bot, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-20T11:00:00Z', body: `${REVIEWER}\n**1.** \`K-PRIN-4\`` },
      // Approvals and the Merger's reviews are no findings.
      { user: bot, state: 'APPROVED', submitted_at: '2026-10-20T11:30:00Z', body: `${REVIEWER}\n\`K-PRIN-4\`` },
      { user: bot, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-20T11:40:00Z', body: `${MERGER}\n\`K-PRIN-4\`` },
      // Submitted at the window's end, which it excludes.
      { user: bot, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-21T00:00:00Z', body: `${REVIEWER}\n\`K-PRIN-4\`` },
    ],
    4: [
      // Submitted at the window's start, which it includes.
      { user: bot, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-14T00:00:00Z', body: `${REVIEWER}\n\`K-PRIN-4\` and \`K-WORK-5\`` },
    ],
    3: [{ user: bot, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-01T10:00:00Z', body: `${REVIEWER}\n\`K-WORK-5\`` }],
  } as Record<number, unknown[]>,
  issues: [
    { number: 20, created_at: '2026-10-16T00:00:00Z', labels: [{ name: 'follow-up' }, { name: 'agent:reviewer' }], body: '`K-PRIN-4`' },
    // Updated in the window, so listed, but created before it.
    { number: 21, created_at: '2026-10-10T00:00:00Z', labels: [{ name: 'follow-up' }, { name: 'agent:reviewer' }], body: '`K-PRIN-4`' },
    // A pull request, which the issues listing includes.
    { number: 22, created_at: '2026-10-16T00:00:00Z', labels: [{ name: 'follow-up' }, { name: 'agent:reviewer' }], body: '`K-PRIN-4`', pull_request: {} },
    // Not the Reviewer's follow-up.
    { number: 23, created_at: '2026-10-16T00:00:00Z', labels: [{ name: 'follow-up' }], body: '`K-PRIN-4`' },
  ],
};

/** What `gh api --include` prints: the status line, the headers, a blank line and the page. */
const http = (items: unknown, next?: string) =>
  `HTTP/2.0 200 OK\n${next ? `Link: <${next}>; rel="next"\r\n` : ''}Content-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(items)}`;

const ISSUES = 'repos/o/r/issues?labels=follow-up,agent:reviewer&state=all&since=2026-10-14T00:00:00Z&per_page=100&page=1';
/** A next page's URL as GitHub's Link header gives it for the issues listing: absolute, with a cursor. */
const ISSUES_2 = 'https://api.github.com/repositories/1/issues?labels=follow-up%2Cagent%3Areviewer&state=all&per_page=100&page=2&after=Y3Vyc29y';

/** The `-f`/`-F` fields of a `gh api graphql` call, by name, the query included. */
const fields = (args: string[]) => {
  const out: Record<string, string> = {};
  for (let i = 2; i < args.length; i += 2) {
    const [k = '', ...v] = (args[i + 1] ?? '').split('=');
    out[`${args[i] === '-F' ? '#' : ''}${k}`] = v.join('=');
  }
  return out;
};

/** GraphQL's answers over FIXTURE: the pull requests and each one's reviews counted, the issues by label. */
const gqlFixture = (f: Record<string, string>): unknown => {
  const query = f.query ?? '';
  if (query.includes('pullRequests{totalCount}')) return { data: { repository: { pullRequests: { totalCount: FIXTURE.pulls.length } } } };
  if (query.includes('reviews{totalCount}')) return { data: { repository: { pullRequest: { reviews: { totalCount: (FIXTURE.reviews[Number(f['#number'])] ?? []).length } } } } };
  if (query.includes('issues(')) {
    const nodes = FIXTURE.issues.filter((i) => !i.pull_request && i.labels.some((l) => l.name === f.label)).map((i) => ({ labels: { nodes: i.labels } }));
    return { data: { repository: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } };
  }
  throw new Error(`unexpected query ${query}`);
};

/**
 * A fake `gh api --include` over FIXTURE, one page of each listing and no next page, recording
 * what it was asked. `answer` may answer a path first, with the page `gh` prints; `gql` may
 * answer a `gh api graphql` call first, given its fields.
 */
const fakeGh = (
  answer: (path: string, read: number) => string | undefined = () => undefined,
  gql: (f: Record<string, string>) => unknown = () => undefined,
) => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const queries: Array<Record<string, string>> = [];
  const gh = (args: string[]): string => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      const f = fields(args);
      queries.push(f);
      return JSON.stringify(gql(f) ?? gqlFixture(f));
    }
    if (args[0] !== 'api' || args[1] !== '--include') throw new Error(`unexpected gh ${args.join(' ')}`);
    const path = args[2] ?? '';
    calls.push(path);
    const own = answer(path, calls.filter((c) => c === path).length);
    if (own !== undefined) return own;
    if (/^repos\/o\/r\/pulls\?/.test(path)) return http(FIXTURE.pulls);
    const rv = /^repos\/o\/r\/pulls\/(\d+)\/reviews\?/.exec(path);
    if (rv) return http(FIXTURE.reviews[Number(rv[1])] ?? []);
    if (path === ISSUES) return http(FIXTURE.issues);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const sleep = (ms: number) => { sleeps.push(ms); };
  return { gh, sleep, calls, sleeps, queries };
};

/** A second follow-up in the window, which only a next page of the issues listing holds. */
const LATER = { number: 30, created_at: '2026-10-17T00:00:00Z', labels: [{ name: 'follow-up' }, { name: 'agent:reviewer' }], body: '`K-WORK-5`' };

describe('counting a repository\'s window (K-SELF-14)', () => {
  it('counts the Reviewer\'s request-changes reviews and follow-ups in [since, until), and reads no pull request older than the window', () => {
    const { gh, sleep, calls, sleeps, queries } = fakeGh();
    const r = count({ repo: 'o/r', gh, sleep, since: '2026-10-14', until: '2026-10-21' });
    expect(queries).toEqual([]);
    expect(r).toMatchObject({ since: '2026-10-14', until: '2026-10-21', reviews: 2, followUpIssues: 1 });
    expect(r.rows).toEqual([
      { rule: 'K-PRIN-4', findings: 2, pullRequests: 2, followUps: 1 },
      { rule: 'K-WORK-5', findings: 1, pullRequests: 1, followUps: 0 },
    ]);
    expect(calls).not.toContain('repos/o/r/pulls/3/reviews?per_page=100&page=1');
    expect(calls).toContain(ISSUES);
    // No page named a next one, so none was read, and no page came back empty.
    expect(calls.filter((c) => c.includes('page=2'))).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(r.weeks).toEqual([
      { week: '2026-10-12', rows: [{ rule: 'K-PRIN-4', findings: 1, pullRequests: 1, followUps: 1 }, { rule: 'K-WORK-5', findings: 1, pullRequests: 1, followUps: 0 }] },
      { week: '2026-10-19', rows: [{ rule: 'K-PRIN-4', findings: 1, pullRequests: 1, followUps: 0 }] },
    ]);
  });

  it('prints a table a person or an audit issue can read', () => {
    const { gh, sleep } = fakeGh();
    const table = renderTable(count({ repo: 'o/r', gh, sleep, since: '2026-10-14', until: '2026-10-21', rules: ['K-PRIN-4', 'K-SPEC-2'] }));
    expect(table).toContain('| Rule | Findings | Pull requests | Follow-ups |');
    expect(table).toContain('| `K-PRIN-4` | 2 | 2 | 1 |');
    expect(table).toContain('| `K-SPEC-2` | 0 | 0 | 0 |');
  });
});

describe('where a listing ends, and an empty page (K-SELF-14)', () => {
  const window = { repo: 'o/r', since: '2026-10-14', until: '2026-10-21' };

  it('reads what `gh api --include` prints: the page, and the next page the Link header names', () => {
    const head = [
      'HTTP/2.0 200 OK',
      'Content-Type: application/json; charset=utf-8',
      `Link: <https://api.github.com/x?page=1&before=a>; rel="prev", <${ISSUES_2}>; rel="next"`,
      'X-Github-Request-Id: 203C',
    ].join('\r\n');
    expect(parsePage(`${head}\r\n\r\n[{"number":1}]`)).toEqual({ items: [{ number: 1 }], next: ISSUES_2 });
    expect(parsePage('HTTP/2.0 200 OK\nlink: <https://api.github.com/x?page=1>; rel="prev"\r\n\r\n[]')).toEqual({ items: [], next: null });
    expect(() => parsePage('[]')).toThrow(/HTTP/);
    expect(() => parsePage('HTTP/2.0 200 OK\r\n\r\n{"message":"x"}')).toThrow(/not a list/);
  });

  it('follows the next page the Link header names, however short the page before it', () => {
    const { gh, sleep, calls } = fakeGh((path) => {
      if (path === ISSUES) return http(FIXTURE.issues, ISSUES_2);
      if (path === ISSUES_2) return http([LATER]);
      return undefined;
    });
    const r = count({ ...window, gh, sleep });
    expect(calls).toContain(ISSUES_2);
    expect(r.followUpIssues).toBe(2);
    expect(r.rows).toContainEqual({ rule: 'K-WORK-5', findings: 1, pullRequests: 1, followUps: 1 });
  });

  it('retries an empty first page, and counts the listing a later read returns, rather than end the listing on it', () => {
    // GitHub answered the follow-ups listing `[]` on about one read in three (#1288).
    const { gh, sleep, calls, sleeps } = fakeGh((path, read) => (path === ISSUES && read === 1 ? http([]) : undefined));
    const r = count({ ...window, gh, sleep });
    expect(calls.filter((c) => c === ISSUES)).toHaveLength(2);
    expect(sleeps).toEqual([200]);
    expect(r.followUpIssues).toBe(1);
    expect(r.rows).toContainEqual({ rule: 'K-PRIN-4', findings: 2, pullRequests: 2, followUps: 1 });
  });

  it('retries a named next page that comes back empty, and counts it when a later read returns it', () => {
    const { gh, sleep, sleeps } = fakeGh((path, read) => {
      if (path === ISSUES) return http(FIXTURE.issues, ISSUES_2);
      if (path === ISSUES_2) return read <= 2 ? http([]) : http([LATER]);
      return undefined;
    });
    expect(count({ ...window, gh, sleep }).followUpIssues).toBe(2);
    expect(sleeps).toEqual([200, 400]);
  });

  it('fails, naming the page, when a named next page stays empty on every read, rather than print a low count', () => {
    const { gh, sleep, calls, sleeps } = fakeGh((path) => {
      if (path === ISSUES) return http(FIXTURE.issues, ISSUES_2);
      if (path === ISSUES_2) return http([]);
      return undefined;
    });
    expect(() => count({ ...window, gh, sleep })).toThrow(`${ISSUES_2} came back empty on each of 5 reads, though the page before it named it as the next one`);
    expect(calls.filter((c) => c === ISSUES_2)).toHaveLength(5);
    expect(sleeps).toEqual([200, 400, 800, 1600]);
  });

  it('takes a first page that is empty on every read as an empty listing only when GraphQL counts it empty too, such as a pull request with no reviews', () => {
    const NONE = 'repos/o/r/pulls/4/reviews?per_page=100&page=1';
    const { gh, sleep, calls, sleeps, queries } = fakeGh(
      (path) => (path === NONE ? http([]) : undefined),
      (f) => (f['#number'] === '4' ? { data: { repository: { pullRequest: { reviews: { totalCount: 0 } } } } } : undefined),
    );
    const r = count({ ...window, gh, sleep });
    expect(calls.filter((c) => c === NONE)).toHaveLength(5);
    expect(sleeps).toEqual([200, 400, 800, 1600]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ owner: 'o', name: 'r', '#number': '4' });
    expect(r.reviews).toBe(1);
  });

  it('asks GraphQL only about a first page that stays empty, never about one a read returns', () => {
    const { gh, sleep, queries } = fakeGh((path, read) => (path === ISSUES && read === 1 ? http([]) : undefined));
    count({ ...window, gh, sleep });
    expect(queries).toEqual([]);
  });

  it('fails, naming the page, when a first page stays empty on every read but GraphQL counts reviews on it (#1323)', () => {
    const SOME = 'repos/o/r/pulls/4/reviews?per_page=100&page=1';
    const { gh, sleep } = fakeGh((path) => (path === SOME ? http([]) : undefined));
    expect(() => count({ ...window, gh, sleep })).toThrow(`${SOME} came back empty on each of 5 reads, but GitHub's GraphQL API counts 1 in that listing`);
  });

  it('fails when the follow-ups listing stays empty but GraphQL finds an issue with both labels, and not for one with a single label (#1323)', () => {
    // The incident's listing (#1288): its first page answered `[]` where there were follow-ups.
    const empty = (path: string) => (path === ISSUES ? http([]) : undefined);
    const full = fakeGh(empty);
    expect(() => count({ ...window, gh: full.gh, sleep: full.sleep })).toThrow(`${ISSUES} came back empty on each of 5 reads, but GitHub's GraphQL API counts 2 in that listing`);
    expect(full.queries.at(-1)).toMatchObject({ label: 'agent:reviewer', since: '2026-10-14T00:00:00Z' });
    // An issue labelled `agent:reviewer` alone, on a second GraphQL page: GraphQL's label filter
    // matches any label, the REST listing all of them, so it is no follow-up and the listing is empty.
    const pagesSeen: Array<string | undefined> = [];
    const single = fakeGh(empty, (f) => {
      if (!(f.query ?? '').includes('issues(')) return undefined;
      pagesSeen.push(f.after);
      return f.after === 'c1'
        ? { data: { repository: { issues: { nodes: [{ labels: { nodes: [{ name: 'agent:reviewer' }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } }
        : { data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } } };
    });
    expect(count({ ...window, gh: single.gh, sleep: single.sleep }).followUpIssues).toBe(0);
    expect(pagesSeen).toEqual([undefined, 'c1']);
  });

  it('fails when GraphQL gives no count for a first page that stays empty, rather than take the listing as empty (#1323)', () => {
    const PULLS = 'repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1';
    // An error beside a count that looks whole: the count isn't trusted.
    const { gh, sleep } = fakeGh(
      (path) => (path === PULLS ? http([]) : undefined),
      () => ({ data: { repository: { pullRequests: { totalCount: 0 } } }, errors: [{ message: 'Something went wrong' }] }),
    );
    expect(() => count({ ...window, gh, sleep })).toThrow(/GraphQL API answered .*Something went wrong/);
    const blank = fakeGh((path) => (path === PULLS ? http([]) : undefined), () => ({ data: { repository: {} } }));
    expect(() => count({ ...window, gh: blank.gh, sleep: blank.sleep })).toThrow(`${PULLS} came back empty on each of 5 reads, and GitHub's GraphQL API gave no count`);
  });
});

describe('the arguments (K-SELF-14)', () => {
  it('defaults to the seven days before today, and refuses a malformed date, rule id, or an empty window', () => {
    expect(parseArgs([], '2026-10-21')).toEqual({ since: '2026-10-14', until: '2026-10-21', rules: null, logins: [], json: false });
    expect(parseArgs(['--since', '2026-09-30', '--until', '2026-10-21', '--rules', 'K-PRIN-4,K-MERGE-13', '--reviewer', 'a[bot]', '--json'], '2026-10-22'))
      .toEqual({ since: '2026-09-30', until: '2026-10-21', rules: ['K-PRIN-4', 'K-MERGE-13'], logins: ['a[bot]'], json: true });
    expect(parseArgs(['--since', '2026-10-1'], '2026-10-21')).toHaveProperty('error');
    expect(parseArgs(['--rules', 'PRIN-4'], '2026-10-21')).toHaveProperty('error');
    expect(parseArgs(['--since', '2026-10-21'], '2026-10-21')).toHaveProperty('error');
    expect(parseArgs(['--bogus'], '2026-10-21')).toHaveProperty('error');
  });
});

describe('the command, against fixtures through a stub `gh` (K-SELF-14)', SPAWNS, () => {
  // Each `gh api --include <path>` answers from the fixture file named for its path, and an empty
  // page where there is none. A path with an `.empty-once` file beside its own answers `[]` once.
  const dir = mkdtempSync(join(tmpdir(), 'finding-counts-'));
  dirs.push(dir);
  const name = (path: string) => path.replace(/[^A-Za-z0-9]/g, '_');
  const put = (path: string, value: unknown, next?: string) => writeFileSync(join(dir, `${name(path)}.http`), http(value, next));
  put('repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1', FIXTURE.pulls);
  for (const n of [5, 4, 3]) put(`repos/o/r/pulls/${n}/reviews?per_page=100&page=1`, FIXTURE.reviews[n]);
  put(ISSUES, FIXTURE.issues);
  writeFileSync(join(dir, `${name(ISSUES)}.empty-once`), '');
  // A repository whose pull request listing names a next page that stays empty.
  put('repos/o/x/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1', FIXTURE.pulls.slice(0, 1), 'https://api.github.com/repositories/2/pulls?state=all&page=2');
  const bin = join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  // GraphQL counts 3 pull requests wherever it is asked, so an empty first page of the pull
  // request listing disagrees with it.
  writeStub(join(bin, 'gh'), `#!/usr/bin/env bash
f="${dir}/$(printf %s "$3" | tr -c 'A-Za-z0-9' '_')"
if [ "$2" = graphql ]; then printf '{"data":{"repository":{"pullRequests":{"totalCount":3}}}}'
elif [ -f "$f.empty-once" ]; then rm "$f.empty-once"; printf 'HTTP/2.0 200 OK\\r\\n\\r\\n[]'
elif [ -f "$f.http" ]; then cat "$f.http"; else printf 'HTTP/2.0 200 OK\\r\\n\\r\\n[]'; fi
`);
  const run = (repo: string, ...args: string[]) => spawnSync('node', [join(ROOT, 'scripts', 'finding-counts.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: repo },
  });

  it('prints the counts as JSON and as a table, the follow-up an empty first read hid included, and exits 2 on a usage error', () => {
    const json = run('o/r', '--since', '2026-10-14', '--until', '2026-10-21', '--json');
    expect(json.stderr).toBe('');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).followUpIssues).toBe(1);
    expect(JSON.parse(json.stdout).rows).toEqual([
      { rule: 'K-PRIN-4', findings: 2, pullRequests: 2, followUps: 1 },
      { rule: 'K-WORK-5', findings: 1, pullRequests: 1, followUps: 0 },
    ]);
    const table = run('o/r', '--since', '2026-10-14', '--until', '2026-10-21');
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('| `K-WORK-5` | 1 | 1 | 0 |');
    const bad = run('o/r', '--since', 'yesterday');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--since takes a date');
  });

  it('exits 1, naming the page, and prints no count when a named next page stays empty', () => {
    const r = run('o/x', '--since', '2026-10-14', '--until', '2026-10-21');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('finding-counts: https://api.github.com/repositories/2/pulls?state=all&page=2 came back empty on each of 5 reads');
  });

  it('exits 1 and prints no count when a first page stays empty but GraphQL counts the listing (#1323)', () => {
    const r = run('o/y', '--since', '2026-10-14', '--until', '2026-10-21');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("finding-counts: repos/o/y/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1 came back empty on each of 5 reads, but GitHub's GraphQL API counts 3 in that listing");
  });
});
