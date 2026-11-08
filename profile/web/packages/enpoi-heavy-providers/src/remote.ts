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
import { HEAVY_MANIFESTS, manifestById, manifestProblems, platformUnsupported, resolveHeavyInstall, withReleaseSource, type HeavyProviderManifest, type HeavyStep } from './manifests.js'
import { localizeHeavyManifest, localizeHeavyPreflight, localizeHeavySteps, settingsLocale, type HostLocale } from './locales.js'
import { lifecycleOf, ownsLocalInstall, registerInstallOwnership } from './state.js'
import {
  catalogAuthorityOf,
  chooseLocalPath,
  commitRoute,
  configuredProfile,
  detectInstance,
  detectRuntimes,
  discoverServiceCatalog,
  effectiveHeavyManifests,
  healthForBase,
  instanceBaseURLFromInput,
  modeBaseURL,
  overlayManifest,
  pendingRestartForManifest,
  probeHealth,
  reachable,
  readServerOverlay,
  removeProvider,
  resolveRouteKey,
  routeSettingsNs,
  settingsNamespaceReady,
  storeCredential,
  useDetectedInstance,
  writeKnownEmptyDiscoveredEntry,
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
  /**
   * The recorded lifecycle mode; `unknown` when the route predates the
   * lifecycle record or the record is missing/malformed. Never inferred from
   * the route address or display name.
   */
  mode?: 'reuse' | 'local' | 'unknown'
  /** Present only when the lifecycle record says this harness owns a local install. */
  installedByHarness?: boolean
  /** Setup provenance: how this provider was introduced to the harness. */
  setupKind?: 'harness-install' | 'detected-instance' | 'custom-instance'
  /** The configured or detected endpoint address. */
  endpoint?: string
  /**
   * The endpoint probe. `reachable` counts an authentication challenge (401 /
   * 403) as an answered service even though `ok` stays false.
   */
  health: { ok: boolean; reachable?: boolean; status?: number; error?: string; checkedAt: number }
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
  /**
   * Secretless installer paths for the dashboard hint (owned local installs):
   * where the generated bootstrap/management key lives on this host. The key
   * itself is never returned.
   */
  bootstrapPath?: string
  /** Alias path the helper reports for the management key (same file). */
  managementKeyPath?: string
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

/**
 * `enpoiHeavy.reuse` result. A successful reply always carries `catalog`
 * (the typed listing outcome the route was written from), so a client can
 * distinguish a valid empty from a failed/unauthorized discovery. Only a
 * blocked/pending reply omits it.
 */
export interface ReuseValue extends Omit<Partial<ReuseOutcome>, 'catalog'> {
  ok: boolean
  /** The typed catalog answer; present on every successful route write. */
  catalog?: ReuseOutcome['catalog']
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

/** The duplicate-add refusal shared by reuse and install. */
function duplicateRouteBlock(manifest: HeavyProviderManifest): { ok: false; blocked: { reason: string; plannedWith: string } } {
  return {
    ok: false,
    blocked: {
      reason: `provider "${manifest.id}" already has a configured route; remove it before adding it again`,
      plannedWith: 'remove the existing route first (Add never overwrites a configured profile)',
    },
  }
}

/** Whether one local step needs the running profile root substituted. */
function stepNeedsProfileDir(step: HeavyStep): boolean {
  return step.command.includes('{profileDir}')
    || step.command.includes('$DSH_HEAVY_PROFILE_DIR')
    || step.cwd?.includes('{profileDir}') === true
}

/** The refusal shared by install paths that cannot expand `{profileDir}`. */
function missingProfileDirBlock(): { ok: false; blocked: { reason: string; plannedWith: string } } {
  return {
    ok: false,
    blocked: {
      reason: 'The running profile root is unknown, so the local install command containing "{profileDir}" cannot be expanded.'
        + ' Start this profile through the dsh launcher (which supplies profileContext.dir),'
        + ' or set the enpoi-heavy-providers profileDir config explicitly, then retry.',
      plannedWith: 'No install step was started; the command containing "{profileDir}" was never executed.',
    },
  }
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

  /** The operator-visible locale: the durable preference, else the host environment. */
  private locale(): HostLocale {
    return settingsLocale(this.options.deps().settings)
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
    const locale = this.locale()
    return {
      items: effectiveHeavyManifests(HEAVY_MANIFESTS, overlay)
        .map(manifest => localizeHeavyManifest(manifest, locale)),
      problems: manifestProblems(),
      platform: process.platform,
    }
  }

  /**
   * Secretless installer paths for the status hint. Only a verified owned
   * local install asks the host reader; the reader never returns a key.
   */
  private async installPaths(id: string): Promise<{ bootstrapPath?: string; managementKeyPath?: string }> {
    try {
      return await this.options.deps().readInstallPaths?.(id) ?? {}
    } catch {
      return {}
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
    const locale = this.locale()
    const settingsNs = routeSettingsNs(manifest)
    const profile = configuredProfile(deps, manifest.id, settingsNs)
    const configured = profile !== undefined
    const configuredBase = typeof profile?.baseURL === 'string' ? profile.baseURL : undefined
    const lifecycle = lifecycleOf(deps.dshHome, manifest.id)
    const ownedLocal = ownsLocalInstall(lifecycle)
    // A route-less owned local install still reports its mode/ownership: the
    // operator has a running service with a retained key and needs the row to
    // keep offering its uninstall path.
    const mode = configured ? lifecycle?.mode ?? 'unknown' : ownedLocal ? 'local' : undefined
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
      {
        home: deps.home,
        dshHome: deps.dshHome,
        ...deps.profileDir === undefined ? {} : { profileDir: deps.profileDir },
        ...deps.installHelperPath === undefined ? {} : { helperPath: deps.installHelperPath },
      },
    )
    // The UI renders these two manifest projections; localize at the wire
    // boundary so the canonical table stays the English fixture the client
    // mirror pins.
    const localizedManifest = localizeHeavyManifest(manifest, locale)
    const localizedPreflight = localizeHeavyPreflight(preflight, localizedManifest, process.platform, locale)
    // A configured endpoint wins over the manifest default: an operator
    // migrating from the legacy keypool keeps a loopback baseURL, and its
    // health must reflect that endpoint, not the vendor root.
    // One configured endpoint is probed once: detection already tried it first,
    // so a refusal there is the same answer the health badge needs. Only when
    // detection moved on to another candidate does the configured endpoint
    // need its own probe.
    const configuredHealthUrl = configuredBase === undefined ? undefined : healthForBase(manifest, configuredBase).url
    const health = direct
      ? await probeHealth(manifest.reuse.health, deps.fetchImpl)
      : configuredBase !== undefined
        ? detection !== undefined && detection.url === configuredHealthUrl
          ? detection.health
          : await probeHealth(healthForBase(manifest, configuredBase), deps.fetchImpl)
        : detection!.health
    const isReachable = reachable(health)
    const settingsReady = settingsNamespaceReady(deps, settingsNs)
    const job = visibleJobSnapshot(this.options.jobs.snapshot(manifest.id), configured)
    return {
      id: manifest.id,
      manifest: localizedManifest,
      settingsNs,
      ...settingsReady === undefined ? {} : { settingsReady },
      configured,
      ...mode === undefined ? {} : { mode },
      ...lifecycle === undefined ? {} : {
        installedByHarness: lifecycle.installedByHarness,
        ...lifecycle.setupKind === undefined ? {} : { setupKind: lifecycle.setupKind },
        ...lifecycle.endpoint === undefined && configuredBase === undefined ? {} : { endpoint: lifecycle.endpoint ?? configuredBase },
      },
      ...ownedLocal ? await this.installPaths(manifest.id) : {},
      health: { ...health, reachable: isReachable },
      platform: process.platform,
      runtime,
      preflight: localizedPreflight,
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
    const deps = this.options.deps()
    // Duplicate Add is refused before any credential store, probe, or write:
    // re-adding never overwrites a configured profile (including its headers
    // and retry policy) and never retargets a saved route that is down.
    if (configuredProfile(deps, manifest.id, routeSettingsNs(manifest)) !== undefined) {
      this.options.log?.(`reuse ${manifest.id}: refused, route already configured`)
      return duplicateRouteBlock(manifest)
    }
    if (manifest.unsupported !== undefined) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } }
    }
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
   * Add by local install: run the runtime preflight, then start the polled job;
   * the route is written only when every required step succeeds. A duplicate
   * configured route is refused before any side effect, and an unsupported
   * platform/runtime starts no job. A route namespace the running profile has
   * not mounted yet is reported as the same pending-restart result reuse
   * returns — the install never starts a job whose finalizer would fail.
   * Ownership is never accepted from this wire request: only the trusted host
   * installer callback (`HeavyDeps.readInstallReceipt`) can record it.
   * @param request - `{ id, key? }`; any `receipt` field is rejected.
   * @returns the initial job snapshot, the unsupported blocker, or the ordering result.
   */
  @Remote
  async install(request: { id?: unknown; key?: unknown }): Promise<InstallValue> {
    if (request !== null && typeof request === 'object' && Object.hasOwn(request, 'receipt')) {
      throw new RemoteError(
        'gateway/bad-request',
        'enpoiHeavy: install does not accept a client ownership receipt',
        {},
      )
    }
    const manifest = this.requireEnabledManifest(request?.id)
    const submittedKey = optionalKey(request?.key)
    // A self-keying local install (CLIProxyAPI) ignores a client-supplied key:
    // the installer generates the authoritative key and the host reads it from
    // the verified receipt. Ignoring is deliberate rather than silent — the
    // form may still carry the legacy field, and a typed value is never stored,
    // never sent to discovery, and never appears in the job or route.
    const selfKeyingInstaller = manifest.id === 'cliproxyapi'
    const key = selfKeyingInstaller ? undefined : submittedKey
    if (selfKeyingInstaller && submittedKey !== undefined && submittedKey !== '') {
      this.options.log?.(`install ${manifest.id}: ignoring the client-supplied key; the installer generates its own`)
    }
    const deps = this.options.deps()
    // Duplicate Add commits nothing: no job, no credential, no route overwrite.
    if (configuredProfile(deps, manifest.id, routeSettingsNs(manifest)) !== undefined) {
      this.options.log?.(`install ${manifest.id}: refused, route already configured`)
      return duplicateRouteBlock(manifest)
    }
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
    // A step that names `{profileDir}` cannot run without a launcher-owned
    // profile root. Refuse before the runtime probe or any job exists instead
    // of spawning a command with the placeholder still in it.
    const localSteps = resolveHeavyInstall(manifest.local, process.platform).steps
    if (deps.profileDir === undefined && localSteps.some(stepNeedsProfileDir)) {
      this.options.log?.(`install ${manifest.id}: refused, running profile root is unknown`)
      return missingProfileDirBlock()
    }
    // Runtime preflight belongs to the install RPC: a missing Docker/Podman/
    // Node (or user systemd manager) refuses before a job exists.
    const runtime = await this.runtime()
    const preflight = chooseLocalPath(manifest, process.platform, runtime, undefined, {
      home: deps.home,
      dshHome: deps.dshHome,
      ...deps.profileDir === undefined ? {} : { profileDir: deps.profileDir },
      ...deps.installHelperPath === undefined ? {} : { helperPath: deps.installHelperPath },
    })
    if (preflight.path === 'unsupported') {
      const reason = preflight.missing.length > 0 ? preflight.missing.join('; ') : preflight.label
      this.options.log?.(`install ${manifest.id}: runtime preflight refused (${reason})`)
      return { ok: false, blocked: { reason, plannedWith: preflight.label } }
    }
    // The installer helper's own port preflight runs only when the helper
    // exposes it; it can refuse a foreign listener before a job is created.
    let helperRefusal: string | undefined
    try {
      const helperPreflight = await deps.installPreflight?.(manifest.id)
      if (helperPreflight !== undefined && helperPreflight.ok === false) helperRefusal = helperPreflight.reason ?? 'the installer port preflight refused the install'
    } catch (error) {
      helperRefusal = `the installer port preflight failed (${error instanceof Error ? error.message : String(error)})`
    }
    if (helperRefusal !== undefined) {
      this.options.log?.(`install ${manifest.id}: helper preflight refused (${helperRefusal})`)
      return { ok: false, blocked: { reason: helperRefusal, plannedWith: 'No install job was started and no port was claimed.' } }
    }
    const pendingRestart = pendingRestartForManifest(deps, manifest)
    if (pendingRestart !== undefined) {
      this.options.log?.(`install ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`)
      return { ok: false, pendingRestart }
    }
    // The job view renders these labels for the operator; localize at the
    // boundary so the manifest table itself stays canonical English. A
    // declared `releaseSource` appends the helper's `--releases-api`/`--repo`
    // flags only when the field exists.
    const steps = localizeHeavySteps(
      manifest,
      process.platform,
      withReleaseSource(localSteps, manifest.releaseSource),
      this.locale(),
    )
    const job = this.options.jobs.start(manifest.id, 'install', steps, async () => {
      const current = this.options.deps()
      // Re-check at the commit point: the namespace may have gone away (or the
      // install may have been started through another surface) since the guard.
      const late = pendingRestartForManifest(current, manifest)
      if (late !== undefined) throw new Error(late.message)
      // Re-check the duplicate guard at the commit point: another surface may
      // have written this route while the job ran, and an install must never
      // replace a route it did not create.
      if (configuredProfile(current, manifest.id, routeSettingsNs(manifest)) !== undefined) {
        throw new Error(
          `provider "${manifest.id}" received a route while the install was running;`
          + ' the install refused to overwrite it (remove the existing route first)',
        )
      }
      // Ownership is read only from the trusted host installer after its steps
      // succeeded. A browser-supplied string never reaches this point. The
      // proof is an opaque receipt (never the installer's credential).
      const localBaseURL = modeBaseURL(manifest, 'local')
      let receipt = await current.readInstallReceipt?.(manifest.id)
      const requiresOwnedInstaller = manifest.id === 'cliproxyapi'
      if (receipt === undefined && !requiresOwnedInstaller) {
        receipt = await current.issueInstallReceipt?.(manifest.id)
      }
      if (requiresOwnedInstaller && receipt === undefined) {
        throw new Error(
          'CLIProxyAPI install finished without a verified ownership receipt.'
          + ' The service may still be installed; no route was written and existing credentials were not changed.'
          + ' Repair the receipt, binary/unit hashes, and bootstrap owner token, then retry the install'
          + ' or add the detected instance.',
        )
      }
      if (receipt !== undefined) {
        registerInstallOwnership(current.dshHome, manifest.id, receipt, {
          setupKind: 'harness-install',
          endpoint: localBaseURL,
        })
      }
      // A local installer may seed its own client credential. Read it through
      // the trusted host seam and store it BEFORE discovery and the route
      // commit: the seeded service accepts the same key discovery presents,
      // and a later route failure leaves the already-installed service
      // usable through Add's detected-instance path.
      const installedCredential = manifest.auth.kind === 'unified'
        ? (await current.readInstallCredential?.(manifest.id))?.trim()
        : undefined
      const seededKey = installedCredential === undefined || installedCredential === '' ? undefined : installedCredential
      if (requiresOwnedInstaller && seededKey === undefined) {
        throw new Error(
          'CLIProxyAPI is installed but its generated inference key is unreadable.'
          + ' No route was written and existing credentials were not overwritten.'
          + ' Repair config.yaml access.api-keys or bootstrap.json, then retry the install'
          + ' or add the detected instance.',
        )
      }
      let seededStored = false
      if (seededKey !== undefined) {
        try {
          seededStored = await storeCredential(current, manifest, seededKey)
        } catch (error) {
          if (!requiresOwnedInstaller) throw error
          const cause = error instanceof Error ? error.message : String(error)
          throw new Error(
            `CLIProxyAPI is installed but its generated inference key could not be stored (${cause}).`
            + ' No route was written and existing credentials were not intentionally changed;'
            + ' repair the credentials service and retry the install or add the detected instance.',
          )
        }
      }
      if (requiresOwnedInstaller && !seededStored) {
        throw new Error(
          'CLIProxyAPI is installed but its generated inference key could not be stored.'
          + ' No route was written; repair the credentials service and retry the install'
          + ' or add the detected instance.',
        )
      }
      // One effective key decides both the listing request and the route's
      // auth: an explicit/seeded key makes the route keyed; a manifest whose
      // stored key is read from the host does too; otherwise the manifest's
      // anonymous default stands. Discovery never resolves a second credential
      // behind this decision. An owned CLIProxyAPI install never falls back to
      // an older stored key: the installer-generated key is authoritative.
      const effectiveKey = requiresOwnedInstaller
        ? seededKey
        : await resolveRouteKey(current, manifest, seededStored ? seededKey : key)
      // A service route lists its own endpoint at its protocol's native
      // address; a direct route's catalog is the bundled snapshot (the vendor
      // exposes no listing), so both resolve through the same seam. The
      // fallback model applies when discovery answers nothing.
      const catalog = await discoverServiceCatalog(current, manifest, localBaseURL, effectiveKey, {
        resolveStoredCredential: false,
      })
      // An endpoint-authority route treats its listing as the whole catalog.
      // A failed or unauthorized listing is not evidence of an empty catalog:
      // write no route at all (the installed service survives for a retry or a
      // detected-instance add) instead of an authoritative empty one.
      if (catalogAuthorityOf(manifest) === 'endpoint'
        && (catalog.state === 'failed' || catalog.state === 'unauthorized')) {
        throw new Error(
          `${manifest.label} is installed but its model listing was ${catalog.state}`
          + `${catalog.error === undefined ? '' : ` (${catalog.error})`}; no route was written.`
          + ' Check the service and its client key, then retry the install or add the detected instance.',
        )
      }
      // A valid empty listing is retained as the known-empty discovered
      // record the resolver reads; without it a first install (no upstream
      // accounts yet) is an invalid endpoint-authority provider until sync.
      if (catalog.state === 'empty') writeKnownEmptyDiscoveredEntry(current, manifest.id, localBaseURL)
      // A seeded credential is already stored, so the route commit must not
      // rewrite or roll it back. An operator-supplied key keeps the atomic
      // store-then-route behavior.
      const routeKey = seededStored ? undefined : key
      const keyless = manifest.auth.kind === 'unified' && effectiveKey !== undefined ? false : undefined
      try {
        // Route and credential commit atomically: a credential-store failure
        // fails the job before any route exists. The listing state decides the
        // fallback behavior, and `refuseExisting` closes the check-then-write
        // race with a route created during the job.
        await commitRoute(current, manifest, 'local', catalog.models, routeKey, {
          catalogState: catalog.state,
          refuseExisting: true,
          ...keyless === undefined ? {} : { keyless },
        })
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        // The service and its receipt/credential survive a route failure; say
        // so where the operator sees the job error instead of implying the
        // whole install can be discarded.
        if (receipt !== undefined || seededKey !== undefined) {
          throw new Error(`${cause} — ${manifest.label} is installed; retry the install or add the detected instance`)
        }
        throw error
      }
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
   * Remove one provider: unset the route first (a refusal aborts everything),
   * then the owned local teardown, credentials, pool state, discovered-cache
   * entry, host references, lifecycle record, and job snapshot.
   * @param request - `{ id, uninstall? }`.
   * @returns what was removed; individual sub-failures land in `summary.errors`.
   */
  @Remote
  async remove(request: { id?: unknown; uninstall?: unknown }): Promise<RemoveValue> {
    const manifest = requireManifest(request?.id)
    if (request?.uninstall !== undefined && typeof request.uninstall !== 'boolean') {
      throw new RemoteError('gateway/bad-request', 'enpoiHeavy: uninstall must be a boolean', {})
    }
    const deps = this.options.deps()
    // Removal works for a disabled provider and must use the operator overlay:
    // its pool identities name the credentials actually configured. The job
    // manager is always present for the lock even if a producer omitted it
    // from the deps view.
    const effective = overlayManifest(manifest, readServerOverlay(deps.dshHome)[manifest.id])
    const lockedDeps: HeavyDeps = deps.jobs === undefined ? { ...deps, jobs: this.options.jobs } : deps
    const summary = await removeProvider(lockedDeps, effective, { uninstall: request?.uninstall === true })
    this.options.log?.(`remove ${manifest.id}: route=${String(summary.routeRemoved)} pool=${String(summary.poolStateRemoved)} cache=${String(summary.cacheEntryRemoved)} teardown=${String(summary.teardown.ok)}`)
    return { ok: summary.errors.length === 0, summary }
  }
}
