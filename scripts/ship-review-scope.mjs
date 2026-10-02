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
 * ── WHICH PATHS: FOUR OF THE MERGER'S AREAS, NOT A COPY ────────────────────────────
 * "Where a missed bug is expensive" starts from `ESCALATE_PATHS` in `merge-gate.mjs`, the
 * set the Merger refuses to merge without a human, and narrows it to FOUR areas (the
 * developer's call, 2026-09-24): payments, auth, schema/migrations, and the QA pipeline
 * (`.github/workflows/agent-*`, the spine's blocks, `.github/scripts/**`, `scripts/qa/**`). The rest of the
 * merge gate's set is still a human's to merge, but not worth ~$1 a branch here: the
 * rest of `.github/**` (mostly CI, deploy and release workflows), the `docs/qa/*.md`
 * playbooks, and `sst.config.ts`. `.github/scripts/**` is taken whole, as decided, so
 * the few deploy/release helpers in it are reviewed too; the QA pipeline's workflows
 * that are not named `agent-*` (`label-guard.yml`, say) are not.
 *
 * The areas are chosen BY NAME from `ESCALATE_PATHS` rather than restated as patterns, so
 * a path added to one of them is reviewed here the same day. The one pattern of its own
 * is `QA_PIPELINE_UNDER_GITHUB`: the merge gate escalates `.github/**` as a single rule,
 * and the pipeline half of it cannot be picked out by area. A reviewed area name that
 * no longer exists in `ESCALATE_PATHS` throws at import, so renaming an area in the
 * merge gate cannot silently drop it from the review.
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
import { pathToFileURL } from 'node:url';
import { ESCALATE_PATHS } from './merge-gate.mjs';

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
 * The `ESCALATE_PATHS` areas `/ship` reviews, by their label there. Four subjects —
 * schema/migrations is two merge-gate rules, and the QA pipeline is `scripts/qa/**` plus
 * the part of `.github/**` below.
 */
export const REVIEWED_AREAS = ['payments', 'auth', 'database migrations', 'the schema and RLS', 'the QA pipeline'];

/**
 * The merge gate's `.github/**` rule, labelled with this area. Only its QA-pipeline half
 * is reviewed.
 */
export const GITHUB_AREA = 'the CI/agent pipeline';

/**
 * The QA pipeline's files under `.github/`: the agent workflows and their scripts. This
 * cannot be derived from `ESCALATE_PATHS`, whose single `^\.github\/` rule also covers
 * CI, deploy and release workflows. It is applied only to a file that rule already
 * matched, so it narrows the merge gate's set and never widens it.
 *
 * AND THE SPINE'S BLOCKS (RA-2666). `agent-lane.yml`'s steps moved into the composite
 * actions `agent-setup`, `agent-run` and `agent-finish` (`LANE_BLOCKS` in
 * `lib/agent-lanes.mjs`, which the unit test holds this to). They were reviewed here as
 * part of an `agent-*` workflow, and a move must not take them out of review. Only the
 * blocks: the rest of `.github/actions/` stays where the 2026-09-24 decision left it.
 * `agent-classify` joined them in RA-2691, carrying the classifier out of `.github/scripts/`,
 * where it was reviewed — so the move keeps it in review. And the project-setup hook
 * (RA-2694), which took the install, `db:init` and the per-lane switches out of the blocks
 * and the spine: the same move, kept in review the same way.
 *
 * SINCE RA-2704 THE BLOCKS ARE KANON'S, so they left this tree and this pattern: they are
 * reviewed in Kanon, and a change to which release runs is a change to the `uses:` lines of
 * the `agent-*` workflows, which this pattern still reviews. The hook stays.
 */
export const QA_PIPELINE_UNDER_GITHUB = /^\.github\/(?:workflows\/agent-[^/]+|scripts\/.+|actions\/project-setup\/.+)$/;

const knownAreas = new Set(ESCALATE_PATHS.map(([, area]) => area));
for (const area of [...REVIEWED_AREAS, GITHUB_AREA]) {
  if (!knownAreas.has(area)) {
    throw new Error(`ship-review-scope: area "${area}" is not in merge-gate.mjs's ESCALATE_PATHS. It was renamed or removed, so /ship would stop reviewing it silently.`);
  }
}

const reviewed = (file, area) =>
  REVIEWED_AREAS.includes(area) || (area === GITHUB_AREA && QA_PIPELINE_UNDER_GITHUB.test(file));

/** Each changed file that falls in a reviewed area, with the area it belongs to. */
export function sensitiveHits(files) {
  const hits = [];
  for (const file of files) {
    const hit = ESCALATE_PATHS.find(([re, area]) => re.test(file) && reviewed(file, area));
    // A `.github/` hit is reported as the area it was admitted for, not the whole rule's.
    if (hit) hits.push({ file, area: hit[1] === GITHUB_AREA ? 'the QA pipeline' : hit[1] });
  }
  return hits;
}

/**
 * @param {string[]} files  changed paths, `<base>...HEAD`
 * @param {{ env?: Record<string, string|undefined>, skip?: string|null }} opts
 */
export function reviewScope(files, { env = process.env, skip = null } = {}) {
  const hits = sensitiveHits(files);
  const docsOnly = hits.length > 0 && hits.every(({ file }) => /\.md$/i.test(file));
  const base = { hits, docsOnly };
  if (inCi(env)) {
    return { ...base, action: 'skip', rule: 'ci', why: 'running in CI — the local review is local-only, it never spends the CI subscription pool' };
  }
  if (files.length === 0) {
    return { ...base, action: 'skip', rule: 'no-diff', why: 'no committed changes against the base — commit first, a range review cannot see the working tree' };
  }
  if (hits.length === 0) {
    return { ...base, action: 'skip', rule: 'no-sensitive-path', why: 'touches none of the reviewed areas (payments, auth, schema/migrations, the QA pipeline)' };
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
  const files = inCi(process.env) ? [] : parseNames(execFileSync('git', diffArgs(base), { encoding: 'utf8' }));
  const verdict = reviewScope(files, { skip });

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

// `process.argv[1]` is undefined when imported by a test runner (RA-1071).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
