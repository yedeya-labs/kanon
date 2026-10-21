import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { callerFile } from '../../cli/callers.mjs';
import { parseArgs } from '../../cli/init.mjs';
import { telemetryCallerFile } from '../../cli/callers.mjs';
import { TELEMETRY_QUESTION } from '../../cli/init.mjs';
import { consentQuestion } from '../../cli/init.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { ROOT, hasYq, REQ, REPO, PINNED, checkout, ok, fakeGitHub, writes, run, person, changing, laneCheck, read, type Doc, parse } from './helpers/kanon-init.js';

// Its cases run `kanon init` against a real git checkout, and several run lane-check, so every
// case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// `kanon init` and the secrets and credentials a repository holds: the QA store's, the Lead's
// brief template, the Claude credential and the id-token holders. Split out of kanon-init.test.ts
// (#1204); the fixtures are in tests/unit/helpers/kanon-init.ts.

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
      `gh secret set QA_STORE_BUCKET -R ${REPO} --body '<BucketName>'`,
      `gh secret set QA_STORE_ROLE_ARN -R ${REPO} --body '<RoleArn>'`,
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
      `gh secret set QA_STORE_BUCKET -R ${REPO} --body '<BucketName>'`,
      `gh variable get QA_STORE_ROLE_ARN -R ${REPO} | gh secret set QA_STORE_ROLE_ARN -R ${REPO}`,
    ]);
    expect(store(d)!.fix.text).toContain('which you then delete once a store job has run green');
    expect(JSON.stringify(d.findings)).not.toMatch(/gh variable set QA_STORE/);
  });
});
// #749: the Lead writes each brief from docs/projects/_template.md, which an adopter copies
// unchanged from Kanon's rulebook/templates/brief.md (K-LAYOUT-11). init writes it wherever it
// writes the Lead's caller, so the full feature, and keeps one the repository has.
describe("kanon init and the Lead's brief template (#749)", () => {
  const TEMPLATE = 'docs/projects/_template.md';
  const BRIEF = read(ROOT, 'rulebook/templates/brief.md');
  const fileOf = (d: Doc) => d.files.find((f) => f.path === TEMPLATE);

  it("--feature full writes Kanon's brief template unchanged, and finds it as it wrote it on a second run", async () => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--feature', 'full']));
    expect(read(dir, TEMPLATE)).toBe(BRIEF);
    expect(fileOf(d)).toMatchObject({ status: 'new', content: BRIEF });
    const again = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--feature', 'full', '--dry-run']));
    expect(fileOf(again)).toMatchObject({ status: 'same' });
  });

  it('keeps a template the repository has', async () => {
    const mine = '# Our brief template\n';
    const dir = checkout({ [TEMPLATE]: mine });
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--feature', 'full']));
    expect(read(dir, TEMPLATE)).toBe(mine);
    expect(fileOf(d)).toMatchObject({ status: 'kept', content: null });
  });

  it("doesn't write it for the review or build feature, which call no Lead; a customised set with the Lead's lane gets it", async () => {
    for (const feature of ['review', 'build']) {
      const dir = checkout();
      const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--feature', feature]));
      expect(existsSync(join(dir, TEMPLATE)), feature).toBe(false);
      expect(fileOf(d), feature).toBeUndefined();
    }
    const dir = checkout();
    await run(dir, fakeGitHub(), ['--json', '--no-apps', '--lanes', 'review,lead']);
    expect(read(dir, TEMPLATE)).toBe(BRIEF);
  });
});
// Plan 0009 A5: the Claude credential, inferred from the repository's secret names and never
// asked, written as the one secret of the pair each caller maps, and shown on the summary's
// `Claude` line with where it came from.
describe('kanon init and the Claude credential (plan 0009 A5)', () => {
  const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
  const KEY = 'ANTHROPIC_API_KEY';
  const ALL = Object.keys(REQ.lanes).map((l) => l.slice('agent-'.length)).join(',');
  const MODEL_LANES = Object.keys(REQ.lanes).filter((l) => REQ.lanes[l]!.claude?.length);
  /** The Claude secrets a caller's job maps, by name. */
  const mapped = (text: string) => {
    const jobs = (parseYaml(text) as { jobs: Record<string, { secrets?: Record<string, string> }> }).jobs;
    return Object.values(jobs).flatMap((j) => Object.keys(j.secrets ?? {})).filter((n) => n === TOKEN || n === KEY);
  };
  const laneOf = (path: string) => path.replace(/^\.github\/workflows\/|\.yml$/g, '');
  const callers = (d: Doc) => d.files.filter((f) => /^\.github\/workflows\/agent-[a-z-]+\.yml$/.test(f.path as string));
  const claudeLine = (d: Doc) => d.summary.find((l) => l.answer === 'Claude');
  const catalogueSecrets = (d: Doc) => (d as Doc & { catalogue: Array<{ lanes: Array<{ secrets: string[] }> }> }).catalogue.flatMap((g) => g.lanes).flatMap((l) => l.secrets);

  it('has a Claude pair for every model lane, and none for a lane that runs no model', () => {
    expect(MODEL_LANES.length).toBeGreaterThan(10);
    for (const l of ['agent-merge', 'agent-lead-reconcile', 'agent-dispatch-sweep']) expect(REQ.lanes[l]!.claude, l).toBeUndefined();
    for (const l of MODEL_LANES) expect(REQ.lanes[l]!.claude, l).toEqual([TOKEN, KEY]);
  });

  it('infers api-key when the repository holds only ANTHROPIC_API_KEY, and every caller maps it alone', async () => {
    const dir = checkout({
      // What init leaves to the project, so lane-check passes every caller: the Explorer's sweep hook and the Overseer's ledger.
      '.github/actions/explore-sweep/action.yml': 'name: Sweep\ndescription: x\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: "true"\n',
      'docs/qa/capability-ledger.md': '# Capability ledger\n',
    });
    // `kanon apps`, stubbed, writes the App register that lane-check reads.
    const d = parse(await run(dir, fakeGitHub({ secrets: new Set([KEY]) }), ['--json', '--lanes', ALL, '--deploy-environments', 'staging,production']));
    expect(d.answers.claudeAuth).toBe('api-key');
    expect(claudeLine(d)).toMatchObject({ fields: ['claudeAuth'], source: 'inferred', reason: "from the repository's secrets" });
    expect(claudeLine(d)!.value).toMatch(/^API key \(ANTHROPIC_API_KEY\)/);
    expect(callers(d)).toHaveLength(Object.keys(REQ.lanes).length);
    for (const f of callers(d)) {
      const lane = laneOf(f.path as string);
      expect(mapped(read(dir, f.path as string)), lane).toEqual(MODEL_LANES.includes(lane) ? [KEY] : []);
    }
    // Nothing asks for the token, and the key is held, so no credential step is left.
    expect(d.findings.map((f) => f.id)).not.toContain('secret.claude-code-oauth-token');
    expect(d.findings.map((f) => f.id)).not.toContain('secret.anthropic-api-key');
    for (const f of d.features) {
      expect(f.secrets as string[], f.feature).toContain(KEY);
      expect(f.secrets as string[], f.feature).not.toContain(TOKEN);
    }
    expect(catalogueSecrets(d)).toContain(KEY);
    expect(catalogueSecrets(d)).not.toContain(TOKEN);
    if (hasYq) {
      const lc = laneCheck(dir);
      expect(lc.status, lc.out).toBe(0);
    }
  });

  it('defaults to subscription when the repository holds neither, and every caller maps the token alone', async () => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub({ secrets: new Set() }), ['--json', '--no-apps', '--lanes', ALL]));
    expect(d.answers.claudeAuth).toBe('subscription');
    expect(claudeLine(d)).toMatchObject({ source: 'default', reason: '' });
    expect(claudeLine(d)!.value).toMatch(/^subscription token \(CLAUDE_CODE_OAUTH_TOKEN\)/);
    for (const f of callers(d)) {
      const lane = laneOf(f.path as string);
      expect(mapped(read(dir, f.path as string)), lane).toEqual(MODEL_LANES.includes(lane) ? [TOKEN] : []);
    }
    expect(d.findings.map((f) => f.id)).toContain('secret.claude-code-oauth-token');
    expect(d.findings.map((f) => f.id)).not.toContain('secret.anthropic-api-key');
    // Secrets the token can't list say nothing, so the default stands, and says why.
    const blind = parse(await run(checkout(), fakeGitHub({ secrets: null }), ['--json', '--no-apps']));
    expect(blind.answers.claudeAuth).toBe('subscription');
    expect(claudeLine(blind)).toMatchObject({ source: 'default', reason: "the token can't list the repository's secrets" });
    const unreadable = blind.findings.find((f) => f.id === 'secret.unreadable')!;
    expect(unreadable.fix.text).toContain(TOKEN);
    expect(unreadable.fix.text).not.toContain(KEY);
  });

  it('keeps the subscription when the repository holds both, never preferring the key', async () => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub({ secrets: new Set([TOKEN, KEY]) }), ['--json', '--no-apps', '--lanes', ALL]));
    expect(d.answers.claudeAuth).toBe('subscription');
    expect(claudeLine(d)).toMatchObject({ source: 'inferred', reason: "from the repository's secrets" });
    for (const f of callers(d)) {
      const lane = laneOf(f.path as string);
      expect(mapped(read(dir, f.path as string)), lane).toEqual(MODEL_LANES.includes(lane) ? [TOKEN] : []);
    }
  });

  it('keeps the key for an installation whose callers map it, though the repository holds both (#809)', async () => {
    const dir = checkout();
    const github = fakeGitHub({ secrets: new Set([TOKEN, KEY]) });
    await run(dir, github, ['--json', '--no-apps', '--lanes', 'review', '--claude-auth', 'api-key']);
    expect(mapped(read(dir, '.github/workflows/agent-review.yml'))).toEqual([KEY]);
    // A re-run that adds a lane, with no flag: the callers say the key, so the key it stays.
    const d = parse(await run(dir, github, ['--json', '--no-apps', '--lanes', 'review,explore', '--dry-run']));
    expect(d.answers.claudeAuth).toBe('api-key');
    expect(claudeLine(d)).toMatchObject({ source: 'inferred', reason: "from the lanes' callers" });
    expect(claudeLine(d)!.value).toMatch(/^API key \(ANTHROPIC_API_KEY\)/);
    expect(d.files.find((f) => f.path === '.github/workflows/agent-review.yml')).toMatchObject({ status: 'same' });
    const added = d.files.find((f) => f.path === '.github/workflows/agent-explore.yml')!;
    expect(added).toMatchObject({ status: 'new' });
    expect(mapped(added.content as string)).toEqual([KEY]);
  });

  it('keeps the token for an installation whose callers map it, whatever the secrets say', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub({ secrets: new Set([TOKEN]) }), ['--json', '--no-apps', '--lanes', 'review']);
    const d = parse(await run(dir, fakeGitHub({ secrets: new Set([KEY]) }), ['--json', '--no-apps', '--lanes', 'review', '--dry-run']));
    expect(d.answers.claudeAuth).toBe('subscription');
    expect(claudeLine(d)).toMatchObject({ source: 'inferred', reason: "from the lanes' callers" });
    expect(d.files.find((f) => f.path === '.github/workflows/agent-review.yml')).toMatchObject({ status: 'same' });
  });

  it("reads the secrets' names when the callers map a mix, or none of the pair", async () => {
    const dir = checkout();
    const both = fakeGitHub({ secrets: new Set([TOKEN, KEY]) });
    await run(dir, both, ['--json', '--no-apps', '--lanes', 'review', '--claude-auth', 'api-key']);
    await run(dir, both, ['--json', '--no-apps', '--lanes', 'review,explore', '--claude-auth', 'subscription']);
    expect(mapped(read(dir, '.github/workflows/agent-review.yml'))).toEqual([KEY]);
    expect(mapped(read(dir, '.github/workflows/agent-explore.yml'))).toEqual([TOKEN]);
    const mix = parse(await run(dir, fakeGitHub({ secrets: new Set([KEY]) }), ['--json', '--no-apps', '--lanes', 'review,explore', '--dry-run']));
    expect(mix.answers.claudeAuth).toBe('api-key');
    expect(claudeLine(mix)).toMatchObject({ source: 'inferred', reason: "from the repository's secrets" });
    // A caller that maps neither of its pair says nothing of which one the installation runs on.
    const none = checkout();
    await run(none, both, ['--json', '--no-apps', '--lanes', 'review', '--claude-auth', 'api-key']);
    const path = join(none, '.github/workflows/agent-review.yml');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^ +ANTHROPIC_API_KEY: .*\n/m, ''));
    expect(mapped(read(none, '.github/workflows/agent-review.yml'))).toEqual([]);
    const blank = parse(await run(none, both, ['--json', '--no-apps', '--lanes', 'review', '--dry-run']));
    expect(blank.answers.claudeAuth).toBe('subscription');
    expect(claudeLine(blank)).toMatchObject({ source: 'inferred', reason: "from the repository's secrets" });
  });

  it('--claude-auth overrides the inference, and the summary line says it came from the flag', async () => {
    const dir = checkout();
    const r = await run(dir, fakeGitHub({ secrets: new Set([TOKEN]) }), ['--json', '--no-apps', '--claude-auth', 'api-key']);
    const d = parse(r);
    expect(d.answers.claudeAuth).toBe('api-key');
    expect(claudeLine(d)).toMatchObject({ source: 'flag', reason: '' });
    expect(mapped(read(dir, '.github/workflows/agent-review.yml'))).toEqual([KEY]);
    // Step R5's split (plan 0009 §9): the key is made in the Console and stored in the person's own terminal.
    const step = d.findings.find((f) => f.id === 'secret.anthropic-api-key')!;
    expect(step).toMatchObject({ category: 'secret', subject: KEY, blocking: false });
    expect(step.fix.url).toBe('https://console.anthropic.com/settings/keys');
    expect(step.fix.text).toMatch(/Claude Console, in a workspace for CI alone with its own spend limit/);
    expect(step.fix.text).toMatch(/in your own terminal/);
    expect(step.fix.commands).toEqual([`gh secret set ${KEY} -R ${REPO}   # in your own terminal, never with ! at the Claude Code prompt`]);
    expect(d.findings.map((f) => f.id)).not.toContain('secret.claude-code-oauth-token');
    // The prose summary names the line and its source too.
    expect(r.err).toMatch(/^Claude {9}API key \(ANTHROPIC_API_KEY\).* flag$/m);
    const sub = parse(await run(checkout(), fakeGitHub({ secrets: new Set([KEY]) }), ['--json', '--no-apps', '--claude-auth', 'subscription']));
    expect(sub.answers.claudeAuth).toBe('subscription');
    expect(claudeLine(sub)).toMatchObject({ source: 'flag' });
  });

  it('refuses a --claude-auth it does not know, by name, before anything changes', () => {
    expect(() => parseArgs(['--claude-auth', 'oauth'], REQ)).toThrow('--claude-auth takes subscription or api-key, not "oauth"');
    expect(() => parseArgs(['--claude-auth', 'api-key', '--claude-auth', 'api-key'], REQ)).toThrow('--claude-auth is given twice');
    expect(parseArgs(['--claude-auth=api-key'], REQ).given.claudeAuth).toBe('api-key');
  });

  it('never asks it, and Change something can change it at the terminal', async () => {
    const asked: string[] = [];
    await run(checkout(), fakeGitHub(), [], undefined, REQ, { ask: person({}, asked) });
    expect(asked.some((q) => q.includes('Claude credential'))).toBe(false);
    const changed: string[] = [];
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), [], undefined, REQ, { ask: changing('6', { 'Which Claude credential': 'Anthropic API key' }, changed) });
    expect(r.status, r.err).toBe(0);
    expect(changed.find((q) => q.startsWith('Which lines to change'))).toContain('6. Claude credential');
    expect(mapped(read(dir, '.github/workflows/agent-review.yml'))).toEqual([KEY]);
    expect(r.out).toMatch(/^Claude {9}API key .* asked$/m);
  });

  it('switches an installation by its callers alone: each differs only in its credential line', async () => {
    const dir = checkout();
    const github = fakeGitHub({ secrets: new Set([TOKEN]) });
    await run(dir, github, ['--json', '--no-apps', '--feature', 'build']);
    const d = parse(await run(dir, github, ['--json', '--no-apps', '--feature', 'build', '--claude-auth', 'api-key', '--dry-run']));
    const differs = d.files.filter((f) => f.status === 'differs');
    // The dispatch sweep runs no model, so its caller maps neither and stays as it was.
    expect(differs.map((f) => f.path).sort()).toEqual(callers(d).map((f) => f.path as string).filter((p) => MODEL_LANES.includes(laneOf(p))).sort());
    expect(d.files.find((f) => f.path === '.github/workflows/agent-dispatch-sweep.yml')).toMatchObject({ status: 'same' });
    for (const f of differs) {
      expect(f.diff, f.path as string).toEqual([`-       ${TOKEN}: \${{ secrets.${TOKEN} }}`, `+       ${KEY}: \${{ secrets.${KEY} }}`]);
      expect(mapped(f.content as string), f.path as string).toEqual([KEY]);
    }
  });

  it('maps exactly one of the pair in every caller, for either answer', () => {
    for (const auth of ['subscription', 'api-key'] as const) {
      for (const lane of Object.keys(REQ.lanes)) {
        const names = mapped(callerFile(lane, REQ.lanes[lane]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'main', claudeAuth: auth }));
        expect(names, `${lane} on ${auth}`).toEqual(MODEL_LANES.includes(lane) ? [auth === 'api-key' ? KEY : TOKEN] : []);
      }
    }
  });
});
// #631: opting in to telemetry makes every job on the default branch that holds `id-token: write`
// a possible writer to the store, and doctor blocks on each one it doesn't see accepted. Init
// names the same holders, with doctor's own check, before anything is written, says so in the
// telemetry questions, and writes the person's acceptance into the adoption record, so the
// install's pull request doesn't learn of it from doctor at the end.
describe('kanon init and the existing id-token holders (#631)', () => {
  const DEPLOY = '.github/workflows/deploy.yml';
  const deploy = 'name: Deploy\non: push\npermissions:\n  contents: read\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n      contents: read\n    steps:\n      - run: ./deploy.sh\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make lint\n';
  const WHY = 'assumes the deploy role in our cloud account';
  type HolderRow = { workflow: string; job: string; grant: string; how: string; calls: string | null; status: string; reason: string | null };
  const holdersOf = (d: Doc) => d.inspection.idTokenHolders as HolderRow[];
  const unaccepted = (d: Doc) => d.findings.filter((f) => f.id === 'id-token.unaccepted');

  it("names each holder in its dry run with doctor's own finding, and changes nothing", async () => {
    const { idTokenHolders, unacceptedHolder } = await import('../../cli/doctor.mjs');
    const dir = checkout({ [DEPLOY]: deploy });
    const github = fakeGitHub();
    const d = parse(await run(dir, github, ['--json', '--dry-run']));
    expect(d.status).toBe('steps-left');
    expect(holdersOf(d)).toEqual([{ workflow: DEPLOY, job: 'deploy', grant: 'job', how: 'id-token', calls: null, status: 'unaccepted', reason: null }]);
    // The same finding doctor gives, word for word: its subject, message and fix.
    const [holder] = idTokenHolders({ workflows: new Map([[DEPLOY, parseYaml(deploy)]]), accepted: new Map(), pinned: () => true, req: REQ });
    const same = unacceptedHolder(holder!, 'main');
    expect(unaccepted(d)).toEqual([{ id: 'id-token.unaccepted', category: 'id-token', blocking: false, subject: same.subject, message: same.message, fix: { ...same.fix, url: null } }]);
    expect(unaccepted(d)[0]!.message).toMatch(/can assume the QA store's role and the telemetry writer/);
    expect(writes(github.calls)).toEqual([]);
    expect(existsSync(join(dir, 'docs/qa/adoption.md'))).toBe(false);
    // The summary names it too, before anything is written.
    expect(d.summary.find((l) => l.fields.includes('acceptedIdTokenHolders'))).toMatchObject({ answer: 'id-token', value: expect.stringContaining('deploy.yml job deploy: narrow or accept') });
  });

  it('lists none, and finds nothing, where no job holds the grant', async () => {
    const d = parse(await run(checkout(), fakeGitHub(), ['--json', '--dry-run']));
    expect(holdersOf(d)).toEqual([]);
    expect(unaccepted(d)).toEqual([]);
    expect(d.answers.acceptedIdTokenHolders).toEqual([]);
  });

  it('writes the acceptance the person gave into the adoption record, which doctor then reads as accepted', async () => {
    const { ADOPTION_RECORD, idTokenHolders, readHolderAcceptances } = await import('../../cli/doctor.mjs');
    const dir = checkout({ [DEPLOY]: deploy });
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--consent', 'yes', '--accept-id-token-holder', `deploy.yml#deploy=${WHY}`]));
    expect(d.status, JSON.stringify(d.findings)).not.toBe('failed');
    expect(d.answers.acceptedIdTokenHolders).toEqual([{ workflow: 'deploy.yml', job: 'deploy', reason: WHY }]);
    expect(unaccepted(d)).toEqual([]);
    expect(holdersOf(d)).toEqual([expect.objectContaining({ job: 'deploy', status: 'accepted', reason: WHY })]);
    const record = read(dir, ADOPTION_RECORD);
    expect(record.split('## Choices\n\n')[1]!.split('\n\n')[0]).toContain(`- **Accepted id-token holder:** \`deploy.yml\` job \`deploy\` (${WHY})`);
    const acceptances = readHolderAcceptances(record);
    expect(acceptances.errors).toEqual([]);
    expect(idTokenHolders({ workflows: new Map([[DEPLOY, parseYaml(deploy)]]), accepted: acceptances.accepted, pinned: () => true, req: REQ }).map((h) => h.status)).toEqual(['accepted']);
    // Run again, it finds the record's acceptance, and asks for nothing more.
    const again = parse(await run(dir, fakeGitHub(), ['--json', '--dry-run', '--no-apps']));
    expect(unaccepted(again)).toEqual([]);
    expect(holdersOf(again)[0]).toMatchObject({ status: 'accepted', reason: WHY });
  });

  it("leaves an adoption record the project already has alone, and its finding's bullet carries the reason given", async () => {
    const dir = checkout({ [DEPLOY]: deploy, 'docs/qa/adoption.md': '# Adoption record\n\n## Choices\n\n- **Feature:** `review`\n' });
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--accept-id-token-holder', `deploy.yml#deploy=${WHY}`]));
    expect(d.files.find((f) => f.path === 'docs/qa/adoption.md')).toMatchObject({ status: 'kept' });
    expect(read(dir, 'docs/qa/adoption.md')).not.toContain('Accepted id-token holder');
    expect(unaccepted(d).map((f) => f.fix.commands)).toEqual([[`- **Accepted id-token holder:** \`deploy.yml\` job \`deploy\` (${WHY})`]]);
  });

  it("doesn't count a caller of Kanon's store-coupled lane or of its telemetry collector", async () => {
    const dir = checkout({ '.github/workflows/telemetry.yml': telemetryCallerFile(PINNED), '.github/workflows/agent-overseer.yml': callerFile('agent-overseer', REQ.lanes['agent-overseer']!, { release: 'v0.30.0', ciName: 'CI', defaultBranch: 'main' }) });
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--dry-run']));
    expect(holdersOf(d).map((h) => `${h.workflow} ${h.status}`).sort()).toEqual(['.github/workflows/agent-overseer.yml kanon-lane', '.github/workflows/telemetry.yml kanon-lane']);
    expect(unaccepted(d)).toEqual([]);
  });

  it('refuses an acceptance that names no holder, or is malformed or given twice, and changes nothing', async () => {
    const dir = checkout({ [DEPLOY]: deploy });
    const github = fakeGitHub();
    const none = await run(dir, github, ['--json', '--no-apps', '--accept-id-token-holder', `deploy.yml#lint=${WHY}`]);
    expect(none.status).toBe(2);
    expect(JSON.parse(none.out).error).toMatch(/deploy\.yml's job lint holds no id-token: write/);
    expect(writes(github.calls)).toEqual([]);
    expect(existsSync(join(dir, 'docs/qa/adoption.md'))).toBe(false);
    for (const v of ['deploy.yml#deploy', 'deploy#deploy=why', 'deploy.yml=why', '.github/workflows/deploy.yml#deploy=why', 'deploy.yml#deploy=  ']) {
      expect(() => parseArgs(['--accept-id-token-holder', v], REQ), v).toThrow(/--accept-id-token-holder takes <workflow>\.yml#<job>=<why it holds the grant>/);
    }
    expect(() => parseArgs(['--accept-id-token-holder', 'deploy.yml#deploy=a', '--accept-id-token-holder=deploy.yml#deploy=b'], REQ)).toThrow(/accepts deploy\.yml's job deploy twice/);
    // Two jobs, two flags: it is the one value flag that can be given more than once.
    expect(parseArgs(['--accept-id-token-holder', 'a.yml#x=one', '--accept-id-token-holder=b.yml#y=two = three'], REQ).given.acceptHolders).toEqual([
      { workflow: 'a.yml', job: 'x', reason: 'one' },
      { workflow: 'b.yml', job: 'y', reason: 'two = three' },
    ]);
  });

  it('says in both telemetry questions that the existing OIDC jobs on the default branch could then write to the store, naming them', async () => {
    // TELEMETRY_QUESTION, for every repository: a holder can write to the store once it is on.
    expect(TELEMETRY_QUESTION).toMatch(/every job on the default branch that holds id-token: write, an existing OIDC job of yours included, can write to the store/i);
    const asked: string[] = [];
    const dir = checkout({ [DEPLOY]: deploy });
    const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: async (q: string, d: string) => (asked.push(q), q.startsWith(consentQuestion(PINNED)) ? 'no' : d) });
    expect(r.status, r.err).toBe(0);
    const consent = asked.find((q) => q.startsWith(consentQuestion(PINNED)))!;
    // The consent question's own words, then a line naming the holder, then its options.
    expect(consent.split('\n')[1]).toBe('On main, a job that already holds id-token: write could then write to Kanon\'s telemetry store: deploy.yml job deploy. Narrow its grant, or accept it in docs/qa/adoption.md (kanon init lists it).');
    expect(consent.split('\n')[2]).toMatch(/^ {2}1\. Yes \(Recommended\)/);
    // Without a holder, the question is its own words alone.
    const plain: string[] = [];
    await run(checkout(), fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: async (q: string, d: string) => (plain.push(q), d) });
    expect(plain.find((q) => q.startsWith(consentQuestion(PINNED)))!.split('\n')[1]).toMatch(/^ {2}1\. Yes/);
  });
});
