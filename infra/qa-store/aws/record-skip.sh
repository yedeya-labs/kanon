#!/usr/bin/env bash
#
# The contract's `record-skip` on Kanon's AWS store: a `RUN#explorer` row saying a commit was
# skipped, so bounded coverage doesn't read as full.
#
# MOVED FROM THE REFERENCE ADOPTER'S EXPLORER GATE (Kanon plan 0004 step P9, ADR 0009). The
# row is the one the gate wrote: no `failed` attribute, which keeps it out of `last-green`'s
# baseline filter, `skipped: true` and a `reason`. The commit, trigger, tier and reason come
# from `skip.json`, which Kanon's `qa-store` block writes and checks (a 40-hex commit); the gate
# wrote the same values as literals (`schedule`, `all`, `unchanged-commit`), which are now that
# block's defaults. NOT best-effort: a failed write fails the store job.
#
# Env: QA_DYNAMO_TABLE, QA_AWS_REGION, DIR.
set -euo pipefail

: "${QA_DYNAMO_TABLE:?QA_DYNAMO_TABLE unset}"
: "${QA_AWS_REGION:?QA_AWS_REGION unset}"
skip="${DIR:?DIR unset}/skip.json"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
item="$(jq -ce --arg ts "$ts" '
  if (.commit | type) == "string" and (.commit | test("^[0-9a-f]{40}$")) then {
    pk: {S: "RUN#explorer"}, sk: {S: $ts}, commit: {S: .commit},
    trigger: {S: (.trigger // "schedule")}, tier: {S: (.tier // "all")},
    skipped: {BOOL: true}, reason: {S: (.reason // "unchanged-commit")}
  } else error("skip.json has no 40-character commit") end' "$skip")"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "[dry-run] put-item: $item"
else
  aws dynamodb put-item --region "$QA_AWS_REGION" --table-name "$QA_DYNAMO_TABLE" --item "$item" >/dev/null
fi
echo "recorded the skip of $(jq -r .commit "$skip") at $ts"
