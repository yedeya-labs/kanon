import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SEARCH_READS, SEARCH_WAIT_MS, SearchUnsettled, settle, trustedSearch, trustedSearchSync,
} from '../../scripts/lib/search.mjs';

/**
 * kanon#1322: GitHub's search API can answer 0 for a query that has matches, so a search whose
 * answer decides an action or a stated number goes through `scripts/lib/search.mjs`, which reads
 * a doubtful answer again and refuses by name when the answers don't settle.
 *
 * THE GUARD. Every search Kanon's scripts, CLI and actions send is HELD: a line that names
 * `trustedSearch` (or `trustedSearchSync`) lies within five lines of it, or a comment at most three
 * lines above it says `search-zero:` and why its zero can't mislead (an empty answer only defers,
 * or the answer is settled where it is read). A search is a REST `search/…` path, a GraphQL
 * `search(type: …)` or `search(query: …)`, `gh search`, or `gh issue list` / `gh pr list` with
 * `--search`, which gh sends through search. The lanes' prompts are an agent's, not code, so they
 * are out of this guard: the prompts that act on a search's empty answer say to read it again.
 * A search that a REST or GraphQL listing can answer should use the listing instead.
 */

const SITE = /search\/(?:issues|commits|code|repositories|users|labels|topics)\b|\bsearch\s*\(\s*(?:type|query)\s*:|\bgh search\b|['"]search['"],\s*['"](?:issues|prs|commits)['"]|['"]--search['"]/;
const HELPER = /\btrustedSearch(?:Sync)?\b/;
const WAIVER = /search-zero:/;
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Searches another change is moving, each with the issue that holds it to this guard. The test
 * below fails once a file here has no unheld search left, so the entry goes with the fix.
 */
const PENDING: Record<string, string> = {};

type Site = { at: string; held: boolean };

/** Every search in one file, and whether each is held. */
export const searchSites = (file: string, text: string): Site[] => {
  const lines = text.split('\n');
  const near = (i: number, before: number, after: number, re: RegExp) =>
    lines.slice(Math.max(0, i - before), Math.min(lines.length, i + after + 1)).some((l) => re.test(l));
  return lines.flatMap((line, i) => {
    if (COMMENT.test(line) || !SITE.test(line)) return [];
    return [{ at: `${file}:${i + 1}`, held: near(i, 5, 5, HELPER) || near(i, 3, 0, WAIVER) }];
  });
};

const FILES = execFileSync('git', ['ls-files', 'scripts', 'cli', 'actions'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(?:mjs|cjs|js|ts)$/.test(f) && f !== 'scripts/lib/search.mjs');

describe('every search Kanon\'s scripts send is settled before it is trusted (kanon#1322)', () => {
  const sites = FILES.flatMap((f) => searchSites(f, readFileSync(f, 'utf8')));
  const fileOf = (s: Site) => s.at.replace(/:\d+$/, '');

  it('finds Kanon\'s searches, so the check below is not vacuous', () => {
    const files = new Set(sites.map(fileOf));
    for (const f of [
      'scripts/weekly-digest.mjs', 'scripts/actions-minutes.mjs', 'scripts/capability-interlock.mjs', 'scripts/promote.mjs',
      'scripts/telemetry/kanon-health.mjs', 'scripts/agent-quality-columns.mjs', 'scripts/lead-reconcile.mjs',
      'scripts/merge-gate.mjs', 'scripts/protocol-census.mjs', 'scripts/project-digest.mjs',
    ]) expect(files, f).toContain(f);
  });

  it('holds each one to the helper, or to a comment that says why its zero is safe', () => {
    expect(sites.filter((s) => !s.held && !(fileOf(s) in PENDING)).map((s) => s.at)).toEqual([]);
  });

  it('keeps a pending file only while it still sends an unheld search', () => {
    for (const f of Object.keys(PENDING)) {
      expect(sites.some((s) => fileOf(s) === f && !s.held), `${f} is settled now: take it out of PENDING`).toBe(true);
    }
  });
});

describe('the guard fails each unheld shape', () => {
  const unheld = (text: string) => searchSites('x.mjs', text).filter((s) => !s.held).length;
  it('a REST search, held by the helper beside it', () => {
    expect(unheld('const n = api(`search/issues?q=${q}`).total_count;')).toBe(1);
    expect(unheld('const n = trustedSearchSync(\n  () => api(`search/issues?q=${q}`),\n  { what: q },\n).total_count;')).toBe(0);
  });
  it('a GraphQL search, gh search, and a listing sent through search', () => {
    expect(unheld('const Q = `query { search(type: ISSUE, first: 1, query: $q) { issueCount } }`;')).toBe(1);
    expect(unheld('const Q = `query { search(query: $q, type: ISSUE) { issueCount } }`;')).toBe(1);
    expect(unheld("run(['search', 'issues', q]);")).toBe(1);
    expect(unheld("gh(['issue', 'list', '--search', q]);")).toBe(1);
    expect(unheld('run: gh search issues "x"')).toBe(1);
  });
  it('passes a search whose comment says why its zero is safe, and only within three lines', () => {
    expect(unheld("// search-zero: an empty answer only defers.\ngh(['pr', 'list', '--search', q]);")).toBe(0);
    expect(unheld("// search-zero: an empty answer only defers.\n\n\n\ngh(['pr', 'list', '--search', q]);")).toBe(1);
  });
  it('reads no comment as a search', () => {
    expect(unheld('// the `search/issues` endpoint\n * `gh pr list --search` too')).toBe(0);
  });
});

describe('settle: when a search answer is trusted', () => {
  const r = (size: number, partial = false) => ({ size, partial });
  const opts = { what: '`q`' };

  it('trusts a complete first answer that found something, at once', () => {
    expect(settle([r(2)], opts)).toBe(0);
  });
  it('reads a zero or an incomplete answer again', () => {
    expect(settle([r(0)], opts)).toBeNull();
    expect(settle([r(3, true)], opts)).toBeNull();
    expect(settle([r(0), r(2)], opts)).toBeNull();
  });
  it('after a doubtful answer, trusts a count two complete reads agree on', () => {
    expect(settle([r(0), r(2), r(2)], opts)).toBe(2);
    expect(settle([r(1, true), r(2), r(0), r(2)], opts)).toBe(3);
  });
  it('fails by name when two complete reads found different counts', () => {
    expect(() => settle([r(0), r(2), r(3)], opts)).toThrow(SearchUnsettled);
    expect(() => settle([r(0), r(2), r(3)], opts)).toThrow(/the search for `q` answered 0, 2, 3 on 3 reads: the counts disagree/);
  });
  it('trusts a zero only when every read found nothing and one was complete', () => {
    expect(settle([r(0), r(0), r(0), r(0)], opts)).toBe(3);
    expect(settle([r(0), r(0, true), r(0), r(0, true)], opts)).toBe(2);
  });
  it('fails by name when the reads are spent unsettled', () => {
    expect(() => settle([r(0), r(2), r(0), r(0)], opts)).toThrow(/answered 0, 2, 0, 0 on 4 reads, which don't settle/);
    expect(() => settle([r(0, true), r(0, true), r(0, true), r(0, true)], opts)).toThrow(/0 \(incomplete\)/);
    expect(() => settle([r(0), r(1, true), r(0), r(0)], opts)).toThrow(SearchUnsettled);
  });
  it('reads SEARCH_READS times before a zero is trusted', () => {
    expect(SEARCH_READS).toBe(4);
    expect(settle(Array.from({ length: SEARCH_READS - 1 }, () => r(0)), opts)).toBeNull();
  });
});

describe('trustedSearch and trustedSearchSync', () => {
  const saved = process.env.KANON_SEARCH_WAIT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.KANON_SEARCH_WAIT_MS;
    else process.env.KANON_SEARCH_WAIT_MS = saved;
  });
  /** A search that answers each of `answers` in turn. */
  const answering = <T,>(answers: T[]) => {
    let n = 0;
    return { read: (): T => answers[Math.min(n++, answers.length - 1)] as T, reads: () => n };
  };

  it('re-reads a spurious zero and returns the count, waiting a doubling time between reads', async () => {
    delete process.env.KANON_SEARCH_WAIT_MS;
    const s = answering([{ total_count: 0, incomplete_results: false }, { total_count: 2 }, { total_count: 2 }]);
    const waits: number[] = [];
    expect(trustedSearchSync(s.read, { what: 'q', sleep: (ms) => { waits.push(ms); } })).toEqual({ total_count: 2 });
    expect(s.reads()).toBe(3);
    expect(waits).toEqual([SEARCH_WAIT_MS, SEARCH_WAIT_MS * 2]);
  });
  it('the async reader settles the same way', async () => {
    const s = answering([{ total_count: 0 }, { total_count: 5 }, { total_count: 5 }]);
    await expect(trustedSearch(async () => s.read(), { what: 'q', sleep: async () => {} })).resolves.toEqual({ total_count: 5 });
    const t = answering([{ total_count: 0 }, { total_count: 1 }, { total_count: 4 }]);
    await expect(trustedSearch(async () => t.read(), { what: 'q', sleep: async () => {} })).rejects.toThrow(/counts disagree/);
  });
  it('sends one request when the first answer found something', () => {
    const s = answering([{ total_count: 7 }]);
    expect(trustedSearchSync(s.read, { what: 'q', sleep: () => {} }).total_count).toBe(7);
    expect(s.reads()).toBe(1);
  });
  it('reads an incomplete answer again even when it found something', () => {
    const s = answering([{ total_count: 1, incomplete_results: true }, { total_count: 3 }, { total_count: 3 }]);
    expect(trustedSearchSync(s.read, { what: 'q', sleep: () => {} }).total_count).toBe(3);
  });
  it('reads a list answer by its own size', () => {
    const s = answering<unknown[]>([[], [{ number: 1 }], [{ number: 1 }]]);
    expect(trustedSearchSync(s.read, { what: 'q', size: (a: unknown[]) => a.length, partial: () => false, sleep: () => {} })).toHaveLength(1);
  });
  it('refuses an answer that carries no count', () => {
    expect(() => trustedSearchSync(() => ({ message: 'rate limited' }), { what: '`q`', sleep: () => {} })).toThrow(/the search for `q` returned no count/);
  });
  it('takes its first wait from KANON_SEARCH_WAIT_MS', () => {
    process.env.KANON_SEARCH_WAIT_MS = '7';
    const waits: number[] = [];
    trustedSearchSync(answering([{ total_count: 0 }]).read, { what: 'q', sleep: (ms) => { waits.push(ms); } });
    expect(waits).toEqual([7, 14, 28]);
  });
});
