#!/usr/bin/env node
// The QA store contract (plan 0004 §3.2, step P9; `K-OBS-17`): what a store job asks of the
// adopter's store hook, and what it hands the lane back.
//
// THE HOOK IS THE ADOPTER'S; THE FILES ARE KANON'S. An adopter that runs a QA store keeps a
// composite action at `.github/actions/qa-store/action.yml`. Kanon calls it with five inputs
// (`operation`, `kind`, `dir`, `from`, `to`) and fixes, per operation, the files in `dir` the
// hook reads or writes. For an AWS store the hook is one `uses:` of Kanon's AWS action
// (`infra/qa-store/aws`); any other store implements the same five operations its own way.
//
//   operation    the hook reads              the hook writes
//   last-green   -                           `last-green`: the newest green full sweep's commit, or empty
//   record-skip  `skip.json`                 -
//   put          `report.json` (`kind`)      -
//   export       -                           `export/`: the files `EXPORT_FILES[kind]` names
//   cost-rows    -                           `cost-rows.json`: `{ rows, error }`, `readCostRows`'s shape
//
// WITHOUT A HOOK, EVERY OPERATION SAYS SO AND DOES NOTHING (§3.2, #19's "done when"):
// `last-green` returns no commit, so the Explorer always sweeps; `record-skip` and `put` are
// skipped with a notice; `export` writes a directory holding only its manifest, which says the
// store is absent; `cost-rows` returns no rows and an error naming the absence, and the dispatch
// sweep reads run artifacts instead (§3.3). A lane runs to completion either way, without memory.
//
// A FAILED READ IS DEGRADED, NEVER ABSENT, AND NEVER GREEN. `last-green`, `export` and
// `cost-rows` fail open in the lane's direction: no baseline (the Explorer sweeps), an export
// whose manifest says it is degraded, and cost rows with an error (the sweep charges every
// dispatch, `readCostRows`'s fail-closed rule). A failed WRITE (`put`, `record-skip`) fails the
// store job: that red run is the page (`K-OBS-6`), as `push-run.sh`'s was.
//
// Only this file and `action.yml` know the file names; the lanes read the block's outputs and
// the export artifact.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The environment every store job declares, and the only one (decision 9). The store's
 *  OIDC trust names it, so a job under any other name gets no credentials. */
export const STORE_ENVIRONMENT = 'kanon-qa-store';

/** The adopter's hook, at a fixed path (`K-LAYOUT-1`). */
export const HOOK_PATH = '.github/actions/qa-store/action.yml';

export const OPERATIONS = /** @type {const} */ (['last-green', 'record-skip', 'put', 'export', 'cost-rows']);
/** A failed write fails the job; a failed read is degraded. */
export const WRITE_OPERATIONS = /** @type {const} */ (['record-skip', 'put']);
export const READ_OPERATIONS = /** @type {const} */ (['last-green', 'export', 'cost-rows']);

/** What `put` takes: the Explorer's sweep summary (plan 0004 §4) or the audit's report. */
export const PUT_KINDS = /** @type {const} */ (['explorer', 'audit']);

/** The files an export holds, per lane. Each is a JSON array of objects, newest first where it
 *  has a time. `reports/` holds the raw reports of the runs in the window, by `<kind>/<ts>.json`. */
export const EXPORT_FILES = {
  audit: ['areas.json'],
  overseer: ['runs-explorer.json', 'runs-audit.json', 'coverage.json', 'areas.json'],
};
/** The directory of raw reports, in an Overseer export only. */
export const EXPORT_REPORTS = 'reports';
/** Files an adopter's hook may add to an Overseer export from its own scripts (§3.2): the
 *  token trend and the cache-TTL facts until plan 0002's S7, and the recall clusters. */
export const ADOPTER_EXPORT_FILES = ['token-trend.md', 'cache-ttl.md', 'qa-clusters.md'];
export const MANIFEST = 'manifest.json';

/** The files in the store job's directory. */
export const FILES = {
  lastGreen: 'last-green',
  skip: 'skip.json',
  report: 'report.json',
  export: 'export',
  costRows: 'cost-rows.json',
};

/** The export's artifact is kept one day, and a job of its own deletes it (§3.2). */
export const EXPORT_RETENTION_DAYS = 1;
/** An export's window, in days, when the lane names none: the Overseer runs weekly. */
export const DEFAULT_EXPORT_DAYS = 30;

const SHA = /^[0-9a-f]{40}$/;
/** A store sort key: basic ISO, `20260904T120245Z` (`dispatch-sweep.mjs`'s `costStamp`). */
export const STAMP = /^\d{8}T\d{6}Z$/;
const AGENT = /^[a-z][a-z0-9-]{0,39}$/;
const DAY = 86_400_000;

/** @param {number} ms */
export const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

/** The sentence a store job's summary carries when the adopter has no hook. */
export const absentLine = (/** @type {string} */ operation) =>
  `The QA store is absent: this repository has no \`${HOOK_PATH}\`, so \`${operation}\` did nothing and this run has no memory (\`K-OBS-17\`).`;

/**
 * Check a store job's request, and say what's wrong with it. A wrong request is the lane's bug,
 * so it fails the job by name, whatever the operation.
 * @param {Record<string, string|undefined>} env
 * @param {number} [now]
 * @returns {{ problems: string[], from: string, to: string }}
 */
export function checkRequest(env, now = Date.now()) {
  const op = env.OPERATION ?? '';
  const kind = env.KIND ?? '';
  /** @type {string[]} */
  const problems = [];
  let from = env.FROM ?? '';
  const to = env.TO ?? '';
  if (!(/** @type {readonly string[]} */ (OPERATIONS)).includes(op)) {
    problems.push(`operation '${op}' is not one of ${OPERATIONS.join(', ')}`);
    return { problems, from, to };
  }
  if (op === 'put' && !(/** @type {readonly string[]} */ (PUT_KINDS)).includes(kind)) problems.push(`put needs kind ${PUT_KINDS.join(' or ')}, not '${kind}'`);
  if (op === 'export' && !Object.hasOwn(EXPORT_FILES, kind)) problems.push(`export needs kind ${Object.keys(EXPORT_FILES).join(' or ')}, not '${kind}'`);
  if (op === 'cost-rows' && !AGENT.test(kind)) problems.push(`cost-rows needs kind, the telemetry agent whose rows it reads, not '${kind}'`);
  if (op === 'record-skip' && !SHA.test(env.COMMIT ?? '')) problems.push('record-skip needs commit, a full 40-character SHA');
  if (op === 'export' || op === 'cost-rows') {
    if (!from) {
      const days = Number(env.DAYS || (op === 'export' ? DEFAULT_EXPORT_DAYS : NaN));
      if (Number.isInteger(days) && days > 0) from = stamp(now - days * DAY);
      else problems.push(`${op} needs from (a store stamp such as 20260904T120245Z) or days`);
    }
    if (from && !STAMP.test(from)) problems.push(`from '${from}' is not a store stamp such as 20260904T120245Z`);
    if (to && !STAMP.test(to)) problems.push(`to '${to}' is not a store stamp such as 20260904T120245Z`);
  }
  return { problems, from, to };
}

/**
 * Before the hook: check the request, clear the job's directory and write what the hook reads.
 * @param {Record<string, string|undefined>} env
 * @param {number} [now]
 * @returns {{ outputs: Record<string, string>, notices: string[] }}
 */
export function prepare(env, now = Date.now()) {
  const { problems, from, to } = checkRequest(env, now);
  if (problems.length) throw new Error(problems.join('; '));
  const op = /** @type {string} */ (env.OPERATION);
  const dir = resolve(env.DIR || join(env.RUNNER_TEMP || '.', 'kanon-qa-store'));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  /** @type {string[]} */
  const notices = [];
  if (op === 'put') {
    const report = env.REPORT ?? '';
    if (report && existsSync(report)) {
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(report, 'utf8'));
      } catch {
        throw new Error(`the ${env.KIND} report at ${report} is not JSON`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`the ${env.KIND} report at ${report} is not a JSON object`);
      cpSync(report, join(dir, FILES.report));
    } else {
      // The hook decides what a missing report means: Kanon's AWS action skips it for the
      // Explorer, whose change gate produces report-less runs, and fails it for the audit.
      notices.push(`no ${env.KIND} report at '${report}'`);
    }
  }
  if (op === 'record-skip') {
    const skip = {
      commit: env.COMMIT,
      trigger: env.TRIGGER || 'schedule',
      tier: env.TIER || 'all',
      reason: env.REASON || 'unchanged-commit',
    };
    writeFileSync(join(dir, FILES.skip), `${JSON.stringify(skip)}\n`);
  }
  if (op === 'export') mkdirSync(join(dir, FILES.export));
  const present = existsSync(join(env.WORKSPACE || '.', HOOK_PATH));
  return { outputs: { present: String(present), dir, from, to }, notices };
}

/** @param {unknown} v */
const isObjectArray = (v) => Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
/** @param {unknown} v */
const stringOrNull = (v) => v === null || typeof v === 'string';

/**
 * `{ rows, error }` in `readCostRows`'s shape, or why it isn't.
 * @param {unknown} v
 * @returns {string|null}
 */
export function costRowsProblem(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  const o = /** @type {Record<string, unknown>} */ (v);
  if (!Array.isArray(o.rows)) return 'rows is not an array';
  if (!stringOrNull(o.error ?? null)) return 'error is neither a string nor null';
  for (const [i, r] of o.rows.entries()) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `rows[${i}] is not an object`;
    for (const k of ['ts', 'issue_number', 'outcome', 'run_id']) {
      if (!stringOrNull(/** @type {Record<string, unknown>} */ (r)[k] ?? null)) return `rows[${i}].${k} is neither a string nor null`;
    }
  }
  return null;
}

/**
 * Read a `cost-rows` file as `readCostRows` returns its result: FAILS CLOSED, so an unreadable
 * or malformed file is `{ rows: [], error }`, which charges every dispatch and says why.
 * @param {string} path
 * @returns {{ rows: Array<{ ts: string|null, issue_number: string|null, outcome: string|null, run_id: string|null }>, error: string|null }}
 */
export function readCostRowsFile(path) {
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { rows: [], error: `the store's cost rows could not be read from ${path}` };
  }
  const problem = costRowsProblem(v);
  if (problem) return { rows: [], error: `the store's cost rows are malformed (${problem})` };
  const o = /** @type {{ rows: Array<Record<string, string|null>>, error?: string|null }} */ (v);
  if (o.error) return { rows: [], error: o.error };
  return {
    rows: o.rows.map((r) => ({ ts: r.ts ?? null, issue_number: r.issue_number ?? null, outcome: r.outcome ?? null, run_id: r.run_id ?? null })),
    error: null,
  };
}

/**
 * What an export directory holds that Kanon doesn't allow, and what it lacks.
 * @param {string} root the `export/` directory
 * @param {string} kind
 * @returns {{ missing: string[], invalid: string[], unknown: string[] }}
 */
export function exportProblems(root, kind) {
  const want = EXPORT_FILES[/** @type {keyof typeof EXPORT_FILES} */ (kind)] ?? [];
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const invalid = [];
  for (const f of want) {
    const at = join(root, f);
    if (!existsSync(at)) { missing.push(f); continue; }
    try {
      if (!isObjectArray(JSON.parse(readFileSync(at, 'utf8')))) invalid.push(f);
    } catch {
      invalid.push(f);
    }
  }
  const allowed = new Set([...want, MANIFEST, ...(kind === 'overseer' ? [EXPORT_REPORTS, ...ADOPTER_EXPORT_FILES] : [])]);
  const unknown = existsSync(root) ? readdirSync(root).filter((f) => !allowed.has(f)) : [];
  if (kind === 'overseer' && existsSync(join(root, EXPORT_REPORTS)) && !statSync(join(root, EXPORT_REPORTS)).isDirectory()) unknown.push(EXPORT_REPORTS);
  return { missing, invalid, unknown };
}

/** Empty a directory, keeping it. @param {string} root */
const emptyDir = (root) => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
};

/**
 * After the hook: read what it wrote, and turn it into the block's outputs and one summary line.
 * @param {Record<string, string|undefined>} env  OPERATION, KIND, DIR, PRESENT, HOOK_OUTCOME
 * @param {number} [now]
 * @returns {{ outputs: Record<string, string>, line: string, warnings: string[] }}
 */
export function finish(env, now = Date.now()) {
  const op = env.OPERATION ?? '';
  const kind = env.KIND ?? '';
  const dir = env.DIR ?? '';
  const present = env.PRESENT === 'true';
  // A read step that never ran (absent) has no outcome; one that ran and failed is degraded.
  const failed = present && env.HOOK_OUTCOME !== 'success';
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, string>} */
  const outputs = { present: String(present), state: present ? 'ok' : 'absent', commit: '' };

  if (!present) {
    if (op === 'export') writeFileSync(join(dir, FILES.export, MANIFEST), `${JSON.stringify({ store: 'absent', kind, generated_at: new Date(now).toISOString(), files: [] })}\n`);
    if (op === 'cost-rows') writeFileSync(join(dir, FILES.costRows), `${JSON.stringify({ rows: [], error: 'the QA store is absent' })}\n`);
    return { outputs, line: absentLine(op), warnings };
  }

  if (op === 'last-green') {
    const at = join(dir, FILES.lastGreen);
    const value = existsSync(at) ? readFileSync(at, 'utf8').trim() : '';
    if (failed) {
      outputs.state = 'degraded';
      warnings.push('the store hook failed to read the last green sweep, so this commit cannot be compared with it: running the full sweep.');
    } else if (value && !SHA.test(value)) {
      // The gate's tripwire (RA-702): anything but a bare 40-hex SHA means the read changed
      // shape. Fail open, never silently.
      outputs.state = 'degraded';
      warnings.push(`the store hook returned a non-SHA last green commit ('${value.slice(0, 80).replace(/\s+/g, ' ')}'): running the full sweep.`);
    } else {
      outputs.commit = value;
    }
    const line = outputs.state === 'degraded'
      ? `QA store \`last-green\`: degraded, so no baseline (${warnings[0]})`
      : `QA store \`last-green\`: ${value ? `\`${value}\`` : 'no green full sweep recorded'}.`;
    return { outputs, line, warnings };
  }

  if (op === 'export') {
    const root = join(dir, FILES.export);
    mkdirSync(root, { recursive: true });
    let state = failed ? 'degraded' : 'ok';
    /** @type {string[]} */
    let files = [];
    if (failed) {
      warnings.push('the store hook failed to export the store, so this run reads none of it.');
      emptyDir(root);
    } else {
      const { missing, invalid, unknown } = exportProblems(root, kind);
      for (const f of unknown) {
        // Only the files Kanon fixes reach the agent (ADR 0007's boundary is the adopter's
        // account, and an export is an artifact anyone who reads the repository can download).
        rmSync(join(root, f), { recursive: true, force: true });
        warnings.push(`the store hook exported '${f}', which isn't a file the ${kind} export holds: left out.`);
      }
      if (missing.length || invalid.length) {
        state = 'degraded';
        warnings.push(`the store hook's export lacks ${[...missing, ...invalid.map((f) => `a valid ${f}`)].join(', ')}, so this run reads none of it.`);
        emptyDir(root);
      } else {
        files = readdirSync(root).sort();
      }
    }
    outputs.state = state;
    writeFileSync(join(root, MANIFEST), `${JSON.stringify({ store: state === 'ok' ? 'present' : 'degraded', kind, generated_at: new Date(now).toISOString(), files })}\n`);
    const line = state === 'ok'
      ? `QA store \`export\` (${kind}): ${files.join(', ')}.`
      : `QA store \`export\` (${kind}): degraded, so the agent reads none of the store.`;
    return { outputs, line, warnings };
  }

  if (op === 'cost-rows') {
    const at = join(dir, FILES.costRows);
    let result = readCostRowsFile(at);
    // A hook that failed may still have said why, in the file's `error` (Kanon's AWS action
    // does). Anything else from a failed hook is not read as rows.
    if (failed) {
      const said = result.error && !result.error.startsWith("the store's cost rows") ? result.error : null;
      result = { rows: [], error: said ?? 'the store hook failed' };
    }
    if (result.error) {
      outputs.state = 'degraded';
      warnings.push(`cost rows for \`${kind}\` NOT read: ${result.error}.`);
    }
    writeFileSync(at, `${JSON.stringify(result)}\n`);
    const line = result.error
      ? `QA store \`cost-rows\` (${kind}): NOT read, ${result.error}.`
      : `QA store \`cost-rows\` (${kind}): ${result.rows.length} rows.`;
    return { outputs, line, warnings };
  }

  // put and record-skip: the hook succeeded, or the job is already red.
  return { outputs, line: `QA store \`${op}\`${kind ? ` (${kind})` : ''}: written.`, warnings };
}

/**
 * `delete-export`: delete the export's artifact, and say so when this attempt re-ran the agent
 * job against an export an earlier attempt already deleted (kanon#224).
 *
 * WHY A RE-RUN NEEDS THIS. "Re-run failed jobs" re-runs a failed agent job and the jobs after
 * it, the delete job among them, but never the export job, which succeeded: the re-run reuses
 * its outputs, and the artifact they name was deleted when the earlier attempt's delete job
 * ran, `if: always()`. So the lane's agent job runs only on the export's own attempt
 * (`needs.<export>.outputs.attempt == github.run_attempt`, which `store-jobs.ts` requires),
 * and is skipped on a partial re-run instead of reading nothing. This is where the run turns
 * red and says why: the export is from an earlier attempt and the agent job was skipped.
 * "Re-run all jobs" exports again. A re-run of the delete job alone (the agent job succeeded,
 * the delete failed) deletes the export and stays green.
 *
 * An artifact already gone (404) is not an error: the export not existing is the goal.
 *
 * @param {Record<string, string | undefined>} env `ARTIFACT_ID`, `EXPORT_ATTEMPT`, `RUN_ATTEMPT`,
 *   `AGENT_RESULT`, `REPO`, `GH_TOKEN`, `GITHUB_API_URL`
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ lines: string[], error: string | null }>}
 */
export async function deleteExport(env, fetchImpl = fetch) {
  const id = env.ARTIFACT_ID ?? '';
  const exportAttempt = env.EXPORT_ATTEMPT ?? '';
  const runAttempt = env.RUN_ATTEMPT ?? '';
  /** @type {string[]} */
  const lines = [];
  if (id !== '' && !/^\d+$/.test(id)) return { lines, error: `artifact-id '${id}' is not a number` };
  if (id !== '' && exportAttempt === '') return { lines, error: 'delete-export needs export-attempt, the export job\'s attempt output' };
  if (id === '') {
    lines.push('No export artifact to delete: the export job uploaded none.');
  } else {
    const api = env.GITHUB_API_URL || 'https://api.github.com';
    const res = await fetchImpl(`${api}/repos/${env.REPO}/actions/artifacts/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) lines.push(`The QA store export (artifact ${id}) was already deleted.`);
    else if (res.ok) lines.push(`Deleted the QA store export (artifact ${id}).`);
    else return { lines, error: `deleting the QA store export (artifact ${id}) failed: HTTP ${res.status}` };
  }
  if (exportAttempt !== '' && exportAttempt !== runAttempt && env.AGENT_RESULT === 'skipped') {
    return {
      lines,
      error: `attempt ${runAttempt} re-ran the agent job without the export job, whose export, from attempt ${exportAttempt}, `
        + 'was deleted when that attempt finished. The agent job was skipped rather than run without the store. '
        + 'Use "Re-run all jobs", which exports again.',
    };
  }
  return { lines, error: null };
}

/** @param {Record<string, string>} outputs */
const writeOutputs = (outputs) => {
  const out = process.env.GITHUB_OUTPUT;
  const text = Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join('');
  if (out) appendFileSync(out, text);
  else process.stdout.write(text);
};

/** @param {string} line */
const writeSummary = (line) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  console.log(line);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === 'prepare') {
      const { outputs, notices } = prepare(process.env);
      for (const n of notices) console.log(`::notice title=qa-store::${n}`);
      writeOutputs(outputs);
    } else if (mode === 'finish') {
      const { outputs, line, warnings } = finish(process.env);
      for (const w of warnings) console.log(`::warning title=qa-store::${w}`);
      writeOutputs(outputs);
      writeSummary(line);
    } else if (mode === 'delete-export') {
      const { lines, error } = await deleteExport(process.env);
      for (const l of lines) writeSummary(l);
      if (error) throw new Error(error);
    } else {
      console.error('usage: qa-store.mjs prepare|finish|delete-export');
      process.exit(2);
    }
  } catch (e) {
    console.log(`::error title=qa-store::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
