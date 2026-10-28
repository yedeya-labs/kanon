#!/usr/bin/env node
// What Kanon's callers need before a candidate's pin pull request is green (kanon#1074). Kanon's
// pin job (plan 0009 §6, its step S4) runs it after `move-pins.mjs`:
//
//   node scripts/pin-lane-check.mjs <release> [--root <dir>]
//
// `<release>` is the exact release the pins moved to, `vX.Y.Z` or `candidate-vX.Y.Z`; `--root` is
// the moved checkout, the current directory by default. It runs `lane-check` from this script's
// own tree, which in the pin job is Kanon at the candidate, over that checkout at that release, as
// CI's `Lane check` runs it on the pin pull request. A candidate whose lane changes what its
// callers map, pass or grant (v0.41.0's project digest took `KANON_CHAT_PROJECT_DIGEST` in place of
// `DIGEST_WEBHOOK`, #1067) is named here, before the pull request opens.
//
// It changes nothing: the caller changes are a person's, made on the pull request's branch. Prints
// one markdown bullet per `::error` lane-check reports, with the file it names, and nothing when it
// passes; lane-check's own output goes to standard error, for the job's log. Exits 0 when
// lane-check passes; 1 when it fails, or can't run, which a bullet says, never a pass (K-PRIN-10);
// 2 on a release that is not exact.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from './lib/cli-entry.mjs';
import { RELEASE } from './move-pins.mjs';

/** This script's own tree: in the pin job, Kanon at the candidate. */
const KANON = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A workflow command lane-check prints: `::error file=<path>,title=lane-check::<message>`. */
const ERROR = /^::error(?: ([^:]*))?::(.*)$/;

/**
 * Each `::error` in lane-check's output, with the file its `file=` parameter names ('' when none).
 *
 * @param {string} out
 * @returns {{ file: string, message: string }[]}
 */
export function laneCheckProblems(out) {
  return out.split('\n').flatMap((line) => {
    const m = ERROR.exec(line);
    if (!m) return [];
    const file = (m[1] ?? '').split(',').find((p) => p.startsWith('file='))?.slice('file='.length) ?? '';
    return [{ file, message: m[2] ?? '' }];
  });
}

/**
 * The problems as a markdown list, one bullet each, its file in code; '' for none.
 *
 * @param {{ file: string, message: string }[]} problems
 */
export function problemList(problems) {
  return problems.map((p) => `- ${p.file ? `\`${p.file}\`: ` : ''}${p.message}`).join('\n');
}

/**
 * Runs lane-check from `kanon` over the checkout at `root`, at `release`.
 *
 * @param {{ root: string, release: string, kanon?: string }} options
 * @returns {{ ok: boolean, problems: { file: string, message: string }[], out: string }}
 */
export function pinLaneCheck({ root, release, kanon = KANON }) {
  if (!RELEASE.test(release)) throw new Error(`not an exact release: ${JSON.stringify(release)} (vX.Y.Z or candidate-vX.Y.Z)`);
  const r = spawnSync('bash', [join(kanon, 'actions/lane-check/lane-check.sh')], {
    cwd: root,
    encoding: 'utf8',
    // The tree at `root` is judged, never the run's pull request: lane-check's refs-only line
    // (kanon#1106) reads the event and `GITHUB_HEAD_REF`, and on a Dependabot branch it counts
    // any tree whose base it can't read as Dependabot's upgrade.
    env: { ...process.env, GITHUB_EVENT_NAME: '', GITHUB_EVENT_PATH: '', GITHUB_HEAD_REF: '', KANON_ROOT: kanon, ACTION_REF: release },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 0) return { ok: true, problems: [], out };
  const problems = laneCheckProblems(out);
  if (problems.length === 0) {
    const how = r.error ? r.error.message : r.status === null ? `on ${r.signal}` : `with ${r.status}`;
    problems.push({ file: '', message: `lane-check stopped ${how}, and named no problem: read the pin job's log` });
  }
  return { ok: false, problems, out };
}

/**
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {{ code: number, out: string, log: string }}
 */
export function pinLaneCheckCli(argv, cwd = process.cwd()) {
  const args = [...argv];
  let root = cwd;
  const at = args.indexOf('--root');
  if (at >= 0) {
    root = args[at + 1] ?? '';
    args.splice(at, 2);
  }
  const [release, ...rest] = args;
  if (!release || rest.length > 0 || !root) return { code: 2, out: '', log: 'usage: pin-lane-check.mjs <vX.Y.Z | candidate-vX.Y.Z> [--root <dir>]' };
  if (!RELEASE.test(release)) return { code: 2, out: '', log: `pin-lane-check: not an exact release: ${JSON.stringify(release)} (vX.Y.Z or candidate-vX.Y.Z)` };
  const r = pinLaneCheck({ root, release });
  return { code: r.ok ? 0 : 1, out: problemList(r.problems), log: r.out.replace(/\n+$/, '') };
}

if (isCliEntry(import.meta.url)) {
  const { code, out, log } = pinLaneCheckCli(process.argv.slice(2));
  if (log) process.stderr.write(`${log}\n`);
  if (out) process.stdout.write(`${out}\n`);
  process.exitCode = code;
}
