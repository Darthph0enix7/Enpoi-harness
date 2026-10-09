// @vitest-environment jsdom
/**
 * Route-removal reference cleanup: every operator reference to a deleted
 * provider resets to its default, unrelated references and other routes stay
 * untouched, a route with no references writes nothing, and `baseline: off`
 * yields blank main-session fields instead of the Kilo fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ModelsWire } from '../src/client/store.ts'
import { ORCHESTRATION_NS } from '../src/client/model-groups.ts'
import { removeProviderProfile } from '../src/client/ModelsSection.tsx'
import {
  AGENT_DEFAULT_MODEL_NS, SUBAGENT_MODEL_SELECTION_NS,
  buildAgentDefaultModelOps, buildOrchestrationPlan, buildSubagentSelectionOps,
  cleanupFailureText, cleanupRemovedRoute,
} from '../src/client/route-references.ts'
import { WRITE_TIMEOUT_MS } from '../src/client/write-timeout.ts'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.client.ts'

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

beforeEach(() => {
  localStorage.clear()
})

/** One scripted settings namespace view. */
function namespace(ns: string, value: unknown, revision = 0): SettingsNamespaceView {
  return {
    ns,
    schema: {},
    value: value as JsonValue,
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision,
  }
}

/** One successful Remote answer. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One refused settings answer with the matching code details. */
function refuse(message: string, code: 'settings/rejected' | 'settings/conflict' | 'gateway/internal' = 'settings/rejected') {
  const error = code === 'settings/conflict'
    ? new RemoteError(code, message, { ns: ORCHESTRATION_NS, expected: 1, actual: 2 })
    : new RemoteError(code, message, { ns: ORCHESTRATION_NS })
  return { ok: false as const, error }
}

/** A settings Remote face over scripted namespace views. */
function settingsFace(namespaces: SettingsNamespaceView[]) {
  const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces })))
  const mutate = vi.fn((..._args: unknown[]): Promise<RemoteResult<unknown>> => Promise.resolve(ok(undefined)))
  const api = { settings: { describe, mutate } } as unknown as Pick<ModelsWire, 'settings'>
  return { api, describe, mutate }
}

/** The complete reference document set for one removed route. */
function fullDocs(removed = 'gone'): SettingsNamespaceView[] {
  return [
    namespace(ORCHESTRATION_NS, {
      personas: {
        keeper: { provider: removed, model: 'm' },
        compaction: { provider: 'other', model: 'n', chain: 'dropped' },
        fixer: { provider: 'kept', model: 'k' },
      },
      chains: {
        mixed: {
          label: 'Mixed',
          links: [{ provider: removed, model: 'm' }, { provider: 'kept', model: 'k' }],
          attempts: 2,
          onCut: 'failover',
          disabled: false,
        },
        dropped: { links: [{ provider: removed, model: 'm' }], attempts: 1, onCut: 'continue', disabled: true },
        selector: { links: [{ provider: removed, model: 'm' }], selectors: [{ when: { free: true } }] },
        untouched: { links: [{ provider: 'kept', model: 'k' }] },
      },
      uiPreferences: {
        favorites: [{ provider: removed, modelId: 'm' }, { provider: 'kept', modelId: 'k' }],
        hiddenModels: { [removed]: ['m'], kept: ['k'] },
        providerOrder: [removed, 'kept'],
        providerCatalog: { [removed]: { hidden: true } },
        webSearchPlans: { [removed]: { plan: 'x' } },
      },
    }),
    namespace(AGENT_DEFAULT_MODEL_NS, { provider: removed, model: 'm', baseline: 'kilo' }),
    namespace(SUBAGENT_MODEL_SELECTION_NS, {
      enabled: true,
      allowedModels: [{ provider: removed, model: 'm' }, { provider: 'kept', model: 'k' }],
    }),
  ]
}

describe('cleanupRemovedRoute', () => {
  it('resets every reference type in order and leaves unrelated references alone', async () => {
    const { api, mutate } = settingsFace(fullDocs())
    const result = await cleanupRemovedRoute(api, 'gone')

    expect(result.error).toBeNull()
    expect(mutate).toHaveBeenCalledTimes(3)
    expect(mutate.mock.calls[0]![0]).toBe(ORCHESTRATION_NS)
    expect(mutate.mock.calls[0]![1]).toEqual([
      {
        op: 'set',
        path: ['chains', 'mixed'],
        value: {
          label: 'Mixed',
          links: [{ provider: 'kept', model: 'k' }],
          attempts: 2,
          onCut: 'failover',
          disabled: false,
        },
      },
      { op: 'unset', path: ['chains', 'dropped'] },
      { op: 'set', path: ['chains', 'selector'], value: { links: [], selectors: [{ when: { free: true } }] } },
      { op: 'set', path: ['personas', 'keeper'], value: null },
      { op: 'set', path: ['personas', 'compaction'], value: null },
      { op: 'set', path: ['uiPreferences', 'favorites'], value: [{ provider: 'kept', modelId: 'k' }] },
      { op: 'set', path: ['uiPreferences', 'hiddenModels'], value: { kept: ['k'] } },
      { op: 'set', path: ['uiPreferences', 'providerOrder'], value: ['kept'] },
    ])
    const [agentNs, agentOps] = [mutate.mock.calls[1]![0], mutate.mock.calls[1]![1]] as const
    expect(agentNs).toBe(AGENT_DEFAULT_MODEL_NS)
    expect(agentOps).toEqual([
      { op: 'set', path: ['provider'], value: 'kilo' },
      { op: 'set', path: ['model'], value: 'kilo-auto/free' },
    ])
    const [subagentNs, subagentOps] = [mutate.mock.calls[2]![0], mutate.mock.calls[2]![1]] as const
    expect(subagentNs).toBe(SUBAGENT_MODEL_SELECTION_NS)
    expect(subagentOps).toEqual([{ op: 'set', path: ['allowedModels'], value: [{ provider: 'kept', model: 'k' }] }])
    expect(result.rewritten).toContain('personas.keeper: reset to inherit')
    expect(result.rewritten).toContain('chains.dropped: dropped (last link removed)')
  })

  it('yields blanks instead of the Kilo fallback under baseline off', async () => {
    const { api, mutate } = settingsFace([
      namespace(ORCHESTRATION_NS, { personas: { keeper: { provider: 'kept', model: 'k' } } }),
      namespace(AGENT_DEFAULT_MODEL_NS, { provider: 'gone', model: 'm', baseline: 'off' }),
    ])
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toBeNull()
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0]![1]).toEqual([
      { op: 'set', path: ['provider'], value: '' },
      { op: 'set', path: ['model'], value: '' },
    ])
  })

  it('clears an agent chain whose group the same pass drops', async () => {
    const { api, mutate } = settingsFace([
      namespace(ORCHESTRATION_NS, { chains: { dropped: { links: [{ provider: 'gone', model: 'm' }] } } }),
      namespace(AGENT_DEFAULT_MODEL_NS, { provider: 'kept', model: 'k', chain: 'dropped' }),
    ])
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toBeNull()
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[0]![1]).toEqual([{ op: 'unset', path: ['chains', 'dropped'] }])
    expect(mutate.mock.calls[1]![1]).toEqual([{ op: 'unset', path: ['chain'] }])
  })

  it('writes nothing when the route has no references', async () => {
    const { api, mutate } = settingsFace([
      namespace(ORCHESTRATION_NS, { uiPreferences: { favorites: [{ provider: 'kept', modelId: 'k' }] } }),
      namespace(AGENT_DEFAULT_MODEL_NS, { provider: 'kept', model: 'k' }),
      namespace(SUBAGENT_MODEL_SELECTION_NS, { enabled: false, allowedModels: [] }),
    ])
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result).toEqual({ rewritten: [], error: null })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('returns immediately for an empty route id', async () => {
    const { api, describe } = settingsFace([])
    expect(await cleanupRemovedRoute(api, '')).toEqual({ rewritten: [], error: null })
    expect(describe).not.toHaveBeenCalled()
  })

  it('reports an unavailable describe as the cleanup failure', async () => {
    const { api, describe, mutate } = settingsFace([])
    describe.mockResolvedValue(refuse('offline', 'gateway/internal') as never)
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toEqual({ code: 'unavailable', message: 'offline' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reports a rejected write without a message when the host sent none', async () => {
    const { api, mutate } = settingsFace(fullDocs())
    mutate.mockResolvedValue(refuse('', 'settings/rejected') as never)
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toEqual({ code: 'rejected' })
    expect(result.rewritten).toEqual([])
  })

  it('re-reads and replans after a revision conflict', async () => {
    const { api, mutate } = settingsFace(fullDocs())
    mutate
      .mockResolvedValueOnce(refuse('stale', 'settings/conflict') as never)
      .mockResolvedValue(ok(undefined))
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toBeNull()
    // The retried orchestration write plus the agent and subagent writes.
    expect(mutate).toHaveBeenCalledTimes(4)
    expect(result.rewritten).not.toEqual([])
  })

  it('reports an exhausted conflict after the bounded retries', async () => {
    const { api, mutate } = settingsFace(fullDocs())
    mutate.mockResolvedValue(refuse('busy', 'settings/conflict') as never)
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toEqual({ code: 'conflict' })
    expect(result.rewritten).toEqual([])
    expect(mutate).toHaveBeenCalledTimes(4)
  })

  it('reports a timeout when a namespace write never settles', async () => {
    vi.useFakeTimers()
    const { api, mutate } = settingsFace(fullDocs())
    mutate.mockImplementation(() => new Promise(() => {}))
    const pending = cleanupRemovedRoute(api, 'gone')
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS)
    expect(await pending).toEqual({ rewritten: [], error: { code: 'timeout' } })
  })

  it('keeps committed orchestration work when a later namespace write fails', async () => {
    localStorage.setItem('dsh_model_favorites_v2', JSON.stringify([{ provider: 'gone', modelId: 'm' }]))
    const { api, mutate } = settingsFace(fullDocs())
    mutate
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(refuse('agent refused') as never)
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toEqual({ code: 'rejected', message: 'agent refused' })
    expect(result.rewritten).toContain('personas.keeper: reset to inherit')
    // The committed namespace's local mirrors follow even on a later failure.
    expect(JSON.parse(localStorage.getItem('dsh_model_favorites_v2') ?? '[]')).toEqual([])
  })

  it('reports a subagent write failure after the earlier namespaces committed', async () => {
    const { api, mutate } = settingsFace(fullDocs())
    mutate
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(refuse('subagent refused') as never)
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toEqual({ code: 'rejected', message: 'subagent refused' })
    expect(result.rewritten).toContain('personas.keeper: reset to inherit')
  })

  it('prunes the picker localStorage mirrors and announces the change', async () => {
    localStorage.setItem('dsh_model_favorites_v2', JSON.stringify([{ provider: 'gone', modelId: 'm' }, { provider: 'kept', modelId: 'k' }]))
    localStorage.setItem('dsh_provider_order_v2', JSON.stringify(['gone', 'kept']))
    localStorage.setItem('dsh_hidden_models_v1', JSON.stringify({ gone: ['m'], kept: ['k'] }))
    const events: string[] = []
    window.addEventListener('dsh:model-picker-prefs-changed', () => events.push('prefs'))
    window.addEventListener('dsh:model-groups-changed', () => events.push('groups'))
    window.addEventListener('dsh:hidden-models-changed', () => events.push('hidden'))

    const { api, mutate } = settingsFace([namespace(ORCHESTRATION_NS, { personas: { fixer: { provider: 'kept', model: 'k' } } })])
    const result = await cleanupRemovedRoute(api, 'gone')
    expect(result.error).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('dsh_model_favorites_v2') ?? 'null')).toEqual([{ provider: 'kept', modelId: 'k' }])
    expect(JSON.parse(localStorage.getItem('dsh_provider_order_v2') ?? 'null')).toEqual(['kept'])
    expect(JSON.parse(localStorage.getItem('dsh_hidden_models_v1') ?? 'null')).toEqual({ kept: ['k'] })
    expect(events).toContain('prefs')
    expect(events).toContain('groups')
    expect(events).toContain('hidden')
  })

  it('leaves a malformed local mirror alone instead of failing the cleanup', async () => {
    const { api } = settingsFace([])
    // A non-array favorites mirror is preserved verbatim, and an order list
    // without the route keeps its exact text.
    localStorage.setItem('dsh_model_favorites_v2', '{"not":"an array"}')
    localStorage.setItem('dsh_provider_order_v2', JSON.stringify(['kept']))
    expect((await cleanupRemovedRoute(api, 'gone')).error).toBeNull()
    expect(localStorage.getItem('dsh_model_favorites_v2')).toBe('{"not":"an array"}')
    expect(localStorage.getItem('dsh_provider_order_v2')).toBe('["kept"]')
    // The other way around: a non-array order mirror and malformed favorites.
    localStorage.setItem('dsh_model_favorites_v2', '[not json')
    localStorage.setItem('dsh_provider_order_v2', '{"not":"an array"}')
    expect((await cleanupRemovedRoute(api, 'gone')).error).toBeNull()
    expect(localStorage.getItem('dsh_model_favorites_v2')).toBe('[not json')
    expect(localStorage.getItem('dsh_provider_order_v2')).toBe('{"not":"an array"}')
  })
})

describe('route reference builders', () => {
  it('preserves malformed documents and entries', () => {
    expect(buildOrchestrationPlan(null, 'gone').ops).toEqual([])
    expect(buildOrchestrationPlan({ chains: { bad: 7 }, personas: { bad: 3 } }, 'gone').ops).toEqual([])
    expect(buildOrchestrationPlan({ uiPreferences: { favorites: 'x', hiddenModels: 'x', providerOrder: 'x' } }, 'gone').ops).toEqual([])
    expect(buildAgentDefaultModelOps(null, 'gone', new Set())).toEqual([])
    expect(buildAgentDefaultModelOps({ provider: 'gone' }, 'gone', new Set())).toEqual([
      { op: 'set', path: ['provider'], value: 'kilo' },
      { op: 'set', path: ['model'], value: 'kilo-auto/free' },
    ])
    expect(buildAgentDefaultModelOps({ provider: 'kept', chain: 'kept' }, 'gone', new Set())).toEqual([])
    expect(buildSubagentSelectionOps(null, 'gone')).toEqual([])
    expect(buildSubagentSelectionOps({ allowedModels: [{ provider: 'kept', model: 'k' }] }, 'gone')).toEqual([])
    expect(buildSubagentSelectionOps({ enabled: false, allowedModels: [{ provider: 'gone', model: 'm' }] }, 'gone')).toEqual([
      { op: 'set', path: ['allowedModels'], value: [] },
    ])
    expect(buildSubagentSelectionOps({ enabled: true, allowedModels: [{ provider: 'gone', model: 'm' }] }, 'gone')).toEqual([
      { op: 'set', path: ['allowedModels'], value: [] },
      { op: 'set', path: ['enabled'], value: false },
    ])
  })
})

describe('cleanupFailureText', () => {
  it('shows the host message verbatim when present', () => {
    expect(cleanupFailureText(translateEn, { code: 'rejected', message: 'host detail' })).toBe('host detail')
  })

  it('falls back to the machine code without a translate seat', () => {
    expect(cleanupFailureText(undefined, { code: 'timeout' })).toBe('timeout')
  })

  it('maps every cause code to its dictionary copy', () => {
    expect(cleanupFailureText(translateEn, { code: 'unavailable' })).toBe(en.cleanupUnavailable)
    expect(cleanupFailureText(translateEn, { code: 'conflict' })).toBe(en.cleanupConflict)
    expect(cleanupFailureText(translateEn, { code: 'timeout' })).toBe(en.cleanupTimeout)
    expect(cleanupFailureText(translateEn, { code: 'rejected' })).toBe(en.cleanupRejected)
  })
})

describe('removeProviderProfile cleanup wiring', () => {
  /** The helper's face over a scripted settings face. */
  function profileFace(scripted: ReturnType<typeof settingsFace>, t?: typeof translateEn) {
    return {
      api: {
        settings: scripted.api.settings,
        credentials: { unset: vi.fn(() => Promise.resolve(ok(undefined))) },
      },
      ...t === undefined ? {} : { t },
    } as unknown as Parameters<typeof removeProviderProfile>[0]
  }

  it('reports the cleanup failure before any route write', async () => {
    const scripted = settingsFace(fullDocs())
    scripted.mutate
      .mockResolvedValueOnce(refuse('cleanup refused') as never)
    const failure = await removeProviderProfile(
      profileFace(scripted, translateEn),
      undefined as never,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gone'], provider: 'gone' },
    )
    // The cleanup runs first and fails: the route write never happened, so
    // the route is still alive and the retry can clean up again.
    expect(failure).toBe('cleanup refused')
    expect(scripted.mutate).toHaveBeenCalledTimes(1)
    expect(scripted.mutate.mock.calls[0]![0]).toBe(ORCHESTRATION_NS)
  })

  it('derives the removed route from the profile path, then unsets the route', async () => {
    const scripted = settingsFace(fullDocs())
    const failure = await removeProviderProfile(
      profileFace(scripted),
      undefined as never,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gone'] },
    )
    expect(failure).toBeNull()
    expect(scripted.mutate).toHaveBeenCalledTimes(4)
    // Cleanup namespaces first, then the route unset on the profile namespace.
    expect(scripted.mutate.mock.calls[0]![0]).toBe(ORCHESTRATION_NS)
    expect(scripted.mutate.mock.calls[3]![0]).toBe('llm-pi-ai')
  })

  it('returns the machine code when no translate seat is bound', async () => {
    const scripted = settingsFace(fullDocs())
    scripted.mutate
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(refuse('') as never)
    const failure = await removeProviderProfile(
      profileFace(scripted),
      undefined as never,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gone'], provider: 'gone' },
    )
    expect(failure).toBe('rejected')
  })
})
