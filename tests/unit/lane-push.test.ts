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

type Answer = { status: number; headers: Record<string, string>; json: unknown };
/** The double, answering the pull request and its labels as GitHub would, and `answer` first. */
const github = (f: Fixture, answer: (call: Call) => Answer | undefined = () => undefined) => fakeGitHub({
  remote: f.remote, repo: REPO, appLogin: APP,
  before: (call: Call) => {
    const given = answer(call);
    if (given) return given;
    if (call.method === 'POST' && call.path === `repos/${REPO}/pulls`) return { status: 201, headers: {}, json: { number: 42, html_url: 'https://example.invalid/pull/42' } };
    if (call.method === 'POST' && call.path === `repos/${REPO}/issues/42/labels`) return { status: 200, headers: {}, json: [] };
    return undefined;
  },
});

/** A branch someone else pushed to the remote, at the default branch's head, as a person's or an earlier run's would be. */
const existing = (f: Fixture, branch: string) => f.onRemote('update-ref', `refs/heads/${branch}`, 'refs/heads/main');

/** The push job's script, in process: the store from the handed-over bundle, then the push. */
const push = async (f: Fixture, opts: { ref?: string; labels?: string[]; attempt?: number; answer?: (call: Call) => Answer | undefined } = {}) => {
  const gh = github(f, opts.answer);
  const dir = join(f.temp, 'kanon-push');
  const store = join(f.root, `store-${Math.random().toString(36).slice(2)}`);
  const { prereqs } = prepareStore({ store, bundle: join(dir, 'commits.bundle'), start: f.start, server: `file://${f.root}`, repo: REPO, token: 'x' });
  const text = existsSync(join(dir, 'request.json')) ? readFileSync(join(dir, 'request.json'), 'utf8') : '';
  const r = await pushLane({
    gitDir: store, prereqs, start: f.start, ref: opts.ref ?? '', request: text ? readRequest(text) : null,
    labels: opts.labels ?? LABELS, ...(opts.attempt ? { attempt: opts.attempt } : {}),
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

  it('[LANE-15] refuses a request whose branch exists on GitHub when it pushes, and creates nothing', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    // Made during the run, after any list of branches a job could have taken before the agent.
    existing(f, 'feat/7-thing');
    const r = await push(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'feat/7-thing', why: expect.stringMatching(/exists on GitHub/) })]);
    expect(at(r.calls, 'GET', 'git/ref/heads/feat/7-thing')).toBeGreaterThan(-1);
    expect(writes(r.calls)).toEqual([]);
    expect(f.onRemote('rev-parse', 'refs/heads/feat/7-thing')).toBe(f.start);
  });

  it('[LANE-15] refuses a request when GitHub can\'t say whether its branch exists: it fails closed', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    const r = await push(f, {
      answer: (call) => (call.method === 'GET' && call.path === `repos/${REPO}/git/ref/heads/feat/7-thing` ? { status: 502, headers: {}, json: {} } : undefined),
    });
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'feat/7-thing', why: expect.stringMatching(/answered 502, so it can't be told new/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-15] on a re-run, a refused request\'s summary tells a person to open the pull request by hand (kanon#1438)', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'feat/7-thing');
      f.commit('src/thing.txt', 'thing\n');
      writeRequest(f, REQUEST);
    });
    // The first attempt pushed the branch, then failed before the pull request opened.
    const first = await push(f, { answer: (call) => (call.method === 'POST' && call.path === `repos/${REPO}/pulls` ? { status: 502, headers: {}, json: {} } : undefined) }).catch((e: Error) => e);
    expect(first).toBeInstanceOf(Error);
    const pushed = f.onRemote('rev-parse', 'refs/heads/feat/7-thing');
    const r = await push(f, { attempt: 2 });
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'feat/7-thing', why: expect.stringMatching(/exists on GitHub/) })]);
    expect(writes(r.calls)).toEqual([]);
    expect(f.onRemote('rev-parse', 'refs/heads/feat/7-thing')).toBe(pushed);
    const text = r.lines.join('\n');
    expect(text).toMatch(/attempt 2 of the run/);
    expect(text).toMatch(/open one by hand, into \*\*main\*\*, titled "feat: the thing", labelled `agent:implement`, `review:please`/);
    // A first attempt's refusal says nothing of the kind.
    const once = await push(f);
    expect(once.lines.join('\n')).not.toMatch(/by hand/);
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

  it('with no request, refuses a branch that exists on GitHub', async () => {
    const f = fixture();
    runAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'docs/old');
      f.commit('a.md', 'a\n');
    });
    existing(f, 'docs/old');
    const r = await push(f, { attempt: 2 });
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'docs/old', why: expect.stringMatching(/exists on GitHub/) })]);
    expect(writes(r.calls)).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/already pushed a branch refused here, its commits are on GitHub/);
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
    const r = await push(f, { ref: 'fix/1-thing' });
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
          START: f.start, REF: '', LABELS: LABELS.join(' '),
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
    // GitHub prefixes `success() &&` to an `if` that calls no status function, so a job gated on
    // outputs alone is skipped when the job it needs failed (kanon#1476).
    if (!/\b(always|cancelled|failure|success)\(\)/.test(expr) && result !== 'success') return false;
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
    // No list of the branches before the run (kanon#1438): it asks GitHub as it pushes.
    expect(JSON.stringify(job)).not.toMatch(/BEFORE|--before|outputs\.branches/);
    expect(spine.jobs.mint.outputs.branches).toBeUndefined();
  });

  it('[LANE-14] re-run on its own, reads the bundle the agent\'s job uploaded in its attempt, of this run alone (kanon#1438)', () => {
    const upload = agentSteps.find((s) => s.id === 'upload')!;
    const download = steps.find((s) => String(s.uses ?? '').startsWith('actions/download-artifact@'))!;
    // The agent's job names the bundle after its attempt and says which, as an output a partial
    // re-run reuses; the push job downloads that name, never one from its own attempt.
    expect(upload.with?.name).toBe('kanon-push-${{ github.run_attempt }}');
    expect(agentJob.jobs.run.outputs.attempt).toBe('${{ github.run_attempt }}');
    expect(agentJob.on.workflow_call.outputs.attempt.value).toBe('${{ jobs.run.outputs.attempt }}');
    expect(download.with?.name).toBe('kanon-push-${{ needs.run.outputs.attempt }}');
    // An earlier attempt's artifact is read through the API, with this job's token, from this run only.
    expect(download.with?.['run-id']).toBe('${{ github.run_id }}');
    expect(download.with?.['github-token']).toBe('${{ steps.push-token.outputs.token }}');
    expect(download.with).not.toHaveProperty('repository');
  });

  it('[LANE-14] mints the Author App\'s token in the job, narrowed to the push, and never hands it on', () => {
    const mint = steps.find((s) => s.id === 'push-token')!;
    expect(mint.with).toEqual({
      'client-id': '${{ secrets.app-id }}',
      'private-key': '${{ secrets.app-private-key }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
      'permission-workflows': "${{ inputs.push-workflows && 'write' || '' }}",
      'permission-actions': 'read',
    });
    expect(pushStep.env?.GH_TOKEN).toBe('${{ steps.push-token.outputs.token }}');
    expect(Object.values(job.outputs ?? {}).join(' ')).not.toMatch(/token/);
  });
});

// ── The rebase lane's push job (kanon#1384, docs/projects/1373.md Issue C) ─────────────────────

const rebaseRun = parse(readFileSync('.github/workflows/rebase-run.yml', 'utf8'));
const rebaseAgent = parse(readFileSync('.github/workflows/rebase-agent-job.yml', 'utf8'));
const rebaseSteps = rebaseAgent.jobs.resolve.steps as WorkflowStep[];
const rebaseHandoff = rebaseSteps.find((s) => s.id === 'handoff')!;
const rebasePush = (rebaseRun.jobs.push?.steps as WorkflowStep[] | undefined)?.find((s) => s.id === 'push');

const PR = 7;
const PR_BRANCH = 'feat/7-thing';
/** The pull request as GitHub answers it: its head is a branch of this repository. */
const PULL = { number: PR, head: { ref: PR_BRANCH, repo: { full_name: REPO } } };

/**
 * A pull request that conflicts with the default branch, as the rebase lane's checkout finds it:
 * the pull request changed `one.txt`, then the default branch changed it too and added `three.txt`.
 * Every branch is fetched (`fetch-depth: 0`), and the pull request's branch is checked out.
 */
const conflicting = () => {
  const f = fixture({ depth: 0, branch: PR_BRANCH });
  const person = join(f.root, 'person');
  f.sh(f.root, 'clone', '-q', f.remote, person);
  const as = ['-c', 'user.name=Pat', '-c', 'user.email=pat@example.invalid'];
  f.sh(person, 'switch', '-q', PR_BRANCH);
  writeFileSync(join(person, 'one.txt'), "one, the pull request's\n");
  f.sh(person, 'add', '.');
  f.sh(person, ...as, 'commit', '-qm', 'the pull request changes one');
  f.sh(person, 'push', '-q', 'origin', `HEAD:refs/heads/${PR_BRANCH}`);
  f.sh(person, 'switch', '-q', 'main');
  writeFileSync(join(person, 'one.txt'), "one, the default branch's\n");
  writeFileSync(join(person, 'three.txt'), 'three\n');
  f.sh(person, 'add', '.');
  f.sh(person, ...as, 'commit', '-qm', 'the default branch changes one');
  f.sh(person, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  f.sh(f.work, 'fetch', '-q', 'origin');
  f.sh(f.work, 'reset', '-q', '--hard', `origin/${PR_BRANCH}`);
  const start = f.sh(f.work, 'rev-parse', 'HEAD');
  const merged = f.sh(f.work, 'rev-parse', 'refs/remotes/origin/main');
  /** Another commit on the default branch, pushed after the agent's job recorded its head. */
  const advanceMain = () => {
    f.sh(person, ...as, 'commit', '-q', '--allow-empty', '-m', 'main moves on');
    f.sh(person, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return f.sh(person, 'rev-parse', 'HEAD');
  };
  /** A person's commit on the pull request's branch, pushed after the agent's job fetched it. */
  const advanceBranch = () => {
    f.sh(person, 'switch', '-q', PR_BRANCH);
    f.sh(person, 'pull', '-q', 'origin', PR_BRANCH);
    f.sh(person, ...as, 'commit', '-q', '--allow-empty', '-m', 'a person pushes to the branch');
    f.sh(person, 'push', '-q', 'origin', `HEAD:refs/heads/${PR_BRANCH}`);
  };
  /** The agent's resolution: merge `what` without committing, keep both sides, commit the merge. */
  const resolve = (what = 'origin/main') => {
    spawnSync('git', ['merge', '--no-ff', '--no-commit', what], { cwd: f.work, env: CLEAN_ENV });
    writeFileSync(join(f.work, 'one.txt'), "one, the pull request's and the default branch's\n");
    f.sh(f.work, 'add', '-A');
    f.sh(f.work, 'commit', '-q', '--no-edit');
    return f.sh(f.work, 'rev-parse', 'HEAD');
  };
  return { ...f, start, merged, advanceMain, advanceBranch, resolve };
};
type Conflicting = ReturnType<typeof conflicting>;

/** The rebase lane's agent's job's handoff, run in its checkout after the agent. */
const rebaseAgentJob = (f: Conflicting, agent: () => void) => {
  agent();
  const handed = runWorkflowStep(rebaseHandoff, { cwd: f.work, env: { ...CLEAN_ENV, RUNNER_TEMP: f.temp, START: f.start } });
  expect(handed.status, handed.output).toBe(0);
  return handed;
};

/** The rebase lane's push, in process, given what the agent's job recorded before its agent ran. */
const pushRebase = async (f: Conflicting, { merged = f.merged, pull = PULL as unknown }: { merged?: string; pull?: unknown } = {}) => {
  const gh = fakeGitHub({ remote: f.remote, repo: REPO, appLogin: APP, pulls: { [PR]: pull } });
  const store = join(f.root, `store-${Math.random().toString(36).slice(2)}`);
  const { prereqs } = prepareStore({ store, bundle: join(f.temp, 'kanon-push', 'commits.bundle'), start: f.start, server: `file://${f.root}`, repo: REPO, token: 'x' });
  const r = await pushLane({
    gitDir: store, prereqs, start: f.start, ref: PR_BRANCH, merged, pr: PR, request: null, labels: [],
    appLogin: APP, repo: REPO, api: gh.request, sleep: async () => {},
  });
  return { ...r, calls: gh.calls as Call[] };
};
const created = (calls: Call[], what: string) => calls.filter((c) => c.method === 'POST' && c.path === `repos/${REPO}/git/${what}`);

describe('the rebase lane\'s push (kanon#1384)', () => {
  it('[LANE-17] creates the merge commit through the helper, with both parents, and moves the branch without force', async () => {
    const f = conflicting();
    let local = '';
    rebaseAgentJob(f, () => { local = f.resolve(); });
    const r = await pushRebase(f);
    expect(r.refused).toEqual([]);
    const head = f.onRemote('rev-parse', `refs/heads/${PR_BRANCH}`);
    // GitHub's merge is a new commit, the App's, whose first parent is the head the job fetched
    // and whose second is the default branch's head it merged.
    expect(head).not.toBe(local);
    expect(f.onRemote('log', '-1', '--format=%an', head)).toBe(APP);
    expect(f.onRemote('rev-list', '--parents', '-n', '1', head).split(' ').slice(1)).toEqual([f.start, f.merged]);
    expect(f.onRemote('rev-parse', `${head}^{tree}`)).toBe(f.sh(f.work, 'rev-parse', `${local}^{tree}`));
    // Only the merge is created, and only the blob the resolution changed is uploaded (`[LANE-6]`, `[LANE-11]`).
    const commits = created(r.calls, 'commits');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.body?.parents).toEqual([f.start, f.merged]);
    expect(created(r.calls, 'blobs')).toHaveLength(1);
    expect(Buffer.from(String(created(r.calls, 'blobs')[0]!.body?.content), 'base64').toString('utf8')).toBe("one, the pull request's and the default branch's\n");
    // Moved from the head the job fetched, without force (`K-AGENT-34`).
    const moves = r.calls.filter((c) => c.method === 'PATCH');
    expect(moves).toEqual([expect.objectContaining({ path: `repos/${REPO}/git/refs/heads/${PR_BRANCH}`, body: expect.objectContaining({ force: false }) })]);
    expect(r.calls.some((c) => c.method === 'POST' && c.path === `repos/${REPO}/git/refs`)).toBe(false);
    expect(r.heads).toEqual([{ ref: PR_BRANCH, sha: head }]);
    expect(r.base).toBe(f.start);
    expect(at(r.calls, 'POST', 'pulls')).toBe(-1);
  });

  it('[LANE-17] keeps a fix committed after the merge, on top of the merge GitHub created', async () => {
    const f = conflicting();
    rebaseAgentJob(f, () => {
      f.resolve();
      f.commit('one.test.txt', 'the test the merged tree needed\n', 'fix the test the merge broke');
    });
    const r = await pushRebase(f);
    expect(r.refused).toEqual([]);
    const head = f.onRemote('rev-parse', `refs/heads/${PR_BRANCH}`);
    expect(f.onRemote('rev-list', '--parents', '-n', '1', `${head}~1`).split(' ').slice(1)).toEqual([f.start, f.merged]);
    expect(created(r.calls, 'commits')).toHaveLength(2);
  });

  it('[LANE-17] refuses a range that holds no merge commit, and creates nothing', async () => {
    const f = conflicting();
    rebaseAgentJob(f, () => { f.commit('one.txt', 'only my side\n', 'not a merge'); });
    const r = await pushRebase(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: PR_BRANCH, why: expect.stringMatching(/no merge commit/) })]);
    expect(writes(r.calls)).toEqual([]);
    expect(f.onRemote('rev-parse', `refs/heads/${PR_BRANCH}`)).toBe(f.start);
  });

  it('[LANE-17] refuses a merge of a newer default branch than the one recorded before the agent, and creates nothing', async () => {
    const f = conflicting();
    const newer = f.advanceMain();
    rebaseAgentJob(f, () => {
      f.sh(f.work, 'fetch', '-q', 'origin');
      f.resolve();
    });
    const r = await pushRebase(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: PR_BRANCH, why: expect.stringContaining(newer) })]);
    expect(r.refused[0]!.why).toContain(f.merged);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-17] refuses a merge whose first parent is not the pull request\'s head as the job fetched it', async () => {
    const f = conflicting();
    rebaseAgentJob(f, () => {
      // The default branch, with the pull request merged into it, put on the pull request's branch.
      f.sh(f.work, 'reset', '-q', '--hard', 'origin/main');
      f.resolve(f.start);
    });
    const r = await pushRebase(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: PR_BRANCH, why: expect.stringMatching(/first parent/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-17] refuses two merge commits, and creates nothing', async () => {
    const f = conflicting();
    rebaseAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'side', f.start);
      f.commit('side.txt', 'side\n');
      f.sh(f.work, 'switch', '-q', PR_BRANCH);
      f.resolve();
      f.sh(f.work, 'merge', '-q', '--no-ff', '--no-edit', 'side');
    });
    const r = await pushRebase(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: PR_BRANCH, why: expect.stringMatching(/2 merge commits/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-17] refuses a branch that moved since the job fetched it: nothing is forced', async () => {
    const f = conflicting();
    rebaseAgentJob(f, () => { f.resolve(); });
    f.advanceBranch();
    const moved = f.onRemote('rev-parse', `refs/heads/${PR_BRANCH}`);
    const r = await pushRebase(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: PR_BRANCH })]);
    expect(r.calls.some((c) => c.method === 'PATCH' && c.body?.force === true)).toBe(false);
    expect(f.onRemote('rev-parse', `refs/heads/${PR_BRANCH}`)).toBe(moved);
  });

  it('refuses a pull request whose head is another branch, or a fork\'s, before it creates anything', async () => {
    for (const pull of [
      { ...PULL, head: { ...PULL.head, ref: 'feat/other' } },
      { ...PULL, head: { ...PULL.head, repo: { full_name: 'someone/fork' } } },
      { ...PULL, head: { ...PULL.head, repo: null } },
    ]) {
      const f = conflicting();
      rebaseAgentJob(f, () => { f.resolve(); });
      const r = await pushRebase(f, { pull });
      expect(r.refused, JSON.stringify(pull.head)).toEqual([expect.objectContaining({ branch: PR_BRANCH, why: expect.stringMatching(/#7/) })]);
      expect(writes(r.calls)).toEqual([]);
    }
  });

  it('the agent\'s job hands on nothing when the agent left no commit, as an aborted resolution leaves', () => {
    const f = conflicting();
    const handed = rebaseAgentJob(f, () => {
      spawnSync('git', ['merge', '--no-ff', '--no-commit', 'origin/main'], { cwd: f.work, env: CLEAN_ENV });
      f.sh(f.work, 'merge', '--abort');
    });
    expect(handed.outputs.commits).toBeUndefined();
    expect(existsSync(join(f.temp, 'kanon-push', 'commits.bundle'))).toBe(false);
  });

  it('[LANE-17] the push job\'s own step: pushes the merge from what the agent\'s job recorded, and writes its outputs', async () => {
    const f = conflicting();
    rebaseAgentJob(f, () => { f.resolve(); });
    const served = join(f.root, 'served');
    mkdirSync(served);
    writeFileSync(join(served, 'pulls.json'), JSON.stringify({ [PR]: PULL }));
    const api = await serveFake({ remote: f.remote, repo: REPO, appLogin: APP, dir: served });
    try {
      expect(rebasePush, 'rebase-run.yml has a push job with a `push` step').toBeDefined();
      const r = runWorkflowStep(rebasePush!, {
        env: {
          ...CLEAN_ENV, KANON: process.cwd(), RUNNER_TEMP: f.temp, GH_TOKEN: 'x', REPO,
          GITHUB_SERVER_URL: `file://${f.root}`, GITHUB_API_URL: api.url, APP_LOGIN: APP,
          PR: String(PR), START: f.start, MERGED: f.merged, REF: PR_BRANCH,
        },
      });
      expect(r.status, r.output).toBe(0);
      const head = f.onRemote('rev-parse', `refs/heads/${PR_BRANCH}`);
      expect(f.onRemote('rev-list', '--parents', '-n', '1', head).split(' ').slice(1)).toEqual([f.start, f.merged]);
      expect(JSON.parse(r.outputs.heads ?? '')).toEqual([{ ref: PR_BRANCH, sha: head }]);
      expect(r.outputs.base).toBe(f.start);
    } finally {
      api.stop();
    }
  });

  it('[LANE-17] the push job\'s own step refuses an empty recorded merge, and moves nothing (kanon#1466)', async () => {
    const f = conflicting();
    // Commits that hold no merge: an empty `--merged` read as absent would push them as a revise.
    rebaseAgentJob(f, () => { f.commit('one.txt', 'only my side\n', 'not a merge'); });
    const served = join(f.root, 'served');
    mkdirSync(served);
    writeFileSync(join(served, 'pulls.json'), JSON.stringify({ [PR]: PULL }));
    const api = await serveFake({ remote: f.remote, repo: REPO, appLogin: APP, dir: served });
    try {
      const r = runWorkflowStep(rebasePush!, {
        env: {
          ...CLEAN_ENV, KANON: process.cwd(), RUNNER_TEMP: f.temp, GH_TOKEN: 'x', REPO,
          GITHUB_SERVER_URL: `file://${f.root}`, GITHUB_API_URL: api.url, APP_LOGIN: APP,
          PR: String(PR), START: f.start, MERGED: '', REF: PR_BRANCH,
        },
      });
      expect(r.status, r.output).not.toBe(0);
      expect(r.output).toMatch(/--merged ""/);
      expect(f.onRemote('rev-parse', `refs/heads/${PR_BRANCH}`)).toBe(f.start);
    } finally {
      api.stop();
    }
  });
});

describe('the rebase lane\'s push job holds the key and runs nothing else (kanon#1384)', () => {
  type Job = { needs?: string | string[]; if?: string; steps?: WorkflowStep[]; outputs?: Record<string, string> };
  const job = (rebaseRun.jobs.push ?? {}) as Job;
  const steps = job.steps ?? [];
  /** The job's `if:`, for these needs. Only the forms it uses. */
  const gate = (expr: string, { commits = 'true', result = 'success' }: { commits?: string; result?: string }) => {
    // GitHub prefixes `success() &&` to an `if` that calls no status function, so a job gated on
    // outputs alone is skipped when the job it needs failed (kanon#1476).
    if (!/\b(always|cancelled|failure|success)\(\)/.test(expr) && result !== 'success') return false;
    const js = String(expr).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/!cancelled\(\)/g, 'true')
      .replace(/needs\.resolve\.result/g, JSON.stringify(result))
      .replace(/needs\.resolve\.outputs\.commits/g, JSON.stringify(commits))
      .replace(/'([^']*)'/g, (_, s: string) => JSON.stringify(s));
    expect(js, `an expression this evaluator doesn't read: ${expr}`).toMatch(/^[\s"\w!=&|()-]*$/);
    return Boolean(new Function(`return (${js});`)());
  };

  it('[LANE-14] on the rebase lane: runs after the agent\'s job whenever it left commits, a failed run\'s included', () => {
    expect([job.needs].flat()).toEqual(['resolve']);
    expect(gate(job.if!, {})).toBe(true);
    expect(gate(job.if!, { result: 'failure' })).toBe(true);
    expect(gate(job.if!, { commits: '' })).toBe(false);
    expect(gate(job.if!, { commits: 'false' })).toBe(false);
    // The agent's job hands its commits on whatever the agent did: always(), never success().
    for (const id of ['handoff', 'upload']) expect(rebaseSteps.find((s) => s.id === id)?.if, id).toMatch(/^always\(\)/);
    expect(rebaseAgent.jobs.resolve.outputs.commits).toBe("${{ steps.upload.outcome == 'success' }}");
    expect(rebaseAgent.on.workflow_call.outputs.commits.value).toBe('${{ jobs.resolve.outputs.commits }}');
    // One artifact per matrix entry: every entry of the lane's matrix runs in the same run.
    const upload = rebaseSteps.find((s) => s.id === 'upload')!;
    expect(upload.with?.name).toBe('kanon-push-${{ inputs.pr }}-${{ github.run_attempt }}');
  });

  it('[LANE-14] on the rebase lane: re-run on its own, reads the bundle the agent\'s job uploaded in its attempt, of this run alone (kanon#1465)', () => {
    const download = steps.find((s) => String(s.uses ?? '').startsWith('actions/download-artifact@'))!;
    // The agent's job says which attempt it ran in, as an output a partial re-run reuses; the push
    // job downloads that attempt's bundle for its pull request, never one from its own attempt.
    expect(rebaseAgent.jobs.resolve.outputs.attempt).toBe('${{ github.run_attempt }}');
    expect(rebaseAgent.on.workflow_call.outputs.attempt.value).toBe('${{ jobs.resolve.outputs.attempt }}');
    expect(download.with?.name).toBe('kanon-push-${{ inputs.pr }}-${{ needs.resolve.outputs.attempt }}');
    // An earlier attempt's artifact is read through the API, with this job's token, from this run only.
    expect(download.with?.['run-id']).toBe('${{ github.run_id }}');
    expect(download.with?.['github-token']).toBe('${{ steps.push-token.outputs.token }}');
    expect(download.with).not.toHaveProperty('repository');
  });

  it('[LANE-14] on the rebase lane: runs no agent and no project code, checks nothing out, and moves the branch with the verified-commit helper', () => {
    expect(steps.map((s) => s.uses ?? s.id)).toEqual(['$/actions/kanon-path', 'actions/create-github-app-token@v3', 'actions/download-artifact@v8', 'push']);
    expect(JSON.stringify(job)).not.toMatch(/claude|npm|\bmake\b|actions\/checkout|"\.\//i);
    expect(rebasePush?.run).toMatch(/node "\$KANON\/scripts\/lane-push\.mjs"/);
    expect(rebasePush?.run).toMatch(/--merged "\$MERGED"/);
    expect(rebasePush?.run).toMatch(/--ref "\$REF"/);
    expect(rebasePush?.run).toMatch(/--pr "\$PR"/);
    // What it builds on, merges and moves, each recorded by the agent's job before its agent ran.
    expect(rebasePush?.env).toMatchObject({
      PR: '${{ inputs.pr }}',
      START: '${{ needs.resolve.outputs.start }}',
      MERGED: '${{ needs.resolve.outputs.merged }}',
      REF: '${{ needs.resolve.outputs.head-ref }}',
    });
    expect(rebaseAgent.jobs.resolve.outputs).toMatchObject({
      start: '${{ steps.base.outputs.base }}', merged: '${{ steps.base.outputs.merged }}', 'head-ref': '${{ steps.base.outputs.ref }}',
    });
    for (const k of ['start', 'merged', 'head-ref']) expect(rebaseAgent.on.workflow_call.outputs[k].value, k).toBe(`\${{ jobs.resolve.outputs.${k} }}`);
    const at = (id: string) => rebaseSteps.findIndex((s) => s.id === id);
    expect(at('base')).toBeGreaterThan(at('checkout'));
    // Before the project's own code, which runs before the agent.
    expect(at('base')).toBeLessThan(at('project'));
    expect(at('project')).toBeLessThan(at('agent'));
  });

  it('[LANE-14] on the rebase lane: mints the Author App\'s token in the job, narrowed to the push, and never hands it on', () => {
    const mint = steps.find((s) => s.id === 'push-token')!;
    expect(mint.with).toEqual({
      'client-id': '${{ secrets.app-id }}',
      'private-key': '${{ secrets.app-private-key }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'read',
      'permission-workflows': 'write',
      'permission-actions': 'read',
    });
    expect(rebasePush?.env?.GH_TOKEN).toBe('${{ steps.push-token.outputs.token }}');
    expect(Object.values(job.outputs ?? {}).join(' ')).not.toMatch(/token/);
  });

  it('the rebase agent\'s job records the pull request\'s head, its branch and the default branch\'s head as it fetched them', () => {
    const step = rebaseSteps.find((s) => s.id === 'base')!;
    const f = conflicting();
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    // `gh` answers the pull request's branch and the repository's default branch.
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncase "$*" in\n  *headRefName*) echo ${PR_BRANCH} ;;\n  *defaultBranchRef*) echo main ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
    const r = runWorkflowStep(step, { cwd: f.work, env: { ...CLEAN_ENV, PATH: `${bin}:${process.env.PATH ?? ''}`, PR_NUMBER: String(PR), REPO } });
    expect(r.status, r.output).toBe(0);
    expect(r.outputs).toMatchObject({ base: f.start, ref: PR_BRANCH, merged: f.merged });
  });
});

// ── The Lead's split lane's push job (kanon#1385, docs/projects/1373.md Issue D) ──────────────

const splitRun = parse(readFileSync('.github/workflows/lead-split-run.yml', 'utf8'));
const splitAgent = parse(readFileSync('.github/workflows/lead-split-agent-job.yml', 'utf8'));
const splitSteps = splitAgent.jobs.split.steps as WorkflowStep[];
const splitPush = (splitRun.jobs.push?.steps as WorkflowStep[] | undefined)?.find((s) => s.id === 'push');

const SPLIT = 'lead/split-7';
const SPLIT_LABELS = ['review:please'];
const SPLIT_REQUEST = { branch: SPLIT, base: 'main', title: 'docs(projects): split #7 into C1 and C2', body: 'Closes #7.\n\nWhy it exhausted.', labels: SPLIT_LABELS };

/** A dead split branch on the remote: an earlier split's, whose pull request closed unmerged. */
const deadSplit = (f: Fixture) => {
  const person = join(f.root, 'person');
  f.sh(f.root, 'clone', '-q', f.remote, person);
  f.sh(person, 'switch', '-q', '-c', SPLIT);
  writeFileSync(join(person, 'dead.md'), 'an earlier split\n');
  f.sh(person, 'add', '.');
  f.sh(person, '-c', 'user.name=Pat', '-c', 'user.email=pat@example.invalid', 'commit', '-qm', 'an earlier split');
  f.sh(person, 'push', '-q', 'origin', `HEAD:refs/heads/${SPLIT}`);
  return f.onRemote('rev-parse', `refs/heads/${SPLIT}`);
};

/** The split agent's job's own steps, run in its checkout: the exclusion before the agent, the handoff after. */
const splitAgentJob = (f: Fixture, agent: () => void) => {
  const env = { ...CLEAN_ENV, RUNNER_TEMP: f.temp, START: f.start };
  const excluded = runWorkflowStep(splitSteps.find((s) => s.id === 'exclude-request')!, { cwd: f.work, env });
  expect(excluded.status, excluded.output).toBe(0);
  agent();
  const handed = runWorkflowStep(splitSteps.find((s) => s.id === 'handoff')!, { cwd: f.work, env });
  expect(handed.status, handed.output).toBe(0);
  return handed;
};

/** The split agent's work, as its prompt has it: a branch fresh from the default branch, one commit. */
const split = (f: Fixture, request: unknown = SPLIT_REQUEST) => () => {
  f.sh(f.work, 'checkout', '-q', '-B', SPLIT, 'origin/main');
  f.commit('docs/projects/1.md', '### Issue C1\n### Issue C2\n', 'docs(projects): split #7 into C1 and C2');
  if (request) writeRequest(f, request);
};

/** The split lane's push, in process: replace mode on the branch the lane names. */
const pushSplit = async (f: Fixture, { replace = SPLIT, pulls = {} as Record<string, unknown>, ref = '' } = {}) => {
  const gh = fakeGitHub({
    remote: f.remote, repo: REPO, appLogin: APP, pulls,
    before: (call: Call) => {
      if (call.method === 'POST' && call.path === `repos/${REPO}/pulls`) return { status: 201, headers: {}, json: { number: 42 } };
      if (call.method === 'POST' && call.path === `repos/${REPO}/issues/42/labels`) return { status: 200, headers: {}, json: [] };
      return undefined;
    },
  });
  const dir = join(f.temp, 'kanon-push');
  const store = join(f.root, `store-${Math.random().toString(36).slice(2)}`);
  const { prereqs } = prepareStore({ store, bundle: join(dir, 'commits.bundle'), start: f.start, server: `file://${f.root}`, repo: REPO, token: 'x' });
  const text = existsSync(join(dir, 'request.json')) ? readFileSync(join(dir, 'request.json'), 'utf8') : '';
  // Replace mode asks GitHub after no branch: the lane names the one that moves, which may exist.
  const r = await pushLane({
    gitDir: store, prereqs, start: f.start, replace, ref, request: text ? readRequest(text) : null, labels: SPLIT_LABELS,
    appLogin: APP, repo: REPO, api: gh.request, sleep: async () => {},
  });
  return { ...r, calls: gh.calls as Call[] };
};

describe('the split lane\'s push (kanon#1385)', () => {
  it('[LANE-18] replaces a dead split branch in the helper\'s replace mode, then opens the pull request from the agent\'s request', async () => {
    const f = fixture({ depth: 0 });
    const dead = deadSplit(f);
    splitAgentJob(f, split(f));
    const r = await pushSplit(f);
    expect(r.refused).toEqual([]);
    const head = f.onRemote('rev-parse', `refs/heads/${SPLIT}`);
    expect(head).not.toBe(dead);
    expect(f.onRemote('log', '-1', '--format=%an', head)).toBe(APP);
    // Built over the commit the run checked out, which GitHub still has on the default branch.
    expect(f.onRemote('rev-parse', `${head}^`)).toBe(f.start);
    expect(r.calls.some((c) => c.path === `repos/${REPO}/compare/${f.start}...main`)).toBe(true);
    expect(r.heads).toEqual([{ ref: SPLIT, sha: head }]);
    expect(r.base).toBe(f.start);
    // Forced, and only after the read-back; the pull request only after the move.
    const moved = r.calls.findIndex((c) => c.method === 'PATCH');
    expect(r.calls[moved]).toEqual({ method: 'PATCH', path: `repos/${REPO}/git/refs/heads/${SPLIT}`, body: { sha: head, force: true } });
    const opened = at(r.calls, 'POST', 'pulls');
    expect(opened).toBeGreaterThan(moved);
    expect(r.calls[opened]!.body).toEqual({ head: SPLIT, base: 'main', title: SPLIT_REQUEST.title, body: SPLIT_REQUEST.body });
    expect(r.calls[at(r.calls, 'POST', 'issues/42/labels')]!.body).toEqual({ labels: SPLIT_LABELS });
    expect(r.pr).toBe(42);
    expect(r.lines.join('\n')).toMatch(new RegExp(`\\*\\*${SPLIT}\\*\\* replaced`));
  });

  it('[LANE-18] creates the split branch when none exists yet', async () => {
    const f = fixture({ depth: 0 });
    splitAgentJob(f, split(f));
    const r = await pushSplit(f);
    expect(r.refused).toEqual([]);
    expect(at(r.calls, 'POST', 'git/refs')).toBeGreaterThan(-1);
    expect(f.onRemote('rev-parse', `refs/heads/${SPLIT}^`)).toBe(f.start);
    expect(r.pr).toBe(42);
  });

  it('[LANE-15] in replace mode, refuses a request for any branch but the one the lane names, and creates nothing', async () => {
    const f = fixture({ depth: 0 });
    splitAgentJob(f, () => {
      split(f, { ...SPLIT_REQUEST, branch: 'lead/split-8' })();
      f.sh(f.work, 'branch', 'lead/split-8');
    });
    const r = await pushSplit(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'lead/split-8', why: expect.stringMatching(/the request is refused: .*lead\/split-7/) })]);
    expect(writes(r.calls)).toEqual([]);
    expect(r.heads).toEqual([]);
  });

  it('[LANE-15] in replace mode, refuses a request whose base is not the default branch, and creates nothing', async () => {
    const f = fixture({ depth: 0 });
    splitAgentJob(f, split(f, { ...SPLIT_REQUEST, base: 'release' }));
    const r = await pushSplit(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: SPLIT, why: expect.stringMatching(/base/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-15] in replace mode, refuses a request with a label the lane never had, and creates nothing', async () => {
    const f = fixture({ depth: 0 });
    splitAgentJob(f, split(f, { ...SPLIT_REQUEST, labels: ['review:please', 'agent:merge'] }));
    const r = await pushSplit(f);
    expect(r.refused).toEqual([expect.objectContaining({ branch: SPLIT, why: expect.stringMatching(/agent:merge/) })]);
    expect(writes(r.calls)).toEqual([]);
  });

  it('[LANE-18] refuses to replace a branch that heads an open pull request, before it creates anything', async () => {
    const f = fixture({ depth: 0 });
    const dead = deadSplit(f);
    splitAgentJob(f, split(f));
    const r = await pushSplit(f, { pulls: { 5: { head: { ref: SPLIT, repo: { full_name: REPO } } } } });
    expect(r.refused).toEqual([expect.objectContaining({ branch: SPLIT, why: expect.stringMatching(/open pull request #5/) })]);
    expect(writes(r.calls)).toEqual([]);
    expect(f.onRemote('rev-parse', `refs/heads/${SPLIT}`)).toBe(dead);
    // It asked GitHub about exactly that branch, of this repository.
    expect(r.calls.some((c) => c.method === 'GET' && c.path === `repos/${REPO}/pulls?head=${encodeURIComponent(`example-org:${SPLIT}`)}&state=open`)).toBe(true);
  });

  it('[LANE-18] with no request, as a crashed agent leaves, still replaces the branch, opens no pull request, and leaves the agent\'s other branches on its runner', async () => {
    const f = fixture({ depth: 0 });
    deadSplit(f);
    splitAgentJob(f, () => {
      f.sh(f.work, 'switch', '-q', '-c', 'scratch');
      f.commit('scratch.txt', 'try\n');
      split(f, null)();
    });
    const r = await pushSplit(f);
    expect(r.refused).toEqual([]);
    expect(r.heads.map((h) => h.ref)).toEqual([SPLIT]);
    expect(f.onRemote('rev-parse', `refs/heads/${SPLIT}`)).toBe(r.heads[0]!.sha);
    expect(r.left).toEqual(['scratch']);
    expect(at(r.calls, 'POST', 'pulls')).toBe(-1);
    expect(r.lines.join('\n')).toMatch(/no request, so no pull request was opened/i);
  });

  it('[LANE-18] never replaces the default branch, whatever the lane names', async () => {
    const f = fixture({ depth: 0 });
    splitAgentJob(f, () => { f.commit('on-main.txt', 'not here\n'); });
    const r = await pushSplit(f, { replace: 'main' });
    expect(r.refused).toEqual([expect.objectContaining({ branch: 'main', why: expect.stringMatching(/default branch/) })]);
    expect(writes(r.calls)).toEqual([]);
    expect(f.onRemote('rev-parse', 'refs/heads/main')).toBe(f.start);
  });

  it('replace mode names the one branch a lane opens, so it comes with no --ref', async () => {
    const f = fixture({ depth: 0 });
    splitAgentJob(f, split(f));
    await expect(pushSplit(f, { ref: 'fix/1-thing' })).rejects.toThrow(/--replace/);
  });

  it('[LANE-18] the split push job\'s own step: works out the branch from the issue, replaces it, and writes its outputs', async () => {
    const f = fixture({ depth: 0 });
    deadSplit(f);
    splitAgentJob(f, split(f));
    const served = join(f.root, 'served');
    mkdirSync(served);
    const api = await serveFake({ remote: f.remote, repo: REPO, appLogin: APP, dir: served });
    try {
      const r = runWorkflowStep(splitPush!, {
        env: {
          ...CLEAN_ENV, KANON: process.cwd(), RUNNER_TEMP: f.temp, GH_TOKEN: 'x', REPO, GITHUB_REPOSITORY: REPO,
          GITHUB_SERVER_URL: `file://${f.root}`, GITHUB_API_URL: api.url, APP_LOGIN: APP, START: f.start, ISSUE: '7',
        },
      });
      const head = f.onRemote('rev-parse', `refs/heads/${SPLIT}`);
      expect(f.onRemote('log', '-1', '--format=%an', head)).toBe(APP);
      expect(JSON.parse(r.outputs.heads ?? '')).toEqual([{ ref: SPLIT, sha: head }]);
      expect(r.outputs.base).toBe(f.start);
      const calls = api.calls() as Call[];
      expect(calls.some((c) => c.method === 'PATCH' && c.path === `repos/${REPO}/git/refs/heads/${SPLIT}` && c.body?.force === true)).toBe(true);
      expect(calls.some((c) => c.method === 'POST' && c.path === `repos/${REPO}/pulls`)).toBe(true);
      // The double opens no pull request, so the step fails, by name.
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/pull request/);
    } finally {
      api.stop();
    }
  });

  it('the split push job\'s step refuses an issue that is not a number, before any request', () => {
    const r = runWorkflowStep(splitPush!, {
      env: { ...CLEAN_ENV, KANON: process.cwd(), RUNNER_TEMP: tmpdir(), GH_TOKEN: 'x', REPO, GITHUB_REPOSITORY: REPO, APP_LOGIN: APP, START: 'a'.repeat(40), ISSUE: '7/../main' },
    });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/issue/);
  });
});

describe('the split lane\'s push job holds the key and runs nothing else (kanon#1385)', () => {
  type Job = { needs?: string | string[]; if?: string; steps?: WorkflowStep[]; outputs?: Record<string, string>; uses?: string };
  const job = (splitRun.jobs.push ?? {}) as Job;
  const steps = job.steps ?? [];
  /** The job's `if:`, for these needs. Only the forms it uses. */
  const gate = (expr: string, { commits = 'true', result = 'success', act = 'split' }: { commits?: string; result?: string; act?: string }) => {
    // GitHub prefixes `success() &&` to an `if` that calls no status function, so a job gated on
    // outputs alone is skipped when the job it needs failed.
    if (!/\b(always|cancelled|failure|success)\(\)/.test(expr) && result !== 'success') return false;
    const js = String(expr).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/!cancelled\(\)/g, 'true')
      .replace(/needs\.split\.result/g, JSON.stringify(result))
      .replace(/needs\.split\.outputs\.commits/g, JSON.stringify(commits))
      .replace(/needs\.split\.outputs\.act/g, JSON.stringify(act))
      .replace(/'([^']*)'/g, (_, s: string) => JSON.stringify(s));
    expect(js, `an expression this evaluator doesn't read: ${expr}`).toMatch(/^[\s"\w!=&|()-]*$/);
    return Boolean(new Function(`return (${js});`)());
  };

  it('[LANE-14] on the split lane: runs after the agent\'s job whenever it left commits, a failed run\'s included', () => {
    expect([job.needs].flat()).toEqual(['split']);
    expect(gate(job.if!, {})).toBe(true);
    expect(gate(job.if!, { result: 'failure' })).toBe(true);
    expect(gate(job.if!, { commits: '' })).toBe(false);
    expect(gate(job.if!, { commits: 'false' })).toBe(false);
    // The agent's job hands its commits on whatever the agent did: always(), never success().
    for (const id of ['handoff', 'upload']) expect(splitSteps.find((s) => s.id === id)?.if, id).toMatch(/^always\(\)/);
    expect(splitAgent.jobs.split.outputs.commits).toBe("${{ steps.upload.outcome == 'success' }}");
    for (const k of ['commits', 'start', 'act']) expect(splitAgent.on.workflow_call.outputs[k].value, k).toBe(`\${{ jobs.split.outputs.${k} }}`);
    const upload = splitSteps.find((s) => s.id === 'upload')!;
    const download = steps.find((s) => String(s.uses ?? '').startsWith('actions/download-artifact@'))!;
    expect(download.with?.name).toBe(upload.with?.name);
  });

  it('[LANE-14] on the split lane: runs no agent and no project code, checks nothing out, and moves the branch with the verified-commit helper', () => {
    expect(steps.map((s) => s.uses ?? s.id)).toEqual(['$/actions/kanon-path', 'actions/create-github-app-token@v3', 'actions/download-artifact@v8', 'push']);
    expect(JSON.stringify(job)).not.toMatch(/claude|npm|\bmake\b|actions\/checkout|"\.\//i);
    expect(splitPush?.run).toMatch(/node "\$KANON\/scripts\/lane-push\.mjs"/);
    expect(splitPush?.run).toMatch(/--replace "\$branch"/);
    expect(splitPush?.run).not.toMatch(/--ref\b/);
    // The branch is the lane's, from the issue the run was started for, never from the agent's job.
    expect(splitPush?.run).toMatch(/branch="\$\(node "\$KANON\/scripts\/split-lineage\.mjs" branch\)"/);
    expect(splitPush?.env?.ISSUE).toBe('${{ github.event.issue.number || inputs.issue }}');
    expect(JSON.stringify(splitPush?.env)).not.toMatch(/needs\.split\.outputs\.(?!start)/);
    // The commit the agent's job checked out, set by its checkout before the agent ran.
    expect(splitPush?.env?.START).toBe('${{ needs.split.outputs.start }}');
    expect(splitAgent.jobs.split.outputs.start).toBe('${{ steps.checkout.outputs.commit }}');
  });

  it('[LANE-14] on the split lane: mints the Author App\'s token in the job, narrowed to the push, and never hands it on', () => {
    const mint = steps.find((s) => s.id === 'push-token')!;
    expect(mint.with).toEqual({
      'client-id': '${{ secrets.app-id }}',
      'private-key': '${{ secrets.app-private-key }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(splitPush?.env?.GH_TOKEN).toBe('${{ steps.push-token.outputs.token }}');
    expect(Object.values(job.outputs ?? {}).join(' ')).not.toMatch(/token/);
  });

  it('[LANE-18] the split agent is told to commit and write its request, and never to push or open the pull request', () => {
    const agent = splitSteps.find((s) => s.id === 'agent')!;
    const prompt = String(agent.with?.prompt);
    // It may say that a push fails, as the spine's prompts do; it never says to make one.
    expect(prompt).not.toMatch(/git push (--force|origin)|push over it/);
    expect(prompt).toMatch(/`git push` fails/);
    expect(prompt).not.toMatch(/OPEN ONE PR/);
    expect(prompt).toContain(REQUEST_PATH);
    expect(prompt).toMatch(/"labels": \["review:please"\]/);
    // Nothing in the agent's job pushes, or probes a push its token can't make.
    expect(JSON.stringify(splitAgent)).not.toMatch(/git push (--force|--dry-run|origin)|push-probe/);
  });

  it('the split agent\'s job keeps the request out of its commits and hands them on with the spine\'s own steps', () => {
    for (const id of ['exclude-request', 'handoff']) {
      const mine = splitSteps.find((s) => s.id === id)!;
      const spines = agentSteps.find((s) => s.id === id)!;
      expect(mine.run, id).toBe(spines.run);
      expect(mine.env ?? {}, id).toEqual(spines.env ?? {});
      expect(String(mine.if), id).toMatch(/steps\.gate\.outputs\.act == 'split'/);
    }
    const at = (id: string) => splitSteps.findIndex((s) => s.id === id);
    expect(at('exclude-request')).toBeLessThan(at('agent'));
    expect(at('handoff')).toBeGreaterThan(at('agent'));
    expect(at('upload')).toBe(at('handoff') + 1);
  });

  it('asks whether a split pull request opened only after the push, on the default token, holding no key', () => {
    const check = splitRun.jobs.check as Job & { steps: WorkflowStep[] };
    expect([check.needs].flat().sort()).toEqual(['push', 'split']);
    expect(check.if).toMatch(/!cancelled\(\)/);
    expect(check.if).toMatch(/needs\.split\.outputs\.act == 'split'/);
    expect(JSON.stringify(check)).not.toMatch(/app-private-key|app-token|actions\/checkout|claude/);
    const step = check.steps.find((s) => /split PR open/.test(String(s.name)))!;
    expect(step.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(step.run).toMatch(/split-lineage\.mjs" check-pr/);
    expect(step.run).toContain('the split run finished with no open PR on $BRANCH');
    // Not in the agent's job any more, where it would always find nothing.
    expect(splitSteps.some((s) => /split PR open/.test(String(s.name)))).toBe(false);
  });
});
