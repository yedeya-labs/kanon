import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { laneFiles, laneTree } from './helpers/requirements.js';
import { SPAWNS } from './helpers/spawns.js';

const { budgetFor, checkMaxTurns, turnBudget } = await import('../../actions/agent-run/turn-budget.mjs');

/**
 * kanon#891 — each agent lane's `--max-turns` is an adopter input, `max_turns`, with a ceiling
 * Kanon fixes per lane.
 *
 * How many turns a job needs depends on the adopter's repository: an adopter's ~500-line brief
 * under revision ran the brief-revise lane to its 90-turn cap and pushed nothing, and the cap
 * error's advice, "raise `--max-turns`", needed a Kanon release. So every lane that runs a model
 * takes `max_turns` from its caller. Empty, the lane's own flags run as before. A whole number up
 * to the lane's ceiling replaces its `--max-turns` and the dollar cap derived from it
 * (`K-OBS-12`). Anything else is refused by `agent-run`'s first step, before any model call.
 *
 * THE CEILING IS TWICE EACH LANE'S DEFAULT: the issue left the number open, and this is the
 * decision put to the Owner in the pull request.
 */
const ROOT = process.cwd();
const WF = join(ROOT, '.github/workflows');
const read = (f: string) => readFileSync(join(WF, f), 'utf8');

const FLAGS = '--model claude-opus-5-5\n--effort high\n--max-turns 90\n--max-budget-usd 40\n--fallback-model claude-opus-5\n';

describe('the turn budget a caller sets', () => {
  it('empty: the lane\'s flags run unchanged, its default budget included', () => {
    const r = turnBudget({ claudeArgs: FLAGS, maxTurns: '', ceiling: '180' });
    expect(r).toMatchObject({ ok: true, claudeArgs: FLAGS, turns: 90 });
    // A lane that takes no budget from its caller (no ceiling) runs as it always did.
    expect(turnBudget({ claudeArgs: FLAGS })).toMatchObject({ ok: true, claudeArgs: FLAGS });
  });

  it('a whole number at or under the ceiling replaces the lane\'s --max-turns and its dollar cap', () => {
    const r = turnBudget({ claudeArgs: FLAGS, maxTurns: '150', ceiling: '180' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turns).toBe(150);
    expect(r.claudeArgs).toBe(FLAGS.replace('--max-turns 90', '--max-turns 150').replace('--max-budget-usd 40', '--max-budget-usd 60'));
    expect(turnBudget({ claudeArgs: FLAGS, maxTurns: '180', ceiling: '180' })).toMatchObject({ ok: true, turns: 180 });
    expect(turnBudget({ claudeArgs: FLAGS, maxTurns: '1', ceiling: '180' })).toMatchObject({ ok: true, turns: 1 });
  });

  it('derives the dollar cap at $0.40 a turn, rounded up to the next $5 (K-OBS-12), as every lane\'s own flags do', () => {
    // Each pair is a lane's own default turns and dollar cap, so the derivation is the one they use.
    for (const [turns, usd] of [[15, 10], [20, 10], [30, 15], [60, 25], [70, 30], [80, 35], [90, 40], [100, 40], [120, 50], [300, 120]] as const) {
      expect(budgetFor(turns), `${turns} turns`).toBe(usd);
    }
    expect(budgetFor(600)).toBe(240);
  });

  it.each([
    ['above the ceiling', '181', /max_turns is 181, above Kanon's ceiling of 180 turns for this lane/],
    ['far above the ceiling', '100000', /above Kanon's ceiling of 180/],
    ['zero', '0', /must be a whole number of turns from 1 to 180, not "0"/],
    ['negative', '-5', /must be a whole number of turns from 1 to 180, not "-5"/],
    ['not a number', 'lots', /must be a whole number of turns from 1 to 180, not "lots"/],
    ['a fraction', '1.5', /must be a whole number/],
    ['a leading zero', '090', /must be a whole number/],
    ['a flag smuggled after a number', '90 --dangerously-skip-permissions', /must be a whole number/],
  ])('refuses a value %s, naming max_turns, and hands the agent nothing', (_name, value, message) => {
    const r = turnBudget({ claudeArgs: FLAGS, maxTurns: value, ceiling: '180' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^::error title=max_turns::/);
    expect(r.message).toMatch(message);
    expect(r.message).toContain('docs/lanes.md, "The turn budget"');
    expect('claudeArgs' in r).toBe(false);
  });

  it('refuses a value on a lane that gives no ceiling', () => {
    const r = turnBudget({ claudeArgs: FLAGS, maxTurns: '50', ceiling: '' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/this lane gives no ceiling for it/);
  });

  it('refuses a value when the lane\'s flags hold no single --max-turns to replace', () => {
    const r = turnBudget({ claudeArgs: '--model x\n', maxTurns: '50', ceiling: '180' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/0 --max-turns and 0 --max-budget-usd/);
  });

  it('prints a refused value encoded, so it can\'t write a workflow command of its own', () => {
    const r = checkMaxTurns('1\n::add-mask::x%', '180');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toMatch(/\n/);
    expect(r.message).toContain('"1\\n::add-mask::x%25"');
  });
});

describe('the script, as agent-run runs it', SPAWNS, () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const run = (maxTurns: string, ceiling = '180') => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-budget-'));
    dirs.push(dir);
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const r = spawnSync('node', [join(ROOT, 'actions/agent-run/turn-budget.mjs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_ARGS: FLAGS, MAX_TURNS: maxTurns, MAX_TURNS_CEILING: ceiling, GITHUB_OUTPUT: out },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, written: readFileSync(out, 'utf8') };
  };

  it('writes the lane\'s own flags when the caller set nothing: the default is unchanged', () => {
    const r = run('');
    expect(r.status, r.out).toBe(0);
    expect(r.written).toMatch(/^max-turns=90\nclaude-args<<(EOF_[0-9a-f]+)\n([\s\S]*)\n\1\n$/);
    expect(/claude-args<<(EOF_[0-9a-f]+)\n([\s\S]*)\n\1\n$/.exec(r.written)![2]).toBe(FLAGS);
  });

  it('writes the caller\'s budget when it is in bounds', () => {
    const r = run('120');
    expect(r.status, r.out).toBe(0);
    expect(r.written).toContain('max-turns=120\n');
    expect(r.written).toContain('--max-turns 120\n--max-budget-usd 50\n');
  });

  it.each(['181', '0', '-1', 'abc'])('fails on %s and writes nothing', (v) => {
    const r = run(v);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error title=max_turns::/);
    expect(r.written).toBe('');
  });
});

describe('agent-run checks the budget first, and runs the flags the check wrote', () => {
  type Step = { id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string>; 'continue-on-error'?: unknown };
  const action = parse(readFileSync(join(ROOT, 'actions/agent-run/action.yml'), 'utf8')) as {
    inputs: Record<string, { default?: string }>; outputs: Record<string, { value: string }>; runs: { steps: Step[] };
  };
  const steps = action.runs.steps;

  it('takes max-turns and max-turns-ceiling, both empty by default', () => {
    expect(action.inputs['max-turns']?.default).toBe('');
    expect(action.inputs['max-turns-ceiling']?.default).toBe('');
  });

  it('checks it right after the start stamp, before the credential and the agent, in a step that may fail the block', () => {
    // The start stamp stays first, as the agent's lower bound (RA-1627); it cannot fail.
    expect(steps.findIndex((s) => s.id === 'turns')).toBe(1);
    expect(steps.findIndex((s) => s.id === 'turns')).toBeLessThan(steps.findIndex((s) => s.id === 'credential'));
    const first = steps[1]!;
    expect(first.id).toBe('turns');
    expect(first.run).toBe('node "$GITHUB_ACTION_PATH/turn-budget.mjs"');
    expect(first['continue-on-error']).toBeUndefined();
    // Through `env:` only, never the run line (K-AGENT-45).
    expect(first.env).toEqual({
      CLAUDE_ARGS: '${{ inputs.claude_args }}',
      MAX_TURNS: '${{ inputs.max-turns }}',
      MAX_TURNS_CEILING: '${{ inputs.max-turns-ceiling }}',
    });
    for (const s of steps) expect(String(s.run ?? '')).not.toMatch(/inputs\.max-turns/);
  });

  it('the agent runs the flags the check wrote, and the block hands them on for the cost row', () => {
    const agent = steps.find((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@'))!;
    expect(agent.with?.claude_args).toMatch(/^\$\{\{ steps\.turns\.outputs\.claude-args \}\}\n/);
    expect(agent.with?.claude_args).not.toMatch(/inputs\.claude_args/);
    expect(action.outputs['claude-args']?.value).toBe('${{ steps.turns.outputs.claude-args }}');
  });
});

// ─── every lane takes it ────────────────────────────────────────────────────────────────────
type Doc = { on?: { workflow_call?: { inputs?: Record<string, { type?: string; default?: unknown; description?: string }> } }; jobs?: Record<string, Job> };
type Job = { uses?: string; with?: Record<string, unknown>; steps?: Array<{ uses?: string; with?: Record<string, unknown> }> };
const doc = (f: string) => parse(read(f)) as Doc;
const runsModel = (f: string) => laneTree(ROOT, f).some((t) => /uses: \$\/actions\/agent-run\s*$/m.test(read(t)) || /uses: \$\/\.github\/workflows\/agent-lane\.yml\s*$/m.test(read(t)));
const MODEL_LANES = laneFiles(ROOT).filter(runsModel);
const marker = (f: string) => {
  const m = /^# MAX TURNS: (\d+), at most (\d+)$/m.exec(read(f));
  return m ? { turns: Number(m[1]), ceiling: Number(m[2]) } : null;
};
const PASS = '${{ inputs.max_turns }}';

describe('every lane that runs a model takes max_turns, defaulting to its own cap', () => {
  it('finds the lanes, so the cases below are not vacuous', () => {
    expect(MODEL_LANES.length).toBe(17);
    expect(MODEL_LANES).toContain('agent-lead-revise.yml');
  });

  it.each(MODEL_LANES)('%s declares max_turns, an optional string, empty by default', (f) => {
    const input = doc(f).on?.workflow_call?.inputs?.max_turns;
    expect(input, f).toMatchObject({ type: 'string', default: '' });
    expect((input as { required?: boolean }).required).toBe(false);
  });

  it.each(MODEL_LANES)('%s states its default and ceiling, the ceiling twice the default, and its input says the same', (f) => {
    const m = marker(f);
    expect(m, `${f}: no # MAX TURNS: line`).not.toBeNull();
    expect(m!.ceiling).toBe(2 * m!.turns);
    const description = String(doc(f).on?.workflow_call?.inputs?.max_turns?.description);
    expect(description).toContain(`from 1 to ${m!.ceiling}`);
    expect(description).toContain(`the lane's default, ${m!.turns}`);
  });

  it.each(MODEL_LANES)('%s: every --max-turns its arms run is the stated default, unchanged', (f) => {
    const caps = laneTree(ROOT, f).flatMap((t) => [...read(t).matchAll(/^\s*--max-turns\s+(\d+)\s*$/gm)].map((m) => Number(m[1])));
    expect(caps.length, f).toBeGreaterThan(0);
    expect(new Set(caps), f).toEqual(new Set([marker(f)!.turns]));
  });

  it.each(MODEL_LANES)('%s hands the caller\'s value, and the stated ceiling, to every agent-run it reaches', (f) => {
    const { ceiling } = marker(f)!;
    let runs = 0;
    // The spine's own two files are held by the case after this one, once for every lane.
    for (const t of laneTree(ROOT, f).filter((x) => x !== 'agent-lane.yml' && x !== 'lane-agent-job.yml')) {
      const d = doc(t);
      for (const [id, job] of Object.entries(d.jobs ?? {})) {
        // Through the spine: the lane's call carries both, and the spine hands them on.
        if (job.uses === '$/.github/workflows/agent-lane.yml') {
          runs++;
          expect(job.with?.['max-turns'], `${t}#${id}`).toBe(PASS);
          expect(job.with?.['max-turns-ceiling'], `${t}#${id}`).toBe(String(ceiling));
        }
        // Down the chain: each Kanon workflow the lane calls gets it passed through.
        if (job.uses?.startsWith('$/.github/workflows/') && job.uses !== '$/.github/workflows/agent-lane.yml') {
          expect(job.with?.max_turns, `${t}#${id} → ${job.uses}`).toBe(PASS);
        }
        for (const s of job.steps ?? []) {
          if (s.uses === '$/actions/agent-run') {
            runs++;
            expect(s.with?.['max-turns'], `${t}#${id}`).toBe(PASS);
            expect(s.with?.['max-turns-ceiling'], `${t}#${id}`).toBe(String(ceiling));
          }
          if (s.uses === '$/actions/agent-finish') expect(s.with?.['claude-args-ran'], `${t}#${id}`).toBe('${{ steps.agent.outputs.claude-args }}');
        }
      }
    }
    expect(runs, f).toBe(1);
  });

  it('the spine hands both to agent-run, and the flags that ran to agent-finish', () => {
    const lane = doc('agent-lane.yml');
    expect(lane.on?.workflow_call?.inputs?.['max-turns']).toMatchObject({ type: 'string', default: '' });
    expect(lane.jobs?.run?.with).toMatchObject({ 'max-turns': '${{ inputs.max-turns }}', 'max-turns-ceiling': '${{ inputs.max-turns-ceiling }}' });
    const steps = doc('lane-agent-job.yml').jobs!.run!.steps!;
    expect(steps.find((s) => s.uses === '$/actions/agent-run')?.with).toMatchObject({ 'max-turns': '${{ inputs.max-turns }}', 'max-turns-ceiling': '${{ inputs.max-turns-ceiling }}' });
    expect(steps.find((s) => s.uses === '$/actions/agent-finish')?.with?.['claude-args-ran']).toBe('${{ steps.agent.outputs.claude-args }}');
  });

  it('agent-finish records the flags that ran, falling back to the lane\'s own', () => {
    const finish = readFileSync(join(ROOT, 'actions/agent-finish/action.yml'), 'utf8');
    expect(finish).toContain('claude_args: ${{ inputs.claude-args-ran || inputs.claude_args }}');
  });
});
