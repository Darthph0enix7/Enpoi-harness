/**
 * Boot reveal gate. The framework-free boot page stays up after the module
 * graph activates while a small set of critical reads settle, so the first
 * application frame is the complete shell instead of a shell that grows rows
 * and panels seconds later. Publishers in other bundles advertise their read
 * and report its promise through the page global, which keeps them free of an
 * import edge on this package (the same seam shape as `__dshSettingsDescribe`).
 *
 * Only advertised reads gate the reveal, so a composition that has no session
 * or settings reader mounts immediately; a read past the budget is abandoned
 * and the surfaces downstream show their own loading state.
 * @module @deepseek-ai/dsh-client-web/src/boot-gate
 */

/** Page global carrying {@link BootGate}; publishers reach it without importing this package. */
export const BOOT_GATE_GLOBAL = '__dshBootGate'

/** Milliseconds one advertised read may hold the reveal after its own start. */
export const BOOT_GATE_BUDGET_MS = 10_000

/** Milliseconds the reveal waits for an advertised read to actually start. */
export const BOOT_GATE_START_GRACE_MS = 1_500

/** Critical-read registry the boot page waits on before the application mounts. */
export interface BootGate {
  /**
   * Advertise one critical read the composition will start during boot.
   * @param name - stable signal name (`sessions`, `settings`).
   */
  expect(name: string): void
  /**
   * Publish the in-flight promise of one advertised read. A read that fails
   * still reveals; the failure belongs to the surface it feeds.
   * @param name - the name passed to {@link expect}.
   * @param promise - the read's completion.
   */
  register(name: string, promise: Promise<unknown>): void
  /**
   * Wait for every advertised read to start and settle, bounded by each read's
   * own budget and by the start grace. Idempotent; never rejects.
   * @returns after the reads settled or their budgets expired.
   */
  settled(): Promise<void>
}

interface BootSignal {
  promise: Promise<unknown>
  startedAt: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Install the gate on the page global so plugin bundles can advertise and
 * report their critical reads during client activation.
 * @param budgetMs - upper bound from one read's start to the reveal.
 * @param startGraceMs - how long an advertised read may take to start.
 * @returns the installed gate.
 */
export function installBootGate(
  budgetMs = BOOT_GATE_BUDGET_MS,
  startGraceMs = BOOT_GATE_START_GRACE_MS,
): BootGate {
  const expected = new Set<string>()
  const signals = new Map<string, BootSignal>()
  let settled = false
  const gate: BootGate = {
    expect(name) {
      if (!settled) expected.add(name)
    },
    register(name, promise) {
      if (settled) return
      expected.add(name)
      signals.set(name, { promise: promise.catch(() => undefined), startedAt: Date.now() })
    },
    async settled() {
      if (settled) return
      if (expected.size > 0) {
        const graceEnd = Date.now() + startGraceMs
        while (Date.now() < graceEnd && [...expected].some(name => !signals.has(name))) {
          await sleep(Math.min(25, Math.max(1, graceEnd - Date.now())))
        }
      }
      // Each read keeps its own budget measured from its start, so a read that
      // began before the module graph settled still gets its full window.
      await Promise.all([...signals.values()].map(({ promise, startedAt }) => Promise.race([
        promise,
        sleep(Math.max(0, startedAt + budgetMs - Date.now())),
      ])))
      settled = true
      expected.clear()
      signals.clear()
    },
  }
  ;(globalThis as Record<string, unknown>)[BOOT_GATE_GLOBAL] = gate
  return gate
}
