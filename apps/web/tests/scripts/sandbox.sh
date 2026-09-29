#!/usr/bin/env bash
# Sandbox runner: boots a throwaway fresh-install DSH home so the first-run
# wizard flow can be experienced without touching the live service.
#
# Reachability: this is a development convenience, not how the product ships —
# dsh web binds loopback by design (the shipped default), and the live service
# reaches the tailnet through its own socat forwarder (dsh-tailnet.service).
# The sandbox mirrors that topology: the app binds 127.0.0.1 and a per-sandbox
# socat process listens on the first tailnet IPv4 from `tailscale ip -4`, so
# other tailnet devices can reach it. When Tailscale is unavailable the sandbox
# stays on loopback and says it is local-only.
#
# Usage:
#   sandbox.sh [start] [--home <dir>] [--port <n>] [--host <addr> | --local]
#   sandbox.sh status  [--home <dir>]
#   sandbox.sh stop    [--home <dir>]
#   sandbox.sh reset   [--home <dir>] [--port <n>] [--host <addr> | --local]
#
#   --local        force loopback; the sandbox is reachable on this machine only
#   --host <addr>  serve that address instead of the detected tailnet IPv4
#
# Default home: ~/.dsh-sandbox. Default port: first free port from 3099.
#
# Profile provisioning: a fresh sandbox home is seeded from OUR profile, never
# the upstream shipped template. The profile is fetched from the public profile
# repo (the same default source the installer uses, overridable with
# DSH_SANDBOX_PROFILE_SOURCE / DSH_SANDBOX_PROFILE_REF) and the home-level seed
# matches scripts/install.sh's seed_profile_home: settings.yaml from
# fresh-settings.yaml, .agent-presets/, skills/, skins/, and
# skin-center-active.json. Nothing from the live $DSH_HOME or its profile tree
# is read or written.
#
# Safety (hard, checked before every destructive or process action):
#   * refuses when the sandbox home equals, contains, or sits inside the live
#     $DSH_HOME (default ~/.dsh) or the repository;
#   * refuses port 3080 and the live service's actual --port;
#   * refuses --host 0.0.0.0, the same whole-network exposure dsh web refuses;
#   * never invokes systemctl start/stop/restart on any unit (read-only
#     `show`/`is-active` only, for safety checks and reporting);
#   * writes only inside the sandbox home.
set -euo pipefail

DEFAULT_HOME="$HOME/.dsh-sandbox"
MARKER=".dsh-sandbox"
START_PORT=3099
END_PORT=3199
LIVE_PORT_FALLBACK=3080
BOOT_TIMEOUT="${DSH_SANDBOX_BOOT_TIMEOUT:-300}"
SEED_TIMEOUT="${DSH_SANDBOX_SEED_TIMEOUT:-60}"
REPO="${DSH_SANDBOX_REPO:-$HOME/deepseek-harness}"
PROFILE="web"
PROFILE_SOURCE="${DSH_SANDBOX_PROFILE_SOURCE:-${DSH_DEFAULT_PROFILE_SOURCE:-https://github.com/Darthph0enix7/dsh-enpoi-web-profile.git}}"
PROFILE_REF="${DSH_SANDBOX_PROFILE_REF:-}"
PROFILE_FETCH_TIMEOUT="${DSH_SANDBOX_PROFILE_FETCH_TIMEOUT:-600}"
PROFILE_INSTALL_TIMEOUT="${DSH_SANDBOX_PROFILE_INSTALL_TIMEOUT:-900}"

SELF="ds sandbox"
SUB=start
SANDBOX_DIR="$DEFAULT_HOME"
REQ_PORT=""
SANDBOX_HOST=""
LOCAL_ONLY=0

info() { printf '  %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

run_limited() {
  local seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$seconds" "$@"
  else "$@"; fi
}

resolve_pnpm() {
  local candidate
  if [ -n "${DSH_SANDBOX_PNPM:-}" ] && [ -x "${DSH_SANDBOX_PNPM}" ]; then printf '%s' "$DSH_SANDBOX_PNPM"; return 0; fi
  candidate="$(command -v pnpm 2>/dev/null || true)"
  if [ -z "$candidate" ] && [ -x "$HOME/.dsh/bin/pnpm" ]; then candidate="$HOME/.dsh/bin/pnpm"; fi
  [ -n "$candidate" ] || fail "no pnpm found to install the profile dependencies; install pnpm or set DSH_SANDBOX_PNPM"
  printf '%s' "$candidate"
}

# Fetch the profile tree into $1. The public repo is the default source; a
# local directory path is accepted for offline runs. Local state that belongs
# to one home (settings.yaml, device-patches, node_modules, .git) is excluded
# so the clone ships only the reproducible profile.
fetch_profile() {
  local dst="$1" src="$PROFILE_SOURCE" args
  rm -rf "$dst"
  mkdir -p "$(dirname "$dst")"
  if [ -d "$src" ]; then
    mkdir -p "$dst" || return 1
    ( cd "$src" && tar -cf - --exclude='./.git' --exclude='.git' \
        --exclude='./node_modules' --exclude='node_modules' --exclude='*/node_modules' . ) \
      | tar -C "$dst" -xf - || return 1
  else
    args=(-c advice.detachedHead=false clone --depth 1)
    [ -n "$PROFILE_REF" ] && args+=(--branch "$PROFILE_REF")
    GIT_TERMINAL_PROMPT=0 run_limited "$PROFILE_FETCH_TIMEOUT" git "${args[@]}" "$src" "$dst" || return 1
  fi
  return 0
}

seed_file_once() { # src dst
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  [ -e "$dst" ] && return 0
  mkdir -p "$(dirname "$dst")" 2>/dev/null || return 0
  cp -p "$src" "$dst" 2>/dev/null || true
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

# The three strippers below remove configured-machine state from a freshly
# copied profile patch in place. They exist as a second line of defence behind
# the sanitized repo template: a source tree that is itself a live profile (a
# local profile dir, a stale clone) must still provision a fresh home. Editing
# the text line-by-line keeps the large YAML document's formatting, multi-line
# strings, and `!!js` tags intact.

# Drop the `onboardingCompleted` and first-run `seedVersion` markers: a fresh
# home must boot into the first-run wizard with the keyless seed pending,
# while the live profile keeps its markers (that setup is complete).
strip_fresh_markers() { # patch-file
  local file="$1" tmp="$1.strip-$$"
  [ -f "$file" ] || return 0
  cp -p "$file" "$tmp"
  grep -v -E '^[[:space:]]*(onboardingCompleted|seedVersion):' "$file" > "$tmp" || true
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
    /^- / { inorch = ($0 == "- id: enpoi-orchestration"); skip = 0 }
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
  strip_fresh_markers "$file"
  return 0
}

# Seed the sandbox home from the fetched profile, mirroring install.sh's
# seed_profile_home so a fresh home boots our composition. Existing files are
# never touched. The fish function/completions are intentionally not seeded:
# the sandbox must not write outside its home.
seed_profile_home() { # stage
  local stage="$1"
  seed_file_once "$stage/fresh-settings.yaml" "$SANDBOX_DIR/settings.yaml"
  seed_dir_once "$stage/presets" "$SANDBOX_DIR/.agent-presets"
  seed_dir_once "$stage/skills" "$SANDBOX_DIR/skills"
  seed_dir_once "$stage/skins" "$SANDBOX_DIR/skins"
  seed_file_once "$stage/skin-center-active.json" "$SANDBOX_DIR/skin-center-active.json"
  return 0
}

# Provision the sandbox profile once per home: fetch, seed the home-level
# files, install the profile's dependencies (its plugin lib/ bundles ship
# prebuilt in the repo). Fails loud instead of booting the upstream template.
# The home-level seed and the dependency check re-run on every start because
# both are idempotent and cheap; the fetch never overwrites an existing tree.
provision_profile() {
  local dir="$SANDBOX_DIR/profiles/$PROFILE"
  local stage="$SANDBOX_DIR/profiles/.$PROFILE-fetch-$$"
  local pnpm need_install=0
  if [ -f "$dir/package.json" ]; then
    info "profile: $dir (already provisioned)"
    [ -d "$dir/node_modules" ] || need_install=1
  else
    info "profile: fetching $PROFILE_SOURCE"
    fetch_profile "$stage" || { rm -rf "$stage"; fail "profile fetch failed: $PROFILE_SOURCE (the sandbox must not fall back to the upstream template)"; }
    # One home's state never ships: the seed writes fresh-settings.yaml, and the
    # profile's own settings.yaml/device-patches belong to the live device.
    rm -rf "$stage/.git" "$stage/settings.yaml" "$stage/device-patches" "$stage/node_modules"
    # The copied patch (a live profile's document when the source is a local
    # tree) still carries that machine's settings rows and orchestration state;
    # only the fresh copy is stripped — the source keeps its live document.
    strip_fresh_patch "$stage/cordis.patch.yml"
    mkdir -p "$(dirname "$dir")"
    mv "$stage" "$dir" || { rm -rf "$stage"; fail "could not move the fetched profile into $dir"; }
    need_install=1
  fi
  seed_profile_home "$dir"
  [ "$need_install" = 1 ] || return 0
  pnpm="$(resolve_pnpm)"
  info "profile deps: $pnpm install --ignore-scripts in $dir (shipped plugin libs are prebuilt)"
  # --ignore-scripts keeps the profile's postinstall (which rewrites the shared
  # apps/web/dist branding) out of the sandbox; the served artifact is already brand-applied.
  if ! ( cd "$dir" && CI=1 run_limited "$PROFILE_INSTALL_TIMEOUT" "$pnpm" install --ignore-scripts ) >&2; then
    fail "profile dependency install failed in $dir (remove $SANDBOX_DIR and retry, or fix network access)"
  fi
  info "profile: provisioned $dir"
  return 0
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home)
      [ $# -ge 2 ] || fail "--home needs a directory"
      SANDBOX_DIR="$2"; shift 2 ;;
    --home=*) SANDBOX_DIR="${1#--home=}"; shift ;;
    --port)
      [ $# -ge 2 ] || fail "--port needs a number"
      REQ_PORT="$2"; shift 2 ;;
    --port=*) REQ_PORT="${1#--port=}"; shift ;;
    --local) LOCAL_ONLY=1; SANDBOX_HOST="127.0.0.1"; shift ;;
    --host)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "--host needs an address"
      SANDBOX_HOST="$2"; LOCAL_ONLY=0; shift 2 ;;
    --host=*)
      [ -n "${1#--host=}" ] || fail "--host needs an address"
      SANDBOX_HOST="${1#--host=}"; LOCAL_ONLY=0; shift ;;
    start|status|stop|reset) SUB="$1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done

case "$SANDBOX_DIR" in
  "~") SANDBOX_DIR="$HOME" ;;
  "~/"*) SANDBOX_DIR="$HOME/${SANDBOX_DIR#\~/}" ;;
esac

case "$SANDBOX_HOST" in
  *[[:space:]]*|*/*) fail "--host must be a bare host or address (got: $SANDBOX_HOST)" ;;
esac
[ "$SANDBOX_HOST" != "0.0.0.0" ] || fail "refusing --host 0.0.0.0: it would expose the sandbox to the whole network (same guard as dsh web); use --local or a specific address"

LIVE_HOME="${DSH_HOME:-$HOME/.dsh}"

is_loopback_host() {
  case "$1" in
    127.*|localhost|localhost.*|"::1"|"[::1]") return 0 ;;
  esac
  return 1
}

is_ipv4_literal() {
  local candidate="$1" dots
  dots="${candidate//[^.]/}"
  [ "${#dots}" = 3 ] && [ "${candidate//[0-9.]/}" = "" ]
}

# Resolve the address the sandbox is reached at: the explicit --host, loopback
# for --local, else the first tailnet IPv4. Without Tailscale, fall back to
# loopback and say so, because a silent fallback would misrepresent reach.
detect_host() {
  local candidate
  if [ -n "$SANDBOX_HOST" ]; then printf '%s' "$SANDBOX_HOST"; return 0; fi
  if command -v tailscale >/dev/null 2>&1; then
    candidate="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
    if is_ipv4_literal "$candidate"; then printf '%s' "$candidate"; return 0; fi
  fi
  printf 'warning: Tailscale is unavailable; sandbox is local-only (127.0.0.1, reachable on this machine only)\n' >&2
  printf '127.0.0.1'
}

# Read-only facts about the live units. Never mutate them.
live_service_port() {
  local exec_start port=""
  exec_start="$(systemctl --user show dsh-web.service -p ExecStart --value 2>/dev/null || true)"
  if [ -n "$exec_start" ]; then
    port="$(printf '%s\n' "$exec_start" | grep -oE -- '--port[ =][0-9]+' | grep -oE '[0-9]+' | head -n1 || true)"
  fi
  case "$port" in
    ''|*[!0-9]*) printf '%s' "$LIVE_PORT_FALLBACK" ;;
    *) printf '%s' "$port" ;;
  esac
}

live_service_pid() {
  local pid
  pid="$(systemctl --user show dsh-web.service -p MainPID --value 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$pid" ;;
  esac
}

# Resolve every path and refuse any sandbox home that could collide with the
# live home or the repository.
assert_safe_home() {
  local sandbox live home_real repo_real
  sandbox="$(realpath -m -- "$SANDBOX_DIR")"
  live="$(realpath -m -- "$LIVE_HOME")"
  home_real="$(realpath -m -- "$HOME")"
  repo_real="$(realpath -m -- "$REPO")"

  [ "$sandbox" != "/" ] || fail "refusing: sandbox home may not be /"
  [ "$sandbox" != "$home_real" ] || fail "refusing: sandbox home may not be \$HOME ($home_real)"
  [ "$sandbox" != "$live" ] || fail "refusing: sandbox home equals the live DSH_HOME ($live)"
  case "$live/" in
    "$sandbox"/*) fail "refusing: sandbox home contains the live DSH_HOME ($live)" ;;
  esac
  case "$sandbox/" in
    "$live"/*) fail "refusing: sandbox home is inside the live DSH_HOME ($live)" ;;
  esac
  case "$sandbox/" in
    "$repo_real"/*) fail "refusing: sandbox home is inside the repository ($repo_real)" ;;
  esac
  SANDBOX_DIR="$sandbox"
}

prepare_home() {
  if [ -e "$SANDBOX_DIR" ] && [ ! -f "$SANDBOX_DIR/$MARKER" ]; then
    if [ -n "$(find "$SANDBOX_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n1 || true)" ]; then
      fail "refusing: $SANDBOX_DIR exists without the $MARKER marker; remove it yourself or pass another --home"
    fi
  fi
  mkdir -p "$SANDBOX_DIR/home"
  [ -f "$SANDBOX_DIR/$MARKER" ] || printf 'sandbox home created %s\n' "$(date -Is)" > "$SANDBOX_DIR/$MARKER"
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$port" 2>/dev/null | grep -q . && return 0
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PY' && return 0
import socket, sys
sock = socket.socket()
sock.settimeout(0.3)
try:
    code = sock.connect_ex(("127.0.0.1", int(sys.argv[1])))
finally:
    sock.close()
sys.exit(0 if code == 0 else 1)
PY
  fi
  return 1
}

pick_port() {
  local live_port="$1" port
  if [ -n "$REQ_PORT" ]; then
    case "$REQ_PORT" in
      ''|*[!0-9]*) fail "--port must be a number" ;;
    esac
    [ "$REQ_PORT" != "$LIVE_PORT_FALLBACK" ] || fail "refusing --port $LIVE_PORT_FALLBACK (live service port)"
    [ "$REQ_PORT" != "$live_port" ] || fail "refusing --port $REQ_PORT (live service port)"
    port_in_use "$REQ_PORT" && fail "refusing --port $REQ_PORT: already in use"
    printf '%s' "$REQ_PORT"
    return 0
  fi
  port="$START_PORT"
  while [ "$port" -le "$END_PORT" ]; do
    if [ "$port" != "$LIVE_PORT_FALLBACK" ] && [ "$port" != "$live_port" ] && ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  fail "no free port in $START_PORT-$END_PORT"
}

resolve_node() {
  local live_pid candidate
  if [ -n "${DSH_SANDBOX_NODE:-}" ] && [ -x "${DSH_SANDBOX_NODE}" ]; then
    printf '%s' "$DSH_SANDBOX_NODE"
    return 0
  fi
  live_pid="$(live_service_pid)"
  if [ "$live_pid" -gt 0 ] && [ -r "/proc/$live_pid/exe" ]; then
    candidate="$(readlink -f "/proc/$live_pid/exe" 2>/dev/null || true)"
    case "$candidate" in
      */node) printf '%s' "$candidate"; return 0 ;;
    esac
  fi
  for candidate in "$HOME"/.local/share/nvm/v*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  candidate="$(command -v node 2>/dev/null || true)"
  [ -n "$candidate" ] || fail "no node binary found; set DSH_SANDBOX_NODE"
  printf '%s' "$candidate"
}

pidfile_pid() {
  local pid=""
  [ -f "$SANDBOX_DIR/sandbox.pid" ] && pid="$(cat "$SANDBOX_DIR/sandbox.pid" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) printf '' ;;
    *) printf '%s' "$pid" ;;
  esac
}

pid_is_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

pid_matches_sandbox() {
  local pid="$1" expected
  [ -n "$pid" ] && [ -d "/proc/$pid" ] || return 1
  [ -r "/proc/$pid/environ" ] || return 1
  expected="$(realpath -m -- "$SANDBOX_DIR")"
  tr '\0' '\n' < "/proc/$pid/environ" | grep -qx "DSH_HOME=$expected"
}

# The address the sandbox is reached at, as recorded by start (older sandboxes
# predate the file and were loopback-only).
sandbox_host() {
  local host
  host="$(cat "$SANDBOX_DIR/sandbox.host" 2>/dev/null || true)"
  [ -n "$host" ] || host=127.0.0.1
  printf '%s' "$host"
}

forwarder_needed() { ! is_loopback_host "$1"; }

forward_pid() {
  local pid=""
  [ -f "$SANDBOX_DIR/forward.pid" ] && pid="$(cat "$SANDBOX_DIR/forward.pid" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) printf '' ;;
    *) printf '%s' "$pid" ;;
  esac
}

# The forwarder is a socat process; it cannot carry DSH_HOME, so ownership is
# proven by the exact listener argument this script constructed.
forward_matches() {
  local pid="$1" host="$2" port="$3"
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' '\n' < "/proc/$pid/cmdline" | grep -qF "TCP-LISTEN:$port,bind=$host,"
}

start_forwarder() {
  local host="$1" port="$2" pid
  forwarder_needed "$host" || return 0
  : >> "$SANDBOX_DIR/forward.log"
  (
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup socat "TCP-LISTEN:$port,bind=$host,fork,reuseaddr" "TCP:127.0.0.1:$port" \
        >> "$SANDBOX_DIR/forward.log" 2>&1 < /dev/null &
    else
      nohup socat "TCP-LISTEN:$port,bind=$host,fork,reuseaddr" "TCP:127.0.0.1:$port" \
        >> "$SANDBOX_DIR/forward.log" 2>&1 < /dev/null &
    fi
    printf '%s' "$!" > "$SANDBOX_DIR/forward.pid"
  )
  sleep 1
  pid="$(forward_pid)"
  if [ -z "$pid" ] || ! pid_is_alive "$pid"; then
    printf 'Error: forwarder failed to listen on %s:%s; last forward.log lines:\n' "$host" "$port" >&2
    tail -n 10 "$SANDBOX_DIR/forward.log" >&2 || true
    rm -f "$SANDBOX_DIR/forward.pid"
    return 1
  fi
  info "forwarder: $host:$port -> 127.0.0.1:$port (pid $pid)"
}

stop_forwarder() {
  local pid host port i
  pid="$(forward_pid)"
  [ -n "$pid" ] || return 0
  if ! pid_is_alive "$pid"; then
    rm -f "$SANDBOX_DIR/forward.pid"
    return 0
  fi
  host="$(sandbox_host)"
  port="$(cat "$SANDBOX_DIR/sandbox.port" 2>/dev/null || true)"
  if ! forward_matches "$pid" "$host" "$port"; then
    printf 'warning: forwarder pid %s does not match this sandbox; leaving it alone and dropping the pidfile\n' "$pid" >&2
    rm -f "$SANDBOX_DIR/forward.pid"
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 10); do
    pid_is_alive "$pid" || break
    sleep 1
  done
  if pid_is_alive "$pid"; then
    info "forwarder $pid ignored TERM; sending KILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
  fi
  pid_is_alive "$pid" && fail "forwarder process $pid survived KILL"
  rm -f "$SANDBOX_DIR/forward.pid"
  info "forwarder stopped (pid $pid)"
}

sandbox_url() {
  local log="$SANDBOX_DIR/sandbox.log" url host
  [ -f "$log" ] || return 0
  url="$(grep -oE 'dsh web: http://[^ ]+' "$log" 2>/dev/null | tail -n1 | sed 's/^dsh web: //' || true)"
  [ -n "$url" ] || return 0
  host="$(sandbox_host)"
  # Announce the reachable host; keep the app-assigned port and the token.
  printf '%s' "$url" | sed -E "s#^http://[^/:]+(:[0-9]+)?#http://$host\1#"
}

http_code() {
  local url="$1"
  curl -s -o /dev/null -w '%{http_code}' -b '' -L --max-time 8 "$url" 2>/dev/null || true
}

sandbox_health() {
  local url
  url="$(sandbox_url)"
  if [ -n "$url" ]; then
    http_code "$url"
    return 0
  fi
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$(cat "$SANDBOX_DIR/sandbox.port" 2>/dev/null || printf '%s' "$START_PORT")/" 2>/dev/null || true
}

print_banner() {
  local pid port url code host
  pid="$(pidfile_pid)"
  port="$(cat "$SANDBOX_DIR/sandbox.port" 2>/dev/null || printf '%s' '?')"
  host="$(sandbox_host)"
  url="$(sandbox_url)"
  code="$(sandbox_health)"
  printf '\n'
  printf '===============================================================\n'
  printf '  DSH SANDBOX — fresh-install first-run experience\n'
  printf '  This is NOT the live service. The live app on :%s and the live\n' "$(live_service_port)"
  printf '  DSH_HOME (%s) are untouched by this script.\n' "$(realpath -m -- "$LIVE_HOME")"
  printf '===============================================================\n'
  info "Home : $SANDBOX_DIR"
  info "Host : $host"
  info "Port : $port"
  info "PID  : ${pid:-not running}"
  info "Log  : $SANDBOX_DIR/sandbox.log"
  info "URL  : ${url:-not printed yet; see the log}"
  info "HTTP : ${code:-no response} (200 = wizard reachable; 401 = up but auth-gated)"
  info "Stop : ds sandbox stop"
  info "Reset: ds sandbox reset   (wipes this home; the next start re-runs first-run)"
  printf '===============================================================\n'
}

wait_healthy() {
  local port="$1" deadline=$((SECONDS + BOOT_TIMEOUT)) url code pid
  printf '  %s\n' "waiting for the sandbox to become healthy (timeout ${BOOT_TIMEOUT}s; log: $SANDBOX_DIR/sandbox.log)" >&2
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(pidfile_pid)"
    if [ -n "$pid" ] && ! pid_is_alive "$pid"; then
      printf 'Error: sandbox process $pid exited during boot; last log lines:\n' >&2
      tail -n 30 "$SANDBOX_DIR/sandbox.log" >&2 || true
      rm -f "$SANDBOX_DIR/sandbox.pid"
      return 1
    fi
    url="$(sandbox_url)"
    if [ -n "$url" ]; then
      code="$(http_code "$url")"
      if [ "$code" = "200" ]; then
        printf '%s' "$url"
        return 0
      fi
    fi
    sleep 1
  done
  printf 'Error: sandbox did not answer a healthy 200 within %ss; last log lines:\n' "$BOOT_TIMEOUT" >&2
  tail -n 30 "$SANDBOX_DIR/sandbox.log" >&2 || true
  return 1
}

# Confirm the freshly provisioned profile is the composition actually served:
# skin-center's served active state names the skin the provisioning seeded
# (the upstream template falls back to its bundled blue-fantasy). When the
# profile carries no active-skin document, the consumed settings seed
# (settings.yaml -> settings.yaml.imported on first boot) is the signal.
wait_seeded() {
  local deadline=$((SECONDS + SEED_TIMEOUT)) active served base
  active="$(sed -n 's/.*"active"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$SANDBOX_DIR/skin-center-active.json" 2>/dev/null | head -n1)"
  base="http://127.0.0.1:$(cat "$SANDBOX_DIR/sandbox.port" 2>/dev/null || printf '%s' "$START_PORT")"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -n "$active" ]; then
      served="$(curl -s --max-time 5 "$base/api/skin-center/v2/active" 2>/dev/null || true)"
      if printf '%s' "$served" | grep -q "\"active\":\"$active\""; then
        printf '  profile live: skin-center serves active skin %s\n' "$active" >&2
        return 0
      fi
    elif [ -f "$SANDBOX_DIR/settings.yaml.imported" ]; then
      printf '  profile live: seeded settings.yaml was imported at first boot\n' >&2
      return 0
    fi
    sleep 1
  done
  return 1
}

start_sandbox() {
  local live_port node_bin port pid url host
  local -a launch_args
  assert_safe_home
  pid="$(pidfile_pid)"
  if pid_is_alive "$pid"; then
    info "sandbox already running (pid $pid)"
    print_banner
    return 0
  fi
  prepare_home
  provision_profile
  live_port="$(live_service_port)"
  port="$(pick_port "$live_port")"
  host="$(detect_host)"
  # Check before the app starts so a missing forwarder tool cannot leave a
  # half-started sandbox behind.
  forwarder_needed "$host" && ! command -v socat >/dev/null 2>&1 \
    && fail "socat is required to serve $host (mirrors the live dsh-tailnet forwarder); install socat or pass --local"
  node_bin="$(resolve_node)"
  [ -f "$REPO/apps/cli/src/bin.ts" ] || fail "launcher not found: $REPO/apps/cli/src/bin.ts"
  printf '%s' "$port" > "$SANDBOX_DIR/sandbox.port"
  printf '%s' "$host" > "$SANDBOX_DIR/sandbox.host"
  : >> "$SANDBOX_DIR/sandbox.log"
  # dsh web binds loopback by design, so the app always gets 127.0.0.1 and the
  # announced host is served by the forwarder below (live topology). The
  # non-loopback authority is declared for the /api Host fence; the index
  # handshake already trusts CGNAT.
  launch_args=(web --host 127.0.0.1 --no-open --port "$port")
  if forwarder_needed "$host"; then
    launch_args+=(--trusted-host "$host")
  fi
  (
    cd "$REPO"
    # DSH_MEMORY_DB mirrors the live ~/.dsh/memory.db: with HOME remapped to the
    # sandbox, the plugin default would point at $SANDBOX_DIR/home/.dsh/memory.db
    # whose parent directory SQLite refuses to create, so the enpoi-memory entry
    # failed to activate.
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup env -u DSH_SNAPSHOT HOME="$SANDBOX_DIR/home" DSH_HOME="$SANDBOX_DIR" \
        DSH_MEMORY_DB="$SANDBOX_DIR/memory.db" \
        "$node_bin" --import tsx/esm apps/cli/src/bin.ts "${launch_args[@]}" \
        >> "$SANDBOX_DIR/sandbox.log" 2>&1 < /dev/null &
    else
      nohup env -u DSH_SNAPSHOT HOME="$SANDBOX_DIR/home" DSH_HOME="$SANDBOX_DIR" \
        DSH_MEMORY_DB="$SANDBOX_DIR/memory.db" \
        "$node_bin" --import tsx/esm apps/cli/src/bin.ts "${launch_args[@]}" \
        >> "$SANDBOX_DIR/sandbox.log" 2>&1 < /dev/null &
    fi
    printf '%s' "$!" > "$SANDBOX_DIR/sandbox.pid"
  )
  sleep 1
  pid="$(pidfile_pid)"
  if [ -z "$pid" ] || ! pid_is_alive "$pid"; then
    printf 'Error: sandbox process failed to start; last log lines:\n' >&2
    tail -n 30 "$SANDBOX_DIR/sandbox.log" >&2 || true
    return 1
  fi
  start_forwarder "$host" "$port" || return 1
  url="$(wait_healthy "$port")" || {
    pid="$(pidfile_pid)"
    if [ -z "$pid" ] || ! pid_is_alive "$pid"; then
      stop_forwarder
    fi
    return 1
  }
  if wait_seeded; then
    info "profile seed confirmed: our composition is live in the sandbox"
  else
    info "warning: the provisioned profile was not observed live within ${SEED_TIMEOUT}s (check the log and ${SANDBOX_DIR}/profiles, settings)"
  fi
  print_banner
  printf '\nOpen the URL above in a browser: it lands on the first-run wizard.\n'
}

status_sandbox() {
  local pid port url code host
  assert_safe_home
  pid="$(pidfile_pid)"
  host="$(sandbox_host)"
  if [ -z "$pid" ] || ! pid_is_alive "$pid"; then
    printf 'dsh sandbox: stopped'
    [ -d "$SANDBOX_DIR" ] && printf ' (home: %s; "ds sandbox reset" wipes it and re-runs first-run)' "$SANDBOX_DIR"
    printf '\n'
    return 1
  fi
  if ! pid_matches_sandbox "$pid"; then
    printf 'Error: pid %s is alive but does not carry DSH_HOME=%s; refusing to treat it as the sandbox\n' "$pid" "$SANDBOX_DIR" >&2
    return 1
  fi
  port="$(cat "$SANDBOX_DIR/sandbox.port" 2>/dev/null || printf '?')"
  url="$(sandbox_url)"
  code="$(sandbox_health)"
  printf 'dsh sandbox: running (pid %s, host %s, port %s, home %s)\n' "$pid" "$host" "$port" "$SANDBOX_DIR"
  printf '  URL : %s\n' "${url:-not printed yet; see $SANDBOX_DIR/sandbox.log}"
  printf '  HTTP: %s\n' "$code"
}

stop_sandbox() {
  local pid live_pid i
  assert_safe_home
  stop_forwarder
  pid="$(pidfile_pid)"
  if [ -z "$pid" ]; then
    info "sandbox is not running (no pidfile)"
    return 0
  fi
  if ! pid_is_alive "$pid"; then
    rm -f "$SANDBOX_DIR/sandbox.pid"
    info "sandbox is not running (stale pidfile removed)"
    return 0
  fi
  live_pid="$(live_service_pid)"
  [ "$pid" != "$live_pid" ] || fail "refusing: pidfile pid $pid is the live dsh-web.service main pid"
  [ "$pid" != "$$" ] || fail "refusing: pidfile pid is this script"
  pid_matches_sandbox "$pid" || fail "refusing: pid $pid does not carry DSH_HOME=$SANDBOX_DIR; not touching it"
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 15); do
    pid_is_alive "$pid" || break
    sleep 1
  done
  if pid_is_alive "$pid"; then
    info "process $pid ignored TERM; sending KILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
  fi
  pid_is_alive "$pid" && fail "process $pid survived KILL"
  rm -f "$SANDBOX_DIR/sandbox.pid"
  info "sandbox stopped (pid $pid); live service untouched"
}

reset_sandbox() {
  assert_safe_home
  stop_sandbox
  [ -f "$SANDBOX_DIR/$MARKER" ] || fail "refusing to wipe $SANDBOX_DIR: missing $MARKER marker"
  rm -rf -- "$SANDBOX_DIR"
  info "wiped $SANDBOX_DIR"
  start_sandbox
}

case "$SUB" in
  start) start_sandbox ;;
  status) status_sandbox ;;
  stop) stop_sandbox ;;
  reset) reset_sandbox ;;
  *) fail "unknown subcommand: $SUB" ;;
esac
