# Reads the test-database declaration (docs/qa/test-database.md, K-LAYOUT-16) and prints the
# kind it declares: `none` or `hook`. Fails, with the reason on stderr, unless
# there is exactly one `**Test database:** `<kind>`` line outside a fenced block and the kind
# is one of those two. A missing FILE is the caller's case (no declaration, so `none`); a
# file that exists declares something, or it is malformed.
#
# The test-database block runs it before a lane starts a database, and lane-check runs it on
# the adopter's checkout, so the two read the declaration one way.
/^[ \t]*(```|~~~)/ { fenced = !fenced; next }
fenced { next }
/^[ \t]*\*\*Test database:\*\*/ {
  lines++
  line = $0
  sub(/[ \t\r]+$/, "", line)
  if (line !~ /^\*\*Test database:\*\* `[^`]*`$/) { bad = $0; next }
  kind = line
  sub(/^\*\*Test database:\*\* `/, "", kind)
  sub(/`$/, "", kind)
}
END {
  if (lines == 0) { print "has no `**Test database:** `<kind>`` line; declare `none` or `hook`, or delete the file" > "/dev/stderr"; exit 1 }
  if (lines > 1) { print "has " lines " `**Test database:**` lines; it declares exactly one" > "/dev/stderr"; exit 1 }
  if (bad != "") { print "reads `" bad "`; the line is exactly **Test database:** followed by the kind in backticks, at column zero" > "/dev/stderr"; exit 1 }
  if (kind != "none" && kind != "hook") { print "declares `" kind "`, which is not a kind Kanon knows: `none`, or `hook` (your project-setup hook starts the database, whatever its engine, and writes DATABASE_URL). Kanon names no engine" > "/dev/stderr"; exit 1 }
  print kind
}
