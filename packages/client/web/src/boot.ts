/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page; plugin composition and the renderer handoff are
 * `bootClient` and `mountClient`. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { installBootGate } from './boot-gate.ts'
import {
  installClientHealth, type BootFailureDisposition, type ClientHealth,
} from './client-health.ts'
import { bootClient } from './boot-client.ts'
import { BootPage, type BootRetryFeedback } from './boot-page.ts'
import { mountClient } from './mount.ts'
import { getStaticModules } from './seed.ts'
import { installWindowDragRecall } from './window-drag/recall.ts'
import './base.css'

/** Stage whose failure the startup classifier is judging. */
export type BootFailureStage =
  /** Injection bootstrap, module-system construction, or manifest validation. */
  | 'bootstrap'
  /** Bundle import or plugin activation through the Loader. */
  | 'plugins'
  /** Renderer handoff, reveal gate, or first application mount. */
  | 'mount'

/** Carrier-owned fatal presentation; retryable failures also receive an action. */
export type BootFailureHandler = (
  reason: unknown,
  retry?: () => BootRetryFeedback,
) => void

/** Module transport and page-health hooks replaced by jsdom tests. */
export interface BootSeams extends Pick<ClientModuleCreateOptions, 'loadBundle'> {
  /**
   * Page-health monitor replacement owned by the caller until {@link AppWebEntry.dispose}.
   * Production omits it: the kernel installs the page's own monitor.
   */
  health?: ClientHealth
}

/**
 * Transport-shaped messages that mean a bundle could not be fetched, as
 * opposed to a deterministic plugin/export/manifest failure. Browsers and the
 * worker transport spell the same condition differently, so the classifier
 * checks the whole `cause` chain instead of one engine's wording.
 */
const TRANSIENT_BOOT_ERROR = new RegExp([
  'failed to fetch',
  'fetch failed',
  'network ?error',
  'networkerror',
  'load failed',
  'chunkloaderror',
  'error loading dynamically imported module',
  'dynamically imported module',
  'importing a module script failed',
  'module script failed',
  'internet connection appears to be offline',
  '\\boffline\\b',
  'err_(?:network|internet_disconnected|connection_(?:refused|reset|closed)|timed_out)',
  'econn(?:reset|refused)',
  'etimedout',
  'enotfound',
  'eai_again',
].join('|'), 'i')

/**
 * Whether one thrown value (or any cause in its chain) is a retryable
 * transport/module-fetch failure rather than a deterministic startup error.
 * @param reason - value thrown while loading or activating the client.
 * @returns true for transport, network, chunk, and offline errors.
 */
export function isTransientBootError(reason: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = reason
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      if (current.name === 'NetworkError') return true
      if (TRANSIENT_BOOT_ERROR.test(current.message)) return true
      const code: unknown = (current as { code?: unknown }).code
      if (typeof code === 'string' && TRANSIENT_BOOT_ERROR.test(code)) return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return typeof reason === 'string' && TRANSIENT_BOOT_ERROR.test(reason)
}

/**
 * Classify one visible startup failure. Plugin-stage failures are transport
 * failures only when the module system recorded a transient import error;
 * plugin activation, export, manifest, and configuration errors stay fatal
 * even if their own text happens to resemble a network error.
 * @param reason - value caught by the boot kernel.
 * @param stage - boot stage that failed.
 * @param modules - module system carrying the per-row import error, when ready.
 * @param pluginIds - manifest rows whose imports the plugin stage attempted.
 * @returns the recovery disposition for the visible boot page.
 */
export function classifyBootFailure(
  reason: unknown,
  stage: BootFailureStage,
  modules?: Pick<ClientModuleSystem, 'importError'>,
  pluginIds: readonly string[] = [],
): BootFailureDisposition {
  if (stage === 'plugins') {
    if (modules === undefined) return 'fatal'
    return pluginIds.some((id) => {
      const error = modules.importError(id)
      return error !== undefined && isTransientBootError(error)
    }) ? 'retryable' : 'fatal'
  }
  return stage === 'mount' && isTransientBootError(reason) ? 'retryable' : 'fatal'
}

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private health: ClientHealth | undefined
  private stopDragRecall: (() => void) | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest
  /** Monotone boot-progress counter consumed by the page-health deadline. */
  private bootProgress = 0

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @param onFailure - Optional carrier-owned presentation; a retryable failure
   * also receives the explicit retry action. Keeps the boot page visible.
   * @returns Resolves after application mount or failure reporting.
   */
  async run(onFailure?: BootFailureHandler): Promise<void> {
    // The page health net installs before the first await: a stalled boot, an
    // error/rejection breadcrumb, or a fatal render crash all have one owner,
    // and the boot deadline covers everything the failure rendering below
    // cannot see.
    const { health: healthSeam, ...moduleSeams } = this.seams ?? {}
    const health = this.health ??= healthSeam ?? installClientHealth({
      container: this.container,
      bootProgress: () => this.bootProgress,
    })
    let stage: BootFailureStage = 'bootstrap'
    try {
      // Boot-readiness gate: whichever bootstrap applies the injection table
      // settles this deferred once every row has taken effect — the served
      // index resolves it in the rendered tail, so the await returns on the
      // next microtask; an asynchronous bootstrap resolves it after its last
      // row, or rejects it into the failure rendering below. An absent global
      // means no bootstrap owns the document and there is nothing to wait for.
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__?.promise
      this.bootProgress += 1
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.bootProgress += 1
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...moduleSeams,
      })
      this.manifest = this.modules.manifest
      // Advertised critical reads (sessions, settings) hold the boot page until
      // they settle, so the first application frame is the complete shell.
      const gate = installBootGate()

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      this.page.setTotal(this.manifest.plugins.length)
      await prefetching
      this.bootProgress += 1
      stage = 'plugins'
      await bootClient({
        ctx,
        modules: this.modules,
        manifest: this.manifest,
        onEntryState: (name, state) => {
          this.bootProgress += 1
          if (onFailure === undefined || state !== 'failed') this.page.setState(name, state)
        },
      })
      this.bootProgress += 1
      stage = 'mount'
      // The shell owns the one watcher that keeps Electron's window drag rects in
      // step with the rows that own them (electron#32341), so no chrome row has to
      // know that trap. It installs before the first mount, so the surface the
      // renderer draws is the one the first frame measures.
      this.stopDragRecall = installWindowDragRecall({ document: this.container.ownerDocument })
      // Single reveal: the boot page stays through the advertised reads (bounded
      // by the gate budget) and the mount then hydrates it in one transition.
      this.page.setHint('Preparing workspace…')
      await gate.settled()
      this.bootProgress += 1
      await mountClient(ctx, this.container)
      health.markBootComplete()
    } catch (reason) {
      // The failure stays visible on the boot page (or the carrier's own
      // surface). A transport/module-fetch failure keeps a bounded recovery
      // path through online/pageshow/visible events and the page's explicit
      // retry action; a deterministic plugin/export/config failure never
      // auto-reloads. The guard's cooldown and rolling cap bound both paths.
      const disposition = stage === 'plugins'
        ? classifyBootFailure(reason, stage, this.modules, this.manifest.plugins.map(row => row.id))
        : classifyBootFailure(reason, stage)
      health.markBootFailed(disposition)
      console.error(reason)
      const retry = (): BootRetryFeedback => this.retryFeedback(health.retryBoot())
      if (onFailure !== undefined) {
        if (disposition === 'retryable') onFailure(reason, retry)
        else onFailure(reason)
      } else {
        this.page.fail(
          reason instanceof Error ? reason.message : String(reason),
          retry,
        )
      }
    }
  }

  /** Translate one guarded retry outcome into visible boot-page feedback. */
  private retryFeedback(outcome: ReturnType<ClientHealth['retryBoot']>): BootRetryFeedback {
    if (outcome.kind === 'reload') return { message: 'Reloading…', disabled: true }
    if (outcome.kind === 'ignored') {
      return {
        message: outcome.reason === 'disposed'
          ? 'Retry is no longer available; reload the page manually.'
          : 'Retry is only available after a visible boot failure; reload the page manually.',
        disabled: true,
      }
    }
    if (outcome.reason === 'cooldown') {
      const seconds = Math.max(1, Math.ceil((outcome.retryAfterMs ?? 0) / 1000))
      return { message: `Retry is cooling down; try again in ${String(seconds)}s or reload the page manually.` }
    }
    if (outcome.reason === 'limit') {
      return { message: 'Retry limit reached; reload the page manually to try again.', disabled: true }
    }
    return {
      message: 'Retry guard storage is unavailable; reload the page manually to try again.',
      disabled: true,
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    this.health?.dispose()
    this.health = undefined
    this.stopDragRecall?.()
    this.stopDragRecall = undefined
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** Prefetch stage-one bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      }).finally(() => { this.bootProgress += 1 })))
  }
}
