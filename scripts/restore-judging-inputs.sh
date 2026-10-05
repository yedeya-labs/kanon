#!/usr/bin/env bash
#
# Restore a judging lane's inputs from the repository's DEFAULT branch, never from the pull
# request it judges (`K-MERGE-17`, kanon#25). Moved from the reference adopter's
# `restore-agent-docs.sh` (RA-848) at step 4 of plan 0001; what it restores is no longer a
# list of its own but `K-MERGE-17`'s, from `judging-inputs.mjs` beside it.
#
# WHY -----------------------------------------------------------------------
# The review lane checks out the PR's head, so the working tree is the PR's content, and the
# Reviewer reads its playbook, the project's instructions and its configuration BY PATH out of
# that tree. Without this step a PR that rewrites the Reviewer's own gate (verdict rules, the
# follow-up filing convention, a severity floor) is reviewed by a Reviewer bound by the
# rewrite, and only the human merge is left to catch it: the "two green assessments, one
# regression" shape of RA-521/RA-528. The agent runtime restores a fixed list of its own
# (`.claude/`, `CLAUDE.md`, …), but not `docs/` or `AGENTS.md`, and the reference adopter
# found each missing file separately, after the gap existed. One list closes the class.
#
# THE DEFAULT BRANCH, NOT THE PR'S BASE (kanon#62). On a stacked PR the base is another PR's
# branch, which that PR's author can write: a register row or a playbook edit there would
# judge the PR stacked on top. Only merged, reviewed changes reach the default branch.
#
# WHAT ----------------------------------------------------------------------
# For each path in the set, the default branch's blob overwrites the working tree, and the
# PR's own version (when it differs) is copied to `$PARK_DIR/<same path>`, so the change is
# still REVIEWABLE: it stops being an instruction, not part of the diff. A path the PR ADDS
# where the default branch has none is parked and then removed: inputs arrive from the
# default branch or not at all (fail closed). The DIFF under review is unaffected: the
# Reviewer reads it from `gh pr diff`, not from the working tree.
#
# THE SET is `judging-inputs.mjs restore-set`: every input at the default branch's commit
# (`K-MERGE-17`'s rows, closed over the markdown documents they delegate to), plus every
# tracked path in the working tree that matches a row. The spec corpus is never in it
# (`K-SPEC-1`): a behaviour change ships its spec update in the same PR, and pinning the
# specs would make the Reviewer flag a correct update as wrong.
#
# THE RESIDUE. On both automatic triggers the reviewing workflow is not the PR's:
# `workflow_run` runs the default branch's caller and `pull_request_target` the base branch's,
# and this script is Kanon's, read from the action cache at the tag the caller pins, so a PR
# cannot edit the guard reviewing it. The calling step records a digest of what this pinned
# (`judging-inputs.mjs manifest`), and the lane refuses the review if the PR's own install
# scripts changed it before the agent starts. What remains is a `workflow_dispatch` on a PR's
# own ref, which runs that ref's caller, and the human merge.
#
# KANON'S BASELINE PLAYBOOKS, BEFORE THE PIN (plan 0005 §5.2, kanon#316). A playbook the default
# branch doesn't have is Kanon's baseline for the role (`K-LAYOUT-17`), put in place by
# `agent-setup`'s defaults step. On the review lane that step runs after the calling step has
# recorded the pin, and the pin is "every input on disk", so a baseline copied there would
# read as a file something on the runner added, and the lane would refuse every review as
# tampered. So this script takes the same defaults itself, last, after every PR-added input
# has been removed: the pin records the baseline, and `agent-setup`'s step then finds every
# playbook in place and copies nothing. The baseline comes from Kanon's tree beside this
# script, never from the PR's.
#
# Inputs:  DEFAULT_REF  (required) the repository's default branch, e.g. `main`
#          PARK_DIR     (optional) where the PR's copies go; default `.qa-pr`
# Prints `sha=<commit>` on its last line: the default branch's commit it restored from.
# Exits non-zero, failing the job, if the default branch cannot be resolved or the set is
# empty. Running the Reviewer on PR-controlled inputs IS the bug, so there is no best-effort
# fallback.

set -euo pipefail

DEFAULT_REF="${DEFAULT_REF:?DEFAULT_REF (the repository default branch, e.g. main) is required}"
PARK_DIR="${PARK_DIR:-.qa-pr}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

cd "$(git rev-parse --show-toplevel)"

# Resolve the default branch. Fetch FIRST and prefer it: `actions/checkout` does a shallow,
# single-branch fetch of the head, so `refs/remotes/origin/$DEFAULT_REF` is normally absent in
# CI, and where a stale local copy does exist, the freshly fetched tip is the one that was
# actually reviewed and merged. The local fallbacks keep the script runnable (and testable) in
# a repository with no `origin`.
resolve_default() {
  if git fetch --no-tags --depth=1 origin "$DEFAULT_REF" >/dev/null 2>&1; then
    git rev-parse FETCH_HEAD && return 0
  fi
  git rev-parse --verify --quiet "refs/remotes/origin/$DEFAULT_REF" && return 0
  git rev-parse --verify --quiet "refs/heads/$DEFAULT_REF" && return 0
  return 1
}

if ! BASE_SHA="$(resolve_default)"; then
  echo "::error::restore-judging-inputs: cannot resolve the default branch '$DEFAULT_REF' — refusing to run the agent on PR-controlled inputs (K-MERGE-17)." >&2
  exit 1
fi

# `K-MERGE-17`'s set, from the one list. A failure here must not read as "nothing to pin":
# the empty-set guard below is the intended failure surface, because it says why.
paths="$(node "$HERE/judging-inputs.mjs" restore-set "$BASE_SHA")" || paths=""

if [ -z "$paths" ]; then
  echo "::error::restore-judging-inputs: no judging inputs found at '$BASE_SHA' — the default branch holds none of K-MERGE-17's list, or the list could not be read." >&2
  exit 1
fi

# SYMLINKS ARE REPLACED, NEVER WRITTEN THROUGH (RA-859). A PR can commit a guarded
# path — or a directory above it — as a symlink. `cp "$path"` and `>"$path"` both
# follow it, so the restore wrote the base playbook over the link's TARGET (any
# file in the workspace, or outside it with an absolute link) and parked the
# target's bytes as "what the PR did", while the guarded path stayed a symlink.
# Reading it afterwards still gave base content, so RA-848's guarantee held; but the
# PR chose the destination of a write, and a clobbered file the Reviewer later
# greps would show him something the PR never contained. So a symlink is parked
# AS a symlink (`cp -P`: evidence of what the PR did, not its target's content)
# and removed, and the restored blob is written into a fresh regular file.
#
# The park directory is guarded the same way. Anything the PR itself put there — the
# directory as a link, a link inside it, or "parked" copies it forged — is TRACKED,
# while everything this script parks is untracked (and excluded below). So a tracked
# entry under it, or the directory itself being a link, refuses the run. Untracked
# content is left alone: this script may run twice in one job, and its own parked
# links from the first run are expected there.
if [ -L "$PARK_DIR" ] || [ -n "$(git ls-files -- "$PARK_DIR" 2>/dev/null)" ]; then
  echo "::error::restore-judging-inputs: $PARK_DIR is a symlink or holds files this PR commits — refusing to park PR content into a directory the PR controls (RA-859)." >&2
  exit 1
fi

park() {
  mkdir -p "$PARK_DIR/$(dirname "$1")"
  if [ -L "$1" ]; then cp -P "$1" "$PARK_DIR/$1"; else cp "$1" "$PARK_DIR/$1"; fi
}

# Every symlinked DIRECTORY above <path>, outermost first, is parked and removed,
# so neither the read nor the write below can leave the tree through one.
detach_symlinked_dirs() {
  local dir chain=()
  dir="$(dirname "$1")"
  while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
    chain=("$dir" ${chain[@]+"${chain[@]}"})
    dir="$(dirname "$dir")"
  done
  for dir in ${chain[@]+"${chain[@]}"}; do
    if [ -L "$dir" ]; then
      park "$dir"
      rm -f "$dir"
      echo "::notice::restore-judging-inputs: $dir is a symlink in this PR — replaced (link parked at $PARK_DIR/$dir)"
    fi
  done
}

restored=()
removed=()
# One notice per path, saying where ITS PR version went. Not always
# `$PARK_DIR/<path>`: a path under a symlinked directory stopped existing when
# `detach_symlinked_dirs` parked that LINK, and a path the PR deleted had nothing
# to park — naming a parked copy there pointed a reader at a missing file (RA-2468).
restored_notices=()
removed_notices=()

while IFS= read -r path; do
  [ -n "$path" ] || continue

  in_base=no
  if git cat-file -e "$BASE_SHA:$path" 2>/dev/null; then in_base=yes; fi

  detach_symlinked_dirs "$path"

  # Already identical → nothing to park, nothing to restore. Keeps repeat runs
  # (and the overwhelmingly common PR that touches no playbook) a true no-op.
  # A symlink is never "identical", even to a target holding base's bytes: the
  # guarded path must end up a regular file (RA-859).
  if [ "$in_base" = yes ] && [ -f "$path" ] && [ ! -L "$path" ] \
     && git cat-file blob "$BASE_SHA:$path" | cmp -s - "$path"; then
    continue
  fi

  # Park the PR's version before it is overwritten — the doc change stays
  # reviewable, it just stops being an instruction. `-L` first: a dangling link
  # fails `-f`, and it is still the PR's entry.
  if [ -L "$path" ] || [ -f "$path" ]; then
    park "$path"
    note="parked at $PARK_DIR/$path"
  else
    note="not parked on its own — the PR deleted it, or it sits under a directory symlink parked as a link above it"
  fi

  if [ "$in_base" = yes ]; then
    # Worktree only (not `git checkout -- `): leaves the index alone so the
    # substitution is visible as a plain working-tree modification. `rm` first so
    # the redirect creates a regular file instead of following a symlink (RA-859).
    rm -f "$path"
    mkdir -p "$(dirname "$path")"
    git cat-file blob "$BASE_SHA:$path" >"$path"
    restored+=("$path")
    restored_notices+=("$path restored from the default branch (PR version $note)")
  else
    rm -f "$path"
    removed+=("$path")
    removed_notices+=("$path removed — added by this PR, absent from the default branch ($note)")
  fi
done <<<"$paths"

# Keep the parked copies out of `git status` so they can't be mistaken for part
# of the PR. Idempotent — this script may run more than once in a job.
exclude_file="$(git rev-parse --git-path info/exclude)"
if ! grep -qxF "/$PARK_DIR/" "$exclude_file" 2>/dev/null; then
  mkdir -p "$(dirname "$exclude_file")"
  printf '/%s/\n' "$PARK_DIR" >>"$exclude_file"
fi

# The baseline for each playbook the default branch lacks, before the caller records the pin.
KANON_ROOT="$HERE/.." PLAYBOOKS_ONLY=1 bash "$HERE/../actions/agent-setup/declaration-defaults.sh"

echo "restore-judging-inputs: default branch '$DEFAULT_REF' → $BASE_SHA"
if [ ${#restored[@]} -eq 0 ] && [ ${#removed[@]} -eq 0 ]; then
  echo "  no judging input differs from the default branch — nothing substituted"
else
  for n in ${restored_notices[@]+"${restored_notices[@]}"} ${removed_notices[@]+"${removed_notices[@]}"}; do
    echo "::notice::restore-judging-inputs: $n"
  done
fi
echo "sha=$BASE_SHA"
