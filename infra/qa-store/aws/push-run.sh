#!/usr/bin/env bash
#
# Push one QA run's telemetry to the L1 operational store (RA-84):
#   - the raw distilled report → S3 (durable, append-only, per-key = race-free)
#   - a queryable rollup → DynamoDB (RUN# / COVERAGE / AREAS items)
#
# Graduates the interim `qa-runs` git branch. See the reference adopter's pipeline design doc, §6.
# MOVED FROM THE REFERENCE ADOPTER (Kanon plan 0004 step P9, ADR 0009). Kanon's AWS store action
# (`store.sh`) calls it for the contract's `put` (kind=explorer|audit), after its own credentials
# step has assumed the store's role through GitHub OIDC (environment: kanon-qa-store). The
# reference adopter's telemetry collector calls it for kind=telemetry until plan 0002's S7.
#
# Usage:  push-run.sh <explorer|audit|telemetry> <report.json>
# Env:    QA_S3_BUCKET, QA_DYNAMO_TABLE, QA_AWS_REGION  (the AWS action's inputs)
#         DRY_RUN=1  → print the S3 key + every DynamoDB item instead of calling AWS
#                      (used by the local self-test; no creds needed)
#
# NOT best-effort: any real write failure exits non-zero and fails the workflow —
# that Actions failure IS the page (the reference adopter's observability doc, §8). A missing report is
# the one benign skip, and ONLY for kind=explorer (its change-gate produces
# report-less runs by design); for kind=audit it is a failure — see below.
set -euo pipefail

kind="${1:?usage: push-run.sh <explorer|audit|telemetry> <report.json>}"
report="${2:?usage: push-run.sh <explorer|audit|telemetry> <report.json>}"

if [ ! -f "$report" ]; then
  # Benign for the EXPLORER only. Its change-gate (RA-167) legitimately produces
  # report-less runs on an unchanged commit — and writes its own `skipped: true`
  # marker — so absence there is the gate working, not a corpse.
  #
  # The AUDIT has no change-gate and no skip path: its agent is instructed to write
  # the summary on turn one, unconditionally. An absent report there is always a
  # degraded run (audit #12 §1) — on 2026-07-22 that combination of this early
  # `exit 0` and the workflow's matching one produced a fully green run with no S3
  # report and no store row, invisible on every surface. agent-code-audit.yml now
  # synthesizes a `no_report` summary before calling this, so in the normal path we
  # never get here; this is the backstop for any other caller.
  if [ "$kind" = "audit" ]; then
    echo "push-run: no report at '$report' — an audit run must always produce one (audit #12 §1); failing rather than skipping" >&2
    exit 1
  fi
  echo "push-run: no report at '$report'; skipping (benign)"
  exit 0
fi

region="${QA_AWS_REGION:?QA_AWS_REGION unset}"
: "${QA_S3_BUCKET:?QA_S3_BUCKET unset}"
: "${QA_DYNAMO_TABLE:?QA_DYNAMO_TABLE unset}"

# Deterministic per-run key (UTC). Matches the qa-runs layout: <kind>/<ts>.json.
# QA_RUN_TS lets the one-time backfill (backfill.sh) preserve each historical run's
# original timestamp instead of stamping "now".
ts="${QA_RUN_TS:-$(date -u +%Y%m%dT%H%M%SZ)}"
commit="$(jq -r '.commit // "unknown"' "$report")"
trigger="$(jq -r '.trigger // "unknown"' "$report")"

# --- S3: the raw distilled report (Overseer drills into this by key) ----------
# Telemetry keys carry the agent, because unlike the other kinds there are THIRTEEN
# producers rather than one, and `<kind>/<ts>.json` at one-second resolution silently
# overwrites when two of them push in the same second. The DynamoDB sort key already
# discriminates by agent; the S3 object did not.
if [ "$kind" = "telemetry" ]; then
  s3_key="${kind}/$(jq -r '.agent // "unknown"' "$report")/${ts}.json"
else
  s3_key="${kind}/${ts}.json"
fi
if [ "${DRY_RUN:-}" = "1" ]; then
  echo "[dry-run] s3://${QA_S3_BUCKET}/${s3_key}  <= ${report}"
else
  aws s3 cp "$report" "s3://${QA_S3_BUCKET}/${s3_key}" --region "$region" --only-show-errors
fi

# --- DynamoDB: put one item (or print it under DRY_RUN) -----------------------
put() {
  if [ "${DRY_RUN:-}" = "1" ]; then
    echo "[dry-run] put-item: $1"
  else
    aws dynamodb put-item --region "$region" --table-name "$QA_DYNAMO_TABLE" --item "$1" >/dev/null
  fi
}

case "$kind" in
  explorer)
    tier="$(jq -r '.tier // "all"' "$report")"
    swept="$(jq -r '.routes_swept // 0' "$report")"
    passed="$(jq -r '.passed // 0' "$report")"
    failed="$(jq -r '.failed // 0' "$report")"
    # RUN#explorer / <ts> — liveness + run history. `tier` lets the change-gate
    # (RA-167) find the last GREEN full-tier ('all') sweep to compare against HEAD.
    put "$(jq -nc --arg ts "$ts" --arg c "$commit" --arg tr "$trigger" --arg tier "$tier" \
      --arg sw "$swept" --arg p "$passed" --arg f "$failed" '{
        pk:{S:"RUN#explorer"}, sk:{S:$ts}, commit:{S:$c}, trigger:{S:$tr}, tier:{S:$tier},
        routes_swept:{N:$sw}, passed:{N:$p}, failed:{N:$f}
      }')"
    # COVERAGE / <route> — last status + commit each route was last seen at
    while IFS= read -r r; do
      route="$(jq -r '.route' <<<"$r")"
      status="$(jq -r '.status' <<<"$r")"
      put "$(jq -nc --arg rt "$route" --arg st "$status" --arg c "$commit" --arg ts "$ts" '{
          pk:{S:"COVERAGE"}, sk:{S:$rt}, last_status:{S:$st}, last_seen_commit:{S:$c}, ts:{S:$ts}
        }')"
    done < <(jq -c '.routes[]?' "$report")
    ;;
  audit)
    fr="$(jq -r '.files_read // 0' "$report")"
    lc="$(jq -r '.lines_cited // 0' "$report")"
    tn="$(jq -r '.turns // 0' "$report")"
    # Liveness flags (audit #12 §1) — `no_report`: the agent wrote nothing and the
    # workflow synthesized this row; `report_invalid`: it wrote something unparseable;
    # `complete`: it reached its final write.
    #
    # Each is written as an explicit true/false, never encoded by presence — the
    # Overseer's playbook mandates full-item queries precisely because a projection
    # built for the healthy shape silently drops an attribute, and "missing" would then
    # be indistinguishable from "false".
    #
    # But ONLY when the source report actually carries the key. agent-code-audit.yml's
    # stamp step normalizes all three before this runs, so a live run always has them.
    # backfill.sh does not go through that step — it replays historical reports written
    # before this protocol existed, and defaulting those to `false` would fabricate a
    # degraded signal: the docs promise pre-change rows have NEITHER attribute ("unknown,
    # not false"), and the playbook has the Overseer read `complete: false` as "a partial
    # audit whose coverage claims are incomplete". Absent stays absent.
    liveness="$(jq -c '
      (if has("no_report")      then {no_report:      {BOOL: (.no_report == true)}}      else {} end)
      + (if has("complete")     then {complete:       {BOOL: (.complete == true)}}       else {} end)
      + (if has("report_invalid") then {report_invalid:{BOOL: (.report_invalid == true)}} else {} end)
    ' "$report")"
    # RUN#audit / <ts> — liveness + execution-truth proxy
    put "$(jq -nc --arg ts "$ts" --arg c "$commit" --arg tr "$trigger" \
      --arg fr "$fr" --arg lc "$lc" --arg tn "$tn" --argjson lv "$liveness" '{
        pk:{S:"RUN#audit"}, sk:{S:$ts}, commit:{S:$c}, trigger:{S:$tr},
        files_read:{N:$fr}, lines_cited:{N:$lc}, turns:{N:$tn}
      } + $lv')"
    # AREAS / <path> — unbounded code-reading coverage ledger (subsumes RA-169's
    # tail -5 window). Key on the LEADING path token (the primary file/area); the
    # full text is kept in `detail`. Robust to the varied areas_scanned shapes the
    # agent writes: "path — desc", "path, sibling.ts, …", "path (note) + other",
    # "path method/…". Falls back to the trimmed whole string if it doesn't lead
    # with a path.
    while IFS= read -r area; do
      [ -n "$area" ] || continue
      # Char class includes []  so dynamic route segments (…/[...path]/…) key in full.
      key="$(printf '%s' "$area" | grep -oE '^[]A-Za-z0-9._/[-]+' | head -n1 || true)"
      [ -n "$key" ] || key="$(printf '%s' "$area" | cut -c1-256)"
      put "$(jq -nc --arg k "$key" --arg ts "$ts" --arg c "$commit" --arg full "$area" '{
          pk:{S:"AREAS"}, sk:{S:$k}, last_scanned_ts:{S:$ts}, commit:{S:$c}, detail:{S:$full}
        }')"
    done < <(jq -r '.areas_scanned[]?' "$report")
    ;;
  telemetry)
    # COST#<agent> / <ts> — one row per agent invocation (RA-1485).
    #
    # NOT `RUN#cost`. The documented item model is `RUN#<agent>` / `<ts>`, so a
    # `RUN#cost` partition puts the string "cost" where every reader expects an agent
    # name, and gives this one kind a sort key (`<agent>#<ts>`) shaped unlike every
    # other. `COST#<agent>` / `<ts>` composes with the convention instead, and keeps
    # one partition per agent so a per-agent cost history is a single query.
    #
    # Worth getting right before the first write rather than after: `dynamodb:DeleteItem`
    # is scoped to the COVERAGE partition, so anything written here is permanent.
    #
    # WHY THE DENOMINATORS SIT HERE AND NOT IN A SEPARATE ITEM. A cost is
    # meaningless on its own: reviewing a 1,000-line PR bills more than a 20-line
    # one, so a fall in daily spend measures the week's PR mix unless the diff size
    # travels WITH the cost. Splitting them across items would make every
    # before/after comparison a join, and a join is exactly what nobody does.
    agent="$(jq -r '.agent // "unknown"' "$report")"
    outcome="$(jq -r '.outcome // "not-reached"' "$report")"
    #
    # EVERY NUMBER IS CONDITIONAL ON ITS KEY BEING PRESENT AND NON-NULL, the same
    # rule the audit's liveness flags follow. DynamoDB has no empty `N`, and
    # defaulting an absent value to 0 is the specific lie this row exists to avoid:
    # a `not-reached` run whose cost is unknown would become a run that cost
    # nothing, and would then be indistinguishable from a run that genuinely billed
    # zero. Absent stays absent.
    #
    # NOT "a capped run really did cost nothing" — that was the claim here, and RA-1503
    # measured it FALSE: an Opus cap still bills ~$0.003 of Haiku pre-flight (four runs,
    # 2026-09-03), which is exactly why `classifyResult` discriminates on PRESENCE of
    # the configured model in `modelUsage` and never on spend or turn count. The
    # normalizer's own header says so 160 lines up; this comment contradicted it, in
    # the file that writes the PERMANENT `COST#<agent>` rows (RA-1532).
    n() { jq -c --arg k "$1" --arg p "$2" '
      if (getpath($p | split(".")) // null) == null then {}
      else {($k): {N: ((getpath($p | split(".")) | tostring))}} end' "$report"; }
    # THE TWO NESTED LEAVES ADDED BY RA-2028 were recorded by `buildRow` and emitted by
    # nothing until then. `subagents_completed` is not derivable from what else is stored
    # (a subagent can be neither completed nor failed), and `cache_write_5m_tokens` is
    # derivable (total - 1h) but was the absence every 5m-TTL reader had to explain away.
    # Rows written before RA-2028 carry neither, and absent is not zero.
    #
    # THE ISSUE-SIDE SIZE AND THE RUN'S OWN DIFF (RA-2137): `issue_body_chars` and
    # `issue_paths_named` are a CANDIDATE size control for the issue-triggered arms, which
    # have no `changed_lines`; `produced_lines` is an OUTCOME, stored under its own name
    # precisely so no reader keying on `changed_lines` mistakes the agent's output for the
    # size of the work it was handed. Rows before RA-2137 carry none of the three.
    metrics="$(jq -nc \
      --argjson a "$(n total_cost_usd total_cost_usd)" \
      --argjson b "$(n num_turns num_turns)" \
      --argjson c "$(n duration_ms duration_ms)" \
      --argjson o "$(n duration_api_ms duration_api_ms)" \
      --argjson d "$(n pr_number pr_number)" \
      --argjson n "$(n issue_number issue_number)" \
      --argjson e "$(n changed_lines changed_lines)" \
      --argjson f "$(n changed_files changed_files)" \
      --argjson g "$(n input_tokens usage.input_tokens)" \
      --argjson m "$(n total_input_tokens usage.total_input_tokens)" \
      --argjson t "$(n thinking_tokens usage.thinking_tokens)" \
      --argjson w "$(n cache_write_1h_tokens usage.cache_creation_1h_tokens)" \
      --argjson x "$(n max_turns max_turns)" \
      --argjson y "$(n artifacts_filed artifacts_filed)" \
      --argjson z "$(n subagents_failed subagents.failed)" \
      --argjson q "$(n subagents_max_depth subagents.max_depth)" \
      --argjson h "$(n output_tokens usage.output_tokens)" \
      --argjson i "$(n cache_read_tokens usage.cache_read_input_tokens)" \
      --argjson j "$(n cache_write_tokens usage.cache_creation_input_tokens)" \
      --argjson k "$(n permission_denials permission_denials)" \
      --argjson l "$(n subagents_spawned subagents.spawned)" \
      --argjson u "$(n subagents_completed subagents.completed)" \
      --argjson v "$(n cache_write_5m_tokens usage.cache_creation_5m_tokens)" \
      --argjson ib "$(n issue_body_chars issue_body_chars)" \
      --argjson ip "$(n issue_paths_named issue_paths_named)" \
      --argjson pl "$(n produced_lines produced_lines)" \
      '$a + $b + $c + $d + $e + $f + $g + $h + $i + $j + $k + $l + $n
         + $m + $t + $w + $x + $y + $z + $q + $o + $u + $v + $ib + $ip + $pl')"
    # `reason` and `execution_file_form` are what make a non-`ok` row ACTIONABLE
    # (RA-1518). `outcome` says a run was `not-reached`; only these say WHICH absence —
    # no file at all, a file that would not parse, or one carrying no result event.
    # The step summary has both and outlives nothing: Actions logs 410 within ~3 days,
    # after which this row is the only surviving record, and it is permanent.
    #
    # Strings the same way — `effort` is null precisely when the step did not set
    # one, and that unset state (inheriting Claude Code's xhigh) is the measurement
    # RA-780 turns on. Writing "unknown" would erase the difference between a step
    # that chose xhigh and a step that never chose.
    # `api_error_status` IS EMITTED HERE, NOT BY `n()` (RA-1938), even though an HTTP
    # status looks numeric. `n()` writes `{N: <tostring>}`, and DynamoDB REJECTS an `N`
    # whose value is not a number — which fails the whole PutItem and takes the entire
    # row with it. This field only ever has a value on an ERROR path, i.e. exactly the
    # run whose row is the one copy of the evidence that outlives a week (the log and
    # the artifact are both gone in ~5 days against a 7-day cadence, §8a). A field that
    # can only appear when something already went wrong must not be able to destroy the
    # record of it. `terminal_reason` is a string for the same reason, and nobody range-
    # queries an HTTP status. Null is skipped by the emitter, so a clean run writes
    # nothing rather than an empty attribute.
    s() { jq -c --arg k "$1" --arg p "$2" '
      if (getpath($p | split(".")) // null) == null then {}
      else {($k): {S: (getpath($p | split(".")) | tostring)}} end' "$report"; }
    labels="$(jq -nc \
      --argjson a "$(s model model)" \
      --argjson b "$(s effort effort)" \
      --argjson ac "$(s autocompact autocompact)" \
      --argjson c "$(s config_fingerprint config_fingerprint)" \
      --argjson d "$(s workflow workflow)" \
      --argjson e "$(s run_id run_id)" \
      --argjson f "$(s terminal_reason terminal_reason)" \
      --argjson g "$(s run_attempt run_attempt)" \
      --argjson h "$(s outcome_label outcome_label)" \
      --argjson i "$(s severities severities)" \
      --argjson k "$(s configured_model configured_model)" \
      --argjson r "$(s reason reason)" \
      --argjson v "$(s execution_file_form execution_file_form)" \
      --argjson w "$(s api_error_status api_error_status)" \
      '$a + $b + $c + $d + $e + $f + $g + $h + $i + $k + $r + $v + $w + $ac')"
    # BOOLEANS NEED THEIR OWN EMITTER. `n()` and `s()` above both test
    # `(getpath(...) // null) == null`, and jq's `//` falls through on **false as well
    # as null** — so `is_error: false` was silently dropped and only errored runs
    # carried the attribute. That is the same "missing is indistinguishable from
    # false" trap the audit's liveness flags are written to avoid a few lines up, and
    # it cost a red test to notice. `has()` on the parent, no `//`.
    b() { jq -c --arg k "$1" --arg p "$2" '
      ($p | split(".")) as $path
      | if (getpath($path) | type) == "boolean" then {($k): {BOOL: getpath($path)}} else {} end' "$report"; }
    flags="$(jq -nc --argjson a "$(b is_error is_error)" '$a')"
    put "$(jq -nc --arg ts "$ts" --arg ag "$agent" --arg c "$commit" --arg tr "$trigger" \
      --arg oc "$outcome" --argjson m "$metrics" --argjson l "$labels" --argjson b "$flags" '{
        pk:{S:("COST#" + $ag)}, sk:{S:$ts},
        agent:{S:$ag}, outcome:{S:$oc}, commit:{S:$c}, trigger:{S:$tr}
      } + $m + $l + $b')"
    ;;
  *)
    echo "push-run: unknown kind '$kind' (want explorer|audit|telemetry)" >&2
    exit 2
    ;;
esac

echo "push-run: pushed ${kind} run ${ts} → s3://${QA_S3_BUCKET}/${s3_key} + ${QA_DYNAMO_TABLE} (commit ${commit})"
