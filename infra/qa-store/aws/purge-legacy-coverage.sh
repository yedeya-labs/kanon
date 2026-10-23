#!/usr/bin/env bash
#
# One-time maintenance sweep (an Overseer audit): delete the stale `signal sweep (dynamic):`
# COVERAGE keys from the L1 index (DynamoDB, RA-84).
#
# Background: the Explorer's store-writer once keyed COVERAGE rows as
#   "signal sweep (dynamic): /admin/items/[id]"
# but now writes the bare route as the key ("/admin/items/[id]"). The old
# keys were never cleaned up, so they sit frozen at their last pre-switch status
# and read as permanent false reds for any query
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
# BOTH COVERAGE PARTITIONS (kanon#1346, `keys.mjs`): this repository's own, `COVERAGE#<repository
# id>`, and the unkeyed `COVERAGE` written before it, which the Owner's migration copies under the
# repository's key, legacy keys and all. The role may delete in those two only.
#
# Usage:  infra/qa-store/aws/purge-legacy-coverage.sh [--apply]
# Env:    QA_DYNAMO_TABLE, QA_AWS_REGION, GITHUB_REPOSITORY_ID (the runner's), APPLY
set -euo pipefail

region="${QA_AWS_REGION:?QA_AWS_REGION unset}"
table="${QA_DYNAMO_TABLE:?QA_DYNAMO_TABLE unset}"
prefix="signal sweep (dynamic): "
repo="${GITHUB_REPOSITORY_ID:-}"
if ! [[ "$repo" =~ ^[1-9][0-9]*$ ]]; then
  echo "purge-legacy-coverage: GITHUB_REPOSITORY_ID is '$repo', not a repository id, and the store keys every row by it (kanon#1346)" >&2
  exit 2
fi

apply=""
[ "${1:-}" = "--apply" ] && apply=1
[ "${APPLY:-}" = "1" ] && apply=1

count=0
for pk in "COVERAGE#$repo" "COVERAGE"; do
  # Query the partition for keys that begin with the legacy prefix. begins_with on the sort
  # key is part of the key condition, so this is a targeted query, not a scan.
  keys="$(aws dynamodb query \
    --region "$region" --table-name "$table" \
    --key-condition-expression 'pk = :p AND begins_with(sk, :pfx)' \
    --expression-attribute-values "$(jq -nc --arg p "$pk" --arg pfx "$prefix" '{":p":{S:$p},":pfx":{S:$pfx}}')" \
    --query 'Items[].sk.S' --output text)"
  # --output text tab-separates, and prints `None` for no match; iterate one key per line.
  while IFS= read -r sk; do
    [ -n "$sk" ] && [ "$sk" != None ] || continue
    count=$((count + 1))
    if [ -n "$apply" ]; then
      aws dynamodb delete-item --region "$region" --table-name "$table" \
        --key "$(jq -nc --arg p "$pk" --arg sk "$sk" '{pk:{S:$p}, sk:{S:$sk}}')" >/dev/null
      echo "deleted: $pk / $sk"
    else
      echo "[dry-run] would delete: $pk / $sk"
    fi
  done < <(printf '%s\n' "$keys" | tr '\t' '\n')
done

if [ "$count" = 0 ]; then
  echo "purge-legacy-coverage: no '$prefix' keys under COVERAGE#$repo or COVERAGE — already clean."
elif [ -n "$apply" ]; then
  echo "purge-legacy-coverage: deleted $count legacy COVERAGE key(s)."
else
  echo "purge-legacy-coverage: $count legacy COVERAGE key(s) found. Re-run with --apply to delete."
fi
