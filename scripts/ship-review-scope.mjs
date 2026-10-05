#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/**
 * Should `/ship` run `/code-review high` on this branch before the PR opens? (RA-781)
 *
 * The RA-781 spike ran `/code-review high` on the approved heads of five PRs whose bugs
 * the Reviewer missed: it caught 2–3 of the 5, and 42 of its 50 findings held up (0 invalid),
 * at ~$1 a run. That earns it a place as a LOCAL, ADVISORY second opinion — but only
 * where a missed bug is expensive, because $1 on every docs tweak is not.
 *
 * ── WHICH PATHS: THE PROJECT'S, FROM ITS ESCALATION FILE ───────────────────────────
 * "Where a missed bug is expensive" is what the project declares in
 * `docs/qa/escalation-paths.md` (`K-LAYOUT-8`, kanon#54): its high-risk paths under
 * `## Escalation paths` and its own pipeline code under `## Pipeline code`, plus Kanon's
 * agent workflows (`.github/workflows/agent-*`) and the project-setup hook. The rest of
 * the Merger's set is still a human's to merge, but not worth ~$1 a branch here: the rest of
 * `.github/**` (mostly CI, deploy and release workflows) and the `docs/qa/*.md` playbooks.
 *
 * Until kanon#54 this chose four of the reference adopter's areas by name from a list in
 * `merge-gate.mjs`. The list was that adopter's, so it left the library, and the areas are
 * now every path the project itself calls high-risk: a project that wants one reviewed
 * declares it, and one it declares is reviewed the same day.
 *
 * ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────────
 * A verdict with a reason, never a boolean — `run`, or `skip` with the rule that
 * skipped it — so the line /ship pastes into the PR body says WHY a sensitive branch
 * went unreviewed rather than just that it did.
 *
 *   ci                 CI is set. Local-only: the CI agent lanes are the subscription
 *                      pool, and the reviewer arm is already most of that spend.
 *   no-diff            nothing between the base and HEAD (uncommitted work is invisible
 *                      to a range review — commit first)
 *   no-sensitive-path  the diff touches none of the four reviewed areas
 *   declined           `--skip "<reason>"`: the agent's judgement, e.g. a docs-only
 *                      change on a pipeline path. The reason is required and printed.
 *   run                otherwise
 *
 * The TARGET is always the local range `<base>...HEAD`. Never a PR number or URL, and
 * never `--comment` / `--post`: those reach GitHub and raised app/OAuth prompts during
 * the spike.
 *
 * Usage: node scripts/ship-review-scope.mjs [--base origin/main] [--skip "<reason>"]
 */

import { execFileSync } from 'node:child_process';
import { readEscalationFile } from './lib/escalation-paths.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * True when running under CI. Only the exact value `true` counts — which is what GitHub
 * Actions (and most CI) sets. A developer's `CI=1`, exported locally to silence
 * interactive prompts, must NOT turn the review off for every branch on that machine.
 */
export function inCi(env) {
  const is = (v) => (v ?? '').trim().toLowerCase() === 'true';
  return is(env.GITHUB_ACTIONS) || is(env.CI);
}

/**
 * The pipeline's files under `.github/` that are reviewed: Kanon's agent workflows, which
 * call its lanes, and the project-setup hook, which runs before every agent. The rest of
 * `.github/` (CI, deploy and release workflows) is a human's to merge but not reviewed here.
 */
export const AGENT_PIPELINE_UNDER_GITHUB = /^\.github\/(?:workflows\/agent-[^/]+|actions\/project-setup\/.+)$/;

/**
 * Each changed file that falls in a reviewed area, with the reason the project gives for it.
 * @param {string[]} files
 * @param {import('./lib/escalation-paths.mjs').EscalationFile} escalation
 */
export function sensitiveHits(files, escalation) {
  const hits = [];
  for (const file of files) {
    const path = escalation.paths.find(({ pattern }) => pattern.test(file));
    const code = escalation.pipeline.find(({ dir }) => file.startsWith(dir));
    const area = path?.reason ?? code?.reason ?? (AGENT_PIPELINE_UNDER_GITHUB.test(file) ? 'the agent pipeline' : null);
    if (area) hits.push({ file, area });
  }
  return hits;
}

/**
 * @param {string[]} files  changed paths, `<base>...HEAD`
 * @param {{ env?: Record<string, string|undefined>, skip?: string|null, escalation: import('./lib/escalation-paths.mjs').EscalationFile }} opts
 */
export function reviewScope(files, { env = process.env, skip = null, escalation }) {
  const hits = sensitiveHits(files, escalation);
  const docsOnly = hits.length > 0 && hits.every(({ file }) => /\.md$/i.test(file));
  const base = { hits, docsOnly };
  if (inCi(env)) {
    return { ...base, action: 'skip', rule: 'ci', why: 'running in CI — the local review is local-only, it never spends the CI subscription pool' };
  }
  if (files.length === 0) {
    return { ...base, action: 'skip', rule: 'no-diff', why: 'no committed changes against the base — commit first, a range review cannot see the working tree' };
  }
  if (hits.length === 0) {
    return { ...base, action: 'skip', rule: 'no-sensitive-path', why: `touches none of the reviewed areas (the paths and pipeline code in docs/qa/escalation-paths.md, and the agent workflows)` };
  }
  if (skip !== null) {
    const reason = String(skip).trim();
    if (!reason) throw new Error('--skip needs a reason: the skip is logged in the PR body, and an unexplained skip is indistinguishable from a forgotten one');
    return { ...base, action: 'skip', rule: 'declined', why: reason };
  }
  const areas = [...new Set(hits.map((h) => h.area))];
  return { ...base, action: 'run', rule: 'sensitive-path', why: `touches ${areas.join('; ')}` };
}

/** The one line /ship pastes into the PR body. */
export function summaryLine(verdict, base = 'origin/main') {
  const target = `\`/code-review high ${base}...HEAD\``;
  const why = verdict.why.replace(/[\s.!?]+$/, '');
  return verdict.action === 'run'
    ? `Local ${target}: run — ${why}.`
    : `Local ${target}: skipped (${verdict.rule}) — ${why}.`;
}

/**
 * The git call that lists the branch's files. `-z` because the default `core.quotePath`
 * wraps a non-ASCII path in quotes and octal escapes, and an anchored rule then misses
 * it (`"src/db/sch\303\251ma.ts"` is not `^src\/db\/`). `--no-renames` because a rename
 * OFF a sensitive path changes it too. Three dots: the branch's own changes, not main's.
 */
export function diffArgs(base) {
  return ['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`];
}

export function parseNames(out) {
  return out.split('\0').filter(Boolean);
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function main(argv = process.argv.slice(2)) {
  const base = arg(argv, '--base') ?? 'origin/main';
  const skip = arg(argv, '--skip');
  // CI is decided BEFORE git is touched. A CI checkout is shallow (`actions/checkout`
  // defaults to fetch-depth 1), so the three-dot range has no merge base and the git
  // call throws — which would turn the documented `skip (ci)` into an exit 1 (RA-2332).
  const ci = inCi(process.env);
  const files = ci ? [] : parseNames(execFileSync('git', diffArgs(base), { encoding: 'utf8' }));
  // The escalation file is read only when the verdict can depend on it, and a missing or
  // malformed one stops the run by name (kanon#54).
  const verdict = reviewScope(files, { skip, escalation: ci ? { paths: [], pipeline: [] } : readEscalationFile() });

  console.log(summaryLine(verdict, base));
  for (const { file, area } of verdict.hits) console.log(`  ${file}  (${area})`);
  if (skip !== null && verdict.rule !== 'declined') {
    console.log(`(--skip reason not used: the verdict is ${verdict.rule}, which is decided before a reason is considered)`);
  }
  if (verdict.action === 'run') {
    console.log(`\nRun: /code-review high ${base}...HEAD   (local range only — no PR number, no --comment/--post)`);
    if (verdict.docsOnly) {
      console.log('Every sensitive hit is Markdown, which usually changes no behaviour: --skip "<reason>" fits it.');
    }
  }
}

// Importing this module with no argv[1] must not crash (RA-1071); `isCliEntry` holds that.
if (isCliEntry(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
