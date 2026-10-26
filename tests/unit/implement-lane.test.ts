import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { branchPattern } from '../../scripts/implement-crash.mjs';
import { MAP_PATH } from '../../scripts/starting-map.mjs';
import { jobPrompt } from './helpers/spine.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * RA-2456 part 2 — the implement lane's prompt points at the starting map first (plan 0001,
 * step 3, from the reference adopter's starting-map test).
 *
 * The adopter's project-setup hook writes the map for the lane whose `agent` is
 * `implementer`. A map nobody is told to read costs a minute and saves nothing.
 */
const lane = parse(readFileSync('.github/workflows/agent-implement.yml', 'utf8')) as {
  jobs: { implement: { with: { agent: string; prompt: string } } };
};

describe('the implement lane is told to read the starting map', () => {
  it('opts in by its name, and its prompt points at the file before the playbook', () => {
    const { agent, prompt } = lane.jobs.implement.with;
    expect(agent).toBe('implementer');
    expect(prompt.indexOf(MAP_PATH)).toBeGreaterThan(-1);
    expect(prompt.indexOf(MAP_PATH)).toBeLessThan(prompt.indexOf('docs/qa/triage-fix-playbook.md'));
  });
});

/**
 * kanon#622 — both of the Implementer's lanes re-point the line cites their diff moved before
 * they push (`K-SELF-3`).
 *
 * The measured case: an adopter's revise push fixed a real finding and went red on one step
 * only, `citation-shift`, because seven `file:line` cites into the files it edited now named
 * moved lines. The fix was one deterministic command, which the lane never ran: it wasn't
 * among the gates the agent runs, and it diffs against the base, so the adopter runs it as a
 * separate CI step. Its review then posted no verdict, and the red head had no owner.
 *
 * The command is read out of each prompt and run, so a prompt whose command stops working
 * fails here rather than in an adopter's CI.
 */
const reviseLane = parse(readFileSync('.github/workflows/agent-implement-revise.yml', 'utf8'));
const PROMPTS: [string, string][] = [
  ['implement', lane.jobs.implement.with.prompt],
  ['revise', jobPrompt(reviseLane.jobs.revise)],
];
const COMMAND = /^\s*(node "\$KANON\/scripts\/citation-shift\.mjs" .*)$/m;

describe('both implementer lanes re-point the cites their diff moved, before they push (kanon#622)', () => {
  it.each(PROMPTS)('%s: names the command, with an explicit base, --fix, the CI\'s --path list and a check after it', (_, prompt) => {
    const flat = prompt.replace(/\s+/g, ' ');
    expect(prompt.match(new RegExp(COMMAND.source, 'gm')), 'one command').toHaveLength(1);
    const command = COMMAND.exec(prompt)![1]!;
    expect(command).toMatch(/--base "\$\(git merge-base origin\/BASE HEAD\)"/);
    expect(command).toMatch(/ --fix$/);
    expect(flat).toMatch(/LINE CITES MOVE WITH THE CODE THAT MOVED THEM \(`K-SELF-3`\)/);
    expect(flat).toMatch(/BASE is the branch your pull request merges into/);
    expect(flat).toMatch(/every `--path` the project's own CI passes/);
    expect(flat).toMatch(/run it again without `--fix`: it must exit zero/);
  });

  it('the two lanes give the same instruction', () => {
    const para = (p: string) => p.slice(p.indexOf('LINE CITES MOVE'), p.indexOf('turns CI red'));
    expect(para(PROMPTS[0]![1]).length).toBeGreaterThan(200);
    expect(para(PROMPTS[1]![1])).toBe(para(PROMPTS[0]![1]));
  });

  it('sits with the gates: before the implement lane opens its PR, and before the revise lane reports', () => {
    const [implement, revise] = PROMPTS.map(([, p]) => p) as [string, string];
    expect(implement.indexOf('LINE CITES MOVE')).toBeGreaterThan(implement.indexOf('TEST-FIRST'));
    expect(implement.indexOf('LINE CITES MOVE')).toBeLessThan(implement.indexOf('OUTPUT: COMMIT ON YOUR BRANCH'));
    expect(revise.indexOf('LINE CITES MOVE')).toBeGreaterThan(revise.indexOf('RUN THE GATES BEFORE YOU PUSH'));
    expect(revise.indexOf('LINE CITES MOVE')).toBeLessThan(revise.indexOf('WHEN YOU ARE DONE'));
  });
});

// Its cases run `git` and `node` in `bash`, so the block takes the spawn budget (#436).
describe('the prompts\' command, run on a branch that merged its base in (kanon#622)', SPAWNS, () => {
  const ROOT = process.cwd();
  const env = {
    ...process.env, KANON: ROOT, GITHUB_ACTIONS: '',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const CODE = ['export function add(a: number, b: number) {', '  return a + b;', '}', '', 'export function total(xs: number[]) {', '  return xs.reduce(add, 0);', '}', ''].join('\n');
  const DOC = '# Design\n\nThe sum is `total`, at `src/calc.ts:5`.\n';

  /**
   * An origin with `main`, a clone whose branch moves `total` down two lines, and a later
   * commit on `main` merged into the branch: HEAD is a merge commit, as it is after a revise
   * run clears a conflict. Runs `command` there, then the check without `--fix`.
   */
  const runIn = (command: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'kanon-622-'));
    const sh = (cwd: string, script: string) => spawnSync('bash', ['-c', script], { cwd, env, encoding: 'utf8' });
    try {
      const origin = join(dir, 'origin');
      mkdirSync(join(origin, 'src'), { recursive: true });
      mkdirSync(join(origin, 'docs'));
      writeFileSync(join(origin, 'src/calc.ts'), CODE);
      writeFileSync(join(origin, 'docs/design.md'), DOC);
      expect(sh(origin, 'git init -q -b main && git add -A && git commit -qm base').status).toBe(0);
      expect(sh(dir, 'git clone -q origin work').status).toBe(0);
      const work = join(dir, 'work');
      writeFileSync(join(work, 'src/calc.ts'), `// Arithmetic.\n\n${CODE}`);
      expect(sh(work, 'git checkout -qb fix/622 && git commit -qam "move total"').status).toBe(0);
      writeFileSync(join(origin, 'NOTES.md'), 'unrelated\n');
      expect(sh(origin, 'git add -A && git commit -qm "later on main"').status).toBe(0);
      expect(sh(work, 'git fetch -q origin && git merge -q --no-ff origin/main -m "Merge main"').status).toBe(0);
      expect(sh(work, 'git cat-file -p HEAD | grep -c ^parent').stdout.trim(), 'HEAD is a merge commit').toBe('2');
      const fix = sh(work, command);
      const check = sh(work, command.replace(/ --fix$/, ''));
      return { fix, check, doc: readFileSync(join(work, 'docs/design.md'), 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const command = () => COMMAND.exec(PROMPTS[0]![1])![1]!.replace('BASE', 'main');

  it('re-points the cite the branch moved, and the check after it is green', () => {
    const r = runIn(command());
    expect(r.fix.status, `${r.fix.stdout}${r.fix.stderr}`).toBe(0);
    expect(r.fix.stdout).toMatch(/re-pointed 1 coordinate/);
    expect(r.doc).toContain('`src/calc.ts:7`');
    expect(r.check.status, `${r.check.stdout}${r.check.stderr}`).toBe(0);
  });

  it('without the explicit base it reads the merge commit as CI\'s, diffs the wrong parent, and leaves the cite behind', () => {
    // The mutation that shows why the prompt passes `--base`: drop it and the move is missed.
    const r = runIn(command().replace(/ --base "[^"]*"/, ''));
    expect(r.fix.status).toBe(0);
    expect(r.fix.stdout).not.toMatch(/re-pointed/);
    expect(r.doc).toContain('`src/calc.ts:5`');
  });
});

/**
 * kanon#1243 — the lanes that make their own branch name it `<type>/<issue>-<slug>` (`K-WS-8`).
 * Crash recovery and the dispatch sweep find an issue's branch by that shape, so each
 * example the prompts give is held to `branchPattern`, the shape both read.
 */
const leadLane = parse(readFileSync('.github/workflows/agent-lead.yml', 'utf8')) as {
  jobs: { brief: { with: { prompt: string } } };
};
const triageLane = parse(readFileSync('.github/workflows/agent-triage.yml', 'utf8')) as {
  jobs: { 'triage-fix': { with: { prompt: string } } };
};

describe('K-WS-8 the lanes that make their own branch name it for its issue', () => {
  it('the implement lane names the shape, and its example is one crash recovery reads', () => {
    const flat = lane.jobs.implement.with.prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('NAME YOUR BRANCH `<type>/<issue>-<slug>` (`K-WS-8`), such as `fix/42-empty-cart-total`');
    expect(branchPattern(42).test('fix/42-empty-cart-total')).toBe(true);
  });

  it('the triage lane, which opens a pull request for the bug it reproduces, names the shape', () => {
    const flat = triageLane.jobs['triage-fix'].with.prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('NAME YOUR BRANCH `<type>/<issue>-<slug>` (`K-WS-8`), such as `fix/42-empty-cart-total`');
    expect(flat.indexOf('NAME YOUR BRANCH')).toBeGreaterThan(flat.indexOf('then open a PR (fix + test)'));
  });

  it("the Lead's brief lane names its branch for the tracking issue", () => {
    const flat = leadLane.jobs.brief.with.prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('Commit it on a new branch named `docs/<n>-<slug>` (`K-WS-8`), the same <n>');
    expect(flat.indexOf('`docs/<n>-<slug>`')).toBeGreaterThan(flat.indexOf('docs/projects/<n>.md where <n> is the TRACKING ISSUE NUMBER'));
    expect(branchPattern(902).test('docs/902-project-brief')).toBe(true);
  });
});
