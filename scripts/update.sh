#!/usr/bin/env bash
# dsh mechanical updater / self-heal / uninstaller — delegates to the installer
# engine (single implementation), and the `doctor` diagnostics entry point,
# which runs scripts/doctor.mjs with the Node recorded by the install.
# Invoked by the `dsh` shim as `dsh update|repair|uninstall|doctor [flags]`;
# runnable directly too (a bare invocation means update).
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
    update|repair|uninstall|doctor|clean) mode="$arg";;
    *) argv+=("$arg");;
  esac
done
if [ "$mode" = "doctor" ]; then
  node_bin="${DSH_NODE:-}"
  if [ -z "$node_bin" ]; then
    [ -n "$prefix" ] || prefix="$HOME/.dsh"
    state="$prefix/harness/install-state.json"
    if [ -f "$state" ]; then
      node_bin="$(sed -n 's/.*"node": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
    fi
  fi
  if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    node_bin="$(command -v node || true)"
  fi
  if [ -z "$node_bin" ]; then
    echo "dsh doctor: no usable Node.js found (set DSH_NODE or put node on PATH)" >&2
    exit 1
  fi
  # --prefix is this script's own flag; doctor.mjs does not accept it.
  doctor_argv=()
  skip_next=0
  for arg in ${argv[@]+"${argv[@]}"}; do
    if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
    case "$arg" in
      --prefix) skip_next=1;;
      --prefix=*) ;;
      *) doctor_argv+=("$arg");;
    esac
  done
  exec "$node_bin" "$HERE/doctor.mjs" ${doctor_argv[@]+"${doctor_argv[@]}"}
fi
case "$mode" in
  repair) mode_flag="--repair";;
  uninstall) mode_flag="--uninstall";;
  clean) mode_flag="--clean";;
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
