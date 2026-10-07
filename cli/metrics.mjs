// `kanon metrics dry-run` (plan 0003 §7, M2 part C, kanon#516): derives the work-item row of
// every pull request closed in a window, from GitHub, with a read-only token, and prints only
// counts. It writes nothing to GitHub and sends nothing to the telemetry store.
//
// WHAT IT IS FOR. Before the collector writes a single work-item row (M4), the metrics module
// is run on a real history: the band counts are compared with §1.2's, every row is validated
// against the telemetry schema, and the revert and linked-fix detectors' counts are printed side
// by side, explicit links and SZZ, so the Owner can hand-check them (§3.5, decision 8).
//
// COUNTS ONLY, ON STANDARD OUTPUT. A pull request's title, a login and a path are the adopter's
// (ADR 0007, `K-OBS-16`), and the output of a dry run is the kind of text pasted into an issue.
// So standard output carries numbers, the window, the repository the caller named, and field
// names; nothing read from a pull request reaches it. The token's login, which `gh` reports,
// goes to standard error with the progress lines.
//
// THE DETAILS FILE, ONLY ON REQUEST. `--details <file>` writes every row and every detector
// link (pull request numbers, how each was found, and the days) to a local JSON file, for the
// Owner's hand check. It names pull requests, so it stays private: it goes to the private ops
// repository, never to a public issue or pull request. It is never written by default, and never
// inside the checkout being measured, where a commit would publish it.
//
// SZZ NEEDS A CHECKOUT. Blame runs on a local git checkout of the repository (`--dir`), at each
// fix's parent. Without one, or when the checkout lacks a fix's merge commit, SZZ is reported as
// not run, by name, and its counts are null, never 0.
//
// Exit codes, as `kanon doctor`'s:
//   0  every pull request in the window was read and its row is valid
//   1  at least one row failed validation (the fields are listed)
//   2  usage error
//   3  could not run: no repository, a declaration that can't be read, a GitHub error, a rate
//      limit nearly spent
//   4  incomplete: every row read is valid, but a pull request was left out as truncated or
//      unreadable, or a blame failed
//
// Node built-ins only, like the other commands.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ACTOR_CLASSES } from '../actions/agent-telemetry/schema.mjs';
import { APP_REGISTER, parseAppRegister } from '../scripts/app-register.mjs';
import { parseCodeAreas, STACK_FILE, UNDECLARED } from '../scripts/lib/code-areas.mjs';
import { defaultEscalationFile, ESCALATION_FILE, parseEscalationFile } from '../scripts/lib/escalation-paths.mjs';
import { toDetectorPr } from '../scripts/metrics/adapter.mjs';
import { AREAS } from '../scripts/metrics/areas.mjs';
import { BANDS } from '../scripts/metrics/band.mjs';
import { accuracyFields, codeAreaTest, detectorCounts, isFixPr } from '../scripts/metrics/detectors.mjs';
import { ORIGINS } from '../scripts/metrics/origin.mjs';
import { isReleasePr } from '../scripts/metrics/release.mjs';
import { WorkItemError, workItemRow } from '../scripts/metrics/work-item.mjs';
import { remoteRepo } from './apps.mjs';
import { kanonRelease } from './callers.mjs';
import { whoami } from './gh-token.mjs';
import { ReadError, readPullRequests } from './metrics-read.mjs';

/** The JSON output's contract (docs/metrics.md). A breaking change to it changes this. */
export const SCHEMA = 'kanon-metrics-dry-run/v1';

/** The details file's contract (docs/metrics.md). */
export const DETAILS_SCHEMA = 'kanon-metrics-details/v1';

/** The exit codes, as docs/metrics.md documents them. */
export const EXIT = /** @type {const} */ ({ ok: 0, invalid: 1, usage: 2, error: 3, incomplete: 4 });

export const USAGE = `Usage: kanon metrics dry-run --since <YYYY-MM-DD> [options]

Derives the work-item row of every pull request closed in the window (plan 0003 §3.3) from
GitHub, validates each against the telemetry schema, runs the revert and linked-fix detectors,
and prints counts only: no title, login or path. Writes nothing to GitHub and sends nothing to
the telemetry store.

Options:
  --since <YYYY-MM-DD>   the window's start, 00:00 UTC (required)
  --until <YYYY-MM-DD>   the window's end, 00:00 UTC, not included (default: now)
  --repo <owner>/<repo>  the repository (default: --dir's origin remote)
  --dir <path>           a git checkout of the repository: the declarations are read from it,
                         and SZZ blames in it. Without it, the declarations are read from the
                         default branch on GitHub, and SZZ is reported as not run
  --json                 print one JSON document (docs/metrics.md) instead of prose
  --details <file>       also write every row and detector link (pull request numbers, how
                         each link was found, the days) to this local JSON file, for a hand
                         check. It names pull requests: keep it private, in the private ops
                         repository, never in a public issue or pull request. Never written
                         unless asked, and never inside --dir
  -h, --help             this text

Exit codes: 0 every row valid; 1 a row failed validation; 2 usage error; 3 could not run;
4 incomplete, a pull request left out as truncated or unreadable (docs/metrics.md).

Needs \`gh\` and a token that can read the repository's pull requests and issues. gh takes its
token from GH_TOKEN, then GITHUB_TOKEN, then its stored login; the command says on standard
error which one it used and whose it is.`;

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult
 * @typedef {{
 *   gh: (args: string[]) => Promise<GhResult>,
 *   git: (args: string[]) => GhResult,
 *   env: Record<string, string | undefined>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   readFile: (path: string) => string | null,
 *   writeFile: (path: string, text: string) => void,
 *   release: () => string,
 *   now: () => Date,
 *   sleep: (ms: number) => Promise<void>,
 *   sizes?: import('./metrics-read.mjs').ReadSizes,
 * }} Deps
 */

/** @type {Deps} */
export const realDeps = {
  gh: (args) =>
    new Promise((done) => {
      const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => done({ status: null, stdout, stderr: String(e.message) }));
      child.on('close', (status) => done({ status, stdout, stderr }));
    }),
  git: (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
  },
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null),
  writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  release: kanonRelease,
  now: () => new Date(),
  sleep: (ms) => wait(ms).then(() => undefined),
};

/** A date argument, `YYYY-MM-DD`, as 00:00 UTC; throws naming the flag. @param {string} flag @param {string} v */
const day = (flag, v) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new Error(`${flag} takes a date, YYYY-MM-DD, not "${v}"`);
  return d;
};

/**
 * Parses `kanon metrics`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv
 */
export const parseArgs = (argv) => {
  /** @type {{ sub: string, since: Date | null, until: Date | null, repo: string, dir: string | null, json: boolean, details: string | null, help: boolean }} */
  const opts = { sub: '', since: null, until: null, repo: '', dir: null, json: false, details: null, help: false };
  const [sub, ...rest] = argv;
  if (sub === '-h' || sub === '--help' || sub === undefined) return { ...opts, help: true };
  if (sub !== 'dry-run') throw new Error(`unknown subcommand "${sub}"; the one there is: dry-run`);
  opts.sub = sub;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? rest[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      if (inline === undefined && v.startsWith('-')) throw new Error(`${flag} needs a value, not the flag "${v}"; to give a value that begins with "-", write ${flag}=<value>`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--since') opts.since = day(flag, value());
    else if (flag === '--until') opts.until = day(flag, value());
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--dir') opts.dir = value();
    else if (flag === '--details') opts.details = value();
    else if (flag === '--json') opts.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (opts.help && opts.json) throw new Error('--help and --json contradict each other; give one');
  if (opts.help) return opts;
  if (!opts.since) throw new Error('--since is required');
  if (opts.until && opts.until <= opts.since) throw new Error('--until must be after --since');
  if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo takes <owner>/<repo>, not "${opts.repo}"`);
  if (!opts.repo && !opts.dir) throw new Error('give --repo <owner>/<repo>, or --dir <checkout> whose origin remote names it');
  return opts;
};

/** @param {Deps} deps @param {number} exitCode @param {string} error */
const errorDocument = (deps, exitCode, error) => ({ schema: SCHEMA, kanon: deps.release(), status: 'error', exitCode, error });

/**
 * `kanon metrics`. Returns the exit code (`EXIT`).
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const metrics = async (argv, overrides = {}) => {
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
      deps.err(`kanon metrics: ${message}`);
      deps.err(USAGE);
    }
    return EXIT.usage;
  }
  if (opts.help) {
    deps.out(USAGE);
    return EXIT.ok;
  }
  /** @type {Awaited<ReturnType<typeof dryRun>>} */
  let result;
  try {
    result = await dryRun(deps, opts);
  } catch (e) {
    const known = e instanceof ReadError || e instanceof DryRunError;
    result = { error: known ? /** @type {Error} */ (e).message : `stopped on an unexpected error: ${/** @type {Error} */ (e).message}` };
  }
  if ('error' in result) {
    if (opts.json) deps.out(JSON.stringify(errorDocument(deps, EXIT.error, result.error), null, 2));
    else deps.err(`kanon metrics: ${result.error}`);
    return EXIT.error;
  }
  if (opts.json) deps.out(JSON.stringify(result.report, null, 2));
  else for (const line of prose(result.report)) deps.out(line);
  return result.report.exitCode;
};

/**
 * A path with symbolic links resolved, as far up as it exists: git reports a checkout's real
 * path (`/private/var/…` on macOS), so a details path is compared in the same spelling.
 * @param {string} p an absolute path
 * @returns {string}
 */
const realPath = (p) => {
  if (existsSync(p)) return realpathSync(p);
  const up = dirname(p);
  return up === p ? p : join(realPath(up), basename(p));
};

/** Stops the run with a message that names no title, login or path. */
class DryRunError extends Error {}

/**
 * The checkout's top level, when it is a checkout of `repo`.
 * @param {Deps} deps @param {string} dir @param {string} repo
 */
function checkoutOf(deps, dir, repo) {
  const top = deps.git(['-C', resolve(dir), 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new DryRunError(`--dir ${dir} is not a git checkout`);
  const root = top.stdout.trim();
  const remotes = deps.git(['-C', root, 'remote', '-v']);
  const repos = remotes.stdout.split('\n').map((l) => remoteRepo(l.split(/\s+/)[1] ?? '')).filter((r) => r !== null);
  if (!repo) {
    const origin = deps.git(['-C', root, 'remote', 'get-url', 'origin']);
    const found = origin.status === 0 ? remoteRepo(origin.stdout) : null;
    if (!found) throw new DryRunError(`--dir ${dir} has no origin remote on GitHub; pass --repo <owner>/<repo>`);
    return { root, repo: found };
  }
  if (!repos.some((r) => r.toLowerCase() === repo.toLowerCase())) throw new DryRunError(`--dir ${dir} is not a checkout of ${repo}: none of its remotes names it`);
  return { root, repo };
}

/**
 * The adopter's declarations, parsed, from the checkout or the default branch on GitHub, and
 * what was found. A file that can't be parsed stops the run; its reader's message, which may
 * quote the file, goes to standard error only.
 * @param {Deps} deps @param {string} repo @param {string | null} root
 */
async function declarations(deps, repo, root) {
  /** @param {string} rel @returns {Promise<string | null>} */
  const read = async (rel) => {
    if (root) return deps.readFile(join(root, rel));
    const r = await deps.gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${rel}`]);
    if (r.status === 0) return r.stdout;
    if (/HTTP 404|Not Found/i.test(r.stderr)) return null;
    throw new DryRunError(`could not read ${rel} from ${repo}'s default branch (${r.stderr.trim().slice(0, 200) || `gh exited ${r.status}`})`);
  };
  /** @template T @param {string} rel @param {(text: string) => T} parse */
  const parsed = async (rel, parse) => {
    const text = await read(rel);
    if (text === null) return null;
    try {
      return parse(text);
    } catch (e) {
      deps.err(`kanon metrics: ${/** @type {Error} */ (e).message}`);
      throw new DryRunError(`${rel} could not be parsed; the reason is on standard error, and \`kanon doctor\` checks it`);
    }
  };
  const register = await parsed(APP_REGISTER, (t) => parseAppRegister(t));
  const codeAreas = await parsed(STACK_FILE, parseCodeAreas);
  const escalationFile = await parsed(ESCALATION_FILE, parseEscalationFile);
  return {
    decl: {
      register: register ?? new Map(),
      // A missing file is the adopter declaring nothing, which is Kanon's default, as the
      // checkout readers have it; a file that can't be read has already stopped the run.
      codeAreas: codeAreas ?? UNDECLARED,
      escalationFile: escalationFile ?? defaultEscalationFile(),
    },
    found: {
      source: root ? 'checkout' : 'github',
      register: register ? 'read' : 'absent',
      codeAreas: codeAreas?.declared ? 'declared' : 'default',
      escalationFile: escalationFile ? 'read' : 'default',
    },
  };
}

/**
 * The old-side hunks of each file a commit changed against `at`, by the file's path after it
 * (its old path when deleted), from `git diff -U0`.
 * @param {string} diff
 * @returns {Map<string, { start: number, count: number }[]>}
 */
export function diffRanges(diff) {
  /** @param {string} p */
  const unquote = (p) => (p.startsWith('"') ? JSON.parse(p.replace(/\\([0-7]{3})/g, (_, o) => `\\u00${parseInt(o, 8).toString(16).padStart(2, '0')}`)) : p);
  /** @type {Map<string, { start: number, count: number }[]>} */
  const out = new Map();
  /** @type {string | null} */
  let old = null;
  /** @type {{ start: number, count: number }[] | null} */
  let cur = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { old = null; cur = null; continue; }
    if (line.startsWith('--- ')) { const p = unquote(line.slice(4)); old = p === '/dev/null' ? null : p.replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ')) {
      const p = unquote(line.slice(4));
      const key = p === '/dev/null' ? old : p.replace(/^b\//, '');
      cur = key === null ? null : [];
      if (key !== null && cur) out.set(key, cur);
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (m && cur) cur.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return out;
}

/**
 * Sets up SZZ: checks the checkout has every fix's merge commit and parent, and gives each fix's
 * files their old-side hunks. Returns the blame function, or why SZZ isn't run.
 * @param {Deps} deps @param {string | null} root @param {import('../scripts/metrics/detectors.mjs').DetectorPr[]} fixes
 */
function szzSetup(deps, root, fixes) {
  if (!root) return { ran: false, reason: 'no checkout was given (--dir)' };
  const shas = fixes.flatMap((f) => [f.mergeCommitSha, f.parentSha]).filter((s) => typeof s === 'string');
  if (fixes.some((f) => !f.mergeCommitSha || !f.parentSha)) return { ran: false, reason: 'a merged fix has no merge commit or parent on GitHub' };
  if (shas.length) {
    const has = deps.git(['-C', root, 'rev-list', '--no-walk', '--quiet', ...new Set(shas)]);
    if (has.status !== 0) return { ran: false, reason: "the checkout lacks a fix's merge commit or its parent; fetch the default branch and run it again" };
  }
  for (const fix of fixes) {
    const d = deps.git(['-C', root, '-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', /** @type {string} */ (fix.parentSha), /** @type {string} */ (fix.mergeCommitSha)]);
    if (d.status !== 0) return { ran: false, reason: "git diff failed on a fix's merge commit" };
    const ranges = diffRanges(d.stdout);
    for (const f of fix.files) f.ranges = ranges.get(f.path) ?? [];
  }
  const failures = { count: 0 };
  /** @type {import('../scripts/metrics/detectors.mjs').Blame} */
  const blame = (path, ranges, at) => {
    const r = deps.git(['-C', root, 'blame', '--porcelain', ...ranges.flatMap((x) => ['-L', `${x.start},+${x.count}`]), at, '--', path]);
    if (r.status !== 0) { failures.count += 1; return []; }
    return [...new Set([...r.stdout.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)].map((m) => /** @type {string} */ (m[1])))];
  };
  return { ran: true, blame, failures };
}

/** Adds `n` to a count. @param {Record<string, number>} t @param {string} k @param {number} [n] */
const bump = (t, k, n = 1) => { t[k] = (t[k] ?? 0) + n; };

/** @param {readonly string[]} keys */
const zeroes = (keys) => /** @type {Record<string, number>} */ (Object.fromEntries(keys.map((k) => [k, 0])));

/**
 * The dry run: reads, derives, counts. The report, or the reason it couldn't run.
 * @param {Deps} deps @param {ReturnType<typeof parseArgs>} opts
 * @returns {Promise<{ report: Record<string, any> & { exitCode: number } } | { error: string }>}
 */
export async function dryRun(deps, opts) {
  const since = /** @type {Date} */ (opts.since);
  let repo = opts.repo;
  /** @type {string | null} */
  let root = null;
  if (opts.dir) ({ root, repo } = checkoutOf(deps, opts.dir, repo));
  if (opts.details && root) {
    // Outside means a first segment of exactly `..`: `..details.json` is a file inside the checkout.
    const rel = relative(realPath(root), realPath(resolve(opts.details)));
    const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!outside) return { error: `--details names a file inside the checkout of ${repo}, where a commit would publish it; write it outside, in the private ops repository` };
  }

  const who = await whoami(deps.gh, deps.env);
  deps.err(who.line);
  if (who.refusal) return { error: who.refusal.join(' ') };

  const { decl, found } = await declarations(deps, repo, root);
  const read = await readPullRequests({ gh: deps.gh, sleep: deps.sleep, progress: deps.err }, repo, { since, until: opts.until }, deps.sizes);

  // Release PRs are left out of every count and of the detectors' items (§1.2, the Owner on
  // kanon#538). The detectors' view goes through the one adapter; a PR it refuses is left out.
  /** @type {{ pr: number, reason: string }[]} */
  const leftOut = [...read.leftOut];
  /** @type {import('../scripts/metrics/types.mjs').PullRequest[]} */
  const prs = [];
  /** @type {import('../scripts/metrics/detectors.mjs').DetectorPr[]} */
  const dprs = [];
  for (const pr of read.prs) {
    if (isReleasePr(pr, decl.register)) {
      leftOut.push({ pr: pr.number, reason: 'release' });
      continue;
    }
    try {
      dprs.push(toDetectorPr(pr));
      prs.push(pr);
    } catch {
      leftOut.push({ pr: pr.number, reason: 'unreadable' });
    }
  }
  const isCode = codeAreaTest({ codeAreas: decl.codeAreas, escalationFile: decl.escalationFile });
  const fixes = dprs.filter((p) => p.mergedAt && isFixPr(p));
  const szz = szzSetup(deps, root, fixes);
  const det = await detectorCounts(dprs, { repo, isCode, blame: szz.ran && szz.blame ? szz.blame : () => [] });
  const blameFailures = szz.ran && szz.failures ? szz.failures.count : 0;

  // The rows.
  const recordedAt = deps.now().toISOString();
  const version = deps.release().replace(/^v/, '');
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {{ pr: number, fields: string[] }[]} */
  const invalid = [];
  prs.forEach((pr, k) => {
    const links = pr.merged_at ? accuracyFields(/** @type {any} */ (dprs[k]), dprs, { repo, isCode }) : {};
    try {
      rows.push(workItemRow({ pr, declarations: decl, tag: 'run', recorded_at: recordedAt, kanon_version: version, links }));
    } catch (e) {
      if (!(e instanceof WorkItemError)) throw e;
      invalid.push({ pr: pr.number, fields: e.fields.length ? e.fields : ['(row)'] });
    }
  });

  // The counts.
  const merged = rows.filter((r) => r.fate === 'merged');
  const bandsOf = (/** @type {Record<string, unknown>[]} */ rs) => {
    const b = zeroes([...BANDS, 'none']);
    for (const r of rs) bump(b, typeof r.band === 'string' ? r.band : 'none');
    return b;
  };
  const areas = zeroes(AREAS);
  for (const r of rows) for (const a of AREAS) bump(areas, a, Number(r[`files_${a}`] ?? 0));
  const tally = (/** @type {readonly string[]} */ keys, /** @type {Record<string, unknown>[]} */ rs, /** @type {string} */ field) => {
    const t = zeroes([...keys, 'unknown']);
    for (const r of rs) bump(t, typeof r[field] === 'string' && keys.includes(/** @type {string} */ (r[field])) ? /** @type {string} */ (r[field]) : 'unknown');
    return t;
  };
  const invalidFields = /** @type {Record<string, number>} */ ({});
  for (const i of invalid) for (const f of i.fields) bump(invalidFields, f);
  const reason = (/** @type {string} */ r) => leftOut.filter((l) => l.reason === r).length;
  const c = det.counts;
  const szzNull = (/** @type {number} */ n) => (szz.ran ? n : null);
  const incomplete = reason('truncated') + reason('unreadable') + blameFailures > 0;
  const exitCode = invalid.length ? EXIT.invalid : incomplete ? EXIT.incomplete : EXIT.ok;
  const report = {
    schema: SCHEMA,
    kanon: deps.release(),
    status: invalid.length ? 'invalid-rows' : incomplete ? 'incomplete' : 'ok',
    exitCode,
    repo,
    window: { since: since.toISOString().slice(0, 10), until: opts.until ? opts.until.toISOString().slice(0, 10) : null },
    declarations: found,
    prs: { read: prs.length, merged: prs.filter((p) => p.merged_at).length, closedUnmerged: prs.filter((p) => !p.merged_at).length },
    leftOut: { open: reason('open'), release: reason('release'), truncated: reason('truncated'), unreadable: reason('unreadable') },
    rows: { valid: rows.length, invalid: invalid.length, invalidFields },
    bands: { merged: bandsOf(merged), closedUnmerged: bandsOf(rows.filter((r) => r.fate !== 'merged')) },
    areas,
    escalation: { mergedTouching: merged.filter((r) => Object.entries(r).some(([k, v]) => k.startsWith('esc_') && v === true)).length },
    origins: tally(ORIGINS, rows, 'origin'),
    authors: tally(ACTOR_CLASSES, rows, 'author_kind'),
    mergedBy: tally(ACTOR_CLASSES, merged, 'merged_by'),
    linkedFixes: {
      fixes: c.fixes,
      explicit: c.explicit,
      szz: szzNull(c.szz),
      both: szzNull(c.both),
      explicitOnly: szzNull(c.explicitOnly),
      szzOnly: szzNull(c.szzOnly),
      neither: szzNull(c.neither),
      undetected: c.undetected,
      nonCodeGap: c.nonCodeGap,
    },
    reverts: { reverting: c.reverts, revertedItems: c.revertedItems },
    szz: szz.ran ? { status: 'ran', reason: null, blameFailures } : { status: 'not-run', reason: szz.reason, blameFailures: 0 },
    githubCalls: read.calls,
  };

  if (opts.details) {
    const details = {
      schema: DETAILS_SCHEMA,
      kanon: deps.release(),
      private: 'Names pull requests. Keep it in the private ops repository, never in a public issue or pull request.',
      repo,
      window: report.window,
      generatedAt: recordedAt,
      rows,
      invalid,
      leftOut: leftOut.sort((a, b) => a.pr - b.pr),
      fixes: det.fixes.map((f) => ({
        pr: f.pr,
        explicit: f.explicit.map((l) => ({ pr: l.pr, via: l.via, days: l.days })),
        szz: szz.ran ? f.szz.map((l) => ({ pr: l.pr, days: l.days })) : null,
        touchesCode: f.touchesCode,
      })),
    };
    try {
      deps.writeFile(resolve(opts.details), `${JSON.stringify(details, null, 2)}\n`);
    } catch (e) {
      return { error: `could not write the details file: ${/** @type {NodeJS.ErrnoException} */ (e).code ?? 'error'}` };
    }
    deps.err(`Wrote the details file. It names pull requests: keep it private, in the private ops repository.`);
  }
  return { report };
}

/** @param {Record<string, number>} t */
const list = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ');

/** @param {number | null} n */
const num = (n) => (n === null ? 'not run' : String(n));

/**
 * The report as prose. Numbers, the window, the repository and field names only.
 * @param {Record<string, any>} r
 */
export function prose(r) {
  const s = r.linkedFixes;
  return [
    `kanon metrics dry-run on ${r.repo}: pull requests closed from ${r.window.since} to ${r.window.until ?? 'now'}.`,
    `Read: ${r.prs.read} (${r.prs.merged} merged, ${r.prs.closedUnmerged} closed unmerged).`,
    `Left out: ${r.leftOut.open} still open, ${r.leftOut.release} release PRs, ${r.leftOut.truncated} truncated, ${r.leftOut.unreadable} unreadable.`,
    `Rows: ${r.rows.valid} valid, ${r.rows.invalid} failed validation${r.rows.invalid ? ` (fields: ${list(r.rows.invalidFields)})` : ''}.`,
    `Bands, merged: ${list(r.bands.merged)}.`,
    `Bands, closed unmerged: ${list(r.bands.closedUnmerged)}.`,
    `Files by area: ${list(r.areas)}.`,
    `Merged rows touching an escalation path: ${r.escalation.mergedTouching}.`,
    `Origins: ${list(r.origins)}.`,
    `Authors: ${list(r.authors)}.`,
    `Merged by: ${list(r.mergedBy)}.`,
    `Linked fixes, over ${s.fixes} merged fix PRs: explicit ${s.explicit}, SZZ ${num(s.szz)}; both ${num(s.both)}, explicit only ${num(s.explicitOnly)}, SZZ only ${num(s.szzOnly)}, neither ${num(s.neither)}.`,
    `Undetected by the explicit detector: ${s.undetected}, of which ${s.nonCodeGap} change no code-area file (the non-code gap).`,
    `Reverts: ${r.reverts.reverting} reverting PRs, ${r.reverts.revertedItems} reverted items.`,
    r.szz.status === 'ran' ? `SZZ: ran${r.szz.blameFailures ? `, ${r.szz.blameFailures} blames failed` : ''}.` : `SZZ: not run: ${r.szz.reason}.`,
    `Declarations, from ${r.declarations.source === 'checkout' ? 'the checkout' : 'the default branch on GitHub'}: App register ${r.declarations.register}, code areas ${r.declarations.codeAreas}, escalation file ${r.declarations.escalationFile}.`,
    `GitHub calls: ${r.githubCalls}. Status: ${r.status} (exit ${r.exitCode}).`,
  ];
}
