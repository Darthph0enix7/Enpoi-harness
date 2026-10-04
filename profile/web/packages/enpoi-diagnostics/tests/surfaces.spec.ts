import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  listIncidentsFrom,
  listPatternsFrom,
  mutePattern,
  submitClientReport,
  systemHealthFrom,
  validateClientReport,
} from '../src/api.js'
import { IncidentBus } from '../src/capture.js'
import { fingerprintMessage } from '../src/fingerprint.js'
import { buildReport } from '../src/report.js'
import type { IncidentInput } from '../src/store.js'
import { IncidentStore } from '../src/store.js'
import { DIAGNOSTICS_TOOL_NAME, registerDiagnosticsTool } from '../src/tools.js'

let root: string
let store: IncidentStore
let bus: IncidentBus
const now = (): number => 10_000

function record(overrides: Partial<IncidentInput> = {}): void {
  const kind = overrides.kind ?? 'log'
  const message = overrides.message ?? 'boom'
  const fingerprinted = fingerprintMessage(kind, message)
  store.record({
    severity: 'error',
    source: 'session',
    at: 1_000,
    ...overrides,
    kind,
    message,
    code: overrides.code ?? fingerprinted.code,
    fingerprint: overrides.fingerprint ?? fingerprinted.fingerprint,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diag-surfaces-'))
  store = new IncidentStore(join(root, 'incidents.sqlite'), { cooldownMs: 0, now })
  bus = new IncidentBus(store, { flushMs: 60_000 })
})

afterEach(() => {
  bus.dispose()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('buildReport', () => {
  it('reports ok on an empty store', () => {
    const report = buildReport(store, bus.stats(), { window: '24h', now })
    expect(report.status).toBe('ok')
    expect(report.patterns).toEqual([])
    expect(report.degraded).toEqual([])
    expect(report.summary).toContain('0 incident row(s)')
  })

  it('flags degraded subsystems deterministically', () => {
    record({ kind: 'provider-error', code: 'RATE_LIMIT', message: 'rate limit exceeded for model auto', at: 9_000, severity: 'warn' })
    record({ kind: 'plugin-failed', code: 'PLUGIN_FAILED', message: 'plugin failed to activate: enpoi-whiteboard', at: 9_500, source: 'plugin' })
    record({ kind: 'log', code: 'ERROR', message: 'MCP mount failed for server foo', at: 9_800, source: 'log:dsh-mcp' })
    record({ kind: 'log', code: 'INFO', message: 'informational line', at: 9_900, source: 'log:dsh-mcp' })
    const report = buildReport(store, bus.stats(), { window: '24h', now, degradeWindowMs: 60_000 })
    expect(report.degraded.map(entry => entry.subsystem).sort()).toEqual(['logs', 'plugin-load', 'providers'])
    expect(report.status).toBe('degraded')
  })

  it('honours mute in the degraded fold and in the pattern list', () => {
    record({ kind: 'provider-error', code: 'RATE_LIMIT', message: 'rate limit exceeded for model auto', at: 9_000, severity: 'warn' })
    const [pattern] = store.patterns()
    store.mute(pattern.fingerprint, true)
    const report = buildReport(store, bus.stats(), { window: '24h', now, degradeWindowMs: 60_000 })
    expect(report.patterns).toEqual([])
    expect(report.degraded.map(entry => entry.subsystem)).not.toContain('providers')
  })

  it('skips log lines when includeLogs is false', () => {
    record({ kind: 'log', code: 'ERROR', message: 'MCP mount failed for server foo', at: 9_800, source: 'log:dsh-mcp' })
    const report = buildReport(store, bus.stats(), { window: '24h', now, degradeWindowMs: 60_000, includeLogs: false })
    expect(report.degraded).toEqual([])
  })

  it('surfaces self failures as a degraded diagnostics subsystem', () => {
    bus.noteSelfFailure()
    const report = buildReport(store, bus.stats(), { window: '24h', now })
    expect(report.degraded[0]).toMatchObject({ subsystem: 'diagnostics', count: 1 })
  })
})

describe('diagnostics_report tool', () => {
  it('registers a schema-valid tool and returns a schema-valid report', async () => {
    const registered: Array<{ name: string; definition: any }> = []
    const ctx = {
      tools: { register: (definition: any) => { registered.push({ name: definition.name, definition }); return () => {} } },
    } as unknown as import('@deepseek-ai/cordis').Context
    registerDiagnosticsTool(ctx, { store, bus, now })
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe(DIAGNOSTICS_TOOL_NAME)

    const definition = registered[0].definition
    expect(() => assertObjectJsonSchema(definition.output.schema)).not.toThrow()
    record({ kind: 'tool-error', message: 'query must be a string', at: 9_000, context: { errorCode: 'BAD_ARGS' } })

    const value = await definition.execute({ window: '24h', limit: 10 })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
    expect(value.ok).toBe(true)
    expect(value.patterns).toHaveLength(1)
    expect(value.patterns[0].code).toMatch(/^D[0-9A-F]{6}$/)
    expect(value.recent[0].message).toContain('query must be a string')
  })

  it('returns an empty ok:false report instead of throwing when the store is closed', async () => {
    const registered: any[] = []
    const ctx = { tools: { register: (definition: any) => { registered.push(definition); return () => {} } } } as unknown as import('@deepseek-ai/cordis').Context
    registerDiagnosticsTool(ctx, { store, bus, now })
    store.close()
    const value = await registered[0].execute({})
    expect(value.ok).toBe(false)
    expect(value.patterns).toEqual([])
    expect(validateJsonSchemaValue(registered[0].output.schema, value)).toEqual([])
  })
})

describe('diagnostics RPC payloads', () => {
  it('accepts a well-formed client report and stores it with a stable fingerprint', () => {
    const first = submitClientReport(bus, { kind: 'window.onerror', message: 'TypeError: x is undefined at app.js:42', url: 'https://enpoi.vip/app' })
    const second = submitClientReport(bus, { kind: 'window.onerror', message: 'TypeError: x is undefined at app.js:99', url: 'https://enpoi.vip/app' })
    expect(first.ok).toBe(true)
    expect(first.fingerprint).toBe(second.fingerprint)
    bus.flushNow()
    const [incident] = store.incidents()
    expect(incident).toMatchObject({ source: 'client', kind: 'client-report' })
    expect(incident.code).toMatch(/^D[0-9A-F]{6}$/)
    expect(incident.context).toMatchObject({ clientKind: 'window.onerror', url: 'https://enpoi.vip/app' })
  })

  it('rejects malformed client reports at the boundary', () => {
    expect(() => validateClientReport({ kind: '', message: 'x' })).toThrowError(/kind must not be empty/)
    expect(() => validateClientReport({ kind: 'ok', message: 42 })).toThrowError(/message must be a string/)
    expect(() => validateClientReport({ kind: 'bad kind!', message: 'x' })).toThrowError(/kind must match/)
    expect(() => validateClientReport(undefined)).toThrowError(/kind/)
    expect(() => validateClientReport({ kind: 'ok', message: 'x', stack: 'y'.repeat(1001) })).toThrowError(/stack/)
  })

  it('lists incidents and patterns, and mutes by fingerprint', () => {
    record({ kind: 'provider-error', code: 'RATE_LIMIT', message: 'rate limit exceeded for model auto', at: 9_000, severity: 'warn' })
    const pattern = listPatternsFrom(store, { window: '1h' }, now).items[0]
    expect(pattern.count).toBe(1)
    expect(pattern.windowCount).toBe(1)
    expect(listIncidentsFrom(store, { limit: 5 }, now).items).toHaveLength(1)
    expect(mutePattern(store, bus, { fingerprint: pattern.fingerprint })).toEqual({ ok: true, muted: true })
    expect(listPatternsFrom(store, {}, now).items).toHaveLength(0)
    expect(listPatternsFrom(store, { includeMuted: true }, now).items).toHaveLength(1)
    expect(() => mutePattern(store, bus, { fingerprint: 'x' })).toThrowError(/fingerprint/)
    expect(() => listIncidentsFrom(store, { severity: 'nope' }, now)).toThrowError(/severity/)
    expect(() => listPatternsFrom(store, { window: '2h' }, now)).toThrowError(/window/)
  })

  it('projects system health with counters and degraded subsystems', () => {
    record({ kind: 'provider-error', code: 'RATE_LIMIT', message: 'rate limit exceeded for model auto', at: 9_000, severity: 'warn' })
    const health = systemHealthFrom(store, bus, { now })
    expect(health.status).toBe('degraded')
    expect(health.degraded[0].subsystem).toBe('providers')
    expect(health.counts.incidents).toBe(1)
    expect(health.storePath).toContain('incidents.sqlite')
  })

  it('does not throw when the store is unavailable', () => {
    store.close()
    expect(() => listIncidentsFrom(store, {}, now)).not.toThrow()
    expect(listIncidentsFrom(store, {}, now).items).toEqual([])
    expect(submitClientReport(bus, { kind: 'window.onerror', message: 'boom' }).ok).toBe(true)
    const health = systemHealthFrom(store, bus, { now })
    expect(health.status).toBe('degraded')
    expect(health.degraded[0]).toMatchObject({ subsystem: 'diagnostics' })
  })
})
