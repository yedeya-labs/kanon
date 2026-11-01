import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { writeRegisterRow } from '../../../cli/app-register.mjs';
import { ciFile, loadRequirements } from '../../../cli/callers.mjs';
import { init, registerRolesOf } from '../../../cli/init.mjs';
import { branchRules } from './branch-rules.js';

/**
 * The fixtures of the `kanon init` tests (tests/unit/kanon-init*.test.ts): a committed checkout of
 * acme/widgets in a temporary directory, a FAKE GitHub for it, and the reader of docs/init.md's
 * tables. The suite was one file of 228 cases, the slowest in `npm test`, and was split by area
 * so its cases run in parallel (#1204), as the doctor's were (#436).
 *
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
export const ROOT = process.cwd();
export const LANE_CHECK_SH = join(ROOT, 'actions/lane-check/lane-check.sh');
export const hasYq = spawnSync('yq', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasYq && process.env.CI) throw new Error('kanon init tests need yq on PATH in CI');
export const REQ = loadRequirements();
export const TAXONOMY = (JSON.parse(readFileSync(join(ROOT, 'rulebook/labels.json'), 'utf8')).labels as Array<{ name: string }>).map((l) => l.name).filter((n) => !/<[a-z]+>$/.test(n));
export const REPO = 'acme/widgets';
/** The release this tree is, which everything init writes pins. */
export const PINNED = `v${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`;

export const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * An empty repository with `remote` as its origin, made once per remote: each checkout is a copy
 * of it, made with the file system alone. Four `git` processes per case were a third of this
 * file's processes (#436). Nothing ever commits to the skeleton, so no git process can still be
 * writing to it while it is copied (helpers/doctor.ts says why that matters).
 */
export const skeletons = new Map<string, string>();
export const skeleton = (remote: string) => {
  let dir = skeletons.get(remote);
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'kanon-init-skeleton-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada Lovelace']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.com']);
    skeletons.set(remote, dir);
  }
  return dir;
};

/** A checkout of acme/widgets with no files, or with the given ones, committed or not. */
export const checkout = (files: Record<string, string> = {}, remote = `https://github.com/${REPO}.git`) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-init-'));
  dirs.push(dir);
  cpSync(skeleton(remote), dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
};

export type Gh = { status: number; stdout: string; stderr: string };
export const ok = (v: unknown): Gh => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
export const no = (stderr: string): Gh => ({ status: 1, stdout: '', stderr });

export type State = {
  kind: 'User' | 'Organization';
  private: boolean;
  admin: boolean;
  /** False for a fine-grained token whose repository access leaves the repository out (#1551): GitHub refuses it the collaborators, and every write. */
  tokenCovers?: boolean;
  hasCommits: boolean;
  rulesetsOnPlan: boolean;
  orgPlan?: string;
  labels: Set<string>;
  milestones: Set<string>;
  secrets: Set<string> | null;
  rulesets: Array<Record<string, unknown> & { id: number }>;
  /** Ruleset ids whose GET answers 404, as for one the token can't read whole (#1262). */
  unreadableRulesets?: number[];
  settings: Record<string, unknown>;
  labelCreateFails?: boolean;
  /** The workflows on the default branch, as GitHub has them (#444); null when the token can't read them. */
  defaultWorkflows: Record<string, string> | null;
  rulesetUpdateFails?: boolean;
  /** The owner's App installations, as `GET orgs/<org>/installations` or `user/installations` lists them; unset, the token can't list them. */
  installations?: Array<Record<string, unknown>>;
  /** The public Apps, as `GET /apps/<slug>` answers them (#462); any other slug is private, which it answers 404 to a person's token. */
  publicApps?: Record<string, { owner: { login: string } }>;
  /** The owner's repositories the token can read, each with its App register's text or null (plan 0007 G4); unset, the token can't list them. */
  registers?: Record<string, string | null>;
  /** The repository's environments, by name (plan 0010 D6); unset, the token can't list them. */
  environments?: string[];
  /** The tags on Kanon's own repository, which `init` pins from (plan 0012 decision 5, CLI-1); this tree's release by default. */
  kanonTags: Set<string>;
  /** What GitHub answers a tag lookup on Kanon's repository with instead, when it can't answer (CLI-1). */
  kanonTagsFail?: string;
};

/** A fake GitHub for one repository. Every call is recorded; the mutating ones change the state. */
export const fakeGitHub = (over: Partial<State> = {}) => {
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
    kanonTags: new Set([PINNED]),
    ...over,
  };
  const calls: Array<{ args: string[]; input?: string }> = [];
  const gh = async (args: string[], input?: string): Promise<Gh> => {
    calls.push({ args, input });
    const [a0, a1] = args;
    if (a0 === 'api' && a1 === 'user') return ok('octo\n');
    if (a0 === 'api' && a1 === 'graphql') {
      const { query, variables } = JSON.parse(input ?? '{}') as { query: string; variables: { owner: string; name: string; expression: string } };
      if (/repositoryOwner/.test(query)) {
        if (!st.registers || variables.owner !== 'acme') return no('gh: Resource not accessible by personal access token (HTTP 403)');
        const nodes = Object.entries(st.registers).map(([name, text]) => ({ name, object: text === null ? null : { text } }));
        return ok({ data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
      }
      if (!st.defaultWorkflows || `${variables.owner}/${variables.name}` !== REPO || variables.expression !== 'main:.github/workflows') return no('gh: Resource not accessible by personal access token (HTTP 403)');
      const entries = Object.entries(st.defaultWorkflows).map(([name, text]) => ({ name, type: 'blob', object: { text } }));
      return ok({ data: { repository: { object: entries.length ? { entries } : null } } });
    }
    if (a0 === 'secret' && a1 === 'list') return st.secrets ? ok([...st.secrets].map((name) => ({ name }))) : no('gh: Resource not accessible by integration (HTTP 403)');
    if (a0 === 'label' && a1 === 'create') {
      if (st.labelCreateFails || st.tokenCovers === false) return no('gh: Resource not accessible by personal access token (HTTP 403)');
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
      if (!st.admin || st.tokenCovers === false) return no('gh: Resource not accessible by personal access token (HTTP 403)');
      for (const f of args.filter((x, i) => args[i - 1] === '-f' || args[i - 1] === '-F')) {
        const [k, v] = [f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)];
        st.settings[k] = v === 'true' ? true : v === 'false' ? false : v;
      }
      return ok('{}');
    }
    if (method === 'POST' && path === `repos/${REPO}/rulesets`) {
      if (!st.admin || st.tokenCovers === false) return no('gh: Resource not accessible by personal access token (HTTP 403)');
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
    const tag = /^repos\/yedeya-labs\/kanon\/git\/ref\/tags\/(.+)$/.exec(path);
    if (tag) {
      const name = decodeURIComponent(tag[1]!);
      if (st.kanonTagsFail) return no(st.kanonTagsFail);
      return st.kanonTags.has(name) ? ok(`refs/tags/${name}\n`) : no('gh: Not Found (HTTP 404)');
    }
    if (path.startsWith(`repos/${REPO}/collaborators?`)) return st.tokenCovers === false ? no('gh: Resource not accessible by personal access token (HTTP 403)') : ok('1');
    if (path === `repos/${REPO}/branches/main`) return st.hasCommits ? ok('main') : no('gh: Branch not found (HTTP 404)');
    if (path.startsWith(`repos/${REPO}/rulesets?`)) {
      if (!st.rulesetsOnPlan) return no('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)');
      return ok(st.rulesets.map((r) => ({ id: r.id, name: r.name, target: r.target })));
    }
    if (path.startsWith(`repos/${REPO}/rules/branches/`)) return ok(branchRules(st.rulesets, REPO));
    const one = /^repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(path);
    if (one && st.unreadableRulesets?.includes(Number(one[1]))) return no('gh: Not Found (HTTP 404)');
    if (one) return ok(st.rulesets.find((r) => r.id === Number(one[1])));
    if (path === 'orgs/acme') return st.orgPlan ? ok({ plan: { name: st.orgPlan } }) : no('gh: Not Found (HTTP 404)');
    if (path.startsWith(`repos/${REPO}/environments?`)) return st.environments ? ok({ total_count: st.environments.length, environments: st.environments.map((name) => ({ name })) }) : no('gh: Not Found (HTTP 404)');
    if (path.startsWith(`repos/${REPO}/labels?`)) return ok([[...st.labels].map((name) => ({ name }))]);
    if (path.startsWith(`repos/${REPO}/milestones?`)) return ok([[...st.milestones].map((title) => ({ title }))]);
    return no(`unexpected gh ${args.join(' ')}`);
  };
  return { st, gh, calls };
};

/** The calls that change something on GitHub. */
export const writes = (calls: Array<{ args: string[] }>) =>
  calls.map((c) => c.args).filter((a) => (a[0] === 'label' && a[1] !== 'list') || a.includes('PATCH') || a.includes('POST') || a.includes('PUT') || a.includes('DELETE'));

export type Run = { status: number; out: string; err: string; appsCalls: string[][]; milestoneCalls: string[][] };

export const run = async (dir: string, github: ReturnType<typeof fakeGitHub>, argv: string[] = ['--yes'], answers?: Record<string, string>, requirements = REQ, extra: NonNullable<Parameters<typeof init>[1]> = {}): Promise<Run> => {
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

/** The confirmation `init` asks after its summary (plan 0007 §3, Q5). */
export const CONFIRM = 'Install Kanon with these settings?';

/**
 * A person at the terminal: a question that contains a key gets its answer, an array's one at a
 * time (its last one after that), and any other question its default. Every question is recorded.
 */
export const person = (answers: Record<string, string | string[]>, asked: string[] = []) => async (q: string, d: string) => {
  asked.push(q);
  const key = Object.keys(answers).find((k) => q.includes(k));
  if (!key) return d;
  const v = answers[key]!;
  if (!Array.isArray(v)) return v;
  return (v.length > 1 ? v.shift() : v[0]) ?? d;
};

/** **Change something** on the summary, the groups given, then **Install**. */
export const changing = (groups: string, answers: Record<string, string | string[]> = {}, asked: string[] = []) =>
  person({ [CONFIRM]: ['2', '1'], 'Which lines to change': groups, ...answers }, asked);

export const laneCheck = (dir: string) => {
  const r = spawnSync('bash', [LANE_CHECK_SH], { cwd: dir, encoding: 'utf8', env: { ...process.env, KANON_ROOT: ROOT, ACTION_REF: '' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

export const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

/** docs/init.md, which documents the flags. */
export const INIT_DOC = readFileSync(join(ROOT, 'docs/init.md'), 'utf8');

/** A column of the tables under a `### <heading>` (or `## <heading>`) of docs/init.md, header and rule rows left out. */
export const tableColumn = (heading: string, which = 0): string[] => {
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
export const fields = (heading: string) => tableColumn(heading).map((c) => /^`([^`]+)`$/.exec(c)?.[1] ?? c);

export type Doc = Record<string, unknown> & {
  schema: string; kanon: string; pin: string | null; status: string; exitCode: number; dryRun: boolean;
  inspection: Record<string, unknown>; answers: Record<string, unknown>;
  files: Array<Record<string, unknown>>; changes: Array<Record<string, unknown>>; apps: Record<string, unknown>;
  findings: Array<{ id: string; category: string; blocking: boolean; subject: string; message: string; fix: { text: string; commands: string[]; url: string | null } }>;
  notes: string[]; failures: string[];
  features: Array<Record<string, unknown> & { feature: string; lanes: string[]; conditional: Array<{ lane: string; condition: string; met: boolean }> }>;
  summary: Array<{ answer: string; fields: string[]; value: string; source: string; reason: string }>;
};
export const parse = (r: Run): Doc => JSON.parse(r.out) as Doc;
export const keys = (o: object) => Object.keys(o).sort();
