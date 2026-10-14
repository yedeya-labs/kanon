// Whether a repository has consented to Kanon's HOSTED telemetry store, read from its default
// branch, for the two reading lanes' gates (plan 0008 §3.3, step J5; ADR 0007, `K-OBS-18`).
//
// THE COLLECTOR'S CALLER IS THE CONSENT, AND IT NAMES THE STORE. A workflow on the default branch
// that calls Kanon's collector is the repository's yes. That caller also says which store it
// sends to: Kanon's hosted one when it passes none of `url:`, `audience:` and `writer-role:`, or
// another store when it passes any of them. From vM, `audience:` names a store of the adopter's
// own. `url:` or `writer-role:` without it is a caller written before vM: every such caller
// passes them, a hosted adopter's included, so its store is ambiguous, and it is refused with
// both ways out (as doctor's `telemetry.legacy-inputs` gives them), never told it is self-hosted.
// A repository whose caller names another store never opted in to
// the hosted service, so a reading lane must not send a token minted for the hosted audience on
// its behalf, which would name the repository to Kanon's operator. Such a lane is told to name
// the adopter's own store with its own two variables, and refuses until it does: never a quiet
// fallback to the hosted store (the Owner's decision on #842, refuse rather than redirect).
//
// `node:` built-ins only, and the snapshot `lane-caller.mjs` reads (`K-SELF-8`).

import { kanonCall } from '../../cli/doctor.mjs';
import { parseYaml } from '../../cli/workflow-yaml.mjs';
import { resolveCaller } from './lane-caller.mjs';

/** Kanon's collector, as `kanonCall` names a reusable workflow. */
export const COLLECTOR_LANE = 'telemetry-collect';
/** The collector's inputs that name a store other than Kanon's hosted one. */
export const OWN_STORE_INPUTS = /** @type {const} */ (['url', 'audience', 'writer-role']);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The collector's own-store inputs that any job calling Kanon's collector passes, in any
 * workflow of the snapshot, a local reusable one included: the inner file is where the call and
 * its `with:` are. Sorted, each once.
 * @param {Map<string, string>} files each workflow's text by its file name
 * @returns {string[]}
 */
export function ownStoreInputs(files) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const text of files.values()) {
    let wf;
    try {
      wf = parseYaml(text);
    } catch {
      continue;
    }
    for (const job of Object.values(isMap(wf) && isMap(wf.jobs) ? wf.jobs : {})) {
      if (!isMap(job) || kanonCall(job.uses)?.workflow !== COLLECTOR_LANE || !isMap(job.with)) continue;
      for (const k of OWN_STORE_INPUTS) if (k in job.with) found.add(k);
    }
  }
  return [...found].sort();
}

/**
 * The consent a snapshot of the default branch shows: whether a workflow calls Kanon's collector,
 * which, and the own-store inputs its callers pass. Pure.
 * @param {import('./lane-caller.mjs').Snapshot} snapshot
 * @returns {{ calls: boolean, caller: string | null, ownStore: string[] }}
 */
export function collectorConsent(snapshot) {
  const caller = resolveCaller(COLLECTOR_LANE, snapshot);
  if (caller.how === 'fallback') return { calls: false, caller: null, ownStore: [] };
  return { calls: true, caller: caller.file, ownStore: ownStoreInputs(snapshot.files) };
}

/**
 * Why a lane about to read the HOSTED store must not, or null: the collector's caller names a
 * store of its own. `variables` are the lane's two variables that name the adopter's store.
 * @param {{ ownStore: string[], caller: string | null }} consent
 * @param {{ url: string, audience: string }} variables
 */
export function hostedRefusal(consent, variables) {
  if (!consent.ownStore.length) return null;
  const file = consent.caller ?? "the collector's caller";
  // A caller written before vM: its store may be Kanon's or the adopter's, so both ways out.
  if (!consent.ownStore.includes('audience')) {
    return `${file} still passes ${consent.ownStore.map((k) => `\`${k}:\``).join(' and ')} to Kanon's collector without \`audience:\`, as every caller written before the token path does, so which store it sends to can't be told, and this lane reads none: for Kanon's hosted store, write the new caller with \`kanon init --telemetry\` (it drops both lines); for a store of your own, add \`audience:\` to the caller and set the repository variables ${variables.url} and ${variables.audience} to that store's token URL and audience (docs/telemetry.md, "Collect the rows")`;
  }
  return `${consent.caller ?? 'the collector\'s caller'} sends this repository's rows to a store of its own (it passes ${consent.ownStore.map((k) => `\`${k}:\``).join(', ')} to Kanon's collector), so this lane never reads Kanon's hosted store for it: set the repository variables ${variables.url} and ${variables.audience} to that store's token URL and audience (docs/telemetry.md)`;
}
