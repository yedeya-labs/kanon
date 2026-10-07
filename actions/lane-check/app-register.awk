# Reads the App register (docs/qa/agent-identities.md, K-LAYOUT-6) and prints the App slug of
# one role, given as `-v role=<Role>`. Fails, with the reason on stderr, unless there is
# exactly one table headed `Role | App slug` outside a fenced block, exactly one row for the
# role, and the slug is in backticks (optionally bold) and spelled as GitHub derives slugs.
# The review lane and the two revise lanes carry this program verbatim, as a
# `REGISTER_AWK` env. tests/unit/lane-check.test.ts holds every such copy to this file.
function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
function unbold(s) {
  s = trim(s)
  if (s ~ /^\*\*.*\*\*$/ || s ~ /^__.*__$/) s = trim(substr(s, 3, length(s) - 4))
  return s
}
/^[ \t]*(```|~~~)/ { fenced = !fenced; intable = 0; next }
fenced { next }
/^[ \t]*\|/ {
  split($0, c, "|")
  if (!intable) {
    if (trim(c[2]) == "Role" && trim(c[3]) == "App slug") { tables++; intable = 1 }
    next
  }
  if (trim(c[2]) ~ /^:?-+:?$/) next
  if (unbold(c[2]) == role) {
    rows++
    slug = unbold(c[3])
    slug = (slug ~ /^`[^`]*`$/) ? substr(slug, 2, length(slug) - 2) : ""
  }
  next
}
{ intable = 0 }
END {
  if (tables != 1) { print "docs/qa/agent-identities.md has " tables + 0 " tables headed | Role | App slug |, not one" > "/dev/stderr"; exit 1 }
  if (rows != 1) { print "docs/qa/agent-identities.md lists the role " role " " rows + 0 " times, not once" > "/dev/stderr"; exit 1 }
  if (slug !~ /^[a-z0-9]+(-[a-z0-9]+)*$/) { print "docs/qa/agent-identities.md gives the role " role " no App slug in backticks" > "/dev/stderr"; exit 1 }
  print slug
}
