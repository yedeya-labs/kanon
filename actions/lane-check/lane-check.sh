#!/usr/bin/env bash
# lane-check: the permanent rules for an adopter's Kanon lane callers (plan 0001 §6).
#
# Run from the root of the adopter's checkout. Reads Kanon's own lane files from KANON_ROOT
# (the action's directory, ../.., which is Kanon at the tag the adopter pinned), so every
# rule about what a lane declares is read from the lane itself and never restated here.
#
# The checks run in one Node process, `lane-check.mjs` (kanon#381), which parses YAML with `yq`
# (mikefarah v4, preinstalled on GitHub's hosted runners; decision 6) and reads the escalation
# and exemptions files, and the adoption record's declarations, with Kanon's own library (the
# action puts Kanon's Node on the PATH first). This script checks it can run, and holds the stack
# document's sections. Prints one `::error` per violation and exits 1 if there is any; exits 2
# when it cannot run at all.
#
# A declaration the project leaves out means its documented default (plan 0005 §5.2), so an
# omitted file or section that has one is not a violation: it prints one `::notice` naming the
# default instead. A malformed one still fails, by name. What has no default (the stack
# document's `## Gates`, the App register) still fails when it is missing.
#
# ENV  KANON_ROOT   Kanon's tree (default: this script's ../..)
#      ACTION_REF   the ref this action was called at; when it is an exact version, every
#                   Kanon reference in the adopter's .github/ must name the same one
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KANON_ROOT="${KANON_ROOT:-$HERE/../..}"
export KANON_ROOT
export ACTION_REF="${ACTION_REF:-}"
SPINE=agent-lane

die() { echo "::error title=lane-check::$*"; exit 2; }
command -v yq >/dev/null 2>&1 || die "needs yq (mikefarah v4) on PATH; GitHub's hosted runners have it"
command -v node >/dev/null 2>&1 || die "needs node on PATH to read the declarations in docs/qa/; the action puts Kanon's own there"
[ -d .github/workflows ] || die "run it from the root of the adopter's checkout: there is no .github/workflows here"
[ -f "$KANON_ROOT/.github/workflows/$SPINE.yml" ] || die "Kanon's lanes are not at $KANON_ROOT"

# The stack document's sections (K-LAYOUT-17): `## Gates` exactly once outside a fenced block,
# with no default; each other section at most once, and when it is left out, its default.
# heading|its default ('' when it has none). tests/unit/helpers/requirements.ts reads this list.
STACK_SECTIONS=(
  "## Gates|"
  "## Schema changes|the project has no schema"
  "## Data isolation|the project has nothing to isolate"
  "## Generated files|the project has no generated files"
)
exec node "$HERE/lane-check.mjs" "${STACK_SECTIONS[@]}"
