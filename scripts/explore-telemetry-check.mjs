#!/usr/bin/env node
// The telemetry Explorer's gate (plan 0008 §2.1, §3.6, step J5): is there a store whose aggregate
// this repository may read, before any token is minted?
//
//   configured="$(node "$KANON/scripts/explore-telemetry-check.mjs")"
//   env: KANON_AGGREGATE_TOKEN_URL, KANON_TELEMETRY_AUDIENCE (a self-hosted store's `AggregateTokenUrl`
//        output and `Audience`, together, or neither for Kanon's hosted store), GITHUB_REPOSITORY,
//        and `gh`'s token (the workflow token: it reads the default branch's workflows)
//   prints: `true` or `false` on stdout, and nothing else there; anything else goes to stderr,
//        since the gate runs it inside `$(…)`, which would swallow a workflow command on stdout
//
// `true`: the self-hosted store the two variables name, or Kanon's hosted one for a repository
// whose collector's caller sends to it. `false`, green: the hosted store's URL isn't published in
// this release, or no workflow on the default branch calls Kanon's collector, so the repository
// isn't registered and no token is sent to name it. Exit 1, naming the problem: one variable
// without the other or of the wrong shape, a default branch that can't be read, or a collector's
// caller that names another store while the two variables are unset: with `audience:`, a store of
// its own, named by the variables to set; with only `url:` or `writer-role:`, a caller written
// before vM, given both ways out (`K-OBS-18`; the Owner's decision on #842: refused, never
// redirected to the hosted store).
//
// `node:` built-ins, and `gh` for the default branch (`K-SELF-8`).

import { execFileSync } from 'node:child_process';

import { aggregateStore, TOKEN_VARIABLES } from './aggregate-read.mjs';
import { isCliEntry } from './lib/cli-entry.mjs';
import { readSnapshot } from './lib/lane-caller.mjs';
import { collectorConsent, hostedRefusal } from './lib/telemetry-consent.mjs';

/**
 * The gate's answer: `true`, `false` with a note, or a refusal.
 * @param {Record<string, string | undefined>} env
 * @param {{ json: (args: string[]) => any, hostedUrl?: string }} io
 * @returns {{ configured: 'true' | 'false', note?: string } | { error: string }}
 */
export function exploreCheck(env, { json, hostedUrl }) {
  const store = hostedUrl === undefined ? aggregateStore(env) : aggregateStore(env, hostedUrl);
  if (!store.ok && store.unpublished) return { configured: 'false', note: store.why };
  if (!store.ok) return { error: store.why };
  // A self-hosted store, named by the lane's own variables, is the adopter's own to read.
  if (!store.hosted) return { configured: 'true' };
  /** @type {import('./lib/lane-caller.mjs').Snapshot} */
  let snapshot;
  try {
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('GITHUB_REPOSITORY must be set');
    snapshot = readSnapshot({ repo, json });
  } catch (e) {
    return { error: `whether this repository sends telemetry to Kanon's hosted store could not be read (${String(e instanceof Error ? e.message : e).split('\n')[0]?.slice(0, 200)})` };
  }
  const consent = collectorConsent(snapshot);
  if (!consent.calls) return { configured: 'false', note: "no workflow on the default branch calls Kanon's telemetry collector, so this repository isn't registered with the hosted store, and no token is sent to it" };
  const refused = hostedRefusal(consent, TOKEN_VARIABLES);
  if (refused) return { error: refused };
  return { configured: 'true' };
}

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  const json = (/** @type {string[]} */ args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  const r = exploreCheck(process.env, { json });
  if ('error' in r) {
    process.stderr.write(`::error title=explore-telemetry::${r.error}.\n`);
    process.exit(1);
  }
  if (r.note) process.stderr.write(`explore-telemetry: ${r.note}\n`);
  process.stdout.write(`${r.configured}\n`);
}
/* c8 ignore stop */
