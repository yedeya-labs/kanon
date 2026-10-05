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
//    caller, `lane-check` in CI, the Dependabot entry and a starting project-setup hook, every
//    Kanon reference pinned to the release it runs from, and prints the diff. It commits nothing.
// 4. CREATES the taxonomy's labels (rulebook/labels.json), the bucket milestones (`kanon
//    milestones`), the squash-only merge setting and, where the plan has rulesets and the token
//    can administer the repository, the default branch's ruleset with its required check.
// 5. DRIVES `kanon apps` for the identities the chosen lanes run as.
// 6. SAYS PLAINLY what the plan can't enforce: on a private repository without rulesets, nothing
//    on the platform refuses a merge without the Reviewer's approval (decision 3, K-ADOPT-3).
//
// Whatever the token can't do is printed as an exact manual step. Re-running it is safe: it
// changes nothing that is already right, never overwrites a file, and names what differs.
// `--dry-run` reads everything and changes nothing.
//
// THE APPS. Which identities a lane runs as is read from the secrets it declares, through the
// requirements file (`<NAME>_APP_ID` names the identity). Today that is one App per role, and
// `kanon apps --roles` creates them. When step L4 renames the lanes' secrets to the Apps'
// (`AUTHOR_APP_ID`, `JUDGE_APP_ID`), the same file names `author` and `judge`, and `appsArgs`
// below passes `--apps` instead, with no other change here.
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { URL } from 'node:url';
import { REGISTER_PATH, apps as runApps, checkoutCheck, remoteRepo } from './apps.mjs';
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
} from './callers.mjs';
import { whoami } from './gh-token.mjs';
import { BUCKETS, milestones as runMilestones } from './milestones.mjs';

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
has rulesets, the default branch's ruleset, and runs \`kanon apps\` for the lanes' Apps. It
commits nothing, and prints as exact steps whatever its token can't do. Safe to run again.

Options:
  --repo <owner>/<repo>  the repository (default: the checkout's origin remote)
  --dir <path>           the checkout (default: here)
  --lanes <list>         comma-separated lanes to install, e.g. review,implement
                         (default: review)
  --yes                  take every default without asking
  --dry-run              read everything, change nothing, print what it would do
  --no-apps              don't run \`kanon apps\`; print the command instead
  -h, --help             this text

Needs \`gh\`. Reading needs a token that can read the repository; creating labels and
milestones needs Issues: write; the merge setting and the ruleset need Administration: write.
gh takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored login; the command prints
which one it uses and whose it is.`;

/**
 * @typedef {{
 *   gh: (args: string[], input?: string) => Promise<GhResult>,
 *   git: (args: string[]) => GhResult,
 *   env: Record<string, string | undefined>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   readFile: (path: string) => string | null,
 *   writeFile: (path: string, text: string) => void,
 *   ask: (question: string, fallback: string) => Promise<string>,
 *   apps: (argv: string[]) => Promise<number>,
 *   milestones: (argv: string[]) => Promise<number>,
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
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  ask: async (question, fallback) => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`${question} [${fallback}] `)).trim();
    return a || fallback;
  },
  apps: (argv) => runApps(argv),
  milestones: (argv) => runMilestones(argv),
  today: () => new Date().toISOString().slice(0, 10),
  requirements: loadRequirements,
  release: kanonRelease,
};

/**
 * Parses `kanon init`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv @param {Requirements} req
 */
export const parseArgs = (argv, req) => {
  /** @type {{ repo: string, dir: string, lanes: string[] | null, yes: boolean, dryRun: boolean, apps: boolean, help: boolean }} */
  const opts = { repo: '', dir: process.cwd(), lanes: null, yes: false, dryRun: false, apps: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--lanes') opts.lanes = parseLanes(value(), req);
    else if (flag === '--yes') opts.yes = true;
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--no-apps') opts.apps = false;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo takes <owner>/<repo>, not "${opts.repo}"`);
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
 * `kanon apps`'s flag for these identities: `--roles` while the lanes run one App per role,
 * `--apps` once they run the Apps of ADR 0013 (plan 0005 step L4).
 * @param {string[]} identities @param {Requirements} req
 */
export const appsArgs = (identities, req) => {
  if (identities.every((i) => req.identities.roles[i])) return ['--roles', identities.join(',')];
  if (identities.every((i) => req.identities.apps[i])) return ['--apps', identities.join(',')];
  throw new Error(`the lanes mix roles and Apps (${identities.join(', ')}); this release's lanes disagree with each other`);
};

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

  // The rulesets that cover the default branch, read whole: the list carries no rules.
  /** @type {any[]} */
  const covering = [];
  for (const s of rulesetList.filter((x) => x?.target === 'branch')) {
    const full = await ghJson(deps, ['api', `repos/${repo}/rulesets/${s.id}`]);
    if (!full.ok) continue;
    const include = full.json?.conditions?.ref_name?.include ?? [];
    if (include.some((/** @type {string} */ p) => p === '~DEFAULT_BRANCH' || p === '~ALL' || p === `refs/heads/${defaultBranch}`)) covering.push(full.json);
  }

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

/**
 * The default branch's ruleset (K-ADOPT-1 step 8): a pull request with no required approval yet
 * (bootstrap, K-ADOPT-6), squash only, no force-push or deletion, `lane-check` required, and the
 * merge queue where the plan has one.
 * @param {boolean} mergeQueue
 */
export const rulesetBody = (mergeQueue) => ({
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
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: LANE_CHECK }] } },
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
  if (!checks.includes(LANE_CHECK)) gaps.push(`require the status check "${LANE_CHECK}"`);
  return gaps;
};

/**
 * The answers, asked one by one with a default each, or all defaults with `--yes`.
 * @param {Deps} deps @param {{ yes: boolean, lanes: string[] | null }} opts @param {{ login: string, gates: string[], gitName: string, gitEmail: string, req: Requirements, defaultLanes: string[] }} ctx
 */
export const askAll = async (deps, opts, ctx) => {
  const ask = (/** @type {string} */ q, /** @type {string} */ d) => (opts.yes ? Promise.resolve(d) : deps.ask(q, d));
  const yesNo = async (/** @type {string} */ q, /** @type {boolean} */ d) => /^y/i.test(await ask(`${q} (y/n)`, d ? 'y' : 'n'));
  const owner = await ask('Who is the Owner (K-ADOPT-1 step 2)?', ctx.login);
  const maintainer = await ask('Who is the Maintainer?', owner);
  const stakeholder = await ask('Who is the Stakeholder?', owner);
  const lanes = opts.lanes ?? parseLanes(await ask(`Which lanes to install? (${Object.keys(ctx.req.lanes).map((l) => l.slice(6)).join(', ')})`, ctx.defaultLanes.map((l) => l.slice(6)).join(',')), ctx.req);
  const gatesAnswer = await ask("The stack's gates, the commands a change must pass, comma-separated", ctx.gates.join(', ') || 'none yet');
  const gates = /^none( yet)?$/i.test(gatesAnswer.trim()) ? [] : gatesAnswer.split(',').map((g) => g.trim()).filter(Boolean);
  const database = /^hook$/i.test(await ask('Does a lane need a test database your project-setup hook starts? (none/hook)', 'none')) ? 'hook' : 'none';
  const delegate = await yesNo("Record a sign-off delegation, so agents' commits pass a required dco check (K-AGENT-44)?", false);
  let delegation = null;
  if (delegate) {
    delegation = { name: await ask('The delegate, as their sign-off writes their name', ctx.gitName), email: await ask("The delegate's email", ctx.gitEmail) };
  }
  const deleteDefaults = await yesNo("Delete GitHub's default labels that aren't in Kanon's taxonomy?", false);
  return { owner, maintainer, stakeholder, lanes, gates, database, delegation, deleteDefaults };
};

/** @typedef {Awaited<ReturnType<typeof askAll>>} Answers */

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
      ? '- **Rulesets:** not on this plan, and there is no fallback. The repository stays in bootstrap and can\'t leave it: every lane runs, and the Merger merges only what the Judge approved, but nothing on the platform refuses a merge without an approval (`K-ADOPT-3`, `K-ADOPT-6`).'
      : `- **Rulesets:** ${s.rulesets === 'yes' ? 'available' : 'not known; check the repository\'s settings'}.`,
  );
  lines.push(
    s.mergeQueue === 'yes'
      ? '- **Merge queue:** available.'
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

/**
 * Every file `init` would write, by path relative to the checkout. A file it leaves to its
 * default is not here.
 * @param {{ s: Inspection, a: Answers, req: Requirements, release: string, repo: string, today: string, read: (rel: string) => string | null }} c
 * @returns {Map<string, string>}
 */
export const plannedFiles = ({ s, a, req, release, repo, today, read }) => {
  /** @type {Map<string, string>} */
  const files = new Map();
  files.set('docs/qa/adoption.md', adoptionFile(s, a, repo, today));
  files.set('docs/qa/stack.md', stackFile(a.gates));
  if (a.delegation) files.set('docs/qa/sign-off-delegation.md', delegationFile(a.delegation, today));
  if (a.database === 'hook') files.set('docs/qa/test-database.md', TEST_DATABASE_HOOK);
  files.set(req.hook.path, hookFile(req.hook.inputs));

  const ci = read('.github/workflows/ci.yml');
  const ciName = ci ? (/^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(ci)?.[1] ?? 'CI') : 'CI';
  for (const lane of a.lanes) {
    files.set(`.github/workflows/${lane}.yml`, callerFile(lane, /** @type {import('./callers.mjs').Lane} */ (req.lanes[lane]), { release, ciName, defaultBranch: s.defaultBranch }));
  }
  const identities = identitiesOf(a.lanes, req);
  if (identities.length) files.set('.github/workflows/apps-check.yml', appsCheckFile(identities, release));
  if (!ci) files.set('.github/workflows/ci.yml', ciFile(release, s.defaultBranch));
  else if (!/yedeya-labs\/kanon\/actions\/lane-check@/.test(ci)) files.set('.github/workflows/lane-check.yml', laneCheckFile(release));
  if (!read('.github/dependabot.yml')) files.set('.github/dependabot.yml', dependabotFile());
  return files;
};

/**
 * `kanon init`. Returns the exit code: 0 when it ran (manual steps may remain, and are printed),
 * 1 when something failed, 2 on a usage error.
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const init = async (argv, overrides = {}) => {
  const deps = { ...realDeps, ...overrides };
  const { out, err } = deps;
  const req = deps.requirements();
  /** @type {ReturnType<typeof parseArgs>} */
  let opts;
  try {
    opts = parseArgs(argv, req);
  } catch (e) {
    err(`kanon init: ${/** @type {Error} */ (e).message}`);
    err(USAGE);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (!opts.yes && deps.ask === realDeps.ask && !process.stdin.isTTY) {
    err('kanon init: standard input is not a terminal, so it can\'t ask; pass --yes to take every default. Nothing was changed.');
    return 2;
  }
  try {
    return await run(deps, opts, req);
  } finally {
    rl?.close();
    rl = null;
  }
};

/**
 * @param {Deps} deps @param {ReturnType<typeof parseArgs>} opts @param {Requirements} req
 */
const run = async (deps, opts, req) => {
  const { out, err } = deps;
  const dry = opts.dryRun;
  const release = deps.release();

  // The checkout, and the repository it is of.
  const top = deps.git(['-C', resolve(opts.dir), 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    err(`kanon init: ${resolve(opts.dir)} is not a git checkout. Run it from your repository's checkout, or pass --dir. Nothing was changed.`);
    return 1;
  }
  let repo = opts.repo;
  if (!repo) {
    const origin = deps.git(['-C', top.stdout.trim(), 'remote', 'get-url', 'origin']);
    repo = (origin.status === 0 && remoteRepo(origin.stdout)) || '';
    if (!repo) {
      err(`kanon init: ${top.stdout.trim()} has no origin remote on GitHub; pass --repo <owner>/<repo>. Nothing was changed.`);
      return 1;
    }
  }
  const [ownerName = '', repoName = ''] = repo.split('/');
  // checkoutCheck reads git only.
  const where = checkoutCheck(/** @type {import('./apps.mjs').Deps} */ (/** @type {unknown} */ ({ git: deps.git })), opts.dir, ownerName, repoName);
  if (where.refusal) {
    for (const l of where.refusal) err(`kanon init: ${l.replace('--register <path> to write the register somewhere else on purpose', '--repo <owner>/<repo> for the checkout\'s own repository')}`);
    return 1;
  }
  const root = where.root;
  const read = (/** @type {string} */ rel) => deps.readFile(join(root, rel));

  const who = await whoami(deps.gh, deps.env);
  out(who.line);
  if (who.refusal) {
    for (const l of who.refusal) err(`kanon init: ${l}`);
    return 1;
  }

  // 1. Inspect.
  /** @type {Inspection} */
  let s;
  try {
    s = await inspect(deps, repo);
  } catch (e) {
    err(`kanon init: ${/** @type {Error} */ (e).message}. Nothing was changed.`);
    return 1;
  }
  out('');
  out(`== ${repo}, at Kanon ${release}${dry ? ' (dry run: nothing will change)' : ''} ==`);
  out(`- ${s.kind === 'User' ? 'A personal account' : 'An organisation'}'s ${s.isPrivate ? 'private' : 'public'} repository; default branch ${s.defaultBranch}${s.hasCommits ? '' : ', with no commit yet'}.`);
  out(`- Rulesets: ${s.rulesets}. Merge queue: ${s.mergeQueue}. Environments: not needed by any lane.`);
  out(`- Your token ${s.admin ? 'can' : "can't"} administer the repository.`);
  out(`- ${s.labels.size} label(s); ${s.covering.length} ruleset(s) on the default branch; secrets ${s.secrets ? `readable (${s.secrets.size})` : 'not readable with this token'}.`);

  // 2. Ask.
  /** @type {string[]} */
  const installed = Object.keys(req.lanes).filter((l) => read(`.github/workflows/${l}.yml`) !== null);
  const gitName = deps.git(['-C', root, 'config', 'user.name']).stdout.trim();
  const gitEmail = deps.git(['-C', root, 'config', 'user.email']).stdout.trim();
  out('');
  const a = await askAll(deps, opts, { login: who.login ?? ownerName, gates: suggestGates(read), gitName, gitEmail, req, defaultLanes: installed.length ? installed : DEFAULT_LANES });

  /** @type {string[]} what changed (or, in a dry run, would) */
  const changed = [];
  /** @type {string[][]} the steps left to a person, each a few lines */
  const manual = [];
  let failures = 0;
  const verb = dry ? 'Would create' : 'Created';

  // 3. Write the files.
  out('');
  out('== Files ==');
  const files = plannedFiles({ s, a, req, release, repo, today: deps.today(), read });
  let wrote = false;
  for (const [rel, text] of files) {
    const have = read(rel);
    if (have === text) {
      out(`${rel}: already as init writes it.`);
      continue;
    }
    if (have !== null) {
      out(`${rel}: exists and differs from what init would write; left unchanged. The difference:`);
      for (const l of lineDiff(have, text)) if (!l.startsWith('  ')) out(`    ${l}`);
      continue;
    }
    if (!dry) deps.writeFile(join(root, rel), text);
    wrote = true;
    changed.push(`${verb} ${rel}`);
    out(`${dry ? 'would write' : 'wrote'} ${rel}:`);
    for (const l of text.replace(/\n$/, '').split('\n')) out(`    + ${l}`);
  }
  const dep = read('.github/dependabot.yml');
  if (dep && !/yedeya-labs\/kanon\*/.test(dep)) manual.push(['Add the entry that proposes Kanon upgrades (K-ADOPT-11) under `updates:` in .github/dependabot.yml:', ...DEPENDABOT_ENTRY]);

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
      changed.push(`Would create the label ${l.name}`);
      continue;
    }
    const r = await deps.gh(cmd);
    if (r.status === 0) changed.push(`Created the label ${l.name}`);
    else labelSteps.push(`gh ${cmd.map((c) => (/^[\w:./-]+$/.test(c) ? c : JSON.stringify(c))).join(' ')}`);
  }
  out(missingLabels.length ? `${dry ? 'Would create' : 'Created'} ${missingLabels.length - labelSteps.length} of the ${missingLabels.length} missing taxonomy label(s).` : `All ${taxonomy.length} taxonomy labels exist.`);
  if (labelSteps.length) manual.push(['Create the labels the token could not (it needs Issues: write):', ...labelSteps]);
  const extra = GITHUB_DEFAULT_LABELS.filter((n) => s.labels.has(n) && !taxonomy.some((l) => l.name === n));
  if (extra.length) {
    if (a.deleteDefaults && !dry) {
      for (const n of extra) {
        const r = await deps.gh(['label', 'delete', n, '--yes', '-R', repo]);
        if (r.status === 0) changed.push(`Deleted GitHub's default label ${n}`);
        else manual.push([`Delete GitHub's default label "${n}" (K-WORK-12): gh label delete ${JSON.stringify(n)} --yes -R ${repo}`]);
      }
    } else if (a.deleteDefaults) changed.push(...extra.map((n) => `Would delete GitHub's default label ${n}`));
    else out(`Kept GitHub's default labels outside the taxonomy, as asked: ${extra.join(', ')}.`);
  }
  const missingBuckets = BUCKETS.filter((b) => !s.milestones.has(b));
  if (!missingBuckets.length) out('Both bucket milestones exist.');
  else if (dry) changed.push(...missingBuckets.map((b) => `Would create the milestone ${b}`));
  else {
    const code = await deps.milestones(['--repo', repo]);
    if (code === 0) changed.push(...missingBuckets.map((b) => `Created the milestone ${b}`));
    else manual.push([`Create the bucket milestones (K-WORK-4): kanon milestones --repo ${repo}`]);
  }

  out('');
  out('== Merging ==');
  const settingDiff = Object.entries(MERGE_SETTINGS).filter(([k, v]) => /** @type {Record<string, unknown>} */ (s.settings)[k] !== v);
  const patch = ['api', '-X', 'PATCH', `repos/${repo}`, ...settingDiff.flatMap(([k, v]) => [typeof v === 'boolean' ? '-F' : '-f', `${k}=${v}`])];
  if (!settingDiff.length) out('Squash merge only, with the PR\'s title and body: already set (K-SHIP-3).');
  else if (dry) changed.push(`Would set ${settingDiff.map(([k, v]) => `${k}=${v}`).join(', ')} (K-SHIP-3)`);
  else {
    const r = s.admin ? await deps.gh(patch) : null;
    if (r?.status === 0) changed.push(`Set ${settingDiff.map(([k, v]) => `${k}=${v}`).join(', ')} (K-SHIP-3)`);
    else manual.push([`Make squash the only merge method, with the PR's title and body as the commit's (K-SHIP-3); it needs Administration: write:`, `gh ${patch.join(' ')}`]);
  }

  const body = rulesetBody(s.mergeQueue === 'yes');
  const rulesetCmd = [`gh api -X POST repos/${repo}/rulesets --input - <<'JSON'`, JSON.stringify(body), 'JSON'];
  if (s.rulesets === 'no') {
    out('');
    out(`THE PLATFORM DOES NOT ENFORCE REVIEW ON ${repo}. A private repository on this plan has no rulesets, so it never leaves bootstrap: every lane runs, and the Merger merges only what the Reviewer approved, but a person can merge past the Reviewer and nothing on GitHub refuses it (K-ADOPT-3, K-ADOPT-6). Making the repository public, or a plan with rulesets, changes that. The adoption record says so.`);
  } else if (s.covering.length) {
    const gaps = rulesetGaps(s.covering);
    if (!gaps.length) out(`The default branch's ruleset has every rule of K-ADOPT-1 step 8.`);
    else manual.push([`The ruleset on ${s.defaultBranch} (${s.covering.map((c) => c.name).join(', ')}) lacks some of K-ADOPT-1 step 8. In the repository's Settings, Rules, Rulesets:`, ...gaps.map((g) => `  - ${g}`)]);
  } else if (!s.hasCommits) {
    manual.push([`Push the first commit straight to ${s.defaultBranch} (K-ADOPT-4), then run kanon init again: it creates the ruleset, which then requires a pull request.`]);
  } else if (dry) changed.push(`Would create the ruleset "${RULESET_NAME}" on ${s.defaultBranch}, requiring "${LANE_CHECK}"`);
  else {
    const r = s.admin ? await deps.gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(body)) : null;
    if (r?.status === 0) changed.push(`Created the ruleset "${RULESET_NAME}" on ${s.defaultBranch}, requiring "${LANE_CHECK}"${s.mergeQueue === 'yes' ? ', with the merge queue' : ''}`);
    else manual.push([`Create the default branch's ruleset (K-ADOPT-1 step 8); it needs Administration: write:`, ...rulesetCmd]);
  }
  if (s.rulesets !== 'no' && s.mergeQueue !== 'yes') out('No merge queue on this plan: "require branches to be up to date" stays off (K-MERGE-7).');

  // 5. The Apps.
  out('');
  out('== Apps ==');
  const identities = identitiesOf(a.lanes, req);
  const rows = registerRows(read(REGISTER_PATH));
  /** @type {string[]} */
  let missing = [];
  try {
    missing = identities.filter((i) => registerRolesOf(i, req).some((r) => !rows.has(r)));
  } catch (e) {
    err(`kanon init: ${/** @type {Error} */ (e).message}`);
    failures++;
  }
  if (!identities.length) out('The chosen lanes run as no App.');
  else if (!missing.length) out(`The App register lists every App the lanes run as: ${identities.join(', ')}.`);
  else {
    const argvApps = ['--owner', s.owner, '--repo', repoName, ...appsArgs(missing, req), '--dir', root];
    const cmd = `kanon apps ${argvApps.join(' ')}`;
    if (dry) changed.push(`Would run: ${cmd}`);
    else if (!opts.apps || !/^y/i.test(opts.yes ? 'y' : await deps.ask(`Create the Apps for ${missing.join(', ')} now? It opens your browser for each. (y/n)`, 'y'))) {
      manual.push([`Create the Apps the lanes run as, from this checkout, and commit the register rows it writes:`, cmd]);
    } else {
      out(`Running: ${cmd}`);
      const code = await deps.apps(argvApps);
      if (code === 0) changed.push(`Created the App(s) for ${missing.join(', ')} with kanon apps`);
      else {
        failures++;
        manual.push([`kanon apps did not finish (exit ${code}); fix what it said, then run it again:`, cmd]);
      }
    }
  }
  if (s.secrets) {
    for (const i of identities) {
      const lacks = appSecrets(i).filter((n) => !s.secrets?.has(n));
      if (lacks.length && !missing.includes(i)) {
        manual.push([`The register lists the ${i} App, but the repository lacks ${lacks.join(' and ')}. Generate a private key on the App's settings page, then:`, `gh secret set ${appSecrets(i)[1]} -R ${repo} < <downloaded>.pem && rm <downloaded>.pem`, `gh secret set ${appSecrets(i)[0]} -R ${repo} --body <the App's id>`]);
      }
    }
    const others = [...new Set(a.lanes.flatMap((l) => req.lanes[l]?.secrets ?? []))].filter((n) => !/_APP_(ID|PRIVATE_KEY)$/.test(n) && !s.secrets?.has(n));
    if (others.includes('CLAUDE_CODE_OAUTH_TOKEN')) manual.push(['Store the token of the Claude subscription the agents run on, made with `claude setup-token` (docs/lanes.md):', `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}   # paste it on standard input`]);
    if (others.includes('DIGEST_WEBHOOK')) manual.push(['Store the chat webhook the digests post to:', `gh secret set DIGEST_WEBHOOK -R ${repo}   # paste it on standard input`]);
  } else manual.push([`The token can't list ${repo}'s secret names, so init can't say which are missing. Each chosen lane maps: ${[...new Set(a.lanes.flatMap((l) => req.lanes[l]?.secrets ?? []))].join(', ')}.`]);

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
    out('init commits nothing: review the files, then commit them on a branch and open a pull request.');
  }
  return failures ? 1 : 0;
};
