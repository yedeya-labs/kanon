// Which of the adopter's workflows runs a Kanon lane (kanon#726): the lane's CALLER.
//
// WHY. A lane is a reusable workflow; its runs are recorded under the workflow that calls it,
// and `gh workflow run` dispatches that caller. The library used to address a lane's runs by the
// lane's own file name (`agent-review.yml`), which is the caller's name only when the caller
// sits at its lane's file name (`K-LAYOUT-18`). A caller that lives elsewhere, under a
// `caller.misplaced` waiver, or in a repository that hosts the lanes, where `agent-<lane>.yml`
// is the lane itself, had no runs to find: the re-delivery evidence read "none" and churned
// (bounded by its caps), and the Merger's re-review dispatch failed.
//
// HOW IT FINDS IT, the way `kanon init` and `kanon doctor` do, over the default branch:
//   1. the file at the lane's own name, when it calls the lane;
//   2. a file the adoption record's `caller.misplaced` waiver names, when it calls the lane;
//   3. any workflow that calls it, the first by name, when nothing above did.
// A file 1 or 2 finds that only another workflow calls is lifted to the workflow above it: doctor
// waives the file whose job calls the lane, which in a nested layout is the inner one.
// "Calls" is a job whose `uses:` is the lane at a Kanon ref, or a local reusable workflow
// (`./.github/workflows/x.yml`) that calls it, at any depth. A file only another workflow calls
// (`on: workflow_call` and nothing else) has no runs of its own, so step 3 skips it and finds the
// workflow above it.
//
// NOTHING FOUND, OR NOTHING READABLE, IS TODAY'S BEHAVIOUR: the lane's own file name, and the
// reason logged. Every site's caps and fail-closed reads stay what they were, so an unreadable
// default branch can cost a bounded spurious re-delivery, never skip a needed one silently.
//
// One read per repository per process: the workflows and the adoption record in one GraphQL
// query against the default branch (`HEAD:`), memoised on the `json` seam that made it.

import { kanonCall, readWaivers } from './waivers.mjs';
import { parseYaml } from '../../cli/workflow-yaml.mjs';

/** Where workflows live, and the record whose waivers name a misplaced caller. */
const WORKFLOWS = '.github/workflows/';
const RECORD = 'docs/qa/adoption.md';

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `agent-review.yml`, `agent-review` and `.github/workflows/agent-review.yml` → `agent-review`. @param {string} lane */
const laneName = (lane) => lane.replace(/^.*\//, '').replace(/\.ya?ml$/, '');

/**
 * @typedef {{ files: Map<string, string>, record: string | null }} Snapshot
 *   `files`: each workflow's text by its file name (`review.yml`); `record`: the adoption record
 * @typedef {{ file: string, how: 'own' | 'waiver' | 'calls' | 'fallback', reason: string | null }} Caller
 *   `file`: the workflow file name to list runs of and dispatch; `how`: which rule found it;
 *   `reason`: why it fell back, or what else called the lane, for the log
 */

/**
 * Who `uses:` what, per file: the Kanon lanes a file's jobs call directly, and the local reusable
 * workflows they call. A file that doesn't parse calls nothing.
 * @param {Map<string, string>} files
 */
const callGraph = (files) => {
  /** @type {Map<string, { lanes: Set<string>, local: Set<string>, reusableOnly: boolean }>} */
  const out = new Map();
  for (const [name, text] of files) {
    let wf;
    try {
      wf = parseYaml(text);
    } catch {
      continue;
    }
    if (!isMap(wf)) continue;
    const lanes = new Set();
    const local = new Set();
    for (const job of Object.values(isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(job) || typeof job.uses !== 'string') continue;
      const call = kanonCall(job.uses);
      if (call) lanes.add(call.workflow);
      const m = /^\.\/\.github\/workflows\/([^/@\s]+\.ya?ml)$/.exec(job.uses.trim());
      if (m) local.add(/** @type {string} */ (m[1]));
    }
    const on = wf.on;
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : isMap(on) ? Object.keys(on) : [];
    out.set(name, { lanes, local, reusableOnly: triggers.length > 0 && triggers.every((t) => t === 'workflow_call') });
  }
  return out;
};

/**
 * Whether a file calls a lane `wanted` accepts, directly or through the local reusable workflows
 * it calls, at any depth (a cycle calls nothing more).
 * @param {ReturnType<typeof callGraph>} graph @param {(lane: string) => boolean} wanted
 * @returns {(file: string) => boolean}
 */
const callsLane = (graph, wanted) => {
  /** @type {(file: string, seen: Set<string>) => boolean} */
  const go = (file, seen) => {
    if (seen.has(file)) return false;
    seen.add(file);
    const node = graph.get(file);
    return Boolean(node && ([...node.lanes].some(wanted) || [...node.local].some((f) => go(f, seen))));
  };
  return (file) => go(file, new Set());
};

/** The files that call per `calls`, without those only another workflow calls, by name. @param {ReturnType<typeof callGraph>} graph @param {(file: string) => boolean} calls */
const topCallers = (graph, calls) => [...graph.keys()].filter((f) => !graph.get(f)?.reusableOnly && calls(f)).sort();

/**
 * The workflows whose runs hold `file`'s: `file` itself, unless only another workflow calls it
 * (`on: workflow_call` alone), which has no runs and can't be dispatched; then each top-level
 * workflow that reaches it through local reusable workflows, by name. Doctor files
 * `caller.misplaced` on the file whose job calls the lane, so in a nested layout a waiver names
 * the inner file, and this lifts it to the workflow above.
 * @param {ReturnType<typeof callGraph>} graph @param {string} file
 * @returns {string[]}
 */
const runHolders = (graph, file) => {
  if (!graph.get(file)?.reusableOnly) return [file];
  /** @type {(from: string, seen: Set<string>) => boolean} */
  const reaches = (from, seen) => {
    if (seen.has(from)) return false;
    seen.add(from);
    const local = graph.get(from)?.local ?? new Set();
    return local.has(file) || [...local].some((f) => reaches(f, seen));
  };
  return topCallers(graph, (f) => reaches(f, new Set()));
};

/**
 * Lane → caller, from a snapshot of the default branch. Pure.
 * @param {string} lane the lane, as `agent-review` or `agent-review.yml`
 * @param {Snapshot} snapshot
 * @returns {Caller}
 */
export function resolveCaller(lane, { files, record }) {
  const name = laneName(lane);
  const own = `${name}.yml`;
  const graph = callGraph(files);
  const calls = callsLane(graph, (l) => l === name);
  /** A rule's candidate, lifted to the workflow that holds its runs; null when nothing does. @param {string} file @param {'own' | 'waiver'} how @returns {Caller | null} */
  const candidate = (file, how) => {
    if (!calls(file)) return null;
    const [first, ...rest] = runHolders(graph, file);
    if (!first) return null;
    return { file: first, how, reason: rest.length ? `${[first, ...rest].join(', ')} all call ${file}, which calls the lane ${name}; using ${first}, the first by name` : null };
  };
  const byOwn = candidate(own, 'own');
  if (byOwn) return byOwn;
  const waived = readWaivers(record).waivers
    .filter((w) => w.id === 'caller.misplaced' && w.subject.startsWith(WORKFLOWS))
    .map((w) => w.subject.slice(WORKFLOWS.length));
  for (const f of waived) {
    const byWaiver = candidate(f, 'waiver');
    if (byWaiver) return byWaiver;
  }
  const found = topCallers(graph, calls);
  const first = found[0];
  if (first) {
    return { file: first, how: 'calls', reason: found.length > 1 ? `${found.join(', ')} all call the lane ${name}; using ${first}, the first by name (a \`caller.misplaced\` waiver names the one to use)` : null };
  }
  return { file: own, how: 'fallback', reason: `no workflow on the default branch calls the lane ${name}, so its runs are looked for under ${own}` };
}

/**
 * Every lane caller among `files`: each workflow, other than one only another workflow calls,
 * that calls a Kanon lane (`agent-*`, the spine excepted), directly or through a local reusable
 * workflow. Sorted by name. Pure.
 * @param {Map<string, string>} files each workflow's text by its file name
 * @returns {string[]}
 */
export function laneCallersIn(files) {
  const graph = callGraph(files);
  return topCallers(graph, callsLane(graph, (l) => l.startsWith('agent-') && l !== 'agent-lane'));
}

/**
 * The default branch's workflows and adoption record, in one GraphQL read. Throws when it can't
 * be read; `laneCaller` turns that into the fallback.
 * @param {{ repo: string, json: (args: string[]) => any }} io
 * @returns {Snapshot}
 */
export function readSnapshot({ repo, json }) {
  const [owner, name] = String(repo ?? '').split('/');
  if (!owner || !name) throw new Error(`no repository to read (${JSON.stringify(repo)})`);
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {`
    + ` workflows: object(expression: "HEAD:${WORKFLOWS.slice(0, -1)}") { ... on Tree { entries { name type object { ... on Blob { text } } } } }`
    + ` record: object(expression: "HEAD:${RECORD}") { ... on Blob { text } } } }`;
  const res = json(['api', 'graphql', '-f', `query=${query}`]);
  const repository = res?.data?.repository;
  const entries = repository?.workflows?.entries;
  if (!Array.isArray(entries)) throw new Error('the default branch\'s .github/workflows could not be read');
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const e of entries) {
    if (e?.type === 'blob' && /\.ya?ml$/.test(String(e.name)) && typeof e.object?.text === 'string') files.set(String(e.name), e.object.text);
  }
  const record = repository?.record?.text;
  return { files, record: typeof record === 'string' ? record : null };
}

/** One snapshot per `json` seam and repository, so a tick reads the default branch once. */
const memo = new WeakMap();

/**
 * The caller of `lane` in `repo`: the workflow file to list the lane's runs of and to dispatch.
 * Never throws: an unreadable default branch falls back to the lane's own file name, with the
 * reason logged, which is the behaviour before kanon#726.
 * @param {string} lane the lane, as `agent-review` or `agent-review.yml`
 * @param {{ repo: string, json: (args: string[]) => any, log?: (msg: string) => void }} io
 * @returns {Caller}
 */
export function laneCaller(lane, { repo, json, log = (m) => console.warn(m) }) {
  /** @type {Map<string, { snapshot: Snapshot | null, error: string | null, said: Set<string> }>} */
  let byRepo = memo.get(json);
  if (!byRepo) memo.set(json, (byRepo = new Map()));
  let entry = byRepo.get(repo);
  if (!entry) {
    try {
      entry = { snapshot: readSnapshot({ repo, json }), error: null, said: new Set() };
    } catch (e) {
      entry = { snapshot: null, error: String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0] ?? '', said: new Set() };
    }
    byRepo.set(repo, entry);
  }
  const own = `${laneName(lane)}.yml`;
  /** @type {Caller} */
  const caller = entry.snapshot
    ? resolveCaller(lane, entry.snapshot)
    : { file: own, how: 'fallback', reason: `could not read the default branch's workflows (${entry.error}), so the lane ${laneName(lane)}'s runs are looked for under ${own}` };
  if (caller.reason && !entry.said.has(own)) {
    entry.said.add(own);
    log(`lane caller: ${caller.reason}`);
  }
  return caller;
}

/** `laneCaller`'s file name alone. @param {string} lane @param {{ repo: string, json: (args: string[]) => any, log?: (msg: string) => void }} io */
export const laneCallerFile = (lane, io) => laneCaller(lane, io).file;
