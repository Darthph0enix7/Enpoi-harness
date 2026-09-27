#!/usr/bin/env bash
# =============================================================================
# dsh — one-line installer and mechanical updater (Linux + macOS, no sudo)
#
#   curl -fsSL <raw-url>/scripts/install.sh | bash
#   ./scripts/install.sh [--source PATH|URL] [--prefix DIR] [--channel stable|beta]
#   dsh update [--dry-run] [--channel stable|beta] [--json]
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
#      (default: the Enpoi web profile repo for --profile web), fetches it into
#      $DSH_HOME/profiles/<name> before the template seed, seeds the shared
#      settings/presets/skills, and installs the profile's dependencies;
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
PROFILE_BUILD_TIMEOUT="${DSH_PROFILE_BUILD_TIMEOUT:-1200}"
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
SERVICE_UNIT=""
MERGE_BASELINE=""
WRITE_RC=0
DRY_RUN=0
FORCE=0
FORCE_DOWNGRADE=0
JSON_OUT=0
UPDATE_MODE=0

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
PREV_VERSION=""
CHECK_VERSION=0
CHECK_HELP=0
CHECK_SMOKE=0
CHECK_AUDIT="skipped"
ROLLED_BACK=0

log() { printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2; }
warn() { printf '%s: WARNING: %s\n' "$SCRIPT_NAME" "$*" >&2; }
die() { printf '%s: ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
say() {
  if [ "$JSON_OUT" = 1 ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi
}

usage() {
  cat <<'USAGE'
dsh installer — installs or updates a dsh build without sudo.

Usage:
  install.sh [options]                 install (or refresh) the channel build
  install.sh --update [options]        mechanical update of an existing install

Options:
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
  --profile-ref REF   git ref fetched from a git profile source (default: HEAD)
  --service-unit U    systemd user unit / launchd label to restart on update
                      (default: auto-detected only when it references --prefix)
  --merge-baseline F  run the profile's three-way merge engine against F
                      (timestamped backups; never fail closed)
  --update            mechanical update: install, migrate, switch, self-check,
                      roll back to the previous versioned dir on failure
  --dry-run           print the plan and exit; writes nothing
  --force             rebuild/reinstall even when the version is already present
  --force-downgrade   allow a downgrade to an older version
  --write-rc          add the bin dir to the shell rc (~/.profile / fish config)
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
    --bin-dir) need_value "$@"; BIN_DIR="$2"; shift 2;;
    --bin-dir=*) BIN_DIR="${arg#*=}"; shift;;
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
    --profile-ref) need_value "$@"; PROFILE_REF="$2"; shift 2;;
    --profile-ref=*) PROFILE_REF="${arg#*=}"; shift;;
    --service-unit) need_value "$@"; SERVICE_UNIT="$2"; shift 2;;
    --service-unit=*) SERVICE_UNIT="${arg#*=}"; shift;;
    --merge-baseline) need_value "$@"; MERGE_BASELINE="$2"; shift 2;;
    --merge-baseline=*) MERGE_BASELINE="${arg#*=}"; shift;;
    --update) UPDATE_MODE=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --force) FORCE=1; shift;;
    --force-downgrade) FORCE_DOWNGRADE=1; shift;;
    --write-rc) WRITE_RC=1; shift;;
    --json) JSON_OUT=1; shift;;
    -h|--help) usage; exit 0;;
    --) shift; break;;
    *) die "unknown option: $arg (see --help)";;
  esac
done

# ── Portable helpers ────────────────────────────────────────────────────────
run_limited() {
  local seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$seconds" "$@"
  else "$@"; fi
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

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
  curl -fsSL --retry 2 --connect-timeout 20 "$url" -o "$tmp/$tarball" || { warn "Node download failed: $url"; rm -rf "$tmp"; return 1; }
  if curl -fsSL --retry 1 "$url.sha256" -o "$tmp/$tarball.sha256" 2>/dev/null; then
    expected="$(awk '{print $1}' "$tmp/$tarball.sha256")"
    if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"
    else actual=""; fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      warn "Node tarball checksum mismatch"; rm -rf "$tmp"; return 1
    fi
  fi
  tar -xzf "$tmp/$tarball" -C "$tmp" || { rm -rf "$tmp"; return 1; }
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
    NODE="$cand"; NODE_ORIGIN="PATH"; return 0
  fi
  cand="$PREFIX/runtime/node/current/bin/node"
  if [ -x "$cand" ] && node_at_least "$cand" "$DSH_MIN_NODE_MAJOR" "$DSH_MIN_NODE_MINOR"; then
    NODE="$cand"; NODE_ORIGIN="prefix runtime"; return 0
  fi
  cand="$PREFIX/runtime/node/$DSH_NODE_VERSION/bin/node"
  if [ -x "$cand" ] && node_at_least "$cand" "$DSH_MIN_NODE_MAJOR" "$DSH_MIN_NODE_MINOR"; then
    NODE="$cand"; NODE_ORIGIN="prefix runtime"; return 0
  fi
  if [ "$allow_fetch" = 1 ] && fetch_node; then
    NODE="$PREFIX/runtime/node/$DSH_NODE_VERSION/bin/node"; NODE_ORIGIN="downloaded"; return 0
  fi
  return 1
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
    run_limited 300 "$nbin/npm" install --global --prefix "$cc_dir" corepack@latest >&2 || return 1
    corepack_bin="$cc_dir/bin/corepack"
  fi
  [ -x "$corepack_bin" ] || { warn "no corepack available next to $NODE"; return 1; }
  run_limited 120 "$corepack_bin" enable --install-directory "$PREFIX/bin" pnpm >&2 || return 1
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
        BUILD_COMMIT="$(printf '%s' "$raw" | head -n 5 | awk -F'"' '/"sha":/ {print $4; exit}')"
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
  local url="$1" archive
  STAGED="$PREFIX/harness/.staging-$$"
  archive="$PREFIX/harness/.download-$$.tar.gz"
  mkdir -p "$STAGED" || return 1
  log "fetching $url"
  curl -fsSL --retry 2 --connect-timeout 20 "$url" -o "$archive" || { warn "download failed: $url"; rm -f "$archive"; return 1; }
  tar -xzf "$archive" -C "$STAGED" --strip-components=1 || { warn "could not extract $url"; rm -f "$archive"; return 1; }
  rm -f "$archive"
  flatten_stage "$STAGED"
  return 0
}

prepare_source() {
  if [ -z "$SOURCE" ]; then
    local ref="${REF:-$CHANNEL}"
    SOURCE_URL="$DSH_GITHUB_URL/archive/refs/heads/$ref.tar.gz"
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
install_tree() { # installs $VERSION into $PREFIX/harness/$VERSION; returns nonzero on failure
  local displaced=""
  HARNESS="$PREFIX/harness/$VERSION"
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
  log "pnpm install --frozen-lockfile in $HARNESS (minutes)"
  if ! ( cd "$HARNESS" && run_limited "$INSTALL_TIMEOUT" "$PNPM" install --frozen-lockfile ) >&2; then
    warn "pnpm install failed"
    if [ -n "$displaced" ]; then rm -rf "$HARNESS"; mv "$displaced" "$HARNESS" 2>/dev/null || true; fi
    return 1
  fi
  resolve_build_commit
  if [ -n "$BUILD_COMMIT" ]; then export DSH_CLIENT_COMMIT_HASH="$BUILD_COMMIT"; fi
  if [ "$BUILD_DIRTY" = true ]; then export DSH_CLIENT_GIT_DIRTY=true; fi
  log "pnpm run build in $HARNESS (this can take many minutes)"
  if ! ( cd "$HARNESS" && run_limited "$BUILD_TIMEOUT" "$PNPM" run build ) >&2; then
    warn "build failed"
    if [ -n "$displaced" ]; then rm -rf "$HARNESS"; mv "$displaced" "$HARNESS" 2>/dev/null || true; fi
    return 1
  fi
  printf '{"version": "%s", "installedAt": "%s"}\n' "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HARNESS/.dsh-install-complete" || return 1
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
  log "seeding $DSH_HOME from the shipped templates (profile: $PROFILE)"
  run_limited 300 "$NODE" "$HARNESS/apps/cli/lib/bin.js" --profile "$PROFILE" --dump-default-config >/dev/null 2>&1 \
    || warn "profile seed for '$PROFILE' did not complete (continuing; existing files are never touched)"
  return 0
}

run_profile_plugin_build() {
  local script="$PROFILE_DIR/build-plugins.sh"
  if [ -f "$script" ]; then
    log "profile plugin build: $script"
    ( cd "$PROFILE_DIR" && run_limited "$PROFILE_BUILD_TIMEOUT" bash "$script" "$PROFILE_DIR" ) >&2 || { warn "profile plugin build failed"; return 1; }
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

copy_profile_tree() { # src dst mode(seed|refresh)
  # seed: first install, all shipped files land (the dir is fresh).
  # refresh: user state survives — settings.yaml, cordis.patch.yml (the
  # config-editor document), device-patches/, node_modules/, backups.
  local src="$1" dst="$2" mode="${3:-seed}" rel d
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    case "$rel" in
      .git|.git/*|node_modules|node_modules/*|*/node_modules|*/node_modules/*) continue;;
      .backup-*|.backup-*/*) continue;;
      settings.yaml|device-patches|device-patches/*) continue;;
      fresh-settings.yaml|fish|fish/*|presets|presets/*|skills|skills/*|systemd|systemd/*) continue;;
    esac
    if [ "$mode" = refresh ]; then
      case "$rel" in cordis.patch.yml) continue;; esac
    fi
    d="$dst/$rel"
    if [ -d "$src/$rel" ]; then
      mkdir -p "$d" || return 1
    else
      mkdir -p "$(dirname "$d")" || return 1
      cp -p "$src/$rel" "$d" || return 1
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
  seed_dir_once "$stage/skills" "$DSH_HOME/skills"
  if [ -d "$fish_dir" ]; then
    seed_file_once "$stage/fish/ds.fish" "$fish_dir/functions/ds.fish"
    seed_file_once "$stage/fish/completions/ds.fish" "$fish_dir/completions/ds.fish"
  fi
  return 0
}

prepare_profile() {
  [ -n "$PROFILE_SOURCE" ] || { log "profile source: none; shipped template only"; return 0; }
  local kind rc=0 mode=seed
  kind="$(profile_source_kind "$PROFILE_SOURCE")"
  log "profile source: $PROFILE_SOURCE ($kind)"
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
  log "profile deps: pnpm install in $PROFILE_DIR (minutes)"
  if ! ( cd "$PROFILE_DIR" && run_limited "$PROFILE_INSTALL_TIMEOUT" "$PNPM" install ) >&2; then
    warn "profile pnpm install failed"
    return 1
  fi
  return 0
}

# ── Shim, state, rc ─────────────────────────────────────────────────────────
write_shim() {
  local body tmp
  mkdir -p "$BIN_DIR" || return 1
  body=$(cat <<'SHIM'
#!/usr/bin/env bash
# dsh — launcher shim generated by the dsh installer. Re-run the installer to
# regenerate. `dsh update` delegates to the mechanical updater.
set -euo pipefail
PREFIX="__PREFIX__"
CURRENT="$PREFIX/harness/current"
if [ ! -d "$CURRENT" ]; then
  echo "dsh: no installed harness under $PREFIX/harness; re-run the installer" >&2
  exit 1
fi
if [ "${1:-}" = "update" ]; then
  shift
  exec "$CURRENT/scripts/update.sh" --prefix "$PREFIX" "$@"
fi
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
)
  body="${body//__PREFIX__/$PREFIX}"
  body="${body//__NODE__/$NODE}"
  tmp="$BIN_DIR/.dsh.tmp.$$"
  printf '%s\n' "$body" > "$tmp" || return 1
  chmod +x "$tmp" || return 1
  mv "$tmp" "$BIN_DIR/dsh" || return 1
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
    printf '  "channel": "%s",\n' "$(json_escape "$CHANNEL")"
    printf '  "ref": "%s",\n' "$(json_escape "${REF:-$CHANNEL}")"
    printf '  "source": "%s",\n' "$(json_escape "$SOURCE")"
    printf '  "sourceUrl": "%s",\n' "$(json_escape "$SOURCE_URL")"
    printf '  "profile": "%s",\n' "$(json_escape "$PROFILE")"
    printf '  "profileSource": "%s",\n' "$(json_escape "$PROFILE_SOURCE")"
    printf '  "profileRef": "%s",\n' "$(json_escape "$PROFILE_REF")"
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
  local profile_file="$HOME/.profile" fish="$HOME/.config/fish/config.fish" marker="# dsh installer"
  if [ -f "$profile_file" ] && grep -qF "$marker" "$profile_file"; then :; else
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$BIN_DIR" >> "$profile_file"
    log "added $BIN_DIR to $profile_file"
  fi
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
  local b="$1" f rel
  [ -d "$b/root" ] || return 0
  while IFS= read -r f; do
    rel="${f#"$b"/root/}"
    mkdir -p "$(dirname "/$rel")" 2>/dev/null || true
    cp -p "$f" "/$rel" 2>/dev/null && log "restored /$rel"
  done <<EOF
$(find "$b/root" -type f 2>/dev/null)
EOF
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

print_summary() { # action
  local action="$1"
  say ""
  say "dsh ${action} complete"
  say "  version:   ${VERSION}"
  say "  channel:   ${CHANNEL}"
  say "  harness:   ${HARNESS}"
  say "  current:   $PREFIX/harness/current -> $(readlink "$PREFIX/harness/current" 2>/dev/null || printf '?')"
  say "  node:      ${NODE} (${NODE_ORIGIN})"
  say "  pnpm:      ${PNPM} (corepack)"
  say "  dsh home:  ${DSH_HOME} (seeded only; your files are never overwritten)"
  say "  profile:   ${PROFILE}"
  if [ -n "$PROFILE_SOURCE" ]; then say "  profile source: ${PROFILE_SOURCE}"; else say "  profile source: (none; shipped template)"; fi
  say "  shim:      ${BIN_DIR}/dsh"
  say ""
  say "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\""
  say "Next:         dsh web        boot the web UI"
  say "              dsh update     update to the newest ${CHANNEL} build"
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
  if [ -n "$PROFILE_SOURCE" ]; then say "  profile:   $PROFILE (source: $PROFILE_SOURCE)"; else say "  profile:   $PROFILE (shipped template)"; fi
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
  detect_os_arch
  sudo_trap
  log "install root $PREFIX on $OS/$ARCH (zero sudo)"
  resolve_node 1 || die "no usable Node.js >= ${DSH_MIN_NODE_MAJOR}.${DSH_MIN_NODE_MINOR} and the download failed"
  log "node: $NODE ($NODE_ORIGIN)"
  prepare_source
  log "target version: $VERSION"
  HARNESS="$PREFIX/harness/$VERSION"
  if [ -f "$HARNESS/.dsh-install-complete" ] && [ "$FORCE" != 1 ]; then
    log "already installed; refreshing seed/shim only"
    if [ -n "$STAGED" ]; then rm -rf "$STAGED"; STAGED=""; fi
    if [ -z "$PNPM" ] && [ -x "$PREFIX/bin/pnpm" ]; then PNPM="$PREFIX/bin/pnpm"; fi
  else
    setup_pnpm || die "could not enable pnpm through corepack"
    log "pnpm: $("$PNPM" --version 2>/dev/null || printf '?') (corepack)"
    install_tree || die "install/build failed; no changes were made to \$DSH_HOME (tree: $HARNESS)"
  fi
  ln -sfn "$VERSION" "$PREFIX/harness/current" || die "could not point $PREFIX/harness/current at $VERSION"
  prepare_profile
  seed_home
  profile_install || die "profile dependency install failed"
  run_profile_plugin_build || die "profile plugin build failed"
  write_shim || die "could not write the dsh shim into $BIN_DIR"
  [ "$WRITE_RC" = 1 ] && write_rc
  if [ -z "$SERVICE_UNIT" ]; then SERVICE_UNIT="$(detect_service_unit)"; fi
  write_state || warn "could not write $PREFIX/harness/install-state.json"
  if ! selfcheck; then
    warn "self-check failed for the freshly installed tree"
    emit_json install 0
    exit 1
  fi
  print_summary install
  emit_json install 1
  return 0
}

# ── Update ──────────────────────────────────────────────────────────────────
rollback() { # prev backup failed_version
  local prev="$1" backup="$2" failed="$3"
  warn "rolling back to $prev"
  ln -sfn "$prev" "$PREFIX/harness/current" 2>/dev/null || warn "could not repoint $PREFIX/harness/current"
  restore_user_files "$backup"
  if [ -d "$PREFIX/harness/$failed" ]; then
    mv "$PREFIX/harness/$failed" "$PREFIX/harness/$failed.failed-$(date +%Y%m%d-%H%M%S)" 2>/dev/null \
      || warn "could not archive the failed tree $PREFIX/harness/$failed"
  fi
  HARNESS="$PREFIX/harness/$prev"
  local prev_ok=1
  unset DSH_UPDATE_SELFTEST_FAIL
  if selfcheck >/dev/null 2>&1; then prev_ok=0; else warn "the previous tree also fails self-check; inspect $HARNESS"; fi
  ROLLED_BACK=1
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
  local keep1="$1" keep2="$2" d name
  for d in "$PREFIX/harness"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in .*|current|*.failed-*) continue;; esac
    if [ "$name" = "$keep1" ] || [ "$name" = "$keep2" ]; then continue; fi
    [ -f "$d/.dsh-install-complete" ] || continue
    log "pruning old version $name"
    rm -rf "$d" || warn "could not prune $name"
  done
  return 0
}

do_update() {
  local state="$PREFIX/harness/install-state.json" current backup rc
  [ -f "$state" ] || die "no install state at $state; run the installer first"
  detect_os_arch
  resolve_node 0 || die "no usable Node.js found for the update"
  if [ -z "$CHANNEL" ]; then CHANNEL="$(json_field "$state" channel)"; [ -n "$CHANNEL" ] || CHANNEL=stable; fi
  if [ -z "$SOURCE" ]; then SOURCE="$(json_field "$state" source)"; fi
  if [ -z "$REF" ]; then REF="$(json_field "$state" ref)"; fi
  if [ -z "$PROFILE" ]; then PROFILE="$(json_field "$state" profile)"; [ -n "$PROFILE" ] || PROFILE=web; fi
  if [ -z "$PROFILE_SOURCE" ]; then PROFILE_SOURCE="$(json_field "$state" profileSource)"; fi
  if [ -z "$PROFILE_REF" ]; then PROFILE_REF="$(json_field "$state" profileRef)"; fi
  if [ -z "$BIN_DIR" ]; then BIN_DIR="$(json_field "$state" binDir)"; [ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"; fi
  if [ -z "$SERVICE_UNIT" ]; then SERVICE_UNIT="$(json_field "$state" serviceUnit)"; fi
  resolve_home
  current="$(readlink "$PREFIX/harness/current" 2>/dev/null || true)"
  if [ -z "$current" ]; then current="$(json_field "$state" version)"; fi
  [ -n "$current" ] && [ -d "$PREFIX/harness/$current" ] || die "cannot find the active version under $PREFIX/harness (current='$current')"
  PREV_VERSION="$current"
  if [ "$DRY_RUN" = 1 ]; then
    local target_value=""
    if [ -z "$SOURCE" ]; then
      say "  source:   $DSH_GITHUB_URL/archive/refs/heads/${REF:-$CHANNEL}.tar.gz (version resolved at fetch time)"
    elif [ -d "$SOURCE" ]; then
      target_value="$("$NODE" -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]+"/package.json","utf8"));process.stdout.write(String(p.version||""))' "$SOURCE" 2>/dev/null || true)"
      say "  source:   $SOURCE (version ${target_value:-unknown})"
    else
      say "  source:   $SOURCE"
    fi
    say "dsh update dry run (no writes)"
    say "  active:   $current ($CHANNEL channel)"
    [ -n "$target_value" ] && say "  target:   $target_value"
    if [ -n "$PROFILE_SOURCE" ]; then say "  profile:  $PROFILE (source: $PROFILE_SOURCE)"; else say "  profile:  $PROFILE (no recorded source)"; fi
    say "  steps:    fetch -> install+build -> profile refresh+deps -> migrations -> switch current -> service restart ($([ -n "$SERVICE_UNIT" ] && printf '%s' "$SERVICE_UNIT" || printf 'none recorded')) -> backfill -> self-check"
    say "  rollback: current link + user-file backups would be restored on failure"
    emit_json update 1
    return 0
  fi
  sudo_trap
  log "update: active $current on the $CHANNEL channel"
  prepare_source
  log "update target: $VERSION"
  HARNESS="$PREFIX/harness/$VERSION"

  if [ "$VERSION" = "$current" ] && [ "$FORCE" != 1 ]; then
    if [ -z "$PNPM" ] && [ -x "$PREFIX/bin/pnpm" ]; then PNPM="$PREFIX/bin/pnpm"; fi
    local recorded_home
    recorded_home="$(json_field "$state" dshHome)"
    if [ -n "$recorded_home" ] && [ "$recorded_home" != "$DSH_HOME" ]; then
      warn "state records dshHome=$recorded_home but this shell resolves DSH_HOME=$DSH_HOME"
    fi
    log "already up to date at $VERSION; nothing to fetch/build"
    if [ -n "$STAGED" ]; then rm -rf "$STAGED"; STAGED=""; fi
    prepare_profile
    seed_home
    profile_install || warn "profile dependency refresh failed"
    run_profile_plugin_build || warn "profile plugin build failed"
    if ! selfcheck; then
      warn "self-check of the active tree failed"
      emit_json noop 0
      exit 1
    fi
    say "dsh is already up to date: $VERSION ($CHANNEL channel)"
    emit_json noop 1
    return 0
  fi
  if ver_lt "$VERSION" "$current" && [ "$FORCE_DOWNGRADE" != 1 ]; then
    die "refusing to downgrade from $current to $VERSION without --force-downgrade"
  fi

  setup_pnpm || die "could not enable pnpm through corepack"
  backup="$PREFIX/harness/.backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup" 2>/dev/null || warn "could not create backup dir $backup"
  backup_user_files "$backup"
  log "user-file backups: $backup"

  if ! install_tree; then
    warn "update failed before switching; $current remains active"
    write_diagnostics install-failed
    emit_json update 0
    exit 1
  fi
  prepare_profile
  if ! run_migrations; then
    warn "migrations failed before switching; $current remains active"
    write_diagnostics migrations-failed
    emit_json update 0
    exit 1
  fi

  ln -sfn "$VERSION" "$PREFIX/harness/current" || die "could not switch $PREFIX/harness/current to $VERSION"
  log "switched current -> $VERSION"
  restart_service
  run_backfill

  if ! selfcheck; then
    rollback "$current" "$backup" "$VERSION"
    exit 1
  fi
  write_state || warn "could not write $state"
  prune_versions "$VERSION" "$current"
  print_summary update
  emit_json update 1
  return 0
}

# ── Defaults + dispatch ─────────────────────────────────────────────────────
if [ -z "$PREFIX" ]; then PREFIX="$HOME/.dsh"; fi
if [ -z "$BIN_DIR" ]; then BIN_DIR="$HOME/.local/bin"; fi
if [ "$UPDATE_MODE" = 0 ]; then
  if [ -z "$CHANNEL" ]; then CHANNEL=stable; fi
  if [ -z "$PROFILE" ]; then PROFILE=web; fi
  if [ -n "$PROFILE_SOURCE" ]; then PROFILE_SOURCE_REQUIRED=1; fi
  if [ -z "$PROFILE_SOURCE" ] && [ "$PROFILE" = web ] && [ -n "$DEFAULT_PROFILE_SOURCE" ]; then
    PROFILE_SOURCE="$DEFAULT_PROFILE_SOURCE"
  fi
else
  if [ -z "$CHANNEL" ]; then CHANNEL=stable; fi
  if [ -z "$PROFILE" ]; then PROFILE=web; fi
fi
case "$CHANNEL" in stable|beta) :;; *) die "unknown channel: $CHANNEL (stable|beta)";; esac
case "$PREFIX" in /*) :;; *) die "--prefix must be an absolute path: $PREFIX";; esac
if [ -z "$DSH_HOME" ]; then DSH_HOME="$HOME/.dsh"; fi
export DSH_HOME

if [ "$DRY_RUN" = 1 ]; then
  detect_os_arch
  dry_run_plan
  exit 0
fi

if [ "$UPDATE_MODE" = 1 ]; then
  do_update
else
  do_install
fi
