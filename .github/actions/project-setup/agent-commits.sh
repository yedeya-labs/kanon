#!/usr/bin/env bash
# Kanon's own agents commit as their App, with the delegate's sign-off (K-AGENT-44, ADR 0011).
#
# Called by Kanon's project-setup hook on every lane, and acts only on the lanes whose agent
# commits: the Implementer's two (`implementer`, `implementer-revise`). Every other lane
# returns at once, so the Reviewer's run is unchanged.
#
# WHY THE HOOK DOES THIS. Kanon requires a sign-off on every commit (the `dco` check). An
# agent's commit passes only when its author is an App in the register and it carries the
# delegate's `Signed-off-by:` from `docs/qa/sign-off-delegation.md`. The released lane
# leaves neither to chance on its own: claude-code-action writes its default bot (not the
# minted App) into the checkout's git config, and nothing adds a sign-off. So, before the
# agent starts, this:
#
#   1. writes the App's bot identity to `$GITHUB_ENV` as GIT_AUTHOR_* and GIT_COMMITTER_*,
#      which outrank any `user.name`/`user.email` in git config, so every commit the agent
#      makes is authored `<slug>[bot] <id+slug[bot]@users.noreply.github.com>`;
#   2. installs a `commit-msg` hook that adds the delegate's `Signed-off-by:` trailer to every
#      commit message, read from the checkout's delegation record with the `dco` action's own
#      parser. The check itself reads the record from the default branch, never from here.
#
# No record, or a malformed one, adds no trailer and warns: the agent's commits then fail the
# `dco` check, which is the rule's own outcome for a repository that delegates nothing.
#
# Inputs, by environment only: LANE, APP_SLUG, GH_TOKEN (the minted App token, to read the
# bot account's id), GITHUB_ENV.
set -euo pipefail

case "${LANE:-}" in
  implementer | implementer-revise) ;;
  *) exit 0 ;;
esac

if [ -z "${APP_SLUG:-}" ]; then
  echo "::error title=project-setup::the $LANE lane passed no app-slug, so its commits can't be authored as its App"
  exit 1
fi

bot="${APP_SLUG}[bot]"
err="$(mktemp)"
if ! id="$(gh api "users/${APP_SLUG}%5Bbot%5D" --jq .id 2>"$err")" || ! [[ "$id" =~ ^[0-9]+$ ]]; then
  echo "::error title=project-setup::could not read the account id of $bot: $(cat "$err")"
  exit 1
fi
email="${id}+${bot}@users.noreply.github.com"
{
  echo "GIT_AUTHOR_NAME=$bot"
  echo "GIT_AUTHOR_EMAIL=$email"
  echo "GIT_COMMITTER_NAME=$bot"
  echo "GIT_COMMITTER_EMAIL=$email"
} >> "$GITHUB_ENV"
echo "The $LANE lane commits as $bot <$email>"

record=docs/qa/sign-off-delegation.md
if [ ! -f "$record" ]; then
  echo "::warning title=project-setup::$record is missing, so no sign-off is delegated and $bot's commits will fail the dco check (K-AGENT-44)"
  exit 0
fi
if ! signoff="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { parseDelegation } from "./actions/dco/dco.mjs";
  const r = parseDelegation(readFileSync(process.argv[1], "utf8"));
  if ("problem" in r) { console.error(r.problem); process.exit(1); }
  console.log(`Signed-off-by: ${r.delegate.name} <${r.delegate.email}>`);
' "$record" 2>"$err")"; then
  echo "::warning title=project-setup::$(cat "$err"), so no sign-off is delegated and $bot's commits will fail the dco check (K-AGENT-44)"
  exit 0
fi

hooks="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks"
# The trailer is written into the hook as one quoted argument; `printf %q` keeps a name with
# spaces or quotes intact.
printf '#!/usr/bin/env bash\n# Written by Kanon'"'"'s project-setup hook (agent-commits.sh): the delegate'"'"'s sign-off.\nexec git interpret-trailers --in-place --if-exists addIfDifferent --trailer %q "$1"\n' "$signoff" > "$hooks/commit-msg"
chmod +x "$hooks/commit-msg"
echo "Every commit gets \"$signoff\" ($record)"
