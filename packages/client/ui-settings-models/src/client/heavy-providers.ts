/**
 * HEAVY provider manifests for the Add Provider workflow.
 *
 * A heavy provider is LISTED (a preset exists) but nothing is installed by
 * default: the row carries this manifest and only an explicit add runs the
 * install (or reuses the server's running endpoint over Tailscale). The
 * hand-maintained table survives preset regeneration, like
 * `KEYLESS_PRESET_IDS`; keep ids and facts in step with the host-side copy in
 * the profile plugin `dsh-enpoi-heavy-providers` (the side that executes).
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

/** One heavy provider's complete declaration. */
export interface HeavyProviderManifest {
  id: string
  label: string
  summary: string
  /** llm-pi-ai wire protocol the route declares. */
  protocol: string
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
  /** Account flows that need a browser; rendered as badges. */
  requiresBrowser: readonly string[]
  /** Operator-facing quirks shown in Add Provider and the detail panel. */
  quirks: readonly string[]
  /** Least-compute option: the server already runs this; zero local install. */
  reuse: {
    label: string
    baseURL: string
    note: string
    health: HeavyProviderHealth
  }
  /** Install path on this device. */
  local: {
    label: string
    baseURL: string
    deps: readonly string[]
    diskHint: string
    /** Dashboard served by the local install (defaults to {@link dashboardUrl}). */
    dashboardUrl?: string
    install: readonly HeavyProviderStep[]
    health: HeavyProviderHealth
  }
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

/** The three heavy providers v1 ships. */
export const HEAVY_PROVIDER_MANIFESTS: readonly HeavyProviderManifest[] = [
  {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    summary: 'Self-hosted free-tier gateway: ~30 providers behind one OpenAI-compatible endpoint.',
    protocol: 'openai-completions',
    auth: { kind: 'unified', apiKeyEnv: 'FREELLMAPI_API_KEY', keyless: false },
    dashboardUrl: 'http://100.122.163.25:3002',
    docsUrl: 'https://freellmapi.co',
    requiresBrowser: [
      'First-run setup code and password-reset code appear only in `docker compose logs` — a browser flow, not automatable',
      'Upstream provider keys are added on the web dashboard',
    ],
    quirks: [
      'Unified key is the only client auth — never expose this port through Cloudflare Tunnel',
      'Losing ENCRYPTION_KEY (in ~/freellmapi/.env) makes every stored upstream key unrecoverable',
      'The free-tier catalog is a monthly snapshot; /v1/models can list models no key serves',
      'A missing bind-mounted JSON file is created as a directory by Docker → boot loop',
    ],
    reuse: {
      label: 'Reuse on server (recommended)',
      baseURL: 'http://100.122.163.25:3002/v1',
      note: 'Zero install: points at the server gateway over Tailscale; one shared key store.',
      health: { url: 'http://100.122.163.25:3002/api/ping', timeoutMs: 5000 },
    },
    local: {
      label: 'Install locally (Docker)',
      baseURL: 'http://127.0.0.1:3002/v1',
      deps: ['Docker Engine + Compose'],
      diskHint: '~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU',
      dashboardUrl: 'http://127.0.0.1:3002',
      install: [
        { label: 'Clone FreeLLMAPI', command: 'git clone --depth 1 https://github.com/tashfeenahmed/freellmapi {home}/freellmapi', weight: 2 },
        {
          label: 'Generate ENCRYPTION_KEY',
          command: 'test -f {home}/freellmapi/.env || printf "ENCRYPTION_KEY=%s\\nPORT=3001\\nHOST_BIND=127.0.0.1\\n" "$(openssl rand -hex 32)" > {home}/freellmapi/.env',
        },
        { label: 'Start the stack', command: 'docker compose up -d', cwd: '{home}/freellmapi' },
        {
          label: 'Wait for the gateway',
          command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1',
        },
      ],
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
    dashboardUrl: 'http://100.122.163.25:8082',
    docsUrl: 'https://www.npmjs.com/package/antigravity-claude-proxy',
    requiresBrowser: [
      'Adding a Google account is an OAuth flow that opens a browser and waits on a localhost callback — on a headless host the printed URL must be opened from a machine that can reach the callback (Tailscale/port-forward); it cannot be automated',
    ],
    quirks: [
      'The proxy runs its own sticky account pool with cooldowns — DSH key pooling MUST stay off for this route',
      'The console at :8082 has no auth (webuiPassword empty) — trusted networks only',
      'Quotas are per-account/per-model weekly windows; "RESOURCE_EXHAUSTED … resets after 46h" is normal',
      'Shared with OpenCode — deleting the service breaks OpenCode too; the systemd unit is dotfiles-managed, so dotfiles must drop it or `op pull` resurrects it',
    ],
    reuse: {
      label: 'Reuse on server (recommended)',
      baseURL: 'http://100.122.163.25:8082',
      note: 'Zero install: uses the server proxy and its already-configured account pool over Tailscale.',
      health: { url: 'http://100.122.163.25:8082/health', timeoutMs: 5000 },
    },
    local: {
      label: 'Install locally (npm + systemd user unit)',
      baseURL: 'http://127.0.0.1:8082',
      deps: ['Node.js >= 18'],
      diskHint: '~23 MB install, ~78–150 MB RAM, no GPU',
      dashboardUrl: 'http://127.0.0.1:8082',
      install: [
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
        'OpenCode consumes the same proxy — its provider entry stops working when the service is removed',
        'The systemd unit is dotfiles-managed: remove it from dotfiles too or `op pull` resurrects it on the next pull',
        'Deleting ~/.config/antigravity-proxy destroys every Google OAuth token and the usage history',
        'DSH route, credential, pool state, discovered cache, and chain links are removed separately by this teardown',
      ],
    },
    fallbackModel: 'gemini-2.5-flash',
  },
  {
    id: 'commandcode',
    label: 'Command Code (keypool)',
    summary: 'Command Code\'s CLI-shaped API behind the shared multi-key keypool proxy.',
    protocol: 'commandcode/alpha-generate',
    auth: { kind: 'none', apiKeyEnv: 'COMMANDCODE_API_KEY', keyless: false },
    dashboardUrl: 'http://100.122.163.25:8899/status',
    docsUrl: 'https://commandcode.ai',
    requiresBrowser: [
      'Vendor account and quota dashboard live at commandcode.ai (browser)',
    ],
    quirks: [
      'The vendor endpoint rejects generic HTTP clients ("Proxy use detected") — traffic must go through the keypool with CLI headers',
      'llm-pi-ai cannot speak this API: v1 ships the manifest as "requires the custom provider package (planned)"',
      'The keypool is shared with the opencode `go` pool — never stop or remove keypool.service when removing this provider',
      'The local dashboards are keypool :8899/keys and /status; there is no provider-owned UI',
    ],
    reuse: {
      label: 'Reuse the server keypool (documented only)',
      baseURL: 'http://100.122.163.25:8899/commandcode',
      note: 'All keys/catalog/sanitizer live once on the server; a DSH route needs the planned custom provider package first.',
      health: { url: 'http://100.122.163.25:8899/healthz', timeoutMs: 5000 },
    },
    local: {
      label: 'Not supported in v1',
      baseURL: '',
      deps: [],
      diskHint: '',
      install: [],
      health: { url: 'http://127.0.0.1:8899/healthz', timeoutMs: 5000 },
    },
    removal: {
      steps: [],
      warnings: [
        'Removal drops only DSH state and the commandcode pool keys — it never stops or removes the shared keypool service (the `go` pool needs it)',
        'usage.jsonl is keypool-wide and is not touched',
      ],
    },
    unsupported: {
      reason: 'llm-pi-ai cannot speak the CLI-shaped /alpha/generate protocol — a custom provider package is required.',
      plannedWith: 'dsh-provider-commandcode (planned)',
      reuseUrl: 'http://100.122.163.25:8899/commandcode',
    },
  },
]

/** Resolve one heavy manifest by route id. */
export function heavyProviderManifest(id: string): HeavyProviderManifest | undefined {
  return HEAVY_PROVIDER_MANIFESTS.find(manifest => manifest.id === id)
}

/** The heavy preset ids, excluded from the provider-sync endpoint set. */
export const HEAVY_PRESET_IDS: ReadonlySet<string> = new Set(HEAVY_PROVIDER_MANIFESTS.map(manifest => manifest.id))

/**
 * Structural validation of the manifest table (unit-tested; mirrors the host
 * plugin's own check so a drifted table fails fast).
 * @param manifests - table to check, defaulting to the shipped one.
 * @returns one message per problem; empty means every manifest is complete.
 */
export function heavyProviderProblems(manifests: readonly HeavyProviderManifest[] = HEAVY_PROVIDER_MANIFESTS): string[] {
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
    if (manifest.reuse.baseURL === '' && manifest.unsupported === undefined) problems.push(`${where}: reuse.baseURL is empty`)
    if (manifest.reuse.health.url === '') problems.push(`${where}: reuse.health.url is empty`)
    if (manifest.unsupported === undefined) {
      if (manifest.local.install.length === 0) problems.push(`${where}: local.install is empty`)
      if (manifest.local.baseURL === '') problems.push(`${where}: local.baseURL is empty`)
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
