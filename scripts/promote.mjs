#!/usr/bin/env node
// The promotion (plan 0009 §2, §3 and §7, step S5): a Kanon candidate, `candidate-vX.Y.Z`,
// becomes the stable release `vX.Y.Z` on the same commit once it has earned it. Run daily and on
// dispatch by `.github/workflows/promote.yml`; Kanon's own operation, as candidates are.
//
// TWO MODES, SO THE RELEASER'S TOKEN IS MINTED ONLY TO WRITE.
//   check  reads, with the workflow's read-only token: the newest candidate tag with no stable
//          release yet, its gates, the six-day spacing, and the dispatch's `hold` and `urgent`.
//          Writes each gate's verdict and evidence to the step summary, `decision=promote|hold|
//          none` to GITHUB_OUTPUT, and, to promote, the plan to `PLAN`. Exit 1 is a refusal: a
//          state the promotion must not act on (a package.json version that isn't the tag's, a
//          stable tag on another commit, `urgent` with no reason), which a person reads.
//   apply  writes, as the Releaser (plan 0005 §3.1, ADR 0013), the one bypass of the `v*` tag
//          ruleset (plan 0008 J6): the tag `vX.Y.Z` on the candidate's commit, its Release, latest,
//          with the notes of every candidate since the last stable release (`notesOf`, newest
//          first) and a line saying on what evidence it was promoted, and the major tag `v<major>`
//          moved to the same commit, as release.yml moves it on a plain release. Neither latest nor
//          the major tag ever moves back to an older release: a candidate below a newer stable tag
//          is superseded, and promoted by nothing (#1002).
//
// THE GATES are one table, `GATES`, each read from GitHub, never self-reported:
//   soak     Kanon's callers pin the candidate, through the merged pin pull request (S4's
//            `ci(deps): run Kanon on candidate vX.Y.Z`), for at least 72 hours, from its merge.
//   revert   no pull request merged to the default branch since the candidate was cut reverts one
//            the candidate contains (`revertsOf`, the metrics' revert detector).
//   bug      no open issue labelled `bug` and `sev:critical` or `sev:high` names, in its
//            `Introduced by` field (`introducedBy`), a pull request the candidate contains.
//   red      every run of Kanon's lane callers since the pins moved succeeded at its latest attempt
//            (so a run re-run green passes), or is explained (#1441): it failed with agent-classify's
//            `unavailable` notice (the model was never reached) on one of its failed jobs; or every
//            failed job carries the verdict annotation of a lane its caller calls (`VERDICT_TITLES`,
//            the red-test check saying the changed tests pass without the source change), which the
//            lane leaves only once it reached a verdict, so a lane that crashed still holds; or a
//            repository admin explained it, by run id and cause, in a comment starting with
//            `EXPLAIN_MARKER` on the pin pull request or the held issue (`explanations`), which the
//            evidence quotes. An edited explanation counts for nothing. Each red conclusion is listed
//            by itself (`status=failure`, …): GitHub's filter matches the latest attempt, so a run
//            re-run green drops out, and the green runs are counted, never read. A red listing
//            GitHub truncates (more runs than were read, or its 1,000-result cap) holds.
//   e2e      the end-to-end gate (plan 0012 §8.2, its step E11): the candidate's commit carries a
//            completed `kanon-e2e` check run by the Reporter App, matched by its App id
//            (`REPORTER_APP_ID`, the id the App register records), and the latest one concluded
//            `success`; and the harness run it links by its `external_id` (`<run id>-<attempt>`)
//            is a run of the harness's `e2e.yml` on the harness's default branch, recorded for
//            this candidate's tag and commit (in its `start` job's name, `startJobName`), whose
//            `verdict` job, at that attempt, succeeded. The run's own conclusion is never read: a non-gating job can fail
//            it while the verdict is green. A check run of the same name by any other App is
//            ignored, so a token that can post check runs can't pass it, and a leaked Reporter
//            key can't either without a green `verdict` job in the harness (decision 18).
//   intake   the telemetry intake deployed in production accepts every row the candidate can
//            write (#1502, `docs/release.md`, "Intake first"): `infra/telemetry/intake-first.mjs`
//            compares the candidate's schema with the schema of the release intake was deployed
//            from, both read from git, and exits 0. The deployed release is the one the operator's
//            intake record names, at `KANON_INTAKE_RECORD` (`<owner>/<repo>:<path>`), which
//            promote.yml reads with a Releaser token narrowed to Contents read on that repository
//            and hands this mode as a file (`INTAKE_RECORD_FILE`). A widening holds until intake
//            is deployed from the candidate and the record names it; a narrowing holds too, since
//            deploying first doesn't help. A record that is unset, unread or names no release
//            holds. Only the CLI reads it (`intakeFromEnv`): the status view, which has neither the
//            record nor the git refs, shows the gate skipped.
// What a candidate contains is every pull request since the newest STABLE tag below it, so the
// pull requests of a candidate held and never promoted count against the next one.
// `urgent` (plan 0009 §7) skips the soak and the six-day spacing, and asks instead that a review
// ran at the candidate (`review`): a run that called the review lane at the candidate's tag, by
// its `referenced_workflows`, and whose `review` job itself succeeded (a run the filter declined
// reviewed nothing). `urgent` doesn't skip the end-to-end gate (plan 0012 decision 12), and no
// input overrides it: the only way past a red one is a fix and a new candidate. Each gate is one
// entry in `GATES`: the summary, the decision and the plan read the table.
//
// A FOURTH MODE, SO A HELD PROMOTION REACHES THE OWNER (#1441):
//   notify reads the check's outcome (`OUTCOME`) with the workflow's token, Issues write. A
//          candidate past its soak that a gate holds gets one issue, `Promotion held: <candidate>`,
//          opened by the workflow token (`HELD_AUTHOR`; a same-titled issue anyone else opened is
//          never read),
//          assigned to whoever merged its pin pull request (the Owner, who starts each soak), with
//          the gates and what unblocks each. Each later run rewrites its body, and comments only when
//          the gates holding it change, so the Owner is told once per change, not daily. It closes
//          when the candidate is promoted (`APPLIED=success`), promoted already or superseded, and
//          one for an older candidate closes once a newer candidate is the newest. A hold before the soak ends, or by the spacing or a dispatch's `hold`, is expected and opens
//          nothing.
//
// A THIRD MODE, FOR THE PIN JOB (plan 0012 §8.1, decision 2):
//   gate   reads the end-to-end gate alone for the candidate `TAG`, with a read-only token, and
//          writes `pass=true|false` to GITHUB_OUTPUT and its verdict to the step summary.
//          `release-please.yml`'s pin job opens the pin pull request only on `pass=true`, so
//          Kanon's pins, and the soak, start only on a candidate the harness passed.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, DEFAULT_BRANCH (default `main`), HOLD, URGENT, REASON, PLAN,
// OUTCOME (check, notify), INTAKE_RECORD and INTAKE_RECORD_FILE (check), APPLIED (notify), TAG
// (gate), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Node built-ins, `gh`, and `git` through intake-first.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/cli-entry.mjs';
import { trustedSearchSync } from './lib/search.mjs';
import { introducedBy, revertsOf } from './metrics/detectors.mjs';
import { renderNotice } from '../actions/agent-classify/classify-agent-result.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The soak: how long Kanon's callers pin a candidate before it may be promoted (Owner decision 2). */
export const SOAK_MS = 72 * HOUR;
/** The spacing: no second promotion within this time of the last stable release, unless `urgent`. */
export const SPACING_MS = 6 * DAY;
/** The severities that make an open bug serious enough to hold a candidate. */
export const SERIOUS = ['sev:critical', 'sev:high'];
/** A run's conclusions that count as red. `cancelled` and `skipped` are no verdict. */
export const RED = ['failure', 'timed_out', 'startup_failure'];
/** The lane whose successful run an urgent promotion needs (plan 0009 §7). */
export const REVIEW_LANE = 'agent-review.yml';
/** The review lane's job that reviews, the last segment of its name in a run's jobs (`review / review / …`). */
export const REVIEW_JOB = 'review';
/** The most results GitHub's run listing returns for one query, however many pages are read. */
export const RUN_LISTING_CAP = 1000;

/** The end-to-end check run's name, which the harness's `start` job creates (plan 0012 §5.2). */
export const E2E_CHECK = 'kanon-e2e';
/**
 * The Reporter App's id (`kanon-e2e-reporter`, plan 0012 decision 18): the one App whose
 * `kanon-e2e` check run counts. The App register, `docs/qa/agent-identities.md`, records it in
 * its `Other App` row's note, which a test holds this to.
 */
export const REPORTER_APP_ID = 5349415;
/** The harness repository (public), whose `e2e.yml` run a check run must link. */
export const HARNESS = 'kanon-e2e/harness';
/** The harness's workflow whose run judges a candidate, as a run's `path` names it. */
export const HARNESS_WORKFLOW = '.github/workflows/e2e.yml';
/** The harness run's job whose conclusion is the gate's answer, not the run's (plan 0012 §5.2). */
export const VERDICT_JOB = 'verdict';
/**
 * The name of the harness run's `start` job, which records the candidate the run tested: its tag
 * and its full commit. The gate reads it from the run's public jobs listing, since a run's
 * artifacts can't be downloaded without a token. The harness's `start` job must carry exactly this
 * name (plan 0012 E8); a run whose `start` job names another candidate, or none, holds.
 * @param {string} tag @param {string} sha
 */
export const startJobName = (tag, sha) => `start (the Reporter's check run: ${tag} at ${sha})`;
/** What every `start` job's name begins with, to say what a mismatched one records. */
const START_PREFIX = 'start (';
/** The red issue the harness's `verdict` files for a candidate (plan 0012 §8.3). @param {string} tag */
export const redIssueTitle = (tag) => `e2e: ${tag} is red`;

/**
 * The annotation a lane leaves only once it reached a verdict that fails a pull request, by the
 * lane a caller calls (#1441): a red run whose every failed job carries it is a verdict, not the
 * lane dying. The step's name is no evidence, since a script that throws fails the same step. The
 * red-test check's says the pull request's changed tests pass without its source change, which a
 * re-run says again (`scripts/red-test.mjs`'s `VERDICT_TITLE`, which a test holds this to; not
 * imported, so the promotion runs no more of the tree with the Releaser's key). A candidate cut
 * before its lane left one is explained by an admin instead.
 * @type {Record<string, string>}
 */
export const VERDICT_TITLES = { 'red-test.yml': 'Red-test verdict' };
/**
 * What a repository admin's explanation of red runs starts with, then one `- <run id>: <cause>` a
 * line (#1441). Plain words, not a hidden marker, so the Owner can type it on a phone.
 */
export const EXPLAIN_MARKER = 'Explain red:';
/** Whether a comment is an explanation: its first line is `EXPLAIN_MARKER`, in any case. @param {string} body */
const isExplanation = (body) => body.trimStart().toLowerCase().startsWith(EXPLAIN_MARKER.toLowerCase());
/** The issue a held promotion opens for its candidate (#1441). @param {string} candidate */
export const heldTitle = (candidate) => `Promotion held: ${candidate}`;
/**
 * Who opens the held issue: the workflow token. The repository is public, so anyone can open an
 * issue with the same title, and only the workflow's own is read, rewritten or closed.
 */
export const HELD_AUTHOR = 'github-actions[bot]';
/** What marks the held issue's body, with the gates holding it, so a change of gates is noticed. */
const HELD_MARKER = '<!-- kanon:promotion-held';
/** The held issue's label and bucket: Kanon's own release operation (`K-WORK-4`, `K-WORK-11`). */
export const HELD_LABEL = 'pipeline-improvement';
export const HELD_MILESTONE = 'Development Automation';

/**
 * The intake gate's comparison (#1502), run from the checkout's root as a script of its own, so
 * the status view's import closure never takes it in.
 */
export const INTAKE_FIRST = 'infra/telemetry/intake-first.mjs';
/** The repository variable naming the operator's intake record, `<owner>/<repo>:<path>`. */
export const INTAKE_VARIABLE = 'KANON_INTAKE_RECORD';
/** A record's location, as `INTAKE_VARIABLE` names it. */
export const RECORD_LOCATION = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+):(\S+)$/;
/** The record's row naming the Kanon release intake was deployed from: `| **Kanon release** | `<tag>` |`. */
const RECORD_ROW = /^\|\s*\*\*Kanon release\*\*\s*\|\s*`([^`]*)`/gm;
/** The checkout's root, where intake-first reads the refs from git. */
const TREE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Kanon's own manifest, whose version release-please's `node` type writes at each release. */
export const MANIFEST = 'package.json';

const CANDIDATE = /^candidate-v(\d+)\.(\d+)\.(\d+)$/;
const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The pin pull request's title, which S4's pin job opens (plan 0009 §6). @param {string} version */
export const pinTitle = (version) => `ci(deps): run Kanon on candidate v${version}`;

/**
 * The release an intake record says intake was deployed from: its one `**Kanon release**` row,
 * which must name a candidate or stable tag, never anything a command line could read as an option.
 * @param {string} text
 * @returns {{ ref: string } | { error: string }}
 */
export function deployedIntake(text) {
  const rows = [...String(text).matchAll(RECORD_ROW)];
  if (rows.length !== 1) return { error: `has ${rows.length === 0 ? 'no' : rows.length} \`| **Kanon release** | \`<tag>\` |\` row${rows.length === 0 ? '' : 's'}, where it needs exactly one` };
  const ref = String(rows[0]?.[1] ?? '');
  if (!CANDIDATE.test(ref) && !STABLE.test(ref)) return { error: `names ${JSON.stringify(ref)}, not a release tag (\`candidate-vX.Y.Z\` or \`vX.Y.Z\`)` };
  return { ref };
}

/**
 * The intake gate's verdict for `candidate` (#1502): from the record's location (`INTAKE_VARIABLE`),
 * its text (`null` when it wasn't read, with why in `recordError`), and `compare`, which runs
 * intake-first for the deployed release against the candidate's tag. Anything it can't read holds.
 * @param {{ location: string, record: string | null, recordError: string, candidate: string,
 *   compare: (deployed: string, release: string) => { status: number | null, stdout: string, stderr: string } }} args
 * @returns {Verdict}
 */
export function intakeVerdict({ location, record, recordError, candidate, compare }) {
  if (!location) return { pass: false, evidence: `the intake record isn't configured: set the repository variable \`${INTAKE_VARIABLE}\` to \`<owner>/<repo>:<path>\`, the operator's record of the release intake was deployed from` };
  if (!RECORD_LOCATION.test(location)) return { pass: false, evidence: `\`${INTAKE_VARIABLE}\` is ${JSON.stringify(location)}, not \`<owner>/<repo>:<path>\`` };
  if (record === null) return { pass: false, evidence: `the intake record ${location} couldn't be read: ${recordError || "the Releaser's token for its repository wasn't minted"}` };
  const parsed = deployedIntake(record);
  if ('error' in parsed) return { pass: false, evidence: `the intake record ${location} ${parsed.error}` };
  const deployed = parsed.ref;
  const r = compare(deployed, candidate);
  const lines = String(r.stdout ?? '').split('\n').filter((l) => /^\s+- /.test(l)).map((l) => l.trim().slice(2));
  const from = `intake deployed from ${deployed} (${location})`;
  if (r.status === 0) return { pass: true, evidence: `${from} accepts every row ${candidate} can write` };
  if (r.status === 1) return { pass: false, evidence: `${from} refuses rows ${candidate} can write: ${lines.join('; ')}. Deploy intake from ${candidate} first` };
  if (r.status === 3) return { pass: false, evidence: `${candidate} narrows what intake accepts, against ${from}, so deploying first doesn't help: ${lines.join('; ')}` };
  const why = String(r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status ?? 'by a signal'}`;
  return { pass: false, evidence: `comparing ${candidate} with ${from} failed: ${why}` };
}

/**
 * The CLI's intake gate: the record promote.yml wrote to `INTAKE_RECORD_FILE` (and, when its read
 * failed, why, beside it as `<file>.err`), and intake-first run in the checkout.
 * @param {Record<string, string | undefined>} env
 * @returns {(candidate: Tag) => Verdict}
 */
export function intakeFromEnv(env) {
  const file = String(env.INTAKE_RECORD_FILE ?? '');
  const record = file && existsSync(file) ? readFileSync(file, 'utf8') : null;
  const recordError = file && existsSync(`${file}.err`) ? readFileSync(`${file}.err`, 'utf8').trim().split('\n')[0] ?? '' : '';
  /** @param {string} deployed @param {string} release */
  const compare = (deployed, release) => {
    const r = spawnSync(process.execPath, [join(TREE, INTAKE_FIRST), '--deployed', deployed, '--release', release], { cwd: TREE, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
  };
  return (candidate) => intakeVerdict({ location: String(env.INTAKE_RECORD ?? '').trim(), record, recordError, candidate: candidate.name, compare });
}

/**
 * The title GitHub stores for agent-classify's `unavailable` notice. The runner splits a workflow
 * command's properties on every `,`, so a title with a comma keeps its first segment alone; the
 * same reading as doctor's `UNREACHABLE_TITLE`, which a test holds this to.
 */
export const UNREACHABLE_TITLE = (() => {
  for (const part of `title=${renderNotice('unavailable', '').title}`.split(',')) {
    const at = part.indexOf('=');
    if (at > 0) return part.slice(at + 1);
  }
  return '';
})();

/** A state the promotion must not act on; exit 1, with the reason. */
export class Refusal extends Error {}

/** An API error, with the HTTP status when `gh` named one. */
export class ApiError extends Error {
  /** @param {string} message @param {number | null} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** @typedef {(path: string, opts?: { method?: string, body?: unknown, raw?: boolean }) => any} Api */

/**
 * GitHub's REST API through `gh`, with the step's token: JSON in, JSON out; `raw` returns a file's
 * text. A failure throws `ApiError` with the status `gh` printed (deploy-gate.mjs's reader).
 * @type {Api}
 */
export const ghApi = (path, { method = 'GET', body, raw = false } = {}) => {
  const args = ['api', '-X', method, path];
  if (raw) args.push('-H', 'Accept: application/vnd.github.raw');
  if (body !== undefined) args.push('--input', '-');
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      input: body === undefined ? undefined : JSON.stringify(body),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (raw) return out;
    return out.trim() ? JSON.parse(out) : null;
  } catch (e) {
    const err = /** @type {{ stderr?: unknown, message?: string }} */ (e);
    const text = String(err?.stderr || err?.message || e).trim();
    const status = /HTTP (\d{3})/.exec(text)?.[1] ?? (/Not Found/.test(text) ? '404' : null);
    throw new ApiError(`${path}: ${text}`, status ? Number(status) : null);
  }
};

/** @param {unknown} e */
const notFound = (e) => e instanceof ApiError && e.status === 404;

/** @typedef {{ name: string, version: string, parts: number[], sha: string }} Tag */
/** @typedef {{ number: number, sha: string, mergedAt: string }} ContainedPr */
/** @typedef {{ file: string, lane: string, ref: string }} Caller */
/** @typedef {{ runs: any[], total: number, truncated: boolean }} Listing a caller's runs since the pins moved */
/**
 * @typedef {{
 *   repo: string, branch: string, now: number, urgent: boolean, api: Api,
 *   candidate: Tag, previous: Tag, cutAt: string,
 *   pin: { number: number, mergedAt: string } | null,
 *   callers: Caller[], contained: ContainedPr[],
 *   since: string,
 *   runsOf: (file: string, status: string) => Listing,
 *   completedOf: (file: string) => number,
 *   explained: Map<number, string>, ignored: string[],
 *   intake?: (candidate: Tag) => Verdict,
 * }} Context what every gate reads: the candidate, the pull requests it contains, the pin, and
 *   Kanon's lane callers; `intake`, the intake gate's reading, only where the record and the git
 *   refs are (the CLI)
 * @typedef {{ pass: boolean, evidence: string, skipped?: boolean }} Verdict
 * @typedef {{ id: string, title: string, when: 'always' | 'normal' | 'urgent', check: (ctx: Context) => Verdict }} Gate
 *   `when`: `normal` gates are skipped by `urgent`, `urgent` ones read only then
 */

/** @param {number[]} a @param {number[]} b */
const compareParts = (a, b) => [0, 1, 2].map((i) => Number(a[i]) - Number(b[i])).find((d) => d !== 0) ?? 0;

/** Every page of a listing, `per_page=100`, until a short page. @param {Api} api @param {string} path @param {(page: any) => any[]} pick */
function pages(api, path, pick = (p) => p) {
  /** @type {any[]} */
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const got = pick(api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)) ?? [];
    all.push(...got);
    if (got.length < 100) break;
  }
  return all;
}

/**
 * The repository's tags of one form, with the commit each names (an annotated tag is peeled).
 * @param {Api} api @param {string} repo @param {string} prefix @param {RegExp} form
 * @returns {Tag[]}
 */
function tagsOf(api, repo, prefix, form) {
  /** @type {any[]} */
  const refs = api(`repos/${repo}/git/matching-refs/tags/${prefix}`) ?? [];
  return refs.flatMap((r) => {
    const name = String(r?.ref ?? '').replace(/^refs\/tags\//, '');
    const m = form.exec(name);
    if (!m) return [];
    let sha = String(r?.object?.sha ?? '');
    if (r?.object?.type === 'tag') sha = String(api(`repos/${repo}/git/tags/${sha}`)?.object?.sha ?? '');
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
    return [{ name, version: parts.join('.'), parts, sha }];
  });
}

/**
 * Kanon's lane callers in a tree: the workflows that call one of `repo`'s reusable workflows at a
 * pinned ref. A commented-out line calls nothing.
 * @param {Array<{ file: string, text: string }>} workflows @param {string} repo
 * @returns {Caller[]}
 */
export function laneCallers(workflows, repo) {
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uses = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*["']?${esc}/\\.github/workflows/([\\w.-]+\\.ya?ml)@([^\\s"'#]+)`);
  return workflows.flatMap(({ file, text }) => text.split(/\r?\n/).flatMap((line) => {
    const m = uses.exec(line);
    return m ? [{ file, lane: String(m[1]), ref: String(m[2]) }] : [];
  }));
}

/** The workflows of a checkout's `.github/workflows`. @param {string} dir */
export function readWorkflows(dir = '.github/workflows') {
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
}

/**
 * The commits between two refs on the default branch, oldest first, with the pull request each
 * squash commit names in its subject, `<title> (#N)` (`K-SHIP-3`).
 * @param {Api} api @param {string} repo @param {string} base @param {string} head
 * @returns {Array<{ sha: string, message: string, date: string, pr: number | null }>}
 */
function commitsBetween(api, repo, base, head) {
  return pages(api, `repos/${repo}/compare/${base}...${head}`, (p) => p?.commits).map((c) => {
    const message = String(c?.commit?.message ?? '');
    const pr = /\(#(\d+)\)\s*$/.exec(message.split('\n')[0] ?? '')?.[1];
    return { sha: String(c?.sha ?? ''), message, date: String(c?.commit?.committer?.date ?? ''), pr: pr ? Number(pr) : null };
  });
}

/** The gates, in the order the summary shows them. @type {Gate[]} */
export const GATES = [
  {
    id: 'soak',
    title: 'Soak',
    when: 'normal',
    check: ({ candidate, pin, callers, now }) => {
      if (!pin) return { pass: false, evidence: `no merged pull request titled \`${pinTitle(candidate.version)}\`: Kanon's callers never moved to the candidate` };
      const off = callers.filter((c) => c.ref !== candidate.name);
      if (callers.length === 0) return { pass: false, evidence: 'no lane caller on the default branch pins a release' };
      if (off.length) return { pass: false, evidence: `${off.map((c) => `${c.file} pins ${c.ref}`).join(', ')}, not ${candidate.name}` };
      const elapsed = now - Date.parse(pin.mergedAt);
      const hours = Math.floor(elapsed / HOUR);
      return SOAK_MS <= elapsed
        ? { pass: true, evidence: `pinned ${hours}h, since #${pin.number} merged at ${pin.mergedAt}` }
        : { pass: false, evidence: `pinned ${hours}h of ${SOAK_MS / HOUR}, since #${pin.number} merged at ${pin.mergedAt}` };
    },
  },
  {
    id: 'revert',
    title: 'No revert',
    when: 'always',
    check: ({ api, repo, candidate, branch, contained }) => {
      const later = commitsBetween(api, repo, candidate.sha, branch).filter((c) => c.pr !== null);
      const prs = later.map((c) => ({
        number: /** @type {number} */ (c.pr),
        body: c.message,
        mergeCommitSha: c.sha,
        mergedAt: c.date,
        commits: pages(api, `repos/${repo}/pulls/${c.pr}/commits`).map((x) => ({ sha: String(x?.sha ?? ''), message: String(x?.commit?.message ?? '') })),
        files: [], closingIssues: [], timeline: [],
      }));
      const hits = contained.flatMap((item) => revertsOf({ number: item.number, mergeCommitSha: item.sha, mergedAt: item.mergedAt, commits: [], files: [], closingIssues: [], timeline: [] }, prs, { repo })
        .map((l) => `#${l.pr} reverts #${item.number}`));
      return hits.length
        ? { pass: false, evidence: hits.join(', ') }
        : { pass: true, evidence: `none of the ${prs.length} pull requests merged since the cut reverts one of the candidate's ${contained.length}` };
    },
  },
  {
    id: 'bug',
    title: 'No serious bug',
    when: 'always',
    check: ({ api, repo, contained }) => {
      const mine = new Set(contained.map((p) => p.number));
      const issues = pages(api, `repos/${repo}/issues?state=open&labels=bug`).filter((i) => !i?.pull_request);
      const serious = issues.filter((i) => (i?.labels ?? []).some((/** @type {any} */ l) => SERIOUS.includes(typeof l === 'string' ? l : l?.name)));
      const hits = serious.flatMap((i) => introducedBy(i?.body, repo).filter((n) => mine.has(n)).map((n) => `#${i.number} names #${n}`));
      return hits.length
        ? { pass: false, evidence: `open ${SERIOUS.join(' or ')} bugs introduced by the candidate: ${hits.join(', ')}` }
        : { pass: true, evidence: `${serious.length} open ${SERIOUS.join(' or ')} bugs, none introduced by the candidate's ${contained.length} pull requests` };
    },
  },
  {
    id: 'red',
    title: 'No unexplained red',
    when: 'always',
    check: ({ api, repo, callers, runsOf, completedOf, since, explained, ignored }) => {
      const files = [...new Set(callers.map((c) => c.file))];
      let count = 0;
      let unreachableRuns = 0;
      let verdictRuns = 0;
      /** @type {string[]} */
      const byPerson = [];
      /** @type {string[]} */
      const red = [];
      /** @type {string[]} */
      const truncated = [];
      for (const file of files) {
        count += completedOf(file);
        // Each red conclusion listed by itself: GitHub's `status` filter matches a run's latest
        // attempt, so a run re-run green is not listed, and the green runs, which can pass the
        // listing's cap in a soak, are never read.
        for (const conclusion of RED) {
          const listing = runsOf(file, conclusion);
          if (listing.truncated) truncated.push(`${file} ${conclusion} (read ${listing.runs.length} of ${listing.total})`);
          for (const run of listing.runs) {
            const id = Number(run.id);
            const kind = redKind(api, repo, id, callers.filter((c) => c.file === file).map((c) => c.lane));
            if (kind === 'unreachable') unreachableRuns += 1;
            else if (kind === 'verdict') verdictRuns += 1;
            else if (explained.has(id)) byPerson.push(`${file} run ${id}, explained by ${explained.get(id)}`);
            else red.push(`${file} run ${id} (${conclusion})`);
          }
        }
      }
      const accepted = `${unreachableRuns} red with the model unreachable, ${verdictRuns} red as a verdict on a pull request${byPerson.length ? `, ${byPerson.length} explained: ${byPerson.join('; ')}` : ''}`;
      const unread = ignored.length ? `; explanations not counted: ${ignored.join('; ')}` : '';
      if (truncated.length) {
        return { pass: false, evidence: `a red run listing is truncated, so a red run may be unread: ${truncated.join(', ')}${red.length ? `; unexplained red since ${since}: ${red.join(', ')}` : ''}${unread}` };
      }
      return red.length
        ? { pass: false, evidence: `unexplained red since ${since}: ${red.join(', ')}${unread}` }
        : { pass: true, evidence: `${count} completed runs of ${files.length} callers since ${since}, ${accepted}${unread}` };
    },
  },
  {
    id: 'e2e',
    title: 'End to end',
    // `always`: `urgent` doesn't skip it (plan 0012 decision 12).
    when: 'always',
    check: ({ api, repo, candidate }) => endToEnd(api, repo, candidate),
  },
  {
    id: 'intake',
    title: 'Intake accepts it',
    // `always`: an urgent fix reaches adopters' collectors as surely as a weekly one (#1502).
    when: 'always',
    check: ({ intake, candidate }) => (intake
      ? intake(candidate)
      : { pass: true, skipped: true, evidence: "not read here: only promote.yml's own run reads the intake record, and compares the schemas in git" }),
  },
  {
    id: 'review',
    title: 'A review ran green',
    when: 'urgent',
    check: ({ api, repo, candidate, callers, runsOf, since }) => {
      const files = [...new Set(callers.filter((c) => c.lane === REVIEW_LANE).map((c) => c.file))];
      for (const file of files) {
        for (const run of runsOf(file, 'success').runs) {
          // The lane the run itself called, as GitHub recorded it: the caller's head copy is a pull
          // request's for `pull_request_target`, not the one that ran.
          const lane = laneRefOf(run, repo);
          if (lane !== candidate.name || !reviewed(api, repo, Number(run.id))) continue;
          return { pass: true, evidence: `${file} run ${run.id} called ${REVIEW_LANE}@${lane}, and its \`${REVIEW_JOB}\` job succeeded` };
        }
      }
      return { pass: false, evidence: `no run of the review lane's caller since ${since} called ${REVIEW_LANE}@${candidate.name} and had its \`${REVIEW_JOB}\` job succeed` };
    },
  },
];

/**
 * The end-to-end gate (plan 0012 §8.2): the Reporter's latest `kanon-e2e` check run on the
 * candidate's commit, and the harness run it links, read from GitHub. Every hold names the check
 * run, when there is one, and the harness's red issue for the candidate (§8.3, `[ETE-34]`). A
 * read that fails throws, as the other gates' reads do, except a linked run that doesn't exist,
 * which holds.
 * @param {Api} api @param {string} repo @param {Tag} candidate
 * @returns {Verdict}
 */
export function endToEnd(api, repo, candidate) {
  // A candidate cut before this gate was built is not gated by it (plan 0012 decision 3): its own
  // commit's promotion carries no end-to-end gate.
  if (!carriesGate(api, repo, candidate)) {
    return { pass: true, evidence: `not gated: ${candidate.name}'s commit ${candidate.sha} predates the end-to-end gate, since its ${SELF} names no \`${E2E_CHECK}\` check (plan 0012 decision 3)` };
  }
  /** @param {string} why @param {any} [run] @returns {Verdict} */
  const hold = (why, run) => ({ pass: false, evidence: `${why}${run?.html_url ? `; the check run: ${run.html_url}` : ''}; ${redIssueOf(api, candidate.name)}` });
  /** @type {any[]} */
  const listed = pages(api, `repos/${repo}/commits/${candidate.sha}/check-runs?check_name=${E2E_CHECK}&app_id=${REPORTER_APP_ID}&filter=all`, (p) => p?.check_runs);
  // The App id, read on each check run: one of the same name from any other App or token is ignored.
  const mine = listed.filter((c) => c?.name === E2E_CHECK && c?.head_sha === candidate.sha && Number(c?.app?.id) === REPORTER_APP_ID);
  const others = listed.length - mine.length;
  const ignored = others ? `; ${others} more by another App or on another commit, ignored` : '';
  if (mine.length === 0) return hold(`no \`${E2E_CHECK}\` check run by the Reporter (App id ${REPORTER_APP_ID}) on ${candidate.name}'s commit ${candidate.sha}${ignored}`);
  const latest = [...mine].sort((a, b) => Number(b.id) - Number(a.id))[0];
  const named = `the Reporter's latest \`${E2E_CHECK}\` check run, ${latest.id},`;
  if (latest.status !== 'completed') return hold(`${named} is ${latest.status}, not completed`, latest);
  if (latest.conclusion !== 'success') return hold(`${named} concluded ${latest.conclusion}`, latest);
  const link = /^(\d+)-(\d+)$/.exec(String(latest.external_id ?? ''));
  if (!link) return hold(`${named} links no harness run: its external_id is ${JSON.stringify(latest.external_id ?? null)}, not <run id>-<attempt>`, latest);
  const [, id, attempt] = link;
  let run;
  try {
    run = api(`repos/${HARNESS}/actions/runs/${id}`);
  } catch (e) {
    if (notFound(e)) return hold(`${named} links the harness run ${id}, which ${HARNESS} doesn't have`, latest);
    throw e;
  }
  const where = `the harness run ${run?.html_url ?? id}`;
  if (run?.path !== HARNESS_WORKFLOW) return hold(`${named} links ${where}, a run of ${run?.path ?? 'no workflow'}, not ${HARNESS_WORKFLOW}`, latest);
  const branch = String(api(`repos/${HARNESS}`)?.default_branch ?? '');
  if (!branch || run?.head_branch !== branch || run?.head_repository?.full_name !== HARNESS) {
    return hold(`${named} links ${where}, on ${run?.head_repository?.full_name ?? '?'}'s ${run?.head_branch ?? '?'}, not ${HARNESS}'s default branch ${branch || '(unread)'}`, latest);
  }
  /** @type {any[]} */
  const jobs = pages(api, `repos/${HARNESS}/actions/runs/${id}/attempts/${attempt}/jobs`, (p) => p?.jobs);
  // The candidate the run recorded, its tag and its commit, in its `start` job's name.
  const want = startJobName(candidate.name, candidate.sha);
  if (!jobs.some((j) => j?.name === want)) {
    const starts = jobs.map((j) => String(j?.name ?? '')).filter((n) => n.startsWith(START_PREFIX));
    return hold(`${named} links ${where}, attempt ${attempt}, whose \`start\` job records ${starts.length ? starts.map((n) => JSON.stringify(n)).join(', ') : 'nothing'}, not ${JSON.stringify(want)}`, latest);
  }
  // The verdict job's own conclusion, at the attempt the check run names: never the run's.
  const verdict = jobs.find((j) => j?.name === VERDICT_JOB);
  if (verdict?.conclusion !== 'success') {
    return hold(`${named} links ${where}, attempt ${attempt}, whose \`${VERDICT_JOB}\` job ${verdict ? `concluded ${verdict.conclusion ?? verdict.status}` : 'is missing'}`, latest);
  }
  return { pass: true, evidence: `the Reporter's latest \`${E2E_CHECK}\` check run, ${latest.html_url ?? latest.id}, concluded success, linking ${where}, attempt ${attempt}, of ${HARNESS_WORKFLOW} on ${branch} for ${candidate.name}, whose \`${VERDICT_JOB}\` job succeeded` };
}

/** How many items a search answer holds; an answer with none holds 0. @param {any} answer */
const itemCount = (answer) => (Array.isArray(answer?.items) ? answer.items.length : 0);

/** This script, as the candidate's commit holds it. */
const SELF = 'scripts/promote.mjs';
/** What marks a commit's promotion as carrying the end-to-end gate: the check run's name, declared. */
const GATE_MARK = /^export const E2E_CHECK = 'kanon-e2e';$/m;

/**
 * Whether the candidate's own commit carries the end-to-end gate, in its `scripts/promote.mjs`.
 * A file the commit doesn't have carries none; any other failed read throws.
 * @param {Api} api @param {string} repo @param {Tag} candidate
 */
function carriesGate(api, repo, candidate) {
  try {
    return GATE_MARK.test(String(api(`repos/${repo}/contents/${SELF}?ref=${candidate.sha}`, { raw: true })));
  } catch (e) {
    if (notFound(e)) return false;
    throw e;
  }
}

/**
 * The harness's red issue for a candidate, `e2e: <tag> is red`, as a phrase for a hold's
 * evidence, an open one first. A search that fails says so: the gate holds either way.
 * @param {Api} api @param {string} tag
 */
function redIssueOf(api, tag) {
  const title = redIssueTitle(tag);
  try {
    // Settled before "no red issue" is said: search can answer nothing for a query with matches (kanon#1322).
    /** @type {any[]} */
    const items = trustedSearchSync(
      () => api(`search/issues?q=${encodeURIComponent(`repo:${HARNESS} is:issue in:title "${title}"`)}&per_page=100`),
      { what: `the red issue \`${title}\``, size: itemCount },
    )?.items ?? [];
    const hit = items.filter((i) => i?.title === title).sort((a, b) => Number(a?.state !== 'open') - Number(b?.state !== 'open'))[0];
    return hit ? `the red issue: ${hit.html_url} (${hit.state})` : `no red issue \`${title}\` in ${HARNESS}`;
  } catch (e) {
    return `the red issue \`${title}\` in ${HARNESS} couldn't be searched: ${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]}`;
  }
}

/**
 * The pin job's reading (plan 0012 §8.1): the end-to-end gate alone, for the candidate `TAG`.
 * @param {Record<string, string | undefined>} env
 * @param {{ api?: Api }} [deps]
 * @returns {{ candidate: string } & Verdict}
 */
export function gate(env, { api = ghApi } = {}) {
  if (!env.GITHUB_REPOSITORY) throw new Refusal('GITHUB_REPOSITORY must be set');
  const repo = String(env.GITHUB_REPOSITORY);
  const name = String(env.TAG ?? '');
  if (!CANDIDATE.test(name)) throw new Refusal(`TAG must be a candidate tag, candidate-vX.Y.Z (got ${JSON.stringify(name)})`);
  const all = tagsOf(api, repo, 'candidate-v', CANDIDATE);
  const candidate = all.find((t) => t.name === name);
  if (!candidate) throw new Refusal(`no tag ${name}`);
  // A check run completed on an older candidate, a re-run's, never moves the pins back.
  const newer = all.filter((t) => compareParts(t.parts, candidate.parts) > 0).sort((a, b) => compareParts(b.parts, a.parts))[0];
  if (newer) return { candidate: name, pass: false, evidence: `${newer.name} is a newer candidate, so ${name} is superseded: Kanon's pins never move back to it` };
  return { candidate: name, ...endToEnd(api, repo, candidate) };
}

/** The pin job's step summary. @param {{ candidate: string } & Verdict} g */
export function gateSummary(g) {
  const title = GATES.find((x) => x.id === 'e2e')?.title ?? 'End to end';
  return [
    `## The end-to-end gate: \`${g.candidate}\``,
    '',
    '| Gate | Verdict | Evidence |',
    '|---|---|---|',
    `| ${title} | ${g.pass ? 'pass' : '**hold**'} | ${g.evidence.replace(/\|/g, '\\|')} |`,
    '',
    g.pass
      ? `**Pass:** the pin job moves Kanon's pins to \`${g.candidate}\`.`
      : `**Held:** Kanon's pins stay where they are. The pin job runs again when a \`${E2E_CHECK}\` check run on \`${g.candidate}\`'s commit completes.`,
    '',
  ].join('\n');
}

/**
 * Whether a run's review job succeeded: a run the filter declined concludes `success` with that
 * job skipped, and reviewed nothing. An unreadable listing counts as no.
 * @param {Api} api @param {string} repo @param {number} id
 */
function reviewed(api, repo, id) {
  try {
    const jobs = api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`)?.jobs ?? [];
    return jobs.some((/** @type {any} */ j) => String(j?.name ?? '').split(' / ').pop() === REVIEW_JOB && j?.conclusion === 'success');
  } catch {
    return false;
  }
}

/**
 * The ref at which a run called the review lane, from the run's `referenced_workflows`
 * (`owner/repo/.github/workflows/agent-review.yml@<ref>`), or null when it called none.
 * @param {any} run @param {string} repo
 */
export function laneRefOf(run, repo) {
  const prefix = `${repo}/.github/workflows/${REVIEW_LANE}@`;
  const hit = (run?.referenced_workflows ?? []).map((/** @type {any} */ w) => String(w?.path ?? '')).find((/** @type {string} */ p) => p.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/**
 * Why a red run is red, from its latest attempt's failed jobs: `unreachable` when one carries
 * agent-classify's `unavailable` notice; `verdict` when every one carries the verdict annotation of
 * a lane its caller calls (`VERDICT_TITLES`); otherwise `red`. A read that fails is `red`, so the
 * gate holds rather than guess.
 * @param {Api} api @param {string} repo @param {number} id @param {string[]} lanes
 * @returns {'unreachable' | 'verdict' | 'red'}
 */
export function redKind(api, repo, id, lanes) {
  try {
    const jobs = api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`)?.jobs ?? [];
    const failed = jobs.filter((/** @type {any} */ job) => job?.conclusion === 'failure');
    const titles = failed.map((/** @type {any} */ job) => new Set((api(`repos/${repo}/check-runs/${Number(job.id)}/annotations?per_page=100`) ?? []).map((/** @type {any} */ a) => String(a?.title ?? ''))));
    if (titles.some((/** @type {Set<string>} */ s) => s.has(UNREACHABLE_TITLE))) return 'unreachable';
    const verdicts = lanes.flatMap((l) => (VERDICT_TITLES[l] ? [VERDICT_TITLES[l]] : []));
    if (titles.length > 0 && titles.every((/** @type {Set<string>} */ s) => verdicts.some((v) => s.has(v)))) return 'verdict';
    return 'red';
  } catch {
    return 'red';
  }
}

/**
 * The red runs a repository admin explained (#1441), from the comments on the issues and pull
 * requests `numbers` names: a comment starting with `EXPLAIN_MARKER`, by a user whose permission is
 * `admin`, and never edited (people with write access, the agents' Apps among them, can edit another
 * person's comment), names one run a line, `- <run id>: <cause>`. Every other marked comment is
 * listed in `ignored`, with why, for the evidence.
 * @param {Api} api @param {string} repo @param {number[]} numbers
 * @returns {{ explained: Map<number, string>, ignored: string[] }}
 */
export function explanations(api, repo, numbers) {
  /** @type {Map<number, string>} */
  const explained = new Map();
  /** @type {string[]} */
  const ignored = [];
  /** @type {Map<string, 'admin' | 'not' | 'unread'>} */
  const roles = new Map();
  /** A user's role, `unread` when the permission read failed, which holds like `not`. @param {string} login */
  const roleOf = (login) => {
    if (!roles.has(login)) {
      try {
        roles.set(login, api(`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)?.permission === 'admin' ? 'admin' : 'not');
      } catch {
        roles.set(login, 'unread');
      }
    }
    return roles.get(login);
  };
  for (const n of numbers) {
    /** @type {any[]} */
    let comments = [];
    try {
      comments = pages(api, `repos/${repo}/issues/${n}/comments`);
    } catch {
      ignored.push(`#${n}: its comments could not be read`);
    }
    for (const c of comments) {
      const body = String(c?.body ?? '');
      if (!isExplanation(body)) continue;
      const login = String(c?.user?.login ?? '');
      const role = c?.user?.type === 'Bot' || !login ? 'not' : roleOf(login);
      if (role === 'unread') {
        ignored.push(`#${n}: @${login}'s permission could not be read, so the explanation can't be checked`);
        continue;
      }
      if (role !== 'admin') {
        ignored.push(`#${n}: @${login} is not a repository admin`);
        continue;
      }
      if (c?.updated_at && c?.created_at && c.updated_at !== c.created_at) {
        ignored.push(`#${n}: @${login}'s explanation was edited after it was posted, so post a new one`);
        continue;
      }
      for (const line of body.split('\n')) {
        const m = /^\s*[-*]\s*(\d+)\s*:\s*(\S.*?)\s*$/.exec(line);
        if (m) explained.set(Number(m[1]), `@${login} on #${n}: ${m[2]}`);
      }
    }
  }
  return { explained, ignored };
}

/**
 * The open issues held promotions opened, for any candidate: the workflow token's alone.
 * @param {Api} api @param {string} repo
 * @returns {Array<{ number: number, title: string, body: string }>}
 */
export function heldIssues(api, repo) {
  return pages(api, `repos/${repo}/issues?state=open&creator=${encodeURIComponent(HELD_AUTHOR)}`)
    .filter((i) => !i?.pull_request && i?.user?.login === HELD_AUTHOR && String(i?.title ?? '').startsWith(heldTitle('')))
    .map((i) => ({ number: Number(i.number), title: String(i.title), body: String(i.body ?? '') }));
}

/**
 * The open issue a held promotion opened for `candidate`, if any.
 * @param {Api} api @param {string} repo @param {string} candidate
 * @returns {{ number: number, title: string, body: string } | null}
 */
export function heldIssue(api, repo, candidate) {
  return heldIssues(api, repo).find((i) => i.title === heldTitle(candidate)) ?? null;
}

/** @param {unknown} v */
const truthy = (v) => /^(true|1|yes)$/i.test(String(v ?? '').trim());

/**
 * @typedef {{ tag: string, candidate: string, sha: string, major: string, notes: string, resume: boolean, publish: boolean, latest: boolean, moveMajor: boolean }} Plan
 *   `resume`: the stable tag exists already; `publish`: the Release is still to publish; `latest`:
 *   it is published as GitHub's latest; `moveMajor`: the major tag moves to it. `latest` is false
 *   only when a newer stable release exists; `moveMajor` is false then too, and also when the major
 *   tag is on the candidate's commit already. Neither moves back
 * @typedef {{
 *   decision: 'promote' | 'hold' | 'none',
 *   why: string,
 *   candidate?: string,
 *   gates: Array<{ id: string, title: string, skipped: boolean } & Verdict>,
 *   plan?: Plan,
 *   pin?: number,
 * }} Outcome `pin`: the candidate's merged pin pull request, whose merger the held issue is
 *   assigned to
 */

/**
 * The check: what to do with the newest candidate, and why. Throws `Refusal` on a state the
 * promotion must not act on.
 * @param {Record<string, string | undefined>} env
 * @param {{ api?: Api, now?: number, workflows?: Array<{ file: string, text: string }>, intake?: (candidate: Tag) => Verdict }} [deps]
 *   `intake`: the intake gate's reading; without it the gate is skipped (the status view)
 * @returns {Outcome}
 */
export function check(env, { api = ghApi, now = Date.now(), workflows, intake } = {}) {
  if (!env.GITHUB_REPOSITORY) throw new Refusal('GITHUB_REPOSITORY must be set');
  const repo = String(env.GITHUB_REPOSITORY);
  const branch = env.DEFAULT_BRANCH || 'main';
  const urgent = truthy(env.URGENT);
  const reason = String(env.REASON ?? '').trim();
  const hold = truthy(env.HOLD);
  if (urgent && !reason) throw new Refusal('`urgent` needs a reason: it skips the soak and the six-day spacing, and the reason goes into the stable Release\'s notes (plan 0009 §7)');

  const candidates = tagsOf(api, repo, 'candidate-v', CANDIDATE).sort((a, b) => compareParts(b.parts, a.parts));
  const stable = tagsOf(api, repo, 'v', STABLE);
  const candidate = candidates[0];
  if (!candidate) return { decision: 'none', why: 'no candidate tag', gates: [] };
  const tag = `v${candidate.version}`;
  const major = `v${candidate.parts[0]}`;

  const promoted = stable.find((t) => t.version === candidate.version);
  // A stable release above the candidate, made by hand or by plan 0009 §3's fallback to (A): latest
  // and the major tag are on it, and stay there.
  const newer = stable.filter((t) => compareParts(t.parts, candidate.parts) > 0).sort((a, b) => compareParts(b.parts, a.parts))[0];
  if (promoted && promoted.sha !== candidate.sha) {
    throw new Refusal(`${tag} names ${promoted.sha}, not ${candidate.name}'s commit ${candidate.sha}: a stable tag is only ever the candidate's commit, so read what moved it`);
  }

  // The commit's own version: the tag must name what the commit says it is (`package.json`, which
  // release-please's `node` type writes).
  let version;
  try {
    version = JSON.parse(String(api(`repos/${repo}/contents/${MANIFEST}?ref=${candidate.sha}`, { raw: true }))).version;
  } catch (e) {
    throw new Refusal(`can't read ${MANIFEST} at ${candidate.name}'s commit ${candidate.sha}: ${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]}`);
  }
  if (version !== candidate.version) {
    throw new Refusal(`${candidate.name}'s commit ${candidate.sha} says it is version ${version} in ${MANIFEST}, not ${candidate.version}: a tag must name the version its commit carries`);
  }

  /** @param {string} name */
  const releaseOf = (name) => {
    try {
      return api(`repos/${repo}/releases/tags/${name}`);
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  };
  const candidateRelease = releaseOf(candidate.name);
  if (!candidateRelease) throw new Refusal(`${candidate.name} has no Release: a candidate is tagged with its pre-release, whose notes the stable Release takes`);
  // The newest stable release below the candidate: what adopters run before this one. What the
  // candidate contains, and what its notes cover, both start there, not at the previous candidate.
  const previous = stable.filter((t) => compareParts(t.parts, candidate.parts) < 0).sort((a, b) => compareParts(b.parts, a.parts))[0];
  /**
   * The stable Release's notes: the Release body of every candidate since the newest stable release
   * below it, newest first, this one's included. release-please writes each candidate's changelog
   * from the previous candidate tag, so a candidate held and never promoted has changes, breaking
   * ones too, that only its own pre-release lists; an adopter's Dependabot jumps from the last
   * stable release to this one and never reads that pre-release. A single candidate's notes are
   * its own body, unchanged.
   */
  const notesOf = () => {
    const superseded = candidates.filter((t) => compareParts(t.parts, candidate.parts) < 0 && (!previous || compareParts(t.parts, previous.parts) > 0));
    const bodies = [String(candidateRelease.body ?? ''), ...superseded.map((t) => {
      const release = releaseOf(t.name);
      if (!release) throw new Refusal(`${t.name}, a candidate since ${previous ? previous.name : 'the start'} that was never promoted, has no Release, so ${tag}'s notes can't cover its changes`);
      return String(release.body ?? '');
    })];
    return bodies.map((b, i) => (i < bodies.length - 1 ? b.trimEnd() : b)).join('\n\n');
  };

  if (promoted) {
    // Interrupted after the tag, or after the Release: finish it, since the tag is already what
    // adopters see. The major tag moves only to the newest stable release, never back.
    const published = Boolean(releaseOf(tag));
    let majorAt = '';
    try {
      majorAt = String(api(`repos/${repo}/git/ref/tags/${major}`)?.object?.sha ?? '');
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    const moveMajor = majorAt !== candidate.sha && !newer;
    if (published && !moveMajor) return { decision: 'none', why: `${candidate.name} is promoted already, as ${tag}`, candidate: candidate.name, gates: [] };
    const left = published ? `${tag} and its Release are on ${candidate.name}'s commit, but ${major} is not` : `${tag} is on ${candidate.name}'s commit with no Release`;
    // `hold` holds this too: finishing publishes the Release as latest and moves the major tag,
    // which is what reaches adopters (#1054). There are no gates to report, since the tag is out.
    if (hold) return { decision: 'hold', why: `held by the dispatch's \`hold\`: ${left}; the next run without \`hold\` finishes it`, candidate: candidate.name, gates: [] };
    return {
      decision: 'promote',
      why: `${left}: finishing that promotion`,
      candidate: candidate.name,
      gates: [],
      plan: { tag, candidate: candidate.name, sha: candidate.sha, major, notes: notesOf(), resume: true, publish: !published, latest: !newer, moveMajor },
    };
  }

  if (newer) {
    return { decision: 'none', why: `${newer.name} is a newer stable release, so ${candidate.name} is superseded: promoting it would move ${major} and the latest Release back`, candidate: candidate.name, gates: [] };
  }

  // From the newest STABLE release below it, not the previous candidate: a candidate held and
  // never promoted reaches adopters inside this one, so its pull requests are this one's too.
  if (!previous) throw new Refusal(`no stable release before ${candidate.name}, so the pull requests it contains can't be read`);
  const contained = commitsBetween(api, repo, previous.name, candidate.sha)
    .flatMap((c) => (c.pr === null ? [] : [{ number: c.pr, sha: c.sha, mergedAt: c.date }]));

  const cutAt = String(candidateRelease.created_at ?? '');
  // Settled before the soak reads no pin: search can answer nothing for a query with matches (kanon#1322),
  // and a missing pin holds the promotion.
  /** @type {any[]} */
  const found = trustedSearchSync(
    () => api(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged in:title "${pinTitle(candidate.version)}"`)}&per_page=100`),
    { what: `the pin pull request \`${pinTitle(candidate.version)}\``, size: itemCount },
  )?.items ?? [];
  const pinPr = found
    .filter((i) => i?.title === pinTitle(candidate.version) && i?.pull_request?.merged_at)
    .sort((a, b) => Date.parse(a.pull_request.merged_at) - Date.parse(b.pull_request.merged_at))[0];
  const pin = pinPr ? { number: Number(pinPr.number), mergedAt: String(pinPr.pull_request.merged_at) } : null;
  const since = pin?.mergedAt ?? cutAt;

  /** @param {string} file */
  const runsPath = (file) => `repos/${repo}/actions/workflows/${file}/runs?created=${encodeURIComponent(`>=${since}`)}`;
  /** @type {Map<string, Listing>} */
  const runs = new Map();
  /** A caller's runs since the pins moved whose latest attempt has `status`. @param {string} file @param {string} status @returns {Listing} */
  const runsOf = (file, status) => {
    const key = `${file} ${status}`;
    if (!runs.has(key)) {
      /** @type {any[]} */
      const all = [];
      let total = 0;
      for (let n = 1; n * 100 <= RUN_LISTING_CAP; n += 1) {
        const got = api(`${runsPath(file)}&status=${status}&per_page=100&page=${n}`);
        if (n === 1) total = Number(got?.total_count ?? 0);
        const list = got?.workflow_runs ?? [];
        all.push(...list);
        if (list.length < 100) break;
      }
      total = Math.max(total, all.length);
      runs.set(key, { runs: all, total, truncated: all.length < total || all.length >= RUN_LISTING_CAP });
    }
    return /** @type {Listing} */ (runs.get(key));
  };
  /** How many runs completed since the pins moved, by the listing's count. @param {string} file */
  const completedOf = (file) => Number(api(`${runsPath(file)}&status=completed&per_page=1`)?.total_count ?? 0);

  // An admin's explanations of red runs: on the pin pull request, or on the issue a held promotion
  // opened for this candidate, where the Owner is told of the hold (#1441).
  const openHeld = heldIssue(api, repo, candidate.name);
  const { explained, ignored } = explanations(api, repo, [pin?.number, openHeld?.number].filter((n) => typeof n === 'number'));

  /** @type {Context} */
  const ctx = {
    repo, branch, now, urgent, api, candidate, previous, cutAt, pin, contained, since, runsOf, completedOf, explained, ignored, intake,
    callers: laneCallers(workflows ?? readWorkflows(), repo),
  };
  const gates = GATES.filter((g) => g.when !== (urgent ? 'normal' : 'urgent')).map((g) => ({ id: g.id, title: g.title, skipped: false, ...g.check(ctx) }));
  if (urgent) for (const g of GATES.filter((x) => x.when === 'normal')) gates.push({ id: g.id, title: g.title, skipped: true, pass: true, evidence: `skipped: urgent, ${reason}` });

  const base = { candidate: candidate.name, gates, ...(pin ? { pin: pin.number } : {}) };
  const held = gates.filter((g) => !g.pass);
  if (held.length) return { ...base, decision: 'hold', why: `held by ${held.map((g) => g.title.toLowerCase()).join(', ')}` };

  if (!urgent) {
    /** @type {any} */
    let latest = null;
    try {
      latest = api(`repos/${repo}/releases/latest`);
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    const at = Date.parse(String(latest?.published_at ?? ''));
    if (Number.isFinite(at) && now - at < SPACING_MS) {
      return { ...base, decision: 'hold', why: `the last stable release, ${latest.tag_name}, was published ${Math.floor((now - at) / HOUR)}h ago, under ${SPACING_MS / DAY} days; \`urgent\` with a reason skips this` };
    }
  }
  if (hold) return { ...base, decision: 'hold', why: 'held by the dispatch\'s `hold`' };

  const date = new Date(now).toISOString().slice(0, 10);
  const evidence = gates.map((g) => `- **${g.title}:** ${g.evidence}`).join('\n');
  const notes = `${notesOf().trimEnd()}\n\n---\n\nPromoted from \`${candidate.name}\` on ${date}${urgent ? `, out of band (urgent): ${reason}` : ''}. The gates (plan 0009 §2):\n\n${evidence}\n`;
  return { ...base, decision: 'promote', why: urgent ? `urgent: ${reason}` : 'every gate passed', plan: { tag, candidate: candidate.name, sha: candidate.sha, major, notes, resume: false, publish: true, latest: true, moveMajor: true } };
}

/**
 * The writes, as the Releaser: the tag on the candidate's commit (unless `resume`), its Release
 * (when `publish`), latest unless `latest` is false, and the major tag moved there (when `moveMajor`).
 * @param {Plan} plan @param {{ api?: Api, repo: string }} deps
 * @returns {string[]} what it did, a line each
 */
export function apply(plan, { api = ghApi, repo }) {
  /** @type {string[]} */
  const done = [];
  if (!plan.resume) {
    api(`repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${plan.tag}`, sha: plan.sha } });
    done.push(`Tagged ${plan.tag} on ${plan.sha}`);
  }
  if (plan.publish) {
    api(`repos/${repo}/releases`, { method: 'POST', body: { tag_name: plan.tag, name: plan.tag, body: plan.notes, draft: false, prerelease: false, make_latest: plan.latest ? 'true' : 'false' } });
    done.push(plan.latest ? `Published the Release ${plan.tag}, latest` : `Published the Release ${plan.tag}, not latest: a newer stable release is`);
  }
  if (!plan.moveMajor) return done;
  let exists = true;
  try {
    api(`repos/${repo}/git/ref/tags/${plan.major}`);
  } catch (e) {
    if (!notFound(e)) throw e;
    exists = false;
  }
  if (exists) api(`repos/${repo}/git/refs/tags/${plan.major}`, { method: 'PATCH', body: { sha: plan.sha, force: true } });
  else api(`repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${plan.major}`, sha: plan.sha } });
  done.push(`Moved ${plan.major} to ${plan.sha}`);
  return done;
}

/** The step summary: each gate's verdict and evidence, then the outcome. @param {Outcome} o */
export function summary(o) {
  const lines = [`## Promotion${o.candidate ? `: \`${o.candidate}\`` : ''}`, ''];
  if (o.gates.length) {
    lines.push('| Gate | Verdict | Evidence |', '|---|---|---|');
    for (const g of o.gates) lines.push(`| ${g.title} | ${g.skipped ? 'skipped' : g.pass ? 'pass' : '**hold**'} | ${g.evidence.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  lines.push(`**${o.decision === 'promote' ? 'Promote' : o.decision === 'hold' ? 'Held' : 'Nothing to promote'}:** ${o.why}.`);
  return `${lines.join('\n')}\n`;
}

/** What unblocks each gate that can hold a candidate past its soak. @type {Record<string, string>} */
const UNBLOCK = {
  red: `**No unexplained red.** Read each run the evidence names. A red the candidate caused needs a fix and a new candidate. One it didn't cause (a transient read from GitHub or the store, a runtime that failed before the model was called) a repository admin explains in a new comment, here or on the pin pull request, starting with \`${EXPLAIN_MARKER}\` and one run a line; the next run quotes it in its evidence:\n\n\`\`\`\n${EXPLAIN_MARKER}\n- <run id>: <cause>\n\`\`\``,
  revert: '**No revert.** A pull request the candidate contains was reverted since: the candidate ships the change the revert undid, so the next candidate, which carries the revert, is the one to promote.',
  bug: '**No serious bug.** An open `sev:critical` or `sev:high` bug names a pull request the candidate contains: fix it, and the next candidate carries the fix.',
  e2e: "**End to end.** The harness's red issue for the candidate names the scenario that failed. A fix ships as a new candidate; a scenario that is itself broken is fixed in the harness, and a re-run there reports again.",
  intake: `**Intake accepts it.** The deployed intake would refuse rows the candidate writes. Deploy intake from the candidate through the operator's deploy lane (its repository moves its pin to the candidate, cuts a release and dispatches the deploy), run Verify, then update the intake record \`${INTAKE_VARIABLE}\` names so its \`**Kanon release**\` row is the candidate; the next run reads it. A narrowing can't be deployed first: decide as \`docs/release.md\`'s "Intake first" says. An unset or unreadable record is fixed where the evidence says.`,
};

/**
 * The held issue's body: the gates holding the candidate, in the marker, then the summary and what
 * unblocks each.
 * @param {Outcome} o @param {string} ids @param {string} repo @param {string} runUrl
 */
function heldBody(o, ids, repo, runUrl) {
  const holding = o.gates.filter((g) => !g.pass && !g.skipped);
  const hints = holding.map((g) => `- ${UNBLOCK[g.id] ?? `**${g.title}.** Read its evidence above.`}`).join('\n');
  return `${HELD_MARKER} ${ids} -->\n\`${o.candidate}\` has soaked, and ${holding.length === 1 ? 'one gate holds' : `${holding.length} gates hold`} its promotion to stable, so adopters stay on the previous release. Each daily run of \`promote.yml\` rewrites this body${runUrl ? ` ([the latest](${runUrl}))` : ''}, comments when the gates holding it change, and closes this issue once the candidate is promoted.\n\n${summary(o)}\n## What unblocks it\n\n${hints}\n\nTo read the gates again now: \`gh workflow run promote.yml -R ${repo}\`.\n`;
}

/**
 * Tells the Owner of a held promotion (#1441): the writes on `o`, the check's outcome. A candidate
 * past its soak that a gate holds gets one issue, assigned to whoever merged its pin pull request;
 * later runs rewrite its body and comment only when the gates holding it change. It closes once
 * the candidate is promoted (`applied` is the apply step's outcome), promoted already or superseded.
 * @param {Outcome} o @param {{ api?: Api, repo: string, applied?: string, runUrl?: string }} deps
 * @returns {string[]} what it did, a line each
 */
export function notify(o, { api = ghApi, repo, applied = '', runUrl = '' }) {
  /** @type {string[]} */
  const done = [];
  if (!o.candidate) return done;
  const all = heldIssues(api, repo);
  // A held candidate's way out is often a newer one: its issue closes once that one is the newest.
  for (const old of all.filter((i) => i.title !== heldTitle(String(o.candidate)))) {
    const why = `Superseded: \`${o.candidate}\` is the newest candidate now, and its promotion is what this run reads.`;
    api(`repos/${repo}/issues/${old.number}/comments`, { method: 'POST', body: { body: why } });
    api(`repos/${repo}/issues/${old.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
    done.push(`Closed #${old.number}: ${why}`);
  }
  const open = all.find((i) => i.title === heldTitle(String(o.candidate))) ?? null;
  if ((o.decision === 'promote' && applied === 'success') || o.decision === 'none') {
    if (open) {
      const why = o.decision === 'promote' ? `Promoted: \`${o.plan?.tag ?? ''}\` is the stable release.` : `Closed: ${o.why}.`;
      api(`repos/${repo}/issues/${open.number}/comments`, { method: 'POST', body: { body: why } });
      api(`repos/${repo}/issues/${open.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
      done.push(`Closed #${open.number}: ${why}`);
    }
    return done;
  }
  const soak = o.gates.find((g) => g.id === 'soak');
  const holding = o.gates.filter((g) => !g.pass && !g.skipped);
  // Before the soak ends, or held by the spacing or a dispatch's `hold`, the hold is expected.
  if (o.decision !== 'hold' || !soak || soak.skipped || !soak.pass || holding.length === 0) return done;
  const ids = holding.map((g) => g.id).join(',');
  const body = heldBody(o, ids, repo, runUrl);
  if (!open) {
    /** @type {string[]} */
    let assignees = [];
    try {
      const by = o.pin ? api(`repos/${repo}/pulls/${o.pin}`)?.merged_by?.login : null;
      if (by) assignees = [String(by)];
    } catch {
      assignees = [];
    }
    let milestone = null;
    try {
      milestone = pages(api, `repos/${repo}/milestones?state=open`).find((m) => m?.title === HELD_MILESTONE)?.number ?? null;
    } catch {
      milestone = null;
    }
    const created = api(`repos/${repo}/issues`, { method: 'POST', body: { title: heldTitle(o.candidate), body, labels: [HELD_LABEL], assignees, ...(milestone ? { milestone } : {}) } });
    done.push(`Opened #${created?.number ?? '?'}, ${heldTitle(o.candidate)}${assignees.length ? `, assigned to @${assignees[0]}` : ''}`);
    return done;
  }
  const before = new RegExp(`${HELD_MARKER} (\\S*) -->`).exec(open.body)?.[1] ?? '';
  api(`repos/${repo}/issues/${open.number}`, { method: 'PATCH', body: { body } });
  done.push(`Updated #${open.number}`);
  if (before !== ids) {
    api(`repos/${repo}/issues/${open.number}/comments`, { method: 'POST', body: { body: `Now held by ${holding.map((g) => g.title.toLowerCase()).join(', ')}: the body has each gate's evidence.` } });
    done.push(`Commented on #${open.number}: the gates holding it changed`);
  }
  return done;
}

function main() {
  const mode = process.argv[2];
  const env = process.env;
  if (!env.GITHUB_REPOSITORY) {
    console.error('promote: GITHUB_REPOSITORY must be set; the runner sets it, and the promotion never guesses a repository');
    process.exit(2);
  }
  const say = (/** @type {string} */ text) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    console.log(text);
  };
  try {
    if (mode === 'check') {
      const o = check(env, { intake: intakeFromEnv(env) });
      say(summary(o));
      if (o.plan && env.PLAN) writeFileSync(env.PLAN, JSON.stringify(o.plan));
      if (env.OUTCOME) writeFileSync(env.OUTCOME, JSON.stringify(o));
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `decision=${o.decision}\n`);
    } else if (mode === 'gate') {
      const g = gate(env);
      say(gateSummary(g));
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `pass=${g.pass}\n`);
    } else if (mode === 'notify') {
      const o = /** @type {Outcome} */ (JSON.parse(readFileSync(String(env.OUTCOME), 'utf8')));
      const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
      const done = notify(o, { repo: String(env.GITHUB_REPOSITORY), applied: env.APPLIED ?? '', runUrl });
      if (done.length) say(`${done.map((l) => `- ${l}`).join('\n')}\n`);
    } else if (mode === 'apply') {
      const plan = /** @type {Plan} */ (JSON.parse(readFileSync(String(env.PLAN), 'utf8')));
      say(`${apply(plan, { repo: String(env.GITHUB_REPOSITORY) }).map((l) => `- ${l}`).join('\n')}\n`);
    } else {
      throw new Refusal(`usage: promote.mjs check|gate|apply|notify (got ${mode ?? 'nothing'})`);
    }
  } catch (e) {
    const message = String(/** @type {Error} */ (e)?.message ?? e);
    console.log(`::error title=${e instanceof Refusal ? 'Promotion refused' : 'Promotion failed'}::${message.split('\n')[0]}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `**${e instanceof Refusal ? 'Refused' : 'Failed'}:** ${message}\n`);
    process.exit(1);
  }
}

if (isCliEntry(import.meta.url)) main();
