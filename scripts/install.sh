#!/usr/bin/env bash
# =============================================================================
# dsh — one-line installer and mechanical updater (Linux + macOS, no sudo)
#
#   curl -fsSL <raw-url>/scripts/install.sh | bash
#   ./scripts/install.sh [--source PATH|URL] [--prefix DIR] [--channel stable|beta]
#   dsh update [--dry-run] [--channel stable|beta] [--json]
#   dsh repair [--check] [--json]
#   dsh uninstall [--purge|--keep-data] [--dry-run] [--json]
#   dsh doctor [--json]                  host diagnostics (scripts/doctor.mjs)
#
# What it does (install):
#   1. detects OS/arch; uses an existing node >= 22.19 from PATH, otherwise
#      downloads the official Node tarball into   <prefix>/runtime/node/<ver>;
#   2. enables pnpm through corepack (ships with Node) — no system packages,
#      no sudo, ever;
#   3. fetches the channel build — the newest published GitHub Release tarball
#      when one carries an asset for this platform, otherwise the GitHub tarball
#      for the channel ref (or --source for a local path/tarball/URL) — into
#      <prefix>/harness/<version>;
#   4. pnpm install --frozen-lockfile + pnpm run build (host), then the
#      profile's own plugin build when the profile ships one;
#   5. when --profile-source / DSH_PROFILE_SOURCE names the companion profile
#      (default: the Enpoi web profile repo for --profile web), fetches it at
#      the selected channel's ref into $DSH_HOME/profiles/<name> before the
#      template seed, seeds the shared settings/presets, and installs the
#      profile's dependencies; an explicit --profile-ref wins;
#   6. seeds $DSH_HOME from the shipped templates (initProfile path), installs
#      the `dsh` shim into ~/.local/bin, and prints the PATH line (only writes
#      the shell rc when --write-rc is given);
#   7. exposes the web service to the machine's tailnet when a Tailscale IPv4
#      exists (a 100.64.0.0/10 address): adds --trusted-host for it and the
#      hostname to the managed service, and installs a dsh-tailnet forwarder
#      (socat on Linux, `tailscale serve` on macOS); DSH_NO_TAILNET=1 opts out.
#
# Update is the same engine via `--update` (delegated by `dsh update`):
#   fetch -> install -> build -> migrations -> switch `current` -> service
#   restart (only when a unit for this install exists) -> projection backfill
#   (when present) -> self-check -> roll back to the previous versioned dir and
#   restore backups on failure. Idempotent, re-runnable. When the update runs
#   inside the managed unit (a session shell or a model tool call), every
#   durable step completes first and the restart is delegated — the after-turn
#   marker when a turn is in flight, a detached restart plus a detached
#   verifier otherwise — so it never kills its own host.
#
# Build identity: every published release gets its own version — the tree's
# package version plus the workflow run number (`0.1.7-enpoi.2.42`, tagged
# `v0.1.7-enpoi.2.42`) — and a prebuilt install lands in a directory named
# after it, so `current` can roll back per build. When no release is reachable
# the source archive at the channel ref builds the tree's own base version, and
# the target ref's commit SHA (git ls-remote, then the GitHub API) decides
# whether a moved rolling branch rebuilds into `<version>-<short-sha>`.
#
# Invariants: the repo tree is pull-only and disposable; $DSH_HOME is only ever
# seeded (never overwritten); versioned dirs make rollback a symlink move.
# =============================================================================
set -u
set -o pipefail
umask 022

SCRIPT_NAME="dsh-install"
SCRIPT_REVISION="4"

# This script's own path: the detached service verifier runs a copy, so the copy
# must not depend on the fetched remote installer surviving in $TMPDIR. Empty
# when the script came from stdin (`curl | bash`).
SELF="${BASH_SOURCE[0]:-}"
case "$SELF" in
  */*) SELF="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd -P)/$(basename "$SELF")";;
esac
[ -f "$SELF" ] || SELF=""

# ── Distribution parameters (the public repo fills these) ───────────────────
DSH_GITHUB_REPO="${DSH_GITHUB_REPO:-Darthph0enix7/enpoi-harness}"
DSH_GITHUB_URL="${DSH_GITHUB_URL:-https://github.com/${DSH_GITHUB_REPO}}"
DSH_NODE_VERSION="${DSH_NODE_VERSION:-22.22.2}"
DSH_MIN_NODE_MAJOR=22
DSH_MIN_NODE_MINOR=19
INSTALL_TIMEOUT="${DSH_INSTALL_TIMEOUT:-1800}"
BUILD_TIMEOUT="${DSH_BUILD_TIMEOUT:-3600}"
PROFILE_BUILD_TIMEOUT="${DSH_PROFILE_BUILD_TIMEOUT:-180}"
PROFILE_INSTALL_TIMEOUT="${DSH_PROFILE_INSTALL_TIMEOUT:-900}"

# ── Defaults (empty means "fill from state / default" below) ────────────────
PREFIX="${PREFIX:-}"
CHANNEL=""
SOURCE=""
SOURCE_URL=""
REF=""
PROFILE=""
PROFILE_SOURCE="${DSH_PROFILE_SOURCE:-}"
PROFILE_REF="${DSH_PROFILE_REF:-}"
PROFILE_TOKEN="${DSH_PROFILE_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
PROFILE_SOURCE_REQUIRED=0
PROFILE_STAGE=""
DEFAULT_PROFILE_SOURCE="${DSH_DEFAULT_PROFILE_SOURCE:-https://github.com/Darthph0enix7/dsh-enpoi-web-profile.git}"
BIN_DIR=""
BIN_DIR_EXPLICIT=0
SERVICE_UNIT=""
SERVICE_INSTALL=1
SERVICE_INSTALL_EXPLICIT=0
NO_TAILNET="${DSH_NO_TAILNET:-0}"
NO_PREBUILT=0
PREBUILT=0
MERGE_BASELINE=""
NO_PROFILE_MERGE="${DSH_NO_PROFILE_MERGE:-0}"
WRITE_RC=0
DRY_RUN=0
FORCE=0
FORCE_DOWNGRADE=0
JSON_OUT=0
UPDATE_MODE=0
REPAIR_MODE=0
UNINSTALL_MODE=0
PURGE=0
CHECK_ONLY=0
QUIET=0
NO_OPEN=0
STEP_NO=0
STEP_TOTAL=0
START_TIME="$(date +%s)"

OS=""
ARCH=""
NODE=""
NODE_ORIGIN=""
PNPM=""
VERSION=""
STAGED=""
HARNESS=""
PROFILE_DIR=""
DSH_HOME="${DSH_HOME:-}"
AUDIT_RESULT="skipped"
BACKFILL="skipped"
BUILD_COMMIT=""
BUILD_DIRTY=""
TARGET_COMMIT=""
RELEASE_COMMIT=""
INSTALLED_COMMIT=""
TREE_DIR_NAME=""
REUSED_TREE_DIR=""
PRE_SWITCH_RESTORE=""
UPDATE_LOCK_DIR=""
PROFILE_REF_EXPLICIT=0
PROFILE_REF_DERIVED=0
PROFILE_SHIPPED_DIR=""
MIGRATION_FAILURES=""
PREV_VERSION=""
CHECK_VERSION=0
CHECK_HELP=0
CHECK_SMOKE=0
CHECK_AUDIT="skipped"
ROLLED_BACK=0
VERBOSE="${DSH_VERBOSE:-0}"
LOG_FILE=""
DISTRO_NAME=""
CLEAN_MODE=0
GUARD_MODE=0
GUARD_BASELINE=""
GUARD_TIMEOUT=""
GUARD_EXPECT_RESTART=0
GUARD_HOME=""

# Terminal styling (disabled when piped, non-TTY, dumb terminal, or NO_COLOR set)
if [ -t 1 ] && [ -t 2 ] && [ "${TERM:-dumb}" != "dumb" ] && [ "${NO_COLOR:-0}" = "0" ]; then
  C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_RESET=$(printf '\033[0m')
  C_CYAN=$(printf '\033[36m')
  C_GREEN=$(printf '\033[32m')
  C_YELLOW=$(printf '\033[33m')
  C_RED=$(printf '\033[31m')
  C_BLUE=$(printf '\033[34m')
else
  C_BOLD=""
  C_DIM=""
  C_RESET=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_BLUE=""
fi

init_log_file() {
  local log_dir="$PREFIX/logs"
  mkdir -p "$log_dir" 2>/dev/null || log_dir="${TMPDIR:-/tmp}"
  LOG_FILE="$log_dir/install.log"
  [ -n "${OS:-}" ] || detect_os_arch
  {
    printf '=================================================================\n'
    printf 'dsh-install session: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'channel: %s, os/arch: %s/%s (%s)\n' "${CHANNEL:-stable}" "${OS:-unknown}" "${ARCH:-unknown}" "${DISTRO_NAME:-unknown}"
    printf '=================================================================\n'
  } >> "$LOG_FILE" 2>/dev/null || LOG_FILE="/dev/null"
}

log() {
  [ -n "${LOG_FILE:-}" ] && printf '%s: %s\n' "$SCRIPT_NAME" "$*" >> "$LOG_FILE" 2>/dev/null || true
  if [ "$VERBOSE" = 1 ]; then
    printf "${C_DIM}%s:${C_RESET} %s\n" "$SCRIPT_NAME" "$*" >&2
  fi
}

warn() {
  [ -n "${LOG_FILE:-}" ] && printf '%s: WARNING: %s\n' "$SCRIPT_NAME" "$*" >> "$LOG_FILE" 2>/dev/null || true
  printf "${C_YELLOW}${C_BOLD}! WARNING:${C_RESET} %s\n" "$*" >&2
}

die() {
  [ -n "${LOG_FILE:-}" ] && printf '%s: ERROR: %s\n' "$SCRIPT_NAME" "$*" >> "$LOG_FILE" 2>/dev/null || true
  printf "\n${C_RED}${C_BOLD}✗ ERROR:${C_RESET} %s\n" "$*" >&2
  if [ -n "${LOG_FILE:-}" ] && [ -f "$LOG_FILE" ] && [ "$LOG_FILE" != "/dev/null" ]; then
    printf "${C_DIM}Full installation log available at: %s${C_RESET}\n\n" "$LOG_FILE" >&2
  fi
  exit 1
}

say() {
  if [ "$JSON_OUT" = 1 ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi
}

step() { # label
  STEP_NO=$((STEP_NO + 1))
  [ "$QUIET" = 1 ] && return 0
  if [ "$STEP_TOTAL" -gt 0 ]; then
    printf "\n${C_BOLD}${C_CYAN}[%d/%d]${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$STEP_NO" "$STEP_TOTAL" "$*" >&2
  else
    printf "\n${C_BOLD}${C_CYAN}▸${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*" >&2
  fi
}

substep_ok() {
  [ "$QUIET" = 1 ] && return 0
  printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*" >&2
}

substep_info() {
  [ "$QUIET" = 1 ] && return 0
  printf "  ${C_CYAN}ℹ${C_RESET} %s\n" "$*" >&2
}

run_logged() { # desc timeout workdir cmd...
  local desc="$1" timeout="$2" workdir="$3"
  shift 3
  local start_t rc=0
  start_t="$(date +%s)"

  if [ "$VERBOSE" = 1 ]; then
    printf "  ${C_CYAN}▸${C_RESET} %s...\n" "$desc" >&2
    ( cd "$workdir" && run_limited "$timeout" "$@" ) 2>&1 | tee -a "$LOG_FILE" >&2
    return "${PIPESTATUS[0]}"
  fi

  if [ "$QUIET" = 1 ]; then
    ( cd "$workdir" && run_limited "$timeout" "$@" ) >> "$LOG_FILE" 2>&1
    return $?
  fi

  printf "  ${C_CYAN}⏳${C_RESET} %s..." "$desc" >&2
  printf '\n--- START: %s (dir: %s) ---\n' "$desc" "$workdir" >> "$LOG_FILE" 2>/dev/null || true

  ( cd "$workdir" && run_limited "$timeout" "$@" ) >> "$LOG_FILE" 2>&1 &
  local pid=$!

  local spin='-\|/'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ -t 2 ]; then
      i=$(( (i + 1) % 4 ))
      local prog="" pf=""
      for pf in "$PREFIX/harness/.cache/"*.chunks/.progress "$PREFIX/harness/.cache/"*.progress "$workdir/"*.chunks/.progress "$workdir/"*.progress; do
        if [ -f "$pf" ]; then
          prog="$(cat "$pf" 2>/dev/null || true)"
          [ -n "$prog" ] && break
        fi
      done
      if [ -n "$prog" ]; then
        printf "\r\033[K  ${C_CYAN}%s${C_RESET} %s %s" "${spin:$i:1}" "$desc" "$prog" >&2
      else
        printf "\r\033[K  ${C_CYAN}%s${C_RESET} %s..." "${spin:$i:1}" "$desc" >&2
      fi
    fi
    sleep 0.2
  done

  wait "$pid" 2>/dev/null || rc=$?
  printf '\n--- END: %s (exit: %d) ---\n' "$desc" "$rc" >> "$LOG_FILE" 2>/dev/null || true

  local elapsed=$(( $(date +%s) - start_t ))
  [ "$elapsed" -ge 0 ] || elapsed=0

  if [ "$rc" = 0 ]; then
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  ${C_GREEN}✓${C_RESET} %s ${C_DIM}(%ds)${C_RESET}\n" "$desc" "$elapsed" >&2
    return 0
  else
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  ${C_RED}✗${C_RESET} ${C_BOLD}%s${C_RESET} ${C_RED}failed${C_RESET} ${C_DIM}(exit code %d, %ds)${C_RESET}\n" "$desc" "$rc" "$elapsed" >&2
    if [ -f "$LOG_FILE" ] && [ "$LOG_FILE" != "/dev/null" ]; then
      printf "\n${C_RED}Last 15 lines of log (${LOG_FILE}):${C_RESET}\n" >&2
      printf "${C_DIM}─────────────────────────────────────────────────────────────────${C_RESET}\n" >&2
      tail -n 15 "$LOG_FILE" >&2
      printf "${C_DIM}─────────────────────────────────────────────────────────────────${C_RESET}\n\n" >&2
    fi
    return "$rc"
  fi
}

elapsed_human() { # whole-second duration since START_TIME, e.g. "3m42s"
  local s h m
  s=$(( $(date +%s) - START_TIME ))
  [ "$s" -ge 0 ] || s=0
  h=$((s / 3600)); m=$((s / 60 % 60)); s=$((s % 60))
  if [ "$h" -gt 0 ]; then printf '%dh%02dm' "$h" "$m"
  elif [ "$m" -gt 0 ]; then printf '%dm%02ds' "$m" "$s"
  else printf '%ds' "$s"; fi
}

usage() {
  cat <<'USAGE'
dsh installer — installs or updates a dsh build without sudo.

Usage:
  install.sh [options]                 install (or refresh) the channel build
  install.sh --update [options]        mechanical update of an existing install
  install.sh --repair [--check]        verify the install and fix the safe breaks
  install.sh --clean                   clean failed builds, staging, and temp files
  install.sh --uninstall [--purge]     remove the install (default: keep data)

Options:
  --clean             remove failed builds, incomplete trees, and temporary
                      staging files (keeps complete builds and all user data)
  --prefix DIR        install root (default: $HOME/.dsh)
  --bin-dir DIR       where the `dsh` shim goes (default: $HOME/.local/bin)
  --channel NAME      stable | beta (default: stable)
  --source SRC        local directory, local tarball, or tarball/archive URL
                      (default: the GitHub archive of the channel ref)
  --ref REF           override the git ref fetched from GitHub (default: channel)
  --profile NAME      profile to seed (default: web)
  --profile-source SRC  companion profile: local dir, local tarball, tarball
                      URL, or git URL (default for --profile web: the Enpoi
                      profile repo; empty disables the profile fetch)
  --profile-ref REF   git ref fetched from a git profile source (default: the
                      selected channel for the canonical Enpoi profile repo,
                      HEAD otherwise)
  --service-unit U    systemd user unit / launchd label to restart on update
                      (default: auto-detected only when it references --prefix)
  --no-service        do not install or start a background service unit
                      (updates still restart a unit already referencing --prefix)
  --no-tailnet        do not configure tailnet peer exposure (the dsh-tailnet
                      forwarder and the web service's --trusted-host flags;
                      also DSH_NO_TAILNET=1)
  --no-prebuilt       always build from the source archive; skip the verified
                      prebuilt download from the newest published release
                      (also DSH_NO_PREBUILT=1)
  --dsh-home DIR      harness home override (default: $DSH_HOME or $HOME/.dsh);
                      update fails loudly when it disagrees with install-state.json
  --merge-baseline F  run the profile's three-way merge engine against F
                      (timestamped backups; never fail closed)
  --no-profile-merge  skip the additive shipped-profile patch merge (new shipped
                      rows/sections are not added; the live patch stays untouched)
  --update            mechanical update: install, migrate, switch, self-check,
                      roll back to the previous versioned dir on failure
  --repair            verify the install's invariants (version dirs, current,
                      shim, profile tree, services, settings, ports) and fix the
                      safe ones; report the rest with the exact remedy command
  --check             with --repair: report only; non-zero exit on findings
  --uninstall         remove the install; the default keeps $DSH_HOME
  --keep-data         with --uninstall: keep $DSH_HOME so a re-install resumes
                      (this is the default)
  --purge             with --uninstall: remove everything including caches,
                      state and logs; requires typing "purge"; --dry-run lists
                      exactly what would be removed
  --dry-run           print the plan and exit; writes nothing
  --force             rebuild/reinstall even when the version is already present
  --force-downgrade   allow a downgrade to an older version
  --write-rc          add the bin dir to the detected shell's startup files
                      (bash ~/.bash_profile|.bash_login|.profile + ~/.bashrc,
                      zsh ~/.zshrc / ~/.zprofile, fish config.fish)
  --verbose, -v       print full command and build output (do not redirect to log)
  --quiet, -q         suppress progress/detail lines (warnings, errors, and the
                      final summary still print)
  --no-open           do not try to open the Web UI URL after install
  --json              print a single JSON status object on stdout
  -h, --help          this help

Environment:
  DSH_GITHUB_REPO / DSH_GITHUB_URL   repository slug / base URL parameter
  DSH_NODE_VERSION                   Node version fetched when PATH has none
  DSH_INSTALL_TIMEOUT/BUILD_TIMEOUT  command budgets in seconds
  DSH_HOME                           harness home (default: $HOME/.dsh)
  DSH_PROFILE_SOURCE / DSH_PROFILE_REF   profile source and git ref
  DSH_PROFILE_TOKEN                  bearer token for a private profile source
                                     (falls back to GH_TOKEN / GITHUB_TOKEN / gh)
  DSH_DEFAULT_PROFILE_SOURCE         built-in default profile source
  DSH_PROFILE_INSTALL_TIMEOUT        profile `pnpm install` budget in seconds
  DSH_WEB_HOST / DSH_WEB_PORT        Web UI URL printed (and opened when a
                                     display exists); default 127.0.0.1:3080
  DSH_NO_OPEN                        same as --no-open
  DSH_NO_SERVICE                     same as --no-service
  DSH_NO_TAILNET                     same as --no-tailnet
  DSH_TAILNET_IP                     override the derived tailnet IPv4 (the
                                     first 100.64.0.0/10 host address otherwise)
  DSH_NO_PREBUILT                    same as --no-prebuilt
  DSH_NO_PROFILE_MERGE               same as --no-profile-merge

Exit codes: 0 success, 1 failure (update rolls back first), 42 sudo trap fired.
USAGE
}

# One EXIT trap owns all cleanup: staging dirs, a pre-switch user-file restore
# that an early die did not reach explicitly, and the portable mkdir lock
# directory. A single chained trap keeps the existing cleanup from being
# clobbered by a later trap registration.
trap 'if [ -n "${STAGED:-}" ]; then rm -rf "$STAGED"; fi; if [ -n "${PROFILE_STAGE:-}" ]; then rm -rf "$PROFILE_STAGE"; fi; if [ -n "${PRE_SWITCH_RESTORE:-}" ]; then restore_pre_switch "$PRE_SWITCH_RESTORE" "the update"; fi; if [ -n "${UPDATE_LOCK_DIR:-}" ]; then rm -rf "$UPDATE_LOCK_DIR" 2>/dev/null; fi' EXIT

# ── Argument parsing ────────────────────────────────────────────────────────
need_value() { [ "$#" -ge 2 ] || die "option $1 needs a value"; }
while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --prefix) need_value "$@"; PREFIX="$2"; shift 2;;
    --prefix=*) PREFIX="${arg#*=}"; shift;;
    --bin-dir) need_value "$@"; BIN_DIR="$2"; BIN_DIR_EXPLICIT=1; shift 2;;
    --bin-dir=*) BIN_DIR="${arg#*=}"; BIN_DIR_EXPLICIT=1; shift;;
    --channel) need_value "$@"; CHANNEL="$2"; shift 2;;
    --channel=*) CHANNEL="${arg#*=}"; shift;;
    --source) need_value "$@"; SOURCE="$2"; shift 2;;
    --source=*) SOURCE="${arg#*=}"; shift;;
    --ref) need_value "$@"; REF="$2"; shift 2;;
    --ref=*) REF="${arg#*=}"; shift;;
    --profile) need_value "$@"; PROFILE="$2"; shift 2;;
    --profile=*) PROFILE="${arg#*=}"; shift;;
    --profile-source) need_value "$@"; PROFILE_SOURCE="$2"; shift 2;;
    --profile-source=*) PROFILE_SOURCE="${arg#*=}"; shift;;
    --profile-ref) need_value "$@"; PROFILE_REF="$2"; PROFILE_REF_EXPLICIT=1; shift 2;;
    --profile-ref=*) PROFILE_REF="${arg#*=}"; PROFILE_REF_EXPLICIT=1; shift;;
    --service-unit) need_value "$@"; SERVICE_UNIT="$2"; shift 2;;
    --service-unit=*) SERVICE_UNIT="${arg#*=}"; shift;;
    --no-service) SERVICE_INSTALL=0; SERVICE_INSTALL_EXPLICIT=1; shift;;
    --no-tailnet) NO_TAILNET=1; shift;;
    --no-prebuilt) NO_PREBUILT=1; shift;;
    --dsh-home) need_value "$@"; DSH_HOME="$2"; shift 2;;
    --dsh-home=*) DSH_HOME="${arg#*=}"; shift;;
    --merge-baseline) need_value "$@"; MERGE_BASELINE="$2"; shift 2;;
    --merge-baseline=*) MERGE_BASELINE="${arg#*=}"; shift;;
    --no-profile-merge) NO_PROFILE_MERGE=1; shift;;
    --update) UPDATE_MODE=1; shift;;
    --repair) REPAIR_MODE=1; shift;;
    --clean) CLEAN_MODE=1; shift;;
    --uninstall) UNINSTALL_MODE=1; shift;;
    --keep-data) PURGE=0; shift;;
    --purge) PURGE=1; shift;;
    --check) CHECK_ONLY=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --force) FORCE=1; shift;;
    --force-downgrade) FORCE_DOWNGRADE=1; shift;;
    --write-rc) WRITE_RC=1; shift;;
    --verbose|-v) VERBOSE=1; shift;;
    --quiet|-q) QUIET=1; shift;;
    --no-open) NO_OPEN=1; shift;;
    --json) JSON_OUT=1; shift;;
    --service-guard) GUARD_MODE=1; shift;;
    --guard-baseline) need_value "$@"; GUARD_BASELINE="$2"; shift 2;;
    --guard-baseline=*) GUARD_BASELINE="${arg#*=}"; shift;;
    --guard-timeout) need_value "$@"; GUARD_TIMEOUT="$2"; shift 2;;
    --guard-timeout=*) GUARD_TIMEOUT="${arg#*=}"; shift;;
    --guard-expect-restart) GUARD_EXPECT_RESTART=1; shift;;
    --guard-home) need_value "$@"; GUARD_HOME="$2"; shift 2;;
    --guard-home=*) GUARD_HOME="${arg#*=}"; shift;;
    -h|--help) usage; exit 0;;
    --) shift; break;;
    *) die "unknown option: $arg (see --help)";;
  esac
done

# ── Portable helpers ────────────────────────────────────────────────────────
# DSH_PROFILE_REF names an explicit ref exactly like --profile-ref does.
[ -n "$PROFILE_REF" ] && PROFILE_REF_EXPLICIT=1

run_limited() {
  local seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$seconds" "$@"
  else "$@"; fi
}

host_short_name() {
  # `hostname` is not POSIX; fall back to uname -n and a literal so the
  # device-patch path and the summary never contain an empty segment. A
  # successful-but-empty hostname must not win over the fallbacks.
  local h
  h="$(hostname 2>/dev/null || true)"
  [ -n "$h" ] || h="$(uname -n 2>/dev/null || true)"
  [ -n "$h" ] || h="this-host"
  printf '%s' "$h"
}

# Atomically repoint harness/current: build the new symlink beside the old one,
# then rename it over. mv -T is GNU-only; mv -h is the BSD/macOS spelling (plain
# mv would follow a directory symlink and move the temporary link inside the old
# tree), and Node's rename(2) is the atomic fallback. The link is never removed
# before the move: that would open a window where harness/current does not exist.
switch_current() { # target -> 0
  local target="$1" link="$PREFIX/harness/current" tmp="$PREFIX/harness/.current.tmp.$$"
  rm -f "$tmp" 2>/dev/null || true
  ln -sfn "$target" "$tmp" || return 1
  if mv -Tf "$tmp" "$link" 2>/dev/null; then return 0; fi
  if mv -hf "$tmp" "$link" 2>/dev/null; then return 0; fi
  if [ -n "${NODE:-}" ] && [ -x "$NODE" ]; then
    "$NODE" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp" "$link" 2>/dev/null && return 0
  fi
  warn "could not atomically replace $link"
  return 1
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

json_lines() { # stdin lines -> ["a", "b"]
  local first=1 line
  printf '['
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ "$first" = 1 ] || printf ', '
    first=0
    printf '"%s"' "$(json_escape "$line")"
  done
  printf ']'
}

json_field() { # file key
  local file="$1" key="$2"
  if [ -n "${NODE:-}" ] && [ -x "$NODE" ]; then
    "$NODE" -e 'const fs=require("fs");try{const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o[process.argv[2]]??""))}catch{process.exit(1)}' "$file" "$key" 2>/dev/null
  else
    sed -n "s/.*\"$key\": \"\([^\"]*\)\".*/\1/p" "$file" 2>/dev/null | head -n 1
  fi
}

node_at_least() { # bin major minor
  local bin="$1" major="$2" minor="$3" v ma mi
  v="$("$bin" --version 2>/dev/null)" || return 1
  v="${v#v}"
  ma="${v%%.*}"
  v="${v#*.}"
  mi="${v%%.*}"
  case "$ma" in ''|*[!0-9]*) return 1;; esac
  case "$mi" in ''|*[!0-9]*) return 1;; esac
  if [ "$ma" -gt "$major" ]; then return 0; fi
  if [ "$ma" -eq "$major" ] && [ "$mi" -ge "$minor" ]; then return 0; fi
  return 1
}

ver_lt() { # true when version $1 < $2 (semver order, prerelease identifiers included)
  local a="$1" b="$2" abase apre bbase bpre a1 a2 a3 b1 b2 b3 ai bi an bn
  abase="${a%%-*}"; apre=""; [ "$a" = "$abase" ] || apre="${a#*-}"
  bbase="${b%%-*}"; bpre=""; [ "$b" = "$bbase" ] || bpre="${b#*-}"
  IFS=. read -r a1 a2 a3 _ <<EOF
$abase
EOF
  IFS=. read -r b1 b2 b3 _ <<EOF
$bbase
EOF
  a1="${a1:-0}"; a2="${a2:-0}"; a3="${a3:-0}"
  b1="${b1:-0}"; b2="${b2:-0}"; b3="${b3:-0}"
  case "$a1$a2$a3$b1$b2$b3" in *[!0-9]*) return 1;; esac
  if [ "$a1" -ne "$b1" ]; then [ "$a1" -lt "$b1" ]; return; fi
  if [ "$a2" -ne "$b2" ]; then [ "$a2" -lt "$b2" ]; return; fi
  if [ "$a3" -ne "$b3" ]; then [ "$a3" -lt "$b3" ]; return; fi
  [ -z "$apre" ] && [ -z "$bpre" ] && return 1   # identical releases
  [ -z "$apre" ] && return 1                     # release outranks prerelease
  [ -z "$bpre" ] && return 0                     # prerelease sorts below release
  while [ -n "$apre" ] || [ -n "$bpre" ]; do
    ai="${apre%%.*}"; [ "$ai" = "$apre" ] && apre="" || apre="${apre#*.}"
    bi="${bpre%%.*}"; [ "$bi" = "$bpre" ] && bpre="" || bpre="${bpre#*.}"
    [ -z "$ai" ] && { [ -n "$bi" ] && return 0 || return 1; }
    [ -z "$bi" ] && return 1
    case "$ai" in *[!0-9]*) an=0;; *) an=1;; esac
    case "$bi" in *[!0-9]*) bn=0;; *) bn=1;; esac
    if [ "$an" != "$bn" ]; then [ "$an" = 0 ] && return 0; return 1; fi
    if [ "$ai" = "$bi" ]; then continue; fi
    if [ "$an" = 1 ]; then [ "$ai" -lt "$bi" ]; return; fi
    [ "$(printf '%s\n%s\n' "$ai" "$bi" | LC_ALL=C sort | head -n 1)" = "$ai" ]; return
  done
  return 1
}

detect_os_arch() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Linux) OS=linux;;
    Darwin) OS=darwin;;
    # Git Bash/MSYS2/Cygwin report a Windows kernel here. Stop before any
    # staging: the harness ships Linux/macOS binaries and cannot run natively.
    MINGW*|MSYS*|CYGWIN*|Windows_NT|UWIN*)
      die "unsupported OS: $uname_s — this is a Windows shell (Git Bash/MSYS2/Cygwin); the harness runs on Linux and macOS only. Use WSL 2 instead: run 'wsl --install' in PowerShell, then run this installer inside the WSL Linux shell.";;
    *) die "unsupported OS: $uname_s — Linux and macOS only";;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64;;
    aarch64|arm64) ARCH=arm64;;
    *) die "unsupported architecture: $(uname -m)";;
  esac

  DISTRO_NAME=""
  if [ "$OS" = "darwin" ]; then
    DISTRO_NAME="macOS $(sw_vers -productVersion 2>/dev/null || uname -r)"
    # Homebrew environment detection: Apple Silicon (/opt/homebrew) or Intel (/usr/local)
    if [ -x "/opt/homebrew/bin/brew" ]; then
      eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || true)"
      export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
      DISTRO_NAME="$DISTRO_NAME (Homebrew)"
    elif [ -x "/usr/local/bin/brew" ]; then
      eval "$(/usr/local/bin/brew shellenv 2>/dev/null || true)"
      export PATH="/usr/local/bin:/usr/local/sbin:$PATH"
      DISTRO_NAME="$DISTRO_NAME (Homebrew)"
    elif command -v brew >/dev/null 2>&1; then
      eval "$(brew shellenv 2>/dev/null || true)"
      DISTRO_NAME="$DISTRO_NAME (Homebrew)"
    fi
  elif [ "$OS" = "linux" ]; then
    if [ -f "/etc/os-release" ]; then
      DISTRO_NAME="$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)"
      [ -n "$DISTRO_NAME" ] || DISTRO_NAME="$(sed -n 's/^NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)"
    fi
    [ -n "$DISTRO_NAME" ] || DISTRO_NAME="Linux"
  fi
}

sudo_trap() { # prepend a failing `sudo` stub; every invocation is recorded
  mkdir -p "$PREFIX/bin" || return 0
  cat > "$PREFIX/bin/sudo" <<EOF
#!/bin/sh
echo "dsh-install: sudo is never used by this installer" >&2
date -u +%Y-%m-%dT%H:%M:%SZ >> "$PREFIX/.sudo-calls" 2>/dev/null || true
exit 42
EOF
  chmod +x "$PREFIX/bin/sudo"
  export PATH="$PREFIX/bin:$PATH"
}

# ── Node ────────────────────────────────────────────────────────────────────
fetch_node() {
  local plat arch tarball url tmp sums expected actual
  case "$OS" in linux) plat=linux;; darwin) plat=darwin;; *) return 1;; esac
  arch="$ARCH"
  tarball="node-v${DSH_NODE_VERSION}-${plat}-${arch}.tar.gz"
  url="${DSH_NODE_MIRROR:-https://nodejs.org/dist}/v${DSH_NODE_VERSION}/${tarball}"
  tmp="$PREFIX/runtime/.node-tmp-$$"
  mkdir -p "$tmp" "$PREFIX/runtime/node" || return 1
  log "downloading Node.js v${DSH_NODE_VERSION} (${plat}-${arch})"
  run_logged "Downloading Node.js v${DSH_NODE_VERSION} (${plat}-${arch})" 120 "$tmp" curl -fsSL --retry 2 --connect-timeout 20 "$url" -o "$tmp/$tarball" || { warn "Node download failed: $url"; rm -rf "$tmp"; return 1; }
  if curl -fsSL --retry 1 "$url.sha256" -o "$tmp/$tarball.sha256" 2>/dev/null; then
    expected="$(awk '{print $1}' "$tmp/$tarball.sha256")"
    if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"
    else actual=""; fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      warn "Node tarball checksum mismatch"; rm -rf "$tmp"; return 1
    fi
  fi
  run_logged "Extracting Node.js" 60 "$tmp" tar -xzf "$tmp/$tarball" -C "$tmp" || { rm -rf "$tmp"; return 1; }
  rm -rf "$PREFIX/runtime/node/$DSH_NODE_VERSION"
  mv "$tmp/node-v${DSH_NODE_VERSION}-${plat}-${arch}" "$PREFIX/runtime/node/$DSH_NODE_VERSION" || { rm -rf "$tmp"; return 1; }
  ln -sfn "$DSH_NODE_VERSION" "$PREFIX/runtime/node/current"
  rm -rf "$tmp"
  return 0
}

resolve_node() { # $1=1 allow fetch
  local allow_fetch="${1:-1}" cand
  NODE=""; NODE_ORIGIN=""
  cand="$(command -v node 2>/dev/null || true)"
  if [ -n "$cand" ] && node_at_least "$cand" "$DSH_MIN_NODE_MAJOR" "$DSH_MIN_NODE_MINOR"; then
    NODE="$cand"; NODE_ORIGIN="PATH"
  elif cand="$PREFIX/runtime/node/current/bin/node"; [ -x "$cand" ] && node_at_least "$cand" "$DSH_MIN_NODE_MAJOR" "$DSH_MIN_NODE_MINOR"; then
    NODE="$cand"; NODE_ORIGIN="prefix runtime"
  elif cand="$PREFIX/runtime/node/$DSH_NODE_VERSION/bin/node"; [ -x "$cand" ] && node_at_least "$cand" "$DSH_MIN_NODE_MAJOR" "$DSH_MIN_NODE_MINOR"; then
    NODE="$cand"; NODE_ORIGIN="prefix runtime"
  elif [ "$allow_fetch" = 1 ] && fetch_node; then
    NODE="$PREFIX/runtime/node/$DSH_NODE_VERSION/bin/node"; NODE_ORIGIN="downloaded"
  else
    return 1
  fi
  if [ -n "$NODE" ] && [ -x "$NODE" ]; then
    export PATH="$(dirname "$NODE"):$PREFIX/bin:$PATH"
  fi
  return 0
}

setup_pnpm() {
  local nbin corepack_bin cc_dir
  nbin="$(dirname "$NODE")"
  COREPACK_HOME="$PREFIX/runtime/corepack"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export COREPACK_HOME COREPACK_ENABLE_DOWNLOAD_PROMPT
  if [ -x "$PREFIX/bin/pnpm" ]; then PNPM="$PREFIX/bin/pnpm"; return 0; fi
  mkdir -p "$PREFIX/bin" || return 1
  corepack_bin="$nbin/corepack"
  if [ ! -x "$corepack_bin" ] && [ -x "$nbin/npm" ]; then
    log "corepack not bundled with this Node; installing it with npm (user prefix)"
    cc_dir="$PREFIX/runtime/corepack-cli"
    run_logged "Installing corepack CLI" 300 "$PREFIX" "$nbin/npm" install --global --prefix "$cc_dir" corepack@latest || return 1
    corepack_bin="$cc_dir/bin/corepack"
  fi
  [ -x "$corepack_bin" ] || { warn "no corepack available next to $NODE"; return 1; }
  run_logged "Enabling pnpm via corepack" 120 "$PREFIX" "$corepack_bin" enable --install-directory "$PREFIX/bin" pnpm || return 1
  [ -x "$PREFIX/bin/pnpm" ] || { warn "corepack did not produce $PREFIX/bin/pnpm"; return 1; }
  PNPM="$PREFIX/bin/pnpm"
  return 0
}

# ── Source acquisition ──────────────────────────────────────────────────────
read_version() { # manifest
  local manifest="$1"
  [ -f "$manifest" ] || return 1
  "$NODE" -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!p.version)process.exit(1);process.stdout.write(String(p.version))' "$manifest" 2>/dev/null
}

digest_hex() { # stable 40-hex digest for builds without git metadata
  if command -v sha1sum >/dev/null 2>&1; then printf '%s' "$1" | sha1sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then printf '%s' "$1" | shasum -a 1 | awk '{print $1}'
  else printf '%040d' 0
  fi
}

# ── Rolling-channel commit identity ─────────────────────────────────────────
# A channel branch can advance without a version bump. The target ref's commit
# SHA and the SHA recorded by the installed tree decide whether an update is a
# no-op; version comparison alone would skip a moved rolling branch forever.

commit_same() { # a b -> 0 when one SHA is a prefix of the other (short vs full)
  local a="$1" b="$2"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  [ "${a#"$b"}" != "$a" ] && return 0
  [ "${b#"$a"}" != "$b" ] && return 0
  return 1
}

installed_tree_commit() { # tree -> the build commit the tree recorded, empty when unknown
  local tree="$1" commit=""
  if [ -f "$tree/.dsh-install-complete" ]; then
    commit="$(json_field "$tree/.dsh-install-complete" commit)"
  fi
  if [ -z "$commit" ] && [ -f "$tree/.dsh-build/client-build-environment.json" ]; then
    commit="$("$NODE" -e 'const fs=require("fs");try{const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o.environment?.DSH_CLIENT_COMMIT_HASH??""))}catch{process.exit(1)}' "$tree/.dsh-build/client-build-environment.json" 2>/dev/null || true)"
  fi
  case "$commit" in *[!0-9a-fA-F]*|'') commit="";; esac
  printf '%s' "$commit"
}

resolve_target_commit() { # ref url -> target commit SHA, empty when unresolvable
  local ref="$1" url="$2" sha="" raw=""
  if [ -n "$ref" ] && [ -n "$url" ] && command -v git >/dev/null 2>&1; then
    sha="$(GIT_TERMINAL_PROMPT=0 run_limited 30 git ls-remote "$url" "refs/heads/$ref" 2>/dev/null | awk 'NR==1 {print $1}')"
    if [ -z "$sha" ]; then
      # The peeled form resolves an annotated tag to its commit; a lightweight
      # tag (what release creation makes) answers from the plain ref.
      sha="$(GIT_TERMINAL_PROMPT=0 run_limited 30 git ls-remote "$url" "refs/tags/$ref^{}" 2>/dev/null | awk 'NR==1 {print $1}')"
    fi
    if [ -z "$sha" ]; then
      sha="$(GIT_TERMINAL_PROMPT=0 run_limited 30 git ls-remote "$url" "refs/tags/$ref" 2>/dev/null | awk 'NR==1 {print $1}')"
    fi
  fi
  case "$sha" in *[!0-9a-fA-F]*|'') sha="";; esac
  if [ -z "$sha" ] && [ -n "$ref" ] && [ -n "$url" ]; then
    case "$url" in
      https://github.com/*)
        raw="$(curl -fsSL --connect-timeout 10 --max-time 20 "https://api.github.com/repos/$DSH_GITHUB_REPO/commits/$ref" 2>/dev/null || true)"
        # Here-string, not a pipe: the API JSON is one very long line, and an
        # early-exiting consumer would close the pipe mid-write and make the
        # printf builtin report EPIPE ("write error: Broken pipe").
        sha="$(awk -F'"' '/"sha":/ {print $4; exit}' <<<"$raw")"
        ;;
    esac
  fi
  case "$sha" in *[!0-9a-fA-F]*|'') sha="";; esac
  printf '%s' "$sha"
}

# Resolve the target SHA for the source selected by prepare_source: a local git
# checkout answers from its own HEAD; the channel archive answers from the ref.
resolve_target_for_source() {
  TARGET_COMMIT=""
  if [ -n "$SOURCE" ] && [ -d "$SOURCE/.git" ]; then
    TARGET_COMMIT="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
  elif [ -n "$SOURCE_URL" ]; then
    TARGET_COMMIT="$(resolve_target_commit "${REF:-$CHANNEL}" "$DSH_GITHUB_URL")"
  fi
  case "$TARGET_COMMIT" in *[!0-9a-fA-F]*|'') TARGET_COMMIT="";; esac
  return 0
}

resolve_build_commit() {
  # The client build embeds a commit hash; tarball installs carry no .git, so
  # the engine accepts DSH_CLIENT_COMMIT_HASH (scripts/client-build-environment.ts).
  # Prefer real metadata (in-tree .git, the --source clone, GitHub API), then a
  # version digest so the build never fails on missing git.
  BUILD_COMMIT=""; BUILD_DIRTY=""
  if [ -d "$HARNESS/.git" ]; then return 0; fi
  if [ -n "${DSH_CLIENT_COMMIT_HASH:-}" ]; then BUILD_COMMIT="$DSH_CLIENT_COMMIT_HASH"; return 0; fi
  if command -v git >/dev/null 2>&1 && [ -n "$SOURCE" ] && [ -d "$SOURCE/.git" ]; then
    BUILD_COMMIT="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$BUILD_COMMIT" ] && [ -n "$(git -C "$SOURCE" status --porcelain=v1 2>/dev/null)" ]; then BUILD_DIRTY=true; fi
  fi
  case "$BUILD_COMMIT" in *[!0-9a-fA-F]*|'') BUILD_COMMIT="";; esac
  if [ -z "$BUILD_COMMIT" ] && [ -n "${SOURCE_URL:-}" ]; then
    local raw=""
    case "$DSH_GITHUB_URL" in
      https://github.com/*)
        raw="$(curl -fsSL --connect-timeout 10 --max-time 20 "https://api.github.com/repos/$DSH_GITHUB_REPO/commits/${REF:-$CHANNEL}" 2>/dev/null || true)"
        BUILD_COMMIT="$(awk -F'"' '/"sha":/ {print $4; exit}' <<<"$raw")"
        ;;
    esac
    case "$BUILD_COMMIT" in *[!0-9a-fA-F]*|'') BUILD_COMMIT="";; esac
  fi
  if [ -z "$BUILD_COMMIT" ]; then
    BUILD_COMMIT="$(digest_hex "$VERSION")"
    warn "no git metadata available; recording DSH_CLIENT_COMMIT_HASH=$BUILD_COMMIT (digest of $VERSION)"
  fi
  return 0
}

flatten_stage() { # move a single top-level directory's contents up
  local stage="$1" entries count
  count=0
  for entries in "$stage"/* "$stage"/.[!.]*; do
    [ -e "$entries" ] || continue
    count=$((count + 1))
  done
  if [ "$count" = 1 ] && [ ! -f "$stage/package.json" ]; then
    for entries in "$stage"/* "$stage"/.[!.]*; do
      [ -d "$entries" ] || continue
      if [ ! -f "$entries/package.json" ]; then continue; fi
      ( cd "$entries" && tar -cf - . ) | tar -C "$stage" -xf -
      local top="$entries"
      if [ "$top" != "$stage" ]; then rm -rf "$top"; fi
      return 0
    done
  fi
  return 0
}

stage_tarball() { # local tarball
  STAGED="$PREFIX/harness/.staging-$$"
  mkdir -p "$STAGED" || return 1
  log "staging source tarball $SOURCE"
  tar -xzf "$SOURCE" -C "$STAGED" --strip-components=1 2>/dev/null \
    || tar -xf "$SOURCE" -C "$STAGED" --strip-components=1 2>/dev/null \
    || tar -xzf "$SOURCE" -C "$STAGED" 2>/dev/null \
    || tar -xf "$SOURCE" -C "$STAGED" \
    || { warn "could not extract $SOURCE"; return 1; }
  flatten_stage "$STAGED"
  return 0
}

clone_repo_at_ref() { # ref git_url dest -> 0 when dest holds a checkout of ref
  local r="$1" u="$2" d="$3"
  rm -rf "$d"
  if run_logged "Cloning release repository ($r)" 300 "$PREFIX" git clone --depth 1 --branch "$r" "$u" "$d"; then
    return 0
  fi
  # --branch accepts only a branch or tag name; a pinned commit SHA (or a
  # branch the depth-1 clone did not fetch) needs a shallow fetch plus detach.
  rm -rf "$d"
  run_logged "Cloning release repository" 300 "$PREFIX" git clone --depth 1 "$u" "$d" || return 1
  if ( cd "$d" && run_limited 120 git fetch --depth 1 origin "$r" >/dev/null 2>&1 ); then
    ( cd "$d" && run_limited 60 git checkout --detach FETCH_HEAD >/dev/null 2>&1 ) || return 1
  else
    ( cd "$d" && run_limited 60 git checkout --detach "$r" >/dev/null 2>&1 ) || return 1
  fi
  return 0
}

stage_remote() { # url
  local url="$1" archive cache_dir cache_file ref_slug
  cache_dir="$PREFIX/harness/.cache"
  mkdir -p "$cache_dir" || return 1
  local ref="${REF:-$CHANNEL}"
  # A ref may contain `/` (feature branches); the cache file name must not
  # grow a directory component.
  ref_slug="$(printf '%s' "$ref" | tr '/ ' '__')"
  # Key the cache by the resolved commit: a channel that moved must never reuse
  # the previous commit's archive (a stale cache once staged the old version
  # under the new commit's name). Without a resolved commit the ref key keeps
  # the offline path working.
  if [ -n "${TARGET_COMMIT:-}" ]; then
    cache_file="$cache_dir/archive-${ref_slug}-${TARGET_COMMIT}.tar.gz"
    local stale
    for stale in "$cache_dir"/archive-"${ref_slug}"*.tar.gz; do
      [ -e "$stale" ] || continue
      [ "$stale" = "$cache_file" ] && continue
      rm -f "$stale"
    done
  else
    cache_file="$cache_dir/archive-${ref_slug}.tar.gz"
  fi
  STAGED="$PREFIX/harness/.staging-$$"
  mkdir -p "$STAGED" || return 1

  local use_cache=0
  if [ "${FORCE:-0}" != 1 ] && [ -s "$cache_file" ]; then
    if tar -tzf "$cache_file" >/dev/null 2>&1; then
      use_cache=1
      log "using cached release archive: $cache_file"
      substep_ok "Using cached release archive (${ref})"
    else
      rm -f "$cache_file"
    fi
  fi

  if [ "$use_cache" = 0 ]; then
    archive="$PREFIX/harness/.download-$$.tar.gz"
    log "fetching $url"
    local dl_timeout="${DSH_DOWNLOAD_TIMEOUT:-600}"
    if ! run_logged "Downloading release archive" "$dl_timeout" "$PREFIX" curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 30 --speed-limit 10240 --speed-time 60 "$url" -o "$archive"; then
      rm -f "$archive"
      # Fallback to git clone if curl download fails or times out
      if command -v git >/dev/null 2>&1; then
        log "direct archive download failed; falling back to shallow git clone ($ref)"
        substep_ok "Direct download timed out; falling back to git clone (${ref})"
        local git_url="${DSH_GITHUB_URL:-https://github.com/Darthph0enix7/enpoi-harness}"
        case "$git_url" in *.git) :;; *) git_url="$git_url.git";; esac
        if clone_repo_at_ref "$ref" "$git_url" "$STAGED"; then
          rm -rf "$STAGED/.git"
          flatten_stage "$STAGED"
          return 0
        fi
      fi
      warn "download failed: $url"
      return 1
    fi
    cp "$archive" "$cache_file" 2>/dev/null || true
  else
    archive="$cache_file"
  fi

  run_logged "Extracting release archive" 60 "$PREFIX" tar -xzf "$archive" -C "$STAGED" --strip-components=1 || { warn "could not extract release archive"; [ "$archive" != "$cache_file" ] && rm -f "$archive"; return 1; }
  [ "$archive" != "$cache_file" ] && rm -f "$archive"
  flatten_stage "$STAGED"
  return 0
}

# ── Prebuilt release fast path ──────────────────────────────────────────────
# The release workflow publishes one GitHub Release per build, tagged
# `v<tree version>.<run number>` (e.g. `v0.1.7-enpoi.2.42`), holding exactly
# the per-platform, fully built harness tarballs and their SHA-256 sidecars:
#   dsh-harness-<release version>-<os>-<arch>.tar.gz (+ .sha256)
# The release tag names the build — no commit SHA appears anywhere in the asset
# name — and installing it removes the pnpm install + full build (~5 minutes)
# and needs no build toolchain. The checksum is mandatory; any failure falls
# back to the source build with a warning, never to an unverified artifact.
sha256_of() { # file
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else printf ''; fi
}

# Newest published release tag, from the `/releases/latest` redirect: anonymous,
# outside the API rate limit, and GitHub excludes draft releases (a build still
# in progress) and prereleases. Both channels resolve this same stream because
# the two channel branches are pushed with the same commit; the source-archive
# fallback still uses the channel ref. Empty when no release exists yet.
latest_release_tag() { # -> `v<version>` or empty
  local target=""
  target="$(run_limited 30 curl -fsS -o /dev/null -w '%{redirect_url}' --connect-timeout 10 "$DSH_GITHUB_URL/releases/latest" 2>/dev/null || true)"
  case "$target" in
    */releases/tag/*) printf '%s' "${target##*/}";;
    *) printf '';;
  esac
}

# A release tag appends one numeric build suffix to the tree's own version:
# 0.1.7-enpoi.2 -> 0.1.7-enpoi.2.42. The packaged tree keeps the base version,
# so the staged-version check accepts it; a version without a prerelease marker
# or with a non-numeric tail is its own base.
release_base_version() { # release-version -> tree base version
  local v="$1" tail
  case "$v" in *-*) : ;; *) printf '%s' "$v"; return 0;; esac
  tail="${v##*.}"
  case "$tail" in ''|*[!0-9]*) printf '%s' "$v"; return 0;; esac
  printf '%s' "${v%.*}"
}

write_fast_downloader() { # target_path
  local target="$1" tmp
  mkdir -p "$(dirname "$target")" || return 1
  tmp="$target.tmp.$$"
  cat <<'FAST_DL_EOF' > "$tmp" || return 1
#!/usr/bin/env node
/**
 * High-performance, resumable, parallel chunk downloader for DSH releases.
 * Zero external dependencies — runs on Node.js >= 22 built-ins.
 *
 * Exit codes:
 *   0: success (downloaded and verified)
 *   1: general failure (network errors after retries)
 *   2: server does not support byte ranges (signal to fall back to single-stream curl)
 *   3: checksum verification mismatch
 * 130: interrupted (SIGINT/SIGTERM, partial chunks preserved for resume)
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const url = process.argv[2]
const outputFile = process.argv[3]
const rawConcurrency = process.argv[4] ? parseInt(process.argv[4], 10) : parseInt(process.env.DSH_DOWNLOAD_CONCURRENCY || '6', 10)
const expectedSha256 = (process.argv[5] || process.env.DSH_DOWNLOAD_EXPECTED_SHA256 || '').trim()

if (!url || !outputFile) {
  console.error('usage: download-fast.mjs <url> <output-file> [concurrency] [expected-sha256]')
  process.exit(1)
}

const concurrency = Math.max(1, Math.min(16, isNaN(rawConcurrency) ? 6 : rawConcurrency))
const stallTimeoutMs = parseInt(process.env.DSH_DOWNLOAD_STALL_MS || '30000', 10)
const maxRetries = 5

let isAborting = false
const activeControllers = new Set()

function handleAbort(sig) {
  if (isAborting) return
  isAborting = true
  process.stderr.write(`\n[download] ${sig} received; pausing transfer and preserving completed chunks...\n`)
  for (const ac of activeControllers) {
    try { ac.abort() } catch {}
  }
  setTimeout(() => process.exit(130), 100).unref()
}

process.on('SIGINT', () => handleAbort('SIGINT'))
process.on('SIGTERM', () => handleAbort('SIGTERM'))

async function fetchHead(targetUrl) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20000)
  try {
    const resp = await fetch(targetUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ac.signal,
    })
    clearTimeout(timer)
    if (!resp.ok && resp.status !== 206) return null
    const lenHeader = resp.headers.get('content-length')
    const rangeHeader = resp.headers.get('accept-ranges')
    const totalBytes = lenHeader ? parseInt(lenHeader, 10) : NaN
    const finalUrl = resp.url || targetUrl
    return {
      status: resp.status,
      totalBytes: isNaN(totalBytes) || totalBytes <= 0 ? null : totalBytes,
      supportsRanges: rangeHeader === 'bytes' || Boolean(resp.headers.get('content-range')),
      finalUrl,
    }
  } catch {
    clearTimeout(timer)
    return null
  }
}

async function verifyExistingTarget(targetPath, expectedHash) {
  if (!existsSync(targetPath)) return false
  if (!expectedHash) return statSync(targetPath).size > 0
  try {
    const hash = createHash('sha256')
    const stream = createReadStream(targetPath)
    await pipeline(stream, hash)
    return hash.digest('hex').toLowerCase() === expectedHash.toLowerCase()
  } catch {
    return false
  }
}

async function main() {
  if (expectedSha256 && await verifyExistingTarget(outputFile, expectedSha256)) {
    console.log(`[download] cached file verified matching sha256: ${outputFile}`)
    process.exit(0)
  }

  const head = await fetchHead(url)
  if (!head || !head.totalBytes) {
    console.warn('[download] server did not return content length; falling back to single-stream')
    process.exit(2)
  }

  if (!head.supportsRanges && concurrency > 1) {
    console.warn('[download] server does not advertise accept-ranges: bytes; falling back to single-stream')
    process.exit(2)
  }

  const totalBytes = head.totalBytes
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1)
  const chunkDir = `${outputFile}.chunks`
  const manifestPath = `${chunkDir}/manifest.json`

  mkdirSync(chunkDir, { recursive: true })

  let validManifest = false
  if (existsSync(manifestPath)) {
    try {
      const saved = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (saved.url === url && saved.totalBytes === totalBytes && saved.concurrency === concurrency) {
        validManifest = true
      }
    } catch {}
  }

  if (!validManifest) {
    rmSync(chunkDir, { recursive: true, force: true })
    mkdirSync(chunkDir, { recursive: true })
    const manifestData = { url, totalBytes, concurrency, createdAt: Date.now() }
    writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2))
  }

  const chunkSize = Math.ceil(totalBytes / concurrency)
  const chunks = []
  for (let i = 0; i < concurrency; i++) {
    const start = i * chunkSize
    const end = (i === concurrency - 1) ? (totalBytes - 1) : Math.min(start + chunkSize - 1, totalBytes - 1)
    chunks.push({
      index: i,
      start,
      end,
      expectedSize: (end - start + 1),
      partPath: `${chunkDir}/part-${i}`,
    })
  }

  let totalDownloadedBytes = 0
  for (const c of chunks) {
    if (existsSync(c.partPath)) {
      const sz = statSync(c.partPath).size
      if (sz === c.expectedSize) {
        totalDownloadedBytes += sz
      } else if (sz < c.expectedSize) {
        totalDownloadedBytes += sz
      } else {
        rmSync(c.partPath, { force: true })
      }
    }
  }

  const startTime = Date.now()
  let lastLogTime = 0
  const isTTY = Boolean(process.stdout.isTTY)

  const progressFile = `${chunkDir}/.progress`
  const topProgressFile = `${outputFile}.progress`

  function formatProgressBar(pct, currentMB, totalMB, speedMBs) {
    const width = 12
    const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
    const empty = width - filled
    const bar = '█'.repeat(filled) + '░'.repeat(empty)
    return `[${bar}] ${pct}% · ${currentMB}/${totalMB} MB · ${speedMBs.toFixed(1)} MB/s`
  }

  function writeProgress(text) {
    try {
      writeFileSync(progressFile, text)
      writeFileSync(topProgressFile, text)
    } catch {}
  }

  function reportProgress(force = false) {
    const now = Date.now()
    if (!force && now - lastLogTime < (isTTY ? 200 : 4000)) return
    lastLogTime = now
    const elapsedSec = Math.max(0.1, (now - startTime) / 1000)
    const currentMB = (totalDownloadedBytes / (1024 * 1024)).toFixed(1)
    const pct = Math.min(100, Math.floor((totalDownloadedBytes / totalBytes) * 100))
    const speedMBs = (totalDownloadedBytes / (1024 * 1024)) / elapsedSec
    const remainingBytes = Math.max(0, totalBytes - totalDownloadedBytes)
    const remainingSec = speedMBs > 0 ? Math.ceil((remainingBytes / (1024 * 1024)) / speedMBs) : 0

    writeProgress(formatProgressBar(pct, currentMB, totalMB, speedMBs))

    const msg = `[download] ${pct}% (${currentMB}/${totalMB} MB, ${speedMBs.toFixed(1)} MB/s, ~${remainingSec}s remaining)`
    if (isTTY) {
      process.stdout.write(`\r${msg}   `)
    } else {
      console.log(msg)
    }
  }

  reportProgress(true)

  async function downloadChunk(chunk) {
    let partSize = existsSync(chunk.partPath) ? statSync(chunk.partPath).size : 0
    if (partSize >= chunk.expectedSize) {
      return
    }

    let attempt = 0
    while (attempt < maxRetries && !isAborting) {
      attempt++
      partSize = existsSync(chunk.partPath) ? statSync(chunk.partPath).size : 0
      if (partSize >= chunk.expectedSize) return

      const rangeStart = chunk.start + partSize
      const rangeEnd = chunk.end

      const controller = new AbortController()
      activeControllers.add(controller)

      let stallTimer = null
      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          controller.abort(new Error('chunk transfer stalled'))
        }, stallTimeoutMs)
      }

      try {
        resetStallTimer()
        const resp = await fetch(url, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
          redirect: 'follow',
          signal: controller.signal,
        })

        if (!resp.ok && resp.status !== 206) {
          throw new Error(`HTTP ${resp.status} on chunk ${chunk.index}`)
        }

        const outStream = createWriteStream(chunk.partPath, { flags: 'a' })
        const nodeStream = Readable.fromWeb(resp.body)

        nodeStream.on('data', (buf) => {
          resetStallTimer()
          totalDownloadedBytes += buf.length
          reportProgress()
        })

        await pipeline(nodeStream, outStream)
        clearTimeout(stallTimer)
        activeControllers.delete(controller)
        return
      } catch (err) {
        clearTimeout(stallTimer)
        activeControllers.delete(controller)
        if (isAborting) return

        if (attempt >= maxRetries) {
          throw new Error(`chunk ${chunk.index} failed after ${maxRetries} attempts: ${err.message}`)
        }
        await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 10000)))
      }
    }
  }

  const queue = [...chunks]
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0 && !isAborting) {
      const c = queue.shift()
      if (c) await downloadChunk(c)
    }
  })

  await Promise.all(workers)

  if (isAborting) {
    process.exit(130)
  }

  reportProgress(true)
  if (isTTY) process.stdout.write('\n')

  for (const c of chunks) {
    if (!existsSync(c.partPath)) throw new Error(`missing chunk ${c.index}`)
    const sz = statSync(c.partPath).size
    if (sz !== c.expectedSize) throw new Error(`incomplete chunk ${c.index} (got ${sz}, expected ${c.expectedSize})`)
  }

  console.log(`[download] assembling ${concurrency} parts into ${outputFile}...`)
  writeProgress('[assembling] verifying SHA-256...')
  const downloadFile = `${outputFile}.download`
  const outStream = createWriteStream(downloadFile)
  const hash = createHash('sha256')

  for (const c of chunks) {
    const partStream = createReadStream(c.partPath)
    await new Promise((resolve, reject) => {
      partStream.on('data', (buf) => {
        hash.update(buf)
        outStream.write(buf)
      })
      partStream.on('end', resolve)
      partStream.on('error', reject)
    })
  }

  await new Promise((resolve, reject) => {
    outStream.end(() => resolve())
    outStream.on('error', reject)
  })

  const actualSha256 = hash.digest('hex').toLowerCase()
  if (expectedSha256) {
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      rmSync(downloadFile, { force: true })
      rmSync(chunkDir, { recursive: true, force: true })
      try { rmSync(topProgressFile, { force: true }) } catch {}
      console.error(`[download] SHA-256 verification failed! Expected: ${expectedSha256}, actual: ${actualSha256}`)
      process.exit(3)
    }
    console.log(`[download] SHA-256 verified (${actualSha256.slice(0, 16)}...)`)
  }

  renameSync(downloadFile, outputFile)
  rmSync(chunkDir, { recursive: true, force: true })
  try { rmSync(topProgressFile, { force: true }) } catch {}
  console.log(`[download] successfully finished: ${outputFile} (${totalMB} MB)`)
  process.exit(0)
}

main().catch((err) => {
  if (!isAborting) {
    console.error(`[download] error: ${err.message}`)
    process.exit(1)
  }
})
FAST_DL_EOF
  chmod 755 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$target" || return 1
}

resolve_fast_downloader() { # cache_dir -> prints path to fast downloader script
  local cdir="$1" script_dir
  script_dir="$(dirname "$0" 2>/dev/null || true)"
  if [ -n "${REPO_ROOT:-}" ] && [ -f "$REPO_ROOT/scripts/download-fast.mjs" ]; then
    printf '%s\n' "$REPO_ROOT/scripts/download-fast.mjs"
    return 0
  fi
  if [ -f "$script_dir/download-fast.mjs" ]; then
    printf '%s\n' "$script_dir/download-fast.mjs"
    return 0
  fi
  if [ -f "$script_dir/scripts/download-fast.mjs" ]; then
    printf '%s\n' "$script_dir/scripts/download-fast.mjs"
    return 0
  fi
  local target="$cdir/.download-fast.mjs"
  if [ ! -s "$target" ]; then
    write_fast_downloader "$target" || return 1
  fi
  printf '%s\n' "$target"
}

stage_prebuilt() { # stages the verified prebuilt tree into $STAGED; 1 = fall back
  [ "${NO_PREBUILT:-0}" = 1 ] && return 1
  [ "${DSH_NO_PREBUILT:-0}" = 1 ] && return 1
  [ -n "$SOURCE" ] && return 1
  local tag version base asset url sha_url cache_dir asset_file expected actual staged_version probe_headers asset_bytes
  tag="$(latest_release_tag)"
  if [ -z "$tag" ]; then
    log "prebuilt: no published release is available yet (release CI may still be building it)"
    return 1
  fi
  case "$tag" in v?*) : ;; *) return 1;; esac
  version="${tag#v}"
  base="$(release_base_version "$version")"
  asset="dsh-harness-$version-$OS-$ARCH.tar.gz"
  url="$DSH_GITHUB_URL/releases/download/$tag/$asset"
  sha_url="$url.sha256"
  cache_dir="$PREFIX/harness/.cache"
  asset_file="$cache_dir/$asset"
  mkdir -p "$cache_dir" || return 1

  # Fetch checksum first so download verification can validate hash streamingly on assembly
  if [ ! -s "$asset_file.sha256" ]; then
    curl -fsSL --retry 2 --connect-timeout 20 "$sha_url" -o "$asset_file.sha256" 2>/dev/null || true
  fi
  expected="$(awk 'NR==1 {print $1}' "$asset_file.sha256" 2>/dev/null || true)"

  # Verify existing cached archive if present
  if [ -s "$asset_file" ] && [ -n "$expected" ]; then
    actual="$(sha256_of "$asset_file")"
    if [ "$actual" = "$expected" ]; then
      log "prebuilt: reusing verified cached archive ($asset)"
    else
      log "prebuilt: cached archive corrupt or mismatched; re-fetching"
      rm -f "$asset_file"
    fi
  fi

  if [ ! -s "$asset_file" ]; then
    # Probe before the logged download: a release whose build is still running
    # publishes no asset yet, and that must read as a normal fallback, not as a
    # failed download. `--range 0-0` keeps the probe tiny; the trailing status
    # code (`-w`) is the last line because the header block ends with a
    # newline, and a non-2xx answer is the absence signal — GitHub still writes
    # 404 headers, so header presence alone would misread as an asset.
    probe_headers="$(curl -sSL --range 0-0 --connect-timeout 15 --max-time 30 -D - -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    probe_status="$(printf '%s\n' "$probe_headers" | tail -n 1 | tr -d '\r')"
    case "$probe_status" in
      200|206) : ;;
      *)
        log "prebuilt: release $tag carries no ${OS}-${ARCH} asset yet (release CI may still be building it)"
        return 1;;
    esac
    asset_bytes="$(printf '%s\n' "$probe_headers" | tr -d '\r' | sed -n 's/^content-range: *bytes [0-9]*-[0-9]*\/\([0-9]*\).*/\1/ip' | head -n 1)"
    log "prebuilt: fetching $asset${asset_bytes:+ ($((asset_bytes / 1048576)) MB)}"

    local dl_ok=0
    # Fast parallel chunk engine if Node.js is available
    if [ -n "$NODE" ] && [ -x "$NODE" ]; then
      local fast_dl dl_rc=0
      fast_dl="$(resolve_fast_downloader "$cache_dir")"
      if [ -n "$fast_dl" ] && [ -f "$fast_dl" ]; then
        log "prebuilt: downloading with parallel chunk engine (Node.js)"
        if run_logged "Fetching prebuilt release ($OS-$ARCH, parallel)" "${DSH_PREBUILT_TIMEOUT:-1800}" "$PREFIX" "$NODE" "$fast_dl" "$url" "$asset_file" "${DSH_DOWNLOAD_CONCURRENCY:-6}" "$expected"; then
          dl_ok=1
        else
          dl_rc=$?
          if [ "$dl_rc" -eq 130 ]; then
            warn "prebuilt: download interrupted by user; completed chunks preserved for resume"
            exit 130
          elif [ "$dl_rc" -eq 2 ]; then
            log "prebuilt: server does not support parallel range chunks; falling back to single-stream curl"
          elif [ "$dl_rc" -eq 3 ]; then
            warn "prebuilt: checksum verification failed; falling back to single-stream curl"
            rm -f "$asset_file" "$asset_file.download"
          else
            log "prebuilt: parallel chunk download failed (exit $dl_rc); falling back to single-stream curl"
          fi
        fi
      fi
    fi

    # Fallback: single-stream curl if fast downloader was skipped or fell back
    if [ "$dl_ok" = 0 ]; then
      if ! run_logged "Downloading prebuilt harness ($OS-$ARCH)" "${DSH_PREBUILT_TIMEOUT:-1800}" "$PREFIX" curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 30 --speed-limit 10240 --speed-time 60 -C - "$url" -o "$asset_file.download"; then
        log "prebuilt: download failed; keeping the partial for a resumable retry ($asset_file.download); building from source for now"
        return 1
      fi
      mv "$asset_file.download" "$asset_file" || return 1
    fi

    if [ ! -s "$asset_file.sha256" ]; then
      if ! curl -fsSL --retry 1 --connect-timeout 20 "$sha_url" -o "$asset_file.sha256" 2>/dev/null; then
        rm -f "$asset_file" "$asset_file.sha256"
        warn "prebuilt: checksum file unavailable; falling back to the source build"
        return 1
      fi
      expected="$(awk 'NR==1 {print $1}' "$asset_file.sha256" 2>/dev/null || true)"
    fi
  fi
  expected="$(awk 'NR==1 {print $1}' "$asset_file.sha256")"
  actual="$(sha256_of "$asset_file")"
  if [ -z "$actual" ] || [ "$actual" != "$expected" ]; then
    warn "prebuilt: checksum mismatch; falling back to the source build"
    rm -f "$asset_file" "$asset_file.sha256"
    return 1
  fi
  STAGED="$PREFIX/harness/.staging-$$"
  mkdir -p "$STAGED" || return 1
  if ! tar -C "$STAGED" -xzf "$asset_file" 2>/dev/null; then
    warn "prebuilt: extraction failed; falling back to the source build"
    rm -rf "$STAGED"; STAGED=""
    return 1
  fi
  flatten_stage "$STAGED"
  staged_version="$(read_version "$STAGED/package.json" 2>/dev/null || true)"
  # The release version is the tree's base version plus the workflow run
  # number; the tree's package.json keeps the base. Accept either so a
  # manually tagged release at the exact tree version also validates.
  if [ "$staged_version" != "$version" ] && [ "$staged_version" != "$base" ]; then
    warn "prebuilt: payload version '$staged_version' is neither the release version '$version' nor its base '$base'; falling back to the source build"
    rm -rf "$STAGED"; STAGED=""
    return 1
  fi
  VERSION="$version"
  PREBUILT=1
  # The tag's own commit is the recorded build identity; empty when git and
  # the GitHub API cannot resolve it (install_tree then falls back to the
  # channel ref's commit).
  RELEASE_COMMIT="$(resolve_target_commit "$tag" "$DSH_GITHUB_URL")"
  return 0
}

prepare_source() {
  if [ -z "$SOURCE" ]; then
    local ref="${REF:-$CHANNEL}"
    # The channel ref names the tree; resolve its commit before choosing the
    # archive URL. Fetching by the resolved commit closes the window where a
    # branch advances between resolution and download: the staged tree is then
    # exactly the commit the cache key, the prebuilt asset, and the recorded
    # build identity name. `/archive/<ref>.tar.gz` resolves branches, tags, and
    # commit SHAs alike; the `refs/heads/` form 404s for a tag or pinned commit.
    SOURCE_URL="$DSH_GITHUB_URL/archive/$ref.tar.gz"
    resolve_target_for_source
    if [ -n "$TARGET_COMMIT" ]; then
      SOURCE_URL="$DSH_GITHUB_URL/archive/$TARGET_COMMIT.tar.gz"
    fi
    # If the target commit is known and already built and complete, reuse it directly
    if [ "${FORCE:-0}" != 1 ] && [ -n "$TARGET_COMMIT" ]; then
      local d name c
      for d in "$PREFIX/harness"/*; do
        [ -d "$d" ] || continue
        name="$(basename "$d")"
        case "$name" in .*|current|*.failed-*) continue;; esac
        if [ -f "$d/.dsh-install-complete" ]; then
          c="$(installed_tree_commit "$d")"
          if [ -n "$c" ] && commit_same "$TARGET_COMMIT" "$c"; then
            # The marker records the built identity: a release version for a
            # prebuilt tree, the base version for a source build. The tree's
            # package.json keeps the base version, so the marker wins.
            VERSION="$(json_field "$d/.dsh-install-complete" version 2>/dev/null || true)"
            [ -n "$VERSION" ] || VERSION="$(read_version "$d/package.json" 2>/dev/null || true)"
            if [ -n "$VERSION" ]; then
              TREE_DIR_NAME="$name"
              REUSED_TREE_DIR="$name"
              HARNESS="$d"
              substep_ok "Target build already complete: $TREE_DIR_NAME (reusing)"
              return 0
            fi
          fi
        fi
      done
    fi
    if stage_prebuilt; then
      substep_ok "Prebuilt release v$VERSION installed ($OS-$ARCH)"
      return 0
    fi
    if [ "$NO_PREBUILT" = 1 ] || [ "${DSH_NO_PREBUILT:-0}" = 1 ]; then
      log "prebuilt: disabled; building from source"
    else
      log "no prebuilt for $OS-$ARCH; building from source (~5 min)"
    fi
    stage_remote "$SOURCE_URL" || die "could not fetch the $CHANNEL channel build from $SOURCE_URL"
  elif [ -d "$SOURCE" ]; then
    VERSION="$(read_version "$SOURCE/package.json")" || die "could not read version from $SOURCE/package.json"
  elif [ -f "$SOURCE" ]; then
    stage_tarball "$SOURCE" || die "could not stage $SOURCE"
  else
    case "$SOURCE" in
      http://*|https://*) stage_remote "$SOURCE" || die "could not fetch $SOURCE";;
      *) die "source not found: $SOURCE";;
    esac
  fi
  if [ -z "$VERSION" ] && [ -n "$STAGED" ]; then
    VERSION="$(read_version "$STAGED/package.json")" || die "could not read version from the fetched source"
  fi
  [ -n "$VERSION" ] || die "could not determine the build version"
}

# ── Install / build ─────────────────────────────────────────────────────────
install_tree() { # installs $VERSION into $PREFIX/harness/${TREE_DIR_NAME:-$VERSION}; returns nonzero on failure
  local displaced=""
  HARNESS="$PREFIX/harness/${TREE_DIR_NAME:-$VERSION}"
  mkdir -p "$PREFIX/harness" || return 1
  if [ -e "$HARNESS" ]; then
    if [ -f "$HARNESS/.dsh-install-complete" ]; then
      if [ "$FORCE" = 1 ]; then
        log "force reinstall: replacing $HARNESS"
        displaced="$HARNESS.replaced-$$"
        rm -rf "$displaced"
        mv "$HARNESS" "$displaced" || { warn "could not move the existing tree aside"; return 1; }
      else
        log "version $VERSION is already installed at $HARNESS (reusing)"
        if [ -n "$STAGED" ]; then rm -rf "$STAGED"; STAGED=""; fi
        return 0
      fi
    else
      log "removing incomplete install at $HARNESS"
      rm -rf "$HARNESS" || return 1
    fi
  fi
  if [ -z "$STAGED" ]; then
    STAGED="$PREFIX/harness/.staging-$$"
    mkdir -p "$STAGED" || return 1
    log "staging source from $SOURCE"
    tar -C "$SOURCE" -cf - \
      --exclude='./.git' --exclude='.git' \
      --exclude='./node_modules' --exclude='node_modules' --exclude='*/node_modules' \
      --exclude='./dist' --exclude='./coverage' \
      --exclude='*.tsbuildinfo' . | tar -C "$STAGED" -xf - || { warn "staging failed"; return 1; }
  fi
  if ! mv "$STAGED" "$HARNESS"; then
    warn "could not move staged tree into $HARNESS"
    if [ -n "$displaced" ]; then mv "$displaced" "$HARNESS" 2>/dev/null || true; fi
    return 1
  fi
  STAGED=""
  if [ "$PREBUILT" = 1 ]; then
    # The tree arrived fully built and checksum-verified from the release
    # workflow: no dependency install, no compilation, no toolchain required.
    # The release tag's own commit is the build identity when it resolved.
    BUILD_COMMIT="${RELEASE_COMMIT:-${TARGET_COMMIT:-}}"
    [ -n "$BUILD_COMMIT" ] || resolve_build_commit
    printf '{"version": "%s", "commit": "%s", "installedAt": "%s"}\n' "$VERSION" "$BUILD_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HARNESS/.dsh-install-complete" || return 1
    if [ -n "$displaced" ]; then rm -rf "$displaced" || true; fi
    substep_ok "Prebuilt tree installed (no build required)"
    return 0
  fi
  if ! run_logged "Installing workspace dependencies" "$INSTALL_TIMEOUT" "$HARNESS" "$PNPM" install --frozen-lockfile; then
    warn "pnpm install failed"
    if [ -n "$displaced" ]; then rm -rf "$HARNESS"; mv "$displaced" "$HARNESS" 2>/dev/null || true; fi
    return 1
  fi
  resolve_build_commit
  if [ -z "$BUILD_COMMIT" ] && [ -n "${TARGET_COMMIT:-}" ]; then BUILD_COMMIT="$TARGET_COMMIT"; fi
  if [ -n "$BUILD_COMMIT" ]; then export DSH_CLIENT_COMMIT_HASH="$BUILD_COMMIT"; fi
  if [ "$BUILD_DIRTY" = true ]; then export DSH_CLIENT_GIT_DIRTY=true; fi
  if ! run_logged "Building core harness & web client" "$BUILD_TIMEOUT" "$HARNESS" "$PNPM" run build; then
    warn "build failed"
    if [ -n "$displaced" ]; then rm -rf "$HARNESS"; mv "$displaced" "$HARNESS" 2>/dev/null || true; fi
    return 1
  fi
  printf '{"version": "%s", "commit": "%s", "installedAt": "%s"}\n' "$VERSION" "$BUILD_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HARNESS/.dsh-install-complete" || return 1
  if [ -n "$displaced" ]; then rm -rf "$displaced" || true; fi
  return 0
}

# ── $DSH_HOME seeding and profile plugin build ──────────────────────────────
resolve_home() {
  if [ -z "$DSH_HOME" ]; then DSH_HOME="$HOME/.dsh"; fi
  export DSH_HOME
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
}

seed_home() {
  resolve_home
  mkdir -p "$DSH_HOME" || return 1
  run_logged "Seeding default configuration ($PROFILE)" 300 "$DSH_HOME" "$NODE" "$HARNESS/apps/cli/lib/bin.js" --profile "$PROFILE" --dump-default-config >/dev/null 2>&1 \
    || warn "profile seed for '$PROFILE' did not complete (continuing; existing files are never touched)"
  return 0
}

run_profile_plugin_build() {
  local script="$PROFILE_DIR/build-plugins.sh"
  if [ -f "$script" ]; then
    run_logged "Verifying Enpoi profile plugins" "$PROFILE_BUILD_TIMEOUT" "$PROFILE_DIR" bash "$script" "$PROFILE_DIR" || { warn "profile plugin build failed"; return 1; }
  else
    log "profile plugin build: no build-plugins.sh in $PROFILE_DIR (nothing to build)"
  fi
  return 0
}

# ── Companion profile source (distribution) ─────────────────────────────────
# The profile is a separate versioned repo: plugin sources, patches, presets,
# skills, and build scripts. The installer fetches it into $DSH_HOME/profiles/
# <name> before the template seed, never overwrites user state (`settings.yaml`,
# `cordis.patch.yml`, `device-patches/`), and installs its dependencies.
profile_source_kind() { # src -> dir|tarball|git|unknown
  local src="$1"
  if [ -d "$src" ]; then printf 'dir'; return 0; fi
  if [ -f "$src" ]; then printf 'tarball'; return 0; fi
  case "$src" in
    *.tar.gz|*.tgz|*.tar|*.zip) printf 'tarball';;
    *.git) printf 'git';;
    http://*|https://*) printf 'git';;
    git://*|ssh://*|git@*) printf 'git';;
    *) printf 'unknown';;
  esac
}

resolve_profile_token() {
  if [ -z "$PROFILE_TOKEN" ] && command -v gh >/dev/null 2>&1; then
    PROFILE_TOKEN="$(run_limited 10 gh auth token 2>/dev/null || true)"
  fi
  return 0
}

profile_auth_header() { # HTTP Basic with x-access-token, for private GitHub sources
  [ -n "$PROFILE_TOKEN" ] || return 0
  local b64
  b64="$(printf 'x-access-token:%s' "$PROFILE_TOKEN" | base64 2>/dev/null | tr -d '\n')"
  [ -n "$b64" ] || return 0
  printf 'Authorization: Basic %s' "$b64"
}

stage_profile_source() { # src kind stage
  local src="$1" kind="$2" stage="$3" tarball args
  case "$kind" in
    dir)
      ( cd "$src" && tar -cf - --exclude='./.git' --exclude='.git' \
          --exclude='./node_modules' --exclude='node_modules' --exclude='*/node_modules' . ) \
        | tar -C "$stage" -xf - || return 1
      ;;
    tarball)
      tarball="$src"
      if [ ! -f "$tarball" ]; then
        tarball="$stage/.profile-download"
        if [ -n "$PROFILE_TOKEN" ]; then
          curl -fsSL --retry 2 --connect-timeout 20 -H "$(profile_auth_header)" "$src" -o "$tarball" || return 1
        else
          curl -fsSL --retry 2 --connect-timeout 20 "$src" -o "$tarball" || return 1
        fi
      fi
      tar -xzf "$tarball" -C "$stage" --strip-components=1 2>/dev/null \
        || tar -xf "$tarball" -C "$stage" || return 1
      [ "$tarball" = "$src" ] || rm -f "$tarball"
      ;;
    git)
      args=(-c advice.detachedHead=false)
      [ -n "$PROFILE_TOKEN" ] && args+=(-c "http.extraheader=$(profile_auth_header)")
      args+=(clone --depth 1)
      [ -n "$PROFILE_REF" ] && args+=(--branch "$PROFILE_REF")
      GIT_TERMINAL_PROMPT=0 run_limited 600 git "${args[@]}" "$src" "$stage" || return 1
      ;;
    *)
      warn "unsupported profile source: $src"; return 1;;
  esac
  return 0
}

# The three strippers below remove configured-machine state from a freshly
# copied profile patch in place. They exist as a second line of defence behind
# the sanitized repo template: a source tree that is itself a live profile (a
# local profile dir, a stale clone) must still install a fresh home. Editing
# the text line-by-line keeps the large YAML document's formatting, multi-line
# strings, and `!!js` tags intact.

# Drop the `onboardingCompleted` marker: a fresh home must boot into the
# first-run wizard, while the live profile keeps its marker (that setup is
# complete).
strip_onboarding_completed() { # patch-file
  local file="$1" tmp="$1.strip-$$"
  [ -f "$file" ] || return 0
  cp -p "$file" "$tmp"
  grep -v -E '^[[:space:]]*onboardingCompleted:' "$file" > "$tmp" || true
  if [ -s "$tmp" ]; then mv "$tmp" "$file"; else rm -f "$tmp"; fi
  return 0
}

# Drop whole top-level `- id: <id>` rows (and their blocks): the settings rows
# a configured machine accumulates — its provider routes, its default-model
# seat, its UI settings.
strip_patch_rows() { # patch-file id...
  local file="$1" tmp="$1.rows-$$"
  shift
  [ -f "$file" ] || return 0
  awk -v ids="$*" '
    BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") drop[a[i]] = 1 }
    /^- / { id = $0; sub(/^- id:[[:space:]]*/, "", id); sub(/[[:space:]]+$/, "", id); skip = (id in drop) }
    !skip { print }
  ' "$file" > "$tmp"
  if [ -s "$tmp" ]; then mv "$tmp" "$file"; else rm -f "$tmp"; fi
  return 0
}

# Drop operator-owned sections (4-space keys such as `    permissions:`) from
# the `enpoi-orchestration` row: seats, grants, MCP catalog/status, chains,
# favorites, whiteboard, tool-group overrides. Only that row is touched.
strip_patch_sections() { # patch-file key...
  local file="$1" tmp="$1.sect-$$"
  shift
  [ -f "$file" ] || return 0
  awk -v keys="$*" '
    BEGIN { n = split(keys, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") drop[a[i]] = 1 }
    /^- / { inorch = ($0 == "- id: enpoi-orchestration") }
    inorch && /^    [A-Za-z0-9_@.\/-]+:/ { key = $0; sub(/^    /, "", key); sub(/:.*/, "", key); skip = (key in drop) }
    !skip { print }
  ' "$file" > "$tmp"
  if [ -s "$tmp" ]; then mv "$tmp" "$file"; else rm -f "$tmp"; fi
  return 0
}

# Drop every `roles` entry that is not a template exception. The tracked
# template carries only designer/oracle (keys label/group/seat); operator
# roles, routes, and extra keys are removed entry-by-entry, so a live-sourced
# tree can never seed them through the operator-owned `roles` section name.
# Personas are not a template exception at all: they are route state the
# first-run seed writes (packages/host/first-run), so the whole `personas`
# section is stripped like every other operator-owned section. Allowlists mirror
# scripts/verify-profile-template.mjs and
# packages/enpoi-capabilities/tests/profile-patch.spec.ts; pinned in lockstep
# by scripts/install-profile-merge.spec.ts.
PROFILE_PATCH_TEMPLATE_ROLE_IDS="designer oracle"
PROFILE_PATCH_TEMPLATE_ROLE_KEYS="label group seat"

strip_template_entry_sections() { # patch-file
  local file="$1" tmp
  tmp="$(mktemp)" || return 0
  awk -v r_ids="$PROFILE_PATCH_TEMPLATE_ROLE_IDS" \
      -v r_keys="$PROFILE_PATCH_TEMPLATE_ROLE_KEYS" '
    BEGIN {
      n = split(r_ids, a, " "); for (i = 1; i <= n; i++) role_id[a[i]] = 1
      n = split(r_keys, a, " "); for (i = 1; i <= n; i++) role_key[a[i]] = 1
    }
    /^- / { inorch = 0; section = "" }
    /^[^[:space:]]/ { section = "" }
    /^- id: enpoi-orchestration$/ { inorch = 1; print; next }
    inorch && /^    [A-Za-z0-9_@.\/-]+:/ {
      key = $0; sub(/^    /, "", key); sub(/:.*/, "", key)
      if (key == "roles") { section = "roles"; print; next }
      section = ""; print; next
    }
    section == "roles" {
      if ($0 ~ /^      [A-Za-z0-9_-]+:[[:space:]]*$/) {
        id = $0; sub(/^[[:space:]]+/, "", id); sub(/:.*/, "", id)
        if (id in role_id) { print; current = id } else { current = "" }
        next
      }
      if ($0 ~ /^        [A-Za-z0-9_-]+:/) {
        k = $0; sub(/^[[:space:]]+/, "", k); sub(/:.*/, "", k)
        if (current != "" && k in role_key) print
        next
      }
      if ($0 ~ /^[[:space:]]*$/) { print; next }
      next
    }
    { print }
  ' "$file" > "$tmp"
  if [ -s "$tmp" ]; then mv "$tmp" "$file"; else rm -f "$tmp"; fi
  return 0
}

# Whether a document's `roles` section carries only the template exceptions. A
# disallowed entry id or an extra key fails the check; the section name itself
# stays operator-owned. `personas` is operator state end to end and is checked
# by the generic operator-section loop in assert_fresh_patch.
assert_template_entry_sections() { # patch-file -> 0 when only template entries are present
  local file="$1"
  awk -v r_ids="$PROFILE_PATCH_TEMPLATE_ROLE_IDS" \
      -v r_keys="$PROFILE_PATCH_TEMPLATE_ROLE_KEYS" '
    BEGIN {
      n = split(r_ids, a, " "); for (i = 1; i <= n; i++) role_id[a[i]] = 1
      n = split(r_keys, a, " "); for (i = 1; i <= n; i++) role_key[a[i]] = 1
    }
    /^- / { inorch = 0; section = "" }
    /^[^[:space:]]/ { section = "" }
    /^- id: enpoi-orchestration$/ { inorch = 1; next }
    inorch && /^    [A-Za-z0-9_@.\/-]+:/ {
      key = $0; sub(/^    /, "", key); sub(/:.*/, "", key)
      if (key == "roles") section = "roles"
      else section = ""
      next
    }
    section == "roles" {
      if ($0 ~ /^[[:space:]]*$/) next
      if ($0 ~ /^      [A-Za-z0-9_-]+:[[:space:]]*$/) {
        id = $0; sub(/^[[:space:]]+/, "", id); sub(/:.*/, "", id)
        if (!(id in role_id)) bad = 1
        current = id
        next
      }
      if ($0 ~ /^        [A-Za-z0-9_-]+:/) {
        k = $0; sub(/^[[:space:]]+/, "", k); sub(/:.*/, "", k)
        if (!(current in role_id) || !(k in role_key)) bad = 1
        next
      }
      bad = 1; next
    }
    { next }
    END { exit bad ? 1 : 0 }
  ' "$file"
}

# Fresh-home patch: strip everything that belongs to the configured machine.
strip_fresh_patch() { # patch-file
  local file="$1"
  strip_patch_rows "$file" agent-default-model ui-settings-general ui-settings-models ui-theme llm-pi-ai
  strip_patch_sections "$file" capabilities mcpServers mcpStatus personas councils chains \
    catalogRules uiPreferences permissions whiteboard toolGroups
  strip_template_entry_sections "$file"
  strip_onboarding_completed "$file"
  return 0
}

# Refuse to seed operator state. This is the same split the profile repo pins
# in packages/enpoi-capabilities/tests/profile-patch.spec.ts: a source tree
# that still carries the configured machine's rows after stripping is a
# packaging bug, and end-user installs must never inherit the operator's
# providers, default model, UI settings, seats, personas, grants, or MCP
# catalog. `roles` stays an operator-owned name with the template exceptions
# checked by assert_template_entry_sections; `personas` is operator state with
# no template exception.
assert_fresh_patch() { # patch-file -> 0 when the document carries no operator state
  local file="$1" id section
  [ -f "$file" ] || return 0
  for id in agent-default-model llm-pi-ai ui-settings-general ui-settings-models ui-theme; do
    if grep -qE "^[[:space:]]*- id:[[:space:]]*$id[[:space:]]*$" "$file"; then
      warn "profile patch carries operator state row '$id'"
      return 1
    fi
  done
  if grep -qE '^[[:space:]]*onboardingCompleted:' "$file"; then
    warn "profile patch carries the onboardingCompleted marker"
    return 1
  fi
  if grep -qE '^[[:space:]]*providers:' "$file"; then
    warn "profile patch carries a providers block"
    return 1
  fi
  for section in $PROFILE_PATCH_OPERATOR_SECTIONS; do
    case "$section" in roles) continue;; esac
    if awk -v key="$section" '
      /^- / { inorch = ($0 == "- id: enpoi-orchestration") }
      inorch && /^    [A-Za-z0-9_@.\/-]+:/ { k = $0; sub(/^    /, "", k); sub(/:.*/, "", k); if (k == key) found = 1 }
      END { exit found ? 0 : 1 }
    ' "$file"; then
      warn "profile patch carries operator-owned section '$section'"
      return 1
    fi
  done
  if ! assert_template_entry_sections "$file"; then
    warn "profile patch carries operator state inside the template roles entries"
    return 1
  fi
  return 0
}

copy_profile_tree() { # src dst mode(seed|refresh)
  # seed: first install, all shipped files land (the dir is fresh).
  # refresh: user state survives — settings.yaml, cordis.patch.yml (the
  # config-editor document), device-patches/, node_modules/, backups.
  # Profile-shipped fish/ and systemd/ files are re-seeded when their content
  # changed: a stale function or unit must not survive an update silently.
  local src="$1" dst="$2" mode="${3:-seed}" rel d
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    case "$rel" in
      .git|.git/*|node_modules|node_modules/*|*/node_modules|*/node_modules/*) continue;;
      .backup-*|.backup-*/*) continue;;
      settings.yaml|device-patches|device-patches/*) continue;;
      fresh-settings.yaml|presets|presets/*) continue;;
    esac
    if [ "$mode" = refresh ]; then
      case "$rel" in
        cordis.patch.yml) continue;;
        # Operator-owned manifests: the dependency union in refresh_profile_merges
        # merges the shipped dependency keys into the live file, so a shipped
        # copy must never clobber user-added dependencies. The lock and
        # workspace files are operator-resolved state; seed them only when the
        # live profile has none.
        package.json) continue;;
        pnpm-lock.yaml|pnpm-workspace.yaml)
          [ -f "$dst/$rel" ] && continue
          ;;
      esac
      case "$rel" in
        fish|fish/*|systemd|systemd/*)
          d="$dst/$rel"
          if [ -d "$src/$rel" ]; then
            mkdir -p "$d" || return 1
          elif [ ! -f "$d" ]; then
            mkdir -p "$(dirname "$d")" || return 1
            cp -p "$src/$rel" "$d" || return 1
            log "profile refresh: seeded $rel"
          elif ! cmp -s "$src/$rel" "$d"; then
            mkdir -p "$(dirname "$d")" || return 1
            cp -p "$src/$rel" "$d" || return 1
            log "profile refresh: re-seeded $rel (shipped content changed)"
          fi
          continue
          ;;
      esac
    fi
    d="$dst/$rel"
    if [ -d "$src/$rel" ]; then
      mkdir -p "$d" || return 1
    else
      mkdir -p "$(dirname "$d")" || return 1
      cp -p "$src/$rel" "$d" || return 1
      # Seed mode only (refresh keeps the live patch above): a fresh home must
      # not inherit the live device's wizard marker, settings rows, or
      # orchestration state.
      case "$rel" in
        cordis.patch.yml)
          strip_fresh_patch "$d"
          if ! assert_fresh_patch "$d"; then
            # Never seed operator state: drop the offending document so the
            # shipped upstream template seeds instead.
            rm -f "$d"
            warn "refused to seed operator state from $rel; the shipped template will seed instead"
            return 1
          fi
          ;;
      esac
    fi
  done < <( cd "$src" && find . -mindepth 1 -print0 )
  return 0
}

seed_file_once() { # src dst
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  [ -f "$dst" ] && return 0
  mkdir -p "$(dirname "$dst")" 2>/dev/null || return 0
  if cp -p "$src" "$dst" 2>/dev/null; then log "seeded $dst"; fi
  return 0
}

seed_dir_once() { # src-dir dst-dir
  local src="$1" dst="$2" rel
  [ -d "$src" ] || return 0
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    seed_file_once "$src/$rel" "$dst/$rel"
  done < <( cd "$src" && find . -type f -print0 )
  return 0
}

# Record for one seeded file: the shipped copy this record refers to and the
# live file's content when the installer last handled it.
write_seed_record() { # stamp shipped-hash live-hash
  printf '%s\n%s\n' "$2" "$3" > "$1" 2>/dev/null || true
  return 0
}

# The profile's fish function and completions are seeded into the user's fish
# config on first install and refreshed on every later install/update when the
# shipped content changed. The `.dsh-seeded` sidecar records the shipped hash
# and the live hash from the last handling: a live copy byte-identical to the
# recorded shipped copy is replaced; a copy with no record (a pre-refresh
# install) or a locally edited copy is kept byte-identical, with the updated
# shipped copy parked beside it and one warning naming both locations. Never
# fails the caller.
refresh_seeded_fish() { # src dst rel(relative to the profile root)
  local src="$1" dst="$2" rel="$3"
  [ -f "$src" ] || return 0
  local stamp="$dst.dsh-seeded" want have last_shipped="" last_live="" backup ts profile_copy
  want="$(sha256_of "$src" 2>/dev/null || true)"
  if [ -z "$want" ]; then
    # No digest tool on this host: fall back to the old seed-only behavior.
    seed_file_once "$src" "$dst"
    return 0
  fi
  if [ -f "$stamp" ]; then
    last_shipped="$(sed -n '1p' "$stamp" 2>/dev/null || true)"
    last_live="$(sed -n '2p' "$stamp" 2>/dev/null || true)"
  fi
  if [ ! -f "$dst" ]; then
    mkdir -p "$(dirname "$dst")" 2>/dev/null || return 0
    cp -p "$src" "$dst" 2>/dev/null || return 0
    write_seed_record "$stamp" "$want" "$want"
    log "seeded $dst"
    return 0
  fi
  have="$(sha256_of "$dst" 2>/dev/null || true)"
  if [ "$have" = "$want" ]; then
    # Already current; keep the record pointing at the shipped copy.
    write_seed_record "$stamp" "$want" "$have"
    return 0
  fi
  if [ -n "$have" ] && [ "$have" = "$last_shipped" ]; then
    if cp -p "$src" "$dst" 2>/dev/null; then
      write_seed_record "$stamp" "$want" "$want"
      log "refreshed $dst ($rel changed)"
    fi
    return 0
  fi
  if [ "$have" = "$last_live" ] && [ "$want" = "$last_shipped" ]; then
    # The same local edit was kept against the same shipped copy; the notice
    # already fired for it.
    return 0
  fi
  # Operator drift: keep the live file, park the updated shipped copy beside
  # it, and tell the operator where both copies are.
  ts="$(date +%Y%m%d-%H%M%S)"
  backup="$dst.dsh-shipped-$ts"
  [ -e "$backup" ] && backup="$backup-$$"
  if [ -n "${PROFILE_DIR:-}" ]; then profile_copy="$PROFILE_DIR/$rel"; else profile_copy="$src"; fi
  if cp -p "$src" "$backup" 2>/dev/null; then
    warn "$dst has local edits and was kept; the updated $rel is at $backup and lives in the profile tree at $profile_copy — merge it or remove $dst to re-seed"
  else
    warn "$dst has local edits and was kept; the updated $rel lives in the profile tree at $profile_copy — merge it or remove $dst to re-seed"
  fi
  write_seed_record "$stamp" "$want" "$have"
  return 0
}

seed_profile_home() { # stage
  local stage="$1" fish_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
  seed_file_once "$stage/fresh-settings.yaml" "$DSH_HOME/settings.yaml"
  # The legacy directory presets ($DSH_HOME/.agent-presets) are retired: agent
  # presets are declarative bundles now and the shipped profile's presets/ tree
  # is not read at runtime, so nothing is seeded there.
  # Shipped skills stay in the profile skills/ dir, which every preset mounts;
  # $DSH_HOME/skills holds only operator-created skills.
  seed_dir_once "$stage/skins" "$DSH_HOME/skins"
  seed_file_once "$stage/skin-center-active.json" "$DSH_HOME/skin-center-active.json"
  if [ -d "$fish_dir" ]; then
    refresh_seeded_fish "$stage/fish/ds.fish" "$fish_dir/functions/ds.fish" "fish/ds.fish"
    refresh_seeded_fish "$stage/fish/completions/ds.fish" "$fish_dir/completions/ds.fish" "fish/completions/ds.fish"
  fi
  return 0
}

# ── Additive profile refresh (update) ───────────────────────────────────────
# Operator-state rows/sections pinned by profile/web/scripts/verify-profile-template.mjs
# and profile/web/packages/enpoi-capabilities/tests/profile-patch.spec.ts. The
# merge below never introduces them into a live document, even when a
# compromised shipped template carries them.
PROFILE_PATCH_OPERATOR_ROWS="agent-default-model llm-pi-ai ui-settings-general ui-settings-models ui-theme"
PROFILE_PATCH_OPERATOR_SECTIONS="capabilities mcpServers mcpStatus personas roles councils chains catalogRules uiPreferences permissions whiteboard toolGroups"

# Additive-only merge of the shipped profile patch into the live document.
# Shipped top-level rows and shipped sections of the orchestration row that the
# live file lacks are appended; existing live rows are never modified or
# removed. A top-of-file `# dsh-ignore: id1, id2` comment opts those shipped ids
# out, like a live `disabled: true` row. Any parse doubt leaves the live file
# byte-identical and warns. The function returns 0 in every outcome — a failed
# merge never fails an update — and a successful merge keeps a timestamped
# backup next to the live file.
merge_profile_patch() { # shipped live
  local shipped="$1" live="$2" tmp="$2.merge-$$" summary="$2.merge-$$.summary" rc added_n=0 backup ts
  if [ ! -s "$shipped" ]; then
    warn "profile patch merge: shipped template is missing ($shipped); live patch left untouched"
    return 0
  fi
  if [ ! -s "$live" ]; then
    warn "profile patch merge: live patch is missing ($live); left untouched"
    return 0
  fi
  awk -v o_rows="$PROFILE_PATCH_OPERATOR_ROWS" -v o_sections="$PROFILE_PATCH_OPERATOR_SECTIONS" '
function trimid(s) { sub(/^[[:space:]]*- id:[[:space:]]*/, "", s); sub(/[[:space:]]+$/, "", s); return s }
function blockend(from, to,   e) {
  # Trailing blank lines and comments belong to the next entry preamble; keep
  # them out of an appended copy.
  e = to
  while (e > from && (s[e] ~ /^[[:space:]]*$/ || s[e] ~ /^[[:space:]]*#/)) e--
  return e
}
NR == FNR {
  sn++; s[sn] = $0
  if ($0 ~ /^- /) { snb++; sb[snb] = sn }
  next
}
{ ln++; l[ln] = $0 }
END {
  if (snb == 0) { print "shipped template carries no top-level entries" > "/dev/stderr"; exit 1 }
  n = split(o_rows, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") operator_row[a[i]] = 1
  n = split(o_sections, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") operator_section[a[i]] = 1
  sb[snb + 1] = sn + 1
  lnb = 0
  for (i = 1; i <= ln; i++) if (l[i] ~ /^- /) { lnb++; lb[lnb] = i }
  lb[lnb + 1] = ln + 1
  firstblock = (lnb > 0) ? lb[1] : ln + 1
  for (i = 1; i < firstblock; i++) {
    if (l[i] !~ /^[[:space:]]*$/ && l[i] !~ /^[[:space:]]*#/) { print "live patch has unrecognized content before the first entry" > "/dev/stderr"; exit 1 }
  }
  if (lnb == 0) {
    content = 0
    for (i = 1; i <= ln; i++) if (l[i] !~ /^[[:space:]]*$/ && l[i] !~ /^[[:space:]]*#/) content = 1
    if (content) { print "live patch is not a top-level array of entries" > "/dev/stderr"; exit 1 }
  }
  for (i = 1; i <= ln; i++) {
    # Only root-level rows and direct children of a top-level insert count as
    # live ids: an id nested deep in a row config (customTools and friends)
    # must not mask a shipped top-level row with the same id.
    if (l[i] ~ /^- id:[[:space:]]*[^[:space:]]+/ || l[i] ~ /^    - id:[[:space:]]*[^[:space:]]+/) live_id[trimid(l[i])] = 1
    if (l[i] ~ /^    [A-Za-z0-9_@.\/-]+:/) { k = l[i]; sub(/^[[:space:]]+/, "", k); sub(/:.*/, "", k); live_section[k] = 1 }
  }
  # Operator opt-out: a top-of-file `# dsh-ignore: id1, id2` comment pins those
  # shipped row ids out of the merge, like a live `disabled: true` row.
  for (i = 1; i <= ln; i++) {
    if (l[i] ~ /^[[:space:]]*$/) continue
    if (l[i] !~ /^[[:space:]]*#/) break
    if (l[i] ~ /^[[:space:]]*#[[:space:]]*dsh-ignore:/) {
      ig = l[i]
      sub(/^[[:space:]]*#[[:space:]]*dsh-ignore:[[:space:]]*/, "", ig)
      n = split(ig, igv, ",")
      for (j = 1; j <= n; j++) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", igv[j]); if (igv[j] != "") ignore[igv[j]] = 1 }
    }
  }
  orch_start = 0; orch_end = 0
  for (b = 1; b <= lnb; b++) if (l[lb[b]] ~ /^- id:[[:space:]]*enpoi-orchestration[[:space:]]*$/) { orch_start = lb[b]; orch_end = lb[b + 1] - 1 }
  for (b = 1; b <= snb; b++) {
    first = s[sb[b]]
    if (first ~ /^- id:[[:space:]]*[^[:space:]]+/) {
      id = trimid(first)
      if (id in operator_row) { print "skipped operator-state row: " id > "/dev/stderr"; continue }
      if (id in ignore) { print "skipped operator opt-out row: " id > "/dev/stderr"; continue }
      if (id in live_id) continue
      if (id in shipped_seen) { print "duplicate shipped row id: " id > "/dev/stderr"; exit 1 }
      shipped_seen[id] = 1
      top_n++; top[++top_c] = ""
      e = blockend(sb[b], sb[b + 1] - 1)
      for (i = sb[b]; i <= e; i++) top[++top_c] = s[i]
      print "added row: " id > "/dev/stderr"
    } else if (first ~ /^- insert:[[:space:]]*$/) {
      nested_n = 0; any_present = 0; missing = 0
      delete nested
      for (i = sb[b] + 1; i < sb[b + 1]; i++) {
        if (s[i] ~ /^    - id:[[:space:]]*[^[:space:]]+/) {
          y = trimid(s[i]); nested_n++
          if (y in ignore) any_present = 1
          else if (y in live_id) any_present = 1
          else { missing = 1; nested[y] = 1 }
        }
      }
      if (nested_n == 0) { print "unrecognized shipped insert block (no nested row ids)" > "/dev/stderr"; exit 1 }
      for (y in nested) if (y in operator_row) { print "shipped insert carries operator-state row: " y > "/dev/stderr"; exit 1 }
      if (any_present && missing) { print "shipped insert block is only partially present in the live patch" > "/dev/stderr"; exit 1 }
      if (any_present) continue
      top_n++; top[++top_c] = ""
      e = blockend(sb[b], sb[b + 1] - 1)
      for (i = sb[b]; i <= e; i++) top[++top_c] = s[i]
      for (y in nested) print "added row: " y > "/dev/stderr"
    } else {
      print "unrecognized shipped top-level entry" > "/dev/stderr"; exit 1
    }
  }
  if (orch_start > 0 && ("enpoi-orchestration" in live_id)) {
    s_orch_start = 0; s_orch_end = 0
    for (b = 1; b <= snb; b++) if (s[sb[b]] ~ /^- id:[[:space:]]*enpoi-orchestration[[:space:]]*$/) { s_orch_start = sb[b]; s_orch_end = sb[b + 1] - 1 }
    if (s_orch_start > 0) {
      for (i = s_orch_start + 1; i < s_orch_end; i++) {
        if (s[i] ~ /^    [A-Za-z0-9_@.\/-]+:/) {
          k = s[i]; sub(/^[[:space:]]+/, "", k); sub(/:.*/, "", k)
          if (k in operator_section) continue
          if (k in live_section) continue
          if (k in section_seen) continue
          section_seen[k] = 1
          j = i + 1
          while (j < s_orch_end && s[j] !~ /^    [A-Za-z0-9_@.\/-]+:/ && s[j] !~ /^  [A-Za-z0-9_@.\/-]+:/) j++
          while (j > i + 1 && (s[j - 1] ~ /^[[:space:]]*$/ || s[j - 1] ~ /^[[:space:]]*#/)) j--
          sec_n++; sec[++sec_c] = ""
          for (m = i; m < j; m++) sec[++sec_c] = s[m]
          print "added section: " k > "/dev/stderr"
          i = j - 1
        }
      }
    }
  }
  if (top_n == 0 && sec_n == 0) exit 2
  for (i = 1; i <= ln; i++) {
    print l[i]
    if (orch_start > 0 && i == orch_end) for (m = 1; m <= sec_c; m++) print sec[m]
  }
  for (m = 1; m <= top_c; m++) print top[m]
  exit 0
}
' "$shipped" "$live" > "$tmp" 2> "$summary"
  rc=$?
  case "$rc" in
    0) :;;
    2)
      rm -f "$tmp"
      while IFS= read -r line; do log "profile patch merge: $line"; done < "$summary"
      rm -f "$summary"
      log "profile patch merge: live patch already carries every shipped row/section"
      return 0
      ;;
    *)
      rm -f "$tmp"
      warn "profile patch merge: $(head -n 1 "$summary" 2>/dev/null || printf 'cannot parse the documents'); live patch left untouched"
      rm -f "$summary"
      return 0
      ;;
  esac
  added_n="$(grep -c '^added ' "$summary" 2>/dev/null || true)"
  case "$added_n" in ''|*[!0-9]*) added_n=0;; esac
  ts="$(date +%Y%m%d-%H%M%S)"
  backup="$live.backup-$ts"
  [ -e "$backup" ] && backup="$backup-$$"
  if ! cp -p "$live" "$backup" 2>/dev/null; then
    rm -f "$tmp" "$summary"
    warn "profile patch merge: could not back up $live; live patch left untouched"
    return 0
  fi
  if ! mv "$tmp" "$live" 2>/dev/null; then
    rm -f "$tmp" "$summary"
    warn "profile patch merge: could not write $live; live patch left untouched (backup: $backup)"
    return 0
  fi
  while IFS= read -r line; do log "profile patch merge: $line"; done < "$summary"
  rm -f "$summary"
  substep_ok "Profile patch merge: $added_n shipped entr(y/ies) added to $(basename "$live") (backup: $backup)"
  return 0
}

# Union the shipped dependency keys into the live profile package.json.
# Shipped wins on a version conflict; user-only dependencies are kept; every
# other field of the live manifest is preserved. An unparseable live manifest
# aborts the update with the shipped keys listed instead of clobbering it.
merge_profile_package_json() { # shipped live
  local shipped="$1" live="$2" tmp="$2.merge-$$" out rc
  [ -f "$shipped" ] || { log "profile package.json merge: no shipped manifest at $shipped; skipping"; return 0; }
  [ -f "$live" ] || { log "profile package.json merge: no live manifest at $live; skipping"; return 0; }
  out="$("$NODE" -e '
const fs = require("fs")
const [shippedPath, livePath, outPath] = process.argv.slice(1)
const maps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
let shipped
try { shipped = JSON.parse(fs.readFileSync(shippedPath, "utf8")) } catch (error) {
  console.error(`cannot parse shipped manifest ${shippedPath}: ${error.message}`)
  process.exit(3)
}
let live
try { live = JSON.parse(fs.readFileSync(livePath, "utf8")) } catch (error) {
  const keys = []
  for (const map of maps) for (const key of Object.keys(shipped[map] ?? {})) keys.push(`${map}:${key}`)
  console.error(`cannot parse live manifest ${livePath}: ${error.message}; shipped dependency keys that would apply: ${keys.sort().join(" ") || "none"}`)
  process.exit(4)
}
const merged = { ...live }
const added = [], updated = [], kept = []
for (const map of maps) {
  const shippedMap = shipped[map] ?? {}
  const liveMap = live[map] ?? {}
  const mergedMap = { ...liveMap }
  for (const [key, value] of Object.entries(shippedMap)) {
    if (!(key in liveMap)) added.push(`${map}:${key}`)
    else if (liveMap[key] !== value) updated.push(`${map}:${key}`)
    mergedMap[key] = value
  }
  for (const key of Object.keys(liveMap)) if (!(key in shippedMap)) kept.push(`${map}:${key}`)
  merged[map] = mergedMap
}
const text = `${JSON.stringify(merged, null, 2)}\n`
if (text === fs.readFileSync(livePath, "utf8")) process.exit(2)
fs.writeFileSync(outPath, text)
const detail = [
  added.length > 0 ? `added ${added.join(", ")}` : "",
  updated.length > 0 ? `updated ${updated.join(", ")}` : "",
  kept.length > 0 ? `kept user-only ${kept.join(", ")}` : "",
].filter(Boolean).join("; ")
console.log(`${added.length} added, ${updated.length} updated, ${kept.length} user-only kept${detail ? ` (${detail})` : ""}`)
' "$shipped" "$live" "$tmp" 2>&1)"
  rc=$?
  case "$rc" in
    0)
      if mv "$tmp" "$live" 2>/dev/null; then
        log "profile package.json merge: $out"
      else
        rm -f "$tmp"
        warn "profile package.json merge: could not write $live; manifest left untouched"
      fi
      ;;
    2)
      rm -f "$tmp"
      log "profile package.json merge: live manifest already carries every shipped dependency"
      ;;
    3)
      rm -f "$tmp"
      die "profile package.json merge: $out"
      ;;
    4)
      rm -f "$tmp"
      die "profile package.json merge: refusing to overwrite $live — $out. Fix the JSON (or move the file aside) and re-run the update."
      ;;
    *)
      rm -f "$tmp"
      warn "profile package.json merge skipped (exit $rc): $out"
      ;;
  esac
  return 0
}

# Profile refresh merges: additive patch rows + dependency union. The staged
# shipped tree is the source when present (set by prepare_profile), otherwise
# the bundled profile of the tree being installed. Never runs on a fresh seed.
refresh_profile_merges() {
  [ -n "${PROFILE_DIR:-}" ] && [ -d "$PROFILE_DIR" ] || return 0
  local shipped="${PROFILE_SHIPPED_DIR:-}"
  if [ -z "$shipped" ] || [ ! -d "$shipped" ]; then shipped="${HARNESS:-}/profile/$PROFILE"; fi
  if [ -z "$shipped" ] || [ ! -d "$shipped" ]; then
    log "profile merge: no shipped profile tree resolved; nothing to merge"
    return 0
  fi
  if [ "$NO_PROFILE_MERGE" = 1 ]; then
    log "profile merge: skipped (--no-profile-merge)"
  else
    merge_profile_patch "$shipped/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
  fi
  merge_profile_package_json "$shipped/package.json" "$PROFILE_DIR/package.json"
  return 0
}

# The canonical companion profile repo is branch-per-channel like the harness:
# a channel install must clone the profile's channel branch, not the repo's
# default HEAD (which tracks the newest template). An explicit --profile-ref /
# DSH_PROFILE_REF always wins; a ref this script derived is re-derived when the
# channel changes, and a state file without the derived flag keeps a recorded
# non-empty ref as an operator pin.
apply_profile_ref_default() { # from_state(0|1) -> sets PROFILE_REF from $CHANNEL
  local from_state="${1:-0}"
  [ "$PROFILE_REF_EXPLICIT" = 1 ] && return 0
  [ "$PROFILE_SOURCE" = "$DEFAULT_PROFILE_SOURCE" ] || return 0
  [ -n "$CHANNEL" ] || return 0
  if [ "$from_state" = 1 ]; then
    [ -z "$PROFILE_REF" ] || [ "$PROFILE_REF_DERIVED" = 1 ] || return 0
  fi
  PROFILE_REF="$CHANNEL"
  PROFILE_REF_DERIVED=1
  return 0
}

# ── Fleet pairings generation ───────────────────────────────────────────────
# `dsh update` owns device pairings: when the profile ships a fleet registry
# (profile/<name>/fleet.yaml) and its generator, render $DSH_HOME/pairings.yaml
# for this device so no file is hand-edited. The generator validates with the
# peer package's own parser, keeps the previous document on any rejection, and
# honors a first-line `# dsh-managed: false` opt-out. Fail-soft: a missing
# generator or registry, an unknown local device, or a generator error leaves
# the existing document untouched and never fails install/update.
generate_peer_pairings() {
  resolve_home
  local script="$PROFILE_DIR/scripts/generate-pairings.mjs"
  if [ ! -f "$script" ]; then
    log "pairings: no fleet generator in $PROFILE_DIR; $DSH_HOME/pairings.yaml left untouched"
    return 0
  fi
  if [ -z "$NODE" ]; then
    warn "pairings: no Node.js available; $DSH_HOME/pairings.yaml left untouched"
    return 0
  fi
  if run_limited 120 env "DSH_HARNESS=${HARNESS:-}" "$NODE" "$script"; then
    log "pairings: fleet generator finished for $PROFILE_DIR (details above)"
  else
    warn "pairings: generator exited non-zero; $DSH_HOME/pairings.yaml left untouched"
  fi
  return 0
}

prepare_profile() {
  # An installer-recorded bundled source names the previous versioned tree.
  # The tree actually being installed/seeded ($HARNESS) carries the current
  # bundle, and the old tree is pruned after the next update, so rebase only
  # paths under $PREFIX/harness; a local or external source still wins.
  if [ -n "$PROFILE_SOURCE" ] && [ -n "${HARNESS:-}" ] && [ -d "$HARNESS/profile/$PROFILE" ]; then
    case "$PROFILE_SOURCE" in
      "$PREFIX"/harness/*) PROFILE_SOURCE="$HARNESS/profile/$PROFILE";;
    esac
  fi
  if [ -z "$PROFILE_SOURCE" ] || [ "$PROFILE_SOURCE" = "$DEFAULT_PROFILE_SOURCE" ]; then
    if [ -n "${HARNESS:-}" ] && [ -d "$HARNESS/profile/$PROFILE" ]; then
      PROFILE_SOURCE="$HARNESS/profile/$PROFILE"
    fi
  fi
  [ -n "$PROFILE_SOURCE" ] || { log "profile source: none; shipped template only"; generate_peer_pairings; return 0; }
  local kind rc=0 mode=seed fresh=0
  kind="$(profile_source_kind "$PROFILE_SOURCE")"
  log "profile source: $PROFILE_SOURCE ($kind${PROFILE_REF:+ ref $PROFILE_REF})"
  # A home without this profile's manifest would otherwise be seeded from the
  # shipped upstream template by initProfile; that is a silent behavior change,
  # so a failed fetch is fatal until the profile exists once.
  if [ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]; then fresh=1; fi
  PROFILE_STAGE="$PREFIX/harness/.profile-staging-$$"
  rm -rf "$PROFILE_STAGE"
  mkdir -p "$PROFILE_STAGE" || return 1
  resolve_profile_token
  stage_profile_source "$PROFILE_SOURCE" "$kind" "$PROFILE_STAGE" || rc=1
  if [ "$rc" = 0 ] && [ ! -f "$PROFILE_STAGE/package.json" ]; then
    flatten_stage "$PROFILE_STAGE"
    [ -f "$PROFILE_STAGE/package.json" ] || rc=1
  fi
  if [ "$rc" != 0 ]; then
    rm -rf "$PROFILE_STAGE"; PROFILE_STAGE=""
    if [ "$PROFILE_SOURCE_REQUIRED" = 1 ]; then die "profile fetch failed: $PROFILE_SOURCE"; fi
    if [ "$fresh" = 1 ]; then
      die "profile fetch failed: $PROFILE_SOURCE and $DSH_HOME/profiles/$PROFILE does not exist yet; refusing to fall back to the shipped upstream template. Fix the source, or pass --profile-source '' to seed it deliberately."
    fi
    warn "profile fetch failed: $PROFILE_SOURCE (continuing with the shipped template)"
    generate_peer_pairings
    return 0
  fi
  resolve_home
  [ -f "$PROFILE_DIR/package.json" ] && mode=refresh
  log "profile seed: $PROFILE_DIR ($mode)"
  if ! copy_profile_tree "$PROFILE_STAGE" "$PROFILE_DIR" "$mode"; then
    warn "profile seed did not complete for $PROFILE_DIR"
  fi
  seed_profile_home "$PROFILE_STAGE"
  if [ "$mode" = refresh ]; then
    # The just-staged shipped tree is the merge source: additive patch rows and
    # the dependency union run before profile deps install and plugin build.
    PROFILE_SHIPPED_DIR="$PROFILE_STAGE"
    refresh_profile_merges
    PROFILE_SHIPPED_DIR=""
  fi
  rm -rf "$PROFILE_STAGE"; PROFILE_STAGE=""
  generate_peer_pairings
  return 0
}

profile_install() {
  resolve_home
  [ -n "$PROFILE_SOURCE" ] || return 0
  [ -f "$PROFILE_DIR/package.json" ] || { log "profile deps: no package.json at $PROFILE_DIR; skipping"; return 0; }
  if [ -z "$PNPM" ] && [ -x "$PREFIX/bin/pnpm" ]; then PNPM="$PREFIX/bin/pnpm"; fi
  [ -n "$PNPM" ] || { warn "profile deps: no pnpm available"; return 1; }
  export HARNESS_ROOT="${HARNESS:-$PREFIX/harness/current}"
  if ! run_logged "Installing Enpoi profile dependencies" "$PROFILE_INSTALL_TIMEOUT" "$PROFILE_DIR" "$PNPM" install; then
    warn "profile pnpm install failed"
    return 1
  fi
  return 0
}

# ── Shim, state, rc ─────────────────────────────────────────────────────────
write_shim() {
  local tmp
  mkdir -p "$BIN_DIR" || return 1
  tmp="$BIN_DIR/.dsh.tmp.$$"
  sed -e "s|__PREFIX__|$PREFIX|g" -e "s|__NODE__|$NODE|g" <<'SHIM' > "$tmp" || return 1
#!/usr/bin/env bash
# dsh — launcher shim generated by the dsh installer. Re-run the installer to
# regenerate. `dsh update`, `dsh repair`, `dsh uninstall` and `dsh doctor`
# delegate to the delegated engine (single implementation): the updater for the
# first three, the doctor diagnostics for the last.
set -euo pipefail
PREFIX="__PREFIX__"
CURRENT="$PREFIX/harness/current"
if [ ! -d "$CURRENT" ]; then
  echo "dsh: no installed harness under $PREFIX/harness; re-run the installer" >&2
  exit 1
fi
case "${1:-}" in
  update|repair|uninstall|doctor|clean)
    sub="$1"; shift
    exec "$CURRENT/scripts/update.sh" "$sub" --prefix "$PREFIX" "$@"
    ;;
esac
NODE=""
if [ -x "$PREFIX/runtime/node/current/bin/node" ]; then
  NODE="$PREFIX/runtime/node/current/bin/node"
elif [ -x "__NODE__" ]; then
  NODE="__NODE__"
else
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ]; then
  echo "dsh: no usable Node.js found; re-run the installer" >&2
  exit 1
fi
exec "$NODE" "$CURRENT/apps/cli/lib/bin.js" "$@"
SHIM
  chmod +x "$tmp" || return 1
  mv "$tmp" "$BIN_DIR/dsh" || return 1
  ln -sfn dsh "$BIN_DIR/ds" 2>/dev/null || true
  return 0
}

# Seed the caller-side peer CLI (`ds peer`) beside the shim. The script ships
# inside the harness tree (scripts/dsh-peer.mjs); re-seeding it on every install
# and update lets CLI fixes reach an existing install through `dsh update`.
# Fail-soft: a missing source or a write error warns at the call site and never
# aborts the install/update.
write_peer_cli() {
  local src="${HARNESS:-$PREFIX/harness/current}/scripts/dsh-peer.mjs" tmp
  [ -f "$src" ] || { log "peer CLI: no script at $src"; return 1; }
  mkdir -p "$BIN_DIR" || return 1
  tmp="$BIN_DIR/.dsh-peer.tmp.$$"
  cp "$src" "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  chmod 755 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$BIN_DIR/dsh-peer" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 0
}

write_state() {
  local file="$PREFIX/harness/install-state.json" tmp now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$file.tmp.$$"
  {
    printf '{\n'
    printf '  "prefix": "%s",\n' "$(json_escape "$PREFIX")"
    printf '  "version": "%s",\n' "$(json_escape "$VERSION")"
    printf '  "harnessDir": "%s",\n' "$(json_escape "${TREE_DIR_NAME:-$VERSION}")"
    printf '  "commit": "%s",\n' "$(json_escape "$BUILD_COMMIT")"
    printf '  "channel": "%s",\n' "$(json_escape "$CHANNEL")"
    printf '  "ref": "%s",\n' "$(json_escape "${REF:-$CHANNEL}")"
    printf '  "source": "%s",\n' "$(json_escape "$SOURCE")"
    printf '  "sourceUrl": "%s",\n' "$(json_escape "$SOURCE_URL")"
    printf '  "profile": "%s",\n' "$(json_escape "$PROFILE")"
    printf '  "profileSource": "%s",\n' "$(json_escape "$PROFILE_SOURCE")"
    printf '  "profileRef": "%s",\n' "$(json_escape "$PROFILE_REF")"
    printf '  "profileRefDerived": %s,\n' "$([ "$PROFILE_REF_DERIVED" = 1 ] && printf 'true' || printf 'false')"
    printf '  "binDir": "%s",\n' "$(json_escape "$BIN_DIR")"
    printf '  "dshHome": "%s",\n' "$(json_escape "$DSH_HOME")"
    printf '  "node": "%s",\n' "$(json_escape "$NODE")"
    printf '  "nodeOrigin": "%s",\n' "$(json_escape "$NODE_ORIGIN")"
    printf '  "pnpm": "%s",\n' "$(json_escape "$PNPM")"
    # null, never "": a blank string is not a unit name, and consumers that
    # fall back with ?? must see "absent".
    if [ -n "$SERVICE_UNIT" ]; then
      printf '  "serviceUnit": "%s",\n' "$(json_escape "$SERVICE_UNIT")"
    else
      printf '  "serviceUnit": null,\n'
    fi
    # Sticky --no-service: a later update must not install a background unit
    # the operator declined at install time.
    printf '  "serviceInstall": %s,\n' "$([ "$SERVICE_INSTALL" = 1 ] && printf 'true' || printf 'false')"
    printf '  "updatedAt": "%s"\n' "$now"
    printf '}\n'
  } > "$tmp" || return 1
  mv "$tmp" "$file" || return 1
  return 0
}

write_rc() {
  local marker="# dsh installer" path_line="export PATH=\"$BIN_DIR:\$PATH\""
  local login_shell bash_login zsh_dir fish_dir fish_line f

  # The login shell decides which startup file the shell actually reads.
  # $SHELL comes from the account database and may be a full path; a case
  # pattern (not a literal comparison) maps it to a bare name. When it is unset
  # only the POSIX login profile can be targeted.
  case "${SHELL:-}" in
    */bash|bash) login_shell=bash;;
    */zsh|zsh) login_shell=zsh;;
    */fish|fish) login_shell=fish;;
    *) login_shell="${SHELL:-}"; login_shell="${login_shell##*/}";;
  esac

  # Append the marker block once per file. Creates a file (and its directory)
  # the shell reads but that does not exist yet; never rewrites content.
  #
  # The marker check and append are not atomic: two installers running against
  # one HOME can both miss the marker and append the block twice. The duplicate
  # is benign (the PATH line is idempotent and the marker stops every later
  # run), and a lock file would risk a stale lock the installer never clears,
  # so single-operator concurrent runs are accepted rather than serialized.
  append_block() { # file line
    local file="$1" line="$2"
    if [ -f "$file" ] && grep -qF "$marker" "$file"; then return 0; fi
    mkdir -p "$(dirname "$file")" 2>/dev/null || { warn "could not create $(dirname "$file")"; return 0; }
    printf '\n%s\n%s\n' "$marker" "$line" >> "$file" || { warn "could not update $file"; return 0; }
    log "added $BIN_DIR to $file"
  }
  append_block_if_present() { # file line
    [ -f "$1" ] || return 0
    append_block "$1" "$2"
  }

  # bash login order: ~/.bash_profile, ~/.bash_login, ~/.profile. With no
  # bash-specific file, ~/.profile also serves sh/dash/ksh logins.
  bash_login=""
  for f in "$HOME/.bash_profile" "$HOME/.bash_login"; do
    if [ -f "$f" ]; then bash_login="$f"; break; fi
  done
  if [ -n "$bash_login" ] && [ "$login_shell" = bash ]; then
    append_block "$bash_login" "$path_line"
  else
    append_block "$HOME/.profile" "$path_line"
  fi

  # bash interactive non-login reads ~/.bashrc; create it only for a bash
  # login shell so other shells do not grow an rc they never read.
  if [ -f "$HOME/.bashrc" ] || [ "$login_shell" = bash ]; then
    append_block "$HOME/.bashrc" "$path_line"
  fi

  # zsh interactive reads ~/.zshrc, login reads ~/.zprofile. macOS defaults to
  # zsh since Catalina; an existing rc means the user runs zsh even when the
  # login shell is something else. ZDOTDIR overrides the rc directory.
  zsh_dir="${ZDOTDIR:-$HOME}"
  if [ "$OS" = darwin ] || [ "$login_shell" = zsh ] || [ -f "$zsh_dir/.zshrc" ] || [ -f "$zsh_dir/.zprofile" ]; then
    append_block "$zsh_dir/.zshrc" "$path_line"
  fi
  append_block_if_present "$zsh_dir/.zprofile" "$path_line"

  # fish reads $XDG_CONFIG_HOME/fish/config.fish (default ~/.config/fish).
  # Write it when fish is the login shell, or when fish is installed and a
  # config directory exists; an installed-but-unused fish grows no rc.
  fish_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
  fish_line="fish_add_path \"$BIN_DIR\""
  if [ "$login_shell" = fish ] || { command -v fish >/dev/null 2>&1 && [ -d "$fish_dir" ]; }; then
    append_block "$fish_dir/config.fish" "$fish_line"
  fi
}

# ── Service, backfill, migrations ───────────────────────────────────────────
detect_service_unit() {
  local u line
  if command -v systemctl >/dev/null 2>&1 && systemctl --user list-units >/dev/null 2>&1; then
    for u in $(systemctl --user list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}'); do
      if systemctl --user cat "$u" 2>/dev/null | grep -qF -- "$PREFIX"; then printf '%s' "$u"; return 0; fi
    done
  fi
  if [ "$OS" = darwin ]; then
    for line in "$HOME/Library/LaunchAgents"/*.plist; do
      [ -f "$line" ] || continue
      if grep -qF -- "$PREFIX" "$line"; then basename "$line" .plist; return 0; fi
    done
  fi
  return 0
}

restart_service() {
  if [ -z "$SERVICE_UNIT" ]; then
    log "service: no unit recorded for this install; not restarting anything"
    return 0
  fi
  log "service: restarting $SERVICE_UNIT"
  case "$OS" in
    linux) systemctl --user restart "$SERVICE_UNIT" || warn "service restart failed";;
    darwin)
      # kickstart fails with `Could not find service ... in domain` when the
      # unit file exists but was never loaded (or was unloaded since install).
      # Load it first with the same probe/remedy the repair path uses; a
      # headless/SSH-only Mac has no GUI domain, so the unit simply loads at
      # the next desktop login and the update is not a failure.
      local uid plist
      uid="$(id -u)"
      plist="$HOME/Library/LaunchAgents/$SERVICE_UNIT.plist"
      if launchctl print "gui/$uid/$SERVICE_UNIT" >/dev/null 2>&1; then
        launchctl kickstart -k "gui/$uid/$SERVICE_UNIT" || warn "service restart failed"
      elif [ ! -f "$plist" ]; then
        warn "service restart failed: launchd unit $SERVICE_UNIT is not loaded and $plist does not exist; run 'dsh service install'"
      elif launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1; then
        log "service: $SERVICE_UNIT was not loaded; bootstrapped it"
      elif launchctl print "gui/$uid" >/dev/null 2>&1; then
        warn "service restart failed: launchctl bootstrap gui/$uid '$plist'"
      else
        log "service: no GUI login session for gui/$uid (headless or SSH-only Mac); $SERVICE_UNIT starts at the next desktop login"
      fi
      ;;
  esac
  return 0
}

service_unit_present() { # unit -> 0 when the service manager knows the unit
  local u="$1"
  [ -n "$u" ] || return 1
  case "$OS" in
    linux)
      command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$u" >/dev/null 2>&1
      ;;
    darwin)
      [ -f "$HOME/Library/LaunchAgents/$u.plist" ]
      ;;
    *) return 1;;
  esac
}

ensure_service() {
  if [ "${SERVICE_INSTALL:-1}" != 1 ] || [ "${DSH_NO_SERVICE:-0}" = 1 ]; then
    log "service: install disabled; leaving any existing unit untouched"
    return 0
  fi
  if [ -n "$SERVICE_UNIT" ] && service_unit_present "$SERVICE_UNIT"; then
    log "service: unit $SERVICE_UNIT already installed"
    return 0
  fi
  local cli="$HARNESS/apps/cli/lib/bin.js" out
  [ -f "$cli" ] || { warn "service: no CLI at $cli; skipping service install"; return 0; }
  log "service: installing the background web service (login persistence)"
  if out="$("$NODE" "$cli" service install 2>&1)"; then
    SERVICE_UNIT="$(json_field "$PREFIX/harness/install-state.json" serviceUnit)"
    # The CLI reports its own start outcome ("installed and started" vs
    # "installed" for --no-start); repeat "and started" only when the CLI did,
    # so an exit 0 that did not start the unit is never reported as started.
    case "$out" in
      *"installed and started"*) substep_ok "Background service installed and started${SERVICE_UNIT:+ ($SERVICE_UNIT)}";;
      *) substep_ok "Background service installed${SERVICE_UNIT:+ ($SERVICE_UNIT)} (not started; run 'dsh service start')";;
    esac
  else
    warn "service: install failed ($(printf '%s' "$out" | tail -n 1)); run 'dsh service install' manually"
  fi
  return 0
}

# ── Update self-restart safety ──────────────────────────────────────────────
# A `dsh update` started from inside the managed unit (a session shell or a
# model tool call) is a child of the unit's main process. Restarting the unit
# directly stops that whole process tree: the update dies mid-flight and the
# service stays down. The helpers below detect that position from observable
# process state and delegate the restart instead:
#   - a turn is in flight (a model shell call carries DSH_SESSION_ID but not
#     DSH_PTY_SESSION_ID): write the after-turn marker consumed by the web
#     watcher (apps/cli/src/restart-after-turn.ts), which restarts between
#     turns and never inside one;
#   - otherwise: restart from a detached process outside the unit's tree;
# and either way a detached verifier confirms the unit comes back, starting or
# bootstrapping it when it does not, and records the outcome in the install log.

darwin_service_pid() { # unit -> live pid, empty when loaded-but-idle or unknown
  command -v launchctl >/dev/null 2>&1 || return 0
  launchctl print "gui/$(id -u)/$1" 2>/dev/null \
    | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*$/\1/p' | head -n 1
}

service_main_pid() { # unit -> main process, empty when the unit is down/unknown
  local pid
  case "$OS" in
    linux)
      command -v systemctl >/dev/null 2>&1 || return 0
      pid="$(systemctl --user show -p MainPID --value "$1" 2>/dev/null || true)"
      case "$pid" in ''|0|*[!0-9]*) return 0;; esac
      # PID 1 is init, never a user unit's main process; refusing it also keeps
      # a bogus answer from matching every ancestor chain.
      [ "$pid" -gt 1 ] || return 0
      printf '%s' "$pid"
      ;;
    darwin)
      darwin_service_pid "$1"
      ;;
  esac
}

pid_is_ancestor() { # ancestor descendant -> 0 when ancestor is on the parent chain
  local want="$1" cur="$2" parent hops=0
  [ -n "$want" ] && [ -n "$cur" ] || return 1
  while [ "$hops" -lt 256 ]; do
    [ "$cur" = "$want" ] && return 0
    case "$cur" in ''|*[!0-9]*) return 1;; esac
    [ "$cur" -gt 1 ] || return 1
    parent="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')"
    case "$parent" in ''|*[!0-9]*) return 1;; esac
    [ "$parent" = "$cur" ] && return 1
    cur="$parent"
    hops=$((hops + 1))
  done
  return 1
}

running_under_service() { # 0 when this process tree is inside the managed unit
  [ -n "${SERVICE_UNIT:-}" ] || return 1
  local pid
  pid="$(service_main_pid "$SERVICE_UNIT")"
  [ -n "$pid" ] || return 1
  pid_is_ancestor "$pid" "$$"
}

unit_is_active() { # unit -> 0 when the service manager reports it running
  case "$OS" in
    linux)
      command -v systemctl >/dev/null 2>&1 || return 1
      systemctl --user is-active --quiet "$1" 2>/dev/null
      ;;
    darwin)
      [ -n "$(darwin_service_pid "$1")" ]
      ;;
    *) return 1;;
  esac
}

service_generation() { # unit -> token that changes on each activation
  case "$OS" in
    linux)
      command -v systemctl >/dev/null 2>&1 || return 0
      systemctl --user show -p ActiveEnterTimestampMonotonic --value "$1" 2>/dev/null | tr -d ' \n'
      ;;
    darwin)
      darwin_service_pid "$1"
      ;;
  esac
}

guard_kick_service() { # unit -> 0 when the restart request was issued
  case "$OS" in
    linux)
      systemctl --user restart "$1" >/dev/null 2>&1
      ;;
    darwin)
      local uid plist
      uid="$(id -u)"
      plist="$HOME/Library/LaunchAgents/$1.plist"
      if launchctl print "gui/$uid/$1" >/dev/null 2>&1; then
        launchctl kickstart -k "gui/$uid/$1" >/dev/null 2>&1
      elif [ -f "$plist" ]; then
        launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1
      else
        return 1
      fi
      ;;
    *) return 1;;
  esac
}

start_or_bootstrap_service() { # 0 when the unit was started or loaded
  case "$OS" in
    linux)
      systemctl --user reset-failed "$SERVICE_UNIT" >/dev/null 2>&1 || true
      systemctl --user start "$SERVICE_UNIT" >/dev/null 2>&1
      ;;
    darwin)
      local uid plist
      uid="$(id -u)"
      plist="$HOME/Library/LaunchAgents/$SERVICE_UNIT.plist"
      if launchctl print "gui/$uid/$SERVICE_UNIT" >/dev/null 2>&1; then
        launchctl kickstart "gui/$uid/$SERVICE_UNIT" >/dev/null 2>&1
      elif [ -f "$plist" ]; then
        launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1
      else
        return 1
      fi
      ;;
    *) return 1;;
  esac
}

# Write the after-turn marker consumed by the web watcher. The JSON matches
# `RestartMarker` (apps/cli/src/restart-after-turn.ts); the scripts spec parses
# this file with the module's own `parseRestartMarker`, so schema drift fails a
# test. Atomic temp+rename, so a re-run overwrites instead of duplicating.
write_restart_marker() { # session
  local session="$1" dir="$DSH_HOME/state" path="$DSH_HOME/state/restart-after-turn.json" tmp
  local now_ms max_wait deadline_ms marker_profile
  # The watcher belongs to the profile the unit booted; a tool call carries
  # that profile in DSH_PROFILE (packages/shell/shell-env), which outranks the
  # recorded install profile when they differ.
  marker_profile="${DSH_PROFILE:-$PROFILE}"
  now_ms="$(( $(date +%s) * 1000 ))"
  max_wait="${DSH_RESTART_MAX_WAIT:-600}"
  case "$max_wait" in ''|*[!0-9]*) max_wait=600;; esac
  max_wait="$((max_wait * 1000))"
  deadline_ms="$(( now_ms + max_wait ))"
  mkdir -p "$dir" 2>/dev/null || { warn "service: could not create $dir for the restart marker"; return 1; }
  tmp="$path.$$.tmp"
  if ! cat > "$tmp" <<EOF
{
  "version": 1,
  "sessionId": "$(json_escape "$session")",
  "unit": "$(json_escape "$SERVICE_UNIT")",
  "profile": "$(json_escape "$marker_profile")",
  "requestedAt": $now_ms,
  "deadline": $deadline_ms,
  "requestedBy": "pid $$ (dsh update)",
  "waitAll": true
}
EOF
  then
    rm -f "$tmp" 2>/dev/null
    warn "service: could not write the restart marker $path"
    return 1
  fi
  if mv -f "$tmp" "$path" 2>/dev/null; then
    log "service: after-turn restart of $SERVICE_UNIT scheduled for session $session ($path)"
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  warn "service: could not write the restart marker $path"
  return 1
}

# The detached restart plan `fireDetachedRestart` uses
# (apps/cli/src/restart-after-turn.ts): Linux prefers a transient user unit, so
# the restart outlives this process's cgroup; macOS kickstarts the label.
fire_detached_restart() { # unit
  case "$OS" in
    linux)
      if command -v systemd-run >/dev/null 2>&1; then
        systemd-run --user --collect --quiet -- systemctl --user restart "$1" >/dev/null 2>&1 && return 0
      fi
      if command -v setsid >/dev/null 2>&1; then
        setsid systemctl --user restart "$1" >/dev/null 2>&1 < /dev/null &
      else
        systemctl --user restart "$1" >/dev/null 2>&1 < /dev/null &
      fi
      return 0
      ;;
    darwin)
      command -v launchctl >/dev/null 2>&1 || return 1
      launchctl kickstart -k "gui/$(id -u)/$1" >/dev/null 2>&1
      ;;
    *) return 1;;
  esac
}

# Stage and start the detached verifier: a copy of this script running the
# internal --service-guard mode outside the target unit's process tree. Linux
# uses a transient user unit; macOS a transient submitted job; plain
# setsid/nohup is the best-effort fallback when neither is available.
spawn_service_guard() { # baseline expect_restart timeout
  local baseline="$1" expect="$2" timeout="$3" script token label guard_log guard_src guard_tmp
  local guard_args
  script="$PREFIX/logs/dsh-service-guard.sh"
  mkdir -p "$PREFIX/logs" 2>/dev/null || script=""
  guard_src=""
  if [ -n "$script" ]; then
    if [ -f "$SELF" ]; then
      guard_src="$SELF"
    elif [ -f "$HARNESS/scripts/install.sh" ]; then
      guard_src="$HARNESS/scripts/install.sh"
    fi
  fi
  if [ -n "$guard_src" ]; then
    # Stage beside the target and rename over it: a verifier from an earlier
    # update may still be reading the old file, and cp truncation in place
    # would corrupt its running script.
    guard_tmp="$script.$$.tmp"
    if cp "$guard_src" "$guard_tmp" 2>/dev/null && mv -f "$guard_tmp" "$script" 2>/dev/null; then
      chmod +x "$script" 2>/dev/null || true
    else
      rm -f "$guard_tmp" 2>/dev/null
      script=""
    fi
  else
    script=""
  fi
  if [ -z "$script" ]; then
    log "service-guard: could not stage a verifier under $PREFIX/logs; skipping post-restart verification"
    return 0
  fi
  guard_log="$PREFIX/logs/service-guard.log"
  guard_args=(--service-guard --service-unit "$SERVICE_UNIT" --prefix "$PREFIX" --dsh-home "$DSH_HOME" --guard-timeout "$timeout" --guard-home "${HOME:-}")
  [ -n "$baseline" ] && guard_args+=(--guard-baseline "$baseline")
  [ "$expect" = 1 ] && guard_args+=(--guard-expect-restart)
  token="$(digest_hex "$PREFIX" | cut -c1-12)"
  case "$OS" in
    linux)
      if command -v systemd-run >/dev/null 2>&1; then
        if systemctl --user is-active --quiet "dsh-update-guard-$token" 2>/dev/null; then
          log "service-guard: verifier dsh-update-guard-$token is already running; reusing it"
          return 0
        fi
        if systemd-run --user --collect --quiet --unit "dsh-update-guard-$token" \
          --setenv=XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
          -- env -u DSH_INSTALL_LIB_ONLY bash "$script" "${guard_args[@]}" >>"$guard_log" 2>&1; then
          log "service-guard: detached verifier scheduled (dsh-update-guard-$token)"
          return 0
        fi
        log "service-guard: systemd-run could not schedule the verifier; falling back to a plain detached process"
      fi
      if command -v setsid >/dev/null 2>&1; then
        setsid nohup env -u DSH_INSTALL_LIB_ONLY bash "$script" "${guard_args[@]}" >>"$guard_log" 2>&1 < /dev/null &
      else
        nohup env -u DSH_INSTALL_LIB_ONLY bash "$script" "${guard_args[@]}" >>"$guard_log" 2>&1 < /dev/null &
      fi
      log "service-guard: detached verifier started without systemd-run (best effort)"
      ;;
    darwin)
      label="com.dsh.update-guard.$token.$$"
      if command -v launchctl >/dev/null 2>&1; then
        if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
          log "service-guard: verifier $label is already loaded; reusing it"
          return 0
        fi
        if launchctl submit -l "$label" -o "$guard_log" -e "$guard_log" -- /usr/bin/env -u DSH_INSTALL_LIB_ONLY /bin/bash "$script" "${guard_args[@]}" >/dev/null 2>&1; then
          log "service-guard: detached verifier submitted ($label)"
          return 0
        fi
        log "service-guard: launchctl submit could not schedule the verifier; falling back to a plain detached process"
      fi
      nohup env -u DSH_INSTALL_LIB_ONLY bash "$script" "${guard_args[@]}" >>"$guard_log" 2>&1 < /dev/null &
      log "service-guard: detached verifier started without launchd (best effort)"
      ;;
  esac
  return 0
}

# The delegated restart. Called only when this process is inside the managed
# unit, after every durable update step has completed and the result has been
# reported: the caller may be killed by the restart, so nothing may follow that
# the update still needs. Idempotent per call: the marker write is an atomic
# overwrite, and a verifier already running for this delegation is reused
# (Linux keys it to the prefix, macOS to the update process).
delegate_service_restart() {
  local baseline session
  if [ -z "$SERVICE_UNIT" ]; then
    log "service: no unit recorded for this install; nothing to delegate"
    return 0
  fi
  baseline="$(service_generation "$SERVICE_UNIT")"
  # A model shell call runs with a scrubbed environment that carries
  # DSH_SESSION_ID but never DSH_PTY_SESSION_ID, which only a persistent
  # terminal gets (packages/terminal/terminal-bash/src/index.ts); such a call
  # is inside a turn by definition, so only the after-turn marker is safe.
  session="${DSH_SESSION_ID:-}"
  if [ -n "$session" ] && [ -z "${DSH_PTY_SESSION_ID:-}" ]; then
    spawn_service_guard "$baseline" 0 900
    if write_restart_marker "$session"; then
      say "  ${C_CYAN}ℹ${C_RESET} Service restart scheduled for between turns (session ${session}): $SERVICE_UNIT"
    else
      warn "service: restart was NOT scheduled; run 'dsh restart --after-turn --session ${session}' after this turn"
    fi
    return 0
  fi
  spawn_service_guard "$baseline" 1 180
  if fire_detached_restart "$SERVICE_UNIT"; then
    say "  ${C_CYAN}ℹ${C_RESET} Service restart delegated to a detached process: $SERVICE_UNIT"
  else
    warn "service: no detached restart mechanism on this platform; run 'dsh service restart' after this command"
  fi
  return 0
}

# The detached verifier (internal --service-guard mode): wait for the delegated
# restart to activate the unit, then confirm the unit is up; when it is down,
# start or bootstrap it and record the outcome in the install log.
do_service_guard() {
  local unit="$SERVICE_UNIT" timeout interval recover kick baseline generation
  local start now saw_outage=0
  timeout="${GUARD_TIMEOUT:-${DSH_SERVICE_GUARD_TIMEOUT:-180}}"
  case "$timeout" in ''|*[!0-9]*) timeout=180;; esac
  [ "$timeout" -ge 1 ] || timeout=1
  interval="${DSH_SERVICE_GUARD_INTERVAL:-2}"
  case "$interval" in ''|*[!0-9]*) interval=2;; esac
  [ "$interval" -ge 1 ] || interval=1
  recover="${DSH_SERVICE_GUARD_RECOVER:-60}"
  case "$recover" in ''|*[!0-9]*) recover=60;; esac
  kick="${DSH_SERVICE_GUARD_KICK:-20}"
  case "$kick" in ''|*[!0-9]*) kick=20;; esac
  baseline="${GUARD_BASELINE:-}"
  log "service-guard: watching $unit for up to ${timeout}s (baseline ${baseline:-unknown}, expect-restart $GUARD_EXPECT_RESTART)"
  start="$(date +%s)"
  while :; do
    if unit_is_active "$unit"; then
      generation="$(service_generation "$unit")"
      if [ -z "$baseline" ] || [ "$saw_outage" = 1 ] \
        || { [ -n "$generation" ] && [ "$generation" != "$baseline" ]; }; then
        log "service-guard: $unit verified active after the delegated restart"
        return 0
      fi
      if [ "$GUARD_EXPECT_RESTART" = 1 ]; then
        now="$(date +%s)"
        if [ $((now - start)) -ge "$kick" ]; then
          log "service-guard: no restart observed within ${kick}s; restarting $unit from the detached verifier"
          if guard_kick_service "$unit"; then
            baseline=""
            saw_outage=1
            start="$(date +%s)"
            continue
          fi
          log "service-guard: restart from the detached verifier failed; still watching $unit"
        fi
      fi
    else
      saw_outage=1
    fi
    now="$(date +%s)"
    [ $((now - start)) -ge "$timeout" ] && break
    sleep "$interval"
  done
  if unit_is_active "$unit"; then
    log "service-guard: $unit is active but no delegated restart was observed within ${timeout}s; nothing to recover (a scheduled after-turn restart may still be pending)"
    return 0
  fi
  log "service-guard: $unit is not active after ${timeout}s; starting it from the detached verifier"
  if start_or_bootstrap_service; then
    local recover_start recover_now
    recover_start="$(date +%s)"
    while :; do
      if unit_is_active "$unit"; then
        log "service-guard: recovered $unit after the failed restart"
        return 0
      fi
      recover_now="$(date +%s)"
      [ $((recover_now - recover_start)) -ge "$recover" ] && break
      sleep "$interval"
    done
    log "service-guard: ERROR: $unit did not become active after the start/bootstrap attempt; run 'dsh doctor' for diagnostics"
    return 1
  fi
  log "service-guard: ERROR: could not start or bootstrap $unit; run 'dsh service install'"
  return 1
}

# ── Tailnet peer exposure ───────────────────────────────────────────────────
# Reaching the loopback web service from another tailnet machine needs two
# pieces, both wired here when the host has a Tailscale IPv4:
#   1. the web service must trust the tailnet authority (`--trusted-host`), or
#      the Host/Origin fence answers 403;
#   2. a forwarder must carry <tailnet-ip>:3080 to 127.0.0.1:3080 — a systemd
#      user unit around socat on Linux, `tailscale serve --bg --tcp=3080` on
#      macOS where socat is not assumed.
# The steps are idempotent and fail-soft: a unit file not generated by this
# installer (or by `dsh service install`) is never rewritten, only reported
# with the exact line to add. DSH_NO_TAILNET=1 / --no-tailnet opts out.
TAILNET_UNIT="dsh-tailnet.service"
TAILNET_UNIT_MARKER="# Generated by dsh installer (tailnet peer exposure); re-run install/update to refresh."
SYSTEMD_GENERATED_MARKER="# Generated by dsh service install"
PLIST_GENERATED_MARKER="<!-- Generated by dsh service install -->"
TAILNET_TRUST_STATUS=""
TAILNET_FORWARD_STATUS=""
TAILNET_SERVE_STATUS=""

tailnet_opt_out() {
  [ "${NO_TAILNET:-0}" = 1 ] || [ "${DSH_NO_TAILNET:-0}" = 1 ]
}

tailnet_ipv4_from_lines() { # candidate addresses on stdin -> first 100.64.0.0/10
  sed -e 's/[[:space:]].*//' -e 's#/.*##' | grep -E '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' | head -n 1
}

tailnet_ipv4() { # -> the host's first tailnet IPv4, empty when none
  local ip=""
  if [ -n "${DSH_TAILNET_IP:-}" ]; then
    ip="$(printf '%s\n' "${DSH_TAILNET_IP}" | tailnet_ipv4_from_lines)"
    if [ -n "$ip" ]; then printf '%s' "$ip"; return 0; fi
  fi
  if command -v tailscale >/dev/null 2>&1; then
    ip="$(tailscale ip -4 2>/dev/null | tailnet_ipv4_from_lines)"
  fi
  if [ -z "$ip" ]; then
    case "$OS" in
      linux)
        if command -v ip >/dev/null 2>&1; then
          ip="$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | tailnet_ipv4_from_lines)"
        fi
        if [ -z "$ip" ] && command -v ifconfig >/dev/null 2>&1; then
          ip="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | tailnet_ipv4_from_lines)"
        fi
        ;;
      darwin)
        if command -v ifconfig >/dev/null 2>&1; then
          ip="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | tailnet_ipv4_from_lines)"
        fi
        ;;
    esac
  fi
  printf '%s' "$ip"
}

patch_systemd_trusted_hosts() { # path ip host -> 0 changed, 2 already, 1 no usable ExecStart
  local path="$1" ip="$2" host="$3" tmp
  tmp="${path}.dsh-tailnet.$$"
  if ! awk -v ip="$ip" -v host="$host" '
      BEGIN { ipflag = "--trusted-host " ip ":3080"; hostflag = "--trusted-host " host ":3080"; done = 0 }
      /^ExecStart=/ && done == 0 {
        if ($0 ~ /\\[ \t]*$/) exit 1
        line = $0
        if (index(line, ipflag) == 0) line = line " " ipflag
        if (index(line, hostflag) == 0) line = line " " hostflag
        print line
        done = 1
        next
      }
      { print }
      END { if (done == 0) exit 1 }
    ' "$path" > "$tmp"; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  if cmp -s "$tmp" "$path"; then
    rm -f "$tmp" 2>/dev/null
    return 2
  fi
  if mv "$tmp" "$path"; then return 0; fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

patch_plist_trusted_hosts() { # path ip host -> 0 changed, 2 already, 1 no ProgramArguments
  local path="$1" ip="$2" host="$3" tmp
  tmp="${path}.dsh-tailnet.$$"
  if ! awk -v ip="$ip" -v host="$host" '
      BEGIN { ipv = ip ":3080"; hostv = host ":3080"; seenip = 0; seenhost = 0; done = 0 }
      {
        if (index($0, "<string>" ipv "</string>") > 0) seenip = 1
        if (index($0, "<string>" hostv "</string>") > 0) seenhost = 1
        if (done == 0 && index($0, "</array>") > 0) {
          if (seenip == 0) { print "    <string>--trusted-host</string>"; print "    <string>" ipv "</string>" }
          if (seenhost == 0) { print "    <string>--trusted-host</string>"; print "    <string>" hostv "</string>" }
          done = 1
        }
        print
      }
      END { if (done == 0) exit 1 }
    ' "$path" > "$tmp"; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  if cmp -s "$tmp" "$path"; then
    rm -f "$tmp" 2>/dev/null
    return 2
  fi
  if mv "$tmp" "$path"; then return 0; fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

render_tailnet_unit() { # ip socat-bin web-unit
  local ip="$1" socat_bin="$2" web_unit="$3"
  cat <<EOF
$TAILNET_UNIT_MARKER
[Unit]
Description=Enpoi Harness tailnet forwarder ($ip:3080 -> 127.0.0.1:3080)
After=$web_unit network-online.target tailscaled.service
Requires=$web_unit

[Service]
Type=simple
ExecStart=$socat_bin TCP-LISTEN:3080,bind=$ip,fork,reuseaddr TCP:127.0.0.1:3080
Restart=on-failure
RestartSec=3s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
}

uninstall_tailnet_forwarder() { # remove only the installer-generated forwarder
  local tfile="$HOME/.config/systemd/user/$TAILNET_UNIT"
  [ "$OS" = linux ] || return 0
  [ -f "$tfile" ] || return 0
  grep -qF -- "$TAILNET_UNIT_MARKER" "$tfile" 2>/dev/null || return 0
  if [ "$DRY_RUN" = 1 ]; then
    say "  would stop and remove tailnet forwarder: $TAILNET_UNIT"
    return 0
  fi
  systemctl --user stop "$TAILNET_UNIT" >/dev/null 2>&1 || true
  systemctl --user disable "$TAILNET_UNIT" >/dev/null 2>&1 || true
  rm -f -- "$tfile" && log "removed tailnet forwarder $tfile"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  return 0
}

ensure_tailnet_forwarder_systemd() { # ip web-unit
  local ip="$1" web_unit="$2" path="$HOME/.config/systemd/user/$TAILNET_UNIT" socat_bin content changed=0
  if ! command -v socat >/dev/null 2>&1; then
    TAILNET_FORWARD_STATUS="skipped (socat not installed)"
    warn "tailnet: socat is not installed; skipping the $TAILNET_UNIT forwarder. Install it (Debian/Ubuntu: sudo apt install socat; Fedora: sudo dnf install socat; Arch: sudo pacman -S socat) and re-run. Manual: socat TCP-LISTEN:3080,bind=$ip,fork,reuseaddr TCP:127.0.0.1:3080"
    return 0
  fi
  socat_bin="$(command -v socat)"
  content="$(render_tailnet_unit "$ip" "$socat_bin" "$web_unit")"
  if [ -f "$path" ]; then
    if ! grep -qF -- "$TAILNET_UNIT_MARKER" "$path" 2>/dev/null; then
      if grep -qF -- "bind=$ip" "$path" 2>/dev/null && grep -qF -- "TCP-LISTEN:3080" "$path" 2>/dev/null; then
        TAILNET_FORWARD_STATUS="operator-managed, already forwards $ip:3080"
        substep_info "tailnet: operator-managed $path already forwards $ip:3080; leaving it untouched"
      else
        TAILNET_FORWARD_STATUS="operator-managed, manual forwarder needed"
        warn "tailnet: $path exists but was not generated by the installer; leaving it untouched. Manual: socat TCP-LISTEN:3080,bind=$ip,fork,reuseaddr TCP:127.0.0.1:3080"
      fi
      return 0
    fi
    if [ "$(cat "$path")" = "$content" ]; then
      TAILNET_FORWARD_STATUS="already current ($TAILNET_UNIT)"
      log "tailnet: $TAILNET_UNIT already current"
    else
      printf '%s\n' "$content" > "$path" || { TAILNET_FORWARD_STATUS="write failed"; warn "tailnet: could not write $path; the forwarder was not updated"; return 0; }
      changed=1
      TAILNET_FORWARD_STATUS="updated ($TAILNET_UNIT)"
    fi
  else
    mkdir -p "$(dirname "$path")" 2>/dev/null || true
    printf '%s\n' "$content" > "$path" || { TAILNET_FORWARD_STATUS="write failed"; warn "tailnet: could not write $path; the forwarder was not installed"; return 0; }
    changed=1
    TAILNET_FORWARD_STATUS="installed ($TAILNET_UNIT)"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user enable "$TAILNET_UNIT" >/dev/null 2>&1 || warn "tailnet: could not enable $TAILNET_UNIT; it will not start at login"
    if [ "$changed" = 1 ]; then
      systemctl --user restart "$TAILNET_UNIT" >/dev/null 2>&1 || warn "tailnet: could not start $TAILNET_UNIT; check: systemctl --user status $TAILNET_UNIT"
    elif ! systemctl --user is-active --quiet "$TAILNET_UNIT" 2>/dev/null; then
      systemctl --user start "$TAILNET_UNIT" >/dev/null 2>&1 || warn "tailnet: could not start $TAILNET_UNIT; check: systemctl --user status $TAILNET_UNIT"
    fi
  fi
  return 0
}

ensure_tailnet_linux() { # ip host
  local ip="$1" host="$2" unit="${SERVICE_UNIT:-}" path rc flags
  flags="--trusted-host $ip:3080 --trusted-host $host:3080"
  if [ -z "$unit" ] || ! service_unit_present "$unit"; then
    TAILNET_TRUST_STATUS="no managed web unit (add $flags manually)"
    TAILNET_FORWARD_STATUS="skipped (no web unit to forward to)"
    substep_info "tailnet: no installed web unit to expose; skipping the forwarder"
    return 0
  fi
  path="$HOME/.config/systemd/user/$unit"
  if [ ! -f "$path" ]; then
    TAILNET_TRUST_STATUS="no $unit file (add $flags manually)"
    warn "tailnet: $path not found; add to the web command: $flags"
  elif grep -qF -- "$SYSTEMD_GENERATED_MARKER" "$path" 2>/dev/null; then
    patch_systemd_trusted_hosts "$path" "$ip" "$host"
    rc=$?
    case "$rc" in
      0)
        TAILNET_TRUST_STATUS="added to $unit"
        substep_ok "tailnet: added trusted hosts to $unit"
        if command -v systemctl >/dev/null 2>&1; then
          systemctl --user daemon-reload >/dev/null 2>&1 || true
          systemctl --user restart "$unit" >/dev/null 2>&1 || warn "tailnet: could not restart $unit; it picks the trusted hosts up on the next restart"
        fi
        ;;
      2)
        TAILNET_TRUST_STATUS="already present in $unit"
        substep_info "tailnet: $unit already trusts $ip and $host"
        ;;
      *)
        TAILNET_TRUST_STATUS="manual flags needed in $unit"
        warn "tailnet: no single-line ExecStart in $path; add manually: $flags"
        ;;
    esac
  else
    if grep -qF -- "--trusted-host $ip:3080" "$path" 2>/dev/null && grep -qF -- "--trusted-host $host:3080" "$path" 2>/dev/null; then
      TAILNET_TRUST_STATUS="operator-managed $unit, already configured"
      substep_info "tailnet: operator-managed $unit already trusts $ip and $host"
    else
      TAILNET_TRUST_STATUS="operator-managed $unit, manual flags needed"
      warn "tailnet: $path is operator-managed; not rewriting it. Add to its web command: $flags"
    fi
  fi
  ensure_tailnet_forwarder_systemd "$ip" "$unit"
  return 0
}

ensure_tailnet_darwin() { # ip host
  local ip="$1" host="$2" unit="${SERVICE_UNIT:-}" plist rc flags
  flags="--trusted-host $ip:3080 --trusted-host $host:3080"
  if command -v tailscale >/dev/null 2>&1; then
    if tailscale serve --bg --tcp=3080 tcp://127.0.0.1:3080 >/dev/null 2>&1; then
      TAILNET_SERVE_STATUS="configured"
      substep_ok "tailnet: tailscale serve --bg --tcp=3080 tcp://127.0.0.1:3080"
    else
      TAILNET_SERVE_STATUS="manual run needed"
      warn "tailnet: could not configure the TCP forwarder; run: tailscale serve --bg --tcp=3080 tcp://127.0.0.1:3080"
    fi
  else
    TAILNET_SERVE_STATUS="skipped (tailscale CLI not installed)"
    warn "tailnet: the tailscale CLI is not installed; no forwarder for $ip:3080. Install Tailscale, run 'tailscale up', then: tailscale serve --bg --tcp=3080 tcp://127.0.0.1:3080"
  fi
  if [ -z "$unit" ] || ! service_unit_present "$unit"; then
    TAILNET_TRUST_STATUS="no launchd agent (add $flags manually)"
    warn "tailnet: no launchd agent to patch; start dsh web with: $flags"
    return 0
  fi
  plist="$HOME/Library/LaunchAgents/$unit.plist"
  if [ ! -f "$plist" ]; then
    TAILNET_TRUST_STATUS="no $unit plist (add $flags manually)"
    warn "tailnet: $plist not found; add to the web command: $flags"
  elif grep -qF -- "$PLIST_GENERATED_MARKER" "$plist" 2>/dev/null; then
    patch_plist_trusted_hosts "$plist" "$ip" "$host"
    rc=$?
    case "$rc" in
      0)
        TAILNET_TRUST_STATUS="added to $unit"
        substep_ok "tailnet: added trusted hosts to $unit"
        if command -v launchctl >/dev/null 2>&1; then
          launchctl bootout "gui/$(id -u)/$unit" >/dev/null 2>&1 || true
          launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || warn "tailnet: wrote the trusted hosts into $plist; load it with: launchctl bootstrap gui/$(id -u) $plist"
        fi
        ;;
      2)
        TAILNET_TRUST_STATUS="already present in $unit"
        substep_info "tailnet: $unit already trusts $ip and $host"
        ;;
      *)
        TAILNET_TRUST_STATUS="manual flags needed in $unit"
        warn "tailnet: no ProgramArguments array in $plist; add manually: $flags"
        ;;
    esac
  else
    if grep -qF -- "<string>$ip:3080</string>" "$plist" 2>/dev/null && grep -qF -- "<string>$host:3080</string>" "$plist" 2>/dev/null; then
      TAILNET_TRUST_STATUS="operator-managed $unit, already configured"
      substep_info "tailnet: operator-managed $unit already trusts $ip and $host"
    else
      TAILNET_TRUST_STATUS="operator-managed $unit, manual flags needed"
      warn "tailnet: $plist is operator-managed; not rewriting it. Add to its web arguments: $flags"
    fi
  fi
  return 0
}

ensure_tailnet_exposure() {
  TAILNET_TRUST_STATUS=""
  TAILNET_FORWARD_STATUS=""
  TAILNET_SERVE_STATUS=""
  if tailnet_opt_out; then
    substep_info "tailnet: peer exposure skipped (DSH_NO_TAILNET=1 or --no-tailnet)"
    return 0
  fi
  if [ "${SERVICE_INSTALL:-1}" != 1 ] || [ "${DSH_NO_SERVICE:-0}" = 1 ]; then
    substep_info "tailnet: peer exposure skipped (service install disabled)"
    return 0
  fi
  local ip host
  ip="$(tailnet_ipv4)"
  if [ -z "$ip" ]; then
    substep_info "tailnet: no 100.64.0.0/10 interface; peer exposure not configured"
    return 0
  fi
  host="$(host_short_name)"
  case "$OS" in
    linux)
      ensure_tailnet_linux "$ip" "$host"
      say "  tailnet: $ip:3080 -> 127.0.0.1:3080 [trusted hosts: $TAILNET_TRUST_STATUS; forwarder: $TAILNET_FORWARD_STATUS]"
      ;;
    darwin)
      ensure_tailnet_darwin "$ip" "$host"
      say "  tailnet: $ip:3080 -> 127.0.0.1:3080 [trusted hosts: $TAILNET_TRUST_STATUS; tailscale serve: $TAILNET_SERVE_STATUS]"
      ;;
    *) :;;
  esac
  return 0
}

find_backfill() {
  local c
  for c in "$HARNESS/scripts/dsh-projections-backfill.mjs" "$PROFILE_DIR/scripts/dsh-projections-backfill.mjs" "$HOME/.local/bin/dsh-projections-backfill.mjs"; do
    if [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 0
}

wait_for_web() { # bounded wait for the local web instance; 0 = it answered
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null --connect-timeout 2 --max-time 3 "http://127.0.0.1:${DSH_WEB_PORT:-3080}/" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

run_backfill() {
  local b
  b="$(find_backfill)"
  if [ -z "$b" ]; then
    BACKFILL="skipped (not present)"
    log "projection backfill: not present; skipping"
    return 0
  fi
  # The backfill reads through the web API. The service was just (re)started,
  # so give it a bounded moment before reading; an immediate read reports a
  # failure that is only startup latency.
  if [ -n "$SERVICE_UNIT" ]; then
    wait_for_web || log "projection backfill: web did not answer within 20s; trying anyway"
  fi
  BACKFILL="ran status"
  log "projection backfill: $b status"
  run_limited 300 "$NODE" "$b" status >/dev/null 2>&1 || warn "projection backfill status failed (continuing)"
  if [ -n "$SERVICE_UNIT" ]; then
    BACKFILL="ran status+run"
    run_limited 1800 "$NODE" "$b" run >/dev/null 2>&1 || warn "projection backfill run failed (continuing)"
  fi
  return 0
}

backup_user_files() { # dir
  local b="$1" f rel d
  for f in "$DSH_HOME/settings.yaml" "$DSH_HOME/cordis.patch.yml" "$DSH_HOME/sync-local.yaml" \
           "$DSH_HOME/heavy-server-overlay.json" "$DSH_HOME/pairings.yaml" \
           "$PROFILE_DIR/settings.yaml" "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_DIR/package.json" \
           "$PROFILE_DIR/pnpm-lock.yaml"; do
    [ -f "$f" ] || continue
    rel="${f#/}"
    mkdir -p "$b/root/$(dirname "$rel")" 2>/dev/null || continue
    cp -p "$f" "$b/root/$rel" 2>/dev/null || true
  done
  # Whole directories of operator state: per-device patch files and the
  # harness-owned key-pool state written under $DSH_HOME/pools.
  for d in "$PROFILE_DIR/device-patches" "$DSH_HOME/pools"; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      rel="${f#/}"
      mkdir -p "$b/root/$(dirname "$rel")" 2>/dev/null || continue
      cp -p "$f" "$b/root/$rel" 2>/dev/null || true
    done < <(find "$d" -type f 2>/dev/null)
  done
  return 0
}

# Restore from the pristine pre-update snapshot taken before any profile merge
# or migration ran. Files the update pipeline rewrites (the patch merge, the
# dependency union, pnpm's lock, migrations) have mtimes newer than the snapshot
# and would trip an mtime guard, so they are always restored; for every other
# file a live copy whose content differs from the snapshot is an operator edit
# made during the update and is kept. A missing or byte-identical copy is
# restored (recreated) from the snapshot.
restore_user_files() { # dir
  local b="$1" f rel live failed=0 total=0 skipped=0
  [ -d "$b/root" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    total=$((total + 1))
    rel="${f#"$b"/root/}"
    live="/$rel"
    case "$live" in
      "${DSH_HOME:-}/settings.yaml"|"${PROFILE_DIR:-}/settings.yaml"|"${PROFILE_DIR:-}/cordis.patch.yml"|"${PROFILE_DIR:-}/package.json"|"${PROFILE_DIR:-}/pnpm-lock.yaml") : ;;
      *)
        if [ -f "$live" ]; then
          if cmp -s "$f" "$live"; then continue; fi
          log "rollback: keeping $live (content differs from the backup; treating it as an operator edit)"
          skipped=$((skipped + 1))
          continue
        fi
        ;;
    esac
    if ! mkdir -p "$(dirname "$live")"; then
      printf '%s: ERROR: cannot create %s while restoring %s\n' "$SCRIPT_NAME" "$(dirname "$live")" "$live" >&2
      failed=$((failed + 1))
      continue
    fi
    if cp -p "$f" "$live"; then
      log "restored $live"
    else
      printf '%s: ERROR: could not restore %s from %s\n' "$SCRIPT_NAME" "$live" "$f" >&2
      failed=$((failed + 1))
    fi
  done <<EOF
$(find "$b/root" -type f 2>/dev/null)
EOF
  if [ "$skipped" -gt 0 ]; then
    warn "rollback: kept $skipped file(s) whose content differs from the backup (see the log for paths)"
  fi
  if [ "$failed" -gt 0 ]; then
    printf '%s: ERROR: rollback restore is INCOMPLETE: %s of %s backed-up file(s) were not restored; the active config may mix old and new files. Restore them manually from %s/root/ (paths there mirror /).\n' \
      "$SCRIPT_NAME" "$failed" "$total" "$b" >&2
    return 1
  fi
  return 0
}

# A failure before the `current` switch must not leave the live profile mutated
# by the profile merge, the dependency union, pnpm, or migrations: restore the
# pristine early backup before exiting. Clearing the marker disarms the EXIT
# trap's catch-all so a die() path restores exactly once.
restore_pre_switch() { # backup [label]
  local b="$1" label="${2:-the update}"
  [ -n "$b" ] && [ -d "$b/root" ] || return 0
  log "$label failed before the switch; restoring user files from $b"
  restore_user_files "$b" || warn "pre-switch restore from $b did not complete; restore the remaining files from $b/root/ manually"
  PRE_SWITCH_RESTORE=""
  return 0
}

write_diagnostics() { # status [detail]
  local dir="$DSH_HOME/diagnostics" status="$1" detail="${2:-}"
  mkdir -p "$dir" 2>/dev/null || return 0
  if [ -n "$detail" ]; then
    printf '{"ts":"%s","action":"update","from":"%s","to":"%s","status":"%s","detail":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "$PREV_VERSION")" "$(json_escape "$VERSION")" "$(json_escape "$status")" "$(json_escape "$detail")" \
      >> "$dir/update.jsonl" 2>/dev/null || true
  else
    printf '{"ts":"%s","action":"update","from":"%s","to":"%s","status":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "$PREV_VERSION")" "$(json_escape "$VERSION")" "$(json_escape "$status")" \
      >> "$dir/update.jsonl" 2>/dev/null || true
  fi
  return 0
}

run_migrations() {
  seed_home || return 1
  profile_install || return 1
  run_profile_plugin_build || return 1
  local engine="$PROFILE_DIR/scripts/dsh-sync-merge.mjs" m rc
  if [ -n "$MERGE_BASELINE" ] && [ -f "$engine" ]; then
    log "config merge: three-way merge against $MERGE_BASELINE (backups under $PROFILE_DIR/.backup-*)"
    local ts backup_dir patch out tmp
    ts="$(date +%Y%m%d-%H%M%S)"
    backup_dir="$PROFILE_DIR/.backup-$ts"
    mkdir -p "$backup_dir" 2>/dev/null || true
    patch="$PROFILE_DIR/device-patches/$(host_short_name).yaml"
    [ -f "$patch" ] || patch="$DSH_HOME/sync-local.yaml"
    out="$PROFILE_DIR/settings.yaml"
    if [ -f "$out" ]; then cp -p "$out" "$backup_dir/settings.yaml" 2>/dev/null || true; fi
    tmp="$out.merge-$$.tmp"
    run_limited 300 "$NODE" "$engine" merge "$MERGE_BASELINE" "$patch" "$DSH_HOME/sync-local.yaml" "$tmp" >&2
    rc=$?
    if [ "$rc" -ne 0 ] || [ ! -f "$tmp" ]; then
      rm -f "$tmp"
      warn "config merge exited $rc; keeping the user's files (never fail closed)"
    else
      # Dry-run diff before the write: show what the merge would change, then
      # apply it. The engine keeps user-touched values per its own three-way rules.
      if [ -f "$out" ]; then
        if diff -u "$out" "$tmp" > "$backup_dir/merge.diff" 2>/dev/null; then
          log "config merge: dry-run diff is empty; nothing to apply"
        else
          log "config merge: dry-run diff written to $backup_dir/merge.diff; applying"
        fi
      fi
      mv "$tmp" "$out" || warn "config merge: could not replace $out"
    fi
  else
    log "config merge: layered defaults seeded from shipped templates; no --merge-baseline given (user files untouched)"
  fi
  for m in "$HARNESS"/scripts/migrations/*.mjs; do
    [ -f "$m" ] || continue
    log "migration: $m"
    if ! DSH_HOME="$DSH_HOME" run_limited 300 "$NODE" "$m" >&2; then
      warn "migration $m failed (never fail closed; continuing)"
      MIGRATION_FAILURES="${MIGRATION_FAILURES:+$MIGRATION_FAILURES, }$(basename "$m")"
    fi
  done
  if [ -n "$MIGRATION_FAILURES" ]; then
    warn "migrations completed with failure(s): $MIGRATION_FAILURES (fail-open; the update continues)"
    write_diagnostics migrated-partial "$MIGRATION_FAILURES"
  else
    write_diagnostics migrated
  fi
  return 0
}

# ── Self-check ──────────────────────────────────────────────────────────────
selfcheck() {
  local ok=0 v rc
  CHECK_VERSION=0; CHECK_HELP=0; CHECK_SMOKE=0; CHECK_AUDIT="skipped"
  v="$(run_limited 60 "$NODE" "$HARNESS/apps/cli/lib/bin.js" --version 2>/dev/null)" || { warn "self-check: --version failed"; ok=1; }
  if [ -n "$v" ]; then CHECK_VERSION=1; else warn "self-check: empty version"; ok=1; fi
  if run_limited 60 "$NODE" "$HARNESS/apps/cli/lib/bin.js" --help >/dev/null 2>&1; then CHECK_HELP=1; else warn "self-check: --help failed"; ok=1; fi
  if run_limited 300 "$NODE" "$HARNESS/apps/cli/lib/bin.js" --profile "$PROFILE" --dump-default-config >/dev/null 2>&1; then
    CHECK_SMOKE=1
  else
    warn "self-check: smoke (--dump-default-config) failed"; ok=1
  fi
  local audit="$HARNESS/scripts/error-audit.mjs"
  if [ -f "$audit" ] && [ -d "$DSH_HOME/sessions" ] && [ -n "$(ls -A "$DSH_HOME/sessions" 2>/dev/null)" ]; then
    run_limited 300 "$NODE" "$audit" --json-only > "$PREFIX/harness/.last-audit.json" 2>/dev/null
    rc=$?
    case "$rc" in
      0) CHECK_AUDIT="pass";;
      2) CHECK_AUDIT="skip (no input)";;
      *) CHECK_AUDIT="warn (exit $rc)";;
    esac
  else
    CHECK_AUDIT="skipped (no corpus)"
  fi
  AUDIT_RESULT="$CHECK_AUDIT"
  if [ "${DSH_UPDATE_SELFTEST_FAIL:-0}" = 1 ]; then
    warn "self-check: DSH_UPDATE_SELFTEST_FAIL is set; forcing failure (test hook)"
    ok=1
  fi
  [ "$ok" = 0 ]
}

# ── JSON / summary output ───────────────────────────────────────────────────
emit_json() { # action ok
  [ "$JSON_OUT" = 1 ] || return 0
  printf '{"ok": %s, "action": "%s", "dryRun": %s, "prefix": "%s", "version": "%s", "previousVersion": "%s", "channel": "%s", "source": "%s", "sourceUrl": "%s", "harnessDir": "%s", "currentLink": "%s", "node": "%s", "nodeOrigin": "%s", "pnpm": "%s", "dshHome": "%s", "profile": "%s", "profileSource": "%s", "profileRef": "%s", "serviceUnit": "%s", "backfill": "%s", "rolledBack": %s, "checks": {"version": %s, "help": %s, "smoke": %s, "audit": "%s"}}\n' \
    "$2" "$1" "$DRY_RUN" "$(json_escape "$PREFIX")" "$(json_escape "$VERSION")" "$(json_escape "${PREV_VERSION:-}")" \
    "$(json_escape "$CHANNEL")" "$(json_escape "$SOURCE")" "$(json_escape "$SOURCE_URL")" "$(json_escape "$HARNESS")" \
    "$(json_escape "$PREFIX/harness/current")" "$(json_escape "$NODE")" "$(json_escape "$NODE_ORIGIN")" "$(json_escape "$PNPM")" \
    "$(json_escape "$DSH_HOME")" "$(json_escape "$PROFILE")" "$(json_escape "$PROFILE_SOURCE")" "$(json_escape "$PROFILE_REF")" \
    "$(json_escape "$SERVICE_UNIT")" "$(json_escape "$BACKFILL")" \
    "$ROLLED_BACK" "$CHECK_VERSION" "$CHECK_HELP" "$CHECK_SMOKE" "$(json_escape "$CHECK_AUDIT")"
  return 0
}

web_url() { # the URL the web surface serves after `dsh web` starts
  local port="${DSH_WEB_PORT:-3080}"
  case "$port" in ''|*[!0-9]*) port=3080;; esac
  # Port 0 asks the OS for a free port, so the bound URL is unknowable here.
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then port=3080; fi
  printf 'http://%s:%s' "${DSH_WEB_HOST:-127.0.0.1}" "$port"
}

maybe_open_browser() { # url — best-effort handoff; detached and never fatal
  local url="$1" opener=""
  if [ "$NO_OPEN" = 1 ] || [ "${DSH_NO_OPEN:-0}" = 1 ]; then
    log "browser: not opening the URL (--no-open)"
    return 0
  fi
  if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ] || [ "$JSON_OUT" = 1 ]; then
    log "browser: not opening the URL (non-interactive session)"
    return 0
  fi
  # An SSH session has no local display even when X11 forwarding sets DISPLAY;
  # opening remotely either fails or hangs, so never try.
  if [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_CLIENT:-}" ] || [ -n "${SSH_TTY:-}" ]; then
    log "browser: SSH session; open $url yourself"
    return 0
  fi
  case "$OS" in
    linux)
      if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
        log "browser: no display session; open $url yourself"
        return 0
      fi
      opener="$(command -v xdg-open 2>/dev/null || true)"
      ;;
    darwin)
      opener="$(command -v open 2>/dev/null || true)"
      ;;
    *) return 0;;
  esac
  if [ -z "$opener" ]; then
    say "  open:     no browser opener found; open ${url} yourself"
    return 0
  fi
  # Detached so a slow/hung opener can never block the installer; failure is
  # not fatal — the URL was already printed above.
  ( "$opener" "$url" >/dev/null 2>&1 & ) || true
  log "browser: asked $opener to open $url"
  return 0
}

web_ready() { # url -> 0 when the HTTP surface answers
  local code
  command -v curl >/dev/null 2>&1 || return 1
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null || true)"
  case "$code" in 2*|3*|401|403) return 0;; *) return 1;; esac
}

maybe_open_browser_when_up() { # url
  # A just-finished install has no server bound yet: opening now would land on
  # a dead page and `dsh web` would open a second one. Open only when the UI is
  # already serving (a refresh install over a running service); otherwise hand
  # off to `dsh web`, which opens the browser once the server is listening.
  if web_ready "$1"; then
    maybe_open_browser "$1"
    return 0
  fi
  log "browser: $1 is not serving yet; run 'dsh web' (it opens the browser once the service is up)"
  return 0
}

box_row() {
  local content="$1" color="${2:-}"
  local stripped
  stripped="$(printf '%s' "$content" | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g')"
  local len=${#stripped}
  local pad=$(( 59 - len ))
  [ "$pad" -ge 0 ] || pad=0
  local spaces=""
  if [ "$pad" -gt 0 ]; then
    spaces="$(printf '%*s' "$pad" '')"
  fi
  say "${color}${C_BOLD}│${C_RESET} ${content}${spaces} ${color}${C_BOLD}│${C_RESET}"
}

print_banner() {
  [ "$QUIET" = 1 ] && return 0
  [ "$JSON_OUT" = 1 ] && return 0
  say "${C_BOLD}╭─────────────────────────────────────────────────────────────╮${C_RESET}"
  box_row "  ${C_CYAN}${C_BOLD}Enpoi Harness${C_RESET} — System Installer" "${C_BOLD}"
  box_row "  ${C_DIM}Channel: ${CHANNEL:-stable}${C_RESET}" "${C_BOLD}"
  say "${C_BOLD}╰─────────────────────────────────────────────────────────────╯${C_RESET}"
}

print_summary() { # action
  local action="$1" url overlay
  url="$(web_url)"
  overlay="$PROFILE_DIR/device-patches/$(host_short_name)"
  say ""
  say "${C_GREEN}${C_BOLD}╭─────────────────────────────────────────────────────────────╮${C_RESET}"
  box_row "  ${C_BOLD}Enpoi Harness successfully ${action}ed!${C_RESET}" "${C_GREEN}"
  box_row "" "${C_GREEN}"
  box_row "  ${C_BOLD}Version:${C_RESET}   ${VERSION} (${CHANNEL:-stable})" "${C_GREEN}"
  box_row "  ${C_BOLD}Location:${C_RESET}  ${PREFIX}" "${C_GREEN}"
  box_row "  ${C_BOLD}Commands:${C_RESET}  dsh, ds" "${C_GREEN}"
  box_row "  ${C_BOLD}Duration:${C_RESET}  $(elapsed_human)" "${C_GREEN}"
  if [ -n "$MIGRATION_FAILURES" ]; then
    box_row "  ${C_YELLOW}Migrations:${C_RESET} $MIGRATION_FAILURES (failed-open; see log)" "${C_YELLOW}"
  fi
  if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ] && [ "$LOG_FILE" != "/dev/null" ]; then
    box_row "  ${C_BOLD}Log:${C_RESET}       ${LOG_FILE}" "${C_GREEN}"
  fi
  box_row "" "${C_GREEN}"
  box_row "  ${C_BOLD}Quick Start:${C_RESET}" "${C_GREEN}"
  box_row "    ${C_CYAN}dsh web${C_RESET}      Start the local web UI" "${C_GREEN}"
  box_row "    ${C_CYAN}dsh doctor${C_RESET}   Check system diagnostics" "${C_GREEN}"
  box_row "    ${C_CYAN}dsh update${C_RESET}   Update harness to latest version" "${C_GREEN}"
  say "${C_GREEN}${C_BOLD}╰─────────────────────────────────────────────────────────────╯${C_RESET}"
  say ""
  case ":$PATH:" in
    *":${BIN_DIR}:"*) :;;
    *) say "  ${C_YELLOW}!${C_RESET} ${C_BOLD}Note:${C_RESET} Add ${BIN_DIR} to your PATH (restart your shell, or source its startup file: ~/.profile, ~/.bashrc, ~/.zshrc, or fish config)";;
  esac
  say ""
}

# ── Dry-run plans ───────────────────────────────────────────────────────────
dry_run_plan() {
  local ref="${REF:-$CHANNEL}"
  say "dsh installer dry run (no writes)"
  say "  os/arch:   $OS/$ARCH"
  say "  prefix:    $PREFIX"
  say "  bin dir:   $BIN_DIR"
  say "  channel:   $CHANNEL (ref: $ref)"
  if [ -n "$SOURCE" ]; then say "  source:    $SOURCE"; else say "  source:    $DSH_GITHUB_URL/archive/$ref.tar.gz"; fi
  local p_source="$PROFILE_SOURCE"
  if [ -z "$p_source" ] || [ "$p_source" = "$DEFAULT_PROFILE_SOURCE" ]; then
    if [ -n "$SOURCE" ] && [ -d "$SOURCE/profile/$PROFILE" ]; then
      p_source="$SOURCE/profile/$PROFILE (bundled with harness)"
    elif [ -d "$PREFIX/harness/current/profile/$PROFILE" ]; then
      p_source="$PREFIX/harness/current/profile/$PROFILE (bundled with harness)"
    fi
  fi
  if [ -n "$p_source" ]; then say "  profile:   $PROFILE (source: $p_source${PROFILE_REF:+, ref: $PROFILE_REF})"; else say "  profile:   $PROFILE (shipped template)"; fi
  if detect_os_arch >/dev/null 2>&1; then :; fi
  if resolve_node 0 >/dev/null 2>&1; then
    say "  node:      $NODE ($NODE_ORIGIN)"
  else
    say "  node:      none >= ${DSH_MIN_NODE_MAJOR}.${DSH_MIN_NODE_MINOR} found; would fetch Node v${DSH_NODE_VERSION} into $PREFIX/runtime/node/$DSH_NODE_VERSION"
  fi
  if [ -d "$SOURCE" ]; then
    local v
    v="$("$NODE" -e 'process.stdout.write(String(require(process.argv[1]+"/package.json").version))' "$SOURCE" 2>/dev/null || true)"
    [ -n "$v" ] && say "  version:   $v"
  fi
  say "  steps:     verified prebuilt release (when one is published) or fetch"
  say "             -> pnpm install --frozen-lockfile -> pnpm run build"
  say "             -> fetch+seed profile (if a source is set) -> seed \$DSH_HOME (initProfile)"
  say "             -> profile deps (pnpm install) -> profile plugin build (if present)"
  say "             -> shim $BIN_DIR/dsh -> install-state.json"
  [ "$WRITE_RC" = 1 ] && say "  rc:        would add the PATH line to the detected shell's startup files (bash/zsh/fish)"
  [ "$UPDATE_MODE" = 1 ] && say "  update:    migrations -> switch current -> service (if unit) -> backfill (if present) -> self-check -> rollback on failure"
  if tailnet_opt_out; then
    say "  tailnet:   disabled (--no-tailnet / DSH_NO_TAILNET=1)"
  else
    local tailnet_hint
    tailnet_hint="$(tailnet_ipv4)"
    if [ -n "$tailnet_hint" ]; then
      say "  tailnet:   would expose $tailnet_hint:3080 -> 127.0.0.1:3080 (trusted-host flags + forwarder)"
    else
      say "  tailnet:   no 100.64.0.0/10 interface; peer exposure would be skipped"
    fi
  fi
}

# ── Install ─────────────────────────────────────────────────────────────────
do_install() {
  STEP_TOTAL=6
  detect_os_arch
  init_log_file
  print_banner

  step "Detecting platform & environment"
  sudo_trap
  substep_ok "Platform: $OS/$ARCH ($DISTRO_NAME)"
  substep_ok "Prefix: $PREFIX (zero sudo)"

  step "Preparing Node.js runtime & Corepack"
  resolve_node 1 || die "no usable Node.js >= ${DSH_MIN_NODE_MAJOR}.${DSH_MIN_NODE_MINOR} and the download failed"
  substep_ok "Node.js: $NODE ($NODE_ORIGIN)"
  setup_pnpm || die "could not enable pnpm through corepack"
  substep_ok "Corepack pnpm: $("$PNPM" --version 2>/dev/null || printf '?')"

  cleanup_stale_artifacts

  step "Fetching release archive (${CHANNEL:-stable})"
  prepare_source
  resolve_target_for_source
  if [ "${PREBUILT:-0}" = 1 ]; then
    substep_ok "Target version: $VERSION (prebuilt release)"
  else
    substep_ok "Target version: $VERSION${TARGET_COMMIT:+ (commit ${TARGET_COMMIT:0:7})}"
  fi

  # A complete tree found by prepare_source is already the target build; keep
  # its directory name instead of re-deriving one that may not exist.
  if [ -n "${REUSED_TREE_DIR:-}" ]; then
    TREE_DIR_NAME="$REUSED_TREE_DIR"
  else
    TREE_DIR_NAME="$VERSION"
  fi
  # A prebuilt release version is unique per build, so its directory is the
  # version itself; the short-SHA suffix only disambiguates source builds of
  # one base version on a moved channel.
  if [ -z "${REUSED_TREE_DIR:-}" ] && [ "${PREBUILT:-0}" != 1 ] && [ -n "$TARGET_COMMIT" ]; then
    local short
    short="$(printf '%s' "$TARGET_COMMIT" | cut -c1-7)"
    if [ -f "$PREFIX/harness/$VERSION/.dsh-install-complete" ] \
      && ! commit_same "$TARGET_COMMIT" "$(installed_tree_commit "$PREFIX/harness/$VERSION")"; then
      TREE_DIR_NAME="$VERSION-$short"
      log "rolling channel advanced: recorded $(installed_tree_commit "$PREFIX/harness/$VERSION") -> target $short; building into $TREE_DIR_NAME"
    elif [ ! -f "$PREFIX/harness/$VERSION/.dsh-install-complete" ] \
      && [ -f "$PREFIX/harness/$VERSION-$short/.dsh-install-complete" ] \
      && commit_same "$TARGET_COMMIT" "$(installed_tree_commit "$PREFIX/harness/$VERSION-$short")"; then
      TREE_DIR_NAME="$VERSION-$short"
    fi
  fi
  HARNESS="$PREFIX/harness/$TREE_DIR_NAME"

  step "Building core harness & dependencies"
  if [ -f "$HARNESS/.dsh-install-complete" ] && [ "$FORCE" != 1 ]; then
    substep_ok "Reusing existing build ($TREE_DIR_NAME)"
    # Keep the recorded build commit: a reused tree records no new one, and a
    # blank commit in install-state.json would lose the rolling no-op identity.
    BUILD_COMMIT="$(installed_tree_commit "$HARNESS")"
    [ -n "$BUILD_COMMIT" ] || resolve_build_commit
    if [ -n "$STAGED" ]; then rm -rf "$STAGED"; STAGED=""; fi
  else
    install_tree || die "install/build failed; no changes were made to \$DSH_HOME (tree: $HARNESS)"
  fi
  switch_current "$TREE_DIR_NAME" || die "could not point $PREFIX/harness/current at $TREE_DIR_NAME"

  step "Configuring Enpoi profile & plugins"
  prepare_profile
  seed_home
  profile_install || die "profile dependency install failed"
  run_profile_plugin_build || die "profile plugin build failed"

  step "Configuring CLI shims & shell environment"
  write_shim || die "could not write the dsh shim into $BIN_DIR"
  substep_ok "Installed launcher: $BIN_DIR/dsh, $BIN_DIR/ds"
  write_peer_cli || warn "could not seed the peer CLI into $BIN_DIR ('ds peer' unavailable until the next successful install/update)"
  if [ "$WRITE_RC" = 1 ]; then
    write_rc
  fi
  if [ -z "$SERVICE_UNIT" ]; then SERVICE_UNIT="$(detect_service_unit)"; fi
  write_state || warn "could not write $PREFIX/harness/install-state.json"

  if ! selfcheck; then
    warn "self-check failed for the freshly installed tree"
    emit_json install 0
    exit 1
  fi
  substep_ok "System self-check passed"

  ensure_service
  ensure_tailnet_exposure
  write_state || warn "could not record the service unit in install-state.json"
  print_summary install
  maybe_open_browser_when_up "$(web_url)"
  emit_json install 1
  return 0
}

# ── Update ──────────────────────────────────────────────────────────────────
# Restore from the pristine pre-update backup (the early snapshot taken before
# the profile merge and migrations ran); the late pre-switch backup is never
# passed here. Called only after the switch.
rollback() { # prev backup failed_version
  local prev="$1" backup="$2" failed="$3" restore_rc=0 in_session=0
  warn "rolling back to $prev"
  switch_current "$prev" || warn "could not repoint $PREFIX/harness/current"
  # The direct path restarted the unit onto the failed tree before the
  # self-check; restart it back so the live service runs the restored tree too.
  # A rollback running inside the managed unit must not restart it here: the
  # delegated restart at the end runs after the user-file restore and the
  # report, so the rollback can never be killed mid-flight.
  if running_under_service; then
    in_session=1
  else
    restart_service
  fi
  restore_user_files "$backup" || restore_rc=1
  # Never archive the tree being restored, and never rename a pre-existing
  # reused tree away: a failed pin-back to a known-good build must leave it
  # reusable.
  if [ -n "$failed" ] && [ "$failed" != "$prev" ] && [ -z "${REUSED_TREE_DIR:-}" ] && [ -d "$PREFIX/harness/$failed" ]; then
    mv "$PREFIX/harness/$failed" "$PREFIX/harness/$failed.failed-$(date +%Y%m%d-%H%M%S)" 2>/dev/null \
      || warn "could not archive the failed tree $PREFIX/harness/$failed"
  elif [ -n "${REUSED_TREE_DIR:-}" ] && [ "$failed" = "$REUSED_TREE_DIR" ]; then
    log "rollback: keeping $failed (pre-existing reused tree)"
  fi
  HARNESS="$PREFIX/harness/$prev"
  local prev_ok=1
  unset DSH_UPDATE_SELFTEST_FAIL
  if selfcheck >/dev/null 2>&1; then prev_ok=0; else warn "the previous tree also fails self-check; inspect $HARNESS"; fi
  ROLLED_BACK=1
  if [ "$restore_rc" != 0 ]; then
    write_diagnostics rolled-back-partial
    emit_json update 0
    say ""
    say "dsh update FAILED; rolled back to ${prev} (previous tree self-check: $([ "$prev_ok" = 0 ] && printf 'ok' || printf 'failed')), but the user-file restore did NOT complete."
    say "  active:  $PREFIX/harness/current -> $(readlink "$PREFIX/harness/current" 2>/dev/null || printf '?')"
    say "  failed:  $PREFIX/harness/$failed.failed-*"
    say "  backups: $backup — restore the remaining files manually from $backup/root/ (paths there mirror /)"
    if [ "$in_session" = 1 ]; then delegate_service_restart; fi
    return 1
  fi
  write_diagnostics rolled-back
  emit_json update 0
  say ""
  say "dsh update FAILED; rolled back to ${prev} (previous tree self-check: $([ "$prev_ok" = 0 ] && printf 'ok' || printf 'failed'))"
  say "  active:  $PREFIX/harness/current -> $(readlink "$PREFIX/harness/current" 2>/dev/null || printf '?')"
  say "  failed:  $PREFIX/harness/$failed.failed-*"
  say "  backups: $backup"
  if [ "$in_session" = 1 ]; then delegate_service_restart; fi
  return 0
}

prune_versions() { # keep1 keep2 (newest first)
  local keep1="$1" keep2="${2:-}" d name size removed=0
  for d in "$PREFIX/harness"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ -n "$keep1" ] && [ "$name" = "$keep1" ]; then continue; fi
    if [ -n "$keep2" ] && [ "$name" = "$keep2" ]; then continue; fi
    [ -f "$d/.dsh-install-complete" ] || continue
    size="$(du -sh "$d" 2>/dev/null | awk '{print $1}')"
    log "pruning old version $name${size:+ (freed $size)}"
    if rm -rf "$d"; then removed=$((removed + 1)); else warn "could not prune $name"; fi
  done
  prune_failed_versions
  [ "$removed" -gt 0 ] && log "pruned $removed old version tree(s)"
  return 0
}

# Failed update trees (<version>.failed-<ts>) are skipped by the
# keep-current-plus-previous rule and would grow without bound. Keep the newest
# DSH_KEEP_FAILED (default 2) for diagnosis, remove the rest newest-first, and
# report the disk space reclaimed. Safe to run before a fetch: it never touches
# a keep-eligible or incomplete tree.
prune_failed_versions() {
  local keep="${DSH_KEEP_FAILED:-2}" i=0 f name size removed=0
  case "$keep" in ''|*[!0-9]*) keep=2;; esac
  while IFS= read -r f; do
    [ -d "$f" ] || continue
    i=$((i + 1))
    [ "$i" -le "$keep" ] && continue
    name="$(basename "$f")"
    size="$(du -sh "$f" 2>/dev/null | awk '{print $1}')"
    log "pruning failed tree $name${size:+ (freed $size)}"
    if rm -rf "$f"; then removed=$((removed + 1)); else warn "could not prune failed tree $name"; fi
  done < <(ls -1dt "$PREFIX/harness"/*.failed-* 2>/dev/null)
  [ "$removed" -gt 0 ] && log "pruned $removed failed tree(s); kept the newest $keep for diagnosis"
  return 0
}

# Successful-update disk hygiene: bounded release-archive cache (newest 2) and
# bounded backup sets (newest 5) under the harness and the live profile.
prune_update_artifacts() {
  local removed=0 i f d group
  i=0
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    i=$((i + 1))
    [ "$i" -le 2 ] && continue
    if rm -f "$f" "$f.sha256" 2>/dev/null; then removed=$((removed + 1)); else warn "could not prune cached archive $f"; fi
  done < <(ls -1t "$PREFIX/harness/.cache"/dsh-harness-*.tar.gz 2>/dev/null)
  for group in "$PREFIX/harness" "$PROFILE_DIR"; do
    [ -d "$group" ] || continue
    i=0
    while IFS= read -r d; do
      [ -e "$d" ] || continue
      i=$((i + 1))
      [ "$i" -le 5 ] && continue
      if rm -rf "$d" 2>/dev/null; then removed=$((removed + 1)); else warn "could not prune backup $d"; fi
    done < <(ls -1dt "$group"/.backup-* 2>/dev/null)
    # Patch-file backups live beside the live document (cordis.patch.yml.backup-*).
    i=0
    while IFS= read -r d; do
      [ -e "$d" ] || continue
      i=$((i + 1))
      [ "$i" -le 5 ] && continue
      if rm -f "$d" 2>/dev/null; then removed=$((removed + 1)); else warn "could not prune backup $d"; fi
    done < <(ls -1t "$group"/*.backup-* 2>/dev/null)
  done
  [ "$removed" -gt 0 ] && log "pruned $removed stale update artifact(s)"
  return 0
}

dir_recently_touched() { # dir minutes -> 0 when modified within the window
  local d="$1" mins="${2:-120}"
  [ -d "$d" ] || return 1
  # -mmin is available on GNU find and macOS find; a find that rejects it
  # prints nothing, which reads as "not recent" and preserves the old
  # removal behavior. find exits 0 with no match, so test the output.
  [ -n "$(find "$d" -maxdepth 0 -mmin "-$mins" 2>/dev/null)" ]
}

cleanup_stale_artifacts() {
  local count=0 p d name pid
  # 1. Clean orphaned staging directories (.staging-*) where process is dead
  for p in "$PREFIX/harness"/.staging-*; do
    [ -d "$p" ] || continue
    pid="${p##*-}"
    case "$pid" in ''|*[!0-9]*) pid="";; esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then continue; fi
    rm -rf -- "$p" 2>/dev/null && count=$((count + 1))
  done

  # 2. Clean temporary downloads (.download-*) where process is dead
  for p in "$PREFIX/harness"/.download-*; do
    [ -e "$p" ] || continue
    case "$(basename "$p")" in .download-cache*) continue;; esac
    pid="${p##*-}"
    case "$pid" in ''|*[!0-9]*) pid="";; esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then continue; fi
    rm -rf -- "$p" 2>/dev/null && count=$((count + 1))
  done

  # 3. Clean profile staging
  for p in "$PREFIX/harness"/.profile-staging-*; do
    [ -d "$p" ] || continue
    pid="${p##*-}"
    case "$pid" in ''|*[!0-9]*) pid="";; esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then continue; fi
    rm -rf -- "$p" 2>/dev/null && count=$((count + 1))
  done

  # 4. Clean incomplete harness version directories (missing .dsh-install-complete).
  # The marker lands only after a build finishes, so a directory without it may
  # be a concurrent installer's live tree; a recent mtime leaves it alone.
  for d in "$PREFIX/harness"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ ! -f "$d/.dsh-install-complete" ]; then
      if dir_recently_touched "$d" 120; then
        log "keeping recently touched incomplete harness directory: $name (a concurrent install may be building it)"
        continue
      fi
      log "cleaning incomplete harness directory: $name"
      rm -rf -- "$d" 2>/dev/null && count=$((count + 1))
    fi
  done

  # 5. Clean temporary runtime node extractions
  for p in "$PREFIX/runtime"/.node-tmp-*; do
    [ -d "$p" ] || continue
    pid="${p##*-}"
    case "$pid" in ''|*[!0-9]*) pid="";; esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then continue; fi
    rm -rf -- "$p" 2>/dev/null && count=$((count + 1))
  done

  # 6. Clean profile build temp directories
  for p in "${TMPDIR:-/tmp}"/dsh-profile-build.*; do
    [ -d "$p" ] || continue
    rm -rf -- "$p" 2>/dev/null && count=$((count + 1))
  done

  prune_failed_versions
  [ "$count" -gt 0 ] && log "cleaned $count stale/incomplete build artifacts from prior runs"
  return 0
}

CLEAN_COUNT=0
CLEAN_FREED=0
CLEAN_FAILED=0

clean_remove() { # path label
  local p="$1" label="$2" sz
  [ -e "$p" ] || [ -L "$p" ] || return 0
  # BSD/macOS du rejects the GNU `--` end-of-options marker; every caller
  # passes an absolute path, so it is not needed.
  sz="$(du -sk "$p" 2>/dev/null | awk '{print $1}')"
  sz="${sz:-0}"
  if [ "$DRY_RUN" = 1 ]; then
    say "  ${C_DIM}would remove${C_RESET} ${label}: $(basename "$p")"
    return 0
  fi
  if rm -rf -- "$p" 2>/dev/null; then
    CLEAN_COUNT=$((CLEAN_COUNT + 1))
    CLEAN_FREED=$((CLEAN_FREED + sz))
    say "  ${C_GREEN}✓${C_RESET} Removed ${label}: $(basename "$p")"
  else
    CLEAN_FAILED=$((CLEAN_FAILED + 1))
    warn "could not remove $p"
  fi
  return 0
}

do_clean() {
  # --dry-run must not even open the log file.
  [ "$DRY_RUN" = 1 ] || init_log_file
  detect_os_arch
  resolve_home
  say "${C_BOLD}Enpoi Harness — System Cleanup${C_RESET}"
  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run (no writes): listing what a clean would remove under ${PREFIX}..."
  else
    say "Cleaning build artifacts, failed updates, and temporary files under ${PREFIX}..."
  fi
  say ""

  local f d p name

  # 1. Prune all .failed-* directories
  for f in "$PREFIX/harness"/*.failed-*; do
    [ -d "$f" ] || continue
    clean_remove "$f" "failed tree"
  done

  # 2. Prune incomplete harness version trees (missing .dsh-install-complete).
  # The marker lands only after a build finishes, so a directory without it may
  # be a concurrent installer's live tree; a recent mtime leaves it alone.
  for d in "$PREFIX/harness"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ ! -f "$d/.dsh-install-complete" ]; then
      if dir_recently_touched "$d" 120; then
        say "  ${C_DIM}skipped${C_RESET} incomplete tree $(basename "$d") (touched within 2h; a concurrent install may be building it)"
        continue
      fi
      clean_remove "$d" "incomplete version tree"
    fi
  done

  # 3. Prune staging, download, and backup directories
  for p in "$PREFIX/harness"/.staging-* "$PREFIX/harness"/.profile-staging-* "$PREFIX/harness"/.download-* "$PREFIX/harness"/.backup-* "$PREFIX/harness"/*.replaced-*; do
    clean_remove "$p" "staging artifact"
  done

  # 4. Prune download archive cache
  clean_remove "$PREFIX/harness/.cache" "release archive cache"

  # 5. Prune temporary node runtime staging
  for p in "$PREFIX/runtime"/.node-tmp-*; do
    clean_remove "$p" "runtime staging"
  done

  # 6. Prune temp profile build directories and stale remote-installer scripts
  for p in "${TMPDIR:-/tmp}"/dsh-profile-build.* "${TMPDIR:-/tmp}"/dsh-install-* "${TMPDIR:-/tmp}"/dsh-remote-installer-*.sh; do
    clean_remove "$p" "temp profile build"
  done

  local freed_mb=$(( CLEAN_FREED / 1024 ))
  say ""
  if [ "$DRY_RUN" = 1 ]; then
    say "${C_BOLD}Dry run complete.${C_RESET} No files were removed."
    return 0
  fi
  if [ "$CLEAN_FAILED" -gt 0 ]; then
    say "${C_RED}${C_BOLD}Cleanup incomplete!${C_RESET} Removed ${CLEAN_COUNT} item(s), freed ~${freed_mb}MB; ${CLEAN_FAILED} path(s) could not be removed."
    say "User data in ${DSH_HOME} (sessions, settings, credentials) was left completely intact."
    return 1
  fi
  say "${C_GREEN}${C_BOLD}Cleanup complete!${C_RESET} Removed ${CLEAN_COUNT} item(s), freed ~${freed_mb}MB."
  say "User data in ${DSH_HOME} (sessions, settings, credentials) was left completely intact."
  return 0
}

# One update per install root: a concurrent update would race the version tree,
# the current symlink, and the user-file backups. flock(1) releases the lock
# when this process exits; macOS ships no flock, so the fallback is an atomic
# mkdir plus the holder's PID, which also reclaims a lock left by a dead
# process. --dry-run is read-only and skips the lock. The EXIT trap removes the
# fallback lock directory.
acquire_update_lock() {
  [ "${DRY_RUN:-0}" != 1 ] || return 0
  mkdir -p "$PREFIX/harness" 2>/dev/null || true
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$PREFIX/harness/.update.lock" && flock -n 9 || die "another update is already running (lock: $PREFIX/harness/.update.lock); wait for it to finish, or remove the lock file if it is stale"
    log "update lock acquired: $PREFIX/harness/.update.lock"
    return 0
  fi
  local lock_dir="$PREFIX/harness/.update.lock.d" pid
  if ! mkdir "$lock_dir" 2>/dev/null; then
    pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$lock_dir" 2>/dev/null && mkdir "$lock_dir" 2>/dev/null || die "another update is already running (lock: $lock_dir)"
    else
      die "another update is already running (lock: $lock_dir)"
    fi
  fi
  echo "$$" > "$lock_dir/pid"
  UPDATE_LOCK_DIR="$lock_dir"
  # A signal must run the EXIT trap (lock removal, restore safety net).
  trap 'exit 130' INT
  trap 'exit 143' TERM
  log "update lock acquired (mkdir fallback): $lock_dir"
  return 0
}

do_update() {
  local state="$PREFIX/harness/install-state.json" current backup late_backup rc recorded_home recorded_bin installed_version deferred_restart
  STEP_TOTAL=8
  [ -f "$state" ] || die "no install state at $state; run the installer first"
  acquire_update_lock
  detect_os_arch
  step "environment: existing install under $PREFIX"
  resolve_node 0 || die "no usable Node.js found for the update"
  if [ -z "$CHANNEL" ]; then CHANNEL="$(json_field "$state" channel)"; [ -n "$CHANNEL" ] || CHANNEL=stable; fi
  if [ -z "$SOURCE" ]; then SOURCE="$(json_field "$state" source)"; fi
  if [ -z "$REF" ]; then REF="$(json_field "$state" ref)"; fi
  if [ -z "$PROFILE" ]; then PROFILE="$(json_field "$state" profile)"; [ -n "$PROFILE" ] || PROFILE=web; fi
  if [ -z "$PROFILE_SOURCE" ]; then PROFILE_SOURCE="$(json_field "$state" profileSource)"; fi
  if [ -z "$PROFILE_REF" ] && [ "$PROFILE_REF_EXPLICIT" != 1 ]; then PROFILE_REF="$(json_field "$state" profileRef)"; fi
  if [ "$(json_field "$state" profileRefDerived)" = "true" ]; then PROFILE_REF_DERIVED=1; fi
  apply_profile_ref_default 1
  # The recorded bin dir is authoritative for an update; this invocation's
  # --bin-dir is the only override. BIN_DIR already holds the default here, so
  # the explicit flag is what distinguishes an override.
  if [ "$BIN_DIR_EXPLICIT" = 0 ]; then
    recorded_bin="$(json_field "$state" binDir)"
    [ -n "$recorded_bin" ] && BIN_DIR="$recorded_bin"
  fi
  if [ -z "$SERVICE_UNIT" ]; then SERVICE_UNIT="$(json_field "$state" serviceUnit)"; fi
  # --no-service is sticky: an install that declined the service must not gain
  # one on a later update. An explicit --no-service on this run always wins.
  if [ "$SERVICE_INSTALL_EXPLICIT" = 0 ] && [ "$(json_field "$state" serviceInstall)" = "false" ]; then
    SERVICE_INSTALL=0
    log "service: install disabled by the recorded --no-service setting"
  fi
  resolve_home
  # The state file records the home this install was seeded with; updating a
  # different home would migrate/seed the wrong tree. Any mismatch is fatal
  # before a single write, with the exact remedy.
  recorded_home="$(json_field "$state" dshHome)"
  if [ -n "$recorded_home" ] && [ "$recorded_home" != "$DSH_HOME" ]; then
    die "DSH_HOME mismatch: $state records dshHome='$recorded_home' but this invocation resolves DSH_HOME='$DSH_HOME'. Nothing was changed. Remedy: export DSH_HOME='$recorded_home' and re-run (or: DSH_HOME='$recorded_home' dsh update). To deliberately move the home, re-run the installer with --dsh-home '$DSH_HOME' --prefix '$PREFIX'."
  fi
  current="$(readlink "$PREFIX/harness/current" 2>/dev/null || true)"
  if [ -z "$current" ]; then current="$(json_field "$state" version)"; fi
  [ -n "$current" ] && [ -d "$PREFIX/harness/$current" ] || die "cannot find the active version under $PREFIX/harness (current='$current')"
  PREV_VERSION="$current"
  # The active tree's build identity and recorded build commit. A prebuilt
  # release tree records the release version (`0.1.7-enpoi.2.42`) in
  # .dsh-install-complete while its package.json keeps the base version
  # (`0.1.7-enpoi.2`); the marker wins so build-to-build updates compare
  # release versions. The directory name may carry a short-SHA suffix after a
  # rolling source rebuild; neither it nor the manifest is the identity.
  installed_version="$(json_field "$PREFIX/harness/$current/.dsh-install-complete" version 2>/dev/null || true)"
  [ -n "$installed_version" ] || installed_version="$(read_version "$PREFIX/harness/$current/package.json" 2>/dev/null || true)"
  [ -n "$installed_version" ] || installed_version="$(json_field "$state" version)"
  INSTALLED_COMMIT="$(installed_tree_commit "$PREFIX/harness/$current")"
  if [ "$DRY_RUN" = 1 ]; then
    local target_value="" dry_target_commit=""
    if [ -z "$SOURCE" ]; then
      say "  source:   $DSH_GITHUB_URL/archive/${REF:-$CHANNEL}.tar.gz (version resolved at fetch time)"
    elif [ -d "$SOURCE" ]; then
      target_value="$("$NODE" -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8"));process.stdout.write(String(p.version||""))' "$SOURCE" 2>/dev/null || true)"
      say "  source:   $SOURCE (version ${target_value:-unknown})"
    else
      say "  source:   $SOURCE"
    fi
    if [ -n "$SOURCE" ] && [ -d "$SOURCE/.git" ]; then
      dry_target_commit="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
    elif [ -z "$SOURCE" ]; then
      dry_target_commit="$(resolve_target_commit "${REF:-$CHANNEL}" "$DSH_GITHUB_URL")"
    fi
    case "$dry_target_commit" in *[!0-9a-fA-F]*|'') dry_target_commit="";; esac
    say "dsh update dry run (no writes)"
    say "  active:   $current ($CHANNEL channel)"
    [ -n "$installed_version" ] && [ "$installed_version" != "$current" ] && say "  version:  $installed_version"
    [ -n "$INSTALLED_COMMIT" ] && say "  built:    $INSTALLED_COMMIT"
    if [ -n "$dry_target_commit" ]; then
      if commit_same "$dry_target_commit" "$INSTALLED_COMMIT"; then
        say "  commit:   $dry_target_commit (already built)"
      else
        say "  commit:   $dry_target_commit (newer than the installed build; the fetch resolves the newest release or rebuilds ${target_value:-<version>}-$(printf '%s' "$dry_target_commit" | cut -c1-7))"
      fi
    fi
    [ -n "$target_value" ] && say "  target:   $target_value"
    if [ -n "$PROFILE_SOURCE" ]; then say "  profile:  $PROFILE (source: $PROFILE_SOURCE${PROFILE_REF:+, ref: $PROFILE_REF})"; else say "  profile:  $PROFILE (no recorded source)"; fi
    say "  steps:    fetch -> install+build -> profile refresh+deps -> migrations -> switch current -> service restart ($([ -n "$SERVICE_UNIT" ] && printf '%s' "$SERVICE_UNIT" || printf 'none recorded')) -> backfill -> self-check"
    say "  rollback: current link + user-file backups would be restored on failure"
    emit_json update 1
    return 0
  fi
  # Without this, every run_logged call in update mode redirects to an empty
  # path and fails. After the dry-run return, so --dry-run opens no log file.
  init_log_file
  sudo_trap
  # Disk hygiene before fetching: failed trees are never keep-eligible, so
  # reclaim them before the new tree needs the space.
  prune_failed_versions
  log "update: active $current on the $CHANNEL channel"
  step "source: ${SOURCE:-$CHANNEL channel archive}"
  prepare_source
  resolve_target_for_source
  if [ "${PREBUILT:-0}" = 1 ]; then
    log "update target: $VERSION (prebuilt release${RELEASE_COMMIT:+; commit ${RELEASE_COMMIT}})"
  else
    log "update target: $VERSION${TARGET_COMMIT:+ (commit ${TARGET_COMMIT})}"
  fi
  # A complete tree found by prepare_source for this exact commit is reused
  # as-is: resetting the name to $VERSION (or later to <version>-<short>) would
  # point install_tree at a directory that does not exist while $STAGED is empty
  # (nothing to extract), failing the update with a tar open error.
  if [ -n "${REUSED_TREE_DIR:-}" ]; then
    TREE_DIR_NAME="$REUSED_TREE_DIR"
  else
    TREE_DIR_NAME="$VERSION"
  fi

  # A prebuilt release carries a unique version, so version equality alone is
  # "up to date" even when the channel branch moved after the release was
  # published. A source-archive target keeps the old rule: the base version can
  # repeat on a rolling channel, so the recorded commit decides. An
  # unresolvable target (no git, no network) keeps the version-only behavior.
  if [ "$VERSION" = "$installed_version" ] && [ "$FORCE" != 1 ] \
    && { [ "${PREBUILT:-0}" = 1 ] || [ -z "$TARGET_COMMIT" ] || commit_same "$TARGET_COMMIT" "$INSTALLED_COMMIT"; }; then
    # The no-op path self-checks the ACTIVE tree, whose directory may carry a
    # short-SHA suffix after an earlier rolling rebuild.
    HARNESS="$PREFIX/harness/$current"
    if [ -z "$PNPM" ] && [ -x "$PREFIX/bin/pnpm" ]; then PNPM="$PREFIX/bin/pnpm"; fi
    log "already up to date at $VERSION; nothing to fetch/build"
    if [ -n "$STAGED" ]; then rm -rf "$STAGED"; STAGED=""; fi
    step "pnpm: present (nothing to rebuild)"
    step "dependencies and build: already up to date at $VERSION"
    step "profile: $PROFILE (refresh)"
    # The refresh merges the profile patch and package.json; arm the same
    # pre-switch restore the full path uses so a failed self-check cannot
    # leave mutated user files behind.
    backup="$PREFIX/harness/.backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup" 2>/dev/null || warn "could not create backup dir $backup"
    backup_user_files "$backup"
    PRE_SWITCH_RESTORE="$backup"
    prepare_profile
    step "home: seeding $DSH_HOME and profile dependencies"
    seed_home
    profile_install || warn "profile dependency refresh failed"
    run_profile_plugin_build || warn "profile plugin build failed"
    ensure_service
    ensure_tailnet_exposure
    step "switch, service and backfill: $VERSION already active"
    step "self-check"
    if ! selfcheck; then
      warn "self-check of the active tree failed"
      restore_pre_switch "$backup" "already up to date self-check"
      emit_json noop 0
      exit 1
    fi
    PRE_SWITCH_RESTORE=""
    # Regenerate the shim even when no new tree was built: a shim fix in the
    # installer must reach an already-current install through `dsh update`.
    write_shim || warn "could not refresh the dsh shim in $BIN_DIR"
    write_peer_cli || warn "could not refresh the peer CLI in $BIN_DIR"
    if [ "$WRITE_RC" = 1 ]; then write_rc; fi
    prune_update_artifacts
    say "dsh is already up to date: $VERSION ($CHANNEL channel)"
    emit_json noop 1
    return 0
  fi
  # A source build of the base version must not land on an existing directory
  # that holds a different build of the same base (the pre-release tree, or an
  # earlier rolling build): suffix the directory with the target's short SHA.
  # The existing tree's own recorded commit decides, not the active release.
  if [ -z "${REUSED_TREE_DIR:-}" ] && [ "${PREBUILT:-0}" != 1 ] && [ -n "$TARGET_COMMIT" ] \
    && [ -f "$PREFIX/harness/$VERSION/.dsh-install-complete" ] \
    && ! commit_same "$TARGET_COMMIT" "$(installed_tree_commit "$PREFIX/harness/$VERSION")"; then
    local short
    short="$(printf '%s' "$TARGET_COMMIT" | cut -c1-7)"
    TREE_DIR_NAME="$VERSION-$short"
    log "existing $VERSION tree records $(installed_tree_commit "$PREFIX/harness/$VERSION") -> target $short; building into $TREE_DIR_NAME"
  fi
  HARNESS="$PREFIX/harness/$TREE_DIR_NAME"
  # A source-archive fallback resolves the tree's base version
  # (`0.1.7-enpoi.2`), which sorts below an installed release of the same line
  # (`0.1.7-enpoi.2.42`) because the release adds prerelease identifiers. That
  # is the same build line, not a downgrade; --no-prebuilt and a release whose
  # platform asset is missing both land here. A base that is genuinely older
  # (different core or RC marker) still refuses.
  if ver_lt "$VERSION" "$installed_version" && [ "$FORCE_DOWNGRADE" != 1 ]; then
    case "$installed_version" in
      "$VERSION".*) log "target $VERSION is the base of installed release $installed_version; same build line, not a downgrade";;
      *) die "refusing to downgrade from ${installed_version:-$current} to $VERSION without --force-downgrade";;
    esac
  fi

  step "pnpm: corepack"
  setup_pnpm || die "could not enable pnpm through corepack"
  backup="$PREFIX/harness/.backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup" 2>/dev/null || warn "could not create backup dir $backup"
  backup_user_files "$backup"
  # Arming this makes the EXIT trap restore the pristine snapshot if a die()
  # path exits before the switch; the explicit calls below disarm it.
  PRE_SWITCH_RESTORE="$backup"
  log "user-file backups: $backup"

  step "dependencies and build (this takes a few minutes)"
  if ! install_tree; then
    warn "update failed before switching; $current remains active"
    restore_pre_switch "$backup" "the build"
    write_diagnostics install-failed
    emit_json update 0
    exit 1
  fi
  step "profile: $PROFILE"
  if ! prepare_profile; then
    warn "profile refresh failed before switching; $current remains active"
    restore_pre_switch "$backup" "the profile refresh"
    write_diagnostics profile-failed
    emit_json update 0
    exit 1
  fi
  step "home, dependencies and migrations"
  if ! run_migrations; then
    warn "migrations failed before switching; $current remains active"
    restore_pre_switch "$backup" "migrations"
    write_diagnostics migrations-failed
    emit_json update 0
    exit 1
  fi

  step "switch, service and backfill"
  # A second snapshot immediately before the switch is forensic evidence only:
  # the profile merge and migrations have already rewritten the files it holds.
  # Rollback always restores the pristine early $backup, never this one.
  late_backup="$PREFIX/harness/.backup-$(date +%Y%m%d-%H%M%S)-pre-switch"
  [ -e "$late_backup" ] && late_backup="$late_backup-$$"
  if mkdir -p "$late_backup" 2>/dev/null; then
    backup_user_files "$late_backup"
    log "pre-switch user-file backups (forensic): $late_backup"
  else
    warn "could not create the pre-switch backup dir; the early backup remains the restore source"
    late_backup=""
  fi
  switch_current "$TREE_DIR_NAME" || die "could not switch $PREFIX/harness/current to $TREE_DIR_NAME"
  # Past the switch, rollback owns restoration from the pristine snapshot.
  PRE_SWITCH_RESTORE=""
  log "switched current -> $TREE_DIR_NAME"
  # A process inside the managed unit cannot survive a direct restart: systemd
  # stops the unit's whole process tree and launchd the job's. Such an update
  # does every durable step first — backfill and self-check included — and
  # delegates the restart only after the result is reported, so the caller
  # always receives it. A plain out-of-session `dsh update` restarts as before.
  deferred_restart=0
  if running_under_service; then deferred_restart=1; fi
  if [ "$deferred_restart" = 0 ]; then restart_service; fi
  ensure_service
  ensure_tailnet_exposure
  run_backfill

  step "self-check"
  if ! selfcheck; then
    # Restore the pristine pre-update snapshot: the late pre-switch snapshot
    # holds migrated new-format files and would put them onto the old binary.
    # It stays on disk as forensic evidence.
    rollback "$current" "$backup" "$TREE_DIR_NAME"
    exit 1
  fi
  write_shim || warn "could not refresh the dsh shim in $BIN_DIR"
  write_peer_cli || warn "could not refresh the peer CLI in $BIN_DIR"
  write_state || warn "could not write $state"
  if [ "$WRITE_RC" = 1 ]; then write_rc; fi
  prune_versions "$TREE_DIR_NAME" "$current"
  prune_update_artifacts
  print_summary update
  emit_json update 1
  if [ "$deferred_restart" = 1 ]; then delegate_service_restart; fi
  return 0
}

# ── Repair (self-heal) ──────────────────────────────────────────────────────
# Verifies the install's invariants and fixes the safe ones: a missing shipped
# file (settings, fish function), a broken link (current), a stale staging
# path, a disabled/inactive service unit, an unsafe credentials mode, and the
# projection backfill. Everything else is reported with the exact remedy
# command. --check is report-only and exits non-zero on any finding.
REPAIR_ISSUES=0
REPAIR_FIXED=0
REPAIR_UNFIXABLE=0
REPAIR_FINDINGS=""

repair_issue() {
  REPAIR_ISSUES=$((REPAIR_ISSUES + 1))
  if [ -n "$REPAIR_FINDINGS" ]; then REPAIR_FINDINGS="$REPAIR_FINDINGS
$1"; else REPAIR_FINDINGS="$1"; fi
}

repair_note() { say "  - $1"; }

repair_fixable() { # desc -> 0 when the caller should apply the fix
  repair_issue "$1"
  if [ "$CHECK_ONLY" = 1 ]; then say "  ~ would fix: $1"; return 1; fi
  return 0
}

repair_fixed() { REPAIR_FIXED=$((REPAIR_FIXED + 1)); say "  + fixed: $1"; }

repair_fail() { # desc remedy
  repair_issue "$1"
  REPAIR_UNFIXABLE=$((REPAIR_UNFIXABLE + 1))
  say "  ! $1"
  say "    remedy: $2"
}

repair_json_findings() {
  local first=1 f
  printf '['
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$first" = 1 ] || printf ', '
    first=0
    printf '"%s"' "$(json_escape "$f")"
  done <<EOF
$REPAIR_FINDINGS
EOF
  printf ']'
}

newest_complete_version() {
  local d name
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    d="${d%/}"
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ -f "$d/.dsh-install-complete" ]; then printf '%s' "$name"; return 0; fi
  done <<EOF
$(ls -1dt "$PREFIX/harness"/*/ 2>/dev/null)
EOF
  return 1
}

do_repair() {
  local state="$PREFIX/harness/install-state.json" recorded_home recorded_version active
  local target cand d name v shim unit en st code port url p pid b l rc peer_cli
  local perm complete_any=0 fish_dir fsrc fdst rel

  if [ "$DRY_RUN" = 1 ]; then CHECK_ONLY=1; fi
  detect_os_arch
  printf '%s: repair%s\n' "$SCRIPT_NAME" \
    "$([ "$CHECK_ONLY" = 1 ] && printf ' --check (report only)' || printf ' (self-heal)')" >&2

  # ── install state (recorded version, home, bin dir, unit) ──
  # Resolve Node first so json_field uses the JSON parser, not the sed fallback.
  if [ -z "$NODE" ]; then resolve_node 0 >/dev/null 2>&1 || true; fi
  recorded_version=""
  if [ -f "$state" ]; then
    recorded_home="$(json_field "$state" dshHome)"
    if [ -n "$recorded_home" ] && [ "$recorded_home" != "$DSH_HOME" ]; then
      die "DSH_HOME mismatch: $state records dshHome='$recorded_home' but this invocation resolves DSH_HOME='$DSH_HOME'. Nothing was changed. Remedy: export DSH_HOME='$recorded_home' and re-run (or: DSH_HOME='$recorded_home' dsh repair)."
    fi
    [ -n "$PROFILE" ] || PROFILE="$(json_field "$state" profile)"
    if [ "$BIN_DIR_EXPLICIT" = 0 ]; then
      v="$(json_field "$state" binDir)"
      [ -n "$v" ] && BIN_DIR="$v"
    fi
    [ -n "$SERVICE_UNIT" ] || SERVICE_UNIT="$(json_field "$state" serviceUnit)"
    recorded_version="$(json_field "$state" version)"
    v="$(json_field "$state" node)"
    if [ -z "$NODE" ] && [ -n "$v" ] && [ -x "$v" ]; then NODE="$v"; NODE_ORIGIN="state"; fi
  else
    repair_fail "install state $state is missing" "re-run the installer: install.sh --prefix '$PREFIX' --dsh-home '$DSH_HOME'"
  fi
  [ -n "$PROFILE" ] || PROFILE=web
  [ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"
  resolve_home
  HARNESS=""

  # ── version dirs + the current symlink ──
  active=""
  if [ -L "$PREFIX/harness/current" ]; then
    target="$(readlink "$PREFIX/harness/current" 2>/dev/null || true)"
    case "$target" in
      /*) cand="$target";;
      *) cand="$PREFIX/harness/$target";;
    esac
    if [ -n "$target" ] && [ -f "$cand/.dsh-install-complete" ]; then active="$(basename "$target")"; fi
  fi
  if [ -z "$active" ]; then
    if [ -n "$recorded_version" ] && [ -f "$PREFIX/harness/$recorded_version/.dsh-install-complete" ]; then
      active="$recorded_version"
    else
      active="$(newest_complete_version || true)"
    fi
  fi
  for d in "$PREFIX/harness"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ -f "$d/.dsh-install-complete" ]; then
      complete_any=1
    else
      repair_fail "incomplete version tree $name (no .dsh-install-complete marker)" "remove it and re-run the installer: rm -rf '$d' && install.sh --prefix '$PREFIX'"
    fi
  done
  if [ "$complete_any" = 0 ]; then
    repair_fail "no complete version tree under $PREFIX/harness" "re-run the installer: install.sh --prefix '$PREFIX' --dsh-home '$DSH_HOME'"
  fi
  if [ -n "$active" ]; then
    HARNESS="$PREFIX/harness/$active"
    repair_note "active version: $active"
  fi

  if [ ! -e "$PREFIX/harness/current" ] && [ ! -L "$PREFIX/harness/current" ]; then
    if [ -n "$active" ]; then
      if repair_fixable "current symlink is missing"; then
        if ln -sfn "$active" "$PREFIX/harness/current"; then repair_fixed "current -> $active"; else repair_fail "could not create $PREFIX/harness/current" "ln -sfn '$active' '$PREFIX/harness/current'"; fi
      fi
    else
      repair_fail "current symlink is missing and no complete version tree is available" "re-run the installer: install.sh --prefix '$PREFIX' --dsh-home '$DSH_HOME'"
    fi
  elif [ -L "$PREFIX/harness/current" ]; then
    target="$(readlink "$PREFIX/harness/current" 2>/dev/null || true)"
    case "$target" in
      /*) cand="$target";;
      *) cand="$PREFIX/harness/$target";;
    esac
    if [ ! -f "$cand/.dsh-install-complete" ]; then
      if [ -n "$active" ]; then
        if repair_fixable "current is broken (-> ${target:-?})"; then
          if ln -sfn "$active" "$PREFIX/harness/current"; then repair_fixed "current -> $active"; else repair_fail "could not repoint $PREFIX/harness/current" "ln -sfn '$active' '$PREFIX/harness/current'"; fi
        fi
      else
        repair_fail "current is broken (-> ${target:-?}) and no complete version tree is available" "re-run the installer: install.sh --prefix '$PREFIX' --dsh-home '$DSH_HOME'"
      fi
    fi
  else
    repair_fail "$PREFIX/harness/current exists but is not a symlink" "move it aside and re-run the installer: mv '$PREFIX/harness/current' '$PREFIX/harness/current.manual'"
  fi

  # ── stale staging/lock paths (only when their PID is gone) ──
  for p in "$PREFIX/harness"/.staging-* "$PREFIX/harness"/.download-* "$PREFIX/harness"/.profile-staging-*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    pid="${p##*-}"
    case "$pid" in ''|*[!0-9]*) pid="";; esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      repair_note "active staging $p (pid $pid alive; left alone)"
      continue
    fi
    if repair_fixable "stale staging path $p"; then
      if rm -rf -- "$p"; then repair_fixed "pruned $p"; else repair_fail "could not prune $p" "rm -rf '$p'"; fi
    fi
  done

  # ── shim + PATH ──
  shim="$BIN_DIR/dsh"
  if [ ! -e "$shim" ] && [ ! -L "$shim" ]; then
    if repair_fixable "shim $shim is missing"; then
      if [ -n "$NODE" ] && write_shim; then repair_fixed "re-created $shim"; else repair_fail "could not re-create $shim" "re-run the installer with --bin-dir '$BIN_DIR'"; fi
    fi
  elif [ ! -x "$shim" ]; then
    if repair_fixable "shim $shim is not executable"; then
      if chmod +x "$shim"; then repair_fixed "chmod +x $shim"; else repair_fail "could not chmod $shim" "chmod +x '$shim'"; fi
    fi
  elif ! grep -qF -- "$PREFIX" "$shim" 2>/dev/null; then
    if repair_fixable "shim $shim does not reference $PREFIX"; then
      if [ -n "$NODE" ] && write_shim; then repair_fixed "regenerated $shim"; else repair_fail "could not regenerate $shim" "re-run the installer with --bin-dir '$BIN_DIR'"; fi
    fi
  fi
  peer_cli="$BIN_DIR/dsh-peer"
  if [ ! -e "$peer_cli" ]; then
    if repair_fixable "peer CLI $peer_cli is missing"; then
      if write_peer_cli; then repair_fixed "seeded $peer_cli"; else repair_note "could not seed $peer_cli (the active tree may predate it; a real update brings it)"; fi
    fi
  elif [ ! -x "$peer_cli" ]; then
    if repair_fixable "peer CLI $peer_cli is not executable"; then
      if chmod +x "$peer_cli"; then repair_fixed "chmod +x $peer_cli"; else repair_fail "could not chmod $peer_cli" "chmod +x '$peer_cli'"; fi
    fi
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*) repair_note "shim dir $BIN_DIR is on PATH";;
    *) repair_fail "shim dir $BIN_DIR is not on PATH" "re-run the installer with --write-rc, or add '$BIN_DIR' to PATH yourself";;
  esac

  # ── profile tree, its node_modules links, and the config overlay ──
  if [ ! -d "$PROFILE_DIR" ]; then
    if [ -n "$(json_field "$state" profileSource 2>/dev/null || true)" ]; then
      repair_fail "profile tree $PROFILE_DIR is missing" "re-run the installer (it fetches the recorded profile source)"
    fi
  else
    if [ -f "$PROFILE_DIR/package.json" ] && [ ! -d "$PROFILE_DIR/node_modules" ]; then
      repair_fail "profile dependencies are missing ($PROFILE_DIR/node_modules)" "(cd '$PROFILE_DIR' && pnpm install)"
    fi
    while IFS= read -r l; do
      [ -n "$l" ] || continue
      [ -L "$l" ] || continue
      if [ ! -e "$l" ]; then
        repair_fail "broken link $l" "(cd '$PROFILE_DIR' && pnpm install)  # or restore what it pointed at"
      fi
    done <<EOF
$(find "$PROFILE_DIR/node_modules" -maxdepth 2 -type l 2>/dev/null)
EOF
    if [ ! -f "$PROFILE_DIR/cordis.patch.yml" ]; then
      repair_fail "$PROFILE_DIR/cordis.patch.yml is missing (the config-editor document)" "restore it from a backup under $PROFILE_DIR/.backup-*/ or re-run the installer"
    fi
  fi

  # ── fish function/completions (re-seed only when missing) ──
  # The profile ships fish/ds.fish and fish/completions/ds.fish; the first one
  # is seeded into ~/.config/fish/functions/ds.fish (see seed_profile_home).
  fish_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
  if [ -d "$fish_dir" ] && [ -f "$PROFILE_DIR/fish/ds.fish" ]; then
    for pair in "ds.fish:functions/ds.fish" "completions/ds.fish:completions/ds.fish"; do
      fsrc="$PROFILE_DIR/fish/${pair%%:*}"
      fdst="$fish_dir/${pair#*:}"
      [ -f "$fsrc" ] || continue
      if [ ! -f "$fdst" ]; then
        if repair_fixable "fish file $fdst is missing"; then
          if mkdir -p "$(dirname "$fdst")" && cp -p "$fsrc" "$fdst"; then repair_fixed "re-seeded $fdst"; else repair_fail "could not re-seed $fdst" "cp '$fsrc' '$fdst'"; fi
        fi
      fi
    done
  fi

  # ── settings + credentials ──
  if [ ! -f "$DSH_HOME/settings.yaml" ]; then
    if repair_fixable "$DSH_HOME/settings.yaml is missing"; then
      rc=1
      if [ -n "$NODE" ] && [ -n "$HARNESS" ] && [ -f "$HARNESS/apps/cli/lib/bin.js" ]; then
        seed_home || true
        [ -f "$DSH_HOME/settings.yaml" ] && rc=0
      fi
      if [ "$rc" = 0 ]; then repair_fixed "re-seeded $DSH_HOME/settings.yaml"; else repair_fail "could not re-seed $DSH_HOME/settings.yaml" "re-run the installer, or: DSH_HOME='$DSH_HOME' dsh update"; fi
    fi
  fi
  if [ -f "$DSH_HOME/.credentials.yaml" ]; then
    perm="$(stat -c '%a' "$DSH_HOME/.credentials.yaml" 2>/dev/null || stat -f '%Lp' "$DSH_HOME/.credentials.yaml" 2>/dev/null || true)"
    if [ -n "$perm" ] && [ "$perm" != "600" ]; then
      if repair_fixable "$DSH_HOME/.credentials.yaml is mode $perm (want 600)"; then
        if chmod 600 "$DSH_HOME/.credentials.yaml"; then repair_fixed "chmod 600 $DSH_HOME/.credentials.yaml"; else repair_fail "could not chmod $DSH_HOME/.credentials.yaml" "chmod 600 '$DSH_HOME/.credentials.yaml'"; fi
      fi
    fi
  fi

  # ── service unit + bound port ──
  unit="$SERVICE_UNIT"
  if [ -z "$unit" ]; then unit="$(detect_service_unit)"; fi
  if [ -n "$unit" ]; then
    case "$OS" in
      linux)
        if ! command -v systemctl >/dev/null 2>&1; then
          repair_note "systemctl not available; unit check skipped"
        elif ! systemctl --user cat "$unit" >/dev/null 2>&1; then
          repair_fail "unit $unit is recorded but systemd cannot find it" "re-create the unit (the profile ships systemd/$unit) and run: systemctl --user daemon-reload"
        else
          en="$(systemctl --user is-enabled "$unit" 2>/dev/null || true)"
          case "$en" in
            disabled|masked)
              if repair_fixable "unit $unit is $en"; then
                if systemctl --user enable "$unit" >/dev/null 2>&1; then repair_fixed "enabled $unit"; else repair_fail "could not enable $unit" "systemctl --user enable '$unit'"; fi
              fi;;
            *) repair_note "unit $unit enabled ($en)";;
          esac
          st="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
          if [ "$st" != "active" ]; then
            if repair_fixable "unit $unit is ${st:-inactive}"; then
              if systemctl --user start "$unit" >/dev/null 2>&1; then repair_fixed "started $unit"; else repair_fail "could not start $unit" "ds restart; journalctl --user -u '$unit' -n 50"; fi
            fi
          else
            repair_note "unit $unit active"
          fi
        fi
        ;;
      darwin)
        local plist="$HOME/Library/LaunchAgents/$unit.plist"
        if [ ! -f "$plist" ]; then
          repair_fail "launchd unit $plist is missing" "re-create the unit (the profile ships systemd/$unit) and load it: launchctl bootstrap gui/$(id -u) '$plist'"
        elif launchctl print "gui/$(id -u)/$unit" >/dev/null 2>&1; then
          repair_note "launchd $unit loaded"
        elif repair_fixable "launchd $unit is not loaded"; then
          if launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1; then repair_fixed "loaded $unit"; else repair_fail "could not load $unit" "launchctl bootstrap gui/$(id -u) '$plist'"; fi
        fi
        ;;
    esac
  else
    repair_note "no service unit references this install; service check skipped"
  fi
  if [ -n "$unit" ] && [ "$OS" = linux ] && command -v curl >/dev/null 2>&1 \
     && [ "$(systemctl --user is-active "$unit" 2>/dev/null || true)" = "active" ]; then
    port="${DSH_WEB_PORT:-3080}"
    case "$port" in ''|*[!0-9]*) port=3080;; esac
    url="http://127.0.0.1:$port/"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)"
    case "$code" in
      2*|3*|401|403) repair_note "web port $port answers (HTTP $code)";;
      *) repair_fail "web port $port does not answer (HTTP ${code:-none})" "ds restart; journalctl --user -u '$unit' -n 50";;
    esac
  fi

  # ── projection backfill ──
  if [ -n "$HARNESS" ]; then
    b="$(find_backfill)"
    if [ -z "$b" ]; then
      repair_note "projection backfill script not present; skipped"
    elif [ "$CHECK_ONLY" = 1 ]; then
      repair_note "projection backfill would run: $b"
    elif [ -z "$NODE" ]; then
      repair_fail "projection backfill cannot run (no Node.js found)" "ds backfill"
    elif run_limited 300 "$NODE" "$b" status >/dev/null 2>&1; then
      repair_note "projection backfill: status ok"
      if [ -n "$unit" ]; then
        if run_limited 600 "$NODE" "$b" run >/dev/null 2>&1; then repair_note "projection backfill: run complete"; else repair_fail "projection backfill run failed" "DSH_HOME='$DSH_HOME' node '$b' run"; fi
      fi
    else
      repair_fail "projection backfill status failed" "DSH_HOME='$DSH_HOME' node '$b' status"
    fi
  fi

  if [ "$CHECK_ONLY" = 1 ]; then
    say "dsh repair --check: $REPAIR_ISSUES finding(s) ($REPAIR_UNFIXABLE unfixable)"
  else
    say "dsh repair: $REPAIR_FIXED fixed, $REPAIR_UNFIXABLE unfixable ($REPAIR_ISSUES finding(s))"
  fi
  if [ "$JSON_OUT" = 1 ]; then
    if [ "$CHECK_ONLY" = 1 ]; then
      if [ "$REPAIR_ISSUES" = 0 ]; then v=1; else v=0; fi
    else
      if [ "$REPAIR_UNFIXABLE" = 0 ]; then v=1; else v=0; fi
    fi
    printf '{"ok": %s, "action": "repair", "check": %s, "prefix": "%s", "dshHome": "%s", "profile": "%s", "fixed": %s, "unfixable": %s, "findings": %s}\n' \
      "$v" "$CHECK_ONLY" "$(json_escape "$PREFIX")" "$(json_escape "$DSH_HOME")" "$(json_escape "$PROFILE")" \
      "$REPAIR_FIXED" "$REPAIR_UNFIXABLE" "$(repair_json_findings)"
  fi
  if [ "$CHECK_ONLY" = 1 ]; then [ "$REPAIR_ISSUES" = 0 ] || return 1; return 0; fi
  [ "$REPAIR_UNFIXABLE" = 0 ] || return 1
  return 0
}

# ── Uninstall ───────────────────────────────────────────────────────────────
uninstall_plan=""
uninstall_kept=""
uninstall_outside=""

uninstall_add() {
  [ -n "${1:-}" ] || return 0
  if [ -n "$uninstall_plan" ]; then uninstall_plan="$uninstall_plan
$1"; else uninstall_plan="$1"; fi
}

uninstall_keep() {
  [ -n "${1:-}" ] || return 0
  if [ -n "$uninstall_kept" ]; then uninstall_kept="$uninstall_kept
$1"; else uninstall_kept="$1"; fi
}

uninstall_outside_add() {
  [ -n "${1:-}" ] || return 0
  if [ -n "$uninstall_outside" ]; then uninstall_outside="$uninstall_outside
$1"; else uninstall_outside="$1"; fi
}

plan_size_suffix() {
  local s
  s="$(du -sh -- "$1" 2>/dev/null | awk '{print $1}')"
  [ -n "$s" ] && printf ' (%s)' "$s"
  return 0
}

uninstall_guard() { # path label
  local p="$1" label="$2" rest
  case "$p" in
    ''|/) die "refusing to remove $label '$p'";;
  esac
  if [ "$p" = "$HOME" ]; then die "refusing to remove $label '$p' (that is \$HOME)"; fi
  case "$p" in /*) :;; *) die "refusing to remove $label '$p' (not an absolute path)";; esac
  rest="${p#/}"
  case "$rest" in */*) :;; *) die "refusing to remove $label '$p' (too close to the filesystem root)";; esac
  return 0
}

unit_belongs() { # unit -> 0 when it references this install prefix
  local u="$1" f
  if command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$u" 2>/dev/null | grep -qF -- "$PREFIX"; then return 0; fi
  for f in "$HOME/.config/systemd/user/$u" "$HOME/Library/LaunchAgents/$u.plist"; do
    [ -f "$f" ] && grep -qF -- "$PREFIX" "$f" && return 0
  done
  return 1
}

uninstall_services() {
  local unit="$SERVICE_UNIT" ufile plist
  if [ -z "$unit" ]; then unit="$(detect_service_unit)"; fi
  if [ -z "$unit" ] || ! unit_belongs "$unit"; then
    say "  services: none recorded for this install"
    uninstall_tailnet_forwarder
    return 0
  fi
  SERVICE_UNIT="$unit"
  case "$OS" in
    linux)
      if [ "$DRY_RUN" = 1 ]; then
        say "  would stop and disable service: $unit"
      else
        systemctl --user stop "$unit" >/dev/null 2>&1 || true
        systemctl --user disable "$unit" >/dev/null 2>&1 || true
        log "service: stopped and disabled $unit"
      fi
      ufile="$HOME/.config/systemd/user/$unit"
      if [ -f "$ufile" ]; then
        if [ "$DRY_RUN" = 1 ]; then
          say "  would remove: $ufile"
        else
          rm -f -- "$ufile" && log "removed unit file $ufile"
          systemctl --user daemon-reload >/dev/null 2>&1 || true
        fi
      fi
      ;;
    darwin)
      plist="$HOME/Library/LaunchAgents/$unit.plist"
      if [ "$DRY_RUN" = 1 ]; then
        say "  would bootout and disable service: $unit"
      else
        launchctl bootout "gui/$(id -u)/$unit" >/dev/null 2>&1 || true
        launchctl disable "gui/$(id -u)/$unit" >/dev/null 2>&1 || true
        log "service: booted out $unit"
      fi
      if [ -f "$plist" ]; then
        if [ "$DRY_RUN" = 1 ]; then say "  would remove: $plist"; else rm -f -- "$plist" && log "removed unit file $plist"; fi
      fi
      ;;
  esac
  uninstall_tailnet_forwarder
  return 0
}

uninstall_plan_lines() {
  local p
  if [ -z "$uninstall_plan" ]; then say "  (nothing)"; return 0; fi
  printf '%s\n' "$uninstall_plan" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    say "  - $p$(plan_size_suffix "$p")"
  done
  return 0
}

uninstall_kept_lines() {
  local p
  printf '%s\n' "$uninstall_kept" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    say "    - $p"
  done
  return 0
}

uninstall_outside_lines() {
  local l
  say "  outside traces this uninstall cannot remove:"
  printf '%s\n' "$uninstall_outside" | while IFS= read -r l; do
    [ -n "$l" ] || continue
    say "    - $l"
  done
  return 0
}

emit_uninstall_json() { # ok mode
  printf '{"ok": %s, "action": "uninstall", "mode": "%s", "dryRun": %s, "prefix": "%s", "dshHome": "%s", "binDir": "%s", "serviceUnit": "%s", "removed": %s, "kept": %s, "outsideTraces": %s}\n' \
    "$1" "$2" "$DRY_RUN" "$(json_escape "$PREFIX")" "$(json_escape "$DSH_HOME")" "$(json_escape "$BIN_DIR")" "$(json_escape "$SERVICE_UNIT")" \
    "$(printf '%s\n' "$uninstall_plan" | json_lines)" \
    "$(printf '%s\n' "$uninstall_kept" | json_lines)" \
    "$(printf '%s\n' "$uninstall_outside" | json_lines)"
}

do_uninstall() {
  local state="$PREFIX/harness/install-state.json" recorded_home mode answer removed p v
  detect_os_arch
  if [ -f "$state" ]; then
    if [ "$BIN_DIR_EXPLICIT" = 0 ]; then
      v="$(json_field "$state" binDir)"
      [ -n "$v" ] && BIN_DIR="$v"
    fi
    [ -n "$SERVICE_UNIT" ] || SERVICE_UNIT="$(json_field "$state" serviceUnit)"
    [ -n "$PROFILE" ] || PROFILE="$(json_field "$state" profile)"
    recorded_home="$(json_field "$state" dshHome)"
    if [ -n "$recorded_home" ] && [ "$recorded_home" != "$DSH_HOME" ]; then
      die "DSH_HOME mismatch: $state records dshHome='$recorded_home' but this invocation resolves DSH_HOME='$DSH_HOME'. Nothing was changed. Remedy: export DSH_HOME='$recorded_home' and re-run (or: DSH_HOME='$recorded_home' dsh uninstall ...)."
    fi
  fi
  [ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"
  [ -n "$PROFILE" ] || PROFILE=web
  resolve_home
  mode="keep-data"
  [ "$PURGE" = 1 ] && mode="purge"

  if [ "$PURGE" = 1 ]; then
    uninstall_guard "$PREFIX" "prefix"
    uninstall_guard "$DSH_HOME" "harness home"
    uninstall_guard "$BIN_DIR/dsh" "shim"
    uninstall_add "$PREFIX"
    [ "$DSH_HOME" != "$PREFIX" ] && uninstall_add "$DSH_HOME"
    uninstall_add "$BIN_DIR/dsh"
    uninstall_add "$BIN_DIR/ds"
    uninstall_add "$BIN_DIR/dsh-peer"
    uninstall_outside_add "shell rc PATH line (bash ~/.bash_profile|.bash_login|.profile + ~/.bashrc, zsh ~/.zshrc/.zprofile, fish config.fish; marker '# dsh installer')"
    uninstall_outside_add "fish function/completions (ds.fish under the fish config dir)"
    uninstall_outside_add "cloned harness repo (e.g. $HOME/enpoi-harness)"
    uninstall_outside_add "profile/dotfiles clone (e.g. $HOME/dotfiles/dsh-dotfiles)"
    uninstall_outside_add "browser localStorage for the Web UI origin (http://127.0.0.1:${DSH_WEB_PORT:-3080})"
    uninstall_outside_add "user systemd journal entries for the removed unit"
  else
    uninstall_guard "$PREFIX/harness" "harness dir"
    uninstall_guard "$BIN_DIR/dsh" "shim"
    uninstall_add "$PREFIX/harness"
    uninstall_add "$BIN_DIR/dsh"
    uninstall_add "$BIN_DIR/ds"
    uninstall_add "$BIN_DIR/dsh-peer"
    # The failing sudo stub is installer scaffolding, not user data; remove it
    # only while it is still the exact file sudo_trap wrote.
    if grep -qF "sudo is never used by this installer" "$PREFIX/bin/sudo" 2>/dev/null; then
      uninstall_add "$PREFIX/bin/sudo"
    fi
    uninstall_keep "$PREFIX/runtime (Node runtime cache)"
    uninstall_keep "$PREFIX/bin (pnpm)"
    uninstall_keep "$DSH_HOME (sessions, settings, credentials, overlay, profile)"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say "dsh uninstall --dry-run ($mode) — nothing is removed"
    uninstall_services
    say "  would remove:"
    uninstall_plan_lines
    if [ "$PURGE" = 1 ]; then
      uninstall_outside_lines
    else
      say "  would keep:"
      uninstall_kept_lines
    fi
    emit_uninstall_json 1 "$mode"
    return 0
  fi

  say "dsh uninstall ($mode)"
  uninstall_services
  say "  removing:"
  uninstall_plan_lines
  if [ "$PURGE" = 1 ]; then
    printf '%s: this PERMANENTLY removes the paths above. Type "purge" to confirm: ' "$SCRIPT_NAME" >&2
    answer=""
    IFS= read -r answer || answer=""
    if [ "$answer" != "purge" ]; then
      say "dsh uninstall aborted: typed confirmation 'purge' not given; nothing was removed"
      emit_uninstall_json 0 "$mode"
      return 1
    fi
  fi

  removed=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -e "$p" ] || [ -L "$p" ]; then
      if rm -rf -- "$p"; then log "removed $p"; removed=$((removed + 1)); else warn "could not remove $p"; fi
    else
      log "already absent: $p"
    fi
  done <<EOF
$uninstall_plan
EOF
  say ""
  say "dsh uninstall complete ($mode) — $removed path(s) removed"
  if [ "$PURGE" = 1 ]; then
    uninstall_outside_lines
  else
    say "  kept:      $DSH_HOME (sessions, settings, credentials, overlay, profile)"
    say "  kept:      $PREFIX/runtime, $PREFIX/bin, and $PREFIX/logs"
    say "  reinstall: re-run the installer — a re-install resumes this home"
  fi
  emit_uninstall_json 1 "$mode"
  return 0
}

# ── Defaults + dispatch ─────────────────────────────────────────────────────
# Sourcing with DSH_INSTALL_LIB_ONLY=1 defines the helpers and runs no mode;
# scratch-HOME tests of write_rc use it instead of re-implementing the logic.
# Never silent: an exported value must not masquerade as a successful install.
if [ "${DSH_INSTALL_LIB_ONLY:-0}" = 1 ]; then
  printf 'dsh-install: sourced as a library (DSH_INSTALL_LIB_ONLY=1); no install performed\n' >&2
  return 0 2>/dev/null || exit 0
fi
if [ -z "$PREFIX" ]; then PREFIX="$HOME/.dsh"; fi
if [ -z "$BIN_DIR" ]; then BIN_DIR="$HOME/.local/bin"; fi
if [ "$UPDATE_MODE" = 1 ] && { [ "$REPAIR_MODE" = 1 ] || [ "$UNINSTALL_MODE" = 1 ] || [ "$CLEAN_MODE" = 1 ]; }; then
  die "choose one of --update, --repair, --uninstall, --clean"
fi
if [ "$REPAIR_MODE" = 1 ] && { [ "$UNINSTALL_MODE" = 1 ] || [ "$CLEAN_MODE" = 1 ]; }; then
  die "choose one of --repair, --uninstall, --clean"
fi
if [ "$UNINSTALL_MODE" = 1 ] && [ "$CLEAN_MODE" = 1 ]; then
  die "choose one of --uninstall, --clean"
fi
if [ "$CHECK_ONLY" = 1 ] && [ "$REPAIR_MODE" != 1 ]; then
  die "--check applies to --repair only"
fi
if [ "$PURGE" = 1 ] && [ "$UNINSTALL_MODE" != 1 ]; then
  die "--purge applies to --uninstall only (run: --uninstall --purge)"
fi
if [ -n "$MERGE_BASELINE" ] && [ "$UPDATE_MODE" != 1 ]; then
  die "--merge-baseline applies to --update only"
fi
if [ "$CLEAN_MODE" = 1 ]; then
  do_clean
  exit $?
fi
if [ "$UPDATE_MODE" = 0 ] && [ "$REPAIR_MODE" = 0 ] && [ "$UNINSTALL_MODE" = 0 ]; then
  if [ -z "$CHANNEL" ]; then CHANNEL=stable; fi
  if [ -z "$PROFILE" ]; then PROFILE=web; fi
  if [ -n "$PROFILE_SOURCE" ]; then PROFILE_SOURCE_REQUIRED=1; fi
  if [ -z "$PROFILE_SOURCE" ] && [ "$PROFILE" = web ] && [ -n "$DEFAULT_PROFILE_SOURCE" ]; then
    PROFILE_SOURCE="$DEFAULT_PROFILE_SOURCE"
  fi
  apply_profile_ref_default 0
else
  if [ "$UPDATE_MODE" = 1 ]; then
    if [ -z "$CHANNEL" ]; then CHANNEL=stable; fi
    if [ -z "$PROFILE" ]; then PROFILE=web; fi
  fi
fi
if [ -n "$CHANNEL" ]; then
  case "$CHANNEL" in stable|beta) :;; *) die "unknown channel: $CHANNEL (stable|beta)";; esac
fi
case "$PREFIX" in /*) :;; *) die "--prefix must be an absolute path: $PREFIX";; esac
case "$BIN_DIR" in /*) :;; *) die "--bin-dir must be an absolute path: $BIN_DIR";; esac
if [ -z "$DSH_HOME" ]; then DSH_HOME="$HOME/.dsh"; fi
case "$DSH_HOME" in /*) :;; *) die "\$DSH_HOME/--dsh-home must be an absolute path: $DSH_HOME";; esac
export DSH_HOME

# The internal --service-guard mode: the detached verifier spawned by
# delegate_service_restart. Runs no install/update step; it waits for the
# delegated restart, confirms the unit is up, starts or bootstraps it when it
# is not, and records the outcome in <prefix>/logs/install.log.
if [ "$GUARD_MODE" = 1 ]; then
  [ -n "$SERVICE_UNIT" ] || die "--service-guard needs --service-unit"
  [ -n "$GUARD_HOME" ] && export HOME="$GUARD_HOME"
  detect_os_arch
  init_log_file
  do_service_guard
  exit $?
fi

if [ "$DRY_RUN" = 1 ] && [ "$UPDATE_MODE" = 0 ] && [ "$REPAIR_MODE" = 0 ] && [ "$UNINSTALL_MODE" = 0 ]; then
  detect_os_arch
  dry_run_plan
  exit 0
fi

if [ "$UPDATE_MODE" = 1 ]; then
  do_update
elif [ "$REPAIR_MODE" = 1 ]; then
  do_repair || exit 1
elif [ "$UNINSTALL_MODE" = 1 ]; then
  do_uninstall || exit 1
else
  do_install
fi
