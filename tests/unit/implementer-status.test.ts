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
  // By default the run's agent job checked out the start and left the branch at `sha('3')`.
  const carry = (over: Record<string, unknown>) => carryDecision({
    startHead: start, head: sha('3'), slug: SLUG, email: EMAIL, startStatuses: [mine],
    compare: { status: 'ahead', commits: [commitBy(sha('2'), EMAIL, [start]), commitBy(sha('3'), EMAIL, [sha('2')])] },
    heads: [{ ref: 'feat/1-new', sha: sha('3') }, { ref: 'HEAD', sha: sha('3') }], base: start, fixSha: '',
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

  // #1263: the App's email binds nothing; the carry is bound to what this run checked out and pushed.
  describe('bound to what this run checked out and pushed (#1263)', () => {
    it('a legitimate multi-commit revise still carries', () => {
      const commits = [commitBy(sha('2'), EMAIL, [start]), commitBy(sha('4'), EMAIL, [sha('2')]), commitBy(sha('3'), EMAIL, [sha('4')])];
      expect(carry({ compare: { status: 'ahead', commits } })).toEqual({ carry: sha('3') });
    });

    it('refuses a forged-email commit below the tip the run pushed: the job checked out the forgery, not the start', () => {
      // A person pushed `P` under the App's address before the agent's job checked out; the agent
      // built `H` on it, and its job held `H`. Every commit on the path reads as the App's.
      const P = sha('2');
      const v = carry({ base: P, compare: { status: 'ahead', commits: [commitBy(P, EMAIL, [start]), commitBy(sha('3'), EMAIL, [P])] } });
      expect(v).toMatchObject({ none: expect.stringMatching(/checked out `2222222`, not `1111111`.*not the Implementer's/) });
    });

    it('refuses a person\'s push after the agent, though it carries the App\'s address', () => {
      const Q = sha('5');
      const commits = [commitBy(sha('2'), EMAIL, [start]), commitBy(sha('3'), EMAIL, [sha('2')]), commitBy(Q, EMAIL, [sha('3')])];
      const v = carry({ head: Q, compare: { status: 'ahead', commits } });
      expect(v).toMatchObject({ none: expect.stringMatching(/`5555555` is not one this run pushed \(its agent's job held 3333333\)/) });
    });

    it('the fix-push path carries: no agent job ran, the fix commit is the head and was made on the start', () => {
      const F = sha('6');
      const v = carry({ head: F, heads: null, base: start, fixSha: F, compare: { status: 'ahead', commits: [commitBy(F, EMAIL, [start])] } });
      expect(v).toEqual({ carry: F });
      // And a push on top of the fix is not the fix.
      const after = carry({ head: sha('7'), heads: null, base: start, fixSha: F, compare: { status: 'ahead', commits: [commitBy(F, EMAIL, [start]), commitBy(sha('7'), EMAIL, [F])] } });
      expect(after).toMatchObject({ none: expect.stringMatching(/not one this run pushed \(the heads its agent's job held are unknown, its fix pushed `6666666`\)/) });
    });

    it('fails closed: unknown heads and no fix, or an unknown checkout, carry nothing', () => {
      expect(carry({ heads: null })).toMatchObject({ none: expect.stringMatching(/heads its agent's job held are unknown/) });
      expect(carry({ heads: [] })).toMatchObject({ none: expect.stringMatching(/held none/) });
      expect(carry({ heads: undefined, fixSha: undefined })).toHaveProperty('none');
      expect(carry({ base: '' })).toMatchObject({ none: expect.stringMatching(/checked out is unknown/) });
      expect(carry({ base: undefined })).toHaveProperty('none');
      expect(carry({ fixSha: 'not-a-sha', heads: null })).toHaveProperty('none');
    });
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
    // The revise lane's `fix-push` too, whose fix commit the carry binds to (#1263).
    expect([job.needs].flat()).toEqual(file === 'agent-implement-revise.yml' ? ['filter', 'fix-push', agent] : ['filter', agent]);
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
      // The one input read from the lane's call (#324): the heads its push job moved, which bind
      // the pick to the head this run pushed (`[LANE-16]`). Nothing else of that call.
      expect(call.with?.heads).toBe(`\${{ needs.${agent}.outputs.push-heads }}`);
      const rest = Object.entries(call.with ?? {}).filter(([k]) => k !== 'heads').map(([, v]) => v).join(' ');
      expect(rest).not.toMatch(new RegExp(`needs\\.${agent}\\.`));
    } else {
      expect(inputs).toMatch(/needs\.filter\.outputs\.(head_sha|heads)/);
      // #1263: the binding to what the agent's job checked out and left, and nothing else of it.
      const read = [...inputs.matchAll(new RegExp(`needs\\.${agent}\\.outputs\\.([\\w-]+)`, 'g'))].map((m) => m[1]);
      expect([...new Set(read)].sort()).toEqual(file === 'agent-rebase.yml' ? ['checked'] : ['push-base', 'push-heads']);
    }
  });

  // #1263: every output the carry reads really reaches the step, through `needs` and each called
  // workflow's `outputs:` block.
  describe('carry: the binding is wired from the agent\'s job to the step (#1263)', SPAWNS, () => {
    type Called = { on: { workflow_call: { outputs?: Record<string, { value: string }> } }; jobs: Record<string, Job> };
    const called = (f: string) => parse(readFileSync(`.github/workflows/${f}`, 'utf8')) as Called;

    it('the revise lane: heads and base from the spine, or the fix commit and its parent from fix-push', () => {
      const { jobs } = wf('agent-implement-revise.yml');
      const job = jobs['implementer-status']!;
      expect([job.needs].flat()).toEqual(expect.arrayContaining(['filter', 'fix-push', 'revise']));
      const call = job.steps![1]!;
      expect(call.with).toMatchObject({
        'start-head': '${{ needs.filter.outputs.head_sha }}',
        heads: '${{ needs.revise.outputs.push-heads }}',
        base: '${{ needs.revise.outputs.push-base || needs.fix-push.outputs.base }}',
        'fix-sha': '${{ needs.fix-push.outputs.sha }}',
      });
      expect(jobs.revise!.uses).toBe('$/.github/workflows/agent-lane.yml');
      expect(jobs['fix-push']!.outputs).toMatchObject({ sha: '${{ steps.push.outputs.sha }}', base: '${{ steps.push.outputs.base }}' });
      const push = jobs['fix-push']!.steps!.find((s) => s.id === 'push')!;
      expect(push.run).toMatch(/revise-fix\.mjs" push .*--head "\$HEAD_SHA"/s);
      expect(readFileSync('scripts/revise-fix.mjs', 'utf8')).toContain("output({ pushed: 'true', sha, base })");
      // The spine passes both up from its push job, which builds on the commit the agent's job
      // checked out, read from that job's checkout before the agent ran (kanon#1383).
      expect(called('agent-lane.yml').on.workflow_call.outputs).toMatchObject({ 'push-heads': { value: '${{ jobs.push.outputs.heads }}' }, 'push-base': { value: '${{ jobs.push.outputs.base }}' } });
      expect(called('agent-lane.yml').jobs.push!.outputs).toMatchObject({ heads: '${{ steps.push.outputs.heads }}', base: '${{ steps.push.outputs.base }}' });
      const spine = called('lane-agent-job.yml');
      expect(spine.on.workflow_call.outputs).toMatchObject({ start: { value: '${{ jobs.run.outputs.start }}' } });
      expect(spine.jobs.run!.outputs).toMatchObject({ start: '${{ steps.checkout.outputs.commit }}' });
      const steps = spine.jobs.run!.steps!;
      const checkout = steps.findIndex((s) => s.id === 'checkout');
      expect(steps[checkout]!.uses).toMatch(/^actions\/checkout@/);
      expect(checkout).toBeLessThan(steps.findIndex((s) => s.id === 'agent'));
    });

    it('[LANE-16] on the spine\'s lanes, the status reads heads and base only from the push job or fix-push, never the agent\'s job', () => {
      const spineOutputs = called('agent-lane.yml').on.workflow_call.outputs ?? {};
      // What the spine hands up from the agent's job is how it ended, never a head or a base.
      const fromRun = Object.entries(spineOutputs).filter(([, o]) => /jobs\.run\./.test(o.value)).map(([k]) => k);
      expect(fromRun.sort()).toEqual(['kind', 'outcome']);
      for (const k of ['push-heads', 'push-base', 'push-pr']) expect(spineOutputs[k]?.value, k).toMatch(/^\$\{\{ jobs\.push\.outputs\.\w+ \}\}$/);
      // And each spine lane's status reads its call's push outputs, or the revise lane's fix-push.
      for (const file of ['agent-implement.yml', 'agent-triage.yml', 'agent-implement-revise.yml'] as const) {
        const { agent } = LANES[file];
        const call = wf(file).jobs['implementer-status']!.steps![1]!;
        for (const key of ['heads', 'base'] as const) {
          const v = call.with?.[key];
          if (v === undefined) continue;
          const reads = [...v.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)].map((m) => `${m[1]}.${m[2]}`);
          expect(reads.length, `${file} ${key}`).toBeGreaterThan(0);
          for (const r of reads) expect([`${agent}.push-${key}`, `fix-push.${key}`], `${file} ${key} reads ${r}`).toContain(r);
        }
      }
    });

    it('the rebase lane: one `{ pr, base, heads }` per entry, through rebase-run, used only for its own pull request', () => {
      const { jobs } = wf('agent-rebase.yml');
      expect(jobs.resolve!.uses).toBe('$/.github/workflows/rebase-run.yml');
      const call = jobs['implementer-status']!.steps![1]!;
      const C = "fromJson(needs.resolve.outputs.checked || '{}')";
      expect(call.with).toMatchObject({
        heads: `\${{ ${C}.pr == matrix.pr && ${C}.heads || '' }}`,
        base: `\${{ ${C}.pr == matrix.pr && ${C}.base || '' }}`,
      });
      expect(call.with?.['fix-sha']).toBeUndefined();
      const run = called('rebase-run.yml');
      expect(run.on.workflow_call.outputs?.checked?.value).toBe('${{ jobs.resolve.outputs.checked }}');
      expect(run.jobs.resolve!.uses).toBe('$/.github/workflows/rebase-agent-job.yml');
      const agentJob = called('rebase-agent-job.yml');
      expect(agentJob.on.workflow_call.outputs?.checked?.value).toBe('${{ jobs.resolve.outputs.checked }}');
      // #1357: the pull request and the base reach the job's output from the input and from a
      // step before the agent, never through a step after it, which code the agent ran can
      // steer (`$GITHUB_PATH`, `BASH_ENV`). Each value is `toJSON`-quoted, so the heads text
      // adds no key; and the output is empty unless both records are there.
      expect(agentJob.jobs.resolve!.outputs?.checked).toBe(
        `\${{ steps.base.outputs.base && steps.heads.outputs.heads && format('{{"pr":{0},"base":{1},"heads":{2}}}', toJSON(inputs.pr), toJSON(steps.base.outputs.base), toJSON(steps.heads.outputs.heads)) || '' }}`,
      );
      type S = Step & { env?: Record<string, string>; if?: string };
      const steps = agentJob.jobs.resolve!.steps! as S[];
      const at = (id: string) => steps.findIndex((s) => s.id === id);
      // The base before the agent, after the checkout; the heads after it, never handling the base.
      expect(at('checkout')).toBeLessThan(at('base'));
      expect(at('base')).toBeLessThan(at('agent'));
      expect(at('heads')).toBeGreaterThan(at('agent'));
      expect(at('heads')).toBeLessThan(at('finish'));
      for (const id of ['base', 'heads']) expect(steps[at(id)]!['continue-on-error'], id).toBe(true);
      for (const s of steps.slice(at('agent') + 1)) expect(JSON.stringify(s), s.id ?? s.uses).not.toMatch(/steps\.base\.outputs/);
      expect(steps[at('heads')]!.if).toMatch(/^always\(\)/);
    });

    it('the rebase lane\'s records read what the job fetched and left, and its expression keeps one entry\'s to that entry', () => {
      const steps = called('rebase-agent-job.yml').jobs.resolve!.steps!;
      const step = (id: string) => steps.find((s) => s.id === id)!.run!;
      const dir = mkdtempSync(join(tmpdir(), 'implementer-checked-'));
      try {
        const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
        git('init', '-q', '-b', 'main');
        git('commit', '-q', '--allow-empty', '-m', 'base');
        const fetched = git('rev-parse', 'HEAD');
        git('update-ref', 'refs/remotes/origin/feat/7-mine', fetched);
        const bin = join(dir, '.bin');
        execFileSync('mkdir', ['-p', bin]);
        execFileSync('bash', ['-c', `printf '#!/bin/sh\necho feat/7-mine\n' > "${bin}/gh" && chmod +x "${bin}/gh"`]);
        const out = join(dir, '.out');
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_OUTPUT: out, PR_NUMBER: '7', REPO: REPO };
        execFileSync('bash', ['-c', step('base')], { cwd: dir, env });
        expect(readFileSync(out, 'utf8').trim()).toBe(`base=${fetched}`);
        // The agent merges and commits on the branch; the record after it holds the heads alone.
        git('checkout', '-q', '-b', 'feat/7-mine', 'origin/feat/7-mine');
        git('commit', '-q', '--allow-empty', '-m', 'merge');
        const left = git('rev-parse', 'HEAD');
        execFileSync('bash', ['-c', step('heads')], { cwd: dir, env: { ...env, GITHUB_OUTPUT: `${out}2` } });
        const line = readFileSync(`${out}2`, 'utf8').trim();
        expect(line.startsWith('heads=')).toBe(true);
        const headsText = line.slice('heads='.length);
        const heads = JSON.parse(headsText) as Array<{ ref: string; sha: string }>;
        expect(heads).toEqual(expect.arrayContaining([{ ref: 'feat/7-mine', sha: left }, { ref: 'HEAD', sha: left }]));
        // The job's `checked`, as its `format` and `toJSON` build it, and the status job's read
        // of it: `heads` arrives as the spine's JSON array text.
        const checked = JSON.parse(`{"pr":${JSON.stringify(7)},"base":${JSON.stringify(fetched)},"heads":${JSON.stringify(headsText)}}`) as { pr: number; base: string; heads: string };
        expect(checked).toEqual({ pr: 7, base: fetched, heads: headsText });
        // And the carry reads exactly that shape.
        const v = carryDecision({
          startHead: fetched, head: left, slug: SLUG, email: EMAIL, startStatuses: [{ context: CONTEXT, state: 'success', creator: { login: `${SLUG}[bot]` } }],
          compare: { status: 'ahead', commits: [commitBy(left, EMAIL, [fetched])] }, heads: JSON.parse(checked.heads), base: checked.base, fixSha: '',
        });
        expect(v).toEqual({ carry: left });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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

// #324: the binding the `open` pick matches on. Since kanon#1383 the push job records it: the
// heads it moved through GitHub, not what the agent's job held (`LANE-16`).
describe('the push job records the heads it moved, for the open pick', () => {
  const lane = parse(readFileSync('.github/workflows/agent-lane.yml', 'utf8')) as {
    on: { workflow_call: { outputs: Record<string, { value: string }> } }; jobs: Record<string, { outputs?: Record<string, string> }>;
  };

  it('passes them up from the push job as `push-heads`, and the agent\'s job passes up none', () => {
    expect(lane.on.workflow_call.outputs['push-heads']?.value).toBe('${{ jobs.push.outputs.heads }}');
    expect(lane.jobs.push?.outputs?.heads).toBe('${{ steps.push.outputs.heads }}');
    expect(lane.on.workflow_call.outputs.heads).toBeUndefined();
  });

  it('in the shape the pick reads: the pull request at a moved head is this run\'s', () => {
    // `scripts/lane-push.mjs` writes `heads=<JSON [{ref, sha}]>`, one entry per branch it moved.
    const mine = 'a'.repeat(40);
    const theirs = 'b'.repeat(40);
    const heads = [{ ref: 'feat/7-mine', sha: mine }];
    const v = pickOpened({ prs: [pr(7, 'feat/7-mine', mine), pr(8, 'feat/8-theirs', theirs)], repo: REPO, since: SINCE, branchesBefore: ['main'], email: EMAIL, heads, headCommit: (x: string) => commitBy(x) });
    expect(v).toEqual({ pr: 7, sha: mine });
  });
});
