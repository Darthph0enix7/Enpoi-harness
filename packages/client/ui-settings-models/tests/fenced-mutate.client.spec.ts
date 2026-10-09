// @vitest-environment jsdom
/**
 * The shared revision-fenced write: one describe per attempt, the fresh
 * revision as the write fence, replanning after each conflict, a bounded
 * retry count, and localized failure text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ModelsWire } from '../src/client/store.ts'
import { MAX_GROUP_WRITE_RETRIES } from '../src/client/model-groups.ts'
import { applyFenced, fencedFailureText, type FencedPlan } from '../src/client/fenced-mutate.ts'
import { WRITE_TIMEOUT_MS } from '../src/client/write-timeout.ts'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.client.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** One scripted namespace view. */
function namespace(revision: number, value: JsonValue = {}): SettingsNamespaceView {
  return { ns: 'llm-pi-ai', schema: {}, value, autoGenerate: true, applies: 'live', secrets: [], revision }
}

/** One successful Remote answer. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One conflict refusal carrying the conflict details. */
function conflict(message = 'stale') {
  return { ok: false as const, error: new RemoteError('settings/conflict', message, { ns: 'llm-pi-ai', expected: 1, actual: 2 }) }
}

/** One non-conflict refusal. */
function rejected(message = '') {
  return { ok: false as const, error: new RemoteError('settings/rejected', message, { ns: 'llm-pi-ai' }) }
}

/** A settings face over scripted describe/mutate mocks. */
function face(describe: ReturnType<typeof vi.fn>, mutate: ReturnType<typeof vi.fn>): Pick<ModelsWire, 'settings'> {
  return { settings: { describe, mutate } as unknown as Pick<ModelsWire, 'settings'>['settings'] }
}

/** A describe that answers a fresh revision on every call, starting at 1. */
function movingDescribe(): ReturnType<typeof vi.fn> {
  let revision = 1
  return vi.fn(async () => ok({ writable: true, hasDocument: false, namespaces: [namespace(revision++)] }))
}

describe('applyFenced', () => {
  it('describes once, plans from the fresh view, and writes with the read revision', async () => {
    const describe = vi.fn(async () => ok({ writable: true, hasDocument: false, namespaces: [namespace(7)] }))
    const mutate = vi.fn(async () => ok(undefined))
    const plan = vi.fn((_view?: SettingsNamespaceView): FencedPlan => ({
      ops: [{ op: 'set', path: ['a'], value: 1 }],
      labels: ['wrote a'],
    }))

    const outcome = await applyFenced(face(describe, mutate), 'llm-pi-ai', plan)

    expect(outcome).toEqual({ error: null, labels: ['wrote a'] })
    expect(plan).toHaveBeenCalledTimes(1)
    expect((plan.mock.calls as unknown as Array<[SettingsNamespaceView | undefined]>)[0]?.[0]).toMatchObject({ revision: 7 })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0]).toEqual(['llm-pi-ai', [{ op: 'set', path: ['a'], value: 1 }], 7])
  })

  it('re-reads and replans after each conflict, writing the fresh revision', async () => {
    const describe = movingDescribe()
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflict())
      .mockResolvedValue(ok(undefined))
    const plan = vi.fn((view?: SettingsNamespaceView): FencedPlan => ({
      ops: [{ op: 'set', path: ['a'], value: view?.revision ?? -1 }],
    }))

    const outcome = await applyFenced(face(describe, mutate), 'llm-pi-ai', plan)

    expect(outcome.error).toBeNull()
    expect(plan).toHaveBeenCalledTimes(2)
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls.map(call => call[2])).toEqual([1, 2])
    // The retry carries the replanned value, not the stale first draft.
    expect(mutate.mock.calls[1]![1]).toEqual([{ op: 'set', path: ['a'], value: 2 }])
  })

  it('stops after the bounded retries and reports the exhausted conflict', async () => {
    const describe = movingDescribe()
    const mutate = vi.fn(async () => conflict('busy'))

    const outcome = await applyFenced(face(describe, mutate), 'llm-pi-ai', () => ({
      ops: [{ op: 'set', path: ['a'], value: 1 }],
    }))

    expect(outcome).toEqual({ error: { code: 'conflict' }, labels: [] })
    expect(mutate).toHaveBeenCalledTimes(MAX_GROUP_WRITE_RETRIES + 1)
    expect(describe).toHaveBeenCalledTimes(MAX_GROUP_WRITE_RETRIES + 1)
  })

  it('reports an unavailable describe without mutating', async () => {
    const describe = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }))
    const mutate = vi.fn()

    const outcome = await applyFenced(face(describe, mutate), 'llm-pi-ai', () => ({
      ops: [{ op: 'set', path: ['a'], value: 1 }],
    }))

    expect(outcome.error).toEqual({ code: 'unavailable', message: 'offline' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reports a non-conflict refusal without retrying', async () => {
    const describe = movingDescribe()
    const mutate = vi.fn(async () => rejected())

    const outcome = await applyFenced(face(describe, mutate), 'llm-pi-ai', () => ({
      ops: [{ op: 'set', path: ['a'], value: 1 }],
    }))

    expect(outcome.error).toEqual({ code: 'rejected' })
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the plan holds no operations', async () => {
    const describe = movingDescribe()
    const mutate = vi.fn()

    const outcome = await applyFenced(face(describe, mutate), 'llm-pi-ai', () => ({ ops: [] }))

    expect(outcome).toEqual({ error: null, labels: [] })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('bounds a never-settling write with the write timeout', async () => {
    vi.useFakeTimers()
    const describe = movingDescribe()
    const mutate = vi.fn(() => new Promise(() => {}))

    const pending = applyFenced(face(describe, mutate), 'llm-pi-ai', () => ({
      ops: [{ op: 'set', path: ['a'], value: 1 }],
    }))
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS)

    expect(await pending).toEqual({ error: { code: 'timeout' }, labels: [] })
  })
})

describe('fencedFailureText', () => {
  it('shows the host diagnostic verbatim when present', () => {
    expect(fencedFailureText(translateEn, { code: 'rejected', message: 'host detail' })).toBe('host detail')
  })

  it('falls back to the machine code without a translate seat', () => {
    expect(fencedFailureText(undefined, { code: 'conflict' })).toBe('conflict')
  })

  it('maps every cause code to its dictionary copy', () => {
    expect(fencedFailureText(translateEn, { code: 'unavailable' })).toBe(en.cleanupUnavailable)
    expect(fencedFailureText(translateEn, { code: 'conflict' })).toBe(en.cleanupConflict)
    expect(fencedFailureText(translateEn, { code: 'timeout' })).toBe(en.cleanupTimeout)
    expect(fencedFailureText(translateEn, { code: 'rejected' })).toBe(en.cleanupRejected)
  })
})
