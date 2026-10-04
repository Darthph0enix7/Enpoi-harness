import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Exporter, Message } from '@deepseek-ai/cordis'
import { attachLoggerSink, attachPluginLifecycle, attachSessionEvents, IncidentBus, logIncident } from '../src/capture.js'
import { IncidentStore } from '../src/store.js'

let root: string
let store: IncidentStore
let bus: IncidentBus
let exporters: Exporter[]
let listeners: Map<string, Array<(...args: any[]) => void>>
let fakeCtx: Context

function message(overrides: Partial<Message> = {}): Message {
  return { sn: 1, ts: 1_000, name: 'dsh-mcp', type: 'error', level: 0, args: ['mcp mount failed'], ...overrides }
}

function emit(name: string, ...args: unknown[]): void {
  for (const listener of listeners.get(name) ?? []) listener(...args)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diag-capture-'))
  store = new IncidentStore(join(root, 'incidents.sqlite'), { cooldownMs: 60_000 })
  bus = new IncidentBus(store, { flushMs: 5_000 })
  exporters = []
  listeners = new Map()
  fakeCtx = {
    logger: { exporter: (exporter: Exporter) => { exporters.push(exporter); return () => {} } },
    on: (name: string, listener: (...args: any[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
  } as unknown as Context
})

afterEach(() => {
  vi.restoreAllMocks()
  bus.dispose()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('logger sink', () => {
  it('subscribes at every level and persists error lines', () => {
    attachLoggerSink(fakeCtx, bus)
    expect(exporters).toHaveLength(1)
    expect(exporters[0].levels).toEqual({ default: 3 })
    exporters[0].export(message())
    bus.flushNow()
    const [incident] = store.incidents()
    expect(incident).toMatchObject({ severity: 'error', source: 'log:dsh-mcp', kind: 'log' })
    expect(incident.code).toMatch(/^D[0-9A-F]{6}$/)
    expect(incident.message).toContain('mcp mount failed')
  })

  it('persists debug lines other exporters drop', () => {
    attachLoggerSink(fakeCtx, bus)
    exporters[0].export(message({ type: 'debug', level: 3, args: ['provider probe'] }))
    bus.flushNow()
    expect(store.incidents()).toHaveLength(1)
    expect(store.incidents()[0].severity).toBe('debug')
  })

  it('never captures its own logger lines', () => {
    attachLoggerSink(fakeCtx, bus)
    exporters[0].export(message({ name: 'enpoi-diagnostics' }))
    bus.flushNow()
    expect(store.incidents()).toHaveLength(0)
  })

  it('respects the minSeverity filter', () => {
    attachLoggerSink(fakeCtx, bus, 'warn')
    exporters[0].export(message({ type: 'info', level: 1, args: ['chatty'] }))
    exporters[0].export(message({ name: 'x', type: 'warn', level: 2, args: ['careful'] }))
    bus.flushNow()
    expect(store.incidents()).toHaveLength(1)
    expect(store.incidents()[0].severity).toBe('warn')
  })

  it('formats Error arguments into one bounded line', () => {
    attachLoggerSink(fakeCtx, bus)
    exporters[0].export(message({ args: [new Error('socket hang up')], name: 'llm' }))
    bus.flushNow()
    expect(store.incidents()[0].message).toContain('Error: socket hang up')
  })

  it('aggregates repeated identical log lines instead of flooding', () => {
    attachLoggerSink(fakeCtx, bus)
    const record = message({ args: ['provider 500 from https://api.example.com/v1 after 1200ms'] })
    exporters[0].export(record)
    exporters[0].export({ ...record, args: ['provider 503 from https://api.example.com/v1 after 900ms'] })
    bus.flushNow()
    const rows = store.incidents()
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(2)
    expect(store.patterns()[0].count).toBe(2)
  })
})

describe('session-event seam', () => {
  beforeEach(() => {
    attachSessionEvents(fakeCtx, bus)
  })

  it('captures tool errors with the tool name and stable code', () => {
    emit('session/event', { id: 's1' }, { type: 'request/context', data: { provider: 'freellmapi', model: 'auto' } })
    emit('session/event', { id: 's1' }, { type: 'tool/call', data: { callId: 'c1', name: 'memory_search' } })
    emit('session/event', { id: 's1' }, {
      type: 'tool/result',
      data: { callId: 'c1', error: { name: 'ToolArgsError', code: 'BAD_ARGS', reason: 'query must be a string' } },
    })
    bus.flushNow()
    const [incident] = store.incidents()
    expect(incident).toMatchObject({
      kind: 'tool-error',
      severity: 'error',
      sessionId: 's1',
      provider: 'freellmapi',
      model: 'auto',
    })
    expect(incident.code).toMatch(/^D[0-9A-F]{6}$/)
    expect(incident.context).toMatchObject({ tool: 'memory_search', callId: 'c1', errorCode: 'BAD_ARGS' })
  })

  it('ignores successful tool results', () => {
    emit('session/event', { id: 's1' }, { type: 'tool/result', data: { callId: 'c1' } })
    bus.flushNow()
    expect(store.incidents()).toHaveLength(0)
  })

  it('captures provider retries as warn provider-error with the classified code', () => {
    emit('session/event', { id: 's2' }, {
      type: 'llm/retry',
      data: {
        provider: 'freellmapi',
        retry: 2,
        maxRetries: 3,
        mode: 'normal',
        policyKey: 'default',
        delayMs: 500,
        failure: { code: 'RATE_LIMIT', message: 'rate limit exceeded for model auto' },
      },
    })
    bus.flushNow()
    const [incident] = store.incidents()
    expect(incident).toMatchObject({ kind: 'provider-error', severity: 'warn', provider: 'freellmapi' })
    expect(incident.code).toMatch(/^D[0-9A-F]{6}$/)
    expect(incident.context).toMatchObject({ errorCode: 'RATE_LIMIT', retry: 2, maxRetries: 3, mode: 'normal' })
  })

  it('captures turn errors and compaction errors', () => {
    emit('session/event', { id: 's3' }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'error', error: { code: 'CONTEXT_OVERFLOW', message: 'context window exceeded' } } } })
    emit('session/event', { id: 's3' }, { type: 'compaction/end', data: { compactionId: 'cmp1', error: 'summarizer returned empty output' } })
    bus.flushNow()
    const kinds = store.incidents().map(row => row.kind).sort()
    expect(kinds).toEqual(['compaction-error', 'turn-error'])
  })

  it('ignores completed turns', () => {
    emit('session/event', { id: 's4' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    bus.flushNow()
    expect(store.incidents()).toHaveLength(0)
  })

  it('never throws on malformed payloads', () => {
    emit('session/event', { id: 's5' }, { type: 'tool/result', data: null })
    emit('session/event', { id: 's5' }, { type: 'llm/retry', data: { failure: null } })
    bus.flushNow()
    expect(bus.stats().selfFailures).toBe(0)
  })
})

describe('plugin-lifecycle seam', () => {
  it('records one incident per failed fiber', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    attachPluginLifecycle(fakeCtx, bus)
    const fiber = { state: 3, name: 'enpoi-whiteboard' }
    emit('internal/status', fiber, 1)
    emit('internal/status', fiber, 3)
    emit('internal/status', { state: 2, name: 'fine' }, 1)
    bus.flushNow()
    const incidents = store.incidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ kind: 'plugin-failed', severity: 'error' })
    expect(incidents[0].code).toMatch(/^D[0-9A-F]{6}$/)
    expect(incidents[0].context).toMatchObject({ plugin: 'enpoi-whiteboard' })
    vi.restoreAllMocks()
  })

  it('makes a throwing fiber loud: journal line plus the error in the coded row', () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })
    attachPluginLifecycle(fakeCtx, bus)
    const error = Object.assign(new Error('cannot get property "tools" without inject'), { code: 'INACTIVE_EFFECT' })
    const fiber = { state: 3, name: 'enpoi-capabilities', _error: error }
    emit('internal/status', fiber, 1)
    emit('internal/status', fiber, 3)
    emit('internal/status', fiber, 3)
    bus.flushNow()
    // One deduped journal line naming the fiber and its stored error.
    expect(written.filter(line => line.includes('plugin fiber failed'))).toEqual([
      '[enpoi-diagnostics] plugin fiber failed: enpoi-capabilities: Error: cannot get property "tools" without inject [INACTIVE_EFFECT]\n',
    ])
    const [incident] = store.incidents()
    expect(incident).toMatchObject({ kind: 'plugin-failed', severity: 'error' })
    expect(incident.message).toContain('enpoi-capabilities')
    expect(incident.message).toContain('cannot get property "tools" without inject')
    expect(incident.context).toMatchObject({ plugin: 'enpoi-capabilities', error: 'Error: cannot get property "tools" without inject [INACTIVE_EFFECT]' })
    vi.restoreAllMocks()
  })

  it('reports a real throwing plugin fiber (synthetic mount) through the seam', async () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })
    const ctx = new Context()
    const realStore = new IncidentStore(join(root, 'real.sqlite'), { cooldownMs: 60_000 })
    const realBus = new IncidentBus(realStore, { flushMs: 5_000 })
    try {
      attachPluginLifecycle(ctx, realBus)
      ctx.plugin({ name: 'boom-synthetic', apply: () => { throw new Error('kaboom') } })
      await new Promise(resolve => setTimeout(resolve, 25))
      realBus.flushNow()
      expect(written).toContain('[enpoi-diagnostics] plugin fiber failed: boom-synthetic: Error: kaboom\n')
      const [incident] = realStore.incidents()
      expect(incident).toMatchObject({ kind: 'plugin-failed', severity: 'error' })
      expect(incident.message).toContain('boom-synthetic')
      expect(incident.message).toContain('kaboom')
    } finally {
      realBus.dispose()
      realStore.close()
    }
  })

  it('degrades to bounded text when the fiber stored no error', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    attachPluginLifecycle(fakeCtx, bus)
    emit('internal/status', { state: 3, name: '' }, 1)
    bus.flushNow()
    const [incident] = store.incidents()
    expect(incident.message).toContain('plugin fiber failed: unknown: no error captured')
    vi.restoreAllMocks()
  })
})

describe('IncidentBus fail-open guarantees', () => {
  it('swallows a store failure, counts it once, and still delivers later writes', () => {
    let notified = 0
    const guarded = new IncidentBus(store, { flushMs: 5_000, onSelfFailure: () => { notified += 1 } })
    store.close()
    expect(() => {
      guarded.push({ severity: 'error', source: 'session', kind: 'tool-error', code: 'X', fingerprint: 'ffffffffffffffff', message: 'first' })
      guarded.push({ severity: 'error', source: 'session', kind: 'tool-error', code: 'X', fingerprint: 'eeeeeeeeeeeeeeee', message: 'second' })
      guarded.flushNow()
    }).not.toThrow()
    const stats = guarded.stats()
    expect(stats.selfFailures).toBe(1)
    expect(stats.dropped).toBeGreaterThanOrEqual(2)
    expect(notified).toBe(1)
    guarded.dispose()
  })

  it('bounds the queue instead of growing without limit', () => {
    const bounded = new IncidentBus(store, { flushMs: 60_000, queueLimit: 16 })
    for (let index = 0; index < 100; index += 1) {
      bounded.push({ severity: 'error', source: 'log:x', kind: 'log', code: 'ERROR', fingerprint: `fp${String(index)}`, message: `line ${String(index)}` })
    }
    expect(bounded.stats().pending).toBeLessThanOrEqual(16)
    bounded.dispose()
  })

  it('logIncident drops empty records', () => {
    expect(logIncident(message({ args: [] }))).toBeUndefined()
  })
})
