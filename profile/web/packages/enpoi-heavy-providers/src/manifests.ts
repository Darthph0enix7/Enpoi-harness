/**
 * enpoi-heavy-providers — the HEAVY provider manifest table.
 *
 * A heavy provider is LISTED in Add Provider but installs nothing by default;
 * adding one either uses an instance the detection already found (the
 * manifest's loopback endpoint), runs the manifest's local install, or — for
 * a `delivery: 'direct'` manifest — points the route at the vendor endpoint
 * and runs only the package setup. Removing one runs the teardown. Everything
 * here is declarative data: the install/removal runner executes steps
 * generically and contains no per-provider branches. Every service default
 * address is loopback: an operator's own server lives in a private overlay
 * ($DSH_HOME/heavy-server-overlay.json), never in this shipped table. A
 * `delivery: 'direct'` manifest is the exception by definition — it names the
 * vendor's public endpoint, and the server-agnostic test pins that host to
 * the manifest's own declared URL.
 *
 * Hand-maintained (beside the harness-side display copy in
 * `ui-settings-models/src/client/provider-templates.ts` — keep the ids and
 * facts in step). The canonical rendering of every route follows the live
 * profiles (antigravity `baseURL` carries no `/v1`; freellmapi uses `/v1`).
 *
 * @module dsh-enpoi-heavy-providers/manifests
 */

/** One shell step of an install or teardown run. */
export interface HeavyStep {
  /** Human stage label shown in the progress UI. */
  label: string
  /**
   * Shell command executed with `bash -lc`. `{home}`, `{config}` (=
   * `$HOME/.config`), and `{dshHome}` (the real `$DSH_HOME`) are substituted
   * by the runner. Paths under the DSH home must use `{dshHome}`, never a
   * literal `~/.dsh` layout.
   */
  command: string
  /** Working directory override (placeholders allowed); defaults to `$HOME`. */
  cwd?: string
  /** A failing optional step logs but does not fail the run. */
  optional?: boolean
  /** Relative progress weight (default 1). */
  weight?: number
}

/** One HTTP health probe. */
export interface HeavyHealth {
  url: string
  /** Accepted HTTP statuses; default any 2xx. */
  expectStatus?: readonly number[]
  /** Substring the response body must contain when set. */
  expectBody?: string
  /** Request headers the probe must carry (a vendor gate may need a client identity). */
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
}

/** What a local install path needs on the machine. */
export type HeavyLocalRuntime = 'vendor-app' | 'docker' | 'podman' | 'node'

/** One file a local install needs before its steps can succeed. */
export interface HeavyFileRequirement {
  /** Candidate paths (`{home}`/`{config}`/`{dshHome}` placeholders allowed); any existing one satisfies the requirement. */
  paths: readonly string[]
  /** Operator-facing line naming what is missing and how to provide it. */
  hint: string
}

/** One platform's local install path. */
export interface HeavyPlatformInstall {
  /** Human label override; defaults to the local install label. */
  label?: string
  /** Dependency hints override; defaults to `local.deps`. */
  deps?: readonly string[]
  /** Footprint hint override; defaults to `local.diskHint`. */
  diskHint?: string
  /** Prerequisite this variant needs; defaults to `local.runtime`. */
  runtime?: HeavyLocalRuntime
  /**
   * Why this platform has no supported local install. Present means the path
   * is refused before any step runs and `steps` is empty; the reason is shown
   * verbatim by preflight and the install RPC.
   */
  unsupported?: string
  /**
   * Files the variant needs (any candidate of each requirement). Preflight
   * reports the first unsatisfied requirement's hint instead of offering a
   * path that would fail partway through its steps.
   */
  requiresFiles?: readonly HeavyFileRequirement[]
  /** Steps executed in order for this platform. */
  steps: readonly HeavyStep[]
}

/** The platform-keyed local install table; `default` is the fallback. */
export interface HeavyInstallTable {
  default: HeavyPlatformInstall
  linux?: HeavyPlatformInstall
  darwin?: HeavyPlatformInstall
  win32?: HeavyPlatformInstall
}

/** Install path on this device, with platform-keyed variants. */
export interface HeavyLocalInstall {
  label: string
  baseURL: string
  deps: readonly string[]
  diskHint: string
  /** Prerequisite the default variant needs, unless a variant overrides it. */
  runtime?: HeavyLocalRuntime
  /** Dashboard served by the local install (defaults to {@link HeavyProviderManifest.dashboardUrl}). */
  dashboardUrl?: string
  /** Platform-keyed steps; a platform without an entry uses `default`. */
  install: HeavyInstallTable
  health: HeavyHealth
}

/** The platforms with a declared install variant. */
export type HeavyPlatform = 'linux' | 'darwin' | 'win32'

/** One platform's install resolved against the local defaults. */
export interface ResolvedHeavyInstall {
  label: string
  deps: readonly string[]
  diskHint: string
  steps: readonly HeavyStep[]
}

/**
 * The install variant one platform resolves to, before the local defaults are
 * filled in. An unknown platform key uses `default`.
 * @param local - the manifest's local install table.
 * @param platform - the platform key.
 * @returns the raw platform variant.
 */
export function platformInstallVariant(local: HeavyLocalInstall, platform: string): HeavyPlatformInstall {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32'
    ? local.install[platform] ?? local.install.default
    : local.install.default
}

/**
 * Why the local install cannot run on one platform, when the resolved variant
 * declares `unsupported`. Install is refused with this exact reason instead of
 * executing commands the platform cannot satisfy.
 * @param manifest - heavy manifest.
 * @param platform - the platform key.
 * @returns the declared reason, or undefined when the variant runs.
 */
export function platformUnsupported(manifest: HeavyProviderManifest, platform: string): string | undefined {
  return platformInstallVariant(manifest.local, platform).unsupported
}

/**
 * Resolve the install path for one platform (`process.platform` on the host).
 * @param local - the manifest's local install table.
 * @param platform - the platform key; an unknown key uses `default`.
 * @returns the platform variant with the local defaults filled in.
 */
export function resolveHeavyInstall(local: HeavyLocalInstall, platform: string): ResolvedHeavyInstall {
  const variant = platformInstallVariant(local, platform)
  return {
    label: variant.label ?? local.label,
    deps: variant.deps ?? local.deps,
    diskHint: variant.diskHint ?? local.diskHint,
    steps: variant.steps,
  }
}

/** One credential identity a manifest's native pool declares. */
export interface HeavyManifestPoolIdentity {
  /** Stable identity key (pool state file, logs, Keys card). */
  id: string
  /** Credential reference resolved through the credentials service or the launch environment. */
  credentialRef: string
  /** Lower serves first under `priority-sticky`; omission ranks last. */
  priority?: number
  /** Disabled identities are skipped without losing their cooldown state. */
  enabled?: boolean
}

/** A provider-native credential pool a route profile declares. */
export interface HeavyManifestPool {
  /** Selection strategy; defaults to `priority-sticky`. */
  strategy?: 'priority-sticky' | 'balanced'
  /** The route's credential identities (≥ 1, unique ids); secrets never appear here. */
  identities: readonly HeavyManifestPoolIdentity[]
}

/** One heavy provider's complete declaration. */
export interface HeavyProviderManifest {
  id: string
  label: string
  summary: string
  /** llm-pi-ai wire protocol the route declares. */
  protocol: string
  /**
   * How an added route reaches its endpoint.
   * - `service` (default): a service instance this device can detect and
   *   health-probe; the manifest's addresses are loopback.
   * - `direct`: the vendor's public endpoint. There is no on-device instance
   *   to detect; status probes the declared vendor health URL directly, reuse
   *   writes the vendor baseURL without model discovery, and the route is
   *   expected to carry its own credential pool.
   */
  delivery?: 'service' | 'direct'
  /**
   * Settings namespace the route profile is written to, addressed by plugin
   * entry id. Defaults to `llm-pi-ai`; a custom-protocol provider (served by
   * its own adapter plugin) names its own namespace so the profile never
   * lands in a section whose schema cannot parse it.
   */
  settingsNs?: string
  /**
   * Provider-native credential pool written into the route profile. Required
   * to declare one's own `settingsNs`: the pool is that adapter's schema, and
   * an llm-pi-ai route must never declare one (its fronting service owns the
   * keys, or it uses a single unified key).
   */
  pool?: HeavyManifestPool
  /**
   * Route auth. `none` writes `keyless: true` (openai only); `placeholder`
   * stores an apiKeyEnv reference with no key (anthropic requires one);
   * `unified` stores one shared gateway key.
   */
  auth: {
    kind: 'none' | 'placeholder' | 'unified'
    apiKeyEnv?: string
    keyless: boolean
  }
  dashboardUrl?: string
  docsUrl?: string
  /** Loopback port the service listens on by default (detection's first candidate). */
  defaultPort: number
  /** Account flows that need a browser; rendered as badges. */
  requiresBrowser: readonly string[]
  /** Operator-facing quirks shown in Add Provider and the detail panel. */
  quirks: readonly string[]
  /**
   * Least-compute option: an instance already running on THIS device; zero
   * install. `baseURL`/`health` default to `defaultPort` and are only ever
   * retargeted by the operator's private overlay.
   */
  reuse: {
    label: string
    baseURL: string
    note: string
    health: HeavyHealth
  }
  /** Install path on this device. */
  local: HeavyLocalInstall
  /** Teardown path; warnings are the explicit confirmations the UI must show. */
  removal: {
    steps: readonly HeavyStep[]
    warnings: readonly string[]
  }
  /** One model id written when discovery returns nothing and the provider accepts it. */
  fallbackModel?: string
  /** Present when no llm-pi-ai route can exist yet; install is blocked in v1. */
  unsupported?: {
    reason: string
    plannedWith: string
    reuseUrl: string
  }
}

/**
 * Wire protocols llm-pi-ai can declare; a served manifest using any other
 * protocol must name its own `settingsNs`, or the route writer would persist
 * an unparseable profile into the llm-pi-ai section.
 */
const LLM_PI_AI_PROTOCOLS: readonly string[] = ['openai-completions', 'openai-responses', 'anthropic-messages']

/**
 * The shell tooling each local runtime's steps are expected to invoke. A
 * variant whose declared runtime names one of these but whose steps never
 * call it — while calling another runtime's tooling — is mislabeled.
 * `vendor-app` installers (curl/hdiutil/open/cmd) have no single signature.
 */
const RUNTIME_TOOL_RE: Readonly<Partial<Record<HeavyLocalRuntime, RegExp>>> = {
  docker: /\bdocker(?:-compose|\s+compose)?\b/,
  podman: /\bpodman\b/,
  node: /\b(?:node|npm|npx|pnpm|yarn)\b/,
}

/** launchd label for the antigravity user agent (macOS). */
const ANTIGRAVITY_LAUNCHD_LABEL = 'dev.enpoi.antigravity-proxy'

/**
 * The npm install step every antigravity platform shares.
 *
 * The install target is the fixed `~/.local` prefix both user-service units
 * name on their ExecStart line. A system-Node box (`/usr/lib/node_modules`) is
 * not writable by the user, and on an nvm/fnm box the default global prefix is
 * a version-manager directory the service never searches — either way a plain
 * `npm install -g` lands the binary outside the service's path. The step keeps
 * the version-manager prefixes untouched (never export NPM_CONFIG_PREFIX — it
 * breaks them). No sudo.
 */
const ANTIGRAVITY_NPM_STEP: HeavyStep = {
  label: 'Install the proxy package',
  command: 'mkdir -p "{home}/.local/bin" && npm install -g --prefix "{home}/.local" antigravity-claude-proxy',
  weight: 2,
}

/** The antigravity health wait, shared by every platform variant. */
const ANTIGRAVITY_WAIT_STEP: HeavyStep = {
  label: 'Wait for the proxy',
  command: 'for i in {1..30}; do curl -fsS http://127.0.0.1:8082/health >/dev/null && exit 0; sleep 2; done; echo "proxy did not answer within 60s"; exit 1',
}

/** Linux (and systemd-like) antigravity provisioning. */
const ANTIGRAVITY_SYSTEMD_STEPS: readonly HeavyStep[] = [
  ANTIGRAVITY_NPM_STEP,
  {
    label: 'Write the systemd user unit',
    // `start --log` is the package's foreground mode; a bare invocation only
    // prints help. The unit's main process must stay the server. The explicit
    // PATH resolves the npm shim's `node` when the version manager only
    // extends an interactive shell; the wrapper prefers the absolute path the
    // npm step guarantees and falls back to the PATH-resolved binary (a
    // version-managed node shim may live outside `~/.local/bin`).
    command: 'mkdir -p {config}/systemd/user && cat > {config}/systemd/user/antigravity-proxy.service <<\'EOF\'\n[Unit]\nDescription=Antigravity Claude proxy (per-device)\nAfter=network-online.target\n\n[Service]\nEnvironment=PORT=8082\nEnvironment=HOST=127.0.0.1\nEnvironment=PATH={home}/.local/bin:/usr/local/bin:/usr/bin:/bin\nExecStart=/bin/bash -lc \'BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log\'\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\nEOF',
  },
  { label: 'Enable and start the unit', command: 'systemctl --user daemon-reload && systemctl --user enable --now antigravity-proxy.service' },
  {
    label: 'Enable lingering (the unit starts without an open login session)',
    command: 'loginctl enable-linger "$(id -un)"',
    optional: true,
  },
  ANTIGRAVITY_WAIT_STEP,
]

/**
 * macOS antigravity provisioning: the same npm package behind a LaunchAgent.
 *
 * The agent prefers the absolute `~/.local/bin` path the npm step guarantees
 * and falls back to the PATH-resolved binary (the login-shell wrapper and the
 * PATH list Homebrew prefixes, `~/.local/bin`, and the common nvm/fnm alias
 * directories, which resolve the npm shim's `node`).
 */
const ANTIGRAVITY_LAUNCHD_STEPS: readonly HeavyStep[] = [
  ANTIGRAVITY_NPM_STEP,
  {
    label: 'Write the launchd agent',
    command: `mkdir -p {home}/Library/LaunchAgents {home}/Library/Logs && cat > {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist <<'EOF'\n<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${ANTIGRAVITY_LAUNCHD_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/bin/bash</string>\n    <string>-lc</string>\n    <string>BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PORT</key>\n    <string>8082</string>\n    <key>HOST</key>\n    <string>127.0.0.1</string>\n    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{home}/.nvm/versions/node/current/bin:{home}/Library/Application Support/fnm/aliases/default/bin:{home}/.local/share/fnm/aliases/default/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>StandardOutPath</key>\n  <string>{home}/Library/Logs/antigravity-proxy.log</string>\n  <key>StandardErrorPath</key>\n  <string>{home}/Library/Logs/antigravity-proxy.err.log</string>\n</dict>\n</plist>\nEOF`,
  },
  {
    label: 'Load and start the agent',
    command: `launchctl bootout gui/$(id -u)/${ANTIGRAVITY_LAUNCHD_LABEL} 2>/dev/null || true; launchctl bootstrap gui/$(id -u) {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist 2>/dev/null || launchctl load -w {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist`,
  },
  ANTIGRAVITY_WAIT_STEP,
]

/**
 * The commandcode vendor health probe. The vendor gate serves CLI-shaped
 * clients and may answer a generic client 4xx, so the probe carries the four
 * CLI identity headers (owner: `enpoi-commandcode-provider/src/headers.ts`)
 * and accepts the documented non-2xx statuses; a working route must never
 * read as unreachable.
 */
const COMMANDCODE_HEALTH: HeavyHealth = {
  url: 'https://api.commandcode.ai/',
  timeoutMs: 5000,
  expectStatus: [200, 401, 403, 404, 405],
  headers: {
    'x-command-code-version': '1.54.0',
    'x-cli-environment': 'production',
    'x-project-slug': 'opencode',
    'user-agent': 'cli',
  },
}

/** The commandcode setup step: link and build the provider package (idempotent). */
const COMMANDCODE_INSTALL_STEP: HeavyStep = {
  label: 'Link and build the DSH provider package',
  command: 'node "{dshHome}/profiles/web/packages/enpoi-commandcode-provider/scripts/install.mjs" "{dshHome}/profiles/web"',
  weight: 3,
}

/** The three heavy providers v1 ships. */
export const HEAVY_MANIFESTS: readonly HeavyProviderManifest[] = [
  {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    summary: 'Self-hosted free-tier gateway: ~30 providers behind one OpenAI-compatible endpoint.',
    protocol: 'openai-completions',
    auth: { kind: 'unified', apiKeyEnv: 'FREELLMAPI_API_KEY', keyless: false },
    dashboardUrl: 'http://127.0.0.1:3002',
    docsUrl: 'https://freellmapi.co',
    defaultPort: 3002,
    // Browser badges belong only to account flows that cannot complete without
    // a browser (antigravity's Google OAuth); FreeLLMAPI's dashboard steps are
    // ordinary quirks, not an operator-blocking browser requirement.
    requiresBrowser: [],
    quirks: [
      'Local install dependencies: Linux uses Docker/Podman compose; macOS/Windows use the vendor desktop app (no Docker needed there)',
      'First-run setup code and password-reset code appear only in `docker compose logs`; upstream provider keys are added on the web dashboard',
      'Unified key is the only client auth — never expose this port beyond the local machine',
      'Losing ENCRYPTION_KEY (in ~/freellmapi/.env) makes every stored upstream key unrecoverable',
      'The free-tier catalog is a monthly snapshot; /v1/models can list models no key serves',
      'A missing bind-mounted JSON file is created as a directory by Docker → boot loop',
      'Windows: the desktop-app install steps run through Git Bash (the harness executes shell steps with bash) — install Git for Windows first',
    ],
    reuse: {
      label: 'Use a detected instance',
      baseURL: 'http://127.0.0.1:3002/v1',
      note: 'Zero install: uses a FreeLLMAPI instance already running on this device.',
      health: { url: 'http://127.0.0.1:3002/api/ping', timeoutMs: 5000 },
    },
    local: {
      label: 'Install locally (Docker or Podman)',
      baseURL: 'http://127.0.0.1:3002/v1',
      deps: ['Docker Engine or Podman, with Compose'],
      diskHint: '~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU',
      dashboardUrl: 'http://127.0.0.1:3002',
      runtime: 'docker',
      install: {
        // Unknown platforms fall back to the manual Docker Compose path.
        default: {
          steps: [
            // Re-running the install must not fail on the existing clone. A
            // stale non-git directory is replaced, but a `.env` inside it is
            // never wiped: it holds ENCRYPTION_KEY, and deleting it makes
            // every stored upstream key unrecoverable.
            { label: 'Clone FreeLLMAPI', command: 'if [ -d "{home}/freellmapi" ] && [ ! -d "{home}/freellmapi/.git" ]; then if [ -f "{home}/freellmapi/.env" ]; then echo "Existing {home}/freellmapi/.env found without .git; refusing to wipe it — move the directory aside, then retry" >&2; exit 1; fi; rm -rf "{home}/freellmapi" 2>/dev/null || true; fi; test -d "{home}/freellmapi/.git" || git clone --depth 1 https://github.com/tashfeenahmed/freellmapi "{home}/freellmapi"', weight: 2 },
            {
              label: 'Generate ENCRYPTION_KEY',
              // PORT is the HOST port (compose maps ${PORT}:3001); keep it at
              // 3002 so the local route's baseURL resolves. An existing .env
              // is kept only when its ENCRYPTION_KEY is non-empty: an empty
              // key makes every stored upstream key unrecoverable.
              command: 'if [ ! -f "{home}/freellmapi/.env" ] || ! grep -qE \'^ENCRYPTION_KEY=.+\' "{home}/freellmapi/.env"; then printf "ENCRYPTION_KEY=%s\\nPORT=3002\\nHOST_BIND=127.0.0.1\\n" "$(openssl rand -hex 32)" > "{home}/freellmapi/.env"; fi',
            },
            {
              label: 'Start the stack',
              // Docker or Podman: preflight offers Podman as the substitute,
              // so the step must resolve whichever engine exists. A Podman
              // without its compose plugin has to fail here, not midway
              // through `up`.
              command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" || { echo "neither docker nor podman is installed"; exit 1; }; "$ENGINE" compose version >/dev/null 2>&1 || { echo "podman compose plugin missing (need podman-compose)"; exit 1; }; "$ENGINE" compose up -d',
              cwd: '{home}/freellmapi',
            },
            {
              label: 'Wait for the gateway',
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
            },
          ],
        },
        // No linux override: the vendor one-liner is Docker-only, while
        // preflight accepts Podman as the substitute runtime, so Linux uses
        // the same engine-aware compose path as every other platform.
        // macOS prefers the vendor desktop app: no Docker Desktop overhead.
        darwin: {
          label: 'Install locally (vendor desktop app, no Docker)',
          deps: ['macOS 11+'],
          diskHint: '~250 MB app; data in ~/Library/Application Support/FreeLLMAPI',
          runtime: 'vendor-app',
          steps: [
            {
              label: 'Download the latest .dmg',
              // Apple Silicon and Intel ship separate disk images; picking by
              // `uname -m` keeps the install correct on both. The asset name
              // ends `-<arch>.dmg`, so the pattern must carry that hyphen (a
              // `"arm64` pattern can never match). A re-run keeps the image
              // already in ~/Downloads.
              command: 'arch="$(uname -m)"; test "$arch" = arm64 || arch=x64; url="$(curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+-\'"$arch"\'\\.dmg"\' | head -1 | cut -d\'"\' -f4)"; test -n "$url" || { echo "no FreeLLMAPI $arch .dmg in the latest release"; exit 1; }; mkdir -p "{home}/Downloads"; test -f "{home}/Downloads/FreeLLMAPI.dmg" || curl -fsSL -o "{home}/Downloads/FreeLLMAPI.dmg" "$url"',
              weight: 2,
            },
            {
              label: 'Install the app from the disk image',
              // A per-run mount point is detached and removed even when the
              // copy fails, so a hung volume never blocks the next attempt.
              command: 'MOUNT="/tmp/freellmapi-dmg-$$"; mkdir -p "$MOUNT"; hdiutil attach "{home}/Downloads/FreeLLMAPI.dmg" -nobrowse -quiet -mountpoint "$MOUNT" && cp -R "$MOUNT"/*.app /Applications/; status=$?; hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true; rmdir "$MOUNT" 2>/dev/null || true; exit $status',
            },
            {
              label: 'Pin the desktop app to port 3002',
              command: 'mkdir -p "{home}/Library/Application Support/FreeLLMAPI" && printf \'{"port":3002}\\n\' > "{home}/Library/Application Support/FreeLLMAPI/config.json"',
            },
            { label: 'Launch FreeLLMAPI', command: 'open -a FreeLLMAPI' },
            {
              label: 'Wait for the gateway',
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
            },
          ],
        },
        // Windows only ships a desktop app (no Docker path in the vendor docs).
        win32: {
          label: 'Install locally (vendor desktop app, no Docker)',
          deps: ['Windows 10+', 'Git Bash (the install steps run through bash)'],
          diskHint: '~250 MB app; data in %APPDATA%\\FreeLLMAPI',
          runtime: 'vendor-app',
          steps: [
            {
              label: 'Download the latest installer',
              // The matched URL lands in a file first: an empty match has to
              // fail the step instead of feeding xargs an empty string.
              command: 'mkdir -p "{home}/Downloads" && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+\\.exe"\' | head -1 | cut -d\'"\' -f4 > "{home}/Downloads/freellmapi-setup-url"; test -s "{home}/Downloads/freellmapi-setup-url" || { echo "no .exe in the latest release"; exit 1; }; xargs -I{} curl -fsSL -o "{home}/Downloads/FreeLLMAPI-Setup.exe" {} < "{home}/Downloads/freellmapi-setup-url"',
              weight: 2,
            },
            { label: 'Install silently', command: 'cmd //c start //wait "" "$HOME/Downloads/FreeLLMAPI-Setup.exe" /S' },
            {
              label: 'Pin the desktop app to port 3002',
              command: 'mkdir -p "$APPDATA/FreeLLMAPI" && printf \'{"port":3002}\\n\' > "$APPDATA/FreeLLMAPI/config.json"',
            },
            { label: 'Launch FreeLLMAPI', command: 'cmd //c start "" "$LOCALAPPDATA\\Programs\\FreeLLMAPI\\FreeLLMAPI.exe"' },
            {
              label: 'Wait for the gateway',
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
            },
          ],
        },
      },
      health: { url: 'http://127.0.0.1:3002/api/ping', timeoutMs: 5000 },
    },
    removal: {
      steps: [
        // Resolve the engine the same way the install did; every step is
        // fail-soft so a machine that moved to another engine still cleans up.
        { label: 'Stop the stack and drop its volume', command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" && "$ENGINE" compose down -v', cwd: '{home}/freellmapi', optional: true },
        { label: 'Remove the container image', command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" && "$ENGINE" image rm ghcr.io/tashfeenahmed/freellmapi:latest', optional: true },
        { label: 'Remove the clone directory', command: 'rm -rf "{home}/freellmapi"' },
        // The vendor desktop-app leftovers are platform-guarded: each step
        // exits cleanly on the platforms it does not own and never fails a
        // teardown.
        {
          label: 'Remove the macOS desktop app and its data',
          optional: true,
          command: 'test "$(uname -s)" = Darwin || exit 0; pkill -f FreeLLMAPI 2>/dev/null || true; hdiutil detach "/tmp/freellmapi-dmg" >/dev/null 2>&1 || true; rm -rf /Applications/FreeLLMAPI.app "{home}/Library/Application Support/FreeLLMAPI" "{home}/Downloads/FreeLLMAPI.dmg" /tmp/freellmapi-dmg',
        },
        {
          label: 'Remove the Windows desktop app and its data',
          optional: true,
          command: 'case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) exit 0;; esac; taskkill //F //IM FreeLLMAPI.exe 2>/dev/null || true; rm -rf "$APPDATA/FreeLLMAPI" "$LOCALAPPDATA/Programs/FreeLLMAPI" "$HOME/Downloads/FreeLLMAPI-Setup.exe"',
        },
      ],
      warnings: [
        '`docker compose down -v` deletes volume freellmapi_freellmapi-data — every upstream key and the unified key die with it',
        '~/freellmapi/.env holds ENCRYPTION_KEY; back it up if the volume data is kept anywhere',
      ],
    },
    fallbackModel: 'auto',
  },
  {
    id: 'antigravity',
    label: 'Antigravity Proxy',
    summary: 'Multi-account Anthropic-compatible proxy for Google Antigravity OAuth accounts.',
    protocol: 'anthropic-messages',
    // The proxy itself needs no client key, but llm-pi-ai refuses
    // keyless anthropic routes: a placeholder reference is stored, and the
    // route MUST NOT declare a DSH pool — the proxy runs its own sticky one.
    auth: { kind: 'placeholder', apiKeyEnv: 'ANTIGRAVITY_API_KEY', keyless: false },
    dashboardUrl: 'http://127.0.0.1:8082',
    docsUrl: 'https://www.npmjs.com/package/antigravity-claude-proxy',
    defaultPort: 8082,
    requiresBrowser: [
      'Adding a Google account is an OAuth flow that opens a browser and waits on a localhost callback — on a headless host the printed URL must be opened from a machine that can reach the callback (e.g. over an SSH port-forward); it cannot be automated',
    ],
    quirks: [
      'Local install dependencies: native npm package (Node.js >= 18) behind a systemd or launchd user service on Linux/macOS; Docker is never required. Windows has no supported local install — run the package manually or use a proxy running elsewhere',
      'Linux: the systemd user unit runs the proxy through /bin/bash -lc with PATH ~/.local/bin:/usr/local/bin:/usr/bin:/bin; the package installs under ~/.local/bin, and a Node.js reachable only from an nvm/fnm shell configuration is not found — keep it reachable from a login shell or one of those directories',
      'macOS: the launchd agent runs the proxy through /bin/bash -lc with PATH /opt/homebrew/bin:/usr/local/bin:~/.local/bin plus the common nvm/fnm node directories; the package installs under ~/.local/bin, and a Node.js reachable only from a fish/zsh/nvm/fnm shell configuration is not found — keep it reachable from a login bash profile or one of those directories',
      'The proxy runs its own sticky account pool with cooldowns — DSH key pooling MUST stay off for this route',
      'The console at :8082 has no auth (webuiPassword empty) — trusted networks only',
      'Quotas are per-account/per-model weekly windows; "RESOURCE_EXHAUSTED … resets after 46h" is normal',
      'Other tools on this device may consume the same proxy — removing the service breaks them too',
    ],
    reuse: {
      label: 'Use a detected instance',
      baseURL: 'http://127.0.0.1:8082',
      note: 'Zero install: uses the proxy instance already running on this device and its configured account pool.',
      health: { url: 'http://127.0.0.1:8082/health', timeoutMs: 5000 },
    },
    local: {
      label: 'Install locally (npm + user service)',
      baseURL: 'http://127.0.0.1:8082',
      deps: ['Node.js >= 18', 'A reachable systemd user session (systemctl --user) on the default path'],
      diskHint: '~23 MB install, ~78–150 MB RAM, no GPU',
      dashboardUrl: 'http://127.0.0.1:8082',
      runtime: 'node',
      install: {
        // The npm package is cross-platform; the user-service wrapper is not.
        // Linux (and systemd-like hosts) keeps the systemd unit; macOS gets the
        // launchd equivalent; Windows has no POSIX user service to install.
        default: { label: 'Install locally (npm + systemd user unit)', steps: ANTIGRAVITY_SYSTEMD_STEPS },
        linux: { label: 'Install locally (npm + systemd user unit)', steps: ANTIGRAVITY_SYSTEMD_STEPS },
        darwin: {
          label: 'Install locally (npm + launchd agent)',
          deps: ['Node.js >= 18', 'macOS 11+ (launchd)'],
          diskHint: '~23 MB install, ~78–150 MB RAM, no GPU; logs in ~/Library/Logs',
          steps: ANTIGRAVITY_LAUNCHD_STEPS,
        },
        win32: {
          label: 'Not supported on Windows',
          unsupported: 'The antigravity proxy local install needs a POSIX user service (systemd or launchd) to keep the proxy running; this profile has no supported Windows provisioning path. Install the npm package and run `antigravity-claude-proxy` yourself, or run the proxy on another machine and add it as a custom route.',
          steps: [],
        },
      },
      health: { url: 'http://127.0.0.1:8082/health', timeoutMs: 5000 },
    },
    removal: {
      // Platform-neutral on purpose: the same teardown runs on Linux and macOS
      // and touches whichever user-service file the platform used.
      steps: [
        {
          label: 'Stop and disable the user service',
          optional: true,
          command: `if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now antigravity-proxy.service 2>/dev/null || true; fi; if command -v launchctl >/dev/null 2>&1; then launchctl bootout gui/$(id -u)/${ANTIGRAVITY_LAUNCHD_LABEL} 2>/dev/null || true; fi; if command -v antigravity-claude-proxy >/dev/null 2>&1; then antigravity-claude-proxy stop >/dev/null 2>&1 || true; fi`,
        },
        {
          label: 'Remove the user service file',
          optional: true,
          command: `rm -f {config}/systemd/user/antigravity-proxy.service {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist; if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload 2>/dev/null || true; fi`,
        },
        // The package may live in `~/.local` (the install's prefix) or in a
        // version-manager global prefix a previous setup used; both are
        // uninstalled, fail-soft, so neither location keeps a stale binary.
        {
          label: 'Uninstall the package',
          optional: true,
          command: 'npm uninstall -g --prefix "{home}/.local" antigravity-claude-proxy 2>/dev/null || true; npm uninstall -g antigravity-claude-proxy 2>/dev/null || true',
        },
        { label: 'Remove the config directory (OAuth tokens, presets, usage history)', command: 'rm -rf {config}/antigravity-proxy' },
      ],
      warnings: [
        'Any other tool configured against the same proxy stops working when the service is removed',
        'If a dotfiles/config repository manages the service file (systemd unit or launchd plist), remove it there too or the next sync resurrects it',
        'Deleting ~/.config/antigravity-proxy destroys every Google OAuth token and the usage history',
        'DSH route, credential, pool state, discovered cache, and chain links are removed separately by this teardown',
      ],
    },
    fallbackModel: 'gemini-2.5-flash',
  },
  {
    id: 'commandcode',
    label: 'Command Code',
    summary: 'Command Code\'s CLI-shaped API at api.commandcode.ai, served by the DSH provider package and its native multi-key pool — no proxy.',
    protocol: 'commandcode/alpha-generate',
    // The vendor is reached directly. The route profile carries its own key
    // pool: identities and priorities live in this route's settings namespace
    // (commandcode-provider) and the secrets live in the credentials store
    // (Settings → Models Keys card) or the environment. The provider package
    // injects the four CLI headers and rotates identities itself; the
    // standalone keypool proxy is not involved.
    auth: { kind: 'unified', apiKeyEnv: 'COMMANDCODE_KEY_1', keyless: false },
    delivery: 'direct',
    docsUrl: 'https://commandcode.ai',
    defaultPort: 443,
    // Served by `dsh-enpoi-commandcode-provider` (ctx.llm.registerAdapter), not
    // llm-pi-ai: the CLI-shaped protocol has no llm-pi-ai entry, so the route
    // profile must never be written into the llm-pi-ai schema.
    settingsNs: 'commandcode-provider',
    // The route is pooled from its first request: an anonymous request cannot
    // pass the vendor gate, so the shipped starter identity gives the Keys
    // card its first key slot and a credential-less request fails with the
    // MISSING_CREDENTIAL action instead of falling back to keyless.
    pool: {
      strategy: 'priority-sticky',
      identities: [{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }],
    },
    // Browser badges belong only to account flows that cannot complete without
    // a browser (antigravity's Google OAuth); the vendor dashboard is an
    // ordinary quirk here, not an operator-blocking browser requirement.
    requiresBrowser: [],
    quirks: [
      'Local install dependencies: Node.js 22 (the setup step links and builds the provider package); Docker is never required, and no proxy or user service runs — the route talks to the vendor directly',
      'The vendor endpoint rejects generic HTTP clients ("Proxy use detected") — the provider package injects the four CLI headers itself; no proxy is required',
      'Keys are managed as pool identities on the Settings → Models Keys card: the route ships one starter identity (COMMANDCODE_KEY_1) and rotates identities in priority order',
      'The vendor account and quota dashboard live at commandcode.ai (browser)',
      'DSH speaks this protocol through the dsh-enpoi-commandcode-provider adapter; llm-pi-ai cannot declare it',
      'Migration: scripts/import-keypool-keys.mjs turns the old keypool pools.json commandcode keys into a settings pool block; it reads the old file but never prints key material',
      'An existing route still pointed at a loopback keypool keeps working until it is switched: set its baseURL to https://api.commandcode.ai, add the imported pool identities, then retire the proxy',
      'The provider package owns the request sanitizer (embedded-base64 scrub, 200k text cap, 413 strip-oldest retry) — clients must not duplicate it',
      'Quota is per key and real: the native pool rotates on exhaustion, and a QUOTA failure ("weekly usage limit" / "insufficient credits") appears only when every pooled identity is spent — a normal state, not a routing defect',
      'A route whose identities resolve no credential fails with MISSING_CREDENTIAL naming the Keys card; there is no anonymous fallback',
    ],
    reuse: {
      label: 'Use the vendor endpoint now',
      baseURL: 'https://api.commandcode.ai',
      note: 'Writes the route at the vendor endpoint after confirming it answers; run the local setup first when the provider package is not linked yet.',
      health: COMMANDCODE_HEALTH,
    },
    local: {
      label: 'Link the provider package, then use the vendor endpoint',
      baseURL: 'https://api.commandcode.ai',
      deps: ['Node.js 22'],
      diskHint: '~5 MB provider package; no local service, no GPU',
      runtime: 'node',
      install: {
        // The setup is one shared, idempotent step; there is no service to
        // wrap and no proxy to deploy on any platform.
        default: { steps: [COMMANDCODE_INSTALL_STEP] },
        linux: { steps: [COMMANDCODE_INSTALL_STEP] },
        darwin: { steps: [COMMANDCODE_INSTALL_STEP] },
        win32: {
          label: 'Not supported on Windows',
          unsupported: 'The provider-package setup step runs through /bin/bash, which this profile does not provide on Windows. Link the package manually: from the profile root (normally ~/.dsh/profiles/web) run `node packages/enpoi-commandcode-provider/scripts/install.mjs .`, or run the harness on Linux/macOS.',
          steps: [],
        },
      },
      health: COMMANDCODE_HEALTH,
    },
    removal: {
      // No local service exists: the vendor endpoint needs no teardown and the
      // provider package is part of the shipped profile.
      steps: [],
      warnings: [
        'Removal drops only DSH state — the route, its COMMANDCODE_KEY_1 credential reference, its pool state, and its cache entry; no local service exists to stop',
        'Vendor keys stored under other pool identities (for example COMMANDCODE_KEY_2) are not deleted by removal — delete them on the Keys card',
        'Vendor account state and quota live at commandcode.ai and are never touched',
      ],
    },
    fallbackModel: 'deepseek/deepseek-v4.1-flash',
  },
]

/** Resolve one manifest by route id. */
export function manifestById(id: string): HeavyProviderManifest | undefined {
  return HEAVY_MANIFESTS.find(manifest => manifest.id === id)
}

/**
 * Structural validation of the manifest table. Returns one message per
 * problem; empty means every manifest is complete. Wired into the test suite
 * and logged once at boot (a malformed manifest must not brick the plugin).
 */
export function manifestProblems(manifests: readonly HeavyProviderManifest[] = HEAVY_MANIFESTS): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const manifest of manifests) {
    const where = `manifest "${manifest.id}"`
    if (manifest.id === '') problems.push(`${where}: id is empty`)
    if (seen.has(manifest.id)) problems.push(`${where}: duplicate id`)
    seen.add(manifest.id)
    for (const [field, value] of [['label', manifest.label], ['summary', manifest.summary], ['protocol', manifest.protocol]] as const) {
      if (typeof value !== 'string' || value.trim() === '') problems.push(`${where}: ${field} is empty`)
    }
    if (!Number.isInteger(manifest.defaultPort) || manifest.defaultPort < 1 || manifest.defaultPort > 65_535) {
      problems.push(`${where}: defaultPort must be a TCP port`)
    }
    if (manifest.reuse.baseURL === '' && manifest.unsupported === undefined) problems.push(`${where}: reuse.baseURL is empty`)
    if (manifest.reuse.health.url === '') problems.push(`${where}: reuse.health.url is empty`)
    const variants = [manifest.local.install.default, manifest.local.install.linux, manifest.local.install.darwin, manifest.local.install.win32]
    if (manifest.unsupported === undefined) {
      if (manifest.local.install.default.steps.length === 0) problems.push(`${where}: local.install.default is empty`)
      if (manifest.local.baseURL === '') problems.push(`${where}: local.baseURL is empty`)
      if (manifest.local.health.url === '') problems.push(`${where}: local.health.url is empty`)
    }
    for (const [index, variant] of variants.entries()) {
      if (variant === undefined) continue
      const variantWhere = `${where}: platform install variant ${String(index)}`
      if (variant.unsupported !== undefined && variant.unsupported.trim() === '') {
        problems.push(`${variantWhere} declares an empty unsupported reason`)
      }
      if (variant.steps.length === 0 && variant.unsupported === undefined && manifest.unsupported === undefined) {
        problems.push(`${variantWhere} has no steps`)
      }
      for (const requirement of variant.requiresFiles ?? []) {
        if (requirement.paths.length === 0 || requirement.hint.trim() === '') {
          problems.push(`${variantWhere} file requirement needs at least one path and a hint`)
        }
      }
      // A refused variant never runs its steps, so the runtime/tooling check
      // does not apply to it.
      if (variant.unsupported !== undefined) continue
      // The declared runtime must match the tooling the steps invoke: a
      // docker-runtime variant whose steps are npm installs (or vice versa)
      // installs under the wrong dependency banner, so it is rejected.
      const runtime = variant.runtime ?? manifest.local.runtime
      const declared = runtime === undefined ? undefined : RUNTIME_TOOL_RE[runtime]
      if (declared === undefined || variant.steps.length === 0) continue
      const commands = variant.steps.map(step => step.command).join('\n')
      if (declared.test(commands)) continue
      const conflicting = (Object.keys(RUNTIME_TOOL_RE) as HeavyLocalRuntime[])
        .filter(other => other !== runtime && RUNTIME_TOOL_RE[other]?.test(commands) === true)
      if (conflicting.length > 0) {
        problems.push(`${variantWhere} declares runtime "${String(runtime)}" but its steps invoke ${conflicting.join('/')} tooling instead`)
      }
    }
    if (manifest.settingsNs !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.settingsNs)) {
      problems.push(`${where}: settingsNs must be a lowercase plugin entry id`)
    }
    if (manifest.unsupported === undefined && !LLM_PI_AI_PROTOCOLS.includes(manifest.protocol) && manifest.settingsNs === undefined) {
      problems.push(`${where}: protocol "${manifest.protocol}" is not served by llm-pi-ai and needs an explicit settingsNs`)
    }
    // A direct vendor route has no gatekeeper in front of it: without a pool
    // or a key reference it can only send the anonymous request the vendor
    // rejects, so the declaration itself is broken.
    if (manifest.delivery === 'direct' && manifest.unsupported === undefined
      && manifest.pool === undefined && manifest.auth.kind === 'none') {
      problems.push(`${where}: a direct route must declare a key pool or a non-keyless auth kind`)
    }
    if (manifest.pool !== undefined) {
      // An llm-pi-ai route must never declare a DSH pool: its fronting
      // service owns the keys (antigravity) or it uses one unified key
      // (freellmapi). A provider served by its own adapter owns its own pool
      // schema, and that namespace is exactly what settingsNs names.
      if (manifest.settingsNs === undefined) {
        problems.push(`${where}: a key pool needs its own settingsNs; llm-pi-ai routes must not declare one`)
      }
      if (manifest.pool.identities.length === 0) problems.push(`${where}: the key pool declares no identities`)
      const identityIds = new Set<string>()
      for (const identity of manifest.pool.identities) {
        if (identity.id === '') problems.push(`${where}: a key-pool identity has an empty id`)
        if (identityIds.has(identity.id)) problems.push(`${where}: key-pool identity id "${identity.id}" is duplicated`)
        identityIds.add(identity.id)
        if (!/^[A-Z_][A-Z0-9_]*$/.test(identity.credentialRef)) {
          problems.push(`${where}: key-pool identity "${identity.id}" credentialRef must be an uppercase credential reference`)
        }
        if (identity.priority !== undefined && (!Number.isSafeInteger(identity.priority) || identity.priority < 0)) {
          problems.push(`${where}: key-pool identity "${identity.id}" priority must be a non-negative integer`)
        }
        if (identity.enabled !== undefined && typeof identity.enabled !== 'boolean') {
          problems.push(`${where}: key-pool identity "${identity.id}" enabled must be a boolean`)
        }
      }
    }
    if (manifest.removal.warnings.length === 0) problems.push(`${where}: removal.warnings is empty`)
    if (manifest.auth.kind === 'none' && manifest.protocol === 'anthropic-messages') {
      problems.push(`${where}: keyless anthropic routes are refused by llm-pi-ai`)
    }
    if (manifest.auth.kind !== 'none' && (manifest.auth.apiKeyEnv === undefined || !/^[A-Z_][A-Z0-9_]*$/.test(manifest.auth.apiKeyEnv))) {
      problems.push(`${where}: apiKeyEnv must be an uppercase credential reference`)
    }
    if (manifest.auth.kind === 'placeholder' && manifest.auth.keyless) {
      problems.push(`${where}: a placeholder-auth route cannot be keyless`)
    }
    for (const step of [...variants.flatMap(variant => variant?.steps ?? []), ...manifest.removal.steps]) {
      if (step.command.trim() === '') problems.push(`${where}: a step command is empty (${step.label})`)
    }
  }
  return problems
}
