import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SPAWNS } from './helpers/spawns.js';
import { fakeGitHub, serveFake } from './helpers/fake-git-data-api.mjs';
import { MAX_WAIT_MS, PACE_MS, READBACK, RETRIES, UNNAMED_WAIT_MS, pushVerified, validBranch } from '../../scripts/lib/verified-commits.mjs';

// Every case builds real repositories with `git`, so every case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// The verified-commit helper (kanon#1382), against a recording double of GitHub's Git Data API
// over a real bare repository (tests/unit/helpers/fake-git-data-api.mjs): a commit the double
// creates is the App's and verified, and one that arrived by `git push` is a person's.

const REPO = 'example-org/example-repo';
const APP = 'example-author[bot]';
// A runner's identity and config in `GIT_*` (a hook path, an author) would rewrite the fixture's commits.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER|CONFIG)/.test(k)));
type Call = { method: string; path: string; body?: Record<string, unknown> };
type Answer = { status: number; headers: Record<string, string>; json: unknown };

/** A remote with `main`, a clone of it, and the helper bound to the double over the remote. */
const fixture = (opts: Omit<Parameters<typeof fakeGitHub>[0], 'remote' | 'repo' | 'appLogin'> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'verified-commits-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const sh = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: CLEAN_ENV });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(root, 'clone', '-q', remote, work);
  sh(work, 'config', 'user.email', 'agent@example.invalid');
  sh(work, 'config', 'user.name', 'agent');
  const w = (f: string, t: string) => { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), t); };
  w('a.txt', 'a\n');
  w('b.txt', 'b\n');
  w('gone.txt', 'gone\n');
  w('bin/run.sh', '#!/bin/sh\n');
  chmodSync(join(work, 'bin/run.sh'), 0o755);
  symlinkSync('a.txt', join(work, 'link'));
  sh(work, 'add', '.');
  sh(work, 'commit', '-qm', 'base');
  sh(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const base = sh(work, 'rev-parse', 'HEAD');
  const commit = (msg: string, edit: () => void) => {
    edit();
    sh(work, 'add', '-A');
    sh(work, 'commit', '-q', '--allow-empty', '-m', msg);
    return sh(work, 'rev-parse', 'HEAD');
  };
  const gh = fakeGitHub({ remote, repo: REPO, appLogin: APP, ...opts });
  let t = 0;
  const slept: number[] = [];
  const at: number[] = [];
  const push = (o: { branch?: string; head?: string; replace?: boolean; tip?: string; appLogin?: string } = {}) => pushVerified({
    gitDir: join(work, '.git'), tip: o.tip ?? 'HEAD', branch: o.branch ?? 'feature', ...(o.replace ? { replace: true, ...(o.head ? { head: o.head } : {}) } : { head: o.head ?? base }),
    appLogin: o.appLogin ?? APP, repo: REPO,
    request: (method: string, path: string, body?: unknown) => { at.push(t); return gh.request(method, path, body); },
    sleep: async (ms: number) => { slept.push(ms); t += ms; }, now: () => t,
  });
  const onRemote = (...a: string[]) => sh(root, '--git-dir', remote, ...a);
  const writes = () => gh.calls.filter((c: Call) => c.method !== 'GET');
  return { root, remote, work, sh, w, base, commit, gh, push, onRemote, writes, slept, at, calls: gh.calls as Call[] };
};

const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.path === `repos/${REPO}/${path}`);
const refMoves = (calls: Call[]) => calls.filter((c) => c.path.startsWith(`repos/${REPO}/git/refs`) && c.method !== 'GET');

describe('the verified-commit helper (kanon#1382)', () => {
  it("[LANE-6] re-creates only the commits the repository lacks, and keeps a fetched person's commit as it is", async () => {
    const f = fixture();
    // A person pushes to main mid-run; the agent fetches it and builds on it.
    const other = join(f.root, 'person');
    f.sh(f.root, 'clone', '-q', f.remote, other);
    f.sh(other, '-c', 'user.name=Pat', '-c', 'user.email=pat@example.invalid', 'commit', '-q', '--allow-empty', '-m', "a person's commit");
    f.sh(other, 'push', '-q', 'origin', 'HEAD:main');
    const person = f.sh(other, 'rev-parse', 'HEAD');
    f.sh(f.work, 'pull', '-q', '--ff-only', 'origin', 'main');
    const mine = f.commit("the agent's commit", () => f.w('a.txt', 'a2\n'));

    const r = await f.push();
    // The range was the person's commit and the agent's, and only the agent's was re-created.
    expect(r.created.map((c) => c.local)).toEqual([mine]);
    expect(posts(f.calls, 'git/commits')).toHaveLength(1);
    expect(posts(f.calls, 'git/commits')[0]!.body!.parents).toEqual([person]);
    // The branch is built on the person's own commit, which keeps its author and stays unverified.
    expect(f.onRemote('rev-parse', 'feature^')).toBe(person);
    expect(f.onRemote('log', '-1', '--format=%an', person)).toBe('Pat');
    expect(f.gh.byApi.has(person)).toBe(false);
    expect(f.calls.some((c) => c.path === `repos/${REPO}/commits/${person}`)).toBe(false);
  });

  it('[LANE-6] maps a re-created parent to the commit created from it, oldest first', async () => {
    const f = fixture();
    const one = f.commit('one', () => f.w('a.txt', 'one\n'));
    const two = f.commit('two', () => f.w('a.txt', 'two\n'));
    const r = await f.push();
    expect(r.created.map((c) => c.local)).toEqual([one, two]);
    const [first, second] = posts(f.calls, 'git/commits');
    expect(first!.body!.parents).toEqual([f.base]);
    expect(second!.body!.parents).toEqual([r.created[0]!.remote]);
  });

  describe('[LANE-7] the same tree id, and no submodule', () => {
    it('[LANE-7] keeps every path, its content, its deletion and its mode', async () => {
      const f = fixture();
      const one = f.commit('change every kind of entry', () => {
        f.w('a.txt', 'a, changed\n');
        f.w('new/deep/file.txt', 'new\n');
        rmSync(join(f.work, 'gone.txt'));
        chmodSync(join(f.work, 'b.txt'), 0o755);
        chmodSync(join(f.work, 'bin/run.sh'), 0o644);
        rmSync(join(f.work, 'link'));
        symlinkSync('b.txt', join(f.work, 'link'));
        symlinkSync('new/deep', join(f.work, 'shortcut'));
      });
      const two = f.commit('and a second commit on it', () => f.w('b.txt', 'b, changed\n'));
      const r = await f.push();
      for (const [i, local] of [one, two].entries()) {
        expect(f.onRemote('rev-parse', `${r.created[i]!.remote}^{tree}`)).toBe(f.sh(f.work, 'rev-parse', `${local}^{tree}`));
      }
      const tree = posts(f.calls, 'git/trees')[0]!.body!.tree as { path: string; mode: string; sha: string | null }[];
      expect(tree).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'gone.txt', sha: null }),
        expect.objectContaining({ path: 'b.txt', mode: '100755' }),
        expect.objectContaining({ path: 'bin/run.sh', mode: '100644' }),
        expect.objectContaining({ path: 'link', mode: '120000' }),
        expect.objectContaining({ path: 'shortcut', mode: '120000' }),
      ]));
      expect(f.onRemote('ls-tree', '-r', 'feature')).toBe(f.sh(f.work, 'ls-tree', '-r', 'HEAD'));
    });

    it('[LANE-7] creates no commit from a tree GitHub built with another id', async () => {
      const wrong = 'f'.repeat(40);
      const f = fixture({
        before: (c: Call) => (c.method === 'POST' && c.path.endsWith('/git/trees') ? { status: 201, headers: {}, json: { sha: wrong } } : undefined),
      });
      f.commit('one', () => f.w('a.txt', 'one\n'));
      await expect(f.push()).rejects.toThrow(/tree as f{40}, not [0-9a-f]{40}, so no commit was created/);
      expect(posts(f.calls, 'git/commits')).toEqual([]);
      expect(refMoves(f.calls)).toEqual([]);
    });

    it('[LANE-7] refuses a range that adds a submodule, before any request that creates an object', async () => {
      const f = fixture();
      f.commit('a plain commit first', () => f.w('a.txt', 'one\n'));
      f.sh(f.work, 'update-index', '--add', '--cacheinfo', `160000,${f.base},vendor/lib`);
      f.sh(f.work, 'commit', '-qm', 'add a submodule');
      await expect(f.push()).rejects.toThrow(/changes the submodule `vendor\/lib`/);
      expect(f.writes()).toEqual([]);
    });

    it('[LANE-7] refuses a range that removes or changes a submodule', async () => {
      const f = fixture();
      f.sh(f.work, 'update-index', '--add', '--cacheinfo', `160000,${f.base},vendor/lib`);
      f.sh(f.work, 'commit', '-qm', 'add a submodule');
      f.sh(f.work, 'push', '-q', 'origin', 'HEAD:main');
      const start = f.sh(f.work, 'rev-parse', 'HEAD');
      f.sh(f.work, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/lib`);
      f.sh(f.work, 'commit', '-qm', 'move it');
      await expect(f.push({ head: start })).rejects.toThrow(/changes the submodule `vendor\/lib`/);
      f.sh(f.work, 'reset', '-q', '--hard', start);
      f.sh(f.work, 'update-index', '--force-remove', 'vendor/lib');
      f.sh(f.work, 'commit', '-qm', 'remove it');
      await expect(f.push({ head: start })).rejects.toThrow(/changes the submodule `vendor\/lib`/);
      expect(f.writes()).toEqual([]);
    });
  });

  it('[LANE-8] sends the message byte for byte, trailers included, and no author, committer or signature', async () => {
    const f = fixture();
    const message = 'fix(x): a subject  \n\n\n  An indented body, with trailing space   \n# not a comment\nÜñíçødé ✓\n\nSigned-off-by: Dee Legate <dee@example.org>\nCo-Authored-By: Someone <s@example.org>\n\n';
    writeFileSync(join(f.root, 'msg'), message);
    f.w('a.txt', 'one\n');
    f.sh(f.work, 'add', '-A');
    f.sh(f.work, '-c', 'commit.gpgSign=false', 'commit', '-q', '--cleanup=verbatim', '-F', join(f.root, 'msg'));
    const r = await f.push();
    const [sent] = posts(f.calls, 'git/commits');
    expect(Object.keys(sent!.body!).sort()).toEqual(['message', 'parents', 'tree']);
    expect(sent!.body!.message).toBe(message);
    expect(f.onRemote('cat-file', 'commit', r.head).split('\n\n').slice(1).join('\n\n')).toBe(message.trimEnd());
    const raw = spawnSync('git', ['--git-dir', f.remote, 'cat-file', 'commit', r.head], { env: CLEAN_ENV }).stdout as Buffer;
    expect(raw.subarray(raw.indexOf('\n\n') + 2).equals(Buffer.from(message))).toBe(true);
  });

  describe('[LANE-9] the read-back before any branch moves', () => {
    it('[LANE-9] reads back every created commit, verified as the App\'s, before the branch moves', async () => {
      const f = fixture();
      f.commit('one', () => f.w('a.txt', 'one\n'));
      f.commit('two', () => f.w('a.txt', 'two\n'));
      const r = await f.push();
      const readBacks = r.created.map((c) => f.calls.findIndex((x) => x.method === 'GET' && x.path === `repos/${REPO}/commits/${c.remote}`));
      const move = f.calls.findIndex((x) => refMoves([x]).length > 0);
      expect(readBacks.every((i) => i !== -1 && i < move)).toBe(true);
    });

    it('[LANE-9] moves nothing when a created commit is unverified, and names it and the reason', async () => {
      const f = fixture({ verification: (_sha: string, api: boolean) => (api ? { verified: false, reason: 'unsigned' } : undefined) });
      f.commit('one', () => f.w('a.txt', 'one\n'));
      const err = await f.push().then(() => '', (e: Error) => e.message);
      const created = posts(f.calls, 'git/commits').length && [...f.gh.byApi][0];
      expect(err).toContain(`${created} is not verified (unsigned)`);
      expect(refMoves(f.calls)).toEqual([]);
      expect(f.onRemote('for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
      // The answer may lag; it is read again within the bound, and no more.
      expect(f.calls.filter((c) => c.path === `repos/${REPO}/commits/${created}`)).toHaveLength(READBACK.tries);
    });

    it('[LANE-9] moves nothing when a created commit is verified under another account', async () => {
      const f = fixture();
      f.commit('one', () => f.w('a.txt', 'one\n'));
      const err = await f.push({ appLogin: 'another-app[bot]' }).then(() => '', (e: Error) => e.message);
      expect(err).toMatch(/is verified with example-author\[bot\] as its author, not another-app\[bot\], so no branch moved/);
      expect(refMoves(f.calls)).toEqual([]);
    });

    it('[LANE-9] waits out a verification that lags, within the bound', async () => {
      let reads = 0;
      const f = fixture({ verification: (_sha: string, api: boolean) => (api && reads++ === 0 ? { verified: false, reason: 'unsigned' } : undefined) });
      f.commit('one', () => f.w('a.txt', 'one\n'));
      const r = await f.push();
      expect(r.move).toBe('created');
      expect(f.slept).toContain(READBACK.waitMs);
    });
  });

  describe('[LANE-10] create, fast-forward or refuse; force only in replace mode', () => {
    it('[LANE-10] creates a branch that does not exist, and reports its head, its commits and its base', async () => {
      const f = fixture();
      const one = f.commit('one', () => f.w('a.txt', 'one\n'));
      const r = await f.push();
      expect(r).toEqual({ head: f.onRemote('rev-parse', 'feature'), base: f.base, created: [{ local: one, remote: r.head }], move: 'created' });
      expect(refMoves(f.calls)).toEqual([{ method: 'POST', path: `repos/${REPO}/git/refs`, body: { ref: 'refs/heads/feature', sha: r.head } }]);
    });

    it('[LANE-10] moves a branch still at the head it was given without force', async () => {
      const f = fixture();
      f.sh(f.work, 'push', '-q', 'origin', `${f.base}:refs/heads/feature`);
      f.commit('one', () => f.w('a.txt', 'one\n'));
      const r = await f.push();
      expect(r.move).toBe('moved');
      expect(refMoves(f.calls)).toEqual([{ method: 'PATCH', path: `repos/${REPO}/git/refs/heads/feature`, body: { sha: r.head, force: false } }]);
      expect(f.onRemote('rev-parse', 'feature')).toBe(r.head);
    });

    it('[LANE-10] refuses a branch that moved from the head it was given, and creates nothing', async () => {
      const f = fixture();
      const other = join(f.root, 'person');
      f.sh(f.root, 'clone', '-q', f.remote, other);
      f.sh(other, '-c', 'user.name=Pat', '-c', 'user.email=pat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'pushed meanwhile');
      f.sh(other, 'push', '-q', 'origin', 'HEAD:refs/heads/feature');
      const moved = f.sh(other, 'rev-parse', 'HEAD');
      f.commit('one', () => f.w('a.txt', 'one\n'));
      await expect(f.push()).rejects.toThrow(`feature is at ${moved.slice(0, 7)}, not ${f.base.slice(0, 7)}`);
      expect(f.writes()).toEqual([]);
      expect(f.onRemote('rev-parse', 'feature')).toBe(moved);
    });

    it('[LANE-10] refuses a tip not built on the head it was given', async () => {
      const f = fixture();
      const elsewhere = f.commit('one', () => f.w('a.txt', 'one\n'));
      f.sh(f.work, 'reset', '-q', '--hard', f.base);
      f.commit('two', () => f.w('a.txt', 'two\n'));
      await expect(f.push({ head: elsewhere })).rejects.toThrow(/is not built on/);
      expect(f.writes()).toEqual([]);
    });

    it('[LANE-10] forces only in replace mode, over the default branch\'s head', async () => {
      const f = fixture();
      // A dead branch, on a commit main never had.
      f.commit('dead', () => f.w('a.txt', 'dead\n'));
      f.sh(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/split');
      const dead = f.sh(f.work, 'rev-parse', 'HEAD');
      f.sh(f.work, 'reset', '-q', '--hard', f.base);
      f.commit('fresh', () => f.w('a.txt', 'fresh\n'));
      // Without replace mode, the dead branch refuses the push.
      await expect(f.push({ branch: 'split' })).rejects.toThrow(`split is at ${dead.slice(0, 7)}`);
      expect(f.calls.some((c) => (c.body as { force?: boolean } | undefined)?.force === true)).toBe(false);
      const r = await f.push({ branch: 'split', replace: true });
      expect(r).toMatchObject({ base: f.base, move: 'forced' });
      expect(refMoves(f.calls)).toEqual([{ method: 'PATCH', path: `repos/${REPO}/git/refs/heads/split`, body: { sha: r.head, force: true } }]);
      expect(f.onRemote('rev-parse', 'split^')).toBe(f.base);
    });

    // kanon#1385, the Owner's answer to its plan: a run lasts long enough for the default branch to
    // move under it, so replace mode builds over the commit the run checked out, when it is given one
    // GitHub still has on the default branch.
    it('[LANE-10] replace mode with a head builds over that commit while it is on the default branch, though the default branch moved', async () => {
      const f = fixture();
      f.commit('dead', () => f.w('a.txt', 'dead\n'));
      f.sh(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/split');
      f.sh(f.work, 'reset', '-q', '--hard', f.base);
      f.commit('fresh', () => f.w('a.txt', 'fresh\n'));
      const tip = f.sh(f.work, 'rev-parse', 'HEAD');
      // The default branch moves on after the run checked out.
      f.sh(f.work, 'commit', '-q', '--allow-empty', '-m', 'main moves on');
      f.sh(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
      const r = await f.push({ branch: 'split', replace: true, head: f.base, tip });
      expect(r).toMatchObject({ base: f.base, move: 'forced' });
      expect(f.calls.filter((c) => c.path.startsWith(`repos/${REPO}/compare/`)).map((c) => c.path)).toEqual([`repos/${REPO}/compare/${f.base}...main`]);
      expect(refMoves(f.calls)).toEqual([{ method: 'PATCH', path: `repos/${REPO}/git/refs/heads/split`, body: { sha: r.head, force: true } }]);
      expect(f.onRemote('rev-parse', 'split^')).toBe(f.base);
    });

    it('[LANE-10] replace mode refuses a head that is not on the default branch, before it creates anything', async () => {
      const f = fixture();
      const elsewhere = f.commit('on another branch', () => f.w('a.txt', 'elsewhere\n'));
      f.sh(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/other');
      f.commit('fresh', () => f.w('a.txt', 'fresh\n'));
      await expect(f.push({ branch: 'split', replace: true, head: elsewhere })).rejects.toThrow(/is not on main \(GitHub compares it as behind\)/);
      expect(f.writes()).toEqual([]);
    });

    it('[LANE-10] never replaces the default branch', async () => {
      const f = fixture();
      f.commit('one', () => f.w('a.txt', 'one\n'));
      await expect(f.push({ branch: 'main', replace: true })).rejects.toThrow(/never moves the default branch/);
      expect(f.writes()).toEqual([]);
    });

    // kanon#1392: the double reads a path as GitHub's server does, so a name sent unencoded is
    // cut at a `#` or decoded at a `%`, and names another branch.
    describe('[LANE-10] reads and moves exactly the branch it was named, whatever characters git allows', () => {
      it("[LANE-10] replace mode never force-moves the default branch for a name that starts with the default's and a '#'", async () => {
        const f = fixture();
        f.commit('one', () => f.w('a.txt', 'one\n'));
        const r = await f.push({ branch: 'main#x', replace: true });
        expect(r.move).toBe('created');
        expect(f.onRemote('rev-parse', 'refs/heads/main#x')).toBe(r.head);
        expect(f.onRemote('rev-parse', 'main')).toBe(f.base);
        expect(f.calls.some((c) => (c.body as { force?: boolean } | undefined)?.force === true)).toBe(false);
        expect(f.calls.filter((c) => c.path.includes('/heads/')).map((c) => `${c.method} ${c.path}`)).toEqual([
          `GET repos/${REPO}/git/ref/heads/main`, `GET repos/${REPO}/git/ref/heads/main%23x`, `GET repos/${REPO}/git/ref/heads/main%23x`,
        ]);
      });

      it("[LANE-10] reads and fast-forwards the '#' branch, never the branch its name starts with", async () => {
        const f = fixture();
        f.sh(f.work, 'push', '-q', 'origin', `${f.base}:refs/heads/feat/x#y`);
        // `feat/x` is elsewhere: read in place of `feat/x#y`, it would refuse the push.
        const elsewhere = f.commit('elsewhere', () => f.w('a.txt', 'elsewhere\n'));
        f.sh(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/x');
        f.sh(f.work, 'reset', '-q', '--hard', f.base);
        f.commit('one', () => f.w('a.txt', 'one\n'));
        const r = await f.push({ branch: 'feat/x#y' });
        expect(r.move).toBe('moved');
        expect(refMoves(f.calls)).toEqual([{ method: 'PATCH', path: `repos/${REPO}/git/refs/heads/feat/x%23y`, body: { sha: r.head, force: false } }]);
        expect(f.onRemote('rev-parse', 'refs/heads/feat/x#y')).toBe(r.head);
        expect(f.onRemote('rev-parse', 'feat/x')).toBe(elsewhere);
      });

      it("[LANE-10] creates the '#' branch when only the branch its name starts with exists", async () => {
        const f = fixture();
        f.sh(f.work, 'push', '-q', 'origin', `${f.base}:refs/heads/feat/x`);
        f.commit('one', () => f.w('a.txt', 'one\n'));
        const r = await f.push({ branch: 'feat/x#y' });
        expect(r.move).toBe('created');
        expect(refMoves(f.calls)).toEqual([{ method: 'POST', path: `repos/${REPO}/git/refs`, body: { ref: 'refs/heads/feat/x#y', sha: r.head } }]);
        expect(f.onRemote('rev-parse', 'feat/x')).toBe(f.base);
      });

      it("[LANE-10] sends a '%' in the name as itself, never as the character it would decode to", async () => {
        const f = fixture();
        // `a%62` decodes to `ab`, which is elsewhere.
        const elsewhere = f.commit('elsewhere', () => f.w('a.txt', 'elsewhere\n'));
        f.sh(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/ab');
        f.sh(f.work, 'reset', '-q', '--hard', f.base);
        f.commit('one', () => f.w('a.txt', 'one\n'));
        const r = await f.push({ branch: 'a%62' });
        expect(r.move).toBe('created');
        expect(f.onRemote('rev-parse', 'refs/heads/a%62')).toBe(r.head);
        expect(f.onRemote('rev-parse', 'ab')).toBe(elsewhere);
      });

      it("[LANE-10] in replace mode builds over the default branch's head when its name has a '#'", async () => {
        const f = fixture({ defaultBranch: 'dev#2' });
        f.sh(f.work, 'push', '-q', 'origin', `${f.base}:refs/heads/dev#2`);
        // `dev` is elsewhere: read in place of `dev#2`, the tip would not be built on it.
        f.commit('elsewhere', () => f.w('a.txt', 'elsewhere\n'));
        f.sh(f.work, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
        f.sh(f.work, 'reset', '-q', '--hard', f.base);
        f.commit('fresh', () => f.w('a.txt', 'fresh\n'));
        const r = await f.push({ branch: 'split', replace: true });
        expect(r).toMatchObject({ base: f.base, move: 'created' });
        expect(f.calls.some((c) => c.path === `repos/${REPO}/git/ref/heads/dev%232`)).toBe(true);
      });

      it.each(['HEAD', '-x', 'a..b', 'a?b', 'a b', 'a~1', 'a^', 'a:b', '@{-1}', 'x.lock', 'a//b', '/a', 'a/', 'a\\b'])(
        '[LANE-10] refuses %j, which is not a valid branch name, before it sends any request',
        async (branch) => {
          const calls: string[] = [];
          const request = async (method: string, path: string): Promise<Answer> => { calls.push(`${method} ${path}`); return { status: 500, headers: {}, json: null }; };
          const opts = { gitDir: join(tmpdir(), 'no-such-store'), tip: 'HEAD', branch, appLogin: APP, repo: REPO, request };
          await expect(pushVerified({ ...opts, head: 'a'.repeat(40) })).rejects.toThrow(`--branch ${JSON.stringify(branch)} is not a valid branch name`);
          await expect(pushVerified({ ...opts, replace: true })).rejects.toThrow(`--branch ${JSON.stringify(branch)} is not a valid branch name`);
          expect(calls).toEqual([]);
        },
      );

      it("[LANE-10] refuses '@{-1}' inside a repository too, where git expands it to the branch checked out before", () => {
        const f = fixture();
        f.sh(f.work, 'checkout', '-q', '-b', 'earlier');
        f.sh(f.work, 'checkout', '-q', 'main');
        // git accepts it there, as the name of another branch.
        expect(f.sh(f.work, 'check-ref-format', '--branch', '@{-1}')).toBe('earlier');
        expect(validBranch('@{-1}', f.work)).toBe(false);
        expect(validBranch('earlier', f.work)).toBe(true);
      });
    });

    it('[LANE-10] the command line writes the new head, its base and the commits it created', SPAWNS, async () => {
      const f = fixture();
      const one = f.commit('one', () => f.w('a.txt', 'one\n'));
      const dir = join(f.root, 'served');
      mkdirSync(dir);
      const fake = await serveFake({ remote: f.remote, repo: REPO, appLogin: APP, dir });
      try {
        writeFileSync(join(f.root, 'out'), '');
        writeFileSync(join(f.root, 'summary'), '');
        const r = await fake.run(process.execPath, [
          'scripts/lib/verified-commits.mjs', '--git-dir', join(f.work, '.git'), '--tip', 'HEAD', '--branch', 'feature', '--head', f.base, '--app-login', APP,
        ], { GH_TOKEN: 'x', REPO, GITHUB_API_URL: fake.url, GITHUB_OUTPUT: join(f.root, 'out'), GITHUB_STEP_SUMMARY: join(f.root, 'summary') });
        expect(r.status, r.output).toBe(0);
        const head = f.onRemote('rev-parse', 'feature');
        expect(readFileSync(join(f.root, 'out'), 'utf8')).toBe(`head=${head}\nbase=${f.base}\ncreated=${head}\n`);
        expect(readFileSync(join(f.root, 'summary'), 'utf8')).toContain(`| \`${one.slice(0, 7)}\` | \`${head.slice(0, 7)}\` |`);
        expect(fake.calls().every((c: { auth: string }) => c.auth === 'Bearer x')).toBe(true);
      } finally {
        fake.stop();
      }
    });
  });

  describe('[LANE-11] uploads, pacing and the rate-limit bound', () => {
    it("[LANE-11] uploads no blob already in a parent's tree, nor one twice", async () => {
      const f = fixture();
      f.commit('one', () => {
        f.w('a.txt', 'brand new\n');
        f.w('copy-of-b.txt', 'b\n');
      });
      f.commit('two', () => f.w('again.txt', 'brand new\n'));
      await f.push();
      const sent = posts(f.calls, 'git/blobs').map((c) => Buffer.from(String(c.body!.content), 'base64').toString());
      expect(sent).toEqual(['brand new\n']);
    });

    it('[LANE-11] paces the requests that create objects', async () => {
      const f = fixture();
      f.commit('one', () => { f.w('a.txt', 'one\n'); f.w('c.txt', 'c\n'); });
      f.commit('two', () => f.w('a.txt', 'two\n'));
      await f.push();
      const times = f.calls.map((c, i) => ({ c, t: f.at[i]! })).filter(({ c }) => c.method !== 'GET').map(({ t }) => t);
      expect(times.length).toBeGreaterThan(4);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PACE_MS);
    });

    const limitedFor = (n: number, answer: Answer) => (c: Call, calls: Call[]) =>
      (c.method === 'POST' && c.path.endsWith('/git/blobs') && calls.filter((x) => x.path === c.path).length <= n ? answer : undefined);
    const secondary = (headers: Record<string, string> = {}): Answer => ({ status: 403, headers, json: { message: 'You have exceeded a secondary rate limit.' } });

    it('[LANE-11] waits the time a secondary rate limit names, and retries', async () => {
      const f = fixture({ before: limitedFor(2, secondary({ 'retry-after': '7' })) });
      f.commit('one', () => f.w('a.txt', 'one\n'));
      const r = await f.push();
      expect(r.move).toBe('created');
      expect(f.slept.filter((ms) => ms === 7000)).toHaveLength(2);
    });

    it('[LANE-11] waits a minute on a secondary rate limit that names no time', async () => {
      const f = fixture({ before: limitedFor(1, { status: 429, headers: {}, json: { message: 'You have exceeded a secondary rate limit.' } }) });
      f.commit('one', () => f.w('a.txt', 'one\n'));
      await f.push();
      expect(f.slept).toContain(UNNAMED_WAIT_MS);
    });

    it('[LANE-11] fails within the bound and moves no branch', async () => {
      const f = fixture({ before: limitedFor(Infinity, secondary({ 'retry-after': '1' })) });
      f.commit('one', () => f.w('a.txt', 'one\n'));
      await expect(f.push()).rejects.toThrow(`still rate-limited after ${RETRIES} retries, so no branch moved`);
      expect(posts(f.calls, 'git/blobs')).toHaveLength(RETRIES + 1);
      expect(refMoves(f.calls)).toEqual([]);
    });

    it('[LANE-11] fails at once on a wait longer than its bound', async () => {
      const f = fixture({ before: limitedFor(Infinity, secondary({ 'retry-after': String(MAX_WAIT_MS / 1000 + 1) })) });
      f.commit('one', () => f.w('a.txt', 'one\n'));
      await expect(f.push()).rejects.toThrow(/longer than the 120s this helper waits, so no branch moved/);
      expect(f.slept.some((ms) => ms > MAX_WAIT_MS)).toBe(false);
      expect(refMoves(f.calls)).toEqual([]);
    });
  });
});
