import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SystemAnalysisStore,
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
})
