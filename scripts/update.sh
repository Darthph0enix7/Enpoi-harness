#!/usr/bin/env bash
# dsh mechanical updater — delegates to the installer engine (single implementation).
# Invoked by the `dsh` shim as `dsh update [flags]`; runnable directly too.
#
# $DSH_HOME is a user-scoped setting, not a prefix property, and the shim only
# knows the install prefix. Derive the configured home here — an explicit
# --dsh-home or DSH_HOME always wins, otherwise the value recorded in
# install-state.json — and pass it on; install.sh fails loudly when the derived
# home disagrees with the state file.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
prefix=""
dsh_home="${DSH_HOME:-}"
explicit_home=0
expect_prefix=0
for arg in "$@"; do
  if [ "$expect_prefix" = 1 ]; then prefix="$arg"; expect_prefix=0; continue; fi
  case "$arg" in
    --prefix) expect_prefix=1;;
    --prefix=*) prefix="${arg#--prefix=}";;
    --dsh-home|--dsh-home=*) explicit_home=1;;
  esac
done
if [ "$explicit_home" = 0 ] && [ -z "$dsh_home" ]; then
  [ -n "$prefix" ] || prefix="$HOME/.dsh"
  state="$prefix/harness/install-state.json"
  if [ -f "$state" ]; then
    dsh_home="$(sed -n 's/.*"dshHome": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
  fi
fi
if [ "$explicit_home" = 0 ] && [ -n "$dsh_home" ]; then
  exec "$HERE/install.sh" --update --dsh-home "$dsh_home" "$@"
fi
exec "$HERE/install.sh" --update "$@"
