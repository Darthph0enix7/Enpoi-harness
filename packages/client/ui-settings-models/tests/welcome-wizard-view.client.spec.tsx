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
import { createModelsOperations } from '../src/client/operations.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import type { WebSetupOperations, WebSetupStatus } from '../src/client/web-setup.ts'
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

/**
 * The host's web-setup answer every spec starts from, unless it overrides one.
 * A strict-zero install reports nothing mounted; the catalogue is still the
 * host's, because applySetup can insert each v1 provider row itself.
 */
const WEB_STATUS: WebSetupStatus = {
  searchProvider: null,
  fetchProvider: null,
  mounted: [],
  credentials: {},
}

/** A configured DeepSeek official row, as the live Models join reports one. */
const DEEPSEEK_ROW: ProviderRow = {
  entry: {
    provider: 'deepseek-official',
    displayName: 'DeepSeek',
    settingsNs: 'llm-deepseek',
    settingsPath: [],
    active: true,
  },
  configured: true,
  removable: false,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  credential: { configured: true, writable: true },
}

/** Overrides one spec uses to steer the wizard's host answers. */
interface MountOptions {
  rows?: ModelsSettingsState['rows']
  webStatus?: WebSetupStatus
  readStatus?: WebSetupOperations['status']
  validate?: WebSetupOperations['validateProvider']
  apply?: WebSetupOperations['applySetup']
}

/** Mount the wizard over fake models state and a mutable completion scope. */
function mount(options: MountOptions = {}) {
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
  const readStatus = vi.fn<WebSetupOperations['status']>(
    options.readStatus ?? (async () => ({ kind: 'status' as const, status: options.webStatus ?? WEB_STATUS })),
  )
  const validateProvider = vi.fn<WebSetupOperations['validateProvider']>(
    options.validate ?? (async () => ({ kind: 'validated' as const, latencyMs: 42 })),
  )
  const applySetup = vi.fn<WebSetupOperations['applySetup']>(
    options.apply ?? (async () => ({ kind: 'applied' as const, applied: [], pendingRestart: null })),
  )
  const operations: ModelsOperations = {
    describeCredential: async () => undefined,
    storeCredential: async () => undefined,
    removeCredential: async () => undefined,
    writeSettings,
    discoverModels: async () => ({ kind: 'found', models: [] }),
    webSetup: { status: readStatus, validateProvider, applySetup },
  }
  const modelsStore = createSnapshotStore<ModelsSettingsState>({
    status: 'ready', error: null, credentialError: null, writable: true, rows: options.rows ?? [], namespaces: new Map(),
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
  return {
    ...render(<WelcomeWizard {...props} />),
    store, analysis, operations: writeSettings, set, complete,
    readStatus, validateProvider, applySetup, modelsStore,
  }
}

/** Move the mounted wizard to the agents step from the rail. */
function gotoAgents(): void {
  fireEvent.click(screen.getByRole('button', { name: zh.wizNameAgents }))
}

/** Walk the real controls to the web step: welcome → security → provider → web. */
async function gotoWeb(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: zh.wizStart }))
  fireEvent.click(await screen.findByRole('button', { name: zh.wizContinue }))
  await screen.findByText(zh.wizProviderHeading)
  fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
  await screen.findByText(zh.wizWebHeading)
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

  it('centers the tip without a hole on a stop whose target is not mounted', async () => {
    // Only the sidebar trigger exists; stop 5 points at the Context Dashboard
    // trigger a fresh install has not mounted. The stop stays in the tour —
    // skipping it would change the "5 of 5" count — with the tip centered on
    // the viewport and no spotlight ring over empty space.
    const target = document.createElement('div')
    target.setAttribute('data-dsh-tour', 'rightbar')
    document.body.appendChild(target)
    mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameTour }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizTourStart }))
    expect(document.querySelector('[data-dsh-tour-hole]')).not.toBeNull()
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: zh.wizNext }))

    expect(document.querySelector('[data-dsh-tour-count]')?.textContent).toBe('第 5 站，共 5 站')
    expect(document.querySelector('[data-dsh-tour-hole]')).toBeNull()
    const tip = document.querySelector<HTMLElement>('[data-dsh-tour-tip]')!
    expect(tip.style.visibility).toBe('visible')
    // jsdom reports a zero-size box, so the inline offset is the tip's center.
    const box = tip.getBoundingClientRect()
    expect(Number.parseFloat(tip.style.left) + box.width / 2).toBeCloseTo(window.innerWidth / 2, 0)
    expect(Number.parseFloat(tip.style.top) + box.height / 2).toBeCloseTo(window.innerHeight / 2, 0)
    target.remove()
  })

  it('stops at the agents step when the tour finishes with the arrow key', async () => {
    const target = document.createElement('div')
    target.setAttribute('data-dsh-tour', 'rightbar')
    document.body.appendChild(target)
    mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameTour }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizTourStart }))
    // Walk to the last stop with the pointer, then finish with the arrow key.
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: zh.wizNext }))
    const overlay = document.querySelector('[data-dsh-tour-overlay]')
    expect(overlay).not.toBeNull()
    fireEvent.keyDown(overlay!, { key: 'ArrowRight' })
    // The tour hands over to the agents decision: the arrow must not carry the
    // blind continue past the ask into Done.
    await screen.findByText(zh.wizAgentsHeading)
    expect(screen.queryByText(zh.wizDoneHeading)).toBeNull()
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

  it('does not let the arrow key answer the agents decision', async () => {
    const h = mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameTour }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizTourStart }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizSkipTour }))
    await screen.findByText(zh.wizAgentsHeading)
    // No run yet: the arrow must not carry the blind continue into Done.
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText(zh.wizAgentsHeading)).toBeTruthy()
    expect(screen.queryByText(zh.wizDoneHeading)).toBeNull()
    // A run in flight turns the step into the Continue state, which the arrow
    // may advance like every other step.
    act(() => {
      h.store.store.update((state) => {
        state.analysis = { state: 'running', stage: 'machine', stageIndex: 0, stageCount: 8, pct: 0 }
      })
    })
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText(zh.wizDoneHeading)).toBeTruthy()
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

describe('WelcomeWizard web step', () => {
  it('walks provider → web → intelligence with the explicit off state, and back', async () => {
    const h = mount()
    await gotoWeb()
    fireEvent.change(screen.getByRole('combobox', { name: zh.wizWebSelectLabel }), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('switch', { name: zh.wizWebFetchHttp }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: null },
      fetch: { provider: null },
      toolToggles: { search: false, fetch: false },
    })

    fireEvent.click(screen.getByRole('button', { name: zh.wizBack }))
    await screen.findByText(zh.wizWebHeading)
    fireEvent.click(screen.getByRole('button', { name: zh.wizBack }))
    expect(screen.getByText(zh.wizProviderHeading)).toBeTruthy()
  })

  it('skips the step with Escape and names the skip on the Done page', async () => {
    const h = mount()
    await gotoWeb()
    fireEvent.keyDown(screen.getByRole('dialog', { name: zh.wizTitle }), { key: 'Escape' })
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.store.store.getSnapshot().wizard.states.web).toBe('skipped')
    expect(h.applySetup).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: zh.wizNameDone }))
    expect(screen.getByText(zh.wizSkippedWeb)).toBeTruthy()
  })

  it('renders the v1 catalogue and hides the shared-key option without a credential', async () => {
    mount()
    await gotoWeb()
    expect(screen.getByRole('option', { name: zh.wizWebExa })).toBeTruthy()
    expect(screen.getByRole('option', { name: zh.wizWebBrave })).toBeTruthy()
    expect(screen.getByRole('option', { name: zh.wizWebTavily })).toBeTruthy()
    expect(screen.getByRole('option', { name: zh.wizWebSearxng })).toBeTruthy()
    expect(screen.queryByRole('option', { name: zh.wizWebDeepSeek })).toBeNull()
    // The shipped built-in fetcher is always a real switch; an unmounted Jina
    // renders as coming-later, never as a dead toggle.
    expect(screen.getByRole('switch', { name: zh.wizWebFetchHttp })).toBeTruthy()
    expect(document.querySelector('[data-wiz-web-coming]')).not.toBeNull()
    expect(screen.queryByRole('switch', { name: zh.wizWebFetchJina })).toBeNull()
  })

  it('shows the shared-key option when the host reports its DeepSeek credential', async () => {
    mount({
      webStatus: {
        ...WEB_STATUS,
        mounted: [{ kind: 'search', provider: 'deepseek-official' }],
        credentials: { DEEPSEEK_API_KEY: { configured: true, writable: true } },
      },
    })
    await gotoWeb()
    expect(await screen.findByRole('option', { name: zh.wizWebDeepSeek })).toBeTruthy()
  })

  it('reuses the live Models credential for the shared-key option', async () => {
    mount({ rows: [DEEPSEEK_ROW] })
    await gotoWeb()
    expect(await screen.findByRole('option', { name: zh.wizWebDeepSeek })).toBeTruthy()
  })

  it('pre-selects the configured provider and badges both configured slots', async () => {
    mount({
      webStatus: {
        ...WEB_STATUS,
        searchProvider: 'exa',
        fetchProvider: 'http',
        mounted: [
          { kind: 'search', provider: 'exa' },
          { kind: 'fetch', provider: 'http' },
        ],
        credentials: { EXA_API_KEY: { configured: true, writable: true } },
      },
    })
    await gotoWeb()
    const select = await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }) as HTMLSelectElement
    expect(select.value).toBe('exa')
    expect(document.querySelector('[data-wiz-web-configured]')).not.toBeNull()
    expect(document.querySelector('[data-wiz-web-warning]')).toBeNull()
    expect(document.querySelector('[data-wiz-web-fetch-http]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('shows no configured badge and keeps the warning when mounted keyless', async () => {
    mount({
      webStatus: {
        ...WEB_STATUS,
        searchProvider: 'exa',
        fetchProvider: 'http',
        mounted: [
          { kind: 'search', provider: 'exa' },
          { kind: 'fetch', provider: 'http' },
        ],
        credentials: { EXA_API_KEY: { configured: false, writable: true } },
      },
    })
    await gotoWeb()
    const select = await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }) as HTMLSelectElement
    expect(select.value).toBe('exa')
    expect(document.querySelector('[data-wiz-web-configured]')).toBeNull()
    expect(document.querySelector('[data-wiz-web-warning]')).not.toBeNull()
    expect(document.querySelector('[data-wiz-web-warning]')?.textContent).toBe(zh.wizWebNoKeyWarning)
  })

  it('keeps a stored key when the field stays blank and never re-validates it', async () => {
    const h = mount({
      webStatus: {
        ...WEB_STATUS,
        searchProvider: 'exa',
        fetchProvider: 'http',
        credentials: { EXA_API_KEY: { configured: true, writable: true } },
      },
    })
    await gotoWeb()
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.validateProvider).not.toHaveBeenCalled()
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
  })

  it('warns when no key is available for Exa, but still allows Continue with search off', async () => {
    const h = mount()
    await gotoWeb()
    // Exa is preselected by default with a clear warning
    expect(document.querySelector('[data-wiz-web-warning]')?.textContent).toBe(zh.wizWebNoKeyWarning)

    // The masked field keeps the wizard's key conventions.
    const input = document.querySelector('[data-wiz-web-key]') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('new-password')
    expect(input.getAttribute('aria-label')).toBe(zh.keyInput)

    // Malformed key blocks Continue
    fireEvent.change(input, { target: { value: 'bad key!' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(zh.keyIllegalCharacters)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    expect(h.applySetup).not.toHaveBeenCalled()

    // Empty key allows Continue and disables search
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa' },
      fetch: { provider: 'http' },
      toolToggles: { search: false, fetch: true },
    })
  })

  it('advances on Continue without warning when EXA_API_KEY is present in the environment', async () => {
    const h = mount({
      webStatus: {
        ...WEB_STATUS,
        searchProvider: 'exa',
        fetchProvider: 'http',
        credentials: { EXA_API_KEY: { configured: true, source: 'user-env', writable: true } },
      },
    })
    await gotoWeb()
    expect(document.querySelector('[data-wiz-web-warning]')).toBeNull()
    expect(document.querySelector('[data-wiz-web-key-env]')).not.toBeNull()
    expect(document.querySelector('[data-wiz-web-key-env]')?.textContent).toBe(
      zh.wizWebKeyEnvNote.replace('{source}', zh.wizWebSourceEnv),
    )

    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
  })

  it('formats the honest note for credentials loaded from vault file', async () => {
    mount({
      webStatus: {
        ...WEB_STATUS,
        searchProvider: 'exa',
        fetchProvider: 'http',
        credentials: { EXA_API_KEY: { configured: true, source: 'file', writable: true } },
      },
    })
    await gotoWeb()
    expect(document.querySelector('[data-wiz-web-key-env]')?.textContent).toBe(
      zh.wizWebKeyEnvNote.replace('{source}', zh.wizWebSourceVault),
    )
  })

  it('validates a typed key with the spinner, then applies it with search on', async () => {
    let release!: (outcome: Awaited<ReturnType<WebSetupOperations['validateProvider']>>) => void
    const pending = new Promise<Awaited<ReturnType<WebSetupOperations['validateProvider']>>>((resolve) => { release = resolve })
    const h = mount({ validate: () => pending })
    await gotoWeb()
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-exa-test' } })
    expect(document.querySelector('[data-wiz-web-dashboard]')?.getAttribute('href')).toContain('exa')
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    expect(h.validateProvider).toHaveBeenCalledWith({ kind: 'search', provider: 'exa', apiKey: 'sk-exa-test' })
    expect(document.querySelector('[data-wiz-web-spinner]')).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.wizWebVerifying })).toBeTruthy()

    await act(async () => { release({ kind: 'validated', latencyMs: 37 }) })
    await screen.findByText(zh.wizWebValidated.replace('{latency}', '37'))
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    // Built-in fetcher is on by default.
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa', apiKey: 'sk-exa-test' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
  })

  it('blocks an invalid key with Retry and Save anyway, storing it with search off', async () => {
    const h = mount({ validate: async () => ({ kind: 'invalid', reason: 'rejected by provider' }) })
    await gotoWeb()
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebInvalid.replace('{reason}', 'rejected by provider'))
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByText(zh.wizWebInvalid.replace('{reason}', 'rejected by provider'))
    expect(h.validateProvider).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: zh.wizWebSaveAnyway }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa', apiKey: 'sk-bad' },
      fetch: { provider: 'http' },
      toolToggles: { search: false, fetch: true },
    })
  })

  it('falls back to the provider default when an invalid canary names no reason', async () => {
    mount({ validate: async () => ({ kind: 'invalid', reason: '' }) })
    await gotoWeb()
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebInvalid.replace('{reason}', zh.wizWebInvalidUnknown))
  })

  it('reports a refused canary with the host message or the local fallback', async () => {
    const validate = vi.fn<WebSetupOperations['validateProvider']>()
      .mockResolvedValueOnce({ kind: 'refused', message: '' })
      .mockResolvedValueOnce({ kind: 'refused', message: 'probe is offline' })
    const h = mount({ validate })
    await gotoWeb()
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-a' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebServiceUnavailable)
    // Changing the candidate resets the canary state, so Retry runs again.
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-b' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText('probe is offline')
    expect(h.applySetup).not.toHaveBeenCalled()
  })

  it('keeps a refused apply inline on its step and clears the note on navigation', async () => {
    const apply = vi.fn<WebSetupOperations['applySetup']>()
      .mockResolvedValueOnce({ kind: 'refused', message: '' })
      .mockResolvedValueOnce({ kind: 'refused', message: 'row surgery refused' })
    const h = mount({ apply })
    await gotoWeb()
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizWebApplyFailed)
    expect(screen.getByText(zh.wizWebHeading)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText('row surgery refused')

    // The note belongs to the step instance; walking away and back clears it.
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameIntelligence }))
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameWeb }))
    await screen.findByText(zh.wizWebHeading)
    expect(screen.queryByText('row surgery refused')).toBeNull()
    expect(h.applySetup).toHaveBeenCalledTimes(2)
  })

  it('shows the honest pending-restart line with the host diagnostic and advances anyway', async () => {
    mount({
      apply: async () => ({
        kind: 'applied',
        applied: ['web.searchProvider'],
        pendingRestart: { ns: 'web-search-exa', message: 'row written but not hot-mounted' },
      }),
    })
    await gotoWeb()
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(document.querySelector('[data-wiz-pending-restart]')?.textContent)
      .toBe(`${zh.wizWebPendingRestart} row written but not hot-mounted`)
  })

  it('sends the full nested selection and surfaces the host pending-restart message', async () => {
    const h = mount({
      apply: async () => ({
        kind: 'applied',
        applied: ['credentials:EXA_API_KEY', 'row:web-search-exa', 'web.searchProvider', 'tool-web'],
        pendingRestart: { ns: 'web-search-exa', message: 'the row was written but could not hot-mount' },
      }),
    })
    await gotoWeb()
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-exact' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebValidated.replace('{latency}', '42'))
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)

    // The exact wire payload: provider/key nested inside search, fetch named,
    // both tool toggles present, and the host restart object carried through.
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa', apiKey: 'sk-exact' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
    expect(document.querySelector('[data-wiz-pending-restart]')?.textContent)
      .toBe(`${zh.wizWebPendingRestart} the row was written but could not hot-mount`)
  })

  it('moves focus to the dialog on every step change', async () => {
    mount()
    await screen.findByRole('dialog', { name: zh.wizTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameIntelligence }))
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: zh.wizTitle }))
  })

  it('does not let the arrow key skip the web step or a focused select', async () => {
    const h = mount()
    await gotoWeb()
    const select = await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText(zh.wizWebHeading)).toBeTruthy()
    expect(h.applySetup).not.toHaveBeenCalled()

    select.focus()
    fireEvent.keyDown(select, { key: 'ArrowRight' })
    fireEvent.keyDown(select, { key: 'ArrowLeft' })
    expect(screen.getByText(zh.wizWebHeading)).toBeTruthy()

    // ArrowLeft from the body still walks back to the provider step.
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByText(zh.wizProviderHeading)).toBeTruthy()

    // The same guard protects the security step's sandbox radios.
    fireEvent.click(screen.getByRole('button', { name: zh.wizNameSecurity }))
    const radio = screen.getByText(zh.wizSandboxReadOnly).closest('button')!
    radio.focus()
    fireEvent.keyDown(radio, { key: 'ArrowRight' })
    expect(screen.getByText(zh.wizSecurityHeading)).toBeTruthy()
  })

  it('shows the loading line while the status read is in flight', async () => {
    let release!: (outcome: Awaited<ReturnType<WebSetupOperations['status']>>) => void
    const pending = new Promise<Awaited<ReturnType<WebSetupOperations['status']>>>((resolve) => { release = resolve })
    mount({ readStatus: () => pending })
    await gotoWeb()
    expect(document.querySelector('[data-wiz-web-loading]')?.textContent).toBe(zh.wizWebLoading)
    await act(async () => { release({ kind: 'status', status: WEB_STATUS }) })
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
  })

  it('recovers from a refused status read through Retry, with Skip always available', async () => {
    const readStatus = vi.fn<WebSetupOperations['status']>()
      .mockResolvedValueOnce({ kind: 'refused', message: '' })
      .mockResolvedValueOnce({ kind: 'status', status: WEB_STATUS })
    mount({ readStatus })
    await gotoWeb()
    await screen.findByText(zh.wizWebStatusFailed)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    expect(readStatus).toHaveBeenCalledTimes(2)
  })

  it('shows the host diagnostic and the Skip escape when the read fails with a message', async () => {
    mount({ readStatus: async () => ({ kind: 'refused', message: 'web service offline' }) })
    await gotoWeb()
    await screen.findByText('web service offline')
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebSkip }))
    await screen.findByText(zh.wizIntelligenceHeading)
  })

  it('requires the SearXNG URL, validates it, then stores the refused endpoint with search off', async () => {
    const h = mount({ validate: async () => ({ kind: 'invalid', reason: 'no response' }) })
    await gotoWeb()
    fireEvent.change(await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }), { target: { value: 'searxng' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizWebBaseUrlRequired)

    const input = document.querySelector('[data-wiz-web-base-url]')!
    fireEvent.change(input, { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizWebBaseUrlInvalid)

    fireEvent.change(input, { target: { value: 'http://127.0.0.1:8080' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizWebInvalid.replace('{reason}', 'no response'))
    expect(h.validateProvider).toHaveBeenCalledWith({ kind: 'search', provider: 'searxng', baseURL: 'http://127.0.0.1:8080' })

    fireEvent.click(screen.getByRole('button', { name: zh.wizWebSaveAnyway }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'searxng', baseURL: 'http://127.0.0.1:8080' },
      fetch: { provider: 'http' },
      toolToggles: { search: false, fetch: true },
    })
  })

  it('applies the shared-key provider without a canary or a credential', async () => {
    const h = mount({
      webStatus: {
        ...WEB_STATUS,
        mounted: [{ kind: 'search', provider: 'deepseek-official' }],
        credentials: { DEEPSEEK_API_KEY: { configured: true, writable: true } },
      },
    })
    await gotoWeb()
    fireEvent.change(await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }), { target: { value: 'deepseek-official' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.validateProvider).not.toHaveBeenCalled()
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'deepseek-official' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
  })

  it('lets the fetch switch choose the mounted Jina reader', async () => {
    const h = mount({
      webStatus: {
        ...WEB_STATUS,
        fetchProvider: 'jina',
        mounted: [{ kind: 'fetch', provider: 'jina' }],
      },
    })
    await gotoWeb()
    const jina = await screen.findByRole('switch', { name: zh.wizWebFetchJina })
    expect(jina.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(jina)
    expect(jina.getAttribute('aria-checked')).toBe('false')
    // The built-in fetcher takes the slot Jina released.
    fireEvent.click(screen.getByRole('switch', { name: zh.wizWebFetchHttp }))
    fireEvent.change(screen.getByRole('combobox', { name: zh.wizWebSelectLabel }), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: null },
      fetch: { provider: 'http' },
      toolToggles: { search: false, fetch: true },
    })
  })

  it('always offers the shipped built-in fetcher, even on a bare host', async () => {
    mount()
    await gotoWeb()
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    expect(document.querySelector('[data-wiz-web-fetch-http]')?.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: zh.wizWebFetchHttp }))
    expect(document.querySelector('[data-wiz-web-fetch-http]')?.getAttribute('aria-checked')).toBe('false')
  })
})

describe('WelcomeWizard web step probe paths', () => {
  it('keeps a pre-existing fetch provider when the step is engaged', async () => {
    mount({
      webStatus: {
        ...WEB_STATUS,
        fetchProvider: 'http',
        mounted: [{ kind: 'fetch', provider: 'http' }],
      },
    })
    await gotoWeb()
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    expect(document.querySelector('[data-wiz-web-fetch-http]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('verifies the SearXNG endpoint from its own button, then applies the validated URL', async () => {
    const h = mount()
    await gotoWeb()
    fireEvent.change(await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }), { target: { value: 'searxng' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebBaseUrlRequired)

    const input = document.querySelector('[data-wiz-web-base-url]')!
    fireEvent.change(input, { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebBaseUrlInvalid)

    fireEvent.change(input, { target: { value: 'http://127.0.0.1:8080' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebValidated.replace('{latency}', '42'))
    expect(h.validateProvider).toHaveBeenCalledWith({ kind: 'search', provider: 'searxng', baseURL: 'http://127.0.0.1:8080' })

    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'searxng', baseURL: 'http://127.0.0.1:8080' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
  })

  it('validates a SearXNG URL entered straight into Continue', async () => {
    const h = mount()
    await gotoWeb()
    fireEvent.change(await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }), { target: { value: 'searxng' } })
    fireEvent.change(document.querySelector('[data-wiz-web-base-url]')!, { target: { value: 'http://127.0.0.1:8080' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.validateProvider).toHaveBeenCalledTimes(1)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'searxng', baseURL: 'http://127.0.0.1:8080' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
  })

  it('refuses Verify with a blank or malformed key before probing', async () => {
    const h = mount()
    await gotoWeb()
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.keyRequired)
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'bad key!' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await vi.waitFor(() => {
      expect(document.querySelector('[data-wiz-web-error]')?.textContent).toBe(zh.keyIllegalCharacters)
    })
    expect(h.validateProvider).not.toHaveBeenCalled()
  })

  it('refuses Continue with a malformed key before probing', async () => {
    const h = mount()
    await gotoWeb()
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'bad key!' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await vi.waitFor(() => {
      expect(document.querySelector('[data-wiz-web-error]')?.textContent).toBe(zh.keyIllegalCharacters)
    })
    expect(h.validateProvider).not.toHaveBeenCalled()
    expect(h.applySetup).not.toHaveBeenCalled()
  })

  it('validates on Continue and applies only after a passing probe', async () => {
    const h = mount()
    await gotoWeb()
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-auto' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.validateProvider).toHaveBeenCalledWith({ kind: 'search', provider: 'exa', apiKey: 'sk-auto' })
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa', apiKey: 'sk-auto' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })
  })

  it('stays on the step when the Continue probe fails', async () => {
    const h = mount({ validate: async () => ({ kind: 'invalid', reason: 'nope' }) })
    await gotoWeb()
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-auto' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizWebInvalid.replace('{reason}', 'nope'))
    expect(h.applySetup).not.toHaveBeenCalled()
  })

  it('saves a cleared candidate anyway with the fetch fold off', async () => {
    const h = mount({ validate: async () => ({ kind: 'invalid', reason: 'nope' }) })
    await gotoWeb()
    await screen.findByRole('combobox', { name: zh.wizWebSelectLabel })
    // Turn the built-in fetcher back off before the probe fails.
    fireEvent.click(screen.getByRole('switch', { name: zh.wizWebFetchHttp }))
    fireEvent.change(document.querySelector('[data-wiz-web-key]')!, { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebVerify }))
    await screen.findByText(zh.wizWebInvalid.replace('{reason}', 'nope'))
    fireEvent.click(screen.getByRole('button', { name: zh.wizWebSaveAnyway }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa', apiKey: 'sk-bad' },
      fetch: { provider: null },
      toolToggles: { search: false, fetch: false },
    })
  })
})

describe('WelcomeWizard web step self-correction', () => {
  it('resets a selected shared-key offer when its credential disappears, so Continue never no-ops', async () => {
    const h = mount({ rows: [DEEPSEEK_ROW] })
    await gotoWeb()
    const select = await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'deepseek-official' } })
    expect(select.value).toBe('deepseek-official')

    // The live Models join drops the credential while the offer is selected.
    act(() => {
      h.modelsStore.update((state) => { state.rows = [] })
    })
    expect(screen.queryByRole('option', { name: zh.wizWebDeepSeek })).toBeNull()
    expect(select.value).toBe('exa')

    // The step now has a consistent selection: Continue applies the fallback
    // instead of hitting the dangling-selection guard and doing nothing.
    fireEvent.click(screen.getByRole('button', { name: zh.wizContinue }))
    await screen.findByText(zh.wizIntelligenceHeading)
    expect(h.applySetup).toHaveBeenCalledWith({
      search: { provider: 'exa' },
      fetch: { provider: 'http' },
      toolToggles: { search: false, fetch: true },
    })
  })
})

describe('WelcomeWizard web step optional service', () => {
  /** The live probe's answer, as the mounted namespace returns it. */
  const LIVE_STATUS: WebSetupStatus = {
    searchProvider: 'exa',
    fetchProvider: 'http',
    mounted: [
      { kind: 'search', provider: 'exa' },
      { kind: 'search', provider: 'deepseek-official' },
      { kind: 'fetch', provider: 'http' },
    ],
    credentials: {
      EXA_API_KEY: { configured: true, source: 'user-env', writable: true },
      DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true },
      BRAVE_API_KEY: { configured: false, writable: true },
      TAVILY_API_KEY: { configured: false, writable: true },
      JINA_API_KEY: { configured: false, writable: true },
    },
  }

  it('resolves status through the optional remote.webSetup service', async () => {
    const ctx = new Context()
    ctx.provide('remote.webSetup', {
      status: async () => ({ ok: true, value: LIVE_STATUS }),
      validateProvider: async () => ({ ok: true, value: { ok: true, latencyMs: 1 } }),
      applySetup: async () => ({ ok: true, value: { ok: true, applied: [] } }),
    })
    const live = createModelsOperations(ctx)
    mount({
      readStatus: live.webSetup.status,
      validate: live.webSetup.validateProvider,
      apply: live.webSetup.applySetup,
    })
    await gotoWeb()

    const select = await screen.findByRole('combobox', { name: zh.wizWebSelectLabel }) as HTMLSelectElement
    expect(select.value).toBe('exa')
    for (const name of [zh.wizWebDeepSeek, zh.wizWebSearxng, zh.wizWebNone, zh.wizWebTavily, zh.wizWebBrave]) {
      expect(screen.getByRole('option', { name })).toBeTruthy()
    }
    expect(document.querySelector('[data-wiz-web-configured]')).not.toBeNull()
    expect(document.querySelector('[data-wiz-web-loading]')).toBeNull()
  })

  it('degrades to the refused path when remote.webSetup is not mounted', async () => {
    const live = createModelsOperations(new Context())
    mount({ readStatus: live.webSetup.status })
    await gotoWeb()
    // No namespace service: the read refuses, the step offers Retry and Skip,
    // and nothing throws.
    await screen.findByText(zh.wizWebStatusFailed)
    expect(screen.getByRole('button', { name: zh.retry })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.wizWebSkip })).toBeTruthy()
  })
})
