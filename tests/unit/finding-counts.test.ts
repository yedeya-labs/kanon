import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { count, findingRules, isReviewers, parseArgs, renderTable, tally, weekOf } from '../../scripts/finding-counts.mjs';
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

/** A fake `gh api` over FIXTURE, one page of each listing, recording what it was asked. */
const fakeGh = () => {
  const calls: string[] = [];
  const gh = (args: string[]): unknown => {
    const path = args[1] ?? '';
    calls.push(path);
    const page = Number(new URL(`https://x/${path}`).searchParams.get('page'));
    if (page > 1) return [];
    if (/^repos\/o\/r\/pulls\?/.test(path)) return FIXTURE.pulls;
    const rv = /^repos\/o\/r\/pulls\/(\d+)\/reviews\?/.exec(path);
    if (rv) return FIXTURE.reviews[Number(rv[1])] ?? [];
    if (/^repos\/o\/r\/issues\?/.test(path)) return FIXTURE.issues;
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
};

describe('counting a repository\'s window (K-SELF-14)', () => {
  it('counts the Reviewer\'s request-changes reviews and follow-ups in [since, until), and reads no pull request older than the window', () => {
    const { gh, calls } = fakeGh();
    const r = count({ repo: 'o/r', gh, since: '2026-10-14', until: '2026-10-21' });
    expect(r).toMatchObject({ since: '2026-10-14', until: '2026-10-21', reviews: 2, followUpIssues: 1 });
    expect(r.rows).toEqual([
      { rule: 'K-PRIN-4', findings: 2, pullRequests: 2, followUps: 1 },
      { rule: 'K-WORK-5', findings: 1, pullRequests: 1, followUps: 0 },
    ]);
    expect(calls).not.toContain('repos/o/r/pulls/3/reviews?per_page=100&page=1');
    expect(calls).toContain('repos/o/r/issues?labels=follow-up,agent:reviewer&state=all&since=2026-10-14T00:00:00Z&per_page=100&page=1');
    expect(r.weeks).toEqual([
      { week: '2026-10-12', rows: [{ rule: 'K-PRIN-4', findings: 1, pullRequests: 1, followUps: 1 }, { rule: 'K-WORK-5', findings: 1, pullRequests: 1, followUps: 0 }] },
      { week: '2026-10-19', rows: [{ rule: 'K-PRIN-4', findings: 1, pullRequests: 1, followUps: 0 }] },
    ]);
  });

  it('prints a table a person or an audit issue can read', () => {
    const { gh } = fakeGh();
    const table = renderTable(count({ repo: 'o/r', gh, since: '2026-10-14', until: '2026-10-21', rules: ['K-PRIN-4', 'K-SPEC-2'] }));
    expect(table).toContain('| Rule | Findings | Pull requests | Follow-ups |');
    expect(table).toContain('| `K-PRIN-4` | 2 | 2 | 1 |');
    expect(table).toContain('| `K-SPEC-2` | 0 | 0 | 0 |');
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
  // Each `gh api <path>` answers from the fixture file named for its path, and `[]` past the first page.
  const dir = mkdtempSync(join(tmpdir(), 'finding-counts-'));
  dirs.push(dir);
  const name = (path: string) => path.replace(/[^A-Za-z0-9]/g, '_');
  const put = (path: string, value: unknown) => writeFileSync(join(dir, `${name(path)}.json`), JSON.stringify(value));
  put('repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1', FIXTURE.pulls);
  for (const n of [5, 4, 3]) put(`repos/o/r/pulls/${n}/reviews?per_page=100&page=1`, FIXTURE.reviews[n]);
  put('repos/o/r/issues?labels=follow-up,agent:reviewer&state=all&since=2026-10-14T00:00:00Z&per_page=100&page=1', FIXTURE.issues);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  writeStub(join(bin, 'gh'), `#!/usr/bin/env bash
f="${dir}/$(printf %s "$2" | tr -c 'A-Za-z0-9' '_').json"
if [ -f "$f" ]; then cat "$f"; else echo '[]'; fi
`);
  const run = (...args: string[]) => spawnSync('node', [join(ROOT, 'scripts', 'finding-counts.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' },
  });

  it('prints the counts as JSON and as a table, and exits 2 on a usage error', () => {
    const json = run('--since', '2026-10-14', '--until', '2026-10-21', '--json');
    expect(json.stderr).toBe('');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).rows).toEqual([
      { rule: 'K-PRIN-4', findings: 2, pullRequests: 2, followUps: 1 },
      { rule: 'K-WORK-5', findings: 1, pullRequests: 1, followUps: 0 },
    ]);
    const table = run('--since', '2026-10-14', '--until', '2026-10-21');
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('| `K-WORK-5` | 1 | 1 | 0 |');
    const bad = run('--since', 'yesterday');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--since takes a date');
  });
});
