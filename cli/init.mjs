// `kanon init` (plan 0005 §5.4, step L9): installs Kanon in a repository, from its checkout.
//
// 1. INSPECTS, read-only: whether the owner is a personal account or an organisation, whether the
//    repository is public or private, which plan features it has (rulesets, the merge queue;
//    environments are not needed, decision 4), its labels, milestones, rulesets, secret names,
//    declaration files, callers and App register.
// 2. ASKS what it can't infer, each question with a default (`--yes` takes them all): the people,
//    the stack's gates, the test database, a sign-off delegation, which lanes to install.
// 3. WRITES the declarations, only the sections that differ from their documented defaults (an
//    omitted section means its default, plan 0005 §5.2), the lane callers, the `apps-check`
//    caller, `lane-check` in CI, the Dependabot entry, a starting project-setup hook and, when the
//    person says yes, the kanon plugin's declaration in `.claude/settings.json` (#376), every
//    Kanon reference pinned to the release it runs from, and prints the diff. It commits nothing.
// 4. CREATES the taxonomy's labels (rulebook/labels.json), the bucket milestones (`kanon
//    milestones`), the squash-only merge setting and, where the plan has rulesets and the token
//    can administer the repository, the default branch's ruleset. The ruleset requires the
//    `Lane check` status check only once a job on the default branch reports it (#444): before
//    that, every other pull request would wait on it, so the rule is a step for after the merge.
//    To an existing ruleset, init adds that rule alone, and nothing else.
// 5. DRIVES `kanon apps` for the Apps the chosen lanes run as (the Author and the Judge), and the
//    optional Releaser when the repository calls Kanon's release workflow.
// 6. SAYS PLAINLY what the plan can't enforce: on a private repository without rulesets, nothing
//    on the platform refuses a merge without the Reviewer's approval (decision 3, K-ADOPT-3).
//
// Whatever the token can't do is printed as an exact manual step. Re-running it is safe: it
// changes nothing that is already right, never overwrites a file, and names what differs.
// `--dry-run` reads everything and changes nothing.
//
// SCRIPTABLE (ADR 0014 decision 2). Every question has a flag that answers it, and `--yes` takes
// the default of each question no flag answers, so a program can run `init` with no terminal
// (#367). `--json` prints one JSON document on standard output, `kanon-init/v1` (docs/init.md,
// following docs/cli-json.md's convention), and moves the prose to standard error: the same run,
// the same exit code, read by the agent skills of plan 0005's L11 (#365). Its shape is a promise
// each release keeps: a change to it is a breaking change.
//
// THE APPS. Which Apps a lane runs as is read from the secrets it declares, through the
// requirements file (`<NAME>_APP_ID` names the identity). Since plan 0005's L4 those are the
// Author (`AUTHOR_APP_ID`: the Implementer's, Lead's, Explorer's and Overseer's lanes) and the
// Judge (`JUDGE_APP_ID`: the Reviewer's and Merger's), and `kanon apps --apps` creates them,
// each with its roles' register rows and the Author's broadened Commit statuses write. The
// optional Releaser, which no lane takes, is offered when the repository calls Kanon's release
// workflow (`.github/workflows/release.yml`, docs/release.md). An App another repository of the
// owner already has is added with `kanon apps --reuse`, from a key generated on its page.
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { URL } from 'node:url';
import { REGISTER_PATH, apps as runApps, checkoutCheck, ownerInstallations, ownerKanonApps, remoteRepo } from './apps.mjs';
import {
  appSecrets,
  appsCheckFile,
  callerFile,
  ciFile,
  dependabotFile,
  DEPENDABOT_ENTRY,
  hookFile,
  kanonRelease,
  laneCheckFile,
  loadRequirements,
  TELEMETRY_CALLER_PATH,
  telemetryCallerFile,
  TRIGGERS,
} from './callers.mjs';
import { branchWorkflows, checkJobs, checkReporters, mergeQueueOn } from './check-reporters.mjs';
import { whoami } from './gh-token.mjs';
import { pluginSettings, pluginSettingsFile, readPluginDeclaration, SETTINGS_PATH } from './plugin.mjs';
import { coveringRulesets } from './ruleset-bypass.mjs';
import { BUCKETS, milestones as runMilestones } from './milestones.mjs';
import { parseYaml } from './workflow-yaml.mjs';

/** @typedef {import('./callers.mjs').Requirements} Requirements */
/** @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult */

/** The lanes installed when nobody says otherwise: the Reviewer, the first lane (docs/lanes.md). */
export const DEFAULT_LANES = ['agent-review'];
/** The ruleset `init` creates and recognises as its own. */
export const RULESET_NAME = 'Kanon: default branch';
/** The check `lane-check`'s job reports, which the ruleset requires. */
export const LANE_CHECK = 'Lane check';
/** GitHub's default labels, which `init` offers to delete when the taxonomy doesn't hold them (K-WORK-12). */
export const GITHUB_DEFAULT_LABELS = ['bug', 'documentation', 'duplicate', 'enhancement', 'good first issue', 'help wanted', 'invalid', 'question', 'wontfix'];

export const USAGE = `Usage: kanon init [options]

Installs Kanon in the repository whose checkout you run it from: inspects the repository,
asks what it can't infer (each question has a default), writes the declarations and the lane
callers pinned to this release, creates the labels, the bucket milestones and, where the plan
has rulesets, the default branch's ruleset, and runs \`kanon apps --apps\` for the Apps the
lanes run as: the Author and the Judge, and the optional Releaser if the repository calls
Kanon's release workflow and you ask for it. It commits nothing, and prints as exact steps
whatever its token can't do. The ruleset requires the "Lane check" status check only once a
job on the default branch reports it; until then, that rule is a step for after the merge.
Safe to run again.

Options:
  --repo <owner>/<repo>  the repository (default: the checkout's origin remote)
  --dir <path>           the checkout (default: here)
  --yes                  take the default of every question no flag below answers
  --dry-run              read everything, change nothing, print what it would do
  --json                 print one JSON document (docs/init.md) on standard output and the
                         prose on standard error; asks nothing, as --yes
  -h, --help             this text

The answers, one flag per question (without --yes, the questions no flag answers are asked):
  --project-owner <who>  the project's Owner (K-ADOPT-1 step 2), a GitHub login or a name
                         (default: the token's login); --owner is kanon apps' account
  --maintainer <who>     the Maintainer (default: the Owner)
  --stakeholder <who>    the Stakeholder (default: the Owner)
  --lanes <list>         comma-separated lanes to install, e.g. review,implement
                         (default: the lanes already called, or review; the lanes are
                         listed below)
  --gates <list>         the stack's gates, comma-separated commands, or none
                         (default: suggested from what the repository holds)
  --test-database <how>  none, or hook: the project-setup hook starts one (default: none)
  --delegation           record a sign-off delegation (K-AGENT-44)
  --no-delegation        don't (the default)
  --delegate-name <name> the delegate, as their sign-off writes their name; implies
                         --delegation (default: git config user.name)
  --delegate-email <e>   the delegate's email; implies --delegation (default: user.email)
  --delete-default-labels  delete GitHub's default labels outside Kanon's taxonomy
  --keep-default-labels  keep them (the default)
  --releaser             create the optional Releaser App; only for a repository that
                         calls Kanon's release workflow
  --no-releaser          don't (the default)
  --plugin               declare the kanon plugin in .claude/settings.json, pinned to this
                         release, for everyone who uses Claude Code here (the default)
  --no-plugin            don't
  --telemetry            send this repository's agent-run rows to Kanon's hosted telemetry
                         store: writes the collector's caller (docs/telemetry.md)
  --no-telemetry         don't (the default)
  --reuse-apps           where the owner already has an App the lanes lack (an installation
                         with exactly its permissions), reuse it with kanon apps --reuse
                         rather than create a second one (the default)
  --no-reuse-apps        create it anyway
  --create-apps          run \`kanon apps\` for the Apps the lanes lack (the default)
  --no-apps              don't run \`kanon apps\`; print the command instead

A flag init doesn't know, a value flag given twice or followed by a flag instead of its value,
or two flags that contradict each other (--help with --json among them) fail by name, and
change nothing. A value that begins with "-" is given as --flag=<value>.

Needs \`gh\`. Reading needs a token that can read the repository; creating labels and
milestones needs Issues: write; the merge setting and the ruleset need Administration: write; finding the owner's Apps needs an organisation owner's
token with Administration: read (on a personal account gh's token can't list them).
gh takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored login; the command prints
which one it uses and whose it is.`;

/**
 * The lane catalogue (docs/lanes.json, kanon#428) as the adopt skill asks it: a group at a
 * time, each lane with what it does, what it needs and costs, when it is recommended, and
 * whether it is recommended for this repository. What the release's requirements derive from
 * the lane itself (its App, its secrets, the QA store, its hooks, the documents it reads) comes
 * from them, never from the catalogue. A lane is recommended when the repository already calls
 * it, when the catalogue recommends it always (the review lane), or when it recommends it with a
 * lane that is itself recommended.
 * @param {Requirements} req @param {string[]} installed
 */
export const laneCatalogue = (req, installed) => {
  const cat = req.catalogue;
  if (!cat) return [];
  const entries = Object.entries(cat.lanes).filter(([lane]) => req.lanes[lane]);
  const recommended = new Set([...installed, ...entries.filter(([, e]) => e.recommend === 'always').map(([lane]) => lane)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [lane, e] of entries) {
      if (!recommended.has(lane) && Array.isArray(e.recommend) && e.recommend.some((w) => recommended.has(w))) {
        recommended.add(lane);
        grew = true;
      }
    }
  }
  return cat.groups.map((g) => ({
    group: g.id,
    title: g.title,
    header: g.header,
    lanes: entries
      .filter(([, e]) => e.group === g.id)
      .map(([lane, e]) => {
        const spec = /** @type {import('./callers.mjs').Lane} */ (req.lanes[lane]);
        return {
          lane,
          name: e.name,
          does: e.does,
          app: spec.identities[0] ?? null,
          secrets: spec.secrets,
          qaStore: spec.grant['id-token'] === 'write',
          hooks: spec.hooks,
          reads: spec.reads,
          schedule: TRIGGERS[lane]?.schedule ?? null,
          needs: e.needs,
          cost: e.cost,
          when: e.when,
          mergeQueue: e.mergeQueue ?? null,
          recommendedWith: e.recommend === 'always' ? [] : e.recommend,
          recommended: recommended.has(lane),
          installed: installed.includes(lane),
        };
      }),
  }));
};

/**
 * The usage text, with the lane catalogue's groups and lanes after the options, one line each.
 * @param {Requirements} req
 */
export const usage = (req) => {
  const groups = laneCatalogue(req, []);
  if (!groups.length) return USAGE;
  const lines = ['', 'The lanes, by group (docs/lanes.md, "The lane catalogue"); --lanes takes their names:'];
  for (const g of groups) {
    lines.push(`  ${g.title}`);
    for (const l of g.lanes) lines.push(`    ${l.lane.slice('agent-'.length).padEnd(18)} ${l.does}${l.recommendedWith.length ? ` (recommended with ${l.recommendedWith.map((w) => w.slice('agent-'.length)).join(' or ')})` : l.recommended ? ' (recommended)' : ''}`);
  }
  return `${USAGE}\n${lines.join('\n')}`;
};

/**
 * @typedef {{
 *   gh: (args: string[], input?: string) => Promise<GhResult>,
 *   git: (args: string[]) => GhResult,
 *   env: Record<string, string | undefined>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   readFile: (path: string) => string | null,
 *   listDir: (path: string) => string[],
 *   writeFile: (path: string, text: string) => void,
 *   ask: (question: string, fallback: string) => Promise<string>,
 *   apps: (argv: string[], io?: { out: (line: string) => void, err: (line: string) => void }) => Promise<number>,
 *   milestones: (argv: string[], io?: { out: (line: string) => void, err: (line: string) => void }) => Promise<number>,
 *   today: () => string,
 *   requirements: () => Requirements,
 *   release: () => string,
 * }} Deps
 */

/** @type {import('node:readline/promises').Interface | null} */
let rl = null;

/** @type {Deps} */
export const realDeps = {
  gh: (args, input) =>
    new Promise((done) => {
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => done({ status: null, stdout, stderr: String(e.message) }));
      child.on('close', (status) => done({ status, stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    }),
  git: (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
  },
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  listDir: (path) => (existsSync(path) && statSync(path).isDirectory() ? readdirSync(path) : []),
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  ask: async (question, fallback) => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${question} [${fallback}] `)).trim();
    return a || fallback;
  },
  apps: (argv, io) => runApps(argv, io),
  milestones: (argv, io) => runMilestones(argv, io),
  today: () => new Date().toISOString().slice(0, 10),
  requirements: loadRequirements,
  release: kanonRelease,
};

/**
 * The answer flags (#367), one per question `askAll` asks, and the Apps' question. Unset means
 * "not answered": the question takes its default with `--yes`, and is asked without it.
 * @typedef {{
 *   projectOwner?: string, maintainer?: string, stakeholder?: string, gates?: string, testDatabase?: 'none' | 'hook',
 *   delegation?: boolean, delegateName?: string, delegateEmail?: string, deleteDefaults?: boolean,
 *   releaser?: boolean, reuseApps?: boolean, plugin?: boolean, telemetry?: boolean, createApps?: boolean,
 * }} Given
 */

/** Pairs of flags that contradict each other, refused by name when both are given. */
/** @type {Array<[string, string]>} */
export const CONFLICTS = [
  ['--delegation', '--no-delegation'],
  ['--delegate-name', '--no-delegation'],
  ['--delegate-email', '--no-delegation'],
  ['--delete-default-labels', '--keep-default-labels'],
  ['--releaser', '--no-releaser'],
  ['--reuse-apps', '--no-reuse-apps'],
  ['--plugin', '--no-plugin'],
  ['--telemetry', '--no-telemetry'],
  ['--create-apps', '--no-apps'],
  // `--help` prints the usage, which is no document: with `--json` it would leave standard
  // output empty, so the pair is refused, and the refusal is the error document (#372).
  ['--help', '--json'],
];

/**
 * Parses `kanon init`'s arguments. Throws with a message naming the problem: an unknown flag, a
 * value flag given twice, a bad value, or two flags that contradict each other.
 * @param {string[]} argv @param {Requirements} req
 */
export const parseArgs = (argv, req) => {
  /** @type {{ repo: string, dir: string, lanes: string[] | null, yes: boolean, dryRun: boolean, json: boolean, apps: boolean, help: boolean, given: Given }} */
  const opts = { repo: '', dir: process.cwd(), lanes: null, yes: false, dryRun: false, json: false, apps: true, help: false, given: {} };
  const g = opts.given;
  /** @type {Set<string>} */
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      if (seen.has(flag)) throw new Error(`${flag} is given twice`);
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      // The next argument is a flag, not this one's value: an unset, unquoted variable leaves
      // `--project-owner --yes`, which would record "--yes" as the Owner (#372). A value that
      // does begin with "-" is given inline, `--gates=-x`.
      if (inline === undefined && v.startsWith('-')) throw new Error(`${flag} needs a value, not the flag "${v}"; to give a value that begins with "-", write ${flag}=<value>`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--lanes') opts.lanes = parseLanes(value(), req);
    else if (flag === '--yes') opts.yes = true;
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--json') opts.json = true;
    else if (flag === '--no-apps') opts.apps = false;
    else if (flag === '--create-apps') g.createApps = true;
    else if (flag === '--project-owner') g.projectOwner = value();
    else if (flag === '--maintainer') g.maintainer = value();
    else if (flag === '--stakeholder') g.stakeholder = value();
    else if (flag === '--gates') g.gates = value();
    else if (flag === '--test-database') {
      const v = value();
      if (v !== 'none' && v !== 'hook') throw new Error(`--test-database takes none or hook, not "${v}"`);
      g.testDatabase = v;
    } else if (flag === '--delegation') g.delegation = true;
    else if (flag === '--no-delegation') g.delegation = false;
    else if (flag === '--delegate-name') g.delegateName = value();
    else if (flag === '--delegate-email') g.delegateEmail = value();
    else if (flag === '--delete-default-labels') g.deleteDefaults = true;
    else if (flag === '--keep-default-labels') g.deleteDefaults = false;
    else if (flag === '--releaser') g.releaser = true;
    else if (flag === '--no-releaser') g.releaser = false;
    else if (flag === '--reuse-apps') g.reuseApps = true;
    else if (flag === '--no-reuse-apps') g.reuseApps = false;
    else if (flag === '--plugin') g.plugin = true;
    else if (flag === '--no-plugin') g.plugin = false;
    else if (flag === '--telemetry') g.telemetry = true;
    else if (flag === '--no-telemetry') g.telemetry = false;
    // `--owner` names the GitHub account everywhere else (`kanon apps --owner`), so init's Owner
    // question is `--project-owner`, and a bare `--owner` is refused with that name (Owner, 2026-10-06).
    else if (flag === '--owner') throw new Error('unknown argument "--owner": the project\'s Owner is --project-owner; --owner names the GitHub account, in kanon apps');
    else throw new Error(`unknown argument "${arg}"`);
    if (inline !== undefined && !['--repo', '--dir', '--lanes', '--project-owner', '--maintainer', '--stakeholder', '--gates', '--test-database', '--delegate-name', '--delegate-email'].includes(flag)) {
      throw new Error(`${flag} takes no value, not "${inline}"`);
    }
    seen.add(flag === '-h' ? '--help' : flag);
  }
  for (const [x, y] of CONFLICTS) if (seen.has(x) && seen.has(y)) throw new Error(`${x} and ${y} contradict each other; give one`);
  if (g.delegateName !== undefined || g.delegateEmail !== undefined) g.delegation = true;
  if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo takes <owner>/<repo>, not "${opts.repo}"`);
  // `--json` asks nothing (docs/cli-json.md): each question takes its flag or its default.
  if (opts.json) opts.yes = true;
  return opts;
};

/**
 * A comma-separated list of lanes, each with or without its `agent-` prefix and `.yml`.
 * @param {string} list @param {Requirements} req
 */
export const parseLanes = (list, req) => {
  const lanes = [...new Set(list.split(',').map((l) => l.trim().replace(/\.yml$/, '')).filter(Boolean).map((l) => (l.startsWith('agent-') ? l : `agent-${l}`)))];
  for (const l of lanes) {
    if (!req.lanes[l]) throw new Error(`"${l}" is not a Kanon lane; the lanes are ${Object.keys(req.lanes).map((k) => k.slice('agent-'.length)).join(', ')}`);
  }
  if (!lanes.length) throw new Error('--lanes names no lane');
  return lanes;
};

/**
 * The identities the chosen lanes run as, read from the secrets each declares.
 * @param {string[]} lanes @param {Requirements} req
 */
export const identitiesOf = (lanes, req) => [...new Set(lanes.flatMap((l) => req.lanes[l]?.identities ?? []))].sort();

/**
 * The register rows (`K-LAYOUT-6`, a row per role) an identity needs: a role's own row, or every
 * row of an App's roles.
 * @param {string} identity @param {Requirements} req
 */
export const registerRolesOf = (identity, req) => {
  const role = req.identities.roles[identity];
  if (role) return [role.name];
  const app = req.identities.apps[identity];
  if (app) return app.roles.map((r) => req.identities.roles[r]?.name ?? r[0]?.toUpperCase() + r.slice(1));
  throw new Error(`the lanes run as "${identity}", which rulebook/agent-permissions.json names neither as a role nor as an App`);
};

/**
 * `kanon apps`'s flag for these identities: `--apps`, for the Apps of ADR 0013 (plan 0005 step
 * L4). A role is no identity since L4, so a requirements file that names one is from a release
 * whose lanes disagree with this `kanon apps`, and is refused by name.
 * @param {string[]} identities @param {Requirements} req
 */
export const appsArgs = (identities, req) => {
  const roles = identities.filter((i) => !req.identities.apps[i]);
  if (roles.length) {
    throw new Error(`the lanes run as ${roles.join(', ')}, which ${roles.length > 1 ? 'are' : 'is'} not one of Kanon's Apps (${Object.keys(req.identities.apps).join(', ')}); this release's lanes and its kanon apps disagree`);
  }
  return ['--apps', identities.join(',')];
};

/** The optional Releaser's identity (plan 0005 §3.1), taken by Kanon's release workflow alone. */
export const RELEASER = 'releaser';

/**
 * The Apps `init` creates and checks: the Author and the Judge, as the chosen lanes need them,
 * and the Releaser when the adopter asked for it.
 * @param {{ lanes: string[], releaser?: boolean }} a @param {Requirements} req
 */
export const appIdentities = (a, req) => [...identitiesOf(a.lanes, req), ...(a.releaser ? [RELEASER] : [])];

/**
 * Whether the repository calls Kanon's release workflow, at the path docs/release.md gives its
 * caller: the one place the optional Releaser's secrets are mapped.
 * @param {string | null} text the caller's text, or null
 */
export const callsRelease = (text) => /^\s*uses:\s*yedeya-labs\/kanon\/\.github\/workflows\/release\.yml@/m.test(text ?? '');

/**
 * The roles the App register lists, with their slugs, read as `lane-check`'s reader reads it:
 * the one table outside a fence headed `| Role | App slug |`.
 * @param {string | null} text
 * @returns {Map<string, string>}
 */
export const registerRows = (text) => {
  /** @type {Map<string, string>} */
  const rows = new Map();
  if (!text) return rows;
  let fenced = false;
  let inTable = false;
  for (const line of text.split('\n')) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      fenced = !fenced;
      inTable = false;
      continue;
    }
    if (fenced) continue;
    if (!/^[ \t]*\|/.test(line)) {
      inTable = false;
      continue;
    }
    const c = line.split('|').slice(1, -1).map((s) => s.trim().replace(/^\*\*(.*)\*\*$/, '$1').trim());
    if (!inTable) {
      inTable = c[0] === 'Role' && c[1] === 'App slug';
      continue;
    }
    if (/^:?-+:?$/.test(c[0] ?? '')) continue;
    const slug = /^`([a-z0-9]+(?:-[a-z0-9]+)*)`$/.exec(c[1] ?? '')?.[1];
    if (c[0] && slug) rows.set(c[0], slug);
  }
  return rows;
};

/**
 * The gates the repository suggests, from what it holds: an npm project's scripts, a Makefile's
 * `test` target, a Cargo or Go module. The stack document's `## Gates` has no default (plan 0005
 * §5.2), so `init` offers these for the adopter to accept or edit.
 * @param {(rel: string) => string | null} read
 */
export const suggestGates = (read) => {
  const gates = [];
  const pkg = read('package.json');
  if (pkg) {
    try {
      const scripts = JSON.parse(pkg).scripts ?? {};
      for (const s of ['lint', 'typecheck', 'test', 'build']) if (scripts[s]) gates.push(s === 'test' ? 'npm test' : `npm run ${s}`);
    } catch {
      // An unreadable package.json suggests nothing.
    }
  }
  if (/^test:/m.test(read('Makefile') ?? '')) gates.push('make test');
  if (read('Cargo.toml')) gates.push('cargo test');
  if (read('go.mod')) gates.push('go test ./...');
  return gates;
};

/**
 * A line diff of two texts, `-` and `+` for what changes, ` ` for context, by longest common
 * subsequence: the files `init` writes are short.
 * @param {string} a @param {string} b
 */
export const lineDiff = (a, b) => {
  const x = a.split('\n');
  const z = b.split('\n');
  const n = x.length;
  const m = z.length;
  // t[i * (m + 1) + j]: the longest common subsequence of x[i..] and z[j..].
  const t = new Int32Array((n + 1) * (m + 1));
  const at = (/** @type {number} */ i, /** @type {number} */ j) => t[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * (m + 1) + j] = x[i] === z[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === z[j]) {
      out.push(`  ${x[i]}`);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) out.push(`- ${x[i++]}`);
    else out.push(`+ ${z[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${z[j++]}`);
  return out;
};

/** @param {GhResult} r */
const why = (r) => r.stderr.trim() || `exit ${r.status}`;

/**
 * A `gh api` call parsed as JSON; `--paginate --slurp` lists come back flat.
 * @param {Deps} deps @param {string[]} args
 * @returns {Promise<{ ok: true, json: any } | { ok: false, r: GhResult }>}
 */
const ghJson = async (deps, args) => {
  const r = await deps.gh(args);
  if (r.status !== 0) return { ok: false, r };
  try {
    const json = JSON.parse(r.stdout);
    return { ok: true, json: args.includes('--slurp') ? json.flat() : json };
  } catch {
    return { ok: false, r: { ...r, stderr: `GitHub's answer to ${args.join(' ')} was not JSON` } };
  }
};

/**
 * Step 1: everything `init` reads from GitHub, read-only.
 * @param {Deps} deps @param {string} repo
 */
export const inspect = async (deps, repo) => {
  const meta = await ghJson(deps, ['api', `repos/${repo}`]);
  if (!meta.ok) throw new Error(`could not read ${repo} (${why(meta.r)})`);
  const r = meta.json;
  const owner = String(r.owner?.login ?? repo.split('/')[0]);
  const kind = r.owner?.type === 'Organization' ? 'Organization' : 'User';
  const isPrivate = Boolean(r.private);
  const defaultBranch = String(r.default_branch ?? 'main');
  const admin = Boolean(r.permissions?.admin);
  const branch = await deps.gh(['api', `repos/${repo}/branches/${encodeURIComponent(defaultBranch)}`, '--jq', '.name']);
  const hasCommits = branch.status === 0;

  // Rulesets: a private repository on a plan without them answers 403 "Upgrade to GitHub Pro".
  const rs = await ghJson(deps, ['api', `repos/${repo}/rulesets?includes_parents=true&per_page=100`]);
  /** @type {'yes' | 'no' | 'unknown'} */
  let rulesets = 'unknown';
  /** @type {any[]} */
  let rulesetList = [];
  if (rs.ok) {
    rulesets = 'yes';
    rulesetList = rs.json;
  } else if (/upgrade to github pro|make this repository public/i.test(rs.r.stderr)) rulesets = 'no';
  else if (!isPrivate) rulesets = 'yes';

  // The merge queue: an organisation's public repository, or an Enterprise Cloud organisation's
  // private one (K-ADOPT-3). A personal account has none.
  /** @type {'yes' | 'no' | 'unknown'} */
  let mergeQueue = 'no';
  if (kind === 'Organization') {
    if (!isPrivate) mergeQueue = 'yes';
    else {
      const org = await ghJson(deps, ['api', `orgs/${owner}`]);
      const plan = org.ok ? String(org.json?.plan?.name ?? '') : '';
      mergeQueue = plan ? (/enterprise/i.test(plan) ? 'yes' : 'no') : 'unknown';
    }
  }

  // The rulesets that cover the default branch, read whole: the list carries no rules. Only an
  // `active` one enforces anything; a `disabled` or `evaluate` one is kept apart and reported.
  const { covering, inactive } = await coveringRulesets(deps.gh, repo, rulesetList, defaultBranch);

  const labels = await ghJson(deps, ['api', '--paginate', '--slurp', `repos/${repo}/labels?per_page=100`]);
  if (!labels.ok) throw new Error(`could not list the labels of ${repo} (${why(labels.r)})`);
  const ms = await ghJson(deps, ['api', '--paginate', '--slurp', `repos/${repo}/milestones?state=all&per_page=100`]);
  if (!ms.ok) throw new Error(`could not list the milestones of ${repo} (${why(ms.r)})`);
  const secrets = await ghJson(deps, ['secret', 'list', '-R', repo, '--json', 'name']);

  return {
    owner,
    kind,
    isPrivate,
    defaultBranch,
    admin,
    hasCommits,
    rulesets,
    mergeQueue,
    covering,
    inactive,
    settings: {
      allow_squash_merge: r.allow_squash_merge,
      allow_merge_commit: r.allow_merge_commit,
      allow_rebase_merge: r.allow_rebase_merge,
      squash_merge_commit_title: r.squash_merge_commit_title,
      squash_merge_commit_message: r.squash_merge_commit_message,
    },
    labels: new Set(labels.json.map((/** @type {any} */ l) => String(l.name))),
    milestones: new Set(ms.json.map((/** @type {any} */ m) => String(m.title))),
    /** @type {Set<string> | null} null when the token can't list them */
    secrets: secrets.ok ? new Set(secrets.json.map((/** @type {any} */ s) => String(s.name))) : null,
  };
};

/** @typedef {Awaited<ReturnType<typeof inspect>>} Inspection */

/** The merge settings of `K-SHIP-3`: squash only, the PR's title and body as the commit's. */
export const MERGE_SETTINGS = { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' };

/** The rule that requires `lane-check`'s status check. */
const CHECK_RULE = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: LANE_CHECK }] } };

/**
 * The default branch's ruleset (K-ADOPT-1 step 8): a pull request with no required approval yet
 * (bootstrap, K-ADOPT-6), squash only, no force-push or deletion, `lane-check` required once a
 * job on the default branch reports it (#444), and the merge queue where the plan has one.
 * @param {boolean} mergeQueue @param {boolean} [requireCheck]
 */
export const rulesetBody = (mergeQueue, requireCheck = true) => ({
  name: RULESET_NAME,
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        allowed_merge_methods: ['squash'],
      },
    },
    ...(requireCheck ? [CHECK_RULE] : []),
    ...(mergeQueue
      ? [
          {
            type: 'merge_queue',
            parameters: {
              merge_method: 'SQUASH',
              grouping_strategy: 'ALLGREEN',
              min_entries_to_merge: 1,
              max_entries_to_build: 5,
              max_entries_to_merge: 5,
              min_entries_to_merge_wait_minutes: 5,
              check_response_timeout_minutes: 60,
            },
          },
        ]
      : []),
  ],
});

/**
 * Whether the default branch merges through a merge queue (#459): one of the rulesets that cover
 * it has one, or, where none covers it yet, the ruleset `init` creates or asks for has one, on a
 * plan that has the queue (`rulesetBody`).
 * @param {{ rulesets: string, mergeQueue: string, covering: any[] }} s
 */
export const mergesThroughQueue = (s) => (s.covering.length ? mergeQueueOn(s.covering) : s.rulesets !== 'no' && s.mergeQueue === 'yes');

/** The gap `rulesetGaps` names for a status check the ruleset doesn't require. @param {string} check */
export const requiredCheckGap = (check) => `require the status check "${check}"`;

/**
 * What the rulesets covering the default branch lack of `K-ADOPT-1` step 8, one line each.
 * @param {any[]} covering
 */
export const rulesetGaps = (covering) => {
  const rules = covering.flatMap((s) => s.rules ?? []);
  const has = (/** @type {string} */ t) => rules.some((r) => r.type === t);
  const gaps = [];
  if (!has('pull_request')) gaps.push('require a pull request before merging');
  if (!has('non_fast_forward')) gaps.push('block force pushes');
  if (!has('deletion')) gaps.push('restrict deletions');
  const methods = rules.filter((r) => r.type === 'pull_request').flatMap((r) => r.parameters?.allowed_merge_methods ?? ['merge', 'squash', 'rebase']);
  if (has('pull_request') && methods.some((m) => m !== 'squash')) gaps.push('allow the squash merge method only');
  const checks = rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
  if (!checks.includes(LANE_CHECK)) gaps.push(requiredCheckGap(LANE_CHECK));
  return gaps;
};

/**
 * The answers: each from its flag when one was given (#367), else asked with a default, or the
 * default itself with `--yes`.
 * @param {Deps} deps @param {{ yes: boolean, lanes: string[] | null, given?: Given }} opts @param {{ login: string, gates: string[], gitName: string, gitEmail: string, req: Requirements, defaultLanes: string[], releases?: boolean, reusable?: (identities: string[]) => Array<{ app: string, slug: string }> }} ctx
 */
export const askAll = async (deps, opts, ctx) => {
  const g = opts.given ?? {};
  const ask = (/** @type {string} */ q, /** @type {string} */ d, /** @type {string | undefined} */ given) =>
    given !== undefined ? Promise.resolve(given) : opts.yes ? Promise.resolve(d) : deps.ask(q, d);
  const yesNo = async (/** @type {string} */ q, /** @type {boolean} */ d, /** @type {boolean | undefined} */ given) =>
    given !== undefined ? given : /^y/i.test(await ask(`${q} (y/n)`, d ? 'y' : 'n', undefined));
  const owner = await ask('Who is the Owner (K-ADOPT-1 step 2)?', ctx.login, g.projectOwner);
  const maintainer = await ask('Who is the Maintainer?', owner, g.maintainer);
  const stakeholder = await ask('Who is the Stakeholder?', owner, g.stakeholder);
  const lanes = opts.lanes ?? parseLanes(await ask(`Which lanes to install? (${Object.keys(ctx.req.lanes).map((l) => l.slice(6)).join(', ')})`, ctx.defaultLanes.map((l) => l.slice(6)).join(','), undefined), ctx.req);
  const gatesAnswer = await ask("The stack's gates, the commands a change must pass, comma-separated", ctx.gates.join(', ') || 'none yet', g.gates);
  const gates = /^none( yet)?$/i.test(gatesAnswer.trim()) ? [] : gatesAnswer.split(',').map((x) => x.trim()).filter(Boolean);
  const database = /^hook$/i.test(await ask('Does a lane need a test database your project-setup hook starts? (none/hook)', 'none', g.testDatabase)) ? 'hook' : 'none';
  const delegate = await yesNo("Record a sign-off delegation, so agents' commits pass a required dco check (K-AGENT-44)?", false, g.delegation);
  let delegation = null;
  if (delegate) {
    delegation = { name: await ask('The delegate, as their sign-off writes their name', ctx.gitName, g.delegateName), email: await ask("The delegate's email", ctx.gitEmail, g.delegateEmail) };
  }
  const deleteDefaults = await yesNo("Delete GitHub's default labels that aren't in Kanon's taxonomy?", false, g.deleteDefaults);
  // THE OPTIONAL RELEASER (plan 0005 §3.1), asked only of a repository that calls Kanon's release
  // workflow, and no by default: moving to it moves the ruleset's bypass too (`kanon apps` adds the
  // Releaser's; the admin's goes once the pinned dco check exempts the Releaser, #337, #49), and
  // release PRs then merge through the front door (docs/release.md, "With the Releaser"). `init`
  // refuses `--releaser` for a repository that doesn't call it, before asking anything.
  const releaser = ctx.releases
    ? await yesNo('Create the optional Releaser App, so the release PR runs CI (docs/release.md, "With the Releaser")?', false, g.releaser)
    : false;
  // AN APP THE OWNER ALREADY HAS (#363; the Owner, 2026-10-07): one Author and one Judge per
  // owner, reused across its repositories (plan 0005 §3.2). Asked only when the owner's
  // installations hold an App the chosen lanes need and this register lacks; yes by default,
  // since a second set doubles the Apps and keys the owner manages. Null when not asked.
  const found = ctx.reusable?.(appIdentities({ lanes, releaser }, ctx.req)) ?? [];
  const reuseApps = found.length ? await yesNo(reuseQuestion(found, ctx.req), true, g.reuseApps) : null;
  // THE KANON PLUGIN (#376), declared at project scope so its release is in the repository, where
  // Dependabot's bump and doctor's check can be read beside it (docs/skills.md). Yes by default:
  // the declaration does nothing until each person trusts the folder in Claude Code.
  const plugin = await yesNo("Declare the kanon plugin in .claude/settings.json, pinned to this release, so everyone who uses Claude Code here gets Kanon's skills (docs/skills.md)?", true, g.plugin);
  // TELEMETRY (#428), no by default and never without an explicit yes: it sends this
  // repository's run rows out of it, to Kanon's hosted store (plan 0002, docs/telemetry.md).
  const telemetry = await yesNo(TELEMETRY_QUESTION, false, g.telemetry);
  return { owner, maintainer, stakeholder, lanes, gates, database, delegation, deleteDefaults, releaser, reuseApps, plugin, telemetry };
};

/**
 * The question for Apps the owner already has (#363).
 * @param {Array<{ app: string, slug: string }>} found @param {Requirements} req
 */
export const reuseQuestion = (found, req) => {
  const name = (/** @type {string} */ app) => req.identities.apps[app]?.name ?? app;
  const apps = [...new Set(found.map((f) => f.app))];
  const list = apps.map((app) => `the ${name(app)} (${found.filter((f) => f.app === app).map((f) => f.slug).join(' or ')})`).join(' and ');
  return `The owner already has ${list}, installed with exactly ${apps.length > 1 ? 'their' : 'its'} permissions. Reuse ${apps.length > 1 ? 'them' : 'it'} here with kanon apps --reuse, rather than create a second ${apps.length > 1 ? 'set' : 'one'}?`;
};

/**
 * The telemetry question (#428), saying what is sent, where, who reads it, and how to stop and
 * erase it, from plan 0002 and docs/telemetry.md.
 */
export const TELEMETRY_QUESTION =
  "Send this repository's agent-run rows to Kanon's hosted telemetry store? Each row is plan 0002's fixed fields about one lane run (lane, outcome, model, cost, tokens, durations, counts, the run, pull request and issue numbers, the Kanon release): no code, no text, no logins or file paths. They go to one table in Kanon's AWS account in Frankfurt (eu-central-1), under an opaque key, and are kept 13 months. Kanon's operator reads them to improve Kanon, and publishes only aggregates of at least three adopters; your repository's own reader role reads only its rows. Stop by deleting .github/workflows/telemetry.yml; the operator erases what was sent on request (docs/telemetry.md, \"Erase an adopter\").";

/** @typedef {Awaited<ReturnType<typeof askAll>>} Answers */

/** The repository variables the telemetry collector's caller passes (docs/telemetry.md). */
export const TELEMETRY_VARIABLES = ['KANON_TELEMETRY_URL', 'KANON_TELEMETRY_WRITER_ROLE'];

/** Where an adopter asks Kanon's operator to register a repository with the telemetry store. */
export const TELEMETRY_REGISTRATION_URL = 'https://github.com/yedeya-labs/kanon/issues/new?template=telemetry-registration.yml';

/**
 * The step left to a person once the collector's caller is written: the operator registers the
 * repository and gives the two variables' values. `init` and `doctor` print the same one.
 * @param {string} repo @param {string[]} unset the variables not set @param {boolean} readable whether the token could list them
 */
export const telemetryStep = (repo, unset, readable) => ({
  id: 'telemetry.register',
  category: 'telemetry',
  subject: repo,
  prose: `Ask Kanon's operator to register ${repo} with the telemetry store (an issue from the template below; it names the repository publicly), then set the two variables the operator gives you:`,
  message: readable
    ? `${repo} calls Kanon's telemetry collector, and ${unset.join(' and ')} ${unset.length > 1 ? 'are' : 'is'} not set, so it sends nothing yet: the collector skips with a warning.`
    : `${repo} calls Kanon's telemetry collector, and the token can't list its variables, so whether ${TELEMETRY_VARIABLES.join(' and ')} are set is not known; until both are, it sends nothing.`,
  text: "The store's register entry and the two variables' values are Kanon's operator's to give (docs/telemetry.md, \"Add a repository\"): ask for them with the telemetry registration issue, then set both variables.",
  commands: [
    `gh variable set KANON_TELEMETRY_URL -R ${repo} --body '<the URL the operator gives you>'`,
    `gh variable set KANON_TELEMETRY_WRITER_ROLE -R ${repo} --body '<the role ARN the operator gives you>'`,
  ],
  url: TELEMETRY_REGISTRATION_URL,
});

/** @param {string} who */
const person = (who) => (/^[A-Za-z0-9-]+$/.test(who) ? `\`@${who}\`` : who);

/**
 * The adoption record (`K-LAYOUT-10`), with what `init` knows: the people, the plan and its
 * fallbacks, and the bootstrap line. `## Choices` only when a choice differs from its default.
 * @param {Inspection} s @param {Answers} a @param {string} repo @param {string} today
 */
export const adoptionFile = (s, a, repo, today) => {
  const account = s.kind === 'User' ? 'a personal account' : 'an organisation';
  const lines = [
    '# Adoption record',
    '',
    `\`${repo}\` adopts Kanon. This is its adoption record (\`K-LAYOUT-10\`), started by \`kanon init\` on ${today}. A section or choice it leaves out means its documented default.`,
    '',
    '## People',
    '',
    '| Role | Who |',
    '|---|---|',
    `| Owner | ${person(a.owner)} |`,
    `| Maintainer | ${person(a.maintainer)} |`,
    `| Stakeholder | ${person(a.stakeholder)} |`,
    '',
  ];
  if (s.kind === 'User') lines.push("On a personal account a collaborator has write access, with no Triage role, so a Stakeholder who is a collaborator holds more than chapter 03's Triage (`K-ADOPT-2`).", '');
  lines.push('## Plan', '', `\`${repo}\` is a **${s.isPrivate ? 'private' : 'public'} repository on ${account}** (\`K-ADOPT-2\`). Of the platform features of \`K-ADOPT-3\`:`, '');
  lines.push(
    s.rulesets === 'no'
      ? '- **Rulesets:** not on this plan, and there is no fallback. The repository stays in bootstrap and can\'t leave it: every lane runs, and the Merger merges only what the Reviewer approved, but nothing on the platform refuses a merge without an approval (`K-ADOPT-3`, `K-ADOPT-6`).'
      : `- **Rulesets:** ${s.rulesets === 'yes' ? 'available' : 'not known; check the repository\'s settings'}.`,
  );
  lines.push(
    s.mergeQueue === 'yes'
      ? '- **Merge queue:** available.'
      : s.mergeQueue === 'unknown'
        ? "- **Merge queue:** not known: the token can't read the organisation's plan. Without one, \"require branches to be up to date\" stays off (`K-MERGE-7`)."
        : '- **Merge queue:** not on this plan, so "require branches to be up to date" stays off and the release commit\'s full CI run catches a stale base (`K-MERGE-7`).',
  );
  lines.push('- **Environments:** no Kanon lane needs one.', '', '## Bootstrap', '', `\`in bootstrap since ${today}\``, '');
  if (a.lanes.includes('agent-overseer')) lines.push('## Choices', '', '- **Overseer:** `installed`', '');
  return lines.join('\n');
};

/**
 * The stack document (`K-LAYOUT-17`): `## Gates`, which has no default, and nothing else.
 * @param {string[]} gates
 */
export const stackFile = (gates) =>
  [
    '# Stack',
    '',
    "The project's stack document (`K-LAYOUT-17`), started by `kanon init`. The sections it leaves out mean their documented defaults: no schema changes, nothing to isolate, no generated files, and the whole repository as code.",
    '',
    '## Gates',
    '',
    ...(gates.length ? gates.map((g, i) => `${i + 1}. \`${g}\``) : ['None yet: list the commands a change must pass, in the order to run them.']),
    '',
  ].join('\n');

/** The sign-off delegation (`K-LAYOUT-14`). @param {{ name: string, email: string }} d @param {string} today */
export const delegationFile = (d, today) =>
  [
    '# Sign-off delegation',
    '',
    `${d.name} signs off this repository's agent commits (\`K-AGENT-44\`): an agent's commit carries their \`Signed-off-by:\`.`,
    '',
    '| Delegate | Email | Delegated on |',
    '|---|---|---|',
    `| ${d.name} | ${d.email} | ${today} |`,
    '',
  ].join('\n');

export const TEST_DATABASE_HOOK = ['# Test database', '', 'The project-setup hook starts the database and writes `DATABASE_URL` (`K-LAYOUT-16`).', '', '**Test database:** `hook`', ''].join('\n');

/** What a YAML double-quoted escape stands for; one not listed is kept as written. */
const ESCAPES = /** @type {Record<string, string>} */ ({ '"': '"', '\\': '\\', '/': '/', ' ': ' ', t: '\t', n: '\n' });

/**
 * The name GitHub gives a workflow, which a `workflow_run` trigger names it by: its top-level
 * `name:`, unquoted and without a trailing comment, or, with none, its path in the repository.
 * A `#` inside a quoted name is part of it; only a plain name loses a ` # comment` (#335).
 * @param {string} text @param {string} path
 */
export const workflowName = (text, path) => {
  const line = /^name:[ \t]*(.*)$/m.exec(text)?.[1] ?? '';
  const [, double, single] = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')/.exec(line) ?? [];
  const value =
    double !== undefined ? double.replace(/\\(.)/g, (e, c) => ESCAPES[c] ?? e)
    : single !== undefined ? single.replace(/''/g, "'")
    : line.replace(/(^|\s+)#.*$/, '');
  return value.trim() || path;
};

/** Where `init` writes `lane-check`'s own workflow. */
const LANE_CHECK_PATH = '.github/workflows/lane-check.yml';

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The checkout's workflows, parsed, by path. A file that doesn't parse is left out: lane-check
 * and doctor say so.
 * @param {Deps} deps @param {string} root
 * @returns {Map<string, Record<string, any>>}
 */
export const checkoutWorkflows = (deps, root) => {
  /** @type {Map<string, Record<string, any>>} */
  const out = new Map();
  for (const name of deps.listDir(join(root, '.github/workflows')).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const rel = `.github/workflows/${name}`;
    try {
      const doc = parseYaml(deps.readFile(join(root, rel)) ?? '');
      if (isMap(doc)) out.set(rel, doc);
    } catch {
      // Left out, as above.
    }
  }
  return out;
};

/** The `uses:` line of a caller of `lane`. @param {string} lane */
const callsLane = (lane) => `uses: yedeya-labs/kanon/.github/workflows/${lane}.yml@`;

/**
 * Where each lane's caller lives (#451): at its lane's file name, `.github/workflows/<lane>.yml`
 * (`K-LAYOUT-18`), unless the file there doesn't call the lane and the adoption record waives
 * `caller.misplaced` on a file that does (#390). In a repository that hosts Kanon's lanes, the
 * lane's file name holds the lane itself, so its caller lives at the path the waiver names, and
 * init compares and writes it there. Only a waived file that already calls the lane names it: a
 * waiver says nothing of which lane a file it doesn't hold yet would call.
 * @param {string[]} lanes @param {(rel: string) => string | null} read
 * @param {string[]} waived the subjects of the record's `caller.misplaced` waivers, in its order
 * @returns {Map<string, string>} lane → path from the checkout's root
 */
export const callerPaths = (lanes, read, waived) => {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const lane of lanes) {
    const own = `.github/workflows/${lane}.yml`;
    const declared = (read(own) ?? '').includes(callsLane(lane)) ? undefined : waived.find((p) => (read(p) ?? '').includes(callsLane(lane)));
    out.set(lane, declared ?? own);
  }
  return out;
};

/**
 * Every file `init` would write, by path relative to the checkout. A file it leaves to its
 * default is not here.
 * @param {{ s: Inspection, a: Answers, req: Requirements, release: string, repo: string, today: string, read: (rel: string) => string | null, workflows: Map<string, Record<string, any>>, callers?: Map<string, string> }} c
 *   `workflows`: the checkout's, parsed, by path (`checkoutWorkflows`); `callers`: where each
 *   lane's caller lives, when not at its lane's file name (`callerPaths`)
 * @returns {Map<string, string>}
 */
export const plannedFiles = ({ s, a, req, release, repo, today, read, workflows, callers = new Map() }) => {
  /** @type {Map<string, string>} */
  const files = new Map();
  files.set('docs/qa/adoption.md', adoptionFile(s, a, repo, today));
  files.set('docs/qa/stack.md', stackFile(a.gates));
  if (a.delegation) files.set('docs/qa/sign-off-delegation.md', delegationFile(a.delegation, today));
  if (a.database === 'hook') files.set('docs/qa/test-database.md', TEST_DATABASE_HOOK);
  files.set(req.hook.path, hookFile(req.hook.inputs));

  const ci = read('.github/workflows/ci.yml');
  const ciName = ci === null ? 'CI' : workflowName(ci, '.github/workflows/ci.yml');
  for (const lane of a.lanes) {
    const path = callers.get(lane) ?? `.github/workflows/${lane}.yml`;
    files.set(path, callerFile(lane, /** @type {import('./callers.mjs').Lane} */ (req.lanes[lane]), { release, ciName, defaultBranch: s.defaultBranch, path }));
  }
  const identities = appIdentities(a, req);
  if (identities.length) files.set('.github/workflows/apps-check.yml', appsCheckFile(identities, release));
  if (!ci) files.set('.github/workflows/ci.yml', ciFile(release, s.defaultBranch));
  // `lane-check` gets a workflow of its own unless another workflow has a job that reports its
  // check on every pull request: a step that uses the action in another job reports nothing
  // under that name (#444, L5's G14).
  else if (!checkReporters(new Map([...workflows].filter(([f]) => f !== LANE_CHECK_PATH)), LANE_CHECK, s.defaultBranch).length) files.set(LANE_CHECK_PATH, laneCheckFile(release));
  if (!read('.github/dependabot.yml')) files.set('.github/dependabot.yml', dependabotFile());
  // The plugin's declaration is written only into a project that has no settings file yet; one it
  // has is the project's, and the keys to merge into it are a finding (`plugin.declare`).
  const settings = read(SETTINGS_PATH);
  if (a.plugin && (settings === null || settings === pluginSettingsFile(release))) files.set(SETTINGS_PATH, pluginSettingsFile(release));
  // The telemetry collector's caller, only on an explicit yes (#428).
  if (a.telemetry === true) files.set(TELEMETRY_CALLER_PATH, telemetryCallerFile(release));
  return files;
};

/** The JSON output's contract (docs/init.md). A breaking change to it changes this. */
export const SCHEMA = 'kanon-init/v1';

/**
 * Something left to a person or a program, in the finding shape every `kanon` command's JSON
 * shares (docs/cli-json.md).
 * @typedef {{ id: string, category: string, blocking: boolean, subject: string, message: string, fix: { text: string, commands: string[], url: string | null } }} Finding
 */

/**
 * The JSON document `init` prints with `--json` (docs/init.md), filled in as it runs. `error` is
 * set only when it stopped before inspecting the repository, so nothing changed.
 * @typedef {{
 *   repository: string | null,
 *   token: { source: string, login: string | null } | null,
 *   dryRun: boolean,
 *   inspection: Record<string, unknown> | null,
 *   answers: Record<string, unknown> | null,
 *   catalogue: ReturnType<typeof laneCatalogue>,
 *   files: Array<{ path: string, status: 'new' | 'same' | 'kept' | 'differs', content: string | null, diff: string[] }>,
 *   changes: Array<{ kind: string, subject: string, message: string }>,
 *   apps: { identities: string[], missing: string[], reuse: Array<{ app: string, slug: string }>, command: string | null, outcome: string, exitCode: number | null } | null,
 *   findings: Finding[],
 *   notes: string[],
 *   failures: string[],
 *   error: string | null,
 * }} Report
 */

/**
 * `kanon init`. Returns the exit code: 0 when it ran (manual steps may remain, and are printed),
 * 1 when something failed, 2 on a usage error. With `--json`, the same exit code, one JSON
 * document on standard output, and the prose on standard error.
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const init = async (argv, overrides = {}) => {
  const base = { ...realDeps, ...overrides };
  /** @type {Requirements | null} */
  let req = null;
  /** @type {string | null} the release's requirements file could not be read */
  let reqError = null;
  try {
    req = base.requirements();
  } catch (e) {
    reqError = `could not read this release's requirements file (${/** @type {Error} */ (e).message}). Nothing was changed.`;
  }
  /** @type {ReturnType<typeof parseArgs> | null} */
  let opts = null;
  /** @type {string | null} */
  let usageError = null;
  if (req) {
    try {
      opts = parseArgs(argv, req);
    } catch (e) {
      usageError = /** @type {Error} */ (e).message;
    }
  }
  // Under `--json` standard output holds the document alone: the prose moves to standard error.
  // Whether the run is under `--json` is what the parse says, so a "--json" taken as a value
  // can't print a document from a run that asks questions (#372); only arguments that don't
  // parse fall back to whether "--json" is among them, to print the error document.
  const wantsJson = opts ? opts.json : argv.includes('--json');
  /** @type {Deps} */
  const deps = wantsJson ? { ...base, out: base.err } : base;
  const { out, err } = deps;
  /** @type {Report} */
  const rep = { repository: null, token: null, dryRun: false, inspection: null, answers: null, catalogue: [], files: [], changes: [], apps: null, findings: [], notes: [], failures: [], error: null };
  const emit = (/** @type {number} */ code) => {
    if (wantsJson) base.out(JSON.stringify(document(rep, code, deps.release()), null, 2));
    return code;
  };
  if (!req) {
    rep.error = reqError;
    err(`kanon init: ${rep.error}`);
    return emit(1);
  }
  if (!opts) {
    rep.error = usageError;
    err(`kanon init: ${rep.error}`);
    err(usage(req));
    return emit(2);
  }
  if (opts.help) {
    out(usage(req));
    return 0;
  }
  rep.dryRun = opts.dryRun;
  if (!opts.yes && deps.ask === realDeps.ask && !process.stdin.isTTY) {
    rep.error = "standard input is not a terminal, so it can't ask; pass --yes to take every default, with a flag for each answer you want to give. Nothing was changed.";
    err(`kanon init: ${rep.error}`);
    return emit(2);
  }
  try {
    return emit(await run(deps, opts, req, rep));
  } catch (e) {
    // An error `run` did not expect, such as a file it could not write (#375). The document
    // still prints: before the inspection nothing had changed, so it is the error document;
    // after it, it is `failed`, with what was already done (`files`, `changes`) and the error
    // among `failures`.
    const message = `stopped on an unexpected error: ${/** @type {Error} */ (e).message}`;
    err(`kanon init: ${message}`);
    if (rep.inspection === null) rep.error = `${message}. Nothing was changed.`;
    else rep.failures.push(message);
    return emit(1);
  } finally {
    rl?.close();
    rl = null;
  }
};

/**
 * The JSON document (docs/init.md): the error document when `init` stopped before it inspected
 * anything, otherwise the whole run. Exported for its test.
 * @param {Report} rep @param {number} exitCode @param {string} release
 */
export const document = (rep, exitCode, release) => {
  if (rep.error !== null || rep.inspection === null) return { schema: SCHEMA, kanon: release, status: 'error', exitCode, error: rep.error ?? `exit ${exitCode}` };
  const status = exitCode !== 0 ? 'failed' : rep.findings.length ? 'steps-left' : 'complete';
  return {
    schema: SCHEMA,
    kanon: release,
    status,
    exitCode,
    repository: rep.repository,
    token: rep.token,
    dryRun: rep.dryRun,
    inspection: rep.inspection,
    answers: rep.answers,
    catalogue: rep.catalogue,
    files: rep.files,
    changes: rep.changes,
    apps: rep.apps,
    findings: rep.findings,
    notes: rep.notes,
    failures: rep.failures,
  };
};

/**
 * @param {Deps} deps @param {ReturnType<typeof parseArgs>} opts @param {Requirements} req @param {Report} rep
 */
const run = async (deps, opts, req, rep) => {
  const { out, err } = deps;
  const dry = opts.dryRun;
  const release = deps.release();
  /** Stops before anything changed: the prose on standard error, the sentence in the report. */
  const stop = (/** @type {number} */ code, /** @type {string[]} */ lines) => {
    for (const l of lines) err(`kanon init: ${l}`);
    rep.error = lines.join(' ');
    return code;
  };

  // The checkout, and the repository it is of.
  const top = deps.git(['-C', resolve(opts.dir), 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) return stop(1, [`${resolve(opts.dir)} is not a git checkout. Run it from your repository's checkout, or pass --dir. Nothing was changed.`]);
  let repo = opts.repo;
  if (!repo) {
    const origin = deps.git(['-C', top.stdout.trim(), 'remote', 'get-url', 'origin']);
    repo = (origin.status === 0 && remoteRepo(origin.stdout)) || '';
    if (!repo) return stop(1, [`${top.stdout.trim()} has no origin remote on GitHub; pass --repo <owner>/<repo>. Nothing was changed.`]);
  }
  rep.repository = repo;
  const [ownerName = '', repoName = ''] = repo.split('/');
  // checkoutCheck reads git only.
  const where = checkoutCheck(/** @type {import('./apps.mjs').Deps} */ (/** @type {unknown} */ ({ git: deps.git })), opts.dir, ownerName, repoName);
  if (where.refusal) return stop(1, where.refusal.map((l) => l.replace('--register <path> to write the register somewhere else on purpose', '--repo <owner>/<repo> for the checkout\'s own repository')));
  const root = where.root;
  const read = (/** @type {string} */ rel) => deps.readFile(join(root, rel));
  const releases = callsRelease(read('.github/workflows/release.yml'));
  if (opts.given.releaser && !releases) {
    return stop(2, ["--releaser is for a repository that calls Kanon's release workflow from .github/workflows/release.yml (docs/release.md), and this one doesn't. Nothing was changed."]);
  }

  const who = await whoami(deps.gh, deps.env);
  out(who.line);
  rep.token = { source: who.source, login: who.login };
  if (who.refusal) return stop(1, who.refusal);

  // 1. Inspect.
  /** @type {Inspection} */
  let s;
  try {
    s = await inspect(deps, repo);
  } catch (e) {
    return stop(1, [`${/** @type {Error} */ (e).message}. Nothing was changed.`]);
  }
  // A lane counts as installed when its caller calls it, not when a file has its name: in a
  // repository that hosts the lanes that path holds the lane itself, and its caller lives where
  // the adoption record's caller.misplaced waiver says (#451). Doctor reads the waivers, and init
  // reads them as doctor does; doctor imports init, so init loads it only once both are loaded.
  const { ADOPTION_RECORD, readWaivers } = await import('./doctor.mjs');
  const waived = readWaivers(read(ADOPTION_RECORD)).waivers.filter((w) => w.id === 'caller.misplaced').map((w) => w.subject);
  const callers = callerPaths(Object.keys(req.lanes), read, waived);
  const installed = Object.keys(req.lanes).filter((l) => (read(/** @type {string} */ (callers.get(l))) ?? '').includes(callsLane(l)));
  rep.inspection = {
    owner: s.owner,
    ownerKind: s.kind === 'User' ? 'user' : 'organization',
    private: s.isPrivate,
    defaultBranch: s.defaultBranch,
    hasCommits: s.hasCommits,
    admin: s.admin,
    rulesets: s.rulesets,
    mergeQueue: s.mergeQueue,
    defaultBranchMergeQueue: mergesThroughQueue(s),
    defaultBranchRulesets: s.covering.map((c) => String(c.name)),
    inactiveRulesets: s.inactive.map((c) => ({ name: String(c.name), enforcement: String(c.enforcement) })),
    labels: [...s.labels].sort(),
    milestones: [...s.milestones].sort(),
    secrets: s.secrets ? [...s.secrets].sort() : null,
    installedLanes: installed,
    callsRelease: releases,
  };
  rep.catalogue = laneCatalogue(req, installed);
  out('');
  out(`== ${repo}, at Kanon ${release}${dry ? ' (dry run: nothing will change)' : ''} ==`);
  out(`- ${s.kind === 'User' ? 'A personal account' : 'An organisation'}'s ${s.isPrivate ? 'private' : 'public'} repository; default branch ${s.defaultBranch}${s.hasCommits ? '' : ', with no commit yet'}.`);
  out(`- Rulesets: ${s.rulesets}. Merge queue: ${s.mergeQueue}. Environments: not needed by any lane.`);
  out(`- Your token ${s.admin ? 'can' : "can't"} administer the repository.`);
  out(`- ${s.labels.size} label(s); ${s.covering.length} ruleset(s) on the default branch; secrets ${s.secrets ? `readable (${s.secrets.size})` : 'not readable with this token'}.`);

  // 2. Ask.
  const gitName = deps.git(['-C', root, 'config', 'user.name']).stdout.trim();
  const gitEmail = deps.git(['-C', root, 'config', 'user.email']).stdout.trim();
  // THE OWNER'S APPS (#363): Kanon's Apps the owner already has, from its installations (the
  // reader `kanon doctor` shares), looked for only when this register lacks one of them. An
  // installation whose App this register already names is this repository's own.
  const rows = registerRows(read(REGISTER_PATH));
  const named = new Set(rows.values());
  const lacking = Object.keys(req.identities.apps).filter((i) => registerRolesOf(i, req).some((r) => !rows.has(r)));
  /** @type {Array<{ app: string, slug: string, installation: number }> | null} null when they can't be listed */
  let ownerApps = [];
  /** @type {string | null} why they can't be listed */
  let unlisted = null;
  if (lacking.length) {
    const { listed, installs } = await ownerInstallations(deps.gh, s.owner, s.kind);
    if (installs) ownerApps = ownerKanonApps(installs, s.owner, req.identities.apps).filter((f) => !named.has(f.slug));
    else {
      ownerApps = null;
      unlisted = `the token can't list ${s.owner}'s App installations (${listed.stderr.trim() || `exit ${listed.status}`}), so init can't tell whether ${s.owner} already has Kanon's Apps. ${
        s.kind === 'Organization' ? `Only an owner of ${s.owner} can list them, with the organisation's Administration permission (read).` : "On a personal account gh's token can't list them."
      }`;
    }
  }
  rep.inspection.ownerApps = ownerApps && ownerApps.map((f) => ({ app: f.app, slug: f.slug }));
  out('');
  const a = await askAll(deps, opts, {
    login: who.login ?? ownerName,
    gates: suggestGates(read),
    gitName,
    gitEmail,
    req,
    defaultLanes: installed.length ? installed : DEFAULT_LANES,
    releases,
    reusable: (ids) => (ownerApps ?? []).filter((f) => ids.includes(f.app) && lacking.includes(f.app)),
  });
  rep.answers = {
    projectOwner: a.owner,
    maintainer: a.maintainer,
    stakeholder: a.stakeholder,
    lanes: a.lanes,
    gates: a.gates,
    testDatabase: a.database,
    delegation: a.delegation,
    deleteDefaultLabels: a.deleteDefaults,
    releaser: a.releaser,
    reuseApps: a.reuseApps,
    plugin: a.plugin,
    telemetry: a.telemetry,
  };

  /** @type {string[]} what changed (or, in a dry run, would) */
  const changed = [];
  /** @param {string} kind @param {string} subject @param {string} message */
  const change = (kind, subject, message) => {
    changed.push(message);
    rep.changes.push({ kind, subject, message });
  };
  /** @type {string[][]} the steps left to a person, each a few lines */
  const manual = [];
  /**
   * A step left to a person: its prose lines, and its finding.
   * @param {{ id: string, category: string, subject: string, prose: string, message: string, text: string, commands: string[], lines?: string[], url?: string | null, blocking?: boolean }} f
   */
  const step = (f) => {
    manual.push([f.prose, ...(f.lines ?? f.commands)]);
    rep.findings.push({ id: f.id, category: f.category, blocking: f.blocking ?? false, subject: f.subject, message: f.message, fix: { text: f.text, commands: f.commands, url: f.url ?? null } });
  };
  /** A failure, said on standard error and kept in the report. @param {string} line */
  const failed = (line) => {
    err(`kanon init: ${line}`);
    rep.failures.push(line);
  };
  /** A fact printed for a person, kept as a note. @param {string} line */
  const note = (line) => {
    out(line);
    rep.notes.push(line);
  };
  let failures = 0;
  const verb = dry ? 'Would create' : 'Created';

  // 3. Write the files.
  out('');
  out('== Files ==');
  const workflows = checkoutWorkflows(deps, root);
  const files = plannedFiles({ s, a, req, release, repo, today: deps.today(), read, workflows, callers });
  let wrote = false;
  for (const [rel, text] of files) {
    const have = read(rel);
    if (have === text) {
      out(`${rel}: already as init writes it.`);
      rep.files.push({ path: rel, status: 'same', content: text, diff: [] });
      continue;
    }
    if (have !== null && (rel.startsWith('docs/') || rel === req.hook.path)) {
      // A declaration, or the project-setup hook, is the project's once it exists: init never
      // rewrites one, and its content is the project's to say, so no difference is printed.
      out(`${rel}: exists, and is the project's; left unchanged.`);
      rep.files.push({ path: rel, status: 'kept', content: null, diff: [] });
      continue;
    }
    if (have !== null) {
      out(`${rel}: exists and differs from what init would write; left unchanged. The difference:`);
      const diff = lineDiff(have, text).filter((l) => !l.startsWith('  '));
      for (const l of diff) out(`    ${l}`);
      // Its full text too, so a program can write it elsewhere, such as a caller whose lane's
      // file name another file holds (#451).
      rep.files.push({ path: rel, status: 'differs', content: text, diff });
      continue;
    }
    if (!dry) deps.writeFile(join(root, rel), text);
    wrote = true;
    change('file', rel, `${verb} ${rel}`);
    rep.files.push({ path: rel, status: 'new', content: text, diff: [] });
    out(`${dry ? 'would write' : 'wrote'} ${rel}:`);
    for (const l of text.replace(/\n$/, '').split('\n')) out(`    + ${l}`);
  }
  const dep = read('.github/dependabot.yml');
  if (dep && !/yedeya-labs\/kanon\*/.test(dep)) {
    step({
      id: 'dependabot.kanon-entry',
      category: 'dependabot',
      subject: '.github/dependabot.yml',
      prose: 'Add the entry that proposes Kanon upgrades (K-ADOPT-11) under `updates:` in .github/dependabot.yml:',
      message: '.github/dependabot.yml has no entry that proposes Kanon upgrades (K-ADOPT-11).',
      text: 'Add these lines under `updates:` in .github/dependabot.yml.',
      commands: [...DEPENDABOT_ENTRY],
    });
  }
  const settings = read(SETTINGS_PATH);
  const declared = readPluginDeclaration(settings);
  if (a.plugin && settings !== null && !(declared.status === 'declared' && declared.ref === release && declared.enabled)) {
    const lines = JSON.stringify(pluginSettings(release), null, 2).split('\n').slice(1, -1);
    step({
      id: 'plugin.declare',
      category: 'plugin',
      subject: SETTINGS_PATH,
      prose: `${SETTINGS_PATH} is the project's, so init leaves it alone. To declare the kanon plugin at ${release}, merge these keys into it, or set the kanon marketplace's ref to ${release} where it is declared already:`,
      message: declared.status === 'declared'
        ? `${SETTINGS_PATH} declares the kanon plugin's marketplace "${declared.name}" ${[...(declared.ref === release ? [`at ${release}`] : [`${declared.ref ? `at ${declared.ref}` : 'with no ref'}, not at ${release}`]), ...(declared.enabled ? [] : [`and doesn't enable kanon@${declared.name}`])].join(', ')}.`
        : `${SETTINGS_PATH} exists, and doesn't declare the kanon plugin${declared.status === 'unreadable' ? ` (${declared.reason})` : ''}.`,
      text: `Merge these keys into ${SETTINGS_PATH}, keeping its own, or set the kanon marketplace's ref there to ${release} and enable its plugin.`,
      commands: lines,
    });
  }

  // The telemetry store's side (#428): the register entry and the two repository variables are
  // the Kanon operator's to give (docs/telemetry.md, "Add a repository"), so a yes leaves them as
  // a step, until both variables are set. Until then the collector skips with a warning.
  if (a.telemetry === true) {
    const vars = await ghJson(deps, ['variable', 'list', '-R', repo, '--json', 'name']);
    const have = new Set(vars.ok ? vars.json.map((/** @type {any} */ v) => String(v.name)) : []);
    const unset = TELEMETRY_VARIABLES.filter((v) => !have.has(v));
    if (unset.length) step(telemetryStep(repo, unset, vars.ok));
  }

  // 4. Labels, milestones, the merge setting and the ruleset.
  out('');
  out('== Labels and milestones ==');
  const taxonomy = /** @type {Array<{ name: string, color: string, description: string }>} */ (
    JSON.parse(readFileSync(new URL('../rulebook/labels.json', import.meta.url), 'utf8')).labels
  ).filter((l) => !/<[a-z]+>$/.test(l.name));
  const missingLabels = taxonomy.filter((l) => !s.labels.has(l.name));
  /** @type {string[]} */
  const labelSteps = [];
  for (const l of missingLabels) {
    const cmd = ['label', 'create', l.name, '--color', l.color, '--description', l.description, '-R', repo];
    if (dry) {
      change('label', l.name, `Would create the label ${l.name}`);
      continue;
    }
    const r = await deps.gh(cmd);
    if (r.status === 0) change('label', l.name, `Created the label ${l.name}`);
    else labelSteps.push(`gh ${cmd.map((c) => (/^[\w:./-]+$/.test(c) ? c : JSON.stringify(c))).join(' ')}`);
  }
  out(missingLabels.length ? `${dry ? 'Would create' : 'Created'} ${missingLabels.length - labelSteps.length} of the ${missingLabels.length} missing taxonomy label(s).` : `All ${taxonomy.length} taxonomy labels exist.`);
  if (labelSteps.length) {
    step({
      id: 'label.create',
      category: 'label',
      subject: repo,
      prose: 'Create the labels the token could not (it needs Issues: write):',
      message: `${labelSteps.length} of the taxonomy's labels are missing, and the token could not create them (it needs Issues: write).`,
      text: 'Create them with a token that has Issues: write.',
      commands: labelSteps,
    });
  }
  const extra = GITHUB_DEFAULT_LABELS.filter((n) => s.labels.has(n) && !taxonomy.some((l) => l.name === n));
  if (extra.length) {
    if (a.deleteDefaults && !dry) {
      for (const n of extra) {
        const r = await deps.gh(['label', 'delete', n, '--yes', '-R', repo]);
        if (r.status === 0) change('label-deleted', n, `Deleted GitHub's default label ${n}`);
        else {
          const cmd = `gh label delete ${JSON.stringify(n)} --yes -R ${repo}`;
          step({ id: 'label.delete-default', category: 'label', subject: n, prose: `Delete GitHub's default label "${n}" (K-WORK-12): ${cmd}`, message: `GitHub's default label "${n}" is outside Kanon's taxonomy, and the token could not delete it.`, text: 'Delete it with a token that has Issues: write (K-WORK-12).', commands: [cmd], lines: [] });
        }
      }
    } else if (a.deleteDefaults) for (const n of extra) change('label-deleted', n, `Would delete GitHub's default label ${n}`);
    else note(`Kept GitHub's default labels outside the taxonomy, as asked: ${extra.join(', ')}.`);
  }
  const missingBuckets = BUCKETS.filter((b) => !s.milestones.has(b));
  if (!missingBuckets.length) out('Both bucket milestones exist.');
  else if (dry) for (const b of missingBuckets) change('milestone', b, `Would create the milestone ${b}`);
  else {
    const code = await deps.milestones(['--repo', repo], { out, err });
    if (code === 0) for (const b of missingBuckets) change('milestone', b, `Created the milestone ${b}`);
    else {
      const cmd = `kanon milestones --repo ${repo}`;
      step({ id: 'milestone.buckets', category: 'milestone', subject: repo, prose: `Create the bucket milestones (K-WORK-4): ${cmd}`, message: `The bucket milestones ${missingBuckets.join(' and ')} are missing (K-WORK-4), and kanon milestones did not create them.`, text: 'Run kanon milestones with a token that has Issues: write.', commands: [cmd], lines: [] });
    }
  }

  out('');
  out('== Merging ==');
  const settingDiff = Object.entries(MERGE_SETTINGS).filter(([k, v]) => /** @type {Record<string, unknown>} */ (s.settings)[k] !== v);
  const patch = ['api', '-X', 'PATCH', `repos/${repo}`, ...settingDiff.flatMap(([k, v]) => [typeof v === 'boolean' ? '-F' : '-f', `${k}=${v}`])];
  const settingList = settingDiff.map(([k, v]) => `${k}=${v}`).join(', ');
  if (!settingDiff.length) out('Squash merge only, with the PR\'s title and body: already set (K-SHIP-3).');
  else if (dry) change('merge-settings', repo, `Would set ${settingList} (K-SHIP-3)`);
  else {
    const r = s.admin ? await deps.gh(patch) : null;
    if (r?.status === 0) change('merge-settings', repo, `Set ${settingList} (K-SHIP-3)`);
    else {
      step({
        id: 'merge.settings',
        category: 'merge',
        subject: repo,
        prose: `Make squash the only merge method, with the PR's title and body as the commit's (K-SHIP-3); it needs Administration: write:`,
        message: `The repository's merge settings differ from K-SHIP-3's (${settingList}), and the token could not change them.`,
        text: 'Make squash the only merge method, with the PR\'s title and body as the commit\'s, with a token that has Administration: write.',
        commands: [`gh ${patch.join(' ')}`],
        url: `https://github.com/${repo}/settings`,
      });
    }
  }

  // THE REQUIRED CHECK (#444, L5's G3 and G14). A ruleset requires "Lane check" only once a job on
  // the default branch reports it on every pull request, read from GitHub as doctor reads it
  // (cli/check-reporters.mjs): a job only this branch adds reports nothing on any other pull
  // request, and each would wait on the rule until this one merges. Until then the rule is a step
  // for after the merge. To a ruleset init didn't create, it adds this rule alone (the Owner's
  // decision on #444), and only with a token that can administer the repository.
  const checkGap = requiredCheckGap(LANE_CHECK);
  const wantsCheck = s.rulesets !== 'no' && s.hasCommits && rulesetGaps(s.covering).includes(checkGap);
  const onDefault = wantsCheck ? await branchWorkflows(deps, repo, s.defaultBranch) : null;
  // Through a merge queue, the job must report the check on the queue's merge_group run too (#459).
  const queued = mergesThroughQueue(s);
  const every = queued ? 'every pull request and every queued merge' : 'every pull request';
  const reported = onDefault !== null && onDefault.error === null && checkReporters(onDefault.workflows, LANE_CHECK, s.defaultBranch, queued).length > 0;
  const rulesPage = `https://github.com/${repo}/settings/rules`;
  /** The rule as a step for after the merge. */
  const checkStep = () => {
    /** @type {Map<string, Record<string, any>>} */
    const planned = new Map();
    for (const [rel, text] of files) {
      if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) continue;
      try {
        const doc = parseYaml(text);
        if (isMap(doc)) planned.set(rel, doc);
      } catch {
        // init's own files parse.
      }
    }
    // The checkout's own file wins over what init would write: init leaves a file that differs.
    const merged = new Map([...planned, ...workflows]);
    const adds = checkReporters(merged, LANE_CHECK, s.defaultBranch, queued);
    // Otherwise a job with no filter lacks only the queue's event (#459): init never edits a
    // workflow of the project's, so adding the trigger is the pull request's.
    const unqueued = [...new Set(checkJobs(merged, LANE_CHECK, s.defaultBranch, queued).filter((j) => !j.filters.length).map((j) => j.job.split('#')[0]))];
    const by = adds.length
      ? `the pull request that adds ${adds.join(', ')}`
      : unqueued.length
        ? `a pull request that adds merge_group, the event the merge queue runs its checks on, to the triggers of ${unqueued.join(', ')},`
        : `a pull request that adds a job named "${LANE_CHECK}", as actions/lane-check's README shows,`;
    const unread = onDefault?.error ? `init could not read the workflows on ${s.defaultBranch} (${onDefault.error}), so it can't tell whether a job there reports the status check "${LANE_CHECK}"` : `No job of a workflow on ${s.defaultBranch} reports the status check "${LANE_CHECK}" on ${every} yet`;
    step({
      id: 'ruleset.require-check',
      category: 'ruleset',
      subject: LANE_CHECK,
      prose: `After ${by} merges to ${s.defaultBranch}, require the status check "${LANE_CHECK}" (K-ADOPT-1 step 8): run kanon init again with a token that can administer the repository, which adds only that rule, or add it in the repository's Settings, Rules, Rulesets. Not before: until then nothing on ${s.defaultBranch} reports it, and every other pull request would wait on it.`,
      message: `${unread}, so the ruleset doesn't require it: a required check that nothing reports blocks every other pull request (K-ADOPT-1 step 8).`,
      text: `After ${by} merges to ${s.defaultBranch}, run kanon init again with a token that can administer the repository, which adds only that rule, or add it on the ruleset's page. Never before: every other pull request would wait on the check.`,
      commands: [],
      url: rulesPage,
    });
  };
  /**
   * Adds the required check to one of the existing rulesets, its other rules unchanged: one this
   * repository owns (an organisation's is the organisation's to change), preferring one that
   * requires checks already, then init's own. Says whether it did, or in a dry run would.
   */
  const addCheck = async () => {
    const own = s.covering.filter((c) => (c.source_type ?? 'Repository') === 'Repository');
    const rank = (/** @type {any} */ c) => ((c.rules ?? []).some((/** @type {any} */ r) => r.type === 'required_status_checks') ? 0 : c.name === RULESET_NAME ? 1 : 2);
    const target = [...own].sort((x, y) => rank(x) - rank(y))[0];
    if (!target || !s.admin) return false;
    const message = `the required status check "${LANE_CHECK}" to the ruleset "${target.name}" on ${s.defaultBranch}, which a job there reports`;
    if (dry) {
      change('ruleset', s.defaultBranch, `Would add ${message}`);
      return true;
    }
    // Each rule as the API takes it back: its type and parameters, nothing GitHub added on reading.
    /** @type {Array<{ type: string, parameters?: any }>} */
    const rules = (target.rules ?? []).map((/** @type {any} */ r) => ({ type: r.type, parameters: r.parameters }));
    const checks = rules.find((r) => r.type === 'required_status_checks');
    if (checks) checks.parameters = { ...checks.parameters, required_status_checks: [...(checks.parameters?.required_status_checks ?? []), { context: LANE_CHECK }] };
    else rules.push(CHECK_RULE);
    const r = await deps.gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${target.id}`, '--input', '-'], JSON.stringify({ rules }));
    if (r.status === 0) {
      change('ruleset', s.defaultBranch, `Added ${message}`);
      return true;
    }
    note(`Could not add the required status check "${LANE_CHECK}" to the ruleset "${target.name}" (${why(r)}).`);
    return false;
  };

  const body = rulesetBody(s.mergeQueue === 'yes', reported);
  const requiring = reported ? `, requiring "${LANE_CHECK}"` : '';
  const rulesetCmd = [`gh api -X POST repos/${repo}/rulesets --input - <<'JSON'`, JSON.stringify(body), 'JSON'];
  if (s.inactive.length && s.rulesets !== 'no') {
    note(`Not counted: the ruleset(s) ${s.inactive.map((c) => `"${c.name}" (${c.enforcement})`).join(', ')} on ${s.defaultBranch}, which enforce nothing.`);
  }
  if (s.rulesets === 'no') {
    out('');
    note(`THE PLATFORM DOES NOT ENFORCE REVIEW ON ${repo}. A private repository on this plan has no rulesets, so it never leaves bootstrap: every lane runs, and the Merger merges only what the Reviewer approved, but a person can merge past the Reviewer and nothing on GitHub refuses it (K-ADOPT-3, K-ADOPT-6). Making the repository public, or a plan with rulesets, changes that. The adoption record says so.`);
  } else if (s.covering.length) {
    const all = rulesetGaps(s.covering);
    let gaps = all.filter((g) => g !== checkGap);
    if (all.includes(checkGap)) {
      if (!reported) checkStep();
      else if (!(await addCheck())) gaps = all;
    }
    if (!all.length) out(`The default branch's ruleset has every rule of K-ADOPT-1 step 8.`);
    if (gaps.length) {
      const names = s.covering.map((c) => c.name).join(', ');
      step({
        id: 'ruleset.gaps',
        category: 'ruleset',
        subject: names,
        prose: `The ruleset on ${s.defaultBranch} (${names}) lacks some of K-ADOPT-1 step 8. In the repository's Settings, Rules, Rulesets:`,
        lines: gaps.map((x) => `  - ${x}`),
        message: `The ruleset on ${s.defaultBranch} (${names}) lacks some of K-ADOPT-1 step 8: ${gaps.join('; ')}.`,
        text: `Add what it lacks in the repository's Settings, Rules, Rulesets. To a ruleset it didn't create, init adds only the required status check, once a job on ${s.defaultBranch} reports it, and with a token that can administer the repository.`,
        commands: [],
        url: rulesPage,
      });
    }
  } else if (!s.hasCommits) {
    const prose = `Push the first commit straight to ${s.defaultBranch} (K-ADOPT-4), then run kanon init again: it creates the ruleset, which then requires a pull request.`;
    step({ id: 'ruleset.first-commit', category: 'ruleset', subject: s.defaultBranch, prose, message: `${s.defaultBranch} has no commit yet, so init created no ruleset (K-ADOPT-4).`, text: prose, commands: [] });
  } else {
    if (dry) change('ruleset', s.defaultBranch, `Would create the ruleset "${RULESET_NAME}" on ${s.defaultBranch}${requiring}`);
    else {
      const r = s.admin ? await deps.gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(body)) : null;
      if (r?.status === 0) change('ruleset', s.defaultBranch, `Created the ruleset "${RULESET_NAME}" on ${s.defaultBranch}${requiring}${s.mergeQueue === 'yes' ? ', with the merge queue' : ''}`);
      else {
        step({
          id: 'ruleset.create',
          category: 'ruleset',
          subject: s.defaultBranch,
          prose: `Create the default branch's ruleset (K-ADOPT-1 step 8); it needs Administration: write:`,
          message: `${s.defaultBranch} has no ruleset, and the token could not create one (K-ADOPT-1 step 8).`,
          text: 'Create it with a token that has Administration: write; the command reads the ruleset from the lines after it.',
          commands: rulesetCmd,
        });
      }
    }
    if (!reported) checkStep();
  }
  if (s.rulesets !== 'no' && s.mergeQueue === 'unknown') note('Merge queue not known: the token can\'t read the organisation\'s plan. Without one, "require branches to be up to date" stays off (K-MERGE-7).');
  else if (s.rulesets !== 'no' && s.mergeQueue !== 'yes') note('No merge queue on this plan: "require branches to be up to date" stays off (K-MERGE-7).');

  // 5. The Apps. Under `--json`, `kanon apps` prints its prose on standard error too.
  out('');
  out('== Apps ==');
  const identities = appIdentities(a, req);
  /** @type {string[]} */
  let missing = [];
  try {
    missing = identities.filter((i) => registerRolesOf(i, req).some((r) => !rows.has(r)));
  } catch (e) {
    failed(/** @type {Error} */ (e).message);
    failures++;
  }
  // The Apps the owner already has, which the person chose to reuse (#363): each is the
  // `kanon apps --reuse` step, with its slug, and the rest are created as before.
  const owned = ownerApps ?? [];
  const reusing = a.reuseApps ? missing.filter((i) => owned.some((f) => f.app === i)) : [];
  const toCreate = missing.filter((i) => !reusing.includes(i));
  rep.apps = { identities, missing, reuse: reusing.map((i) => ({ app: i, slug: /** @type {{ slug: string }} */ (owned.find((f) => f.app === i)).slug })), command: null, outcome: failures ? 'failed' : 'none', exitCode: null };
  const appsRep = rep.apps;
  if (missing.length && ownerApps === null && unlisted) note(`Not looked for: ${unlisted}`);
  for (const i of reusing) {
    const all = owned.filter((f) => f.app === i);
    const slug = /** @type {{ slug: string }} */ (all[0]).slug;
    const name = req.identities.apps[i]?.name ?? i;
    const also = all.length > 1 ? ` (it also has ${all.slice(1).map((f) => f.slug).join(', ')} with the same permissions: give the one ${repoName} should share)` : '';
    step({
      id: 'app.reuse',
      category: 'app',
      subject: i,
      prose: `${s.owner} already has the ${name} App ${slug}${also}. Add ${repoName} to its installation, generate a private key on its settings page, then run this, and commit the register rows it writes:`,
      message: `${s.owner} already has the ${name} App ${slug}, which the chosen lanes run as, and the register lacks it.`,
      text: `Add ${repoName} to the App's installation, generate a private key on its settings page, then run kanon apps --reuse with the downloaded key, and commit the register rows it writes.${also}`,
      commands: [`kanon apps --owner ${s.owner} --repo ${repoName} --reuse ${i}:${slug}=<downloaded>.pem`],
      url: s.kind === 'User' ? `https://github.com/settings/apps/${slug}` : `https://github.com/organizations/${s.owner}/settings/apps/${slug}`,
    });
  }
  if (!identities.length) out('The chosen lanes run as no App.');
  else if (!missing.length) {
    if (!failures) appsRep.outcome = 'registered';
    out(`The App register lists every App the lanes run as: ${identities.join(', ')}.`);
  } else if (!toCreate.length) {
    if (!failures) appsRep.outcome = 'reuse';
    out(`The owner already has every App the register lacks (${reusing.join(', ')}): reuse ${reusing.length > 1 ? 'them' : 'it'} with the kanon apps --reuse step${reusing.length > 1 ? 's' : ''} below.`);
  } else {
    /** @type {string[]} */
    let flag;
    try {
      flag = appsArgs(toCreate, req);
    } catch (e) {
      failed(/** @type {Error} */ (e).message);
      appsRep.outcome = 'failed';
      return 1;
    }
    const argvApps = ['--owner', s.owner, '--repo', repoName, ...flag, '--dir', root];
    const cmd = `kanon apps ${argvApps.join(' ')}`;
    appsRep.command = cmd;
    // One App per owner (plan 0005 §3.2): when the owner's installations can't be listed, an App
    // it already has for another repository looks missing here (#363), so the step says to
    // reuse such an App rather than create a second one.
    const reuseInstead = ownerApps !== null ? '' : ` If ${s.owner} already has ${toCreate.length > 1 ? 'these Apps' : 'this App'} for another repository, don't create ${toCreate.length > 1 ? 'them' : 'it'} again: add ${repoName} to ${toCreate.length > 1 ? 'each' : 'its'} installation, generate a private key on its settings page, and run kanon apps --owner ${s.owner} --repo ${repoName} --reuse <app>:<slug>=<key file> instead (docs/apps.md, "A repository added later").`;
    const createStep = () =>
      step({
        id: 'app.create',
        category: 'app',
        subject: toCreate.join(', '),
        prose: `Create the Apps the lanes run as, from this checkout, and commit the register rows it writes.${reuseInstead}`,
        message: `The App register lacks ${toCreate.join(' and ')}, which the chosen lanes run as.`,
        text: `Run kanon apps from this checkout: it opens your browser for each App. Then commit the register rows it writes.${reuseInstead}`,
        commands: [cmd],
      });
    if (dry) {
      out(`Would run: ${cmd}`);
      change('apps', toCreate.join(', '), `Would run: ${cmd}`);
      appsRep.outcome = 'would-run';
    } else if (!opts.apps || !(opts.given.createApps || /^y/i.test(opts.yes ? 'y' : await deps.ask(`Create the Apps for ${toCreate.join(', ')} now? It opens your browser for each. (y/n)`, 'y')))) {
      createStep();
      appsRep.outcome = 'left-to-you';
    } else {
      out(`Running: ${cmd}`);
      const code = await deps.apps(argvApps, { out, err });
      appsRep.exitCode = code;
      if (code === 0) {
        change('apps', toCreate.join(', '), `Created the App(s) for ${toCreate.join(', ')} with kanon apps`);
        appsRep.outcome = 'ran';
      } else {
        failures++;
        appsRep.outcome = 'failed';
        rep.failures.push(`kanon apps did not finish (exit ${code}).`);
        step({
          id: 'app.failed',
          category: 'app',
          subject: toCreate.join(', '),
          blocking: true,
          prose: `kanon apps did not finish (exit ${code}); fix what it said, then run it again:`,
          message: `kanon apps did not finish (exit ${code}), so ${toCreate.join(' and ')} may not exist yet.`,
          text: 'Fix what kanon apps said, then run it again.',
          commands: [cmd],
        });
      }
    }
  }
  if (s.secrets) {
    for (const i of identities) {
      const lacks = appSecrets(i).filter((n) => !s.secrets?.has(n));
      if (lacks.length && !missing.includes(i)) {
        // One App per owner (plan 0005 §3.2): the App exists, so this repository joins it with
        // a key generated on its page, which `kanon apps --reuse` checks, stores and deletes.
        const known = registerRolesOf(i, req).map((r) => rows.get(r)).find(Boolean);
        const slug = known ?? `<the ${i} App's slug>`;
        step({
          id: 'app.reuse',
          category: 'app',
          subject: i,
          prose: `The register lists the ${i} App, but the repository lacks ${lacks.join(' and ')}. Add ${repoName} to the App's installation, generate a private key on its settings page, then:`,
          message: `The register lists the ${i} App, but the repository lacks ${lacks.join(' and ')}.`,
          text: `Add ${repoName} to the App's installation, generate a private key on its settings page, then run kanon apps --reuse with the downloaded key.`,
          commands: [`kanon apps --owner ${s.owner} --repo ${repoName} --reuse ${i}:${slug}=<downloaded>.pem`],
          url: known ? (s.kind === 'User' ? `https://github.com/settings/apps/${known}` : `https://github.com/organizations/${s.owner}/settings/apps/${known}`) : null,
        });
      }
    }
    const others = [...new Set(a.lanes.flatMap((l) => req.lanes[l]?.secrets ?? []))].filter((n) => !/_APP_(ID|PRIVATE_KEY)$/.test(n) && !s.secrets?.has(n));
    const secretsUrl = `https://github.com/${repo}/settings/secrets/actions`;
    if (others.includes('CLAUDE_CODE_OAUTH_TOKEN')) {
      const prose = 'Store the token of the Claude subscription the agents run on, made with `claude setup-token` (docs/lanes.md):';
      step({ id: 'secret.claude-code-oauth-token', category: 'secret', subject: 'CLAUDE_CODE_OAUTH_TOKEN', prose, message: 'The repository lacks CLAUDE_CODE_OAUTH_TOKEN, which the chosen lanes map.', text: prose.replace(/:$/, '.'), commands: [`gh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}   # paste it on standard input`], url: secretsUrl });
    }
    if (others.includes('DIGEST_WEBHOOK')) {
      step({ id: 'secret.digest-webhook', category: 'secret', subject: 'DIGEST_WEBHOOK', prose: 'Store the chat webhook the digests post to:', message: 'The repository lacks DIGEST_WEBHOOK, which the chosen lanes map.', text: 'Store the chat webhook the digests post to.', commands: [`gh secret set DIGEST_WEBHOOK -R ${repo}   # paste it on standard input`], url: secretsUrl });
    }
  } else {
    const all = [...new Set(a.lanes.flatMap((l) => req.lanes[l]?.secrets ?? []))];
    step({
      id: 'secret.unreadable',
      category: 'secret',
      subject: repo,
      prose: `The token can't list ${repo}'s secret names, so init can't say which are missing. Each chosen lane maps: ${all.join(', ')}.`,
      message: `The token can't list ${repo}'s secret names, so init can't say which are missing.`,
      text: `Check that the repository has each secret the chosen lanes map: ${all.join(', ')}.`,
      commands: [],
      url: `https://github.com/${repo}/settings/secrets/actions`,
    });
  }

  // 6. The summary.
  out('');
  out('== Summary ==');
  if (!changed.length) out(dry ? 'A run would change nothing: everything init sets up is already right.' : 'Nothing changed: everything init sets up is already right.');
  else for (const c of changed) out(`- ${c}`);
  if (manual.length) {
    out('');
    out('Left to you, because the token or the plan can\'t do it:');
    manual.forEach((m, i) => {
      out(`${i + 1}. ${m[0]}`);
      for (const l of m.slice(1)) out(`   ${l}`);
    });
  }
  if (wrote) {
    out('');
    note('init commits nothing: review the files, then commit them on a branch and open a pull request.');
  }
  return failures ? 1 : 0;
};
