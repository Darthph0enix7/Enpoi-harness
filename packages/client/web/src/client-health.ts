/**
 * Page-owned client health: last-resort crash recovery, blank-workspace
 * watchdog, and rate-limited error breadcrumbs.
 *
 * The application can lose its React tree without any server-side symptom: a
 * fatal render error outside the per-entry slot boundaries, a client bundle
 * replacement that never re-mounts the renderer, or a boot that stalls past
 * every budget. This module is the page's own net:
 *
 * - window `error` / `unhandledrejection` listeners report structured,
 *   rate-limited breadcrumbs through the existing `diagnostics.report` RPC, so
 *   the next occurrence names its cause in the host's incident store.
 * - A watchdog probes the mount point on tab return, on a hard boot deadline,
 *   and shortly after mount reaches the application. A blank or replaced-away
 *   workspace triggers one hard reload, guarded by a sessionStorage cooldown and
 *   a rolling reload cap, so recovery can never loop.
 * - When a reload is suppressed (cooldown, cap, or unavailable storage) a
 *   framework-free boot-style card states the failure — never a blank page.
 * @module @deepseek-ai/dsh-client-web/src/client-health
 */
import { BootPage } from './boot-page.ts'

/** Page global carrying the {@link ClientHealthGlobal} face (the renderer's recovery seam). */
export const CLIENT_HEALTH_GLOBAL = '__DSH_CLIENT_HEALTH__'

/** Milliseconds the boot may take from the entry start to application mount. */
export const BOOT_DEADLINE_MS = 45_000

/** Milliseconds the mounted application gets to render its first frame before the first probe. */
export const BOOT_SETTLE_MS = 2_000

/** Milliseconds between two auto-reloads; inside it recovery falls back to the card. */
export const RELOAD_COOLDOWN_MS = 30_000

/** Auto-reloads allowed inside one rolling {@link RELOAD_WINDOW_MS} window. */
export const MAX_RELOADS_PER_WINDOW = 3

/** Rolling window over which auto-reloads are counted. */
export const RELOAD_WINDOW_MS = 600_000

/** Breadcrumb reports allowed per rolling minute. */
export const REPORT_LIMIT_PER_MINUTE = 5

/** One identical breadcrumb message is reported at most once per this window. */
export const REPORT_DEDUPE_MS = 30_000

/** sessionStorage key of the rolling auto-reload record. */
const RELOAD_RECORD_KEY = 'dsh.clientHealth.reloads'

const MAX_MESSAGE_CHARS = 4000
const MAX_STACK_CHARS = 1000
const MAX_DEDUPE_ENTRIES = 200

/** One structured client failure breadcrumb (the `diagnostics.report` request). */
export interface ClientErrorReport {
  /** Short client classifier, e.g. `window.onerror`, `unhandledrejection`, `renderer.fatal`. */
  readonly kind: string
  /** Bounded error text. */
  readonly message: string
  /** Bounded stack when the failure carried one. */
  readonly stack?: string
  /** Page URL at report time. */
  readonly url?: string
}

/** The page-global recovery face the root error boundary and slot boundaries call. */
export interface ClientHealthGlobal {
  /**
   * Recover from one fatal page failure (root boundary catch or watchdog verdict).
   * @param reason - the thrown value.
   */
  fatal(reason: unknown): void
  /**
   * Breadcrumb one contained failure that needs no recovery action (a crashed
   * slot entry or factory occurrence the renderer already surfaced inline).
   * @param kind - short classifier, e.g. `renderer.slot-crash`.
   * @param message - bounded failure text naming the slot or factory.
   * @param stack - optional bounded stack.
   */
  report(kind: string, message: string, stack?: string): void
}

/** Installable page health surface. */
export interface ClientHealth {
  /** Boot reached application mount: stop the deadline and start the settle probe. */
  markBootComplete(): void
  /** Boot failed visibly on the boot page: the watchdog stands down and never reloads. */
  markBootFailed(): void
  /**
   * Run one blank/stall probe against the current page.
   * @returns whether the probe recovered a failure.
   */
  checkNow(): boolean
  /**
   * Report and recover one fatal failure.
   * @param reason - the thrown value.
   * @param kind - breadcrumb classifier (default `renderer.fatal`).
   * @returns the recovery outcome.
   */
  fatal(reason: unknown, kind?: string): 'reload' | 'fallback' | 'ignored'
  /** Remove listeners, timers, and the page global (idempotent). */
  dispose(): void
}

/** {@link installClientHealth} seams; production callers pass only the container. */
export interface ClientHealthOptions {
  /** Application mount point (the element React owns). */
  container: HTMLElement
  /** Page window; defaults to the ambient global. */
  window?: Window
  /** Page document; defaults to the container's owner document. */
  document?: Document
  /** Reload guard storage; `null` disables auto-reload (tests). Defaults to sessionStorage. */
  storage?: Storage | null
  /** Breadcrumb transport; defaults to a fail-soft `diagnostics.report` fetch. */
  postReport?: (report: ClientErrorReport) => void
  /** Hard reload action; defaults to `location.reload()`. */
  reload?: () => void
  /** Suppressed-recovery presentation; defaults to a boot-style failure card. */
  showFallback?: (reason: unknown) => void
  /** Clock; defaults to `Date.now`. */
  now?: () => number
  /** Boot deadline override. */
  bootDeadlineMs?: number
  /** Post-mount settle window override. */
  settleMs?: number
  /** Auto-reload cooldown override. */
  reloadCooldownMs?: number
  /** Rolling auto-reload cap override. */
  maxReloadsPerWindow?: number
  /** Rolling auto-reload window override. */
  reloadWindowMs?: number
  /** Breadcrumbs-per-minute cap override. */
  reportLimitPerMinute?: number
  /** Identical-message dedupe window override. */
  reportDedupeMs?: number
}

/** Describe one thrown value for a breadcrumb or the failure card. */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message === '' ? reason.name : reason.message
  return String(reason)
}

/** Bounded stack of one thrown value, when it carries one. */
function stackOf(reason: unknown): string | undefined {
  if (reason instanceof Error && typeof reason.stack === 'string' && reason.stack !== '') {
    return reason.stack.slice(0, MAX_STACK_CHARS)
  }
  return undefined
}

/** Fail-soft transport: one `diagnostics.report` unary RPC, never awaited. */
async function postDiagnosticsReport(report: ClientErrorReport): Promise<void> {
  try {
    await fetch('/api/diagnostics.report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `client-health-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        method: 'diagnostics.report',
        payload: { args: { request: report } },
      }),
    })
  } catch {
    // The host may be unreachable exactly when the page fails; reporting is best-effort.
  }
}

/** sessionStorage when the browser exposes it; undefined when disabled or throwing. */
function ambientSessionStorage(): { storage: Storage } | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : { storage: sessionStorage }
  } catch {
    // Storage access can throw under some privacy policies; recovery degrades to the card.
    return undefined
  }
}

/** One rolling auto-reload record; `t` is the last reload and `n` its window count. */
interface ReloadRecord {
  t: number
  n: number
}

/** Guardian of the one-reload-per-window auto-recovery invariant. */
class ReloadGuard {
  constructor(
    private readonly storage: Storage | undefined,
    private readonly now: () => number,
    private readonly cooldownMs: number,
    private readonly maxReloads: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Consume one auto-reload slot. The slot is persisted before it is granted,
   * so a reload grants at most the cap inside the rolling window and never
   * twice inside the cooldown; unavailable storage denies the slot rather than
   * risk an unguarded reload loop.
   * @returns true when the caller may reload.
   */
  consume(): boolean {
    const storage = this.storage
    if (storage === undefined) return false
    const now = this.now()
    let next: ReloadRecord = { t: now, n: 1 }
    try {
      const raw = storage.getItem(RELOAD_RECORD_KEY)
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') {
          const record = parsed as { t?: unknown; n?: unknown }
          if (
            typeof record.t === 'number'
            && typeof record.n === 'number'
            && now - record.t <= this.windowMs
          ) {
            if (record.n >= this.maxReloads || now - record.t < this.cooldownMs) return false
            next = { t: now, n: record.n + 1 }
          }
        }
      }
      storage.setItem(RELOAD_RECORD_KEY, JSON.stringify(next))
      return true
    } catch {
      // Unreadable or unwritable storage: deny rather than reload without a guard.
      return false
    }
  }
}

/** Blank-workspace verdict returned by {@link ClientHealthMonitor.probeBlankness}. */
function probeBlankness(container: HTMLElement): string | undefined {
  if (container.querySelector('[data-dsh-boot]') !== null) {
    return 'web boot: the boot page was not replaced by the application'
  }
  const anchor = container.querySelector('[data-slot="root"]')
  if (anchor === null) return 'web boot: the application root is not mounted'
  const meaningful = [...anchor.querySelectorAll('*')].some(
    element => !element.hasAttribute('data-slot-error') && !element.hasAttribute('data-dsh-boot'),
  )
  if (!meaningful && anchor.textContent.trim() === '') {
    return 'web boot: the application root rendered no content'
  }
  return undefined
}

/** Live page-health monitor installed by the web kernel at entry start. */
class ClientHealthMonitor implements ClientHealth {
  private readonly container: HTMLElement
  private readonly win: Window
  private readonly doc: Document
  private readonly now: () => number
  private readonly reload: () => void
  private readonly showFallback: (reason: unknown) => void
  private readonly postReport: (report: ClientErrorReport) => void
  private readonly reloadGuard: ReloadGuard
  private readonly bootDeadlineMs: number
  private readonly settleMs: number
  private readonly reportLimitPerMinute: number
  private readonly reportDedupeMs: number
  private readonly face: ClientHealthGlobal
  private readonly startTimes: number[] = []
  private readonly lastByMessage = new Map<string, number>()
  private bootComplete = false
  private bootFailed = false
  private bootCompletedAt: number | undefined
  private startedAt: number
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  private fallbackShown = false
  private disposed = false

  private readonly onError = (event: ErrorEvent): void => {
    const thrown: unknown = event.error
    const reason = thrown ?? event.message
    this.report('window.onerror', describeReason(reason), stackOf(reason))
  }

  private readonly onRejection = (event: PromiseRejectionEvent): void => {
    this.report('unhandledrejection', describeReason(event.reason), stackOf(event.reason))
  }

  private readonly onVisibility = (): void => {
    if (this.doc.visibilityState === 'visible') this.checkNow()
  }

  constructor(options: ClientHealthOptions) {
    this.container = options.container
    this.win = options.window ?? window
    this.doc = options.document ?? this.win.document
    this.now = options.now ?? Date.now
    this.reload = options.reload ?? (() => { this.win.location.reload() })
    const ambient = ambientSessionStorage()
    this.reloadGuard = new ReloadGuard(
      options.storage === null ? undefined : options.storage ?? ambient?.storage,
      this.now,
      options.reloadCooldownMs ?? RELOAD_COOLDOWN_MS,
      options.maxReloadsPerWindow ?? MAX_RELOADS_PER_WINDOW,
      options.reloadWindowMs ?? RELOAD_WINDOW_MS,
    )
    this.bootDeadlineMs = options.bootDeadlineMs ?? BOOT_DEADLINE_MS
    this.settleMs = options.settleMs ?? BOOT_SETTLE_MS
    this.reportLimitPerMinute = options.reportLimitPerMinute ?? REPORT_LIMIT_PER_MINUTE
    this.reportDedupeMs = options.reportDedupeMs ?? REPORT_DEDUPE_MS
    this.postReport = options.postReport ?? ((report) => { void postDiagnosticsReport(report) })
    this.showFallback = options.showFallback ?? ((reason) => { this.drawDefaultFallback(reason) })
    this.startedAt = this.now()
    this.face = {
      fatal: (reason) => { this.fatal(reason) },
      report: (kind, message, stack) => { this.report(kind, message, stack) },
    }
    this.win.addEventListener('error', this.onError)
    this.win.addEventListener('unhandledrejection', this.onRejection as EventListener)
    this.doc.addEventListener('visibilitychange', this.onVisibility)
    ;(globalThis as Record<string, unknown>)[CLIENT_HEALTH_GLOBAL] = this.face
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined
      if (this.disposed || this.bootComplete || this.bootFailed) return
      this.fatal(new Error('web boot: the workspace did not become ready before the boot deadline'), 'watchdog')
    }, this.bootDeadlineMs)
  }

  markBootComplete(): void {
    if (this.disposed || this.bootComplete) return
    this.bootComplete = true
    this.bootCompletedAt = this.now()
    clearTimeout(this.deadlineTimer)
    this.deadlineTimer = undefined
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined
      this.checkNow()
    }, this.settleMs)
  }

  markBootFailed(): void {
    if (this.disposed) return
    this.bootFailed = true
    clearTimeout(this.deadlineTimer)
    this.deadlineTimer = undefined
  }

  checkNow(): boolean {
    if (this.disposed || this.bootFailed) return false
    const now = this.now()
    if (!this.bootComplete) {
      if (now - this.startedAt < this.bootDeadlineMs) return false
      return this.fatal(new Error('web boot: the workspace did not become ready before the boot deadline'), 'watchdog') !== 'ignored'
    }
    if (this.bootCompletedAt !== undefined && now - this.bootCompletedAt < this.settleMs) return false
    const blank = probeBlankness(this.container)
    if (blank === undefined) return false
    return this.fatal(new Error(blank), 'watchdog') !== 'ignored'
  }

  fatal(reason: unknown, kind = 'renderer.fatal'): 'reload' | 'fallback' | 'ignored' {
    if (this.disposed) return 'ignored'
    this.report(kind, describeReason(reason), stackOf(reason))
    if (this.reloadGuard.consume()) {
      this.reload()
      return 'reload'
    }
    if (!this.fallbackShown) {
      this.fallbackShown = true
      this.showFallback(reason)
    }
    return 'fallback'
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.deadlineTimer)
    this.deadlineTimer = undefined
    clearTimeout(this.settleTimer)
    this.settleTimer = undefined
    this.win.removeEventListener('error', this.onError)
    this.win.removeEventListener('unhandledrejection', this.onRejection as EventListener)
    this.doc.removeEventListener('visibilitychange', this.onVisibility)
    const globals = globalThis as Record<string, unknown>
    if (globals[CLIENT_HEALTH_GLOBAL] === this.face) Reflect.deleteProperty(globalThis, CLIENT_HEALTH_GLOBAL)
  }

  /**
   * Report one breadcrumb through the injected transport, bounded by the
   * per-minute cap and the identical-message dedupe window. The transport runs
   * outside any try of ours because it is contractually fail-soft.
   */
  private report(kind: string, message: string, stack: string | undefined): void {
    const now = this.now()
    while (this.startTimes.length > 0) {
      const oldest = this.startTimes[0]
      if (oldest === undefined || now - oldest < 60_000) break
      this.startTimes.shift()
    }
    if (this.startTimes.length >= this.reportLimitPerMinute) return
    const last = this.lastByMessage.get(message)
    if (last !== undefined && now - last < this.reportDedupeMs) return
    if (this.lastByMessage.size >= MAX_DEDUPE_ENTRIES) this.lastByMessage.clear()
    this.lastByMessage.set(message, now)
    this.startTimes.push(now)
    const url = this.locationHref()
    const report: ClientErrorReport = {
      kind,
      message: message.slice(0, MAX_MESSAGE_CHARS),
      ...(stack === undefined ? {} : { stack }),
      ...(url === undefined ? {} : { url }),
    }
    try {
      this.postReport(report)
    } catch {
      // The reporter must never escalate the failure it was observing.
    }
  }

  private locationHref(): string | undefined {
    try {
      return this.win.location.href
    } catch {
      // A detached or opaque window has no readable location.
      return undefined
    }
  }

  /** Last-resort visible card: the kernel's own boot failure page, reused. */
  private drawDefaultFallback(reason: unknown): void {
    try {
      const page = new BootPage(this.container)
      page.fail(describeReason(reason))
    } catch {
      // The mount point itself is gone; there is nothing left to draw on.
    }
  }
}

/**
 * Install the page health surface and return its disposal handle.
 * @param options - mount point plus the seams above.
 * @returns the installed monitor.
 */
export function installClientHealth(options: ClientHealthOptions): ClientHealth {
  return new ClientHealthMonitor(options)
}
