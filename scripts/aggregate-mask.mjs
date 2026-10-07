#!/usr/bin/env node
// Masks the aggregate function's URL and the invoker role before any other step of the
// telemetry Explorer's `aggregate` job names them (kanon#433).
//
// Repository variables are not masked, and a run log of a public repository is public. The
// role's ARN holds the AWS account id, which Kanon keeps out of the public tree. So the job's
// second step registers the URL, the ARN and the account id inside it as masks: from then on
// the credentials step's `role-to-assume:`, the read step's `env:` and anything a later step
// prints show `***`. This step's own `env:` is printed before it runs, so the two values appear
// in its header, once; nothing here can change that.
//
//   node "$KANON/scripts/aggregate-mask.mjs"
//   env: URL, ROLE (the repository variables KANON_AGGREGATE_URL and KANON_AGGREGATE_ROLE)
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
