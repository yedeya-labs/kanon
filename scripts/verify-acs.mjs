#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-1068 — resolve one project's acceptance criteria to executable evidence.
//
// Phase 5 (RA-1063) asks "did this project do what its brief said". The brief's
// acceptance criteria ARE `[XXX-n]` invariants (agentic-lead-engineer.md §6), so
// the question reduces to: for each cited ID, is there a test that names it, and
// does that test pass at the deployed tag?
//
// AND SINCE RA-1742 THAT IS THE ONLY PLACE THEY LIVE. A brief cites an id; it never
// restates the criterion beside it. So this file reads acceptance criteria from spec
// ids ALONE, which it always did — what changed is that the prose criterion it used to
// step over silently is now refused at lint time by `brief-guard.mjs`, through
// `isAcDeclaration` below. That closes the one asymmetry in the design: an unrecognised
// criterion could never make a project fail, only vanish, so a brief committing to four
// deliverables in prose reported four criteria fewer and nobody saw a gap.
//
// THE RULE THIS FILE EXISTS TO ENFORCE. An AC with no citing test is
// `unverifiable`, NEVER `passed`. Folding "no evidence" into "verified" would make
// phase 5 a rubber stamp reporting green on a project where nothing was checked —
// silent-absence (§12.7) on the artifact that CLOSES the project.
//
// That is not a hypothetical: measured on the pilot the day this was written, all
// seven of RA-961's ACs were `[seed]` with zero citing tests.
//
//   | Area | Invariants | Locked | Confirmed, untested |
//   | PAY  | 7          | 0      | 0                   |
//
// Which is the sequence working, not a fault — Issue B's own criteria say "its test
// is RA-897's exact scenario", so the tests are written DURING implementation and
// become this phase's evidence. But it means a project verified on the day it was
// filed would report seven unverifiable ACs, and that must read as "nothing was
// checked", not as a pass.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseProposed } from './project-closure.mjs';
import { citations } from './spec-coverage.mjs';
import { parseSpec, specFiles } from './spec-lib.mjs';
import { RUNNERS, interpretGoJson, interpretJunit, runnerFor } from './lib/test-conventions.mjs';

/**
 * The acceptance-criteria IDs a brief's issues COMMIT TO.
 *
 * LEADING DECLARATION, not any occurrence. An acceptance criterion is an ID at the
 * head of its own bullet — `- \`[PAY-1]\` — a required from-set at every call site`
 * — because that is the form the brief uses to take one on. An ID anywhere else in
 * the body is the issue ARGUING, and arguing is not committing.
 *
 * Scanning the whole body over-captured badly. Against the pilot it reported 13
 * criteria where the brief's own falsifiability table commits to seven:
 *
 *   PAY-3    @ A   "(that is the whole point of `[PAY-3]`)"      a parenthetical
 *   PAY-2    @ A   "`open` is the state `[PAY-2]` calls live…"   an italic aside
 *   ESCAPE-5 @ C   "The model is `[ESCAPE-5]` — lint-enforced"   an ANALOGY
 *   FILTER-2 @ D   "`[FILTER-2]` is explicit that filtering…"    a justification
 *
 * Issue A is the unambiguous case: its own section says "Not in this issue: writing
 * tests. Every `[PAY-n]` clause is locked by a test in issue B or C." It commits to
 * none of them, and the whole-body scan gave it two.
 *
 * Over-capture cannot produce a false PASS — it only adds `unverifiable` rows — so
 * the central guarantee was never at risk. It matters because the second half of
 * RA-1068 files findings against these IDs: attributing a criterion a project never
 * took on sends an implementer after nothing, which is the thing the
 * `not-an-invariant` verdict exists to prevent, arriving through another door.
 *
 * The repo already draws this line one layer up: `spec-lib.mjs`'s `DECL` matches a
 * declaration only at the head of a bullet, for the same reason.
 *
 * @param {string} markdown the brief
 */
// Leading emphasis and ordered-list markers count. The pilot brief already
// contains one — `docs/projects/961.md:474`, inside Issue C:
//
//   - **`[PAY-3]` is pinned here (decision 4), and this is new scope for this issue.**
//
// That is an issue explicitly TAKING A CRITERION ON, and the un-emphasised regex
// dropped it: PAY-3 was attributed to B alone and C's own declaration vanished.
// Measured across docs/projects/**, bullet-leading forms are 7x "- `[ID]`" and
// 1x "- **`[ID]`" — a 1-in-8 miss on the only corpus this tool has.
// `+` is a markdown bullet like `-` and `*`, and it is here so that this regex and
// `brief-guard.mjs`'s `acBullets` recognise the SAME set of bullets (RA-1744 review).
// Where they disagreed, a `+ \`[AREA-1]\` — …` criterion was a declaration to one and
// prose to the other: lint would have called a real commitment a restatement, which is
// the failure message being wrong about the thing it is refusing.
const AC_DECL = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__|\*|_)?`\[([A-Z]+)-(\d+)\]`/gm;

/**
 * The same form, asked of ONE bullet — exported so `brief-guard.mjs` can refuse a
 * criterion written as prose at lint time (RA-1742).
 *
 * ONE DEFINITION, TWO CONSUMERS. Since acceptance criteria now live only in the spec
 * layer and a brief cites them, the shape lint demands and the shape this file counts as
 * a commitment have to be the same shape — a guard accepting a form phase 5 then reads
 * as nothing is how a project reports "no criteria" over an issue that stated four.
 *
 * A fresh `RegExp` per call rather than `AC_DECL.test`: `AC_DECL` is global, and `.test`
 * on a global regex advances `lastIndex`, so alternate calls would return false.
 */
export const isAcDeclaration = (line) => new RegExp(AC_DECL.source).test(line);

/** Every backticked ID anywhere in a body, leading or not. */
const ANY_ID = /`\[([A-Z]+)-(\d+)\]`/g;

export function acsFromBrief(markdown) {
  const proposed = parseProposed(markdown);
  const out = [];
  for (const p of proposed) {
    const body = p.body ?? '';
    const declared = new Set([...body.matchAll(AC_DECL)].map((m) => `${m[1]}-${m[2]}`));
    for (const id of declared) out.push({ id, issue: p.key ?? '?', title: p.title, declared: true });

    // MENTIONED BUT NOT DECLARED, reported rather than dropped. The two errors are
    // not symmetric: over-capture adds an `unverifiable` row, which BLOCKS the
    // verdict and is therefore loud, while a missed declaration is invisible and
    // cannot block anything — so a criterion nobody checked can report VERIFIED.
    // That asymmetry is why this exists: a form the regex does not yet know about
    // becomes visible instead of silently vanishing.
    // Deduped, as declarations are. An ID argued about five times in one issue is
    // one mention, and five identical rows would drown the table this exists to
    // make readable.
    const mentioned = new Set(
      [...body.matchAll(ANY_ID)].map((m) => `${m[1]}-${m[2]}`).filter((id) => !declared.has(id)),
    );
    for (const id of mentioned) out.push({ id, issue: p.key ?? '?', title: p.title, declared: false });
  }
  return out;
}

/**
 * The resolution verdict per ID — one of four, never two and never a default.
 * `applyRuns` later turns `has-test` into `passed`, `failed` or `not-run`, so the
 * full set a consumer can see is six. (Said plainly because the docstring claimed
 * "exactly three" through three review rounds while the count grew underneath it.)
 *
 *   mentioned         cited, but not as a leading declaration — not a commitment
 *   not-an-invariant  no spec declares the ID: a typo or a deleted invariant
 *   unverifiable      declared, and no test cites it
 *   has-test          declared, with citing tests — until `applyRuns` runs them
 *
 * `not-an-invariant` is its own answer rather than a failure: §6.2 is explicit that
 * not every AC maps to an invariant and that forcing it is a mistake. An ID cited
 * by a brief that no spec declares is a typo or a deleted invariant, and calling
 * that a FAILURE would blame the project for a bookkeeping error.
 *
 * @param {{id: string, issue?: string, title?: string, declared?: boolean}[]} acs
 *   `declared: false` marks a mention. An omitted `declared` is treated as a
 *   declaration — the fail-safe direction, since a real criterion judged is better
 *   than one skipped, and `verify-acs.test.ts` relies on it.
 * @param {Map<string, Set<string>>} cited  ID -> citing test files
 * @param {Set<string>} known  every ID a spec actually declares
 */
export function verdicts(acs, cited, known) {
  return acs.map((ac) => {
    // A mention is not a commitment, so it is neither verified nor held against
    // the project. It is surfaced so an unrecognised DECLARATION form cannot hide
    // inside it.
    if (ac.declared === false) return { ...ac, status: 'mentioned', tests: [] };
    if (!known.has(ac.id)) return { ...ac, status: 'not-an-invariant', tests: [] };
    const tests = [...(cited.get(ac.id) ?? [])].sort();
    return tests.length
      ? { ...ac, status: 'has-test', tests }
      : { ...ac, status: 'unverifiable', tests: [] };
  });
}


/**
 * Which runner owns a test file, by the per-language table (`scripts/lib/test-conventions.mjs`,
 * kanon#20): `tests/**` JavaScript is Vitest, `e2e/**` is Playwright, a pytest file is pytest,
 * a `_test.go` file is `go test`, and anything else is NEITHER — reported as such rather than
 * guessed at, because a file this tool cannot run is evidence it cannot read, and saying
 * "passed" about it would be the same rubber stamp `unverifiable` exists to prevent.
 */
export { runnerFor };

/**
 * Fold execution results into the resolved criteria.
 *
 * FOUR outcomes now, and the two new ones are both failures to KNOW rather than
 * failures of the project:
 *
 *   passed        every citing test ran and passed
 *   failed        a citing test ran and failed
 *   not-run       the tool could not run them (an unknown runner, a run that reported
 *                 no test result — no database, a timeout, a crash — or --run absent)
 *   ...plus `unverifiable` and `not-an-invariant` from the resolution pass
 *
 * `not-run` is deliberately NOT `passed`. A criterion whose evidence exists but was
 * never executed has not been checked, and the whole point of this file is that
 * "no evidence" and "verified" must never be the same answer.
 *
 * @param {{status: string, tests: string[]}[]} rows
 * @param {Map<string, boolean>} fileResults  test file -> did it pass
 */
export const applyRuns = (rows, fileResults) =>
  rows.map((r) => {
    if (r.status !== 'has-test') return r;
    const results = r.tests.map((t) => fileResults.get(t));
    if (results.some((v) => v === undefined)) return { ...r, status: 'not-run' };
    // ALL of them, not some. An invariant cited by two tests is claimed by both,
    // and one passing does not excuse the other failing.
    return { ...r, status: results.every(Boolean) ? 'passed' : 'failed' };
  });

/** Never a pass unless EVERY criterion produced evidence. */
export const summarise = (rows) => ({
  total: rows.length,
  hasTest: rows.filter((r) => r.status === 'has-test').length,
  passed: rows.filter((r) => r.status === 'passed').length,
  failed: rows.filter((r) => r.status === 'failed').length,
  notRun: rows.filter((r) => r.status === 'not-run').length,
  unverifiable: rows.filter((r) => r.status === 'unverifiable').length,
  notInvariant: rows.filter((r) => r.status === 'not-an-invariant').length,
  mentioned: rows.filter((r) => r.status === 'mentioned').length,
  // The whole point. A project whose ACs are all unverifiable has NOT been
  // verified, and must not close as though it had.
  // `not-run` belongs here. The evidence EXISTS — the tool declined to run it —
  // and excluding it made an all-`not-run` report print "NOTHING was verified:
  // every acceptance criterion lacks an executable test", which is false in the
  // one direction this file is supposed to prevent collapsing. The four-outcome
  // design separates "no test" from "test not executed"; this line had merged them
  // back together for the human-readable sentence a person reads before closing a
  // project. The VERIFIED verdict was never affected — it fails closed.
  anyEvidence: rows.some((r) => ['has-test', 'passed', 'failed', 'not-run'].includes(r.status)),
  // The verdict phase 5 acts on. A project PASSES only if every judgeable criterion
  // was executed and passed — `unverifiable` and `not-run` both block it, because
  // both mean nobody checked.
  verified: (() => {
    const judgeable = rows.filter((r) => !['not-an-invariant', 'mentioned'].includes(r.status));
    return judgeable.length > 0 && judgeable.every((r) => r.status === 'passed');
  })(),
  // `not-an-invariant` is a typo or a deleted invariant — a bookkeeping error, and
  // counting it against the project would leave a project permanently un-coverable
  // for a reason it cannot fix. It is reported separately and loudly instead.
  fullyCovered: (() => {
    const judgeable = rows.filter((r) => !['not-an-invariant', 'mentioned'].includes(r.status));
    return judgeable.length > 0 && judgeable.every((r) => ['has-test', 'passed', 'failed'].includes(r.status));
  })(),
});


/**
 * Did a runner's JSON report show THIS file's tests actually executing?
 *
 * `true` passed, `false` failed, `undefined` could-not-tell — and `undefined` is the
 * answer whenever the report does not positively show a test result (RA-1075). Exit code
 * alone cannot draw that line: vitest exits 1 for a real assertion failure, for "no test
 * files found", and for a globalSetup that could not reach Postgres — and measured on
 * vitest 5, the last one STILL writes a well-formed report, with `numTotalTests: 0` and
 * an empty `testResults`. So "the file exists" is not evidence either; a counted test is.
 *
 * A file that has its OWN result entry marked failed with no assertion run — it failed
 * to import, or a beforeAll threw — is `false`, deliberately. That shape is how a real
 * regression presents when the project renamed an export the test imports or made a
 * module throw at load, and calling it not-run would verify nothing and file nothing.
 * The environment failures are the other shape: a globalSetup that cannot reach its
 * database fails BEFORE any file is collected, so the report holds no entry for the
 * file at all.
 *
 * @param {'vitest'|'playwright'|'pytest'|'go'} runner
 * @param {unknown} report  the parsed JSON for Vitest and Playwright, the report's raw text for
 *   pytest (JUnit XML) and `go test -json` (one event per line), or null when there was none
 * @param {string} file     repo-relative test path
 */
export function interpretRun(runner, report, file) {
  if (runner === 'pytest') return typeof report === 'string' ? interpretJunit(report) : undefined;
  if (runner === 'go') return typeof report === 'string' ? interpretGoJson(report) : undefined;
  if (!report || typeof report !== 'object') return undefined;
  if (runner === 'vitest') {
    const mine = (report.testResults ?? []).filter((t) => typeof t?.name === 'string' && (t.name === file || t.name.endsWith(`/${file}`)));
    const asserts = mine.flatMap((t) => t.assertionResults ?? []);
    const ran = asserts.filter((a) => a.status === 'passed' || a.status === 'failed');
    if (ran.length === 0) return mine.some((t) => t.status === 'failed') ? false : undefined;
    return ran.every((a) => a.status === 'passed');
  }
  if (runner === 'playwright') {
    const st = report.stats ?? {};
    const ran = (st.expected ?? 0) + (st.unexpected ?? 0) + (st.flaky ?? 0);
    if (ran === 0) return undefined;
    // `flaky` passed on retry — Playwright exits 0 for it, and so does this.
    return (st.unexpected ?? 0) === 0;
  }
  return undefined;
}

/**
 * Run the citing tests and report, per FILE, whether it passed.
 *
 * Runs only the files that cite a criterion, not the tier — the point of targeted
 * mode is that a project's own acceptance criteria are checked rather than a whole
 * suite swept (RA-1068).
 *
 * A file this tool could not RUN is ABSENT from the result map, which `applyRuns`
 * turns into `not-run` — an unknown runner, and since RA-1075 every run that did not
 * report a test result: ENOENT, a signal kill, the 15-minute timeout, a globalSetup
 * that could not reach its database, no report written. Before RA-1075 any throw was
 * `false`, so on a box without Postgres every integration-tier citation reported
 * `failed` — a claim of evidence about a test that never executed. Silence here must
 * not read as success, and it must not read as failure either.
 *
 * @param {string[]} files
 * @param {{cwd?: string, exec?: typeof execFileSync, outDir?: string, read?: (file: string) => string}} [opts]
 *   `exec` is injectable so the tests do not shell out. It receives the same
 *   (cmd, args, options) `execFileSync` would; the runner's report is read back from the
 *   path named in the arguments (Vitest, pytest) or the env (Playwright), or taken from
 *   what `exec` returns, its standard output (`go test -json`). `read` gives a test file's
 *   text, which `go test` needs to name the file's test functions.
 */
// The default wraps `execFileSync` rather than aliasing it so the call site still reads
// as a subprocess with a COMPUTED binary — which is what permissions-guard.mjs flags as
// unreadable for its `gh` scan (RA-1379), and what this is.
export function runTests(files, { cwd = process.cwd(), exec = (bin, args, opts) => execFileSync(bin, args, opts), outDir, read = (f) => readFileSync(join(cwd, f), 'utf8') } = {}) {
  const results = new Map();
  const byRunner = new Map();
  for (const f of files) {
    const r = runnerFor(f);
    if (r === 'unknown') continue;
    if (!byRunner.has(r)) byRunner.set(r, []);
    byRunner.get(r).push(f);
  }

  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'verify-acs-'));
  try {
    runEach(byRunner, dir, cwd, exec, read, results);
  } finally {
    // Only a directory this call made; a caller's outDir is theirs to keep.
    if (!outDir) rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

function runEach(byRunner, dir, cwd, exec, read, results) {
  let n = 0;
  for (const [runner, group] of byRunner) {
    // PER FILE, not per batch. A batched run gives one exit code for many files,
    // so one failure would mark every criterion in the batch failed — blaming
    // criteria that passed, and sending an implementer after them.
    for (const file of group) {
      // A fresh path per file, so a report left by a previous file can never be read
      // as this one's.
      const out = join(dir, `run-${n++}.${runner === 'pytest' ? 'xml' : 'json'}`);
      // The command is the table's, run through the toolchain the project-setup hook
      // installed — never `npx`, which would fetch a runner the adopter never chose (kanon#20).
      let cmd;
      try { cmd = RUNNERS[runner](file, out, () => read(file)); } catch { cmd = null; }
      if (!cmd) continue;                                  // nothing to run: not-run
      const env = cmd.env ? { ...process.env, ...cmd.env } : process.env;
      let stdout = '';
      try {
        stdout = String(exec(cmd.bin, cmd.args, { cwd, env, stdio: cmd.report === 'stdout' ? ['ignore', 'pipe', 'ignore'] : 'ignore', encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 1e9 }) ?? '');
      } catch (e) {
        // A non-zero exit is not yet an answer — read the report to find out whether
        // a test failed or nothing ran at all.
        stdout = String(e?.stdout ?? '');
      }
      if (cmd.report === 'stdout' && stdout) writeFileSync(out, stdout);
      let report = null;
      try {
        const raw = readFileSync(out, 'utf8');
        report = runner === 'vitest' || runner === 'playwright' ? JSON.parse(raw) : raw;
      } catch { /* none written: not-run */ }
      const verdict = interpretRun(runner, report, file);
      if (verdict !== undefined) results.set(file, verdict);
    }
  }
}

/** The ref the evidence was gathered at. Recorded, never assumed: a report that
 *  does not say WHICH tree it ran against cannot be checked later, and phase 5's
 *  whole claim is "at the deployed tag". */
export function currentRef(cwd = process.cwd()) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    let described = null;
    try {
      described = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* not a tagged commit — say so rather than inventing one */ }
    return { sha, tag: described };
  } catch {
    return { sha: null, tag: null };
  }
}

const main = () => {
  const args = process.argv.slice(2);
  const project = args.find((a) => !a.startsWith('-'));
  const doRun = args.includes('--run');
  const jsonOut = args.find((a) => a.startsWith('--json='))?.slice('--json='.length);
  if (!project) {
    console.error('usage: verify-acs.mjs <project-number> [--run] [--json=<path>]');
    process.exit(2);
  }

  const brief = readFileSync(`docs/projects/${project}.md`, 'utf8');
  const known = new Set(specFiles().flatMap((f) => parseSpec(f)).map((i) => i.id).filter(Boolean));
  let rows = verdicts(acsFromBrief(brief), citations(), known);

  const ref = currentRef();
  if (doRun) {
    const files = [...new Set(rows.flatMap((r) => r.tests))];
    rows = applyRuns(rows, runTests(files));
  }
  const s = summarise(rows);

  console.log(`# Acceptance criteria — project #${project}\n`);
  console.log(`Evidence gathered at \`${ref.tag ?? ref.sha?.slice(0, 7) ?? 'unknown ref'}\`${doRun ? '' : ' — resolution only, no tests were run'}.\n`);
  console.log('| AC | issue | status | evidence |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| \`${r.id}\` | ${r.issue} | ${r.status} | ${r.tests.join(', ') || '—'} |`);

  // Every row in exactly one bucket. The previous line omitted `has-test`, so in
  // resolution-only mode the counts silently did not add up to the total.
  const buckets = [
    [s.passed, 'passed'], [s.failed, 'failed'], [s.hasTest, 'resolved, not executed'],
    [s.notRun, 'not-run'], [s.unverifiable, 'unverifiable'],
    [s.mentioned, 'mentioned only'], [s.notInvariant, 'not an invariant'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const accounted = s.passed + s.failed + s.hasTest + s.notRun + s.unverifiable + s.mentioned + s.notInvariant;
  console.log(`\n**${buckets.join(' · ')}** — ${accounted} of ${s.total} accounted for.`);
  if (accounted !== s.total) console.log(`\n**${s.total - accounted} row(s) fell into NO bucket** — a status this report does not know how to count.`);
  if (s.unverifiable) console.log(`\n**${s.unverifiable} UNVERIFIABLE** — no test names them. Unverifiable is not a pass.`);
  if (s.notRun) console.log(`\n**${s.notRun} NOT RUN** — a citing test exists but produced no test result here (not executed, or it could not start — e.g. no database). Not run is not a pass.`);
  if (s.notInvariant) console.log(`\n${s.notInvariant} cited ID(s) are declared by no spec — a typo, or an invariant deleted from under the brief. Not a failure of the project.`);
  if (!s.anyEvidence) console.log('\n**NOTHING was verified.** Every acceptance criterion lacks an executable test.');
  console.log(`\n**Verdict: ${s.verified ? 'VERIFIED' : 'NOT VERIFIED'}** — a project passes only when every judgeable criterion was executed and passed.`);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ project, ref, ran: doRun, summary: s, criteria: rows }, null, 2));
    console.log(`\nWrote \`${jsonOut}\`.`);
  }
};

// try/catch is half the precedent (`lead-reconcile.mjs`'s entry check, now `isCliEntry`). Without it,
// `pathToFileURL(undefined)` THROWS where the old `file://` template merely failed
// to match, so importing this module with no argv[1] — a REPL, a worker — crashes.
// Round 3's commit claimed both files were fixed; only spec-coverage.mjs was.
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (IS_CLI) main();
