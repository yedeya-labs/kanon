#!/usr/bin/env bash
# Reads the project's test-database declaration for the test-database block (kanon#18).
#
# ENV  WANTED  'true' when the lane needs a database; anything else reads nothing
#      FROM    a commit to read the declaration from; empty reads the working tree
# Writes `kind` and `database` to $GITHUB_OUTPUT. Exits 1, by name, on a malformed one.
set -euo pipefail

FILE=docs/qa/test-database.md
OUT="${GITHUB_OUTPUT:-/dev/stdout}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${WANTED:-}" != true ]; then
  echo "This lane needs no database; the declaration is not read."
  { echo "kind="; echo "database=false"; } >> "$OUT"
  exit 0
fi

src="$(mktemp)"
if [ -n "${FROM:-}" ]; then
  # An unreadable commit is not an absent file: say so rather than read it as "none".
  if ! git cat-file -e "$FROM^{commit}" 2>/dev/null; then
    echo "::error file=$FILE,title=test database::cannot read the commit ${FROM:0:12} to find $FILE; fetch it (a shallow clone lacks it) rather than reading it as no declaration"
    exit 1
  fi
  git show "$FROM:$FILE" > "$src" 2>/dev/null || : > "$src.absent"
  where="$FILE at ${FROM:0:12}"
else
  if [ -f "$FILE" ]; then cp "$FILE" "$src"; else : > "$src.absent"; fi
  where="$FILE"
fi

if [ -e "$src.absent" ]; then
  kind=none
  echo "No $where: the project declares no test database, so none is started."
elif ! kind="$(awk -f "$HERE/declaration.awk" "$src" 2> "$src.err")"; then
  echo "::error file=$FILE,title=test database::$where $(cat "$src.err")"
  exit 1
else
  echo "$where declares \`$kind\`."
fi

database=false
[ "$kind" = none ] || database=true
{ echo "kind=$kind"; echo "database=$database"; } >> "$OUT"
