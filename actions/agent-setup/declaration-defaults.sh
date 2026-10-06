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
# THE AGENT IS TOLD WHICH PLAYBOOKS ARE THE BASELINE (kanon#329). A copy sits at the path the
# project's own playbook takes, and git ignores it there, so an agent asked to write that
# playbook edits the copy and then can't commit it: `git add <path>` is refused and `git add -A`
# skips it without a word. So this writes `KANON_BASELINE_PLAYBOOKS` to `$GITHUB_ENV`, the
# baseline copies in the checkout, whichever run made them, and `agent-run` names them in the
# prompt with the remedy, `git add -f`. Written on every run, so the last one is the checkout's.
#
# The review lane's restore (`scripts/restore-judging-inputs.sh`) runs this too, before the lane
# records its pin of the judging inputs, so the pin holds the baseline and this block's later run
# copies nothing (kanon#316). It passes PLAYBOOKS_ONLY, so the stack lines are said once, here.
#
# ENV  KANON_ROOT      Kanon's tree (default: this script's ../..)
#      PLAYBOOKS_ONLY  '1' takes only the playbook defaults
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
  say "$f doesn't exist, so the lane reads Kanon's baseline for it, at a path git ignores (plan 0005 §5.2, K-LAYOUT-17)"
done

# The baseline copies in the checkout: excluded by the line above, and not the project's.
copies=()
for baseline in "$BASELINES"/*-playbook.md; do
  [ -f "$baseline" ] || continue
  f="docs/qa/$(basename "$baseline")"
  [ -f "$f" ] && grep -qxF "/$f" "$exclude" 2>/dev/null && ! git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 \
    && copies+=("$f")
done
[ -n "${GITHUB_ENV:-}" ] && echo "KANON_BASELINE_PLAYBOOKS=${copies[*]:-}" >> "$GITHUB_ENV"

STACK=docs/qa/stack.md
if [ "${PLAYBOOKS_ONLY:-}" != 1 ] && [ -f "$STACK" ]; then
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
