#!/usr/bin/env bash
# lane-check: the permanent rules for an adopter's Kanon lane callers (plan 0001 §6).
#
# Run from the root of the adopter's checkout. Reads Kanon's own lane files from KANON_ROOT
# (the action's directory, ../.., which is Kanon at the tag the adopter pinned), so every
# rule about what a lane declares is read from the lane itself and never restated here.
#
# Parses YAML with `yq` (mikefarah v4, preinstalled on GitHub's hosted runners; decision 6)
# into JSON, and checks it with `jq`. Reads the escalation and exemptions files, and the
# adoption record's reference-deploy declaration, with Kanon's own library, on Node (the action puts Kanon's Node on the PATH first). Prints one
# `::error` per violation and exits 1 if there is any; exits 2 when it cannot run at all.
#
# ENV  KANON_ROOT   Kanon's tree (default: this script's ../..)
#      ACTION_REF   the ref this action was called at; when it is an exact version, every
#                   Kanon reference in the adopter's .github/ must name the same one
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KANON_ROOT="${KANON_ROOT:-$HERE/../..}"
ACTION_REF="${ACTION_REF:-}"
SPINE=agent-lane
HOOK=.github/actions/project-setup/action.yml
REGISTER=docs/qa/agent-identities.md
DATABASE=docs/qa/test-database.md

die() { echo "::error title=lane-check::$*"; exit 2; }
command -v yq >/dev/null 2>&1 || die "needs yq (mikefarah v4) on PATH; GitHub's hosted runners have it"
command -v jq >/dev/null 2>&1 || die "needs jq on PATH"
[ -d .github/workflows ] || die "run it from the root of the adopter's checkout: there is no .github/workflows here"
[ -f "$KANON_ROOT/.github/workflows/$SPINE.yml" ] || die "Kanon's lanes are not at $KANON_ROOT"

ERRORS=0
fail() { # file, message
  echo "::error file=$1,title=lane-check::$2"
  ERRORS=$((ERRORS + 1))
}
json() { yq -o=json '.' "$1" 2>/dev/null; }

# ── Every Kanon reference under .github/ names one exact version ────────────────────────
# Comments are skipped: a commented-out example is not a pin.
REFS="$(find .github -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 \
  | xargs -0 grep -hE 'yedeya-labs/kanon/' 2>/dev/null \
  | grep -vE '^[[:space:]]*#' \
  | grep -oE 'yedeya-labs/kanon/[^@[:space:]]+@[^[:space:]"'"'"']+' || true)"
TAGS="$(printf '%s\n' "$REFS" | sed -nE 's/.*@//p' | sort -u)"
for tag in $TAGS; do
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail .github "a Kanon reference pins '$tag', not an exact version vX.Y.Z (K-ADOPT-11)"
done
if [ "$(printf '%s\n' "$TAGS" | grep -c .)" -gt 1 ]; then
  fail .github "Kanon references pin $(printf '%s\n' "$TAGS" | grep . | paste -sd, -): every caller, action and lane must pin one version"
fi
if [[ "$ACTION_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -n "$TAGS" ] && [ "$TAGS" != "$ACTION_REF" ]; then
  fail .github "lane-check runs at $ACTION_REF, but the Kanon references pin $(printf '%s\n' "$TAGS" | paste -sd, -)"
fi

# ── The callers ─────────────────────────────────────────────────────────────────────────
level() { case "$1" in write) echo 2 ;; read) echo 1 ;; *) echo 0 ;; esac; }
# Is this workflow document a reusable workflow? `on: workflow_call`, as a key, a list item or
# the one event.
is_reusable() {
  jq -e '.on as $o | ($o | type) as $t
    | ($t == "object" and ($o | has("workflow_call"))) or ($t == "array" and ($o | index("workflow_call") != null)) or ($o == "workflow_call")' <<<"$1" >/dev/null 2>&1
}
# Kanon's own source tree: the spine as a reusable workflow, and this check's own script, at
# the paths Kanon ships them. No adopter's repository holds both.
KANON_TREE=0
if [ -f actions/lane-check/lane-check.sh ] && [ -f ".github/workflows/$SPINE.yml" ] && is_reusable "$(json ".github/workflows/$SPINE.yml" || true)"; then
  KANON_TREE=1
fi
CALLERS=0
ROLES=""
DOCS=""
READS=""
HOOKS=""
for f in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$f" ] || continue
  doc="$(json "$f")" || { fail "$f" "is not valid YAML"; continue; }
  lanes="$(jq -r '[.jobs // {} | .[] | .uses // empty | strings
    | capture("^yedeya-labs/kanon/\\.github/workflows/(?<lane>[A-Za-z0-9_.-]+)\\.ya?ml@").lane] | .[]' <<<"$doc")"
  # Only a call to a LANE makes a file a caller, and a lane is an `agent-*` workflow. Kanon's
  # other reusable workflows (the release workflow, apps-check) are not lanes: they take
  # their own secrets, or none, and their callers are held to no lane caller rule, only to
  # the pin above and the secrets rule just below (kanon#152). The spine is called by lanes
  # that have not moved yet; it is not a lane either, and its callers are not trigger-only.
  lane="$(printf '%s\n' "$lanes" | grep -E '^agent-' | grep -vx "$SPINE" | head -1 || true)"
  # Not a lane, but still Kanon's code: a job that calls any other Kanon workflow maps the
  # secrets it passes by name, or passes none, and never `secrets: inherit` (plan 0001
  # decision 7, K-AGENT-47). A lane caller is held to the same below, with its lane's names.
  while IFS=$'\t' read -r name wf value; do
    [ -n "$name" ] || continue
    fail "$f" "the job \`$name\` calls Kanon's $wf workflow with \`secrets: $value\`; map each secret it takes by name, or pass none (\`secrets: inherit\` would hand every secret to Kanon's code; plan 0001 decision 7)"
  done < <(jq -r '.jobs // {} | to_entries[]
    | (.value.uses // "" | tostring | capture("^yedeya-labs/kanon/\\.github/workflows/(?<w>[A-Za-z0-9_.-]+)\\.ya?ml@").w) as $w
    | select($w | startswith("agent-") | not)
    | select(.value | has("secrets"))
    | select((.value.secrets | type) != "object")
    | [.key, $w, (.value.secrets | tostring)] | @tsv' <<<"$doc")
  [ -n "$lane" ] || continue
  CALLERS=$((CALLERS + 1))
  lane_file="$KANON_ROOT/.github/workflows/$lane.yml"
  if [ ! -f "$lane_file" ]; then
    fail "$f" "calls Kanon lane '$lane', which this Kanon version does not ship"
    continue
  fi
  lane_doc="$(json "$lane_file")" || die "Kanon's $lane.yml does not parse"

  # Every caller lives at its lane's own file name (K-LAYOUT-18, kanon#207). Kanon's scripts
  # find a lane's runs, and dispatch it, by the caller's file name: the review lane's
  # (`merge-gate.mjs`, the review-run evidence), the revise lanes' (the reconciler), and every
  # caller's (the health check, which watches `agent-*.yml`). Under another name those reads
  # come back empty, which the recoveries read as "nothing is parked".
  #
  # GitHub files a run under the TOP-LEVEL workflow's file name, so a caller that is itself a
  # reusable workflow, a wrapper some other workflow calls, has its runs filed under that other
  # name even at the right path (kanon#217). It is refused.
  if is_reusable "$doc"; then
    fail "$f" "calls the Kanon lane $lane but is itself a reusable workflow (\`on: workflow_call\`): GitHub files its runs under the workflow that calls it, so Kanon's scripts can't find them by this file name. Put the lane's triggers here and call the lane from this file (K-LAYOUT-18)"
  fi
  # The one exception to the path: Kanon's own repository, where `.github/workflows/<lane>.yml`
  # holds the lane itself, so its caller can't take that path (its review caller is
  # `review.yml`). Recognised by the checkout being Kanon's source tree (`KANON_TREE` below),
  # and the file at the lane's path being a reusable workflow, never by a name or setting an
  # adopter could share by accident (kanon#217).
  if [ "$f" != ".github/workflows/$lane.yml" ]; then
    taken="$(json ".github/workflows/$lane.yml" || true)"
    [ -n "$taken" ] || taken='{}'
    if ! { [ "$KANON_TREE" = 1 ] && is_reusable "$taken"; }; then
      fail "$f" "calls the Kanon lane $lane, so it lives at .github/workflows/$lane.yml: Kanon's scripts find this lane's runs, and dispatch it, by that file name (K-LAYOUT-18)"
    fi
  fi
  # The workflows of the adopter's own that the lane reads by file name, on `# READS WORKFLOW:
  # <file>` lines in the lane (the review lane and the reconciler read CI's runs from `ci.yml`).
  for w in $(sed -n 's/^# READS WORKFLOW: //p' "$lane_file"); do
    READS="$READS $w=$lane"
  done
  # The hooks of the adopter's own that only some lanes call, on `# NEEDS HOOK: <path>` lines
  # in the lane (the Explorer's sweep hook, plan 0004 decision 5). The project-setup hook,
  # which every lane that checks out calls, is checked on its own below.
  for h in $(sed -n 's/^# NEEDS HOOK: //p' "$lane_file"); do
    HOOKS="$HOOKS $h=$lane"
  done

  # Only `on`, `permissions` and one job (and a `name` and a `run-name`). No `concurrency`:
  # the lane holds its own group, and the same group on the caller would deadlock the two
  # (decision 11).
  extra="$(jq -r 'keys - ["name","run-name","on","permissions","jobs"] | join(", ")' <<<"$doc")"
  [ -z "$extra" ] || fail "$f" "a lane caller holds only name, run-name, on, permissions and one job; it also has: $extra"

  # A run's title is its caller's: a called workflow's `run-name` is ignored. A lane whose
  # title is read by another program (the review lane's, by the review-run evidence) says
  # what the caller's title must end with, on a `# CALLER RUN-NAME ENDS WITH: <text>` line.
  want_title="$(sed -n 's/^# CALLER RUN-NAME ENDS WITH: //p' "$lane_file" | head -1)"
  if [ -n "$want_title" ]; then
    title="$(jq -r '."run-name" // ""' <<<"$doc")"
    case "$title" in
      *" $want_title") ;;
      *) fail "$f" "its run-name must end with \` $want_title\`, as the last token: the Kanon lane $lane's runs are found by it" ;;
    esac
  fi
  # A check is reported under its caller's `name:`, and a lane whose checks another program
  # tells apart by that name (the Merger's, by `merge-gate.mjs`, which must not wait on itself)
  # says what the caller's name must be, on a `# CALLER NAME: <name>` line (plan 0004 step 7).
  want_name="$(sed -n 's/^# CALLER NAME: //p' "$lane_file" | head -1)"
  if [ -n "$want_name" ]; then
    name="$(jq -r '.name // ""' <<<"$doc")"
    [ "$name" = "$want_name" ] \
      || fail "$f" "its name must be \`$want_name\`, not \`$name\`: GitHub reports the Kanon lane $lane's checks under its caller's name, and the lane tells its own checks from the rest by it (docs/lanes.md)"
  fi
  # The project documents this lane's prompt reads, at their fixed paths (K-LAYOUT-17).
  # Read from the lane itself, so a lane that starts reading one makes it required here.
  for d in $(grep -oE 'docs/qa/(stack|[a-z]+(-[a-z]+)*-playbook)\.md' "$lane_file" | sort -u); do
    DOCS="$DOCS $d=$lane"
  done
  njobs="$(jq '.jobs | length' <<<"$doc")"
  [ "$njobs" = 1 ] || fail "$f" "a lane caller has exactly one job, not $njobs"
  job="$(jq -c '.jobs | to_entries[0].value' <<<"$doc")"
  extra="$(jq -r 'keys - ["name","uses","with","secrets","permissions"] | join(", ")' <<<"$job")"
  [ -z "$extra" ] || fail "$f" "the calling job holds only uses, with, secrets and permissions; it also has: $extra"

  # `with:` only passes the caller's own inputs through, by the same name.
  declared="$(jq -c '.on.workflow_call.inputs // {} | keys' <<<"$lane_doc")"
  while IFS=$'\t' read -r k v; do
    [ -n "$k" ] || continue
    jq -e --arg k "$k" 'index($k) != null' <<<"$declared" >/dev/null \
      || fail "$f" "passes \`$k\`, which the Kanon lane $lane does not declare"
    [[ "$v" =~ ^\$\{\{[[:space:]]*inputs\.${k}[[:space:]]*\}\}$ ]] \
      || fail "$f" "passes \`$k: $v\`; a caller only passes its own input through, as \`\${{ inputs.$k }}\` (ADR 0002)"
  done < <(jq -r '.with // {} | to_entries[] | [.key, (.value | tostring)] | @tsv' <<<"$job")

  # Secrets: exactly the lane's, by their fixed names, each mapped explicitly.
  if [ "$(jq -r '.secrets | type' <<<"$job")" != object ]; then
    fail "$f" "maps no secrets explicitly (\`secrets: inherit\` would hand every secret to Kanon's code; plan 0001 decision 7)"
  else
    want="$(jq -r '.on.workflow_call.secrets // {} | keys | sort | join(",")' <<<"$lane_doc")"
    got="$(jq -r '.secrets | keys | sort | join(",")' <<<"$job")"
    [ "$want" = "$got" ] || fail "$f" "maps secrets [$got]; the Kanon lane $lane takes exactly [$want]"
    while IFS=$'\t' read -r k v; do
      [ -n "$k" ] || continue
      [[ "$v" =~ ^\$\{\{[[:space:]]*secrets\.[A-Za-z0-9_]+[[:space:]]*\}\}$ ]] \
        || fail "$f" "maps \`$k\` to \`$v\`; map each one to a single repository secret"
    done < <(jq -r '.secrets | to_entries[] | [.key, (.value | tostring)] | @tsv' <<<"$job")
    for s in $(jq -r '.on.workflow_call.secrets // {} | keys[] | select(endswith("_APP_ID")) | sub("_APP_ID$"; "")' <<<"$lane_doc"); do
      ROLES="$ROLES $(printf '%s' "${s:0:1}")$(printf '%s' "${s:1}" | tr '[:upper:]' '[:lower:]')"
    done
  fi

  # The permissions ceiling: the calling job must grant at least what the lane declares, at
  # its top level or on any one of its jobs. A job-level grant in a called workflow is still
  # held to the caller's ceiling, so the implement lane's crash recovery, which writes issues
  # on the default token, needs the caller to grant that too.
  perms="$(jq -c 'if (.jobs | to_entries[0].value.permissions) != null then .jobs | to_entries[0].value.permissions else .permissions end' <<<"$doc")"
  if [ "$(jq -r 'type' <<<"$perms")" != object ]; then
    fail "$f" "grants no explicit permissions; the calling job's \`permissions:\` is the lane's ceiling (plan 0001 §3)"
  else
    while IFS=$'\t' read -r scope need; do
      [ -n "$scope" ] || continue
      have="$(jq -r --arg s "$scope" '.[$s] // "none"' <<<"$perms")"
      [ "$(level "$have")" -ge "$(level "$need")" ] \
        || fail "$f" "grants $scope: $have; the Kanon lane $lane needs $scope: $need"
    done < <(jq -r 'def lv: if . == "write" then 2 elif . == "read" then 1 else 0 end;
      [(.permissions | objects), (.jobs // {} | .[] | .permissions | objects)]
      | map(to_entries[]) | group_by(.key) | .[] | max_by(.value | lv) | [.key, .value] | @tsv' <<<"$lane_doc")
  fi
done

[ "$CALLERS" -gt 0 ] || fail .github/workflows "no workflow calls a Kanon lane (yedeya-labs/kanon/.github/workflows/<lane>.yml@vX.Y.Z)"

# ── The workflows the called lanes read by file name (K-LAYOUT-18) ─────────────────────
for w in $(printf '%s\n' $READS | sed 's/=.*//' | sort -u); do
  by="$(printf '%s\n' $READS | sed -n "s|^$w=||p" | sort -u | paste -sd, -)"
  [ -f ".github/workflows/$w" ] \
    || fail ".github/workflows/$w" "is missing; the Kanon lane(s) $by read its runs by that file name (K-LAYOUT-18)"
done

# ── The project-setup hook ──────────────────────────────────────────────────────────────
if [ ! -f "$HOOK" ]; then
  fail "$HOOK" "the project-setup hook is missing; every lane that checks out calls it (plan 0001 §5)"
else
  hook="$(json "$HOOK")" || fail "$HOOK" "is not valid YAML"
  spine="$(json "$KANON_ROOT/.github/workflows/$SPINE.yml")"
  # The inputs Kanon passes the hook are read from the spine's own call to it.
  for k in $(jq -r '[.jobs[].steps[]? | select(.uses == "./.github/actions/project-setup") | .with // {} | keys[]] | unique | .[]' <<<"$spine"); do
    jq -e --arg k "$k" '.inputs // {} | has($k)' <<<"$hook" >/dev/null \
      || fail "$HOOK" "does not declare the input \`$k\`, which Kanon's lanes pass it"
  done
  [ "$(jq -r '.runs.using // ""' <<<"$hook")" = composite ] || fail "$HOOK" "must be a composite action"
fi

# ── The hooks only some lanes call ─────────────────────────────────────────────────────
for h in $(printf '%s\n' $HOOKS | sed 's/=.*//' | sort -u); do
  by="$(printf '%s\n' $HOOKS | sed -n "s|^$h=||p" | sort -u | paste -sd, -)"
  if [ ! -f "$h" ]; then
    fail "$h" "is missing; the Kanon lane(s) $by call it"
  elif [ "$(json "$h" | jq -r '.runs.using // ""')" != composite ]; then
    fail "$h" "must be a composite action; the Kanon lane(s) $by call it"
  fi
done

# ── The project documents the lanes read (K-LAYOUT-17) ────────────────────────────────
# Each one a called lane's prompt names must exist; the stack document must also carry its
# four sections, each once, outside a fenced block, because the prompts send the agent to a
# section by its heading and a missing one reads as "nothing to do".
STACK_HEADINGS=("## Gates" "## Schema changes" "## Data isolation" "## Generated files")
for d in $(printf '%s\n' $DOCS | sed 's/=.*//' | sort -u); do
  by="$(printf '%s\n' $DOCS | sed -n "s|^$d=||p" | sort -u | paste -sd, -)"
  if [ ! -f "$d" ]; then
    fail "$d" "is missing; the Kanon lane(s) $by read it (K-LAYOUT-17)"
    continue
  fi
  [ "$d" = docs/qa/stack.md ] || continue
  for h in "${STACK_HEADINGS[@]}"; do
    n="$(awk -v h="$h" '/^[ \t]*(```|~~~)/ { f = !f; next } !f && $0 == h { n++ } END { print n + 0 }' "$d")"
    if [ "$n" != 1 ]; then
      # A near miss (trailing spaces, CRLF, a different case) looks present and matches nothing.
      near="$(awk -v h="$h" '/^[ \t]*(```|~~~)/ { f = !f; next } { l = $0; sub(/[ \t\r]+$/, "", l) } !f && $0 != h && tolower(l) == tolower(h) { n++ } END { print n + 0 }' "$d")"
      hint=""
      [ "$near" = 0 ] || hint=" ($near more line(s) match it once trailing spaces, a CR and case are ignored: write it exactly)"
      fail "$d" "has the heading \`$h\` $n times$hint; the stack document has it exactly once, and the lanes read that section (K-LAYOUT-17)"
    fi
  done
done

# ── The test-database declaration (K-LAYOUT-16, kanon#18) ─────────────────────────────
# Read by the same program the lanes' test-database block reads it with, so a declaration
# this passes is one the lanes start. No file declares no database, which is valid.
if [ -f "$DATABASE" ]; then
  if ! out="$(awk -f "$KANON_ROOT/actions/test-database/declaration.awk" "$DATABASE" 2>&1)"; then
    fail "$DATABASE" "$out (K-LAYOUT-16)"
  fi
fi

# ── The escalation and exemptions files (K-LAYOUT-8, K-LAYOUT-15; kanon#153), the ─────────
# ── reference environment's deploy in the adoption record (K-LAYOUT-10, plan 0004 P6), ────
# ── and the code areas in the stack document (K-LAYOUT-17, kanon#54) ──────────────────────
# Read by the library's own readers from this Kanon tree, so a file this passes is one the
# guards, the Merger and the reconciler accept. A missing file is the reader's to fail (each
# rule says so), so only a file that exists is read here. A record that declares no reference
# environment passes: the reconciler fails on it when a project reaches its deploy phase.
for d in escalation-paths exemptions adoption stack; do
  f="docs/qa/$d.md"
  [ -f "$f" ] || continue
  command -v node >/dev/null 2>&1 || die "needs node on PATH to read $f; the action puts Kanon's own there"
  if ! out="$(node "$HERE/declarations.mjs" "$d" 2>&1)"; then
    fail "$f" "$(printf '%s' "$out" | head -1)"
  fi
done

# ── App slugs: every role a caller's lane runs as has one row in the register ──────────
for role in $(printf '%s\n' $ROLES | sort -u); do
  if [ ! -f "$REGISTER" ]; then
    fail "$REGISTER" "the App register is missing (K-LAYOUT-6); the lanes read the $role's App slug from it"
    break
  fi
  if ! out="$(awk -v role="$role" -f "$HERE/app-register.awk" "$REGISTER" 2>&1)"; then
    fail "$REGISTER" "$out"
  fi
done

# ── The Dependabot entry that proposes Kanon upgrades (K-ADOPT-11) ─────────────────────
DEP=.github/dependabot.yml
if [ ! -f "$DEP" ]; then
  fail "$DEP" "is missing; it holds the entry that proposes Kanon upgrades (K-ADOPT-11)"
else
  dep="$(json "$DEP")" || fail "$DEP" "is not valid YAML"
  ok="$(jq -r '
    [ .updates[]? | select(."package-ecosystem" == "github-actions")
      | select(((.directory // "") == "/") or ((.directories // []) | index("/") != null))
      | select(((.groups // {}) | to_entries | any(.value.patterns // [] | index("yedeya-labs/kanon*") != null)))
      | select((."commit-message".prefix // "") == "ci")
      | select((.allow == null) or (.allow | any((."dependency-name" // "") | startswith("yedeya-labs/kanon"))))
      | select((.cooldown.exclude // []) | index("yedeya-labs/kanon*") != null)
    ] | length' <<<"$dep")"
  [ "${ok:-0}" -gt 0 ] || fail "$DEP" "has no github-actions entry for \`/\` that groups yedeya-labs/kanon*, prefixes its commits \`ci\`, and excludes yedeya-labs/kanon* from its cooldown: with no \`cooldown\` at all, Dependabot's default of 3 days holds every Kanon release back (K-ADOPT-11)"
fi

if [ "$ERRORS" -gt 0 ]; then
  echo "lane-check: $ERRORS problem(s) in $CALLERS lane caller(s)"
  exit 1
fi
echo "lane-check: $CALLERS lane caller(s) pass"
