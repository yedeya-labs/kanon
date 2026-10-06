import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Plan 0005 step L8 (§5.2): a playbook the project leaves out is Kanon's baseline for the role,
 * and an omitted stack-document section means none. The lanes' prompts read the playbooks at
 * their fixed paths, so `agent-setup` puts the baseline there before the agent starts
 * (`actions/agent-setup/declaration-defaults.sh`), and names every default it takes.
 *
 * Each case runs the real script in a throwaway git checkout.
 */
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'actions/agent-setup/declaration-defaults.sh');
const BASELINES = join(ROOT, 'rulebook/templates/playbooks');
const PLAYBOOKS = readdirSync(BASELINES).filter((f) => f.endsWith('-playbook.md')).sort();

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

const checkout = (files: Record<string, string> = {}, git = true) => {
  dir = mkdtempSync(join(tmpdir(), 'declaration-defaults-'));
  if (git) spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
};
const run = (cwd: string) => {
  const summary = join(cwd, '..', `${cwd.split('/').pop()}-summary.md`);
  const env = join(cwd, '..', `${cwd.split('/').pop()}-env`);
  writeFileSync(summary, '');
  writeFileSync(env, '');
  const r = spawnSync('bash', [SCRIPT], { cwd, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, GITHUB_STEP_SUMMARY: summary, GITHUB_ENV: env } });
  const out = { status: r.status, out: `${r.stdout}${r.stderr}`, summary: readFileSync(summary, 'utf8'), env: readFileSync(env, 'utf8') };
  rmSync(summary);
  rmSync(env);
  return out;
};
const status = (cwd: string) => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' }).stdout;

describe("Kanon's baseline playbooks (K-LAYOUT-17)", () => {
  // The playbooks K-LAYOUT-17 names, and the headings it says a prompt sends the agent to.
  const rule = readFileSync(join(ROOT, 'rulebook/11-repository-layout.md'), 'utf8');
  const start = rule.indexOf('### `K-LAYOUT-17`');
  const end = rule.indexOf('### `K-LAYOUT-18`');
  if (start < 0 || end < start) throw new Error('K-LAYOUT-17 moved: re-anchor this test');
  const body = rule.slice(start, end);
  const named = [...body.matchAll(/^ {2}- \*\*`docs\/qa\/([a-z-]+-playbook\.md)`\*\*: (.*)$/gm)].map((m) => ({
    file: m[1]!,
    headings: [...m[2]!.matchAll(/`(## [^`]+)`/g)].map((h) => h[1]!),
  }));

  it('ships one for every playbook the rule names, and none it does not', () => {
    const listed = [...new Set([...body.matchAll(/`docs\/qa\/([a-z-]+-playbook\.md)`/g)].map((m) => m[1]!))].sort();
    expect(listed.length).toBeGreaterThanOrEqual(5);
    expect(PLAYBOOKS).toEqual(listed);
  });

  it.each(named.map((n) => [n.file, n.headings] as const))('%s holds every heading a prompt sends the agent to', (file, headings) => {
    expect(headings.length).toBeGreaterThan(0);
    const lines = readFileSync(join(BASELINES, file), 'utf8').split('\n');
    for (const h of headings) expect(lines.filter((l) => l === h), h).toHaveLength(1);
  });
});

describe('agent-setup takes the defaults before the agent starts', () => {
  it('runs the script with no condition, so every lane gets it, before any step that commits', () => {
    const action = parse(readFileSync(join(ROOT, 'actions/agent-setup/action.yml'), 'utf8')) as { runs: { steps: { name?: string; if?: string; run?: string }[] } };
    const steps = action.runs.steps;
    const at = steps.findIndex((s) => s.run === 'bash "$GITHUB_ACTION_PATH/declaration-defaults.sh"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(steps[at]!.if).toBeUndefined();
    // After the persona step, which #310 holds first, and before the commit identity.
    expect(steps.findIndex((s) => s.name === 'Commit as the App, signed off by the delegate')).toBeGreaterThan(at);
  });

  it("puts Kanon's baseline where each missing playbook would be, keeps it out of commits, and names it", () => {
    const cwd = checkout({ 'README.md': 'x\n' });
    const r = run(cwd);
    expect(r.status, r.out).toBe(0);
    for (const f of PLAYBOOKS) {
      expect(readFileSync(join(cwd, 'docs/qa', f), 'utf8')).toBe(readFileSync(join(BASELINES, f), 'utf8'));
      const line = `docs/qa/${f} doesn't exist, so the lane reads Kanon's baseline for it, at a path git ignores (plan 0005 §5.2, K-LAYOUT-17)`;
      expect(r.out).toContain(line);
      expect(r.summary).toContain(`- ${line}`);
    }
    // Nothing the agent's `git add -A` would pick up.
    expect(status(cwd)).toBe('?? README.md\n');
  });

  it("keeps the project's own playbook, and says nothing about it", () => {
    const own = '# Our reviewer playbook\n';
    const cwd = checkout({ 'docs/qa/reviewer-playbook.md': own });
    const r = run(cwd);
    expect(readFileSync(join(cwd, 'docs/qa/reviewer-playbook.md'), 'utf8')).toBe(own);
    expect(r.out).not.toContain('docs/qa/reviewer-playbook.md');
    expect(r.out).toContain('docs/qa/explorer-playbook.md doesn\'t exist');
  });

  it('is idempotent: a second run copies nothing and adds no second exclude line', () => {
    const cwd = checkout();
    run(cwd);
    const again = run(cwd);
    expect(again.out).not.toMatch(/baseline/);
    const exclude = readFileSync(join(cwd, '.git/info/exclude'), 'utf8').split('\n');
    expect(exclude.filter((l) => l === '/docs/qa/reviewer-playbook.md')).toHaveLength(1);
  });

  describe('tells the agent which playbooks are the baseline, so it can commit the project\'s first (kanon#329)', () => {
    const exported = (env: string) => {
      const lines = env.split('\n').filter((l) => l.startsWith('KANON_BASELINE_PLAYBOOKS='));
      expect(lines).toHaveLength(1);
      return lines[0]!.slice('KANON_BASELINE_PLAYBOOKS='.length).split(' ').filter(Boolean).sort();
    };
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

    it('exports every copy it made, and not the project\'s own playbook', () => {
      const cwd = checkout({ 'docs/qa/reviewer-playbook.md': '# Ours\n' });
      expect(exported(run(cwd).env)).toEqual(PLAYBOOKS.filter((f) => f !== 'reviewer-playbook.md').map((f) => `docs/qa/${f}`));
    });

    it('exports the copies an earlier run made, so the review lane\'s second run still names them', () => {
      const cwd = checkout();
      run(cwd);
      expect(exported(run(cwd).env)).toEqual(PLAYBOOKS.map((f) => `docs/qa/${f}`));
    });

    it('drops a copy the project has since committed as its own', () => {
      const cwd = checkout();
      run(cwd);
      // The case itself: the copy is ignored, so a plain add is refused, and `-f` is the remedy.
      expect(git(cwd, 'add', 'docs/qa/reviewer-playbook.md').status).not.toBe(0);
      expect(git(cwd, 'add', '-f', 'docs/qa/reviewer-playbook.md').status).toBe(0);
      expect(exported(run(cwd).env)).not.toContain('docs/qa/reviewer-playbook.md');
    });

    it('exports an empty list when the project keeps every playbook', () => {
      const cwd = checkout(Object.fromEntries(PLAYBOOKS.map((f) => [`docs/qa/${f}`, '# Ours\n'])));
      expect(run(cwd).env).toBe('KANON_BASELINE_PLAYBOOKS=\n');
    });
  });

  it.each([
    ['## Schema changes', 'the project has no schema'],
    ['## Data isolation', 'the project has nothing to isolate'],
    ['## Generated files', 'the project has no generated files'],
  ])("names the default for an omitted `%s`, and none for a present one", (h, means) => {
    const all = '## Gates\n\n## Schema changes\n\n## Data isolation\n\n## Generated files\n';
    const cwd = checkout({ 'docs/qa/stack.md': all.replace(`${h}\n`, '') });
    const r = run(cwd);
    const line = `docs/qa/stack.md has no \`${h}\`, so Kanon's default applies: ${means} (K-LAYOUT-17)`;
    expect(r.out).toContain(line);
    expect(r.summary).toContain(`- ${line}`);
    expect(r.out.match(/docs\/qa\/stack\.md has no/g)).toHaveLength(1);
  });

  it('does not count a heading inside a fenced block as present', () => {
    const cwd = checkout({ 'docs/qa/stack.md': '## Gates\n\n```\n## Schema changes\n```\n\n## Data isolation\n\n## Generated files\n' });
    expect(run(cwd).out).toContain('docs/qa/stack.md has no `## Schema changes`');
  });

  it('takes no default, and exits 0, where there is no checkout', () => {
    const cwd = checkout({}, false);
    const r = run(cwd);
    expect(r.status).toBe(0);
    expect(r.out).toContain('No checkout here');
    expect(existsSync(join(cwd, 'docs'))).toBe(false);
  });
});
