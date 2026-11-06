#!/usr/bin/env node
// kanon#1568 — a red default branch is one issue, filed and kept until the branch is green again
// (the Owner's decision of 2026-11-06). Run by the dispatch sweep, after its own reconcile, on the
// Lead's App token; it adds no schedule of its own.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Two pull requests, each green on its own base, merged minutes apart, and together turned the
// default branch's CI red. Nothing said so: the reconciler reports red pull requests, not a red
// default branch. Every open pull request's required check then failed for a cause outside its
// diff, and the Reviewer requested changes on each. A merge queue makes this rarer, never
// impossible, so it holds with or without one (`K-MERGE-7` is unchanged).
//
// ── WHAT IT DOES ────────────────────────────────────────────────────────────
// It reads the latest completed `push` run of the CI workflow (`.github/workflows/ci.yml`, the
// file `kanon init` writes and the review lane waits on) on the default branch:
//  - RED (failure, timed out, startup failure): it files one issue naming the run and its first
//    failing job, or, when one is open already, comments on it once per new red run;
//  - GREEN: it closes the open issue, naming the green run.
// The open issue is found by its marker, `<!-- kanon:default-branch-red -->`, never by its title,
// and only in an issue the Lead's App opened: a person who quotes the marker in an issue of their
// own (`K-AGENT-45`) has that issue left alone, and so is a run marker they quote in a comment.
// Every post is signed as the Lead (plan 0005 §3.3).
//
// ── A REPOSITORY THAT WATCHES ITS OWN DEFAULT BRANCH ──────────────────────────
// A repository may already have a workflow of its own that files such an issue. Two filers would
// file two issues, so a repository declares its own under `## Choices` in its adoption record,
// `- **Default-branch watcher:** \`<workflow>.yml\``, and this then does nothing. That is the
// rule for every repository, Kanon's own included; nothing here names one.
//
// NON-FATAL, like the sweep that runs it: a failed read or write is a ::warning:: and exit 0. A
// missed tick costs nothing: the next one reads the same run. SAFE BY DEFAULT: without APPLY=1
// (or --apply) it prints what it would do.
//
// DEPENDENCY-FREE: `node:` and `gh` only, like every script under scripts/ (`K-SELF-8`).
//
// Env: GH_TOKEN (the Lead's App token in the sweep), GITHUB_REPOSITORY (required: it exits 2
// without it, before it reads anything), APPLY.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { appLogin, appPersona } from './app-register.mjs';
import { plan } from './issue-triage-defaults.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { signed } from './lib/role-marker.mjs';

/** The marker the open issue carries, and with it, the run each red one was filed or updated for. */
export const MARKER = '<!-- kanon:default-branch-red -->';
const runMarker = (/** @type {number} */ id) => `<!-- kanon:default-branch-red run=${id} -->`;

/** The CI workflow it watches: the file `kanon init` writes, and the review lane waits on. */
export const CI_WORKFLOW = 'ci.yml';

/** The adoption record's bullet that names a watcher of the repository's own. */
export const WATCHER_LABEL = 'Default-branch watcher';

/** The conclusions that make a run red. */
export const RED = ['failure', 'timed_out', 'startup_failure'];

/** The issue's labels: a defect, at a gate severity, since every open pull request waits on it. */
export const LABELS = ['bug', 'sev:high'];

/**
 * The watcher a repository declares under `## Choices` in its adoption record, or null.
 * @param {string | null} record
 */
export function declaredWatcher(record) {
  if (!record) return null;
  const choices = /^## Choices[ \t]*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(record)?.[1] ?? '';
  const m = new RegExp(`^- \\*\\*${WATCHER_LABEL}:\\*\\* \`([^\`]+)\``, 'm').exec(choices);
  return m ? m[1] ?? null : null;
}

/**
 * The run ids the open issue has already been filed or updated for, from its body and comments.
 * @param {string[]} texts
 */
export function notedRuns(texts) {
  return new Set(texts.flatMap((t) => [...t.matchAll(/<!-- kanon:default-branch-red run=(\d+) -->/g)].map((m) => Number(m[1]))));
}

/** A login as `gh` gives it, for a comparison: without `app/` or `[bot]`, in lower case. @param {unknown} login */
const bare = (login) => String(login ?? '').replace(/^app\//, '').replace(/\[bot\]$/, '').toLowerCase();

/**
 * The open issue this files and keeps: the first that carries the marker and that the Lead's App
 * opened, or null. Another author's issue that quotes the marker is never it.
 * @template {{ body?: string | null, author?: { login?: string } | null }} T
 * @param {T[]} issues @param {string} lead the Lead's App login, from the register
 * @returns {T | null}
 */
export function ownIssue(issues, lead) {
  return issues.find((i) => String(i.body ?? '').includes(MARKER) && bare(i.author?.login) === bare(lead)) ?? null;
}

/**
 * The texts of the Lead's own comments, the ones whose run markers count.
 * @param {Array<{ body?: string | null, author?: { login?: string } | null }>} comments @param {string} lead
 */
export function ownTexts(comments, lead) {
  return comments.filter((c) => bare(c.author?.login) === bare(lead)).map((c) => String(c.body ?? ''));
}

/**
 * What to do, from the latest completed push run and the open issue, if any.
 * @param {{ run: { id: number, conclusion: string, url: string, sha: string } | null,
 *   job: { name: string, url: string } | null, open: { number: number, texts: string[] } | null, branch: string }} c
 * @returns {{ act: 'none', why: string } | { act: 'file', title: string, body: string }
 *   | { act: 'comment', issue: number, body: string } | { act: 'close', issue: number, body: string }}
 */
export function nextStep({ run, job, open, branch }) {
  if (!run) return { act: 'none', why: `no completed push run of ${CI_WORKFLOW} on ${branch}` };
  const failing = job ? `its first failing job is [${job.name}](${job.url})` : 'GitHub names no failing job';
  if (RED.includes(run.conclusion)) {
    if (open) {
      if (notedRuns(open.texts).has(run.id)) return { act: 'none', why: `#${open.number} already names run ${run.id}` };
      return { act: 'comment', issue: open.number, body: [runMarker(run.id), `Still red: [run ${run.id}](${run.url}) on \`${run.sha.slice(0, 7)}\` concluded \`${run.conclusion}\`, and ${failing}.`].join('\n') };
    }
    return {
      act: 'file',
      title: `CI is red on ${branch}`,
      body: [
        MARKER,
        runMarker(run.id),
        `The latest push run of \`${CI_WORKFLOW}\` on \`${branch}\`, [run ${run.id}](${run.url}) on \`${run.sha.slice(0, 7)}\`, concluded \`${run.conclusion}\`, and ${failing} (kanon#1568).`,
        '',
        '## What must be true',
        '',
        `\`${branch}\`'s CI is green again. Until it is, every open pull request's required check can fail for a cause outside its diff: read a red check there against this run before blaming the pull request.`,
        '',
        `_Filed by \`scripts/default-branch-red.mjs\` from the dispatch sweep. It comments here on each new red run, and closes this once \`${branch}\` is green._`,
      ].join('\n'),
    };
  }
  if (run.conclusion === 'success' && open) {
    return { act: 'close', issue: open.number, body: `Green again: [run ${run.id}](${run.url}) on \`${run.sha.slice(0, 7)}\` passed (kanon#1568).` };
  }
  return { act: 'none', why: `the latest push run of ${CI_WORKFLOW} on ${branch} is \`${run.conclusion}\`${open ? '' : ', and no issue is open'}` };
}

/* c8 ignore start — the CLI: `gh` calls around `decide`. */
if (isCliEntry(import.meta.url)) {
  const REPO = process.env.GITHUB_REPOSITORY;
  if (!REPO) {
    console.error('default-branch-red: GITHUB_REPOSITORY must be set');
    process.exit(2);
  }
  const APPLY = process.env.APPLY === '1' || process.argv.includes('--apply');
  const say = (/** @type {string} */ line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const gh = (/** @type {string[]} */ args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const json = (/** @type {string[]} */ args) => JSON.parse(gh(args));
  try {
    const record = existsSync('docs/qa/adoption.md') ? readFileSync('docs/qa/adoption.md', 'utf8') : null;
    const watcher = declaredWatcher(record);
    if (watcher) {
      say(`Default branch: the adoption record names a watcher of its own, \`${watcher}\`, so this files nothing (kanon#1568).`);
      process.exit(0);
    }
    const branch = json(['api', `repos/${REPO}`]).default_branch;
    let runs;
    try {
      runs = json(['api', `repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=1`]).workflow_runs ?? [];
    } catch (e) {
      // Only a 404 means there is no `ci.yml`. A 403 (no `Actions: read`), a 5xx or anything else is
      // a read that failed, and says so, so a broken grant never looks like a repository with no CI.
      if (/HTTP 404|Not Found/.test(String(/** @type {Error} */ (e).message))) {
        say(`Default branch: no \`${CI_WORKFLOW}\` to read, so nothing to watch.`);
        process.exit(0);
      }
      throw e;
    }
    const r = runs[0];
    const run = r ? { id: Number(r.id), conclusion: String(r.conclusion), url: String(r.html_url), sha: String(r.head_sha) } : null;
    let job = null;
    if (run && RED.includes(run.conclusion)) {
      const jobs = json(['api', `repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`]).jobs ?? [];
      const first = jobs.find((/** @type {any} */ j) => RED.includes(j.conclusion));
      if (first) job = { name: String(first.name), url: String(first.html_url) };
    }
    const lead = appLogin('Lead');
    const found = ownIssue(/** @type {Array<{ number: number, body?: string | null, author?: { login?: string } | null }>} */ (json(['issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '500', '--json', 'number,body,author'])), lead);
    const open = found
      ? { number: found.number, texts: [String(found.body ?? ''), ...ownTexts(json(['issue', 'view', String(found.number), '--repo', REPO, '--json', 'comments']).comments ?? [], lead)] }
      : null;
    const d = nextStep({ run, job, open, branch });
    if (d.act === 'none') say(`Default branch: nothing to do — ${d.why}.`);
    else if (!APPLY) say(`Default branch: would ${d.act}${'issue' in d ? ` #${d.issue}` : ''} (dry run).`);
    else if (d.act === 'file') {
      const { args } = plan(LABELS, { subject: 'product' });
      say(`Default branch: filed ${gh(['issue', 'create', '--repo', REPO, '--title', d.title, '--body', signed(d.body, 'Lead', appPersona('Lead')), ...args]).trim()}.`);
    } else if (d.act === 'comment') {
      gh(['issue', 'comment', String(d.issue), '--repo', REPO, '--body', signed(d.body, 'Lead', appPersona('Lead'))]);
      say(`Default branch: still red, noted on #${d.issue}.`);
    } else {
      gh(['issue', 'close', String(d.issue), '--repo', REPO, '--comment', signed(d.body, 'Lead', appPersona('Lead'))]);
      say(`Default branch: green again, closed #${d.issue}.`);
    }
  } catch (e) {
    console.log(`::warning title=default-branch-red::${String(/** @type {Error} */ (e).message).split('\n')[0]}`);
  }
}
/* c8 ignore stop */
