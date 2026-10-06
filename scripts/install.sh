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
#   3. fetches the channel build (GitHub tarball for the channel ref, or
#      --source for a local path/tarball/URL) into  <prefix>/harness/<version>;
#   4. pnpm install --frozen-lockfile + pnpm run build (host), then the
#      profile's own plugin build when the profile ships one;
#   5. when --profile-source / DSH_PROFILE_SOURCE names the companion profile
#      (default: the Enpoi web profile repo for --profile web), fetches it at
#      the selected channel's ref into $DSH_HOME/profiles/<name> before the
#      template seed, seeds the shared settings/presets, and installs the
#      profile's dependencies; an explicit --profile-ref wins;
#   6. seeds $DSH_HOME from the shipped templates (initProfile path), installs
#      the `dsh` shim into ~/.local/bin, and prints the PATH line (only writes
#      the shell rc when --write-rc is given).
#
# Update is the same engine via `--update` (delegated by `dsh update`):
#   fetch -> install -> build -> migrations -> switch `current` -> service
#   restart (only when a unit for this install exists) -> projection backfill
#   (when present) -> self-check -> roll back to the previous versioned dir and
#   restore backups on failure. Idempotent, re-runnable.
#
# Rolling channels: stable/beta branches can advance without a version bump, so
# the update decision compares the target ref's commit SHA (git ls-remote, then
# the GitHub API) with the SHA the installed tree recorded at build time. When
# the branch moved, the build lands in `<version>-<short-sha>` so two builds of
# one semver never collide and `current` can roll back to the previous build.
#
# Invariants: the repo tree is pull-only and disposable; $DSH_HOME is only ever
# seeded (never overwritten); versioned dirs make rollback a symlink move.
# =============================================================================
set -u
set -o pipefail
umask 022

SCRIPT_NAME="dsh-install"
SCRIPT_REVISION="1"

# ── Distribution parameters (the public repo fills these) ───────────────────
DSH_GITHUB_REPO="${DSH_GITHUB_REPO:-Darthph0enix7/deepseek-harness}"
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
NO_PREBUILT=0
PREBUILT=0
MERGE_BASELINE=""
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
INSTALLED_COMMIT=""
TREE_DIR_NAME=""
PROFILE_REF_EXPLICIT=0
PROFILE_REF_DERIVED=0
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
      printf "\r  ${C_CYAN}%s${C_RESET} %s..." "${spin:$i:1}" "$desc" >&2
    fi
    sleep 0.25
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
  --no-prebuilt       always build from the source archive; skip the verified
                      GitHub Release prebuilt download (also DSH_NO_PREBUILT=1)
  --dsh-home DIR      harness home override (default: $DSH_HOME or $HOME/.dsh);
                      update fails loudly when it disagrees with install-state.json
  --merge-baseline F  run the profile's three-way merge engine against F
                      (timestamped backups; never fail closed)
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
  --write-rc          add the bin dir to the shell rc (~/.profile / fish config)
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
  DSH_NO_PREBUILT                    same as --no-prebuilt

Exit codes: 0 success, 1 failure (update rolls back first), 42 sudo trap fired.
USAGE
}

trap 'if [ -n "${STAGED:-}" ]; then rm -rf "$STAGED"; fi; if [ -n "${PROFILE_STAGE:-}" ]; then rm -rf "$PROFILE_STAGE"; fi' EXIT

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
    --no-service) SERVICE_INSTALL=0; shift;;
    --no-prebuilt) NO_PREBUILT=1; shift;;
    --dsh-home) need_value "$@"; DSH_HOME="$2"; shift 2;;
    --dsh-home=*) DSH_HOME="${arg#*=}"; shift;;
    --merge-baseline) need_value "$@"; MERGE_BASELINE="$2"; shift 2;;
    --merge-baseline=*) MERGE_BASELINE="${arg#*=}"; shift;;
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
  case "$(uname -s)" in
    Linux) OS=linux;;
    Darwin) OS=darwin;;
    *) die "unsupported OS: $(uname -s) — Linux and macOS only";;
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
      sha="$(GIT_TERMINAL_PROMPT=0 run_limited 30 git ls-remote "$url" "refs/tags/$ref" "refs/tags/$ref^{}" 2>/dev/null | awk 'NR==1 {print $1}')"
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
    || tar -xzf "$SOURCE" -C "$STAGED" \
    || { warn "could not extract $SOURCE"; return 1; }
  flatten_stage "$STAGED"
  return 0
}

stage_remote() { # url
  local url="$1" archive cache_dir cache_file
  cache_dir="$PREFIX/harness/.cache"
  mkdir -p "$cache_dir" || return 1
  local ref="${REF:-$CHANNEL}"
  cache_file="$cache_dir/archive-${ref}.tar.gz"
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
    if ! run_logged "Downloading release archive" "$dl_timeout" "$PREFIX" curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 30 "$url" -o "$archive"; then
      rm -f "$archive"
      # Fallback to git clone if curl download fails or times out
      if command -v git >/dev/null 2>&1; then
        log "direct archive download failed; falling back to shallow git clone ($ref)"
        substep_ok "Direct download timed out; falling back to git clone (${ref})"
        local git_url="${DSH_GITHUB_URL:-https://github.com/Darthph0enix7/deepseek-harness}"
        case "$git_url" in *.git) :;; *) git_url="$git_url.git";; esac
        rm -rf "$STAGED"
        if run_logged "Cloning release repository" 300 "$PREFIX" git clone --depth 1 --branch "$ref" "$git_url" "$STAGED"; then
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
# The release workflow publishes a per-platform, fully built harness tree
# (dsh-harness-<version>-<commit>-<os>-<arch>.tar.gz + .sha256) as GitHub
# Release assets. When the asset for this exact commit exists, installing it
# removes the pnpm install + full build (~5 minutes) and needs no build
# toolchain. The checksum is mandatory; any failure falls back to the source
# build with a warning, never to an unverified artifact.
sha256_of() { # file
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else printf ''; fi
}

stage_prebuilt() { # stages the verified prebuilt tree into $STAGED; 1 = fall back
  [ "${NO_PREBUILT:-0}" = 1 ] && return 1
  [ "${DSH_NO_PREBUILT:-0}" = 1 ] && return 1
  [ -n "$SOURCE" ] && return 1
  [ -n "${TARGET_COMMIT:-}" ] || return 1
  local ref="${REF:-$CHANNEL}" meta version asset url sha_url cache_dir asset_file expected actual staged_version
  meta="$(curl -fsSL --connect-timeout 10 --max-time 20 "$DSH_GITHUB_URL/raw/$ref/package.json" 2>/dev/null || true)"
  [ -n "$meta" ] || return 1
  version="$(printf '%s\n' "$meta" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || return 1
  asset="dsh-harness-$version-$TARGET_COMMIT-$OS-$ARCH.tar.gz"
  url="$DSH_GITHUB_URL/releases/download/v$version/$asset"
  sha_url="$url.sha256"
  cache_dir="$PREFIX/harness/.cache"
  asset_file="$cache_dir/$asset"
  mkdir -p "$cache_dir" || return 1
  if [ ! -s "$asset_file" ] || [ ! -s "$asset_file.sha256" ]; then
    rm -f "$asset_file" "$asset_file.sha256"
    log "prebuilt: fetching $asset"
    if ! run_logged "Downloading prebuilt harness ($OS-$ARCH)" "${DSH_PREBUILT_TIMEOUT:-900}" "$PREFIX" curl -fsSL --retry 2 --retry-delay 2 --connect-timeout 30 "$url" -o "$asset_file.download"; then
      rm -f "$asset_file.download"
      log "prebuilt: no asset for this commit; building from source"
      return 1
    fi
    mv "$asset_file.download" "$asset_file" || return 1
    if ! curl -fsSL --retry 1 --connect-timeout 20 "$sha_url" -o "$asset_file.sha256" 2>/dev/null; then
      rm -f "$asset_file" "$asset_file.sha256"
      warn "prebuilt: checksum file unavailable; falling back to the source build"
      return 1
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
  if [ "$staged_version" != "$version" ]; then
    warn "prebuilt: payload version '$staged_version' does not match '$version'; falling back to the source build"
    rm -rf "$STAGED"; STAGED=""
    return 1
  fi
  VERSION="$version"
  PREBUILT=1
  return 0
}

prepare_source() {
  if [ -z "$SOURCE" ]; then
    local ref="${REF:-$CHANNEL}"
    resolve_target_for_source
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
            VERSION="$(read_version "$d/package.json" 2>/dev/null || true)"
            if [ -n "$VERSION" ]; then
              TREE_DIR_NAME="$name"
              HARNESS="$d"
              substep_ok "Target build already complete: $TREE_DIR_NAME (reusing)"
              return 0
            fi
          fi
        fi
      done
    fi
    SOURCE_URL="$DSH_GITHUB_URL/archive/refs/heads/$ref.tar.gz"
    if stage_prebuilt; then
      substep_ok "Prebuilt harness reused for commit ${TARGET_COMMIT:0:7} ($OS-$ARCH)"
      return 0
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
    BUILD_COMMIT="${TARGET_COMMIT:-}"
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

# Fresh-home patch: strip everything that belongs to the configured machine.
strip_fresh_patch() { # patch-file
  local file="$1"
  strip_patch_rows "$file" agent-default-model ui-settings-general ui-settings-models ui-theme llm-pi-ai
  strip_patch_sections "$file" capabilities mcpServers mcpStatus personas roles councils chains \
    catalogRules uiPreferences permissions whiteboard toolGroups
  strip_onboarding_completed "$file"
  return 0
}

# Refuse to seed operator state. This is the same split the profile repo pins
# in packages/enpoi-capabilities/tests/profile-patch.spec.ts: a source tree
# that still carries the configured machine's rows after stripping is a
# packaging bug, and end-user installs must never inherit the operator's
# providers, default model, UI settings, seats, grants, or MCP catalog.
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
  for section in capabilities mcpServers mcpStatus personas roles councils chains catalogRules \
    uiPreferences permissions whiteboard toolGroups; do
    if awk -v key="$section" '
      /^- / { inorch = ($0 == "- id: enpoi-orchestration") }
      inorch && /^    [A-Za-z0-9_@.\/-]+:/ { k = $0; sub(/^    /, "", k); sub(/:.*/, "", k); if (k == key) found = 1 }
      END { exit found ? 0 : 1 }
    ' "$file"; then
      warn "profile patch carries operator-owned section '$section'"
      return 1
    fi
  done
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
      case "$rel" in cordis.patch.yml) continue;; esac
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

seed_profile_home() { # stage
  local stage="$1" fish_dir="$HOME/.config/fish"
  seed_file_once "$stage/fresh-settings.yaml" "$DSH_HOME/settings.yaml"
  seed_dir_once "$stage/presets" "$DSH_HOME/.agent-presets"
  # Shipped skills stay in the profile skills/ dir, which every preset mounts;
  # $DSH_HOME/skills holds only operator-created skills.
  seed_dir_once "$stage/skins" "$DSH_HOME/skins"
  seed_file_once "$stage/skin-center-active.json" "$DSH_HOME/skin-center-active.json"
  if [ -d "$fish_dir" ]; then
    seed_file_once "$stage/fish/ds.fish" "$fish_dir/functions/ds.fish"
    seed_file_once "$stage/fish/completions/ds.fish" "$fish_dir/completions/ds.fish"
  fi
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

prepare_profile() {
  if [ -z "$PROFILE_SOURCE" ] || [ "$PROFILE_SOURCE" = "$DEFAULT_PROFILE_SOURCE" ]; then
    if [ -n "${HARNESS:-}" ] && [ -d "$HARNESS/profile/$PROFILE" ]; then
      PROFILE_SOURCE="$HARNESS/profile/$PROFILE"
    fi
  fi
  [ -n "$PROFILE_SOURCE" ] || { log "profile source: none; shipped template only"; return 0; }
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
    return 0
  fi
  resolve_home
  [ -f "$PROFILE_DIR/package.json" ] && mode=refresh
  log "profile seed: $PROFILE_DIR ($mode)"
  if ! copy_profile_tree "$PROFILE_STAGE" "$PROFILE_DIR" "$mode"; then
    warn "profile seed did not complete for $PROFILE_DIR"
  fi
  seed_profile_home "$PROFILE_STAGE"
  rm -rf "$PROFILE_STAGE"; PROFILE_STAGE=""
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
    printf '  "serviceUnit": "%s",\n' "$(json_escape "$SERVICE_UNIT")"
    printf '  "updatedAt": "%s"\n' "$now"
    printf '}\n'
  } > "$tmp" || return 1
  mv "$tmp" "$file" || return 1
  return 0
}

write_rc() {
  local marker="# dsh installer" path_line="export PATH=\"$BIN_DIR:\$PATH\""
  local fish="$HOME/.config/fish/config.fish"

  append_rc_if_present() {
    local f="$1"
    [ -f "$f" ] || return 0
    if grep -qF "$marker" "$f"; then return 0; fi
    printf '\n%s\n%s\n' "$marker" "$path_line" >> "$f"
    log "added $BIN_DIR to $f"
  }

  # Standard POSIX login shell profile
  if [ -f "$HOME/.profile" ] && grep -qF "$marker" "$HOME/.profile"; then :; else
    printf '\n%s\n%s\n' "$marker" "$path_line" >> "$HOME/.profile"
    log "added $BIN_DIR to $HOME/.profile"
  fi

  # Bash login and interactive (Linux and macOS)
  append_rc_if_present "$HOME/.bashrc"
  append_rc_if_present "$HOME/.bash_profile"

  # Zsh (macOS default login shell since Catalina, also common on Linux)
  if [ "$OS" = darwin ] || [ -f "$HOME/.zshrc" ] || [ "${SHELL:-}" = "*/zsh" ]; then
    touch "$HOME/.zshrc" 2>/dev/null || true
    append_rc_if_present "$HOME/.zshrc"
  fi
  append_rc_if_present "$HOME/.zprofile"

  # Fish shell
  if [ -f "$fish" ] && ! grep -qF "$marker" "$fish"; then
    printf '\n%s\nfish_add_path "%s"\n' "$marker" "$BIN_DIR" >> "$fish"
    log "added $BIN_DIR to $fish"
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
    darwin) launchctl kickstart -k "gui/$(id -u)/$SERVICE_UNIT" || warn "service restart failed";;
  esac
  return 0
}

ensure_service() {
  if [ "${SERVICE_INSTALL:-1}" != 1 ] || [ "${DSH_NO_SERVICE:-0}" = 1 ]; then
    log "service: install disabled; leaving any existing unit untouched"
    return 0
  fi
  if [ -n "$SERVICE_UNIT" ]; then
    log "service: unit $SERVICE_UNIT already references this install"
    return 0
  fi
  local cli="$HARNESS/apps/cli/lib/bin.js" out
  [ -f "$cli" ] || { warn "service: no CLI at $cli; skipping service install"; return 0; }
  log "service: installing the background web service (login persistence)"
  if out="$("$NODE" "$cli" service install 2>&1)"; then
    SERVICE_UNIT="$(json_field "$PREFIX/harness/install-state.json" serviceUnit)"
    substep_ok "Background service installed and started${SERVICE_UNIT:+ ($SERVICE_UNIT)}"
  else
    warn "service: install failed ($(printf '%s' "$out" | tail -n 1)); run 'dsh service install' manually"
  fi
  return 0
}

find_backfill() {
  local c
  for c in "$HARNESS/scripts/dsh-projections-backfill.mjs" "$PROFILE_DIR/scripts/dsh-projections-backfill.mjs" "$HOME/.local/bin/dsh-projections-backfill.mjs"; do
    if [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 0
}

run_backfill() {
  local b
  b="$(find_backfill)"
  if [ -z "$b" ]; then
    BACKFILL="skipped (not present)"
    log "projection backfill: not present; skipping"
    return 0
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
  local b="$1" f rel
  for f in "$DSH_HOME/settings.yaml" "$DSH_HOME/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_DIR/package.json" "$DSH_HOME/sync-local.yaml"; do
    [ -f "$f" ] || continue
    rel="${f#/}"
    mkdir -p "$b/root/$(dirname "$rel")" 2>/dev/null || continue
    cp -p "$f" "$b/root/$rel" 2>/dev/null || true
  done
  return 0
}

restore_user_files() { # dir
  local b="$1" f rel failed=0 total=0
  [ -d "$b/root" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    total=$((total + 1))
    rel="${f#"$b"/root/}"
    if ! mkdir -p "$(dirname "/$rel")"; then
      printf '%s: ERROR: cannot create %s while restoring /%s\n' "$SCRIPT_NAME" "$(dirname "/$rel")" "$rel" >&2
      failed=$((failed + 1))
      continue
    fi
    if cp -p "$f" "/$rel"; then
      log "restored /$rel"
    else
      printf '%s: ERROR: could not restore /%s from %s\n' "$SCRIPT_NAME" "$rel" "$f" >&2
      failed=$((failed + 1))
    fi
  done <<EOF
$(find "$b/root" -type f 2>/dev/null)
EOF
  if [ "$failed" -gt 0 ]; then
    printf '%s: ERROR: rollback restore is INCOMPLETE: %s of %s backed-up file(s) were not restored; the active config may mix old and new files. Restore them manually from %s/root/ (paths there mirror /).\n' \
      "$SCRIPT_NAME" "$failed" "$total" "$b" >&2
    return 1
  fi
  return 0
}

write_diagnostics() { # status
  local dir="$DSH_HOME/diagnostics" status="$1"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '{"ts":"%s","action":"update","from":"%s","to":"%s","status":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "$PREV_VERSION")" "$(json_escape "$VERSION")" "$(json_escape "$status")" \
    >> "$dir/update.jsonl" 2>/dev/null || true
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
    patch="$PROFILE_DIR/device-patches/$(hostname).yaml"
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
    DSH_HOME="$DSH_HOME" run_limited 300 "$NODE" "$m" >&2 || warn "migration $m failed (never fail closed; continuing)"
  done
  write_diagnostics migrated
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
  overlay="$PROFILE_DIR/device-patches/$(hostname 2>/dev/null || printf 'this-host')"
  say ""
  say "${C_GREEN}${C_BOLD}╭─────────────────────────────────────────────────────────────╮${C_RESET}"
  box_row "  ${C_BOLD}Enpoi Harness successfully ${action}ed!${C_RESET}" "${C_GREEN}"
  box_row "" "${C_GREEN}"
  box_row "  ${C_BOLD}Version:${C_RESET}   ${VERSION} (${CHANNEL:-stable})" "${C_GREEN}"
  box_row "  ${C_BOLD}Location:${C_RESET}  ${PREFIX}" "${C_GREEN}"
  box_row "  ${C_BOLD}Commands:${C_RESET}  dsh, ds" "${C_GREEN}"
  box_row "  ${C_BOLD}Duration:${C_RESET}  $(elapsed_human)" "${C_GREEN}"
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
    *) say "  ${C_YELLOW}!${C_RESET} ${C_BOLD}Note:${C_RESET} Add ${BIN_DIR} to your PATH (e.g. source ~/.bashrc or ~/.zshrc)";;
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
  if [ -n "$SOURCE" ]; then say "  source:    $SOURCE"; else say "  source:    $DSH_GITHUB_URL/archive/refs/heads/$ref.tar.gz"; fi
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
  say "  steps:     fetch -> pnpm install --frozen-lockfile -> pnpm run build"
  say "             -> fetch+seed profile (if a source is set) -> seed \$DSH_HOME (initProfile)"
  say "             -> profile deps (pnpm install) -> profile plugin build (if present)"
  say "             -> shim $BIN_DIR/dsh -> install-state.json"
  [ "$WRITE_RC" = 1 ] && say "  rc:        would add the PATH line to ~/.profile / fish config"
  [ "$UPDATE_MODE" = 1 ] && say "  update:    migrations -> switch current -> service (if unit) -> backfill (if present) -> self-check -> rollback on failure"
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
  substep_ok "Target version: $VERSION${TARGET_COMMIT:+ (commit ${TARGET_COMMIT:0:7})}"

  TREE_DIR_NAME="$VERSION"
  if [ -n "$TARGET_COMMIT" ]; then
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
    if [ -n "$STAGED" ]; then rm -rf "$STAGED"; STAGED=""; fi
  else
    install_tree || die "install/build failed; no changes were made to \$DSH_HOME (tree: $HARNESS)"
  fi
  ln -sfn "$TREE_DIR_NAME" "$PREFIX/harness/current" || die "could not point $PREFIX/harness/current at $TREE_DIR_NAME"

  step "Configuring Enpoi profile & plugins"
  prepare_profile
  seed_home
  profile_install || die "profile dependency install failed"
  run_profile_plugin_build || die "profile plugin build failed"

  step "Configuring CLI shims & shell environment"
  write_shim || die "could not write the dsh shim into $BIN_DIR"
  substep_ok "Installed launcher: $BIN_DIR/dsh, $BIN_DIR/ds"
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
  write_state || warn "could not record the service unit in install-state.json"
  print_summary install
  maybe_open_browser_when_up "$(web_url)"
  emit_json install 1
  return 0
}

# ── Update ──────────────────────────────────────────────────────────────────
rollback() { # prev backup failed_version
  local prev="$1" backup="$2" failed="$3" restore_rc=0
  warn "rolling back to $prev"
  ln -sfn "$prev" "$PREFIX/harness/current" 2>/dev/null || warn "could not repoint $PREFIX/harness/current"
  restore_user_files "$backup" || restore_rc=1
  if [ -d "$PREFIX/harness/$failed" ]; then
    mv "$PREFIX/harness/$failed" "$PREFIX/harness/$failed.failed-$(date +%Y%m%d-%H%M%S)" 2>/dev/null \
      || warn "could not archive the failed tree $PREFIX/harness/$failed"
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
    return 1
  fi
  write_diagnostics rolled-back
  emit_json update 0
  say ""
  say "dsh update FAILED; rolled back to ${prev} (previous tree self-check: $([ "$prev_ok" = 0 ] && printf 'ok' || printf 'failed'))"
  say "  active:  $PREFIX/harness/current -> $(readlink "$PREFIX/harness/current" 2>/dev/null || printf '?')"
  say "  failed:  $PREFIX/harness/$failed.failed-*"
  say "  backups: $backup"
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

  # 4. Clean incomplete harness version directories (missing .dsh-install-complete)
  for d in "$PREFIX/harness"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ ! -f "$d/.dsh-install-complete" ]; then
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

do_clean() {
  init_log_file
  detect_os_arch
  resolve_home
  say "${C_BOLD}Enpoi Harness — System Cleanup${C_RESET}"
  say "Cleaning build artifacts, failed updates, and temporary files under ${PREFIX}..."
  say ""

  local freed=0 count=0 f d p sz name

  # 1. Prune all .failed-* directories
  for f in "$PREFIX/harness"/*.failed-*; do
    [ -d "$f" ] || continue
    sz="$(du -sk "$f" 2>/dev/null | awk '{print $1}')"
    sz="${sz:-0}"
    if rm -rf "$f" 2>/dev/null; then
      count=$((count + 1))
      freed=$((freed + sz))
      say "  ${C_GREEN}✓${C_RESET} Removed failed tree: $(basename "$f")"
    fi
  done

  # 2. Prune incomplete harness version trees (missing .dsh-install-complete)
  for d in "$PREFIX/harness"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ ! -f "$d/.dsh-install-complete" ]; then
      sz="$(du -sk "$d" 2>/dev/null | awk '{print $1}')"
      sz="${sz:-0}"
      if rm -rf "$d" 2>/dev/null; then
        count=$((count + 1))
        freed=$((freed + sz))
        say "  ${C_GREEN}✓${C_RESET} Removed incomplete version tree: $name"
      fi
    fi
  done

  # 3. Prune staging, download, and backup directories
  for p in "$PREFIX/harness"/.staging-* "$PREFIX/harness"/.profile-staging-* "$PREFIX/harness"/.download-* "$PREFIX/harness"/.backup-* "$PREFIX/harness"/*.replaced-*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    sz="$(du -sk "$p" 2>/dev/null | awk '{print $1}')"
    sz="${sz:-0}"
    if rm -rf -- "$p" 2>/dev/null; then
      count=$((count + 1))
      freed=$((freed + sz))
      say "  ${C_GREEN}✓${C_RESET} Removed staging artifact: $(basename "$p")"
    fi
  done

  # 4. Prune download archive cache
  if [ -d "$PREFIX/harness/.cache" ]; then
    sz="$(du -sk "$PREFIX/harness/.cache" 2>/dev/null | awk '{print $1}')"
    sz="${sz:-0}"
    if rm -rf "$PREFIX/harness/.cache" 2>/dev/null; then
      count=$((count + 1))
      freed=$((freed + sz))
      say "  ${C_GREEN}✓${C_RESET} Cleared release archive cache"
    fi
  fi

  # 5. Prune temporary node runtime staging
  for p in "$PREFIX/runtime"/.node-tmp-*; do
    [ -e "$p" ] || continue
    sz="$(du -sk "$p" 2>/dev/null | awk '{print $1}')"
    sz="${sz:-0}"
    if rm -rf -- "$p" 2>/dev/null; then
      count=$((count + 1))
      freed=$((freed + sz))
      say "  ${C_GREEN}✓${C_RESET} Removed runtime staging: $(basename "$p")"
    fi
  done

  # 6. Prune temp profile build directories
  for p in "${TMPDIR:-/tmp}"/dsh-profile-build.* "${TMPDIR:-/tmp}"/dsh-install-*; do
    [ -d "$p" ] || continue
    rm -rf -- "$p" 2>/dev/null
  done

  local freed_mb=$(( freed / 1024 ))
  say ""
  say "${C_GREEN}${C_BOLD}Cleanup complete!${C_RESET} Removed ${count} item(s), freed ~${freed_mb}MB."
  say "User data in ${DSH_HOME} (sessions, settings, credentials) was left completely intact."
  return 0
}

do_update() {
  local state="$PREFIX/harness/install-state.json" current backup rc recorded_home installed_version
  STEP_TOTAL=8
  [ -f "$state" ] || die "no install state at $state; run the installer first"
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
  if [ -z "$BIN_DIR" ]; then BIN_DIR="$(json_field "$state" binDir)"; [ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"; fi
  if [ -z "$SERVICE_UNIT" ]; then SERVICE_UNIT="$(json_field "$state" serviceUnit)"; fi
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
  # The active tree's own semver and recorded build commit. The directory name
  # may carry a short-SHA suffix after a rolling rebuild; the manifest does not.
  installed_version="$(read_version "$PREFIX/harness/$current/package.json" 2>/dev/null || true)"
  [ -n "$installed_version" ] || installed_version="$(json_field "$state" version)"
  INSTALLED_COMMIT="$(installed_tree_commit "$PREFIX/harness/$current")"
  if [ "$DRY_RUN" = 1 ]; then
    local target_value="" dry_target_commit=""
    if [ -z "$SOURCE" ]; then
      say "  source:   $DSH_GITHUB_URL/archive/refs/heads/${REF:-$CHANNEL}.tar.gz (version resolved at fetch time)"
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
        say "  commit:   $dry_target_commit (rolling rebuild -> ${target_value:-<version>}-$(printf '%s' "$dry_target_commit" | cut -c1-7))"
      fi
    fi
    [ -n "$target_value" ] && say "  target:   $target_value"
    if [ -n "$PROFILE_SOURCE" ]; then say "  profile:  $PROFILE (source: $PROFILE_SOURCE${PROFILE_REF:+, ref: $PROFILE_REF})"; else say "  profile:  $PROFILE (no recorded source)"; fi
    say "  steps:    fetch -> install+build -> profile refresh+deps -> migrations -> switch current -> service restart ($([ -n "$SERVICE_UNIT" ] && printf '%s' "$SERVICE_UNIT" || printf 'none recorded')) -> backfill -> self-check"
    say "  rollback: current link + user-file backups would be restored on failure"
    emit_json update 1
    return 0
  fi
  sudo_trap
  # Disk hygiene before fetching: failed trees are never keep-eligible, so
  # reclaim them before the new tree needs the space.
  prune_failed_versions
  log "update: active $current on the $CHANNEL channel"
  step "source: ${SOURCE:-$CHANNEL channel archive}"
  prepare_source
  resolve_target_for_source
  log "update target: $VERSION${TARGET_COMMIT:+ (commit ${TARGET_COMMIT})}"
  TREE_DIR_NAME="$VERSION"

  # Same semver on a rolling channel: the version is identical but the branch
  # may have advanced. Only a matching recorded commit is "up to date"; a moved
  # target rebuilds into <version>-<short-sha> so two builds of one semver do
  # not collide and rollback can point back at the previous build. An
  # unresolvable target (no git, no network) keeps the version-only behavior.
  if [ "$VERSION" = "$installed_version" ] && [ "$FORCE" != 1 ] \
    && { [ -z "$TARGET_COMMIT" ] || commit_same "$TARGET_COMMIT" "$INSTALLED_COMMIT"; }; then
    # The no-op path self-checks the ACTIVE tree, whose directory may carry a
    # short-SHA suffix after an earlier rolling rebuild.
    HARNESS="$PREFIX/harness/$current"
    if [ -z "$PNPM" ] && [ -x "$PREFIX/bin/pnpm" ]; then PNPM="$PREFIX/bin/pnpm"; fi
    log "already up to date at $VERSION; nothing to fetch/build"
    if [ -n "$STAGED" ]; then rm -rf "$STAGED"; STAGED=""; fi
    step "pnpm: present (nothing to rebuild)"
    step "dependencies and build: already up to date at $VERSION"
    step "profile: $PROFILE (refresh)"
    prepare_profile
    step "home: seeding $DSH_HOME and profile dependencies"
    seed_home
    profile_install || warn "profile dependency refresh failed"
    run_profile_plugin_build || warn "profile plugin build failed"
    ensure_service
    step "switch, service and backfill: $VERSION already active"
    step "self-check"
    if ! selfcheck; then
      warn "self-check of the active tree failed"
      emit_json noop 0
      exit 1
    fi
    say "dsh is already up to date: $VERSION ($CHANNEL channel)"
    emit_json noop 1
    return 0
  fi
  if [ "$VERSION" = "$installed_version" ] && [ -n "$TARGET_COMMIT" ] \
    && ! commit_same "$TARGET_COMMIT" "$INSTALLED_COMMIT"; then
    local short
    short="$(printf '%s' "$TARGET_COMMIT" | cut -c1-7)"
    TREE_DIR_NAME="$VERSION-$short"
    log "rolling channel advanced: recorded ${INSTALLED_COMMIT:-<none>} -> target $short; building into $TREE_DIR_NAME"
  fi
  HARNESS="$PREFIX/harness/$TREE_DIR_NAME"
  if ver_lt "$VERSION" "$installed_version" && [ "$FORCE_DOWNGRADE" != 1 ]; then
    die "refusing to downgrade from ${installed_version:-$current} to $VERSION without --force-downgrade"
  fi

  step "pnpm: corepack"
  setup_pnpm || die "could not enable pnpm through corepack"
  backup="$PREFIX/harness/.backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup" 2>/dev/null || warn "could not create backup dir $backup"
  backup_user_files "$backup"
  log "user-file backups: $backup"

  step "dependencies and build (this takes a few minutes)"
  if ! install_tree; then
    warn "update failed before switching; $current remains active"
    write_diagnostics install-failed
    emit_json update 0
    exit 1
  fi
  step "profile: $PROFILE"
  prepare_profile
  step "home, dependencies and migrations"
  if ! run_migrations; then
    warn "migrations failed before switching; $current remains active"
    write_diagnostics migrations-failed
    emit_json update 0
    exit 1
  fi

  step "switch, service and backfill"
  ln -sfn "$TREE_DIR_NAME" "$PREFIX/harness/current" || die "could not switch $PREFIX/harness/current to $TREE_DIR_NAME"
  log "switched current -> $TREE_DIR_NAME"
  restart_service
  ensure_service
  run_backfill

  step "self-check"
  if ! selfcheck; then
    rollback "$current" "$backup" "$TREE_DIR_NAME"
    exit 1
  fi
  write_state || warn "could not write $state"
  prune_versions "$TREE_DIR_NAME" "$current"
  print_summary update
  emit_json update 1
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
  local target cand d name v shim unit en st code port url p pid b l rc
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
  fish_dir="$HOME/.config/fish"
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
    uninstall_outside_add "shell rc PATH line (~/.profile or ~/.config/fish/config.fish, marker '# dsh installer')"
    uninstall_outside_add "fish function/completions (~/.config/fish/functions/ds.fish, ~/.config/fish/completions/ds.fish)"
    uninstall_outside_add "cloned harness repo (e.g. $HOME/deepseek-harness)"
    uninstall_outside_add "profile/dotfiles clone (e.g. $HOME/dotfiles/dsh-dotfiles)"
    uninstall_outside_add "browser localStorage for the Web UI origin (http://127.0.0.1:${DSH_WEB_PORT:-3080})"
    uninstall_outside_add "user systemd journal entries for the removed unit"
  else
    uninstall_guard "$PREFIX/harness" "harness dir"
    uninstall_guard "$BIN_DIR/dsh" "shim"
    uninstall_add "$PREFIX/harness"
    uninstall_add "$BIN_DIR/dsh"
    uninstall_add "$BIN_DIR/ds"
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
    say "  kept:      $PREFIX/runtime and $PREFIX/bin"
    say "  reinstall: re-run the installer — a re-install resumes this home"
  fi
  emit_uninstall_json 1 "$mode"
  return 0
}

# ── Defaults + dispatch ─────────────────────────────────────────────────────
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
if [ "$CHECK_ONLY" = 1 ] && { [ "$UNINSTALL_MODE" = 1 ] || [ "$CLEAN_MODE" = 1 ]; }; then
  die "--check applies to --repair, not --clean or --uninstall"
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
if [ -z "$DSH_HOME" ]; then DSH_HOME="$HOME/.dsh"; fi
export DSH_HOME

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
