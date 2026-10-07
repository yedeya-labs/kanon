// The jobs that report a status check on a pull request, read from a repository's workflows:
// `kanon doctor` asks for a required-check rule only once a job on the default branch reports
// the check on every pull request (#418, #446), and `kanon init` requires it on the same terms
// (#444). Node built-ins only, and no import of another `cli/` module but the YAML reader, so
// either may import it.

import { parseYaml } from './workflow-yaml.mjs';

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── The jobs that report a status check (#418) ──────────────────────────────────────────────

/** The events on which a workflow's jobs report their checks on a pull request. */
const PR_EVENTS = ['pull_request', 'pull_request_target'];

/** The activity types a pull-request trigger runs on when it names none. A list without any of them skips the pull requests they open or update (#446). */
const PR_TYPES = ['opened', 'synchronize', 'reopened'];

/** @param {unknown} v @returns {string[]} */
const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(String);

/**
 * A branch filter's pattern as a regular expression, as GitHub matches it: `**` is any run of
 * characters, `*` any run without `/`, `?` and `+` make the character before them optional or
 * repeated, `[...]` is a class, and `\` escapes the next character.
 * @param {string} pattern
 */
export const branchPattern = (pattern) => {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = /** @type {string} */ (pattern[i]);
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?' || c === '+') re += c;
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${pattern.slice(i + 1, end)}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < pattern.length) re += `\\${pattern[++i]}`;
    else re += c.replace(/[.^$|(){}\\/-]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    // A pattern GitHub would refuse, such as a class `[z-a]`, matches nothing.
    return /(?!)/;
  }
};

/** Whether a `branches` list admits `branch`: the last pattern it matches decides, a `!` one excluding it. @param {string[]} patterns @param {string} branch */
const branchesAdmit = (patterns, branch) => {
  let admitted = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    if (branchPattern(negated ? p.slice(1) : p).test(branch)) admitted = !negated;
  }
  return admitted;
};

/**
 * The filters of one pull-request trigger that skip some pull request into `branch`: `paths` and
 * `paths-ignore` always (they skip a pull request by what it changes), `branches` that don't
 * admit it, `branches-ignore` that matches it, and `types` that leave out one of the defaults.
 * Without `branch`, any branch filter counts. GitHub never reports the check of a run it skips,
 * so a pull request it skips waits on a required check (#446).
 * @param {string} event @param {unknown} trigger @param {string | undefined} branch
 * @returns {string[]}
 */
const triggerFilters = (event, trigger, branch) => {
  if (!isMap(trigger)) return [];
  const has = (/** @type {string} */ k) => trigger[k] !== undefined && trigger[k] !== null;
  /** @type {string[]} */
  const out = [];
  for (const k of ['paths', 'paths-ignore']) if (has(k)) out.push(`${event}.${k}`);
  if (has('branches') && (branch === undefined || !branchesAdmit(listOf(trigger.branches), branch))) out.push(`${event}.branches`);
  if (has('branches-ignore') && (branch === undefined || listOf(trigger['branches-ignore']).some((p) => branchPattern(p).test(branch)))) out.push(`${event}.branches-ignore`);
  if (has('types') && !PR_TYPES.every((t) => listOf(trigger.types).includes(t))) out.push(`${event}.types`);
  return out;
};

/**
 * Whether a workflow runs on every pull request into `branch`: null when it doesn't run on a
 * pull request at all, none when one of its pull-request triggers has no filter that skips one,
 * and otherwise the filters that do.
 * @param {Record<string, any>} wf @param {string | undefined} branch
 * @returns {string[] | null}
 */
const pullRequestFilters = (wf, branch) => {
  const on = wf.on;
  if (typeof on === 'string') return PR_EVENTS.includes(on) ? [] : null;
  if (Array.isArray(on)) return on.some((e) => PR_EVENTS.includes(e)) ? [] : null;
  if (!isMap(on)) return null;
  const events = PR_EVENTS.filter((e) => e in on);
  if (!events.length) return null;
  const each = events.map((e) => triggerFilters(e, on[e], branch));
  return each.some((f) => !f.length) ? [] : each.flat();
};

/**
 * The jobs that would report the status check `check` on a pull request into `branch`, each with
 * the filters of its workflow's trigger that skip some pull request (none when it runs on every
 * one): in a workflow that runs on one, a job whose name, or its key when it has none, is
 * exactly the check's. A job that calls a reusable workflow reports `<its name> / <the called
 * job's>`, and a matrix job its name with the matrix's values, so neither counts:
 * actions/lane-check's README runs the check as a job of its own. A step of another job reports
 * nothing under its own name (L5's G14).
 * @param {Map<string, Record<string, any>>} workflows by path @param {string} check
 * @param {string} [branch] the branch the pull requests are into; without it, any branch filter skips some
 * @returns {Array<{ job: string, filters: string[] }>} `job` is `<workflow file>#<job>`
 */
export const checkJobs = (workflows, check, branch) => {
  /** @type {Array<{ job: string, filters: string[] }>} */
  const out = [];
  for (const [file, wf] of workflows) {
    const filters = pullRequestFilters(wf, branch);
    if (filters === null) continue;
    for (const [key, job] of Object.entries(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(job) || job.uses !== undefined || (isMap(job.strategy) && job.strategy.matrix !== undefined)) continue;
      if ((job.name === undefined || job.name === null ? key : String(job.name)) === check) out.push({ job: `${file}#${key}`, filters });
    }
  }
  return out;
};

/**
 * The jobs that report the status check `check` on every pull request into `branch`
 * (`checkJobs`, without a filter that skips one).
 * @param {Map<string, Record<string, any>>} workflows @param {string} check @param {string} [branch]
 * @returns {string[]} `<workflow file>#<job>`
 */
export const checkReporters = (workflows, check, branch) => checkJobs(workflows, check, branch).filter((j) => !j.filters.length).map((j) => j.job);

/** One read of every workflow file on a branch, with its text. */
const BRANCH_WORKFLOWS = 'query($owner: String!, $name: String!, $expression: String!) { repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Tree { entries { name type object { ... on Blob { text } } } } } } }';

/**
 * The workflows on the default branch, read from GitHub rather than the checkout: a job that
 * only a branch adds reports its check on that branch's pull request, and on no other (#418).
 * One GraphQL query, sent on standard input. A file that doesn't parse is left out: the
 * checkout's own read says so.
 * @param {{ gh: (args: string[], input?: string) => Promise<{ status: number | null, stdout: string, stderr: string }> }} deps
 * @param {string} repo @param {string} branch
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
