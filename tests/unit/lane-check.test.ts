import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { actionFiles } from './helpers/actions.js';
import { RELEASE_REF } from './helpers/release-ref.js';
import { movesOnlyKanonRefs } from '../../actions/lane-check/refs-only.mjs';
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
    // A copy in a temporary directory, never Kanon's own tree (kanon#330).
    const copy = caller.includes(legacy) ? mkdtempSync(join(tmpdir(), 'kanon-self-')) : undefined;
    if (copy) {
      expect(caller).toMatch(new RegExp(`uses: yedeya-labs/kanon/\\.github/workflows/agent-project-digest\\.yml@${RELEASE_REF}\n`));
      // The lane-check script too: it is how lane-check knows the tree is Kanon's (`KANON_TREE`).
      for (const d of ['.github', 'docs', 'actions/lane-check']) cpSync(join(ROOT, d), join(copy, d), { recursive: true });
      writeFileSync(join(copy, '.github/workflows/project-digest.yml'), caller.replace(legacy, '      KANON_CHAT_PROJECT_DIGEST: ${{ secrets.KANON_CHAT_PROJECT_DIGEST }}\n'));
    }
    const r = spawnSync('bash', [SCRIPT], { cwd: copy ?? ROOT, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
    if (copy) rmSync(copy, { recursive: true, force: true });
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

    // kanon#1007: GitHub fills a dispatch input's `default` whenever a dispatch doesn't supply it,
    // and Kanon's own scripts dispatch a caller with only its own inputs, so a default on either
    // input would raise every such run with a canned reason: a raise stored in the repository.
    // The implement-revise fixture declares both inputs, with no default, and passes them through.
    const dispatchInput = (name: string, extra: Record<string, unknown>) => (t: Tree) => t.edit(IMPL, (d) => {
      const inputs = ((d as { on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } } }).on.workflow_dispatch.inputs);
      inputs[name] = { ...inputs[name], ...extra };
    });
    it.each([['140'], [140]])('refuses a default on the max_turns dispatch input (%s), which raises every dispatch that leaves it out', (v) => {
      const r = red(dispatchInput('max_turns', { default: v }), `its \`workflow_dispatch\` input \`max_turns\` has the default \`${v}\``);
      expect(r.out).toContain('a raise stored in the repository');
    });
    it('refuses a default on the reason dispatch input, which gives every raise a canned reason', () => {
      red(dispatchInput('reason', { default: 'always' }), 'its `workflow_dispatch` input `reason` has the default `always`');
    });
    it('passes an empty default on either, which is no raise and no reason', () => {
      const t = adopter();
      dispatchInput('max_turns', { default: '' })(t);
      dispatchInput('reason', { default: '' })(t);
      const r = check(t);
      expect(r.status, r.out).toBe(0);
    });
  });
});

// kanon#1106, proposal 1: a Dependabot pull request that moves Kanon's pins across a release that
// changes what the callers need opens red, and nothing told the adopter what to do. On a pull
// request whose diff changes only Kanon's `uses:` refs, a red run now says to run /kanon:upgrade
// on the branch, and lists the changes, the ones only a person can do apart. Every other run's
// output is unchanged.
laneCheck(() => {
  describe('a red pull request that only moves Kanon\'s references points to /kanon:upgrade (kanon#1106)', () => {
    const git = (dir: string, ...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    /** Move every Kanon reference in the fixture's workflows, as Dependabot's pull request does. */
    const moveRefs = (t: Tree) => {
      for (const f of readdirSync(join(t.dir, '.github/workflows'))) {
        const rel = `.github/workflows/${f}`;
        t.write(rel, t.read(rel).replaceAll('@v1.2.3', '@v1.3.0'));
      }
    };
    /** The callers as an older release wrote them: the role-named App secrets, and no `statuses: read`. */
    const oldCallers = (t: Tree) => t.edit(IMPL, (d) => {
      const s = job(d).secrets as Record<string, string>;
      delete s.AUTHOR_APP_ID;
      delete s.AUTHOR_APP_PRIVATE_KEY;
      s.IMPLEMENTER_APP_ID = '${{ secrets.IMPLEMENTER_APP_ID }}';
      s.IMPLEMENTER_APP_PRIVATE_KEY = '${{ secrets.IMPLEMENTER_APP_PRIVATE_KEY }}';
      delete (d as Caller).permissions!.statuses;
    });
    type Opts = { headRef?: string; base?: 'committed' | 'unknown' | 'remote'; event?: string };
    /**
     * Run lane-check on a pull request: the base as `before` leaves the fixture, committed, and the
     * head as `after` then leaves it, committed on top, with the event's payload naming the base.
     * Returns the output and the job summary it wrote.
     */
    const onPullRequest = (before: (t: Tree) => void, after: (t: Tree) => void, opts: Opts = {}) => {
      const t = adopter();
      before(t);
      git(t.dir, 'init', '-q', '-b', 'main');
      git(t.dir, 'add', '-A');
      git(t.dir, 'commit', '-q', '-m', 'base');
      const base = opts.base === 'unknown' ? 'f'.repeat(40) : git(t.dir, 'rev-parse', 'HEAD');
      after(t);
      git(t.dir, 'add', '-A');
      git(t.dir, 'commit', '-q', '--allow-empty', '-m', 'head');
      const side = mkdtempSync(join(tmpdir(), 'lane-check-pr-'));
      let cwd = t.dir;
      if (opts.base === 'remote') {
        // actions/checkout's default: one commit deep, the base fetched only on demand from `origin`.
        git(side, 'clone', '-q', '--depth', '1', `file://${t.dir}`, 'checkout');
        cwd = join(side, 'checkout');
      }
      const event = join(side, 'event.json');
      const summary = join(side, 'summary.md');
      writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }));
      const r = spawnSync('bash', [SCRIPT], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '', GITHUB_EVENT_NAME: opts.event ?? 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_HEAD_REF: opts.headRef ?? 'kanon-bump', GITHUB_STEP_SUMMARY: summary },
      });
      const written = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
      rmSync(t.dir, { recursive: true, force: true });
      rmSync(side, { recursive: true, force: true });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, summary: written };
    };
    /** The same tree's output off any pull request: what every run printed before kanon#1106. */
    const offPullRequest = (change: (t: Tree) => void) => {
      const t = adopter();
      change(t);
      return check(t);
    };
    const PERSON = 'Only a person can do these:';
    const SKILL = 'The upgrade skill does these:';
    const between = (out: string, from: string, to: string) => out.slice(out.indexOf(from), to ? out.indexOf(to) : undefined);

    it('says to run /kanon:upgrade on this branch, and splits the person\'s steps from the skill\'s', () => {
      const r = onPullRequest(oldCallers, moveRefs);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('This release changes what your callers need. Run `/kanon:upgrade` on this branch');
      expect(r.out).toContain('::error title=lane-check::This pull request only moves Kanon\'s references');
      const person = between(r.out, PERSON, SKILL);
      const skill = between(r.out, SKILL, '');
      // A renamed repository secret is the person's: lane-check names both names, and never a value.
      expect(person).toContain('- Store the Author App\'s id as the repository secret `AUTHOR_APP_ID`, in place of `IMPLEMENTER_APP_ID` (docs/apps.md)');
      expect(person).toContain('- Store the Author App\'s private key as the repository secret `AUTHOR_APP_PRIVATE_KEY`, in place of `IMPLEMENTER_APP_PRIVATE_KEY` (docs/apps.md)');
      expect(person).toContain('App permission');
      expect(person).not.toContain('statuses');
      // The mapping and the permissions block are the skill's.
      expect(skill).toContain('- .github/workflows/agent-implement-revise.yml: grants statuses: none; the Kanon lane agent-implement-revise needs statuses: read');
      expect(skill).toContain('- .github/workflows/agent-implement-revise.yml: maps the role-named secret `IMPLEMENTER_APP_ID`');
      expect(skill).toContain('maps secrets [CLAUDE_CODE_OAUTH_TOKEN,IMPLEMENTER_APP_ID,IMPLEMENTER_APP_PRIVATE_KEY]');
      // And the job's summary on the pull request says the same.
      expect(r.summary).toContain('Run `/kanon:upgrade` on this branch');
      expect(r.summary).toContain('`AUTHOR_APP_ID`, in place of `IMPLEMENTER_APP_ID`');
      expect(r.summary).toContain('grants statuses: none');
    });

    it('asks the person to add a secret the release\'s lane takes and no caller maps', () => {
      const r = onPullRequest((t) => t.edit(TRIAGE, (d) => { delete (job(d).secrets as Record<string, string>).AUTHOR_APP_ID; }), moveRefs);
      expect(r.status, r.out).toBe(1);
      expect(between(r.out, PERSON, SKILL)).toContain('- Add the repository secret `AUTHOR_APP_ID`, which the Kanon lane agent-triage takes, unless the repository has it already');
      expect(between(r.out, SKILL, '')).toContain('maps secrets [AUTHOR_APP_PRIVATE_KEY,CLAUDE_CODE_OAUTH_TOKEN]');
    });

    it('reads the base from origin when the checkout is one commit deep, as actions/checkout leaves it', () => {
      const r = onPullRequest(oldCallers, moveRefs, { base: 'remote' });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('Run `/kanon:upgrade` on this branch');
    });

    it('takes a Dependabot branch as moving only the references when it can\'t read the base', () => {
      const r = onPullRequest(oldCallers, moveRefs, { base: 'unknown', headRef: 'dependabot/github_actions/kanon-0123abcd' });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('Run `/kanon:upgrade` on this branch');
    });

    it('prints what it always printed on a pull request that changes more than Kanon\'s references', () => {
      const more = (t: Tree) => { moveRefs(t); t.write(TRIAGE, `${t.read(TRIAGE)}# and a line of the person's own\n`); };
      const r = onPullRequest(oldCallers, more);
      expect(r.status, r.out).toBe(1);
      expect(r.out).not.toContain('/kanon:upgrade');
      expect(r.out).toBe(offPullRequest(oldCallers).out);
      expect(r.summary).toBe('');
    });

    it('prints what it always printed when it can\'t read the base of a branch that isn\'t Dependabot\'s', () => {
      const r = onPullRequest(oldCallers, moveRefs, { base: 'unknown' });
      expect(r.out).not.toContain('/kanon:upgrade');
      expect(r.out).toBe(offPullRequest(oldCallers).out);
    });

    it('says nothing of the upgrade off a pull request, or on one that passes', () => {
      const merge = onPullRequest(oldCallers, moveRefs, { event: 'merge_group' });
      expect(merge.out).not.toContain('/kanon:upgrade');
      const green = onPullRequest(() => {}, moveRefs);
      expect(green.status, green.out).toBe(0);
      expect(green.out).not.toContain('/kanon:upgrade');
      expect(green.summary).toBe('');
    });
  });
});

describe('which diffs only move Kanon\'s references (kanon#1106)', () => {
  const file = (body: string, name = '.github/workflows/review.yml') =>
    `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n${body}`;
  const bump = '@@ -18 +18 @@ jobs:\n-    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.23.0\n+    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.39.0\n';

  it('takes a diff that moves the refs of `uses:` lines, in a job or a step, in any number of files', () => {
    expect(movesOnlyKanonRefs(file(bump))).toBe(true);
    expect(movesOnlyKanonRefs(file(bump) + file('@@ -9 +9 @@\n-      - uses: yedeya-labs/kanon/actions/lane-check@v0.23.0\n+      - uses: yedeya-labs/kanon/actions/lane-check@v0.39.0\n', '.github/workflows/ci.yml'))).toBe(true);
    expect(movesOnlyKanonRefs(file('@@ -9 +9 @@\n-      - uses: "yedeya-labs/kanon/actions/dco@v0.23.0" # v0.23.0\n+      - uses: "yedeya-labs/kanon/actions/dco@v0.39.0" # v0.39.0\n'))).toBe(true);
  });

  it('refuses any other change beside them, or none at all', () => {
    expect(movesOnlyKanonRefs('')).toBe(false);
    expect(movesOnlyKanonRefs(file(`${bump}@@ -30,0 +31 @@\n+      statuses: read\n`))).toBe(false);
    expect(movesOnlyKanonRefs(file('@@ -18 +18 @@\n-    uses: actions/checkout@v6\n+    uses: actions/checkout@v7\n'))).toBe(false);
    // A ref moved onto another lane is a change of the caller, not of the pin.
    expect(movesOnlyKanonRefs(file('@@ -18 +18 @@\n-    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.23.0\n+    uses: yedeya-labs/kanon/.github/workflows/agent-merge.yml@v0.39.0\n'))).toBe(false);
    expect(movesOnlyKanonRefs(file('@@ -18 +17,0 @@\n-    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v0.23.0\n'))).toBe(false);
  });

  it('refuses a file added, deleted or renamed, or a binary one', () => {
    const added = 'diff --git a/x.yml b/x.yml\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/x.yml\n@@ -0,0 +1 @@\n+    uses: yedeya-labs/kanon/actions/dco@v0.39.0\n';
    expect(movesOnlyKanonRefs(added)).toBe(false);
    expect(movesOnlyKanonRefs(`${file(bump)}diff --git a/a.png b/a.png\nindex 1111111..2222222 100644\nBinary files a/a.png and b/a.png differ\n`)).toBe(false);
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
