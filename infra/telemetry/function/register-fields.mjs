// The register table's fields (plan 0008 §5.2), and who may write or read which (§5.3). One home
// for them: `template.yaml` holds the same lists as IAM conditions, and
// `tests/unit/telemetry-store-template.test.ts` holds the template to these, so a field added
// here and not there, or there and not here, is red.
//
// THE OPERATOR'S FIELDS ARE THE CLI'S ALONE. `infra/telemetry/register.mjs`, run with the Owner's
// profile, writes them; the ingest function's role may not name one in any write, which IAM
// holds with `dynamodb:Attributes`, whatever the function's code does. So the function can't
// make itself an aggregate invoker, a page reader, give itself a label, raise its own quota, or
// clear a suspension's reason. It also can't REMOVE one, since a removed attribute is named in
// the request too: the tombstone of §7 is therefore written whole, with a `PutItem` of
// `TOMBSTONE_FIELDS`, which replaces the item, never with an `UpdateItem` that removes fields.
//
// `status` is the function's too (`active` at registration, `erased` on erasure), so IAM can't
// tell a suspension's `status` from the function's; that a suspended registration stays
// suspended is the function's conditional write to hold (plan 0008 J3).

/** Written by the operator's CLI only (§5.2, §5.3). */
export const OPERATOR_FIELDS = Object.freeze([
  'aggregate_invoker',
  'publish_own_figures_as',
  'page_reader',
  'quota_rows_per_day',
  'quota_requests_per_hour',
  'suspended_at',
  'suspended_reason',
  'first_review',
]);

/**
 * Every field the ingest function's role may write (§5.3): the registration's own fields, the key
 * item's, and the counters' (`n`, the count a conditional `ADD` reserves, and `expires_at`, §6).
 */
export const FUNCTION_FIELDS = Object.freeze([
  'pk',
  'repository_id',
  'repository_owner_id',
  'repository',
  'key',
  'status',
  'default_ref',
  'name_hashes',
  'registered_at',
  'registered_by_version',
  'last_seen_at',
  'erased_at',
  'rows_erased_at',
  'source',
  'n',
  'expires_at',
]);

/** What the ingest function's role may read with a `Scan`: the key items' `pk`, for `assertNoKey` (§3.4). */
export const INGEST_SCAN = Object.freeze(['pk']);

/** The aggregate function's `Scan` of the registrations (§3.6): no name, no owner id. */
export const AGGREGATE_SCAN = Object.freeze(['pk', 'key', 'status', 'publish_own_figures_as']);

/** The aggregate function's `GetItem` of the caller's registration (§3.6), for checks 8 and 9. */
export const AGGREGATE_GET = Object.freeze(['pk', 'key', 'status', 'repository_owner_id', 'default_ref', 'aggregate_invoker', 'page_reader']);

/** What an erased registration keeps, with no expiry (§7, Owner decision 5 of 2026-10-12). */
export const TOMBSTONE_FIELDS = Object.freeze(['pk', 'repository_id', 'repository_owner_id', 'status', 'erased_at', 'rows_erased_at']);

/** The codes a suspension may give (§5.2). */
export const SUSPENDED_REASONS = Object.freeze(['abuse', 'quota', 'owner-changed', 'request', 'other']);

/** The register table's name, in the same stack and account as the rows table (§5.1). */
export const REGISTER_TABLE = 'kanon-telemetry-register';
