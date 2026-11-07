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
import { listingText, readModelListing, type ListingEntry, type ListingModel } from '@deepseek-ai/dsh-llm-pi-ai'
import { parseReleaseSource, platformInstallVariant, platformUnsupported, resolveHeavyInstall } from './manifests.js'
import { acquireProviderLock } from './provider-lock.js'
import {
  clearProviderLifecycle,
  lifecycleOf,
  ownsLocalInstall,
  recordReuseLifecycle,
  type HeavyLifecycleEntry,
} from './state.js'
import type { HeavyFileRequirement, HeavyHealth, HeavyLocalRuntime, HeavyManifestPool, HeavyProviderManifest, HeavyStep } from './manifests.js'

/** The llm-pi-ai settings namespace every route write targets. */
export const LLM_NS = 'llm-pi-ai'
/** The namespace that owns `chains` (registered by enpoi-capabilities). */
export const ORCHESTRATION_NS = 'enpoi-orchestration'

/** Minimal settings seam (matches the live service). */
export interface SettingsSeam {
  describe?(): Array<{ ns: string; revision: number; value?: unknown }>
  /** 0.1.7+ narrow seam: one namespace's descriptor instead of the full set. */
  describeNamespace?(ns: string): { value?: unknown } | undefined
  mutate(ns: string, ops: readonly Record<string, unknown>[], expectedRevision?: number): Promise<void>
}

/** Minimal credentials seam (matches the live service). */
export interface CredentialsSeam {
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** One response-body reader when the fetch seam exposes a stream. */
interface FetchBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  cancel?(): Promise<void>
}

/** The subset of `fetch` the planner uses. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  headers?: { get(name: string): string | null } | undefined
  /** Optional streaming body; the bounded reader uses it when available. */
  body?: { getReader(): FetchBodyReader } | null | undefined
}>

/** One model a provider-side discovery answers about a route. */
export interface ModelDiscoveryEntry {
  id: string
  name?: string
  contextWindow?: number
  /** Maximum input (prompt-side) tokens when the source states one separately. */
  maxInputTokens?: number
  maxTokens?: number
  inputModalities?: readonly string[]
  /** Whether the source stated tool-call support; absent means undisclosed. */
  tools?: boolean
  /** Whether the source stated reasoning support; absent means undisclosed. */
  reasoning?: boolean
  /** Selectable reasoning levels (picker id → wire value), or `false` to disable reasoning. */
  reasoningEfforts?: Readonly<Record<string, string>> | false
  /** Advertised effort identifiers no configured level accepts; diagnostics only. */
  unsupportedReasoningEfforts?: readonly string[]
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
  /**
   * The shared install-job manager, when one exists. Removal takes the same
   * per-provider lock an install owns, then evicts the provider's snapshot
   * (the in-memory view and its `$DSH_HOME/cache/heavy-jobs/<id>.json`) so a
   * terminal job from an earlier install cannot resurrect once the route is
   * gone. A live or unreadable lock refuses removal before any mutation.
   */
  jobs?: {
    /** Drop the terminal snapshot; false when a live owner refused. */
    evict(id: string): boolean
    /** Whether a running job elsewhere owns this provider. */
    isRunning(id: string): boolean
    /** Run one provider-scoped operation under the install lock. */
    withProviderLock<T>(id: string, operation: () => Promise<T>): Promise<T>
  } | undefined
  /**
   * Trusted host installer ownership reader. Called only after every install
   * step succeeded; the callback reads and validates the concrete installer's
   * receipt for this provider. Returning undefined (or omitting the callback)
   * leaves the install unowned. A client-supplied string is never consulted.
   * The value is an opaque ownership proof (never a credential).
   */
  readInstallReceipt?: ((id: string) => Promise<string | undefined> | string | undefined) | undefined
  /**
   * Trusted host installer credential reader. Called only after every install
   * step succeeded, for a local install whose service seeds its own client
   * credential. The value is stored through the credentials seam before model
   * discovery and the route commit; it never reaches a wire reply or log.
   */
  readInstallCredential?: ((id: string) => Promise<string | undefined> | string | undefined) | undefined
  /**
   * Trusted host reader for the secretless install paths a dashboard hint may
   * show: where the generated bootstrap/management key lives. Never returns
   * the key itself.
   */
  readInstallPaths?: ((id: string) => Promise<{ bootstrapPath?: string; managementKeyPath?: string } | undefined> | { bootstrapPath?: string; managementKeyPath?: string } | undefined) | undefined
  /**
   * Trusted helper preflight called before a local install job is created.
   * When the helper provides a port preflight it answers `ok: false` with a
   * reason; a missing helper capability leaves the verdict undefined.
   */
  installPreflight?: ((id: string) => Promise<{ ok: boolean; reason?: string } | undefined>) | undefined
  /**
   * Absolute path of this plugin's installer helper, used by the manifest's
   * `{helper}` file requirement. Wired from the plugin's own module location;
   * omitted in unit tests that do not execute the helper.
   */
  installHelperPath?: string | undefined
  /**
   * The running profile's root directory, substituted for `{profileDir}` in
   * declared paths. Wired by the profile producer; omitted manifests simply
   * never use the placeholder.
   */
  profileDir?: string | undefined
  fetchImpl?: FetchLike | undefined
  /** Runs one shell step (the service wires this to `ctx.subprocess`). */
  runStep: (step: HeavyStep) => Promise<StepOutcome>
}

/** One shell step's result. */
export interface StepOutcome {
  exitCode: number | null
  output: string
}

/** Which source may fill a route's served catalog when its models list is empty. */
export type HeavyCatalogAuthority = 'catalog' | 'endpoint'

/** One route profile written to `llm-pi-ai.providers.<id>`. */
export interface HeavyRouteProfile {
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv?: string
  keyless?: boolean
  /** Provider-native credential pool declared by a custom-protocol manifest. */
  pool?: HeavyManifestPool
  /** llm-pi-ai wire-compatibility switches the manifest declares. */
  compat?: Readonly<Record<string, boolean>>
  /** Request header carrying the stable session id for routing affinity. */
  sessionHeader?: string
  /**
   * `endpoint` makes the endpoint's listing the whole catalog authority: the
   * installed catalog never refills an empty list. Omitted keeps the default
   * catalog-first resolution.
   */
  catalogAuthority?: HeavyCatalogAuthority
  models: Array<{
    id: string
    name?: string
    contextWindow?: number
    /** Maximum input (prompt-side) tokens distinct from the combined window. */
    maxInputTokens?: number
    maxTokens?: number
    input?: readonly string[]
    /**
     * Whether the source stated tool-call support; absent means undisclosed.
     * Written only to an llm-pi-ai route, whose profile schema owns the field.
     */
    tools?: boolean
    /**
     * Whether the source stated reasoning support; absent means undisclosed.
     * Written only to an llm-pi-ai route, whose profile schema owns the field.
     */
    reasoning?: boolean
    /** Selectable reasoning levels, so the Effort control exists from the add. */
    reasoningEfforts?: Readonly<Record<string, string>> | false
  }>
}

/**
 * A character that would change shell parsing if a legacy placeholder value
 * were interpolated into a command. Backslash and space stay allowed for
 * Windows paths; the characters that can start a new command, expand a
 * variable, or break out of a quote do not.
 */
const UNSAFE_PLACEHOLDER_CHAR = /[\u0000\n\r`$"';|&<>()*?\[\]{}!#~]/

/**
 * Substitute the runner placeholders in one declared string. This is the
 * legacy path for manifests that still embed `{home}`/`{config}`/`{dshHome}`/
 * `{profileDir}`; built-in steps that touch the vulnerable paths use the
 * `DSH_HEAVY_*` environment variables instead.
 * @param value - the declared command or cwd.
 * @param home - the user home (`{home}`; `{config}` is its `.config`).
 * @param dshHome - the DSH home (`{dshHome}`); defaults to the standard
 *   `<home>/.dsh` when omitted.
 * @param profileDir - the running profile root (`{profileDir}`), when the
 *   profile producer resolved one. The placeholder is left untouched when it
 *   is unknown rather than guessing a `profiles/web` layout.
 * @returns the string with every placeholder expanded.
 */
export function substitute(value: string, home: string, dshHome?: string, profileDir?: string): string {
  const expand = (source: string, token: string, replacement: string): string => {
    if (!source.includes(token)) return source
    if (UNSAFE_PLACEHOLDER_CHAR.test(replacement)) {
      throw new Error(
        `Cannot expand ${token}: the host path contains a shell metacharacter,`
        + ' so interpolating it into a command would change what the shell executes.'
        + ' Commands that need a host path must read it from the runner environment instead.',
      )
    }
    return source.replaceAll(token, replacement)
  }
  let expanded = expand(value, '{home}', home)
  expanded = expand(expanded, '{config}', join(home, '.config'))
  expanded = expand(expanded, '{dshHome}', dshHome ?? join(home, '.dsh'))
  return profileDir === undefined ? expanded : expand(expanded, '{profileDir}', profileDir)
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

/**
 * Whether one health probe proves something is listening. HTTP 401/403 mean
 * the endpoint answered and only the credential is missing, so detection and
 * status share this predicate; model discovery then decides whether the add's
 * key/route actually works. A transport error or timeout carries no status and
 * stays unreachable.
 * @param health - a health probe result.
 * @returns whether the endpoint answered.
 */
export function reachable(health: { ok: boolean; status?: number; error?: string }): boolean {
  return health.ok || health.status === 401 || health.status === 403
}

/** The detection outcome for one manifest. */
export interface InstanceDetection {
  /** Whether a candidate answered; an auth challenge counts (see {@link reachable}). */
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
 * @returns the first reachable instance (including an auth challenge), or the
 *   first failure.
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
      ok: reachable(health),
      baseURL: candidate.baseURL,
      ...candidate.port === undefined ? {} : { port: candidate.port },
      url: candidate.url,
      health,
    }
    if (reachable(health)) return detection
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
  context: { home: string; dshHome: string; profileDir?: string | undefined; helperPath?: string | undefined } | undefined,
): string | undefined {
  if (context === undefined) return undefined
  for (const requirement of requirements ?? []) {
    // `{helper}` is the plugin-relative helper path. Without it the check
    // cannot prove the file missing, so it never blocks on an absent seam.
    const withHelper = requirement.paths.map(path => {
      if (!path.includes('{helper}')) return path
      return context.helperPath === undefined ? undefined : path.replaceAll('{helper}', context.helperPath)
    })
    if (withHelper.some(path => path === undefined ? true : existsSync(substitute(path, context.home, context.dshHome, context.profileDir)))) continue
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
  requires: readonly ('docker' | 'podman' | 'systemd-user')[]
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
  context?: { home: string; dshHome: string; profileDir?: string | undefined; helperPath?: string | undefined },
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
      // install the package and then die at the unit step. The requirement is
      // declared by the variant (`requires: ['systemd-user']`), so a helper
      // step that provisions the unit is covered even when the command text
      // never spells `systemctl --user`; the legacy command scan stays for
      // variants that predate the field. The install path is reported
      // unavailable with the real missing requirement instead.
      const needsSystemdUser = platformInstallVariant(manifest.local, platform).requires?.includes('systemd-user') === true
        || resolved.steps.some(step => step.command.includes('systemctl --user'))
      if (needsSystemdUser && !runtime.systemdUser) {
        return {
          path: 'unsupported',
          label: resolved.label,
          ...base,
          requires: ['systemd-user'],
          missing: ['A reachable systemd user session (`systemctl --user`)'],
        }
      }
      return { path: 'node', label: resolved.label, ...base, requires: [], missing: [] }
    }
  }
}

/** One operator-owned override from `$DSH_HOME/heavy-server-overlay.json`. */
export interface ServerOverlayEntry {
  /** Remove the provider from every host reply; its status/reuse/install calls are refused. */
  disabled?: boolean
  label?: string
  summary?: string
  /** Replacement dashboard link; null removes the shipped one. */
  dashboardUrl?: string | null
  /** Replacement docs link; null removes the shipped one. */
  docsUrl?: string | null
  reuseBaseURL?: string
  reuseHealthURL?: string
  /** Replacement local install steps for every supported platform variant. */
  installSteps?: readonly HeavyStep[]
  /** Replacement fallback model; null removes the shipped one. */
  fallbackModel?: string | null
  /** Replacement credential pool; null removes the shipped one. */
  pool?: HeavyManifestPool | null
  /** Replacement release source (`https://` releases API or `owner/repo`). */
  releaseSource?: string
}

/** Whether a wire value is a plain JSON object. */
function isOverlayRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string overlay field, or undefined when absent/blank/mistyped. */
function overlayString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** An optional string overlay field: null (or empty) removes, a string sets. */
function overlayNullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return value === '' ? null : value
}

/** Sanitize an install-step list; a malformed list is ignored whole. */
function overlaySteps(value: unknown): readonly HeavyStep[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const steps: HeavyStep[] = []
  for (const raw of value) {
    if (!isOverlayRecord(raw)) return undefined
    const label = overlayString(raw, 'label')
    const command = overlayString(raw, 'command')
    if (label === undefined || command === undefined) return undefined
    const cwd = overlayString(raw, 'cwd')
    // A malformed weight only drops the progress weight; the step still runs.
    const weight = typeof raw.weight === 'number' && Number.isFinite(raw.weight) && raw.weight > 0 ? raw.weight : undefined
    steps.push({
      label,
      command,
      ...cwd === undefined ? {} : { cwd },
      ...raw.optional === true ? { optional: true } : {},
      ...weight === undefined ? {} : { weight },
    })
  }
  return steps
}

/** Sanitize a pool override: null removes, a valid pool replaces, anything else is ignored. */
function overlayPool(value: unknown): HeavyManifestPool | null | undefined {
  if (value === null) return null
  if (!isOverlayRecord(value)) return undefined
  const strategy = value.strategy
  if (strategy !== undefined && strategy !== 'priority-sticky' && strategy !== 'balanced') return undefined
  if (!Array.isArray(value.identities) || value.identities.length === 0) return undefined
  const identities: HeavyManifestPool['identities'][number][] = []
  const seen = new Set<string>()
  for (const raw of value.identities) {
    if (!isOverlayRecord(raw)) return undefined
    const id = overlayString(raw, 'id')
    const credentialRef = overlayString(raw, 'credentialRef')
    if (id === undefined || credentialRef === undefined || !/^[A-Z_][A-Z0-9_]*$/.test(credentialRef) || seen.has(id)) {
      return undefined
    }
    seen.add(id)
    const priority = raw.priority
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0)) {
      return undefined
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return undefined
    identities.push({
      id,
      credentialRef,
      ...typeof priority === 'number' ? { priority } : {},
      ...typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {},
    })
  }
  return { ...strategy === undefined ? {} : { strategy }, identities }
}

/** Sanitize one overlay entry; undefined when it carries no usable override. */
function sanitizeOverlayEntry(raw: unknown): ServerOverlayEntry | undefined {
  if (!isOverlayRecord(raw)) return undefined
  const entry: ServerOverlayEntry = {}
  if (raw.disabled === true) entry.disabled = true
  const label = overlayString(raw, 'label')
  if (label !== undefined) entry.label = label
  const summary = overlayString(raw, 'summary')
  if (summary !== undefined) entry.summary = summary
  const dashboardUrl = overlayNullableString(raw, 'dashboardUrl')
  if (dashboardUrl !== undefined) entry.dashboardUrl = dashboardUrl
  const docsUrl = overlayNullableString(raw, 'docsUrl')
  if (docsUrl !== undefined) entry.docsUrl = docsUrl
  const reuseBaseURL = overlayString(raw, 'reuseBaseURL')
  if (reuseBaseURL !== undefined) entry.reuseBaseURL = reuseBaseURL
  const reuseHealthURL = overlayString(raw, 'reuseHealthURL')
  if (reuseHealthURL !== undefined) entry.reuseHealthURL = reuseHealthURL
  const installSteps = overlaySteps(raw.installSteps)
  if (installSteps !== undefined) entry.installSteps = installSteps
  const fallbackModel = overlayNullableString(raw, 'fallbackModel')
  if (fallbackModel !== undefined) entry.fallbackModel = fallbackModel
  const pool = overlayPool(raw.pool)
  if (pool !== undefined) entry.pool = pool
  const releaseSource = overlayString(raw, 'releaseSource')
  if (releaseSource !== undefined && parseReleaseSource(releaseSource) !== undefined) entry.releaseSource = releaseSource
  return Object.keys(entry).length === 0 ? undefined : entry
}

/**
 * Read the private deployment overlay. The file is operator-owned data, never
 * shipped; an absent or malformed file means "no override" (fail-soft), and a
 * malformed field is dropped rather than reaching execution.
 * @param dshHome - the DSH home directory.
 * @returns provider id → sanitized override entry.
 */
export function readServerOverlay(dshHome: string): Record<string, ServerOverlayEntry> {
  try {
    const document: unknown = JSON.parse(readFileSync(join(dshHome, 'heavy-server-overlay.json'), 'utf8'))
    if (!isOverlayRecord(document) || !isOverlayRecord(document.providers)) return {}
    const overlay: Record<string, ServerOverlayEntry> = {}
    for (const [id, raw] of Object.entries(document.providers)) {
      const entry = sanitizeOverlayEntry(raw)
      if (id !== '' && entry !== undefined) overlay[id] = entry
    }
    return overlay
  } catch {
    return {}
  }
}

/** Replace the steps of every supported platform variant, keeping refusals. */
function replaceInstallSteps(
  local: HeavyProviderManifest['local'],
  steps: readonly HeavyStep[],
): HeavyProviderManifest['local'] {
  const install = { ...local.install }
  for (const platform of ['default', 'linux', 'darwin', 'win32'] as const) {
    const variant = install[platform]
    if (variant === undefined || variant.unsupported !== undefined) continue
    install[platform] = { ...variant, steps }
  }
  return { ...local, install }
}

/** Apply one overlay entry; the shipped table is returned untouched without one. */
export function overlayManifest(
  manifest: HeavyProviderManifest,
  entry: ServerOverlayEntry | undefined,
): HeavyProviderManifest {
  if (entry === undefined) return manifest
  const next: HeavyProviderManifest = {
    ...manifest,
    ...entry.label === undefined ? {} : { label: entry.label },
    ...entry.summary === undefined ? {} : { summary: entry.summary },
    reuse: {
      ...manifest.reuse,
      ...entry.reuseBaseURL === undefined ? {} : { baseURL: entry.reuseBaseURL },
      ...entry.reuseHealthURL === undefined ? {} : { health: { ...manifest.reuse.health, url: entry.reuseHealthURL } },
    },
    local: entry.installSteps === undefined ? manifest.local : replaceInstallSteps(manifest.local, entry.installSteps),
  }
  if (entry.dashboardUrl === null) delete next.dashboardUrl
  else if (entry.dashboardUrl !== undefined) next.dashboardUrl = entry.dashboardUrl
  if (entry.docsUrl === null) delete next.docsUrl
  else if (entry.docsUrl !== undefined) next.docsUrl = entry.docsUrl
  if (entry.fallbackModel === null) delete next.fallbackModel
  else if (entry.fallbackModel !== undefined) next.fallbackModel = entry.fallbackModel
  if (entry.pool === null) delete next.pool
  else if (entry.pool !== undefined) next.pool = entry.pool
  if (entry.releaseSource !== undefined) next.releaseSource = entry.releaseSource
  return next
}

/**
 * The host table with the overlay applied: disabled providers are dropped and
 * every other entry keeps its order with its overrides merged.
 * @param manifests - the shipped host table.
 * @param overlay - the sanitized operator overlay.
 * @returns the effective table the host replies with and executes.
 */
export function effectiveHeavyManifests(
  manifests: readonly HeavyProviderManifest[],
  overlay: Record<string, ServerOverlayEntry>,
): HeavyProviderManifest[] {
  const effective: HeavyProviderManifest[] = []
  for (const manifest of manifests) {
    const entry = overlay[manifest.id]
    if (entry?.disabled === true) continue
    effective.push(overlayManifest(manifest, entry))
  }
  return effective
}

/**
 * Page-global key carrying the operator overlay to the browser. The client
 * package names the same literal
 * (`packages/client/ui-settings-models/src/heavy-overlay.ts`); the browser
 * half sanitizes the document again and applies it to the compiled fallback,
 * so the pre-connection table honors the overlay before the first
 * `enpoiHeavy.manifests` reply.
 */
export const HEAVY_OVERLAY_GLOBAL = '__DSH_HEAVY_OVERLAY__'

/** One `webserver/index-inject` row publishing the overlay to the page. */
export interface HeavyOverlayInjectionRow {
  kind: 'global'
  name: string
  value: { providers: Record<string, ServerOverlayEntry> }
}

/**
 * Build the page-bootstrap row for the operator overlay, when the file
 * overrides at least one provider.
 * @param dshHome - the DSH home directory.
 * @returns the injection row, or undefined when there is no overlay.
 */
export function overlayInjectionRow(dshHome: string): HeavyOverlayInjectionRow | undefined {
  const providers = readServerOverlay(dshHome)
  if (Object.keys(providers).length === 0) return undefined
  return { kind: 'global', name: HEAVY_OVERLAY_GLOBAL, value: { providers } }
}

/**
 * The catalog authority a manifest declares, when any. The field is data the
 * manifest table owns; a manifest without it keeps llm-pi-ai's catalog-first
 * behavior.
 * @param manifest - heavy manifest, optionally carrying the authority field.
 * @returns the declared authority, or undefined when the manifest stays silent.
 */
export function catalogAuthorityOf(manifest: HeavyProviderManifest): HeavyCatalogAuthority | undefined {
  return manifest.catalogAuthority
}

/**
 * Build the route profile for one mode. Auth follows the manifest: `none`
 * writes `keyless`, `unified` writes the reference whose credential value
 * `commitRoute` stages, and a manifest-declared `pool` is written as the
 * route's provider-native pool (identities only — secrets stay in the
 * credentials store). An llm-pi-ai route never declares a pool: these services
 * front their own credential handling (a gateway key, or no client auth at
 * all).
 *
 * The manifest's `compat` switches are written at the route, and each model
 * carries the capacities, input modalities, and reasoning ladder its listing
 * disclosed, so a route created here — by Add or by an install — offers the
 * same effort and modality controls a later Models-page refresh would. An
 * explicit `reasoningEfforts: false` is preserved; an empty ladder is omitted
 * because the route schema refuses a declared-but-empty capability.
 *
 * A service route with `catalogAuthority: 'endpoint'` (declared by the
 * manifest or passed as an override) writes that authority and never fills an
 * empty discovery with `fallbackModel`: the endpoint's valid empty listing is
 * a real empty catalog. Every other route writes the manifest fallback only
 * when the caller reports a valid empty listing (`catalogState: 'empty'`);
 * a failed or unauthorized discovery writes no model, and a caller that does
 * not report the listing outcome gets no invented id either. The fallback
 * entry's name labels it as a fallback so it can never be mistaken for an
 * advertised model.
 *
 * Auth is computed from the effective key, not only the manifest default: an
 * anonymous `unified` route writes `keyless` and no `apiKeyEnv`; as soon as an
 * explicit or stored key exists the route is keyed and names the manifest's
 * reference. `auth.kind: 'none'` is always anonymous.
 * @param manifest - heavy manifest.
 * @param mode - detected instance or local install.
 * @param models - discovered models; the fallback model fills an empty list
 *   only for a valid empty listing on a non-endpoint-authority route.
 * @param overrides - detected address, catalog authority, listing state, or
 *   the effective keyless verdict written instead of the declared defaults.
 * @returns the route profile written to settings.
 */
export function routeProfile(
  manifest: HeavyProviderManifest,
  mode: 'reuse' | 'local',
  models: ReadonlyArray<DiscoveredModel>,
  overrides: {
    baseURL?: string
    catalogAuthority?: HeavyCatalogAuthority
    keyless?: boolean
    /** The listing outcome that produced `models`; omission is an unknown state, never "empty". */
    catalogState?: ModelListingState
  } = {},
): HeavyRouteProfile {
  const authority = overrides.catalogAuthority ?? catalogAuthorityOf(manifest)
  const anonymous = manifest.auth.kind === 'none' ? true : overrides.keyless ?? manifest.auth.keyless
  const carriesKey = !anonymous && manifest.auth.apiKeyEnv !== undefined
  // A manifest that normally serves anonymous requests still records the
  // explicit keyed verdict when an operator key exists; a manifest that was
  // always keyed keeps its existing profile spelling (an absent `keyless`).
  const explicitKeyless = manifest.auth.kind === 'unified' && !anonymous && manifest.auth.keyless
  // llm-pi-ai's route model schema owns `tools`/`reasoning`; a custom-protocol
  // namespace (commandcode) must not receive fields its own schema cannot
  // parse. The disclosure is still true in the discovery result either way.
  const piAiRoute = routeSettingsNs(manifest) === LLM_NS
  const list = models.length > 0
    ? models.map((model): HeavyRouteProfile['models'][number] => ({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        ...model.input === undefined || model.input.length === 0 ? {} : { input: [...model.input] },
        ...!piAiRoute || model.tools === undefined ? {} : { tools: model.tools },
        ...!piAiRoute || model.reasoning === undefined ? {} : { reasoning: model.reasoning },
        // An empty ladder states nothing and the route schema refuses it as a
        // declared-but-empty capability, so it is omitted like an absent one.
        // An explicit false is a declared answer and stays.
        ...model.reasoningEfforts === undefined
          ? {}
          : model.reasoningEfforts === false
            ? { reasoningEfforts: false }
            : Object.keys(model.reasoningEfforts).length === 0
              ? {}
              : { reasoningEfforts: { ...model.reasoningEfforts } },
      }))
    : authority === 'endpoint'
      || manifest.fallbackModel === undefined
      || overrides.catalogState !== 'empty'
      ? []
      : [{ id: manifest.fallbackModel, name: `${manifest.fallbackModel} (fallback)` }]
  // A direct route never runs a local service, so its name must not carry the
  // setup path's "(local)" suffix even though the setup flow provisioned it.
  const suffix = manifest.delivery === 'direct' ? ' (direct)' : mode === 'local' ? ' (local)' : ' (detected)'
  return {
    displayName: `${manifest.label}${suffix}`,
    api: manifest.protocol,
    baseURL: overrides.baseURL ?? modeBaseURL(manifest, mode),
    ...carriesKey ? { apiKeyEnv: manifest.auth.apiKeyEnv } : {},
    ...(anonymous || explicitKeyless ? { keyless: anonymous } : {}),
    ...manifest.compat === undefined ? {} : { compat: { ...manifest.compat } },
    ...manifest.sessionHeader === undefined ? {} : { sessionHeader: manifest.sessionHeader },
    ...authority === 'endpoint' ? { catalogAuthority: 'endpoint' as const } : {},
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

/** One discovered model, before any enrichment. */
export interface DiscoveredModel {
  id: string
  name?: string
  /** Maximum combined request and response context the source disclosed. */
  contextWindow?: number
  /** Maximum input (prompt-side) tokens the source disclosed separately. */
  maxInputTokens?: number
  /** Maximum output tokens the source disclosed. */
  maxTokens?: number
  /** Accepted input modalities the source disclosed. */
  input?: readonly string[]
  /** Whether the source stated tool-call support; absent means undisclosed. */
  tools?: boolean
  /** Whether the source stated reasoning support; absent means undisclosed. */
  reasoning?: boolean
  /** Selectable reasoning levels (picker id → wire value), or `false` to disable reasoning. */
  reasoningEfforts?: Readonly<Record<string, string>> | false
}

/** Stable API version required by Anthropic's native model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Wall-clock budget for one model-listing interrogation. */
export const MODEL_LISTING_TIMEOUT_MS = 15_000

/** Largest model-listing reply accepted, in bytes. */
export const MODEL_LISTING_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** The answer one endpoint's model listing gave. */
export type ModelListingState = 'fresh' | 'empty' | 'unauthorized' | 'failed'

/** Typed outcome of one `/models` interrogation; a valid empty is not a failure. */
export interface ModelListingOutcome {
  /** `fresh` has models, `empty` is a valid empty listing, the others are failures. */
  state: ModelListingState
  models: DiscoveredModel[]
  /** HTTP status when a reply arrived. */
  status?: number
  /** Sanitized diagnostic; never carries a key or endpoint URL. */
  error?: string
}

/** Where a service route's models came from. */
export type ModelCatalogSource = 'endpoint' | 'namespace'

/** Typed service-route discovery result, including its source. */
export interface ServiceCatalogOutcome extends ModelListingOutcome {
  source: ModelCatalogSource
}

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
 * Human names the raw listing carries in `description` (some gateways publish
 * the label there instead of `name`). The shared reader deliberately does not
 * turn free prose into a label; this map lets the planner accept a
 * description only when it is a plausibly short name and no declared name
 * exists.
 */
function listingDescriptionNames(body: unknown): Map<string, string> {
  const names = new Map<string, string>()
  const rows: Array<{ key?: string; raw: unknown }> = []
  if (Array.isArray(body)) {
    for (const raw of body) rows.push({ raw })
  } else if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const listing = body as { data?: unknown; models?: unknown }
    if (Array.isArray(listing.data)) {
      for (const raw of listing.data) rows.push({ raw })
    } else if (Array.isArray(listing.models)) {
      for (const raw of listing.models) rows.push({ raw })
    } else if (listing.models !== null && typeof listing.models === 'object') {
      for (const [key, raw] of Object.entries(listing.models)) rows.push({ key, raw })
    }
  }
  for (const { key, raw } of rows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as ListingEntry
    const id = listingText(key, entry.id, entry.slug)
    if (id === undefined) continue
    const name = listingText(entry.name, entry.displayName, entry.display_name, entry.description)
    if (name === undefined || name === id || names.has(id)) continue
    names.set(id, name)
  }
  return names
}

/** Convert one shared listing row into the planner's route-facing model. */
function discoveredFromListing(model: ListingModel, descriptionName?: string): DiscoveredModel {
  const name = model.name ?? descriptionName
  return {
    id: model.id,
    ...name === undefined || name === model.id ? {} : { name },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.inputModalities === undefined || model.inputModalities.length === 0
      ? {}
      : { input: [...model.inputModalities] },
    ...model.tools === undefined ? {} : { tools: model.tools },
    ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
    ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: { ...model.reasoningEfforts } },
  }
}

/** Convert one route-namespace discovery row into the planner's model. */
function discoveredFromEntry(model: ModelDiscoveryEntry): DiscoveredModel | undefined {
  if (model.id === '') return undefined
  const input = (model.inputModalities ?? []).filter(modality => typeof modality === 'string' && modality !== '')
  return {
    id: model.id,
    ...model.name === undefined || model.name === model.id ? {} : { name: model.name },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...input.length === 0 ? {} : { input },
    ...model.tools === undefined ? {} : { tools: model.tools },
    ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
    ...model.reasoningEfforts === undefined
      ? {}
      : model.reasoningEfforts === false
        ? { reasoningEfforts: false }
        : { reasoningEfforts: { ...model.reasoningEfforts } },
  }
}

/** A diagnostic safe for logs and RPC replies: no key, no endpoint URL. */
function sanitizedDiscoveryError(error: unknown, apiKey?: string): string {
  const raw = error instanceof Error
    ? error.name === 'TimeoutError' ? 'listing request timed out' : error.message
    : String(error)
  const redacted = apiKey === undefined || apiKey === '' ? raw : raw.split(apiKey).join('[redacted]')
  return redacted.replace(/https?:\/\/\S+/gu, '[endpoint]').slice(0, 300)
}

/** A bounded body read: the text, or the single oversized/empty-failure reason. */
type BoundedListingBody =
  | { ok: true; text: string }
  | { ok: false; error: string }

/**
 * Read a listing reply without trusting it to be small. A declared
 * `content-length` is checked before transferring anything; a streamed body
 * is accumulated against the byte ceiling, and a minimal fetch fake without a
 * body falls back to `text()` with the same post-read check.
 */
async function readBoundedListingBody(response: Awaited<ReturnType<FetchLike>>): Promise<BoundedListingBody> {
  const oversized = `listing response exceeds ${String(MODEL_LISTING_MAX_RESPONSE_BYTES)} bytes`
  const declared = Number(response.headers?.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MODEL_LISTING_MAX_RESPONSE_BYTES) {
    return { ok: false, error: oversized }
  }
  const body = response.body
  if (body === undefined || body === null) {
    const text = await response.text()
    return Buffer.byteLength(text, 'utf8') > MODEL_LISTING_MAX_RESPONSE_BYTES
      ? { ok: false, error: oversized }
      : { ok: true, text }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > MODEL_LISTING_MAX_RESPONSE_BYTES) {
      if (reader.cancel !== undefined) {
        await reader.cancel().catch(() => {
          // Cancelling an oversized read is best-effort cleanup; the refusal
          // is already decided.
        })
      }
      return { ok: false, error: oversized }
    }
    chunks.push(value)
  }
  if (reader.cancel !== undefined) {
    await reader.cancel().catch(() => {
      // A drained reader's cancel cannot change the completed reply.
    })
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(bytes) }
}

/**
 * Interrogate one route's native listing address and keep the outcome typed.
 * A recognized empty container is `empty` (a real answer), a body with no
 * listing container is `failed`, and 401/403 is `unauthorized`; none of the
 * latter two is a valid empty listing. The reply is read through the shared
 * listing parser and bounded by declared length and actual UTF-8 bytes; a
 * diagnostic never includes the key or the endpoint URL.
 * @param baseURL - the configured endpoint base.
 * @param apiKey - the credential to present, when any.
 * @param fetchImpl - fetch seam (tests inject one).
 * @param api - the route's wire protocol; Anthropic routes select the native
 *   listing address and credential header.
 * @returns the typed listing outcome in endpoint order.
 */
export async function discoverModelListing(
  baseURL: string,
  apiKey: string | undefined,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  api?: string,
): Promise<ModelListingOutcome> {
  const url = modelListingUrl(baseURL, api)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (apiKey !== undefined && apiKey.length > 0) headers['x-api-key'] = apiKey
  } else if (apiKey !== undefined && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`
  }
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(MODEL_LISTING_TIMEOUT_MS) })
    const status = response.status
    if (!response.ok) {
      return {
        state: status === 401 || status === 403 ? 'unauthorized' : 'failed',
        models: [],
        status,
        error: `HTTP ${String(status)}`,
      }
    }
    const bounded = await readBoundedListingBody(response)
    if (!bounded.ok) return { state: 'failed', models: [], status, error: bounded.error }
    let body: unknown
    try {
      body = JSON.parse(bounded.text)
    } catch {
      return { state: 'failed', models: [], status, error: 'listing response is not JSON' }
    }
    const parsed = readModelListing(body)
    if (!parsed.ok) {
      return { state: 'failed', models: [], status, error: 'listing response is not a model listing' }
    }
    const names = listingDescriptionNames(body)
    const seen = new Set<string>()
    const models: DiscoveredModel[] = []
    for (const model of parsed.models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push(discoveredFromListing(model, names.get(model.id)))
    }
    return { state: models.length === 0 ? 'empty' : 'fresh', models, status }
  } catch (error) {
    return { state: 'failed', models: [], error: sanitizedDiscoveryError(error, apiKey) }
  }
}

/**
 * The array-only compatibility wrapper over {@link discoverModelListing}.
 * Callers that need the distinction between a valid empty listing, an
 * unauthorized reply, and a failed interrogation use the typed function.
 * @param baseURL - the configured endpoint base.
 * @param apiKey - the credential to present, when any.
 * @param fetchImpl - fetch seam (tests inject one).
 * @param api - the route's wire protocol.
 * @returns the disclosed models, or `[]` for an empty or failed listing.
 */
export async function discoverModels(
  baseURL: string,
  apiKey: string | undefined,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  api?: string,
): Promise<DiscoveredModel[]> {
  return (await discoverModelListing(baseURL, apiKey, fetchImpl, api)).models
}

/** One route-namespace discovery result before it reaches the service layer. */
interface NamespaceDiscoveryOutcome {
  state: 'fresh' | 'empty' | 'failed'
  models: DiscoveredModel[]
  error?: string
}

/**
 * Ask the route namespace's registered model discovery. The seam answers an
 * array, so an empty array is the namespace's own `empty` answer and a throw
 * is `failed`; an unmounted namespace is a failure, never a fabricated empty.
 */
async function discoverNamespaceModels(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  baseURL: string,
  apiKey?: string,
): Promise<NamespaceDiscoveryOutcome> {
  const llm = deps.llm
  if (llm === undefined) return { state: 'failed', models: [], error: 'no model discovery is registered' }
  try {
    const found = await llm.discoverModels(routeSettingsNs(manifest), {
      provider: manifest.id,
      baseURL,
      api: manifest.protocol,
      ...apiKey === undefined || apiKey.length === 0 ? {} : { apiKey },
    })
    const models: DiscoveredModel[] = []
    for (const entry of found) {
      const model = discoveredFromEntry(entry)
      if (model !== undefined) models.push(model)
    }
    return { state: models.length === 0 ? 'empty' : 'fresh', models }
  } catch (error) {
    return { state: 'failed', models: [], error: sanitizedDiscoveryError(error, apiKey) }
  }
}

/**
 * Ask the route namespace's registered model discovery for the endpoint's
 * models. This stays the array compatibility wrapper; use
 * {@link discoverServiceCatalog} when the empty/unauthorized/failed distinction
 * matters.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param baseURL - endpoint the written route points at.
 * @param apiKey - one-shot credential the add carries, when any.
 * @returns discovered models with the capacities and modalities disclosed.
 */
export async function discoverRouteModels(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  baseURL: string,
  apiKey?: string,
): Promise<DiscoveredModel[]> {
  return (await discoverNamespaceModels(deps, manifest, baseURL, apiKey)).models
}

/** Read one stored credential reference, treating an absent/blank/unreadable value as no key. */
async function resolveStoredCredential(deps: HeavyDeps, ref: string): Promise<string | undefined> {
  if (deps.credentials === undefined) return undefined
  try {
    const value = (await deps.credentials.resolve(ref))?.value?.trim()
    return value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * The credential one Add or install should present and commit. An explicit key
 * wins over a stored one; a `unified` route falls back to the reference's
 * stored value so a repeat Add keeps working without asking for it again.
 * `auth.kind: 'none'` never reads an ambient credential: only an explicitly
 * supplied key reaches its one-shot discovery.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param supplied - operator-supplied key, when any.
 * @returns the effective key, or undefined for an anonymous route.
 */
export async function resolveRouteKey(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  supplied?: string,
): Promise<string | undefined> {
  const explicit = supplied?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  if (manifest.auth.kind !== 'unified') return undefined
  const ref = manifest.auth.apiKeyEnv
  return ref === undefined ? undefined : resolveStoredCredential(deps, ref)
}

/**
 * Discover one route being added and preserve what the source actually said.
 *
 * A service route served by llm-pi-ai interrogates its own protocol's native
 * listing address, using the key carried by the add or the route reference's
 * stored credential. Its endpoint answer is final: a valid empty listing
 * stays empty, and invalid, unauthorized, or unreachable replies never cross
 * over to another provider's namespace discovery. A direct vendor route, or a
 * service served by its own adapter namespace, has no llm-pi-ai native
 * listing path and asks only that route namespace.
 * @param deps - host seams.
 * @param manifest - heavy manifest.
 * @param baseURL - endpoint the written route points at.
 * @param apiKey - credential the operator supplied with the add, when any.
 * @param options - `resolveStoredCredential: false` when the caller already
 *   resolved the effective key, so discovery presents exactly that value.
 * @returns the typed catalog outcome and its source.
 */
export async function discoverServiceCatalog(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  baseURL: string,
  apiKey?: string,
  options: { resolveStoredCredential?: boolean } = {},
): Promise<ServiceCatalogOutcome> {
  if (manifest.delivery === 'direct' || manifest.settingsNs !== undefined) {
    return { ...await discoverNamespaceModels(deps, manifest, baseURL, apiKey), source: 'namespace' }
  }
  let key = apiKey
  // `auth.kind: 'none'` is anonymous by contract: a low-level discovery call
  // must not reach for an ambient credential the route would never send.
  const ref = manifest.auth.kind === 'unified' ? manifest.auth.apiKeyEnv : undefined
  if (key === undefined && options.resolveStoredCredential !== false && ref !== undefined && deps.credentials !== undefined) {
    key = await resolveStoredCredential(deps, ref)
  }
  return { ...await discoverModelListing(baseURL, key, deps.fetchImpl, manifest.protocol), source: 'endpoint' }
}

/**
 * The array compatibility wrapper over {@link discoverServiceCatalog}. The
 * service outcome paths that expect a model list keep using this; new route
 * creation can use the typed catalog to distinguish a valid empty from a
 * failed discovery.
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
  return (await discoverServiceCatalog(deps, manifest, baseURL, apiKey)).models
}

/** Current settings revision for one namespace, when the seam exposes one. */
function revisionOf(settings: SettingsSeam, ns: string): number | undefined {
  return settings.describe?.().find(entry => entry.ns === ns)?.revision
}

/** One namespace value and revision from the same describe snapshot. */
function namespaceSnapshot(settings: SettingsSeam, ns: string): { value?: unknown; revision?: number } | undefined {
  const entry = settings.describe?.().find(candidate => candidate.ns === ns)
  return entry === undefined ? undefined : { ...entry.revision === undefined ? {} : { revision: entry.revision }, ...entry.value === undefined ? {} : { value: entry.value } }
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
  overrides: {
    baseURL?: string
    catalogAuthority?: HeavyCatalogAuthority
    keyless?: boolean
    catalogState?: ModelListingState
    /** Revision from the same snapshot the caller checked; defaults to a fresh read. */
    expectedRevision?: number
  } = {},
): Promise<HeavyRouteProfile> {
  const settings = deps.settings
  if (settings === undefined) throw new Error('settings seam absent — cannot write the route')
  const pending = pendingRestartForManifest(deps, manifest)
  if (pending !== undefined) throw new Error(pending.message)
  const profile = routeProfile(manifest, mode, models, overrides)
  const settingsNs = routeSettingsNs(manifest)
  await settings.mutate(
    settingsNs,
    [{ op: 'set', path: ['providers', manifest.id], value: profile }],
    overrides.expectedRevision ?? revisionOf(settings, settingsNs),
  )
  return profile
}

/**
 * Store the key the operator supplied with an add. A pooled manifest stores it
 * under its first identity's reference (the Keys card slot a fresh route
 * shows); otherwise the manifest's unified auth reference is the target. No
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
 * @param models - discovered models; the fallback model fills a valid empty
 *   listing only.
 * @param key - optional unified/gateway key stored with the route.
 * @param overrides - detected address, keyless verdict, catalog authority, or
 *   listing state written instead of the declared defaults. A supplied key
 *   forces a keyed route for a unified manifest even when it normally serves
 *   anonymous requests; `auth.kind: 'none'` stays anonymous.
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
  overrides: {
    baseURL?: string
    catalogAuthority?: HeavyCatalogAuthority
    keyless?: boolean
    catalogState?: ModelListingState
    /**
     * Refuse to replace a route that appeared between the caller's duplicate
     * check and this commit. The check runs before every bounded attempt, so an
     * install finalizer cannot overwrite a route written while its job ran.
     */
    refuseExisting?: boolean
  } = {},
): Promise<{ route: HeavyRouteProfile; credentialStored: boolean }> {
  if (deps.settings === undefined) throw new Error('settings seam absent — cannot write the route')
  const pending = pendingRestartForManifest(deps, manifest)
  if (pending !== undefined) throw new Error(pending.message)
  const credentials = deps.credentials
  const ref = manifest.pool?.identities[0]?.credentialRef ?? manifest.auth.apiKeyEnv
  const value = key?.trim() ?? ''
  const store = value !== '' && ref !== undefined
  const keyless = manifest.auth.kind === 'none' ? true : store ? false : overrides.keyless
  let previous: { value?: string } | undefined
  if (store) {
    if (credentials === undefined) throw new Error('credentials seam absent — cannot store the key')
    previous = await credentials.resolve(ref)
    await credentials.set(ref, value)
  }
  const writeOverrides = {
    ...overrides.baseURL === undefined ? {} : { baseURL: overrides.baseURL },
    ...overrides.catalogAuthority === undefined ? {} : { catalogAuthority: overrides.catalogAuthority },
    ...overrides.catalogState === undefined ? {} : { catalogState: overrides.catalogState },
    ...keyless === undefined ? {} : { keyless },
  }
  let route: HeavyRouteProfile | undefined
  try {
    // A concurrent settings writer moves the namespace revision between the
    // read and the mutate; the same bounded re-read + replan provider-sync and
    // removal use makes the route commit survive it instead of leaving an
    // installed service with no route after a single SETTINGS_CONFLICT.
    const settingsNs = routeSettingsNs(manifest)
    for (let attempt = 0; attempt < MAX_SETTINGS_WRITE_ATTEMPTS; attempt += 1) {
      let expectedRevision: number | undefined
      if (overrides.refuseExisting === true) {
        // Value and revision come from one describe snapshot: a route written
        // after this point moves the revision, so the mutate conflicts and the
        // retry re-checks instead of overwriting the fresh row.
        const snapshot = namespaceSnapshot(deps.settings, settingsNs)
        const section = isPlainRecord(snapshot?.value) ? snapshot.value : undefined
        const providers = isPlainRecord(section?.providers) ? section.providers : undefined
        if (providers !== undefined && Object.hasOwn(providers, manifest.id)) {
          throw new Error(
            `provider "${manifest.id}" received a route while the install was running;`
            + ' the install refused to overwrite it (remove or retry deliberately)',
          )
        }
        expectedRevision = snapshot?.revision
      }
      try {
        route = await writeRoute(deps, manifest, mode, models, {
          ...writeOverrides,
          ...expectedRevision === undefined ? {} : { expectedRevision },
        })
        break
      } catch (error) {
        if (isSettingsConflict(error) && attempt < MAX_SETTINGS_WRITE_ATTEMPTS - 1) continue
        throw error
      }
    }
    if (route === undefined) throw new Error('route commit exhausted its settings attempts')
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
  /** `reachable` includes an auth challenge; `ok` requires 2xx. */
  health: { ok: boolean; status?: number; error?: string; checkedAt: number; reachable: boolean }
  models: DiscoveredModel[]
  /** The typed catalog answer the route was written from. */
  catalog: ServiceCatalogOutcome
  credentialStored: boolean
  /** The answering loopback (or overlay) port, when the detection found one. */
  port?: number
  /** The address the route was written with. */
  endpoint: string
}

/**
 * The zero-install add: detect a running instance (configured port, declared
 * endpoint, then the default port), discover its models, write the route at
 * the detected address, then store the key when one was supplied. Detection
 * accepts an HTTP 401/403 answer as a reachable instance (`reachable`), so an
 * instance whose health endpoint requires auth is offered instead of reported
 * missing; model discovery then decides whether the add's credential works.
 * The probe normally never blocks the add — its verdict is reported for the
 * UI's health badge — but an implicit add refuses when no candidate answered:
 * writing a loopback route for a listener that is not running creates a dead
 * endpoint. A reachable instance whose listing refuses with 401/403 and whose
 * route would be anonymous stops with the credential action instead of
 * persisting a route that cannot authenticate. A typed custom address is the
 * operator's explicit choice and stays saveable even when its probe is down;
 * its typed catalog carries the honest failure.
 * A `delivery: 'direct'` manifest skips detection
 * and probes the declared vendor endpoint for the health badge; its models
 * come from the route namespace's registered discovery (the bundled catalog,
 * no network call) instead of a `{baseURL}/models` listing.
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
  if (!direct && customBase === undefined && detection?.ok !== true) {
    throw new Error(`no running ${manifest.label} instance was detected — start it, install it locally, or enter a custom instance address`)
  }
  const endpoint = direct
    ? manifest.reuse.baseURL
    : customBase ?? (detection!.ok ? detection!.baseURL : manifest.reuse.baseURL)
  // Resolve the credential once: discovery and the route must agree about
  // whether this add is anonymous, and a stored key must reach the listing
  // even when the operator typed none.
  let effectiveKey = await resolveRouteKey(deps, manifest, key)
  // A harness-owned local install seeds its own key. Route-only removal keeps
  // that credential, but a store reset (or a route deleted before this fix)
  // can leave it unreadable through the ambient reference; the verified
  // lifecycle lets the host read the installer's key again instead of failing
  // the no-key 401 guard. Recovered only when the operator supplied nothing.
  let recoveredKey: string | undefined
  const operatorKey = key?.trim() ?? ''
  if (effectiveKey === undefined && operatorKey === '' && ownsLocalInstall(lifecycleOf(deps.dshHome, manifest.id))) {
    const readable = (await deps.readInstallCredential?.(manifest.id))?.trim()
    if (readable !== undefined && readable !== '') {
      effectiveKey = readable
      recoveredKey = readable
    }
  }
  // A direct vendor route has no native listing and asks its namespace. A
  // service route's native listing is the sole source, so an empty or failed
  // answer never becomes another provider's catalog.
  const catalog = await discoverServiceCatalog(deps, manifest, endpoint, effectiveKey, { resolveStoredCredential: false })
  const models = catalog.models
  const rawHealth = direct
    ? await probeHealth(manifest.reuse.health, deps.fetchImpl)
    : typedOrigin !== undefined
      ? await probeHealth(healthForBase(manifest, typedOrigin), deps.fetchImpl)
      : detection!.health
  const health = { ...rawHealth, reachable: reachable(rawHealth) }
  // A reachable endpoint that refuses the listing with 401/403 needs a
  // credential. Writing a keyless route there would create a route whose every
  // request fails anonymously, so the add stops with the credential action.
  const wouldBeAnonymous = manifest.auth.kind === 'none'
    || (effectiveKey === undefined && manifest.auth.keyless)
  if (catalog.state === 'unauthorized' && effectiveKey === undefined && wouldBeAnonymous) {
    throw new Error(
      `${manifest.label} answered at ${endpoint} but requires authorization (HTTP ${String(health.status ?? '401/403')});`
      + ' enter the instance key and retry, or check its access configuration',
    )
  }
  // Only an operator-supplied (or recovered owned) key is stored here; a
  // resolved stored key is already in the credentials seam and must not be
  // rewritten (or rolled back over a route failure). `keyless` is the
  // effective verdict, so a manifest that normally serves anonymous requests
  // becomes a keyed route as soon as a stored key exists.
  const suppliedKey = operatorKey !== '' ? operatorKey : recoveredKey
  const keyless = manifest.auth.kind === 'unified' && effectiveKey !== undefined ? false : undefined
  // A valid empty listing is the whole catalog for an endpoint-authority
  // route. Record it as the known-empty discovered cache entry before the
  // route commit: without that record the resolver reads "no evidence" and
  // refuses the route until a later sync, which is exactly a first local
  // install (no upstream accounts configured yet). A failed or unauthorized
  // listing never takes this path.
  if (catalog.state === 'empty') writeKnownEmptyDiscoveredEntry(deps, manifest.id, endpoint)
  const { route, credentialStored } = await commitRoute(deps, manifest, 'reuse', models, suppliedKey, {
    baseURL: endpoint,
    catalogState: catalog.state,
    ...keyless === undefined ? {} : { keyless },
  })
  // The route is the durable outcome; the lifecycle record is committed only
  // after it lands. A detected instance of a harness-owned local install keeps
  // its local ownership record: overwriting it with `reuse` would erase the
  // only proof that an uninstall is still available.
  const existingLifecycle = lifecycleOf(deps.dshHome, manifest.id)
  if (!ownsLocalInstall(existingLifecycle)) recordReuseLifecycle(deps.dshHome, manifest.id)
  const customPort = typedOrigin === undefined ? undefined : urlPort(typedOrigin)
  return {
    route,
    health,
    models,
    catalog,
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

/** Cache format version shared with `dsh-llm-pi-ai`'s discovered reader and provider-sync's writer. */
export const DISCOVERED_CACHE_VERSION = 1

/**
 * Write the known-empty discovered-cache record for one route: `models: []`
 * with a successful-fetch `fetchedAt`. `dsh-llm-pi-ai`'s resolver only answers
 * `knownEmpty` for an endpoint-authority route when the cache record exists
 * with a positive stamp; an absent record is "no evidence" and would make a
 * first local install (always empty before dashboard setup) an invalid
 * provider until the hourly sync ran. This is the minimal atomic writer with
 * the same file shape/version provider-sync owns.
 * @param deps - host seams (the DSH home owns the cache path).
 * @param id - provider route id.
 * @param baseURL - the endpoint the empty listing came from.
 * @param now - fetch stamp; injectable for tests.
 * @throws when the cache file cannot be written (the caller must not commit a
 *   route whose known-empty evidence was not recorded).
 */
export function writeKnownEmptyDiscoveredEntry(
  deps: HeavyDeps,
  id: string,
  baseURL: string,
  now: () => number = Date.now,
): void {
  const path = discoveredCachePath(deps)
  let document: { version: number; routes: Record<string, unknown> } = { version: DISCOVERED_CACHE_VERSION, routes: {} }
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (isPlainRecord(parsed) && parsed.version === DISCOVERED_CACHE_VERSION && isPlainRecord(parsed.routes)) {
        document = { version: DISCOVERED_CACHE_VERSION, routes: { ...parsed.routes } }
      }
    } catch {
      // A corrupt cache is replaced by a valid minimal document; a failed
      // sync pass can always rebuild it.
    }
  }
  document.routes[id] = { baseURL, fetchedAt: now(), models: [] }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  try {
    writeFileSync(temporary, JSON.stringify(document), 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
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

/** Whether a value is a plain JSON object (not an array or null). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** How many attempts a settings write makes when another writer moved the namespace. */
const MAX_SETTINGS_WRITE_ATTEMPTS = 3

/** The settings service's conflict code; a stale revision is replanned, not replayed. */
function isSettingsConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
}

/** One namespace plan and the result it produced from the fresh document. */
interface PlannedSettingsWrite<T> {
  readonly ops: readonly Record<string, unknown>[]
  readonly result: T
}

/**
 * Apply one settings plan with a bounded conflict retry. The plan callback
 * re-reads the namespace on every attempt, so a concurrent writer's unrelated
 * fields survive and leaf operations are never replayed against a stale
 * document. No operations means no write at all.
 */
async function applySettingsPlan<T>(
  settings: SettingsSeam,
  ns: string,
  plan: (document: Record<string, unknown> | undefined) => PlannedSettingsWrite<T>,
): Promise<{ committed: boolean; result: T }> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_SETTINGS_WRITE_ATTEMPTS; attempt += 1) {
    const planned = plan(readNamespace(settings, ns))
    if (planned.ops.length === 0) return { committed: false, result: planned.result }
    try {
      await settings.mutate(ns, planned.ops, revisionOf(settings, ns))
      return { committed: true, result: planned.result }
    } catch (error) {
      lastError = error
      if (!isSettingsConflict(error) || attempt === MAX_SETTINGS_WRITE_ATTEMPTS - 1) throw error
    }
  }
  throw lastError
}

/** One provider's host reference cleanup plan. */
interface OrchestrationCleanup {
  readonly ops: readonly Record<string, unknown>[]
  readonly chainLinksRemoved: number
  readonly rewritten: readonly string[]
  readonly droppedChains: ReadonlySet<string>
}

/**
 * Plan the `enpoi-orchestration` rewrite: chain links, persona seats, and the
 * picker preferences that name the route. Chain and persona writes are leaf
 * operations, so an unrelated chain or seat is never restated. A malformed
 * entry is preserved untouched.
 * @param document - the freshly read orchestration document.
 * @param id - deleted provider route id.
 * @returns the planned operations and their diagnostics.
 */
function planOrchestrationCleanup(document: Record<string, unknown> | undefined, id: string): OrchestrationCleanup {
  const ops: Record<string, unknown>[] = []
  const rewritten: string[] = []
  const droppedChains = new Set<string>()
  let chainLinksRemoved = 0
  const chains = document?.chains
  if (isPlainRecord(chains)) {
    for (const [chainId, raw] of Object.entries(chains)) {
      if (!isPlainRecord(raw)) continue
      const links = Array.isArray(raw.links) ? raw.links : []
      const kept = links.filter(link => !linkReferences(link, id))
      if (kept.length === links.length) continue
      chainLinksRemoved += links.length - kept.length
      const selectors = Array.isArray(raw.selectors) ? raw.selectors : []
      if (kept.length === 0 && selectors.length === 0) {
        ops.push({ op: 'unset', path: ['chains', chainId] })
        droppedChains.add(chainId)
        rewritten.push(`chains.${chainId}: dropped (last link removed)`)
        continue
      }
      ops.push({ op: 'set', path: ['chains', chainId], value: { ...raw, links: kept } })
      rewritten.push(`chains.${chainId}: dropped ${String(links.length - kept.length)} link(s)`)
    }
  }

  const personas = document?.personas
  if (isPlainRecord(personas)) {
    for (const [seat, raw] of Object.entries(personas)) {
      if (!isPlainRecord(raw)) continue
      const chain = typeof raw.chain === 'string' && raw.chain !== '' ? raw.chain : undefined
      const namesRoute = raw.provider === id
      const namesDroppedChain = chain !== undefined && droppedChains.has(chain)
      if (!namesRoute && !namesDroppedChain) continue
      ops.push({ op: 'set', path: ['personas', seat], value: null })
      rewritten.push(`personas.${seat}: reset to inherit`)
    }
  }

  const preferences = document?.uiPreferences
  if (isPlainRecord(preferences)) {
    const favorites = Array.isArray(preferences.favorites) ? preferences.favorites : undefined
    if (favorites !== undefined) {
      const kept = favorites.filter(entry => !(isPlainRecord(entry) && entry.provider === id))
      if (kept.length !== favorites.length) {
        ops.push({ op: 'set', path: ['uiPreferences', 'favorites'], value: kept })
        rewritten.push('uiPreferences.favorites: pruned')
      }
    }
    const hidden = preferences.hiddenModels
    if (isPlainRecord(hidden) && Object.hasOwn(hidden, id)) {
      const next = { ...hidden }
      delete next[id]
      ops.push({ op: 'set', path: ['uiPreferences', 'hiddenModels'], value: next })
      rewritten.push('uiPreferences.hiddenModels: pruned')
    }
    const order = Array.isArray(preferences.providerOrder) ? preferences.providerOrder : undefined
    if (order !== undefined) {
      const kept = order.filter(entry => entry !== id)
      if (kept.length !== order.length) {
        ops.push({ op: 'set', path: ['uiPreferences', 'providerOrder'], value: kept })
        rewritten.push('uiPreferences.providerOrder: pruned')
      }
    }
  }

  return { ops, chainLinksRemoved, rewritten, droppedChains }
}

/** The built-in keyless route the default selection resets to under the kilo baseline. */
const DEFAULT_BASELINE_PROVIDER = 'kilo'
/** The measured free model the built-in keyless route names. */
const DEFAULT_BASELINE_MODEL = 'poolside/laguna-s-2.1:free'

/** Plan the `agent-default-model` rewrite; unrelated selections stay untouched. */
function planDefaultModelCleanup(
  document: Record<string, unknown> | undefined,
  id: string,
  droppedChains: ReadonlySet<string>,
): { ops: Record<string, unknown>[]; rewritten: string[] } {
  if (document === undefined) return { ops: [], rewritten: [] }
  const ops: Record<string, unknown>[] = []
  const rewritten: string[] = []
  const chain = typeof document.chain === 'string' && document.chain !== '' ? document.chain : undefined
  if (chain !== undefined && droppedChains.has(chain)) {
    ops.push({ op: 'unset', path: ['chain'] })
    rewritten.push('agent-default-model.chain: dropped')
  }
  if (document.provider !== id) return { ops, rewritten }
  const baseline = document.baseline === 'off' ? 'off' : 'kilo'
  ops.push(
    { op: 'set', path: ['provider'], value: baseline === 'off' ? '' : DEFAULT_BASELINE_PROVIDER },
    { op: 'set', path: ['model'], value: baseline === 'off' ? '' : DEFAULT_BASELINE_MODEL },
  )
  rewritten.push('agent-default-model: reset')
  return { ops, rewritten }
}

/** Settings namespace owning the default (main-session) model selection. */
const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'
/** Authoritative host namespace for the subagent allowed-route selection. */
const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection-settings'
/** Older readable spelling of the same subagent selection document. */
const LEGACY_SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection'

/** Plan the subagent allowed-route rewrite; an enabled empty selection resets off. */
function planSubagentCleanup(
  document: Record<string, unknown> | undefined,
  id: string,
): { ops: Record<string, unknown>[]; rewritten: string[] } {
  if (document === undefined) return { ops: [], rewritten: [] }
  const allowed = Array.isArray(document.allowedModels) ? document.allowedModels : undefined
  if (allowed === undefined) return { ops: [], rewritten: [] }
  const kept = allowed.filter(entry => !(isPlainRecord(entry) && entry.provider === id))
  if (kept.length === allowed.length) return { ops: [], rewritten: [] }
  const ops: Record<string, unknown>[] = [{ op: 'set', path: ['allowedModels'], value: kept }]
  if (kept.length === 0 && document.enabled === true) ops.push({ op: 'set', path: ['enabled'], value: false })
  return { ops, rewritten: ['subagent-model-selection: pruned'] }
}

/** What one reference cleanup pass rewrote or failed to rewrite. */
export interface ReferenceCleanupResult {
  chainLinksRemoved: number
  /** Labels of every rewritten host reference row. */
  rewritten: readonly string[]
  /** One entry per namespace that could not be rewritten. */
  errors: readonly string[]
}

/**
 * Rewrite every host reference that names a removed route: default selection,
 * persona seats, chain links, picker favorites/hidden pins/order, and subagent
 * allowed routes. Writes are leaf operations with revision fencing and a
 * bounded conflict retry; an unchanged namespace is never written. The client
 * owns conversation-level and `localStorage` mirrors, which a host cannot
 * safely reach.
 * @param deps - host seams.
 * @param id - deleted provider route id.
 * @returns the counts/labels and any namespace write failure.
 */
export async function removeRouteReferences(deps: HeavyDeps, id: string): Promise<ReferenceCleanupResult> {
  const settings = deps.settings
  if (settings === undefined) return { chainLinksRemoved: 0, rewritten: [], errors: [] }
  const rewritten: string[] = []
  const errors: string[] = []
  let chainLinksRemoved = 0
  let droppedChains: ReadonlySet<string> = new Set()

  try {
    const outcome = await applySettingsPlan(settings, ORCHESTRATION_NS, (document) => {
      const planned = planOrchestrationCleanup(document, id)
      return { ops: planned.ops, result: planned }
    })
    chainLinksRemoved = outcome.result.chainLinksRemoved
    droppedChains = outcome.result.droppedChains
    rewritten.push(...outcome.result.rewritten)
  } catch (error) {
    errors.push(`references (${ORCHESTRATION_NS}): ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const outcome = await applySettingsPlan(settings, AGENT_DEFAULT_MODEL_NS, (document) => {
      const planned = planDefaultModelCleanup(document, id, droppedChains)
      return { ops: planned.ops, result: planned.rewritten }
    })
    rewritten.push(...outcome.result)
  } catch (error) {
    errors.push(`references (${AGENT_DEFAULT_MODEL_NS}): ${error instanceof Error ? error.message : String(error)}`)
  }

  for (const ns of [SUBAGENT_MODEL_SELECTION_NS, LEGACY_SUBAGENT_MODEL_SELECTION_NS]) {
    if (readNamespace(settings, ns) === undefined) continue
    try {
      const outcome = await applySettingsPlan(settings, ns, (document) => {
        const planned = planSubagentCleanup(document, id)
        return { ops: planned.ops, result: planned.rewritten }
      })
      rewritten.push(...outcome.result)
    } catch (error) {
      errors.push(`references (${ns}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { chainLinksRemoved, rewritten, errors }
}

/**
 * Remove every chain link that names the route. A chain left with no links
 * and no selectors is dropped with it. Returns the number of removed links;
 * a document that does not change is not written.
 * @param deps - host seams.
 * @param id - deleted provider route id.
 * @returns the number of removed links.
 */
export async function removeChainReferences(deps: HeavyDeps, id: string): Promise<number> {
  const settings = deps.settings
  if (settings === undefined) return 0
  const outcome = await applySettingsPlan(settings, ORCHESTRATION_NS, (document) => {
    const planned = planOrchestrationCleanup(document, id)
    return {
      // Only the chain part belongs to this legacy helper.
      ops: planned.ops.filter(op => Array.isArray(op.path) && op.path[0] === 'chains'),
      result: planned.chainLinksRemoved,
    }
  })
  return outcome.result
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
  /** Host reference rows the cleanup pass rewrote (diagnostics). */
  referencesRemoved?: readonly string[]
  /** Set when a live or unreadable provider lock refused removal before any mutation. */
  blocked?: { reason: string; lock: 'held' | 'unreadable' }
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

/** Every credential reference a manifest or its configured route actually names. */
function routeCredentialRefs(
  manifest: HeavyProviderManifest,
  profile: Record<string, unknown> | undefined,
): string[] {
  const refs = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value !== '') refs.add(value)
  }
  add(manifest.auth.apiKeyEnv)
  for (const identity of manifest.pool?.identities ?? []) add(identity.credentialRef)
  if (profile !== undefined) {
    add(profile.apiKeyEnv)
    const pool = profile.pool
    if (isPlainRecord(pool) && Array.isArray(pool.identities)) {
      for (const identity of pool.identities) {
        if (isPlainRecord(identity)) add(identity.credentialRef)
      }
    }
  }
  return [...refs]
}

/** Classify a provider-lock refusal by name without importing the job module. */
function lockRefusal(error: unknown): { reason: string; lock: 'held' | 'unreadable' } | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const name = (error as { name?: unknown }).name
  if (name !== 'HeavyProviderLockedError' && name !== 'HeavyProviderLockUnreadableError') return undefined
  return {
    reason: error instanceof Error ? error.message : String(error),
    lock: name === 'HeavyProviderLockedError' ? 'held' : 'unreadable',
  }
}

/** A summary that mutates nothing, used when the provider lock refuses removal. */
function refusedRemoval(reason: string, lock: 'held' | 'unreadable'): RemovalSummary {
  return {
    routeRemoved: false,
    credentialRemoved: false,
    poolStateRemoved: false,
    cacheEntryRemoved: false,
    chainLinksRemoved: 0,
    teardown: { ran: false, ok: false, output: '' },
    warnings: [],
    errors: [`lock: ${reason}`],
    blocked: { reason, lock },
  }
}

/** Run one manifest teardown; optional failures are logged, required ones stop the run. */
async function runTeardown(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
): Promise<RemovalSummary['teardown']> {
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
  return { ran: true, ok, ...failedStep === undefined ? {} : { failedStep }, output }
}

/**
 * Remove every trace of a heavy provider while holding its job lock. The DSH
 * route is unset first; a refused unset aborts before the owned-local
 * teardown and every other destructive step, so credentials, pools, cache,
 * references, lifecycle state, and the still-running service survive for a
 * retry. After the route commits, an owned local teardown runs, then
 * credentials, pool state, discovered-cache entry, host references, lifecycle
 * record, and the install-job snapshot are cleaned. A failed teardown keeps
 * the lifecycle receipt even though the route is already gone, so the
 * uninstall can be retried. Unknown or reused state never authorizes the
 * manifest's static teardown; only a local install carrying an ownership
 * receipt does.
 */
async function removeProviderLocked(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  options: { uninstall?: boolean },
): Promise<RemovalSummary> {
  const warnings: string[] = []
  const errors: string[] = []
  const lifecycle: HeavyLifecycleEntry | undefined = lifecycleOf(deps.dshHome, manifest.id)
  const owned = ownsLocalInstall(lifecycle)

  const settingsNs = routeSettingsNs(manifest)
  const profile = configuredProfile(deps, manifest.id, settingsNs)
  const credentialRefs = routeCredentialRefs(manifest, profile)
  let routeRemoved = false
  if (deps.settings !== undefined && profile !== undefined) {
    try {
      await applySettingsPlan(deps.settings, settingsNs, () => ({
        ops: [{ op: 'unset', path: ['providers', manifest.id] }],
        result: undefined,
      }))
      routeRemoved = true
    } catch (error) {
      // The route is the commit point: a refused unset aborts before teardown
      // or any downstream destructive step, so a still-configured provider is
      // never half-removed.
      errors.push(`route: ${error instanceof Error ? error.message : String(error)}`)
      return {
        routeRemoved: false,
        credentialRemoved: false,
        poolStateRemoved: false,
        cacheEntryRemoved: false,
        chainLinksRemoved: 0,
        teardown: { ran: false, ok: true, output: '' },
        warnings,
        errors,
        referencesRemoved: [],
      }
    }
  }

  let teardown: RemovalSummary['teardown'] = { ran: false, ok: true, output: '' }
  if (options.uninstall === true) {
    if (!owned) {
      if (manifest.removal.steps.length > 0) {
        warnings.push(
          `local teardown skipped for ${manifest.id}: no verified harness ownership receipt; the vendor service was not touched`,
        )
      }
    } else if (manifest.removal.steps.length > 0) {
      teardown = await runTeardown(deps, manifest)
      if (!teardown.ok) warnings.push(`local install kept: teardown did not complete, lifecycle record preserved for retry`)
    }
  }

  // A route-only delete of a harness-owned local install must keep the seeded
  // credential: the service is still running with that key, the lifecycle
  // record stays for a later uninstall, and a detected-instance re-add has to
  // work without the operator retyping a key the installer generated.
  const retainOwnedCredential = owned && options.uninstall !== true
  let credentialRemoved = false
  if (retainOwnedCredential) {
    if (credentialRefs.length > 0) {
      warnings.push(
        `credential ${credentialRefs.join(', ')} kept: ${manifest.id} is still an owned local install`
        + ' (remove with uninstall to run its teardown); the generated key is required to re-add it',
      )
    }
  } else if (deps.credentials !== undefined) {
    for (const ref of credentialRefs) {
      if (credentialRefInUse(deps, manifest, ref)) {
        warnings.push(`credential ${ref} kept: another configured route references it`)
        continue
      }
      try {
        await deps.credentials.unset(ref)
        credentialRemoved = true
      } catch (error) {
        errors.push(`credential ${ref}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const poolStateRemoved = removePoolState(deps, manifest.id)
  const cacheEntryRemoved = removeDiscoveredEntry(deps, manifest.id)
  const references = await removeRouteReferences(deps, manifest.id)
  errors.push(...references.errors)

  try {
    if (lifecycle !== undefined) {
      const uninstalled = owned && options.uninstall === true && teardown.ok
      const reused = lifecycle.mode === 'reuse'
      if (uninstalled || reused) {
        clearProviderLifecycle(deps.dshHome, manifest.id)
      } else if (owned && options.uninstall !== true) {
        warnings.push(`local install left in place: ${manifest.id} is still owned by this harness; remove with uninstall to run its teardown`)
      }
    }
  } catch (error) {
    errors.push(`state: ${error instanceof Error ? error.message : String(error)}`)
  }

  // The job manager owns the snapshot's memory and file; eviction goes through
  // it so a restart-persisted `succeeded` view cannot resurrect on status for
  // a provider whose route no longer exists. This runs under the same lock an
  // install holds, so a finalizer cannot re-create the file afterwards.
  const evicted = deps.jobs?.evict(manifest.id) ?? true
  if (!evicted) warnings.push(`job snapshot for ${manifest.id} kept: a live owner still holds it`)

  return {
    routeRemoved,
    credentialRemoved,
    poolStateRemoved,
    cacheEntryRemoved,
    chainLinksRemoved: references.chainLinksRemoved,
    teardown,
    warnings,
    errors,
    referencesRemoved: references.rewritten,
  }
}

/**
 * Remove every trace of a heavy provider. The provider's shared job lock is
 * taken before any route, teardown, credential, cache, or reference work: a
 * live or unreadable lock returns a refusal summary and mutates nothing. A
 * caller without a job manager acquires the same on-disk provider lock
 * directly instead of running unlocked. An unknown or reused install never
 * runs the manifest's static teardown; a route-only deletion remains allowed
 * and reports the retained local install.
 * @param deps - host seams.
 * @param manifest - the manifest being removed (operator overlay applied).
 * @param options - `uninstall` requests the owned local teardown.
 * @returns what was removed; sub-failures are reported in `errors`.
 */
export async function removeProvider(
  deps: HeavyDeps,
  manifest: HeavyProviderManifest,
  options: { uninstall?: boolean } = {},
): Promise<RemovalSummary> {
  const jobs = deps.jobs
  if (jobs?.withProviderLock !== undefined) {
    try {
      return await jobs.withProviderLock(manifest.id, () => removeProviderLocked(deps, manifest, options))
    } catch (error) {
      const refusal = lockRefusal(error)
      if (refusal === undefined) throw error
      return refusedRemoval(refusal.reason, refusal.lock)
    }
  }
  // A direct planner caller with no job manager still owns the same
  // cross-process provider lock. Destructive removal never runs unlocked, and
  // a live/unreadable lock refuses exactly as the manager path does.
  const dir = join(deps.dshHome, 'cache', 'heavy-jobs')
  let lock
  try {
    lock = acquireProviderLock(dir, manifest.id)
  } catch (error) {
    const refusal = lockRefusal(error)
    if (refusal === undefined) throw error
    return refusedRemoval(refusal.reason, refusal.lock)
  }
  try {
    const fallbackJobs: NonNullable<HeavyDeps['jobs']> = {
      evict: deps.jobs?.evict ?? ((id) => {
        try {
          rmSync(join(dir, `${id}.json`), { force: true })
          return true
        } catch {
          return false
        }
      }),
      isRunning: deps.jobs?.isRunning ?? (() => false),
      withProviderLock: async (_id, operation) => operation(),
    }
    return await removeProviderLocked({ ...deps, jobs: fallbackJobs }, manifest, options)
  } finally {
    lock.release()
  }
}
