import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ciFile, DEPENDABOT_ENTRY, loadRequirements } from '../../cli/callers.mjs';
import { LANE_CHECK, RULESET_NAME } from '../../cli/init.mjs';
import { TELEMETRY_CALLER_PATH, telemetryCallerFile } from '../../cli/callers.mjs';
import { TELEMETRY_QUESTION, telemetryQuestion, telemetryRegisters } from '../../cli/init.mjs';
import { HOSTED_INGEST_URL } from '../../scripts/lib/telemetry-token.mjs';
import { consentQuestion } from '../../cli/init.mjs';
import { parseUpstreamFindings } from '../../scripts/lib/upstream-findings.mjs';
import { SPAWNS } from './helpers/spawns.js';
import { unreached } from '../../actions/lane-check/dependabot-reach.mjs';
import { ROOT, hasYq, REQ, TAXONOMY, REPO, checkout, ok, no, fakeGitHub, writes, run, changing, laneCheck, read, parse } from './helpers/kanon-init.js';
import { readDocs, scanDoc } from '../../scripts/doc-pins.mjs';

// Its cases run `kanon init` against a real git checkout, and several run lane-check, so every
// case takes the spawn budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// `kanon init` on an empty repository, on what the plan and the token allow, the required check
// and telemetry. The other areas are in tests/unit/kanon-init-*.test.ts; the fixtures they share,
// and what each case runs against, are in tests/unit/helpers/kanon-init.ts (#1204).

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
    // Its only choices are the feature and the review trigger, and the Data section says nobody
    // declared it (plan 0007 §6, K-LAYOUT-10).
    const record = read(dir, 'docs/qa/adoption.md');
    expect(record.split('## Choices\n\n')[1]!.split('\n\n')[0]).toBe('- **Feature:** `review`\n- **Review trigger:** `labelled`');
    expect(record).toMatch(/## Data\n\n[^\n]+\n\n- \*\*Private or sensitive material:\*\* `not declared`\n$/);
    expect(record.indexOf('## Data')).toBeGreaterThan(record.indexOf('## Choices'));
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

  // kanon#1105: an entry for `/` alone reaches the workflows, never a composite action, so a hook
  // that pinned Kanon stayed behind on every upgrade pull request and lane-check failed the mix.
  it('writes a Dependabot entry that reaches the workflows and every hook under .github/actions/ (K-ADOPT-11, kanon#1105)', async () => {
    const dir = checkout();
    await run(dir, fakeGitHub());
    const entry = parseYaml(read(dir, '.github/dependabot.yml')).updates[0];
    const req = loadRequirements();
    const reached = ['.github/workflows/ci.yml', req.hook.path, '.github/actions/notify/action.yml', '.github/actions/a-hook-of-your-own/action.yaml'];
    expect(reached).toContain('.github/actions/project-setup/action.yml');
    expect(unreached(entry, reached)).toEqual([]);
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
    // GitHub's rules for the branch leave them out, so they are listed, not matched to it (#1262).
    expect(r.out).toContain('Not counted: the branch ruleset(s) "off" (disabled), "trial" (evaluate), which enforce nothing.');
    expect(github.st.rulesets.map((x) => x.name)).toEqual(['off', 'trial', RULESET_NAME]);
  });

  // #1262: a ruleset GitHub says applies to main, which the token couldn't read whole, may already
  // protect it, so init creates no second ruleset beside it, and says why.
  it('creates no ruleset while one that applies to the default branch could not be read, and says why', async () => {
    const dir = checkout();
    const github = fakeGitHub({ rulesets: [{ id: 7, name: 'org-main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } }, rules: [{ type: 'deletion' }] }] });
    github.st.unreadableRulesets = [7];
    const r = await run(dir, github);
    expect(github.st.rulesets.map((x) => x.name)).toEqual(['org-main']);
    expect(r.out).toContain('Init created no ruleset on main: the ruleset(s) "org-main" (gh: Not Found (HTTP 404)) could not be read, and may already cover it.');
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
  // The workflows' read; the owner's other registers are read through GraphQL too (plan 0007 G4).
  const graphql = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter((c) => c.args[1] === 'graphql' && !/repositoryOwner/.test(c.input ?? ''));
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
describe('the ci.yml kanon init writes, and the lanes that read it (#1214)', () => {
  // How each lane that reads `ci.yml` is named in the texts that say who needs that file. A lane
  // that gains a `# READS WORKFLOW: ci.yml` line and has no name here fails the first case, so the
  // header and the rulebook's layout table are updated with it.
  const NAMES: Record<string, string> = {
    'agent-review.yml': 'the review lane',
    'agent-lead-reconcile.yml': 'the reconciler',
    'agent-dispatch-sweep.yml': 'the dispatch sweep',
  };
  const readers = readdirSync(join(ROOT, '.github/workflows'))
    .filter((f) => /^agent-.*\.yml$/.test(f))
    .filter((f) => /^# READS WORKFLOW: ci\.yml$/m.test(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')));

  it('names every lane whose workflow carries `# READS WORKFLOW: ci.yml`', () => {
    expect(readers.length).toBeGreaterThan(0);
    for (const f of readers) expect(NAMES[f], `${f} reads ci.yml but has no name in NAMES`).toBeDefined();
    const header = ciFile('v1.2.3', 'main').split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^# ?/, '')).join(' ');
    const row = readFileSync(join(ROOT, 'rulebook/11-repository-layout.md'), 'utf8').split('\n').find((l) => l.startsWith('| `.github/workflows/ci.yml` |'))!;
    for (const f of readers) {
      expect(header, `the ci.yml header omits ${f}`).toContain(NAMES[f]);
      expect(row, `K-LAYOUT-18's layout row omits ${f}`).toContain(NAMES[f]);
    }
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

  // The docs name the latest stable release, not the one this tree releases (scripts/doc-pins.mjs),
  // so the block is `init`'s file at the release the docs name: byte for byte, apart from the release.
  it("writes docs/telemetry.md's caller, byte for byte, pinned to the release it runs from", () => {
    const doc = read(ROOT, 'docs/telemetry.md');
    const block = doc.split('**The caller.**')[1]!.split('```yaml\n')[1]!.split('```')[0]!;
    const named = [...new Set(readDocs(ROOT).flatMap((d) => scanDoc(d.text).flatMap((l) => l.refs)))];
    expect(named).toHaveLength(1);
    expect(telemetryCallerFile(named[0]!)).toBe(block);
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
    // Asked without --yes, in the one consent question (plan 0007 §3): an answer it doesn't recognise is No, the safe side.
    const asked: string[] = [];
    const dir = checkout();
    await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: async (q: string, d: string) => (asked.push(q), q.startsWith(consentQuestion(RELEASE)) ? 'maybe' : d) });
    const consent = asked.filter((q) => q.startsWith(consentQuestion(RELEASE)));
    expect(consent).toHaveLength(1);
    expect(consent[0]).toMatch(/^ {2}1\. Yes \(Recommended\): /m);
    expect(existsSync(join(dir, TELEMETRY_CALLER_PATH))).toBe(false);
  });

  // Owner decision 16 of plan 0007: the question was shown, so Enter is the person's answer to it,
  // and takes the recommended Yes; `--yes`, which shows no question, still sends nothing (above).
  it('takes Enter on the shown consent question as its recommended Yes', async () => {
    for (const enter of [(_q: string, d: string) => d, () => '']) {
      const dir = checkout();
      const r = await run(dir, fakeGitHub(), ['--no-apps'], undefined, REQ, { ask: async (q: string, d: string) => enter(q, d) });
      expect(r.status, r.err).toBe(0);
      expect(read(dir, TELEMETRY_CALLER_PATH)).toBe(telemetryCallerFile(RELEASE));
      expect(parseUpstreamFindings(read(dir, 'docs/qa/adoption.md'))).toBe('sent with evidence');
    }
  });

  it('says what is sent, where, who reads it, and how to stop and erase, in its question', () => {
    for (const s of ['no code', 'no titles', 'no logins', 'One row per lane run', 'One row per closed pull request', 'actor classes', 'one row per environment a release run reaches, whatever its outcome', 'one row each time its notify job runs, whether the message was posted, failed or skipped', 'docs/sharing.md and K-OBS-16 list every field', 'Frankfurt', '13 months', "Kanon's operator", 'at least three adopters', 'deleting .github/workflows/telemetry.yml', 'erase: yes', 'Stop and erase', 'registers this repository on its first run']) expect(TELEMETRY_QUESTION).toContain(s);
    // No issue and no variable is asked of the adopter any more (plan 0008 §8).
    for (const s of ['registration issue', 'variable set', 'reader role']) expect(TELEMETRY_QUESTION).not.toContain(s);
  });

  // #960: the question and the adopt skill's "What is sent" bullet name every row kind the
  // collector sends (run, work-item, deploy and notify rows) and point at the full list.
  it('names the deploy and notify rows, and the full list, in its question and in the adopt skill (#960)', () => {
    const bullet = read(ROOT, 'skills/adopt/SKILL.md').match(/^- \*\*What is sent:\*\* .*$/m)?.[0] ?? '';
    for (const s of ['one row per environment a release run reaches, whatever its outcome', 'whether the message was posted, failed or skipped', 'K-OBS-16']) {
      expect(TELEMETRY_QUESTION).toContain(s);
      expect(bullet).toContain(s);
    }
    expect(bullet).toContain('docs/sharing.md');
  });

  // #843: init pins the caller to its own release, so whether that release publishes the hosted
  // store's URL is the CLI's own constant. Until it does, init says the collector sends nothing.
  it("says the hosted store is unpublished, in its question and its summary, while this release's hosted URL is empty (#843)", () => {
    expect(TELEMETRY_QUESTION).toBe(telemetryQuestion(HOSTED_INGEST_URL !== ''));
    const unpublished = telemetryQuestion(false);
    expect(unpublished).toContain("this release of Kanon doesn't publish the hosted store's URL yet, so until your pin moves to one that does, the collector sends nothing and registers nothing");
    expect(telemetryQuestion(true)).not.toMatch(/doesn't publish|sends nothing/);
    expect(telemetryRegisters(true)).toBe("registers on the collector's first run");
    expect(telemetryRegisters(false)).toBe("sends nothing yet: this release of Kanon doesn't publish the hosted store's URL");
  });

  it('says what the adopter gets for it, here, in the adopt skill and in the docs (#41 §2)', () => {
    for (const s of ['Kanon notices failures it caused in your runs', 'cross-adopter cost and reliability baselines']) expect(TELEMETRY_QUESTION).toContain(s);
    expect(read(ROOT, 'skills/adopt/SKILL.md')).toMatch(/^- \*\*What the person gets:\*\* Kanon notices failures that Kanon caused in their runs/m);
    expect(read(ROOT, 'docs/telemetry.md')).toContain('**What an adopter gets by opting in**');
    expect(read(ROOT, 'docs/telemetry.md')).toMatch(/erasure, which completes within 35 days/);
  });

  it('on a yes, writes the caller and nothing else: no step, no variable, no issue (plan 0008 §8, J5)', async () => {
    const dir = checkout();
    const github = withVariables([]);
    const d = parse(await run(dir, github, ['--yes', '--json', '--no-apps', '--telemetry']));
    expect(d.answers.telemetry).toBe(true);
    expect(read(dir, TELEMETRY_CALLER_PATH)).toBe(telemetryCallerFile(RELEASE));
    expect(d.files.find((f) => f.path === TELEMETRY_CALLER_PATH)).toMatchObject({ status: 'new', content: telemetryCallerFile(RELEASE) });
    expect(d.findings.filter((x) => x.category === 'telemetry')).toEqual([]);
    expect(github.calls.some((c) => c.args[0] === 'variable')).toBe(false);
    // The registration issue template is gone with the step that linked it.
    expect(existsSync(join(ROOT, '.github/ISSUE_TEMPLATE/telemetry-registration.yml'))).toBe(false);
    expect(d.summary.find((l) => l.answer === 'Sharing')!.value).toContain(telemetryRegisters(HOSTED_INGEST_URL !== ''));
    if (HOSTED_INGEST_URL === '') expect(d.summary.find((l) => l.answer === 'Sharing')!.value).not.toContain("registers on the collector's first run");
    else expect(d.summary.find((l) => l.answer === 'Sharing')!.value).not.toContain('sends nothing yet');
    // A second run leaves the caller as written.
    const again = parse(await run(dir, github, ['--yes', '--json', '--no-apps', '--telemetry']));
    expect(again.files.find((x) => x.path === TELEMETRY_CALLER_PATH)).toMatchObject({ status: 'same' });
  });

  it('writes a caller with no `vars.`, no secret, and the erase and register dispatch inputs (plan 0008 §8, J5)', () => {
    const text = telemetryCallerFile(RELEASE);
    expect(text).not.toContain('vars.');
    expect(text).not.toContain('secrets.');
    expect(text).not.toMatch(/^\s+(url|writer-role|audience):/m);
    const caller = parseYaml(text) as { on: { workflow_dispatch: { inputs: Record<string, { type?: string; options?: string[]; default: string }> } }; jobs: { collect: { with: Record<string, string> } } };
    for (const k of ['erase', 'register']) expect(caller.on.workflow_dispatch.inputs[k]).toMatchObject({ type: 'choice', options: ['no', 'yes'], default: 'no' });
    expect(caller.jobs.collect.with).toEqual({ window_minutes: '${{ inputs.window_minutes }}', erase: '${{ inputs.erase }}', register: '${{ inputs.register }}' });
  });

  it('takes a yes to the consent question without --yes, and to its own question through Change something', async () => {
    const dir = checkout();
    const r = await run(dir, withVariables([]), ['--no-apps'], undefined, REQ, {
      ask: async (q: string, d: string) => (q.startsWith(consentQuestion(RELEASE)) ? 'yes' : d),
    });
    expect(r.status, r.err).toBe(0);
    expect(read(dir, TELEMETRY_CALLER_PATH)).toBe(telemetryCallerFile(RELEASE));
    const own = checkout();
    const changed = await run(own, withVariables([]), ['--no-apps'], undefined, REQ, { ask: changing('5', { [TELEMETRY_QUESTION]: 'y' }) });
    expect(changed.status, changed.err).toBe(0);
    expect(read(own, TELEMETRY_CALLER_PATH)).toBe(telemetryCallerFile(RELEASE));
  });
});
