#!/usr/bin/env node
// The red-test check (`K-MERGE-13`): verify an agent's "confirmed it fails" claim instead of
// trusting it. Moved from the reference adopter's pipeline library (plan 0001 §7), and
// generalised to read the project's stack from its stack document rather than assume one.
//
// The implement lanes tell the Implementer to write the test FROM the acceptance criteria,
// confirm it fails, then implement until it passes (`K-AGENT-15`). The middle step is the only
// one with no artifact, it is the most attractive thing to fake, and without this check it is
// an unverified claim by the party that benefits from it being believed.
//
// This reverts the non-test half of the diff and re-runs the changed tests. If they still pass,
// the tests prove nothing.
//
// IT IS NOT THE WHOLE STORY, deliberately. It proves SENSITIVITY to the diff, never that the
// assertion is meaningful: whether each test asserts the invariant it claims stays the
// Reviewer's, who reads this result rather than re-deriving it (`K-AGENT-24`), and is told a
// green check is not a verdict on the test. What it does buy is a mechanical guard against a
// trivially-true test.
//
// WHY CI AND NOT A REVIEWER STEP. What a prompt cannot be is a REQUIRED-SHAPED CHECK: whether
// it ran and what its result meant would both become model judgement, and a prompt-only gate is
// a gate a model can talk itself past (`K-PRIN-4`). A workflow is deterministic (same diff,
// same verdict), costs no agent's turns, and leaves a check rather than a transcript.
//
// ── SCOPED TO AGENT PRs, AND THAT SCOPE IS MEASURED (ADR 0004 §7) ─────────────
// Measured in the reference adopter over its most recent merged PRs touching both source and
// tests: the agents' tests went red on the reverted tree; none of the people's did, and about
// half of the measurable PRs would have been blocked. The mechanism is not a coincidence: an
// agent's tests are written FROM the change under a test-first instruction, so they are
// sensitive by construction. People change source for reasons no test covers, and touch tests
// for adjacent reasons. So it runs where the CLAIM IS MADE: the workflow scopes it by the
// `agent:implement` and `agent:triage` labels. A person's PR never claimed "confirmed it fails".
//
// ── WHAT IS A TEST, WHAT IS SOURCE, AND HOW A TEST IS RUN: THE PROJECT'S, NOT KANON'S ──
// The adopter's copy named its own stack: TypeScript under `tests/` and `e2e/`, its own source
// directories, its infrastructure config by name, and `npx vitest --project unit|integration`.
// Kanon is stack-neutral, so each of those answers now comes from where Kanon's other guards
// take it:
//   test side  a file in a `tests` tree the stack document declares (`K-LAYOUT-17`,
//              `scripts/lib/code-areas.mjs`), fixtures and helpers included, or a test by its
//              language's convention wherever it is (ADR 0012, `scripts/lib/test-conventions.mjs`);
//              plus pytest's `conftest.py`, which the run loads like a setup file.
//   runnable   a test-side file whose runner the table knows and runs (`runnerFor`): Vitest for
//              a file in a tree that names it, pytest for a Python test, `go test` for a Go one;
//              and which that runner COLLECTS by default: for JavaScript a `*.test.*` or
//              `*.spec.*` file, for Python and Go the convention's own test files. A helper or
//              setup file beside them is loaded by the run, never collected: it is the harness.
//   browser    a file in a tree that names Playwright: it needs a built app, and is out of this
//              check's scope, as the adopter's `e2e/` was.
//   no runner  a test no declared tree names a runner for (ADR 0012: Kanon never picks a
//              JavaScript runner for the project). Reported, never run.
//   source     every other file the PR changed in a language the table reads, or a shell
//              script (a test can execute one), wherever it is. The declared `code` trees are
//              not consulted: a BLOCK is only about the change if the change was undone, so
//              this reverts what it can rather than what one declaration names. Two kinds stay
//              out: a test runner's own configuration (`vitest.config.*`, `vitest.workspace.*`,
//              `playwright.config.*`), which configures the run doing the verifying, so
//              reverting it breaks the run for a reason unrelated to the claim; and every file
//              in no language the table reads (docs, workflows, manifests, lockfiles,
//              migrations, JSON), which land in `unreverted` and are named.
//   run        one file at a time, with the command the table gives (`RUNNERS`), through the
//              toolchain the project-setup hook installed: never through a package runner that
//              fetches what it cannot find (ADR 0012 decision 4).
//
// ── NO BEHAVIOUR CHANGE, NO FIX TO PROVE (the Owner's decision of 2026-10-12, #666) ──
// A characterization test locks behaviour that is already right, so it cannot fail on a revert by
// construction, and a red check on its PR would mean nothing: every such PR would teach people to
// ignore this check. Such a PR is recognised two ways, and either one ends the check SKIPPED,
// never red, never green:
//   the diff   the non-test, non-doc change is comments or whitespace in a file present at both
//              ends, or there is none at all (`noBehaviourChange`). Decided conservatively: a file
//              the reader can't prove comment-only, or a non-doc file this job can't revert,
//              keeps the diff on the verifying path. An agent can't fake it, because a diff that
//              changes behaviour isn't comment-only.
//   a person   `test:characterization`, on the run a PERSON's applying it started
//              (`characterization`). An App's, the agents' included, is ignored: the agent cannot
//              waive the check. Read in the scope job only, where no code from the PR has run.
// Either way the PR states the mutations that turn its test red (`K-PRIN-11`), and the Reviewer
// asks for them: the test's sensitivity comes from those, since it can't come from here.
//
// ── WHAT IT JUDGES WITH IS NEVER THE PULL REQUEST'S (`K-MERGE-17`, kanon#761) ──
// The script is Kanon's, from the action cache at the caller's pin. The other input that decides
// the verdict is the stack document's `## Code areas`: which files are tests, and which runner
// runs them. Read from the PR's checkout, a PR could declare its source directory a `tests` tree,
// or drop its tree's runner, and every changed file would classify as a test that never runs: the
// plan says "nothing to verify", and the required check concludes SKIPPED, which a ruleset counts
// as passing. So the areas come from a ref the PR can't write, `--areas-ref` (the default branch,
// in the workflow's `scope` job, where none of the PR's code has run), read from git objects,
// never from the working tree. The verifying job runs the PR's setup hook first, which could
// rewrite `.git` as easily as the tree, so it gets the areas the scope job read, as
// `--areas-json` through a job output, and reads none of its own.
//
// A PR THAT CHANGES THE AREAS IS REFUSED, NEVER SKIPPED. Judged by the default branch's areas, a
// PR that adds its first `tests` tree would conclude SKIPPED (its tests have no runner yet), and
// judged by its own, it steers the check. Neither is a verdict, so the check refuses by name, red,
// and a person merges the PR (`K-MERGE-4`: the stack document is an escalation path anyway).
// "Changes" means the head declares different `tests` trees or runners from both the default
// branch and the merge base, so a branch that is only behind a default branch whose areas moved
// is judged by the default branch's, not refused. Only the `tests` entries are compared: they are
// all of the declaration this check reads. A head whose declaration can't be parsed is refused
// the same way.
//
// Usage: node "$KANON/scripts/red-test.mjs" --base <sha> --head <sha> --areas-ref <ref>
//        (or --areas-json <json>: the areas a `--plan` run with `--areas-ref` wrote)
//        (add --dry-run to classify and print without touching the tree)
//        (add --plan to classify only and write `verify=true|false` to $GITHUB_OUTPUT: the
//         workflow's `scope` job)

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { isAgentActor } from './lib/actors.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { STACK_FILE, UNDECLARED, codeAreasDefaults, isTestPath, parseCodeAreas } from './lib/code-areas.mjs';
import { commentOnly } from './lib/comment-only.mjs';
import { RUNNERS, TABLE_EXT, interpretGoJson, isTestFile, runnerFor } from './lib/test-conventions.mjs';

/** @typedef {import('./lib/code-areas.mjs').CodeAreas} CodeAreas */
/** @typedef {{ file: string, status: string, failed: number, passed: number }} FileResult */
/** @typedef {(args: string[], opts?: import('node:child_process').ExecFileSyncOptions) => string} Git */

/** @param {string} name @param {string | null} [fallback] */
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const DRY = process.argv.includes('--dry-run');
const PLAN = process.argv.includes('--plan');

/** `--plan`'s output line for a `main()` result, EXPORTED so the shipped rule is the tested one.
 *
 *  A diff with tests but no source change used to run the whole job and exit 0, so the check
 *  read SUCCESS, indistinguishable in the rollup from a claim that was verified. "Not checked"
 *  must not look like "verified", and the only way a GitHub check concludes SKIPPED is for its
 *  JOB not to run: a job whose steps all succeed is SUCCESS, whatever it printed. So the
 *  workflow asks this first, in a cheap `scope` job, and the `Red-test verification` job runs
 *  only on `verify=true`.
 *
 *  Only a `skipped` result declines. Every other result, including one that would refuse, says
 *  `true`, so the real job still runs and still reports it: the plan may narrow what is checked
 *  to "nothing to check", never to "passed".
 *  @param {Record<string, unknown> | undefined | null} r */
export const planOutput = (r) => `verify=${r?.skipped ? 'false' : 'true'}`;

/** Every line `--plan` writes to `$GITHUB_OUTPUT`: the plan, the code areas the scope job read
 *  from the trusted ref (one line of JSON, for the verifying job, which must not read its own),
 *  and whether the PR changes them.
 *  @param {Record<string, unknown> | undefined | null} r @param {CodeAreas} areas */
export const planOutputs = (r, areas) => [planOutput(r), `areas=${JSON.stringify(areas)}`, `areas_changed=${r?.areasChanged ? 'true' : 'false'}`];

/** @type {Git} */
function git(args, opts = {}) {
  return String(execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts }));
}

// ---------------------------------------------------------------------------
// Classification

/** The extensions a source file may have: every language in the test-convention table, and a
 *  shell script, which a test can execute, so reverting one is test-observable. */
const SOURCE_RE = new RegExp(`\\.(?:${TABLE_EXT}|sh)$`);

/** A test runner's own configuration. It configures the run doing the verifying, so reverting it
 *  would break the run for a cause unrelated to the claim: it is named, never reverted. Matched by
 *  the runners' own file names, never as a `*.config.*` glob, so a project's other config files
 *  (a build or infrastructure config a test reads) stay source. */
const RUNNER_CONFIG_RE = /(?:^|\/)(?:vitest\.(?:config|workspace)|playwright\.config)\.[^/]+$/;

/** A runner's harness that no declared tree need hold: pytest loads every `conftest.py` on the way
 *  to a test, as Vitest loads a setup file, so it shapes the run and is never collected. */
const HARNESS_RE = /(?:^|\/)conftest\.py$/;

/** The JavaScript suffix the common runners collect by default (ADR 0012). */
const JS_ENTRY_RE = /\.(?:test|spec)\.[^./]+$/;

/** The runners this check runs. Playwright needs a built app and is out of scope. */
const RUN = /** @type {const} */ (['vitest', 'pytest', 'go']);

/**
 * Is this file on the TEST side of the diff: a test, or a fixture, helper or setup file beside one?
 * A file in a declared `tests` tree, a test by its language's convention (with the trees, and
 * without: a co-located `*.test.*` file is never reverted, since reverting it would delete the very
 * evidence being examined), or a runner harness file.
 * @param {string} f @param {CodeAreas} areas
 */
const isTestSide = (f, areas) =>
  isTestPath(f, areas) || isTestFile(f, areas.tests) || isTestFile(f, []) || HARNESS_RE.test(f);

/**
 * Which runner this check runs a test-side file with, or why it doesn't: `browser` for a Playwright
 * file, `none` for a test no tree names a runner for, and null for a file no runner collects (a
 * helper, a setup file, a fixture), which the run still loads.
 * @param {string} file
 * @param {CodeAreas} [areas]
 * @returns {'vitest' | 'pytest' | 'go' | 'browser' | 'none' | null}
 */
export function tierOf(file, areas = UNDECLARED) {
  const runner = runnerFor(file, areas.tests);
  const entry = /\.(?:py|go)$/.test(file) ? isTestFile(file, []) : JS_ENTRY_RE.test(basename(file));
  if (!entry) return null;
  if (runner === 'playwright') return 'browser';
  if ((/** @type {readonly string[]} */ (RUN)).includes(runner)) return /** @type {'vitest' | 'pytest' | 'go'} */ (runner);
  return 'none';
}

/** Split the runner's inputs from the test paths this PR DELETED. Deleted paths must not reach
 *  the runner (it cannot find them, and the phantom row used to count as sensitivity) but must
 *  still be reported: "we removed a test" is worth a line.
 *  @param {string[]} runnable @param {(f: string) => boolean} existsAtHead */
export function narrowRunnable(runnable, existsAtHead) {
  return {
    runnable: runnable.filter((f) => existsAtHead(f)),
    deletedTests: runnable.filter((f) => !existsAtHead(f)),
  };
}

/** A documentation file: the diff's non-test change may hold these and still be no behaviour
 *  change. Only prose formats; a `.txt` may be a manifest (`requirements.txt`), and `.mdx` holds
 *  code. */
const DOC_RE = /\.(?:md|markdown|rst|adoc)$/;

/**
 * Is the non-test, non-doc part of the diff no behaviour change at all? `'no-source'` when there
 * is none, `'comment-only'` when every source file changed only in comments or whitespace, and
 * null otherwise: one source file `commentOnly` can't prove, or one non-doc file this job doesn't
 * revert (a config, a migration, a manifest), whose change may be the behaviour change.
 * @param {{ src: string[], unreverted: string[], commentOnly: (file: string) => boolean }} input
 * @returns {'no-source' | 'comment-only' | null}
 */
export function noBehaviourChange({ src, unreverted, commentOnly: isCommentOnly }) {
  if (unreverted.some((f) => !DOC_RE.test(f))) return null;
  if (!src.length) return 'no-source';
  return src.every((f) => isCommentOnly(f)) ? 'comment-only' : null;
}

/**
 * Did `file` change between `base` and `head` in comments or whitespace only? Only for a regular
 * file at both ends with the same mode: a file the PR added or deleted, made executable, or turned
 * into a symlink changed whatever its text says.
 * @param {string} file @param {string} base @param {string} head @param {{ run?: Git }} [io]
 */
export function commentOnlyAt(file, base, head, { run = git } = {}) {
  try {
    const entry = (/** @type {string} */ ref) => /^(100644|100755) blob ([0-9a-f]+)\t/.exec(run(['ls-tree', ref, '--', file], { stdio: 'pipe' }));
    const a = entry(base), b = entry(head);
    if (!a || !b || a[1] !== b[1]) return false;
    return commentOnly(file, run(['cat-file', 'blob', a[2] ?? ''], { stdio: 'pipe' }), run(['cat-file', 'blob', b[2] ?? ''], { stdio: 'pipe' }));
  } catch {
    return false;
  }
}

/** The label a person applies to say a PR's tests lock behaviour that is already correct. */
export const CHARACTERIZATION_LABEL = 'test:characterization';

/**
 * Who applied `test:characterization`, as far as the event that started this run can say. `person`
 * only on the `labeled` event for that label, sent by a person; `app` on that event sent by any
 * App, by the label guard's test (`isAgentActor`); `unattributed` on every other event of a PR
 * that carries it, since only the labelling's own event names who applied it; null when the PR
 * doesn't carry it.
 * @param {unknown} event the event payload
 * @returns {{ kind: 'person' | 'app', by: string } | { kind: 'unattributed' } | null}
 */
export function characterization(event) {
  const e = /** @type {{ action?: unknown, label?: { name?: unknown }, sender?: { login?: unknown, type?: unknown }, pull_request?: { labels?: Array<{ name?: unknown }> } } | null} */ (event);
  const labels = Array.isArray(e?.pull_request?.labels) ? e.pull_request.labels : [];
  if (!labels.some((l) => l?.name === CHARACTERIZATION_LABEL)) return null;
  const login = e?.sender?.login;
  if (e?.action !== 'labeled' || e.label?.name !== CHARACTERIZATION_LABEL || typeof login !== 'string' || !login) return { kind: 'unattributed' };
  return { kind: isAgentActor(e.sender) ? 'app' : 'person', by: login };
}

/** The event that started this run, from where Actions writes it, or null outside Actions. */
function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The diff's files, split.
 * @param {string[]} files
 * @param {CodeAreas} [areas] the stack document's `## Code areas`; undeclared by default
 */
export function classify(files, areas = UNDECLARED) {
  const tests = files.filter((f) => isTestSide(f, areas));
  const src = files.filter((f) => !isTestSide(f, areas) && SOURCE_RE.test(f) && !RUNNER_CONFIG_RE.test(f));
  const tier = (/** @type {string} */ f) => tierOf(f, areas);
  const runnable = tests.filter((f) => { const t = tier(f); return t === 'vitest' || t === 'pytest' || t === 'go'; });
  const skipped = tests.filter((f) => !runnable.includes(f));
  // NON-TEST FILES THIS JOB WILL NOT REVERT. A BLOCK says "every changed test passed WITHOUT the
  // change", and that sentence is only true if the change was actually undone. Docs, migrations,
  // JSON fixtures and the runner's own configs are not reverted, so on a MIXED diff the job
  // reverts the source, finds the tests still green because their real sensitivity was to a
  // file it never touched, and would report BLOCKED. Measured in the reference adopter: a PR
  // whose payload was one config entry and its doc, with comment-only source edits beside them,
  // was blocked although its test was sound. Naming these in the verdict is what stops it lying.
  const unreverted = files.filter((f) => !isTestSide(f, areas) && !src.includes(f));
  // TEST-SIDE FILES NO RUNNER COLLECTS, WHICH ARE ALSO NEVER REVERTED. Setup files and shared
  // helpers are test-side, so they are excluded from `src` and, because `unreverted` excludes the
  // test side too, from that inventory as well. No runner collects them, so they are never run
  // either. The result would be a file the PR's author controls that shapes every verdict while
  // appearing in no list the verdict prints: a head-side throw at import in a shared helper makes
  // every changed test fail to LOAD, which scores as `not-collected`, weak, "PASS, weakly".
  //
  // NOT REVERTED, only named, for the runner configuration's reason: reverting the harness the
  // verification runs on breaks the run for a cause unrelated to the claim.
  //
  // BROWSER SUITES AND TESTS WITH NO RUNNER ARE NOT HARNESS. The reverted run never loads either,
  // so one cannot manufacture a `not-collected`. Counting them would also break the narrowness the
  // harness arm depends on: a new module plus its new test is all-`not-collected` BY CONSTRUCTION
  // (reverting deletes the module, so the test cannot import it), and pairing that with a browser
  // spec would have been refused. The three lists are derived from ONE split, so the verdict and
  // the report cannot disagree about which file is which.
  const browserSkipped = skipped.filter((f) => tier(f) === 'browser');
  const noRunner = skipped.filter((f) => tier(f) === 'none');
  const unrevertedTests = skipped.filter((f) => tier(f) === null);
  return { tests, src, runnable, skipped, browserSkipped, noRunner, unreverted, unrevertedTests };
}

// ---------------------------------------------------------------------------
// Verdict
//
// Four outcomes per file, with different evidential weight:
//
//   passed            the test proves nothing.                        BLOCK (exit 1)
//   assertion failure it ran, exercised the change, disagreed.        strong
//   not collected     present in the report but empty: it could not   weak
//                     LOAD against the reverted source. Real evidence
//                     it depends on the change, silent about what it
//                     asserts.
//   no data           absent from the report entirely. NOT evidence    INCONCLUSIVE
//                     in either direction. When it is every file, the
//                     job could not establish anything and fails
//                     closed (exit 1).
//
// THE EXIT-1 VERDICTS say different things: BLOCKED means the claim is false, INCONCLUSIVE means
// the runner produced nothing so it could not be tested (re-run it), UNVERIFIABLE means the diff
// carried a file this job cannot revert, so the evidence was never about it (a person judges the
// claim; re-running is futile). Conflating any of them is how an infrastructure failure gets
// read as proof.
//
// Reported separately because folding them together is how the weak case gets laundered as the
// strong one. Measured in the reference adopter: 52 tests at head and 18 on the reverted tree, so
// 34 never ran while the run still "looked red for the right reason".

/**
 * The job's exit code for a verdict, EXPORTED so the shipped rule is the tested one: inline in
 * the CLI branch no test can reach it, and a revert to a fail-open predicate left every test green.
 *
 * Five states refuse. `blocked`: the claim is false. `inconclusive`: the runner produced nothing.
 * `unverifiable`: files in the diff were never reverted, so no claim about them was tested.
 * `weakOnUnrevertedHarness`: the only evidence is files that failed to LOAD, and an unreverted
 * test helper could have caused that. `refused`: uncommitted work in the revert set (never in
 * CI, where the checkout is clean at a commit). `areasChanged`: the PR changes the code areas it
 * would be judged with (kanon#761). Listed rather than inverted, because a pass is
 * not one condition either; what stops a new refusal forgetting to join the list is that this
 * line is covered by a test.
 * @param {Record<string, unknown> | undefined | null} r
 */
export const exitCodeFor = (r) => (r?.blocked || r?.inconclusive || r?.unverifiable || r?.weakOnUnrevertedHarness || r?.refused || r?.areasChanged ? 1 : 0);

/**
 * @param {{ expected: string[], results: Array<Partial<FileResult> & { file: string }>, ran?: boolean, unreverted?: string[], unrevertedTests?: string[] }} input
 */
export function verdict({ expected, results, ran = true, unreverted = [], unrevertedTests = [] }) {
  const byFile = expected.map((file) => {
    const r = results.find((x) => x.file === file || x.file.endsWith(`/${file}`));
    // ABSENT from the report is NO DATA, never evidence. Counting it as weak evidence made the
    // guard fail OPEN in two reachable ways: a renamed test leaves a deleted path in the diff,
    // the runner cannot find it, and that one phantom row unblocked a PR whose only real new
    // test was vacuous; and a runner that produced nothing (no database, a config error) scored
    // EVERY file weak and printed "PASS, weakly".
    if (!r) return { file, outcome: 'no-data' };
    if ((r.failed ?? 0) > 0) return { file, outcome: 'assertion-failure' };
    // Present but empty: a runner reports a file that could not LOAD as failed with zero
    // assertions. Counting only failed assertions read that as a pass and blocked: the exact
    // strong/weak distinction this job exists to draw, inverted. Found by running the check on
    // its own diff, where reverting the script made its test unloadable.
    if (r.status === 'failed' && (r.passed ?? 0) === 0) return { file, outcome: 'not-collected' };
    return { file, outcome: 'passed' };
  });
  const strong = byFile.filter((f) => f.outcome === 'assertion-failure').length;
  const sensitive = byFile.filter((f) => f.outcome === 'assertion-failure' || f.outcome === 'not-collected');
  const noData = byFile.filter((f) => f.outcome === 'no-data');

  // INCONCLUSIVE is a verdict of its own, not a pass and not a block. A failing global setup
  // writes a report with zero entries, byte-identical to an unavailable test database. The two
  // cannot be told apart from the report, so calling it weak evidence would launder an
  // infrastructure failure into proof. Fail CLOSED on ambiguity, and a person resolves it.
  const inconclusive = !ran || (noData.length === byFile.length && byFile.length > 0);

  return {
    byFile,
    strong,
    weak: sensitive.length - strong,
    passed: byFile.filter((f) => f.outcome === 'passed').length,
    noData: noData.length,
    inconclusive,
    unreverted,
    // At least one changed test must detect the revert. Requiring ALL of them would block a PR
    // that also tidies an unrelated test file: common, and not what this guards against.
    //
    // AND NOTHING THE JOB COULD NOT REVERT. "Every changed test passed without the change" is
    // only a claim about the change if the change was undone. With an unreverted file in the
    // diff it was not, so a BLOCK there is an assertion the evidence does not support.
    blocked: !inconclusive && sensitive.length === 0 && unreverted.length === 0,
    // FAILS CLOSED. Naming a limitation is only survivable if the job still refuses: an arm that
    // printed its limitation and exited 0 would make one `docs/` line a complete bypass of the
    // check, reached without editing the script at all.
    unverifiable: !inconclusive && sensitive.length === 0 && unreverted.length > 0,
    unrevertedTests,
    // A WEAK PASS THAT AN UNREVERTED TEST HELPER COULD HAVE MANUFACTURED IS NOT A PASS. Then the
    // `not-collected` is manufactured, and the job would report "PASS, weakly", exit 0.
    //
    // DELIBERATELY NARROW, because the innocent case must stay green: a PR that changes a helper
    // alongside its test, where the test really is sensitive to the source, produces at least one
    // assertion failure and never reaches this arm. It fires only when NOTHING failed an
    // assertion, which the reviewer already sends to a person; this makes that referral
    // mechanical and says why. Reported as UNVERIFIABLE: the sentence is the same one, a file in
    // the diff was not reverted, so the evidence is not about the change.
    weakOnUnrevertedHarness: !inconclusive && sensitive.length > 0 && strong === 0 && unrevertedTests.length > 0,
  };
}

// ---------------------------------------------------------------------------

/**
 * Make `paths` match `ref` exactly, in the index and the working tree: a file absent at `ref` is
 * removed rather than left behind.
 *
 * This is the revert AND the restore: reverting is materialising at the merge base, restoring is
 * materialising at `head`. One function both ways means the restore cannot drift from the
 * revert's file-state handling, which is the half that is easy to get wrong: added, modified and
 * deleted each need a different action, and only two of them are a `checkout`.
 * @param {string[]} paths @param {string} ref @param {{ run?: Git }} [io]
 */
export function materialise(paths, ref, { run = git } = {}) {
  for (const f of paths) {
    try {
      run(['cat-file', '-e', `${ref}:${f}`], { stdio: 'pipe' });
      run(['checkout', ref, '--', f]);
    } catch {
      // Absent at `ref`: matching it means the file should not exist.
      if (existsSync(f)) run(['rm', '-q', '-f', f]);
    }
  }
}

/**
 * Run `body` against `paths` materialised at `ref`, and put them back at `restoreRef` on every
 * path out: return, throw, anything. EXPORTED because a `try`/`finally` inside `main()` is
 * reachable by no test, so the restore could be deleted with the whole suite green, which is how
 * a missing restore once survived and deleted a file the PR added from a developer's tree.
 * @template T
 * @param {{ paths: string[], ref: string, restoreRef: string, body: () => T, materialise?: (paths: string[], ref: string) => void }} input
 * @returns {T}
 */
export function withMaterialised({ paths, ref, restoreRef, body, materialise: m = materialise }) {
  try {
    m(paths, ref);
    return body();
  } finally {
    m(paths, restoreRef);
  }
}

/**
 * Paths with uncommitted work, so the job can refuse instead of overwriting it. `materialise`
 * writes through the index, so no restore preserves a staged or unstaged edit to a file being
 * reverted. Refusing is the honest answer. In CI this is always empty: the checkout is clean.
 * @param {string[]} paths @param {{ run?: Git }} [io]
 */
export function dirtyPaths(paths, { run = git } = {}) {
  if (!paths.length) return [];
  const out = run(['status', '--porcelain', '--', ...paths], { stdio: 'pipe' });
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
}

/**
 * One file's result from its runner's report, in the shape `verdict` reads, or null when the
 * report holds nothing for it. A file that could not LOAD is `failed` with no assertion passed or
 * failed, in every runner: Vitest reports it as a failed file with no assertions, pytest as a
 * test case with an `<error>` (a collection error), and `go test` as a package that failed with
 * no test result (it did not compile).
 * @param {'vitest' | 'pytest' | 'go'} runner
 * @param {unknown} report the parsed JSON for Vitest, the raw text for pytest and `go test -json`
 * @param {string} file
 * @returns {FileResult | null}
 */
export function readResult(runner, report, file) {
  if (runner === 'vitest') {
    const all = /** @type {{ testResults?: Array<{ name?: unknown, status?: string, assertionResults?: Array<{ status?: string }> }> }} */ (report ?? {}).testResults ?? [];
    const mine = all.filter((t) => typeof t?.name === 'string' && (t.name === file || t.name.endsWith(`/${file}`)));
    if (!mine.length) return null;
    const asserts = mine.flatMap((t) => t.assertionResults ?? []);
    return {
      file,
      status: mine.some((t) => t.status === 'failed') ? 'failed' : 'passed',
      failed: asserts.filter((a) => a.status === 'failed').length,
      passed: asserts.filter((a) => a.status === 'passed').length,
    };
  }
  if (typeof report !== 'string') return null;
  if (runner === 'pytest') {
    let failed = 0, errored = 0, passed = 0;
    for (const m of report.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const body = m[1] ?? '';
      if (/<failure\b/.test(body)) failed++;
      else if (/<error\b/.test(body)) errored++;
      else if (!/<skipped\b/.test(body)) passed++;
    }
    if (!failed && !errored && !passed) return null;
    return { file, status: failed || errored ? 'failed' : 'passed', failed, passed };
  }
  let failed = 0, passed = 0;
  for (const line of report.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || typeof e.Test !== 'string' || e.Test.includes('/')) continue;
    if (e.Action === 'pass') passed++;
    else if (e.Action === 'fail') failed++;
  }
  if (failed || passed) return { file, status: failed ? 'failed' : 'passed', failed, passed };
  // No test result: a package that did not build is a file that could not load; silence is none.
  return interpretGoJson(report) === false ? { file, status: 'failed', failed: 0, passed: 0 } : null;
}

/**
 * Run each runnable file with its runner, ONE FILE AT A TIME, through the table's command, and
 * read its report back. `ran` is false when any run wrote no report at all, which is not the same
 * as "ran and found nothing" and must not be scored as evidence: deliberately whole-job, so a run
 * known to be broken never supplies a pass, even when another file gave a clean failure.
 * @param {string[]} files
 * @param {{ trees: import('./lib/test-conventions.mjs').TestTree[], areas?: CodeAreas, exec?: (bin: string, args: string[], opts: import('node:child_process').ExecFileSyncOptions) => unknown, read?: (f: string) => string, outDir?: string }} opts
 * @returns {{ results: FileResult[], ran: boolean }}
 */
export function runFiles(files, { trees, exec = (bin, args, opts) => execFileSync(bin, args, opts), read = (f) => readFileSync(f, 'utf8'), outDir }) {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'red-test-'));
  /** @type {FileResult[]} */
  const results = [];
  let ran = true;
  try {
    files.forEach((file, n) => {
      const runner = /** @type {'vitest' | 'pytest' | 'go'} */ (runnerFor(file, trees));
      const out = join(dir, `run-${n}.${runner === 'pytest' ? 'xml' : 'json'}`);
      let cmd;
      try { cmd = RUNNERS[runner](file, out, () => read(file)); } catch { cmd = null; }
      // Nothing to run (a Go file that declares no test function): no data for this file.
      if (!cmd) return;
      const env = cmd.env ? { ...process.env, ...cmd.env } : process.env;
      let stdout = '';
      try {
        // 32 MB, as `git()`: the default 1 MB kills the child mid-run on a verbose failure.
        stdout = String(exec(cmd.bin, cmd.args, { env, stdio: cmd.report === 'stdout' ? ['ignore', 'pipe', 'ignore'] : 'ignore', encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 }) ?? '');
      } catch (e) {
        // A non-zero exit is the expected case here: the tests are supposed to fail.
        stdout = String(/** @type {{ stdout?: unknown }} */ (e)?.stdout ?? '');
      }
      if (cmd.report === 'stdout' && stdout) writeFileSync(out, stdout);
      let raw;
      try { raw = readFileSync(out, 'utf8'); } catch { ran = false; return; }
      let report = raw;
      if (runner === 'vitest') {
        try { report = JSON.parse(raw); } catch { ran = false; return; }
      }
      const r = readResult(runner, report, file);
      if (r) results.push(r);
    });
  } finally {
    if (!outDir) rmSync(dir, { recursive: true, force: true });
  }
  return { results, ran };
}

/** The PR's OWN changed files, and the ref a revert must restore from.
 *
 *  THE MERGE BASE, NOT THE BASE BRANCH TIP. The workflow passes `pull_request.base.sha`, the
 *  default branch's tip at event time, so on any branch that has not just been rebased a two-dot
 *  diff returns every commit the default branch gained since the branch point as though the PR
 *  had made it. Measured in the reference adopter: twice the PR's files, one of them a runnable
 *  test whose own source was reverted alongside it, so it failed by construction and supplied the
 *  evidence that cleared a PR whose own new test was vacuous. The same stale churn (a changelog,
 *  a lockfile) also relabels a genuine BLOCK as UNVERIFIABLE, pointing at the wrong repair.
 *
 *  THE REVERT REF MOVES WITH IT: restoring from the base tip would make a file the default branch
 *  also changed look like the default branch rather than like the tree before this PR. "Undo the
 *  PR's changes" is the merge base by definition.
 *
 *  FAILS CLOSED. A shallow checkout cannot compute a merge base, and silently falling back to
 *  `base` would restore exactly the behaviour this replaces. The workflow sets `fetch-depth: 0`.
 *  @param {string} base @param {string} head @param {{ run?: Git }} [io]
 */
export function changedFiles(base, head, { run = git } = {}) {
  let diffBase;
  try {
    diffBase = run(['merge-base', base, head]).trim();
  } catch {
    throw new Error(
      `could not compute the merge base of ${base} and ${head}, refusing to fall back to a `
      + 'two-dot diff, which would revert and run commits this PR never made. '
      + 'The checkout needs full history (`fetch-depth: 0`).');
  }
  if (!diffBase) {
    throw new Error(`empty merge base for ${base}...${head}, refusing to guess.`);
  }
  return { diffBase, files: run(['diff', '--name-only', diffBase, head]).split('\n').filter(Boolean) };
}

// ---------------------------------------------------------------------------
// The code areas it judges with (kanon#761)

/**
 * The stack document's `## Code areas` at a git ref, read from the object store, never from the
 * working tree. A ref that doesn't resolve throws: the check refuses rather than fall back to
 * the checkout, which is the PR's. A ref with no stack document declares nothing, as
 * `readCodeAreas` reads a tree without one; a malformed declaration throws.
 * @param {string} ref @param {{ run?: Git }} [io]
 * @returns {CodeAreas}
 */
export function areasAt(ref, { run = git } = {}) {
  try {
    run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'pipe' });
  } catch {
    throw new Error(`can't read \`${ref}\`, the ref the code areas are taken from, and the check never takes them from the pull request. The checkout needs full history (\`fetch-depth: 0\`).`);
  }
  try {
    run(['cat-file', '-e', `${ref}:${STACK_FILE}`], { stdio: 'pipe' });
  } catch {
    return UNDECLARED;
  }
  return parseCodeAreas(run(['cat-file', 'blob', `${ref}:${STACK_FILE}`], { stdio: 'pipe' }));
}

/** The part of a declaration this check reads, as one comparable string: each `tests` tree and
 *  its runner. @param {CodeAreas} areas */
const judgedKey = (areas) => areas.tests.map((t) => `\`${t.path}\`${t.runner ? ` \`${t.runner}\`` : ''}`).sort().join(', ');

/**
 * The code areas a run judges with, and whether the PR changes them.
 *
 * `areas` is always the trusted ref's, and a failure to read it throws (fail closed). `changed`
 * is null when the head's `tests` trees match the trusted ref's, or the merge base's (the PR
 * didn't touch them, the default branch moved). Otherwise it says what the head declares, or
 * why it can't be read.
 * @param {{ trustedRef: string, head: string, diffBase: string, read?: (ref: string) => CodeAreas }} input
 * @returns {{ areas: CodeAreas, changed: null | { trusted: string, head: string } | { malformed: string } }}
 */
export function judgingAreas({ trustedRef, head, diffBase, read = (ref) => areasAt(ref) }) {
  const areas = read(trustedRef);
  let headKey;
  try {
    headKey = judgedKey(read(head));
  } catch (e) {
    return { areas, changed: { malformed: /** @type {Error} */ (e).message } };
  }
  if (headKey === judgedKey(areas)) return { areas, changed: null };
  let baseKey = null;
  try { baseKey = judgedKey(read(diffBase)); } catch { /* unreadable at the merge base: the head's can't be shown unchanged */ }
  return { areas, changed: headKey === baseKey ? null : { trusted: judgedKey(areas) || 'none', head: headKey || 'none' } };
}

/**
 * The areas a `--plan` run wrote as JSON, for the verifying job. Shape-checked, and any fault
 * throws: a missing or garbled hand-over must not become "no tests tree declared".
 * @param {string} text
 * @returns {CodeAreas}
 */
export function areasFromJson(text) {
  /** @type {any} */
  let v;
  try { v = JSON.parse(text); } catch { v = null; }
  const list = (/** @type {unknown} */ x) => Array.isArray(x) && x.every((a) => a && typeof a.path === 'string' && typeof a.what === 'string' && (a.runner === undefined || typeof a.runner === 'string'));
  if (!v || typeof v !== 'object' || typeof v.declared !== 'boolean' || !list(v.code) || !list(v.tests) || !list(v.audit)) {
    throw new Error('--areas-json is not the code areas a `--plan` run wrote, so the check refuses rather than judge with none');
  }
  return { declared: v.declared, code: v.code, tests: v.tests, audit: v.audit };
}

/**
 * Where this run's areas come from: `--areas-json` (the verifying job) or `--areas-ref` (the
 * scope job, or a person's own run). Never the working tree, so one of the two is required.
 * @param {string} diffBase @param {string} head
 */
function areasForRun(diffBase, head) {
  const json = arg('areas-json');
  const ref = arg('areas-ref');
  if (json !== null && ref !== null) throw new Error('give --areas-ref or --areas-json, not both');
  if (json !== null) return { areas: areasFromJson(json), changed: null, ref: null };
  if (ref) return { ...judgingAreas({ trustedRef: ref, head, diffBase }), ref };
  throw new Error(`--areas-ref <ref> is required: the ref ${STACK_FILE}'s \`## Code areas\` is read from, the default branch in CI. The check never reads them from the pull request's checkout (kanon#761).`);
}

/** @returns {{ result: Record<string, unknown>, areas: CodeAreas }} */
function main() {
  const base = arg('base');
  const head = arg('head', 'HEAD') ?? 'HEAD';
  if (!base) throw new Error('--base <sha> is required');

  const { diffBase, files } = changedFiles(base, head);
  const { areas, changed, ref: areasRef } = areasForRun(diffBase, head);
  const say = (/** @type {string} */ line) => { console.log(line); };
  // `--plan` runs in the `Red-test scope` job and reaches no verdict, so it must not print a
  // verification heading that then ends without one.
  say(PLAN ? '## Red-test scope\n' : '## Red-test verification\n');
  if (changed) {
    const what = 'malformed' in changed
      ? `This pull request's ${STACK_FILE} can't be read: ${changed.malformed}`
      : `This pull request declares the \`tests\` trees ${changed.head}, and \`${areasRef}\` declares ${changed.trusted}`;
    say(`**Refused: this pull request changes the code areas the check judges with.** ${what}. The check reads \`## Code areas\` from the default branch, never from the pull request, so a pull request can't decide which of its own files are tests or how they run, and judging this one by the default branch's areas would skip tests its new declaration makes runnable. So it refuses rather than skip. A person reviews and merges a pull request that changes the code areas (K-MERGE-4, K-MERGE-13, K-MERGE-17).`);
    return { result: { areasChanged: true }, areas };
  }
  return { result: verifyWith(areas, { base, head, diffBase, files, say }), areas };
}

/**
 * @param {CodeAreas} areas
 * @param {{ base: string, head: string, diffBase: string, files: string[], say: (line: string) => void }} run
 * @returns {Record<string, unknown>}
 */
function verifyWith(areas, { base, head, diffBase, files, say }) {
  const existsAtHead = (/** @type {string} */ f) => {
    try { git(['cat-file', '-e', `${head}:${f}`], { stdio: 'pipe' }); return true; } catch { return false; }
  };
  const c = classify(files, areas);
  const { tests, src, unreverted, unrevertedTests } = c;
  // Narrow ONLY what is handed to the runner. Applied to the whole diff, it stripped DELETED
  // source files out of the revert set, so the reverted tree was no longer the base tree: a
  // delete-only source diff reported "no source file changed" and exited 0, and a
  // delete-a-helper/update-its-caller diff left the caller importing a file that stayed deleted,
  // which reads as `not-collected`, "PASS, weakly". `materialise` restores a deleted source file
  // from the base correctly; it just has to still be told about it.
  const { runnable, deletedTests } = narrowRunnable(c.runnable, existsAtHead);

  for (const d of codeAreasDefaults(areas)) say(`${d}\n`);
  say(`Diff \`${diffBase.slice(0, 7)}..${head.slice(0, 7)}\` (merge base of \`${base.slice(0, 7)}\`): ${src.length} source file(s), ${tests.length} test file(s).\n`);

  // No silent caps: say what was not run and why, every time.
  if (c.browserSkipped.length) say(`**Not run**: a browser suite needs a built app and is out of this job's scope: ${c.browserSkipped.join(', ')}\n`);
  if (c.noRunner.length) say(`**Not run**: no \`tests\` tree in docs/qa/stack.md names a runner for these, and Kanon never picks one (K-LAYOUT-17): ${c.noRunner.join(', ')}\n`);
  // NAMED AS UN-REVERTED, not merely as un-run. These shape the verdict (setup files and shared
  // helpers decide whether the changed tests LOAD at all), and "not collected" alone reads as
  // irrelevant rather than as unexamined.
  if (unrevertedTests.length) say(`**Not run, and NOT reverted**: no runner collects these, but the reverted run still loads them (helpers, setup, fixtures): ${unrevertedTests.join(', ')}\n`);
  if (deletedTests.length) say(`**Removed by this PR** (not run, nothing to verify): ${deletedTests.join(', ')}\n`);
  if (!runnable.length) {
    say('**Skipped:** no runnable test file changed, so there is no "confirmed it fails" claim to verify. The check concludes SKIPPED, not green.');
    return { skipped: true };
  }
  // NO BEHAVIOUR CHANGE TO REVERT, read from the diff. Before the no-source skip, which says
  // less, and before UNVERIFIABLE, which would blame a doc for what is really the absence of a
  // fix: reverting the doc as well would still leave every test green.
  const unchanged = noBehaviourChange({ src, unreverted, commentOnly: (f) => commentOnlyAt(f, diffBase, head) });
  if (unchanged) {
    const what = unchanged === 'no-source'
      ? `No non-test file changed${unreverted.length ? ' but documentation' : ''}`
      : `Every change to ${src.map((f) => `\`${f}\``).join(', ')} is to comments or whitespace${unreverted.length ? ', and the rest is documentation' : ''}`;
    say(`**Skipped: no behaviour change to revert.** ${what}, so the changed tests lock behaviour that was already there: they are characterization tests, which cannot fail on a revert by construction. The check concludes SKIPPED, not green: nothing was verified, and the tests' sensitivity must come from the mutations their pull request states (K-MERGE-13, K-PRIN-11).`);
    return { skipped: true, noBehaviourChange: unchanged };
  }
  if (!src.length) {
    say('**Skipped:** no source file changed, so there is nothing to revert. The check concludes SKIPPED, not green: nothing was verified.');
    return { skipped: true };
  }

  if (PLAN) {
    // A PERSON'S LABEL, read here only. The scope job runs nothing from the PR before this
    // script; the verify job has run the project-setup hook, which could rewrite the event file.
    const label = characterization(readEvent());
    if (label?.kind === 'person') {
      say(`**Skipped: a person applied \`${CHARACTERIZATION_LABEL}\`** (@${label.by}), saying the changed tests lock behaviour that was already correct, so there is no fix to revert. The check concludes SKIPPED, not green: nothing was verified, and the tests' sensitivity must come from the mutations their pull request states (K-MERGE-13, K-PRIN-11).`);
      return { skipped: true, characterization: label.by };
    }
    if (label?.kind === 'app') say(`**\`${CHARACTERIZATION_LABEL}\` was applied by an App (@${label.by}), and an App cannot waive this check (K-MERGE-13): ignored.** Only a person's label makes it skip.\n`);
    if (label?.kind === 'unattributed') say(`**\`${CHARACTERIZATION_LABEL}\` is on this PR, but not honoured on this run:** only the run that applying it starts can tell whether a person applied it. To have it honoured on this head, a person removes it and applies it again.\n`);
    return { plan: true };
  }

  if (DRY) {
    say(`Would revert (from merge base ${diffBase.slice(0, 7)}): ${src.join(', ')}`);
    say(`Would run: ${runnable.join(', ')}`);
    return { dryRun: true };
  }

  // REFUSE RATHER THAN OVERWRITE. Unreachable in CI, where the checkout is clean at a commit, so
  // it costs the check nothing and makes the script safe to run against a developer's own tree.
  const dirty = dirtyPaths(src);
  if (dirty.length) {
    say(`**Refused: ${dirty.length} file(s) in the revert set have uncommitted changes:** ${dirty.map((f) => `\`${f}\``).join(', ')}`);
    say('');
    say('This job reverts those paths through the git index, and no restore preserves work that was never committed. Commit it or set it aside, then re-run. This cannot fire in CI, where the checkout is clean at a commit.');
    return { refused: true };
  }

  const { results, ran } = withMaterialised({
    paths: src,
    ref: diffBase,
    restoreRef: head,
    body: () => runFiles(runnable, { trees: areas.tests }),
  });

  const v = verdict({ expected: runnable, results, ran, unreverted, unrevertedTests });

  say('| Changed test file | Against reverted source |');
  say('|---|---|');
  /** @type {Record<string, string>} */
  const label = {
    'assertion-failure': '🔴 failed an assertion: **strong**',
    'not-collected': '🟠 did not collect: *weak*',
    'no-data': '⚪ no data: the runner reported nothing for this file',
    passed: '🟢 still passed',
  };
  for (const f of v.byFile) say(`| \`${f.file}\` | ${label[f.outcome]} |`);
  say('');

  if (v.inconclusive) {
    say('**INCONCLUSIVE: the runner produced no result for these tests, so nothing was established.**');
    say('');
    say('This is deliberately neither a pass nor a block. A report with no entries is what a failing global setup looks like *and* what an unavailable test database looks like, and the two cannot be told apart from the report. Scoring it as evidence would launder an infrastructure failure into proof, so the job fails closed and a person resolves it.');
  } else if (v.unverifiable) {
    // Would have been a BLOCK, and the evidence does not support one: files in this diff were
    // never reverted. UNVERIFIABLE, not INCONCLUSIVE: this is deterministic on the diff's file
    // set, so re-running produces the identical result forever.
    say(`**UNVERIFIABLE: ${v.unreverted.length} changed file(s) were not reverted, so a block would not be about them.**`);
    say('');
    say(`This job reverts every source file the PR changed: a file in a language Kanon's test conventions read, or a shell script, other than a test runner's configuration. These changed and were left in place: ${v.unreverted.map((f) => `\`${f}\``).join(', ')}. Every changed test passed against the reverted set, but if their sensitivity is to one of those files, that proves nothing either way, so this is not a block. Reverting them is out of scope on purpose: a runner configuration or a migration cannot be undone without breaking the run for a reason unrelated to the claim.`);
  } else if (v.blocked) {
    const detail = v.noData > 0
      ? `${v.passed} changed test(s) passed without the source change and ${v.noData} produced no data: nothing here proves anything`
      : 'every changed test passed without the source change, so none of them proves anything';
    say(`**BLOCKED: ${detail}.**`);
    say('');
    say('This is the check that the implement lane\'s "confirm it fails" step (K-AGENT-15) asserts and cannot demonstrate. If the change genuinely is not test-observable, say so on the PR and a person decides: it is not waivable by the author (K-MERGE-13).');
  } else if (v.weakOnUnrevertedHarness) {
    say(`**UNVERIFIABLE: the only evidence is files that failed to load, and ${v.unrevertedTests.length} unreverted test harness file(s) could have caused that.**`);
    say('');
    say(`Not one changed test failed an assertion; the whole result is \`not-collected\`, which normally reads as real evidence the tests depend on the reverted source. It does not read that way here, because this job does not revert ${v.unrevertedTests.map((f) => `\`${f}\``).join(', ')}: no runner collects them, so the reverted run loads the head's copy. A throw at import there produces exactly this shape, and the evidence would be about the harness rather than about the change.`);
    say('');
    say('Reverting them is out of scope on purpose, for the runner configuration\'s reason: the harness the verification runs on cannot be undone without breaking the run for a cause unrelated to the claim. A person judges the claim. A single 🔴 anywhere clears this: it only fires when nothing asserted.');
  } else if (v.strong === 0) {
    say(`**PASS, weakly.** ${v.weak} file(s) failed to collect against the reverted source and none failed an assertion.`);
    say('');
    say('That is real evidence the tests depend on the change, but it is silent about *what* they assert: the reverted tree could not load them. Worth a reviewer\'s eye.');
  } else {
    say(`**PASS.** ${v.strong} file(s) failed an assertion against the reverted source.`);
  }
  return v;
}

if (isCliEntry(import.meta.url)) {
  // The test trees and their runners decide which files are tests and how they run (ADR 0012): a
  // malformed declaration at the trusted ref, or a ref that can't be read, ends the run with one
  // line naming it, before any test runs.
  let out;
  try {
    out = main();
  } catch (e) {
    console.error(`red-test: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
  const { result: r, areas } = out;
  if (PLAN) {
    const [line, ...rest] = planOutputs(r, areas);
    console.log(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, [line, ...rest].map((l) => `${l}\n`).join(''));
    // THE PLAN EXITS 0 ON EVERY RESULT IT REACHES, a refusal included. A failed `scope` job makes
    // `Red-test verification` fail with the generic "Red-test scope failed" (kanon#1189). A refusal
    // is carried to the verifying job instead (`areas_changed`), which fails with its own message.
    process.exit(0);
  }
  process.exit(exitCodeFor(r));
}
