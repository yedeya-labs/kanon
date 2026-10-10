// `kanon init` (plan 0005 §5.4, step L9): installs Kanon in a repository, from its checkout.
//
// 1. INSPECTS, read-only: whether the owner is a personal account or an organisation, whether the
//    repository is public or private, which plan features it has (rulesets, the merge queue;
//    environments are not needed, decision 4), its labels, milestones, rulesets, secret names,
//    declaration files, callers and App register.
// 2. ASKS three questions (plan 0007 §3): the feature, a fixed set of lanes (or the lanes one by
//    one), whether the repository holds private or sensitive material, and one consent question
//    for sharing. Everything else it infers or defaults (§4), and it shows every value in one
//    summary, with where each came from, which the person confirms, changes or stops at (`--yes`
//    takes the defaults and confirms).
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
import { REGISTER_PATH, apps as runApps, checkoutCheck, ownerInstallations, ownerKanonApps, ownersOwn, remoteRepo } from './apps.mjs';
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
import { DEFAULT_VALUE as UPSTREAM_DEFAULT, LABEL as UPSTREAM_LABEL, sends } from '../scripts/lib/upstream-findings.mjs';

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
/**
 * Where a person runs a `gh secret set` that reads a real secret's value on standard input
 * (#625). With `!` at the Claude Code prompt it runs in the session, whose standard input isn't a
 * terminal, so gh asks for nothing and stores an empty secret without a word, and GitHub never
 * shows a secret's value to tell. A value that isn't secret goes on the line with `--body`.
 */
export const OWN_TERMINAL = 'in your own terminal, pasting the value when gh asks for it: never with `!` at the Claude Code prompt, where gh reads no value and stores an empty secret without a word. Or read it from a file, with `< <file>` at the end of the line';
/** The note on a line that reads a real secret on standard input (#625). */
export const OWN_TERMINAL_NOTE = '# in your own terminal, never with ! at the Claude Code prompt';

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

Without --yes it asks three questions, what Kanon should do here, whether the repository holds
private or sensitive material, and whether to share with Kanon, then shows one summary of
every value, asked, inferred or defaulted, and asks whether to install, change something or
stop. The flags below answer the questions and set the values the summary shows.

The questions:
  --feature <which>      what Kanon does here, a fixed set of lanes (docs/lanes.md, "The
                         features"): review, build (Review + build) or full (Full pipeline);
                         --lanes is the advanced choice, lane by lane, and not with it
                         (default: the feature the lanes already called make up, or review)
  --review-trigger <which>  which pull requests the Reviewer reviews: labelled, only those
                         labelled review:please (the default); every-pr isn't built yet
  --sensitive-data       record that the repository holds private or sensitive material, in
                         the adoption record's ## Data
  --no-sensitive-data    record that it holds none (default: not declared)
  --consent <level>      share with Kanon (docs/sharing.md): yes, run data and scrubbed bug
                         evidence; codes, run data and Kanon bugs as codes; or no (the
                         default); not with --telemetry or --upstream-findings

The other values, each inferred or defaulted, as the summary shows:
  --project-owner <who>  the project's Owner (K-ADOPT-1 step 2), a GitHub login or a name
                         (default: the one user CODEOWNERS names for *, else the token's
                         login); --owner is kanon apps' account
  --maintainer <who>     the Maintainer (default: the Owner)
  --stakeholder <who>    the Stakeholder (default: the Owner)
  --lanes <list>         comma-separated lanes to install, e.g. review,implement, the
                         Customise choice (default: the feature's lanes; the lanes are
                         listed below)
  --gates <list>         the stack's gates, comma-separated commands, or none
                         (default: suggested from what the repository holds)
  --test-database <how>  none, or hook: the project-setup hook starts one (default: hook
                         when a compose file has a database service, an example environment
                         file sets DATABASE_URL or a migrations directory exists, else none)
  --delegation           record a sign-off delegation (K-AGENT-44) (the default when a lane
                         runs as the Author and a workflow runs Kanon's DCO check)
  --no-delegation        don't
  --delegate-name <name> the delegate, as their sign-off writes their name; implies
                         --delegation (default: git config user.name)
  --delegate-email <e>   the delegate's email; implies --delegation (default: user.email)
  --delete-default-labels  delete GitHub's default labels outside Kanon's taxonomy (the
                         default on a repository with no commit yet)
  --keep-default-labels  keep them (the default otherwise)
  --releaser             create the optional Releaser App; only for a repository that
                         calls Kanon's release workflow (the default there)
  --no-releaser          don't (the default otherwise)
  --releases             the same as --releaser
  --no-releases          the same as --no-releaser
  --plugin               declare the kanon plugin in .claude/settings.json, pinned to this
                         release, for everyone who uses Claude Code here (the default)
  --no-plugin            don't
  --telemetry            send this repository's agent-run rows to Kanon's hosted telemetry
                         store: writes the collector's caller (docs/telemetry.md)
  --no-telemetry         don't (the default)
  --upstream-findings <where>  where findings only Kanon can act on go: drafted (the
                         default), filed-here, or, with --telemetry, sent or
                         sent-with-evidence (docs/init.md)
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
          // The QA store's secrets are the lane's optional ones (kanon#433), under `qaStore`.
          secrets: spec.secrets.filter((n) => !(spec.optionalSecrets ?? []).includes(n)),
          // From the lane (kanon#471); a requirements file from before it says so by the grant alone.
          qaStore: spec.qaStore ?? spec.grant['id-token'] === 'write',
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
 *   upstreamFindings?: import('../scripts/lib/upstream-findings.mjs').Value,
 *   feature?: 'review' | 'build' | 'full', reviewTrigger?: 'labelled', sensitiveData?: boolean, consent?: Consent,
 * }} Given
 */

/** The flags that take a value. */
const VALUE_FLAGS = ['--repo', '--dir', '--lanes', '--project-owner', '--maintainer', '--stakeholder', '--gates', '--test-database', '--delegate-name', '--delegate-email', '--upstream-findings', '--feature', '--review-trigger', '--consent'];

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
  // Plan 0007 §6. `--releases` is `--releaser` by another name, so either of one pair contradicts
  // either of the other; `--consent` sets what the telemetry and upstream-findings flags set, and
  // `--feature` chooses the lanes `--lanes` chooses one by one.
  ['--releases', '--no-releases'],
  ['--releaser', '--no-releases'],
  ['--releases', '--no-releaser'],
  ['--sensitive-data', '--no-sensitive-data'],
  ['--consent', '--telemetry'],
  ['--consent', '--no-telemetry'],
  ['--consent', '--upstream-findings'],
  ['--feature', '--lanes'],
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
  /** @type {{ repo: string, dir: string, lanes: string[] | null, yes: boolean, dryRun: boolean, json: boolean, apps: boolean, help: boolean, given: Given, releaserFlag?: string }} */
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
    else if (flag === '--releaser' || flag === '--releases') {
      g.releaser = true;
      opts.releaserFlag = flag;
    } else if (flag === '--no-releaser' || flag === '--no-releases') g.releaser = false;
    else if (flag === '--feature') {
      const v = value();
      if (v !== 'review' && v !== 'build' && v !== 'full') throw new Error(`--feature takes review, build or full, not "${v}"; to choose lane by lane, give --lanes instead`);
      g.feature = v;
    } else if (flag === '--review-trigger') {
      const v = value();
      // The review lane reviews only a labelled pull request until plan 0007's step G7 is built,
      // so init never writes a trigger the pinned lane doesn't read (K-LAYOUT-10).
      if (v === 'every-pr') throw new Error('--review-trigger every-pr is not built yet (plan 0007 step G7): the review lane reviews only a pull request labelled review:please. Give --review-trigger labelled, or leave it out');
      if (v !== 'labelled') throw new Error(`--review-trigger takes labelled or every-pr, not "${v}"`);
      g.reviewTrigger = v;
    } else if (flag === '--sensitive-data') g.sensitiveData = true;
    else if (flag === '--no-sensitive-data') g.sensitiveData = false;
    else if (flag === '--consent') {
      const v = value();
      if (v !== 'yes' && v !== 'codes' && v !== 'no') throw new Error(`--consent takes yes, codes or no, not "${v}"`);
      g.consent = v;
    }
    else if (flag === '--reuse-apps') g.reuseApps = true;
    else if (flag === '--no-reuse-apps') g.reuseApps = false;
    else if (flag === '--plugin') g.plugin = true;
    else if (flag === '--no-plugin') g.plugin = false;
    else if (flag === '--telemetry') g.telemetry = true;
    else if (flag === '--no-telemetry') g.telemetry = false;
    else if (flag === '--upstream-findings') {
      const v = value();
      const where = UPSTREAM_FLAG_VALUES[v];
      if (!where) throw new Error(`--upstream-findings takes ${Object.keys(UPSTREAM_FLAG_VALUES).join(', ').replace(/, (?=[^,]*$)/, ' or ')}, not "${v}"`);
      g.upstreamFindings = where;
    }
    // `--owner` names the GitHub account everywhere else (`kanon apps --owner`), so init's Owner
    // question is `--project-owner`, and a bare `--owner` is refused with that name (Owner, 2026-10-06).
    else if (flag === '--owner') throw new Error('unknown argument "--owner": the project\'s Owner is --project-owner; --owner names the GitHub account, in kanon apps');
    else throw new Error(`unknown argument "${arg}"`);
    if (inline !== undefined && !VALUE_FLAGS.includes(flag)) {
      throw new Error(`${flag} takes no value, not "${inline}"`);
    }
    seen.add(flag === '-h' ? '--help' : flag);
  }
  for (const [x, y] of CONFLICTS) if (seen.has(x) && seen.has(y)) throw new Error(`${x} and ${y} contradict each other; give one`);
  if (g.delegateName !== undefined || g.delegateEmail !== undefined) g.delegation = true;
  // Sent findings travel over the telemetry channel (plan 0006 §3.1), so `sent` is offered only on
  // a telemetry yes, and a flag that sends them needs `--telemetry` beside it.
  if (sends(g.upstreamFindings) && g.telemetry !== true) {
    const flag = Object.entries(UPSTREAM_FLAG_VALUES).find(([, v]) => v === g.upstreamFindings)?.[0];
    throw new Error(`--upstream-findings ${flag} needs --telemetry: sent findings travel over the telemetry channel (plan 0006 §3.1). Give --telemetry too, or choose drafted or filed-here`);
  }
  // A review trigger without the review lane is no answer (plan 0007 §6).
  if (g.reviewTrigger && opts.lanes && !opts.lanes.includes(REVIEW_LANE)) throw new Error(`--review-trigger is for a lane set with the review lane, and --lanes ${opts.lanes.map((l) => l.slice('agent-'.length)).join(',')} has none`);
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

const OWNER_REGISTERS = `query($owner: String!, $after: String) { repositoryOwner(login: $owner) { repositories(first: 100, after: $after, ownerAffiliations: [OWNER], isFork: false, orderBy: { field: PUSHED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { name object(expression: "HEAD:${REGISTER_PATH}") { ... on Blob { text } } } } } }`;

/**
 * Kanon's Apps named in the App registers of the owner's other repositories the token can read
 * (plan 0007 G4), each with `from`, the register that names it. In the order of the Apps, then of
 * the repositories, the most recently pushed first, at most ten pages of a hundred. A fork is left
 * out: its register names its upstream's Apps, which are never the owner's. `ownersOwn` then drops
 * an App of someone else's. Null when the repositories can't be read.
 * @param {(args: string[], input?: string) => Promise<{ status: number | null, stdout: string, stderr: string }>} gh
 * @param {string} owner @param {string} repoName this repository, whose register is the checkout's
 * @param {Requirements} req
 * @returns {Promise<Array<{ app: string, slug: string, from: string }> | null>}
 */
export const ownerRegisters = async (gh, owner, repoName, req) => {
  const apps = Object.keys(req.identities.apps);
  /** @type {Array<{ app: string, slug: string, from: string }>} */
  const found = [];
  /** @type {string | null} */
  let after = null;
  for (let page = 0; page < 10; page++) {
    const r = await gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query: OWNER_REGISTERS, variables: { owner, after } }));
    /** @type {any} */
    let repos;
    try {
      const j = r.status === 0 ? JSON.parse(r.stdout) : null;
      repos = Array.isArray(j?.errors) && j.errors.length ? null : j?.data?.repositoryOwner?.repositories;
    } catch {
      repos = null;
    }
    if (!Array.isArray(repos?.nodes)) {
      if (!page) return null;
      break;
    }
    for (const n of repos.nodes) {
      if (typeof n?.name !== 'string' || n.name.toLowerCase() === repoName.toLowerCase() || typeof n.object?.text !== 'string') continue;
      const rows = registerRows(n.object.text);
      for (const app of apps) {
        for (const slug of new Set(registerRolesOf(app, req).map((role) => rows.get(role)))) {
          if (slug && !found.some((f) => f.app === app && f.slug === slug)) found.push({ app, slug, from: `register:${owner}/${n.name}` });
        }
      }
    }
    if (!repos.pageInfo?.hasNextPage || typeof repos.pageInfo.endCursor !== 'string') break;
    after = repos.pageInfo.endCursor;
  }
  return found.sort((x, y) => apps.indexOf(x.app) - apps.indexOf(y.app));
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

/** The review lane, the one the review trigger is for. */
export const REVIEW_LANE = 'agent-review';

/** @typedef {'yes' | 'codes' | 'no'} Consent */
/** @typedef {'flag' | 'asked' | 'inferred' | 'default'} Source */
/** @typedef {{ source: Source, reason: string }} Why */
/** @typedef {import('./callers.mjs').Feature} Feature */

/** Where the caveats of sharing are, beyond what the consent question says itself (plan 0007 G1). */
export const SHARING_PAGE = 'docs/sharing.md';
/** The sharing page at the release init runs from. @param {string} release */
export const sharingUrl = (release) => `https://github.com/yedeya-labs/kanon/blob/${release}/${SHARING_PAGE}`;

/**
 * An option of a question: the value it sets, its label and its one-line consequence (plan 0007
 * §3 and §9), and the words a terminal answer may name it by besides its number and its label.
 * @template T
 * @typedef {{ value: T, label: string, does: string, names?: string[] }} Option
 */

/** Q1 (plan 0007 §3): the feature, or the lanes one by one. Its options are the features' titles and `does`, then Customise. */
export const FEATURE_QUESTION = 'What should Kanon do in this repo?';
/** Q1's last option, the advanced one. @type {Option<string>} */
export const CUSTOMISE = { value: 'custom', label: 'Customise', does: 'Choose lane by lane (advanced).', names: ['custom', 'customise', 'customize'] };

/**
 * Q2 (plan 0007 §3), which pull requests the Reviewer reviews. Not asked until step G7 builds the
 * review lane's trigger without a label: until then one option is no decision, and the trigger is
 * the summary's `labelled` line.
 */
export const REVIEW_TRIGGER_QUESTION = 'Which pull requests should the Reviewer review?';
/** @type {Array<Option<'labelled' | 'every-pr'>>} */
export const REVIEW_TRIGGER_OPTIONS = [
  { value: 'labelled', label: 'Only labelled ones', does: 'Only pull requests you label `review:please` get a verdict.' },
  { value: 'every-pr', label: 'Every pull request', does: "Each member's pull request gets a verdict when its CI finishes, one model run per pushed head." },
];

/** Q3 (plan 0007 §3): the adoption record's `## Data` section (K-LAYOUT-10). */
export const DATA_QUESTION = 'Does this repo hold private or sensitive material?';
/** @type {Array<Option<boolean>>} */
export const DATA_OPTIONS = [
  { value: true, label: 'Yes', does: 'The record says so; the lanes still read the files and diffs they need.', names: ['y'] },
  { value: false, label: 'No', does: 'The record says it holds none.', names: ['n'] },
];

/**
 * Q4 (plan 0007 §3), the one consent question, which sets telemetry, where upstream findings go
 * and their evidence. Its second sentence, and *Yes*'s consequence, are the disclosure ADR 0007
 * and `K-OBS-16` require the question itself to make (Owner decision 15): the evidence text may
 * rarely hold personal data, and it is read by Kanon's maintainer and a third-party decision
 * provider. The readers named are the evidence's, never the run data's, which only Kanon's store
 * holds. `<link>` is the sharing page at the pinned release (`consentQuestion`). The adopt skill
 * asks it word for word.
 */
export const CONSENT_QUESTION = 'Help improve Kanon by sharing anonymous run data and the Kanon bugs your lanes find? Evidence text may rarely hold personal data; details: <link>.';
/** The consent question with its link. @param {string} release */
export const consentQuestion = (release) => CONSENT_QUESTION.replace('<link>', sharingUrl(release));
/** @type {Array<Option<Consent>>} */
export const CONSENT_OPTIONS = [
  { value: 'yes', label: 'Yes', does: "Run data, and scrubbed bug evidence read by Kanon's maintainer and a third-party decision provider.", names: ['y'] },
  { value: 'codes', label: 'Codes only', does: 'Run data, and Kanon bugs as codes with no text.', names: ['codes'] },
  { value: 'no', label: 'No', does: 'Nothing leaves this repo; Kanon bugs stay drafts here.', names: ['n'] },
];
/**
 * What each consent level sets (plan 0007 §3). *Yes* is `sent with evidence` whatever the feature
 * (Owner decision 7): the record holds what the person consented to.
 * @type {Record<Consent, { telemetry: boolean, upstreamFindings: import('../scripts/lib/upstream-findings.mjs').Value, upstreamEvidence: boolean | null }>}
 */
export const CONSENT_LEVELS = {
  yes: { telemetry: true, upstreamFindings: 'sent with evidence', upstreamEvidence: true },
  codes: { telemetry: true, upstreamFindings: 'sent', upstreamEvidence: false },
  no: { telemetry: false, upstreamFindings: 'drafted', upstreamEvidence: null },
};
/**
 * The consent level a telemetry answer and an upstream-findings value make, or null for a
 * combination no level names, such as telemetry with `drafted`, or `filed here`.
 * @param {boolean} telemetry @param {string} upstreamFindings
 * @returns {Consent | null}
 */
export const consentOf = (telemetry, upstreamFindings) =>
  /** @type {Consent | undefined} */ (Object.entries(CONSENT_LEVELS).find(([, l]) => l.telemetry === telemetry && l.upstreamFindings === upstreamFindings)?.[0]) ?? null;

/** Q5 (plan 0007 §3), asked after the summary. */
export const CONFIRM_QUESTION = 'Install Kanon with these settings?';
/** @type {Array<Option<'install' | 'change' | 'stop'>>} */
export const CONFIRM_OPTIONS = [
  { value: 'install', label: 'Install', does: 'Writes the files and makes the changes init lists; it commits nothing.', names: ['i', 'y', 'yes'] },
  { value: 'change', label: 'Change something', does: 'Pick a line of the summary to change.', names: ['change', 'c'] },
  { value: 'stop', label: 'Stop', does: 'Nothing is written.', names: ['s', 'n', 'no'] },
];
/** The groups of the summary's lines that **Change something** offers, each asked in today's shape. */
export const CHANGE_GROUPS = ['People', 'Lanes and Apps', 'Gates, database and delegation', 'Labels, plugin and pin', 'Data and sharing'];

/** How to ask for a review (plan 0007 §3), said in the summary when the review lane is chosen. */
export const REVIEW_HOW = 'To get a review, add the label `review:please` to the pull request; the Reviewer posts its verdict once CI has finished. After a verdict, push a new commit, or remove and add the label again, to ask for another look.';

/**
 * A question with options, asked at the terminal: the question, then each option numbered with
 * its label and its consequence, the recommended one first and marked `(Recommended)`. The answer
 * is a number, a label or one of the option's names; any other is the fallback, so nothing is
 * chosen on a guess. The fallback is what pressing Enter takes: for the consent question it is
 * No, since recommended is not a default (plan 0007 §3, `K-OBS-18`).
 * @template T
 * @param {Pick<Deps, 'ask'>} deps @param {string} question @param {Array<Option<T>>} options @param {T} recommended @param {T} fallback
 * @returns {Promise<T>}
 */
export const choose = async (deps, question, options, recommended, fallback) => {
  const ordered = [...options.filter((o) => o.value === recommended), ...options.filter((o) => o.value !== recommended)];
  const text = [question, ...ordered.map((o, i) => `  ${i + 1}. ${o.label}${o.value === recommended ? ' (Recommended)' : ''}: ${o.does}`), `Answer 1-${ordered.length}, or a name`].join('\n');
  const fb = /** @type {Option<T>} */ (ordered.find((o) => o.value === fallback) ?? ordered[0]);
  const answer = (await deps.ask(text, fb.label)).trim().toLowerCase();
  const n = /^\d+$/.test(answer) ? Number(answer) : 0;
  const hit = ordered[n - 1] ?? ordered.find((o) => o.label.toLowerCase() === answer || (o.names ?? []).includes(answer));
  return (hit ?? fb).value;
};

/**
 * A feature's lanes here: its own, and each conditional lane whose condition holds (plan 0007 §2).
 * @param {Feature} f @param {(lane: string) => boolean} met
 */
export const featureLanes = (f, met) => [...f.lanes, ...Object.keys(f.conditional ?? {}).filter((l) => met(l))];

/**
 * The feature a set of lanes makes up: the one whose lanes it holds, and no lane beyond them but
 * its conditional ones; `custom` when none does.
 * @param {string[]} lanes @param {Feature[]} features
 * @returns {string}
 */
export const featureOf = (lanes, features) =>
  features.find((f) => f.lanes.every((l) => lanes.includes(l)) && lanes.every((l) => f.lanes.includes(l) || Object.hasOwn(f.conditional ?? {}, l)))?.feature ?? 'custom';

/**
 * The features as `init`'s JSON gives them (plan 0007 §6), from the requirements file: each one's
 * lanes, its conditional lanes with their conditions and whether each holds here, the lanes it
 * leaves out, its Apps, the secrets its lanes map (a caller's optional ones aside) and the steps
 * left to a person.
 * @param {Requirements} req @param {(lane: string) => boolean} met
 */
export const featureCatalogue = (req, met) =>
  (req.features ?? []).map((f) => {
    const all = [...f.lanes, ...Object.keys(f.conditional ?? {})];
    return {
      feature: f.feature,
      title: f.title,
      does: f.does,
      lanes: f.lanes,
      conditional: Object.entries(f.conditional ?? {}).map(([lane, c]) => ({ lane, condition: c.condition, met: met(lane) })),
      leftOut: Object.entries(f.leftOut ?? {}).map(([lane, reason]) => ({ lane, reason })),
      apps: f.apps,
      secrets: [...new Set(all.flatMap((l) => (req.lanes[l]?.secrets ?? []).filter((n) => !(req.lanes[l]?.optionalSecrets ?? []).includes(n))))],
      steps: f.steps,
    };
  });

/** The gates answer: comma-separated commands, or none. @param {string} answer */
const parseGates = (answer) => (/^none( yet)?$/i.test(answer.trim()) ? [] : answer.split(',').map((x) => x.trim()).filter(Boolean));

/** The lanes question, today's, for Customise. @param {Pick<Deps, 'ask'>} deps @param {Requirements} req @param {string[]} fallback */
const askLanes = async (deps, req, fallback) =>
  parseLanes(await deps.ask(`Which lanes to install? (${Object.keys(req.lanes).map((l) => l.slice(6)).join(', ')})`, fallback.map((l) => l.slice(6)).join(',')), req);

/** The Releaser's question, in today's shape. */
const RELEASER_QUESTION = 'Create the optional Releaser App, so the release PR runs CI (docs/release.md, "With the Releaser")?';

/**
 * What `askAll` infers from: the token's login, the suggested gates, git's name and email, the
 * requirements, the lanes the repository calls, whether it calls the release workflow, the
 * owner's Apps it could reuse, the user owners of `*` in CODEOWNERS, why a test database is
 * inferred (or null), whether a workflow runs Kanon's DCO check, whether the default branch has a
 * commit, whether the repository is private, whether a feature's conditional lane's condition
 * holds here, and the release init runs from.
 * @typedef {{ login: string, gates: string[], gitName: string, gitEmail: string, req: Requirements,
 *   installed?: string[], releases?: boolean, reusable?: (identities: string[]) => Array<{ app: string, slug: string, from?: string }>,
 *   codeowners?: string[] | null, database?: string | null, runsDco?: boolean, hasCommits?: boolean, isPrivate?: boolean,
 *   met?: (lane: string) => boolean, release?: string }} AskContext
 */

/**
 * Q1's terms here: the recommended feature, the one the lanes the repository calls make up, else
 * Review; what Enter and `--yes` take, that same feature, or `custom` for lanes no feature makes
 * up, and Review when it calls none; and each feature's lanes, with the conditional ones whose
 * condition holds or that the repository calls.
 * @param {AskContext} ctx
 */
const featureTerms = (ctx) => {
  const features = ctx.req.features ?? [];
  const installed = ctx.installed ?? [];
  const met = ctx.met ?? (() => false);
  const here = installed.length && features.length ? featureOf(installed, features) : null;
  const fallback = here ?? 'review';
  const lanesFor = (/** @type {string} */ id) => {
    const f = features.find((x) => x.feature === id);
    return f ? featureLanes(f, (l) => met(l) || installed.includes(l)) : [...DEFAULT_LANES];
  };
  return { features, recommended: here && here !== 'custom' ? here : 'review', lanes: fallback === 'custom' ? installed : lanesFor(fallback), lanesFor };
};

/**
 * Q1 at the terminal, and the lane question after Customise.
 * @param {Pick<Deps, 'ask'>} deps @param {AskContext} ctx @param {string[]} current
 */
const askFeature = async (deps, ctx, current) => {
  const t = featureTerms(ctx);
  if (!t.features.length) return askLanes(deps, ctx.req, current);
  /** @type {Array<Option<string>>} */
  const options = [...t.features.map((f) => ({ value: f.feature, label: f.title, does: f.does, names: [f.feature] })), CUSTOMISE];
  const picked = await choose(deps, FEATURE_QUESTION, options, t.recommended, featureOf(current, t.features));
  return picked === 'custom' ? askLanes(deps, ctx.req, current) : t.lanesFor(picked);
};

/**
 * The answers that follow from others, unless a flag or the person gave them: the feature the
 * lanes make up, the review trigger, the delegation, whether to reuse the owner's Apps, and the
 * consent level the sharing answers make (plan 0007 §4). Run again after **Change something**.
 * @param {Answers} a @param {AskContext} ctx @param {Given} [g]
 */
export const derive = (a, ctx, g = {}) => {
  const why = a.why;
  const fixed = (/** @type {string} */ f) => why[f]?.source === 'flag' || why[f]?.source === 'asked';
  a.feature = ctx.req.features?.length ? featureOf(a.lanes, ctx.req.features) : 'custom';
  why.feature = why.lanes ?? { source: 'default', reason: '' };
  if (!a.lanes.includes(REVIEW_LANE)) {
    // A Customise without the review lane drops the trigger (plan 0007 §3, Q2).
    if (g.reviewTrigger && !a.notes.some((n) => n.startsWith('--review-trigger'))) a.notes.push('--review-trigger was given, and the lanes chosen have no review lane, so it is dropped.');
    a.reviewTrigger = null;
    why.reviewTrigger = { source: 'default', reason: 'no review lane' };
  } else {
    a.reviewTrigger = 'labelled';
    why.reviewTrigger = { source: g.reviewTrigger ? 'flag' : 'default', reason: '' };
  }
  if (!fixed('delegation')) {
    const author = identitiesOf(a.lanes, ctx.req).includes('author');
    const named = Boolean(ctx.gitName && ctx.gitEmail);
    a.delegation = author && ctx.runsDco && named ? { name: ctx.gitName, email: ctx.gitEmail } : null;
    why.delegation = {
      source: 'inferred',
      reason: !author ? 'no Author lane' : !ctx.runsDco ? 'no Kanon DCO check' : !named ? "git's user.name or user.email is unset" : "an Author lane and Kanon's DCO check",
    };
  }
  // AN APP THE OWNER ALREADY HAS (#363): reused unless a flag or the person says otherwise, since
  // a second set doubles the Apps and keys the owner manages; null when there is none to reuse.
  const found = ctx.reusable?.(appIdentities(a, ctx.req)) ?? [];
  if (!found.length) {
    a.reuseApps = null;
    why.reuseApps = { source: 'inferred', reason: 'the owner has none the register lacks' };
  } else {
    if (!fixed('reuseApps')) why.reuseApps = { source: 'inferred', reason: 'the owner already has them' };
    a.reuseApps ??= true;
  }
  a.consent = consentOf(a.telemetry, a.upstreamFindings);
  return a;
};

/**
 * The answers (plan 0007 §3, §4). Without `--yes`, three questions are asked, each unless its flag
 * answers it: the feature (Q1, and the lanes one by one after Customise), whether the repository
 * holds private or sensitive material (Q3), and the one consent question (Q4). Q2, the review
 * trigger, waits for step G7. Every other answer is inferred from the repository or defaulted, as
 * plan 0007 §4's table says, unless its flag gives it, and the summary shows each with where it
 * came from (`why`). **Recommended is not a default:** with `--yes` and no flag, sharing is No,
 * the review trigger `labelled` and the Data section `not declared`.
 * @param {Pick<Deps, 'ask'>} deps @param {{ yes: boolean, lanes: string[] | null, given?: Given }} opts @param {AskContext} ctx
 */
export const askAll = async (deps, opts, ctx) => {
  const g = opts.given ?? {};
  /** @type {Why} */
  const flag = { source: 'flag', reason: '' };
  /** @type {Why} */
  const asked = { source: 'asked', reason: '' };
  /** @type {Record<string, Why>} */
  const why = {};
  const t = featureTerms(ctx);

  // Q1. A feature, or the lanes one by one.
  /** @type {string[]} */
  let lanes;
  if (opts.lanes) [lanes, why.lanes] = [opts.lanes, flag];
  else if (g.feature) [lanes, why.lanes] = [t.lanesFor(g.feature), flag];
  else if (opts.yes) [lanes, why.lanes] = [t.lanes, (ctx.installed ?? []).length ? { source: 'inferred', reason: 'from the lanes the repository calls' } : { source: 'default', reason: '' }];
  else [lanes, why.lanes] = [await askFeature(deps, ctx, t.lanes), asked];

  // Q3. Private or sensitive material: recommended Yes on a private repository, No on a public one.
  /** @type {boolean | null} */
  let sensitiveData;
  if (g.sensitiveData !== undefined) [sensitiveData, why.sensitiveData] = [g.sensitiveData, flag];
  else if (opts.yes) [sensitiveData, why.sensitiveData] = [null, { source: 'default', reason: 'nobody answered' }];
  else [sensitiveData, why.sensitiveData] = [await choose(deps, DATA_QUESTION, DATA_OPTIONS, Boolean(ctx.isPrivate), Boolean(ctx.isPrivate)), asked];

  // Q4. The one consent question; the older flags still set its three answers one by one.
  /** @type {{ telemetry: boolean, upstreamFindings: import('../scripts/lib/upstream-findings.mjs').Value, upstreamEvidence: boolean | null }} */
  let sharing;
  if (g.consent) [sharing, why.consent] = [CONSENT_LEVELS[g.consent], flag];
  else if (g.telemetry !== undefined || g.upstreamFindings !== undefined) {
    const up = g.upstreamFindings ?? UPSTREAM_DEFAULT;
    sharing = { telemetry: g.telemetry ?? false, upstreamFindings: up, upstreamEvidence: sends(up) ? up === 'sent with evidence' : null };
    why.consent = flag;
  } else if (opts.yes) [sharing, why.consent] = [CONSENT_LEVELS.no, { source: 'default', reason: 'only an explicit answer sends anything (K-OBS-18)' }];
  else [sharing, why.consent] = [CONSENT_LEVELS[await choose(deps, consentQuestion(ctx.release ?? 'main'), CONSENT_OPTIONS, 'yes', 'no')], asked];

  // The rest, inferred or defaulted (plan 0007 §4), each unless its flag gives it.
  const single = ctx.codeowners?.length === 1 ? ctx.codeowners[0] : undefined;
  const owner = g.projectOwner ?? single ?? ctx.login;
  why.projectOwner = g.projectOwner !== undefined ? flag : { source: 'inferred', reason: single ? 'from CODEOWNERS' : "the token's login" };
  const maintainer = g.maintainer ?? owner;
  why.maintainer = g.maintainer !== undefined ? flag : { source: 'inferred', reason: 'the Owner' };
  const stakeholder = g.stakeholder ?? owner;
  why.stakeholder = g.stakeholder !== undefined ? flag : { source: 'inferred', reason: 'the Owner' };
  const gates = g.gates !== undefined ? parseGates(g.gates) : ctx.gates;
  why.gates = g.gates !== undefined ? flag : ctx.gates.length ? { source: 'inferred', reason: 'suggested from what the repository holds' } : { source: 'default', reason: 'none suggested' };
  /** @type {'none' | 'hook'} */
  const database = g.testDatabase ?? (ctx.database ? 'hook' : 'none');
  why.testDatabase = g.testDatabase !== undefined ? flag : { source: 'inferred', reason: ctx.database ?? 'no database service, DATABASE_URL or migrations directory' };
  /** @type {{ name: string, email: string } | null} */
  let delegation = null;
  if (g.delegation !== undefined) {
    why.delegation = flag;
    if (g.delegation) delegation = { name: g.delegateName ?? ctx.gitName, email: g.delegateEmail ?? ctx.gitEmail };
  }
  const deleteDefaults = g.deleteDefaults ?? !ctx.hasCommits;
  why.deleteDefaultLabels = g.deleteDefaults !== undefined ? flag : { source: 'default', reason: ctx.hasCommits ? 'issues may carry them' : 'the repository has no commit yet' };
  // THE OPTIONAL RELEASER (plan 0005 §3.1, plan 0007 §2.4): on when the repository calls Kanon's
  // release workflow, off otherwise. `init` refuses `--releaser` for a repository that doesn't
  // call it, before asking anything.
  const releaser = g.releaser ?? Boolean(ctx.releases);
  why.releaser = g.releaser !== undefined ? flag : { source: 'inferred', reason: ctx.releases ? "the repository calls Kanon's release workflow" : 'no release workflow' };
  // THE KANON PLUGIN (#376), yes by default: the declaration does nothing until each person
  // trusts the folder in Claude Code.
  const plugin = g.plugin ?? true;
  why.plugin = g.plugin !== undefined ? flag : { source: 'default', reason: '' };
  if (g.reuseApps !== undefined) why.reuseApps = flag;

  /** @type {Answers} */
  const a = {
    feature: 'custom', owner, maintainer, stakeholder, lanes, gates, database, delegation, deleteDefaults, releaser,
    reuseApps: g.reuseApps ?? null, plugin, ...sharing, reviewTrigger: null, sensitiveData, consent: null, why, notes: [],
  };
  return derive(a, ctx, g);
};

/**
 * **Change something** (plan 0007 §3): one question of the summary's groups, then each chosen
 * group's questions in today's shape, each with its current value as what Enter takes. Sharing
 * is asked here as its three answers, so `filed here`, for a repository that maintains Kanon or
 * a fork, is reached only through it (plan 0007 §4).
 * @param {Pick<Deps, 'ask'>} deps @param {Answers} a @param {AskContext} ctx @param {Given} [g]
 */
export const changeSomething = async (deps, a, ctx, g = {}) => {
  const text = ['Which lines to change? Their numbers, comma-separated:', ...CHANGE_GROUPS.map((x, i) => `  ${i + 1}. ${x}`)].join('\n');
  const picked = new Set((await deps.ask(text, 'none')).split(',').map((x) => Number(x.trim())));
  const asked = (/** @type {string[]} */ ...fields) => {
    for (const f of fields) a.why[f] = { source: 'asked', reason: '' };
  };
  const yesNo = async (/** @type {string} */ q, /** @type {boolean} */ d) => /^y/i.test(await deps.ask(`${q} (y/n)`, d ? 'y' : 'n'));
  if (picked.has(1)) {
    a.owner = await deps.ask('Who is the Owner (K-ADOPT-1 step 2)?', a.owner);
    a.maintainer = await deps.ask('Who is the Maintainer?', a.maintainer);
    a.stakeholder = await deps.ask('Who is the Stakeholder?', a.stakeholder);
    asked('projectOwner', 'maintainer', 'stakeholder');
  }
  if (picked.has(2)) {
    a.lanes = await askFeature(deps, ctx, a.lanes);
    asked('lanes');
    if (ctx.releases) {
      a.releaser = await yesNo(RELEASER_QUESTION, a.releaser);
      asked('releaser');
    }
    const found = ctx.reusable?.(appIdentities(a, ctx.req)) ?? [];
    if (found.length) {
      a.reuseApps = await yesNo(reuseQuestion(found, ctx.req), a.reuseApps ?? true);
      asked('reuseApps');
    }
  }
  if (picked.has(3)) {
    a.gates = parseGates(await deps.ask("The stack's gates, the commands a change must pass, comma-separated", a.gates.join(', ') || 'none yet'));
    a.database = /^hook$/i.test(await deps.ask('Does a lane need a test database your project-setup hook starts? (none/hook)', a.database)) ? 'hook' : 'none';
    a.delegation = (await yesNo("Record a sign-off delegation, so agents' commits pass a required dco check (K-AGENT-44)?", a.delegation !== null))
      ? { name: await deps.ask('The delegate, as their sign-off writes their name', a.delegation?.name ?? ctx.gitName), email: await deps.ask("The delegate's email", a.delegation?.email ?? ctx.gitEmail) }
      : null;
    asked('gates', 'testDatabase', 'delegation');
  }
  if (picked.has(4)) {
    a.deleteDefaults = await yesNo("Delete GitHub's default labels that aren't in Kanon's taxonomy?", a.deleteDefaults);
    a.plugin = await yesNo("Declare the kanon plugin in .claude/settings.json, pinned to this release, so everyone who uses Claude Code here gets Kanon's skills (docs/skills.md)?", a.plugin);
    asked('deleteDefaultLabels', 'plugin');
  }
  if (picked.has(5)) {
    a.sensitiveData = await choose(deps, DATA_QUESTION, DATA_OPTIONS, Boolean(ctx.isPrivate), a.sensitiveData ?? Boolean(ctx.isPrivate));
    // TELEMETRY (#428) and UPSTREAM FINDINGS (plan 0006 §3.2), as their own questions: `sent` is
    // offered only on a telemetry yes, since it travels over that channel, and the evidence text is
    // asked about only after `sent`. An answer it didn't offer is the default, so nothing is sent
    // on a guess.
    a.telemetry = await yesNo(TELEMETRY_QUESTION, a.telemetry);
    const now = Object.entries(UPSTREAM_FLAG_VALUES).find(([, v]) => v === (a.upstreamFindings === 'sent with evidence' ? 'sent' : a.upstreamFindings))?.[0] ?? 'drafted';
    const answer = (await deps.ask(upstreamFindingsQuestion(a.telemetry), a.telemetry || !sends(a.upstreamFindings) ? now : 'drafted')).trim().toLowerCase().replace(/\s+/g, '-');
    const where = UPSTREAM_FLAG_VALUES[answer];
    const evidence = a.upstreamEvidence === true;
    a.upstreamFindings = where === 'drafted' || where === 'filed here' || (where === 'sent' && a.telemetry) ? where : UPSTREAM_DEFAULT;
    a.upstreamEvidence = null;
    if (a.upstreamFindings === 'sent') {
      a.upstreamEvidence = await yesNo(UPSTREAM_EVIDENCE_QUESTION, evidence);
      if (a.upstreamEvidence) a.upstreamFindings = 'sent with evidence';
    }
    asked('sensitiveData', 'consent');
  }
  return derive(a, ctx, g);
};

/**
 * `--upstream-findings`' values (plan 0006 decision 14), each the declaration's value it writes.
 * @type {Record<string, import('../scripts/lib/upstream-findings.mjs').Value>}
 */
export const UPSTREAM_FLAG_VALUES = { drafted: 'drafted', 'filed-here': 'filed here', sent: 'sent', 'sent-with-evidence': 'sent with evidence' };

/**
 * The question where upstream findings go (plan 0006 §3.2), offering `sent` only when the
 * telemetry answer is yes, and otherwise saying that it needs telemetry.
 * @param {boolean} telemetry
 */
export const upstreamFindingsQuestion = (telemetry) =>
  [
    "Where do upstream findings go? An upstream finding is one about Kanon itself (a lane's behaviour, a guard, a rule or Kanon's library), found by the Overseer or the telemetry Explorer; whichever you choose, nothing is ever filed in another repository.",
    "drafted: written into the audit issue or the run's summary, for you to read; nothing is filed or sent.",
    telemetry
      ? "sent: also sent to Kanon's telemetry store as codes only (the lane, stage, error and reason codes, the Kanon release, rulebook ids, Kanon's own file paths and a fix category); no text."
      : "Sending them to Kanon as codes needs telemetry, which this repository doesn't send, so it isn't offered.",
    'filed-here: filed as issues in this repository, for a repository that maintains Kanon itself or a fork of it.',
    telemetry ? '(drafted/sent/filed-here)' : '(drafted/filed-here)',
  ].join(' ');

/**
 * The evidence question (plan 0006 §3.2, decision 14), asked only after `sent`, in the plan's own
 * words: who reads the text, a third-party decision provider among them, and that it may rarely
 * still hold personal data. The adopt skill quotes it word for word.
 */
export const UPSTREAM_EVIDENCE_QUESTION =
  "Also send each finding's evidence and suggested fix, as text? The agent writes it for Kanon's maintainer, to Kanon's template, without names, logins, URLs, repository names or quotes of this repository's text, and before it leaves, an automatic scrub removes URLs, this repository's name, the logins and names the lane can see, and every path outside Kanon's own files. It may rarely still contain personal data, such as a name the scrub didn't know. The text is read by Kanon's maintainer, and by a third-party decision provider, TypeSafe, whose model, Jev, decides whether a finding becomes a public Kanon issue. The text itself is never published: a public issue holds only the codes. It is kept 13 months in Frankfurt and erased on request, like telemetry.";

/**
 * The question for Apps the owner already has (#363), saying where they were found: its
 * installations, or another repository's register (plan 0007 G4).
 * @param {Array<{ app: string, slug: string, from?: string }>} found @param {Requirements} req
 */
export const reuseQuestion = (found, req) => {
  const name = (/** @type {string} */ app) => req.identities.apps[app]?.name ?? app;
  const apps = [...new Set(found.map((f) => f.app))];
  const list = apps.map((app) => `the ${name(app)} (${found.filter((f) => f.app === app).map((f) => f.slug).join(' or ')})`).join(' and ');
  const registers = [...new Set(found.flatMap((f) => (f.from?.startsWith('register:') ? [f.from.slice('register:'.length)] : [])))];
  const where = registers.length ? `named in ${registers.map((r) => `${r}'s`).join(' and ')} App register${registers.length > 1 ? 's' : ''}` : `installed with exactly ${apps.length > 1 ? 'their' : 'its'} permissions`;
  return `The owner already has ${list}, ${where}. Reuse ${apps.length > 1 ? 'them' : 'it'} here with kanon apps --reuse, rather than create a second ${apps.length > 1 ? 'set' : 'one'}?`;
};

/**
 * The telemetry question (#428), saying what is sent, where, who reads it, and how to stop and
 * erase it, from plan 0002 and docs/telemetry.md.
 */
export const TELEMETRY_QUESTION =
  "Send this repository's agent-run rows to Kanon's hosted telemetry store? Each row is plan 0002's fixed fields about one lane run (lane, outcome, model, cost, tokens, durations, counts, the run, pull request and issue numbers, the Kanon release): no code, no text, no logins or file paths. They go to one table in Kanon's AWS account in Frankfurt (eu-central-1), under an opaque key, and are kept 13 months. Kanon's operator reads them to improve Kanon: Kanon notices failures it caused in your runs, often fixing them before you would report one, and you get cross-adopter cost and reliability baselines. The operator publishes only aggregates of at least three adopters; your repository's own reader role reads only its rows. Stop by deleting .github/workflows/telemetry.yml; the operator erases what was sent on request (docs/telemetry.md, \"Erase an adopter\").";

/**
 * The answers `askAll` gives, with where each came from (`why`, by its `.answers` field) and the
 * notes the answers make.
 * @typedef {{ feature: string, owner: string, maintainer: string, stakeholder: string, lanes: string[], gates: string[],
 *   database: 'none' | 'hook', delegation: { name: string, email: string } | null, deleteDefaults: boolean, releaser: boolean,
 *   reuseApps: boolean | null, plugin: boolean, telemetry: boolean, upstreamFindings: import('../scripts/lib/upstream-findings.mjs').Value,
 *   upstreamEvidence: boolean | null, reviewTrigger: 'labelled' | null, sensitiveData: boolean | null, consent: Consent | null,
 *   why: Record<string, Why>, notes: string[] }} Answers
 */

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
  const choices = [];
  // The feature and the review trigger (plan 0007 §6, K-LAYOUT-10): without the bullets the record
  // means `custom` and `labelled`, so `custom` writes none, and a trigger is written only beside
  // the review lane. `every pull request` is never written until step G7 builds it.
  if (a.feature && a.feature !== 'custom') choices.push(`- **Feature:** \`${a.feature}\``);
  if (a.reviewTrigger === 'labelled') choices.push('- **Review trigger:** `labelled`');
  if (a.lanes.includes('agent-overseer')) choices.push('- **Overseer:** `installed`');
  if (a.upstreamFindings && a.upstreamFindings !== UPSTREAM_DEFAULT) choices.push(`- **${UPSTREAM_LABEL}:** \`${a.upstreamFindings}\``);
  if (choices.length) lines.push('## Choices', '', ...choices, '');
  // Q3's answer (plan 0007 §3, K-LAYOUT-10), after `## Choices`: `not declared` when nobody answered.
  const data = a.sensitiveData === true ? 'yes' : a.sensitiveData === false ? 'no' : 'not declared';
  lines.push(
    '## Data',
    '',
    `Whether this repository holds private or sensitive material, ${data === 'not declared' ? 'which nobody declared' : 'as declared'} at install. The lanes read the files and diffs their work needs either way.`,
    '',
    `- **Private or sensitive material:** \`${data}\``,
    '',
  );
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
    "The project's stack document (`K-LAYOUT-17`), started by `kanon init`. The sections it leaves out mean their documented defaults: no schema changes, nothing to isolate, no generated files, and the whole repository as code, with a JavaScript or TypeScript test being a `*.test.*` or `*.spec.*` file that nothing runs until `## Code areas` names its tree and runner.",
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

/** Where GitHub looks for CODEOWNERS, in its order: the first that exists is the one it reads. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/**
 * The user owners of `*` in the repository's CODEOWNERS (plan 0007 §4): the logins of the last
 * `*` line, as GitHub's last matching pattern wins, without its teams (`@org/team`) and emails.
 * Null when there is no CODEOWNERS, or it has no `*` line.
 * @param {(rel: string) => string | null} read
 * @returns {string[] | null}
 */
export const codeownersOf = (read) => {
  const text = CODEOWNERS_PATHS.map((p) => read(p)).find((t) => t !== null);
  if (text === undefined || text === null) return null;
  /** @type {string[] | null} */
  let owners = null;
  for (const line of text.split('\n')) {
    const [pattern, ...who] = line.replace(/(^|\s)#.*$/, '').trim().split(/\s+/);
    if (pattern === '*') owners = who.filter((w) => /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(w)).map((w) => w.slice(1));
  }
  return owners;
};

/** The compose files, example environment files and migrations directories a test database is inferred from. */
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const MIGRATIONS = ['migrations', 'db/migrate', 'db/migrations', 'prisma/migrations', 'supabase/migrations'];
const DATABASE_IMAGE = /^\s*image:\s*["']?(?:[\w.-]+\/)*(postgres|postgis|mysql|mariadb|mongo|mssql|cockroach)/im;

/**
 * Why the repository's tests need a database, or null (plan 0007 §4): a database service in a
 * compose file, `DATABASE_URL` in an example environment file, or a migrations directory.
 * @param {(rel: string) => string | null} read @param {(rel: string) => string[]} list
 * @returns {string | null}
 */
export const testDatabaseSignal = (read, list) => {
  for (const f of COMPOSE_FILES) if (DATABASE_IMAGE.test(read(f) ?? '')) return `a database service in ${f}`;
  for (const f of ENV_EXAMPLES) if (/^\s*(?:export\s+)?DATABASE_URL\s*=/m.test(read(f) ?? '')) return `DATABASE_URL in ${f}`;
  for (const d of MIGRATIONS) if (list(d).length) return `a migrations directory, ${d}/`;
  return null;
};

/** Whether a workflow of the checkout runs Kanon's DCO check (`K-AGENT-44`). @param {(rel: string) => string | null} read @param {string[]} workflows their paths */
export const runsDco = (read, workflows) => workflows.some((p) => /^\s*-?\s*uses:\s*yedeya-labs\/kanon\/actions\/dco@/m.test(read(p) ?? ''));

/**
 * What `init` does with a file it plans: `same`, already as it writes it; `kept`, a declaration
 * or the project-setup hook that exists, the project's; `differs`, a workflow that exists and
 * differs; or `new`.
 * @param {string} rel @param {string} text @param {string | null} have @param {Requirements} req
 * @returns {'same' | 'kept' | 'differs' | 'new'}
 */
export const fileStatus = (rel, text, have, req) => (have === text ? 'same' : have !== null && (rel.startsWith('docs/') || rel === req.hook.path) ? 'kept' : have !== null ? 'differs' : 'new');

/**
 * A line of the summary (plan 0007 §4): its name, the `.answers` fields it shows (none for a line
 * that is what `init` does rather than an answer), its value, where the value came from, and why.
 * @typedef {{ answer: string, fields: string[], value: string, source: Source, reason: string }} SummaryLine
 */

/**
 * The summary (plan 0007 §4): one line per value, each with where it came from, shown before
 * anything is written. Every answer is on a line, so nothing is silent.
 * @param {{ s: Inspection, a: Answers, req: Requirements, repo: string, release: string, read: (rel: string) => string | null,
 *   files: Map<string, string>, rows: Map<string, string>, ownerApps: Array<{ app: string, slug: string, from: string }> | null,
 *   met: (lane: string) => boolean }} c
 * @returns {SummaryLine[]}
 */
export const summaryOf = ({ s, a, req, repo, release, read, files, rows, ownerApps, met }) => {
  /** @type {SummaryLine[]} */
  const lines = [];
  const why = (/** @type {string} */ f) => a.why[f] ?? { source: /** @type {Source} */ ('default'), reason: '' };
  const line = (/** @type {string} */ answer, /** @type {string[]} */ fields, /** @type {string} */ value, /** @type {Why} */ w) => lines.push({ answer, fields, value, source: w.source, reason: w.reason });
  const inferred = (/** @type {string} */ reason) => /** @type {Why} */ ({ source: 'inferred', reason });
  const byDefault = (/** @type {string} */ reason = '') => /** @type {Why} */ ({ source: 'default', reason });
  const feature = req.features?.find((f) => f.feature === a.feature);
  line('Feature', ['feature', 'lanes'], `${feature ? feature.title : 'Customised'}: ${a.lanes.join(', ')}`, why('lanes'));
  // A conditional lane of the feature whose condition doesn't hold, and agent-merge, each said in one line (plan 0007 §2.3).
  if (feature) {
    const out = Object.entries(feature.conditional ?? {}).filter(([l]) => !a.lanes.includes(l));
    if (out.length) line('Left out', [], out.map(([l, c]) => `${l}, only ${c.condition}`).join('; '), inferred(out.some(([l]) => met(l)) ? '' : 'none of their conditions holds here'));
  }
  if (a.lanes.includes('agent-merge')) line('Merger', [], 'agent-merge is in: the catalogue recommends it once people have merged the approved Implementer PRs by hand for a while', byDefault());
  line('Review', ['reviewTrigger'], a.reviewTrigger === 'labelled' ? 'labelled: add `review:please` to a PR to get a verdict' : 'none: no review lane', why('reviewTrigger'));
  line('Data', ['sensitiveData'], a.sensitiveData === true ? 'holds private material (## Data)' : a.sensitiveData === false ? 'holds none (## Data)' : 'not declared (## Data)', why('sensitiveData'));
  const sharing = {
    yes: 'yes: telemetry on, findings sent with evidence',
    codes: 'codes only: telemetry on, findings sent as codes',
    no: 'no: nothing leaves this repo, findings drafted',
  };
  line('Sharing', ['consent', 'telemetry', 'upstreamFindings', 'upstreamEvidence'], a.consent ? sharing[a.consent] : `custom: telemetry ${a.telemetry ? 'on' : 'off'}, findings ${a.upstreamFindings}`, why('consent'));
  const identities = appIdentities(a, req);
  const appName = (/** @type {string} */ i) => req.identities.apps[i]?.name ?? i;
  const apps = identities.map((i) => {
    if (registerRolesOf(i, req).every((r) => rows.has(r))) return `${appName(i)}: registered`;
    const own = a.reuseApps ? (ownerApps ?? []).find((f) => f.app === i) : undefined;
    if (own) return `${appName(i)}: reuse ${own.slug}, from ${own.from.startsWith('register:') ? `${own.from.slice('register:'.length)}'s register` : "the owner's installations"}`;
    return `${appName(i)}: create`;
  });
  line('Apps', ['reuseApps'], apps.length ? apps.join('; ') : 'none: the lanes run as no App', why('reuseApps'));
  line('Releases', ['releaser'], a.releaser ? 'on: the Releaser App opens the release PRs' : 'off', why('releaser'));
  const people = a.owner === a.maintainer && a.owner === a.stakeholder ? `Owner, Maintainer, Stakeholder: ${a.owner}` : `Owner ${a.owner}; Maintainer ${a.maintainer}; Stakeholder ${a.stakeholder}`;
  line('People', ['projectOwner', 'maintainer', 'stakeholder'], people, why('projectOwner'));
  line('Gates', ['gates'], a.gates.length ? a.gates.join('; ') : 'none yet', why('gates'));
  line('Test database', ['testDatabase'], a.database === 'hook' ? 'hook: your project-setup hook starts it' : 'none', why('testDatabase'));
  line('Delegation', ['delegation'], a.delegation ? `${a.delegation.name} <${a.delegation.email}>` : 'none', why('delegation'));
  line('Labels', ['deleteDefaultLabels'], `create Kanon's taxonomy; ${a.deleteDefaults ? 'delete' : 'keep'} GitHub's defaults`, why('deleteDefaultLabels'));
  line('Milestones', [], 'the bucket milestones', byDefault());
  const ruleset =
    s.rulesets === 'no' ? ['none: the plan has no rulesets, so nothing on GitHub enforces review', 'the plan']
    : s.covering.length ? [`keep ${s.covering.map((c) => c.name).join(', ')}; Lane check once a job on ${s.defaultBranch} reports it`, 'rulesets cover the default branch']
    : !s.hasCommits ? [`none yet: after the first commit to ${s.defaultBranch}`, 'the default branch has no commit']
    : s.admin ? [`create on ${s.defaultBranch}; Lane check once a job there reports it`, 'the token administers it']
    : [`a step for you: the token can't administer ${repo}`, "the token can't administer it"];
  line('Ruleset', [], ruleset[0] ?? '', inferred(ruleset[1] ?? ''));
  line('Merging', [], 'squash only', byDefault());
  line('Plugin', ['plugin'], a.plugin ? `declared in ${SETTINGS_PATH} at ${release}` : 'not declared', why('plugin'));
  line('Pin', [], `${release}, the release init runs from`, inferred(''));
  line('CI', [], read('.github/workflows/ci.yml') === null ? 'write .github/workflows/ci.yml' : 'keep .github/workflows/ci.yml', inferred(''));
  const dep = read('.github/dependabot.yml');
  line('Dependabot', [], dep === null ? 'write .github/dependabot.yml with the Kanon entry' : /yedeya-labs\/kanon\*/.test(dep) ? 'has the Kanon entry' : 'add the Kanon entry', byDefault());
  /** @type {Record<string, number>} */
  const count = { new: 0, kept: 0, same: 0, differs: 0 };
  for (const [rel, text] of files) count[fileStatus(rel, text, read(rel), req)] = (count[fileStatus(rel, text, read(rel), req)] ?? 0) + 1;
  line('Files', [], `${count.new} new, ${count.kept} kept, ${count.same} already as written, ${count.differs} differ`, inferred('from the checkout'));
  const steps = [
    ...apps.filter((x) => / create$/.test(x)).map((x) => `create the ${x.split(':')[0]} App`),
    ...apps.filter((x) => /: reuse /.test(x)).map((x) => `1 key for the ${x.split(':')[0]}`),
    ...([...new Set(a.lanes.flatMap((l) => req.lanes[l]?.secrets ?? []))].filter((n) => n === 'CLAUDE_CODE_OAUTH_TOKEN' || n === 'DIGEST_WEBHOOK').filter((n) => !s.secrets?.has(n)).map((n) => (n === 'DIGEST_WEBHOOK' ? 'the chat webhook' : 'the Claude token'))),
    'merge the PR',
    ...(a.lanes.includes(REVIEW_LANE) ? ['1 test PR'] : []),
  ];
  line('Your steps', [], steps.join(', '), inferred(''));
  return lines;
};

/**
 * The summary as a person reads it: a heading with the repository, then a line per value, its
 * name, its value and where it came from.
 * @param {SummaryLine[]} lines @param {{ s: Inspection, repo: string, release: string }} c
 */
export const summaryText = (lines, { s, repo, release }) => [
  `Kanon ${release} for ${repo} (${s.isPrivate ? 'private' : 'public'}, ${s.kind === 'User' ? 'personal account' : 'organisation'}; rulesets: ${s.rulesets})`,
  '',
  ...lines.map((l) => `${l.answer.padEnd(15)}${l.value.padEnd(52)} ${l.source}${!l.reason ? '' : l.reason.startsWith('from ') ? ` ${l.reason}` : `: ${l.reason}`}`),
];

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
 *   features: ReturnType<typeof featureCatalogue>,
 *   summary: SummaryLine[],
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
  const rep = { repository: null, token: null, dryRun: false, inspection: null, answers: null, catalogue: [], features: [], summary: [], files: [], changes: [], apps: null, findings: [], notes: [], failures: [], error: null };
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
    features: rep.features,
    summary: rep.summary,
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
    return stop(2, [`${opts.releaserFlag ?? '--releaser'} is for a repository that calls Kanon's release workflow from .github/workflows/release.yml (docs/release.md), and this one doesn't. Nothing was changed.`]);
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
    codeowners: codeownersOf(read),
  };
  rep.catalogue = laneCatalogue(req, installed);
  // A feature's conditional lane is in when its condition holds here (plan 0007 §2.3): the hook it
  // calls exists in the checkout, or the repository holds the secret it takes.
  const met = (/** @type {string} */ lane) => {
    const c = req.features?.flatMap((f) => Object.entries(f.conditional ?? {})).find(([l]) => l === lane)?.[1];
    return Boolean(c && ((c.hook && read(c.hook) !== null) || (c.secret && s.secrets?.has(c.secret))));
  };
  rep.features = featureCatalogue(req, met);
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
  // installation whose App this register already names is this repository's own. Each App is
  // matched alike, the Releaser as strictly as the Author and the Judge (#462): its exact
  // permissions, no events, and an App of the owner's own, never another account's. When the
  // installations can't be listed, the registers of the owner's other repositories name the Apps
  // it has (plan 0007 G4); when they can, they decide, so an App they show drifted isn't offered.
  const rows = registerRows(read(REGISTER_PATH));
  const named = new Set(rows.values());
  const lacking = Object.keys(req.identities.apps).filter((i) => registerRolesOf(i, req).some((r) => !rows.has(r)));
  /** @type {Array<{ app: string, slug: string, appId: number | null, from: string }> | null} null when neither the installations nor another register names one */
  let ownerApps = [];
  /** @type {string | null} why the installations can't be listed */
  let unlisted = null;
  if (lacking.length) {
    const { listed, installs } = await ownerInstallations(deps.gh, s.owner, s.kind);
    if (installs) ownerApps = (await ownersOwn(deps.gh, s.owner, ownerKanonApps(installs, s.owner, req.identities.apps).filter((f) => !named.has(f.slug)))).map((f) => ({ ...f, from: 'installation' }));
    else {
      const registered = await ownerRegisters(deps.gh, s.owner, repoName, req);
      const own = registered ? await ownersOwn(deps.gh, s.owner, registered.filter((f) => !named.has(f.slug))) : [];
      ownerApps = own.length ? own.map((f) => ({ ...f, appId: null })) : null;
      unlisted =`the token can't list ${s.owner}'s App installations (${listed.stderr.trim() || `exit ${listed.status}`}), so init can't tell whether ${s.owner} already has Kanon's Apps. ${
        s.kind === 'Organization' ? `Only an owner of ${s.owner} can list them, with the organisation's Administration permission (read).` : "On a personal account gh's token can't list them."
      }`;
    }
  }
  rep.inspection.ownerApps = ownerApps && ownerApps.map((f) => ({ app: f.app, slug: f.slug, from: f.from }));
  out('');
  const workflows = checkoutWorkflows(deps, root);
  /** @type {AskContext} */
  const ctx = {
    login: who.login ?? ownerName,
    gates: suggestGates(read),
    gitName,
    gitEmail,
    req,
    installed,
    releases,
    reusable: (ids) => (ownerApps ?? []).filter((f) => ids.includes(f.app) && lacking.includes(f.app)),
    codeowners: /** @type {string[] | null} */ (rep.inspection.codeowners),
    database: testDatabaseSignal(read, (rel) => deps.listDir(join(root, rel))),
    runsDco: runsDco(read, deps.listDir(join(root, '.github/workflows')).filter((n) => /\.ya?ml$/.test(n)).map((n) => `.github/workflows/${n}`)),
    hasCommits: s.hasCommits,
    isPrivate: s.isPrivate,
    met,
    release,
  };
  const a = await askAll(deps, opts, ctx);
  // THE SUMMARY (plan 0007 §4): every value, and where it came from, before anything is written.
  // Without --yes it is confirmed in one question, or changed, a group at a time, and shown again.
  const plan = () => plannedFiles({ s, a, req, release, repo, today: deps.today(), read, workflows, callers });
  for (;;) {
    rep.summary = summaryOf({ s, a, req, repo, release, read, files: plan(), rows, ownerApps, met });
    out('');
    for (const l of summaryText(rep.summary, { s, repo, release })) out(l);
    if (a.lanes.includes(REVIEW_LANE)) {
      out('');
      out(REVIEW_HOW);
    }
    if (opts.yes) break;
    out('');
    const go = await choose(deps, CONFIRM_QUESTION, CONFIRM_OPTIONS, 'install', 'install');
    if (go === 'install') break;
    if (go === 'stop') {
      out('Stopped: nothing was written or changed.');
      return 0;
    }
    await changeSomething(deps, a, ctx, opts.given);
  }
  for (const n of a.notes) {
    out(n);
    rep.notes.push(n);
  }
  if (a.sensitiveData === null) {
    const line = "Whether the repository holds private or sensitive material is not declared: the adoption record's ## Data section says so. Give --sensitive-data or --no-sensitive-data to declare it.";
    out(line);
    rep.notes.push(line);
  }
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
    upstreamFindings: a.upstreamFindings,
    upstreamEvidence: a.upstreamEvidence,
    feature: a.feature,
    reviewTrigger: a.reviewTrigger,
    sensitiveData: a.sensitiveData,
    consent: a.consent,
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
  const files = plan();
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
  const first = (/** @type {string} */ i) => /** @type {{ slug: string, appId: number | null, from: string }} */ (owned.find((f) => f.app === i));
  rep.apps = { identities, missing, reuse: reusing.map((i) => ({ app: i, slug: first(i).slug, appId: first(i).appId })), command: null, outcome: failures ? 'failed' : 'none', exitCode: null };
  const appsRep = rep.apps;
  if (missing.length && ownerApps === null && unlisted) note(`Not looked for: ${unlisted}`);
  for (const i of reusing) {
    const all = owned.filter((f) => f.app === i);
    // The App ID, when its installation carries it, is filled in, so the person needn't copy it
    // from the App's page (#640); a register names only the slug.
    const { slug, appId, from } = first(i);
    const name = req.identities.apps[i]?.name ?? i;
    const also = all.length > 1 ? ` (it also has ${all.slice(1).map((f) => (f.appId ? `${f.slug}, App ID ${f.appId},` : f.slug)).join(', ')} with the same permissions: give the one ${repoName} should share)` : '';
    const where = from.startsWith('register:') ? ` (${from.slice('register:'.length)}'s App register names it)` : '';
    const todo = appId ? `Add ${repoName} to its installation and generate a private key on its settings page, then run this with the key` : `Add ${repoName} to its installation, generate a private key on its settings page and copy its App ID from the same page, then run this with both`;
    const todoText = appId
      ? `Add ${repoName} to the App's installation and generate a private key on its settings page, then run kanon apps --reuse with the key`
      : `Add ${repoName} to the App's installation, generate a private key on its settings page and copy its App ID from the same page, then run kanon apps --reuse with both`;
    step({
      id: 'app.reuse',
      category: 'app',
      subject: i,
      prose: `${s.owner} already has the ${name} App ${slug}${where}${also}. ${todo}, and commit the register rows it writes:`,
      message: `${s.owner} already has the ${name} App ${slug}, which the chosen lanes run as, and the register lacks it${where}.`,
      text: `${todoText}, and commit the register rows it writes.${also}`,
      commands: [`kanon apps --owner ${s.owner} --repo ${repoName} --reuse ${i}:${slug}@${appId ?? '<App ID>'}=<downloaded>.pem`],
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
    // it already has for another repository looks missing here (#363), even with another
    // register naming some (plan 0007 G4), so the step says to reuse such an App rather than
    // create a second one.
    const reuseInstead = unlisted === null ? '' : ` If ${s.owner} already has ${toCreate.length > 1 ? 'these Apps' : 'this App'} for another repository, don't create ${toCreate.length > 1 ? 'them' : 'it'} again: add ${repoName} to ${toCreate.length > 1 ? 'each' : 'its'} installation, generate a private key on its settings page and copy its App ID from there, and run kanon apps --owner ${s.owner} --repo ${repoName} --reuse <app>:<slug>@<App ID>=<key file> instead (docs/apps.md, "A repository added later").`;
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
          prose: `The register lists the ${i} App, but the repository lacks ${lacks.join(' and ')}. Add ${repoName} to the App's installation, generate a private key on its settings page and copy its App ID from the same page, then:`,
          message: `The register lists the ${i} App, but the repository lacks ${lacks.join(' and ')}.`,
          text: `Add ${repoName} to the App's installation, generate a private key on its settings page and copy its App ID from the same page, then run kanon apps --reuse with both.`,
          commands: [`kanon apps --owner ${s.owner} --repo ${repoName} --reuse ${i}:${slug}@<App ID>=<downloaded>.pem`],
          url: known ? (s.kind === 'User' ? `https://github.com/settings/apps/${known}` : `https://github.com/organizations/${s.owner}/settings/apps/${known}`) : null,
        });
      }
    }
    const others = [...new Set(a.lanes.flatMap((l) => req.lanes[l]?.secrets ?? []))].filter((n) => !/_APP_(ID|PRIVATE_KEY)$/.test(n) && !s.secrets?.has(n));
    const secretsUrl = `https://github.com/${repo}/settings/secrets/actions`;
    if (others.includes('CLAUDE_CODE_OAUTH_TOKEN')) {
      const prose = `Store the token of the Claude subscription the agents run on, made with \`claude setup-token\` (docs/lanes.md), ${OWN_TERMINAL}:`;
      step({ id: 'secret.claude-code-oauth-token', category: 'secret', subject: 'CLAUDE_CODE_OAUTH_TOKEN', prose, message: 'The repository lacks CLAUDE_CODE_OAUTH_TOKEN, which the chosen lanes map.', text: prose.replace(/:$/, '.'), commands: [`gh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}   ${OWN_TERMINAL_NOTE}`], url: secretsUrl });
    }
    if (others.includes('DIGEST_WEBHOOK')) {
      const prose = `Store the chat webhook the digests post to, ${OWN_TERMINAL}:`;
      step({ id: 'secret.digest-webhook', category: 'secret', subject: 'DIGEST_WEBHOOK', prose, message: 'The repository lacks DIGEST_WEBHOOK, which the chosen lanes map.', text: prose.replace(/:$/, '.'), commands: [`gh secret set DIGEST_WEBHOOK -R ${repo}   ${OWN_TERMINAL_NOTE}`], url: secretsUrl });
    }
    // The QA store's coordinates (kanon#433): secrets, which the runner masks in the store jobs'
    // logs. Asked for only where the store hook exists: without one the lanes run without memory,
    // and their callers map the two empty. A variable of the same name, v0.33.0's way, which the
    // lanes no longer read (kanon#479), is copied. They aren't secret, so the line carries each with
    // `--body`, which works at the Claude Code prompt with `!` too (#625).
    const storeLacks = (req.qaStore?.secrets ?? []).filter((n) => others.includes(n));
    if (storeLacks.length && req.qaStore && read(req.qaStore.hook) !== null) {
      const vars = await ghJson(deps, ['variable', 'list', '-R', repo, '--json', 'name']);
      const asVariable = new Set(vars.ok ? vars.json.map((/** @type {any} */ v) => String(v.name)) : []);
      const output = (/** @type {string} */ n) => (n === 'QA_STORE_ROLE_ARN' ? 'RoleArn' : 'BucketName');
      step({
        id: 'secret.qa-store',
        category: 'secret',
        subject: storeLacks.join(', '),
        prose: `${req.qaStore.hook} exists, so store the QA store's coordinates as secrets, never as variables: the lanes hand the hook no variables (kanon#479), and a variable is never masked in a log (docs/qa-store.md):`,
        message: `The repository has a QA store hook, and lacks ${storeLacks.join(' and ')}, which the store-coupled lanes map.`,
        text: `Store the stack's ${storeLacks.map(output).join(' and ')} ${storeLacks.length > 1 ? 'outputs' : 'output'} as ${storeLacks.join(' and ')}${storeLacks.some((n) => asVariable.has(n)) ? ', copying each from the variable of the same name, which you then delete once a store job has run green' : ''}${storeLacks.some((n) => !asVariable.has(n)) ? `, putting the output in for its \`<…>\` on the line: it isn't secret, and with \`--body\` the line works at the Claude Code prompt with \`!\` too` : ''}.`,
        commands: storeLacks.flatMap((n) => (asVariable.has(n)
          ? [`gh variable get ${n} -R ${repo} | gh secret set ${n} -R ${repo}`]
          : [`gh secret set ${n} -R ${repo} --body '<${output(n)}>'`])),
        url: secretsUrl,
      });
    }
  } else {
    // The store's secrets only where the store hook exists, as secret.qa-store asks (#480).
    const all = [...new Set(a.lanes.flatMap((l) => req.lanes[l]?.secrets ?? []))]
      .filter((n) => !req.qaStore?.secrets.includes(n) || read(req.qaStore.hook) !== null);
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
