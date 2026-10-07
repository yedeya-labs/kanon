import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SPAWNS } from './helpers/spawns.js';

const { CONTEXT, byApp, carryDecision, pickOpened } = await import('../../actions/implementer-status/implementer-status.mjs');

/**
 * The implementer commit status, `kanon/role: implementer` (plan 0005 §3.3, question 6; step
 * L3). A fixed step of the Implementer's lanes sets it, never the agent, and since L4 the Merger
 * requires it (`tests/library/two-apps.test.ts`). The decisions are pure and held here case by case; the wiring below holds every lane
 * to "a job after the agent's, holding no agent".
 */

const REPO = 'acme/widgets';
const SLUG = 'acme-implementer';
const EMAIL = `42+${SLUG}[bot]@users.noreply.github.com`;
const SINCE = '2026-10-05T10:00:00Z';
const before = ['main', 'feat/1-old'];
const sha = (c: string) => c.repeat(40);
const commitBy = (s: string, email = EMAIL, parents: string[] = []) => ({ sha: s, parents: parents.map((p) => ({ sha: p })), commit: { author: { email } } });
const pr = (number: number, ref: string, head: string, created = '2026-10-05T10:30:00Z', repo = REPO) =>
  ({ number, created_at: created, head: { ref, sha: head, repo: { full_name: repo } } });
// The heads this run's agent job held when the agent finished (#324). By default, the one head
// `sha('a')`, on the branch the cases below call this run's.
const ours = [{ ref: 'feat/1-new', sha: sha('a') }, { ref: 'HEAD', sha: sha('a') }];
const opened = (prs: ReturnType<typeof pr>[], commits: Record<string, ReturnType<typeof commitBy>>, over: Record<string, unknown> = {}) =>
  pickOpened({ prs, repo: REPO, since: SINCE, branchesBefore: before, email: EMAIL, heads: ours, headCommit: (s: string) => commits[s], ...over });

// Its cases run the step in `bash` against a stub `gh`, so the block takes the spawn budget (#436).
describe('the summary an adopter reads when the App lacks Commit statuses write (L4)', SPAWNS, () => {
  it('says what now requires the status, and no longer that nothing does', () => {
    const src = readFileSync('actions/implementer-status/implementer-status.mjs', 'utf8');
    expect(src).not.toMatch(/until L4/);
    expect(src).toMatch(/the Merger skips this pull request as \\`not-the-implementer\\`, and the revise and rebase lanes refuse it/);
  });

  // #474: an adopter installs the Author App, which holds the Implementer; there is no
  // Implementer's App to grant the permission to.
  it('names the Author App, the one the adopter installs, as the App to grant the permission', () => {
    const say = (env: Record<string, string>) => execFileSync('node', ['actions/implementer-status/implementer-status.mjs'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_REPOSITORY: REPO, ...env },
    });
    const noRead = say({});
    expect(noRead).toContain('the Author App (the Implementer\'s) could not mint a read token');
    const noWrite = say({ APP_SLUG: SLUG, READ_TOKEN: 'read' });
    expect(noWrite).toContain('the Author App (the Implementer\'s) could not mint a token with Commit statuses write. Grant it that permission');
    for (const out of [noRead, noWrite]) expect(out).not.toMatch(/Implementer's App/);
  });
});

describe('open: the first status goes only on the pull request this run opened', () => {
  it('stamps the one PR opened after the run started, from a new branch, at a head the App authored', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) })).toEqual({ pr: 7, sha: sha('a') });
  });

  it('never stamps a forged PR already open before the run, though it closes the same issue', () => {
    // Opened before `since`, from a branch the snapshot lists: two independent refusals.
    const forged = pr(6, 'feat/1-old', sha('f'), '2026-10-05T09:00:00Z');
    expect(opened([forged], { [sha('f')]: commitBy(sha('f')) })).toMatchObject({ none: expect.stringMatching(/no open pull request/) });
    // Even opened during the run, a branch that existed before it is not this run's.
    expect(opened([pr(6, 'feat/1-old', sha('f'))], { [sha('f')]: commitBy(sha('f')) })).toMatchObject({ none: expect.any(String) });
    // And beside the real one, it changes nothing.
    expect(opened([forged, pr(7, 'feat/1-new', sha('a'))], { [sha('f')]: commitBy(sha('f')), [sha('a')]: commitBy(sha('a')) })).toEqual({ pr: 7, sha: sha('a') });
  });

  it('never stamps a PR from a new branch that was opened before the run started', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'), '2026-10-05T09:59:59Z')], { [sha('a')]: commitBy(sha('a')) })).toHaveProperty('none');
  });

  it('stamps neither of two candidates its own job held, and says so by number', () => {
    const v = opened([pr(7, 'feat/1-new', sha('a')), pr(8, 'feat/1-other', sha('b'))], { [sha('a')]: commitBy(sha('a')), [sha('b')]: commitBy(sha('b')) }, {
      heads: [...ours, { ref: 'feat/1-other', sha: sha('b') }],
    });
    expect(v).toEqual({ none: expect.stringContaining('2 pull requests match (#7, #8)') });
  });

  // #324: the App's email is every Author run's, so it binds no pull request to a run.
  it('two overlapping runs of the shared App each stamp their own pull request, by the head their job pushed', () => {
    // Run A started at SINCE, run B a little later; each opened one PR before either status job
    // read the list, so each sees both: opened after its start, from a new branch, App-authored.
    const both = [pr(7, 'feat/1-new', sha('a'), '2026-10-05T10:30:00Z'), pr(8, 'feat/2-new', sha('b'), '2026-10-05T10:31:00Z')];
    const commits = { [sha('a')]: commitBy(sha('a')), [sha('b')]: commitBy(sha('b')) };
    expect(opened(both, commits)).toEqual({ pr: 7, sha: sha('a') });
    expect(opened(both, commits, { since: '2026-10-05T10:10:00Z', heads: [{ ref: 'feat/2-new', sha: sha('b') }] })).toEqual({ pr: 8, sha: sha('b') });
  });

  it('a run that pushed no pull request stamps nothing, though another Author lane opened one during it', () => {
    const lanes = [pr(9, 'feat/3-lead', sha('c'))];
    const commits = { [sha('c')]: commitBy(sha('c')) };
    // Its job held only the default branch's head it checked out, or nothing at all.
    expect(opened(lanes, commits, { heads: [{ ref: 'main', sha: sha('0') }, { ref: 'HEAD', sha: sha('0') }] })).toMatchObject({ none: expect.stringMatching(/at a head this run's agent job pushed \(it held main@0000000, HEAD@0000000\)/) });
    expect(opened(lanes, commits, { heads: [] })).toMatchObject({ none: expect.stringMatching(/it held none/) });
  });

  it('matches the head, not the branch name: a PR whose branch the job held at another commit is not this run\'s', () => {
    expect(opened([pr(7, 'feat/1-new', sha('d'))], { [sha('d')]: commitBy(sha('d')) })).toHaveProperty('none');
  });

  it('stamps nothing when the heads the agent\'s job held are unknown', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) }, { heads: null })).toMatchObject({ none: expect.stringMatching(/heads the agent's job held are unknown/) });
  });

  it('refuses a head the App did not author, a fork\'s branch, and an unknown start or snapshot', () => {
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a'), 'person@example.com') })).toHaveProperty('none');
    expect(opened([pr(7, 'feat/1-new', sha('a'), undefined, 'fork/widgets')], { [sha('a')]: commitBy(sha('a')) })).toHaveProperty('none');
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) }, { since: '' })).toMatchObject({ none: expect.stringMatching(/start time/) });
    expect(opened([pr(7, 'feat/1-new', sha('a'))], { [sha('a')]: commitBy(sha('a')) }, { branchesBefore: null })).toMatchObject({ none: expect.stringMatching(/branches/) });
  });

  it('recognises the App by its noreply email, not the persona in the author\'s name', () => {
    expect(byApp({ sha: 'x', commit: { author: { email: EMAIL.toUpperCase() } } }, EMAIL)).toBe(true);
    expect(byApp({ sha: 'x', commit: { author: { email: 'implementer@example.com' } } }, EMAIL)).toBe(false);
  });
});

describe('carry: the status is a chain, not a stamp', () => {
  const start = sha('1');
  const mine = { context: CONTEXT, state: 'success', creator: { login: `${SLUG}[bot]` } };
  const carry = (over: Record<string, unknown>) => carryDecision({
    startHead: start, head: sha('3'), slug: SLUG, email: EMAIL, startStatuses: [mine],
    compare: { status: 'ahead', commits: [commitBy(sha('2'), EMAIL, [start]), commitBy(sha('3'), EMAIL, [sha('2')])] },
    ...over,
  });

  it('moves to the new head when the start had it and every commit since is the App\'s', () => {
    expect(carry({})).toEqual({ carry: sha('3') });
  });

  it('carries through the rebase lane\'s merge: the default branch\'s commits are its second parent', () => {
    const merge = commitBy(sha('3'), EMAIL, [start, sha('9')]);
    expect(carry({ compare: { status: 'ahead', commits: [commitBy(sha('9'), 'person@example.com', [sha('8')]), merge] } })).toEqual({ carry: sha('3') });
  });

  it('refuses a forged PR: no status on the start, or one another App created, or one not successful', () => {
    expect(carry({ startStatuses: [] })).toMatchObject({ none: expect.stringMatching(/carries no `kanon\/role: implementer` status/) });
    expect(carry({ startStatuses: [{ ...mine, creator: { login: 'acme-lead[bot]' } }] })).toHaveProperty('none');
    expect(carry({ startStatuses: [{ ...mine, state: 'pending' }] })).toHaveProperty('none');
    expect(carry({ startStatuses: [{ ...mine, context: 'kanon/role: lead' }] })).toHaveProperty('none');
  });

  it('a person\'s push ends the chain', () => {
    const v = carry({ compare: { status: 'ahead', commits: [commitBy(sha('2'), 'person@example.com', [start]), commitBy(sha('3'), EMAIL, [sha('2')])] } });
    expect(v).toMatchObject({ none: expect.stringMatching(/a person's push ends the chain/) });
  });

  it('refuses a head that doesn\'t descend from the start, an unreadable path, and an unknown start', () => {
    expect(carry({ compare: { status: 'diverged', commits: [] } })).toMatchObject({ none: expect.stringMatching(/does not descend/) });
    expect(carry({ compare: null })).toMatchObject({ none: expect.stringMatching(/unreadable/) });
    expect(carry({ compare: { status: 'ahead', commits: [commitBy(sha('3'), EMAIL, [sha('2')])] } })).toMatchObject({ none: expect.stringMatching(/could not be read whole/) });
    expect(carry({ startHead: '' })).toMatchObject({ none: expect.stringMatching(/unknown/) });
  });

  it('sets nothing when the run pushed nothing', () => {
    expect(carry({ head: start })).toMatchObject({ none: expect.stringMatching(/already carries/) });
  });
});

/** The four Implementer lanes, the job each runs its agent in, and the mode their status step uses. */
const LANES = {
  'agent-implement.yml': { agent: 'implement', mode: 'open' },
  'agent-triage.yml': { agent: 'triage-fix', mode: 'open' },
  'agent-implement-revise.yml': { agent: 'revise', mode: 'carry' },
  'agent-rebase.yml': { agent: 'resolve', mode: 'carry' },
} as const;
type Step = { uses?: string; run?: string; with?: Record<string, string>; id?: string; 'continue-on-error'?: boolean };
type Job = { needs?: string | string[]; if?: string; uses?: string; steps?: Step[]; with?: Record<string, unknown>; outputs?: Record<string, string> };
const wf = (f: string) => parse(readFileSync(`.github/workflows/${f}`, 'utf8')) as { jobs: Record<string, Job> };

describe('every Implementer lane sets it in a fixed job after its agent\'s, never in it', () => {
  it.each(Object.entries(LANES))('%s', (file, { agent, mode }) => {
    const { jobs } = wf(file);
    const job = jobs['implementer-status']!;
    expect(job, 'the lane has an implementer-status job').toBeDefined();
    expect([job.needs].flat()).toEqual(['filter', agent]);
    expect(job.if).toMatch(/!cancelled\(\)/);
    const steps = job.steps ?? [];
    // Nothing but Kanon's Node and the action: no agent, no `./` action, no checkout.
    expect(steps.map((s) => s.uses)).toEqual(['$/actions/kanon-path', '$/actions/implementer-status']);
    const call = steps[1]!;
    expect(call['continue-on-error']).toBe(true);
    expect(call.with?.mode).toBe(mode);
    expect(call.with?.['app-id']).toBe('${{ secrets.AUTHOR_APP_ID }}');
    expect(call.with?.['app-private-key']).toBe('${{ secrets.AUTHOR_APP_PRIVATE_KEY }}');
    // What the chain or the pick reads was recorded by the filter job, before any agent ran.
    const inputs = Object.values(call.with ?? {}).join(' ');
    if (mode === 'open') {
      expect(call.with?.since).toBe('${{ needs.filter.outputs.since }}');
      expect(call.with?.['branches-before']).toBe('${{ needs.filter.outputs.branches }}');
      // The one input read from the agent's job (#324): the heads its fixed step recorded after
      // the agent, which bind the pick to the head this run pushed. Nothing else of that job.
      expect(call.with?.heads).toBe(`\${{ needs.${agent}.outputs.heads }}`);
      const rest = Object.entries(call.with ?? {}).filter(([k]) => k !== 'heads').map(([, v]) => v).join(' ');
      expect(rest).not.toMatch(new RegExp(`needs\\.${agent}\\.`));
    } else {
      expect(inputs).toMatch(/needs\.filter\.outputs\.(head_sha|heads)/);
      expect(inputs).not.toMatch(new RegExp(`needs\\.${agent}\\.`));
    }
  });

  it('and no other job of any workflow calls the action', () => {
    const all = ['agent-implement.yml', 'agent-triage.yml', 'agent-implement-revise.yml', 'agent-rebase.yml', 'agent-lane.yml', 'lane-agent-job.yml', 'agent-lead.yml', 'agent-review.yml'];
    const callers = all.flatMap((f) => Object.entries(wf(f).jobs).filter(([, j]) => (j.steps ?? []).some((s) => s.uses === '$/actions/implementer-status')).map(([n]) => `${f}:${n}`));
    expect(callers.sort()).toEqual(Object.keys(LANES).map((f) => `${f}:implementer-status`).sort());
  });

  it.each(['agent-implement.yml', 'agent-triage.yml'])('%s snapshots the start and the branches in its filter job, never failing it', (file) => {
    const filter = wf(file).jobs.filter!;
    expect(filter.outputs).toMatchObject({ since: '${{ steps.before.outputs.since }}', branches: '${{ steps.before.outputs.branches }}' });
    const step = (filter.steps ?? []).find((s) => s.id === 'before')!;
    expect(step['continue-on-error']).toBe(true);
    // The time first, so nothing the listing takes can push a branch before it.
    expect(step.run!.indexOf('since=')).toBeLessThan(step.run!.indexOf('branches'));
  });

  it('the rebase lane records each PR\'s head in its filter job', () => {
    const filter = wf('agent-rebase.yml').jobs.filter!;
    expect(filter.outputs?.heads).toBe('${{ steps.heads.outputs.heads }}');
    expect((filter.steps ?? []).find((s) => s.id === 'heads')?.['continue-on-error']).toBe(true);
  });
});

// #324: the binding the `open` pick matches on, recorded by a fixed step of the agent's job.
describe('the spine records the branch heads the agent left, for the open pick', () => {
  type SpineStep = Step & { name?: string; if?: string };
  const spine = parse(readFileSync('.github/workflows/lane-agent-job.yml', 'utf8')) as {
    on: { workflow_call: { outputs: Record<string, { value: string }> } }; jobs: { run: { outputs: Record<string, string>; steps: SpineStep[] } };
  };
  const steps = spine.jobs.run.steps;
  const at = (id: string) => steps.findIndex((s) => s.id === id);
  const record = steps[at('heads')]!;

  it('after the agent, never failing the job, and passed up through both spines', () => {
    expect(at('heads')).toBeGreaterThan(at('agent'));
    expect(at('heads')).toBeLessThan(at('finish'));
    expect(record.if).toMatch(/^always\(\)/);
    expect(record['continue-on-error']).toBe(true);
    expect(record.uses).toBeUndefined();
    expect(spine.jobs.run.outputs.heads).toBe('${{ steps.heads.outputs.heads }}');
    expect(spine.on.workflow_call.outputs.heads?.value).toBe('${{ jobs.run.outputs.heads }}');
    const lane = parse(readFileSync('.github/workflows/agent-lane.yml', 'utf8')) as { on: { workflow_call: { outputs: Record<string, { value: string }> } } };
    expect(lane.on.workflow_call.outputs.heads?.value).toBe('${{ jobs.run.outputs.heads }}');
  });

  it('lists the local branches and HEAD, and not a branch a `git fetch` brought in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'implementer-heads-'));
    try {
      const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'feat/7-mine');
      git('commit', '-q', '--allow-empty', '-m', 'mine');
      const mine = git('rev-parse', 'HEAD');
      // Another run's branch, as a fetch leaves it: a remote-tracking ref, no local branch.
      git('commit', '-q', '--allow-empty', '-m', 'theirs');
      git('update-ref', 'refs/remotes/origin/feat/8-theirs', 'HEAD');
      const theirs = git('rev-parse', 'HEAD');
      git('reset', '-q', '--hard', mine);
      const out = join(dir, '.out');
      execFileSync('bash', ['-c', record.run!], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out } });
      const line = readFileSync(out, 'utf8').trim();
      expect(line.startsWith('heads=')).toBe(true);
      const heads = JSON.parse(line.slice('heads='.length)) as Array<{ ref: string; sha: string }>;
      expect(heads).toEqual(expect.arrayContaining([{ ref: 'main', sha: base }, { ref: 'feat/7-mine', sha: mine }, { ref: 'HEAD', sha: mine }]));
      expect(heads.map((h) => h.sha)).not.toContain(theirs);
      // And the pick reads exactly that shape.
      const v = pickOpened({ prs: [pr(7, 'feat/7-mine', mine), pr(8, 'feat/8-theirs', theirs)], repo: REPO, since: SINCE, branchesBefore: ['main'], email: EMAIL, heads, headCommit: (x: string) => commitBy(x) });
      expect(v).toEqual({ pr: 7, sha: mine });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
