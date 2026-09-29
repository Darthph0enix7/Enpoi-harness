import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SystemAnalysisStore,
  clampPct,
  systemAnalysisApi,
  type SystemAnalysisApi,
  type SystemAnalysisRpcResult,
  type SystemAnalysisView,
} from '../src/client/system-analysis.ts'

/** One job view with the fields a test does not care about defaulted. */
function view(overrides: Partial<SystemAnalysisView> = {}): SystemAnalysisView {
  return {
    state: 'idle',
    stage: '',
    stageIndex: 0,
    stageCount: 9,
    pct: 0,
    hasProfile: false,
    decision: null,
    ...overrides,
  }
}

/** A fake host API whose answers each test scripts. */
function fakeApi(): {
  api: SystemAnalysisApi
  start: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  context: ReturnType<typeof vi.fn>
  accept: ReturnType<typeof vi.fn>
  reject: ReturnType<typeof vi.fn>
} {
  const start = vi.fn(async (): Promise<SystemAnalysisRpcResult<SystemAnalysisView>> => ({ ok: true, value: view({ state: 'running' }) }))
  const status = vi.fn(async (): Promise<SystemAnalysisRpcResult<SystemAnalysisView>> => ({ ok: true, value: view() }))
  const context = vi.fn(async (): Promise<SystemAnalysisRpcResult<string | null>> => ({ ok: true, value: '# System profile\n' }))
  const accept = vi.fn(async (): Promise<SystemAnalysisRpcResult<SystemAnalysisView>> => ({ ok: true, value: view({ hasProfile: true, decision: 'accepted' }) }))
  const reject = vi.fn(async (): Promise<SystemAnalysisRpcResult<SystemAnalysisView>> => ({ ok: true, value: view({ decision: 'rejected' }) }))
  return { api: { start, status, context, accept, reject }, start, status, context, accept, reject }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('analysis percentage', () => {
  it('clamps any value into the renderable 0 to 100', () => {
    expect(clampPct(0)).toBe(0)
    expect(clampPct(33.4)).toBe(33)
    expect(clampPct(420)).toBe(100)
    expect(clampPct(-20)).toBe(0)
    expect(clampPct(Number.NaN)).toBe(0)
  })

  it('clamps a percentage the host reports past 100 at the wire boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      job: { state: 'running', stage: 'tooling', stageIndex: 3, stageCount: 9, pct: 420, hasProfile: false, decision: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const result = await systemAnalysisApi.status()
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ pct: 100, stageIndex: 3 }) })
  })

  it('fills absent job fields with display defaults and drops invalid ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      job: { state: 'running', error: 'boom', decision: 'maybe' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    expect(await systemAnalysisApi.status()).toEqual({
      ok: true,
      value: { state: 'running', stage: '', stageIndex: 0, stageCount: 0, pct: 0, hasProfile: false, decision: null, error: 'boom' },
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      job: { state: 'succeeded', stageIndex: 3, stageCount: 9, pct: 33, hasProfile: true, decision: 'accepted' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    expect(await systemAnalysisApi.status()).toEqual({
      ok: true,
      value: { state: 'succeeded', stage: '', stageIndex: 3, stageCount: 9, pct: 33, hasProfile: true, decision: 'accepted' },
    })
  })

  it('classifies an unrecognized job envelope at the wire boundary', async () => {
    const respond = (body: unknown): void => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    }
    respond({ ok: true, job: 'nonsense' })
    expect(await systemAnalysisApi.status()).toEqual({ ok: false, failure: { kind: 'payload' } })
    respond({ ok: true, job: { state: 'weird' } })
    expect(await systemAnalysisApi.status()).toEqual({ ok: false, failure: { kind: 'payload' } })
    respond({ ok: false, message: 'the analysis request was rejected' })
    expect(await systemAnalysisApi.status()).toEqual({ ok: false, failure: { kind: 'rejected', message: 'the analysis request was rejected' } })
    respond({ ok: false })
    expect(await systemAnalysisApi.status()).toEqual({ ok: false, failure: { kind: 'rejected' } })
  })
})

describe('system-analysis store', () => {
  it('auto-starts on a machine with no profile and follows the run to ready', async () => {
    vi.useFakeTimers()
    const { api, start, status } = fakeApi()
    status.mockResolvedValueOnce({ ok: true, value: view() })
    start.mockResolvedValueOnce({ ok: true, value: view({ state: 'running', stage: 'hardware', stageIndex: 0, pct: 0 }) })
    status.mockResolvedValueOnce({ ok: true, value: view({ state: 'succeeded', hasProfile: true, stage: 'done', stageIndex: 9, pct: 100 }) })
    const store = new SystemAnalysisStore(api)
    await store.load()
    expect(start).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'running', stage: 'hardware' })
    await vi.advanceTimersByTimeAsync(300)
    expect(store.store.getSnapshot().phase).toBe('ready')
    store.dispose()
  })

  it('offers the decision for a stored profile and never auto-starts after a rejection', async () => {
    const stored = fakeApi()
    stored.status.mockResolvedValueOnce({ ok: true, value: view({ hasProfile: true }) })
    const ready = new SystemAnalysisStore(stored.api)
    await ready.load()
    expect(ready.store.getSnapshot().phase).toBe('ready')
    expect(stored.start).not.toHaveBeenCalled()

    const rejected = fakeApi()
    rejected.status.mockResolvedValueOnce({ ok: true, value: view({ decision: 'rejected' }) })
    const hidden = new SystemAnalysisStore(rejected.api)
    await hidden.load()
    expect(hidden.store.getSnapshot().phase).toBe('hidden')
    expect(rejected.start).not.toHaveBeenCalled()
  })

  it('re-runs a settled job whose document is gone', async () => {
    const { api, start, status } = fakeApi()
    status.mockResolvedValueOnce({ ok: true, value: view({ state: 'succeeded' }) })
    start.mockResolvedValueOnce({ ok: true, value: view({ state: 'running', stage: 'hardware' }) })
    const store = new SystemAnalysisStore(api)
    await store.load()
    expect(start).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().phase).toBe('running')
    store.dispose()
  })

  it('hides a stored profile whose decision was already recorded', async () => {
    const recorded = fakeApi()
    recorded.status.mockResolvedValueOnce({
      ok: true,
      value: view({ state: 'succeeded', hasProfile: true, decision: 'accepted', stage: 'done', stageIndex: 9, pct: 100 }),
    })
    const store = new SystemAnalysisStore(recorded.api)
    await store.load()
    expect(store.store.getSnapshot().phase).toBe('hidden')
    expect(recorded.start).not.toHaveBeenCalled()
  })

  it('never starts outside the first-run flow', async () => {
    const { api, start, status } = fakeApi()
    status.mockResolvedValueOnce({ ok: true, value: view() })
    const store = new SystemAnalysisStore(api, () => false)
    await store.load()
    expect(start).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().phase).toBe('hidden')
  })

  it('adopts a run already in flight and follows it to the decision', async () => {
    vi.useFakeTimers()
    const { api, start, status } = fakeApi()
    status.mockResolvedValueOnce({ ok: true, value: view({ state: 'running', stage: 'services', stageIndex: 2, pct: 22 }) })
    status.mockResolvedValueOnce({ ok: true, value: view({ state: 'succeeded', hasProfile: true, stage: 'done', stageIndex: 9, pct: 100 }) })
    const store = new SystemAnalysisStore(api)
    await store.load()
    expect(start).not.toHaveBeenCalled()
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'running', stage: 'services', pct: 22 })
    await vi.advanceTimersByTimeAsync(300)
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'ready', pct: 100 })
    store.dispose()
  })

  it('reports a status failure and a start failure in the chip', async () => {
    const statusFailure = fakeApi()
    statusFailure.status.mockResolvedValueOnce({ ok: false, failure: { kind: 'service', status: 500 } })
    const first = new SystemAnalysisStore(statusFailure.api)
    await first.load()
    expect(first.store.getSnapshot()).toMatchObject({ phase: 'failed', errorCode: 'service', error: null })

    const startFailure = fakeApi()
    startFailure.status.mockResolvedValueOnce({ ok: true, value: view() })
    startFailure.start.mockResolvedValueOnce({ ok: false, failure: { kind: 'rejected' } })
    const second = new SystemAnalysisStore(startFailure.api)
    await second.load()
    expect(second.store.getSnapshot()).toMatchObject({ phase: 'failed', errorCode: 'rejected', error: null })

    const transport = fakeApi()
    transport.status.mockResolvedValueOnce({ ok: false, failure: { kind: 'transport', message: 'Failed to fetch' } })
    const third = new SystemAnalysisStore(transport.api)
    await third.load()
    expect(third.store.getSnapshot()).toMatchObject({ phase: 'failed', errorCode: null, error: 'Failed to fetch' })
  })

  it('opens the results panel with the stored document and reports a read failure', async () => {
    const { api, context } = fakeApi()
    const store = new SystemAnalysisStore(api)
    await store.open()
    expect(store.store.getSnapshot()).toMatchObject({ open: true, text: '# System profile\n' })
    context.mockResolvedValueOnce({ ok: false, failure: { kind: 'service', status: 404 } })
    await store.open()
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'failed', open: false, errorCode: 'service' })
  })

  it('accepts, rejects, and dismisses by accepting only an open panel', async () => {
    const { api, accept, reject } = fakeApi()
    const store = new SystemAnalysisStore(api)
    await store.dismiss()
    expect(accept).not.toHaveBeenCalled()
    await store.open()
    await store.dismiss()
    expect(accept).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'hidden', open: false, text: null })

    await store.open()
    await store.reject()
    expect(reject).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().phase).toBe('hidden')
  })

  it('reports a refused decision and retries a failed run', async () => {
    const { api, accept, start } = fakeApi()
    const store = new SystemAnalysisStore(api)
    accept.mockResolvedValueOnce({ ok: false, failure: { kind: 'rejected', message: 'the analysis request was rejected' } })
    await store.accept()
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'failed', errorCode: 'rejected', error: 'the analysis request was rejected' })
    start.mockResolvedValueOnce({ ok: true, value: view({ state: 'running', stage: 'hardware' }) })
    await store.retry()
    expect(store.store.getSnapshot().phase).toBe('running')
    store.dispose()
  })

  it('stops polling once disposed', async () => {
    vi.useFakeTimers()
    const { api, status } = fakeApi()
    status.mockResolvedValue({ ok: true, value: view({ state: 'running', stage: 'hardware' }) })
    const store = new SystemAnalysisStore(api)
    await store.start()
    expect(store.store.getSnapshot().phase).toBe('running')
    store.dispose()
    const calls = status.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(status.mock.calls.length).toBe(calls)
  })

  it('keeps one poll when start is called again on a live run', async () => {
    vi.useFakeTimers()
    const { api, status } = fakeApi()
    status.mockResolvedValue({ ok: true, value: view({ state: 'running', stage: 'hardware' }) })
    const store = new SystemAnalysisStore(api)
    await store.start()
    await store.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(status).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('keeps a settled start without following it', async () => {
    vi.useFakeTimers()
    const { api, start, status } = fakeApi()
    start.mockResolvedValueOnce({
      ok: true,
      value: view({ state: 'succeeded', hasProfile: true, stage: 'done', stageIndex: 9, pct: 100 }),
    })
    const store = new SystemAnalysisStore(api)
    await store.start()
    expect(store.store.getSnapshot().phase).toBe('ready')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(status).not.toHaveBeenCalled()
  })

  it('ignores a failed poll and settles on the failed run that follows it', async () => {
    vi.useFakeTimers()
    const { api, status } = fakeApi()
    status.mockResolvedValueOnce({ ok: false, failure: { kind: 'service', status: 500 } })
    status.mockResolvedValueOnce({ ok: true, value: view({ state: 'failed', stage: 'failed', error: 'route refused' }) })
    const store = new SystemAnalysisStore(api)
    await store.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(store.store.getSnapshot().phase).toBe('running')
    await vi.advanceTimersByTimeAsync(300)
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'failed', error: 'route refused' })
    const calls = status.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(status.mock.calls.length).toBe(calls)
  })

  it('reports a refused reject decision', async () => {
    const { api, reject } = fakeApi()
    reject.mockResolvedValueOnce({ ok: false, failure: { kind: 'rejected', message: 'nope' } })
    const store = new SystemAnalysisStore(api)
    await store.reject()
    expect(store.store.getSnapshot()).toMatchObject({ phase: 'failed', error: 'nope' })
  })

  it('calls every host route through the API face and classifies a service failure', async () => {
    const respond = (body: unknown, status = 200): void => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))
    }
    respond({ ok: true, job: { state: 'running' } })
    expect(await systemAnalysisApi.start()).toEqual({ ok: true, value: expect.objectContaining({ state: 'running' }) })
    expect(await systemAnalysisApi.accept()).toEqual({ ok: true, value: expect.objectContaining({ state: 'running' }) })
    expect(await systemAnalysisApi.reject()).toEqual({ ok: true, value: expect.objectContaining({ state: 'running' }) })
    respond({ ok: true, text: '# profile' })
    expect(await systemAnalysisApi.context()).toEqual({ ok: true, value: '# profile' })
    respond({ ok: true, text: 42 })
    expect(await systemAnalysisApi.context()).toEqual({ ok: true, value: null })
    respond({ ok: false })
    expect(await systemAnalysisApi.context()).toEqual({ ok: false, failure: { kind: 'rejected' } })
    respond({ ok: false, message: 'no' })
    expect(await systemAnalysisApi.context()).toEqual({ ok: false, failure: { kind: 'rejected', message: 'no' } })
    respond({}, 503)
    expect(await systemAnalysisApi.status()).toEqual({ ok: false, failure: { kind: 'service', status: 503 } })
    expect(await systemAnalysisApi.context()).toEqual({ ok: false, failure: { kind: 'service', status: 503 } })
  })

  it('reports a transport failure when a route cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await systemAnalysisApi.context()).toEqual({ ok: false, failure: { kind: 'transport', message: 'offline' } })
    expect(await systemAnalysisApi.start()).toEqual({ ok: false, failure: { kind: 'transport', message: 'offline' } })
  })
})
