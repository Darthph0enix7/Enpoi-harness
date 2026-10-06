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
  [ -n "$prefix" ] || prefix="$HOME/.dsh"
  state="$prefix/harness/install-state.json"
  node_bin="${DSH_NODE:-}"
  if [ -z "$node_bin" ] && [ -f "$state" ]; then
    node_bin="$(sed -n 's/.*"node": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
  fi
  if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    node_bin="$(command -v node || true)"
  fi
  if [ -z "$node_bin" ]; then
    echo "dsh doctor: no usable Node.js found (set DSH_NODE or put node on PATH)" >&2
    exit 1
  fi
  # doctor.mjs names the home --home, while this script (and the other modes)
  # accept --dsh-home; translate, and derive the recorded home from state so
  # `dsh doctor` inspects the install's home rather than the process default.
  if [ "$explicit_home" = 0 ] && [ -z "$dsh_home" ] && [ -f "$state" ]; then
    dsh_home="$(sed -n 's/.*"dshHome": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
  fi
  # --prefix is this script's own flag; doctor.mjs does not accept it.
  doctor_argv=()
  skip_next=0
  expect_home=0
  service_explicit=0
  for arg in ${argv[@]+"${argv[@]}"}; do
    if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
    if [ "$expect_home" = 1 ]; then dsh_home="$arg"; expect_home=0; continue; fi
    case "$arg" in
      --prefix) skip_next=1;;
      --prefix=*) ;;
      --dsh-home) expect_home=1;;
      --dsh-home=*) dsh_home="${arg#--dsh-home=}";;
      --service|--service=*) service_explicit=1; doctor_argv+=("$arg");;
      *) doctor_argv+=("$arg");;
    esac
  done
  # Forward the unit recorded by install-state.json so doctor inspects this
  # install's service (a systemd unit or a launchd label), not the default.
  if [ "$service_explicit" = 0 ] && [ -f "$state" ]; then
    recorded_unit="$(sed -n 's/.*"serviceUnit": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
    if [ -n "$recorded_unit" ]; then doctor_argv+=(--service "$recorded_unit"); fi
  fi
  if [ -n "$dsh_home" ]; then doctor_argv+=(--home "$dsh_home"); fi
  exec "$node_bin" "$HERE/doctor.mjs" ${doctor_argv[@]+"${doctor_argv[@]}"}
fi
case "$mode" in
  repair) mode_flag="--repair";;
  uninstall) mode_flag="--uninstall";;
  clean) mode_flag="--clean";;
  *) mode_flag="--update";;
esac
installer="$HERE/install.sh"
if [ "$mode" = "update" ]; then
  update_channel=""
  [ -n "$prefix" ] || prefix="$HOME/.dsh"
  state="$prefix/harness/install-state.json"
  if [ -f "$state" ]; then
    update_channel="$(sed -n 's/.*"channel": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
  fi
  [ -n "$update_channel" ] || update_channel="stable"
  # The update runs the fetched installer via exec, so its EXIT trap cannot
  # remove the script; reap scripts from earlier runs whose PID is gone.
  for stale in "${TMPDIR:-/tmp}"/dsh-remote-installer-*.sh; do
    [ -e "$stale" ] || continue
    stale_pid="${stale##*-}"
    stale_pid="${stale_pid%.sh}"
    case "$stale_pid" in ''|*[!0-9]*) stale_pid="";; esac
    if [ -n "$stale_pid" ] && kill -0 "$stale_pid" 2>/dev/null; then continue; fi
    rm -f -- "$stale"
  done
  remote_installer="${TMPDIR:-/tmp}/dsh-remote-installer-$$.sh"
  remote_url="https://raw.githubusercontent.com/Darthph0enix7/enpoi-harness/$update_channel/scripts/install.sh"
  if curl -fsSL --connect-timeout 5 --max-time 15 "$remote_url" -o "$remote_installer" 2>/dev/null && bash -n "$remote_installer" 2>/dev/null; then
    chmod +x "$remote_installer"
    installer="$remote_installer"
  else
    # A silent fallback hides a stale installed updater; name the revision in
    # use and the channel that could not be reached.
    installed_revision="$(sed -n 's/^SCRIPT_REVISION=//p' "$installer" 2>/dev/null | head -n 1 | tr -d '"' || true)"
    printf 'dsh update: WARNING: could not fetch the %s installer from %s; using the installed updater%s — it may be older than the %s channel\n' \
      "$update_channel" "$remote_url" "${installed_revision:+ (script revision $installed_revision)}" "$update_channel" >&2
  fi
fi
if [ "$explicit_home" = 0 ] && [ -z "$dsh_home" ]; then
  [ -n "$prefix" ] || prefix="$HOME/.dsh"
  state="$prefix/harness/install-state.json"
  if [ -f "$state" ]; then
    dsh_home="$(sed -n 's/.*"dshHome": "\([^"]*\)".*/\1/p' "$state" | head -n 1)"
  fi
fi
if [ "$explicit_home" = 0 ] && [ -n "$dsh_home" ]; then
  exec "$installer" "$mode_flag" --dsh-home "$dsh_home" ${argv[@]+"${argv[@]}"}
fi
exec "$installer" "$mode_flag" ${argv[@]+"${argv[@]}"}
