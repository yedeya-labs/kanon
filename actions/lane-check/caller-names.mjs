// The caller names and job ids the merge gate reads, beyond the Merger's own (kanon#728).
//
// GitHub reports a called lane's checks under its caller's `name:` and its calling job's id
// (`<job id> / <lane job>`), and `merge-gate.mjs` tells three more callers' checks from the
// rest by them: the review lane's caller (`SELF_CHECKS`, never waited on), and the
// implement-revise and merge-reconcile callers' `filter` jobs, which race the Merger on the
// same review event (`REVIEW_EVENT_CHECKS`). Under another name or job id the gate waits on
// them. The Merger's own caller name is the lane's `# CALLER NAME:` line, which lane-check has
// always failed; these three are read from the gate's own constants in
// `scripts/lib/protocol-spellings.mjs`, so lane-check and the gate can't disagree.
//
// A WARNING FOR ONE RELEASE, THEN A FAILURE. Adopters on an earlier release's caller names
// (the old spellings the gate still reads, or names of their own) get the release that
// introduces this check to rename them. `FAILS_FROM` is the one switch: from that Kanon version
// on, lane-check runs at it (the version in its own tree's `package.json`), and each finding
// is a failure. `docs/lanes.md` ("Four callers have fixed names") names the same version.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IMPLEMENT_REVISE_CALLER,
  LEGACY,
  MERGE_RECONCILE_CALLER,
  REVIEW_CALLER,
  REVIEW_EVENT_CHECKS,
} from '../../scripts/lib/protocol-spellings.mjs';

/** The first Kanon release in which a wrong name or job id fails lane-check, not warns. */
export const FAILS_FROM = '0.41.0';

/** The calling job's id the gate reads for a racer, from its `<job id> / filter` check. @param {string} workflow */
const jobOf = (workflow) => {
  const racer = REVIEW_EVENT_CHECKS.find((c) => c.workflow === workflow);
  if (!racer) throw new Error(`no review-event check for ${workflow} in protocol-spellings.mjs`);
  return /** @type {string} */ (racer.job.split(' / ')[0]);
};

/**
 * Per lane, the caller's fixed name, and the calling job's fixed id where the gate reads one.
 * The review caller's job id is read by nothing, so it is free.
 * @type {Readonly<Record<string, { name: string, job?: string }>>}
 */
export const FIXED_CALLERS = Object.freeze({
  'agent-review': { name: REVIEW_CALLER },
  'agent-implement-revise': { name: IMPLEMENT_REVISE_CALLER, job: jobOf(IMPLEMENT_REVISE_CALLER) },
  'agent-merge-reconcile': { name: MERGE_RECONCILE_CALLER, job: jobOf(MERGE_RECONCILE_CALLER) },
});

/** The old caller names the gate still reads, from before #53. */
const LEGACY_NAMES = new Set([...LEGACY.selfChecks, ...LEGACY.reviewEventChecks.map((c) => c.workflow)]);

/** `a.b.c` as numbers, or `null`. @param {string} v */
const semver = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * Whether the Kanon `version` fails these findings: at or after `FAILS_FROM`. An unreadable
 * version warns, as the release that introduced the check does.
 * @param {string} version @param {string} [from]
 */
export const failsAt = (version, from = FAILS_FROM) => {
  const v = semver(version);
  const f = /** @type {number[]} */ (semver(from));
  if (!v) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((v[i] ?? 0) !== (f[i] ?? 0)) return (v[i] ?? 0) > (f[i] ?? 0);
  }
  return true;
};

/** The version of the Kanon tree at `root`, from its `package.json`, or `''`. @param {string} root */
export const kanonVersion = (root) => {
  try { return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? ''); } catch { return ''; }
};

/**
 * What lane-check says about one caller of `lane`: nothing when its name and job id are the
 * fixed ones, or the lane has none; otherwise one finding each, `error` from `FAILS_FROM` on and
 * `warning` before it.
 * @param {string} lane the lane's file name without `.yml`
 * @param {string} name the caller's `name:`
 * @param {string | null} jobId the calling job's id, or `null` when there isn't exactly one job
 * @param {string} version the Kanon version lane-check runs at
 * @returns {Array<{ level: 'warning' | 'error', message: string }>}
 */
export const callerNameFindings = (lane, name, jobId, version) => {
  const want = FIXED_CALLERS[lane];
  if (!want) return [];
  const level = failsAt(version) ? 'error' : 'warning';
  const when = level === 'error'
    ? `since Kanon ${FAILS_FROM} this fails`
    : `this is a warning until Kanon ${FAILS_FROM}, and a failure from it`;
  /** @type {Array<{ level: 'warning' | 'error', message: string }>} */
  const found = [];
  if (name !== want.name) {
    const old = LEGACY_NAMES.has(name) ? ' (an earlier release\'s spelling)' : '';
    found.push({ level, message: `its name must be \`${want.name}\`, not \`${name}\`${old}: GitHub reports the Kanon lane ${lane}'s checks under its caller's name, and the Merger tells them from the rest by it, so under another name it waits on them. Rename it with \`name: ${want.name}\`; ${when} (docs/lanes.md, "Four callers have fixed names")` });
  }
  if (want.job && jobId !== null && jobId !== want.job) {
    found.push({ level, message: `its job must have the id \`${want.job}\`, not \`${jobId}\`: GitHub reports the Kanon lane ${lane}'s checks as \`${want.job} / <job>\`, and the Merger tells them from the rest by it, so under another id it waits on them. Rename the job to \`${want.job}:\`; ${when} (docs/lanes.md, "Four callers have fixed names")` });
  }
  return found;
};
