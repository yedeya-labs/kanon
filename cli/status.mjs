// `kanon status` (project #1327, Issue B): where a repository that runs Kanon stands, read live
// from GitHub and printed, with nothing written anywhere (docs/status.md).
//
// A SURFACE, NOT A SECOND CORE. Every answer is a view of the status core (`scripts/status/`),
// read through a `gh`-backed reader with the person's own credential, as `kanon doctor` reads.
// This file parses the flags, finds the repository, says whose token it reads with, and prints:
// one `kanon-status/v1` document with `--json` (docs/cli-json.md), or the same result as prose
// (`[STAT-11]`). The document is built first and the prose is printed from it, so the two can't
// give a different result or exit code.
//
// ONE SECTION PER VIEW ASKED FOR. `--project <n>` asks for the project view, `--release` for the
// release view, `--pr <n>` for the pull-request readiness view, `--lanes` for the lane-health view
// and `--needs-owner` for the needs-the-Owner view, and any of them may be asked at once. A later
// view adds its own section within v1, which docs/cli-json.md allows. A view whose reads didn't
// complete answers with an error naming each read (`[STAT-3]`), never a partial answer, and the
// command exits 4.
//
// EVERY VIEW RUNS FROM ANY DIRECTORY. `--pr` and `--needs-owner` run the merge gate's verdict
// function, and judge by the logins in the default branch's App register, never the checkout's
// (kanon#1396, docs/status.md). `scripts/status/views.mjs` builds each section, for the hosted
// server too.
import { spawn, spawnSync } from 'node:child_process';
import { ghReader, isRepo } from '../scripts/status/reader.mjs';
import { VIEWS, section } from '../scripts/status/views.mjs';
import { remoteRepo } from './apps.mjs';
import { kanonRelease } from './callers.mjs';
import { whoami } from './gh-token.mjs';

/** The JSON output's contract (docs/status.md). A breaking change to it changes this. */
export const SCHEMA = 'kanon-status/v1';

/** The exit codes, as docs/status.md documents them. */
export const EXIT = /** @type {const} */ ({ ok: 0, usage: 2, error: 3, incomplete: 4 });

export const USAGE = `Usage: kanon status [--project <n>] [--release] [--pr <n>] [--lanes] [--needs-owner] [options]

Reads where a repository that runs Kanon stands, live from GitHub, and prints it. Writes
nothing, anywhere (docs/status.md).

Options:
  --project <n>          the project view: tracking issue <n>'s brief, its items with their
                         issues, pull requests, criteria and what holds each, and the phase the
                         Lead's reconciler is in
  --release              the release view: the open release pull request, the latest release
                         and pre-release, each declared environment's last deploy, and the
                         promotion's gates where the repository runs Kanon's promotion
  --lanes                the lane-health view: each lane caller's recent runs as the
                         workflow-health check judges them, and each failure classed infra
                         (the model unreachable, an API error, no verdict, or fixed by a
                         re-run) or real
  --pr <n>               the pull-request readiness view: pull request <n>'s checks, the
                         Reviewer's verdict, the criteria of the issues it closes, the merge
                         gate's verdict, and whether it is ready to merge, and by whom
  --needs-owner          the needs-the-Owner view: what waits on a person, each with its
                         link and reason: the pull requests ready for a person's merge, the
                         Implementer's stops, the Lead's holds, the open decisions in brief
                         pull requests, and the red lanes
  --repo <owner>/<repo>  the repository (default: this checkout's origin remote)
  --json                 print one JSON document (docs/status.md) instead of prose
  -h, --help             this text

Exit codes: 0 answered; 2 usage error; 3 could not run; 4 a view's reads didn't complete, so
it has no answer (docs/status.md).

Needs \`gh\` and a token that can read the repository. gh takes its token from GH_TOKEN, then
GITHUB_TOKEN, then its stored login; the command says on standard error which one it used and
whose it is.`;

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} GhResult
 * @typedef {{
 *   git: (args: string[]) => GhResult,
 *   gh: (args: string[]) => Promise<GhResult>,
 *   reader: () => import('../scripts/status/reader.mjs').Reader,
 *   env: Record<string, string | undefined>,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   release: () => string,
 *   now: () => Date,
 * }} Deps
 */

/** @type {Deps} */
export const realDeps = {
  git: (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
  },
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
  reader: () => ghReader(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  release: kanonRelease,
  now: () => new Date(),
};

/** A positive issue or pull-request number; throws naming the flag. @param {string} flag @param {string} v */
const number = (flag, v) => {
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`${flag} takes an issue or pull-request number, not "${v}"`);
  return Number(v);
};

/**
 * Parses `kanon status`'s arguments. Throws with a message naming the problem.
 * @param {string[]} argv
 */
export const parseArgs = (argv) => {
  /** @type {{ repo: string, project: number | null, release: boolean, pr: number | null, lanes: boolean, needsOwner: boolean, json: boolean, help: boolean }} */
  const opts = { repo: '', project: null, release: false, pr: null, lanes: false, needsOwner: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      if (inline === undefined && v.startsWith('-')) throw new Error(`${flag} needs a value, not the flag "${v}"`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--repo') opts.repo = value();
    else if (flag === '--project') opts.project = number(flag, value());
    else if (flag === '--release' && inline === undefined) opts.release = true;
    else if (flag === '--pr') opts.pr = number(flag, value());
    else if (flag === '--lanes' && inline === undefined) opts.lanes = true;
    else if (flag === '--needs-owner' && inline === undefined) opts.needsOwner = true;
    else if (flag === '--json') opts.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (opts.help && opts.json) throw new Error('--help and --json contradict each other; give one');
  if (opts.help) return opts;
  if (opts.repo && !isRepo(opts.repo)) throw new Error(`--repo takes <owner>/<repo>, not "${opts.repo}"`);
  if (opts.project === null && !opts.release && opts.pr === null && !opts.lanes && !opts.needsOwner) throw new Error('name a view to read: --project <n>, --release, --pr <n>, --lanes or --needs-owner');
  return opts;
};

/** @param {Deps} deps @param {number} exitCode @param {string} error */
const errorDocument = (deps, exitCode, error) => ({ schema: SCHEMA, kanon: deps.release(), status: 'error', exitCode, error });

/** Stops the command with a message: it can't run. */
class StatusError extends Error {}

/**
 * The document `kanon status` prints, or throws `StatusError` when it can't run.
 * @param {Deps} deps @param {ReturnType<typeof parseArgs>} opts
 */
async function document(deps, opts) {
  let repo = opts.repo;
  if (!repo) {
    const origin = deps.git(['remote', 'get-url', 'origin']);
    repo = (origin.status === 0 && remoteRepo(origin.stdout)) || '';
    if (!repo) throw new StatusError('this directory is not a checkout with an origin remote on GitHub; pass --repo <owner>/<repo>');
  }
  const who = await whoami(deps.gh, deps.env);
  deps.err(who.line);
  if (who.refusal) throw new StatusError(who.refusal.join(' '));
  const readAt = deps.now().toISOString();
  const reader = deps.reader();
  /** @type {Record<string, object>} */
  const views = {};
  const reads = { reader, repo, readAt };
  if (opts.project !== null) {
    const n = opts.project;
    views.project = await section(() => VIEWS.project({ ...reads, n }));
  }
  if (opts.release) views.release = await section(() => VIEWS.release(reads));
  if (opts.pr !== null) {
    const n = opts.pr;
    views.pr = await section(() => VIEWS.pr({ ...reads, n }));
  }
  if (opts.lanes) views.lanes = await section(() => VIEWS.lanes(reads));
  if (opts.needsOwner) views.needsOwner = await section(() => VIEWS.needsOwner(reads));
  const incomplete = Object.values(views).some((v) => 'error' in v);
  const exitCode = incomplete ? EXIT.incomplete : EXIT.ok;
  return { schema: SCHEMA, kanon: deps.release(), status: incomplete ? 'incomplete' : 'ok', exitCode, repo, readAt, ...views };
}

/**
 * `kanon status`. Returns the exit code (`EXIT`).
 * @param {string[]} argv @param {Partial<Deps>} [overrides]
 */
export const status = async (argv, overrides = {}) => {
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
      deps.err(`kanon status: ${message}`);
      deps.err(USAGE);
    }
    return EXIT.usage;
  }
  if (opts.help) {
    deps.out(USAGE);
    return EXIT.ok;
  }
  /** @type {Awaited<ReturnType<typeof document>>} */
  let doc;
  try {
    doc = await document(deps, opts);
  } catch (e) {
    const message = e instanceof StatusError ? e.message : `stopped on an unexpected error: ${/** @type {Error} */ (e).message}`;
    if (opts.json) deps.out(JSON.stringify(errorDocument(deps, EXIT.error, message), null, 2));
    else deps.err(`kanon status: ${message}`);
    return EXIT.error;
  }
  if (opts.json) deps.out(JSON.stringify(doc, null, 2));
  else for (const line of prose(doc)) deps.out(line);
  return doc.exitCode;
};

/**
 * The document as a person reads it: the same result, in the order the document holds it.
 * @param {Awaited<ReturnType<typeof document>>} doc
 * @returns {string[]}
 */
export function prose(doc) {
  const lines = [`${doc.repo}, read at ${doc.readAt}`];
  if ('project' in doc) lines.push('', ...projectProse(/** @type {any} */ (doc.project)));
  if ('release' in doc) lines.push('', ...releaseProse(/** @type {any} */ (doc.release)));
  if ('pr' in doc) lines.push('', ...prProse(/** @type {any} */ (doc.pr)));
  if ('lanes' in doc) lines.push('', ...lanesProse(/** @type {any} */ (doc.lanes)));
  if ('needsOwner' in doc) lines.push('', ...needsOwnerProse(/** @type {any} */ (doc.needsOwner)));
  return lines;
}

/** @param {any} n the needs-the-Owner section */
function needsOwnerProse(n) {
  if ('error' in n) return [`The needs-the-Owner view has no answer: ${n.error}`];
  const count = n.merges.length + n.stops.length + n.holds.length + n.decisions.length + n.lanes.length;
  const lines = [count ? `Needs a person: ${count} thing(s)` : 'Needs a person: nothing'];
  for (const m of n.merges) lines.push(`  Merge #${m.number} ${m.title}: ${m.reason} ${m.url}`);
  for (const s of n.stops) lines.push(`  Stopped #${s.number} ${s.title}: ${s.reasons.join(', ')} ${s.url}`);
  for (const h of n.holds) lines.push(`  Held by the Lead #${h.number} ${h.title} ${h.url}`);
  for (const d of n.decisions) lines.push(`  Decide #${d.number}, decision ${d.n} in ${d.brief}: ${d.headline} ${d.url}`);
  for (const l of n.lanes) lines.push(`  Red lane ${l.file}: ${l.failed} failed of ${l.decisive} decisive ${l.url}`);
  return lines;
}

/** @param {any} l the lane-health section */
function lanesProse(l) {
  if ('error' in l) return [`The lane-health view has no answer: ${l.error}`];
  const lines = [`Lane health: ${l.callers.length} lane caller(s) on ${l.branch}, the last ${l.window} runs of each`];
  for (const c of l.callers) {
    lines.push(`  ${c.file}  ${c.health}${c.health === c.status ? '' : ` (the health check says ${c.status})`}, ${c.failed} failed of ${c.decisive} decisive`);
    for (const f of c.failures) {
      lines.push(`       run ${f.run}${f.attempt > 1 ? ` attempt ${f.attempt}` : ''} ${f.conclusion}: ${f.class}${f.reason ? `, ${f.reason}` : ''}${f.url ? ` ${f.url}` : ''}`);
    }
  }
  return lines;
}

/** @param {any} p the readiness section */
function prProse(p) {
  if ('error' in p) return [`The pull-request readiness view has no answer: ${p.error}`];
  const r = p.readiness;
  const whose = r.by === 'merger' ? "the Merger's to merge" : "a person's to merge";
  const lines = [
    `Pull request #${p.number}: ${p.title} (${p.state.toLowerCase()}${p.draft ? ', draft' : ''}, by ${p.author}, head ${p.head.slice(0, 7)})`,
    `  ${r.ready ? 'Ready' : 'Not ready'}, ${whose}: ${r.why}`,
  ];
  if (r.lacks.length) lines.push(`  Lacks: ${r.lacks.join(', ')}`);
  lines.push(`  Merge gate: ${p.verdict.action} (${p.verdict.rule}): ${p.verdict.why}`);
  const c = p.checks;
  lines.push(`  Checks: ${c.relevant.length} relevant; ${c.pending.length} pending, ${c.cancelled.length} cancelled, ${c.failed.length} failed`);
  for (const [what, names] of [['pending', c.pending], ['cancelled', c.cancelled], ['failed', c.failed]]) {
    if (names.length) lines.push(`       ${what}: ${names.join(', ')}`);
  }
  lines.push(p.review
    ? `  Review: ${p.review.state.toLowerCase().replace('_', ' ')} on ${p.review.commit.slice(0, 7)}, ${p.review.current ? 'current' : 'not the head, so not current'}`
    : '  Review: the Reviewer has given no verdict');
  for (const i of p.closes) {
    lines.push(`  Closes #${i.number}${i.acs.length ? '' : ', which cites no criterion'}`);
    for (const a of i.acs) lines.push(`       ${a.id} ${a.clause ?? 'not in the spec layer'}${a.declared ? '' : ', mentioned only'}`);
  }
  for (const d of p.decisions ?? []) lines.push(`  Open decision ${d.n} in ${d.brief}: ${d.headline}`);
  return lines;
}

/** @param {any} p the project section */
function projectProse(p) {
  if ('error' in p) return [`The project view has no answer: ${p.error}`];
  const lines = [`Project #${p.project}: phase ${p.phase} (brief ${p.brief.path} on ${p.branch})`];
  if (p.brief.state === 'missing') lines.push(`  No brief at ${p.brief.path} on ${p.branch}.`);
  if (p.brief.state === 'unparseable') {
    lines.push(`  The brief's decomposition doesn't parse${p.brief.residue.length ? `: ${p.brief.residue.join(' / ')}` : '.'}`);
  }
  if (p.gating.length) lines.push(`  Gating work: ${p.gating.map((/** @type {number} */ n) => `#${n}`).join(', ')}`);
  if (p.hold) lines.push(`  Held: \`${p.hold.label}\`, ${p.hold.by === 'lead' ? "the Lead's hold" : "a person's"}`);
  if (p.environment) lines.push(`  Reference environment: ${p.environment}`);
  for (const i of p.items ?? []) {
    const prs = [i.prs.open.length ? `open ${i.prs.open.map((/** @type {number} */ n) => `#${n}`).join(', ')}` : '', i.prs.merged.length ? `merged ${i.prs.merged.map((/** @type {number} */ n) => `#${n}`).join(', ')}` : ''].filter(Boolean);
    lines.push(`  ${i.key}  ${i.title}: ${i.issue ? `#${i.issue.number} ${i.issue.state.toLowerCase()}` : 'not filed'}${prs.length ? `; ${prs.join('; ')}` : ''}`);
    for (const d of i.dependsOn) lines.push(`       depends on ${d.key}${d.issue ? ` (#${d.issue}, ${String(d.state).toLowerCase()})` : ', not filed'}`);
    for (const a of i.acs) {
      lines.push(`       ${a.id} ${a.clause ?? 'not in the spec layer'}, ${a.tested ? `tested by ${a.tests.join(', ')}` : 'no test cites it'}`);
    }
    for (const s of i.stops) lines.push(`       can't proceed: ${s.reason}, ${s.detail}`);
  }
  for (const n of p.notes) lines.push(`  Note: ${n}`);
  return lines;
}

/** @param {any} r the release section */
function releaseProse(r) {
  if ('error' in r) return [`The release view has no answer: ${r.error}`];
  const lines = [`Releases (declarations on ${r.branch})`];
  if (!r.releasePrs.length) lines.push('  No open release pull request.');
  for (const p of r.releasePrs) lines.push(`  Release pull request #${p.number}: ${p.title} (${p.url})`);
  lines.push(r.latest ? `  Latest release: ${r.latest.tag}, published ${r.latest.publishedAt}` : '  No release yet.');
  lines.push(r.preRelease ? `  Latest pre-release: ${r.preRelease.tag}, published ${r.preRelease.publishedAt}, ${r.preRelease.ageHours}h ago` : '  No pre-release.');
  if (!r.deploys.length) lines.push('  No environment declared in the adoption record\'s ## Deploy.');
  for (const d of r.deploys) {
    const where = `  ${d.environment}`;
    if (d.job === null) lines.push(`${where}: the adoption record names no deploy job for it in ${d.workflow}`);
    else if (d.last) lines.push(`${where}: ${d.last.tag} ${d.last.outcome} (${d.workflow}, job \`${d.job}\`, ${d.last.url})`);
    else lines.push(`${where}: no deploy among the latest releases' runs of ${d.workflow} (job \`${d.job}\`)`);
  }
  const p = r.promotion;
  if (p) {
    lines.push(`  Promotion (${p.workflow}): ${p.decision}${p.candidate ? `, ${p.candidate}` : ''}: ${p.why}`);
    for (const g of p.gates) lines.push(`       ${g.title}: ${g.skipped ? 'skipped' : g.pass ? 'pass' : 'hold'}, ${g.evidence}`);
  }
  return lines;
}
