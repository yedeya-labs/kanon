/**
 * A PR's effective patch at a commit, as `gh api repos/{o}/{r}/compare/BASE...SHA`
 * returns it under the `application/vnd.github.v3.diff` media type.
 *
 * Both revise lanes fingerprint that diff to answer "did the CONTENT move, or only the
 * SHA" (RA-1841), so both their suites need the same fixture — and, more to the point,
 * the same definition of "the same content". Written once so the two cannot drift into
 * proving different things: `agent-implement-revise.yml` and `agent-lead-revise.yml`
 * carry the filter verbatim, which is how they came to carry the defect verbatim.
 *
 * `churn` is everything a CONTENT-FREE REBASE moves and no reviewer ever read — the
 * blob oids on the `index` line, the hunk header's line numbers, and a context line the
 * base rewrote. `content` is the change itself. PR RA-1822's three heads differed by
 * exactly that much: one hunk header and three context lines, zero content lines.
 */
export const comparePatch = ({ content, churn = 'aaaaaaa' }: { content: string; churn?: string }): string => [
  'diff --git a/scripts/qa/spec-coverage.mjs b/scripts/qa/spec-coverage.mjs',
  `index ${churn}..bbbbbbb 100644`,
  '--- a/scripts/qa/spec-coverage.mjs',
  '+++ b/scripts/qa/spec-coverage.mjs',
  `@@ -${churn.length},7 +${churn.length},7 @@ export function coverage() {`,
  `   const unrelatedBaseLine = '${churn}';`,
  '   const rows = [];',
  '-  return rows;',
  `+  return ${content};`,
  ' }',
].join('\n');

/**
 * The `gh` stub's arm for `gh api .../compare/BASE...SHA` — shared for the same reason.
 *
 * A sha with no entry in `STUB_DIFFS` is an UNREADABLE diff (a 404, a compare truncated
 * at 300 files), and the stub fails the way `gh` does so the SHA fallback is exercised
 * rather than assumed. Interpolated into a shell script, so `${...}` is escaped for the
 * template literal that carries it.
 */
export const GH_COMPARE_ARM = `if [ "\${1:-}" = "api" ]; then
  sha="\${2##*...}"
  out="$(printf '%s' "\${STUB_DIFFS:-null}" | jq -r --arg sha "$sha" 'if type == "object" then (.[$sha] // "") else "" end')"
  [ -n "$out" ] || exit 1
  printf '%s\\n' "$out"
  exit 0
fi`;
