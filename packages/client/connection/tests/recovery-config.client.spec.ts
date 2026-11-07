/** Recovery timing validation before a loop or Host bootstrap is published. */
import { describe, expect, it } from 'vitest'
import { resolveConnectionConfig } from '../src/recovery-config.ts'

describe('connection recovery configuration', () => {
  it('separates the slow-Host warning from the hard handshake deadline', () => {
    expect(resolveConnectionConfig()).toEqual({
      backoffBaseMs: 500,
      backoffFactor: 2,
      backoffMaxMs: 10_000,
      generationReadyWarnMs: 3_000,
      generationReadyTimeoutMs: 15_000,
      stableConnectionMs: 30_000,
      wakeReconnectDebounceMs: 100,
      wakeStaleThresholdMs: 30_000,
      wakeConnectingGraceMs: 3_000,
      watchdogIntervalMs: 5_000,
      watchdogStaleMs: 30_000,
      networkDebounceMs: 1_000,
      reconnectStaggerMs: 100,
      rpcTimeoutMs: 45_000,
    })
  })

  it.each([
    { backoffBaseMs: 0 },
    { backoffFactor: 0.5 },
    { backoffFactor: Infinity },
    { backoffFactor: NaN },
    { backoffMaxMs: -1 },
    { generationReadyWarnMs: NaN },
    { generationReadyTimeoutMs: 2_147_483_648 },
    { generationReadyTimeoutMs: '15000' },
    { stableConnectionMs: 0 },
    { wakeStaleThresholdMs: -1 },
    { wakeConnectingGraceMs: 1.5 },
    { watchdogIntervalMs: 0 },
    { watchdogStaleMs: NaN },
    { networkDebounceMs: 2_147_483_648 },
    { reconnectStaggerMs: -1 },
    { reconnectStaggerMs: NaN },
    { rpcTimeoutMs: 0 },
  ])('rejects timing that could disable recovery or overflow a timer: %j', (config) => {
    expect(() => resolveConnectionConfig(config)).toThrow()
  })

  it('allows disabling the reconnect stagger explicitly', () => {
    expect(resolveConnectionConfig({ reconnectStaggerMs: 0 }).reconnectStaggerMs).toBe(0)
  })

  it('preserves a finite fractional growth factor', () => {
    expect(resolveConnectionConfig({ backoffFactor: 1.5 }).backoffFactor).toBe(1.5)
  })
})
