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
//          with the candidate's notes and a line saying on what evidence it was promoted, and the
//          major tag `v<major>` moved to the same commit, as release.yml moves it on a plain release.
//
// THE GATES are one table, `GATES`, each read from GitHub, never self-reported:
//   soak     Kanon's callers pin the candidate, through the merged pin pull request (S4's
//            `ci(deps): run Kanon on candidate vX.Y.Z`), for at least 72 hours, from its merge.
//   revert   no pull request merged to the default branch since the candidate was cut reverts one
//            the candidate contains (`revertsOf`, the metrics' revert detector).
//   bug      no open issue labelled `bug` and `sev:critical` or `sev:high` names, in its
//            `Introduced by` field (`introducedBy`), a pull request the candidate contains.
//   red      every run of Kanon's lane callers since the pins moved succeeded at its latest attempt
//            (so a run re-run green passes), or failed with agent-classify's `unavailable` notice
//            (the model was never reached), on one of its failed jobs.
// `urgent` (plan 0009 §7) skips the soak and the six-day spacing, and asks instead that a review
// run at the candidate succeeded (`review`). A gate added later (plan 0012's end-to-end gate, its
// step E11) is one more entry in `GATES`: the summary, the decision and the plan read the table.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, DEFAULT_BRANCH (default `main`), HOLD, URGENT, REASON, PLAN,
// GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Node built-ins and `gh` only.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from './lib/cli-entry.mjs';
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

/** Kanon's own manifest, whose version release-please's `node` type writes at each release. */
export const MANIFEST = 'package.json';

const CANDIDATE = /^candidate-v(\d+)\.(\d+)\.(\d+)$/;
const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The pin pull request's title, which S4's pin job opens (plan 0009 §6). @param {string} version */
export const pinTitle = (version) => `ci(deps): run Kanon on candidate v${version}`;

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
/**
 * @typedef {{
 *   repo: string, branch: string, now: number, urgent: boolean, api: Api,
 *   candidate: Tag, previous: Tag, cutAt: string,
 *   pin: { number: number, mergedAt: string } | null,
 *   callers: Caller[], contained: ContainedPr[],
 *   since: string,
 *   runsOf: (file: string) => any[],
 * }} Context what every gate reads: the candidate, the pull requests it contains, the pin, and
 *   Kanon's lane callers
 * @typedef {{ pass: boolean, evidence: string }} Verdict
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

/** The gates, in the order the summary shows them. Plan 0012's end-to-end gate (E11) is one more entry. @type {Gate[]} */
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
    check: ({ api, repo, callers, runsOf, since }) => {
      const files = [...new Set(callers.map((c) => c.file))];
      let count = 0;
      let explained = 0;
      /** @type {string[]} */
      const red = [];
      for (const file of files) {
        for (const run of runsOf(file)) {
          if (run?.status !== 'completed') continue;
          count += 1;
          if (!RED.includes(run?.conclusion)) continue;
          if (unreachable(api, repo, Number(run.id))) explained += 1;
          else red.push(`${file} run ${run.id} (${run.conclusion})`);
        }
      }
      return red.length
        ? { pass: false, evidence: `unexplained red since ${since}: ${red.join(', ')}` }
        : { pass: true, evidence: `${count} completed runs of ${files.length} callers since ${since}, ${explained} red with the model unreachable` };
    },
  },
  {
    id: 'review',
    title: 'A review ran green',
    when: 'urgent',
    check: ({ callers, runsOf, since }) => {
      const files = [...new Set(callers.filter((c) => c.lane === REVIEW_LANE).map((c) => c.file))];
      const green = files.flatMap((file) => runsOf(file).filter((r) => r?.conclusion === 'success').map((r) => `${file} run ${r.id}`));
      return green.length
        ? { pass: true, evidence: `${green[0]} succeeded at the candidate` }
        : { pass: false, evidence: `no run of the review lane's caller succeeded since ${since}` };
    },
  },
];

/**
 * Whether a red run's failed jobs carry agent-classify's `unavailable` notice: the model was
 * never reached, a cause outside Kanon's code. An unreadable job or annotation counts as no.
 * @param {Api} api @param {string} repo @param {number} id
 */
function unreachable(api, repo, id) {
  try {
    const jobs = api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`)?.jobs ?? [];
    return jobs.some((/** @type {any} */ job) => job?.conclusion === 'failure'
      && (api(`repos/${repo}/check-runs/${Number(job.id)}/annotations?per_page=100`) ?? []).some((/** @type {any} */ a) => a?.title === UNREACHABLE_TITLE));
  } catch {
    return false;
  }
}

/** @param {unknown} v */
const truthy = (v) => /^(true|1|yes)$/i.test(String(v ?? '').trim());

/**
 * @typedef {{ tag: string, candidate: string, sha: string, major: string, notes: string, resume: boolean }} Plan
 * @typedef {{
 *   decision: 'promote' | 'hold' | 'none',
 *   why: string,
 *   candidate?: string,
 *   gates: Array<{ id: string, title: string, skipped: boolean } & Verdict>,
 *   plan?: Plan,
 * }} Outcome
 */

/**
 * The check: what to do with the newest candidate, and why. Throws `Refusal` on a state the
 * promotion must not act on.
 * @param {Record<string, string | undefined>} env
 * @param {{ api?: Api, now?: number, workflows?: Array<{ file: string, text: string }> }} [deps]
 * @returns {Outcome}
 */
export function check(env, { api = ghApi, now = Date.now(), workflows } = {}) {
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
  const notesOf = () => String(candidateRelease.body ?? '');

  if (promoted) {
    if (releaseOf(tag)) return { decision: 'none', why: `${candidate.name} is promoted already, as ${tag}`, candidate: candidate.name, gates: [] };
    // Interrupted after the tag: finish it, since the tag is already what adopters see.
    return {
      decision: 'promote',
      why: `${tag} is on ${candidate.name}'s commit with no Release: finishing that promotion`,
      candidate: candidate.name,
      gates: [],
      plan: { tag, candidate: candidate.name, sha: candidate.sha, major, notes: notesOf(), resume: true },
    };
  }

  const previous = [...candidates, ...stable].filter((t) => compareParts(t.parts, candidate.parts) < 0).sort((a, b) => compareParts(b.parts, a.parts))[0];
  if (!previous) throw new Refusal(`no release before ${candidate.name}, so the pull requests it contains can't be read`);
  const contained = commitsBetween(api, repo, previous.name, candidate.sha)
    .flatMap((c) => (c.pr === null ? [] : [{ number: c.pr, sha: c.sha, mergedAt: c.date }]));

  const cutAt = String(candidateRelease.created_at ?? '');
  /** @type {any[]} */
  const found = api(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged in:title "${pinTitle(candidate.version)}"`)}&per_page=100`)?.items ?? [];
  const pinPr = found
    .filter((i) => i?.title === pinTitle(candidate.version) && i?.pull_request?.merged_at)
    .sort((a, b) => Date.parse(a.pull_request.merged_at) - Date.parse(b.pull_request.merged_at))[0];
  const pin = pinPr ? { number: Number(pinPr.number), mergedAt: String(pinPr.pull_request.merged_at) } : null;
  const since = pin?.mergedAt ?? cutAt;

  /** @type {Map<string, any[]>} */
  const runs = new Map();
  /** @param {string} file */
  const runsOf = (file) => {
    if (!runs.has(file)) {
      runs.set(file, pages(api, `repos/${repo}/actions/workflows/${file}/runs?created=${encodeURIComponent(`>=${since}`)}`, (p) => p?.workflow_runs));
    }
    return /** @type {any[]} */ (runs.get(file));
  };

  /** @type {Context} */
  const ctx = {
    repo, branch, now, urgent, api, candidate, previous, cutAt, pin, contained, since, runsOf,
    callers: laneCallers(workflows ?? readWorkflows(), repo),
  };
  const gates = GATES.filter((g) => g.when !== (urgent ? 'normal' : 'urgent')).map((g) => ({ id: g.id, title: g.title, skipped: false, ...g.check(ctx) }));
  if (urgent) for (const g of GATES.filter((x) => x.when === 'normal')) gates.push({ id: g.id, title: g.title, skipped: true, pass: true, evidence: `skipped: urgent, ${reason}` });

  const base = { candidate: candidate.name, gates };
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
  return { ...base, decision: 'promote', why: urgent ? `urgent: ${reason}` : 'every gate passed', plan: { tag, candidate: candidate.name, sha: candidate.sha, major, notes, resume: false } };
}

/**
 * The writes, as the Releaser: the tag on the candidate's commit (unless `resume`), its Release,
 * latest, and the major tag moved there.
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
  api(`repos/${repo}/releases`, { method: 'POST', body: { tag_name: plan.tag, name: plan.tag, body: plan.notes, draft: false, prerelease: false, make_latest: 'true' } });
  done.push(`Published the Release ${plan.tag}, latest`);
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
      const o = check(env);
      say(summary(o));
      if (o.plan && env.PLAN) writeFileSync(env.PLAN, JSON.stringify(o.plan));
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `decision=${o.decision}\n`);
    } else if (mode === 'apply') {
      const plan = /** @type {Plan} */ (JSON.parse(readFileSync(String(env.PLAN), 'utf8')));
      say(`${apply(plan, { repo: String(env.GITHUB_REPOSITORY) }).map((l) => `- ${l}`).join('\n')}\n`);
    } else {
      throw new Refusal(`usage: promote.mjs check|apply (got ${mode ?? 'nothing'})`);
    }
  } catch (e) {
    const message = String(/** @type {Error} */ (e)?.message ?? e);
    console.log(`::error title=${e instanceof Refusal ? 'Promotion refused' : 'Promotion failed'}::${message.split('\n')[0]}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `**${e instanceof Refusal ? 'Refused' : 'Failed'}:** ${message}\n`);
    process.exit(1);
  }
}

if (isCliEntry(import.meta.url)) main();
