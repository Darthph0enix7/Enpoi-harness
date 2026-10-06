/**
 * enpoi-heavy-providers — route/credential/cache planning for heavy providers.
 *
 * Decorator-free by design (the profile's vitest pipeline cannot transform
 * standard decorators); `remote.ts` is a thin decorated shell over this file.
 * Every side effect goes through an injected seam so tests run without a
 * harness: settings, credentials, fetch, filesystem paths, and the step
 * runner all arrive from the caller.
 *
 * @module dsh-enpoi-heavy-providers/planner
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { platformInstallVariant, platformUnsupported, resolveHeavyInstall } from './manifests.js'
import type { HeavyFileRequirement, HeavyHealth, HeavyLocalRuntime, HeavyProviderManifest, HeavyStep } from './manifests.js'

/** The llm-pi-ai settings namespace every route write targets. */
export const LLM_NS = 'llm-pi-ai'
/** The namespace that owns `chains` (registered by enpoi-capabilities). */
export const ORCHESTRATION_NS = 'enpoi-orchestration'

/** Minimal settings seam (matches the live service). */
export interface SettingsSeam {
  describe?(): Array<{ ns: string; revision: number; value?: unknown }>
  mutate(ns: string, ops: readonly Record<string, unknown>[], expectedRevision?: number): Promise<void>
}

/** Minimal credentials seam (matches the live service). */
export interface CredentialsSeam {
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** The subset of `fetch` the planner uses. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/** Everything a planner call needs from the host. */
export interface HeavyDeps {
  /** User home; `{home}`/`{config}` placeholder base. */
  home: string
  /** DSH home directory; pools and the discovered-model cache live under it. */
  dshHome: string
  settings?: SettingsSeam | undefined
  credentials?: CredentialsSeam | undefined
  fetchImpl?: FetchLike | undefined
  /** Runs one shell step (the service wires this to `ctx.subprocess`). */
  runStep: (step: HeavyStep) => Promise<StepOutcome>
}

/** One shell step's result. */
export interface StepOutcome {
  exitCode: number | null
  output: string
}

/** One route profile written to `llm-pi-ai.providers.<id>`. */
export interface HeavyRouteProfile {
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv?: string
  keyless?: boolean
  models: Array<{ id: string; name?: string }>
}

/**
 * Substitute the runner placeholders in one declared string.
 * @param value - the declared command or cwd.
 * @param home - the user home (`{home}`; `{config}` is its `.config`).
 * @param dshHome - the DSH home (`{dshHome}`); defaults to the standard
 *   `<home>/.dsh` when omitted.
 * @returns the string with every placeholder expanded.
 */
export function substitute(value: string, home: string, dshHome?: string): string {
  return value
    .replaceAll('{home}', home)
    .replaceAll('{config}', join(home, '.config'))
    .replaceAll('{dshHome}', dshHome ?? join(home, '.dsh'))
}

/** The base URL a mode points the route at. */
export function modeBaseURL(manifest: HeavyProviderManifest, mode: 'reuse' | 'local'): string {
  return mode === 'reuse' ? manifest.reuse.baseURL : manifest.local.baseURL
}

/** One HTTP URL's explicit port; undefined when absent or unparsable. */
export function urlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined
  } catch {
    return undefined
  }
}

/** The path of an absolute URL, '' when it is the host root. */
function urlPath(url: string): string {
  try {
    const path = new URL(url).pathname
    return path === '/' ? '' : path
  } catch {
    return ''
  }
}

/** The loopback health probe for one port (path from the manifest's declared probe). */
export function instanceHealth(manifest: HeavyProviderManifest, port: number): HeavyHealth {
  return { ...manifest.local.health, url: `http://127.0.0.1:${port}${urlPath(manifest.local.health.url)}` }
}

/** The loopback route address for one port (path from the manifest's endpoint). */
export function instanceBaseURL(manifest: HeavyProviderManifest, port: number): string {
  return `http://127.0.0.1:${port}${urlPath(manifest.reuse.baseURL)}`
}

/** The health probe for a configured route address, port substituted. */
export function healthForBase(manifest: HeavyProviderManifest, baseURL: string): HeavyHealth {
  try {
    const base = new URL(baseURL)
    const declared = new URL(manifest.reuse.health.url)
    return { ...manifest.reuse.health, url: `${base.protocol}//${base.host}${declared.pathname}` }
  } catch {
    return manifest.reuse.health
  }
}

/** One endpoint detection probes. */
export interface InstanceCandidate {
  /** Probe URL. */
  url: string
  /** Route address the instance would be used with. */
  baseURL: string
  port?: number
}

/**
 * The probe order: the configured/settings address first (its port is the
 * operator's recorded one), then the manifest's declared endpoint, then the
 * loopback default port. Exact duplicate URLs are dropped.
 * @param manifest - heavy manifest.
 * @param configuredBaseURL - the route address already in settings, when any.
 * @returns candidates in probe order.
 */
export function instanceCandidates(manifest: HeavyProviderManifest, configuredBaseURL?: string): InstanceCandidate[] {
  const candidates: InstanceCandidate[] = []
  const add = (baseURL: string, url: string): void => {
    if (candidates.some(candidate => candidate.url === url)) return
    const port = urlPort(baseURL)
    candidates.push({ url, baseURL, ...port === undefined ? {} : { port } })
  }
  if (configuredBaseURL !== undefined && configuredBaseURL !== '') {
    add(configuredBaseURL, healthForBase(manifest, configuredBaseURL).url)
  }
  add(manifest.reuse.baseURL, manifest.reuse.health.url)
  add(instanceBaseURL(manifest, manifest.defaultPort), instanceHealth(manifest, manifest.defaultPort).url)
  return candidates
}

/** The detection outcome for one manifest. */
export interface InstanceDetection {
  ok: boolean
  /** Route address to write when this instance is used. */
  baseURL: string
  port?: number
  /** The probe URL that answered (or the first attempted when none did). */
  url: string
  health: { ok: boolean; status?: number; error?: string; checkedAt: number }
}

/**
 * Probe localhost for an already-running instance: the configured port (when
 * one is recorded), the manifest's endpoint, and the default port. Fail-soft:
 * every failure is reported, never thrown, and the declared endpoint is the
 * fallback address when nothing answers.
 * @param deps - host seams (fetch).
 * @param manifest - heavy manifest.
 * @param configuredBaseURL - the route address already in settings, when any.
 * @returns the first answering instance, or the first failure.
 */
export async function detectInstance(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  configuredBaseURL?: string,
): Promise<InstanceDetection> {
  let firstFailure: InstanceDetection | undefined
  for (const candidate of instanceCandidates(manifest, configuredBaseURL)) {
    const health = await probeHealth({ ...manifest.reuse.health, url: candidate.url }, deps.fetchImpl)
    const detection: InstanceDetection = {
      ok: health.ok,
      baseURL: candidate.baseURL,
      ...candidate.port === undefined ? {} : { port: candidate.port },
      url: candidate.url,
      health,
    }
    if (health.ok) return detection
    firstFailure ??= detection
  }
  return firstFailure ?? {
    ok: false,
    baseURL: manifest.reuse.baseURL,
    url: manifest.reuse.health.url,
    health: { ok: false, error: 'no probe candidates', checkedAt: Date.now() },
  }
}

/** What the machine has for running a local heavy service. */
export interface RuntimeProbe {
  docker: boolean
  podman: boolean
  /** `node` resolves in the same shell the install steps run in. */
  node: boolean
}

/**
 * Detect Docker, Podman, and Node with one shell probe. Fail-soft: an absent
 * runner or a failed step reports nothing installed rather than blocking the
 * page.
 * @param runStep - the host's step runner.
 * @returns availability of each runtime the local install paths use.
 */
export async function detectRuntimes(runStep: (step: HeavyStep) => Promise<StepOutcome>): Promise<RuntimeProbe> {
  try {
    const outcome = await runStep({
      label: 'Detect local runtimes',
      command: 'command -v docker >/dev/null 2>&1 && echo available:docker; command -v podman >/dev/null 2>&1 && echo available:podman; command -v node >/dev/null 2>&1 && echo available:node; exit 0',
    })
    return {
      docker: /(^|\n)available:docker(\n|$)/.test(outcome.output),
      podman: /(^|\n)available:podman(\n|$)/.test(outcome.output),
      node: /(^|\n)available:node(\n|$)/.test(outcome.output),
    }
  } catch {
    return { docker: false, podman: false, node: false }
  }
}

/**
 * The first declared file requirement the machine does not satisfy. An absent
 * `context` means the check cannot run, so nothing is reported as missing.
 * @param requirements - the variant's file requirements, when any.
 * @param context - home/dshHome placeholder bases for the candidate paths.
 * @returns the unsatisfied requirement's hint, or undefined when satisfied.
 */
function missingFileRequirement(
  requirements: readonly HeavyFileRequirement[] | undefined,
  context: { home: string; dshHome: string } | undefined,
): string | undefined {
  if (context === undefined) return undefined
  for (const requirement of requirements ?? []) {
    if (requirement.paths.some(path => existsSync(substitute(path, context.home, context.dshHome)))) continue
    return requirement.hint
  }
  return undefined
}

/** One local path's kind. */
export type LocalPathKind = 'detected' | 'vendor-app' | 'docker' | 'podman' | 'node' | 'unsupported'

/** The preflight verdict for one manifest on the host platform. */
export interface LocalPathChoice {
  path: LocalPathKind
  /** Human label of the chosen (or unavailable) path. */
  label: string
  deps: readonly string[]
  diskHint: string
  steps: readonly HeavyStep[]
  /** Machine prerequisites the chosen path needs; empty when none beyond the app. */
  requires: readonly ('docker' | 'podman')[]
  /** What is missing when no path is available. */
  missing: readonly string[]
}

/** The runtime a platform's variant needs (platform variant, then local default). */
function declaredRuntime(manifest: HeavyProviderManifest, platform: string): HeavyLocalRuntime {
  const variant = platform === 'linux' || platform === 'darwin' || platform === 'win32'
    ? manifest.local.install[platform]
    : undefined
  return variant?.runtime ?? manifest.local.runtime ?? 'node'
}

/**
 * Choose the platform's best local path: a detected instance first, then the
 * declared variant when it runs on this platform and its declared files and
 * runtime exist (vendor app, Docker, Podman as the Docker-compatible
 * substitute, or npm on Node), else the exact missing requirement.
 * @param manifest - heavy manifest.
 * @param platform - host platform key.
 * @param runtime - the runtimes the machine has.
 * @param detectedPort - port an already-running instance was found on.
 * @param context - home/dshHome placeholder bases for declared file requirements.
 * @returns the verdict the UI renders.
 */
export function chooseLocalPath(
  manifest: HeavyProviderManifest,
  platform: string,
  runtime: RuntimeProbe,
  detectedPort?: number,
  context?: { home: string; dshHome: string },
): LocalPathChoice {
  const resolved = resolveHeavyInstall(manifest.local, platform)
  if (detectedPort !== undefined) {
    return { path: 'detected', label: 'Use the detected instance', deps: [], diskHint: '', steps: [], requires: [], missing: [] }
  }
  const base = { deps: resolved.deps, diskHint: resolved.diskHint, steps: resolved.steps }
  const blocked = platformUnsupported(manifest, platform)
  if (blocked !== undefined) {
    return { path: 'unsupported', label: resolved.label, ...base, requires: [], missing: [blocked] }
  }
  const missingFile = missingFileRequirement(platformInstallVariant(manifest.local, platform).requiresFiles, context)
  if (missingFile !== undefined) {
    return { path: 'unsupported', label: resolved.label, ...base, requires: [], missing: [missingFile] }
  }
  switch (declaredRuntime(manifest, platform)) {
    case 'docker':
      if (runtime.docker) return { path: 'docker', label: resolved.label, ...base, requires: ['docker'], missing: [] }
      if (runtime.podman) return { path: 'podman', label: resolved.label, ...base, requires: ['podman'], missing: [] }
      return { path: 'unsupported', label: resolved.label, ...base, requires: ['docker'], missing: ['Docker Engine + Compose (or Podman)'] }
    case 'podman':
      return runtime.podman
        ? { path: 'podman', label: resolved.label, ...base, requires: ['podman'], missing: [] }
        : { path: 'unsupported', label: resolved.label, ...base, requires: ['podman'], missing: ['Podman'] }
    case 'vendor-app':
      return { path: 'vendor-app', label: resolved.label, ...base, requires: [], missing: [] }
    case 'node':
      // The dependency line names the version the path needs; it is the exact
      // requirement to show when the shell cannot resolve node at all.
      return runtime.node
        ? { path: 'node', label: resolved.label, ...base, requires: [], missing: [] }
        : { path: 'unsupported', label: resolved.label, ...base, requires: [], missing: [resolved.deps[0] ?? 'Node.js'] }
  }
}

/** One operator-owned override from `$DSH_HOME/heavy-server-overlay.json`. */
export interface ServerOverlayEntry {
  reuseBaseURL?: string
  reuseHealthURL?: string
  dashboardUrl?: string
}

/**
 * Read the private deployment overlay. The file is operator-owned data, never
 * shipped; an absent or malformed file means "no override" (fail-soft).
 * @param dshHome - the DSH home directory.
 * @returns provider id → override entry.
 */
export function readServerOverlay(dshHome: string): Record<string, ServerOverlayEntry> {
  try {
    const document = JSON.parse(readFileSync(join(dshHome, 'heavy-server-overlay.json'), 'utf8')) as unknown
    if (document === null || typeof document !== 'object' || Array.isArray(document)) return {}
    const entries = (document as { providers?: unknown }).providers
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return {}
    return entries as Record<string, ServerOverlayEntry>
  } catch {
    return {}
  }
}

/** Apply one overlay entry; the shipped table is returned untouched without one. */
export function overlayManifest(
  manifest: HeavyProviderManifest,
  entry: ServerOverlayEntry | undefined,
): HeavyProviderManifest {
  if (entry === undefined) return manifest
  return {
    ...manifest,
    ...entry.dashboardUrl === undefined ? {} : { dashboardUrl: entry.dashboardUrl },
    reuse: {
      ...manifest.reuse,
      ...entry.reuseBaseURL === undefined ? {} : { baseURL: entry.reuseBaseURL },
      ...entry.reuseHealthURL === undefined ? {} : { health: { ...manifest.reuse.health, url: entry.reuseHealthURL } },
    },
  }
}

/**
 * Build the route profile for one mode. Auth follows the manifest: `none`
 * writes `keyless`, `placeholder` writes only the reference (llm-pi-ai refuses
 * keyless anthropic routes), and the DSH key pool is NEVER declared — the
 * heavy providers either have their own pool (antigravity) or a single key.
 * @param manifest - heavy manifest.
 * @param mode - detected instance or local install.
 * @param models - discovered models; the fallback model fills an empty list.
 * @param overrides - detected address written instead of the declared default.
 * @returns the route profile written to settings.
 */
export function routeProfile(
  manifest: HeavyProviderManifest,
  mode: 'reuse' | 'local',
  models: ReadonlyArray<{ id: string; name?: string }>,
  overrides: { baseURL?: string } = {},
): HeavyRouteProfile {
  const list = models.length > 0
    ? models.map(model => model.name === undefined ? { id: model.id } : { id: model.id, name: model.name })
    : manifest.fallbackModel === undefined ? [] : [{ id: manifest.fallbackModel }]
  return {
    displayName: `${manifest.label}${mode === 'reuse' ? ' (detected)' : ' (local)'}`,
    api: manifest.protocol,
    baseURL: overrides.baseURL ?? modeBaseURL(manifest, mode),
    ...manifest.auth.apiKeyEnv === undefined ? {} : { apiKeyEnv: manifest.auth.apiKeyEnv },
    ...manifest.auth.kind === 'none' ? { keyless: true } : {},
    models: list,
  }
}

/**
 * Probe one health endpoint. Never throws: an unreachable dashboard or
 * service answers `{ ok: false }` so adding is never blocked by a probe.
 */
export async function probeHealth(
  probe: HeavyHealth,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  now: () => number = Date.now,
): Promise<{ ok: boolean; status?: number; error?: string; checkedAt: number }> {
  const checkedAt = now()
  try {
    const response = await fetchImpl(probe.url, { signal: AbortSignal.timeout(probe.timeoutMs ?? 5000) })
    const accepted = probe.expectStatus ?? undefined
    const statusOk = accepted === undefined ? response.status >= 200 && response.status < 300 : accepted.includes(response.status)
    if (!statusOk) return { ok: false, status: response.status, error: `HTTP ${String(response.status)}`, checkedAt }
    if (probe.expectBody !== undefined && !(await response.text()).includes(probe.expectBody)) {
      return { ok: false, status: response.status, error: `body missing "${probe.expectBody}"`, checkedAt }
    }
    return { ok: true, status: response.status, checkedAt }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), checkedAt }
  }
}

/** One discovered model, before enrichment. */
export interface DiscoveredModel {
  id: string
  name?: string
}

/**
 * Discover a route's models from `GET {baseURL}/models`. Best-effort: an
 * unreachable or refusing endpoint answers `[]` and the caller falls back to
 * the manifest's fallback model.
 */
export async function discoverModels(
  baseURL: string,
  apiKey: string | undefined,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<DiscoveredModel[]> {
  const url = `${baseURL.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey !== undefined && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return []
    const body = JSON.parse(await response.text()) as { data?: unknown } | unknown[]
    const rows = Array.isArray(body) ? body : body.data
    if (!Array.isArray(rows)) return []
    const seen = new Set<string>()
    const models: DiscoveredModel[] = []
    for (const row of rows.slice(0, 2000)) {
      if (row === null || typeof row !== 'object') continue
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      seen.add(id)
      const name = (row as { name?: unknown }).name
      models.push(typeof name === 'string' && name !== '' ? { id, name } : { id })
    }
    return models
  } catch {
    return []
  }
}

/** Current settings revision for one namespace, when the seam exposes one. */
function revisionOf(settings: SettingsSeam, ns: string): number | undefined {
  return settings.describe?.().find(entry => entry.ns === ns)?.revision
}

/** Read one namespace's document through the settings seam. */
export function readNamespace(settings: SettingsSeam | undefined, ns: string): Record<string, unknown> | undefined {
  const value = settings?.describe?.().find(entry => entry.ns === ns)?.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * The settings namespace one manifest's route profile is written to. Defaults
 * to llm-pi-ai; a custom-protocol provider names its own adapter plugin's
 * entry id so the profile never reaches a schema that cannot parse it.
 * @param manifest - heavy manifest.
 * @returns the plugin entry id whose settings section owns the route.
 */
export function routeSettingsNs(manifest: HeavyProviderManifest): string {
  return manifest.settingsNs ?? LLM_NS
}

/** A route namespace the running profile has not mounted yet. */
export interface PendingRestart {
  /** The settings namespace the route profile needs. */
  ns: string
  /** Operator-facing ordering message; the client renders it verbatim. */
  message: string
}

/**
 * The clear ordering message for a route namespace that only exists after the
 * profile is built and the service restarted.
 * @param ns - the settings namespace the route must be written to.
 * @returns the operator-facing message.
 */
export function pendingRestartMessage(ns: string): string {
  return `Available after the next restart — the "${ns}" settings namespace is not registered in the running profile yet (build the profile, then restart the service).`
}

/**
 * Whether one settings namespace is mounted in the running profile.
 * @param deps - host seams.
 * @param ns - settings namespace to look up.
 * @returns the settings describe verdict, or undefined when the seam cannot say.
 */
export function settingsNamespaceReady(deps: HeavyDeps, ns: string): boolean | undefined {
  const settings = deps.settings
  if (settings === undefined || settings.describe === undefined) return undefined
  return settings.describe().some(entry => entry.ns === ns)
}

/**
 * The pending-restart guard for one manifest: present only when the settings
 * describe proves the route namespace is absent, so the route write would
 * fail at `settings.mutate` with an error the operator cannot act on.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @returns the guard, or undefined when the write may proceed.
 */
export function pendingRestartForManifest(deps: HeavyDeps, manifest: HeavyProviderManifest): PendingRestart | undefined {
  const ns = routeSettingsNs(manifest)
  return settingsNamespaceReady(deps, ns) === false ? { ns, message: pendingRestartMessage(ns) } : undefined
}

/** The route profile already configured for one id, when any. */
export function configuredProfile(
  deps: HeavyDeps,
  id: string,
  settingsNs: string = LLM_NS,
): Record<string, unknown> | undefined {
  const section = readNamespace(deps.settings, settingsNs)
  const providers = section?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return undefined
  const profile = (providers as Record<string, unknown>)[id]
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return undefined
  return profile as Record<string, unknown>
}

/**
 * Write the route profile. Only ever called after a successful probe/install;
 * a failure rejects the caller and leaves no route behind.
 * @throws when the route namespace is not mounted in the running profile (the
 *   same pending-restart message reuse returns) or when no settings seam exists.
 */
export async function writeRoute(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  mode: 'reuse' | 'local',
  models: ReadonlyArray<DiscoveredModel>,
  overrides: { baseURL?: string } = {},
): Promise<HeavyRouteProfile> {
  const settings = deps.settings
  if (settings === undefined) throw new Error('settings seam absent — cannot write the route')
  const pending = pendingRestartForManifest(deps, manifest)
  if (pending !== undefined) throw new Error(pending.message)
  const profile = routeProfile(manifest, mode, models, overrides)
  const settingsNs = routeSettingsNs(manifest)
  await settings.mutate(settingsNs, [{ op: 'set', path: ['providers', manifest.id], value: profile }], revisionOf(settings, settingsNs))
  return profile
}

/** Store the unified key when the user supplied one; no key means no credential. */
export async function storeCredential(deps: HeavyDeps, manifest: HeavyProviderManifest, key: string | undefined): Promise<boolean> {
  const ref = manifest.auth.apiKeyEnv
  if (key === undefined || key.trim() === '' || ref === undefined) return false
  const credentials = deps.credentials
  if (credentials === undefined) throw new Error('credentials seam absent — cannot store the key')
  await credentials.set(ref, key.trim())
  return true
}

/** The outcome of one add. */
export interface ReuseOutcome {
  route: HeavyRouteProfile
  health: { ok: boolean; status?: number; error?: string; checkedAt: number }
  models: DiscoveredModel[]
  credentialStored: boolean
  /** The answering loopback (or overlay) port, when the detection found one. */
  port?: number
  /** The address the route was written with. */
  endpoint: string
}

/**
 * The zero-install add: detect a running instance (configured port, declared
 * endpoint, then the default port), discover its models, write the route at
 * the detected address, then store the key when one was supplied. The probe
 * never blocks the add — its verdict is reported for the UI's health badge.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param key - optional unified gateway key.
 * @returns the route written, the probe verdict, and whether a key was stored.
 */
export async function useDetectedInstance(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  key?: string,
): Promise<ReuseOutcome> {
  const profile = configuredProfile(deps, manifest.id, routeSettingsNs(manifest))
  const configuredBase = typeof profile?.baseURL === 'string' ? profile.baseURL : undefined
  const detection = await detectInstance(deps, manifest, configuredBase)
  const endpoint = detection.ok ? detection.baseURL : manifest.reuse.baseURL
  const models = await discoverModels(endpoint, key, deps.fetchImpl)
  const route = await writeRoute(deps, manifest, 'reuse', models, { baseURL: endpoint })
  const credentialStored = await storeCredential(deps, manifest, key)
  return {
    route,
    health: detection.health,
    models,
    credentialStored,
    ...detection.ok && detection.port !== undefined ? { port: detection.port } : {},
    endpoint,
  }
}

/* ── removal ─────────────────────────────────────────────────────────────── */

/** The discovered-model cache path (mirrors the provider-sync contract). */
export function discoveredCachePath(deps: HeavyDeps): string {
  const override = process.env.DSH_DISCOVERED_MODELS
  if (override !== undefined && override.length > 0) return override
  return join(deps.dshHome, 'cache', 'discovered-models.json')
}

/** Delete one route's entry from the discovered-model cache; returns whether it existed. */
export function removeDiscoveredEntry(deps: HeavyDeps, id: string): boolean {
  const path = discoveredCachePath(deps)
  if (!existsSync(path)) return false
  try {
    const document = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; routes?: Record<string, unknown> }
    const routes = document.routes
    if (routes === null || typeof routes !== 'object' || routes === undefined) return false
    if (!(id in routes)) return false
    delete routes[id]
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${String(process.pid)}`
    writeFileSync(temporary, JSON.stringify(document), 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    return false
  }
}

/**
 * Delete `$DSH_HOME/pools/<id>.json` — the fork's per-route key-pool state.
 * A missing file is not an error.
 */
export function removePoolState(deps: HeavyDeps, id: string): boolean {
  const path = join(deps.dshHome, 'pools', `${id}.json`)
  if (!existsSync(path)) return false
  try {
    rmSync(path)
    return true
  } catch {
    return false
  }
}

/** Whether one chain link references a route. */
function linkReferences(link: unknown, id: string): boolean {
  return link !== null && typeof link === 'object' && (link as { provider?: unknown }).provider === id
}

/**
 * Remove every chain link that names the route. A chain left with no links
 * and no selectors is dropped with it. Returns the number of removed links;
 * a document that does not change is not written.
 */
export async function removeChainReferences(deps: HeavyDeps, id: string): Promise<number> {
  const settings = deps.settings
  const document = readNamespace(settings, ORCHESTRATION_NS)
  const chains = document?.chains
  if (chains === null || typeof chains !== 'object' || Array.isArray(chains)) return 0
  let removed = 0
  const next: Record<string, unknown> = {}
  for (const [chainId, raw] of Object.entries(chains as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      next[chainId] = raw
      continue
    }
    const chain = raw as Record<string, unknown>
    const links = Array.isArray(chain.links) ? chain.links : []
    const kept = links.filter((link) => {
      const drop = linkReferences(link, id)
      if (drop) removed += 1
      return !drop
    })
    const selectors = Array.isArray(chain.selectors) ? chain.selectors : []
    if (kept.length === 0 && selectors.length === 0 && links.length > 0) continue
    next[chainId] = kept.length === links.length ? chain : { ...chain, links: kept }
  }
  if (removed === 0 || settings === undefined) return removed
  await settings.mutate(ORCHESTRATION_NS, [{ op: 'set', path: ['chains'], value: next }], revisionOf(settings, ORCHESTRATION_NS))
  return removed
}

/** What one removal changed. */
export interface RemovalSummary {
  routeRemoved: boolean
  credentialRemoved: boolean
  poolStateRemoved: boolean
  cacheEntryRemoved: boolean
  chainLinksRemoved: number
  teardown: { ran: boolean; ok: boolean; failedStep?: string; output: string }
  errors: string[]
}

/**
 * Remove every trace of a heavy provider: optional local teardown, then the
 * DSH route, credential reference, pool state, discovered-cache entry, and
 * chain links. Every sub-step is fail-soft and reported in the summary.
 */
export async function removeProvider(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  options: { uninstall?: boolean } = {},
): Promise<RemovalSummary> {
  const errors: string[] = []
  let teardown: RemovalSummary['teardown'] = { ran: false, ok: true, output: '' }
  if (options.uninstall === true && manifest.removal.steps.length > 0) {
    let output = ''
    let ok = true
    let failedStep: string | undefined
    for (const step of manifest.removal.steps) {
      try {
        const outcome = await deps.runStep(step)
        output += `$ ${step.label}\n${outcome.output}\n`
        if (outcome.exitCode !== 0 && step.optional !== true) {
          ok = false
          failedStep = step.label
          break
        }
      } catch (error) {
        if (step.optional === true) {
          output += `$ ${step.label} (optional, failed: ${error instanceof Error ? error.message : String(error)})\n`
          continue
        }
        ok = false
        failedStep = step.label
        output += `$ ${step.label} (failed: ${error instanceof Error ? error.message : String(error)})\n`
        break
      }
    }
    teardown = { ran: true, ok, ...failedStep === undefined ? {} : { failedStep }, output }
  }

  let routeRemoved = false
  const settingsNs = routeSettingsNs(manifest)
  if (deps.settings !== undefined && configuredProfile(deps, manifest.id, settingsNs) !== undefined) {
    try {
      await deps.settings.mutate(settingsNs, [{ op: 'unset', path: ['providers', manifest.id] }], revisionOf(deps.settings, settingsNs))
      routeRemoved = true
    } catch (error) {
      errors.push(`route: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let credentialRemoved = false
  if (deps.credentials !== undefined && manifest.auth.apiKeyEnv !== undefined) {
    try {
      await deps.credentials.unset(manifest.auth.apiKeyEnv)
      credentialRemoved = true
    } catch (error) {
      errors.push(`credential: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const poolStateRemoved = removePoolState(deps, manifest.id)
  const cacheEntryRemoved = removeDiscoveredEntry(deps, manifest.id)
  let chainLinksRemoved = 0
  try {
    chainLinksRemoved = await removeChainReferences(deps, manifest.id)
  } catch (error) {
    errors.push(`chains: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { routeRemoved, credentialRemoved, poolStateRemoved, cacheEntryRemoved, chainLinksRemoved, teardown, errors }
}
