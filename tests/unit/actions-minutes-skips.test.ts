import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIGGERS } from '../../cli/callers.mjs';
import { parseYaml } from '../../cli/workflow-yaml.mjs';

/**
 * kanon#837: the "Its short and skipped runs" column of docs/actions-minutes.md's lane table says,
 * in prose, which runs of each lane end early. What decides that is the lane's own jobs: the
 * filter or gate job's `if:`, which skips a run outright (nothing billed), and the outputs later
 * jobs test, which end a run after a short filter job. This test reads those jobs and holds each
 * row to them:
 *
 *   - a lane that runs no model (no Claude credential in its jobs) says "None: it runs no model",
 *     and a lane that runs one doesn't;
 *   - a lane whose filter runs only on a dispatch says "None: it runs only when you dispatch it";
 *   - every label a lane's jobs compare (`github.event.label.name == '…'`) is named in its row, and
 *     the row names no label they don't compare;
 *   - "(skipped, nothing billed)" appears exactly when the first job's `if:` skips some run: it
 *     compares a label, or tests a condition SKIPS below ties to the row;
 *   - every output of a filter or gate that a lane's jobs test is in SKIPS, with the words the row
 *     uses for the runs it ends, or `null` and why it ends no run early; a new one turns this red;
 *   - a model lane that skips nothing by any of the above says "None to speak of".
 *
 * WHAT IT DOESN'T HOLD: the words between those anchors. A row can name the right label and
 * output and still describe them loosely; that stays a reviewer's read. A lane that runs no model
 * is held only to its "runs no model" line: every run of it is short, whatever it skips.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** Outputs every lane's gate has, which end no run in a way the column describes. */
const PLUMBING = new Set([
  // The gate's check that the run is in a repository set up for the lane; off, every job skips.
  'member',
  // A re-run's guard: the later job runs only on the attempt that made its input.
  'attempt',
]);

const NO_MODEL = 'None: it runs no model, so every run is short';
const DISPATCH_ONLY = 'None: it runs only when you dispatch it';
const NOTHING = 'None to speak of';
const SKIPPED = '(skipped, nothing billed)';

type Spec = {
  /** Each tested output: the phrases the row uses for the runs it ends, or null when it ends none early. */
  outputs?: Record<string, string[] | null>;
  /** Conditions in the first job's `if:`, besides a label, that skip a run the row words. */
  skipped?: string[];
};

/** The lanes whose rows rest on more than labels and the model. */
const SKIPS: Record<string, Spec> = {
  'agent-review': { outputs: { review: ['a head with no review label', 'a head already reviewed'] } },
  'agent-merge-reconcile': {
    outputs: { run: ['whose latest verdict declares nothing open'] },
    skipped: ["github.event.pull_request.state != 'open'", 'github.event.pull_request.merged == true'],
  },
  // `empty` is read after the model run, by the crash recovery.
  'agent-implement': { outputs: { empty: null } },
  // `mode`, `fix` and `changed` choose the fix jobs over the model on a hand-back (kanon#1173), and
  // end no run early by themselves; a push by them does, as the model then doesn't run.
  'agent-implement-revise': {
    outputs: {
      act: ["a review that doesn't request changes", "isn't the Implementer's", 'a round past its cap'],
      mode: null,
      fix: null,
      changed: null,
      pushed: ['a hand-back whose failed checks all have a fix command Kanon knows'],
    },
  },
  // `summary-artifact` is read after the model run, to store its summary.
  'agent-explore': { outputs: { sweep: ['a commit the QA store already holds a green sweep of'], 'summary-artifact': null } },
  'agent-explore-telemetry': {
    outputs: {
      configured: ['no aggregate function configured', 'a dispatch from a branch other than the default'],
      empty: ['an aggregate with no cell and no signal'],
    },
  },
  'agent-lead-revise': {
    outputs: { act: ["isn't the Lead's brief", 'a round past its cap'] },
    skipped: ["github.event.review.state == 'changes_requested'"],
  },
  // `reader` skips only the telemetry read; the Overseer still runs.
  'agent-overseer': { outputs: { due: ["doesn't move the agent runtime forward"], reader: null } },
  // Plan 0011 N7: the gate's `post` skips the digest job, and its model, without both the hook and
  // the kind's secret; `hook` starts the notify job, which records a skip and bills next to nothing.
  'agent-project-digest': { outputs: { post: ['without both the notify hook and `KANON_CHAT_PROJECT_DIGEST`', 'runs only the health job'], hook: null } },
  'agent-rebase': { outputs: { prs: ['finds no agent pull request in conflict'] } },
  // Plan 0011 N8: `narrate` skips the digest job and its model when nothing would be posted;
  // `hook` starts the notify job, which runs no model, so it ends no run early on its own.
  'agent-weekly-digest': { outputs: { narrate: ['no notify hook', 'no `KANON_CHAT_WEEKLY_DIGEST`'], hook: null } },
  // Plan 0010 D8: its caller fires on every conclusion, and its gate admits a failure alone.
  'agent-deploy-diagnose': {
    outputs: { issues: ['a failed run that filed no issue'] },
    skipped: ["github.event.workflow_run.conclusion == 'failure'"],
  },
};

type Lane = { cell: string; text: string; jobs: Record<string, { if?: unknown }> };

const flat = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const ifs = (lane: Lane) => Object.values(lane.jobs).map((j) => flat(j.if));
const firstIf = (lane: Lane) => flat(Object.values(lane.jobs)[0]?.if);
const labelsIn = (s: string) => [...s.matchAll(/github\.event\.label\.name == '([^']+)'/g)].map((m) => m[1]!);
const outputsIn = (s: string) => [...s.matchAll(/needs\.[\w-]+\.outputs\.([\w-]+)/g)].map((m) => m[1]!);

/** What is wrong with a lane's row, given its jobs; empty when the row holds. */
const problems = (name: string, lane: Lane, spec: Spec = SKIPS[name] ?? {}): string[] => {
  const out: string[] = [];
  const { cell } = lane;
  const lower = cell.toLowerCase();

  if (!lane.text.includes('secrets.CLAUDE_CODE_OAUTH_TOKEN')) {
    if (cell !== NO_MODEL) out.push(`runs no model, so the row must read "${NO_MODEL}"`);
    return out;
  }
  if (cell.startsWith('None: it runs no model')) out.push('runs a model, but the row says it runs none');

  const dispatchOnly = firstIf(lane) === "github.event_name == 'workflow_dispatch'";
  if (dispatchOnly !== (cell === DISPATCH_ONLY)) {
    out.push(dispatchOnly ? `runs only on a dispatch, so the row must read "${DISPATCH_ONLY}"` : 'runs on more than a dispatch, but the row says it runs only on one');
  }

  const labels = new Set(ifs(lane).flatMap(labelsIn));
  for (const l of labels) if (!cell.includes(`\`${l}\``)) out.push(`its jobs compare the label ${l}, which the row doesn't name`);
  for (const m of cell.matchAll(/`([a-z]+:[a-z-]+)`/g)) {
    if (!labels.has(m[1]!)) out.push(`the row names the label ${m[1]}, which its jobs don't compare`);
  }

  const tested = [...new Set(ifs(lane).flatMap(outputsIn))].filter((o) => !PLUMBING.has(o)).sort();
  const known = Object.keys(spec.outputs ?? {}).sort();
  if (tested.join() !== known.join()) out.push(`its jobs test the outputs [${tested}], SKIPS ties [${known}] to the row`);
  for (const [o, phrases] of Object.entries(spec.outputs ?? {})) {
    for (const p of phrases ?? []) if (!lower.includes(p.toLowerCase())) out.push(`the row doesn't say "${p}" for the output ${o}`);
  }

  const first = firstIf(lane);
  for (const c of spec.skipped ?? []) if (!first.includes(c)) out.push(`the first job's if: no longer tests ${c}`);
  const skips = labelsIn(first).length > 0 || (spec.skipped ?? []).length > 0;
  if (skips !== cell.includes(SKIPPED)) {
    out.push(skips ? `its first job skips some runs, so the row must say "${SKIPPED}"` : `its first job skips no run, but the row says "${SKIPPED}"`);
  }

  const phrased = Object.values(spec.outputs ?? {}).some((p) => p !== null);
  const nothing = !dispatchOnly && labels.size === 0 && !phrased && !skips;
  if (nothing !== (cell === NOTHING)) {
    out.push(nothing ? `skips nothing, so the row must read "${NOTHING}"` : `skips some runs, but the row reads "${NOTHING}"`);
  }
  return out;
};

const cells = (): Map<string, string> => {
  const doc = readFileSync(join(ROOT, 'docs/actions-minutes.md'), 'utf8');
  const section = doc.split('\n## What starts each lane\n')[1]!.split('\n## ')[0]!;
  return new Map([...section.matchAll(/^\| `(agent-[a-z-]+)` \| [^|]+ \| ([^|]+) \|/gm)].map((m) => [m[1]!, m[2]!.trim()]));
};

const table = cells();
const lane = (name: string): Lane => {
  const text = readFileSync(join(ROOT, '.github/workflows', `${name}.yml`), 'utf8');
  const wf = parseYaml(text) as { jobs: Lane['jobs'] };
  const cell = table.get(name);
  if (cell === undefined) throw new Error(`docs/actions-minutes.md has no row for ${name}: the anchor moved`);
  return { cell, text, jobs: wf.jobs };
};

/** A copy of a lane with one job's `if:` rewritten. */
const withIf = (l: Lane, job: string, f: (s: string) => string): Lane => {
  if (!l.jobs[job]) throw new Error(`no job ${job}: the mutation would pass for the wrong reason`);
  return { ...l, jobs: { ...l.jobs, [job]: { ...l.jobs[job], if: f(flat(l.jobs[job].if)) } } };
};

/** A copy of a lane with every job's `if:` rewritten. */
const withIfs = (l: Lane, f: (s: string) => string): Lane => ({
  ...l,
  jobs: Object.fromEntries(Object.entries(l.jobs).map(([k, j]) => [k, { ...j, if: f(flat(j.if)) }])),
});

/** A mutation turns the row red, for the reason given. */
const red = (name: string, l: Lane, why: RegExp) => expect(problems(name, l)).toContainEqual(expect.stringMatching(why));

describe(`docs/actions-minutes.md's "Its short and skipped runs" column is the lanes' filter jobs (kanon#837)`, () => {
  it('has a row for every lane, and a SKIPS entry only for a lane', () => {
    expect([...table.keys()].sort()).toEqual(Object.keys(TRIGGERS).sort());
    for (const name of Object.keys(SKIPS)) expect(table.has(name), name).toBe(true);
  });

  it.each(Object.keys(TRIGGERS))("%s's row says what its jobs skip", (name) => {
    expect(problems(name, lane(name))).toEqual([]);
  });

  describe('the mutations: each goes red, for its reason', () => {
    it('a label the filter compares, taken out of the row or changed in the filter, or one it doesn\'t, added to the row', () => {
      const triage = lane('agent-triage');
      red('agent-triage', { ...triage, cell: triage.cell.replace('`qa:needs-triage`', 'its own') }, /compare the label qa:needs-triage, which the row doesn't name/);
      red('agent-triage', withIf(triage, 'filter', (s) => s.replace('qa:needs-triage', 'qa:triage')), /names the label qa:needs-triage, which its jobs don't compare/);
      const extra = { ...triage, cell: triage.cell.replace('`qa:needs-triage`', '`qa:needs-triage` or `qa:verify`') };
      expect(problems('agent-triage', extra)).toEqual(["the row names the label qa:verify, which its jobs don't compare"]);
      const review = lane('agent-review');
      red('agent-review', { ...review, cell: review.cell.replace(', `agent:reviewer` among them', '') }, /label agent:reviewer, which the row doesn't name/);
    });

    it('a model run gained or lost, with the row not following', () => {
      const merge = lane('agent-merge');
      red('agent-merge', { ...merge, text: `${merge.text}\n# secrets.CLAUDE_CODE_OAUTH_TOKEN` }, /runs a model, but the row says it runs none/);
      const implement = lane('agent-implement');
      red('agent-implement', { ...implement, text: implement.text.replaceAll('secrets.CLAUDE_CODE_OAUTH_TOKEN', 'secrets.X') }, /runs no model/);
    });

    it('a filter output a later job starts or stops testing, or a phrase for one dropped from the row', () => {
      const audit = lane('agent-code-audit');
      red('agent-code-audit', withIf(audit, 'export', (s) => `${s} && needs.gate.outputs.due == 'true'`), /test the outputs \[due\], SKIPS ties \[\]/);
      const telemetry = lane('agent-explore-telemetry');
      red('agent-explore-telemetry', { ...telemetry, cell: telemetry.cell.replace('no aggregate function configured, or ', '') }, /doesn't say "no aggregate function configured"/);
      const rebase = lane('agent-rebase');
      red('agent-rebase', withIfs(rebase, (s) => s.replace("needs.filter.outputs.prs != '[]'", 'true')), /test the outputs \[\], SKIPS ties \[prs\]/);
    });

    it('"(skipped, nothing billed)" without a skipping filter, or a skip the row stops saying', () => {
      const reconcile = lane('agent-merge-reconcile');
      red('agent-merge-reconcile', withIf(reconcile, 'filter', (s) => s.replace('github.event.pull_request.merged == true', 'true')), /no longer tests github.event.pull_request.merged/);
      red('agent-merge-reconcile', { ...reconcile, cell: reconcile.cell.replace(` ${SKIPPED}`, '') }, /skips some runs, so the row must say/);
      const triage = lane('agent-triage');
      const unlabelled = withIfs(triage, (s) => s.replace("github.event.label.name == 'qa:needs-triage'", "contains(github.event.issue.labels.*.name, 'qa:triage')"));
      red('agent-triage', { ...unlabelled, cell: unlabelled.cell.replace('`qa:needs-triage`', 'its own') }, /skips no run, but the row says/);
    });

    it('"None to speak of" on a lane that skips, or missing on one that skips nothing; a dispatch-only lane that gains a trigger', () => {
      const audit = lane('agent-code-audit');
      red('agent-code-audit', withIf(audit, 'gate', (s) => `${s} || github.event.label.name == 'qa:audit'`), /skips some runs, but the row reads/);
      // The weekly digest's row names its gate's decision (plan 0011 N8); dropped, it is red.
      const weekly = lane('agent-weekly-digest');
      red('agent-weekly-digest', { ...weekly, cell: NOTHING }, /skips some runs, but the row reads/);
      red('agent-weekly-digest', { ...weekly, cell: weekly.cell.replace('No notify hook', 'No hook') }, /doesn't say "no notify hook"/);
      red('agent-code-audit', { ...audit, cell: 'A commit already audited' }, /skips nothing, so the row must read "None to speak of"/);
      const lead = lane('agent-lead');
      red('agent-lead', withIf(lead, 'filter', (s) => `${s} || github.event_name == 'schedule'`), /runs on more than a dispatch/);
      red('agent-lead', { ...lead, cell: NOTHING }, /runs only on a dispatch, so the row must read/);
    });
  });
});
