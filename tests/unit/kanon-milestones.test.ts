import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUCKETS, milestones } from '../../cli/milestones.mjs';

/**
 * `kanon milestones` (#72): creates the two buckets of K-WORK-4 when missing, never with a
 * due date, and reports, without changing it, a milestone with a bucket's name that has a
 * due date or is closed. `gh` is mocked by a fake GitHub that holds the repository's
 * milestones, so a second run sees what the first one created.
 */
const REPO = 'acme/widgets';
type Milestone = { number: number; title: string; state: string; due_on: string | null };

type Gh = { status: number; stdout: string; stderr: string };
const fakeGitHub = (initial: Milestone[], opts: { listFails?: string; createFails?: string; pageSize?: number; user?: Gh } = {}) => {
  const milestonesHeld = initial.map((m) => ({ ...m }));
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'user') return opts.user ?? { status: 0, stdout: 'octo\n', stderr: '' };
    if (args.includes('--slurp')) {
      if (opts.listFails) return { status: 1, stdout: '', stderr: opts.listFails };
      const size = opts.pageSize ?? 100;
      const pages: Milestone[][] = [];
      for (let i = 0; i < milestonesHeld.length; i += size) pages.push(milestonesHeld.slice(i, i + size));
      return { status: 0, stdout: JSON.stringify(pages.length ? pages : [[]]), stderr: '' };
    }
    if (args.includes('POST')) {
      const title = (args.find((a) => a.startsWith('title=')) ?? '').slice('title='.length);
      if (title === opts.createFails) return { status: 1, stdout: '', stderr: 'gh: Validation Failed (HTTP 422)' };
      const dueArg = args.find((a) => a.startsWith('due_on='));
      milestonesHeld.push({ number: milestonesHeld.length + 1, title, state: 'open', due_on: dueArg ? dueArg.slice(7) : null });
      return { status: 0, stdout: '{}', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { gh, calls, milestonesHeld };
};

const run = async (github: ReturnType<typeof fakeGitHub>, argv = ['--repo', REPO], env: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const status = await milestones(argv, { gh: github.gh, env, out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
  return { status, out: out.join('\n'), err: err.join('\n') };
};

const writes = (calls: string[][]) => calls.filter((c) => !c.includes('--slurp') && c[1] !== 'user');
const roadmap = (title: string, number = 7): Milestone => ({ number, title, state: 'open', due_on: '2026-12-01T08:00:00Z' });
const bucket = (title: string, number = 3): Milestone => ({ number, title, state: 'open', due_on: null });

describe('kanon milestones creates the bucket milestones (#72, K-ADOPT-1 step 7)', () => {
  it("names exactly K-WORK-4's two buckets", () => {
    expect(BUCKETS).toEqual(['Product Backlog', 'Development Automation']);
  });

  it('creates both on a repository with none, with no due date, and says so', async () => {
    const github = fakeGitHub([bucket('Q4 launch', 1)]);
    const r = await run(github);
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    expect(writes(github.calls)).toEqual([
      ['api', '-X', 'POST', `repos/${REPO}/milestones`, '-f', 'title=Product Backlog'],
      ['api', '-X', 'POST', `repos/${REPO}/milestones`, '-f', 'title=Development Automation'],
    ]);
    expect(github.milestonesHeld.filter((m) => BUCKETS.includes(m.title)).map((m) => m.due_on)).toEqual([null, null]);
    expect(r.out).toContain('Created "Product Backlog", with no due date.');
    expect(r.out).toContain('Created "Development Automation", with no due date.');
  });

  it('is idempotent: a second run on the same repository changes nothing', async () => {
    const github = fakeGitHub([]);
    expect((await run(github)).status).toBe(0);
    const before = github.calls.length;
    const again = await run(github);
    expect(again.status).toBe(0);
    expect(writes(github.calls.slice(before))).toEqual([]);
    expect(again.out).toContain('"Product Backlog" already exists, with no due date.');
    expect(again.out).toContain('"Development Automation" already exists, with no due date.');
    expect(github.milestonesHeld.filter((m) => BUCKETS.includes(m.title))).toHaveLength(2);
  });

  it('reads every page and closed milestones too, so it never creates a duplicate', async () => {
    const github = fakeGitHub([bucket('a', 1), bucket('b', 2), bucket('Development Automation', 3)], { pageSize: 2 });
    const r = await run(github);
    expect(r.status).toBe(0);
    expect(github.calls[0]).toEqual(['api', 'user', '--jq', '.login']);
    expect(github.calls[1]).toEqual(['api', '--paginate', '--slurp', `repos/${REPO}/milestones?state=all&per_page=100`]);
    expect(writes(github.calls)).toEqual([['api', '-X', 'POST', `repos/${REPO}/milestones`, '-f', 'title=Product Backlog']]);
  });

  it('reports a bucket name that carries a due date, leaves it unchanged, still creates the other, and exits 1', async () => {
    const github = fakeGitHub([roadmap('Product Backlog')]);
    const r = await run(github);
    expect(r.status).toBe(1);
    expect(r.err).toContain('"Product Backlog" (#7) has a due date, 2026-12-01, so it reads as a roadmap milestone, not a bucket (K-WORK-3)');
    expect(r.err).toContain("Left unchanged: whether it should be one is the Stakeholder's call.");
    expect(writes(github.calls)).toEqual([['api', '-X', 'POST', `repos/${REPO}/milestones`, '-f', 'title=Development Automation']]);
    expect(github.milestonesHeld[0]).toEqual(roadmap('Product Backlog'));
  });

  it('reports a closed bucket, with the command to reopen it, and does not reopen it', async () => {
    const github = fakeGitHub([{ ...bucket('Development Automation', 4), state: 'closed' }, bucket('Product Backlog', 5)]);
    const r = await run(github);
    expect(r.status).toBe(1);
    expect(r.err).toContain('"Development Automation" (#4) is closed, and a bucket never completes (K-WORK-4).');
    expect(r.err).toContain(`gh api -X PATCH repos/${REPO}/milestones/4 -f state=open`);
    expect(writes(github.calls)).toEqual([]);
  });

  it('matches by the exact name only', async () => {
    const github = fakeGitHub([bucket('product backlog'), bucket('Development Automation (old)')]);
    const r = await run(github);
    expect(r.status).toBe(0);
    expect(writes(github.calls)).toHaveLength(2);
  });

  it('fails, creating nothing, when the milestones cannot be listed', async () => {
    const github = fakeGitHub([], { listFails: 'gh: Not Found (HTTP 404)' });
    const r = await run(github);
    expect(r.status).toBe(1);
    expect(r.err).toContain(`could not list the milestones of ${REPO}: gh: Not Found (HTTP 404)`);
    expect(writes(github.calls)).toEqual([]);
    // A 404 is not the token's fault, so no token advice.
    expect(r.err).not.toMatch(/unset|gh auth/);
  });

  it('fails when a create fails, naming it, and still tries the other bucket', async () => {
    const github = fakeGitHub([], { createFails: 'Product Backlog' });
    const r = await run(github);
    expect(r.status).toBe(1);
    expect(r.err).toContain(`could not create "Product Backlog" on ${REPO}: gh: Validation Failed (HTTP 422)`);
    expect(r.out).toContain('Created "Development Automation", with no due date.');
  });

  it.each([
    [[], '--repo is required'],
    [['--repo'], '--repo needs a value'],
    [['--repo', 'widgets'], '--repo takes <owner>/<repo>, not "widgets"'],
    [['--repo', REPO, '--org', 'acme'], 'unknown argument "--org"'],
  ])('exits 2 on %j, saying why, and calls nothing', async (argv, why) => {
    const github = fakeGitHub([]);
    const r = await run(github, argv);
    expect(r.status).toBe(2);
    expect(r.err).toContain(why);
    expect(r.err).toContain('Usage: kanon milestones --repo <owner>/<repo>');
    expect(github.calls).toEqual([]);
  });

  it('takes --repo=<owner>/<repo> too, and --help calls nothing', async () => {
    expect((await run(fakeGitHub([]), [`--repo=${REPO}`])).status).toBe(0);
    const github = fakeGitHub([]);
    const help = await run(github, ['--help']);
    expect(help.status).toBe(0);
    expect(help.out).toContain('Usage: kanon milestones');
    expect(github.calls).toEqual([]);
  });

  it('is a `kanon` subcommand', () => {
    const r = spawnSync(process.execPath, ['cli/kanon.mjs', 'milestones', '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: kanon milestones --repo <owner>/<repo>');
    expect(spawnSync(process.execPath, ['cli/kanon.mjs', '--help'], { encoding: 'utf8' }).stdout).toMatch(/^ {2}milestones +create the two bucket milestones/m);
  });

  it('K-ADOPT-1 step 7 names the command', () => {
    const step = /^7\. \*\*Milestones\.\*\*.*$/m.exec(readFileSync('rulebook/10-adoption.md', 'utf8'))?.[0] ?? '';
    expect(step).toContain('kanon milestones');
  });
});

describe('kanon milestones names the token it uses (plan 0005 §5.1)', () => {
  it("prints the token's source and its login before it lists anything, and never the token", async () => {
    const github = fakeGitHub([]);
    const r = await run(github, ['--repo', REPO], { GH_TOKEN: 'ghp_never_printed' });
    expect(r.status).toBe(0);
    expect(r.out.split('\n')[0]).toBe('Using the token in GH_TOKEN, which belongs to octo.');
    expect(github.calls[0]).toEqual(['api', 'user', '--jq', '.login']);
    expect(`${r.out}${r.err}${JSON.stringify(github.calls)}`).not.toContain('ghp_never_printed');
    expect((await run(fakeGitHub([]), ['--repo', REPO], {})).out).toContain("Using gh's stored login, which belongs to octo.");
    expect((await run(fakeGitHub([]), ['--repo', REPO], { GITHUB_TOKEN: 'x' })).out).toContain('Using the token in GITHUB_TOKEN, which belongs to octo.');
  });

  it('stops, listing nothing, when GitHub refuses a stale GH_TOKEN, and says how to fix it', async () => {
    const github = fakeGitHub([], { user: { status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' } });
    const r = await run(github, ['--repo', REPO], { GH_TOKEN: 'ghp_stale' });
    expect(r.status).toBe(1);
    expect(github.calls).toEqual([['api', 'user', '--jq', '.login']]);
    expect(r.err).toContain('GitHub refuses the token in GH_TOKEN (gh: Bad credentials (HTTP 401)). Nothing was changed.');
    expect(r.err).toContain('`unset GH_TOKEN` to use the stored login');
  });

  it('carries on when the login cannot be read for another reason, and says so', async () => {
    const github = fakeGitHub([], { user: { status: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' } });
    const r = await run(github, ['--repo', REPO], { GITHUB_TOKEN: 'x' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('Using the token in GITHUB_TOKEN; its login could not be read (gh: Resource not accessible by integration (HTTP 403)).');
  });

  it('adds the GH_TOKEN fix when GitHub refuses the list with 401 or 403', async () => {
    const github = fakeGitHub([], { listFails: 'gh: Resource not accessible by personal access token (HTTP 403)' });
    const r = await run(github, ['--repo', REPO], { GH_TOKEN: 'x' });
    expect(r.status).toBe(1);
    expect(r.err).toContain('kanon milestones: GH_TOKEN is set in this shell, and gh uses it before its stored login');
  });

  it('adds the same fix when a create is refused', async () => {
    const github = fakeGitHub([], { createFails: 'Product Backlog' });
    const forbidden = github.gh;
    const r = await run({ ...github, gh: async (args: string[]) => (args.includes('POST') ? { status: 1, stdout: '', stderr: 'gh: Must have admin rights (HTTP 403)' } : forbidden(args)) }, ['--repo', REPO], { GH_TOKEN: 'x' });
    expect(r.status).toBe(1);
    expect(r.err).toContain('`unset GH_TOKEN`');
  });
});
