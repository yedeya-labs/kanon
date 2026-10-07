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
// that matches no finding is listed as stale, and one in another shape is malformed.
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
import { readResult } from './apps-check.mjs';
import { checkoutCheck, REGISTER_PATH, remoteRepo } from './apps.mjs';
import { appSecrets, kanonRelease, loadRequirements } from './callers.mjs';
import { whoami } from './gh-token.mjs';
import { appsArgs, inspect, LANE_CHECK, registerRolesOf, registerRows, requiredCheckGap, rulesetGaps, RULESET_NAME, telemetryStep } from './init.mjs';
import { actorName, bypassCommand, releaserActor, releaserBypass, rulesetUrl } from './ruleset-bypass.mjs';
import { readPluginDeclaration, SETTINGS_PATH } from './plugin.mjs';
import { parseYaml } from './workflow-yaml.mjs';
import { parseUpstreamFindings } from '../scripts/lib/upstream-findings.mjs';

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
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--to') opts.to = value();
    else if (flag === '--json') opts.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
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
 * Each names one finding id, one subject exactly as doctor reports it, and the reason. A bullet in
 * another shape, outside `## Choices`, with no reason, naming an id doctor doesn't report or one
 * it doesn't waive (`UNWAIVABLE`), or waiving the same finding twice, is returned as an error
 * naming its line.
 * @param {string | null} text
 * @returns {{ waivers: Array<{ id: string, subject: string, reason: string, line: number }>, errors: string[] }}
 */
export const readWaivers = (text) => {
  /** @type {Array<{ id: string, subject: string, reason: string, line: number }>} */
  const waivers = [];
  /** @type {string[]} */
  const errors = [];
  if (!text) return { waivers, errors };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  const mention = new RegExp(`^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)?\\*\\*${WAIVER_LABEL}:\\*\\*`, 'i');
  const entry = new RegExp(`^[-*] \\*\\*${WAIVER_LABEL}:\\*\\* \`([^\`\\s]+)\` on \`([^\`]*\\S[^\`]*)\` \\((.*\\S.*)\\)\\s*$`);
  let section = '';
  lines.forEach((line, i) => {
    if (inFence.has(i)) return;
    if (/^#{1,6} /.test(line)) section = line.trimEnd();
    if (!mention.test(line)) return;
    const m = entry.exec(line);
    const where = `${ADOPTION_RECORD}:${i + 1}`;
    if (!m) return errors.push(`${where} is not \`- **${WAIVER_LABEL}:** \`<finding id>\` on \`<subject>\` (<why the finding stands>)\``);
    if (section !== '## Choices') return errors.push(`${where} waives a finding outside \`## Choices\``);
    const [id, subject, reason] = [/** @type {string} */ (m[1]), /** @type {string} */ (m[2]), /** @type {string} */ (m[3]).trim()];
    if (!FINDINGS[id]) return errors.push(`${where} waives \`${id}\`, which is no finding doctor reports`);
    if (UNWAIVABLE[id]) return errors.push(`${where} waives \`${id}\`, which can't be waived: ${UNWAIVABLE[id]}`);
    if (waivers.some((w) => w.id === id && w.subject === subject)) return errors.push(`${where} waives \`${id}\` on \`${subject}\` a second time`);
    waivers.push({ id, subject, reason, line: i + 1 });
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
 * The secrets a workflow maps into its jobs: each name an expression reads as `secrets.<NAME>` or
 * `secrets['<NAME>']` anywhere outside its `on:` (where a reusable workflow declares the secrets
 * it takes, which reads none), upper-cased as GitHub stores them; and the jobs that pass on every
 * secret with `secrets: inherit`. Whatever a job calls, a lane, the release workflow by any path,
 * or nothing, its secrets count (#414).
 * @param {Record<string, any>} wf
 */
export const secretReads = (wf) => {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {unknown} v */
  const walk = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(/(?<![\w.])secrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\])/g)) names.add(/** @type {string} */ (m[1] ?? m[2]).toUpperCase());
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isMap(v)) Object.values(v).forEach(walk);
  };
  for (const [k, v] of Object.entries(wf)) if (k !== 'on') walk(v);
  const inherits = Object.entries(isMap(wf.jobs) ? wf.jobs : {}).filter(([, j]) => isMap(j) && j.secrets === 'inherit').map(([n]) => n);
  return { names, inherits };
};

/** The headings a document holds exactly once outside a fence, and how often each appears. @param {string} text @param {string} heading */
const headingCount = (text, heading) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inFence = fenced(lines);
  return lines.filter((l, i) => !inFence.has(i) && l === heading).length;
};

// ── The jobs that report a status check (#418) ──────────────────────────────────────────────

/** The events on which a workflow's jobs report their checks on a pull request. */
const PR_EVENTS = ['pull_request', 'pull_request_target'];

/** Whether a workflow runs on a pull request. @param {Record<string, any>} wf */
const onPullRequest = (wf) => {
  const on = wf.on;
  if (typeof on === 'string') return PR_EVENTS.includes(on);
  if (Array.isArray(on)) return on.some((e) => PR_EVENTS.includes(e));
  return isMap(on) && PR_EVENTS.some((e) => e in on);
};

/**
 * The jobs that report the status check `check` on a pull request: in a workflow that runs on
 * one, a job whose name, or its key when it has none, is exactly the check's. A job that calls a
 * reusable workflow reports `<its name> / <the called job's>`, and a matrix job its name with the
 * matrix's values, so neither counts: actions/lane-check's README runs the check as a job of its
 * own. A step of another job reports nothing under its own name (L5's G14).
 * @param {Map<string, Record<string, any>>} workflows by path @param {string} check
 * @returns {string[]} `<workflow file>#<job>`
 */
export const checkReporters = (workflows, check) => {
  /** @type {string[]} */
  const out = [];
  for (const [file, wf] of workflows) {
    if (!onPullRequest(wf)) continue;
    for (const [key, job] of Object.entries(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(job) || job.uses !== undefined || (isMap(job.strategy) && job.strategy.matrix !== undefined)) continue;
      if ((job.name === undefined || job.name === null ? key : String(job.name)) === check) out.push(`${file}#${key}`);
    }
  }
  return out;
};

/** One read of every workflow file on a branch, with its text. */
const BRANCH_WORKFLOWS = 'query($owner: String!, $name: String!, $expression: String!) { repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Tree { entries { name type object { ... on Blob { text } } } } } } }';

/**
 * The workflows on the default branch, read from GitHub rather than the checkout: a job that
 * only a branch adds reports its check on that branch's pull request, and on no other (#418).
 * One GraphQL query, sent on standard input. A file that doesn't parse is left out: the
 * checkout's own read says so.
 * @param {Deps} deps @param {string} repo @param {string} branch
 * @returns {Promise<{ workflows: Map<string, Record<string, any>>, error: null } | { workflows: null, error: string }>}
 */
export const branchWorkflows = async (deps, repo, branch) => {
  const [owner, name] = repo.split('/');
  const r = await deps.gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query: BRANCH_WORKFLOWS, variables: { owner, name, expression: `${branch}:.github/workflows` } }));
  if (r.status !== 0) return { workflows: null, error: r.stderr.trim() || `exit ${r.status}` };
  /** @type {any[]} */
  let entries;
  try {
    const j = JSON.parse(r.stdout);
    if (Array.isArray(j?.errors) && j.errors.length) return { workflows: null, error: String(j.errors[0]?.message ?? 'GraphQL error') };
    if (!isMap(j?.data?.repository)) return { workflows: null, error: 'GitHub returned no repository' };
    entries = j.data.repository.object?.entries ?? [];
  } catch {
    return { workflows: null, error: "GitHub's answer was not JSON" };
  }
  /** @type {Map<string, Record<string, any>>} */
  const workflows = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e?.type !== 'blob' || !/\.ya?ml$/.test(String(e.name)) || typeof e.object?.text !== 'string') continue;
    try {
      const doc = parseYaml(e.object.text);
      if (isMap(doc)) workflows.set(`.github/workflows/${e.name}`, doc);
    } catch {
      // Left out, as above.
    }
  }
  return { workflows, error: null };
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
 * @typedef {Finding & { reason: string }} Waived
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
  const result = await diagnose(deps, opts);
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
  /** @type {Array<{ file: string, job: Record<string, any> }>} */
  const releaseCallers = [];
  for (const [file, wf] of workflows) {
    for (const [jobName, job] of Object.entries(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(job)) continue;
      const call = kanonCall(job.uses);
      if (!call) continue;
      if (call.workflow === 'apps-check') appsCheckCallers.push({ file, job });
      else if (call.workflow === 'release') releaseCallers.push({ file, job });
      else if (call.workflow.startsWith('agent-') && call.workflow !== 'agent-lane') callers.push({ file, wf, jobName, job, lane: call.workflow });
    }
  }
  const installed = [...new Set(callers.map((c) => c.lane))].filter((l) => req.lanes[l]).sort();

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
      const missing = want.filter((n) => !got.includes(n));
      const stale = got.filter((n) => !want.includes(n));
      if (missing.length) {
        find('caller.secret-missing', c.file, `does not map ${missing.join(', ')}, which the lane ${c.lane} takes at ${checked}.`, {
          text: `Add under the job's secrets:`,
          commands: missing.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        });
      }
      if (stale.length) {
        find('caller.secret-stale', c.file, `maps ${stale.join(', ')}, which the lane ${c.lane} does not take at ${checked}; GitHub refuses a call that passes a secret the called workflow does not declare.`, {
          text: `Remove these lines from the job's secrets:`,
          commands: stale.map((n) => `      ${n}: \${{ secrets.${n} }}`),
        });
      }
    }
    const stale = Object.keys(isMap(c.job.with) ? c.job.with : {}).filter((k) => !spec.inputs[k]);
    if (stale.length) {
      find('caller.input-stale', c.file, `passes ${stale.join(', ')}, which the lane ${c.lane} does not declare at ${checked}.`, { text: `Remove ${stale.map((k) => `\`${k}\``).join(', ')} from the job's with:, and the dispatch input${stale.length > 1 ? 's' : ''} that feed${stale.length > 1 ? '' : 's'} ${stale.length > 1 ? 'them' : 'it'}.` });
    }
    const grant = c.job.permissions !== undefined ? c.job.permissions : c.wf.permissions;
    const short = Object.entries(spec.grant).filter(([k, v]) => !isMap(grant) || level(grant[k]) < level(v));
    if (short.length) {
      find('caller.grant-missing', c.file, isMap(grant)
        ? `grants ${short.map(([k]) => `${k}: ${grant[k] ?? 'none'}`).join(', ')}; the lane ${c.lane} needs ${short.map(([k, v]) => `${k}: ${v}`).join(', ')} at ${checked}.`
        : grant === undefined
          ? `grants no explicit permissions; the calling job's permissions: are the lane ${c.lane}'s ceiling (plan 0001 §3).`
          : `grants \`permissions: ${String(grant)}\` rather than a map; the calling job's permissions: are the lane ${c.lane}'s ceiling, so lane-check requires the lane's grant written out (plan 0001 §3).`, {
        text: isMap(grant) ? `Grant under the caller's permissions:` : `Replace the caller's permissions: with the lane's grant:`,
        commands: isMap(grant) ? short.map(([k, v]) => `  ${k}: ${v}`) : ['permissions:', ...Object.entries(spec.grant).map(([k, v]) => `  ${k}: ${v}`)],
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
      find('register.missing-row', REGISTER_PATH, `lists no ${missingRows.join(', ')} row, which the ${id} App's lanes read their App slug from (K-LAYOUT-6).`, {
        text: slugs.length === 1
          ? `Add the row${missingRows.length > 1 ? 's' : ''} naming the ${id} App's slug \`${slugs[0]}\`, or let kanon apps write them, and commit the register.`
          : `Create the ${id} App from this checkout, and commit the register rows it writes.`,
        commands: slugs.length === 1 ? [] : [apps],
      });
    }
    if (slugs.length > 1) {
      find('register.split-slug', REGISTER_PATH, `names more than one App for the ${id} App's roles (${roles.map((r) => `${r}: ${rows.get(r) ?? 'none'}`).join(', ')}); since plan 0005 each App's roles share one slug (§3.4).`, {
        text: `Create the ${id} App, or reuse the owner's, and point each of its roles' rows at its slug; then commit the register.`,
        commands: [apps],
      });
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
  // Actions: read. Only the latest completed run on the default branch counts: its workflow is
  // the reviewed one, and an older run may predate a change.
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
      const runs = await deps.gh(['api', `repos/${repo}/actions/workflows/${appsCheckName}/runs?branch=${encodeURIComponent(s.defaultBranch)}&status=completed&per_page=1`]);
      const list = ghJsonOf(runs)?.workflow_runs;
      if (!Array.isArray(list)) return { reason: `the token can't list ${appsCheckName}'s runs, which needs Actions: read (${runs.stderr.trim() || `exit ${runs.status}`})` };
      const run = list[0];
      if (!isMap(run)) return { reason: `${appsCheckName} has no completed run on ${s.defaultBranch}: ${runAppsCheck}` };
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
    if (!result) return { reason: `${when} printed no result for the ${id} App, as an apps-check from before #417 doesn't, nor one that couldn't mint the App's token: ${runAppsCheck}` };
    if (result.slug !== slug) return { reason: `${when} checked the App \`${result.slug}\` as the ${id} App, but the register names \`${slug}\`: ${runAppsCheck}` };
    return { result, when };
  };

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
      app = { id: found.result.appId, permissions: found.result.permissions };
      notes.push(`GitHub shows the ${id} App \`${slug}\` only to itself, so its permissions are its installation's, as ${found.when} found them; run apps-check again after you change them.`);
    }
    if (Number.isInteger(app.id)) appIdOf.set(id, Number(app.id));
    const have = /** @type {Record<string, string>} */ (app.permissions);
    const ownerLogin = String(app.owner?.login ?? s.owner);
    const url = app.owner?.type === 'Organization' || (!app.owner && s.kind === 'Organization') ? `https://github.com/organizations/${ownerLogin}/settings/apps/${slug}/permissions` : `https://github.com/settings/apps/${slug}/permissions`;
    const missing = Object.entries(need).filter(([k, v]) => level(have[k]) < level(v));
    const extra = Object.entries(have).filter(([k, v]) => level(v) > level(need[k]));
    if (missing.length) {
      find('app.permission-missing', slug, `The ${id} App \`${slug}\` holds ${missing.map(([k]) => `${k}: ${have[k] ?? 'none'}`).join(', ')}; Kanon ${checked} needs ${missing.map(([k, v]) => `${k}: ${v}`).join(', ')}.`, {
        text: `Widen the App's permissions on its settings page, then accept the new permissions on its installation (GitHub asks the installation's owner), and run your apps-check caller.`,
        url,
      });
    }
    if (extra.length) {
      find('app.permission-extra', slug, `The ${id} App \`${slug}\` holds ${extra.map(([k, v]) => `${k}: ${v}`).join(', ')}, beyond what Kanon ${checked} grants it (${extra.map(([k]) => `${k}: ${need[k] ?? 'none'}`).join(', ')}). Each lane narrows its token to what it uses (K-AGENT-46), so this blocks nothing, but the App holds more than it needs (K-ADOPT-8).`, {
        text: `Narrow the App's permissions on its settings page.`,
        url,
      });
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
    const listed = await deps.gh(['api', s.kind === 'Organization' ? `orgs/${s.owner}/installations?per_page=100` : 'user/installations?per_page=100']);
    /** @type {any[] | null} */
    const installs = (() => {
      try {
        const j = listed.status === 0 ? JSON.parse(listed.stdout) : null;
        return Array.isArray(j?.installations) ? j.installations : null;
      } catch {
        return null;
      }
    })();
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
        const inst = installs.find((i) => i?.app_slug === slug && String(i?.account?.login ?? '').toLowerCase() === s.owner.toLowerCase());
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
  const needSecrets = [...new Set([...installed.flatMap((l) => req.lanes[l]?.secrets ?? []), ...(identities.includes('releaser') ? releaserSecrets : [])])].sort();
  if (!s.secrets) unchecked.push({ check: 'secrets', subject: repo, reason: "the token can't list the repository's secret names (it needs admin access)" });
  else {
    for (const id of identities) {
      const lacks = appSecrets(id).filter((n) => needSecrets.includes(n) && !s.secrets?.has(n));
      if (!lacks.length) continue;
      const slug = slugOf.get(id);
      find('secret.missing', repo, `lacks ${lacks.join(' and ')}, the ${id} App's ${lacks.length > 1 ? 'secrets' : 'secret'}.`, slug
        ? { text: `Add ${repoName} to the ${id} App's installation, generate a private key on its settings page, then store it (the command checks it, stores both secrets and deletes the file):`, commands: [`kanon apps --owner ${s.owner} --repo ${repoName} --reuse ${id}:${slug}=<downloaded>.pem`] }
        : { text: `Create the ${id} App from this checkout; kanon apps stores its secrets.`, commands: [`kanon apps --owner ${s.owner} --repo ${repoName} ${(() => { try { return appsArgs([id], req).join(' '); } catch { return ''; } })()}`.trim()] });
    }
    for (const n of needSecrets.filter((x) => !/_APP_(ID|PRIVATE_KEY)$/.test(x) && !s.secrets?.has(x))) {
      const by = installed.filter((l) => req.lanes[l]?.secrets.includes(n));
      find('secret.missing', repo, `lacks ${n}, which ${by.join(', ')} ${by.length > 1 ? 'take' : 'takes'}.`, {
        text: n === 'CLAUDE_CODE_OAUTH_TOKEN' ? "Store the token of the Claude subscription the agents run on, made with `claude setup-token` (docs/lanes.md), pasting it on standard input:" : `Store it, pasting the value on standard input:`,
        commands: [`gh secret set ${n} -R ${repo}`],
      });
    }
    // An App secret no App in use reads and no workflow maps: left from the per-role Apps, or from
    // an App dropped. A secret any job maps counts as read, whatever the job calls (#414).
    const known = new Set([...Object.keys(req.identities.roles), ...Object.keys(req.identities.apps)].flatMap(appSecrets));
    const used = new Set(identities.flatMap(appSecrets));
    const mapping = [...workflows].map(([file, wf]) => ({ file, ...secretReads(wf) }));
    for (const m of mapping) for (const n of m.names) used.add(n);
    const stale = [...s.secrets].filter((n) => known.has(n) && !used.has(n.toUpperCase())).sort();
    const inheriting = mapping.flatMap((m) => m.inherits.map((j) => `${m.file}'s job ${j}`));
    const unread = unchecked.filter((u) => u.check === 'workflow').map((u) => u.subject);
    if (stale.length && inheriting.length) notes.push(`${inheriting.join(', ')} inherit${inheriting.length > 1 ? '' : 's'} every secret, so doctor lists none of ${stale.join(', ')} as stale: it can't tell which the called workflow reads.`);
    else if (stale.length && unread.length) notes.push(`doctor lists none of ${stale.join(', ')} as stale: it could not read ${unread.join(', ')}, which may map them.`);
    else if (stale.length) {
      find('secret.stale', repo, `holds ${stale.join(', ')}, which no App the lanes of ${checked} run as here reads, and no job of a workflow under .github/workflows/ on ${onCheckout} names: doctor reads every \`secrets.<NAME>\` in each workflow outside its on:, in a job's secrets:, env:, with: or steps alike, whatever the job calls.`, {
        text: `Delete them${branchName === s.defaultBranch ? '' : `, once ${s.defaultBranch}'s workflows map none of them either`}, and uninstall the Apps they belong to if no repository uses them:`,
        commands: stale.map((n) => `gh secret delete ${n} -R ${repo}`),
      });
    }
  }

  // ── The declarations, hooks and workflows the lanes read ────────────────────────────────────
  /** @type {Map<string, string[]>} path → lanes */
  const reads = new Map();
  for (const l of installed) for (const d of req.lanes[l]?.reads ?? []) reads.set(d, [...(reads.get(d) ?? []), l]);
  const declared = /** @type {Record<string, { baseline: boolean, requiredSections: string[] }> | undefined} */ (/** @type {any} */ (req).declarations);
  for (const [path, by] of [...reads].sort(([a], [b]) => a.localeCompare(b))) {
    const decl = declared?.[path] ?? { baseline: /-playbook\.md$/.test(path), requiredSections: path === 'docs/qa/stack.md' ? ['## Gates'] : [] };
    const text = read(path);
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
      if (n !== 1) find('declaration.section-missing', path, `has the heading \`${h}\` ${n} times; ${by.join(', ')} read${by.length > 1 ? '' : 's'} that section, which has no default, so it is there exactly once (K-LAYOUT-17).`, { text: `Write \`${h}\` exactly once, outside any fenced block.` });
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
          find('hook.input-missing', req.hook.path, `does not declare ${lacks.join(', ')}, which Kanon ${checked}'s lanes pass it.`, {
            text: `Add under inputs:`,
            commands: lacks.flatMap((k) => [`  ${k}:`, `    description: Passed by Kanon's lanes (docs/lanes.md).`, '    default: ""']),
          });
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
    const blind = identities.filter((i) => appSecrets(i).some((n) => lacks.includes(n)));
    const stale = got.filter((n) => !takes.has(n));
    if (lacks.length) find('apps-check.secret-missing', c.file, `does not map ${lacks.join(', ')}, so apps-check can't check the ${blind.join(' and ')} App${blind.length > 1 ? 's' : ''}.`, { text: `Add under the job's secrets:`, commands: lacks.map((n) => `      ${n}: \${{ secrets.${n} }}`) });
    if (stale.length) find('apps-check.secret-stale', c.file, `maps ${stale.join(', ')}, which Kanon ${checked}'s apps-check does not take; GitHub refuses the call.`, { text: `Remove these lines from the job's secrets:`, commands: stale.map((n) => `      ${n}: \${{ secrets.${n} }}`) });
  }

  // ── The labels ──────────────────────────────────────────────────────────────────────────────
  const taxonomy = new Map(deps.labels().map((l) => [l.name, l]));
  const missingLabels = (req.labels ?? []).filter((n) => !/<[a-z]+>$/.test(n) && !s.labels.has(n));
  if (missingLabels.length) {
    find('label.missing', repo, `lacks ${missingLabels.length} of the taxonomy's labels: ${missingLabels.join(', ')}. A lane creates a label it needs on first use (plan 0005 §5.3), so this blocks nothing.`, {
      text: `Let kanon init create them, or create them yourself:`,
      commands: missingLabels.map((n) => {
        const l = taxonomy.get(n);
        return l ? `gh label create ${JSON.stringify(n)} --color ${l.color} --description ${JSON.stringify(l.description)} -R ${repo}` : `gh label create ${JSON.stringify(n)} -R ${repo}`;
      }),
    });
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
      const appId = appIdOf.get('releaser');
      if (slug === undefined || appId === undefined) {
        unchecked.push({ check: 'ruleset-bypass', subject: s.defaultBranch, reason: `the Releaser App ${slug ? `\`${slug}\` could not be read` : 'has no register row'}, so its bypass can't be looked for` });
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

  // ── The telemetry collector (#428) ──────────────────────────────────────────────────────────
  // A caller of Kanon's collector sends nothing until the repository has the two variables the
  // Kanon operator gives it (docs/telemetry.md): the collector skips with a warning and stays
  // green, so nothing else would say so. Not blocking: no lane needs it. Variables the token
  // can't list are a note, not an unchecked check, for the same reason.
  const collector = req.telemetry?.collector;
  const collectorCallers = collector
    ? [...workflows].filter(([, wf]) => Object.values(isMap(wf.jobs) ? wf.jobs : {}).some((j) => isMap(j) && kanonCall(j.uses)?.workflow === collector)).map(([f]) => f)
    : [];
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
        const fix = telemetryStep(repo, unset, true);
        for (const file of collectorCallers) {
          find('telemetry.unconfigured', file, `calls Kanon's telemetry collector, and ${repo} doesn't set ${unset.join(' or ')}, so it sends nothing: the collector skips with a warning and stays green.`, { text: fix.text, commands: fix.commands, url: fix.url });
        }
      }
    }
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
    } catch (e) {
      find('declaration.malformed', ADOPTION_RECORD, /** @type {Error} */ (e).message, { text: 'Write it under ## Choices as `- **Upstream findings:** `filed here`` or `drafted`, or remove it for Kanon\'s default, `drafted` (K-LAYOUT-10).' });
    }
  }
  // ── The waivers ─────────────────────────────────────────────────────────────────────────────
  // Last, over every finding: one bullet waives one id on one subject, as doctor reported it.
  const waiverRecord = readWaivers(read(ADOPTION_RECORD));
  for (const e of waiverRecord.errors) find('declaration.malformed', ADOPTION_RECORD, e, { text: `Write each waiver under ## Choices as \`- **${WAIVER_LABEL}:** \`<finding id>\` on \`<subject>\` (<why the finding stands>)\`, for a finding that can be waived (docs/doctor.md).` });
  /** @type {Waived[]} */
  const waived = [];
  for (const w of waiverRecord.waivers) {
    const hits = findings.filter((f) => f.id === w.id && f.subject === w.subject);
    if (hits.length) {
      for (const f of hits) {
        findings.splice(findings.indexOf(f), 1);
        waived.push({ ...f, reason: w.reason });
      }
      continue;
    }
    const category = /** @type {{ category: string }} */ (FINDINGS[w.id]).category;
    const blind = unchecked.find((u) => u.subject === w.subject || UNCHECKED_CATEGORY[u.check] === category);
    if (blind) notes.push(`${ADOPTION_RECORD}:${w.line} waives ${w.id} on ${w.subject}, which doctor did not report; the ${blind.check} check could not run, so it can't tell whether the waiver is still needed.`);
    else find('waiver.stale', ADOPTION_RECORD, `${ADOPTION_RECORD}:${w.line} waives ${w.id} on ${w.subject}, but doctor reports no such finding.`, { text: `Remove the bullet, so the record says only what is true.` });
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
 * (`ruleset.rule-missing`), a workflow on the default branch must report it; otherwise it asks
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
  if (checkReporters(onDefault.workflows, LANE_CHECK).length) return gaps;
  const here = checkReporters(checkout, LANE_CHECK);
  const then = required ? 'Until it merges, every other pull request waits on the check.' : `Then require the check: doctor asks for it (ruleset.rule-missing) once the job is on ${s.defaultBranch}.`;
  find('ruleset.check-unreported', LANE_CHECK, required
    ? `The ruleset on ${s.defaultBranch} requires the status check "${LANE_CHECK}", but no job of a workflow on ${s.defaultBranch} reports it, so every pull request that doesn't add such a job waits on it (K-ADOPT-1 step 8).`
    : `No job of a workflow on ${s.defaultBranch} reports the status check "${LANE_CHECK}", so the ruleset can't require it yet: a required check that nothing reports blocks every pull request (K-ADOPT-1 step 8).`, {
    text: here.length
      ? `This checkout adds it (${here.join(', ')}): merge the pull request that adds it to ${s.defaultBranch} first. ${then}`
      : `Add a job of its own named "${LANE_CHECK}", in a workflow that runs on pull_request, as actions/lane-check's README shows (a step in another job reports nothing under that name), and merge it. ${then}`,
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
    for (const w of r.waived) out.push(`- [${TITLES[w.category] ?? w.category}] ${w.id}, ${w.subject}: ${w.reason}.`);
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
