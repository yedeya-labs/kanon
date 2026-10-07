import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * kanon#243 (the Owner's decision of 2026-10-05, `K-AGENT-50`): the Lead runs none of the tree's
 * code, the way the Reviewer was closed by kanon#185 and kanon#248. Its lanes turn the spine's
 * project setup off, so no hook or install runs, and its shell is an allow-list:
 *   • it writes only under `docs/` (a brief, a spec clause);
 *   • it runs Kanon's scripts by name (`kanon-brief-guard`, `kanon-spec-ids`, `kanon-spec-coverage`),
 *     which the spine puts on the PATH as wrappers around Kanon's own Node and script;
 *   • it commits and pushes, to `origin` only;
 *   • it calls named `gh` subcommands;
 *   • it loads no project settings (`--setting-sources user`, kanon#277), so no project hook or
 *     MCP server joins the grant.
 * Every other command falls to Claude Code's read-only set. The flags are read the way
 * claude-code-action reads them (the Reviewer's test, kanon#248, explains the parse).
 */
const WF = '.github/workflows';
type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
const read = (f: string) => parse(readFileSync(join(WF, f), 'utf8')) as { jobs: Record<string, { uses?: string; with?: Record<string, unknown>; steps?: Step[] }> };

const LANES = [['agent-lead.yml', 'brief'], ['agent-lead-revise.yml', 'revise']] as const;

const words = (args: string) => [...args.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  .matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
const toolsOf = (kind: 'allowed' | 'disallowed') => (args: string) => {
  const w = words(args);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const eq = new RegExp(`^--${kind}-?[Tt]ools=(.*)$`).exec(w[i]!);
    if (eq) { out.push(eq[1]!); continue; }
    if (!new RegExp(`^--${kind}-?[Tt]ools$`).test(w[i]!)) continue;
    while (i + 1 < w.length && !w[i + 1]!.startsWith('--')) out.push(w[++i]!);
  }
  return out.flatMap((v) => v.split(',')).map((t) => t.trim()).filter(Boolean);
};
const allowedTools = toolsOf('allowed');
const disallowedTools = toolsOf('disallowed');

// THE LIST, pinned. A change to it is a security change the Owner reviews, made here and in
// both lanes together.
const EXPECTED = [
  'Read', 'Grep', 'Glob',
  'Edit(/docs/**)',
  'Bash(kanon-brief-guard:*)', 'Bash(kanon-spec-ids:*)', 'Bash(kanon-spec-coverage:*)',
  'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git add:*)', 'Bash(git commit:*)',
  'Bash(git push origin:*)', 'Bash(git push -u origin:*)', 'Bash(git fetch origin:*)',
  'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr list:*)',
  'Bash(gh pr create:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr edit:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh issue comment:*)', 'Bash(gh label list:*)',
  'Bash(gh run view:*)', 'Bash(gh run list:*)', 'Bash(gh search:*)', 'Bash(gh api:*)',
];

// THE DENY LIST, pinned (kanon#405, the Owner's decision of 2026-10-07). `git push origin:*` and
// `git fetch origin:*` match any option after the remote, and `--receive-pack`, `--exec` and
// `--upload-pack` name a program git runs for the far end: an https `origin` ignores it, a local
// one runs it. So both arms deny them, in each spelling git accepts (an unambiguous prefix:
// `--rece`, `--e`, `--upl`; `=` or a space) and each the shell joins back into one (a quote, a
// backslash, a brace). A rule spells a backslash as four: the CLI halves them when it reads the
// rule, and its matcher reads the two left as one literal backslash (measured on CLI 2.1.289: with
// one or two, a push holding a backslash got through). The CLI refuses a brace on its own; the
// rule is a second layer. `reviewer-grant-probe.mjs` refuses each push spelling and each fetch
// option for real, and these pin the list on both arms.
const DENIED = [
  'Bash(git push *--rece*)', 'Bash(git push *--e*)', 'Bash(git fetch *--upl*)', 'Bash(git fetch *--e*)',
  "Bash(git push *'*)", 'Bash(git push *"*)', String.raw`Bash(git push *\\\\*)`, 'Bash(git push *{*)',
  "Bash(git fetch *'*)", 'Bash(git fetch *"*)', String.raw`Bash(git fetch *\\\\*)`, 'Bash(git fetch *{*)',
];

// Independent of the pinned list: each word runs a program it is handed, or the project's.
const RUNS_CODE = new Set([
  'node', 'bash', 'sh', 'zsh', 'dash', 'fish', 'python', 'python3', 'ruby', 'perl', 'php', 'lua', 'deno', 'bun',
  'tsx', 'ts-node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'make', 'pip', 'pip3', 'poetry', 'uv', 'cargo',
  'go', 'gradle', 'gradlew', 'mvn', 'bundle', 'composer', 'playwright', 'docker', 'vitest', 'jest',
  'env', 'xargs', 'timeout', 'nice', 'nohup', 'exec', 'eval', 'source', '.', 'command', 'builtin', 'watch',
  'find', 'awk', 'sed', 'tee',
]);
const GH_RUNS_CODE = /^gh (alias|extension|ext|codespace|pr checkout|run download|release download|repo clone|attestation|workflow)\b/;
/** The git rules the Lead may hold: none that runs a program or takes a remote other than `origin`. */
const GIT_ALLOWED = new Set(['git checkout', 'git switch', 'git add', 'git commit', 'git push origin', 'git push -u origin', 'git fetch origin']);
/** Kanon's scripts, as the spine names them on the PATH. */
const KANON_SCRIPTS = ['brief-guard', 'spec-ids', 'spec-coverage'];

export const badBashRules = (tools: string[]): string[] => tools.filter((t) => /^Bash\b/.test(t)).filter((t) => {
  const m = /^Bash\((.+?)(?::\*| \*)?\)$/.exec(t);
  if (!m) return true;
  const prefix = m[1]!.trim();
  const first = prefix.split(/\s+/)[0]!;
  if (prefix.includes('*') || /[;&|`$<>()=]/.test(prefix) || RUNS_CODE.has(first)) return true;
  if (first === 'git') return !GIT_ALLOWED.has(prefix);
  if (first === 'gh') return prefix.split(/\s+/).length < 2 || GH_RUNS_CODE.test(prefix);
  if (first.startsWith('kanon-')) return !KANON_SCRIPTS.includes(first.slice('kanon-'.length)) || prefix !== first;
  return true;
});

describe("the Lead's shell is an allow-list that runs no tree code (kanon#243)", () => {
  for (const [file, job] of LANES) {
    const call = read(file).jobs[job]!;
    const ARGS = String(call.with?.claude_args);
    const prompt = String(call.with?.prompt);

    describe(file, () => {
      it('calls the spine with the project setup off', () => {
        expect(call.uses).toBe('$/.github/workflows/agent-lane.yml');
        expect(call.with?.['project-setup']).toBe(false);
      });
      it('grants exactly the pinned list', () => {
        expect([...allowedTools(ARGS)].sort()).toEqual([...EXPECTED].sort());
      });
      it('denies a program for the far end of a push or fetch, in every spelling (kanon#405)', () => {
        expect([...disallowedTools(ARGS)].sort()).toEqual([...DENIED].sort());
        // claude-code-action splits each rule list on commas, so a rule may hold none.
        expect(words(ARGS).filter((x) => /^Bash\(git (push|fetch) /.test(x) && x.includes(','))).toEqual([]);
      });
      it('grants Bash only for named commands that run no program of the tree', () => {
        expect(allowedTools(ARGS).filter((t) => /^Bash\b/.test(t)).length, 'not vacuous').toBeGreaterThan(10);
        expect(badBashRules(allowedTools(ARGS))).toEqual([]);
      });
      it('writes only under docs/, never the rest of the tree or .git', () => {
        const tools = allowedTools(ARGS);
        expect(tools.filter((t) => /^(Write|NotebookEdit|MultiEdit)\b/.test(t) || t === 'Edit')).toEqual([]);
        expect(tools.filter((t) => /^Edit\(/.test(t))).toEqual(['Edit(/docs/**)']);
      });
      it('loads no project settings, once, in the form the action parses, and no flag widens the rules', () => {
        const w = words(ARGS);
        const at = w.flatMap((x, i) => (/^--setting-?sources\b/i.test(x) ? [i] : []));
        expect(at.map((i) => [w[i], w[i + 1]])).toEqual([['--setting-sources', 'user']]);
        expect(w.filter((x) => /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode|settings|add-dir|mcp-config|plugin-dir|strict-mcp-config|agents)\b/.test(x))).toEqual([]);
      });
      it('tells the agent what its shell allows, and names Kanon\'s scripts as it can run them', () => {
        expect(prompt).toContain('YOUR SHELL IS AN ALLOW-LIST (kanon#243)');
        expect(prompt).toContain("YOUR PROJECT'S INSTRUCTIONS ARE NOT LOADED FOR YOU");
        expect(prompt).not.toMatch(/node "\$KANON|\$KANON\//);
      });
    });
  }

  describe('the spine', () => {
    const spine = read('lane-agent-job.yml').jobs.run!;
    const steps = spine.steps!;
    const wrap = steps.find((s) => s.name === "Put Kanon's scripts on the agent's PATH, by name")!;

    it('records the flags the agent ran with, so config_fingerprint is the run\'s', () => {
      const agent = steps.find((s) => s.id === 'agent')!;
      const finish = steps.find((s) => s.uses === '$/actions/agent-finish')!;
      expect(agent.with?.claude_args).toBe('${{ inputs.claude_args }}');
      expect(finish.with?.claude_args).toBe('${{ inputs.claude_args }}');
    });

    it('puts exactly the allowed scripts on the PATH, only for a lane with the setup off, before the agent', () => {
      expect(wrap.if).toBe('${{ !inputs.project-setup }}');
      expect(String(wrap.run)).toContain(`for s in ${KANON_SCRIPTS.join(' ')}; do`);
      expect(String(wrap.run)).toContain('>> "$GITHUB_PATH"');
      expect(steps.indexOf(wrap)).toBeLessThan(steps.findIndex((s) => s.id === 'agent'));
      expect(steps.indexOf(wrap)).toBeGreaterThan(steps.findIndex((s) => s.id === 'kanon'));
    });
  });
});

describe('the rule check', () => {
  it('fails each widening', () => {
    for (const t of ['Bash', 'Bash(*)', 'Bash(node:*)', 'Bash(npm run lint:*)', 'Bash(git:*)', 'Bash(git push:*)', 'Bash(git -c x:*)',
      'Bash(git fetch:*)', 'Bash(gh:*)', 'Bash(gh workflow run:*)', 'Bash(gh pr checkout:*)', 'Bash(kanon-x:*)', 'Bash(kanon-brief-guard && sh:*)',
      'Bash(sh marker.sh)', 'Bash(env X=1 git commit:*)', 'Bash(cat:*)']) {
      expect(badBashRules([t]), t).toEqual([t]);
    }
    expect(badBashRules(EXPECTED)).toEqual([]);
  });
});

/**
 * kanon#327: `Edit(/docs/**)` must not write outside `docs/` through a symlink the tree carries,
 * such as `docs/x -> ../.git/config`. Whether Claude Code matches the rule against the named
 * path or the link's target is its own behaviour, so the spine takes the link away instead: for
 * a lane with the project setup off, git checks every symlink out as a plain file, now and on
 * every later checkout, and the step fails if a link is left. Its body runs here on a scratch
 * repository whose commits carry the links an attacker would plant.
 */
describe('the spine leaves the agent no symlink to write through (kanon#327)', () => {
  const steps = read('lane-agent-job.yml').jobs.run!.steps!;
  const step = steps.find((s) => s.name === "Check the tree's symlinks out as plain files")!;
  const ENV = { ...process.env, HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (dir: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8', env: ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const isLink = (p: string) => lstatSync(p).isSymbolicLink();
  // The links a pull request's head could commit: to `.git/config`, to the hooks directory,
  // to the top of the tree, `docs/` itself, and a name with a space and a newline in it.
  const LINKS: [string, string][] = [['docs/x', '../.git/config'], ['docs/a b', '../.git/hooks'], ['docs/up', '..'], ['docs/new\nline', '../.git/config']];
  const repo = (links: [string, string][] = LINKS) => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-symlinks-'));
    git(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/brief.md'), 'a brief\n');
    for (const [path, target] of links) symlinkSync(target, join(dir, path));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'a tree with links');
    return dir;
  };
  const runStep = (dir: string) => {
    const r = spawnSync('bash', ['-e', '-c', String(step.run)], { cwd: dir, encoding: 'utf8', env: ENV });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('runs only for a lane with the setup off, after the checkout and before the agent', () => {
    expect(step, 'the step').toBeDefined();
    expect(step.if).toBe('${{ !inputs.project-setup }}');
    expect(steps.indexOf(step)).toBeGreaterThan(steps.findIndex((s) => s.uses === 'actions/checkout@v7'));
    expect(steps.indexOf(step)).toBeLessThan(steps.findIndex((s) => s.id === 'agent'));
  });

  it('checks each link out as a plain file holding its target, and leaves the status clean', () => {
    const dir = repo();
    try {
      const r = runStep(dir);
      expect(r.status, r.out).toBe(0);
      for (const [path, target] of LINKS) {
        expect(isLink(join(dir, path)), path).toBe(false);
        expect(readFileSync(join(dir, path), 'utf8'), path).toBe(target);
      }
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(r.out).toContain("::notice title=agent-lane::docs/x is a symlink in this tree");
      // The newline is escaped, so the path can't open a workflow command of its own.
      expect(r.out.split('\n').filter((l) => l.startsWith('line'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('so a write to the link\'s path leaves .git/config alone, and a commit keeps the link a link', () => {
    const dir = repo();
    try {
      expect(runStep(dir).status).toBe(0);
      const config = readFileSync(join(dir, '.git/config'), 'utf8');
      writeFileSync(join(dir, 'docs/x'), '[core]\n\tfsmonitor = ./evil\n');
      expect(readFileSync(join(dir, '.git/config'), 'utf8')).toBe(config);
      git(dir, 'add', 'docs/x');
      expect(git(dir, 'ls-files', '-s', 'docs/x')).toMatch(/^120000 /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('and a branch the agent checks out later brings no link either', () => {
    const dir = repo([]);
    try {
      git(dir, 'checkout', '-q', '-b', 'planted');
      symlinkSync('../.git/config', join(dir, 'docs/x'));
      symlinkSync('.git', join(dir, 'gitdir'));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'plant links');
      git(dir, 'checkout', '-q', 'main');
      expect(runStep(dir).status).toBe(0);
      git(dir, 'checkout', '-q', 'planted');
      expect(isLink(join(dir, 'docs/x'))).toBe(false);
      expect(isLink(join(dir, 'gitdir'))).toBe(false);
      expect(git(dir, 'status', '--porcelain')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a link is left in the work tree, tracked or not', () => {
    const dir = repo([]);
    try {
      symlinkSync('../.git/config', join(dir, 'docs/x'));
      const r = runStep(dir);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('the work tree still holds a symlink');
      expect(r.out).toContain('./docs/x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
