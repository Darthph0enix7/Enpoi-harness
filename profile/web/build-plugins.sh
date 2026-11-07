#!/usr/bin/env bash
# Rebuild or verify every enpoi-* profile plugin bundle with the canonical
# esbuild flags.
#
# Harness packages and schemastery stay external (they resolve at runtime from
# the profile's node_modules links into the harness workspace); everything else
# is inlined. Run after any plugin source port, then restart dsh-web.service.
#
# Freshness is content-based, not mtime-based. `scripts/profile-bundle-
# fingerprint.mjs` writes one map at `<profile-root>/.bundle-fingerprints.json`
# with, per plugin, a SHA-256 of the build inputs (src TypeScript/JavaScript/
# JSON plus package.json/tsconfig.json), a SHA-256 of lib/index.js, and a
# SHA-256 of the canonical build flags. A shipped prebuilt bundle is skipped
# only when all three match, so a source edit with a preserved timestamp still
# rebuilds and a truncated/tampered bundle is restored. Missing entries request
# a build: source checkouts and older installs can never silently keep a stale
# bundle.
#
# A build hashes its sources before esbuild and again before publishing the
# temporary output. If the hash moved, the temporary bundle is discarded and
# the previous lib/index.js plus fingerprint stay in place. The record step
# also revalidates that pre-build hash, so a build cannot bless bytes from one
# source revision with a hash from another. Source symlinks are rejected by the
# helper rather than silently ignored.
#
# The release workflow passes FORCE_BUILD=1. That is the authoritative
# all-bundle build: every lib/index.js is regenerated and every fingerprint is
# rewritten before the artifact is staged, so the shipped map describes the
# bytes in that tarball. Prebuilt installs then verify that map without needing
# esbuild.
#
# esbuild is deliberately resolved as an argv array, never a command string:
# paths with spaces stay a single executable argument. ESBUILD_BIN, when set,
# is one executable path (or a JS entry run with node). There is no
# `pnpm exec`/`npm exec` fallback because those commands may install into the
# profile; changed sources need a real esbuild binary, and a verified prebuilt
# release needs none.
#
# Usage: bash build-plugins.sh [profile-root]
# Env: FORCE_BUILD=1  rebuild every bundle even when its fingerprint matches
#      ESBUILD_BIN=/path/to/esbuild  explicit esbuild binary (single path)
set -u

PROFILE_ROOT_INPUT="${1:-$HOME/.dsh/profiles/web}"
if ! PROFILE_ROOT="$(cd "$PROFILE_ROOT_INPUT" 2>/dev/null && pwd -P)"; then
  echo "FAIL profile root is not a directory: $PROFILE_ROOT_INPUT" >&2
  exit 1
fi
PACKAGES_DIR="$PROFILE_ROOT/packages"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
FINGERPRINT_HELPER="$SCRIPT_DIR/scripts/profile-bundle-fingerprint.mjs"
FINGERPRINT_FILE="$PROFILE_ROOT/.bundle-fingerprints.json"

if [ ! -d "$PACKAGES_DIR" ]; then
  echo "FAIL profile has no packages directory: $PACKAGES_DIR" >&2
  exit 1
fi
if [ ! -f "$FINGERPRINT_HELPER" ]; then
  echo "FAIL profile fingerprint helper is missing: $FINGERPRINT_HELPER" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-${NODE:-node}}"
case "$NODE_BIN" in
  */*) ;;
  *) NODE_BIN="$(command -v "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")" ;;
esac
if [ ! -x "$NODE_BIN" ]; then
  echo "FAIL node is not executable: $NODE_BIN" >&2
  exit 1
fi

# Using the helper as the flag source keeps the hashed argv and the argv passed
# to esbuild identical.
if ! FLAGS_OUT="$("$NODE_BIN" "$FINGERPRINT_HELPER" flags 2>&1)"; then
  echo "FAIL could not read canonical build flags: $FLAGS_OUT" >&2
  exit 1
fi
BUILD_ARGS=()
while IFS= read -r flag; do
  [ -n "$flag" ] && BUILD_ARGS[${#BUILD_ARGS[@]}]="$flag"
done <<< "$FLAGS_OUT"
if [ ${#BUILD_ARGS[@]} -eq 0 ]; then
  echo "FAIL canonical build flag list is empty" >&2
  exit 1
fi

# Locate esbuild directly. Keep each candidate as an argv element so a path
# containing spaces is never split; the old `ESBUILD_BIN='node path'` string
# form is intentionally gone.
ESBUILD_CMD=()
if [ -n "${ESBUILD_BIN:-}" ]; then
  if [ -x "$ESBUILD_BIN" ]; then
    ESBUILD_CMD=("$ESBUILD_BIN")
  elif [ -f "$ESBUILD_BIN" ]; then
    ESBUILD_CMD=("$NODE_BIN" "$ESBUILD_BIN")
  else
    echo "FAIL ESBUILD_BIN is not a file: $ESBUILD_BIN" >&2
    exit 1
  fi
elif [ -x "$PROFILE_ROOT/node_modules/.bin/esbuild" ]; then
  ESBUILD_CMD=("$PROFILE_ROOT/node_modules/.bin/esbuild")
elif [ -n "${HARNESS_ROOT:-}" ] && [ -x "$HARNESS_ROOT/node_modules/.bin/esbuild" ]; then
  ESBUILD_CMD=("$HARNESS_ROOT/node_modules/.bin/esbuild")
elif [ -x "$PROFILE_ROOT/../../harness/current/node_modules/.bin/esbuild" ]; then
  ESBUILD_CMD=("$PROFILE_ROOT/../../harness/current/node_modules/.bin/esbuild")
elif [ -f "$PROFILE_ROOT/node_modules/esbuild/bin/esbuild" ]; then
  ESBUILD_CMD=("$NODE_BIN" "$PROFILE_ROOT/node_modules/esbuild/bin/esbuild")
elif [ -n "${HARNESS_ROOT:-}" ] && [ -f "$HARNESS_ROOT/node_modules/esbuild/bin/esbuild" ]; then
  ESBUILD_CMD=("$NODE_BIN" "$HARNESS_ROOT/node_modules/esbuild/bin/esbuild")
elif [ -f "$PROFILE_ROOT/../../harness/current/node_modules/esbuild/bin/esbuild" ]; then
  ESBUILD_CMD=("$NODE_BIN" "$PROFILE_ROOT/../../harness/current/node_modules/esbuild/bin/esbuild")
elif command -v esbuild >/dev/null 2>&1; then
  ESBUILD_CMD=("$(command -v esbuild)")
elif (cd "$SCRIPT_DIR" && pnpm exec which esbuild >/dev/null 2>&1); then
  ESBUILD_CMD=(pnpm --dir "$SCRIPT_DIR/../.." exec esbuild)
fi

ERRDIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-profile-build.XXXXXX")" || exit 1
TMP_OUT=""
cleanup() {
  if [ -n "${TMP_OUT:-}" ]; then
    rm -f "$TMP_OUT"
  fi
}
trap cleanup EXIT

cd "$PACKAGES_DIR" || exit 1

fail=0
for dir in enpoi-*/; do
  [ -d "$dir" ] || continue
  pkg="${dir%/}"
  [ -f "$pkg/src/index.ts" ] || { echo "SKIP (no src/index.ts): $pkg"; continue; }

  build_reason=""
  if [ "${FORCE_BUILD:-0}" = 1 ]; then
    build_reason="forced by FORCE_BUILD=1"
  else
    check_out="$("$NODE_BIN" "$FINGERPRINT_HELPER" check "$PROFILE_ROOT" "$pkg" 2>&1)"
    check_rc=$?
    if [ "$check_rc" -eq 0 ]; then
      echo "OK   $pkg  ($(du -h "$pkg/lib/index.js" | cut -f1)) (prebuilt fingerprint verified)"
      continue
    fi
    if [ "$check_rc" -ne 3 ]; then
      echo "FAIL $pkg  — fingerprint check failed: $check_out"
      fail=1
      continue
    fi
    build_reason="${check_out#STALE $pkg: }"
    [ "$build_reason" = "$check_out" ] && build_reason="$check_out"
  fi

  # Capture the inputs before esbuild reads them. This also rejects a
  # symlinked/otherwise unhashable source explicitly instead of building a
  # bundle whose freshness cannot be verified.
  source_before="$("$NODE_BIN" "$FINGERPRINT_HELPER" source-hash "$PROFILE_ROOT" "$pkg" 2>&1)"
  source_rc=$?
  if [ "$source_rc" -ne 0 ]; then
    echo "FAIL $pkg  — source fingerprint failed: $source_before"
    fail=1
    continue
  fi

  if [ ${#ESBUILD_CMD[@]} -eq 0 ]; then
    echo "FAIL $pkg  — esbuild not found; cannot rebuild ($build_reason)"
    echo "     Prebuilt bundles verify from $FINGERPRINT_FILE; edited sources need an esbuild binary."
    fail=1
    continue
  fi

  if ! mkdir -p "$pkg/lib"; then
    echo "FAIL $pkg  — cannot create $pkg/lib"
    fail=1
    continue
  fi
  if ! TMP_OUT="$(mktemp "$PROFILE_ROOT/packages/$pkg/lib/.index.js.XXXXXX")"; then
    echo "FAIL $pkg  — cannot create a temporary output file"
    fail=1
    continue
  fi
  # mktemp creates 0600; the bundle keeps normal readable artifact permissions.
  chmod 0644 "$TMP_OUT" 2>/dev/null || true

  echo "BUILD $pkg  ($build_reason)"
  build_ok=0
  if (cd "$pkg" && "${ESBUILD_CMD[@]}" "${BUILD_ARGS[@]}" "--outfile=$TMP_OUT" --log-level=warning 2>"$ERRDIR/build-$pkg.err"); then
    build_ok=1
  fi

  if [ "$build_ok" = 1 ] && [ -s "$TMP_OUT" ]; then
    source_after="$("$NODE_BIN" "$FINGERPRINT_HELPER" source-hash "$PROFILE_ROOT" "$pkg" 2>&1)"
    source_after_rc=$?
    if [ "$source_after_rc" -ne 0 ]; then
      rm -f "$TMP_OUT"
      TMP_OUT=""
      echo "FAIL $pkg  — source fingerprint failed after build: $source_after"
      fail=1
      continue
    fi
    if [ "$source_after" != "$source_before" ]; then
      rm -f "$TMP_OUT"
      TMP_OUT=""
      echo "FAIL $pkg  — source inputs changed during build; previous bundle and fingerprint preserved"
      fail=1
      continue
    fi
    if mv -f "$TMP_OUT" "$pkg/lib/index.js"; then
      TMP_OUT=""
      if record_out="$("$NODE_BIN" "$FINGERPRINT_HELPER" record "$PROFILE_ROOT" "$pkg" "$source_before" 2>&1)"; then
        echo "OK   $pkg  ($(du -h "$pkg/lib/index.js" | cut -f1))"
      else
        echo "FAIL $pkg  — lib/index.js rebuilt but fingerprint record failed: $record_out"
        fail=1
      fi
    else
      rm -f "$TMP_OUT"
      TMP_OUT=""
      echo "FAIL $pkg  — could not move the rebuilt bundle into $pkg/lib/index.js"
      fail=1
    fi
  else
    rm -f "$TMP_OUT"
    TMP_OUT=""
    echo "FAIL $pkg  — see $ERRDIR/build-$pkg.err"
    sed -n '1,5p' "$ERRDIR/build-$pkg.err"
    fail=1
  fi
done
[ "$fail" = 0 ] && rm -rf "$ERRDIR"
exit $fail
