import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TRIGGERS } from '../../cli/callers.mjs';
import { laneFiles, laneTree } from './helpers/requirements.js';
import { SPAWNS } from './helpers/spawns.js';

const { budgetFor, checkMaxTurns, raiseSummary, turnBudget } = await import('../../actions/agent-run/turn-budget.mjs');

/**
 * kanon#891, as the Owner shaped it on 2026-10-15 (ADR 0005 §2, amended): a lane's turn limit is
 * never a standing setting. A person may raise it for ONE dispatched run, with a reason, up to a
 * ceiling Kanon fixes per lane at twice its limit.
 *
 * How many turns a job needs depends on the adopter's repository: an adopter's ~500-line brief
 * under revision ran the brief-revise lane to its 90-turn cap and pushed nothing, and the cap
 * error's advice, "raise `--max-turns`", needed a Kanon release. So every lane that runs a model
 * and has a dispatch trigger takes `max_turns` and `reason`, which only its caller's
 * `workflow_dispatch` inputs fill. Empty, the lane's own flags run as before. A whole number up
 * to the ceiling, on a dispatch, with a reason, replaces its `--max-turns` and the dollar cap
 * derived from it (`K-OBS-12`), and the run's summary records the raise and the reason.
 * Anything else is refused by `agent-run`'s turn-limit step, before any model call.
 */
const ROOT = process.cwd();
const WF = join(ROOT, '.github/workflows');
const read = (f: string) => readFileSync(join(WF, f), 'utf8');

const FLAGS = '--model claude-opus-5-5\n--effort high\n--max-turns 90\n--max-budget-usd 40\n--fallback-model claude-opus-5\n';
const RAISE = { claudeArgs: FLAGS, ceiling: '180', reason: 'one ruling touches the brief, five issues and six clauses', event: 'workflow_dispatch' };

describe('a turn limit raised for one dispatched run', () => {
  it('empty: the lane\'s flags run unchanged, at its own limit, whatever the event', () => {
    for (const event of ['workflow_dispatch', 'issues', 'schedule', '']) {
      expect(turnBudget({ ...RAISE, maxTurns: '', reason: '', event })).toMatchObject({ ok: true, claudeArgs: FLAGS, turns: 90, raised: false });
    }
    // A lane whose limit can't be raised (no ceiling) runs as it always did.
    expect(turnBudget({ claudeArgs: FLAGS })).toMatchObject({ ok: true, claudeArgs: FLAGS });
  });

  it('a whole number at or under the ceiling, dispatched with a reason, replaces the lane\'s --max-turns and its dollar cap', () => {
    const r = turnBudget({ ...RAISE, maxTurns: '150' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ turns: 150, raised: true });
    expect(r.claudeArgs).toBe(FLAGS.replace('--max-turns 90', '--max-turns 150').replace('--max-budget-usd 40', '--max-budget-usd 60'));
    expect(turnBudget({ ...RAISE, maxTurns: '180' })).toMatchObject({ ok: true, turns: 180 });
    expect(turnBudget({ ...RAISE, maxTurns: '1' })).toMatchObject({ ok: true, turns: 1 });
  });

  it('derives the dollar cap at $0.40 a turn, rounded up to the next $5 (K-OBS-12), as every lane\'s own flags do', () => {
    // Each pair is a lane's own limit and dollar cap, so the derivation is the one they use.
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
    const r = turnBudget({ ...RAISE, maxTurns: value });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^::error title=max_turns::/);
    expect(r.message).toMatch(message);
    expect(r.message).toContain('docs/lanes.md, "The turn budget"');
    expect('claudeArgs' in r).toBe(false);
  });

  it.each(['', '   ', '\n'])('refuses a raise without a reason (%j)', (reason) => {
    const r = turnBudget({ ...RAISE, maxTurns: '150', reason });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^::error title=max_turns::max_turns is 150, but the dispatch gives no reason/);
  });

  it.each(['issues', 'pull_request_review', 'schedule', 'workflow_run', ''])('refuses a raise on a run that was not dispatched (%j): it is never a standing setting', (event) => {
    const r = turnBudget({ ...RAISE, maxTurns: '150', event });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/max_turns is raised only for one dispatched run/);
  });

  it('refuses a value on a lane that gives no ceiling', () => {
    const r = turnBudget({ ...RAISE, maxTurns: '50', ceiling: '' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/this lane gives no ceiling for it/);
  });

  it('refuses a value when the lane\'s flags hold no single --max-turns to replace', () => {
    const r = turnBudget({ ...RAISE, claudeArgs: '--model x\n', maxTurns: '50' });
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

  it('summarises a raise on one line each, the reason kept to one line and its markup neutralised', () => {
    const s = raiseSummary({ turns: 150, own: 90, reason: 'line one\nline two `x` <b>|' });
    expect(s).toContain('### Turn limit raised for this run');
    expect(s).toContain("- **max_turns:** 150 (the lane's limit is 90), dollar cap $60");
    expect(s).toContain('- **Reason:** line one line two &#96;x&#96; &#60;b&#62;&#124;');
  });
});

describe('the script, as agent-run runs it', SPAWNS, () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const run = (maxTurns: string, { reason = RAISE.reason, event = 'workflow_dispatch' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-budget-'));
    dirs.push(dir);
    const out = join(dir, 'out');
    const summary = join(dir, 'summary');
    writeFileSync(out, '');
    writeFileSync(summary, '');
    const r = spawnSync('node', [join(ROOT, 'actions/agent-run/turn-budget.mjs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_ARGS: FLAGS, MAX_TURNS: maxTurns, MAX_TURNS_CEILING: '180', MAX_TURNS_REASON: reason, EVENT_NAME: event, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, written: readFileSync(out, 'utf8'), summary: readFileSync(summary, 'utf8') };
  };

  it('writes the lane\'s own flags when nothing was raised: the limit is unchanged, and the summary says nothing', () => {
    const r = run('', { reason: '', event: 'issues' });
    expect(r.status, r.out).toBe(0);
    expect(r.written).toMatch(/^max-turns=90\nclaude-args<<(EOF_[0-9a-f]+)\n([\s\S]*)\n\1\n$/);
    expect(/claude-args<<(EOF_[0-9a-f]+)\n([\s\S]*)\n\1\n$/.exec(r.written)![2]).toBe(FLAGS);
    expect(r.summary).toBe('');
  });

  it('writes the raised limit, and records it with its reason in the run\'s summary', () => {
    const r = run('120');
    expect(r.status, r.out).toBe(0);
    expect(r.written).toContain('max-turns=120\n');
    expect(r.written).toContain('--max-turns 120\n--max-budget-usd 50\n');
    expect(r.summary).toContain("max_turns:** 120 (the lane's limit is 90), dollar cap $50");
    expect(r.summary).toContain(`**Reason:** ${RAISE.reason}`);
  });

  it.each([
    ['above the ceiling', '181', {}],
    ['zero', '0', {}],
    ['negative', '-1', {}],
    ['not a number', 'abc', {}],
    ['without a reason', '120', { reason: '' }],
    ['on a run that was not dispatched', '120', { event: 'schedule' }],
  ])('fails %s and writes nothing', (_name, v, o) => {
    const r = run(v, o);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error title=max_turns::/);
    expect(r.written).toBe('');
    expect(r.summary).toBe('');
  });
});

describe('agent-run checks the limit before the agent, and runs the flags the check wrote', () => {
  type Step = { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string>; 'continue-on-error'?: unknown };
  const action = parse(readFileSync(join(ROOT, 'actions/agent-run/action.yml'), 'utf8')) as {
    inputs: Record<string, { default?: string }>; outputs: Record<string, { value: string }>; runs: { steps: Step[] };
  };
  const steps = action.runs.steps;

  it('takes max-turns, max-turns-ceiling and max-turns-reason, all empty by default', () => {
    for (const k of ['max-turns', 'max-turns-ceiling', 'max-turns-reason']) expect(action.inputs[k]?.default, k).toBe('');
  });

  it('checks it right after the start stamp, before the credential and the agent, in a step that may fail the block', () => {
    // The start stamp stays first, as the agent's lower bound (RA-1627); it cannot fail.
    const at = steps.findIndex((s) => s.id === 'turns');
    expect(at).toBe(1);
    expect(at).toBeLessThan(steps.findIndex((s) => s.id === 'credential'));
    const step = steps[at]!;
    expect(step.run).toBe('node "$GITHUB_ACTION_PATH/turn-budget.mjs"');
    expect(step['continue-on-error']).toBeUndefined();
    // Through `env:` only, never the run line (K-AGENT-45); the event is the caller's.
    expect(step.env).toEqual({
      CLAUDE_ARGS: '${{ inputs.claude_args }}',
      MAX_TURNS: '${{ inputs.max-turns }}',
      MAX_TURNS_CEILING: '${{ inputs.max-turns-ceiling }}',
      MAX_TURNS_REASON: '${{ inputs.max-turns-reason }}',
      EVENT_NAME: '${{ github.event_name }}',
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

// ─── every dispatchable model lane takes it ─────────────────────────────────────────────────
type Doc = { on?: { workflow_call?: { inputs?: Record<string, { type?: string; default?: unknown; description?: string; required?: boolean }> } }; jobs?: Record<string, Job> };
type Job = { uses?: string; with?: Record<string, unknown>; steps?: Array<{ uses?: string; with?: Record<string, unknown> }> };
const doc = (f: string) => parse(read(f)) as Doc;
const runsModel = (f: string) => laneTree(ROOT, f).some((t) => /uses: \$\/actions\/agent-run\s*$/m.test(read(t)) || /uses: \$\/\.github\/workflows\/agent-lane\.yml\s*$/m.test(read(t)));
const name = (f: string) => f.replace(/\.yml$/, '') as keyof typeof TRIGGERS;
const dispatchable = (f: string) => !(TRIGGERS[name(f)] as { deployRun?: boolean } | undefined)?.deployRun;
const MODEL_LANES = laneFiles(ROOT).filter(runsModel).filter(dispatchable);
const marker = (f: string) => {
  const m = /^# MAX TURNS: (\d+), at most (\d+)$/m.exec(read(f));
  return m ? { turns: Number(m[1]), ceiling: Number(m[2]) } : null;
};
const PASS = '${{ inputs.max_turns }}';
const REASON = '${{ inputs.reason }}';

describe('every model lane a person can dispatch takes max_turns and reason, at its own limit by default', () => {
  it('finds the lanes, so the cases below are not vacuous', () => {
    expect(MODEL_LANES.length).toBe(16);
    expect(MODEL_LANES).toContain('agent-lead-revise.yml');
  });

  it('the deploy-diagnose lane, which no one dispatches, takes neither: nothing can raise it', () => {
    const inputs = doc('agent-deploy-diagnose.yml').on?.workflow_call?.inputs ?? {};
    expect(Object.keys(inputs)).not.toContain('max_turns');
    expect(marker('agent-deploy-diagnose.yml')).toBeNull();
  });

  it.each(MODEL_LANES)('%s declares max_turns and reason, optional strings, empty by default', (f) => {
    for (const k of ['max_turns', 'reason']) {
      const input = doc(f).on?.workflow_call?.inputs?.[k];
      expect(input, `${f}: ${k}`).toMatchObject({ type: 'string', default: '', required: false });
    }
  });

  it.each(MODEL_LANES)('%s states its limit and ceiling, the ceiling twice the limit, and its input says the same', (f) => {
    const m = marker(f);
    expect(m, `${f}: no # MAX TURNS: line`).not.toBeNull();
    expect(m!.ceiling).toBe(2 * m!.turns);
    const description = String(doc(f).on?.workflow_call?.inputs?.max_turns?.description);
    expect(description).toContain(`from 1 to ${m!.ceiling}`);
    expect(description).toContain(`the lane's limit is ${m!.turns}`);
    expect(description).toContain('one dispatched run');
  });

  it.each(MODEL_LANES)('%s: every --max-turns its arms run is the stated limit, unchanged', (f) => {
    const caps = laneTree(ROOT, f).flatMap((t) => [...read(t).matchAll(/^\s*--max-turns\s+(\d+)\s*$/gm)].map((m) => Number(m[1])));
    expect(caps.length, f).toBeGreaterThan(0);
    expect(new Set(caps), f).toEqual(new Set([marker(f)!.turns]));
  });

  it.each(MODEL_LANES)('%s hands the dispatched value, its reason and the stated ceiling to every agent-run it reaches', (f) => {
    const { ceiling } = marker(f)!;
    let runs = 0;
    // The spine's own two files are held by the case after this one, once for every lane.
    for (const t of laneTree(ROOT, f).filter((x) => x !== 'agent-lane.yml' && x !== 'lane-agent-job.yml')) {
      const d = doc(t);
      for (const [id, job] of Object.entries(d.jobs ?? {})) {
        // Through the spine: the lane's call carries all three, and the spine hands them on.
        if (job.uses === '$/.github/workflows/agent-lane.yml') {
          runs++;
          expect(job.with?.['max-turns'], `${t}#${id}`).toBe(PASS);
          expect(job.with?.['max-turns-ceiling'], `${t}#${id}`).toBe(String(ceiling));
          expect(job.with?.['max-turns-reason'], `${t}#${id}`).toBe(REASON);
        }
        // Down the chain: each Kanon workflow the lane calls gets both passed through.
        if (job.uses?.startsWith('$/.github/workflows/') && job.uses !== '$/.github/workflows/agent-lane.yml') {
          expect(job.with?.max_turns, `${t}#${id} → ${job.uses}`).toBe(PASS);
          expect(job.with?.reason, `${t}#${id} → ${job.uses}`).toBe(REASON);
        }
        for (const s of job.steps ?? []) {
          if (s.uses === '$/actions/agent-run') {
            runs++;
            expect(s.with?.['max-turns'], `${t}#${id}`).toBe(PASS);
            expect(s.with?.['max-turns-ceiling'], `${t}#${id}`).toBe(String(ceiling));
            expect(s.with?.['max-turns-reason'], `${t}#${id}`).toBe(REASON);
          }
          if (s.uses === '$/actions/agent-finish') expect(s.with?.['claude-args-ran'], `${t}#${id}`).toBe('${{ steps.agent.outputs.claude-args }}');
        }
      }
    }
    expect(runs, f).toBe(1);
  });

  it('the spine hands all three to agent-run, and the flags that ran to agent-finish', () => {
    const lane = doc('agent-lane.yml');
    for (const k of ['max-turns', 'max-turns-ceiling', 'max-turns-reason']) expect(lane.on?.workflow_call?.inputs?.[k], k).toMatchObject({ type: 'string', default: '' });
    const pass = { 'max-turns': '${{ inputs.max-turns }}', 'max-turns-ceiling': '${{ inputs.max-turns-ceiling }}', 'max-turns-reason': '${{ inputs.max-turns-reason }}' };
    expect(lane.jobs?.run?.with).toMatchObject(pass);
    const steps = doc('lane-agent-job.yml').jobs!.run!.steps!;
    expect(steps.find((s) => s.uses === '$/actions/agent-run')?.with).toMatchObject(pass);
    expect(steps.find((s) => s.uses === '$/actions/agent-finish')?.with?.['claude-args-ran']).toBe('${{ steps.agent.outputs.claude-args }}');
  });

  it('agent-finish records the flags that ran, falling back to the lane\'s own', () => {
    const finish = readFileSync(join(ROOT, 'actions/agent-finish/action.yml'), 'utf8');
    expect(finish).toContain('claude_args: ${{ inputs.claude-args-ran || inputs.claude_args }}');
  });

  // kanon#1009. The turn-cap notice tells a person to re-dispatch with a higher `max_turns`, which
  // the deploy-diagnose lane can't take. The spine knows a lane takes it by its ceiling, and says
  // so down to the classifier, so that lane's notice names no re-dispatch.
  it('a lane with no ceiling, the deploy-diagnose lane, reaches the classifier as not raisable', () => {
    const diagnose = doc('agent-deploy-diagnose.yml').jobs?.diagnose;
    expect(diagnose?.uses).toBe('$/.github/workflows/agent-lane.yml');
    expect(diagnose?.with?.['max-turns-ceiling']).toBeUndefined();
    const steps = doc('lane-agent-job.yml').jobs!.run!.steps!;
    expect(steps.find((s) => s.uses === '$/actions/agent-finish')?.with?.raisable).toBe("${{ inputs.max-turns-ceiling != '' }}");
    const finish = parse(readFileSync(join(ROOT, 'actions/agent-finish/action.yml'), 'utf8'));
    expect(finish.inputs?.raisable?.default).toBe('true');
    const classify = (finish.runs.steps as { uses?: string; with?: Record<string, string> }[]).find((s) => s.uses === '$/actions/agent-classify');
    expect(classify?.with?.raisable).toBe('${{ inputs.raisable }}');
  });
});
