#!/usr/bin/env node
// The `notify` block (plan 0011 §5, step N6; `K-OBS-19`): one lane's message, handed to the
// adopter's hook at `.github/actions/notify`, in the lane's `notify` job, and recorded.
//
// THE HOOK IS THE ADOPTER'S; THE STEPS AROUND IT ARE KANON'S. `action.yml` runs this file in five
// modes, in order, around the one step that calls the hook:
//
//   mask      registers the secret, and each line of it, with `::add-mask::`, before anything prints
//   prepare   decides whether anything is posted: no secret is `skipped` (`no-secret`), checked
//             FIRST, since with no secret the gate also skipped the producer and the artifact is
//             empty too (decision 21); then no artifact is `skipped` (`no-message`). Names the
//             hook's kind for telemetry, and the producer's attempt from the artifact's name
//   check     validates the downloaded `message.json` with `notify-contract.mjs` and the hook's
//             declared contract version, BEFORE the hook is called: an invalid message, or a hook
//             that declares no version this release writes, calls no hook and fails the job by name
//   finish    the outcome (`posted`, `failed`, `skipped`), the one line doctor reads, and the
//             `notify` telemetry row, written on every outcome
//   fail      fails the job, by name, unless the outcome is `posted` or `skipped`
//
// THE ARTIFACT'S NAME IS THE PRODUCER'S, NEVER COMPUTED HERE (§4). After "Re-run failed jobs" this
// job's `github.run_attempt` is one past the green producer's, so the lane hands the name the
// producer published (`message-artifact`), and the row's `producer_attempt` is read from it.
//
// NOTHING HERE PRINTS A URL, A CHANNEL, THE MESSAGE'S TEXT OR THE SECRET. A rejection names fields
// (`validate`'s `describeErrors`), the doctor line names the hook's kind, the message's kind and
// the outcome, and the row holds closed words and numbers only (`schema.mjs`, NOTIFY_V1).

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeErrors as describeMessageErrors, KIND_SECRETS, KINDS, renderText, validate as validateMessage, VERSIONS } from '../../scripts/lib/notify-contract.mjs';
import { describeErrors as describeRowErrors, LANES, NOTIFY_HOOKS, TAGS, validate as validateRow } from '../agent-telemetry/schema.mjs';
import { kanonVersion } from '../agent-telemetry/agent-telemetry.mjs';
import { DELIVERY_ARTIFACT_FILE, deliveryArtifactName } from '../../scripts/lib/telemetry-artifacts.mjs';
import { parseYaml } from '../../cli/workflow-yaml.mjs';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

/** The adopter's hook, at a fixed path (§6.1, `K-LAYOUT-1`): the one thing the block calls. */
export const HOOK_PATH = '.github/actions/notify/action.yml';
/** The line the block prints for doctor (§5.1, step 6), before its JSON: `cli/doctor.mjs`'s `NOTIFY_LINE`. */
export const LINE = 'kanon-notify/v1';
/**
 * The telemetry lane a kind's `notify` row is written under, where it isn't the kind's own name:
 * the deploy lane's is `deploy-announce`, since `deploy` is the deploy rows' partition, which no
 * lane may take (`schema.mjs`, `DEPLOY_PARTITION`; plan 0011 N9), and the `release` kind's is its
 * lane's, `release-announce` (kanon#1190).
 * @type {Readonly<Record<string, string>>}
 */
export const ROW_LANES = Object.freeze({ deploy: 'deploy-announce', release: 'release-announce' });
/** The file a producer's artifact holds (§4): one message. */
export const MESSAGE_FILE = 'message.json';
/** The block's state between its steps, in its directory under `runner.temp`. */
export const STATE_FILE = 'state.json';
/** The files the hook reads, in the block's directory: the message at its version, and its text. */
export const messageFile = (/** @type {number} */ version) => `message-v${version}.json`;
export const TEXT_FILE = 'text.txt';

/**
 * A producer's artifact (§4): `kanon-notify-<lane>-<job>-<run id>-<attempt>`, the producer's own
 * attempt last. Its lane and job may hold hyphens, so only the two numbers are read.
 */
export const ARTIFACT = /^kanon-notify-[a-z0-9][a-z0-9-]*-(\d+)-(\d+)$/;
/** Kanon's prebuilt hooks (§7.1): a hook whose one step is Kanon's action of that name, at any ref. */
export const PREBUILT = /^yedeya-labs\/kanon\/actions\/notify\/(slack|webhook)@[^\s@]+$/;

/**
 * @typedef {{ started_ms: number, kind: string, tag: string, hook: string, present: boolean,
 *   producer_attempt?: number, skip_reason?: string, failure?: string, problem?: string,
 *   contract_version?: number, called?: boolean }} State
 */

/**
 * What to mask (§5.1, step 3): the secret whole, and each of its lines when it holds several, as
 * the QA store block masks its coordinates. The runner masks a secret it was handed whole, but a
 * multi-line value prints line by line, and `::add-mask::` takes one line.
 * @param {string | undefined} secret
 * @returns {string[]}
 */
export function masks(secret) {
  const s = String(secret ?? '');
  if (!s.trim()) return [];
  // A workflow command is one line: a value with a line break is masked line by line, never whole,
  // or its second line would print as it is.
  return [...new Set(s.split(/\r?\n/).filter((line) => line.trim()))];
}

/**
 * The hook's composite action, read, or `undefined` when there is none or it isn't YAML.
 * @param {string} text
 * @returns {Record<string, any> | undefined}
 */
const readHook = (text) => {
  try {
    const doc = parseYaml(text);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? /** @type {Record<string, any>} */ (doc) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The hook's kind, for telemetry (§5.1, step 4): `slack` or `webhook` when its one step is Kanon's
 * prebuilt action of that name, `custom` otherwise, a hook that can't be read among them.
 * @param {string} text the hook's `action.yml`
 * @returns {'slack' | 'webhook' | 'custom'}
 */
export function hookKind(text) {
  const steps = readHook(text)?.runs?.steps;
  if (!Array.isArray(steps) || steps.length !== 1) return 'custom';
  const step = steps[0];
  if (!step || typeof step !== 'object' || step.run !== undefined) return 'custom';
  const m = PREBUILT.exec(String(step.uses ?? '').trim());
  return m ? /** @type {'slack' | 'webhook'} */ (m[1]) : 'custom';
}

/**
 * The contract versions the hook declares, by its `message-v<N>` inputs (§6.2, item 1), oldest first.
 * @param {string} text the hook's `action.yml`
 * @returns {number[]}
 */
export function declaredVersions(text) {
  const inputs = readHook(text)?.inputs;
  if (!inputs || typeof inputs !== 'object') return [];
  return Object.keys(inputs).flatMap((k) => {
    const m = /^message-v([1-9]\d*)$/.exec(k);
    return m ? [Number(m[1])] : [];
  }).sort((a, b) => a - b);
}

/**
 * The version the hook is handed (§6.2, item 1): the newest it declares that this release writes.
 * @param {number[]} declared
 * @param {readonly number[]} [written] the versions this release writes
 * @returns {number | undefined}
 */
export const chooseVersion = (declared, written = VERSIONS) => [...declared].reverse().find((v) => written.includes(v));

/** @param {string} dir */
const readState = (dir) => /** @type {State} */ (JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')));
/** @param {string} dir @param {State} state */
const writeState = (dir, state) => writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state)}\n`);

/**
 * Before any download: is there anything to post, and which hook would post it?
 *
 * `HAS_SECRET` is `'true'` when the kind's secret is set; this step is never handed the secret.
 * @param {Record<string, string | undefined>} env
 * @param {number} [now]
 * @returns {{ outputs: Record<string, string>, lines: string[] }}
 */
export function prepare(env, now = Date.now()) {
  const kind = env.KIND ?? '';
  if (!KINDS.includes(kind)) throw new Error(`kind '${kind}' is not one of ${KINDS.join(', ')}`);
  const tag = env.TAG || 'run';
  if (!TAGS.includes(tag)) throw new Error(`tag '${tag}' is not one of ${TAGS.join(', ')}`);
  const dir = resolve(env.DIR || join(env.RUNNER_TEMP || '.', 'kanon-notify'));
  mkdirSync(dir, { recursive: true });
  const hookFile = join(env.WORKSPACE || '.', HOOK_PATH);
  const present = existsSync(hookFile);
  // A hook that isn't there is `custom` in the row: the gate saw one at this commit, so its
  // absence here is the adopter's, and the hook's step is what fails (below, in `check`).
  /** @type {State} */
  const state = { started_ms: now, kind, tag, present, hook: present ? hookKind(readFileSync(hookFile, 'utf8')) : 'custom' };
  /** @type {string[]} */
  const lines = [];
  const artifact = (env.ARTIFACT ?? '').trim();
  if (env.HAS_SECRET !== 'true') {
    state.skip_reason = 'no-secret';
    lines.push(`No \`${KIND_SECRETS[kind]}\`: this kind was not posted.`);
  } else if (!artifact) {
    state.skip_reason = 'no-message';
    lines.push(`No ${kind} message: the producing job wrote none, so nothing was posted.`);
  } else {
    const m = ARTIFACT.exec(artifact);
    if (m) state.producer_attempt = Number(m[2]);
    else {
      state.failure = 'invalid-message';
      state.problem = 'the artifact input is not a producer\'s message artifact (kanon-notify-<lane>-<job>-<run id>-<attempt>)';
    }
  }
  writeState(dir, state);
  const go = !state.skip_reason && !state.failure;
  return { outputs: { go: String(go), dir }, lines };
}

/**
 * After the download, before the hook: the message validates, its kind is the job's, and the hook
 * declares a contract version this release writes. Writes the files the hook reads. Never throws on
 * a bad message: it records the failure, so `finish` writes the row before the job fails.
 * @param {Record<string, string | undefined>} env
 * @returns {{ outputs: Record<string, string>, lines: string[] }}
 */
export function check(env) {
  const dir = resolve(env.DIR ?? '');
  const state = readState(dir);
  /** @type {(failure: string, problem: string) => { outputs: Record<string, string>, lines: string[] }} */
  const refuse = (failure, problem) => {
    state.failure = failure;
    state.problem = problem;
    writeState(dir, state);
    return { outputs: { call: 'false' }, lines: [] };
  };
  const file = join(env.DOWNLOAD ?? join(dir, 'download'), MESSAGE_FILE);
  if (!existsSync(file)) return refuse('invalid-message', `the message artifact holds no ${MESSAGE_FILE}`);
  /** @type {unknown} */
  let message;
  try {
    message = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return refuse('invalid-message', `the message artifact's ${MESSAGE_FILE} is not JSON`);
  }
  const v = validateMessage(message);
  if (!v.ok) return refuse('invalid-message', `the message breaks the kanon-notify contract: ${describeMessageErrors(v.errors)}`);
  const msg = /** @type {Record<string, any>} */ (message);
  if (msg.kind !== state.kind) return refuse('invalid-message', `the message's kind is not this job's kind, ${state.kind}`);
  const hookFile = join(env.WORKSPACE || '.', HOOK_PATH);
  if (!existsSync(hookFile)) return refuse('hook-step-failed', `there is no hook at ${HOOK_PATH} at this commit`);
  const declared = declaredVersions(readFileSync(hookFile, 'utf8'));
  const version = chooseVersion(declared);
  if (version === undefined) {
    const has = declared.length ? `declares only ${declared.map((n) => `message-v${n}`).join(', ')}` : 'declares no message-v<N> input';
    return refuse('hook-step-failed', `the hook at ${HOOK_PATH} ${has}, and this release writes ${VERSIONS.map((n) => `message-v${n}`).join(', ')}: declare the input it reads (docs/notifications.md)`);
  }
  // Version 1 is the only version: the validated file is handed on as it is. A second version
  // would be written here from the first, for a hook that declares it (§3.4).
  const handed = join(dir, messageFile(version));
  copyFileSync(file, handed);
  const text = join(dir, TEXT_FILE);
  writeFileSync(text, renderText(msg));
  state.contract_version = version;
  state.called = true;
  writeState(dir, state);
  return { outputs: { call: 'true', [`message-v${version}`]: handed, text }, lines: [] };
}

/**
 * The outcome, from what the steps recorded and the hook step's outcome.
 * @param {State} state
 * @param {string} hookOutcome `steps.hook.outcome`: `success`, `failure`, or empty when it didn't run
 * @returns {{ outcome: 'posted' | 'failed' | 'skipped', skip_reason?: string, failure?: string, problem?: string }}
 */
export function outcomeOf(state, hookOutcome) {
  if (state.skip_reason) return { outcome: 'skipped', skip_reason: state.skip_reason };
  if (state.failure) return { outcome: 'failed', failure: state.failure, problem: state.problem };
  // The message was never checked: the download failed, or the check step didn't finish. No
  // hook ran, and the message never reached it.
  if (!state.called) return { outcome: 'failed', failure: 'invalid-message', problem: 'the message could not be downloaded or read' };
  if (hookOutcome === 'success') return { outcome: 'posted' };
  return { outcome: 'failed', failure: 'hook-step-failed', problem: `the hook's step failed (read its error above)` };
}

/**
 * After the hook, on every outcome: the doctor line, the summary line and the telemetry row.
 * @param {Record<string, string | undefined>} env
 * @param {number} [now]
 * @returns {{ outputs: Record<string, string>, lines: string[], summary: string, notices: string[] }}
 */
export function finish(env, now = Date.now()) {
  const dir = resolve(env.DIR ?? '');
  const state = readState(dir);
  const result = outcomeOf(state, env.HOOK_OUTCOME ?? '');
  if (result.problem) writeState(dir, { ...state, problem: result.problem });
  const hook = NOTIFY_HOOKS.includes(state.hook) ? state.hook : 'custom';
  const line = `${LINE} ${JSON.stringify({ hook, kind: state.kind, outcome: result.outcome })}`;
  const summary = result.outcome === 'posted'
    ? `Posted the ${state.kind} message through the ${hook} hook.`
    : result.outcome === 'skipped'
      ? (result.skip_reason === 'no-secret' ? `No \`${KIND_SECRETS[state.kind]}\`: this kind was not posted.` : `No ${state.kind} message was produced, so nothing was posted.`)
      : `The ${state.kind} message was not posted: ${result.problem}.`;
  /** @type {string[]} */
  const notices = [];
  /** @type {Record<string, string>} */
  const outputs = { outcome: result.outcome, reason: result.skip_reason ?? result.failure ?? '', row: '', 'row-artifact': '' };
  // The row's lane is the kind's own lane (§3.2): the digests' by their kind's name, the deploy
  // lane's as `deploy-announce`, since `deploy` is the deploy rows' reserved partition (N9), and the
  // release announcement's as `release-announce` (kanon#1190).
  const lane = ROW_LANES[state.kind] ?? state.kind;
  if (!LANES.includes(lane)) {
    notices.push(`no notify row: the ${lane} lane is not in the telemetry schema's lanes yet`);
  } else {
    /** @type {Record<string, unknown>} */
    const row = {
      schema_version: 1,
      row_kind: 'notify',
      tag: state.tag,
      recorded_at: new Date(now).toISOString(),
      run_id: Number(env.RUN_ID),
      run_attempt: Number(env.RUN_ATTEMPT),
      ...(state.producer_attempt !== undefined ? { producer_attempt: state.producer_attempt } : {}),
      lane,
      kanon_version: kanonVersion(env.KANON_REF ?? '', env.KANON_WORKFLOW_REF ?? '', env.KANON_WORKFLOW_SHA ?? ''),
      kind: state.kind,
      ...(state.contract_version !== undefined ? { contract_version: state.contract_version } : {}),
      hook,
      outcome: result.outcome,
      ...(result.skip_reason ? { skip_reason: result.skip_reason } : {}),
      ...(result.failure ? { failure: result.failure } : {}),
      duration_ms: Math.max(0, now - state.started_ms),
    };
    const v = validateRow(row);
    if (v.ok) {
      const rowFile = join(dir, 'row', DELIVERY_ARTIFACT_FILE);
      mkdirSync(join(dir, 'row'), { recursive: true });
      writeFileSync(rowFile, `${JSON.stringify(row)}\n`);
      outputs.row = rowFile;
      // The deploy lane notifies once per environment in one run: its position keeps the names apart.
      const position = /^\d+$/.test(String(env.POSITION ?? '')) ? String(env.POSITION) : undefined;
      outputs['row-artifact'] = deliveryArtifactName(lane, String(env.RUN_ID), String(env.RUN_ATTEMPT), position);
    } else {
      // Telemetry is an observer: a row that doesn't validate is not uploaded, and the post's
      // outcome stands. It is a Kanon bug, said by field name.
      notices.push(`the notify row did not validate, so it is not uploaded: ${describeRowErrors(v.errors)}`);
    }
  }
  return { outputs, lines: [line], summary, notices };
}

/**
 * The job's verdict: red unless the message was posted or skipped (§5.4). The producing job stays
 * green either way (`K-SHIP-10`).
 * @param {Record<string, string | undefined>} env `OUTCOME` and `DIR`
 * @returns {string | undefined} the error, or `undefined` when the job may stay green
 */
export function verdict(env) {
  if (env.OUTCOME === 'posted' || env.OUTCOME === 'skipped') return undefined;
  /** @type {string | undefined} */
  let problem;
  try { problem = readState(resolve(env.DIR ?? '')).problem; } catch { problem = undefined; }
  return `nothing was posted: ${problem ?? 'the block did not finish'}`;
}

/** @param {Record<string, string>} outputs */
const writeOutputs = (outputs) => {
  const text = Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
};
/** @param {string} line */
const writeSummary = (line) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

if (isCliEntry(import.meta.url)) {
  const mode = process.argv[2];
  const env = process.env;
  try {
    if (mode === 'mask') {
      for (const m of masks(env.SECRET)) console.log(`::add-mask::${m}`);
    } else if (mode === 'prepare') {
      const { outputs, lines } = prepare(env);
      // The summary line is `finish`'s, written on every outcome.
      for (const l of lines) console.log(`::notice title=notify::${l}`);
      writeOutputs(outputs);
    } else if (mode === 'check') {
      writeOutputs(check(env).outputs);
    } else if (mode === 'finish') {
      const { outputs, lines, summary, notices } = finish(env);
      for (const n of notices) console.log(`::notice title=notify::${n}`);
      for (const l of lines) console.log(l);
      writeSummary(summary);
      writeOutputs(outputs);
    } else if (mode === 'fail') {
      const error = verdict(env);
      if (error) throw new Error(error);
    } else {
      console.error('usage: notify.mjs mask|prepare|check|finish|fail');
      process.exit(2);
    }
  } catch (e) {
    console.log(`::error title=notify::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
