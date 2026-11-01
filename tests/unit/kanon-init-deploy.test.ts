import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DIAGNOSE_DROPPED } from '../../cli/init.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { ROOT, hasYq, REQ, PINNED, checkout, fakeGitHub, run, changing, laneCheck, read, parse } from './helpers/kanon-init.js';

// Its cases run `kanon init` against a real git checkout, and several run lane-check, so every
// case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// `kanon init` and the deploy and deploy diagnose lanes. Split out of kanon-init.test.ts (#1204);
// the fixtures are in tests/unit/helpers/kanon-init.ts.

// Plan 0010 step D6: `kanon init` writes the deploy lane's caller from the declared list, the
// three hooks' stubs, and, with `--deploy-environments`, the record's `## Deploy` section; with no
// list it writes none of them. The adopt skill's question is recommended from the inspection.
describe('kanon init and the deploy lane (plan 0010 D6)', () => {
  const CALLER = '.github/workflows/deploy.yml';
  const RECORD = 'docs/qa/adoption.md';
  const DEPLOY = (REQ as unknown as { deploy: { workflows: { release: string; environment: string }; grants: Record<string, Record<string, string>>; hooks: Array<{ path: string; inputs: string[] }> } }).deploy;
  const HOOKS = DEPLOY.hooks.map((h) => h.path);
  const BUILD = '${{ needs.release.outputs.build }}';
  const TARGETS_IN = '${{ vars.KANON_DEPLOY_TARGETS }}';
  const TARGETS_OUT = '${{ needs.release.outputs.targets }}';
  type Job = { name?: string; needs?: string | string[]; uses?: string; with?: Record<string, unknown>; permissions?: Record<string, string>; secrets?: unknown };
  const callerOf = (dir: string) => parseYaml(read(dir, CALLER)) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  const declare = async (envs: string, extra: string[] = []) => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--deploy-environments', envs, ...extra]));
    return { dir, d };
  };

  /** The caller's shape for a list: a release job, then one deploy-<n> per environment, in order, chained. */
  const expectChain = (dir: string, envs: string[]) => {
    const wf = callerOf(dir);
    expect(Object.keys(wf.jobs)).toEqual(['release', ...envs.map((_, i) => `deploy-${i + 1}`)]);
    expect(wf.on).toEqual({ release: { types: ['published'] }, workflow_dispatch: { inputs: { release: expect.objectContaining({ required: true, type: 'string' }) } } });
    const release = wf.jobs.release!;
    expect(release.uses).toBe(`yedeya-labs/kanon/.github/workflows/${DEPLOY.workflows.release}.yml@${PINNED}`);
    // kanon#1555: the repository variable, which only the caller can read, into the lane.
    expect(release.with).toEqual({ environments: envs.join(' '), targets: TARGETS_IN });
    expect(release.permissions).toEqual(DEPLOY.grants[DEPLOY.workflows.release]);
    expect(release.needs).toBeUndefined();
    envs.forEach((env, i) => {
      const job = wf.jobs[`deploy-${i + 1}`]!;
      expect(job.name).toBe(env);
      expect(job.needs, env).toEqual(i === 0 ? 'release' : ['release', `deploy-${i}`]);
      expect(job.uses).toBe(`yedeya-labs/kanon/.github/workflows/${DEPLOY.workflows.environment}.yml@${PINNED}`);
      // D5: deploy.yml's build input is required, so a caller without it fails before any job runs.
      // kanon#1555: the release job's targets, so the deploy hook gets this environment's role.
      expect(job.with, env).toEqual({ environment: env, position: i + 1, build: BUILD, targets: TARGETS_OUT });
      expect(job.permissions).toEqual(DEPLOY.grants[DEPLOY.workflows.environment]);
    });
    // Each environment's job maps the announcement's chat secret, whatever the chat answer (plan
    // 0011 N9, §10.2's `none` row), and the deploy hook's environment secret by its own name, which
    // GitHub evaluates in the deploy job's scope, the environment's first (kanon#1049). Nothing else.
    expect(wf.jobs.release!.secrets).toBeUndefined();
    envs.forEach((env, i) => expect(wf.jobs[`deploy-${i + 1}`]!.secrets, env).toEqual({
      KANON_CHAT_DEPLOY: '${{ secrets.KANON_CHAT_DEPLOY }}',
      KANON_DEPLOY_SECRET: '${{ secrets.KANON_DEPLOY_SECRET }}',
    }));
    expect(read(dir, CALLER).match(/KANON_DEPLOY_SECRET: \$\{\{ secrets\.KANON_DEPLOY_SECRET \}\}/g)).toHaveLength(envs.length);
    expect(read(dir, CALLER)).not.toMatch(/inherit/);
  };

  it.each([[['production']], [['staging', 'production']], [['dev', 'staging', 'production']]])('writes the caller for %j: a release job, then one job per environment in order, each needing the one before and release', async (envs) => {
    const { dir, d } = await declare(envs.join(','));
    expect(d.status, JSON.stringify(d)).not.toBe('error');
    expect(d.answers.deployEnvironments).toEqual(envs);
    expectChain(dir, envs);
    expect(d.files.find((f) => f.path === CALLER)).toMatchObject({ status: 'new', content: read(dir, CALLER) });
  });

  it('writes a ## Deploy section the declaration parser reads, the first environment the reference, after ## Data', async () => {
    const { parseDeployDeclaration } = await import('../../scripts/lib/deploy-declaration.mjs');
    const { dir, d } = await declare('staging,production');
    const record = read(dir, RECORD);
    const declared = parseDeployDeclaration(record);
    expect(declared.environments).toEqual(['staging', 'production']);
    expect(declared.chain.map((l) => l.role)).toEqual(['pre-production', 'production']);
    expect(declared.reference).toEqual({ environment: 'staging', workflow: 'deploy.yml', job: 'staging / deploy' });
    expect(declared.ciWait).toBe(90);
    expect(declared.fallback).toBeNull();
    expect(record.indexOf('\n## Deploy\n')).toBeGreaterThan(record.indexOf('\n## Data\n'));
    // The plan's prose bullet no longer says no lane needs an environment.
    expect(record).not.toContain('no Kanon lane needs one');
    expect(d.summary.find((l) => l.answer === 'Deploy')).toMatchObject({ fields: ['deployEnvironments'], source: 'flag' });
    expect(d.summary.find((l) => l.answer === 'Deploy')!.value).toMatch(/^staging then production \(production is production\)/);
  });

  it('writes no caller, no stub and no ## Deploy section with no declaration, nor with --deploy-environments none', async () => {
    for (const argv of [[], ['--deploy-environments', 'none']]) {
      const dir = checkout();
      const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', ...argv]));
      expect(d.answers.deployEnvironments, argv.join(' ')).toEqual([]);
      for (const p of [CALLER, ...HOOKS]) {
        expect(existsSync(join(dir, p)), p).toBe(false);
        expect(d.files.map((f) => f.path)).not.toContain(p);
      }
      expect(read(dir, RECORD)).not.toContain('## Deploy');
      expect(read(dir, RECORD)).toContain('- **Environments:** no Kanon lane needs one.');
      expect(d.findings.map((f) => f.id).filter((id) => id.startsWith('deploy.'))).toEqual([]);
      expect(d.summary.find((l) => l.answer === 'Deploy')).toMatchObject({ value: 'none: no deploy lane' });
    }
  });

  it('rewrites the caller when the declared list changes, from the record, and keeps the hooks', async () => {
    const { dir } = await declare('staging,production');
    writeFileSync(join(dir, RECORD), read(dir, RECORD).replace('- **Environments:** `staging`, `production`', '- **Environments:** `staging`, `qa`, `production`'));
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(d.answers.deployEnvironments).toEqual(['staging', 'qa', 'production']);
    expect(d.summary.find((l) => l.answer === 'Deploy')).toMatchObject({ source: 'inferred', reason: "from the adoption record's ## Deploy" });
    expectChain(dir, ['staging', 'qa', 'production']);
    const f = d.files.find((x) => x.path === CALLER)!;
    expect(f.status).toBe('rewritten');
    expect(f.diff).toContain("+       environments: 'staging qa production'");
    // The record is the project's: its list is the answer, so nothing is left to declare.
    expect(d.findings.map((x) => x.id)).not.toContain('deploy.declare');
    for (const p of HOOKS) expect(d.files.find((x) => x.path === p)?.status, p).toBe('same');
    // Its jobs hold id-token: write for the lane, as a store-coupled lane's caller does: Kanon's.
    const holders = d.inspection.idTokenHolders as Array<{ workflow: string; status: string }>;
    expect(holders.filter((h) => h.workflow === CALLER).map((h) => h.status)).toEqual(['kanon-lane', 'kanon-lane', 'kanon-lane']);
    expect(d.findings.map((x) => x.id)).not.toContain('id-token.unaccepted');
  });

  it("rewrites a caller that doesn't map KANON_DEPLOY_SECRET, the old caller's shape, so the hook reads the environment's secret (kanon#1049)", async () => {
    const { dir } = await declare('staging,production');
    const MAP = '      KANON_DEPLOY_SECRET: ${{ secrets.KANON_DEPLOY_SECRET }}\n';
    const written = read(dir, CALLER);
    expect(written.split(MAP)).toHaveLength(3);
    writeFileSync(join(dir, CALLER), written.split(MAP).join(''));
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    const f = d.files.find((x) => x.path === CALLER)!;
    expect(f.status).toBe('rewritten');
    expect(f.diff).toContain('+       KANON_DEPLOY_SECRET: ${{ secrets.KANON_DEPLOY_SECRET }}');
    expectChain(dir, ['staging', 'production']);
  });

  it("rewrites a caller that doesn't hand on KANON_DEPLOY_TARGETS, the old caller's shape, so the hook gets each environment's role (kanon#1555)", async () => {
    const { dir } = await declare('staging,production');
    const IN = `      targets: ${TARGETS_IN}\n`;
    const OUT = `      targets: ${TARGETS_OUT}\n`;
    const written = read(dir, CALLER);
    expect(written.split(IN)).toHaveLength(2);
    expect(written.split(OUT)).toHaveLength(3);
    writeFileSync(join(dir, CALLER), written.replaceAll(IN, '').replaceAll(OUT, ''));
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    const f = d.files.find((x) => x.path === CALLER)!;
    expect(f.status).toBe('rewritten');
    expect(f.diff).toContain(`+       targets: ${TARGETS_IN}`);
    expect(f.diff).toContain(`+       targets: ${TARGETS_OUT}`);
    expectChain(dir, ['staging', 'production']);
  });

  it("passes no targets for a release whose deploy lane doesn't take them, as before kanon#1555", async () => {
    const before = structuredClone(REQ) as unknown as { deploy: { inputs: Record<string, Record<string, unknown>> } };
    delete before.deploy.inputs['deploy-release']!.targets;
    delete before.deploy.inputs.deploy!.targets;
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--deploy-environments', 'staging,production'], undefined, before as unknown as typeof REQ);
    expect(r.status, r.err).toBe(0);
    const jobs = callerOf(dir).jobs;
    expect(jobs.release!.with).toEqual({ environments: 'staging production' });
    expect(jobs['deploy-1']!.with).toEqual({ environment: 'staging', position: 1, build: BUILD });
    expect(read(dir, CALLER)).not.toMatch(/targets/);
  });

  it("maps no KANON_DEPLOY_SECRET for a release whose deploy.yml doesn't declare it, as before kanon#1049", async () => {
    const before = structuredClone(REQ) as unknown as { deploy: { declaredSecrets?: string[] } };
    delete before.deploy.declaredSecrets;
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--deploy-environments', 'staging,production'], undefined, before as unknown as typeof REQ);
    expect(r.status, r.err).toBe(0);
    const jobs = callerOf(dir).jobs;
    expect(jobs['deploy-1']!.secrets).toEqual({ KANON_CHAT_DEPLOY: '${{ secrets.KANON_CHAT_DEPLOY }}' });
    expect(read(dir, CALLER)).not.toMatch(/KANON_DEPLOY_SECRET/);
  });

  it("leaves a deploy workflow of the project's own at that path alone, writes nothing of the lane, and says why (#956)", async () => {
    const own = 'name: Deploy\non: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: ./deploy.sh\n';
    const dir = checkout({ [CALLER]: own });
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--deploy-environments', 'production']));
    expect(read(dir, CALLER)).toBe(own);
    // No caller, no stub, and no reference deploy naming a job nobody writes.
    expect(d.files.map((f) => f.path)).not.toContain(CALLER);
    for (const p of HOOKS) expect(existsSync(join(dir, p)), p).toBe(false);
    expect(read(dir, RECORD)).not.toContain('\n## Deploy\n');
    expect(read(dir, RECORD)).not.toContain('Reference deploy');
    const f = d.findings.find((x) => x.id === 'deploy.caller-taken')!;
    expect(f).toMatchObject({ category: 'deploy', blocking: false, subject: CALLER });
    expect(f.message).toMatch(/is a deploy workflow of your own, which calls no Kanon deploy lane, so init wrote nothing for the deploy lane/);
    expect(d.findings.map((x) => x.id)).not.toContain('deploy.hooks');
    const line = d.summary.find((l) => l.answer === 'Deploy')!.value;
    expect(line).toBe(`production: nothing written, ${CALLER} is a deploy workflow of your own`);
    expect(line).not.toMatch(/caller and three hook stubs/);
  });

  it("stops, naming the line, on a record that declares an environment name it couldn't write into the caller (#956)", async () => {
    for (const name of ['prod eu', "it's"]) {
      const record = `# Adoption record\n\n## Deploy\n\n- **Environments:** \`staging\`, \`${name}\`\n`;
      const dir = checkout({ [RECORD]: record });
      const github = fakeGitHub();
      const r = await run(dir, github, ['--yes', '--json', '--no-apps']);
      expect(r.status, name).toBe(1);
      expect(JSON.parse(r.out).error, name).toContain(`${RECORD}:5 declares the environment \`${name}\`, which init can't write`);
      expect(github.calls).toEqual([]);
      expect(existsSync(join(dir, CALLER))).toBe(false);
    }
  });

  it("names the Environments bullet inside ## Deploy, not ## Plan's prose bullet, in either bullet form (#956)", async () => {
    // A record init wrote, then edited: ## Plan's prose bullet of the same label comes first.
    const { dir } = await declare('staging,production');
    const written = read(dir, RECORD).replace('- **Environments:** `staging`, `production`', '* **Environments:** `staging`, `prod eu`');
    writeFileSync(join(dir, RECORD), written);
    const at = written.split('\n').findIndex((l) => l.startsWith('* **Environments:**')) + 1;
    expect(written.split('\n').findIndex((l) => l.startsWith('- **Environments:**')) + 1).toBeLessThan(at);
    const github = fakeGitHub();
    const r = await run(dir, github, ['--yes', '--json', '--no-apps']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out).error).toContain(`${RECORD}:${at} declares the environment \`prod eu\``);
    expect(github.calls).toEqual([]);
  });

  it('takes none in any case, as the adopt skill labels it None (#956)', async () => {
    const { parseDeployEnvironments } = await import('../../cli/init.mjs');
    for (const v of ['none', 'None', 'NONE', ' none ']) expect(parseDeployEnvironments(v), v).toEqual([]);
  });

  it("names the repository's environments in the inspection's banner, not 'not needed by any lane' (#956)", async () => {
    const r = await run(checkout(), fakeGitHub({ environments: ['staging', 'production'] }), ['--yes', '--dry-run']);
    expect(r.out).toContain('Environments: staging, production (only the deploy lane uses them).');
    expect(r.out).not.toContain('not needed by any lane');
    expect((await run(checkout(), fakeGitHub(), ['--yes', '--dry-run'])).out).toContain('Environments: not readable with this token');
  });

  it("writes hook stubs that declare the lane's inputs and exit non-zero naming their file, and never overwrites a hook", async () => {
    const filled = 'name: Smoke\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: curl -fsS https://example.com/health\n';
    const dir = checkout({ '.github/actions/smoke/action.yml': filled });
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--deploy-environments', 'production']));
    expect(read(dir, '.github/actions/smoke/action.yml')).toBe(filled);
    expect(d.files.find((f) => f.path === '.github/actions/smoke/action.yml')).toMatchObject({ status: 'kept', content: null });
    for (const h of DEPLOY.hooks.filter((x) => x.path !== '.github/actions/smoke/action.yml')) {
      const stub = parseYaml(read(dir, h.path)) as { inputs: Record<string, unknown>; runs: { using: string; steps: Array<{ shell: string; run: string }> } };
      expect(Object.keys(stub.inputs).sort(), h.path).toEqual([...h.inputs].sort());
      expect(stub.runs.using).toBe('composite');
      const r = spawnSync('bash', ['-c', stub.runs.steps[0]!.run], { encoding: 'utf8' });
      expect(r.status, h.path).not.toBe(0);
      expect(r.stdout, h.path).toContain(h.path);
    }
    // The stubs left are a step for the person, named; the kept hook is not among them.
    const f = d.findings.find((x) => x.id === 'deploy.hooks')!;
    expect(f).toMatchObject({ category: 'deploy', blocking: false, subject: '.github/actions/build/action.yml, .github/actions/deploy/action.yml' });
    // A second run keeps the stubs as they are.
    const again = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    for (const p of HOOKS) expect(['same', 'kept'], p).toContain(again.files.find((x) => x.path === p)?.status);
  });

  it.skipIf(!hasYq)('writes a caller and stubs that pass lane-check', async () => {
    // With the Apps' stub, which writes the register the review lane's caller needs.
    const dir = checkout();
    expect((await run(dir, fakeGitHub(), ['--yes', '--deploy-environments', 'staging,production'])).status).toBe(0);
    expect(existsSync(join(dir, CALLER))).toBe(true);
    const lc = laneCheck(dir);
    expect(lc.status, lc.out).toBe(0);
  }, 30_000);

  it("names the bullets to write where the record is the project's and declares another list, and still writes the caller from the answer", async () => {
    const dir = checkout();
    await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']);
    const before = read(dir, RECORD);
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--deploy-environments', 'staging,production']));
    expect(read(dir, RECORD)).toBe(before);
    expectChain(dir, ['staging', 'production']);
    const f = d.findings.find((x) => x.id === 'deploy.declare')!;
    expect(f).toMatchObject({ category: 'deploy', blocking: false, subject: RECORD });
    expect(f.message).toBe(`${RECORD} is the project's, and its ## Deploy section declares no deploy environment, not staging, production.`);
    expect(f.fix.commands).toEqual(['- **Environments:** `staging`, `production`', '- **Reference environment:** `staging`', '- **Reference deploy workflow:** `deploy.yml`', '- **Reference deploy job:** `staging / deploy`']);
  });

  it("stops before reading GitHub on a ## Deploy section that doesn't parse, and changes nothing", async () => {
    const record = '# Adoption record\n\n## Deploy\n\n- **Environments:** `staging`, `staging`\n';
    const dir = checkout({ [RECORD]: record });
    const github = fakeGitHub();
    const r = await run(dir, github, ['--yes', '--json', '--no-apps']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'error', error: expect.stringMatching(/names `staging` twice/) });
    expect(github.calls).toEqual([]);
    expect(read(dir, RECORD)).toBe(record);
  });

  it('refuses a list it would not write, by name, before any call to GitHub', async () => {
    for (const [v, why] of [['staging,,production', /comma-separated/], ['stag ing', /isn't an environment name/], ['staging,staging', /names "staging" twice/]] as const) {
      const github = fakeGitHub();
      const r = await run(checkout(), github, ['--yes', `--deploy-environments=${v}`]);
      expect(r.status, v).toBe(2);
      expect(r.err, v).toMatch(why);
      expect(github.calls).toEqual([]);
    }
  });

  it("lists the repository's environments and the workflows that reference one in the dry run's inspection", async () => {
    const wf = 'name: Ship\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: make }]\n  staging:\n    runs-on: ubuntu-latest\n    environment: staging\n    steps: [{ run: make }]\n  prod:\n    runs-on: ubuntu-latest\n    environment:\n      name: production\n      url: https://example.com\n    steps: [{ run: make }]\n';
    const dir = checkout({ '.github/workflows/ship.yml': wf });
    const d = parse(await run(dir, fakeGitHub({ environments: ['staging', 'production'] }), ['--yes', '--json', '--dry-run']));
    expect(d.inspection.environments).toEqual(['staging', 'production']);
    expect(d.inspection.deployWorkflows).toEqual([
      { workflow: '.github/workflows/ship.yml', job: 'staging', environment: 'staging' },
      { workflow: '.github/workflows/ship.yml', job: 'prod', environment: 'production' },
    ]);
    // Inspected, not declared: nothing is written for a deploy lane until the list is given.
    expect(d.answers.deployEnvironments).toEqual([]);
    expect(d.files.map((f) => f.path)).not.toContain(CALLER);
    // Null when the token can't list them.
    expect(parse(await run(checkout(), fakeGitHub(), ['--yes', '--json', '--dry-run'])).inspection.environments).toBeNull();
  });

  it("is the adopt skill's install question, recommended from the inspection, with None as an option", () => {
    const skill = read(ROOT, 'skills/adopt/SKILL.md');
    const questions = skill.slice(skill.indexOf('\n## The questions\n'), skill.indexOf('\n## Steps\n'));
    const block = questions.split(/^(?=### )/m).find((b) => b.startsWith('### `.answers.deployEnvironments`'))!;
    expect(block).toBeDefined();
    expect(block).toMatch(/^- \*\*Recommended:\*\* .*`\.inspection\.environments`.*`\.inspection\.deployWorkflows`/m);
    expect(block).toMatch(/^- \*\*Options:\*\* .*\*\*None\*\* \(`--deploy-environments none`\)/m);
  });

  it('changes the list at the terminal only through Change something, its seventh group', async () => {
    const asked: string[] = [];
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: changing('7', { "The deploy lane's environments": 'staging,production' }, asked) });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.startsWith("The deploy lane's environments"))).toHaveLength(1);
    expectChain(dir, ['staging', 'production']);
  });
});
// Plan 0010 step D8: the deploy diagnose lane is opt-in, outside every feature, and `init` writes
// its caller only when asked and only beside a deploy caller it writes, which the lane follows by
// its name on `workflow_run`, with no dispatch.
describe('kanon init and the deploy diagnose lane (plan 0010 D8)', () => {
  const LANE = 'agent-deploy-diagnose';
  const CALLER = `.github/workflows/${LANE}.yml`;
  const initWith = async (argv: string[], files: Record<string, string> = {}) => {
    const dir = checkout(files);
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', ...argv]));
    return { dir, d };
  };

  it('writes its caller when asked beside declared environments: workflow_run of the deploy caller by its name, no dispatch', async () => {
    const { dir, d } = await initWith(['--lanes', 'review,deploy-diagnose', '--deploy-environments', 'staging,production']);
    expect(d.answers.lanes).toContain(LANE);
    const wf = parseYaml(read(dir, CALLER)) as { name: string; on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { uses: string; secrets: Record<string, string>; with?: unknown }> };
    const deployName = (parseYaml(read(dir, '.github/workflows/deploy.yml')) as { name: string }).name;
    expect(wf.on).toEqual({ workflow_run: { workflows: [deployName], types: ['completed'] } });
    expect(wf.permissions).toEqual(REQ.lanes[LANE]!.grant);
    expect(wf.permissions).not.toHaveProperty('id-token');
    expect(wf.jobs.diagnose!.uses).toBe(`yedeya-labs/kanon/.github/workflows/${LANE}.yml@${PINNED}`);
    expect(wf.jobs.diagnose!.with).toBeUndefined();
    expect(Object.keys(wf.jobs.diagnose!.secrets).sort()).toEqual(['AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('is in no feature, so the full pipeline writes no caller for it', async () => {
    const { dir, d } = await initWith(['--feature', 'full', '--deploy-environments', 'staging,production']);
    expect(d.answers.lanes).not.toContain(LANE);
    expect(existsSync(join(dir, CALLER))).toBe(false);
  });

  it('is left out, with a note, when no deploy environment is declared', async () => {
    const { dir, d } = await initWith(['--lanes', 'review,deploy-diagnose']);
    expect(d.answers.lanes).toEqual(['agent-review']);
    expect(existsSync(join(dir, CALLER))).toBe(false);
    expect(d.notes.filter((n: string) => n.startsWith(DIAGNOSE_DROPPED))).toHaveLength(1);
  });

  it("is left out, with a note, where the deploy caller's path is a workflow of the project's own", async () => {
    const own = 'name: Ship\non: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./ship.sh\n';
    const { dir, d } = await initWith(['--lanes', 'review,deploy-diagnose', '--deploy-environments', 'production'], { '.github/workflows/deploy.yml': own });
    expect(read(dir, '.github/workflows/deploy.yml')).toBe(own);
    expect(existsSync(join(dir, CALLER))).toBe(false);
    expect(d.answers.lanes).toEqual(['agent-review']);
    expect(d.notes.filter((n: string) => n.startsWith(DIAGNOSE_DROPPED))).toEqual([expect.stringContaining('.github/workflows/deploy.yml is a deploy workflow of your own')]);
  });
});
