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

# Per-device settings patches are operator state (another machine's MCP
# servers and capability flags); the live profile reads its own copy from the
# installed profile directory, and a missing patch means empty input to the
# merge engine. A release must never carry them, or every device stages
# another device's patch next to its runtime tree.
rm -rf "$TREE/profile/web/device-patches"

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

# Optional native vendor binaries for uninstalled/optional subagent providers.
# Codex and Claude-Code are optional plugins with heavy platform CLIs; pruning
# them from the prebuilt release asset frees ~526 MB of uncompressed binaries.
# Users who explicitly install those bundles in a profile can install them on demand.
find "$TREE" -path '*/node_modules/*' -type d \( \
  -name '@openai+codex*' -o \
  -name '@anthropic-ai+claude-agent-sdk*' -o \
  -name 'codex-linux-*' -o \
  -name 'codex-darwin-*' -o \
  -name 'codex-win32-*' \
\) -prune -exec rm -rf {} +

# Documentation generation dependencies (Mermaid) not needed by the runtime (~117 MB).
find "$TREE" -path '*/node_modules/*' -type d \( \
  -name 'mermaid*' -o \
  -name '@mermaid-js*' -o \
  -name 'vitepress-plugin-mermaid*' \
\) -prune -exec rm -rf {} +

# Optional LibreOffice kit wasm engine (~146 MB uncompressed).
# Office-to-PDF conversion can be installed or downloaded on demand.
find "$TREE" -path '*/node_modules/*' -type d \( \
  -name '@deepseek-ai+libreoffice-kit-wasm*' \
\) -prune -exec rm -rf {} +

# Clean up broken symlinks in node_modules left by pruned packages.
if [ -d "$TREE/node_modules" ]; then
  find "$TREE/node_modules" -type l | while read -r link; do
    [ -e "$link" ] || rm -f "$link"
  done
fi
