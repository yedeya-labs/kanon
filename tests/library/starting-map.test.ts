import { describe, expect, it } from 'vitest';
import {
  COMMENT_BUDGET,
  MAX_BASENAME_MATCHES,
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  build,
  clauseBlock,
  lookupClauses,
  shownComments,
  pathMentions,
  resolvePaths,
  specIds,
} from '../../scripts/starting-map.mjs';

/**
 * RA-2456 part 2 — the implementer's pre-computed starting map.
 *
 * Two ways it goes wrong silently: the map is written but the prompt never points at it
 * (the step costs a minute and saves nothing), or a failed read produces an EMPTY section
 * the agent then trusts as "the issue named nothing". Both are asserted here, alongside
 * the parsing itself.
 *
 * KANON'S HALF (plan 0001, step 3). The implement lane's prompt is held in
 * `tests/unit/implement-lane.test.ts`; the reference adopter keeps the half about its
 * project-setup hook, which writes the map, and its telemetry cutover record.
 */

const clause = (id: string, file = 'payments.md', line = 10) => ({ id, file, line, raw: `- \`[${id}]\` \`[seed]\` **the ${id} rule.**` });

describe('what the map extracts', () => {
  it('finds each registered clause id once, in first-seen order, and ignores unregistered notation', () => {
    expect(specIds('see [PAY-12] and [STORE-22], then [PAY-12] again; [F-1] is a flag')).toEqual(['PAY-12', 'STORE-22']);
  });

  it('returns the declaration of a cited clause, and names the ids no spec declares', () => {
    const { found, missing } = lookupClauses(['PAY-12', 'PAY-999'], [clause('PAY-12', 'payments.md', 91)]);
    expect(found).toEqual([{ id: 'PAY-12', where: 'docs/qa/specs/payments.md:91', text: clause('PAY-12').raw }]);
    expect(missing).toEqual(['PAY-999']);
  });

  it('carries a clause\'s indented continuation, and stops at a blank line, a sibling or the next declaration', () => {
    const lines = [
      '- `[PAY-1]` `[seed]` **Headline.**',
      '  - sub-condition one',
      '    - nested detail',
      '  - `[PAY-2]` `[seed]` a nested declaration is its own clause',
      '- a sibling bullet',
    ];
    expect(clauseBlock(lines, 1)).toBe(lines.slice(0, 3).join('\n'));
    expect(clauseBlock(['- `[PAY-1]` `[seed]` **H.**', '  - one', '', '  - after a blank'], 1)).toBe('- `[PAY-1]` `[seed]` **H.**\n  - one');
    const { found } = lookupClauses(['PAY-1'], [clause('PAY-1', 'payments.md', 1)], () => lines);
    expect(found[0].text).toContain('nested detail');
  });

  it('reads path mentions without their line suffix, prose brackets or a URL host', () => {
    const text = [
      'the page (`src/app/page.tsx:52-61`) and (see src/lib/seo.ts)',
      'a route group src/app/(portal)/[slug]/page.tsx',
      './scripts/qa/x.mjs and https://github.com/o/r/blob/main/docs/a.md',
      'the alias @/server/kiosk.ts and ../lib/y.ts',
    ].join('\n');
    expect(pathMentions(text)).toEqual([
      'src/app/page.tsx',
      'src/lib/seo.ts',
      'src/app/(portal)/[slug]/page.tsx',
      'scripts/qa/x.mjs',
      'src/server/kiosk.ts',
      'lib/y.ts',
    ]);
  });

  it('resolves exact, suffix and bare names, drops a bare duplicate, and does not list an ambiguous name', () => {
    const tracked = ['src/app/robots.ts', 'docs/qa/specs/payments.md', ...Array.from({ length: MAX_BASENAME_MATCHES + 1 }, (_, i) => `src/app/r${i}/page.tsx`)];
    const got = resolvePaths(['src/app/robots.ts', 'robots.ts', 'specs/payments.md', 'page.tsx', 'src/new-thing.ts', 'Next.js'], tracked);
    expect(got.resolved).toEqual([
      { named: 'src/app/robots.ts', files: ['src/app/robots.ts'] },
      { named: 'specs/payments.md', files: ['docs/qa/specs/payments.md'] },
    ]);
    expect(got.ambiguous).toEqual([{ named: 'page.tsx', count: MAX_BASENAME_MATCHES + 1 }]);
    // A new file is named with its directory; an unresolved bare word is prose.
    expect(got.unresolved).toEqual(['src/new-thing.ts']);
  });

  it('keeps a bare name whose longer twin does not resolve, so the file that exists is still found', () => {
    const got = resolvePaths(['src/app/legacy/robots.ts', 'robots.ts'], ['src/app/robots.ts']);
    expect(got.resolved).toEqual([{ named: 'robots.ts', files: ['src/app/robots.ts'] }]);
    expect(got.unresolved).toEqual(['src/app/legacy/robots.ts']);
  });

  it('shows the newest comments within the budget, oldest-first, and marks a cut one', () => {
    const c = (i: number, n: number) => ({ body: `${i}`.padEnd(n, 'x') });
    const long = shownComments([c(0, 10), c(1, MAX_COMMENT_CHARS + 50)]);
    expect(long.map((x) => x.text.length)).toEqual([10, MAX_COMMENT_CHARS]);
    expect(long.map((x) => x.truncated)).toEqual([false, true]);
    // More full-size comments than the budget holds: the OLDEST are the ones dropped.
    const fit = Math.floor(COMMENT_BUDGET / MAX_COMMENT_CHARS);
    const many = Array.from({ length: fit + 2 }, (_, i) => c(i, MAX_COMMENT_CHARS));
    expect(shownComments(many).map((x) => x.text[0])).toEqual(many.slice(-fit).map((x) => x.body[0]));
  });
});

describe('the rendered map', () => {
  const issue = {
    title: 'Close robots on unknown hosts',
    body: 'Build [PAY-12]. Touch `src/app/robots.ts` and a ```fenced``` sample.',
    labels: [{ name: 'agent:implement' }],
    comments: Array.from({ length: MAX_COMMENTS + 2 }, (_, i) => ({ author: { login: `u${i}` }, createdAt: 't', body: `comment ${i}` })),
  };
  const ok = {
    readIssue: () => issue,
    readTree: () => ['src/app/robots.ts'],
    readClauses: () => [clause('PAY-12')],
    readSpecLines: () => [...Array(9).fill(''), clause('PAY-12').raw],
  };

  it('carries the body, the cited clause text, the named files and only the latest comments', () => {
    const map = build(7, ok);
    expect(map).toContain(issue.body);
    expect(map).toContain(clause('PAY-12').raw);
    expect(map).toContain('- `src/app/robots.ts`');
    expect(map).toContain(`comment ${MAX_COMMENTS + 1}`);
    expect(map).not.toContain('comment 1\n');
    expect(map).not.toContain('comment 0\n');
    expect(map).toContain('gh issue view 7 --comments');
  });

  it('says where the rest of a truncated comment is, and whose it is', () => {
    const map = build(7, { ...ok, readIssue: () => ({ ...issue, comments: [{ author: { login: 'drive-by' }, authorAssociation: 'NONE', body: 'y'.repeat(MAX_COMMENT_CHARS + 1) }] }) });
    expect(map).toContain(`**drive-by** (none)`);
    expect(map).toContain(`TRUNCATED at ${MAX_COMMENT_CHARS} chars; run \`gh issue view 7 --comments\` for the rest`);
  });

  it('fences the body with a run longer than any backtick run inside it', () => {
    // A ``` in the body must not close the fence around it.
    expect(build(7, ok)).toMatch(/^````markdown$/m);
  });

  it('says UNAVAILABLE for each piece it could not read, rather than rendering it empty', () => {
    const boom = () => { throw new Error('HTTP 502'); };
    const noIssue = build(7, { ...ok, readIssue: boom });
    expect(noIssue).toMatch(/## Issue\n\nUNAVAILABLE — the read failed \(HTTP 502\)/);
    expect(build(7, { ...ok, readClauses: boom })).toMatch(/## Spec clauses it cites\n\nUNAVAILABLE/);
    expect(build(7, { ...ok, readTree: boom })).toMatch(/## Repo files it names\n\nUNAVAILABLE/);
    // An issue that cites and names nothing says THAT, which is a different sentence.
    const bare = build(7, { ...ok, readIssue: () => ({ ...issue, body: 'nothing here', comments: [] }) });
    expect(bare).toContain('(the issue cites no spec clause id)');
    expect(bare).toContain('(the issue names no file path)');
  });
});

