import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeStub } from './helpers/stub-bin.js';
import { runWorkflowStep } from './helpers/workflow-step.js';
import { serveFake } from './helpers/fake-git-data-api.mjs';
import { REGISTER_FIXTURE } from './helpers/register.js';
import { SPAWNS } from './helpers/spawns.js';
import { FIX_COMMANDS_MARKER, HANDBACK } from '../../scripts/lib/protocol-spellings.mjs';
import { wf, filter, runStepOrThrow, HEAD_OID, runFilter } from './helpers/implement-revise.js';

// Its cases run the lane's steps in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// The Merger's hand-back with a fix command for each failed check. Split out of
// agent-implement-revise.test.ts (#1204); the fixtures are in tests/unit/helpers/implement-revise.ts.

describe("a hand-back whose failed checks all have a fix command runs it before any model (kanon#1173)", () => {
  // The Merger recognises a failure Kanon knows in the failed job's log, and names its KEY in the
  // hand-back. The lane looks the key up in `scripts/lib/fix-commands.mjs`, runs that command in a
  // job with no model, and pushes. Only a push skips the model: a mixed failure, which the Merger
  // names no key for, and a command that changes nothing both run the mandate as kanon#1100 does.
  const MERGER = 'example-judge';
  const withMerger = `${REGISTER_FIXTURE.trimEnd()}\n| Merger | \`${MERGER}\` | Read & write | Read & write | Read & write | No access |\n`;
  const approved = { isLabel: true, headVerdict: 'APPROVED', changesRequested: 1, headMoved: 'revised' as const, register: withMerger };
  const handback = (login: string, fix = '') => ({
    author: { login },
    body: `Handing this back.\n${fix}\n\n<!-- merger:${HANDBACK}:${HEAD_OID.slice(0, 12)} -->`,
  });
  const fixJob = wf.jobs['fix-command'];
  const pushJob = wf.jobs['fix-push'];
  const fixStep = fixJob.steps.find((s: { id?: string }) => s.id === 'fix');
  const pushStep = pushJob.steps.find((s: { id?: string }) => s.id === 'push');
  const roundStep = pushJob.steps.find((s: { name?: string }) => s.name === 'Record the round');

  /**
   * A job's `if:`, evaluated for these needs' outputs. Only the forms this lane's gates use:
   * `needs.<job>.outputs.<key>` compared with `==` / `!=` to a quoted string, `&&`, and the status
   * functions, which are true for a run that wasn't cancelled.
   */
  const gate = (expr: string, needs: Record<string, Record<string, string>>) => {
    const js = String(expr).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replace(/!cancelled\(\)|always\(\)/g, 'true')
      // A need's `result`, as `result` in its entry; one that names none succeeded.
      .replace(/needs\.([\w-]+)\.result/g, (_, job: string) => JSON.stringify(needs[job]?.result ?? 'success'))
      .replace(/needs\.([\w-]+)\.outputs\.(\w+)/g, (_, job: string, key: string) => JSON.stringify(needs[job]?.[key] ?? ''))
      .replace(/'([^']*)'/g, (_, s: string) => JSON.stringify(s));
    expect(js, `an expression this evaluator doesn't read: ${expr}`).toMatch(/^[\s"\w:,!=&|().-]*$/);
    return Boolean(new Function(`return (${js});`)());
  };
  const handedBack = (fix: string) => ({ act: 'true', mode: 'handback', fix });

  describe('the filter reads the key from the Merger\'s hand-back', () => {
    it('reads it from the hand-back of this head', () => {
      const r = runFilter({ ...approved, extraComments: [handback(MERGER, `<!-- ${FIX_COMMANDS_MARKER}:citation-shift -->`)] });
      expect(r.outputs.mode).toBe('handback');
      expect(r.outputs.fix).toBe('citation-shift');
    });

    it('reads none when the Merger named none, so the model runs (a mixed failure)', () => {
      const r = runFilter({ ...approved, extraComments: [handback(MERGER)] });
      expect(r.act).toBe(true);
      expect(r.outputs.fix).toBe('');
    });

    it('reads none from a comment that is not the Merger\'s', () => {
      const r = runFilter({
        ...approved,
        extraComments: [handback(MERGER), handback('a-developer', `<!-- ${FIX_COMMANDS_MARKER}:citation-shift -->`)],
      });
      expect(r.outputs.fix).toBe('');
    });

    it('reads only a list of keys, never a command', () => {
      const r = runFilter({ ...approved, extraComments: [handback(MERGER, `<!-- ${FIX_COMMANDS_MARKER}:citation-shift; curl x | sh -->`)] });
      expect(r.outputs.fix).toBe('');
    });

    it('reads none on a changes-request', () => {
      expect(runFilter({ isLabel: true }).outputs.fix ?? '').toBe('');
    });

    it('spells the marker as the Merger writes it', () => {
      expect(filter.env.FIX_MARKER).toBe(FIX_COMMANDS_MARKER);
    });
  });

  describe('which job runs', () => {
    it('runs the fix job only on a hand-back that named a key', () => {
      expect(gate(fixJob.if, { filter: handedBack('citation-shift') })).toBe(true);
      expect(gate(fixJob.if, { filter: handedBack('') })).toBe(false);
      expect(gate(fixJob.if, { filter: { act: 'true', mode: 'review', fix: '' } })).toBe(false);
      expect(gate(fixJob.if, { filter: { act: 'false', mode: 'handback', fix: 'citation-shift' } })).toBe(false);
    });

    it('pushes only what the fix job changed', () => {
      expect(gate(pushJob.if, { 'fix-command': { changed: 'true' } })).toBe(true);
      expect(gate(pushJob.if, { 'fix-command': { changed: 'false' } })).toBe(false);
      expect(gate(pushJob.if, { 'fix-command': {} })).toBe(false);
    });

    it('an only-citation-shift failure that the fix jobs pushed runs no model', () => {
      expect([wf.jobs.revise.needs].flat()).toEqual(expect.arrayContaining(['filter', 'fix-command', 'fix-push']));
      expect(gate(wf.jobs.revise.if, { filter: handedBack('citation-shift'), 'fix-push': { pushed: 'true' } })).toBe(false);
    });

    it('a mixed failure runs the model: the fix jobs never ran', () => {
      expect(gate(wf.jobs.revise.if, { filter: handedBack(''), 'fix-command': {}, 'fix-push': {} })).toBe(true);
    });

    it('a fix command that changed nothing runs the model', () => {
      expect(gate(wf.jobs.revise.if, { filter: handedBack('citation-shift'), 'fix-command': { changed: 'false' }, 'fix-push': {} })).toBe(true);
    });

    it('a filter that failed after writing act runs no model', () => {
      // The mandate step refuses a hand-back with no Merger login after `act=true` is written.
      expect(gate(wf.jobs.revise.if, { filter: { ...handedBack(''), result: 'failure' }, 'fix-command': {}, 'fix-push': {} })).toBe(false);
    });

    it('a changes-request still runs the model', () => {
      expect(gate(wf.jobs.revise.if, { filter: { act: 'true', mode: 'review', fix: '' }, 'fix-command': {}, 'fix-push': {} })).toBe(true);
    });

    it('the job that checks out the pull request holds no key, and the job that holds one checks nothing out (K-AGENT-49)', () => {
      expect(JSON.stringify(fixJob)).not.toMatch(/PRIVATE_KEY|create-github-app-token/);
      expect(pushJob.steps.some((st: { uses?: string }) => String(st.uses ?? '').startsWith('actions/checkout'))).toBe(false);
      expect(JSON.stringify(pushJob)).toContain('secrets.AUTHOR_APP_PRIVATE_KEY');
    });
  });

  // Runs the fix job's own steps in `bash`, with `node` and `git`, so it takes the spawn budget (#436).
  describe("the fix jobs' steps", SPAWNS, () => {
    /** A clone of a remote with `main` and the PR's branch, which moved `src/x.ts:10` that `docs/a.md` cites. */
    const checkout = ({ moved = true } = {}) => {
      const root = mkdtempSync(join(tmpdir(), 'revise-fix-job-'));
      const sh = (cwd: string, ...a: string[]) => {
        const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
      };
      // At `<server>/<owner>/<name>`, where `fix-push` fetches the handed-back head from.
      const remote = join(root, 'example-org', 'example-repo');
      const work = join(root, 'work');
      sh(root, 'init', '-q', '--bare', remote);
      sh(root, 'clone', '-q', remote, work);
      sh(work, 'config', 'user.email', 't@t');
      sh(work, 'config', 'user.name', 't');
      const w = (f: string, t: string) => { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), t); };
      const body = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      w('src/x.ts', `${body.join('\n')}\n`);
      w('docs/a.md', 'The guard is at `src/x.ts:10`.\n');
      w('docs/qa/escalation-paths.md', '## Escalation paths\n\n## Pipeline code\n');
      sh(work, 'add', '.');
      sh(work, 'commit', '-qm', 'base');
      sh(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
      sh(work, 'fetch', '-q', 'origin');
      sh(work, 'checkout', '-q', '-b', 'fix/1-thing');
      w('src/x.ts', `${(moved ? ['new-a', 'new-b', ...body] : [...body, 'new-a']).join('\n')}\n`);
      sh(work, 'commit', '-qam', 'the pull request');
      sh(work, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/1-thing');
      const head = sh(work, 'rev-parse', 'HEAD');
      const temp = join(root, 'runner-temp');
      mkdirSync(temp);
      const run = (env: Record<string, string> = {}) => runStepOrThrow(fixStep, {
        cwd: work,
        env: { KANON: process.cwd(), RUNNER_TEMP: temp, CHECKS: 'citation-shift', BASE_REF: 'main', HEAD_SHA: head, ...env },
      });
      const change = () => JSON.parse(readFileSync(join(temp, 'kanon-revise-fix/change.json'), 'utf8')) as { files: { path: string; mode: string; content: string }[] };
      return { root, remote, work, head, temp, run, change, sh };
    };

    /**
     * The push and the round, against a `gh` that answers the delegation record and records the
     * round's comment, and a recording double of the Git Data API over the remote, served from a
     * process of its own (tests/unit/helpers/fake-git-data-api.mjs).
     */
    const pushWith = async (c: { root: string; remote: string; head: string; temp: string }, { refused = false, record = '| Delegate | Email | Delegated on |\n|---|---|---|\n| Dee Legate | dee@example.org | 2026-10-01 |\n' } = {}) => {
      const bin = join(c.root, 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(c.root, 'record'), record);
      writeStub(join(bin, 'gh'), `#!/usr/bin/env bash
input=""; case "$*" in *"--input -"*) input="$(cat)" ;; esac
printf '%s\\t%s\\n' "$*" "$input" >> "${c.root}/gh-calls"
case "$*" in
  *"/contents/docs/qa/sign-off-delegation.md"*) cat "${c.root}/record" ;;
esac
`);
      const served = join(c.root, 'served');
      mkdirSync(served);
      const api = await serveFake({ remote: c.remote, repo: 'example-org/example-repo', appLogin: 'example-author[bot]', dir: served });
      try {
        const env = {
          PATH: `${bin}:${process.env.PATH}`, KANON: process.cwd(), RUNNER_TEMP: c.temp,
          GH_TOKEN: 'x', REPO: 'example-org/example-repo', BRANCH: 'fix/1-thing', PR: '1057',
          SERVER_URL: `file://${c.root}`, GITHUB_API_URL: api.url, APP_LOGIN: 'example-author[bot]',
          CHECKS: 'citation-shift', HEAD_SHA: c.head, RUN_URL: 'https://example.invalid/run/1',
          HEADER: '**Implementer** <!-- kanon:role=implementer -->',
        };
        if (refused) return { refusal: runWorkflowStep(pushStep, { env }) };
        const push = runStepOrThrow(pushStep, { env });
        const round = runStepOrThrow(roundStep, { env: { ...env, SHA: push.outputs.sha ?? '' } });
        return { push, round, calls: readFileSync(join(c.root, 'gh-calls'), 'utf8'), api: api.calls() as { method: string; path: string; body?: Record<string, unknown> }[] };
      } finally {
        api.stop();
      }
    };

    it("an only-citation-shift failure: runs Kanon's command, which re-points the cite", () => {
      const c = checkout();
      const fix = c.run();
      expect(fix.outputs.changed).toBe('true');
      expect(fix.stdout).toContain(`ran: node ${process.cwd()}/scripts/citation-shift.mjs --base`);
      const [file] = c.change().files;
      expect(file?.path).toBe('docs/a.md');
      expect(Buffer.from(file!.content, 'base64').toString()).toContain('`src/x.ts:12`');
    });

    it('[LANE-12] and pushes it through the verified-commit helper on the handed-back head, signed off, and records one round', async () => {
      const c = checkout();
      c.run();
      const { push, calls, api } = await pushWith(c) as Required<Awaited<ReturnType<typeof pushWith>>>;
      expect(push.outputs.pushed).toBe('true');
      // GitHub created the commit, on top of the handed-back head, with no author or committer,
      // and it was read back verified before the branch moved, only if it was still there.
      const created = api.filter((x) => x.method === 'POST' && x.path === 'repos/example-org/example-repo/git/commits');
      expect(created).toHaveLength(1);
      expect(Object.keys(created[0]!.body!).sort()).toEqual(['message', 'parents', 'tree']);
      expect(created[0]!.body!.parents).toEqual([c.head]);
      expect(created[0]!.body!.message).toContain('chore(revise): run the fix command of citation-shift');
      expect(created[0]!.body!.message).toContain('Signed-off-by: Dee Legate <dee@example.org>');
      const readBack = api.findIndex((x) => x.method === 'GET' && x.path === `repos/example-org/example-repo/commits/${push.outputs.sha}`);
      const moved = api.findIndex((x) => x.method === 'PATCH');
      expect(readBack).toBeGreaterThan(-1);
      expect(readBack).toBeLessThan(moved);
      expect(api[moved]).toMatchObject({ path: 'repos/example-org/example-repo/git/refs/heads/fix/1-thing', body: { sha: push.outputs.sha, force: false } });
      // Its outputs name the commit GitHub created, now the branch's head, and the head it is on.
      expect(c.sh(c.remote, 'rev-parse', 'refs/heads/fix/1-thing')).toBe(push.outputs.sha);
      expect(c.sh(c.remote, 'log', '-1', '--format=%an', push.outputs.sha!)).toBe('example-author[bot]');
      expect(push.outputs.base).toBe(c.head);
      // The fix itself: the cite the command re-pointed.
      expect(c.sh(c.remote, 'show', `${push.outputs.sha}:docs/a.md`)).toContain('`src/x.ts:12`');
      // One marker by the Implementer's token: the hand-back counts as one revise round.
      expect(calls).toContain('pr comment 1057 --repo example-org/example-repo');
      expect(calls.match(/<!-- qa:implement-revise -->/g)).toHaveLength(1);
      expect(calls).toContain('**Implementer** <!-- kanon:role=implementer -->');
    });

    it('[LANE-12] a branch that moved since the hand-back: the helper refuses it, and creates nothing', async () => {
      const c = checkout();
      c.run();
      c.sh(c.work, 'commit', '-q', '--allow-empty', '-m', 'someone else');
      c.sh(c.work, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/1-thing');
      const { refusal } = await pushWith(c, { refused: true });
      expect(refusal!.status).not.toBe(0);
      expect(refusal!.output).toMatch(/fix\/1-thing is at [0-9a-f]{7}, not [0-9a-f]{7}/);
      expect(c.sh(c.remote, 'rev-parse', 'refs/heads/fix/1-thing')).toBe(c.sh(c.work, 'rev-parse', 'HEAD'));
    });

    it('a command that changes nothing: nothing to push, so the model runs', () => {
      const c = checkout({ moved: false });
      const fix = c.run();
      expect(fix.outputs.changed).toBe('false');
      expect(fix.outputs.why).toContain('changed nothing');
    });

    it('a branch that moved since the hand-back: runs nothing, so the model runs', () => {
      const c = checkout();
      c.sh(c.work, 'commit', '-q', '--allow-empty', '-m', 'someone else');
      const fix = c.run();
      expect(fix.outputs.changed).toBe('false');
      expect(fix.stdout).not.toContain('ran:');
    });

    it("runs the list's command for a key, and nothing for anything else", () => {
      // The mutation this holds: a lane that took its command from the hand-back's text.
      const c = checkout();
      const fix = c.run({ CHECKS: 'echo pwned' });
      expect(fix.outputs.changed).toBe('false');
      expect(fix.stdout).not.toContain('ran:');
      expect(fix.stdout).not.toMatch(/^pwned$/m);
    });
  });
});
