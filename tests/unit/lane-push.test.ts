import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { SPAWNS } from './helpers/spawns.js';
import { fakeGitHub, serveFake } from './helpers/fake-git-data-api.mjs';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { REQUEST_PATH, bundleHeader, prepareStore, pushLane, readRequest } from '../../scripts/lane-push.mjs';

// Every case builds real repositories with `git`, so every case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// The spine's push job (kanon#1383, docs/projects/1373.md Issue B): the agent commits locally and
// hands its commits on as a bundle, with the pull request it wants as a request file. The push job
// re-creates each commit through the verified-commit helper and opens the pull request, against a
// recording double of GitHub's API over a real bare repository (tests/unit/helpers/fake-git-data-api.mjs).

const REPO = 'example-org/example-repo';
const APP = 'example-author[bot]';
const LABELS = ['agent:implement', 'review:please'];
// A runner's identity and config in `GIT_*` (a hook path, an author) would rewrite the fixture's commits.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER|CONFIG)/.test(k)));
type Call = { method: string; path: string; body?: Record<string, unknown> };

const spine = parse(readFileSync('.github/workflows/agent-lane.yml', 'utf8'));
const agentJob = parse(readFileSync('.github/workflows/lane-agent-job.yml', 'utf8'));
const agentSteps = agentJob.jobs.run.steps as WorkflowStep[];
const handoffStep = agentSteps.find((s) => s.id === 'handoff')!;
const excludeStep = agentSteps.find((s) => s.id === 'exclude-request')!;
const pushStep = (spine.jobs.push.steps as WorkflowStep[]).find((s) => s.id === 'push')!;

/**
 * A remote with `main` at `example-org/example-repo` under the root, so `file://<root>` is its
 * server, and a one-commit-deep clone of it, as the implement lane's checkout is.
 */
const fixture = ({ depth = 1, branch = '' } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'lane-push-'));
  const remote = join(root, REPO);
  const work = join(root, 'work');
  const sh = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: CLEAN_ENV });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  mkdirSync(remote, { recursive: true });
  sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(root, 'seed');
  sh(root, 'clone', '-q', remote, seed);
  for (const n of ['one', 'two']) {
    writeFileSync(join(seed, `${n}.txt`), `${n}\n`);
    sh(seed, 'add', '.');
    sh(seed, '-c', 'user.name=Pat', '-c', 'user.email=pat@example.invalid', 'commit', '-qm', n);
  }
  sh(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  if (branch) {
    sh(seed, '-c', 'user.name=Pat', '-c', 'user.email=pat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'the pull request');
    sh(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  }
  sh(root, 'clone', '-q', ...(depth ? [`--depth=${depth}`] : []), ...(branch ? ['-b', branch] : []), `file://${remote}`, work);
  sh(work, 'config', 'user.email', 'agent@example.invalid');
  sh(work, 'config', 'user.name', 'agent');
  const start = sh(work, 'rev-parse', 'HEAD');
  const commit = (file: string, text: string, msg = `add ${file}`) => {
    mkdirSync(join(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), text);
    sh(work, 'add', '-A');
    sh(work, 'commit', '-qm', msg);
    return sh(work, 'rev-parse', 'HEAD');
  };
  const onRemote = (...a: string[]) => sh(root, '--git-dir', remote, ...a);
  const temp = join(root, 'temp');
  mkdirSync(temp);
  return { root, remote, work, sh, start, commit, onRemote, temp };
};
type Fixture = ReturnType<typeof fixture>;

/** The agent's job's own steps, run in its checkout: the exclusion before the agent, the handoff after. */
const runAgentJob = (f: Fixture, agent: () => void) => {
  const env = { ...CLEAN_ENV, RUNNER_TEMP: f.temp, START: f.start };
  const excluded = runWorkflowStep(excludeStep, { cwd: f.work, env });
  expect(excluded.status, excluded.output).toBe(0);
  agent();
  const handed = runWorkflowStep(handoffStep, { cwd: f.work, env });
  expect(handed.status, handed.output).toBe(0);
  return handed;
};

/** The pull request the agent asks for, written where the prompt tells it to. */
const writeRequest = (f: Fixture, request: unknown) => {
  mkdirSync(join(f.work, 'docs'), { recursive: true });
  writeFileSync(join(f.work, REQUEST_PATH), typeof request === 'string' ? request : JSON.stringify(request));
};

/** The double, answering the pull request and its labels as GitHub would. */
const github = (f: Fixture) => fakeGitHub({
  remote: f.remote, repo: REPO, appLogin: APP,
  before: (call: Call) => {
    if (call.method === 'POST' && call.path === `repos/${REPO}/pulls`) return { status: 201, headers: {}, json: { number: 42, html_url: 'https://example.invalid/pull/42' } };
    if (call.method === 'POST' && call.path === `repos/${REPO}/issues/42/labels`) return { status: 200, headers: {}, json: [] };
    return undefined;
  },
});

/** The push job's script, in process: the store from the handed-over bundle, then the push. */
const push = async (f: Fixture, opts: { ref?: string; before?: string[] | null; labels?: string[] } = {}) => {
  const gh = github(f);
  const dir = join(f.temp, 'kanon-push');
  const store = join(f.root, `store-${Math.random().toString(36).slice(2)}`);
  const { prereqs } = prepareStore({ store, bundle: join(dir, 'commits.bundle'), start: f.start, server: `file://${f.root}`, repo: REPO, token: 'x' });
  const text = existsSync(join(dir, 'request.json')) ? readFileSync(join(dir, 'request.json'), 'utf8') : '';
  const r = await pushLane({
    gitDir: store, prereqs, start: f.start, ref: opts.ref ?? '', request: text ? readRequest(text) : null,
    before: opts.before === undefined ? ['main'] : opts.before, labels: opts.labels ?? LABELS,
    appLogin: APP, repo: REPO, api: gh.request, sleep: async () => {},
  });
  return { ...r, calls: gh.calls as Call[] };
};
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const at = (calls: Call[], method: string, path: string) => calls.findIndex((c) => c.method === method && c.path === `repos/${REPO}/${path}`);

const REQUEST = { branch: 'feat/7-thing', base: 'main', title: 'feat: the thing', body: 'Closes #7\n\nWhat it does.', labels: LABELS };

describe('the push job (kanon#1383)', () => {
  it('[LANE-15] opens the pull request from the agent\'s request, only after it has moved the branch', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    const r = await push(f);
    expect(r.refused).toEqual([]);
    // The branch GitHub has is the re-created commit, verified as the App's, not the agent's own.
    const head = f.onRemote('rev-parse', 'refs/heads/feat/7-thing');
    expect(head).not.toBe(f.sh(f.work, 'rev-parse', 'HEAD'));
    expect(f.onRemote('log', '-1', '--format=%an', head)).toBe(APP);
    expect(r.heads).toEqual([{ ref: 'feat/7-thing', sha: head }]);
    expect(r.base).toBe(f.start);
    // The pull request: the request's branch, base, title and body, then its labels, after the move.
    const moved = at(r.calls, 'POST', 'git/refs');
    const opened = at(r.calls, 'POST', 'pulls');
    expect(moved).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(moved);
    expect(r.calls[opened]!.body).toEqual({ head: 'feat/7-thing', base: 'main', title: REQUEST.title, body: REQUEST.body });
    const labelled = at(r.calls, 'POST', 'issues/42/labels');
    expect(labelled).toBeGreaterThan(opened);
    expect(r.calls[labelled]!.body).toEqual({ labels: LABELS });
    expect(r.pr).toBe(42);
    // The request itself is in no commit: the spine excluded it before the agent ran.
    expect(f.onRemote('ls-tree', '-r', '--name-only', head)).not.toContain(REQUEST_PATH);
    expect(r.lines.join('\n')).toMatch(/Opened #42/);
  });

  it('[LANE-15] refuses a request whose branch is the default branch, and creates nothing', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, { ...REQUEST, branch: 'main' });
    });
    const r = await push(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'main', why: expect.stringMatching(/default branch/) })]);
    expect(writes(r.calls)).toEqual([]);
    expect(r.heads).toEqual([]);
    expect(r.pr).toBeUndefined();
  });

  it('[LANE-15] refuses a request whose branch existed before the run, and creates nothing', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    const r = await push(f, { before: ['main', 'feat/7-thing'] });
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'feat/7-thing', why: expect.stringMatching(/existed before the run/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-15] refuses a request when the branches before the run are unknown: it fails closed', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    const r = await push(f, { before: null });
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'feat/7-thing', why: expect.stringMatching(/unknown/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-15] refuses a request that asks for a label the lane never had, and creates nothing', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, { ...REQUEST, labels: ['review:please', 'agent:merge'] });
    });
    const r = await push(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'feat/7-thing', why: expect.stringMatching(/agent:merge/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('refuses a request that is not one, by name, and creates nothing', async () => {
    expect(readRequest('{"branch": 7}')).toEqual({ problem: expect.stringMatching(/branch/) });
    expect(readRequest('not json')).toEqual({ problem: expect.stringMatching(/JSON/) });
    expect(readRequest(JSON.stringify({ ...REQUEST, title: '' }))).toEqual({ problem: expect.stringMatching(/title/) });
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, '{"branch": 7}');
    });
    const r = await push(f);
    expect(r.refused).toEqual([expect.objectContaining({ why: expect.stringMatching(/request/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('refuses a branch whose commits carry the request file itself, which the spine keeps out of every commit', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      writeRequest(f, REQUEST);
      f.sh(f.work, 'add', '-f', REQUEST_PATH);
      f.sh(f.work, 'commit', '-qm', 'smuggle the request');
    });
    const r = await push(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'feat/7-thing', why: expect.stringContaining(REQUEST_PATH) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('refuses a branch name a URL could read as another branch, before any request', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'main#x');
      f.commit('src/thing.txt', 'thing\n');
    });
    const r = await push(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'main#x' })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-14] with no request, as a failed agent leaves: moves each new branch, never the default, and opens no pull request', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.commit('on-main.txt', 'not here\n');
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
    });
    const r = await push(f);
    expect(r.heads.map((h) => h.ref)).toEqual(['feat/7-thing']);
    expect(f.onRemote('rev-parse', 'refs/heads/feat/7-thing')).toBe(r.heads[0]!.sha);
    // The default branch is refused, which fails the job, and stays where it was.
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'main', why: expect.stringMatching(/default branch/) })]);
    expect(f.onRemote('rev-parse', 'refs/heads/main')).toBe(f.start);
    expect(at(r.calls, 'POST', 'pulls')).toBe(-1);
    expect(r.lines.join('\n')).toMatch(/no request, so no pull request was opened/i);
  });

  it('with no request, refuses a branch that existed before the run', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'docs/old');
      f.commit('a.md', 'a\n');
    });
    const r = await push(f, { before: ['main', 'docs/old'] });
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'docs/old', why: expect.stringMatching(/existed before the run/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('with a request, moves only its branch, and leaves the agent\'s other branches local', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'scratch');
      f.commit('scratch.txt', 'try\n');
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing', 'main');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    const r = await push(f);
    expect(r.heads.map((h) => h.ref)).toEqual(['feat/7-thing']);
    expect(r.left).toEqual(['scratch']);
    expect(r.refused).toEqual([]);
  });

  it('builds on a newer default branch the agent merged in, re-creating only its own commits', async () => {
    const f = fixture();
    // A person pushes to main mid-run; the agent fetches it and merges it in.
    const person = join(f.root, 'person');
    f.sh(f.root, 'clone', '-q', f.remote, person);
    f.sh(person, '-c', 'user.name=Pat', '-c', 'user.email=pat@example.invalid', 'commit', '-q', '--allow-empty', '-m', "a person's commit");
    f.sh(person, 'push', '-q', 'origin', 'HEAD:main');
    const theirs = f.onRemote('rev-parse', 'refs/heads/main');
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      f.sh(f.work, 'fetch', '-q', 'origin', 'main');
      f.sh(f.work, 'merge', '-q', '--no-edit', 'origin/main');
      writeRequest(f, REQUEST);
    });
    const r = await push(f);
    expect(r.refused).toEqual([]);
    const head = r.heads[0]!.sha;
    // Two created, the commit and the merge; the person's commit is kept as it is.
    expect(r.calls.filter((c) => c.method === 'POST' && c.path === `repos/${REPO}/git/commits`)).toHaveLength(2);
    expect(f.onRemote('rev-list', '--parents', '-n', '1', head).split(' ')).toContain(theirs);
  });

  it('on a revise lane, moves only its own branch, from the head it checked out, though that branch existed before', async () => {
    const f = fixture({ depth: 0, branch: 'fix/1-thing' });
    runAgentJob(f, () => {
      f.commit('src/fix.txt', 'fixed\n');
      f.sh(f.work, 'switch', '-q', '-c', 'side');
      f.commit('side.txt', 'side\n');
    });
    const r = await push(f, { ref: 'fix/1-thing', before: ['main', 'fix/1-thing'] });
    expect(r.refused).toEqual([]);
    expect(r.heads.map((h) => h.ref)).toEqual(['fix/1-thing']);
    expect(r.base).toBe(f.start);
    expect(r.left).toEqual(['side']);
    const move = r.calls.find((c) => c.method === 'PATCH');
    expect(move).toMatchObject({ path: `repos/${REPO}/git/refs/heads/fix/1-thing`, body: { force: false } });
    expect(at(r.calls, 'POST', 'pulls')).toBe(-1);
  });

  it('reads the bundle\'s header: the commits it needs and the branches it carries', () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
    });
    const h = bundleHeader(readFileSync(join(f.temp, 'kanon-push', 'commits.bundle')));
    expect(h.prereqs).toEqual([f.start]);
    expect(h.refs).toEqual([{ ref: 'refs/heads/feat/7-thing', sha: f.sh(f.work, 'rev-parse', 'HEAD') }]);
  });
});

describe('the spine\'s steps around it (kanon#1383)', () => {
  it('the agent\'s job hands on nothing when the agent left no commit GitHub lacks', () => {
    const f = fixture();
    const handed = runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
    });
    expect(handed.outputs.commits).toBeUndefined();
    expect(existsSync(join(f.temp, 'kanon-push', 'commits.bundle'))).toBe(false);
  });

  it('the agent\'s `git add -A` leaves the request out, and the handoff carries it beside the bundle', () => {
    const f = fixture();
    const handed = runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      writeRequest(f, REQUEST);
      f.commit('src/thing.txt', 'thing\n');
    });
    expect(handed.outputs.commits).toBe('true');
    expect(f.sh(f.work, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain(REQUEST_PATH);
    expect(JSON.parse(readFileSync(join(f.temp, 'kanon-push', 'request.json'), 'utf8'))).toEqual(REQUEST);
  });

  it('the agent\'s job hands on no request that is a symlink', () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      mkdirSync(join(f.work, 'docs'), { recursive: true });
      spawnSync('ln', ['-s', '/etc/hostname', join(f.work, REQUEST_PATH)]);
    });
    expect(existsSync(join(f.temp, 'kanon-push', 'request.json'))).toBe(false);
  });

  it('[LANE-15] the push job\'s own step: fetches what the bundle needs, pushes, opens the pull request, and writes its outputs', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    const served = join(f.root, 'served');
    mkdirSync(served);
    const api = await serveFake({ remote: f.remote, repo: REPO, appLogin: APP, dir: served });
    try {
      // The double answers no pull request; the step's refusal to go on without one is the point here.
      const r = runWorkflowStep(pushStep, {
        env: {
          ...CLEAN_ENV, KANON: process.cwd(), RUNNER_TEMP: f.temp, GH_TOKEN: 'x', REPO,
          GITHUB_SERVER_URL: `file://${f.root}`, GITHUB_API_URL: api.url, APP_LOGIN: APP,
          START: f.start, REF: '', BEFORE: '["main"]', LABELS: LABELS.join(' '),
        },
      });
      const head = f.onRemote('rev-parse', 'refs/heads/feat/7-thing');
      expect(f.onRemote('log', '-1', '--format=%an', head)).toBe(APP);
      expect(JSON.parse(r.outputs.heads ?? '')).toEqual([{ ref: 'feat/7-thing', sha: head }]);
      expect(r.outputs.base).toBe(f.start);
      const calls = api.calls() as Call[];
      expect(calls.some((c) => c.method === 'POST' && c.path === `repos/${REPO}/pulls`)).toBe(true);
      // The double has no pull requests, so opening one fails, and so does the step, by name.
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/pull request/);
    } finally {
      api.stop();
    }
  });
});

describe('the spine\'s push job holds the key and runs nothing else (kanon#1383)', () => {
  type Job = { needs?: string | string[]; if?: string; steps?: WorkflowStep[]; outputs?: Record<string, string> };
  const job = spine.jobs.push as Job;
  const steps = job.steps ?? [];
  /** The job's `if:`, for these inputs and needs. Only the forms it uses. */
  const gate = (expr: string, { push = true, commits = 'true', result = 'success' }: { push?: boolean; commits?: string; result?: string }) => {
    const js = String(expr).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/!cancelled\(\)/g, 'true')
      .replace(/inputs\.push\b(?!-)/g, String(push))
      .replace(/needs\.run\.result/g, JSON.stringify(result))
      .replace(/needs\.run\.outputs\.commits/g, JSON.stringify(commits))
      .replace(/'([^']*)'/g, (_, s: string) => JSON.stringify(s));
    expect(js, `an expression this evaluator doesn't read: ${expr}`).toMatch(/^[\s"\w!=&|()-]*$/);
    return Boolean(new Function(`return (${js});`)());
  };

  it('[LANE-14] runs after the agent\'s job whenever it left commits, a failed run\'s included', () => {
    expect([job.needs].flat().sort()).toEqual(['mint', 'run']);
    expect(gate(job.if!, {})).toBe(true);
    expect(gate(job.if!, { result: 'failure' })).toBe(true);
    expect(gate(job.if!, { commits: '' })).toBe(false);
    expect(gate(job.if!, { commits: 'false' })).toBe(false);
    // A lane that doesn't commit (the deploy diagnosis) gets no push job and no write token.
    expect(gate(job.if!, { push: false })).toBe(false);
    // The agent's job hands its commits on whatever the agent did: always(), never success().
    for (const id of ['handoff', 'upload']) {
      const step = agentSteps.find((s) => s.id === id)!;
      expect(step.if, id).toMatch(/always\(\)/);
    }
    expect(agentJob.jobs.run.outputs.commits).toBe("${{ steps.upload.outcome == 'success' }}");
  });

  it('[LANE-14] runs no agent and no project code, checks nothing out, and moves the branch with the verified-commit helper', () => {
    const uses = steps.map((s) => s.uses ?? '').filter(Boolean);
    expect(uses).toEqual(['$/actions/kanon-path', 'actions/create-github-app-token@v3', 'actions/download-artifact@v8']);
    expect(steps.some((s) => String(s.uses ?? '').startsWith('./'))).toBe(false);
    expect(steps.some((s) => /actions\/(checkout|agent-run)/.test(String(s.uses ?? '')))).toBe(false);
    expect(JSON.stringify(job)).not.toMatch(/claude|npm|\bmake\b/i);
    // Its one script is Kanon's, at the release the lane pinned, and it pushes through the helper.
    expect(pushStep.run).toMatch(/node "\$KANON\/scripts\/lane-push\.mjs"/);
    expect(readFileSync('scripts/lane-push.mjs', 'utf8')).toMatch(/import \{[^}]*\bpushVerified\b[^}]*\} from '\.\/lib\/verified-commits\.mjs'/);
    // It reads the commit the agent's job checked out from that job's checkout, set before the agent ran.
    expect(pushStep.env?.START).toBe('${{ needs.run.outputs.start }}');
    expect(agentJob.jobs.run.outputs.start).toBe('${{ steps.checkout.outputs.commit }}');
    // And the branches that existed before the run from the mint job, before the agent's job started.
    expect(pushStep.env?.BEFORE).toBe('${{ needs.mint.outputs.branches }}');
    expect(spine.jobs.mint.outputs.branches).toBe('${{ steps.branches.outputs.branches }}');
  });

  it('[LANE-14] mints the Author App\'s token in the job, narrowed to the push, and never hands it on', () => {
    const mint = steps.find((s) => s.id === 'push-token')!;
    expect(mint.with).toEqual({
      'client-id': '${{ secrets.app-id }}',
      'private-key': '${{ secrets.app-private-key }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
      'permission-workflows': "${{ inputs.push-workflows && 'write' || '' }}",
    });
    expect(pushStep.env?.GH_TOKEN).toBe('${{ steps.push-token.outputs.token }}');
    expect(Object.values(job.outputs ?? {}).join(' ')).not.toMatch(/token/);
  });
});
