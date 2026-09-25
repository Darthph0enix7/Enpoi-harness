// @vitest-environment jsdom
/** The reveal gate's advertised-read registry: settle order, start grace, and budgets. */
import { afterEach, describe, expect, it } from 'vitest'
import { BOOT_GATE_GLOBAL, installBootGate } from '../src/boot-gate.ts'

afterEach(() => { delete (globalThis as Record<string, unknown>)[BOOT_GATE_GLOBAL] })

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('installBootGate', () => {
  it('installs the gate on the page global', () => {
    const gate = installBootGate(50, 10)
    expect((globalThis as Record<string, unknown>)[BOOT_GATE_GLOBAL]).toBe(gate)
  })

  it('settles immediately when the composition advertises no reads', async () => {
    const gate = installBootGate(50, 10)
    const started = Date.now()
    await gate.settled()
    expect(Date.now() - started).toBeLessThan(40)
  })

  it('waits for an advertised read to settle', async () => {
    const gate = installBootGate(500, 50)
    const read = deferred<void>()
    gate.expect('sessions')
    const settled = gate.settled()
    await new Promise(resolve => setTimeout(resolve, 20))
    gate.register('sessions', read.promise)
    read.resolve()
    await settled
  })

  it('reveals after the start grace when an advertised read never starts', async () => {
    const gate = installBootGate(500, 30)
    gate.expect('settings')
    const started = Date.now()
    await gate.settled()
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(25)
    expect(elapsed).toBeLessThan(300)
  })

  it('reveals when a registered read exceeds its budget', async () => {
    const gate = installBootGate(40, 10)
    gate.register('sessions', new Promise<void>(() => {}))
    const started = Date.now()
    await gate.settled()
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('reveals when a registered read fails', async () => {
    const gate = installBootGate(500, 10)
    gate.register('settings', Promise.reject(new Error('offline')))
    await gate.settled()
  })

  it('ignores advertisements and registrations after settling', async () => {
    const gate = installBootGate(20, 10)
    await gate.settled()
    gate.expect('later')
    gate.register('later', new Promise<void>(() => {}))
    await gate.settled()
  })
})
