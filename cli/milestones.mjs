// `kanon milestones` (#72): creates the two bucket milestones of K-WORK-4, Product Backlog
// and Development Automation, on a repository that lacks them. Step 7 of the adoption
// checklist (K-ADOPT-1). On Kanon itself the buckets were missed until the review lane tried
// to file a follow-up into one that didn't exist.
//
// - **By name, never with a due date.** A due date is what makes a milestone a roadmap
//   milestone (K-WORK-3), so a bucket never gets one.
// - **Idempotent.** A bucket that already exists, open and with no due date, is left alone.
//   Running it twice creates nothing the second time.
// - **Reports, never repairs.** A milestone with a bucket's name and a due date is a
//   roadmap milestone, and whether it should be one is the Stakeholder's call (K-WORK-5).
//   A closed one has been completed by someone, and a bucket never completes. Either is
//   reported, left unchanged, and makes the command exit 1, so a bootstrap script notices.
//
// The list comes from the backstop's own constant, so there is one copy of it (K-WORK-13).
//
// Like `kanon apps`, it first says which token `gh` uses and whose it is, and when GitHub
// refuses the token, how to fix a stale GH_TOKEN (cli/gh-token.mjs, plan 0005 §5.1).
import { spawn } from 'node:child_process';
import { BUCKET_MILESTONES } from '../scripts/issue-triage-defaults.mjs';
import { isAuthFailure, tokenFix, whoami } from './gh-token.mjs';

/** The two buckets, in the order K-WORK-4 names them: the backstop's own list. */
export const BUCKETS = BUCKET_MILESTONES;

export const USAGE = `Usage: kanon milestones --repo <owner>/<repo>

Creates the bucket milestones, ${BUCKETS.map((b) => `"${b}"`).join(' and ')}, with no due
date, on a repository that has none of that name (K-WORK-4). Safe to run again: it creates
only what is missing. A milestone with a bucket's name that has a due date, or is closed, is
reported and left unchanged, and the command exits 1.

Needs \`gh\` signed in with Issues: write on the repository. gh takes its token from GH_TOKEN,
then GITHUB_TOKEN, then its stored login; the command prints which one it uses and whose it is.`;

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult
 * @typedef {{ gh: (args: string[]) => Promise<GhResult>, out: (line: string) => void, err: (line: string) => void, env: Record<string, string | undefined> }} Deps
 * @typedef {{ number: number, title: string, state: string, due_on: string | null }} Milestone
 */

/** @type {Deps} */
export const realDeps = {
  gh: (args) =>
    new Promise((resolve) => {
      const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => resolve({ status: null, stdout, stderr: String(e.message) }));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    }),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
};

/**
 * Parses `kanon milestones`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv
 */
export const parseArgs = (argv) => {
  const opts = { repo: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--repo') {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error('--repo needs a value');
      opts.repo = v;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (opts.help) return opts;
  if (!opts.repo) throw new Error('--repo is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo takes <owner>/<repo>, not "${opts.repo}"`);
  return opts;
};

/**
 * `kanon milestones`. Returns the exit code: 0 when both buckets exist as buckets, 1 when one
 * is reported or a GitHub call fails, 2 on a usage error.
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const milestones = async (argv, overrides = {}) => {
  const deps = { ...realDeps, ...overrides };
  /** @type {ReturnType<typeof parseArgs>} */
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    deps.err(`kanon milestones: ${/** @type {Error} */ (e).message}`);
    deps.err(USAGE);
    return 2;
  }
  if (opts.help) {
    deps.out(USAGE);
    return 0;
  }
  const { repo } = opts;

  const who = await whoami(deps.gh, deps.env);
  deps.out(who.line);
  if (who.refusal) {
    for (const l of who.refusal) deps.err(`kanon milestones: ${l}`);
    return 1;
  }
  /** @param {GhResult} r */
  const fix = (r) => (isAuthFailure(r.stderr) ? tokenFix(who.source).map((l) => `kanon milestones: ${l}`) : []);

  // Every milestone, closed ones included: GitHub refuses a second milestone with a closed
  // one's title, and a closed bucket is a finding, not an absence.
  const list = await deps.gh(['api', '--paginate', '--slurp', `repos/${repo}/milestones?state=all&per_page=100`]);
  /** @type {Milestone[]} */
  let existing;
  try {
    if (list.status !== 0) throw new Error(list.stderr.trim() || `gh exited ${list.status}`);
    existing = /** @type {Milestone[][]} */ (JSON.parse(list.stdout)).flat();
  } catch (e) {
    deps.err(`kanon milestones: could not list the milestones of ${repo}: ${/** @type {Error} */ (e).message}`);
    for (const l of fix(list)) deps.err(l);
    return 1;
  }

  let problems = 0;
  for (const title of BUCKETS) {
    const found = existing.find((m) => m.title === title);
    if (!found) {
      const r = await deps.gh(['api', '-X', 'POST', `repos/${repo}/milestones`, '-f', `title=${title}`]);
      if (r.status !== 0) {
        deps.err(`kanon milestones: could not create "${title}" on ${repo}: ${r.stderr.trim() || `gh exited ${r.status}`}`);
        for (const l of fix(r)) deps.err(l);
        problems++;
        continue;
      }
      deps.out(`Created "${title}", with no due date.`);
    } else if (found.due_on) {
      deps.err(
        `kanon milestones: "${title}" (#${found.number}) has a due date, ${found.due_on.slice(0, 10)}, so it reads as a roadmap milestone, not a bucket (K-WORK-3). ` +
          'Left unchanged: whether it should be one is the Stakeholder\'s call. To make it the bucket, remove its due date.',
      );
      problems++;
    } else if (found.state !== 'open') {
      deps.err(
        `kanon milestones: "${title}" (#${found.number}) is ${found.state}, and a bucket never completes (K-WORK-4). ` +
          `Left unchanged. To reopen it: gh api -X PATCH repos/${repo}/milestones/${found.number} -f state=open`,
      );
      problems++;
    } else deps.out(`"${title}" already exists, with no due date.`);
  }
  return problems ? 1 : 0;
};
