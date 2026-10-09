/**
 * Terminal host configuration: the schema defaults that preserve the shipped
 * behavior, overrides, and the per-session cap the registry enforces.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { TerminalHostError, TerminalRegistry, defaultShell, ensureSpawnHelper } from '../src/pty.ts'

let registry: TerminalRegistry | undefined

afterEach(() => {
  registry?.dispose()
  registry = undefined
})

describe('enpoi-terminal config', () => {
  it('resolves the shipped defaults when omitted', () => {
    const resolved = Config({})
    expect(resolved.maxPerSession).toBe(8)
    expect(resolved.disconnectGraceMs).toBe(90_000)
    expect(resolved.transcriptLimitBytes).toBe(512 * 1024)
    expect(resolved.shell).toBe(defaultShell())
  })

  it('keeps explicit overrides', () => {
    const resolved = Config({
      maxPerSession: 2,
      disconnectGraceMs: 1_000,
      transcriptLimitBytes: 1024,
      shell: '/bin/sh',
    })
    expect(resolved).toEqual({
      maxPerSession: 2,
      disconnectGraceMs: 1_000,
      transcriptLimitBytes: 1024,
      shell: '/bin/sh',
    })
  })

  it.skipIf(process.platform === 'win32')('rejects a third terminal when maxPerSession is 2', () => {
    ensureSpawnHelper()
    registry = new TerminalRegistry({ maxPerSession: 2, shell: '/bin/sh' })
    registry.open({ key: 'session:one', sessionId: 'session' })
    registry.open({ key: 'session:two', sessionId: 'session' })
    let caught: unknown
    try {
      registry.open({ key: 'session:three', sessionId: 'session' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TerminalHostError)
    expect((caught as TerminalHostError).code).toBe('session-limit')
    expect((caught as TerminalHostError).status).toBe(429)
    // Another conversation keeps its own budget.
    expect(registry.open({ key: 'other:one', sessionId: 'other' }).spawned).toBe(true)
  })
})
