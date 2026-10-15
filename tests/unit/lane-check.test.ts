import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { actionFiles } from './helpers/actions.js';
import { ROOT, SCRIPT, TRIAGE, IMPL, adopter, check, red, job, type Caller, type Tree, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the fixture whole, Kanon's own tree, and what a calling job
 * holds and passes.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  it('passes Kanon itself, its seventeen lane callers on the Author and the Judge (ADR 0011)', () => {
    // In this tree, not a copy: Kanon is its own adopter. CI runs the RELEASED action on it, at
    // the version its callers pin; this run reads the lanes as this PR leaves them, so a lane
    // change that would break Kanon's caller is red here before it is released. Since plan
    // 0005's L5 the callers map the Author's and the Judge's secrets, and the register names
    // one slug per App. The fifth is the Overseer's, since kanon#423, the sixth the rebase
    // lane's, since kanon#448, and the seventh the telemetry Explorer's, since kanon#443. The other
    // nine are the rest of the full pipeline, since ADR 0011's amendment of 2026-10-12: triage,
    // the dispatch sweep, merge reconcile, the Lead's four lanes, verify-acs and the Merger. The
    // seventeenth is the daily project digest, since kanon#813, for its health job.
    //
    // ONE CALLER IS CHECKED AS ITS PIN MOVE WILL WRITE IT. Plan 0011's N7 moved the project digest
    // behind the notify job and dropped `DIGEST_WEBHOOK` from the lane (decision 17), but Kanon's
    // `project-digest.yml` pins a release before N7, whose lane still declares it: mapping the new
    // secret now would stop that caller at its pinned release. It changes its mapping in the pull
    // request that moves its pin to N7's release (plan 0011 §5.2), so until then this run reads a
    // copy of Kanon's tree with that one line as that pull request writes it, and the line is
    // held to a pinned release, never `$/`, which would call the moved lane.
    const legacy = '      DIGEST_WEBHOOK: ${{ secrets.DIGEST_WEBHOOK }}\n';
    const caller = readFileSync(join(ROOT, '.github/workflows/project-digest.yml'), 'utf8');
    let cwd = ROOT;
    if (caller.includes(legacy)) {
      expect(caller).toMatch(/uses: yedeya-labs\/kanon\/\.github\/workflows\/agent-project-digest\.yml@v\d+\.\d+\.\d+\n/);
      cwd = mkdtempSync(join(tmpdir(), 'kanon-self-'));
      // The lane-check script too: it is how lane-check knows the tree is Kanon's (`KANON_TREE`).
      for (const d of ['.github', 'docs', 'actions/lane-check']) cpSync(join(ROOT, d), join(cwd, d), { recursive: true });
      writeFileSync(join(cwd, '.github/workflows/project-digest.yml'), caller.replace(legacy, '      KANON_CHAT_PROJECT_DIGEST: ${{ secrets.KANON_CHAT_PROJECT_DIGEST }}\n'));
    }
    const r = spawnSync('bash', [SCRIPT], { cwd, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('17 lane caller(s) pass');
    // One lane-check run over Kanon's whole tree: under a loaded full run it outlasted the 5s
    // default once, as the three-run test below did.
  }, 30_000);

  it('passes the fixture adopter whole, and counts its four callers', () => {
    const r = check(adopter());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('4 lane caller(s) pass');
  });

  describe('a caller holds only its triggers, permissions and one job', () => {
    it('refuses a workflow-level env', () => red((t) => t.edit(TRIAGE, (d) => { d.env = { X: '1' }; }), 'it also has: env'));
    it('refuses concurrency on the caller, which the lane holds (decision 11)', () =>
      red((t) => t.edit(TRIAGE, (d) => { d.concurrency = { group: 'x' }; }), 'it also has: concurrency'));
    it('refuses concurrency on the calling job too', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).concurrency = 'x'; }), 'the calling job holds only uses, with, secrets and permissions; it also has: concurrency'));
    it('refuses a second job', () =>
      red((t) => t.edit(TRIAGE, (d) => { (d as Caller).jobs.more = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] }; }), 'exactly one job, not 2'));
    it('refuses a job-level `if`, which is the lane\'s admission rule', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).if = 'true'; }), 'it also has: if'));
  });

  describe('the calling job passes only its own inputs through', () => {
    it('refuses a literal value, which would be a setting (ADR 0002)', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '12' }; }), 'a caller only passes its own input through'));
    it('refuses another input\'s value', () =>
      red((t) => t.edit(IMPL, (d) => { job(d).with = { pr_number: '${{ inputs.reset }}', reset: '${{ inputs.reset }}' }; }), 'passes `pr_number: ${{ inputs.reset }}`'));
    it('refuses the smoke-only `smoke` input, though every lane declares it (kanon#321)', () => {
      const r = red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '${{ inputs.issue_number }}', smoke: '${{ inputs.smoke }}' }; }),
        "passes `smoke`, which only Kanon's lanes smoke sets");
      expect(r.out).toContain('docs/lanes.md');
    });
    it('refuses an input the lane does not declare', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '${{ inputs.issue_number }}', bogus: '${{ inputs.bogus }}' }; }), 'passes `bogus`, which the Kanon lane agent-triage does not declare'));
  });

  // kanon#891, as the Owner shaped it on 2026-10-15: the turn limit is raised only for one
  // dispatched run, so a caller passes its own dispatch inputs through and never a number.
  describe('the calling job passes a raised turn limit only through from its dispatch', () => {
    const withTurns = (extra: Record<string, unknown>) => (t: Tree) => t.edit(TRIAGE, (d) => { job(d).with = { issue_number: '${{ inputs.issue_number }}', ...extra }; });
    it('passes max_turns and reason, each its own dispatch input passed through', () => {
      const t = adopter();
      withTurns({ max_turns: '${{ inputs.max_turns }}', reason: '${{ inputs.reason }}' })(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
    it.each([[150], ['150'], [1], ['${{ inputs.issue_number }}']])('refuses max_turns: %s, which is no dispatch passthrough: never a standing setting', (v) => {
      red(withTurns({ max_turns: v, reason: '${{ inputs.reason }}' }), 'the turn limit is raised only for one dispatched run, never set in a caller');
    });
    it('refuses max_turns passed through without its reason', () => {
      red(withTurns({ max_turns: '${{ inputs.max_turns }}' }), 'passes `max_turns` without `reason`; a raised turn limit needs a reason');
    });
    it('refuses a literal reason, like any other setting', () => {
      red(withTurns({ max_turns: '${{ inputs.max_turns }}', reason: 'because' }), 'passes `reason: because`; a caller only passes its own input through');
    });
  });
});

describe('the lane-check action', () => {
  const action = parse(readFileSync(join(ROOT, 'actions/lane-check/action.yml'), 'utf8')) as {
    inputs?: unknown;
    runs: { using: string; steps: { run?: string; env?: Record<string, string> }[] };
  };

  it('takes no inputs: what a lane needs is read from the lane (ADR 0002)', () => {
    expect(action.inputs).toBeUndefined();
  });

  it('runs its script from its own directory, at the version it was called at', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toHaveLength(2);
    expect(action.runs.steps[1]?.run).toBe('bash "$GITHUB_ACTION_PATH/lane-check.sh"');
    expect(action.runs.steps[1]?.env).toEqual({ ACTION_REF: '${{ github.action_ref }}' });
  });

  it("puts Kanon's own Node on the PATH first, for the library's readers (kanon#110, kanon#153)", () => {
    expect((action.runs.steps[0] as { uses?: string }).uses).toBe('$/actions/kanon-path');
  });

  it('the agents smoke runs it on the fixture adopter, through `$/`', () => {
    const smoke = parse(readFileSync(join(ROOT, '.github/workflows/agent-lanes-smoke.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: { uses?: string; run?: string }[] }>;
    };
    const steps = smoke.jobs.smoke?.steps ?? [];
    expect(steps.map((s) => s.uses).filter(Boolean)).toEqual(['actions/checkout@v7', '$/actions/kanon-path', '$/actions/lane-check']);
    expect(steps.some((s) => s.run?.includes('cp -R tests/fixtures/lane-check/adopter/. .'))).toBe(true);
  });
});

describe('every copy of the App-register parser is the parser (kanon#401)', () => {
  // The review lane and the two revise lanes carry `actions/lane-check/app-register.awk` verbatim
  // as a `REGISTER_AWK` env, and the file and each copy say this test holds them to it. A copy
  // that drifts reads a role's login with a parser `lane-check` and the CLI don't use. The
  // copies are found by reading the tree, not by naming the lanes, so one added later is held too.
  const AWK = readFileSync(join(ROOT, 'actions/lane-check/app-register.awk'), 'utf8');
  type Env = Record<string, unknown> | undefined;
  type Step = { name?: string; id?: string; env?: Env };
  type Doc = { env?: Env; jobs?: Record<string, { env?: Env; steps?: Step[] }>; runs?: { steps?: Step[] } };
  const files = [
    ...readdirSync(join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`),
    // Every action, nested ones too (kanon#927).
    ...actionFiles(ROOT),
  ];
  const read = files.map((file) => {
    const raw = readFileSync(join(ROOT, file), 'utf8');
    const doc = parse(raw) as Doc;
    const envs: Array<[string, Env]> = [
      ['(top level)', doc.env],
      ...Object.entries(doc.jobs ?? {}).flatMap(([jn, j]): Array<[string, Env]> =>
        [[jn, j.env], ...(j.steps ?? []).map((s): [string, Env] => [`${jn}: ${s.name ?? s.id ?? '?'}`, s.env])]),
      ...(doc.runs?.steps ?? []).map((s): [string, Env] => [s.name ?? s.id ?? '?', s.env]),
    ];
    const copies = envs.filter(([, env]) => env && 'REGISTER_AWK' in env).map(([where, env]) => ({ where, text: env!.REGISTER_AWK }));
    // The parser's own first function, wherever it appears in the file's text.
    return { file, copies, mentions: raw.split('function unbold(s)').length - 1 };
  });

  it('finds the copies the lanes carry', () => {
    // It reads every action, nested ones too (kanon#927), where a copy would hide as well.
    expect(read.map((r) => r.file)).toContain('actions/notify/slack/action.yml');
    expect(read.filter((r) => r.copies.length).map((r) => r.file)).toEqual([
      '.github/workflows/agent-implement-revise.yml',
      '.github/workflows/agent-lead-revise.yml',
      '.github/workflows/agent-review.yml',
    ]);
  });

  it('holds each to `actions/lane-check/app-register.awk`, word for word', () => {
    for (const { file, copies } of read) for (const c of copies) expect(c.text, `${file} (${c.where})`).toBe(AWK);
  });

  it('leaves no copy outside a `REGISTER_AWK` env, where the case above would not see it', () => {
    for (const { file, copies, mentions } of read) expect(mentions, file).toBe(copies.length);
  });
});
