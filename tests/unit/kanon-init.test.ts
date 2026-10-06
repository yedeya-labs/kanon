import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeRegisterRow } from '../../cli/app-register.mjs';
import { loadRequirements, TRIGGERS } from '../../cli/callers.mjs';
import { appIdentities, appsArgs, callsRelease, CONFLICTS, init, LANE_CHECK, lineDiff, parseArgs, registerRolesOf, RULESET_NAME, rulesetGaps, SCHEMA, USAGE, workflowName } from '../../cli/init.mjs';

/**
 * `kanon init` (plan 0005 §5.4, step L9). Every case runs the command against a real git
 * checkout in a temporary directory and a FAKE GitHub: `gh` is a function holding one
 * repository's state (its labels, milestones, rulesets, secrets and settings), so a second run
 * sees what the first created, and nothing reaches the network. `kanon apps` and `kanon
 * milestones` are stubbed: no App, secret, label or ruleset is ever created anywhere real.
 *
 * The plan's falsifiable checks for L9:
 *  - on an empty fixture repository, `init` with every default accepted writes files that pass
 *    `lane-check` for the Reviewer's lane (run as the real script, from this tree);
 *  - run a second time, it changes nothing and says so;
 *  - deleting one label after the first run makes the second run create exactly that label.
 */
const ROOT = process.cwd();
const LANE_CHECK_SH = join(ROOT, 'actions/lane-check/lane-check.sh');
const hasYq = spawnSync('yq', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasYq && process.env.CI) throw new Error('kanon init tests need yq on PATH in CI');
const REQ = loadRequirements();
const TAXONOMY = (JSON.parse(readFileSync(join(ROOT, 'rulebook/labels.json'), 'utf8')).labels as Array<{ name: string }>).map((l) => l.name).filter((n) => !/<[a-z]+>$/.test(n));
const REPO = 'acme/widgets';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A checkout of acme/widgets with no files, or with the given ones, committed or not. */
const checkout = (files: Record<string, string> = {}, remote = `https://github.com/${REPO}.git`) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-init-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada Lovelace']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.com']);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
};

type Gh = { status: number; stdout: string; stderr: string };
const ok = (v: unknown): Gh => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
const no = (stderr: string): Gh => ({ status: 1, stdout: '', stderr });

type State = {
  kind: 'User' | 'Organization';
  private: boolean;
  admin: boolean;
  hasCommits: boolean;
  rulesetsOnPlan: boolean;
  orgPlan?: string;
  labels: Set<string>;
  milestones: Set<string>;
  secrets: Set<string> | null;
  rulesets: Array<Record<string, unknown> & { id: number }>;
  settings: Record<string, unknown>;
  labelCreateFails?: boolean;
};

/** A fake GitHub for one repository. Every call is recorded; the mutating ones change the state. */
const fakeGitHub = (over: Partial<State> = {}) => {
  const st: State = {
    kind: 'User',
    private: false,
    admin: true,
    hasCommits: true,
    rulesetsOnPlan: true,
    labels: new Set(['bug', 'documentation', 'enhancement', 'question']),
    milestones: new Set(),
    secrets: new Set(),
    rulesets: [],
    settings: { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, squash_merge_commit_title: 'COMMIT_OR_PR_TITLE', squash_merge_commit_message: 'COMMIT_MESSAGES' },
    ...over,
  };
  const calls: Array<{ args: string[]; input?: string }> = [];
  const gh = async (args: string[], input?: string): Promise<Gh> => {
    calls.push({ args, input });
    const [a0, a1] = args;
    if (a0 === 'api' && a1 === 'user') return ok('octo\n');
    if (a0 === 'secret' && a1 === 'list') return st.secrets ? ok([...st.secrets].map((name) => ({ name }))) : no('gh: Resource not accessible by integration (HTTP 403)');
    if (a0 === 'label' && a1 === 'create') {
      if (st.labelCreateFails) return no('gh: Resource not accessible by personal access token (HTTP 403)');
      st.labels.add(args[2]!);
      return ok('');
    }
    if (a0 === 'label' && a1 === 'delete') {
      st.labels.delete(args[2]!);
      return ok('');
    }
    if (a0 !== 'api') return no(`unexpected gh ${args.join(' ')}`);
    const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
    const path = args.find((x, i) => i > 0 && /^(repos|orgs)\//.test(x)) ?? '';
    if (method === 'PATCH' && path === `repos/${REPO}`) {
      if (!st.admin) return no('gh: Must have admin rights to Repository. (HTTP 403)');
      for (const f of args.filter((x, i) => args[i - 1] === '-f' || args[i - 1] === '-F')) {
        const [k, v] = [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)];
        st.settings[k] = v === 'true' ? true : v === 'false' ? false : v;
      }
      return ok('{}');
    }
    if (method === 'POST' && path === `repos/${REPO}/rulesets`) {
      if (!st.admin) return no('gh: Must have admin rights to Repository. (HTTP 403)');
      st.rulesets.push({ id: st.rulesets.length + 100, ...JSON.parse(input ?? '{}') });
      return ok('{}');
    }
    if (method !== 'GET') return no(`unexpected gh ${args.join(' ')}`);
    if (path === `repos/${REPO}`) {
      return ok({ private: st.private, default_branch: 'main', owner: { login: 'acme', type: st.kind }, permissions: { admin: st.admin }, ...st.settings });
    }
    if (path === `repos/${REPO}/branches/main`) return st.hasCommits ? ok('main') : no('gh: Branch not found (HTTP 404)');
    if (path.startsWith(`repos/${REPO}/rulesets?`)) {
      if (!st.rulesetsOnPlan) return no('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)');
      return ok(st.rulesets.map((r) => ({ id: r.id, name: r.name, target: r.target })));
    }
    const one = /^repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(path);
    if (one) return ok(st.rulesets.find((r) => r.id === Number(one[1])));
    if (path === 'orgs/acme') return st.orgPlan ? ok({ plan: { name: st.orgPlan } }) : no('gh: Not Found (HTTP 404)');
    if (path.startsWith(`repos/${REPO}/labels?`)) return ok([[...st.labels].map((name) => ({ name }))]);
    if (path.startsWith(`repos/${REPO}/milestones?`)) return ok([[...st.milestones].map((title) => ({ title }))]);
    return no(`unexpected gh ${args.join(' ')}`);
  };
  return { st, gh, calls };
};

/** The calls that change something on GitHub. */
const writes = (calls: Array<{ args: string[] }>) =>
  calls.map((c) => c.args).filter((a) => (a[0] === 'label' && a[1] !== 'list') || a.includes('PATCH') || a.includes('POST') || a.includes('DELETE'));

type Run = { status: number; out: string; err: string; appsCalls: string[][]; milestoneCalls: string[][] };

const run = async (dir: string, github: ReturnType<typeof fakeGitHub>, argv: string[] = ['--yes'], answers?: Record<string, string>, requirements = REQ, extra: NonNullable<Parameters<typeof init>[1]> = {}): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  const appsCalls: string[][] = [];
  const milestoneCalls: string[][] = [];
  const status = await init(['--dir', dir, ...argv], {
    gh: github.gh,
    env: {},
    requirements: () => requirements,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    today: () => '2026-10-05',
    ask: async (q: string, d: string) => {
      const key = Object.keys(answers ?? {}).find((k) => q.includes(k));
      return key ? answers![key]! : d;
    },
    // `kanon apps`, stubbed: it writes the register rows the real one writes after the Owner
    // clicks Create and Install, and sets the App secrets, and nothing else.
    apps: async (args: string[]) => {
      appsCalls.push(args);
      // One row per role of each App, the rows sharing the App's slug (plan 0005 §3.4).
      const apps = args[args.indexOf('--apps') + 1]!.split(',');
      const register = join(dir, 'docs/qa/agent-identities.md');
      let text = existsSync(register) ? readFileSync(register, 'utf8') : null;
      for (const app of apps) {
        const spec = REQ.identities.apps[app]!;
        for (const r of registerRolesOf(app, REQ)) {
          text = writeRegisterRow(text, { role: r, slug: `acme-${app}`, permissions: spec.permissions }).text;
        }
        for (const s of [`${app.toUpperCase()}_APP_ID`, `${app.toUpperCase()}_APP_PRIVATE_KEY`]) github.st.secrets?.add(s);
      }
      mkdirSync(dirname(register), { recursive: true });
      writeFileSync(register, text!);
      return 0;
    },
    milestones: async (args: string[]) => {
      milestoneCalls.push(args);
      github.st.milestones.add('Product Backlog');
      github.st.milestones.add('Development Automation');
      return 0;
    },
    ...extra,
  });
  return { status, out: out.join('\n'), err: err.join('\n'), appsCalls, milestoneCalls };
};

const laneCheck = (dir: string) => {
  const r = spawnSync('bash', [LANE_CHECK_SH], { cwd: dir, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

describe('kanon init, on an empty repository with every default (plan 0005 L9)', () => {
  it.skipIf(!hasYq)('writes files that pass lane-check for the Reviewer\'s lane', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    const r = await run(dir, github);
    expect(r.status, `${r.out}\n${r.err}`).toBe(0);
    expect(r.err).toBe('');
    const lc = laneCheck(dir);
    expect(lc.status, lc.out).toBe(0);
    expect(lc.out).toContain('1 lane caller(s) pass');
    // Only the sections with no default: no playbook, no escalation or exemptions file, no
    // test-database declaration, no delegation, and the stack document's `## Gates` alone.
    for (const f of ['docs/qa/reviewer-playbook.md', 'docs/qa/escalation-paths.md', 'docs/qa/exemptions.md', 'docs/qa/test-database.md', 'docs/qa/sign-off-delegation.md']) {
      expect(existsSync(join(dir, f)), f).toBe(false);
    }
    expect(read(dir, 'docs/qa/stack.md')).not.toMatch(/## (Schema changes|Data isolation|Generated files)/);
    expect(read(dir, 'docs/qa/adoption.md')).not.toContain('## Choices');
  }, 30_000);

  it('pins every Kanon reference it writes to the release it runs from', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub());
    const release = `v${JSON.parse(read(ROOT, 'package.json')).version}`;
    const refs = ['.github/workflows/agent-review.yml', '.github/workflows/apps-check.yml', '.github/workflows/ci.yml'].flatMap((f) => [...read(dir, f).matchAll(/yedeya-labs\/kanon\/[^@\s]+@(\S+)/g)].map((m) => m[1]));
    expect(refs.length).toBe(3);
    expect(new Set(refs)).toEqual(new Set([release]));
  });

  it('creates the taxonomy, the buckets, the merge setting and the ruleset, and runs kanon apps for the Judge, the Reviewer\'s App', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    const r = await run(dir, github);
    expect([...github.st.labels].filter((l) => TAXONOMY.includes(l)).sort()).toEqual([...TAXONOMY].sort());
    // GitHub's defaults outside the taxonomy are kept unless the adopter says to delete them.
    expect(github.st.labels.has('question')).toBe(true);
    expect(r.milestoneCalls).toEqual([['--repo', REPO]]);
    expect(github.st.settings).toMatchObject({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' });
    expect(github.st.rulesets).toHaveLength(1);
    const rules = github.st.rulesets[0]!.rules as Array<{ type: string; parameters?: Record<string, unknown> }>;
    expect(github.st.rulesets[0]!.name).toBe(RULESET_NAME);
    expect(rules.map((x) => x.type)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
    expect(rules[2]!.parameters).toMatchObject({ required_approving_review_count: 0, allowed_merge_methods: ['squash'] });
    expect(rules[3]!.parameters).toMatchObject({ required_status_checks: [{ context: LANE_CHECK }] });
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge', '--dir', expect.any(String)]]);
    expect(r.out).toContain('gh secret set CLAUDE_CODE_OAUTH_TOKEN -R acme/widgets');
  });

  it('changes nothing on a second run, and says so', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    await run(dir, github);
    const before = github.calls.length;
    const again = await run(dir, github);
    expect(again.status, again.out).toBe(0);
    expect(writes(github.calls.slice(before))).toEqual([]);
    expect(again.appsCalls).toEqual([]);
    expect(again.milestoneCalls).toEqual([]);
    expect(again.out).toContain('Nothing changed: everything init sets up is already right.');
    expect(again.out).not.toMatch(/^wrote /m);
    expect(again.out).toContain('.github/workflows/agent-review.yml: already as init writes it.');
    expect(again.out).not.toContain('exists and differs');
  });

  it('creates exactly the label deleted after the first run', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    await run(dir, github);
    github.st.labels.delete('qa:needs-split');
    const before = github.calls.length;
    const again = await run(dir, github);
    expect(writes(github.calls.slice(before))).toEqual([['label', 'create', 'qa:needs-split', '--color', expect.any(String), '--description', expect.any(String), '-R', REPO]]);
    expect(again.out).toContain('- Created the label qa:needs-split');
  });
});

describe('kanon init, on what the plan and the token allow', () => {
  it('says plainly that the platform does not enforce review on a free private repository, and creates no ruleset', async () => {
    const dir = checkout();
    const github = fakeGitHub({ private: true, rulesetsOnPlan: false });
    const r = await run(dir, github);
    expect(r.status).toBe(0);
    expect(r.out).toContain('THE PLATFORM DOES NOT ENFORCE REVIEW ON acme/widgets');
    expect(r.out).toContain('a person can merge past the Reviewer');
    expect(github.calls.filter((c) => c.args.includes('POST'))).toEqual([]);
    expect(read(dir, 'docs/qa/adoption.md')).toContain("stays in bootstrap and can't leave it");
  });

  it('prints exact steps for what a token without Administration or Issues write cannot do, and still exits 0', async () => {
    const dir = checkout();
    const github = fakeGitHub({ admin: false, labelCreateFails: true });
    const r = await run(dir, github);
    expect(r.status, r.err).toBe(0);
    expect(github.st.rulesets).toEqual([]);
    expect(r.out).toContain('gh label create qa:needs-split --color');
    expect(r.out).toContain('gh api -X PATCH repos/acme/widgets -F allow_merge_commit=false');
    expect(r.out).toContain(`gh api -X POST repos/acme/widgets/rulesets --input - <<'JSON'`);
    const body = r.out.split(`--input - <<'JSON'\n`)[1]!.split('\n')[0]!.trim();
    expect(JSON.parse(body).rules.map((x: { type: string }) => x.type)).toContain('required_status_checks');
  });

  it("adds the merge queue on an organisation's public repository", async () => {
    const dir = checkout();
    const github = fakeGitHub({ kind: 'Organization' });
    await run(dir, github);
    const rules = github.st.rulesets[0]!.rules as Array<{ type: string; parameters?: Record<string, unknown> }>;
    expect(rules.map((x) => x.type)).toContain('merge_queue');
    expect(read(dir, 'docs/qa/adoption.md')).not.toContain('personal account');
  });

  it('creates no ruleset on a repository with no commit yet, and says to push the first one first (K-ADOPT-4)', async () => {
    const dir = checkout();
    const github = fakeGitHub({ hasCommits: false });
    const r = await run(dir, github);
    expect(github.st.rulesets).toEqual([]);
    expect(r.out).toContain('Push the first commit straight to main (K-ADOPT-4), then run kanon init again');
  });

  it("doesn't count a disabled or evaluate-only ruleset as covering the branch: it says so and creates its own", async () => {
    const dir = checkout();
    const full = { conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, target: 'branch', rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: LANE_CHECK }] } }] };
    const github = fakeGitHub({ rulesets: [{ id: 7, name: 'off', enforcement: 'disabled', ...full }, { id: 8, name: 'trial', enforcement: 'evaluate', ...full }] });
    const r = await run(dir, github);
    expect(r.out).not.toContain('has every rule');
    expect(r.out).toContain('Not counted: the ruleset(s) "off" (disabled), "trial" (evaluate) on main, which enforce nothing.');
    expect(github.st.rulesets.map((x) => x.name)).toEqual(['off', 'trial', RULESET_NAME]);
  });

  it('says it does not know the merge queue when the token cannot read an organisation\'s plan', async () => {
    const dir = checkout();
    const r = await run(dir, fakeGitHub({ kind: 'Organization', private: true }));
    expect(read(dir, 'docs/qa/adoption.md')).toContain("**Merge queue:** not known: the token can't read the organisation's plan.");
    expect(r.out).toContain("Merge queue not known: the token can't read the organisation's plan.");
    expect(r.out).not.toContain('No merge queue on this plan');
  });

  it('stops with its own message, not a stack trace, when a release\'s lanes name a role rather than an App', async () => {
    const mixed = structuredClone(REQ);
    mixed.lanes['agent-review']!.identities = ['judge'];
    mixed.lanes['agent-triage']!.identities = ['implementer'];
    const r = await run(checkout(), fakeGitHub(), ['--yes', '--lanes', 'review,triage'], undefined, mixed);
    expect(r.status).toBe(1);
    expect(r.err).toContain("kanon init: the lanes run as implementer, which is not one of Kanon's Apps (author, judge, releaser)");
    expect(r.appsCalls).toEqual([]);
  });

  it("names what an existing default-branch ruleset lacks, and doesn't change it", async () => {
    const dir = checkout();
    const existing = { id: 7, name: 'protect main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'] } }] };
    const github = fakeGitHub({ rulesets: [existing] });
    const r = await run(dir, github);
    expect(github.st.rulesets).toEqual([existing]);
    expect(r.out).toContain('The ruleset on main (protect main) lacks some of K-ADOPT-1 step 8');
    for (const g of ['block force pushes', 'restrict deletions', 'allow the squash merge method only', `require the status check "${LANE_CHECK}"`]) expect(r.out).toContain(`- ${g}`);
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
});

describe('kanon init, from the answers', () => {
  it.skipIf(!hasYq)('writes the gates, a sign-off delegation and a test-database declaration that the readers accept', async () => {
    const dir = checkout({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }) });
    const r = await run(dir, fakeGitHub(), [], { 'sign-off delegation': 'y', 'test database': 'hook', 'Who is the Owner': 'grace' });
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
    await run(checkout(), github, [], { "Delete GitHub's default labels": 'y' });
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
    ...(t.issues ? [`issues:${[...t.issues].sort().join(',')}`] : []),
    ...(t.schedule ? ['schedule'] : []),
    `workflow_dispatch:${Object.keys(t.dispatch).sort().join(',')}`,
  ];

  it("holds each lane's triggers to docs/lanes.md's table, event by event", () => {
    const section = readFileSync(join(ROOT, 'docs/lanes.md'), 'utf8').split('## Which lanes are available')[1]!.split('\n## ')[0]!;
    const rows = [...section.matchAll(/^\| [^|]+\| `(agent-[a-z-]+)\.yml` \| [^|]+\| (.+) \|$/gm)];
    expect(rows.length).toBe(Object.keys(TRIGGERS).length);
    for (const [, lane, cell] of rows) expect(fromTriggers(TRIGGERS[lane!]!).sort(), lane).toEqual(fromTable(cell!).sort());
  });

  it.skipIf(!hasYq)('passes lane-check with a caller for every lane at once', async () => {
    const dir = checkout({
      // What init leaves to the project: the Explorer's sweep hook and the Overseer's ledger.
      '.github/actions/explore-sweep/action.yml': 'name: Sweep\ndescription: x\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: "true"\n',
      'docs/qa/capability-ledger.md': '# Capability ledger\n',
    });
    const all = Object.keys(REQ.lanes).map((l) => l.slice('agent-'.length)).join(',');
    const github = fakeGitHub();
    const r = await run(dir, github, ['--yes', '--lanes', all]);
    expect(r.status, r.err).toBe(0);
    expect(r.appsCalls[0]).toContain('author,judge');
    const lc = laneCheck(dir);
    expect(lc.status, lc.out).toBe(0);
    expect(lc.out).toContain(`${Object.keys(REQ.lanes).length} lane caller(s) pass`);
    expect(r.out).toContain('gh secret set DIGEST_WEBHOOK -R acme/widgets');
  }, 60_000);
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
    expect(r.out).toContain('kanon apps --owner acme --repo widgets --reuse judge:acme-judge=<downloaded>.pem');
    expect(r.out).not.toMatch(/gh secret set JUDGE_APP/);
  });

  it('creates the Releaser beside the Judge when the repository calls the release workflow and the adopter says yes', async () => {
    const caller = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';
    const yes = await run(checkout({ '.github/workflows/release.yml': caller }), fakeGitHub(), ['--lanes', 'review'], { 'optional Releaser': 'y' });
    expect(yes.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge,releaser', '--dir', expect.any(String)]]);
    const no = await run(checkout({ '.github/workflows/release.yml': caller }), fakeGitHub(), ['--yes', '--lanes', 'review']);
    expect(no.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge', '--dir', expect.any(String)]]);
    const none = await run(checkout(), fakeGitHub(), ['--lanes', 'review'], { 'optional Releaser': 'y' });
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

/** docs/init.md, which documents the flags. */
const INIT_DOC = readFileSync(join(ROOT, 'docs/init.md'), 'utf8');

/** A column of the tables under a `### <heading>` (or `## <heading>`) of docs/init.md, header and rule rows left out. */
const tableColumn = (heading: string, which = 0): string[] => {
  const start = INIT_DOC.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`docs/init.md has no "${heading}" heading`);
  const rest = INIT_DOC.slice(start + heading.length + 2);
  const end = rest.search(/\n#{2,3} /);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^\|(.+)\|$/gm)]
    .map((m) => m[1]!.split(/(?<!\\)\|/).map((c) => c.trim()))
    .filter((c) => !/^-+$/.test(c[0]!) && !['Field', 'Status', 'Id', 'Question'].includes(c[0]!))
    .map((c) => c[which]!);
};

/**
 * `kanon init --json` (#365, ADR 0014 decision 2): one document on standard output, its shape
 * held to docs/init.md's tables, which docs/cli-json.md's convention frames.
 */
/** The first table of a section: the document's own fields, not the status table after it. */
const fields = (heading: string) => tableColumn(heading).map((c) => /^`([^`]+)`$/.exec(c)?.[1] ?? c);

type Doc = Record<string, unknown> & {
  schema: string; status: string; exitCode: number; dryRun: boolean;
  inspection: Record<string, unknown>; answers: Record<string, unknown>;
  files: Array<Record<string, unknown>>; changes: Array<Record<string, unknown>>; apps: Record<string, unknown>;
  findings: Array<{ id: string; category: string; blocking: boolean; subject: string; message: string; fix: { text: string; commands: string[]; url: string | null } }>;
  notes: string[]; failures: string[];
};
const parse = (r: Run): Doc => JSON.parse(r.out) as Doc;
const keys = (o: object) => Object.keys(o).sort();

describe('kanon init --json, the contract (docs/init.md)', () => {
  const STATUSES = ['complete', 'steps-left', 'failed', 'error'];
  // The document's own fields are the rows of its table that come before the status table.
  const DOC_FIELDS = fields('### The document').filter((f) => !STATUSES.includes(f));

  it('prints one document on standard output, the prose on standard error, with every field docs/init.md lists and no other', async () => {
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--yes', '--json']);
    expect(r.status, r.err).toBe(0);
    const d = parse(r);
    expect(r.err).toContain('== Summary ==');
    expect(r.out).not.toContain('== Summary ==');
    expect(keys(d)).toEqual([...DOC_FIELDS].sort());
    expect(d.schema).toBe(SCHEMA);
    expect(SCHEMA).toBe('kanon-init/v1');
    expect(d.kanon).toBe(`v${JSON.parse(read(ROOT, 'package.json')).version}`);
    expect(d.status).toBe('steps-left');
    expect(d.exitCode).toBe(0);
    expect(d.repository).toBe(REPO);
    expect(d.token).toEqual({ source: 'gh', login: 'octo' });
    expect(keys(d.inspection)).toEqual(fields('### The inspection').sort());
    expect(keys(d.answers)).toEqual(fields('### The answers').sort());
    expect(keys(d.apps)).toEqual(fields('### The Apps').sort());
    expect(d.files.length).toBeGreaterThan(0);
    for (const f of d.files) expect(keys(f)).toEqual(fields('### A file').sort());
    for (const c of d.changes) expect(keys(c)).toEqual(fields('### A change').sort());
    for (const f of d.findings) {
      expect(keys(f)).toEqual(['blocking', 'category', 'fix', 'id', 'message', 'subject']);
      expect(keys(f.fix)).toEqual(['commands', 'text', 'url']);
    }
    expect(d.inspection).toMatchObject({ owner: 'acme', ownerKind: 'user', private: false, defaultBranch: 'main', rulesets: 'yes', installedLanes: [], callsRelease: false });
    expect(d.answers).toEqual({ projectOwner: 'octo', maintainer: 'octo', stakeholder: 'octo', lanes: ['agent-review'], gates: [], testDatabase: 'none', delegation: null, deleteDefaultLabels: false, releaser: false });
    expect(d.apps).toEqual({ identities: ['judge'], missing: ['judge'], command: expect.stringMatching(/^kanon apps --owner acme --repo widgets --apps judge --dir /), outcome: 'ran', exitCode: 0 });
    expect(d.files.find((f) => f.path === '.github/workflows/agent-review.yml')).toMatchObject({ status: 'new', content: read(dir, '.github/workflows/agent-review.yml'), diff: [] });
    expect(d.findings.map((f) => f.id)).toEqual(['secret.claude-code-oauth-token']);
    expect(d.findings[0]!.fix.commands).toEqual(['gh secret set CLAUDE_CODE_OAUTH_TOKEN -R acme/widgets   # paste it on standard input']);
    expect(d.notes).toContain('init commits nothing: review the files, then commit them on a branch and open a pull request.');
  });

  it('is the same run as the prose: the same exit code, changes in the summary\'s order, findings in its numbering', async () => {
    const opts = { admin: false, labelCreateFails: true };
    const prose = await run(checkout(), fakeGitHub(opts), ['--yes']);
    const json = await run(checkout(), fakeGitHub(opts), ['--yes', '--json']);
    expect(json.status).toBe(prose.status);
    expect(json.err.replace(/kanon-init-[^/\s]+/g, '<dir>')).toBe(prose.out.replace(/kanon-init-[^/\s]+/g, '<dir>'));
    const d = parse(json);
    const summary = prose.out.split('== Summary ==\n')[1]!;
    expect(d.changes.map((c) => `- ${c.message}`)).toEqual(summary.split('\n').filter((l) => l.startsWith('- ')));
    const numbered = [...summary.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
    expect(d.findings).toHaveLength(numbered.length);
    expect(d.findings.map((f) => f.id)).toEqual(['label.create', 'merge.settings', 'ruleset.create', 'secret.claude-code-oauth-token']);
    expect(numbered[0]).toBe('Create the labels the token could not (it needs Issues: write):');
  });

  it('says what a dry run would do, and does nothing', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    const r = await run(dir, github, ['--json', '--dry-run']);
    const d = parse(r);
    expect(d.dryRun).toBe(true);
    expect(writes(github.calls)).toEqual([]);
    expect(r.appsCalls).toEqual([]);
    expect(d.apps.outcome).toBe('would-run');
    expect(d.files.every((f) => f.status === 'new')).toBe(true);
    expect(d.changes.map((c) => c.kind)).toContain('ruleset');
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('reports complete when nothing is left, and the files already as init writes them', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    await run(dir, github);
    github.st.secrets!.add('CLAUDE_CODE_OAUTH_TOKEN');
    const d = parse(await run(dir, github, ['--json']));
    expect(d.status).toBe('complete');
    expect(d.findings).toEqual([]);
    expect(d.changes).toEqual([]);
    expect(d.apps.outcome).toBe('registered');
    expect(new Set(d.files.map((f) => f.status))).toEqual(new Set(['same']));
  });

  it('reports failed, exit 1, and a blocking finding when kanon apps does not finish', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, { apps: async () => 3 });
    expect(r.status).toBe(1);
    const d = parse(r);
    expect(d).toMatchObject({ status: 'failed', exitCode: 1, failures: ['kanon apps did not finish (exit 3).'] });
    expect(d.apps).toMatchObject({ outcome: 'failed', exitCode: 3 });
    expect(d.findings.find((f) => f.id === 'app.failed')).toMatchObject({ blocking: true, category: 'app', subject: 'judge' });
  });

  it('prints the error document, and nothing else, when it cannot start', async () => {
    const bad = await run(checkout(), fakeGitHub(), ['--json', '--bogus']);
    expect(bad.status).toBe(2);
    const d = JSON.parse(bad.out);
    expect(keys(d)).toEqual(['error', 'exitCode', 'kanon', 'schema', 'status']);
    expect(d).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: 'unknown argument "--bogus"' });
    const none = mkdtempSync(join(tmpdir(), 'kanon-init-json-none-'));
    dirs.push(none);
    const notCheckout = await run(none, fakeGitHub(), ['--json']);
    expect(notCheckout.status).toBe(1);
    expect(JSON.parse(notCheckout.out)).toMatchObject({ status: 'error', exitCode: 1, error: expect.stringContaining('is not a git checkout') });
  });

  it('sends the prose of kanon apps and kanon milestones to standard error too', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, {
      apps: async (_argv: string[], io?: { out: (l: string) => void }) => (io?.out('APPS PROSE'), 0),
      milestones: async (_argv: string[], io?: { out: (l: string) => void }) => (io?.out('MILESTONES PROSE'), 0),
    });
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.err).toContain('APPS PROSE');
    expect(r.err).toContain('MILESTONES PROSE');
  });

  it('gives every finding a documented id, and documents only ids the code gives', async () => {
    const source = readFileSync(join(ROOT, 'cli/init.mjs'), 'utf8');
    const inCode = [...source.matchAll(/\bid: '([a-z-]+\.[a-z-]+)'/g)].map((m) => m[1]!).sort();
    const documented = fields('### The findings').sort();
    expect(inCode).toEqual(documented);
    const categories = new Map(tableColumn('### The findings').map((id, i) => [id.replace(/`/g, ''), tableColumn('### The findings', 1)[i]!.replace(/`/g, '')]));
    // The findings these fixtures produce carry their documented category.
    const dep = checkout({ '.github/dependabot.yml': 'version: 2\nupdates: []\n' });
    const d = parse(await run(dep, fakeGitHub({ admin: false, labelCreateFails: true, secrets: null }), ['--json', '--no-apps']));
    expect(d.findings.map((f) => f.id)).toEqual(['dependabot.kanon-entry', 'label.create', 'merge.settings', 'ruleset.create', 'app.create', 'secret.unreadable']);
    for (const f of d.findings) expect(f.category, f.id).toBe(categories.get(f.id));
    expect(d.apps.outcome).toBe('left-to-you');
  });

  it('documents each status the document can carry', () => {
    expect(tableColumn('### The document').filter((c) => /^`[a-z-]+`$/.test(c) && STATUSES.includes(c.replace(/`/g, '')))).toHaveLength(STATUSES.length);
  });
});

describe('kanon init, a flag for each question (#367)', () => {
  const never = async (q: string): Promise<string> => {
    throw new Error(`asked "${q}"`);
  };
  const RELEASE_CALLER = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';

  it('answers every question from its flag with --yes, asking nothing', async () => {
    const dir = checkout({ '.github/workflows/release.yml': RELEASE_CALLER });
    const github = fakeGitHub();
    const r = await run(dir, github, [
      '--yes', '--project-owner', 'grace', '--maintainer', 'linus', '--stakeholder=ada', '--lanes', 'review', '--gates', 'make check, make lint',
      '--test-database', 'hook', '--delegate-name', 'Grace Hopper', '--delegate-email', 'grace@example.com', '--delete-default-labels', '--releaser', '--create-apps',
    ], undefined, REQ, { ask: never });
    expect(r.status, r.err).toBe(0);
    const adoption = read(dir, 'docs/qa/adoption.md');
    for (const row of ['| Owner | `@grace` |', '| Maintainer | `@linus` |', '| Stakeholder | `@ada` |']) expect(adoption).toContain(row);
    expect(read(dir, 'docs/qa/stack.md')).toContain('1. `make check`\n2. `make lint`');
    expect(read(dir, 'docs/qa/test-database.md')).toContain('**Test database:** `hook`');
    expect(read(dir, 'docs/qa/sign-off-delegation.md')).toContain('| Grace Hopper | grace@example.com | 2026-10-05 |');
    expect(github.st.labels.has('question')).toBe(false);
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge,releaser', '--dir', expect.any(String)]]);
  });

  it('answers the other way from the negative flags, and with --gates none', async () => {
    const dir = checkout({ '.github/workflows/release.yml': RELEASE_CALLER, 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
    const github = fakeGitHub();
    const r = await run(dir, github, ['--yes', '--gates', 'none', '--test-database', 'none', '--no-delegation', '--keep-default-labels', '--no-releaser', '--no-apps'], undefined, REQ, { ask: never });
    expect(r.status, r.err).toBe(0);
    expect(read(dir, 'docs/qa/stack.md')).toContain('None yet');
    expect(existsSync(join(dir, 'docs/qa/sign-off-delegation.md'))).toBe(false);
    expect(existsSync(join(dir, 'docs/qa/test-database.md'))).toBe(false);
    expect(github.st.labels.has('question')).toBe(true);
    expect(r.appsCalls).toEqual([]);
    expect(r.out).toContain('Create the Apps the lanes run as, from this checkout');
  });

  it('asks, without --yes, only the questions no flag answers', async () => {
    const asked: string[] = [];
    const r = await run(checkout(), fakeGitHub(), ['--project-owner', 'grace', '--gates', 'none', '--no-delegation', '--create-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (asked.push(q), d),
    });
    expect(r.status, r.err).toBe(0);
    expect(asked.some((q) => q.includes('Who is the Owner'))).toBe(false);
    expect(asked.some((q) => q.includes("stack's gates"))).toBe(false);
    expect(asked.some((q) => q.includes('sign-off delegation'))).toBe(false);
    expect(asked.some((q) => q.includes('Create the Apps'))).toBe(false);
    expect(asked.some((q) => q.includes('Who is the Maintainer'))).toBe(true);
    expect(asked.some((q) => q.includes('test database'))).toBe(true);
    expect(r.appsCalls).toHaveLength(1);
  });

  it('holds a negative flag against a person who would say yes, without --yes', async () => {
    const dir = checkout({ '.github/workflows/release.yml': RELEASE_CALLER });
    const github = fakeGitHub();
    const asked: string[] = [];
    const r = await run(dir, github, ['--no-releaser', '--keep-default-labels', '--no-delegation', '--no-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (asked.push(q), q.endsWith('(y/n)') ? 'y' : d),
    });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.endsWith('(y/n)'))).toEqual([]);
    expect(github.st.labels.has('question')).toBe(true);
    expect(existsSync(join(dir, 'docs/qa/sign-off-delegation.md'))).toBe(false);
    expect(read(dir, '.github/workflows/apps-check.yml')).not.toContain('RELEASER_APP_ID');
    expect(r.appsCalls).toEqual([]);
  });

  it('fails by name on an unknown flag, a value flag given twice, a bad value, or a flag that takes none', () => {
    expect(() => parseArgs(['--maintainers', 'x'], REQ)).toThrow('unknown argument "--maintainers"');
    expect(() => parseArgs(['--project-owner', 'a', '--project-owner', 'b'], REQ)).toThrow('--project-owner is given twice');
    expect(() => parseArgs(['--owner', 'grace'], REQ)).toThrow('unknown argument "--owner": the project\'s Owner is --project-owner');
    expect(() => parseArgs(['--gates=x', '--gates', 'y'], REQ)).toThrow('--gates is given twice');
    expect(() => parseArgs(['--test-database', 'docker'], REQ)).toThrow('--test-database takes none or hook, not "docker"');
    expect(() => parseArgs(['--lanes', 'reviews'], REQ)).toThrow('"agent-reviews" is not a Kanon lane');
    expect(() => parseArgs(['--releaser=yes'], REQ)).toThrow('--releaser takes no value, not "yes"');
    expect(() => parseArgs(['--delegate-name'], REQ)).toThrow('--delegate-name needs a value');
  });

  it('fails by name on each pair of flags that contradict each other', () => {
    expect(CONFLICTS.length).toBe(6);
    for (const [x, y] of CONFLICTS) {
      const argv = [x, y].flatMap((f) => (f.startsWith('--delegate-') ? [f, 'v'] : [f]));
      expect(() => parseArgs(argv, REQ), `${x} ${y}`).toThrow(`${x} and ${y} contradict each other; give one`);
    }
    expect(parseArgs(['--delegate-email', 'e@x'], REQ).given.delegation).toBe(true);
    expect(parseArgs(['--json'], REQ).yes).toBe(true);
  });

  it('exits 2 on a contradiction and touches nothing', async () => {
    const github = fakeGitHub();
    const r = await run(checkout(), github, ['--yes', '--releaser', '--no-releaser']);
    expect(r.status).toBe(2);
    expect(r.err).toContain('kanon init: --releaser and --no-releaser contradict each other; give one');
    expect(github.calls).toEqual([]);
  });

  it("refuses --releaser for a repository that doesn't call Kanon's release workflow, before any call to GitHub", async () => {
    const github = fakeGitHub();
    const r = await run(checkout(), github, ['--yes', '--releaser']);
    expect(r.status).toBe(2);
    expect(r.err).toContain("kanon init: --releaser is for a repository that calls Kanon's release workflow");
    expect(github.calls).toEqual([]);
    expect(writes(github.calls)).toEqual([]);
  });

  it('lists every flag it takes in its usage text and in docs/init.md, and only those', () => {
    const source = readFileSync(join(ROOT, 'cli/init.mjs'), 'utf8');
    // `--owner` is matched only to be refused with a hint (Owner, 2026-10-06), so it is not a flag init takes.
    const parsed = new Set([...source.matchAll(/flag === '(--[a-z-]+)'/g)].map((m) => m[1]!).filter((f) => f !== '--owner'));
    const usage = new Set([...USAGE.matchAll(/^ {2}(?:-h, )?(--[a-z-]+)/gm)].map((m) => m[1]!));
    expect([...usage].sort()).toEqual([...parsed].sort());
    const documented = new Set(tableColumn('## Answering without a terminal', 1).flatMap((c) => [...c.matchAll(/`(--[a-z-]+)/g)].map((m) => m[1]!)));
    const answers = [...parsed].filter((f) => !['--repo', '--dir', '--yes', '--dry-run', '--json', '--help'].includes(f));
    expect([...documented].sort()).toEqual(answers.sort());
  });
});
