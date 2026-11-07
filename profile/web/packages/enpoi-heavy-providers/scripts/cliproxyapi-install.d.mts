/**
 * Type declarations for the Node ESM CLIProxyAPI installer helper.
 * Runtime implementation: `./cliproxyapi-install.mjs`.
 */

/** Stable installer refusal/failure code carried by CliProxyInstallError. */
export type CliProxyInstallErrorCode =
  | 'ABORTED'
  | 'BINARY_MODIFIED'
  | 'BOUNDS_EXCEEDED'
  | 'CREDENTIAL_STATE_INVALID'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CONFIG_PORT_MISMATCH'
  | 'OWNED_UPGRADE_BLOCKED'
  | 'DOWNLOAD_FAILED'
  | 'FOREIGN_STATE'
  | 'HEALTH_TIMEOUT'
  | 'INVALID_OPTIONS'
  | 'IO'
  | 'LISTENER_UNVERIFIED'
  | 'LOCKED'
  | 'NOT_INSTALLED'
  | 'PLATFORM_UNSUPPORTED'
  | 'PORT_IN_USE'
  | 'RECEIPT_INVALID'
  | 'SERVICE_FAILED'
  | 'SERVICE_TIMEOUT'
  | 'UNIT_MODIFIED'
  | string

export class CliProxyInstallError extends Error {
  constructor(code: CliProxyInstallErrorCode, message: string, options?: { cause?: unknown })
  readonly code: CliProxyInstallErrorCode
}

export const DEFAULT_PORT: number
export const SERVICE_LABEL: string
export const LAUNCHD_LABEL: string
export const RECEIPT_VERSION: number
export const DEFAULT_SERVICE_TIMEOUT_MS: number
export const REQUIRED_CONFIG_MAJOR: number
export const DASHBOARD_PANEL_MAX_BYTES: number

export interface CliProxyLayout {
  readonly root: string
  readonly binDir: string
  readonly binaryPath: string
  readonly configPath: string
  readonly authDir: string
  readonly staticDir: string
  readonly dashboardPanelPath: string
  readonly logDir: string
  readonly stdoutLogPath: string
  readonly stderrLogPath: string
  readonly bootstrapPath: string
  readonly receiptPath: string
  readonly journalPath: string
  readonly removedStatePath: string
  readonly stageDir: string
  readonly lockPath: string
  readonly unitPath: string
  readonly serviceLabel: string
  readonly serviceKind: 'systemd-user' | 'launchd-agent'
  readonly platform: string
}

export interface CliProxyReceipt {
  version: 1
  installId: string
  root: string
  binaryPath: string
  binarySha256: string
  configPath: string
  authDir: string
  bootstrapPath: string
  unitPath: string
  unitSha256: string
  ownerTokenSha256: string
  serviceLabel: string
  serviceKind: 'systemd-user' | 'launchd-agent'
  cliProxyVersion: string
  port: number
  installedAt: string
}

/** Dashboard panel state reported by the release downloader and installer. */
export type CliProxyDashboardPanel = 'installed' | 'embedded-or-absent'

export interface DownloadReleaseOptions {
  destination: string
  version?: string
  /** Full releases API URL; wins over `repo`. */
  releasesApi?: string
  /** GitHub `owner/name` release repository; defaults to upstream. */
  repo?: string
  platform?: string
  arch?: string
  signal?: AbortSignal
  fetch?: unknown
  timeoutMs?: number
  requiredMajor?: number
  maxDashboardPanelBytes?: number
}

export interface DownloadReleaseResult {
  destination?: string
  version?: string
  assetName?: string
  checksum?: string
  bytes?: number
  dashboardPanel?: CliProxyDashboardPanel
}

export type DownloadRelease = (
  options: DownloadReleaseOptions,
) => DownloadReleaseResult | void | Promise<DownloadReleaseResult | void>

export type PortProbe = (port: number, host?: string) => boolean | Promise<boolean>

export interface ServiceRunResult {
  code?: number
  status?: number
  exitCode?: number
  stdout?: string
  stderr?: string
  signal?: string | null
  timedOut?: boolean
  aborted?: boolean
}

export interface ServiceRunOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export type ServiceRunner = (
  command: string,
  args: string[],
  options?: ServiceRunOptions,
) => ServiceRunResult | number | boolean | void | Promise<ServiceRunResult | number | boolean | void>

export function defaultServiceRunner(
  command: string,
  args: string[],
  options?: ServiceRunOptions,
): Promise<ServiceRunResult>

export interface HealthResponseLike {
  ok?: boolean
  status?: number
  json?: () => unknown | Promise<unknown>
  timedOut?: boolean
  aborted?: boolean
}

export type HealthFetch = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' },
) => HealthResponseLike | boolean | Promise<HealthResponseLike | boolean>

/** Context for proving the started owned service owns its listening port. */
export interface ListenerVerification {
  layout: CliProxyLayout
  port: number
  uid: number
  serviceRunner: ServiceRunner
  processRunner: ServiceRunner
  serviceOptions: ServiceRunOptions
}

export type ListenerVerifier = (
  context: ListenerVerification,
) => boolean | Promise<boolean>

export interface CliProxyInstallOptions {
  dshHome?: string
  /** Alias for dshHome. */
  home?: string
  userHome?: string
  /** Alias for userHome. */
  homeDir?: string
  xdgConfigHome?: string
  platform?: string
  arch?: string
  port?: number | string
  version?: string
  releasesApi?: string
  /** GitHub `owner/name` release repository; defaults to upstream. */
  repo?: string
  downloadRelease?: DownloadRelease
  /** Alias for downloadRelease. */
  download?: DownloadRelease
  probePort?: PortProbe
  /** Alias for probePort. */
  portProbe?: PortProbe
  serviceRunner?: ServiceRunner
  /** Alias for serviceRunner. */
  runService?: ServiceRunner
  /** Runs `ps`/`lsof` for the macOS listener proof; never a service command. */
  processRunner?: ServiceRunner
  /** Alias for processRunner. */
  runProcess?: ServiceRunner
  /**
   * Proves the started service owns the listening port; defaults to the
   * platform listener probe. A false result rolls the install back before the
   * receipt (and its credentials) is published.
   */
  verifyListener?: ListenerVerifier
  fetch?: HealthFetch
  /** Alias for fetch. */
  healthFetch?: HealthFetch
  downloadFetch?: unknown
  downloadTimeoutMs?: number
  healthAttempts?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  serviceTimeoutMs?: number
  signal?: AbortSignal
  uid?: number
  now?: number | (() => number)
}

export interface CliProxyRemoveOptions {
  dshHome?: string
  home?: string
  userHome?: string
  homeDir?: string
  xdgConfigHome?: string
  platform?: string
  arch?: string
  serviceRunner?: ServiceRunner
  runService?: ServiceRunner
  serviceTimeoutMs?: number
  signal?: AbortSignal
  uid?: number
  now?: number | (() => number)
  /**
   * Runs after the read-only ownership preflight and before the removal lock.
   * A concurrency-test seam; it must not mutate owned state.
   */
  beforeLock?: () => void | Promise<void>
}

export interface CliProxyStatusOptions {
  dshHome?: string
  home?: string
  userHome?: string
  homeDir?: string
  xdgConfigHome?: string
  platform?: string
  arch?: string
}

export interface CliProxyPreflightOptions {
  dshHome?: string
  home?: string
  userHome?: string
  homeDir?: string
  xdgConfigHome?: string
  platform?: string
  arch?: string
  port?: number | string
  probePort?: PortProbe
  /** Alias for probePort. */
  portProbe?: PortProbe
  serviceRunner?: ServiceRunner
  /** Alias for serviceRunner. */
  runService?: ServiceRunner
  processRunner?: ServiceRunner
  /** Alias for processRunner. */
  runProcess?: ServiceRunner
  serviceTimeoutMs?: number
  signal?: AbortSignal
  uid?: number
}

export interface CliProxyServiceView {
  label: string
  kind: 'systemd-user' | 'launchd-agent'
  unitPath: string
}

export interface CliProxyInstallResult {
  ok: true
  action: 'install'
  installed: true
  installId: string
  version: string
  port: number
  configPath: string
  authDir: string
  bootstrapPath: string
  managementKeyPath: string
  dashboardUrl: string
  dashboardPanel: CliProxyDashboardPanel
  credentialsPresent: boolean
  portMismatch: boolean
  service: CliProxyServiceView
  receiptPath: string
}

export interface CliProxyRemoveResult {
  ok: true
  action: 'remove'
  removed: boolean
  alreadyRemoved?: boolean
  incomplete: boolean
  removedState?: boolean
  retainedConfig?: boolean
  removedUnit: boolean
  removedBinary: boolean
  removedJournal: boolean
  service: CliProxyServiceView
  retained: {
    configPath: string
    authDir: string
    bootstrapPath: string
  }
}

export interface CliProxyJournal {
  version: 1
  installId: string
  ownerTokenSha256: string
  binarySha256: string
  unitSha256: string
  previousBinarySha256?: string
  previousUnitSha256?: string
  /** Digest of the dashboard panel this install publishes, when it has one. */
  dashboardPanelSha256?: string
  /** Digest of the dashboard panel this install replaces, when one exists. */
  previousDashboardPanelSha256?: string
  root: string
  binaryPath: string
  configPath: string
  authDir: string
  bootstrapPath: string
  unitPath: string
  serviceLabel: 'dsh-cliproxyapi' | 'dev.enpoi.cliproxyapi'
  serviceKind: 'systemd-user' | 'launchd-agent'
  createdAt: string
}

export interface CliProxyRemovedState {
  version: 1
  state: 'removed'
  installId: string
  ownerTokenSha256: string
  binarySha256: string
  unitSha256: string
  root: string
  binaryPath: string
  configPath: string
  authDir: string
  bootstrapPath: string
  unitPath: string
  serviceLabel: 'dsh-cliproxyapi' | 'dev.enpoi.cliproxyapi'
  serviceKind: 'systemd-user' | 'launchd-agent'
  removedAt: string
}

export interface CliProxyStatusResult {
  ok: true
  action: 'status'
  installed: boolean
  incomplete?: boolean
  /** True when a journaled binary/panel pair is only half published. */
  halfPublished: boolean
  removedState?: boolean
  retainedConfig?: boolean
  installId?: string
  version?: string
  port?: number
  configPath: string
  authDir?: string
  bootstrapPath?: string
  managementKeyPath?: string
  dashboardUrl?: string
  configPort?: number
  portMismatch?: boolean
  service: CliProxyServiceView
  receiptPath?: string
  binaryMatches?: boolean
  unitMatches?: boolean
  credentialsPresent?: boolean
}

export function assertSupportedPlatform(platform: string, arch: string): void

export function resolveCliProxyLayout(options: {
  dshHome: string
  platform?: string
  userHome?: string
  xdgConfigHome?: string
}): CliProxyLayout

export function renderServiceDefinition(layout: CliProxyLayout): string

export function renderSeedConfig(options: {
  port: number
  authDir: string
  managementKey: string
  inferenceKey: string
}): string

export function installCliProxyApi(options?: CliProxyInstallOptions): Promise<CliProxyInstallResult>

export function removeCliProxyApi(options?: CliProxyRemoveOptions): Promise<CliProxyRemoveResult>

export function statusCliProxyApi(options?: CliProxyStatusOptions): Promise<CliProxyStatusResult>

export interface CliProxyPreflightResult {
  /** False refuses the caller's install before a job exists. */
  ok: boolean
  action: 'preflight'
  /** Stable refusal code when `ok` is false. */
  code?: string
  /** Human-readable refusal reason when `ok` is false. */
  reason?: string
  installed: boolean
  incomplete: boolean
  /** True when a journaled binary/panel pair is only half published. */
  halfPublished: boolean
  removedState: boolean
  installId?: string
  version?: string
  port: number
  configPort?: number
  portMismatch: boolean
  /** True when the bounded loopback probe found an existing listener. */
  portInUse: boolean
  credentialsPresent: boolean
  configPath: string
  authDir: string
  bootstrapPath: string
  managementKeyPath: string
  service: CliProxyServiceView
  receiptPath?: string
  binaryMatches?: boolean
  unitMatches?: boolean
}

/** Read-only install preflight; never mutates owned state or calls a service command. */
export function preflightCliProxyApi(options?: CliProxyPreflightOptions): Promise<CliProxyPreflightResult>

/** Local owner/planner-only credential read after receipt + stable owner-token verification. */
export function readOwnedInferenceCredential(
  dshHome: string,
  options?: { platform?: string; userHome?: string; homeDir?: string },
): Promise<string>

export function parseCliProxyArgs(argv: string[]): {
  command: 'install' | 'remove' | 'status' | 'preflight' | 'help'
  options: {
    dshHome?: string
    userHome?: string
    port?: number
    version?: string
    releasesApi?: string
    repo?: string
  }
}

export function runCliProxyInstaller(
  argv: string[],
  overrides?: Partial<CliProxyInstallOptions & CliProxyRemoveOptions & CliProxyStatusOptions>,
): Promise<
  CliProxyInstallResult
  | CliProxyRemoveResult
  | CliProxyStatusResult
  | CliProxyPreflightResult
  | { ok: true; action: 'help'; usage: string }
>

export function main(argv?: string[]): Promise<number>
