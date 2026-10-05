import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeRegisterRow } from '../../cli/app-register.mjs';
import { loadRequirements, TRIGGERS } from '../../cli/callers.mjs';
import { appsArgs, init, LANE_CHECK, lineDiff, registerRolesOf, RULESET_NAME, rulesetGaps } from '../../cli/init.mjs';

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

const run = async (dir: string, github: ReturnType<typeof fakeGitHub>, argv: string[] = ['--yes'], answers?: Record<string, string>): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  const appsCalls: string[][] = [];
  const milestoneCalls: string[][] = [];
  const status = await init(['--dir', dir, ...argv], {
    gh: github.gh,
    env: {},
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
      const roles = args[args.indexOf('--roles') + 1]!.split(',');
      const register = join(dir, 'docs/qa/agent-identities.md');
      let text = existsSync(register) ? readFileSync(register, 'utf8') : null;
      for (const r of roles) {
        const spec = REQ.identities.roles[r]!;
        text = writeRegisterRow(text, { role: spec.name, slug: `widgets-${r}`, permissions: spec.permissions }).text;
        for (const s of [`${r.toUpperCase()}_APP_ID`, `${r.toUpperCase()}_APP_PRIVATE_KEY`]) github.st.secrets?.add(s);
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

  it('creates the taxonomy, the buckets, the merge setting and the ruleset, and runs kanon apps for the Reviewer', async () => {
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
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--roles', 'reviewer', '--dir', expect.any(String)]]);
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

  it("names what an existing default-branch ruleset lacks, and doesn't change it", async () => {
    const dir = checkout();
    const existing = { id: 7, name: 'protect main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'] } }] };
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
    expect(r.out).toContain('- Would run: kanon apps --owner acme --repo widgets --roles reviewer');
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
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--roles', 'implementer', '--dir', expect.any(String)]]);
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
    expect(r.appsCalls[0]).toContain('explorer,implementer,lead,merger,overseer,reviewer');
    const lc = laneCheck(dir);
    expect(lc.status, lc.out).toBe(0);
    expect(lc.out).toContain(`${Object.keys(REQ.lanes).length} lane caller(s) pass`);
    expect(r.out).toContain('gh secret set DIGEST_WEBHOOK -R acme/widgets');
  }, 60_000);
});

describe('the Apps, today and after plan 0005 step L4', () => {
  it('passes --roles while the lanes run one App per role', () => {
    expect(appsArgs(['reviewer'], REQ)).toEqual(['--roles', 'reviewer']);
    expect(registerRolesOf('reviewer', REQ)).toEqual(['Reviewer']);
  });

  it('passes --apps, and needs every row of the App\'s roles, once the lanes take the Apps\' secrets', () => {
    expect(appsArgs(['author', 'judge'], REQ)).toEqual(['--apps', 'author,judge']);
    expect(registerRolesOf('author', REQ)).toEqual(['Implementer', 'Lead', 'Explorer', 'Overseer']);
    expect(() => appsArgs(['author', 'reviewer'], REQ)).toThrow(/mix roles and Apps/);
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
