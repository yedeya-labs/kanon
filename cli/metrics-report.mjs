// `kanon metrics report` (plan 0003 §7, M6, kanon#659): the three headline indicators by band,
// from one adopter's stored rows. It reads the rows from local files, which the caller exported
// from the telemetry store with its reader role (plan 0002 §6), and prints Markdown, or one JSON
// document with `--json` (docs/cli-json.md). It calls nothing: no GitHub, no store.
//
// The rows are counts, times, enums and numbers (ADR 0007), so the report is too. A file that
// can't be read stops the run, and the message names the file the caller gave, never its content.
//
// Exit codes, as the other commands':
//   0  the report was made (cells below their minimum say so, and a pooled view says why;
//      neither is a failure)
//   2  usage error
//   3  could not run: a rows file that can't be read or isn't JSON rows
//
// Node built-ins only, like the other commands; the file reading is `kanon metrics`'s.

import { metricsReport, renderReport, WINDOW_DAYS } from '../scripts/metrics/report.mjs';

/** The JSON output's contract (docs/metrics.md). A breaking change to it changes this. */
export const SCHEMA = 'kanon-metrics-report/v1';

/** The exit codes, as docs/metrics.md documents them. */
export const EXIT = /** @type {const} */ ({ ok: 0, usage: 2, error: 3 });

export const USAGE = `Usage: kanon metrics report --rows <file> [--rows <file> …] [options]

Reports the three headline indicators of plan 0003 §2 by complexity band: cost per merged work
item (median and p90, API list price), yield (the share of delivery spend that ended in merged
work) and the escaped-defect rate at 30 and 90 days, with first-review approval and the
human-correction rate beside it. Each with its 95% interval; a cell below its minimum sample says
"not enough data (N)". When cost doesn't rise with the band, the pooled view replaces the banded
one, with a warning. Reads only the files it is given; calls nothing.

Options:
  --rows <file>          one adopter's stored rows, run and work-item, as a JSON array, JSON
                         Lines, or a JSON object with a "rows" array. Repeat for several files
  --until <YYYY-MM-DD>   the window's end, 00:00 UTC, not included (default: now)
  --days <n>             the window's length in days, by close date (default: ${WINDOW_DAYS})
  --json                 print one JSON document (docs/metrics.md) instead of Markdown
  -h, --help             this text

Exit codes: 0 the report was made; 2 usage error; 3 could not run (docs/metrics.md).`;

/**
 * @typedef {{
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   readFile: (path: string) => string | null,
 *   release: () => string,
 *   now: () => Date,
 * }} ReportDeps
 */

/**
 * Parses `kanon metrics report`'s arguments, the subcommand already taken. Throws with a message
 * naming the problem.
 * @param {string[]} argv
 */
export function parseReportArgs(argv) {
  /** @type {{ rows: string[], until: Date | null, days: number, json: boolean, help: boolean }} */
  const opts = { rows: [], until: null, days: WINDOW_DAYS, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      if (inline === undefined && v.startsWith('-')) throw new Error(`${flag} needs a value, not the flag "${v}"; to give a value that begins with "-", write ${flag}=<value>`);
      return v;
    };
    if (flag === '-h' || flag === '--help') opts.help = true;
    else if (flag === '--rows') opts.rows.push(value());
    else if (flag === '--until') {
      const v = value();
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
      if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new Error(`--until takes a date, YYYY-MM-DD, not "${v}"`);
      opts.until = d;
    } else if (flag === '--days') {
      const v = value();
      if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 366) throw new Error(`--days takes a whole number of days from 1 to 366, not "${v}"`);
      opts.days = Number(v);
    } else if (flag === '--json') opts.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (opts.help && opts.json) throw new Error('--help and --json contradict each other; give one');
  if (opts.help) return opts;
  if (!opts.rows.length) throw new Error('--rows <file> is required: the rows exported from the telemetry store');
  return opts;
}

/** Stops the run with a message that names the file, never its content. */
class RowsError extends Error {}

/**
 * The rows in one file: a JSON array, a JSON object with a `rows` array, or JSON Lines.
 * @param {string} text @param {string} file
 * @returns {unknown[]}
 */
export function parseRows(text, file) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const doc = JSON.parse(trimmed);
    if (Array.isArray(doc)) return doc;
    if (doc && typeof doc === 'object' && Array.isArray(doc.rows)) return doc.rows;
    if (doc && typeof doc === 'object') return [doc];
  } catch {
    // Not one document: JSON Lines, below.
  }
  /** @type {unknown[]} */
  const rows = [];
  const lines = trimmed.split('\n');
  for (let k = 0; k < lines.length; k += 1) {
    const line = /** @type {string} */ (lines[k]).trim();
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new RowsError(`${file} is not JSON rows: line ${k + 1} is not JSON (give a JSON array, JSON Lines, or an object with a "rows" array)`);
    }
  }
  return rows;
}

/**
 * `kanon metrics report`, the subcommand already taken. Returns the exit code (`EXIT`).
 * @param {string[]} argv @param {ReportDeps} deps
 */
export function report(argv, deps) {
  const wantsJson = argv.includes('--json');
  const errorDocument = (/** @type {number} */ exitCode, /** @type {string} */ error) => ({ schema: SCHEMA, kanon: deps.release(), status: 'error', exitCode, error });
  /** @type {ReturnType<typeof parseReportArgs>} */
  let opts;
  try {
    opts = parseReportArgs(argv);
  } catch (e) {
    const message = /** @type {Error} */ (e).message;
    if (wantsJson) deps.out(JSON.stringify(errorDocument(EXIT.usage, message), null, 2));
    else {
      deps.err(`kanon metrics report: ${message}`);
      deps.err(USAGE);
    }
    return EXIT.usage;
  }
  if (opts.help) {
    deps.out(USAGE);
    return EXIT.ok;
  }
  /** @type {unknown[]} */
  const rows = [];
  try {
    for (const file of opts.rows) {
      const text = deps.readFile(file);
      if (text === null) throw new RowsError(`${file} is not a file that can be read`);
      rows.push(...parseRows(text, file));
    }
  } catch (e) {
    const message = e instanceof RowsError ? e.message : `stopped on an unexpected error: ${/** @type {Error} */ (e).message}`;
    if (opts.json) deps.out(JSON.stringify(errorDocument(EXIT.error, message), null, 2));
    else deps.err(`kanon metrics report: ${message}`);
    return EXIT.error;
  }
  const result = metricsReport(rows, { until: opts.until ?? deps.now(), days: opts.days });
  if (opts.json) deps.out(JSON.stringify({ schema: SCHEMA, kanon: deps.release(), status: result.view === 'banded' ? 'ok' : 'pooled', exitCode: EXIT.ok, ...result }, null, 2));
  else for (const line of renderReport(result)) deps.out(line);
  return EXIT.ok;
}
