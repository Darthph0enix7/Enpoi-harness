#!/usr/bin/env bash
# Rebuild every enpoi-* profile plugin bundle with the canonical esbuild flags.
#
# Harness packages and schemastery stay external (they resolve at runtime from
# the profile's node_modules links into the harness workspace); everything else
# is inlined. Run after any plugin source port, then restart dsh-web.service.
set -u
PROFILE_ROOT="${1:-$HOME/.dsh/profiles/web}"
cd "$PROFILE_ROOT/packages" || exit 1
ERRDIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-profile-build.XXXXXX")" || exit 1

fail=0
for dir in enpoi-*/; do
  pkg="${dir%/}"
  [ -f "$pkg/src/index.ts" ] || { echo "SKIP (no src/index.ts): $pkg"; continue; }

  # Skip rebuild if prebuilt bundle exists and source has not been modified
  if [ "${FORCE_BUILD:-0}" != 1 ] && [ -f "$pkg/lib/index.js" ] && [ ! "$pkg/src/index.ts" -nt "$pkg/lib/index.js" ]; then
    echo "OK   $pkg  ($(du -h "$pkg/lib/index.js" | cut -f1)) (prebuilt)"
    continue
  fi

  if pnpm --dir "$pkg" exec esbuild src/index.ts \
      --bundle --format=esm --platform=node --target=node22 \
      --external:@deepseek-ai/* --external:schemastery --external:dsh-enpoi-* \
      --outfile=lib/index.js --log-level=warning 2>"$ERRDIR/build-$pkg.err"; then
    echo "OK   $pkg  ($(du -h "$pkg/lib/index.js" | cut -f1))"
  else
    echo "FAIL $pkg  — see $ERRDIR/build-$pkg.err"
    sed -n '1,5p' "$ERRDIR/build-$pkg.err"
    fail=1
  fi
done
[ "$fail" = 0 ] && rm -rf "$ERRDIR"
exit $fail
