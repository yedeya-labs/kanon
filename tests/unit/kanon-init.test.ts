import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { writeRegisterRow } from '../../cli/app-register.mjs';
import { callerFile, ciFile, DEPENDABOT_ENTRY, loadRequirements, TRIGGERS } from '../../cli/callers.mjs';
import { appIdentities, appsArgs, callsRelease, CONFLICTS, init, LANE_CHECK, laneCatalogue, lineDiff, parseArgs, registerRolesOf, RULESET_NAME, rulesetGaps, SCHEMA, usage, USAGE, workflowName } from '../../cli/init.mjs';
import { pluginSettingsFile, readPluginDeclaration } from '../../cli/plugin.mjs';
import { TELEMETRY_CALLER_PATH, telemetryCallerFile } from '../../cli/callers.mjs';
import { TELEMETRY_QUESTION, TELEMETRY_REGISTRATION_URL } from '../../cli/init.mjs';

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
  /** The workflows on the default branch, as GitHub has them (#444); null when the token can't read them. */
  defaultWorkflows: Record<string, string> | null;
  rulesetUpdateFails?: boolean;
  /** The owner's App installations, as `GET orgs/<org>/installations` or `user/installations` lists them; unset, the token can't list them. */
  installations?: Array<Record<string, unknown>>;
  /** The public Apps, as `GET /apps/<slug>` answers them (#462); any other slug is private, which it answers 404 to a person's token. */
  publicApps?: Record<string, { owner: { login: string } }>;
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
    // A job on the default branch reports "Lane check" unless a case says otherwise, so the
    // ruleset may require it (#444).
    defaultWorkflows: { 'ci.yml': ciFile('v1.2.3', 'main') },
    ...over,
  };
  const calls: Array<{ args: string[]; input?: string }> = [];
  const gh = async (args: string[], input?: string): Promise<Gh> => {
    calls.push({ args, input });
    const [a0, a1] = args;
    if (a0 === 'api' && a1 === 'user') return ok('octo\n');
    if (a0 === 'api' && a1 === 'graphql') {
      const { variables } = JSON.parse(input ?? '{}') as { variables: { owner: string; name: string; expression: string } };
      if (!st.defaultWorkflows || `${variables.owner}/${variables.name}` !== REPO || variables.expression !== 'main:.github/workflows') return no('gh: Resource not accessible by personal access token (HTTP 403)');
      const entries = Object.entries(st.defaultWorkflows).map(([name, text]) => ({ name, type: 'blob', object: { text } }));
      return ok({ data: { repository: { object: entries.length ? { entries } : null } } });
    }
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
    if (a1 === (st.kind === 'Organization' ? 'orgs/acme/installations?per_page=100' : 'user/installations?per_page=100')) {
      return st.installations ? ok({ total_count: st.installations.length, installations: st.installations }) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    }
    const app = /^apps\/([\w-]+)$/.exec(a1 ?? '');
    if (app && !args.includes('-X')) return st.publicApps?.[app[1]!] ? ok({ slug: app[1], ...st.publicApps[app[1]!] }) : no('gh: Not Found (HTTP 404)');
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
    const put = /^repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(path);
    if (method === 'PUT' && put) {
      const target = st.rulesets.find((r) => r.id === Number(put[1]));
      if (!st.admin || st.rulesetUpdateFails || !target) return no('gh: Must have admin rights to Repository. (HTTP 403)');
      Object.assign(target, JSON.parse(input ?? '{}'));
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
  calls.map((c) => c.args).filter((a) => (a[0] === 'label' && a[1] !== 'list') || a.includes('PATCH') || a.includes('POST') || a.includes('PUT') || a.includes('DELETE'));

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

  it("writes the Dependabot entry adopters are given: daily, and allowing only Kanon's dependencies (K-ADOPT-11, #360)", async () => {
    const readme = read(ROOT, 'actions/pr-title/README.md');
    const block = /## Upgrades: Dependabot[\s\S]*?```yaml\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    const documented = parseYaml(block!);
    expect(documented.updates[0].schedule.interval).toBe('daily');
    expect(documented.updates[0].allow).toEqual([{ 'dependency-name': 'yedeya-labs/kanon*' }]);
    const dir = checkout();
    await run(dir, fakeGitHub());
    expect(parseYaml(read(dir, '.github/dependabot.yml'))).toEqual(documented);
    // The step init prints for a dependabot.yml that lacks the entry is the same entry.
    const github = fakeGitHub();
    const other = checkout({ '.github/dependabot.yml': 'version: 2\nupdates: []\n' });
    const r = await run(other, github);
    expect(r.out).toContain(DEPENDABOT_ENTRY.join('\n   '));
    expect(parseYaml(['updates:', ...DEPENDABOT_ENTRY].join('\n'))).toEqual({ updates: documented.updates });
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

  it('names what an existing default-branch ruleset lacks, and adds only the required check, which a job on main reports (#444)', async () => {
    const dir = checkout();
    const existing = { id: 7, name: 'protect main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash', 'merge'] } }] };
    const github = fakeGitHub({ rulesets: [structuredClone(existing)] });
    const r = await run(dir, github);
    expect(writes(github.calls).filter((a) => a.includes('PUT'))).toEqual([['api', '-X', 'PUT', 'repos/acme/widgets/rulesets/7', '--input', '-']]);
    expect(github.st.rulesets).toEqual([{ ...existing, rules: [...existing.rules, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: LANE_CHECK }] } }] }]);
    expect(r.out).toContain(`- Added the required status check "${LANE_CHECK}" to the ruleset "protect main" on main, which a job there reports`);
    expect(r.out).toContain('The ruleset on main (protect main) lacks some of K-ADOPT-1 step 8');
    for (const g of ['block force pushes', 'restrict deletions', 'allow the squash merge method only']) expect(r.out).toContain(`- ${g}`);
    expect(r.out).not.toContain(`- require the status check "${LANE_CHECK}"`);
  });
});

// #444, L5's G3 and G14: init created its ruleset requiring "Lane check" in the run that wrote the
// job reporting it on the adopt branch, so every other open pull request waited on the check
// until the adopt pull request merged. It now requires the check only once a job on the default
// branch reports it, as doctor asks (#418), and adds that one rule to a ruleset it didn't create.
describe('kanon init and the required check (#444)', () => {
  const CHECK_RULE = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: LANE_CHECK }] } };
  const ruleTypes = (github: ReturnType<typeof fakeGitHub>, i = 0) => (github.st.rulesets[i]!.rules as Array<{ type: string }>).map((x) => x.type);
  const graphql = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter((c) => c.args[1] === 'graphql');
  const ruleset = (over: Record<string, unknown> = {}) => ({ id: 7, name: 'protect main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }], ...over });

  it("creates its ruleset without the check while no job on main reports it, and leaves the rule as a step for after the merge", async () => {
    const dir = checkout();
    // main has a workflow, whose lane check is a step of another job: it reports nothing as "Lane check".
    const asStep = 'name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: yedeya-labs/kanon/actions/lane-check@v1.2.3\n';
    const github = fakeGitHub({ defaultWorkflows: { 'ci.yml': asStep } });
    const d = parse(await run(dir, github, ['--json']));
    expect(ruleTypes(github)).toEqual(['deletion', 'non_fast_forward', 'pull_request']);
    expect(d.changes.find((c) => c.kind === 'ruleset')!.message).toBe(`Created the ruleset "${RULESET_NAME}" on main`);
    const f = d.findings.find((x) => x.id === 'ruleset.require-check')!;
    expect(f).toMatchObject({ category: 'ruleset', blocking: false, subject: LANE_CHECK, fix: { commands: [], url: 'https://github.com/acme/widgets/settings/rules' } });
    expect(f.message).toBe(`No job of a workflow on main reports the status check "${LANE_CHECK}" on every pull request yet, so the ruleset doesn't require it: a required check that nothing reports blocks every other pull request (K-ADOPT-1 step 8).`);
    expect(f.fix.text).toMatch(/^After the pull request that adds \.github\/workflows\/ci\.yml#lanes merges to main, run kanon init again with a token that can administer the repository, which adds only that rule/);
    expect(d.status).toBe('steps-left');
  });

  it('changes nothing again before the merge, and adds the check to its own ruleset once the job is on main', async () => {
    const dir = checkout();
    const github = fakeGitHub({ defaultWorkflows: {} });
    await run(dir, github);
    const before = github.calls.length;
    const again = await run(dir, github);
    expect(writes(github.calls.slice(before))).toEqual([]);
    expect(again.out).toContain(`require the status check "${LANE_CHECK}"`);
    // The adopt pull request merges.
    github.st.defaultWorkflows = { 'ci.yml': read(dir, '.github/workflows/ci.yml') };
    const merged = await run(dir, github);
    expect(ruleTypes(github)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
    expect(merged.out).toContain(`- Added the required status check "${LANE_CHECK}" to the ruleset "${RULESET_NAME}" on main, which a job there reports`);
    expect(merged.out).not.toContain('Not before: until then');
    expect(merged.out).not.toContain('lacks some of K-ADOPT-1');
  });

  it("doesn't require the check when it can't read main's workflows, and says why", async () => {
    const github = fakeGitHub({ defaultWorkflows: null });
    const d = parse(await run(checkout(), github, ['--json']));
    expect(ruleTypes(github)).not.toContain('required_status_checks');
    expect(d.findings.find((x) => x.id === 'ruleset.require-check')!.message).toMatch(/^init could not read the workflows on main \(gh: Resource not accessible by personal access token \(HTTP 403\)\), so it can't tell whether a job there reports the status check "Lane check", so the ruleset doesn't require it/);
  });

  it('leaves the check out of a dry run and of the command for a token that cannot create the ruleset', async () => {
    const dry = await run(checkout(), fakeGitHub({ defaultWorkflows: {} }), ['--yes', '--dry-run']);
    expect(dry.out).toContain(`- Would create the ruleset "${RULESET_NAME}" on main\n`);
    expect(dry.out).toContain(`require the status check "${LANE_CHECK}" (K-ADOPT-1 step 8)`);
    const github = fakeGitHub({ defaultWorkflows: {}, admin: false });
    const d = parse(await run(checkout(), github, ['--json']));
    const create = d.findings.find((x) => x.id === 'ruleset.create')!;
    expect(JSON.parse(create.fix.commands[1]!).rules.map((x: { type: string }) => x.type)).toEqual(['deletion', 'non_fast_forward', 'pull_request']);
    expect(d.findings.map((x) => x.id)).toContain('ruleset.require-check');
    // With a job on main, the dry run says the ruleset requires the check.
    const reported = await run(checkout(), fakeGitHub(), ['--yes', '--dry-run']);
    expect(reported.out).toContain(`- Would create the ruleset "${RULESET_NAME}" on main, requiring "${LANE_CHECK}"`);
    expect(reported.out).not.toContain('Not before: until then');
  });

  it("doesn't add the check to an existing ruleset before a job on main reports it: the rule is the step for after the merge", async () => {
    const github = fakeGitHub({ defaultWorkflows: {}, rulesets: [ruleset()] });
    const r = await run(checkout(), github, ['--json']);
    const d = parse(r);
    expect(writes(github.calls).filter((a) => a.includes('PUT'))).toEqual([]);
    expect(d.findings.filter((x) => x.id.startsWith('ruleset.')).map((x) => x.id)).toEqual(['ruleset.require-check']);
    // It lacks the check still, so it hasn't every rule.
    expect(r.err).not.toContain('has every rule');
  });

  it('adds only the check to a ruleset that requires other checks, keeping them', async () => {
    const other = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'build' }] } };
    // GitHub may add fields to a rule it reads back; the update sends each rule's type and parameters only.
    const github = fakeGitHub({ rulesets: [ruleset({ rules: [...ruleset().rules.slice(0, 2), { ...ruleset().rules[2], ruleset_id: 7 }, other] })] });
    const d = parse(await run(checkout(), github, ['--json']));
    expect(JSON.parse(github.calls.find((c) => c.args.includes('PUT'))!.input!).rules[2]).toEqual(ruleset().rules[2]);
    expect((github.st.rulesets[0]!.rules as unknown[]).at(-1)).toEqual({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'build' }, { context: LANE_CHECK }] } });
    expect(ruleTypes(github)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
    expect(d.findings.filter((x) => x.id.startsWith('ruleset.'))).toEqual([]);
  });

  it('chooses the ruleset that requires checks already, then its own, and never an organisation\'s', async () => {
    const checks = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'build' }] } };
    const github = fakeGitHub({ rulesets: [ruleset({ id: 7 }), ruleset({ id: 8, name: RULESET_NAME }), ruleset({ id: 9, name: 'checks', rules: [checks] })] });
    await run(checkout(), github);
    expect(writes(github.calls).filter((a) => a.includes('PUT'))).toEqual([['api', '-X', 'PUT', 'repos/acme/widgets/rulesets/9', '--input', '-']]);
    const own = fakeGitHub({ rulesets: [ruleset({ id: 7 }), ruleset({ id: 8, name: RULESET_NAME })] });
    await run(checkout(), own);
    expect(writes(own.calls).filter((a) => a.includes('PUT'))).toEqual([['api', '-X', 'PUT', 'repos/acme/widgets/rulesets/8', '--input', '-']]);
    const org = fakeGitHub({ rulesets: [ruleset({ source_type: 'Organization' })] });
    const d = parse(await run(checkout(), org, ['--json']));
    expect(writes(org.calls).filter((a) => a.includes('PUT'))).toEqual([]);
    expect(d.findings.find((x) => x.id === 'ruleset.gaps')!.message).toContain(`require the status check "${LANE_CHECK}"`);
  });

  it('names the check among the gaps when the token cannot administer the repository or GitHub refuses the change', async () => {
    for (const over of [{ admin: false }, { rulesetUpdateFails: true }]) {
      const github = fakeGitHub({ ...over, rulesets: [ruleset()] });
      const d = parse(await run(checkout(), github, ['--json']));
      expect(github.st.rulesets[0]!.rules, JSON.stringify(over)).toEqual(ruleset().rules);
      expect(d.findings.find((x) => x.id === 'ruleset.gaps')!.message).toContain(`require the status check "${LANE_CHECK}"`);
      expect(d.findings.map((x) => x.id)).not.toContain('ruleset.require-check');
      // A token that can't administer the repository isn't asked to.
      if ('admin' in over) expect(github.calls.filter((c) => c.args.includes('PUT'))).toEqual([]);
    }
    const refused = parse(await run(checkout(), fakeGitHub({ rulesetUpdateFails: true, rulesets: [ruleset()] }), ['--json']));
    expect(refused.notes).toContain(`Could not add the required status check "${LANE_CHECK}" to the ruleset "protect main" (gh: Must have admin rights to Repository. (HTTP 403)).`);
  });

  it('says what it would add in a dry run, and adds nothing', async () => {
    const github = fakeGitHub({ rulesets: [ruleset()] });
    const r = await run(checkout(), github, ['--yes', '--dry-run']);
    expect(writes(github.calls)).toEqual([]);
    expect(r.out).toContain(`- Would add the required status check "${LANE_CHECK}" to the ruleset "protect main" on main, which a job there reports`);
  });

  it("reads main's workflows only when a ruleset could require the check", async () => {
    const free = fakeGitHub({ private: true, rulesetsOnPlan: false });
    await run(checkout(), free);
    expect(graphql(free)).toEqual([]);
    const empty = fakeGitHub({ hasCommits: false });
    await run(checkout(), empty);
    expect(graphql(empty)).toEqual([]);
    const done = fakeGitHub({ rulesets: [ruleset({ rules: [...ruleset().rules, CHECK_RULE] })] });
    await run(checkout(), done);
    expect(graphql(done)).toEqual([]);
  });

  // #459: through a merge queue, the queue waits for the check on its merge_group run.
  describe('through a merge queue (#459)', () => {
    const noQueueEvent = (text: string) => text.replace('  merge_group:\n', '');
    const queue = { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } };

    it("creates its queued ruleset without the check while main's job doesn't run on merge_group, and names the workflow to add it to", async () => {
      const dir = checkout({ '.github/workflows/ci.yml': noQueueEvent(ciFile('v1.2.3', 'main')) });
      const github = fakeGitHub({ kind: 'Organization', defaultWorkflows: { 'ci.yml': noQueueEvent(ciFile('v1.2.3', 'main')) } });
      const d = parse(await run(dir, github, ['--json', '--no-apps']));
      expect(ruleTypes(github)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'merge_queue']);
      const f = d.findings.find((x) => x.id === 'ruleset.require-check')!;
      expect(f.message).toBe(`No job of a workflow on main reports the status check "${LANE_CHECK}" on every pull request and every queued merge yet, so the ruleset doesn't require it: a required check that nothing reports blocks every other pull request (K-ADOPT-1 step 8).`);
      expect(f.fix.text).toMatch(/^After a pull request that adds merge_group, the event the merge queue runs its checks on, to the triggers of \.github\/workflows\/ci\.yml, merges to main/);
      // init doesn't write a second job that reports the check beside the project's.
      expect(existsSync(join(dir, '.github/workflows/lane-check.yml'))).toBe(false);
    });

    it('requires the check on a queued ruleset once the job runs on merge_group', async () => {
      const github = fakeGitHub({ kind: 'Organization' });
      await run(checkout(), github);
      expect(ruleTypes(github)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks', 'merge_queue']);
    });

    it("doesn't add the check to an existing ruleset with a merge queue while main's job doesn't run on merge_group", async () => {
      const github = fakeGitHub({ defaultWorkflows: { 'ci.yml': noQueueEvent(ciFile('v1.2.3', 'main')) }, rulesets: [ruleset({ rules: [...ruleset().rules, queue] })] });
      const d = parse(await run(checkout(), github, ['--json', '--no-apps']));
      expect(writes(github.calls).filter((a) => a.includes('PUT'))).toEqual([]);
      expect(d.findings.find((x) => x.id === 'ruleset.require-check')!.fix.text).toMatch(/^After the pull request that adds \.github\/workflows\/ci\.yml#lanes merges to main/);
      // Without the queue, the same job is enough.
      const plain = fakeGitHub({ defaultWorkflows: { 'ci.yml': noQueueEvent(ciFile('v1.2.3', 'main')) }, rulesets: [ruleset()] });
      await run(checkout(), plain);
      expect(writes(plain.calls).filter((a) => a.includes('PUT'))).toEqual([['api', '-X', 'PUT', 'repos/acme/widgets/rulesets/7', '--input', '-']]);
    });

    it('asks nothing of merge_group on a plan without the queue, where init creates its ruleset without one', async () => {
      const github = fakeGitHub({ defaultWorkflows: { 'ci.yml': noQueueEvent(ciFile('v1.2.3', 'main')) } });
      await run(checkout(), github);
      expect(ruleTypes(github)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
    });
  });

  describe("lane-check's own workflow (L5's G14)", () => {
    const job = (on: string) => `name: Build\non:\n${on}jobs:\n  lanes:\n    name: Lane check\n    runs-on: ubuntu-latest\n    steps:\n      - uses: yedeya-labs/kanon/actions/lane-check@v1.2.3\n`;
    const writesLaneCheck = async (files: Record<string, string>) => {
      const dir = checkout(files);
      await run(dir, fakeGitHub(), ['--yes', '--no-apps']);
      return existsSync(join(dir, '.github/workflows/lane-check.yml'));
    };

    it('is written when the lane check runs as a step of another job, or in a workflow that skips some pull requests', async () => {
      const asStep = 'name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: yedeya-labs/kanon/actions/lane-check@v1.2.3\n';
      expect(await writesLaneCheck({ '.github/workflows/ci.yml': asStep })).toBe(true);
      expect(await writesLaneCheck({ '.github/workflows/ci.yml': job("  pull_request:\n    paths: ['src/**']\n") })).toBe(true);
      expect(await writesLaneCheck({ '.github/workflows/ci.yml': job('  push:\n') })).toBe(true);
    });

    it('is not written when a workflow, CI or another, has a job that reports the check on every pull request', async () => {
      expect(await writesLaneCheck({ '.github/workflows/ci.yml': job('  pull_request:\n') })).toBe(false);
      expect(await writesLaneCheck({ '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: "true"\n', '.github/workflows/checks.yaml': job('  pull_request:\n') })).toBe(false);
      // A workflow that doesn't parse reports nothing.
      expect(await writesLaneCheck({ '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: "true"\n', '.github/workflows/broken.yml': 'a: &x 1\n' })).toBe(true);
    });

    it("names the job the checkout's own lane-check.yml has, not the one init would write, in the step for after the merge", async () => {
      const ci = 'name: CI\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: "true"\n';
      const filtered = job("  pull_request:\n    paths: ['src/**']\n");
      const d = parse(await run(checkout({ '.github/workflows/ci.yml': ci, '.github/workflows/lane-check.yml': filtered }), fakeGitHub({ defaultWorkflows: {} }), ['--json', '--no-apps']));
      expect(d.files.find((f) => f.path === '.github/workflows/lane-check.yml')!.status).toBe('differs');
      expect(d.findings.find((x) => x.id === 'ruleset.require-check')!.fix.text).toMatch(/^After a pull request that adds a job named "Lane check", as actions\/lane-check's README shows, merges to main/);
    });

    it('is still its own file to compare once init has written it', async () => {
      const dir = checkout({ '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: "true"\n' });
      await run(dir, fakeGitHub(), ['--yes', '--no-apps']);
      const again = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps']));
      expect(again.files.find((f) => f.path === '.github/workflows/lane-check.yml')!.status).toBe('same');
    });
  });
});

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
    ...(t.pinMoved ? ['pull_request_target:closed'] : []),
    ...(t.issues ? [`issues:${[...t.issues].sort().join(',')}`] : []),
    ...(t.schedule ? ['schedule'] : []),
    `workflow_dispatch:${Object.keys(t.dispatch).sort().join(',')}`,
  ];

  it("writes the Overseer's runtime-version trigger on its own file, on the default branch (kanon#423)", () => {
    const text = callerFile('agent-overseer', REQ.lanes['agent-overseer']!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' });
    expect(text).toContain('  pull_request_target:\n    types: [closed]\n    branches: [trunk]\n    paths:\n      - .github/workflows/agent-overseer.yml\n');
    // No other lane's caller gets it.
    for (const lane of Object.keys(REQ.lanes).filter((l) => l !== 'agent-overseer')) {
      expect(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'trunk' }), lane).not.toContain('types: [closed]\n    branches:');
    }
  });

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

// #363 (the Owner, 2026-10-07: "A + ask"): init lists the owner's App installations and offers
// to reuse one whose permissions are exactly an App's, rather than create a second set.
describe("kanon init and the Apps the owner already has (#363)", () => {
  const APPS = REQ.identities.apps;
  const install = (slug: string, app: string, over: Record<string, unknown> = {}) => ({ id: slug.length, app_id: 900 + slug.length, app_slug: slug, account: { login: 'acme', type: 'Organization' }, permissions: { ...APPS[app]!.permissions }, events: [], repository_selection: 'selected', ...over });
  const installsCalls = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter((c) => /installations/.test(c.args.join(' ')));

  it('finds the Judge among an organisation\'s installations, reuses it by default, and prints the --reuse step with its slug', async () => {
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-kanon-judge', 'judge'), install('some-ci-bot', 'judge', { permissions: { contents: 'read', metadata: 'read' } })] });
    const r = await run(checkout(), github, ['--json']);
    expect(r.status, r.err).toBe(0);
    const d = parse(r);
    expect(d.inspection.ownerApps).toEqual([{ app: 'judge', slug: 'acme-kanon-judge' }]);
    expect(d.answers.reuseApps).toBe(true);
    expect(d.apps).toEqual({ identities: ['judge'], missing: ['judge'], reuse: [{ app: 'judge', slug: 'acme-kanon-judge' }], command: null, outcome: 'reuse', exitCode: null });
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
          text: "Add widgets to the App's installation, generate a private key on its settings page, then run kanon apps --reuse with the downloaded key, and commit the register rows it writes.",
          commands: ['kanon apps --owner acme --repo widgets --reuse judge:acme-kanon-judge=<downloaded>.pem'],
          url: 'https://github.com/organizations/acme/settings/apps/acme-kanon-judge',
        },
      },
    ]);
    expect(installsCalls(github).map((c) => c.args)).toEqual([['api', 'orgs/acme/installations?per_page=100']]);
  });

  it('creates the App anyway with --no-reuse-apps, and asks without --yes, taking the answer', async () => {
    const owned = { kind: 'Organization' as const, orgPlan: 'free', installations: [install('acme-kanon-judge', 'judge')] };
    const no = await run(checkout(), fakeGitHub(owned), ['--json', '--no-reuse-apps']);
    expect(parse(no).answers.reuseApps).toBe(false);
    expect(parse(no).apps).toMatchObject({ reuse: [], outcome: 'ran' });
    expect(no.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'judge', '--dir', expect.any(String)]]);
    const asked: string[] = [];
    const said = await run(checkout(), fakeGitHub(owned), [], { 'Reuse it here': 'n' }, REQ, {
      ask: async (q: string, d: string) => (asked.push(q), /Reuse it here/.test(q) ? 'n' : d),
    });
    expect(asked.find((q) => /Reuse/.test(q))).toBe('The owner already has the Judge (acme-kanon-judge), installed with exactly its permissions. Reuse it here with kanon apps --reuse, rather than create a second one? (y/n)');
    expect(said.appsCalls).toHaveLength(1);
    const yes = await run(checkout(), fakeGitHub(owned), [], undefined, REQ, { ask: async (_q: string, d: string) => d });
    expect(yes.appsCalls).toEqual([]);
    expect(yes.out).toContain('kanon apps --owner acme --repo widgets --reuse judge:acme-kanon-judge=<downloaded>.pem');
  });

  it('reuses the Apps the owner has and creates the rest, and names a second match', async () => {
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-judge-a', 'judge'), install('acme-judge-b', 'judge')] });
    const r = await run(checkout(), github, ['--json', '--lanes', 'review,implement']);
    const d = parse(r);
    expect(d.apps).toMatchObject({ missing: ['author', 'judge'], reuse: [{ app: 'judge', slug: 'acme-judge-a' }], outcome: 'ran' });
    expect(r.appsCalls).toEqual([['--owner', 'acme', '--repo', 'widgets', '--apps', 'author', '--dir', expect.any(String)]]);
    const reuse = d.findings.find((x) => x.id === 'app.reuse')!;
    expect(reuse.fix.commands).toEqual(['kanon apps --owner acme --repo widgets --reuse judge:acme-judge-a=<downloaded>.pem']);
    expect(reuse.fix.text).toContain('(it also has acme-judge-b with the same permissions: give the one widgets should share)');
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
    expect(d.inspection.ownerApps).toEqual([{ app: 'releaser', slug: 'acme-releaser' }]);
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
    expect(await releaserOffer([install('acme-releaser', 'releaser')])).toEqual([{ app: 'judge', slug: 'acme-judge' }, { app: 'releaser', slug: 'acme-releaser' }]);
    expect(await releaserOffer([install('acme-releaser', 'releaser')], { 'acme-releaser': { owner: { login: 'ACME' } } })).toEqual([{ app: 'judge', slug: 'acme-judge' }, { app: 'releaser', slug: 'acme-releaser' }]);
  }, 60_000);

  it("offers no App of another account's, none that subscribes to events, and none GitHub can't say whose it is, as the Releaser or the Judge (#462)", async () => {
    const theirs = { 'release-bot': { owner: { login: 'bot-maker' } }, 'acme-judge': { owner: { login: 'bot-maker' } } };
    expect(await releaserOffer([install('release-bot', 'releaser')], theirs)).toEqual([]);
    expect(await releaserOffer([install('acme-releaser', 'releaser', { events: ['push'] })])).toEqual([{ app: 'judge', slug: 'acme-judge' }]);
    expect(await releaserOffer([install('acme-releaser', 'releaser', { events: undefined })])).toEqual([{ app: 'judge', slug: 'acme-judge' }]);
    const github = fakeGitHub({ kind: 'Organization', orgPlan: 'free', installations: [install('acme-judge', 'judge'), install('acme-releaser', 'releaser')] });
    const gh = github.gh;
    github.gh = async (args: string[], input?: string) => (args[1] === 'apps/acme-releaser' ? no('gh: Bad Gateway (HTTP 502)') : gh(args, input));
    const d = parse(await run(checkout({ '.github/workflows/release.yml': RELEASE_CALLER }), github, ['--json', '--lanes', 'review', '--releaser']));
    expect(d.inspection.ownerApps).toEqual([{ app: 'judge', slug: 'acme-judge' }]);
    expect(d.apps).toMatchObject({ missing: ['judge', 'releaser'], reuse: [{ app: 'judge', slug: 'acme-judge' }] });
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
    expect(r.out).toContain('kanon apps --owner acme --repo widgets --reuse judge:acme-judge=<downloaded>.pem');
    expect(r.out).not.toMatch(/gh secret set JUDGE_APP/);
  });

  it('says, where it leaves the Apps to create, to reuse an App the owner already has rather than create a second (#363)', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--json', '--no-apps', '--lanes', 'review,implement']);
    const f = parse(r).findings.find((x) => x.id === 'app.create')!;
    expect(f.subject).toBe('author, judge');
    expect(f.fix.commands).toEqual([expect.stringMatching(/^kanon apps --owner acme --repo widgets --apps author,judge --dir /)]);
    expect(f.fix.text).toContain("If acme already has these Apps for another repository, don't create them again: add widgets to each installation, generate a private key on its settings page, and run kanon apps --owner acme --repo widgets --reuse <app>:<slug>=<key file> instead");
    expect(r.err).toContain("If acme already has these Apps for another repository, don't create them again");
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
    expect(d.answers).toEqual({ projectOwner: 'octo', maintainer: 'octo', stakeholder: 'octo', lanes: ['agent-review'], gates: [], testDatabase: 'none', delegation: null, deleteDefaultLabels: false, releaser: false, reuseApps: null, plugin: true, telemetry: false });
    expect(d.apps).toEqual({ identities: ['judge'], missing: ['judge'], reuse: [], command: expect.stringMatching(/^kanon apps --owner acme --repo widgets --apps judge --dir /), outcome: 'ran', exitCode: 0 });
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

  it('prints a failed document listing the files already written when a write throws (#375)', async () => {
    const dir = checkout();
    const github = fakeGitHub();
    let n = 0;
    const r = await run(dir, github, ['--json'], undefined, REQ, {
      writeFile: (path: string, text: string) => {
        if (++n === 3) throw new Error(`EROFS: read-only file system, open '${path}'`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      },
    });
    expect(r.status).toBe(1);
    const d = parse(r);
    expect(d).toMatchObject({ schema: SCHEMA, status: 'failed', exitCode: 1, repository: REPO });
    expect(d.failures).toEqual([expect.stringMatching(/^stopped on an unexpected error: EROFS: read-only file system/)]);
    const written = d.files.filter((f) => f.status === 'new').map((f) => String(f.path));
    expect(written).toHaveLength(2);
    for (const f of written) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(d.changes.map((c) => c.subject)).toEqual(written);
    expect(r.err).toContain('kanon init: stopped on an unexpected error: EROFS');
    // Nothing after the throw ran: no label, ruleset or App.
    expect(writes(github.calls)).toEqual([]);
    expect(r.appsCalls).toEqual([]);
  });

  it('prints the error document when it throws before inspecting, or cannot read its requirements (#375)', async () => {
    const early = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, {
      git: () => {
        throw new Error('spawnSync git ENOENT');
      },
    });
    expect(early.status).toBe(1);
    expect(JSON.parse(early.out)).toEqual({ schema: SCHEMA, kanon: expect.any(String), status: 'error', exitCode: 1, error: 'stopped on an unexpected error: spawnSync git ENOENT. Nothing was changed.' });
    const noReq = await run(checkout(), fakeGitHub(), ['--json'], undefined, REQ, {
      requirements: () => {
        throw new Error('ENOENT: requirements.json');
      },
    });
    expect(noReq.status).toBe(1);
    expect(JSON.parse(noReq.out)).toMatchObject({ status: 'error', exitCode: 1, error: expect.stringContaining("could not read this release's requirements file (ENOENT: requirements.json)") });
    // Without --json, the same sentence on standard error, and no stack trace.
    const prose = await run(checkout(), fakeGitHub(), ['--yes'], undefined, REQ, {
      git: () => {
        throw new Error('spawnSync git ENOENT');
      },
    });
    expect(prose.status).toBe(1);
    expect(prose.out).toBe('');
    expect(prose.err).toBe('kanon init: stopped on an unexpected error: spawnSync git ENOENT');
  });

  it('prints the error document for --help with --json, not an empty standard output (#372)', async () => {
    for (const h of ['--help', '-h']) {
      const github = fakeGitHub();
      const r = await run(checkout(), github, [h, '--json']);
      expect(r.status, h).toBe(2);
      expect(JSON.parse(r.out), h).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: '--help and --json contradict each other; give one' });
      expect(r.err, h).toContain('Usage: kanon init');
      expect(github.calls).toEqual([]);
    }
    // Without --json, --help prints the usage on standard output, as before.
    const help = await run(checkout(), fakeGitHub(), ['--help']);
    expect(help.status).toBe(0);
    expect(help.out).toContain('Usage: kanon init');
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
    const inCode = [...new Set([...source.matchAll(/\bid: '([a-z-]+\.[a-z-]+)'/g)].map((m) => m[1]!))].sort();
    const documented = fields('### The findings').sort();
    expect(inCode).toEqual(documented);
    const categories = new Map(tableColumn('### The findings').map((id, i) => [id.replace(/`/g, ''), tableColumn('### The findings', 1)[i]!.replace(/`/g, '')]));
    // The findings these fixtures produce carry their documented category.
    const dep = checkout({ '.github/dependabot.yml': 'version: 2\nupdates: []\n', '.claude/settings.json': '{}\n' });
    const d = parse(await run(dep, fakeGitHub({ admin: false, labelCreateFails: true, secrets: null }), ['--json', '--no-apps']));
    expect(d.findings.map((f) => f.id)).toEqual(['dependabot.kanon-entry', 'plugin.declare', 'label.create', 'merge.settings', 'ruleset.create', 'app.create', 'secret.unreadable']);
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
    const r = await run(dir, github, ['--no-releaser', '--keep-default-labels', '--no-delegation', '--no-plugin', '--no-telemetry', '--no-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (asked.push(q), q.endsWith('(y/n)') ? 'y' : d),
    });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.endsWith('(y/n)'))).toEqual([]);
    expect(github.st.labels.has('question')).toBe(true);
    expect(existsSync(join(dir, 'docs/qa/sign-off-delegation.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(dir, '.github/workflows/telemetry.yml'))).toBe(false);
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
    expect(CONFLICTS.length).toBe(10);
    for (const [x, y] of CONFLICTS) {
      const argv = [x, y].flatMap((f) => (f.startsWith('--delegate-') ? [f, 'v'] : [f]));
      expect(() => parseArgs(argv, REQ), `${x} ${y}`).toThrow(`${x} and ${y} contradict each other; give one`);
    }
    expect(parseArgs(['--delegate-email', 'e@x'], REQ).given.delegation).toBe(true);
    expect(parseArgs(['--json'], REQ).yes).toBe(true);
    // -h is --help.
    expect(() => parseArgs(['-h', '--json'], REQ)).toThrow('--help and --json contradict each other; give one');
  });

  it('never takes the next flag as a value flag\'s value, and takes a value beginning with "-" inline (#372)', () => {
    const valueFlags = ['--repo', '--dir', '--lanes', '--project-owner', '--maintainer', '--stakeholder', '--gates', '--test-database', '--delegate-name', '--delegate-email'];
    for (const f of valueFlags) {
      expect(() => parseArgs([f, '--yes', '--json'], REQ), f).toThrow(`${f} needs a value, not the flag "--yes"; to give a value that begins with "-", write ${f}=<value>`);
      expect(() => parseArgs([f, '-h'], REQ), f).toThrow(`${f} needs a value, not the flag "-h"`);
    }
    expect(parseArgs(['--gates=--fast-check', '--yes'], REQ).given.gates).toBe('--fast-check');
    expect(parseArgs(['--project-owner', 'grace', '--yes'], REQ).given.projectOwner).toBe('grace');
  });

  it('records no flag as the Owner, and prints the error document, when a value flag is followed by a flag (#372)', async () => {
    const github = fakeGitHub();
    const dir = checkout();
    const r = await run(dir, github, ['--project-owner', '--yes', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: expect.stringContaining('--project-owner needs a value, not the flag "--yes"') });
    expect(github.calls).toEqual([]);
    expect(existsSync(join(dir, 'docs/qa/adoption.md'))).toBe(false);
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

// #376: init offers to declare the kanon plugin in .claude/settings.json, pinned to its release
// (docs/skills.md), and never rewrites a settings file the project already has.
describe('kanon init and the kanon plugin (#376)', () => {
  const RELEASE = `v${JSON.parse(read(ROOT, 'package.json')).version}`;
  const SETTINGS = '.claude/settings.json';

  it('declares it by default, pinned to the release it runs from, and leaves it as written on a second run', async () => {
    const dir = checkout();
    const first = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(first.answers.plugin).toBe(true);
    expect(read(dir, SETTINGS)).toBe(pluginSettingsFile(RELEASE));
    expect(readPluginDeclaration(read(dir, SETTINGS))).toEqual({ status: 'declared', name: 'kanon', ref: RELEASE, enabled: true });
    expect(first.files.find((f) => f.path === SETTINGS)).toMatchObject({ status: 'new' });
    expect(first.findings.map((f) => f.id)).not.toContain('plugin.declare');
    const second = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(second.files.find((f) => f.path === SETTINGS)).toMatchObject({ status: 'same' });
    expect(second.findings.map((f) => f.id)).not.toContain('plugin.declare');
  });

  it('writes nothing with --no-plugin, and a dry run writes nothing either', async () => {
    const no = checkout();
    const d = parse(await run(no, fakeGitHub(), ['--yes', '--json', '--no-plugin', '--no-apps']));
    expect(d.answers.plugin).toBe(false);
    expect(existsSync(join(no, SETTINGS))).toBe(false);
    expect(d.files.map((f) => f.path)).not.toContain(SETTINGS);
    const dry = checkout();
    const dd = parse(await run(dry, fakeGitHub(), ['--yes', '--json', '--dry-run']));
    expect(dd.files.find((f) => f.path === SETTINGS)).toMatchObject({ status: 'new', content: pluginSettingsFile(RELEASE) });
    expect(existsSync(join(dry, SETTINGS))).toBe(false);
  });

  it('leaves a settings file the project has alone, and names the keys to merge into it', async () => {
    const own = '{\n  "permissions": { "allow": ["Bash(npm test)"] }\n}\n';
    const dir = checkout({ [SETTINGS]: own });
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(read(dir, SETTINGS)).toBe(own);
    expect(d.files.map((f) => f.path)).not.toContain(SETTINGS);
    const f = d.findings.find((x) => x.id === 'plugin.declare')!;
    expect(f).toMatchObject({ category: 'plugin', blocking: false, subject: SETTINGS });
    expect(f.message).toBe(`${SETTINGS} exists, and doesn't declare the kanon plugin.`);
    // The lines are the declaration's keys, which merged into an empty object give what init writes.
    expect(JSON.parse(`{${f.fix.commands.join('\n')}}`)).toEqual(JSON.parse(pluginSettingsFile(RELEASE)));
  });

  it('names a declaration at another release, or not enabled, and says nothing of one at its release', async () => {
    const stale = JSON.parse(pluginSettingsFile('v0.1.0'));
    const off = { ...JSON.parse(pluginSettingsFile(RELEASE)), enabledPlugins: { 'kanon@kanon': false }, permissions: {} };
    const at = { ...JSON.parse(pluginSettingsFile(RELEASE)), permissions: {} };
    const message = async (doc: unknown) => parse(await run(checkout({ [SETTINGS]: JSON.stringify(doc) }), fakeGitHub(), ['--yes', '--json', '--no-apps'])).findings.find((x) => x.id === 'plugin.declare')?.message;
    expect(await message(stale)).toBe(`${SETTINGS} declares the kanon plugin's marketplace "kanon" at v0.1.0, not at ${RELEASE}.`);
    expect(await message(off)).toBe(`${SETTINGS} declares the kanon plugin's marketplace "kanon" at ${RELEASE}, and doesn't enable kanon@kanon.`);
    expect(await message(at)).toBeUndefined();
  });

  it('asks the question without --yes, and takes the answer', async () => {
    const asked: string[] = [];
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (asked.push(q), q.startsWith('Declare the kanon plugin') ? 'n' : d),
    });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.startsWith('Declare the kanon plugin'))).toHaveLength(1);
    expect(existsSync(join(dir, SETTINGS))).toBe(false);
  });
});

// kanon#428: the lane catalogue (docs/lanes.json) is what a person chooses lanes from, in
// --help and in the JSON's `catalogue`, which the adopt skill asks a question per group from.
describe('kanon init and the lane catalogue (#428)', () => {
  const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'docs/lanes.json'), 'utf8')) as { groups: Array<{ id: string; title: string; header: string }>; lanes: Record<string, { group: string; does: string; when: string; cost: string }> };

  it('prints every group and every lane of the catalogue in its JSON, with the fields docs/init.md lists', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--yes', '--json', '--dry-run']);
    const d = parse(r) as Doc & { catalogue: Array<Record<string, unknown> & { group: string; lanes: Array<Record<string, unknown> & { lane: string }> }> };
    expect(d.catalogue.map((g) => g.group)).toEqual(CATALOGUE.groups.map((g) => g.id));
    for (const g of d.catalogue) {
      expect(keys(g)).toEqual(fields('### The lane catalogue').sort());
      for (const l of g.lanes) {
        expect(keys(l)).toEqual(fields('### A catalogue lane').sort());
        const e = CATALOGUE.lanes[l.lane]!;
        expect(l, l.lane).toMatchObject({ does: e.does, when: e.when, cost: e.cost });
        expect(e.group).toBe(g.group);
      }
    }
    expect(d.catalogue.flatMap((g) => g.lanes.map((l) => l.lane)).sort()).toEqual(Object.keys(REQ.lanes).sort());
    expect(d.catalogue[0]!.lanes[0]).toMatchObject({ lane: 'agent-review', app: 'judge', recommended: true, installed: false, qaStore: false, schedule: null });
    expect(d.catalogue.flatMap((g) => g.lanes).find((l) => l.lane === 'agent-explore')).toMatchObject({ app: 'author', qaStore: true, schedule: '0 3 * * *', hooks: ['.github/actions/explore-sweep/action.yml'] });
    // Its id-token grant is for the aggregate function, not a QA store (kanon#471's review).
    expect(d.catalogue.flatMap((g) => g.lanes).find((l) => l.lane === 'agent-explore-telemetry')).toMatchObject({ app: 'author', qaStore: false, schedule: '30 6 * * 2' });
  });

  it('recommends only the review lane on a repository that calls none', () => {
    const rec = laneCatalogue(REQ, []).flatMap((g) => g.lanes).filter((l) => l.recommended).map((l) => l.lane);
    expect(rec).toEqual(['agent-review']);
  });

  it('recommends what the repository calls already, and what is recommended with it', () => {
    const lanes = laneCatalogue(REQ, ['agent-implement']).flatMap((g) => g.lanes);
    expect(lanes.filter((l) => l.recommended).map((l) => l.lane).sort()).toEqual(['agent-dispatch-sweep', 'agent-implement', 'agent-implement-revise', 'agent-rebase', 'agent-review']);
    expect(lanes.filter((l) => l.installed).map((l) => l.lane)).toEqual(['agent-implement']);
    // Transitively: the Lead recommends the reconciler, which recommends verify-acs and the daily digest.
    const lead = laneCatalogue(REQ, ['agent-lead']).flatMap((g) => g.lanes).filter((l) => l.recommended).map((l) => l.lane);
    expect(lead).toEqual(expect.arrayContaining(['agent-lead-reconcile', 'agent-verify-acs', 'agent-project-digest']));
  });

  it('recommends the same lanes whatever order the catalogue lists them in', () => {
    const cat = REQ.catalogue!;
    const reversed = { ...REQ, catalogue: { ...cat, lanes: Object.fromEntries(Object.entries(cat.lanes).reverse()) } };
    const rec = (req: typeof REQ, installed: string[]) => laneCatalogue(req, installed).flatMap((g) => g.lanes).filter((l) => l.recommended).map((l) => l.lane).sort();
    for (const installed of [[], ['agent-lead'], ['agent-implement'], ['agent-explore']]) expect(rec(reversed, installed), installed.join()).toEqual(rec(REQ, installed));
    expect(rec(reversed, ['agent-lead'])).toEqual(expect.arrayContaining(['agent-project-digest']));
  });

  it('lists every lane of the catalogue in --help, with what it does, by group', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--help']);
    expect(r.status).toBe(0);
    expect(r.out).toBe(usage(REQ));
    for (const g of CATALOGUE.groups) expect(r.out).toContain(`\n  ${g.title}\n`);
    for (const [lane, e] of Object.entries(CATALOGUE.lanes)) expect(r.out).toMatch(new RegExp(`^ {4}${lane.slice('agent-'.length)} +${e.does.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    expect(r.out).toMatch(/^ {4}review +.* \(recommended\)$/m);
  });
});

// #428: telemetry is asked, off by default, and installed only on an explicit yes. On yes, init
// writes the collector's caller exactly as docs/telemetry.md gives it, and leaves the operator's
// side (the register entry and the two variables) as a step.
// #452 (#79): a merge through a merge queue doesn't start a lane that runs on CI finishing on the
// default branch, so init says when the default branch has one, and the catalogue what it changes.
describe('kanon init and a merge queue on the default branch (#452)', () => {
  const queue = { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } };
  const ruleset = (rules: unknown[]) => ({ id: 7, name: 'protect main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }, ...rules] });
  const inspect = async (over: Parameters<typeof fakeGitHub>[0]) => parse(await run(checkout(), fakeGitHub(over), ['--json', '--dry-run', '--no-apps'])).inspection.defaultBranchMergeQueue;

  it('says whether the default branch merges through a merge queue: its ruleset has one, or the one init creates will', async () => {
    expect(await inspect({ rulesets: [ruleset([queue])] })).toBe(true);
    expect(await inspect({ kind: 'Organization', rulesets: [ruleset([])] })).toBe(false);
    expect(await inspect({ kind: 'Organization' })).toBe(true);
    expect(await inspect({})).toBe(false);
    expect(await inspect({ kind: 'Organization', private: true, orgPlan: 'enterprise', rulesetsOnPlan: false })).toBe(false);
  });

  it("gives each catalogue lane what a merge queue changes for it, from docs/lanes.json", async () => {
    const d = parse(await run(checkout(), fakeGitHub(), ['--json', '--dry-run', '--no-apps']));
    const lanes = (d.catalogue as Array<{ lanes: Array<{ lane: string; mergeQueue: string | null }> }>).flatMap((g) => g.lanes);
    expect(lanes.find((l) => l.lane === 'agent-rebase')!.mergeQueue).toBe(REQ.catalogue!.lanes['agent-rebase']!.mergeQueue);
    expect(lanes.find((l) => l.lane === 'agent-rebase')!.mergeQueue).toMatch(/^Through a merge queue, a merge doesn't start it/);
    expect(lanes.find((l) => l.lane === 'agent-review')!.mergeQueue).toBeNull();
  });
});

describe('kanon init and telemetry (#428)', () => {
  const RELEASE = `v${JSON.parse(read(ROOT, 'package.json')).version}`;
  const withVariables = (names: string[] | null) => {
    const github = fakeGitHub();
    const gh = github.gh;
    github.gh = async (args: string[], input?: string) => {
      if (args[0] === 'variable' && args[1] === 'list') {
        github.calls.push({ args, input });
        return names ? ok(names.map((name) => ({ name }))) : no('gh: Resource not accessible by personal access token (HTTP 403)');
      }
      return gh(args, input);
    };
    return github;
  };

  it("writes docs/telemetry.md's caller, byte for byte, pinned to the release it runs from", () => {
    const doc = read(ROOT, 'docs/telemetry.md');
    const block = doc.split('**The caller.**')[1]!.split('```yaml\n')[1]!.split('```')[0]!;
    expect(telemetryCallerFile(RELEASE)).toBe(block);
    expect(TELEMETRY_CALLER_PATH).toBe('.github/workflows/telemetry.yml');
    expect(REQ.telemetry?.collector).toBe('telemetry-collect');
    for (const v of REQ.telemetry!.variables) expect(telemetryCallerFile(RELEASE)).toContain(`\${{ vars.${v} }}`);
  });

  it('installs nothing without an explicit yes: the default, --yes, --json, a dry run and --no-telemetry', async () => {
    for (const argv of [['--yes'], ['--yes', '--json', '--no-apps'], ['--yes', '--json', '--dry-run'], ['--yes', '--no-telemetry']]) {
      const dir = checkout();
      const github = fakeGitHub();
      const r = await run(dir, github, argv);
      expect(r.status, argv.join(' ')).toBe(0);
      expect(existsSync(join(dir, TELEMETRY_CALLER_PATH)), argv.join(' ')).toBe(false);
      expect(`${r.out}${r.err}`, argv.join(' ')).not.toContain(TELEMETRY_CALLER_PATH);
      expect(github.calls.some((c) => c.args[0] === 'variable'), argv.join(' ')).toBe(false);
      if (argv.includes('--json')) expect(parse(r).answers.telemetry).toBe(false);
    }
    // Asked without --yes, the default answer is no.
    const asked: string[] = [];
    const dir = checkout();
    await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: async (q: string, d: string) => (asked.push(q), d) });
    expect(asked.filter((q) => q.startsWith(TELEMETRY_QUESTION))).toHaveLength(1);
    expect(existsSync(join(dir, TELEMETRY_CALLER_PATH))).toBe(false);
  });

  it('says what is sent, where, who reads it, and how to stop and erase, in its question', () => {
    for (const s of ['no code', 'no logins', 'Frankfurt', '13 months', "Kanon's operator", 'at least three adopters', 'deleting .github/workflows/telemetry.yml', 'Erase an adopter']) expect(TELEMETRY_QUESTION).toContain(s);
  });

  it('on a yes, writes the caller and leaves the registration as a step until both variables are set', async () => {
    const dir = checkout();
    const d = parse(await run(dir, withVariables([]), ['--yes', '--json', '--no-apps', '--telemetry']));
    expect(d.answers.telemetry).toBe(true);
    expect(read(dir, TELEMETRY_CALLER_PATH)).toBe(telemetryCallerFile(RELEASE));
    expect(d.files.find((f) => f.path === TELEMETRY_CALLER_PATH)).toMatchObject({ status: 'new', content: telemetryCallerFile(RELEASE) });
    const f = d.findings.find((x) => x.id === 'telemetry.register')!;
    expect(f).toMatchObject({ category: 'telemetry', blocking: false, subject: REPO });
    expect(f.message).toContain('KANON_TELEMETRY_URL and KANON_TELEMETRY_WRITER_ROLE are not set');
    expect(f.fix.url).toBe(TELEMETRY_REGISTRATION_URL);
    expect(f.fix.commands).toEqual([
      `gh variable set KANON_TELEMETRY_URL -R ${REPO} --body '<the URL the operator gives you>'`,
      `gh variable set KANON_TELEMETRY_WRITER_ROLE -R ${REPO} --body '<the role ARN the operator gives you>'`,
    ]);
    expect(existsSync(join(ROOT, '.github/ISSUE_TEMPLATE/telemetry-registration.yml'))).toBe(true);
    expect(TELEMETRY_REGISTRATION_URL).toMatch(/template=telemetry-registration\.yml$/);

    // One variable set: still a step, naming the other.
    const one = parse(await run(checkout(), withVariables(['KANON_TELEMETRY_URL']), ['--yes', '--json', '--no-apps', '--telemetry']));
    expect(one.findings.find((x) => x.id === 'telemetry.register')!.message).toContain('KANON_TELEMETRY_WRITER_ROLE is not set');
    // Variables it can't list: still a step, saying so.
    const blind = parse(await run(checkout(), withVariables(null), ['--yes', '--json', '--no-apps', '--telemetry']));
    expect(blind.findings.find((x) => x.id === 'telemetry.register')!.message).toContain("the token can't list its variables");
    // Both set: no step, and a second run leaves the caller as written.
    const both = parse(await run(dir, withVariables(['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE']), ['--yes', '--json', '--no-apps', '--telemetry']));
    expect(both.findings.map((x) => x.id)).not.toContain('telemetry.register');
    expect(both.files.find((x) => x.path === TELEMETRY_CALLER_PATH)).toMatchObject({ status: 'same' });
  });

  it('takes a yes to its question without --yes', async () => {
    const dir = checkout();
    const r = await run(dir, withVariables([]), ['--no-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (q.startsWith(TELEMETRY_QUESTION) ? 'y' : d),
    });
    expect(r.status, r.err).toBe(0);
    expect(read(dir, TELEMETRY_CALLER_PATH)).toBe(telemetryCallerFile(RELEASE));
  });
});

// #433: the QA store's coordinates are secrets, which the store-coupled callers map. init writes
// the mapping in every such caller, and asks for the secrets only where the store hook exists,
// copying a variable of the same name where one holds it.
describe("kanon init and the QA store's secrets (#433)", () => {
  const HOOK = REQ.qaStore!.hook;
  const withVariables = (names: string[]) => {
    const github = fakeGitHub({ secrets: new Set(['AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) });
    const gh = github.gh;
    github.gh = async (args: string[], input?: string) => {
      if (args[0] === 'variable' && args[1] === 'list') {
        github.calls.push({ args, input });
        return ok(names.map((name) => ({ name })));
      }
      return gh(args, input);
    };
    return github;
  };
  const store = (d: ReturnType<typeof parse>) => d.findings.find((f) => f.id === 'secret.qa-store');

  it('maps both secrets in a store-coupled caller, and asks for neither without a hook', async () => {
    const dir = checkout();
    const github = withVariables([]);
    const d = parse(await run(dir, github, ['--yes', '--json', '--no-apps', '--lanes', 'code-audit']));
    const caller = read(dir, '.github/workflows/agent-code-audit.yml');
    for (const n of REQ.qaStore!.secrets) expect(caller).toContain(`      ${n}: \${{ secrets.${n} }}`);
    // The --json document carries the caller's full content (#483), mappings included.
    expect(d.files.find((f) => f.path === '.github/workflows/agent-code-audit.yml')).toMatchObject({ status: 'new', content: caller });
    expect(store(d)).toBeUndefined();
    expect(github.calls.some((c) => c.args[0] === 'variable')).toBe(false);
  });

  it('with a hook, asks for each as a secret, from the stack\'s outputs', async () => {
    const d = parse(await run(checkout({ [HOOK]: 'name: QA store\n' }), withVariables([]), ['--yes', '--json', '--no-apps', '--lanes', 'code-audit']));
    expect(store(d)).toMatchObject({ category: 'secret', subject: 'QA_STORE_BUCKET, QA_STORE_ROLE_ARN' });
    expect(store(d)!.fix.commands).toEqual([
      `gh secret set QA_STORE_BUCKET -R ${REPO}   # paste the stack's BucketName output on standard input`,
      `gh secret set QA_STORE_ROLE_ARN -R ${REPO}   # paste the stack's RoleArn output on standard input`,
    ]);
  });

  it('names the store\'s secrets among those to check by hand, when the token can\'t list them, only with a hook (#480)', async () => {
    const unreadable = async (files: Record<string, string>) => {
      const d = parse(await run(checkout(files), fakeGitHub({ secrets: null }), ['--yes', '--json', '--no-apps', '--lanes', 'code-audit']));
      return d.findings.find((f) => f.id === 'secret.unreadable')!.fix.text;
    };
    const without = await unreadable({});
    expect(without).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    for (const n of REQ.qaStore!.secrets) expect(without).not.toContain(n);
    const withHook = await unreadable({ [HOOK]: 'name: QA store\n' });
    for (const n of REQ.qaStore!.secrets) expect(withHook).toContain(n);
  });

  it('with a hook, copies a variable that holds one, and never asks for a variable', async () => {
    const d = parse(await run(checkout({ [HOOK]: 'name: QA store\n' }), withVariables(['QA_STORE_ROLE_ARN']), ['--yes', '--json', '--no-apps', '--lanes', 'code-audit']));
    expect(store(d)!.fix.commands).toEqual([
      `gh secret set QA_STORE_BUCKET -R ${REPO}   # paste the stack's BucketName output on standard input`,
      `gh variable get QA_STORE_ROLE_ARN -R ${REPO} | gh secret set QA_STORE_ROLE_ARN -R ${REPO}`,
    ]);
    expect(store(d)!.fix.text).toContain('which you then delete once a store job has run green');
    expect(JSON.stringify(d.findings)).not.toMatch(/gh variable set QA_STORE/);
  });
});
