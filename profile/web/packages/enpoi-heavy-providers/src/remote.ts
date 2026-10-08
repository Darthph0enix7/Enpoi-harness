/**
 * enpoi-heavy-providers — the `enpoiHeavy` Typert Remote namespace.
 *
 * Decorated shell over `planner.ts`/`jobs.ts`: the client's Add Provider and
 * provider-detail surfaces drive install/reuse/removal exclusively through
 * these endpoints, so a long install never sits in the `settings.mutate`
 * path. All payload validation happens here at the wire boundary.
 *
 * @module dsh-enpoi-heavy-providers/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HeavyJobView } from './jobs.js'
import { HeavyJobManager, visibleJobSnapshot } from './jobs.js'
import { HEAVY_MANIFESTS, manifestById, manifestProblems, platformUnsupported, resolveHeavyInstall, type HeavyProviderManifest } from './manifests.js'
import {
  chooseLocalPath,
  commitRoute,
  configuredProfile,
  detectInstance,
  detectRuntimes,
  discoverServiceModels,
  effectiveHeavyManifests,
  healthForBase,
  instanceBaseURLFromInput,
  modeBaseURL,
  overlayManifest,
  pendingRestartForManifest,
  probeHealth,
  readServerOverlay,
  removeProvider,
  routeSettingsNs,
  settingsNamespaceReady,
  useDetectedInstance,
  type HeavyDeps,
  type LocalPathChoice,
  type PendingRestart,
  type RemovalSummary,
  type ReuseOutcome,
  type RuntimeProbe,
} from './planner.js'

/** Longest accepted key string (a credential is a bounded token). */
const MAX_KEY_CHARS = 4096

/** One runtime probe per minute: status serves several rows per page load. */
const RUNTIME_TTL_MS = 60_000

/** The host seams the service reads lazily (each may mount after this plugin). */
export interface HeavyServiceOptions {
  /** Current deps; read per call so late-mounted services are seen. */
  deps: () => HeavyDeps
  /** The shared job manager (one install per provider at a time). */
  jobs: HeavyJobManager
  /** Diagnostics sink; defaults to no logging. */
  log?: (line: string) => void
}

/** `enpoiHeavy.manifests` result. */
export interface ManifestsValue {
  items: readonly HeavyProviderManifest[]
  problems: readonly string[]
  /** The host platform install steps execute on (`process.platform`). */
  platform: string
}

/** `enpoiHeavy.status` result. */
export interface StatusValue {
  id: string
  /** The effective host manifest (overlay applied) the client renders this row from. */
  manifest: HeavyProviderManifest
  configured: boolean
  mode?: 'reuse' | 'local'
  health: { ok: boolean; status?: number; error?: string; checkedAt: number }
  /** The host platform install steps execute on (`process.platform`). */
  platform: string
  /** Settings namespace the route profile is written to (`llm-pi-ai` by default). */
  settingsNs: string
  /** Whether that namespace is mounted in the running profile; absent when unknown. */
  settingsReady?: boolean
  /** Loopback port an already-running instance answered on, when one did. */
  detectedPort?: number
  /** Address the detection found; the UI's "running at — use it" offer. */
  detectedEndpoint?: string
  /** Container runtimes the machine has (detection is fail-soft). */
  runtime: RuntimeProbe
  /** The platform's best local path for this provider (detection first). */
  preflight: LocalPathChoice
  unsupported?: HeavyProviderManifest['unsupported']
  /**
   * The install job still worth showing (running progress, or a failure the
   * operator must see). A succeeded run is omitted once `configured`: its
   * route is the durable outcome, not a progress bar to re-render.
   */
  job?: HeavyJobView
}

/** `enpoiHeavy.reuse` result. */
export interface ReuseValue extends Partial<ReuseOutcome> {
  ok: boolean
  blocked?: { reason: string; plannedWith: string }
  /** Route namespace absent from the running profile: the write waits for a restart. */
  pendingRestart?: PendingRestart
}

/** `enpoiHeavy.install` result. */
export interface InstallValue {
  ok: boolean
  job?: HeavyJobView
  blocked?: { reason: string; plannedWith: string }
  /** Route namespace absent from the running profile: the install waits for a restart. */
  pendingRestart?: PendingRestart
}

/** `enpoiHeavy.job` result. */
export interface JobValue {
  job?: HeavyJobView
}

/** `enpoiHeavy.remove` result. */
export interface RemoveValue {
  ok: boolean
  summary?: RemovalSummary
}

/** Validate one wire id against the manifest table. */
function requireManifest(value: unknown): HeavyProviderManifest {
  if (typeof value !== 'string' || value === '') {
    throw new RemoteError('gateway/bad-request', 'enpoiHeavy: id must be a non-empty string', {})
  }
  const manifest = manifestById(value)
  if (manifest === undefined) {
    throw new RemoteError('gateway/bad-request', `enpoiHeavy: unknown heavy provider "${value}"`, {})
  }
  return manifest
}

/** Normalize an optional key argument. */
function optionalKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RemoteError('gateway/bad-request', 'enpoiHeavy: key must be a string', {})
  if (value.length > MAX_KEY_CHARS) throw new RemoteError('gateway/bad-request', 'enpoiHeavy: key is too long', {})
  return value
}

/** Longest accepted custom-instance base URL (a bounded address, not a payload). */
const MAX_BASE_URL_CHARS = 2048

/**
 * Validate the operator-typed custom-instance address. An empty value means
 * "no custom instance"; anything non-empty must be an absolute http(s) URL
 * without embedded credentials and is normalized to its origin (the manifest
 * owns the service's paths). A non-loopback host is accepted: typing it is
 * the explicit operator action, and the manifest's exposure quirks still hold.
 */
function optionalBaseURL(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RemoteError('gateway/bad-request', 'enpoiHeavy: baseURL must be a string', {})
  if (value.trim() === '') return undefined
  if (value.length > MAX_BASE_URL_CHARS) throw new RemoteError('gateway/bad-request', 'enpoiHeavy: baseURL is too long', {})
  const normalized = instanceBaseURLFromInput(value)
  if (normalized === undefined) {
    throw new RemoteError('gateway/bad-request', 'enpoiHeavy: baseURL must be an absolute http(s) URL', {})
  }
  return normalized
}

/** The service behind the `enpoiHeavy` Remote namespace. */
export class HeavyProvidersService extends TypertRemoteService {
  /** Nothing is injected into the service fiber; the plugin passes its deps. */
  static inject: string[] = []

  private readonly options: HeavyServiceOptions
  private runtimeCache: { at: number; value: RuntimeProbe } | undefined

  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - deps accessor, job manager, and optional log sink.
   */
  constructor(ctx: Context, options: HeavyServiceOptions) {
    super(ctx, 'enpoiHeavy')
    this.options = options
  }

  /** The machine's container runtimes, memoized for one minute. */
  private async runtime(): Promise<RuntimeProbe> {
    const now = Date.now()
    if (this.runtimeCache !== undefined && now - this.runtimeCache.at < RUNTIME_TTL_MS) {
      return this.runtimeCache.value
    }
    const value = await detectRuntimes(this.options.deps().runStep)
    this.runtimeCache = { at: now, value }
    return value
  }

  /**
   * Resolve one wire id to its effective manifest, refusing a provider the
   * operator disabled. `remove`/`job` keep the plain resolution: an operator
   * who disables a provider must still be able to clean up its state.
   */
  private requireEnabledManifest(value: unknown): HeavyProviderManifest {
    const manifest = requireManifest(value)
    const entry = readServerOverlay(this.options.deps().dshHome)[manifest.id]
    if (entry?.disabled === true) {
      throw new RemoteError(
        'gateway/bad-request',
        `enpoiHeavy: provider "${manifest.id}" is disabled by $DSH_HOME/heavy-server-overlay.json`,
        {},
      )
    }
    return overlayManifest(manifest, entry)
  }

  /** The declared manifest table (overlay applied, disabled entries dropped) plus any structural problems. */
  @Remote
  manifests(): ManifestsValue {
    const overlay = readServerOverlay(this.options.deps().dshHome)
    return {
      items: effectiveHeavyManifests(HEAVY_MANIFESTS, overlay),
      problems: manifestProblems(),
      platform: process.platform,
    }
  }

  /**
   * One provider's configured/health/job state plus the detection/preflight
   * fold the UI renders: an answering instance (`detectedEndpoint`), the
   * container runtimes found, and the platform's best local path.
   * @param request - `{ id }`.
   * @returns the status fold; a probe failure is reported, never thrown.
   */
  @Remote
  async status(request: { id?: unknown }): Promise<StatusValue> {
    const manifest = this.requireEnabledManifest(request?.id)
    const deps = this.options.deps()
    const settingsNs = routeSettingsNs(manifest)
    const profile = configuredProfile(deps, manifest.id, settingsNs)
    const configured = profile !== undefined
    const configuredBase = typeof profile?.baseURL === 'string' ? profile.baseURL : undefined
    const mode = configuredBase === undefined ? undefined : configuredBase === manifest.reuse.baseURL ? 'reuse' : 'local'
    // A direct manifest has no on-device instance: detection is not applicable,
    // and the health badge comes from the declared vendor endpoint instead.
    const direct = manifest.delivery === 'direct'
    const detection = direct ? undefined : await detectInstance(deps, manifest, configuredBase)
    const runtime = await this.runtime()
    const preflight = chooseLocalPath(
      manifest,
      process.platform,
      runtime,
      detection?.ok === true ? detection.port : undefined,
      { home: deps.home, dshHome: deps.dshHome },
    )
    // A configured endpoint wins over the manifest default: an operator
    // migrating from the legacy keypool keeps a loopback baseURL, and its
    // health must reflect that endpoint, not the vendor root.
    const health = configuredBase !== undefined
      ? await probeHealth(healthForBase(manifest, configuredBase), deps.fetchImpl)
      : direct
        ? await probeHealth(manifest.reuse.health, deps.fetchImpl)
        : detection!.health
    const settingsReady = settingsNamespaceReady(deps, settingsNs)
    const job = visibleJobSnapshot(this.options.jobs.snapshot(manifest.id), configured)
    return {
      id: manifest.id,
      manifest,
      settingsNs,
      ...settingsReady === undefined ? {} : { settingsReady },
      configured,
      ...mode === undefined ? {} : { mode },
      health,
      platform: process.platform,
      runtime,
      preflight,
      ...detection?.ok === true && detection.port !== undefined ? { detectedPort: detection.port } : {},
      ...detection?.ok === true ? { detectedEndpoint: detection.baseURL } : {},
      ...manifest.unsupported === undefined ? {} : { unsupported: manifest.unsupported },
      ...job === undefined ? {} : { job },
    }
  }

  /**
   * Add by detected instance: probe localhost, discover models, write the
   * route at the detected address. A typed `baseURL` is the operator's
   * custom-instance fallback: detection is skipped and the route is written
   * at that address (a service manifest only — a direct vendor route has no
   * on-device instance to retarget).
   * @param request - `{ id, key?, baseURL? }`.
   * @returns the route written, the probe verdict, and whether a key was stored.
   */
  @Remote
  async reuse(request: { id?: unknown; key?: unknown; baseURL?: unknown }): Promise<ReuseValue> {
    const manifest = this.requireEnabledManifest(request?.id)
    const key = optionalKey(request?.key)
    const baseURL = optionalBaseURL(request?.baseURL)
    if (baseURL !== undefined && manifest.delivery === 'direct') {
      throw new RemoteError(
        'gateway/bad-request',
        `enpoiHeavy: "${manifest.id}" is a direct vendor route; a custom instance URL does not apply`,
        {},
      )
    }
    if (manifest.unsupported !== undefined) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } }
    }
    const deps = this.options.deps()
    // The route namespace of a custom-protocol provider (commandcode) only
    // exists once its adapter plugin is part of the built profile: surface the
    // ordering fact before attempting a write that would fail at mutate.
    const pendingRestart = pendingRestartForManifest(deps, manifest)
    if (pendingRestart !== undefined) {
      this.options.log?.(`reuse ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`)
      return { ok: false, pendingRestart }
    }
    const outcome = await useDetectedInstance(deps, manifest, key, baseURL === undefined ? {} : { baseURL })
    this.options.log?.(`detected ${manifest.id}: health=${outcome.health.ok ? 'ok' : 'down'} endpoint=${outcome.endpoint} models=${String(outcome.models.length)}`)
    return { ok: true, ...outcome }
  }

  /**
   * Add by local install: start the polled job; the route is written only when
   * every required step succeeds. A route namespace the running profile has
   * not mounted yet is reported as the same pending-restart result reuse
   * returns — the install never starts a job whose finalizer would fail.
   * @param request - `{ id, key? }`.
   * @returns the initial job snapshot, the unsupported blocker, or the ordering result.
   */
  @Remote
  install(request: { id?: unknown; key?: unknown }): InstallValue {
    const manifest = this.requireEnabledManifest(request?.id)
    const key = optionalKey(request?.key)
    if (manifest.unsupported !== undefined) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } }
    }
    // A platform with no supported provisioning path is refused with its
    // declared reason instead of running steps that cannot work.
    const platformBlocked = platformUnsupported(manifest, process.platform)
    if (platformBlocked !== undefined) {
      this.options.log?.(`install ${manifest.id}: refused on ${process.platform} (${platformBlocked})`)
      return { ok: false, blocked: { reason: platformBlocked, plannedWith: 'run the service manually and add it with "Use a detected instance"' } }
    }
    const deps = this.options.deps()
    const pendingRestart = pendingRestartForManifest(deps, manifest)
    if (pendingRestart !== undefined) {
      this.options.log?.(`install ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`)
      return { ok: false, pendingRestart }
    }
    const job = this.options.jobs.start(manifest.id, 'install', resolveHeavyInstall(manifest.local, process.platform).steps, async () => {
      const current = this.options.deps()
      // Re-check at the commit point: the namespace may have gone away (or the
      // install may have been started through another surface) since the guard.
      const late = pendingRestartForManifest(current, manifest)
      if (late !== undefined) throw new Error(late.message)
      // A service route lists its own endpoint at its protocol's native
      // address; a direct route's catalog is the bundled snapshot (the vendor
      // exposes no listing), so both resolve through the same seam. The
      // fallback model applies when discovery answers nothing.
      const models = await discoverServiceModels(current, manifest, modeBaseURL(manifest, 'local'), key)
      // Route and credential commit atomically: a credential-store failure
      // fails the job before any route exists.
      await commitRoute(current, manifest, 'local', models, key)
    })
    return { ok: true, job }
  }

  /**
   * Poll one provider's current job snapshot.
   * @param request - `{ id }`.
   * @returns the snapshot, or nothing when no job ever ran.
   */
  @Remote
  job(request: { id?: unknown }): JobValue {
    const manifest = requireManifest(request?.id)
    const job = this.options.jobs.snapshot(manifest.id)
    return job === undefined ? {} : { job }
  }

  /**
   * Remove one provider: optional local teardown, then route, credential,
   * pool state, discovered-cache entry, and chain links.
   * @param request - `{ id, uninstall? }`.
   * @returns what was removed; individual sub-failures land in `summary.errors`.
   */
  @Remote
  async remove(request: { id?: unknown; uninstall?: unknown }): Promise<RemoveValue> {
    const manifest = requireManifest(request?.id)
    if (request?.uninstall !== undefined && typeof request.uninstall !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'enpoiHeavy: uninstall must be a boolean', {})
    }
    const summary = await removeProvider(this.options.deps(), manifest, { uninstall: request?.uninstall === true })
    this.options.log?.(`remove ${manifest.id}: route=${String(summary.routeRemoved)} pool=${String(summary.poolStateRemoved)} cache=${String(summary.cacheEntryRemoved)} teardown=${String(summary.teardown.ok)}`)
    return { ok: summary.errors.length === 0, summary }
  }
}
