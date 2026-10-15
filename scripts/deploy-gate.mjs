// The deploy lane's checks (plan 0010 §3, §4, §5, step D4): the gate, the trust probe's judge, the
// environment job's declaration check and its supersede check. Every one is a script with no
// secret, reading GitHub's API with the job's own read-only token, so a refusal is a named code
// (`DEPLOY_REFUSALS` in `actions/agent-telemetry/schema.mjs`), never a guess.
//
// THE GATE (`gate`), in `deploy-release.yml`'s `gate` job, before the probe and anything that
// builds or deploys. It refuses, by code, unless all four hold, in this order:
//   1. the release exists and is not a draft, and its tag resolves to the run's commit (for a
//      dispatch, the `release` input's tag, and the dispatch ran AT that tag, `GITHUB_REF`
//      `refs/tags/<tag>`, so no job carries the default branch's subject, #914, and no
//      deployment records a commit other than the one deployed, #911): `draft`, `no-release`;
//   2. that commit is reachable from the default branch: `not-default-branch`;
//   3. the environments the caller passes are exactly the adoption record's `## Deploy` list
//      AT THAT COMMIT, in order (`scripts/lib/deploy-declaration.mjs`): `declaration-mismatch`;
//   4. `ci.yml`'s `push` run on the default branch at that commit completed green, polled every
//      60 seconds up to the CI wait the record declares at that commit, and never past
//      `CI_WAIT_CEILING` (345 minutes), so the wait ends inside the job's 360-minute limit in the
//      named refusal, which is filed, never in a cancellation, which files nothing (#912):
//      `ci-red`, `ci-timeout`.
// Check 2 reads the compare API rather than a clone: the commit is on the default branch when
// the branch is not behind it (`behind_by` 0), which is `git merge-base --is-ancestor`'s answer
// without a checkout or a credential on disk.
//
// THE PROBE'S JUDGE (`probe`), in the `probe` job, after the adopter's deploy hook ran with
// `probe: 'true'`. The hook writes its answer, one word per declared environment (`refused`,
// `obtained` or `unconfigured`), as a JSON object to `$RUNNER_TEMP/kanon-deploy-probe.json`
// (`PROBE_FILE`). The judge prints the line doctor reads, `kanon-deploy-probe/v1 {…}`, with
// exactly the declared environments, and passes only when every one is `refused`: one
// `obtained` is `trust-unbound`, and anything else, a missing file or word included, is
// `probe-unconfigured`, so a probe that tested nothing never reads as proof (§5).
//
// THE ENVIRONMENT JOB'S CHECKS. `declare`, in `deploy.yml`'s `declare` job: the release again,
// and the environment the caller passes must be at the position it passes in the list at the
// commit (`declaration-mismatch`); the role comes from that position, never from the caller, and
// under the `no-environments` marker the job is told to set no environment (§13). Under either
// fallback marker the last environment is HELD on a `release` run (`held=true`, kanon#894): only
// the Maintainer named in the record's `## People` deploys it, by dispatch, and a dispatch by
// anyone else is refused (`unauthorized=not-maintainer`, recorded at stage `deploy`, kanon#899).
// `supersede`, in `deploy.yml`'s `deploy` job, once it holds its concurrency slot and its
// approval (`deployCheck`): first, under either fallback marker for production (`FALLBACK` set,
// `ROLE` production), the Maintainer check again, for whoever started THIS attempt, so a re-run
// that reuses `declare`'s outputs still meets it (`unauthorized=not-maintainer`); then the
// supersede check: for a `release` trigger, a commit older than the environment's last successful
// deploy is refused `superseded`; a dispatch may go back, and says so (`rollback`). It reads
// the commit of the deployment GitHub created for an earlier run's environment job, assumed to
// be that run's commit (unmeasured, plan 0010 §14.2), and check 1 holds every run's commit to
// the one it deploys (#911).
//
// ENV  GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF, GITHUB_EVENT_NAME, GH_TOKEN (for `gh`)
//      RELEASE_TAG      the `release` event's tag (`github.event.release.tag_name`)
//      RELEASE_DRAFT    the `release` event's `draft` flag
//      DISPATCH_RELEASE a dispatch's `release` input (`github.event.inputs.release`)
//      DEFAULT_BRANCH   `github.event.repository.default_branch`; read from the API when empty
//      ENVIRONMENTS     the caller's list, space-separated (`gate`, `probe`)
//      ENVIRONMENT      the environment job's own (`declare`, `supersede`)
//      POSITION         its position in the caller's chain (`declare`)
//      GITHUB_TRIGGERING_ACTOR, else GITHUB_ACTOR  who started this attempt, for the Maintainer
//                       check (`attemptActor`; `declare`, `supersede`)
//      SHA              the commit to deploy, the `declare` job's output (`supersede`)
//      FALLBACK, ROLE   the `declare` job's outputs: the fallback's marker and the role (`supersede`)
//
// Each subcommand writes its outputs to $GITHUB_OUTPUT, a line to the step summary, and exits
// non-zero on a refusal, with `refusal=<code>` written first so the `record` job can read it.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEPLOY_REFUSALS } from '../actions/agent-telemetry/schema.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { ADOPTION_RECORD, DeclarationError, parseDeployDeclaration, ROLES } from './lib/deploy-declaration.mjs';

/** The file the deploy hook writes its probe answer to, under `$RUNNER_TEMP` (plan 0010 §5). */
export const PROBE_FILE = 'kanon-deploy-probe.json';
/** The line doctor reads from the probe job's log (plan 0010 §5, §12). */
export const PROBE_LINE = 'kanon-deploy-probe/v1';
/** The hook's three answers, per environment. */
export const PROBE_ANSWERS = /** @type {const} */ (['refused', 'obtained', 'unconfigured']);
/** How often the gate asks for CI's run while it waits (plan 0010 §3, check 4). */
export const CI_POLL_MS = 60_000;
/**
 * The minutes `deploy-release.yml`'s `gate` job may spend outside the CI wait: its setup, the
 * `kanon-path` step and checks 1 to 3 before the wait starts, and the last look after it ends.
 */
export const GATE_MARGIN_MINUTES = 15;
/**
 * The longest the gate waits for CI, whatever the record declares: the gate job's limit, 360
 * minutes, a hosted job's, less `GATE_MARGIN_MINUTES`. A wait that could outlast the job would end
 * in a cancellation, which files nothing, instead of `ci-timeout` (#912).
 * `tests/unit/deploy-lane.test.ts` holds the job's `timeout-minutes` to it.
 */
export const CI_WAIT_CEILING = 360 - GATE_MARGIN_MINUTES;
/** The workflow whose `push` run the gate waits for (`K-SHIP-8`). */
export const CI_WORKFLOW = 'ci.yml';

/** A refusal, by its code. */
export class Refusal extends Error {
  /** @param {typeof DEPLOY_REFUSALS[number]} code @param {string} message */
  constructor(code, message) {
    super(message);
    if (!DEPLOY_REFUSALS.includes(code)) throw new Error(`${code} is not one of the deploy row's refusal codes`);
    this.code = code;
  }
}

/** An API error, with the HTTP status when `gh` named one. */
export class ApiError extends Error {
  /** @param {string} message @param {number | null} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {(path: string, opts?: { method?: string, body?: unknown, raw?: boolean }) => any} Api
 */

/**
 * GitHub's REST API through `gh`, with the job's token. JSON in, JSON out; `raw` returns the
 * body as text (a file's contents). A failure throws `ApiError` with the status `gh` printed.
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
      maxBuffer: 16 * 1024 * 1024,
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

/** The caller's list: names separated by spaces (or commas), in order. */
export const splitEnvironments = (/** @type {string | undefined} */ text) => String(text ?? '').split(/[\s,]+/).filter(Boolean);

/**
 * @typedef {{ tag: string, sha: string, prerelease: boolean, publishedAt: string }} Release
 */

/**
 * Check 1: the release, and the commit its tag names.
 * @param {{ repo: string, event: string, releaseTag?: string, releaseDraft?: string, dispatchRelease?: string, githubSha?: string, githubRef?: string, api: Api }} o
 * @returns {Release}
 */
export function resolveRelease({ repo, event, releaseTag = '', releaseDraft = '', dispatchRelease = '', githubSha = '', githubRef = '', api }) {
  let tag;
  if (event === 'release') {
    tag = releaseTag.trim();
    if (!tag) throw new Refusal('no-release', 'the `release` event names no tag');
    if (releaseDraft === 'true') throw new Refusal('draft', `release \`${tag}\` is a draft: only a published release deploys`);
  } else if (event === 'workflow_dispatch') {
    tag = dispatchRelease.trim();
    if (!tag) throw new Refusal('no-release', 'the dispatch names no release: pass an existing release\'s tag as the `release` input');
    // A dispatch runs AT its release's tag, never at a branch (the Owner's decision on #914): every
    // job then carries the tag's subject or its environment's, never the default branch's, which
    // the adopter's QA store and other roles trust.
    if (githubRef !== `refs/tags/${tag}`) {
      throw new Refusal('no-release', `a dispatch deploys only from its release's tag: this one ran at \`${githubRef || 'an unknown ref'}\`; dispatch it with \`--ref ${tag} -f release=${tag}\``);
    }
  } else {
    throw new Refusal('no-release', `the deploy lane runs on a published release or a dispatch naming one, not on \`${event || 'an unknown event'}\``);
  }
  let release;
  try {
    release = api(`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (e) {
    if (notFound(e)) throw new Refusal('no-release', `no published release has the tag \`${tag}\``);
    throw e;
  }
  if (release?.draft === true) throw new Refusal('draft', `release \`${tag}\` is a draft: only a published release deploys`);
  let sha;
  try {
    sha = String(api(`repos/${repo}/commits/${encodeURIComponent(tag)}`)?.sha ?? '');
  } catch (e) {
    if (notFound(e)) throw new Refusal('no-release', `the tag \`${tag}\` names no commit`);
    throw e;
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Refusal('no-release', `the tag \`${tag}\` names no commit`);
  // The run's commit is, by the plan's assumption (unmeasured, plan 0010 §14.2), the one GitHub
  // puts on the deployment it creates for each environment job, which the supersede check reads
  // as what the environment runs. So a run deploys only its own commit, on a dispatch as on a
  // release (#911).
  if (sha !== githubSha) {
    throw new Refusal('no-release', event === 'release'
      ? `the tag \`${tag}\` names \`${sha.slice(0, 12)}\`, not the release's commit \`${githubSha.slice(0, 12)}\`: it moved after the release was published`
      : `the tag \`${tag}\` names \`${sha.slice(0, 12)}\`, not the dispatch's commit \`${githubSha.slice(0, 12)}\`: it moved after the dispatch; dispatch it again with \`--ref ${tag} -f release=${tag}\``);
  }
  return { tag, sha, prerelease: release?.prerelease === true, publishedAt: String(release?.published_at ?? '') };
}

/** The default branch: the event's, or the repository's. */
export const defaultBranch = (/** @type {Api} */ api, /** @type {string} */ repo, /** @type {string | undefined} */ fromEvent) =>
  (fromEvent?.trim() || String(api(`repos/${repo}`)?.default_branch ?? '').trim());

/**
 * Check 2: the commit is reachable from the default branch.
 * @param {{ repo: string, sha: string, branch: string, api: Api }} o
 */
export function checkDefaultBranch({ repo, sha, branch, api }) {
  if (!branch) throw new Refusal('not-default-branch', 'the repository has no default branch to deploy from');
  let cmp;
  try {
    cmp = api(`repos/${repo}/compare/${sha}...${encodeURIComponent(branch)}`);
  } catch (e) {
    if (notFound(e)) throw new Refusal('not-default-branch', `\`${sha.slice(0, 12)}\` can't be compared with \`${branch}\``);
    throw e;
  }
  if (cmp?.behind_by !== 0) {
    throw new Refusal('not-default-branch', `\`${sha.slice(0, 12)}\` is not on \`${branch}\`: only a commit of the default branch, reviewed and merged, deploys`);
  }
}

/**
 * The adoption record at a commit, parsed. A missing or malformed record is a mismatch: the
 * lane deploys only what the record at that commit declares.
 * @param {{ repo: string, sha: string, api: Api }} o
 */
export function declarationAt({ repo, sha, api }) {
  let text;
  try {
    text = api(`repos/${repo}/contents/${ADOPTION_RECORD}?ref=${sha}`, { raw: true });
  } catch (e) {
    if (notFound(e)) throw new Refusal('declaration-mismatch', `${ADOPTION_RECORD} doesn't exist at \`${sha.slice(0, 12)}\`, so it declares no environment`);
    throw e;
  }
  try {
    return parseDeployDeclaration(String(text));
  } catch (e) {
    if (e instanceof DeclarationError) throw new Refusal('declaration-mismatch', `at \`${sha.slice(0, 12)}\`: ${e.message}`);
    throw e;
  }
}

/**
 * Check 3: the caller's list is the declared list, in order.
 * @param {string[]} passed @param {string[]} declared @param {string} sha
 */
export function checkList(passed, declared, sha) {
  if (passed.length === declared.length && passed.every((e, i) => e === declared[i])) return;
  const show = (/** @type {string[]} */ l) => (l.length ? l.map((e) => `\`${e}\``).join(', ') : 'none');
  throw new Refusal('declaration-mismatch', `the caller passes ${show(passed)}, but ${ADOPTION_RECORD} at \`${sha.slice(0, 12)}\` declares ${show(declared)}: run \`kanon init\` again to rewrite the caller from the declaration`);
}

/**
 * Check 4: the commit's CI, on the default branch's `push`, green. Waits while it runs, up to
 * `waitMinutes` from the first look, and never more than `CI_WAIT_CEILING`.
 * @param {{ repo: string, sha: string, branch: string, waitMinutes: number, api: Api, now?: () => number, sleep?: (ms: number) => void, pollMs?: number, log?: (line: string) => void }} o
 */
export function waitForCi({ repo, sha, branch, waitMinutes, api, now = Date.now, sleep = sleepSync, pollMs = CI_POLL_MS, log = () => {} }) {
  const start = now();
  const minutes = Math.min(waitMinutes, CI_WAIT_CEILING);
  const deadline = start + minutes * 60_000;
  const waited = minutes < waitMinutes
    ? `${minutes} minute(s), the most the gate's job can wait (the record declares ${waitMinutes})`
    : `the declared CI wait of ${waitMinutes} minute(s)`;
  for (;;) {
    let runs;
    try {
      runs = api(`repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?event=push&branch=${encodeURIComponent(branch)}&head_sha=${sha}&per_page=20`);
    } catch (e) {
      if (notFound(e)) throw new Refusal('ci-red', `the repository has no \`.github/workflows/${CI_WORKFLOW}\`, so no green CI vouches for \`${sha.slice(0, 12)}\` (K-SHIP-8)`);
      throw e;
    }
    const run = (Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [])
      .filter((/** @type {any} */ r) => r?.head_sha === sha)
      .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.id) - Number(a.id))[0];
    if (run && run.status === 'completed') {
      if (run.conclusion !== 'success') {
        throw new Refusal('ci-red', `CI's run on \`${sha.slice(0, 12)}\` concluded \`${run.conclusion}\` (${run.html_url ?? `run ${run.id}`}): only a green commit deploys (K-SHIP-8)`);
      }
      const jobs = api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      const red = (Array.isArray(jobs?.jobs) ? jobs.jobs : []).filter((/** @type {any} */ j) => j?.conclusion !== 'success' && j?.conclusion !== 'skipped');
      if (red.length) {
        throw new Refusal('ci-red', `CI's run on \`${sha.slice(0, 12)}\` has ${red.length} job(s) not green: ${red.map((/** @type {any} */ j) => `\`${j.name}\` ${j.conclusion ?? j.status}`).join(', ')} (K-SHIP-8)`);
      }
      return run;
    }
    if (now() >= deadline) {
      throw new Refusal('ci-timeout', run
        ? `CI's run on \`${sha.slice(0, 12)}\` was still \`${run.status}\` after ${waited}`
        : `no CI run on \`${sha.slice(0, 12)}\` appeared within ${waited}`);
    }
    log(run ? `CI's run on ${sha.slice(0, 12)} is ${run.status}; asking again in ${Math.round(pollMs / 1000)} s.` : `No CI run on ${sha.slice(0, 12)} yet; asking again in ${Math.round(pollMs / 1000)} s.`);
    sleep(pollMs);
  }
}

/** A blocking sleep for the polling loop: the gate does nothing else while it waits. */
function sleepSync(/** @type {number} */ ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The gate: checks 1 to 4, in order. Returns the outputs the later jobs read, or the refusal.
 * @param {Record<string, string | undefined>} env
 * @param {{ api?: Api, now?: () => number, sleep?: (ms: number) => void, log?: (line: string) => void }} [deps]
 * @returns {{ ok: true, outputs: Record<string, string>, line: string } | { ok: false, refusal: string, message: string, outputs: Record<string, string> }}
 */
export function gate(env, { api = ghApi, now, sleep, log } = {}) {
  const repo = String(env.GITHUB_REPOSITORY);
  const passed = splitEnvironments(env.ENVIRONMENTS);
  /** @type {Record<string, string>} */
  const outputs = { environments: passed.join(' ') };
  try {
    const release = resolveRelease({
      repo, event: env.GITHUB_EVENT_NAME ?? '', releaseTag: env.RELEASE_TAG, releaseDraft: env.RELEASE_DRAFT,
      dispatchRelease: env.DISPATCH_RELEASE, githubSha: env.GITHUB_SHA, githubRef: env.GITHUB_REF, api,
    });
    Object.assign(outputs, { sha: release.sha, tag: release.tag, prerelease: String(release.prerelease), 'published-at': release.publishedAt });
    const branch = defaultBranch(api, repo, env.DEFAULT_BRANCH);
    checkDefaultBranch({ repo, sha: release.sha, branch, api });
    const declared = declarationAt({ repo, sha: release.sha, api });
    outputs.fallback = declared.fallback ?? '';
    checkList(passed, declared.environments, release.sha);
    waitForCi({ repo, sha: release.sha, branch, waitMinutes: declared.ciWait, api, now, sleep, log });
    return { ok: true, outputs, line: `Release \`${release.tag}\` (\`${release.sha.slice(0, 12)}\`) is published, on \`${branch}\`, declared for ${passed.map((e) => `\`${e}\``).join(', ')}, and green: deploying.` };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, refusal: e.code, message: e.message, outputs: { ...outputs, refusal: e.code } };
    throw e;
  }
}

/**
 * The probe's judge: the hook's answer, against the declared list.
 * @param {string[]} environments the declared list
 * @param {string | null} text the answer file's contents, `null` when the hook wrote none
 * @returns {{ ok: boolean, refusal: 'trust-unbound' | 'probe-unconfigured' | null, answers: Record<string, string>, line: string, message: string }}
 */
export function judgeProbe(environments, text) {
  /** @type {Record<string, unknown>} */
  let given = {};
  let why = '';
  if (text === null) why = `the deploy hook wrote no ${PROBE_FILE}`;
  else {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) given = parsed;
      else why = `${PROBE_FILE} is not a JSON object of one answer per environment`;
    } catch {
      why = `${PROBE_FILE} is not JSON`;
    }
  }
  /** @type {Record<string, string>} */
  const answers = Object.fromEntries(environments.map((e) => {
    const a = given[e];
    return [e, typeof a === 'string' && (/** @type {readonly string[]} */ (PROBE_ANSWERS)).includes(a) ? a : 'unconfigured'];
  }));
  const line = `${PROBE_LINE} ${JSON.stringify(answers)}`;
  const obtained = environments.filter((e) => answers[e] === 'obtained');
  const unconfigured = environments.filter((e) => answers[e] === 'unconfigured');
  const names = (/** @type {string[]} */ l) => l.map((e) => `\`${e}\``).join(', ');
  if (!environments.length) return { ok: false, refusal: 'probe-unconfigured', answers, line, message: 'no environment was declared to probe' };
  if (obtained.length) {
    return { ok: false, refusal: 'trust-unbound', answers, line, message: `a job outside every environment obtained the credential of ${names(obtained)}: its role must trust only \`…:environment:<name>\` (plan 0010 §5)` };
  }
  if (unconfigured.length) {
    return { ok: false, refusal: 'probe-unconfigured', answers, line, message: `${why ? `${why}; ` : ''}the probe found no role to try for ${names(unconfigured)}: the deploy hook must read each environment's role from where a job outside the environment can, such as a repository variable (plan 0010 §5)` };
  }
  return { ok: true, refusal: null, answers, line, message: `Every declared environment refused a job outside it: ${names(environments)}.` };
}

/**
 * The Maintainer's GitHub logins, from the adoption record's `## People` table (`K-LAYOUT-10`):
 * the code spans `@login` on its `| Maintainer |` row.
 * @param {string} text the adoption record
 * @returns {string[]}
 */
export function maintainersOf(text) {
  const row = text.split(/\r?\n/).find((l) => /^\|\s*Maintainer\s*\|/.test(l));
  return row ? [...row.matchAll(/`@([A-Za-z0-9-]+(?:\[bot\])?)`/g)].map((m) => /** @type {string} */ (m[1])) : [];
}

/**
 * Who started this attempt of the run: the person who clicked "Re-run" (`GITHUB_TRIGGERING_ACTOR`),
 * else the run's actor. On a re-run `GITHUB_ACTOR` stays whoever started the first attempt, so a
 * re-run of the Maintainer's dispatch would otherwise read as the Maintainer's (as
 * `scripts/lane-gate.mjs` reads it, `K-AGENT-45`).
 * @param {Record<string, string | undefined>} env
 */
export const attemptActor = (env) => String(env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || '');

/**
 * Under a fallback marker, production is deployed only by the Maintainer the adoption record's
 * `## People` names (plan 0010 §13): `null` when this attempt's actor is one, else the refusal.
 * Its code, `not-maintainer`, is one of `DEPLOY_REFUSALS`: the job refuses, the row records it at
 * stage `deploy` and the report files it (kanon#899).
 * @param {{ repo: string, sha: string, fallback: string | null, env: Record<string, string | undefined>, api: Api }} o
 * @returns {{ code: 'not-maintainer', message: string } | null}
 */
export function maintainerCheck({ repo, sha, fallback, env, api }) {
  const record = String(api(`repos/${repo}/contents/${ADOPTION_RECORD}?ref=${sha}`, { raw: true }));
  const maintainers = maintainersOf(record);
  const actor = attemptActor(env);
  if (maintainers.some((m) => m.toLowerCase() === actor.toLowerCase())) return null;
  return {
    code: 'not-maintainer',
    message: `under the \`${fallback}\` fallback only the Maintainer (${maintainers.length ? maintainers.map((m) => `@${m}`).join(', ') : 'none named in the adoption record\'s `## People`'}) may deploy production, by dispatch; this attempt was started by @${actor || 'unknown'}`,
  };
}

/**
 * The environment job's declaration check: the release, then this environment at this position.
 * @param {Record<string, string | undefined>} env
 * @param {{ api?: Api }} [deps]
 * @returns {{ ok: true, outputs: Record<string, string>, line: string } | { ok: false, refusal: string, message: string, outputs: Record<string, string> }}
 *   `refusal` is empty for a production dispatch refused to a non-Maintainer (`outputs.unauthorized`).
 */
export function environmentCheck(env, { api = ghApi } = {}) {
  const repo = String(env.GITHUB_REPOSITORY);
  const environment = String(env.ENVIRONMENT ?? '').trim();
  const position = Number(env.POSITION);
  // Until the record is read, the safe guess: a failure here is filed as production's would be.
  /** @type {Record<string, string>} */
  const outputs = { role: ROLES.production, environment: '' };
  try {
    const release = resolveRelease({
      repo, event: env.GITHUB_EVENT_NAME ?? '', releaseTag: env.RELEASE_TAG, releaseDraft: env.RELEASE_DRAFT,
      dispatchRelease: env.DISPATCH_RELEASE, githubSha: env.GITHUB_SHA, githubRef: env.GITHUB_REF, api,
    });
    Object.assign(outputs, { sha: release.sha, tag: release.tag, prerelease: String(release.prerelease), 'published-at': release.publishedAt });
    const declared = declarationAt({ repo, sha: release.sha, api });
    outputs.fallback = declared.fallback ?? '';
    const count = declared.environments.length;
    outputs.role = Number.isInteger(position) && position >= 1 && position < count ? ROLES.preProduction : ROLES.production;
    if (!Number.isInteger(position) || position < 1 || declared.environments[position - 1] !== environment) {
      throw new Refusal('declaration-mismatch', `the caller deploys \`${environment}\` at position ${env.POSITION ?? '(none)'}, but ${ADOPTION_RECORD} at \`${release.sha.slice(0, 12)}\` declares ${count ? declared.environments.map((e, i) => `${i + 1}. \`${e}\``).join(', ') : 'no environment'}: run \`kanon init\` again to rewrite the caller`);
    }
    // Under the `no-environments` fallback the job sets no environment (plan 0010 §13).
    outputs.environment = declared.fallback === 'no-environments' ? '' : environment;
    outputs.held = 'false';
    // THE HOLD (plan 0010 §13, kanon#894). Under either marker the platform can't gate production,
    // so a `release` run deploys the pre-production environments and holds the last one, which
    // only the Maintainer's dispatch deploys. The hold lives here, in the lane, so the caller is
    // the same with or without a fallback.
    if (declared.fallback && position === count) {
      const event = env.GITHUB_EVENT_NAME ?? '';
      if (event === 'release') {
        outputs.held = 'true';
        return { ok: true, outputs, line: `\`${environment}\` is production under the \`${declared.fallback}\` fallback: held. It waits for the Maintainer's dispatch of this release (\`gh workflow run <caller> --ref ${release.tag} -f release=${release.tag}\`).` };
      }
      // Refused here, before any approval wait, and again in the `deploy` job itself, which is
      // what a "Re-run failed jobs" re-runs with `declare`'s outputs reused (`maintainerCheck`).
      const m = maintainerCheck({ repo, sha: release.sha, fallback: declared.fallback, env, api });
      if (m) {
        outputs.unauthorized = m.code;
        return { ok: false, refusal: '', message: m.message, outputs };
      }
    }
    return { ok: true, outputs, line: `\`${environment}\` is environment ${position} of ${count}, ${outputs.role}${outputs.environment ? '' : ', deployed with no GitHub environment (the `no-environments` fallback)'}.` };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, refusal: e.code, message: e.message, outputs: { ...outputs, refusal: e.code } };
    throw e;
  }
}

/**
 * The supersede check: the environment's last successful deploy, by the Deployments API, and
 * whether this commit is older, the same, or newer.
 * @param {{ repo: string, environment: string, sha: string, trigger: string, api?: Api }} o
 * @returns {{ ok: boolean, refusal: 'superseded' | null, redeploy: boolean, rollback: boolean, message: string }}
 */
export function supersede({ repo, environment, sha, trigger, api = ghApi }) {
  const list = api(`repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`);
  const deployments = (Array.isArray(list) ? list : []).filter((/** @type {any} */ d) => /^[0-9a-f]{40}$/.test(String(d?.sha ?? '')));
  const succeeded = (/** @type {any} */ d) => {
    const statuses = api(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`);
    return Array.isArray(statuses) && statuses[0]?.state === 'success';
  };
  // Newest first, as the API lists them; the job's own deployment is in progress, never a success.
  const last = deployments.find(succeeded);
  if (!last) return { ok: true, refusal: null, redeploy: false, rollback: false, message: `No earlier successful deploy to \`${environment}\`.` };
  const redeploy = last.sha === sha || deployments.some((/** @type {any} */ d) => d !== last && d.sha === sha && succeeded(d));
  if (last.sha === sha) return { ok: true, refusal: null, redeploy, rollback: false, message: `\`${sha.slice(0, 12)}\` is what \`${environment}\` last deployed: deploying it again.` };
  const cmp = api(`repos/${repo}/compare/${sha}...${last.sha}`);
  const older = cmp?.status === 'ahead';
  if (!older) return { ok: true, refusal: null, redeploy, rollback: false, message: `\`${sha.slice(0, 12)}\` is not older than \`${environment}\`'s last successful deploy, \`${String(last.sha).slice(0, 12)}\`.` };
  if (trigger === 'workflow_dispatch') {
    return { ok: true, refusal: null, redeploy, rollback: true, message: `\`${sha.slice(0, 12)}\` is older than \`${environment}\`'s last successful deploy, \`${String(last.sha).slice(0, 12)}\`: a dispatch rolls back.` };
  }
  return {
    ok: false, refusal: 'superseded', redeploy, rollback: false,
    message: `\`${sha.slice(0, 12)}\` is older than \`${environment}\`'s last successful deploy, \`${String(last.sha).slice(0, 12)}\`: a release never rolls an environment back unasked; dispatch the lane with this release to roll back`,
  };
}

/**
 * The `deploy` job's own checks, once it holds its slot and its approval: under a fallback marker,
 * production's Maintainer check, for whoever started THIS attempt, so a "Re-run failed jobs" that
 * reuses `declare`'s outputs still meets it; then the supersede check.
 * @param {Record<string, string | undefined>} env  ENVIRONMENT, SHA, FALLBACK, ROLE, and the runner's
 * @param {{ api?: Api }} [deps]
 * @returns {{ ok: boolean, outputs: Record<string, string>, message: string, title: string, code: string }}
 */
export function deployCheck(env, { api = ghApi } = {}) {
  const repo = String(env.GITHUB_REPOSITORY);
  const sha = env.SHA ?? '';
  if (env.FALLBACK && env.ROLE === ROLES.production) {
    const m = maintainerCheck({ repo, sha, fallback: env.FALLBACK, env, api });
    if (m) return { ok: false, outputs: { unauthorized: m.code }, message: m.message, title: 'Deploy production', code: m.code };
  }
  const r = supersede({ repo, environment: env.ENVIRONMENT ?? '', sha, trigger: env.GITHUB_EVENT_NAME ?? '', api });
  return {
    ok: r.ok,
    outputs: { redeploy: String(r.redeploy), rollback: String(r.rollback), ...(r.refusal ? { refusal: r.refusal } : {}) },
    message: r.message, title: 'Deploy superseded', code: r.refusal ?? '',
  };
}

// ── The CLI ─────────────────────────────────────────────────────────────────────────────────

/** @param {Record<string, string>} outputs */
const writeOutputs = (outputs) => {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}\n`).join(''));
};
/** @param {string} line */
const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};
/** @param {string} title @param {string} code @param {string} message */
const refuse = (title, code, message) => {
  console.log(`::error title=${title}: ${code}::${message}`);
  summary(`**Refused, \`${code}\`:** ${message}`);
  process.exitCode = 1;
};

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const command = process.argv[2];
  if (!env.GITHUB_REPOSITORY) {
    console.error('deploy-gate: GITHUB_REPOSITORY must be set; the runner sets it, and the lane never guesses a repository');
    process.exit(2);
  }
  if (command === 'gate') {
    const r = gate(env, { log: (l) => console.log(l) });
    writeOutputs(r.outputs);
    if (r.ok) summary(r.line);
    else refuse('Deploy gate', r.refusal, r.message);
  } else if (command === 'probe') {
    let text = null;
    try {
      text = readFileSync(join(env.RUNNER_TEMP ?? '', PROBE_FILE), 'utf8');
    } catch {
      text = null;
    }
    const r = judgeProbe(splitEnvironments(env.ENVIRONMENTS), text);
    console.log(r.line);
    writeOutputs(r.refusal ? { refusal: r.refusal } : {});
    if (r.ok) summary(r.message);
    else refuse('Deploy trust probe', /** @type {string} */ (r.refusal), r.message);
  } else if (command === 'declare') {
    const r = environmentCheck(env);
    writeOutputs(r.outputs);
    if (r.ok) summary(r.line);
    else if (r.refusal) refuse('Deploy declaration', r.refusal, r.message);
    else refuse('Deploy production', 'not-maintainer', r.message);
  } else if (command === 'supersede') {
    const r = deployCheck(env);
    writeOutputs(r.outputs);
    if (r.ok) summary(r.message);
    else refuse(r.title, r.code, r.message);
  } else {
    console.error('usage: deploy-gate.mjs gate | probe | declare | supersede');
    process.exitCode = 2;
  }
}
