/** Host durability of the column width record: hydrate precedence and debounced mirrors. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostWidthSync, readHostWidths } from '../src/client/width-sync.ts'

type Call = { method: string; args: Record<string, unknown> }

let calls: Call[]
let failure: 'none' | 'unreachable' | 'rejected' | 'denied'

/** Flush the promise chains a stubbed fetch resolves. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

function jsonResponse(value: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => (ok ? { result: { ok: true, value } } : {}),
  } as Response
}

const stored = { sidebar: 320, rightbar: { px: 720, ratio: 0.375 }, updatedAt: 7 }

beforeEach(() => {
  calls = []
  failure = 'none'
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { method: string; payload: { args: Record<string, unknown> } }
    calls.push({ method: body.method, args: body.payload.args })
    if (failure === 'unreachable') throw new Error('offline')
    if (failure === 'rejected') return jsonResponse(null, false)
    if (failure === 'denied') {
      return { ok: true, status: 200, json: async () => ({ result: { ok: false, error: { message: 'denied' } } }) } as Response
    }
    return jsonResponse(body.method === 'enpoiUiState.getLayout' ? stored : { ok: true, updatedAt: 8 })
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('readHostWidths', () => {
  it('accepts a stored record and drops the server stamp from the widths', () => {
    expect(readHostWidths(stored)).toEqual({ sidebar: 320, rightbar: { px: 720, ratio: 0.375 } })
    expect(readHostWidths({ sidebar: 280, updatedAt: 3 })).toEqual({ sidebar: 280, rightbar: null })
  })

  it('treats "nothing stored" and malformed records as absent', () => {
    for (const value of [
      null, 42, 'layout', [],
      { sidebar: 0, updatedAt: 0 },
      { sidebar: 0 },
      { sidebar: 'wide', updatedAt: 1 },
      { sidebar: -1, updatedAt: 1 },
      { sidebar: 280, rightbar: 'wide', updatedAt: 1 },
      { sidebar: 280, rightbar: { px: 0, ratio: 0.3 }, updatedAt: 1 },
      { sidebar: 280, rightbar: { px: 'wide', ratio: 0.3 }, updatedAt: 1 },
      { sidebar: 280, rightbar: { px: 500, ratio: 0 }, updatedAt: 1 },
      { sidebar: 280, rightbar: { px: 500, ratio: 2 }, updatedAt: 1 },
      { sidebar: 280, updatedAt: Number.NaN },
      { sidebar: Number.POSITIVE_INFINITY, updatedAt: 1 },
      { sidebar: 280, rightbar: { px: Number.POSITIVE_INFINITY, ratio: 0.3 }, updatedAt: 1 },
      { sidebar: 280, rightbar: { px: 500, ratio: Number.NaN }, updatedAt: 1 },
    ]) {
      expect(readHostWidths(value)).toBeNull()
    }
  })
})

describe('createHostWidthSync', () => {
  it('adopts the host record once it arrives', async () => {
    const adopt = vi.fn()
    const sync = createHostWidthSync()
    sync.hydrate(adopt)
    await flush()
    expect(calls.map(call => call.method)).toEqual(['enpoiUiState.getLayout'])
    expect(adopt).toHaveBeenCalledWith({ sidebar: 320, rightbar: { px: 720, ratio: 0.375 } })
    sync.dispose()
  })

  it('leaves the local cache in force when the host read fails or holds nothing', async () => {
    const failed = vi.fn()
    failure = 'unreachable'
    const first = createHostWidthSync()
    first.hydrate(failed)
    await flush()
    expect(failed).not.toHaveBeenCalled()
    first.dispose()

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ sidebar: 0, updatedAt: 0 })))
    const empty = vi.fn()
    const second = createHostWidthSync()
    second.hydrate(empty)
    await flush()
    expect(empty).not.toHaveBeenCalled()
    second.dispose()
  })

  it('ignores a late read or a rejection from the gateway', async () => {
    const late = vi.fn()
    const disposed = createHostWidthSync()
    disposed.hydrate(late)
    disposed.dispose()
    await flush()
    expect(late).not.toHaveBeenCalled()

    failure = 'denied'
    const denied = vi.fn()
    const rejected = createHostWidthSync()
    rejected.hydrate(denied)
    await flush()
    expect(denied).not.toHaveBeenCalled()
    rejected.dispose()
  })

  it('does not re-adopt the record it just pushed', async () => {
    vi.useFakeTimers()
    const adopt = vi.fn()
    const sync = createHostWidthSync()
    const pushed = { sidebar: 320, rightbar: { px: 720, ratio: 0.375 } }
    sync.mirror(pushed)
    await vi.advanceTimersByTimeAsync(500)
    // The host now answers with exactly that record; the store already holds it.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...pushed, updatedAt: 9 })))
    sync.hydrate(adopt)
    await flush()
    expect(adopt).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('does nothing when the browser has no fetch', () => {
    vi.stubGlobal('fetch', undefined)
    const adopt = vi.fn()
    const sync = createHostWidthSync()
    sync.hydrate(adopt)
    expect(adopt).not.toHaveBeenCalled()
    sync.dispose()
  })

  it('collapses a burst of gestures into one write of the last record', async () => {
    vi.useFakeTimers()
    const sync = createHostWidthSync()
    sync.mirror({ sidebar: 320, rightbar: { px: 700, ratio: 0.36 } })
    sync.mirror({ sidebar: 360, rightbar: { px: 700, ratio: 0.36 } })
    sync.mirror({ sidebar: 360, rightbar: { px: 720, ratio: 0.375 } })
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual([{ method: 'enpoiUiState.putLayout', args: { widths: { sidebar: 360, rightbar: { px: 720, ratio: 0.375 } } } }])
    // An identical record is not rewritten.
    sync.mirror({ sidebar: 360, rightbar: { px: 720, ratio: 0.375 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toHaveLength(1)
    sync.dispose()
  })

  it('retries the next gesture after a failed write without spamming the log', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    failure = 'unreachable'
    const sync = createHostWidthSync()
    sync.mirror({ sidebar: 360, rightbar: { px: 720, ratio: 0.375 } })
    await vi.advanceTimersByTimeAsync(500)
    sync.mirror({ sidebar: 360, rightbar: { px: 720, ratio: 0.375 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(error).toHaveBeenCalledTimes(1)
    failure = 'none'
    sync.mirror({ sidebar: 380, rightbar: { px: 720, ratio: 0.375 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.filter(call => call.method === 'enpoiUiState.putLayout')).toHaveLength(3)
    sync.dispose()
  })

  it('stays quiet when a write settles after teardown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let settle: ((response: Response) => void) | undefined
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const sync = createHostWidthSync()
    sync.mirror({ sidebar: 360, rightbar: null })
    await vi.advanceTimersByTimeAsync(500)
    sync.dispose()
    settle?.(jsonResponse(null, false))
    await flush()
    expect(error).not.toHaveBeenCalled()
  })

  it('does not write after dispose', async () => {
    vi.useFakeTimers()
    const sync = createHostWidthSync()
    sync.mirror({ sidebar: 360, rightbar: null })
    sync.dispose()
    await vi.advanceTimersByTimeAsync(500)
    sync.mirror({ sidebar: 380, rightbar: null })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual([])
  })
})
