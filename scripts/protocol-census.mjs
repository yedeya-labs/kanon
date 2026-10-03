// Which live artifacts still carry an old spelling of a protocol string (#53).
//
// `lib/protocol-spellings.mjs` keeps reading the old spellings until this says none are
// left, so the day they are dropped is measured, not assumed. Run it in the adopter's
// checkout, with `gh` authenticated for its repository:
//
//   GITHUB_REPOSITORY=<owner>/<repo> node "$KANON/scripts/protocol-census.mjs"
//
// It reads what a reader of an old spelling would misread if the spelling were dropped:
//   · the adopter's caller workflows, by their `name:` (the merge gate's check names);
//   · every open pull request: its comments (the Merger's markers and escalation header),
//     its checks (the caller names, on runs already made) and the failed runs on its head
//     (the retry breadcrumbs, which matter while that head can still be retried);
//   · every open issue's body (the Lead's adoption sentence);
//   · every branch (the split branch).
//
// Exit 0 when nothing carries an old spelling, 1 when something does (each one printed),
// and 2 when a read failed: an unread artifact is never counted as clean.
//
// NODE BUILTINS ONLY, like the lanes' other scripts.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LEGACY } from './lib/protocol-spellings.mjs';

/**
 * Every old spelling a live artifact carries. PURE.
 *
 * @param {{callers?: {file: string, name: string}[], prs?: any[], issues?: any[], branches?: string[],
 *          failedJobs?: Record<string, any[]>}} world `failedJobs` is keyed by PR number: the jobs
 *          of every failed run on that PR's head.
 * @returns {{protocol: string, where: string, spelling: string}[]}
 */
export function censusOf({ callers = [], prs = [], issues = [], branches = [], failedJobs = {} }) {
  /** @type {{protocol: string, where: string, spelling: string}[]} */
  const found = [];
  /** @param {string} protocol @param {string} where @param {string} spelling */
  const add = (protocol, where, spelling) => found.push({ protocol, where, spelling });
  const legacyWorkflows = [...LEGACY.selfChecks, ...LEGACY.reviewEventChecks.map((r) => r.workflow)];

  for (const c of callers) {
    if (legacyWorkflows.includes(c.name)) add('caller name', c.file, c.name);
  }
  for (const pr of prs) {
    const at = `PR #${pr.number}`;
    for (const c of pr.comments ?? []) {
      const body = String(c?.body ?? '');
      for (const m of LEGACY.mergerMarkers) if (body.includes(`<!-- ${m}:`)) add('merger marker', at, `<!-- ${m}:…`);
      for (const h of LEGACY.escalationHeaders) if (body.includes(h)) add('escalation header', at, h);
    }
    for (const check of pr.statusCheckRollup ?? []) {
      if (legacyWorkflows.includes(check?.workflowName)) add('caller name', `${at} (a check on its head)`, check.workflowName);
    }
    for (const p of LEGACY.splitPrefixes) {
      if (String(pr.headRefName ?? '').startsWith(p)) add('split branch', at, pr.headRefName);
    }
    for (const job of failedJobs[pr.number] ?? []) {
      for (const s of job?.steps ?? []) {
        if (LEGACY.retrySteps.includes(s?.name) && s?.conclusion === 'success') {
          add('retry breadcrumb', `${at} (job ${job.name})`, s.name);
        }
      }
    }
  }
  for (const i of issues) {
    for (const by of LEGACY.adoptedBy) {
      if (new RegExp(`Adopted into project #\\d+ by ${by}\\b`).test(String(i.body ?? ''))) {
        add('adoption note', `issue #${i.number}`, `… by ${by}`);
      }
    }
  }
  for (const b of branches) {
    for (const p of LEGACY.splitPrefixes) if (b.startsWith(p)) add('split branch', `branch ${b}`, b);
  }
  return found;
}

/** The adopter's caller workflows and their `name:`, from the working directory. */
export function callersIn(dir = '.github/workflows') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) => {
      const m = /^name:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, f), 'utf8'));
      return m ? [{ file: join(dir, f), name: String(m[1]).replace(/^(['"])(.*)\1$/, '$2') }] : [];
    });
}

/**
 * Everything `censusOf` reads, from GitHub. Throws on any failed read.
 *
 * @param {string} repo
 * @param {{json?: (args: string[]) => any}} [io]
 */
export function readWorld(repo, { json = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) } = {}) {
  const prs = json(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '1000',
    '--json', 'number,headRefName,headRefOid,comments,statusCheckRollup']);
  const issues = json(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '5000', '--json', 'number,body']);
  const branches = json(['api', '--paginate', '--slurp', `repos/${repo}/branches?per_page=100`]).flat().map((/** @type {any} */ b) => b.name);
  /** @type {Record<string, any[]>} */
  const failedJobs = {};
  for (const pr of prs) {
    const runs = json(['api', `repos/${repo}/actions/runs?head_sha=${pr.headRefOid}&status=failure&per_page=100`]).workflow_runs ?? [];
    failedJobs[pr.number] = runs.flatMap((/** @type {any} */ r) => json(['api', `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`]).jobs ?? []);
  }
  return { callers: callersIn(), prs, issues, branches, failedJobs };
}

const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(String(process.argv[1]))).href; } catch { return false; }
})();
if (IS_CLI) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('protocol-census: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  let found;
  try {
    found = censusOf(readWorld(repo));
  } catch (e) {
    console.error(`protocol-census: a read failed, so nothing is known: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  for (const f of found) console.log(`${f.protocol}: ${f.where} carries ${f.spelling}`);
  console.log(found.length
    ? `${found.length} live artifact(s) still carry an old spelling; the readers must keep them.`
    : 'No live artifact carries an old spelling; the readers can drop them.');
  process.exit(found.length ? 1 : 0);
}
