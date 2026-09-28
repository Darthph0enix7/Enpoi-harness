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
  ns: 'permission-presets',
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
  const store = new WelcomeWizardStore(scope, {
    start: async () => ({ ok: true, value: { state: 'idle', stage: '', stageIndex: 0, stageCount: 6, pct: 0 } }),
    status: async () => ({ ok: true, value: { state: 'idle', stage: '', stageIndex: 0, stageCount: 6, pct: 0 } }),
  })
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
  return { ...render(<WelcomeWizard {...props} />), store, operations: writeSettings, set, complete }
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
      'permission-presets',
      [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }],
      undefined,
    )
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

  it('renders the live analysis progress on every step, including done', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    act(() => {
      h.store.store.update((state) => {
        state.analysis = { state: 'running', stage: 'services', stageIndex: 2, stageCount: 6, pct: 33 }
      })
    })
    const dock = document.querySelector('[data-dsh-analysis-dock]')
    expect(dock).not.toBeNull()
    expect(document.querySelector('[data-dsh-analysis-spinner]')).not.toBeNull()
    expect(document.querySelector('[data-dsh-analysis-pct]')?.textContent).toBe('33%')
    expect(document.querySelector('[data-dsh-analysis-fill]')?.getAttribute('style')).toContain('width: 33%')
    const phases = Array.from(document.querySelectorAll('[data-dsh-analysis-phases] li'))
    expect(phases.map(phase => phase.getAttribute('data-state'))).toEqual([
      'done', 'done', 'active', 'pending', 'pending', 'pending',
    ])

    fireEvent.click(screen.getByRole('button', { name: zh.wizNameDone }))
    expect(document.querySelector('[data-dsh-analysis-dock]')).not.toBeNull()
  })
})
