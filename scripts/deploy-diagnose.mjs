// The diagnose lane's gate (plan 0010 §9, decision 13, step D8): what a failed deploy run left for
// the agent to read, and the only issues it may comment on. A script with no secret and no model,
// in `agent-deploy-diagnose.yml`'s `gate` job, after the membership gate, with the workflow token's
// `actions: read` and `issues: read`.
//
// THE ISSUES ARE THE ONES THE RUN'S `report` JOBS WROTE ON (plan 0010 §8). `scripts/deploy-report.mjs`
// keeps one open issue per environment, titled `Deploy to <environment> failed` and labelled `bug`,
// and every issue it files or comments on after a failure ends with the line `Run: <the run's
// link>`, written with the workflow token, so by `github-actions[bot]`. An issue is this run's when
// it is open, carries exactly that title and the `bug` label, and its body or a comment made since
// the run started holds that line, by that author. Nothing else qualifies: not an issue a person
// titled the same way, nor a link pasted into a comment. A run that stopped before any environment
// comments on the first environment's issue, which this finds the same way.
//
// WHAT THE AGENT READS OF THE RUN: the last lines of each failed job's log, cut to a fixed size and
// handed to it in its prompt, since the Explorer's App token holds no `actions` permission
// (rulebook/agent-permissions.json). The release's tag and commit come from the run itself.
//
// OUTPUTS (to $GITHUB_OUTPUT)
//   issues  the issue numbers, space-separated, empty when the run filed nothing to diagnose
//   rules   the agent's one write: `--allowedTools` with `Bash(gh issue comment <n> --body:*)` per
//           issue, so its shell can comment on these issues and no other
//   log     the failed jobs' log tails, as one block
//
// ENV  GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, GH_TOKEN (for `gh`)
//      RUN_ID, RUN_ATTEMPT, RUN_STARTED_AT   the failed run's (`github.event.workflow_run`)

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { ghApi } from './deploy-gate.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/** The author of what the `report` jobs write: the workflow token's. */
export const REPORT_AUTHOR = 'github-actions[bot]';
/** The title the `report` jobs give an environment's issue (`issueTitle` in deploy-report.mjs). */
export const TITLE = /^Deploy to (.+) failed$/;
/** The lines kept from the end of each failed job's log, and the most characters handed on in all. */
export const LOG_LINES = 150;
export const LOG_CHARS = 60_000;
/** The most pages of open issues and of an issue's comments read. */
const MAX_PAGES = 10;

/** The run's link, exactly as the `report` jobs write it (`RUN_URL` in deploy.yml). */
export const runUrl = (/** @type {string} */ server, /** @type {string} */ repo, /** @type {string | number} */ id) => `${server}/${repo}/actions/runs/${id}`;

/** Whether a text holds the line `Run: <url>`, whole. @param {unknown} text @param {string} url */
export const namesRun = (text, url) => String(text ?? '').split(/\r?\n/).some((l) => l.trim() === `Run: ${url}`);

/** @param {any} who */
const byReport = (who) => who?.login === REPORT_AUTHOR;

/**
 * Pages of a list endpoint, up to `MAX_PAGES`.
 * @param {import('./deploy-gate.mjs').Api} api @param {string} path
 */
const pages = (api, path) => {
  /** @type {any[]} */
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = Array.isArray(list) ? list : [];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
};

/**
 * The open issues this run's `report` jobs filed or commented on, oldest first.
 * @param {{ api: import('./deploy-gate.mjs').Api, repo: string, url: string, since: string }} o
 * @returns {Array<{ number: number, environment: string }>}
 */
export function reportedIssues({ api, repo, url, since }) {
  const open = pages(api, `repos/${repo}/issues?state=open&labels=bug`)
    .filter((i) => !i?.pull_request && TITLE.test(String(i?.title ?? '')))
    .filter((i) => (i.labels ?? []).some((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.name) === 'bug'));
  /** @type {Array<{ number: number, environment: string }>} */
  const hits = [];
  for (const i of open) {
    const filed = byReport(i.user) && namesRun(i.body, url);
    const commented = filed || pages(api, `repos/${repo}/issues/${i.number}/comments?since=${encodeURIComponent(since)}`)
      .some((c) => byReport(c?.user) && namesRun(c?.body, url));
    if (filed || commented) hits.push({ number: Number(i.number), environment: /** @type {string} */ (TITLE.exec(i.title)?.[1]) });
  }
  return hits.sort((a, b) => a.number - b.number);
}

/**
 * The agent's comment rules: one per issue, by number, so `gh issue comment 12` can't reach #123.
 * @param {number[]} numbers
 */
export const commentRules = (numbers) => (numbers.length ? `--allowedTools ${numbers.map((n) => `"Bash(gh issue comment ${n} --body:*)"`).join(' ')}` : '');

/** A log's last lines, the runner's timestamp taken off each. @param {string} text @param {number} [n] */
export const tail = (text, n = LOG_LINES) => String(text ?? '').replace(/\r/g, '').split('\n')
  .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''))
  .filter((l, i, all) => l !== '' || i < all.length - 1)
  .slice(-n).join('\n');

/**
 * The failed jobs of the run's attempt, and the tail of each one's log, cut to `LOG_CHARS` in all.
 * A log that can't be read says so in its place.
 * @param {{ api: import('./deploy-gate.mjs').Api, repo: string, id: string | number, attempt: string | number }} o
 */
export function failedLogs({ api, repo, id, attempt }) {
  const jobs = /** @type {any[]} */ ([]);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const r = api(`repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    const list = Array.isArray(r?.jobs) ? r.jobs : [];
    jobs.push(...list);
    if (list.length < 100) break;
  }
  const failed = jobs.filter((j) => j?.conclusion === 'failure');
  let left = LOG_CHARS;
  const blocks = [];
  for (const j of failed) {
    let text;
    try {
      text = tail(api(`repos/${repo}/actions/jobs/${j.id}/logs`, { raw: true }));
    }
    catch (e) {
      text = `(the log could not be read: ${/** @type {Error} */ (e).message.split('\n')[0]})`;
    }
    const block = `=== ${j.name} ===\n${text}`;
    if (left <= 0) break;
    blocks.push(block.length > left ? `${block.slice(0, left)}\n(cut)` : block);
    left -= block.length;
  }
  return { jobs: failed.map((j) => String(j.name)), log: blocks.join('\n\n') };
}

/** A multi-line output, in GitHub's delimiter form. @param {string} name @param {string} value */
export const output = (name, value) => {
  const eof = `KANON_${randomBytes(8).toString('hex')}`;
  return `${name}<<${eof}\n${value}\n${eof}\n`;
};

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const repo = String(env.GITHUB_REPOSITORY ?? '');
  if (!repo || !env.RUN_ID || !env.RUN_ATTEMPT || !env.RUN_STARTED_AT) {
    console.error('deploy-diagnose: GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT and RUN_STARTED_AT must be set: the lane reads them from the workflow_run event');
    process.exit(2);
  }
  const url = runUrl(String(env.GITHUB_SERVER_URL || 'https://github.com'), repo, env.RUN_ID);
  const issues = reportedIssues({ api: ghApi, repo, url, since: env.RUN_STARTED_AT });
  const out = (/** @type {string} */ s) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, s); };
  const say = (/** @type {string} */ s) => { console.log(s); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${s}\n`); };
  out(`issues=${issues.map((i) => i.number).join(' ')}\n`);
  out(`rules=${commentRules(issues.map((i) => i.number))}\n`);
  if (!issues.length) {
    out(output('log', ''));
    say(`Deploy diagnose: no open \`Deploy to <environment> failed\` issue names ${url}, so there is nothing to diagnose.`);
  }
  else {
    const { jobs, log } = failedLogs({ api: ghApi, repo, id: env.RUN_ID, attempt: env.RUN_ATTEMPT });
    out(output('log', log));
    say(`Deploy diagnose: ${issues.map((i) => `#${i.number} (\`${i.environment}\`)`).join(', ')}; failed jobs: ${jobs.join(', ') || 'none listed'}.`);
  }
}
