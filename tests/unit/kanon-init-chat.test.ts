import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { callerFile, TRIGGERS } from '../../cli/callers.mjs';
import { parseArgs } from '../../cli/init.mjs';
import { CHAT_QUESTION, CHAT_QUESTION_BOTH, CHAT_QUESTION_DEPLOY, CHAT_QUESTION_RELEASE, chatHookStub, legacyChatRewrite } from '../../cli/init.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { ROOT, REQ, REPO, PINNED, checkout, type State, fakeGitHub, run, person, changing, read, type Doc, parse } from './helpers/kanon-init.js';

// Its cases run `kanon init` against a real git checkout, and several run lane-check, so every
// case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// `kanon init` and the chat channel, and its re-ask. Split out of kanon-init.test.ts (#1204); the
// fixtures are in tests/unit/helpers/kanon-init.ts.

// Plan 0011 §10 (step N11): the installer's chat question, asked only when the chosen lanes post to
// a chat channel and inferred from a notify hook the repository has; what each answer writes; one
// person step per message kind; and the clean break from DIGEST_WEBHOOK (decision 17).
describe('kanon init and the chat channel (plan 0011 N11)', () => {
  const HOOK = '.github/actions/notify/action.yml';
  const SLACK_PAGE = 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks';
  const PROJECT = '.github/workflows/agent-project-digest.yml';
  const WEEKLY = '.github/workflows/agent-weekly-digest.yml';
  const NOTIFY = (REQ as unknown as { notify: { hook: { inputs: string[] } } }).notify;
  const prebuilt = (name: string) => read(ROOT, `actions/notify/hooks/${name}.yml`);
  const choices = (dir: string) => read(dir, 'docs/qa/adoption.md').split('## Choices\n\n')[1]?.split('\n\n')[0]?.split('\n') ?? [];
  const chatSteps = (d: Doc) => d.findings.filter((f) => f.id.startsWith('secret.chat-'));
  const jobSecrets = (dir: string, p: string) => Object.keys(Object.values(parseYaml(read(dir, p)).jobs as Record<string, { secrets?: Record<string, string> }>).find((j) => j.secrets)?.secrets ?? {});
  const initWith = async (argv: string[], files: Record<string, string> = {}, over: Partial<State> = {}) => {
    const dir = checkout(files);
    const r = await run(dir, fakeGitHub(over), ['--json', '--no-apps', ...argv]);
    expect(r.status, r.err).toBe(0);
    return { dir, d: parse(r) };
  };

  it('asks the question only when a chosen lane posts to a chat channel: never under Review or Review + build', async () => {
    for (const feature of ['review', 'build']) {
      const asked: string[] = [];
      const r = await run(checkout(), fakeGitHub(), ['--feature', feature, '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: person({}, asked) });
      expect(r.status, r.err).toBe(0);
      expect(asked.some((q) => q.startsWith(CHAT_QUESTION)), feature).toBe(false);
    }
    const asked: string[] = [];
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--feature', 'full', '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: person({ [CHAT_QUESTION]: 'webhook' }, asked) });
    expect(r.status, r.err).toBe(0);
    const q = asked.find((x) => x.startsWith(CHAT_QUESTION))!;
    // Its four options, Kanon's Slack hook first and recommended.
    expect(q.split('\n').slice(1, 5).map((l) => l.replace(/:.*$/, '').trim())).toEqual(["1. Kanon's Slack hook (Recommended)", "2. Kanon's generic webhook hook", '3. My own hook', '4. None']);
    expect(read(dir, HOOK)).toBe(prebuilt('webhook'));
  });

  it('is inferred from the notify hook the repository has, naming which, and not asked', async () => {
    const own = 'name: notify\ndescription: ours\ninputs:\n  message-v1: { required: true }\n  text: { required: true }\n  kind: { required: true }\n  secret: { required: true }\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: ./post.sh\n';
    for (const [file, chat, named] of [[prebuilt('slack'), 'slack', "Kanon's Slack hook"], [prebuilt('webhook'), 'webhook', "Kanon's generic webhook hook"], [own, 'hook', 'a hook of your own']] as const) {
      const asked: string[] = [];
      const dir = checkout({ [HOOK]: file });
      const r = await run(dir, fakeGitHub(), ['--feature', 'full', '--no-sensitive-data', '--consent', 'no', '--no-apps', '--dry-run'], undefined, REQ, { ask: person({}, asked) });
      expect(r.status, r.err).toBe(0);
      expect(asked.some((q) => q.startsWith(CHAT_QUESTION)), chat).toBe(false);
      const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--dry-run', '--feature', 'full']));
      expect(d.answers.chat, chat).toBe(chat);
      expect(d.inspection.notifyHook).toBe(chat === 'hook' ? 'custom' : chat);
      expect(d.summary.find((l) => l.answer === 'Chat'), chat).toMatchObject({ fields: ['chat'], source: 'inferred', reason: `from ${HOOK}, ${named}` });
      // The hook is the project's: Kanon's as init writes it, or kept, never rewritten.
      expect(read(dir, HOOK)).toBe(file);
      expect(d.files.find((f) => f.path === HOOK)?.status).toBe(chat === 'hook' ? 'kept' : 'same');
      expect(d.answers.lanes).toContain('agent-weekly-digest');
    }
  });

  it('--chat slack and --chat webhook write the prebuilt hook byte for byte, pinned at the release init runs from', async () => {
    for (const chat of ['slack', 'webhook']) {
      const { dir, d } = await initWith(['--feature', 'full', '--chat', chat]);
      expect(read(dir, HOOK), chat).toBe(prebuilt(chat));
      expect(read(dir, HOOK)).toMatch(new RegExp(`^ {4}- uses: yedeya-labs/kanon/actions/notify/${chat}@${PINNED.replace(/\./g, '\\.')} `, 'm'));
      expect(d.files.find((f) => f.path === HOOK)).toMatchObject({ status: 'new', content: prebuilt(chat) });
      expect(d.answers).toMatchObject({ chat, feature: 'full' });
      // A hook is written, so the weekly digest is in, and the lanes still make up Full.
      expect(existsSync(join(dir, WEEKLY))).toBe(true);
      expect(d.summary.find((l) => l.answer === 'Chat')).toMatchObject({ source: 'flag' });
    }
  });

  it('--chat hook writes a stub that exits non-zero, naming its file, and that is a hook the notify job can call', async () => {
    const { dir, d } = await initWith(['--feature', 'full', '--chat', 'hook']);
    const stub = read(dir, HOOK);
    expect(stub).toBe(chatHookStub(NOTIFY.hook.inputs));
    const doc = parseYaml(stub) as { runs: { using: string; steps: Array<{ shell: string; run: string }> }; inputs: Record<string, unknown> };
    expect(doc.runs.using).toBe('composite');
    expect(Object.keys(doc.inputs).sort()).toEqual([...NOTIFY.hook.inputs].sort());
    const step = spawnSync('bash', ['-c', doc.runs.steps[0]!.run], { encoding: 'utf8' });
    expect(step.status).not.toBe(0);
    expect(step.stdout).toContain(`::error file=${HOOK}::${HOOK} is the stub kanon init wrote`);
    expect(d.answers.chat).toBe('hook');
    expect(existsSync(join(dir, WEEKLY))).toBe(true);
    expect(d.summary.find((l) => l.answer === 'Your steps')!.value).toContain('fill the notify hook');
  });

  it('--chat none writes no hook, and installs the project digest and not the weekly one', async () => {
    const { dir, d } = await initWith(['--feature', 'full', '--chat', 'none']);
    expect(existsSync(join(dir, HOOK))).toBe(false);
    expect(d.files.some((f) => f.path === HOOK)).toBe(false);
    expect(existsSync(join(dir, PROJECT))).toBe(true);
    expect(existsSync(join(dir, WEEKLY))).toBe(false);
    expect(d.answers).toMatchObject({ chat: 'none', feature: 'full' });
    // The project digest's caller maps its kind's secret anyway, so a hook added later needs no change.
    expect(jobSecrets(dir, PROJECT)).toContain('KANON_CHAT_PROJECT_DIGEST');
    expect(chatSteps(d)).toEqual([]);
    // Under --yes, with no hook and no flag, none: only an explicit answer writes a hook.
    const y = await initWith(['--feature', 'full']);
    expect(y.d.answers.chat).toBe('none');
    expect(y.d.summary.find((l) => l.answer === 'Chat')).toMatchObject({ source: 'default' });
    expect(existsSync(join(y.dir, HOOK))).toBe(false);
    // A weekly digest named by --lanes stays, since the person chose it by name.
    const named = await initWith(['--lanes', 'review,weekly-digest', '--chat', 'none']);
    expect(named.d.answers.lanes).toEqual(['agent-review', 'agent-weekly-digest']);
  });

  it("has each notifying caller map its own kind's secret, and none map DIGEST_WEBHOOK", async () => {
    const { dir } = await initWith(['--feature', 'full', '--chat', 'slack']);
    expect(jobSecrets(dir, PROJECT)).toContain('KANON_CHAT_PROJECT_DIGEST');
    expect(jobSecrets(dir, PROJECT)).not.toContain('KANON_CHAT_WEEKLY_DIGEST');
    expect(jobSecrets(dir, WEEKLY)).toContain('KANON_CHAT_WEEKLY_DIGEST');
    expect(jobSecrets(dir, WEEKLY)).not.toContain('KANON_CHAT_PROJECT_DIGEST');
    for (const f of readdirSync(join(dir, '.github/workflows'))) expect(read(dir, `.github/workflows/${f}`), f).not.toContain('DIGEST_WEBHOOK');
  });

  it("leaves one person step per kind, worded for the answer, the Slack ones linking Slack's page", async () => {
    const steps = async (chat: string, over: Partial<State> = {}) => chatSteps((await initWith(['--feature', 'full', '--chat', chat], {}, over)).d);
    const slack = await steps('slack');
    expect(slack.map((f) => [f.id, f.subject])).toEqual([['secret.chat-project-digest', 'KANON_CHAT_PROJECT_DIGEST'], ['secret.chat-weekly-digest', 'KANON_CHAT_WEEKLY_DIGEST']]);
    for (const f of slack) {
      expect(f.fix.url).toBe(SLACK_PAGE);
      expect(f.fix.text).toMatch(/^Create a Slack incoming webhook for the channel the (daily project|weekly) digest posts to/);
      expect(f.fix.text).toMatch(/in your own terminal/);
      expect(f.fix.text).toMatch(/never with `!` at the Claude Code prompt/);
      expect(f.fix.text).toMatch(/The same value may go in each kind's secret/);
      expect(f.fix.commands).toEqual([`gh secret set ${f.subject} -R ${REPO}   # in your own terminal, never with ! at the Claude Code prompt`]);
      expect(f.category).toBe('secret');
      expect(f.blocking).toBe(false);
    }
    for (const f of await steps('webhook')) {
      expect(f.fix.url).toBe(`https://github.com/yedeya-labs/kanon/blob/${PINNED}/docs/notifications.md#kanons-generic-webhook-hook`);
      expect(f.fix.text).toMatch(/^Store the https URL your receiver takes the/);
    }
    for (const f of await steps('hook')) {
      expect(f.fix.url).toBe(`https://github.com/${REPO}/settings/secrets/actions`);
      expect(f.fix.text).toMatch(/whatever your own hook at \.github\/actions\/notify\/action\.yml needs/);
    }
    // A kind whose secret the repository holds asks for nothing.
    expect((await steps('slack', { secrets: new Set(['KANON_CHAT_PROJECT_DIGEST']) })).map((f) => f.id)).toEqual(['secret.chat-weekly-digest']);
    expect(read(ROOT, 'docs/notifications.md')).toMatch(/^## Kanon's generic webhook hook$/m);
  });

  // Plan 0011 N9's installer half (§10.2's last line): the deploy lane announces each deploy with
  // KANON_CHAT_DEPLOY, which its caller maps whatever the answer, and whose step comes with the lane.
  it('maps KANON_CHAT_DEPLOY into each deploy job, with or without a hook, and never into the release job', async () => {
    const DEPLOY = '.github/workflows/deploy.yml';
    const LINE = '${{ secrets.KANON_CHAT_DEPLOY }}';
    const HOOK_SECRET = { KANON_DEPLOY_SECRET: '${{ secrets.KANON_DEPLOY_SECRET }}' };
    for (const chat of ['slack', 'none']) {
      const { dir } = await initWith(['--feature', 'full', '--chat', chat, '--deploy-environments', 'staging,production']);
      const jobs = (parseYaml(read(dir, DEPLOY)) as { jobs: Record<string, { secrets?: Record<string, string> }> }).jobs;
      expect(jobs.release!.secrets, chat).toBeUndefined();
      expect(jobs['deploy-1']!.secrets, chat).toEqual({ KANON_CHAT_DEPLOY: LINE, ...HOOK_SECRET });
      expect(jobs['deploy-2']!.secrets, chat).toEqual({ KANON_CHAT_DEPLOY: LINE, ...HOOK_SECRET });
    }
    // The topic doc says so, and nowhere that the mapping is the adopter's to add (kanon#1266).
    const doc = read(ROOT, 'docs/notifications.md');
    expect(doc).toContain('`kanon init` writes that mapping into every `deploy-<position>` job whatever its chat answer');
    expect(doc).not.toMatch(/doesn't map `KANON_CHAT_DEPLOY`|add the mapping by hand/);
  });

  it('leaves secret.chat-deploy only with a declared deploy environment and an answer that writes a hook', async () => {
    const deploy = (d: Doc) => chatSteps(d).filter((f) => f.id === 'secret.chat-deploy');
    const envs = ['--deploy-environments', 'staging,production'];
    const [slack] = deploy((await initWith(['--feature', 'full', '--chat', 'slack', ...envs])).d);
    expect(slack).toMatchObject({ id: 'secret.chat-deploy', subject: 'KANON_CHAT_DEPLOY', category: 'secret', blocking: false });
    expect(slack!.fix.url).toBe(SLACK_PAGE);
    expect(slack!.fix.text).toMatch(/^Create a Slack incoming webhook for the channel the deploy announcement posts to/);
    expect(slack!.fix.commands).toEqual([`gh secret set KANON_CHAT_DEPLOY -R ${REPO}   # in your own terminal, never with ! at the Claude Code prompt`]);
    expect(slack!.message).toContain("which the deploy lane's caller, .github/workflows/deploy.yml, maps");
    const [webhook] = deploy((await initWith(['--feature', 'full', '--chat', 'webhook', ...envs])).d);
    expect(webhook!.fix.url).toBe(`https://github.com/yedeya-labs/kanon/blob/${PINNED}/docs/notifications.md#kanons-generic-webhook-hook`);
    expect(webhook!.fix.text).toMatch(/^Store the https URL your receiver takes the deploy announcement at/);
    // The deploy lane alone asks the question: Review with environments takes --chat, and its step follows.
    const review = await initWith(['--feature', 'review', '--chat', 'slack', ...envs]);
    expect(review.d.answers.chat).toBe('slack');
    expect(chatSteps(review.d).map((f) => f.id)).toEqual(['secret.chat-deploy']);
    // Not without an environment, nor with none for the answer, nor once the repository holds it.
    expect(deploy((await initWith(['--feature', 'full', '--chat', 'slack'])).d)).toEqual([]);
    expect(deploy((await initWith(['--feature', 'full', '--chat', 'none', ...envs])).d)).toEqual([]);
    expect(deploy((await initWith(['--feature', 'full', '--chat', 'slack', ...envs], {}, { secrets: new Set(['KANON_CHAT_DEPLOY']) })).d)).toEqual([]);
    expect(() => parseArgs(['--feature', 'review', '--chat', 'slack', '--deploy-environments', 'none'], REQ)).toThrow(/--feature review has none/);
  });

  it('words the question for what posts: the digests, the deploy announcements, or both, in two sentences', async () => {
    const question = async (argv: string[], files: Record<string, string> = {}) => {
      const asked: string[] = [];
      const r = await run(checkout(files), fakeGitHub(), [...argv, '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: person({}, asked) });
      expect(r.status, r.err).toBe(0);
      return asked.filter((q) => /^Post .* to a chat channel\?/.test(q)).map((q) => q.split('\n')[0]);
    };
    expect(await question(['--feature', 'full'])).toEqual([CHAT_QUESTION]);
    expect(await question(['--feature', 'review', '--deploy-environments', 'production'])).toEqual([CHAT_QUESTION_DEPLOY]);
    expect(await question(['--feature', 'full', '--deploy-environments', 'staging,production'])).toEqual([CHAT_QUESTION_BOTH]);
    for (const q of [CHAT_QUESTION, CHAT_QUESTION_DEPLOY, CHAT_QUESTION_BOTH]) expect(q.split('? ')[1]).toBe('Kanon ships a Slack hook and a generic webhook hook, or you can write your own.');
  });

  // kanon#1190: the release announcement posts too, so choosing it asks the question, named as
  // what it posts, and the Slack answer leaves the step for its kind's secret.
  it('counts the release announcement as a lane that posts, names it in the question, and leaves secret.chat-release (kanon#1190)', async () => {
    const question = async (argv: string[]) => {
      const asked: string[] = [];
      const r = await run(checkout(), fakeGitHub(), [...argv, '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: person({}, asked) });
      expect(r.status, r.err).toBe(0);
      return asked.filter((q) => /^Post .* to a chat channel\?/.test(q)).map((q) => q.split('\n')[0]);
    };
    const tail = ' to a chat channel? Kanon ships a Slack hook and a generic webhook hook, or you can write your own.';
    expect(await question(['--lanes', 'review,release-announce'])).toEqual([CHAT_QUESTION_RELEASE]);
    expect(await question(['--lanes', 'review,project-digest,release-announce'])).toEqual([`Post digests and release announcements${tail}`]);
    expect(await question(['--lanes', 'review,project-digest,release-announce', '--deploy-environments', 'production'])).toEqual([`Post digests, release announcements and deploy announcements${tail}`]);
    expect(await question(['--lanes', 'review,release-announce', '--deploy-environments', 'production'])).toEqual([`Post release announcements and deploy announcements${tail}`]);
    // The question's three constants are what it builds for their cases.
    expect(await question(['--lanes', 'review,project-digest'])).toEqual([CHAT_QUESTION]);
    const { dir, d } = await initWith(['--lanes', 'review,release-announce', '--chat', 'slack']);
    expect(d.answers.chat).toBe('slack');
    expect(chatSteps(d).map((f) => [f.id, f.subject])).toEqual([['secret.chat-release', 'KANON_CHAT_RELEASE']]);
    expect(chatSteps(d)[0]!.fix.url).toBe(SLACK_PAGE);
    expect(chatSteps(d)[0]!.fix.text).toMatch(/^Create a Slack incoming webhook for the channel the release announcement posts to/);
    // Its caller: a published release and a dispatch with the tag, and its one kind's secret.
    const caller = parseYaml(read(dir, '.github/workflows/agent-release-announce.yml')) as { on: Record<string, unknown>; jobs: Record<string, { uses: string; with: Record<string, string>; secrets: Record<string, string> }> };
    expect(caller.on.release).toEqual({ types: ['published'] });
    expect(Object.keys(caller.on)).toEqual(['release', 'workflow_dispatch']);
    expect(caller.jobs.announce!.with).toEqual({ tag: '${{ inputs.tag }}', dry_run: '${{ inputs.dry_run }}' });
    expect(caller.jobs.announce!.secrets).toEqual({ KANON_CHAT_RELEASE: '${{ secrets.KANON_CHAT_RELEASE }}' });
  });

  it("accepts --chat beside a deploy lane the adoption record's ## Deploy section declares, with no --deploy-environments", async () => {
    const record = (await initWith(['--feature', 'review', '--deploy-environments', 'staging,production'])).dir;
    const files = { 'docs/qa/adoption.md': read(record, 'docs/qa/adoption.md') };
    const { d } = await initWith(['--feature', 'review', '--chat', 'slack'], files);
    expect(d.answers.deployEnvironments).toEqual(['staging', 'production']);
    expect(d.answers.chat).toBe('slack');
    expect(chatSteps(d).map((f) => f.id)).toEqual(['secret.chat-deploy']);
    // Without the record's declaration it is still no answer.
    const r = await run(checkout(), fakeGitHub(), ['--json', '--no-apps', '--feature', 'review', '--chat', 'slack']);
    expect(r.status).toBe(2);
  });

  it("asks nothing for deploy announcements where deploy.yml is the project's own workflow, so init writes no deploy caller", async () => {
    const own = 'name: Ship\non: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n';
    const files = { '.github/workflows/deploy.yml': own };
    const asked: string[] = [];
    const r = await run(checkout(files), fakeGitHub(), ['--feature', 'review', '--deploy-environments', 'production', '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: person({}, asked) });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => /^Post .* to a chat channel\?/.test(q))).toEqual([]);
    // Under the Full pipeline it is the digests' question alone.
    const full: string[] = [];
    expect((await run(checkout(files), fakeGitHub(), ['--feature', 'full', '--deploy-environments', 'production', '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: person({}, full) })).status).toBe(0);
    expect(full.filter((q) => /^Post .* to a chat channel\?/.test(q)).map((q) => q.split('\n')[0])).toEqual([CHAT_QUESTION]);
    // Nor through Change something's deploy group.
    const changed: string[] = [];
    expect((await run(checkout(files), fakeGitHub(), ['--feature', 'review', '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: changing('7', { "The deploy lane's environments": 'production' }, changed) })).status).toBe(0);
    expect(changed.filter((q) => /^Post .* to a chat channel\?/.test(q))).toEqual([]);
    // And with --yes the answer is no chat at all.
    const { d } = await initWith(['--feature', 'review', '--deploy-environments', 'production'], files);
    expect(d.answers.chat).toBeNull();
  });

  it('asks the chat question when deploy environments are declared through Change something, under Review', async () => {
    const dir = checkout();
    const asked: string[] = [];
    const r = await run(dir, fakeGitHub(), ['--feature', 'review', '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: changing('7', { "The deploy lane's environments": 'production', [CHAT_QUESTION_DEPLOY]: 'webhook' }, asked) });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.startsWith(CHAT_QUESTION_DEPLOY))).toHaveLength(1);
    expect(read(dir, HOOK)).toBe(prebuilt('webhook'));
  });

  it("writes the adoption record's Chat channel bullet for each answer, and none without a notifying lane", async () => {
    const want: Record<string, string> = {
      slack: "- **Chat channel:** Slack, through Kanon's Slack hook (one secret per kind)",
      webhook: "- **Chat channel:** a JSON webhook, through Kanon's generic webhook hook",
      hook: '- **Chat channel:** our own hook, .github/actions/notify',
      none: '- **Chat channel:** none yet',
    };
    for (const [chat, bullet] of Object.entries(want)) {
      const { dir } = await initWith(['--feature', 'full', '--chat', chat]);
      expect(choices(dir).filter((l) => l.startsWith('- **Chat channel:**')), chat).toEqual([bullet]);
    }
    const { dir, d } = await initWith(['--feature', 'build']);
    expect(d.answers.chat).toBeNull();
    expect(choices(dir).some((l) => l.startsWith('- **Chat channel:**'))).toBe(false);
  });

  it('refuses --chat with lanes that post to no chat channel, and a value it does not take', () => {
    expect(() => parseArgs(['--chat', 'teams'], REQ)).toThrow('--chat takes slack, webhook, hook or none, not "teams"');
    expect(() => parseArgs(['--feature', 'review', '--chat', 'slack'], REQ)).toThrow(/--chat is for lanes that post to a chat channel .*--feature review has none/);
    expect(() => parseArgs(['--lanes', 'review,implement', '--chat', 'none'], REQ)).toThrow(/--lanes review,implement has none/);
    expect(parseArgs(['--feature', 'full', '--chat', 'webhook'], REQ).given.chat).toBe('webhook');
  });

  it('changes the answer through Change something, the weekly digest following it', async () => {
    const dir = checkout();
    const asked: string[] = [];
    const r = await run(dir, fakeGitHub(), ['--feature', 'full', '--chat', 'none', '--no-sensitive-data', '--consent', 'no', '--no-apps'], undefined, REQ, { ask: changing('8', { [CHAT_QUESTION]: 'slack' }, asked) });
    expect(r.status, r.err).toBe(0);
    expect(asked.filter((q) => q.startsWith(CHAT_QUESTION))).toHaveLength(1);
    expect(read(dir, HOOK)).toBe(prebuilt('slack'));
    expect(existsSync(join(dir, WEEKLY))).toBe(true);
  });

  // Decision 17: no lane takes DIGEST_WEBHOOK, and GitHub refuses a caller that still maps it.
  it("rewrites the secrets: of a digest's caller at this release that maps DIGEST_WEBHOOK, and says what to do with one at another", async () => {
    const caller = (release: string) => callerFile('agent-project-digest', REQ.lanes['agent-project-digest']!, { release, ciName: 'CI', defaultBranch: 'main', path: PROJECT });
    const legacy = (release: string) => caller(release).replace('KANON_CHAT_PROJECT_DIGEST: ${{ secrets.KANON_CHAT_PROJECT_DIGEST }}', 'DIGEST_WEBHOOK: ${{ secrets.DIGEST_WEBHOOK }}');
    expect(legacy(PINNED)).toContain('DIGEST_WEBHOOK');
    const here = await initWith(['--feature', 'full', '--dry-run'], { [PROJECT]: legacy(PINNED) });
    const file = here.d.files.find((f) => f.path === PROJECT)!;
    expect(file.status).toBe('rewritten');
    expect(file.content).toBe(caller(PINNED));
    expect(file.diff).toEqual(['-       DIGEST_WEBHOOK: ${{ secrets.DIGEST_WEBHOOK }}', '+       KANON_CHAT_PROJECT_DIGEST: ${{ secrets.KANON_CHAT_PROJECT_DIGEST }}']);
    expect(here.d.summary.find((l) => l.answer === 'Chat')!.value).toMatch(/still maps DIGEST_WEBHOOK, which no lane takes: posts resume only once a hook exists and the kind secrets are stored/);
    // The chat answer isn't inferred from the old secret: with no hook it is none.
    expect(here.d.answers.chat).toBe('none');
    const old = await initWith(['--feature', 'full', '--dry-run'], { [PROJECT]: legacy('v0.39.0') });
    expect(old.d.files.find((f) => f.path === PROJECT)!.status).toBe('differs');
    expect(old.d.notes).toContainEqual(expect.stringMatching(/^\.github\/workflows\/agent-project-digest\.yml maps DIGEST_WEBHOOK.*the upgrade skill rewrites its secrets: in the same edit/));
    expect(legacyChatRewrite(legacy('v0.39.0'), 'agent-project-digest', REQ, PINNED)).toBeNull();
    expect(legacyChatRewrite(legacy(PINNED), 'agent-review', REQ, PINNED)).toBeNull();
  });
});
// kanon#1023: the re-ask names each covered caller by the name it has in the repository, as the
// `ci` trigger names the adopter's CI, and by its template's name only where init writes it.
describe("kanon init's re-ask names the covered callers the repository has (#1023)", () => {
  const SWEEP = '.github/workflows/agent-dispatch-sweep.yml';
  const IMPLEMENT = '.github/workflows/agent-implement.yml';
  const reask = (dir: string) => (parseYaml(read(dir, SWEEP)) as { on: { workflow_run: { workflows: string[] } } }).on.workflow_run.workflows;
  const implementCaller = (name: string) => callerFile('agent-implement', REQ.lanes['agent-implement']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' }).replace(/^name: .*$/m, `name: ${name}`);
  const lanes = ['--yes', '--json', '--no-apps', '--lanes', 'review,implement,dispatch-sweep'];

  it('names an existing caller by its own name:, and a lane with no caller yet by its template name', async () => {
    const dir = checkout({ [IMPLEMENT]: implementCaller('Implement') });
    const r = await run(dir, fakeGitHub(), lanes);
    expect(r.status, r.err).toBe(0);
    expect(reask(dir)).toEqual(['Implement', TRIGGERS['agent-triage']!.name]);
    // The implement caller is the project's: init never overwrites it.
    expect(read(dir, IMPLEMENT)).toBe(implementCaller('Implement'));
    // A quoted name with a comment, as GitHub reads it.
    const quoted = checkout({ [IMPLEMENT]: implementCaller('"Implement: ours" # renamed') });
    expect((await run(quoted, fakeGitHub(), lanes)).status).toBe(0);
    expect(reask(quoted)).toEqual(['Implement: ours', TRIGGERS['agent-triage']!.name]);
  });

  it('keeps the template names where no covered caller exists, and ignores a file at the path that calls no lane', async () => {
    const dir = checkout({ [IMPLEMENT]: 'name: Something else\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' });
    expect((await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', '--lanes', 'review,dispatch-sweep'])).status).toBe(0);
    expect(reask(dir)).toEqual([TRIGGERS['agent-implement']!.name, TRIGGERS['agent-triage']!.name]);
  });
});
