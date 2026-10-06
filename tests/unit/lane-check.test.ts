import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT, SCRIPT, REGISTER, TRIAGE, IMPL, adopter, check, red, job, type Tree, type Caller, laneCheck } from './helpers/lane-check.js';

/**
 * `actions/lane-check` (plan 0001 §6): the shape of a caller: the fixture whole, Kanon's own tree,
 * and what a calling job holds, passes and maps.
 *
 * One of the lane-check files split by area (kanon#381); `tests/unit/helpers/lane-check.ts`
 * says how every case runs and holds the helpers they share.
 */
laneCheck(() => {
  it('fails Kanon itself on exactly what plan 0005\'s L5 migrates, and on nothing else (ADR 0011)', () => {
    // In this tree, not a copy: Kanon is its own adopter. CI runs the RELEASED action on it, at
    // the version its callers pin; this run reads the lanes as this PR leaves them. Since L4
    // the lanes take the Author's and the Judge's secrets and the register names one slug per
    // App, and Kanon moves onto both only at L5, after #279 (plan 0005, question 4). Until then
    // its own callers fail here on the L5 migration and on nothing else: the role-named
    // secrets its three callers map, and its per-role register. Any other error is a lane
    // change that would break Kanon's caller, and is red here before it is released.
    // At L5 this goes back to `status 0` and `4 lane caller(s) pass`.
    const r = spawnSync('bash', [SCRIPT], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
    expect(r.status).toBe(1);
    const errors = r.stdout.split('\n').filter((l) => l.startsWith('::error'));
    const l5 = errors.filter((l) => /maps the role-named secret `(EXPLORER|IMPLEMENTER|REVIEWER)_APP_(ID|PRIVATE_KEY)`/.test(l)
      || /maps secrets \[CLAUDE_CODE_OAUTH_TOKEN,(EXPLORER|IMPLEMENTER|REVIEWER)_APP_ID,\1_APP_PRIVATE_KEY\]; the Kanon lane agent-[a-z-]+ takes exactly \[[A-Z_,]*(AUTHOR|JUDGE)_APP_ID/.test(l)
      || /agent-identities\.md,title=lane-check::the Author's roles name 2 App slugs \(Implementer `kanon-implementer`, Explorer `kanon-explorer`\)/.test(l));
    expect(errors.filter((l) => !l5.includes(l)), r.stdout).toEqual([]);
    // Four callers (code-audit, implement, implement-revise, review), each two renames and a set
    // difference, and the register.
    expect(l5).toHaveLength(13);
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

  describe('the calling job maps exactly the lane\'s secrets, explicitly', () => {
    it('refuses `secrets: inherit` (decision 7)', () =>
      red((t) => t.edit(TRIAGE, (d) => { job(d).secrets = 'inherit'; }), 'maps no secrets explicitly'));
    it('refuses a missing secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { delete (job(d).secrets as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN; }), 'takes exactly [AUTHOR_APP_ID,AUTHOR_APP_PRIVATE_KEY,CLAUDE_CODE_OAUTH_TOKEN]'));
    it('refuses a secret under a name the lane does not take', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).QA_TRIAGE_APP_ID = '${{ secrets.QA_TRIAGE_APP_ID }}'; }), 'the Kanon lane agent-triage takes exactly'));
    it('refuses a secret mapped to anything but one repository secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).AUTHOR_APP_ID = '${{ github.token }}'; }), 'map each one to a single repository secret'));
    it('accepts a secret mapped from another repository secret, as during the renaming (§8)', () => {
      const t = adopter();
      t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).AUTHOR_APP_ID = '${{ secrets.QA_TRIAGE_APP_ID }}'; });
      expect(check(t).status).toBe(0);
    });
  });

  describe('plan 0005 L4: the two Apps, by their secrets and the register (§3.4, §3.5)', () => {
    const rename = (t: Tree) => t.edit(TRIAGE, (d) => {
      const sec = job(d).secrets as Record<string, string>;
      delete sec.AUTHOR_APP_ID; delete sec.AUTHOR_APP_PRIVATE_KEY;
      sec.IMPLEMENTER_APP_ID = '${{ secrets.IMPLEMENTER_APP_ID }}';
      sec.IMPLEMENTER_APP_PRIVATE_KEY = '${{ secrets.IMPLEMENTER_APP_PRIVATE_KEY }}';
    });
    it('fails a caller mapping a role-named secret, naming the Author\'s it takes instead', () =>
      red(rename, 'maps the role-named secret `IMPLEMENTER_APP_ID`; since plan 0005\'s two Apps the lane takes `AUTHOR_APP_ID` (the Author App\'s)'));
    it('names the Judge\'s for a Reviewer or Merger secret', () =>
      red((t) => t.edit(TRIAGE, (d) => { (job(d).secrets as Record<string, string>).MERGER_APP_ID = '${{ secrets.MERGER_APP_ID }}'; }), 'takes `JUDGE_APP_ID` (the Judge App\'s)'));
    const rows = (t: Tree, extra: string) => t.write(REGISTER, `${t.read(REGISTER)}${extra}`);
    it('fails a register whose Author roles name two slugs', () =>
      red((t) => rows(t, '| Explorer | `example-explorer` | Read | Read & write | Read | No access |\n'),
        /the Author's roles name 2 App slugs \(Implementer `example-author`, Lead `example-author`, Explorer `example-explorer`\)/));
    it('fails a register whose Judge roles name two slugs', () =>
      red((t) => rows(t, '| Reviewer | `example-judge` | x | x | x | x |\n| Merger | `example-merger` | x | x | x | x |\n'), /the Judge's roles name 2 App slugs/));
    it('fails a register in which the Author and the Judge share a slug: the self-approval case', () =>
      red((t) => rows(t, '| Reviewer | `example-author` | x | x | x | x |\n'), /the Reviewer row names `example-author`, the App the Implementer row names .*, but the Reviewer belongs to the Judge and the Implementer to the Author/));
    it('fails a register in which the Releaser shares a slug with another App', () =>
      red((t) => rows(t, '| Releaser | `example-author` | x | x | x | x |\n'), /the Releaser belongs to the Releaser and the Implementer to the Author/));
    it('passes the Author\'s four rows on one slug, the Judge\'s two on another and the Releaser on a third', () => {
      const t = adopter();
      rows(t, '| Explorer | `example-author` | x | x | x | x |\n| Overseer | `example-author` | x | x | x | x |\n| Reviewer | `example-judge` | x | x | x | x |\n| Merger | `example-judge` | x | x | x | x |\n| Releaser | `example-releaser` | x | x | x | x |\n');
      const r = check(t);
      expect(r.status, r.out).toBe(0);
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
