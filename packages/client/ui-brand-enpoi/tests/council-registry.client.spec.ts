// @vitest-environment jsdom
/**
 * Council registry store (`enpoiCouncil.list`): parses the live council shape
 * into seats and arbiters, shares one in-flight read with a trailing read for a
 * trigger that arrives mid-read, and reuses a fresh snapshot on mount while a
 * failed read stays retryable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** One `enpoiCouncil.list` envelope. */
function councilResponse(councils: unknown[]): Response {
  return new Response(JSON.stringify({ result: { ok: true, value: { councils } } }), { status: 200 })
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('council registry store', () => {
  it('parses seats and arbiters into the snapshot and notifies subscribers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => councilResponse([
      {
        id: 'roundtable',
        label: 'Architecture Roundtable',
        seats: [
          { id: 'skeptic', label: 'Skeptic' },
          { id: 'architect', label: 'Architect', family: 'reasoning' },
          'junk',
          { label: 'no id' },
        ],
        arbiters: ['referee', 7, 'chair'],
        enabled: true,
      },
      { id: 'empty', seatCount: 0 },
      { label: 'no id' },
      'nope',
    ])))
    const store = await import('../src/client/CapabilitiesBody.tsx')
    const listener = vi.fn()
    const unsubscribe = store.subscribeCouncilRegistry(listener)

    await store.refreshCouncils()

    expect(store.getCouncilRegistry()).toEqual([
      {
        id: 'roundtable',
        label: 'Architecture Roundtable',
        seats: [
          { id: 'skeptic', label: 'Skeptic' },
          { id: 'architect', label: 'Architect', family: 'reasoning' },
        ],
        arbiters: ['referee', 'chair'],
        enabled: true,
      },
      { id: 'empty', seatCount: 0 },
    ])
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('shares one in-flight read and runs a trailing read for a mid-flight trigger', async () => {
    const fetchMock = vi.fn(async () => {
      // The first answer stays in flight long enough for the second call to
      // arrive inside it; the trailing read is the trigger not being swallowed.
      if (fetchMock.mock.calls.length === 1) await new Promise(resolve => setTimeout(resolve, 10))
      return councilResponse([{ id: 'roundtable', label: 'Architecture Roundtable', seats: [], arbiters: [] }])
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/CapabilitiesBody.tsx')

    const first = store.refreshCouncils()
    const second = store.refreshCouncils()
    await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.getCouncilRegistry()).toHaveLength(1)
  })

  it('reuses a fresh snapshot on mount and re-reads once the window elapsed', async () => {
    const fetchMock = vi.fn(async () => councilResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/CapabilitiesBody.tsx')

    await store.refreshCouncils()
    store.ensureCouncilsFresh(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    store.ensureCouncilsFresh(0)
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
  })

  it('keeps a failed read retryable on the next mount', async () => {
    const fetchMock = vi.fn(async () => new Response('offline', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/CapabilitiesBody.tsx')

    await store.refreshCouncils()
    store.ensureCouncilsFresh(10_000)

    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    expect(store.getCouncilRegistry()).toEqual([])
  })
})
