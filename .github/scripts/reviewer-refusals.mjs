// Permission refusals per Reviewer run, from the review lane's telemetry rows (kanon#404).
//
// WHY. Since the Reviewer's shell became an allow-list (kanon#248), a read the CLI's read-only
// checker can't parse is refused like a write: a `cd …;` chain, a grep pattern holding `$`, a
// `sed -n '/a/,/b/p'` range, an absolute path, a loop or a variable. #248 measured about 1.7 a
// run over 73 runs. The prompt now steers each read to a shape the checker accepts, and #404 is
// done when the refusals per run are re-measured on the first 20 or more Reviewer runs after
// that ships. This is that measurement, re-runnable: the same numbers before and after.
//
// WHAT IT READS. Every `review` lane run uploads its version-2 telemetry row as an artifact,
// and the row carries `permission_denials`, the length of the CLI's own `permission_denials`
// list for the run, which is what #248 counted from the transcripts. It reads them with
// `scripts/lib/telemetry-artifacts.mjs`, this repository's own runs only, and groups them by
// the Kanon release the row names (`kanon_version`) and by `config_fingerprint`, which changes
// with the flags. A prompt change leaves the fingerprint as it was, and a row's `kanon_version`
// can read `dev` (it does on every row Kanon's own lanes wrote so far), so the runs after a
// change are chosen by time: `--after` the moment the caller's pin moved. A row without a denial
// count (the run never reached a result) is listed, and left out of the rate. Artifacts expire
// with the repository's retention, so measure while the runs are still there.
//
// RUN IT (a maintainer, with `gh` signed in to the repository):
//   node .github/scripts/reviewer-refusals.mjs --repo <owner/name> [--days 30] [--after <ISO time>] [--fingerprint <id>] [--first 20]
// `--after` keeps the runs recorded after that time, `--fingerprint` the runs with those flags,
// and `--first` the earliest N of what is left.

import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { ghApi, ghDownload, queryRunRows } from '../../scripts/lib/telemetry-artifacts.mjs';

const DAY = 86_400_000;

/**
 * Compare two `x.y.z` versions; a version that isn't one (`dev`) sorts first.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const parts = (/** @type {string} */ v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : [-1, -1, -1]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * @typedef {{ recorded_at: string, kanon_version?: string, config_fingerprint?: string, permission_denials?: number }} Row
 * @typedef {{ runs: number, counted: number, denials: number, perRun: number | null, most: number }} Tally
 */

/** @param {Row[]} rows @returns {Tally} */
function tally(rows) {
  const counts = rows.flatMap((r) => (typeof r.permission_denials === 'number' ? [r.permission_denials] : []));
  const denials = counts.reduce((a, b) => a + b, 0);
  return { runs: rows.length, counted: counts.length, denials, perRun: counts.length ? denials / counts.length : null, most: Math.max(0, ...counts) };
}

/**
 * The rows chosen, oldest first, and their refusals per run, overall and per release and
 * fingerprint.
 * @param {Row[]} rows
 * @param {{ after?: string, fingerprint?: string, first?: number }} [opts]
 */
export function summarize(rows, { after = '', fingerprint = '', first = 0 } = {}) {
  const from = after ? Date.parse(after) : -Infinity;
  let chosen = [...rows]
    .filter((r) => Date.parse(r.recorded_at) > from && (!fingerprint || r.config_fingerprint === fingerprint))
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  if (first > 0) chosen = chosen.slice(0, first);
  /** @type {Map<string, Row[]>} */
  const groups = new Map();
  for (const r of chosen) {
    const key = `${r.kanon_version ?? '(none)'}\t${r.config_fingerprint ?? '(none)'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return {
    total: tally(chosen),
    from: chosen[0]?.recorded_at ?? null,
    to: chosen.at(-1)?.recorded_at ?? null,
    groups: [...groups].map(([key, g]) => {
      const [version = '', fingerprint = ''] = key.split('\t');
      return { version, fingerprint, ...tally(g) };
    }).sort((a, b) => compareVersions(a.version, b.version) || a.fingerprint.localeCompare(b.fingerprint)),
  };
}

const rate = (/** @type {number | null} */ n) => (n === null ? 'n/a' : n.toFixed(2));

/** The summary as a Markdown table, to paste into the issue. */
export function render(/** @type {ReturnType<typeof summarize>} */ s) {
  const lines = [
    '| Kanon release | config_fingerprint | runs | with a count | refusals | per run | most in one run |',
    '|---|---|---|---|---|---|---|',
    ...s.groups.map((g) => `| ${g.version} | ${g.fingerprint} | ${g.runs} | ${g.counted} | ${g.denials} | ${rate(g.perRun)} | ${g.most} |`),
    `| **all** | | **${s.total.runs}** | ${s.total.counted} | ${s.total.denials} | **${rate(s.total.perRun)}** | ${s.total.most} |`,
  ];
  return `${lines.join('\n')}\n\nRuns from ${s.from ?? 'n/a'} to ${s.to ?? 'n/a'}.`;
}

function main(/** @type {string[]} */ argv) {
  const opt = (/** @type {string} */ name, /** @type {string} */ fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : String(argv[i + 1] ?? '');
  };
  const repo = opt('--repo', process.env.GITHUB_REPOSITORY ?? '');
  const days = Number(opt('--days', '30'));
  const first = Number(opt('--first', '0'));
  const after = opt('--after', '');
  const fingerprint = opt('--fingerprint', '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !(days > 0) || !(first >= 0) || (after && Number.isNaN(Date.parse(after)))) {
    console.log('Usage: node .github/scripts/reviewer-refusals.mjs --repo <owner/name> [--days 30] [--after <ISO time>] [--fingerprint <id>] [--first 20]');
    process.exit(1);
  }
  const read = queryRunRows('review', Date.now() - days * DAY, Infinity, { repo, api: ghApi(), download: ghDownload(repo) });
  const skipped = read.skipped.invalid + read.skipped.unreadable + read.skipped.mismatched;
  if (skipped) console.log(`warning: ${skipped} of ${read.listed} review artifacts could not be read (${JSON.stringify(read.skipped)}); the rate leaves them out.`);
  if (read.retentionDays !== null && read.retentionDays < days) console.log(`note: the repository keeps artifacts ${read.retentionDays} days, so this covers ${read.retentionDays} of the ${days}.`);
  console.log(render(summarize(/** @type {Row[]} */ (read.rows), { after, fingerprint, first })));
}

if (isCliEntry(import.meta.url)) main(process.argv.slice(2));
