#!/usr/bin/env node
// The Overseer's filing step: what its agent found, filed by who can act on it (plan 0004,
// step 13, decision 12; `K-AGENT-35`, `K-SELF-11`, `K-SELF-17`).
//
// WHY A STEP AND NOT THE AGENT. The Overseer is the adopter's auditor, and its findings go by who
// can act on them. An adopter-actionable finding (a declaration, a playbook, an App or its
// permissions, cost or a schedule, labels or milestones, test or spec coverage, a hook) is filed
// in the adopter's repository, as it always was. A Kanon-actionable one (a lane's behaviour, a
// guard, a rule, Kanon's library) is NEVER filed there: it goes into the "Upstream" section of
// the rolling audit issue, as a draft the adopter may file on Kanon by hand. Kanon is public, so
// a direct filing would cross ADR 0007's data boundary. An instruction to the agent alone would
// make that routing a judgement the agent could skip, so the agent's token reads only, and this
// step, in a job of its own on a token that may write issues, does all the filing from what the
// agent wrote down.
//
// IN A JOB OF ITS OWN. This runs in the lane's `file` job, on a fresh runner that runs no agent
// and checks out nothing: the report is data downloaded from the agent's job, so a steered agent
// can change what the report says, never how it is routed (the lane's header says so, and names
// the one dependency, kanon#274).
//
// THE REPORT, `qa-overseer-audit.json`, written by the agent at the repository root:
//
//   { "audit": "<the audit issue's body, in Markdown>",
//     "findings": [ { "title": "...", "body": "...", "subject": "playbook", "capability": false } ] }
//
// `subject` names what the finding asks to change, from a fixed list (`SUBJECTS`): the subject
// decides where it goes, not the agent. A subject outside the list goes upstream, never into
// the adopter's repository, and says why: an unclassified finding is still in the audit, where a
// human reads it, and nothing is filed on a guess. `capability: true` marks a capability
// investigation (`K-SELF-17`): at most one is filed per run, and only while the interlock is
// clear, counted by `capability-interlock.mjs` here and not by the agent.
//
// WHAT IT DOES, in order: files each adopter-actionable finding (labels `pipeline-improvement`
// and `agent:overseer`, `capability` too for a capability investigation, in the platform bucket,
// one call each, `K-WORK-2`); files the audit issue, numbered after the newest earlier one, with
// a "Filed this run" section and an "Upstream" section, present even when empty; then comments
// on and closes every earlier open audit issue, the only thing the Overseer ever closes
// (`K-AGENT-35`).
//
// THE OUTCOME. No report, or one that doesn't parse, files nothing and exits 1: the whole audit
// was lost, which the run must show. An agent that exited non-zero after writing a valid report
// is a warning, and its audit is filed. A finding that fails to file is named, the audit is
// still filed, and the step exits 1.
//
// THE WATERMARK ANCHOR. The capability review finds its last audit by a `Watermark:` line in an
// audit issue's body (`K-SELF-17`). The agent writes that line itself; anything this step adds
// to the body (titles, drafts) has the word neutralised, so a draft quoting one can never become
// the anchor.
//
//   node "$KANON/scripts/overseer-file.mjs"
//   env: GH_TOKEN (issues write), GITHUB_REPOSITORY, AGENT_OUTCOME (the agent step's outcome),
//        REPORT_PATH (the downloaded report; default `qa-overseer-audit.json`)
//
// `node:` builtins only, like every script under scripts/ (`K-SELF-8`).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { THRESHOLD, countInterlock } from './capability-interlock.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { beforeApply } from './lib/labels.mjs';

/** The report the agent writes, at the repository root. */
export const REPORT = 'qa-overseer-audit.json';

/** What a finding may ask to change, and who can act on it (plan 0004 decision 12). */
export const SUBJECTS = /** @type {const} */ ({
  declaration: 'adopter',
  playbook: 'adopter',
  hook: 'adopter',
  app: 'adopter',
  permissions: 'adopter',
  cost: 'adopter',
  schedule: 'adopter',
  labels: 'adopter',
  milestones: 'adopter',
  coverage: 'adopter',
  lane: 'kanon',
  guard: 'kanon',
  rule: 'kanon',
  library: 'kanon',
});

/** Every issue the Overseer files carries these (`K-WORK-4`'s backstop routes them to the platform bucket). */
export const LABELS = ['pipeline-improvement', 'agent:overseer'];
/** The platform bucket (`K-WORK-4`). */
export const BUCKET = 'Development Automation';
/** The audit issue's title, numbered. `workflow-health.mjs` finds it by `audit-summary` in the title. */
export const auditTitle = (/** @type {number} */ n) => `[pipeline] audit-summary — Overseer audit #${n}`;
const AUDIT_NUMBER = /audit-summary — Overseer audit #(\d+)\s*$/;
const MAX_TITLE = 256;

export class ReportError extends Error {}

/**
 * @typedef {{ title: string, body: string, subject: string, capability: boolean }} Finding
 * @typedef {{ audit: string, findings: Finding[] }} Report
 */

/**
 * The agent's report, checked. Throws `ReportError` naming what is wrong.
 * @param {string} text
 * @returns {Report}
 */
export function parseReport(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ReportError(`${REPORT} is not JSON (${/** @type {Error} */ (e).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReportError(`${REPORT} is not a JSON object`);
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (typeof r.audit !== 'string' || r.audit.trim() === '') throw new ReportError(`${REPORT} has no \`audit\` body`);
  const findings = r.findings ?? [];
  if (!Array.isArray(findings)) throw new ReportError(`${REPORT}'s \`findings\` is not an array`);
  return {
    audit: r.audit,
    findings: findings.map((f, i) => {
      if (!f || typeof f !== 'object') throw new ReportError(`${REPORT}'s finding ${i + 1} is not an object`);
      const o = /** @type {Record<string, unknown>} */ (f);
      if (typeof o.title !== 'string' || o.title.trim() === '') throw new ReportError(`${REPORT}'s finding ${i + 1} has no title`);
      if (o.title.length > MAX_TITLE) throw new ReportError(`${REPORT}'s finding ${i + 1} has a title over ${MAX_TITLE} characters`);
      if (typeof o.body !== 'string') throw new ReportError(`${REPORT}'s finding ${i + 1} ("${o.title}") has no body`);
      return { title: o.title.trim(), body: o.body, subject: typeof o.subject === 'string' ? o.subject.trim() : '', capability: o.capability === true };
    }),
  };
}

/**
 * Who can act on a finding: the subject decides, and an unknown one goes upstream.
 * @param {Finding} f
 * @returns {{ who: 'adopter' | 'kanon', why: string }}
 */
export function classify(f) {
  const who = Object.hasOwn(SUBJECTS, f.subject) ? SUBJECTS[/** @type {keyof typeof SUBJECTS} */ (f.subject)] : null;
  if (who) return { who, why: `subject \`${f.subject}\`` };
  return { who: 'kanon', why: f.subject ? `subject \`${f.subject}\` is not one of the known subjects, so it was not filed here` : 'no subject, so it was not filed here' };
}

/**
 * Where each finding goes. Pure: the interlock count is passed in, `null` when it couldn't be
 * read (a closed interlock).
 * @param {Finding[]} findings
 * @param {number | null} interlock
 * @returns {{ file: Finding[], held: Array<{ finding: Finding, why: string }>, upstream: Array<{ finding: Finding, why: string }> }}
 */
export function route(findings, interlock) {
  /** @type {Finding[]} */
  const file = [];
  /** @type {Array<{ finding: Finding, why: string }>} */
  const held = [];
  /** @type {Array<{ finding: Finding, why: string }>} */
  const upstream = [];
  for (const finding of findings) {
    const { who, why } = classify(finding);
    if (who === 'kanon') { upstream.push({ finding, why }); continue; }
    // The capability anchor searches `audit-summary in:title`, so a filed issue titled so, with
    // a quoted `Watermark:` in its body, could become the anchor. It is never filed.
    if (/audit-summary/i.test(finding.title)) { held.push({ finding, why: 'its title holds `audit-summary`, which the capability anchor searches for' }); continue; }
    if (!finding.capability) { file.push(finding); continue; }
    if (interlock === null) held.push({ finding, why: 'the capability interlock could not be counted, so it is closed' });
    else if (interlock > THRESHOLD) held.push({ finding, why: `the capability interlock is closed (${interlock} open, more than ${THRESHOLD})` });
    else if (file.some((f) => f.capability)) held.push({ finding, why: 'one capability investigation is filed per run' });
    else file.push(finding);
  }
  return { file, held, upstream };
}

/** Text this step adds to the audit body never carries a `Watermark:` line the anchor would select. */
export const neutralise = (/** @type {string} */ s) => s.replace(/Watermark(?=[^A-Za-z0-9\n:]*:)/g, 'Watermark (quoted)');

/**
 * The audit issue's body: the agent's audit, what was filed or held, and the Upstream section.
 * @param {{ audit: string, filed: Array<{ title: string, number?: number, error?: string }>,
 *   held: Array<{ finding: Finding, why: string }>, upstream: Array<{ finding: Finding, why: string }> }} o
 */
export function renderAudit({ audit, filed, held, upstream }) {
  const out = [audit.trimEnd(), '', '## Filed this run', ''];
  if (filed.length === 0 && held.length === 0) out.push('Nothing.');
  for (const f of filed) out.push(f.number ? `- #${f.number} ${neutralise(f.title)}` : `- **Not filed, the create failed:** ${neutralise(f.title)} (${f.error ?? 'unknown error'})`);
  for (const h of held) out.push(`- **Held:** ${neutralise(h.finding.title)}: ${h.why}.`);
  out.push('', '## Upstream', '');
  out.push('Drafts of findings only Kanon can act on: a lane\'s behaviour, a guard, a rule or Kanon\'s library. Nothing here was filed. Before filing one on Kanon by hand, check that it names nothing of this project, its issues or its data (ADR 0007).');
  out.push('');
  if (upstream.length === 0) out.push('None this run.');
  for (const { finding, why } of upstream) {
    out.push(`### ${neutralise(finding.title)}`, '', `_Routed here by ${why}._`, '', neutralise(finding.body.trim()), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * The next audit's number: one past the highest earlier one, or 1.
 * @param {string[]} titles
 */
export function nextAuditNumber(titles) {
  const ns = titles.map((t) => AUDIT_NUMBER.exec(t)?.[1]).filter(Boolean).map(Number);
  return ns.length ? Math.max(...ns) + 1 : 1;
}

/** @param {string} url an issue's URL, as `gh issue create` prints it */
const issueNumber = (url) => {
  const m = /\/issues\/(\d+)\s*$/.exec(url.trim());
  if (!m) throw new Error(`gh printed no issue URL: ${url.trim().slice(0, 120)}`);
  return Number(m[1]);
};

/**
 * @typedef {(args: string[], input?: string) => string} Gh
 */

/**
 * The whole step. Returns the exit code; prints its annotations through `log`.
 * @param {{ repo: string, text: string | null, agentOutcome: string, gh: Gh, interlock?: (repo: string, gh: Gh) => { count: number },
 *   log?: (line: string) => void }} o
 * @returns {number}
 */
export function fileAudit({ repo, text, agentOutcome, gh, interlock = countInterlock, log = console.log }) {
  if (text === null) {
    log(`::error title=overseer produced nothing::The agent wrote no ${REPORT}, so nothing was filed and the whole audit was lost (the agent step's outcome: ${agentOutcome || 'unknown'}). Why it stopped is on this run's \`overseer\` telemetry row: its \`outcome\` and \`terminal_reason\`.`);
    return 1;
  }
  /** @type {Report} */
  let report;
  try {
    report = parseReport(text);
  } catch (e) {
    log(`::error title=overseer produced nothing::${/** @type {Error} */ (e).message}, so nothing was filed and the whole audit was lost (the agent step's outcome: ${agentOutcome || 'unknown'}).`);
    return 1;
  }
  let failed = 0;

  /** @type {number | null} */
  let count = null;
  if (report.findings.some((f) => f.capability && classify(f).who === 'adopter')) {
    try {
      count = interlock(repo, gh).count;
    } catch (e) {
      log(`::warning title=capability interlock::could not count it (${String(/** @type {Error} */ (e).message).split('\n')[0]}); it is closed, so no capability investigation is filed`);
    }
  }
  const { file, held, upstream } = route(report.findings, count);

  /** @type {Array<{ title: string, number?: number, error?: string }>} */
  const filed = [];
  for (const f of file) {
    const labels = [...LABELS, ...(f.capability ? ['capability'] : [])].flatMap((l) => ['--label', l]);
    try {
      const number = issueNumber(gh(['issue', 'create', '--repo', repo, '--title', f.title, '--body-file', '-', ...labels, '--milestone', BUCKET], f.body));
      filed.push({ title: f.title, number });
      log(`filed #${number}: ${f.title}`);
    } catch (e) {
      failed += 1;
      const error = String(/** @type {Error} */ (e).message).split('\n')[0] ?? '';
      filed.push({ title: f.title, error });
      log(`::error title=overseer finding not filed::"${f.title}": ${error}`);
    }
  }

  /** @type {Array<{ number: number, title: string, state: string }>} */
  let prior;
  let audit;
  try {
    prior = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', 'agent:overseer', '--state', 'all', '--limit', '200',
      '--search', 'in:title "audit-summary"', '--json', 'number,title,state']));
    const n = nextAuditNumber(prior.map((p) => p.title));
    const body = renderAudit({ audit: report.audit, filed, held, upstream });
    audit = issueNumber(gh(['issue', 'create', '--repo', repo, '--title', auditTitle(n), '--body-file', '-', ...LABELS.flatMap((l) => ['--label', l]), '--milestone', BUCKET], body));
  } catch (e) {
    log(`::error title=overseer audit not filed::${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
    return 1;
  }
  log(`filed the audit #${audit}: ${upstream.length} upstream draft(s), ${filed.length - failed} finding(s) filed, ${held.length} held`);

  for (const p of prior.filter((x) => x.state === 'OPEN' && AUDIT_NUMBER.test(x.title) && x.number !== audit)) {
    try {
      gh(['issue', 'comment', String(p.number), '--repo', repo, '--body', `Superseded by #${audit}.`]);
      gh(['issue', 'close', String(p.number), '--repo', repo]);
    } catch (e) {
      failed += 1;
      log(`::error title=prior audit not closed::#${p.number}: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
    }
  }

  if (agentOutcome === 'failure') {
    log(`::warning title=overseer exited non-zero after writing its audit::The agent exited non-zero, but its ${REPORT} was complete and valid, so the audit #${audit} was filed. Why it exited is on this run's \`overseer\` telemetry row.`);
  }
  return failed > 0 ? 1 : 0;
}

/* c8 ignore start */
const IS_CLI = isCliEntry(import.meta.url);
if (IS_CLI) {
  if (!process.env.GITHUB_REPOSITORY) {
    console.error('overseer-file: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  /** @type {Gh} */
  const gh = (args, input) => {
    beforeApply(args, (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  };
  process.exitCode = fileAudit({
    repo: process.env.GITHUB_REPOSITORY,
    text: (() => { const at = process.env.REPORT_PATH || REPORT; return existsSync(at) ? readFileSync(at, 'utf8') : null; })(),
    agentOutcome: String(process.env.AGENT_OUTCOME ?? ''),
    gh,
  });
}
/* c8 ignore stop */
