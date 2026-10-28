/**
 * The status core's pull-request readiness view (project #1327, Issue C): a pull request's checks
 * as the merge gate partitions them, the Reviewer's verdict and whether it is current, the
 * criteria of the issues it closes, and the merge gate's own verdict; ready for the Merger only
 * when that verdict is a merge; and a pull request the gate skips as not the Implementer's
 * reported as a person's, ready only on the gate's check partition, the review-recovery lane's
 * verdict on its head and, for a brief, the brief guard's open-decision read.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { ESCALATE_PATHS } from './helpers/escalations.js';
import {
  DEFAULT_FILES, HEAD, MERGER_HEADER, NUMBER, OLD, READ_AT, REPO, approval, briefPr, briefText, ci, ghFor, implementerPr, personPr, readerFor, type PrWorld,
} from './helpers/pr-world.js';

const { readinessView, readPullRequest } = await import('../../scripts/status/pull-request.mjs');
const { IncompleteRead } = await import('../../scripts/status/project.mjs');
const { ReadError } = await import('../../scripts/status/reader.mjs');
const { checkPartition, mergeVerdict, readPr } = await import('../../scripts/merge-gate.mjs');
const { verdictOnHead } = await import('../../scripts/review-recovery.mjs');
const { conflictState } = await import('../../scripts/conflict-state.mjs');
const { ESCALATION_HEADER, HANDBACK, mergerMarker } = await import('../../scripts/lib/protocol-spellings.mjs');
const { IMPLEMENTER_STATUS } = await import('../../scripts/lib/role-marker.mjs');
const { marker: rebaseMarker } = await import('../../scripts/rebase-lane.mjs');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const view = async (w: PrWorld, overrides = {}) => {
  const r = readerFor(w, overrides);
  return { v: (await readinessView({ reader: r.reader, repo: REPO, pr: w.number, now: READ_AT })) as Any, seen: r.seen, queries: r.queries };
};

/** The merge gate's own verdict for the world, over the shape `readPr` builds through `gh`. */
const gateOver = (w: PrWorld) => {
  const pr = readPr(w.number, REPO, ghFor(w));
  return { pr, verdict: mergeVerdict(pr, { escalations: ESCALATE_PATHS, now: READ_AT }) };
};
/**
 * The limit of a case that holds the view against the gate over many worlds. Each `gateOver` is
 * about seven `gh` reads, and each read starts the stub `gh` as a node process of its own: some
 * 650 ms a world on a laptop, against about 1 ms for the view itself. Over a dozen worlds that is
 * seven seconds of process starts, past vitest's 5 s default and slower on a loaded runner.
 * The gate's own `readPr` is what the case compares against, so the processes stay (kanon#1464).
 */
const GATE_READS_TIMEOUT = 30_000;

/** The Merger's escalation of `rule` on `sha`, as it posts one. */
const escalation = (rule: string, sha = HEAD) => ({
  login: 'example-merger[bot]', body: `${MERGER_HEADER}\n\n${ESCALATION_HEADER}\n\nA person decides.\n\n${mergerMarker(rule, sha)}`, at: '2026-10-25T11:00:00Z',
});
const heldBy = (actor: string) => [{ event: 'labeled', label: 'needs:human', actor }];

/** The worlds the shared fixture holds the two shapes together over: one per branch of `readPr`. */
const SHAPES: Record<string, PrWorld> = {
  'green and approved': implementerPr(),
  'a check still running, and a status still pending': implementerPr({
    checks: [ci('test', null), { kind: 'StatusContext', context: 'deploy/preview', state: 'PENDING', createdAt: '2026-10-25T10:01:00Z' }],
  }),
  'a third-party check with no workflow': implementerPr({ checks: [ci('lint', 'SUCCESS', { workflow: null, detailsUrl: null })] }),
  'a failed check the Merger handed back': implementerPr({
    checks: [ci('test', 'FAILURE')],
    comments: [{ login: 'example-merger[bot]', body: `${MERGER_HEADER}\n\nHanding back.\n\n${mergerMarker(HANDBACK, HEAD)}`, at: '2026-10-25T11:50:00Z' }],
  }),
  'a needs:human the Merger applied': implementerPr({
    labels: ['agent:implement', 'needs:human'], events: heldBy('example-merger[bot]'), comments: [escalation('checks-failed', OLD)],
  }),
  'a changed spec': implementerPr({
    files: [{ filename: 'docs/qa/specs/storefront.md', patch: '@@ -3,1 +3,1 @@\n-- `[STORE-2]` `[seed]` x\n+- `[STORE-2]` `[confirmed]` x', changes: 2 }],
  }),
  'a conflict the rebase lane tried': implementerPr({
    mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', comments: [{ login: 'example-implementer[bot]', body: `Resolving.\n${rebaseMarker(HEAD)}`, at: '2026-10-25T11:00:00Z' }],
  }),
  // Anyone may comment: a marker counts only from the Implementer App (kanon#1486).
  'a conflict with a forged attempt marker': implementerPr({
    mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', comments: [{ login: 'octo', body: `Resolving.\n${rebaseMarker(HEAD)}`, at: '2026-10-25T11:00:00Z' }],
  }),
  'a head the merge queue removed': implementerPr({
    queue: { enabled: true, queued: false, removed: { reason: 'FAILED_CHECKS', at: '2026-10-25T11:30:00Z' } },
    comments: [{ login: 'example-merger[bot]', body: `${MERGER_HEADER}\n\nQueued.\n\n${mergerMarker('queued', HEAD)}`, at: '2026-10-25T11:20:00Z' }],
  }),
  'a workflow that failed to load': implementerPr({ failedRuns: [{ name: '.github/workflows/ci.yml', conclusion: 'failure' }] }),
  'a stale approval and a changes-request on the head': implementerPr({ reviews: [approval(1, OLD), approval(2, HEAD, 'CHANGES_REQUESTED')] }),
  "a person's": personPr(),
};

describe('the readiness view feeds the merge gate the shape readPr builds', () => {
  it.each(Object.keys(SHAPES))('[STAT-7] builds readPr\'s pull request from the same world, through the reader: %s', async (name) => {
    const w = SHAPES[name]!;
    const r = readerFor(w);
    const { pr } = await readPullRequest(r.reader, REPO, w.number, { merger: 'example-merger', implementer: 'example-implementer' });
    const viaGh = gateOver(w);
    expect(pr).toEqual(viaGh.pr);
    // So the gate, given the same reads, answers the same, and the view reports that answer.
    const { v } = await view(w);
    expect(v.verdict).toEqual({ action: viaGh.verdict.action, rule: viaGh.verdict.rule, why: viaGh.verdict.why });
  });

  it('counts the rebase lane\'s attempt only from the Implementer App, in both reads (kanon#1486)', async () => {
    const tried = SHAPES['a conflict the rebase lane tried']!;
    const forged = SHAPES['a conflict with a forged attempt marker']!;
    for (const [w, attempted] of [[tried, true], [forged, false]] as const) {
      const { pr } = await readPullRequest(readerFor(w).reader, REPO, w.number, { merger: 'example-merger', implementer: 'example-implementer' });
      expect(pr.rebaseAttempted, 'the view').toBe(attempted);
      expect(gateOver(w).pr.rebaseAttempted, 'the gate').toBe(attempted);
    }
  }, GATE_READS_TIMEOUT);
});

describe('what the readiness view gives', () => {
  it('[STAT-6] gives the checks as the gate partitions them, the verdict and its currency, the closed issues\' criteria, and the gate\'s verdict', async () => {
    const w = implementerPr({
      checks: [
        ci('test'), ci('e2e', 'CANCELLED'), ci('e2e', 'SUCCESS', { completedAt: '2026-10-25T10:09:00Z' }), ci('lint', 'FAILURE'), ci('build', null),
        { kind: 'CheckRun', name: 'review / review', workflow: 'Review (Reviewer)', status: 'IN_PROGRESS', conclusion: null },
      ],
    });
    const { v } = await view(w);
    const { pr, verdict } = gateOver(w);
    const parts = checkPartition(pr.checks);
    const names = (cs: Any[]) => cs.map((c) => c.name);
    expect(v.checks.pending).toEqual(names(parts.pending));
    expect(v.checks.cancelled).toEqual(names(parts.cancelled));
    expect(v.checks.failed).toEqual(names(parts.failed));
    expect(v.checks.relevant.map((c: Any) => c.name)).toEqual(names(parts.relevant));
    expect(v.checks.relevant.map((c: Any) => c.name), "the Reviewer's own run is not a check on the merge").not.toContain('review / review');
    expect([v.checks.pending, v.checks.failed, v.checks.cancelled]).toEqual([['build'], ['lint'], []]);
    expect(v.checks.relevant[0]).toEqual({ name: 'test', workflow: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' });

    // The gate's verdict, with its rule and its reason.
    expect(v.verdict).toEqual({ action: verdict.action, rule: verdict.rule, why: verdict.why });
    expect(v.verdict).toMatchObject({ action: 'wait', rule: 'checks-pending' });

    // The Reviewer's latest verdict: current only when the commit it read is the head.
    expect(v.review).toEqual({ state: 'APPROVED', commit: HEAD, current: true });
    const stale = (await view(implementerPr({ reviews: [approval(1, OLD)] }))).v;
    expect(stale.review).toEqual({ state: 'APPROVED', commit: OLD, current: false });
    // GitHub files a review under the head it was submitted on; the stamp says what it read.
    const misfiled = implementerPr({ reviews: [{ ...approval(1, OLD), commit: HEAD }] });
    expect((await view(misfiled)).v.review).toEqual({ state: 'APPROVED', commit: OLD, current: false });
    const latest = (await view(implementerPr({ reviews: [approval(1), approval(2, HEAD, 'CHANGES_REQUESTED')] }))).v;
    expect(latest.review).toEqual({ state: 'CHANGES_REQUESTED', commit: HEAD, current: true });
    expect((await view(implementerPr({ reviews: [] }))).v.review).toBeNull();

    // The criteria of the issues it closes, with their status in the spec layer.
    expect(v.closes).toEqual([{
      number: 12,
      acs: [
        { id: 'STORE-2', declared: true, clause: 'confirmed' },
        { id: 'STORE-99', declared: true, clause: null },
        { id: 'STORE-1', declared: false, clause: 'seed' },
      ],
    }]);
    expect(v).toMatchObject({ number: NUMBER, state: 'OPEN', draft: false, author: 'app/example-implementer', head: HEAD, branch: 'main', title: w.title });
  });

  it('[STAT-1] reads only through its reader, asking REST GETs and GraphQL queries, and writes nothing while it reads', async () => {
    const w = briefPr('Which store? ⛔ OPEN', { labels: ['needs:human'], events: heldBy('octo'), checks: [ci('test', 'FAILURE')] });
    const { v, seen, queries } = await view(w);
    expect(v.readiness.ready).toBe(false);
    for (const s of seen) expect(s, s).toMatch(/^(GET|PAGES|GraphQL) /);
    for (const q of queries) expect(q.trimStart(), q.slice(0, 60)).toMatch(/^query\s/);

    // In a process of its own, every write, child process and fetch replaced once the core is
    // loaded, in an empty working directory: the core reads no App register from it (kanon#1396).
    const dir = mkdtempSync(join(tmpdir(), 'status-readiness-'));
    const answers: Record<string, unknown> = {};
    const record = readerFor(w);
    for (const s of seen) {
      const [kind, ...rest] = s.split(' ');
      const path = rest.join(' ');
      const asked = (fn: () => unknown) => { try { return fn(); } catch { return null; } };
      if (kind === 'GET') answers[`GET ${path}`] = asked(() => record.reader.get(path));
      if (kind === 'PAGES') answers[`PAGES ${path}`] = asked(() => record.reader.pages(path));
    }
    answers.graphql = record.reader.graphql('query PullRequestGate { x }', { number: NUMBER });
    const script = `
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const { readinessView } = await import(${JSON.stringify(join(ROOT, 'scripts/status/pull-request.mjs'))});
      const calls = [];
      const record = (name) => (...args) => { calls.push(name + ' ' + String(args[0])); throw new Error('the core must not ' + name); };
      for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'openSync', 'readFileSync', 'readdirSync', 'existsSync', 'statSync', 'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'createWriteStream']) fs[name] = record('fs.' + name);
      for (const k of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'readFile', 'readdir', 'open']) fs.promises[k] = record('fs.promises.' + k);
      for (const name of ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'exec', 'execFile', 'fork']) cp[name] = record('child_process.' + name);
      globalThis.fetch = record('fetch');
      syncBuiltinESMExports();
      const answers = JSON.parse(process.argv[1]);
      const answer = (key) => { const r = answers[key]; if (r === undefined || r === null) throw Object.assign(new Error('not found'), { status: 404 }); return r; };
      const reader = { get: (p) => answer('GET ' + p), pages: (p) => answer('PAGES ' + p), graphql: () => answers.graphql };
      let view;
      try { view = await readinessView({ reader, repo: ${JSON.stringify(REPO)}, pr: ${NUMBER}, now: ${READ_AT} }); } catch (e) { view = { error: e.message }; }
      console.log(JSON.stringify({ calls, view }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(answers)], { cwd: dir, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    const out = JSON.parse(run.stdout);
    expect(out.calls, 'no file read or written, no process started, no other network').toEqual([]);
    expect(out.view.error, 'and the view was answered').toBeUndefined();
    expect(out.view.readiness).toEqual(v.readiness);
    expect(readdirSync(dir), 'nothing left behind').toEqual([]);
  });

  it('[STAT-3] answers a read that failed with an error naming it, never a partial view', async () => {
    const limited = await readinessView({
      reader: readerFor(implementerPr(), { pages: (p: string) => { if (p.endsWith('/reviews?per_page=100')) throw new ReadError(`GET ${p}`, 'API rate limit exceeded', { status: 403, resetAt: '2026-10-25T13:00:00.000Z' }); return undefined; } }).reader,
      repo: REPO, pr: NUMBER, now: READ_AT,
    }).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(IncompleteRead);
    expect((limited as Error).message).toMatch(/pull request #42 couldn't be read whole, so there is no answer: GET repos\/acme\/shop\/pulls\/42\/reviews\?per_page=100 failed: API rate limit exceeded \(the rate limit resets at 2026-10-25T13:00:00.000Z\)/);

    // A listing cut short: more failed runs on the head than came back.
    const cut = readerFor(implementerPr(), { pages: (p: string) => (p.includes('/actions/runs?') ? [{ total_count: 140, workflow_runs: [] }] : undefined) });
    await expect(readinessView({ reader: cut.reader, repo: REPO, pr: NUMBER, now: READ_AT })).rejects.toThrow(/cut short: 0 of 140/);
    // Over a hundred labels, contexts or closing issues is a cut-short read, not the first hundred.
    const many = readerFor(implementerPr(), { graphql: { PullRequestGate: () => ({ repository: { pullRequest: { ...gateNode(implementerPr()), labels: { nodes: [], totalCount: 101 } } } }) } });
    await expect(readinessView({ reader: many.reader, repo: REPO, pr: NUMBER, now: READ_AT })).rejects.toThrow(/labels.*cut short: 0 of 101/);
    // No such pull request.
    await expect(readinessView({ reader: readerFor(implementerPr()).reader, repo: REPO, pr: 404, now: READ_AT })).rejects.toThrow(/pull request #404 couldn't be read whole.*Could not resolve to a PullRequest/);
    // A brief at the head that can't be read is no answer either.
    const gone = briefPr('Which store? ✅ ANSWERED', { headFiles: {} });
    await expect(readinessView({ reader: readerFor(gone).reader, repo: REPO, pr: NUMBER, now: READ_AT })).rejects.toThrow(/docs\/projects\/9\.md/);
  });
});

/** The pull request node the reader answers for a world, for a test that alters one field. */
const gateNode = (w: PrWorld) => (readerFor(w).reader.graphql('query PullRequestGate { x }', { number: w.number }) as Any).repository.pullRequest;

describe("an Implementer's pull request is ready only when the merge gate says so", () => {
  it("[STAT-7] is ready for the Merger on merge, for a person's merge on an escalation path alone, and never on its own judgement", async () => {
    const green = (await view(implementerPr())).v;
    expect(green.verdict).toMatchObject({ action: 'merge', rule: 'green-zone' });
    expect(green.readiness).toMatchObject({ by: 'merger', ready: true, lacks: [] });

    // An escalation path, approved on the head and green: a person's merge, ready.
    const path = implementerPr({ files: [{ filename: 'migrations/001.sql' }] });
    const owner = (await view(path)).v;
    expect(owner.verdict).toMatchObject({ action: 'escalate', rule: 'escalating-path' });
    expect(owner.readiness).toMatchObject({ by: 'person', ready: true, lacks: [] });
    // Still, once the Merger has labelled it for that path: the label is the path's.
    const labelled = implementerPr({
      files: [{ filename: 'migrations/001.sql' }], labels: ['agent:implement', 'needs:human'], events: heldBy('example-merger[bot]'), comments: [escalation('escalating-path')],
    });
    expect((await view(labelled)).v.readiness).toMatchObject({ by: 'person', ready: true });

    // Not the path alone: a check that failed, a stale approval, a person's hold beside it.
    const failing = (await view(implementerPr({ files: [{ filename: 'migrations/001.sql' }], checks: [ci('test', 'FAILURE')] }))).v;
    expect(failing.verdict.rule).toBe('escalating-path');
    expect(failing.readiness).toMatchObject({ by: 'person', ready: false });
    expect(failing.readiness.lacks.length).toBeGreaterThan(0);
    const stale = (await view(implementerPr({ files: [{ filename: 'migrations/001.sql' }], reviews: [approval(1, OLD)] }))).v;
    expect(stale.readiness).toMatchObject({ by: 'person', ready: false });
    const personsHold = implementerPr({ files: [{ filename: 'migrations/001.sql' }], labels: ['agent:implement', 'needs:human'], events: heldBy('octo') });
    expect((await view(personsHold)).v.readiness).toMatchObject({ ready: false });

    // Every other answer of the gate is not ready, and the gate's rule is what it lacks.
    // An escalation is a person's to decide; anything else stays the Merger's.
    for (const [w, rule, by] of [
      [implementerPr({ checks: [ci('test', null)] }), 'checks-pending', 'merger'],
      [implementerPr({ reviews: [] }), 'no-review-on-head', 'merger'],
      [implementerPr({ reviews: [approval(1, HEAD, 'CHANGES_REQUESTED')] }), 'changes-requested', 'merger'],
      [implementerPr({ checks: [ci('test', 'FAILURE')] }), HANDBACK, 'merger'],
      [implementerPr({ labels: ['agent:implement', 'blocked'] }), 'escalating-label', 'person'],
      [implementerPr({ isDraft: true }), 'draft', 'person'],
    ] as Array<[PrWorld, string, string]>) {
      const { v } = await view(w);
      expect(v.verdict.rule).toBe(rule);
      expect(v.verdict).toEqual((({ action, rule: r, why }) => ({ action, rule: r, why }))(gateOver(w).verdict));
      expect(v.readiness, rule).toMatchObject({ by, ready: false, lacks: [rule] });
    }

    // The Implementer's pull request is never judged by the person's three conditions: green,
    // approved and decision-free, it is still the gate's to answer, and the gate says wait.
    const unsettled = (await view(implementerPr({ mergeStateStatus: 'UNKNOWN' }))).v;
    expect(checkPartition(gateOver(implementerPr({ mergeStateStatus: 'UNKNOWN' })).pr.checks).failed).toEqual([]);
    expect(unsettled.verdict.rule).toBe('merge-state-unknown');
    expect(unsettled.readiness).toMatchObject({ by: 'merger', ready: false, lacks: ['merge-state-unknown'] });
  }, GATE_READS_TIMEOUT);
});

describe("any other pull request is a person's to merge", () => {
  it("[STAT-14] is a person's, ready only on the gate's check partition, no conflict, a current approval and, for a brief, no open decision, and names what it lacks", async () => {
    const ready = (await view(personPr())).v;
    expect(ready.verdict).toMatchObject({ action: 'skip', rule: 'not-the-implementer' });
    expect(ready.readiness).toMatchObject({ by: 'person', ready: true, lacks: [] });
    expect(ready.decisions, 'not a brief, so no decision is read').toBeNull();

    // Each of the four, alone, and what it lacks.
    const cases: Array<[string, PrWorld, string[]]> = [
      ['no check at all', personPr({ checks: [] }), ['checks']],
      ['only the pipeline\'s own check', personPr({ checks: [{ kind: 'CheckRun', name: 'review / review', workflow: 'Review (Reviewer)', status: 'COMPLETED', conclusion: 'SUCCESS' }] }), ['checks']],
      ['a check still running', personPr({ checks: [ci('test', null)] }), ['checks']],
      ['a check cancelled', personPr({ checks: [ci('test', 'CANCELLED')] }), ['checks']],
      ['a check failed', personPr({ checks: [ci('test', 'FAILURE')] }), ['checks']],
      ['a conflict GitHub reports', personPr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), ['mergeable']],
      ['a conflict in the state alone', personPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }), ['mergeable']],
      ['no review', personPr({ reviews: [] }), ['approval']],
      ['an approval of an older head', personPr({ reviews: [approval(1, OLD)] }), ['approval']],
      ['changes requested on the head', personPr({ reviews: [approval(1, HEAD, 'CHANGES_REQUESTED')] }), ['approval']],
      ['an approval from someone else', personPr({ reviews: [{ ...approval(1), login: 'octo' }] }), ['approval']],
      ['an open decision in a brief', briefPr('Which store? ⛔ OPEN'), ['decisions']],
      ['all four', briefPr('Which store? PROPOSED', { checks: [ci('test', 'FAILURE')], reviews: [], mergeable: 'CONFLICTING' }), ['checks', 'mergeable', 'approval', 'decisions']],
    ];
    for (const [name, w, lacks] of cases) {
      const { v } = await view(w);
      expect(v.readiness, name).toMatchObject({ by: 'person', ready: false, lacks });
      expect(v.readiness.why, name).toMatch(lacks.includes('decisions') ? /decision/ : lacks.includes('approval') ? /approv/ : lacks.includes('mergeable') ? /conflicts with its base branch/ : /check/);
      // Composed of the functions themselves.
      const { pr } = gateOver(w);
      const p = checkPartition(pr.checks);
      const green = p.relevant.length > 0 && !p.pending.length && !p.cancelled.length && !p.failed.length;
      const onHead = verdictOnHead({ headRefOid: pr.headSha, reviews: pr.reviews.map((r: Any) => ({ author: { login: r.author }, state: r.state, body: r.body, commit: { oid: r.sha } })) });
      expect(lacks.includes('checks'), name).toBe(!green);
      expect(lacks.includes('approval'), name).toBe(onHead?.state !== 'APPROVED');
      expect(lacks.includes('mergeable'), name).toBe(conflictState(pr) === 'conflicting');
    }

    // The brief guard's read: an answered mark wins over an open one, and a pre-standard brief
    // (the default branch's exemptions file lists `docs/projects/2.md`) isn't checked.
    const brief = (await view(briefPr('Which store? ⛔ OPEN'))).v;
    expect(brief.decisions).toEqual([{ brief: 'docs/projects/9.md', n: 1, headline: 'Which store? ⛔ OPEN', marker: '⛔' }]);
    const answered = (await view(briefPr('Which store? Was OPEN, now ✅ ANSWERED: Postgres.'))).v;
    expect(answered.decisions).toEqual([]);
    expect(answered.readiness).toMatchObject({ by: 'person', ready: true, lacks: [] });
    const preStandard = (await view(briefPr('Which store? ⛔ OPEN', {}, 'docs/projects/2.md'))).v;
    expect(preStandard.decisions).toEqual([]);
    expect(preStandard.readiness.ready).toBe(true);
    // Without an exemptions file on the default branch, Kanon's default: no brief is exempt.
    const noFile = briefPr('Which store? ⛔ OPEN', {}, 'docs/projects/2.md');
    const without = Object.fromEntries(Object.entries(noFile.defaultFiles).filter(([p]) => p !== 'docs/qa/exemptions.md'));
    expect((await view({ ...noFile, defaultFiles: without })).v.readiness.lacks).toEqual(['decisions']);
    // The exemptions file is read from the default branch, never from the pull request.
    const added = briefPr('Which store? ⛔ OPEN', { headFiles: { 'docs/projects/9.md': briefText('Which store? ⛔ OPEN'), 'docs/qa/exemptions.md': '# Exemptions\n\n## Pre-standard briefs\n\n- `docs/projects/9.md` — mine\n' } });
    expect((await view(added)).v.readiness.lacks).toEqual(['decisions']);
    // A brief the pull request deletes has no decision to read.
    expect((await view(briefPr('x', { files: [{ filename: 'docs/projects/9.md', status: 'removed' }], headFiles: {} }))).v.decisions).toEqual([]);

    // Whoever opened it, and whatever the gate skips it as: not the Implementer's login, marker or
    // status, or its pull request without the Implementer's label. Never the Merger's.
    const unlabelled = implementerPr({ labels: ['enhancement'] });
    const skipped: Array<[PrWorld, string]> = [
      [personPr(), 'not-the-implementer'],
      [briefPr('Which store? ✅'), 'not-the-implementer'],
      [personPr({ author: { type: 'Bot', login: 'dependabot' }, body: 'Bumps x.' }), 'not-the-implementer'],
      [personPr({ author: { type: 'Bot', login: 'example-releaser' }, body: 'Release.', labels: ['autorelease: pending'] }), 'not-the-implementer'],
      [implementerPr({ statuses: [] }), 'not-the-implementer'],
      [unlabelled, 'not-implementer-label'],
    ];
    for (const [w, rule] of skipped) {
      const { v } = await view(w);
      expect(v.verdict.rule).toBe(rule);
      expect(v.readiness.by, rule).toBe('person');
      expect(v.readiness.ready, rule).toBe(true);
    }
    // And no other test: a person's pull request is ready while GitHub is still computing whether it
    // conflicts, and though GitHub says it is blocked, which the gate would refuse the
    // Implementer's for.
    expect((await view(personPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))).v.readiness.ready).toBe(true);
    expect((await view(personPr({ mergeStateStatus: 'BLOCKED', labels: ['blocked'] }))).v.readiness.ready).toBe(true);
  }, GATE_READS_TIMEOUT);

  it("[STAT-14] reads the Reviewer's latest verdict on the head, in either order, as the view's review field does", async () => {
    const changedThenApproved = (await view(personPr({ reviews: [approval(1, HEAD, 'CHANGES_REQUESTED'), approval(2, HEAD)] }))).v;
    expect(changedThenApproved.review).toMatchObject({ state: 'APPROVED', current: true });
    expect(changedThenApproved.readiness).toMatchObject({ by: 'person', ready: true, lacks: [] });
    const approvedThenChanged = (await view(personPr({ reviews: [approval(1, HEAD), approval(2, HEAD, 'CHANGES_REQUESTED')] }))).v;
    expect(approvedThenChanged.review).toMatchObject({ state: 'CHANGES_REQUESTED', current: true });
    expect(approvedThenChanged.readiness).toMatchObject({ by: 'person', ready: false, lacks: ['approval'] });
    expect(approvedThenChanged.readiness.why).toMatch(/requested changes/);
  });
});

describe('the readiness view judges by the default branch\'s register, and loads where there is none (kanon#1396)', () => {
  // The default branch's register names other Apps than the checkout's: this tier runs inside the
  // fixture adopter, whose register names `example-*`. So a view that compared any login of the
  // working directory's would not read this pull request as the Implementer's, or its hold as
  // the Merger's.
  const REGISTER = 'docs/qa/agent-identities.md';
  const shopFiles = () => {
    const files = DEFAULT_FILES();
    files[REGISTER] = files[REGISTER]!.replaceAll('`example-', '`shop-');
    return files;
  };
  /** The Implementer's pull request as the shop's Apps made it, held by the shop's Merger for a check that failed on an old head. */
  const shopPr = (over: Partial<PrWorld> = {}) => implementerPr({
    author: { type: 'Bot', login: 'shop-implementer' },
    statuses: [{ context: IMPLEMENTER_STATUS, state: 'success', creator: 'shop-implementer[bot]' }],
    reviews: [{ ...approval(1), login: 'shop-reviewer[bot]' }],
    labels: ['agent:implement', 'needs:human'],
    events: heldBy('shop-merger[bot]'),
    comments: [{ ...escalation('checks-failed', OLD), login: 'shop-merger[bot]' }],
    defaultFiles: shopFiles(),
    ...over,
  });

  /** The view of `w`, answered in a process of its own whose working directory is an empty temp directory. */
  const inBareDirectory = (w: PrWorld) => {
    const dir = mkdtempSync(join(tmpdir(), 'status-bare-'));
    const record = readerFor(w);
    const seen = readerFor(w);
    // The reads the view makes, answered from the world: run it once here to learn them.
    return readinessView({ reader: seen.reader, repo: REPO, pr: w.number, now: READ_AT }).catch(() => null).then(() => {
      const answers: Record<string, unknown> = {};
      const asked = (fn: () => unknown) => { try { return fn(); } catch { return null; } };
      for (const s of seen.seen) {
        const [kind, ...rest] = s.split(' ');
        const path = rest.join(' ');
        if (kind === 'GET') answers[`GET ${path}`] = asked(() => record.reader.get(path));
        if (kind === 'PAGES') answers[`PAGES ${path}`] = asked(() => record.reader.pages(path));
      }
      answers.graphql = record.reader.graphql('query PullRequestGate { x }', { number: w.number });
      const script = `
        const { readinessView } = await import(${JSON.stringify(join(ROOT, 'scripts/status/pull-request.mjs'))});
        const answers = JSON.parse(process.argv[1]);
        const answer = (key) => { const r = answers[key]; if (r === undefined || r === null) throw Object.assign(new Error('not found'), { status: 404 }); return r; };
        const reader = { get: (p) => answer('GET ' + p), pages: (p) => answer('PAGES ' + p), graphql: () => answers.graphql };
        let view;
        try { view = await readinessView({ reader, repo: ${JSON.stringify(REPO)}, pr: ${w.number}, now: ${READ_AT} }); } catch (e) { view = { error: e.message }; }
        console.log(JSON.stringify(view));
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(answers)], { cwd: dir, encoding: 'utf8' });
      expect(readdirSync(dir), 'the working directory stays empty').toEqual([]);
      return { run, view: run.stdout ? JSON.parse(run.stdout) : null };
    });
  };

  it('[STAT-2] loads and answers with no App register in its working directory, by the default branch\'s logins, read through the reader', async () => {
    const { run, view: bare } = await inBareDirectory(shopPr());
    expect(run.stderr).toBe('');
    expect(bare.error, 'the view loaded and answered').toBeUndefined();
    // The shop's Implementer's pull request, approved by the shop's Reviewer, held by the shop's
    // Merger for a failure on a head that is gone: the gate lifts that hold.
    expect(bare.verdict).toMatchObject({ action: 'release' });
    expect(bare.review).toEqual({ state: 'APPROVED', commit: HEAD, current: true });
    // The same answer the view gives in the checkout, whose register names other Apps.
    expect(bare.verdict).toEqual((await view(shopPr())).v.verdict);
  });

  it("[STAT-2] reads a needs:human hold as the Merger's only by the default branch's Merger, not the checkout's", async () => {
    // The shop's Merger's hold lapses with its head; the checkout's Merger's label is a stranger's
    // to the shop, so it is a person's hold and stays.
    expect((await view(shopPr())).v.verdict).toMatchObject({ action: 'release' });
    const byCheckoutsMerger = shopPr({ events: heldBy('example-merger[bot]'), comments: [escalation('checks-failed', OLD)] });
    expect((await view(byCheckoutsMerger)).v.verdict).toMatchObject({ action: 'escalate', rule: 'escalating-label' });
    const bare = (await inBareDirectory(byCheckoutsMerger)).view;
    expect(bare.verdict).toMatchObject({ action: 'escalate', rule: 'escalating-label' });
  });

  it('stops, naming the role, when the default branch\'s register lists no login for one the gate compares', async () => {
    const files = shopFiles();
    files[REGISTER] = files[REGISTER]!.split('\n').filter((l) => !l.startsWith('| Merger |')).join('\n');
    await expect(readinessView({ reader: readerFor(shopPr({ defaultFiles: files })).reader, repo: REPO, pr: NUMBER, now: READ_AT }))
      .rejects.toThrow(/docs\/qa\/agent-identities\.md on `main` lists no Merger App/);
    const none = shopFiles();
    delete none[REGISTER];
    await expect(readinessView({ reader: readerFor(shopPr({ defaultFiles: none })).reader, repo: REPO, pr: NUMBER, now: READ_AT }))
      .rejects.toThrow(/acme\/shop has no App register/);
  });
});
