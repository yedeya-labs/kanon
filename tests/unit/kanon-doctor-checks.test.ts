import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appSecrets, callerFile, ciFile, hookFile } from '../../cli/callers.mjs';
import { rulesetBody } from '../../cli/init.mjs';
import { branchPattern, branchWorkflows, checkJobs, checkReporters, doctor, EXIT, parseArgs, SCHEMA, startsOnMerge, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { checkout, fakeGitHub, healthyFiles, identitiesOf, ids, LANES, no, ok, PINNED, registerText, REPO, REQ, run, scratch, type Gh, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon doctor` on what an installation lacks, and on the job behind a required check (#418, #446,
 * #452, #459).
 *
 * Split out of kanon-doctor.test.ts, which holds the plan's falsifiable checks and the JSON contract,
 * so the doctor's cases run in parallel (#436). The fixtures are in helpers/doctor.ts.
 */
// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

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

// #459: a ruleset with a merge queue waits for each required check on the queue's merge_group run,
// so the job behind the check must run on that event too.
describe('kanon doctor and the job behind a required check, through a merge queue (#459)', () => {
  const queued = (github: ReturnType<typeof fakeGitHub>) => {
    github.st.rulesets = [{ id: 7, ...rulesetBody(true) }];
  };
  const noQueueEvent = (text: string) => text.replace('  merge_group:\n', '');

  it("doesn't count a job whose workflow doesn't run on merge_group, and names the job and the trigger", async () => {
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = noQueueEvent(files['.github/workflows/ci.yml']!);
    const dir = checkout(files);
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    const f = r.json.findings[0];
    expect(f.message).toBe('The ruleset on main requires the status check "Lane check", but no job of a workflow on main reports it on every pull request and every queued merge, so every one that doesn\'t get it waits on it (K-ADOPT-1 step 8). .github/workflows/ci.yml#lanes doesn\'t run on merge_group, the event the merge queue on main runs its checks on, so a queued merge never gets the check and waits on it.');
    expect(f.fix.text).toMatch(/^Run the job on every pull request and every queued merge: add merge_group to the triggers of \.github\/workflows\/ci\.yml, or move the job to a workflow of its own on pull_request and merge_group with no filter/);
  });

  it('says the checkout adds merge_group when its workflow runs on it', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.check-unreported Lane check']);
    expect(r.json.findings[0].fix.text).toContain('This checkout adds it (.github/workflows/ci.yml#lanes): merge the pull request that adds it to main first.');
  });

  it("names a merge_group filter that skips the default branch, and a job of its own when none reports it", async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': ciFile(PINNED, 'main').replace('  merge_group:\n', '  merge_group:\n    branches: [release]\n') };
    const r = await run(dir, github, ['--json']);
    expect(r.json.findings[0].message).toContain('The job there that reports it (.github/workflows/ci.yml#lanes) runs on some runs only (merge_group.branches), and a run it skips never gets the check.');
    github.st.defaultWorkflows = {};
    const none = await run(checkout({ ...healthyFiles(), '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: "true"\n' }), github, ['--json']);
    expect(none.json.findings.find((x: { id: string }) => x.id === 'ruleset.check-unreported').fix.text).toMatch(/^Add a job of its own named "Lane check", in a workflow that runs on pull_request and merge_group,/);
  });

  it('is healthy when the job runs on merge_group, and asks nothing of it without a merge queue', async () => {
    const github = fakeGitHub();
    queued(github);
    expect(ids(await run(checkout(healthyFiles()), github, ['--json']))).toEqual([]);
    const files = healthyFiles();
    files['.github/workflows/ci.yml'] = noQueueEvent(files['.github/workflows/ci.yml']!);
    const plain = fakeGitHub();
    plain.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    expect(ids(await run(checkout(files), plain, ['--json']))).toEqual([]);
  });

  it('is waived like any other finding', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += `- **${WAIVER_LABEL}:** \`ruleset.check-unreported\` on \`Lane check\` (the queue's checks run elsewhere)\n`;
    const github = fakeGitHub();
    queued(github);
    github.st.defaultWorkflows = { 'ci.yml': noQueueEvent(ciFile(PINNED, 'main')) };
    const r = await run(checkout(files), github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['ruleset.check-unreported']);
  });
});

// #452 (#79): a merge through a merge queue doesn't start a lane on CI finishing on the default
// branch, so doctor notes it, in the catalogue's words, for a lane the repository calls. It blocks
// nothing. #484: the rebase lane's caller starts it on the merged pull request instead, so doctor
// notes a rebase caller without that trigger, which an upgrade of the pin alone doesn't add.
describe('kanon doctor and a lane a merge queue changes (#452, #484)', () => {
  const rebaseCaller = callerFile('agent-rebase', REQ.lanes['agent-rebase']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
  // A caller written before #484: the same, without the merged-pull-request trigger.
  const before484 = rebaseCaller.replace(/ {2}# A merged pull request[^\n]*\n[^\n]*\n {2}pull_request_target:\n {4}types: \[closed\]\n {4}branches: \[main\]\n/, '');
  const withRebase = (text = rebaseCaller) => ({ ...healthyFiles(), '.github/workflows/agent-rebase.yml': text });
  const withMerge = () => ({ ...healthyFiles(), '.github/workflows/agent-merge.yml': callerFile('agent-merge', REQ.lanes['agent-merge']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' }) });
  const noteOf = (r: Result) => (r.json.notes as string[]).filter((n) => n.includes('merges through a merge queue'));
  const queued = () => {
    const github = fakeGitHub();
    github.st.rulesets = [{ id: 7, ...rulesetBody(true) }];
    return github;
  };

  it('notes a called lane that a merge through the queue does not start, and nothing else changes', async () => {
    const r = await run(checkout(withMerge()), queued(), ['--json']);
    expect(noteOf(r)).toEqual([`main merges through a merge queue, and you call agent-merge. ${REQ.catalogue!.lanes['agent-merge']!.mergeQueue}`]);
    expect(r.json.findings.filter((f: { blocking: boolean }) => f.blocking).map((f: { id: string }) => f.id)).not.toContain('ruleset.check-unreported');
  });

  it("notes nothing for the rebase caller kanon init writes, which a merge through the queue starts", async () => {
    expect(before484).not.toBe(rebaseCaller);
    expect(before484).not.toContain('pull_request_target');
    expect(noteOf(await run(checkout(withRebase()), queued(), ['--json']))).toEqual([]);
  });

  it('notes a rebase caller without the merged-pull-request trigger, by file, with what to add', async () => {
    const notes = noteOf(await run(checkout(withRebase(before484)), queued(), ['--json']));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('.github/workflows/agent-rebase.yml calls agent-rebase without a trigger on a merged pull request');
    expect(notes[0]).toContain('`pull_request_target: { types: [closed], branches: [main] }`');
  });

  it('notes nothing without a merge queue, or for a lane the repository does not call', async () => {
    expect(noteOf(await run(checkout(withMerge()), fakeGitHub(), ['--json']))).toEqual([]);
    expect(noteOf(await run(checkout(withRebase(before484)), fakeGitHub(), ['--json']))).toEqual([]);
    expect(noteOf(await run(checkout(healthyFiles()), queued(), ['--json']))).toEqual([]);
  });
});

describe('startsOnMerge: whether a caller runs on a pull request closed on the branch (#484)', () => {
  const wf = (on: unknown) => ({ on });
  it('needs `closed` in the types, which the default types lack', () => {
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], branches: ['main'] } }), 'main')).toBe(true);
    expect(startsOnMerge(wf({ pull_request_target: { types: 'closed' } }), 'main')).toBe(true);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['opened', 'labeled'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request_target: null }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request: { types: ['closed'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf('pull_request_target'), 'main')).toBe(false);
    expect(startsOnMerge(wf(['pull_request_target']), 'main')).toBe(false);
  });
  it('and a branch filter that admits the branch', () => {
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], branches: ['trunk'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], branches: ['releases/**'] } }), 'main')).toBe(true);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], 'branches-ignore': ['main'] } }), 'main')).toBe(false);
    expect(startsOnMerge(wf({ pull_request_target: { types: ['closed'], 'branches-ignore': ['other'] } }), 'main')).toBe(true);
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
