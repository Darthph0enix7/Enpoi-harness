import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { INCLUDE_BODIES_REASON, parseSessionDebugArgs, registerSessionDebugTool, SESSION_DEBUG_TOOL_NAME } from '../src/tools.js'
import { clampRecentTools, CAPS, PREVIEW_CHARS } from '../src/fold.js'
import type { DebugSources, DigestValue, IncidentListValue, SnapshotValue } from '../src/types.js'

function digestValue(overrides: Partial<DigestValue> = {}): DigestValue {
  return {
    sessionId: 'session-test-1',
    state: {
      latch: 'idle',
      since: 1_000,
      source: 'host-latch',
      activeDescendants: 0,
      descendantsExact: true,
      pendingAsks: [],
      model: { provider: 'test', model: 'm1' },
    },
    recentToolCalls: [],
    injectionIndex: [],
    subagentTree: [],
    pendingInteractions: [],
    ...overrides,
  }
}

function snapshotValue(overrides: Partial<SnapshotValue> = {}): SnapshotValue {
  return {
    capturedAt: 2_000,
    sessionId: 'session-test-1',
    provider: 'test',
    model: 'm1',
    system: { chars: 10, sha256: 'abc' },
    tools: ['bash', 'read'],
    messages: [{ role: 'user', chars: 5 }],
    bodiesIncluded: false,
    ...overrides,
  }
}

interface ApprovalSeam {
  readonly request: (request: Record<string, unknown>) => Promise<string>
}

function register(
  resolve: () => DebugSources | undefined,
  approval?: ApprovalSeam,
): { definition: any; registered: any[] } {
  const registered: any[] = []
  const ctx = {
    tools: {
      register: (definition: any) => { registered.push(definition); return () => {} },
    },
    get: (name: string) => (name === 'approval' ? approval : undefined),
  } as unknown as Context
  registerSessionDebugTool(ctx, { resolve })
  return { definition: registered[0], registered: registered }
}

/** The execution identity the registry hands the tool body in production. */
const EXEC = {
  agent: { id: 'agent-1', session: { id: 'session-caller' } },
  signal: new AbortController().signal,
}

describe('session_debug tool', () => {
  it('registers a schema-valid tool that folds the digest by default', async () => {
    const { definition } = register(() => ({
      digest: async () => digestValue({
        recentToolCalls: [{ tool: 'bash', status: 'ok', argumentPreview: 'ls', resultPreview: 'total 12' }],
        pendingInteractions: [{ kind: 'approval', askId: 'a1', toolName: 'bash', since: 1 }],
      }),
      requestSnapshot: async () => snapshotValue(),
    }))
    expect(definition.name).toBe(SESSION_DEBUG_TOOL_NAME)
    expect(() => assertObjectJsonSchema(definition.output.schema)).not.toThrow()
    const value = await definition.execute({ sessionId: 'session-test-1' })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
    expect(value.ok).toBe(true)
    expect(value.include).toEqual(['digest'])
    expect(value.digest.latch).toBe('idle')
    expect(value.digest.recentToolCalls[0].tool).toBe('bash')
    expect(value.digest.pendingInteractions[0].kind).toBe('approval')
    expect(value.snapshot).toBeNull()
    expect(value.incidents).toBeNull()
  })

  it('never returns snapshot bodies unless includeBodies is explicitly true and approved once', async () => {
    const calls: Array<{ includeBodies?: boolean }> = []
    const asks: Array<Record<string, unknown>> = []
    const snapshot = (request: { includeBodies?: boolean }): SnapshotValue => {
      calls.push(request)
      return request.includeBodies === true
        ? snapshotValue({
          bodiesIncluded: true,
          bodies: { system: 'S'.repeat(9_000), tools: [{ name: 'bash' }], messages: [{ role: 'user', content: 'x' }] },
        })
        : snapshotValue()
    }
    const { definition } = register(
      () => ({ digest: async () => digestValue(), requestSnapshot: async request => snapshot(request) }),
      { request: async request => { asks.push(request); return 'allowed-once' } },
    )
    const summary = await definition.execute({ sessionId: 's', include: ['snapshot'] })
    expect(summary.snapshot.bodies).toBeUndefined()
    expect(summary.snapshot.bodiesIncluded).toBe(false)
    expect(calls[0]?.includeBodies).toBe(false)
    expect(asks).toHaveLength(0)
    const full = await definition.execute({ sessionId: 's', include: ['snapshot'], includeBodies: true }, EXEC)
    expect(calls[1]?.includeBodies).toBe(true)
    expect(full.snapshot.bodies.system.length).toBeLessThanOrEqual(4_001)
    expect(full.snapshot.bodies.system.endsWith('…')).toBe(true)
    expect(full.notes.join(' ')).toMatch(/secret-bearing/)
    expect(asks).toHaveLength(1)
    expect(asks[0]?.toolName).toBe(SESSION_DEBUG_TOOL_NAME)
    expect(asks[0]?.reason).toBe(INCLUDE_BODIES_REASON)
    expect(asks[0]?.agent).toEqual(EXEC.agent)
  })

  it('refuses includeBodies on anything but allowed-once: summary-only, no body text, named ask', async () => {
    const asks: Array<Record<string, unknown>> = []
    const sourceCalls: Array<{ includeBodies?: boolean }> = []
    // Hostile source: always hands over bodies, so the refusal must be enforced
    // by the tool (not by asking the source nicely).
    const source = (request: { includeBodies?: boolean }): SnapshotValue => {
      sourceCalls.push(request)
      return snapshotValue({
        bodiesIncluded: true,
        bodies: { system: 'S'.repeat(9_000), tools: [], messages: [{ role: 'user', content: 'top secret' }] },
      })
    }
    for (const outcome of ['rejected', 'allowed-always', 'cancelled', 'unavailable']) {
      const { definition } = register(
        () => ({ digest: async () => digestValue(), requestSnapshot: async request => source(request) }),
        { request: async request => { asks.push(request); return outcome } },
      )
      const value = await definition.execute({ sessionId: 's', include: ['snapshot'], includeBodies: true }, EXEC)
      expect(sourceCalls.at(-1)?.includeBodies).toBe(false)
      expect(value.snapshot.bodies).toBeUndefined()
      expect(JSON.stringify(value)).not.toContain('S'.repeat(64))
      expect(JSON.stringify(value)).not.toContain('top secret')
      expect(value.notes.join(' ')).toContain(`includeBodies refused (${outcome})`)
      expect(value.notes.join(' ')).toMatch(/raw system prompt and message bodies/)
      expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
    }
    // Every refusal still asked a human, with the exact named reason.
    expect(asks).toHaveLength(4)
    expect(asks.every(ask => ask.toolName === SESSION_DEBUG_TOOL_NAME
      && ask.reason === INCLUDE_BODIES_REASON
      && ask.agent !== undefined)).toBe(true)
  })

  it('refuses includeBodies when no approval service or executing agent is present', async () => {
    const { definition } = register(() => ({
      digest: async () => digestValue(),
      requestSnapshot: async () => snapshotValue({
        bodiesIncluded: true,
        bodies: { system: 'S'.repeat(9_000), tools: [], messages: [] },
      }),
    }))
    const value = await definition.execute({ sessionId: 's', include: ['snapshot'], includeBodies: true })
    expect(value.snapshot.bodies).toBeUndefined()
    expect(value.notes.join(' ')).toContain('includeBodies refused (unavailable)')
    expect(JSON.stringify(value)).not.toContain('S'.repeat(64))
  })

  it('caps every list and preview', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ tool: `t${index}`, status: 'ok' as const, resultPreview: 'z'.repeat(2_000) }))
    const { definition } = register(() => ({ digest: async () => digestValue({ recentToolCalls: many }), requestSnapshot: async () => snapshotValue() }))
    const value = await definition.execute({ sessionId: 's', recentTools: 50 })
    expect(value.digest.recentToolCalls).toHaveLength(CAPS.recentTools)
    expect(value.digest.recentToolCallCount).toBe(40)
    expect(value.digest.recentToolCalls[0].resultPreview.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1)
    expect(clampRecentTools(500)).toBe(50)
    expect(clampRecentTools(-3)).toBe(1)
    expect(clampRecentTools('nope')).toBe(10)
  })

  it('preserves the gateway error code when an explicit id is not attached, even with a callable caller session', async () => {
    const failure = Object.assign(new Error('session "x" not found (not attached)'), { code: 'session/not-found' })
    const { definition } = register(() => ({ digest: async () => { throw failure }, requestSnapshot: async () => snapshotValue() }))
    const value = await definition.execute({ sessionId: 'x' }, EXEC)
    expect(value.ok).toBe(false)
    expect(value.sessionId).toBe('x')
    expect(value.error).toEqual({ code: 'session/not-found', message: 'session "x" not found (not attached)' })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
  })

  it('reports debug/unavailable when no read surface exists in this process', async () => {
    const { definition } = register(() => undefined)
    const value = await definition.execute({ sessionId: 'x' })
    expect(value.ok).toBe(false)
    expect(value.error.code).toBe('debug/unavailable')
  })

  it('rejects a malformed provided sessionId with gateway/bad-request instead of throwing', async () => {
    const { definition } = register(() => ({ digest: async () => digestValue(), requestSnapshot: async () => snapshotValue() }))
    const value = await definition.execute({ sessionId: '   ' })
    expect(value.ok).toBe(false)
    expect(value.error.code).toBe('gateway/bad-request')
    expect(parseSessionDebugArgs({}).sessionId).toBeUndefined()
    expect(() => parseSessionDebugArgs({ sessionId: 42 })).toThrowError(/sessionId/)
  })

  it('defaults an omitted sessionId to the calling session and keeps an explicit id', async () => {
    const asked: Array<{ sessionId?: string }> = []
    const { definition } = register(() => ({
      digest: async request => { asked.push(request); return digestValue() },
      requestSnapshot: async () => snapshotValue(),
    }))
    const omitted = await definition.execute({}, EXEC)
    expect(omitted.ok).toBe(true)
    expect(omitted.sessionId).toBe('session-caller')
    expect(asked[0]?.sessionId).toBe('session-caller')
    const explicit = await definition.execute({ sessionId: 'other-session' }, EXEC)
    expect(explicit.sessionId).toBe('other-session')
    expect(asked[1]?.sessionId).toBe('other-session')
  })

  it('rejects an omitted sessionId when no calling Agent is attached', async () => {
    const { definition } = register(() => ({ digest: async () => digestValue(), requestSnapshot: async () => snapshotValue() }))
    const value = await definition.execute({})
    expect(value.ok).toBe(false)
    expect(value.sessionId).toBe('')
    expect(value.error.code).toBe('gateway/bad-request')
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
  })

  it('folds incidents with this session first and renders a compact text form', async () => {
    const incidents: IncidentListValue = {
      generatedAt: 3_000,
      items: [
        { at: 1, severity: 'warn', source: 'session', kind: 'tool-error', code: 'D1', message: 'other' },
        { at: 2, severity: 'error', source: 'session', kind: 'provider-error', code: 'D2', message: 'mine', sessionId: 's' },
      ],
    }
    const { definition } = register(() => ({ digest: async () => digestValue(), requestSnapshot: async () => snapshotValue(), incidents: async () => incidents }))
    const value = await definition.execute({ sessionId: 's', include: ['incidents'] })
    expect(value.incidents.sessionMatches).toBe(1)
    expect(value.incidents.items[0].code).toBe('D2')
    const rendered = definition.output.render({}, value)
    expect(rendered[0].text).toMatch(/session_debug s/)
    expect(rendered[0].text).toMatch(/incidents \(1 for this session/)
  })
})

describe('preset registration (orchestrator + sysadmin only)', () => {
  // tests/ -> package root -> packages/ -> profile root.
  const profileRoot = fileURLToPath(new URL('../../..', import.meta.url))

  it('is named inside the enpoi-orchestration group of exactly those two presets', () => {
    const read = (preset: string): string => readFileSync(`${profileRoot}/presets/${preset}/agent.cordis.yml`, 'utf8')
    expect(read('orchestrator')).toContain("name: 'dsh-enpoi-debug'")
    expect(read('sysadmin')).toContain("name: 'dsh-enpoi-debug'")
    expect(read('creator')).not.toContain('dsh-enpoi-debug')
  })

  it('is NOT a host-plane profile bundle (that would leak the tool to every agent)', () => {
    const profile = JSON.parse(readFileSync(`${profileRoot}/package.json`, 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(profile.dependencies?.['dsh-enpoi-debug']).toBe('workspace:*')
    expect(profile.dsh?.profile?.bundles ?? []).not.toContain('dsh-enpoi-debug')
  })
})
