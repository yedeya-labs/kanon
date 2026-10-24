// The store's keys carry the repository (kanon#1346, the Owner's decision of 2026-10-23).
//
// EVERY PARTITION IS `<partition>#<repository id>`: `RUN#explorer#<id>`, `RUN#audit#<id>`,
// `COVERAGE#<id>`, `AREAS#<id>` and `COST#<agent>#<id>`, and every raw report is under
// `repository/<id>/`. So repositories that share one store read only their own rows. The bash
// scripts (`push-run.sh`, `record-skip.sh`, `last-green.sh`, `purge-legacy-coverage.sh`) build the
// same keys inline; the unit test holds them to these.
//
// THE REPOSITORY ID, NOT ITS NAME. GitHub's numeric id survives a rename and a transfer, so a
// renamed repository keeps its history, and a repository deleted and created again under the same
// name starts clean. The runner sets `GITHUB_REPOSITORY_ID` in every job, to the repository whose
// workflow runs: the caller's, in a called workflow. It is also the id GitHub's immutable OIDC
// subject carries, so a role could one day hold a session to its own keys (`docs/qa-store.md`).
//
// THE UNKEYED ROWS ARE READ ONLY WHILE A REPOSITORY HAS NONE OF ITS OWN. A store written before
// this holds `RUN#explorer`, `COVERAGE` and the rest with no repository. Until the Owner migrates
// them (`migrate-to-repository-keys.mjs`), a reader that finds this repository's partition empty
// reads the unkeyed one instead, as every reader did before. The first row the repository writes
// to a partition ends that partition's fallback; the migration copies the unkeyed history under
// the repository's key, so nothing is lost once it has run.
//
// A MIGRATED UNKEYED ROW IS MARKED, NEVER DELETED, AND NO FALLBACK READS IT (kanon#1377, the Owner's
// decision of 2026-10-23). The migration sets `migratedTo` (the repository id it was copied to) on
// every unkeyed row it copies, and tags every unkeyed raw report `kanon-migrated-to`. Each reader's
// fallback filters the unkeyed partition server-side with `attribute_not_exists(migratedTo)`, so a
// repository added to the store after the migration never reads another repository's history as
// its own, while a store not yet migrated still reads its history through the fallback. A raw
// report is reached only through its row (the export copies `<kind>/<ts>.json` for each unkeyed
// row it read), so a marked row's report is never read either, and no reader needs its tag: the
// tag is the operator's record, and the role needs no tagging grant.

/** The partitions written before kanon#1346, with no repository in their key. */
export const UNKEYED_PARTITIONS = /** @type {const} */ (['RUN#explorer', 'RUN#audit', 'COVERAGE', 'AREAS']);

/** The attribute the migration sets on an unkeyed row it copied: the repository id it went to. */
export const MIGRATED_TO = 'migratedTo';

/** The filter every fallback read of an unkeyed partition applies: rows the migration hasn't marked. */
export const UNMARKED = `attribute_not_exists(${MIGRATED_TO})`;

/** The S3 tag the migration puts on an unkeyed raw report it copied: the repository id it went to. */
export const MIGRATED_TAG = 'kanon-migrated-to';

/** Where a repository's raw reports live in the bucket, ahead of `<kind>/<ts>.json`. */
export const REPORTS_ROOT = 'repository';

/**
 * The repository id the store keys rows by, from the runner's `GITHUB_REPOSITORY_ID`. Throws
 * when it is unset or not a positive integer: a row keyed by nothing would be read by everyone.
 * @param {Record<string, string|undefined>} [env]
 */
export function repositoryId(env = process.env) {
  const id = env.GITHUB_REPOSITORY_ID ?? '';
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new Error(`GITHUB_REPOSITORY_ID is '${id}', not a repository id, and the store keys every row by it (kanon#1346)`);
  }
  return id;
}

/**
 * A partition's key for one repository.
 * @param {string} partition `RUN#explorer`, `COVERAGE`, `COST#<agent>`, ...
 * @param {string} id
 */
export const keyed = (partition, id) => `${partition}#${id}`;

/**
 * A raw report's object key for one repository.
 * @param {string} key `<kind>/<ts>.json`, or `telemetry/<agent>/<ts>.json`
 * @param {string} id
 */
export const reportKey = (key, id) => `${REPORTS_ROOT}/${id}/${key}`;

/**
 * Whether a partition key is one written before kanon#1346: an unkeyed partition, or `COST#<agent>`
 * with no repository after the agent.
 * @param {string} pk
 */
export const isUnkeyed = (pk) => /** @type {readonly string[]} */ (UNKEYED_PARTITIONS).includes(pk) || /^COST#[^#]+$/.test(pk);
