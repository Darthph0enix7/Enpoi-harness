// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSettingsSchemaOperations } from '../src/client/schema-operations.ts'
import { WelcomeWizard } from '../src/client/WelcomeWizard.tsx'
import type { WelcomeWizardProps } from '../src/client/WelcomeWizard.tsx'
import { WelcomeWizardStore, WIZARD_COMPLETED_FIELD, WIZARD_VERSION, type WizardScope, type WizardScopeSnapshot } from '../src/client/welcome-wizard.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import type { ModelsSettingsState } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const unusedHook = (() => { throw new Error('unused standard hook') }) as never
const noAttention = new Map() as Parameters<Parameters<WelcomeWizardProps['useSessionStatus']>[0]>[0]
const useSessionStatus: WelcomeWizardProps['useSessionStatus'] = selector => selector(noAttention)
const schemaService = new SettingsSchemaService(new Context())

const VIEW: SettingsNamespaceView = {
  autoGenerate: false,
  ns: 'permission',
  schema: {},
  value: {},
  applies: 'live',
  secrets: [],
  revision: 1,
}

afterEach(cleanup)

/** Mount the wizard over fake models state and a mutable completion scope. */
function mount() {
  const snapshot: WizardScopeSnapshot = { mode: 'host', status: 'ready', value: {} }
  let listener: (() => void) | undefined
  const set = vi.fn(async (field: string, value: unknown) => {
    ;(snapshot.value ??= {})[field] = value
    listener?.()
    return true
  })
  const scope: WizardScope = {
    getSnapshot: () => snapshot,
    subscribe: (next) => { listener = next; return () => { listener = undefined } },
    set,
  }
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'written' as const, view: VIEW }))
  const operations: ModelsOperations = {
    describeCredential: async () => undefined,
    storeCredential: async () => undefined,
    removeCredential: async () => undefined,
    writeSettings,
    discoverModels: async () => ({ kind: 'found', models: [] }),
  }
  const modelsStore = createSnapshotStore<ModelsSettingsState>({
    status: 'ready', error: null, credentialError: null, writable: true, rows: [], namespaces: new Map(),
  })
  const analysis = {
    start: vi.fn(async () => ({ ok: true as const, value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 6, pct: 0 } })),
    status: vi.fn(async () => ({ ok: true as const, value: { state: 'idle' as const, stage: '', stageIndex: 0, stageCount: 6, pct: 0 } })),
  }
  const store = new WelcomeWizardStore(scope, analysis, vi.fn())
  const complete = vi.fn()
  const props: WelcomeWizardProps = {
    stepId: 'welcome-wizard',
    complete,
    openSection: vi.fn(),
    useSessions: unusedHook,
    useSessionStatus,
    usePanelInfo,
    useSessionRetainInfo: () => undefined,
    useResource,
    useWorkspaces: unusedHook,
    store,
    useWizard: bindSnapshotSelector(store.store),
    modelsController: { load: vi.fn(async () => {}) } as never,
    operations,
    api: {} as never,
    schema: createSettingsSchemaOperations(schemaService),
    useModels: bindSnapshotSelector(modelsStore),
    t: key => zh[key],
  }
  return { ...render(<WelcomeWizard {...props} />), store, analysis, operations: writeSettings, set, complete }
}

/** Move the mounted wizard to the agents step from the rail. */
function gotoAgents(): void {
  fireEvent.click(screen.getByRole('button', { name: zh.wizNameAgents }))
}

describe('WelcomeWizard', () => {
  it('walks the seven steps and writes the real sandbox preset', async () => {
    const h = mount()
    fireEvent.click(await screen.findByRole('button', { name: zh.wizStart }))
    expect(screen.getByText(zh.wizSecurityHeading)).toBeTruthy()

    fireEvent.click(screen.getByText(zh.wizSandboxReadOnly).closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizProviderHeading)
    expect(h.operations).toHaveBeenCalledWith(
      'permission',
      [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }],
      undefined,
    )
  })

  it('shows a refused write only on the step that caused it', async () => {
    const h = mount()
    fireEvent.click(await screen.findByRole('button', { name: zh.wizStart }))
    expect(screen.getByText(zh.wizSecurityHeading)).toBeTruthy()

    act(() => { h.store.noteWriteFailure('security', 'the host refused the write') })
    expect(document.querySelector('[data-wiz-write-error]')?.textContent).toBe('the host refused the write')

    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizProviderHeading)
    expect(document.querySelector('[data-wiz-write-error]')).toBeNull()
  })

  it('writes the background-helper toggles with the Kilo free seats', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameIntelligence }))
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
    fireEvent.click(switches[1]!)
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizTourHeading)
    const namespaces = h.operations.mock.calls.map(call => call[0])
    expect(namespaces).toEqual(['enpoi-orchestration', 'enpoi-orchestration', 'enpoi-orchestration'])
    expect(h.operations).toHaveBeenCalledWith('enpoi-orchestration', [
      { op: 'set', path: ['personas', 'compaction'], value: { provider: 'kilo', model: 'kilo-auto/free' } },
    ], undefined)
  })

  it('finishes only after the completion marker is written', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameDone }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizFinish }))
    await act(async () => { await Promise.resolve() })
    expect(h.set).toHaveBeenCalledWith(WIZARD_COMPLETED_FIELD, WIZARD_VERSION)
    expect(h.complete).toHaveBeenCalledTimes(1)
  })

  it('runs the tour as one layer over the real UI with a working Back', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-dsh-tour', 'rightbar')
    document.body.appendChild(target)
    mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameTour }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizTourStart }))

    // The wizard dialog is gone: exactly the tour layer owns the screen.
    expect(screen.queryByRole('dialog', { name: zh.wizTitle })).toBeNull()
    const overlay = document.querySelector('[data-dsh-tour-overlay]')
    expect(overlay).not.toBeNull()
    expect(document.querySelector('[data-dsh-tour-hole]')).not.toBeNull()
    expect(document.querySelector('[data-dsh-tour-count]')?.textContent).toBe('第 1 站，共 5 站')

    fireEvent.click(screen.getByRole('button', { name: zh.wizNext }))
    expect(document.querySelector('[data-dsh-tour-count]')?.textContent).toBe('第 2 站，共 5 站')

    // Back walks stops, and at the first stop returns to the wizard steps
    // instead of dead-ending on a disabled control.
    fireEvent.click(screen.getByRole('button', { name: zh.wizBack }))
    expect(document.querySelector('[data-dsh-tour-count]')?.textContent).toBe('第 1 站，共 5 站')
    fireEvent.click(screen.getByRole('button', { name: zh.wizBack }))
    expect(document.querySelector('[data-dsh-tour-overlay]')).toBeNull()
    expect(screen.getByRole('dialog', { name: zh.wizTitle })).toBeTruthy()
    expect(screen.getByText(zh.wizTourHeading)).toBeTruthy()
    target.remove()
  })

  it('skips the tour into the agents step', async () => {
    mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameTour }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizTourStart }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizSkipTour }))
    expect(document.querySelector('[data-dsh-tour-overlay]')).toBeNull()
    await screen.findByText(zh.wizAgentsHeading)
  })

  it('keeps the analysis progress surface out of the wizard card and states the run in step copy', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })

    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText(zh.wizSecurityHeading)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByText(zh.wizWelcomeLead)).toBeTruthy()

    act(() => {
      h.store.store.update((state) => {
        state.analysis = { state: 'running', stage: 'tooling', stageIndex: 3, stageCount: 8, pct: 38 }
      })
    })
    // The live progress surface is the frame-wide chip; the wizard card only
    // states the run's outcome.
    const card = screen.getByRole('dialog', { name: zh.wizTitle })
    expect(document.querySelector('[data-dsh-analysis-dock]')).toBeNull()
    expect(card.querySelector('[data-dsh-analysis-pct]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh.wizNameAgents }))
    expect(document.querySelector('[data-wiz-analysis-status]')?.textContent).toBe(zh.wizAnalyseRunning)

    act(() => {
      h.store.store.update((state) => {
        state.analysis = {
          state: 'succeeded', stage: 'done', stageIndex: 8, stageCount: 8, pct: 100,
        }
      })
    })
    const ready = document.querySelector('[data-wiz-analysis-status]')?.textContent ?? ''
    expect(ready).toBe(zh.wizAnalysisReady)
  })

  it('returns from the agents step to the tour step with Back', async () => {
    mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    gotoAgents()
    await screen.findByText(zh.wizAgentsHeading)
    fireEvent.click(screen.getByRole('button', { name: zh.wizBack }))
    expect(screen.getByText(zh.wizTourHeading)).toBeTruthy()
  })

  it('skips the agents step without starting a run', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    gotoAgents()
    fireEvent.click(screen.getByRole('button', { name: zh.wizAnalyseSkip }))
    expect(h.analysis.start).not.toHaveBeenCalled()
    expect(screen.getByText(zh.wizDoneHeading)).toBeTruthy()
    expect(h.store.store.getSnapshot().wizard.states.agents).toBe('skipped')
  })

  it('starts the investigation in the background and advances on Investigate', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    gotoAgents()
    fireEvent.click(screen.getByRole('button', { name: zh.wizAnalyseStart }))
    expect(h.analysis.start).toHaveBeenCalledTimes(1)
    expect(h.store.store.getSnapshot().wizard.states.agents).toBe('configured')
    expect(screen.getByText(zh.wizDoneHeading)).toBeTruthy()
  })

  it('offers Continue beside the status while a run is in flight', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    act(() => {
      h.store.store.update((state) => {
        state.analysis = { state: 'running', stage: 'machine', stageIndex: 0, stageCount: 8, pct: 10 }
      })
    })
    gotoAgents()
    expect(document.querySelector('[data-wiz-analysis-status]')?.textContent).toBe(zh.wizAnalyseRunning)
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    expect(screen.getByText(zh.wizDoneHeading)).toBeTruthy()
  })

  it('keeps Continue and Back on a failed run, without starting a retry', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    act(() => {
      h.store.store.update((state) => {
        state.analysis = { state: 'failed', stage: '', stageIndex: 0, stageCount: 8, pct: 0, error: 'route refused' }
      })
    })
    gotoAgents()
    expect(document.querySelector('[data-wiz-analysis-status]')?.textContent).toBe(`${zh.wizAnalysisFailed}: route refused`)
    expect(screen.getByRole('button', { name: zh.wizBack })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    expect(h.analysis.start).not.toHaveBeenCalled()
    expect(screen.getByText(zh.wizDoneHeading)).toBeTruthy()
  })

  it('offers Investigate and Skip again after reopening onto an idle host', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    act(() => {
      h.store.store.update((state) => {
        state.analysis = { state: 'succeeded', stage: 'done', stageIndex: 8, stageCount: 8, pct: 100 }
      })
    })
    await act(async () => { await h.store.reopen() })
    gotoAgents()
    expect(document.querySelector('[data-wiz-analysis-status]')).toBeNull()
    expect(screen.getByRole('button', { name: zh.wizAnalyseStart })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.wizAnalyseSkip })).toBeTruthy()
  })

  it('shows the demo key glyphs beside Back and Continue', async () => {
    mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizStart }))
    await screen.findByText(zh.wizSecurityHeading)

    const back = document.querySelector('[data-wiz-key="before"]')
    const forward = document.querySelector('[data-wiz-key="after"]')
    expect(back?.textContent).toBe('←')
    expect(forward?.textContent).toBe('→')
    // The glyph stays out of the accessible name: the buttons read as labels.
    expect(back?.getAttribute('aria-hidden')).toBe('true')
    expect(forward?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: zh.wizBack })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.wizContinue })).toBeTruthy()
  })
})
