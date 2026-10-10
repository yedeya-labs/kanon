// `kanon doctor` (plan 0005 §5.5, step L10): what an installation of Kanon lacks, read-only.
//
// It reads the repository the way `kanon init` does (cli/init.mjs's `inspect`, and the same
// register and ruleset readers) and compares it with the requirements file of a release
// (`requirements.json`, which every release ships at its tag): the release its callers pin, or,
// with `--to vX.Y.Z`, the release being moved to, so that run before Dependabot's pin bump merges
// it turns "the first red run" into a list. Each finding says what is missing or stale and the
// exact fix, and the list comes in the order to work through it: the pin (with the kanon plugin's,
// where the project declares it), then each App (its register rows and its permissions), the
// secrets, the declarations and hooks, the callers, the labels and the ruleset.
//
// It also lists every job of the repository's own workflows that holds `id-token: write`,
// counted as Kanon's id-token guard counts it (tests/unit/helpers/store-jobs.ts): its own grant,
// the workflow's when it declares none, `write-all` at either level, and a job that calls a
// reusable workflow with such a grant. The QA store's role and the telemetry writer trust the
// default branch's ref, so each of those jobs can assume them. A caller of one of Kanon's
// store-coupled lanes at the pinned release is listed as Kanon's and accepted; any other holder
// is accepted only by a bullet in the adoption record that names it and gives a reason
// (`K-LAYOUT-10`), or by narrowing its grant.
//
// ANY OTHER FINDING CAN BE WAIVED the same way, by the repository and not by doctor: a bullet
// under `## Choices` names one finding id, the one subject it applies to, and the reason
// (`WAIVER_LABEL`). A waived finding moves from `findings` to `waived`, so it no longer counts
// toward the exit code but stays in the document. Doctor knows no repository's special case:
// every finding and every repository is waived alike, except the ids `UNWAIVABLE` lists. A waiver
// that matches no finding is listed as stale, and one in another shape is malformed. A finding
// that lists items, which a later release can add to (`ITEMIZED`), is waived item by item: each
// bullet names the items it waives after `for`, with its own reason, several bullets may share
// one finding, and an item none names stays a finding. A bullet of such a finding that names no
// items is malformed, since it would hide what a later release adds (#406, the Owner, 2026-10-07).
//
// IT WRITES NOTHING: every GitHub call is a read, and no file is written. `kanon init` fixes
// what can be fixed from the checkout.
//
// TWO OUTPUTS, ONE RESULT. The default is prose for a person. `--json` prints one JSON document
// and nothing else on standard output, whose shape is a versioned contract (`SCHEMA`, and
// docs/doctor.md, following docs/cli-json.md's convention for every command): the skills that
// wrap `kanon init` and `kanon doctor` (ADR 0014, decision 1) and later integrators build on it,
// so a change to it is a breaking change. The exit code is the same in both modes:
//   0  healthy: every check ran and found nothing that blocks
//   1  findings: at least one blocking finding, an id-token holder neither accepted nor narrowed
//      included
//   2  usage error
//   3  could not run: no checkout, the repository or a requirements file could not be read, or
//      nothing pins Kanon
//   4  incomplete: nothing blocking was found, but at least one check could not run (the token
//      can't list the secrets, say), so health can't be claimed
//
// Node built-ins only: this runs from a Kanon checkout or through `npx`, with no install.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { URL } from 'node:url';
import { readResult, resultMasked } from './apps-check.mjs';
import { checkoutCheck, ownerInstallations as listInstallations, REGISTER_PATH, remoteRepo } from './apps.mjs';
import { appSecrets, kanonRelease, loadRequirements, TRIGGERS } from './callers.mjs';
import { whoami } from './gh-token.mjs';
import { appsArgs, inspect, LANE_CHECK, OWN_TERMINAL, registerRolesOf, registerRows, requiredCheckGap, rulesetGaps, RULESET_NAME, telemetryStep } from './init.mjs';
import { actorName, bypassCommand, releaserActor, releaserBypass, rulesetUrl } from './ruleset-bypass.mjs';
import { readPluginDeclaration, SETTINGS_PATH } from './plugin.mjs';
import { parseYaml } from './workflow-yaml.mjs';
import { branchWorkflows, checkJobs, checkReporters, mergeQueueOn } from './check-reporters.mjs';
import { LABEL as UPSTREAM_LABEL, parseUpstreamFindings, unsentMessage } from '../scripts/lib/upstream-findings.mjs';
import { LEDGER as CAPABILITY_LEDGER, parseCapabilityWatch } from '../scripts/lib/capability-watch.mjs';

// The reporter check lives in its own module, which `kanon init` shares (#444).
export { branchPattern, branchWorkflows, checkJobs, checkReporters } from './check-reporters.mjs';

/** @typedef {import('./callers.mjs').Requirements} Requirements */
/** @typedef {import('./init.mjs').Inspection} Inspection */
/** @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult */

/** The JSON output's contract (docs/doctor.md). A breaking change to it changes this. */
export const SCHEMA = 'kanon-doctor/v1';

/** The exit codes, as docs/doctor.md documents them. */
export const EXIT = /** @type {const} */ ({ healthy: 0, findings: 1, usage: 2, error: 3, incomplete: 4 });

/** Where Kanon's releases are, whose tags carry each release's requirements file. */
export const KANON_REPO = 'yedeya-labs/kanon';

/** The adoption record (`K-LAYOUT-10`), where an id-token holder is accepted. */
export const ADOPTION_RECORD = 'docs/qa/adoption.md';

/** The bullet's bold label that accepts an id-token holder, under `## Choices`. */
export const HOLDER_LABEL = 'Accepted id-token holder';

/** The bullet's bold label that waives one finding, under `## Choices`. */
export const WAIVER_LABEL = 'Waived doctor finding';

/** The dispatch sweep's backlog feeder's valve, a repository variable (#609). */
export const BACKLOG_FEED = 'QA_BACKLOG_FEED';

/**
 * The note on the backlog feeder's valve (#609): informational in every state, since unset is
 * the feeder's default, off. Reads the value as `scripts/backlog-feed.mjs` does: a whole number,
 * and anything else closed.
 * @param {string[]} files the callers of a sweep that feeds
 * @param {Map<string, string> | null} vars the repository's variables, or null when unlisted
 * @param {string} repo
 */
export function backlogFeedNote(files, vars, repo) {
  const who = `${files.join(', ')} ${files.length > 1 ? 'run' : 'runs'} the dispatch sweep, whose backlog feeder`;
  const how = '(docs/lanes.md, "The backlog feeder")';
  if (!vars) return `${who} reads ${BACKLOG_FEED}, and the token can't list ${repo}'s variables, so doctor can't tell whether it feeds ${how}.`;
  const raw = (vars.get(BACKLOG_FEED) ?? '').trim();
  const milestones = (vars.get('QA_BACKLOG_MILESTONES') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (raw === '' || raw === '0') return `${who} is off: ${BACKLOG_FEED} is ${raw === '' ? 'unset' : '0'}. Set it to the number of reviewer follow-ups to label agent:implement a day ${how}: \`gh variable set ${BACKLOG_FEED} -R ${repo} --body 1\`.`;
  if (!/^\d+$/.test(raw)) return `${who} is off: ${BACKLOG_FEED} is \`${raw}\`, which is not a whole number, so the feeder reads it as 0 ${how}.`;
  return `${who} labels up to ${raw} reviewer follow-up${raw === '1' ? '' : 's'} a day agent:implement, from ${milestones.length ? milestones.join(', ') : 'Product Backlog'}, into implementer slots nothing else is using ${how}.`;
}

/**
 * The finding ids no waiver waives, each with why (docs/doctor.md, "Waiving a finding"). A
 * waiver of one is malformed. The record's own findings can't be waived, or a waiver could hide
 * a broken or stale waiver; an id-token holder has its own form of waiver, the acceptance above;
 * and the rest protect a rule that keeps review independent or keeps secrets in their place.
 * @type {Record<string, string>}
 */
export const UNWAIVABLE = {
  'declaration.malformed': 'it is about the adoption record itself, so a waiver could hide a malformed waiver',
  'waiver.stale': 'it is about the adoption record itself, so a waiver could keep a stale waiver alive',
  'id-token.stale-acceptance': 'it is about the adoption record itself; remove the stale acceptance instead',
  'id-token.unaccepted': `a job is accepted as an id-token holder by its own bullet, \`- **${HOLDER_LABEL}:** \`<workflow>.yml\` job \`<job>\` (<why>)\``,
  'register.shared-slug': 'one App authoring and approving its own work defeats independent review (K-LAYOUT-6)',
  'caller.secrets-inherited': 'it hands the lane every secret of the repository (plan 0001 decision 7)',
  'ruleset.missing': 'without it nothing enforces review on the default branch (K-ADOPT-1 step 8)',
  'ruleset.rule-missing': 'without it nothing enforces that rule of review on the default branch (K-ADOPT-1 step 8)',
  'ruleset.bypass-extra': 'it lets an actor other than the Releaser merge around review (K-MERGE-8)',
  'upstream.unsent': 'it is about the adoption record itself, which says findings are sent when nothing sends them, and lane-check fails it whatever a waiver says',
};

/**
 * The finding ids whose findings list items, each with what an item is (#406). A later release
 * can add an item to such a finding, a permission an App needs or a secret a lane takes, so a
 * waiver of one names the items it waives after `for`, and doctor still reports any other. Several
 * bullets may waive items of one finding, each with its reason, but no item twice. A waiver of one
 * that names no items is malformed (the Owner, 2026-10-07), its fix the bullet built from the
 * items doctor reports today.
 * @type {Record<string, string>}
 */
export const ITEMIZED = {
  'register.missing-row': 'a role whose row is missing',
  'register.split-slug': 'an App whose roles name more than one slug',
  'app.permission-missing': 'a permission',
  'app.permission-extra': 'a permission',
  'secret.missing': 'a secret',
  'secret.stale': 'a secret',
  'declaration.section-missing': 'a heading',
  'hook.input-missing': 'an input',
  'caller.secret-missing': 'a secret',
  'caller.secret-stale': 'a secret',
  'caller.input-stale': 'an input',
  'caller.grant-missing': 'a permission',
  'apps-check.secret-missing': 'a secret',
  'apps-check.secret-stale': 'a secret',
  'label.missing': 'a label',
  'telemetry.unconfigured': 'a variable',
  'qa-store.unmapped': 'a secret',
  'qa-store.variables': 'a variable',
};

/**
 * The categories of the findings a check that could not run would have reported, by the
 * `unchecked[].check` it is listed under: a waiver of such a finding can't be called stale.
 * @type {Record<string, string>}
 */
const UNCHECKED_CATEGORY = { 'app-permissions': 'app', 'unused-apps': 'app', secrets: 'secret', hook: 'declaration', ruleset: 'ruleset', 'ruleset-bypass': 'ruleset', 'required-check': 'ruleset' };

/**
 * The finding categories, in the order a finding is listed and fixed: the pin decides which
 * release's requirements apply; an App's rows and permissions come before the secrets that name
 * it; the files a lane reads before the callers that call it; the platform's own state last.
 */
export const CATEGORIES = ['pin', 'app', 'secret', 'declaration', 'caller', 'label', 'ruleset', 'id-token'];

/**
 * Every finding `doctor` can report, by its stable id: its category, and whether it blocks (sets
 * exit code 1). docs/doctor.md lists the same ids; tests/unit/kanon-doctor.test.ts holds the two
 * to each other.
 * @type {Record<string, { category: string, blocking: boolean }>}
 */
export const FINDINGS = {
  'pin.mixed': { category: 'pin', blocking: true },
  'plugin.version-mismatch': { category: 'pin', blocking: false },
  'register.missing-row': { category: 'app', blocking: true },
  'register.split-slug': { category: 'app', blocking: true },
  'register.shared-slug': { category: 'app', blocking: true },
  'app.permission-missing': { category: 'app', blocking: true },
  'app.permission-extra': { category: 'app', blocking: false },
  'app.unused': { category: 'app', blocking: false },
  'secret.missing': { category: 'secret', blocking: true },
  'secret.stale': { category: 'secret', blocking: false },
  'declaration.missing': { category: 'declaration', blocking: true },
  'declaration.section-missing': { category: 'declaration', blocking: true },
  'declaration.malformed': { category: 'declaration', blocking: true },
  'upstream.unsent': { category: 'declaration', blocking: true },
  'hook.missing': { category: 'declaration', blocking: true },
  'hook.input-missing': { category: 'declaration', blocking: true },
  'workflow.missing': { category: 'declaration', blocking: true },
  'waiver.stale': { category: 'declaration', blocking: false },
  'caller.lane-removed': { category: 'caller', blocking: true },
  'caller.misplaced': { category: 'caller', blocking: true },
  'caller.secrets-inherited': { category: 'caller', blocking: true },
  'caller.secret-missing': { category: 'caller', blocking: true },
  'caller.secret-stale': { category: 'caller', blocking: true },
  'caller.input-stale': { category: 'caller', blocking: true },
  'caller.grant-missing': { category: 'caller', blocking: true },
  'caller.name': { category: 'caller', blocking: true },
  'caller.run-name': { category: 'caller', blocking: true },
  'apps-check.secret-missing': { category: 'caller', blocking: true },
  'apps-check.secret-stale': { category: 'caller', blocking: true },
  'telemetry.unconfigured': { category: 'caller', blocking: false },
  'qa-store.unmapped': { category: 'caller', blocking: false },
  'qa-store.variables': { category: 'secret', blocking: false },
  'label.missing': { category: 'label', blocking: false },
  'ruleset.missing': { category: 'ruleset', blocking: true },
  'ruleset.rule-missing': { category: 'ruleset', blocking: true },
  'ruleset.check-unreported': { category: 'ruleset', blocking: true },
  'ruleset.releaser-bypass-missing': { category: 'ruleset', blocking: true },
  'ruleset.bypass-extra': { category: 'ruleset', blocking: true },
  'id-token.unaccepted': { category: 'id-token', blocking: true },
  'id-token.stale-acceptance': { category: 'id-token', blocking: false },
};

export const USAGE = `Usage: kanon doctor [options]

Compares the Kanon installation in the repository whose checkout you run it from with the
requirements of a release: the one its callers pin, or, with --to, the one you are moving to.
Lists what is missing or stale, each with its exact fix, in the order to fix them, and every
job of your own workflows that holds id-token: write. Writes nothing.

Options:
  --to <vX.Y.Z>          check against this release's requirements instead of the pinned one's
                         (run it before you merge the pin bump)
  --json                 print one JSON document (docs/doctor.md) instead of prose
  --repo <owner>/<repo>  the repository (default: the checkout's origin remote)
  --dir <path>           the checkout (default: here)
  -h, --help             this text

Exit codes: 0 healthy; 1 findings; 2 usage error; 3 could not run; 4 nothing blocking found,
but some check could not run (docs/doctor.md).

Needs \`gh\` and a token that can read the repository; listing its secrets' names needs
admin access to it. gh takes its token from GH_TOKEN, then GITHUB_TOKEN, then its stored
login; the command says which one it used and whose it is.`;

/**
 * @typedef {{
 *   gh: (args: string[], input?: string) => Promise<GhResult>,
 *   git: (args: string[]) => GhResult,
 *   env: Record<string, string | undefined>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   readFile: (path: string) => string | null,
 *   listFiles: (dir: string) => string[],
 *   requirements: () => Requirements,
 *   release: () => string,
 *   labels: () => Array<{ name: string, color: string, description: string }>,
 * }} Deps
 */

/** Every file under `dir`, by path relative to it; none when it doesn't exist. @param {string} dir */
const listFiles = (dir) => {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
};

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
  readFile: (path) => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null),
  listFiles,
  requirements: loadRequirements,
  release: kanonRelease,
  labels: () => JSON.parse(readFileSync(new URL('../rulebook/labels.json', import.meta.url), 'utf8')).labels,
};

/**
 * Parses `kanon doctor`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv
 */
export const parseArgs = (argv) => {
  /** @type {{ repo: string, dir: string, to: string | null, json: boolean, help: boolean }} */
  const opts = { repo: '', dir: process.cwd(), to: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      // The next argument is a flag, not this one's value: an unset, unquoted variable leaves
      // `--dir --json`, which would read "--json" as the checkout and print prose (#457). A
      // value that does begin with "-" is given inline, `--dir=-x`.
      if (inline === undefined && v.startsWith('-')) throw new Error(`${flag} needs a value, not the flag "${v}"; to give a value that begins with "-", write ${flag}=<value>`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--to') opts.to = value();
    else if (flag === '--json') opts.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  // `--help` prints the usage, which is no document: with `--json` it would leave prose on
  // standard output, so the pair is refused, and the refusal is the error document (#457).
  if (opts.help && opts.json) throw new Error('--help and --json contradict each other; give one');
  if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo takes <owner>/<repo>, not "${opts.repo}"`);
  if (opts.to && !/^v\d+\.\d+\.\d+$/.test(opts.to)) throw new Error(`--to takes an exact release, vX.Y.Z, not "${opts.to}"`);
  return opts;
};

// ── Small readers ─────────────────────────────────────────────────────────────────────────

/** @param {unknown} v */
const level = (v) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A semantic version's parts, for ordering. @param {string} v */
const semver = (v) => (/^v(\d+)\.(\d+)\.(\d+)$/.exec(v) ?? []).slice(1).map(Number);

/** @param {string} a @param {string} b */
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The line numbers (0-based) inside fenced code blocks. @param {string[]} lines */
const fenced = (lines) => {
  /** @type {Set<number>} */
  const set = new Set();
  let open = false;
  lines.forEach((l, i) => {
    if (/^[ \t]*(```|~~~)/.test(l)) {
      set.add(i);
      open = !open;
    } else if (open) set.add(i);
  });
  return set;
};

/**
 * Every Kanon release a file under `.github/` pins, outside comments, as `lane-check` reads them.
 * @param {Map<string, string>} texts by path
 * @returns {Map<string, string[]>} release → the files that pin it
 */
export const kanonPins = (texts) => {
  /** @type {Map<string, string[]>} */
  const pins = new Map();
  for (const [path, text] of texts) {
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      for (const m of line.matchAll(/yedeya-labs\/kanon\/[^@\s]+@([^\s"']+)/g)) {
        const ref = /** @type {string} */ (m[1]);
        const files = pins.get(ref) ?? [];
        if (!files.includes(path)) files.push(path);
        pins.set(ref, files);
      }
    }
  }
  return pins;
};

/**
 * The accepted id-token holders the adoption record declares under `## Choices`, one bullet
 * each: `- **Accepted id-token holder:** \`deploy.yml\` job \`deploy\` (why it holds it)`. A
 * bullet in another shape, outside `## Choices`, with no reason, or naming a holder twice, is
 * returned as an error naming its line.
 * @param {string | null} text
 * @returns {{ accepted: Map<string, string>, errors: string[] }} accepted: `<file>#<job>` → reason
 */
export const readHolderAcceptances = (text) => {
  /** @type {Map<string, string>} */
  const accepted = new Map();
  /** @type {string[]} */
  const errors = [];
  if (!text) return { accepted, errors };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${HOLDER_LABEL}:\\*\\*`, 'i');
  const entry = new RegExp(`^[-*] \\*\\*${HOLDER_LABEL}:\\*\\* \`([^\`\\s/]+\\.ya?ml)\` job \`([^\`\\s]+)\` \\((.*\\S.*)\\)\\s*$`);
  let section = '';
  lines.forEach((line, i) => {
    if (inFence.has(i)) return;
    if (/^#{1,6} /.test(line)) section = line.trimEnd();
    if (!mention.test(line)) return;
    const m = entry.exec(line);
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    if (!m) errors.push(`${where} is not \`- **${HOLDER_LABEL}:** \`<workflow>.yml\` job \`<job>\` (<why it holds the grant>)\``);
    else if (section !== '## Choices') errors.push(`${where} accepts an id-token holder outside \`## Choices\``);
    else {
      const key = `${m[1]}#${m[2]}`;
      if (accepted.has(key)) errors.push(`${where} accepts ${m[1]}'s job ${m[2]} a second time`);
      else accepted.set(key, /** @type {string} */ (m[3]).trim());
    }
  });
  return { accepted, errors };
};

/**
 * The waivers the adoption record declares under `## Choices`, one bullet each:
 * `- **Waived doctor finding:** \`caller.misplaced\` on \`.github/workflows/review.yml\` (why)`.
 * Each names one finding id, one subject exactly as doctor reports it, and the reason; for a
 * finding that lists items (`ITEMIZED`), it may name the items it waives, each a code span after
 * `for`, separated by commas (`items`, null when it names none). A bullet in another shape,
 * outside `## Choices`, with no reason, naming an id doctor doesn't report or one it doesn't
 * waive (`UNWAIVABLE`), naming items of a finding that lists none, waiving a finding that lists
 * none twice, or naming an item another bullet of the same finding names, is returned as an error
 * naming its line. A bullet of an `ITEMIZED` finding that names no items is returned as read:
 * `diagnose` reports it malformed, with the bullet to write from the items it finds.
 * @param {string | null} text
 * @returns {{ waivers: Array<{ id: string, subject: string, items: string[] | null, reason: string, line: number }>, errors: string[] }}
 */
export const readWaivers = (text) => {
  /** @type {Array<{ id: string, subject: string, items: string[] | null, reason: string, line: number }>} */
  const waivers = [];
  /** @type {string[]} */
  const errors = [];
  if (!text) return { waivers, errors };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${WAIVER_LABEL}:\\*\\*`, 'i');
  const entry = new RegExp(`^[-*] \\*\\*${WAIVER_LABEL}:\\*\\* \`([^\`\\s]+)\` on \`([^\`]*\\S[^\`]*)\`(?: for (\`[^\`]*\\S[^\`]*\`(?:, \`[^\`]*\\S[^\`]*\`)*))? \\((.*\\S.*)\\)\\s*$`);
  let section = '';
  lines.forEach((line, i) => {
    if (inFence.has(i)) return;
    if (/^#{1,6} /.test(line)) section = line.trimEnd();
    if (!mention.test(line)) return;
    const m = entry.exec(line);
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    if (!m) return errors.push(`${where} is not \`- **${WAIVER_LABEL}:** \`<finding id>\` on \`<subject>\` (<why the finding stands>)\`, with \`for \`<item>\`, \`<item>\`\` before the parentheses for a finding that lists items`);
    if (section !== '## Choices') return errors.push(`${where} waives a finding outside \`## Choices\``);
    const [id, subject, reason] = [/** @type {string} */ (m[1]), /** @type {string} */ (m[2]), /** @type {string} */ (m[4]).trim()];
    const items = m[3] === undefined ? null : [...new Set([...m[3].matchAll(/`([^`]+)`/g)].map((x) => /** @type {string} */ (x[1])))];
    if (!FINDINGS[id]) return errors.push(`${where} waives \`${id}\`, which is no finding doctor reports`);
    if (UNWAIVABLE[id]) return errors.push(`${where} waives \`${id}\`, which can't be waived: ${UNWAIVABLE[id]}`);
    if (items && !ITEMIZED[id]) return errors.push(`${where} names items after \`for\`, but \`${id}\` lists none: waive it on its subject alone`);
    const same = waivers.filter((w) => w.id === id && w.subject === subject);
    if (!ITEMIZED[id] && same.length) return errors.push(`${where} waives \`${id}\` on \`${subject}\` a second time`);
    for (const w of same) {
      const twice = items && w.items ? items.filter((x) => w.items?.includes(x)) : [];
      if (twice.length) return errors.push(`${where} waives ${twice.map((x) => `\`${x}\``).join(', ')} of \`${id}\` on \`${subject}\`, which ${ADOPTION_RECORD}:${w.line} waives already`);
    }
    waivers.push({ id, subject, items, reason, line: i + 1 });
  });
  return { waivers, errors };
};

/** @param {unknown} p a `permissions:` value */
const grantsIdToken = (p) => p === 'write-all' || (isMap(p) && 'id-token' in p && p['id-token'] !== 'none');

/**
 * Whether a job holds `id-token: write`, as Kanon's id-token guard counts it: from its own
 * `permissions:`, or from the workflow's when it declares none, either one a map that grants it or
 * `write-all`. A job that calls a reusable workflow holds what it grants as any job does.
 * @param {Record<string, any>} wf @param {Record<string, any>} job
 * @returns {{ from: 'job' | 'workflow', how: 'id-token' | 'write-all' } | null}
 */
export const idTokenGrant = (wf, job) => {
  const own = job.permissions;
  if (own !== undefined) return grantsIdToken(own) ? { from: 'job', how: own === 'write-all' ? 'write-all' : 'id-token' } : null;
  return grantsIdToken(wf.permissions) ? { from: 'workflow', how: wf.permissions === 'write-all' ? 'write-all' : 'id-token' } : null;
};

/** A call of one of Kanon's reusable workflows: its file name without `.yml`, and its ref. @param {unknown} uses */
export const kanonCall = (uses) => {
  const m = typeof uses === 'string' ? /^yedeya-labs\/kanon\/\.github\/workflows\/([A-Za-z0-9_.-]+)\.ya?ml@(\S+)$/.exec(uses.trim()) : null;
  return m ? { workflow: /** @type {string} */ (m[1]), ref: /** @type {string} */ (m[2]) } : null;
};

/**
 * The triggers a workflow runs on, read from its `on:` as a name, a list or a map. Null when `on:`
 * is none of those, which doctor can't read.
 * @param {Record<string, any>} wf
 * @returns {string[] | null}
 */
const triggers = (wf) => typeof wf.on === 'string' ? [wf.on] : Array.isArray(wf.on) ? wf.on.map(String) : isMap(wf.on) ? Object.keys(wf.on) : null;

/**
 * Whether a caller runs on a pull request closed on `branch` (`pull_request_target`, `closed`), the
 * trigger that starts a lane after a merge through a merge queue (kanon#484). `types` must name
 * `closed`, which GitHub's default types don't; a `branches` filter must match `branch` (by name,
 * and a glob is taken to match), and a `branches-ignore` must not name it.
 * @param {Record<string, any>} wf @param {string} branch
 */
export const startsOnMerge = (wf, branch) => {
  const on = wf.on;
  if (!isMap(on)) return false;
  const t = on.pull_request_target;
  if (!isMap(t)) return false;
  /** @param {unknown} v @returns {string[]} */
  const list = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : []);
  if (!list(t.types).includes('closed')) return false;
  if (t.branches !== undefined) return list(t.branches).some((b) => b === branch || /[*?[]/.test(b));
  return !list(t['branches-ignore']).includes(branch);
};

/**
 * Whether an expression reads the `secrets` context other than by a literal name: an index by an
 * expression (`secrets[format('{0}_APP_ID', x)]`), or the whole context (`toJSON(secrets)`,
 * `secrets.*`, `${{ secrets }}`). Such a read can reach any secret the workflow sees (#440).
 * @param {string} expr the text inside `${{ }}`, or an `if:`
 */
const computedRead = (expr) => /(?<![\w.])secrets(?![\w-])/.test(expr
  .replace(/(?<![\w.])secrets\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_-]*|\[\s*'[A-Za-z_][A-Za-z0-9_-]*'\s*\])/g, '')
  .replace(/'(?:[^']|'')*'/g, "''"));

/**
 * The expressions a string holds, each `${{ }}`'s text, read past a `}}` inside a quoted literal
 * (`format('{{"A":{0}}}', x)`).
 * @param {string} v
 */
const expressions = (v) => {
  /** @type {string[]} */
  const out = [];
  for (let at = v.indexOf('${{'); at !== -1; at = v.indexOf('${{', at)) {
    let i = at + 3;
    let quoted = false;
    for (; i < v.length; i++) {
      if (v[i] === "'") quoted = !quoted;
      else if (!quoted && v.startsWith('}}', i)) break;
    }
    out.push(v.slice(at + 3, i));
    at = i + 2;
  }
  return out;
};

/**
 * The secrets a workflow maps into its jobs: each name an expression reads as `secrets.<NAME>` or
 * `secrets['<NAME>']` anywhere outside its `on:` (where a reusable workflow declares the secrets
 * it takes, which reads none), upper-cased as GitHub stores them; the jobs that pass on every
 * secret with `secrets: inherit`; and whether it reads the repository's secrets by a computed name
 * or as a whole (`secrets[expr]`, `toJSON(secrets)`), which can reach any of them (#440). Only an
 * expression counts for that, `${{ }}` or an `if:`, never a script's own text, and only in a
 * workflow that runs on a trigger of its own: one that runs only on `workflow_call` sees just what
 * its caller passes, which the caller names or inherits. Whatever a job calls, a lane, the release
 * workflow by any path, or nothing, its secrets count (#414).
 * @param {Record<string, any>} wf
 */
export const secretReads = (wf) => {
  /** @type {Set<string>} */
  const names = new Set();
  let computed = false;
  /** @param {unknown} v @param {string} [key] */
  const walk = (v, key) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/(?<![\w.])secrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\])/g)) names.add(/** @type {string} */ (m[1] ?? m[2]).toUpperCase());
      const exprs = expressions(v);
      if (key === 'if' && !exprs.length) exprs.push(v);
      if (exprs.some(computedRead)) computed = true;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (isMap(v)) Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  for (const [k, v] of Object.entries(wf)) if (k !== 'on') walk(v, k);
  const inherits = Object.entries(isMap(wf.jobs) ? wf.jobs : {}).filter(([, j]) => isMap(j) && j.secrets === 'inherit').map(([n]) => n);
  const on = triggers(wf);
  return { names, inherits, computed: computed && (on === null || on.some((t) => t !== 'workflow_call')) };
};

/**
 * Whether a job's `uses` calls Kanon's release workflow, recognised by what it calls: Kanon's
 * pinned path, `$/` (Kanon's self-pinning form, plan 0001 §4) or a local path, never by the
 * repository doctor runs on (#441).
 * @param {unknown} uses
 */
export const releaseCall = (uses) => kanonCall(uses)?.workflow === 'release'
  || (typeof uses === 'string' && /^(?:\$|\.)\/\.github\/workflows\/release\.ya?ml$/.test(uses.trim()));

/**
 * The secrets a reusable workflow declares it takes from its caller (`on.workflow_call.secrets`),
 * upper-cased as `secretReads` reads them.
 * @param {Record<string, any>} wf
 * @returns {Set<string>}
 */
export const callTakes = (wf) => {
  const call = isMap(wf.on) && isMap(wf.on.workflow_call) ? wf.on.workflow_call : null;
  return new Set(Object.keys(call && isMap(call.secrets) ? call.secrets : {}).map((n) => n.toUpperCase()));
};

/** The headings a document holds exactly once outside a fence, and how often each appears. @param {string} text @param {string} heading */
const headingCount = (text, heading) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  return lines.filter((l, i) => !inFence.has(i) && l === heading).length;
};

// ── The requirements of a release ─────────────────────────────────────────────────────────

/**
 * A release's requirements file: this tree's own when it is that release, otherwise read from
 * Kanon's repository at the release's tag. Throws naming the release when there is none.
 * @param {Deps} deps @param {string} release
 * @returns {Promise<Requirements>}
 */
export const requirementsAt = async (deps, release) => {
  if (release === deps.release()) return deps.requirements();
  const r = await deps.gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${KANON_REPO}/contents/requirements.json?ref=${encodeURIComponent(release)}`]);
  if (r.status !== 0) {
    const why = r.stderr.trim() || `exit ${r.status}`;
    throw new Error(/HTTP 404|Not Found/i.test(why) ? `Kanon ${release} ships no requirements file (requirements.json); doctor can check against a release from v0.28.0 on, the first that ships one` : `could not read Kanon ${release}'s requirements file (${why})`);
  }
  try {
    const req = JSON.parse(r.stdout);
    if (!isMap(req) || !isMap(req.lanes) || !isMap(req.identities)) throw new Error('not a requirements file');
    return /** @type {Requirements} */ (req);
  } catch {
    throw new Error(`Kanon ${release}'s requirements.json is not a requirements file this doctor reads`);
  }
};

// ── The run ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, category: string, blocking: boolean, subject: string, message: string,
 *   fix: { text: string, commands: string[], url: string | null } }} Finding
 * @typedef {Finding & { items: string[], line: number, reason: string }} Waived
 * @typedef {{ text: string, commands?: string[], url?: string | null }} FixIn
 * @typedef {{ workflow: string, job: string, grant: 'job' | 'workflow', how: 'id-token' | 'write-all',
 *   calls: string | null, status: 'kanon-lane' | 'accepted' | 'unaccepted', reason: string | null }} Holder
 */

/**
 * `kanon doctor`. Returns the exit code (`EXIT`).
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const doctor = async (argv, overrides = {}) => {
  const deps = { ...realDeps, ...overrides };
  const wantsJson = argv.includes('--json');
  /** @type {ReturnType<typeof parseArgs>} */
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    const message = /** @type {Error} */ (e).message;
    if (wantsJson) deps.out(JSON.stringify(errorDocument(deps, EXIT.usage, message), null, 2));
    else {
      deps.err(`kanon doctor: ${message}`);
      deps.err(USAGE);
    }
    return EXIT.usage;
  }
  if (opts.help) {
    deps.out(USAGE);
    return EXIT.healthy;
  }
  // An error `diagnose` did not expect is the error document too, so `--json` always prints one
  // (#375). Doctor changes nothing, so there is nothing done to record.
  /** @type {Awaited<ReturnType<typeof diagnose>>} */
  let result;
  try {
    result = await diagnose(deps, opts);
  } catch (e) {
    result = { error: `stopped on an unexpected error: ${/** @type {Error} */ (e).message}` };
  }
  if (result.error !== undefined || !result.report) {
    const error = result.error ?? 'no report';
    if (opts.json) deps.out(JSON.stringify(errorDocument(deps, EXIT.error, error), null, 2));
    else deps.err(`kanon doctor: ${error}`);
    return EXIT.error;
  }
  if (opts.json) deps.out(JSON.stringify(result.report, null, 2));
  else for (const line of prose(result.report)) deps.out(line);
  return result.report.exitCode;
};

/** @param {Deps} deps @param {number} exitCode @param {string} error */
const errorDocument = (deps, exitCode, error) => ({ schema: SCHEMA, kanon: deps.release(), status: 'error', exitCode, error });

/**
 * Everything `doctor` finds, as the JSON document it prints, or the reason it could not run.
 * @param {Deps} deps @param {ReturnType<typeof parseArgs>} opts
 */
export const diagnose = async (deps, opts) => {
  // The checkout, and the repository it is of: as `kanon init` finds them.
  const top = deps.git(['-C', resolve(opts.dir), 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { error: `${resolve(opts.dir)} is not a git checkout. Run it from your repository's checkout, or pass --dir.` };
  let repo = opts.repo;
  if (!repo) {
    const origin = deps.git(['-C', top.stdout.trim(), 'remote', 'get-url', 'origin']);
    repo = (origin.status === 0 && remoteRepo(origin.stdout)) || '';
    if (!repo) return { error: `${top.stdout.trim()} has no origin remote on GitHub; pass --repo <owner>/<repo>.` };
  }
  const [ownerName = '', repoName = ''] = repo.split('/');
  const where = checkoutCheck(/** @type {import('./apps.mjs').Deps} */ (/** @type {unknown} */ ({ git: deps.git })), opts.dir, ownerName, repoName);
  if (where.refusal) return { error: `${where.refusal[0]} Run it from the checkout of ${repo}, or pass --repo for the checkout's own repository.` };
  const root = where.root;
  const read = (/** @type {string} */ rel) => deps.readFile(join(root, rel));
  const branch = deps.git(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const head = deps.git(['-C', root, 'rev-parse', 'HEAD']);

  const who = await whoami(deps.gh, deps.env);
  if (who.refusal) return { error: who.refusal.join(' ') };

  // The files under `.github/`, and the workflows parsed.
  const github = deps.listFiles(join(root, '.github')).map((f) => `.github/${f}`);
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const f of github.filter((x) => /\.ya?ml$/.test(x))) texts.set(f, read(f) ?? '');
  /** @type {Array<{ check: string, subject: string, reason: string }>} */
  const unchecked = [];
  /** @type {Map<string, Record<string, any>>} */
  const workflows = new Map();
  for (const f of github.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x))) {
    try {
      const doc = parseYaml(texts.get(f) ?? '');
      if (isMap(doc)) workflows.set(f, doc);
    } catch (e) {
      unchecked.push({ check: 'workflow', subject: f, reason: `could not read it: ${/** @type {Error} */ (e).message}` });
    }
  }

  // The release the callers pin, and the one to check against.
  const pins = kanonPins(texts);
  const exact = [...pins.keys()].filter((r) => /^v\d+\.\d+\.\d+$/.test(r));
  if (!exact.length) return { error: `nothing in ${repo}'s .github/ pins Kanon to an exact release (yedeya-labs/kanon/...@vX.Y.Z). Install it with kanon init first.` };
  const laneCallers = [...workflows].flatMap(([, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).map((j) => kanonCall(j?.uses)).filter((c) => c && c.workflow.startsWith('agent-')).map((c) => /** @type {{ ref: string }} */ (c).ref));
  const count = (/** @type {string} */ r) => laneCallers.filter((x) => x === r).length;
  const pinned = /** @type {string} */ ([...exact].sort((a, b) => count(b) - count(a) || newer(b, a))[0]);
  const checked = opts.to ?? pinned;
  /** @type {Requirements} */
  let req;
  try {
    req = await requirementsAt(deps, checked);
  } catch (e) {
    return { error: /** @type {Error} */ (e).message };
  }

  /** @type {Inspection} */
  let s;
  try {
    // `inspect` reads through `gh` alone.
    s = await inspect(/** @type {import('./init.mjs').Deps} */ (/** @type {unknown} */ (deps)), repo);
  } catch (e) {
    return { error: /** @type {Error} */ (e).message };
  }

  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const notes = [];
  /**
   * @param {string} id @param {string} subject @param {string} message
   * @param {{ text: string, commands?: string[], url?: string | null }} fix
   */
  const find = (id, subject, message, fix) => {
    const kind = FINDINGS[id];
    if (!kind) throw new Error(`no finding "${id}" in FINDINGS`);
    findings.push({ id, category: kind.category, blocking: kind.blocking, subject, message, fix: { text: fix.text, commands: fix.commands ?? [], url: fix.url ?? null } });
  };
  /**
   * The items each finding of an `ITEMIZED` id lists, and how to write it again for some of them,
   * so a waiver that names only some leaves the rest a finding (#406).
   * @type {Map<Finding, { items: string[], build: (items: string[]) => [string, FixIn] }>}
   */
  const itemized = new Map();
  /**
   * A finding that lists `items`: `build` writes its message and fix for any of them.
   * @param {string} id @param {string} subject @param {string[]} items
   * @param {(items: string[]) => [string, FixIn]} build
   */
  const findItems = (id, subject, items, build) => {
    if (!ITEMIZED[id]) throw new Error(`no finding "${id}" in ITEMIZED`);
    const [message, fix] = build(items);
    find(id, subject, message, fix);
    itemized.set(/** @type {Finding} */ (findings[findings.length - 1]), { items, build });
  };
  /** The finding `f` written again for some of its items. @param {Finding} f @param {string[]} items @returns {Finding} */
  const remake = (f, items) => {
    const [message, fix] = /** @type {{ build: (items: string[]) => [string, FixIn] }} */ (itemized.get(f)).build(items);
    return { ...f, message, fix: { text: fix.text, commands: fix.commands ?? [], url: fix.url ?? null } };
  };
  // The workflows are read from the checkout, not from the default branch through the API.
  const branchName = branch.status === 0 ? branch.stdout.trim() : null;
  const onCheckout = branchName && branchName !== 'HEAD' ? branchName : 'this checkout';
  const checking = opts.to ? `${checked} (the release you are moving to)` : `${checked} (the release the callers pin)`;

  if (exact.length > 1 || pins.size > exact.length) {
    const list = [...pins].map(([r, files]) => `${r} (${files.join(', ')})`).join('; ');
    find('pin.mixed', '.github', `Kanon's references pin more than one release, or a ref that is not an exact release: ${list}. lane-check requires one exact release everywhere (K-ADOPT-11).`, {
      text: `Pin every yedeya-labs/kanon reference under .github/ to ${checked}.`,
    });
  }

  // ── The kanon plugin's release ──────────────────────────────────────────────────────────
  // Declared in the project's .claude/settings.json (#376, cli/plugin.mjs), the plugin's release
  // is in the repository, where doctor can compare it with the release it checks against: the
  // skills run `kanon` from the release they ship in, and install that release. Not blocking: no
  // lane reads it, and the two move at different times (the upgrade skill moves the ref with the
  // pins, Dependabot the pins alone, release-please in Kanon's own repository the ref first).
  const plugin = readPluginDeclaration(read(SETTINGS_PATH));
  if (plugin.status === 'unreadable') unchecked.push({ check: 'plugin', subject: SETTINGS_PATH, reason: `could not read it: ${plugin.reason}` });
  else if (plugin.status === 'declared') {
    if (plugin.ref !== checked) {
      find('plugin.version-mismatch', SETTINGS_PATH, `declares the kanon plugin's marketplace "${plugin.name}" ${plugin.ref ? `at ${plugin.ref}` : "with no ref, so it follows Kanon's default branch"}, not at ${checking}; the skills run kanon from the release they ship in, and install it (K-ADOPT-11).`, {
        text: `Set the "${plugin.name}" marketplace's ref in ${SETTINGS_PATH} to ${checked}. Claude Code fetches the marketplace again from the changed source; run /reload-plugins in a session that is open.`,
        commands: [`"ref": "${checked}"`],
      });
    }
    if (!plugin.enabled) notes.push(`${SETTINGS_PATH} declares the kanon plugin's marketplace "${plugin.name}" but doesn't enable kanon@${plugin.name} under enabledPlugins, so nobody gets its skills from it (docs/skills.md).`);
  } else {
    notes.push(`${SETTINGS_PATH} doesn't declare the kanon plugin${plugin.status === 'undeclared' && plugin.enabled.length ? ` (it enables ${plugin.enabled.join(', ')}, from a marketplace each person added themselves)` : ''}, so its release lives in each person's Claude Code configuration, where doctor can't compare it with the callers' (docs/skills.md).`);
  }

  // ── The callers ─────────────────────────────────────────────────────────────────────────
  /** @type {Array<{ file: string, wf: Record<string, any>, jobName: string, job: Record<string, any>, lane: string }>} */
  const callers = [];
  /** @type {Array<{ file: string, job: Record<string, any> }>} */
  const appsCheckCallers = [];
  // Each job that calls the release workflow, by Kanon's pin, `$/` or a local path (#441): read
  // only to tell whether the Releaser is in use, so a `$/` caller meets no rule of a pinned one.
  /** @type {Array<{ file: string, job: Record<string, any> }>} */
  const releaseCallers = [];
  for (const [file, wf] of workflows) {
    for (const [jobName, job] of Object.entries(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(job)) continue;
      if (releaseCall(job.uses)) releaseCallers.push({ file, job });
      const call = kanonCall(job.uses);
      if (!call) continue;
      if (call.workflow === 'apps-check') appsCheckCallers.push({ file, job });
      else if (call.workflow.startsWith('agent-') && call.workflow !== 'agent-lane') callers.push({ file, wf, jobName, job, lane: call.workflow });
    }
  }
  const installed = [...new Set(callers.map((c) => c.lane))].filter((l) => req.lanes[l]).sort();
  // THE QA STORE (kanon#433): its two secrets are the store-coupled lanes' optional ones, which a
  // caller maps once the repository has a store hook, and may leave out until then. So they are
  // asked for only where the hook exists.
  const storeSecrets = req.qaStore?.secrets ?? [];
  const hasStore = Boolean(req.qaStore && read(req.qaStore.hook) !== null);
  // From kanon#479 the `qa-store` block takes no `variables`, so the hook reads the secrets alone:
  // a store secret is then needed even where a variable still holds its value. A release whose
  // requirements file doesn't say so (v0.34.x) still passed the variables, as a fallback.
  const secretsOnly = req.qaStore?.secretsOnly === true;

  for (const c of callers) {
    const spec = req.lanes[c.lane];
    if (!spec) {
      find('caller.lane-removed', c.file, `calls the lane ${c.lane}, which Kanon ${checked} does not ship.`, { text: `Remove ${c.file}, or replace it with the lane that took ${c.lane}'s place (the release notes of ${checked} say which).` });
      continue;
    }
    if (c.file !== `.github/workflows/${c.lane}.yml`) {
      find('caller.misplaced', c.file, `calls the lane ${c.lane}, so it must live at .github/workflows/${c.lane}.yml: Kanon finds and dispatches the lane's runs by that file name (K-LAYOUT-18).`, {
        text: `Rename it to .github/workflows/${c.lane}.yml.`,
        commands: [`git mv ${c.file} .github/workflows/${c.lane}.yml`],
      });
    }
    const want = spec.secrets;
    if (!isMap(c.job.secrets)) {
      find('caller.secrets-inherited', c.file, `maps no secrets by name (secrets: ${String(c.job.secrets ?? 'none')}); the lane ${c.lane} takes exactly ${want.join(', ') || 'none'}, each mapped explicitly (plan 0001 decision 7).`, {
        text: `Replace the job's secrets: with one line per secret the lane takes.`,
        commands: want.map((n) => `      ${n}: \${{ secrets.${n} }}`),
      });
    } else {
      const got = Object.keys(c.job.secrets);
      const optional = spec.optionalSecrets ?? [];
      const missing = want.filter((n) => !got.includes(n) && !optional.includes(n));
      const stale = got.filter((n) => !want.includes(n));
      const unmapped = optional.filter((n) => !got.includes(n) && storeSecrets.includes(n));
      if (missing.length) {
        findItems('caller.secret-missing', c.file, missing, (xs) => [`does not map ${xs.join(', ')}, which the lane ${c.lane} takes at ${checked}.`, {
          text: `Add under the job's secrets:`,
          commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        }]);
      }
      if (stale.length) {
        findItems('caller.secret-stale', c.file, stale, (xs) => [`maps ${xs.join(', ')}, which the lane ${c.lane} does not take at ${checked}; GitHub refuses a call that passes a secret the called workflow does not declare.`, {
          text: `Remove these lines from the job's secrets:`,
          commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        }]);
      }
      if (hasStore && unmapped.length) {
        findItems('qa-store.unmapped', c.file, unmapped, (xs) => [`does not map ${xs.join(' or ')}, so the lane ${c.lane} hands ${req.qaStore?.hook} no store secrets: its store jobs ${secretsOnly ? `reach no store, since Kanon ${checked} passes the hook no variables to fall back to` : "read the deprecated variables, which every store job's log prints, or reach no store"} (docs/qa-store.md, "Move the coordinates to secrets").`, {
          text: `Add under the job's secrets:`,
          commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        }]);
      }
    }
    const stale = Object.keys(isMap(c.job.with) ? c.job.with : {}).filter((k) => !spec.inputs[k]);
    if (stale.length) {
      findItems('caller.input-stale', c.file, stale, (xs) => [`passes ${xs.join(', ')}, which the lane ${c.lane} does not declare at ${checked}.`, { text: `Remove ${xs.map((k) => `\`${k}\``).join(', ')} from the job's with:, and the dispatch input${xs.length > 1 ? 's' : ''} that feed${xs.length > 1 ? '' : 's'} ${xs.length > 1 ? 'them' : 'it'}.` }]);
    }
    const grant = c.job.permissions !== undefined ? c.job.permissions : c.wf.permissions;
    const short = Object.entries(spec.grant).filter(([k, v]) => !isMap(grant) || level(grant[k]) < level(v));
    if (short.length) {
      findItems('caller.grant-missing', c.file, short.map(([k]) => k), (xs) => {
        const some = short.filter(([k]) => xs.includes(k));
        return [isMap(grant)
        ? `grants ${some.map(([k]) => `${k}: ${grant[k] ?? 'none'}`).join(', ')}; the lane ${c.lane} needs ${some.map(([k, v]) => `${k}: ${v}`).join(', ')} at ${checked}.`
        : grant === undefined
          ? `grants no explicit permissions; the calling job's permissions: are the lane ${c.lane}'s ceiling (plan 0001 §3).`
          : `grants \`permissions: ${String(grant)}\` rather than a map; the calling job's permissions: are the lane ${c.lane}'s ceiling, so lane-check requires the lane's grant written out (plan 0001 §3).`, {
        text: isMap(grant) ? `Grant under the caller's permissions:` : `Replace the caller's permissions: with the lane's grant:`,
        commands: isMap(grant) ? some.map(([k, v]) => `  ${k}: ${v}`) : ['permissions:', ...Object.entries(spec.grant).map(([k, v]) => `  ${k}: ${v}`)],
      }];
      });
    }
    if (spec.callerName && c.wf.name !== spec.callerName) {
      find('caller.name', c.file, `is named "${String(c.wf.name ?? '')}"; the lane ${c.lane} tells its own checks apart by its caller's name, which must be "${spec.callerName}".`, { text: `Set the workflow's name:`, commands: [`name: ${spec.callerName}`] });
    }
    if (spec.callerRunNameEndsWith && !String(c.wf['run-name'] ?? '').endsWith(` ${spec.callerRunNameEndsWith}`)) {
      find('caller.run-name', c.file, `has a run-name that does not end with \` ${spec.callerRunNameEndsWith}\`; the lane ${c.lane}'s runs are found by it.`, { text: `End the workflow's run-name: with that text, as its last token.` });
    }
  }

  // ── The Apps the lanes run as ─────────────────────────────────────────────────────────────
  const identities = [...new Set(installed.flatMap((l) => req.lanes[l]?.identities ?? []))];
  const releaserSecrets = appSecrets('releaser');
  if (req.identities.apps.releaser && releaseCallers.some((c) => isMap(c.job.secrets) && releaserSecrets.some((n) => n in c.job.secrets))) identities.push('releaser');
  identities.sort();
  const rows = registerRows(read(REGISTER_PATH));
  /** @type {Map<string, string>} identity → its one slug */
  const slugOf = new Map();
  /** @type {Map<string, string[]>} slug → identities */
  const bySlug = new Map();
  for (const id of identities) {
    /** @type {string[]} */
    let roles;
    try {
      roles = registerRolesOf(id, req);
    } catch (e) {
      return { error: `Kanon ${checked}'s requirements file is inconsistent: ${/** @type {Error} */ (e).message}` };
    }
    const missingRows = roles.filter((r) => !rows.has(r));
    const slugs = [...new Set(roles.map((r) => rows.get(r)).filter((x) => x !== undefined))];
    const apps = (() => {
      try {
        return `kanon apps --owner ${s.owner} --repo ${repoName} ${appsArgs([id], req).join(' ')}`;
      } catch {
        return `kanon apps --owner ${s.owner} --repo ${repoName}`;
      }
    })();
    if (missingRows.length) {
      findItems('register.missing-row', REGISTER_PATH, missingRows, (xs) => [`lists no ${xs.join(', ')} row, which the ${id} App's lanes read their App slug from (K-LAYOUT-6).`, {
        text: slugs.length === 1
          ? `Add the row${xs.length > 1 ? 's' : ''} naming the ${id} App's slug \`${slugs[0]}\`, or let kanon apps write them, and commit the register.`
          : `Create the ${id} App from this checkout, and commit the register rows it writes.`,
        commands: slugs.length === 1 ? [] : [apps],
      }]);
    }
    if (slugs.length > 1) {
      findItems('register.split-slug', REGISTER_PATH, [id], () => [`names more than one App for the ${id} App's roles (${roles.map((r) => `${r}: ${rows.get(r) ?? 'none'}`).join(', ')}); since plan 0005 each App's roles share one slug (§3.4).`, {
        text: `Create the ${id} App, or reuse the owner's, and point each of its roles' rows at its slug; then commit the register.`,
        commands: [apps],
      }]);
    }
    if (slugs.length === 1) {
      const slug = /** @type {string} */ (slugs[0]);
      slugOf.set(id, slug);
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), id]);
    }
  }
  for (const [slug, ids] of bySlug) {
    if (ids.length > 1) {
      find('register.shared-slug', REGISTER_PATH, `names the App \`${slug}\` for ${ids.join(' and ')}; ${ids.includes('author') && ids.includes('judge') ? 'an App that authors and approves approves its own pull requests' : 'each App holds its own roles alone'} (plan 0005 §3.4).`, {
        text: `Give each its own App, and point its roles' rows at that App's slug.`,
      });
    }
  }
  // GitHub shows a private App only to the App itself: GET /apps/<slug> answers 404 to a person's
  // token and the workflow's alike (#417). apps-check reads each installation with the App's own
  // key and prints what it found (cli/apps-check.mjs), and a run's log is readable with
  // Actions: read. Only the latest completed run dispatched on the default branch counts: its
  // workflow is the reviewed one, and an older run may predate a change. The branch filter alone
  // doesn't hold that: it matches a run's head_branch, and a pull request from a fork's own `main`
  // has that too, and runs the fork's workflow. So the query asks the server for workflow_dispatch
  // runs only, the one trigger the caller declares and one a fork can't start, and a run from
  // another repository or another trigger is refused, never read.
  const appsCheckPath = appsCheckCallers[0]?.file ?? (workflows.has('.github/workflows/apps-check.yml') ? '.github/workflows/apps-check.yml' : null);
  const appsCheckName = appsCheckPath ? basename(appsCheckPath) : 'apps-check.yml';
  const runAppsCheck = appsCheckPath
    ? `run ${appsCheckName} on ${s.defaultBranch} (gh workflow run ${appsCheckName} -R ${repo}), then doctor again`
    : `add the apps-check caller (docs/apps.md), run it on ${s.defaultBranch}, then doctor again`;
  const ghJsonOf = (/** @type {GhResult} */ r) => {
    try {
      return r.status === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      return null;
    }
  };
  /** @type {Promise<{ run: any, jobs: any[] } | { reason: string }> | null} */
  let latestAppsCheck = null;
  const appsCheckRun = () =>
    (latestAppsCheck ??= (async () => {
      if (!appsCheckPath) return { reason: `no apps-check workflow is there to read it from: ${runAppsCheck}` };
      const runs = await deps.gh(['api', `repos/${repo}/actions/workflows/${appsCheckName}/runs?branch=${encodeURIComponent(s.defaultBranch)}&event=workflow_dispatch&status=completed&per_page=1`]);
      const list = ghJsonOf(runs)?.workflow_runs;
      if (!Array.isArray(list)) return { reason: `the token can't list ${appsCheckName}'s runs, which needs Actions: read (${runs.stderr.trim() || `exit ${runs.status}`})` };
      const run = list[0];
      if (!isMap(run)) return { reason: `${appsCheckName} has no completed run on ${s.defaultBranch}: ${runAppsCheck}` };
      const from = isMap(run.head_repository) ? String(run.head_repository.full_name ?? '') : '';
      if (run.event !== 'workflow_dispatch' || from.toLowerCase() !== repo.toLowerCase()) {
        return { reason: `the latest ${appsCheckName} run on ${s.defaultBranch} (${run.html_url}) was started by ${run.event || 'an unknown event'} from ${from || 'an unknown repository'}, not dispatched in ${repo}, so its workflow may not be the reviewed one: ${runAppsCheck}` };
      }
      const jobs = await deps.gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]);
      const all = ghJsonOf(jobs)?.jobs;
      if (!Array.isArray(all)) return { reason: `the token can't list the jobs of ${run.html_url}, which needs Actions: read (${jobs.stderr.trim() || `exit ${jobs.status}`})` };
      return { run, jobs: all };
    })());
  /**
   * What the latest apps-check run found on the App's installation, or why it can't be used.
   * @param {string} id @param {string} slug
   * @returns {Promise<{ result: import('./apps-check.mjs').Result, when: string } | { reason: string }>}
   */
  const fromAppsCheck = async (id, slug) => {
    const found = await appsCheckRun();
    if ('reason' in found) return found;
    const when = `the ${appsCheckName} run of ${String(found.run.created_at ?? '').slice(0, 10)} (${found.run.html_url})`;
    const name = req.identities.apps[id]?.name;
    const job = name ? found.jobs.find((j) => isMap(j) && (j.name === name || String(j.name).endsWith(` / ${name}`))) : undefined;
    if (!job) return { reason: `${when} has no job for the ${id} App: ${runAppsCheck}` };
    const path = `repos/${repo}/actions/jobs/${job.id}/logs`;
    // The log holds terminal escapes, which gh prints only when asked; a gh too old to know the
    // flag prints them anyway.
    let log = await deps.gh(['api', '--allow-escape-sequences', path]);
    if (log.status !== 0 && /unknown flag/.test(log.stderr)) log = await deps.gh(['api', path]);
    if (log.status !== 0) return { reason: `the token can't read the log of ${when}, which needs Actions: read (${log.stderr.trim() || `exit ${log.status}`})` };
    const result = readResult(log.stdout, id);
    if (!result && resultMasked(log.stdout)) return { reason: `${when} printed a result for the ${id} App that the runner masked part of, where a secret's value appeared in it, so it can't be read; this is apps-check's to fix, not yours` };
    if (!result) return { reason: `${when} printed no result for the ${id} App, as an apps-check from before #417 doesn't, nor one that couldn't mint the App's token: ${runAppsCheck}` };
    if (result.slug !== slug) return { reason: `${when} checked the App \`${result.slug}\` as the ${id} App, but the register names \`${slug}\`: ${runAppsCheck}` };
    return { result, when };
  };

  /**
   * The owner's App installations, read once: only an owner of an organisation can list them,
   * with its Administration permission (read); a repository's token never can (#417).
   * @type {Promise<{ listed: GhResult, installs: any[] | null }> | null}
   */
  let installations = null;
  const ownerInstallations = () =>
    (installations ??= listInstallations(deps.gh, s.owner, s.kind));

  /** @type {Map<string, number>} identity → its App's id, read with its permissions */
  const appIdOf = new Map();
  for (const [id, slug] of slugOf) {
    const need = req.identities.apps[id]?.permissions ?? req.identities.roles[id]?.permissions ?? {};
    const r = await deps.gh(['api', `apps/${slug}`]);
    /** @type {any} */
    let app = ghJsonOf(r);
    if (!isMap(app) || !isMap(app.permissions)) {
      const found = await fromAppsCheck(id, slug);
      if ('reason' in found) {
        unchecked.push({ check: 'app-permissions', subject: slug, reason: `could not read the App ${slug} (${r.stderr.trim() || `exit ${r.status}`}), and ${found.reason}` });
        continue;
      }
      // No id: the App's id is a secret's value, which the run's log masks (#417).
      app = { permissions: found.result.permissions };
      notes.push(`GitHub shows the ${id} App \`${slug}\` only to itself, so its permissions are its installation's, as ${found.when} found them; run apps-check again after you change them.`);
    }
    if (Number.isInteger(app.id)) appIdOf.set(id, Number(app.id));
    const have = /** @type {Record<string, string>} */ (app.permissions);
    const ownerLogin = String(app.owner?.login ?? s.owner);
    const url = app.owner?.type === 'Organization' || (!app.owner && s.kind === 'Organization') ? `https://github.com/organizations/${ownerLogin}/settings/apps/${slug}/permissions` : `https://github.com/settings/apps/${slug}/permissions`;
    const missing = Object.entries(need).filter(([k, v]) => level(have[k]) < level(v));
    const extra = Object.entries(have).filter(([k, v]) => level(v) > level(need[k]));
    if (missing.length) {
      findItems('app.permission-missing', slug, missing.map(([k]) => k), (xs) => {
        const some = missing.filter(([k]) => xs.includes(k));
        return [`The ${id} App \`${slug}\` holds ${some.map(([k]) => `${k}: ${have[k] ?? 'none'}`).join(', ')}; Kanon ${checked} needs ${some.map(([k, v]) => `${k}: ${v}`).join(', ')}.`, {
          text: `Widen the App's permissions on its settings page, then accept the new permissions on its installation (GitHub asks the installation's owner), and run your apps-check caller.`,
          url,
        }];
      });
    }
    if (extra.length) {
      findItems('app.permission-extra', slug, extra.map(([k]) => k), (xs) => [`The ${id} App \`${slug}\` holds ${extra.filter(([k]) => xs.includes(k)).map(([k, v]) => `${k}: ${v}`).join(', ')}, beyond what Kanon ${checked} grants it (${extra.filter(([k]) => xs.includes(k)).map(([k]) => `${k}: ${need[k] ?? 'none'}`).join(', ')}). Each lane narrows its token to what it uses (K-AGENT-46), so this blocks nothing, but the App holds more than it needs (K-ADOPT-8).`, {
        text: `Narrow the App's permissions on its settings page.`,
        url,
      }]);
    }
  }

  // ── Apps the register no longer names, still installed ───────────────────────────────────────
  // After the move to two Apps (plan 0005 §3.1, L5/L6), the per-role Apps of earlier releases stay
  // installed until someone deletes them, holding keys no lane reads (the Owner, 2026-10-06). An
  // App counts when the register's own history on this checkout once named it and its current
  // copy doesn't, and the owner still has an installation of it. Never blocking: deleting an App
  // is the Owner's, after a week of green runs on the new ones (L5).
  const nowSlugs = new Set(rows.values());
  const history = deps.git(['-C', root, 'log', '--format=', '-p', '--', REGISTER_PATH]);
  const formerSlugs = history.status === 0
    ? [...new Set([...history.stdout.matchAll(/^[+-][ \t]*\|[^|\n]*\|[ \t]*\*{0,2}`([a-z0-9]+(?:-[a-z0-9]+)*)`/gm)].map((m) => /** @type {string} */ (m[1])))].filter((x) => !nowSlugs.has(x)).sort()
    : [];
  if (formerSlugs.length) {
    const { listed, installs } = await ownerInstallations();
    // Only an owner of the organisation can list its installations, with the organisation's
    // Administration permission (read); a repository's token never can (#417).
    if (!installs) {
      unchecked.push({
        check: 'unused-apps',
        subject: s.owner,
        reason: `the token can't list ${s.owner}'s App installations (${listed.stderr.trim() || `exit ${listed.status}`}), so ${formerSlugs.join(', ')}, which the register once named, can't be looked for. ${
          s.kind === 'Organization'
            ? `Only an owner of ${s.owner} can list them, with a token that holds the organisation's Administration permission (read): run doctor once with one (docs/doctor.md, "The token it needs")`
            : 'Look for them on https://github.com/settings/installations'
        }`,
      });
    }
    else {
      for (const slug of formerSlugs) {
        const inst = installs.find((/** @type {any} */ i) => i?.app_slug === slug && String(i?.account?.login ?? '').toLowerCase() === s.owner.toLowerCase());
        if (!inst) continue;
        const base = s.kind === 'Organization' ? `https://github.com/organizations/${s.owner}/settings` : 'https://github.com/settings';
        find('app.unused', slug, `The App \`${slug}\` is still installed for ${s.owner}, but ${REGISTER_PATH} no longer names it, so no lane of ${checked} runs as it; it holds a key nothing reads (plan 0005 §3.1).`, {
          text: `Once the Apps that replaced it have run green for a week (plan 0005 L5), uninstall it on its installation page, delete it on its Advanced page (${base}/apps/${slug}/advanced, "Delete GitHub App"), and delete its secrets if secret.stale lists them. Keep it while another repository's register still names it.`,
          url: `${base}/installations/${inst.id}`,
        });
      }
    }
  }

  // ── The secrets ───────────────────────────────────────────────────────────────────────────
  // What each workflow maps, read as #414 reads it: any `secrets.<NAME>` outside its on:, whatever
  // the job calls. A secret of Kanon's that a workflow maps is needed whether or not the job calls
  // a lane doctor recognises (a local path, `$/`), and the secrets of each of the checked release's
  // Apps that one maps, both of them, so the Releaser's too when a local release caller maps it
  // (#415). A reusable workflow's own `secrets.<NAME>` of a secret its on.workflow_call.secrets
  // declares reads what its caller passes it, not the repository's: the caller is what maps it, so
  // it doesn't count here, though it still counts as read for secret.stale (#414).
  const mapping = [...workflows].map(([file, wf]) => ({ file, ...secretReads(wf), takes: callTakes(wf) }));
  /** @param {string} n */
  const mappedBy = (n) => mapping.filter((m) => m.names.has(n) && !m.takes.has(n)).map((m) => m.file);
  const laneSecrets = new Set(Object.values(req.lanes).flatMap((l) => l?.secrets ?? []));
  const secretApps = [...new Set([...identities, ...Object.keys(req.identities.apps).filter((a) => appSecrets(a).some((n) => mappedBy(n).length))])].sort();
  // The QA store's two secrets are optional (kanon#433): a caller maps them, empty, whether or not
  // the repository has a store, so they are needed only once its store hook exists.
  const needSecrets = [...new Set([...installed.flatMap((l) => req.lanes[l]?.secrets ?? []), ...secretApps.flatMap(appSecrets), ...[...laneSecrets].filter((n) => mappedBy(n).length)])]
    .filter((n) => hasStore || !storeSecrets.includes(n))
    .sort();
  /**
   * The workflows that map these secrets, and the callers of a lane that takes them and doesn't
   * map them yet (caller.secret-missing names those lines), for the finding's message.
   * @param {string[]} names
   */
  const whoNeeds = (names) => {
    const maps = [...new Set(names.flatMap(mappedBy))].sort();
    const must = [...new Set(callers.filter((c) => names.some((n) => req.lanes[c.lane]?.secrets.includes(n))).map((c) => c.file))].filter((f) => !maps.includes(f)).sort();
    const them = names.length > 1 ? 'them' : 'it';
    return [
      ...(maps.length ? [`${maps.join(', ')} map${maps.length > 1 ? '' : 's'} ${them}`] : []),
      ...(must.length ? [`${must.join(', ')} call${must.length > 1 ? '' : 's'} a lane that takes ${them} at ${checked}`] : []),
    ].join('; ');
  };
  // The QA store's coordinates as repository variables (kanon#433): v0.33.0's way, which prints
  // them, and the account id they carry, in every store job's log. Never blocking: against a
  // release that still passes them (v0.34.x) the hook falls back to them, so the store still
  // works; against one that doesn't (kanon#479, `secretsOnly`) a variable is only a leftover, and
  // the store secret it doesn't replace is `secret.missing`, below, which blocks. Only where the
  // store hook exists and a store-coupled lane is installed.
  /** @type {string[]} */
  let storeVariables = [];
  if (hasStore && storeSecrets.length && installed.some((l) => (req.lanes[l]?.optionalSecrets ?? []).length)) {
    const listed = await deps.gh(['variable', 'list', '-R', repo, '--json', 'name']);
    try {
      if (listed.status === 0) storeVariables = storeSecrets.filter((n) => JSON.parse(listed.stdout).some((/** @type {any} */ v) => String(v.name) === n));
      else notes.push(`The token can't list ${repo}'s variables, so doctor can't tell whether ${storeSecrets.join(' or ')} is still a variable, which every store job's log prints (docs/qa-store.md, "Move the coordinates to secrets").`);
    } catch {
      storeVariables = [];
    }
    if (storeVariables.length) {
      findItems('qa-store.variables', repo, storeVariables, (xs) => [secretsOnly
        ? `holds ${xs.join(' and ')} as ${xs.length > 1 ? 'repository variables' : 'a repository variable'}, which Kanon ${checked}'s lanes no longer read or print: they hand the QA store's hook its coordinates as secrets alone (kanon#479). ${xs.length > 1 ? 'They are' : 'It is'} left over from v0.33.0, and any workflow that reads ${xs.length > 1 ? 'them' : 'it'} prints the AWS account id in ${xs.length > 1 ? 'them' : 'it'}.`
        : `holds ${xs.join(' and ')} as ${xs.length > 1 ? 'repository variables' : 'a repository variable'}, which the runner never masks: every store job's log prints ${xs.length > 1 ? 'them' : 'it'}, and the AWS account id in ${xs.length > 1 ? 'them' : 'it'}. Kanon's lanes take the QA store's coordinates as secrets since kanon#433.`, {
        text: secretsOnly
          ? `Copy each into a secret of the same name where none is set yet, then, once a store job has run green on the secrets, delete the variables (docs/qa-store.md, "Move the coordinates to secrets"):`
          : `Copy each into a secret of the same name, map both secrets in the caller of each store-coupled lane (${installed.filter((l) => (req.lanes[l]?.optionalSecrets ?? []).length).join(', ')}) at ${checked} or later, make the hook read inputs.secrets first, and once a store job has run green on the secrets, delete the variables (docs/qa-store.md, "Move the coordinates to secrets"):`,
        commands: [
          ...xs.filter((n) => !s.secrets?.has(n)).map((n) => `gh variable get ${n} -R ${repo} | gh secret set ${n} -R ${repo}`),
          ...xs.map((n) => `gh variable delete ${n} -R ${repo}`),
        ],
      }]);
    }
  }
  if (!s.secrets) unchecked.push({ check: 'secrets', subject: repo, reason: "the token can't list the repository's secret names (it needs admin access)" });
  else {
    // `kanon apps` is the person's step (#420): its pre-check first, which creates nothing, then
    // the line that creates the App, or stores a key for the one the register already names.
    const preflight = `kanon apps --owner ${s.owner} --repo ${repoName} --preflight`;
    for (const id of secretApps) {
      const lacks = appSecrets(id).filter((n) => needSecrets.includes(n) && !s.secrets?.has(n));
      if (!lacks.length) continue;
      const slug = slugOf.get(id) ?? (() => {
        try {
          const slugs = [...new Set(registerRolesOf(id, req).map((r) => rows.get(r)).filter((x) => x !== undefined))];
          return slugs.length === 1 ? slugs[0] : undefined;
        } catch {
          return undefined;
        }
      })();
      findItems('secret.missing', repo, lacks, (xs) => {
        const who = whoNeeds(xs);
        // The App's id alone isn't secret, so it goes on the line with --body, which works at the
        // Claude Code prompt with `!`, where a line that reads standard input stores an empty
        // secret (#625); and it needs no new key. GitHub shows a private App's id only on its page.
        const [idName] = appSecrets(id);
        const appId = appIdOf.get(id);
        return [`lacks ${xs.join(' and ')}, the ${id} App's ${xs.length > 1 ? 'secrets' : 'secret'}${who ? `: ${who}` : ''}.`, slug && xs.length === 1 && xs[0] === idName
        ? {
          text: `Store the App's id${appId === undefined ? ", the App ID its settings page shows, in place of the line's <…>" : ''}. It isn't secret, so it goes on the line with --body, which works at the Claude Code prompt with \`!\` as well:`,
          commands: [`gh secret set ${idName} -R ${repo} --body ${appId ?? '<the App ID on its settings page>'}`],
          url: s.kind === 'Organization' ? `https://github.com/organizations/${s.owner}/settings/apps/${slug}` : `https://github.com/settings/apps/${slug}`,
        }
        : slug
        ? { text: `Add ${repoName} to the ${id} App's installation, generate a private key on its settings page, and copy its App ID from the same page. kanon apps is your step: check the token with the first command (it creates nothing), then store the key with the second (it checks the key, stores both secrets and deletes the file):`, commands: [preflight, `kanon apps --owner ${s.owner} --repo ${repoName} --reuse ${id}:${slug}@<App ID>=<downloaded>.pem`] }
        : { text: `Create the ${id} App from this checkout. kanon apps is your step: check the token with the first command (it creates nothing), then create the App with the second, which stores its secrets:`, commands: [preflight, `kanon apps --owner ${s.owner} --repo ${repoName} ${(() => { try { return appsArgs([id], req).join(' '); } catch { return ''; } })()}`.trim()] }];
      });
    }
    // A store secret a variable still holds is `qa-store.variables`, above, while the checked
    // release still passes the variables, so the store still works; once it doesn't (kanon#479),
    // the secret is missing, and the fix copies it from the variable.
    const output = (/** @type {string} */ n) => (n === 'QA_STORE_ROLE_ARN' ? 'RoleArn' : 'BucketName');
    for (const n of needSecrets.filter((x) => !/_APP_(ID|PRIVATE_KEY)$/.test(x) && !s.secrets?.has(x) && (secretsOnly || !storeVariables.includes(x)))) {
      const by = installed.filter((l) => req.lanes[l]?.secrets.includes(n));
      const who = whoNeeds([n]);
      findItems('secret.missing', repo, [n], () => [`lacks ${n}${by.length ? `, which ${by.join(', ')} ${by.length > 1 ? 'take' : 'takes'}` : ''}${who ? `: ${who}` : ''}.`, {
        text: n === 'CLAUDE_CODE_OAUTH_TOKEN' ? `Store the token of the Claude subscription the agents run on, made with \`claude setup-token\` (docs/lanes.md), ${OWN_TERMINAL}:`
          : storeVariables.includes(n) ? `${req.qaStore?.hook} exists, and Kanon ${checked} hands it the store's coordinates as secrets alone, never the variable ${n} that holds this one (kanon#479): copy the variable into the secret, through a pipe, so the value is never printed (docs/qa-store.md, "Move the coordinates to secrets"):`
          : storeSecrets.includes(n) ? `${req.qaStore?.hook} exists, so the store-coupled lanes need the store's coordinates: store the stack's ${output(n)} output, putting it in for the line's <${output(n)}>. It isn't secret, so it goes on the line with --body, which works at the Claude Code prompt with \`!\` as well (docs/qa-store.md, "Provision a store"):`
          : `Store it ${OWN_TERMINAL}:`,
        commands: [storeVariables.includes(n) ? `gh variable get ${n} -R ${repo} | gh secret set ${n} -R ${repo}` : storeSecrets.includes(n) ? `gh secret set ${n} -R ${repo} --body '<${output(n)}>'` : `gh secret set ${n} -R ${repo}`],
      }]);
    }
    // An App secret no App in use reads and no workflow maps: left from the per-role Apps, or from
    // an App dropped. A secret any job maps counts as read, whatever the job calls (#414).
    const known = new Set([...Object.keys(req.identities.roles), ...Object.keys(req.identities.apps)].flatMap(appSecrets));
    const used = new Set(identities.flatMap(appSecrets));
    for (const m of mapping) for (const n of m.names) used.add(n);
    const stale = [...s.secrets].filter((n) => known.has(n) && !used.has(n.toUpperCase())).sort();
    const inheriting = mapping.flatMap((m) => m.inherits.map((j) => `${m.file}'s job ${j}`));
    const unread = unchecked.filter((u) => u.check === 'workflow').map((u) => u.subject);
    const computing = mapping.filter((m) => m.computed).map((m) => m.file);
    if (stale.length && inheriting.length) notes.push(`${inheriting.join(', ')} inherit${inheriting.length > 1 ? '' : 's'} every secret, so doctor lists none of ${stale.join(', ')} as stale: it can't tell which the called workflow reads.`);
    else if (stale.length && computing.length) notes.push(`${computing.join(', ')} read${computing.length > 1 ? '' : 's'} secrets by a computed name or as a whole (\`secrets[<expression>]\`, \`toJSON(secrets)\`), which can reach any of them, so doctor lists none of ${stale.join(', ')} as stale: it can't tell which ${computing.length > 1 ? 'they read' : 'it reads'} (#440).`);
    else if (stale.length && unread.length) notes.push(`doctor lists none of ${stale.join(', ')} as stale: it could not read ${unread.join(', ')}, which may map them.`);
    else if (stale.length) {
      findItems('secret.stale', repo, stale, (xs) => [`holds ${xs.join(', ')}, which no App the lanes of ${checked} run as here reads, and no job of a workflow under .github/workflows/ on ${onCheckout} names: doctor reads every \`secrets.<NAME>\` in each workflow outside its on:, in a job's secrets:, env:, with: or steps alike, whatever the job calls.`, {
        text: `Delete them${branchName === s.defaultBranch ? '' : `, once ${s.defaultBranch}'s workflows map none of them either`}, and uninstall the Apps they belong to if no repository uses them:`,
        commands: xs.map((n) => `gh secret delete ${n} -R ${repo}`),
      }]);
    }
  }

  // ── The declarations, hooks and workflows the lanes read ────────────────────────────────────
  /** @type {Map<string, string[]>} path → lanes */
  const reads = new Map();
  for (const l of installed) for (const d of req.lanes[l]?.reads ?? []) reads.set(d, [...(reads.get(d) ?? []), l]);
  const declared = /** @type {Record<string, { baseline: boolean, requiredSections: string[] }> | undefined} */ (/** @type {any} */ (req).declarations);
  // The capability ledger is needed only where the adoption record turns the capability watch on
  // (kanon#477); off by default. A malformed choice is named below, and holds the ledger as needed.
  const capabilityWatchOn = (() => {
    const record = read(ADOPTION_RECORD);
    try { return record !== null && parseCapabilityWatch(record) === 'on'; } catch { return true; }
  })();
  for (const [path, by] of [...reads].sort(([a], [b]) => a.localeCompare(b))) {
    const decl = declared?.[path] ?? { baseline: /-playbook\.md$/.test(path), requiredSections: path === 'docs/qa/stack.md' ? ['## Gates'] : [] };
    const text = read(path);
    if (text === null && path === CAPABILITY_LEDGER && !capabilityWatchOn) {
      notes.push(`${path} doesn't exist, which is fine: ${ADOPTION_RECORD} doesn't turn the capability watch on, so ${by.join(', ')} skip${by.length > 1 ? '' : 's'} the capability review and don't read it (K-LAYOUT-10).`);
      continue;
    }
    if (text === null) {
      if (decl.baseline) notes.push(`${path} doesn't exist, so ${by.join(', ')} read${by.length > 1 ? '' : 's'} Kanon's baseline for it (plan 0005 §5.2).`);
      else {
        find('declaration.missing', path, `is missing; ${by.join(', ')} read${by.length > 1 ? '' : 's'} it at ${checked} (K-LAYOUT-17).`, {
          text: path === 'docs/qa/stack.md' ? `Write it with its ## Gates, or let kanon init write it:` : `Write it (K-LAYOUT-17), or let kanon init write it where it can:`,
          commands: ['kanon init --dry-run'],
        });
      }
      continue;
    }
    for (const h of decl.requiredSections) {
      const n = headingCount(text, h);
      if (n !== 1) findItems('declaration.section-missing', path, [h], () => [`has the heading \`${h}\` ${n} times; ${by.join(', ')} read${by.length > 1 ? '' : 's'} that section, which has no default, so it is there exactly once (K-LAYOUT-17).`, { text: `Write \`${h}\` exactly once, outside any fenced block.` }]);
    }
  }
  if (installed.length) {
    const hook = read(req.hook.path);
    if (hook === null) {
      find('hook.missing', req.hook.path, `the project-setup hook is missing; every lane that checks out calls it (plan 0001 §5).`, { text: `Write it, or let kanon init write a starting one that installs nothing yet.`, commands: ['kanon init --dry-run'] });
    } else {
      /** @type {unknown} */
      let doc = null;
      try {
        doc = parseYaml(hook);
      } catch (e) {
        unchecked.push({ check: 'hook', subject: req.hook.path, reason: `could not read it: ${/** @type {Error} */ (e).message}` });
      }
      if (isMap(doc)) {
        const inputs = isMap(doc.inputs) ? doc.inputs : {};
        const lacks = req.hook.inputs.filter((k) => !(k in inputs));
        if (lacks.length) {
          findItems('hook.input-missing', req.hook.path, lacks, (xs) => [`does not declare ${xs.join(', ')}, which Kanon ${checked}'s lanes pass it.`, {
            text: `Add under inputs:`,
            commands: xs.flatMap((k) => [`  ${k}:`, `    description: Passed by Kanon's lanes (docs/lanes.md).`, '    default: ""']),
          }]);
        }
      }
    }
  }
  for (const l of installed) {
    for (const h of req.lanes[l]?.hooks ?? []) {
      if (read(h) === null) find('hook.missing', h, `is missing; the lane ${l} calls it at ${checked}.`, { text: `Write the hook (docs/lanes.md says what it receives and returns).` });
    }
    for (const w of req.lanes[l]?.readsWorkflows ?? []) {
      if (!workflows.has(`.github/workflows/${w}`) && read(`.github/workflows/${w}`) === null) {
        find('workflow.missing', `.github/workflows/${w}`, `is missing; the lane ${l} reads its runs by that file name (K-LAYOUT-18).`, { text: `Name the project's CI workflow .github/workflows/${w}, or let kanon init write one.` });
      }
    }
  }

  // ── The apps-check caller ───────────────────────────────────────────────────────────────────
  const kind = identities.some((i) => req.identities.apps[i]) ? req.identities.apps : req.identities.roles;
  const takes = new Set(Object.keys(kind).flatMap(appSecrets));
  for (const c of appsCheckCallers) {
    const got = isMap(c.job.secrets) ? Object.keys(c.job.secrets) : [];
    const lacks = identities.flatMap(appSecrets).filter((n) => !got.includes(n));
    const stale = got.filter((n) => !takes.has(n));
    if (lacks.length) {
      findItems('apps-check.secret-missing', c.file, lacks, (xs) => {
        const blind = identities.filter((i) => appSecrets(i).some((n) => xs.includes(n)));
        return [`does not map ${xs.join(', ')}, so apps-check can't check the ${blind.join(' and ')} App${blind.length > 1 ? 's' : ''}.`, { text: `Add under the job's secrets:`, commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`) }];
      });
    }
    if (stale.length) findItems('apps-check.secret-stale', c.file, stale, (xs) => [`maps ${xs.join(', ')}, which Kanon ${checked}'s apps-check does not take; GitHub refuses the call.`, { text: `Remove these lines from the job's secrets:`, commands: xs.map((n) => `      ${n}: \${{ secrets.${n} }}`) }]);
  }

  // ── The labels ──────────────────────────────────────────────────────────────────────────────
  const taxonomy = new Map(deps.labels().map((l) => [l.name, l]));
  const missingLabels = (req.labels ?? []).filter((n) => !/<[a-z]+>$/.test(n) && !s.labels.has(n));
  if (missingLabels.length) {
    findItems('label.missing', repo, missingLabels, (xs) => [`lacks ${xs.length} of the taxonomy's labels: ${xs.join(', ')}. A lane creates a label it needs on first use (plan 0005 §5.3), so this blocks nothing.`, {
      text: `Let kanon init create them, or create them yourself:`,
      commands: xs.map((n) => {
        const l = taxonomy.get(n);
        return l ? `gh label create ${JSON.stringify(n)} --color ${l.color} --description ${JSON.stringify(l.description)} -R ${repo}` : `gh label create ${JSON.stringify(n)} -R ${repo}`;
      }),
    }]);
  }

  // ── The ruleset ─────────────────────────────────────────────────────────────────────────────
  if (s.rulesets === 'no') notes.push(`${repo} is a private repository on a plan without rulesets: nothing on the platform refuses a merge without the Reviewer's approval, and the repository stays in bootstrap (K-ADOPT-3, K-ADOPT-6).`);
  else if (s.rulesets === 'unknown') unchecked.push({ check: 'ruleset', subject: repo, reason: "the token can't read the repository's rulesets" });
  else if (!s.covering.length) {
    find('ruleset.missing', s.defaultBranch, `no active ruleset covers ${s.defaultBranch}${s.inactive.length ? ` (${s.inactive.map((c) => `"${c.name}" is ${c.enforcement}`).join(', ')})` : ''} (K-ADOPT-1 step 8).`, {
      text: `Let kanon init create "${RULESET_NAME}"; it needs Administration: write.`,
      commands: ['kanon init'],
    });
  } else {
    for (const gap of await checkGaps({ deps, repo, s, checked, gaps: rulesetGaps(s.covering), checkout: workflows, find, unchecked })) {
      find('ruleset.rule-missing', s.defaultBranch, `The ruleset on ${s.defaultBranch} (${s.covering.map((c) => c.name).join(', ')}) does not ${gap} (K-ADOPT-1 step 8).`, { text: `In the repository's Settings, Rules, Rulesets: ${gap}.`, url: `https://github.com/${repo}/settings/rules` });
    }
    // THE RELEASER'S BYPASS (K-MERGE-8, plan 0005 §3.1, #49), only where the release caller maps
    // the Releaser: it is then the one bypass actor, through pull requests only. Without it, the
    // admin's bypass is what merges a release PR that runs no CI (docs/release.md), so nothing
    // is asked. Another actor's bypass is asked off only against a release whose dco check
    // passes the Releaser's release PR (#337); before that, it is what merges that PR.
    if (identities.includes('releaser')) {
      const slug = slugOf.get('releaser');
      let appId = appIdOf.get('releaser');
      /** @type {string | null} */
      let noId = null;
      // A private Releaser's permissions come from apps-check, but not its id: that is the
      // <RELEASER>_APP_ID secret's value, which the run's log masks, and doctor never works
      // around a mask (K-AGENT-47). Its installation, which an organisation's owner can list,
      // names it.
      if (slug !== undefined && appId === undefined && !unchecked.some((u) => u.check === 'app-permissions' && u.subject === slug)) {
        const { listed, installs } = await ownerInstallations();
        const inst = installs?.find((/** @type {any} */ i) => i?.app_slug === slug && String(i?.account?.login ?? '').toLowerCase() === s.owner.toLowerCase());
        if (Number.isInteger(inst?.app_id)) appId = Number(inst.app_id);
        else if (installs) noId = `the Releaser App \`${slug}\` is private and ${s.owner}'s installations list no installation of it, so its id, and with it its bypass, can't be looked for`;
        else {
          noId = `the Releaser App \`${slug}\` is private, so GitHub shows its id only in ${s.owner}'s App installations, which the token can't list (${listed.stderr.trim() || `exit ${listed.status}`}); apps-check can't print it, because it is the value of a secret the run's log masks. ${
            s.kind === 'Organization'
              ? `An owner of ${s.owner} runs doctor once with a token that holds the organisation's Administration permission (read) (docs/doctor.md, "The token it needs")`
              : 'On a personal account only a GitHub App\'s user token can list them, so check the bypass list yourself on the ruleset\'s page'
          }`;
        }
      }
      if (slug === undefined || appId === undefined) {
        unchecked.push({ check: 'ruleset-bypass', subject: s.defaultBranch, reason: noId ?? `the Releaser App ${slug ? `\`${slug}\` could not be read` : 'has no register row'}, so its bypass can't be looked for` });
      } else {
        const where = releaserBypass(s.covering, appId);
        for (const r of where.hidden) unchecked.push({ check: 'ruleset-bypass', subject: s.defaultBranch, reason: `the token can't see the bypass list of the ruleset "${r.name}" (only someone who can edit it can)` });
        for (const r of where.lacking) {
          find('ruleset.releaser-bypass-missing', s.defaultBranch, `The ruleset "${r.name}" on ${s.defaultBranch} does not list the Releaser App \`${slug}\` as a bypass actor; K-MERGE-8 makes it the only one, through pull requests only.`, {
            text: r.source_type === 'Organization' ? `Add the App to the organisation ruleset's bypass list, "For pull requests only".` : `Add it, through pull requests only, keeping the ruleset's other actors (kanon apps adds it when it creates the Releaser):`,
            commands: r.source_type === 'Organization' ? [] : bypassCommand(repo, r, [...r.bypass_actors, releaserActor(appId)]),
            url: rulesetUrl(repo, r),
          });
        }
        if (where.others.length && req.release?.dcoExemptsReleaser) {
          for (const r of [...new Set(where.others.map((o) => o.ruleset))]) {
            const extra = where.others.filter((o) => o.ruleset === r).map((o) => actorName(o.actor));
            find('ruleset.bypass-extra', s.defaultBranch, `The ruleset "${r.name}" on ${s.defaultBranch} lets ${extra.join(', ')} bypass it; K-MERGE-8 makes the Releaser App \`${slug}\` the only bypass actor. Kanon ${checked}'s dco check passes the Releaser's release PR (#337), so release PRs merge through the front door without it.`, {
              text: r.source_type === 'Organization' ? `Remove the other actors from the organisation ruleset's bypass list.` : `Leave the Releaser as the ruleset's only bypass actor, once your dco caller pins ${checked}:`,
              commands: r.source_type === 'Organization' ? [] : bypassCommand(repo, r, [releaserActor(appId)]),
              url: rulesetUrl(repo, r),
            });
          }
        } else if (where.others.length) {
          notes.push(`The ruleset on ${s.defaultBranch} lets ${where.others.map((o) => actorName(o.actor)).join(', ')} bypass it beside the Releaser. Keep that while you pin ${checked}: its dco check fails the Releaser's release PR (#337), and that bypass is what merges it.`);
        }
      }
    }
  }

  // ── A merge queue (#452) ────────────────────────────────────────────────────────────────────
  // A merge through the queue is pushed by the queue's bot, which a lane's gate turns away, so a
  // lane that starts on CI finishing on the default branch waits for its schedule. The release's
  // lane catalogue says so of each such lane; it blocks nothing.
  // A lane whose caller starts it on the merged pull request as well (kanon#484) has no such
  // sentence from a release that admits that trigger. Its caller still needs the trigger, which
  // an upgrade of the pin alone doesn't add, so a caller without it is noted, with what to add.
  if (mergeQueueOn(s.covering)) {
    for (const l of installed) {
      const said = req.catalogue?.lanes[l]?.mergeQueue;
      if (said) notes.push(`${s.defaultBranch} merges through a merge queue, and you call ${l}. ${said}`);
      else if (TRIGGERS[l]?.merged) {
        for (const file of [...new Set(callers.filter((c) => c.lane === l && !startsOnMerge(c.wf, s.defaultBranch)).map((c) => c.file))]) {
          notes.push(`${s.defaultBranch} merges through a merge queue, and ${file} calls ${l} without a trigger on a merged pull request, so a merge through the queue doesn't start it: the CI run on the merge is the queue's, which the lane's gate turns away. Add \`pull_request_target: { types: [closed], branches: [${s.defaultBranch}] }\` to its \`on:\`, as \`kanon init\` writes it (#484).`);
        }
      }
    }
  }

  // ── The telemetry collector (#428) ──────────────────────────────────────────────────────────
  // A caller of Kanon's collector sends nothing until the repository has the two variables the
  // Kanon operator gives it (docs/telemetry.md): the collector skips with a warning and stays
  // green, so nothing else would say so. Not blocking: no lane needs it. Variables the token
  // can't list are a note, not an unchecked check, for the same reason.
  const collector = req.telemetry?.collector;
  const collectorCallers = collector
    ? [...workflows].filter(([, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).some((j) => isMap(j) && kanonCall(j.uses)?.workflow === collector)).map(([f]) => f)
    : [];
  // A called workflow's job can only narrow its caller's grant, and GitHub refuses to start a run
  // whose called job asks for more (plan 0001 §3). So a caller whose permissions: lack what the
  // collector's job asks for at the checked release (`contents: read` since plan 0006 F4, to read
  // the record's upstream-findings level) would stop every sweep once the pin moves: named here,
  // as a lane caller's grant is.
  const telemetryGrant = req.telemetry?.grant ?? {};
  for (const file of collectorCallers) {
    const wf = /** @type {Record<string, any>} */ (workflows.get(file));
    for (const j of Object.values(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(j) || kanonCall(j.uses)?.workflow !== collector) continue;
      const grant = j.permissions !== undefined ? j.permissions : wf.permissions;
      const short = Object.entries(telemetryGrant).filter(([k, v]) => !isMap(grant) || level(grant[k]) < level(v));
      if (!short.length) continue;
      findItems('caller.grant-missing', file, short.map(([k]) => k), (xs) => {
        const some = short.filter(([k]) => xs.includes(k));
        return [`grants ${some.map(([k]) => `${k}: ${isMap(grant) ? grant[k] ?? 'none' : 'none'}`).join(', ')}; Kanon's telemetry collector needs ${some.map(([k, v]) => `${k}: ${v}`).join(', ')} at ${checked}, and GitHub refuses to start a run whose called job asks for more than its caller grants.`, {
          text: `Grant under the caller's permissions:`,
          commands: some.map(([k, v]) => `  ${k}: ${v}`),
        }];
      });
    }
  }
  if (collectorCallers.length) {
    const wanted = req.telemetry?.variables ?? [];
    const listed = await deps.gh(['variable', 'list', '-R', repo, '--json', 'name']);
    /** @type {Set<string> | null} */
    let have = null;
    try {
      if (listed.status === 0) have = new Set(JSON.parse(listed.stdout).map((/** @type {any} */ v) => String(v.name)));
    } catch {
      have = null;
    }
    if (!have) notes.push(`${collectorCallers.join(', ')} ${collectorCallers.length > 1 ? 'call' : 'calls'} Kanon's telemetry collector, and the token can't list ${repo}'s variables, so doctor can't tell whether ${wanted.join(' and ')} are set; until both are, it sends nothing (docs/telemetry.md).`);
    else {
      const unset = wanted.filter((v) => !have?.has(v));
      if (unset.length) {
        for (const file of collectorCallers) {
          findItems('telemetry.unconfigured', file, unset, (xs) => {
            const fix = telemetryStep(repo, xs, true);
            return [`calls Kanon's telemetry collector, and ${repo} doesn't set ${xs.join(' or ')}, so it sends nothing: the collector skips with a warning and stays green.`, { text: fix.text, commands: fix.commands, url: fix.url }];
          });
        }
      }
    }
  }

  // ── The backlog feeder (#609) ─────────────────────────────────────────────────────────────
  // Where a caller runs a dispatch sweep that feeds the backlog at the checked release, the state
  // of its valve, as a note: unset is the feeder's default, off, and no finding.
  const feeders = callers.filter((c) => req.lanes[c.lane]?.optionalVariables?.includes(BACKLOG_FEED)).map((c) => c.file);
  if (feeders.length) {
    const listed = await deps.gh(['variable', 'list', '-R', repo, '--json', 'name,value']);
    /** @type {Map<string, string> | null} */
    let vars = null;
    try {
      if (listed.status === 0) vars = new Map(JSON.parse(listed.stdout).map((/** @type {any} */ v) => [String(v.name), String(v.value ?? '')]));
    } catch {
      vars = null;
    }
    notes.push(backlogFeedNote(feeders, vars, repo));
  }

  // ── The id-token holders ────────────────────────────────────────────────────────────────────
  const record = readHolderAcceptances(read(ADOPTION_RECORD));
  for (const e of record.errors) find('declaration.malformed', ADOPTION_RECORD, e, { text: `Write each acceptance under ## Choices as \`- **${HOLDER_LABEL}:** \`<workflow>.yml\` job \`<job>\` (<why it holds the grant>)\` (K-LAYOUT-10).` });
  /** @type {Holder[]} */
  const holders = [];
  const used = new Set();
  for (const [file, wf] of workflows) {
    for (const [job, j] of Object.entries(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(j)) continue;
      const g = idTokenGrant(wf, j);
      if (!g) continue;
      const calls = typeof j.uses === 'string' ? j.uses.trim() : null;
      const call = kanonCall(calls);
      const base = file.slice('.github/workflows/'.length);
      const key = `${base}#${job}`;
      const reason = record.accepted.get(key) ?? null;
      if (reason !== null) used.add(key);
      /** @type {Holder['status']} */
      let status = reason !== null ? 'accepted' : 'unaccepted';
      if (call && call.ref === pinned && req.lanes[call.workflow]?.grant['id-token'] === 'write') status = 'kanon-lane';
      // Kanon's telemetry collector (#428): its one job that holds the grant is held by Kanon's
      // id-token guard, as a store-coupled lane's store jobs are.
      if (call && call.ref === pinned && req.telemetry && call.workflow === req.telemetry.collector) status = 'kanon-lane';
      holders.push({ workflow: file, job, grant: g.from, how: g.how, calls, status, reason: status === 'kanon-lane' ? null : reason });
      if (status === 'unaccepted') {
        const source = `${g.how === 'write-all' ? 'permissions: write-all' : 'id-token: write'} ${g.from === 'job' ? 'in its own permissions' : "inherited from the workflow's permissions"}`;
        find('id-token.unaccepted', `${file}#${job}`, `The job ${job} of ${file} holds ${source}${calls ? `, and passes it to ${calls}` : ''}. On ${s.defaultBranch} it can assume the QA store's role and the telemetry writer, which trust the default branch's ref.`, {
          text: `Narrow its grant${g.from === 'workflow' ? ' (give the job a permissions: of its own without id-token)' : ''}, or accept it under ## Choices in ${ADOPTION_RECORD}, with the reason it holds the grant:`,
          commands: [`- **${HOLDER_LABEL}:** \`${base}\` job \`${job}\` (<why it holds the grant>)`],
        });
      }
    }
  }
  for (const key of record.accepted.keys()) {
    if (used.has(key) || unchecked.some((u) => u.check === 'workflow' && u.subject === `.github/workflows/${key.split('#')[0]}`)) continue;
    const [wfFile, job] = key.split('#');
    find('id-token.stale-acceptance', ADOPTION_RECORD, `accepts ${wfFile}'s job ${job} as an id-token holder, but no such job holds the grant.`, { text: `Remove the bullet, so the record says only what is true.` });
  }
  // ── Where the Overseer's upstream findings go (`K-LAYOUT-10`, kanon#423) ──────────────────────
  // The lane reads it from the default branch and stops before its agent on a malformed one; this
  // names it first, from the checkout, as lane-check does.
  const recordText = read(ADOPTION_RECORD);
  if (recordText !== null) {
    try {
      parseUpstreamFindings(recordText);
      // `sent` and `sent with evidence` travel over the telemetry channel (plan 0006 §3.1): with
      // no caller of Kanon's collector, nothing is sent, so the record says what isn't true.
      const unsent = unsentMessage(recordText, collectorCallers.length > 0);
      if (unsent) {
        find('upstream.unsent', ADOPTION_RECORD, unsent, {
          text: `Opt in to telemetry, which writes the collector's caller: run \`kanon init --telemetry\` (docs/telemetry.md). Or choose \`drafted\`, which drafts each upstream finding and sends nothing: write this bullet in its place, or remove it for Kanon's default (K-LAYOUT-10).`,
          commands: [`- **${UPSTREAM_LABEL}:** \`drafted\``],
        });
      }
    } catch (e) {
      find('declaration.malformed', ADOPTION_RECORD, /** @type {Error} */ (e).message, { text: 'Write it under ## Choices as `- **Upstream findings:** `filed here`` or `drafted`, `sent` or `sent with evidence`, or remove it for Kanon\'s default, `drafted` (K-LAYOUT-10).' });
    }
    // ── Whether the Overseer runs the capability watch (`K-LAYOUT-10`, kanon#477) ─────────────────
    try {
      parseCapabilityWatch(recordText);
    } catch (e) {
      find('declaration.malformed', ADOPTION_RECORD, /** @type {Error} */ (e).message, { text: 'Write it under ## Choices as `- **Capability watch:** `on`` or `off`, or remove it for Kanon\'s default, `off` (K-LAYOUT-10).' });
    }
  }
  // ── The waivers ─────────────────────────────────────────────────────────────────────────────
  // Last, over every finding: one bullet waives one id on one subject, as doctor reported it.
  const waiverRecord = readWaivers(read(ADOPTION_RECORD));
  for (const e of waiverRecord.errors) find('declaration.malformed', ADOPTION_RECORD, e, { text: `Write each waiver under ## Choices as \`- **${WAIVER_LABEL}:** \`<finding id>\` on \`<subject>\` (<why the finding stands>)\`, for a finding that can be waived; for one that lists items, name those it waives before the parentheses, \`for \`<item>\`, \`<item>\`\` (docs/doctor.md).` });
  /** @type {Waived[]} */
  const waived = [];
  const spans = (/** @type {string[]} */ xs) => xs.map((x) => `\`${x}\``).join(', ');
  /** @type {Map<string, typeof waiverRecord.waivers>} the bullets of each finding id on each subject */
  const groups = new Map();
  for (const w of waiverRecord.waivers) groups.set(`${w.id} ${w.subject}`, [...(groups.get(`${w.id} ${w.subject}`) ?? []), w]);
  for (const ws of groups.values()) {
    const { id, subject } = /** @type {(typeof ws)[number]} */ (ws[0]);
    const hits = findings.filter((f) => f.id === id && f.subject === subject);
    const category = /** @type {{ category: string }} */ (FINDINGS[id]).category;
    const blind = unchecked.find((u) => u.subject === subject || UNCHECKED_CATEGORY[u.check] === category);
    if (!ITEMIZED[id]) {
      // A finding that lists no items: its one bullet waives it whole.
      const w = /** @type {(typeof ws)[number]} */ (ws[0]);
      for (const f of hits) {
        findings.splice(findings.indexOf(f), 1);
        waived.push({ ...f, items: [], line: w.line, reason: w.reason });
      }
      if (hits.length) continue;
      if (blind) notes.push(`${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject}, which doctor did not report; the ${blind.check} check could not run, so it can't tell whether the waiver is still needed.`);
      else find('waiver.stale', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject}, but doctor reports no such finding.`, { text: `Remove the bullet, so the record says only what is true.` });
      continue;
    }
    // A finding that lists items: each bullet waives the items it names, and an item none names
    // stays a finding. A bullet that names none would waive what a later release adds too, so it
    // is malformed and waives nothing; its fix is the bullet to write, from today's items.
    const named = ws.filter((w) => w.items);
    const claimed = new Set(named.flatMap((w) => w.items ?? []));
    const today = [...new Set(hits.flatMap((f) => itemized.get(f)?.items ?? []))].filter((x) => !claimed.has(x));
    for (const w of ws.filter((x) => !x.items)) {
      find('declaration.malformed', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} without naming its items, so it would waive whatever a later release adds to that finding too; it waives nothing until it names them (#406). ${today.length ? `Doctor reports ${today.join(', ')} there today${named.length ? ', besides what the other bullets name' : ''}.` : `Doctor reports no item there today${named.length ? ' that the other bullets don\'t name' : ''}.`}`, today.length
        ? { text: `Name the items the repository keeps after \`for\`, as doctor reports them today, and drop any it doesn't keep (docs/doctor.md, "Waiving a finding"):`, commands: [`- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` for ${spans(today)} (${w.reason})`] }
        : { text: `Remove the bullet, or name the items it keeps after \`for\` (docs/doctor.md, "Waiving a finding"):`, commands: [`- **${WAIVER_LABEL}:** \`${id}\` on \`${subject}\` for \`<item>\` (${w.reason})`] });
    }
    /** @type {Map<(typeof ws)[number], Set<string>>} */
    const covered = new Map(named.map((w) => [w, new Set()]));
    for (const f of hits) {
      const items = itemized.get(f)?.items ?? [];
      const takes = /** @type {Array<[(typeof ws)[number], string[]]>} */ (named.map((w) => [w, items.filter((x) => w.items?.includes(x))])).filter(([, t]) => t.length);
      if (!takes.length) continue;
      const keep = items.filter((x) => !claimed.has(x));
      const at = findings.indexOf(f);
      if (keep.length) {
        const rest = remake(f, keep);
        findings.splice(at, 1, { ...rest, message: `${rest.message} ${takes.map(([w, t]) => `${ADOPTION_RECORD}:${w.line} waives ${t.join(', ')}`).join('; ')}, not ${keep.length > 1 ? 'these' : 'this'}.` });
      } else findings.splice(at, 1);
      for (const [w, t] of takes) {
        for (const x of t) covered.get(w)?.add(x);
        waived.push({ ...remake(f, t), items: t, line: w.line, reason: w.reason });
      }
    }
    for (const w of named) {
      const got = /** @type {Set<string>} */ (covered.get(w));
      const gone = (w.items ?? []).filter((x) => !got.has(x));
      if (!gone.length) continue;
      if (blind) notes.push(`${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} for ${gone.join(', ')}, which doctor did not report; the ${blind.check} check could not run, so it can't tell whether the waiver is still needed.`);
      else if (got.size) find('waiver.stale', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} for ${gone.join(', ')}, but doctor reports no such ${gone.length > 1 ? 'items' : 'item'} there.`, { text: `Remove ${spans(gone)} from the bullet, so the record says only what is true.` });
      else find('waiver.stale', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${id} on ${subject} for ${gone.join(', ')}, but doctor reports ${hits.length ? `none of ${gone.length > 1 ? 'them' : 'it'} there` : 'no such finding'}.`, { text: `Remove the bullet, so the record says only what is true.` });
    }
  }

  if (branchName !== s.defaultBranch) notes.push(`The id-token holders and the secrets the workflows map are counted on ${onCheckout}, not on ${s.defaultBranch}; the roles trust ${s.defaultBranch}'s jobs, and its workflows are the ones that run, so run it there for their count.`);

  findings.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  waived.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  const blocking = findings.some((f) => f.blocking);
  const status = blocking ? 'findings' : unchecked.length ? 'incomplete' : 'healthy';
  return {
    report: {
      schema: SCHEMA,
      kanon: deps.release(),
      repository: repo,
      checkout: { branch: branchName, defaultBranch: s.defaultBranch, head: head.status === 0 ? head.stdout.trim() : null },
      token: { source: who.source, login: who.login },
      releases: { pins: [...pins.keys()].sort(newer), pinned, to: opts.to, checked },
      checking,
      status,
      exitCode: EXIT[status],
      lanes: installed,
      apps: identities.map((id) => ({ identity: id, slug: slugOf.get(id) ?? null })),
      findings,
      waived,
      idTokenHolders: holders,
      unchecked,
      notes,
    },
  };
};

/**
 * THE REQUIRED CHECK'S JOB (#418, L5's G14). A ruleset that requires a status check no job on the
 * default branch reports blocks every pull request but the one that adds the job, approved and
 * green, until that one merges. So before doctor asks the person to require Kanon's check
 * (`ruleset.rule-missing`), a workflow on the default branch must report it on every pull request
 * into that branch, with no trigger filter that skips one (#446); otherwise it asks
 * for the job first, and for the rule only once the job has merged. It asks the same of a ruleset
 * that requires the check already. A job only the checkout has is not on the default branch: it
 * is a branch's, and the rule waits for its merge. Returns the ruleset's gaps still to ask for.
 * @param {{ deps: Deps, repo: string, s: Inspection, checked: string, gaps: string[],
 *   checkout: Map<string, Record<string, any>>,
 *   find: (id: string, subject: string, message: string, fix: { text: string, commands?: string[], url?: string | null }) => void,
 *   unchecked: Array<{ check: string, subject: string, reason: string }> }} c
 * @returns {Promise<string[]>}
 */
const checkGaps = async ({ deps, repo, s, checked, gaps, checkout, find, unchecked }) => {
  const gap = requiredCheckGap(LANE_CHECK);
  const required = !gaps.includes(gap);
  const rest = gaps.filter((g) => g !== gap);
  const onDefault = await branchWorkflows(deps, repo, s.defaultBranch);
  if (onDefault.error !== null) {
    unchecked.push({ check: 'required-check', subject: LANE_CHECK, reason: `could not read the workflows on ${s.defaultBranch} (${onDefault.error}), so doctor can't tell whether a job there reports the status check "${LANE_CHECK}"${required ? '' : ", and doesn't ask you to require it yet"}` });
    return rest;
  }
  // With a merge queue, the queue waits for the check on its own `merge_group` run, so the job must
  // run on that event as well (#459).
  const queue = mergeQueueOn(s.covering);
  const jobs = checkJobs(onDefault.workflows, LANE_CHECK, s.defaultBranch, queue);
  if (jobs.some((j) => !j.filters.length && !j.missing.length)) return gaps;
  const here = checkReporters(checkout, LANE_CHECK, s.defaultBranch, queue);
  const every = queue ? 'every pull request and every queued merge' : 'every pull request';
  const then = required ? 'Until it merges, every other pull request waits on the check.' : `Then require the check: doctor asks for it (ruleset.rule-missing) once the job is on ${s.defaultBranch}.`;
  // A job whose workflow skips some pull requests (#446): GitHub never reports the check on one
  // it skips, so that pull request waits on the check once it is required.
  const filters = [...new Set(jobs.flatMap((j) => j.filters))];
  const filtered = jobs.filter((j) => j.filters.length);
  const skipping = filtered.length ? ` The ${queue ? '' : 'only '}job${filtered.length > 1 ? 's' : ''} there that report${filtered.length > 1 ? '' : 's'} it (${filtered.map((j) => j.job).join(', ')}) run${filtered.length > 1 ? '' : 's'} on some ${queue ? 'runs' : 'pull requests'} only (${filters.join(', ')}), and a ${queue ? 'run' : 'pull request'} ${filtered.length > 1 ? 'they skip' : 'it skips'} never gets the check.` : '';
  // A job whose workflow doesn't run on the merge queue's event (#459).
  const unqueued = jobs.filter((j) => j.missing.length).map((j) => j.job);
  const lacking = unqueued.length ? ` ${unqueued.join(', ')} ${unqueued.length > 1 ? "don't" : "doesn't"} run on merge_group, the event the merge queue on ${s.defaultBranch} runs its checks on, so a queued merge never gets the check and waits on it.` : '';
  const workflowsOf = (/** @type {string[]} */ list) => [...new Set(list.map((j) => j.split('#')[0]))].join(', ');
  const fixes = [...(filters.length ? [`take ${filters.join(', ')} off the workflow's trigger`] : []), ...(unqueued.length ? [`add merge_group to the triggers of ${workflowsOf(unqueued)}`] : [])];
  find('ruleset.check-unreported', LANE_CHECK, required
    ? `The ruleset on ${s.defaultBranch} requires the status check "${LANE_CHECK}", but no job of a workflow on ${s.defaultBranch} reports it on ${every}, so every ${queue ? 'one' : 'pull request'} that doesn't get it waits on it (K-ADOPT-1 step 8).${skipping}${lacking}`
    : `No job of a workflow on ${s.defaultBranch} reports the status check "${LANE_CHECK}" on ${every}, so the ruleset can't require it yet: a required check that nothing reports blocks every pull request (K-ADOPT-1 step 8).${skipping}${lacking}`, {
    text: here.length
      ? `This checkout adds it (${here.join(', ')}): merge the pull request that adds it to ${s.defaultBranch} first. ${then}`
      : jobs.length
        ? `Run the job on ${every}: ${fixes.join(', and ')}, or move the job to a workflow of its own on pull_request${queue ? ' and merge_group' : ''} with no filter, as actions/lane-check's README shows, and merge it. ${then}`
        : `Add a job of its own named "${LANE_CHECK}", in a workflow that runs on pull_request${queue ? ' and merge_group' : ''}, as actions/lane-check's README shows (a step in another job reports nothing under that name), and merge it. ${then}`,
    url: `https://github.com/${KANON_REPO}/blob/${checked}/actions/lane-check/README.md`,
  });
  return rest;
};

/** @typedef {Extract<Awaited<ReturnType<typeof diagnose>>, { report: any }>['report']} Report */

const TITLES = /** @type {Record<string, string>} */ ({ pin: 'Pin', app: 'App', secret: 'Secret', declaration: 'Declaration', caller: 'Caller', label: 'Label', ruleset: 'Ruleset', 'id-token': 'id-token' });

/**
 * The report as prose for a person.
 * @param {Report} r
 * @returns {string[]}
 */
export const prose = (r) => {
  const out = [];
  out.push(`Using ${r.token.source === 'gh' ? "gh's stored login" : `the token in ${r.token.source}`}${r.token.login ? `, which belongs to ${r.token.login}` : ''}.`);
  out.push('');
  out.push(`== ${r.repository}: Kanon ${r.releases.pinned} pinned${r.releases.to ? `, checked against ${r.releases.to}` : ''} ==`);
  out.push(`- Lanes called: ${r.lanes.length ? r.lanes.join(', ') : 'none'}.`);
  out.push(`- Apps they run as: ${r.apps.length ? r.apps.map((a) => `${a.identity} (${a.slug ? `\`${a.slug}\`` : 'not in the register'})`).join(', ') : 'none'}.`);
  out.push('');
  if (!r.findings.length) out.push(`Nothing is missing or stale for ${r.checking}.`);
  else {
    out.push(`What ${r.checking} needs, in the order to do it:`);
    r.findings.forEach((f, i) => {
      out.push(`${i + 1}. [${TITLES[f.category] ?? f.category}${f.blocking ? '' : ', not blocking'}] ${f.subject}: ${f.message}`);
      out.push(`   Fix: ${f.fix.text}`);
      if (f.fix.url) out.push(`   ${f.fix.url}`);
      for (const c of f.fix.commands) out.push(`     ${c}`);
    });
  }
  if (r.waived.length) {
    out.push('');
    out.push(`Waived under ## Choices in ${ADOPTION_RECORD}, so they don't count:`);
    for (const w of r.waived) out.push(`- [${TITLES[w.category] ?? w.category}] ${w.id}, ${w.subject}${w.items.length ? ` (${w.items.join(', ')})` : ''}, by ${ADOPTION_RECORD}:${w.line}: ${w.reason}.`);
  }
  out.push('');
  if (!r.idTokenHolders.length) out.push('No job of your workflows holds id-token: write.');
  else {
    out.push('Jobs of your workflows that hold id-token: write:');
    for (const h of r.idTokenHolders) {
      const how = `${h.how === 'write-all' ? 'write-all' : 'id-token: write'}, ${h.grant === 'job' ? 'its own grant' : "the workflow's"}${h.calls ? `, passed to ${h.calls}` : ''}`;
      const verdict = h.status === 'kanon-lane' ? "Kanon's store-coupled lane at the pinned release: accepted" : h.status === 'accepted' ? `accepted in the adoption record: ${h.reason}` : 'NOT ACCEPTED: narrow it, or accept it in the adoption record';
      out.push(`- ${h.workflow}, job ${h.job} (${how}): ${verdict}.`);
    }
  }
  if (r.unchecked.length) {
    out.push('');
    out.push('Not checked:');
    for (const u of r.unchecked) out.push(`- ${u.check}, ${u.subject}: ${u.reason}.`);
  }
  if (r.notes.length) {
    out.push('');
    for (const n of r.notes) out.push(`Note: ${n}`);
  }
  out.push('');
  const blocking = r.findings.filter((f) => f.blocking).length;
  const waivedToo = r.waived.length ? ` ${r.waived.length} finding(s) waived in ${ADOPTION_RECORD}.` : '';
  out.push(
    (r.status === 'healthy'
      ? 'Healthy. doctor wrote nothing.'
      : r.status === 'incomplete'
        ? `Nothing blocking found, but ${r.unchecked.length} check(s) could not run, so health can't be claimed (exit ${r.exitCode}). doctor wrote nothing.`
        : `${blocking} blocking finding(s)${r.findings.length > blocking ? `, ${r.findings.length - blocking} not blocking` : ''} (exit ${r.exitCode}). doctor wrote nothing; kanon init fixes what it can from the checkout.`) + waivedToo,
  );
  return out;
};
