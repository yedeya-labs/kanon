#!/usr/bin/env bash
#
# One operation of the QA store contract on Kanon's AWS store (plan 0004 §3.2, step P9). The
# action's credentials step has already assumed the store's role; this only picks the script.
# What each operation reads and writes in "$DIR" is the contract's (`actions/qa-store/qa-store.mjs`).
#
# Env: OPERATION, KIND, DIR, FROM, TO, QA_AWS_REGION, QA_DYNAMO_TABLE, QA_S3_BUCKET.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DIR:?DIR unset}"

case "${OPERATION:-}" in
  last-green) bash "$here/last-green.sh" ;;
  record-skip) bash "$here/record-skip.sh" ;;
  put) bash "$here/push-run.sh" "${KIND:?KIND unset}" "$DIR/report.json" ;;
  export) node "$here/export.mjs" ;;
  cost-rows) node "$here/cost-rows.mjs" ;;
  *)
    echo "::error title=qa-store::unknown operation '${OPERATION:-}' (want last-green, record-skip, put, export or cost-rows)"
    exit 2
    ;;
esac
