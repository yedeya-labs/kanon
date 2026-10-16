// kanon#1074: the pin job's check of Kanon's callers against the candidate, `scripts/pin-lane-check.mjs`.
// After `move-pins.mjs` moves every pin, it runs the candidate's own `lane-check` on the moved tree,
// as CI's `Lane check` will on the pin pull request, and lists what each caller needs. The case it
// was built for is candidate v0.41.0 (#1067): the project digest's lane took
// `KANON_CHAT_PROJECT_DIGEST` in place of `DIGEST_WEBHOOK` (plan 0011 N7, decision 17), so a caller
// still mapping the old secret turned the pin pull request red with nothing saying why.
//
// The fixture tree is lane-check's fixture adopter (`tests/fixtures/lane-check/adopter`) with a
// caller of the project digest, and the lanes are this tree's, as the pin job reads the candidate's.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { movePins } from '../../scripts/move-pins.mjs';
import { laneCheckProblems, pinLaneCheck, pinLaneCheckCli, problemList } from '../../scripts/pin-lane-check.mjs';
import { adopter, hasYq, ROOT } from './helpers/lane-check.js';

const SCRIPT = join(ROOT, 'scripts/pin-lane-check.mjs');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const RELEASE = `candidate-v${VERSION}`;
const DIGEST = '.github/workflows/agent-project-digest.yml';

/** A caller of the project digest at the fixture's pin, mapping `chat` as its chat secret. */
const digestCaller = (chat: string) =>
  [
    'name: Daily project digest',
    'on:',
    '  schedule:',
    '    - cron: "0 7 * * *"',
    '  workflow_dispatch:',
    '    inputs:',
    '      dry_run:',
    '        description: "\'true\' to print the message instead of posting it"',
    '        required: false',
    'permissions:',
    '  actions: read',
    '  contents: read',
    '  issues: write',
    '  pull-requests: read',
    'jobs:',
    '  digest:',
    '    uses: yedeya-labs/kanon/.github/workflows/agent-project-digest.yml@v1.2.3',
    '    with:',
    '      dry_run: ${{ inputs.dry_run }}',
    '    secrets:',
    '      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
    `      ${chat}: \${{ secrets.${chat} }}`,
    '',
  ].join('\n');

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The fixture adopter with a digest caller mapping `chat`, its pins moved to the candidate as the pin job moves them. */
const moved = (chat: string) => {
  const tree = adopter();
  roots.push(tree.dir);
  tree.write(DIGEST, digestCaller(chat));
  const changed = movePins({ root: tree.dir, release: RELEASE }).map((c) => c.path);
  expect(changed).toContain(DIGEST);
  return tree.dir;
};

/** Every file under `dir`, by its path relative to `dir`. */
const snapshot = (dir: string, at = dir): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of readdirSync(at)) {
    const path = join(at, name);
    if (statSync(path).isDirectory()) Object.assign(out, snapshot(dir, path));
    else out[relative(dir, path)] = readFileSync(path, 'utf8');
  }
  return out;
};

describe('the pieces', () => {
  it("reads each `::error` lane-check prints, with the file it names, and nothing else it prints", () => {
    const out = [
      '::error file=.github/workflows/a.yml,title=lane-check::maps secrets [X]; the Kanon lane a takes exactly [Y]',
      '::notice file=docs/qa/stack.md,title=lane-check::declares no `## Code areas`',
      '::warning file=.github/workflows/b.yml,title=lane-check::a rule in its release of warning',
      '::error title=lane-check::run it from the root of the checkout',
      'lane-check: 2 problem(s) in 2 lane caller(s)',
    ].join('\n');
    expect(laneCheckProblems(out)).toEqual([
      { file: '.github/workflows/a.yml', message: 'maps secrets [X]; the Kanon lane a takes exactly [Y]' },
      { file: '', message: 'run it from the root of the checkout' },
    ]);
  });

  it('lists each problem as a markdown bullet, with its file in code when it names one', () => {
    expect(problemList([{ file: '.github/workflows/a.yml', message: 'maps secrets [X]' }, { file: '', message: 'cannot run' }])).toBe(
      '- `.github/workflows/a.yml`: maps secrets [X]\n- cannot run',
    );
    expect(problemList([])).toBe('');
  });

  it('refuses a release that is not exact', () => {
    expect(() => pinLaneCheck({ root: ROOT, release: 'main' })).toThrow(/not an exact release/);
    expect(pinLaneCheckCli(['v0.41'], ROOT).code).toBe(2);
    expect(pinLaneCheckCli([], ROOT).code).toBe(2);
  });
});

// lane-check needs `yq`, which CI always has (tests/unit/helpers/lane-check.ts).
describe.skipIf(!hasYq)("the candidate's lane-check on the moved callers (kanon#1074)", { timeout: 20_000 }, () => {
  it('names a caller that still maps DIGEST_WEBHOOK, and what the lane takes instead (the v0.41.0 case)', () => {
    const root = moved('DIGEST_WEBHOOK');
    const r = pinLaneCheck({ root, release: RELEASE });
    expect(r.ok, r.out).toBe(false);
    expect(r.problems).toEqual([
      {
        file: DIGEST,
        message: expect.stringMatching(/^maps secrets \[CLAUDE_CODE_OAUTH_TOKEN,DIGEST_WEBHOOK\]; the Kanon lane agent-project-digest takes exactly \[[A-Z_,]*KANON_CHAT_PROJECT_DIGEST[A-Z_,]*\]/),
      },
    ]);
    expect(problemList(r.problems)).toMatch(/^- `\.github\/workflows\/agent-project-digest\.yml`: maps secrets \[CLAUDE_CODE_OAUTH_TOKEN,DIGEST_WEBHOOK\]/);
  });

  it('lists nothing for a caller that needs no change', () => {
    const root = moved('KANON_CHAT_PROJECT_DIGEST');
    const r = pinLaneCheck({ root, release: RELEASE });
    expect(r.ok, r.out).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('changes nothing in the tree, so the pin job still moves only refs', () => {
    for (const chat of ['DIGEST_WEBHOOK', 'KANON_CHAT_PROJECT_DIGEST']) {
      const root = moved(chat);
      const before = snapshot(root);
      pinLaneCheck({ root, release: RELEASE });
      expect(snapshot(root), chat).toEqual(before);
    }
  });

  it('runs lane-check at the release, so a pin the move left behind is named too', () => {
    const root = moved('KANON_CHAT_PROJECT_DIGEST');
    const r = pinLaneCheck({ root, release: `candidate-v${VERSION.replace(/\d+$/, (n) => String(Number(n) + 1))}` });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.message).join('\n')).toMatch(/lane-check runs at candidate-v/);
  });

  it('lists a lane-check that cannot run as a problem, never as a pass (K-PRIN-10)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pin-lane-check-empty-'));
    roots.push(root);
    const r = pinLaneCheck({ root, release: RELEASE });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ file: '', message: expect.stringContaining('no .github/workflows here') }]);
  });

  it('lists a lane-check that stops without naming a problem, never as a pass (K-PRIN-10)', () => {
    const kanon = mkdtempSync(join(tmpdir(), 'pin-lane-check-kanon-'));
    roots.push(kanon);
    mkdirSync(join(kanon, 'actions/lane-check'), { recursive: true });
    writeFileSync(join(kanon, 'actions/lane-check/lane-check.sh'), 'echo "Segmentation fault" >&2\nexit 139\n');
    const r = pinLaneCheck({ root: moved('KANON_CHAT_PROJECT_DIGEST'), release: RELEASE, kanon });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ file: '', message: "lane-check stopped with 139, and named no problem: read the pin job's log" }]);
  });

  describe('the CLI, from the current directory, as the pin job runs it', () => {
    it('prints the list and exits 1 when a caller needs a change', () => {
      const root = moved('DIGEST_WEBHOOK');
      const r = spawnSync(process.execPath, [SCRIPT, RELEASE], { cwd: root, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).toMatch(/^- `\.github\/workflows\/agent-project-digest\.yml`: maps secrets \[CLAUDE_CODE_OAUTH_TOKEN,DIGEST_WEBHOOK\]/);
      // lane-check's own output goes to the job's log.
      expect(r.stderr).toContain('::error file=.github/workflows/agent-project-digest.yml');
    });

    it('prints nothing and exits 0 when none does', () => {
      const root = moved('KANON_CHAT_PROJECT_DIGEST');
      const r = spawnSync(process.execPath, [SCRIPT, RELEASE], { cwd: root, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // The pin job's own steps, run on the fixture tree: the move, then the check, whose list the
  // pull request step reads from `$RUNNER_TEMP/callers.md`. `scripts/` is linked into the tree, as
  // the job's checkout holds the candidate's, so the step's `node scripts/…` lines run as written.
  describe("the pin job's steps on the fixture tree", () => {
    type Step = { id?: string; run?: string; env?: Record<string, string> };
    const wf = parse(readFileSync(join(ROOT, '.github/workflows/release-please.yml'), 'utf8')) as { jobs: { pins: { steps: Step[] } } };
    const steps = wf.jobs.pins.steps;
    const move = steps.find((s) => s.run?.includes('scripts/move-pins.mjs'));
    const check = steps.find((s) => s.id === 'callers');

    const runSteps = (chat: string) => {
      const tree = adopter();
      roots.push(tree.dir);
      tree.write(DIGEST, digestCaller(chat));
      symlinkSync(join(ROOT, 'scripts'), join(tree.dir, 'scripts'));
      // The job's checkout is a repository: the move step prints `git diff --stat`.
      expect(spawnSync('git', ['init', '-q'], { cwd: tree.dir }).status).toBe(0);
      const temp = mkdtempSync(join(tmpdir(), 'pin-job-temp-'));
      roots.push(temp);
      const summary = join(temp, 'summary');
      const env = { ...process.env, TAG: RELEASE, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary };
      const runs = [move, check].map((s) => spawnSync('bash', ['-c', String(s?.run)], { cwd: tree.dir, encoding: 'utf8', env }));
      const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
      return { runs, tree, callers: read(join(temp, 'callers.md')), summary: read(summary) };
    };

    it('lists the caller that needs a change for the pull request, in the step summary and as a warning, and succeeds', () => {
      const r = runSteps('DIGEST_WEBHOOK');
      for (const run of r.runs) expect(run.status, run.stderr).toBe(0);
      expect(r.callers).toMatch(/^- `\.github\/workflows\/agent-project-digest\.yml`: maps secrets \[CLAUDE_CODE_OAUTH_TOKEN,DIGEST_WEBHOOK\]/);
      expect(r.summary).toContain(r.callers.trim());
      expect(r.runs[1]?.stdout).toMatch(/::warning title=pin job::/);
      // The caller is moved, and left as its author wrote it otherwise: the person changes it.
      expect(r.tree.read(DIGEST)).toBe(digestCaller('DIGEST_WEBHOOK').replace('@v1.2.3', `@${RELEASE}`));
    });

    it('lists nothing when no caller needs a change', () => {
      const r = runSteps('KANON_CHAT_PROJECT_DIGEST');
      for (const run of r.runs) expect(run.status, run.stderr).toBe(0);
      expect(r.callers).toBe('');
      expect(r.summary).toContain("The candidate's lane-check passes on the moved callers.");
    });
  });
});

