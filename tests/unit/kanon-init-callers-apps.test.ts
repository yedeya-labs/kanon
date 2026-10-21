import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { callerFile, TRIGGERS } from '../../cli/callers.mjs';
import { appIdentities, appsArgs, callsRelease, LANE_CHECK, lineDiff, registerRolesOf, RULESET_NAME, rulesetGaps, workflowName } from '../../cli/init.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { KEYS_HELP } from '../../cli/apps.mjs';
import { ROOT, hasYq, REQ, REPO, dirs, checkout, no, fakeGitHub, writes, run, changing, laneCheck, read, type Doc, parse } from './helpers/kanon-init.js';

// Its cases run `kanon init` against a real git checkout, and several run lane-check, so every
// case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// `kanon init`: the callers it writes and where, what it never overwrites, and the Apps. Split out
// of kanon-init.test.ts (#1204); the fixtures are in tests/unit/helpers/kanon-init.ts.

// #451: in a repository that hosts the lanes, `.github/workflows/<lane>.yml` is the lane itself,
// so its caller lives elsewhere, which the adoption record waives (`caller.misplaced`, #390).
// init honours that waiver as the caller's path, and its JSON always holds each caller's text.
describe("kanon init and a caller at the path the adoption record declares (#451)", () => {
  const LANE = 'name: Rebase lane\non:\n  workflow_call:\njobs:\n  rebase:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n';
  const record = (bullets: string) => `# Adoption record\n\n## Choices\n\n${bullets}`;
  const waiver = (path: string) => `- **Waived doctor finding:** \`caller.misplaced\` on \`${path}\` (the lane itself holds its name)\n`;
  const RELEASE = `v${JSON.parse(read(ROOT, 'package.json')).version}`;
  const at = (lane: string, path: string, release = RELEASE) => callerFile(lane, REQ.lanes[lane]!, { release, ciName: 'CI', defaultBranch: 'main', path });
  const fileOf = (d: Doc, path: string) => d.files.find((f) => f.path === path);

  it('compares the caller at the waived path, not the lane at the default one, and counts the lane as installed', async () => {
    const dir = checkout({
      '.github/workflows/agent-rebase.yml': LANE,
      '.github/workflows/rebase.yml': at('agent-rebase', '.github/workflows/rebase.yml', 'v1.0.0'),
      'docs/qa/adoption.md': record(waiver('.github/workflows/rebase.yml')),
    });
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--dry-run', '--no-apps', '--lanes', 'review,rebase']));
    expect(fileOf(d, '.github/workflows/agent-rebase.yml')).toBeUndefined();
    const caller = fileOf(d, '.github/workflows/rebase.yml')!;
    expect(caller.status).toBe('differs');
    expect(caller.content).toBe(at('agent-rebase', '.github/workflows/rebase.yml'));
    expect(caller.diff).toContain(`+     uses: yedeya-labs/kanon/.github/workflows/agent-rebase.yml@${RELEASE}`);
    expect(d.inspection.installedLanes).toContain('agent-rebase');
  });

  it("gives every caller's full content, whatever its status, and none of a declaration that is the project's", async () => {
    const dir = checkout({ '.github/workflows/agent-rebase.yml': LANE, 'docs/qa/stack.md': '# Stack\n' });
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--dry-run', '--no-apps', '--lanes', 'review,rebase']));
    // Without a waiver the default path is offered, and its text is there to write elsewhere.
    const offered = fileOf(d, '.github/workflows/agent-rebase.yml')!;
    expect(offered).toMatchObject({ status: 'differs', content: at('agent-rebase', '.github/workflows/agent-rebase.yml') });
    expect(fileOf(d, 'docs/qa/stack.md')).toMatchObject({ status: 'kept', content: null });
    // A caller already as init writes it.
    const same = checkout({ '.github/workflows/agent-review.yml': at('agent-review', '.github/workflows/agent-review.yml') });
    const s = parse(await run(same, fakeGitHub(), ['--json', '--dry-run', '--no-apps']));
    expect(fileOf(s, '.github/workflows/agent-review.yml')).toMatchObject({ status: 'same', content: at('agent-review', '.github/workflows/agent-review.yml') });
  });

  it('writes the caller at the waived path, the runtime-version trigger naming that path', async () => {
    const dir = checkout({
      '.github/workflows/agent-overseer.yml': LANE,
      '.github/workflows/overseer.yml': at('agent-overseer', '.github/workflows/overseer.yml', 'v1.0.0'),
      'docs/qa/adoption.md': record(waiver('.github/workflows/overseer.yml')),
    });
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--dry-run', '--no-apps', '--lanes', 'review,overseer']));
    const caller = fileOf(d, '.github/workflows/overseer.yml')!;
    expect(caller.content).toContain('    paths:\n      - .github/workflows/overseer.yml\n');
    expect(caller.content).not.toContain('agent-overseer.yml\n');
  });

  it("keeps the default path when the waived file doesn't call the lane, or the default path already does", async () => {
    // The waived file calls another lane: the waiver is that lane's.
    const other = checkout({
      '.github/workflows/agent-rebase.yml': LANE,
      '.github/workflows/rebase.yml': at('agent-review', '.github/workflows/rebase.yml'),
      'docs/qa/adoption.md': record(waiver('.github/workflows/rebase.yml')),
    });
    const o = parse(await run(other, fakeGitHub(), ['--json', '--dry-run', '--no-apps', '--lanes', 'review,rebase']));
    expect(fileOf(o, '.github/workflows/agent-rebase.yml')!.status).toBe('differs');
    expect(o.inspection.installedLanes).not.toContain('agent-rebase');
    // A waived file that isn't there.
    const missing = checkout({ '.github/workflows/agent-rebase.yml': LANE, 'docs/qa/adoption.md': record(waiver('.github/workflows/rebase.yml')) });
    expect(fileOf(parse(await run(missing, fakeGitHub(), ['--json', '--dry-run', '--no-apps', '--lanes', 'review,rebase'])), '.github/workflows/agent-rebase.yml')).toBeDefined();
    // The default path is the lane's caller already: a second caller elsewhere doesn't move it.
    const both = checkout({
      '.github/workflows/agent-rebase.yml': at('agent-rebase', '.github/workflows/agent-rebase.yml'),
      '.github/workflows/rebase.yml': at('agent-rebase', '.github/workflows/rebase.yml'),
      'docs/qa/adoption.md': record(waiver('.github/workflows/rebase.yml')),
    });
    const b = parse(await run(both, fakeGitHub(), ['--json', '--dry-run', '--no-apps', '--lanes', 'review,rebase']));
    expect(fileOf(b, '.github/workflows/agent-rebase.yml')!.status).toBe('same');
    expect(fileOf(b, '.github/workflows/rebase.yml')).toBeUndefined();
  });

  it('honours only a waiver of caller.misplaced, under ## Choices', async () => {
    const files = (record: string) => ({ '.github/workflows/agent-rebase.yml': LANE, '.github/workflows/rebase.yml': at('agent-rebase', '.github/workflows/rebase.yml'), 'docs/qa/adoption.md': record });
    const paths = async (text: string) => parse(await run(checkout(files(text)), fakeGitHub(), ['--json', '--dry-run', '--no-apps', '--lanes', 'review,rebase'])).files.map((f) => String(f.path)).filter((p) => /rebase/.test(p));
    expect(await paths(record(waiver('.github/workflows/rebase.yml')))).toEqual(['.github/workflows/rebase.yml']);
    expect(await paths(record(waiver('.github/workflows/rebase.yml').replace('caller.misplaced', 'caller.name')))).toEqual(['.github/workflows/agent-rebase.yml']);
    expect(await paths(`# Adoption record\n\n## People\n\n${waiver('.github/workflows/rebase.yml')}`)).toEqual(['.github/workflows/agent-rebase.yml']);
  });
});
describe('kanon init, safely', () => {
  it('changes nothing in a dry run, and lists what it would do', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    const r = await run(dir, github, ['--yes', '--dry-run']);
    expect(r.status).toBe(0);
    expect(writes(github.calls)).toEqual([]);
    expect(r.appsCalls).toEqual([]);
    expect(r.milestoneCalls).toEqual([]);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(r.out).toContain('- Would create .github/workflows/agent-review.yml');
    expect(r.out).toContain('- Would run: kanon apps --owner acme --repo widgets --apps judge');
    expect(r.out).toContain(`- Would create the ruleset "${RULESET_NAME}"`);
  });

  it('refuses outside a checkout of the repository, before any call to GitHub', async () => {
    const github = fakeGitHub();
    const elsewhere = checkout({}, 'https://github.com/acme/other.git');
    const r = await run(elsewhere, github, ['--yes', '--repo', REPO]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('is a checkout of acme/other, not of acme/widgets');
    const none = mkdtempSync(join(tmpdir(), 'kanon-init-none-'));
    dirs.push(none);
    const r2 = await run(none, github);
    expect(r2.status).toBe(1);
    expect(r2.err).toContain('is not a git checkout');
    expect(github.calls).toEqual([]);
  });

  it("never overwrites a file it finds: keeps the project's declarations, and names how a caller differs", async () => {
    const mine = '# Stack\n\n## Gates\n\n1. `make check`\n';
    const caller = 'name: Review (Reviewer)\n';
    const dir = checkout({ 'docs/qa/stack.md': mine, '.github/workflows/agent-review.yml': caller });
    const r = await run(dir, fakeGitHub());
    expect(read(dir, 'docs/qa/stack.md')).toBe(mine);
    expect(read(dir, '.github/workflows/agent-review.yml')).toBe(caller);
    expect(r.out).toContain("docs/qa/stack.md: exists, and is the project's; left unchanged.");
    expect(r.out).toContain('.github/workflows/agent-review.yml: exists and differs from what init would write; left unchanged.');
    expect(r.out).toMatch(/^ {4}\+ jobs:$/m);
  });

  it('offers the lanes whose callers already call them as the default, not a file that only has the name', async () => {
    const implement = 'name: Implement\njobs:\n  implement:\n    uses: yedeya-labs/kanon/.github/workflows/agent-implement.yml@v0.1.0\n';
    const dir = checkout({ '.github/workflows/agent-implement.yml': implement, '.github/workflows/agent-lead.yml': 'name: my own lead workflow\n' });
    const r = await run(dir, fakeGitHub());
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'author', '--dir', expect.any(String)]]);
    expect(existsSync(join(dir, '.github/workflows/agent-review.yml'))).toBe(false);
  });

  it('writes lane-check beside a CI the project already has, reading its name for the review trigger', async () => {
    const ci = 'name: Build\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n';
    const dir = checkout({ '.github/workflows/ci.yml': ci });
    await run(dir, fakeGitHub());
    expect(read(dir, '.github/workflows/ci.yml')).toBe(ci);
    expect(read(dir, '.github/workflows/lane-check.yml')).toContain('name: Lane check');
    expect(read(dir, '.github/workflows/agent-review.yml')).toContain('workflows: [Build]');
  });

  it("names the workflow_run trigger as GitHub names the CI: its name without a comment or quotes, or its path when unnamed", async () => {
    expect(workflowName('name: CI # build and test\non: push\n', 'x')).toBe('CI');
    expect(workflowName('name: "Build all"\n', 'x')).toBe('Build all');
    expect(workflowName("name: 'Build' # c\n", 'x')).toBe('Build');
    expect(workflowName('on: push\njobs:\n  a:\n    name: inner\n', '.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    const dir = checkout({ '.github/workflows/ci.yml': 'on:\n  pull_request:\njobs:\n  t:\n    name: Test\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' });
    await run(dir, fakeGitHub());
    expect(read(dir, '.github/workflows/agent-review.yml')).toContain('workflows: [".github/workflows/ci.yml"]');
  });

  it('keeps a # inside a quoted CI name, where only a plain name loses a trailing comment (#335)', async () => {
    expect(workflowName('name: "CI #1"\n', 'x')).toBe('CI #1');
    expect(workflowName("name: 'CI #1' # nightly\n", 'x')).toBe('CI #1');
    expect(workflowName('name: "Say \\"hi\\" #2" # c\n', 'x')).toBe('Say "hi" #2');
    expect(workflowName("name: 'It''s #3'\n", 'x')).toBe("It's #3");
    expect(workflowName('name: CI#1 # c\n', 'x')).toBe('CI#1');
    expect(workflowName('name: # no name\n', 'p')).toBe('p');
    const dir = checkout({ '.github/workflows/ci.yml': 'name: "CI #1"\non:\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' });
    await run(dir, fakeGitHub());
    expect(read(dir, '.github/workflows/agent-review.yml')).toContain('workflows: ["CI #1"]');
  });
});
describe('kanon init, from the answers', () => {
  it.skipIf(!hasYq)('writes the gates, a sign-off delegation and a test-database declaration that the readers accept', async () => {
    const dir = checkout({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }) });
    // Changed through the summary's Change something (plan 0007 §3), each in today's question.
    const r = await run(dir, fakeGitHub(), [], undefined, REQ, { ask: changing('1,3', { 'sign-off delegation': 'y', 'test database': 'hook', 'Who is the Owner': 'grace' }) });
    expect(r.status, r.err).toBe(0);
    expect(read(dir, 'docs/qa/stack.md')).toContain('1. `npm run lint`\n2. `npm test`');
    expect(read(dir, 'docs/qa/sign-off-delegation.md')).toContain('| Ada Lovelace | ada@example.com | 2026-10-05 |');
    expect(read(dir, 'docs/qa/adoption.md')).toContain('| Owner | `@grace` |');
    const lc = laneCheck(dir);
    expect(lc.status, lc.out).toBe(0);
    const db = spawnSync('awk', ['-f', join(ROOT, 'actions/test-database/declaration.awk'), join(dir, 'docs/qa/test-database.md')], { encoding: 'utf8' });
    expect(db.stdout.trim()).toBe('hook');
  }, 30_000);

  it("deletes GitHub's default labels outside the taxonomy only when asked", async () => {
    const github = fakeGitHub();
    await run(checkout(), github, [], undefined, REQ, { ask: changing('4', { "Delete GitHub's default labels": 'y' }) });
    expect(github.st.labels.has('question')).toBe(false);
    expect(github.st.labels.has('documentation')).toBe(false);
    // `bug` and `enhancement` are in the taxonomy, so they stay.
    expect(github.st.labels.has('bug')).toBe(true);
  });
});
describe('the callers kanon init writes', () => {
  it('has a caller template for every lane the release ships, and no other', () => {
    expect(Object.keys(TRIGGERS).sort()).toEqual(Object.keys(REQ.lanes).sort());
  });

  // kanon#891, as the Owner shaped it on 2026-10-15: a person raises a lane's turn limit for one
  // dispatched run, so every caller of a lane whose limit can be raised carries `max_turns` and
  // `reason` on its dispatch, optional, and passes both through; no other caller does.
  it('writes the dispatch inputs that raise a turn limit for one run, passed through, on each lane that takes them', () => {
    const lanes = REQ.lanes as Record<string, { turns?: unknown }>;
    const raisable = Object.keys(lanes).filter((l) => lanes[l]!.turns).sort();
    expect(raisable.length).toBe(16);
    for (const lane of Object.keys(lanes)) {
      const d = parseYaml(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'main' })) as {
        on: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } | null }; jobs: Record<string, { with?: Record<string, string> }>;
      };
      const inputs = d.on.workflow_dispatch?.inputs ?? {};
      const withs = Object.values(d.jobs)[0]!.with ?? {};
      if (raisable.includes(lane)) {
        expect(inputs.max_turns, lane).toMatchObject({ required: false });
        expect(inputs.reason, lane).toMatchObject({ required: false });
        expect(withs.max_turns, lane).toBe('${{ inputs.max_turns }}');
        expect(withs.reason, lane).toBe('${{ inputs.reason }}');
      } else {
        expect(inputs, lane).not.toHaveProperty('max_turns');
        expect(withs, lane).not.toHaveProperty('max_turns');
      }
    }
  });

  // Each trigger as one line: `<event>:<types>`, `workflow_run:branches` for a default-branch
  // filter, `schedule`, and `workflow_dispatch:<inputs>`.
  const fromTable = (cell: string): string[] =>
    cell.split(';').flatMap((part) => {
      const ticks = [...part.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      const [head = '', ...rest] = ticks;
      const event = head.split(':')[0]!.trim();
      if (event === 'schedule') return ['schedule'];
      if (event === 'workflow_dispatch') return [`workflow_dispatch:${rest.sort().join(',')}`];
      if (event === 'workflow_run') {
        const types = /\[([^\]]+)\]/.exec(ticks.find((t) => t.startsWith('types:')) ?? '')?.[1] ?? '';
        return [`workflow_run:${types}`, ...(rest.includes('branches') ? ['workflow_run:branches'] : [])];
      }
      return [`${event}:${(/\[([^\]]+)\]/.exec(head)?.[1] ?? '').split(',').map((x) => x.trim()).sort().join(',')}`];
    });
  const fromTriggers = (t: (typeof TRIGGERS)[string]): string[] => [
    ...(t.ci ? ['workflow_run:completed', ...(t.ci === 'default' ? ['workflow_run:branches'] : [])] : []),
    ...(t.review ? ['pull_request_review:submitted'] : []),
    ...(t.pr ? [`pull_request:${[...t.pr].sort().join(',')}`] : []),
    ...(t.prTarget ? [`pull_request_target:${[...t.prTarget].sort().join(',')}`] : []),
    ...(t.pinMoved || t.merged ? ['pull_request_target:closed'] : []),
    ...(t.issues ? [`issues:${[...t.issues].sort().join(',')}`] : []),
    ...(t.release ? ['release:published'] : []),
    ...(t.deployRun ? ['workflow_run:completed'] : []),
    ...(t.reask ? ['workflow_run:completed'] : []),
    ...(t.schedule ? ['schedule'] : []),
    // A `deployRun` caller has no dispatch: the lane reads the failed run from the event (plan 0010 D8).
    ...(t.deployRun ? [] : [`workflow_dispatch:${Object.keys(t.dispatch).sort().join(',')}`]),
  ];

  it("writes the Overseer's runtime-version trigger on its own file, on the default branch (kanon#423)", () => {
    const text = callerFile('agent-overseer', REQ.lanes['agent-overseer']!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' });
    expect(text).toContain('  pull_request_target:\n    types: [closed]\n    branches: [trunk]\n    paths:\n      - .github/workflows/agent-overseer.yml\n');
    // No other lane's caller gets it.
    for (const lane of Object.keys(REQ.lanes).filter((l) => l !== 'agent-overseer')) {
      expect(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' }), lane).not.toContain('types: [closed]\n    branches: [trunk]\n    paths:');
    }
  });

  // #484: through a merge queue the CI run on a merge is the queue's, which the gate turns away,
  // so the rebase lane's caller also starts it on the merged pull request, on the default branch.
  it("writes the rebase lane's merged-pull-request trigger on the default branch, any file, and no other lane's (kanon#484)", () => {
    const text = callerFile('agent-rebase', REQ.lanes['agent-rebase']!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' });
    const on = (parseYaml(text) as { on: Record<string, unknown> }).on;
    expect(on.pull_request_target).toEqual({ types: ['closed'], branches: ['trunk'] });
    expect(Object.keys(on)).toEqual(['workflow_run', 'pull_request_target', 'schedule', 'workflow_dispatch']);
    const merged = Object.entries(TRIGGERS).filter(([, t]) => t.merged).map(([l]) => l);
    expect(merged).toEqual(['agent-rebase']);
    for (const lane of Object.keys(REQ.lanes).filter((l) => !merged.includes(l) && l !== 'agent-overseer')) {
      expect(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' }), lane).not.toContain('types: [closed]\n    branches:');
    }
  });

  // kanon#833, after kanon#813: the dispatch sweep and the reconciler are re-asked by a real run
  // of the lanes they recover, so `kanon init` writes that `workflow_run` in their callers, naming
  // each covered caller as init writes it, exactly as docs/lanes.md's snippets give it.
  it("writes the re-ask on the dispatch sweep's and the reconciler's callers, as docs/lanes.md gives it, and on no other (kanon#833)", () => {
    const section = readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8').split('## Schedules are best effort')[1]!.split('\n## ')[0]!;
    const snippet = (caller: string) => {
      const block = [...section.matchAll(/```yaml\n# In the (.+?)'s caller\n([\s\S]*?)```/g)].find((m) => m[1] === caller);
      expect(block, caller).toBeDefined();
      return (parseYaml(block![2]!) as { workflow_run: unknown }).workflow_run;
    };
    const on = (lane: string) => (parseYaml(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'main' })) as { on: Record<string, unknown> }).on;
    const name = (lane: string) => (parseYaml(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'main' })) as { name: string }).name;
    const want = {
      'agent-dispatch-sweep': { doc: 'dispatch sweep', covers: ['agent-implement', 'agent-triage'] },
      'agent-lead-reconcile': { doc: 'reconciler', covers: ['agent-review', 'agent-implement-revise', 'agent-lead-revise', 'agent-implement'] },
    };
    for (const [lane, { doc, covers }] of Object.entries(want)) {
      expect(on(lane).workflow_run, lane).toEqual({ workflows: covers.map(name), types: ['completed'] });
      expect(on(lane).workflow_run, lane).toEqual(snippet(doc));
      // The schedule stays the floor, and the dispatch stays.
      expect(on(lane), lane).toHaveProperty('schedule');
      expect(on(lane), lane).toHaveProperty('workflow_dispatch');
    }
    // No other caller re-asks: a `workflow_run` elsewhere is a CI's or the deploy caller's.
    for (const lane of Object.keys(REQ.lanes).filter((l) => !(l in want))) {
      const t = TRIGGERS[lane]!;
      if (!t.ci && !t.deployRun) expect(on(lane), lane).not.toHaveProperty('workflow_run');
    }
  });

  it('refuses a template that would write workflow_run twice', () => {
    for (const extra of [{ ci: 'any' as const }, { deployRun: true }]) {
      const t = TRIGGERS['agent-dispatch-sweep']!;
      TRIGGERS['agent-dispatch-sweep'] = { ...t, ...extra };
      try {
        expect(() => callerFile('agent-dispatch-sweep', REQ.lanes['agent-dispatch-sweep']!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' })).toThrow(/workflow_run` twice/);
      } finally {
        TRIGGERS['agent-dispatch-sweep'] = t;
      }
    }
  });

  it('refuses a template that would write pull_request_target twice', () => {
    const t = TRIGGERS['agent-rebase']!;
    TRIGGERS['agent-rebase'] = { ...t, pinMoved: true };
    try {
      expect(() => callerFile('agent-rebase', REQ.lanes['agent-rebase']!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' })).toThrow(/pull_request_target` twice/);
    } finally {
      TRIGGERS['agent-rebase'] = t;
    }
  });

  it("holds each lane's triggers to docs/lanes.md's table, event by event", () => {
    const section = readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8').split('## Which lanes are available')[1]!.split('\n## ')[0]!;
    const rows = [...section.matchAll(/^\| [^|]+\| `(agent-[a-z-]+)\.yml` \| [^|]+\| (.+) \|$/gm)];
    expect(rows.length).toBe(Object.keys(TRIGGERS).length);
    // A cell's triggers are its first sentence; a later one is a note about them (kanon#626).
    for (const [, lane, cell] of rows) expect(fromTriggers(TRIGGERS[lane!]!).sort(), lane).toEqual(fromTable(cell!.split('. ')[0]!).sort());
  });

  it.skipIf(!hasYq)('passes lane-check with a caller for every lane at once', async () => {
    const dir = checkout({
      // What init leaves to the project: the Explorer's sweep hook and the Overseer's ledger.
      '.github/actions/explore-sweep/action.yml': 'name: Sweep\ndescription: x\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: "true"\n',
      'docs/qa/capability-ledger.md': '# Capability ledger\n',
    });
    const all = Object.keys(REQ.lanes).map((l) => l.slice('agent-'.length)).join(',');
    const github = fakeGitHub();
    // With environments declared, so the deploy diagnose lane's caller is written too (plan 0010 D8).
    const r = await run(dir, github, ['--yes', '--lanes', all, '--deploy-environments', 'staging,production']);
    expect(r.status, r.err).toBe(0);
    expect(r.appsCalls[0]).toContain('author,judge');
    const lc = laneCheck(dir);
    expect(lc.status, lc.out).toBe(0);
    expect(lc.out).toContain(`${Object.keys(REQ.lanes).length} lane caller(s) pass`);
    // No lane takes DIGEST_WEBHOOK since plan 0011 N7 and N8, and no caller init writes maps it (decision 17).
    expect(r.out).not.toContain('gh secret set DIGEST_WEBHOOK');
    for (const f of readdirSync(join(dir, '.github/workflows'))) expect(read(dir, `.github/workflows/${f}`), f).not.toContain('DIGEST_WEBHOOK');
  }, 60_000);
});
// #363 (the Owner, 2026-10-07: "A + ask"): init lists the owner's App installations and offers
// to reuse one whose permissions are exactly an App's, rather than create a second set.
describe("kanon init and the Apps the owner already has (#363)", () => {
  const APPS = REQ.identities.apps;
  const install = (slug: string, app: string, over: Record<string, unknown> = {}) => ({ id: slug.length, app_id: 900 + slug.length, app_slug: slug, account: { login: 'acme', type: 'Organization' }, permissions: { ...APPS[app]!.permissions }, events: [], repository_selection: 'selected', ...over });
  const installsCalls = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter((c) => /installations/.test(c.args.join(' ')));
  const registerReads = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter((c) => c.args[1] === 'graphql' && /repositoryOwner/.test(c.input ?? ''));

  it('finds the Judge among an organisation\'s installations, reuses it by default, and prints the --reuse step with its slug', async () => {
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-kanon-judge', 'judge'), install('some-ci-bot', 'judge', { permissions: { contents: 'read', metadata: 'read' } })] });
    const r = await run(checkout(), github, ['--json']);
    expect(r.status, r.err).toBe(0);
    const d = parse(r);
    expect(d.inspection.ownerApps).toEqual([{ app: 'judge', slug: 'acme-kanon-judge', from: 'installation' }]);
    expect(d.answers.reuseApps).toBe(true);
    expect(d.apps).toEqual({ identities: ['judge'], missing: ['judge'], reuse: [{ app: 'judge', slug: 'acme-kanon-judge', appId: 916 }], command: null, outcome: 'reuse', exitCode: null });
    expect(r.appsCalls).toEqual([]);
    const f = d.findings.filter((x) => x.id.startsWith('app.'));
    expect(f).toEqual([
      {
        id: 'app.reuse',
        category: 'app',
        blocking: false,
        subject: 'judge',
        message: 'acme already has the Judge App acme-kanon-judge, which the chosen lanes run as, and the register lacks it.',
        fix: {
          // #637: the fix says where the key is made, and links GitHub's page on it.
          text: `Add widgets to the App's installation and generate a private key on its settings page (Credentials → Key pairs → New key; GitHub's steps: ${KEYS_HELP}), then run kanon apps --reuse with the key, and commit the register rows it writes.`,
          commands: ['kanon apps --owner acme --repo widgets --reuse judge:acme-kanon-judge@916=<downloaded>.pem'],
          url: 'https://github.com/organizations/acme/settings/apps/acme-kanon-judge',
        },
      },
    ]);
    expect(installsCalls(github).map((c) => c.args)).toEqual([['api', 'orgs/acme/installations?per_page=100']]);
    // The installations answered, so they decide: no other repository's register is read (plan 0007 G4).
    expect(registerReads(github)).toEqual([]);
  });

  // #640: the App ID comes from the installation, so the person needn't copy it from the App's page.
  it("fills the installation's app_id into the --reuse command, and keeps <App ID> for an installation without one (#640)", async () => {
    const d = parse(await run(checkout(), fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-kanon-judge', 'judge', { app_id: 4242 })] }), ['--json']));
    expect(d.apps.reuse).toEqual([{ app: 'judge', slug: 'acme-kanon-judge', appId: 4242 }]);
    expect(d.findings.find((x) => x.id === 'app.reuse')!.fix.commands).toEqual(['kanon apps --owner acme --repo widgets --reuse judge:acme-kanon-judge@4242=<downloaded>.pem']);
    const without = parse(await run(checkout(), fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-kanon-judge', 'judge', { app_id: undefined })] }), ['--json']));
    expect(without.apps.reuse).toEqual([{ app: 'judge', slug: 'acme-kanon-judge', appId: null }]);
    const reuse = without.findings.find((x) => x.id === 'app.reuse')!;
    expect(reuse.fix.commands).toEqual(['kanon apps --owner acme --repo widgets --reuse judge:acme-kanon-judge@<App ID>=<downloaded>.pem']);
    expect(reuse.fix.text).toContain('copy its App ID from the same page');
  });

  // Plan 0007 G4: an owner whose installations the token can't list (a personal account, or an
  // organisation's member who isn't its owner) may still have the Apps, named in the App register
  // of another of its repositories.
  const SIBLING = '# App register\n\n| Role | App slug |\n|---|---|\n| Reviewer | `acme-judge` |\n| Merger | `acme-judge` |\n';
  it("with the installations unreadable, finds the Judge a sibling repository's register names, and prints the --reuse step with its slug (plan 0007 G4)", async () => {
    for (const kind of ['User', 'Organization'] as const) {
      // This repository's own entry is never a sibling, and a register naming no App adds none.
      const github = fakeGitHub({ kind, orgPlan: 'free', registers: { widgets: SIBLING.replace(/acme-judge/g, 'acme-stale-judge'), notes: null, site: SIBLING } });
      const r = await run(checkout(), github, ['--json']);
      expect(r.status, r.err).toBe(0);
      const d = parse(r);
      expect(d.inspection.ownerApps, kind).toEqual([{ app: 'judge', slug: 'acme-judge', from: 'register:acme/site' }]);
      expect(d.answers.reuseApps).toBe(true);
      expect(d.apps).toMatchObject({ missing: ['judge'], reuse: [{ app: 'judge', slug: 'acme-judge', appId: null }], outcome: 'reuse' });
      expect(r.appsCalls).toEqual([]);
      const reuse = d.findings.find((x) => x.id === 'app.reuse')!;
      expect(reuse.message).toBe("acme already has the Judge App acme-judge, which the chosen lanes run as, and the register lacks it (acme/site's App register names it).");
      expect(reuse.fix.commands).toEqual(['kanon apps --owner acme --repo widgets --reuse judge:acme-judge@<App ID>=<downloaded>.pem']);
      expect(d.notes.some((n: string) => n.startsWith('Not looked for'))).toBe(false);
      expect(registerReads(github)).toHaveLength(1);
      // A fork's register names its upstream's Apps, never the owner's.
      expect(registerReads(github)[0]!.input).toContain('ownerAffiliations: [OWNER], isFork: false');
    }
    const asked: string[] = [];
    await run(checkout(), fakeGitHub({ kind: 'User', registers: { site: SIBLING } }), [], undefined, REQ, { ask: changing('2', {}, asked) });
    expect(asked.find((q) => /Reuse/.test(q))).toBe("The owner already has the Judge (acme-judge), named in acme/site's App register. Reuse it here with kanon apps --reuse, rather than create a second one? (y/n)");
  });

  it("still cautions against a second App it found nowhere, and offers no App of another account's from a register (plan 0007 G4)", async () => {
    const author = registerRolesOf('author', REQ).map((r) => `| ${r} | \`bot-author\` |`).join('\n');
    const github = fakeGitHub({ kind: 'User', registers: { site: `${SIBLING}${author}\n` }, publicApps: { 'bot-author': { owner: { login: 'bot-maker' } } } });
    const d = parse(await run(checkout(), github, ['--json', '--lanes', 'review,implement', '--no-apps']));
    expect(d.inspection.ownerApps).toEqual([{ app: 'judge', slug: 'acme-judge', from: 'register:acme/site' }]);
    expect(d.apps).toMatchObject({ missing: ['author', 'judge'], reuse: [{ app: 'judge', slug: 'acme-judge', appId: null }], outcome: 'left-to-you' });
    expect(d.findings.find((x) => x.id === 'app.create')!.fix.text).toContain("If acme already has this App for another repository, don't create it again");
    // Neither the installations nor the registers could be read: null, as before G4.
    const neither = parse(await run(checkout(), fakeGitHub({ kind: 'User' }), ['--json', '--no-apps']));
    expect(neither.inspection.ownerApps).toBeNull();
  });

  // #652: a sibling register naming the Judge says nothing of the Author, so the JSON says which
  // Apps init couldn't look for, and the note stays, whatever ownerApps holds.
  it("names each App it couldn't look for, and keeps the note, when a sibling register names only some (#652)", async () => {
    const partial = parse(await run(checkout(), fakeGitHub({ kind: 'User', registers: { site: SIBLING } }), ['--json', '--lanes', 'review,implement', '--no-apps']));
    expect(partial.inspection.ownerApps).toEqual([{ app: 'judge', slug: 'acme-judge', from: 'register:acme/site' }]);
    expect(partial.inspection.appsNotLookedFor).toEqual(['author', 'releaser']);
    const why = partial.notes.find((n: string) => n.startsWith('Not looked for: '));
    expect(why).toContain("the token can't list acme's App installations");
    expect(why).toContain("Another of its repositories' App registers names judge, but none names author, which acme may have all the same.");
    // Every App the chosen lanes need was found: still named in the field, but no note.
    const full = parse(await run(checkout(), fakeGitHub({ kind: 'User', registers: { site: SIBLING } }), ['--json', '--no-apps']));
    expect(full.inspection.appsNotLookedFor).toEqual(['author', 'releaser']);
    expect(full.notes.some((n: string) => n.startsWith('Not looked for'))).toBe(false);
    // Found nowhere: every App the register lacks; listed: none.
    expect(parse(await run(checkout(), fakeGitHub({ kind: 'User' }), ['--json', '--no-apps'])).inspection.appsNotLookedFor).toEqual(['author', 'judge', 'releaser']);
    expect(parse(await run(checkout(), fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [] }), ['--json', '--no-apps'])).inspection.appsNotLookedFor).toEqual([]);
  });

  it('creates the App anyway with --no-reuse-apps, and asks without --yes, taking the answer', async () => {
    const owned = { kind: 'Organization' as const, orgPlan: 'free', installations: [install('acme-kanon-judge', 'judge')] };
    const no = await run(checkout(), fakeGitHub(owned), ['--json', '--no-reuse-apps']);
    expect(parse(no).answers.reuseApps).toBe(false);
    expect(parse(no).apps).toMatchObject({ reuse: [], outcome: 'ran' });
    expect(no.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge', '--dir', expect.any(String)]]);
    const asked: string[] = [];
    const said = await run(checkout(), fakeGitHub(owned), [], undefined, REQ, { ask: changing('2', { 'Reuse it here': 'n' }, asked) });
    expect(asked.find((q) => /Reuse/.test(q))).toBe('The owner already has the Judge (acme-kanon-judge), installed with exactly its permissions. Reuse it here with kanon apps --reuse, rather than create a second one? (y/n)');
    expect(said.appsCalls).toHaveLength(1);
    const yes = await run(checkout(), fakeGitHub(owned), [], undefined, REQ, { ask: async (_q: string, d: string) => d });
    expect(yes.appsCalls).toEqual([]);
    expect(yes.out).toContain('kanon apps --owner acme --repo widgets --reuse judge:acme-kanon-judge@916=<downloaded>.pem');
  });

  it('reuses the Apps the owner has and creates the rest, and names each further match once (#653)', async () => {
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-judge-a', 'judge'), install('acme-judge-b', 'judge', { app_id: 913 }), install('acme-judge-cc', 'judge', { app_id: 914 }), install('acme-judge-ddd', 'judge', { app_id: undefined })] });
    const r = await run(checkout(), github, ['--json', '--lanes', 'review,implement']);
    const d = parse(r);
    expect(d.apps).toMatchObject({ missing: ['author', 'judge'], reuse: [{ app: 'judge', slug: 'acme-judge-a' }], outcome: 'ran' });
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'author', '--dir', expect.any(String)]]);
    const reuse = d.findings.find((x) => x.id === 'app.reuse')!;
    expect(reuse.fix.commands).toEqual(['kanon apps --owner acme --repo widgets --reuse judge:acme-judge-a@912=<downloaded>.pem']);
    expect(reuse.fix.text).toContain('(it also has acme-judge-b (App ID 913), acme-judge-cc (App ID 914), acme-judge-ddd with the same permissions: give the one widgets should share)');
    expect(reuse.fix.text).not.toMatch(/,,|, ,/);
  });

  it("offers no installation whose permissions differ, of another account, whose App the register names, or whose App no chosen lane needs", async () => {
    const register = '| Role | App slug |\n|---|---|\n| Reviewer | `acme-judge` |\n| Merger | `acme-judge` |\n';
    const installations = [
      install('acme-judge', 'judge'),
      install('acme-author-wide', 'author', { permissions: { ...APPS.author!.permissions, administration: 'write' } }),
      install('acme-author-narrow', 'author', { permissions: Object.fromEntries(Object.entries(APPS.author!.permissions).filter(([k]) => k !== 'workflows')) }),
      install('other-author', 'author', { account: { login: 'other' } }),
      install('acme-releaser', 'releaser'),
    ];
    const r = await run(checkout({ 'docs/qa/agent-identities.md': register }), fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations }), ['--json', '--lanes', 'review,implement']);
    const d = parse(r);
    expect(d.inspection.ownerApps).toEqual([{ app: 'releaser', slug: 'acme-releaser', from: 'installation' }]);
    // The Releaser wasn't asked for, so there is nothing to ask about.
    expect(d.answers.reuseApps).toBeNull();
    expect(d.apps).toMatchObject({ missing: ['author'], reuse: [], outcome: 'ran' });
  });

  // #462: the Releaser's three permissions are ones an ordinary bot can hold, so every App is
  // matched as strictly: exactly its permissions, no events, and an App of the owner's own.
  const RELEASE_CALLER = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';
  const releaserOffer = async (installations: Array<Record<string, unknown>>, publicApps: Record<string, { owner: { login: string } }> = {}) => {
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-judge', 'judge'), ...installations], publicApps });
    return parse(await run(checkout({ '.github/workflows/release.yml': RELEASE_CALLER }), github, ['--json', '--lanes', 'review', '--releaser'])).inspection.ownerApps;
  };

  it("offers the owner's own Releaser, private or public, as it does the Judge (#462, the mutations' baseline)", async () => {
    const both = [{ app: 'judge', slug: 'acme-judge', from: 'installation' }, { app: 'releaser', slug: 'acme-releaser', from: 'installation' }];
    expect(await releaserOffer([install('acme-releaser', 'releaser')])).toEqual(both);
    expect(await releaserOffer([install('acme-releaser', 'releaser')], { 'acme-releaser': { owner: { login: 'ACME' } } })).toEqual(both);
  }, 60_000);

  it("offers no App of another account's, none that subscribes to events, and none GitHub can't say whose it is, as the Releaser or the Judge (#462)", async () => {
    const theirs = { 'release-bot': { owner: { login: 'bot-maker' } }, 'acme-judge': { owner: { login: 'bot-maker' } } };
    const judge = [{ app: 'judge', slug: 'acme-judge', from: 'installation' }];
    expect(await releaserOffer([install('release-bot', 'releaser')], theirs)).toEqual([]);
    expect(await releaserOffer([install('acme-releaser', 'releaser', { events: ['push'] })])).toEqual(judge);
    expect(await releaserOffer([install('acme-releaser', 'releaser', { events: undefined })])).toEqual(judge);
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-judge', 'judge'), install('acme-releaser', 'releaser')] });
    const gh = github.gh;
    github.gh = async (args: string[], input?: string) => (args[1] === 'apps/acme-releaser' ? no('gh: Bad Gateway (HTTP 502)') : gh(args, input));
    const d = parse(await run(checkout({ '.github/workflows/release.yml': RELEASE_CALLER }), github, ['--json', '--lanes', 'review', '--releaser']));
    expect(d.inspection.ownerApps).toEqual([{ app: 'judge', slug: 'acme-judge', from: 'installation' }]);
    expect(d.apps).toMatchObject({ missing: ['judge', 'releaser'], reuse: [{ app: 'judge', slug: 'acme-judge', appId: 910 }] });
  }, 60_000);

  it("doesn't list the installations when the register names every App", async () => {
    const register = ['| Role | App slug |', '|---|---|', ...['Reviewer', 'Merger'].map((r) => `| ${r} | \`acme-judge\` |`), ...registerRolesOf('author', REQ).map((r) => `| ${r} | \`acme-author\` |`), ...registerRolesOf('releaser', REQ).map((r) => `| ${r} | \`acme-releaser\` |`), ''].join('\n');
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-judge-2', 'judge')] });
    const r = await run(checkout({ 'docs/qa/agent-identities.md': register }), github, ['--json']);
    expect(installsCalls(github)).toEqual([]);
    expect(parse(r).inspection.ownerApps).toEqual([]);
    expect(parse(r).answers.reuseApps).toBeNull();
  });

  it('creates the Apps as before when the installations cannot be listed, and says why', async () => {
    for (const kind of ['User', 'Organization'] as const) {
      const github = fakeGitHub({ kind, orgPlan: 'free' });
      const r = await run(checkout(), github, ['--json', '--no-apps']);
      const d = parse(r);
      expect(installsCalls(github).map((c) => c.args[1])).toEqual([kind === 'User' ? 'user/installations?per_page=100' : 'orgs/acme/installations?per_page=100']);
      expect(d.inspection.ownerApps).toBeNull();
      expect(d.answers.reuseApps).toBeNull();
      expect(d.apps).toMatchObject({ reuse: [], outcome: 'left-to-you' });
      const why = d.notes.find((n) => n.startsWith('Not looked for: '));
      expect(why).toContain("the token can't list acme's App installations (gh: Resource not accessible by personal access token (HTTP 403)), so init can't tell whether acme already has Kanon's Apps.");
      expect(why).toContain(kind === 'User' ? "On a personal account gh's token can't list them." : "Only an owner of acme can list them, with the organisation's Administration permission (read).");
      expect(d.findings.find((x) => x.id === 'app.create')!.fix.text).toContain("If acme already has this App for another repository, don't create it again");
    }
    // Listed, with none of Kanon's Apps: no such caution, and nothing asked.
    const none = parse(await run(checkout(), fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [] }), ['--json', '--no-apps']));
    expect(none.inspection.ownerApps).toEqual([]);
    expect(none.notes.some((n) => n.startsWith('Not looked for'))).toBe(false);
    expect(none.findings.find((x) => x.id === 'app.create')!.fix.text).not.toContain('already has');
  });
});
describe('the Apps (plan 0005 step L4)', () => {
  it('reads the Author and the Judge from the lanes\' secrets, and passes --apps', () => {
    expect(REQ.lanes['agent-review']!.identities).toEqual(['judge']);
    expect(REQ.lanes['agent-implement']!.identities).toEqual(['author']);
    expect(appsArgs(['author', 'judge'], REQ)).toEqual(['--apps', 'author,judge']);
    expect(registerRolesOf('author', REQ)).toEqual(['Implementer', 'Lead', 'Explorer', 'Overseer']);
    expect(registerRolesOf('judge', REQ)).toEqual(['Reviewer', 'Merger']);
    expect(registerRolesOf('releaser', REQ)).toEqual(['Releaser']);
  });

  it('joins an App the owner already has with kanon apps --reuse, never by a bare gh secret set', async () => {
    const register = '| Role | App slug |\n|---|---|\n| Reviewer | `acme-judge` |\n| Merger | `acme-judge` |\n';
    const dir = checkout({ 'docs/qa/agent-identities.md': register });
    const r = await run(dir, fakeGitHub(), ['--yes', '--lanes', 'review']);
    expect(r.status, r.err).toBe(0);
    expect(r.appsCalls).toEqual([]);
    expect(r.out).toContain('kanon apps --owner acme --repo widgets --reuse judge:acme-judge@<App ID>=<downloaded>.pem');
    expect(r.out).not.toMatch(/gh secret set JUDGE_APP/);
    // #637: where on the App's page the key is made, and GitHub's page on it.
    const f = parse(await run(checkout({ 'docs/qa/agent-identities.md': register }), fakeGitHub(), ['--json', '--lanes', 'review'])).findings.find((x) => x.id === 'app.reuse')!;
    expect(f.fix.text).toBe(`Add widgets to the App's installation, generate a private key on its settings page (Credentials → Key pairs → New key; GitHub's steps: ${KEYS_HELP}) and copy its App ID from the same page, then run kanon apps --reuse with both.`);
  });

  it('says, where it leaves the Apps to create, to reuse an App the owner already has rather than create a second (#363)', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--json', '--no-apps', '--lanes', 'review,implement']);
    const f = parse(r).findings.find((x) => x.id === 'app.create')!;
    expect(f.subject).toBe('author, judge');
    expect(f.fix.commands).toEqual([expect.stringMatching(/^kanon apps --owner acme --repo widgets --apps author,judge --dir /)]);
    expect(f.fix.text).toContain(`If acme already has these Apps for another repository, don't create them again: add widgets to each installation, generate a private key on its settings page (Credentials → Key pairs → New key; GitHub's steps: ${KEYS_HELP}) and copy its App ID from there, and run kanon apps --owner acme --repo widgets --reuse <app>:<slug>@<App ID>=<key file> instead`);
    expect(r.err).toContain("If acme already has these Apps for another repository, don't create them again");
  });

  // Plan 0007 §2.4: Releases is inferred, never asked: on for a repository that calls the release
  // workflow, off otherwise, and shown in the summary either way.
  it('creates the Releaser beside the Judge when the repository calls the release workflow, unless told not to', async () => {
    const caller = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';
    const yes = await run(checkout({ '.github/workflows/release.yml': caller }), fakeGitHub(), ['--yes', '--lanes', 'review']);
    expect(yes.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge,releaser', '--dir', expect.any(String)]]);
    expect(yes.out).toMatch(/^Releases {7}on: the Releaser App opens the release PRs +inferred: the repository calls Kanon's release workflow$/m);
    for (const flag of ['--no-releases', '--no-releaser']) {
      const no = await run(checkout({ '.github/workflows/release.yml': caller }), fakeGitHub(), ['--yes', '--lanes', 'review', flag]);
      expect(no.appsCalls, flag).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge', '--dir', expect.any(String)]]);
    }
    // Changed through the summary, in today's question.
    const changed = await run(checkout({ '.github/workflows/release.yml': caller }), fakeGitHub(), [], undefined, REQ, { ask: changing('2', { 'optional Releaser': 'n' }) });
    expect(changed.appsCalls[0]).toEqual(['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge', '--dir', expect.any(String)]);
    const none = await run(checkout(), fakeGitHub(), ['--lanes', 'review'], undefined, REQ, { ask: changing('2', { 'optional Releaser': 'y' }) });
    expect(none.out).toMatch(/^Releases {7}off +inferred: no release workflow$/m);
    expect(none.appsCalls[0]).toContain('judge');
    expect(none.out).not.toContain('Releaser');
  }, 60_000);

  it('maps the Releaser\'s secrets in the apps-check caller it writes, when it creates the Releaser', async () => {
    const caller = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';
    const dir = checkout({ '.github/workflows/release.yml': caller });
    await run(dir, fakeGitHub(), ['--lanes', 'review'], { 'optional Releaser': 'y' });
    const check = read(dir, '.github/workflows/apps-check.yml');
    for (const s of ['JUDGE_APP_ID', 'JUDGE_APP_PRIVATE_KEY', 'RELEASER_APP_ID', 'RELEASER_APP_PRIVATE_KEY']) expect(check).toContain(`${s}: \${{ secrets.${s} }}`);
  }, 60_000);

  it('refuses a role where an App belongs: kanon apps takes no --roles since L4', () => {
    expect(() => appsArgs(['author', 'reviewer'], REQ)).toThrow(/the lanes run as reviewer, which is not one of Kanon's Apps/);
  });

  it("asks for the Author's broadened Commit statuses write through the App's manifest, not a role's", () => {
    expect(REQ.identities.apps.author!.permissions.statuses).toBe('write');
    expect(REQ.identities.apps.judge!.permissions.statuses).toBe('read');
  });

  it('adds the Releaser only when asked, and only for a repository that calls Kanon\'s release workflow', () => {
    expect(appIdentities({ lanes: ['agent-review'] }, REQ)).toEqual(['judge']);
    expect(appIdentities({ lanes: ['agent-review'], releaser: true }, REQ)).toEqual(['judge', 'releaser']);
    expect(callsRelease('jobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n')).toBe(true);
    expect(callsRelease('# uses: yedeya-labs/kanon/.github/workflows/release.yml@v1\n')).toBe(false);
    expect(callsRelease(null)).toBe(false);
  });
});
describe('the helpers', () => {
  it('diffs line by line', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual(['  a', '- b', '+ x', '  c']);
  });

  it('finds no gap in a ruleset with every rule, and each missing one by name', () => {
    const full = [{ rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: LANE_CHECK }] } }] }];
    expect(rulesetGaps(full)).toEqual([]);
    expect(rulesetGaps([])).toEqual(['require a pull request before merging', 'block force pushes', 'restrict deletions', `require the status check "${LANE_CHECK}"`]);
  });
});
