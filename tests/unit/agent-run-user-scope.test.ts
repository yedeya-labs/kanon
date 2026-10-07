import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { claudeArgWords, loadsNoProjectSettings, settingSources } from '../../scripts/lib/claude-args.mjs';
import { SPAWNS } from './helpers/spawns.js';

/**
 * kanon#283 — a lane whose flags load no project settings gets a user scope its own job made.
 *
 * `--setting-sources user` (kanon#277) keeps the project's Claude Code settings out of the
 * Reviewer's and the Lead's runs, so their flags are their whole grant. The user scope still
 * loads, and claude-code-action keeps whatever `$HOME/.claude/settings.json` it finds. On a
 * persistent self-hosted runner that file, and `$HOME/.claude.json`, can hold what an earlier
 * job left: measured on CLI 2.1.289, a leftover `SessionStart` and `UserPromptSubmit` hook both
 * fired, a leftover user MCP server was spawned and a leftover `CLAUDE.md` was read under
 * `--setting-sources user`; with `CLAUDE_CONFIG_DIR` at a new directory, none of them was. And an
 * EMPTY `CLAUDE_CONFIG_DIR` made the CLI read the user scope from the working directory, the
 * checkout, so the value must only ever be set when it is a real path.
 *
 * `agent-run` reads the flags the way the action does and, for such a lane, writes a new
 * directory under the runner's temp directory to `$GITHUB_ENV` before the action step.
 */

describe('reading the setting sources the way claude-code-action does', () => {
  it('splits shell words, drops full-line comments and resolves quotes', () => {
    expect(claudeArgWords(`--model x\n  # --setting-sources user\n--allowedTools "Bash(gh pr view:*)" 'Edit(/t/a b.md)' a\\ b`))
      .toEqual(['--model', 'x', '--allowedTools', 'Bash(gh pr view:*)', 'Edit(/t/a b.md)', 'a b']);
  });

  it.each([
    ['no flag: the action loads every source', '--model x --max-turns 3', ['user', 'project', 'local']],
    ['the space form', '--model x\n--setting-sources user', ['user']],
    ['a quoted value', '--setting-sources "user"', ['user']],
    ['several sources', '--setting-sources user,local', ['user', 'local']],
    ['the `=` form is not read, so the default stands', '--setting-sources=user', ['user', 'project', 'local']],
    ['a later occurrence overwrites an earlier one', '--setting-sources user\n--setting-sources user,project', ['user', 'project']],
    ['a flag with no value is no value', '--setting-sources\n--model x', ['user', 'project', 'local']],
    ['a commented-out flag is not there', '# --setting-sources user\n--model x', ['user', 'project', 'local']],
    ['after an accumulating flag', '--allowedTools Read "Bash(gh api:*)"\n--setting-sources user', ['user']],
    ['not taken as an accumulated value', '--allowedTools Read --setting-sources user', ['user']],
  ])('%s', (_name, args, expected) => {
    expect(settingSources(args)).toEqual(expected);
  });

  it('isolates only when the project is not among the sources', () => {
    expect(loadsNoProjectSettings('--setting-sources user')).toBe(true);
    expect(loadsNoProjectSettings('--setting-sources user,local')).toBe(true);
    expect(loadsNoProjectSettings('--model x')).toBe(false);
    expect(loadsNoProjectSettings('--setting-sources user,project')).toBe(false);
  });
});

/** Every `claude_args` value in Kanon's workflows: the agent steps, the lane calls, agent-finish. */
const laneFlags = (): { where: string; args: string }[] => {
  const out: { where: string; args: string }[] = [];
  const walk = (file: string, node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(file, n, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'claude_args' && typeof v === 'string') out.push({ where: `${file}#${path}`, args: v });
        else walk(file, v, `${path}.${k}`);
      }
    }
  };
  for (const f of readdirSync('.github/workflows').filter((x) => x.endsWith('.yml'))) {
    walk(f, parse(readFileSync(join('.github/workflows', f), 'utf8')), '');
  }
  return out;
};

describe("which of Kanon's lanes get a user scope of their own", () => {
  const flags = laneFlags();
  const isolated = [...new Set(flags.filter((f) => loadsNoProjectSettings(f.args)).map((f) => f.where.split('#')[0]))].sort();

  it('every lane that passes `--setting-sources user`, and only those', () => {
    // Read independently of the library: the tests of kanon#277 and kanon#243 pin the flag on
    // these lanes, and the library must agree with them.
    const passesUser = (args: string) => /^\s*--setting-sources user\s*$/m.test(args);
    for (const f of flags) expect(loadsNoProjectSettings(f.args), f.where).toBe(passesUser(f.args));
    expect(isolated).toEqual(['agent-lead-revise.yml', 'agent-lead.yml', 'review-agent-job.yml']);
  });

  it('leaves the lanes that load their project settings alone, so the check is not vacuous', () => {
    expect(flags.filter((f) => !loadsNoProjectSettings(f.args)).length).toBeGreaterThan(5);
  });
});

// Its cases run the script in `bash`, so the block takes the spawn budget (#436).
describe('the user-scope script', SPAWNS, () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const runScript = (args: string, temp?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'user-scope-'));
    dirs.push(dir);
    const env = join(dir, 'env');
    writeFileSync(env, '');
    const runnerTemp = temp ?? join(dir, 'temp');
    if (temp === undefined) spawnSync('mkdir', ['-p', runnerTemp]);
    const r = spawnSync(process.execPath, ['actions/agent-run/user-scope.mjs'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_ARGS: args, RUNNER_TEMP: runnerTemp, GITHUB_ENV: env },
    });
    return { status: r.status, out: r.stdout + r.stderr, env: readFileSync(env, 'utf8'), runnerTemp };
  };

  it("points CLAUDE_CONFIG_DIR at a new, empty directory under the runner's temp directory", () => {
    const review = String(flagsOf('review-agent-job.yml'));
    const r = runScript(review);
    expect(r.status, r.out).toBe(0);
    const m = /^CLAUDE_CONFIG_DIR=(.+)\n$/.exec(r.env);
    expect(m, r.env).not.toBeNull();
    const dir = m![1]!;
    expect(dir.startsWith(`${r.runnerTemp}/claude-user-`)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a new directory each run, never one an earlier job on the same runner could have filled', () => {
    const temp = mkdtempSync(join(tmpdir(), 'user-scope-runner-'));
    dirs.push(temp);
    const first = runScript('--setting-sources user', temp);
    const dir = /^CLAUDE_CONFIG_DIR=(.+)\n$/.exec(first.env)![1]!;
    writeFileSync(join(dir, 'settings.json'), '{"hooks":{}}'); // what an earlier job leaves
    const second = runScript('--setting-sources user', temp);
    expect(second.status, second.out).toBe(0);
    const again = /^CLAUDE_CONFIG_DIR=(.+)\n$/.exec(second.env)![1]!;
    expect(again).not.toBe(dir);
    expect(readdirSync(again)).toEqual([]);
  });

  it('leaves a lane that loads its project settings exactly as it was', () => {
    const r = runScript('--model x --max-turns 3');
    expect(r.status, r.out).toBe(0);
    expect(r.env).toBe('');
  });

  it.each([
    ['empty', ''],
    ['relative', 'temp'],
    ['on two lines', '/tmp/a\nCLAUDE_CONFIG_DIR=/x'],
  ])("fails, and writes nothing, when the runner's temp directory is %s", (_name, temp) => {
    const r = runScript('--setting-sources user', temp);
    expect(r.status).not.toBe(0);
    expect(r.env).toBe('');
    expect(r.out).toMatch(/::error title=user-scope::/);
  });
});

/** The agent step's flags in a workflow, the first `claude_args` found. */
const flagsOf = (file: string) => laneFlags().find((f) => f.where.startsWith(`${file}#`))!.args;

describe('agent-run runs the script before the agent, and can never hand it a blank value', () => {
  type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown>; 'continue-on-error'?: unknown };
  const steps = (parse(readFileSync('actions/agent-run/action.yml', 'utf8')) as { runs: { steps: Step[] } }).runs.steps;
  const scope = steps.findIndex((s) => /user-scope\.mjs/.test(String(s.run ?? '')));
  const action = steps.findIndex((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'));

  it('runs it unconditionally, before the action, on the flags the action gets', () => {
    expect(scope, 'the step exists').toBeGreaterThanOrEqual(0);
    expect(scope).toBeLessThan(action);
    const step = steps[scope]!;
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.env?.CLAUDE_ARGS).toBe('${{ inputs.claude_args }}');
    expect(existsSync('actions/agent-run/user-scope.mjs')).toBe(true);
  });

  it('sets CLAUDE_CONFIG_DIR on no step, where an empty value would make the checkout the user scope', () => {
    for (const s of steps) expect(Object.keys(s.env ?? {}), s.name ?? s.uses).not.toContain('CLAUDE_CONFIG_DIR');
  });
});
