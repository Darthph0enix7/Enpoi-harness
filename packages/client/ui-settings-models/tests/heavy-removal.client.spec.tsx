// @vitest-environment jsdom
/**
 * Tests for heavy provider deletion lifecycle guards:
 * 1. The host removal runs before any client reference cleanup; a refusal or
 *    failure leaves favorites/defaults untouched.
 * 2. Uninstall checkbox only renders when status.installedByHarness === true AND mode === 'local'.
 * 3. External/unknown instances display the route-only removal notice.
 * 4. Running install blocks deletion with an explanatory message.
 * 5. Host `summary.warnings` are surfaced, and a skipped requested teardown
 *    keeps the dialog open instead of reporting success.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ModelsSection, providerCopy } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore, type ModelsWire } from '../src/client/store.ts'
import { heavyApi, heavyStatusCache, type HeavyStatusView } from '../src/client/heavy-rpc.ts'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.client.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => {
  cleanup()
  heavyStatusCache.invalidate()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = translateEn

function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
  })),
})

function wireNamespaces(): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
      value: {
        providers: {
          freellmapi: { baseURL: 'http://127.0.0.1:3002/v1' },
        },
      },
      user: {
        providers: {
          freellmapi: { baseURL: 'http://127.0.0.1:3002/v1' },
        },
      },
      autoGenerate: true,
      applies: 'live',
      secrets: [],
      revision: 0,
    },
  ]
}

function scriptedFace() {
  const providerNamespace = wireNamespaces()[0]!
  const mutate = vi.fn(
    (_ns: string, _ops: readonly SettingsPathOpView[], _expectedRevision?: number) =>
      Promise.resolve(remoteOk(providerNamespace)),
  )
  const describe = vi.fn((): Promise<RemoteResult<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>> =>
    Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: wireNamespaces() })),
  )
  const face = {
    llm: {
      listProviders: vi.fn(() => Promise.resolve(remoteOk([
        { id: 'freellmapi', name: 'FreeLLMAPI' },
      ]))),
      listConfigurableProviders: vi.fn(() => Promise.resolve(remoteOk([
        { provider: 'freellmapi', displayName: 'FreeLLMAPI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'freellmapi'], active: true },
      ]))),
      discoverModels: vi.fn(() => Promise.resolve(remoteOk([]))),
    },
    settings: {
      describe,
      update: vi.fn(() => Promise.resolve(remoteOk(providerNamespace))),
      mutate,
    },
    credentials: {
      describe: vi.fn(() => Promise.resolve(remoteOk({}))),
      set: vi.fn(() => Promise.resolve(remoteOk(undefined))),
      unset: vi.fn(() => Promise.resolve(remoteOk(undefined))),
    },
  }
  return { face, mutate, describe }
}

type PageContext = ConstructorParameters<typeof ModelsSettingsStore>[0]
function ctxWith(face: object): PageContext {
  return { remote: face } as unknown as PageContext
}

async function mountSection(faceHelper = scriptedFace()) {
  const { face, mutate, describe } = faceHelper
  const ctx = ctxWith(face)
  const mirror = new SettingsDescribeMirror(ctx)
  const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await controller.load()
  const renderSlot = vi.fn(() => null)
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: face as unknown as ModelsWire,
    schema: settingsSchema,
    t,
    picker: null,
    modelT: key => key,
    renderSlot: renderSlot as unknown as ModelsSectionProps['renderSlot'],
  }
  const view = render(<ModelsSection {...injected} />)
  return { view, face, mutate, describe, controller }
}

function providerRow(provider: string): HTMLElement {
  const row = screen.getAllByText(provider)
    .map(node => node.closest<HTMLElement>('[role="button"]'))
    .find(candidate => candidate !== null)
  if (row === undefined || row === null) throw new Error(`no row for ${provider}`)
  return row
}

describe('Heavy provider deletion lifecycle guards', () => {
  it('hides uninstall checkbox and shows route-only notice for reused or external provider', async () => {
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'reuse',
        installedByHarness: false,
        health: { ok: true, status: 200, checkedAt: 1 },
      } as HeavyStatusView,
    })
    const removeSpy = vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: true,
      value: { ok: true, summary: { routeRemoved: true, credentialRemoved: false, poolStateRemoved: false, cacheEntryRemoved: false, chainLinksRemoved: 0, teardown: { ran: false, ok: true, output: '' }, warnings: [], errors: [] } },
    })

    await mountSection()
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })

    // 1. Uninstall checkbox must NOT be present
    expect(within(dialog).queryByText(en.heavyAlsoUninstall)).toBeNull()
    // 2. Route-only notice must be present
    await waitFor(() => {
      expect(within(dialog).getByText(en.heavyRouteOnlyRemovalNotice)).toBeTruthy()
    })

    // 3. Confirming delete calls remove with false (no teardown)
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmDeleteAction }))
    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('freellmapi', false)
    })
  })

  it('renders uninstall checkbox when provider was locally installed by this harness', async () => {
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'local',
        installedByHarness: true,
        health: { ok: true, status: 200, checkedAt: 1 },
      } as HeavyStatusView,
    })
    const removeSpy = vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: true,
      value: { ok: true, summary: { routeRemoved: true, credentialRemoved: false, poolStateRemoved: false, cacheEntryRemoved: false, chainLinksRemoved: 0, teardown: { ran: true, ok: true, output: '' }, warnings: [], errors: [] } },
    })

    await mountSection()
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })

    // 1. Uninstall checkbox MUST be present
    await waitFor(() => {
      expect(within(dialog).getByText(en.heavyAlsoUninstall)).toBeTruthy()
    })
    // 2. The external/shared notice is NOT shown; the owned route-only
    //    warning names the still-running service instead.
    expect(within(dialog).queryByText(en.heavyRouteOnlyRemovalNotice)).toBeNull()
    expect(within(dialog).getByText(en.heavyOwnedRouteOnlyNotice)).toBeTruthy()

    // 3. Check the uninstall box
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmDeleteAction }))

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('freellmapi', true)
    })
  })

  it('blocks deletion with explanatory text when install job is currently running', async () => {
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'local',
        installedByHarness: true,
        health: { ok: true, status: 200, checkedAt: 1 },
        job: { id: 'j1', kind: 'install', state: 'running', stage: 'Building', stageIndex: 1, stageCount: 4, pct: 25, logTail: '', startedAt: 1 },
      } as HeavyStatusView,
    })
    const removeSpy = vi.spyOn(heavyApi, 'remove')

    await mountSection()
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })

    // 1. Explanatory message is rendered
    await waitFor(() => {
      expect(within(dialog).getByText(en.heavyDeleteBlockedRunningInstall)).toBeTruthy()
    })
    // 2. Delete confirm button is disabled
    const deleteBtn = within(dialog).getByRole('button', { name: en.confirmDeleteAction })
    expect(deleteBtn).toHaveProperty('disabled', true)
    // 3. remove is never called
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('runs the host removal before client cleanup and reports a cleanup failure afterwards', async () => {
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'reuse',
        installedByHarness: false,
        health: { ok: true, status: 200, checkedAt: 1 },
      } as HeavyStatusView,
    })
    const removeSpy = vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: true,
      value: { ok: true, summary: { routeRemoved: true, credentialRemoved: false, poolStateRemoved: false, cacheEntryRemoved: false, chainLinksRemoved: 0, teardown: { ran: false, ok: true, output: '' }, warnings: [], errors: [] } },
    })

    const helper = scriptedFace()
    await mountSection(helper)
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })

    // Wait for delete status to settle (disabling confirmed while unsettled)
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: en.confirmDeleteAction })).toHaveProperty('disabled', false)
    })

    // Simulate cleanup failure by having describe fail during the cleanup phase
    helper.describe.mockResolvedValueOnce({ ok: false as const, error: new Error('cleanup failed') as never })

    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmDeleteAction }))

    await waitFor(() => {
      // The host removal already ran; only the client mirror pass failed.
      expect(removeSpy).toHaveBeenCalledWith('freellmapi', false)
      expect(within(dialog).getByText(/cleanup failed/)).toBeTruthy()
    })
  })

  it('keeps client favorites when the host removal is refused before any mutation', async () => {
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'reuse',
        installedByHarness: false,
        health: { ok: true, status: 200, checkedAt: 1 },
      } as HeavyStatusView,
    })
    const removeSpy = vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: false,
      message: 'the provider lock is held by another install',
    })
    localStorage.setItem('dsh_model_favorites_v2', JSON.stringify([
      { provider: 'freellmapi', modelId: 'free-a' },
    ]))

    const helper = scriptedFace()
    await mountSection(helper)
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: en.confirmDeleteAction })).toHaveProperty('disabled', false)
    })

    const mutationsBefore = helper.mutate.mock.calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmDeleteAction }))

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('freellmapi', false)
      expect(within(dialog).getByText(/provider lock is held/)).toBeTruthy()
    })
    // No reference cleanup may follow a refused removal: the orchestration
    // namespace (first cleanup pass) is never written beyond the mount-time
    // auto-populate, and favorites keep their entry.
    expect(helper.mutate.mock.calls.slice(mutationsBefore).some(call => call[0] === 'enpoi-orchestration')).toBe(false)
    expect(JSON.parse(localStorage.getItem('dsh_model_favorites_v2') ?? '[]')).toEqual([
      { provider: 'freellmapi', modelId: 'free-a' },
    ])
  })

  it('keeps the dialog open and names the warnings when the requested uninstall was skipped', async () => {
    const warning = 'local teardown skipped for freellmapi: no verified harness ownership receipt; the vendor service was not touched'
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'local',
        installedByHarness: true,
        health: { ok: true, status: 200, checkedAt: 1 },
      } as HeavyStatusView,
    })
    vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: true,
      value: { ok: true, summary: { routeRemoved: true, credentialRemoved: false, poolStateRemoved: false, cacheEntryRemoved: false, chainLinksRemoved: 0, teardown: { ran: false, ok: true, output: '' }, warnings: [warning], errors: [] } },
    })

    await mountSection()
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })
    await waitFor(() => { expect(within(dialog).getByText(en.heavyAlsoUninstall)).toBeTruthy() })
    fireEvent.click(within(dialog).getByRole('checkbox'))

    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmDeleteAction }))

    await waitFor(() => {
      expect(within(dialog).getByText(en.heavyTeardownSkipped)).toBeTruthy()
      expect(within(dialog).getByText(warning)).toBeTruthy()
    })
    // The dialog must not close on a skipped uninstall.
    expect(screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })).toBeTruthy()
  })

  it('surfaces removal warnings after a successful host removal', async () => {
    const warning = 'credential kept: another configured route references it'
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'reuse',
        installedByHarness: false,
        health: { ok: true, status: 200, checkedAt: 1 },
      } as HeavyStatusView,
    })
    vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: true,
      value: { ok: true, summary: { routeRemoved: true, credentialRemoved: false, poolStateRemoved: false, cacheEntryRemoved: false, chainLinksRemoved: 0, teardown: { ran: false, ok: true, output: '' }, warnings: [warning], errors: [] } },
    })

    await mountSection()
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: en.confirmDeleteAction })).toHaveProperty('disabled', false)
    })

    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmDeleteAction }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: providerCopy(en.deleteTitle, target) })).toBeNull()
      expect(document.querySelector('[data-removal-warning]')?.textContent).toContain(warning)
    })
  })

  it('disables delete confirm button while forced status check is unsettled on dialog open', async () => {
    let resolveStatus!: (resp: { ok: true; value: HeavyStatusView }) => void
    const statusPromise = new Promise<{ ok: true; value: HeavyStatusView }>((resolve) => {
      resolveStatus = resolve
    })
    vi.spyOn(heavyApi, 'status').mockReturnValue(statusPromise)

    await mountSection()
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })

    // 1. While status check is unsettled, confirm button is disabled
    const deleteBtn = within(dialog).getByRole('button', { name: en.confirmDeleteAction })
    expect(deleteBtn).toHaveProperty('disabled', true)

    // 2. Resolve status with reuse mode
    resolveStatus({
      ok: true,
      value: {
        id: 'freellmapi',
        configured: true,
        mode: 'reuse',
        installedByHarness: false,
        health: { ok: true, status: 200, checkedAt: 1 },
      } as HeavyStatusView,
    })

    // 3. Once settled, confirm button becomes enabled
    await waitFor(() => {
      expect(deleteBtn).toHaveProperty('disabled', false)
    })
  })

  it('allows explicit route-only removal without uninstall when status fetch fails', async () => {
    vi.spyOn(heavyApi, 'status').mockResolvedValue({
      ok: false,
      message: 'status endpoint 503',
    })
    const removeSpy = vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: true,
      value: { ok: true, summary: { routeRemoved: true, credentialRemoved: false, poolStateRemoved: false, cacheEntryRemoved: false, chainLinksRemoved: 0, teardown: { ran: false, ok: true, output: '' }, warnings: [], errors: [] } },
    })

    await mountSection()
    fireEvent.click(providerRow('FreeLLMAPI'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))

    const target = { provider: 'freellmapi', displayName: 'FreeLLMAPI' }
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })

    // 1. Shows the status-unavailable route-only notice (no uninstall checkbox)
    await waitFor(() => {
      expect(within(dialog).getByText(en.heavyStatusReadFailedRouteOnly)).toBeTruthy()
    })
    expect(within(dialog).queryByText(en.heavyRouteOnlyRemovalNotice)).toBeNull()
    expect(within(dialog).queryByText(en.heavyAlsoUninstall)).toBeNull()

    // 2. Confirm button is enabled and calls remove with uninstall = false
    const deleteBtn = within(dialog).getByRole('button', { name: en.confirmDeleteAction })
    expect(deleteBtn).toHaveProperty('disabled', false)
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('freellmapi', false)
    })
  })

  it('offers an uninstall entry for a route-less owned local install', async () => {
    const statusSpy = vi.spyOn(heavyApi, 'status').mockImplementation(async (id: string) => ({
      ok: true,
      value: id === 'freellmapi'
        ? {
          id,
          configured: false,
          mode: 'local',
          installedByHarness: true,
          health: { ok: true, status: 200, checkedAt: 1 },
        }
        : {
          id,
          configured: false,
          health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
        },
    }))
    const removeSpy = vi.spyOn(heavyApi, 'remove').mockResolvedValue({
      ok: true,
      value: { ok: true, summary: { routeRemoved: false, credentialRemoved: false, poolStateRemoved: false, cacheEntryRemoved: false, chainLinksRemoved: 0, teardown: { ran: true, ok: true, output: '' }, warnings: [], errors: [] } },
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    await mountSection()
    await waitFor(() => { expect(screen.getByText(en.heavyRouteLessTitle)).toBeTruthy() })
    expect(screen.getByText(en.heavyRouteLessHint)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.heavyUninstallAction }))
    await waitFor(() => { expect(removeSpy).toHaveBeenCalledWith('freellmapi', true) })
    expect(statusSpy).toHaveBeenCalledWith('freellmapi')
  })
})

it('re-reads ownership when the Add modal closes after a failed install', async () => {
  let owned = false
  const statusSpy = vi.spyOn(heavyApi, 'status').mockImplementation(async (id: string) => ({
    ok: true,
    value: id === 'freellmapi' && owned
      ? {
        id,
        configured: false,
        mode: 'local',
        installedByHarness: true,
        health: { ok: true, status: 200, checkedAt: 1 },
      }
      : {
        id,
        configured: false,
        health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
      },
  }))

  await mountSection()
  await waitFor(() => { expect(statusSpy).toHaveBeenCalledWith('freellmapi') })
  expect(screen.queryByText(en.heavyRouteLessTitle)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: en.addProviderAction }))
  const dialog = await screen.findByRole('dialog')
  // The install registered ownership on the host before failing its route
  // commit; closing the failed form must reveal the route-less service.
  owned = true
  fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))

  await waitFor(() => { expect(screen.getByText(en.heavyRouteLessTitle)).toBeTruthy() })
})
