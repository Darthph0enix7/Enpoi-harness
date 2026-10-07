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
import type { HeavyFileRequirement, HeavyHealth, HeavyLocalRuntime, HeavyManifestPool, HeavyProviderManifest, HeavyStep } from './manifests.js'

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

/** One model a provider-side discovery answers about a route. */
export interface ModelDiscoveryEntry {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
}

/**
 * Minimal model-discovery seam (matches the live Llm service's
 * `discoverModels`). A provider plugin registers a discovery per settings
 * namespace; resolving it in-process costs no network call for a direct
 * vendor route.
 */
export interface ModelDiscoverySeam {
  discoverModels(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
  ): Promise<readonly ModelDiscoveryEntry[]>
}

/** Everything a planner call needs from the host. */
export interface HeavyDeps {
  /** User home; `{home}`/`{config}` placeholder base. */
  home: string
  /** DSH home directory; pools and the discovered-model cache live under it. */
  dshHome: string
  settings?: SettingsSeam | undefined
  credentials?: CredentialsSeam | undefined
  /** Route-namespace model discovery, when the owning adapter plugin is mounted. */
  llm?: ModelDiscoverySeam | undefined
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
  /** Provider-native credential pool declared by a custom-protocol manifest. */
  pool?: HeavyManifestPool
  models: Array<{
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    input?: readonly string[]
  }>
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

/**
 * The health probe for a configured route address, host and port substituted.
 * The manifest's declared health path stays authoritative: the service serves
 * it at its own root, not under the API base path (`/v1` and `/api/ping` are
 * siblings in the live FreeLLMAPI), so only the origin is taken from the
 * address.
 */
export function healthForBase(manifest: HeavyProviderManifest, baseURL: string): HeavyHealth {
  try {
    const base = new URL(baseURL)
    const declared = new URL(manifest.reuse.health.url)
    return { ...manifest.reuse.health, url: `${base.protocol}//${base.host}${declared.pathname}` }
  } catch {
    return manifest.reuse.health
  }
}

/**
 * Accept an operator-typed instance address: an absolute http(s) URL with a
 * port in 1–65535, without embedded credentials, query, or fragment,
 * normalized to its origin. The manifest owns the service's paths, so a typed
 * path is dropped here rather than silently half-honored: the route endpoint
 * and the health probe are rebuilt from the origin plus the manifest's
 * declared endpoint/health paths, and the UI hint states origin-only. A
 * non-loopback host is accepted — an operator typing one is the explicit
 * action the manifest's "never expose" quirks assume — and the declared
 * loopback default remains when nothing is typed.
 * @param value - the typed value.
 * @returns the normalized origin, or undefined for an empty or invalid value.
 */
export function instanceBaseURLFromInput(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.username !== '' || parsed.password !== '') return undefined
    if (parsed.search !== '' || parsed.hash !== '') return undefined
    if (parsed.port !== '' && Number(parsed.port) < 1) return undefined
    return parsed.origin
  } catch {
    return undefined
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
  // A direct manifest addresses the vendor's public endpoint; there is no
  // on-device instance to probe, and probing the vendor from detection would
  // report it as a local instance.
  if (manifest.delivery === 'direct') return []
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
 * fallback address when nothing answers. A `delivery: 'direct'` manifest has
 * no on-device instance and answers the same fail-soft not-applicable result.
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
  if (manifest.delivery === 'direct') {
    return {
      ok: false,
      baseURL: manifest.reuse.baseURL,
      url: manifest.reuse.health.url,
      health: { ok: false, error: 'direct vendor endpoint — no local instance to detect', checkedAt: Date.now() },
    }
  }
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
  /** Major `node -v` reports in that shell; absent when node is absent or silent. */
  nodeMajor?: number
  /** The user systemd manager answers, so `systemctl --user` can manage a unit. */
  systemdUser: boolean
}

/**
 * Detect Docker, Podman, Node (with its major version), and the user systemd
 * manager with one shell probe. Fail-soft: an absent runner or a failed step
 * reports nothing installed rather than blocking the page.
 * @param runStep - the host's step runner.
 * @returns availability of each runtime the local install paths use.
 */
export async function detectRuntimes(runStep: (step: HeavyStep) => Promise<StepOutcome>): Promise<RuntimeProbe> {
  try {
    const outcome = await runStep({
      label: 'Detect local runtimes',
      command: 'command -v docker >/dev/null 2>&1 && echo available:docker; command -v podman >/dev/null 2>&1 && echo available:podman; command -v node >/dev/null 2>&1 && echo available:node; command -v node >/dev/null 2>&1 && node -v 2>/dev/null | cut -d. -f1 | tr -d v | sed \'s/^/node-major:/\'; systemctl --user show-environment >/dev/null 2>&1 && echo available:systemd-user; exit 0',
    })
    const nodeMajor = /(^|\n)node-major:(\d+)(\n|$)/.exec(outcome.output)?.[2]
    return {
      docker: /(^|\n)available:docker(\n|$)/.test(outcome.output),
      podman: /(^|\n)available:podman(\n|$)/.test(outcome.output),
      node: /(^|\n)available:node(\n|$)/.test(outcome.output),
      ...nodeMajor === undefined ? {} : { nodeMajor: Number(nodeMajor) },
      systemdUser: /(^|\n)available:systemd-user(\n|$)/.test(outcome.output),
    }
  } catch {
    return { docker: false, podman: false, node: false, systemdUser: false }
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
 * The minimum Node major version one resolved install's dependency hints
 * declare, read from the first line naming one (e.g. `Node.js 22` or
 * `Node.js >= 18`). A hint that names no version leaves the requirement open.
 * @param deps - the resolved variant's dependency hints.
 * @returns the declared major, or undefined when no hint names one.
 */
function declaredNodeMajor(deps: readonly string[]): number | undefined {
  for (const dep of deps) {
    const match = /^Node\.js\s*(?:>=\s*)?(\d+)/.exec(dep.trim())
    if (match?.[1] !== undefined) return Number(match[1])
  }
  return undefined
}

/**
 * Choose the platform's best local path: a detected instance first, then the
 * declared variant when it runs on this platform and its declared files and
 * runtime exist (vendor app, Docker, Podman as the Docker-compatible
 * substitute, or npm on Node), else the exact missing requirement. A node path
 * whose probe reports a major below the variant's declared requirement (for
 * example `Node.js 22`) is refused with the version as the missing item; a
 * probe that cannot report a version leaves the path approved, since it
 * cannot prove the requirement unmet.
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
    case 'node': {
      // The dependency line names the version the path needs; it is the exact
      // requirement to show when the shell cannot resolve node at all.
      if (!runtime.node) {
        return { path: 'unsupported', label: resolved.label, ...base, requires: [], missing: [resolved.deps[0] ?? 'Node.js'] }
      }
      // A declared minimum Node major is a real requirement: the setup step
      // dies when the shell's node is too old. Only a probe that reports a
      // version can prove it unmet; an absent version keeps the path approved.
      const requiredNodeMajor = declaredNodeMajor(resolved.deps)
      if (requiredNodeMajor !== undefined && runtime.nodeMajor !== undefined && runtime.nodeMajor < requiredNodeMajor) {
        return { path: 'unsupported', label: resolved.label, ...base, requires: [], missing: [`Node.js >= ${String(requiredNodeMajor)}`] }
      }
      // A variant that provisions a systemd user unit needs the user manager
      // to answer too: a shell with node but no `systemctl --user` would
      // install the package and then die at the unit step. The install path
      // is reported unavailable with the real missing requirement instead.
      const needsSystemdUser = resolved.steps.some(step => step.command.includes('systemctl --user'))
      if (needsSystemdUser && !runtime.systemdUser) {
        return {
          path: 'unsupported',
          label: resolved.label,
          ...base,
          requires: [],
          missing: ['A reachable systemd user session (`systemctl --user`)'],
        }
      }
      return { path: 'node', label: resolved.label, ...base, requires: [], missing: [] }
    }
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
 * keyless anthropic routes), and a manifest-declared `pool` is written as the
 * route's provider-native pool (identities only — secrets stay in the
 * credentials store). An llm-pi-ai route never declares a pool: the heavy
 * providers either have their own pool (antigravity) or a single key.
 * @param manifest - heavy manifest.
 * @param mode - detected instance or local install.
 * @param models - discovered models; the fallback model fills an empty list.
 * @param overrides - detected address written instead of the declared default.
 * @returns the route profile written to settings.
 */
export function routeProfile(
  manifest: HeavyProviderManifest,
  mode: 'reuse' | 'local',
  models: ReadonlyArray<DiscoveredModel>,
  overrides: { baseURL?: string } = {},
): HeavyRouteProfile {
  const list = models.length > 0
    ? models.map(model => ({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        ...model.input === undefined || model.input.length === 0 ? {} : { input: [...model.input] },
      }))
    : manifest.fallbackModel === undefined ? [] : [{ id: manifest.fallbackModel }]
  // A direct route never runs a local service, so its name must not carry the
  // setup path's "(local)" suffix even though the setup flow provisioned it.
  const suffix = manifest.delivery === 'direct' ? ' (direct)' : mode === 'local' ? ' (local)' : ' (detected)'
  return {
    displayName: `${manifest.label}${suffix}`,
    api: manifest.protocol,
    baseURL: overrides.baseURL ?? modeBaseURL(manifest, mode),
    ...manifest.auth.apiKeyEnv === undefined ? {} : { apiKeyEnv: manifest.auth.apiKeyEnv },
    ...manifest.auth.kind === 'none' ? { keyless: true } : {},
    ...manifest.pool === undefined
      ? {}
      : {
          pool: {
            ...manifest.pool.strategy === undefined ? {} : { strategy: manifest.pool.strategy },
            identities: manifest.pool.identities.map(identity => ({ ...identity })),
          },
        },
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
    const response = await fetchImpl(probe.url, {
      ...probe.headers === undefined ? {} : { headers: { ...probe.headers } },
      signal: AbortSignal.timeout(probe.timeoutMs ?? 5000),
    })
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
  /** Maximum combined request and response context the source disclosed. */
  contextWindow?: number
  /** Maximum output tokens the source disclosed. */
  maxTokens?: number
  /** Accepted input modalities the source disclosed. */
  input?: readonly string[]
}

/** Stable API version required by Anthropic's native model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * The model-listing URL one protocol serves. OpenAI protocols list at
 * `{baseURL}/models`. Anthropic Messages lists at the root's `/v1/models`
 * (`discovery.ts` in llm-pi-ai makes the same call): a base that already
 * carries one trailing `/v1` segment keeps every other path segment and gets
 * the required prefix back, and the public endpoint's page cap is requested so
 * a large catalog is not truncated to the default page. The proxy under the
 * antigravity route serves exactly this Anthropic address while its route
 * baseURL deliberately carries no `/v1`.
 * @param baseURL - the configured endpoint base.
 * @param api - the route's wire protocol, when known.
 * @returns the absolute listing URL.
 */
export function modelListingUrl(baseURL: string, api?: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=1000`
}

/**
 * One listing entry field as a non-empty label. The proxy discloses the human
 * model name in `description`; a value long enough to be prose rather than a
 * name is refused so it never becomes a route row's label.
 */
function listingLabel(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 200) return candidate
  }
  return undefined
}

/** One listing entry field as a positive integer capacity, or undefined. */
function listingCapacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** The listing fields a compatible endpoint may disclose beyond the id. */
interface ListingEntry {
  id?: unknown
  name?: unknown
  displayName?: unknown
  display_name?: unknown
  description?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  limit?: { context?: unknown; output?: unknown } | null
  maxOutputTokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  max_tokens?: unknown
  top_provider?: { max_completion_tokens?: unknown } | null
}

/**
 * Read one model listing: the standard `data` array or an enriched `models`
 * map, whose property key is the endpoint-facing id. Entries without an id
 * are skipped; capacities are kept only when the endpoint discloses them.
 */
function readModelListing(body: unknown): DiscoveredModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  let rows: Array<{ key?: string; raw: unknown }>
  if (Array.isArray(body)) {
    rows = body.map(raw => ({ raw }))
  } else if (Array.isArray(listing?.data)) {
    rows = (listing.data as readonly unknown[]).map(raw => ({ raw }))
  } else if (listing?.models !== null && typeof listing?.models === 'object' && !Array.isArray(listing.models)) {
    rows = Object.entries(listing.models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  } else {
    return []
  }
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const { key, raw } of rows.slice(0, 2000)) {
    const entry = raw as ListingEntry | null
    const id = listingLabel(key, entry?.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = listingLabel(entry?.name, entry?.displayName, entry?.display_name, entry?.description)
    const contextWindow = listingCapacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = listingCapacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    models.push({
      id,
      ...name === undefined || name === id ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * Discover a route's models at its protocol's native listing address — `GET
 * {baseURL}/models` for the OpenAI protocols, `GET /v1/models` for Anthropic
 * Messages. Best-effort: an unreachable or refusing endpoint answers `[]` and
 * the caller falls back to the manifest's fallback model.
 * @param baseURL - the configured endpoint base.
 * @param apiKey - the credential to present, when any.
 * @param fetchImpl - fetch seam (tests inject one).
 * @param api - the route's wire protocol; Anthropic routes select the native
 *   listing address and credential header.
 * @returns the disclosed models in endpoint order.
 */
export async function discoverModels(
  baseURL: string,
  apiKey: string | undefined,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  api?: string,
): Promise<DiscoveredModel[]> {
  const url = modelListingUrl(baseURL, api)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (apiKey !== undefined && apiKey.length > 0) headers['x-api-key'] = apiKey
  } else if (apiKey !== undefined && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`
  }
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return []
    return readModelListing(JSON.parse(await response.text()) as unknown)
  } catch {
    return []
  }
}

/**
 * Ask the route namespace's registered model discovery for the endpoint's
 * models. A namespace with no discovery (an adapter family without one, or a
 * provider plugin not mounted yet) answers nothing, and the manifest's
 * declarative fallback model fills the route — discovery is an enrichment,
 * never a write gate. A direct vendor route resolves the bundled catalog with
 * no network call and no quota.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param baseURL - endpoint the written route points at.
 * @param apiKey - one-shot credential the add carries, when any; a configured
 *   route's stored credential is resolved by the namespace's own discovery.
 * @returns discovered models with the capacities and modalities disclosed.
 */
export async function discoverRouteModels(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  baseURL: string,
  apiKey?: string,
): Promise<DiscoveredModel[]> {
  const llm = deps.llm
  if (llm === undefined) return []
  try {
    const found = await llm.discoverModels(routeSettingsNs(manifest), {
      provider: manifest.id,
      baseURL,
      api: manifest.protocol,
      ...apiKey === undefined || apiKey.length === 0 ? {} : { apiKey },
    })
    return found.flatMap((model): DiscoveredModel[] => {
      if (model.id === '') return []
      const input = (model.inputModalities ?? []).filter(modality => typeof modality === 'string' && modality !== '')
      return [{
        id: model.id,
        ...model.name === undefined || model.name === model.id ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        ...input.length === 0 ? {} : { input },
      }]
    })
  } catch {
    // A refused or absent discovery leaves the declarative fallback model in
    // place; the route write must not depend on the enrichment answering.
    return []
  }
}

/**
 * Discover the models for a route being added. A service route asks its own
 * endpoint first at the protocol's native listing address, using the key
 * carried by the add or — when none was typed — the route reference's already
 * stored credential, so a re-add never downgrades a configured gateway to its
 * fallback model. A listing that answers nothing falls back to the route
 * namespace's registered discovery (the same path the Refresh action uses),
 * which can resolve a configured route's stored credential and any listing
 * path its adapter knows. A direct vendor route has no endpoint to list and
 * always uses the namespace discovery. Best-effort throughout: an unreachable
 * or refusing source leaves the caller's fallback model in place.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param baseURL - endpoint the written route points at.
 * @param apiKey - credential the operator supplied with the add, when any.
 * @returns discovered models, or `[]` when nothing could be read.
 */
export async function discoverServiceModels(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  baseURL: string,
  apiKey?: string,
): Promise<DiscoveredModel[]> {
  if (manifest.delivery === 'direct') return discoverRouteModels(deps, manifest, baseURL, apiKey)
  let key = apiKey
  const ref = manifest.auth.apiKeyEnv
  if (key === undefined && ref !== undefined && deps.credentials !== undefined) {
    try {
      key = (await deps.credentials.resolve(ref))?.value
    } catch {
      key = undefined
    }
  }
  const listed = await discoverModels(baseURL, key, deps.fetchImpl, manifest.protocol)
  return listed.length > 0 ? listed : discoverRouteModels(deps, manifest, baseURL, key)
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

/**
 * Store the key the operator supplied with an add. A pooled manifest stores it
 * under its first identity's reference (the Keys card slot a fresh route
 * shows); otherwise the unified/placeholder auth reference is the target. No
 * key means no credential.
 */
export async function storeCredential(deps: HeavyDeps, manifest: HeavyProviderManifest, key: string | undefined): Promise<boolean> {
  const ref = manifest.pool?.identities[0]?.credentialRef ?? manifest.auth.apiKeyEnv
  if (key === undefined || key.trim() === '' || ref === undefined) return false
  const credentials = deps.credentials
  if (credentials === undefined) throw new Error('credentials seam absent — cannot store the key')
  await credentials.set(ref, key.trim())
  return true
}

/**
 * Write a route and its credential as one commit. The credential is stored
 * before the route, so a rejected store leaves no route behind; when the route
 * write then fails, the credential is rolled back to its previous value (unset
 * when it had none), so after any failure either both exist or neither. The
 * route namespace guard runs first: an unmounted namespace fails before any
 * credential is touched. A manifest with no reference, or a blank key, stores
 * no credential and the route write proceeds alone.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param mode - detected instance or local install.
 * @param models - discovered models; the fallback model fills an empty list.
 * @param key - optional unified/gateway key stored with the route.
 * @param overrides - detected address written instead of the declared default.
 * @returns the written profile and whether a credential was stored.
 * @throws when the settings/credentials seam is absent, the namespace is not
 *   mounted, or either write is refused.
 */
export async function commitRoute(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  mode: 'reuse' | 'local',
  models: ReadonlyArray<DiscoveredModel>,
  key: string | undefined,
  overrides: { baseURL?: string } = {},
): Promise<{ route: HeavyRouteProfile; credentialStored: boolean }> {
  if (deps.settings === undefined) throw new Error('settings seam absent — cannot write the route')
  const pending = pendingRestartForManifest(deps, manifest)
  if (pending !== undefined) throw new Error(pending.message)
  const credentials = deps.credentials
  const ref = manifest.pool?.identities[0]?.credentialRef ?? manifest.auth.apiKeyEnv
  const value = key?.trim() ?? ''
  const store = value !== '' && ref !== undefined
  let previous: { value?: string } | undefined
  if (store) {
    if (credentials === undefined) throw new Error('credentials seam absent — cannot store the key')
    previous = await credentials.resolve(ref)
    await credentials.set(ref, value)
  }
  let route: HeavyRouteProfile
  try {
    route = await writeRoute(deps, manifest, mode, models, overrides)
  } catch (error) {
    if (store && credentials !== undefined) {
      try {
        if (previous?.value !== undefined) await credentials.set(ref, previous.value)
        else await credentials.unset(ref)
      } catch (rollbackError) {
        const cause = error instanceof Error ? error.message : String(error)
        const failed = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(`${cause} (credential rollback also failed: ${failed})`)
      }
    }
    throw error
  }
  return { route, credentialStored: store }
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
 * A `delivery: 'direct'` manifest skips detection and probes the declared
 * vendor endpoint for the health badge; its models come from the route
 * namespace's registered discovery (the bundled catalog, no network call)
 * instead of a `{baseURL}/models` listing.
 *
 * A typed `options.baseURL` is the operator's custom-instance fallback: it
 * skips detection and is normalized to its origin, and the manifest's
 * declared endpoint path is applied to it, so the route is written at the
 * same canonical layout as the manifest's own address. The health probe uses
 * that origin with the manifest's declared health path (`healthForBase`), so
 * badge and route describe one endpoint. The value is validated at the wire
 * boundary before it reaches here; an invalid value is refused, never
 * silently ignored. The route and its credential commit atomically
 * (`commitRoute`): after any failure either both exist or neither.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param key - optional unified gateway key.
 * @param options - operator-typed custom instance address, when any.
 * @returns the route written, the probe verdict, and whether a key was stored.
 */
export async function useDetectedInstance(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  key?: string,
  options: { baseURL?: string } = {},
): Promise<ReuseOutcome> {
  const direct = manifest.delivery === 'direct'
  const typedOrigin = options.baseURL === undefined ? undefined : instanceBaseURLFromInput(options.baseURL)
  if (options.baseURL !== undefined && typedOrigin === undefined) {
    throw new Error('invalid custom instance base URL')
  }
  // The typed address is an origin; the manifest owns the service's paths.
  const customBase = typedOrigin === undefined ? undefined : `${typedOrigin}${urlPath(manifest.reuse.baseURL)}`
  const profile = configuredProfile(deps, manifest.id, routeSettingsNs(manifest))
  const configuredBase = typeof profile?.baseURL === 'string' ? profile.baseURL : undefined
  const detection = direct || customBase !== undefined
    ? undefined
    : await detectInstance(deps, manifest, configuredBase)
  const endpoint = direct
    ? manifest.reuse.baseURL
    : customBase ?? (detection!.ok ? detection!.baseURL : manifest.reuse.baseURL)
  // A service route lists its own endpoint at its protocol's native address;
  // a refused listing falls back to the route namespace's registered
  // discovery. A direct vendor route has no /models endpoint at all and
  // always uses the namespace discovery.
  const models = await discoverServiceModels(deps, manifest, endpoint, key)
  const health = direct
    ? await probeHealth(manifest.reuse.health, deps.fetchImpl)
    : typedOrigin !== undefined
      ? await probeHealth(healthForBase(manifest, typedOrigin), deps.fetchImpl)
      : detection!.health
  const { route, credentialStored } = await commitRoute(deps, manifest, 'reuse', models, key, { baseURL: endpoint })
  const customPort = typedOrigin === undefined ? undefined : urlPort(typedOrigin)
  return {
    route,
    health,
    models,
    credentialStored,
    ...detection?.ok === true && detection.port !== undefined
      ? { port: detection.port }
      : customPort === undefined ? {} : { port: customPort },
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
  /** Non-fatal facts the operator should see, e.g. a shared credential left in place. */
  warnings: string[]
  errors: string[]
}

/**
 * Whether any configured route other than the one being removed resolves this
 * credential reference. Every settings namespace's `providers` map is
 * inspected; a route's `apiKeyEnv` and its pool identities' `credentialRef`
 * both count. A settings seam that cannot describe its namespaces answers
 * false, so removal keeps its unconditional-unset behavior when nothing can
 * be inspected.
 * @param deps - host seams.
 * @param manifest - the manifest being removed.
 * @param ref - the credential reference to look for.
 * @returns whether another configured route still resolves the reference.
 */
export function credentialRefInUse(deps: HeavyDeps, manifest: HeavyProviderManifest, ref: string): boolean {
  const entries = deps.settings?.describe?.()
  if (entries === undefined) return false
  const removedNs = routeSettingsNs(manifest)
  for (const entry of entries) {
    const value = entry.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const providers = (value as Record<string, unknown>).providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue
    for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (entry.ns === removedNs && id === manifest.id) continue
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const route = raw as Record<string, unknown>
      if (route.apiKeyEnv === ref) return true
      const pool = route.pool
      if (pool === null || typeof pool !== 'object' || Array.isArray(pool)) continue
      const identities = (pool as Record<string, unknown>).identities
      if (!Array.isArray(identities)) continue
      if (identities.some(identity => identity !== null && typeof identity === 'object' && !Array.isArray(identity)
        && (identity as Record<string, unknown>).credentialRef === ref)) return true
    }
  }
  return false
}

/**
 * Remove every trace of a heavy provider: optional local teardown, then the
 * DSH route, credential reference, pool state, discovered-cache entry, and
 * chain links. Every sub-step is fail-soft and reported in the summary. The
 * credential reference is unset only when no other configured route resolves
 * it; a shared reference is left in place and named in `warnings`.
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

  const warnings: string[] = []
  let credentialRemoved = false
  const credentialRef = manifest.auth.apiKeyEnv
  if (deps.credentials !== undefined && credentialRef !== undefined) {
    if (credentialRefInUse(deps, manifest, credentialRef)) {
      // Another configured route (a second provider sharing the env ref, or
      // one of its pool identities) still resolves it: unsets here would break
      // that route's credentials, so the reference stays and is reported.
      warnings.push(`credential ${credentialRef} kept: another configured route references it`)
    } else {
      try {
        await deps.credentials.unset(credentialRef)
        credentialRemoved = true
      } catch (error) {
        errors.push(`credential: ${error instanceof Error ? error.message : String(error)}`)
      }
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

  return { routeRemoved, credentialRemoved, poolStateRemoved, cacheEntryRemoved, chainLinksRemoved, teardown, warnings, errors }
}
