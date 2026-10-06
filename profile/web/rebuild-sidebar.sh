#!/usr/bin/env bash
# Rebuild the dsh-better-sidebar client bundle from the plugin's source and
# restart the web service. The npm-published 0.14.0 lib/client.js has two
# latent bugs that break mounting against dsh rc.2:
#   1. JSX classic runtime leaves a bare global `React` reference in
#      RenderBoundary (ReferenceError: React is not defined at mount).
#   2. `activeTabType` useMemo sits AFTER the no-session early return, so the
#      welcome→session transition changes the hook count (React error #310).
# Both are fixed in the plugin's src/ + build-client.mjs (React shim banner).
# Run this after any `dsh plugin`/pnpm reinstall of the profile, which wipes
# node_modules back to the published (broken) build.
set -e

# Harness checkout: HARNESS_ROOT wins, then the documented clone, then the
# installer layout ($DSH_HOME/harness/current). The MCP-client link and the
# local esbuild used below both come from it.
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HARNESS_ROOT="${HARNESS_ROOT:-$HOME/deepseek-harness}"
if [ ! -d "$HARNESS_ROOT" ] && [ -d "$DSH_HOME/harness/current" ]; then
  HARNESS_ROOT="$DSH_HOME/harness/current"
fi

# Ensure the MCP client package is resolvable from the profile (dynamic MCP mounting)
mkdir -p node_modules/@deepseek-ai
if [ -d "$HARNESS_ROOT/packages/mcp/mcp-client" ]; then
  ln -sfn "$HARNESS_ROOT/packages/mcp/mcp-client" node_modules/@deepseek-ai/dsh-mcp-client
else
  echo "warn: no harness checkout at $HARNESS_ROOT; skipping the dsh-mcp-client link" >&2
fi

PKG_DIR="$HOME/.dsh/profiles/web/node_modules/dsh-better-sidebar"
if [ ! -d "$PKG_DIR" ]; then
  echo "dsh-better-sidebar not installed in the web profile" >&2
  exit 1
fi
cd "$PKG_DIR"

# Restore the patched source files ONLY when the installed copy lost our
# customizations (any pnpm/dsh-plugin reinstall wipes them). The marker grep
# prevents clobbering NEWER local edits with the older backup.
PATCH_DIR="$HOME/.dsh/profiles/web/sidebar-patch"
if [ -d "$PATCH_DIR" ]; then
  cp -r "$PATCH_DIR/src/"* "$PKG_DIR/src/" 2>/dev/null || true
  cp "$PATCH_DIR/build-client.mjs" "$PKG_DIR/build-client.mjs" 2>/dev/null || true
  cp "$PATCH_DIR/build-client.cjs" "$PKG_DIR/build-client.cjs" 2>/dev/null || true
  cp "$PATCH_DIR/build-chunks.cjs" "$PKG_DIR/build-chunks.cjs" 2>/dev/null || true
  echo "synced patched sidebar sources from $PATCH_DIR"
fi

# Point the builder at a local esbuild that exists on this machine.
ESBUILD="$HARNESS_ROOT/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild"
LIGHTNING="$HARNESS_ROOT/node_modules/.pnpm/lightningcss@1.32.0/node_modules/lightningcss"
if [ ! -d "$ESBUILD" ]; then
  ESBUILD="$(find "$HARNESS_ROOT/node_modules/.pnpm" -maxdepth 2 -type d -name 'esbuild@*' 2>/dev/null | sort | tail -1)/node_modules/esbuild"
fi
if [ ! -d "$LIGHTNING" ]; then
  LIGHTNING="$(find "$HARNESS_ROOT/node_modules/.pnpm" -maxdepth 2 -type d -name 'lightningcss@*' 2>/dev/null | sort | tail -1)/node_modules/lightningcss"
fi
if [ ! -d "$ESBUILD" ] || [ ! -d "$LIGHTNING" ]; then
  echo "error: esbuild/lightningcss not found under $HARNESS_ROOT/node_modules/.pnpm" >&2
  echo "       point HARNESS_ROOT at a harness checkout with its dependencies installed" >&2
  exit 1
fi
ESBUILD_BIN="$ESBUILD/bin/esbuild"
if [ ! -x "$ESBUILD_BIN" ]; then
  ESBUILD_BIN="$HARNESS_ROOT/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild"
fi

# Rewrite the builder's absolute import paths (they may point at a version
# pnpm no longer has after repo updates). Node is guaranteed here; python3 is
# not on a fresh macOS, so the rewrite uses node.
node - "$ESBUILD" "$LIGHTNING" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs')
const [esbuild, lightning] = process.argv.slice(2)
const rewrite = (source) => source
  .replace(/(import \{ build \} from )['"][^'"]*esbuild[^'"]*['"]/g, `$1'${esbuild}/lib/main.js'`)
  .replace(/(import \{ transform \} from )['"][^'"]*lightningcss[^'"]*['"]/g, `$1'${lightning}/node/index.js'`)
  .replace(/require\((['"])[^'"]*esbuild[^'"]*\1\)/g, `require('${esbuild}')`)
  .replace(/require\((['"])[^'"]*lightningcss[^'"]*\1\)/g, `require('${lightning}')`)
for (const file of ['build-client.mjs', 'build-client.cjs', 'build-chunks.cjs']) {
  writeFileSync(file, rewrite(readFileSync(file, 'utf8')))
}
console.log('builder import paths updated')
JS

cd "$PKG_DIR"
node build-client.mjs
node --check lib/client.js
# Rebuild the lazy chunk bundles (client-editor.js etc.) — the npm-published
# copies predate our TextEditor/FileTree patches.
node build-chunks.cjs
node --check lib/client-editor.js

# Rebuild the HOST bundle too (PTY quota/eviction + host routes live in
# lib/index.js; the npm-published copy predates our patches).
"$ESBUILD_BIN" src/index.ts --bundle --platform=node --format=esm \
  --outfile=lib/index.js --external:ws --external:zod --external:schemastery \
  "--external:@deepseek-ai/*" >/dev/null
node --check lib/index.js

if command -v systemctl >/dev/null 2>&1 && systemctl --user cat dsh-web.service >/dev/null 2>&1; then
  systemctl --user restart dsh-web.service
  echo "dsh-better-sidebar rebuilt (client+host) and dsh-web restarted."
else
  echo "dsh-better-sidebar rebuilt (client+host)."
  echo "Restart the web service to apply: dsh service restart (or systemctl --user restart dsh-web.service)"
fi
