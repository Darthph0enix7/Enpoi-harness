/**
 * PRE-CONNECTION FALLBACK heavy-provider manifests.
 *
 * The host's `enpoiHeavy.manifests` reply is the single source of truth for
 * everything the Add Provider and provider-detail surfaces render (see
 * `heavy-manifest-source.ts`): the running profile plugin executes those
 * manifests, so only they can say whether a provider is addable. This table
 * is the small, clearly-labelled fallback the page renders before the first
 * host reply — it mirrors the host table's ids and facts but is never
 * authoritative, and a host reply replaces it wholesale.
 *
 * Every URL here is loopback: an operator's own server lives in the host's
 * private `$DSH_HOME/heavy-server-overlay.json`, never in this table.
 *
 * @module ui-settings-models/heavy-providers
 */

/** One shell step of an install or teardown run. */
export interface HeavyProviderStep {
  /** Human stage label shown in the progress UI. */
  label: string
  /** Shell command executed by the host's generic step runner. */
  command: string
  /** Working directory override (placeholders allowed). */
  cwd?: string
  /** A failing optional step does not fail the run. */
  optional?: boolean
  /** Relative progress weight (default 1). */
  weight?: number
}

/** One HTTP health probe. */
export interface HeavyProviderHealth {
  url: string
  /** Accepted HTTP statuses; default any 2xx. */
  expectStatus?: readonly number[]
  /** Substring the response body must contain when set. */
  expectBody?: string
  timeoutMs?: number
}

/** What a local install path needs on the machine. */
export type HeavyLocalRuntime = 'vendor-app' | 'docker' | 'podman' | 'node'

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
  /** Steps executed in order for this platform. */
  steps: readonly HeavyProviderStep[]
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
  health: HeavyProviderHealth
}

/** The platforms with a declared install variant. */
export const HEAVY_PLATFORMS = ['linux', 'darwin', 'win32'] as const

/** A platform key accepted by {@link resolveHeavyInstall}. */
export type HeavyPlatform = (typeof HEAVY_PLATFORMS)[number]

/** One platform's install resolved against the local defaults. */
export interface ResolvedHeavyInstall {
  label: string
  deps: readonly string[]
  diskHint: string
  steps: readonly HeavyProviderStep[]
}

/**
 * Resolve the install path for one platform (`process.platform` on the host).
 * @param local - the manifest's local install table.
 * @param platform - the platform key; an unknown key uses `default`.
 * @returns the platform variant with the local defaults filled in.
 */
export function resolveHeavyInstall(local: HeavyLocalInstall, platform: string): ResolvedHeavyInstall {
  const variant = platform === 'linux' || platform === 'darwin' || platform === 'win32'
    ? local.install[platform] ?? local.install.default
    : local.install.default
  return {
    label: variant.label ?? local.label,
    deps: variant.deps ?? local.deps,
    diskHint: variant.diskHint ?? local.diskHint,
    steps: variant.steps,
  }
}

/**
 * Dashboard URLs the operator should be able to open: the detected
 * instance's dashboard and the loopback dashboard of a local install (both
 * loopback by default, so they usually deduplicate to one URL).
 * @param manifest - the heavy manifest.
 * @param mode - restrict to one mode; omitted returns both (deduplicated).
 * @returns URLs in display order (detected endpoint first).
 */
export function heavyDashboardUrls(manifest: HeavyProviderManifest, mode?: 'reuse' | 'local'): string[] {
  const localUrl = manifest.local.dashboardUrl ?? manifest.dashboardUrl
  const entries = mode === 'reuse'
    ? [manifest.dashboardUrl]
    : mode === 'local'
      ? [localUrl]
      : [manifest.dashboardUrl, localUrl]
  return [...new Set(entries.filter((url): url is string => url !== undefined && url !== ''))]
}

/** One heavy provider's complete declaration. */
export interface HeavyProviderManifest {
  id: string
  label: string
  summary: string
  /** llm-pi-ai wire protocol the route declares. */
  protocol: string
  /**
   * Settings namespace the route profile is written to, addressed by plugin
   * entry id. Defaults to `llm-pi-ai`; a custom-protocol provider names its
   * own adapter plugin's namespace so the profile never lands in a section
   * whose schema cannot parse it.
   */
  settingsNs?: string
  /**
   * Route auth. `none` writes `keyless: true` (openai only); `placeholder`
   * stores an apiKeyEnv reference with no key (anthropic requires one);
   * `unified` stores one shared gateway key. Never a DSH key pool.
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
   * retargeted by the host's private server overlay.
   */
  reuse: {
    label: string
    baseURL: string
    note: string
    health: HeavyProviderHealth
  }
  /** Install path on this device. */
  local: HeavyLocalInstall
  /** Teardown path; warnings are the explicit confirmations the UI must show. */
  removal: {
    steps: readonly HeavyProviderStep[]
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

/** The three heavy providers v1 ships (the pre-connection fallback). */
export const FALLBACK_HEAVY_PROVIDER_MANIFESTS: readonly HeavyProviderManifest[] = [
  {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    summary: 'Self-hosted free-tier gateway: ~30 providers behind one OpenAI-compatible endpoint.',
    protocol: 'openai-completions',
    auth: { kind: 'unified', apiKeyEnv: 'FREELLMAPI_API_KEY', keyless: false },
    dashboardUrl: 'http://127.0.0.1:3002',
    docsUrl: 'https://freellmapi.co',
    defaultPort: 3002,
    requiresBrowser: [
      'First-run setup code and password-reset code appear only in `docker compose logs` — a browser flow, not automatable',
      'Upstream provider keys are added on the web dashboard',
    ],
    quirks: [
      'Unified key is the only client auth — never expose this port beyond the local machine',
      'Losing ENCRYPTION_KEY (in ~/freellmapi/.env) makes every stored upstream key unrecoverable',
      'The free-tier catalog is a monthly snapshot; /v1/models can list models no key serves',
      'A missing bind-mounted JSON file is created as a directory by Docker → boot loop',
    ],
    reuse: {
      label: 'Use a detected instance',
      baseURL: 'http://127.0.0.1:3002/v1',
      note: 'Zero install: uses a FreeLLMAPI instance already running on this device.',
      health: { url: 'http://127.0.0.1:3002/api/ping', timeoutMs: 5000 },
    },
    local: {
      label: 'Install locally (Docker)',
      baseURL: 'http://127.0.0.1:3002/v1',
      deps: ['Docker Engine + Compose'],
      diskHint: '~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU',
      dashboardUrl: 'http://127.0.0.1:3002',
      runtime: 'docker',
      install: {
        // Unknown platforms fall back to the manual Docker Compose path.
        default: {
          steps: [
            { label: 'Clone FreeLLMAPI', command: 'git clone --depth 1 https://github.com/tashfeenahmed/freellmapi {home}/freellmapi', weight: 2 },
            {
              label: 'Generate ENCRYPTION_KEY',
              // PORT is the HOST port (compose maps ${PORT}:3001); keep it at
              // 3002 so the local route's baseURL resolves.
              command: 'test -f {home}/freellmapi/.env || printf "ENCRYPTION_KEY=%s\\nPORT=3002\\nHOST_BIND=127.0.0.1\\n" "$(openssl rand -hex 32)" > {home}/freellmapi/.env',
            },
            { label: 'Start the stack', command: 'docker compose up -d', cwd: '{home}/freellmapi' },
            {
              label: 'Wait for the gateway',
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
            },
          ],
        },
        // The vendor one-liner is the documented Linux/macOS server install;
        // PORT=3002 keeps the route baseURL valid.
        linux: {
          label: 'Install locally (vendor one-liner, Docker)',
          steps: [
            {
              label: 'Run the FreeLLMAPI one-liner',
              command: 'curl -fsSL https://freellmapi.co/install.sh | PORT=3002 HOST_BIND=127.0.0.1 bash',
              weight: 3,
            },
            {
              label: 'Wait for the gateway',
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
            },
          ],
        },
        // macOS prefers the vendor desktop app: no Docker Desktop overhead.
        darwin: {
          label: 'Install locally (vendor desktop app, no Docker)',
          deps: ['macOS 11+'],
          diskHint: '~250 MB app; data in ~/Library/Application Support/FreeLLMAPI',
          runtime: 'vendor-app',
          steps: [
            {
              label: 'Download the latest .dmg',
              command: 'mkdir -p {home}/Downloads && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+\\.dmg"\' | head -1 | cut -d\'"\' -f4 | xargs -I{} curl -fsSL -o {home}/Downloads/FreeLLMAPI.dmg {}',
              weight: 2,
            },
            {
              label: 'Install the app from the disk image',
              command: 'hdiutil attach {home}/Downloads/FreeLLMAPI.dmg -nobrowse -quiet -mountpoint /tmp/freellmapi-dmg && cp -R /tmp/freellmapi-dmg/*.app /Applications/ && hdiutil detach /tmp/freellmapi-dmg -quiet',
            },
            {
              label: 'Pin the desktop app to port 3002',
              command: 'mkdir -p {home}/Library/Application\\ Support/FreeLLMAPI && printf \'{"port":3002}\\n\' > {home}/Library/Application\\ Support/FreeLLMAPI/config.json',
            },
            { label: 'Launch FreeLLMAPI', command: 'open -a FreeLLMAPI' },
            {
              label: 'Wait for the gateway',
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
            },
          ],
        },
        // Windows only ships a desktop app (no Docker path in the vendor docs).
        win32: {
          label: 'Install locally (vendor desktop app, no Docker)',
          deps: ['Windows 10+'],
          diskHint: '~250 MB app; data in %APPDATA%\\FreeLLMAPI',
          runtime: 'vendor-app',
          steps: [
            {
              label: 'Download the latest installer',
              command: 'mkdir -p {home}/Downloads && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+\\.exe"\' | head -1 | cut -d\'"\' -f4 | xargs -I{} curl -fsSL -o {home}/Downloads/FreeLLMAPI-Setup.exe {}',
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
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
            },
          ],
        },
      },
      health: { url: 'http://127.0.0.1:3002/api/ping', timeoutMs: 5000 },
    },
    removal: {
      steps: [
        { label: 'Stop the stack and drop its volume', command: 'docker compose down -v', cwd: '{home}/freellmapi', optional: true },
        { label: 'Remove the container image', command: 'docker image rm ghcr.io/tashfeenahmed/freellmapi:latest', optional: true },
        { label: 'Remove the clone directory', command: 'rm -rf {home}/freellmapi' },
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
      label: 'Install locally (npm + systemd user unit)',
      baseURL: 'http://127.0.0.1:8082',
      deps: ['Node.js >= 18'],
      diskHint: '~23 MB install, ~78–150 MB RAM, no GPU',
      dashboardUrl: 'http://127.0.0.1:8082',
      runtime: 'node',
      install: {
        default: {
          steps: [
            { label: 'Install the proxy package', command: 'npm install -g antigravity-claude-proxy', weight: 2 },
            {
              label: 'Write the systemd user unit',
              command: 'mkdir -p {config}/systemd/user && cat > {config}/systemd/user/antigravity-proxy.service <<\'EOF\'\n[Unit]\nDescription=Antigravity Claude proxy (per-device)\nAfter=network-online.target\n\n[Service]\nEnvironment=PORT=8082\nEnvironment=HOST=127.0.0.1\nExecStart=/bin/bash -lc \'exec antigravity-claude-proxy\'\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\nEOF',
            },
            { label: 'Enable and start the unit', command: 'systemctl --user daemon-reload && systemctl --user enable --now antigravity-proxy.service' },
            {
              label: 'Wait for the proxy',
              command: 'for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8082/health >/dev/null && exit 0; sleep 2; done; echo "proxy did not answer within 60s"; exit 1',
            },
          ],
        },
      },
      health: { url: 'http://127.0.0.1:8082/health', timeoutMs: 5000 },
    },
    removal: {
      steps: [
        { label: 'Stop and disable the unit', command: 'systemctl --user disable --now antigravity-proxy.service', optional: true },
        { label: 'Remove the unit file', command: 'rm -f {config}/systemd/user/antigravity-proxy.service && systemctl --user daemon-reload', optional: true },
        { label: 'Uninstall the package', command: 'npm uninstall -g antigravity-claude-proxy', optional: true },
        { label: 'Remove the config directory (OAuth tokens, presets, usage history)', command: 'rm -rf {config}/antigravity-proxy' },
      ],
      warnings: [
        'Any other tool configured against the same proxy stops working when the service is removed',
        'If a dotfiles/config repository manages the systemd unit, remove it there too or the next sync resurrects it',
        'Deleting ~/.config/antigravity-proxy destroys every Google OAuth token and the usage history',
        'DSH route, credential, pool state, discovered cache, and chain links are removed separately by this teardown',
      ],
    },
    fallbackModel: 'gemini-2.5-flash',
  },
  {
    id: 'commandcode',
    label: 'Command Code (keypool)',
    summary: 'Command Code\'s CLI-shaped API behind the shared multi-key keypool proxy, served by the DSH provider package.',
    protocol: 'commandcode/alpha-generate',
    // The keypool owns the real keys and replaces the Authorization header per
    // request, so the DSH route is keyless; COMMANDCODE_API_KEY remains the
    // reference a direct (non-keypool) route would name.
    auth: { kind: 'none', apiKeyEnv: 'COMMANDCODE_API_KEY', keyless: true },
    dashboardUrl: 'http://127.0.0.1:8899/status',
    docsUrl: 'https://commandcode.ai',
    defaultPort: 8899,
    // Served by `dsh-enpoi-commandcode-provider` (ctx.llm.registerAdapter), not
    // llm-pi-ai: the CLI-shaped protocol has no llm-pi-ai entry, so the route
    // profile must never be written into the llm-pi-ai schema.
    settingsNs: 'commandcode-provider',
    requiresBrowser: [
      'Vendor account and quota dashboard live at commandcode.ai (browser)',
    ],
    quirks: [
      'The vendor endpoint rejects generic HTTP clients ("Proxy use detected") — traffic must go through the keypool with CLI headers',
      'DSH speaks this protocol through the dsh-enpoi-commandcode-provider adapter; llm-pi-ai cannot declare it',
      'The keypool may be shared with other tools — never stop or remove the shared keypool service when removing this provider',
      'The local dashboards are keypool :8899/keys and /status; there is no provider-owned UI',
      'The keypool sanitizer (older-image stripping, embedded-base64 scrub, 200k text cap) is the only sanitizer — clients must not duplicate it',
      'Quota is per key and real: the keypool rotates on exhaustion, and a QUOTA failure ("weekly usage limit" / "insufficient credits") appears only when every pooled key is spent — a normal state, not a routing defect',
    ],
    reuse: {
      label: 'Use a detected instance',
      baseURL: 'http://127.0.0.1:8899/commandcode',
      note: 'Uses the keypool already running on this device; the provider package speaks the CLI protocol and fetches the 83-model catalog from /commandcode/catalog.json.',
      health: { url: 'http://127.0.0.1:8899/healthz', timeoutMs: 5000 },
    },
    local: {
      label: 'Install locally (provider package + keypool)',
      baseURL: 'http://127.0.0.1:8899/commandcode',
      deps: ['Node.js 22', 'systemd user units'],
      diskHint: '~5 MB provider package, ~150 MB RAM for the keypool, no GPU',
      dashboardUrl: 'http://127.0.0.1:8899/status',
      runtime: 'node',
      install: {
        default: {
          steps: [
            { label: 'Build and link the DSH provider package', command: 'node {home}/.dsh/profiles/web/packages/enpoi-commandcode-provider/scripts/install.mjs {home}/.dsh/profiles/web', weight: 3 },
            { label: 'Seed the commandcode pool in pools.json', command: 'node {home}/.dsh/profiles/web/packages/enpoi-commandcode-provider/scripts/keypool-seed.mjs' },
            { label: 'Deploy the keypool proxy from dotfiles', command: 'test -f {home}/dotfiles/opencode-dotfiles/keypool/proxy.js || { echo "keypool proxy.js not found — sync dotfiles (opencode-dotfiles/keypool) first"; exit 1; }; install -Dm644 {home}/dotfiles/opencode-dotfiles/keypool/proxy.js {config}/opencode/keypool/proxy.js' },
            {
              label: 'Write the keypool systemd user unit',
              command: 'mkdir -p {config}/systemd/user && cat > {config}/systemd/user/keypool.service <<\'EOF\'\n[Unit]\nDescription=OpenCode KeyPool — multi-key rotation proxy\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/bin/bash -lc \'exec node %h/.config/opencode/keypool/proxy.js\'\nRestart=on-failure\nRestartSec=10s\nEnvironment=KEYPOOL_PORT=8899\nEnvironment=KEYPOOL_HOST=127.0.0.1\nEnvironment=HOME=%h\n\n[Install]\nWantedBy=default.target\nEOF',
            },
            { label: 'Enable and start the keypool', command: 'systemctl --user daemon-reload && systemctl --user enable --now keypool.service', optional: true },
            {
              label: 'Wait for the keypool',
              command: 'for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8899/healthz >/dev/null && exit 0; sleep 2; done; echo "keypool did not answer within 60s"; exit 1',
            },
          ],
        },
      },
      health: { url: 'http://127.0.0.1:8899/healthz', timeoutMs: 5000 },
    },
    removal: {
      steps: [
        // Drops only the commandcode pool entry; the keypool rereads pools.json
        // per request, so the shared service (and the `go` pool) is never
        // stopped, restarted, or otherwise touched.
        { label: 'Drop only pools.commandcode (keypool and other pools stay)', command: 'node {home}/.dsh/profiles/web/packages/enpoi-commandcode-provider/scripts/keypool-remove.mjs', optional: true },
      ],
      warnings: [
        'Removal drops only DSH state and the commandcode pool keys — it never stops or removes the shared keypool service (other tools may need it)',
        'usage.jsonl is keypool-wide and is not touched',
        'The provider package and its profile entry stay installed; delete the entry only when no route declares it',
      ],
    },
    fallbackModel: 'deepseek/deepseek-v4.1-flash',
  },
]

/** Resolve one route id against the fallback table (pre-connection only). */
export function fallbackHeavyManifest(id: string): HeavyProviderManifest | undefined {
  return FALLBACK_HEAVY_PROVIDER_MANIFESTS.find(manifest => manifest.id === id)
}

/** The heavy preset ids, excluded from the provider-sync endpoint set. */
export const HEAVY_PRESET_IDS: ReadonlySet<string> = new Set(FALLBACK_HEAVY_PROVIDER_MANIFESTS.map(manifest => manifest.id))

/**
 * Structural validation of the manifest table (unit-tested; mirrors the host
 * plugin's own check so a drifted table fails fast).
 * @param manifests - table to check, defaulting to the shipped one.
 * @returns one message per problem; empty means every manifest is complete.
 */
export function heavyProviderProblems(manifests: readonly HeavyProviderManifest[] = FALLBACK_HEAVY_PROVIDER_MANIFESTS): string[] {
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
    const variants = [manifest.local.install.default, manifest.local.install.linux, manifest.local.install.darwin,
      manifest.local.install.win32]
    if (manifest.unsupported === undefined) {
      if (manifest.local.install.default.steps.length === 0) problems.push(`${where}: local.install.default is empty`)
      if (manifest.local.baseURL === '') problems.push(`${where}: local.baseURL is empty`)
    }
    for (const [index, variant] of variants.entries()) {
      if (variant === undefined) continue
      if (variant.steps.length === 0 && manifest.unsupported === undefined) {
        problems.push(`${where}: platform install variant ${String(index)} has no steps`)
      }
    }
    if (manifest.removal.warnings.length === 0) problems.push(`${where}: removal.warnings is empty`)
    if (manifest.auth.kind === 'none' && manifest.protocol === 'anthropic-messages') {
      problems.push(`${where}: keyless anthropic routes are refused by llm-pi-ai`)
    }
    if (manifest.auth.kind !== 'none' && (manifest.auth.apiKeyEnv === undefined || !/^[A-Z_][A-Z0-9_]*$/.test(manifest.auth.apiKeyEnv))) {
      problems.push(`${where}: apiKeyEnv must be an uppercase credential reference`)
    }
  }
  return problems
}
