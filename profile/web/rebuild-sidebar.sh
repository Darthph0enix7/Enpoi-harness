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
# installer layout ($DSH_HOME/harness/current). The MCP-client link comes from
# it; the sidebar builders resolve esbuild/lightningcss through the profile's
# own node_modules (normal module resolution), never through checkout paths.
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

PKG_DIR="$DSH_HOME/profiles/web/node_modules/dsh-better-sidebar"
if [ ! -d "$PKG_DIR" ]; then
  echo "dsh-better-sidebar not installed in the web profile" >&2
  exit 1
fi
cd "$PKG_DIR"

# Restore the patched source files ONLY when the installed copy lost our
# customizations (any pnpm/dsh-plugin reinstall wipes them). The marker grep
# prevents clobbering NEWER local edits with the older backup.
PATCH_DIR="$DSH_HOME/profiles/web/sidebar-patch"
if [ -d "$PATCH_DIR" ]; then
  cp -r "$PATCH_DIR/src/"* "$PKG_DIR/src/" 2>/dev/null || true
  cp "$PATCH_DIR/build-client.mjs" "$PKG_DIR/build-client.mjs" 2>/dev/null || true
  cp "$PATCH_DIR/build-client.cjs" "$PKG_DIR/build-client.cjs" 2>/dev/null || true
  cp "$PATCH_DIR/build-chunks.cjs" "$PKG_DIR/build-chunks.cjs" 2>/dev/null || true
  echo "synced patched sidebar sources from $PATCH_DIR"
fi

# The builders import `esbuild` and `lightningcss` by name. The deployed copy
# lives under the profile's node_modules, so Node resolves both through the
# profile install. Verify that, and resolve the esbuild binary for the host
# bundle the same way — version-agnostic, no pnpm-store path.
if ! node -e 'require.resolve("esbuild")' >/dev/null 2>&1 \
  || ! node -e 'require.resolve("lightningcss")' >/dev/null 2>&1; then
  echo "error: esbuild/lightningcss are not resolvable from $PKG_DIR" >&2
  echo "       run pnpm install in the profile so its node_modules supplies both" >&2
  exit 1
fi
ESBUILD_BIN="$(node -e 'const { dirname, join } = require("node:path"); console.log(join(dirname(require.resolve("esbuild")), "..", "bin", "esbuild"))')"
if [ ! -x "$ESBUILD_BIN" ]; then
  echo "error: the resolved esbuild package has no executable bin at $ESBUILD_BIN" >&2
  exit 1
fi

# Normalize any absolute esbuild/lightningcss specifier in the deployed
# builder copies back to a bare one, so they keep normal module resolution. A
# PATCH_DIR copy that predates the portability fix carries checkout-absolute
# paths (some naming versions pnpm has since removed); the current sources
# already use bare specifiers, for which this is a no-op. Node is guaranteed
# here; python3 is not on a fresh macOS, so the rewrite uses node.
node - <<'JS'
const { readFileSync, writeFileSync } = require('node:fs')
const normalize = (source) => source
  .replace(/(import \{ build \} from )['"][^'"]*esbuild[^'"]*['"]/g, "$1'esbuild'")
  .replace(/(import \{ transform \} from )['"][^'"]*lightningcss[^'"]*['"]/g, "$1'lightningcss'")
  .replace(/require\((['"])[^'"]*esbuild[^'"]*\1\)/g, "require('esbuild')")
  .replace(/require\((['"])[^'"]*lightningcss[^'"]*\1\)/g, "require('lightningcss')")
for (const file of ['build-client.mjs', 'build-client.cjs', 'build-chunks.cjs']) {
  writeFileSync(file, normalize(readFileSync(file, 'utf8')))
}
console.log('builder imports normalized to bare specifiers')
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
