import { describe, expect, it, vi } from 'vitest'
import {
  WIZARD_COMPLETED_FIELD, WIZARD_VERSION, WelcomeWizardStore, initialWizardState,
  intelligenceWrites, sandboxWrite, skippedSteps, skipWholeTour, wizardReducer,
  type WizardScope, type WizardScopeSnapshot,
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

  it('writes the sandbox preset through the real namespace', () => {
    expect(sandboxWrite('read-only')).toEqual({
      ns: 'permission-presets',
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

const idleAnalysis = {
  start: async () => ({ ok: true as const, value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 6, pct: 0 } }),
  status: async () => ({ ok: true as const, value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 6, pct: 0 } }),
}

describe('welcome wizard gating', () => {
  it('shows on a fresh document and hides once the marker version matches', async () => {
    const fresh = new WelcomeWizardStore(scope({ mode: 'host', status: 'ready', value: {} }), idleAnalysis)
    await fresh.load()
    expect(fresh.store.getSnapshot().visible).toBe(true)

    const done = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: { [WIZARD_COMPLETED_FIELD]: WIZARD_VERSION } }),
      idleAnalysis,
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
    )
    await store.load()
    await expect(store.finish()).resolves.toBe(false)
    expect(set).toHaveBeenCalledWith(WIZARD_COMPLETED_FIELD, WIZARD_VERSION)
    expect(store.store.getSnapshot().visible).toBe(true)
    expect(store.store.getSnapshot().error).toBe('the setup completion did not persist')
    store.dispose()
  })

  it('reopens after the marker when the Setup entry asks', async () => {
    const store = new WelcomeWizardStore(
      scope({ mode: 'host', status: 'ready', value: { [WIZARD_COMPLETED_FIELD]: WIZARD_VERSION } }),
      idleAnalysis,
    )
    await store.load()
    store.reopen()
    expect(store.store.getSnapshot().visible).toBe(true)
    expect(store.store.getSnapshot().wizard.step).toBe('welcome')
    store.close()
    expect(store.store.getSnapshot().visible).toBe(false)
    store.dispose()
  })

  it('treats an unmounted settings namespace as no overlay, never as a block', async () => {
    const store = new WelcomeWizardStore(scope({ mode: 'host', status: 'unavailable' }), idleAnalysis)
    await store.load()
    expect(store.store.getSnapshot().visible).toBe(false)
    expect(store.store.getSnapshot().status).toBe('error')
    store.dispose()
  })
})
