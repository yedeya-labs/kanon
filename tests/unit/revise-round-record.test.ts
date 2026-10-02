import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runWorkflowStep, type WorkflowStep } from './helpers/workflow-step.js';
import { writeStub } from './helpers/stub-bin.js';
import { callsSpine, laneBlockOf, readBlock, readSpine } from './helpers/spine.js';

/**
 * RA-1981 — a revise run that PUSHED is a round, whether or not the agent survived it.
 *
 * The round cap is `max(distinct patches faulted − 1, MARKED)`. MARKED counted only a
 * marker the agent writes as its last act, so a run that merged `main` (a push the
 * patch fingerprint normalises away) and then died advanced NEITHER count, and the
 * push re-fired review → revise with the cap never binding. Both revise workflows now
 * record the round themselves in that one case. These EXECUTE the shipped step.
 *
 * SINCE RA-2592 THE RECORD IS A JOB OF ITS OWN (`record-round`) in each lane: the agent
 * half calls the spine (`agent-lane.yml`), which takes no steps from its caller, and the
 * record names the lane's login and marker, which the spine must not. So "after the agent,
 * whatever it concluded" is now a job-level property — `needs` the agent job, `always()`
 * — and the outcome it reports crosses TWO boundaries: the spine's job output, then its
 * workflow output. Both are asserted, since either missing reports `unknown` forever.
 */
type Job = { steps: WorkflowStep[]; outputs?: Record<string, string>; needs?: string | string[]; if?: string; uses?: string };
type Wf = { jobs: { filter: Job; revise: Job; 'record-round': Job } & Record<string, Job> };
type Lane = {
  name: string;
  file: string;
  steps: (wf: Wf) => WorkflowStep[];
  login: string;
  /** The record step's variable holding the login, which the filter read from the App register. */
  loginVar: string;
  marker: string;
  filterRun: (wf: Wf) => string;
  gate: string;
};
// The same gate on both lanes since RA-2592: `always()` so a crashed, timed-out or cancelled
// agent job still records, and the filter's `act` so a declined review records nothing.
const GATE = "always() && needs.filter.outputs.act == 'true'";
const filterRunOf = (wf: Wf) => wf.jobs.filter.steps.find((s: WorkflowStep) => s.id === 'filter')?.run ?? '';
const LANES: Lane[] = [
  {
    name: 'implementer',
    file: '.github/workflows/agent-implement-revise.yml',
    steps: (wf) => wf.jobs['record-round'].steps,
    login: 'example-implementer',
    loginVar: 'IMPL_LOGIN',
    marker: '<!-- qa:implement-revise -->',
    filterRun: filterRunOf,
    gate: GATE,
  },
  {
    name: 'lead',
    file: '.github/workflows/agent-lead-revise.yml',
    steps: (wf) => wf.jobs['record-round'].steps,
    login: 'example-lead',
    loginVar: 'LEAD_LOGIN',
    marker: '<!-- qa:lead-revise -->',
    filterRun: filterRunOf,
    gate: GATE,
  },
];

const GH_STUB = `#!/usr/bin/env bash
# \`gh pr view … --json headRefOid,comments\` answers from STUB_STATE (or fails when it
# is unset); \`gh pr comment … --body X\` appends X to the log the test reads.
if [ "$1 $2" = "pr view" ]; then
  [ -n "\${STUB_STATE:-}" ] || { echo "HTTP 502" >&2; exit 1; }
  printf '%s' "$STUB_STATE"; exit 0
fi
if [ "$1 $2" = "pr comment" ]; then
  while [ $# -gt 0 ]; do [ "$1" = "--body" ] && { printf '%s\\n<<END>>\\n' "$2" >> "$COMMENT_LOG"; }; shift; done
  exit 0
fi
echo "unexpected gh call: $*" >&2; exit 3
`;

const BEFORE = 'b'.repeat(40);
const AFTER = 'a'.repeat(40);

for (const lane of LANES) {
  const wf = parse(readFileSync(join(process.cwd(), lane.file), 'utf8')) as Wf;
  const steps = lane.steps(wf);
  const idx = steps.findIndex((s) => s.name?.startsWith('Record the round'));
  const record = steps[idx]!;
  const run = ({ head = AFTER, comments = [] as { author: { login: string }; body: string }[],
    marked = '0', before = BEFORE, readable = true } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'round-record-'));
    writeStub(join(dir, 'gh'), GH_STUB);
    const log = join(dir, 'comments.log');
    const env = { ...(record as { env: Record<string, string> }).env };
    const r = runWorkflowStep(record, {
      dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 'x', REPO: 'example-org/example-repo', PR: '1822',
        ...Object.fromEntries(Object.entries(env).filter(([, v]) => !String(v).includes('${{'))),
        [lane.loginVar]: lane.login,
        BEFORE_SHA: before, BEFORE_MARKED: marked, OUTCOME: 'failure',
        RUN_URL: 'https://github.com/example-org/example-repo/actions/runs/1',
        STUB_STATE: readable ? JSON.stringify({ headRefOid: head, comments }) : '',
        COMMENT_LOG: log,
      },
    });
    const posted = existsSync(log) ? readFileSync(log, 'utf8').split('<<END>>\n').filter(Boolean) : [];
    return { ...r, posted };
  };

  describe(`the ${lane.name} lane records a round the agent did not (RA-1981)`, () => {
    it('exists, after the agent, and runs whatever the agent concluded', () => {
      expect(record, 'the step is missing').toBeDefined();
      const job = wf.jobs['record-round'];
      // After the agent: the job waits for the job that calls the spine.
      expect(callsSpine(wf.jobs.revise)).toBe(true);
      expect([job.needs].flat()).toEqual(expect.arrayContaining(['filter', 'revise']));
      // A crash, a timeout or a cancel is exactly the run this is for — `always()`, on
      // the JOB, so a failed agent job does not skip it.
      expect(job.if).toBe(lane.gate);
      expect(record.if, 'gated once, on the job').toBeUndefined();
    });

    it('reports the agent STEP outcome, through both boundaries (RA-2592)', () => {
      const env = (record as { env: Record<string, string> }).env;
      expect(env.OUTCOME).toBe('${{ needs.revise.outputs.outcome }}');
      const spine = readSpine();
      expect(spine.on.workflow_call.outputs.outcome?.value).toBe('${{ jobs.run.outputs.outcome }}');
      expect(spine.jobs.run.outputs?.outcome).toBe('${{ steps.agent.outcome }}');
      // …and `agent` IS the step running the agent, not whatever happens to hold the id.
      // Since RA-2666 that is the `agent-run` block's CALL, whose outcome is the block's —
      // failure if any step inside failed. So the block's outcome is the action's only
      // while nothing else in it can fail on its own, which is asserted rather than
      // assumed: the action is its LAST step (nothing after a green action can red the
      // block), and every step before it either swallows its failure or is the one named
      // no-model step whose failure means the agent never started (the second, the revert
      // of loaded blocks, went with the `./` block references in RA-2697). Another fallible
      // step before the agent must be added to that list on purpose.
      const agent = (spine.jobs.run.steps ?? []).find((s) => s.id === 'agent');
      const block = laneBlockOf(agent);
      expect(block, 'the step with id `agent` must call a lane block').toBe('agent-run');
      const inner = readBlock(String(block)).runs.steps;
      const action = inner.findIndex((s) => /claude-code-action/.test(String(s.uses)));
      expect(action, 'the block runs no claude-code-action step').toBeGreaterThan(-1);
      expect(inner.filter((s) => /claude-code-action/.test(String(s.uses))), 'exactly one agent step').toHaveLength(1);
      expect(action, 'a step after the action could red a green agent run').toBe(inner.length - 1);
      const fallible = inner.slice(0, action).filter((s) => s['continue-on-error'] !== true).map((s) => s.name);
      expect(fallible).toEqual(['Record when the agent started']);
    });

    it('posts the marker when the run PUSHED and left none — the RA-1981 cycle', () => {
      const r = run({ head: AFTER, comments: [], marked: '0' });
      expect(r.status, r.output).toBe(0);
      expect(r.posted).toHaveLength(1);
      expect(r.posted[0]).toContain(lane.marker);
      // It says what it is: a stand-in, not the agent's reply.
      expect(r.posted[0]).toMatch(/not\*\* .*answer to the review/);
    });

    it('posts nothing when the head did not move — no push, no re-review, no loop', () => {
      // And a quota-capped run that never started must not spend the developer's rounds.
      const r = run({ head: BEFORE });
      expect(r.status, r.output).toBe(0);
      expect(r.posted).toEqual([]);
    });

    it('posts nothing when the agent left its own marker during the run', () => {
      const r = run({ marked: '1', comments: [
        { author: { login: lane.login }, body: `earlier\n${lane.marker}` },
        { author: { login: `app/${lane.login}` }, body: `this round\n${lane.marker}` },
      ] });
      expect(r.status, r.output).toBe(0);
      expect(r.posted).toEqual([]);
    });

    it('does not mistake SOMEONE ELSE quoting the marker for the agent\'s reply', () => {
      const r = run({ comments: [{ author: { login: 'a-developer' }, body: `about ${lane.marker}` }] });
      expect(r.posted).toHaveLength(1);
    });

    it('treats an unknown starting head as moved — the cap over-counts, never under', () => {
      const r = run({ before: '', head: AFTER });
      expect(r.posted).toHaveLength(1);
    });

    it('fails LOUD when it cannot read the PR, rather than skipping the record', () => {
      const r = run({ readable: false });
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/UNRECORDED/);
      expect(r.posted).toEqual([]);
    });

    it('writes the exact marker the round count reads, under the identity it filters on', () => {
      // The count is author-filtered, so the stand-in must be posted by the lane's own
      // App (a fresh token — the agent step can outlive the first) and carry the same
      // marker string the filter's `contains()` looks for.
      expect(lane.filterRun(wf)).toContain(`contains(\\"${lane.marker}\\")`);
      expect((record as { env: Record<string, string> }).env.MARKER).toBe(lane.marker);
      // The login is the one the FILTER read from the App register (plan 0001 §5), handed
      // across the job boundary, so the record and the count cannot filter on two logins.
      expect((record as { env: Record<string, string> }).env[lane.loginVar]).toBe('${{ needs.filter.outputs.login }}');
      expect(wf.jobs.filter.outputs?.login).toBe('${{ steps.filter.outputs.login }}');
      expect(lane.filterRun(wf)).toContain(`echo "login=$${lane.loginVar}" >> "$GITHUB_OUTPUT"`);
      expect((record as { env: Record<string, string> }).env.GH_TOKEN).toBe('${{ steps.round-app-token.outputs.token }}');
      const mint = steps.find((s) => (s as { id?: string }).id === 'round-app-token');
      expect(mint?.uses).toMatch(/create-github-app-token/);
      // Before the record, in the same job — the job's gate covers both.
      expect(steps.indexOf(mint!)).toBeLessThan(idx);
      expect(mint?.if).toBeUndefined();
      // THE SAME APP the agent ran as. The count filters on the login, so a record minted
      // from another App's secret posts a marker the count never sees. Pinned against the
      // secret the lane hands the spine, rather than a literal, so the two cannot drift
      // apart (RA-2592 mutation-check: this was unguarded before the move, too).
      const lane_ = wf.jobs.revise as unknown as { secrets: Record<string, string> };
      expect((mint as { with?: Record<string, string> }).with?.['client-id']).toBe(lane_.secrets['app-id']);
      expect((mint as { with?: Record<string, string> }).with?.['private-key']).toBe(lane_.secrets['app-private-key']);
    });

    it('compares against the head and marker count the FILTER read', () => {
      const run = lane.filterRun(wf);
      expect(run).toContain('echo "head_sha=$HEAD_SHA" >> "$GITHUB_OUTPUT"');
      expect(run).toContain('echo "marked=$MARKED" >> "$GITHUB_OUTPUT"');
      const env = (record as { env: Record<string, string> }).env;
      expect(env.BEFORE_SHA).toMatch(/filter\.outputs\.head_sha/);
      expect(env.BEFORE_MARKED).toMatch(/filter\.outputs\.marked/);
      // Crosses a job boundary on both lanes since RA-2592, so the job must re-export them.
      expect(wf.jobs.filter.outputs?.head_sha).toBe('${{ steps.filter.outputs.head_sha }}');
      expect(wf.jobs.filter.outputs?.marked).toBe('${{ steps.filter.outputs.marked }}');
    });
  });
}
