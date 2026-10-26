import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escalatingPaths, readEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { credentialProblems, credentialReach as reachOf, evaluateIf, fileEntries, ROOT, type Reach } from './helpers/credential-reach.js';
import { RELEASE_REF } from './helpers/release-ref.js';

/**
 * kanon#730: every file of this tree that a Kanon workflow runs or imports, transitively, in a
 * job holding a secret, an App token, a write grant or `id-token: write`, either escalates or is
 * reached only at a pinned release.
 *
 * Since ADR 0011's amendment of 2026-10-12 the Merger merges an Implementer pull request that
 * touches only the green zone `docs/qa/escalation-paths.md` declares. The lane callers run the
 * library at the release they pin, but `apps-check.yml`, `metrics-page.yml`, `promote.yml`, `release-please.yml` and
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
const GREEN = 'scripts/lib/token-trend.mjs';
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
      'promote.yml:promote scripts/promote.mjs',
      'promote.yml:promote scripts/metrics/detectors.mjs',
      'promote.yml:promote scripts/lib/reverts.mjs',
      'promote.yml:promote actions/agent-classify/classify-agent-result.mjs',
    ]) expect(r, hit).toContain(hit);
    // The register job reads with `contents: read` alone, and the smoke's admission jobs with a
    // read grant and no App key: neither holds a credential.
    expect(r).not.toContain('apps-check.yml:register cli/apps-check.mjs');
    expect(r.filter((x) => x.endsWith(' scripts/lane-gate.mjs'))).toEqual([]);
    expect(escalates(GREEN), `${GREEN} must be green for the mutations below to mean anything`).toBe(false);
  });

  it("ADR 0011 says what the smoke run holds as the guard reads it: the store-cleanup jobs write, the admission jobs read (kanon#815)", () => {
    const adr = readFileSync('docs/decisions/0011-kanon-runs-its-own-lanes.md', 'utf8');
    const smoke = /`agent-lanes-smoke\.yml` \((.*?)\)\. Their entry files/.exec(adr)?.[1] ?? '';
    expect(smoke, 'the green-zone paragraph names what the smoke run holds').not.toBe('');
    const entries = new Set(REACH.filter((r) => r.workflow === 'agent-lanes-smoke.yml').map((r) => r.file));
    expect(entries).toContain('actions/qa-store/qa-store.mjs');
    expect(smoke).toMatch(/store-cleanup jobs \(`actions\/qa-store\/qa-store\.mjs`\)[^;]*write grants/);
    expect(smoke).toMatch(/admission jobs \(`scripts\/lane-gate\.mjs`\)[^;]*read grant alone/);
    expect(smoke).not.toMatch(/admission jobs[^;]*write grants/);
  });

  it('only the workflows that run this tree reach its code: every pinned lane caller runs its release', () => {
    expect([...new Set(REACH.filter((r) => r.file !== 'package.json').map((r) => r.workflow))].sort()).toEqual(['agent-lanes-smoke.yml', 'apps-check.yml', 'metrics-page.yml', 'promote.yml', 'release-please.yml']);
  });

  it("a shell script's run through its own directory is followed: the pin job reaches lane-check's Node and what it imports (kanon#1076)", () => {
    const pins = REACH.filter((r) => r.workflow === 'release-please.yml' && r.job === 'pins');
    const node = pins.find((r) => r.file === 'actions/lane-check/lane-check.mjs');
    expect(node?.via.at(-1), 'lane-check.sh runs it as `node "$HERE/lane-check.mjs"`').toBe('actions/lane-check/lane-check.sh');
    const files = pins.map((r) => r.file);
    for (const lib of ['capability-watch', 'declarations', 'deploy-declaration', 'digest-audience', 'exemptions', 'overseer-install', 'reference-deploy', 'upstream-findings']) {
      expect(files, lib).toContain(`scripts/lib/${lib}.mjs`);
    }
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
    const problems = credentialProblems(credentialReach(withImport('scripts/metrics/indicators.mjs', `export { DAY_MS } from '../lib/token-trend.mjs';`)), ESCALATIONS);
    expect(problems.map((p) => p.split(',')[0])).toEqual([`${GREEN}: metrics-page.yml`]);
  });

  it('when a file a shell script runs through its own directory imports one: lane-check, which the pin job runs (kanon#1076)', () => {
    const problems = credentialProblems(credentialReach(withImport('actions/lane-check/lane-check.mjs', `import '../../${GREEN}';`)), ESCALATIONS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${GREEN}: release-please\\.yml, job pins, .*actions/lane-check/lane-check\\.sh > actions/lane-check/lane-check\\.mjs\\)`));
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

  it('when a lane caller stops pinning a release, at a branch, the major tag or through `$/`', () => {
    const file = '.github/workflows/telemetry.yml';
    const text = readFileSync(file, 'utf8');
    const pin = new RegExp(`yedeya-labs/kanon/\\.github/workflows/telemetry-collect\\.yml@${RELEASE_REF}`);
    expect(text).toMatch(pin);
    const at = (ref: string) => `yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@${ref}`;
    for (const uses of [at('main'), at('v0'), at('candidate-main'), '$/.github/workflows/telemetry-collect.yml']) {
      expect(reached(credentialReach({ [file]: text.replace(pin, uses) })), uses).toContain('telemetry.yml:collect scripts/telemetry-collect.mjs');
    }
    // A release, stable or the candidate Kanon's pin job moves it to (plan 0009 S4), runs no file of this tree.
    for (const uses of [at('v1.2.3'), at('candidate-v1.2.3')]) {
      expect(reached(credentialReach({ [file]: text.replace(pin, uses) })), uses).not.toContain('telemetry.yml:collect scripts/telemetry-collect.mjs');
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
    expect(problems.some((p) => p.startsWith('scripts/ensure-labels.mjs: agent-lanes-smoke.yml, job implement-revise,') && p.includes('lane-agent-job.yml:run'))).toBe(true);
  });

  // kanon#831: a lane spine hands its agent job the App token its mint job seals into an output,
  // `app-token: ${{ needs.mint.outputs.sealed }}`, beside the Claude secret. The token alone holds
  // a credential.
  const SPINES = ['agent-lane.yml', 'review-run.yml', 'rebase-run.yml', 'lead-split-run.yml', 'explore-run.yml', 'code-audit-run.yml', 'overseer-run.yml', 'verify-acs-run.yml', 'merge-reconcile-run.yml', 'explore-telemetry-run.yml'];
  const CLAUDE = /(\n {6}app-token: \$\{\{ needs\.mint\.outputs\.sealed \}\})\n {6}claude-token: \$\{\{ secrets\.claude-token \}\}\n {6}anthropic-api-key: \$\{\{ secrets\.anthropic-api-key \}\}/;
  const withoutClaude = (spine: string) => {
    const file = `.github/workflows/${spine}`;
    const text = readFileSync(file, 'utf8');
    expect(text, spine).toMatch(CLAUDE);
    return { [file]: text.replace(CLAUDE, '$1') };
  };

  it("when a spine maps its agent job no Claude secret, the minted App token it still maps holds a credential", () => {
    for (const spine of SPINES) expect(reached(credentialReach(withoutClaude(spine))), spine).toEqual(reached(REACH));
  });

  it("when the project-setup hook runs a green-zone file in a lane whose spine maps only the minted App token", () => {
    const file = '.github/actions/project-setup/action.yml';
    const anchor = '      run: npm ci\n';
    const setup = readFileSync(file, 'utf8').replace(anchor, `${anchor}    - shell: bash\n      run: node ${GREEN}\n`);
    for (const [spine, hit] of [['agent-lane.yml', `${GREEN}: implement.yml, job implement`], ['rebase-run.yml', `${GREEN}: rebase.yml, job rebase`]] as const) {
      const problems = credentialProblems(credentialReach({ ...withoutClaude(spine), [file]: setup }), ESCALATIONS);
      expect(problems.find((p) => p.startsWith(hit)), spine).toContain(`${spine}:`);
    }
  });

  // A token minted from a real secret, carried in a job output to a job that holds no other.
  const FIXTURE = '.github/workflows/fixture-831.yml';
  const CALLED = '.github/workflows/fixture-831-called.yml';
  const mintAnd = (jobs: string) => `on: push
permissions: {}
jobs:
  mint:
    runs-on: ubuntu-latest
    outputs:
      token: \${{ steps.mint.outputs.token }}
    steps:
      - id: mint
        uses: actions/create-github-app-token@v3
        with:
          private-key: \${{ secrets.APP_PRIVATE_KEY }}
  plain:
    runs-on: ubuntu-latest
    outputs:
      count: \${{ steps.count.outputs.count }}
    steps:
      - id: count
        run: echo count=1 >> "$GITHUB_OUTPUT"
${jobs}`;
  const runsGreen = (needs: string, env: string, extra = '') => `  use:
    needs: ${needs}
    runs-on: ubuntu-latest
    permissions:
      contents: read${extra}
    env:
      VALUE: ${env}
    steps:
      - run: node ${GREEN}
`;
  const called = (ref: string) => `on:
  workflow_call:
    inputs:
      token:
        type: string
      count:
        type: string
    secrets:
      token:
        required: false
jobs:
  use:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - env:
          VALUE: ${ref}
        run: node ${GREEN}
`;
  const call = (needs: string, mapping: string) => `  call:
    needs: ${needs}
    uses: ./${CALLED}
${mapping}
`;
  const problemsOf = (overrides: Record<string, string>) => credentialProblems(credentialReach(overrides), ESCALATIONS).map((p) => p.split(',').slice(0, 2).join(','));

  it('when a job reads, in its `env:`, an output of a job that reads a real secret, and runs a green-zone file', () => {
    expect(problemsOf({ [FIXTURE]: mintAnd(runsGreen('mint', '${{ needs.mint.outputs.token }}')) })).toEqual([`${GREEN}: fixture-831.yml, job use`]);
    // Through a job that relays it, too.
    const relay = `  relay:
    needs: mint
    runs-on: ubuntu-latest
    outputs:
      token: \${{ steps.relay.outputs.token }}
    steps:
      - id: relay
        env:
          TOKEN: \${{ needs.mint.outputs.token }}
        run: echo "token=$TOKEN" >> "$GITHUB_OUTPUT"
`;
    expect(problemsOf({ [FIXTURE]: mintAnd(relay + runsGreen('relay', '${{ needs.relay.outputs.token }}')) })).toEqual([`${GREEN}: fixture-831.yml, job use`]);
    // An output of a job that reads no secret holds none, and nor does an `if:` that reads one.
    expect(problemsOf({ [FIXTURE]: mintAnd(runsGreen('plain', '${{ needs.plain.outputs.count }}')) })).toEqual([]);
    expect(problemsOf({ [FIXTURE]: mintAnd(runsGreen('[mint, plain]', '${{ needs.plain.outputs.count }}', "\n    if: needs.mint.outputs.token != ''")) })).toEqual([]);
  });

  it("when a called workflow's job reads a minted token mapped to it as a secret or passed in its `with:`, and runs a green-zone file", () => {
    const hit = [`${GREEN}: fixture-831.yml, job call`];
    expect(problemsOf({ [FIXTURE]: mintAnd(call('mint', '    secrets:\n      token: ${{ needs.mint.outputs.token }}')), [CALLED]: called('${{ secrets.token }}') })).toEqual(hit);
    expect(problemsOf({ [FIXTURE]: mintAnd(call('mint', '    with:\n      token: ${{ needs.mint.outputs.token }}')), [CALLED]: called('${{ inputs.token }}') })).toEqual(hit);
    // An input that carries no credential, or one the job never reads, holds none.
    expect(problemsOf({ [FIXTURE]: mintAnd(call('[mint, plain]', '    with:\n      token: ${{ needs.mint.outputs.token }}\n      count: ${{ needs.plain.outputs.count }}')), [CALLED]: called('${{ inputs.count }}') })).toEqual([]);
  });

  it('when a job reads an output of a called workflow given a minted token', () => {
    const after = `  use:
    needs: call
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      VALUE: \${{ needs.call.outputs.token }}
    steps:
      - run: node ${GREEN}
`;
    const quiet = called('${{ inputs.count }}').replace(`node ${GREEN}`, 'true');
    const problems = problemsOf({ [FIXTURE]: mintAnd(call('mint', '    with:\n      token: ${{ needs.mint.outputs.token }}') + after), [CALLED]: quiet });
    expect(problems).toEqual([`${GREEN}: fixture-831.yml, job use`]);
  });

  it('but not for a file a comment names', () => {
    expect(credentialProblems(credentialReach(withImport('cli/apps.mjs', `// import '../${GREEN}';\n/* require('../${GREEN}') */`)), ESCALATIONS)).toEqual([]);
  });
});

describe("fileEntries follows a shell script's own directory (kanon#1076)", () => {
  const script = join(ROOT, 'actions/lane-check/fixture-1076.sh');
  const entries = (text: string) => fileEntries(script, {
    isFile: (abs) => abs === script || (existsSync(abs) && statSync(abs).isFile()),
    text: (abs) => (abs === script ? text : readFileSync(abs, 'utf8')),
  }).map((abs) => relative(ROOT, abs).split(sep).join('/'));
  const SELF = 'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"';

  it('a path under a variable set to it, written `$VAR/` or `${VAR}/`, from `${BASH_SOURCE[0]}` or `$0`', () => {
    expect(entries(`${SELF}\nexec node "$HERE/lane-check.mjs" "$@"`)).toContain('actions/lane-check/lane-check.mjs');
    expect(entries(`${SELF}\nnode "\${HERE}/lane-check.mjs"`)).toContain('actions/lane-check/lane-check.mjs');
    expect(entries('here=$(dirname "$0")\nnode "$here/lane-check.mjs"')).toContain('actions/lane-check/lane-check.mjs');
  });

  it('and one set to a directory above it, as `$(dirname …)/..`', () => {
    expect(entries('UP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\nnode "$UP/qa-store/qa-store.mjs"')).toContain('actions/qa-store/qa-store.mjs');
  });

  it('but not from a comment line', () => {
    expect(entries(`${SELF}\n# exec node "$HERE/lane-check.mjs"`)).toEqual([]);
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
