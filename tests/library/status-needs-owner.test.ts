/**
 * The needs-the-Owner view (project #1327, Issue F): the closed list of what waits on a person,
 * each with its link and its reason. Every entry is another decider's answer: the readiness view's
 * for a pull request ready for a person's merge and for a brief's open decisions, the dispatch
 * sweep's for the Implementer's stops, the reconciler's for the Lead's holds, and the lane-health
 * view's for a red lane.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADOPTER, ROOT } from './helpers/adopter.js';
import { IMPLEMENTER_HEADER, LEAD_HEADER, READ_AT, REPO, briefPr, ci, implementerPr, personPr } from './helpers/pr-world.js';
import { liveRun, numbered, ownerWorld, type OwnerIssue } from './helpers/owner-world.js';
import { fail, failedJob, laneCaller, ok } from './helpers/status-world.js';

const { needsOwnerView } = await import('../../scripts/status/needs-owner.mjs');
const { readinessView } = await import('../../scripts/status/pull-request.mjs');
const { IncompleteRead } = await import('../../scripts/status/project.mjs');
const { ReadError } = await import('../../scripts/status/reader.mjs');
const { HELD_MARKER } = await import('../../scripts/lead-reconcile.mjs');
const { RETRY_STEPS } = await import('../../scripts/lane-retry.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FRESH = '2026-10-25T11:00:00Z';
const STALE = '2026-10-21T09:00:00Z';
const implementer = (body: string, createdAt: string) => ({ login: 'example-implementer', body: `${IMPLEMENTER_HEADER}\n\n${body}`, createdAt });

/** One of each thing the view lists, beside a look-alike of each that it mustn't. */
const PRS = () => [
  // The Merger's to merge, and ready: not a person's.
  numbered(42, implementerPr()),
  // The Implementer's, escalated for a path alone: ready for a person's merge.
  numbered(43, implementerPr({ files: [{ filename: 'migrations/001.sql' }] })),
  // A person's, green and approved: ready for a person's merge.
  numbered(44, personPr()),
  // A person's, red: not ready.
  numbered(45, personPr({ checks: [ci('test', 'FAILURE')] })),
  // A brief with an open decision: not ready, and its decision listed.
  numbered(46, briefPr('Which store? ⛔ OPEN')),
  // A brief whose decisions are answered: ready for a person's merge.
  numbered(47, briefPr('Which store? ✅ ANSWERED: Postgres.', {}, 'docs/projects/10.md')),
  // The Implementer's, still running its checks, and closing #36.
  numbered(48, implementerPr({ checks: [ci('test', null)], closes: [{ number: 36, body: 'PRIVATE issue body' }] })),
];

const ISSUES = (): OwnerIssue[] => [
  { number: 7, title: 'Project: storefront', labels: ['needs:human'], comments: [{ login: 'example-lead', body: `${LEAD_HEADER}\n\nPRIVATE hold reasons.\n\n${HELD_MARKER}`, createdAt: STALE }] },
  // The marker in a comment that isn't the Lead's is no Lead hold (kanon#1399).
  { number: 8, title: 'Project: payments', labels: ['needs:human'], comments: [{ login: 'octo', body: `Quoting: ${HELD_MARKER}`, createdAt: STALE }] },
  { number: 9, title: 'Project: shipping', labels: ['needs:human'], comments: [] },
  { number: 30, title: 'Pick a store', labels: ['qa:needs-info'] },
  { number: 31, title: 'Rebuild checkout', labels: ['qa:needs-split', 'enhancement'] },
  // A bail an hour old: the sweep calls it in flight, and it is the Implementer's last word.
  { number: 32, title: 'Add login', labels: ['agent:implement'], comments: [implementer('SCOPE-FIRST BAIL — PRIVATE plan: this is an auth change.', FRESH)] },
  // The Implementer's word is the last, and days old: the sweep's awaiting-human.
  { number: 33, title: 'Add search', labels: ['agent:implement'], comments: [implementer('PRIVATE plan, and a question.', STALE)] },
  // Fresh and no bail: in flight, nobody is waited on.
  { number: 34, title: 'Add cart', labels: ['agent:implement'], comments: [implementer('Working on it.', FRESH)] },
  // A bail a person answered: the sweep calls it answered.
  { number: 35, title: 'Add coupons', labels: ['agent:implement'], comments: [implementer('SCOPE-FIRST BAIL — migration.', STALE), { login: 'octo', body: 'Go ahead.', createdAt: '2026-10-22T09:00:00Z' }] },
  // A stale word, but an open pull request closes it: the sweep calls it has-pr.
  { number: 36, title: 'Add wishlist', labels: ['agent:implement'], comments: [implementer('Plan.', STALE)] },
  // A stale word, and its run is going again: the sweep calls it running.
  { number: 37, title: 'Add reviews', labels: ['agent:implement'], comments: [implementer('Plan.', STALE)] },
  // Never commented: the sweep's never-ran, which it dispatches itself.
  { number: 38, title: 'Add ratings', labels: ['agent:implement'], comments: [] },
  // The triage lane is the Implementer too.
  { number: 39, title: 'Crash on checkout', labels: ['qa:needs-triage', 'bug'], comments: [implementer('Cannot tell; which browser?', STALE)] },
  // A stale bail: the sweep's awaiting-human, named for what it is.
  { number: 40, title: 'Add payments', labels: ['agent:implement'], comments: [implementer('SCOPE-FIRST BAIL — credentials.', STALE)] },
  // Carrying nothing the view reads.
  { number: 50, title: 'Unrelated', labels: ['enhancement', 'blocked'] },
];

const LANES = {
  workflows: { 'implement.yml': laneCaller('implement'), 'review.yml': laneCaller('review'), 'merge.yml': laneCaller('merge') },
  runs: { 'implement.yml': [fail(201), fail(202), fail(203)], 'review.yml': [fail(101), fail(102), fail(103)], 'merge.yml': [ok(1), ok(2), ok(3)] },
  jobs: {
    201: [failedJob('implement / implement')], 202: [failedJob('implement / implement')], 203: [],
    101: [failedJob('review / review', RETRY_STEPS.unreachable)], 102: [failedJob('review / review', RETRY_STEPS.api_error)], 103: [failedJob('review / review', RETRY_STEPS.unreachable)],
  },
};

const world = (over: Partial<Parameters<typeof ownerWorld>[0]> = {}) => ownerWorld({
  prs: PRS(), issues: ISSUES(), live: [liveRun(9, 'Add reviews', '2026-10-25T11:30:00Z')], ...LANES, ...over,
});

describe('the needs-the-Owner view', () => {
  it('[STAT-10] lists what waits on a person, each with its link and its reason, and nothing else', async () => {
    const w = world();
    const v: Any = await needsOwnerView({ reader: w.reader, repo: w.repo, now: READ_AT });
    expect(Object.keys(v).sort(), 'the closed list, and nothing else').toEqual(['branch', 'decisions', 'holds', 'lanes', 'merges', 'stops']);
    expect(v.branch).toBe('main');

    // The pull requests ready for a person's merge: the Implementer's the gate escalates for a path
    // alone, and those it skips as not the Implementer's. Not the Merger's, not one that isn't ready.
    expect(v.merges.map((m: Any) => [m.number, m.rule])).toEqual([[43, 'escalating-path'], [44, 'not-the-implementer'], [47, 'not-the-implementer']]);
    for (const m of v.merges) {
      expect(m.url).toBe(`https://github.com/${REPO}/pull/${m.number}`);
      // The readiness view's own answer for the same pull request, never the view's.
      const r = readinessView({ reader: world().reader, repo: REPO, pr: m.number, now: READ_AT });
      const { readiness, title } = (await r) as Any;
      expect(readiness).toMatchObject({ by: 'person', ready: true });
      expect([m.title, m.reason]).toEqual([title, readiness.why]);
    }
    for (const n of [42, 45, 46, 48]) {
      const { readiness } = (await readinessView({ reader: world().reader, repo: REPO, pr: n, now: READ_AT })) as Any;
      expect(readiness.by === 'person' && readiness.ready, `#${n}`).toBe(false);
    }

    // The Implementer's stops that wait on a person: the two labels, a bail that is its last word,
    // and the sweep's awaiting-human; in either of the sweep's lanes.
    expect(v.stops.map((s: Any) => [s.number, s.reasons])).toEqual([
      [30, ['qa:needs-info']],
      [31, ['qa:needs-split']],
      [32, ['scope-first-bail']],
      [33, ['awaiting-human']],
      [39, ['awaiting-human']],
      [40, ['scope-first-bail']],
    ]);
    expect(v.stops[0]).toEqual({ number: 30, title: 'Pick a store', url: `https://github.com/${REPO}/issues/30`, reasons: ['qa:needs-info'] });

    // The Lead's holds: the hold marker in the Lead's own comment, beside `needs:human`.
    expect(v.holds).toEqual([{ number: 7, title: 'Project: storefront', url: `https://github.com/${REPO}/issues/7` }]);

    // Each open decision in an open brief pull request, as the brief guard reads it.
    expect(v.decisions).toEqual([{
      number: 46, title: 'docs(projects): brief for #9', url: `https://github.com/${REPO}/pull/46`, brief: 'docs/projects/9.md', n: 1, headline: 'Which store? ⛔ OPEN', marker: '⛔',
    }]);

    // The lanes the lane-health view reports red; not a flaky one, not a green one.
    expect(v.lanes).toEqual([{ file: 'implement.yml', url: `https://github.com/${REPO}/actions/workflows/implement.yml`, failed: 3, decisive: 3 }]);

    // A comment or an issue body is read only to find a marker: the answer carries the fact and its link.
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/PRIVATE|SCOPE-FIRST|Closes #|qa:lead-held|Go ahead/);
  });

  it('[STAT-10] leaves the list empty where nothing waits on a person', async () => {
    const w = ownerWorld({ prs: [numbered(42, implementerPr())], issues: [{ number: 34, title: 'Add cart', labels: ['agent:implement'], comments: [implementer('Working on it.', FRESH)] }] });
    const v: Any = await needsOwnerView({ reader: w.reader, repo: w.repo, now: READ_AT });
    expect(v).toEqual({ branch: 'main', merges: [], stops: [], holds: [], decisions: [], lanes: [] });
    expect(w.seen.some((s) => s.includes('event=issues')), 'the live runs are read for an issue in a lane').toBe(true);
    const none = ownerWorld({ prs: [] });
    expect(await needsOwnerView({ reader: none.reader, repo: none.repo, now: READ_AT })).toEqual({ branch: 'main', merges: [], stops: [], holds: [], decisions: [], lanes: [] });
    expect(none.seen.some((s) => s.includes('event=issues')), 'and not without one').toBe(false);
  });

  it('[STAT-1] reads only through its reader, asking REST GETs and GraphQL queries, and writes nothing while it reads', async () => {
    const w = world();
    const v: Any = await needsOwnerView({ reader: w.reader, repo: w.repo, now: READ_AT });
    for (const s of w.seen) expect(s, s).toMatch(/^(GET|PAGES|GraphQL) /);
    for (const q of w.queries) expect(q.trimStart(), q.slice(0, 60)).toMatch(/^query\s/);

    // In a process of its own, every write, child process and fetch replaced once the core is
    // loaded, over the answers the recording reader gave. Loading the merge gate reads the App
    // register from the working directory, so the directory holds that and nothing else.
    const dir = mkdtempSync(join(tmpdir(), 'status-owner-'));
    mkdirSync(join(dir, 'docs/qa'), { recursive: true });
    cpSync(join(ADOPTER, 'docs/qa/agent-identities.md'), join(dir, 'docs/qa/agent-identities.md'));
    const record = world();
    const answers: Record<string, unknown> = {};
    const asked = (fn: () => unknown) => { try { return fn(); } catch { return null; } };
    for (const s of w.seen) {
      const [kind, ...rest] = s.split(' ');
      const path = rest.join(' ');
      if (kind === 'GET') answers[s] = asked(() => record.reader.get(path));
      if (kind === 'PAGES') answers[s] = asked(() => record.reader.pages(path));
    }
    for (const q of w.queries) {
      const op = /query\s+(\w+)/.exec(q)![1]!;
      for (const s of w.seen.filter((x) => x.startsWith(`GraphQL ${op} `))) {
        answers[s] = asked(() => record.reader.graphql(q, JSON.parse(s.slice(`GraphQL ${op} `.length))));
      }
    }
    const script = `
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const { needsOwnerView } = await import(${JSON.stringify(join(ROOT, 'scripts/status/needs-owner.mjs'))});
      const calls = [];
      const record = (name) => (...args) => { calls.push(name + ' ' + String(args[0])); throw new Error('the core must not ' + name); };
      for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'openSync', 'readFileSync', 'readdirSync', 'existsSync', 'statSync', 'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'createWriteStream']) fs[name] = record('fs.' + name);
      for (const k of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'readFile', 'readdir', 'open']) fs.promises[k] = record('fs.promises.' + k);
      for (const name of ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'exec', 'execFile', 'fork']) cp[name] = record('child_process.' + name);
      globalThis.fetch = record('fetch');
      syncBuiltinESMExports();
      const answers = JSON.parse(process.argv[1]);
      const answer = (key) => { const r = answers[key]; if (r === undefined || r === null) throw Object.assign(new Error('not found'), { status: 404 }); return r; };
      const opOf = (q) => /query\\s+(\\w+)/.exec(q)[1];
      const reader = { get: (p) => answer('GET ' + p), pages: (p) => answer('PAGES ' + p), graphql: (q, v = {}) => answer('GraphQL ' + opOf(q) + ' ' + JSON.stringify(v)) };
      let view;
      try { view = await needsOwnerView({ reader, repo: ${JSON.stringify(REPO)}, now: ${READ_AT} }); } catch (e) { view = { error: e.message }; }
      console.log(JSON.stringify({ calls, view }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(answers)], { cwd: dir, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    const out = JSON.parse(run.stdout);
    expect(out.calls, 'no file read or written, no process started, no other network').toEqual([]);
    expect(out.view, 'and the view was answered, the same').toEqual(v);
    expect(readdirSync(dir), 'nothing left behind').toEqual(['docs']);
  });

  it('[STAT-3] makes the view an error when any of its reads fails or comes back cut short, never a shorter list', async () => {
    const refuse = (match: RegExp) => (p: string) => {
      if (match.test(p)) throw new ReadError(`GET ${p}`, 'API rate limit exceeded', { status: 403, resetAt: '2026-10-25T13:00:00.000Z' });
      return undefined;
    };
    // A pull request's reads.
    const pr = world({ overrides: { pages: refuse(/pulls\/44\/reviews/) } });
    const err: Any = await needsOwnerView({ reader: pr.reader, repo: pr.repo, now: READ_AT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteRead);
    expect(err.message).toMatch(/^the needs-the-Owner view couldn't be read whole, so there is no answer: GET repos\/acme\/shop\/pulls\/44\/reviews\?per_page=100 failed: API rate limit exceeded \(the rate limit resets at 2026-10-25T13:00:00.000Z\)/);

    // An issue's comments, which the sweep and the hold are read from.
    const comments = world({ overrides: { graphql: { Comments: (vars: Any) => { if (vars.number === 7) throw new ReadError('GraphQL Comments', 'Something went wrong'); return { repository: { issue: { comments: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } } } } }; } } } });
    await expect(needsOwnerView({ reader: comments.reader, repo: comments.repo, now: READ_AT })).rejects.toThrow(/needs-the-Owner view.*GraphQL Comments failed: Something went wrong/);

    // The live runs, cut short.
    const cut = world({ overrides: { pages: (p: string) => (p.includes('status=queued&event=issues') ? [{ total_count: 300, workflow_runs: [] }] : undefined) } });
    await expect(needsOwnerView({ reader: cut.reader, repo: cut.repo, now: READ_AT })).rejects.toThrow(/status=queued&event=issues.*cut short: 0 of 300/);

    // An issue with more labels than came back, and more open pull requests than came back.
    const labels = world({ overrides: { graphql: { OwnerIssues: () => ({ repository: { issues: { totalCount: 1, nodes: [{ number: 30, title: 'x', url: 'u', labels: { nodes: [], totalCount: 101 } }], pageInfo: { hasNextPage: false } } } }) } } });
    await expect(needsOwnerView({ reader: labels.reader, repo: labels.repo, now: READ_AT })).rejects.toThrow(/labels of #30.*cut short: 0 of 101/);
    const prs = world({ overrides: { graphql: { OpenPullRequests: () => ({ repository: { pullRequests: { totalCount: 80, nodes: [], pageInfo: { hasNextPage: false } } } }) } } });
    await expect(needsOwnerView({ reader: prs.reader, repo: prs.repo, now: READ_AT })).rejects.toThrow(/GraphQL OpenPullRequests failed: the listing was cut short: 0 of 80/);

    // A lane's runs.
    const lane = world({ overrides: { get: refuse(/actions\/workflows\/merge\.yml\/runs/) } });
    await expect(needsOwnerView({ reader: lane.reader, repo: lane.repo, now: READ_AT })).rejects.toThrow(/^the needs-the-Owner view couldn't be read whole.*merge\.yml\/runs.*API rate limit exceeded/);
  });
});
