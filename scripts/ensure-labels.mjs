#!/usr/bin/env node
// Create, before an agent runs, the labels its lane may apply and the repository lacks
// (plan 0005 §5.3, `K-WORK-12`). `actions/agent-run` calls this with the lane's `labels` input
// and the agent's own token, so the agent never meets a missing label mid-run, after the work
// is done.
//
//   node scripts/ensure-labels.mjs <label> [<label> ...]
//
// The repository is `REPO`, else `GITHUB_REPOSITORY`. Exits 1, having created nothing, when a
// missing name is outside the taxonomy; an unreadable label list or a failed create is a
// warning, and the lane goes on as it did before labels were created on first use.

import { execFileSync } from 'node:child_process';
import { isCliEntry } from './lib/cli-entry.mjs';
import { LabelError, ensureLabels } from './lib/labels.mjs';

/**
 * @param {string[]} names
 * @param {{ repo?: string, run?: (args: string[]) => string }} [io]
 * @returns {number} the exit code
 */
export function main(names, { repo = process.env.REPO || process.env.GITHUB_REPOSITORY, run = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  try {
    const created = ensureLabels(names, { repo, run });
    if (!created.length) console.log(`labels: nothing to create for ${names.length} label(s)`);
    return 0;
  } catch (err) {
    if (!(err instanceof LabelError)) throw err;
    console.log(`::error title=labels::${err.message}`);
    return 1;
  }
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean));
