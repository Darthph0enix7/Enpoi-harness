#!/usr/bin/env bash
# Prune a staged harness tree before harness-release.yml packs it into a
# prebuilt asset.
#
# The asset carries the full built workspace: a prod-only install fails the
# pruned-tree smoke boot, so this script removes only weight no shipped runtime
# path reads — VCS and non-runtime trees, source maps, incremental build
# metadata, committed specs/tests, Agent Notes, and the README/CHANGELOG/HISTORY
# docs of installed dependencies. `scripts/` (the updater) and `apps/desktop*`
# (unresolved consumer) stay whole, and LICENSE files stay because third-party
# notices read them from node_modules. harness-release.yml boots the result
# before packing, and scripts/prune-release-tree.spec.ts pins every category and
# exclusion here.
#
# Usage: prune-release-tree.sh <tree-root>
set -euo pipefail

TREE="${1:-}"
if [ -z "$TREE" ]; then
  echo "usage: prune-release-tree.sh <tree-root>" >&2
  exit 2
fi
if [ ! -d "$TREE" ]; then
  echo "prune-release-tree: not a directory: $TREE" >&2
  exit 2
fi

# VCS metadata and trees the smoke does not run.
rm -rf "$TREE/.git" "$TREE/docs" "$TREE/snapshots" "$TREE/benchmarks" \
       "$TREE/python" "$TREE/website" "$TREE/dist" "$TREE/coverage"

# Source maps and incremental build metadata are never loaded by the runtime.
find "$TREE" -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete

# Agent Notes are repository documentation; only JSDoc comment links point at
# them. `.agents/skills` stays: the harness loads skills.
rm -rf "$TREE/.agents/notes"

# Committed specs and test trees serve repository development only. Both finds
# skip installed dependencies and the two trees that stay whole: `scripts/`
# (the updater) and `apps/desktop*` (unresolved consumer).
find "$TREE" \
  \( -path '*/node_modules' -o -path '*/node_modules/*' \) -prune -o \
  -path "$TREE/scripts" -prune -o \
  -path "$TREE/apps/desktop*" -prune -o \
  -type d \( -name tests -o -name __tests__ \) -prune -exec rm -rf {} +
find "$TREE" \
  \( -path '*/node_modules' -o -path '*/node_modules/*' \) -prune -o \
  -path "$TREE/scripts" -prune -o \
  -path "$TREE/apps/desktop*" -prune -o \
  -type f \( \
    -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.mts' -o -name '*.spec.cts' \
    -o -name '*.spec.js' -o -name '*.spec.mjs' -o -name '*.spec.cjs' \
    -o -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mts' -o -name '*.test.cts' \
    -o -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \
  \) -exec rm -f {} +

# Package documentation inside installed dependencies. LICENSE files stay:
# third-party notice tooling reads them from node_modules. Only doc extensions
# match, because runtime code ships `history.js`/`History.d.ts`-style modules.
find "$TREE" -path '*/node_modules/*' -type f \( \
  -iname 'readme.md' -o -iname 'readme.markdown' -o \
  -iname 'changelog.md' -o -iname 'changelog.markdown' -o \
  -iname 'history.md' -o -iname 'history.markdown' -o \
  -iname 'changes.md' -o -iname 'changes.markdown' \
  \) -delete
