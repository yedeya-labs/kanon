#!/usr/bin/env bash
#
# The contract's `last-green` on Kanon's AWS store: the commit of the newest GREEN, full-tier
# Explorer sweep, written to "$DIR/last-green", or nothing.
#
# MOVED FROM THE REFERENCE ADOPTER'S EXPLORER GATE (Kanon plan 0004 step P9, ADR 0009). The
# gate's two queries, its zero-match diagnosis and its tripwire are here, unchanged; what the
# gate did with the answer (compare it with HEAD, skip, and record the skip) stays in the
# Explorer's lane, and the skip's write is `record-skip.sh`. The gate's three outcomes map onto
# the contract's: a baseline is a commit in the file; a quiet `ok` with no baseline is an empty
# file; and `degraded` (the baseline could not be read, or the filter has drifted) exits 1,
# which Kanon's `qa-store` block reports as `state: degraded`, and the lane sweeps. All of them
# fail OPEN, as the gate did: a store hiccup must run the sweep, never skip it.
#
# THIS REPOSITORY'S SWEEPS ONLY (kanon#1346, `keys.mjs`): the partition is
# `RUN#explorer#<repository id>`, so another repository on the same store never supplies the
# baseline. WHILE THAT PARTITION HOLDS NO SWEEP (nothing at all, or only a skip marker the gate
# wrote against an unkeyed baseline), the gate reads the unkeyed `RUN#explorer` written before
# kanon#1346 instead, with the same queries, as it did then. The repository's first sweep ends
# that, and the Owner's migration copies the unkeyed history under the repository's key.
# THE FALLBACK SKIPS WHAT THE MIGRATION MARKED (kanon#1377, `keys.mjs`): both reads of the unkeyed
# partition add `attribute_not_exists(migratedTo)` to their server-side filter, so once a store's
# history is migrated to one repository, a repository added later finds no baseline there and
# sweeps; a store not yet migrated reads its unkeyed history as before.
#
# Env: QA_DYNAMO_TABLE, QA_AWS_REGION, DIR, GITHUB_REPOSITORY_ID (the runner's).
set -euo pipefail

: "${QA_DYNAMO_TABLE:?QA_DYNAMO_TABLE unset}"
: "${QA_AWS_REGION:?QA_AWS_REGION unset}"
out="${DIR:?DIR unset}/last-green"
: > "$out"

run_sweep() { # $1 = degraded|ok, $2 = message
  if [ "$1" = degraded ]; then
    echo "::warning title=Explorer change-gate degraded::$2"
    exit 1
  fi
  echo "$2"
  exit 0
}

repo="${GITHUB_REPOSITORY_ID:-}"
if ! [[ "$repo" =~ ^[1-9][0-9]*$ ]]; then
  run_sweep degraded "GITHUB_REPOSITORY_ID is '$repo', not a repository id, and the store keys every row by it (kanon#1346) — running the full sweep."
fi
own="RUN#explorer#$repo"
unkeyed="RUN#explorer"

# Commit of the most recent GREEN, full-tier sweep in the store.
#
# Filtered SERVER-side and read as JSON, both load-bearing:
#  - `--filter-expression` + `--max-items 1` makes the CLI page until it
#    finds a match, so the query cannot age out as the partition grows.
#    Filtering client-side inside a fixed `--max-items 25` window is what
#    broke this gate on 2026-07-20, the day the partition passed 25 rows.
#  - `--output json` piped to `jq` cannot pick up the CLI's pagination
#    token. Under `--output text` that token is appended as an extra
#    line, so the value became "<sha>\nNone" and never compared equal.
#  - skip markers carry no `failed` attribute, so `#f = :zero` excludes
#    them from the baseline — that shape is load-bearing (see
#    the reference adopter's Overseer playbook, "Liveness queries").
# stderr goes to its own file rather than into `items` (`2>&1`): any
# warning the CLI prints on an otherwise *successful* call would
# otherwise be spliced into the JSON and break the parse.
query_err="$(mktemp)"
for pk in "$own" "$unkeyed"; do
# The unkeyed partition's reads skip the rows the migration marked; this repository's own has none.
unmarked=""
[ "$pk" = "$unkeyed" ] && unmarked=" AND attribute_not_exists(migratedTo)"
values="$(jq -nc --arg p "$pk" '{":p":{"S":$p},":zero":{"N":"0"},":all":{"S":"all"}}')"
if ! items="$(aws dynamodb query --region "$QA_AWS_REGION" --table-name "$QA_DYNAMO_TABLE" \
  --no-scan-index-forward --max-items 1 \
  --key-condition-expression 'pk = :p' \
  --filter-expression "#f = :zero AND #t = :all$unmarked" \
  --expression-attribute-names '{"#f":"failed","#t":"tier"}' \
  --expression-attribute-values "$values" \
  --output json 2>"$query_err")"; then
  run_sweep degraded "the baseline query failed, so HEAD could not be compared — running the full sweep. $(tr '\n' ' ' < "$query_err")"
fi
# A MATCHED row with no `commit` is its own failure, not a zero-match: say so
# here (the tripwire below rejects the sentinel) rather than letting it fall
# into the zero-match branch and be misread as filter drift.
if ! last_green="$(printf '%s' "$items" | jq -er 'if (.Items | length) > 0 then (.Items[0].commit.S // "<matched row has no commit attribute>") else "" end')"; then
  run_sweep degraded "the baseline response did not parse as the expected JSON — running the full sweep. $(printf '%s' "$items" | head -c 300 | tr '\n' ' ')"
fi
[ -n "$last_green" ] && break

# A ZERO-MATCH baseline is not one state but three, and only one is benign
# (RA-714). The filter above matches nothing when the partition is genuinely
# empty — but ALSO when every recorded sweep is red or partial-tier, and when
# the attributes it filters on stopped matching what `push-run.sh` writes (a
# renamed or retyped attribute in its put-item, a changed tier value). The last is RA-702 through another
# door: the gate never skips again, every run is green, and a benign line
# says so. The `^[0-9a-f]{40}$` tripwire below cannot see it — `-z` exits first.
#
# So look at the partition's NEWEST row, filtered only on the migration's mark
# (in the unkeyed partition; see below). This second request is
# made only on this branch, never on the skip/changed paths.
#   - no row at all                → a fresh store: quiet `ok`. In this
#     repository's own partition, it is instead the cue to read the unkeyed one.
#     In the unkeyed one this read skips marked rows too, so a partition the
#     migration marked whole is empty here, not drift.
#   - a RED full-tier sweep (`failed` a non-zero number, `tier` "all") → a red
#     streak. Quiet `ok`, deliberately — the gate is behaving correctly, and an
#     outage already has its own signal (the bugs the sweep files); a daily
#     warning here would teach the reader to skip it.
#   - a partial-tier sweep from a MANUAL dispatch → also quiet `ok`: only a
#     dispatch can set a tier, so it genuinely is not a baseline.
#   - anything else (a skip marker, a row without those attributes, a
#     SCHEDULED row whose tier is not "all" — a changed tier value —, or a green
#     full-tier row the filter should have returned) →
#     `degraded`: rows exist that the baseline filter cannot see, which is
#     the drift. A skip marker is only ever written against a green baseline,
#     so a skip marker with no green row visible is itself impossible — except
#     in this repository's own partition, before its first sweep, when the
#     baseline it was written against was the unkeyed one: read that one too.
if ! newest="$(aws dynamodb query --region "$QA_AWS_REGION" --table-name "$QA_DYNAMO_TABLE" \
  --no-scan-index-forward --max-items 1 \
  --key-condition-expression 'pk = :p' \
  ${unmarked:+--filter-expression "attribute_not_exists(migratedTo)"} \
  --expression-attribute-values "$(jq -nc --arg p "$pk" '{":p":{"S":$p}}')" \
  --output json 2>"$query_err")"; then
  run_sweep degraded "the baseline query matched no green full-tier sweep, and the follow-up read of the partition failed, so an empty store cannot be told from a broken filter — running the full sweep. $(tr '\n' ' ' < "$query_err")"
fi
if ! shape="$(printf '%s' "$newest" | jq -er --arg own "$([ "$pk" = "$own" ] && echo yes)" '
    if (.Items | length) == 0 then "empty"
    elif $own == "yes" and .Items[0].skipped.BOOL == true and (.Items[0].failed.N // null) == null
      then "empty"
    elif .Items[0].failed.N == "0" and .Items[0].tier.S == "all"
      then "other a green full-tier row the filter did not return"
    elif (.Items[0].failed.N // null) != null and .Items[0].tier.S == "all"
      then "sweep failed=\(.Items[0].failed.N) tier=all sk=\(.Items[0].sk.S // "?")"
    elif (.Items[0].failed.N // null) != null and (.Items[0].tier.S // null) != null and .Items[0].trigger.S == "workflow_dispatch"
      then "sweep failed=\(.Items[0].failed.N) tier=\(.Items[0].tier.S) (manual) sk=\(.Items[0].sk.S // "?")"
    elif (.Items[0].tier.S // null) != null and (.Items[0].failed.N // null) != null
      then "other a \(.Items[0].trigger.S // "?") sweep recorded tier=\(.Items[0].tier.S), and only a manual dispatch sets a partial tier"
    else "other attributes \(.Items[0] | keys | join(","))" end')"; then
  run_sweep degraded "the partition read did not parse as the expected JSON, so an empty store cannot be told from a broken filter — running the full sweep. $(printf '%s' "$newest" | head -c 300 | tr '\n' ' ')"
fi
if [ "$pk" = "$own" ] && [ "$shape" = empty ]; then
  echo "$own holds no sweep of this repository's yet, so the gate reads the store's unkeyed $unkeyed, written before kanon#1346, until this repository's first sweep or the Owner's migration."
  continue
fi
case "$shape" in
  empty) run_sweep ok "no sweep in the store yet → running the full sweep." ;;
  sweep*) run_sweep ok "no green full-tier sweep among the recorded runs (newest: ${shape#sweep }) → running the full sweep." ;;
  *) run_sweep degraded "$pk holds rows, but the baseline filter (failed = 0 AND tier = all) matched none, and the newest row is not a red or manual partial-tier sweep that would explain it (${shape#other }). The filter has likely drifted from what push-run.sh writes (or a row landed between the two reads — a re-run settles that) — running the full sweep." ;;
esac
done
# Tripwire. Anything that is not a bare 40-hex sha means the query shape
# changed under us again; fail open, but never silently. Matched with
# bash `=~` rather than `grep`, deliberately: grep is line-oriented and
# would happily match the *first* line of the very "<sha>\nNone" value
# this tripwire exists to catch.
if ! [[ "$last_green" =~ ^[0-9a-f]{40}$ ]]; then
  run_sweep degraded "baseline query returned a non-sha value ('$(printf '%s' "$last_green" | tr '\n' ' ')') — running the full sweep."
fi

printf '%s\n' "$last_green" > "$out"
echo "last green full-tier sweep: $last_green ($pk)"
