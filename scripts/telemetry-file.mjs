#!/usr/bin/env node
// The telemetry Explorer's filing step (plan 0004 step 14, decision 13; plan 0002 §6.1): what
// its agent found in the aggregate, checked against that aggregate and filed, or refused.
//
// WHY A STEP AND NOT THE AGENT. Everything the lane files is public, and plan 0002 §6.1's item 3
// limits what it may say: the lane, the reason, the stage, the Kanon error and version and how
// many adopters were affected, and figures only from a cross-adopter cell (at least three
// adopters) or an adopter's own cells, published because it declared them. An instruction to
// the agent alone would make that a judgement it could skip. So the agent's token reads only,
// and this step, in a job of its own on a fresh runner that runs no agent, files from what the
// agent wrote down, after checking it:
//
// - A FINDING NAMES WHAT IT RESTS ON, AND THIS STEP QUOTES THE FIGURES. Each finding lists the
//   signals and cells it rests on, by their identifying fields only. Each must be exactly one
//   entry of the aggregate the lane's read job handed both jobs, and this step renders their
//   figures into the issue from that aggregate. A reference to anything else refuses the
//   finding.
// - THE AGENT'S PROSE CARRIES NO FIGURE. A digit in its title or body refuses the finding,
//   apart from an issue reference (`#41`), a rule id (`K-AGENT-9`), and a model or a Kanon
//   version the aggregate names. So the only figures an issue holds are the ones rendered here.
// - NOTHING THAT LOOKS LIKE AN ADOPTER KEY. A key is eight hex characters (`openssl rand -hex 4`,
//   docs/telemetry.md), and a stored partition is `<key>#<lane>`. The agent never sees a key,
//   because the function answers none, so a finding holding either shape is refused rather than
//   trusted. Nor an HTML comment, which could forge this step's markers.
// - THE EXPLORER'S FILING GATE (`K-AGENT-9`). A finding that rests on a failure signal is an
//   objective signal, and is filed as a `bug` (`agent:explorer`, `qa:needs-triage` and its
//   `sev:*`); one that rests on cost cells alone is an observation, and is filed as a
//   `spec-delta` (`agent:explorer`). The kind is derived here, never taken from the agent.
//   Deduplicated by an exact signature: the kind and the identifying fields of what it rests
//   on, with the figures (the volatile part) left out. An open `agent:explorer` issue carrying
//   the same signature gets a comment with this week's figures instead of a second issue.
// - SPARINGLY. At most `MAX_FILED` new issues a run; the rest are held, and the summary says so.
//   A run that finds nothing files nothing, which is a valid outcome.
//
// THE MILESTONE IS THE PROJECT'S ROUTING (`K-WORK-4`; the Owner's decision on kanon#476), from
// the issue's own labels through the backstop's `decide()` (`issue-triage-defaults.mjs`), as for
// every filer: a bucket, never a roadmap milestone (`K-WORK-5`). Nothing here fixes one.
//
// FILED HERE, OR DRAFTED (the Owner's decision on kanon#471). Every finding is about Kanon's lanes,
// so it goes by the repository's `Upstream findings:` choice (`K-LAYOUT-10`), as the Overseer's
// do: `UPSTREAM` is the lane's gate job's reading of the adoption record, never anything the
// agent wrote. `filed here` files in this repository, as above. Anything else is `drafted`, the
// default: each finding that passes the check is written into the run's summary, rendered
// exactly as it would be filed, and nothing is filed, commented on or listed. Nothing is ever
// filed in another repository.
//
// SENT TO KANON, AND STILL DRAFTED (plan 0006 §3.1 and §5, F3). With `sent` or `sent with
// evidence`, each drafted finding is also written as a finding row for Kanon's telemetry store
// (`scripts/lib/finding-rows.mjs`), into one file the lane's next step uploads as
// `kanon-finding-explore-telemetry-<run id>-<attempt>`. Its codes are the first signal it rests
// on, as checked against the aggregate, or the first cell's lane, never the agent's own; its rule
// ids, Kanon paths and fix category come from its `upstream` object, each kept only when it is in
// the schema's list; and at level 2 its `upstream.evidence` and `upstream.suggested_fix` go
// through the scrub and then through `proseProblem`, as the prose does, since the draft shows
// them in the run's summary. A text either refuses is withheld, and the finding is sent as codes.
// The scrub's names are the App register's, which the gate job hashed, this repository's and the
// run's actor: the agent reads the aggregate alone, which names no one.
//
// THE REPORT, `qa-telemetry-findings.json`, written by the agent at the repository root:
//
//   { "examined": "<what was looked at>", "held_back": ["<a candidate not filed, and why>"],
//     "findings": [ { "title": "...", "body": "...", "severity": "sev:medium",
//       "signals": [ { "lane", "reason", "failed_stage", "kanon_error", "kanon_version" } ],
//       "cells": [ { "source": "own", "label": "...", "lane", "model" } | { "source": "cross_adopter", "lane", "model" } ],
//       "upstream": { "rules": [], "kanon_paths": [], "fix_category", "evidence", "suggested_fix" } } ] }
//
// THE OUTCOME. No report, or one that doesn't parse, files nothing and exits 1: the run was lost.
// A refused finding is named by its position and why, never filed, and the step exits 1 after
// filing the rest. An agent that exited non-zero after a valid report is a warning.
//
//   node "$KANON/scripts/telemetry-file.mjs"
//   env: GH_TOKEN (issues write; only for `filed here`), GITHUB_REPOSITORY, AGENT_OUTCOME,
//        REPORT_PATH, AGGREGATE_PATH, UPSTREAM (`filed here`, `drafted`, `sent` or `sent with
//        evidence`), GITHUB_STEP_SUMMARY; and for the rows: KANON, APP_NAME_HASHES (the gate
//        job's), TAG, KANON_WORKFLOW_REF, KANON_WORKFLOW_SHA, FINDINGS_PATH, GITHUB_OUTPUT
//
// `node:` builtins only, like every script under scripts/ (`K-SELF-8`).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { AggregateError, checkAggregate } from './aggregate-read.mjs';
import { appPersona } from './app-register.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { beforeApply } from './lib/labels.mjs';
import { decide } from './issue-triage-defaults.mjs';
import { nameContext } from '../actions/agent-telemetry/scrub.mjs';
import { buildRows, notWritten, readUpstream, renderSent, sendFromEnv, sentSentence } from './lib/finding-rows.mjs';
import { upstreamChoice } from './overseer-file.mjs';
import { signed } from './lib/role-marker.mjs';

/** The report the agent writes, at the repository root. */
export const REPORT = 'qa-telemetry-findings.json';
/**
 * The labels a finding is filed with: its kind's, and a bug's severity (`K-AGENT-9`).
 * @param {'bug' | 'spec-delta'} kind @param {string} severity
 */
export const labelsFor = (kind, severity) => [...LABELS[kind], ...(kind === 'bug' ? [severity] : [])];
/**
 * The bucket an issue with these labels goes to, by the backstop's routing (`K-WORK-4`).
 * @param {string[]} labels
 * @returns {string}
 */
export const milestoneFor = (labels) => /** @type {string} */ (decide({ labels }).milestone);
/** At most this many new issues a run. */
export const MAX_FILED = 3;
export const SEVERITIES = ['sev:critical', 'sev:high', 'sev:medium', 'sev:low'];
/** The labels by kind (`K-AGENT-9`, the Explorer's filing gate). */
export const LABELS = { bug: ['bug', 'agent:explorer', 'qa:needs-triage'], 'spec-delta': ['spec-delta', 'agent:explorer'] };
const MAX_TITLE = 200;
const MAX_BODY = 8000;
const SIGNAL_KEYS = ['lane', 'reason', 'failed_stage', 'kanon_error', 'kanon_version'];
const MARKER = 'kanon:telemetry-signature';

export class ReportError extends Error {}

/**
 * @typedef {import('./aggregate-read.mjs').Aggregate} Aggregate
 * @typedef {import('./aggregate-read.mjs').Cell} Cell
 * @typedef {import('./aggregate-read.mjs').Signal} Signal
 * @typedef {{ lane: string, reason: string | null, failed_stage: string | null, kanon_error: string | null, kanon_version: string | null }} SignalRef
 * @typedef {{ source: 'own', label: string, lane: string, model: string } | { source: 'cross_adopter', lane: string, model: string }} CellRef
 * @typedef {{ title: string, body: string, severity: string, signals: unknown[], cells: unknown[], upstream?: unknown }} Finding
 * @typedef {{ examined: string, held_back: string[], findings: Finding[] }} Report
 * @typedef {{ kind: 'bug' | 'spec-delta', signals: Signal[], cells: Array<{ source: string, cell: Cell }>, signature: string }} Checked
 * @typedef {import('./lib/finding-rows.mjs').Level} Level
 * @typedef {import('./lib/finding-rows.mjs').Send} Send
 */

/**
 * The agent's report, checked for shape. Throws `ReportError` naming what is wrong.
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
  if (typeof r.examined !== 'string' || r.examined.trim() === '') throw new ReportError(`${REPORT} doesn't say what was examined (\`examined\`, K-AGENT-11)`);
  const held = r.held_back ?? [];
  if (!Array.isArray(held) || held.some((h) => typeof h !== 'string')) throw new ReportError(`${REPORT}'s \`held_back\` is not a list of strings`);
  const findings = r.findings ?? [];
  if (!Array.isArray(findings)) throw new ReportError(`${REPORT}'s \`findings\` is not an array`);
  return {
    examined: r.examined,
    held_back: /** @type {string[]} */ (held),
    findings: findings.map((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) throw new ReportError(`${REPORT}'s finding ${i + 1} is not an object`);
      const o = /** @type {Record<string, unknown>} */ (f);
      return {
        title: typeof o.title === 'string' ? o.title.trim() : '',
        body: typeof o.body === 'string' ? o.body : '',
        severity: typeof o.severity === 'string' ? o.severity.trim() : '',
        signals: Array.isArray(o.signals) ? o.signals : [],
        cells: Array.isArray(o.cells) ? o.cells : [],
        ...(Object.hasOwn(o, 'upstream') ? { upstream: o.upstream } : {}),
      };
    }),
  };
}

/** The tokens of prose that may hold a digit: an issue reference and a rule id. */
const ALLOWED_NUMBERED = [/#\d+\b/g, /\bK-[A-Z]+-\d+\b/g];
/** An adopter key as `openssl rand -hex 4` makes one (docs/telemetry.md). */
const KEY_LIKE = /(?<![0-9A-Za-z])[0-9a-f]{8}(?![0-9A-Za-z])/i;
/** A stored partition, `<key>#<lane>`. */
const PARTITION_LIKE = /[0-9a-z]#[a-z]/i;

/**
 * What is wrong with a finding's prose, or null. Pure.
 * @param {string} text the title and the body
 * @param {Aggregate} a
 * @returns {string | null}
 */
export function proseProblem(text, a) {
  if (/<!--/.test(text)) return 'it holds an HTML comment, which could forge a marker';
  if (KEY_LIKE.test(text)) return 'it holds eight hex characters, the shape of an adopter key';
  if (PARTITION_LIKE.test(text)) return 'it holds `<something>#<lane>`, the shape of a stored partition';
  let rest = text;
  for (const re of ALLOWED_NUMBERED) rest = rest.replace(re, ' ');
  // A model or a Kanon version the aggregate names, longest first so none is cut short.
  const named = [...new Set([
    ...a.cross_adopter.map((c) => c.model), ...a.own.flatMap((o) => o.cells.map((c) => c.model)),
    ...a.signals.map((s) => s.kanon_version).filter((v) => v !== null),
  ])].sort((x, y) => y.length - x.length);
  for (const n of named) rest = rest.split(/** @type {string} */ (n)).join(' ');
  if (/\d/.test(rest)) return 'its prose quotes a figure; only the table this step renders from the aggregate may (plan 0002 §6.1, item 3)';
  return null;
}

/** @param {unknown} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : v === null ? null : undefined);

/**
 * The aggregate's signal a reference names, by its five identifying fields exactly.
 * @param {unknown} ref @param {Aggregate} a
 */
function resolveSignal(ref, a) {
  if (!isObject(ref)) return null;
  const r = /** @type {Record<string, unknown>} */ (ref);
  if (Object.keys(r).some((k) => !SIGNAL_KEYS.includes(k)) || SIGNAL_KEYS.some((k) => str(r[k]) === undefined)) return null;
  return a.signals.find((s) => SIGNAL_KEYS.every((k) => s[/** @type {keyof Signal} */ (k)] === r[k])) ?? null;
}

/**
 * The aggregate's cell a reference names: an own cell by label, lane and model, or a
 * cross-adopter cell by lane and model.
 * @param {unknown} ref @param {Aggregate} a
 */
function resolveCell(ref, a) {
  if (!isObject(ref)) return null;
  const r = /** @type {Record<string, unknown>} */ (ref);
  if (r.source === 'own') {
    if (Object.keys(r).some((k) => !['source', 'label', 'lane', 'model'].includes(k))) return null;
    const cell = a.own.find((o) => o.label === r.label)?.cells.find((c) => c.lane === r.lane && c.model === r.model);
    return cell ? { source: `own: ${r.label}`, cell } : null;
  }
  if (r.source === 'cross_adopter') {
    if (Object.keys(r).some((k) => !['source', 'lane', 'model'].includes(k))) return null;
    const cell = a.cross_adopter.find((c) => c.lane === r.lane && c.model === r.model);
    return cell ? { source: `cross-adopter (at least ${a.min_adopters} adopters)`, cell } : null;
  }
  return null;
}

/**
 * The finding's signature: its kind and the identifying fields of what it rests on, sorted,
 * without a figure. Hashed, so the marker is short and holds no prose.
 * @param {string} kind @param {Signal[]} signals @param {Array<{ source: string, cell: Cell }>} cells
 */
export function signatureOf(kind, signals, cells) {
  const ids = [
    ...signals.map((s) => `signal:${SIGNAL_KEYS.map((k) => s[/** @type {keyof Signal} */ (k)] ?? '-').join('/')}`),
    ...cells.map((c) => `cell:${c.source.startsWith('own') ? c.source : 'cross'}/${c.cell.lane}/${c.cell.model}`),
  ].sort();
  return createHash('sha256').update(`${kind}\n${ids.join('\n')}`).digest('hex').slice(0, 24);
}

/**
 * One finding against the aggregate: what it rests on, its kind and signature, or why it is
 * refused. Pure.
 * @param {Finding} f @param {Aggregate} a
 * @returns {{ ok: true, checked: Checked } | { ok: false, why: string }}
 */
export function checkFinding(f, a) {
  if (!f.title) return { ok: false, why: 'it has no title' };
  if (f.title.length > MAX_TITLE) return { ok: false, why: `its title is over ${MAX_TITLE} characters` };
  if (!f.body.trim()) return { ok: false, why: 'it has no body' };
  if (f.body.length > MAX_BODY) return { ok: false, why: `its body is over ${MAX_BODY} characters` };
  if (f.signals.length + f.cells.length === 0) return { ok: false, why: 'it names no signal and no cell of the aggregate to rest on' };
  /** @type {Signal[]} */
  const signals = [];
  for (const [i, ref] of f.signals.entries()) {
    const s = resolveSignal(ref, a);
    if (!s) return { ok: false, why: `its signal ${i + 1} is not exactly one of the aggregate's signals (lane, reason, failed_stage, kanon_error, kanon_version)` };
    if (!signals.includes(s)) signals.push(s);
  }
  /** @type {Array<{ source: string, cell: Cell }>} */
  const cells = [];
  for (const [i, ref] of f.cells.entries()) {
    const c = resolveCell(ref, a);
    if (!c) return { ok: false, why: `its cell ${i + 1} is not one of the aggregate's \`own\` or \`cross_adopter\` cells` };
    if (!cells.some((x) => x.cell === c.cell)) cells.push(c);
  }
  const prose = proseProblem(`${f.title}\n${f.body}`, a);
  if (prose) return { ok: false, why: prose };
  const kind = signals.length ? 'bug' : 'spec-delta';
  if (kind === 'bug' && !SEVERITIES.includes(f.severity)) return { ok: false, why: `it rests on a failure signal, so it is a bug, and its severity is not one of ${SEVERITIES.join(', ')}` };
  return { ok: true, checked: { kind, signals, cells, signature: signatureOf(kind, signals, cells) } };
}

const usd = (/** @type {number} */ n) => `$${n.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')}`;
const cellText = (/** @type {string | null} */ v) => (v === null ? '—' : `\`${v}\``);

/**
 * The figures an issue quotes, rendered from the aggregate, and the signature marker.
 * @param {Checked} c @param {Aggregate} a
 */
export function renderEvidence(c, a) {
  const out = ['## What the aggregate shows', '',
    `These are the only figures this issue quotes. They come from Kanon's aggregate function, computed ${a.computed_at} (plan 0002 §6.1): a cross-adopter cell combines at least ${a.min_adopters} adopters, an own cell is one adopter's own figures, published because it declared them publishable, and a signal counts the adopters a failure affected over ${a.signal_days} days, with no cost and no run count.`, ''];
  if (c.signals.length) {
    out.push('| Lane | Reason | Failed stage | Kanon error | Kanon version | Adopters affected |', '|---|---|---|---|---|---|');
    for (const s of c.signals) out.push(`| ${cellText(s.lane)} | ${cellText(s.reason)} | ${cellText(s.failed_stage)} | ${cellText(s.kanon_error)} | ${cellText(s.kanon_version)} | ${s.adopters_affected} |`);
    out.push('');
  }
  if (c.cells.length) {
    out.push('| Figures | Lane | Model | Runs | Median cost per run | 90th percentile cost per run |', '|---|---|---|---|---|---|');
    for (const { source, cell } of c.cells) out.push(`| ${source} | ${cellText(cell.lane)} | ${cellText(cell.model)} | ${cell.runs} | ${usd(cell.median_cost_usd)} | ${usd(cell.p90_cost_usd)} |`);
    out.push('');
  }
  out.push(`<!-- ${MARKER}=${c.signature} -->`);
  return out.join('\n');
}

/** The signature an issue body carries, or null. @param {string} body */
export const signatureIn = (body) => new RegExp(`<!--\\s*${MARKER}=([0-9a-f]{24})\\s*-->`).exec(String(body ?? ''))?.[1] ?? null;

/** @param {string} url an issue's URL, as `gh issue create` prints it */
const issueNumber = (url) => {
  const m = /\/issues\/(\d+)\s*$/.exec(url.trim());
  if (!m) throw new Error(`gh printed no issue URL: ${url.trim().slice(0, 120)}`);
  return Number(m[1]);
};

/** @typedef {(args: string[], input?: string) => string} Gh */

/**
 * The finding rows of this run's drafts (plan 0006 §5, step 1), written in one go, and what each
 * draft shows of them, by signature. The codes are what the finding rests on, checked against
 * the aggregate; the agent's `upstream` adds only rule ids, Kanon paths, a fix category and text.
 * @param {{ repo: string, a: Aggregate, drafts: Array<{ f: Finding, c: Checked }>, level: Level, send: Send | undefined,
 *   log: (line: string) => void }} o
 * @returns {{ blocks: Map<string, string>, written: number, failed: boolean }}
 */
function sendFindings({ repo, a, drafts, level, send, log }) {
  /** @type {Map<string, string>} */
  const blocks = new Map();
  if (!send) {
    log('::warning title=telemetry explorer finding rows::the repository sends its findings to Kanon, but this step was given nowhere to write their rows, so none was sent');
    return { blocks, written: 0, failed: false };
  }
  const items = drafts.map(({ f, c }) => {
    const s = c.signals[0];
    const lane = s ? s.lane : c.cells[0]?.cell.lane;
    const raw = { ...(typeof f.upstream === 'object' && f.upstream !== null && !Array.isArray(f.upstream) ? f.upstream : {}),
      lane, failed_stage: s?.failed_stage ?? undefined, kanon_error: s?.kanon_error ?? undefined, reason: s?.reason ?? undefined };
    return { subject: 'lane', ...readUpstream(raw, send.isKanonFile), ...(s?.kanon_version ? { kanon_version: s.kanon_version } : {}) };
  });
  const needsContext = level === 'evidence' && items.some((i) => i.evidence || i.suggested_fix);
  const context = needsContext && send.nameHashes !== null
    ? { nameHashes: new Set([...send.nameHashes, ...nameContext({ repository: repo, actor: send.actor ?? '' })]), kanonFiles: send.isKanonFile }
    : {};
  const contextProblem = needsContext && send.nameHashes === null ? 'the App register\'s names were not read in the gate job' : undefined;
  const { rows, outcomes } = buildRows({ reporter: 'explore-telemetry', level, items, send, context, contextProblem, check: (t) => proseProblem(t, a) });
  if (rows.length) {
    try {
      send.write(rows);
    } catch (e) {
      const why = String(/** @type {Error} */ (e).message).split('\n')[0] ?? '';
      log(`::error title=telemetry explorer finding rows::${why}: the ${rows.length} finding row(s) of this run were not written, so none was sent to Kanon`);
      for (const { c } of drafts) blocks.set(c.signature, notWritten(why));
      return { blocks, written: 0, failed: true };
    }
  }
  drafts.forEach(({ c }, i) => blocks.set(c.signature, renderSent(/** @type {import('./lib/finding-rows.mjs').Outcome} */ (outcomes[i]))));
  return { blocks, written: rows.length, failed: false };
}

/**
 * The whole step. Returns the exit code; prints its annotations through `log` and its summary
 * through `summary`. With `sent` or `sent with evidence`, `send` is where its rows go.
 * @param {{ repo: string, text: string | null, aggregateText: string | null, agentOutcome: string, gh: Gh,
 *   log?: (line: string) => void, summary?: (line: string) => void, upstream?: string, send?: Send }} o
 * @returns {number}
 */
export function fileFindings({ repo, text, aggregateText, agentOutcome, gh, log = console.log, summary = () => {}, upstream: declared, send }) {
  const { upstream: choice, unknown, level } = upstreamChoice(declared);
  if (unknown !== undefined) {
    log(`::warning title=telemetry explorer upstream choice::the lane passed \`${unknown}\`, which is neither \`drafted\` nor \`filed here\`, so the findings are drafted, not filed (K-LAYOUT-10)`);
  }
  /** @type {Aggregate} */
  let a;
  try {
    if (aggregateText === null) throw new AggregateError('the aggregate the agent read is missing');
    a = checkAggregate(JSON.parse(aggregateText));
  } catch (e) {
    log(`::error title=telemetry explorer::${e instanceof AggregateError ? e.message : 'the aggregate the agent read does not parse'}, so nothing can be checked and nothing was filed.`);
    return 1;
  }
  if (text === null) {
    log(`::error title=telemetry explorer produced nothing::The agent wrote no ${REPORT}, so nothing was filed and the run was lost (the agent step's outcome: ${agentOutcome || 'unknown'}). Why it stopped is on this run's telemetry row.`);
    return 1;
  }
  /** @type {Report} */
  let report;
  try {
    report = parseReport(text);
  } catch (e) {
    log(`::error title=telemetry explorer produced nothing::${/** @type {Error} */ (e).message}, so nothing was filed and the run was lost (the agent step's outcome: ${agentOutcome || 'unknown'}).`);
    return 1;
  }

  let failed = 0;
  /** @type {Array<{ f: Finding, c: Checked }>} */
  const ok = [];
  for (const [i, f] of report.findings.entries()) {
    const r = checkFinding(f, a);
    if (r.ok) ok.push({ f, c: r.checked });
    else {
      failed += 1;
      log(`::error title=telemetry finding refused::finding ${i + 1}: ${r.why}. It was not filed.`);
      summary(`- **Refused:** finding ${i + 1}: ${r.why}.`);
    }
  }

  if (choice !== 'filed here') {
    const seenDraft = new Set();
    /** @type {Array<{ f: Finding, c: Checked }>} */
    const drafts = [];
    for (const { f, c } of ok) {
      if (seenDraft.has(c.signature)) { summary(`- **Held:** "${f.title}": another finding this run has the same signature.`); continue; }
      seenDraft.add(c.signature);
      drafts.push({ f, c });
    }
    const sent = level ? sendFindings({ repo, a, drafts, level, send, log }) : null;
    if (sent?.failed) failed += 1;
    if (level && drafts.length) summary(sentSentence(level));
    for (const { f, c } of drafts) {
      const names = labelsFor(c.kind, f.severity);
      const block = sent?.blocks.get(c.signature);
      summary(`\n### Draft: ${f.title}\n\nLabels: ${names.map((l) => `\`${l}\``).join(', ')}. Milestone: ${milestoneFor(names)}.\n\n${f.body.trim()}\n\n${renderEvidence(c, a)}\n${block ? `\n${block}\n` : ''}`);
    }
    log(`${seenDraft.size} finding(s) drafted in the run's summary, none filed: this repository's adoption record doesn't say \`Upstream findings: filed here\` (K-LAYOUT-10).`);
    summary(`- ${report.findings.length} finding(s) in the report, ${seenDraft.size} drafted above and not filed (this repository doesn't declare \`Upstream findings: filed here\`), ${report.held_back.length} candidate(s) the agent held back.`);
    if (sent) summary(`- ${sent.written} finding row(s) written for Kanon's telemetry store, at \`${level}\`.`);
    if (agentOutcome === 'failure') log(`::warning title=telemetry explorer exited non-zero after writing its report::The agent exited non-zero, but its ${REPORT} was valid, so it was drafted from.`);
    return failed > 0 ? 1 : 0;
  }

  /** @type {Map<string, number>} */
  let open = new Map();
  if (ok.length) {
    try {
      const issues = /** @type {Array<{ number: number, body: string }>} */ (JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', 'agent:explorer', '--state', 'open', '--limit', '500', '--json', 'number,body'])));
      open = new Map(issues.flatMap((x) => { const s = signatureIn(x.body); return s ? [[s, x.number]] : []; }));
    } catch (e) {
      log(`::error title=telemetry explorer::could not list the open \`agent:explorer\` issues to deduplicate against (${String(/** @type {Error} */ (e).message).split('\n')[0]}), so nothing was filed.`);
      return 1;
    }
  }

  let filed = 0;
  const seen = new Set();
  for (const { f, c } of ok) {
    if (seen.has(c.signature)) { summary(`- **Held:** "${f.title}": another finding this run has the same signature.`); continue; }
    seen.add(c.signature);
    const evidence = renderEvidence(c, a);
    const existing = open.get(c.signature);
    try {
      if (existing !== undefined) {
        gh(['issue', 'comment', String(existing), '--repo', repo, '--body-file', '-'], signed(`Seen again in this week's aggregate.\n\n${evidence}`, 'Explorer', appPersona('Explorer')));
        log(`commented on #${existing}: the same signature`);
        summary(`- **Seen again:** #${existing}`);
        continue;
      }
      if (filed >= MAX_FILED) { summary(`- **Held:** "${f.title}": ${MAX_FILED} issues were filed this run already.`); continue; }
      const names = labelsFor(c.kind, f.severity);
      const labels = names.flatMap((l) => ['--label', l]);
      // The agent's prose holds no HTML comment (`proseProblem`), so no marker of its own can
      // stand in for the Explorer's header.
      const number = issueNumber(gh(['issue', 'create', '--repo', repo, '--title', f.title, '--body-file', '-', ...labels, '--milestone', milestoneFor(names)],
        signed(`${f.body.trim()}\n\n${evidence}`, 'Explorer', appPersona('Explorer'))));
      filed += 1;
      log(`filed #${number} (${c.kind}): ${f.title}`);
      summary(`- **Filed:** #${number} (${c.kind})`);
    } catch (e) {
      failed += 1;
      log(`::error title=telemetry finding not filed::"${f.title}": ${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
    }
  }
  summary(`- ${report.findings.length} finding(s) in the report, ${filed} filed, ${report.held_back.length} candidate(s) the agent held back.`);
  if (report.findings.length === 0) log('No findings this run: nothing to file.');
  if (agentOutcome === 'failure') {
    log(`::warning title=telemetry explorer exited non-zero after writing its report::The agent exited non-zero, but its ${REPORT} was valid, so it was filed from. Why it exited is on this run's telemetry row.`);
  }
  return failed > 0 ? 1 : 0;
}

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  if (!process.env.GITHUB_REPOSITORY) {
    console.error('telemetry-file: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  /** @type {Gh} */
  const gh = (args, input) => {
    beforeApply(args, (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  };
  const read = (/** @type {string | undefined} */ at) => (at && existsSync(at) ? readFileSync(at, 'utf8') : null);
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) appendFileSync(out, '## Telemetry findings\n\n');
  process.exitCode = fileFindings({
    repo: process.env.GITHUB_REPOSITORY,
    text: read(process.env.REPORT_PATH || REPORT),
    aggregateText: read(process.env.AGGREGATE_PATH),
    agentOutcome: String(process.env.AGENT_OUTCOME ?? ''),
    upstream: process.env.UPSTREAM,
    gh,
    send: sendFromEnv(process.env),
    summary: (line) => { if (out) appendFileSync(out, `${line}\n`); },
  });
}
/* c8 ignore stop */
