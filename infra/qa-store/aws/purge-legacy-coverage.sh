#!/usr/bin/env bash
#
# One-time maintenance sweep (audit #9 §4): delete the stale `signal sweep (dynamic):`
# COVERAGE keys from the L1 index (DynamoDB, RA-84).
#
# Background: the Explorer's store-writer once keyed COVERAGE rows as
#   "signal sweep (dynamic): /admin/training-sites/[id]"
# but now writes the bare route as the key ("/admin/training-sites/[id]"). The old
# keys were never cleaned up, so they sit frozen at their last pre-switch status
# (e.g. `failed` @ 77bdff7, 07-08) and read as permanent false reds for any query
# that doesn't know the legacy prefix — shadowing the real, green key. Three audits
# have carried this; this script is the "get it done" arm of the proposal.
#
# SAFE BY DEFAULT: prints what it would delete and exits 0 (dry run). Pass --apply
# (or APPLY=1) to actually delete. Idempotent — re-running after a successful apply
# finds nothing and is a clean no-op, so it can also serve as a "still clean?" check.
#
# Runs against the SAME store the pipeline uses (env: QA_DYNAMO_TABLE, QA_AWS_REGION),
# so run it where those resolve to the store — locally with the store's credentials, or
# through Kanon's maintenance workflow (`qa-store-aws-maintenance.yml`), which has the store's role.
#
# Usage:  scripts/qa/purge-legacy-coverage.sh [--apply]
set -euo pipefail

region="${QA_AWS_REGION:?QA_AWS_REGION unset}"
table="${QA_DYNAMO_TABLE:?QA_DYNAMO_TABLE unset}"
prefix="signal sweep (dynamic): "

apply=""
[ "${1:-}" = "--apply" ] && apply=1
[ "${APPLY:-}" = "1" ] && apply=1

# Query the COVERAGE partition for keys that begin with the legacy prefix. begins_with
# on the sort key is part of the key condition, so this is a targeted query, not a scan.
keys="$(aws dynamodb query \
  --region "$region" --table-name "$table" \
  --key-condition-expression 'pk = :p AND begins_with(sk, :pfx)' \
  --expression-attribute-values "{\":p\":{\"S\":\"COVERAGE\"},\":pfx\":{\"S\":\"$prefix\"}}" \
  --query 'Items[].sk.S' --output text)"

if [ -z "$keys" ]; then
  echo "purge-legacy-coverage: no '$prefix' keys under COVERAGE — already clean."
  exit 0
fi

# --output text tab-separates; iterate one key per line.
count=0
while IFS= read -r sk; do
  [ -n "$sk" ] || continue
  count=$((count + 1))
  if [ -n "$apply" ]; then
    aws dynamodb delete-item --region "$region" --table-name "$table" \
      --key "$(jq -nc --arg sk "$sk" '{pk:{S:"COVERAGE"}, sk:{S:$sk}}')" >/dev/null
    echo "deleted: COVERAGE / $sk"
  else
    echo "[dry-run] would delete: COVERAGE / $sk"
  fi
done < <(printf '%s\n' "$keys" | tr '\t' '\n')

if [ -n "$apply" ]; then
  echo "purge-legacy-coverage: deleted $count legacy COVERAGE key(s)."
else
  echo "purge-legacy-coverage: $count legacy COVERAGE key(s) found. Re-run with --apply to delete."
fi
