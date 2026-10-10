import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { MIN_ADOPTERS } from '../../infra/telemetry/function/aggregate.mjs';
import {
  DISPUTE_FIELD, DISPUTE_FORM, disputedRule, healthView, releaseList, ruleDisputes, timeToFix, upgradeLag,
} from '../../scripts/metrics/health.mjs';
import { renderIssue } from '../../scripts/telemetry/kanon-bugs.mjs';
import { LABELS } from '../../scripts/telemetry/kanon-findings.mjs';
import { SCHEMA, bugsQuery, main } from '../../scripts/telemetry/kanon-health.mjs';

/**
 * Plan 0003 M8: group 9's Kanon-side measures (§4, "Group 9, field by field"). Disputed rules,
 * from the "Dispute a rule" form (decision 15); the time to fix the bugs #41's job files, to the
 * close and to the first release containing the fix; and upgrade lag, each adopter's newest
 * `kanon_version` against Kanon's release list. The check: a seeded dispute and a seeded #41
 * issue each appear in the health view.
 */

const ROOT = join(__dirname, '../..');
const NOW = new Date('2026-10-10T12:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** An issue body as GitHub writes it from the "Dispute a rule" form. */
const disputeBody = (rule: string) =>
  `### ${DISPUTE_FIELD}\n\n${rule}\n\n### What the rule did\n\nIt blocked a merge.\n\n### Why it is wrong here\n\nBecause.`;
const dispute = (number: number, rule: string, state = 'OPEN') => ({ number, state, body: disputeBody(rule) });

/** A seeded #41 issue: the body the job renders, for a `test` signal. */
const seeded = renderIssue({
  kind: 'signal', signature: 'abc123def456abc123def456', lane: 'review', failed_stage: 'agent', kanon_error: null,
  reason: 'did_not_finish', kanon_version: '0.37.0', runs: 4, adopters: 3, first_seen: at(9), last_seen: at(8),
  api_error_status: {}, starts_at_release: false, classification: 'kanon', visibility: 'public', new: true,
});
const bug = (over: Record<string, unknown> = {}) => ({
  number: 700, state: 'CLOSED', state_reason: 'COMPLETED', labels: [LABELS.bug], body: seeded.body,
  created_at: at(8), closed_at: at(6), fixed_at: at(6), ...over,
});

const RELEASES = [
  { tag: 'v0.35.0', published_at: at(30), draft: false, prerelease: false },
  { tag: 'v0.36.0', published_at: at(20), draft: false, prerelease: false },
  { tag: 'v0.37.0', published_at: at(10), draft: false, prerelease: false },
  { tag: 'v0.38.0', published_at: at(5), draft: false, prerelease: false },
];

type Row = Record<string, unknown>;
const run = (pk: string, version: string | undefined, over: Row = {}): Row => ({
  schema_version: 2, row_kind: 'run', tag: 'run', recorded_at: at(1), lane: 'review', outcome: 'ok', reason: 'none',
  pk, ...(version === undefined ? {} : { kanon_version: version }), ...over,
});

describe('the Dispute a rule form', () => {
  const form = parse(readFileSync(join(ROOT, DISPUTE_FORM), 'utf8'));

  it('asks for one rule id, required, under the heading the health view reads', () => {
    expect(form.name).toBe('Dispute a rule');
    const field = form.body.find((b: { id?: string }) => b.id === 'rule');
    expect(field).toMatchObject({ type: 'input', attributes: { label: DISPUTE_FIELD }, validations: { required: true } });
    // Exactly one field carries the heading, or a dispute's body would hold it twice.
    expect(form.body.filter((b: { attributes?: { label?: string } }) => b.attributes?.label === DISPUTE_FIELD)).toHaveLength(1);
  });

  it('is not the Rule change form, whose rule id is optional and means something else', () => {
    const change = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/rule-change.yml'), 'utf8');
    expect(change).not.toContain(`label: ${DISPUTE_FIELD}`);
  });
});

describe('disputedRule: the rule id a dispute names', () => {
  it("reads the form's heading, in any case, with or without backticks", () => {
    expect(disputedRule(disputeBody('K-MERGE-7'))).toBe('K-MERGE-7');
    expect(disputedRule(disputeBody('`k-merge-7`'))).toBe('K-MERGE-7');
    expect(disputedRule(disputeBody('  K-OBS-14  '))).toBe('K-OBS-14');
  });

  it("is null for an id the rulebook doesn't have, or free text, so it is never shown", () => {
    expect(disputedRule(disputeBody('K-MERGE-999'))).toBeNull();
    expect(disputedRule(disputeBody('K-FOO-1'))).toBeNull();
    expect(disputedRule(disputeBody('the merge rule, I think'))).toBeNull();
    expect(disputedRule(disputeBody('_No response_'))).toBeNull();
  });

  it('is undefined for an issue that is not a dispute', () => {
    expect(disputedRule('### Rule id\n\nK-MERGE-7')).toBeUndefined();
    expect(disputedRule('')).toBeUndefined();
    expect(disputedRule(undefined)).toBeUndefined();
  });
});

describe('ruleDisputes: open and closed disputes per rule id (decision 15)', () => {
  it('counts each rule id, open and closed, most disputed first', () => {
    const r = ruleDisputes([
      dispute(1, 'K-MERGE-7'), dispute(2, 'K-MERGE-7', 'CLOSED'), dispute(3, 'K-MERGE-7'),
      dispute(4, 'K-OBS-14', 'CLOSED'), dispute(5, 'K-AGENT-2'),
    ]);
    expect(r.rules).toEqual([
      { rule: 'K-MERGE-7', open: 2, closed: 1 },
      { rule: 'K-AGENT-2', open: 1, closed: 0 },
      { rule: 'K-OBS-14', open: 0, closed: 1 },
    ]);
    expect(r).toMatchObject({ disputes: 5, unreadable: 0 });
  });

  it('counts an unreadable id apart, never as a rule, and skips what is not a dispute', () => {
    const r = ruleDisputes([dispute(1, 'K-FOO-1'), dispute(2, 'K-MERGE-7'), { number: 3, state: 'OPEN', body: 'A bug.' }]);
    expect(r.rules).toEqual([{ rule: 'K-MERGE-7', open: 1, closed: 0 }]);
    expect(r).toMatchObject({ disputes: 2, unreadable: 1 });
    expect(JSON.stringify(r)).not.toContain('K-FOO-1');
  });
});

describe('releaseList: Kanon releases on a date', () => {
  it('keeps published releases up to that date, oldest first, without drafts or prereleases', () => {
    const list = releaseList([
      ...RELEASES,
      { tag: 'v0.39.0', published_at: at(-1), draft: false, prerelease: false },
      { tag: 'v0.40.0-rc.1', published_at: at(2), draft: false, prerelease: true },
      { tag: 'v0.39.1', published_at: at(2), draft: true, prerelease: false },
      { tag: 'nightly', published_at: at(2), draft: false, prerelease: false },
      { tag: 'v0.34.1', published_at: at(40), draft: false, prerelease: false },
    ], NOW);
    expect(list.map((r) => r.version)).toEqual(['0.34.1', '0.35.0', '0.36.0', '0.37.0', '0.38.0']);
  });
});

describe("timeToFix: the bugs #41's job files, to their close and to the release with the fix", () => {
  it('measures created to closed, and created to the first release published after the fix merged', () => {
    const r = timeToFix([bug()], RELEASES, { now: NOW });
    expect(r).toMatchObject({ filed: 1, open: 0, fixed: 1, closed_unfixed: 0, unreleased: 0, no_fix_link: 0 });
    expect(r.to_close).toEqual({ n: 1, median_days: 2, p90_days: 2 });
    // Fixed 6 days ago; v0.38.0, 5 days ago, is the first release after it; filed 8 days ago.
    expect(r.to_release).toEqual({ n: 1, median_days: 3, p90_days: 3 });
  });

  it("takes the first release after the FIX, not after the issue was filed", () => {
    // Filed 12 days ago, before v0.37.0; fixed 6 days ago, after it. v0.37.0 can't contain the fix.
    const r = timeToFix([bug({ created_at: at(12) })], RELEASES, { now: NOW });
    expect(r.to_release).toEqual({ n: 1, median_days: 7, p90_days: 7 });
  });

  it('counts a fix with no release yet, and a close with no linked fix, apart', () => {
    const r = timeToFix([
      bug({ number: 1, closed_at: at(1), fixed_at: at(1) }),
      bug({ number: 2, fixed_at: null }),
    ], RELEASES, { now: NOW });
    expect(r).toMatchObject({ fixed: 2, unreleased: 1, no_fix_link: 1, to_release: null });
    expect(r.to_close?.n).toBe(2);
  });

  it('leaves open issues and those closed as not planned out of the times', () => {
    const r = timeToFix([
      bug({ number: 1 }),
      bug({ number: 2, state: 'OPEN', state_reason: null, closed_at: null, fixed_at: null }),
      bug({ number: 3, state_reason: 'NOT_PLANNED', created_at: at(9), closed_at: at(1) }),
      bug({ number: 4, state_reason: 'DUPLICATE', created_at: at(9), closed_at: at(1) }),
    ], RELEASES, { now: NOW });
    expect(r).toMatchObject({ filed: 4, open: 1, fixed: 1, closed_unfixed: 2 });
    expect(r.to_close).toEqual({ n: 1, median_days: 2, p90_days: 2 });
  });

  it("reads only the job's issues: the kanon-bug label AND its signature marker", () => {
    const r = timeToFix([
      bug({ number: 1, labels: ['bug'] }),
      bug({ number: 2, body: 'A person filed this with the label.' }),
    ], RELEASES, { now: NOW });
    expect(r.filed).toBe(0);
    expect(r.to_close).toBeNull();
  });

  it('gives the median and the 90th percentile by nearest rank', () => {
    const issues = Array.from({ length: 10 }, (_, i) => bug({ number: i, created_at: at(7 + i), closed_at: at(7), fixed_at: at(7) }));
    expect(timeToFix(issues, RELEASES, { now: NOW }).to_close).toEqual({ n: 10, median_days: 4.5, p90_days: 8 });
  });
});

describe("upgradeLag: each adopter's newest version against the release list", () => {
  const rows = [
    run('aaaa1111#review', '0.38.0'),
    // Its highest version first: a lane still on an older pin, read later, doesn't lower it.
    run('bbbb2222#review', '0.37.0'), run('bbbb2222#triage', '0.36.0'),
    run('cccc3333#review', '0.35.0'), run('cccc3333#review', 'dev'), run('cccc3333#implement', undefined),
  ];

  it("counts releases behind, and days since the first newer release, for each adopter's highest version", () => {
    const r = upgradeLag(rows, RELEASES, { now: NOW });
    // aaaa: on 0.38.0, current. bbbb: 0.37.0, one behind, 5 days. cccc: 0.35.0, three behind, 20 days.
    expect(r).toEqual({
      withheld: false, adopters: 3, on_latest: 1,
      releases_behind: { median: 1, p90: 3 }, days_behind: { median: 5, p90: 20 },
    });
  });

  it(`withholds the distribution below ${MIN_ADOPTERS} adopters, without their count`, () => {
    const r = upgradeLag(rows.filter((x) => !String(x.pk).startsWith('aaaa')), RELEASES, { now: NOW });
    expect(r).toEqual({ withheld: true, min_adopters: MIN_ADOPTERS });
  });

  it('reads only run rows of the tag asked for, with a release version, recorded by then', () => {
    const r = upgradeLag([
      ...rows,
      run('dddd4444#review', '0.30.0', { tag: 'test' }),
      run('eeee5555#review', '0.30.0', { recorded_at: at(-1) }),
      run('ffff6666#review', '0.30.0', { row_kind: 'work_item' }),
    ], RELEASES, { now: NOW });
    expect(r).toMatchObject({ adopters: 3 });
  });

  it('never holds an adopter key', () => {
    const r = upgradeLag(rows.map((x) => ({ ...x, pk: undefined, adopter: String(x.pk).slice(0, 8) })), RELEASES, { now: NOW });
    const text = JSON.stringify(r);
    for (const key of ['aaaa1111', 'bbbb2222', 'cccc3333']) expect(text).not.toContain(key);
    expect(r).toMatchObject({ adopters: 3 });
  });
});

describe('healthView: the health view', () => {
  it('shows a seeded dispute and a seeded #41 issue (M8)', () => {
    const view = healthView({
      computed_at: NOW.toISOString(),
      disputes: ruleDisputes([dispute(1, 'K-MERGE-7')]),
      fixes: timeToFix([bug()], RELEASES, { now: NOW }),
      lag: null,
    });
    expect(view).toContain('| `K-MERGE-7` | 1 | 0 |');
    expect(view).toMatch(/1 filed by #41's job: 0 open, 1 fixed, 0 closed unfixed/);
    expect(view).toContain('| To the close | 1 | 2.0 | 2.0 |');
    expect(view).toContain('| To the first release with the fix | 1 | 3.0 | 3.0 |');
    expect(view).toContain('Not computed');
  });

  it('says so when there is nothing, and when the lag is withheld', () => {
    const view = healthView({
      computed_at: NOW.toISOString(), disputes: ruleDisputes([]), fixes: timeToFix([], RELEASES, { now: NOW }),
      lag: upgradeLag([], RELEASES, { now: NOW }),
    });
    expect(view).toContain('No rule has been disputed.');
    expect(view).toContain("#41's job has filed no issue.");
    expect(view).toContain(`Withheld: fewer than ${MIN_ADOPTERS} adopters`);
    expect(view).not.toMatch(/\| To the close/);
  });

  it('shows the lag distribution at three adopters', () => {
    const view = healthView({
      computed_at: NOW.toISOString(), disputes: ruleDisputes([]), fixes: timeToFix([], RELEASES, { now: NOW }),
      lag: { withheld: false, adopters: 3, on_latest: 1, releases_behind: { median: 1, p90: 3 }, days_behind: { median: 5, p90: 20 } },
    });
    expect(view).toContain('3 adopters, 1 on the latest release.');
    expect(view).toContain('| Releases behind | 1 | 3 |');
    expect(view).toContain('| Days behind | 5.0 | 20.0 |');
  });
});

describe('kanon-health.mjs: reads Kanon from GitHub and prints the view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-health-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const node = (n: Record<string, unknown>) => ({
    number: n.number, state: n.state, stateReason: n.state_reason ?? null, createdAt: n.created_at, closedAt: n.closed_at ?? null,
    body: n.body, labels: { nodes: ((n.labels as string[]) ?? []).map((name) => ({ name })) },
    timelineItems: { nodes: n.fixed_at ? [{ closer: { __typename: 'PullRequest', mergedAt: n.fixed_at } }] : [] },
  });
  const page = (nodes: unknown[], next?: string) => JSON.stringify({
    data: { search: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } },
  });
  /** A fake `gh`: the release list, then a search for disputes and one for #41's issues, in pages. */
  const fakeGh = (calls: string[][]) => (args: string[]) => {
    calls.push(args);
    if (args[0] === 'release') {
      return { status: 0, stderr: '', stdout: JSON.stringify(RELEASES.map((r) => ({ tagName: r.tag, publishedAt: r.published_at, isDraft: r.draft, isPrerelease: r.prerelease }))) };
    }
    const q = args.find((a) => a.startsWith('q='))?.slice(2) ?? '';
    const after = args.find((a) => a.startsWith('after='))?.slice(6);
    if (q.includes('in:body')) return { status: 0, stderr: '', stdout: page([{ number: 1, state: 'OPEN', body: disputeBody('K-MERGE-7') }]) };
    if (q.includes(`label:${LABELS.bug}`) && !after) return { status: 0, stderr: '', stdout: page([node(bug({ number: 1 }))], 'c1') };
    if (q.includes(`label:${LABELS.bug}`)) return { status: 0, stderr: '', stdout: page([node(bug({ number: 2, state: 'OPEN', state_reason: null, closed_at: null, fixed_at: null }))]) };
    return { status: 1, stderr: 'unexpected', stdout: '' };
  };
  const deps = (calls: string[][], over: Record<string, unknown> = {}) => ({ gh: fakeGh(calls), now: () => NOW, ...over });

  it('prints the view, with the seeded dispute and the #41 issues from every page', () => {
    const calls: string[][] = [];
    const { code, out } = main([], deps(calls));
    expect(code).toBe(0);
    expect(out).toContain('| `K-MERGE-7` | 1 | 0 |');
    expect(out).toMatch(/2 filed by #41's job: 1 open, 1 fixed/);
    // The closing pull request's merge times the fix.
    expect(out).toContain('| To the first release with the fix | 1 | 3.0 | 3.0 |');
    expect(calls.some((a) => a.includes('-R') && a.includes('yedeya-labs/kanon'))).toBe(true);
    expect(calls.filter((a) => a.includes('graphql'))).toHaveLength(3);
  });

  it('asks GitHub for the closer of each issue, to time the fix', () => {
    expect(bugsQuery).toMatch(/CLOSED_EVENT/);
    expect(bugsQuery).toMatch(/mergedAt/);
  });

  it('with --json, prints one document; with --rows, the upgrade lag', () => {
    const file = join(dir, 'rows.jsonl');
    writeFileSync(file, ['aaaa1111', 'bbbb2222', 'cccc3333'].map((k) => JSON.stringify(run(`${k}#review`, '0.37.0'))).join('\n'));
    const { code, out } = main(['--json', '--rows', file, '--repo', 'acme/kanon-fork'], deps([]));
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc).toMatchObject({ schema: SCHEMA, computed_at: NOW.toISOString(), disputes: { disputes: 1 }, fixes: { filed: 2 } });
    expect(doc.upgrade_lag).toMatchObject({ withheld: false, adopters: 3, on_latest: 0, releases_behind: { median: 1 } });
    expect(out).not.toContain('aaaa1111');
  });

  it('exits 3 when GitHub fails, and 2 on a bad argument', () => {
    const failing = deps([], { gh: () => ({ status: 1, stdout: '', stderr: 'HTTP 502' }) });
    expect(main([], failing).code).toBe(3);
    // A failed call is a failure even when what it printed parses.
    const searches = fakeGh([]);
    const releasesFail = (args: string[]) => (args[0] === 'release' ? { status: 1, stdout: '[]', stderr: '' } : searches(args));
    expect(main([], deps([], { gh: releasesFail })).code).toBe(3);
    expect(main(['--nope'], deps([])).code).toBe(2);
    expect(main(['--repo', 'not a repo'], deps([])).code).toBe(2);
    expect(main(['--rows', join(dir, 'missing.json')], deps([])).code).toBe(2);
  });
});
