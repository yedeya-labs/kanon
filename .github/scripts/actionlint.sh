#!/usr/bin/env bash
#
# actionlint.sh — run a PINNED actionlint over `.github/`, `$/`-aware (#77).
#
# A TEMPORARY SHIM. actionlint (1.7.12, the latest release when this was written) cannot
# parse GitHub's `$/` self-reference: every `uses: $/...` call is reported as "specifying
# action "$/…" in invalid format because ref is missing", and the call's `with:` inputs are
# then NOT checked against the action's `action.yml`. That input check is what catches a lane
# passing an undeclared or misspelled block input. Upstream:
#   https://github.com/rhysd/actionlint/issues/711
#   https://github.com/rhysd/actionlint/issues/732
# DROP THE REWRITE (the `perl -pi` below and the snippet restore) once a released actionlint
# supports `$/`: bump ACTIONLINT_VERSION and its checksums, delete the rewrite, and
# `tests/unit/actionlint.test.ts`'s red-on-undeclared-input case keeps proving the input
# check still runs.
#
# WHAT IT DOES
#   1. Copies `.github/` and `actions/` to a temporary directory (with an empty `.git/`, which
#      is how actionlint finds a project root). The real tree is never written.
#   2. In the COPY only, rewrites `uses: $/` to `uses: ./` on `uses:` lines. Both forms name
#      a path from the repository root, and the files exist in the repository, so the local
#      form resolves and actionlint checks every input. `$/` and `./` are the same length, so
#      every reported line AND column is the real file's.
#   3. Runs the pinned actionlint there: downloaded once, the archive checked against the
#      release's sha256, then kept in a cache. The cached BINARY's own sha256 is pinned too
#      and checked on every run, so a stale or tampered cache entry is replaced, never run.
#   4. Maps what it prints back to the real files: the temp root becomes the real root, and
#      each quoted snippet line is replaced by the real file's line, so a snippet shows
#      `$/` where the source has it. Messages still name a rewritten call in its `./` form,
#      and the snippet restore reads the default text format only (not `-format` output).
#   5. Exits with actionlint's own code (0 clean, 1 findings, 2 bad flags, 3 fatal). A
#      failure of the wrapper itself (download, checksum, unsupported platform) exits 3.
#
# DELIBERATELY NOT RUN: shellcheck and pyflakes. actionlint calls them when they are on
# PATH, which makes its verdict depend on the machine: ubuntu-latest ships shellcheck, a
# laptop often does not. Pass `-shellcheck=shellcheck` to opt in; it overrides the default.
#
# WHAT IT CANNOT SEE: actionlint lints workflows, not composite `action.yml` files, so a call
# NESTED in a block (`agent-finish` → `agent-classify`, `agent-telemetry`) has its inputs
# unchecked here. A call to an action directory that does not exist is skipped silently,
# `./` or `$/` alike. And a released Kanon action (`yedeya-labs/kanon/actions/...@vX.Y.Z`)
# is remote, so actionlint checks none of its inputs.
#
# USAGE   .github/scripts/actionlint.sh [actionlint flags…]
#         Extra arguments go to actionlint unchanged (e.g. `-oneline`, `-format …`). FLAGS
#         ONLY: actionlint runs inside the temp copy, so a file argument resolves against the
#         copy (an absolute one names the real, un-rewritten file). With none, it lints all.
# ENV     ACTIONLINT_ROOT       repository root to lint (default: this script's ../..)
#         ACTIONLINT_CACHE_DIR  where the verified binary is kept
#                               (default: $HOME/.cache/kanon-actionlint — deliberately not
#                               XDG_CACHE_HOME, so it is always the path CI caches)
# CI      `.github/workflows/ci.yml`, the actionlint step of the lint job, restores and
#         saves $HOME/.cache/kanon-actionlint keyed on the version below. Each unit-test
#         shard restores it too, for tests/unit/actionlint.test.ts's real-binary cases.
set -euo pipefail

ACTIONLINT_VERSION=1.7.12
# sha256 of each release archive (from the release's actionlint_1.7.12_checksums.txt) and
# of the `actionlint` binary inside it (measured from those verified archives).
archive_sha() {
  case "$1" in
    linux_amd64)  echo 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
    linux_arm64)  echo 325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
    darwin_amd64) echo 5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
    darwin_arm64) echo aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
    *) return 1 ;;
  esac
}
binary_sha() {
  case "$1" in
    linux_amd64)  echo c872d6db8c6bf83a8eaa704fc93999f027d55dffbc63b8a6abdccb47df5f4cd4 ;;
    linux_arm64)  echo ac0323433c2853ec3fb978c611430c5b3dc5d43c58d1a1ec031b00ab572beb60 ;;
    darwin_amd64) echo d1f7cee75ae2873609bd9567b4600bebc5315a5e733e73202987a44fafdd53b2 ;;
    darwin_arm64) echo 8db11704dc296f096216db4db65d86cd7f0ebfdf4c38453a1da276b137b88388 ;;
    *) return 1 ;;
  esac
}

# Every failure of the wrapper itself exits 3, so it never reads as actionlint's 1 (findings).
die() { echo "actionlint.sh: $*" >&2; exit 3; }
trap 'echo "actionlint.sh: setup failed at line $LINENO" >&2; exit 3' ERR

ROOT="${ACTIONLINT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ROOT="$(cd "$ROOT" 2>/dev/null && pwd -P)" || die "no such root: $ROOT"
[ -d "$ROOT/.github" ] || die "no .github/ under $ROOT"

CACHE="${ACTIONLINT_CACHE_DIR:-$HOME/.cache/kanon-actionlint}/$ACTIONLINT_VERSION"
BIN="$CACHE/actionlint"

case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) die "unsupported OS $(uname -s)" ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
PLATFORM="${OS}_${ARCH}"
WANT_ARCHIVE="$(archive_sha "$PLATFORM")" || die "no pinned checksum for $PLATFORM"
WANT_BINARY="$(binary_sha "$PLATFORM")" || die "no pinned checksum for $PLATFORM"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# One temp directory for the download, the copy and the output, removed on any exit.
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/actionlint-dollar.XXXXXX")"
TMPD="$(cd "$TMPD" && pwd -P)"
trap 'rm -rf "$TMPD"' EXIT
WORK="$TMPD/repo"
OUT="$TMPD/out"

# The cached binary runs only if its own sha256 is the pinned one.
if ! { [ -x "$BIN" ] && [ "$(sha256 "$BIN")" = "$WANT_BINARY" ]; }; then
  archive="$TMPD/actionlint.tar.gz"
  curl -fsSL --retry 3 -o "$archive" \
    "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_${PLATFORM}.tar.gz" \
    || die "download of actionlint $ACTIONLINT_VERSION failed"
  got="$(sha256 "$archive")"
  [ "$got" = "$WANT_ARCHIVE" ] || die "archive checksum mismatch for actionlint $ACTIONLINT_VERSION $PLATFORM: got $got"
  tar -xzf "$archive" -C "$TMPD" actionlint || die "could not unpack the archive"
  got="$(sha256 "$TMPD/actionlint")"
  [ "$got" = "$WANT_BINARY" ] || die "binary checksum mismatch for actionlint $ACTIONLINT_VERSION $PLATFORM: got $got"
  mkdir -p "$CACHE"
  mv -f "$TMPD/actionlint" "$BIN"
fi

mkdir "$WORK"
cp -R "$ROOT/.github" "$WORK/.github"
# The lanes call Kanon's own actions by `$/actions/<name>`; after the rewrite they are local
# paths, so the actions must be in the copy for their inputs to be checked.
if [ -d "$ROOT/actions" ]; then cp -R "$ROOT/actions" "$WORK/actions"; fi
mkdir "$WORK/.git"
# The shim. Only `uses:` keys (optionally a list item, optionally quoted), never comments.
find "$WORK/.github" -type f \( -name '*.yml' -o -name '*.yaml' \) -exec \
  perl -pi -e 's{^(\s*(?:-\s+)?uses:\s*["\x27]?)\$/}{$1./}' {} +

trap - ERR
set +e
(cd "$WORK" && "$BIN" -no-color -shellcheck= -pyflakes= "$@") >"$OUT" 2>&1
rc=$?
set -e
trap 'echo "actionlint.sh: mapping the output failed at line $LINENO" >&2; exit 3' ERR

# Map back: temp root -> real root, and each `NNN | text` snippet line -> the real line.
WORK="$WORK" ROOT="$ROOT" perl -ne '
  BEGIN { $w = $ENV{WORK}; $r = $ENV{ROOT}; %cache = (); }
  s/\Q$w\E/$r/g;
  if (/^(\S.*?):(\d+):(\d+): /) { $file = $1; $file = "$r/$file" unless $file =~ m{^/}; }
  elsif (defined $file && /^(\s*)(\d+) \| (.*)$/) {
    my ($pad, $n) = ($1, $2);
    if (!exists $cache{$file}) {
      if (open my $fh, "<", $file) { my @l = <$fh>; chomp @l; $cache{$file} = \@l; } else { $cache{$file} = undef; }
    }
    my $lines = $cache{$file};
    $_ = "$pad$n | $lines->[$n - 1]\n" if $lines && defined $lines->[$n - 1];
  }
  print;
' "$OUT"
exit "$rc"
