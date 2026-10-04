#!/usr/bin/env bash
# An agent's commits are authored as the lane's App and carry the delegate's sign-off
# (K-AGENT-44, kanon#234). Run by `agent-setup` on every lane, after the checkout and the
# project-setup hook and before the agent.
#
# WHY THE LANE DOES THIS, NOT THE ADOPTER. A repository that runs Kanon's `dco` check passes
# an agent's commit only when its author is an App in the register (`docs/qa/agent-identities.md`)
# and it carries the `Signed-off-by:` of the person the adopter delegated
# (`docs/qa/sign-off-delegation.md`). claude-code-action writes its own default bot,
# `claude[bot]`, into the checkout's git config, which no register lists, and nothing adds a
# sign-off. So before the agent starts this:
#
#   1. writes the App's bot identity to `$GITHUB_ENV` as GIT_AUTHOR_* and GIT_COMMITTER_*.
#      These outrank `user.name`/`user.email` in any git config, so every commit the agent or a
#      later step of the job makes is authored `<slug>[bot] <id+slug[bot]@users.noreply.…>`,
#      whatever the action writes. `agentSlug` in `actions/dco/dco.mjs` recognises the login
#      everywhere, and the noreply email on github.com only: on GitHub Enterprise Server the
#      address is `users.noreply.<host>`, and the agent is recognised by its login alone.
#   2. when the default branch records a delegation, points git at a hooks directory outside
#      the workspace whose `commit-msg` adds the delegate's `Signed-off-by:`. The record is
#      read from the DEFAULT branch, as the `dco` check reads it (K-MERGE-17), and parsed with
#      the check's own `parseDelegation`, so the trailer and the check can't disagree.
#
# THE PROJECT'S OWN HOOKS STILL RUN. The directory is set with GIT_CONFIG_COUNT in
# `$GITHUB_ENV`, which outranks the repository's `core.hooksPath` (an `npm install` that
# re-runs husky can't undo it) and changes no file in the workspace. Every hook the project
# had when this ran is called from it under its own path (a hook the project installs later in
# the job, such as an agent running `pre-commit install`, isn't wrapped, so git won't run it), and `commit-msg` adds the sign-off first and then
# calls the project's own, so a commit-msg linter sees the trailer it may require.
#
# No record adds no trailer, and says so: the agent's commits then fail the `dco` check, which
# is the rule's own outcome for a repository that delegates nothing. A malformed record, or a
# read that fails, warns the same way. A bot account that can't be read fails the step: every
# commit the agent made would be authored by an identity no register lists.
#
# Inputs, by environment only: APP_SLUG, GH_TOKEN (to read the bot account and the record),
# GITHUB_REPOSITORY, GITHUB_ENV, RUNNER_TEMP, and DCO_MJS (the `dco` action's parser, in the
# same Kanon tree as this block).
set -euo pipefail

if [ -z "${APP_SLUG:-}" ]; then
  echo "::error title=agent-setup::no app-slug was passed, so the agent's commits can't be authored as its App"
  exit 1
fi

bot="${APP_SLUG}[bot]"
err="$(mktemp)"
if ! id="$(gh api "users/${APP_SLUG}%5Bbot%5D" --jq .id 2>"$err")" || ! [[ "$id" =~ ^[0-9]+$ ]]; then
  echo "::error title=agent-setup::could not read the account id of $bot: $(cat "$err")"
  exit 1
fi
host="${GITHUB_SERVER_URL:-https://github.com}"
host="${host#*://}"
host="${host%%/*}"
email="${id}+${bot}@users.noreply.${host}"
{
  echo "GIT_AUTHOR_NAME=$bot"
  echo "GIT_AUTHOR_EMAIL=$email"
  echo "GIT_COMMITTER_NAME=$bot"
  echo "GIT_COMMITTER_EMAIL=$email"
} >> "$GITHUB_ENV"
echo "The agent commits as $bot <$email>"

record=docs/qa/sign-off-delegation.md
nodelegation() {
  echo "::$1 title=agent-setup::$2, so no sign-off is delegated and $bot's commits will fail a dco check (K-AGENT-44)"
  exit 0
}
if ! text="$(gh api "repos/${GITHUB_REPOSITORY}/contents/${record}" -H 'Accept: application/vnd.github.raw' 2>"$err")"; then
  if grep -q 'HTTP 404' "$err"; then
    nodelegation notice "the default branch has no $record (or this token can't read the repository's contents)"
  fi
  nodelegation warning "$record could not be read from the default branch ($(head -c 300 "$err"))"
fi
if ! signoff="$(node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  import { readFileSync } from "node:fs";
  // The path comes by environment, not argv: dco.mjs runs its check when argv[1] is itself.
  const { parseDelegation } = await import(pathToFileURL(process.env.DCO_MJS).href);
  const r = parseDelegation(readFileSync(0, "utf8"));
  if ("problem" in r) { console.error(r.problem); process.exit(1); }
  console.log(`Signed-off-by: ${r.delegate.name} <${r.delegate.email}>`);
' <<<"$text" 2>"$err")"; then
  nodelegation warning "$record on the default branch is malformed: $(head -c 300 "$err")"
fi

# The project's hooks directory, absolute: `core.hooksPath` when it is set (husky sets one),
# else `.git/hooks`. Read from the top of the work tree, where a relative path is resolved.
cd "$(git rev-parse --show-toplevel)"
project="$(git rev-parse --git-path hooks)"
case "$project" in /*) ;; *) project="$PWD/$project" ;; esac

hooks="$(mktemp -d "${RUNNER_TEMP:-/tmp}/kanon-git-hooks.XXXXXX")"
# Every hook the project has keeps running, called under its own path (a husky hook finds its
# helper next to itself). `printf %q` keeps a path with spaces intact.
if [ -d "$project" ]; then
  for f in "$project"/*; do
    name="$(basename "$f")"
    case "$name" in *.sample | commit-msg) continue ;; esac
    [ -f "$f" ] && [ -x "$f" ] || continue
    printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$f" > "$hooks/$name"
    chmod +x "$hooks/$name"
  done
fi
{
  printf '#!/usr/bin/env bash\n'
  printf '# Written by Kanon'"'"'s agent-setup block (agent-commits.sh): the delegate'"'"'s sign-off, then the project'"'"'s own commit-msg hook.\n'
  printf 'git interpret-trailers --in-place --if-exists addIfDifferent --trailer %q "$1"\n' "$signoff"
  printf 'if [ -x %q ]; then exec %q "$@"; fi\n' "$project/commit-msg" "$project/commit-msg"
} > "$hooks/commit-msg"
chmod +x "$hooks/commit-msg"

n="${GIT_CONFIG_COUNT:-0}"
{
  echo "GIT_CONFIG_KEY_${n}=core.hooksPath"
  echo "GIT_CONFIG_VALUE_${n}=$hooks"
  echo "GIT_CONFIG_COUNT=$((n + 1))"
} >> "$GITHUB_ENV"
echo "Every commit gets \"$signoff\" ($record on the default branch)"
