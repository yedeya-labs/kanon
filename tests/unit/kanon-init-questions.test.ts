import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { callerFile } from '../../cli/callers.mjs';
import { parseArgs } from '../../cli/init.mjs';
import { TELEMETRY_CALLER_PATH } from '../../cli/callers.mjs';
import { TELEMETRY_QUESTION, UPSTREAM_EVIDENCE_QUESTION, upstreamFindingsQuestion } from '../../cli/init.mjs';
import { codeownersOf, CONSENT_LEVELS, CONSENT_OPTIONS, CONSENT_QUESTION, consentOf, consentQuestion, DATA_QUESTION, FEATURE_QUESTION, featureOf, REVIEW_HOW, sharingUrl, testDatabaseSignal } from '../../cli/init.mjs';
import { parseUpstreamFindings } from '../../scripts/lib/upstream-findings.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { ROOT, REQ, REPO, PINNED, checkout, fakeGitHub, writes, run, CONFIRM, person, changing, read, parse } from './helpers/kanon-init.js';

// Its cases run `kanon init` against a real git checkout, and several run lane-check, so every
// case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// `kanon init`'s install questions: upstream findings, and a feature, three questions and one
// summary. Split out of kanon-init.test.ts (#1204); the fixtures are in
// tests/unit/helpers/kanon-init.ts.

// Plan 0006 §3.2 (kanon#585): where upstream findings go is asked after telemetry, `drafted`
// recommended. `sent` is offered only when the telemetry answer is yes, since it travels over the
// telemetry channel, and only after it is the evidence text asked about, codes only recommended.
describe('kanon init and upstream findings (plan 0006 F2)', () => {
  const WHERE = 'Where do upstream findings go';
  const EVIDENCE = 'Also send each finding';
  const record = (dir: string) => parseUpstreamFindings(read(dir, 'docs/qa/adoption.md'));

  it('drafts them by default, writing no bullet, and leaves the evidence unasked', async () => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(d.answers).toMatchObject({ upstreamFindings: 'drafted', upstreamEvidence: null });
    expect(read(dir, 'docs/qa/adoption.md')).not.toContain('Upstream findings');
    expect(record(dir)).toBeNull();
  });

  for (const value of ['sent', 'sent-with-evidence']) {
    it(`offers no sent option without telemetry: --json --upstream-findings ${value} is refused by name, before any call to GitHub`, async () => {
      for (const argv of [['--json', '--no-apps', '--upstream-findings', value], ['--json', '--no-apps', '--no-telemetry', '--upstream-findings', value]]) {
        const github = fakeGitHub();
        const r = await run(checkout(), github, argv);
        expect(r.status, argv.join(' ')).toBe(2);
        const d = parse(r);
        expect(d.status).toBe('error');
        expect(d.error).toContain(`--upstream-findings ${value} needs --telemetry`);
        expect(github.calls).toEqual([]);
      }
    });
  }

  it.each([
    ['sent', ['--telemetry'], 'sent', false],
    ['sent-with-evidence', ['--telemetry'], 'sent with evidence', true],
    ['filed-here', [], 'filed here', null],
    ['drafted', [], 'drafted', null],
  ] as const)('writes --upstream-findings %s as the bullet the lanes read', async (flag, extra, value, evidence) => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps', ...extra, '--upstream-findings', flag]));
    expect(d.status).not.toBe('error');
    expect(d.answers).toMatchObject({ upstreamFindings: value, upstreamEvidence: evidence });
    expect(record(dir)).toBe(value === 'drafted' ? null : value);
  });

  it('refuses a value it does not take, and the flag twice', () => {
    expect(() => parseArgs(['--upstream-findings', 'filed'], REQ)).toThrow('--upstream-findings takes drafted, filed-here, sent or sent-with-evidence, not "filed"');
    expect(() => parseArgs(['--upstream-findings', 'sent with evidence'], REQ)).toThrow(/takes drafted, filed-here, sent or sent-with-evidence/);
    expect(() => parseArgs(['--upstream-findings', 'drafted', '--upstream-findings', 'drafted'], REQ)).toThrow('--upstream-findings is given twice');
    expect(parseArgs(['--upstream-findings=filed-here'], REQ).given.upstreamFindings).toBe('filed here');
  });

  it('asks without telemetry, offering no sent option, and never asks about the evidence', async () => {
    const asked: string[] = [];
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: changing('5', { 'Help improve Kanon': 'no', [WHERE]: 'sent' }, asked) });
    expect(r.status, r.err).toBe(0);
    const where = asked.filter((q) => q.startsWith(WHERE));
    expect(where).toEqual([upstreamFindingsQuestion(false)]);
    expect(where[0]).toMatch(/\(drafted\/filed-here\)$/);
    expect(where[0]).toContain('needs telemetry');
    expect(asked.indexOf(where[0]!)).toBeGreaterThan(asked.findIndex((q) => q.startsWith(TELEMETRY_QUESTION)));
    expect(asked.some((q) => q.startsWith(EVIDENCE))).toBe(false);
    // An answer it didn't offer is its default: nothing is sent on a guess.
    expect(record(dir)).toBeNull();
  });

  it('with telemetry, offers sent, then asks about the evidence, codes only by default', async () => {
    for (const [evidence, value] of [['n', 'sent'], ['y', 'sent with evidence']] as const) {
      const asked: string[] = [];
      const dir = checkout();
      const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: changing('5', { [TELEMETRY_QUESTION]: 'y', [WHERE]: 'sent', [EVIDENCE]: evidence }, asked) });
      expect(r.status, r.err).toBe(0);
      expect(asked.filter((q) => q.startsWith(WHERE))).toEqual([upstreamFindingsQuestion(true)]);
      expect(upstreamFindingsQuestion(true)).toMatch(/\(drafted\/sent\/filed-here\)$/);
      expect(asked.filter((q) => q.startsWith(EVIDENCE))).toEqual([`${UPSTREAM_EVIDENCE_QUESTION} (y/n)`]);
      expect(record(dir)).toBe(value);
    }
  });

  it('says, in the evidence question, who reads the text and that it may hold personal data (decision 14)', () => {
    expect(UPSTREAM_EVIDENCE_QUESTION.startsWith(EVIDENCE)).toBe(true);
    for (const s of ['third-party decision provider', 'TypeSafe', 'Jev', 'It may rarely still contain personal data', "Kanon's maintainer", 'never published', '13 months in Frankfurt', 'erased on request']) {
      expect(UPSTREAM_EVIDENCE_QUESTION).toContain(s);
    }
  });
});
// Plan 0007 step G5 (kanon#645): init's three questions (the feature, the Data section, one
// consent question), one summary of every value with where it came from, the confirmation, and
// the flags and JSON fields behind them, all additive within kanon-init/v1 (§6).
describe('kanon init, a feature, three questions and one summary (plan 0007 G5)', () => {
  const callers = (dir: string) => readdirSync(join(dir, '.github/workflows')).filter((f) => f.startsWith('agent-')).map((f) => f.replace(/\.yml$/, '')).sort();
  const choices = (dir: string) => read(dir, 'docs/qa/adoption.md').split('## Choices\n\n')[1]?.split('\n\n')[0]?.split('\n') ?? [];
  const featureLanes = (id: string) => REQ.features!.find((f) => f.feature === id)!.lanes;

  it('--feature review writes exactly the review lane\'s caller, and records the feature and the trigger', async () => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--feature', 'review']));
    expect(d.status).toBe('steps-left');
    expect(callers(dir)).toEqual(['agent-review']);
    expect(d.answers).toMatchObject({ feature: 'review', lanes: ['agent-review'], reviewTrigger: 'labelled' });
    expect(choices(dir)).toEqual(['- **Feature:** `review`', '- **Review trigger:** `labelled`']);
  });

  it('--feature build and full write their lanes, a conditional lane only where its condition holds', async () => {
    const build = checkout();
    const b = parse(await run(build, fakeGitHub(), ['--json', '--no-apps', '--feature', 'build']));
    expect(callers(build)).toEqual([...featureLanes('build')].sort());
    expect(b.answers.feature).toBe('build');
    expect(choices(build)).toContain('- **Feature:** `build`');
    // Full, with neither the sweep hook nor a notify hook: the two conditional lanes are left out, and
    // the summary says so; the project digest is in whatever the chat answer (plan 0011 decision 12).
    const bare = checkout();
    const f = parse(await run(bare, fakeGitHub(), ['--json', '--no-apps', '--feature', 'full']));
    expect(callers(bare)).toEqual([...featureLanes('full')].sort());
    expect(featureLanes('full')).toContain('agent-project-digest');
    expect(f.answers.feature).toBe('full');
    expect(f.features.find((x) => x.feature === 'full')!.conditional.every((c) => !c.met)).toBe(true);
    const out = f.summary.find((l) => l.answer === 'Left out')!;
    for (const lane of ['agent-explore', 'agent-weekly-digest']) expect(out.value).toContain(lane);
    expect(f.summary.find((l) => l.answer === 'Merger')!.value).toMatch(/^agent-merge is in/);
    expect(choices(bare)).toEqual(['- **Feature:** `full`', '- **Review trigger:** `labelled`', '- **Overseer:** `installed`', '- **Chat channel:** none yet']);
    // With both hooks: both are in, and the lanes still make up Full.
    const both = checkout({ '.github/actions/explore-sweep/action.yml': 'runs:\n  using: composite\n  steps: []\n', '.github/actions/notify/action.yml': read(ROOT, 'actions/notify/hooks/slack.yml') });
    const w = parse(await run(both, fakeGitHub(), ['--json', '--no-apps', '--feature', 'full']));
    expect(callers(both)).toEqual([...featureLanes('full'), 'agent-explore', 'agent-weekly-digest'].sort());
    expect(w.answers.feature).toBe('full');
    expect(w.summary.some((l) => l.answer === 'Left out')).toBe(false);
  });

  it('takes the feature the called lanes make up by default, and lanes no feature makes up as custom, with no Feature bullet', async () => {
    const lanes = featureLanes('build');
    const files = Object.fromEntries(lanes.map((l) => [`.github/workflows/${l}.yml`, callerFile(l, REQ.lanes[l]!, { release: 'v1.2.3', ciName: 'CI', defaultBranch: 'main', path: `.github/workflows/${l}.yml` })]));
    const d = parse(await run(checkout(files), fakeGitHub(), ['--json', '--no-apps', '--dry-run']));
    expect(d.answers).toMatchObject({ feature: 'build', lanes });
    expect(d.summary.find((l) => l.answer === 'Feature')).toMatchObject({ source: 'inferred', reason: 'from the lanes the repository calls' });
    const odd = { '.github/workflows/agent-implement.yml': files['.github/workflows/agent-implement.yml']! };
    const c = checkout(odd);
    const custom = parse(await run(c, fakeGitHub(), ['--json', '--no-apps']));
    expect(custom.answers).toMatchObject({ feature: 'custom', lanes: ['agent-implement'], reviewTrigger: null });
    expect(choices(c)).toEqual([]);
    expect(featureOf(['agent-review', 'agent-code-audit'], REQ.features!)).toBe('custom');
  });

  it('--consent yes writes the collector and `sent with evidence`, codes writes `sent`, and no neither', async () => {
    for (const [level, bullet] of [['yes', 'sent with evidence'], ['codes', 'sent'], ['no', null]] as const) {
      const dir = checkout();
      const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', '--consent', level]));
      expect(d.answers, level).toMatchObject({ consent: level, ...CONSENT_LEVELS[level] });
      expect(existsSync(join(dir, TELEMETRY_CALLER_PATH)), level).toBe(level !== 'no');
      expect(parseUpstreamFindings(read(dir, 'docs/qa/adoption.md')), level).toBe(bullet);
      expect(d.summary.find((l) => l.answer === 'Sharing')!.source).toBe('flag');
    }
    // Yes is `sent with evidence` whatever the feature (Owner decision 7).
    expect(parse(await run(checkout(), fakeGitHub(), ['--json', '--no-apps', '--dry-run', '--feature', 'review', '--consent', 'yes'])).answers.upstreamFindings).toBe('sent with evidence');
  });

  it('--yes alone sends nothing, declares no Data, and says so', async () => {
    const dir = checkout();
    const d = parse(await run(dir, fakeGitHub(), ['--yes', '--json', '--no-apps']));
    expect(d.answers).toMatchObject({ consent: 'no', telemetry: false, upstreamFindings: 'drafted', sensitiveData: null, reviewTrigger: 'labelled' });
    expect(existsSync(join(dir, TELEMETRY_CALLER_PATH))).toBe(false);
    expect(d.summary.find((l) => l.answer === 'Sharing')).toMatchObject({ value: 'no: nothing leaves this repo, findings drafted', source: 'default' });
    expect(d.summary.find((l) => l.answer === 'Data')).toMatchObject({ value: 'not declared (## Data)', source: 'default' });
    expect(d.notes.some((n) => n.startsWith('Whether the repository holds private or sensitive material is not declared'))).toBe(true);
  });

  it('writes the Data section from --sensitive-data and --no-sensitive-data', async () => {
    for (const [flag, value] of [['--sensitive-data', 'yes'], ['--no-sensitive-data', 'no']] as const) {
      const dir = checkout();
      const d = parse(await run(dir, fakeGitHub(), ['--json', '--no-apps', flag]));
      expect(d.answers.sensitiveData).toBe(value === 'yes');
      expect(read(dir, 'docs/qa/adoption.md')).toMatch(new RegExp(`## Data\\n\\n[^\\n]+\\n\\n- \\*\\*Private or sensitive material:\\*\\* \`${value}\`\\n$`));
    }
  });

  it('refuses, exit 2 and before any call to GitHub, what plan 0007 §6 refuses', async () => {
    const release = 'name: Release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  release:\n    uses: yedeya-labs/kanon/.github/workflows/release.yml@v1.2.3\n';
    for (const [argv, message] of [
      [['--consent', 'yes', '--telemetry'], '--consent and --telemetry contradict each other'],
      [['--consent', 'no', '--no-telemetry'], '--consent and --no-telemetry contradict each other'],
      [['--consent', 'codes', '--upstream-findings', 'filed-here'], '--consent and --upstream-findings contradict each other'],
      [['--feature', 'review', '--lanes', 'review'], '--feature and --lanes contradict each other'],
      [['--review-trigger', 'every-pr'], '--review-trigger every-pr is not built yet (plan 0007 step G7)'],
      [['--review-trigger', 'labelled', '--lanes', 'implement'], '--review-trigger is for a lane set with the review lane'],
      [['--releases', '--no-releaser'], '--releases and --no-releaser contradict each other'],
      [['--sensitive-data', '--no-sensitive-data'], '--sensitive-data and --no-sensitive-data contradict each other'],
      [['--feature', 'custom'], '--feature takes review, build or full, not "custom"'],
      [['--consent', 'maybe'], '--consent takes yes, codes or no, not "maybe"'],
      [['--releases'], "--releases is for a repository that calls Kanon's release workflow"],
    ] as const) {
      const github = fakeGitHub();
      const r = await run(checkout(), github, ['--json', '--no-apps', ...argv]);
      expect(r.status, argv.join(' ')).toBe(2);
      expect(parse(r).error, argv.join(' ')).toContain(message);
      expect(github.calls, argv.join(' ')).toEqual([]);
    }
    // The same answer by both names is no contradiction.
    const both = parse(await run(checkout({ '.github/workflows/release.yml': release }), fakeGitHub(), ['--json', '--no-apps', '--releases', '--releaser']));
    expect(both.answers.releaser).toBe(true);
    expect(parse(await run(checkout(), fakeGitHub(), ['--json', '--no-apps', '--review-trigger', 'labelled'])).answers.reviewTrigger).toBe('labelled');
  });

  it('shows every answer on a line of the summary, each naming where it came from (nothing is silent)', async () => {
    const d = parse(await run(checkout(), fakeGitHub(), ['--json', '--no-apps', '--project-owner', 'grace']));
    expect(new Set(d.summary.flatMap((l) => l.fields))).toEqual(new Set(Object.keys(d.answers)));
    for (const l of d.summary) {
      expect(['flag', 'inferred', 'default'], l.answer).toContain(l.source);
      expect(l.value, l.answer).not.toBe('');
    }
    expect(d.summary.find((l) => l.answer === 'People')).toMatchObject({ value: 'Owner, Maintainer, Stakeholder: grace', source: 'flag' });
    expect(d.summary.map((l) => l.answer).slice(0, 4)).toEqual(['Feature', 'Review', 'Data', 'Sharing']);
  });

  it('prints the summary before it writes anything, and says how to ask for a review', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--yes', '--no-apps']);
    expect(r.out).toContain(`Kanon ${PINNED} for ${REPO} (public, personal account; rulesets: yes)`);
    expect(r.out).toMatch(/^Feature {8}Review: agent-review +default$/m);
    expect(r.out).toMatch(/^Review {9}labelled: add `review:please` to a PR to get a verdict +default$/m);
    expect(r.out).toContain(REVIEW_HOW);
    expect(r.out.indexOf(REVIEW_HOW)).toBeLessThan(r.out.indexOf('== Files =='));
    expect(REVIEW_HOW).toBe('To get a review, add the label `review:please` to the pull request; the Reviewer posts its verdict once CI has finished. After a verdict, push a new commit, or remove and add the label again, to ask for another look.');
  });

  it('asks three questions at the terminal, in the plan\'s words, then the confirmation, and asks nothing else', async () => {
    const asked: string[] = [];
    const dir = checkout();
    const r = await run(dir, fakeGitHub({ private: true }), ['--no-apps'], undefined, REQ, { ask: async (q: string, d: string) => (asked.push(q), d) });
    expect(r.status, r.err).toBe(0);
    expect(asked.map((q) => q.split('\n')[0])).toEqual([FEATURE_QUESTION, DATA_QUESTION, consentQuestion(PINNED), CONFIRM]);
    expect(asked[0]).toBe([
      'What should Kanon do in this repo?',
      '  1. Review (Recommended): An AI reviewer approves or requests changes on pull requests, with one GitHub App.',
      '  2. Review + build: Also writes code from issues you label and revises it, with a second App.',
      '  3. Full pipeline: Also plans projects, merges approved work and audits the pipeline, with the same two Apps.',
      '  4. Customise: Choose lane by lane (advanced).',
      'Answer 1-4, or a name',
    ].join('\n'));
    // Yes is recommended on a private repository, and taken by Enter.
    expect(asked[1]).toContain('  1. Yes (Recommended): The record says so; the lanes still read the files and diffs they need.\n  2. No: The record says it holds none.');
    expect(asked[2]).toContain([
      `${CONSENT_QUESTION.replace('<link>', sharingUrl(PINNED))}`,
      "  1. Yes (Recommended): Run data, and scrubbed bug evidence read by Kanon's maintainer and a third-party decision provider.",
      '  2. Codes only: Run data, and Kanon bugs as codes with no text.',
      '  3. No: Nothing leaves this repo; Kanon bugs stay drafts here.',
    ].join('\n'));
    expect(asked[3]).toMatch(/^Install Kanon with these settings\?\n {2}1\. Install \(Recommended\): .+\n {2}2\. Change something: Pick a line of the summary to change\.\n {2}3\. Stop: Nothing is written\./);
    // Enter takes each recommended answer: the feature, the Data answer and Yes for sharing (Owner decision 16).
    expect(read(dir, 'docs/qa/adoption.md')).toContain('- **Private or sensitive material:** `yes`');
    expect(existsSync(join(dir, TELEMETRY_CALLER_PATH))).toBe(true);
    expect(callers(dir)).toEqual(['agent-review']);
  });

  it('takes answers by number or name, asks the lanes after Customise, and writes and changes nothing on Stop', async () => {
    const dir = checkout();
    const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: person({ [FEATURE_QUESTION]: '2', [DATA_QUESTION]: 'no', 'Help improve Kanon': 'codes' }) });
    expect(r.status, r.err).toBe(0);
    expect(callers(dir)).toEqual([...featureLanes('build')].sort());
    expect(read(dir, 'docs/qa/adoption.md')).toContain('- **Private or sensitive material:** `no`');
    expect(parseUpstreamFindings(read(dir, 'docs/qa/adoption.md'))).toBe('sent');
    const custom = checkout();
    await run(custom, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: person({ [FEATURE_QUESTION]: 'customise', 'Which lanes to install': 'review,code-audit' }) });
    expect(callers(custom)).toEqual(['agent-code-audit', 'agent-review']);
    const github = fakeGitHub();
    const stop = checkout();
    const stopped = await run(stop, github, [], undefined, REQ, { ask: person({ [CONFIRM]: 'stop' }) });
    expect(stopped.status).toBe(0);
    expect(stopped.out).toContain('Stopped: nothing was written or changed.');
    expect(existsSync(join(stop, 'docs/qa/adoption.md'))).toBe(false);
    expect(writes(github.calls)).toEqual([]);
    expect(stopped.appsCalls).toEqual([]);
  });

  // The confirmation is the last gate before anything changes: a typo there is Stop, never Install.
  it('writes and changes nothing on an answer to the confirmation it does not recognise', async () => {
    for (const typo of ['sotp', 'q', 'cancel', 'abort', '9']) {
      const github = fakeGitHub();
      const dir = checkout();
      const r = await run(dir, github, [], undefined, REQ, { ask: person({ [CONFIRM]: typo }) });
      expect(r.status, typo).toBe(0);
      expect(r.out, typo).toContain('Stopped: nothing was written or changed.');
      expect(existsSync(join(dir, 'docs/qa/adoption.md')), typo).toBe(false);
      expect(writes(github.calls), typo).toEqual([]);
      expect(r.appsCalls, typo).toEqual([]);
    }
  });

  it('shows the summary again after Change something, with the changed line asked', async () => {
    const r = await run(checkout(), fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: changing('1', { 'Who is the Owner': 'grace' }) });
    const people = r.out.split('\n').filter((l) => l.startsWith('People'));
    expect(people).toEqual([expect.stringMatching(/^People {9}Owner, Maintainer, Stakeholder: octo +inferred: the token's login$/), expect.stringMatching(/^People {9}Owner grace; Maintainer octo; Stakeholder octo +asked$/)]);
  });

  it('infers the Owner from CODEOWNERS, a test database, the delegation, and deleting the default labels before a first commit', async () => {
    const dco = 'name: DCO\non: pull_request\npermissions: {}\njobs:\n  dco:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: yedeya-labs/kanon/actions/dco@v1.2.3\n';
    const dir = checkout({ '.github/CODEOWNERS': '# owners\n*.md @docs-team/writers\n* @grace @acme/core\n', 'compose.yaml': 'services:\n  db:\n    image: postgres:16\n', '.github/workflows/dco.yml': dco });
    const d = parse(await run(dir, fakeGitHub({ hasCommits: false }), ['--json', '--no-apps', '--feature', 'build']));
    expect(d.inspection.codeowners).toEqual(['grace']);
    expect(d.answers).toMatchObject({ projectOwner: 'grace', maintainer: 'grace', testDatabase: 'hook', delegation: { name: 'Ada Lovelace', email: 'ada@example.com' }, deleteDefaultLabels: true });
    expect(d.summary.find((l) => l.answer === 'People')).toMatchObject({ source: 'inferred', reason: 'from CODEOWNERS' });
    expect(d.summary.find((l) => l.answer === 'Test database')).toMatchObject({ value: 'hook: your project-setup hook starts it', source: 'inferred', reason: 'a database service in compose.yaml' });
    expect(d.summary.find((l) => l.answer === 'Delegation')).toMatchObject({ value: 'Ada Lovelace <ada@example.com>', reason: "an Author lane and Kanon's DCO check" });
    // Review alone runs no Author lane, so no delegation; two users in CODEOWNERS make no Owner.
    const review = parse(await run(checkout({ CODEOWNERS: '* @grace @linus\n', '.github/workflows/dco.yml': dco }), fakeGitHub(), ['--json', '--no-apps', '--dry-run']));
    expect(review.answers).toMatchObject({ projectOwner: 'octo', delegation: null, testDatabase: 'none', deleteDefaultLabels: false });
    expect(review.inspection.codeowners).toEqual(['grace', 'linus']);
    expect(codeownersOf(() => null)).toBeNull();
    expect(codeownersOf((p) => (p === 'CODEOWNERS' ? '*.js @a\n' : null))).toBeNull();
    expect(testDatabaseSignal((p) => (p === '.env.example' ? 'export DATABASE_URL=postgres://x\n' : null), () => [])).toBe('DATABASE_URL in .env.example');
    expect(testDatabaseSignal(() => null, (p) => (p === 'db/migrate' ? ['001.sql'] : []))).toBe('a migrations directory, db/migrate/');
    expect(testDatabaseSignal((p) => (p === 'compose.yml' ? 'services:\n  cache:\n    image: nginx\n' : null), () => [])).toBeNull();
  });

  it('gives the features from the requirements file, with their secrets', async () => {
    const d = parse(await run(checkout(), fakeGitHub(), ['--json', '--no-apps', '--dry-run']));
    for (const f of d.features) {
      const spec = REQ.features!.find((x) => x.feature === f.feature)!;
      expect(f).toMatchObject({ title: spec.title, does: spec.does, lanes: spec.lanes, apps: spec.apps, steps: spec.steps });
      expect(f.conditional.map((c) => c.lane)).toEqual(Object.keys(spec.conditional));
    }
    expect(new Set(d.features[0]!.secrets as string[])).toEqual(new Set(['JUDGE_APP_ID', 'JUDGE_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']));
    expect(d.features[2]!.secrets).toEqual(expect.arrayContaining(['KANON_CHAT_PROJECT_DIGEST', 'KANON_CHAT_WEEKLY_DIGEST']));
    expect(d.features[2]!.secrets).not.toContain('DIGEST_WEBHOOK');
  });

  // Plan 0007 §9, Owner decision 15: the disclosure ADR 0007 and K-OBS-16 require stays in Q4.
  it('says, in the consent question itself, that the evidence may hold personal data, and who reads the evidence', () => {
    expect(CONSENT_QUESTION).toContain('may rarely hold personal data');
    expect(CONSENT_QUESTION).toContain('<link>');
    // The adopt skill asks it word for word (plan 0007 §9).
    expect(read(ROOT, 'skills/adopt/SKILL.md')).toContain(`"${CONSENT_QUESTION}"`);
    const yes = CONSENT_OPTIONS.find((o) => o.value === 'yes')!;
    expect(CONSENT_OPTIONS[0]).toBe(yes);
    expect(yes.does).toContain("scrubbed bug evidence read by Kanon's maintainer and a third-party decision provider");
    // The readers are the evidence's, never the run data's.
    expect(yes.does).toMatch(/^Run data, and scrubbed bug evidence read by/);
    // Plan 0007 §9's budgets: a question of at most 160 characters, the link not counted; labels of at most four words; consequences of at most 100 characters.
    for (const q of [FEATURE_QUESTION, DATA_QUESTION, CONSENT_QUESTION.replace('<link>', ''), CONFIRM]) expect(q.length, q).toBeLessThanOrEqual(160);
    for (const o of [...CONSENT_OPTIONS, ...REQ.features!.map((f) => ({ label: f.title, does: f.does }))]) {
      expect(o.label.split(' ').length, o.label).toBeLessThanOrEqual(4);
      expect(o.does.length, o.does).toBeLessThanOrEqual(100);
    }
    expect(consentOf(true, 'drafted')).toBeNull();
    expect(consentOf(false, 'filed here')).toBeNull();
    expect(consentOf(true, 'sent with evidence')).toBe('yes');
  });
});
