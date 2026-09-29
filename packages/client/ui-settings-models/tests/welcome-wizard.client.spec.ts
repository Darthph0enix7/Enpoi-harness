import { describe, expect, it, vi } from 'vitest'
import {
  WIZARD_COMPLETED_FIELD, WIZARD_VERSION, WelcomeWizardStore, initialWizardState,
  intelligenceWrites, sandboxWrite, skippedSteps, skipWholeTour, wizardReducer,
  type WizardAnalysisView, type WizardScope, type WizardScopeSnapshot,
} from '../src/client/welcome-wizard.ts'

describe('welcome wizard state machine', () => {
  it('advances with continue, marking the left step at its default', () => {
    const first = wizardReducer(initialWizardState(), { type: 'continue' })
    expect(first.step).toBe('security')
    expect(first.states.welcome).toBe('default')
  })

  it('marks explicit skips and never downgrades a configured step', () => {
    let state = wizardReducer(initialWizardState(), { type: 'configured' })
    state = wizardReducer(state, { type: 'skip' })
    expect(state.step).toBe('security')
    expect(state.states.welcome).toBe('configured')

    state = wizardReducer(state, { type: 'skip' })
    expect(state.states.security).toBe('skipped')
    expect(skippedSteps(state)).toEqual(['security'])
  })

  it('skips the whole tour from the welcome step: steps 2 to 6 skipped', () => {
    const state = skipWholeTour()
    expect(state.step).toBe('done')
    expect(skippedSteps(state)).toEqual(['security', 'provider', 'intelligence', 'tour', 'agents'])
  })

  it('restarts to the initial state', () => {
    const dirty = wizardReducer(initialWizardState(), { type: 'skip' })
    expect(wizardReducer(dirty, { type: 'restart' })).toEqual(initialWizardState())
  })

  it('writes the sandbox preset through the profile entry namespace', () => {
    expect(sandboxWrite('read-only')).toEqual({
      ns: 'permission',
      ops: [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }],
    })
  })

  it('writes the background helpers with the Kilo free seats, never the main model', () => {
    const writes = intelligenceWrites({ compaction: true, keeper: true, whiteboard: true })
    expect(writes.map(write => write.ns)).toEqual(['enpoi-orchestration', 'enpoi-orchestration', 'enpoi-orchestration', 'enpoi-orchestration'])
    expect(writes[2]?.ops).toEqual([{
      op: 'set', path: ['personas', 'compaction'], value: { provider: 'kilo', model: 'kilo-auto/free' },
    }])
    expect(writes[3]?.ops).toEqual([{
      op: 'set', path: ['personas', 'keeper'], value: { provider: 'kilo', model: 'kilo-auto/free' },
    }])
  })

  it('clears the compaction seat when the helper is switched off', () => {
    const writes = intelligenceWrites({ compaction: false, keeper: true, whiteboard: false })
    expect(writes[1]?.ops).toEqual([{ op: 'set', path: ['toolGroups', 'groups', 'whiteboard', 'enabled'], value: false }])
    expect(writes[2]?.ops).toEqual([{ op: 'unset', path: ['personas', 'compaction'] }])
    expect(writes).toHaveLength(4)
  })
})

/** A scope whose answer the test controls. */
function scope(snapshot: WizardScopeSnapshot, set = vi.fn(async () => true)): WizardScope {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set,
  }
}

/** Third constructor argument for specs that never reopen the wizard. */
const noRequest = (): void => {}

const idleAnalysis = {
  start: async () => ({ ok: true as const, value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 6, pct: 0 } }),
  status: async () => ({ ok: true as const, value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 6, pct: 0 } }),
}

describe('welcome wizard gating', () => {
  it('shows on a fresh document and hides once the marker version matches', async () => {
    const fresh = new WelcomeWizardStore(scope({ mode: 'host', status: 'ready', value: {} }), idleAnalysis, noRequest)
    await fresh.load()
    expect(fresh.store.getSnapshot().visible).toBe(true)

    const done = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: { [WIZARD_COMPLETED_FIELD]: WIZARD_VERSION } }),
      idleAnalysis,
      noRequest,
    )
    await done.load()
    expect(done.store.getSnapshot().completed).toBe(true)
    expect(done.store.getSnapshot().visible).toBe(false)
    fresh.dispose()
    done.dispose()
  })

  it('writes the completion marker and keeps the overlay on a refused write', async () => {
    const set = vi.fn(async () => false)
    const store = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: {} }, set),
      idleAnalysis,
      noRequest,
    )
    await store.load()
    await expect(store.finish()).resolves.toBe(false)
    expect(set).toHaveBeenCalledWith(WIZARD_COMPLETED_FIELD, WIZARD_VERSION)
    expect(store.store.getSnapshot().visible).toBe(true)
    expect(store.store.getSnapshot().error).toBe('the setup completion did not persist')
    store.dispose()
  })

  it('reopens after the marker when the Setup entry asks, raising the shell request', async () => {
    const requestOnboarding = vi.fn()
    const store = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: { [WIZARD_COMPLETED_FIELD]: WIZARD_VERSION } }),
      idleAnalysis,
      requestOnboarding,
    )
    await store.load()
    await store.reopen()
    expect(store.store.getSnapshot().reopened).toBe(true)
    expect(store.store.getSnapshot().visible).toBe(true)
    expect(store.store.getSnapshot().wizard.step).toBe('welcome')
    expect(requestOnboarding).toHaveBeenCalledOnce()
    store.close()
    expect(store.store.getSnapshot().visible).toBe(false)
    store.dispose()
  })

  it('refreshes the analysis on reopen, so a settled run from before the restart does not persist', async () => {
    const succeeded: WizardAnalysisView = { state: 'succeeded', stage: 'done', stageIndex: 8, stageCount: 8, pct: 100 }
    const status = vi.fn(async () => ({
      ok: true as const,
      value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 8, pct: 0 },
    }))
    const store = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: {} }),
      { start: async () => ({ ok: true as const, value: succeeded }), status },
      noRequest,
    )
    await store.load()
    await store.startAnalysis()
    expect(store.store.getSnapshot().analysis?.state).toBe('succeeded')
    // A reject (or a host restart) settles the runner at idle: the reopened
    // step must offer Investigate and Skip again, not a Continue over a run
    // that no longer exists.
    await store.reopen()
    expect(status).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().analysis).toBeNull()
    store.dispose()
  })

  it('adopts a live host run view on reopen', async () => {
    const running: WizardAnalysisView = { state: 'running', stage: 'machine', stageIndex: 0, stageCount: 8, pct: 0 }
    const status = vi.fn(async () => ({ ok: true as const, value: running }))
    const store = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: {} }),
      { start: async () => ({ ok: true as const, value: running }), status },
      noRequest,
    )
    await store.load()
    await store.reopen()
    expect(store.store.getSnapshot().analysis).toMatchObject({ state: 'running', stage: 'machine' })
    store.dispose()
  })

  it('clears a stale analysis when the reopen status read fails', async () => {
    const succeeded: WizardAnalysisView = { state: 'succeeded', stage: 'done', stageIndex: 8, stageCount: 8, pct: 100 }
    const status = vi.fn(async () => ({ ok: false as const, message: 'offline' }))
    const store = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: {} }),
      { start: async () => ({ ok: true as const, value: succeeded }), status },
      noRequest,
    )
    await store.load()
    await store.startAnalysis()
    await store.reopen()
    expect(store.store.getSnapshot().analysis).toBeNull()
    store.dispose()
  })

  it('clears the analysis when a poll finds the host settled at idle', async () => {
    const running: WizardAnalysisView = { state: 'running', stage: 'machine', stageIndex: 0, stageCount: 8, pct: 0 }
    const status = vi.fn(async () => ({
      ok: true as const,
      value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 8, pct: 0 },
    }))
    const store = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: {} }),
      { start: async () => ({ ok: true as const, value: running }), status },
      noRequest,
    )
    vi.useFakeTimers()
    try {
      await store.load()
      await store.startAnalysis()
      expect(store.store.getSnapshot().analysis?.state).toBe('running')
      // A host restart mid-run: the next poll reads idle, so the step must
      // fall back to the offer instead of painting the idle view as a failure.
      await vi.advanceTimersByTimeAsync(300)
      expect(store.store.getSnapshot().analysis).toBeNull()
      expect(status).toHaveBeenCalledTimes(1)
    } finally {
      store.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps a refused step write on its own step and clears it on navigation', async () => {
    const store = new WelcomeWizardStore(scope({ mode: 'host', status: 'ready', value: {} }), idleAnalysis, noRequest)
    await store.load()
    store.dispatch({ type: 'continue' })
    store.noteWriteFailure('security', 'refused')
    expect(store.store.getSnapshot().writeFailure).toEqual({ step: 'security', message: 'refused' })

    store.dispatch({ type: 'goto', step: 'provider' })
    expect(store.store.getSnapshot().writeFailure).toBeNull()
    store.dispose()
  })

  it('treats an unmounted settings namespace as no overlay, never as a block', async () => {
    const store = new WelcomeWizardStore(scope({ mode: 'host', status: 'unavailable' }), idleAnalysis, noRequest)
    await store.load()
    expect(store.store.getSnapshot().visible).toBe(false)
    expect(store.store.getSnapshot().status).toBe('error')
    store.dispose()
  })

  it('treats a memory scope as a first run and resolves load immediately', async () => {
    const store = new WelcomeWizardStore(scope({ mode: 'memory', status: 'ready' }), idleAnalysis, noRequest)
    await store.load()
    expect(store.store.getSnapshot().visible).toBe(true)
    store.dispose()
  })

  it('resolves load only after the marker scope leaves its loading state', async () => {
    const snapshot: WizardScopeSnapshot = { mode: 'host', status: 'loading' }
    const listeners = new Set<() => void>()
    const loading: WizardScope = {
      getSnapshot: () => snapshot,
      subscribe: (next) => { listeners.add(next); return () => { listeners.delete(next) } },
      set: async () => true,
    }
    const store = new WelcomeWizardStore(loading, idleAnalysis, noRequest)
    let settled = false
    const pending = store.load().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    snapshot.status = 'ready'
    snapshot.value = {}
    for (const listener of [...listeners]) listener()
    await pending
    expect(store.store.getSnapshot().visible).toBe(true)
    store.dispose()
  })
})
