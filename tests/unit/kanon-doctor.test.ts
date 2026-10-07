import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeRegisterRow } from '../../cli/app-register.mjs';
import { RESULT_MARK, resultLine } from '../../cli/apps-check.mjs';
import { appSecrets, appsCheckFile, callerFile, ciFile, dependabotFile, hookFile, loadRequirements, TELEMETRY_CALLER_PATH, telemetryCallerFile } from '../../cli/callers.mjs';
import { branchPattern, branchWorkflows, CATEGORIES, checkJobs, checkReporters, doctor, EXIT, FINDINGS, HOLDER_LABEL, idTokenGrant, ITEMIZED, kanonPins, parseArgs, readHolderAcceptances, readWaivers, SCHEMA, UNWAIVABLE, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { registerRolesOf, rulesetBody } from '../../cli/init.mjs';
import { isKanonSource, pluginSettingsFile, readPluginDeclaration } from '../../cli/plugin.mjs';
import { laneFiles, laneTree } from './helpers/requirements.js';

/**
 * `kanon doctor` (plan 0005 §5.5, step L10). Every case runs the command against a real git
 * checkout in a temporary directory and a FAKE GitHub: `gh` is a function holding one
 * repository's state, one App per identity and Kanon's requirements file at each release, so
 * nothing reaches the network, and the test asserts that doctor only ever reads.
 *
 * The plan's falsifiable checks for L10:
 *  - on a fixture pinned at one release, `doctor --to` a release whose requirements add an App
 *    permission and a declaration lists exactly those two, and exits non-zero; after both are
 *    fixed it exits 0;
 *  - a requirements file that drops the permission makes doctor miss it, and the test that
 *    compares the requirements file with the lanes' minting steps turns red;
 *  - a job of the adopter's holding `id-token: write` (its own grant, inherited from the
 *    workflow, `write-all`, or passed to a reusable workflow of its own) is named, and the run
 *    exits non-zero until the adoption record accepts it or the grant is removed; a caller of
 *    Kanon's code-audit lane at the pinned release is listed as Kanon's and accepted; a job with
 *    `id-token: none` is not listed.
 * And ADR 0014's: the `--json` document is a versioned contract, documented in docs/doctor.md.
 */
const ROOT = process.cwd();
const REQ = loadRequirements();
const REPO = 'acme/widgets';
const PINNED = 'v1.0.0';
const NEXT = 'v1.1.0';
const LANES = ['agent-review', 'agent-code-audit'];
const TAXONOMY = (JSON.parse(readFileSync(join(ROOT, 'rulebook/labels.json'), 'utf8')).labels as Array<{ name: string }>).map((l) => l.name).filter((n) => !/<[a-z]+>$/.test(n));

type Req = typeof REQ;
const clone = (r: Req): Req => JSON.parse(JSON.stringify(r));
const identitiesOf = (lanes: string[]) => [...new Set(lanes.flatMap((l) => REQ.lanes[l]!.identities))].sort();
const permissionsOf = (r: Req, id: string): Record<string, string> => ({ ...(r.identities.apps[id]?.permissions ?? r.identities.roles[id]!.permissions) });

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The register rows for the fixture's identities, one App slug each. */
const registerText = (ids: string[]) => {
  let text: string | null = null;
  for (const id of ids) {
    for (const role of registerRolesOf(id, REQ)) text = writeRegisterRow(text, { role, slug: `widgets-${id}`, permissions: permissionsOf(REQ, id) }).text;
  }
  return text!;
};

/** A healthy installation of the review and code-audit lanes at PINNED, as `kanon init` writes one. */
const healthyFiles = (): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const lane of LANES) files[`.github/workflows/${lane}.yml`] = callerFile(lane, REQ.lanes[lane]!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
  files['.github/workflows/apps-check.yml'] = appsCheckFile(identitiesOf(LANES), PINNED);
  files['.github/workflows/ci.yml'] = ciFile(PINNED, 'main');
  files['.github/dependabot.yml'] = dependabotFile();
  files[REQ.hook.path] = hookFile(REQ.hook.inputs);
  files['docs/qa/stack.md'] = '# Stack\n\n## Gates\n\n1. `npm test`\n';
  files['docs/qa/agent-identities.md'] = registerText(identitiesOf(LANES));
  files['docs/qa/adoption.md'] = '# Adoption record\n\n## People\n\n| Role | Who |\n|---|---|\n| Owner | `@octo` |\n\n## Choices\n\n- **Overseer:** `not installed`\n';
  return files;
};

/** A committed checkout of acme/widgets holding `files`. */
const checkout = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanon-doctor-'));
  scratch.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Ada Lovelace']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'ada@example.com']);
  put(dir, files);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture']);
  return dir;
};

const put = (dir: string, files: Record<string, string | null>) => {
  for (const [rel, text] of Object.entries(files)) {
    const at = join(dir, rel);
    if (text === null) rmSync(at, { force: true });
    else {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, text);
    }
  }
};

type Gh = { status: number; stdout: string; stderr: string };
const ok = (v: unknown): Gh => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
const no = (stderr: string): Gh => ({ status: 1, stdout: '', stderr });

/** A fake GitHub: the repository, its Apps, and Kanon's requirements file at each release. */
const fakeGitHub = (over: { secrets?: Set<string> | null; releases?: Record<string, Req | null>; variables?: Set<string> | null } = {}) => {
  const ids = identitiesOf(LANES);
  const st = {
    labels: new Set(TAXONOMY),
    secrets: over.secrets === undefined ? new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets)) : over.secrets,
    apps: Object.fromEntries(ids.map((id) => [`widgets-${id}`, { owner: { login: 'acme', type: 'User' }, permissions: permissionsOf(REQ, id) }])) as Record<string, { id?: number; owner: object; permissions: Record<string, string> }>,
    rulesets: [{ id: 7, ...rulesetBody(false) }] as Array<ReturnType<typeof rulesetBody> & { id: number; bypass_actors?: unknown[]; source_type?: string }>,
    releases: over.releases ?? {},
    installations: null as Array<{ id: number; app_slug: string; app_id?: number; account: { login: string } }> | null,
    variables: over.variables === undefined ? new Set<string>() : over.variables,
    // The workflows on the default branch, as GitHub has them (#418): CI with the lane check's job.
    defaultWorkflows: { 'ci.yml': ciFile(PINNED, 'main') } as Record<string, string> | null,
    ownerType: 'User' as 'User' | 'Organization',
    /** Slugs of private Apps: GET /apps/<slug> answers 404 to a person's token and the workflow's (#417). */
    private: new Set<string>(),
    appsCheck: { runs: [] as AppsCheckRun[], jobs: {} as Record<number, Array<{ id: number; name: string; conclusion: string }>>, logs: {} as Record<number, string>, ignoresEvent: false /* a server that ignores the event filter, so doctor's own check is what refuses */,
      /** The values of the run's secrets, each App's <APP>_APP_ID among them, which the runner masks in every log as `***`. */
      secrets: new Set<string>() },
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
    if (a0 === 'secret' && a1 === 'list') return st.secrets ? ok([...st.secrets].map((name) => ({ name }))) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    if (a0 === 'variable' && a1 === 'list') return st.variables ? ok([...st.variables].map((name) => ({ name }))) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    if (a0 !== 'api' || args.includes('-X')) return no(`unexpected gh ${args.join(' ')}`);
    const path = args.find((x, i) => i > 0 && /^(repos|orgs|apps)\//.test(x)) ?? '';
    if (path === `repos/${REPO}`) return ok({ private: false, default_branch: 'main', owner: { login: 'acme', type: st.ownerType }, permissions: { admin: true } });
    const runs = /^repos\/acme\/widgets\/actions\/workflows\/apps-check\.yml\/runs\?(.*)$/.exec(path);
    if (runs) {
      const q = new URLSearchParams(runs[1]);
      const list = st.appsCheck.runs.filter((x) => (!q.get('branch') || x.head_branch === q.get('branch')) && (!q.get('event') || st.appsCheck.ignoresEvent || x.event === q.get('event')) && (!q.get('status') || q.get('status') === 'completed'));
      return ok({ total_count: list.length, workflow_runs: list.slice(0, Number(q.get('per_page') ?? 30)) });
    }
    const jobs = /^repos\/acme\/widgets\/actions\/runs\/(\d+)\/jobs(\?.*)?$/.exec(path);
    if (jobs) return ok({ jobs: st.appsCheck.jobs[Number(jobs[1])] ?? [] });
    const log = /^repos\/acme\/widgets\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (log) return st.appsCheck.logs[Number(log[1])] !== undefined ? ok(masked(st.appsCheck.logs[Number(log[1])]!, st.appsCheck.secrets)) : no('gh: Not Found (HTTP 404)');
    if (path === `repos/${REPO}/branches/main`) return ok('main');
    if (path.startsWith(`repos/${REPO}/rulesets?`)) return ok(st.rulesets.map((r) => ({ id: r.id, name: r.name, target: r.target })));
    const one = /^repos\/acme\/widgets\/rulesets\/(\d+)$/.exec(path);
    if (one) return ok(st.rulesets.find((r) => r.id === Number(one[1])));
    if (path.startsWith(`repos/${REPO}/labels?`)) return ok([[...st.labels].map((name) => ({ name }))]);
    if (path.startsWith(`repos/${REPO}/milestones?`)) return ok([[]]);
    const app = /^apps\/([a-z0-9-]+)$/.exec(path);
    if (app) return st.apps[app[1]!] && !st.private.has(app[1]!) ? ok({ slug: app[1], ...st.apps[app[1]!] }) : no('gh: Not Found (HTTP 404)');
    const rel = /^repos\/yedeya-labs\/kanon\/contents\/requirements\.json\?ref=(.+)$/.exec(path);
    if (rel) {
      const r = st.releases[decodeURIComponent(rel[1]!)];
      return r ? ok(r) : no('gh: Not Found (HTTP 404)');
    }
    return no(`unexpected gh ${args.join(' ')}`);
  };
  return { st, gh, calls, inputs };
};

/** A log as the runner writes it: each secret's value, wherever it appears, is `***`. */
const masked = (log: string, secrets: Set<string>) => [...secrets].reduce((text, value) => text.split(value).join('***'), log);

type AppsCheckRun = { id: number; head_branch: string; event: string; head_repository: { full_name: string }; html_url: string; created_at: string; conclusion: string };

/**
 * A completed run of the apps-check caller, newest first: each App's job printed the line
 * apps-check writes for doctor, with what its installation holds (#417).
 */
const appsCheckRun = (
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
type Result = { status: number; out: string; err: string; json: any };

const run = async (dir: string, github: ReturnType<typeof fakeGitHub>, argv: string[] = []): Promise<Result> => {
  const out: string[] = [];
  const err: string[] = [];
  const status = await doctor(['--dir', dir, ...argv], {
    gh: github.gh,
    env: {},
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    requirements: () => REQ,
    release: () => PINNED,
  });
  const text = out.join('\n');
  return { status, out: text, err: err.join('\n'), json: argv.includes('--json') ? JSON.parse(text) : null };
};

const ids = (r: Result) => r.json.findings.map((f: { id: string; subject: string }) => `${f.id} ${f.subject}`);

/** The release after PINNED: one App permission more, and one declaration more for the review lane. */
const nextRelease = () => {
  const next = clone(REQ);
  const judgeLike = REQ.lanes['agent-review']!.identities[0]!;
  const target = next.identities.apps[judgeLike] ?? next.identities.roles[judgeLike]!;
  target.permissions.deployments = 'read';
  next.lanes['agent-review']!.reads = [...next.lanes['agent-review']!.reads, 'docs/qa/capability-ledger.md'].sort();
  return { next, slug: `widgets-${judgeLike}` };
};

describe('kanon doctor on a healthy installation', () => {
  it('finds nothing, lists the code-audit caller as Kanon\'s accepted holder, and exits 0', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.findings).toEqual([]);
    expect(r.json.waived).toEqual([]);
    expect(r.json.status).toBe('healthy');
    expect(r.json.releases).toEqual({ pins: [PINNED], pinned: PINNED, to: null, checked: PINNED });
    expect(r.json.lanes).toEqual([...LANES].sort());
    expect(r.json.idTokenHolders).toEqual([
      { workflow: '.github/workflows/agent-code-audit.yml', job: 'audit', grant: 'workflow', how: 'id-token', calls: `yedeya-labs/kanon/.github/workflows/agent-code-audit.yml@${PINNED}`, status: 'kanon-lane', reason: null },
    ]);
  });

  it('only ever reads: every gh call is a GET or a listing, and the checkout is untouched', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    const { next } = nextRelease();
    github.st.releases[NEXT] = next;
    await run(dir, github, ['--to', NEXT]);
    await run(dir, github, ['--json']);
    expect(github.calls.length).toBeGreaterThan(5);
    for (const c of github.calls) {
      expect(c[0] === 'api' ? !c.includes('-X') && !c.includes('--method') && !c.includes('-f') && !c.includes('-F') : (c[0] === 'secret' || c[0] === 'variable') && c[1] === 'list', c.join(' ')).toBe(true);
    }
    // The one body it sends is the default branch's workflows (#418): a GraphQL query, never a mutation.
    expect(github.inputs.length).toBeGreaterThan(0);
    for (const i of github.inputs) expect((JSON.parse(i) as { query: string }).query).toMatch(/^query\(/);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('prints prose by default, with the same exit code', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub());
    expect(r.status).toBe(0);
    expect(r.out).toContain(`== ${REPO}: Kanon ${PINNED} pinned ==`);
    expect(r.out).toContain("Kanon's store-coupled lane at the pinned release: accepted");
    expect(r.out).toContain('Healthy. doctor wrote nothing.');
    expect(() => JSON.parse(r.out)).toThrow();
  });
});

describe('kanon doctor --to, before the pin moves (plan 0005 L10)', () => {
  it('lists exactly the App permission and the declaration the next release adds, and exits 1; after both are fixed, 0', async () => {
    const dir = checkout(healthyFiles());
    const { next, slug } = nextRelease();
    const github = fakeGitHub({ releases: { [NEXT]: next } });
    const before = await run(dir, github, ['--to', NEXT, '--json']);
    expect(before.status, before.out).toBe(EXIT.findings);
    expect(ids(before)).toEqual([`app.permission-missing ${slug}`, 'declaration.missing docs/qa/capability-ledger.md']);
    expect(before.json.findings[0].message).toContain('deployments: read');
    expect(before.json.findings[0].fix.url).toBe(`https://github.com/settings/apps/${slug}/permissions`);
    expect(before.json.releases).toMatchObject({ pinned: PINNED, to: NEXT, checked: NEXT });

    github.st.apps[slug]!.permissions.deployments = 'read';
    put(dir, { 'docs/qa/capability-ledger.md': '# Capability ledger\n' });
    const after = await run(dir, github, ['--to', NEXT, '--json']);
    expect(after.json.findings).toEqual([]);
    expect(after.status, after.out).toBe(EXIT.healthy);
  });

  it('misses the permission when the requirements file drops it (the minting-step test below is what catches that)', async () => {
    const dir = checkout(healthyFiles());
    const { next } = nextRelease();
    const dropped = clone(next);
    const id = REQ.lanes['agent-review']!.identities[0]!;
    delete (dropped.identities.apps[id] ?? dropped.identities.roles[id]!).permissions.deployments;
    const r = await run(dir, fakeGitHub({ releases: { [NEXT]: dropped } }), ['--to', NEXT, '--json']);
    expect(ids(r)).toEqual(['declaration.missing docs/qa/capability-ledger.md']);
  });

  it('names what a caller must change for the next release: a secret, a grant and an input', async () => {
    const dir = checkout(healthyFiles());
    const next = clone(REQ);
    const lane = next.lanes['agent-review']!;
    lane.secrets = [...lane.secrets, 'DIGEST_WEBHOOK'].sort();
    lane.grant = { ...lane.grant, checks: 'read' };
    delete lane.inputs.pr_number;
    const r = await run(dir, fakeGitHub({ releases: { [NEXT]: next } }), ['--to', NEXT, '--json']);
    expect(r.status).toBe(1);
    expect(ids(r)).toEqual([
      'secret.missing acme/widgets',
      'caller.secret-missing .github/workflows/agent-review.yml',
      'caller.input-stale .github/workflows/agent-review.yml',
      'caller.grant-missing .github/workflows/agent-review.yml',
    ]);
    const grant = r.json.findings.find((f: { id: string }) => f.id === 'caller.grant-missing');
    expect(grant.fix.commands).toEqual(['  checks: read']);
    expect(r.json.findings[0].fix.commands).toEqual([`gh secret set DIGEST_WEBHOOK -R ${REPO}`]);
    // The lane that takes it, and its caller, which doesn't map it yet (#415).
    expect(r.json.findings[0].message).toBe(`lacks DIGEST_WEBHOOK, which agent-review takes: .github/workflows/agent-review.yml calls a lane that takes it at ${NEXT}.`);
  });

  it('refuses, exit 3, a release that ships no requirements file', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--to', 'v0.1.0', '--json']);
    expect(r.status).toBe(EXIT.error);
    expect(r.json).toEqual({ schema: SCHEMA, kanon: PINNED, status: 'error', exitCode: 3, error: expect.stringContaining('ships no requirements file') });
  });
});

describe('kanon doctor on an error it did not expect (#375)', () => {
  it('prints the error document, exit 3, and the sentence without a stack trace in prose', async () => {
    const dir = checkout(healthyFiles());
    const go = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const status = await doctor(['--dir', dir, ...argv], {
        gh: fakeGitHub().gh,
        git: () => {
          throw new Error('spawnSync git EMFILE');
        },
        env: {},
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        requirements: () => REQ,
        release: () => PINNED,
      });
      return { status, out: out.join('\n'), err: err.join('\n') };
    };
    const json = await go(['--json']);
    expect(json.status).toBe(EXIT.error);
    expect(JSON.parse(json.out)).toEqual({ schema: SCHEMA, kanon: PINNED, status: 'error', exitCode: 3, error: 'stopped on an unexpected error: spawnSync git EMFILE' });
    const prose = await go([]);
    expect(prose.status).toBe(EXIT.error);
    expect(prose.out).toBe('');
    expect(prose.err).toBe('kanon doctor: stopped on an unexpected error: spawnSync git EMFILE');
  });
});

describe('kanon doctor on what an installation lacks', () => {
  it('names a missing register row, App secret and stack section, and a stale role secret', async () => {
    const files = healthyFiles();
    const id = REQ.lanes['agent-review']!.identities[0]!;
    files['docs/qa/agent-identities.md'] = registerText(identitiesOf(LANES).filter((x) => x !== id));
    files['docs/qa/stack.md'] = '# Stack\n';
    const dir = checkout(files);
    const secrets = new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets).filter((n) => n !== appSecrets(id)[1]));
    const staleRole = Object.keys(REQ.identities.roles).find((r) => !identitiesOf(LANES).includes(r))!;
    secrets.add(appSecrets(staleRole)[0]!);
    const r = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(r.status).toBe(1);
    expect(ids(r)).toEqual(['register.missing-row docs/qa/agent-identities.md', 'secret.missing acme/widgets', 'secret.stale acme/widgets', 'declaration.section-missing docs/qa/stack.md']);
    expect(r.json.findings[1].fix.commands[0]).toMatch(/^kanon apps --owner acme --repo widgets /);
    expect(r.json.findings[2]).toMatchObject({ blocking: false, fix: { commands: [`gh secret delete ${appSecrets(staleRole)[0]} -R ${REPO}`] } });
  });

  it('warns, without blocking, about an App that holds more than the release grants (the Owner, 2026-10-06)', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    const id = REQ.lanes['agent-code-audit']!.identities[0]!;
    github.st.apps[`widgets-${id}`]!.permissions.administration = 'write';
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([`app.permission-extra widgets-${id}`]);
    expect(r.json.findings[0]).toMatchObject({ blocking: false, fix: { text: expect.stringContaining('Narrow') } });
    expect(r.json.findings[0].message).toContain('blocks nothing');
    expect(r.status).toBe(EXIT.healthy);
  });

  it('names a missing hook input, a missing ruleset rule and missing labels (the labels not blocking)', async () => {
    const files = healthyFiles();
    files[REQ.hook.path] = hookFile(REQ.hook.inputs.slice(1));
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.rulesets = [{ ...github.st.rulesets[0]!, rules: github.st.rulesets[0]!.rules.filter((x) => x.type !== 'deletion') }];
    github.st.labels.delete('qa:needs-split');
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([`hook.input-missing ${REQ.hook.path}`, 'label.missing acme/widgets', 'ruleset.rule-missing main']);
    expect(r.json.findings[1]).toMatchObject({ blocking: false });
    expect(r.json.findings[1].fix.commands).toEqual([expect.stringMatching(/^gh label create "qa:needs-split" --color [0-9a-f]{6} --description /)]);
  });

  it('names a caller that inherits secrets, and an apps-check caller that maps a secret its release does not take', async () => {
    const files = healthyFiles();
    files['.github/workflows/agent-review.yml'] = files['.github/workflows/agent-review.yml']!.replace(/ {4}secrets:\n( {6}.*\n)+/, '    secrets: inherit\n');
    files['.github/workflows/apps-check.yml'] += '      NOBODY_APP_ID: ${{ secrets.NOBODY_APP_ID }}\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['caller.secrets-inherited .github/workflows/agent-review.yml', 'apps-check.secret-stale .github/workflows/apps-check.yml']);
  });

  it('names a caller granting write-all as what it is, with the lane\'s grant written out as the fix', async () => {
    const files = healthyFiles();
    files['.github/workflows/agent-review.yml'] = files['.github/workflows/agent-review.yml']!.replace(/^permissions:\n( {2}.*\n)+/m, 'permissions: write-all\n');
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    // write-all also hands the review lane, which is not store-coupled, id-token: write.
    expect(ids(r)).toEqual(['caller.grant-missing .github/workflows/agent-review.yml', 'id-token.unaccepted .github/workflows/agent-review.yml#review']);
    expect(r.json.findings[0].message).toContain('grants `permissions: write-all` rather than a map');
    expect(r.json.findings[0].fix.commands).toEqual(['permissions:', ...Object.entries(REQ.lanes['agent-review']!.grant).map(([k, v]) => `  ${k}: ${v}`)]);
  });

  it('names, in the apps-check finding, each App whose secrets the caller does not map', async () => {
    const files = healthyFiles();
    files['.github/workflows/apps-check.yml'] = files['.github/workflows/apps-check.yml']!.split('\n').filter((l) => !/_APP_PRIVATE_KEY:/.test(l)).join('\n');
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['apps-check.secret-missing .github/workflows/apps-check.yml']);
    const both = identitiesOf(LANES);
    expect(both).toHaveLength(2);
    expect(r.json.findings[0].message).toContain(`can't check the ${both.join(' and ')} Apps.`);
  });

  it('says which release first ships a requirements file', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--to', 'v0.27.0', '--json']);
    expect(r.json.error).toContain('from v0.28.0 on');
  });

  it('names pins that disagree', async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = files['.github/workflows/ci.yml']!.replace(`@${PINNED}`, '@v0.9.0');
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['pin.mixed .github']);
    expect(r.json.releases.pins).toEqual(['v0.9.0', PINNED]);
    expect(r.json.releases.pinned).toBe(PINNED);
  });

  it('says it is incomplete, exit 4, when the token cannot list the secrets', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub({ secrets: null }), ['--json']);
    expect(r.status).toBe(EXIT.incomplete);
    expect(r.json.status).toBe('incomplete');
    expect(r.json.unchecked).toEqual([{ check: 'secrets', subject: REPO, reason: expect.stringContaining('secret names') }]);
  });

  it('refuses, exit 3, where nothing pins Kanon, and outside a checkout', async () => {
    const dir = checkout({ 'README.md': 'hello\n' });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status).toBe(EXIT.error);
    expect(r.json.error).toContain('pins Kanon');
    const bare = mkdtempSync(join(tmpdir(), 'kanon-doctor-bare-'));
    scratch.push(bare);
    const out = await run(bare, fakeGitHub());
    expect(out.status).toBe(EXIT.error);
    expect(out.err).toContain('is not a git checkout');
  });

  it('refuses a bad argument with exit 2, as JSON when --json was asked for', async () => {
    const dir = checkout(healthyFiles());
    const r = await run(dir, fakeGitHub(), ['--to', 'latest', '--json']);
    expect(r.status).toBe(EXIT.usage);
    expect(r.json).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: expect.stringContaining('vX.Y.Z') });
  });

  it('prints the error document for --help with --json, not the usage text (#457)', async () => {
    const dir = checkout(healthyFiles());
    for (const h of ['--help', '-h']) {
      const r = await run(dir, fakeGitHub(), [h, '--json']);
      expect(r.status, h).toBe(EXIT.usage);
      expect(r.json, h).toMatchObject({ schema: SCHEMA, status: 'error', exitCode: 2, error: '--help and --json contradict each other; give one' });
    }
    // Without --json, --help prints the usage on standard output, as before.
    const help = await run(dir, fakeGitHub(), ['--help']);
    expect(help.status).toBe(EXIT.healthy);
    expect(help.out).toContain('Usage: kanon doctor');
  });

  it('never takes the next flag as a value flag\'s value, and prints the error document under --json (#457)', async () => {
    // `kanon doctor --dir --json`, as an unset, unquoted variable leaves it.
    for (const f of ['--dir', '--repo', '--to']) {
      const out: string[] = [];
      const err: string[] = [];
      const status = await doctor([f, '--json'], { gh: fakeGitHub().gh, env: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l), requirements: () => REQ, release: () => PINNED });
      expect(status, f).toBe(EXIT.usage);
      expect(JSON.parse(out.join('\n')), f).toMatchObject({
        schema: SCHEMA,
        status: 'error',
        exitCode: 2,
        error: `${f} needs a value, not the flag "--json"; to give a value that begins with "-", write ${f}=<value>`,
      });
      expect(err, f).toEqual([]);
    }
    expect(() => parseArgs(['--dir', '-h'])).toThrow('--dir needs a value, not the flag "-h"');
    // A value that begins with "-" is given inline.
    expect(parseArgs(['--dir=-x', '--json'])).toMatchObject({ dir: '-x', json: true });
  });
});

describe('kanon doctor on the id-token holders (plan 0005 §5.5)', () => {
  const deploy = (perms: string, jobPerms = '') => `name: Deploy
on:
  push:
    branches: [main]
${perms}
jobs:
  deploy:
    runs-on: ubuntu-latest
${jobPerms}    steps:
      - run: ./deploy.sh
  lint:
    runs-on: ubuntu-latest
    permissions:
      id-token: none
      contents: read
    steps:
      - run: make lint
`;
  const accept = (job = 'deploy') => `\n- **${HOLDER_LABEL}:** \`deploy.yml\` job \`${job}\` (assumes the deploy role in our cloud account)\n`;
  const holders = (r: Result) => r.json.idTokenHolders.filter((h: { status: string }) => h.status !== 'kanon-lane').map((h: { job: string; grant: string; how: string; status: string; calls: string | null }) => `${h.job} ${h.grant} ${h.how} ${h.status}${h.calls ? ` ${h.calls}` : ''}`);

  const cases: Array<[string, string]> = [
    ['its own grant', deploy('permissions:\n  contents: read', '    permissions:\n      id-token: write\n      contents: read\n')],
    ["the workflow's grant, inherited", deploy('permissions:\n  id-token: write\n  contents: read')],
    ['permissions: write-all on the job', deploy('permissions: {}', '    permissions: write-all\n')],
    ['permissions: write-all on the workflow', deploy('permissions: write-all')],
  ];
  for (const [how, text] of cases) {
    it(`names a job holding it through ${how}, until the record accepts it or the grant goes`, async () => {
      const files = healthyFiles();
      files['.github/workflows/deploy.yml'] = text;
      const dir = checkout(files);
      const github = fakeGitHub();
      const named = await run(dir, github, ['--json']);
      expect(named.status).toBe(EXIT.findings);
      expect(holders(named)).toHaveLength(1);
      expect(holders(named)[0]).toMatch(/^deploy (job|workflow) (id-token|write-all) unaccepted$/);
      expect(ids(named)).toEqual(['id-token.unaccepted .github/workflows/deploy.yml#deploy']);
      expect(named.json.findings[0].fix.commands).toEqual([`- **${HOLDER_LABEL}:** \`deploy.yml\` job \`deploy\` (<why it holds the grant>)`]);

      put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md'] + accept() });
      const accepted = await run(dir, github, ['--json']);
      expect(accepted.status, accepted.out).toBe(EXIT.healthy);
      expect(accepted.json.idTokenHolders.find((h: { job: string }) => h.job === 'deploy')).toMatchObject({ status: 'accepted', reason: 'assumes the deploy role in our cloud account' });

      put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md']!, '.github/workflows/deploy.yml': deploy('permissions:\n  contents: read') });
      const narrowed = await run(dir, github, ['--json']);
      expect(narrowed.status, narrowed.out).toBe(EXIT.healthy);
      expect(holders(narrowed)).toEqual([]);
    });
  }

  it('names a job that passes the grant to a reusable workflow of its own', async () => {
    const files = healthyFiles();
    files['.github/workflows/release-train.yml'] = 'name: Train\non: push\npermissions:\n  contents: read\njobs:\n  ship:\n    permissions:\n      id-token: write\n    uses: ./.github/workflows/reusable-deploy.yml\n';
    files['.github/workflows/reusable-deploy.yml'] = 'on:\n  workflow_call:\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./go.sh\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(holders(r)).toEqual(['ship job id-token unaccepted ./.github/workflows/reusable-deploy.yml']);
    expect(r.status).toBe(EXIT.findings);
  });

  it('lists a job with id-token: none nowhere, and names a stale or malformed acceptance', async () => {
    const files = healthyFiles();
    files['.github/workflows/deploy.yml'] = deploy('permissions:\n  contents: read');
    files['docs/qa/adoption.md'] += accept('lint') + '- **Accepted id-token holder:** deploy.yml deploy\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(holders(r)).toEqual([]);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md', 'id-token.stale-acceptance docs/qa/adoption.md']);
    expect(r.json.findings[1].blocking).toBe(false);
  });

  it("blocks on a malformed `Upstream findings:` choice, and passes a well-formed one (K-LAYOUT-10, kanon#423)", async () => {
    const good = healthyFiles();
    good['docs/qa/adoption.md'] += '- **Upstream findings:** `filed here`\n';
    expect(ids(await run(checkout(good), fakeGitHub(), ['--json']))).toEqual([]);
    const bad = healthyFiles();
    bad['docs/qa/adoption.md'] += '- **Upstream findings:** `filed on another repository`\n';
    const r = await run(checkout(bad), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md']);
    expect(r.json.findings[0].message).toMatch(/`Upstream findings` is `filed on another repository`; write `drafted` or `filed here`/);
    expect(r.status).toBe(EXIT.findings);
  });

  it('accepts a caller of a store-coupled Kanon lane only at the pinned release', async () => {
    const files = healthyFiles();
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.json.idTokenHolders.map((h: { status: string }) => h.status)).toEqual(['kanon-lane']);
    const next = clone(REQ);
    delete next.lanes['agent-code-audit']!.grant['id-token'];
    const moved = await run(dir, fakeGitHub({ releases: { [NEXT]: next } }), ['--to', NEXT, '--json']);
    expect(moved.json.idTokenHolders.map((h: { status: string }) => h.status)).toEqual(['unaccepted']);
  });
});

// #418, L5's G14: doctor told the Owner to require "Lane check" while the lane check ran as a step
// of another job, and before the pull request adding its job had merged, so every other open
// pull request waited, approved and green, on a check its branch could never produce.
describe('kanon doctor and the job behind a required check (#418)', () => {
  /** Kanon's own shape before #394: the lane check as a step of another job. */
  const asStep = `name: CI\non:\n  pull_request:\njobs:\n  test:\n    name: Lint, type-check and unit tests\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n      - uses: yedeya-labs/kanon/actions/lane-check@${PINNED}\n`;
  const withoutCheck = (github: ReturnType<typeof fakeGitHub>) => {
    github.st.rulesets = [{ ...github.st.rulesets[0]!, rules: github.st.rulesets[0]!.rules.filter((x) => x.type !== 'required_status_checks') }];
  };

  it('asks for the rule once a job on the default branch reports the check', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.rule-missing main']);
    expect(r.json.findings[0].message).toContain('require the status check "Lane check"');
  });

  it("doesn't offer the rule for a check whose job is only on this checkout's branch: the job's pull request merges first", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = {};
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.status).toBe(EXIT.findings);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'ruleset', blocking: true, subject: 'Lane check', fix: { url: `https://github.com/yedeya-labs/kanon/blob/${PINNED}/actions/lane-check/README.md` } });
    expect(f.message).toContain('so the ruleset can\'t require it yet');
    expect(f.fix.text).toContain('This checkout adds it (.github/workflows/ci.yml#lanes): merge the pull request that adds it to main first.');
    expect(f.fix.text).toContain('once the job is on main');
  });

  it('asks for a job of its own when the lane check runs as a step of another job, on the branch and the default branch alike', async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = asStep;
    const dir = checkout(files);
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = { 'ci.yml': asStep };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].fix.text).toMatch(/^Add a job of its own named "Lane check", in a workflow that runs on pull_request/);
  });

  it('names a ruleset that already requires a check no job on the default branch reports', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    github.st.defaultWorkflows = { 'ci.yml': asStep };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].message).toContain('requires the status check "Lane check", but no job of a workflow on main reports it');
    expect(r.json.findings[0].fix.text).toContain('Until it merges, every other pull request waits on the check.');
  });

  it("can't tell without the default branch's workflows: lists the check as unchecked, and doesn't ask for the rule", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = null;
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.status).toBe(EXIT.incomplete);
    expect(r.json.unchecked).toEqual([{ check: 'required-check', subject: 'Lane check', reason: expect.stringContaining("doesn't ask you to require it yet") }]);
  });

  // #446: a job whose workflow filters pull_request runs on some pull requests only, and GitHub
  // never reports its check on the others, which then wait on the required check.
  const filtered = (filter: string) => ciFile(PINNED, 'main').replace('  pull_request:\n', `  pull_request:\n${filter}`);

  it("doesn't ask for the rule while the only job that reports the check skips some pull requests, and names the filter", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = { 'ci.yml': filtered("    paths: ['src/**']\n") };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    const f = r.json.findings[0];
    expect(f.message).toContain("so the ruleset can't require it yet");
    expect(f.message).toContain('The only job there that reports it (.github/workflows/ci.yml#lanes) runs on some pull requests only (pull_request.paths), and a pull request it skips never gets the check.');
    // This checkout's ci.yml has no filter, so its pull request merges first.
    expect(f.fix.text).toContain('This checkout adds it (.github/workflows/ci.yml#lanes)');
  });

  it('tells a ruleset that already requires the check to run its job on every pull request when the checkout filters it too', async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = filtered('    types: [labeled]\n');
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.defaultWorkflows = { 'ci.yml': filtered('    types: [labeled]\n') };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].message).toContain('requires the status check "Lane check", but no job of a workflow on main reports it on every pull request');
    expect(r.json.findings[0].fix.text).toMatch(/^Run the job on every pull request: take pull_request\.types off the workflow's trigger/);
  });

  it('counts a job whose filters skip no pull request into the default branch', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    withoutCheck(github);
    github.st.defaultWorkflows = { 'ci.yml': filtered("    branches: [main]\n    types: [opened, synchronize, reopened, labeled]\n") };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.rule-missing main']);
  });

  it('is waived like any other finding, on the check it names', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += `- **${WAIVER_LABEL}:** \`ruleset.check-unreported\` on \`Lane check\` (another CI reports it)\n`;
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.defaultWorkflows = {};
    const r = await run(dir, github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(r.json.waived.map((w: { id: string; reason: string }) => [w.id, w.reason])).toEqual([['ruleset.check-unreported', 'another CI reports it']]);
  });
});

describe("branchWorkflows: the default branch's workflows, read from GitHub (#418)", () => {
  const read = (reply: Gh) => branchWorkflows({ gh: async () => reply } as unknown as Parameters<typeof branchWorkflows>[0], REPO, 'main');
  const lane = 'on: pull_request\njobs:\n  lanes:\n    name: Lane check\n    runs-on: x\n';

  it('reads each workflow file, and only files', async () => {
    const r = await read(ok({ data: { repository: { object: { entries: [
      { name: 'ci.yml', type: 'blob', object: { text: lane } },
      { name: 'nested.yml', type: 'tree', object: { text: lane } },
      { name: 'notes.md', type: 'blob', object: { text: lane } },
      { name: 'broken.yml', type: 'blob', object: { text: 'a: &x 1\n' } },
      { name: 'big.yml', type: 'blob', object: { text: null } },
    ] } } } }));
    expect(r.error).toBeNull();
    expect([...r.workflows!.keys()]).toEqual(['.github/workflows/ci.yml']);
  });

  it('has none on a branch without the directory, and says why when GitHub refuses or errs', async () => {
    expect([...(await read(ok({ data: { repository: { object: null } } }))).workflows!.keys()]).toEqual([]);
    expect((await read(no('HTTP 403'))).error).toBe('HTTP 403');
    expect((await read(ok({ errors: [{ message: 'Could not resolve to a Repository' }] }))).error).toBe('Could not resolve to a Repository');
    expect((await read(ok({ data: { repository: null } }))).error).toBe('GitHub returned no repository');
    expect((await read(ok('not json'))).error).toBe("GitHub's answer was not JSON");
  });
});

describe('checkReporters: which jobs report a status check on a pull request (#418)', () => {
  const wf = (on: unknown, jobs: Record<string, unknown>) => ({ on, jobs });
  const job = { name: 'Lane check', 'runs-on': 'ubuntu-latest', steps: [] };
  const one = (w: Record<string, unknown>) => checkReporters(new Map([['.github/workflows/x.yml', w]]), 'Lane check');

  it("counts a job named exactly the check, in a workflow on pull_request, however `on` is written", () => {
    expect(one(wf({ pull_request: null }, { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    expect(one(wf('pull_request', { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    expect(one(wf(['push', 'pull_request'], { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    expect(one(wf({ pull_request_target: null }, { lanes: job }))).toEqual(['.github/workflows/x.yml#lanes']);
    // A job with no name reports its key.
    expect(checkReporters(new Map([['w.yml', wf('pull_request', { lanes: { 'runs-on': 'x' } })]]), 'lanes')).toEqual(['w.yml#lanes']);
  });

  it('counts no job that reports under another name, or not on a pull request', () => {
    expect(one(wf({ push: null, merge_group: null }, { lanes: job }))).toEqual([]);
    expect(one(wf('push', { lanes: job }))).toEqual([]);
    expect(one(wf(['push'], { lanes: job }))).toEqual([]);
    expect(one(wf({ pull_request: null }, { lanes: { ...job, name: 'Lane checks' } }))).toEqual([]);
    expect(one(wf({ pull_request: null }, { 'lane-check': { 'runs-on': 'x' } }))).toEqual([]);
    // A reusable workflow's call reports "<name> / <its job>", a matrix job "<name> (<values>)".
    expect(one(wf({ pull_request: null }, { lanes: { name: 'Lane check', uses: './.github/workflows/l.yml' } }))).toEqual([]);
    expect(one(wf({ pull_request: null }, { lanes: { ...job, strategy: { matrix: { os: ['a', 'b'] } } } }))).toEqual([]);
    // A strategy without a matrix keeps the name.
    expect(one(wf({ pull_request: null }, { lanes: { ...job, strategy: { 'fail-fast': false } } }))).toEqual(['.github/workflows/x.yml#lanes']);
  });
});

describe('checkJobs: the filters that skip some pull requests (#446)', () => {
  const job = { name: 'Lane check', 'runs-on': 'ubuntu-latest', steps: [] };
  const filtersOf = (on: unknown, branch = 'main') => checkJobs(new Map([['x.yml', { on, jobs: { lanes: job } }]]), 'Lane check', branch).map((j) => j.filters);
  const reports = (on: unknown, branch = 'main') => checkReporters(new Map([['x.yml', { on, jobs: { lanes: job } }]]), 'Lane check', branch);

  it('names each filter that skips a pull request, by its event', () => {
    expect(filtersOf({ pull_request: { paths: ['src/**'] } })).toEqual([['pull_request.paths']]);
    expect(filtersOf({ pull_request: { 'paths-ignore': ['docs/**'] } })).toEqual([['pull_request.paths-ignore']]);
    expect(filtersOf({ pull_request: { branches: ['release/**'] } })).toEqual([['pull_request.branches']]);
    expect(filtersOf({ pull_request: { 'branches-ignore': ['ma*'] } })).toEqual([['pull_request.branches-ignore']]);
    expect(filtersOf({ pull_request_target: { types: ['labeled'] } })).toEqual([['pull_request_target.types']]);
    expect(filtersOf({ pull_request: { types: 'opened' } })).toEqual([['pull_request.types']]);
    expect(filtersOf({ pull_request: { paths: ['a'], types: ['opened', 'synchronize'] } })).toEqual([['pull_request.paths', 'pull_request.types']]);
    expect(reports({ pull_request: { paths: ['src/**'] } })).toEqual([]);
  });

  it('counts a trigger whose filters skip no pull request into the branch', () => {
    expect(reports({ pull_request: null })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { types: ['opened', 'reopened', 'synchronize', 'labeled'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { types: null } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['main'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: 'main' } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['ma*'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { 'branches-ignore': ['release/**'] } })).toEqual(['x.yml#lanes']);
    // One unfiltered trigger is enough: the workflow runs on every pull request through it.
    expect(reports({ pull_request: { paths: ['a'] }, pull_request_target: null })).toEqual(['x.yml#lanes']);
    expect(filtersOf({ pull_request: { paths: ['a'] }, pull_request_target: { types: ['closed'] } })).toEqual([['pull_request.paths', 'pull_request_target.types']]);
  });

  it('reads a branches list as GitHub does: the last pattern it matches decides, and a ! one excludes', () => {
    expect(reports({ pull_request: { branches: ['**', '!main'] } })).toEqual([]);
    expect(reports({ pull_request: { branches: ['!main', '**'] } })).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['release/*'] } }, 'release/1')).toEqual(['x.yml#lanes']);
    expect(reports({ pull_request: { branches: ['release/*'] } }, 'release/1/x')).toEqual([]);
    expect(reports({ pull_request: { branches: ['release/**'] } }, 'release/1/x')).toEqual(['x.yml#lanes']);
    // Without the branch, any branch filter counts as one that skips.
    const anyBranch = (on: unknown) => checkReporters(new Map([['x.yml', { on, jobs: { lanes: job } }]]), 'Lane check');
    expect(anyBranch({ pull_request: { branches: ['main'] } })).toEqual([]);
    expect(anyBranch({ pull_request: { 'branches-ignore': ['x'] } })).toEqual([]);
    expect(anyBranch({ pull_request: null })).toEqual(['x.yml#lanes']);
  });
});

describe("branchPattern: a branch filter's pattern, as GitHub matches it (#446)", () => {
  const m = (p: string, b: string) => branchPattern(p).test(b);
  it('matches *, **, ?, +, a class and an escape', () => {
    expect([m('main', 'main'), m('main', 'mainx'), m('mai', 'main')]).toEqual([true, false, false]);
    expect([m('feat/*', 'feat/a'), m('feat/*', 'feat/a/b'), m('feat/**', 'feat/a/b'), m('*', 'a/b')]).toEqual([true, false, true, false]);
    expect([m('mains?', 'main'), m('mains?', 'mains'), m('ma+in', 'maaain'), m('ma+in', 'min')]).toEqual([true, true, true, false]);
    expect([m('v[0-9].x', 'v1.x'), m('v[0-9].x', 'va.x'), m('v1.x', 'v1yx')]).toEqual([true, false, false]);
    expect([m('a\\*b', 'a*b'), m('a\\*b', 'axb'), m('[ab', '[ab'), m('[z-a]', 'z')]).toEqual([true, false, true, false]);
  });
});

// #390: any repository waives a finding it has decided to keep, one bullet per finding id and
// subject under `## Choices`, with its reason. Doctor knows no repository's special case: the
// fixtures below are Kanon's (callers that can't take their lane's name, because the lane's own
// definition holds it) and an ordinary adopter's, and the same rules apply to both.
describe('kanon doctor and the waivers under ## Choices (#390)', () => {
  const waive = (id: string, subject: string, reason = 'the lane itself holds that name') => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` (${reason})\n`;
  const record = (bullets: string) => healthyFiles()['docs/qa/adoption.md']! + bullets;
  const waiveFor = (id: string, subject: string, items: string[], reason: string) => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` for ${items.map((x) => `\`${x}\``).join(', ')} (${reason})\n`;
  const definition = 'name: Lane\non:\n  workflow_call:\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./lane.sh\n';
  /** Kanon's shape: each lane's definition at the lane's file name, and its caller beside it under another. */
  const laneHost = () => {
    const files = healthyFiles();
    for (const lane of LANES) {
      const short = lane.slice('agent-'.length);
      files[`.github/workflows/${short}.yml`] = files[`.github/workflows/${lane}.yml`]!;
      files[`.github/workflows/${lane}.yml`] = definition;
    }
    return files;
  };
  const misplaced = ['caller.misplaced .github/workflows/code-audit.yml', 'caller.misplaced .github/workflows/review.yml'];

  it('turns each waived caller.misplaced into a waived finding, and the run healthy', async () => {
    const files = laneHost();
    const dir = checkout(files);
    const github = fakeGitHub();
    const before = await run(dir, github, ['--json']);
    expect(before.status, before.out).toBe(EXIT.findings);
    expect(ids(before).sort()).toEqual(misplaced);
    expect(before.json.waived).toEqual([]);

    put(dir, { 'docs/qa/adoption.md': record(waive('caller.misplaced', '.github/workflows/review.yml') + waive('caller.misplaced', '.github/workflows/code-audit.yml', "agent-code-audit.yml is the lane's definition")) });
    const after = await run(dir, github, ['--json']);
    expect(after.status, after.out).toBe(EXIT.healthy);
    expect(after.json.findings).toEqual([]);
    const byFile = Object.fromEntries(after.json.waived.map((w: { subject: string; reason: string }) => [w.subject, w.reason]));
    expect(byFile).toEqual({ '.github/workflows/review.yml': 'the lane itself holds that name', '.github/workflows/code-audit.yml': "agent-code-audit.yml is the lane's definition" });
    // The waived finding is the finding, whole: what it was, and the fix it would have had.
    const review = before.json.findings.find((f: { subject: string }) => f.subject === '.github/workflows/review.yml');
    expect(after.json.waived.find((w: { subject: string }) => w.subject === review.subject)).toEqual({ ...review, items: [], line: 12, reason: 'the lane itself holds that name' });

    const prose = await run(dir, github);
    expect(prose.status).toBe(EXIT.healthy);
    expect(prose.out).toContain("Waived under ## Choices in docs/qa/adoption.md, so they don't count:");
    expect(prose.out).toContain('- [Caller] caller.misplaced, .github/workflows/review.yml, by docs/qa/adoption.md:12: the lane itself holds that name.');
    expect(prose.out).toContain('Healthy. doctor wrote nothing. 2 finding(s) waived in docs/qa/adoption.md.');
  });

  it('waives only the finding id and the subject it names (mutations: another path, another id)', async () => {
    const dir = checkout({ ...laneHost(), 'docs/qa/adoption.md': record(waive('caller.misplaced', '.github/workflows/implement.yml') + waive('caller.name', '.github/workflows/review.yml') + waive('caller.misplaced', '.github/workflows/code-audit.yml')) });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.findings);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md', 'waiver.stale docs/qa/adoption.md', 'caller.misplaced .github/workflows/review.yml']);
    expect(r.json.waived.map((w: { id: string; subject: string }) => `${w.id} ${w.subject}`)).toEqual(['caller.misplaced .github/workflows/code-audit.yml']);
    expect(r.json.findings[0].message).toContain('waives caller.misplaced on .github/workflows/implement.yml, but doctor reports no such finding');
    expect(r.json.findings[1].message).toContain('waives caller.name on .github/workflows/review.yml');
  });

  it('names a stale waiver, without blocking, once the finding is gone', async () => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waive('caller.misplaced', '.github/workflows/review.yml')) });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(r.json.findings[0]).toMatchObject({ blocking: false, fix: { text: 'Remove the bullet, so the record says only what is true.' } });
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.waived).toEqual([]);
  });

  it("doesn't call a waiver stale when the check that would report its finding could not run", async () => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, ['DIGEST_WEBHOOK'], 'set in the organisation')) });
    const blind = await run(dir, fakeGitHub({ secrets: null }), ['--json']);
    expect(blind.status).toBe(EXIT.incomplete);
    expect(ids(blind)).toEqual([]);
    expect(blind.json.notes.join('\n')).toContain(`waives secret.missing on ${REPO} for DIGEST_WEBHOOK, which doctor did not report; the secrets check could not run`);
    const seeing = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(seeing)).toEqual(['waiver.stale docs/qa/adoption.md']);
  });

  it('waives a finding that does not block too, and every finding of that id on that subject whose items it names', async () => {
    const github = fakeGitHub({ secrets: new Set() });
    github.st.labels = new Set();
    const labels = TAXONOMY;
    const secrets = [...new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets))];
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('label.missing', REPO, labels, 'we keep our own labels') + waiveFor('secret.missing', REPO, secrets, 'set in the organisation')) });
    const r = await run(dir, github, ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
    const waived = r.json.waived.map((w: { id: string; blocking: boolean }) => `${w.id} ${w.blocking}`);
    expect(waived.filter((w: string) => w === 'secret.missing true').length).toBeGreaterThan(1);
    expect(waived).toContain('label.missing false');
  });

  it('fails a malformed waiver by its line, and one of a finding that cannot be waived, so neither is ignored', async () => {
    const bad = [
      `- **${WAIVER_LABEL}:** caller.misplaced on .github/workflows/review.yml\n`,
      waive('caller.misplaced', '.github/workflows/review.yml', ' '),
      waive('caller.misplced', '.github/workflows/review.yml'),
      waive('caller.secrets-inherited', '.github/workflows/review.yml'),
      waive('caller.misplaced', '.github/workflows/review.yml') + waive('caller.misplaced', '.github/workflows/review.yml', 'again'),
    ];
    for (const b of bad) {
      const dir = checkout({ ...laneHost(), 'docs/qa/adoption.md': record(b) });
      const r = await run(dir, fakeGitHub(), ['--json']);
      expect(r.status, b).toBe(EXIT.findings);
      expect(r.json.findings.filter((f: { id: string }) => f.id === 'declaration.malformed'), b).toHaveLength(1);
      expect(r.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed').message, b).toMatch(/^docs\/qa\/adoption\.md:\d+ /);
    }
    const outside = checkout({ ...laneHost(), 'docs/qa/adoption.md': record('') .replace('## People\n', `## People\n\n${waive('caller.misplaced', '.github/workflows/review.yml')}`) });
    const r = await run(outside, fakeGitHub(), ['--json']);
    expect(ids(r).sort()).toEqual([...misplaced, 'declaration.malformed docs/qa/adoption.md']);
  });

  it('keeps the id-token holder its own form: a general waiver of one is malformed, and the holder stays unaccepted', async () => {
    const files = healthyFiles();
    files['.github/workflows/deploy.yml'] = 'on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: x\n';
    const dir = checkout({ ...files, 'docs/qa/adoption.md': record(waive('id-token.unaccepted', '.github/workflows/deploy.yml#d')) });
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md', 'id-token.unaccepted .github/workflows/deploy.yml#d']);
    expect(r.json.findings[0].message).toContain(HOLDER_LABEL);
    expect(r.json.waived).toEqual([]);
  });

  it("leaves an ordinary adopter's findings exactly as they were", async () => {
    const files = healthyFiles();
    files['docs/qa/stack.md'] = '# Stack\n';
    const dir = checkout(files);
    const github = fakeGitHub();
    github.st.labels = new Set();
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['declaration.section-missing docs/qa/stack.md', `label.missing ${REPO}`]);
    expect(r.json.waived).toEqual([]);
    expect(r.status).toBe(EXIT.findings);
  });
});

// #406: a finding that lists items, which a later release can add to, is waived item by item.
// A bullet names the items it keeps after `for`; any other item, today's or the next release's,
// stays a finding. A bullet that names none still waives the whole finding, as before, and a
// note names what it waives and the bullet to write instead.
describe('kanon doctor and the waiver of a finding that lists items (#406)', () => {
  const judge = REQ.lanes['agent-review']!.identities[0]!;
  const slug = `widgets-${judge}`;
  const record = (bullet: string) => `${healthyFiles()['docs/qa/adoption.md']}${bullet}\n`;
  const waiveFor = (id: string, subject: string, items: string[] | null, reason = 'kept on purpose') =>
    `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\`${items ? ` for ${items.map((x) => `\`${x}\``).join(', ')}` : ''} (${reason})`;
  /** The Judge's App lacks one permission it is granted, which the repository keeps on purpose. */
  const kept = Object.keys(permissionsOf(REQ, judge)).find((k) => k !== 'metadata')!;
  /** The next release asks the Judge's App for one permission more, and nothing else. */
  const next = () => {
    const r = clone(REQ);
    (r.identities.apps[judge] ?? r.identities.roles[judge]!).permissions.deployments = 'read';
    return r;
  };
  const setup = (bullet: string) => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(bullet) });
    const github = fakeGitHub({ releases: { [NEXT]: next() } });
    delete github.st.apps[slug]!.permissions[kept];
    return { dir, github };
  };

  it('waives the items it names, and reports the one the next release adds, written for it alone', async () => {
    const { dir, github } = setup(waiveFor('app.permission-missing', slug, [kept]));
    const now = await run(dir, github, ['--json']);
    expect(now.status, now.out).toBe(EXIT.healthy);
    expect(now.json.waived.map((w: { id: string; items: string[] }) => [w.id, w.items])).toEqual([['app.permission-missing', [kept]]]);

    const later = await run(dir, github, ['--to', NEXT, '--json']);
    expect(later.status).toBe(EXIT.findings);
    expect(ids(later)).toEqual([`app.permission-missing ${slug}`]);
    const f = later.json.findings[0];
    expect(f.message).toBe(`The ${judge} App \`${slug}\` holds deployments: none; Kanon ${NEXT} needs deployments: read. docs/qa/adoption.md:12 waives ${kept}, not this.`);
    expect(later.json.waived).toHaveLength(1);
    expect(later.json.waived[0]).toMatchObject({ items: [kept], line: 12, reason: 'kept on purpose' });
    expect(later.json.waived[0].message).not.toContain('deployments');
    const prose = await run(dir, github, ['--to', NEXT]);
    expect(prose.out).toContain(`- [App] app.permission-missing, ${slug} (${kept}), by docs/qa/adoption.md:12: kept on purpose.`);
  });

  it('refuses a bullet that names no items, waiving nothing, and gives the bullet to write from today\'s items (the Owner, 2026-10-07)', async () => {
    const { dir, github } = setup(waiveFor('app.permission-missing', slug, null));
    const later = await run(dir, github, ['--to', NEXT, '--json']);
    expect(later.status).toBe(EXIT.findings);
    expect(ids(later)).toEqual([`app.permission-missing ${slug}`, 'declaration.malformed docs/qa/adoption.md']);
    expect(later.json.waived).toEqual([]);
    const bad = later.json.findings[1];
    expect(bad.message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} without naming its items, so it would waive whatever a later release adds to that finding too; it waives nothing until it names them (#406). Doctor reports ${kept}, deployments there today.`);
    expect(bad.fix.commands).toEqual([`- **${WAIVER_LABEL}:** \`app.permission-missing\` on \`${slug}\` for \`${kept}\`, \`deployments\` (kept on purpose)`]);
    // Written as the fix says, it waives both, and the run is healthy again.
    put(dir, { 'docs/qa/adoption.md': record(bad.fix.commands[0]) });
    expect((await run(dir, github, ['--to', NEXT, '--json'])).status).toBe(EXIT.healthy);
    // Beside a bullet that names some, the rewrite names only the rest; with none reported, a placeholder.
    put(dir, { 'docs/qa/adoption.md': record(`${waiveFor('app.permission-missing', slug, [kept])}\n${waiveFor('app.permission-missing', slug, null, 'and the rest')}`) });
    const beside = await run(dir, github, ['--to', NEXT, '--json']);
    expect(beside.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed').fix.commands).toEqual([`- **${WAIVER_LABEL}:** \`app.permission-missing\` on \`${slug}\` for \`deployments\` (and the rest)`]);
    const none = await run(dir, github, ['--json']);
    expect(none.json.findings.find((f: { id: string }) => f.id === 'declaration.malformed')).toMatchObject({ message: expect.stringContaining('Doctor reports no item there today that the other bullets don\'t name.'), fix: { commands: [`- **${WAIVER_LABEL}:** \`app.permission-missing\` on \`${slug}\` for \`<item>\` (and the rest)`] } });
    // A finding that lists no items is still waived by a bullet that names none.
    const moved = healthyFiles();
    moved['.github/workflows/review.yml'] = moved['.github/workflows/agent-review.yml']!;
    delete moved['.github/workflows/agent-review.yml'];
    const plain = checkout({ ...moved, 'docs/qa/adoption.md': record(waiveFor('caller.misplaced', '.github/workflows/review.yml', null)) });
    const r = await run(plain, fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['caller.misplaced']);
  });

  it('takes several bullets for one finding, each with its own items and reason, and shows which covers which', async () => {
    const { dir, github } = setup(`${waiveFor('app.permission-missing', slug, [kept], 'kept on purpose')}\n${waiveFor('app.permission-missing', slug, ['deployments'], 'until the deploy lane lands')}`);
    const r = await run(dir, github, ['--to', NEXT, '--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.waived.map((w: { items: string[]; line: number; reason: string }) => [w.items, w.line, w.reason])).toEqual([[[kept], 12, 'kept on purpose'], [['deployments'], 13, 'until the deploy lane lands']]);
    expect(r.json.waived[1].message).toBe(`The ${judge} App \`${slug}\` holds deployments: none; Kanon ${NEXT} needs deployments: read.`);
    const prose = await run(dir, github, ['--to', NEXT]);
    expect(prose.out).toContain(`- [App] app.permission-missing, ${slug} (deployments), by docs/qa/adoption.md:13: until the deploy lane lands.`);
    // An item a third permission brings stays a finding, naming both bullets.
    const more = next();
    (more.identities.apps[judge] ?? more.identities.roles[judge]!).permissions.pages = 'read';
    github.st.releases[NEXT] = more;
    const later = await run(dir, github, ['--to', NEXT, '--json']);
    expect(later.json.findings[0].message).toMatch(/needs pages: read\. docs\/qa\/adoption\.md:12 waives \w+; docs\/qa\/adoption\.md:13 waives deployments, not this\.$/);
  });

  it('waives item by item across the findings of one id on one subject, each App\'s secrets and a lane\'s', async () => {
    const secrets = new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets).filter((n) => !appSecrets(judge).includes(n) && n !== 'CLAUDE_CODE_OAUTH_TOKEN'));
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, appSecrets(judge), 'set in the organisation')) });
    const r = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(ids(r)).toEqual([`secret.missing ${REPO}`]);
    expect(r.json.findings[0].message).toMatch(/^lacks CLAUDE_CODE_OAUTH_TOKEN,/);
    expect(r.json.waived.map((w: { items: string[] }) => w.items)).toEqual([appSecrets(judge)]);
    // Naming one of the App's two leaves the other a finding, its fix the App's own.
    put(dir, { 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, [appSecrets(judge)[0]!, 'CLAUDE_CODE_OAUTH_TOKEN'], 'set in the organisation')) });
    const half = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(ids(half)).toEqual([`secret.missing ${REPO}`]);
    expect(half.json.findings[0].message).toMatch(new RegExp(`^lacks ${appSecrets(judge)[1]}, the ${judge} App's secret: .* docs/qa/adoption.md:12 waives ${appSecrets(judge)[0]}, not this\\.$`));
    expect(half.json.findings[0].fix.commands[0]).toBe('kanon apps --owner acme --repo widgets --preflight');
  });

  it('calls an item it names that doctor no longer reports stale, and the bullet stale when it reports none', async () => {
    const { dir, github } = setup(waiveFor('app.permission-missing', slug, [kept, 'pages']));
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(r.json.findings[0].message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} for pages, but doctor reports no such item there.`);
    expect(r.json.findings[0].fix.text).toBe('Remove `pages` from the bullet, so the record says only what is true.');
    expect(r.json.waived.map((w: { items: string[] }) => w.items)).toEqual([[kept]]);
    // The finding is there, but for none of the items it names (the Reviewer's F2 on 5a0088f).
    put(dir, { 'docs/qa/adoption.md': record(waiveFor('app.permission-missing', slug, ['pages'])) });
    const other = await run(dir, github, ['--json']);
    expect(ids(other)).toEqual([`app.permission-missing ${slug}`, 'waiver.stale docs/qa/adoption.md']);
    expect(other.json.findings[1].message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} for pages, but doctor reports none of it there.`);
    expect(other.json.findings[1].fix.text).toBe('Remove the bullet, so the record says only what is true.');
    github.st.apps[slug]!.permissions[kept] = permissionsOf(REQ, judge)[kept]!;
    const none = await run(dir, github, ['--json']);
    expect(ids(none)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(none.json.findings[0].message).toBe(`docs/qa/adoption.md:12 waives app.permission-missing on ${slug} for pages, but doctor reports no such finding.`);
  });

  it("doesn't call an item stale when the check that would report it could not run", async () => {
    const dir = checkout({ ...healthyFiles(), 'docs/qa/adoption.md': record(waiveFor('secret.missing', REPO, ['DIGEST_WEBHOOK'])) });
    const r = await run(dir, fakeGitHub({ secrets: null }), ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.notes.join('\n')).toContain(`docs/qa/adoption.md:12 waives secret.missing on ${REPO} for DIGEST_WEBHOOK, which doctor did not report; the secrets check could not run`);
  });

  it('reads the items of a waiver, and refuses items for a finding that lists none', () => {
    const at = (bullet: string) => readWaivers(`## Choices\n\n${bullet}\n`);
    expect(at(waiveFor('secret.missing', REPO, ['A_B', 'C D', 'A_B'], 'why')).waivers).toEqual([{ id: 'secret.missing', subject: REPO, items: ['A_B', 'C D'], reason: 'why', line: 3 }]);
    expect(at(waiveFor('caller.misplaced', 'a.yml', ['x'])).errors[0]).toContain("names items after `for`, but `caller.misplaced` lists none");
    // Several bullets of one finding, but never one item twice; an item-less one is read, for diagnose to refuse.
    const two = at(`${waiveFor('secret.missing', REPO, ['A', 'B'], 'one')}\n${waiveFor('secret.missing', REPO, ['C'], 'two')}\n${waiveFor('secret.missing', REPO, null, 'three')}`);
    expect(two.errors).toEqual([]);
    expect(two.waivers.map((w) => [w.items, w.line])).toEqual([[['A', 'B'], 3], [['C'], 4], [null, 5]]);
    expect(at(`${waiveFor('secret.missing', REPO, ['A', 'B'], 'one')}\n${waiveFor('secret.missing', REPO, ['C', 'B'], 'two')}`).errors).toEqual(['docs/qa/adoption.md:4 waives `B` of `secret.missing` on `acme/widgets`, which docs/qa/adoption.md:3 waives already']);
    expect(at(`${waiveFor('caller.misplaced', 'a.yml', null)}\n${waiveFor('caller.misplaced', 'a.yml', null, 'again')}`).errors[0]).toContain('a second time');
    for (const bad of [`- **${WAIVER_LABEL}:** \`secret.missing\` on \`${REPO}\` for A_B (why)`, `- **${WAIVER_LABEL}:** \`secret.missing\` on \`${REPO}\` for \`\` (why)`, `- **${WAIVER_LABEL}:** \`secret.missing\` on \`${REPO}\` for \`a\` and \`b\` (why)`]) {
      expect(at(bad).errors, bad).toHaveLength(1);
    }
  });

  it('lists every finding id that lists items in ITEMIZED and in docs/doctor.md, and nothing else', () => {
    const source = readFileSync(join(ROOT, 'cli/doctor.mjs'), 'utf8');
    const built = [...new Set([...source.matchAll(/findItems\('([a-z-]+\.[a-z-]+)'/g)].map((m) => m[1]))].sort();
    expect(built).toEqual(Object.keys(ITEMIZED).sort());
    for (const id of built) expect(UNWAIVABLE[id!], id).toBeUndefined();
    const doc = readFileSync(join(ROOT, 'docs/doctor.md'), 'utf8');
    const table = doc.split('| Id | An item |')[1]!.split('\n\n')[0]!;
    expect([...new Set([...table.matchAll(/`([a-z-]+\.[a-z-]+)`/g)].map((m) => m[1]))].sort()).toEqual(Object.keys(ITEMIZED).sort());
  });
});

describe('the readers doctor is built from', () => {
  it('counts an id-token grant as the guard does', () => {
    expect(idTokenGrant({}, { permissions: { 'id-token': 'write' } })).toEqual({ from: 'job', how: 'id-token' });
    expect(idTokenGrant({ permissions: { 'id-token': 'write' } }, { permissions: { contents: 'read' } })).toBeNull();
    expect(idTokenGrant({ permissions: 'write-all' }, {})).toEqual({ from: 'workflow', how: 'write-all' });
    expect(idTokenGrant({ permissions: 'read-all' }, {})).toBeNull();
    expect(idTokenGrant({}, { permissions: { 'id-token': 'none' } })).toBeNull();
    expect(idTokenGrant({}, {})).toBeNull();
  });

  it('reads Kanon pins outside comments only', () => {
    const pins = kanonPins(new Map([['.github/workflows/a.yml', '# uses: yedeya-labs/kanon/x@v0.0.1\n    uses: yedeya-labs/kanon/.github/workflows/agent-review.yml@v1.2.3\n']]));
    expect([...pins.keys()]).toEqual(['v1.2.3']);
  });

  it('reads an acceptance only under ## Choices, outside fences, once per holder', () => {
    const ok = `## Choices\n\n- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` (why)\n`;
    expect([...readHolderAcceptances(ok).accepted]).toEqual([['d.yml#j', 'why']]);
    expect(readHolderAcceptances(`## People\n\n- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` (why)\n`).errors[0]).toContain('outside `## Choices`');
    expect(readHolderAcceptances(`${ok}- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` (again)\n`).errors[0]).toContain('a second time');
    expect(readHolderAcceptances(`## Choices\n\n- **${HOLDER_LABEL}:** \`d.yml\` job \`j\` ()\n`).errors).toHaveLength(1);
    expect(readHolderAcceptances(`## Choices\n\n\`\`\`\n- **${HOLDER_LABEL}:** nonsense\n\`\`\`\n`)).toEqual({ accepted: new Map(), errors: [] });
  });

  it('reads a waiver only under ## Choices, outside fences, of a finding doctor reports and may waive, once each', () => {
    const line = (id: string, subject = 'a.yml', why = '(why)') => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` ${why}\n`;
    const ok = `## Choices\n\n${line('caller.misplaced')}`;
    expect(readWaivers(ok)).toEqual({ waivers: [{ id: 'caller.misplaced', subject: 'a.yml', items: null, reason: 'why', line: 3 }], errors: [] });
    expect(readWaivers(`${ok}${line('caller.misplaced', 'b.yml')}${line('caller.name')}`).waivers).toHaveLength(3);
    expect(readWaivers(`## People\n\n${line('caller.misplaced')}`).errors[0]).toContain('outside `## Choices`');
    expect(readWaivers(`${ok}${line('caller.misplaced', 'a.yml', '(again)')}`).errors[0]).toContain('a second time');
    expect(readWaivers(`## Choices\n\n${line('caller.misplaced', 'a.yml', '()')}`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n${line('caller.misplaced', 'a.yml', '')}`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n${line('caller.misplaced', ' ')}`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n${line('caller.nope')}`).errors[0]).toContain('no finding doctor reports');
    expect(readWaivers(`## Choices\n\n* **${WAIVER_LABEL.toLowerCase()}:** whatever\n`).errors).toHaveLength(1);
    expect(readWaivers(`## Choices\n\n\`\`\`\n${line('caller.misplaced')}\`\`\`\n`)).toEqual({ waivers: [], errors: [] });
    for (const id of Object.keys(UNWAIVABLE)) {
      expect(FINDINGS[id], id).toBeDefined();
      expect(readWaivers(`## Choices\n\n${line(id)}`).errors[0], id).toContain("can't be waived");
    }
  });
});

describe("the requirements file's App grants and the lanes' minting steps", () => {
  // The requirements file says what each App must hold; the lanes' minting steps are what they
  // ask of it. A grant the file drops that a step still mints with would make doctor pass an App
  // the lane then fails to mint on, so the two are held together here, from the lanes themselves.
  const level = (v: unknown) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);
  it('covers every literal permission a lane mints with, for the identity the lane runs as', () => {
    let seen = 0;
    const problems: string[] = [];
    for (const file of laneFiles(ROOT)) {
      const lane = file.replace(/\.yml$/, '');
      const ids = REQ.lanes[lane]!.identities;
      if (!ids.length) continue;
      expect(ids, `${lane} runs as one identity`).toHaveLength(1);
      const grant = permissionsOf(REQ, ids[0]!);
      for (const f of laneTree(ROOT, file)) {
        const doc = parse(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')) as { jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }> };
        for (const job of Object.values(doc.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            if (!String(step.uses ?? '').startsWith('actions/create-github-app-token@')) continue;
            for (const [k, v] of Object.entries(step.with ?? {})) {
              if (!k.startsWith('permission-') || typeof v !== 'string' || !/^(read|write)$/.test(v)) continue;
              seen++;
              const scope = k.slice('permission-'.length).replace(/-/g, '_');
              if (level(grant[scope]) < level(v)) problems.push(`${f} (${lane}, as ${ids[0]}) mints ${scope}: ${v}; requirements.json grants ${grant[scope] ?? 'none'}`);
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });
});

describe('the JSON contract (ADR 0014, docs/doctor.md)', () => {
  const doc = readFileSync(join(ROOT, 'docs/doctor.md'), 'utf8');

  it('has exactly the documented top-level, finding and holder fields', async () => {
    const files = healthyFiles();
    files['.github/workflows/deploy.yml'] = 'on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: x\n';
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(), ['--json']);
    const documented = (heading: string) => [...doc.split(`### ${heading}`)[1]!.split('\n### ')[0]!.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((m) => m[1]).sort();
    expect(r.json.schema).toBe(SCHEMA);
    expect(r.json.exitCode).toBe(r.status);
    expect(Object.keys(r.json).sort()).toEqual(documented('The document'));
    expect(Object.keys(r.json.findings[0]).sort()).toEqual(documented('A finding'));
    expect(Object.keys(r.json.findings[0].fix).sort()).toEqual(documented('A fix'));
    expect(Object.keys(r.json.idTokenHolders[0]).sort()).toEqual(documented('An id-token holder'));
    put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md'] + `- **${WAIVER_LABEL}:** \`caller.misplaced\` on \`.github/workflows/x.yml\` (why)\n` });
    const stale = await run(dir, fakeGitHub(), ['--json']);
    expect(stale.json.findings.map((f: { id: string }) => f.id)).toContain('waiver.stale');
    const github = fakeGitHub();
    github.st.labels = new Set();
    put(dir, { 'docs/qa/adoption.md': files['docs/qa/adoption.md'] + `- **${WAIVER_LABEL}:** \`label.missing\` on \`${REPO}\` for ${TAXONOMY.map((n) => `\`${n}\``).join(', ')} (why)\n` });
    const waived = await run(dir, github, ['--json']);
    expect(Object.keys(waived.json.waived[0]).sort()).toEqual(documented('A waived finding'));
    expect(doc).toContain(`\`${SCHEMA}\``);
  });

  it('documents every finding id, with its category and whether it blocks, and nothing else', () => {
    const rows = [...doc.matchAll(/^\| `([a-z-]+\.[a-z-]+)` \| `([a-z-]+)` \| (yes|no) \|/gm)].map((m) => [m[1], { category: m[2], blocking: m[3] === 'yes' }]);
    expect(Object.fromEntries(rows)).toEqual(FINDINGS);
    for (const f of Object.values(FINDINGS)) expect(CATEGORIES).toContain(f.category);
  });

  it('documents every finding id no waiver waives, and nothing else', () => {
    const section = doc.split('### What can\'t be waived')[1]!.split('\n## ')[0]!;
    const listed = [...new Set([...section.matchAll(/`([a-z-]+\.[a-z-]+)`/g)].map((m) => m[1]))].sort();
    expect(listed).toEqual(Object.keys(UNWAIVABLE).sort());
  });

  it('documents every exit code', () => {
    for (const [name, code] of Object.entries(EXIT)) expect(doc, name).toMatch(new RegExp(`^\\| ${code} \\| \`${name}\` \\|`, 'm'));
  });
});

// #49, K-MERGE-8: where the release caller maps the Releaser, it is the ruleset's only bypass
// actor, through pull requests only.
describe('kanon doctor and the Releaser\'s ruleset bypass (#49)', () => {
  const RELEASER_ID = 4242;
  const ADMIN = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' };
  const RELEASER = { actor_id: RELEASER_ID, actor_type: 'Integration', bypass_mode: 'pull_request' };
  const releaseCaller = [
    'name: Release', 'on:', '  push:', '    branches: [main]', 'permissions: {}', 'jobs:', '  release:',
    '    permissions:', '      contents: write', '      pull-requests: write',
    `    uses: yedeya-labs/kanon/.github/workflows/release.yml@${PINNED}`,
    '    secrets:', ...appSecrets('releaser').map((n) => `      ${n}: \${{ secrets.${n} }}`), '',
  ].join('\n');
  const withReleaser = (bypass: unknown[] | undefined, release = REQ) => {
    const files = healthyFiles();
    files['.github/workflows/release.yml'] = releaseCaller;
    files['docs/qa/agent-identities.md'] = registerText([...identitiesOf(LANES), 'releaser']);
    files['.github/workflows/apps-check.yml'] = appsCheckFile([...identitiesOf(LANES), 'releaser'], PINNED);
    const github = fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...appSecrets('releaser')]), releases: { [NEXT]: release } });
    github.st.apps['widgets-releaser'] = { id: RELEASER_ID, owner: { login: 'acme', type: 'User' }, permissions: permissionsOf(REQ, 'releaser') };
    github.st.rulesets = [{ ...github.st.rulesets[0]!, source_type: 'Repository', ...(bypass ? { bypass_actors: bypass } : {}) }];
    return { dir: checkout(files), github };
  };

  it('is healthy with the Releaser as the one bypass actor', async () => {
    const { dir, github } = withReleaser([RELEASER]);
    const r = await run(dir, github, ['--json']);
    expect(r.json.apps.map((a: { identity: string }) => a.identity)).toContain('releaser');
    expect(ids(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
  });

  it('names a ruleset that lacks the Releaser, with the command that adds it beside the others', async () => {
    const { dir, github } = withReleaser([ADMIN]);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.releaser-bypass-missing main', 'ruleset.bypass-extra main']);
    const [missing, extra] = r.json.findings;
    expect(missing).toMatchObject({ category: 'ruleset', blocking: true, fix: { url: `https://github.com/${REPO}/settings/rules/7` } });
    expect(missing.message).toContain('`widgets-releaser`');
    expect(JSON.parse(missing.fix.commands[1])).toEqual({ bypass_actors: [ADMIN, RELEASER] });
    expect(extra.message).toContain('the admin role (pull requests only)');
    expect(JSON.parse(extra.fix.commands[1])).toEqual({ bypass_actors: [RELEASER] });
    expect(r.status).toBe(EXIT.findings);
  });

  it('asks the admin bypass off only against a release whose dco passes the Releaser\'s release PR (#337)', async () => {
    // A release without the exemption, or one from before the field existed: keep the bypass.
    const without = clone(REQ);
    without.release = { dcoExemptsReleaser: false };
    const older = clone(REQ);
    delete older.release;
    for (const target of [without, older]) {
      const { dir, github } = withReleaser([ADMIN, RELEASER], target);
      const r = await run(dir, github, ['--json', '--to', NEXT]);
      expect(ids(r)).toEqual([]);
      expect(r.json.notes.join('\n')).toMatch(/lets the admin role \(pull requests only\) bypass it beside the Releaser\. Keep that while you pin v1\.1\.0/);
      expect(r.status).toBe(EXIT.healthy);
    }
    // This release has it: the admin's bypass goes.
    const { dir, github } = withReleaser([ADMIN, RELEASER]);
    expect(ids(await run(dir, github, ['--json']))).toEqual(['ruleset.bypass-extra main']);
  });

  it('tells the Releaser from another App by its id', async () => {
    const other = { actor_id: 99, actor_type: 'Integration', bypass_mode: 'pull_request' };
    const { dir, github } = withReleaser([other]);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.releaser-bypass-missing main', 'ruleset.bypass-extra main']);
    expect(r.json.findings[1].message).toContain('the App 99 (pull requests only)');
  });

  it('is incomplete, not healthy, when the token can\'t see the bypass list', async () => {
    const { dir, github } = withReleaser(undefined);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.unchecked).toEqual([expect.objectContaining({ check: 'ruleset-bypass', subject: 'main' })]);
    expect(r.status).toBe(EXIT.incomplete);
  });

  // #417: apps-check reads a private Releaser's permissions, but its id is the RELEASER_APP_ID
  // secret's value, which the run's log masks; the owner's installations name it.
  const privateReleaser = (bypass: unknown[]) => {
    const { dir, github } = withReleaser(bypass);
    github.st.private = new Set(Object.keys(github.st.apps));
    appsCheckRun(github, Object.fromEntries([...identitiesOf(LANES), 'releaser'].map((id) => [id, permissionsOf(REQ, id)])), { appIds: { releaser: RELEASER_ID } });
    return { dir, github };
  };

  it('reads a private Releaser\'s id from the owner\'s installations, never from the masked log, to find it in the bypass list (#417)', async () => {
    const { dir, github } = privateReleaser([RELEASER]);
    github.st.installations = [{ id: 34, app_slug: 'widgets-releaser', app_id: RELEASER_ID, account: { login: 'acme' } }];
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.unchecked).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
    const missing = privateReleaser([ADMIN]);
    missing.github.st.installations = github.st.installations;
    expect(ids(await run(missing.dir, missing.github, ['--json']))).toContain('ruleset.releaser-bypass-missing main');
  });

  it('leaves a private Releaser\'s bypass unchecked, and says why, when the token can\'t list the installations or they list no Releaser (#417)', async () => {
    const { dir, github } = privateReleaser([RELEASER]);
    const r = await run(dir, github, ['--json']);
    expect(r.json.unchecked).toEqual([expect.objectContaining({ check: 'ruleset-bypass', subject: 'main', reason: expect.stringContaining('a secret the run\'s log masks') })]);
    expect(r.json.unchecked[0].reason).toContain('only a GitHub App\'s user token can list them');
    expect(r.status).toBe(EXIT.incomplete);
    github.st.ownerType = 'Organization';
    const org = await run(dir, github, ['--json']);
    expect(org.json.unchecked[0].reason).toContain('Administration permission (read)');
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', app_id: 77, account: { login: 'acme' } }];
    const none = await run(dir, github, ['--json']);
    expect(none.json.unchecked).toEqual([expect.objectContaining({ check: 'ruleset-bypass', reason: expect.stringContaining('list no installation of it') })]);
  });

  it('asks nothing of the bypass where the release caller doesn\'t map the Releaser', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    github.st.rulesets = [{ ...github.st.rulesets[0]!, bypass_actors: [ADMIN] }];
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
  });
});

// The Owner, 2026-10-06: per-role Apps left installed after the two-App move are listed, not blocking.
describe('kanon doctor and Apps no lane uses any more', () => {
  /** A checkout whose register once named the per-role App `widgets-reviewer`, then moved on. */
  const migrated = () => {
    const files = healthyFiles();
    const now = files['docs/qa/agent-identities.md']!;
    files['docs/qa/agent-identities.md'] = `${now.trimEnd()}\n| Reviewer | \`widgets-reviewer\` | Read & write | Read & write | Read & write | No access | No access | None |\n`;
    const dir = checkout(files);
    put(dir, { 'docs/qa/agent-identities.md': now });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-am', 'move to two Apps']);
    return dir;
  };

  it('names an App the register once named that is still installed, without blocking, with the delete steps', async () => {
    const github = fakeGitHub();
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', account: { login: 'acme' } }, { id: 32, app_slug: 'some-other-app', account: { login: 'acme' } }];
    const r = await run(migrated(), github, ['--json']);
    expect(ids(r)).toEqual(['app.unused widgets-reviewer']);
    expect(r.json.findings[0]).toMatchObject({ category: 'app', blocking: false, fix: { url: 'https://github.com/settings/installations/31' } });
    expect(r.json.findings[0].fix.text).toContain('https://github.com/settings/apps/widgets-reviewer/advanced');
    expect(r.status).toBe(EXIT.healthy);
  });

  it('says nothing of one already uninstalled, or one the register still names', async () => {
    const github = fakeGitHub();
    github.st.installations = [{ id: 33, app_slug: `widgets-${identitiesOf(LANES)[0]}`, account: { login: 'acme' } }];
    const r = await run(migrated(), github, ['--json']);
    expect(ids(r)).toEqual([]);
  });

  it('in an organisation, lists its installations, and names the token that can when this one can\'t (#417)', async () => {
    const github = fakeGitHub();
    github.st.ownerType = 'Organization';
    const blind = await run(migrated(), github, ['--json']);
    expect(blind.json.unchecked).toEqual([expect.objectContaining({ check: 'unused-apps', subject: 'acme' })]);
    expect(blind.json.unchecked[0].reason).toMatch(/an owner of acme.*Administration permission \(read\)/);
    expect(blind.json.unchecked[0].reason).toContain('docs/doctor.md');
    expect(blind.status).toBe(EXIT.incomplete);
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', account: { login: 'acme' } }];
    const r = await run(migrated(), github, ['--json']);
    expect(github.calls.some((c) => c[1] === 'orgs/acme/installations?per_page=100')).toBe(true);
    expect(ids(r)).toEqual(['app.unused widgets-reviewer']);
    expect(r.json.findings[0].fix.url).toBe('https://github.com/organizations/acme/settings/installations/31');
    expect(r.status).toBe(EXIT.healthy);
  });

  it('is incomplete when the installations can\'t be listed, and asks nothing without a former App', async () => {
    const r = await run(migrated(), fakeGitHub(), ['--json']);
    expect(r.json.unchecked).toEqual([expect.objectContaining({ check: 'unused-apps', subject: 'acme' })]);
    expect(r.status).toBe(EXIT.incomplete);
    const github = fakeGitHub();
    const plain = await run(checkout(healthyFiles()), github, ['--json']);
    expect(plain.status).toBe(EXIT.healthy);
    expect(github.calls.some((c) => String(c[1]).includes('installations'))).toBe(false);
  });

  it('lists the per-role Apps as app.unused and their secrets as secret.stale, beside a release caller by `$/` (G4)', async () => {
    const dir = migrated();
    put(dir, { '.github/workflows/release-please.yml': releaseBy('$/.github/workflows/release.yml') });
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'release caller']);
    const github = fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...appSecrets('releaser'), ...appSecrets('reviewer')]) });
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', account: { login: 'acme' } }];
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['app.unused widgets-reviewer', 'secret.stale acme/widgets']);
    expect(r.json.findings[1].fix.commands).toEqual(appSecrets('reviewer').sort().map((n) => `gh secret delete ${n} -R ${REPO}`));
  });
});

/** A release caller reaching Kanon's release workflow by `uses`, mapping the Releaser's secrets. */
const releaseBy = (uses: string) => [
  'name: Release', 'on:', '  push:', '    branches: [main]', 'permissions: {}', 'jobs:', '  release:',
  '    permissions:', '      contents: write', '      pull-requests: write',
  `    uses: ${uses}`,
  '    secrets:', ...appSecrets('releaser').map((n) => `      ${n}: \${{ secrets.${n} }}`), '',
].join('\n');

// #414 (plan 0005 G16): doctor counts a secret as read when any workflow maps it into a job, not
// only when a caller it recognises as Kanon's does, so it never tells anyone to delete a secret a
// workflow still uses.
describe('kanon doctor and the secrets a workflow maps (#414)', () => {
  const RELEASER = appSecrets('releaser');
  const withSecrets = (files: Record<string, string>) => {
    const dir = checkout({ ...healthyFiles(), ...files });
    const github = fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...RELEASER]) });
    return run(dir, github, ['--json']);
  };

  it('lists the Releaser\'s secrets as stale when no workflow maps them, and says how it looked (the mutation\'s baseline)', async () => {
    const r = await withSecrets({});
    expect(ids(r)).toEqual(['secret.stale acme/widgets']);
    const stale = r.json.findings[0];
    expect(stale.fix.commands).toEqual(RELEASER.map((n) => `gh secret delete ${n} -R ${REPO}`));
    expect(stale.message).toContain('no job of a workflow under .github/workflows/ on main names');
    expect(stale.message).toContain('`secrets.<NAME>`');
  });

  for (const uses of ['$/.github/workflows/release.yml', './.github/workflows/release.yml']) {
    it(`doesn't list the secrets a release caller reaching release.yml by \`${uses.split('/')[0]}/\` maps`, async () => {
      const r = await withSecrets({ '.github/workflows/release-please.yml': releaseBy(uses) });
      expect(ids(r)).toEqual([]);
      expect(r.status).toBe(EXIT.healthy);
    });
  }

  it("doesn't list a secret any other job names, in its env:, a step's with: or its secrets:", async () => {
    const [id, key] = RELEASER as [string, string];
    const other = ['name: Other', 'on: push', 'permissions: {}', 'jobs:', '  mint:', '    runs-on: ubuntu-latest',
      '    env:', `      ID: \${{ secrets.${id} }}`,
      '    steps:', '      - uses: actions/create-github-app-token@v2', '        with:', `          private-key: \${{ secrets.${key} }}`, ''].join('\n');
    expect(ids(await withSecrets({ '.github/workflows/other.yml': other }))).toEqual([]);
    // Mutation: the job names only one of them, and the other is listed.
    const half = other.split('\n').filter((l) => !l.includes(key)).join('\n');
    const r = await withSecrets({ '.github/workflows/other.yml': half });
    expect(ids(r)).toEqual(['secret.stale acme/widgets']);
    expect(r.json.findings[0].fix.commands).toEqual([`gh secret delete ${key} -R ${REPO}`]);
  });

  it("doesn't count a secret a comment, or a reusable workflow's declaration of what it takes, names", async () => {
    const declares = ['name: Takes', 'on:', '  workflow_call:', '    secrets:', ...RELEASER.map((n) => `      ${n}:\n        required: false\n        description: "the caller maps secrets.${n}"`),
      'jobs:', '  noop:', '    runs-on: ubuntu-latest', `    # \${{ secrets.${RELEASER[0]} }}`, '    steps:', '      - run: "true"', ''].join('\n');
    expect(ids(await withSecrets({ '.github/workflows/takes.yml': declares }))).toEqual(['secret.stale acme/widgets']);
  });

  it('lists nothing as stale while a job inherits every secret, and says why', async () => {
    const inherits = ['name: Inherits', 'on: push', 'permissions: {}', 'jobs:', '  call:', '    uses: ./.github/workflows/mine.yml', '    secrets: inherit', ''].join('\n');
    const r = await withSecrets({ '.github/workflows/inherits.yml': inherits });
    expect(ids(r)).toEqual([]);
    expect(r.json.notes.join('\n')).toContain(`.github/workflows/inherits.yml's job call inherits every secret, so doctor lists none of ${RELEASER.join(', ')} as stale`);
  });

  it('lists nothing as stale while a workflow can\'t be read, which might map them', async () => {
    const r = await withSecrets({ '.github/workflows/broken.yml': 'jobs: [\n' });
    expect(ids(r)).toEqual([]);
    expect(r.json.unchecked).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'workflow', subject: '.github/workflows/broken.yml' })]));
  });

  it('notes that the reads are counted on the checkout, off the default branch', async () => {
    const dir = checkout(healthyFiles());
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'topic']);
    const r = await run(dir, fakeGitHub(), ['--json']);
    expect(r.json.notes.join('\n')).toContain('The id-token holders and the secrets the workflows map are counted on topic, not on main');
  });
});

// #415 (Kanon's own L5, G2 and G9e): for each secret of the checked release's Apps, or of its
// lanes, that a workflow maps and the repository doesn't hold, doctor reports secret.missing,
// naming the secret, the workflows that map it, and the kanon apps line that creates it, after
// its pre-check (#420). A caller that reaches its workflow by a local path or `$/` counts.
describe('kanon doctor and the secrets a caller maps at the checked release (#415)', () => {
  const APPS = ['author', 'judge', 'releaser'];
  const all = () => new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...APPS.flatMap(appSecrets)]);
  const preflight = `kanon apps --owner acme --repo widgets --preflight`;
  /** The L5 shape: the lanes Kanon pins, and a release caller that reaches release.yml by `$/`. */
  const l5 = (secrets: Set<string>, extra: Record<string, string> = {}) => {
    const dir = checkout({ ...healthyFiles(), '.github/workflows/release-please.yml': releaseBy('$/.github/workflows/release.yml'), ...extra });
    return run(dir, fakeGitHub({ secrets, releases: { [NEXT]: clone(REQ) } }), ['--to', NEXT, '--json']);
  };
  const missing = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'secret.missing');

  it('finds nothing missing while every App secret is there (the mutations\' baseline)', async () => {
    const r = await l5(all());
    expect(ids(r)).toEqual([]);
  });

  it('reports each App whose secrets are gone, the Releaser of a `$/` release caller included, and nothing else', async () => {
    const r = await l5(new Set([...all()].filter((n) => !/_APP_(ID|PRIVATE_KEY)$/.test(n))));
    expect(r.status).toBe(EXIT.findings);
    expect(ids(r)).toEqual(APPS.map(() => `secret.missing ${REPO}`));
    expect(missing(r).map((f: { message: string }) => f.message.split(',')[0])).toEqual(APPS.map((a) => `lacks ${appSecrets(a).join(' and ')}`));
    const releaser = missing(r)[2];
    expect(releaser.message).toContain('the releaser App\'s secrets: .github/workflows/release-please.yml maps them.');
    expect(releaser.fix.commands).toEqual([preflight, 'kanon apps --owner acme --repo widgets --apps releaser']);
  });

  for (const app of APPS) {
    it(`reports exactly the ${app} App's finding when only its secrets are gone (mutation)`, async () => {
      const r = await l5(new Set([...all()].filter((n) => !appSecrets(app).includes(n))));
      expect(ids(r)).toEqual([`secret.missing ${REPO}`]);
      expect(r.json.findings[0].message).toMatch(new RegExp(`^lacks ${appSecrets(app).join(' and ')}, the ${app} App's secrets: \\S`));
      expect(r.json.findings[0].fix.commands[0]).toBe(preflight);
      // The App the register names gets the line that stores a new key for it; another, the line that creates it.
      expect(r.json.findings[0].fix.commands[1]).toBe(app === 'releaser' ? `kanon apps --owner acme --repo widgets --apps releaser` : `kanon apps --owner acme --repo widgets --reuse ${app}:widgets-${app}=<downloaded>.pem`);
    });
  }

  it('names every workflow that maps the secrets, and the caller of a lane that takes them without mapping them', async () => {
    const files = healthyFiles();
    const judge = appSecrets('judge');
    const review = files['.github/workflows/agent-review.yml']!.split('\n').filter((l) => !judge.some((n) => l.includes(`${n}:`))).join('\n');
    const r = await l5(new Set([...all()].filter((n) => !judge.includes(n))), { '.github/workflows/agent-review.yml': review });
    const f = missing(r)[0];
    expect(f.message).toBe(`lacks ${judge.join(' and ')}, the judge App's secrets: .github/workflows/apps-check.yml maps them; .github/workflows/agent-review.yml calls a lane that takes them at ${NEXT}.`);
  });

  it('counts a lane reached by `$/`, which doctor does not read as a caller, and its lane secret too', async () => {
    const files = healthyFiles();
    delete files['.github/workflows/agent-review.yml'];
    const local = callerFile('agent-review', REQ.lanes['agent-review']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' }).replace(`yedeya-labs/kanon/.github/workflows/agent-review.yml@${PINNED}`, '$/.github/workflows/agent-review.yml').replace(/^( {4}secrets:\n)/m, '$1      DIGEST_WEBHOOK: ${{ secrets.DIGEST_WEBHOOK }}\n');
    const dir = checkout({ ...files, '.github/workflows/local-review.yml': local });
    const secrets = new Set([...all()].filter((n) => ![...appSecrets('judge'), ...appSecrets('releaser'), 'DIGEST_WEBHOOK'].includes(n)));
    const r = await run(dir, fakeGitHub({ secrets }), ['--json']);
    expect(r.json.lanes).toEqual(['agent-code-audit']);
    expect(ids(r).filter((x: string) => x.startsWith('secret.'))).toEqual([`secret.missing ${REPO}`, `secret.missing ${REPO}`]);
    const [judgeFinding, digest] = missing(r);
    expect(judgeFinding.message).toBe(`lacks ${appSecrets('judge').join(' and ')}, the judge App's secrets: .github/workflows/apps-check.yml, .github/workflows/local-review.yml map them.`);
    // No lane doctor reads runs as the Judge, so its slug is the register's own row.
    expect(r.json.apps.map((a: { identity: string }) => a.identity)).toEqual(['author']);
    expect(judgeFinding.fix.commands).toEqual([preflight, 'kanon apps --owner acme --repo widgets --reuse judge:widgets-judge=<downloaded>.pem']);
    expect(digest.message).toBe('lacks DIGEST_WEBHOOK: .github/workflows/local-review.yml maps it.');
    expect(digest.fix.commands).toEqual([`gh secret set DIGEST_WEBHOOK -R ${REPO}`]);
  });

  it("doesn't ask for a secret a reusable workflow only takes from its caller, as a lane's own definition does (Kanon's DIGEST_WEBHOOK)", async () => {
    const definition = (declares: boolean) => ['name: Digest', 'on:', '  workflow_call:', ...(declares ? ['    secrets:', '      digest_webhook: # GitHub reads a secret name in any case', '        required: true'] : []), '  schedule:', '    - cron: "0 9 * * 1"',
      'jobs:', '  post:', '    runs-on: ubuntu-latest', '    env:', '      HOOK: ${{ secrets.DIGEST_WEBHOOK }}', '    steps:', '      - run: "true"', ''].join('\n');
    expect(ids(await l5(all(), { '.github/workflows/digest.yml': definition(true) }))).toEqual([]);
    const secrets = new Set([...all()].filter((n) => n !== 'DIGEST_WEBHOOK'));
    expect(ids(await l5(secrets, { '.github/workflows/digest.yml': definition(true) }))).toEqual([]);
    // Mutation: the same job, in a workflow that doesn't declare it takes the secret, reads the repository's.
    const r = await l5(secrets, { '.github/workflows/digest.yml': definition(false) });
    expect(ids(r)).toEqual([`secret.missing ${REPO}`]);
    expect(r.json.findings[0].message).toBe('lacks DIGEST_WEBHOOK: .github/workflows/digest.yml maps it.');
  });

  it("reports no secret that is not Kanon's, nor one of a per-role App the checked release has no more", async () => {
    const role = Object.keys(REQ.identities.roles).find((x) => !REQ.identities.apps[x])!;
    const other = ['name: Publish', 'on: push', 'permissions: {}', 'jobs:', '  publish:', '    runs-on: ubuntu-latest', '    env:',
      '      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}', ...appSecrets(role).map((n) => `      ${n}: \${{ secrets.${n} }}`), '    steps:', '      - run: "true"', ''].join('\n');
    const r = await l5(all(), { '.github/workflows/publish.yml': other });
    expect(ids(r)).toEqual([]);
  });
});

// #417: GET /apps/<slug> answers 404 for a private App to a person's token and the workflow's
// alike; only the App itself reads it. apps-check reads each installation with the App's own
// key, and prints what it found; doctor reads that from the latest run on the default branch.
describe('kanon doctor and private Apps, read through apps-check (#417)', () => {
  const apps = identitiesOf(LANES);
  const asReleased = () => Object.fromEntries(apps.map((id) => [id, permissionsOf(REQ, id)]));
  const privately = () => {
    const github = fakeGitHub();
    github.st.private = new Set(apps.map((id) => `widgets-${id}`));
    return github;
  };

  it('is healthy, exit 0, when the Apps are private and the latest apps-check run found what the release grants', async () => {
    const github = privately();
    const url = appsCheckRun(github, asReleased());
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked).toEqual([]);
    expect(ids(r)).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.notes.filter((n: string) => n.includes(url))).toHaveLength(apps.length);
    expect(github.calls.map((c) => c.join(' '))).toContain(`api repos/${REPO}/actions/workflows/apps-check.yml/runs?branch=main&event=workflow_dispatch&status=completed&per_page=1`);
  });

  it('finds a missing and an extra permission in what apps-check found, though apps-check failed the run', async () => {
    const github = privately();
    const [author, judge] = apps as [string, string];
    const holds = asReleased();
    delete holds[judge]!.issues;
    holds[author]!.deployments = 'read';
    appsCheckRun(github, holds, { conclusion: 'failure' });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(ids(r)).toEqual([`app.permission-extra widgets-${author}`, `app.permission-missing widgets-${judge}`]);
    expect(r.json.findings[1].message).toContain('issues: none');
    expect(r.json.findings[1].fix.url).toBe(`https://github.com/settings/apps/widgets-${judge}/permissions`);
    expect(r.status).toBe(EXIT.findings);
  });

  it('checks --to against what apps-check found', async () => {
    const github = privately();
    const { next, slug } = nextRelease();
    github.st.releases[NEXT] = next;
    appsCheckRun(github, asReleased());
    const r = await run(checkout(healthyFiles()), github, ['--json', '--to', NEXT]);
    expect(ids(r)).toEqual([`app.permission-missing ${slug}`, 'declaration.missing docs/qa/capability-ledger.md']);
    expect(r.json.findings[0].message).toContain('deployments: read');
  });

  it('is incomplete, and says to run apps-check, when there is no run on the default branch', async () => {
    const github = privately();
    appsCheckRun(github, asReleased(), { branch: 'feature' });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked.map((u: { check: string; subject: string }) => `${u.check} ${u.subject}`)).toEqual(apps.map((id) => `app-permissions widgets-${id}`));
    for (const u of r.json.unchecked) {
      expect(u.reason).toContain('could not read the App');
      expect(u.reason).toContain(`gh workflow run apps-check.yml -R ${REPO}`);
    }
    expect(r.status).toBe(EXIT.incomplete);
  });

  it('never reads a newer run a fork\'s pull request from its own main started, whose workflow is the fork\'s', async () => {
    const github = privately();
    const [author] = apps as [string];
    const url = appsCheckRun(github, asReleased());
    const forged = asReleased();
    delete forged[author]!.contents;
    appsCheckRun(github, forged, { event: 'pull_request', from: 'mallory/widgets' });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked).toEqual([]);
    expect(ids(r)).toEqual([]);
    expect(r.json.notes.filter((n: string) => n.includes(url))).toHaveLength(apps.length);
  });

  it('is incomplete, and reads nothing from it, when the run it is given came from another repository or another event', async () => {
    for (const o of [{ from: 'mallory/widgets' }, { event: 'pull_request', from: 'mallory/widgets' }, { event: 'push' }]) {
      const github = privately();
      github.st.appsCheck.ignoresEvent = true;
      appsCheckRun(github, asReleased(), o);
      const r = await run(checkout(healthyFiles()), github, ['--json']);
      expect(r.json.unchecked.map((u: { check: string }) => u.check), JSON.stringify(o)).toEqual(apps.map(() => 'app-permissions'));
      expect(r.json.unchecked[0].reason).toContain(`not dispatched in ${REPO}`);
      expect(r.json.unchecked[0].reason).toContain(`gh workflow run apps-check.yml -R ${REPO}`);
      expect(r.status).toBe(EXIT.incomplete);
    }
  });

  it('is incomplete when the run printed no result, as apps-check before #417 did, or checked another App', async () => {
    const github = privately();
    const url = appsCheckRun(github, asReleased(), { line: false });
    const old = await run(checkout(healthyFiles()), github, ['--json']);
    expect(old.json.unchecked).toHaveLength(apps.length);
    expect(old.json.unchecked[0].reason).toContain(url);
    expect(old.json.unchecked[0].reason).toContain('gh workflow run apps-check.yml');
    expect(old.status).toBe(EXIT.incomplete);
    const [author] = apps as [string];
    appsCheckRun(github, asReleased(), { slugs: { [author]: 'acme-old-author' } });
    const other = await run(checkout(healthyFiles()), github, ['--json']);
    expect(other.json.unchecked).toEqual([expect.objectContaining({ check: 'app-permissions', subject: `widgets-${author}`, reason: expect.stringContaining('`acme-old-author`') })]);
    expect(other.status).toBe(EXIT.incomplete);
  });

  it('reads the permissions from a log the runner masked the App id in, and says when a line it can\'t read was masked', async () => {
    const github = privately();
    appsCheckRun(github, asReleased());
    expect([...github.st.appsCheck.secrets]).toHaveLength(apps.length);
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
    for (const n of r.json.notes) for (const v of github.st.appsCheck.secrets) expect(n).not.toContain(v);
    appsCheckRun(github, asReleased(), { line: 'with-id' });
    const old = await run(checkout(healthyFiles()), github, ['--json']);
    expect(old.json.unchecked).toHaveLength(apps.length);
    expect(old.json.unchecked[0].reason).toContain('the runner masked part of');
    expect(old.json.unchecked[0].reason).not.toContain('from before #417');
  });

  it('reads an App it can read from GitHub, and no run', async () => {
    const github = fakeGitHub();
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(github.calls.some((c) => c.some((x) => x.includes('/actions/')))).toBe(false);
  });
});

// #376: a project declares the kanon plugin in its .claude/settings.json (docs/skills.md), and
// doctor compares the declared release with the one it checks against, without blocking.
describe("kanon doctor and the kanon plugin's declared release (#376)", () => {
  const SETTINGS = '.claude/settings.json';
  const declared = (ref: string | null, over: { name?: string; source?: Record<string, unknown>; enabled?: boolean } = {}) => {
    const name = over.name ?? 'kanon';
    const source = over.source ?? { source: 'github', repo: 'yedeya-labs/kanon', ...(ref === null ? {} : { ref }) };
    return `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, extraKnownMarketplaces: { [name]: { source } }, enabledPlugins: { [`kanon@${name}`]: over.enabled ?? true } }, null, 2)}\n`;
  };
  const mismatch = (r: Result) => r.json.findings.filter((f: { id: string }) => f.id === 'plugin.version-mismatch');

  it('says nothing of a plugin declared at the pinned release, and notes one not declared at all', async () => {
    const at = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), fakeGitHub(), ['--json']);
    expect(at.status, at.out).toBe(EXIT.healthy);
    expect(at.json.findings).toEqual([]);
    expect(at.json.notes.join('\n')).not.toContain(SETTINGS);
    const none = await run(checkout(healthyFiles()), fakeGitHub(), ['--json']);
    expect(none.json.findings).toEqual([]);
    expect(none.json.notes.join('\n')).toContain(`${SETTINGS} doesn't declare the kanon plugin, so its release lives in each person's Claude Code configuration`);
  });

  it('names a declaration at another release, without blocking, with the one ref to set', async () => {
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0') }), fakeGitHub(), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.status).toBe('healthy');
    expect(mismatch(r)).toEqual([{
      id: 'plugin.version-mismatch', category: 'pin', blocking: false, subject: SETTINGS,
      message: `declares the kanon plugin's marketplace "kanon" at v0.9.0, not at ${PINNED} (the release the callers pin); the skills run kanon from the release they ship in, and install it (K-ADOPT-11).`,
      fix: { text: `Set the "kanon" marketplace's ref in ${SETTINGS} to ${PINNED}. Claude Code fetches the marketplace again from the changed source; run /reload-plugins in a session that is open.`, commands: [`"ref": "${PINNED}"`], url: null },
    }]);
    const prose = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0') }), fakeGitHub());
    expect(prose.status).toBe(EXIT.healthy);
    expect(prose.out).toContain(`[Pin, not blocking] ${SETTINGS}: declares the kanon plugin's marketplace "kanon" at v0.9.0`);
  });

  it('names a declaration with no ref, which follows the default branch', async () => {
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared(null) }), fakeGitHub(), ['--json']);
    expect(mismatch(r).map((f: { message: string }) => f.message)).toEqual([expect.stringContaining("with no ref, so it follows Kanon's default branch, not at")]);
  });

  it('compares with the release --to moves to: the plugin at the pin is named, the plugin at the target is not', async () => {
    const github = fakeGitHub();
    github.st.releases[NEXT] = clone(REQ);
    const atPin = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(PINNED) }), github, ['--to', NEXT, '--json']);
    expect(mismatch(atPin).map((f: { fix: { commands: string[] } }) => f.fix.commands)).toEqual([[`"ref": "${NEXT}"`]]);
    expect(mismatch(atPin)[0].message).toContain(`not at ${NEXT} (the release you are moving to)`);
    const atTarget = await run(checkout({ ...healthyFiles(), [SETTINGS]: pluginSettingsFile(NEXT) }), github, ['--to', NEXT, '--json']);
    expect(mismatch(atTarget)).toEqual([]);
  });

  it('finds Kanon by its marketplace source, whatever the entry is called, and only Kanon', async () => {
    const git = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0', { name: 'tools', source: { source: 'git', url: 'https://github.com/yedeya-labs/kanon.git', ref: 'v0.9.0' } }) }), fakeGitHub(), ['--json']);
    expect(mismatch(git).map((f: { message: string }) => f.message)).toEqual([expect.stringContaining('marketplace "tools" at v0.9.0')]);
    const other = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0', { source: { source: 'github', repo: 'acme/kanon-fork', ref: 'v0.9.0' } }) }), fakeGitHub(), ['--json']);
    expect(mismatch(other)).toEqual([]);
    expect(other.json.notes.join('\n')).toContain(`${SETTINGS} doesn't declare the kanon plugin (it enables kanon@kanon, from a marketplace each person added themselves)`);
  });

  it('notes a declared marketplace whose plugin is not enabled', async () => {
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared(PINNED, { enabled: false }) }), fakeGitHub(), ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.json.notes.join('\n')).toContain(`declares the kanon plugin's marketplace "kanon" but doesn't enable kanon@kanon`);
  });

  it('is incomplete, exit 4, when the settings file is not a JSON object', async () => {
    for (const text of ['{ "enabledPlugins": ', '[]\n']) {
      const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: text }), fakeGitHub(), ['--json']);
      expect(r.status, text).toBe(EXIT.incomplete);
      expect(r.json.unchecked).toEqual([{ check: 'plugin', subject: SETTINGS, reason: expect.stringMatching(/^could not read it: it is not (JSON|a JSON object)/) }]);
    }
  });

  it('lets the adoption record waive it, as any finding (#390)', async () => {
    const record = `${healthyFiles()['docs/qa/adoption.md']}- **${WAIVER_LABEL}:** \`plugin.version-mismatch\` on \`${SETTINGS}\` (the plugin leads the pin until Dependabot's bump merges)\n`;
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: declared('v0.9.0'), 'docs/qa/adoption.md': record }), fakeGitHub(), ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.json.waived.map((w: { id: string; reason: string }) => [w.id, w.reason])).toEqual([['plugin.version-mismatch', "the plugin leads the pin until Dependabot's bump merges"]]);
    expect(UNWAIVABLE['plugin.version-mismatch']).toBeUndefined();
  });

  it("doesn't call its waiver stale when the settings file can't be read, and doesn't excuse another pin waiver", async () => {
    const waive = (id: string, subject: string) => `- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` (kept on purpose)\n`;
    const record = `${healthyFiles()['docs/qa/adoption.md']}${waive('plugin.version-mismatch', SETTINGS)}${waive('pin.mixed', '.github')}`;
    const r = await run(checkout({ ...healthyFiles(), [SETTINGS]: '{', 'docs/qa/adoption.md': record }), fakeGitHub(), ['--json']);
    expect(ids(r)).toEqual(['waiver.stale docs/qa/adoption.md']);
    expect(r.json.findings[0].message).toContain('waives pin.mixed on .github');
    expect(r.json.notes.join('\n')).toContain('waives plugin.version-mismatch on .claude/settings.json, which doctor did not report; the plugin check could not run');
  });
});

describe('the reader of the kanon plugin\'s declaration (cli/plugin.mjs)', () => {
  const at = (doc: unknown) => readPluginDeclaration(JSON.stringify(doc));
  const kanon = (ref?: string) => ({ source: { source: 'github', repo: 'yedeya-labs/kanon', ...(ref ? { ref } : {}) } });

  it('reads what init writes as declared at its release, and enabled', () => {
    expect(readPluginDeclaration(pluginSettingsFile('v1.2.3'))).toEqual({ status: 'declared', name: 'kanon', ref: 'v1.2.3', enabled: true });
    expect(readPluginDeclaration(null)).toEqual({ status: 'absent' });
  });

  it('reads the alias only when the canonical key is absent, as Claude Code does', () => {
    expect(at({ additionalMarketplaces: { kanon: kanon('v1.0.0') } })).toMatchObject({ status: 'declared', ref: 'v1.0.0' });
    expect(at({ extraKnownMarketplaces: { kanon: kanon('v2.0.0') }, additionalMarketplaces: { kanon: kanon('v1.0.0') } })).toMatchObject({ status: 'declared', ref: 'v2.0.0' });
  });

  it('knows Kanon by a github or git source, in any case, and nothing else', () => {
    for (const source of [
      { source: 'github', repo: 'Yedeya-Labs/Kanon' },
      { source: 'git', url: 'https://github.com/yedeya-labs/kanon' },
      { source: 'git', url: 'git@github.com:yedeya-labs/kanon.git' },
    ]) expect(isKanonSource(source), JSON.stringify(source)).toBe(true);
    for (const source of [
      { source: 'github', repo: 'yedeya-labs/kanon-fork' },
      { source: 'github', repo: 'acme/kanon' },
      { source: 'git', url: 'https://gitlab.com/yedeya-labs/kanon.git' },
      { source: 'git', url: 'https://github.com/yedeya-labs/kanon-fork.git' },
      { source: 'directory', path: '.' },
      { source: 'url', url: 'https://github.com/yedeya-labs/kanon' },
      null,
    ]) expect(isKanonSource(source), JSON.stringify(source)).toBe(false);
  });

  it('treats an empty ref as none', () => {
    expect(at({ extraKnownMarketplaces: { kanon: { source: { source: 'github', repo: 'yedeya-labs/kanon', ref: ' ' } } }, enabledPlugins: { 'kanon@kanon': true } })).toEqual({ status: 'declared', name: 'kanon', ref: null, enabled: true });
  });
});

// #428: a caller of Kanon's telemetry collector, as `kanon init --telemetry` writes it, is Kanon's
// id-token holder, and sends nothing until the repository sets the two variables the operator
// gives it, which doctor lists without blocking.
describe("kanon doctor and the telemetry collector's caller (#428)", () => {
  const VARS = ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE'];
  const withCollector = (release = PINNED) => ({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: telemetryCallerFile(release) });
  const holderOf = (r: Result) => r.json.idTokenHolders.find((h: { workflow: string }) => h.workflow === TELEMETRY_CALLER_PATH);

  it('lists the caller init writes as Kanon\'s holder, and is healthy once both variables are set', async () => {
    const dir = checkout(withCollector());
    const r = await run(dir, fakeGitHub({ variables: new Set(VARS) }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.findings).toEqual([]);
    expect(holderOf(r)).toMatchObject({ job: 'collect', status: 'kanon-lane', reason: null });
  });

  it('reports each unset variable without blocking, with the operator step as its fix, and lets it be waived', async () => {
    const dir = checkout(withCollector());
    const r = await run(dir, fakeGitHub({ variables: new Set(['KANON_TELEMETRY_URL']) }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(ids(r)).toEqual([`telemetry.unconfigured ${TELEMETRY_CALLER_PATH}`]);
    const f = r.json.findings[0];
    expect(f).toMatchObject({ category: 'caller', blocking: false });
    expect(f.message).toContain("doesn't set KANON_TELEMETRY_WRITER_ROLE,");
    expect(f.fix.url).toMatch(/template=telemetry-registration\.yml$/);
    expect(f.fix.commands).toHaveLength(2);
    const none = await run(dir, fakeGitHub(), ['--json']);
    expect(none.json.findings[0].message).toContain("doesn't set KANON_TELEMETRY_URL or KANON_TELEMETRY_WRITER_ROLE");
    put(dir, { 'docs/qa/adoption.md': healthyFiles()['docs/qa/adoption.md'] + `- **${WAIVER_LABEL}:** \`telemetry.unconfigured\` on \`${TELEMETRY_CALLER_PATH}\` for \`KANON_TELEMETRY_URL\`, \`KANON_TELEMETRY_WRITER_ROLE\` (registration requested)\n` });
    const waived = await run(dir, fakeGitHub(), ['--json']);
    expect(waived.json.findings).toEqual([]);
    expect(waived.json.waived.map((w: { id: string }) => w.id)).toEqual(['telemetry.unconfigured']);
  });

  it("says in a note, not as unchecked, when the token can't list the variables", async () => {
    const r = await run(checkout(withCollector()), fakeGitHub({ variables: null }), ['--json']);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.unchecked).toEqual([]);
    expect(r.json.notes.some((n: string) => n.includes("the token can't list acme/widgets's variables"))).toBe(true);
  });

  it("asks nothing of a repository without the collector's caller", async () => {
    const github = fakeGitHub({ variables: null });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(github.calls.some((c) => c[0] === 'variable')).toBe(false);
  });

  it('accepts the collector only from a release whose requirements name it', async () => {
    const old = clone(REQ);
    delete (old as { telemetry?: unknown }).telemetry;
    const github = fakeGitHub({ variables: new Set(VARS) });
    const r = await run(checkout({ ...healthyFiles(), [TELEMETRY_CALLER_PATH]: telemetryCallerFile(PINNED) }), github, ['--json']);
    expect(holderOf(r).status).toBe('kanon-lane');
    // Against a release whose requirements file doesn't name the collector, it is unaccepted.
    const out: string[] = [];
    await doctor(['--dir', checkout(withCollector()), '--json'], { gh: github.gh, env: {}, out: (l: string) => out.push(l), err: () => {}, requirements: () => old, release: () => PINNED });
    const doc = JSON.parse(out.join('\n'));
    expect(doc.idTokenHolders.find((h: { workflow: string }) => h.workflow === TELEMETRY_CALLER_PATH).status).toBe('unaccepted');
    expect(doc.findings.map((f: { id: string }) => f.id)).not.toContain('telemetry.unconfigured');
  });
});
