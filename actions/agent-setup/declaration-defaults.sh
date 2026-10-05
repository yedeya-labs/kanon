#!/usr/bin/env bash
# Kanon's defaults for the declarations a project leaves out (plan 0005 §5.2, K-LAYOUT-17).
#
# A lane's prompt sends the agent to the project's playbooks and stack document at their fixed
# paths. A project may leave a playbook out: the lane then reads Kanon's baseline for that role,
# from the Kanon tree the lane runs at (`rulebook/templates/playbooks/`, the release the adopter
# pinned). This copies each missing playbook into place in the workspace, before the agent starts,
# and keeps it out of every commit through the repository's own `info/exclude`, so the agent reads
# the default at the path the prompt names and never commits it. A project that writes its own
# playbook gets its own, unchanged.
#
# The stack document's `## Schema changes`, `## Data isolation` and `## Generated files` may be
# left out too, and then mean none (K-LAYOUT-17): there is nothing to copy, so this only says so.
# `## Gates` has no default; lane-check fails a stack document without it.
#
# Every default it takes is one line in the log and in the job's summary. Run from the root of the
# checkout. Not a git checkout (a lane that checks nothing out): there is nothing to read, and it
# says so and exits 0.
#
# ENV  KANON_ROOT  Kanon's tree (default: this script's ../..)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KANON_ROOT="${KANON_ROOT:-$HERE/../..}"
BASELINES="$KANON_ROOT/rulebook/templates/playbooks"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

say() {
  echo "$1"
  echo "- $1" >> "$SUMMARY"
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "No checkout here, so no declaration is read and no default is taken."
  exit 0
fi
exclude="$(git rev-parse --git-path info/exclude)"

for baseline in "$BASELINES"/*-playbook.md; do
  [ -f "$baseline" ] || continue
  f="docs/qa/$(basename "$baseline")"
  [ -e "$f" ] && continue
  mkdir -p docs/qa "$(dirname "$exclude")"
  cp "$baseline" "$f"
  grep -qxF "/$f" "$exclude" 2>/dev/null || echo "/$f" >> "$exclude"
  say "$f doesn't exist, so the lane reads Kanon's baseline for it (plan 0005 §5.2, K-LAYOUT-17)"
done

STACK=docs/qa/stack.md
if [ -f "$STACK" ]; then
  while IFS='|' read -r heading means; do
    n="$(awk -v h="$heading" '/^[ \t]*(```|~~~)/ { f = !f; next } !f && $0 == h { n++ } END { print n + 0 }' "$STACK")"
    [ "$n" = 0 ] && say "$STACK has no \`$heading\`, so Kanon's default applies: $means (K-LAYOUT-17)"
  done <<'SECTIONS'
## Schema changes|the project has no schema
## Data isolation|the project has nothing to isolate
## Generated files|the project has no generated files
SECTIONS
fi
exit 0
