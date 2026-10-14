import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { escalatingPaths, readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { credentialProblems, credentialReach as reachOf, evaluateIf, type Reach } from './helpers/credential-reach.js';

/**
 * kanon#730: every file of this tree that a Kanon workflow runs or imports, transitively, in a
 * job holding a secret, an App token, a write grant or `id-token: write`, either escalates or is
 * reached only at a pinned release.
 *
 * Since ADR 0011's amendment of 2026-10-12 the Merger merges an Implementer pull request that
 * touches only the green zone `docs/qa/escalation-paths.md` declares. The lane callers run the
 * library at the release they pin, but `apps-check.yml`, `metrics-page.yml` and
 * `agent-lanes-smoke.yml` run this tree, from `main`, holding credentials. Without this guard,
 * one new `import` from a green-zone file into a file they reach would let the Merger land code
 * into a job that holds an App's key or the store's role, and nothing would go red.
 *
 * The escalations are the strictest the Merger can apply: Kanon's adoption record declares its
 * production promotion human-gated, so only the pipeline's own paths and the entries marked
 * `always` escalate (`escalatingPaths` with no judging input, which can only add to them).
 * `tests/unit/helpers/credential-reach.ts` says what it reads as running, holding and reaching.
 */
const ESCALATIONS = escalatingPaths(readEscalationFile(), { judgingInputs: [] });
// The secret `agent-lanes-smoke.yml` maps every lane's secrets to, which it says does not exist:
// a root workflow's every other secret counts as real.
const UNSET = ['KANON_SMOKE_UNSET'];
const credentialReach = (overrides: Readonly<Record<string, string>> = {}) => reachOf(overrides, { unset: UNSET });
const REACH = credentialReach();
const escalates = (file: string) => ESCALATIONS.some(([re]) => re.test(file));
const reached = (reaches: readonly Reach[]) => reaches.map((r) => `${r.workflow}:${r.job} ${r.file}`);

// A library file the green zone holds, which no credential-holding run reaches today.
const GREEN = 'scripts/lib/labels.mjs';
const withImport = (file: string, line: string) => ({ [file]: `${line}\n${readFileSync(file, 'utf8')}` });

describe("this tree's credential-holding runs", () => {
  it('reach only files an escalation path matches', () => {
    expect(credentialProblems(REACH, ESCALATIONS)).toEqual([]);
  });

  it('the guard is not vacuous: it reaches the App check, the metrics page and the smoke run, and their imports', () => {
    const r = reached(REACH);
    for (const hit of [
      'apps-check.yml:check cli/apps-check.mjs',
      'apps-check.yml:check cli/apps.mjs',
      'apps-check.yml:check cli/gh-token.mjs',
      'apps-check.yml:check scripts/lib/cli-entry.mjs',
      'metrics-page.yml:aggregate scripts/aggregate-read.mjs',
      'metrics-page.yml:page scripts/telemetry/kanon-health.mjs',
      'metrics-page.yml:page .github/scripts/metrics-page.mjs',
      'metrics-page.yml:page scripts/metrics/indicators.mjs',
      'metrics-page.yml:page scripts/metrics/health.mjs',
      'metrics-page.yml:page actions/agent-setup/agent-commits.sh',
      'agent-lanes-smoke.yml:code-audit actions/qa-store/qa-store.mjs',
    ]) expect(r, hit).toContain(hit);
    // The register job reads with `contents: read` alone, and the smoke's admission jobs with a
    // read grant and no App key: neither holds a credential.
    expect(r).not.toContain('apps-check.yml:register cli/apps-check.mjs');
    expect(r.filter((x) => x.endsWith(' scripts/lane-gate.mjs'))).toEqual([]);
    expect(escalates(GREEN), `${GREEN} must be green for the mutations below to mean anything`).toBe(false);
  });

  it('only the workflows that run this tree reach its code: every pinned lane caller runs its release', () => {
    expect([...new Set(REACH.filter((r) => r.file !== 'package.json').map((r) => r.workflow))].sort()).toEqual(['agent-lanes-smoke.yml', 'apps-check.yml', 'metrics-page.yml']);
  });

  it("a pinned lane's `uses: ./` runs this tree: the project-setup hook's `npm ci` reads package.json, which declares no install hook", () => {
    const r = reached(REACH);
    for (const hit of ['implement.yml:implement package.json', 'rebase.yml:rebase package.json', 'lead-split.yml:split package.json']) expect(r, hit).toContain(hit);
    expect(REACH.filter((x) => x.unmodelled !== undefined)).toEqual([]);
  });
});

// K-PRIN-11: each change below is one a pull request could make; each must turn the guard red,
// naming the file and the workflow. Each walks every workflow again, which a loaded suite slows.
describe('the guard goes red', { timeout: 30_000 }, () => {
  it('when a reached file imports a green-zone file', () => {
    const problems = credentialProblems(credentialReach(withImport('cli/apps.mjs', `import '../${GREEN}';`)), ESCALATIONS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${GREEN}: apps-check\\.yml, job check, .*cli/apps-check\\.mjs > cli/apps\\.mjs`));
  });

  it('when the metrics page imports one, through the library it reaches', () => {
    const problems = credentialProblems(credentialReach(withImport('scripts/metrics/indicators.mjs', `export { LABELS } from '../lib/labels.mjs';`)), ESCALATIONS);
    expect(problems.map((p) => p.split(',')[0])).toEqual([`${GREEN}: metrics-page.yml`]);
  });

  it('when a credential-holding job gains a step that runs a green-zone file', () => {
    const file = '.github/workflows/metrics-page.yml';
    const text = readFileSync(file, 'utf8').replace('      - name: Read Kanon\'s health\n', `      - run: node ${GREEN}\n      - name: Read Kanon's health\n`);
    expect(text).toContain(`node ${GREEN}`);
    expect(credentialProblems(credentialReach({ [file]: text }), ESCALATIONS).map((p) => p.split(',')[0])).toEqual([`${GREEN}: metrics-page.yml`]);
  });

  it('when an escalation entry a reached file needs is dropped', () => {
    const dropped = ESCALATIONS.filter(([re]) => !re.test('cli/gh-token.mjs'));
    expect(dropped.length).toBe(ESCALATIONS.length - 1);
    expect(credentialProblems(REACH, dropped).map((p) => p.split(',')[0])).toEqual(['cli/gh-token.mjs: apps-check.yml']);
  });

  it('when a lane caller stops pinning a release, at a branch or through `$/`', () => {
    const file = '.github/workflows/telemetry.yml';
    const text = readFileSync(file, 'utf8');
    const pin = /yedeya-labs\/kanon\/\.github\/workflows\/telemetry-collect\.yml@v\d+\.\d+\.\d+/;
    expect(text).toMatch(pin);
    for (const uses of ['yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@main', '$/.github/workflows/telemetry-collect.yml']) {
      expect(reached(credentialReach({ [file]: text.replace(pin, uses) })), uses).toContain('telemetry.yml:collect scripts/telemetry-collect.mjs');
    }
  });

  it('when a lane the smoke run calls admits a push into a job holding a secret', () => {
    const file = '.github/workflows/agent-weekly-digest.yml';
    const text = readFileSync(file, 'utf8');
    const gate = "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
    expect(text).toContain(gate);
    // Read as if the smoke run's secret were set: the job then holds it.
    const problems = credentialProblems(reachOf({ [file]: text.replace(gate, 'if: always()') }), ESCALATIONS);
    expect(problems.some((p) => p.startsWith('scripts/weekly-digest.mjs: agent-lanes-smoke.yml, job weekly-digest,'))).toBe(true);
  });

  // kanon#814: three routes the guard did not model. Each fixture below passed the guard before.
  it("when a workflow's top-level `env:` gives every job a secret, and a job it holds then runs a green-zone file", () => {
    const file = '.github/workflows/apps-check.yml';
    const text = readFileSync(file, 'utf8');
    const step = '      - id: apps\n';
    expect(text).toContain('\njobs:\n');
    expect(text).toContain(step);
    const mutated = text
      .replace('\njobs:\n', '\nenv:\n  REGISTER_KEY: ${{ secrets.AUTHOR_APP_PRIVATE_KEY }}\n\njobs:\n')
      .replace(step, `      - run: node ${GREEN}\n${step}`);
    // The step alone, in a job holding only `contents: read`, reaches nothing.
    expect(credentialProblems(credentialReach({ [file]: text.replace(step, `      - run: node ${GREEN}\n${step}`) }), ESCALATIONS)).toEqual([]);
    expect(credentialProblems(credentialReach({ [file]: mutated }), ESCALATIONS).map((p) => p.split(',').slice(0, 2).join(','))).toEqual([`${GREEN}: apps-check.yml, job register`]);
  });

  it('when a credential-holding job runs an npm script or binary, which the guard does not follow', () => {
    const file = '.github/workflows/metrics-page.yml';
    const text = readFileSync(file, 'utf8');
    const anchor = "      - name: Read Kanon's health\n";
    const commands = ['npm test', 'npm run lint', 'npx vitest run', 'npm exec -- tsc'];
    const problems = credentialProblems(credentialReach({ [file]: text.replace(anchor, `${commands.map((c) => `      - run: ${c}\n`).join('')}${anchor}`) }), ESCALATIONS);
    expect(problems).toHaveLength(commands.length);
    for (const [i, command] of commands.entries()) {
      expect(problems[i], command).toMatch(new RegExp(`^package\\.json: metrics-page\\.yml, job page, holds a credential and \`${command.split(' ').slice(0, 2).join(' ')}\` runs a package\\.json script or a binary, an entry point this guard does not follow`));
    }
    // `npm ci` runs only the root package's install hooks, of which package.json declares none.
    expect(credentialProblems(credentialReach({ [file]: text.replace(anchor, `      - run: npm ci\n${anchor}`) }), ESCALATIONS)).toEqual([]);
  });

  it("when package.json gains an install hook that a pinned lane's project-setup `npm ci` runs", () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.prepare = `node ${GREEN}`;
    const problems = credentialProblems(credentialReach({ 'package.json': JSON.stringify(pkg) }), ESCALATIONS);
    expect(problems.some((p) => p.startsWith("package.json: implement.yml, job implement, holds a credential and `npm ci` runs package.json's prepare script"))).toBe(true);
  });

  it("when the project-setup hook a release-pinned lane runs through `uses: ./` runs a green-zone file", () => {
    const file = '.github/actions/project-setup/action.yml';
    const text = readFileSync(file, 'utf8');
    const anchor = '      run: npm ci\n';
    expect(text).toContain(anchor);
    const mutated = text.replace(anchor, `${anchor}    - shell: bash\n      run: node ${GREEN}\n`);
    const problems = credentialProblems(credentialReach({ [file]: mutated }), ESCALATIONS).map((p) => p.split(',').slice(0, 2).join(','));
    for (const hit of [`${GREEN}: implement.yml, job implement`, `${GREEN}: rebase.yml, job rebase`, `${GREEN}: lead-split.yml, job split`]) expect(problems, hit).toContain(hit);
    // Only the caller-pinned lanes' jobs, never a file their `$/` steps run, which is the release's.
    expect(problems.every((p) => p.startsWith(`${GREEN}: `))).toBe(true);
  });

  it("when the smoke run maps a lane's hyphen-named secret from a real one", () => {
    const file = '.github/workflows/agent-lanes-smoke.yml';
    const text = readFileSync(file, 'utf8');
    const unset = /(implement-revise:[\s\S]*?CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.)KANON_SMOKE_UNSET/;
    expect(text).toMatch(unset);
    const problems = credentialProblems(credentialReach({ [file]: text.replace(unset, '$1CLAUDE_CODE_OAUTH_TOKEN') }), ESCALATIONS);
    expect(problems.some((p) => p.startsWith('scripts/lib/labels.mjs: agent-lanes-smoke.yml, job implement-revise,') && p.includes('lane-agent-job.yml:run'))).toBe(true);
  });

  it('but not for a file a comment names', () => {
    expect(credentialProblems(credentialReach(withImport('cli/apps.mjs', `// import '../${GREEN}';\n/* require('../${GREEN}') */`)), ESCALATIONS)).toEqual([]);
  });
});

describe('evaluateIf reads what a workflow decides statically', () => {
  const ctx = (event: string, needs: string[] = [], skipped: string[] = []) => ({ event, needs, neverRuns: (j: string) => skipped.includes(j) });

  it('the event, and a payload a push never carries', () => {
    expect(evaluateIf("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", ctx('push'))).toBe(false);
    expect(evaluateIf("github.event_name == 'schedule'", ctx('schedule'))).toBe(true);
    expect(evaluateIf("github.event_name == 'workflow_dispatch' || github.event.label.name == 'agent:implement'", ctx('push'))).toBe(false);
    expect(evaluateIf("github.event.label.name == 'agent:implement'", ctx('issues'))).toBe(null);
    expect(evaluateIf("contains(fromJSON('[\"workflow_run\",\"schedule\"]'), github.event_name)", ctx('push'))).toBe(false);
    expect(evaluateIf("${{ github.event_name != 'pull_request' }}", ctx('push'))).toBe(true);
  });

  it("a needed job that never runs: skipped, its outputs empty, and success() false unless a status function says otherwise", () => {
    expect(evaluateIf(undefined, ctx('push', ['gate'], ['gate']))).toBe(false);
    expect(evaluateIf("needs.gate.outputs.member == 'true'", ctx('push', ['gate'], ['gate']))).toBe(false);
    expect(evaluateIf("needs.gate.outputs.member == 'true'", ctx('push', ['gate']))).toBe(null);
    expect(evaluateIf('always()', ctx('push', ['gate'], ['gate']))).toBe(true);
    expect(evaluateIf("failure() && needs.gate.result == 'failure'", ctx('push', ['gate'], ['gate']))).toBe(false);
    expect(evaluateIf("${{ !cancelled() && needs.gate.result == 'success' }}", ctx('push', ['gate'], ['gate']))).toBe(false);
  });

  it('anything else is unknown, and unknown runs', () => {
    expect(evaluateIf("inputs.smoke != ''", ctx('push'))).toBe(null);
    expect(evaluateIf("github.event.pull_request.labels.*.name[0] == 'x'", ctx('push'))).toBe(null);
  });
});
