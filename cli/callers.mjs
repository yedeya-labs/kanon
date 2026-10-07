// The files `kanon init` writes into an adopter's `.github/` (plan 0005 §5.4, step 3): a caller per
// chosen lane, the `apps-check` caller, `lane-check` in CI, the Dependabot entry and a starting
// project-setup hook, every Kanon reference pinned to one release.
//
// WHAT A CALLER MAPS, GRANTS AND PASSES IS READ FROM THE LANE, through `requirements.json` (the
// requirements file the release ships, built from the lanes and held to them by
// tests/unit/requirements.test.ts), never restated here. What this file holds is the one thing a
// lane can't declare: its caller's triggers (docs/lanes.md, "Which lanes are available"), with
// a name for the caller and a cadence for each schedule. tests/unit/kanon-init.test.ts holds
// TRIGGERS to that table, event by event, and runs `lane-check` on a caller written for every
// lane, which catches a dispatch input the lane doesn't declare and a lane with no template.
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

/**
 * @typedef {{ type: string, description: string }} LaneInput
 * @typedef {{ identities: string[], secrets: string[], inputs: Record<string, LaneInput>, grant: Record<string, string>,
 *   reads: string[], readsWorkflows: string[], hooks: string[], callerName?: string, callerRunNameEndsWith?: string }} Lane
 * @typedef {{ name: string, permissions: Record<string, string> }} RoleIdentity
 * @typedef {{ name: string, roles: string[], permissions: Record<string, string> }} AppIdentity
 * @typedef {{ lanes: Record<string, Lane>, hook: { path: string, inputs: string[] },
 *   identities: { roles: Record<string, RoleIdentity>, apps: Record<string, AppIdentity> }, labels: string[],
 *   declarations?: Record<string, { baseline: boolean, requiredSections: string[] }>,
 *   release?: { dcoExemptsReleaser?: boolean }, catalogue?: Catalogue }} Requirements
 * @typedef {{ name: string, group: string, does: string, needs: string[], cost: string, recommend: 'always' | string[], when: string }} CatalogueEntry
 * @typedef {{ groups: Array<{ id: string, title: string, header: string }>, lanes: Record<string, CatalogueEntry> }} Catalogue
 */

/** The requirements file of the Kanon tree this runs from. @returns {Requirements} */
export const loadRequirements = () => JSON.parse(readFileSync(new URL('../requirements.json', import.meta.url), 'utf8'));

/** The release this Kanon tree is, `v<package.json version>`: what every file `init` writes pins. */
export const kanonRelease = () => `v${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`;

/**
 * Each lane's caller: its `name`, its job's id, and its triggers. `dispatch` lists the
 * `workflow_dispatch` inputs, each the lane's own input passed through by name, `true` when a
 * dispatch must give it. `ci` adds a `workflow_run` of the adopter's CI (`'default'` limits it to
 * the default branch); `schedule` is the cron the caller suggests, which the adopter may change.
 * `pinMoved` adds the Overseer's runtime-version trigger (kanon#423): a `pull_request_target`
 * that closed a pull request on the default branch which changed this caller file, the one place
 * the adopter's agent runtime moves (it is pinned per Kanon release). The lane audits on it only
 * when the runtime changed, so it costs a short gate job on any other Kanon upgrade.
 * @type {Record<string, { name: string, job: string, dispatch: Record<string, boolean>, issues?: string[], pr?: string[], prTarget?: string[], review?: boolean, ci?: 'any' | 'default', schedule?: string, pinMoved?: boolean }>}
 */
export const TRIGGERS = {
  'agent-triage': { name: 'Triage (Implementer)', job: 'triage', issues: ['labeled'], dispatch: { issue_number: true } },
  'agent-implement': { name: 'Implement (Implementer)', job: 'implement', issues: ['labeled'], dispatch: { issue_number: true } },
  'agent-implement-revise': { name: 'Implement (Implementer) — revise', job: 'revise', review: true, pr: ['labeled'], dispatch: { pr_number: true, reset: false } },
  'agent-lead-revise': { name: 'Lead (Lead) — revise', job: 'revise', review: true, pr: ['labeled'], dispatch: { pr_number: true, reset: false } },
  'agent-merge-reconcile': { name: 'Merge Reconcile (Reviewer)', job: 'reconcile', pr: ['closed'], review: true, dispatch: { pr_number: true } },
  'agent-review': { name: 'Review (Reviewer)', job: 'review', ci: 'any', prTarget: ['opened', 'labeled'], dispatch: { pr_number: true } },
  'agent-verify-acs': { name: 'Verify acceptance criteria (Explorer)', job: 'verify', issues: ['labeled'], dispatch: { project: false, ref: false } },
  'agent-lead': { name: 'Lead (Lead) — brief', job: 'brief', dispatch: { mandate: true, context: false } },
  'agent-lead-split': { name: 'Lead (Lead) — split', job: 'split', issues: ['labeled'], dispatch: { issue: true } },
  'agent-rebase': { name: 'Rebase (Implementer)', job: 'rebase', ci: 'default', schedule: '17 5 * * *', dispatch: { pr_number: false } },
  'agent-lead-reconcile': { name: 'Lead (Lead) — reconcile', job: 'reconcile', pr: ['closed'], issues: ['closed'], schedule: '7 * * * *', dispatch: { project: false, apply: false } },
  'agent-merge': { name: 'Merge (Merger)', job: 'merge', review: true, ci: 'default', schedule: '37 * * * *', dispatch: { pr_number: false, apply: false } },
  'agent-project-digest': { name: 'Daily project digest', job: 'digest', schedule: '0 7 * * *', dispatch: { dry_run: false } },
  'agent-weekly-digest': { name: 'Weekly digest', job: 'digest', schedule: '0 8 * * 1', dispatch: { week_end: false, dry_run: false } },
  'agent-explore': { name: 'Explore (Explorer)', job: 'explore', schedule: '0 3 * * *', dispatch: { tier: false } },
  'agent-dispatch-sweep': { name: 'Dispatch sweep (Lead)', job: 'sweep', schedule: '30 4 * * *', dispatch: { apply: false } },
  'agent-code-audit': { name: 'Code audit (Explorer)', job: 'audit', schedule: '30 7 */3 * *', dispatch: {} },
  'agent-overseer': { name: 'Overseer (Overseer)', job: 'oversee', schedule: '0 6 * * 1', dispatch: {}, pinMoved: true },
};

/** A YAML scalar, double-quoted when plain would be read as something else. @param {string} s */
const y = (s) => (/^[A-Za-z0-9_][A-Za-z0-9_ ./()—-]*$/.test(s) && !/[ ]$/.test(s) ? s : JSON.stringify(s));

/**
 * One lane's caller, as `lane-check` holds it: `name` (and `run-name` when the lane asks), `on`,
 * `permissions` and one job that passes its inputs through, maps exactly the lane's secrets and
 * names the lane at `release`.
 * @param {string} lane the lane's file name without `.yml` @param {Lane} spec
 * @param {{ release: string, ciName: string, defaultBranch: string }} o
 */
export const callerFile = (lane, spec, { release, ciName, defaultBranch }) => {
  const t = TRIGGERS[lane];
  if (!t) throw new Error(`no caller template for the lane ${lane}: add its triggers to TRIGGERS in cli/callers.mjs`);
  const out = [`# The caller of Kanon's ${lane} lane, written by \`kanon init\` (docs/lanes.md). The triggers are yours;`, '# the rest is the lane\'s, and `lane-check` holds this file to it.'];
  out.push(`name: ${y(spec.callerName ?? t.name)}`, '');
  if (spec.callerRunNameEndsWith) out.push(`run-name: ${t.name.split(' ')[0]} ${spec.callerRunNameEndsWith}`, '');
  out.push('on:');
  if (t.ci) {
    out.push('  workflow_run:', `    workflows: [${y(ciName)}]`, '    types: [completed]');
    if (t.ci === 'default') out.push(`    branches: [${y(defaultBranch)}]`);
  }
  if (t.review) out.push('  pull_request_review:', '    types: [submitted]');
  if (t.pr) out.push('  pull_request:', `    types: [${t.pr.join(', ')}]`);
  if (t.prTarget) out.push('  pull_request_target:', `    types: [${t.prTarget.join(', ')}]`);
  if (t.issues) out.push('  issues:', `    types: [${t.issues.join(', ')}]`);
  if (t.schedule) out.push('  schedule:', `    - cron: "${t.schedule}"`);
  const dispatch = Object.entries(t.dispatch);
  if (!dispatch.length) out.push('  workflow_dispatch:');
  else {
    out.push('  workflow_dispatch:', '    inputs:');
    for (const [k, required] of dispatch) {
      const input = spec.inputs[k];
      if (!input) throw new Error(`the caller template of ${lane} passes "${k}", which the lane does not declare`);
      out.push(`      ${k}:`, `        description: ${JSON.stringify(input.description)}`, `        required: ${required}`);
      if (input.type === 'boolean') out.push('        type: boolean', '        default: false');
    }
  }
  if (t.pinMoved) {
    out.push('  # The runtime-version trigger: a merged pull request that moves this file\'s Kanon pin.',
      '  pull_request_target:', '    types: [closed]', `    branches: [${y(defaultBranch)}]`, '    paths:', `      - .github/workflows/${lane}.yml`);
  }
  out.push('', 'permissions:');
  for (const [k, v] of Object.entries(spec.grant)) out.push(`  ${k}: ${v}`);
  out.push('', 'jobs:', `  ${t.job}:`, `    uses: yedeya-labs/kanon/.github/workflows/${lane}.yml@${release}`);
  if (dispatch.length) {
    out.push('    with:');
    for (const [k] of dispatch) out.push(`      ${k}: \${{ inputs.${k} }}`);
  }
  out.push('    secrets:');
  // App secrets first, then the others, as docs/lanes.md writes them.
  const secrets = [...spec.secrets.filter((s) => /_APP_(ID|PRIVATE_KEY)$/.test(s)), ...spec.secrets.filter((s) => !/_APP_(ID|PRIVATE_KEY)$/.test(s))];
  for (const s of secrets) out.push(`      ${s}: \${{ secrets.${s} }}`);
  return `${out.join('\n')}\n`;
};

/** The `<NAME>_APP_ID` and `<NAME>_APP_PRIVATE_KEY` secrets of an identity. @param {string} identity */
export const appSecrets = (identity) => [`${identity.toUpperCase()}_APP_ID`, `${identity.toUpperCase()}_APP_PRIVATE_KEY`];

/** The `apps-check` caller (docs/apps.md), mapping the secrets of each identity the lanes run as. @param {string[]} identities @param {string} release */
export const appsCheckFile = (identities, release) =>
  [
    '# Checks each agent App in the register against its installation (docs/apps.md). Run it by hand:',
    '#   gh workflow run apps-check.yml',
    'name: apps-check',
    '',
    'on:',
    '  workflow_dispatch:',
    '',
    'permissions: {}',
    '',
    'jobs:',
    '  apps:',
    '    permissions:',
    '      contents: read',
    `    uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@${release}`,
    '    secrets:',
    ...identities.flatMap(appSecrets).map((s) => `      ${s}: \${{ secrets.${s} }}`),
    '',
  ].join('\n');

/** The `lane-check` job (actions/lane-check/README.md), as its own job in a workflow. @param {string} release */
const laneCheckJob = (release) => [
  '  lanes:',
  '    name: Lane check',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    steps:',
  '      - uses: actions/checkout@v7',
  `      - uses: yedeya-labs/kanon/actions/lane-check@${release}`,
];

/**
 * A new `ci.yml`, for a repository with none: the review lane and the reconciler read CI's runs by
 * that file name (`K-LAYOUT-18`), and `lane-check` is its first job. The project's own gates go
 * beside it.
 * @param {string} release @param {string} defaultBranch
 */
export const ciFile = (release, defaultBranch) =>
  [
    '# The project\'s CI (K-LAYOUT-18): the review lane and the reconciler read its runs by this file',
    '# name. `kanon init` started it with Kanon\'s lane check; add the project\'s own gates as jobs.',
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '  merge_group:',
    '  push:',
    `    branches: [${y(defaultBranch)}]`,
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    ...laneCheckJob(release),
    '',
  ].join('\n');

/** `lane-check` as a workflow of its own, beside a CI the project already has. @param {string} release */
export const laneCheckFile = (release) =>
  ['# Kanon\'s lane check (actions/lane-check/README.md), written by `kanon init`.', 'name: Lane check', '', 'on:', '  pull_request:', '  merge_group:', '', 'permissions:', '  contents: read', '', 'jobs:', ...laneCheckJob(release), ''].join('\n');

/** The Dependabot entry that proposes Kanon upgrades (`K-ADOPT-11`), cooldown written out. */
export const DEPENDABOT_ENTRY = [
  '  - package-ecosystem: github-actions',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  '    cooldown:',
  '      default-days: 3',
  '      exclude:',
  '        - "yedeya-labs/kanon*"',
  '    commit-message:',
  '      prefix: ci',
  '      include: scope',
  '    groups:',
  '      kanon:',
  '        patterns:',
  '          - "yedeya-labs/kanon*"',
];

export const dependabotFile = () => ['version: 2', 'updates:', ...DEPENDABOT_ENTRY, ''].join('\n');

/**
 * A starting project-setup hook (docs/lanes.md, "The project-setup hook"): a composite action that
 * declares every input the lanes pass it and installs nothing yet. The review lane never calls it;
 * the lanes that check out a branch do, so the project fills it in before installing them.
 * @param {string[]} inputs
 */
export const hookFile = (inputs) =>
  [
    '# The project-setup hook (docs/lanes.md): every lane that checks out calls it before the agent.',
    '# `kanon init` wrote this starting point, which installs nothing; add the steps that install',
    '# your toolchain and dependencies before you install a lane that checks out a branch.',
    'name: Project setup',
    'description: Installs the project for an agent lane.',
    'inputs:',
    ...inputs.flatMap((k) => [`  ${k}:`, `    description: Passed by Kanon's lanes (docs/lanes.md).`, '    default: ""']),
    'runs:',
    '  using: composite',
    '  steps:',
    '    - shell: bash',
    '      run: echo "No project setup yet (.github/actions/project-setup/action.yml)."',
    '',
  ].join('\n');
