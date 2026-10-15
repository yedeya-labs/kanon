import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { writeRegisterRow } from '../../../cli/app-register.mjs';
import { RESULT_MARK, resultLine } from '../../../cli/apps-check.mjs';
import { appSecrets, appsCheckFile, callerFile, ciFile, dependabotFile, hookFile, loadRequirements } from '../../../cli/callers.mjs';
import { doctor } from '../../../cli/doctor.mjs';
import { registerRolesOf, rulesetBody } from '../../../cli/init.mjs';

/**
 * The fixtures of the `kanon doctor` tests (tests/unit/kanon-doctor*.test.ts): a committed
 * checkout of acme/widgets in a temporary directory, and a FAKE GitHub, a function holding one
 * repository's state, one App per identity and Kanon's requirements file at each release, so
 * nothing reaches the network. The suite was one file of 157 cases, the slowest in `npm test`,
 * and was split by area so its cases run in parallel (#436).
 */
export const ROOT = process.cwd();
export const REQ = loadRequirements();
export const REPO = 'acme/widgets';
export const PINNED = 'v1.0.0';
export const NEXT = 'v1.1.0';
export const LANES = ['agent-review', 'agent-code-audit'];
export const TAXONOMY = (JSON.parse(readFileSync(join(ROOT, 'rulebook/labels.json'), 'utf8')).labels as Array<{ name: string }>).map((l) => l.name).filter((n) => !/<[a-z]+>$/.test(n));

export type Req = typeof REQ;
export const clone = (r: Req): Req => JSON.parse(JSON.stringify(r));
export const identitiesOf = (lanes: string[]) => [...new Set(lanes.flatMap((l) => REQ.lanes[l]!.identities))].sort();
export const permissionsOf = (r: Req, id: string): Record<string, string> => ({ ...(r.identities.apps[id]?.permissions ?? r.identities.roles[id]!.permissions) });

export const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The register rows for the fixture's identities, one App slug each. */
export const registerText = (ids: string[]) => {
  let text: string | null = null;
  for (const id of ids) {
    for (const role of registerRolesOf(id, REQ)) text = writeRegisterRow(text, { role, slug: `widgets-${id}`, permissions: permissionsOf(REQ, id) }).text;
  }
  return text!;
};

/** The healthy record's `## Deploy` section: the reference deploy alone, no chain (plan 0010 §4). */
export const HEALTHY_DEPLOY = '## Deploy\n- **Reference environment:** `preview`\n- **Reference deploy workflow:** `deploy-preview.yml`\n- **Reference deploy job:** `ship`\n';

/** A healthy installation of the review and code-audit lanes at PINNED, as `kanon init` writes one. */
export const healthyFiles = (): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const lane of LANES) files[`.github/workflows/${lane}.yml`] = callerFile(lane, REQ.lanes[lane]!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
  files['.github/workflows/apps-check.yml'] = appsCheckFile(identitiesOf(LANES), PINNED);
  files['.github/workflows/ci.yml'] = ciFile(PINNED, 'main');
  files['.github/dependabot.yml'] = dependabotFile();
  files[REQ.hook.path] = hookFile(REQ.hook.inputs);
  files['docs/qa/stack.md'] = '# Stack\n\n## Gates\n\n1. `npm test`\n';
  files['docs/qa/agent-identities.md'] = registerText(identitiesOf(LANES));
  // With a reference deploy of the project's own and no Kanon deploy chain, so doctor's
  // `deploy.reference-undeclared` is quiet (plan 0010 §12). `## Choices` stays last, where the
  // cases append their bullets, and the record stays 11 lines, so the line numbers they name
  // stand: the line parsers need no blank line after a heading.
  files['docs/qa/adoption.md'] = `# Adoption record\n## People\n| Role | Who |\n|---|---|\n| Owner | \`@octo\` |\n${HEALTHY_DEPLOY}## Choices\n- **Overseer:** \`not installed\`\n`;
  return files;
};

/**
 * A committed checkout of acme/widgets holding `files`, in a directory of its own.
 *
 * Git processes were most of this suite's time (#436): six per checkout and seven per doctor run,
 * about 2,500 in all, on one worker. So the repository itself (`git init`, the origin remote, the
 * author) is made once, each distinct set of files is committed once, and every case gets a copy
 * of that committed checkout, made with the file system alone. A copy is a checkout like any other:
 * a case can change it, commit to it, and run doctor on it, and no other case sees that.
 */
let skeleton: string | null = null;
const committed = new Map<string, string>();
export const checkout = (files: Record<string, string>) => {
  const key = JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  let built = committed.get(key);
  if (!built) {
    if (!skeleton) {
      skeleton = mkdtempSync(join(tmpdir(), 'kanon-doctor-skeleton-'));
      scratch.push(skeleton);
      execFileSync('git', ['init', '-q', '-b', 'main', skeleton]);
      execFileSync('git', ['-C', skeleton, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
      execFileSync('git', ['-C', skeleton, 'config', 'user.name', 'Ada Lovelace']);
      execFileSync('git', ['-C', skeleton, 'config', 'user.email', 'ada@example.com']);
      // From git 2.47, a commit starts `git maintenance run --auto --detach`, which can still be
      // writing under .git/objects after the commit returns. A copy taken then can find a file
      // gone mid-copy: ENOENT on CI's git 2.55 (#523). Every fixture and every copy inherits this
      // config, so no commit to them, here or in a case, leaves a git process behind.
      execFileSync('git', ['-C', skeleton, 'config', 'maintenance.auto', 'false']);
      execFileSync('git', ['-C', skeleton, 'config', 'gc.auto', '0']);
    }
    built = mkdtempSync(join(tmpdir(), 'kanon-doctor-built-'));
    scratch.push(built);
    cpSync(join(skeleton, '.git'), join(built, '.git'), { recursive: true });
    put(built, files);
    execFileSync('git', ['-C', built, 'add', '-A']);
    execFileSync('git', ['-C', built, 'commit', '-q', '-m', 'fixture']);
    committed.set(key, built);
  }
  const dir = mkdtempSync(join(tmpdir(), 'kanon-doctor-'));
  scratch.push(dir);
  cpSync(built, dir, { recursive: true });
  return dir;
};

export const put = (dir: string, files: Record<string, string | null>) => {
  for (const [rel, text] of Object.entries(files)) {
    const at = join(dir, rel);
    if (text === null) rmSync(at, { force: true });
    else {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, text);
    }
  }
};

export type Gh = { status: number; stdout: string; stderr: string };
export const ok = (v: unknown): Gh => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
export const no = (stderr: string): Gh => ({ status: 1, stdout: '', stderr });

/** A fake GitHub: the repository, its Apps, and Kanon's requirements file at each release. */
export const fakeGitHub = (over: { secrets?: Set<string> | null; releases?: Record<string, Req | null>; templates?: Record<string, string>; variables?: Set<string> | Map<string, string> | null; latest?: string | null } = {}) => {
  const ids = identitiesOf(LANES);
  const st = {
    labels: new Set(TAXONOMY),
    secrets: over.secrets === undefined ? new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets)) : over.secrets,
    apps: Object.fromEntries(ids.map((id) => [`widgets-${id}`, { owner: { login: 'acme', type: 'User' }, permissions: permissionsOf(REQ, id) }])) as Record<string, { id?: number; owner: object; permissions: Record<string, string> }>,
    rulesets: [{ id: 7, ...rulesetBody(false) }] as Array<ReturnType<typeof rulesetBody> & { id: number; bypass_actors?: unknown[]; source_type?: string }>,
    releases: over.releases ?? {},
    /** Kanon's brief template at each release (`rulebook/templates/brief.md`, #755); a release not here answers 404. */
    templates: over.templates ?? {},
    /** Kanon's latest release's tag, as GET releases/latest names it (plan 0009 S2); null answers 404. */
    latest: over.latest ?? null,
    installations: null as Array<{ id: number; app_slug: string; app_id?: number; account: { login: string } }> | null,
    variables: over.variables === undefined ? new Set<string>() : over.variables,
    // The workflows on the default branch, as GitHub has them (#418): CI with the lane check's job.
    defaultWorkflows: { 'ci.yml': ciFile(PINNED, 'main') } as Record<string, string> | null,
    ownerType: 'User' as 'User' | 'Organization',
    /** A private repository on a plan without rulesets: its rulesets answer 403 "Upgrade to GitHub Pro". */
    noRulesetsOnPlan: false,
    /** Slugs of private Apps: GET /apps/<slug> answers 404 to a person's token and the workflow's (#417). */
    private: new Set<string>(),
    appsCheck: { runs: [] as AppsCheckRun[], jobs: {} as Record<number, Array<{ id: number; name: string; conclusion: string }>>, logs: {} as Record<number, string>, ignoresEvent: false /* a server that ignores the event filter, so doctor's own check is what refuses */,
      /** The values of the run's secrets, each App's <APP>_APP_ID among them, which the runner masks in every log as `***`. */
      secrets: new Set<string>() },
    /** Each secret's `updatedAt`, as `gh secret list --json name,updatedAt` gives it; a secret not here was stored just now (plan 0009 §11). */
    secretDates: {} as Record<string, string>,
    /** Each workflow file's runs, as `gh run list --workflow <file>` gives them, newest first; a file not here has none. */
    runs: {} as Record<string, Array<{ databaseId: number; conclusion: string; createdAt: string }>>,
    /** `gh run list`'s answer when it fails, such as a token without Actions: read. */
    runsRefused: null as string | null,
    /** Each run's jobs, by run id (`GET actions/runs/<id>/jobs`), and each job's annotations, by its check run id. */
    runJobs: {} as Record<number, Array<{ id: number; name: string; conclusion: string }>>,
    annotations: {} as Record<number, Array<{ title: string; annotation_level: string; message: string }>>,
    /** The repository's run artifacts (`GET actions/artifacts`), newest first, each with its zip's bytes; none by default. */
    artifacts: [] as FakeArtifact[],
    /** The artifact listing's answer when it fails, such as a token without Actions: read. */
    artifactsRefused: null as string | null,
  };
  const calls: string[][] = [];
  const inputs: string[] = [];
  const gh = async (args: string[], input?: string): Promise<Gh> => {
    calls.push(args);
    if (input) inputs.push(input);
    const [a0, a1] = args;
    if (a0 === 'api' && a1 === 'graphql') {
      const { variables } = JSON.parse(input ?? '{}') as { variables: { owner: string; name: string; expression: string } };
      if (!st.defaultWorkflows || `${variables.owner}/${variables.name}` !== REPO || variables.expression !== 'main:.github/workflows') return no('gh: Resource not accessible by personal access token (HTTP 403)');
      const entries = Object.entries(st.defaultWorkflows).map(([name, text]) => ({ name, type: 'blob', object: { text } }));
      return ok({ data: { repository: { object: entries.length ? { entries } : null } } });
    }
    if (a0 === 'api' && a1 === 'user') return ok('octo\n');
    if (a0 === 'api' && (a1 === 'user/installations?per_page=100' || a1 === 'orgs/acme/installations?per_page=100')) return st.installations ? ok({ total_count: st.installations.length, installations: st.installations }) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    if (a0 === 'secret' && a1 === 'list') return st.secrets ? ok([...st.secrets].map((name) => ({ name, updatedAt: st.secretDates[name] ?? new Date().toISOString() }))) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    if (a0 === 'run' && a1 === 'list') {
      if (st.runsRefused) return no(st.runsRefused);
      const file = args[args.indexOf('--workflow') + 1]!;
      return ok((st.runs[file] ?? []).slice(0, Number(args[args.indexOf('--limit') + 1])));
    }
    // A Set names variables only; a Map gives their values too (#609).
    if (a0 === 'variable' && a1 === 'list') return st.variables ? ok(st.variables instanceof Map ? [...st.variables].map(([name, value]) => ({ name, value })) : [...st.variables].map((name) => ({ name, value: '' }))) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    if (a0 !== 'api' || args.includes('-X')) return no(`unexpected gh ${args.join(' ')}`);
    const path = args.find((x, i) => i > 0 && /^(repos|orgs|apps)\//.test(x)) ?? '';
    if (path === `repos/${REPO}`) return ok({ private: st.noRulesetsOnPlan, default_branch: 'main', owner: { login: 'acme', type: st.ownerType }, permissions: { admin: true } });
    const runs = /^repos\/acme\/widgets\/actions\/workflows\/apps-check\.yml\/runs\?(.*)$/.exec(path);
    if (runs) {
      const q = new URLSearchParams(runs[1]);
      const list = st.appsCheck.runs.filter((x) => (!q.get('branch') || x.head_branch === q.get('branch')) && (!q.get('event') || st.appsCheck.ignoresEvent || x.event === q.get('event')) && (!q.get('status') || q.get('status') === 'completed'));
      return ok({ total_count: list.length, workflow_runs: list.slice(0, Number(q.get('per_page') ?? 30)) });
    }
    const listed = /^repos\/acme\/widgets\/actions\/artifacts\?per_page=100&page=(\d+)$/.exec(path);
    if (listed) {
      if (st.artifactsRefused) return no(st.artifactsRefused);
      const page = Number(listed[1]);
      return ok({ total_count: st.artifacts.length, artifacts: st.artifacts.slice((page - 1) * 100, page * 100).map((a) => ({ id: a.id, name: a.name, created_at: a.created_at, expires_at: a.expires_at, expired: a.expired ?? false, workflow_run: a.workflow_run })) });
    }
    const jobs = /^repos\/acme\/widgets\/actions\/runs\/(\d+)\/jobs(\?.*)?$/.exec(path);
    if (jobs) return ok({ jobs: st.runJobs[Number(jobs[1])] ?? st.appsCheck.jobs[Number(jobs[1])] ?? [] });
    const notes = /^repos\/acme\/widgets\/check-runs\/(\d+)\/annotations(\?.*)?$/.exec(path);
    if (notes) return st.annotations[Number(notes[1])] ? ok(st.annotations[Number(notes[1])]) : ok([]);
    const log = /^repos\/acme\/widgets\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (log) return st.appsCheck.logs[Number(log[1])] !== undefined ? ok(masked(st.appsCheck.logs[Number(log[1])]!, st.appsCheck.secrets)) : no('gh: Not Found (HTTP 404)');
    if (path === `repos/${REPO}/branches/main`) return ok('main');
    if (path.startsWith(`repos/${REPO}/rulesets?`)) return st.noRulesetsOnPlan ? no('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)') : ok(st.rulesets.map((r) => ({ id: r.id, name: r.name, target: r.target })));
    const one = /^repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(path);
    if (one) return ok(st.rulesets.find((r) => r.id === Number(one[1])));
    if (path.startsWith(`repos/${REPO}/labels?`)) return ok([[...st.labels].map((name) => ({ name }))]);
    if (path.startsWith(`repos/${REPO}/milestones?`)) return ok([[]]);
    const app = /^apps\/([a-z0-9-]+)$/.exec(path);
    if (app) return st.apps[app[1]!] && !st.private.has(app[1]!) ? ok({ slug: app[1], ...st.apps[app[1]!] }) : no('gh: Not Found (HTTP 404)');
    if (path === 'repos/yedeya-labs/kanon/releases/latest') return st.latest ? ok({ tag_name: st.latest, prerelease: false }) : no('gh: Not Found (HTTP 404)');
    const rel = /^repos\/yedeya-labs\/kanon\/contents\/requirements\.json\?ref=(.+)$/.exec(path);
    if (rel) {
      const r = st.releases[decodeURIComponent(rel[1]!)];
      return r ? ok(r) : no('gh: Not Found (HTTP 404)');
    }
    const template = /^repos\/yedeya-labs\/kanon\/contents\/rulebook\/templates\/brief\.md\?ref=(.+)$/.exec(path);
    if (template) {
      const t = st.templates[decodeURIComponent(template[1]!)];
      return t !== undefined ? ok(t) : no('gh: Not Found (HTTP 404)');
    }
    return no(`unexpected gh ${args.join(' ')}`);
  };
  /** One artifact's zip, by id, as `gh api repos/<repo>/actions/artifacts/<id>/zip` gives its bytes. */
  const download = async (repo: string, id: number) => {
    calls.push(['api', `repos/${repo}/actions/artifacts/${id}/zip`]);
    const a = repo === REPO ? st.artifacts.find((x) => x.id === id) : undefined;
    if (!a || a.zip === null) return { status: 1, bytes: Buffer.alloc(0), stderr: 'gh: Not Found (HTTP 404)' };
    return { status: 0, bytes: a.zip, stderr: '' };
  };
  return { st, gh, download, calls, inputs };
};

/** An artifact as `GET repos/<repo>/actions/artifacts` lists it, with its zip (null: its download fails). */
export type FakeArtifact = {
  id: number; name: string; created_at: string; expires_at: string; expired?: boolean;
  workflow_run: { id: number; repository_id: number; head_repository_id: number } | null;
  zip: Buffer | null;
};

/** A log as the runner writes it: each secret's value, wherever it appears, is `***`. */
const masked = (log: string, secrets: Set<string>) => [...secrets].reduce((text, value) => text.split(value).join('***'), log);

export type AppsCheckRun = { id: number; head_branch: string; event: string; head_repository: { full_name: string }; html_url: string; created_at: string; conclusion: string };

/**
 * A completed run of the apps-check caller, newest first: each App's job printed the line
 * apps-check writes for doctor, with what its installation holds (#417).
 */
export const appsCheckRun = (
  github: ReturnType<typeof fakeGitHub>,
  holds: Record<string, Record<string, string>>,
  o: { branch?: string; event?: string; from?: string; conclusion?: string; slugs?: Record<string, string>; appIds?: Record<string, number>; line?: boolean | 'with-id' } = {},
) => {
  const id = 900 + github.st.appsCheck.runs.length;
  const conclusion = o.conclusion ?? 'success';
  github.st.appsCheck.runs.unshift({ id, head_branch: o.branch ?? 'main', event: o.event ?? 'workflow_dispatch', head_repository: { full_name: o.from ?? REPO }, html_url: `https://github.com/${REPO}/actions/runs/${id}`, created_at: '2026-10-06T17:32:19Z', conclusion });
  const apps = Object.keys(holds);
  github.st.appsCheck.jobs[id] = [{ id: id * 10, name: 'apps / Read the App register', conclusion: 'success' }, ...apps.map((app, i) => ({ id: id * 10 + i + 1, name: `apps / ${REQ.identities.apps[app]!.name}`, conclusion }))];
  apps.forEach((app, i) => {
    const result = { app, slug: o.slugs?.[app] ?? `widgets-${app}`, permissions: holds[app]! };
    // The App's id is its <APP>_APP_ID secret, which the job maps and the runner masks.
    const appId = String(o.appIds?.[app] ?? 3100001 + i);
    github.st.appsCheck.secrets.add(appId);
    github.st.appsCheck.logs[id * 10 + i + 1] = [
      '2026-10-06T17:32:40.1163336Z ##[group]Run actions/create-github-app-token',
      `2026-10-06T17:32:40.1163336Z   client-id: ${appId}`,
      '2026-10-06T17:32:43.2932067Z ##[group]Run node "$KANON/cli/apps-check.mjs" check',
      `2026-10-06T17:32:43.2932067Z   APP_ID: ${appId}`,
      // 'with-id': the line as d7a7108 printed it, with the App's id in it.
      ...(o.line === false ? [] : [`2026-10-06T17:32:44.1163336Z ${o.line === 'with-id' ? `${RESULT_MARK} ${JSON.stringify({ app, slug: result.slug, appId: Number(appId), permissions: result.permissions })}` : resultLine(result)}`]),
      `2026-10-06T17:32:44.1163336Z ${REQ.identities.apps[app]!.name}: the installation matches the register and the App's permissions.`,
    ].join('\n');
  });
  return `https://github.com/${REPO}/actions/runs/${id}`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the JSON document, read field by field
export type Result = { status: number; out: string; err: string; json: any };

export const run = async (dir: string, github: ReturnType<typeof fakeGitHub>, argv: string[] = [], now?: number): Promise<Result> => {
  const out: string[] = [];
  const err: string[] = [];
  const status = await doctor(['--dir', dir, ...argv], {
    gh: github.gh,
    download: github.download,
    env: {},
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    requirements: () => REQ,
    release: () => PINNED,
    ...(now === undefined ? {} : { now: () => now }),
  });
  const text = out.join('\n');
  return { status, out: text, err: err.join('\n'), json: argv.includes('--json') ? JSON.parse(text) : null };
};

export const ids = (r: Result) => r.json.findings.map((f: { id: string; subject: string }) => `${f.id} ${f.subject}`);

/** The release after PINNED: one App permission more, and one declaration more for the review lane:
 *  a document with no baseline, which the lane would need whatever the adoption record chose. */
export const NEW_DOC = 'docs/qa/release-checklist.md';
export const nextRelease = () => {
  const next = clone(REQ);
  const judgeLike = REQ.lanes['agent-review']!.identities[0]!;
  const target = next.identities.apps[judgeLike] ?? next.identities.roles[judgeLike]!;
  target.permissions.deployments = 'read';
  next.lanes['agent-review']!.reads = [...next.lanes['agent-review']!.reads, NEW_DOC].sort();
  return { next, slug: `widgets-${judgeLike}` };
};

/** A release caller reaching Kanon's release workflow by `uses`, mapping the Releaser's secrets. */
export const releaseBy = (uses: string) => [
  'name: Release', 'on:', '  push:', '    branches: [main]', 'permissions: {}', 'jobs:', '  release:',
  '    permissions:', '      contents: write', '      pull-requests: write',
  `    uses: ${uses}`,
  '    secrets:', ...appSecrets('releaser').map((n) => `      ${n}: \${{ secrets.${n} }}`), '',
].join('\n');

/** The Releaser as an App in use (#441): its register row, and the apps-check caller mapping it. */
export const releaserFiles = (files: Record<string, string>) => ({
  ...files,
  'docs/qa/agent-identities.md': registerText([...identitiesOf(LANES), 'releaser']),
  '.github/workflows/apps-check.yml': appsCheckFile([...identitiesOf(LANES), 'releaser'], PINNED),
});
export const RELEASER_APP_ID = 4242;
export const RELEASER_BYPASS = { actor_id: RELEASER_APP_ID, actor_type: 'Integration', bypass_mode: 'pull_request' };
/** The Releaser's App on GitHub, and each ruleset's bypass listing it alone (#441). */
export const releaserOn = (github: ReturnType<typeof fakeGitHub>, bypass: unknown[] = [RELEASER_BYPASS]) => {
  github.st.apps['widgets-releaser'] = { id: RELEASER_APP_ID, owner: { login: 'acme', type: 'User' }, permissions: permissionsOf(REQ, 'releaser') };
  github.st.rulesets = github.st.rulesets.map((r) => ({ ...r, bypass_actors: bypass }));
  return github;
};
