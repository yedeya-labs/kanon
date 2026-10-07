#!/usr/bin/env node
// Masks the aggregate function's URL, and the account id inside the invoker role's ARN, before
// any other step of the telemetry Explorer's `aggregate` job names them (kanon#433).
//
// A repository variable is not masked, and a run log of a public repository is public. The
// role's ARN is a secret (the Owner's decision on kanon#471), which GitHub masks whole, but not
// the account id inside it on its own. So the job's second step registers the URL and the
// account id as masks (and the ARN again, which costs nothing): from then on the read step's
// `env:` and anything a later step prints show `***`. This step's own `env:` is printed before
// it runs, so the URL appears in its header, once; the ARN, a secret, shows `***` there too.
//
//   node "$KANON/scripts/aggregate-mask.mjs"
//   env: URL (the variable KANON_AGGREGATE_URL), ROLE (the secret KANON_AGGREGATE_ROLE)
//
// `node:` built-ins only, like every script under scripts/ (`K-SELF-8`).

import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * The values to mask: each variable, trimmed, and the account id inside an IAM ARN. Never an
 * empty value, which would mask nothing useful and is refused by the runner.
 * @param {{ URL?: string, ROLE?: string }} env
 * @returns {string[]}
 */
export function masksOf(env) {
  const out = [];
  for (const v of [env.URL, env.ROLE]) {
    const t = String(v ?? '').trim();
    if (t) out.push(t);
  }
  const account = /^arn:aws[a-z-]*:iam::(\d{12}):/.exec(String(env.ROLE ?? '').trim())?.[1];
  if (account) out.push(account);
  return [...new Set(out)];
}

/* c8 ignore start */
if (isCliEntry(import.meta.url)) {
  for (const m of masksOf(process.env)) process.stdout.write(`::add-mask::${m}\n`);
  process.stdout.write('Masked the aggregate function\'s URL and the invoker role.\n');
}
/* c8 ignore stop */
