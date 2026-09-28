#!/usr/bin/env bash
# dsh mechanical updater / self-heal / uninstaller — delegates to the installer
# engine (single implementation).
# Invoked by the `dsh` shim as `dsh update|repair|uninstall [flags]`; runnable
# directly too (a bare invocation means update).
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
mode="update"
argv=()
for arg in "$@"; do
  if [ "$expect_prefix" = 1 ]; then prefix="$arg"; expect_prefix=0; argv+=("$arg"); continue; fi
  case "$arg" in
    --prefix) expect_prefix=1; argv+=("$arg");;
    --prefix=*) prefix="${arg#--prefix=}"; argv+=("$arg");;
    --dsh-home|--dsh-home=*) explicit_home=1; argv+=("$arg");;
    update|repair|uninstall) mode="$arg";;
    *) argv+=("$arg");;
  esac
done
case "$mode" in
  repair) mode_flag="--repair";;
  uninstall) mode_flag="--uninstall";;
  *) mode_flag="--update";;
esac
if [ "$explicit_home" = 0 ] && [ -z "$dsh_home" ]; then
  [ -n "$prefix" ] || prefix="$HOME/.dsh"
  state="$prefix/harness/install-state.json"
  if [ -f "$state" ]; then
    dsh_home="$(sed -n 's/.*"dshHome": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
  fi
fi
if [ "$explicit_home" = 0 ] && [ -n "$dsh_home" ]; then
  exec "$HERE/install.sh" "$mode_flag" --dsh-home "$dsh_home" ${argv[@]+"${argv[@]}"}
fi
exec "$HERE/install.sh" "$mode_flag" ${argv[@]+"${argv[@]}"}
